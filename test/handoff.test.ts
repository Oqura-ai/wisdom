import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { call, handoffFromEnv } from '../src/client.js';
import { startDaemon, type Connection } from '../src/daemon.js';
import { chooseSource, handoffPrompt, type HandoffSession } from '../src/handoff.js';
import { marker } from '../src/paths.js';

const bin = fileURLToPath(new URL('../src/bin.js', import.meta.url));

/** A project with a data folder, and a way to send hook events as a harness would. */
function project() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wisdom-handoff-')));
  const data = path.join(root, '.wisdom');
  fs.mkdirSync(data);
  fs.writeFileSync(path.join(data, marker), JSON.stringify({ project: root }));
  return { root, data };
}
const send = (c: Connection, cwd: string, harness: string, sessionId: string, type: string, extra: Record<string, unknown> = {}) =>
  call(c, '/observe', { harness, cwd, ...extra, observation: { observationId: randomUUID(), sessionId, type,
    ...(type === 'input' ? { data: { text: `prompt in ${sessionId}` } } : {}) } });
const glance = async (c: Connection, capture: string): Promise<string> => (await call(c, '/ledger', { capture, glance: true })).text;

test('a hook reads the handoff its harness was started with, and ignores one it cannot parse', () => {
  const handoff = { id: randomUUID(), from: 'session-a' };
  assert.deepEqual(handoffFromEnv({ WISDOM_HANDOFF: JSON.stringify(handoff) }), { handoff });
  assert.deepEqual(handoffFromEnv({}), {});
  assert.deepEqual(handoffFromEnv({ WISDOM_HANDOFF: 'not json' }), {});
  assert.deepEqual(handoffFromEnv({ WISDOM_HANDOFF: JSON.stringify({ from: 'session-a' }) }), {});
});

test('a session started by a handoff says which session it continues, once, and only that session', async () => {
  const { root, data } = project();
  const daemon = await startDaemon(data, 0);
  try {
    const c = daemon.connection;
    await send(c, root, 'claude-code', 'claude-a', 'input');
    await send(c, root, 'claude-code', 'claude-a', 'session_ended');
    const handoff = { id: randomUUID(), from: 'claude-a' };
    await send(c, root, 'codex', 'codex-b', 'session_started', { handoff });
    await send(c, root, 'codex', 'codex-b', 'input', { handoff });
    // A /clear or /new later in the same harness process carries the same handoff.
    await send(c, root, 'codex', 'codex-c', 'input', { handoff });

    const b = await glance(c, 'codex-b');
    assert.match(b, /^continues claude-a \(claude-code\)$/m);
    assert.equal(b.match(/continues claude-a/g)!.length, 1);
    assert.doesNotMatch(await glance(c, 'codex-c'), /continues/);
  } finally {
    await daemon.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an existing session resumed by a handoff is marked at the turn it continued from', async () => {
  const { root, data } = project();
  const daemon = await startDaemon(data, 0);
  try {
    const c = daemon.connection;
    await send(c, root, 'claude-code', 'claude-a', 'input');
    await send(c, root, 'claude-code', 'claude-a', 'session_ended');
    await send(c, root, 'codex', 'codex-b', 'input');
    await send(c, root, 'codex', 'codex-b', 'session_ended');
    const handoff = { id: randomUUID(), from: 'codex-b' };
    await send(c, root, 'claude-code', 'claude-a', 'session_started', { handoff });
    await send(c, root, 'claude-code', 'claude-a', 'input', { handoff });
    assert.match(await glance(c, 'claude-a'), /^continued after codex-b \(codex\) · at t2$/m);
  } finally {
    await daemon.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('after a daemon restart, a running handoff is not linked a second time', async () => {
  const { root, data } = project();
  const handoff = { id: randomUUID(), from: 'claude-a' };
  let daemon = await startDaemon(data, 0);
  try {
    await send(daemon.connection, root, 'claude-code', 'claude-a', 'input');
    await send(daemon.connection, root, 'codex', 'codex-b', 'input', { handoff });
    await daemon.close();
    daemon = await startDaemon(data, 0);
    await send(daemon.connection, root, 'codex', 'codex-b', 'input', { handoff });
    assert.equal((await glance(daemon.connection, 'codex-b')).match(/continues claude-a/g)!.length, 1);
  } finally {
    await daemon.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the dashboard sees a handoff from both ends', async () => {
  const { root, data } = project();
  const daemon = await startDaemon(data, 0);
  try {
    const c = daemon.connection;
    await send(c, root, 'claude-code', 'claude-a', 'input');
    await send(c, root, 'codex', 'codex-b', 'input', { handoff: { id: randomUUID(), from: 'claude-a' } });
    const { sessions } = await call(c, '/view', { view: 'project', workspaceRoot: root });
    const links = (id: string) => sessions.find((session: any) => session.captureId === id).links;
    assert.deepEqual(links('codex-b'), [{ kind: 'continues', session: 'claude-a', harness: 'claude-code' }]);
    assert.deepEqual(links('claude-a'), [{ kind: 'continued-by', session: 'codex-b', harness: 'codex' }]);
  } finally {
    await daemon.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('without --from, a handoff reads the newest session from another harness', () => {
  const session = (captureId: string, harness: string, lastObservedAt: string): HandoffSession =>
    ({ captureId, harness, status: 'closed', lastObservedAt, tokens: { total: 0 } });
  const sessions = [session('old-claude', 'claude-code', '2026-01-01'), session('new-codex', 'codex', '2026-01-03'), session('new-claude', 'claude-code', '2026-01-02')];
  assert.equal(chooseSource(sessions, { harness: 'codex' })?.captureId, 'new-claude');
  assert.equal(chooseSource(sessions, { captureId: 'new-codex' })?.captureId, 'new-claude');
  assert.equal(chooseSource([session('only', 'codex', '2026-01-01')], { harness: 'codex' }), undefined);
});

test('the handoff prompt names the full session ID and how to read it', () => {
  const from: HandoffSession = { captureId: '0f3c8a1e-77b2-4c10-9a5e-2d81c6f04b3a', harness: 'claude-code', status: 'closed', lastObservedAt: '', tokens: { total: 0 } };
  const fresh = handoffPrompt(from, false, ' also run the tests ');
  assert.match(fresh, /^Continue the work from Wisdom session 0f3c8a1e-77b2-4c10-9a5e-2d81c6f04b3a \(claude-code\)\. /);
  assert.match(fresh, /`wisdom glance 0f3c8a1e-77b2-4c10-9a5e-2d81c6f04b3a`/);
  assert.match(fresh, /\n\nalso run the tests$/);
  assert.match(handoffPrompt(from, true), /^While you were away, Wisdom session 0f3c8a1e-77b2-4c10-9a5e-2d81c6f04b3a \(claude-code\) continued this work\./);
});

test('a handoff into a running session starts nothing and prints the prompt to paste', async () => {
  const { root, data } = project();
  const daemon = await startDaemon(data, 0);
  try {
    await send(daemon.connection, root, 'claude-code', 'claude-a', 'input');
    await send(daemon.connection, root, 'codex', 'codex-b', 'input');
    // The daemon runs in this process, so the CLI must not block its event loop.
    const run = (...args: string[]) => new Promise<{ code: number | null; stdout: string; stderr: string }>(resolve =>
      execFile(process.execPath, [bin, 'handoff', ...args], { cwd: root }, (error, stdout, stderr) =>
        resolve({ code: error ? (error as any).code ?? 1 : 0, stdout, stderr })));
    const running = await run('claude-a', '--from', 'codex-b');
    assert.equal(running.code, 1);
    assert.match(running.stderr, /^Session claude-a is still running, so Wisdom cannot start it\. Paste this into it instead:/);
    assert.match(running.stdout, /^While you were away, Wisdom session codex-b \(codex\) continued this work\./);

    const said = async (...args: string[]) => (await run(...args)).stderr.trim();
    assert.equal(await said('nobody'), 'nobody is neither a harness (claude, codex, pi) nor a recorded session\'s full ID. glance lists sessions.');
    assert.equal(await said('codex', '--from', 'missing'), 'No recorded session has the ID missing. Use the full session ID; glance lists them.');
    assert.equal(await said('claude-a', '--from', 'claude-a'), 'A session cannot continue itself.');
    assert.equal(await said(), 'Use: wisdom handoff claude|codex|pi|SESSION-ID [--from SESSION-ID]');
  } finally {
    await daemon.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
