/** Browser-side access to the ledger, through this dashboard's own /api/query proxy. */
export async function ledger<T = any>(request: unknown): Promise<T> {
  const response = await fetch('/api/query', { method: 'POST', cache: 'no-store',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? `HTTP ${response.status}`);
  return result;
}

export interface Project { workspaceRoot: string; captures: number; harnesses: string[]; lastStartedAt: string; recording: number }
/** Additive token buckets: total = input + cacheRead + cacheWrite + output; reasoning is part of output. */
export interface Tokens { calls: number; input: number; cacheRead: number; cacheWrite: number; output: number; reasoning: number; total: number; costUsd: number | null }
export interface HarnessTotals { harness: string; captures: number; recording: number; requests: number; replies: number; tools: number;
  failures: number; changes: number; gaps: number; subagents: number; tokens: Tokens }
export interface Session { captureId: string; sessionId: string; harness: string; harnessVersion?: string; status: string;
  endReason?: string; startedAt: string; endedAt?: string; lastObservedAt: string; requests: number; replies: number; tools: number;
  failures: number; changes: number; gaps: number; subagents: number; tokens: Tokens; evidenceMissing?: boolean }
export interface ProjectStats { readVersion: number; workspaceRoot: string; harnesses: HarnessTotals[]; sessions: Session[];
  toolUsage: { harness: string; toolName: string; calls: number; failures: number }[];
  files: { path: string; changes: number; captures: number; lastChangedAt: string }[];
  models: (Tokens & { harness: string; model: string })[] }

export interface EventRecord {
  id: string; seq: number; observedAt: string; type: string; summary?: string; parentId?: string; requestId?: string;
  toolCallId?: string; toolName?: string; isError?: boolean; agentId?: string; childAgentId?: string; resultBasis?: string;
  path?: string; operation?: string; attribution?: string; status?: string; role?: string; sourceTimestamp?: string;
  internalAgent?: boolean; model?: string; usageKey?: string; usageScope?: string; beforeCapture?: boolean;
  usage?: { input: number; cacheRead: number; cacheWrite: number; output: number; reasoning?: number; costUsd?: number };
}

const treeTypes = ['input', 'tool_started', 'tool_finished', 'file_change', 'gap', 'subagent_started', 'subagent_stopped',
  'session_compact', 'capture_started', 'capture_closed'];
const treeFields = ['seq', 'observedAt', 'type', 'summary', 'parentId', 'requestId', 'toolCallId', 'toolName', 'isError',
  'agentId', 'childAgentId', 'resultBasis', 'path', 'operation', 'attribution', 'status', 'role', 'sourceTimestamp', 'internalAgent'];

async function allPages(base: Record<string, unknown>, readVersion?: number): Promise<{ readVersion: number; items: EventRecord[] }> {
  let page: any = await ledger({ ...base, ...(readVersion === undefined ? {} : { readVersion }) });
  const version = page.readVersion;
  const items: EventRecord[] = [...page.items];
  for (let pages = 1; page.nextCursor && pages < 50; pages++) {
    page = await ledger({ ...base, readVersion: version, cursor: page.nextCursor });
    items.push(...page.items);
  }
  return { readVersion: version, items };
}

/** One capture at one read version: its structure, the assistant's replies, and token
 * usage. Later queries reuse the first readVersion, so all three are one snapshot.
 */
export async function captureEvents(captureId: string): Promise<{ readVersion: number; events: EventRecord[]; usage: EventRecord[] }> {
  const structure = await allPages({ find: 'events', captureId, where: { type: { in: treeTypes } }, select: treeFields, limit: 100 });
  const replies = await allPages({ find: 'messages', captureId, where: { role: 'assistant' }, select: treeFields, limit: 100 }, structure.readVersion);
  const usage = await allPages({ find: 'events', captureId, where: { type: 'usage' }, limit: 100,
    select: ['seq', 'requestId', 'agentId', 'usage', 'usageKey', 'usageScope', 'beforeCapture', 'model'] }, structure.readVersion);
  // A reply without text is a tool-call-only turn; the tool rows already show it.
  const events = [...structure.items, ...replies.items.filter(r => r.summary)].sort((a, b) => a.seq - b.seq);
  return { readVersion: structure.readVersion, events, usage: usage.items };
}

/** A tool's result body. A result taken from the harness transcript has no hook body,
 * so read the native transcript record with the same call ID instead.
 */
export async function resultBody(captureId: string, result: EventRecord, readVersion: number): Promise<any> {
  if (!result.resultBasis || !result.toolCallId) return (await recordBodies(captureId, result.id, readVersion))?.content;
  const native = await ledger({ find: 'events', captureId, readVersion, where: { type: 'source_record', role: 'toolResult', toolCallId: result.toolCallId },
    select: ['content'], maxChars: 16000, limit: 1 });
  const body = native.items[0]?.content;
  // Show the tool's output, not the whole native line; keep the raw line if its shape is unknown.
  if (!body?.available || body.truncated) return body;
  try {
    const line = JSON.parse(body.text);
    const output = line?.payload?.output ?? line?.message?.content;
    if (output !== undefined) return { ...body, text: typeof output === 'string' ? output : JSON.stringify(output, null, 2) };
  } catch { /* not JSON */ }
  return body;
}

/** One record's evidence bodies: request text, tool input/result, or patch. */
export async function recordBodies(captureId: string, id: string, readVersion: number): Promise<any> {
  const result = await ledger({ find: 'events', captureId, readVersion, where: { id }, select: ['type', 'content', 'data', 'patch'], maxChars: 16000 });
  return result.items[0];
}
