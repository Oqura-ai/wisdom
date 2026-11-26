/**
 * `wisdom commits deploy`: set up the team's Commits dashboard (design policy 5.24-5.28), once,
 * by an admin, from a team-mode repository's checkout. Run again to fix or change the setup.
 *
 *   1. The repository: team mode, a GitHub remote; private (a GitHub sign-in, the default) or
 *      public (no sign-in, only on purpose). A company needs Vercel Pro (5.27).
 *   2. Vercel: logged in, the project created or linked, its production address confirmed by
 *      finding a one-time marker there (a placeholder page, never over a running dashboard).
 *   3. The GitHub App the sign-in uses, made from a manifest (live test 2): Metadata read, no
 *      webhook, its callback the confirmed address. Installed on this repository only, which
 *      is asked of GitHub as the app while its private key is in memory; the key is then dropped.
 *   4. Its client ID and secret, and a new cookie key, as the Vercel project's environment.
 *   5. The CI's Vercel token, as the repository's secret WISDOM_VERCEL_TOKEN: `gh secret set`
 *      asks for it itself, or GitHub's secrets page takes the paste. Wisdom never sees it.
 *   6. `.github/workflows/wisdom.yml` (one job calling Wisdom's reusable workflow), and the
 *      dashboard's address in wisdom-team.yaml, for the admin to commit.
 *
 * Each step that writes anywhere asks first. Everything outside Wisdom goes through `DeployIO`,
 * so the whole flow is tested with stand-ins (test/commits-deploy.test.ts).
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createSign, randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { gitText, POLICY_FILE, readPolicy, topLevel } from '../team/gitrefs.js';
import { repositoryFromUrl } from '../team/github.js';
import { defaultBranch, workflowFile as relinkWorkflowFile } from '../team/relink.js';
import { teamWorkflowText } from './ci.js';

/** The Vercel CLI version deploy and CI run (the one the live test used). */
export const VERCEL_CLI = 'vercel@67';
export const TOKEN_SECRET = 'WISDOM_VERCEL_TOKEN';
export const ENV_NAMES = { clientId: 'WISDOM_GITHUB_CLIENT_ID', clientSecret: 'WISDOM_GITHUB_CLIENT_SECRET', cookieKey: 'WISDOM_COOKIE_KEY' } as const;

export interface Run { status: number; stdout: string; stderr: string }

/** Everything deploy does outside Wisdom: the terminal, the browser, the Vercel CLI, gh, GitHub. */
export interface DeployIO {
  say(line: string): void;
  /** A yes/no question; undefined with no terminal to ask in. */
  yes(question: string): Promise<boolean | undefined>;
  /** A line of text (Enter alone: ''). */
  ask(question: string): Promise<string>;
  /** Open a page in the browser (the address is always printed too). */
  open(url: string): void;
  /** The Vercel CLI in `cwd`; `interactive` hands it the terminal (to log in). */
  vercel(args: string[], options: { cwd: string; input?: string; interactive?: boolean }): Run;
  /** GitHub's CLI, when installed: undefined when it is not. */
  gh(args: string[], options?: { interactive?: boolean }): Run | undefined;
  fetch: typeof fetch;
  /** GitHub's web and API addresses (tests point them at a stand-in). */
  web: string; api: string;
}

export interface DeployState { url?: string; vercelProject?: string; githubApp?: string; public?: boolean }

const marker = () => `wisdom-placeholder-${randomBytes(8).toString('hex')}`;
const slugify = (text: string) => text.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 52) || 'wisdom-commits';

/** The repository this checkout's remote is on GitHub, as owner/name. */
function repositoryOf(project: string, remote: string): string {
  let url = '';
  try { url = gitText(project, ['remote', 'get-url', remote]); } catch { /* no such remote */ }
  const repository = repositoryFromUrl(url);
  if (!repository) throw new Error(`The remote "${remote}" is not on GitHub${url ? ` (${url})` : ''}: the dashboard's sign-in is a GitHub App, so it needs a GitHub repository.`);
  return repository;
}

/** The dashboard's settings in wisdom-team.yaml (`commits:`), for a rerun. */
export function readDeployState(project: string): DeployState {
  const policy = readPolicy(project) as { commits?: DeployState } | undefined;
  return policy?.commits ?? {};
}

/** Write `commits:` into wisdom-team.yaml. Only that block is written (appended, or put in place
 * of the one there): every other line stays byte for byte, the admin's comments and alignment too. */
export function writeDeployState(project: string, state: DeployState): void {
  const file = path.join(project, POLICY_FILE);
  const lines = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n').replace(/\n*$/, '').split('\n');
  const block = ['commits:', ...Object.entries(state).filter(([, value]) => value !== undefined).map(([key, value]) => `  ${key}: ${JSON.stringify(value)}`)];
  const start = lines.findIndex(line => /^commits:\s*(#.*)?$/.test(line));
  if (start < 0) lines.push('', '# The team\'s Commits dashboard: wisdom commits deploy writes this (docs/team.md#commits-for-your-team)', ...block);
  else {
    let end = start + 1;
    while (end < lines.length && (/^\s/.test(lines[end]) || lines[end] === '')) end++;
    lines.splice(start, end - start, ...block);
  }
  fs.writeFileSync(file, lines.join('\n') + '\n');
  // Still a policy this version reads, or nothing is left half written for the team to commit.
  readPolicy(project);
}

/** A JSON Web Token as the GitHub App, to ask GitHub one thing as it (whether it is installed). */
function appToken(appId: number, pem: string): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${part({ alg: 'RS256', typ: 'JWT' })}.${part({ iat: now - 60, exp: now + 540, iss: String(appId) })}`;
  return `${unsigned}.${createSign('RSA-SHA256').update(unsigned).sign(pem).toString('base64url')}`;
}

/** The manifest flow (live test 2): a page on 127.0.0.1 that hands GitHub the manifest, and takes
 * back the code GitHub returns, swapped at once for the app's keys. */
async function createApp(io: DeployIO, manifest: Record<string, unknown>, owner: { login: string; organization: boolean }): Promise<{ id: number; slug: string; client_id: string; client_secret: string; pem: string }> {
  const state = randomBytes(16).toString('hex');
  let done!: (value: any) => void, fail!: (error: Error) => void;
  const created = new Promise<any>((resolve, reject) => { done = resolve; fail = reject; });
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const page = (html: string) => { response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); response.end(`<!doctype html><meta charset="utf-8"><body style="font:15px/1.5 system-ui;max-width:560px;margin:15vh auto">${html}</body>`); };
    if (url.pathname === '/') {
      const action = owner.organization ? `${io.web}/organizations/${owner.login}/settings/apps/new` : `${io.web}/settings/apps/new`;
      const value = JSON.stringify({ ...manifest, redirect_url: `http://127.0.0.1:${port}/created` }).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
      return page(`<form id="f" method="post" action="${action}?state=${state}"><input type="hidden" name="manifest" value="${value}">
        <p>Wisdom is creating the dashboard's sign-in app on GitHub. Press the button if nothing happens.</p><button>Continue to GitHub</button></form>
        <script>document.getElementById('f').submit()</script>`);
    }
    if (url.pathname === '/created') {
      if (url.searchParams.get('state') !== state) { page('<p>This answer is not from the setup Wisdom started. Run wisdom commits deploy again.</p>'); return; }
      try {
        const answer = await io.fetch(`${io.api}/app-manifests/${url.searchParams.get('code')}/conversions`, { method: 'POST', headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'wisdom-commits' } });
        if (answer.status !== 201) throw new Error(`GitHub answered ${answer.status} while creating the app`);
        const app = await answer.json();
        page(`<p>The sign-in app <b>${String(app.slug).replace(/[<>&]/g, '')}</b> is created. Go back to the terminal.</p>`);
        done(app);
      } catch (error) { page('<p>The app could not be created; the terminal says why.</p>'); fail(error as Error); }
      return;
    }
    response.writeHead(404); response.end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const timer = setTimeout(() => fail(new Error('No answer from GitHub within 10 minutes. Run wisdom commits deploy again.')), 10 * 60_000);
  try {
    io.say(`Opening GitHub to create the sign-in app (it asks only for Metadata: read). Press "Create GitHub App" there.\n  If no browser opens: http://127.0.0.1:${port}/`);
    io.open(`http://127.0.0.1:${port}/`);
    return await created;
  } finally { clearTimeout(timer); server.close(); }
}

export async function deployCommits(cwd: string, io: DeployIO, options: { public?: boolean } = {}): Promise<{ url: string; written: string[] }> {
  const project = topLevel(cwd);
  const policy = readPolicy(project);
  if (!policy) throw new Error(`The team's Commits dashboard is for a team-mode repository: ${POLICY_FILE} is not here. An admin starts team mode with: wisdom team init`);
  const remote = policy.remote ?? 'origin';
  const repository = repositoryOf(project, remote);
  const [owner, name] = repository.split('/');
  const main = defaultBranch(project, remote);
  const earlier = readDeployState(project);
  const written: string[] = [];

  // ----- 1. private or public -----
  let isPublic = false;
  try { const answer = await io.fetch(`${io.api}/repos/${repository}`, { headers: { 'User-Agent': 'wisdom-commits' } }); isPublic = answer.status === 200 && (await answer.json()).private === false; } catch { /* unknown: private */ }
  let open = !!options.public;
  if (open && !isPublic) {
    io.say(`${repository} is private, or GitHub would not say. Without a sign-in, anyone with the dashboard's link would read its commits and every recorded session.`);
    if (!await io.yes('Deploy it without a sign-in anyway?')) open = false;
  }
  io.say(open ? `The dashboard will be public: no sign-in.` : `The dashboard's link will be open, its data only for people who can read ${repository} on GitHub (they sign in with GitHub).`);
  io.say('It runs on Vercel. Vercel\'s free Hobby plan is for personal and non-commercial use only: a company\'s dashboard needs Vercel Pro. Only whoever deploys needs a Vercel seat; everyone else signs in with GitHub.');

  // ----- 2. Vercel -----
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'wisdom-deploy-'));
  try {
    if (io.vercel(['whoami'], { cwd: work }).status !== 0) {
      io.say('Log in to Vercel (once on this machine):');
      if (io.vercel(['login'], { cwd: work, interactive: true }).status !== 0) throw new Error('Not logged in to Vercel. Run wisdom commits deploy again.');
    }
    const scopeAnswer = (await io.ask('The Vercel team to deploy under (its slug, as in vercel.com/<slug>), or Enter for your default: ')).trim();
    const scope = scopeAnswer ? ['--scope', scopeAnswer] : [];
    const projectName = earlier.vercelProject ?? slugify(`wisdom-${name}`);
    const linked = io.vercel(['link', '--yes', '--project', projectName, ...scope], { cwd: work });
    if (linked.status !== 0) throw new Error(`Vercel could not create or link the project ${projectName}: ${(linked.stderr || linked.stdout).trim()}`);
    const { projectId, orgId } = JSON.parse(fs.readFileSync(path.join(work, '.vercel', 'project.json'), 'utf8')) as { projectId: string; orgId: string };
    io.say(`Vercel project: ${projectName}`);

    // The production address: a running dashboard answers its gate; otherwise a placeholder proves it.
    let url = earlier.url;
    const ours = async (address: string, expect?: string) => {
      try {
        const answer = await io.fetch(`${address.replace(/\/+$/, '')}${expect ? '/' : '/data/manifest.json'}`, { redirect: 'manual' });
        if (expect) return (await answer.text()).includes(expect);
        return [200, 401, 403, 500].includes(answer.status);
      } catch { return false; }
    };
    if (!url || !await ours(url)) {
      const sign = marker();
      const output = path.join(work, '.vercel', 'output');
      fs.mkdirSync(path.join(output, 'static'), { recursive: true });
      fs.writeFileSync(path.join(output, 'config.json'), JSON.stringify({ version: 3 }));
      fs.writeFileSync(path.join(output, 'static', 'index.html'), `<!doctype html><meta charset="utf-8"><title>Wisdom Commits</title><p>The team's Commits dashboard is being set up. (${sign})</p>`);
      io.say('Deploying a placeholder page, to learn the dashboard\'s address…');
      const placed = io.vercel(['deploy', '--prebuilt', '--prod', '--yes', ...scope], { cwd: work });
      if (placed.status !== 0) throw new Error(`Vercel could not deploy: ${(placed.stderr || placed.stdout).trim()}`);
      url = `https://${projectName}.vercel.app`;
      for (let attempt = 0; !await ours(url, sign); attempt++) {
        if (attempt >= 3) throw new Error('The placeholder was not found at the address given. Run wisdom commits deploy again.');
        const typed = (await io.ask(`The placeholder is not at ${url}. Its production address (Vercel: the project's Domains), as https://…: `)).trim();
        if (/^https:\/\/[^\s/]+$/.test(typed)) url = typed;
      }
    }
    io.say(`The dashboard's address: ${url}`);

    // ----- 3. the GitHub App -----
    let app: { id: number; slug: string; client_id: string; client_secret: string; pem: string } | undefined;
    if (!open) {
      const keep = earlier.githubApp && earlier.url === url ? await io.yes(`Keep the sign-in app ${earlier.githubApp} made before (no to make a new one)?`) : false;
      if (!keep) {
        let organization = false;
        try { const answer = await io.fetch(`${io.api}/users/${owner}`, { headers: { 'User-Agent': 'wisdom-commits' } }); organization = answer.ok && (await answer.json()).type === 'Organization'; } catch { /* a person */ }
        app = await createApp(io, {
          name: `wisdom-${name}`.slice(0, 26) + '-' + randomBytes(3).toString('hex'),
          url, description: `Sign-in for the Wisdom Commits dashboard of ${repository}.`,
          hook_attributes: { url, active: false }, callback_urls: [`${url}/auth/callback`],
          public: false, request_oauth_on_install: false, default_permissions: { metadata: 'read' }, default_events: [],
        }, { login: owner, organization });
        io.say(`Sign-in app created: ${app.slug}. Install it on ${repository} only (choose "Only select repositories").`);
        // Installed? Asked as the app, while its key is here; then the key is forgotten.
        for (let attempt = 0; ; attempt++) {
          io.open(`${io.web}/apps/${app.slug}/installations/new`);
          await io.ask(`  ${io.web}/apps/${app.slug}/installations/new\n  Press Enter once it is installed on ${repository}: `);
          const answer = await io.fetch(`${io.api}/repos/${repository}/installation`, { headers: { Authorization: `Bearer ${appToken(app.id, app.pem)}`, Accept: 'application/vnd.github+json', 'User-Agent': 'wisdom-commits' } }).catch(() => undefined);
          if (answer?.status === 200) { io.say(`Installed on ${repository}.`); break; }
          if (attempt >= 2) { io.say(`GitHub does not show it installed on ${repository} yet. Nobody can sign in until it is: ${io.web}/apps/${app.slug}/installations/new`); break; }
          io.say(`GitHub does not show it installed on ${repository} yet.`);
        }
        app.pem = '';
      }
    }

    // ----- 4. the gate's secrets, on Vercel -----
    if (app) {
      const keys = { [ENV_NAMES.clientId]: app.client_id, [ENV_NAMES.clientSecret]: app.client_secret, [ENV_NAMES.cookieKey]: randomBytes(32).toString('hex') };
      if (await io.yes(`Store the sign-in app's client ID and secret and a new cookie key as ${projectName}'s environment variables on Vercel (production)?`)) {
        for (const [key, value] of Object.entries(keys)) {
          io.vercel(['env', 'rm', key, 'production', '--yes', ...scope], { cwd: work });
          const added = io.vercel(['env', 'add', key, 'production', ...scope], { cwd: work, input: value });
          if (added.status !== 0) throw new Error(`Vercel did not take ${key}: ${(added.stderr || added.stdout).trim()}`);
        }
        io.say('Stored. A new cookie key signs everyone out once, which is all it changes.');
      } else io.say('Not stored: the dashboard cannot sign anyone in until they are. Run wisdom commits deploy again to make a new app and store them.');
    }

    // ----- 5. the CI's token, as the repository's secret -----
    io.say(`CI deploys with a Vercel token. Create one on the page that opens (name it "wisdom ${name}", scope: ${scopeAnswer || 'your account'}), and copy it.`);
    io.open('https://vercel.com/account/tokens');
    const gh = io.gh(['auth', 'status']);
    let stored = false;
    if (gh?.status === 0 && await io.yes(`Store it as ${repository}'s secret ${TOKEN_SECRET} with gh (gh asks you to paste it)?`)) {
      stored = io.gh(['secret', 'set', TOKEN_SECRET, '--repo', repository], { interactive: true })?.status === 0;
    }
    if (!stored) {
      const page = `${io.web}/${repository}/settings/secrets/actions/new`;
      io.say(`Add it on GitHub: name ${TOKEN_SECRET}, the token as its value, then "Add secret".\n  ${page}`);
      io.open(page);
      await io.ask('Press Enter once it is added: ');
    }

    // ----- 6. the workflow and the team file -----
    const file = path.join(project, '.github', 'workflows', 'wisdom.yml');
    const text = teamWorkflowText(main, { orgId, projectId, ...(open ? { public: true } : {}) });
    const mine = !fs.existsSync(file) || fs.readFileSync(file, 'utf8').includes('Written by Wisdom');
    if (mine || await io.yes(`${path.relative(project, file)} is there and not Wisdom's. Replace it?`)) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text);
      written.push(path.relative(project, file));
    }
    const old = relinkWorkflowFile(project);
    if (fs.existsSync(old) && await io.yes(`${path.relative(project, old)} relinks after merges, and so does the new file: remove the old one, so links are not written twice?`)) {
      fs.rmSync(old);
      written.push(`${path.relative(project, old)} (removed)`);
    }
    writeDeployState(project, { url, vercelProject: projectName, ...(app ? { githubApp: app.slug } : earlier.githubApp && !open ? { githubApp: earlier.githubApp } : {}), ...(open ? { public: true } : {}) });
    written.push(POLICY_FILE);
    io.say(`\nDone. Commit and push to ${main}: ${written.filter(w => !w.endsWith('(removed)')).join(', ')}${written.some(w => w.endsWith('(removed)')) ? `, and the removal of ${relinkWorkflowFile(project).slice(project.length + 1)}` : ''}.`);
    io.say(`The push starts the first build; a few minutes later the dashboard is at ${url}.`);
    return { url, written };
  } finally { fs.rmSync(work, { recursive: true, force: true }); }
}

// ---------- the real terminal, browser and CLIs ----------

const win = process.platform === 'win32';
function run(command: string, args: string[], options: { cwd?: string; input?: string; interactive?: boolean }): Run {
  const result = spawnSync(command, args, { cwd: options.cwd, input: options.input, encoding: 'utf8', windowsHide: true, shell: win,
    stdio: options.interactive ? 'inherit' : ['pipe', 'pipe', 'pipe'] });
  return { status: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.error ? result.error.message : result.stderr ?? '' };
}

export function terminalIO(): DeployIO {
  const tty = !!process.stdin.isTTY;
  const question = async (text: string) => {
    if (!tty) throw new Error('wisdom commits deploy asks questions as it goes: run it in a terminal.');
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    try { return await prompt.question(text); } finally { prompt.close(); }
  };
  return {
    say: line => console.log(line),
    yes: async text => tty ? /^y(es)?$/i.test((await question(`${text} [y/N] `)).trim()) : undefined,
    ask: question,
    open: url => {
      const [command, args] = win ? ['cmd', ['/c', 'start', '""', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
      try { spawn(command, args as string[], { stdio: 'ignore', detached: true, windowsHide: true }).on('error', () => {}).unref(); } catch { /* the address is printed */ }
    },
    vercel: (args, options) => run(win ? 'npx.cmd' : 'npx', ['--yes', VERCEL_CLI, ...args], options),
    gh: (args, options = {}) => {
      const found = run(win ? 'where' : 'which', ['gh'], {});
      return found.status === 0 ? run('gh', args, options) : undefined;
    },
    fetch,
    web: 'https://github.com', api: 'https://api.github.com',
  };
}
