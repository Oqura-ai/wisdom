import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
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
export const CAPTURE_API = 12;

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
        const { captureId, harness, workspaceRoot } = captures.get(String((input as any)?.session ?? '')).manifest;
        send(200, { captureId, harness, workspaceRoot }); return;
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
