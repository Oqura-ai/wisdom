import os from 'node:os';
import path from 'node:path';
import { harnessHome, wisdomHomeData } from '../core/paths.js';
import type { HarnessAdapter, NeutralMessage } from './types.js';
import type { Place } from './launch.js';
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

/** The harness's home when a person runs it themselves: its variable, else its default
 * folder. A Wisdom home in the variable is this process running inside a tracked session,
 * not the person's own, so it is passed over.
 */
export function userHome(name: string): string {
  const { homeEnv, defaultHome } = adapter(name);
  const set = process.env[homeEnv];
  return set && !wisdomHomeData(name, set) ? path.resolve(set) : path.join(os.homedir(), ...defaultHome);
}

/** Where a session runs: in its harness's home in Wisdom's folder, or, when its transcript is
 * kept anywhere else, in the person's own home, where a connected project records it.
 */
export function sessionPlace(dataDir: string, name: string, source: string | null | undefined): Place {
  if (!source) return 'home';
  const relative = path.relative(harnessHome(dataDir, name), source);
  return relative.startsWith('..') || path.isAbsolute(relative) ? 'project' : 'home';
}

/** The command a person types to continue a session directly: its folder, its home, its
 * harness. Wisdom's home is what keeps a tracked session recording, so the command sets it;
 * a connected session runs in the person's own home, so it is left alone.
 */
export function resumeCommands(dataDir: string, name: string, sessionId: string, cwd: string, source?: string | null): { powershell: string; posix: string } {
  const { homeEnv, resume } = adapter(name);
  const folder = harnessHome(dataDir, name);
  const command = resume(sessionId).join(' ');
  const literal = (value: string, quote: string) => `'${value.replaceAll("'", quote)}'`;
  const own = sessionPlace(dataDir, name, source) === 'project';
  return {
    powershell: `cd -LiteralPath ${literal(cwd, "''")}; ${own ? '' : `$env:${homeEnv} = ${literal(folder, "''")}; `}${command}`,
    posix: `cd ${literal(cwd, "'\\''")} && ${own ? '' : `${homeEnv}=${literal(folder, "'\\''")} `}${command}`,
  };
}

/** Normalize one native line at read time, so adapter fixes apply to old captures. */
export function nativeMessage(name: string, raw: string, toolCallId?: string): NeutralMessage | null {
  const { messages } = adapter(name).nativeEntry(JSON.parse(raw));
  return (toolCallId ? messages.find(message => message.toolCallId === toolCallId) : undefined) ?? messages[0] ?? null;
}
