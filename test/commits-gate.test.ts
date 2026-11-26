import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { gate, seal, RECHECK_MS, SIGN_IN_MS, type GateConfig, type GateResponse } from '../src/visualizer/gate.js';
import { TooBig, writeVercelSite } from '../src/visualizer/site.js';

const KEY = randomBytes(32);
const secrets = { clientId: 'cid', clientSecret: 'csecret', cookieKey: KEY.toString('hex') };
const HOST = { host: 'dash.example', 'x-forwarded-proto': 'https' };

/** A stand-in GitHub: sign-in, the repository check, and who a token is. `access` is what it
 * answers for the repository; `down` makes it fail as an outage would. */
async function github() {
  const state = { access: 'yes' as 'yes' | 'no' | 'down', exchanged: [] as unknown[] };
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      const send = (status: number, body: unknown) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(body)); };
      const url = new URL(request.url ?? '/', 'http://github');
      if (url.pathname === '/login/oauth/access_token') {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        state.exchanged.push(body);
        return body.code === 'good' && body.client_secret === 'csecret' ? send(200, { access_token: 'tok-1', expires_in: 28800, refresh_token: 'r' }) : send(200, { error: 'bad_verification_code' });
      }
      if (state.access === 'down') return send(502, {});
      if (url.pathname === '/user') return send(200, { login: 'maya' });
      if (url.pathname === '/repos/acme/app') {
        if (request.headers.authorization !== 'Bearer tok-1') return send(401, {});
        return state.access === 'yes' ? send(200, { private: true, permissions: { pull: true, push: false } }) : send(404, {});
      }
      send(404, {});
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { state, base, close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}

const cookies = (response: GateResponse) => ([] as string[]).concat(response.headers['Set-Cookie'] ?? []);
const cookieValue = (response: GateResponse, name: string) => cookies(response).find(c => c.startsWith(`${name}=`))?.split(';')[0].slice(name.length + 1);
const get = (config: GateConfig, url: string, cookie?: string, now?: number) => gate({ method: 'GET', url, headers: { ...HOST, ...(cookie ? { cookie } : {}) } }, config, secrets, now);

/** Sign in through the gate as a viewer does, returning the session cookie (or the last answer). */
async function signIn(config: GateConfig, to = '#/change/124', now = Date.now()) {
  const login = await get(config, `/auth/login?to=${encodeURIComponent(to)}`, undefined, now);
  const state = new URL(String(login.headers.Location)).searchParams.get('state');
  const callback = await get(config, `/auth/callback?code=good&state=${state}`, `wisdom_state=${cookieValue(login, 'wisdom_state')}`, now);
  return { login, callback, session: cookieValue(callback, 'wisdom_session') };
}

test('the gate: signing in sends the viewer to GitHub and back, then lets a reader in', async () => {
  const gh = await github();
  try {
    const config = { repo: 'acme/app', api: gh.base, web: gh.base };
    const { login, callback, session } = await signIn(config);
    // To GitHub's sign-in, with this site's own return address and a one-time state.
    assert.equal(login.status, 302);
    const to = new URL(String(login.headers.Location));
    assert.equal(`${to.origin}${to.pathname}`, `${gh.base}/login/oauth/authorize`);
    assert.equal(to.searchParams.get('client_id'), 'cid');
    assert.equal(to.searchParams.get('redirect_uri'), 'https://dash.example/auth/callback');
    assert.match(cookies(login)[0], /^wisdom_state=.+; Path=\/; HttpOnly; SameSite=Lax; Max-Age=600; Secure$/);
    // Back: the code swapped with the app's secret, the repository asked, the viewer in.
    assert.deepEqual(gh.state.exchanged.at(-1), { client_id: 'cid', client_secret: 'csecret', code: 'good', redirect_uri: 'https://dash.example/auth/callback' });
    assert.equal(callback.status, 302);
    assert.equal(callback.headers.Location, '/#/change/124', 'back to the page the viewer was on');
    assert.ok(session);
    assert.match(cookies(callback).find(c => c.startsWith('wisdom_session='))!, /HttpOnly; SameSite=Lax; Max-Age=28800; Secure$/, 'a sign-in lasts 8 hours');
    assert.ok(!session.includes('tok-1') && !Buffer.from(session, 'base64url').toString('latin1').includes('tok-1'), 'the token in the cookie is encrypted');

    const data = await get(config, '/data/session/r1/s1/t3.json', `wisdom_session=${session}`);
    assert.deepEqual([data.status, data.file, data.headers['Cache-Control']], [200, 'session/r1/s1/t3.json', 'private, no-store']);
    const me = await get(config, '/auth/me', `wisdom_session=${session}`);
    assert.deepEqual(JSON.parse(me.body!), { login: 'maya', repo: 'acme/app' });
    const out = await get(config, '/auth/logout', `wisdom_session=${session}`);
    assert.match(cookies(out)[0], /^wisdom_session=; .*Max-Age=0/);
  } finally { await gh.close(); }
});

test('the gate keeps out whoever may not read the repository, and forged, stale or wandering requests', async () => {
  const gh = await github();
  try {
    const config = { repo: 'acme/app', api: gh.base, web: gh.base };
    // No cookie, a made-up one, one sealed with another key: sign in first.
    assert.equal((await get(config, '/data/manifest.json')).status, 401);
    assert.equal((await get(config, '/data/manifest.json', 'wisdom_session=abc')).status, 401);
    const forged = seal(randomBytes(32), { token: 'tok-1', login: 'eve', checkedAt: Date.now(), until: Date.now() + 1e9 });
    assert.equal((await get(config, '/data/manifest.json', `wisdom_session=${forged}`)).status, 401);

    // Someone GitHub won't show the repository to: refused, and no sign-in kept.
    gh.state.access = 'no';
    const refused = await signIn(config);
    assert.equal(refused.callback.status, 403);
    assert.match(refused.callback.body!, /can&#39;t read acme\/app|can't read acme\/app/);
    assert.equal(refused.session, undefined);
    gh.state.access = 'yes';

    // A return address that isn't a page of this site is dropped, never followed.
    assert.equal((await signIn(config, '//evil.example/x')).callback.headers.Location, '/');
    // A callback whose state isn't the one this browser was given.
    const login = await get(config, '/auth/login');
    assert.equal((await get(config, '/auth/callback?code=good&state=other', `wisdom_state=${cookieValue(login, 'wisdom_state')}`)).status, 400);
    // A code GitHub doesn't accept.
    const state = new URL(String(login.headers.Location)).searchParams.get('state');
    assert.equal((await get(config, `/auth/callback?code=bad&state=${state}`, `wisdom_state=${cookieValue(login, 'wisdom_state')}`)).status, 400);

    const { session } = await signIn(config);
    const as = `wisdom_session=${session}`;
    // Nothing outside the data, however the path is written.
    for (const wander of ['/data/..%2Fgate.mjs', '/data/../gate.mjs', '/data/a%2F..%2F..%2Fgate.json','/data/%2e%2e/x', '/data/', '/data//x', '/data/a%00b'])
      assert.equal((await get(config, wander, as)).file, undefined, wander);
    assert.equal((await get(config, '/elsewhere', as)).status, 404);
  } finally { await gh.close(); }
});

test('the gate asks GitHub again every 10 minutes, fails closed when it cannot, and ends a sign-in after 8 hours', async () => {
  const gh = await github();
  try {
    const config = { repo: 'acme/app', api: gh.base, web: gh.base };
    const start = Date.now();
    const { session } = await signIn(config, '#/', start);
    const as = `wisdom_session=${session}`;
    // Within 10 minutes: no question asked, even with GitHub down.
    gh.state.access = 'down';
    assert.equal((await get(config, '/data/index.json', as, start + RECHECK_MS - 1)).status, 200);
    // After: GitHub down means nothing is shown.
    const outage = await get(config, '/data/index.json', as, start + RECHECK_MS);
    assert.deepEqual([outage.status, outage.file], [503, undefined]);
    // Still a reader: in, and the cookie renewed with the new time.
    gh.state.access = 'yes';
    const again = await get(config, '/data/index.json', as, start + RECHECK_MS);
    assert.equal(again.status, 200);
    assert.ok(cookieValue(again, 'wisdom_session'), 'the renewed cookie');
    // Access taken away on GitHub: out at the next check, and the sign-in forgotten.
    gh.state.access = 'no';
    const lost = await get(config, '/data/index.json', as, start + 2 * RECHECK_MS);
    assert.deepEqual([lost.status, lost.file], [403, undefined]);
    assert.match(cookies(lost)[0], /^wisdom_session=; .*Max-Age=0/);
    // 8 hours on: sign in again, whatever GitHub says.
    gh.state.access = 'yes';
    assert.equal((await get(config, '/data/index.json', as, start + SIGN_IN_MS + 1)).status, 401);
  } finally { await gh.close(); }
});

/** A response object the Vercel adapter can write and stream into. */
function response() {
  const res = Object.assign(new PassThrough(), { statusCode: 200, headers: {} as Record<string, unknown>, setHeader(name: string, value: unknown) { res.headers[name.toLowerCase()] = value; } });
  const body = new Promise<string>(resolve => { const chunks: Buffer[] = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8'))); });
  return { res, body };
}

test('the Vercel site: the app public, the data only inside the gate, and the adapter streams a reader\'s file', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wisdom-site-'));
  const app = path.join(root, 'app'), data = path.join(root, 'data'), out = path.join(root, 'out');
  fs.mkdirSync(path.join(app, 'data'), { recursive: true });
  fs.writeFileSync(path.join(app, 'index.html'), '<!doctype html><title>Commits</title>');
  fs.writeFileSync(path.join(app, 'data', 'sample.json'), '{}');
  fs.mkdirSync(path.join(data, 'session', 'r1', 's1'), { recursive: true });
  fs.writeFileSync(path.join(data, 'manifest.json'), '{"contract":1}');
  fs.writeFileSync(path.join(data, 'session', 'r1', 's1', 't1.json'), '{"turn":1}');

  writeVercelSite(out, { app, data, gate: { repo: 'acme/app' } });
  const output = path.join(out, '.vercel', 'output');
  assert.ok(fs.existsSync(path.join(output, 'static', 'index.html')));
  assert.ok(!fs.existsSync(path.join(output, 'static', 'data')), 'no data among the public files, not even the app\'s sample');
  const fn = path.join(output, 'functions', 'gate.func');
  for (const file of ['index.mjs', 'gate.mjs', 'gate.json', '.vc-config.json', 'data/manifest.json', 'data/session/r1/s1/t1.json'])
    assert.ok(fs.existsSync(path.join(fn, file)), file);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(output, 'config.json'), 'utf8')).routes, [{ src: '^/(?:data|auth)(?:/.*)?$', dest: '/gate' }]);
  // The gate needs nothing but Node: it runs from its folder alone.
  assert.doesNotMatch(fs.readFileSync(path.join(fn, 'gate.mjs'), 'utf8'), /from '\.\.?\//);

  const handler = (await import(pathToFileURL(path.join(fn, 'index.mjs')).href)).default;
  // Without its secrets it says so and serves nothing.
  delete process.env.WISDOM_COOKIE_KEY;
  const unset = response();
  await handler({ method: 'GET', url: '/data/manifest.json', headers: HOST }, unset.res);
  assert.equal(unset.res.statusCode, 500);
  assert.match(await unset.body, /not set up right/);

  process.env.WISDOM_GITHUB_CLIENT_ID = 'cid'; process.env.WISDOM_GITHUB_CLIENT_SECRET = 'csecret'; process.env.WISDOM_COOKIE_KEY = KEY.toString('hex');
  try {
    const anonymous = response();
    await handler({ method: 'GET', url: '/data/manifest.json', headers: HOST }, anonymous.res);
    assert.equal(anonymous.res.statusCode, 401);
    const session = seal(KEY, { token: 't', login: 'maya', checkedAt: Date.now(), until: Date.now() + 60_000 });
    const reader = response();
    await handler({ method: 'GET', url: '/data/session/r1/s1/t1.json', headers: { ...HOST, cookie: `wisdom_session=${session}` } }, reader.res);
    assert.equal(await reader.body, '{"turn":1}');
    assert.equal(reader.res.statusCode, 200);
    const absent = response();
    await handler({ method: 'GET', url: '/data/nope.json', headers: { ...HOST, cookie: `wisdom_session=${session}` } }, absent.res);
    await absent.body;
    assert.equal(absent.res.statusCode, 404);
  } finally { delete process.env.WISDOM_GITHUB_CLIENT_ID; delete process.env.WISDOM_GITHUB_CLIENT_SECRET; delete process.env.WISDOM_COOKIE_KEY; }

  // Public, only when asked: the data beside the app, no gate.
  writeVercelSite(out, { app, data, gate: 'public' });
  assert.ok(fs.existsSync(path.join(output, 'static', 'data', 'manifest.json')));
  assert.ok(!fs.existsSync(path.join(output, 'functions')));
  // Too much data for one function: a clear stop, nothing half written.
  assert.throws(() => writeVercelSite(path.join(root, 'big'), { app, data, gate: { repo: 'acme/app' }, limit: 10 }), (error: unknown) => error instanceof TooBig && /enterprise/.test(error.message));
  assert.ok(!fs.existsSync(path.join(root, 'big', '.vercel')));
});
