import fs from 'node:fs';
import path from 'node:path';
import type { SessionStore, SharedInfo, SharedSession } from '../storage/store.js';
import { ledgerSchema, type LedgerRecord, type LedgerRequest, type Manifest } from '../core/schema.js';
import { EvidenceReader, evidenceVersion } from '../storage/evidence.js';
import { betterResult, conversation, type Change, type Subagent, type TurnItem } from './conversation.js';
import { adapter } from '../harnesses/index.js';
import { agentWork, projectOf, readCommit, toRecord, windowStart, windowTurns, workFor, type CommitInfo, type CommitRecord, type RecordStep, type Target } from '../team/commits.js';
import { gitText, readFile, readPolicy, recordIds, recordRef, recordsWithIds } from '../team/gitrefs.js';
import { plainGuide } from '../team/plain.js';
import { wisdomVersion } from '../setup/doctor.js';

/** The agent-facing ledger. Two moves over one session: glance (its shape and one entry
 * per turn) and open (one position, whole). Responses are plain text in recorded order.
 * Nothing is summarized or reworded; tool outputs and patches are never cut by a rule.
 * The only limit is the ceiling below, and a limited response says exactly where to continue.
 */
export const CEILING = 80_000;
/** A longer line is split so the ceiling can always be met; continued pieces start with ⤷. */
const WRAP = 2_000;
const INDENT = '    ';

type Tool = Extract<TurnItem, { kind: 'tool' }>;
type Context = { captures: SessionStore; version: number; manifest: Manifest; reader: EvidenceReader };

/** `shared` lists sessions imported from share files, for the plain session list only. */
export function ledger(captures: SessionStore, input: unknown, shared: SharedSession[] = [],
  stores: (id: string) => SessionStore | undefined = id => captures.database.manifests().some(m => m.captureId === id) ? captures : undefined): string {
  const parsed = ledgerSchema.safeParse(input);
  if (!parsed.success) throw new Error(`Invalid ledger request. ${parsed.error.issues.map(i => `${i.path.join('.') || 'request'}: ${i.message}`).join('; ')}. `
    + 'Use { glance: true } to list sessions, { capture, glance: true } for one session, or { capture, open: "t1" }.');
  const request = parsed.data;
  if (!!request.glance === !!request.open) throw new Error('Send exactly one of glance or open.');
  const version = evidenceVersion(captures, request.at);
  if (request.commit !== undefined) {
    if (!request.glance || request.capture) throw new Error('commit goes with glance and no capture: { glance: true, commit: "HEAD" }.');
    return commitGlance(captures, version, request.commit, request.from, stores);
  }
  if (request.glance && !request.capture) return sessions(captures, version, shared, request.from);
  if (!request.capture) throw new Error('open needs capture: an ID from glance, or "latest".');
  const manifest = resolveCapture(captures, request.capture, version);
  const context: Context = { captures, version, manifest, reader: new EvidenceReader(captures) };
  return request.glance ? glance(context, request.from) : open(context, request.open!, request.from);
}

export function resolveCapture(captures: SessionStore, ref: string, version: number): Manifest {
  const manifests = captures.database.manifests();
  if (!manifests.length) throw new Error('No sessions are recorded yet.');
  if (ref === 'latest') {
    // A session nobody prompted has nothing to read; it stays listed by a plain glance.
    const prompted = new Set(captures.database.sql.prepare(`SELECT DISTINCT capture_id AS id FROM records
      WHERE type='input' AND json_extract(body,'$.agentId') IS NULL AND revision<=?`).all(version).map(row => String(row.id)));
    const candidates = manifests.filter(m => prompted.has(m.captureId));
    return (candidates.length ? candidates : manifests).reduce((a, b) => b.startedAt > a.startedAt ? b : a);
  }
  const exact = manifests.find(m => m.captureId === ref);
  if (exact) return exact;
  const matches = ref.length >= 8 ? manifests.filter(m => m.captureId.startsWith(ref)) : [];
  if (matches.length === 1) return matches[0];
  throw new Error(matches.length > 1 ? `"${ref}" matches ${matches.length} sessions; use more of the ID.`
    : `No session matches "${ref}". Glance without capture to list sessions.`);
}

// ---------- response assembly ----------

/** Cut at a line boundary under the ceiling. The footer is the only place a response
 * says whether it is complete, and it names the exact request that continues it.
 */
function respond(lines: string[], from: number | undefined, next: LedgerRequest): string {
  const all: string[] = [];
  let wrapped = false;
  for (const line of lines) {
    if (line.length <= WRAP) { all.push(line); continue; }
    wrapped = true;
    for (let i = 0; i < line.length; i += WRAP) all.push((i ? '⤷ ' : '') + line.slice(i, i + WRAP));
  }
  const start = (from ?? 1) - 1;
  if (start > 0 && start >= all.length) throw new Error(`from ${from} is past the end: this response has ${all.length} lines.`);
  let end = start, size = 0;
  while (end < all.length && (end === start || size + all[end].length + 1 <= CEILING)) size += all[end++].length + 1;
  const footer = end < all.length
    ? `limited · lines ${start + 1}–${end} of ${all.length} · continue: ${JSON.stringify({ ...next, from: end + 1 })}`
    : start > 0 ? `complete · lines ${start + 1}–${end} of ${all.length}` : `complete · ${all.length} ${all.length === 1 ? 'line' : 'lines'}`;
  return [...all.slice(start, end), '', footer + (wrapped ? ' · lines over 2,000 characters are split; ⤷ marks a continued piece' : '')].join('\n');
}

/** A body under its label: one line beside the label, more lines indented below it.
 * `lead` replaces the indent on the first line only (a turn's position).
 */
function block(out: string[], indent: string, label: string, text: string | undefined, lead = indent): void {
  if (text === undefined) return;
  const lines = text.replace(/(\r?\n)+$/, '').split(/\r?\n/);
  if (lines.length === 1) out.push(`${lead}${label.padEnd(8)}  ${lines[0]}`);
  else { out.push(`${lead}${label}`); for (const line of lines) out.push(`${indent}${INDENT}${line}`); }
}

const number = (n: number) => n.toLocaleString('en-US');
const minute = (iso?: string) => iso ? iso.slice(0, 16).replace('T', ' ') + 'Z' : '';
const plural = (n: number, word: string) => `${number(n)} ${word}${n === 1 ? '' : 's'}`;
const short = (id: string) => id.slice(0, 8);
const ms = (value?: number) => value === undefined ? '' : value >= 1000 ? `${(value / 1000).toFixed(1)} s` : `${value} ms`;

function rows(context: Context, where: string, bindings: (string | number)[] = []): LedgerRecord[] {
  return context.captures.database.records(`capture_id=? AND revision<=? AND ${where}`,
    [context.manifest.captureId, context.version, ...bindings], 'ORDER BY seq');
}

function json(context: Context, record: LedgerRecord): any {
  try { const raw = context.reader.read(record, 'data'); return raw === undefined ? undefined : JSON.parse(raw); }
  catch { return undefined; }
}

// ---------- session structure ----------

interface Shape {
  turns: LedgerRecord[];
  agents: string[];
  /** Main turn each subagent belongs to (by its spawning call, or its first linked record). */
  agentTurn: Map<string, string | undefined>;
  records: LedgerRecord[];
}

const structureTypes = ['input', 'tool_started', 'tool_finished', 'file_change', 'gap', 'subagent_started', 'subagent_stopped', 'agent_settled', 'usage'];

/** Turns are the user's own inputs, in recorded order; subagents are numbered by first appearance. */
function shape(context: Context): Shape {
  const records = rows(context, `(type IN (${structureTypes.map(() => '?').join(',')}) OR (type IN ('message','source_record') AND role='assistant'))`, structureTypes)
    .filter(r => !r.internalAgent);
  const turns = records.filter(r => r.type === 'input' && !r.agentId);
  const turnIds = new Set(turns.map(t => t.id));
  const agents: string[] = [];
  for (const r of records) if (r.agentId && !agents.includes(r.agentId) && r.type !== 'usage') agents.push(r.agentId);
  const agentTurn = new Map<string, string | undefined>();
  for (const agent of agents) {
    const spawn = records.find(r => r.type === 'tool_finished' && r.childAgentId === agent && r.requestId && turnIds.has(r.requestId));
    const linked = records.find(r => r.agentId === agent && r.requestId && turnIds.has(r.requestId));
    const first = records.find(r => r.agentId === agent)!;
    const before = turns.filter(t => t.seq < first.seq).at(-1);
    agentTurn.set(agent, spawn?.requestId ?? linked?.requestId ?? before?.id);
  }
  return { turns, agents, agentTurn, records };
}

/** Per call: the start, and the result a hook reported (preferred) or the transcript established. */
function calls(records: LedgerRecord[]) {
  const finishes = new Map<string, LedgerRecord>();
  for (const r of records) if (r.type === 'tool_finished' && r.toolCallId) {
    if (betterResult(finishes.get(r.toolCallId), r)) finishes.set(r.toolCallId, r);
  }
  const started = new Map<string, LedgerRecord>();
  for (const r of records) if (r.type === 'tool_started' && r.toolCallId && !started.has(r.toolCallId)) started.set(r.toolCallId, r);
  const list = [...started.values()];
  return { count: list.length, failed: list.filter(r => finishes.get(r.toolCallId!)?.isError === true).length,
    pending: list.filter(r => !finishes.has(r.toolCallId!)).length };
}

function changeFacts(records: LedgerRecord[]): string {
  const changes = records.filter(r => r.type === 'file_change');
  if (!changes.length) return 'no changes';
  const paths = [...new Set(changes.map(c => c.worktree ? `${c.path ?? '?'} in worktree ${c.worktree}` : c.path ?? '?'))];
  const outside = changes.filter(c => c.attribution === 'external-or-unknown').length;
  return `changed ${paths.join(', ')}${outside ? ` (${plural(outside, 'change')} outside any tool call)` : ''}`;
}

function callFacts(records: LedgerRecord[], recording: boolean): string {
  const c = calls(records);
  return [c.count ? plural(c.count, 'tool call') : 'no tool calls', c.failed ? `${number(c.failed)} failed` : '',
    c.pending ? `${number(c.pending)} ${recording ? 'pending' : 'without a recorded result'}` : ''].filter(Boolean).join(' · ');
}

/** Tokens once per model response; native history from before the capture is excluded. */
function tokens(records: LedgerRecord[]): { total: number; cost?: number; callsAfterCost: number } {
  const seen = new Set<string>();
  let total = 0, cost: number | undefined, sessionCost: number | undefined, callsAfterCost = 0;
  for (const r of records) {
    if (r.type !== 'usage' || !r.usage || r.beforeCapture) continue;
    if (r.usageScope === 'session-total') { sessionCost = r.usage.costUsd; callsAfterCost = 0; continue; }
    const key = `${r.agentId ?? ''}:${r.usageKey}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // A subagent's usage is indexed when it stops, so its place in the records is not its time.
    if (!r.agentId) callsAfterCost++;
    total += r.usage.input + r.usage.cacheRead + r.usage.cacheWrite + r.usage.output;
    if (typeof r.usage.costUsd === 'number') cost = (cost ?? 0) + r.usage.costUsd;
  }
  // A harness's running total is only as new as its last report.
  return { total, cost: sessionCost ?? cost, callsAfterCost: sessionCost === undefined ? 0 : callsAfterCost };
}

/** An input says so when it is not a person's prompt seen live: a notice the harness wrote,
 * or a prompt read from the session file because no hook reported it. */
const inLabel = (turn: LedgerRecord) => {
  const notes = [turn.notice ? 'harness notice' : '', turn.inputBasis === 'session-file' ? 'from session file' : ''].filter(Boolean);
  return notes.length ? `in (${notes.join(', ')})` : 'in';
};

/** Where a change happened, when that is a linked worktree: its path is relative to it. */
const place = (change: { path?: string; worktree?: string; branch?: string }) =>
  `${change.path ?? '?'}${change.worktree ? ` in worktree ${change.worktree}${change.branch ? ` (branch ${change.branch})` : ''}` : ''}`;

function inputText(context: Context, record: LedgerRecord): string {
  const data = json(context, record);
  if (data === undefined) return `[input body unavailable · ${record.summary}]`;
  return (data.text ?? '') + (data.images?.length ? `\n[${plural(data.images.length, 'image')} attached]` : '');
}

function lastReply(context: Context, records: LedgerRecord[]): string | undefined {
  const reply = records.filter(r => ['message', 'source_record'].includes(r.type) && r.role === 'assistant' && r.summary).at(-1);
  if (reply) return reply.summary.length >= 240 ? reply.summary + '…' : reply.summary;
  const settled = records.filter(r => r.type === 'agent_settled').at(-1);
  const text = settled ? json(context, settled)?.lastAssistantMessage : undefined;
  if (typeof text !== 'string' || !text.trim()) return undefined;
  const flat = text.replace(/\s+/g, ' ').trim();
  return (flat.length > 240 ? flat.slice(0, 240) + '…' : flat) + ' (from hook)';
}

/** What reading Wisdom cost this session: its calls to the ledger (the MCP tool, or a shell
 * running `wisdom glance`/`open`/`guide`/`check`) and how much text they returned. Tokens are
 * estimated at four characters each; the harness's own counts include them, unseparated. */
const shellTools = /^(bash|shell|shell_command|exec_command|powershell|local_shell)$/i;
const wisdomCommand = /(?:\bwisdom(?:\.cmd)?|cli\.js["']?)\s+(?:[^|;&\n]*\s)?(?:glance|open|guide|check)\b/;
function wisdomReads(context: Context, records: LedgerRecord[]): { calls: number; chars: number } {
  let calls = 0, chars = 0;
  const finishes = new Map<string, LedgerRecord>();
  for (const r of records) if (r.type === 'tool_finished' && r.toolCallId && betterResult(finishes.get(r.toolCallId), r)) finishes.set(r.toolCallId, r);
  for (const r of records) {
    if (r.type !== 'tool_started' || !r.toolName || !r.toolCallId) continue;
    let reads = /(^|__)ledger$/.test(r.toolName);
    if (!reads && shellTools.test(r.toolName)) {
      const input = json(context, r)?.input;
      const command = input?.command ?? input?.cmd;
      reads = wisdomCommand.test(Array.isArray(command) ? command.join(' ') : String(command ?? ''));
    }
    if (!reads) continue;
    calls++;
    const finish = finishes.get(r.toolCallId);
    if (finish && !finish.resultBasis) {
      try { chars += context.reader.read(finish, 'data')?.length ?? 0; } catch { /* unreadable: counted as a call only */ }
    }
  }
  return { calls, chars };
}

// ---------- glance ----------

function sessions(captures: SessionStore, version: number, shared: SharedSession[], from?: number): string {
  const manifests = captures.database.manifests().sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  if (!manifests.length && !shared.length) return respond(['No sessions are recorded yet.'], from, { glance: true, at: version });
  const counts = new Map(captures.database.sql.prepare(`SELECT capture_id AS id, count(*) AS n FROM records
    WHERE type='input' AND json_extract(body,'$.agentId') IS NULL AND revision<=? GROUP BY capture_id`).all(version)
    .map(row => [String(row.id), Number(row.n)]));
  const lines: string[] = [];
  if (manifests.length) lines.push(`sessions · ${number(manifests.length)}, newest first · version ${version}`, '');
  for (const m of manifests) {
    lines.push(`${m.captureId}  ${m.harness}  ${m.status}  ${minute(m.startedAt)}  ${plural(counts.get(m.captureId) ?? 0, 'turn')}  ${m.workspaceRoot}`);
  }
  // Shared copies have versions of their own, so this list's version does not cover them.
  if (shared.length) {
    lines.push(...(manifests.length ? [''] : []), `shared with you · ${number(shared.length)}, read-only`, '');
    for (const s of [...shared].sort((a, b) => b.startedAt.localeCompare(a.startedAt))) {
      lines.push(`${s.captureId}  ${s.harness}  ${minute(s.startedAt)}  ${plural(s.turns, 'turn')}  from ${s.project}, shared ${minute(s.sharedAt)}`);
    }
  }
  lines.push('', 'To read one, glance its ID or its first 8 characters.');
  return respond(lines, from, { glance: true, at: version });
}


/** How a shared copy introduces itself: whose it is, that it is read-only, and what the sender redacted. */
function sharedLines(shared: SharedInfo): string[] {
  return [`shared copy from ${shared.project}, shared ${minute(shared.sharedAt)} · read-only, as recorded on the sender's machine`,
    ...(shared.redactions ? [`redacted by sender ×${shared.redactions}${shared.patchesEdited.length ? ` · patches edited by redaction: ${shared.patchesEdited.join(', ')}` : ''}`] : [])];
}

function glance(context: Context, from?: number): string {
  const { manifest, version } = context;
  const { shared } = context.captures;
  const ledger = context.captures.get(manifest.captureId);
  const { turns, agents, agentTurn, records } = shape(context);
  const recording = manifest.status === 'recording';
  const main = records.filter(r => !r.agentId);
  const t = tokens(records);
  const lines: string[] = [
    `session ${manifest.captureId} · ${manifest.harness}${manifest.harnessVersion ? ` ${manifest.harnessVersion}` : ''} · ${manifest.status}${manifest.endReason ? ` (${manifest.endReason})` : ''} · version ${version}`,
    // A resume run outside Wisdom loads no hooks, so its work would never reach the ledger.
    // A shared copy is someone else's recording: it can be read, not resumed.
    ...(shared ? sharedLines(shared) : [`resume with: wisdom resume ${manifest.captureId}`]),
    `workspace ${manifest.workspaceRoot}`,
    `started ${minute(manifest.startedAt)}${manifest.endedAt ? ` · ended ${minute(manifest.endedAt)}` : ''}`,
    // A handoff that resumed this session took effect at the turn after it.
    ...rows(context, "type='session_link'").map(({ summary, link, seq }) =>
      link?.kind === 'continued-after' ? `${summary} · at t${turns.filter(turn => turn.seq < seq).length + 1}` : summary),
    [plural(turns.length, 'turn'), callFacts(records, recording), plural(records.filter(r => r.type === 'file_change').length, 'change'),
      plural(agents.length, 'subagent'), `${number(t.total)} tokens`, t.cost === undefined ? '' : `$${t.cost.toFixed(4)} reported${t.callsAfterCost ? ` before the last ${plural(t.callsAfterCost, 'model call')}` : ''}`].filter(Boolean).join(' · '),
  ];
  const reads = wisdomReads(context, records);
  if (reads.calls) lines.push(`read Wisdom · ${plural(reads.calls, 'call')} · ${plural(reads.chars, 'character')} returned, about ${number(Math.ceil(reads.chars / 4))} tokens`);
  if (!fs.existsSync(ledger.dir)) lines.push('evidence folder missing: inputs, outputs and patches cannot be read');
  // A kind that repeats three or more times is one line with its count, first and last.
  // Every gap stays a record; only the glance line is shared.
  const gaps = records.filter(r => r.type === 'gap');
  const byKind = new Map<string, LedgerRecord[]>();
  for (const gap of gaps) {
    const kind = gap.summary.split(':', 1)[0];
    byKind.set(kind, [...byKind.get(kind) ?? [], gap]);
  }
  for (const same of byKind.values()) {
    if (same.length < 3) for (const gap of same) lines.push(`not recorded  ${gap.summary} (seq ${gap.seq})`);
    else {
      const [first, last] = [same[0], same.at(-1)!];
      const detail = (gap: LedgerRecord) => gap.summary.slice(gap.summary.indexOf(':') + 1);
      lines.push(`not recorded  ${first.summary.split(':', 1)[0]} ×${same.length} · first (seq ${first.seq}): ${detail(first)} · last (seq ${last.seq}): ${detail(last)}`);
    }
  }
  for (const gap of ledger.recoveryGaps) lines.push(`not recorded  ${gap}`);

  const byTurn = (id: string) => main.filter(r => r.requestId === id);
  turns.forEach((turn, index) => {
    const own = byTurn(turn.id);
    lines.push('');
    block(lines, INDENT, inLabel(turn), inputText(context, turn), `t${index + 1}`.padEnd(4));
    const out = lastReply(context, own);
    if (out) lines.push(`${INDENT}out       ${out}`);
    lines.push(`${INDENT}${[callFacts(own, recording), changeFacts(own)].join(' · ')}`);
    agents.forEach((agent, i) => {
      if (agentTurn.get(agent) !== turn.id) return;
      const work = records.filter(r => r.agentId === agent);
      const type = work.filter(r => r.type === 'subagent_started' || r.type === 'subagent_stopped')
        .map(r => json(context, r)?.agentType).find(t => typeof t === 'string' && t);
      lines.push(`${INDENT}subagent a${i + 1}${type ? ` (${type})` : ''} · ${callFacts(work, recording)} · ${changeFacts(work)}`);
    });
  });

  const outside = main.filter(r => !r.requestId && ['file_change', 'tool_started', 'tool_finished'].includes(r.type));
  const outsideWork = outside.some(r => r.type !== 'tool_finished');
  const unplaced = agents.filter(agent => !agentTurn.get(agent));
  if (outsideWork || unplaced.length) {
    lines.push('', `outside   ${[outsideWork ? `${callFacts(outside, recording)} · ${changeFacts(outside)}` : '',
      unplaced.length ? `subagents ${unplaced.map(a => `a${agents.indexOf(a) + 1}`).join(', ')}` : ''].filter(Boolean).join(' · ')} · open "outside"`);
  }
  if (!turns.length && !outsideWork && !unplaced.length) lines.push('', 'No turns recorded yet.');
  return respond(lines, from, { capture: manifest.captureId, glance: true, at: version });
}

// ---------- commits ----------

/** Where a recorded change sits in its session, as a position that can be opened:
 * the call it was observed during, or its turn or subagent when no call was running. */
function positioner(captures: SessionStore, version: number): (record: LedgerRecord) => string {
  const sessions = new Map<string, { s: Shape; items: Map<string, TurnItem[]> }>();
  return record => {
    let session = sessions.get(record.captureId);
    if (!session) {
      const context: Context = { captures, version, manifest: captures.get(record.captureId).manifest, reader: new EvidenceReader(captures) };
      session = { s: shape(context), items: new Map() };
      sessions.set(record.captureId, session);
    }
    const { s, items: cache } = session;
    const turnItems = (turnId: string) => cache.get(turnId)
      ?? cache.set(turnId, conversation(captures, { captureId: record.captureId, requestId: turnId, readVersion: version }).items).get(turnId)!;
    // A change carries its call, not its agent: a subagent's call says which subagent it was.
    const start = record.toolCallId ? s.records.find(r => r.type === 'tool_started' && r.toolCallId === record.toolCallId) : undefined;
    const agent = record.agentId ?? start?.agentId;
    let scope: string, items: TurnItem[] | undefined;
    if (agent && s.agents.includes(agent)) {
      scope = `a${s.agents.indexOf(agent) + 1}`;
      const turnId = s.agentTurn.get(agent);
      items = turnId ? findSubagent(turnItems(turnId), agent)?.items : undefined;
    } else {
      const turn = s.turns.findIndex(t => t.id === record.requestId);
      if (turn < 0) return 'outside';
      scope = `t${turn + 1}`;
      items = turnItems(record.requestId!);
    }
    const tools = (items ?? []).filter((item): item is Tool => item.kind === 'tool');
    const call = tools.findIndex(tool => tool.changes.some(change => change.id === record.id));
    return call < 0 ? scope : `${scope}/c${call + 1}`;
  };
}

/** A commit's record, worked out from this store's recordings. `target` defaults to the
 * commit against its first parent; `made` says whether it is kept at commit time or only shown. */
export function buildRecord(captures: SessionStore, version: number, project: string, commit: CommitInfo,
  extra: { made: 'commit' | 'later' | 'now'; recorder?: string; target?: Target }): CommitRecord {
  const target = extra.target ?? { parent: commit.parent, rev: commit.sha, until: Date.parse(commit.committedAt) };
  const files = workFor(captures, version, project, target);
  const record = toRecord(files, positioner(captures, version), id => captures.get(id).manifest.harness,
    { commit, made: extra.made, madeAt: new Date().toISOString(), wisdomVersion: wisdomVersion(), recorder: extra.recorder });
  // A record kept at commit time names the window its guide covers: since this person's
  // previous commit on the branch, and each session's turns inside it.
  if (extra.made !== 'now' && extra.recorder && record.sessions.length) {
    const since = windowStart(project, extra.recorder, commit.parent);
    record.window = { ...(since ? { since } : {}), until: commit.committedAt };
    for (const session of record.sessions) {
      const turns = windowTurns(captures, session.id, since ? Date.parse(since.at) : undefined, target.until, session.positions);
      if (turns) session.turns = turns;
    }
  }
  return record;
}

/** Has the session a step cites still got that exact change? Each step is checked on its own. */
type StepState = 'ok' | 'changed' | 'missing';
function checkStep(stores: (id: string) => SessionStore | undefined, step: RecordStep): StepState {
  const store = stores(step.session);
  if (!store) return 'missing';
  const found = store.database.sql.prepare(`SELECT 1 FROM records WHERE capture_id=? AND type='file_change'
    AND json_extract(body,'$.afterHash') IS ? AND json_extract(body,'$.beforeHash') IS ? AND json_extract(body,'$.patchRef') IS ? LIMIT 1`)
    .get(step.session, step.after, step.before, step.patch ?? null);
  return found ? 'ok' : 'changed';
}

/** Was this commit made with this clone's git identity? Without one set, it counts as made here. */
function committedHere(project: string, sha: string): boolean {
  try {
    const committer = gitText(project, ['log', '-1', '--format=%ce', sha]);
    let me = '';
    try { me = gitText(project, ['config', 'user.email']); } catch { /* no identity set */ }
    return !me || committer === me;
  } catch { return true; }
}

/** A commit, piece by piece, with the recorded steps that made each one: from the record kept
 * when the commit was made, or worked out now when there is none. */
function commitGlance(captures: SessionStore, version: number, ref: string, from: number | undefined,
  stores: (id: string) => SessionStore | undefined): string {
  const project = projectOf(captures);
  const commit = readCommit(project, ref);
  const harnessOf = (id: string) => stores(id)?.get(id).manifest.harness;
  const next = { glance: true as const, commit: commit.sha, at: version };
  const keptText = readFile(project, recordRef(commit.sha), 'record.json')?.toString('utf8');
  const kept: CommitRecord | undefined = keptText ? JSON.parse(keptText) : undefined;
  // Work brought in from other commits (a squash merge, a cherry-pick): the records its message
  // names through their Wisdom-Record lines, besides its own.
  const carried = recordsWithIds(project, recordIds(project, commit.sha).filter(id => id !== kept?.recordId))
    .filter(found => found.commit !== commit.sha);
  let recorder: string | undefined;
  try { recorder = JSON.parse(fs.readFileSync(path.join(captures.dataDir, 'recorder.json'), 'utf8')).id; } catch { recorder = undefined; }
  const reader = { recorder, madeHere: committedHere(project, commit.sha) };
  const lines = kept ? renderRecord(kept, version, stores, harnessOf, !readPolicy(project), reader)
    : carried.length ? [`commit ${commit.sha.slice(0, 12)} · ${commit.subject} · version ${version}`, 'no record of its own', `the commit's own diff: git show ${commit.sha.slice(0, 12)}`]
    : renderRecord(buildRecord(captures, version, project, commit, { made: 'now' }), version, undefined, harnessOf, false, reader);
  if (carried.length) {
    lines.push('', `its message carries ${plural(carried.length, 'recorded commit')} through their Wisdom-Record lines (a squash merge, say); their records follow`);
    for (const found of carried) lines.push('', `── carried: ${found.commit.slice(0, 12)}`, ...renderRecord(JSON.parse(found.text), undefined, stores, harnessOf, false, reader));
  }
  return respond(lines, from, next);
}

/** The text of a commit record. With `stores`, every step is checked against the session it cites.
 * `local`: in local mode a kept record with agent work and no stored guide shows the plain guide,
 * built now from the record and the requests it cites, never stored. */
export function renderRecord(record: CommitRecord, version: number | undefined, stores?: (id: string) => SessionStore | undefined,
  harnessOf: (id: string) => string | undefined = () => undefined, local = false,
  reader: { recorder?: string; madeHere?: boolean } = {}): string[] {
  // A teammate reading someone else's record: "your previous commit" would be wrong (live test 5.11).
  const yours = !reader.recorder || !record.recorder || reader.recorder === record.recorder;
  const { commit } = record;
  const states = record.steps.map(step => stores ? checkStep(stores, step) : 'ok' as StepState);
  const used = new Map<string, string[]>();
  const describe = (indexes: number[]): string => {
    const bySession = new Map<string, string[]>();
    for (const k of indexes) {
      const step = record.steps[k];
      const seen = used.get(step.session) ?? used.set(step.session, []).get(step.session)!;
      if (!seen.includes(step.position)) seen.push(step.position);
      const notes = [step.attribution === 'observed-during-tool' ? '' : step.attribution === 'reported-by-harness' ? 'reported by the harness' : 'changed outside any recorded step',
        states[k] === 'changed' ? 'changed since the commit' : states[k] === 'missing' ? 'session not available' : ''].filter(Boolean);
      const label = notes.length ? `${step.position} (${notes.join(', ')})` : step.position;
      const list = bySession.get(step.session) ?? bySession.set(step.session, []).get(step.session)!;
      if (!list.includes(label)) list.push(label);
    }
    return [...bySession].map(([id, labels]) => `${labels.join(', ')} in session ${short(id)}`).join('; ');
  };
  let full = 0, partly = 0, none = 0, byFile = 0;
  const body: string[] = [];
  for (const file of record.files) {
    const head = `${file.path} · ${file.operation}`;
    const counts = file.note === 'binary' ? 'binary' : `+${number(file.added)} −${number(file.removed)}`;
    const earlier = file.complete ? '' : ' · earlier changes not recorded';
    if (file.note === 'outside-project') { body.push(`${head} · outside this project, not recorded here`); continue; }
    if (file.note === 'not-watched') { body.push(`${head} · ${counts} · not recorded: excluded from recording`); continue; }
    if (!file.chain.length) { none++; body.push(`${head} · ${counts} · not recorded`); continue; }
    if (!file.pieces) {
      byFile++;
      body.push(`${head} · ${counts} · whole file from ${describe(file.chain)}${earlier}${file.lineGap ? ` · ${file.lineGap}` : ''}`);
      continue;
    }
    body.push(`${head} · ${counts}`);
    for (const piece of file.pieces) {
      const made = piece.steps.length ? describe(piece.steps) : '';
      if (!made) none++; else if (piece.unexplained) partly++; else full++;
      body.push(`${INDENT}${piece.header}  ${[made || 'not recorded', made && piece.unexplained ? `${plural(piece.unexplained, 'line')} not recorded` : '',
        piece.byFile ? 'lined up by file, not by line' : ''].filter(Boolean).join(' · ')}`);
    }
  }
  const pieces = full + partly + none;
  const changed = states.filter(s => s === 'changed').length, missing = states.filter(s => s === 'missing').length;
  const lines = [
    `commit ${commit.sha.slice(0, 12)} · ${commit.subject} · committed ${minute(new Date(commit.committedAt).toISOString())}${version === undefined ? '' : ` · version ${version}`}`,
    `${commit.parent ? `parent ${commit.parent.slice(0, 12)}` : 'first commit'} · ${plural(record.files.length, 'file')} · ${[
      pieces ? `${plural(pieces, 'piece')}: ${number(full)} from recorded steps${partly ? `, ${number(partly)} partly recorded` : ''}${none ? `, ${number(none)} not recorded` : ''}` : '',
      byFile ? `${plural(byFile, 'file')} matched as a whole` : ''].filter(Boolean).join(' · ') || 'nothing matched'}`,
    record.made === 'now' ? (reader.madeHere === false ? 'worked out now from the recordings here; no record of this commit is here'
      : 'worked out now from the recordings; no record was kept when the commit was made')
      : `${record.made === 'later' ? `record kept later, ${minute(record.madeAt)}, because the job after the commit did not finish; it reads the recordings up to the commit's time`
        : `record kept when the commit was made, ${minute(record.madeAt)}`}${changed ? ` · ${plural(changed, 'step')} changed since` : ''}${missing ? ` · ${plural(missing, 'step')} in sessions not available here` : ''}`,
    `the commit's own diff: git show ${commit.sha.slice(0, 12)}`,
    '', ...body,
  ];
  if (used.size) {
    lines.push('', 'sessions');
    // In session order: turns, then subagents, then outside; calls by number.
    const rank = (at: string) => {
      const match = /^(t|a)(\d+)(?:\/c(\d+))?$/.exec(at);
      return match ? [match[1] === 't' ? 0 : 1, Number(match[2]), Number(match[3] ?? 0)] : [2, 0, 0];
    };
    const order = (a: string, b: string) => { const [x, y] = [rank(a), rank(b)]; return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]; };
    for (const [id, positions] of used) {
      const known = record.sessions.find(s => s.id === id);
      const window = known?.turns ? ` · window ${known.turns[0] === known.turns[1] ? `t${known.turns[0]}` : `t${known.turns[0]}–t${known.turns[1]}`}` : '';
      lines.push(`${INDENT}${id}  ${harnessOf(id) ?? known?.harness ?? '?'}  ${[...positions].sort(order).join(', ')}${window}`);
    }
    if (record.window) lines.push(`${INDENT}window: ${record.window.since
      ? `since ${yours ? 'your' : 'the recorder\'s'} previous commit on this branch, ${record.window.since.commit.slice(0, 12)} (${minute(new Date(record.window.since.at).toISOString())})`
      : `from the start of these sessions (no earlier commit of ${yours ? 'yours' : 'the recorder\'s'} on this branch)`}, up to this commit`);
    const [id, [at]] = [...used][0];
    lines.push('', `To read a step, open its position in its session, such as ${JSON.stringify({ capture: short(id), open: at })}.`);
  }
  if (record.guide) {
    const { guide } = record;
    lines.push('', `guide · written by ${guide.writer}, ${minute(guide.writtenAt)} · derived, not evidence · ${guide.problems.length
      ? `did not pass Wisdom's check: ${guide.problems.join('; ')}` : 'Wisdom checked that it covers every item and that its citations exist, not that it is right'}`);
    for (const line of guide.text.replace(/\s+$/, '').split(/\r?\n/)) lines.push(line ? INDENT + line : '');
  } else if (record.guideMissing) lines.push('', `guide · none: ${record.guideMissing}`);
  else if (local && stores && agentWork(record)) {
    lines.push('', `guide · plain, built from the record now, no model · derived, not evidence · not stored; a model guide on request: wisdom guide ${commit.sha.slice(0, 12)}`);
    for (const line of plainGuide(record, stores).replace(/\s+$/, '').split(/\r?\n/)) lines.push(line ? INDENT + line : '');
  }
  return lines;
}

// ---------- open ----------

function open(context: Context, position: string, from?: number): string {
  const match = /^(?:(t|a)(\d+)(?:\/c(\d+))?|(outside))$/.exec(position);
  if (!match) throw new Error(`"${position}" is not a position. Use t3 (a turn), t3/c2 (a tool call), a1 (a subagent), a1/c2, or outside.`);
  const next = { capture: context.manifest.captureId, open: position, at: context.version };
  if (match[4]) return respond(renderOutside(context), from, next);
  const s = shape(context);
  const index = Number(match[2]) - 1;
  const call = match[3] === undefined ? undefined : Number(match[3]);
  if (match[1] === 't') {
    const turn = s.turns[index];
    if (!turn) throw new Error(`t${index + 1} does not exist: this session has ${s.turns.length ? `t1–t${s.turns.length}` : 'no turns'} at version ${context.version}.`);
    const view = conversation(context.captures, { captureId: context.manifest.captureId, requestId: turn.id, readVersion: context.version });
    const header = `t${index + 1} · session ${short(context.manifest.captureId)} · version ${context.version} · ${number(view.tokens.total)} tokens`;
    const lines = [header];
    // A single call is opened to read its bodies; the turn's input is one glance away.
    if (call === undefined) { block(lines, '', inLabel(turn), inputText(context, turn)); lines.push(''); }
    const body = renderItems(context, s, view.items, `t${index + 1}`, call);
    if (!body.length) body.push('Nothing else is recorded in this turn yet: no thinking, replies, tool calls or changes.');
    return respond(lines.concat(body, issueLines(view.issues)), from, next);
  }
  const agent = s.agents[index];
  if (!agent) throw new Error(`a${index + 1} does not exist: this session has ${s.agents.length ? `a1–a${s.agents.length}` : 'no subagents'} at version ${context.version}.`);
  const turnId = s.agentTurn.get(agent);
  const subagent = turnId ? findSubagent(conversation(context.captures, { captureId: context.manifest.captureId, requestId: turnId, readVersion: context.version }).items, agent) : undefined;
  const turnNo = s.turns.findIndex(t => t.id === turnId) + 1;
  if (!subagent) {
    // Not placed under a turn: its records are still listed, in order, so nothing is hidden.
    const lines = [`a${index + 1} · session ${short(context.manifest.captureId)} · version ${context.version} · not linked to a turn`, ''];
    const own = new Set(s.records.filter(r => r.agentId === agent && r.toolCallId).map(r => r.toolCallId));
    for (const r of s.records.filter(r => r.agentId === agent || r.toolCallId && own.has(r.toolCallId))) {
      lines.push(`seq ${r.seq}  ${r.type}  ${r.summary}${r.isError ? ' · failed' : ''}`);
    }
    return respond(lines, from, next);
  }
  const lines = [`a${index + 1} · subagent${subagent.agentType ? ` (${subagent.agentType})` : ''} in t${turnNo} · session ${short(context.manifest.captureId)} · version ${context.version}`];
  block(lines, '', 'task', subagent.task?.text);
  lines.push('');
  const body = renderItems(context, s, subagent.items, `a${index + 1}`, call);
  if (call === undefined && subagent.report) { body.push(''); block(body, '', 'report', subagent.report.text); }
  return respond(lines.concat(body), from, next);
}

function findSubagent(items: TurnItem[], agent: string): Subagent | undefined {
  for (const item of items) {
    const subagent = item.kind === 'subagent' ? item.subagent : item.kind === 'tool' ? item.subagent : undefined;
    if (!subagent) continue;
    if (subagent.agentId === agent) return subagent;
    const nested = findSubagent(subagent.items, agent);
    if (nested) return nested;
  }
  return undefined;
}

function issueLines(issues: { id: string; reason: string }[]): string[] {
  return issues.length ? ['', ...issues.map(issue => `unreadable  record ${issue.id}: ${issue.reason}`)] : [];
}

/** Items in recorded order, calls numbered within their scope, all patches together at the end. */
function renderItems(context: Context, s: Shape, items: TurnItem[], scope: string, only?: number): string[] {
  const harness = adapter(context.manifest.harness);
  const recording = context.manifest.status === 'recording';
  const lines: string[] = [];
  const patches: { change: Change; owner?: string }[] = [];
  const tools = items.filter((item): item is Tool => item.kind === 'tool');
  if (only !== undefined && !tools[only - 1]) {
    throw new Error(`${scope}/c${only} does not exist: ${scope} has ${tools.length ? `c1–c${tools.length}` : 'no tool calls'}.`);
  }
  const patchRef = (change: Change, owner?: string) => { patches.push({ change, owner }); return `p${patches.length}`; };
  for (const item of items) {
    if (only !== undefined && !(item.kind === 'tool' && tools.indexOf(item) === only - 1)) continue;
    if (item.kind === 'text') block(lines, '', item.source === 'hook' ? 'reply (from hook)' : 'reply', item.text.text);
    else if (item.kind === 'thinking') {
      if (item.redacted || !item.text.text) lines.push(`thinking  redacted${item.durationMs ? ` · ${ms(item.durationMs)}` : ''} (it happened; its text was not recorded)`);
      else block(lines, '', `thinking${item.durationMs ? ` · ${ms(item.durationMs)}` : ''}`, item.text.text);
    } else if (item.kind === 'change') {
      lines.push(`change    ${place(item)} · ${patchRef(item)} · not made by a recorded tool call`);
    } else if (item.kind === 'subagent') {
      const n = s.agents.indexOf(item.subagent.agentId) + 1;
      lines.push(`subagent  a${n}${item.subagent.agentType ? ` (${item.subagent.agentType})` : ''} · not linked to a call · open a${n}`);
    } else {
      const c = tools.indexOf(item) + 1;
      const input = parse(item.input?.text);
      const target = relative(context, harness.toolTarget(item.name, input));
      const view = only !== undefined ? 'full' : harness.toolView(item.name);
      const refs = item.changes.map(change => patchRef(change, `c${c}`));
      const step = harness.isScriptStep(item.name);
      const status = step ? 'script step' : item.status === 'ok' ? 'ok' : item.status === 'error' ? 'failed'
        : item.status === 'pending' ? recording ? 'pending' : 'no result recorded' : 'outcome not recorded';
      const child = item.subagent ? s.agents.indexOf(item.subagent.agentId) + 1 : 0;
      lines.push([`c${c}  ${item.name}${target ? ` ${target}` : ''}`, status, ms(item.durationMs),
        item.resultBasis ? 'result from transcript' : '', item.native && !step ? 'seen only in transcript' : '',
        refs.length ? `→ ${refs.join(', ')}` : '', child ? `→ a${child} (open a${child})` : ''].filter(Boolean).join(' · '));
      // The change is the evidence: an edit's input and output repeat it, so they are shown once, as its patch.
      if (view === 'patch' && refs.length && item.status !== 'error') {
        lines.push(`${INDENT}input and output repeat ${refs.join(', ')} · open ${scope}/c${c} to read them`);
        continue;
      }
      block(lines, INDENT, 'input', compact(input, item.input?.text));
      if (view === 'file' && item.status === 'ok' && item.output) {
        lines.push(`${INDENT}output    file content, ${plural(item.output.text.length, 'character')} · open ${scope}/c${c} to read it`);
      } else if (item.output) block(lines, INDENT, 'output', item.output.text);
      else if (item.status !== 'pending') lines.push(`${INDENT}output    none recorded`);
    }
  }
  if (patches.length) lines.push('');
  patches.forEach(({ change, owner }, i) => {
    const stat = diffStat(change.patch?.text);
    const basis = change.attribution === 'observed-during-tool' && owner ? `observed during ${owner}` : change.attribution ?? 'attribution unknown';
    lines.push([`p${i + 1}  ${place(change)}`, change.operation, stat, basis].filter(Boolean).join(' · '));
    if (change.patch) for (const line of change.patch.text.replace(/\n$/, '').split(/\r?\n/)) {
      if (!/^Index: /.test(line) && !/^=+$/.test(line)) lines.push(INDENT + line);
    } else lines.push(`${INDENT}patch not recorded${change.patchUnavailable ? `: ${change.patchUnavailable}` : ''}`);
  });
  return lines;
}

function renderOutside(context: Context): string[] {
  const records = rows(context, "request_id IS NULL AND type IN ('file_change','tool_started','tool_finished')").filter(r => !r.agentId && !r.internalAgent);
  const lines = [`outside · session ${short(context.manifest.captureId)} · version ${context.version} · recorded with no turn (before the first input, or between turns)`, ''];
  const starts = records.filter(r => r.type === 'tool_started');
  for (const r of starts) {
    const result = records.find(f => f.type === 'tool_finished' && f.toolCallId === r.toolCallId);
    lines.push(`call  ${r.toolName ?? 'tool'} · ${result ? result.isError ? 'failed' : 'ok' : 'no result recorded'} · seq ${r.seq}`);
    block(lines, INDENT, 'input', compact(json(context, r)?.input));
  }
  const changes = records.filter(r => r.type === 'file_change');
  changes.forEach((r, i) => {
    let patch: string | undefined;
    try { patch = context.reader.read(r, 'patch'); } catch (error) { patch = undefined; lines.push(`unreadable  record ${r.id}: ${error}`); }
    lines.push([`p${i + 1}  ${place(r)}`, r.operation, diffStat(patch), r.attribution ?? 'attribution unknown', `seq ${r.seq}`].filter(Boolean).join(' · '));
    if (patch) for (const line of patch.replace(/\n$/, '').split(/\r?\n/)) { if (!/^Index: /.test(line) && !/^=+$/.test(line)) lines.push(INDENT + line); }
    else lines.push(`${INDENT}patch not recorded${r.patchUnavailable ? `: ${r.patchUnavailable}` : ''}`);
  });
  if (!starts.length && !changes.length) lines.push('Nothing was recorded outside a turn.');
  return lines;
}

function parse(text?: string): unknown {
  if (text === undefined) return undefined;
  try { return JSON.parse(text); } catch { return text; }
}

/** Short structured input stays on one line; longer input keeps its indented form. */
function compact(value: unknown, original?: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return value;
  const line = JSON.stringify(value);
  return line.length <= 200 ? line : original ?? JSON.stringify(value, null, 2);
}

function relative(context: Context, target?: string): string | undefined {
  if (!target) return undefined;
  const rel = path.isAbsolute(target) ? path.relative(context.manifest.workspaceRoot, target) : target;
  return (rel.startsWith('..') ? target : rel).replace(/\\/g, '/');
}

function diffStat(patch?: string): string {
  if (!patch) return '';
  let add = 0, del = 0;
  for (const line of patch.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) add++;
    else if (line.startsWith('-') && !line.startsWith('---')) del++;
  }
  return `+${add} −${del}`;
}
