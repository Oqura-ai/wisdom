import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { Launch } from '../launch.js';

const resumes = ['--resume', '-r', '--continue', '-c'];

/** Hooks, MCP and nothing global: the plugin loads only for this one process,
 * so a `claude` started without Wisdom is never recorded or paused.
 */
export function launchClaudeCode(options: { command?: string; args: string[]; dataDir: string; cliPath: string }): Launch {
  const command = options.command ?? 'claude';
  let version: string | undefined;
  try { version = execFileSync(command, ['--version'], { encoding: 'utf8', windowsHide: true }).trim(); }
  catch { throw new Error(`Cannot run Claude Code (${command}). Install it or pass --claude-bin.`); }
  // A fresh session's ID is fixed up front. A resumed one reports its ID in SessionStart.
  const resuming = options.args.some(arg => resumes.includes(arg) || resumes.some(flag => arg.startsWith(flag + '=')));
  const sessionId = resuming ? undefined : randomUUID();
  const mcp = { mcpServers: { wisdom: { command: process.execPath, args: [options.cliPath, 'mcp', '--data', options.dataDir] } } };
  return {
    command,
    args: ['--plugin-dir', fileURLToPath(new URL('../../../../integrations/claude-code', import.meta.url)),
      '--mcp-config', JSON.stringify(mcp), ...(sessionId ? ['--session-id', sessionId] : []), ...options.args],
    capture: { harness: 'claude-code', sessionId: sessionId ?? 'pending-resume', harnessVersion: version },
  };
}
