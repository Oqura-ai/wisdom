import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { startDaemon } from '../src/daemon.js';
import { call } from '../src/client.js';
import { cleanEntries } from '../src/clean-query.js';

test('clean HTTP returns exact dialogue and paired tools without metadata or duplicate source copies', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wisdom-clean-'));
  const workspace = path.join(root, 'project'); fs.mkdirSync(workspace);
  const source = path.join(root, 'native.jsonl'); fs.writeFileSync(source, '');
  const daemon = await startDaemon(path.join(root, 'data'), 0);
  try {
    const c = daemon.connection;
    const { captureId } = await call(c, '/captures', { workspaceRoot: workspace, piSessionId: 's', source });
    const send = (type: string, fields = {}) => call(c, `/captures/${captureId}/observe`, { type, observationId: randomUUID(), ...fields });
    await send('input', { data: { text: 'Print hello.\nKeep this newline.' } });
    await send('tool_started', { toolCallId: 't', toolName: 'bash', data: { input: { command: 'echo hello', timeout: 10 } } });
    await send('tool_finished', { toolCallId: 't', toolName: 'bash', isError: false,
      data: { content: [{ type: 'text', text: 'hello\n' }], details: {},
        structuredContent: { output: 'hello\n', truncated: false, exit_code: 0, wall_time_seconds: 0.2 } } });
    const native = [
      ...Array.from({ length: 110 }, (_, i) => ({ id: `admin${i}`, type: 'model_change' })),
      { id: 'u', message: { role: 'user', content: 'Print hello.\nKeep this newline.' } },
      { id: 'a', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'PRIVATE' }, { type: 'toolCall', id: 't', name: 'bash', arguments: { command: 'echo hello' } }] } },
      { id: 'o', message: { role: 'toolResult', toolCallId: 't', toolName: 'bash', content: [{ type: 'text', text: 'hello\n' }] } },
      { id: 'done', message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }], usage: { tokens: 123 } } },
    ];
    fs.writeFileSync(source, native.map(row => JSON.stringify(row)).join('\n') + '\n');
    daemon.captures.get(captureId).syncSource();
    const request = { preset: 'interaction-review', captureId, clean: true };
    const expected = [
      { user: 'Print hello.\nKeep this newline.' },
      { tool: 'bash', input: { command: 'echo hello', timeout: 10 }, output: 'hello\n' },
      { assistant: 'Done.' },
    ];
    assert.deepEqual(await call(c, '/query', request), expected);
    assert.deepEqual(await call(c, '/query', { ...request, preset: 'intent' }), [expected[0], expected[2]]);
    await assert.rejects(call(c, '/query', { ...request, limit: 1 }), /Nothing was truncated/);
    await assert.rejects(call(c, '/query', { ...request, maxChars: 100 }), /Nothing was truncated/);
    await send('input', { data: { text: 'Print hello.\nKeep this newline.' } });
    const repeated = await call(c, '/query', request);
    assert.equal(repeated.filter((r: any) => r.user).length, 2);
    await assert.rejects(call(c, '/query', { ...request, preset: 'changes' }), /Clean mode supports/);
  } finally { await daemon.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('clean presentation retains structured outputs, nontext blocks and pending calls', () => {
  const common = { captureId: 'c', sessionId: 's' };
  const entries = [
    { ...common, id: 'start', type: 'tool_started', toolCallId: 't', toolName: 'mcp', body: { input: { query: 'x' } } },
    { ...common, id: 'end', type: 'tool_finished', toolCallId: 't', body: { content: [{ type: 'text', text: 'Found' }], structuredContent: { count: 2 }, details: { elapsed: 3 } } },
    { ...common, id: 'pending', type: 'tool_started', toolCallId: 'p', toolName: 'read', body: { input: { path: 'a.ts' } } },
    { ...common, id: 'image', type: 'message', body: { role: 'assistant', content: [{ type: 'image', data: 'abc', mimeType: 'image/png' }] } },
  ];
  assert.deepEqual(cleanEntries(entries), [
    { tool: 'mcp', input: { query: 'x' }, output: { content: 'Found', structuredContent: { count: 2 }, details: { elapsed: 3 } } },
    { tool: 'read', input: { path: 'a.ts' }, output: null },
    { assistant: [{ type: 'image', data: 'abc', mimeType: 'image/png' }] },
  ]);
});

test('native-only calls and results are paired without needing hook records', () => {
  const common = { captureId: 'c', sessionId: 's', type: 'source_record' };
  assert.deepEqual(cleanEntries([
    { ...common, id: 'a', body: { message: { role: 'assistant', content: [{ type: 'toolCall', id: 't', name: 'read', arguments: { path: 'a' } }] } } },
    { ...common, id: 'o', body: { message: { role: 'toolResult', toolCallId: 't', toolName: 'read', content: [{ type: 'text', text: 'file contents' }] } } },
  ]), [{ tool: 'read', input: { path: 'a' }, output: 'file contents' }]);
});
