import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { CAPTURE_API, type Connection } from './daemon.js';

// This file runs from dist/src. Storage belongs to Wisdom's root, even when the harness's
// working directory is a different project.
export const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
export const defaultDataDir = path.join(projectRoot, '.wisdom');

export function connectionAt(dataDir: string): Connection {
  const file = path.join(dataDir, 'daemon.json');
  if (!fs.existsSync(file)) throw new Error('Wisdom daemon is not running. Run: npm run wisdom -- daemon start');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export async function call(connection: Connection, route: string, input?: unknown, timeoutMs = 30000): Promise<any> {
  const response = await fetch(connection.url + route, {
    method: input === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${connection.token}`, 'Content-Type': 'application/json' },
    body: input === undefined ? undefined : JSON.stringify(input),
    signal: AbortSignal.timeout(timeoutMs)
  });
  const result = await response.json() as any;
  if (!response.ok) throw new Error(result.error ?? `Daemon returned HTTP ${response.status}`);
  return result;
}

export async function ensureDaemon(dataDir: string, port = 7434, dashboard = true): Promise<Connection> {
  const connect = async (): Promise<{ connection: Connection; health: any } | undefined> => {
    try { const connection = connectionAt(dataDir); return { connection, health: await call(connection, '/health') }; }
    catch { return undefined; }
  };
  const existing = await connect();
  if (existing) {
    if (existing.health.captureApi !== CAPTURE_API) throw new Error(`The running Wisdom daemon (PID ${existing.connection.pid}) is from an older build. `
      + 'Stop it with `wisdom daemon stop` (any active recording becomes interrupted), then retry.');
    return existing.connection;
  }
  fs.mkdirSync(dataDir, { recursive: true });
  const log = fs.openSync(path.join(dataDir, 'daemon.log'), 'a');
  const child = spawn(process.execPath, [fileURLToPath(new URL('./cli.js', import.meta.url)), 'daemon', 'run', '--data', dataDir, '--port', String(port), ...(dashboard ? [] : ['--no-dashboard'])], {
    detached: true, windowsHide: true, stdio: ['ignore', log, log]
  });
  child.unref(); fs.closeSync(log);
  let spawnError: Error | undefined;
  child.once('error', error => { spawnError = error; });
  for (let attempt = 0; attempt < 100; attempt++) {
    if (spawnError) throw spawnError;
    const started = await connect();
    if (started) return started.connection;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Daemon did not start. Read ${path.join(dataDir, 'daemon.log')}`);
}
