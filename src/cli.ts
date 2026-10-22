#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { call, connectionAt, defaultDataDir, ensureDaemon } from './client.js';
import { startDaemon } from './daemon.js';
import { serveMcp } from './mcp.js';
import { presets, vocabulary } from './vocabulary.js';

const print = (value: unknown) => console.log(JSON.stringify(value, null, 2));
const help = `Wisdom — live Pi evidence

  wisdom daemon start|run|status|stop [--data DIR] [--port 7434]
  wisdom track [--cwd DIR] [--pi-entry FILE] [-- Pi arguments]
  wisdom sessions [--limit N] [--cursor TOKEN]
  wisdom intent|timeline|changes|failures|interaction-review [CAPTURE]
  wisdom file-history [CAPTURE] --path FILE
  wisdom inspect CAPTURE RECORD [--section data|patch] [--offset N]
  wisdom query --file request.json
  wisdom vocabulary
  wisdom mcp [--data DIR]

Preset scope: --session ID --workspace DIR, or positional CAPTURE
Preset filters: --path FILE --text PHRASE --tool-name NAME --error
Read controls: --limit N --cursor TOKEN --read-version N --max-chars N
Conversation-only output: intent|timeline|interaction-review --clean
All query output is JSON. Run: npm.cmd run wisdom -- <command>
`;

/** Reuse the user's Pi installation; do not install another agent. */
function piEntry(explicit?: string): string {
  if (explicit) return path.resolve(explicit);
  const root = path.join(os.homedir(), '.pi', 'agent', 'install');
  const version = fs.readFileSync(path.join(root, 'current-version'), 'utf8').trim();
  if (!/^[a-zA-Z0-9._-]+$/.test(version) || version === '..') throw new Error('Invalid managed Pi version');
  const pkg = path.join(root, 'releases', version, 'node_modules', '@earendil-works', 'pi-coding-agent');
  const metadata = JSON.parse(fs.readFileSync(path.join(pkg, 'package.json'), 'utf8'));
  return path.join(pkg, typeof metadata.bin === 'string' ? metadata.bin : metadata.bin.pi);
}

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
      workspace: { type: 'string' }, session: { type: 'string' }, 'read-version': { type: 'string' }
    } });
  const [command, first, second] = positionals;
  if (!command || values.help) { console.log(help); return; }
  const preset = Object.hasOwn(presets, command);
  const options: Record<string, string[]> = {
    daemon: ['port'], track: ['port', 'cwd', 'pi-entry'], mcp: ['port'], vocabulary: [],
    sessions: ['limit', 'cursor'], inspect: ['section', 'offset', 'max-chars', 'read-version'], query: ['file', 'clean'],
  };
  const allowed = preset ? ['session', 'workspace', 'path', 'text', 'tool-name', 'error', 'limit', 'cursor', 'read-version', 'max-chars', 'clean'] : options[command];
  if (!allowed) throw new Error(`Unknown command: ${command}. Run --help.`);
  for (const key of Object.keys(values)) if (key !== 'data' && !allowed.includes(key)) throw new Error(`--${key} is not valid for ${command}`);
  if (separator >= 0 && command !== 'track') throw new Error('Arguments after -- are only supported by track');
  const maxPositionals = command === 'inspect' ? 3 : ['daemon', 'query'].includes(command) || preset ? 2 : 1;
  if (positionals.length > maxPositionals) throw new Error('Unexpected positional arguments');
  if (command === 'vocabulary') { print(vocabulary); return; }

  const dataDir = path.resolve(values.data ?? process.env.WISDOM_DATA_DIR ?? defaultDataDir);
  const port = Number(values.port ?? 7434);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid port');
  if (command === 'daemon') {
    if (first === 'run') {
      const daemon = await startDaemon(dataDir, port);
      console.error(`Wisdom listening at ${daemon.connection.url}; data: ${dataDir}`);
      const stop = () => void daemon.close();
      process.once('SIGINT', stop); process.once('SIGTERM', stop);
      await daemon.closed;
      process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
    } else if (first === 'start') {
      const connection = await ensureDaemon(dataDir, port);
      console.log(`Wisdom running at ${connection.url} (PID ${connection.pid})`);
    } else if (first === 'status') print(await call(connectionAt(dataDir), '/health'));
    else if (first === 'stop') print(await call(connectionAt(dataDir), '/stop', {}));
    else throw new Error('Use daemon start, run, status, or stop');
    return;
  }
  if (command === 'track') {
    await ensureDaemon(dataDir, port);
    const child = spawn(process.execPath, [piEntry(values['pi-entry']), '--extension',
      fileURLToPath(new URL('./pi-extension.js', import.meta.url)), '--skill',
      fileURLToPath(new URL('../../skills/wisdom-ledger', import.meta.url)), ...piArgs], {
      cwd: path.resolve(values.cwd ?? process.cwd()), stdio: 'inherit', windowsHide: true,
      env: { ...process.env, WISDOM_DATA_DIR: dataDir, WISDOM_CLI_PATH: fileURLToPath(new URL('./cli.js', import.meta.url)) }
    });
    process.exitCode = await new Promise<number>((resolve, reject) => {
      child.once('error', reject); child.once('exit', code => resolve(code ?? 1));
    });
    return;
  }
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
      ...(values.error !== undefined ? { 'tool.isError': values.error } : {}) } };
  print(await call(connectionAt(dataDir), '/query', input));
}

main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
