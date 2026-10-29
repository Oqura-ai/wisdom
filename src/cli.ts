#!/usr/bin/env node
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { call, connectionAt, defaultDataDir, ensureDaemon } from './client.js';
import { startDaemon } from './daemon.js';
import { serveMcp } from './mcp.js';
import { launchPi } from './harnesses/pi/launch.js';
import { launchClaudeCode } from './harnesses/claude-code/launch.js';
import { launchCodex } from './harnesses/codex/launch.js';
import type { Launch } from './harnesses/launch.js';

const print = (value: unknown) => console.log(JSON.stringify(value, null, 2));
const help = `Wisdom — live evidence ledger for coding agents (Pi, Claude Code, Codex)

  wisdom daemon start|run|status|stop [--data DIR] [--port 7434] [--no-dashboard]
  wisdom dashboard                  Print the live dashboard URL (served on daemon port + 1)
  wisdom track pi [--cwd DIR] [--pi-entry FILE] [-- Pi arguments]
  wisdom track claude [--cwd DIR] [--claude-bin FILE] [-- Claude Code arguments]
  wisdom track codex [--cwd DIR] [--codex-bin FILE] [--setup-hooks | --trust-all-hooks] [-- Codex arguments]
  wisdom resume SESSION-ID           Continue a recorded session in its harness and folder, recording
  wisdom glance [CAPTURE|latest] [--from N] [--at VERSION]
  wisdom open POSITION --capture CAPTURE|latest [--from N] [--at VERSION]
  wisdom mcp [--data DIR]

resume takes the full session ID. CAPTURE also takes its first 8+ characters, or latest. glance without CAPTURE lists recorded sessions. POSITION is t3 (a turn), t3/c2 (a tool call),
a1 (a subagent), a1/c2, or outside. A limited response ends with the request that continues it.
Run: npm.cmd run wisdom -- <command>
`;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const separator = args.indexOf('--');
  const piArgs = separator < 0 ? [] : args.slice(separator + 1);
  const { positionals, values } = parseArgs({ args: separator < 0 ? args : args.slice(0, separator), allowPositionals: true,
    options: {
      data: { type: 'string' }, port: { type: 'string' }, cwd: { type: 'string' }, 'pi-entry': { type: 'string' },
      help: { type: 'boolean' }, capture: { type: 'string' }, from: { type: 'string' }, at: { type: 'string' },
      'claude-bin': { type: 'string' }, 'no-dashboard': { type: 'boolean' }, 'codex-bin': { type: 'string' }, 'setup-hooks': { type: 'boolean' }, 'trust-all-hooks': { type: 'boolean' },
    } });
  const [command, first] = positionals;
  if (!command || values.help) { console.log(help); return; }
  const options: Record<string, string[]> = {
    daemon: ['port', 'no-dashboard'], dashboard: [], track: ['port', 'cwd', 'pi-entry', 'claude-bin', 'codex-bin', 'setup-hooks', 'trust-all-hooks'], mcp: ['port'],
    resume: ['port', 'pi-entry', 'claude-bin', 'codex-bin', 'trust-all-hooks'],
    glance: ['from', 'at'], open: ['capture', 'from', 'at'],
  };
  const allowed = options[command];
  if (!allowed) throw new Error(`Unknown command: ${command}. Run --help.`);
  for (const key of Object.keys(values)) if (key !== 'data' && !allowed.includes(key)) throw new Error(`--${key} is not valid for ${command}`);
  if (separator >= 0 && command !== 'track') throw new Error('Arguments after -- are only supported by track');
  if (positionals.length > (['daemon', 'track', 'resume', 'glance', 'open'].includes(command) ? 2 : 1)) throw new Error('Unexpected positional arguments');

  const dataDir = path.resolve(values.data ?? process.env.WISDOM_DATA_DIR ?? defaultDataDir);
  const port = Number(values.port ?? 7434);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid port');
  if (command === 'daemon') {
    if (first === 'run') {
      // The dashboard listens on the next port; tests and port 0 run without it.
      const daemon = await startDaemon(dataDir, port, { dashboardPort: values['no-dashboard'] || !port ? undefined : port + 1 });
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
  if (command === 'track') { process.exitCode = await track(first, values, piArgs, dataDir, port); return; }
  if (command === 'resume') {
    // The ledger knows the harness, folder and full ID; the harness gets its own resume flag.
    if (!first) throw new Error('Use: wisdom resume SESSION-ID (the full ID; glance lists them)');
    const session = await call(await ensureDaemon(dataDir, port), '/resolve', { session: first });
    const [harness, args] = session.harness === 'pi' ? ['pi', ['--session', session.captureId]]
      : session.harness === 'claude-code' ? ['claude', ['--resume', session.captureId]] : ['codex', ['resume', session.captureId]];
    console.error(`Resuming ${session.harness} session ${session.captureId}`);
    process.exitCode = await track(harness, { ...values, cwd: session.workspaceRoot }, args, dataDir, port); return;
  }
  if (command === 'mcp') { await serveMcp(await ensureDaemon(dataDir, port)); return; }
  // glance and open: the same request an agent sends through MCP, printed as the same text.
  const number = (value?: string) => value === undefined ? undefined : Number(value);
  const reading = { from: number(values.from), at: number(values.at) };
  if (command === 'open' && !first) throw new Error('Use: wisdom open POSITION --capture CAPTURE|latest');
  const input = command === 'glance' ? { capture: first, glance: true, ...reading } : { capture: values.capture, open: first, ...reading };
  console.log((await call(connectionAt(dataDir), '/ledger', input)).text);
}

/** Every tracked harness is spawned here, so its data always lands in Wisdom's
 * data directory. Fail closed: the daemon must be running before the harness starts.
 */
async function track(harness: string | undefined, values: any, args: string[], dataDir: string, port: number): Promise<number> {
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
  if (launch.setupOnly) {
    console.error('Open /hooks in Codex, review and trust the Wisdom hooks, then quit and rerun without --setup-hooks. This setup session is not recorded.');
    const env = { ...process.env, ...launch.env }; delete env.WISDOM_LAUNCH_ID;
    return runHarness(launch, cwd, env);
  }
  const connection = await ensureDaemon(dataDir, port);
  const env: Record<string, string> = { ...process.env as Record<string, string>, ...launch.env,
    WISDOM_DATA_DIR: dataDir, WISDOM_CLI_PATH: cliPath };
  let launchId: string | undefined;
  let heartbeat: NodeJS.Timeout | undefined;
  if (launch.launch) {
    // The capture is chosen when the harness names its session: a resume continues its capture.
    launchId = (await call(connection, '/launches', { ...launch.launch, workspaceRoot: cwd })).launchId as string;
    env.WISDOM_LAUNCH_ID = launchId;
    console.error('Wisdom is recording this session.');
    // The launcher outlives nothing but the harness, so its heartbeat is the harness's.
    heartbeat = setInterval(() => void call(connection, `/launches/${launchId}/heartbeat`, {}).catch(() => {}), 5000);
  }
  let code = 1;
  try { code = await runHarness(launch, cwd, env); return code; }
  finally {
    clearInterval(heartbeat);
    if (launchId) await call(connection, `/launches/${launchId}/close`, { reason: `exit-${code}` })
      .catch(error => console.error(`Wisdom could not close its capture: ${error.message}`));
  }
}

function runHarness(launch: Launch, cwd: string, env: NodeJS.ProcessEnv): Promise<number> {
  const child = spawn(launch.command, launch.args, { cwd, stdio: 'inherit', windowsHide: true, env });
  return new Promise((resolve, reject) => {
    child.once('error', reject); child.once('exit', code => resolve(code ?? 1));
  });
}

main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
