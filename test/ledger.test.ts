import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { applyPatch } from 'diff';
import { startDaemon } from '../src/daemon.js';
import { call } from '../src/client.js';
import { closeSession, observeSession, openSession } from './session.js';
import { Ledger } from '../src/ledger.js';
import { LedgerDatabase } from '../src/database.js';
import { scope } from '../src/workspace.js';
import { createLedgerMcp } from '../src/mcp.js';
import { CEILING } from '../src/discovery.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wisdom-test-'));
  const workspace = path.join(root, 'project'); fs.mkdirSync(workspace);
  return { root, workspace, data: path.join(root, 'data') };
}
const obs = (type: string, extra: Record<string, unknown> = {}) => ({ observationId: randomUUID(), type, ...extra });

test('live reads show pending calls, exact patches, failed side effects, and whole bodies', async () => {
  const box = sandbox();
  fs.writeFileSync(path.join(box.workspace, 'auth.ts'), 'const greeting = "hello";\r\n');
  const daemon = await startDaemon(box.data, 0);
  try {
    const connection = daemon.connection;
    const capture = await openSession(connection, { harness: 'pi', sessionId: 'test-session', workspaceRoot: box.workspace, source: null });
    const id = capture.captureId;
    const send = (record: unknown) => observeSession(connection, id, record);
    const read = async (request: object): Promise<string> => (await call(connection, '/ledger', { capture: id, ...request })).text;
    await send(obs('input', { data: { text: 'Change greeting without changing the API.' } }));
    const start = obs('tool_started', { toolCallId: 't1', toolName: 'edit', data: { input: { path: 'auth.ts' } } });
    await send(start);
    await send(start); // Retried observation must not create a second start.
    assert.match(await read({ glance: true }), /^ {4}1 tool call · 1 pending · no changes$/m);
    assert.match(await read({ open: 't1' }), /^c1  edit auth\.ts · pending$/m);
    fs.writeFileSync(path.join(box.workspace, 'auth.ts'), 'const greeting = "नमस्ते";\r\n');
    await send(obs('tool_finished', { toolCallId: 't1', toolName: 'edit', isError: false, data: { content: 'changed' } }));
    const change = daemon.captures.database.records("capture_id=? AND type='file_change'", [id])[0];
    assert.equal(change.attribution, 'observed-during-tool');
    assert.equal(change.operation, 'modify');
    // The stored patch is exact: it turns the old bytes into the new ones, CRLF included.
    assert.equal(applyPatch('const greeting = "hello";\r\n', daemon.captures.get(id).readPayload(change.patchRef!)), 'const greeting = "नमस्ते";\r\n');
    const turn = await read({ open: 't1' });
    assert.match(turn, /^c1  edit auth\.ts · ok · → p1\n {4}input and output repeat p1 · open t1\/c1 to read them$/m);
    assert.match(turn, /^p1  auth\.ts · modify · \+1 −1 · observed during c1$/m);
    assert.match(turn, /^ {4}\+const greeting = "नमस्ते";$/m);

    await send(obs('tool_started', { toolCallId: 't2', toolName: 'bash', data: { input: { command: 'write then fail' } } }));
    fs.writeFileSync(path.join(box.workspace, 'leftover.txt'), 'partial side effect');
    await send(obs('tool_finished', { toolCallId: 't2', toolName: 'bash', isError: true, data: { content: 'failure '.repeat(2000) } }));
    const after = await read({ open: 't1' });
    assert.match(after, /^c2  bash · failed · → p2\n {4}input {5}\{"command":"write then fail"\}$/m);
    assert.match(after, /^p2  leftover\.txt · create · \+1 −0 · observed during c2$/m);
    // A 16,000-character output is under the ceiling, so it arrives whole: no rule cuts tool output.
    assert(after.replace(/\n⤷ /g, '').includes('failure '.repeat(2000).trimEnd()));
    assert.match(after, /\ncomplete · \d+ lines · lines over 2,000 characters are split; ⤷ marks a continued piece$/);
    await closeSession(connection, id, 'test');
  } finally { await daemon.close(); fs.rmSync(box.root, { recursive: true, force: true }); }
});

test('a limited response continues from the same snapshot; external edits, rename, deletion and binaries stay observable', async () => {
  const box = sandbox();
  const daemon = await startDaemon(box.data, 0);
  try {
    const c = daemon.connection;
    const manifest = await openSession(c, { harness: 'pi', sessionId: 's', workspaceRoot: box.workspace, source: null });
    const id = manifest.captureId;
    const send = (record: unknown) => observeSession(c, id, record);
    const read = async (request: object): Promise<string> => (await call(c, '/ledger', { capture: id, ...request })).text;
    await send(obs('input', { data: { text: 'Print a lot' } }));
    await send(obs('tool_started', { toolCallId: 'big', toolName: 'bash', data: { input: { command: 'yes' } } }));
    const big = Array.from({ length: 3000 }, (_, i) => `line ${i} ${'y'.repeat(40)}`).join('\n');
    await send(obs('tool_finished', { toolCallId: 'big', toolName: 'bash', isError: false, data: { content: big } }));
    const first = await read({ open: 't1' });
    assert(first.length <= CEILING + 400, 'one response stays under the ceiling');
    assert.match(first.split('\n').at(-1)!, /^limited · lines 1–\d+ of \d+ · continue: \{"capture":"[^"]+","open":"t1","at":\d+,"from":\d+\}$/);
    // Recording continues, but the continuation reads the version the first page stated.
    await send(obs('input', { data: { text: 'later request' } }));
    const pages = [first];
    for (let page = first; /continue: (\{.*\})$/.test(page.split('\n').at(-1)!);) {
      page = (await call(c, '/ledger', JSON.parse(/continue: (\{.*\})$/.exec(page.split('\n').at(-1)!)![1]))).text;
      pages.push(page);
    }
    assert(pages.length >= 2);
    assert.match(pages.at(-1)!.split('\n').at(-1)!, /^complete · lines \d+–\d+ of \d+$/);
    const stitched = pages.map(page => page.split('\n').slice(0, -2)).flat().join('\n');
    assert(stitched.includes(big.split('\n').map(line => `        ${line}`).join('\n')), 'every line arrives once, in order');
    assert.match(await read({ glance: true }), /^t2  in {8}later request$/m);

    fs.writeFileSync(path.join(box.workspace, 'manual.txt'), 'human or background writer');
    // A real watcher notification drives idle observation without any tool call.
    await new Promise(resolve => setTimeout(resolve, 800));
    daemon.captures.poll();
    assert.equal(daemon.captures.database.records("capture_id=? AND type='file_change' AND path='manual.txt'", [id])[0].attribution, 'external-or-unknown');
    // An idle change belongs to no turn: the glance points to it and "outside" shows it whole.
    assert.match(await read({ glance: true }), /^outside {3}no tool calls · changed manual\.txt \(1 change outside any tool call\) · open "outside"$/m);
    assert.match(await read({ open: 'outside' }), /^p1  manual\.txt · create · \+1 −0 · external-or-unknown · seq \d+\n[\s\S]*?^ {4}\+human or background writer$/m);
    await send(obs('tool_started', { toolCallId: 'rename', toolName: 'bash' }));
    fs.renameSync(path.join(box.workspace, 'manual.txt'), path.join(box.workspace, 'renamed.txt'));
    await send(obs('tool_finished', { toolCallId: 'rename', toolName: 'bash', isError: false }));
    await send(obs('tool_started', { toolCallId: 'binary', toolName: 'bash' }));
    fs.writeFileSync(path.join(box.workspace, 'image.bin'), Buffer.from([0, 1, 2, 255]));
    await send(obs('tool_finished', { toolCallId: 'binary', toolName: 'bash', isError: false }));
    const later = await read({ open: 't2' });
    assert.match(later, /^c1  bash · ok · → p1, p2\n {4}output {4}none recorded$/m);
    // Creation and deletion are patches from and to empty, so the contents stay readable.
    assert.match(later, /^p1  renamed\.txt · create · \+1 −0 · observed during c1\n[\s\S]*?^ {4}\+human or background writer$/m);
    assert.match(later, /^p2  manual\.txt · delete · \+0 −1 · observed during c1\n {4}--- manual\.txt\s*\n {4}\+\+\+ \/dev\/null\s*\n {4}@@[^\n]*\n {4}-human or background writer$/m);
    assert.match(later, /^p3  image\.bin · create · observed during c2\n {4}patch not recorded: binary-or-non-utf8$/m);
  } finally { await daemon.close(); fs.rmSync(box.root, { recursive: true, force: true }); }
});

test('ledger requests that cannot be answered say what to send instead', async () => {
  const box = sandbox();
  const daemon = await startDaemon(box.data, 0);
  try {
    const c = daemon.connection;
    await assert.rejects(call(c, '/ledger', { glance: true, capture: 'latest' }), /No sessions are recorded yet/);
    const { captureId } = await openSession(c, { harness: 'pi', sessionId: 's', workspaceRoot: box.workspace, source: null });
    await observeSession(c, captureId, obs('input', { data: { text: 'hello' } }));
    const version = daemon.captures.database.revision;
    for (const [request, message] of [
      [{}, /exactly one of glance or open/], [{ glance: true, open: 't1', capture: captureId }, /exactly one of glance or open/],
      [{ open: 't1' }, /open needs capture/], [{ capture: 'nothing-like-it', glance: true }, /No session matches/],
      [{ capture: captureId, open: 't2' }, /t2 does not exist: this session has t1–t1 at version/],
      [{ capture: captureId, open: 't1/c1' }, /t1\/c1 does not exist: t1 has no tool calls/],
      [{ capture: captureId, open: 'turn 1' }, /is not a position/], [{ capture: captureId, open: 'a1' }, /no subagents/],
      [{ capture: captureId, glance: true, from: 999 }, /past the end/], [{ capture: captureId, glance: true, at: version + 5 }, /not available/],
      [{ capture: captureId, find: 'changes' }, /Invalid ledger request/],
    ] as const) await assert.rejects(call(c, '/ledger', request), message);
    // A unique prefix of the capture ID and "latest" both name the session.
    const byPrefix = (await call(c, '/ledger', { capture: captureId.slice(0, 8), glance: true })).text;
    assert.equal(byPrefix, (await call(c, '/ledger', { capture: 'latest', glance: true })).text);
    assert.match((await call(c, '/ledger', { glance: true })).text, new RegExp(`^${captureId}  pi  recording  `, 'm'));
  } finally { await daemon.close(); fs.rmSync(box.root, { recursive: true, force: true }); }
});

test('native mirroring preserves bytes across partial UTF-8 lines and correlates explicit tool IDs', () => {
  const box = sandbox();
  try {
    const source = path.join(box.root, 'native.jsonl'); fs.writeFileSync(source, '');
    const ledger = new Ledger(path.join(box.data, 'capture'), { schemaVersion: 1, captureId: 'capture', harness: 'pi', sessionId: 's',
      workspaceRoot: box.workspace, source, startedAt: new Date().toISOString(), status: 'recording', scope }, new LedgerDatabase(path.join(box.data, 'ledger.sqlite')), true);
    const first = Buffer.from(JSON.stringify({ type: 'message', id: 'm1', parentId: null, message: { role: 'assistant',
      content: [{ type: 'text', text: 'हैलो\u2028world' }, { type: 'toolCall', id: 'a', name: 'edit', arguments: {} },
        { type: 'toolCall', id: 'b', name: 'write', arguments: {} }] } }) + '\n');
    fs.appendFileSync(source, first.subarray(0, first.length - 3)); ledger.syncSource();
    assert.equal(ledger.listRecords().length, 0);
    fs.appendFileSync(source, first.subarray(first.length - 3)); ledger.syncSource(); ledger.syncSource();
    assert.equal(ledger.listRecords().length, 3);
    const result = Buffer.from(JSON.stringify({ type: 'message', id: 'm2', parentId: 'm1', message: { role: 'toolResult', toolCallId: 'b', content: [] } }) + '\n');
    fs.appendFileSync(source, result); ledger.syncSource();
    assert.deepEqual(fs.readFileSync(ledger.mirror), Buffer.concat([first, result]));
    assert.equal(ledger.listRecords().filter(r => r.toolCallId === 'b').length, 2);
    ledger.database.close();
  } finally { fs.rmSync(box.root, { recursive: true, force: true }); }
});

test('MCP serves the same read-only ledger and captures survive daemon restart', async () => {
  const box = sandbox();
  let daemon = await startDaemon(box.data, 0);
  try {
    const manifest = await openSession(daemon.connection, { harness: 'pi', sessionId: 's', workspaceRoot: box.workspace, source: null });
    await observeSession(daemon.connection, manifest.captureId, obs('input', { data: { text: 'Preserve this intent.' } }));
    const server = createLedgerMcp(daemon.connection);
    const client = new Client({ name: 'test', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const tools = await client.listTools();
    assert.equal(tools.tools.length, 1); assert.equal(tools.tools[0].annotations?.readOnlyHint, true);
    assert.equal(tools.tools[0].name, 'ledger');
    const text = (result: any): string => result.content[0].text;
    assert(text(await client.callTool({ name: 'ledger', arguments: { glance: true } })).includes(manifest.captureId));
    const opened = await client.callTool({ name: 'ledger', arguments: { capture: manifest.captureId, open: 't1' } });
    assert.match(text(opened), /^in {8}Preserve this intent\.$/m);
    assert.equal(text(opened), (await call(daemon.connection, '/ledger', { capture: manifest.captureId, open: 't1' })).text);
    const missing = await client.callTool({ name: 'ledger', arguments: { capture: manifest.captureId, open: 't9' } });
    assert.equal(missing.isError, true); assert.match(text(missing), /t9 does not exist/);
    await client.close(); await server.close();
    await daemon.close();
    daemon = await startDaemon(box.data, 0);
    const recovered = (await call(daemon.connection, '/ledger', { capture: manifest.captureId, glance: true })).text;
    assert.match(recovered, /^session [^\n]* · interrupted/);
    // The session ID is the harness's own, with the command that resumes it under recording.
    assert.match(recovered, /^resume with: wisdom resume s$/m);
    assert.match((await call(daemon.connection, '/ledger', { glance: true })).text, /^s  pi  [^\n]* 1 turn  /m);
    assert.match(recovered, /^t1  in {8}Preserve this intent\.$/m);
    const unauthorized = await fetch(daemon.connection.url + '/ledger', { method: 'POST', body: '{}' });
    assert.equal(unauthorized.status, 401);
  } finally { await daemon.close(); fs.rmSync(box.root, { recursive: true, force: true }); }
});

test('nested operations do not duplicate patches or imply exclusive attribution', async () => {
  const box = sandbox();
  const daemon = await startDaemon(box.data, 0);
  try {
    const m = await openSession(daemon.connection, { harness: 'pi', sessionId: 's', workspaceRoot: box.workspace, source: null });
    const send = (record: unknown) => observeSession(daemon.connection, m.captureId, record);
    await send(obs('tool_started', { toolCallId: 'parent', toolName: 'custom' }));
    await send(obs('tool_started', { toolCallId: 'parent/1', parentToolCallId: 'parent', toolName: 'write', data: { input: { path: 'nested.txt' } } }));
    fs.writeFileSync(path.join(box.workspace, 'nested.txt'), 'nested');
    await send(obs('tool_finished', { toolCallId: 'parent/1', toolName: 'write', isError: false }));
    await send(obs('tool_finished', { toolCallId: 'parent', toolName: 'custom', isError: false }));
    const changes = daemon.captures.database.records("capture_id=? AND type='file_change'", [m.captureId]);
    assert.equal(changes.length, 1);
    assert.deepEqual(changes[0].activeToolCallIds, ['parent', 'parent/1']);
  } finally { await daemon.close(); fs.rmSync(box.root, { recursive: true, force: true }); }
});

test('relative native source paths resolve against Pi cwd and do not become code changes', async () => {
  const box = sandbox();
  const daemon = await startDaemon(box.data, 0);
  try {
    const source = path.join(box.workspace, 'native.jsonl');
    fs.writeFileSync(source, JSON.stringify({ type: 'session', id: 's' }) + '\n');
    const manifest = await openSession(daemon.connection, { harness: 'pi', sessionId: 's', workspaceRoot: box.workspace, source: 'native.jsonl' });
    assert.equal(daemon.captures.get(manifest.captureId).manifest.source, source);
    fs.appendFileSync(source, JSON.stringify({ type: 'message', id: 'm', parentId: null, message: { role: 'user', content: 'hello' } }) + '\n');
    await closeSession(daemon.connection, manifest.captureId, 'test');
    const ledger = daemon.captures.get(manifest.captureId);
    assert(ledger.listRecords().some(r => r.role === 'user'));
    assert.equal(ledger.listRecords().filter(r => r.type === 'file_change').length, 0);
    // Reopening a capture reads its committed SQLite evidence; the mirror matches, so no recovery gap.
    const recovered = new Ledger(ledger.dir, ledger.manifest, daemon.captures.database);
    assert.equal(recovered.recoveryGaps.length, 0);
    assert(recovered.listRecords().some(r => r.role === 'user'));
  } finally { await daemon.close(); fs.rmSync(box.root, { recursive: true, force: true }); }
});
