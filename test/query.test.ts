import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { startDaemon } from '../src/daemon.js';
import { call } from '../src/client.js';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wisdom-query-'));
  const workspace = path.join(root, 'project'); fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(workspace, 'auth.ts'), 'export const enabled = false;\n');
  return { root, workspace, data: path.join(root, 'data') };
}
const observation = (type: string, extra = {}) => ({ observationId: randomUUID(), type, ...extra });

test('one query returns interaction surfaces, exact edit patches and outputs without call arguments', async () => {
  const box = fixture(); const daemon = await startDaemon(box.data, 0);
  try {
    const c = daemon.connection;
    const { captureId } = await call(c, '/captures', { workspaceRoot: box.workspace, piSessionId: 's', source: null });
    const send = (type: string, extra = {}) => call(c, `/captures/${captureId}/observe`, observation(type, extra));
    const input = await send('input', { data: { text: 'Enable authentication, preserving the API.' } });
    await send('message', { data: { role: 'assistant', content: [
      { type: 'thinking', thinking: 'DO_NOT_DISCLOSE' }, { type: 'text', text: 'I will update the flag.' }] } });
    await send('tool_started', { toolCallId: 'edit-1', toolName: 'edit', data: { input: { path: 'auth.ts', secretArgument: 'DO_NOT_DISCLOSE' } } });
    fs.writeFileSync(path.join(box.workspace, 'auth.ts'), 'export const enabled = true;\n');
    await send('tool_finished', { toolCallId: 'edit-1', toolName: 'edit', isError: true, data: { content: 'Changed file, but validation failed.' } });
    const result = await call(c, '/query', { preset: 'interaction-review', captureId });
    assert.equal(result.items.length, 1);
    const interaction = result.items[0];
    assert.equal(interaction.id, input.id);
    assert.match(interaction.content.text, /preserving the API/);
    assert.equal(interaction.messages.items[0].content.text, 'I will update the flag.');
    assert.match(interaction.changes.items[0].patch.text, /\+export const enabled = true/);
    assert.equal(interaction.outputs.items[0].isError, true);
    assert.equal(interaction.changes.items[0].evidence.requestId, input.id);
    assert.equal(interaction.changes.items[0].linkBasis, 'recorded-parent');
    assert(!JSON.stringify(result).includes('DO_NOT_DISCLOSE'));
    assert(!('tools' in interaction));
    await send('message', { data: { role: 'toolResult', content: [{ type: 'text', text: 'TOOL_OUTPUT_NOT_INTENT' }] } });
    const intent = await call(c, '/query', { preset: 'intent', captureId });
    assert(!JSON.stringify(intent).includes('TOOL_OUTPUT_NOT_INTENT'));

    // Start at the leaf using path + outcome, and fetch ancestors in the same call.
    const leaves = await call(c, '/query', { find: 'changes', scope: { workspaceRoot: box.workspace },
      where: { path: 'auth.ts', 'tool.isError': true }, select: ['path', 'patch'],
      include: { request: { select: ['content'] }, tools: { select: ['toolName', 'status'] }, outputs: { select: ['content'] } } });
    assert.equal(leaves.items.length, 1);
    assert.equal(leaves.items[0].request.items[0].id, input.id);
    assert.equal(leaves.items[0].tools.items[0].status, 'error');
    assert.match(leaves.items[0].outputs.items[0].content.text, /validation failed/);
    const failed = await call(c, '/query', { preset: 'failures', captureId });
    assert.equal(failed.items[0].changes.items[0].path, 'auth.ts');
  } finally { await daemon.close(); fs.rmSync(box.root, { recursive: true, force: true }); }
});

test('scope isolates projects, session scope spans captures, pagination freezes related evidence', async () => {
  const box = fixture(); const daemon = await startDaemon(box.data, 0);
  try {
    const c = daemon.connection;
    const other = path.join(box.root, 'other'); fs.mkdirSync(other);
    const captures: string[] = [];
    for (const [workspaceRoot, piSessionId] of [[box.workspace, 'same-session'], [box.workspace, 'same-session'], [other, 'other-session']]) {
      const m = await call(c, '/captures', { workspaceRoot, piSessionId, source: null }); captures.push(m.captureId);
      await call(c, `/captures/${m.captureId}/observe`, observation('input', { data: { text: workspaceRoot } }));
      await call(c, `/captures/${m.captureId}/observe`, observation('tool_started', { toolCallId: 'shared-id', toolName: 'bash' }));
    }
    const base = { find: 'tools', scope: { sessionIds: ['same-session'], workspaceRoot: box.workspace },
      select: ['status'], include: { outputs: { select: ['content'] } }, limit: 1 };
    const first = await call(c, '/query', base);
    assert.equal(first.items[0].status, 'pending-or-missing');
    assert(first.nextCursor);
    await call(c, `/captures/${captures[1]}/observe`, observation('tool_finished', { toolCallId: 'shared-id', toolName: 'bash', isError: false, data: { content: 'late result' } }));
    const second = await call(c, '/query', { ...base, cursor: first.nextCursor });
    assert.equal(second.readVersion, first.readVersion);
    assert.equal(second.items[0].captureId, captures[1]);
    assert.equal(second.items[0].outputs.items.length, 0);
    assert.equal(second.items[0].status, 'pending-or-missing');
    assert.equal(second.nextCursor, null);
    const latest = await call(c, '/query', { ...base, limit: 10 });
    assert.equal(latest.items.length, 2);
    assert.equal(latest.items[1].status, 'completed');
    const workspace = await call(c, '/query', { preset: 'intent', scope: { workspaceRoot: other } });
    assert.equal(workspace.items.length, 1);
    assert.equal(workspace.items[0].captureId, captures[2]);
    await assert.rejects(call(c, '/query', { ...base, where: { toolName: 'read' }, cursor: first.nextCursor }), /Cursor/);
  } finally { await daemon.close(); fs.rmSync(box.root, { recursive: true, force: true }); }
});

test('nested continuations and evidence budgets are explicit; malformed queries are rejected', async () => {
  const box = fixture(); const daemon = await startDaemon(box.data, 0);
  try {
    const c = daemon.connection;
    const { captureId } = await call(c, '/captures', { workspaceRoot: box.workspace, piSessionId: 's', source: null });
    await call(c, `/captures/${captureId}/observe`, observation('input', { data: { text: 'Review changes.' } }));
    for (let i = 0; i < 3; i++) {
      await call(c, `/captures/${captureId}/observe`, observation('tool_started', { toolCallId: `t${i}`, toolName: 'read' }));
      await call(c, `/captures/${captureId}/observe`, observation('tool_finished', { toolCallId: `t${i}`, toolName: 'read', data: { content: 'x'.repeat(300) } }));
    }
    const result = await call(c, '/query', { find: 'requests', captureId, select: ['content'],
      include: { outputs: { select: ['content'], limit: 1 } }, maxChars: 100 });
    assert.equal(result.budget.contentCharsUsed, 100);
    const output = result.items[0].outputs;
    assert.equal(output.truncated, true); assert(output.nextQuery);
    assert.equal(output.items[0].content.truncated, true);
    const continued = await call(c, '/query', output.nextQuery);
    assert.notEqual(continued.items[0].id, output.items[0].id);
    assert.equal(continued.readVersion, result.readVersion);
    const inspected = await call(c, '/query', output.items[0].content.inspect);
    assert(inspected.sections.data.available);
    for (const bad of [
      { find: 'events' }, { find: 'events', captureId, where: { unknown: 1 } },
      { find: 'events', captureId, select: ['typo'] }, { find: 'events', captureId, include: { imaginary: {} } },
      { find: 'events', captureId, include: { tools: { limit: 999 } } },
      { find: 'events', captureId, where: { text: { like: '%' } } },
      { find: 'events', captureId, where: { text: { contains: [1] } } },
    ]) await assert.rejects(call(c, '/query', bad));
    const injected = await call(c, '/query', { find: 'events', captureId, where: { id: "' OR 1=1 --" } });
    assert.equal(injected.items.length, 0);
    const vocab = await call(c, '/query', { op: 'describe' });
    assert(vocab.relations.includes('outputs'));
    // Missing evidence is distinct from an empty successful output.
    const record = daemon.captures.get(captureId).listRecords().find(r => r.type === 'tool_finished')!;
    fs.unlinkSync(path.join(box.data, 'sessions', captureId, 'payloads', record.dataRef!));
    const missing = await call(c, '/query', { find: 'outputs', captureId, where: { id: record.id }, select: ['content'] });
    assert.equal(missing.items[0].content.available, false); assert.equal(missing.issues.length, 1);
  } finally { await daemon.close(); fs.rmSync(box.root, { recursive: true, force: true }); }
});

test('SQLite captures survive restart without reading historical JSONL manifests', async () => {
  const box = fixture(); let daemon = await startDaemon(box.data, 0);
  try {
    const { captureId } = await call(daemon.connection, '/captures', { workspaceRoot: box.workspace, piSessionId: 's', source: null });
    const request = await call(daemon.connection, `/captures/${captureId}/observe`, observation('input', { data: { text: 'Keep this record' } }));
    await call(daemon.connection, `/captures/${captureId}/close`, {});
    const dir = path.join(box.data, 'sessions', captureId);
    fs.writeFileSync(path.join(dir, 'manifest.json'), 'invalid old manifest');
    fs.writeFileSync(path.join(dir, 'events.jsonl'), '{"unfinished":');
    const before = await call(daemon.connection, '/query', { preset: 'timeline', captureId });
    await daemon.close(); daemon = await startDaemon(box.data, 0);
    const after = await call(daemon.connection, '/query', { preset: 'timeline', captureId });
    assert.deepEqual(after.items, before.items);
    assert.equal(after.readVersion, before.readVersion);
    assert(after.items.some((r: any) => r.id === request.id));
    assert.equal(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'), 'invalid old manifest');
    assert.equal(daemon.captures.database.sql.prepare('PRAGMA integrity_check').get()!.integrity_check, 'ok');
  } finally { await daemon.close(); fs.rmSync(box.root, { recursive: true, force: true }); }
});

test('a result and its edit retain the original request when a new input arrives during a tool', async () => {
  const box = fixture(); const daemon = await startDaemon(box.data, 0);
  try {
    const c = daemon.connection;
    const { captureId } = await call(c, '/captures', { workspaceRoot: box.workspace, piSessionId: 's', source: null });
    const send = (type: string, extra = {}) => call(c, `/captures/${captureId}/observe`, observation(type, extra));
    const first = await send('input', { data: { text: 'Enable the flag' } });
    await send('tool_started', { toolCallId: 'slow', toolName: 'edit', data: { input: { path: 'auth.ts' } } });
    const second = await send('input', { data: { text: 'Next, document the flag' } });
    fs.writeFileSync(path.join(box.workspace, 'auth.ts'), 'export const enabled = true;\n');
    await send('tool_finished', { toolCallId: 'slow', toolName: 'edit', isError: false, data: { content: 'Done' } });
    const result = await call(c, '/query', { preset: 'interaction-review', captureId });
    assert.equal(result.items[0].id, first.id);
    assert.equal(result.items[0].outputs.items.length, 1);
    assert.equal(result.items[0].changes.items.length, 1);
    assert.equal(result.items[1].id, second.id);
    assert.equal(result.items[1].outputs.items.length, 0);
    assert.equal(result.items[1].changes.items.length, 0);
  } finally { await daemon.close(); fs.rmSync(box.root, { recursive: true, force: true }); }
});
