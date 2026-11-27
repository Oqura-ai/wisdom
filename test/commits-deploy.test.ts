import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createVerify, generateKeyPairSync } from 'node:crypto';
import { parse } from 'yaml';
import { gitText } from '../src/team/gitrefs.js';
import { workflowFile, writeWorkflow } from '../src/team/relink.js';
import { deployCommits, ENV_NAMES, TOKEN_SECRET, writeDeployState, type DeployIO, type Run } from '../src/visualizer/deploy.js';
import { rebuildDashboard } from '../src/visualizer/rebuild.js';
import { REUSABLE } from '../src/visualizer/ci.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const DASHBOARD = 'https://wisdom-app.vercel.app';

/** A team-mode repository on "GitHub", with the old relink job team init used to write. */
function repository() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wisdom-deploy-test-'));
  gitText(dir, ['init', '-q', '-b', 'main']);
  gitText(dir, ['remote', 'add', 'origin', 'https://github.com/acme/app.git']);
  fs.writeFileSync(path.join(dir, 'wisdom-team.yaml'), '# Wisdom team mode: committed, it turns team mode on for everyone.\nversion: 1\nrepoId: testrepo1\nremote: origin   # where sessions go\n');
  writeWorkflow(dir, 'main');
  return dir;
}

/** GitHub, as far as deploy asks it: visibility, the owner's kind, the manifest's conversion, and
 * (as the app, with a JWT the test checks) whether the app is installed. */
async function github(options: { publicRepo?: boolean } = {}) {
  const seen = { jwtVerified: false, conversions: 0 };
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://github');
    const send = (status: number, body: unknown) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(body)); };
    if (url.pathname === '/repos/acme/app') return options.publicRepo ? send(200, { private: false }) : send(404, {});
    if (url.pathname === '/users/acme') return send(200, { type: 'Organization' });
    if (request.method === 'POST' && url.pathname === '/app-manifests/good/conversions') { seen.conversions++; return send(201, { id: 7, slug: 'wisdom-app-abc123', client_id: 'cid', client_secret: 'csecret', webhook_secret: null, pem: privateKey }); }
    if (url.pathname === '/repos/acme/app/installation') {
      const [header, payload, signature] = String(request.headers.authorization).replace('Bearer ', '').split('.');
      seen.jwtVerified = createVerify('RSA-SHA256').update(`${header}.${payload}`).verify(publicKey, signature, 'base64url') && JSON.parse(Buffer.from(payload, 'base64url').toString()).iss === '7';
      return seen.jwtVerified ? send(200, { id: 99 }) : send(401, {});
    }
    send(404, {});
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { base, seen, close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}

/** Stand-ins for the terminal, the browser, the Vercel CLI and the dashboard's address. */
function stand(base: string, options: { yes?: (question: string) => boolean; live?: boolean } = {}) {
  const log: string[] = [], vercel: string[][] = [], opened: string[] = [], env: Record<string, string> = {};
  const manifest: { action?: string; value?: any } = {};
  let deployed = '';
  const io: DeployIO = {
    say: line => log.push(line),
    yes: async question => { log.push(`? ${question}`); return options.yes ? options.yes(question) : true; },
    ask: async question => { log.push(`? ${question}`); return ''; },
    open: url => {
      opened.push(url);
      // The browser: deploy's page posts the manifest to GitHub, and GitHub sends back a code.
      if (url.startsWith('http://127.0.0.1:') && !url.startsWith(base)) void (async () => {
        const html = await (await fetch(url)).text();
        manifest.action = /action="([^"]+)"/.exec(html)![1];
        manifest.value = JSON.parse(/value="([^"]+)"/.exec(html)![1].replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
        const state = new URL(manifest.action).searchParams.get('state');
        await fetch(`${new URL(manifest.value.redirect_url).origin}/created?code=good&state=${state}`);
      })();
    },
    vercel: (args, { cwd, input }): Run => {
      vercel.push(args);
      if (args[0] === 'link') { fs.mkdirSync(path.join(cwd, '.vercel'), { recursive: true }); fs.writeFileSync(path.join(cwd, '.vercel', 'project.json'), JSON.stringify({ projectId: 'prj_1', orgId: 'team_1' })); }
      if (args[0] === 'deploy') deployed = fs.readFileSync(path.join(cwd, '.vercel', 'output', 'static', 'index.html'), 'utf8');
      if (args[0] === 'env' && args[1] === 'add') env[args[2]] = input ?? '';
      return { status: 0, stdout: '', stderr: '' };
    },
    gh: () => undefined,
    // The dashboard's address answers with what was deployed there; a running one, from its gate.
    fetch: (async (target: string | URL, init?: RequestInit) => {
      const url = String(target);
      if (url.startsWith(DASHBOARD)) return options.live ? new Response('{"signIn":"/auth/login"}', { status: 401 }) : new Response(deployed, { status: deployed ? 200 : 404 });
      return fetch(target, init);
    }) as typeof fetch,
    web: base, api: base,
  };
  return { io, log, vercel, opened, env, manifest, deployed: () => deployed };
}

test('commits deploy: Vercel, the sign-in app from a manifest, its secrets, the CI token by the person, the CI file and the team file', async () => {
  const dir = repository();
  const gh = await github();
  try {
    const s = stand(gh.base);
    const result = await deployCommits(dir, s.io);
    assert.equal(result.url, DASHBOARD);

    // The address was learned from a placeholder, found where Vercel put it.
    assert.match(s.deployed(), /wisdom-placeholder-[0-9a-f]{16}/);
    assert.ok(s.vercel.some(args => args.join(' ') === 'link --yes --project wisdom-app'));
    assert.ok(s.vercel.some(args => args.join(' ') === 'deploy --prebuilt --prod --yes'));

    // The app: for the organization, Metadata read only, no webhook, the confirmed callback.
    assert.equal(new URL(s.manifest.action!).pathname, '/organizations/acme/settings/apps/new');
    assert.deepEqual(s.manifest.value.default_permissions, { metadata: 'read' });
    assert.deepEqual(s.manifest.value.default_events, []);
    assert.equal(s.manifest.value.hook_attributes.active, false);
    assert.deepEqual(s.manifest.value.callback_urls, [`${DASHBOARD}/auth/callback`]);
    assert.equal(s.manifest.value.public, false);
    assert.ok(s.manifest.value.name.length <= 34, 'GitHub\'s limit on an app\'s name');
    // Installed: asked of GitHub as the app, with a token signed by its key.
    assert.ok(s.opened.includes(`${gh.base}/apps/wisdom-app-abc123/installations/new`));
    assert.ok(gh.seen.jwtVerified);

    // The gate's secrets on Vercel; the CI token never passes through Wisdom.
    assert.deepEqual(Object.keys(s.env).sort(), Object.values(ENV_NAMES).sort());
    assert.equal(s.env[ENV_NAMES.clientId], 'cid');
    assert.equal(s.env[ENV_NAMES.clientSecret], 'csecret');
    assert.match(s.env[ENV_NAMES.cookieKey], /^[0-9a-f]{64}$/);
    assert.ok(s.opened.includes('https://vercel.com/account/tokens'));
    assert.ok(s.opened.includes(`${gh.base}/acme/app/settings/secrets/actions/new`), 'without gh: GitHub\'s secrets page, for the paste');
    assert.ok(s.log.some(line => line.includes(TOKEN_SECRET)));
    assert.ok(s.log.some(line => /Vercel Pro/.test(line)), 'a company is told it needs Pro');

    // The CI file, the old relink job gone (the new one relinks), the team file kept as it was plus commits.
    const workflow = parse(fs.readFileSync(path.join(dir, '.github', 'workflows', 'wisdom.yml'), 'utf8'));
    assert.equal(workflow.jobs.wisdom.uses, REUSABLE);
    assert.deepEqual(workflow.jobs.wisdom.with, { main: 'main', 'wisdom-version': JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version,
      commits: true, 'vercel-org-id': 'team_1', 'vercel-project-id': 'prj_1' });
    assert.ok(!fs.existsSync(workflowFile(dir)));
    const team = fs.readFileSync(path.join(dir, 'wisdom-team.yaml'), 'utf8');
    assert.match(team, /^# Wisdom team mode: committed/);
    assert.match(team, /remote: origin {3}# where sessions go/);
    assert.deepEqual(parse(team).commits, { url: DASHBOARD, vercelProject: 'wisdom-app', githubApp: 'wisdom-app-abc123' });
  } finally { await gh.close(); }
});

test('after a team delete: the dashboard rebuilds now through gh, or the person is told when the session leaves it', () => {
  const dir = repository();
  const gh = (status: number | undefined) => { const calls: string[][] = []; return { calls, run: (args: string[]) => { calls.push(args); return status === undefined ? undefined : { status, stdout: '', stderr: status ? 'HTTP 404: workflow not found' : '' }; } }; };
  // No dashboard set up: nothing to say.
  const none = gh(0);
  assert.equal(rebuildDashboard(dir, 'origin', none.run), undefined);
  assert.deepEqual(none.calls, []);
  writeDeployState(dir, { url: DASHBOARD, vercelProject: 'wisdom-app' });
  const started = gh(0);
  assert.match(rebuildDashboard(dir, 'origin', started.run)!, /rebuilding now/);
  assert.deepEqual(started.calls, [['workflow', 'run', 'wisdom.yml', '--repo', 'acme/app']]);
  const missing = rebuildDashboard(dir, 'origin', gh(undefined).run)!;
  assert.match(missing, /within 20 minutes/);
  assert.match(missing, /https:\/\/github\.com\/acme\/app\/actions\/workflows\/wisdom\.yml/);
  assert.match(rebuildDashboard(dir, 'origin', gh(1).run)!, /gh could not start it: HTTP 404/);
});

test('commits deploy again: a running dashboard is never replaced by the placeholder, and the app is kept when asked', async () => {
  const dir = repository();
  const gh = await github();
  try {
    await deployCommits(dir, stand(gh.base).io);
    const conversions = gh.seen.conversions;
    const again = stand(gh.base, { live: true, yes: question => /^Keep the sign-in app/.test(question) });
    await deployCommits(dir, again.io);
    assert.ok(!again.vercel.some(args => args[0] === 'deploy'), 'no placeholder over the live dashboard');
    assert.equal(gh.seen.conversions, conversions, 'no second app');
    assert.deepEqual(again.env, {}, 'the kept app\'s secrets stay as they are');
    assert.equal(parse(fs.readFileSync(path.join(dir, 'wisdom-team.yaml'), 'utf8')).commits.githubApp, 'wisdom-app-abc123');
  } finally { await gh.close(); }
});

test('commits deploy --public: only for a public repository without asking again; a private one stays behind the sign-in unless confirmed', async () => {
  const open = await github({ publicRepo: true });
  try {
    const dir = repository();
    const s = stand(open.base);
    await deployCommits(dir, s.io, { public: true });
    assert.equal(open.seen.conversions, 0, 'no sign-in app for a public dashboard');
    assert.equal(parse(fs.readFileSync(path.join(dir, '.github', 'workflows', 'wisdom.yml'), 'utf8')).jobs.wisdom.with.public, true);
    assert.equal(parse(fs.readFileSync(path.join(dir, 'wisdom-team.yaml'), 'utf8')).commits.public, true);
  } finally { await open.close(); }
  const closed = await github();
  try {
    const dir = repository();
    const s = stand(closed.base, { yes: question => !/without a sign-in anyway/.test(question) });
    await deployCommits(dir, s.io, { public: true });
    assert.equal(closed.seen.conversions, 1, 'declined: the sign-in app is made after all');
    assert.equal(parse(fs.readFileSync(path.join(dir, '.github', 'workflows', 'wisdom.yml'), 'utf8')).jobs.wisdom.with.public, undefined);
  } finally { await closed.close(); }
});
