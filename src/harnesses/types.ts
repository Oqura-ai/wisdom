/** The only shape the Wisdom core accepts from a harness. A harness update can
 * break its own adapter, but never the ledger, queries or another adapter.
 */
export interface NeutralMessage {
  role: string;
  /** A string, or blocks: text, image, toolCall {id, name, arguments}, and thinking
   * {thinking, redacted?, durationMs?}. `redacted` means the harness recorded that
   * thinking happened but not its text (omitted or provider-encrypted). Surface views
   * never show thinking; the conversation view shows it explicitly.
   */
  content: unknown;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
}

/** Token usage in one shape for every harness. All token fields are additive:
 * total = input + cacheRead + cacheWrite + output. `reasoning` is already part of
 * `output`. Cost is only what the harness itself reported; nothing is estimated.
 */
export interface NeutralUsage {
  /** De-duplication key within one transcript (one model response). */
  key: string;
  /** 'call': one model response. 'session-total': the harness's running cost total; the latest wins. */
  scope: 'call' | 'session-total';
  model?: string;
  provider?: string;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  reasoning?: number;
  costUsd?: number;
}

export interface NativeEntry {
  id?: string;
  turnId?: string;
  parentId?: string | null;
  timestamp?: string;
  /** The harness's own entry kind, kept for summaries of non-message records. */
  kind: string;
  messages: NeutralMessage[];
  usage?: NeutralUsage[];
  /** Model now in effect, for formats that state it once per turn (Codex). */
  model?: string;
}

export const count = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;

export interface HarnessAdapter {
  name: string;
  /** File named by a direct file tool's input, if any. */
  toolTarget(toolName: string, input: any): string | undefined;
  /** Tools that touch nothing but their named target. Others need a workspace reconcile. */
  isDirectFileTool(toolName: string): boolean;
  /** How the ledger shows this tool's calls without repeating evidence held elsewhere.
   * 'patch': the input is the file change itself, shown once, as its patch.
   * 'file': a successful output is file content; listed by size, read by opening the call.
   * 'full': input and output are shown whole. Unknown tools must be 'full'.
   */
  toolView(toolName: string): 'patch' | 'file' | 'full';
  /** Read one native transcript line. Unknown entry kinds must not throw. */
  nativeEntry(entry: any): NativeEntry;
}
