#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { call, connectionAt, defaultDataDir, ensureDaemon } from './client.js';
import { startDaemon } from './daemon.js';
import { serveMcp } from './mcp.js';
import { presets, vocabulary } from './vocabulary.js';
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
  wisdom sessions [--limit N] [--cursor TOKEN]
  wisdom intent|timeline|changes|failures|interaction-review [CAPTURE]
  wisdom file-history [CAPTURE] --path FILE
  wisdom inspect CAPTURE RECORD [--section data|patch] [--offset N]
  wisdom query --file request.json
  wisdom vocabulary
  wisdom mcp [--data DIR]

Preset scope: --session ID --workspace DIR, or positional CAPTURE
Preset filters: --path FILE --text PHRASE --tool-name NAME --error --harness pi|claude-code|codex --agent ID|main
Read controls: --limit N --cursor TOKEN --read-version N --max-chars N
Conversation-only output: intent|timeline|interaction-review --clean
All query output is JSON. Run: npm.cmd run wisdom -- <command>
`;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const separator = args.indexOf('--');
  const piArgs = separator < 0 ? [] : args.slice(separator + 1);
  const { positionals, values } = parseArgs({ args: separator < 0 ? args : args.slice(0, separator), allowPositionals: true,
    options: {
      data: { type: 'string' }, port: { type: 'string' }, cwd: { type: 'string' }, 'pi-entry': { type: 'string' },
      clean: { type: 'boolean' }, help: { type: 'boolean' }, text: { type: 'string' }, path: { type: 'string' },
      section: { type: 'string' }, limit: { type: 'string' }, cursor: { type: 'string' }, offset: { type: 'string' },
      'max-chars': { type: 'string' }, file: { type: 'string' }, 'tool-name': { type: 'string' }, error: { type: 'boolean' },
      workspace: { type: 'string' }, session: { type: 'string' }, 'read-version': { type: 'string' },
      'claude-bin': { type: 'string' }, 'no-dashboard': { type: 'boolean' }, 'codex-bin': { type: 'string' }, 'setup-hooks': { type: 'boolean' }, 'trust-all-hooks': { type: 'boolean' },
      harness: { type: 'string' }, agent: { type: 'string' }
    } });
  const [command, first, second] = positionals;
  if (!command || values.help) { console.log(help); return; }
  const preset = Object.hasOwn(presets, command);
  const options: Record<string, string[]> = {
    daemon: ['port', 'no-dashboard'], dashboard: [], track: ['port', 'cwd', 'pi-entry', 'claude-bin', 'codex-bin', 'setup-hooks', 'trust-all-hooks'], mcp: ['port'], vocabulary: [],
    sessions: ['limit', 'cursor'], inspect: ['section', 'offset', 'max-chars', 'read-version'], query: ['file', 'clean'],
  };
  const allowed = preset ? ['session', 'workspace', 'path', 'text', 'tool-name', 'error', 'harness', 'agent', 'limit', 'cursor', 'read-version', 'max-chars', 'clean'] : options[command];
  if (!allowed) throw new Error(`Unknown command: ${command}. Run --help.`);
  for (const key of Object.keys(values)) if (key !== 'data' && !allowed.includes(key)) throw new Error(`--${key} is not valid for ${command}`);
  if (separator >= 0 && command !== 'track') throw new Error('Arguments after -- are only supported by track');
  const maxPositionals = command === 'inspect' ? 3 : ['daemon', 'query', 'track'].includes(command) || preset ? 2 : 1;
  if (positionals.length > maxPositionals) throw new Error('Unexpected positional arguments');
  if (command === 'vocabulary') { print(vocabulary); return; }

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
  if (command === 'mcp') { await serveMcp(await ensureDaemon(dataDir, port)); return; }
  const number = (value?: string) => value === undefined ? undefined : Number(value);
  const limits = { limit: number(values.limit), cursor: values.cursor };
  const evidence = { readVersion: number(values['read-version']), maxChars: number(values['max-chars']) };
  let input: Record<string, unknown>;
  if (command === 'query') {
    if (!!values.file === !!first) throw new Error('Supply exactly one of --file request.json or a JSON argument');
    input = JSON.parse(values.file ? fs.readFileSync(values.file, 'utf8') : first!);
    if (values.clean) input.clean = true;
  } else if (command === 'sessions') input = { op: 'sessions', ...limits };
  else if (command === 'inspect') input = { op: 'inspect', captureId: first, id: second,
    sections: values.section ? [values.section] : ['data'], contentOffset: number(values.offset), ...evidence };
  else input = { preset: command, captureId: first, clean: values.clean, ...limits, ...evidence,
    scope: values.workspace || values.session ? { workspaceRoot: values.workspace,
      sessionIds: values.session ? [values.session] : undefined } : undefined,
    where: { ...(values.path ? { path: values.path } : {}), ...(values.text ? { text: { contains: values.text } } : {}),
      ...(values['tool-name'] ? { 'tool.name': values['tool-name'] } : {}),
      ...(values.error !== undefined ? { 'tool.isError': values.error } : {}),
      ...(values.harness ? { harness: values.harness } : {}),
      ...(values.agent ? { agentId: values.agent === 'main' ? null : values.agent } : {}) } };
  print(await call(connectionAt(dataDir), '/query', input));
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
  const launch: Launch = harness === 'pi' ? launchPi({ entry: values['pi-entry'], args })
    : harness === 'claude' ? launchClaudeCode({ command: values['claude-bin'], args, dataDir, cliPath })
    : harness === 'codex' ? await launchCodex({ command: values['codex-bin'], args, dataDir, cliPath, cwd, setupHooks: values['setup-hooks'], trustAllHooks: values['trust-all-hooks'] })
    : (() => { throw new Error('Use: wisdom track pi|claude|codex'); })();
  if (launch.setupOnly) {
    console.error('Open /hooks in Codex, review and trust the Wisdom hooks, then quit and rerun without --setup-hooks. This setup session is not recorded.');
    const env = { ...process.env }; delete env.WISDOM_CAPTURE_ID;
    return runHarness(launch, cwd, env);
  }
  const connection = await ensureDaemon(dataDir, port);
  const env: Record<string, string> = { ...process.env as Record<string, string>, ...launch.env,
    WISDOM_DATA_DIR: dataDir, WISDOM_CLI_PATH: cliPath };
  let captureId: string | undefined;
  let heartbeat: NodeJS.Timeout | undefined;
  if (launch.capture) {
    captureId = (await call(connection, '/captures', { ...launch.capture, workspaceRoot: cwd, source: null })).captureId as string;
    env.WISDOM_CAPTURE_ID = captureId;
    console.error(`Wisdom capture ${captureId}${harness === 'codex' ? ' (waiting for Codex session identity)' : ''}`);
    // The launcher outlives nothing but the harness, so its heartbeat is the harness's.
    heartbeat = setInterval(() => void call(connection, `/captures/${captureId}/heartbeat`, {}).catch(() => {}), 5000);
  }
  let code = 1;
  try { code = await runHarness(launch, cwd, env); return code; }
  finally {
    clearInterval(heartbeat);
    if (captureId) await call(connection, `/captures/${captureId}/close`, { reason: `exit-${code}` })
      .catch(error => console.error(`Wisdom could not close capture ${captureId}: ${error.message}`));
  }
}

function runHarness(launch: Launch, cwd: string, env: NodeJS.ProcessEnv): Promise<number> {
  const child = spawn(launch.command, launch.args, { cwd, stdio: 'inherit', windowsHide: true, env });
  return new Promise((resolve, reject) => {
    child.once('error', reject); child.once('exit', code => resolve(code ?? 1));
  });
}

main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
