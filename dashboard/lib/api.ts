/** Browser-side access to the daemon's dashboard views, through this dashboard's own /api/view proxy. */
export async function view<T = any>(request: unknown): Promise<T> {
  const response = await fetch('/api/view', { method: 'POST', cache: 'no-store',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? `HTTP ${response.status}`);
  return result;
}

/** What deleting one session would do. `harnessCopy`: a connected session's own files in the
 * person's harness home, deleted only when asked. `outside`: files that stay whatever is chosen. */
export interface RemovalPlan { session: string; harness: string; status: string; recording: boolean; files: string[]; harnessCopy: string[];
  outside: string[]; bytes: number; harnessCopyBytes: number; linked: { session: string; harness: string; kind: SessionLink['kind'] }[];
  /** Its lines in a harness's shared prompt history; `harnessCopy` ones go only with the harness's own copy. */
  history: { file: string; lines: number; harnessCopy: boolean }[] }
/** One session's outcome: `error` when it was refused, otherwise what was removed and kept. */
export interface DeleteResult { session: string; removed?: string[]; kept?: string[]; error?: string }

async function change<T>(route: string, body: unknown): Promise<T> {
  const response = await fetch(route, { method: 'POST', cache: 'no-store',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? `HTTP ${response.status}`);
  return result;
}

/** What deleting these sessions would do; nothing is deleted. A session the daemon cannot find comes back with `error`. */
export const previewDelete = (sessions: string[]) => change<{ results: (RemovalPlan | { session: string; error: string })[] }>('/api/delete', { sessions, preview: true });
export const deleteSessions = (sessions: string[], harnessCopy: boolean) => change<{ results: DeleteResult[] }>('/api/delete', { sessions, harnessCopy });

async function get<T>(route: string): Promise<T> {
  const response = await fetch(route, { cache: 'no-store' });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? `HTTP ${response.status}`);
  return result;
}

/** Where this project's disk space goes. */
export interface Storage { total: number; database: number; sessions: { session: string; harness: string; bytes: number }[]; homes: { harness: string; bytes: number }[]; other: number }
export const storage = () => get<Storage>('/api/storage');

/** One of `wisdom doctor`'s checks, with the command that fixes it. */
export interface Check { level: 'ok' | 'note' | 'problem'; name: string; detail: string; fix?: string }
export interface Health { version?: string; checks?: Check[]; error?: string; checkedAt: string }
export const health = (fresh = false) => get<Health>(`/api/health${fresh ? '?fresh=1' : ''}`);

/** A harness whose Wisdom setup repair would rewrite: `hooks` record nothing now; `skill` is missing or older. */
export interface RepairTarget { harness: string; place: 'home' | 'project'; problem: 'hooks' | 'skill'; files: string[] }
export interface Backup { id: string; createdAt: string; targets: RepairTarget[]; items: { original: string; saved: string | null }[] }
export const repairPlan = () => change<{ targets: RepairTarget[]; backups: Backup[] }>('/api/repair', { action: 'plan' });
export const runRepair = () => change<{ backup: Backup; codexReview: boolean }>('/api/repair', { action: 'repair' });
export const restoreBackup = (backup: string) => change<{ restored: Backup }>('/api/repair', { action: 'restore', backup });

export interface Project { workspaceRoot: string; captures: number; harnesses: string[]; lastStartedAt: string; recording: number }
/** Additive token buckets: total = input + cacheRead + cacheWrite + output; reasoning is part of output. */
export interface Tokens { calls: number; input: number; cacheRead: number; cacheWrite: number; output: number; reasoning: number; total: number; costUsd: number | null; costBehind?: boolean; costEstimated?: boolean }
export interface HarnessTotals { harness: string; captures: number; recording: number; requests: number; replies: number; tools: number;
  failures: number; changes: number; gaps: number; subagents: number; tokens: Tokens }
/** A handoff between two sessions, seen from this one. No `session` when a person deleted the other one. */
export interface SessionLink { kind: 'continues' | 'continued-after' | 'continued-by' | 'cloned' | 'cloned-by'; session?: string; deleted?: boolean; harness?: string; turns?: number }
/** Where a shared copy came from. A shared session is read-only, so it has no resume command. */
export interface SharedInfo { shareId: string; project: string; sharedAt: string; importedAt: string; redactions: number; patchesEdited: string[] }
export interface Session { captureId: string; harness: string; harnessVersion?: string; status: string; resume?: { powershell: string; posix: string }; shared?: SharedInfo;
  endReason?: string; startedAt: string; endedAt?: string; lastObservedAt: string; requests: number; replies: number; tools: number;
  failures: number; changes: number; gaps: number; subagents: number; tokens: Tokens; links: SessionLink[]; evidenceMissing?: boolean }
export interface ProjectStats { readVersion: number; workspaceRoot: string; harnesses: HarnessTotals[]; sessions: Session[];
  toolUsage: { harness: string; toolName: string; calls: number; failures: number }[];
  files: { path: string; worktree?: string; changes: number; captures: number; lastChangedAt: string }[];
  models: (Tokens & { harness: string; model: string })[] }

export interface EventRecord {
  id: string; seq: number; observedAt: string; type: string; summary?: string; parentId?: string; requestId?: string;
  toolCallId?: string; toolName?: string; isError?: boolean; agentId?: string; childAgentId?: string; resultBasis?: string;
  path?: string; worktree?: string; branch?: string; notice?: boolean; operation?: string; attribution?: string; status?: string; role?: string; sourceTimestamp?: string;
  internalAgent?: boolean; model?: string; usageKey?: string; usageScope?: string; beforeCapture?: boolean; estimatedCostUsd?: number;
  usage?: { input: number; cacheRead: number; cacheWrite: number; output: number; reasoning?: number; costUsd?: number };
}

/** One capture at one read version: its structure, the assistant's replies, and token
 * usage, read by the daemon in one snapshot.
 */
export async function captureEvents(captureId: string): Promise<{ readVersion: number; events: EventRecord[]; usage: EventRecord[] }> {
  return view({ view: 'capture', captureId });
}

/** The prompt a session opened with: its first own request, not a subagent's task or a notice. */
export async function firstPrompt(captureId: string): Promise<string | undefined> {
  const { events } = await captureEvents(captureId);
  return events.filter(e => e.type === 'input' && !e.agentId && !e.notice).sort((a, b) => a.seq - b.seq)[0]?.summary;
}

/** A tool's result body. A result taken from the harness transcript has no hook body,
 * so read the native transcript record with the same call ID instead.
 */
export async function resultBody(captureId: string, result: EventRecord, readVersion: number): Promise<any> {
  if (!result.resultBasis || !result.toolCallId) return (await recordBodies(captureId, result.id, readVersion))?.content;
  const native = await view({ view: 'native-result', captureId, toolCallId: result.toolCallId, readVersion });
  const body = native.content;
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
  return view({ view: 'record', captureId, id, readVersion });
}
