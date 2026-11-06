import path from 'node:path';
import { contentText, count, jsonlFiles, type HarnessAdapter, type NeutralMessage, type NeutralUsage } from '../types.js';

// Claude Code calls this format internal, so this reader is best-effort; hooks
// remain the primary evidence. Verified against Claude Code 2.1.306.
const direct = new Set(['Read', 'Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'TodoWrite', 'ToolSearch']);

function messages(entry: any): NeutralMessage[] {
  const message = entry?.message;
  if (!message || (entry.type !== 'user' && entry.type !== 'assistant')) return [];
  if (!Array.isArray(message.content)) return [{ role: message.role ?? entry.type, content: message.content ?? null }];
  if (entry.type === 'assistant') {
    return [{ role: 'assistant', content: message.content.map((block: any) => block?.type === 'tool_use'
      ? { type: 'toolCall', id: block.id, name: block.name, arguments: block.input }
      // Claude Code keeps a signature and duration but may omit the text (thinkingDisplay).
      : block?.type === 'thinking' ? { type: 'thinking', thinking: block.thinking ?? '', redacted: !block.thinking || undefined,
        durationMs: typeof entry.thinkingDurationMs === 'number' ? entry.thinkingDurationMs : undefined }
      : block?.type === 'redacted_thinking' ? { type: 'thinking', thinking: '', redacted: true }
      : block) }];
  }
  // A user entry carries tool results, possibly several, beside any typed text.
  const results = message.content.filter((block: any) => block?.type === 'tool_result');
  const rest = message.content.filter((block: any) => block?.type !== 'tool_result');
  return [...results.map((block: any): NeutralMessage => ({ role: 'toolResult', toolCallId: block.tool_use_id,
    content: block.content ?? null, isError: block.is_error === true })),
    ...(rest.length ? [{ role: 'user', content: rest }] : [])];
}

/** One API response is written as several entries (one per content block), each
 * repeating the same usage, so the key is the response's message.id. input_tokens
 * excludes cache tokens. cost-state is Claude Code's own running session cost.
 */
function usage(entry: any): NeutralUsage[] {
  const raw = entry?.message?.usage;
  if (entry?.type === 'assistant' && raw && typeof entry.message.id === 'string') {
    return [{ key: entry.message.id, scope: 'call', model: entry.message.model, provider: 'anthropic',
      input: count(raw.input_tokens), cacheRead: count(raw.cache_read_input_tokens), cacheWrite: count(raw.cache_creation_input_tokens),
      output: count(raw.output_tokens), reasoning: count(raw.output_tokens_details?.thinking_tokens) }];
  }
  if (entry?.type === 'cost-state' && typeof entry.totalCostUSD === 'number') {
    return [{ key: 'cost-state', scope: 'session-total', input: 0, cacheRead: 0, cacheWrite: 0, output: 0, costUsd: entry.totalCostUSD }];
  }
  return [];
}

export const claudeCode: HarnessAdapter = {
  name: 'claude-code',
  homeEnv: 'CLAUDE_CONFIG_DIR',
  resume: sessionId => ['claude', '--resume', sessionId],
  toolTarget: (_toolName, input) => typeof input?.file_path === 'string' ? input.file_path
    : typeof input?.notebook_path === 'string' ? input.notebook_path : undefined,
  isDirectFileTool: toolName => direct.has(toolName),
  toolView: toolName => ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(toolName) ? 'patch' : toolName === 'Read' ? 'file' : 'full',
  nativeSession: entry => typeof entry?.sessionId === 'string' ? entry.sessionId : undefined,
  nativeCwd: entry => typeof entry?.cwd === 'string' ? entry.cwd : undefined,
  // Every line names its session and folder.
  cloneLine: (entry, { sessionId, move }) => !entry || typeof entry !== 'object' ? entry
    : { ...entry, ...(typeof entry.sessionId === 'string' ? { sessionId } : {}), ...(typeof entry.cwd === 'string' ? { cwd: move(entry.cwd) } : {}) },
  // projects/<the folder, every character not a letter or digit as ->/<session>.jsonl
  sessionFile: (home, sessionId, cwd) => path.join(home, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${sessionId}.jsonl`),
  nativeVersion: entry => typeof entry?.version === 'string' ? entry.version : undefined,
  nativeChanges: () => [],
  isScriptStep: () => false,
  nativeForkedFrom: entry => typeof entry?.forkedFrom?.sessionId === 'string' ? entry.forkedFrom.sessionId : undefined,
  // A finished background command wakes the agent with this, through the prompt hook.
  isNotice: text => /^\s*<task-notification>/.test(text),
  // What starts a turn under hooks: not a tool result, a meta line, a compaction summary, a
  // slash command's own lines, or a line written only to the transcript (a fork's first notice).
  nativePrompt: entry => {
    if (entry?.type !== 'user' || entry.isMeta || entry.isCompactSummary || entry.queueTranscriptOnly || entry.toolUseResult !== undefined) return undefined;
    const text = contentText(entry.message?.content)?.trim();
    return text && !/^<(?:command-|local-command-)/.test(text) ? text : undefined;
  },
  // projects/<folder>/<session>.jsonl; subagent files sit one folder deeper.
  sessionFiles: home => jsonlFiles(path.join(home, 'projects'), 1),
  nativeEntry: entry => ({ id: entry?.uuid, parentId: entry?.parentUuid, timestamp: entry?.timestamp,
    kind: String(entry?.type ?? 'unknown'), messages: messages(entry), usage: usage(entry) }),
};
