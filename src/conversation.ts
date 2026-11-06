import type { SessionStore } from './store.js';
import type { LedgerRecord } from './schema.js';
import { EvidenceReader, evidenceVersion } from './evidence.js';
import { nativeMessage } from './harnesses/index.js';
import { messageContent } from './content.js';
import { estimateCost } from './prices.js';

/** One turn, at one version. Without maxChars every body is returned whole. */
export interface TurnRequest { captureId: string; requestId: string; readVersion?: number; maxChars?: number }

/** A tool result without its transport envelope. Native message envelopes carry provider
 * metadata; hook result bodies keep their meaningful extra fields (details, structuredContent).
 */
export function cleanOutput(body: any): any {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body ?? null;
  if (body.message || body.role === 'toolResult') return messageContent((body.message ?? body).content);
  const { content: blocks, ...extra } = body;
  const text = messageContent(blocks);
  const structured = extra.structuredContent;
  // Pi's shell result repeats stdout inside a timing/exit-status envelope. Flatten only this
  // recognized successful, untruncated duplicate; anything else keeps its fields.
  if (structured && structured.output === text && structured.truncated === false && structured.exit_code === 0
    && Object.keys(structured).every(k => ['output', 'truncated', 'exit_code', 'wall_time_seconds'].includes(k))) {
    delete extra.structuredContent;
  }
  for (const key of Object.keys(extra)) {
    if (extra[key] === null || typeof extra[key] === 'object' && !Object.keys(extra[key]).length) delete extra[key];
  }
  if (!Object.keys(extra).length && blocks !== undefined) return text;
  return blocks === undefined ? extra : { content: text, ...extra };
}

/** Clipped body: long text keeps its size and the record to inspect for the rest. */
export interface Body { text: string; truncated?: true; totalChars?: number; recordId?: string }
export interface Change { kind: 'change'; id: string; at: string; path?: string; operation?: string; attribution?: string; worktree?: string; branch?: string;
  patch?: Body; patchUnavailable?: string }
export interface Subagent { agentId: string; agentType?: string; task?: Body; items: TurnItem[]; report?: Body }
export type TurnItem =
  | { kind: 'text'; id: string; at: string; text: Body; source: 'transcript' | 'hook' }
  | { kind: 'thinking'; id: string; at: string; text: Body; redacted?: boolean; durationMs?: number }
  | { kind: 'tool'; id: string; at: string; toolCallId: string; name: string; agentId?: string; input?: Body; output?: Body;
      status: 'ok' | 'error' | 'recorded' | 'pending'; resultBasis?: string; durationMs?: number; changes: Change[];
      subagent?: Subagent; native?: true }
  | Change
  | { kind: 'subagent'; id: string; at: string; subagent: Subagent };

/** Which of two results to show for a call. One that says how the call ended beats one that
 * does not; otherwise a hook result is preferred over one established from the transcript.
 */
export function betterResult(prior: LedgerRecord | undefined, next: LedgerRecord): boolean {
  if (!prior) return true;
  if (typeof prior.isError === 'boolean' !== (typeof next.isError === 'boolean')) return typeof next.isError === 'boolean';
  return !!prior.resultBasis || !next.resultBasis;
}

const turnTypes = ['input', 'source_record', 'message', 'tool_started', 'tool_finished', 'file_change', 'subagent_started', 'subagent_stopped', 'agent_settled'];

/** One request as a conversation turn: the prompt, then thinking, replies, tool calls
 * (input, output, file changes) and subagents in recorded order. Native transcript
 * lines are read through the harness adapter, so the shape is the same for every
 * harness. Only recorded links place an item; nothing is inferred.
 */
export function conversation(captures: SessionStore, request: TurnRequest) {
  const version = evidenceVersion(captures, request.readVersion);
  const ledger = captures.get(request.captureId);
  const harness = ledger.manifest.harness;
  const db = captures.database;
  const prompt = db.records('capture_id=? AND id=? AND type=? AND revision<=?', [request.captureId, request.requestId, 'input', version])[0];
  if (!prompt) throw new Error('Request not found at this readVersion');
  const reader = new EvidenceReader(captures);
  const issues: { id: string; reason: string }[] = [];
  const clip = (value: unknown, recordId: string): Body | undefined => {
    if (value === undefined || value === null || value === '') return undefined;
    const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    const limit = request.maxChars;
    return limit === undefined || text.length <= limit ? { text } : { text: text.slice(0, limit), truncated: true, totalChars: text.length, recordId };
  };
  const json = (record: LedgerRecord): any => {
    try { const raw = reader.read(record, 'data'); return raw === undefined ? undefined : JSON.parse(raw); }
    catch (error) { issues.push({ id: record.id, reason: String(error) }); return undefined; }
  };
  const types = turnTypes.map(() => '?').join(',');
  let records = db.records(`capture_id=? AND revision<=? AND request_id=? AND type IN (${types})`,
    [request.captureId, version, prompt.id, ...turnTypes]);
  // Subagents started during this turn bring their own records, wherever they are linked.
  const agents = new Set<string>();
  for (const record of records) {
    if (record.childAgentId) agents.add(record.childAgentId);
    if (record.agentId && !record.internalAgent) agents.add(record.agentId);
  }
  if (agents.size) {
    const ids = [...agents];
    const known = new Set(records.map(r => r.id));
    records = records.concat(db.records(`capture_id=? AND revision<=? AND type IN (${types}) AND json_extract(body,'$.agentId') IN (${ids.map(() => '?').join(',')})`,
      [request.captureId, version, ...turnTypes, ...ids]).filter(r => !known.has(r.id)));
  }
  // File changes link by call ID; a subagent's changes may sit under its own request.
  const callIds = [...new Set(records.filter(r => r.type === 'tool_started' && r.toolCallId).map(r => r.toolCallId!))];
  if (callIds.length) {
    const known = new Set(records.map(r => r.id));
    records = records.concat(db.records(`capture_id=? AND revision<=? AND type='file_change' AND tool_call_id IN (${callIds.map(() => '?').join(',')})`,
      [request.captureId, version, ...callIds]).filter(r => !known.has(r.id)));
  }
  records = records.filter(r => !r.internalAgent && r.id !== prompt.id);
  const at = (r: LedgerRecord) => r.sourceTimestamp ?? r.observedAt;
  records.sort((a, b) => at(a).localeCompare(at(b)) || a.seq - b.seq);

  const finishes = new Map<string, LedgerRecord>();
  for (const r of records) if (r.type === 'tool_finished' && r.toolCallId) {
    const prior = finishes.get(r.toolCallId);
    if (betterResult(prior, r)) finishes.set(r.toolCallId, r);
  }
  const nativeResults = new Map<string, unknown>();
  const nativeOutcomes = new Map<string, boolean>();
  const hookTools = new Set(records.filter(r => r.type === 'tool_started' && r.toolCallId).map(r => r.toolCallId!));
  const buckets = new Map<string, TurnItem[]>(); // '' is the main agent
  const bucket = (agentId?: string) => buckets.get(agentId ?? '') ?? buckets.set(agentId ?? '', []).get(agentId ?? '')!;
  const tools = new Map<string, Extract<TurnItem, { kind: 'tool' }>>();
  const reports = new Map<string, { body?: Body; agentType?: string; task?: Body }>();
  let settled: Body | undefined;

  const output = (finish: LedgerRecord | undefined): Body | undefined => {
    if (!finish) return undefined;
    if (finish.resultBasis) return clip(nativeResults.get(finish.toolCallId!), finish.id);
    const body = json(finish);
    return clip(cleanOutput(body?.response ?? body?.error ?? body), finish.id);
  };
  const status = (finish: LedgerRecord | undefined) => !finish ? 'pending' : finish.isError === true ? 'error' : finish.isError === false ? 'ok' : 'recorded';

  for (const record of records) {
    if (record.type === 'source_record' && record.role === 'toolResult' && record.toolCallId) {
      const message = nativeMessage(harness, reader.read(record, 'data') ?? 'null', record.toolCallId);
      nativeResults.set(record.toolCallId, cleanOutput(message?.content));
      if (typeof record.isError === 'boolean') nativeOutcomes.set(record.toolCallId, record.isError);
    }
  }
  for (const record of records) {
    if (record.type === 'tool_started' && record.toolCallId) {
      const finish = finishes.get(record.toolCallId);
      const data = json(record);
      const item = { kind: 'tool' as const, id: record.id, at: at(record), toolCallId: record.toolCallId, name: record.toolName ?? 'tool',
        agentId: record.agentId, input: clip(data?.input, record.id), output: output(finish), status: status(finish) as any,
        resultBasis: finish?.resultBasis, durationMs: finish ? json(finish)?.durationMs : undefined, changes: [] as Change[] };
      tools.set(record.toolCallId, item);
      bucket(record.agentId).push(item);
    } else if (record.type === 'file_change') {
      const change: Change = { kind: 'change', id: record.id, at: at(record), path: record.path, operation: record.operation,
        attribution: record.attribution, worktree: record.worktree, branch: record.branch, patchUnavailable: record.patchUnavailable };
      try { const patch = reader.read(record, 'patch'); if (patch) change.patch = clip(patch, record.id); }
      catch (error) { issues.push({ id: record.id, reason: String(error) }); }
      const owner = record.toolCallId ? tools.get(record.toolCallId) : undefined;
      if (owner) owner.changes.push(change); else bucket(record.agentId).push(change);
    } else if ((record.type === 'source_record' || record.type === 'message') && record.role === 'assistant') {
      const raw = reader.read(record, 'data');
      if (raw === undefined) continue;
      let message: any;
      try { message = record.type === 'source_record' ? nativeMessage(harness, raw, record.toolCallId) : JSON.parse(raw); }
      catch (error) { issues.push({ id: record.id, reason: String(error) }); continue; }
      const blocks = typeof message?.content === 'string' ? [{ type: 'text', text: message.content }] : Array.isArray(message?.content) ? message.content : [];
      blocks.forEach((block: any, index: number) => {
        const id = `${record.id}:${index}`;
        if (block?.type === 'text' && block.text?.trim()) bucket(record.agentId).push({ kind: 'text', id, at: at(record), text: clip(block.text, record.id)!, source: 'transcript' });
        else if (block?.type === 'thinking') bucket(record.agentId).push({ kind: 'thinking', id, at: at(record),
          text: clip(block.thinking ?? '', record.id) ?? { text: '' }, redacted: block.redacted, durationMs: block.durationMs });
        else if (block?.type === 'toolCall' && block.id && !hookTools.has(block.id)) {
          // A call only the transcript knows about (no hook fired for it).
          const item = { kind: 'tool' as const, id, at: at(record), toolCallId: block.id, name: block.name ?? 'tool', agentId: record.agentId,
            input: clip(block.arguments, record.id), output: clip(nativeResults.get(block.id), record.id),
            status: (nativeOutcomes.has(block.id) ? nativeOutcomes.get(block.id) ? 'error' : 'ok' : nativeResults.has(block.id) ? 'recorded' : 'pending') as any, changes: [] as Change[], native: true as const };
          tools.set(block.id, item); bucket(record.agentId).push(item);
        }
      });
    } else if (record.type === 'subagent_stopped' && record.agentId) {
      const data = json(record);
      reports.set(record.agentId, { ...reports.get(record.agentId), body: clip(data?.lastAssistantMessage, record.id), agentType: data?.agentType });
    } else if (record.type === 'subagent_started' && record.agentId) {
      const data = json(record);
      reports.set(record.agentId, { ...reports.get(record.agentId), agentType: data?.agentType });
    } else if (record.type === 'input' && record.agentId) {
      // A subagent's own prompt is its task.
      reports.set(record.agentId, { ...reports.get(record.agentId), task: clip(json(record)?.text, record.id) });
    } else if (record.type === 'agent_settled' && !record.agentId) {
      settled = clip(json(record)?.lastAssistantMessage, record.id) ?? settled;
    }
  }

  // The final reply as the harness reported it, when no transcript text exists (no native file).
  const main = bucket();
  if (settled && !main.some(item => item.kind === 'text')) main.push({ kind: 'text', id: `${prompt.id}:settled`, at: main.at(-1)?.at ?? at(prompt), text: settled, source: 'hook' });
  // Nest each subagent under the call that started it; without a recorded link it stands alone.
  for (const [agentId, items] of buckets) {
    if (!agentId) continue;
    const report = reports.get(agentId);
    const subagent: Subagent = { agentId, agentType: report?.agentType, task: report?.task, items, report: report?.body };
    const spawn = [...tools.values()].find(tool => finishes.get(tool.toolCallId)?.childAgentId === agentId);
    if (spawn) spawn.subagent = subagent;
    else main.push({ kind: 'subagent', id: `agent:${agentId}`, at: items[0]?.at ?? at(prompt), subagent });
  }
  main.sort((a, b) => a.at.localeCompare(b.at));

  // Tokens of this turn: once per model response, resumed history excluded.
  const tokens = { calls: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, total: 0, costUsd: null as number | null, costEstimated: undefined as true | undefined };
  const seen = new Set<string>();
  const usageAgents = [...agents];
  const usage = db.records(`capture_id=? AND revision<=? AND type='usage' AND (request_id=?${usageAgents.length ? ` OR json_extract(body,'$.agentId') IN (${usageAgents.map(() => '?').join(',')})` : ''})`,
    [request.captureId, version, prompt.id, ...usageAgents], 'ORDER BY seq');
  for (const record of usage) {
    if (record.usageScope !== 'call' || record.beforeCapture || !record.usage) continue;
    const key = `${record.agentId ?? ''}:${record.usageKey}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const u = record.usage;
    tokens.calls++; tokens.input += u.input; tokens.cacheRead += u.cacheRead; tokens.cacheWrite += u.cacheWrite;
    tokens.output += u.output; tokens.reasoning += u.reasoning ?? 0; tokens.total += u.input + u.cacheRead + u.cacheWrite + u.output;
    // A harness that reports no cost (Codex) gets an estimate from its tokens, marked as one.
    const estimate = typeof u.costUsd === 'number' ? undefined : estimateCost(record.model, u);
    if (typeof u.costUsd === 'number') tokens.costUsd = (tokens.costUsd ?? 0) + u.costUsd;
    else if (estimate !== undefined) { tokens.costUsd = (tokens.costUsd ?? 0) + estimate; tokens.costEstimated = true; }
  }

  const promptData = json(prompt);
  return { readVersion: version, captureId: request.captureId, harness,
    request: { id: prompt.id, at: at(prompt), text: clip(promptData?.text ?? '', prompt.id) ?? { text: '' }, images: promptData?.images?.length || undefined },
    items: main, tokens, issues,
    notes: ['Recorded evidence in recorded order. Thinking marked redacted happened, but its text was not recorded (omitted by the harness or encrypted by the provider).'] };
}
