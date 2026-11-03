import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export type DashboardState = { url: string; status: 'starting' | 'running' | 'exited'; log: string } | { status: 'unavailable'; reason: string };

/** The optional Next.js viewer in dashboard/. The daemon starts it, and it never
 * affects recording: if it is not built or cannot start, capture continues.
 */
export function startDashboard(dataDir: string, port: number): { state: () => DashboardState; close: () => void } {
  const root = fileURLToPath(new URL('../../dashboard/', import.meta.url));
  const next = path.join(root, 'node_modules', 'next', 'dist', 'bin', 'next');
  if (!fs.existsSync(next)) return unavailable('Dashboard dependencies are not installed. Run: npm run dashboard:install');
  if (!fs.existsSync(path.join(root, '.next', 'BUILD_ID'))) return unavailable('Dashboard is not built. Run: npm run dashboard:build');
  const log = path.join(dataDir, 'dashboard.log');
  const out = fs.openSync(log, 'a');
  let status: 'starting' | 'running' | 'exited' = 'starting';
  // Loopback only; the dashboard serves unredacted evidence.
  const child: ChildProcess = spawn(process.execPath, [next, 'start', '-H', '127.0.0.1', '-p', String(port)], {
    cwd: root, windowsHide: true, stdio: ['ignore', out, out],
    env: { ...process.env, WISDOM_DATA_DIR: dataDir, WISDOM_DAEMON_PID: String(process.pid), NEXT_TELEMETRY_DISABLED: '1' },
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
