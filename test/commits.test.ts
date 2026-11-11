import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { startDaemon } from '../src/service/daemon.js';
import { call } from '../src/service/client.js';
import { chainOf } from '../src/team/commits.js';
import { readFile, readHead, recordRef } from '../src/team/gitrefs.js';
import { observeSession, openSession } from './session.js';
import type { LedgerRecord } from '../src/core/schema.js';

const hasGit = spawnSync('git', ['--version'], { windowsHide: true }).status === 0;
const obs = (type: string, extra: Record<string, unknown> = {}) => ({ observationId: randomUUID(), type, ...extra });

/** A git project whose `.wisdom/` is the data folder, as `wisdom init` makes it. */
function repo(autocrlf = 'false') {
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wisdom-commits-')));
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args],
    { cwd: project, encoding: 'utf8', windowsHide: true });
  git('init', '-q');
  git('config', 'core.autocrlf', autocrlf);
  git('config', 'user.email', 'test@example.com');
  fs.appendFileSync(path.join(project, '.git', 'info', 'exclude'), '.wisdom/\n');
  const write = (file: string, text: string) => fs.writeFileSync(path.join(project, file), text);
  return { project, data: path.join(project, '.wisdom'), git, write };
}

test('a commit lists each piece with the recorded step that made it, or says it was not recorded', { skip: !hasGit }, async () => {
  const { project, data, git, write } = repo();
  write('a.ts', 'one\ntwo\nthree\n'); write('b.ts', 'b1\n'); write('d.ts', 'd1\n');
  git('add', '-A'); git('commit', '-q', '-m', 'start');
  write('d.ts', 'd1\nd2\n'); // Before any recording.
  const daemon = await startDaemon(data, 0);
  try {
    const { captureId: id } = await openSession(daemon.connection, { harness: 'pi', sessionId: 'commit-session', workspaceRoot: project, source: null });
    const send = (o: unknown) => observeSession(daemon.connection, id, o);
    await send(obs('input', { data: { text: 'Fix a and add c.' } }));
    await send(obs('tool_started', { toolCallId: 'e1', toolName: 'edit', data: { input: { path: 'a.ts' } } }));
    write('a.ts', 'one\nTWO\nthree\nfour\n');
    await send(obs('tool_finished', { toolCallId: 'e1', toolName: 'edit', isError: false, data: { content: 'ok' } }));
    await send(obs('tool_started', { toolCallId: 'w1', toolName: 'write', data: { input: { path: 'c.ts' } } }));
    write('c.ts', 'new\n');
    await send(obs('tool_finished', { toolCallId: 'w1', toolName: 'write', isError: false, data: { content: 'ok' } }));
    write('b.ts', 'b1\nb2\n'); // A person's edit while no tool runs.
    // The file watcher reports it a moment later; a busy machine can take longer.
    for (let waited = 0; waited < 10_000; waited += 100) {
      await send(obs('agent_settled', { data: {} }));
      if (daemon.captures.database.records("type='file_change' AND path=?", ['b.ts']).length) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    git('add', '-A'); git('commit', '-q', '-m', 'fix a, add c');
    const [sha, parent, committed] = git('log', '-1', '--format=%H%n%P%n%cI').trim().split('\n');
    // Before the watcher keeps a record, the answer is worked out on request.
    const now = (await call(daemon.connection, '/ledger', { glance: true, commit: 'HEAD' })).text;
    if (!readFile(project, recordRef(sha), 'record.json')) assert.match(now, /^worked out now from the recordings; no record was kept when the commit was made$/m);
    daemon.watcher.poll(true);
    const kept = JSON.parse(readFile(project, recordRef(sha), 'record.json')!.toString('utf8'));
    const text = (await call(daemon.connection, '/ledger', { glance: true, commit: 'HEAD' })).text;
    const version = Number(/ · version (\d+)$/m.exec(text)![1]);
    assert.equal(text, [
      `commit ${sha.slice(0, 12)} · fix a, add c · committed ${new Date(committed).toISOString().slice(0, 16).replace('T', ' ')}Z · version ${version}`,
      `parent ${parent.slice(0, 12)} · 4 files · 5 pieces: 4 from recorded steps, 1 not recorded`,
      `record kept when the commit was made, ${kept.madeAt.slice(0, 16).replace('T', ' ')}Z`,
      `the commit's own diff: git show ${sha.slice(0, 12)}`,
      '',
      'a.ts · modify · +2 −1',
      '    @@ -2,1 +2,1 @@  t1/c1 in session commit-s',
      '    @@ -3,0 +4,1 @@  t1/c1 in session commit-s',
      'b.ts · modify · +1 −0',
      // Seen between calls, so it is not placed in a turn: the session's glance lists it under outside.
      '    @@ -1,0 +2,1 @@  outside (changed outside any recorded step) in session commit-s',
      'c.ts · create · +1 −0',
      '    @@ -0,0 +1,1 @@  t1/c2 in session commit-s',
      'd.ts · modify · +1 −0 · not recorded',
      '',
      'sessions',
      '    commit-session  pi  t1/c1, t1/c2, outside',
      '',
      'To read a step, open its position in its session, such as {"capture":"commit-s","open":"t1/c1"}.',
      '',
      'complete · 18 lines',
    ].join('\n'));
    // Pinned to the version, the same request gives the same text, by hash as by HEAD.
    assert.equal((await call(daemon.connection, '/ledger', { glance: true, commit: sha, at: version })).text, text);
  } finally { await daemon.close(); fs.rmSync(project, { recursive: true, force: true }); }
});

test('an agent writing LF where git checks out CRLF still matches the commit', { skip: !hasGit }, async () => {
  const { project, data, git, write } = repo('true');
  write('a.ts', 'x\r\n'); git('add', '-A'); git('commit', '-q', '-m', 'start');
  const daemon = await startDaemon(data, 0);
  try {
    const { captureId: id } = await openSession(daemon.connection, { harness: 'pi', sessionId: 'crlf-session', workspaceRoot: project, source: null });
    const send = (o: unknown) => observeSession(daemon.connection, id, o);
    await send(obs('input', { data: { text: 'Add new.ts' } }));
    await send(obs('tool_started', { toolCallId: 'w1', toolName: 'write', data: { input: { path: 'new.ts' } } }));
    write('new.ts', 'a\nb\n');
    await send(obs('tool_finished', { toolCallId: 'w1', toolName: 'write', isError: false, data: { content: 'ok' } }));
    git('add', '-A'); git('commit', '-q', '-m', 'add new');
    const text = (await call(daemon.connection, '/ledger', { glance: true, commit: 'HEAD' })).text;
    assert.match(text, /^ {4}@@ -0,0 \+1,2 @@  t1\/c1 in session crlf-ses$/m);
  } finally { await daemon.close(); fs.rmSync(project, { recursive: true, force: true }); }
});

test('glance --commit refuses what is not a commit, and goes without a session', { skip: !hasGit }, async () => {
  const { project, data, git, write } = repo();
  write('a.ts', 'x\n'); git('add', '-A'); git('commit', '-q', '-m', 'start');
  const daemon = await startDaemon(data, 0);
  try {
    await assert.rejects(call(daemon.connection, '/ledger', { glance: true, commit: '--output=x' }), /is not a commit/);
    await assert.rejects(call(daemon.connection, '/ledger', { glance: true, commit: 'nope' }), /git cannot read commit "nope"/);
    await assert.rejects(call(daemon.connection, '/ledger', { glance: true, commit: 'HEAD', capture: 'latest' }), /commit goes with glance and no capture/);
    const text = (await call(daemon.connection, '/ledger', { glance: true, commit: 'HEAD' })).text;
    assert.match(text, /^first commit · 1 file · 1 piece: 0 from recorded steps, 1 not recorded$/m);
  } finally { await daemon.close(); fs.rmSync(project, { recursive: true, force: true }); }
});

test('a session\'s glance says what reading Wisdom cost it', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wisdom-reads-')));
  const daemon = await startDaemon(path.join(root, '.wisdom'), 0);
  try {
    const { captureId: id } = await openSession(daemon.connection, { harness: 'claude-code', sessionId: 'reads-session', workspaceRoot: root, source: null });
    const send = (o: unknown) => observeSession(daemon.connection, id, o);
    await send(obs('input', { data: { text: 'Review the last session.' } }));
    await send(obs('tool_started', { toolCallId: 'b1', toolName: 'Bash', data: { input: { command: 'wisdom glance latest' } } }));
    await send(obs('tool_finished', { toolCallId: 'b1', toolName: 'Bash', isError: false, data: { response: 'x'.repeat(4000) } }));
    await send(obs('tool_started', { toolCallId: 'b2', toolName: 'Bash', data: { input: { command: 'npm test' } } }));
    await send(obs('tool_finished', { toolCallId: 'b2', toolName: 'Bash', isError: false, data: { response: 'ok' } }));
    await send(obs('tool_started', { toolCallId: 'm1', toolName: 'mcp__wisdom__ledger', data: { input: { glance: true } } }));
    await send(obs('tool_finished', { toolCallId: 'm1', toolName: 'mcp__wisdom__ledger', isError: false, data: { response: 'y'.repeat(1000) } }));
    const text = (await call(daemon.connection, '/ledger', { capture: id, glance: true })).text;
    assert.match(text, /^read Wisdom · 2 calls · 5,0\d\d characters returned, about 1,2\d\d tokens$/m);
  } finally { await daemon.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('HEAD read from git\'s files agrees with git, loose, packed, detached, and before any commit', { skip: !hasGit }, () => {
  const { project, git, write } = repo();
  try {
    assert.equal(readHead(project), undefined, 'no commit yet');
    write('a.ts', 'x\n'); git('add', '-A'); git('commit', '-q', '-m', 'one');
    assert.equal(readHead(project), git('rev-parse', 'HEAD').trim());
    git('pack-refs', '--all');
    assert.equal(readHead(project), git('rev-parse', 'HEAD').trim());
    git('checkout', '-q', '--detach');
    assert.equal(readHead(project), git('rev-parse', 'HEAD').trim());
    assert.equal(readHead(path.join(os.tmpdir(), 'no-such-folder-wisdom')), undefined);
  } finally { fs.rmSync(project, { recursive: true, force: true }); }
});

const change = (n: number, before: string | null, after: string | null, attribution: LedgerRecord['attribution'], second = n): LedgerRecord =>
  ({ schemaVersion: 1, id: `r${n}`, captureId: 'c', seq: n, observedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, second)).toISOString(),
    type: 'file_change', summary: '', beforeHash: before, afterHash: after, attribution });

test('the chain follows contents back to the parent, keeps the copy seen during a tool, and says when it breaks', () => {
  // Two sessions saw the same edit: one during its tool call, one as an outside change.
  const both = [change(1, 'p', 'x', 'external-or-unknown', 10), change(2, 'p', 'x', 'observed-during-tool', 10), change(3, 'x', 'c', 'observed-during-tool', 20)];
  assert.deepEqual(chainOf(both, ['p'], 'c').chain.map(r => r.id), ['r2', 'r3']);
  assert.equal(chainOf(both, ['p'], 'c').complete, true);
  // The recording started after the file had moved on from the parent.
  assert.deepEqual(chainOf([change(1, 'q', 'c', 'observed-during-tool')], ['p'], 'c'), { chain: [change(1, 'q', 'c', 'observed-during-tool')], complete: false });
  // Back and forth: only the steps since the file last equalled the parent count.
  const revert = [change(1, 'p', 'x', 'observed-during-tool'), change(2, 'x', 'p', 'observed-during-tool'), change(3, 'p', 'c', 'observed-during-tool')];
  assert.deepEqual(chainOf(revert, ['p'], 'c').chain.map(r => r.id), ['r3']);
  assert.deepEqual(chainOf([], [null], 'c'), { chain: [], complete: false });
});
