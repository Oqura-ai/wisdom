import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { startDaemon } from '../src/daemon.js';
import { call } from '../src/client.js';
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
    const { captureId } = await call(c, '/captures', { harness: 'claude-code', sessionId: 'pending-resume',
      harnessVersion: '2.1.306 (Claude Code)', workspaceRoot: workspace, source: null });
    const hook = (event: Record<string, unknown>) =>
      call(c, `/captures/${captureId}/observe`, { observationId: randomUUID(), ...observation({ ...common, ...event })! });
    await hook({ hook_event_name: 'SessionStart', transcript_path: native, source: 'resume' });
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
    await call(c, `/captures/${captureId}/close`, { reason: 'exit-0' });

    const ledger = daemon.captures.get(captureId);
    assert.equal(ledger.dir, path.join(data, 'harnesses', 'claude-code', captureId));
    assert.equal(ledger.manifest.sessionId, 'cc-session');
    assert.deepEqual(fs.readFileSync(ledger.mirror), fs.readFileSync(native));
    assert.deepEqual(fs.readFileSync(path.join(ledger.dir, 'subagents', 'agent-a1.jsonl')), fs.readFileSync(subTranscript));

    const changes = await call(c, '/query', { preset: 'changes', captureId });
    const edit = changes.items.find((r: any) => r.path === 'existing.txt');
    assert.equal(edit.attribution, 'observed-during-tool');
    assert.match(edit.patch.text, /\+hello world/);
    assert(changes.items.some((r: any) => r.path === 'leftover.txt' && r.operation === 'create'));
    const failures = await call(c, '/query', { preset: 'failures', captureId });
    assert.equal(failures.items[0].toolName, 'Bash');

    const subagent = await call(c, '/query', { find: 'tools', captureId, where: { agentId: 'a1' } });
    assert.deepEqual(subagent.items.map((r: any) => r.toolName), ['Glob']);
    const main = await call(c, '/query', { find: 'tools', scope: { sessionIds: ['cc-session'] }, where: { agentId: null, harness: 'claude-code' } });
    assert.deepEqual(main.items.map((r: any) => r.toolName), ['Edit', 'Bash']);

    // The clean view reads Claude Code's transcript through its adapter.
    const clean = await call(c, '/query', { preset: 'timeline', captureId, clean: true });
    assert.deepEqual(clean[0], { user: 'Edit existing.txt' });
    assert(clean.some((row: any) => row.assistant === 'calling Edit'));
    assert(clean.some((row: any) => row.tool === 'Bash' && row.output?.error === 'Exit code 1'));
    assert.equal(clean.filter((row: any) => row.tool === 'Edit').length, 1);
  } finally { await daemon.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('a Claude Code hook blocks the tool when Wisdom cannot record it', async () => {
  const { spawnSync } = await import('node:child_process');
  const hook = path.resolve('integrations', 'claude-code', 'hook.mjs');
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'wisdom-nodaemon-'));
  const run = (event: unknown, env: Record<string, string>) => spawnSync(process.execPath, [hook],
    { input: JSON.stringify(event), encoding: 'utf8', env: { ...process.env, WISDOM_DATA_DIR: empty, ...env } });
  try {
    const blocked = run({ ...common, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 't', tool_input: {} }, { WISDOM_CAPTURE_ID: 'x' });
    assert.equal(blocked.status, 2); assert.match(blocked.stderr, /work stays paused/);
    // Without Wisdom's launcher there is no capture, so the hook stays out of the way.
    const unmanaged = spawnSync(process.execPath, [hook], { input: JSON.stringify({ hook_event_name: 'PreToolUse' }), encoding: 'utf8',
      env: Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'WISDOM_CAPTURE_ID')) as Record<string, string> });
    assert.equal(unmanaged.status, 0);
  } finally { fs.rmSync(empty, { recursive: true, force: true }); }
});
