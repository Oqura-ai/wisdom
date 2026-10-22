import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { Captures } from './captures.js';
import { query } from './query.js';
import { openSchema, observationSchema } from './schema.js';
import { writeJson } from './ledger.js';

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
export async function startDaemon(dataDir: string, port = 7434) {
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
  try { captures = new Captures(path.join(dataDir, 'sessions')); }
  catch (error) { fs.unlinkSync(lock); throw error; }
  const token = randomBytes(32).toString('hex');
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
          storage: 'sqlite', queryVersion: 3, readVersion: captures.database.revision }); return;
      }
      if (request.method !== 'POST') { send(404, { error: 'Unknown route' }); return; }
      const input = await body(request);
      if (url.pathname === '/query') { send(200, query(captures, input)); return; }
      if (url.pathname === '/captures') { send(201, captures.open(openSchema.parse(input))); return; }
      if (url.pathname === '/stop') { send(200, { status: 'stopping' }); setImmediate(() => void close()); return; }
      const match = /^\/captures\/([^/]+)\/(observe|heartbeat|close)$/.exec(url.pathname);
      if (!match) { send(404, { error: 'Unknown route' }); return; }
      const [, id, action] = match;
      if (action === 'observe') {
        const record = captures.observe(id, observationSchema.parse(input));
        send(200, { recorded: true, id: record?.id, lastSeq: captures.get(id).lastSeq });
      } else if (action === 'heartbeat') {
        captures.heartbeat(id); send(200, { status: 'recording' });
      } else {
        const reason = typeof (input as any)?.reason === 'string' ? (input as any).reason.slice(0, 200) : 'quit';
        captures.close(id, reason); send(200, { status: captures.get(id).manifest.status });
      }
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
  writeJson(path.join(dataDir, 'daemon.json'), connection);
  timer = setInterval(() => captures.poll(), 500);

  async function close(): Promise<void> {
    if (closing) return closed;
    closing = true;
    clearInterval(timer);
    captures.shutdown();
    await new Promise<void>(resolve => server.close(() => resolve()));
    captures.database.close();
    fs.rmSync(path.join(dataDir, 'daemon.json'), { force: true });
    fs.rmSync(lock, { force: true });
    finish();
  }
  return { connection, captures, close, closed };
}
