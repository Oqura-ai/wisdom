import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { home, hookCommand, readSettings, saveSettings, withHooks, type Launch } from '../launch.js';

export const hookEvents = ['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse',
  'PostToolUseFailure', 'Stop', 'SubagentStart', 'SubagentStop', 'PreCompact'] as const;
const toolEvents = new Set(['PreToolUse', 'PostToolUse', 'PostToolUseFailure']);

/** Write Wisdom's hooks into the settings of Claude Code's home in Wisdom's folder.
 * Every Claude Code process that uses this home (a fork's background process, a
 * branch, a resume, a worktree) loads them; ~/.claude is never touched.
 */
export function installClaudeCode(dataDir: string): string {
  const folder = home(dataDir, 'claude-code');
  const file = path.join(folder, 'settings.json');
  const settings = readSettings(file);
  settings.hooks = withHooks(settings.hooks, hookEvents, hookCommand('claude-code', dataDir),
    event => toolEvents.has(event) ? { matcher: '*' } : {});
  saveSettings(file, settings);
  return folder;
}

/** Claude Code with its home in Wisdom's folder: its files, sessions and login stay there. */
export function launchClaudeCode(options: { command?: string; args: string[]; dataDir: string; cliPath: string }): Launch {
  const command = options.command ?? 'claude';
  try { execFileSync(command, ['--version'], { encoding: 'utf8', windowsHide: true }); }
  catch { throw new Error(`Cannot run Claude Code (${command}). Install it or pass --claude-bin.`); }
  const mcp = { mcpServers: { wisdom: { command: process.execPath, args: [options.cliPath, 'mcp', '--data', options.dataDir] } } };
  return { command, env: { CLAUDE_CONFIG_DIR: installClaudeCode(options.dataDir) },
    args: ['--mcp-config', JSON.stringify(mcp), ...options.args] };
}
