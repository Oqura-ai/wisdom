import { z } from 'zod';
import { harnessNames } from './harnesses/index.js';

const limit = z.number().int().min(1).max(100).default(20);
const readVersion = z.number().int().nonnegative().optional();
const maxChars = z.number().int().min(100).max(32000).default(8000);

// Each operation has its own strict contract. Reject unrelated options here,
// before reaching selection, discovery or body inspection.
export const selectionSchema = z.object({
  clean: z.boolean().optional().describe('Return only ordered user, assistant, and tool/input/output objects for conversation queries. No metadata or summarization. Oversized results error instead of truncating.'),
  op: z.literal('query').optional(),
  preset: z.enum(['intent', 'timeline', 'changes', 'failures', 'file-history', 'interaction-review']).optional(),
  find: z.enum(['requests', 'messages', 'tools', 'outputs', 'changes', 'events']).optional(),
  scope: z.object({
    captureIds: z.array(z.string()).min(1).max(100).optional(),
    sessionIds: z.array(z.string()).min(1).max(100).optional(),
    workspaceRoot: z.string().optional(),
  }).strict().optional(),
  where: z.record(z.unknown()).optional(),
  select: z.array(z.string()).max(30).optional(),
  // A bounded tree is validated by the query engine against the vocabulary.
  include: z.record(z.unknown()).optional(),
  readVersion,
  captureId: z.string().optional(),
  limit,
  cursor: z.string().optional(),
  maxChars
}).strict();
export type Query = z.infer<typeof selectionSchema>;

export const inspectSchema = z.object({
  op: z.literal('inspect'), captureId: z.string().min(1), id: z.string().min(1),
  sections: z.array(z.enum(['data', 'patch'])).min(1).max(2).default(['data']),
  contentOffset: z.number().int().nonnegative().default(0), maxChars, readVersion,
}).strict();
export type InspectQuery = z.infer<typeof inspectSchema>;
const sessionsSchema = z.object({ op: z.literal('sessions'), limit, cursor: z.string().optional() }).strict();
const describeSchema = z.object({ op: z.literal('describe') }).strict();
/** Aggregate counts: without workspaceRoot, the tracked projects; with it, per harness and capture. */
const statsSchema = z.object({ op: z.literal('stats'), workspaceRoot: z.string().optional() }).strict();
export type StatsQuery = z.infer<typeof statsSchema>;
export const querySchema = z.union([sessionsSchema, describeSchema, statsSchema, inspectSchema, selectionSchema]);
export type QueryRequest = z.infer<typeof querySchema>;

// MCP's registration API takes an object shape. This advertises the fields;
// the strict union above validates the selected operation inside the service.
export const mcpQuerySchema = z.object({
  ...selectionSchema.partial().shape, ...inspectSchema.partial().shape,
  op: z.enum(['query', 'sessions', 'describe', 'inspect', 'stats']).optional(),
  workspaceRoot: z.string().optional().describe('op=stats only: aggregate one project instead of listing projects.'),
}).strict();

export const openSchema = z.object({
  harness: z.enum(harnessNames),
  sessionId: z.string().min(1),
  harnessVersion: z.string().optional(),
  workspaceRoot: z.string().min(1),
  source: z.string().nullable(),
}).strict();

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

export interface Manifest {
  schemaVersion: 1;
  captureId: string;
  /** Absent only on captures recorded before harness tagging, which were Pi. */
  harness?: string;
  harnessVersion?: string;
  sessionId: string;
  /** Legacy name of sessionId; read once when loading old captures. */
  piSessionId?: string;
  workspaceRoot: string;
  source: string | null;
  startedAt: string;
  endedAt?: string;
  status: 'recording' | 'closed' | 'interrupted' | 'degraded';
  /** Token usage has been indexed (live while mirroring, or once from the mirror). */
  usageIndexed?: boolean;
  endReason?: string;
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
