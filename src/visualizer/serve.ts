/**
 * Local Commits, served: the Commits app (a static export) and this machine's data beside it,
 * on loopback. It runs as its own process, started by the daemon like the Usage dashboard, so a
 * build never holds up a hook: it reads recordings through ReadStore, never the daemon's store.
 *
 * Live: every two seconds it compares branch tips, Wisdom's refs and each session's newest
 * record with the last build, and builds again when any moved. The app swaps a new build in.
 *
 * Run as `node serve.js` with WISDOM_DATA_DIR, PORT (the first port to try), WISDOM_COMMITS_APP
 * (the app's files) and WISDOM_DAEMON_PID (it exits when that process is gone).
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { topLevel } from '../team/gitrefs.js';
import { ReadStore } from '../storage/readstore.js';
import { commitsStateFile } from '../service/commits.js';
import { buildLocal, commitsDataDir, localSignature } from './local.js';

const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8' };

/** The file under `root` a request path names, or undefined if it would leave `root`. */
function inside(root: string, request: string): string | undefined {
  const file = path.resolve(root, '.' + path.posix.normalize('/' + request));
  return file === root || file.startsWith(root + path.sep) ? file : undefined;
}

export async function serveCommits(dataDir: string, firstPort: number, app: string): Promise<{ url: string; close: () => Promise<void> }> {
  const project = (() => { try { return topLevel(path.dirname(dataDir)); } catch { return path.dirname(dataDir); } })();
  const data = commitsDataDir(dataDir);
  let port = 0;

  const server = http.createServer((request, response) => {
    // Loopback only, and only under its own name: a page elsewhere cannot read unredacted
    // sessions through a hostname that points here (DNS rebinding).
    const host = request.headers.host ?? '';
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) { response.writeHead(403).end(); return; }
    if (request.method !== 'GET' && request.method !== 'HEAD') { response.writeHead(405).end(); return; }
    const url = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname);
    const fromData = url.startsWith('/data/');
    let file = fromData ? inside(data, url.slice('/data/'.length)) : inside(app, url === '/' ? 'index.html' : url.slice(1));
    // The app routes in its hash, so every page is index.html; a missing asset is a 404.
    if (!fromData && file && !fs.existsSync(file) && !path.extname(file)) file = path.join(app, 'index.html');
    let body: Buffer;
    try { if (!file) throw new Error('outside'); body = fs.readFileSync(file); }
    catch { response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }).end(fromData ? 'Not in this build' : 'Not found'); return; }
    response.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream',
      'Cache-Control': fromData || file.endsWith('.html') ? 'no-store' : 'public, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff' });
    response.end(request.method === 'HEAD' ? undefined : body);
  });

  // Its own port, or the next free one: another project's daemon may hold it.
  for (let candidate = firstPort; ; candidate++) {
    try {
      await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(candidate, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); }); });
      port = (server.address() as { port: number }).port; break;
    } catch (error: any) { if (error?.code !== 'EADDRINUSE' || candidate >= firstPort + 20) throw error; }
  }
  fs.writeFileSync(commitsStateFile(dataDir), JSON.stringify({ url: `http://127.0.0.1:${port}`, pid: process.pid }));

  // Build now, then whenever something it reads moved. One build at a time; a failed one is
  // logged and tried again on the next change.
  const store = new ReadStore(dataDir);
  let last = '';
  const tick = () => {
    let signature: string;
    try { signature = localSignature(project, store); } catch (error) { console.error(`Could not read this project: ${message(error)}`); return; }
    if (signature === last) return;
    const started = Date.now();
    try {
      const built = buildLocal(project, dataDir);
      last = signature;
      if (built) console.error(`${new Date().toISOString()} built ${built.made} files, reused ${built.reused}, in ${Date.now() - started} ms`);
    } catch (error) { console.error(`${new Date().toISOString()} build failed: ${message(error)}`); last = signature; }
  };
  tick();
  const timer = setInterval(tick, 2000);
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>(resolve => {
      clearInterval(timer); store.close(); fs.rmSync(commitsStateFile(dataDir), { force: true });
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}

const message = (error: unknown) => error instanceof Error ? error.message : String(error);

// Run as a process: started by the daemon (service/commits.ts).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dataDir = process.env.WISDOM_DATA_DIR, app = process.env.WISDOM_COMMITS_APP;
  if (!dataDir || !app) { console.error('WISDOM_DATA_DIR and WISDOM_COMMITS_APP are needed.'); process.exit(2); }
  const server = await serveCommits(dataDir, Number(process.env.PORT) || 7436, path.resolve(app));
  const pid = Number(process.env.WISDOM_DAEMON_PID);
  if (Number.isInteger(pid) && pid > 0) setInterval(() => {
    try { process.kill(pid, 0); } catch (error: any) { if (error?.code !== 'EPERM') void server.close().then(() => process.exit(0)); }
  }, 2000).unref();
  const stop = () => void server.close().then(() => process.exit(0));
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
}
