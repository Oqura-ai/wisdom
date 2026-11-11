import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { startDaemon } from '../src/service/daemon.js';
import { call } from '../src/service/client.js';
import { prCheck, prune } from '../src/team/team.js';
import { readFile, recordRef, writePolicy } from '../src/team/gitrefs.js';
import { hooksInstalled, installHooks, removeHooks, runGitHook } from '../src/team/githooks.js';
import { setGuides } from '../src/team/guides.js';
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
  const policy = JSON.parse(fs.readFileSync(policyFile, 'utf8'));
  fs.writeFileSync(policyFile, JSON.stringify({ ...policy, guides: { command: fakeWriter(root) } }, null, 2));
  alice.git('add', '-A'); alice.git('commit', '-q', '-m', 'start'); alice.git('push', '-q', 'origin', 'main');
  const base = alice.git('rev-parse', 'HEAD');

  const daemon = await startDaemon(alice.data, 0);
  let bobDaemon: Awaited<ReturnType<typeof startDaemon>> | undefined;
  try {
    installHooks(alice.dir, alice.data);
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
    assert.match(kept.guide.writer, /^claude-haiku-5-5 via /);
    assert.deepEqual(kept.guide.problems, []);
    assert.match(kept.guide.text, /^- a\.ts @@ -2,1 \+2,1 @@ · t1\/c1 in session alice-se\n {2}Made by this step \[t1\/c1 alice-se\]\.$/m);

    const own = (await call(daemon.connection, '/ledger', { glance: true, commit: 'HEAD' })).text;
    assert.match(own, /^record kept when the commit was made, /m);
    assert.match(own, /^guide · written by claude-haiku-5-5 via .* · derived, not evidence · Wisdom checked that it covers every item and that its citations exist, not that it is right$/m);

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
    assert.match(check.text, /^ {4}agent work · guide by claude-haiku-5-5 via .* · 1 sessions$/m);
    bob.git('checkout', '-q', '-b', 'squashed', base);
    fs.writeFileSync(path.join(bob.dir, 'a.ts'), 'one\nTWO\n');
    bob.git('commit', '-q', '-am', `two (#1)\n\n* two\n\nWisdom-Record: ${line}`);
    const squashed = (await call(bobDaemon.connection, '/ledger', { glance: true, commit: 'HEAD' })).text;
    assert.match(squashed, /its message carries 1 recorded commit through their Wisdom-Record lines/);
    assert.match(squashed, /^ {4}@@ -2,1 \+2,1 @@ {2}t1\/c1 in session alice-se$/m);
    assert.match(prCheck(bob.dir, `${base}..HEAD`).text, /carries 1 recorded commit/);

    // A person who turns guides off gets none, and CI says why.
    setGuides(alice.data, false);
    await send(obs('tool_started', { toolCallId: 'e2', toolName: 'edit', data: { input: { path: 'a.ts' } } }));
    fs.writeFileSync(path.join(alice.dir, 'a.ts'), 'ONE\nTWO\n');
    await send(obs('tool_finished', { toolCallId: 'e2', toolName: 'edit', isError: false, data: { content: 'ok' } }));
    alice.git('commit', '-q', '-am', 'one');
    const off = alice.git('rev-parse', 'HEAD');
    const offRecord = await until('the record', () => record(alice.dir, off)?.guideMissing ? record(alice.dir, off) : undefined);
    assert.match(offRecord.guideMissing, /turned off by the person who committed/);
    assert.equal(spawnSync('git', ['push', 'origin', 'main'], { cwd: alice.dir, windowsHide: true }).status, 0);
    const offCheck = prCheck(alice.dir, `${sha}..${off}`);
    assert.equal(offCheck.ok, false);
    assert.match(offCheck.text, /agent work without a guide \(turned off by the person who committed/);

    // Retention keeps a session a pushed record still names.
    fs.writeFileSync(policyFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(policyFile, 'utf8')), retentionDays: 30 }));
    assert.deepEqual(prune(daemon.captures, undefined, Date.now() + 90 * 86_400_000), []);

    // Deleted for the team: Bob's copy goes, his read says so, and CI notices.
    const deleted = await call(daemon.connection, '/team', { action: 'delete', session: id });
    assert.match(deleted.key, /^[a-f0-9-]{36}\/alice-session-1$/);
    assert.deepEqual((await call(bobDaemon.connection, '/team', { action: 'fetch' })).removed, [deleted.key]);
    assert.match((await call(bobDaemon.connection, '/ledger', { glance: true, commit: sha })).text, /t1\/c1 \(session not available\) in session alice-se/);
    assert.match(prCheck(bob.dir, `${base}..${sha}`).text, /session alice-se is not on origin/);

    assert.deepEqual(removeHooks(alice.dir), ['prepare-commit-msg', 'post-commit', 'pre-push']);
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

test('without wisdom-team.json nothing is added to a commit message and nothing is pushed', { skip: !hasGit }, async () => {
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
    await assert.rejects(call(daemon.connection, '/team', { action: 'push' }), /no wisdom-team\.json, so Wisdom is in local mode/);
  } finally { await daemon.close(); fs.rmSync(root, { recursive: true, force: true }); }
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
