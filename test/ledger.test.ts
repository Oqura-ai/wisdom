import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { applyPatch } from 'diff';
import { startDaemon } from '../src/daemon.js';
import { call } from '../src/client.js';
import { Ledger } from '../src/ledger.js';
import { LedgerDatabase } from '../src/database.js';
import { scope } from '../src/workspace.js';
import { createLedgerMcp } from '../src/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wisdom-test-'));
  const workspace = path.join(root, 'project'); fs.mkdirSync(workspace);
  return { root, workspace, data: path.join(root, 'data') };
}
const obs = (type: string, extra: Record<string, unknown> = {}) => ({ observationId: randomUUID(), type, ...extra });

test('live queries show pending calls, exact patches, failed side effects, and bounded evidence', async () => {
  const box = sandbox();
  fs.writeFileSync(path.join(box.workspace, 'auth.ts'), 'const greeting = "hello";\r\n');
  const daemon = await startDaemon(box.data, 0);
  try {
    const connection = daemon.connection;
    const capture = await call(connection, '/captures', { piSessionId: 'test-session', workspaceRoot: box.workspace, source: null });
    const id = capture.captureId;
    const send = (record: unknown) => call(connection, `/captures/${id}/observe`, record);
    const ask = (query: object) => call(connection, '/query', { captureId: id, ...query });
    const input = await send(obs('input', { data: { text: 'Change greeting without changing the API.' } }));
    const start = obs('tool_started', { toolCallId: 't1', toolName: 'edit', data: { input: { path: 'auth.ts' } } });
    await send(start);
    await send(start); // Retried observation must not create a second start.
    const running = await ask({ preset: 'timeline' });
    assert.deepEqual(running.coverage[0].pendingToolCount, 1);
    assert.equal(running.items.filter((r: any) => r.type === 'tool_started').length, 1);
    fs.writeFileSync(path.join(box.workspace, 'auth.ts'), 'const greeting = "नमस्ते";\r\n');
    await send(obs('tool_finished', { toolCallId: 't1', toolName: 'edit', isError: false, data: { content: 'changed' } }));
    const files = await ask({ preset: 'changes' });
    const change = files.items[0];
    assert.equal(change.attribution, 'observed-during-tool');
    assert.equal(change.operation, 'modify');
    assert.equal(change.patchRef, undefined); // Summary views don't load bodies.
    const details = await ask({ op: 'inspect', id: change.id, sections: ['patch'] });
    assert.equal(applyPatch('const greeting = "hello";\r\n', details.sections.patch.text), 'const greeting = "नमस्ते";\r\n');
    const operation = await ask({ find: 'tools', where: { toolCallId: change.evidence.toolCallId } });
    assert(operation.items.some((r: any) => r.type === 'tool_started'));
    const children = await ask({ find: 'events', where: { parentId: input.id } });
    assert(children.items.some((r: any) => r.type === 'tool_started'));

    await send(obs('tool_started', { toolCallId: 't2', toolName: 'bash', data: { input: { command: 'write then fail' } } }));
    fs.writeFileSync(path.join(box.workspace, 'leftover.txt'), 'partial side effect');
    await send(obs('tool_finished', { toolCallId: 't2', toolName: 'bash', isError: true, data: { content: 'failure '.repeat(2000) } }));
    const failed = await ask({ find: 'outputs', where: { isError: true } });
    assert.equal(failed.items.length, 1);
    const changes = await ask({ find: 'changes', where: { toolCallId: failed.items[0].evidence.toolCallId } });
    assert.equal(changes.items[0].path, 'leftover.txt');
    const output = await ask({ op: 'inspect', id: failed.items[0].id, sections: ['data'], maxChars: 100 });
    assert.equal(output.sections.data.text.length, 100);
    assert.equal(output.sections.data.nextOffset, 100);
    await call(connection, `/captures/${id}/close`, { reason: 'test' });
  } finally { await daemon.close(); fs.rmSync(box.root, { recursive: true, force: true }); }
});

test('pagination freezes its read position; external edits, rename and deletion stay observable', async () => {
  const box = sandbox();
  const daemon = await startDaemon(box.data, 0);
  try {
    const c = daemon.connection;
    const manifest = await call(c, '/captures', { piSessionId: 's', workspaceRoot: box.workspace, source: null });
    const id = manifest.captureId;
    const send = (record: unknown) => call(c, `/captures/${id}/observe`, record);
    for (let i = 0; i < 3; i++) await send(obs('input', { data: { text: `request ${i}` } }));
    const base = { preset: 'timeline', captureId: id, limit: 2 };
    let page = await call(c, '/query', base);
    const version = page.readVersion;
    await send(obs('input', { data: { text: 'later request' } }));
    let count = page.items.length;
    while (page.nextCursor) {
      page = await call(c, '/query', { ...base, cursor: page.nextCursor });
      assert.equal(page.readVersion, version); count += page.items.length;
      assert(page.items.every((r: any) => r.seq <= version));
    }
    assert.equal(count, 5);
    fs.writeFileSync(path.join(box.workspace, 'manual.txt'), 'human or background writer');
    // A real watcher notification drives idle observation without any tool call.
    await new Promise(resolve => setTimeout(resolve, 800));
    daemon.captures.poll();
    const files = await call(c, '/query', { preset: 'changes', captureId: id });
    assert.equal(files.items[0].attribution, 'external-or-unknown');
    await send(obs('tool_started', { toolCallId: 'rename', toolName: 'bash' }));
    fs.renameSync(path.join(box.workspace, 'manual.txt'), path.join(box.workspace, 'renamed.txt'));
    await send(obs('tool_finished', { toolCallId: 'rename', toolName: 'bash', isError: false }));
    const lifecycle = await call(c, '/query', { preset: 'changes', captureId: id });
    const deleted = lifecycle.items.find((r: any) => r.path === 'manual.txt' && r.operation === 'delete');
    const created = lifecycle.items.find((r: any) => r.path === 'renamed.txt' && r.operation === 'create');
    // Creation and deletion are patches from and to empty, so the contents stay readable.
    assert.match(deleted.patch.text, /--- manual\.txt[\s\S]*\+\+\+ \/dev\/null[\s\S]*-human or background writer/);
    assert.match(created.patch.text, /--- \/dev\/null[\s\S]*\+\+\+ renamed\.txt[\s\S]*\+human or background writer/);
    await send(obs('tool_started', { toolCallId: 'binary', toolName: 'bash' }));
    fs.writeFileSync(path.join(box.workspace, 'image.bin'), Buffer.from([0, 1, 2, 255]));
    await send(obs('tool_finished', { toolCallId: 'binary', toolName: 'bash', isError: false }));
    const binary = (await call(c, '/query', { preset: 'changes', captureId: id, where: { path: 'image.bin' } })).items[0];
    assert.equal(binary.operation, 'create');
    assert.equal(binary.patch.available, false);
    assert.equal(binary.patchUnavailable, 'binary-or-non-utf8');
  } finally { await daemon.close(); fs.rmSync(box.root, { recursive: true, force: true }); }
});

test('native mirroring preserves bytes across partial UTF-8 lines and correlates explicit tool IDs', () => {
  const box = sandbox();
  try {
    const source = path.join(box.root, 'native.jsonl'); fs.writeFileSync(source, '');
    const ledger = new Ledger(path.join(box.data, 'capture'), { schemaVersion: 1, captureId: 'capture', piSessionId: 's',
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
    assert.deepEqual(fs.readFileSync(path.join(ledger.dir, 'pi-session.jsonl')), Buffer.concat([first, result]));
    assert.equal(ledger.listRecords().filter(r => r.toolCallId === 'b').length, 2);
    ledger.database.close();
  } finally { fs.rmSync(box.root, { recursive: true, force: true }); }
});

test('MCP uses the same read-only queries and captures survive daemon restart', async () => {
  const box = sandbox();
  let daemon = await startDaemon(box.data, 0);
  try {
    const manifest = await call(daemon.connection, '/captures', { piSessionId: 's', workspaceRoot: box.workspace, source: null });
    await call(daemon.connection, `/captures/${manifest.captureId}/observe`, obs('input', { data: { text: 'Preserve this intent.' } }));
    const server = createLedgerMcp(daemon.connection);
    const client = new Client({ name: 'test', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const tools = await client.listTools();
    assert.equal(tools.tools.length, 1); assert.equal(tools.tools[0].annotations?.readOnlyHint, true);
    const response = await client.callTool({ name: 'ledger_query', arguments: { op: 'sessions' } });
    assert((response.content as any[])[0].text.includes(manifest.captureId));
    const review = await client.callTool({ name: 'ledger_query', arguments: { preset: 'interaction-review', captureId: manifest.captureId } });
    const projection = JSON.parse((review.content as any[])[0].text);
    assert.equal(projection.queryVersion, 3);
    assert.equal(projection.items[0].content.text, 'Preserve this intent.');
    const clean = await client.callTool({ name: 'ledger_query', arguments: { preset: 'interaction-review', captureId: manifest.captureId, clean: true } });
    assert.deepEqual(JSON.parse((clean.content as any[])[0].text), [{ user: 'Preserve this intent.' }]);
    await client.close(); await server.close();
    await daemon.close();
    daemon = await startDaemon(box.data, 0);
    const recovered = await call(daemon.connection, '/query', { find: 'requests', captureId: manifest.captureId });
    assert.equal(recovered.coverage[0].currentStatus, 'interrupted');
    assert(recovered.items.some((r: any) => r.summary === 'Preserve this intent.'));
    const unauthorized = await fetch(daemon.connection.url + '/query', { method: 'POST', body: '{}' });
    assert.equal(unauthorized.status, 401);
  } finally { await daemon.close(); fs.rmSync(box.root, { recursive: true, force: true }); }
});

test('nested operations do not duplicate patches or imply exclusive attribution', async () => {
  const box = sandbox();
  const daemon = await startDaemon(box.data, 0);
  try {
    const m = await call(daemon.connection, '/captures', { piSessionId: 's', workspaceRoot: box.workspace, source: null });
    const send = (record: unknown) => call(daemon.connection, `/captures/${m.captureId}/observe`, record);
    await send(obs('tool_started', { toolCallId: 'parent', toolName: 'custom' }));
    await send(obs('tool_started', { toolCallId: 'parent/1', parentToolCallId: 'parent', toolName: 'write', data: { input: { path: 'nested.txt' } } }));
    fs.writeFileSync(path.join(box.workspace, 'nested.txt'), 'nested');
    await send(obs('tool_finished', { toolCallId: 'parent/1', toolName: 'write', isError: false }));
    await send(obs('tool_finished', { toolCallId: 'parent', toolName: 'custom', isError: false }));
    const result = await call(daemon.connection, '/query', { preset: 'changes', captureId: m.captureId });
    assert.equal(result.items.length, 1);
    assert.deepEqual(result.items[0].activeToolCallIds, ['parent', 'parent/1']);
  } finally { await daemon.close(); fs.rmSync(box.root, { recursive: true, force: true }); }
});

test('relative native source paths resolve against Pi cwd and do not become code changes', async () => {
  const box = sandbox();
  const daemon = await startDaemon(box.data, 0);
  try {
    const source = path.join(box.workspace, 'native.jsonl');
    fs.writeFileSync(source, JSON.stringify({ type: 'session', id: 's' }) + '\n');
    const manifest = await call(daemon.connection, '/captures', { piSessionId: 's', workspaceRoot: box.workspace, source: 'native.jsonl' });
    assert.equal(manifest.source, source);
    fs.appendFileSync(source, JSON.stringify({ type: 'message', id: 'm', parentId: null, message: { role: 'user', content: 'hello' } }) + '\n');
    await call(daemon.connection, `/captures/${manifest.captureId}/close`, { reason: 'test' });
    const ledger = daemon.captures.get(manifest.captureId);
    assert(ledger.listRecords().some(r => r.role === 'user'));
    assert.equal(ledger.listRecords().filter(r => r.type === 'file_change').length, 0);
    // Stale legacy files must not replace committed SQLite evidence on reopen.
    fs.appendFileSync(path.join(ledger.dir, 'events.jsonl'), '{"unfinished":');
    const recovered = new Ledger(ledger.dir, ledger.manifest, daemon.captures.database);
    assert.equal(recovered.recoveryGaps.length, 0);
    assert(recovered.listRecords().some(r => r.role === 'user'));
  } finally { await daemon.close(); fs.rmSync(box.root, { recursive: true, force: true }); }
});
