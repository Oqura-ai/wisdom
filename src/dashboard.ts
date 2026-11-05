import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export type DashboardState = { url: string; status: 'starting' | 'running' | 'exited'; log: string } | { status: 'unavailable'; reason: string };

const bundled = fileURLToPath(new URL('../../dist-dashboard/', import.meta.url));

/** The viewer, built ahead of time into dist-dashboard/. The daemon starts it, and it never
 * affects recording: if it is missing or cannot start, capture continues.
 */
export function startDashboard(dataDir: string, port: number, root = bundled): { state: () => DashboardState; close: () => void } {
  const server = path.join(root, 'server.js');
  if (!fs.existsSync(server)) return unavailable('The dashboard is missing from this copy of Wisdom. Reinstall the package; in a clone, run npm run dashboard:install, then npm run dashboard:build.');
  const log = path.join(dataDir, 'dashboard.log');
  const out = fs.openSync(log, 'a');
  let status: 'starting' | 'running' | 'exited' = 'starting';
  // Loopback only; the dashboard serves unredacted evidence.
  const child: ChildProcess = spawn(process.execPath, [server], {
    cwd: root, windowsHide: true, stdio: ['ignore', out, out],
    env: { ...process.env, PORT: String(port), HOSTNAME: '127.0.0.1', WISDOM_DATA_DIR: dataDir, WISDOM_DAEMON_PID: String(process.pid), NEXT_TELEMETRY_DISABLED: '1' },
  });
  fs.closeSync(out);
  child.once('spawn', () => { status = 'running'; });
  child.once('exit', () => { status = 'exited'; });
  child.once('error', error => { status = 'exited'; fs.appendFileSync(log, `spawn error: ${error.message}\n`); });
  const url = `http://127.0.0.1:${port}`;
  return { state: () => ({ url, status, log }), close: () => { if (status !== 'exited') child.kill(); } };
}

function unavailable(reason: string) {
  return { state: (): DashboardState => ({ status: 'unavailable', reason }), close: () => {} };
}
