/**
 * A deployable Commits site: the app, its data, and (unless the dashboard is public on purpose)
 * the gate in front of the data. Written for a host by an adapter; Vercel's is here, in the
 * Build Output API layout `vercel deploy --prebuilt` uploads (checked live, commits-build-plan.md):
 *
 *   .vercel/output/config.json                 /data/* and /auth/* go to the gate
 *   .vercel/output/static/                     the app: public files, never any data
 *   .vercel/output/functions/gate.func/        the gate, with the data inside it: files there are
 *                                              never served directly, only read by its code
 *
 * Public (`gate: 'public'`): no function, the data beside the app as plain files. Only ever when
 * asked for (policy 5.24): it is never what a private repository gets by default.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { GateConfig } from './gate.js';

/** Vercel's limit on one function's files, uncompressed (live-checked docs, 2026-11-26), less room for the gate. */
export const FUNCTION_LIMIT = 240 * 1024 * 1024;
/** The Node runtime the gate runs on (the one the live test deployed with). */
export const RUNTIME = 'nodejs22.x';

const gateSource = fileURLToPath(new URL('./gate.js', import.meta.url));

export class TooBig extends Error {}

/** The adapter that runs the gate on Vercel: its request and response in, a file streamed out. */
const ADAPTER = `// Written by Wisdom (src/visualizer/site.ts): runs the gate (gate.mjs) on Vercel.
import fs from 'node:fs';
import { gate } from './gate.mjs';

const config = JSON.parse(fs.readFileSync(new URL('./gate.json', import.meta.url), 'utf8'));
const data = new URL('./data/', import.meta.url);

export default async function handler(req, res) {
  let answer;
  try {
    answer = await gate({ method: req.method, url: req.url, headers: req.headers }, config, {
      clientId: process.env.WISDOM_GITHUB_CLIENT_ID ?? '', clientSecret: process.env.WISDOM_GITHUB_CLIENT_SECRET ?? '',
      cookieKey: process.env.WISDOM_COOKIE_KEY ?? '' });
  } catch (error) {
    // A missing or wrong secret: say what is wrong, show nothing.
    res.statusCode = 500; res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end('This dashboard is not set up right: ' + error.message + ' Run wisdom commits deploy again.'); return;
  }
  for (const [name, value] of Object.entries(answer.headers)) res.setHeader(name, value);
  if (answer.file === undefined) { res.statusCode = answer.status; res.end(req.method === 'HEAD' ? undefined : answer.body); return; }
  // Streamed, so a big turn is not held to Vercel's 4.5 MB limit on a whole response.
  const file = new URL(answer.file, data);
  fs.stat(file, (error, stat) => {
    if (error || !stat.isFile()) { res.statusCode = 404; res.setHeader('Content-Type', 'text/plain; charset=utf-8'); res.end('Not in this build'); return; }
    res.statusCode = 200; res.setHeader('Content-Length', String(stat.size));
    if (req.method === 'HEAD') { res.end(); return; }
    fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
  });
}
`;

function size(dir: string): number {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) if (entry.isFile()) total += fs.statSync(path.join(entry.parentPath, entry.name)).size;
  return total;
}

/** Write a Vercel site into `out` (its `.vercel/output`), from the app (dist-commits/) and one build's data. */
export function writeVercelSite(out: string, options: { app: string; data: string; gate: GateConfig | 'public'; limit?: number }): { files: number; dataBytes: number } {
  const { app, data } = options;
  if (!fs.existsSync(path.join(app, 'index.html'))) throw new Error(`${app} holds no Commits app: run npm run commits:build (a published Wisdom carries it as dist-commits/).`);
  if (!fs.existsSync(path.join(data, 'manifest.json'))) throw new Error(`${data} holds no Commits build (no manifest.json).`);
  const dataBytes = size(data);
  const limit = options.limit ?? FUNCTION_LIMIT;
  if (options.gate !== 'public' && dataBytes > limit) throw new TooBig(`This repository's Commits data is ${(dataBytes / 1048576).toFixed(0)} MB, more than one Vercel function can hold (${(limit / 1048576).toFixed(0)} MB). `
    + 'Faster, separate storage for sessions is part of the enterprise offering; meanwhile, fewer or shorter sessions on the remote (wisdom team prune) bring it down.');

  const output = path.join(out, '.vercel', 'output');
  fs.rmSync(output, { recursive: true, force: true });
  const statics = path.join(output, 'static');
  // The app's own files; a stray data/ folder in it (sample data) never ships.
  fs.cpSync(app, statics, { recursive: true, filter: source => path.relative(app, source).split(path.sep)[0] !== 'data' });

  if (options.gate === 'public') {
    fs.cpSync(data, path.join(statics, 'data'), { recursive: true });
    fs.writeFileSync(path.join(output, 'config.json'), JSON.stringify({ version: 3 }, null, 2));
  } else {
    const fn = path.join(output, 'functions', 'gate.func');
    fs.mkdirSync(fn, { recursive: true });
    fs.copyFileSync(gateSource, path.join(fn, 'gate.mjs'));
    fs.writeFileSync(path.join(fn, 'index.mjs'), ADAPTER);
    fs.writeFileSync(path.join(fn, 'gate.json'), JSON.stringify(options.gate));
    fs.writeFileSync(path.join(fn, '.vc-config.json'), JSON.stringify({ runtime: RUNTIME, handler: 'index.mjs', launcherType: 'Nodejs', shouldAddHelpers: false }, null, 2));
    fs.cpSync(data, path.join(fn, 'data'), { recursive: true });
    fs.writeFileSync(path.join(output, 'config.json'), JSON.stringify({ version: 3, routes: [
      // Every data and sign-in address is the gate's; nothing there is a file anyone can fetch.
      { src: '^/(?:data|auth)(?:/.*)?$', dest: '/gate' },
    ] }, null, 2));
  }
  const files = fs.readdirSync(output, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile()).length;
  return { files, dataBytes };
}
