import type { HarnessAdapter, NeutralMessage } from './types.js';
import { pi } from './pi/adapter.js';
import { claudeCode } from './claude-code/adapter.js';
import { codex } from './codex/adapter.js';

export const harnesses = { pi, 'claude-code': claudeCode, codex } as const;
export type HarnessName = keyof typeof harnesses;
export const harnessNames = Object.keys(harnesses) as [HarnessName, ...HarnessName[]];

export function adapter(name: string): HarnessAdapter {
  const found = harnesses[name as HarnessName];
  if (!found) throw new Error(`Unknown harness: ${name}`);
  return found;
}

/** Normalize one native line at read time, so adapter fixes apply to old captures. */
export function nativeMessage(name: string, raw: string, toolCallId?: string): NeutralMessage | null {
  const { messages } = adapter(name).nativeEntry(JSON.parse(raw));
  return (toolCallId ? messages.find(message => message.toolCallId === toolCallId) : undefined) ?? messages[0] ?? null;
}
