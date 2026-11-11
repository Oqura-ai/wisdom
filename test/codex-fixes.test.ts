import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startDaemon } from '../src/service/daemon.js';
import { call } from '../src/service/client.js';
import { observation } from '../src/harnesses/codex/hook.js';
import { hookEvents, nodeReplEnabled, requireTrustedHooks } from '../src/harnesses/codex/launch.js';

const line = (type: string, payload: unknown) => JSON.stringify({ timestamp: '2026-10-23T00:00:00Z', type, payload }) + '\n';

async function capture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wisdom-codex-fix-'));
  const workspace = path.join(root, 'project'); fs.mkdirSync(workspace);
  const source = path.join(root, 'rollout.jsonl'); fs.writeFileSync(source, '');
  const daemon = await startDaemon(path.join(root, 'data'), 0);
  const hook = (event: any) => call(daemon.connection, '/observe', { harness: 'codex', cwd: workspace,
    observation: { observationId: randomUUID(), sessionId: 'codex-session', source, ...observation(event) } });
  const { captureId } = await hook({ hook_event_name: 'SessionStart', session_id: 'codex-session', transcript_path: source, source: 'startup' });
  const done = async () => { await daemon.close(); fs.rmSync(root, { recursive: true, force: true }); };
  return { daemon, captureId, hook, source, workspace, done };
}

test('the Codex hook shim answers {} and warns when the Wisdom build cannot load; it never blocks', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wisdom-codex-shim-'));
  // A copy two levels deep has no ../../dist beside it, like a missing build.
  const shim = path.join(root, 'a', 'b', 'hook.mjs'); fs.mkdirSync(path.dirname(shim), { recursive: true });
  fs.copyFileSync(fileURLToPath(new URL('../../integrations/codex/hook.mjs', import.meta.url)), shim);
  const run = (input: string) => new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [shim, root], { windowsHide: true });
    let stdout = '', stderr = ''; child.stdout.on('data', bytes => { stdout += bytes; }); child.stderr.on('data', bytes => { stderr += bytes; });
    child.stdin.end(input); child.once('error', reject); child.once('close', code => resolve({ code, stdout, stderr }));
  });
  try {
    for (const name of ['PreToolUse', 'UserPromptSubmit', 'Stop']) {
      const result = await run(JSON.stringify({ hook_event_name: name }));
      assert.deepEqual(JSON.parse(result.stdout), {});
      assert.equal(result.code, 1); assert.match(result.stderr, /could not load/);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a tool with no result hook is finished from the native transcript at turn end', async () => {
  const { daemon, captureId, hook, source, workspace, done } = await capture();
  try {
    await hook({ hook_event_name: 'UserPromptSubmit', turn_id: 't', prompt: 'Patch it' });
    await hook({ hook_event_name: 'PreToolUse', turn_id: 't', tool_name: 'Bash', tool_use_id: 'patch', tool_input: { command: 'apply_patch ...' } });
    fs.writeFileSync(path.join(workspace, 'patched.txt'), 'new\n');
    // Codex sent no PostToolUse here (observed with apply_patch); the rollout has the result.
    fs.appendFileSync(source, line('response_item', { type: 'function_call', call_id: 'patch', name: 'shell_command', arguments: '{}' })
      + line('response_item', { type: 'function_call_output', call_id: 'patch', output: 'Success. Updated the following files:\nA patched.txt' }));
    await hook({ hook_event_name: 'Stop', turn_id: 't', last_assistant_message: 'Done' });
    // The turn shows the native result rather than an empty transcript-based finish.
    const turn = (await call(daemon.connection, '/ledger', { capture: captureId, open: 't1' })).text;
    assert.match(turn, /^c1  Bash · outcome not recorded · result from transcript · → p1\n {4}input {5}\{"command":"apply_patch \.\.\."\}\n {4}output\n {8}Success\. Updated the following files:$/m);
    // A result hook arriving late is evidence, not a missing-start gap.
    await hook({ hook_event_name: 'PostToolUse', turn_id: 't', tool_name: 'Bash', tool_use_id: 'patch', tool_response: 'late' });
    await hook({ hook_event_name: 'SessionEnd', reason: 'exit' });
    const ledger = daemon.captures.get(captureId);
    const records = ledger.listRecords();
    const finished = records.find(r => r.type === 'tool_finished' && r.resultBasis === 'native-transcript')!;
    assert.equal(finished.toolCallId, 'patch');
    assert(!records.some(r => r.type === 'gap' && /unfinished-tools-at-settle|missing-tool-start/.test(r.summary)));
    assert.equal(ledger.manifest.status, 'closed');
    const change = records.find(r => r.type === 'file_change' && r.path === 'patched.txt')!;
    assert.equal(change.toolCallId, 'patch'); assert.equal(change.attribution, 'observed-during-tool');
  } finally { await done(); }
});

test('a tool still open at turn end without transcript evidence stays visibly unfinished', async () => {
  const { daemon, captureId, hook, done } = await capture();
  try {
    await hook({ hook_event_name: 'PreToolUse', turn_id: 't', tool_name: 'Bash', tool_use_id: 'lost', tool_input: { command: 'x' } });
    await hook({ hook_event_name: 'Stop', turn_id: 't' });
    await hook({ hook_event_name: 'SessionEnd', reason: 'exit' });
    const ledger = daemon.captures.get(captureId);
    assert(ledger.listRecords().some(r => r.type === 'gap' && r.summary.includes('unfinished-tools-at-settle')));
    assert.equal(ledger.manifest.status, 'interrupted');
  } finally { await done(); }
});

test('opening a spawned Codex subagent reaches everything it did', async () => {
  const { daemon, captureId, hook, done } = await capture();
  try {
    await hook({ hook_event_name: 'UserPromptSubmit', turn_id: 't', prompt: 'Delegate' });
    await hook({ hook_event_name: 'PreToolUse', turn_id: 't', tool_name: 'spawn_agent', tool_use_id: 'spawn', tool_input: { message: 'list files' } });
    await hook({ hook_event_name: 'PostToolUse', turn_id: 't', tool_name: 'spawn_agent', tool_use_id: 'spawn',
      tool_response: JSON.stringify({ agent_id: 'kid', nickname: 'helper' }) });
    await hook({ hook_event_name: 'PreToolUse', turn_id: 'k', agent_id: 'kid', tool_name: 'Bash', tool_use_id: 'kid-ls', tool_input: { command: 'ls' } });
    await hook({ hook_event_name: 'PostToolUse', turn_id: 'k', agent_id: 'kid', tool_name: 'Bash', tool_use_id: 'kid-ls', tool_response: { exit_code: 0 } });
    const read = async (request: object): Promise<string> => (await call(daemon.connection, '/ledger', { capture: captureId, ...request })).text;
    assert.match(await read({ glance: true }), /^ {4}subagent a1 · 1 tool call · no changes$/m);
    assert.match(await read({ open: 't1' }), /^c1  spawn_agent · outcome not recorded · → a1 \(open a1\)$/m);
    const subagent = await read({ open: 'a1' });
    assert.match(subagent, /^a1 · subagent in t1 · /);
    assert.match(subagent, /^c1  Bash · ok\n {4}input {5}\{"command":"ls"\}$/m);
  } finally { await done(); }
});

test('subagent events keep the session transcript; failed commands are errors from the transcript', async () => {
  const { daemon, captureId, hook, source, done } = await capture();
  const send = (event: any) => call(daemon.connection, '/observe', { harness: 'codex', cwd: daemon.captures.get(captureId).manifest.workspaceRoot,
    observation: { observationId: randomUUID(), sessionId: 'codex-session', ...observation(event) } });
  try {
    // Real Codex: a subagent's events carry its own rollout path. The hook omits it.
    await send({ hook_event_name: 'SubagentStart', agent_id: 'kid', agent_type: 'default' });
    await send({ hook_event_name: 'PreToolUse', agent_id: 'kid', tool_name: 'Bash', tool_use_id: 'kid-cmd', tool_input: { command: 'cat missing' } });
    // Codex sends no PostToolUse for a failed command; only the rollout records it.
    fs.appendFileSync(source, line('response_item', { type: 'function_call_output', call_id: 'kid-cmd',
      output: 'Exit code: 1\nWall time: 0.3 seconds\nOutput:\ncat : Cannot find path' }));
    await hook({ hook_event_name: 'Stop', turn_id: 't' });
    const ledger = daemon.captures.get(captureId);
    assert.equal(ledger.manifest.status, 'recording');
    assert.equal(ledger.manifest.source, source);
    const finished = ledger.listRecords().find(r => r.type === 'tool_finished' && r.toolCallId === 'kid-cmd')!;
    assert.equal(finished.resultBasis, 'native-transcript'); assert.equal(finished.isError, true);
    // No turn was recorded, so the subagent is listed outside the turns; its failure stays visible.
    const read = async (request: object): Promise<string> => (await call(daemon.connection, '/ledger', { capture: captureId, ...request })).text;
    assert.match(await read({ glance: true }), /^outside {3}subagents a1 · open "outside"$/m);
    assert.match(await read({ open: 'a1' }), /^seq \d+  tool_finished  /m);
  } finally { await done(); }
});

test('node_repl detection and opt-in trust bypass behave as documented', () => {
  const config = '[mcp_servers.node_repl]\ncommand = "node_repl.exe"\n\n[mcp_servers.node_repl.env]\nX = "1"\n\n[other]\nenabled = false\n';
  assert.equal(nodeReplEnabled(config, []), true);
  assert.equal(nodeReplEnabled(config, ['-c', 'mcp_servers.node_repl.enabled=false']), false);
  assert.equal(nodeReplEnabled(config.replace('command', 'enabled = false\ncommand'), []), false);
  assert.equal(nodeReplEnabled('[mcp_servers.other]\ncommand = "x"\n', []), false);
  const settings = { command: 'node "hook.mjs" "data"' };
  const untrusted = hookEvents.map(event => ({ command: settings.command, source: 'user',
    eventName: event[0].toLowerCase() + event.slice(1), enabled: true, trustStatus: 'untrusted' }));
  assert.throws(() => requireTrustedHooks({ data: [{ hooks: untrusted, errors: [] }] }, settings.command), /untrusted/);
  requireTrustedHooks({ data: [{ hooks: untrusted, errors: [] }] }, settings.command, true);
  // Trust bypass never excuses missing or disabled hooks.
  assert.throws(() => requireTrustedHooks({ data: [{ hooks: untrusted.slice(1), errors: [] }] }, settings.command, true));
});

/** Lines as Codex 0.164.0 wrote them in a real session: the model's exec, and what actually ran. */
const execCall = (id: string, code: string) => line('response_item', { type: 'custom_tool_call', call_id: id, name: 'exec', input: code });
const execOutput = (id: string, output: string) => line('response_item', { type: 'custom_tool_call_output', call_id: id, output });
const ran = (item: Record<string, unknown>) => line('event_msg', { type: 'item_completed', turn_id: 't', item });

test('on 0.164 a failed command is failed: the hook and what ran share an ID, in either order', async () => {
  const { daemon, captureId, hook, source, done } = await capture();
  try {
    const read = async (request: object): Promise<string> => (await call(daemon.connection, '/ledger', { capture: captureId, ...request })).text;
    await hook({ hook_event_name: 'UserPromptSubmit', turn_id: 't', prompt: 'run it' });
    fs.appendFileSync(source, execCall('call_a', "await tools.exec_command({cmd:'node -e 1'})"));
    await hook({ hook_event_name: 'PreToolUse', turn_id: 't', tool_name: 'Bash', tool_use_id: 'exec-a', tool_input: { command: 'node -e 1' } });
    // Already in the rollout when the empty result hook arrives.
    fs.appendFileSync(source, ran({ type: 'CommandExecution', id: 'exec-a', status: 'failed', exit_code: 1, aggregated_output: '', command: ['powershell.exe', '-Command', 'node -e 1'], parsed_cmd: [{ cmd: 'node -e 1' }] }));
    await hook({ hook_event_name: 'PostToolUse', turn_id: 't', tool_name: 'Bash', tool_use_id: 'exec-a', tool_input: { command: 'node -e 1' }, tool_response: '' });
    fs.appendFileSync(source, execOutput('call_a', 'Script completed'));
    // Written after its result hook: settled at the turn's end.
    fs.appendFileSync(source, execCall('call_b', "await tools.exec_command({cmd:'node -e 2'})"));
    await hook({ hook_event_name: 'PreToolUse', turn_id: 't', tool_name: 'Bash', tool_use_id: 'exec-b', tool_input: { command: 'node -e 2' } });
    await hook({ hook_event_name: 'PostToolUse', turn_id: 't', tool_name: 'Bash', tool_use_id: 'exec-b', tool_input: { command: 'node -e 2' }, tool_response: '' });
    fs.appendFileSync(source, ran({ type: 'CommandExecution', id: 'exec-b', status: 'failed', exit_code: 2, aggregated_output: 'boom', parsed_cmd: [{ cmd: 'node -e 2' }] }));
    fs.appendFileSync(source, line('response_item', { type: 'function_call', call_id: 'call_w', name: 'wait', arguments: '{"cell_id":"3"}' }));
    await hook({ hook_event_name: 'Stop', turn_id: 't', last_assistant_message: 'done' });
    const glance = await read({ glance: true });
    assert.match(glance, /2 tool calls · 2 failed/, 'exec and wait are not actions');
    const turn = await read({ open: 't1' });
    assert.match(turn, /^c\d+ {2}exec · script step/m);
    assert.match(turn, /^c\d+ {2}wait · script step/m);
    assert.match(turn, /^c\d+ {2}Bash · failed/m);
    assert.doesNotMatch(turn, /Bash · outcome not recorded/);
    const stats = await call(daemon.connection, '/view', { view: 'project', workspaceRoot: daemon.captures.get(captureId).manifest.workspaceRoot });
    assert.equal(stats.sessions[0].failures, 2, 'each failure is counted once');
  } finally { await done(); }
});

test('a change Wisdom could not observe is kept from Codex\'s report, and says so; an observed one is not repeated', async () => {
  const { daemon, captureId, hook, source, workspace, done } = await capture();
  try {
    const file = path.join(workspace, 'probe.txt');
    await hook({ hook_event_name: 'UserPromptSubmit', turn_id: 't', prompt: 'edit' });
    const send = (tool: string, type: string) => hook({ hook_event_name: type, turn_id: 't', tool_name: 'apply_patch', tool_use_id: tool, tool_input: { command: '*** Begin Patch' }, tool_response: 'Exit code: 0\nOutput:\nSuccess' });
    // Observed: the file really changes while the tool runs.
    await send('exec-seen', 'PreToolUse');
    fs.writeFileSync(file, 'hello\n');
    await send('exec-seen', 'PostToolUse');
    fs.appendFileSync(source, ran({ type: 'FileChange', id: 'exec-seen', status: 'completed', stdout: 'Success', stderr: '', changes: { [file]: { type: 'add', content: 'hello\n' } } }));
    // Not observed: the file was already changed when the tool's events arrive.
    const quiet = path.join(workspace, 'quiet.txt');
    await send('exec-lost', 'PreToolUse');
    fs.appendFileSync(source, ran({ type: 'FileChange', id: 'exec-lost', status: 'completed', stdout: 'Success', stderr: '', changes: { [quiet]: { type: 'update', unified_diff: '@@ -1 +1,2 @@\n hello\n+world\n' } } }));
    await send('exec-lost', 'PostToolUse');
    await hook({ hook_event_name: 'Stop', turn_id: 't', last_assistant_message: 'done' });
    const turn = (await call(daemon.connection, '/ledger', { capture: captureId, open: 't1' })).text;
    assert.match(turn, /^p1 {2}probe\.txt · create · \+1 −0 · observed during c\d+$/m);
    assert.match(turn, /^p2 {2}quiet\.txt · modify · \+1 −0 · reported-by-harness$/m);
    assert.match(turn, /^ {4}\+world$/m);
    assert.equal(turn.match(/probe\.txt · /g)!.length, 1, 'an observed change is not repeated');
  } finally { await done(); }
});

test('a Codex session read only from its file shows what ran and how it ended', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wisdom-codex-found-'));
  const workspace = path.join(root, 'project'); fs.mkdirSync(workspace);
  const data = path.join(root, 'data');
  const folder = path.join(data, 'harnesses', 'codex', 'home', 'sessions', '2026', '11', '02');
  fs.mkdirSync(folder, { recursive: true });
  const file = path.join(folder, 'rollout.jsonl');
  fs.writeFileSync(file, line('session_meta', { id: 'found-codex', cwd: workspace, source: 'cli', cli_version: '0.164.0' })
    + line('turn_context', { turn_id: 't' })
    + line('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'run it' }] })
    + execCall('call_a', 'script') + ran({ type: 'CommandExecution', id: 'exec-a', status: 'failed', exit_code: 1, aggregated_output: '', parsed_cmd: [{ cmd: 'node -e 1' }] }) + execOutput('call_a', 'Script completed'));
  const quiet = new Date(Date.now() - 10 * 60_000); fs.utimesSync(file, quiet, quiet);
  const daemon = await startDaemon(data, 0);
  try {
    daemon.captures.scan();
    const turn = (await call(daemon.connection, '/ledger', { capture: 'found-codex', open: 't1' })).text;
    assert.match(turn, /^c\d+ {2}exec · script step/m);
    assert.match(turn, /^c\d+ {2}Bash · failed · seen only in transcript/m);
    assert.match((await call(daemon.connection, '/ledger', { capture: 'found-codex', glance: true })).text, /^session found-codex · codex 0\.164\.0 · /m);
  } finally { await daemon.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
