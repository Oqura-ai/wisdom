import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createLedgerMcp } from '../src/mcp.js';
import { startDaemon } from '../src/daemon.js';
import { call } from '../src/client.js';
import { codex } from '../src/harnesses/codex/adapter.js';
import { observation, toolError } from '../src/harnesses/codex/hook.js';
import { hookEvents, hookSettings, inspectionArgs, requireTrustedHooks } from '../src/harnesses/codex/launch.js';

const line = (type: string, payload: unknown) => JSON.stringify({ timestamp: '2026-10-23T00:00:00Z', type, payload }) + '\n';
const message = (id: string, role: string, text: string) => line('response_item', {
  type: 'message', id, role, content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text }],
});

test('Codex normalizes response items without duplicating event messages or exposing reasoning', () => {
  assert.deepEqual(codex.nativeEntry(JSON.parse(message('m', 'assistant', 'Done'))).messages,
    [{ role: 'assistant', content: [{ type: 'text', text: 'Done' }] }]);
  const call = codex.nativeEntry({ type: 'response_item', payload: { type: 'function_call', id: 'f',
    call_id: 'call-1', name: 'exec_command', arguments: '{"cmd":"echo hello"}' } });
  assert.deepEqual(call.messages[0].content, [{ type: 'toolCall', id: 'call-1', name: 'exec_command', arguments: { cmd: 'echo hello' } }]);
  const custom = codex.nativeEntry({ type: 'response_item', payload: { type: 'custom_tool_call',
    call_id: 'patch-1', name: 'apply_patch', input: '*** Begin Patch' } });
  assert.equal((custom.messages[0].content as any[])[0].arguments, '*** Begin Patch');
  assert.equal(codex.nativeEntry({ type: 'response_item', payload: { type: 'function_call_output', call_id: 'c', output: 'ok' } }).messages[0].toolCallId, 'c');
  for (const raw of [{ type: 'event_msg', payload: { type: 'agent_message', message: 'Done' } }, { type: 'future-record' }]) {
    assert.deepEqual(codex.nativeEntry(raw).messages, []);
  }
  // Encrypted reasoning is recorded as redacted thinking, never as surface text.
  assert.deepEqual(codex.nativeEntry({ type: 'response_item', payload: { type: 'reasoning', summary: [], encrypted_content: 'opaque' } }).messages,
    [{ role: 'assistant', content: [{ type: 'thinking', thinking: '', redacted: true }] }]);
  assert.equal((codex.nativeEntry({ type: 'response_item', payload: { type: 'reasoning', summary: [{ type: 'summary_text', text: 'Plan' }] } })
    .messages[0].content as any[])[0].thinking, 'Plan');
  assert.equal(codex.isDirectFileTool('apply_patch'), false);
  assert.deepEqual(['apply_patch', 'exec_command', 'Bash'].map(codex.toolView), ['patch', 'full', 'full']);
});

test('Codex hook mapping preserves turn identity and unknown outcomes', () => {
  const input: any = observation({ hook_event_name: 'UserPromptSubmit', turn_id: 'turn-a', prompt: 'Change it' });
  assert.equal(input.turnId, 'turn-a'); assert.equal(input.data.text, 'Change it');
  const failed: any = observation({ hook_event_name: 'PostToolUse', tool_use_id: 'c', tool_name: 'Bash', tool_response: { exit_code: 7 } });
  assert.equal(failed.isError, true);
  assert.equal(toolError('Bash', 'Process exited with code 1\nFinal output:\n'), true);
  assert.equal(toolError('Bash', { exit_code: 0 }), false);
  assert.equal(toolError('mcp__test__tool', { isError: true }), true);
  assert.equal(toolError('apply_patch', 'Done'), undefined);
  assert.equal(toolError('unknown', { exit_code: 1 }), undefined);
  assert.equal(observation({ hook_event_name: 'PostToolUseFailure' }), undefined);
});

test('Codex launch checks every recording hook and preserves configuration overrides', () => {
  const settings = hookSettings();
  const hooks = hookEvents.map(event => ({ command: settings.command, source: 'sessionFlags',
    eventName: event[0].toLowerCase() + event.slice(1), enabled: true, trustStatus: 'trusted' }));
  requireTrustedHooks({ data: [{ hooks, errors: [] }] }, settings.command);
  assert.throws(() => requireTrustedHooks({ data: [{ hooks: hooks.slice(1) }] }, settings.command), /setup-hooks/);
  assert.throws(() => requireTrustedHooks({ data: [{ hooks: hooks.map(h => ({ ...h, trustStatus: 'untrusted' })) }] }, settings.command), /untrusted/);
  assert.deepEqual(inspectionArgs(['resume', '--last', '-c', 'model="example"', '-p', 'work']), ['-c', 'model="example"', '-p', 'work']);
  for (const args of [['-c', 'hooks={}'], ['-c', 'features.hooks=false'], ['-c', '"features"."hooks"=false'], ['--disable', 'hooks'],
    ['--config=mcp_servers.wisdom.command="other"'], ['--cd', 'elsewhere'], ['--dangerously-bypass-hook-trust']]) {
    assert.throws(() => inspectionArgs(args));
  }
});

test('Codex capture preserves bytes, correlates overlapping turns, and serves existing query views', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wisdom-codex-test-'));
  const workspace = path.join(root, 'project'); fs.mkdirSync(workspace);
  const source = path.join(root, 'rollout.jsonl'); fs.writeFileSync(source, '');
  fs.writeFileSync(path.join(workspace, 'one.txt'), 'before\n');
  const daemon = await startDaemon(path.join(root, 'data'), 0);
  try {
    const c = daemon.connection;
    const { launchId } = await call(c, '/launches', { harness: 'codex', workspaceRoot: workspace });
    const hook = async (event: any, observationId = randomUUID()) => call(c, `/launches/${launchId}/observe`, {
      observationId, sessionId: 'codex-session', source, ...observation(event),
    });
    const { captureId } = await hook({ hook_event_name: 'SessionStart', session_id: 'codex-session', transcript_path: source, source: 'startup' });
    fs.appendFileSync(source, line('turn_context', { turn_id: 'a' }) + message('user-a', 'user', 'Edit one.txt'));
    const a = await hook({ hook_event_name: 'UserPromptSubmit', turn_id: 'a', prompt: 'Edit one.txt' });
    await hook({ hook_event_name: 'PreToolUse', turn_id: 'a', tool_name: 'Bash', tool_use_id: 'tool-a', tool_input: { command: 'edit one.txt' } });
    await hook({ hook_event_name: 'UserPromptSubmit', turn_id: 'b', prompt: 'Another request' });
    fs.writeFileSync(path.join(workspace, 'one.txt'), 'after\n');
    fs.writeFileSync(path.join(workspace, 'two.txt'), 'partial failure\n');
    const event = { hook_event_name: 'PostToolUse', turn_id: 'a', tool_name: 'Bash', tool_use_id: 'tool-a', tool_response: { exit_code: 1, output: 'failed after writes' } };
    const eventId = randomUUID(); await hook(event, eventId); await hook(event, eventId);
    fs.appendFileSync(source, message('assistant-a', 'assistant', 'Both files changed')
      + line('event_msg', { type: 'agent_message', message: 'Both files changed' })
      + line('response_item', { type: 'function_call', id: 'f1', name: 'exec_command', call_id: 'tool-a', arguments: '{"cmd":"edit one.txt"}' })
      + line('response_item', { type: 'function_call_output', id: 'f2', call_id: 'tool-a', output: 'native duplicate' }));
    await hook({ hook_event_name: 'Stop', turn_id: 'a', last_assistant_message: 'Both files changed' });
    await call(c, `/launches/${launchId}/close`, {});
    const ledger = daemon.captures.get(captureId);
    assert.equal(ledger.manifest.sessionId, 'codex-session');
    assert.equal(ledger.manifest.status, 'closed');
    assert.deepEqual(fs.readFileSync(ledger.mirror), fs.readFileSync(source));
    const records = ledger.listRecords();
    assert.equal(records.filter(r => r.type === 'tool_finished').length, 1);
    assert.equal(records.find(r => r.type === 'tool_finished')?.requestId, a.id);
    assert.equal(records.find(r => r.sourceEntryId === 'assistant-a')?.requestId, a.id);
    const read = async (request: object): Promise<string> => (await call(c, '/ledger', { capture: captureId, ...request })).text;
    const glance = await read({ glance: true });
    assert.match(glance, /^resume with: wisdom resume codex-session$/m);
    assert.match(glance, /^t1  in {8}Edit one\.txt\n {4}out {7}Both files changed\n {4}1 tool call · 1 failed · changed one\.txt, two\.txt$/m);
    assert.match(glance, /^t2  in {8}Another request\n {4}no tool calls · no changes$/m);
    // The overlapping turn keeps its own call, reply and both changes; the native duplicate is not a second call.
    const turn = await read({ open: 't1' });
    assert.equal(turn.match(/^c\d+ /gm)?.length, 1);
    assert.match(turn, /^c1  Bash · failed · → p1, p2$/m);
    assert.equal(turn.match(/^reply {5}Both files changed$/gm)?.length, 1);
    assert.match(turn, /^p1  one\.txt · modify · \+1 −1 · observed during c1$/m);
    assert.match(turn, /^p2  two\.txt · create · \+1 −0 · observed during c1$/m);
    // CLI, HTTP and MCP return the same text.
    const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
    const { stdout } = await promisify(execFile)(process.execPath, [cli, 'open', 't1', '--capture', captureId, '--data', path.join(root, 'data')]);
    assert.equal(stdout, turn + '\n');
    const server = createLedgerMcp(c);
    const client = new Client({ name: 'codex-test', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      const result = await client.callTool({ name: 'ledger', arguments: { capture: captureId, open: 't1' } });
      assert.equal((result.content as any[])[0].text, turn);
    } finally { await client.close(); await server.close(); }
  } finally { await daemon.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('a resumed Codex session continues its capture; subagent copies, compaction and missing transcripts remain explicit', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wisdom-codex-resume-'));
  const workspace = path.join(root, 'project'); fs.mkdirSync(workspace);
  const source = path.join(root, 'rollout.jsonl');
  // Some rollout versions omit response-item IDs. Byte identity must still deduplicate resume copies.
  fs.writeFileSync(source, line('turn_context', { turn_id: 'old' }) + message('', 'assistant', 'Existing history'));
  const sub = path.join(root, 'subagent.jsonl'); fs.writeFileSync(sub, message('sub', 'assistant', 'Subagent result'));
  const daemon = await startDaemon(path.join(root, 'data'), 0);
  try {
    const c = daemon.connection;
    const open = async (nativeSource: string | null = source, sessionId = 'native-session') => (await call(c, '/captures', {
      harness: 'codex', sessionId, workspaceRoot: workspace, source: nativeSource,
    })).captureId as string;
    const first = await open(); await call(c, `/captures/${first}/close`, {});
    // The same native session is the same capture: a resume is a new visit, not a new capture.
    const second = await open();
    assert.equal(second, first);
    assert(daemon.captures.get(second).listRecords().some(r => r.summary.startsWith('not-recording-between-visits')));
    const hook = (event: any) => call(c, `/captures/${second}/observe`, { observationId: randomUUID(), ...observation(event) });
    await hook({ hook_event_name: 'SessionStart', session_id: 'native-session', transcript_path: source, source: 'resume' });
    await hook({ hook_event_name: 'PreCompact', trigger: 'auto', turn_id: 'new' });
    await hook({ hook_event_name: 'PostCompact', trigger: 'auto', turn_id: 'new' });
    await hook({ hook_event_name: 'SubagentStop', agent_id: 'sub-1', agent_transcript_path: sub });
    await call(c, `/captures/${second}/close`, {});
    // History from before the capture is mirrored byte for byte, but belongs to no turn,
    // so a reader never sees it as this capture's work.
    const history = daemon.captures.database.records("type='source_record' AND role='assistant'").filter(r => r.summary === 'Existing history');
    assert(history.length >= 1 && history.every(r => !r.requestId));
    assert.match((await call(c, '/ledger', { capture: second, glance: true })).text, /^0 turns · /m);
    const ledger = daemon.captures.get(second);
    assert.deepEqual(fs.readFileSync(path.join(ledger.dir, 'subagents', 'agent-sub-1.jsonl')), fs.readFileSync(sub));
    assert.equal(ledger.listRecords().filter(r => r.type === 'session_compact').length, 2);
    const missing = await open(null, 'no-transcript'); await call(c, `/captures/${missing}/close`, {});
    assert(daemon.captures.get(missing).listRecords().some(r => r.summary.startsWith('native-session-unavailable')));
    const pending = await open(null, 'unfinished');
    await call(c, `/captures/${pending}/observe`, { observationId: randomUUID(), type: 'tool_started', turnId: 'unfinished', toolCallId: 'pending', toolName: 'Bash' });
    await call(c, `/captures/${pending}/close`, {});
    assert.equal(daemon.captures.get(pending).manifest.status, 'interrupted');
  } finally { await daemon.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

const hookFile = fileURLToPath(new URL('../../integrations/codex/hook.mjs', import.meta.url));
async function runHook(input: string, env: NodeJS.ProcessEnv): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [hookFile], { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', bytes => { stdout += bytes; }); child.stderr.on('data', bytes => { stderr += bytes; });
  child.stdin.end(input);
  return new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => resolve({ code, stdout, stderr })); });
}

test('Codex hook process acknowledges writes, preserves raw payloads and denies unavailable recording', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wisdom-codex-hook-'));
  const workspace = path.join(root, 'project'); fs.mkdirSync(workspace);
  const data = path.join(root, 'data');
  const daemon = await startDaemon(data, 0);
  const env = { ...process.env, WISDOM_DATA_DIR: data, WISDOM_LAUNCH_ID: '' };
  const session = (id: string) => [...daemon.captures.ledgers.values()].find(l => l.manifest.sessionId === id)!;
  try {
    env.WISDOM_LAUNCH_ID = (await call(daemon.connection, '/launches', { harness: 'codex', workspaceRoot: workspace })).launchId;
    const event = { session_id: 'native-session', transcript_path: null, hook_event_name: 'UserPromptSubmit', turn_id: 'a', prompt: 'Hello' };
    const result = await runHook(JSON.stringify(event), env);
    assert.equal(result.code, 0, result.stderr); assert.deepEqual(JSON.parse(result.stdout), {});
    const ledger = session('native-session');
    const raw = ledger.listRecords().find(r => r.type === 'harness_event')!;
    assert.deepEqual(JSON.parse(ledger.readPayload(raw.dataRef!)), event);
    // One request carries both records; the raw event hangs off its observation.
    assert.equal(raw.parentId, ledger.listRecords().find(r => r.type === 'input')!.id);
    // Another session (/new, /clear) is another capture; the previous one closes, nothing mixes.
    const changed = await runHook(JSON.stringify({ ...event, session_id: 'different' }), env);
    assert.equal(changed.code, 0); assert.deepEqual(JSON.parse(changed.stdout), {});
    assert.equal(ledger.manifest.endReason, 'session-switched');
    assert.equal(session('different').listRecords().filter(r => r.type === 'input').length, 1);
    const blocked = await runHook(JSON.stringify({ ...event, hook_event_name: 'PreToolUse', tool_use_id: 'x', tool_name: 'Bash' }),
      { ...env, WISDOM_DATA_DIR: path.join(root, 'missing') });
    assert.equal(blocked.code, 0);
    assert.equal(JSON.parse(blocked.stdout).hookSpecificOutput.permissionDecision, 'deny');
    // Events that cannot undo work report the failure without a decision.
    const stop = await runHook(JSON.stringify({ ...event, hook_event_name: 'Stop' }), { ...env, WISDOM_DATA_DIR: path.join(root, 'missing') });
    assert.equal(stop.code, 1); assert.equal(stop.stdout, '');
    // Unparseable input: the event name is still recovered from the raw text.
    const truncated = await runHook('{"hook_event_name":"PreToolUse","tool_input":', env);
    assert.equal(JSON.parse(truncated.stdout).hookSpecificOutput.permissionDecision, 'deny');
    const inactive = await runHook('{}', { ...env, WISDOM_LAUNCH_ID: '' });
    assert.equal(inactive.code, 0); assert.deepEqual(JSON.parse(inactive.stdout), {});
  } finally { await daemon.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
