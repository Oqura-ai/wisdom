import fs from 'node:fs';
import path from 'node:path';
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
  /** The variable that sets the harness's home. */
  homeEnv: string;
  /** The harness's own command to continue a session by its ID. */
  resume(sessionId: string): string[];
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
  /** The session a native line says it belongs to, when the line says so. A subagent's
   * or helper's own file names no session, so it is never taken for one. */
  nativeSession(entry: any): string | undefined;
  /** The folder the harness ran in, when a native line says so. */
  nativeCwd(entry: any): string | undefined;
  /** The harness's own version, when a native line states it. */
  nativeVersion(entry: any): string | undefined;
  /** The session this native line says it was copied from, when it says so. */
  nativeForkedFrom(entry: any): string | undefined;
  /** Whether prompt text is a notice the harness wrote itself rather than a person's words. */
  isNotice(text: string): boolean;
  /** The text a person typed, when this native line is their prompt. Read only for
   * sessions found in their file, which had no prompt hook. */
  nativePrompt(entry: any): string | undefined;
  /** Candidate session files in the harness's home (inside Wisdom's data folder). */
  sessionFiles(home: string): string[];
}

/** `.jsonl` files `depth` folders below `dir` (0: in it), in name order. */
export function jsonlFiles(dir: string, depth: number): string[] {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  return entries.sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
    const full = path.join(dir, entry.name);
    if (depth > 0) return entry.isDirectory() ? jsonlFiles(full, depth - 1) : [];
    return entry.isFile() && entry.name.endsWith('.jsonl') ? [full] : [];
  });
}

/** Text blocks of a message's content, joined; undefined when there are none. */
export function contentText(content: unknown): string | undefined {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return undefined;
  const parts = content.filter((block: any) => ['text', 'input_text'].includes(block?.type) && typeof block.text === 'string')
    .map((block: any) => block.text as string);
  return parts.length ? parts.join('\n') : undefined;
}
