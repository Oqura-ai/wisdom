import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { parse, stringify } from 'yaml';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { startDaemon } from '../src/service/daemon.js';
import { call } from '../src/service/client.js';
import { prCheck, prune } from '../src/team/team.js';
import { commitFiles, oldPolicyNote, policyCommands, readFile, readPolicy, recordRef, refExists, setRef, trustCommands, trusted, writePolicy } from '../src/team/gitrefs.js';
import { guideCommit, hooksDir, hooksInstalled, installHooks, jobs, LOCAL_HOOKS, parsePushed, removeHooks, runGitHook } from '../src/team/githooks.js';
import { relink } from '../src/team/relink.js';
import { checkGuide, fillFromPlain, setGuides } from '../src/team/guides.js';
import { claudeOutput, guidePrompt, guideSettings } from '../src/team/writer.js';
import { GUIDE_OPENING, items, PLAIN_MARK, plainGuide, problemSummary, writtenBy } from '../src/team/plain.js';
import { guideWriterRun } from '../src/record/captures.js';
import { startDetached } from '../src/service/client.js';
import { observeSession, openSession } from './session.js';

const hasGit = spawnSync('git', ['--version'], { windowsHide: true }).status === 0;
const obs = (type: string, extra: Record<string, unknown> = {}) => ({ observationId: randomUUID(), type, ...extra });

function person(root: string, name: string, origin: string, clone: boolean) {
  const dir = path.join(root, name);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  if (clone) execFileSync('git', ['clone', '-q', '-c', 'core.autocrlf=false', origin, dir], { windowsHide: true });
  else { fs.mkdirSync(dir); git('init', '-q', '-b', 'main'); git('remote', 'add', 'origin', origin); }
  git('config', 'user.name', name); git('config', 'user.email', `${name}@example.com`); git('config', 'core.autocrlf', 'false');
  fs.appendFileSync(path.join(dir, '.git', 'info', 'exclude'), '.wisdom/\n');
  const real = fs.realpathSync(dir);
  return { dir: real, data: path.join(real, '.wisdom'), git };
}

/** A stand-in for the model: it writes a guide that answers every item, citing its first step. */
function fakeWriter(root: string): string {
  const file = path.join(root, 'writer.mjs');
  fs.writeFileSync(file, `let input = '';
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
  const template = input.slice(input.indexOf('## Items'), input.indexOf('\\nCommit '));
  const items = template.split('\\n').filter(line => line.startsWith('- '));
  const out = ['## Summary', 'Written by a stand-in for ' + process.env.WISDOM_GUIDE_MODEL + '.', '', '## Items'];
  for (const line of items) {
    const step = / · (\\S+)(?: \\([^)]*\\))? in session (\\S+)/.exec(line);
    out.push(line, step ? '  Made by this step [' + step[1] + ' ' + step[2] + '].' : '  No recording explains it.');
  }
  process.stdout.write(out.join('\\n') + '\\n');
});
`);
  return `"${process.execPath}" "${file}"`;
}

/** What a person does once after reading the team file's commands: wisdom team trust. */
function trustPolicy(who: { dir: string; data: string }) {
  trustCommands(who.data, policyCommands(readPolicy(who.dir)));
}

async function until<T>(what: string, check: () => T | undefined, ms = 60_000): Promise<T> {
  for (let waited = 0; waited < ms; waited += 200) {
    const value = check();
    if (value !== undefined) return value;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

const record = (dir: string, sha: string) => { const bytes = readFile(dir, recordRef(sha), 'record.json'); return bytes ? JSON.parse(bytes.toString('utf8')) : undefined; };

test('team mode: every commit gets its link line, a model writes the guide after it, git push carries it all, and a teammate reads it, even through a squash', { skip: !hasGit }, async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wisdom-team-')));
  const origin = path.join(root, 'origin.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin], { windowsHide: true });
  const alice = person(root, 'alice', origin, false);
  fs.writeFileSync(path.join(alice.dir, 'a.ts'), 'one\ntwo\n');
  const { file: policyFile } = writePolicy(alice.dir);
  const policy = parse(fs.readFileSync(policyFile, 'utf8'));
  fs.writeFileSync(policyFile, stringify({ ...policy, guides: { command: fakeWriter(root) } }, null, 2));
  alice.git('add', '-A'); alice.git('commit', '-q', '-m', 'start'); alice.git('push', '-q', 'origin', 'main');
  const base = alice.git('rev-parse', 'HEAD');

  const daemon = await startDaemon(alice.data, 0);
  let bobDaemon: Awaited<ReturnType<typeof startDaemon>> | undefined;
  try {
    installHooks(alice.dir, alice.data);
    trustPolicy(alice);
    assert.equal(hooksInstalled(alice.dir), true);
    const { captureId: id } = await openSession(daemon.connection, { harness: 'pi', sessionId: 'alice-session-1', workspaceRoot: alice.dir, source: null });
    const send = (o: unknown) => observeSession(daemon.connection, id, o);
    await send(obs('input', { data: { text: 'Make two say TWO.' } }));
    await send(obs('tool_started', { toolCallId: 'e1', toolName: 'edit', data: { input: { path: 'a.ts' } } }));
    fs.writeFileSync(path.join(alice.dir, 'a.ts'), 'one\nTWO\n');
    await send(obs('tool_finished', { toolCallId: 'e1', toolName: 'edit', isError: false, data: { content: 'ok' } }));

    // The agent commits as usual: nothing stops it, and the commit returns at once.
    alice.git('commit', '-q', '-am', 'two');
    const sha = alice.git('rev-parse', 'HEAD');
    const line = /^Wisdom-Record: (r-[a-f0-9]+)$/m.exec(alice.git('log', '-1', '--format=%B'))?.[1];
    assert(line, 'the commit message carries its link line');
    const kept = await until('the guide', () => record(alice.dir, sha)?.guide ? record(alice.dir, sha) : undefined);
    assert.equal(kept.recordId, line);
    // The policy names a command and no model, so the label names only the command.
    assert.match(kept.guide.writer, /writer\.mjs" \(model not named\)$/);
    assert.doesNotMatch(kept.guide.writer, /claude-haiku/);
    assert.deepEqual(kept.guide.problems, []);
    assert.match(kept.guide.text, /^- a\.ts @@ -2,1 \+2,1 @@ · t1\/c1 in session alice-se\n {2}Made by this step \[t1\/c1 alice-se\]\.$/m);
    // The job says what it did, one line in jobs.log.
    const jobsLog = path.join(alice.data, 'jobs.log');
    const logged = await until('the job line', () => fs.existsSync(jobsLog) ? fs.readFileSync(jobsLog, 'utf8').split('\n').find(l => l.includes(sha.slice(0, 12))) : undefined);
    assert.match(logged, new RegExp(`^\\S+Z ${sha.slice(0, 12)} job · record kept · guide by .* \\(model not named\\), check passed, writer [\\d.]+ s · \\d+ s$`));
    // wisdom guide <commit> has the writer write it again, as a new version of the record's ref.
    const versions = () => Number(alice.git('rev-list', '--count', recordRef(sha)));
    const before = versions();
    assert.match(guideCommit(alice.data, sha).guide!.writer, / \(model not named\)$/);
    assert.equal(versions(), before + 1);

    const own = (await call(daemon.connection, '/ledger', { glance: true, commit: 'HEAD' })).text;
    assert.match(own, /^record kept when the commit was made, /m);
    assert.match(own, /^guide · written by .* \(model not named\), \S+ \S+ · derived, not evidence · Wisdom checked that it covers every item and that its citations exist, not that it is right$/m);

    // The person's own push carries the sessions and the records.
    const pushed = spawnSync('git', ['push', 'origin', 'main'], { cwd: alice.dir, encoding: 'utf8', windowsHide: true });
    assert.equal(pushed.status, 0, pushed.stderr);
    assert.match(pushed.stderr, /Wisdom: 1 commit record and 1 session version\(s\) sent to origin\./);
    const remote = execFileSync('git', ['ls-remote', origin, 'refs/wisdom/*'], { encoding: 'utf8' });
    assert.match(remote, new RegExp(`refs/wisdom/${policy.repoId}/records/${sha}`));
    assert.match(remote, new RegExp(`refs/wisdom/${policy.repoId}/sessions/[a-f0-9-]{36}/alice-session-1`));

    // Bob reads the commit through Alice's session, and through a squash that only keeps the line.
    const bob = person(root, 'bob', origin, true);
    bobDaemon = await startDaemon(bob.data, 0);
    assert.equal((await call(bobDaemon.connection, '/team', { action: 'fetch' })).imported.length, 1);
    assert.match((await call(bobDaemon.connection, '/ledger', { glance: true, commit: sha })).text, /^ {4}@@ -2,1 \+2,1 @@ {2}t1\/c1 in session alice-se$/m);
    const check = prCheck(bob.dir, `${base}..${sha}`);
    assert.equal(check.ok, true, check.text);
    assert.match(check.text, /^ {4}agent work · guide by .* \(model not named\) · 1 sessions$/m);
    bob.git('checkout', '-q', '-b', 'squashed', base);
    fs.writeFileSync(path.join(bob.dir, 'a.ts'), 'one\nTWO\n');
    bob.git('commit', '-q', '-am', `two (#1)\n\n* two\n\nWisdom-Record: ${line}`);
    const squashed = (await call(bobDaemon.connection, '/ledger', { glance: true, commit: 'HEAD' })).text;
    assert.match(squashed, /its message carries 1 recorded commit through their Wisdom-Record lines/);
    assert.match(squashed, /^ {4}@@ -2,1 \+2,1 @@ {2}t1\/c1 in session alice-se$/m);
    assert.match(prCheck(bob.dir, `${base}..HEAD`).text, /carries 1 recorded commit/);

    // The first commit's window reads its session from the start.
    assert.equal(kept.window.since, undefined);
    assert.deepEqual(kept.sessions[0].turns, [1, 1]);

    // A person who turns guides off calls no model: Wisdom writes a plain guide from the
    // record, and CI accepts it. The window now starts at Alice's previous commit.
    setGuides(alice.data, false);
    await send(obs('input', { data: { text: 'Make one say ONE.' } }));
    await send(obs('tool_started', { toolCallId: 'e2', toolName: 'edit', data: { input: { path: 'a.ts' } } }));
    fs.writeFileSync(path.join(alice.dir, 'a.ts'), 'ONE\nTWO\n');
    await send(obs('tool_finished', { toolCallId: 'e2', toolName: 'edit', isError: false, data: { content: 'ok' } }));
    alice.git('commit', '-q', '-am', 'one');
    const off = alice.git('rev-parse', 'HEAD');
    const offRecord = await until('the plain guide', () => record(alice.dir, off)?.guide ? record(alice.dir, off) : undefined);
    assert.equal(offRecord.guide.writer, 'Wisdom, no model (wisdom guide off)');
    assert.deepEqual(offRecord.guide.problems, []);
    assert.match(offRecord.guide.text, /^ {2}Made by \[t2\/c1 alice-se\] \(pi\)\. Asked in t2: "Make one say ONE\."\.$/m);
    assert.equal(offRecord.window.since.commit, sha);
    assert.deepEqual(offRecord.sessions[0].turns, [1, 2]);
    assert.match((await call(daemon.connection, '/ledger', { glance: true, commit: 'HEAD' })).text,
      new RegExp(`^ {4}window: since your previous commit on this branch, ${sha.slice(0, 12)} `, 'm'));
    assert.equal(spawnSync('git', ['push', 'origin', 'main'], { cwd: alice.dir, windowsHide: true }).status, 0);
    const offCheck = prCheck(alice.dir, `${sha}..${off}`);
    assert.equal(offCheck.ok, true, offCheck.text);
    assert.match(offCheck.text, /guide by Wisdom, no model/);

    // A model told to explore is given the sessions and their windows, and the ledger tool.
    const explore = guidePrompt(daemon.captures, offRecord, true);
    assert.match(explore, /^- alice-session-1 \(pi\) · made t2\/c1 · window t1–t2$/m);
    assert.match(explore, /you have one tool, ledger/);
    assert.doesNotMatch(explore, /Do not use tools/);
    // It asks for what the edits alone do not show (live test 8.7): departures, reasons, tests.
    for (const asked of [/where the agent did not do what was asked/, /reasons given in other turns/, /tests or checks run in the window/,
      /^## Beyond the edits$/m, /^Departed from the request: /m, /^Reasons from other turns: /m, /^Tests run: /m]) assert.match(explore, asked);
    assert.match(guidePrompt(daemon.captures, offRecord), /^Tests run: <.*"none shown in the evidence">$/m);
    // That section is optional for the check, and its citations are checked like any other.
    const beyond = '\n## Beyond the edits\nDeparted from the request: none found in the window\nReasons from other turns: none\nTests run: the edit was checked [t2 alice-se]\n';
    assert.deepEqual(checkGuide(offRecord.guide.text + beyond, offRecord, () => daemon.captures, () => ['alice-session-1']), []);
    assert.match(checkGuide(offRecord.guide.text + beyond.replace('[t2 alice-se]', '[t9 alice-se]'), offRecord, () => daemon.captures, () => ['alice-session-1']).join('\n'), /t9/);
    // A citation of a turn outside the window, or of a session that is not the commit's, fails the check.
    const ids = () => ['alice-session-1', 'other-session-x'];
    const narrow = { ...offRecord, sessions: [{ ...offRecord.sessions[0], turns: [2, 2] }] };
    assert.match(checkGuide(offRecord.guide.text.replace('[t2/c1 alice-se]', '[t1/c1 alice-se]'), narrow, () => daemon.captures, ids).join('\n'), /outside this commit's window/);

    // Retention keeps a session a pushed record still names.
    fs.writeFileSync(policyFile, stringify({ ...parse(fs.readFileSync(policyFile, 'utf8')), retentionDays: 30 }));
    assert.deepEqual(prune(daemon.captures, undefined, Date.now() + 90 * 86_400_000), []);

    // Deleted for the team: Bob's copy goes, his read says so, and CI notices.
    const deleted = await call(daemon.connection, '/team', { action: 'delete', session: id });
    assert.match(deleted.key, /^[a-f0-9-]{36}\/alice-session-1$/);
    // Bob's fetch brings what his own branches reach (policy 5.22), so he updates main first.
    bob.git('fetch', '-q', 'origin', 'main:main');
    const firstFetch = await call(bobDaemon.connection, '/team', { action: 'fetch' });
    assert.deepEqual([firstFetch.removed, firstFetch.notRemoved], [[deleted.key], 0]);
    assert.deepEqual(fs.readdirSync(path.join(bob.data, 'shared')), [], 'the copy\'s folder is gone, not only hidden');
    // A second fetch has nothing left to remove, and says so.
    const secondFetch = await call(bobDaemon.connection, '/team', { action: 'fetch' });
    assert.deepEqual([secondFetch.removed, secondFetch.notRemoved], [[], 0]);
    // Bob reads Alice's record: the window is her previous commit, not his (live test 5.11).
    bob.git('fetch', '-q', 'origin');
    const bobReads = (await call(bobDaemon.connection, '/ledger', { glance: true, commit: off })).text;
    assert.match(bobReads, new RegExp(`^ {4}window: since the recorder's previous commit on this branch, ${sha.slice(0, 12)} `, 'm'));
    // And a commit of hers with no record anywhere: none is here, not "none was kept".
    assert.match((await call(bobDaemon.connection, '/ledger', { glance: true, commit: base })).text,
      /^worked out now from the recordings here; no record of this commit is here$/m);
    assert.match((await call(bobDaemon.connection, '/ledger', { glance: true, commit: sha })).text, /t1\/c1 \(session not available\) in session alice-se/);
    assert.match(prCheck(bob.dir, `${base}..${sha}`).text, /session alice-se is not on origin/);

    assert.deepEqual(removeHooks(alice.dir), ['prepare-commit-msg', 'post-commit', 'post-rewrite', 'pre-push']);
    assert.equal(hooksInstalled(alice.dir), false);
  } finally {
    await daemon.close(); await bobDaemon?.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a hook already in place keeps running first, and a hooks folder the repository tracks is left alone', { skip: !hasGit }, () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wisdom-chain-')));
  try {
    const me = person(root, 'me', path.join(root, 'none.git'), false);
    writePolicy(me.dir);
    const theirs = path.join(me.dir, '.git', 'hooks', 'post-commit');
    fs.writeFileSync(theirs, '#!/bin/sh\necho mine\n', { mode: 0o755 });
    assert.deepEqual(installHooks(me.dir, me.data).chained, ['post-commit']);
    assert.equal(fs.readFileSync(`${theirs}.pre-wisdom`, 'utf8'), '#!/bin/sh\necho mine\n');
    removeHooks(me.dir);
    assert.equal(fs.readFileSync(theirs, 'utf8'), '#!/bin/sh\necho mine\n', 'theirs is back as it was');

    fs.mkdirSync(path.join(me.dir, '.husky'));
    fs.writeFileSync(path.join(me.dir, '.husky', 'pre-commit'), 'npm test\n');
    me.git('add', '.husky'); me.git('config', 'core.hooksPath', '.husky');
    assert.throws(() => installHooks(me.dir, me.data), /a folder this repository tracks/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('without wisdom-team.yaml nothing is added to a commit message and nothing is pushed', { skip: !hasGit }, async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wisdom-local-')));
  const origin = path.join(root, 'origin.git');
  execFileSync('git', ['init', '-q', '--bare', origin], { windowsHide: true });
  const me = person(root, 'me', origin, false);
  const daemon = await startDaemon(me.data, 0);
  try {
    const message = path.join(root, 'MSG');
    fs.writeFileSync(message, 'fix\n');
    runGitHook('prepare-commit-msg', [message, 'message'], me.data);
    assert.equal(fs.readFileSync(message, 'utf8'), 'fix\n');
    await assert.rejects(call(daemon.connection, '/team', { action: 'push' }), /no wisdom-team.yaml, so Wisdom is in local mode/);
  } finally { await daemon.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

/** PATH with only node and git on it, so no hook can find a real `claude` and spend money. */
function pathWithoutClaude(): string | undefined {
  const git = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['git'], { encoding: 'utf8', windowsHide: true }).stdout.split(/\r?\n/)[0]?.trim();
  if (!git) return undefined;
  // Windows starts background jobs through PowerShell, in the system folders.
  const system = process.platform === 'win32' ? [path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32'),
    path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0')] : [];
  // Git for Windows runs a hook through its own sh, in <install>/usr/bin. Its cmd/git.exe adds that
  // folder itself, but mingw64/bin/git.exe (the first git in a Git Bash shell) does not.
  const sh = process.platform === 'win32' ? path.resolve(spawnSync('git', ['--exec-path'], { encoding: 'utf8', windowsHide: true }).stdout.trim(), '..', '..', '..', 'usr', 'bin') : undefined;
  const dirs = [...new Set([path.dirname(process.execPath), path.dirname(git), ...system, ...(sh && fs.existsSync(path.join(sh, 'sh.exe')) ? [sh] : [])])];
  const claude = dirs.some(dir => ['claude', 'claude.cmd', 'claude.exe', 'claude.ps1'].some(name => fs.existsSync(path.join(dir, name))));
  return claude ? undefined : dirs.join(path.delimiter);
}

test('local mode: glance --commit shows a plain guide built when read; guide on adds only post-commit, which changes no message and pushes nothing; guide <commit> refuses without what it needs', { skip: !hasGit }, async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wisdom-localguide-')));
  const origin = path.join(root, 'origin.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin], { windowsHide: true });
  const me = person(root, 'me', origin, false);
  fs.writeFileSync(path.join(me.dir, 'a.ts'), 'one\ntwo\n');
  me.git('add', '-A'); me.git('commit', '-q', '-m', 'start');
  const base = me.git('rev-parse', 'HEAD');
  const daemon = await startDaemon(me.data, 0);
  try {
    const { captureId: id } = await openSession(daemon.connection, { harness: 'pi', sessionId: 'me-session-1', workspaceRoot: me.dir, source: null });
    const send = (o: unknown) => observeSession(daemon.connection, id, o);
    await send(obs('input', { data: { text: 'Make two say TWO.' } }));
    await send(obs('tool_started', { toolCallId: 'e1', toolName: 'edit', data: { input: { path: 'a.ts' } } }));
    fs.writeFileSync(path.join(me.dir, 'a.ts'), 'one\nTWO\n');
    await send(obs('tool_finished', { toolCallId: 'e1', toolName: 'edit', isError: false, data: { content: 'ok' } }));
    me.git('commit', '-q', '-am', 'two');
    const sha = me.git('rev-parse', 'HEAD');
    await until('the record', () => record(me.dir, sha));

    // Read, the record has a plain guide, built now: the same text each time, never stored.
    const read = async () => (await call(daemon.connection, '/ledger', { glance: true, commit: sha })).text;
    const text = await read();
    assert.match(text, new RegExp(`^guide · plain, built from the record now, no model · derived, not evidence · not stored; a model guide on request: wisdom guide ${sha.slice(0, 12)}$`, 'm'));
    assert.match(text, /^ {4}- a\.ts @@ -2,1 \+2,1 @@ · t1\/c1 in session me-sessi\n {6}Made by \[t1\/c1 me-sessi\] \(pi\)\. Asked in t1: "Make two say TWO\."\.$/m);
    assert.equal(await read(), text);
    assert.equal(record(me.dir, sha).guide, undefined);

    // wisdom guide <commit> refuses a commit with no record, and one whose session is gone.
    assert.throws(() => guideCommit(me.data, base), /No record was kept for/);
    const other = me.git('commit-tree', '-p', sha, '-m', 'elsewhere', `${sha}^{tree}`);
    const gone = { ...record(me.dir, sha), commit: { ...record(me.dir, sha).commit, sha: other }, sessions: [{ ...record(me.dir, sha).sessions[0], id: 'gone-session' }] };
    setRef(me.dir, recordRef(other), commitFiles(me.dir, { 'record.json': JSON.stringify(gone) }, 'test'));
    assert.throws(() => guideCommit(me.data, other), /the guide must read session gone-session, which is no longer recorded here .* The record stays as it is\./);

    // wisdom guide on, in local mode: one post-commit hook, nothing else.
    setGuides(me.data, true);
    installHooks(me.dir, me.data, LOCAL_HOOKS);
    const hooks = hooksDir(me.dir);
    assert.equal(fs.existsSync(path.join(hooks, 'post-commit')), true);
    assert.equal(fs.existsSync(path.join(hooks, 'prepare-commit-msg')), false);
    assert.equal(fs.existsSync(path.join(hooks, 'pre-push')), false);
    assert.equal(hooksInstalled(me.dir), false);

    const PATH = pathWithoutClaude();
    if (PATH) {
      await send(obs('input', { data: { text: 'Make one say ONE.' } }));
      await send(obs('tool_started', { toolCallId: 'e2', toolName: 'edit', data: { input: { path: 'a.ts' } } }));
      fs.writeFileSync(path.join(me.dir, 'a.ts'), 'ONE\nTWO\n');
      await send(obs('tool_finished', { toolCallId: 'e2', toolName: 'edit', isError: false, data: { content: 'ok' } }));
      execFileSync('git', ['commit', '-q', '-am', 'one'], { cwd: me.dir, windowsHide: true, env: { ...process.env, PATH, Path: PATH } });
      const next = me.git('rev-parse', 'HEAD');
      // The hook's job ran (here with no writer to find), the message is unchanged, nothing is pushed.
      const log = path.join(me.data, 'jobs.log');
      const job = await until('the job', () => record(me.dir, next)?.guideMissing ? record(me.dir, next) : undefined)
        .catch(error => { throw new Error(`${error.message}; jobs.log: ${fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '(none)'}; record: ${JSON.stringify(record(me.dir, next)?.guide ?? null)}`); });
      assert.match(job.guideMissing, /no guide writer/);
      assert.equal(job.recordId, undefined);
      // Kept once, by the job (the daemon's watcher stands aside), then once more with the reason.
      assert.equal(Number(me.git('rev-list', '--count', recordRef(next))), 2);
      assert.equal(me.git('log', '-1', '--format=%B'), 'one');
      me.git('push', '-q', 'origin', 'main');
      assert.equal(execFileSync('git', ['ls-remote', origin, 'refs/wisdom/*'], { encoding: 'utf8' }).trim(), '');
    }

    // wisdom guide off takes the hook out.
    assert.deepEqual(removeHooks(me.dir, LOCAL_HOOKS), ['post-commit']);
    assert.equal(fs.existsSync(path.join(hooks, 'post-commit')), false);
  } finally { await daemon.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('a commit whose job died gets its record and guide from wisdom guide <commit> or the next push, and a dead job holds nothing up', { skip: !hasGit }, async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wisdom-deadjob-')));
  const origin = path.join(root, 'origin.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin], { windowsHide: true });
  const alice = person(root, 'alice', origin, false);
  fs.writeFileSync(path.join(alice.dir, 'a.ts'), 'one\ntwo\nthree\n');
  const { file: policyFile } = writePolicy(alice.dir);
  fs.writeFileSync(policyFile, stringify({ ...parse(fs.readFileSync(policyFile, 'utf8')), guides: { command: fakeWriter(root), model: 'claude-haiku-5-5' } }, null, 2));
  // This policy names its model too, so the guide's label names it: '<model> via <command>'.
  alice.git('add', '-A'); alice.git('commit', '-q', '-m', 'start'); alice.git('push', '-q', 'origin', 'main');
  const daemon = await startDaemon(alice.data, 0);
  try {
    installHooks(alice.dir, alice.data);
    trustPolicy(alice);
    const { captureId: id } = await openSession(daemon.connection, { harness: 'pi', sessionId: 'alice-session-2', workspaceRoot: alice.dir, source: null });
    const send = (o: unknown) => observeSession(daemon.connection, id, o);
    const noHooks = path.join(root, 'no-hooks');
    fs.mkdirSync(noHooks);
    // A commit whose hooks never ran stands for one whose job was killed or never started.
    const edit = async (call: string, text: string, message: string) => {
      await send(obs('tool_started', { toolCallId: call, toolName: 'edit', data: { input: { path: 'a.ts' } } }));
      fs.writeFileSync(path.join(alice.dir, 'a.ts'), text);
      await send(obs('tool_finished', { toolCallId: call, toolName: 'edit', isError: false, data: { content: 'ok' } }));
      alice.git('-c', `core.hooksPath=${noHooks}`, 'commit', '-q', '-am', message);
      return alice.git('rev-parse', 'HEAD');
    };
    await send(obs('input', { data: { text: 'Shout every line.' } }));
    const first = await edit('e1', 'ONE\ntwo\nthree\n', 'one');
    // Its job file stayed behind with no process: dead, so it is not waited for.
    fs.mkdirSync(path.join(alice.data, 'jobs'), { recursive: true });
    fs.writeFileSync(path.join(alice.data, 'jobs', first), JSON.stringify({ sha: first, at: new Date(Date.now() - 60_000).toISOString(), attempts: 3 }));
    assert.deepEqual(jobs(alice.data).dead.map(job => job.sha), [first]);
    assert.deepEqual(jobs(alice.data).running, []);

    // wisdom guide <commit> keeps the missing record of a commit of yours, then writes its guide.
    const second = await edit('e2', 'ONE\nTWO\nthree\n', 'two');
    assert.equal(record(alice.dir, second), undefined);
    const guided = guideCommit(alice.data, second);
    assert.equal(guided.made, 'commit');
    assert.match(guided.guide!.writer, /^claude-haiku-5-5 via /);
    assert.equal(record(alice.dir, second).steps[0].position, 't1/c2');

    // The next push keeps the dead job's record and guide, without waiting for it.
    const started = Date.now();
    const pushed = spawnSync('git', ['push', 'origin', 'main'], { cwd: alice.dir, encoding: 'utf8', windowsHide: true });
    assert.equal(pushed.status, 0, pushed.stderr);
    assert.doesNotMatch(pushed.stderr, /waiting for/);
    assert(Date.now() - started < 60_000);
    assert.match(record(alice.dir, first).guide.writer, /^claude-haiku-5-5 via /);
    assert.equal(fs.existsSync(path.join(alice.data, 'jobs', first)), false);
    assert.match(fs.readFileSync(path.join(alice.data, 'jobs.log'), 'utf8'), new RegExp(`${first.slice(0, 12)} finished at push \\(its job had died\\) · record kept · guide by `));
    assert.match(execFileSync('git', ['ls-remote', origin, 'refs/wisdom/*'], { encoding: 'utf8' }), new RegExp(`records/${first}`));
  } finally { await daemon.close(); fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 }); }
});

test('work recorded before team mode was turned on is not pushed and gets no guide at push', { skip: !hasGit }, async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wisdom-beforeteam-')));
  const origin = path.join(root, 'origin.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin], { windowsHide: true });
  const alice = person(root, 'alice', origin, false);
  try {
    // A local-mode commit with a kept record of agent work.
    fs.writeFileSync(path.join(alice.dir, 'a.ts'), 'one\n');
    alice.git('add', '-A'); alice.git('commit', '-q', '-m', 'local work');
    const local = alice.git('rev-parse', 'HEAD');
    const localRecord = { kind: 'wisdom-commit-record', version: 1, commit: { sha: local, subject: 'local work', committedAt: new Date().toISOString(), tree: '' },
      made: 'commit', madeAt: new Date().toISOString(), wisdomVersion: 'test', steps: [{ session: 'old-session', position: 't1/c1', attribution: 'observed-during-tool', before: null, after: null }],
      files: [], sessions: [{ id: 'old-session', harness: 'pi', positions: ['t1/c1'] }] };
    setRef(alice.dir, recordRef(local), commitFiles(alice.dir, { 'record.json': JSON.stringify(localRecord) }, 'test'));
    // Team mode is turned on afterwards.
    const { file: policyFile } = writePolicy(alice.dir);
    fs.writeFileSync(policyFile, stringify({ ...parse(fs.readFileSync(policyFile, 'utf8')), guides: { command: fakeWriter(root) } }, null, 2));
    alice.git('add', '-A'); alice.git('commit', '-q', '-m', 'Turn on Wisdom team mode');
    installHooks(alice.dir, alice.data);
    fs.mkdirSync(alice.data, { recursive: true });
    fs.writeFileSync(path.join(alice.data, 'wisdom.json'), '{}');
    const pushed = spawnSync('git', ['push', 'origin', 'main'], { cwd: alice.dir, encoding: 'utf8', windowsHide: true });
    assert.equal(pushed.status, 0, pushed.stderr);
    assert.doesNotMatch(execFileSync('git', ['ls-remote', origin, 'refs/wisdom/*'], { encoding: 'utf8' }), new RegExp(`records/${local}`));
    assert.equal(Number(alice.git('rev-list', '--count', recordRef(local))), 1, 'no guide was written for it');
  } finally { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 }); }
});

test('only what is in question moves: a push sends what it pushes, a teammate fetches what their branches reach, CI fetches its range (policy 5.22)', { skip: !hasGit }, async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wisdom-narrow-')));
  const origin = path.join(root, 'origin.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin], { windowsHide: true });
  const alice = person(root, 'alice', origin, false);
  let bobDaemon: Awaited<ReturnType<typeof startDaemon>> | undefined;
  try {
    fs.writeFileSync(path.join(alice.dir, 'a.ts'), 'one\n');
    writePolicy(alice.dir);
    alice.git('add', '-A'); alice.git('commit', '-q', '-m', 'start'); alice.git('push', '-q', 'origin', 'main');
    const base = alice.git('rev-parse', 'HEAD');
    const repoId = readPolicy(alice.dir)!.repoId;
    // Two branches, each commit with a record naming a session, made by hand (no recording here).
    const recorder = 'alice-recorder-0001';
    const made: Record<string, { sha: string; recordId: string; session: string }> = {};
    for (const name of ['a', 'b']) {
      alice.git('checkout', '-q', '-b', `feat/${name}`, base);
      fs.writeFileSync(path.join(alice.dir, `${name}.ts`), `${name}\n`);
      alice.git('add', '-A'); alice.git('commit', '-q', '-m', name);
      const sha = alice.git('rev-parse', 'HEAD');
      const recordId = `r-${name.repeat(12)}`, session = `session-${name}`;
      const kept = { kind: 'wisdom-commit-record', version: 1, recordId, commit: { sha, subject: name, committedAt: new Date().toISOString(), tree: '' },
        made: 'commit', madeAt: new Date().toISOString(), wisdomVersion: 'test', steps: [], files: [], sessions: [{ id: session, harness: 'pi', recorder, positions: [] }] };
      setRef(alice.dir, recordRef(sha), commitFiles(alice.dir, { 'record.json': JSON.stringify(kept) }, 'test'));
      setRef(alice.dir, `refs/wisdom/sessions/${recorder}/${session}`, commitFiles(alice.dir, { 'meta.json': '{}' }, 'test'));
      alice.git('push', '-q', '--no-verify', 'origin', `refs/wisdom/sessions/${recorder}/${session}:refs/wisdom/${repoId}/sessions/${recorder}/${session}`);
      made[name] = { sha, recordId, session };
    }
    fs.mkdirSync(alice.data, { recursive: true });
    fs.writeFileSync(path.join(alice.data, 'wisdom.json'), '{}');
    installHooks(alice.dir, alice.data);
    const onRemote = () => execFileSync('git', ['ls-remote', origin, 'refs/wisdom/*'], { encoding: 'utf8' });

    // 3. A push sends the records of what it pushes, not of the branch checked out (feat/b).
    assert.deepEqual(parsePushed(`refs/heads/feat/a ${made.a.sha} refs/heads/feat/a ${'0'.repeat(40)}\n`), [made.a.sha]);
    assert.deepEqual(parsePushed(`(delete) ${'0'.repeat(40)} refs/heads/old ${made.a.sha}\n`), [], 'a push that only deletes sends no records');
    assert.equal(parsePushed('\n'), undefined, 'no list from git: the push goes by HEAD');
    const pushedA = spawnSync('git', ['push', 'origin', 'feat/a'], { cwd: alice.dir, encoding: 'utf8', windowsHide: true });
    assert.equal(pushedA.status, 0, pushedA.stderr);
    assert.match(pushedA.stderr, /Wisdom: 1 commit record and 0 session version\(s\) sent to origin\./);
    assert.match(onRemote(), new RegExp(`records/${made.a.sha}`));
    assert.doesNotMatch(onRemote(), new RegExp(`records/${made.b.sha}`));
    assert.equal(spawnSync('git', ['push', 'origin', 'feat/b'], { cwd: alice.dir, windowsHide: true }).status, 0);
    assert.match(onRemote(), new RegExp(`records/${made.b.sha}`));
    // The team deletes session b.
    const deletedList = commitFiles(alice.dir, { 'deleted.json': JSON.stringify([{ key: `${recorder}/${made.b.session}`, deletedAt: new Date().toISOString(), reason: 'deleted' }]) }, 'test');
    alice.git('push', '-q', '--no-verify', 'origin', `${deletedList}:refs/wisdom/${repoId}/deleted`);

    // 2. Bob's fetch brings what his own branches reach; the deletion list comes whole.
    const bob = person(root, 'bob', origin, true);
    bobDaemon = await startDaemon(bob.data, 0);
    const fetched = (key: string) => refExists(bob.dir, `refs/wisdom/fetched/sessions/${recorder}/${key}`);
    await call(bobDaemon.connection, '/team', { action: 'fetch' });
    assert.equal(refExists(bob.dir, 'refs/wisdom/deleted'), true);
    assert.deepEqual([record(bob.dir, made.a.sha), record(bob.dir, made.b.sha), fetched(made.a.session)], [undefined, undefined, false], 'main reaches neither branch');
    bob.git('branch', 'feat/a', 'origin/feat/a');
    await call(bobDaemon.connection, '/team', { action: 'fetch' });
    assert.equal(record(bob.dir, made.a.sha)?.recordId, made.a.recordId);
    assert.equal(fetched(made.a.session), true);
    assert.equal(record(bob.dir, made.b.sha), undefined, 'a branch Bob does not have brings nothing');
    bob.git('branch', 'feat/b', 'origin/feat/b');
    await call(bobDaemon.connection, '/team', { action: 'fetch' });
    assert.equal(record(bob.dir, made.b.sha)?.recordId, made.b.recordId);
    assert.equal(fetched(made.b.session), false, 'a deleted session is not fetched');

    // 1. CI fetches the records of its range and never a session.
    const carol = person(root, 'carol', origin, true);
    const sessionsHere = (dir: string) => execFileSync('git', ['for-each-ref', 'refs/wisdom/fetched/sessions/'], { cwd: dir, encoding: 'utf8' }).trim();
    const check = prCheck(carol.dir, `${base}..origin/feat/a`);
    assert.equal(check.ok, true, check.text);
    assert.equal(record(carol.dir, made.a.sha)?.recordId, made.a.recordId);
    assert.equal(record(carol.dir, made.b.sha), undefined, 'a record outside the range is not fetched');
    assert.equal(sessionsHere(carol.dir), '');
    // A squash with no link names its records only by ID (the backup): then every record comes, still no session.
    carol.git('checkout', '-q', '-b', 'squashed', base);
    fs.writeFileSync(path.join(carol.dir, 'b.ts'), 'b\n');
    carol.git('add', '-A'); carol.git('commit', '-q', '-m', `b (#2)\n\nWisdom-Record: ${made.b.recordId}`);
    assert.match(prCheck(carol.dir, `${base}..HEAD`).text, /carries 1 recorded commit/);
    assert.equal(sessionsHere(carol.dir), '');
    // The relink job looks at its range only.
    const dave = person(root, 'dave', origin, true);
    const relinked = await relink(dave.dir, { range: `${base}..origin/feat/a`, env: {} });
    assert.match(relinked.lines.join('\n'), /1 commit in .*, 0 with neither a record nor a link/);
    assert.deepEqual([record(dave.dir, made.a.sha)?.recordId, record(dave.dir, made.b.sha), sessionsHere(dave.dir)], [made.a.recordId, undefined, '']);
  } finally {
    await bobDaemon?.close();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  }
});

test('a secret quoted in a commit record is redacted before push, in every version the remote gets (live test 5.4)', { skip: !hasGit }, async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wisdom-recsecret-')));
  const origin = path.join(root, 'origin.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin], { windowsHide: true });
  const alice = person(root, 'alice', origin, false);
  fs.writeFileSync(path.join(alice.dir, 'a.ts'), 'one\n');
  writePolicy(alice.dir);
  alice.git('add', '-A'); alice.git('commit', '-q', '-m', 'start'); alice.git('push', '-q', 'origin', 'main');
  const secret = 'sk-proj-abcdefghijklmnopqrstuvwxyz123456';
  const daemon = await startDaemon(alice.data, 0);
  try {
    installHooks(alice.dir, alice.data);
    setGuides(alice.data, false);
    const { captureId: id } = await openSession(daemon.connection, { harness: 'pi', sessionId: 'secret-session', workspaceRoot: alice.dir, source: null });
    const send = (o: unknown) => observeSession(daemon.connection, id, o);
    await send(obs('input', { data: { text: `Use the key ${secret} and shout.` } }));
    await send(obs('tool_started', { toolCallId: 'e1', toolName: 'edit', data: { input: { path: 'a.ts' } } }));
    fs.writeFileSync(path.join(alice.dir, 'a.ts'), 'ONE\n');
    await send(obs('tool_finished', { toolCallId: 'e1', toolName: 'edit', isError: false, data: { content: 'ok' } }));
    alice.git('commit', '-q', '-am', 'shout');
    const sha = alice.git('rev-parse', 'HEAD');
    // The plain guide quotes the request as asked, secret included, on this machine.
    await until('the plain guide', () => record(alice.dir, sha)?.guide?.text.includes(secret) ? true : undefined);

    const pushed = spawnSync('git', ['push', 'origin', 'main'], { cwd: alice.dir, encoding: 'utf8', windowsHide: true });
    assert.equal(pushed.status, 0, pushed.stderr);
    assert.match(pushed.stderr, /1 possible secret redacted in the records first\./);
    const remote = (...args: string[]) => execFileSync('git', ['--git-dir', origin, ...args], { encoding: 'utf8', windowsHide: true }).trim();
    const ref = remote('for-each-ref', '--format=%(refname)', `refs/wisdom/*/records/${sha}`);
    assert(ref, 'the record is on the remote');
    for (const version of remote('rev-list', ref).split('\n')) assert(!remote('show', `${version}:record.json`).includes(secret), `version ${version} holds no secret`);
    assert.match(remote('show', `${ref}:record.json`), /\[redacted by sender: openai-key\]/);
    // The session the record cites keeps the original; a second push sends nothing new.
    assert.match((await call(daemon.connection, '/ledger', { capture: id, open: 't1' })).text, new RegExp(secret));
    const again = spawnSync('git', ['push', 'origin', 'main'], { cwd: alice.dir, encoding: 'utf8', windowsHide: true });
    assert.doesNotMatch(again.stderr, /redacted/);
  } finally { await daemon.close(); fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 }); }
});

test('a session the project\'s check held back is tried again at each push, with a short cause (live test 5.5)', { skip: !hasGit }, async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wisdom-heldback-')));
  const origin = path.join(root, 'origin.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin], { windowsHide: true });
  const alice = person(root, 'alice', origin, false);
  fs.writeFileSync(path.join(alice.dir, 'a.ts'), 'one\n');
  const { file: policyFile } = writePolicy(alice.dir);
  const setCheck = (code: number) => fs.writeFileSync(policyFile, stringify({ ...parse(fs.readFileSync(policyFile, 'utf8')),
    check: `"${process.execPath}" -e "process.stderr.write('found sk-proj-secretvalue1234567890abcd'); process.exit(${code})"` }, null, 2));
  setCheck(1);
  alice.git('add', '-A'); alice.git('commit', '-q', '-m', 'start'); alice.git('push', '-q', 'origin', 'main');
  const daemon = await startDaemon(alice.data, 0);
  try {
    installHooks(alice.dir, alice.data);
    setGuides(alice.data, false);
    const { captureId: id } = await openSession(daemon.connection, { harness: 'pi', sessionId: 'held-session', workspaceRoot: alice.dir, source: null });
    const send = (o: unknown) => observeSession(daemon.connection, id, o);
    await send(obs('input', { data: { text: 'Shout.' } }));
    await send(obs('tool_started', { toolCallId: 'e1', toolName: 'edit', data: { input: { path: 'a.ts' } } }));
    fs.writeFileSync(path.join(alice.dir, 'a.ts'), 'ONE\n');
    await send(obs('tool_finished', { toolCallId: 'e1', toolName: 'edit', isError: false, data: { content: 'ok' } }));
    alice.git('commit', '-q', '-am', 'shout');
    const sha = alice.git('rev-parse', 'HEAD');
    await until('the guide', () => record(alice.dir, sha)?.guide ? true : undefined);
    const sessionOnRemote = () => execFileSync('git', ['--git-dir', origin, 'for-each-ref', '--format=%(refname)', 'refs/wisdom/*/sessions/*/*'], { encoding: 'utf8' }).trim();

    // Not trusted yet: the check is not run and not skipped, so the session stays here.
    const untrusted = spawnSync('git', ['push', 'origin', 'main'], { cwd: alice.dir, encoding: 'utf8', windowsHide: true });
    assert.equal(untrusted.status, 0, untrusted.stderr);
    assert.match(untrusted.stderr, /held back held-ses \(the project's check is not trusted on this machine yet \(wisdom team trust\)\)/);
    assert.equal(sessionOnRemote(), '');
    trustPolicy(alice);

    const first = spawnSync('git', ['push', 'origin', 'main'], { cwd: alice.dir, encoding: 'utf8', windowsHide: true });
    assert.match(first.stderr, /Wisdom: held back held-ses \(refused by the project's check\); it is tried again at each push\./);
    assert.doesNotMatch(first.stderr, /secretvalue/, 'the check\'s own output is never shown');
    assert.equal(sessionOnRemote(), '');
    // Nothing new to push, but the record on the remote names a session it lacks: tried again.
    const again = spawnSync('git', ['push', 'origin', 'main'], { cwd: alice.dir, encoding: 'utf8', windowsHide: true });
    assert.match(again.stderr, /held back held-ses/);
    assert.doesNotMatch(prCheck(alice.dir, `${sha}~1..${sha}`).text, /wisdom team push/);
    // Someone changes the command: it is not trusted until this person looks again.
    setCheck(0);
    const changed = spawnSync('git', ['push', 'origin', 'main'], { cwd: alice.dir, encoding: 'utf8', windowsHide: true });
    assert.match(changed.stderr, /not trusted on this machine yet/);
    trustPolicy(alice);
    const fixed = spawnSync('git', ['push', 'origin', 'main'], { cwd: alice.dir, encoding: 'utf8', windowsHide: true });
    assert.doesNotMatch(fixed.stderr, /held back/);
    assert.match(sessionOnRemote(), /\/held-session$/);
  } finally { await daemon.close(); fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 }); }
});

test('a commit\'s job goes by the guide switch and writer as they were at the commit (live tests 4.9, 6.3)', { skip: !hasGit }, async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wisdom-snapshot-')));
  const origin = path.join(root, 'origin.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin], { windowsHide: true });
  const alice = person(root, 'alice', origin, false);
  fs.writeFileSync(path.join(alice.dir, 'a.ts'), 'one\n');
  const { file: policyFile } = writePolicy(alice.dir);
  fs.writeFileSync(policyFile, stringify({ ...parse(fs.readFileSync(policyFile, 'utf8')), guides: { command: fakeWriter(root) } }, null, 2));
  alice.git('add', '-A'); alice.git('commit', '-q', '-m', 'start');
  const daemon = await startDaemon(alice.data, 0);
  try {
    const { captureId: id } = await openSession(daemon.connection, { harness: 'pi', sessionId: 'snap-session', workspaceRoot: alice.dir, source: null });
    const send = (o: unknown) => observeSession(daemon.connection, id, o);
    await send(obs('input', { data: { text: 'Shout.' } }));
    await send(obs('tool_started', { toolCallId: 'e1', toolName: 'edit', data: { input: { path: 'a.ts' } } }));
    fs.writeFileSync(path.join(alice.dir, 'a.ts'), 'ONE\n');
    await send(obs('tool_finished', { toolCallId: 'e1', toolName: 'edit', isError: false, data: { content: 'ok' } }));
    const noHooks = path.join(root, 'no-hooks'); fs.mkdirSync(noHooks);
    alice.git('-c', `core.hooksPath=${noHooks}`, 'commit', '-q', '-am', 'shout');
    const sha = alice.git('rev-parse', 'HEAD');
    // post-commit keeps the switch and the writer in the job file.
    setGuides(alice.data, false);
    runGitHook('post-commit', [], alice.data, () => {});
    const jobFile = path.join(alice.data, 'jobs', sha);
    assert.deepEqual(JSON.parse(fs.readFileSync(jobFile, 'utf8')).settings?.guides, false);
    await until('the job', () => fs.existsSync(jobFile) ? undefined : true);
    // Off at the commit, on now: a job started with that snapshot still writes the plain guide.
    fs.mkdirSync(path.join(alice.data, 'jobs'), { recursive: true });
    fs.writeFileSync(jobFile, JSON.stringify({ sha, at: new Date().toISOString(), attempts: 1, settings: { guides: false } }));
    alice.git('update-ref', '-d', recordRef(sha));
    setGuides(alice.data, true);
    runGitHook('record', [sha], alice.data, () => {});
    assert.equal(record(alice.dir, sha).guide.writer, 'Wisdom, no model (wisdom guide off)');
  } finally { await daemon.close(); fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 }); }
});

test('a huge commit made by one step is one guide item, and a guide of the grouped items passes the check (live test 8.1)', () => {
  const step = { session: 'big-session-1', position: 't1/c1', attribution: 'observed-during-tool', before: null, after: 'h' };
  const other = { ...step, position: 't2/c1' };
  const files = Array.from({ length: 2000 }, (_, n) => ({ path: `gen/f${n}.ts`, operation: 'create', added: 1, removed: 0, complete: true, chain: [0],
    pieces: [{ header: '@@ -0,0 +1,1 @@', steps: [0], unexplained: 0 }] }));
  files.push({ path: 'src/main.ts', operation: 'modify', added: 1, removed: 1, complete: true, chain: [1], pieces: [{ header: '@@ -1,1 +1,1 @@', steps: [1], unexplained: 0 }] });
  files.push({ path: 'notes.txt', operation: 'modify', added: 1, removed: 0, complete: false, chain: [], pieces: [{ header: '@@ -1,0 +2,1 @@', steps: [], unexplained: 1 }] });
  const big = { kind: 'wisdom-commit-record', version: 1, commit: { sha: 'f'.repeat(40), subject: 'generate', committedAt: new Date().toISOString(), tree: '' },
    made: 'commit', madeAt: new Date().toISOString(), wisdomVersion: 'test', steps: [step, other], files,
    sessions: [{ id: 'big-session-1', harness: 'claude-code', positions: ['t1/c1', 't2/c1'] }] } as any;
  const list = items(big);
  assert.deepEqual(list.map(item => item.key), ['group 1: 2000 pieces in 2000 files', 'src/main.ts @@ -1,1 +1,1 @@', 'notes.txt @@ -1,0 +2,1 @@']);
  assert.match(list[0].label, /^t1\/c1 in session big-sess · gen\/f0\.ts, gen\/f1\.ts, .*, and 1992 more$/);
  // A small commit keeps one item per piece.
  assert.equal(items({ ...big, files: files.slice(0, 5) }).length, 5);
  // A guide answering the three items passes the check (skip: needs no session to open).
  const guide = ['## Summary', 'Generated files.', '', '## Items', ...list.flatMap(item => [`- ${item.key} · ${item.label}`, '  skip: test']), ''].join('\n');
  assert.deepEqual(checkGuide(guide, big, () => undefined, () => []), []);
  assert(plainGuide(big, () => undefined).split('\n').length < 20, 'the plain guide is short too');
});

test('a model guide that stops early is filled from the record: every piece is answered, the model\'s own items stay, and the check passes on coverage', () => {
  const step = (n: number) => ({ session: 'fill-session-1', position: `t1/c${n}`, attribution: 'observed-during-tool', before: null, after: `h${n}` });
  const files = Array.from({ length: 6 }, (_, n) => ({ path: `src/f${n}.ts`, operation: 'create', added: 1, removed: 0, complete: true, chain: [n],
    pieces: [{ header: '@@ -0,0 +1,1 @@', steps: [n], unexplained: 0 }] }));
  const rec = { kind: 'wisdom-commit-record', version: 1, commit: { sha: 'e'.repeat(40), subject: 'six files', committedAt: new Date().toISOString(), tree: '' },
    made: 'commit', madeAt: new Date().toISOString(), wisdomVersion: 'test', steps: files.map((_, n) => step(n + 1)), files,
    sessions: [{ id: 'fill-session-1', harness: 'claude-code', positions: files.map((_, n) => `t1/c${n + 1}`) }] } as any;
  const list = items(rec);
  // As on a 95-piece commit: two items written, one with no citation, the rest never reached.
  const model = ['## Summary', 'Adds six files.', '', '## Items',
    `- ${list[0].key} · ${list[0].label}`, '  The first file [t1/c1 fill-ses].',
    `- ${list[1].key} · ${list[1].label}`, '  The second file, no citation.',
    '', '## Beyond the edits', 'Not covered: the other four files.', ''].join('\n');
  const coverage = (text: string) => checkGuide(text, rec, () => undefined, () => []).filter(p => /is missing|cites none|nothing is written/.test(p));
  assert.equal(coverage(model).length, 5, '4 missing, 1 without a citation');
  const filled = fillFromPlain(model, rec, () => undefined);
  assert.deepEqual([filled.filled, filled.items], [5, 6]);
  assert.deepEqual(coverage(filled.text), [], 'every item answered');
  assert.match(filled.text, /^## Summary\nAdds six files\.\n\n## Items\n/, 'the model\'s summary stays');
  assert.match(filled.text, /The first file \[t1\/c1 fill-ses\]\./, 'the model\'s own item stays as written');
  assert.doesNotMatch(filled.text, /no citation/, 'an item with no citation is replaced');
  assert.equal(filled.text.split(PLAIN_MARK).length - 1, 5, 'each filled item says it is from the record');
  assert.match(filled.text, /\n## Beyond the edits\nNot covered: the other four files\.\n$/, 'its closing sections stay, at the end');
  assert.deepEqual(list.map(item => filled.text.indexOf(`- ${item.key}`) >= 0), list.map(() => true));
  // A guide that answers everything is left exactly as it was; one with no summary gets the plain one.
  const whole = plainGuide(rec, () => undefined);
  assert.deepEqual(fillFromPlain(whole, rec, () => undefined), { text: whole, filled: 0, items: 6 });
  assert.match(fillFromPlain('nothing useful', rec, () => undefined).text, /^## Summary\nsix files\. Written by Wisdom from the commit's record/);
  // How readers name it.
  assert.equal(writtenBy({ writer: 'claude-haiku-5-5', filled: 5, items: 6 }), 'claude-haiku-5-5 for 1 of 6 items; 5 from the record, no model');
  assert.equal(writtenBy({ writer: 'claude-haiku-5-5' }), 'claude-haiku-5-5');
});

test('a guide\'s problems read as one line: counted by kind, a few named, the rest said as a number', () => {
  const problems = [...Array.from({ length: 90 }, (_, n) => `The item "- src/f${n}.ts @@ -0,0 +1,1 @@" is missing.`),
    'group 1: 2 pieces in 1 files: made by a recorded step, but cites none.', '[t9/c1 abcdefgh]: no session starts with abcdefgh.'];
  assert.equal(problemSummary(problems),
    '90 items missing (src/f0.ts @@ -0,0 +1,1 @@, src/f1.ts @@ -0,0 +1,1 @@, src/f2.ts @@ -0,0 +1,1 @@, and 87 more); 1 item cites no step (group 1: 2 pieces in 1 files); [t9/c1 abcdefgh]: no session starts with abcdefgh.');
  assert.doesNotMatch(problemSummary(problems), /\.;|\.\./, 'no doubled punctuation');
  assert.equal(problemSummary(['a.', 'b.', 'c.', 'd.', 'e.']), 'a; b; c; and 2 more.');
});

test('two background jobs started a second apart both run (a shared cmd log once stopped the second)', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wisdom-twojobs-')));
  try {
    const script = path.join(root, 'job.mjs');
    fs.writeFileSync(script, `import fs from 'node:fs'; fs.writeFileSync(process.argv[2], 'ran'); setTimeout(() => {}, Number(process.argv[3]));`);
    startDetached([script, path.join(root, 'A'), '5000']);
    await new Promise(resolve => setTimeout(resolve, 1000));
    startDetached([script, path.join(root, 'B'), '0']);
    await until('both jobs', () => fs.existsSync(path.join(root, 'A')) && fs.existsSync(path.join(root, 'B')) ? true : undefined, 15_000);
  } finally { await new Promise(resolve => setTimeout(resolve, 5000)); fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 }); }
});

test('a guide writer\'s run found in a harness home is never a session; Claude Code\'s JSON result gives the guide and its cost', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wisdom-writerrun-')));
  try {
    const writer = path.join(root, 'writer.jsonl'), person = path.join(root, 'person.jsonl');
    fs.writeFileSync(writer, [JSON.stringify({ type: 'queue-operation' }),
      JSON.stringify({ type: 'user', sessionId: 'w', cwd: os.tmpdir(), message: { role: 'user', content: `${GUIDE_OPENING} Say what each part does.` } })].join('\n'));
    fs.writeFileSync(person, [JSON.stringify({ type: 'user', sessionId: 'p', cwd: root, message: { role: 'user', content: 'Fix the bug.' } }),
      JSON.stringify({ type: 'user', sessionId: 'p', cwd: root, message: { role: 'user', content: GUIDE_OPENING } })].join('\n'));
    assert.equal(guideWriterRun(writer), true);
    assert.equal(guideWriterRun(person), false, 'only the first request counts');
    assert.deepEqual(claudeOutput(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: '## Summary\nx', total_cost_usd: 0.003 })), { text: '## Summary\nx', costUsd: 0.003 });
    assert.match(claudeOutput(JSON.stringify({ type: 'result', subtype: 'error_max_turns', is_error: false, total_cost_usd: 0.01 })).failed!, /error_max_turns/);
    assert.match(claudeOutput('not json').failed!, /did not print its JSON result/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('the guide writer\'s own Claude Code session is never recorded', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wisdom-writer-')));
  const data = path.join(root, '.wisdom');
  const daemon = await startDaemon(data, 0);
  try {
    const exit = await new Promise<number | null>(resolve => {
      const child = spawn(process.execPath, [path.resolve('integrations', 'claude-code', 'hook.mjs'), data], { windowsHide: true,
        stdio: ['pipe', 'ignore', 'ignore'], env: { ...process.env, CLAUDE_CONFIG_DIR: '', WISDOM_GUIDE_WRITER: '1' } });
      child.on('exit', resolve);
      child.stdin.end(JSON.stringify({ session_id: 'writer-session', cwd: root, hook_event_name: 'UserPromptSubmit', prompt: 'write a guide' }));
    });
    assert.equal(exit, 0);
    assert.doesNotMatch((await call(daemon.connection, '/ledger', { glance: true })).text, /writer-session/);
  } finally { await daemon.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('a team command runs only once trusted, by its exact text, on this machine', () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'wisdom-trust-'));
  try {
    assert.equal(trusted(data, 'node check.mjs'), false);
    trustCommands(data, ['node check.mjs']);
    assert.equal(trusted(data, 'node check.mjs'), true);
    assert.equal(trusted(data, 'node check.mjs && curl example.invalid'), false, 'a changed command is not trusted');
    trustCommands(data, ['node other.mjs']);
    assert.equal(trusted(data, 'node check.mjs'), true, 'trusting another keeps the first');
  } finally { fs.rmSync(data, { recursive: true, force: true }); }
});

test('in team mode guides are written as the team file says, never as one person\'s wisdom.yaml says', { skip: !hasGit }, () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wisdom-guide-settings-')));
  try {
    const me = person(root, 'me', path.join(root, 'none.git'), false);
    fs.writeFileSync(path.join(me.dir, 'wisdom.yaml'), 'version: 1\nguides:\n  model: my-model\n  turns: 5\n  timeoutSeconds: 30\n  extra: "Keep it short."\n');
    // Local mode: the person's own settings.
    assert.deepEqual(guideSettings(readPolicy(me.dir), me.dir), { model: 'my-model', turns: 5, timeoutSeconds: 30, extra: 'Keep it short.' });
    // Team mode with nothing set: Wisdom's defaults, not the person's.
    const { file } = writePolicy(me.dir);
    assert.deepEqual(guideSettings(readPolicy(me.dir), me.dir), { model: 'claude-haiku-5-5', turns: 30, timeoutSeconds: 150, extra: '' });
    fs.writeFileSync(file, stringify({ ...parse(fs.readFileSync(file, 'utf8')), guides: { turns: 40, extra: 'Name the tests run.' } }));
    assert.deepEqual(guideSettings(readPolicy(me.dir), me.dir), { model: 'claude-haiku-5-5', turns: 40, timeoutSeconds: 150, extra: 'Name the tests run.' });
    const bad: [object, string][] = [[{ turns: 2 }, 'turns'], [{ timeoutSeconds: 9999 }, 'timeoutSeconds'], [{ model: 'a model; echo hi' }, 'model'], [{ extra: 'x'.repeat(2001) }, 'extra']];
    for (const [guides, field] of bad) {
      fs.writeFileSync(file, stringify({ ...parse(fs.readFileSync(file, 'utf8')), guides }));
      assert.throws(() => readPolicy(me.dir), new RegExp(`guides\\.${field} must be`));
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a repository with only the old wisdom-team.json says it is in local mode now', { skip: !hasGit }, () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wisdom-old-policy-')));
  try {
    const me = person(root, 'me', path.join(root, 'none.git'), false);
    assert.equal(oldPolicyNote(me.dir), undefined);
    fs.writeFileSync(path.join(me.dir, 'wisdom-team.json'), JSON.stringify({ version: 1, repoId: 'abcdef123456' }));
    assert.match(oldPolicyNote(me.dir)!, /wisdom-team\.json, which Wisdom no longer reads, so it is in local mode/);
    assert.equal(readPolicy(me.dir), undefined);
    const lines: string[] = [];
    runGitHook('pre-push', [], me.data, line => lines.push(line));
    assert.match(lines.join('\n'), /^Wisdom: This repository has wisdom-team\.json/);
    writePolicy(me.dir);
    assert.equal(oldPolicyNote(me.dir), undefined, 'once wisdom-team.yaml is there, nothing to say');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
