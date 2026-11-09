import path from 'node:path';
import { contentText, count, jsonlFiles, type HarnessAdapter, type NeutralMessage, type NeutralUsage } from '../types.js';

/** Codex's command envelope ("Exit code: 1\nWall time: ..."). Verified in 0.147.0 rollouts,
 * where a failed command sent no PostToolUse; on 0.164.0 hooks still use it for apply_patch.
 * Arbitrary tool-output prose is not interpreted.
 */
export function exitEnvelope(text: unknown): boolean | undefined {
  const match = typeof text === 'string'
    ? /(?:^|\n)(?:Process exited with code |Exit code: )(-?\d+)\r?(?:\n|$)/.exec(text) : null;
  return match ? Number(match[1]) !== 0 : undefined;
}

/** What actually ran, on 0.164.0: the model's `exec` script calls tools inside it, and each
 * ends as an item whose ID is the hook's tool_use_id. An unknown status stays unknown.
 */
function itemFailed(item: any): boolean | undefined {
  if (typeof item.exit_code === 'number' && item.exit_code !== 0) return true;
  return item.status === 'failed' ? true : item.status === 'completed' ? false : undefined;
}

function itemMessages(item: any): NeutralMessage[] {
  if (!item?.id || !['CommandExecution', 'FileChange'].includes(item.type)) return [];
  const command = item.type === 'CommandExecution';
  const input = command ? { command: item.parsed_cmd?.[0]?.cmd ?? item.command } : { files: Object.keys(item.changes ?? {}) };
  return [
    // A session read from its file has no hook, so this is the only record of the call.
    { role: 'assistant', content: [{ type: 'toolCall', id: item.id, name: command ? 'Bash' : 'apply_patch', arguments: input }] },
    { role: 'toolResult', toolCallId: item.id, isError: itemFailed(item),
      content: command ? item.aggregated_output ?? '' : [item.stdout, item.stderr].filter(Boolean).join('\n') },
  ];
}

/** Rollouts are an internal format. Keep unknown records as raw evidence and
 * normalize only recognized response items; other event_msg lines repeat their content.
 */
function messages(entry: any): NeutralMessage[] {
  const item = entry?.payload;
  if (entry?.type === 'event_msg' && item?.type === 'item_completed') return itemMessages(item.item);
  if (entry?.type !== 'response_item' || !item) return [];
  if (item.type === 'message') return [{ role: item.role, content: Array.isArray(item.content)
    ? item.content.map((block: any) => ['input_text', 'output_text'].includes(block?.type)
      ? { type: 'text', text: block.text } : block) : item.content }];
  // Reasoning is encrypted by the provider; its summary is only present when reasoning
  // summaries are enabled. Record that it happened without inventing text.
  if (item.type === 'reasoning') {
    const summary = Array.isArray(item.summary) ? item.summary.map((part: any) => part?.text).filter(Boolean).join('\n\n') : '';
    return [{ role: 'assistant', content: [{ type: 'thinking', thinking: summary, redacted: !summary || undefined }] }];
  }
  if (item.type === 'function_call' || item.type === 'custom_tool_call') {
    let input = item.arguments ?? item.input;
    if (item.type === 'function_call' && typeof input === 'string') {
      try { input = JSON.parse(input); } catch { /* Preserve non-JSON arguments. */ }
    }
    return [{ role: 'assistant', content: [{ type: 'toolCall', id: item.call_id, name: item.name, arguments: input }] }];
  }
  if (item.type === 'function_call_output' || item.type === 'custom_tool_call_output') {
    return [{ role: 'toolResult', toolCallId: item.call_id, content: item.output, isError: exitEnvelope(item.output) }];
  }
  return [];
}

/** One token_count event per model call. Codex's input_tokens includes the cached
 * and cache-write parts, so fresh input is the remainder. The running total is
 * strictly increasing, so it keys a call and drops repeated events. No cost is reported.
 */
function usage(entry: any): NeutralUsage[] {
  const info = entry?.type === 'event_msg' && entry.payload?.type === 'token_count' ? entry.payload.info : undefined;
  const last = info?.last_token_usage;
  if (!last || typeof info.total_token_usage?.total_tokens !== 'number') return [];
  const cacheRead = count(last.cached_input_tokens), cacheWrite = count(last.cache_write_input_tokens);
  return [{ key: `total:${info.total_token_usage.total_tokens}`, scope: 'call', provider: 'openai',
    input: Math.max(0, count(last.input_tokens) - cacheRead - cacheWrite), cacheRead, cacheWrite,
    output: count(last.output_tokens), reasoning: count(last.reasoning_output_tokens) }];
}

export const codex: HarnessAdapter = {
  name: 'codex',
  homeEnv: 'CODEX_HOME',
  defaultHome: ['.codex'],
  resume: sessionId => ['codex', 'resume', sessionId],
  // apply_patch can change several files; shell and MCP calls can write anywhere.
  toolTarget: () => undefined,
  isDirectFileTool: () => false,
  toolView: toolName => toolName === 'apply_patch' ? 'patch' : 'full',
  // A subagent's rollout has its own session_meta with an object source ({subagent: …}).
  nativeSession: entry => entry?.type === 'session_meta' && typeof entry.payload?.id === 'string'
    && typeof entry.payload.source !== 'object' ? entry.payload.id : undefined,
  nativeCwd: entry => entry?.type === 'session_meta' && typeof entry.payload?.cwd === 'string' ? entry.payload.cwd : undefined,
  nativeChanges: entry => {
    const item = entry?.type === 'event_msg' && entry.payload?.type === 'item_completed' ? entry.payload.item : undefined;
    if (item?.type !== 'FileChange' || !item.changes || typeof item.changes !== 'object') return [];
    return Object.entries<any>(item.changes).map(([file, change]) => ({ path: file, content: change?.content, diff: change?.unified_diff,
      operation: change?.type === 'add' ? 'create' : change?.type === 'delete' ? 'delete' : 'modify' }));
  },
  isScriptStep: toolName => toolName === 'exec' || toolName === 'wait',
  // A fork points to its parent and copies no lines, so no line of it needs tracing.
  nativeForkedFrom: () => undefined,
  isNotice: () => false,
  nativeVersion: entry => entry?.type === 'session_meta' && typeof entry.payload?.cli_version === 'string' ? entry.payload.cli_version : undefined,
  // Codex adds its own user-role messages (AGENTS.md, <environment_context>); they are not typed.
  nativePrompt: entry => {
    const item = entry?.payload;
    if (entry?.type !== 'response_item' || item?.type !== 'message' || item.role !== 'user') return undefined;
    const text = contentText(item.content)?.trim();
    return text && !/^(?:# AGENTS\.md instructions for |<[a-z_]+>)/.test(text) ? text : undefined;
  },
  // sessions/YYYY/MM/DD/rollout-….jsonl
  sessionFiles: home => jsonlFiles(path.join(home, 'sessions'), 3),
  // Everything else Codex keeps about a session is in files and databases all sessions share.
  sessionTraces: () => [],
  // The session's own header names it and its folders; a turn's context names its folder.
  cloneLine: (entry, { from, sessionId, move }) => {
    const payload = entry?.payload;
    if (entry?.type === 'session_meta' && payload?.id === from) {
      return { ...entry, payload: { ...payload, id: sessionId, ...(payload.session_id === undefined ? {} : { session_id: sessionId }),
        ...(typeof payload.cwd === 'string' ? { cwd: move(payload.cwd) } : {}),
        ...(Array.isArray(payload.runtime_workspace_roots) ? { runtime_workspace_roots: payload.runtime_workspace_roots.map((root: unknown) => typeof root === 'string' ? move(root) : root) } : {}) } };
    }
    if (entry?.type === 'turn_context' && typeof payload?.cwd === 'string') return { ...entry, payload: { ...payload, cwd: move(payload.cwd) } };
    return entry;
  },
  // sessions/YYYY/MM/DD/rollout-YYYY-MM-DDTHH-MM-SS-<session>.jsonl, in local time as Codex names them.
  sessionFile: (home, sessionId, _cwd, now) => {
    const two = (n: number) => String(n).padStart(2, '0');
    const [year, month, day] = [String(now.getFullYear()), two(now.getMonth() + 1), two(now.getDate())];
    const time = `${two(now.getHours())}-${two(now.getMinutes())}-${two(now.getSeconds())}`;
    return path.join(home, 'sessions', year, month, day, `rollout-${year}-${month}-${day}T${time}-${sessionId}.jsonl`);
  },
  nativeEntry: entry => ({
    id: typeof entry?.payload?.id === 'string' && entry.payload.id ? entry.payload.id : undefined,
    timestamp: entry?.timestamp,
    turnId: typeof entry?.payload?.turn_id === 'string' ? entry.payload.turn_id : undefined,
    kind: [entry?.type ?? 'unknown', entry?.payload?.type].filter(Boolean).join(':'),
    messages: messages(entry),
    usage: usage(entry),
    model: entry?.type === 'turn_context' && typeof entry.payload?.model === 'string' ? entry.payload.model : undefined,
  }),
};
