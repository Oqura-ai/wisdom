#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { call, connectionAt, ensureDaemon } from './client.js';
import { startDaemon } from './daemon.js';
import { serveMcp } from './mcp.js';
import { findDataDir, marker, movedFrom } from './paths.js';
import { writeJson } from './ledger.js';
import { installPi, launchPi, piEntry } from './harnesses/pi/launch.js';
import { installClaudeCode, launchClaudeCode } from './harnesses/claude-code/launch.js';
import { installCodex, launchCodex } from './harnesses/codex/launch.js';
import { adapter } from './harnesses/index.js';
import { staleHooks, type Launch } from './harnesses/launch.js';

const print = (value: unknown) => console.log(JSON.stringify(value, null, 2));
const help = `Wisdom — live evidence ledger for coding agents (Pi, Claude Code, Codex)

  wisdom init [--cwd DIR]            Make DIR (default: here) a Wisdom project: .wisdom/, hooks, daemon
  wisdom track pi [--cwd DIR] [--pi-entry FILE] [-- Pi arguments]
  wisdom track claude [--cwd DIR] [--claude-bin FILE] [-- Claude Code arguments]
  wisdom track codex [--cwd DIR] [--codex-bin FILE] [--setup-hooks | --trust-all-hooks] [-- Codex arguments]
  wisdom resume SESSION-ID           Continue a recorded session in its harness and folder
  wisdom glance [CAPTURE|latest] [--from N] [--at VERSION]
  wisdom open POSITION --capture CAPTURE|latest [--from N] [--at VERSION]
  wisdom daemon start|run|status|stop [--port N] [--no-dashboard]
  wisdom dashboard                   Print the live dashboard URL (served on daemon port + 1)
  wisdom mcp

Every command finds the project's .wisdom folder from the current folder (or --cwd) upward,
like git; --data DIR or WISDOM_DATA_DIR names it directly. Any harness process that uses
the project's harness home records, however it was started; track is the short way.
resume takes the full session ID. CAPTURE also takes its first 8+ characters, or latest (the newest session with a turn).
POSITION is t3 (a turn), t3/c2 (a tool call), a1 (a subagent), a1/c2, or outside.
Run: npm.cmd run wisdom -- <command>
`;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const separator = args.indexOf('--');
  const harnessArgs = separator < 0 ? [] : args.slice(separator + 1);
  const { positionals, values } = parseArgs({ args: separator < 0 ? args : args.slice(0, separator), allowPositionals: true,
    options: {
      data: { type: 'string' }, port: { type: 'string' }, cwd: { type: 'string' }, 'pi-entry': { type: 'string' },
      help: { type: 'boolean' }, capture: { type: 'string' }, from: { type: 'string' }, at: { type: 'string' },
      'claude-bin': { type: 'string' }, 'no-dashboard': { type: 'boolean' }, 'codex-bin': { type: 'string' }, 'setup-hooks': { type: 'boolean' }, 'trust-all-hooks': { type: 'boolean' },
    } });
  const [command, first] = positionals;
  if (!command || values.help) { console.log(help); return; }
  const options: Record<string, string[]> = {
    init: ['cwd', 'port', 'pi-entry', 'claude-bin', 'codex-bin'],
    daemon: ['port', 'no-dashboard'], dashboard: [], track: ['port', 'cwd', 'pi-entry', 'claude-bin', 'codex-bin', 'setup-hooks', 'trust-all-hooks'], mcp: ['port'],
    resume: ['port', 'pi-entry', 'claude-bin', 'codex-bin', 'trust-all-hooks'],
    glance: ['from', 'at'], open: ['capture', 'from', 'at'],
  };
  const allowed = options[command];
  if (!allowed) throw new Error(`Unknown command: ${command}. Run --help.`);
  for (const key of Object.keys(values)) if (key !== 'data' && !allowed.includes(key)) throw new Error(`--${key} is not valid for ${command}`);
  if (separator >= 0 && command !== 'track') throw new Error('Arguments after -- are only supported by track');
  if (positionals.length > (['daemon', 'track', 'resume', 'glance', 'open'].includes(command) ? 2 : 1)) throw new Error('Unexpected positional arguments');

  const port = values.port === undefined ? undefined : Number(values.port);
  if (port !== undefined && (!Number.isInteger(port) || port < 0 || port > 65535)) throw new Error('Invalid port');
  if (command === 'init') { await init(path.resolve(values.cwd ?? process.cwd()), values, port); return; }
  const explicit = values.data ?? process.env.WISDOM_DATA_DIR;
  const start = path.resolve(values.cwd ?? process.cwd());
  const found = explicit ? path.resolve(explicit) : findDataDir(start);
  if (!found) throw new Error(`${start} is not inside a Wisdom project. Run: wisdom init`);
  const dataDir = found;
  // track and resume write the hooks again themselves.
  const stale = ['track', 'resume'].includes(command) ? [] : staleHooks(dataDir);
  if (stale.length) console.error(`Wisdom's hooks for ${stale.join(', ')} point to a Wisdom build that has moved, so they cannot run. Run: wisdom init`);
  if (command === 'daemon') {
    if (first === 'run') {
      const daemon = await runDaemon(dataDir, port, !values['no-dashboard']);
      console.error(`Wisdom listening at ${daemon.connection.url}; data: ${dataDir}`);
      const viewer = (await call(daemon.connection, '/health')).dashboard;
      console.error(viewer.url ? `Dashboard: ${viewer.url}` : `Dashboard not started: ${viewer.reason}`);
      const stop = () => void daemon.close();
      process.once('SIGINT', stop); process.once('SIGTERM', stop);
      await daemon.closed;
      process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
    } else if (first === 'start') {
      const connection = await ensureDaemon(dataDir, port, !values['no-dashboard']);
      console.log(`Wisdom running at ${connection.url} (PID ${connection.pid})`);
      const viewer = (await call(connection, '/health')).dashboard;
      console.log(viewer.url ? `Dashboard: ${viewer.url}` : `Dashboard not started: ${viewer.reason}`);
    } else if (first === 'status') print(await call(connectionAt(dataDir), '/health'));
    else if (first === 'stop') print(await call(connectionAt(dataDir), '/stop', {}));
    else throw new Error('Use daemon start, run, status, or stop');
    return;
  }
  if (command === 'dashboard') {
    const viewer = (await call(connectionAt(dataDir), '/health')).dashboard;
    if (!viewer.url) throw new Error(`Dashboard not running: ${viewer.reason}`);
    console.log(viewer.url); return;
  }
  if (command === 'track') { process.exitCode = await track(first, values, harnessArgs, dataDir, port); return; }
  if (command === 'resume') {
    // The ledger knows the harness, folder and full ID; the harness gets its own resume flag.
    if (!first) throw new Error('Use: wisdom resume SESSION-ID (the full ID; glance lists them)');
    const session = await call(await ensureDaemon(dataDir, port), '/resolve', { session: first });
    const [harness, ...args] = adapter(session.harness).resume(session.captureId);
    console.error(`Resuming ${session.harness} session ${session.captureId}`);
    process.exitCode = await track(harness, { ...values, cwd: session.workspaceRoot }, args, dataDir, port); return;
  }
  if (command === 'mcp') { await serveMcp(await ensureDaemon(dataDir, port)); return; }
  // glance and open: the same request an agent sends through MCP, printed as the same text.
  const number = (value?: string) => value === undefined ? undefined : Number(value);
  const reading = { from: number(values.from), at: number(values.at) };
  if (command === 'open' && !first) throw new Error('Use: wisdom open POSITION --capture CAPTURE|latest');
  const input = command === 'glance' ? { capture: first, glance: true, ...reading } : { capture: values.capture, open: first, ...reading };
  console.log((await call(await ensureDaemon(dataDir), '/ledger', input)).text);
}

/** The daemon's default port is 7434; when another project's daemon holds it, the next
 * free pair is used (daemon.json says which). An explicit --port is used as given.
 */
async function runDaemon(dataDir: string, port: number | undefined, dashboard: boolean) {
  for (let candidate = port ?? 7434; ; candidate += 2) {
    try { return await startDaemon(dataDir, candidate, { dashboardPort: dashboard && candidate ? candidate + 1 : undefined }); }
    catch (error: any) { if (port !== undefined || error?.code !== 'EADDRINUSE' || candidate >= 7434 + 40) throw error; }
  }
}

/** Make a folder a Wisdom project: its data folder, Wisdom's hooks in each installed
 * harness's home there, and a running daemon. Running it again repairs the hooks.
 */
async function init(project: string, values: any, port?: number): Promise<void> {
  if (!fs.existsSync(project)) throw new Error(`${project} does not exist`);
  const dataDir = path.join(project, '.wisdom');
  const fresh = !fs.existsSync(path.join(dataDir, marker));
  fs.mkdirSync(dataDir, { recursive: true });
  if (fresh) writeJson(path.join(dataDir, marker), { project, createdAt: new Date().toISOString() });
  // Session files and payloads are stored unredacted: never commit them.
  const ignore = path.join(project, '.gitignore');
  const lines = fs.existsSync(ignore) ? fs.readFileSync(ignore, 'utf8').split(/\r?\n/) : [];
  const ignored = lines.some(line => ['.wisdom', '.wisdom/', '/.wisdom', '/.wisdom/'].includes(line.trim()));
  if (!ignored) fs.appendFileSync(ignore, (lines.length && lines.at(-1) !== '' ? '\n' : '') + '.wisdom/\n');
  console.log(`${fresh ? 'Created' : 'Found'} ${dataDir}${ignored ? '' : ' (added .wisdom/ to .gitignore)'}`);
  const known = fresh ? undefined : movedFrom(dataDir);
  if (known) console.log(`  This project moved from ${known}. Its recorded sessions follow it when the daemon starts.`);
  const installed = (name: string, check: () => void, install: () => string, next: string) => {
    try { check(); } catch { console.log(`  ${name.padEnd(12)} not found, skipped (run wisdom init again after installing it)`); return; }
    console.log(`  ${name.padEnd(12)} hooks in ${path.relative(project, install())} · ${next}`);
  };
  const version = (command: string) => () => { execFileSync(command, ['--version'], { windowsHide: true, stdio: 'ignore' }); };
  installed('Claude Code', version(values['claude-bin'] ?? 'claude'), () => installClaudeCode(dataDir),
    'first run: wisdom track claude, then log in once');
  installed('Codex', version(values['codex-bin'] ?? 'codex'), () => installCodex(dataDir).home,
    'first run: wisdom track codex --setup-hooks, trust Wisdom\'s hooks in /hooks, log in');
  installed('Pi', () => { fs.accessSync(piEntry(values['pi-entry'])); }, () => installPi(dataDir),
    'first run: wisdom track pi, then log in once (/login)');
  console.log('Your global harness settings (~/.claude, ~/.codex, ~/.pi) are not touched.');
  console.log('Keep .wisdom/ private: it holds each harness\'s login and unredacted sessions. .gitignore only keeps it out of git, so leave it out of zips, copies and synced folders.');
  const connection = await ensureDaemon(dataDir, port);
  console.log(`Daemon running at ${connection.url}`);
}

/** Start a harness with its home in the project's data folder. Recording comes from the
 * hooks in that home, so the launcher only sets the folder and starts the daemon early.
 */
async function track(harness: string | undefined, values: any, args: string[], dataDir: string, port?: number): Promise<number> {
  const cwd = path.resolve(values.cwd ?? process.cwd());
  const cliPath = fileURLToPath(new URL('./cli.js', import.meta.url));
  if (values['pi-entry'] && harness !== 'pi') throw new Error('--pi-entry applies only to track pi');
  if (values['claude-bin'] && harness !== 'claude') throw new Error('--claude-bin applies only to track claude');
  if ((values['codex-bin'] || values['setup-hooks'] || values['trust-all-hooks']) && harness !== 'codex') {
    throw new Error('--codex-bin, --setup-hooks and --trust-all-hooks apply only to track codex');
  }
  const launch: Launch = harness === 'pi' ? launchPi({ entry: values['pi-entry'], args, dataDir })
    : harness === 'claude' ? launchClaudeCode({ command: values['claude-bin'], args, dataDir, cliPath })
    : harness === 'codex' ? await launchCodex({ command: values['codex-bin'], args, dataDir, cliPath, cwd, setupHooks: values['setup-hooks'], trustAllHooks: values['trust-all-hooks'] })
    : (() => { throw new Error('Use: wisdom track pi|claude|codex'); })();
  if (launch.setupOnly) console.error('Open /hooks in Codex, review and trust the Wisdom hooks, then quit and run wisdom track codex. '
    + 'Until they are trusted, sessions are read from their files only.');
  else {
    await ensureDaemon(dataDir, port);
    console.error('Wisdom is recording sessions in this harness home.');
  }
  // The ledger skill calls this installation's CLI from the project.
  return runHarness(launch, cwd, { ...process.env, ...launch.env, WISDOM_CLI_PATH: cliPath });
}

function runHarness(launch: Launch, cwd: string, env: NodeJS.ProcessEnv): Promise<number> {
  const child = spawn(launch.command, launch.args, { cwd, stdio: 'inherit', windowsHide: true, env });
  return new Promise((resolve, reject) => {
    child.once('error', reject); child.once('exit', code => resolve(code ?? 1));
  });
}

main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
