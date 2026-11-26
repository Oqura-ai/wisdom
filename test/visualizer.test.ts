import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { commitFiles, git, gitText, recordRef, setRef } from '../src/team/gitrefs.js';
import { writeLink } from '../src/team/links.js';
import type { CommitRecord } from '../src/team/commits.js';
import http from 'node:http';
import { githubApi } from '../src/team/github.js';
import { buildData, writeData, type BuildInput, type Evidence } from '../src/visualizer/build.js';
import { gatherGitHub } from '../src/visualizer/github.js';
import type * as C from '../src/visualizer/contract.js';

/** A repository with each way a change lands on main, records and links written straight into
 * Wisdom's refs (no harness, no daemon), and a branch with work not on main. */
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wisdom-visualizer-'));
  const run = (...args: string[]) => gitText(dir, args);
  run('init', '-q', '-b', 'main');
  run('config', 'user.name', 'maya'); run('config', 'user.email', 'maya@example.com');
  const commit = (file: string, text: string, message: string) => {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), text);
    run('add', '-A'); run('commit', '-q', '-m', message);
    return run('rev-parse', 'HEAD');
  };
  const record = (sha: string, subject: string, options: { sessions?: string[]; guide?: string; twoSessions?: boolean; parent?: string } = {}) => {
    const sessions = options.sessions ?? ['s1'];
    const steps = sessions.map((id, k) => ({ session: id, position: `t${k + 1}/c1`, attribution: 'observed-during-tool', before: null, after: `h${k}` }));
    const value: CommitRecord = {
      kind: 'wisdom-commit-record', version: 1, commit: { sha, parent: options.parent, subject, committedAt: '2026-11-20T10:00:00Z', tree: '' },
      made: 'commit', madeAt: '2026-11-20T10:00:00Z', wisdomVersion: 'test', recorder: 'r1', steps,
      files: [{ path: `${subject}.txt`, operation: 'modify' as never, added: 1, removed: 0, complete: true, chain: steps.map((_, k) => k),
        pieces: [{ header: '@@ -1 +1 @@', steps: options.twoSessions ? steps.map((_, k) => k) : [0], unexplained: 0 }] }],
      sessions: sessions.map(id => ({ id, harness: 'claude-code', recorder: 'r1', positions: ['t1/c1'] })),
      guide: { text: options.guide ?? '## Summary\nfine', writtenAt: '2026-11-20T10:01:00Z', writer: 'test', problems: [], derived: true },
    };
    setRef(dir, recordRef(sha), commitFiles(dir, { 'record.json': JSON.stringify(value) }, 'record'));
  };

  commit('README.md', 'hello', 'Before team mode');
  const teamOn = commit('wisdom-team.yaml', 'repoId: test\n', 'Turn on team mode');
  // A merge commit: the branch's commit stays on main.
  run('checkout', '-q', '-b', 'chore/express-5');
  const x1 = commit('package.json', '{}', 'Bump express to 5.1');
  record(x1, 'x1');
  run('checkout', '-q', 'main');
  run('merge', '-q', '--no-ff', '-m', 'Merge pull request #121 from org/chore/express-5', '-m', 'Bump express to 5.1', 'chore/express-5');
  // A squash merge: the pull request's commits are gone from git, their records and the link stay.
  const g1 = 'a'.repeat(40), g2 = 'b'.repeat(40);
  record(g1, 'g1'); record(g2, 'g2', { sessions: ['sX'] });
  const s124 = commit('health.ts', 'ok', 'Healthcheck endpoint (#124)');
  writeLink(dir, { commit: s124, from: [g1, g2], how: 'squash-merge', basis: 'github', writer: 'ci', pr: 124 });
  // A direct commit whose guide fails its check.
  const d1 = commit('Dockerfile', 'FROM node', 'Pin Node 24');
  record(d1, 'd1', { guide: 'BAD guide' });
  // A rebase merge: two new commits, the second linked by position only.
  const o1 = 'c'.repeat(40), o2 = 'd'.repeat(40);
  record(o1, 'o1'); record(o2, 'o2');
  const r1 = commit('docs/a.md', 'a', 'Fix doc links');
  const r2 = commit('docs/b.md', 'b', 'Reword setup');
  writeLink(dir, { commit: r1, from: [o1], how: 'rebase-merge', basis: 'patch-id', writer: 'ci', pr: 126 });
  writeLink(dir, { commit: r2, from: [o2], how: 'rebase-merge', basis: 'order', writer: 'ci', pr: 126 });
  // Work not on main yet: one piece made by two sessions.
  run('checkout', '-q', '-b', 'feat/x');
  const f1 = commit('x.ts', 'x', 'Try backoff');
  record(f1, 'f1', { sessions: ['s1', 's2'], twoSessions: true });
  run('checkout', '-q', 'main');
  return { dir, teamOn, x1, s124, d1, r1, r2, f1, g1, g2 };
}

const evidence: Evidence = {
  session: id => id === 'sX' ? undefined : { harness: 'claude-code', title: `session ${id}`, turns: 3 },
  step: () => 'ok',
  guide: text => text.includes('BAD') ? ['t9 names no real step'] : [],
};

const input = (dir: string, mode: 'team' | 'local'): BuildInput => ({ project: dir, mode, main: { name: 'main', ref: 'refs/heads/main' },
  branches: [{ name: 'feat/x', ref: 'refs/heads/feat/x' }, { name: 'chore/express-5', ref: 'refs/heads/chore/express-5' }],
  evidence, wisdomVersion: 'test', now: new Date() });

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
  const manifest = writeData(out, build, files);
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
