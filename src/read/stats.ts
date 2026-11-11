import fs from 'node:fs';
import type { SessionStore } from '../storage/store.js';
import { workspaceKey } from '../storage/database.js';
import { resumeCommands } from '../harnesses/index.js';
import type { LedgerRecord } from '../core/schema.js';
import { estimateCost } from './prices.js';

/** `costEstimated`: some of `costUsd` was estimated from tokens (prices.ts), because the
 * harness reported no cost for those calls. */
export interface TokenTotals { calls: number; input: number; cacheRead: number; cacheWrite: number; output: number; reasoning: number; total: number; costUsd: number | null; costBehind?: boolean; costEstimated?: boolean }
const emptyTokens = (): TokenTotals => ({ calls: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, total: 0, costUsd: null });
function addTokens(into: TokenTotals, from: TokenTotals): void {
  for (const field of ['calls', 'input', 'cacheRead', 'cacheWrite', 'output', 'reasoning', 'total'] as const) into[field] += from[field];
  if (from.costUsd !== null) into.costUsd = (into.costUsd ?? 0) + from.costUsd;
  if (from.costEstimated) into.costEstimated = true;
}

/** `session` is missing, and `deleted` set, when a person deleted the session at the other end. */
export interface SessionLink { kind: 'continues' | 'continued-after' | 'continued-by' | 'cloned' | 'cloned-by'; session?: string; deleted?: boolean; harness?: string; turns?: number }

/** Handoffs and clones between this project's sessions, from both ends: a session lists the
 * one it continues or was cloned from, and that one lists it back (`continued-by`, `cloned-by`).
 */
function sessionLinks(captures: SessionStore, key: string): Map<string, SessionLink[]> {
  const links = new Map<string, SessionLink[]>();
  const add = (id: string, link: SessionLink) => links.set(id, [...links.get(id) ?? [], link]);
  const rows = captures.database.sql.prepare(`SELECT r.capture_id AS id, json_extract(c.manifest,'$.harness') AS harness, r.body AS body
    FROM records r JOIN captures c ON c.id=r.capture_id WHERE c.workspace_root=? AND r.type='session_link' ORDER BY r.revision`).all(key);
  for (const row of rows) {
    const { link } = JSON.parse(String(row.body)) as LedgerRecord;
    if (!link) continue;
    add(String(row.id), { kind: link.kind, ...(link.from ? { session: link.from } : { deleted: true }), harness: link.fromHarness, ...(link.turns === undefined ? {} : { turns: link.turns }) });
    if (link.from) add(link.from, { kind: link.kind === 'cloned' ? 'cloned-by' : 'continued-by', session: String(row.id), harness: String(row.harness) });
  }
  return links;
}

/** Counts of recorded evidence, computed in SQLite. These describe what was observed,
 * not quality: a failure is a tool result marked as an error, a change is an
 * observed file delta, and an unknown outcome is not counted as either.
 */
export function stats(captures: SessionStore, request: { workspaceRoot?: string }) {
  const readVersion = captures.database.revision;
  const manifests = captures.database.manifests();
  if (!request.workspaceRoot) {
    // Inventory: one row per tracked project, newest activity first.
    const projects = new Map<string, { workspaceRoot: string; captures: number; harnesses: Set<string>; lastStartedAt: string; recording: number }>();
    for (const manifest of manifests) {
      const key = workspaceKey(manifest.workspaceRoot);
      const project = projects.get(key) ?? { workspaceRoot: manifest.workspaceRoot, captures: 0, harnesses: new Set(), lastStartedAt: '', recording: 0 };
      project.captures++; project.harnesses.add(manifest.harness);
      if (manifest.status === 'recording') project.recording++;
      if (manifest.startedAt > project.lastStartedAt) project.lastStartedAt = manifest.startedAt;
      projects.set(key, project);
    }
    return { readVersion, projects: [...projects.values()].map(p => ({ ...p, harnesses: [...p.harnesses].sort() }))
      .sort((a, b) => b.lastStartedAt.localeCompare(a.lastStartedAt)) };
  }

  const key = workspaceKey(request.workspaceRoot);
  const inScope = manifests.filter(manifest => workspaceKey(manifest.workspaceRoot) === key);
  const number = (value: unknown) => Number(value ?? 0);
  const agent = "json_extract(r.body,'$.agentId')";
  // Requests are the user's own prompts (a subagent's task is not one). Subagents are
  // agents that did work; harness-internal helpers are excluded. Replies are assistant
  // messages with text, from the transcript or, without one, from the hook.
  const counts = new Map(captures.database.sql.prepare(`SELECT r.capture_id AS id,
      sum(r.type='input' AND ${agent} IS NULL AND json_extract(r.body,'$.notice') IS NULL) AS requests, sum(r.type='tool_started') AS tools,
      sum(r.type='tool_finished' AND r.is_error=1) AS failures, sum(r.type='file_change') AS changes,
      sum(r.type='gap') AS gaps,
      count(DISTINCT CASE WHEN r.type IN ('tool_started','subagent_started','input') THEN ${agent} END) AS subagents,
      sum(r.type IN ('source_record','message') AND r.role='assistant' AND length(json_extract(r.body,'$.summary'))>0) AS replies,
      max(json_extract(r.body,'$.observedAt')) AS lastObservedAt
    FROM records r JOIN captures c ON c.id=r.capture_id WHERE c.workspace_root=? GROUP BY r.capture_id`)
    .all(key).map(row => [String(row.id), row]));

  // Token usage: one row per model response (the first record of each key), excluding
  // native history replayed from before the capture started.
  const usageRows = captures.database.sql.prepare(`WITH first AS (
      SELECT min(r.revision) AS revision FROM records r JOIN captures c ON c.id=r.capture_id
      WHERE c.workspace_root=? AND r.type='usage' AND json_extract(r.body,'$.usageScope')='call'
        AND json_extract(r.body,'$.beforeCapture') IS NULL
      GROUP BY r.capture_id, coalesce(${agent},''), json_extract(r.body,'$.usageKey'))
    SELECT r.capture_id AS id, coalesce(json_extract(r.body,'$.model'),'unknown') AS model,
      count(*) AS calls, sum(json_extract(r.body,'$.usage.input')) AS input,
      sum(json_extract(r.body,'$.usage.cacheRead')) AS cacheRead, sum(json_extract(r.body,'$.usage.cacheWrite')) AS cacheWrite,
      sum(json_extract(r.body,'$.usage.output')) AS output, sum(coalesce(json_extract(r.body,'$.usage.reasoning'),0)) AS reasoning,
      sum(json_extract(r.body,'$.usage.costUsd')) AS costUsd
    FROM first JOIN records r ON r.revision=first.revision GROUP BY r.capture_id, model`).all(key);
  // A harness-reported running session total (Claude Code cost-state): the latest wins.
  const sessionCost = new Map(captures.database.sql.prepare(`SELECT r.capture_id AS id, json_extract(r.body,'$.usage.costUsd') AS costUsd
    FROM records r WHERE r.revision IN (SELECT max(r.revision) FROM records r JOIN captures c ON c.id=r.capture_id
      WHERE c.workspace_root=? AND r.type='usage' AND json_extract(r.body,'$.usageScope')='session-total' GROUP BY r.capture_id)`)
    .all(key).map(row => [String(row.id), Number(row.costUsd)]));
  const tokensByCapture = new Map<string, TokenTotals>();
  const modelRows = new Map<string, TokenTotals & { harness: string; model: string }>();
  const harnessOfCapture = new Map(inScope.map(m => [m.captureId, m.harness]));
  for (const row of usageRows) {
    const tokens: TokenTotals = { calls: number(row.calls), input: number(row.input), cacheRead: number(row.cacheRead),
      cacheWrite: number(row.cacheWrite), output: number(row.output), reasoning: number(row.reasoning), total: 0,
      costUsd: row.costUsd === null ? null : number(row.costUsd) };
    tokens.total = tokens.input + tokens.cacheRead + tokens.cacheWrite + tokens.output;
    if (tokens.costUsd === null) {
      const estimate = estimateCost(String(row.model), tokens);
      if (estimate !== undefined) { tokens.costUsd = estimate; tokens.costEstimated = true; }
    }
    const id = String(row.id);
    addTokens(tokensByCapture.get(id) ?? tokensByCapture.set(id, emptyTokens()).get(id)!, tokens);
    const harness = harnessOfCapture.get(id) ?? 'unknown';
    const modelKey = `${harness}:${row.model}`;
    const model = modelRows.get(modelKey) ?? { ...emptyTokens(), harness, model: String(row.model) };
    addTokens(model, tokens); modelRows.set(modelKey, model);
  }
  // Model responses after the harness's last total: that total is older than they are.
  const costBehind = new Set(captures.database.sql.prepare(`SELECT DISTINCT r.capture_id AS id FROM records r JOIN captures c ON c.id=r.capture_id
    WHERE c.workspace_root=? AND r.type='usage' AND json_extract(r.body,'$.usageScope')='call' AND json_extract(r.body,'$.beforeCapture') IS NULL AND ${agent} IS NULL
      AND r.revision > (SELECT max(t.revision) FROM records t WHERE t.capture_id=r.capture_id AND t.type='usage' AND json_extract(t.body,'$.usageScope')='session-total')`)
    .all(key).map(row => String(row.id)));
  for (const [id, cost] of sessionCost) {
    // The harness's own session total replaces summed per-call costs for that capture.
    const tokens = tokensByCapture.get(id) ?? tokensByCapture.set(id, emptyTokens()).get(id)!;
    tokens.costUsd = cost;
    if (costBehind.has(id)) tokens.costBehind = true;
  }

  const links = sessionLinks(captures, key);
  const sessions = inScope.map(manifest => {
    const row: any = counts.get(manifest.captureId) ?? {};
    return { captureId: manifest.captureId, harness: manifest.harness,
      harnessVersion: manifest.harnessVersion, status: manifest.status, endReason: manifest.endReason,
      // A shared copy is someone else's recording: it is read, never resumed.
      ...(captures.shared ? { shared: captures.shared } : { resume: resumeCommands(captures.dataDir, manifest.harness, manifest.captureId, manifest.workspaceRoot, manifest.source) }),
      startedAt: manifest.startedAt, endedAt: manifest.endedAt, lastObservedAt: row.lastObservedAt ?? manifest.startedAt,
      requests: number(row.requests), replies: number(row.replies), tools: number(row.tools), failures: number(row.failures),
      changes: number(row.changes), gaps: number(row.gaps), subagents: number(row.subagents),
      tokens: tokensByCapture.get(manifest.captureId) ?? emptyTokens(),
      links: links.get(manifest.captureId) ?? [],
      // Records survive in SQLite, but bodies, patches and transcript copies live in this folder.
      evidenceMissing: !fs.existsSync(captures.get(manifest.captureId).dir) || undefined };
  }).sort((a, b) => b.startedAt.localeCompare(a.startedAt));

  const harnesses = new Map<string, any>();
  for (const session of sessions) {
    const total = harnesses.get(session.harness) ?? { harness: session.harness, captures: 0, recording: 0,
      requests: 0, replies: 0, tools: 0, failures: 0, changes: 0, gaps: 0, subagents: 0, tokens: emptyTokens() };
    total.captures++; if (session.status === 'recording') total.recording++;
    for (const field of ['requests', 'replies', 'tools', 'failures', 'changes', 'gaps', 'subagents']) total[field] += (session as any)[field];
    addTokens(total.tokens, session.tokens);
    harnesses.set(session.harness, total);
  }
  const harnessOf = "coalesce(json_extract(c.manifest,'$.harness'),'pi')";
  const toolUsage = captures.database.sql.prepare(`SELECT ${harnessOf} AS harness, r.tool_name AS toolName,
      sum(r.type='tool_started') AS calls, sum(r.type='tool_finished' AND r.is_error=1) AS failures
    FROM records r JOIN captures c ON c.id=r.capture_id
    WHERE c.workspace_root=? AND r.type IN ('tool_started','tool_finished') AND r.tool_name IS NOT NULL
    GROUP BY harness, r.tool_name ORDER BY calls DESC LIMIT 40`).all(key)
    .map(row => ({ harness: String(row.harness), toolName: String(row.toolName), calls: number(row.calls), failures: number(row.failures) }));
  const files = captures.database.sql.prepare(`SELECT r.path AS path, json_extract(r.body,'$.worktree') AS worktree, count(*) AS changes,
      count(DISTINCT r.capture_id) AS captures, max(json_extract(r.body,'$.observedAt')) AS lastChangedAt
    FROM records r JOIN captures c ON c.id=r.capture_id WHERE c.workspace_root=? AND r.type='file_change'
    GROUP BY r.path, worktree ORDER BY changes DESC, lastChangedAt DESC LIMIT 20`).all(key)
    .map(row => ({ path: String(row.path), worktree: row.worktree === null ? undefined : String(row.worktree), changes: number(row.changes), captures: number(row.captures), lastChangedAt: String(row.lastChangedAt) }));
  return { readVersion, workspaceRoot: inScope[0]?.workspaceRoot ?? request.workspaceRoot,
    harnesses: [...harnesses.values()], sessions, toolUsage, files,
    models: [...modelRows.values()].sort((a, b) => b.total - a.total),
    notes: ['Counts are recorded evidence. Failures count tool results marked as errors; unknown outcomes are not counted.',
      'Tokens: input is uncached input; total = input + cacheRead + cacheWrite + output; reasoning is part of output. '
        + 'Each model response is counted once; resumed history from before a capture is excluded. '
        + 'Cost is only what the harness reported (Pi per message, Claude Code session total); Codex reports none.'] };
}
