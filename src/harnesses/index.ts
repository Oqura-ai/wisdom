import { harnessHome } from '../paths.js';
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

/** The command a person types to continue a session directly: its folder, its home, its
 * harness. The home is what keeps it recording, so the command must set it.
 */
export function resumeCommands(dataDir: string, name: string, sessionId: string, cwd: string): { powershell: string; posix: string } {
  const { homeEnv, resume } = adapter(name);
  const folder = harnessHome(dataDir, name);
  const command = resume(sessionId).join(' ');
  const literal = (value: string, quote: string) => `'${value.replaceAll("'", quote)}'`;
  return {
    powershell: `cd -LiteralPath ${literal(cwd, "''")}; $env:${homeEnv} = ${literal(folder, "''")}; ${command}`,
    posix: `cd ${literal(cwd, "'\\''")} && ${homeEnv}=${literal(folder, "'\\''")} ${command}`,
  };
}

/** Normalize one native line at read time, so adapter fixes apply to old captures. */
export function nativeMessage(name: string, raw: string, toolCallId?: string): NeutralMessage | null {
  const { messages } = adapter(name).nativeEntry(JSON.parse(raw));
  return (toolCallId ? messages.find(message => message.toolCallId === toolCallId) : undefined) ?? messages[0] ?? null;
}
