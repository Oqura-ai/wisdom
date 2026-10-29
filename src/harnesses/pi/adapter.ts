import { count, type HarnessAdapter, type NeutralUsage } from '../types.js';

/** Pi's Usage is already additive (input excludes cache) and carries cost. It appears
 * on assistant messages, standalone usage entries (cache warming) and compactions.
 */
function usage(entry: any): NeutralUsage[] {
  const raw = entry?.message?.role === 'assistant' ? entry.message.usage : entry?.usage;
  if (!raw || typeof raw !== 'object' || typeof entry?.id !== 'string') return [];
  return [{ key: entry.id, scope: 'call', model: entry.message?.model ?? entry.model, provider: entry.message?.provider ?? entry.provider,
    input: count(raw.input), cacheRead: count(raw.cacheRead), cacheWrite: count(raw.cacheWrite), output: count(raw.output),
    reasoning: count(raw.reasoning), costUsd: typeof raw.cost?.total === 'number' ? raw.cost.total : undefined }];
}

// Pi's message blocks (text, thinking, toolCall) already match the neutral shape.
export const pi: HarnessAdapter = {
  name: 'pi',
  toolTarget: (_toolName, input) => typeof input?.path === 'string' ? input.path : undefined,
  isDirectFileTool: toolName => ['read', 'edit', 'write'].includes(toolName),
  toolView: toolName => ['edit', 'write'].includes(toolName) ? 'patch' : toolName === 'read' ? 'file' : 'full',
  nativeEntry: entry => ({ id: entry?.id, parentId: entry?.parentId, timestamp: entry?.timestamp,
    kind: String(entry?.type ?? 'unknown'), messages: entry?.message ? [entry.message] : [], usage: usage(entry) }),
};
