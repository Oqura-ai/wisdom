import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { gitText } from '../src/team/gitrefs.js';
import { buildTeam, REUSABLE, teamWorkflowText } from '../src/visualizer/ci.js';
import { pruneDeployments } from '../src/visualizer/vercel.js';
import { fixture } from './visualizer-fixture.js';
import type * as C from '../src/visualizer/contract.js';

const root = fileURLToPath(new URL('../../', import.meta.url));

/** The fixture pushed to a bare "remote" the way team mode keeps it (refs/wisdom/<repoId>/...),
 * then cloned fresh, as actions/checkout leaves a CI runner: branches as origin/*, no Wisdom refs. */
function remoteAndClone() {
  const f = fixture();
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'wisdom-commits-ci-'));
  const remote = path.join(temp, 'remote.git'), work = path.join(temp, 'work');
  // Its HEAD on main, as GitHub's is on the default branch.
  gitText(temp, ['init', '-q', '--bare', '-b', 'main', remote]);
  gitText(f.dir, ['push', '-q', remote, 'main', 'feat/x', 'refs/wisdom/records/*:refs/wisdom/testrepo1/records/*', 'refs/wisdom/links/*:refs/wisdom/testrepo1/links/*']);
  gitText(temp, ['clone', '-q', remote, work]);
  // A policy this version reads (the fixture's own team file is a placeholder), in the working tree.
  fs.writeFileSync(path.join(work, 'wisdom-team.yaml'), 'version: 1\nrepoId: testrepo1\nremote: origin\n');
  const app = path.join(temp, 'app');
  fs.mkdirSync(app);
  fs.writeFileSync(path.join(app, 'index.html'), '<!doctype html><title>Commits</title>');
  return { f, work, app };
}

test('commits build: the remote fetched whole into a fresh clone, built, and written as a site behind the sign-in', async () => {
  const { f, work, app } = remoteAndClone();
  assert.equal(gitText(work, ['for-each-ref', 'refs/wisdom/']), '', 'a fresh clone has none of Wisdom\'s refs');
  // GitHub answers nothing useful here: the build goes on without its facts.
  const github = http.createServer((_, response) => { response.writeHead(404, { 'Content-Type': 'application/json' }); response.end('{}'); });
  await new Promise<void>(resolve => github.listen(0, '127.0.0.1', resolve));
  try {
    const env = { GITHUB_REPOSITORY: 'acme/app', GITHUB_API_URL: `http://127.0.0.1:${(github.address() as { port: number }).port}`, VERCEL_ORG_ID: 'team_x', VERCEL_PROJECT_ID: 'prj_y' };
    const built = await buildTeam(work, { app, env });
    const index = JSON.parse(fs.readFileSync(path.join(built.data, 'index.json'), 'utf8')) as C.Index;
    assert.deepEqual(index.changes.entries.map(e => e.kind === 'change' ? `${e.how}:${e.change}` : `direct:${e.commit.sha}`),
      ['rebase:126', `direct:${f.d1}`, 'squash:124', 'merge:121', `direct:${f.teamOn}`], 'the same main as built from the fixture itself');
    assert.equal(index.since, 'team-mode');
    assert.deepEqual(index.branches.map(b => b.name), ['feat/x'], 'branches come from the remote');
    const manifest = JSON.parse(fs.readFileSync(path.join(built.data, 'manifest.json'), 'utf8')) as C.Manifest;
    assert.equal(manifest.mode, 'team');
    assert.equal(manifest.repository, 'acme/app');
    assert.ok(Object.keys(manifest.inputs).some(ref => ref.startsWith('refs/wisdom/records/')), 'the records were fetched');

    const output = path.join(built.site, '.vercel', 'output');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(output, 'functions', 'gate.func', 'gate.json'), 'utf8')), { repo: 'acme/app' });
    assert.ok(fs.existsSync(path.join(output, 'functions', 'gate.func', 'data', 'index.json')));
    assert.ok(!fs.existsSync(path.join(output, 'static', 'data')));
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(built.site, '.vercel', 'project.json'), 'utf8')), { orgId: 'team_x', projectId: 'prj_y' });
    assert.ok(built.lines.some(line => line.startsWith('GitHub')), 'it says GitHub gave nothing');

    // Public only when asked; a private dashboard without a repository name has no gate to make.
    const open = await buildTeam(work, { app, public: true, env: {} });
    assert.ok(fs.existsSync(path.join(open.site, '.vercel', 'output', 'static', 'data', 'index.json')));
    await assert.rejects(buildTeam(work, { app, env: {} }), /needs the GitHub repository/);
  } finally { await new Promise<void>(resolve => github.close(() => resolve())); }
});

test('the workflows: the team\'s one file calls Wisdom\'s reusable one, which checks, relinks, builds, deploys and prunes', () => {
  // The team's file, with and without the dashboard.
  const plain = parse(teamWorkflowText('main'));
  assert.equal(plain.jobs.wisdom.uses, REUSABLE);
  assert.equal(plain.on.schedule, undefined, 'no backstop without a dashboard to refresh');
  assert.equal(plain.jobs.wisdom.secrets, undefined);
  const full = parse(teamWorkflowText('trunk', { orgId: 'team_x', projectId: 'prj_y' }));
  assert.deepEqual(full.on.push.branches, ['trunk']);
  assert.ok(full.on.schedule[0].cron && 'workflow_dispatch' in full.on);
  assert.deepEqual(full.jobs.wisdom.with, { main: 'trunk', commits: true, 'vercel-org-id': 'team_x', 'vercel-project-id': 'prj_y' });
  assert.equal(full.jobs.wisdom.secrets.VERCEL_TOKEN, '${{ secrets.WISDOM_VERCEL_TOKEN }}');
  assert.equal(full.permissions.contents, 'write', 'relink pushes link refs');
  assert.equal(full.permissions.checks, 'write', 'a called workflow gets no more than its caller grants: the check run needs it here too');
  assert.equal(parse(teamWorkflowText('main', { orgId: 'a', projectId: 'b', public: true })).jobs.wisdom.with.public, true);

  // Wisdom's reusable workflow, as published.
  const reusable = parse(fs.readFileSync(path.join(root, '.github', 'workflows', 'wisdom.yml'), 'utf8'));
  assert.deepEqual(Object.keys(reusable.on), ['workflow_call'], 'it never runs by itself');
  const steps = (job: string) => reusable.jobs[job].steps.map((s: { run?: string; uses?: string }) => s.run ?? s.uses).join('\n');
  assert.match(steps('check'), /wisdom check --range/);
  assert.match(steps('relink'), /wisdom team relink --range/);
  assert.equal(reusable.jobs.relink.permissions.contents, 'write');
  assert.equal(reusable.jobs.check.permissions.checks, 'write', 'the check posts its result as a check run');
  const commits = reusable.jobs.commits;
  assert.equal(commits.needs, 'relink', 'built after relink, so a merge\'s new links count');
  assert.equal(commits.concurrency['cancel-in-progress'], true, 'the newest build wins');
  assert.match(commits.if, /head\.repo\.full_name == github\.repository/, 'a fork\'s pull request, which gets no secrets, is not built');
  const order = ['actions/cache', 'wisdom commits build', 'deploy --prebuilt --prod', 'wisdom commits prune'].map(part => steps('commits').indexOf(part));
  assert.ok(order.every((at, k) => at >= 0 && (k === 0 || at > order[k - 1])), `cache, build, deploy, prune, in that order: ${order}`);
  assert.equal(commits.permissions.contents, 'read', 'the dashboard build changes nothing in the repository');
});

test('commits prune: older finished production deployments go, the newest stays, nothing in progress or by hand is touched', async () => {
  const day = 86_400_000, now = Date.now();
  const all = [
    { uid: 'd-new', url: 'new.vercel.app', created: now, state: 'READY', target: 'production' },
    { uid: 'd-building', url: 'building.vercel.app', created: now + 1, state: 'BUILDING', target: 'production' },
    { uid: 'd-preview', url: 'preview.vercel.app', created: now - day, state: 'READY', target: null },
    { uid: 'd-old', url: 'old.vercel.app', created: now - day, state: 'READY', target: 'production' },
    { uid: 'd-failed', url: 'failed.vercel.app', created: now - 2 * day, state: 'ERROR', target: 'production' },
    { uid: 'd-older', url: 'older.vercel.app', created: now - 3 * day, state: 'READY', target: 'production' },
  ];
  const deleted: string[] = [], asked: URL[] = [];
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://vercel');
    asked.push(url);
    const send = (status: number, body: unknown) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(body)); };
    if (request.headers.authorization !== 'Bearer tok') return send(403, {});
    if (request.method === 'GET' && url.pathname === '/v7/deployments') {
      // Two pages, as Vercel pages a long list.
      const second = url.searchParams.get('until') === 'p2';
      return send(200, { deployments: second ? all.slice(3) : all.slice(0, 3), pagination: second ? {} : { next: 'p2' } });
    }
    if (request.method === 'DELETE' && url.pathname.startsWith('/v13/deployments/')) { deleted.push(url.pathname.split('/').pop()!); return send(200, { state: 'DELETED' }); }
    send(404, {});
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const api = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const result = await pruneDeployments({ token: 'tok', projectId: 'prj_y', orgId: 'team_x', api });
    assert.deepEqual(result.kept, ['new.vercel.app']);
    assert.deepEqual(deleted.sort(), ['d-failed', 'd-old', 'd-older']);
    assert.ok(asked.every(url => url.searchParams.get('teamId') === 'team_x'), 'a team\'s project is asked under the team');
    assert.equal(asked[0].searchParams.get('projectId'), 'prj_y');
    // A personal account: no team in the question. A wrong token: said plainly.
    asked.length = 0;
    await pruneDeployments({ token: 'tok', projectId: 'prj_y', orgId: 'personal', api });
    assert.ok(asked.every(url => !url.searchParams.has('teamId')));
    await assert.rejects(pruneDeployments({ token: 'nope', projectId: 'prj_y', api }), /403.*token/);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
