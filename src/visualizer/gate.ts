/**
 * The deployed Commits dashboard's gate (design policy 5.24, 5.28): its link is open, its data
 * needs a GitHub sign-in by someone who may read the repository.
 *
 *   /auth/login      to GitHub's sign-in, with a one-time state
 *   /auth/callback   GitHub's answer: the viewer's token, then "may they read the repository?"
 *   /auth/me         who is signed in (the app shows it)
 *   /auth/logout     forget the sign-in
 *   /data/<path>     a data file, only for a signed-in reader; asked of GitHub again every 10 minutes
 *
 * The viewer's token rides in their own cookie, encrypted with a key only the host holds
 * (AES-256-GCM), so nothing is stored anywhere else. A sign-in lasts at most 8 hours. When
 * GitHub can't be asked, the gate says so and serves nothing (it fails closed).
 *
 * Host-neutral and self-contained: a plain request in, a plain answer out, and only node:crypto
 * imported, so the build copies this file as it is next to a host's small adapter (vercel.ts).
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export interface GateConfig {
  /** owner/name: the repository a viewer must be able to read. */
  repo: string;
  /** GitHub's API and web addresses (tests point them at a stand-in). */
  api?: string;
  web?: string;
}

export interface GateSecrets {
  clientId: string;
  clientSecret: string;
  /** 32 bytes, base64 or hex: encrypts the cookies. */
  cookieKey: string;
}

export interface GateRequest { method: string; url: string; headers: Record<string, string | undefined> }
/** `file`: a data path for the host to send (it exists or the host answers 404). */
export interface GateResponse { status: number; headers: Record<string, string | string[]>; body?: string; file?: string }

/** How often a reader's access is asked of GitHub again. */
export const RECHECK_MS = 10 * 60_000;
/** The longest a sign-in lasts, whatever GitHub's token says. */
export const SIGN_IN_MS = 8 * 3_600_000;
const STATE_MS = 10 * 60_000;
const SESSION = 'wisdom_session', STATE = 'wisdom_state';

interface Session { token: string; login: string; checkedAt: number; until: number }

export async function gate(request: GateRequest, config: GateConfig, secrets: GateSecrets,
  now = Date.now(), ask: typeof fetch = fetch): Promise<GateResponse> {
  const api = (config.api ?? 'https://api.github.com').replace(/\/+$/, ''), web = (config.web ?? 'https://github.com').replace(/\/+$/, '');
  const key = keyOf(secrets.cookieKey);
  const url = new URL(request.url, 'http://gate');
  const secure = origin(request).startsWith('https:');
  const cookies = parseCookies(request.headers.cookie);
  if (request.method !== 'GET' && request.method !== 'HEAD') return text(405, 'Only GET');

  // ----- sign-in -----
  if (url.pathname === '/auth/login') {
    const state = randomBytes(16).toString('hex');
    const to = safeReturn(url.searchParams.get('to'));
    const go = new URL(`${web}/login/oauth/authorize`);
    go.searchParams.set('client_id', secrets.clientId);
    go.searchParams.set('redirect_uri', `${origin(request)}/auth/callback`);
    go.searchParams.set('state', state);
    go.searchParams.set('allow_signup', 'false');
    return redirect(go.toString(), [cookie(STATE, seal(key, { state, to, until: now + STATE_MS }), STATE_MS, secure)]);
  }
  if (url.pathname === '/auth/callback') {
    const pending = open<{ state: string; to: string; until: number }>(key, cookies[STATE]);
    const clear = cookie(STATE, '', 0, secure);
    if (!pending || pending.until < now || pending.state !== url.searchParams.get('state'))
      return page(400, 'That sign-in link has expired', '<p><a href="/auth/login">Sign in again</a>.</p>', [clear]);
    const code = url.searchParams.get('code');
    if (!code) return page(400, 'GitHub did not sign you in', '<p><a href="/auth/login">Try again</a>.</p>', [clear]);
    let token: string, lifetime: number;
    try {
      const exchanged = await ask(`${web}/login/oauth/access_token`, { method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'wisdom-commits' },
        body: JSON.stringify({ client_id: secrets.clientId, client_secret: secrets.clientSecret, code, redirect_uri: `${origin(request)}/auth/callback` }) });
      const body = await exchanged.json() as { access_token?: string; expires_in?: number };
      if (!body.access_token) return page(400, 'GitHub did not sign you in', '<p><a href="/auth/login">Try again</a>.</p>', [clear]);
      token = body.access_token;
      lifetime = Math.min(SIGN_IN_MS, (body.expires_in ?? Infinity) * 1000);
    } catch { return page(503, 'GitHub could not be reached', '<p>Nothing is shown until it can be. <a href="/auth/login">Try again</a>.</p>', [clear]); }
    const access = await mayRead(ask, api, config.repo, token);
    if (access === 'unknown') return page(503, 'GitHub could not be reached', '<p>Nothing is shown until it can be. <a href="/auth/login">Try again</a>.</p>', [clear]);
    if (access === 'no') return page(403, `Your GitHub account can't read ${esc(config.repo)}`,
      '<p>This dashboard shows only what people who can read the repository may see. Ask its admins for access, or <a href="/auth/login">sign in as someone else</a>.</p>', [clear]);
    const login = await whoIs(ask, api, token);
    const session: Session = { token, login, checkedAt: now, until: now + lifetime };
    return redirect(`/${pending.to}`, [clear, cookie(SESSION, seal(key, session), lifetime, secure)]);
  }
  if (url.pathname === '/auth/logout') return redirect('/', [cookie(SESSION, '', 0, secure)]);

  // ----- a reader's requests -----
  const signIn = { status: 401, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify({ signIn: '/auth/login' }) };
  const session = open<Session>(key, cookies[SESSION]);
  if (!session || session.until < now) return session ? { ...signIn, headers: { ...signIn.headers, 'Set-Cookie': [cookie(SESSION, '', 0, secure)] } } : signIn;
  const refreshed: string[] = [];
  if (now - session.checkedAt >= RECHECK_MS) {
    const access = await mayRead(ask, api, config.repo, session.token);
    if (access === 'unknown') return text(503, 'GitHub could not be asked whether you may still read this repository. Nothing is shown until it can be.');
    if (access === 'no') return { status: 403, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Set-Cookie': [cookie(SESSION, '', 0, secure)] },
      body: JSON.stringify({ denied: config.repo }) };
    session.checkedAt = now;
    refreshed.push(cookie(SESSION, seal(key, session), session.until - now, secure));
  }
  const withCookie = (response: GateResponse): GateResponse => refreshed.length ? { ...response, headers: { ...response.headers, 'Set-Cookie': refreshed } } : response;
  if (url.pathname === '/auth/me') return withCookie({ status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify({ login: session.login, repo: config.repo }) });
  if (url.pathname.startsWith('/data/')) {
    const file = dataPath(url.pathname.slice('/data/'.length));
    if (!file) return text(404, 'Not in this build');
    return withCookie({ status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' }, file });
  }
  return text(404, 'Not found');
}

/** Whether this token's person may read the repository: GitHub's own answer, or unknown. */
async function mayRead(ask: typeof fetch, api: string, repo: string, token: string): Promise<'yes' | 'no' | 'unknown'> {
  try {
    const response = await ask(`${api}/repos/${repo}`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'wisdom-commits' } });
    if (response.status === 200) { const body = await response.json() as { permissions?: { pull?: boolean } }; return body.permissions?.pull === true ? 'yes' : 'no'; }
    // 401: the token is no longer good; 403/404: GitHub will not show this person the repository.
    if (response.status === 401 || response.status === 403 || response.status === 404) return 'no';
    return 'unknown';
  } catch { return 'unknown'; }
}

async function whoIs(ask: typeof fetch, api: string, token: string): Promise<string> {
  try {
    const response = await ask(`${api}/user`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'wisdom-commits' } });
    return response.ok ? String((await response.json() as { login?: string }).login ?? '') : '';
  } catch { return ''; }
}

// ----- paths -----

/** A data file's path, or undefined if it could name anything outside the data. */
export function dataPath(raw: string): string | undefined {
  let path: string;
  try { path = decodeURIComponent(raw); } catch { return undefined; }
  const parts = path.split('/');
  if (!path || parts.some(part => !part || part === '.' || part === '..' || !/^[A-Za-z0-9._-]+$/.test(part))) return undefined;
  return parts.join('/');
}

/** Where to go after signing in: a page of this site only (the app's hash route), never another site. */
function safeReturn(to: string | null): string {
  return to && /^#\/[A-Za-z0-9._~%/-]*$/.test(to) ? to : '';
}

function origin(request: GateRequest): string {
  const host = request.headers.host ?? 'localhost';
  const local = /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host);
  const proto = request.headers['x-forwarded-proto']?.split(',')[0].trim() || (local ? 'http' : 'https');
  return `${proto === 'http' ? 'http' : 'https'}://${host}`;
}

// ----- cookies, sealed -----

function keyOf(text: string): Buffer {
  const key = /^[0-9a-f]{64}$/i.test(text) ? Buffer.from(text, 'hex') : Buffer.from(text, 'base64');
  if (key.length !== 32) throw new Error('The cookie key must be 32 bytes, as hex or base64.');
  return key;
}

/** Encrypt and sign a value for a cookie: only someone with the key can read or change it. */
export function seal(key: Buffer, value: unknown): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64url');
}

/** The value a cookie holds, or undefined when it is missing, forged or damaged. */
export function open<T>(key: Buffer, text: string | undefined): T | undefined {
  if (!text) return undefined;
  try {
    const raw = Buffer.from(text, 'base64url');
    const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    return JSON.parse(Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8')) as T;
  } catch { return undefined; }
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const at = part.indexOf('=');
    if (at > 0) out[part.slice(0, at).trim()] = part.slice(at + 1).trim();
  }
  return out;
}

/** Only this site, never read by its pages' scripts, and only over HTTPS once deployed. */
function cookie(name: string, value: string, ms: number, secure: boolean): string {
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.max(0, Math.floor(ms / 1000))}${secure ? '; Secure' : ''}`;
}

// ----- answers -----

const esc = (text: string) => text.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const text = (status: number, body: string): GateResponse => ({ status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }, body });
const redirect = (to: string, cookies: string[]): GateResponse => ({ status: 302, headers: { Location: to, 'Cache-Control': 'no-store', 'Set-Cookie': cookies } });
function page(status: number, title: string, html: string, cookies: string[]): GateResponse {
  return { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Set-Cookie': cookies },
    body: `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Wisdom Commits</title>
<body style="font:15px/1.5 system-ui,sans-serif;max-width:560px;margin:15vh auto;padding:0 16px"><h1 style="font-size:20px">${esc(title)}</h1>${html}</body>` };
}
