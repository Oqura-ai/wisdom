import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { startDaemon } from '../src/daemon.js';
import { call } from '../src/client.js';
import { closeSession, observeSession, openSession } from './session.js';
import { pi } from '../src/harnesses/pi/adapter.js';
import { claudeCode } from '../src/harnesses/claude-code/adapter.js';
import { codex } from '../src/harnesses/codex/adapter.js';

const lines = (...entries: unknown[]) => entries.map(e => JSON.stringify(e)).join('\n') + '\n';

test('each adapter reports usage in additive buckets (fresh input excludes cache)', () => {
  assert.deepEqual(pi.nativeEntry({ type: 'message', id: 'p1', message: { role: 'assistant', model: 'm', provider: 'x',
    usage: { input: 10, output: 5, cacheRead: 100, cacheWrite: 7, reasoning: 2, totalTokens: 122, cost: { total: 0.5 } } } }).usage,
    [{ key: 'p1', scope: 'call', model: 'm', provider: 'x', input: 10, cacheRead: 100, cacheWrite: 7, output: 5, reasoning: 2, costUsd: 0.5 }]);
  assert.equal(pi.nativeEntry({ type: 'usage', id: 'warm', kind: 'cache_warm', model: 'm', usage: { input: 0, output: 0, cacheRead: 50, cacheWrite: 0 } }).usage![0].cacheRead, 50);
  const claude = claudeCode.nativeEntry({ type: 'assistant', message: { id: 'msg', model: 'haiku', usage: { input_tokens: 2,
    cache_read_input_tokens: 300, cache_creation_input_tokens: 40, output_tokens: 9, output_tokens_details: { thinking_tokens: 4 } } } }).usage![0];
  assert.deepEqual([claude.key, claude.input, claude.cacheRead, claude.cacheWrite, claude.output, claude.reasoning], ['msg', 2, 300, 40, 9, 4]);
  assert.deepEqual(claudeCode.nativeEntry({ type: 'cost-state', totalCostUSD: 0.25 }).usage![0], { key: 'cost-state', scope: 'session-total',
    input: 0, cacheRead: 0, cacheWrite: 0, output: 0, costUsd: 0.25 });
  // Codex's input_tokens includes the cached and cache-write parts.
  const openai = codex.nativeEntry({ type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { total_tokens: 500 },
    last_token_usage: { input_tokens: 400, cached_input_tokens: 300, cache_write_input_tokens: 60, output_tokens: 20, reasoning_output_tokens: 8 } } } }).usage![0];
  assert.deepEqual([openai.key, openai.input, openai.cacheRead, openai.cacheWrite, openai.output, openai.reasoning], ['total:500', 40, 300, 60, 20, 8]);
  assert.equal(codex.nativeEntry({ type: 'turn_context', payload: { model: 'gpt-x' } }).model, 'gpt-x');
  assert.deepEqual(codex.nativeEntry({ type: 'event_msg', payload: { type: 'token_count', info: null } }).usage, []);
});

test('stats count each response once, include subagents, exclude resumed history, and hide helper agents', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wisdom-usage-'));
  const workspace = path.join(root, 'project'); fs.mkdirSync(workspace);
  const transcript = path.join(root, 'main.jsonl');
  const subTranscript = path.join(root, 'agent.jsonl');
  const daemon = await startDaemon(path.join(root, 'data'), 0);
  try {
    const c = daemon.connection;
    const assistant = (id: string, timestamp: string, input: number) => ({ type: 'assistant', uuid: randomUUID(), timestamp,
      message: { id, model: 'haiku', role: 'assistant', content: [{ type: 'text', text: 'hi' }],
        usage: { input_tokens: input, cache_read_input_tokens: 100, cache_creation_input_tokens: 10, output_tokens: 5 } } });
    // Resumed history (before the capture) and one response written twice (two content blocks).
    fs.writeFileSync(transcript, lines(assistant('old', '2000-01-01T00:00:00.000Z', 999)));
    const { captureId } = await openSession(c, { harness: 'claude-code', sessionId: 's', workspaceRoot: workspace, source: null });
    const send = (body: Record<string, unknown>) => observeSession(c, captureId, { observationId: randomUUID(), ...body });
    await send({ type: 'session_started', source: transcript, data: { sessionId: 's', source: transcript } });
    await send({ type: 'input', data: { text: 'go' } });
    const now = new Date().toISOString();
    fs.appendFileSync(transcript, lines(assistant('new', now, 3), assistant('new', now, 3), { type: 'cost-state', totalCostUSD: 0.01 }));
    fs.writeFileSync(subTranscript, lines(assistant('sub', now, 1)));
    await send({ type: 'subagent_stopped', agentId: 'kid', data: { agentType: 'Explore', transcriptPath: subTranscript } });
    // A Claude Code helper: no type, no transcript. Recorded, but no gap and not a subagent.
    await send({ type: 'subagent_stopped', agentId: 'helper', data: { agentType: '', transcriptPath: path.join(root, 'none.jsonl'), lastAssistantMessage: 'commit this' } });
    await send({ type: 'agent_settled', data: { lastAssistantMessage: 'done' } });
    await closeSession(c, captureId);

    const stats = await call(c, '/view', { view: 'project', workspaceRoot: workspace });
    const tokens = stats.sessions[0].tokens;
    assert.deepEqual([tokens.calls, tokens.input, tokens.cacheRead, tokens.cacheWrite, tokens.output, tokens.costUsd], [2, 4, 200, 20, 10, 0.01]);
    assert.equal(tokens.total, 4 + 200 + 20 + 10);
    assert.equal(stats.sessions[0].subagents, 0, 'only agents that did work count; neither stop event did any');
    // The agent's glance counts the same tokens. It lists every subagent with recorded evidence (here
    // a transcript and a reply, but no tool work), so nothing is hidden; the helper stays excluded.
    const glance = (await call(c, '/ledger', { capture: captureId, glance: true })).text;
    assert.match(glance, /· 1 subagent · 234 tokens · \$0\.0100 reported$/m);
    assert.match(glance, /^ {4}subagent a1 \(Explore\) · no tool calls · no changes$/m);
    assert(!/subagent a2/.test(glance), 'the helper agent is not listed');
    const records = daemon.captures.get(captureId).listRecords();
    assert(!records.some(r => r.type === 'gap' && r.summary.includes('helper')));
    assert.equal(records.find(r => r.type === 'subagent_stopped' && r.agentId === 'helper')!.internalAgent, true);
    assert.equal(records.find(r => r.type === 'agent_settled')!.summary, 'done');
    // Usage is linked to the request whose window it arrived in.
    const input = records.find(r => r.type === 'input')!;
    assert(records.filter(r => r.type === 'usage' && !r.beforeCapture).every(r => r.requestId === input.id));
    assert.equal(stats.models[0].model, 'haiku');
  } finally { await daemon.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('usage is indexed live, linked to its requests, and not indexed again after a restart', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wisdom-usage-restart-'));
  const workspace = path.join(root, 'project'); fs.mkdirSync(workspace);
  const transcript = path.join(root, 'main.jsonl'); fs.writeFileSync(transcript, '');
  const data = path.join(root, 'data');
  let daemon = await startDaemon(data, 0);
  try {
    const { captureId } = await openSession(daemon.connection, { harness: 'pi', sessionId: 's', workspaceRoot: workspace, source: transcript });
    const send = (body: Record<string, unknown>) => observeSession(daemon.connection, captureId, { observationId: randomUUID(), ...body });
    const reply = (id: string, input: number) => ({ type: 'message', id, parentId: null, timestamp: new Date().toISOString(),
      message: { role: 'assistant', model: 'm', content: [{ type: 'text', text: id }], usage: { input, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0.001 } } } });
    await send({ type: 'input', data: { text: 'first' } });
    fs.appendFileSync(transcript, lines(reply('a', 10)));
    await send({ type: 'input', data: { text: 'second' } });
    fs.appendFileSync(transcript, lines(reply('b', 20)));
    await send({ type: 'agent_settled' });
    await closeSession(daemon.connection, captureId);
    const records = daemon.captures.get(captureId).listRecords();
    const inputs = records.filter(r => r.type === 'input');
    assert.deepEqual(records.filter(r => r.type === 'usage').map(r => [r.usage!.input, r.requestId]), [[10, inputs[0].id], [20, inputs[1].id]]);
    await daemon.close();
    daemon = await startDaemon(data, 0); // A restart reads the same records; nothing is indexed again.
    assert.equal(daemon.captures.get(captureId).listRecords().filter(r => r.type === 'usage').length, 2);
    const stats = await call(daemon.connection, '/view', { view: 'project', workspaceRoot: workspace });
    assert.equal(stats.sessions[0].tokens.costUsd, 0.002);
  } finally { await daemon.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
