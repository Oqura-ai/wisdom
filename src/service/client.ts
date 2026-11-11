import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { CAPTURE_API, type Connection } from './daemon.js';
import { spoolDir } from '../core/paths.js';
import { handoffSchema, type Handoff, type HookEvent } from '../core/schema.js';

export function connectionAt(dataDir: string): Connection {
  const file = path.join(dataDir, 'daemon.json');
  if (!fs.existsSync(file)) throw new Error('Wisdom daemon is not running. Run: wisdom daemon start');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export async function call(connection: Connection, route: string, input?: unknown, timeoutMs = 30000): Promise<any> {
  let response: Response | undefined;
  for (let attempt = 0; !response; attempt++) {
    try {
      response = await fetch(connection.url + route, {
        method: input === undefined ? 'GET' : 'POST',
        headers: { Authorization: `Bearer ${connection.token}`, 'Content-Type': 'application/json' },
        body: input === undefined ? undefined : JSON.stringify(input),
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (error: any) {
      if (error?.name === 'TimeoutError') throw error;
      // A kept-alive connection the daemon closed while it was busy fails before any answer;
      // the request never reached it, so sending it again on a new connection is safe.
      const code = error?.cause?.code;
      if (attempt === 0 && (code === 'UND_ERR_SOCKET' || code === 'ECONNRESET')) continue;
      throw new Error(`Wisdom daemon is not answering at ${connection.url}. Run: wisdom daemon start`);
    }
  }
  const result = await response.json() as any;
  if (!response.ok) throw new Error(result.error ?? `Daemon returned HTTP ${response.status}`);
  return result;
}

/** The handoff `wisdom handoff` set on this harness process, if any. A value that does not
 * parse is ignored: recording never depends on it.
 */
export function handoffFromEnv(env: NodeJS.ProcessEnv = process.env): { handoff: Handoff } | {} {
  try { return env.WISDOM_HANDOFF ? { handoff: handoffSchema.parse(JSON.parse(env.WISDOM_HANDOFF)) } : {}; }
  catch { return {}; }
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

/** Start the daemon so it outlives whatever started it. On Windows a child of Node inherits
 * every inheritable handle, including a hook's output pipe: Codex then waits for that pipe
 * until its hook timeout, and kills the child. Measured with real Codex hooks on 0.164:
 * `spawn` and `cmd /c start` hang and die; `Start-Process` returns at once and survives.
 */
export function startDetached(args: string[], logFile: string): void {
  if (process.platform === 'win32') {
    const line = [process.execPath, ...args].map(arg => `"${arg}"`).join(' ') + ` >> "${logFile}" 2>&1`;
    const script = `Start-Process -WindowStyle Hidden -FilePath $env:ComSpec -ArgumentList '/d /s /c "${line.replaceAll("'", "''")}"'`;
    const started = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
    if (started.status !== 0) throw new Error(`Could not start a Wisdom background process (${started.stderr || started.error}). A sandboxed agent may not be allowed to; run wisdom daemon start outside the sandbox.`);
    return;
  }
  const log = fs.openSync(logFile, 'a');
  spawn(process.execPath, args, { detached: true, stdio: ['ignore', log, log] }).unref();
  fs.closeSync(log);
}

export async function ensureDaemon(dataDir: string, port?: number, dashboard = true): Promise<Connection> {
  const connect = async (): Promise<{ connection: Connection; health: any } | undefined> => {
    try { const connection = connectionAt(dataDir); return { connection, health: await call(connection, '/health') }; }
    catch { return undefined; }
  };
  const existing = await connect();
  if (existing) {
    const running = Number(existing.health.captureApi);
    // Either side can be the older one: a daemon left running after an upgrade, or an older
    // `wisdom` command (a global install) next to a daemon started from a newer build.
    if (running < CAPTURE_API) throw new Error(`The running Wisdom daemon (PID ${existing.connection.pid}) is from an older build. `
      + 'Stop it with `wisdom daemon stop` (any active recording becomes interrupted), then retry.');
    if (running !== CAPTURE_API) throw new Error(`This wisdom command (${fileURLToPath(new URL('../cli.js', import.meta.url))}) is older than the running daemon `
      + `(PID ${existing.connection.pid}). Use the copy that started the daemon, or update this one: npm install -g @oqura/wisdom@latest`);
    return existing.connection;
  }
  fs.mkdirSync(dataDir, { recursive: true });
  startDetached([fileURLToPath(new URL('../cli.js', import.meta.url)), 'daemon', 'run', '--data', dataDir,
    ...(port === undefined ? [] : ['--port', String(port)]), ...(dashboard ? [] : ['--no-dashboard'])], path.join(dataDir, 'daemon.log'));
  for (let attempt = 0; attempt < 100; attempt++) {
    const started = await connect();
    if (started) return started.connection;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Daemon did not start. Read ${path.join(dataDir, 'daemon.log')}`);
}
