#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { call, connectionAt, ensureDaemon } from './client.js';
import { startDaemon, type Connection } from './daemon.js';
import { diagnose, formatChecks, wisdomVersion } from './doctor.js';
import { serveMcp } from './mcp.js';
import { findDataDir, marker, movedFrom } from './paths.js';
import { writeJson } from './ledger.js';
import { installPi, launchPi, piEntry } from './harnesses/pi/launch.js';
import { installClaudeCode, launchClaudeCode } from './harnesses/claude-code/launch.js';
import { installCodex, launchCodex } from './harnesses/codex/launch.js';
import { adapter } from './harnesses/index.js';
import { staleHooks, type Launch } from './harnesses/launch.js';

const help = `Wisdom records your coding agents' sessions, so you and your agents can read them.

Set up
  wisdom init                     Turn on recording in this project
  wisdom doctor                   Check that everything is working

Run an agent
  wisdom track claude|codex|pi    Start an agent in this project, recording
  wisdom resume <session-id>      Continue a recorded session (takes the full ID)

Read a session
  wisdom dashboard                Print the address of the live dashboard
  wisdom glance                   List recorded sessions, newest first
  wisdom glance <session>         Show one session's shape and every turn
  wisdom open <position> --capture <session>
                                  Read one turn, tool call or subagent, whole

Background service
  wisdom daemon start|stop|status
  wisdom daemon run               Run it in the foreground

Other
  wisdom mcp                      Serve the optional read-only MCP tool
  wisdom --version

<session>   a session ID, its first 8 or more characters, or latest
<position>  t3 (a turn), t3/c2 (a tool call), a1 (a subagent), a1/c2, or outside

Options
  --cwd DIR, --data DIR           Use the project at DIR, or the data folder DIR
  --from N, --at VERSION          glance, open: read from a line, at a fixed version
  --port N, --no-dashboard        daemon: choose a port, or skip the dashboard
  --claude-bin, --codex-bin FILE  track: use another installation (Pi: --pi-entry FILE)
  --setup-hooks                   track codex: review Wisdom's hooks, first time only
  --trust-all-hooks               track codex: skip the review, for every hook in that run
  -- ARGUMENTS                    track: pass the rest to the agent

Docs: https://github.com/Oqura-ai/wisdom
`;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const separator = args.indexOf('--');
  const harnessArgs = separator < 0 ? [] : args.slice(separator + 1);
  const { positionals, values } = parseArgs({ args: separator < 0 ? args : args.slice(0, separator), allowPositionals: true,
    options: {
      data: { type: 'string' }, port: { type: 'string' }, cwd: { type: 'string' }, 'pi-entry': { type: 'string' },
      help: { type: 'boolean' }, version: { type: 'boolean' }, capture: { type: 'string' }, from: { type: 'string' }, at: { type: 'string' },
      'claude-bin': { type: 'string' }, 'no-dashboard': { type: 'boolean' }, 'codex-bin': { type: 'string' }, 'setup-hooks': { type: 'boolean' }, 'trust-all-hooks': { type: 'boolean' },
    } });
  const [command, first] = positionals;
  if (values.version) { console.log(wisdomVersion()); return; }
  if (!command || values.help) { console.log(help); return; }
  const options: Record<string, string[]> = {
    init: ['cwd', 'port', 'pi-entry', 'claude-bin', 'codex-bin'],
    daemon: ['cwd', 'port', 'no-dashboard'], dashboard: ['cwd'], doctor: ['cwd'], track: ['port', 'cwd', 'pi-entry', 'claude-bin', 'codex-bin', 'setup-hooks', 'trust-all-hooks'], mcp: ['cwd', 'port'],
    resume: ['cwd', 'port', 'pi-entry', 'claude-bin', 'codex-bin', 'trust-all-hooks'],
    glance: ['cwd', 'from', 'at'], open: ['cwd', 'capture', 'from', 'at'],
  };
  const allowed = options[command];
  if (!allowed) throw new Error(['start', 'stop', 'status'].includes(command) ? `Unknown command: ${command}. Did you mean: wisdom daemon ${command}?` : `Unknown command: ${command}. Run: wisdom --help`);
  for (const key of Object.keys(values)) if (key !== 'data' && !allowed.includes(key)) throw new Error(`--${key} is not valid for ${command}`);
  if (separator >= 0 && command !== 'track') throw new Error('Arguments after -- are only supported by track');
  if (positionals.length > (['daemon', 'track', 'resume', 'glance', 'open'].includes(command) ? 2 : 1)) throw new Error('Unexpected positional arguments');

  const port = values.port === undefined ? undefined : Number(values.port);
  if (port !== undefined && (!Number.isInteger(port) || port < 0 || port > 65535)) throw new Error('--port needs a number from 0 to 65535.');
  if (command === 'init') { await init(path.resolve(values.cwd ?? process.cwd()), values, port); return; }
  const explicit = values.data ?? process.env.WISDOM_DATA_DIR;
  const start = path.resolve(values.cwd ?? process.cwd());
  const found = explicit ? path.resolve(explicit) : findDataDir(start);
  if (!found) throw new Error(`${start} is not inside a Wisdom project. Run: wisdom init`);
  const dataDir = found;
  if (command === 'doctor') {
    const checks = await diagnose(dataDir);
    console.log(formatChecks(path.dirname(dataDir), checks));
    if (checks.some(check => check.level === 'problem')) process.exitCode = 1;
    return;
  }
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
      await showRunning(await ensureDaemon(dataDir, port, !values['no-dashboard']));
    } else if (first === 'status') await showRunning(connectionAt(dataDir));
    else if (first === 'stop') await stopDaemon(dataDir);
    else throw new Error('Use: wisdom daemon start|stop|status|run');
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
  const number = (flag: string, value?: string) => {
    if (value !== undefined && !/^\d+$/.test(value)) throw new Error(`${flag} needs a whole number.`);
    return value === undefined ? undefined : Number(value);
  };
  const reading = { from: number('--from', values.from), at: number('--at', values.at) };
  if (command === 'open' && !first) throw new Error('Use: wisdom open POSITION --capture CAPTURE|latest');
  const input = command === 'glance' ? { capture: first, glance: true, ...reading } : { capture: values.capture, open: first, ...reading };
  console.log((await call(await ensureDaemon(dataDir), '/ledger', input)).text);
}

/** What the running service is, in the same words whichever command asked. */
async function showRunning(connection: Connection): Promise<void> {
  const health = await call(connection, '/health');
  const viewer = health.dashboard;
  console.log('Wisdom is running.');
  console.log(`  Address    ${connection.url} (PID ${connection.pid})`);
  console.log(`  Dashboard  ${dashboardLine(viewer)}`);
  console.log(`  Sessions   ${health.captures}`);
}

function dashboardLine(viewer: any): string {
  if (!viewer.url) return `not started. ${viewer.reason}`;
  return viewer.status === 'exited' ? `stopped unexpectedly. Read ${viewer.log}` : viewer.url;
}

/** Stopping something already stopped is not a failure, and "stopped" is only said once it is. */
async function stopDaemon(dataDir: string): Promise<void> {
  const file = path.join(dataDir, 'daemon.json');
  if (!fs.existsSync(file)) { console.log('Wisdom is not running.'); return; }
  try { await call(connectionAt(dataDir), '/stop', {}); }
  catch (error) {
    if (error instanceof Error && error.message.includes('not answering')) { console.log('Wisdom is not running.'); return; }
    throw error;
  }
  for (let attempt = 0; attempt < 50 && fs.existsSync(file); attempt++) await new Promise(resolve => setTimeout(resolve, 100));
  console.log(fs.existsSync(file) ? 'Wisdom is stopping.' : 'Wisdom stopped.');
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
  console.log(fresh ? `Wisdom is set up in ${project}` : `Wisdom was already set up in ${project}. Its hooks and skills are refreshed.`);
  const known = fresh ? undefined : movedFrom(dataDir);
  if (known) console.log(`This project moved from ${known}. Its recorded sessions follow it when the daemon starts.`);
  console.log('\nStart an agent:');
  const installed = (name: string, check: () => void, install: () => string, next: string) => {
    try { check(); } catch { console.log(`  ${name.padEnd(12)} not installed. Run wisdom init again after installing it.`); return; }
    install();
    console.log(`  ${name.padEnd(12)} ${next}`);
  };
  const version = (command: string) => () => { execFileSync(command, ['--version'], { windowsHide: true, stdio: 'ignore' }); };
  installed('Claude Code', version(values['claude-bin'] ?? 'claude'), () => installClaudeCode(dataDir),
    'wisdom track claude');
  installed('Codex', version(values['codex-bin'] ?? 'codex'), () => installCodex(dataDir).home,
    'wisdom track codex --setup-hooks, trust its hooks in /hooks, then wisdom track codex');
  installed('Pi', () => { fs.accessSync(piEntry(values['pi-entry'])); }, () => installPi(dataDir),
    'wisdom track pi');
  const connection = await ensureDaemon(dataDir, port);
  console.log(`\nDashboard: ${dashboardLine((await call(connection, '/health')).dashboard)}`);
  console.log('\nEach agent asks you to log in once for this project. Your global agent settings are not touched.');
  console.log('Keep .wisdom/ private: it holds your sessions and agent logins, unredacted. Git ignores it, but leave it out of zips and synced folders.');
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

// A reader that stops early (`| head`, `| Select-Object -First`) is not a failure.
process.stdout.on('error', (error: NodeJS.ErrnoException) => { if (error.code === 'EPIPE') process.exit(0); throw error; });

main().catch(error => { console.error(errorText(error)); process.exitCode = 1; });

/** Node's own message for an unknown option talks about positional arguments. */
function errorText(error: any): string {
  if (error?.code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION') return `Unknown option ${/'([^']+)'/.exec(error.message)?.[1] ?? ''}. Run: wisdom --help`;
  return error instanceof Error ? error.message : String(error);
}
