import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { harnessHome, type Launch } from '../launch.js';

/** Hooks, MCP and nothing global: the plugin loads only for this one process,
 * so a `claude` started without Wisdom is never recorded or paused. Claude Code
 * keeps its files, sessions and login in Wisdom's folder, not in ~/.claude.
 */
export function launchClaudeCode(options: { command?: string; args: string[]; dataDir: string; cliPath: string }): Launch {
  const command = options.command ?? 'claude';
  let version: string | undefined;
  try { version = execFileSync(command, ['--version'], { encoding: 'utf8', windowsHide: true }).trim(); }
  catch { throw new Error(`Cannot run Claude Code (${command}). Install it or pass --claude-bin.`); }
  const mcp = { mcpServers: { wisdom: { command: process.execPath, args: [options.cliPath, 'mcp', '--data', options.dataDir] } } };
  return {
    command,
    env: { CLAUDE_CONFIG_DIR: harnessHome(options.dataDir, 'claude-code') },
    args: ['--plugin-dir', fileURLToPath(new URL('../../../../integrations/claude-code', import.meta.url)),
      '--mcp-config', JSON.stringify(mcp), ...options.args],
    launch: { harness: 'claude-code', harnessVersion: version },
  };
}
