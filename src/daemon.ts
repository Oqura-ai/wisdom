import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { backups, repair, repairTargets, restore } from './repair.js';
import { Captures } from './captures.js';
import { SharedLibrary, readLedger, readView } from './shared.js';
import { hookSchema, viewSchema } from './schema.js';
import { writeJson } from './ledger.js';
import { startDashboard } from './dashboard.js';

/** Bumped when the daemon's contract changes (capture opening or reading). A daemon
 * started from an older build keeps running old code in memory, so clients check this.
 */
// 11: hook events may carry a handoff, and the export view exists.
// 12: /import, and the shared and transcript views.
// 13: the markdown view.
// 15: /delete, /storage, /doctor and /repair.
export const CAPTURE_API = 15;

const cli = fileURLToPath(new URL('./cli.js', import.meta.url));

/** `wisdom doctor --json`, run as its own process: asking each harness its version can take
 * seconds, and the daemon must keep answering hooks meanwhile. One run at a time; its result is
 * reused for 30 seconds unless `fresh` asks for a new one.
 */
function doctor(dataDir: string) {
  let last: { at: number; result: Promise<unknown> } | undefined;
  return (fresh = false): Promise<unknown> => {
    if (last && !fresh && Date.now() - last.at < 30_000) return last.result;
    const result = new Promise<unknown>(resolve => {
      execFile(process.execPath, [cli, 'doctor', '--json'], { env: { ...process.env, WISDOM_DATA_DIR: dataDir }, timeout: 90_000, windowsHide: true },
        // doctor exits 1 when it finds a problem; its report is still on stdout.
        (error, stdout) => {
          try { resolve({ ...JSON.parse(stdout), checkedAt: new Date().toISOString() }); }
          catch { resolve({ error: `wisdom doctor could not run: ${error?.message ?? 'no report'}`, checkedAt: new Date().toISOString() }); }
        });
    });
    last = { at: Date.now(), result };
    return result;
  };
}

/** `plan`: what repair would change, and the backups it can restore. `repair` and `restore` change the files. */
const repairSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('plan') }).strict(),
  z.object({ action: z.literal('repair') }).strict(),
  z.object({ action: z.literal('restore'), backup: z.string().min(1) }).strict(),
]);

function repairs(dataDir: string, input: unknown) {
  const request = repairSchema.parse(input);
  if (request.action === 'repair') return repair(dataDir);
  if (request.action === 'restore') return { restored: restore(dataDir, request.backup) };
  return { targets: repairTargets(dataDir), backups: backups(dataDir) };
}

/** `harnessCopy`: also delete a connected session's files in the person's own harness home.
 * `preview`: delete nothing; say what each deletion would do. */
const deleteSchema = z.object({ sessions: z.array(z.string().min(1)).min(1).max(1000), harnessCopy: z.boolean().optional(),
  preview: z.boolean().optional() }).strict();

/** Each session is deleted on its own: one refused (still recording, unknown) never stops the rest. */
function deleteSessions(captures: Captures, input: unknown) {
  const { sessions, harnessCopy, preview } = deleteSchema.parse(input);
  return { results: sessions.map(session => {
    try { return preview ? captures.removal(session) : captures.remove(session, { harnessCopy }); }
    catch (error) { return { session, error: error instanceof Error ? error.message : String(error) }; }
  }) };
}

export interface Connection { url: string; token: string; pid: number }

async function body(request: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 16 * 1024 * 1024) throw new Error('Request exceeds 16 MiB');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

/** One local process owns SQLite and evidence files. No web framework is needed. */
export async function startDaemon(dataDir: string, port = 7434, options: { dashboardPort?: number } = {}) {
  fs.mkdirSync(dataDir, { recursive: true });
  const lock = path.join(dataDir, 'daemon.lock');
  if (fs.existsSync(lock)) {
    const pid = Number(fs.readFileSync(lock, 'utf8'));
    let alive = false;
    if (Number.isInteger(pid) && pid > 0) {
      try { process.kill(pid, 0); alive = true; } catch (error: any) { if (error.code === 'EPERM') alive = true; }
    }
    if (alive) throw new Error(`Daemon already owns this data directory (PID ${pid}).`);
    fs.unlinkSync(lock);
  }
  fs.writeFileSync(lock, String(process.pid), { flag: 'wx' });
  let captures: Captures;
  try { captures = new Captures(dataDir); }
  catch (error) { fs.unlinkSync(lock); throw error; }
  const library = new SharedLibrary(path.join(dataDir, 'shared'));
  const checks = doctor(dataDir);
  const token = randomBytes(32).toString('hex');
  let dashboard: ReturnType<typeof startDashboard> | undefined;
  let closing = false;
  let timer: NodeJS.Timeout;
  let finish!: () => void;
  const closed = new Promise<void>(resolve => { finish = resolve; });
  const server = http.createServer(async (request, response) => {
    const send = (status: number, data: unknown) => {
      response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify(data));
    };
    if (request.headers.authorization !== `Bearer ${token}`) { send(401, { error: 'Local daemon token required' }); return; }
    if (closing) { send(503, { error: 'Daemon is stopping' }); return; }
    try {
      const url = new URL(request.url ?? '/', 'http://localhost');
      if (request.method === 'GET' && url.pathname === '/health') {
        send(200, { status: 'running', pid: process.pid, captures: captures.ledgers.size,
          storage: 'sqlite', captureApi: CAPTURE_API, readVersion: captures.database.revision,
          dashboard: dashboard?.state() ?? { status: 'unavailable', reason: 'Not started with this daemon.' } }); return;
      }
      if (request.method !== 'POST') { send(404, { error: 'Unknown route' }); return; }
      const input = await body(request);
      if (url.pathname === '/ledger') { send(200, { text: readLedger(captures, library, input) }); return; }
      if (url.pathname === '/view') { send(200, readView(captures, library, viewSchema.parse(input))); return; }
      if (url.pathname === '/import') { send(200, importShare(captures, library, input)); return; }
      // Every hook and the Pi extension: the session the event names picks its record.
      if (url.pathname === '/observe') {
        const record = captures.route(hookSchema.parse(input));
        send(200, { recorded: !!record, id: record?.id, captureId: record?.captureId }); return;
      }
      if (url.pathname === '/resolve') {
        // Resuming starts a harness, so it takes the exact session ID only: never a guess.
        const { captureId, harness, workspaceRoot, source } = captures.get(String((input as any)?.session ?? '')).manifest;
        send(200, { captureId, harness, workspaceRoot, source }); return;
      }
      if (url.pathname === '/delete') { send(200, deleteSessions(captures, input)); return; }
      if (url.pathname === '/storage') { send(200, captures.storage()); return; }
      if (url.pathname === '/doctor') { send(200, await checks((input as any)?.fresh === true)); return; }
      if (url.pathname === '/repair') {
        const result = repairs(dataDir, input);
        if ((input as any)?.action !== 'plan') void checks(true);
        send(200, result); return;
      }
      if (url.pathname === '/stop') { send(200, { status: 'stopping' }); setImmediate(() => void close()); return; }
      send(404, { error: 'Unknown route' });
    } catch (error) { send(400, { error: error instanceof Error ? error.message : String(error) }); }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject); server.listen(port, '127.0.0.1', resolve);
    });
  } catch (error) { captures.shutdown(); captures.database.close(); fs.unlinkSync(lock); throw error; }
  const address = server.address() as { port: number };
  const connection: Connection = { url: `http://127.0.0.1:${address.port}`, token, pid: process.pid };
  // Once the port is held, and before daemon.json says so: the hook that started this daemon
  // waits for that file, so the file baseline of a kept tool start is taken before the tool runs.
  captures.drainSpool();
  writeJson(path.join(dataDir, 'daemon.json'), connection);
  timer = setInterval(() => { captures.poll(); library.poll(); }, 500);
  // Optional viewer. Started after daemon.json exists, since it reads it to connect.
  if (options.dashboardPort) dashboard = startDashboard(dataDir, options.dashboardPort);

  async function close(): Promise<void> {
    if (closing) return closed;
    closing = true;
    clearInterval(timer);
    dashboard?.close();
    captures.shutdown();
    await new Promise<void>(resolve => server.close(() => resolve()));
    captures.database.close();
    library.close();
    fs.rmSync(path.join(dataDir, 'daemon.json'), { force: true });
    fs.rmSync(lock, { force: true });
    finish();
  }
  return { connection, captures, close, closed };
}

/** Import a share file named by an absolute path. Sessions also recorded here are named,
 * because this project's own recording is the one every read shows.
 */
function importShare(captures: Captures, library: SharedLibrary, input: unknown) {
  const file = (input as { file?: unknown })?.file;
  if (typeof file !== 'string' || !path.isAbsolute(file)) throw new Error('Name the share file by its full path.');
  const { store, added } = library.import(file);
  const own = new Set(captures.database.manifests().map(manifest => manifest.captureId));
  const sessions = library.sessions().filter(session => store.ids.includes(session.captureId));
  return { added, shared: store.shared, sessions, alsoRecordedHere: sessions.map(s => s.captureId).filter(id => own.has(id)) };
}
