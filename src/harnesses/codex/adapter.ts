import path from 'node:path';
import { contentText, count, jsonlFiles, type HarnessAdapter, type NeutralMessage, type NeutralUsage } from '../types.js';

/** Codex's model-facing command envelope ("Exit code: 1\nWall time: ..."). Verified in
 * 0.147.0 rollouts. Codex sends no PostToolUse for a failed command, so this is often
 * the only failure evidence. Arbitrary tool-output prose is not interpreted.
 */
export function exitEnvelope(text: unknown): boolean | undefined {
  const match = typeof text === 'string'
    ? /(?:^|\n)(?:Process exited with code |Exit code: )(-?\d+)\r?(?:\n|$)/.exec(text) : null;
  return match ? Number(match[1]) !== 0 : undefined;
}

/** Rollouts are an internal format. Keep unknown records as raw evidence and
 * normalize only recognized response items; event_msg repeats their content.
 */
function messages(entry: any): NeutralMessage[] {
  const item = entry?.payload;
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
  resume: sessionId => ['codex', 'resume', sessionId],
  // apply_patch can change several files; shell and MCP calls can write anywhere.
  toolTarget: () => undefined,
  isDirectFileTool: () => false,
  toolView: toolName => toolName === 'apply_patch' ? 'patch' : 'full',
  // A subagent's rollout has its own session_meta with an object source ({subagent: …}).
  nativeSession: entry => entry?.type === 'session_meta' && typeof entry.payload?.id === 'string'
    && typeof entry.payload.source !== 'object' ? entry.payload.id : undefined,
  nativeCwd: entry => entry?.type === 'session_meta' && typeof entry.payload?.cwd === 'string' ? entry.payload.cwd : undefined,
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
