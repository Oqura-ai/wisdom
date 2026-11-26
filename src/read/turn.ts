/** The shapes of one assembled turn (conversation.ts), with no imports: shared by the Usage
 * dashboard's reads and the Commits contract, which the browser app imports. */

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
