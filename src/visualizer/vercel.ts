/**
 * `wisdom commits prune`: remove the team dashboard's older Vercel deployments after a new one
 * (design policy 5.25). Each build is its own deployment at its own address, and an old one still
 * holds the data it was built with, sessions since deleted included. Vercel's Deployment
 * Protection closes those addresses by default (live test 3), but a team can turn it off: so they
 * go. Only finished production deployments older than the newest finished one are removed; one
 * still building, or a preview someone made by hand, is never touched.
 *
 * Vercel's REST API, with the CI's token: list `GET /v7/deployments`, remove `DELETE
 * /v13/deployments/{id}`. VERCEL_API (a test's stand-in) else api.vercel.com.
 */

export interface PruneOptions { token: string; projectId: string; orgId?: string; keep?: number; api?: string }

interface Deployment { uid: string; url: string; created: number; state: string; target?: string | null }

const DONE = new Set(['READY', 'ERROR', 'CANCELED']);

export async function pruneDeployments(options: PruneOptions): Promise<{ kept: string[]; removed: string[] }> {
  const api = (options.api ?? 'https://api.vercel.com').replace(/\/+$/, '');
  const keep = Math.max(1, options.keep ?? 1);
  // A team's projects are asked for under the team; a personal account's without.
  const team = options.orgId?.startsWith('team_') ? options.orgId : undefined;
  const ask = async (method: string, route: string, query: Record<string, string>) => {
    const url = new URL(`${api}${route}`);
    for (const [key, value] of Object.entries({ ...query, ...(team ? { teamId: team } : {}) })) url.searchParams.set(key, value);
    const response = await fetch(url, { method, headers: { Authorization: `Bearer ${options.token}`, 'User-Agent': 'wisdom-commits' } });
    if (!response.ok) throw new Error(`Vercel answered ${response.status} to ${method} ${route}${response.status === 403 ? ' (does the token reach this project?)' : ''}`);
    return response.json() as Promise<any>;
  };

  const all: Deployment[] = [];
  for (let until: string | undefined, page = 0; page < 20; page++) {
    const body = await ask('GET', '/v7/deployments', { projectId: options.projectId, target: 'production', limit: '100', ...(until ? { until } : {}) });
    for (const d of body.deployments ?? []) all.push({ uid: String(d.uid), url: String(d.url), created: Number(d.created ?? d.createdAt ?? 0), state: String(d.state ?? d.readyState ?? ''), target: d.target });
    until = body.pagination?.next ? String(body.pagination.next) : undefined;
    if (!until) break;
  }
  const finished = all.filter(d => d.target === 'production' && DONE.has(d.state)).sort((a, b) => b.created - a.created);
  const newestReady = finished.filter(d => d.state === 'READY').slice(0, keep);
  if (!newestReady.length) return { kept: [], removed: [] };
  const oldestKept = newestReady[newestReady.length - 1].created;
  const remove = finished.filter(d => !newestReady.includes(d) && d.created < oldestKept);
  const removed: string[] = [];
  for (const d of remove) { await ask('DELETE', `/v13/deployments/${d.uid}`, {}); removed.push(d.url); }
  return { kept: newestReady.map(d => d.url), removed };
}
