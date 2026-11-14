import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { call } from '../src/service/client.js';
import { startDaemon, type Connection } from '../src/service/daemon.js';
import { cloneTranscript, differingFiles, planClone } from '../src/sessions/clone.js';
import { adapter } from '../src/harnesses/index.js';
import { moveFolder } from '../src/harnesses/types.js';
import { draftShare, writeShare } from '../src/share/share.js';
import { cloneNote, harnessHome, marker } from '../src/core/paths.js';

function project(name: string) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `wisdom-clone-${name}-`)));
  const data = path.join(root, '.wisdom');
  fs.mkdirSync(data);
  fs.writeFileSync(path.join(data, marker), JSON.stringify({ project: root }));
  return { root, data };
}

const user = (sessionId: string, cwd: string, uuid: string, text: string, timestamp: string) =>
  JSON.stringify({ type: 'user', sessionId, cwd, uuid, timestamp, message: { role: 'user', content: text } });
const reply = (sessionId: string, cwd: string, uuid: string, timestamp: string) =>
  JSON.stringify({ type: 'assistant', sessionId, cwd, uuid, timestamp, message: { id: uuid, role: 'assistant', content: [{ type: 'text', text: 'done' }], usage: { input_tokens: 10, output_tokens: 5 } } });

/** A project whose Claude Code home holds one finished two-turn session, found and recorded from its file. */
async function recorded(name: string, sessionId = 'source-session') {
  const { root, data } = project(name);
  const file = adapter('claude-code').sessionFile(harnessHome(data, 'claude-code'), sessionId, root, new Date());
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, [user(sessionId, root, 'u1', 'first ask', '2026-01-01T10:00:00.000Z'), reply(sessionId, root, 'm1', '2026-01-01T10:00:05.000Z'),
    user(sessionId, root, 'u2', 'second ask', '2026-01-01T10:01:00.000Z'), reply(sessionId, root, 'm2', '2026-01-01T10:01:05.000Z')].join('\n') + '\n');
  const quiet = new Date(Date.now() - 10 * 60_000);
  fs.utimesSync(file, quiet, quiet);
  const daemon = await startDaemon(data, 0);
  daemon.captures.scan();
  return { root, data, daemon };
}

const glance = async (c: Connection, capture: string): Promise<string> => (await call(c, '/ledger', { capture, glance: true })).text;
const lines = (file: string) => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));

test('each harness names the new session and folder in the lines that carry them, and nothing else', () => {
  const move = moveFolder('C:\\Users\\a\\shop', 'D:\\work\\shop');
  const clone = { from: 'old', sessionId: 'new', move };
  assert.deepEqual(adapter('claude-code').cloneLine({ type: 'user', sessionId: 'old', cwd: 'C:\\Users\\a\\shop\\api', uuid: 'u1' }, clone),
    { type: 'user', sessionId: 'new', cwd: 'D:\\work\\shop\\api', uuid: 'u1' });
  const meta = adapter('codex').cloneLine({ type: 'session_meta', payload: { id: 'old', session_id: 'old', cwd: 'C:\\Users\\a\\shop', runtime_workspace_roots: ['C:\\Users\\a\\shop'], source: 'cli' } }, clone);
  assert.deepEqual(meta.payload, { id: 'new', session_id: 'new', cwd: 'D:\\work\\shop', runtime_workspace_roots: ['D:\\work\\shop'], source: 'cli' });
  const subagent = { type: 'session_meta', payload: { id: 'someone-else', cwd: 'C:\\Users\\a\\shop' } };
  assert.deepEqual(adapter('codex').cloneLine(subagent, clone), subagent, 'another session\'s header is left alone');
  assert.equal(adapter('codex').cloneLine({ type: 'turn_context', payload: { cwd: 'C:\\Users\\a\\shop' } }, clone).payload.cwd, 'D:\\work\\shop');
  assert.deepEqual(adapter('pi').cloneLine({ type: 'session', version: 3, id: 'old', cwd: 'C:\\Users\\a\\shop' }, clone), { type: 'session', version: 3, id: 'new', cwd: 'D:\\work\\shop' });
  assert.deepEqual(adapter('pi').cloneLine({ type: 'message', id: 'e1' }, clone), { type: 'message', id: 'e1' });
  assert.equal(move('C:\\Users\\a\\shopping'), 'C:\\Users\\a\\shopping', 'a folder that only starts the same is not inside');
});

test('each harness puts a session file where it looks for one', () => {
  const now = new Date(2026, 10, 7, 9, 5, 3);
  const at = (harness: string) => path.relative('H', adapter(harness).sessionFile('H', 'abc', 'C:\\Users\\a\\shop_x', now)).replaceAll('\\', '/');
  assert.equal(at('claude-code'), 'projects/C--Users-a-shop-x/abc.jsonl');
  assert.equal(at('codex'), 'sessions/2026/11/07/rollout-2026-11-07T09-05-03-abc.jsonl');
  assert.match(at('pi'), /^sessions\/--C--Users-a-shop_x--\/\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z_abc\.jsonl$/);
});

test('a clone is a new session: its copy names it, and recording counts only what happens after', async () => {
  const { root, data, daemon } = await recorded('own');
  try {
    const c = daemon.connection;
    const plan = await planClone(c, data, 'source-session', root);
    assert.notEqual(plan.sessionId, 'source-session');
    assert.deepEqual([plan.command, ...plan.args], ['claude', '--resume', plan.sessionId]);
    assert(lines(plan.file).every(line => line.sessionId === plan.sessionId));
    const note = JSON.parse(fs.readFileSync(cloneNote(data, plan.sessionId), 'utf8'));
    assert.deepEqual([note.from, note.turns], ['source-session', 2]);

    // Claude Code resumes it: the hooks name the new session and its file, then a new prompt arrives.
    const send = (type: string, extra: Record<string, unknown> = {}) => call(c, '/observe', { harness: 'claude-code', cwd: root,
      observation: { observationId: randomUUID(), sessionId: plan.sessionId, source: plan.file, type, ...extra } });
    await send('session_started', { data: { origin: 'resume' } });
    await send('input', { data: { text: 'third ask' } });
    const text = await glance(c, plan.sessionId);
    assert.match(text, /^cloned from source-session \(claude-code\) at version \d+ · 2 turns$/m);
    assert.match(text, /^1 turn · /m, 'the cloned turns are not this session\'s');
    assert.match(text, /history-cloned:The first 2 turns happened in source-session/);
    assert.match(text, /^t1 {2}in {8}third ask$/m);
    assert.match(await glance(c, 'source-session'), /^2 turns · /m, 'the original is unchanged');

    const { sessions } = await call(c, '/view', { view: 'project', workspaceRoot: root });
    const links = (id: string) => sessions.find((s: any) => s.captureId === id).links;
    assert.deepEqual(links(plan.sessionId), [{ kind: 'cloned', session: 'source-session', harness: 'claude-code', turns: 2 }]);
    assert.deepEqual(links('source-session'), [{ kind: 'cloned-by', session: plan.sessionId, harness: 'claude-code' }]);
  } finally {
    await daemon.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a clone found only in its file still counts only its new prompts', async () => {
  const { root, data, daemon } = await recorded('found');
  try {
    const plan = await planClone(daemon.connection, data, 'source-session', root);
    fs.appendFileSync(plan.file, user(plan.sessionId, root, 'u9', 'asked after cloning', '2026-02-01T10:00:00.000Z') + '\n');
    const quiet = new Date(Date.now() - 10 * 60_000);
    fs.utimesSync(plan.file, quiet, quiet);
    daemon.captures.scan();
    const text = await glance(daemon.connection, plan.sessionId);
    assert.match(text, /^cloned from source-session/m);
    assert.match(text, /^1 turn · /m);
    assert.match(text, /^t1 {2}in \(from session file\) {2}asked after cloning$/m);
  } finally {
    await daemon.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a teammate\'s shared session clones into this project\'s folder', async () => {
  const sender = await recorded('sender', 'their-session');
  const receiver = project('receiver');
  const daemon = await startDaemon(receiver.data, 0);
  try {
    const draft = await draftShare(sender.daemon.connection, ['their-session']);
    const file = path.join(sender.root, 'out.wisdom-share');
    writeShare(draft, [], file);
    await call(daemon.connection, '/import', { file });
    const plan = await planClone(daemon.connection, receiver.data, 'their-session', receiver.root);
    assert.equal(plan.source.sharedFrom, path.basename(sender.root));
    assert(plan.file.startsWith(harnessHome(receiver.data, 'claude-code')));
    assert(lines(plan.file).every(line => line.cwd === receiver.root), 'every line names the receiver\'s folder');
    assert(!fs.readFileSync(plan.file, 'utf8').includes(sender.root.replaceAll('\\', '\\\\')), 'no line names the sender\'s folder');
  } finally {
    await daemon.close(); await sender.daemon.close();
    fs.rmSync(receiver.root, { recursive: true, force: true }); fs.rmSync(sender.root, { recursive: true, force: true });
  }
});

test('a clone whose agent cannot start is kept, with the command that starts it later', async () => {
  const { root, data, daemon } = await recorded('nostart');
  try {
    // The daemon runs in this process, so the CLI must not block its event loop.
    const { execFile } = await import('node:child_process');
    const bin = new URL('../src/bin.js', import.meta.url);
    const stderr = await new Promise<string>(resolve => execFile(process.execPath, [fileURLToPath(bin), 'clone', 'source-session', '--claude-bin', 'wisdom-test-no-claude'],
      { cwd: root }, (_e, _o, err) => resolve(err)));
    const id = /into new session (\S+)\./.exec(stderr)?.[1];
    assert(id, stderr);
    assert.match(stderr, /Cannot run Claude Code \(wisdom-test-no-claude\)/);
    assert.match(stderr, new RegExp(`The clone is saved as session ${id}\\. Start it later with:\\n {2}.*claude --resume ${id}`));
    assert(fs.existsSync(cloneNote(data, id!)));
  } finally {
    await daemon.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a session with no transcript copy cannot be cloned, and files that differ are named', async () => {
  const { root, data } = project('plain');
  const daemon = await startDaemon(data, 0);
  try {
    await call(daemon.connection, '/observe', { harness: 'pi', cwd: root, observation: { observationId: randomUUID(), sessionId: 'no-file', type: 'input', data: { text: 'hi' } } });
    await assert.rejects(planClone(daemon.connection, data, 'no-file', root), /no-file has no copy of its harness transcript, so it cannot be cloned/);
    fs.writeFileSync(path.join(root, 'same.txt'), 'kept');
    fs.writeFileSync(path.join(root, 'changed.txt'), 'edited since');
    const kept = (await import('../src/storage/ledger.js')).hash('kept');
    assert.deepEqual(differingFiles(root, [{ path: 'same.txt', afterHash: kept }, { path: 'changed.txt', afterHash: kept },
      { path: 'gone.txt', afterHash: kept }, { path: 'deleted.txt', afterHash: null }]), ['changed.txt', 'gone.txt']);
    assert.equal(cloneTranscript('pi', 'not json\n', { from: 'a', sessionId: 'b', fromFolder: 'x', toFolder: 'y' }), 'not json\n');
  } finally {
    await daemon.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
