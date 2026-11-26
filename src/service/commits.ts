import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** Where the Commits server says it is listening, for `wisdom commits` and the daemon's health. */
export const commitsStateFile = (dataDir: string) => path.join(dataDir, 'commits.json');

export type CommitsState = { url?: string; status: 'starting' | 'running' | 'exited'; log: string } | { status: 'unavailable'; reason: string };

const bundled = fileURLToPath(new URL('../../../dist-commits/', import.meta.url));
const server = fileURLToPath(new URL('../visualizer/serve.js', import.meta.url));

/** Local Commits (design policy 5.19, 5.20): the Commits app over this machine, built ahead of
 * time into dist-commits/. Started by the daemon on its own port, like the Usage dashboard, and
 * like it never affects recording: if it is missing or cannot start, capture continues. Its
 * address is the one it wrote once listening (it moves up when its port is taken).
 */
export function startCommits(dataDir: string, port: number, app = bundled): { state: () => CommitsState; close: () => void } {
  if (!fs.existsSync(path.join(app, 'index.html'))) return {
    state: () => ({ status: 'unavailable', reason: 'Commits is missing from this copy of Wisdom. Reinstall the package; in a clone, run npm run commits:install, then npm run commits:build.' }),
    close: () => {},
  };
  const log = path.join(dataDir, 'commits.log');
  const out = fs.openSync(log, 'a');
  let status: 'starting' | 'running' | 'exited' = 'starting';
  fs.rmSync(commitsStateFile(dataDir), { force: true });
  const child: ChildProcess = spawn(process.execPath, [server], {
    windowsHide: true, stdio: ['ignore', out, out],
    env: { ...process.env, PORT: String(port), WISDOM_DATA_DIR: dataDir, WISDOM_COMMITS_APP: app, WISDOM_DAEMON_PID: String(process.pid) },
  });
  fs.closeSync(out);
  child.once('spawn', () => { status = 'running'; });
  child.once('exit', () => { status = 'exited'; });
  child.once('error', error => { status = 'exited'; fs.appendFileSync(log, `spawn error: ${error.message}\n`); });
  const url = () => { try { return JSON.parse(fs.readFileSync(commitsStateFile(dataDir), 'utf8')).url as string; } catch { return undefined; } };
  return { state: () => ({ url: status === 'exited' ? undefined : url(), status, log }), close: () => { if (status !== 'exited') child.kill(); } };
}
