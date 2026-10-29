import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { harnessHome, type Launch } from '../launch.js';

export const hookEvents = ['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse',
  'Stop', 'SubagentStart', 'SubagentStop', 'PreCompact', 'PostCompact'] as const;

export function hookSettings(): { command: string; args: string[] } {
  const file = fileURLToPath(new URL('../../../../integrations/codex/hook.mjs', import.meta.url)).replaceAll('\\', '/');
  if (/["\r\n]/.test(file)) throw new Error('Wisdom hook path cannot contain quotes or newlines');
  const command = `node "${file}"`;
  const args = ['-c', 'features.hooks=true'];
  for (const event of hookEvents) args.push('-c', `hooks.${event}=[{hooks=[{type="command",command=${JSON.stringify(command)},timeout=${event === 'SessionEnd' ? 3 : 40}}]}]`);
  return { command, args };
}

/** Read hook metadata only. No thread is started and no model is called. */
export async function inspectHooks(command: string, args: string[], cwd: string, env = process.env): Promise<any> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args, 'app-server'], { cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let done = false;
    const finish = (error?: Error, result?: unknown) => {
      if (done) return;
      done = true; clearTimeout(timer); lines.close(); child.stdin.end(); child.kill();
      if (error) reject(error); else resolve(result);
    };
    const timer = setTimeout(() => finish(new Error('Codex hook inspection timed out')), 15000);
    const lines = createInterface({ input: child.stdout });
    child.stderr.resume(); // Do not echo unrelated configuration or authentication diagnostics.
    const send = (message: unknown) => child.stdin.write(JSON.stringify(message) + '\n');
    child.on('error', error => finish(error));
    child.stdin.on('error', error => finish(error));
    child.on('exit', () => finish(new Error('Codex exited before reporting its recording hooks')));
    lines.on('line', line => {
      let message: any;
      try { message = JSON.parse(line); } catch { return; }
      if (message.error) { finish(new Error(`Codex hook inspection failed: ${message.error.message}`)); return; }
      if (message.id === 1) {
        send({ method: 'initialized' });
        send({ id: 2, method: 'hooks/list', params: { cwds: [cwd] } });
      } else if (message.id === 2) finish(undefined, message.result);
    });
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'wisdom', version: '0.3.0' } } });
  });
}

export function requireTrustedHooks(result: any, command: string, allowUntrusted = false): void {
  const entries = result?.data;
  if (!Array.isArray(entries) || entries.length !== 1 || entries[0].errors?.length) {
    throw new Error('Codex could not load Wisdom hooks. Check Codex configuration and managed hook policy.');
  }
  const missing = hookEvents.filter(event => !entries[0].hooks?.some((hook: any) =>
    hook.command === command && hook.eventName === event[0].toLowerCase() + event.slice(1)
    && hook.source === 'sessionFlags' && hook.enabled && (allowUntrusted || hook.trustStatus === 'trusted')));
  if (missing.length) throw new Error('Wisdom hooks are missing, disabled, or untrusted. Run `wisdom track codex --setup-hooks` '
    + 'with the same --cwd, review Wisdom hooks in /hooks, then quit and retry. Required: ' + missing.join(', '));
}

/** Inspect the same config/profile overrides used by the interactive process. */
export function inspectionArgs(args: string[]): string[] {
  const result: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (/^(?:--cd|-C|--worktree|--remote)(?:=|$)/.test(arg) || /^-C.+/.test(arg)) {
      throw new Error('Use Wisdom --cwd; changing the Codex workspace or attaching remotely is not supported.');
    }
    if (arg === '--dangerously-bypass-hook-trust') throw new Error('Review Wisdom hooks with --setup-hooks, or pass Wisdom\'s --trust-all-hooks.');
    if (['-c', '--config', '-p', '--profile', '--enable', '--disable'].includes(arg)) {
      if (!args[i + 1]) throw new Error(`Missing Codex value for ${arg}`);
      result.push(arg, args[++i]);
    } else if (/^(?:--config=|--profile=|--enable=|--disable=|-c.+|-p.+)/.test(arg)) result.push(arg);
  }
  for (const arg of result) {
    const value = arg.replace(/^(?:--config=|-c)/, '').trim();
    const key = value.split('=', 1)[0].replace(/["'\s]/g, '');
    if (/^(?:hooks(?:\.|$)|features(?:\.hooks)?$|mcp_servers(?:\.wisdom(?:\.|$)|$))/.test(key)
      || value === 'hooks' || value === '--disable=hooks') {
      throw new Error('Codex arguments cannot override Wisdom hooks or its MCP server.');
    }
  }
  return result;
}

/** node_repl (shipped with the Codex desktop app) can run shell commands and patches
 * inside one MCP call, so hooks see only that outer call. Best-effort config check.
 */
export function nodeReplEnabled(configText: string, overrides: string[]): boolean {
  if (overrides.some(arg => /mcp_servers\.node_repl\.enabled\s*=\s*false/.test(arg))) return false;
  const section = /^\[mcp_servers\.node_repl\]\s*$([\s\S]*?)(?=^\[(?!mcp_servers\.node_repl[.\]])|(?![\s\S]))/m.exec(configText);
  return !!section && !/^\s*enabled\s*=\s*false\b/m.test(section[1]);
}

export const trustAllWarning = 'WARNING: --trust-all-hooks runs every enabled Codex hook without review for this session, '
  + "including your global hooks and this project's .codex hooks, not only Wisdom's. Use it only in repositories you trust.";

export async function launchCodex(options: {
  command?: string; args: string[]; dataDir: string; cliPath: string; cwd: string; setupHooks?: boolean; trustAllHooks?: boolean;
}): Promise<Launch> {
  const command = options.command ?? 'codex';
  let version: string;
  try { version = execFileSync(command, ['--version'], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
  catch { throw new Error(`Cannot run Codex (${command}). Install it or pass --codex-bin.`); }
  const match = /codex-cli (\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!match || Number(match[1]) === 0 && Number(match[2]) < 147) throw new Error('Codex CLI 0.147.0 or newer is required.');
  // Codex keeps its sessions, login and hook trust in Wisdom's folder, not in ~/.codex.
  const env = { CODEX_HOME: harnessHome(options.dataDir, 'codex') };
  const settings = hookSettings();
  const overrides = inspectionArgs(options.args);
  if (options.setupHooks) {
    if (options.args.length) throw new Error('--setup-hooks does not accept Codex arguments');
    if (options.trustAllHooks) throw new Error('--setup-hooks and --trust-all-hooks are alternatives; choose one');
    return { command, env, args: ['-C', options.cwd, ...settings.args], setupOnly: true };
  }
  requireTrustedHooks(await inspectHooks(command, [...settings.args, ...overrides], options.cwd, { ...process.env, ...env }), settings.command, options.trustAllHooks);
  if (options.trustAllHooks) console.error(trustAllWarning);
  const configFile = path.join(env.CODEX_HOME, 'config.toml');
  if (nodeReplEnabled(fs.existsSync(configFile) ? fs.readFileSync(configFile, 'utf8') : '', overrides)) {
    console.error('Note: the node_repl MCP server is enabled. Commands it runs inside one call are invisible to hooks; '
      + 'Wisdom still records their file changes. Add -- -c mcp_servers.node_repl.enabled=false to see each command.');
  }
  const mcp = ['-c', `mcp_servers.wisdom.command=${JSON.stringify(process.execPath)}`, '-c',
    `mcp_servers.wisdom.args=${JSON.stringify([options.cliPath, 'mcp', '--data', options.dataDir])}`];
  return { command, env, args: ['-C', options.cwd, ...settings.args, ...mcp,
    ...(options.trustAllHooks ? ['--dangerously-bypass-hook-trust'] : []), ...options.args],
    launch: { harness: 'codex', harnessVersion: version } };
}
