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
  for (const raw of [{ type: 'event_msg', payload: { type: 'agent_message', message: 'Done' } },
    { type: 'response_item', payload: { type: 'reasoning', encrypted_content: 'opaque' } }, { type: 'future-record' }]) {
    assert.deepEqual(codex.nativeEntry(raw).messages, []);
  }
  assert.equal(codex.isDirectFileTool('apply_patch'), false);
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
    const { captureId } = await call(c, '/captures', { harness: 'codex', sessionId: 'pending-start', workspaceRoot: workspace, source: null });
    const hook = async (event: any, observationId = randomUUID()) => call(c, `/captures/${captureId}/observe`, {
      observationId, sessionId: 'codex-session', source, ...observation(event),
    });
    await hook({ hook_event_name: 'SessionStart', session_id: 'codex-session', transcript_path: source, source: 'startup' });
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
    await call(c, `/captures/${captureId}/close`, {});
    const ledger = daemon.captures.get(captureId);
    assert.equal(ledger.manifest.sessionId, 'codex-session');
    assert.equal(ledger.manifest.status, 'closed');
    assert.deepEqual(fs.readFileSync(ledger.mirror), fs.readFileSync(source));
    const records = ledger.listRecords();
    assert.equal(records.filter(r => r.type === 'tool_finished').length, 1);
    assert.equal(records.find(r => r.type === 'tool_finished')?.requestId, a.id);
    assert.equal(records.find(r => r.sourceEntryId === 'assistant-a')?.requestId, a.id);
    const changes = await call(c, '/query', { preset: 'changes', captureId });
    assert.equal(changes.items.length, 2);
    assert(changes.items.every((r: any) => r.attribution === 'observed-during-tool'));
    const failures = await call(c, '/query', { preset: 'failures', captureId });
    assert.equal(failures.items.length, 1);
    const review = await call(c, '/query', { preset: 'interaction-review', captureId, maxChars: 32000 });
    assert.equal(review.items.find((r: any) => r.id === a.id).changes.items.length, 2);
    const clean = await call(c, '/query', { preset: 'timeline', captureId, clean: true, maxChars: 32000 });
    assert.equal(clean.filter((r: any) => r.user === 'Edit one.txt').length, 1);
    assert.equal(clean.filter((r: any) => r.assistant === 'Both files changed').length, 1);
    assert.equal(clean.filter((r: any) => r.tool).length, 1);
    assert.equal((await call(c, '/query', { find: 'tools', captureId, where: { harness: 'codex', turnId: 'a' } })).items.length, 1);
    const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
    const { stdout } = await promisify(execFile)(process.execPath, [cli, 'timeline', captureId,
      '--clean', '--max-chars', '32000', '--data', path.join(root, 'data')]);
    assert.deepEqual(JSON.parse(stdout), clean);
    const server = createLedgerMcp(c);
    const client = new Client({ name: 'codex-test', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      const result = await client.callTool({ name: 'ledger_query', arguments: { preset: 'timeline', captureId, clean: true, maxChars: 32000 } });
      assert.deepEqual(JSON.parse((result.content as any[])[0].text), clean);
    } finally { await client.close(); await server.close(); }
  } finally { await daemon.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('Codex resume deduplicates native history; subagent copies, compaction and missing transcripts remain explicit', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wisdom-codex-resume-'));
  const workspace = path.join(root, 'project'); fs.mkdirSync(workspace);
  const source = path.join(root, 'rollout.jsonl');
  // Some rollout versions omit response-item IDs. Byte identity must still deduplicate resume copies.
  fs.writeFileSync(source, line('turn_context', { turn_id: 'old' }) + message('', 'assistant', 'Existing history'));
  const sub = path.join(root, 'subagent.jsonl'); fs.writeFileSync(sub, message('sub', 'assistant', 'Subagent result'));
  const daemon = await startDaemon(path.join(root, 'data'), 0);
  try {
    const c = daemon.connection;
    const open = async (nativeSource: string | null = source) => (await call(c, '/captures', {
      harness: 'codex', sessionId: 'native-session', workspaceRoot: workspace, source: nativeSource,
    })).captureId as string;
    const first = await open(); await call(c, `/captures/${first}/close`, {});
    const second = await open();
    const hook = (event: any) => call(c, `/captures/${second}/observe`, { observationId: randomUUID(), ...observation(event) });
    await hook({ hook_event_name: 'SessionStart', session_id: 'native-session', transcript_path: source, source: 'resume' });
    await hook({ hook_event_name: 'PreCompact', trigger: 'auto', turn_id: 'new' });
    await hook({ hook_event_name: 'PostCompact', trigger: 'auto', turn_id: 'new' });
    await hook({ hook_event_name: 'SubagentStop', agent_id: 'sub-1', agent_transcript_path: sub });
    await call(c, `/captures/${second}/close`, {});
    const clean = await call(c, '/query', { preset: 'timeline', scope: { sessionIds: ['native-session'] }, clean: true });
    assert.equal(clean.filter((row: any) => row.assistant === 'Existing history').length, 1);
    const ledger = daemon.captures.get(second);
    assert.deepEqual(fs.readFileSync(path.join(ledger.dir, 'subagents', 'agent-sub-1.jsonl')), fs.readFileSync(sub));
    assert.equal(ledger.listRecords().filter(r => r.type === 'session_compact').length, 2);
    const missing = await open(null); await call(c, `/captures/${missing}/close`, {});
    assert(daemon.captures.get(missing).listRecords().some(r => r.summary.startsWith('native-session-unavailable')));
    const pending = await open(null);
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
  const env = { ...process.env, WISDOM_DATA_DIR: data, WISDOM_CAPTURE_ID: '' };
  try {
    env.WISDOM_CAPTURE_ID = (await call(daemon.connection, '/captures', { harness: 'codex', sessionId: 'pending-start', workspaceRoot: workspace, source: null })).captureId;
    const event = { session_id: 'native-session', transcript_path: null, hook_event_name: 'UserPromptSubmit', turn_id: 'a', prompt: 'Hello' };
    const result = await runHook(JSON.stringify(event), env);
    assert.equal(result.code, 0, result.stderr); assert.deepEqual(JSON.parse(result.stdout), {});
    const ledger = daemon.captures.get(env.WISDOM_CAPTURE_ID);
    const raw = ledger.listRecords().find(r => r.type === 'harness_event')!;
    assert.deepEqual(JSON.parse(ledger.readPayload(raw.dataRef!)), event);
    // One request carries both records; the raw event hangs off its observation.
    assert.equal(raw.parentId, ledger.listRecords().find(r => r.type === 'input')!.id);
    // A changed session must never mix another transcript into this capture.
    // Codex runs the tool after a non-zero exit, so failures exit 0 with a decision.
    const changed = await runHook(JSON.stringify({ ...event, session_id: 'different' }), env);
    assert.equal(changed.code, 0); assert.equal(JSON.parse(changed.stdout).decision, 'block');
    assert.equal(ledger.manifest.status, 'degraded');
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
    const inactive = await runHook('{}', { ...env, WISDOM_CAPTURE_ID: '' });
    assert.equal(inactive.code, 0); assert.deepEqual(JSON.parse(inactive.stdout), {});
  } finally { await daemon.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
