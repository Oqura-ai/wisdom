import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { startDaemon } from '../src/service/daemon.js';
import { call } from '../src/service/client.js';
import { closeSession, observeSession, openSession } from './session.js';
import { cleanOutput, conversation } from '../src/read/conversation.js';

const line = (entry: unknown) => JSON.stringify(entry) + '\n';
// Transcript lines are stamped when written, before the next hook event, as harnesses do.
const stamp = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

test('a turn reads as prompt, thinking, replies, tools, changes and a nested subagent; the ledger renders it whole as prompt, thinking, replies, tools, changes and a nested subagent', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wisdom-conversation-'));
  const workspace = path.join(root, 'project'); fs.mkdirSync(workspace);
  const transcript = path.join(root, 'main.jsonl'); fs.writeFileSync(transcript, '');
  const daemon = await startDaemon(path.join(root, 'data'), 0);
  try {
    const c = daemon.connection;
    const { captureId } = await openSession(c, { harness: 'claude-code', sessionId: 's', workspaceRoot: workspace, source: null });
    const send = (body: Record<string, unknown>) => observeSession(c, captureId, { observationId: randomUUID(), ...body });
    await send({ type: 'session_started', source: transcript, data: { sessionId: 's', source: transcript } });
    await send({ type: 'input', data: { text: 'Write a file and delegate a count' } });
    // Claude Code: thinking recorded without text, then a reply, as separate entries.
    fs.appendFileSync(transcript, line({ type: 'assistant', uuid: 'a1', timestamp: stamp(0), thinkingDurationMs: 750,
      message: { id: 'm1', role: 'assistant', content: [{ type: 'thinking', thinking: '', signature: 'sig' }] } })
      + line({ type: 'assistant', uuid: 'a2', timestamp: stamp(0), message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: "I'll **write** it." }] } }));
    await send({ type: 'tool_started', toolCallId: 'w', toolName: 'Write', data: { input: { file_path: path.join(workspace, 'a.txt'), content: 'x'.repeat(500) } } });
    fs.writeFileSync(path.join(workspace, 'a.txt'), 'hello\n');
    await send({ type: 'tool_finished', toolCallId: 'w', toolName: 'Write', isError: false, data: { response: { type: 'create' }, durationMs: 12 } });
    await send({ type: 'tool_started', toolCallId: 'agent', toolName: 'Agent', data: { input: { description: 'count' } } });
    await send({ type: 'subagent_started', agentId: 'kid', data: { agentType: 'Explore' } });
    await send({ type: 'tool_started', toolCallId: 'g', toolName: 'Glob', agentId: 'kid', data: { input: { pattern: '*.txt' } } });
    await send({ type: 'tool_finished', toolCallId: 'g', toolName: 'Glob', agentId: 'kid', isError: false, data: { response: { filenames: ['a.txt'] } } });
    await send({ type: 'subagent_stopped', agentId: 'kid', data: { agentType: 'Explore', lastAssistantMessage: 'One file.' } });
    await send({ type: 'tool_finished', toolCallId: 'agent', toolName: 'Agent', isError: false, childAgentId: 'kid', data: { response: { content: 'One file.' } } });
    await send({ type: 'agent_settled', data: { lastAssistantMessage: 'Done.' } });
    const input = daemon.captures.get(captureId).listRecords().find(r => r.type === 'input')!;

    const turn: any = conversation(daemon.captures, { captureId, requestId: input.id, maxChars: 200 });
    assert.equal(turn.request.text.text, 'Write a file and delegate a count');
    assert.deepEqual(turn.items.map((i: any) => i.kind), ['thinking', 'text', 'tool', 'tool']);
    const [thinking, reply, write, agent] = turn.items;
    assert.equal(thinking.redacted, true); assert.equal(thinking.durationMs, 750);
    assert.equal(reply.text.text, "I'll **write** it."); assert.equal(reply.source, 'transcript');
    assert.equal(write.status, 'ok'); assert.equal(write.durationMs, 12);
    assert.equal(write.input.truncated, true, 'long bodies are clipped with their full size');
    assert(write.input.totalChars > 200);
    assert.deepEqual(write.changes.map((ch: any) => [ch.operation, ch.path]), [['create', 'a.txt']]);
    assert.match(write.changes[0].patch.text, /\+hello/);
    // The subagent is nested under the call that started it, with its own calls and report.
    assert.equal(agent.subagent.agentType, 'Explore');
    assert.deepEqual(agent.subagent.items.map((i: any) => i.name), ['Glob']);
    assert.equal(agent.subagent.report.text, 'One file.');
    // Transcript text exists, so the hook's final-reply copy is not added again.
    assert(!turn.items.some((i: any) => i.source === 'hook'));
    assert.throws(() => conversation(daemon.captures, { captureId, requestId: 'missing' }), /Request not found/);

    // The ledger renders the same turn whole: no clipping, the write shown once as its patch, the subagent one move away.
    const read = async (request: object): Promise<string> => (await call(c, '/ledger', { capture: captureId, ...request })).text;
    const opened = await read({ open: 't1' });
    assert.match(opened, /^thinking  redacted · 750 ms /m);
    assert.match(opened, /^reply {5}I'll \*\*write\*\* it\.$/m);
    assert.match(opened, /^c1  Write a\.txt · ok · 12 ms · → p1\n {4}input and output repeat p1 · open t1\/c1 to read them$/m);
    assert.match(opened, /^c2  Agent · ok · → a1 \(open a1\)$/m);
    assert(!opened.includes('x'.repeat(500)) && !opened.includes('Done.'));
    assert((await read({ open: 't1/c1' })).includes('x'.repeat(500)), 'opening the call returns its whole input');
    const subagent = await read({ open: 'a1' });
    assert.match(subagent, /^a1 · subagent \(Explore\) in t1 · /);
    assert.match(subagent, /^c1  Glob · ok$/m);
    assert.match(subagent, /^report {4}One file\.$/m);
  } finally { await daemon.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('a turn falls back to the hook reply and reads transcript-only results', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wisdom-conversation-'));
  const workspace = path.join(root, 'project'); fs.mkdirSync(workspace);
  const daemon = await startDaemon(path.join(root, 'data'), 0);
  try {
    const c = daemon.connection;
    const { captureId } = await openSession(c, { harness: 'codex', sessionId: 'pending-start', workspaceRoot: workspace, source: null });
    const send = (body: Record<string, unknown>) => observeSession(c, captureId, { observationId: randomUUID(), sessionId: 's', ...body });
    await send({ type: 'input', data: { text: 'Run it' } });
    await send({ type: 'tool_started', toolCallId: 'b', toolName: 'Bash', data: { input: { command: 'false' } } });
    await send({ type: 'agent_settled', data: { lastAssistantMessage: 'It failed.' } });
    const input = daemon.captures.get(captureId).listRecords().find(r => r.type === 'input')!;
    const turn = await call(c, '/view', { view: 'turn', captureId, requestId: input.id });
    assert.deepEqual(turn.items.map((i: any) => [i.kind, i.status ?? i.source]), [['tool', 'pending'], ['text', 'hook']]);
    assert.equal(turn.items[1].text.text, 'It failed.');
    const opened = (await call(c, '/ledger', { capture: captureId, open: 't1' })).text;
    assert.match(opened, /^c1  Bash · pending\n {4}input {5}\{"command":"false"\}\nreply \(from hook\)  It failed\.$/m);
  } finally { await daemon.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('tool output keeps its meaningful structure; only a recognised duplicate envelope is flattened', () => {
  const ok = { output: 'hello\n', truncated: false, exit_code: 0, wall_time_seconds: 0.2 };
  assert.equal(cleanOutput({ content: [{ type: 'text', text: 'hello\n' }], structuredContent: ok }), 'hello\n');
  const failed = { output: 'boom', truncated: false, exit_code: 1 };
  assert.deepEqual(cleanOutput({ content: [{ type: 'text', text: 'boom' }], structuredContent: failed }), { content: 'boom', structuredContent: failed });
  assert.deepEqual(cleanOutput({ content: [{ type: 'text', text: 'Found' }], structuredContent: { count: 2 }, details: { elapsed: 3 } }),
    { content: 'Found', structuredContent: { count: 2 }, details: { elapsed: 3 } });
  assert.equal(cleanOutput({ role: 'toolResult', content: [{ type: 'text', text: 'native' }] }), 'native');
  assert.equal(cleanOutput('plain'), 'plain');
});
