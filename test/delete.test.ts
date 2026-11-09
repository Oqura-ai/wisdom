import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { call } from '../src/client.js';
import { startDaemon, type Connection } from '../src/daemon.js';
import { Captures } from '../src/captures.js';
import { hookSchema } from '../src/schema.js';
import { harnessHome, marker } from '../src/paths.js';

function project() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wisdom-delete-')));
  const data = path.join(root, '.wisdom');
  fs.mkdirSync(data);
  fs.writeFileSync(path.join(data, marker), JSON.stringify({ project: root }));
  return { root, data };
}

const event = (cwd: string, harness: string, sessionId: string, type: string, extra: Record<string, unknown> = {}, text?: string) =>
  ({ harness, cwd, ...extra, observation: { observationId: randomUUID(), sessionId, type, ...(text ? { data: { text } } : {}) } });
const send = (c: Connection, ...args: Parameters<typeof event>) => call(c, '/observe', event(...args));
const glance = async (c: Connection, capture?: string): Promise<string> => (await call(c, '/ledger', capture ? { capture, glance: true } : { glance: true })).text;

/** A Claude Code transcript in this project's own Claude home, as a tracked session writes it. */
function claudeTranscript(data: string, root: string, sessionId: string, text: string): string {
  const folder = path.join(harnessHome(data, 'claude-code'), 'projects', root.replace(/[^a-zA-Z0-9]/g, '-'));
  fs.mkdirSync(path.join(folder, sessionId, 'subagents'), { recursive: true });
  const file = path.join(folder, `${sessionId}.jsonl`);
  fs.writeFileSync(file, JSON.stringify({ type: 'user', sessionId, cwd: root, uuid: randomUUID(), message: { role: 'user', content: text } }) + '\n');
  return file;
}

/** Every byte SQLite holds, its write-ahead log included. */
function databaseBytes(data: string): string {
  return ['ledger.sqlite', 'ledger.sqlite-wal'].map(name => path.join(data, name))
    .filter(file => fs.existsSync(file)).map(file => fs.readFileSync(file).toString('latin1')).join('');
}

test('deleting a session leaves no trace of it in the database, its folder or its harness home', async () => {
  const { root, data } = project();
  const daemon = await startDaemon(data, 0);
  try {
    const c = daemon.connection;
    const home = harnessHome(data, 'claude-code');
    const source = claudeTranscript(data, root, 'gone', 'zebra-marker-77 in the transcript');
    fs.mkdirSync(path.join(home, 'file-history', 'gone'), { recursive: true });
    fs.mkdirSync(path.join(home, 'session-env', 'gone'), { recursive: true });
    await call(c, '/observe', { harness: 'claude-code', cwd: root, observation: { observationId: randomUUID(), sessionId: 'gone', type: 'session_started', source } });
    await send(c, root, 'claude-code', 'gone', 'input', {}, 'zebra-marker-77 typed by a person');
    await send(c, root, 'claude-code', 'gone', 'session_ended');
    await send(c, root, 'claude-code', 'stays', 'input', {}, 'another session');
    await send(c, root, 'claude-code', 'stays', 'session_ended');
    const before = Number((await call(c, '/health')).readVersion);
    assert.match(databaseBytes(data), /zebra-marker-77/);

    const { results } = await call(c, '/delete', { sessions: ['gone'] });
    assert.equal(results.length, 1);
    assert.deepEqual(results[0].kept, []);
    for (const removed of [path.join(data, 'harnesses', 'claude-code', 'gone'), source, source.replace(/\.jsonl$/, ''),
      path.join(home, 'file-history', 'gone'), path.join(home, 'session-env', 'gone')]) {
      assert.ok(results[0].removed.includes(removed), `removed ${removed}`);
      assert.equal(fs.existsSync(removed), false, `${removed} is gone`);
    }
    assert.doesNotMatch(databaseBytes(data), /zebra-marker-77/);
    assert.doesNotMatch(await glance(c), /gone/);
    assert.match(await glance(c), /stays/);
    // The version never moves back, so a version given before the delete can still be read.
    assert.equal(Number((await call(c, '/health')).readVersion), before);
    await assert.rejects(call(c, '/ledger', { capture: 'gone', glance: true }), /No recorded session|gone/);
  } finally {
    await daemon.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a session that continues a deleted one says so, and keeps its own evidence', async () => {
  const { root, data } = project();
  const daemon = await startDaemon(data, 0);
  try {
    const c = daemon.connection;
    await send(c, root, 'claude-code', 'first', 'input', {}, 'start the work');
    await send(c, root, 'claude-code', 'first', 'session_ended');
    const handoff = { id: randomUUID(), from: 'first' };
    await send(c, root, 'codex', 'second', 'session_started', { handoff });
    await send(c, root, 'codex', 'second', 'input', { handoff }, 'read first, then go on');
    await send(c, root, 'codex', 'second', 'session_ended');
    assert.match(await glance(c, 'second'), /^continues first \(claude-code\)$/m);

    await call(c, '/delete', { sessions: ['first'] });
    const second = await glance(c, 'second');
    assert.match(second, /^continues a deleted session$/m);
    assert.doesNotMatch(second, /continues first/);
    // The person's prompt is that session's evidence and is not edited.
    assert.match((await call(c, '/ledger', { capture: 'second', open: 't1' })).text, /read first, then go on/);
  } finally {
    await daemon.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a session still recording is refused, and the others in the same request are still deleted', async () => {
  const { root, data } = project();
  const daemon = await startDaemon(data, 0);
  try {
    const c = daemon.connection;
    await send(c, root, 'pi', 'live', 'input', {}, 'still working');
    await send(c, root, 'pi', 'done', 'input', {}, 'finished');
    await send(c, root, 'pi', 'done', 'session_ended');
    const { results } = await call(c, '/delete', { sessions: ['live', 'done', 'never-recorded'] });
    assert.match(results[0].error, /still recording/);
    assert.equal(results[1].session, 'done');
    assert.ok(results[1].removed.length > 0);
    assert.match(results[2].error, /No recorded session/);
    const list = await glance(c);
    assert.match(list, /live/);
    assert.doesNotMatch(list, /done/);
  } finally {
    await daemon.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a deleted session is never recorded again, from its hooks or from a session file', () => {
  const { root, data } = project();
  const captures = new Captures(data);
  try {
    captures.route(hookSchema.parse(event(root, 'claude-code', 'once', 'input', {}, 'hello')));
    captures.close('once');
    captures.remove('once');
    assert.equal(captures.isDeleted('once'), true);
    assert.equal(captures.route(hookSchema.parse(event(root, 'claude-code', 'once', 'input', {}, 'hello again'))), undefined);
    assert.equal(captures.ledgers.has('once'), false);
    // A quiet transcript naming it, left in the harness home, is not taken as a found session.
    const file = claudeTranscript(data, root, 'once', 'hello');
    const old = new Date(Date.now() - 10 * 60_000);
    fs.utimesSync(file, old, old);
    captures.scan();
    assert.equal(captures.ledgers.has('once'), false);
    // Only a hash of the ID is kept.
    assert.doesNotMatch(fs.readFileSync(path.join(data, 'deleted.json'), 'utf8'), /once/);
  } finally {
    captures.shutdown(); captures.database.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the deleted list survives a daemon restart, and a session file outside the data folder is kept', async () => {
  const { root, data } = project();
  const outside = path.join(root, 'elsewhere.jsonl');
  fs.writeFileSync(outside, JSON.stringify({ type: 'session', version: 3, id: 'theirs', cwd: root, timestamp: new Date().toISOString() }) + '\n');
  let captures = new Captures(data);
  try {
    captures.route(hookSchema.parse({ ...event(root, 'pi', 'theirs', 'session_started'), observation: { ...event(root, 'pi', 'theirs', 'session_started').observation, source: outside } }));
    captures.close('theirs');
    // Not in a connected harness home, so kept even when the harness's copy is asked for.
    const result = captures.remove('theirs', { harnessCopy: true });
    assert.deepEqual(result.kept, [outside]);
    assert.equal(fs.existsSync(outside), true);
    captures.shutdown(); captures.database.close();
    captures = new Captures(data);
    assert.equal(captures.isDeleted('theirs'), true);
    assert.equal(captures.route(hookSchema.parse(event(root, 'pi', 'theirs', 'input', {}, 'resumed later'))), undefined);
  } finally {
    captures.shutdown(); captures.database.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a connected session\'s files in the person\'s own harness home go only when asked, and only if they are that session\'s', () => {
  const { root, data } = project();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wisdom-own-claude-'));
  fs.writeFileSync(path.join(data, 'connected.json'), JSON.stringify({ 'claude-code': { since: new Date(0).toISOString(), home } }));
  const folder = path.join(home, 'projects', root.replace(/[^a-zA-Z0-9]/g, '-'));
  fs.mkdirSync(folder, { recursive: true });
  const transcript = (sessionId: string, names = sessionId) => {
    const file = path.join(folder, `${sessionId}.jsonl`);
    fs.writeFileSync(file, JSON.stringify({ type: 'user', sessionId: names, cwd: root, uuid: randomUUID(), message: { role: 'user', content: 'hi' } }) + '\n');
    return file;
  };
  const record = (sessionId: string, source: string) => {
    const opened = event(root, 'claude-code', sessionId, 'session_started');
    captures.route(hookSchema.parse({ ...opened, observation: { ...opened.observation, source } }));
    captures.close(sessionId);
  };
  const captures = new Captures(data);
  try {
    const kept = transcript('kept-copy');
    record('kept-copy', kept);
    assert.deepEqual(captures.remove('kept-copy').kept, [kept]);
    assert.equal(fs.existsSync(kept), true);

    const gone = transcript('gone-copy');
    fs.mkdirSync(path.join(home, 'file-history', 'gone-copy'), { recursive: true });
    record('gone-copy', gone);
    const result = captures.remove('gone-copy', { harnessCopy: true });
    assert.deepEqual(result.kept, []);
    assert.equal(fs.existsSync(gone), false);
    assert.equal(fs.existsSync(path.join(home, 'file-history', 'gone-copy')), false);

    // A record naming a file that turns out to hold another session never deletes it.
    const other = transcript('other-copy');
    record('other-copy', other);
    fs.writeFileSync(other, JSON.stringify({ type: 'user', sessionId: 'someone-else', cwd: root, uuid: randomUUID(), message: { role: 'user', content: 'hi' } }) + '\n');
    assert.deepEqual(captures.remove('other-copy', { harnessCopy: true }).kept, [other]);
    assert.equal(fs.existsSync(other), true);
  } finally {
    captures.shutdown(); captures.database.close();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('a preview deletes nothing and names the linked sessions still recording', async () => {
  const { root, data } = project();
  const daemon = await startDaemon(data, 0);
  try {
    const c = daemon.connection;
    await send(c, root, 'claude-code', 'origin', 'input', {}, 'begin');
    await send(c, root, 'claude-code', 'origin', 'session_ended');
    const handoff = { id: randomUUID(), from: 'origin' };
    await send(c, root, 'codex', 'follower', 'input', { handoff }, 'go on');
    const { results: [plan] } = await call(c, '/delete', { sessions: ['origin'], preview: true });
    assert.equal(plan.recording, false);
    assert.deepEqual(plan.linked, [{ session: 'follower', harness: 'codex', kind: 'continued-by' }]);
    assert.ok(plan.files.includes(path.join(data, 'harnesses', 'claude-code', 'origin')));
    assert.ok(plan.bytes > 0);
    assert.match(await glance(c), /origin/);
    const { results: [live] } = await call(c, '/delete', { sessions: ['follower'], preview: true });
    assert.equal(live.recording, true);
  } finally {
    await daemon.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('deleting a session takes only its own lines out of the history every session shares', () => {
  const { root, data } = project();
  const ownHome = harnessHome(data, 'claude-code');
  const personal = fs.mkdtempSync(path.join(os.tmpdir(), 'wisdom-own-claude-'));
  fs.writeFileSync(path.join(data, 'connected.json'), JSON.stringify({ 'claude-code': { since: new Date(0).toISOString(), home: personal } }));
  const line = (sessionId: string, prompt: string) => JSON.stringify({ display: prompt, timestamp: 1, project: root, sessionId });
  // Another session's lines, a line that is not JSON, and Windows line ends must all survive byte for byte.
  const history = (home: string) => {
    fs.mkdirSync(home, { recursive: true });
    const file = path.join(home, 'history.jsonl');
    fs.writeFileSync(file, [line('keep', 'first'), line('drop', 'secret prompt'), 'not json', line('keep', 'second') + '\r', line('drop', 'another'), ''].join('\n'));
    return file;
  };
  const own = history(ownHome), theirs = history(personal);
  const expected = [line('keep', 'first'), 'not json', line('keep', 'second') + '\r', ''].join('\n');
  const before = fs.readFileSync(theirs, 'utf8');
  const captures = new Captures(data);
  try {
    for (const id of ['drop', 'drop-too']) {
      captures.route(hookSchema.parse(event(root, 'claude-code', id, 'input', {}, 'hi')));
      captures.close(id);
    }
    const plan = captures.removal('drop');
    assert.deepEqual(plan.history, [{ file: own, lines: 2, harnessCopy: false }, { file: theirs, lines: 2, harnessCopy: true }]);

    const result = captures.remove('drop');
    assert.equal(fs.readFileSync(own, 'utf8'), expected);
    assert.ok(result.removed.includes(`${own} (2 lines of this session)`));
    // The person's own history changes only when the harness's copy is asked for.
    assert.equal(fs.readFileSync(theirs, 'utf8'), before);
    assert.ok(result.kept.includes(`${theirs} (2 lines of this session)`));

    fs.writeFileSync(theirs, before.replaceAll('"drop"', '"drop-too"'));
    captures.remove('drop-too', { harnessCopy: true });
    assert.equal(fs.readFileSync(theirs, 'utf8'), expected);
  } finally {
    captures.shutdown(); captures.database.close();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(personal, { recursive: true, force: true });
  }
});
