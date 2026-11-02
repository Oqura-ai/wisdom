import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { CAPTURE_API, type Connection } from './daemon.js';
import { spoolDir } from './paths.js';
import type { HookEvent } from './schema.js';

export function connectionAt(dataDir: string): Connection {
  const file = path.join(dataDir, 'daemon.json');
  if (!fs.existsSync(file)) throw new Error('Wisdom daemon is not running. Run: wisdom daemon start');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export async function call(connection: Connection, route: string, input?: unknown, timeoutMs = 30000): Promise<any> {
  let response: Response;
  try {
    response = await fetch(connection.url + route, {
      method: input === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${connection.token}`, 'Content-Type': 'application/json' },
      body: input === undefined ? undefined : JSON.stringify(input),
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (error: any) {
    if (error?.name === 'TimeoutError') throw error;
    throw new Error(`Wisdom daemon is not answering at ${connection.url}. Run: wisdom daemon start`);
  }
  const result = await response.json() as any;
  if (!response.ok) throw new Error(result.error ?? `Daemon returned HTTP ${response.status}`);
  return result;
}

/** How every hook reports. Live when the daemon answers; otherwise the event is kept in
 * the spool and the daemon is started, so nothing waits on Wisdom and nothing is lost.
 * A spooled event that was in fact recorded is recognized by its observation ID.
 */
export async function deliver(dataDir: string, event: HookEvent, timeoutMs = 10000): Promise<{ spooled?: string }> {
  try { await call(connectionAt(dataDir), '/observe', event, timeoutMs); return {}; }
  catch (error) {
    spool(dataDir, event);
    await ensureDaemon(dataDir).catch(() => { /* The spool waits for the next start. */ });
    return { spooled: error instanceof Error ? error.message : String(error) };
  }
}

/** One file per event, named so that a session's events sort in the order they were kept. */
export function spool(dataDir: string, event: HookEvent): void {
  const session = /^[A-Za-z0-9_-]+$/.test(event.observation.sessionId) ? event.observation.sessionId : '_unnamed';
  const folder = path.join(spoolDir(dataDir), event.harness, session);
  fs.mkdirSync(folder, { recursive: true });
  const file = path.join(folder, `${String(Date.now()).padStart(15, '0')}-${process.hrtime.bigint()}-${randomUUID()}`);
  fs.writeFileSync(file + '.tmp', JSON.stringify({ ...event, late: { spooledAt: new Date().toISOString() } }));
  fs.renameSync(file + '.tmp', file + '.json');
}

export async function ensureDaemon(dataDir: string, port?: number, dashboard = true): Promise<Connection> {
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
  const child = spawn(process.execPath, [fileURLToPath(new URL('./cli.js', import.meta.url)), 'daemon', 'run', '--data', dataDir,
    ...(port === undefined ? [] : ['--port', String(port)]), ...(dashboard ? [] : ['--no-dashboard'])], {
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
