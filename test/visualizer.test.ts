import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { commitFiles, git, gitText, recordRef, setRef } from '../src/team/gitrefs.js';
import type { CommitRecord } from '../src/team/commits.js';
import http from 'node:http';
import { githubApi } from '../src/team/github.js';
import { buildData, writeData, type BuildInput } from '../src/visualizer/build.js';
import { evidence, fixture, input } from './visualizer-fixture.js';
import { gatherGitHub } from '../src/visualizer/github.js';
import type * as C from '../src/visualizer/contract.js';

test('main shows each landed change once, newest first, with what the snapshot can prove', () => {
  const f = fixture();
  const files = buildData(input(f.dir, 'team'));
  const index = files.get('index.json') as C.Index;
  const entries = index.changes.entries;
  assert.deepEqual(entries.map(e => e.kind === 'change' ? `${e.how}:${e.change}` : `direct:${e.commit.sha}`),
    ['rebase:126', `direct:${f.d1}`, 'squash:124', 'merge:121', `direct:${f.teamOn}`]);
  // History from before team mode folds into one line.
  assert.equal(index.changes.earlier?.commits, 1);

  const rebase = files.get('change/126.json') as C.Change;
  assert.equal(rebase.status, 'attention');
  assert.deepEqual(rebase.landed?.onMain.map(m => m.sha), [f.r1, f.r2]);
  assert.ok(rebase.reasons.some(r => r.code === 'order-link'));

  const squash = files.get('change/124.json') as C.Change;
  assert.equal(squash.commits.length, 2, 'the squashed-away commits come from their records');
  assert.equal(squash.status, 'attention');
  assert.deepEqual(squash.needs.map(r => r.code), ['session-missing']);

  // What a change put on main has its own page, standing for the commits it came from, never counted twice.
  const onMain = files.get(`commit/${f.s124}.json`) as C.Commit;
  assert.equal(onMain.found.by, 'link');
  assert.equal(onMain.change, '124');
  assert.deepEqual(onMain.files.map(x => x.path).sort(), ['g1.txt', 'g2.txt']);
  assert.ok(onMain.reasons.some(r => r.code === 'session-missing'));
  assert.equal((files.get(`commit/${f.r2}.json`) as C.Commit).status, 'attention', 'a position-only link');
  assert.ok(!index.sessions.some(s => s.commits.includes(f.s124)));
  assert.equal(index.people.find(p => p.username === 'maya')?.commits, 8);
  assert.equal((files.get('change/121.json') as C.Change).status, 'good');
  assert.equal((files.get(`commit/${f.x1}.json`) as C.Commit).change, '121');

  const direct = files.get(`commit/${f.d1}.json`) as C.Commit;
  assert.equal(direct.status, 'attention');
  assert.deepEqual(direct.guide?.problems, ['t9 names no real step'], 'the guide check is re-run, not read from the record');

  const grey = files.get(`commit/${f.teamOn}.json`) as C.Commit;
  assert.equal(grey.status, 'none');
  assert.equal(grey.found.by, 'unlinked');

  // Work not on main: listed as a branch, not on main.
  assert.deepEqual(index.branches.map(b => [b.name, b.status]), [['feat/x', 'look']]);
  assert.equal(index.branches[0].change, undefined, 'team mode: a branch without a pull request opens no page yet');
  assert.ok(index.sessions.some(s => s.key === 'r1/sX'));
});

test('local mode gives every branch its own page, and the build is written whole with its manifest', () => {
  const f = fixture();
  const build = input(f.dir, 'local');
  const files = buildData(build);
  const branch = (files.get('index.json') as C.Index).branches[0];
  assert.equal(branch.change, 'b-feat_x');
  assert.equal((files.get('change/b-feat_x.json') as C.Change).pr, undefined);

  const out = path.join(f.dir, '..', `${path.basename(f.dir)}-out`);
  const { manifest } = writeData(out, build, files);
  assert.equal(manifest.mode, 'local');
  assert.equal(manifest.snapshot.head, git(f.dir, ['rev-parse', 'main']).toString('utf8').trim());
  assert.ok(manifest.files['index.json']);
  assert.ok(manifest.inputs[recordRef(f.f1)]);
  assert.ok(fs.existsSync(path.join(out, 'commit', `${f.f1}.json`)));
  assert.ok(!fs.existsSync(`${out}.building`));
});

/** GitHub stand-in: a local server answering in GitHub's shape, as links.test.ts does. */
async function githubStub(routes: Record<string, unknown>) {
  const server = http.createServer((request, response) => {
    const body = routes[request.url!.replace(/^\/repos\/acme\/app/, '')];
    response.writeHead(body === undefined ? 404 : 200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body ?? { message: 'Not Found' }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return { env: { GITHUB_API_URL: `http://127.0.0.1:${port}`, GITHUB_REPOSITORY: 'acme/app', GITHUB_TOKEN: 'test-token' } as NodeJS.ProcessEnv,
    close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}

test('with GitHub: pull request titles, branches and open pull requests, and usernames instead of git names', async () => {
  const f = fixture();
  const pull = (number: number, title: string, login: string, branch: string, merged = true) => ({ number, title, state: merged ? 'closed' : 'open',
    ...(merged ? { merged_at: '2026-11-20T00:00:00Z' } : {}), user: { login }, head: { ref: branch, repo: { full_name: 'acme/app' } } });
  const commits = (list: { sha: string; login: string; email?: string }[]) => list.map(c => ({ sha: c.sha, author: { login: c.login }, commit: { author: { email: c.email } } }));
  const page = '?per_page=100&page=1';
  const stub = await githubStub({
    '/pulls?state=open&per_page=100&page=1': [pull(130, 'Exponential backoff', 'leepark', 'feat/x', false)],
    '/pulls/121': pull(121, 'Bump express to 5.1', 'sokafor', 'chore/express-5'),
    '/pulls/124': pull(124, 'Healthcheck endpoint', 'leepark', 'feat/healthz'),
    '/pulls/126': pull(126, 'Docs cleanup', 'sokafor', 'docs/cleanup'),
    [`/pulls/121/commits${page}`]: commits([{ sha: f.x1, login: 'mayachen', email: 'maya@example.com' }]),
    [`/pulls/124/commits${page}`]: commits([{ sha: f.g1, login: 'leepark' }, { sha: f.g2, login: 'leepark' }]),
    [`/pulls/126/commits${page}`]: [], [`/pulls/130/commits${page}`]: [],
  });
  try {
    const github = await gatherGitHub(githubApi(f.dir, 'origin', stub.env)!, f.dir, 'refs/heads/main');
    assert.deepEqual(github.warnings, []);
    const files = buildData({ ...input(f.dir, 'team'), github });
    const squash = files.get('change/124.json') as C.Change;
    assert.deepEqual([squash.title, squash.author, squash.branch], ['Healthcheck endpoint', 'leepark', 'feat/healthz']);
    assert.deepEqual(squash.commits.map(c => c.author), ['leepark', 'leepark'], 'a squashed-away commit is named from GitHub');
    assert.equal((files.get(`commit/${f.x1}.json`) as C.Commit).author, 'mayachen');
    // The same email elsewhere gets the same username, and no git name or email is left.
    assert.equal((files.get(`commit/${f.teamOn}.json`) as C.Commit).author, 'mayachen');
    const index = files.get('index.json') as C.Index;
    assert.ok(!index.people.some(p => p.username === 'maya'));
    assert.ok(![...files.values()].some(value => JSON.stringify(value).includes('@example.com')), 'no email is written out');
    // An open pull request: its branch opens to it.
    assert.equal(index.branches[0].change, '130');
    const open = files.get('change/130.json') as C.Change;
    assert.deepEqual([open.state, open.title, open.pr], ['open', 'Exponential backoff', 130]);
  } finally { await stub.close(); }
});

test('real sessions: a fetched share file is read, its turns written one per file, and both checks re-run against it', async () => {
  const { randomUUID } = await import('node:crypto');
  const { startDaemon } = await import('../src/service/daemon.js');
  const { call } = await import('../src/service/client.js');
  const { draftShare, writeShare } = await import('../src/share/share.js');
  const { marker } = await import('../src/core/paths.js');
  const { storeEvidence, remoteSessions } = await import('../src/visualizer/evidence.js');
  const { sessionPath } = await import('../src/visualizer/contract.js');

  // A teammate's session: two turns, the second running a tool. Shared as a team push would.
  const sender = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wisdom-visualizer-sender-')));
  fs.mkdirSync(path.join(sender, '.wisdom'));
  fs.writeFileSync(path.join(sender, '.wisdom', marker), JSON.stringify({ project: sender }));
  const daemon = await startDaemon(path.join(sender, '.wisdom'), 0);
  try {
    const send = (type: string, extra: Record<string, unknown>) => call(daemon.connection, '/observe', { harness: 'claude-code', cwd: sender,
      observation: { observationId: randomUUID(), sessionId: 'sess-1', type, ...extra } });
    await send('input', { data: { text: 'Add a lockout counter' } });
    await send('input', { data: { text: 'Run the tests' } });
    await send('tool_started', { toolCallId: 'b1', toolName: 'Bash', data: { input: { command: 'npm test' } } });
    await send('tool_finished', { toolCallId: 'b1', toolName: 'Bash', data: { response: { stdout: '23 pass' } } });
    const draft = await draftShare(daemon.connection, ['sess-1']);
    const file = path.join(sender, 'out.wisdom-share');
    writeShare(draft, draft.findings, file);

    // A clone where a fetch brought that session and a record citing it at t2/c1, with hashes the session does not have.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wisdom-visualizer-real-'));
    const run = (...args: string[]) => gitText(dir, args);
    run('init', '-q', '-b', 'main'); run('config', 'user.name', 'maya'); run('config', 'user.email', 'maya@example.com');
    fs.writeFileSync(path.join(dir, 'wisdom-team.yaml'), 'repoId: test\n'); run('add', '-A'); run('commit', '-q', '-m', 'Turn on team mode');
    fs.writeFileSync(path.join(dir, 'lockout.ts'), 'x'); run('add', '-A'); run('commit', '-q', '-m', 'Lock after 5');
    const sha = run('rev-parse', 'HEAD');
    setRef(dir, 'refs/wisdom/fetched/sessions/r1/sess-1', commitFiles(dir, { 'session.wisdom-share': fs.readFileSync(file) }, 'session'));
    const value: CommitRecord = { kind: 'wisdom-commit-record', version: 1, commit: { sha, subject: 'Lock after 5', committedAt: '2026-11-20T10:00:00Z', tree: '' },
      made: 'commit', madeAt: '2026-11-20T10:00:00Z', wisdomVersion: 'test', recorder: 'r1',
      steps: [{ session: 'sess-1', position: 't2/c1', attribution: 'observed-during-tool', before: null, after: 'not-in-the-session' }],
      files: [{ path: 'lockout.ts', operation: 'modify' as never, added: 1, removed: 0, complete: true, chain: [0], pieces: [{ header: '@@ -0,0 +1 @@', steps: [0], unexplained: 0 }] }],
      sessions: [{ id: 'sess-1', harness: 'claude-code', recorder: 'r1', positions: ['t2/c1'] }] };
    setRef(dir, recordRef(sha), commitFiles(dir, { 'record.json': JSON.stringify(value) }, 'record'));

    const sessions = remoteSessions(dir, path.join(dir, '..', `${path.basename(dir)}-cache`));
    const build: BuildInput = { project: dir, mode: 'team', main: { name: 'main', ref: 'refs/heads/main' }, branches: [],
      evidence: storeEvidence(sessions.stores, sessions.ids, sessions.version), wisdomVersion: 'test' };
    const files = buildData(build);
    const commit = files.get(`commit/${sha}.json`) as C.Commit;
    assert.ok(commit.sessionsNamed[0].present, 'the fetched session is here');
    assert.ok(!commit.reasons.some(r => r.code === 'session-missing'));
    assert.ok(commit.reasons.some(r => r.code === 'step-changed' && r.detail === 't2/c1'), 'the step is checked against the session, not taken from the record');
    assert.equal(commit.status, 'attention');

    const base = sessionPath('r1/sess-1');
    const listing = files.get(`${base}/index.json`) as C.SessionTurns;
    assert.equal(listing.title, 'Add a lockout counter');
    assert.deepEqual(listing.turnList.map(t => [t.turn, t.request, t.cited]), [[1, 'Add a lockout counter', []], [2, 'Run the tests', [sha]]]);

    const out = path.join(dir, '..', `${path.basename(dir)}-out`);
    const first = writeData(out, build, files);
    const turnFile = path.join(out, ...`${base}/t2.json`.split('/'));
    const turn = JSON.parse(fs.readFileSync(turnFile, 'utf8')) as C.Turn;
    assert.equal(turn.request, 'Run the tests');
    assert.ok(turn.items.some(item => item.kind === 'tool' && item.name === 'Bash'), 'the turn is assembled as the Usage dashboard shows it');
    assert.equal(first.reused, 0);

    // The same snapshot again: every turn is copied from the last build, none assembled.
    let assembled = 0;
    const counting: BuildInput = { ...build, evidence: { ...build.evidence, turns: id => build.evidence.turns!(id).map(t => ({ ...t, items: () => { assembled++; return t.items(); } })) } };
    const second = writeData(out, counting, buildData(counting));
    assert.equal(second.reused, 2);
    assert.equal(assembled, 0);
    assert.deepEqual(second.manifest.files[`${base}/t2.json`], first.manifest.files[`${base}/t2.json`]);
    assert.ok(fs.existsSync(turnFile));

    // A new version of the session (a later push): its turns are assembled again.
    const changed: BuildInput = { ...counting, evidence: { ...counting.evidence, version: () => 'a-new-version' } };
    const third = writeData(out, changed, buildData(changed));
    assert.equal(third.reused, 0);
    assert.equal(assembled, 2);
  } finally { await daemon.close(); }
});
