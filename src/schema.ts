import { z } from 'zod';
import { harnessNames } from './harnesses/index.js';

/** The agent-facing ledger: two moves over one session (glance, open) and a way to
 * continue a limited response. Positions are the address: t3, t2/c4, a1, a1/c2, outside.
 */
export const ledgerSchema = z.object({
  capture: z.string().min(1).optional().describe('A capture ID, a unique prefix of one (8+ characters), or "latest". Omit with glance to list sessions.'),
  glance: z.literal(true).optional().describe('The shape of a session and one entry per turn. Without capture: the recorded sessions, newest first.'),
  open: z.string().min(1).optional().describe('A position from a glance: t3 (a turn), t3/c2 (one tool call), a1 (a subagent), a1/c2, or outside (changes outside any turn).'),
  from: z.number().int().min(1).optional().describe('Continue a limited response from this line, as its last line says.'),
  at: z.number().int().nonnegative().optional().describe('Read version to pin. Every response states its version; pass it back to read the same snapshot.'),
}).strict();
export type LedgerRequest = z.infer<typeof ledgerSchema>;

/** The dashboard's data, served by the daemon. Agents use the ledger above. */
export const viewSchema = z.discriminatedUnion('view', [
  z.object({ view: z.literal('projects') }).strict(),
  z.object({ view: z.literal('project'), workspaceRoot: z.string().min(1) }).strict(),
  z.object({ view: z.literal('capture'), captureId: z.string().min(1) }).strict(),
  z.object({ view: z.literal('turn'), captureId: z.string().min(1), requestId: z.string().min(1), readVersion: z.number().int().nonnegative().optional() }).strict(),
  z.object({ view: z.literal('record'), captureId: z.string().min(1), id: z.string().min(1), readVersion: z.number().int().nonnegative() }).strict(),
  z.object({ view: z.literal('native-result'), captureId: z.string().min(1), toolCallId: z.string().min(1), readVersion: z.number().int().nonnegative() }).strict(),
]);
export type ViewRequest = z.infer<typeof viewSchema>;

export const observationSchema = z.object({
  observationId: z.string().min(1),
  type: z.enum(['tool_started', 'tool_finished', 'input', 'message', 'agent_settled', 'session_tree', 'session_compact', 'gap',
    'session_started', 'session_ended', 'subagent_started', 'subagent_stopped', 'harness_event']),
  turnId: z.string().optional(),
  sessionId: z.string().optional(),
  source: z.string().nullable().optional(),
  toolCallId: z.string().optional(),
  parentToolCallId: z.string().optional(),
  toolName: z.string().optional(),
  agentId: z.string().optional(),
  /** Subagent started by this call (Codex spawn_agent, Claude Code Agent). */
  childAgentId: z.string().optional(),
  sourceEntryId: z.string().optional(),
  isError: z.boolean().optional(),
  data: z.unknown().optional(),
  /** The exact hook JSON, stored as its own harness_event record in the same request. */
  harnessEvent: z.unknown().optional(),
}).strict();
export type Observation = z.infer<typeof observationSchema>;

/** What every hook or extension sends: the session it names picks the record, so no
 * launcher is needed. `cwd` is where the harness runs; `late` marks an event kept in the
 * spool while the daemon was down, delivered after it came back.
 */
export const hookSchema = z.object({
  harness: z.enum(harnessNames),
  harnessVersion: z.string().optional(),
  cwd: z.string().min(1),
  late: z.object({ spooledAt: z.string() }).strict().optional(),
  observation: observationSchema.extend({ sessionId: z.string().min(1) }),
}).strict();
export type HookEvent = z.infer<typeof hookSchema>;

export interface Manifest {
  schemaVersion: 1;
  captureId: string;
  harness: string;
  harnessVersion?: string;
  sessionId: string;
  workspaceRoot: string;
  source: string | null;
  startedAt: string;
  endedAt?: string;
  status: 'recording' | 'closed' | 'interrupted' | 'degraded';
  endReason?: string;
  /** Where the native file is read, minus where the copy is written. Non-zero once the
   * harness rewrote its file: copying went on from the file's new end. */
  sourceShift?: number;
  scope: { excludedDirectories: string[]; excludedPaths: string[]; maxFileBytes: number; maxFiles: number; maxTotalBytes: number };
}

export interface LedgerRecord {
  schemaVersion: 1;
  id: string;
  captureId: string;
  seq: number;
  observedAt: string;
  type: string;
  turnId?: string;
  parentId?: string;
  requestId?: string;
  linkBasis?: 'recorded-parent' | 'recorded-turn' | 'observed-input-window';
  toolCallId?: string;
  parentToolCallId?: string;
  toolName?: string;
  agentId?: string;
  childAgentId?: string;
  /** How a tool_finished was established when its result hook never arrived. */
  resultBasis?: 'native-transcript';
  /** usage records: neutral token counts and harness-reported cost (see harnesses/types.ts). */
  usage?: { input: number; cacheRead: number; cacheWrite: number; output: number; reasoning?: number; costUsd?: number };
  usageKey?: string;
  usageScope?: 'call' | 'session-total';
  model?: string;
  provider?: string;
  /** Native history from before this capture started (a resumed session); not this capture's work. */
  beforeCapture?: boolean;
  /** A harness's own helper agent (Claude Code prompt suggestions, recaps): no task, no transcript. */
  internalAgent?: boolean;
  /** An input read from the harness's session file because no hook reported it. */
  inputBasis?: 'session-file';
  /** Kept in the spool while the daemon was down; recorded when it came back. */
  spooledAt?: string;
  sourceEntryId?: string;
  sourceParentId?: string | null;
  sourceTimestamp?: string;
  observationId?: string;
  isError?: boolean;
  role?: string;
  path?: string;
  operation?: 'create' | 'modify' | 'delete';
  attribution?: 'observed-during-tool' | 'external-or-unknown';
  activeToolCallIds?: string[];
  beforeHash?: string | null;
  afterHash?: string | null;
  summary: string;
  dataRef?: string;
  patchRef?: string;
  patchUnavailable?: string;
  sourceOffset?: number;
  sourceLength?: number;
}

// Human-readable summaries are navigation hints, never replacements for evidence.
export function preview(value: unknown, limit = 240): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value) ?? '';
  return text.replace(/\s+/g, ' ').slice(0, limit);
}
