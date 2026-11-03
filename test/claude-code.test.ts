import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { startDaemon } from '../src/daemon.js';
import { call, connectionAt } from '../src/client.js';
import { observation } from '../src/harnesses/claude-code/hook.js';
import { claudeCode } from '../src/harnesses/claude-code/adapter.js';

// Shapes recorded from Claude Code 2.1.306 hooks and transcripts (phase 0).
const common = { session_id: 'cc-session', cwd: 'x', permission_mode: 'default' };
const line = (entry: unknown) => JSON.stringify(entry) + '\n';
const assistantCall = (uuid: string, id: string, name: string, input: unknown) => line({ type: 'assistant', uuid, parentUuid: null,
  message: { role: 'assistant', content: [{ type: 'text', text: `calling ${name}` }, { type: 'tool_use', id, name, input }] } });

test('Claude Code hook payloads map to neutral observations; unknown events are ignored', () => {
  assert.deepEqual(observation({ ...common, hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_use_id: 'toolu_1',
    tool_input: { file_path: 'C:/p/a.txt' } }), { type: 'tool_started', toolCallId: 'toolu_1', toolName: 'Edit',
    data: { input: { file_path: 'C:/p/a.txt' } } });
  const failure: any = observation({ ...common, hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_use_id: 'toolu_2',
    error: 'Exit code 1', is_interrupt: false, duration_ms: 5 });
  assert.equal(failure.type, 'tool_finished'); assert.equal(failure.isError, true); assert.equal(failure.data.error, 'Exit code 1');
  const sub: any = observation({ ...common, hook_event_name: 'PreToolUse', tool_name: 'Glob', tool_use_id: 'toolu_3',
    agent_id: 'a1', agent_type: 'Explore', tool_input: { pattern: '*' } });
  assert.equal(sub.agentId, 'a1');
  assert.equal(observation({ ...common, hook_event_name: 'PostToolBatch' }), undefined);
});

test('Claude Code transcript lines become neutral messages, one per parallel tool result', () => {
  const assistant = claudeCode.nativeEntry(JSON.parse(assistantCall('u1', 'toolu_1', 'Read', { file_path: 'a' })));
  assert.equal(assistant.id, 'u1');
  assert.deepEqual((assistant.messages[0].content as any[])[1], { type: 'toolCall', id: 'toolu_1', name: 'Read', arguments: { file_path: 'a' } });
  const results = claudeCode.nativeEntry({ type: 'user', uuid: 'u2', parentUuid: 'u1', message: { role: 'user', content: [
    { type: 'tool_result', tool_use_id: 'toolu_1', content: 'one' },
    { type: 'tool_result', tool_use_id: 'toolu_2', content: 'two', is_error: true }] } });
  assert.deepEqual(results.messages.map(m => [m.role, m.toolCallId, m.isError]), [['toolResult', 'toolu_1', false], ['toolResult', 'toolu_2', true]]);
  const other = claudeCode.nativeEntry({ type: 'attachment', uuid: 'u3', attachment: {} });
  assert.deepEqual(other.messages, []); assert.equal(other.kind, 'attachment');
  assert.equal(claudeCode.toolTarget('NotebookEdit', { notebook_path: 'n.ipynb' }), 'n.ipynb');
  assert(claudeCode.isDirectFileTool('Edit')); assert(!claudeCode.isDirectFileTool('Bash'));
  assert.deepEqual(['Write', 'Edit', 'Read', 'Bash', 'Unknown'].map(claudeCode.toolView), ['patch', 'patch', 'file', 'full', 'full']);
});

test('a Claude Code capture records hooks, patches, subagents and its transcript in its own harness directory', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wisdom-cc-'));
  const workspace = path.join(root, 'project'); fs.mkdirSync(workspace);
  const data = path.join(root, 'data');
  const native = path.join(root, 'claude', 'cc-session.jsonl'); fs.mkdirSync(path.dirname(native));
  const subTranscript = path.join(root, 'claude', 'agent-a1.jsonl');
  fs.writeFileSync(native, ''); fs.writeFileSync(subTranscript, line({ type: 'user', uuid: 's1', isSidechain: true,
    message: { role: 'user', content: 'list files' } }));
  fs.writeFileSync(path.join(workspace, 'existing.txt'), 'hello\n');
  const daemon = await startDaemon(data, 0);
  try {
    const c = daemon.connection;
    // As the hook process does: every event names its session; a subagent's names its parent's.
    const hook = (event: Record<string, unknown>) => call(c, '/observe', { harness: 'claude-code', harnessVersion: '2.1.306 (Claude Code)', cwd: workspace,
      observation: { observationId: randomUUID(), sessionId: common.session_id, ...(event.agent_id ? {} : { source: native }), ...observation({ ...common, ...event })! } });
    const { captureId } = await hook({ hook_event_name: 'SessionStart', transcript_path: native, source: 'resume' });
    await hook({ hook_event_name: 'UserPromptSubmit', prompt: 'Edit existing.txt' });
    fs.appendFileSync(native, line({ type: 'user', uuid: 'u0', message: { role: 'user', content: 'Edit existing.txt' } }));

    await hook({ hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_use_id: 'toolu_e',
      tool_input: { file_path: path.join(workspace, 'existing.txt'), old_string: 'hello', new_string: 'hello world' } });
    fs.writeFileSync(path.join(workspace, 'existing.txt'), 'hello world\n');
    await hook({ hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_use_id: 'toolu_e', tool_response: { filePath: 'existing.txt' } });
    fs.appendFileSync(native, assistantCall('u1', 'toolu_e', 'Edit', { file_path: 'existing.txt' })
      + line({ type: 'user', uuid: 'u2', parentUuid: 'u1', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_e', content: 'updated' }] } }));

    await hook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'toolu_b', tool_input: { command: 'make' } });
    fs.writeFileSync(path.join(workspace, 'leftover.txt'), 'partial\n');
    await hook({ hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_use_id: 'toolu_b', error: 'Exit code 1' });

    await hook({ hook_event_name: 'SubagentStart', agent_id: 'a1', agent_type: 'Explore' });
    await hook({ hook_event_name: 'PreToolUse', tool_name: 'Glob', tool_use_id: 'toolu_g', agent_id: 'a1', tool_input: { pattern: '*' } });
    await hook({ hook_event_name: 'PostToolUse', tool_name: 'Glob', tool_use_id: 'toolu_g', agent_id: 'a1', tool_response: { filenames: [] } });
    await hook({ hook_event_name: 'SubagentStop', agent_id: 'a1', agent_type: 'Explore', agent_transcript_path: subTranscript });
    await hook({ hook_event_name: 'Stop', last_assistant_message: 'Done' });
    await hook({ hook_event_name: 'SessionEnd', reason: 'exit' });

    const ledger = daemon.captures.get(captureId);
    assert.equal(ledger.dir, path.join(data, 'harnesses', 'claude-code', captureId));
    assert.equal(ledger.manifest.sessionId, 'cc-session');
    assert.deepEqual(fs.readFileSync(ledger.mirror), fs.readFileSync(native));
    assert.deepEqual(fs.readFileSync(path.join(ledger.dir, 'subagents', 'agent-a1.jsonl')), fs.readFileSync(subTranscript));

    const read = async (request: object): Promise<string> => (await call(c, '/ledger', { capture: captureId, ...request })).text;
    const glance = await read({ glance: true });
    assert.match(glance, /^resume with: wisdom resume cc-session$/m);
    assert.match(glance, /^t1  in {8}Edit existing\.txt$/m);
    assert.match(glance, /^ {4}2 tool calls · 1 failed · changed existing\.txt, leftover\.txt$/m);
    assert.match(glance, /^ {4}subagent a1 \(Explore\) · 1 tool call · no changes$/m);

    // The turn reads Claude Code's transcript through its adapter; the edit is shown once, as its patch.
    const turn = await read({ open: 't1' });
    assert.match(turn, /^reply {5}calling Edit$/m);
    assert.match(turn, /^c1  Edit existing\.txt · ok · → p1$/m);
    assert.match(turn, /^c2  Bash · failed · → p2\n {4}input {5}\{"command":"make"\}\n {4}output {4}Exit code 1$/m);
    assert.match(turn, /^p1  existing\.txt · modify · \+1 −1 · observed during c1\n[\s\S]*^ {4}\+hello world$/m);
    assert.match(turn, /^p2  leftover\.txt · create · \+1 −0 · observed during c2$/m);
    assert.equal(turn.match(/^c\d+ /gm)?.length, 2);

    const subagent = await read({ open: 'a1' });
    assert.match(subagent, /^a1 · subagent \(Explore\) in t1 · /);
    assert.match(subagent, /^c1  Glob · ok$/m);
  } finally { await daemon.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('with its daemon down, a Claude Code hook keeps the event, starts the daemon and never blocks', async () => {
  const { spawnSync } = await import('node:child_process');
  const hook = path.resolve('integrations', 'claude-code', 'hook.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wisdom-nodaemon-'));
  const data = path.join(root, 'data'); fs.mkdirSync(data);
  const run = (event: unknown) => spawnSync(process.execPath, [hook, data], { input: JSON.stringify(event), encoding: 'utf8' });
  const kept = run({ ...common, cwd: root, hook_event_name: 'UserPromptSubmit', prompt: 'while down' });
  assert.equal(kept.status, 1, 'exit code 1 warns; 2 would block'); assert.match(kept.stderr, /Wisdom kept this UserPromptSubmit/);
  const connection = connectionAt(data);
  try {
    // The daemon the hook started has read the spool by the time the hook returns.
    let text = '';
    for (let i = 0; i < 100 && !/while down/.test(text); i++) {
      await new Promise(resolve => setTimeout(resolve, 100));
      text = (await call(connection, '/ledger', { capture: common.session_id, glance: true }).catch(() => ({ text: '' }))).text;
    }
    assert.match(text, /^t1  in {8}while down$/m);
    const live = run({ ...common, cwd: root, hook_event_name: 'Stop', last_assistant_message: 'ok' });
    assert.equal(live.status, 0); assert.equal(live.stderr, '');
  } finally {
    await call(connection, '/stop', {});
    for (let i = 0; i < 100 && fs.existsSync(path.join(data, 'daemon.json')); i++) await new Promise(resolve => setTimeout(resolve, 100));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
