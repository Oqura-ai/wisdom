import 'server-only';
import fs from 'node:fs';
import path from 'node:path';

/** The daemon token never reaches the browser: only this server reads daemon.json. */
interface Connection { url: string; token: string; pid: number }

// The daemon passes its data directory; `next dev` from dashboard/ uses the repo default.
const dataDir = process.env.WISDOM_DATA_DIR ?? path.resolve(process.cwd(), '..', '.wisdom');

function connection(): Connection {
  const file = path.join(dataDir, 'daemon.json');
  if (!fs.existsSync(file)) throw new DaemonUnavailable(`Wisdom daemon is not running (no ${file}). Run: wisdom daemon start`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export class DaemonUnavailable extends Error {}

export async function daemon(route: string, input?: unknown): Promise<any> {
  const target = connection();
  let response: Response;
  try {
    response = await fetch(target.url + route, {
      method: input === undefined ? 'GET' : 'POST', cache: 'no-store',
      headers: { Authorization: `Bearer ${target.token}`, 'Content-Type': 'application/json' },
      body: input === undefined ? undefined : JSON.stringify(input), signal: AbortSignal.timeout(15000),
    });
  } catch (error) { throw new DaemonUnavailable(`Wisdom daemon did not answer: ${(error as Error).message}`); }
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? `Daemon returned HTTP ${response.status}`);
  return result;
}

/** Recordings are unredacted, so only same-machine requests addressed to this server
 * are served. A Host check also defeats DNS-rebinding pages in the browser.
 */
export function localOnly(request: Request): Response | undefined {
  const host = request.headers.get('host') ?? '';
  if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host)) {
    return Response.json({ error: 'The Wisdom dashboard only serves localhost.' }, { status: 403 });
  }
  const origin = request.headers.get('origin');
  if (origin && new URL(origin).host !== host) return Response.json({ error: 'Cross-origin request refused.' }, { status: 403 });
  return undefined;
}
