import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { home, hookCommand, installSkill, readSettings, resolveCommand, saveOrRemoveSettings, saveSettings, settingsFile, withHooks, withoutHooks, type Command, type Launch, type Place } from '../launch.js';

export const hookEvents = ['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse',
  'PostToolUseFailure', 'Stop', 'SubagentStart', 'SubagentStop', 'PreCompact'] as const;
const toolEvents = new Set(['PreToolUse', 'PostToolUse', 'PostToolUseFailure']);

/** Put Wisdom's hooks in one Claude Code settings file, keeping any other hooks there. */
function writeHooks(dataDir: string, place: Place): void {
  const file = settingsFile(dataDir, 'claude-code', place);
  const settings = readSettings(file);
  settings.hooks = withHooks(settings.hooks, hookEvents, hookCommand('claude-code', dataDir, place === 'project'),
    event => toolEvents.has(event) ? { matcher: '*' } : {});
  saveSettings(file, settings);
}

/** Write Wisdom's hooks into the settings of Claude Code's home in Wisdom's folder.
 * Every Claude Code process that uses this home (a fork's background process, a
 * branch, a resume, a worktree) loads them; ~/.claude is never touched.
 */
export function installClaudeCode(dataDir: string): string {
  const folder = home(dataDir, 'claude-code');
  writeHooks(dataDir, 'home');
  installSkill(folder);
  return folder;
}

/** Wisdom's hooks in the project's `.claude/settings.local.json`, which Claude Code loads when
 * it starts in the project's folder, with the person's own home and login. Returns the file.
 */
export function connectClaudeCode(dataDir: string): string {
  writeHooks(dataDir, 'project');
  return settingsFile(dataDir, 'claude-code', 'project');
}

/** Take Wisdom's hooks out of the project's settings, leaving everything else as it was. */
export function disconnectClaudeCode(dataDir: string): void {
  const file = settingsFile(dataDir, 'claude-code', 'project');
  const settings = readSettings(file);
  const hooks = withoutHooks(settings.hooks);
  if (hooks) settings.hooks = hooks; else delete settings.hooks;
  saveOrRemoveSettings(file, settings);
}

/** Claude Code with its home in Wisdom's folder (its files, sessions and login stay there), or,
 * in a connected project, with the person's own home, where the project's settings record it.
 */
export function launchClaudeCode(options: { command?: string; args: string[]; dataDir: string; cliPath: string; place?: Place }): Launch {
  const name = options.command ?? 'claude';
  let program: Command;
  try { program = resolveCommand(name); execFileSync(program.command, [...program.args, '--version'], { encoding: 'utf8', windowsHide: true }); }
  catch { throw new Error(`Cannot run Claude Code (${name}). Install it or pass --claude-bin.`); }
  const mcp = { mcpServers: { wisdom: { command: process.execPath, args: [options.cliPath, 'mcp', '--data', options.dataDir] } } };
  return { command: program.command, env: options.place === 'project' ? {} : { CLAUDE_CONFIG_DIR: installClaudeCode(options.dataDir) },
    // `--mcp-config` takes several values: written apart, it would also take a prompt that follows.
    args: [...program.args, `--mcp-config=${JSON.stringify(mcp)}`, ...options.args] };
}
