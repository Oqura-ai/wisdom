import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchPi } from '../src/harnesses/pi/launch.js';
import { launchClaudeCode } from '../src/harnesses/claude-code/launch.js';

test('tracked harnesses keep their sessions in Wisdom\'s folder, not the global one', () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'wisdom-launch-'));
  try {
    const piHome = path.join(data, 'harnesses', 'pi', 'home');
    const piLaunch = launchPi({ entry: 'pi.js', args: ['--session', 'abc123'], dataDir: data });
    assert.deepEqual(piLaunch.args.slice(1, 3), ['--session-dir', piHome]);
    assert(fs.statSync(piHome).isDirectory());
    assert.throws(() => launchPi({ entry: 'pi.js', args: ['--session-dir', 'x'], dataDir: data }), /remove --session-dir/);
    const outside = path.join(os.homedir(), '.pi', 'agent', 'sessions', 'old.jsonl');
    assert.throws(() => launchPi({ entry: 'pi.js', args: ['--session', outside], dataDir: data }), /by its ID/);
    launchPi({ entry: 'pi.js', args: [`--session=${path.join(piHome, 'mine.jsonl')}`], dataDir: data });

    // Any command that prints a version stands in for the claude binary.
    const claude = launchClaudeCode({ command: process.execPath, args: [], dataDir: data, cliPath: 'cli.js' });
    assert.equal(claude.env?.CLAUDE_CONFIG_DIR, path.join(data, 'harnesses', 'claude-code', 'home'));
  } finally { fs.rmSync(data, { recursive: true, force: true }); }
});

test('one native session is one capture: a resume continues it, a new session is another, a launch with no session leaves nothing', async () => {
  const { startDaemon } = await import('../src/daemon.js');
  const { call } = await import('../src/client.js');
  const { randomUUID } = await import('node:crypto');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wisdom-resume-'));
  const workspace = path.join(root, 'project'); fs.mkdirSync(workspace);
  const daemon = await startDaemon(path.join(root, 'data'), 0);
  try {
    const c = daemon.connection;
    const launch = async () => (await call(c, '/launches', { harness: 'codex', workspaceRoot: workspace })).launchId as string;
    const say = (launchId: string, sessionId: string, text: string) => call(c, `/launches/${launchId}/observe`,
      { observationId: randomUUID(), sessionId, type: 'input', turnId: text, data: { text } });

    const first = await launch();
    assert.equal((await say(first, 'one', 'hello')).captureId, 'one');
    await call(c, `/launches/${first}/close`, { reason: 'exit-0' });
    const failed = await launch();
    assert.deepEqual(await call(c, `/launches/${failed}/close`, { reason: 'exit-1' }), { status: 'nothing recorded' });

    // Resume: same session, same capture, its turns continue.
    const second = await launch();
    assert.equal((await say(second, 'one', 'again')).captureId, 'one');
    // Codex ends every session it opened when it quits; another session's end changes nothing.
    assert.equal((await call(c, `/launches/${second}/observe`, { observationId: randomUUID(), sessionId: 'old', type: 'session_ended' })).recorded, false);
    // /clear or /new: a new session is a new capture; the previous one is closed, not mixed in.
    assert.equal((await say(second, 'two', 'fresh')).captureId, 'two');
    assert.equal(daemon.captures.get('one').manifest.endReason, 'session-switched');
    await call(c, `/launches/${second}/close`, { reason: 'exit-0' });

    assert.deepEqual(daemon.captures.database.manifests().map(m => m.captureId).sort(), ['one', 'two']);
    const glance = (await call(c, '/ledger', { capture: 'one', glance: true })).text;
    assert.match(glance, /^t1  in {8}hello$/m);
    assert.match(glance, /^t2  in {8}again$/m);
    assert.match(glance, /not-recording-between-visits/);
  } finally { await daemon.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('resume finds a session only by its full ID', async () => {
  const { startDaemon } = await import('../src/daemon.js');
  const { call } = await import('../src/client.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wisdom-resolve-'));
  const workspace = path.join(root, 'project'); fs.mkdirSync(workspace);
  const daemon = await startDaemon(path.join(root, 'data'), 0);
  try {
    const c = daemon.connection;
    // UUIDv7 session IDs started within a minute share their first 8 characters.
    for (const sessionId of ['01a1836b-aaaa', '01a1836b-bbbb']) {
      await call(c, '/captures', { harness: 'codex', sessionId, workspaceRoot: workspace, source: null });
    }
    const resolved = await call(c, '/resolve', { session: '01a1836b-bbbb' });
    assert.deepEqual(resolved, { captureId: '01a1836b-bbbb', harness: 'codex', workspaceRoot: fs.realpathSync(workspace) });
    for (const partial of ['01a1836b', '01a1836b-b', 'latest']) {
      await assert.rejects(call(c, '/resolve', { session: partial }), /No recorded session has the ID/);
    }
    const glance = (await call(c, '/ledger', { capture: '01a1836b-aaaa', glance: true })).text;
    assert.match(glance, /^resume with: wisdom resume 01a1836b-aaaa$/m);
  } finally { await daemon.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
