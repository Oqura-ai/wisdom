import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startDaemon } from '../src/service/daemon.js';
import { call } from '../src/service/client.js';
import { closeSession, observeSession, openSession } from './session.js';

const line = (entry: unknown) => JSON.stringify(entry) + '\n';
const header = (id: string) => line({ type: 'session', version: 3, id, timestamp: '2026-10-29T00:00:00.000Z', cwd: 'x' });
const message = (id: string, text: string) => line({ type: 'message', id, parentId: null, timestamp: '2026-10-29T00:00:01.000Z',
  message: { role: 'user', content: [{ type: 'text', text }] } });

async function setup(prefix: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const workspace = path.join(root, 'project'); fs.mkdirSync(workspace);
  const native = path.join(root, 'session.jsonl');
  const data = path.join(root, 'data');
  return { root, workspace, native, data, done: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('a rewritten native file keeps every copied byte, and copying goes on from its new end, across restarts', async () => {
  const box = await setup('wisdom-rewrite-');
  try {
    fs.writeFileSync(box.native, header('s') + message('m1', 'first') + message('m2', 'second'));
    let daemon = await startDaemon(box.data, 0);
    const open = () => openSession(daemon.connection, { harness: 'pi', sessionId: 's', workspaceRoot: box.workspace, source: box.native });
    await open();
    let ledger = daemon.captures.get('s');
    const before = fs.readFileSync(ledger.mirror);
    assert.deepEqual(before, fs.readFileSync(box.native));

    // The harness rewrites its file shorter, then appends.
    fs.writeFileSync(box.native, header('s'));
    ledger.syncSource();
    fs.appendFileSync(box.native, message('m3', 'after the rewrite'));
    ledger.syncSource();
    assert.deepEqual(fs.readFileSync(ledger.mirror), Buffer.concat([before, Buffer.from(message('m3', 'after the rewrite'))]));
    assert(ledger.listRecords().some(r => r.summary.startsWith('source-rewritten:Native file shrank')));
    await closeSession(daemon.connection, 's');
    assert(!ledger.listRecords().some(r => r.summary.startsWith('source-copy-incomplete')));

    // The read position survives a daemon restart.
    await daemon.close();
    daemon = await startDaemon(box.data, 0);
    fs.appendFileSync(box.native, message('m4', 'after a restart'));
    await open();
    ledger = daemon.captures.get('s');
    assert(fs.readFileSync(ledger.mirror, 'utf8').endsWith(message('m3', 'after the rewrite') + message('m4', 'after a restart')));
    await daemon.close();
  } finally { box.done(); }
});

test('a native file that is not this session is never copied', async () => {
  const box = await setup('wisdom-incompatible-');
  const daemon = await startDaemon(box.data, 0);
  try {
    const open = async (sessionId: string, text: string) => {
      const native = path.join(box.root, `${sessionId}.jsonl`); fs.writeFileSync(native, text);
      await openSession(daemon.connection, { harness: 'pi', sessionId, workspaceRoot: box.workspace, source: native });
      return daemon.captures.get(sessionId);
    };
    const other = await open('mine', header('someone-else') + message('m1', 'not mine'));
    assert.equal(fs.readFileSync(other.mirror, 'utf8'), '');
    assert(other.listRecords().some(r => r.summary === 'source-incompatible:Native file is not this pi session (line 1 belongs to session someone-else); copying stopped.'));
    const text = await open('text', 'plain text\n' + header('text'));
    assert.equal(fs.readFileSync(text.mirror, 'utf8'), '');
    assert(text.listRecords().some(r => r.summary.includes('its first line is not a JSON object')));
    // A damaged line further in is the same file: it is copied and becomes its own gap.
    const damaged = await open('damaged', header('damaged') + '{broken\n' + message('m1', 'still mine'));
    assert.equal(fs.readFileSync(damaged.mirror, 'utf8'), header('damaged') + '{broken\n' + message('m1', 'still mine'));
  } finally { await daemon.close(); box.done(); }
});

test('a gap kind repeated three or more times is one glance line with its count, first and last', async () => {
  const box = await setup('wisdom-gaps-');
  const daemon = await startDaemon(box.data, 0);
  try {
    const open = () => openSession(daemon.connection, { harness: 'pi', sessionId: 's', workspaceRoot: box.workspace, source: null });
    await open();
    for (let visit = 0; visit < 3; visit++) { await closeSession(daemon.connection, 's'); await open(); }
    const records = daemon.captures.get('s').listRecords().filter(r => r.summary.startsWith('not-recording-between-visits'));
    assert.equal(records.length, 3);
    const glance = (await call(daemon.connection, '/ledger', { capture: 's', glance: true })).text;
    const lines = glance.split('\n').filter((l: string) => l.includes('not-recording-between-visits'));
    assert.equal(lines.length, 1);
    assert.match(lines[0], new RegExp(`^not recorded  not-recording-between-visits ×3 · first \\(seq ${records[0].seq}\\): File changes from .+ · last \\(seq ${records[2].seq}\\): File changes from .+$`));
  } finally { await daemon.close(); box.done(); }
});
