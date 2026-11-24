import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { startDaemon } from '../src/service/daemon.js';
import { call } from '../src/service/client.js';
import { readCommit, type CommitRecord } from '../src/team/commits.js';
import { commitFiles, FETCHED_LINKS, patchId, readFile, recordRef, recordText, setRef, writePolicy, readPolicy } from '../src/team/gitrefs.js';
import { followLinks, linkRef, ownLink, pairCommits, parseCommitMap, parseRewrites, readLink, writeLink, type CommitLink } from '../src/team/links.js';
import { installHooks, queueLinks, readOutbox, sendQueuedLinks } from '../src/team/githooks.js';
import { prCheck, pushLinks } from '../src/team/team.js';
import { relink, setSync, syncOn, syncSpecs, workflowText, writeWorkflow, workflowFile } from '../src/team/relink.js';
import { githubApi, repositoryFromUrl } from '../src/team/github.js';
import { setGuides } from '../src/team/guides.js';
import { observeSession, openSession } from './session.js';

/** Commit links, with real git throughout: real repositories, commits, amends, rebases, hooks
 * git itself runs, pushes to bare repositories that stand in for GitHub. The one stand-in is
 * GitHub's HTTP API, served here by a small local server answering in GitHub's documented shape
 * (marked "GitHub stub"); `refs/pull/<n>/head`, which GitHub keeps, is written into the bare
 * repository the way GitHub does. What only a live run can prove is listed in
 * private/design/commit-links-review.md. */

const hasGit = spawnSync('git', ['--version'], { windowsHide: true }).status === 0;
const obs = (type: string, extra: Record<string, unknown> = {}) => ({ observationId: randomUUID(), type, ...extra });
const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));

function tempRoot(name: string) { return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `wisdom-${name}-`))); }

function bare(root: string, name = 'origin.git') {
  const dir = path.join(root, name);
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', dir], { windowsHide: true });
  return dir;
}

function person(root: string, name: string, origin: string, clone: boolean) {
  const dir = path.join(root, name);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  // --no-local: copy only what a network clone would get, so a commit on no branch stays behind.
  if (clone) execFileSync('git', ['clone', '-q', '--no-local', '-c', 'core.autocrlf=false', origin, dir], { windowsHide: true });
  else { fs.mkdirSync(dir); git('init', '-q', '-b', 'main'); git('remote', 'add', 'origin', origin); }
  git('config', 'user.name', name); git('config', 'user.email', `${name}@example.com`); git('config', 'core.autocrlf', 'false');
  fs.appendFileSync(path.join(dir, '.git', 'info', 'exclude'), '.wisdom/\n');
  const real = fs.realpathSync(dir);
  return { dir: real, data: path.join(real, '.wisdom'), git };
}
type Person = ReturnType<typeof person>;

/** A team-mode repository: the policy file committed, pushed to its bare origin. */
function teamRepo(root: string, origin: string, name = 'alice') {
  const who = person(root, name, origin, false);
  fs.writeFileSync(path.join(who.dir, 'a.ts'), 'one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\n');
  writePolicy(who.dir);
  who.git('add', '-A'); who.git('commit', '-q', '-m', 'start'); who.git('push', '-q', 'origin', 'main');
  return { ...who, repoId: readPolicy(who.dir)!.repoId };
}

function edit(who: Person, file: string, change: (text: string) => string, message: string): string {
  const full = path.join(who.dir, file);
  fs.writeFileSync(full, change(fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : ''));
  who.git('add', '-A'); who.git('commit', '-q', '-m', message);
  return who.git('rev-parse', 'HEAD');
}

/** A record of a commit, kept the way the post-commit job keeps one (its ref, record.json), with
 * no steps: these tests are about finding a record, not about what is in it. */
function keepRecord(dir: string, sha: string, extra: Partial<CommitRecord> = {}): CommitRecord {
  const record = { kind: 'wisdom-commit-record', version: 1, commit: readCommit(dir, sha), made: 'commit', madeAt: new Date().toISOString(),
    wisdomVersion: 'test', recorder: 'recorder-test', patchId: patchId(dir, sha), steps: [], files: [], sessions: [], ...extra } as CommitRecord;
  setRef(dir, recordRef(sha), commitFiles(dir, { 'record.json': JSON.stringify(record, null, 2) }, `wisdom record for ${sha}`));
  return record;
}

/** Push this clone's own records to the team remote, as pre-push does. */
const pushRecords = (who: Person & { repoId: string }, shas: string[]) =>
  who.git('push', '-q', '--no-verify', 'origin', ...shas.map(sha => `${recordRef(sha)}:refs/wisdom/${who.repoId}/records/${sha}`));

const remoteRefs = (origin: string, pattern = 'refs/wisdom/*') => execFileSync('git', ['ls-remote', origin, pattern], { encoding: 'utf8' });

/** GitHub stub: a local HTTP server answering the two routes relink asks, in GitHub's shape. */
async function githubStub(routes: Record<string, unknown>) {
  const seen: { url: string; auth?: string }[] = [];
  const server = http.createServer((request, response) => {
    seen.push({ url: request.url!, auth: request.headers.authorization });
    const route = request.url!.replace(/^\/repos\/acme\/app/, '');
    const body = routes[route];
    response.writeHead(body === undefined ? 404 : 200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body ?? { message: 'Not Found' }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return { env: { GITHUB_API_URL: `http://127.0.0.1:${port}`, GITHUB_REPOSITORY: 'acme/app', GITHUB_TOKEN: 'test-token' } as NodeJS.ProcessEnv,
    seen, close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}

/** GitHub keeps every pull request's commits at refs/pull/<n>/head in the base repository. */
const pullHead = (origin: string, n: number, sha: string) => execFileSync('git', ['update-ref', `refs/pull/${n}/head`, sha], { cwd: origin });

async function until<T>(what: string, check: () => T | undefined, ms = 60_000): Promise<T> {
  for (let waited = 0; waited < ms; waited += 200) {
    const value = check();
    if (value !== undefined) return value;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

// ---------- pure parts ----------

test('post-rewrite input: each new commit with the commits it came from, as git prints them', () => {
  const a = 'a'.repeat(40), b = 'b'.repeat(40), c = 'c'.repeat(40), d = 'd'.repeat(40);
  // What git 2.47 gave a real post-rewrite hook for a fixup rebase (see the review doc), shas replaced.
  const pairs = parseRewrites(`${a} ${c}\n${b} ${c}\n${d} ${d}\nnot a line\n${a} ${c}\n`);
  assert.deepEqual([...pairs], [[c, [a, b]]]);
});

test('filter-repo commit map: header skipped, dropped commits (all zeros) and unchanged ones left out', () => {
  const a = 'a'.repeat(40), b = 'b'.repeat(40), c = 'c'.repeat(40), zero = '0'.repeat(40);
  assert.deepEqual(parseCommitMap(`old                                      new\n${a} ${b}\n${c} ${zero}\n${b} ${b}\n`), [[a, b]]);
});

test('pairing a rebase merge: patch-id first, then by position only where both sides have the same gap, never a guess', () => {
  const m = (sha: string, patchId?: string) => ({ sha, patchId });
  // r2 changed (context), between two that matched: paired by order.
  assert.deepEqual(pairCommits([m('r1', 'x'), m('r2', 'y2'), m('r3', 'z')], [m('p1', 'x'), m('p2', 'y'), m('p3', 'z')]),
    [{ main: 'r1', pr: 'p1', basis: 'patch-id' }, { main: 'r2', pr: 'p2', basis: 'order' }, { main: 'r3', pr: 'p3', basis: 'patch-id' }]);
  // GitHub dropped an empty commit: gaps differ, so the odd one stays unpaired.
  assert.deepEqual(pairCommits([m('r1', 'x'), m('r2', 'q'), m('r3', 'z')], [m('p1', 'x'), m('p2', 'y'), m('p2b', 'w'), m('p3', 'z')]),
    [{ main: 'r1', pr: 'p1', basis: 'patch-id' }, { main: 'r2' }, { main: 'r3', pr: 'p3', basis: 'patch-id' }]);
  // Nothing matches and the counts agree: order alone, from the ends.
  assert.deepEqual(pairCommits([m('r1', 'a'), m('r2', 'b')], [m('p1', 'c'), m('p2', 'd')]).map(p => p.basis), ['order', 'order']);
  // Matches that cross (reordered) leave the commits between them unpaired.
  assert.deepEqual(pairCommits([m('r1', 'b'), m('r2', 'q'), m('r3', 'a')], [m('p1', 'a'), m('p2', 'y'), m('p3', 'b')]).map(p => p.basis), ['patch-id', undefined, 'patch-id']);
});

test('GitHub remote URLs name the repository; anything else does not', () => {
  assert.equal(repositoryFromUrl('https://github.com/acme/app.git'), 'acme/app');
  assert.equal(repositoryFromUrl('git@github.com:acme/app.git'), 'acme/app');
  assert.equal(repositoryFromUrl('ssh://git@github.com/acme/app'), 'acme/app');
  assert.equal(repositoryFromUrl('https://gitlab.com/acme/app.git'), undefined);
  assert.equal(repositoryFromUrl('/tmp/origin.git'), undefined);
});

test('GitHub stub: the API module sends the token, reads a fork, and pages through a pull request\'s commits', async () => {
  const many = Array.from({ length: 130 }, (_, i) => ({ sha: i.toString(16).padStart(40, '0') }));
  const stub = await githubStub({
    [`/commits/${'f'.repeat(40)}/pulls`]: [{ number: 3, merged_at: '2026-11-20T00:00:00Z', merge_commit_sha: 'f'.repeat(40), head: { repo: { full_name: 'someone/app', clone_url: 'https://github.com/someone/app.git' } } }],
    '/pulls/3/commits?per_page=100&page=1': many.slice(0, 100),
    '/pulls/3/commits?per_page=100&page=2': many.slice(100),
  });
  try {
    const api = githubApi(process.cwd(), 'origin', stub.env)!;
    assert.deepEqual(await api.pullsForCommit('f'.repeat(40)), [{ number: 3, merged: true, mergeCommit: 'f'.repeat(40), fork: { fullName: 'someone/app', cloneUrl: 'https://github.com/someone/app.git' } }]);
    assert.equal((await api.pullCommits(3)).length, 130);
    assert.ok(stub.seen.every(request => request.auth === 'Bearer test-token'));
    await assert.rejects(api.pullCommits(4), /GitHub answered 404 for \/pulls\/4\/commits.*GITHUB_TOKEN/);
  } finally { await stub.close(); }
});

// ---------- the link store ----------

test('links: kept once, joined when git reports more, replaced only by a stronger one with the old kept beneath, followed through a link of a link, and a loop ends', { skip: !hasGit }, () => {
  const root = tempRoot('links-store');
  try {
    const me = teamRepo(root, bare(root));
    const a = edit(me, 'a.ts', t => t.replace('two', 'TWO'), 'a');
    const b = edit(me, 'a.ts', t => t.replace('six', 'SIX'), 'b');
    const c = edit(me, 'b.ts', () => 'b\n', 'c');
    keepRecord(me.dir, a);
    const base = { writer: 'w' };
    assert.equal(writeLink(me.dir, { ...base, commit: c, from: [a], how: 'amend', basis: 'git' }), 'written');
    assert.equal(writeLink(me.dir, { ...base, commit: c, from: [a], how: 'rebase', basis: 'git' }), 'kept');
    assert.equal(writeLink(me.dir, { ...base, commit: c, from: [b], how: 'rebase', basis: 'git' }), 'joined');
    assert.deepEqual(ownLink(me.dir, c)!.from, [a, b]);
    assert.equal(ownLink(me.dir, c)!.how, 'rebase');
    // A weaker link never replaces one git reported; a commit is never its own source.
    assert.equal(writeLink(me.dir, { ...base, commit: c, from: [a], how: 'rewrite', basis: 'patch-id' }), 'kept');
    assert.equal(writeLink(me.dir, { ...base, commit: a, from: [a], how: 'amend', basis: 'git' }), 'kept');
    // A stronger link replaces a weaker one, as a new version on top: its history stays.
    assert.equal(writeLink(me.dir, { ...base, commit: b, from: [a], how: 'rebase-merge', basis: 'order' }), 'written');
    assert.equal(writeLink(me.dir, { ...base, commit: b, from: [a], how: 'rebase-merge', basis: 'patch-id' }), 'replaced');
    assert.equal(me.git('rev-list', '--count', linkRef(b)), '2');
    // Followed: c came from a (a record) and b, whose own link leads to a again (seen once).
    const found = followLinks(me.dir, c)!;
    assert.deepEqual(found.map(f => [f.commit, !!f.record, f.via.length]), [[a, true, 1]]);
    // A loop of links (b from c, c from b) ends, and a commit with no record is reported as such.
    const d = edit(me, 'b.ts', () => 'd\n', 'd');
    writeLink(me.dir, { ...base, commit: d, from: [c], how: 'amend', basis: 'git' });
    writeLink(me.dir, { ...base, commit: a, from: [d], how: 'amend', basis: 'git' });
    assert.deepEqual(followLinks(me.dir, d)!.map(f => f.commit), [a]);
    const e = edit(me, 'b.ts', () => 'e\n', 'e');
    const f = edit(me, 'b.ts', () => 'f\n', 'f');
    writeLink(me.dir, { ...base, commit: f, from: [e], how: 'amend', basis: 'git' });
    assert.deepEqual(followLinks(me.dir, f)!.map(x => [x.commit, x.record]), [[e, undefined]]);
    assert.equal(followLinks(me.dir, e), undefined);
    // A copy a pull brought is read too; this clone's own wins when as strong, the stronger one otherwise.
    const fetched = (link: Partial<CommitLink>) => setRef(me.dir, `${FETCHED_LINKS}${e}`, commitFiles(me.dir, { 'link.json': JSON.stringify({ kind: 'wisdom-commit-link', version: 1, commit: e, from: [a], how: 'squash-merge', basis: 'github', writtenAt: 'x', writer: 'ci', ...link }) }, 't'));
    fetched({});
    assert.equal(readLink(me.dir, e)!.basis, 'github');
    writeLink(me.dir, { ...base, commit: e, from: [b], how: 'rewrite', basis: 'patch-id' });
    assert.equal(readLink(me.dir, e)!.basis, 'github');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// ---------- git's own hook ----------

test('post-rewrite, run by git itself: amend, rebase and a fixup each leave links with the exact pairs; local mode leaves none', { skip: !hasGit }, () => {
  const root = tempRoot('links-hook');
  try {
    const origin = bare(root);
    const me = teamRepo(root, origin);
    installHooks(me.dir, me.data, ['post-rewrite']);
    // Amend.
    const first = edit(me, 'a.ts', t => t.replace('two', 'TWO'), 'first');
    me.git('commit', '-q', '--amend', '-m', 'first, reworded');
    const amended = me.git('rev-parse', 'HEAD');
    assert.deepEqual([ownLink(me.dir, amended)!.from, ownLink(me.dir, amended)!.how, ownLink(me.dir, amended)!.basis], [[first], 'amend', 'git']);
    // Rebase onto a main that moved.
    me.git('checkout', '-q', '-b', 'work');
    const w1 = edit(me, 'a.ts', t => t.replace('four', 'FOUR'), 'w1');
    const w2 = edit(me, 'a.ts', t => t.replace('eight', 'EIGHT'), 'w2');
    me.git('checkout', '-q', 'main');
    edit(me, 'c.ts', () => 'c\n', 'main moves');
    me.git('checkout', '-q', 'work');
    me.git('rebase', '-q', 'main');
    const [r2, r1] = me.git('rev-list', '--max-count=2', 'HEAD').split('\n');
    assert.deepEqual([ownLink(me.dir, r1)!.from, ownLink(me.dir, r2)!.from, ownLink(me.dir, r2)!.how], [[w1], [w2], 'rebase']);
    // A fixup: git reports it twice (amend while rebasing, then the rebase); one link holds both.
    const env = { ...process.env, GIT_SEQUENCE_EDITOR: `"${process.execPath}" -e "const f=process.argv[1];const fs=require('fs');const l=fs.readFileSync(f,'utf8').split('\\n');l[1]=l[1].replace(/^pick/,'fixup');fs.writeFileSync(f,l.join('\\n'))"` };
    execFileSync('git', ['rebase', '-q', '-i', 'main'], { cwd: me.dir, env, windowsHide: true, stdio: 'pipe' });
    const fixed = me.git('rev-parse', 'HEAD');
    assert.equal(me.git('rev-list', '--count', 'main..HEAD'), '1');
    assert.deepEqual(ownLink(me.dir, fixed)!.from.sort(), [r1, r2].sort());
    assert.equal(ownLink(me.dir, fixed)!.how, 'rebase');
    // Each run says what it kept, in jobs.log.
    assert.match(fs.readFileSync(path.join(me.data, 'jobs.log'), 'utf8'), /post-rewrite \(amend\) · 1 link kept/);

    // Local mode (no wisdom-team.yaml): the hook does nothing.
    const local = person(root, 'local', bare(root, 'local.git'), false);
    edit(local, 'x.ts', () => 'x\n', 'x');
    installHooks(local.dir, local.data, ['post-rewrite']);
    local.git('commit', '-q', '--amend', '-m', 'x2');
    assert.equal(local.git('for-each-ref', 'refs/wisdom/'), '');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// ---------- push, outbox ----------

test('the outbox: links a push could not send stay here, a retry sends them once the remote takes them, and the doctor\'s file clears', { skip: !hasGit }, async () => {
  const root = tempRoot('links-outbox');
  try {
    const origin = bare(root);
    const me = teamRepo(root, origin);
    const old = edit(me, 'a.ts', t => t.replace('two', 'TWO'), 'old');
    me.git('commit', '-q', '--amend', '-m', 'new');
    const next = me.git('rev-parse', 'HEAD');
    writeLink(me.dir, { commit: next, from: [old], how: 'amend', basis: 'git', writer: 'w' });
    me.git('push', '-q', '--no-verify', 'origin', 'main');
    // The remote refuses Wisdom's link refs (a server-side rule, a token without the right).
    const hook = path.join(origin, 'hooks', 'pre-receive');
    fs.writeFileSync(hook, '#!/bin/sh\nwhile read old new ref; do case "$ref" in refs/wisdom/*/links/*) echo "links refused here" >&2; exit 1;; esac; done\nexit 0\n', { mode: 0o755 });
    assert.throws(() => pushLinks(me.dir), /^Error: Commit links could not be pushed to origin: failed to push some refs to /);
    fs.mkdirSync(me.data, { recursive: true });
    fs.writeFileSync(path.join(me.data, 'links-outbox.json'), JSON.stringify({ since: '2026-11-24T00:00:00Z', cause: 'x', attempts: 0 }));
    assert.ok('failed' in sendQueuedLinks(me.data));
    assert.equal(readOutbox(me.data)!.attempts, 1);
    assert.doesNotMatch(remoteRefs(origin), /links/);
    // The remote takes them again: the next try sends them and clears the outbox.
    fs.rmSync(hook);
    assert.deepEqual(sendQueuedLinks(me.data), { sent: 1 });
    assert.equal(readOutbox(me.data), undefined);
    assert.match(remoteRefs(origin), new RegExp(`refs/wisdom/${me.repoId}/links/${next}`));
    assert.match(fs.readFileSync(path.join(me.data, 'jobs.log'), 'utf8'), /links outbox · 1 link sent/);

    // queueLinks starts the background retry (a detached process), which says it is the one running.
    queueLinks(me.data, 'test');
    const pid = await until('the retry process', () => readOutbox(me.data)?.pid);
    try { process.kill(pid, 0); } catch { assert.fail('the retry process is running'); }
    // A second queue while it runs does not start another.
    queueLinks(me.data, 'again');
    assert.equal(readOutbox(me.data)!.pid, pid);
    process.kill(pid);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('end to end: an amend in a recorded session; push sends links first and the rebased-away record; a refused session upload does not stop the links; a teammate reads the work through a squash GitHub made, with no Wisdom-Record line', { skip: !hasGit }, async () => {
  const root = tempRoot('links-e2e');
  const origin = bare(root);
  const alice = teamRepo(root, origin);
  setGuides(alice.data, false);
  const daemon = await startDaemon(alice.data, 0);
  let bobDaemon: Awaited<ReturnType<typeof startDaemon>> | undefined;
  const stubs: { close(): Promise<void> }[] = [];
  try {
    installHooks(alice.dir, alice.data);
    const { captureId: id } = await openSession(daemon.connection, { harness: 'pi', sessionId: 'alice-links-1', workspaceRoot: alice.dir, source: null });
    const send = (o: unknown) => observeSession(daemon.connection, id, o);
    alice.git('checkout', '-q', '-b', 'feature');
    const agentEdit = async (n: number, change: (t: string) => string, ask: string) => {
      await send(obs('input', { data: { text: ask } }));
      await send(obs('tool_started', { toolCallId: `e${n}`, toolName: 'edit', data: { input: { path: 'a.ts' } } }));
      fs.writeFileSync(path.join(alice.dir, 'a.ts'), change(fs.readFileSync(path.join(alice.dir, 'a.ts'), 'utf8')));
      await send(obs('tool_finished', { toolCallId: `e${n}`, toolName: 'edit', isError: false, data: { content: 'ok' } }));
    };
    const recorded = (sha: string) => until(`the record of ${sha.slice(0, 8)}`, () => recordText(alice.dir, sha) ? JSON.parse(recordText(alice.dir, sha)!) as CommitRecord : undefined);

    await agentEdit(1, t => t.replace('two', 'TWO'), 'Make two say TWO.');
    alice.git('commit', '-q', '-am', 'two');
    const c1 = alice.git('rev-parse', 'HEAD');
    const r1 = await recorded(c1);
    assert.equal(r1.patchId, patchId(alice.dir, c1), 'the record keeps the commit\'s patch-id');
    // Amend (the message only): git's post-rewrite links the new commit to the old.
    alice.git('commit', '-q', '--amend', '-m', 'two, reworded');
    const c1b = alice.git('rev-parse', 'HEAD');
    assert.deepEqual(ownLink(alice.dir, c1b)?.from, [c1]);
    await recorded(c1b);
    await agentEdit(2, t => t.replace('seven', 'SEVEN'), 'Make seven say SEVEN.');
    alice.git('commit', '-q', '-am', 'seven');
    const c2 = alice.git('rev-parse', 'HEAD');
    await recorded(c2);

    // The remote refuses session uploads for now: links go anyway, first. The remote's hook
    // writes down each push it receives, in order, so the order is checked, not only the result.
    const hook = path.join(origin, 'hooks', 'pre-receive');
    const received = path.join(root, 'received.log').replaceAll('\\', '/');
    fs.writeFileSync(hook, `#!/bin/sh\nreject=0\nall=""\nwhile read old new ref; do all="$all $ref"; case "$ref" in refs/wisdom/*/sessions/*) reject=1;; esac; done\necho "$all" >> "${received}"\nif [ $reject = 1 ]; then echo "sessions refused here" >&2; exit 1; fi\nexit 0\n`, { mode: 0o755 });
    const refused = spawnSync('git', ['push', 'origin', 'feature'], { cwd: alice.dir, encoding: 'utf8', windowsHide: true });
    assert.equal(refused.status, 0, 'a Wisdom failure never fails the push');
    assert.match(refused.stderr, /Wisdom could not run its pre-push hook: Sessions could not be pushed to origin/);
    assert.match(remoteRefs(origin), new RegExp(`refs/wisdom/${alice.repoId}/links/${c1b}`));
    const firstWisdomPush = fs.readFileSync(received, 'utf8').split('\n').find(line => line.includes('refs/wisdom/'))!;
    assert.match(firstWisdomPush, /\/links\//, 'the first Wisdom refs sent are the links');
    assert.doesNotMatch(firstWisdomPush, /\/sessions\/|\/records\//);
    assert.doesNotMatch(remoteRefs(origin), /records\//, 'no record went before its sessions');
    fs.rmSync(hook);
    const pushed = spawnSync('git', ['push', 'origin', 'feature'], { cwd: alice.dir, encoding: 'utf8', windowsHide: true });
    assert.equal(pushed.status, 0, pushed.stderr);
    // c1 is on no branch now (amended away), but a link names it: its record went too.
    for (const sha of [c1, c1b, c2]) assert.match(remoteRefs(origin), new RegExp(`refs/wisdom/${alice.repoId}/records/${sha}`));

    // GitHub squash-merges PR #12 into main: a new commit, no hook ran, and its message carries no
    // Wisdom-Record line (someone cleaned it up). GitHub keeps the PR's head.
    const bob = person(root, 'bob', origin, true);
    bob.git('checkout', '-q', 'main');
    const tree = execFileSync('git', ['rev-parse', 'origin/feature^{tree}'], { cwd: bob.dir, encoding: 'utf8' }).trim();
    // Made by GitHub, as GitHub: Bob's own daemon keeps records only of commits he makes.
    const squash = execFileSync('git', ['commit-tree', tree, '-p', 'main', '-m', 'Make two and seven loud (#12)'], { cwd: bob.dir, encoding: 'utf8',
      env: { ...process.env, GIT_COMMITTER_NAME: 'GitHub', GIT_COMMITTER_EMAIL: 'noreply@github.com' } }).trim();
    bob.git('update-ref', 'refs/heads/main', squash); bob.git('push', '-q', 'origin', 'main');
    pullHead(origin, 12, c2);
    // Before relink: no record, no link, no message line. The CI check says so.
    const before = prCheck(bob.dir, `${squash}~1..${squash}`);
    assert.match(before.text, /no record or link: made without Wisdom, or not linked yet \(wisdom team relink\)/);
    // The CI job after the merge (GitHub stub answers which PR made it).
    const stub = await githubStub({
      [`/commits/${squash}/pulls`]: [{ number: 12, merged_at: '2026-11-24T10:00:00Z', merge_commit_sha: squash, head: { repo: { full_name: 'acme/app', clone_url: origin } } }],
      '/pulls/12/commits?per_page=100&page=1': [{ sha: c1b }, { sha: c2 }],
    });
    stubs.push(stub);
    const ci = person(root, 'ci', origin, true);
    const result = await relink(ci.dir, { range: `${squash}~1..${squash}`, env: { ...stub.env, GITHUB_ACTIONS: 'true' } });
    assert.deepEqual(result.lines, ['1 commit in ' + `${squash}~1..${squash}` + ', 1 with neither a record nor a link', '1 link written and pushed to origin']);
    const link = JSON.parse(execFileSync('git', ['cat-file', 'blob', `refs/wisdom/${alice.repoId}/links/${squash}:link.json`], { cwd: origin, encoding: 'utf8' }));
    assert.deepEqual([link.from, link.how, link.basis, link.pr, link.writer], [[c1b, c2], 'squash-merge', 'github', 12, 'github-actions']);

    // Bob reads main's commit: through the link, to the PR's records, each piece to its step.
    bobDaemon = await startDaemon(bob.data, 0);
    await call(bobDaemon.connection, '/team', { action: 'fetch' });
    const text = (await call(bobDaemon.connection, '/ledger', { glance: true, commit: squash })).text;
    assert.match(text, /^no record of its own$/m);
    assert.match(text, /^squash merge of PR #12, from GitHub's pull request: it came from 2 commits; their records follow$/m);
    assert.match(text, new RegExp(`^── from: ${c1b.slice(0, 12)}$`, 'm'));
    assert.match(text, /^ {4}@@ -2,1 \+2,1 @@ {2}t1\/c1 in session alice-li$/m);
    assert.match(text, /^ {4}@@ -7,1 \+7,1 @@ {2}t2\/c1 in session alice-li$/m);
    assert.doesNotMatch(text, /Wisdom-Record lines/);
    const after = prCheck(bob.dir, `${squash}~1..${squash}`);
    assert.match(after.text, /^ {4}no record of its own; squash merge of PR #12, from GitHub's pull request: 2 recorded commits stand for it$/m);
    // Alice's own record of the amended commit says where it came from.
    const own = (await call(daemon.connection, '/ledger', { glance: true, commit: c1b })).text;
    assert.match(own, new RegExp(`^amended, git reported the rewrite, from ${c1.slice(0, 12)}$`, 'm'));
    assert.match(own, new RegExp(`^the record from before: wisdom glance --commit ${c1.slice(0, 12)}$`, 'm'));
    // Run again: nothing left to link.
    const again = await relink(ci.dir, { range: `${squash}~1..${squash}`, env: stub.env });
    assert.match(again.lines.join('\n'), /0 with neither a record nor a link[\s\S]*0 links written/);
  } finally {
    await daemon.close(); await bobDaemon?.close();
    for (const stub of stubs) await stub.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------- relink: the four repairs ----------

test('repair 1, hooks did not run: a rebase with no hook is linked by the patch-id its record kept, on a CI clone that never had the old commits; two records with that change link to neither', { skip: !hasGit }, async () => {
  const root = tempRoot('links-patchid');
  try {
    const origin = bare(root);
    const bob = teamRepo(root, origin, 'bob');
    bob.git('checkout', '-q', '-b', 'work');
    const w1 = edit(bob, 'a.ts', t => t.replace('two', 'TWO'), 'w1');
    const w2 = edit(bob, 'a.ts', t => t.replace('six', 'SIX'), 'w2');
    keepRecord(bob.dir, w1); keepRecord(bob.dir, w2);
    bob.git('push', '-q', 'origin', 'work'); pushRecords(bob, [w1, w2]);
    bob.git('checkout', '-q', 'main');
    edit(bob, 'c.ts', () => 'c\n', 'main moves'); bob.git('push', '-q', 'origin', 'main');
    // A GUI rebase that runs no hooks (no hooks are installed here at all), then a force push.
    bob.git('checkout', '-q', 'work');
    bob.git('-c', 'core.hooksPath=/dev/null', 'rebase', '-q', 'main');
    bob.git('push', '-q', '-f', 'origin', 'work');
    const [n2, n1] = bob.git('rev-list', '--max-count=2', 'work').split('\n');
    // The CI clone: only main and work; w1 and w2 are on no branch, so it never fetches them.
    const ci = person(root, 'ci', origin, true);
    ci.git('fetch', '-q', 'origin', 'work:work');
    assert.notEqual(spawnSync('git', ['cat-file', '-e', `${w1}^{commit}`], { cwd: ci.dir }).status, 0, 'the old commit is not on the CI clone');
    const result = await relink(ci.dir, { range: 'main..work', env: {} });
    assert.match(result.lines.join('\n'), /GitHub not asked: origin is not a GitHub remote and GITHUB_REPOSITORY is not set/);
    assert.match(result.lines.at(-1)!, /^2 links written and pushed to origin$/);
    for (const [next, old] of [[n1, w1], [n2, w2]]) {
      const link = JSON.parse(execFileSync('git', ['cat-file', 'blob', `refs/wisdom/${bob.repoId}/links/${next}:link.json`], { cwd: origin, encoding: 'utf8' }));
      assert.deepEqual([link.from, link.basis, link.how, link.writer], [[old], 'patch-id', 'rewrite', 'wisdom team relink']);
    }
    // The same change recorded twice (a cherry-pick kept a record too): ambiguous, so no link.
    ci.git('checkout', '-q', '-b', 'twice', 'main');
    const p = edit(ci, 'd.ts', () => 'd\n', 'p');
    const q = ci.git('commit-tree', `${p}^{tree}`, '-p', 'main', '-m', 'p again');
    keepRecord(ci.dir, p); keepRecord(ci.dir, q);
    ci.git('checkout', '-q', 'main');
    const r = ci.git('commit-tree', `${p}^{tree}`, '-p', 'main', '-m', 'p a third time');
    ci.git('update-ref', 'refs/heads/third', r);
    const ambiguous = await relink(ci.dir, { range: 'main..third', env: {} });
    assert.match(ambiguous.lines.join('\n'), new RegExp(`${r.slice(0, 12)} is the same change as 2 recorded commits .* so it is not linked to any`));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('repair 2, a fork: the pull request\'s records and sessions are copied from the fork into the team remote, sessions first, then the squash is linked (GitHub stub)', { skip: !hasGit }, async () => {
  const root = tempRoot('links-fork');
  const stubs: { close(): Promise<void> }[] = [];
  try {
    const origin = bare(root);
    const owner = teamRepo(root, origin, 'owner');
    // Priya clones, works, and can push only to her fork, where her pre-push put her refs.
    const fork = bare(root, 'fork.git');
    const priya = person(root, 'priya', origin, true);
    priya.git('remote', 'set-url', 'origin', fork); priya.git('push', '-q', 'origin', 'main');
    priya.git('checkout', '-q', '-b', 'fix');
    const f1 = edit(priya, 'a.ts', t => t.replace('three', 'THREE'), 'f1');
    const session = commitFiles(priya.dir, { 'meta.json': JSON.stringify({ sessionId: 'priya-s1', recorder: 'priya-rec' }) }, 'wisdom session priya-s1');
    setRef(priya.dir, 'refs/wisdom/sessions/priya-rec/priya-s1', session);
    keepRecord(priya.dir, f1, { sessions: [{ id: 'priya-s1', harness: 'pi', recorder: 'priya-rec', positions: ['t1/c1'] }] });
    priya.git('push', '-q', 'origin', 'fix', `refs/wisdom/sessions/priya-rec/priya-s1:refs/wisdom/${owner.repoId}/sessions/priya-rec/priya-s1`,
      `${recordRef(f1)}:refs/wisdom/${owner.repoId}/records/${f1}`);
    // GitHub copies the PR's commits into the base repository (refs/pull/5/head), not her Wisdom refs.
    execFileSync('git', ['fetch', '-q', fork, `fix:refs/pull/5/head`], { cwd: origin });
    owner.git('fetch', '-q', 'origin', 'refs/pull/5/head');
    const squash = owner.git('commit-tree', 'FETCH_HEAD^{tree}', '-p', 'main', '-m', 'Fix three (#5)');
    owner.git('update-ref', 'refs/heads/main', squash); owner.git('push', '-q', 'origin', 'main');
    const stub = await githubStub({
      [`/commits/${squash}/pulls`]: [{ number: 5, merged_at: '2026-11-24T10:00:00Z', merge_commit_sha: squash, head: { repo: { full_name: 'priya/app', clone_url: fork } } }],
      '/pulls/5/commits?per_page=100&page=1': [{ sha: f1 }],
    });
    stubs.push(stub);
    const ci = person(root, 'ci', origin, true);
    const result = await relink(ci.dir, { range: `${squash}~1..${squash}`, env: stub.env });
    assert.ok(result.lines.includes('PR #5 came from the fork priya/app: copied 1 record and 1 session to origin'), result.lines.join('\n'));
    const listed = remoteRefs(origin);
    assert.match(listed, new RegExp(`refs/wisdom/${owner.repoId}/records/${f1}`));
    assert.match(listed, new RegExp(`refs/wisdom/${owner.repoId}/sessions/priya-rec/priya-s1`));
    assert.match(listed, new RegExp(`refs/wisdom/${owner.repoId}/links/${squash}`));
    assert.match(prCheck(ci.dir, `${squash}~1..${squash}`).text, /squash merge of PR #5, from GitHub's pull request: 1 recorded commit stands for it/);
  } finally {
    for (const stub of stubs) await stub.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('repair 3, a GitHub rebase merge: two commits pair by patch-id, the one whose context main changed pairs by position and says it is weaker (GitHub stub)', { skip: !hasGit }, async () => {
  const root = tempRoot('links-rebasemerge');
  const stubs: { close(): Promise<void> }[] = [];
  try {
    const origin = bare(root);
    const asha = teamRepo(root, origin, 'asha');
    asha.git('checkout', '-q', '-b', 'pr');
    const p1 = edit(asha, 'b.ts', () => 'b\n', 'p1');
    const p2 = edit(asha, 'a.ts', t => t.replace('four', 'FOUR'), 'p2');
    const p3 = edit(asha, 'e.ts', () => 'e\n', 'p3');
    for (const sha of [p1, p2, p3]) keepRecord(asha.dir, sha);
    asha.git('push', '-q', 'origin', 'pr'); pushRecords(asha, [p1, p2, p3]);
    pullHead(origin, 9, p3);
    // Bob's merged change sits two lines below p2's: no conflict, but p2's diff context changes.
    asha.git('checkout', '-q', 'main');
    edit(asha, 'a.ts', t => t.replace('six', 'six!'), 'bob, merged first'); asha.git('push', '-q', 'origin', 'main');
    // "Rebase and merge": GitHub replays the commits on its own servers. No hook runs.
    asha.git('checkout', '-q', '-b', 'replayed', 'pr');
    asha.git('-c', 'core.hooksPath=/dev/null', 'rebase', '-q', 'main');
    const [r3, r2, r1] = asha.git('rev-list', '--max-count=3', 'replayed').split('\n');
    asha.git('push', '-q', 'origin', 'replayed:main');
    assert.equal(patchId(asha.dir, r1), patchId(asha.dir, p1));
    assert.notEqual(patchId(asha.dir, r2), patchId(asha.dir, p2), 'precondition: main changed r2\'s context');
    const pull = { number: 9, merged_at: '2026-11-24T10:00:00Z', merge_commit_sha: r3, head: { repo: { full_name: 'acme/app', clone_url: origin } } };
    const stub = await githubStub({
      [`/commits/${r1}/pulls`]: [pull], [`/commits/${r2}/pulls`]: [pull], [`/commits/${r3}/pulls`]: [pull],
      '/pulls/9/commits?per_page=100&page=1': [{ sha: p1 }, { sha: p2 }, { sha: p3 }],
    });
    stubs.push(stub);
    const ci = person(root, 'ci', origin, true);
    const result = await relink(ci.dir, { range: `${r1}~1..${r3}`, env: stub.env });
    assert.match(result.lines.at(-1)!, /^3 links written and pushed to origin$/);
    const got = (sha: string) => readLink(ci.dir, sha)!;
    assert.deepEqual([r1, r2, r3].map(sha => [got(sha).from[0], got(sha).basis, got(sha).how, got(sha).pr]),
      [[p1, 'patch-id', 'rebase-merge', 9], [p2, 'order', 'rebase-merge', 9], [p3, 'patch-id', 'rebase-merge', 9]]);
    assert.match(prCheck(ci.dir, `${r1}~1..${r3}`).text, /rebase merge of PR #9, paired by position only, since its change differs: a weaker link: 1 recorded commit stands for it/);
  } finally {
    for (const stub of stubs) await stub.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('repair 4, a history cleanup: the commit map links every commit; one whose change lost the removed file says its change differs', { skip: !hasGit }, async () => {
  const root = tempRoot('links-commitmap');
  try {
    const origin = bare(root);
    const me = teamRepo(root, origin);
    // k1 leaks a file; filter-branch removes it, so k1's change differs afterwards. k2 and k3
    // only get new shas (their parents changed), with the same change.
    fs.writeFileSync(path.join(me.dir, 'secret.env'), 'KEY=1\n');
    const k1 = edit(me, 'a.ts', t => t.replace('two', 'TWO'), 'k1, with a leaked file');
    const k2 = edit(me, 'a.ts', t => t.replace('six', 'SIX'), 'k2');
    const k3 = edit(me, 'b.ts', () => 'b\n', 'k3');
    for (const sha of [k1, k2, k3]) keepRecord(me.dir, sha);
    const old = me.git('rev-list', '--reverse', 'HEAD').split('\n');
    // A real rewrite of history that removes the file (filter-branch: filter-repo is not installed here).
    execFileSync('git', ['filter-branch', '-f', '--index-filter', 'git rm -q --cached --ignore-unmatch secret.env', 'HEAD'], { cwd: me.dir, stdio: 'pipe', env: { ...process.env, FILTER_BRANCH_SQUELCH_WARNING: '1' } });
    const now = me.git('rev-list', '--reverse', 'HEAD').split('\n');
    // filter-repo's commit map, in its format, for this rewrite (same number of commits, same order).
    const map = path.join(root, 'commit-map');
    fs.writeFileSync(map, `old                                      new\n${old.map((sha, i) => `${sha} ${now[i]}`).join('\n')}\n`);
    const result = await relink(me.dir, { commitMap: map, env: {} });
    assert.equal(result.lines[0], '3 commits linked from git filter-repo\'s commit map');
    const [n1, n2, n3] = now.slice(-3);
    assert.deepEqual([n1, n2, n3].map(sha => readLink(me.dir, sha)!.from[0]), [k1, k2, k3]);
    const daemon = await startDaemon(me.data, 0);
    try {
      const glance = async (sha: string) => (await call(daemon.connection, '/ledger', { glance: true, commit: sha })).text;
      assert.match(await glance(n1), /^history rewritten by git filter-repo, from git filter-repo's commit map: it came from 1 commit; its change differs from the commit it came from \(edited in the rewrite\); their records follow$/m);
      assert.match(await glance(n2), /^history rewritten by git filter-repo, from git filter-repo's commit map: it came from 1 commit; their records follow$/m);
      assert.doesNotMatch(await glance(n3), /its change differs/);
    } finally { await daemon.close(); }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// ---------- sync on pull ----------

test('team sync: two lines in the fetch list and nothing else; git pull brings links and records into their own namespace; a prune never deletes this clone\'s unpushed records, in a pull or in wisdom\'s own fetch', { skip: !hasGit }, async () => {
  const root = tempRoot('links-sync');
  try {
    const origin = bare(root);
    const alice = teamRepo(root, origin);
    const a1 = edit(alice, 'a.ts', t => t.replace('two', 'TWO'), 'a1');
    alice.git('push', '-q', 'origin', 'main');
    keepRecord(alice.dir, a1); pushRecords(alice, [a1]);
    const a2 = alice.git('commit-tree', `${a1}^{tree}`, '-p', a1, '-m', 'a2');
    writeLink(alice.dir, { commit: a2, from: [a1], how: 'amend', basis: 'git', writer: 'w' });
    alice.git('push', '-q', '--no-verify', 'origin', `${linkRef(a2)}:refs/wisdom/${alice.repoId}/links/${a2}`);

    const bob = person(root, 'bob', origin, true);
    const before = bob.git('config', '--get-all', 'remote.origin.fetch');
    assert.equal(syncOn(bob.dir).on, false);
    assert.deepEqual(setSync(bob.dir, true), { remote: 'origin', changed: true });
    assert.deepEqual(setSync(bob.dir, true), { remote: 'origin', changed: false });
    assert.deepEqual(bob.git('config', '--get-all', 'remote.origin.fetch').split('\n'), [before, ...syncSpecs(readPolicy(bob.dir)!)]);
    // Bob has a record of his own, not pushed, and prunes on every fetch.
    const b1 = edit(bob, 'b.ts', () => 'b\n', 'b1');
    keepRecord(bob.dir, b1);
    bob.git('config', 'fetch.prune', 'true');
    bob.git('pull', '-q', '--no-rebase');
    assert.ok(readFile(bob.dir, `refs/wisdom/fetched/records/${a1}`, 'record.json'), 'git pull brought the record');
    assert.ok(readFile(bob.dir, `${FETCHED_LINKS}${a2}`, 'link.json'), 'git pull brought the link');
    assert.deepEqual(followLinks(bob.dir, a2)!.map(f => [f.commit, !!f.record]), [[a1, true]]);
    assert.ok(recordText(bob.dir, b1), 'a pruning pull left his own unpushed record');
    // Wisdom's own fetch (here through the CI check) never prunes either.
    prCheck(bob.dir, `${a1}..HEAD`);
    assert.ok(recordText(bob.dir, b1), 'a pruning wisdom fetch left his own unpushed record');
    // Off takes out exactly the two lines.
    assert.deepEqual(setSync(bob.dir, false), { remote: 'origin', changed: true });
    assert.equal(bob.git('config', '--get-all', 'remote.origin.fetch'), before);
    assert.throws(() => setSync(bob.dir, true, 'nowhere'), /There is no remote named "nowhere" here/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// ---------- the CLI ----------

test('CLI: with no terminal to ask in, team init writes no workflow and team sync changes nothing; relink and sync answer in plain words', { skip: !hasGit }, () => {
  const root = tempRoot('links-cli');
  try {
    const origin = bare(root);
    const me = person(root, 'me', origin, false);
    edit(me, 'a.ts', () => 'a\n', 'start'); me.git('push', '-q', 'origin', 'main');
    const run = (...args: string[]) => spawnSync(process.execPath, [cli, ...args, '--cwd', me.dir], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const init = run('team', 'init');
    assert.equal(init.status, 0, init.stderr);
    assert.match(init.stdout, /Not written \(no terminal to ask in\)\. A GitHub Actions job .* is in docs\/team\.md#ci/);
    assert.equal(fs.existsSync(workflowFile(me.dir)), false);
    assert.match(run('team', 'sync').stdout, /git pull does not bring the team's commit links and records from origin\. Change it with: wisdom team sync on\|off/);
    assert.match(run('team', 'sync', 'on').stdout, /^Added two lines in \.git\/config \(remote\.origin\.fetch\)/);
    assert.match(run('team', 'sync', 'off').stdout, /^Removed Wisdom's two lines/);
    assert.match(run('team', 'relink').stderr, /Use: wisdom team relink --range <base>\.\.<head>, or --commit-map/);
    assert.match(run('team', 'sync', '--range', 'a..b').stderr, /--range and --commit-map apply only to team relink/);
    // The workflow, written on a yes: after each push to the default branch, with what it may do.
    const file = writeWorkflow(me.dir, 'main')!;
    const text = fs.readFileSync(file, 'utf8');
    assert.equal(text, workflowText('main'));
    assert.match(text, /^ {4}branches: \["main"\]$/m);
    assert.match(text, /^ {2}contents: write/m);
    assert.match(text, /^ {2}pull-requests: read/m);
    assert.match(text, /wisdom team relink --range "\$\{\{ github\.event\.before \}\}\.\.\$\{\{ github\.sha \}\}"/);
    assert.equal(writeWorkflow(me.dir, 'main'), undefined, 'never over one that is there');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a link is read before the message line; the line stays the backup when there is no link', { skip: !hasGit }, () => {
  const root = tempRoot('links-backup');
  try {
    const me = teamRepo(root, bare(root));
    const linked = edit(me, 'a.ts', t => t.replace('two', 'TWO'), 'linked one');
    const named = edit(me, 'b.ts', () => 'b\n', 'named by a pasted line');
    keepRecord(me.dir, linked, { recordId: 'r-aaaaaaaaaaaa' });
    keepRecord(me.dir, named, { recordId: 'r-bbbbbbbbbbbb' });
    // A squash whose message carries a line naming another commit's record (pasted by hand).
    const squash = me.git('commit-tree', `${named}^{tree}`, '-p', named, '-m', 'squash\n\nWisdom-Record: r-bbbbbbbbbbbb');
    const plain = me.git('commit-tree', `${named}^{tree}`, '-p', squash, '-m', 'backup\n\nWisdom-Record: r-bbbbbbbbbbbb');
    me.git('update-ref', 'refs/heads/main', plain);
    writeLink(me.dir, { commit: squash, from: [linked], how: 'squash-merge', basis: 'github', pr: 1, writer: 'ci' });
    const text = prCheck(me.dir, `${named}..${plain}`).text;
    const [forSquash, forPlain] = text.split(/^[0-9a-f]{12} {2}/m).slice(1);
    assert.match(forSquash, /no record of its own; squash merge of PR #1, from GitHub's pull request: 1 recorded commit stands for it/);
    assert.doesNotMatch(forSquash, /Wisdom-Record lines/);
    assert.match(forPlain, /carries 1 recorded commit through their Wisdom-Record lines/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('relink on a new branch (base all zeros) looks at the head commit only, and says so', { skip: !hasGit }, async () => {
  const root = tempRoot('links-zero');
  try {
    const me = teamRepo(root, bare(root));
    const head = edit(me, 'a.ts', t => t.replace('one', 'ONE'), 'head');
    const result = await relink(me.dir, { range: `${'0'.repeat(40)}..${head}`, env: {} });
    assert.equal(result.lines[0], `${'0'.repeat(40)} is not a commit here (a new branch, or a force push), so only ${head.slice(0, 12)} is looked at`);
    assert.equal(result.lines[1], `1 commit in ${'0'.repeat(40)}..${head}, 1 with neither a record nor a link`);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
