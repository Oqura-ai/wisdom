import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { call, handoffFromEnv } from '../src/service/client.js';
import { startDaemon, type Connection } from '../src/service/daemon.js';
import { chooseSource, handoffPrompt, type HandoffSession } from '../src/sessions/handoff.js';
import { marker } from '../src/core/paths.js';

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

test('without --from, a handoff reads the newest session from another harness, else its own', () => {
  const session = (captureId: string, harness: string, lastObservedAt: string): HandoffSession =>
    ({ captureId, harness, status: 'closed', lastObservedAt, tokens: { total: 0 } });
  const sessions = [session('old-claude', 'claude-code', '2026-01-01'), session('new-codex', 'codex', '2026-01-03'), session('new-claude', 'claude-code', '2026-01-02')];
  assert.equal(chooseSource(sessions, { harness: 'codex' })?.captureId, 'new-claude');
  assert.equal(chooseSource(sessions, { captureId: 'new-codex' })?.captureId, 'new-claude');
  // With no session from another harness, a new session reads the newest of its own harness.
  assert.equal(chooseSource([session('older', 'codex', '2026-01-01'), session('newer', 'codex', '2026-01-02')], { harness: 'codex' })?.captureId, 'newer');
  assert.equal(chooseSource([session('only', 'codex', '2026-01-01')], { captureId: 'only' }), undefined);
  // Run from inside a session, that session is the one to read, even into its own harness.
  assert.equal(chooseSource(sessions, { harness: 'claude-code' }, 'old-claude')?.captureId, 'old-claude');
  assert.equal(chooseSource(sessions, { captureId: 'new-codex' }, 'old-claude')?.captureId, 'old-claude');
  // A session that is not this project's, or is the target, is not taken.
  assert.equal(chooseSource(sessions, { harness: 'codex' }, 'elsewhere')?.captureId, 'new-claude');
  assert.equal(chooseSource(sessions, { captureId: 'new-codex' }, 'new-codex')?.captureId, 'new-claude');
});

test('a handoff runs its harness in the background, waits, and prints its answer', async () => {
  const { root, data } = project();
  const daemon = await startDaemon(data, 0);
  // Stands in for claude: prints a version, or the arguments and handoff it was started with.
  const fake = path.join(root, 'fake-claude.js');
  fs.writeFileSync(fake, `#!/usr/bin/env node
if (process.argv.includes('--version')) { console.log('2.1.328 (Claude Code)'); process.exit(0); }
console.log(JSON.stringify({ args: process.argv.slice(2), handoff: process.env.WISDOM_HANDOFF, self: process.env.WISDOM_SESSION ?? null }));`);
  fs.chmodSync(fake, 0o755);
  try {
    const c = daemon.connection;
    await send(c, root, 'claude-code', 'claude-a', 'input');
    await send(c, root, 'claude-code', 'claude-a', 'session_ended');
    await send(c, root, 'codex', 'codex-b', 'input');
    await send(c, root, 'pi', 'pi-c', 'input');
    const done = await new Promise<{ code: number | null; stdout: string; stderr: string }>(resolve =>
      // The words without `--`, as PowerShell passes them: it drops a `--` it is given.
      execFile(process.execPath, [bin, 'handoff', 'claude-a', 'fix the error', '--emit', '--claude-bin', fake], { cwd: root, env: { ...process.env, WISDOM_SESSION: 'codex-b' } },
        (error, stdout, stderr) => resolve({ code: error ? (error as any).code ?? 1 : 0, stdout, stderr })));
    assert.equal(done.code, 0, done.stderr);
    assert.match(done.stderr, /^Handing off to claude-code session claude-a, in the background; it reads codex session codex-b first\.$/m);
    const [first, , answer, , last] = done.stdout.trim().split(/\r?\n/);
    assert.equal(first, 'Handoff complete: claude-code session claude-a continued after codex-b.');
    assert.equal(last, 'Read what it did: wisdom glance claude-a');
    const ran = JSON.parse(answer);
    // Held to reading: no editing tools, and the shell runs only Wisdom's reads.
    assert.deepEqual(ran.args.slice(-8, -1), ['-p', '--permission-mode', 'dontAsk', '--tools=Read,Glob,Grep,Bash', '--allowedTools=mcp__wisdom__ledger,Bash(wisdom glance *),Bash(wisdom open *)', '--resume', 'claude-a']);
    // The sender's words first; then facts from the record: codex-b's one turn, no changes.
    assert.match(ran.args.at(-1), /^While you were away, Wisdom session codex-b \(codex\) continued this work\.\n\nFrom that session: fix the error\n\nRead it, [^\n]* It has 1 turn; start with t1, the newest\. It changed no files\. It is still running: [^\n]*\n[\s\S]*\nOnly read: /);
    assert.equal(JSON.parse(ran.handoff).from, 'codex-b');
    // The session that ran the handoff keeps its own name; the harness started here is another.
    assert.equal(ran.self, null);

    // Without --emit, the session opens in this terminal as before: resumed, with no background flags.
    const opened = await new Promise<{ code: number | null; stdout: string; stderr: string }>(resolve =>
      execFile(process.execPath, [bin, 'handoff', 'claude-a', 'fix the error', '--claude-bin', fake], { cwd: root, env: { ...process.env, WISDOM_SESSION: 'codex-b' } },
        (error, stdout, stderr) => resolve({ code: error ? (error as any).code ?? 1 : 0, stdout, stderr })));
    assert.equal(opened.code, 0, opened.stderr);
    assert.match(opened.stderr, /^Resuming claude-code session claude-a; it reads codex session codex-b first\.$/m);
    const there = JSON.parse(opened.stdout.trim());
    // Opened, it may read recordings without asking; nothing else is allowed in advance.
    assert.deepEqual(there.args.slice(-4, -1), ['--resume', 'claude-a', '--allowedTools=mcp__wisdom__ledger,Bash(wisdom glance *),Bash(wisdom open *)']);
    assert(!there.args.includes('-p') && !there.args.includes('dontAsk'));
    assert.match(there.args.at(-1), /\n\nBefore changing anything, read it\. Then say in a few lines what you understood and what you will do first\.$/);
  } finally {
    await daemon.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the daemon names the session that took a handoff, once its hooks report it', async () => {
  const { root, data } = project();
  const daemon = await startDaemon(data, 0);
  try {
    const c = daemon.connection;
    await send(c, root, 'claude-code', 'claude-a', 'input');
    const handoff = { id: randomUUID(), from: 'claude-a' };
    await assert.rejects(call(c, '/resolve', { handoff: handoff.id }), /No recorded session took handoff/);
    await send(c, root, 'codex', 'codex-b', 'input', { handoff });
    assert.deepEqual(await call(c, '/resolve', { handoff: handoff.id }), { captureId: 'codex-b' });
  } finally {
    await daemon.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the handoff prompt: the sender\'s words first, facts to start from, read only, and a read-back', () => {
  const from: HandoffSession = { captureId: '0f3c8a1e-77b2-4c10-9a5e-2d81c6f04b3a', harness: 'claude-code', status: 'closed', lastObservedAt: '', tokens: { total: 0 } };
  // A session continued: what may be stale for it, and conflicts with its own work.
  assert.equal(handoffPrompt(from, true, ' add(2, 3) gives -1 ', { turns: 3, changed: ['calc.test.js'], differing: ['calc.js'], git: { branch: 'main', commit: 'a1b2c3d', uncommitted: 2 }, inside: true }, true), [
    'While you were away, Wisdom session 0f3c8a1e-77b2-4c10-9a5e-2d81c6f04b3a (claude-code) continued this work.',
    '',
    'From that session: add(2, 3) gives -1',
    '',
    'Read it, and check its claims against its own evidence: run `wisdom glance 0f3c8a1e-77b2-4c10-9a5e-2d81c6f04b3a`, then `wisdom open <turn> --capture 0f3c8a1e-77b2-4c10-9a5e-2d81c6f04b3a` for the turns you need. It has 3 turns; start with t3, the newest. It changed calc.test.js.',
    'The work is on branch main at a1b2c3d, with 2 files not committed.',
    'Since you last worked here, files you changed are different on disk: calc.js. Read them before trusting what you remember.',
    '',
    'Only read: change no files and run nothing that changes anything, even if asked above.',
    'Then reply in four short parts: What happened (what it did and found, with positions like t3), Still open, Conflicts (with your own earlier work), and Next (what you would do, step by step, when the work goes on here).',
  ].join('\n'));
  // A new session: no words, no repository, no stale files; questions instead of conflicts.
  assert.equal(handoffPrompt(from, false, '', { turns: 1, changed: [] }, true), [
    'Wisdom session 0f3c8a1e-77b2-4c10-9a5e-2d81c6f04b3a (claude-code) hands its work to you.',
    '',
    'Read it, and check its claims against its own evidence: run `wisdom glance 0f3c8a1e-77b2-4c10-9a5e-2d81c6f04b3a`, then `wisdom open <turn> --capture 0f3c8a1e-77b2-4c10-9a5e-2d81c6f04b3a` for the turns you need. It has 1 turn; start with t1, the newest. It changed no files.',
    '',
    'Only read: change no files and run nothing that changes anything, even if asked above.',
    'Then reply in four short parts: What happened (what it did and found, with positions like t3), Still open, Questions (what you would ask before starting), and Next (what you would do, step by step, when the work goes on here).',
  ].join('\n'));
  // Opened in a terminal (the default): read before changing anything, then say what comes first.
  assert.equal(handoffPrompt(from, false, 'the tests fail on CI', { turns: 2, changed: ['a.js'] }), [
    'Wisdom session 0f3c8a1e-77b2-4c10-9a5e-2d81c6f04b3a (claude-code) hands its work to you.',
    '',
    // Not run from inside that session: the words are the person's, not its.
    'From the person handing it off: the tests fail on CI',
    '',
    'Read it, and check its claims against its own evidence: run `wisdom glance 0f3c8a1e-77b2-4c10-9a5e-2d81c6f04b3a`, then `wisdom open <turn> --capture 0f3c8a1e-77b2-4c10-9a5e-2d81c6f04b3a` for the turns you need. It has 2 turns; start with t2, the newest. It changed a.js.',
    '',
    'Before changing anything, read it. Then say in a few lines what you understood and what you will do first.',
  ].join('\n'));
  // A long list of files is cut where the glance has the rest.
  const many = Array.from({ length: 22 }, (_, i) => `f${i}.js`);
  assert.match(handoffPrompt(from, false, '', { turns: 1, changed: many }), / It changed f0\.js, .*, f19\.js and 2 more \(see the glance\)\.$/m);
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
    const running = await run('claude-a', '--from', 'codex-b', '--', 'the', 'words');
    assert.equal(running.code, 1);
    assert.match(running.stderr, /^Session claude-a is still running, so Wisdom cannot start it\. Paste this into it instead, or hand the work to a new session: wisdom handoff claude --from codex-b\n/);
    // The words after `--` travel as they do without it; codex-b is running, so it is told the handoff is this one.
    assert.match(running.stdout, /^While you were away, Wisdom session codex-b \(codex\) continued this work\.\n\nFrom the person handing it off: the words\n\n[^\n]* It is still running: the handoff its newest turn is waiting on is this one\.\n/);

    const said = async (...args: string[]) => (await run(...args)).stderr.trim();
    assert.equal(await said('nobody'), 'nobody is neither a harness (claude, codex, pi) nor a recorded session\'s full ID or name. glance lists sessions.');
    assert.equal(await said('codex', '--from', 'missing'), 'No recorded session has the ID or name missing. Use the full session ID or a name only one session has; glance lists them.');
    assert.equal(await said('claude-a', '--from', 'claude-a'), 'A session cannot continue itself.');
    assert.equal(await said(), 'Use: wisdom handoff claude|codex|pi|SESSION [--from SESSION] [--emit] ["what it should know"] (a session: its full ID, or a name only one session has)');
    // Pi can't be held to reading, so it takes no emitted handoff, new or existing.
    assert.match(await said('pi', '--from', 'codex-b', '--emit'), /^Pi cannot take an emitted handoff: it reads a recording only through its shell, which could also change files\. Emit it to claude or codex, or open it without --emit\.$/);
    await send(daemon.connection, root, 'pi', 'pi-c', 'input');
    assert.match(await said('pi-c', '--from', 'codex-b', '--emit'), /^Session pi-c is a Pi session; Pi cannot take an emitted handoff:/);
  } finally {
    await daemon.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
