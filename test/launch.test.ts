import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { installPi, launchPi } from '../src/harnesses/pi/launch.js';
import { resolveCommand, staleHooks } from '../src/harnesses/launch.js';
import { installClaudeCode, launchClaudeCode } from '../src/harnesses/claude-code/launch.js';
import { installCodex } from '../src/harnesses/codex/launch.js';
import { startDaemon } from '../src/daemon.js';
import { call, connectionAt, spool } from '../src/client.js';
import { findDataDir, hookDataDir, marker } from '../src/paths.js';

const temp = (name: string) => fs.mkdtempSync(path.join(os.tmpdir(), `wisdom-${name}-`));

test('init writes Wisdom\'s hooks into each harness home in the data folder, keeping other hooks', () => {
  const data = temp('install');
  try {
    const claudeHome = path.join(data, 'harnesses', 'claude-code', 'home');
    fs.mkdirSync(claudeHome, { recursive: true });
    const theirs = { hooks: [{ type: 'command', command: 'echo mine' }] };
    fs.writeFileSync(path.join(claudeHome, 'settings.json'), JSON.stringify({ theme: 'dark', hooks: { Stop: [theirs] } }));
    installClaudeCode(data); installClaudeCode(data); // Running init again repairs, never duplicates.
    const settings = JSON.parse(fs.readFileSync(path.join(claudeHome, 'settings.json'), 'utf8'));
    assert.equal(settings.theme, 'dark');
    assert.deepEqual(settings.hooks.Stop[0], theirs);
    assert.equal(settings.hooks.Stop.length, 2);
    assert.match(settings.hooks.PreToolUse[0].hooks[0].command, /^node ".*integrations\/claude-code\/hook\.mjs" ".*"$/);
    assert.equal(settings.hooks.PreToolUse[0].matcher, '*');
    assert(settings.hooks.PreToolUse[0].hooks[0].command.endsWith(`"${data.replaceAll('\\', '/')}"`));

    const codex = installCodex(data);
    const hooks = JSON.parse(fs.readFileSync(path.join(codex.home, 'hooks.json'), 'utf8')).hooks;
    assert.equal(hooks.SessionEnd[0].hooks[0].timeout, 3);
    assert.equal(hooks.PreToolUse[0].hooks[0].command, codex.command);

    const piHome = installPi(data);
    assert.match(JSON.parse(fs.readFileSync(path.join(piHome, 'settings.json'), 'utf8')).extensions[0], /harnesses[\\/]pi[\\/]extension\.js$/);
  } finally { fs.rmSync(data, { recursive: true, force: true }); }
});

test('track only points a harness at its home; Pi sessions cannot leave it', () => {
  const data = temp('launch');
  try {
    const piHome = path.join(data, 'harnesses', 'pi', 'home');
    const pi = launchPi({ entry: 'pi.js', args: ['--session', 'abc123'], dataDir: data });
    assert.equal(pi.env?.PI_CODING_AGENT_DIR, piHome);
    assert(!pi.args.includes('--session-dir') && !pi.args.includes('--extension'));
    assert.throws(() => launchPi({ entry: 'pi.js', args: ['--session-dir', 'x'], dataDir: data }), /remove --session-dir/);
    const outside = path.join(os.homedir(), '.pi', 'agent', 'sessions', 'old.jsonl');
    assert.throws(() => launchPi({ entry: 'pi.js', args: ['--session', outside], dataDir: data }), /by its ID/);
    launchPi({ entry: 'pi.js', args: [`--session=${path.join(piHome, 'sessions', 'mine.jsonl')}`], dataDir: data });
    // Any command that prints a version stands in for the claude binary.
    const claude = launchClaudeCode({ command: process.execPath, args: [], dataDir: data, cliPath: 'cli.js' });
    assert.equal(claude.env?.CLAUDE_CONFIG_DIR, path.join(data, 'harnesses', 'claude-code', 'home'));
    assert(!claude.args.includes('--plugin-dir'));
    // A prompt after the MCP config stays the prompt (a new handoff session starts with one).
    const prompted = launchClaudeCode({ command: process.execPath, args: ['Continue the work'], dataDir: data, cliPath: 'cli.js' });
    assert.match(prompted.args.at(-2)!, /^--mcp-config=\{/);
    assert.equal(prompted.args.at(-1), 'Continue the work');
  } finally { fs.rmSync(data, { recursive: true, force: true }); }
});

test('on Windows, a harness installed as an npm or pnpm .cmd shim starts the program the shim names', { skip: process.platform !== 'win32' }, () => {
  const bin = temp('shims');
  const saved = process.env.PATH;
  try {
    const native = path.join(bin, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
    const script = path.join(bin, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
    fs.mkdirSync(path.dirname(native), { recursive: true }); fs.writeFileSync(native, '');
    fs.mkdirSync(path.dirname(script), { recursive: true }); fs.writeFileSync(script, "console.log('codex-cli 0.166.0')");
    // npm's cmd-shim: a native program it starts itself, a script it hands to node.exe beside it or on PATH.
    fs.writeFileSync(path.join(bin, 'claude.cmd'), '@ECHO off\r\n"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*\r\n');
    fs.writeFileSync(path.join(bin, 'codex.cmd'), 'IF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n)\r\n'
      + 'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n');
    // pnpm writes the same path with %~dp0.
    fs.writeFileSync(path.join(bin, 'pi.cmd'), '@"%~dp0\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n');
    process.env.PATH = bin;
    assert.deepEqual(resolveCommand('claude'), { command: native, args: [] });
    assert.deepEqual(resolveCommand('codex'), { command: process.execPath, args: [script] });
    assert.deepEqual(resolveCommand('pi'), { command: process.execPath, args: [script] });
    const codex = resolveCommand('codex');
    assert.match(execFileSync(codex.command, [...codex.args, '--version'], { encoding: 'utf8' }), /codex-cli 0\.166\.0/);
    assert.deepEqual(resolveCommand(path.join(bin, 'codex.cmd')), codex, 'a shim named with --codex-bin is followed too');
    assert.deepEqual(resolveCommand(script), codex, 'a script named directly runs with node');
    // Nothing found: started as named, so it fails the way a harness that is not installed does.
    assert.deepEqual(resolveCommand('wisdom-test-none'), { command: 'wisdom-test-none', args: [] });
  } finally { process.env.PATH = saved; fs.rmSync(bin, { recursive: true, force: true }); }
});

test('a project\'s data folder is found from any folder inside it', () => {
  const root = temp('find');
  try {
    fs.mkdirSync(path.join(root, '.wisdom'));
    fs.mkdirSync(path.join(root, 'src', 'deep'), { recursive: true });
    assert.equal(findDataDir(path.join(root, 'src', 'deep')), undefined, 'a folder without wisdom.json is not a project');
    fs.writeFileSync(path.join(root, '.wisdom', 'wisdom.json'), '{}');
    assert.equal(findDataDir(path.join(root, 'src', 'deep')), path.join(root, '.wisdom'));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('every session is its own record, whatever started it: resumes continue, forks run beside it', async () => {
  const root = temp('route');
  const workspace = path.join(root, 'project'); fs.mkdirSync(workspace);
  const daemon = await startDaemon(path.join(root, 'data'), 0);
  try {
    const c = daemon.connection;
    const say = (sessionId: string, text: string) => call(c, '/observe', { harness: 'codex', cwd: workspace,
      observation: { observationId: randomUUID(), sessionId, type: 'input', turnId: text, data: { text } } });
    const end = (sessionId: string) => call(c, '/observe', { harness: 'codex', cwd: workspace,
      observation: { observationId: randomUUID(), sessionId, type: 'session_ended', data: { reason: 'exit' } } });

    assert.equal((await say('one', 'hello')).captureId, 'one');
    // A fork or a parallel session: its own record, and both keep recording.
    assert.equal((await say('two', 'fresh')).captureId, 'two');
    assert.equal(daemon.captures.get('one').manifest.status, 'recording');
    assert.equal(daemon.captures.get('two').manifest.status, 'recording');
    await end('one');
    assert.equal(daemon.captures.get('one').manifest.endReason, 'session-ended: exit');
    // Codex ends every session it opened when it quits; a session not being watched has nothing to close.
    assert.equal((await end('one')).recorded, false);
    // Resume: same session, same record, its turns continue after a gap.
    assert.equal((await say('one', 'again')).captureId, 'one');

    const glance = (await call(c, '/ledger', { capture: 'one', glance: true })).text;
    assert.match(glance, /^t1  in {8}hello$/m);
    assert.match(glance, /^t2  in {8}again$/m);
    assert.match(glance, /not-recording-between-visits/);
    assert.deepEqual(daemon.captures.database.manifests().map(m => m.captureId).sort(), ['one', 'two']);
  } finally { await daemon.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('events kept while the daemon was down are recorded in order when it comes back, marked late', async () => {
  const root = temp('spool');
  const workspace = path.join(root, 'project'); fs.mkdirSync(workspace);
  const data = path.join(root, 'data');
  const event = (type: string, extra: Record<string, unknown> = {}) => ({ harness: 'claude-code' as const, cwd: workspace,
    observation: { observationId: randomUUID(), sessionId: 'kept', type: type as any, ...extra } });
  spool(data, event('input', { data: { text: 'while down' } }));
  spool(data, event('tool_started', { toolCallId: 'k1', toolName: 'Bash', data: { input: { command: 'ls' } } }));
  spool(data, event('tool_finished', { toolCallId: 'k1', toolName: 'Bash', isError: false, data: { response: 'a' } }));
  const daemon = await startDaemon(data, 0);
  try {
    daemon.captures.drainSpool();
    assert.deepEqual(fs.readdirSync(path.join(data, 'spool')), [], 'a recorded event leaves the spool');
    const records = daemon.captures.get('kept').listRecords();
    assert.deepEqual(records.filter(r => r.spooledAt).map(r => r.type), ['input', 'tool_started', 'tool_finished']);
    const glance = (await call(daemon.connection, '/ledger', { capture: 'kept', glance: true })).text;
    assert.match(glance, /^t1  in {8}while down$/m);
    assert.match(glance, /^ {4}1 tool call · no changes$/m);
    assert.match(glance, /not recorded {2}delivered-late:/);
  } finally { await daemon.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('a daemon restart mid-turn keeps the turn, its calls, its reply and the diff of a tool that runs after', async () => {
  const root = temp('restart');
  const workspace = path.join(root, 'project'); fs.mkdirSync(workspace);
  const file = path.join(workspace, 'a.txt'); fs.writeFileSync(file, 'before\n');
  const data = path.join(root, 'data');
  const event = (type: string, extra: Record<string, unknown> = {}) => ({ harness: 'claude-code' as const, cwd: workspace,
    observation: { observationId: randomUUID(), sessionId: 'mid', type: type as any, ...extra } });
  const edit = { toolName: 'Edit', toolCallId: 'e1' };
  let daemon = await startDaemon(data, 0);
  await call(daemon.connection, '/observe', event('input', { data: { text: 'change it' } }));
  await daemon.close();
  // The hook keeps the tool start and starts the daemon; the tool runs once the hook returns.
  spool(data, event('tool_started', { ...edit, data: { input: { file_path: file } } }));
  // A port another project's daemon holds must not cost the kept event or its baseline.
  const holder = http.createServer().listen(0, '127.0.0.1');
  await once(holder, 'listening');
  await assert.rejects(startDaemon(data, (holder.address() as { port: number }).port), /EADDRINUSE/);
  holder.close();
  daemon = await startDaemon(data, 0);
  try {
    fs.writeFileSync(file, 'after\n');
    await call(daemon.connection, '/observe', event('tool_finished', { ...edit, isError: false, data: { response: 'ok' } }));
    await call(daemon.connection, '/observe', event('agent_settled', { data: { lastAssistantMessage: 'Changed it.' } }));
    const read = async (request: object) => (await call(daemon.connection, '/ledger', { capture: 'mid', ...request })).text;
    const glance = await read({ glance: true });
    assert.match(glance, /^ {4}out {7}Changed it\. \(from hook\)$/m);
    assert.match(glance, /^ {4}1 tool call · changed a\.txt$/m);
    assert.doesNotMatch(glance, /missing-tool-start/);
    assert.match(await read({ open: 't1' }), /^p1  a\.txt · modify · \+1 −1 · observed during c1$/m);
    assert.match(await read({ open: 'outside' }), /Nothing was recorded outside a turn/);

    // A settled turn is not reopened by a later restart.
    await daemon.close();
    daemon = await startDaemon(data, 0);
    await call(daemon.connection, '/observe', event('tool_started', { toolName: 'Bash', toolCallId: 'b1', data: { input: { command: 'ls' } } }));
    assert.match(await read({ open: 'outside' }), /^call {2}Bash/m);
  } finally { await daemon.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('a session file nobody reported becomes a record read from it, its prompts marked as from the file', async () => {
  const root = temp('scan');
  const workspace = path.join(root, 'project'); fs.mkdirSync(workspace);
  const data = path.join(root, 'data');
  const folder = path.join(data, 'harnesses', 'claude-code', 'home', 'projects', 'project');
  fs.mkdirSync(path.join(folder, 'abc', 'subagents'), { recursive: true });
  const line = (value: object) => JSON.stringify({ sessionId: 'abc', cwd: workspace, ...value }) + '\n';
  const file = path.join(folder, 'abc.jsonl');
  const answered = new Date(Date.now() - 9 * 60_000).toISOString();
  fs.writeFileSync(file, line({ type: 'user', uuid: 'u1', message: { role: 'user', content: 'fix the bug' } })
    + line({ type: 'user', uuid: 'u0', isMeta: true, message: { role: 'user', content: 'not typed' } })
    + line({ type: 'assistant', uuid: 'a1', timestamp: answered,
      message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'Fixed it.' }], usage: { input_tokens: 10, output_tokens: 5 } } })
    + line({ type: 'user', uuid: 'u2', toolUseResult: {}, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }] } }));
  // A subagent's file is not a session.
  fs.writeFileSync(path.join(folder, 'abc', 'subagents', 'agent-1.jsonl'), line({ type: 'user', message: { role: 'user', content: 'task' } }));
  const quiet = new Date(Date.now() - 10 * 60_000);
  fs.utimesSync(file, quiet, quiet);
  const daemon = await startDaemon(data, 0);
  try {
    daemon.captures.scan();
    assert.deepEqual(daemon.captures.database.manifests().map(m => m.captureId), ['abc']);
    const manifest = daemon.captures.get('abc').manifest;
    assert.equal(manifest.status, 'closed');
    assert.equal(manifest.endReason, 'found-in-session-file');
    assert.equal(manifest.workspaceRoot, fs.realpathSync(workspace));
    // Dated from its file's first dated line, not from when the scan reached it, so its usage counts.
    assert.equal(manifest.startedAt, answered);
    const glance = (await call(daemon.connection, '/ledger', { capture: 'abc', glance: true })).text;
    assert.match(glance, /· 15 tokens/);
    assert.match(glance, /^t1  in \(from session file\)  fix the bug$/m);
    assert.match(glance, /^ {4}out {7}Fixed it\.$/m);
    assert.doesNotMatch(glance, /not typed/);
    assert.match(glance, /not recorded {2}not-recorded-live:/);

    // Lines the session gained while nothing recorded are read once the file is quiet again.
    fs.appendFileSync(file, line({ type: 'user', uuid: 'u3', message: { role: 'user', content: 'and the test' } }));
    fs.utimesSync(file, quiet, quiet);
    daemon.captures.scan();
    assert.match((await call(daemon.connection, '/ledger', { capture: 'abc', glance: true })).text, /^t2  in \(from session file\)  and the test$/m);
  } finally { await daemon.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('when the harness moves the session file, the copy follows it from the same position', async () => {
  const root = temp('move');
  const workspace = path.join(root, 'project'); fs.mkdirSync(workspace);
  const daemon = await startDaemon(path.join(root, 'data'), 0);
  try {
    const first = path.join(root, 'first.jsonl'), moved = path.join(root, 'moved.jsonl');
    const line = (uuid: string) => JSON.stringify({ type: 'system', sessionId: 'mv', uuid }) + '\n';
    fs.writeFileSync(first, line('l1'));
    const send = (source: string, type = 'agent_settled') => call(daemon.connection, '/observe', { harness: 'claude-code', cwd: workspace,
      observation: { observationId: randomUUID(), sessionId: 'mv', source, type } });
    await send(first, 'session_started');
    fs.writeFileSync(moved, line('l1') + line('l2'));
    await send(moved);
    const ledger = daemon.captures.get('mv');
    assert.equal(ledger.manifest.source, moved);
    assert.equal(fs.readFileSync(ledger.mirror, 'utf8'), line('l1') + line('l2'));
    assert.match(ledger.listRecords().find(r => r.type === 'source_moved')!.summary, /copying continues at byte \d+/);
  } finally { await daemon.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('resume finds a session only by its full ID', async () => {
  const root = temp('resolve');
  const workspace = path.join(root, 'project'); fs.mkdirSync(workspace);
  const daemon = await startDaemon(path.join(root, 'data'), 0);
  try {
    const c = daemon.connection;
    // UUIDv7 session IDs started within a minute share their first 8 characters.
    for (const sessionId of ['01a1836b-aaaa', '01a1836b-bbbb']) {
      await call(c, '/observe', { harness: 'codex', cwd: workspace, observation: { observationId: randomUUID(), sessionId, type: 'session_started' } });
    }
    const resolved = await call(c, '/resolve', { session: '01a1836b-bbbb' });
    // Its transcript's place says which home it resumes in; none was reported here.
    assert.deepEqual(resolved, { captureId: '01a1836b-bbbb', harness: 'codex', workspaceRoot: fs.realpathSync(workspace), source: null });
    for (const partial of ['01a1836b', '01a1836b-b', 'latest']) {
      await assert.rejects(call(c, '/resolve', { session: partial }), /No recorded session has the ID/);
    }
    const glance = (await call(c, '/ledger', { capture: '01a1836b-aaaa', glance: true })).text;
    assert.match(glance, /^resume with: wisdom resume 01a1836b-aaaa$/m);
  } finally { await daemon.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('a found fork does not count its parent\'s copied prompts as its own turns', async () => {
  const root = temp('fork');
  const workspace = path.join(root, 'project'); fs.mkdirSync(workspace);
  const data = path.join(root, 'data');
  const folder = path.join(data, 'harnesses', 'claude-code', 'home', 'projects', 'project');
  fs.mkdirSync(folder, { recursive: true });
  const user = (session: string, uuid: string, content: string, timestamp: string) => JSON.stringify({ type: 'user', sessionId: session, cwd: workspace, uuid, timestamp, version: '9.8.7', message: { role: 'user', content } }) + '\n';
  const quiet = new Date(Date.now() - 10 * 60_000);
  const write = (name: string, text: string) => { fs.writeFileSync(path.join(folder, name), text); fs.utimesSync(path.join(folder, name), quiet, quiet); };
  const first = user('parent', 'u1', 'parent prompt', '2026-01-01T10:00:00.000Z');
  write('parent.jsonl', first + user('parent', 'u2', 'parent later', '2026-01-01T10:10:00.000Z'));
  // Claude Code's first dated line in a fork is newer than the history it then copies.
  write('fork.jsonl', JSON.stringify({ type: 'queue-operation', sessionId: 'fork', timestamp: '2026-01-01T10:05:00.000Z' }) + '\n' + first.replaceAll('"parent"', '"fork"')
    + JSON.stringify({ type: 'user', sessionId: 'fork', uuid: 'u9', timestamp: '2026-01-01T10:05:00.100Z', queueTranscriptOnly: true, message: { role: 'user', content: '<task-notification><fork-source>began as a fork</fork-source></task-notification>' } }) + '\n'
    + user('fork', 'u3', 'fork prompt', '2026-01-01T10:06:00.000Z'));
  const daemon = await startDaemon(data, 0);
  try {
    daemon.captures.scan();
    const glance = async (capture: string) => (await call(daemon.connection, '/ledger', { capture, glance: true })).text;
    const fork = await glance('fork');
    assert.match(fork, /^t1  in \(from session file\)  fork prompt$/m);
    assert.doesNotMatch(fork, /^t\d+ +in.*parent prompt$/m);
    assert.doesNotMatch(fork, /^t2 /m);
    assert.match(fork, /history-from-another-session:1 prompt at the start of this file also appear in parent/);
    assert.match(await glance('parent'), /^t1  in \(from session file\)  parent prompt$/m, 'the older session keeps its own turns');
    assert.equal(daemon.captures.get('fork').manifest.startedAt, '2026-01-01T10:05:00.000Z');
    assert.equal(daemon.captures.get('fork').manifest.harnessVersion, '9.8.7');
    assert.match(fork, /^session fork · claude-code 9\.8\.7 · /m);
    assert(fs.readFileSync(path.join(daemon.captures.get('fork').dir, 'native-session.jsonl'), 'utf8').includes('parent prompt'), 'copied lines stay in the byte copy');
  } finally { await daemon.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('latest is the newest session with a turn; a session nobody prompted stays listed', async () => {
  const root = temp('latest');
  const workspace = path.join(root, 'project'); fs.mkdirSync(workspace);
  const daemon = await startDaemon(path.join(root, 'data'), 0);
  try {
    const c = daemon.connection;
    const send = (sessionId: string, type: string, data?: unknown) => call(c, '/observe', { harness: 'claude-code', cwd: workspace, observation: { observationId: randomUUID(), sessionId, type, data } });
    await send('empty-one', 'session_started');
    assert.match((await call(c, '/ledger', { capture: 'latest', glance: true })).text, /^session empty-one /m, 'with no turns anywhere, the newest session');
    await send('real', 'input', { text: 'hello' });
    await new Promise(resolve => setTimeout(resolve, 5));
    await send('empty-two', 'session_started');
    assert.match((await call(c, '/ledger', { capture: 'latest', glance: true })).text, /^session real /m);
    assert.match((await call(c, '/ledger', { glance: true })).text, /^empty-two /m);
  } finally { await daemon.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('a moved project keeps recording: sessions follow it and say so; no second project appears', async () => {
  const root = temp('moved');
  const before = path.join(root, 'before'), after = path.join(root, 'after');
  fs.mkdirSync(path.join(before, '.wisdom'), { recursive: true });
  fs.writeFileSync(path.join(before, '.wisdom', marker), JSON.stringify({ project: before, createdAt: 'then' }));
  fs.writeFileSync(path.join(before, 'a.txt'), 'one\n');
  const send = (daemon: any, cwd: string, type: string, extra = {}) => call(daemon.connection, '/observe', { harness: 'claude-code', cwd, observation: { observationId: randomUUID(), sessionId: 's', type, ...extra } });
  let daemon = await startDaemon(path.join(before, '.wisdom'), 0);
  await send(daemon, before, 'input', { data: { text: 'first' } });
  await daemon.close();
  fs.renameSync(before, after);
  daemon = await startDaemon(path.join(after, '.wisdom'), 0);
  try {
    const manifest = daemon.captures.get('s').manifest;
    assert.equal(manifest.workspaceRoot, fs.realpathSync(after));
    assert.equal(JSON.parse(fs.readFileSync(path.join(after, '.wisdom', marker), 'utf8')).project, path.resolve(after));
    await send(daemon, after, 'input', { data: { text: 'second' } });
    const started = { toolCallId: 'k', toolName: 'Write', data: { input: { file_path: path.join(after, 'a.txt') } } };
    await send(daemon, after, 'tool_started', started);
    fs.writeFileSync(path.join(after, 'a.txt'), 'two\n');
    await send(daemon, after, 'tool_finished', { ...started, isError: false });
    const glance = (await call(daemon.connection, '/ledger', { capture: 's', glance: true })).text;
    assert.match(glance, /project-moved:The project moved/);
    assert.match(glance, /^t2  in {8}second$/m);
    assert.match(glance, /1 tool call · changed a\.txt/);
    assert.doesNotMatch(glance, /outside-watched-folder/);
    assert.equal((await call(daemon.connection, '/view', { view: 'project', workspaceRoot: after })).sessions.length, 1);
  } finally { await daemon.close(); }

  // The hook names the old folder. The home it runs in wins, and the old folder is never recreated.
  const home = path.join(after, '.wisdom', 'harnesses', 'claude-code', 'home');
  assert.equal(hookDataDir('claude-code', home, before + '/.wisdom'), path.join(after, '.wisdom'));
  assert.throws(() => hookDataDir('claude-code', undefined, before + '/.wisdom'), /no longer exists/);
  assert.equal(hookDataDir('claude-code', os.homedir() + '/.claude', after + '/.wisdom'), after + '/.wisdom', 'a home outside any project changes nothing');
  const hook = path.resolve('integrations', 'claude-code', 'hook.mjs');
  const run = spawnSync(process.execPath, [hook, path.join(before, '.wisdom')], { encoding: 'utf8', env: { ...process.env, CLAUDE_CONFIG_DIR: '' },
    input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 's', cwd: after, prompt: 'x' }) });
  assert.equal(run.status, 1); assert.match(run.stderr, /no longer exists/);
  assert(!fs.existsSync(before), 'a moved project leaves nothing behind at the old path');
  fs.rmSync(root, { recursive: true, force: true });
});

test('hooks pointing at a build that has moved are named; ones that exist are not', () => {
  const data = temp('stale');
  try {
    assert.deepEqual(staleHooks(data), []);
    installClaudeCode(data); installPi(data);
    assert.deepEqual(staleHooks(data), []);
    const file = path.join(data, 'harnesses', 'claude-code', 'home', 'settings.json');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replaceAll('integrations/claude-code/hook.mjs', 'gone/integrations/claude-code/hook.mjs'));
    assert.deepEqual(staleHooks(data), ['claude-code']);
  } finally { fs.rmSync(data, { recursive: true, force: true }); }
});

test('forks that start at their parent\'s first line are still told apart', async () => {
  const root = temp('tie');
  const workspace = path.join(root, 'project'); fs.mkdirSync(workspace);
  const data = path.join(root, 'data');
  const folder = path.join(data, 'harnesses', 'claude-code', 'home', 'projects', 'project');
  fs.mkdirSync(folder, { recursive: true });
  const user = (session: string, uuid: string, content: string, timestamp: string, extra = {}) => JSON.stringify({ type: 'user', sessionId: session, cwd: workspace, uuid, timestamp, ...extra, message: { role: 'user', content } }) + '\n';
  const answer = (session: string, id: string, timestamp: string) => JSON.stringify({ type: 'assistant', sessionId: session, uuid: id, timestamp, message: { id, role: 'assistant', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 10, output_tokens: 5 } } }) + '\n';
  const quiet = new Date(Date.now() - 10 * 60_000);
  const write = async (name: string, text: string) => { fs.writeFileSync(path.join(folder, name), text); fs.utimesSync(path.join(folder, name), quiet, quiet); await new Promise(resolve => setTimeout(resolve, 30)); };
  const start = '2026-01-01T10:00:00.000Z';
  // /branch names its parent; --fork-session does not, so the older file is the one made first.
  await write('zz-parent.jsonl', user('zz-parent', 'u1', 'parent prompt', start) + answer('zz-parent', 'm1', '2026-01-01T10:00:05.000Z'));
  const copied = (session: string, extra = {}) => user(session, 'u1', 'parent prompt', start, extra) + answer(session, 'm1', '2026-01-01T10:00:05.000Z');
  await write('aa-branch.jsonl', copied('aa-branch', { forkedFrom: { sessionId: 'zz-parent', messageUuid: 'u1' } })
    + user('aa-branch', 'u2', 'branch prompt', '2026-01-01T10:10:00.000Z') + answer('aa-branch', 'm2', '2026-01-01T10:10:05.000Z'));
  await write('ab-fork.jsonl', copied('ab-fork') + user('ab-fork', 'u3', 'fork prompt', '2026-01-01T10:20:00.000Z') + answer('ab-fork', 'm3', '2026-01-01T10:20:05.000Z'));
  const daemon = await startDaemon(data, 0);
  try {
    daemon.captures.scan();
    const glance = async (capture: string) => (await call(daemon.connection, '/ledger', { capture, glance: true })).text;
    for (const [session, prompt] of [['aa-branch', 'branch prompt'], ['ab-fork', 'fork prompt']] as const) {
      const text = await glance(session);
      assert.match(text, new RegExp(`^t1  in \\(from session file\\)  ${prompt}$`, 'm'));
      assert.doesNotMatch(text, /^t2 /m);
      assert.match(text, /· 15 tokens/, 'the copied response is the parent\'s, not counted again');
      assert.notEqual(daemon.captures.get(session).manifest.startedAt, start, 'dated from its own first line');
    }
    assert.match(await glance('zz-parent'), /^t1  in \(from session file\)  parent prompt$/m);
  } finally { await daemon.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('a harness notice is a turn in both readings, says what it is, and is not a request', async () => {
  const root = temp('notice');
  const workspace = path.join(root, 'project'); fs.mkdirSync(workspace);
  const data = path.join(root, 'data');
  const folder = path.join(data, 'harnesses', 'claude-code', 'home', 'projects', 'project');
  fs.mkdirSync(folder, { recursive: true });
  const notice = '<task-notification>\n<status>completed</status>\n</task-notification>';
  const file = path.join(folder, 'found.jsonl');
  fs.writeFileSync(file, JSON.stringify({ type: 'user', sessionId: 'found', cwd: workspace, uuid: 'n1', timestamp: '2026-01-01T10:00:00.000Z', message: { role: 'user', content: notice } }) + '\n');
  const quiet = new Date(Date.now() - 10 * 60_000); fs.utimesSync(file, quiet, quiet);
  const daemon = await startDaemon(data, 0);
  try {
    const c = daemon.connection;
    const send = (text: string) => call(c, '/observe', { harness: 'claude-code', cwd: workspace, observation: { observationId: randomUUID(), sessionId: 'live', type: 'input', data: { text } } });
    await send('a real prompt');
    await send(notice);
    daemon.captures.scan();
    const live = (await call(c, '/ledger', { capture: 'live', glance: true })).text;
    assert.match(live, /^t1  in {8}a real prompt$/m);
    assert.match(live, /^t2  in \(harness notice\)\n/m);
    assert.match((await call(c, '/ledger', { capture: 'found', glance: true })).text, /^t1  in \(harness notice, from session file\)\n/m);
    const stats = await call(c, '/view', { view: 'project', workspaceRoot: workspace });
    assert.equal(stats.sessions.find((s: any) => s.captureId === 'live').requests, 1);
  } finally { await daemon.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('a cost the harness reported before later model calls says so, and a later report clears it', async () => {
  const root = temp('cost');
  const workspace = path.join(root, 'project'); fs.mkdirSync(workspace);
  const source = path.join(root, 'session.jsonl');
  const now = () => new Date().toISOString();
  const answer = (id: string) => JSON.stringify({ type: 'assistant', sessionId: 'c', uuid: id, timestamp: now(), message: { id, role: 'assistant', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 10, output_tokens: 5 } } }) + '\n';
  const cost = (value: number) => JSON.stringify({ type: 'cost-state', sessionId: 'c', totalCostUSD: value }) + '\n';
  const daemon = await startDaemon(path.join(root, 'data'), 0);
  try {
    const c = daemon.connection;
    const send = () => call(c, '/observe', { harness: 'claude-code', cwd: workspace, observation: { observationId: randomUUID(), sessionId: 'c', source, type: 'agent_settled' } });
    const read = async () => ({ glance: (await call(c, '/ledger', { capture: 'c', glance: true })).text, tokens: (await call(c, '/view', { view: 'project', workspaceRoot: workspace })).sessions[0].tokens });
    await new Promise(resolve => setTimeout(resolve, 5));
    fs.writeFileSync(source, cost(0.5));
    await send();
    fs.appendFileSync(source, answer('m1') + answer('m2'));
    await send();
    let seen = await read();
    assert.match(seen.glance, /\$0\.5000 reported before the last 2 model calls/);
    assert.equal(seen.tokens.costBehind, true);
    fs.appendFileSync(source, cost(0.9));
    await send();
    seen = await read();
    assert.match(seen.glance, /\$0\.9000 reported( ·|$)/m);
    assert.equal(seen.tokens.costBehind, undefined);
  } finally { await daemon.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

/** A linked worktree as git lays it out: a `.git` file naming the main repository. */
function fakeWorktree(main: string, name: string, branch: string, files: Record<string, string>, root = path.join(main, '.claude', 'worktrees', name)): string {
  const gitDir = path.join(main, '.git', 'worktrees', name);
  fs.mkdirSync(gitDir, { recursive: true }); fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(gitDir, 'HEAD'), `ref: refs/heads/${branch}\n`);
  fs.writeFileSync(path.join(root, '.git'), `gitdir: ${gitDir.replaceAll('\\', '/')}\n`);
  for (const [file, text] of Object.entries(files)) fs.writeFileSync(path.join(root, file), text);
  return fs.realpathSync(root);
}

test('a session records the worktree it works in by name and branch, not its checkout; another session marks it once', async () => {
  const root = temp('worktree');
  const main = path.join(root, 'project');
  fs.mkdirSync(path.join(main, '.git'), { recursive: true });
  fs.writeFileSync(path.join(main, 'base.txt'), 'base\n');
  const daemon = await startDaemon(path.join(main, '.wisdom'), 0);
  try {
    const c = daemon.connection;
    const send = (sessionId: string, cwd: string, type: string, extra = {}) => call(c, '/observe', { harness: 'claude-code', cwd, observation: { observationId: randomUUID(), sessionId, type, ...extra } });
    const glance = async (capture: string) => (await call(c, '/ledger', { capture, glance: true })).text;
    await send('watcher', main, 'input', { data: { text: 'stay in the project' } });

    // A session enters a worktree partway through, the way EnterWorktree does.
    await send('mover', main, 'input', { data: { text: 'enter' } });
    await send('mover', main, 'tool_started', { toolCallId: 'e', toolName: 'EnterWorktree', data: { input: { name: 'wt' } } });
    const tree = fakeWorktree(fs.realpathSync(main), 'wt', 'worktree-wt', { 'base.txt': 'base\n' });
    await new Promise(resolve => setTimeout(resolve, 150));
    await send('mover', tree, 'tool_finished', { toolCallId: 'e', toolName: 'EnterWorktree', isError: false });
    const write = { toolCallId: 'w', toolName: 'Write', data: { input: { file_path: path.join(tree, 'w.txt') } } };
    await send('mover', tree, 'tool_started', write);
    fs.writeFileSync(path.join(tree, 'w.txt'), 'whiskey\n');
    await send('mover', tree, 'tool_finished', { ...write, isError: false });
    await new Promise(resolve => setTimeout(resolve, 700));

    const mover = await glance('mover');
    assert.match(mover, /1 change/, 'the checkout is not logged as changes');
    assert.match(mover, /changed w\.txt in worktree wt/);
    assert.match(mover, /worktree-entered:Watching worktree wt/);
    assert.doesNotMatch(mover, /\.claude\/worktrees/);
    assert.match((await call(c, '/ledger', { capture: 'mover', open: 't1' })).text, /^p1 {2}w\.txt in worktree wt \(branch worktree-wt\) · create · \+1 −0 · observed during c2$/m);

    // A session started in a worktree belongs to the project; its file there has a plain path.
    await send('starter', tree, 'input', { data: { text: 'start here' } });
    assert.equal(daemon.captures.get('starter').manifest.workspaceRoot, fs.realpathSync(main));
    const write2 = { toolCallId: 'h', toolName: 'Write', data: { input: { file_path: path.join(tree, 'h.txt') } } };
    await send('starter', tree, 'tool_started', write2);
    fs.writeFileSync(path.join(tree, 'h.txt'), 'hotel\n');
    await send('starter', tree, 'tool_finished', { ...write2, isError: false });
    const starter = await glance('starter');
    assert.match(starter, /changed h\.txt in worktree wt/);
    assert.doesNotMatch(starter, /worktree-entered|outside-watched-folder/);
    assert.equal((await call(c, '/view', { view: 'projects' })).projects.length, 1, 'the project does not split');

    // The session that stayed in the project has no diffs from there, and says files changed.
    await new Promise(resolve => setTimeout(resolve, 700));
    const watcher = await glance('watcher');
    assert.match(watcher, /other-worktree:Files changed in worktree wt/);
    assert.match(watcher, /0 changes/);
    assert.equal(watcher.match(/other-worktree/g)!.length, 1);
  } finally { await daemon.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('a worktree outside the project folder is watched without an outside gap; a submodule stays in its project', async () => {
  const root = temp('external');
  const main = path.join(root, 'project');
  fs.mkdirSync(path.join(main, '.git'), { recursive: true });
  // A submodule's .git file names a module, not a worktree.
  fs.mkdirSync(path.join(main, 'sub'));
  fs.writeFileSync(path.join(main, 'sub', '.git'), 'gitdir: ../.git/modules/sub\n');
  const daemon = await startDaemon(path.join(main, '.wisdom'), 0);
  try {
    const c = daemon.connection;
    const send = (cwd: string, type: string, extra = {}) => call(c, '/observe', { harness: 'codex', cwd, observation: { observationId: randomUUID(), sessionId: 's', type, ...extra } });
    await send(main, 'input', { data: { text: 'go' } });
    const tree = fakeWorktree(fs.realpathSync(main), 'away', 'away-branch', {}, path.join(root, 'away'));
    const write = { toolCallId: 'a', toolName: 'apply_patch', data: { input: {} } };
    await send(tree, 'tool_started', write);
    fs.writeFileSync(path.join(tree, 'a.txt'), 'x\n');
    fs.writeFileSync(path.join(main, 'sub', 'b.txt'), 'y\n');
    await send(tree, 'tool_finished', { ...write, isError: false });
    const glance = (await call(c, '/ledger', { capture: 's', glance: true })).text;
    assert.match(glance, /a\.txt in worktree away/);
    assert.match(glance, /sub\/b\.txt/);
    assert.doesNotMatch(glance, /outside-watched-folder/);
  } finally { await daemon.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('run through PowerShell with its output piped, as Codex runs it, a hook that starts the daemon returns at once and the daemon survives', { skip: process.platform !== 'win32' }, async () => {
  const { spawn } = await import('node:child_process');
  const root = temp('hang');
  const data = path.join(root, 'data'); fs.mkdirSync(data);
  const hook = path.resolve('integrations', 'codex', 'hook.mjs').replaceAll('\\', '/');
  const started = Date.now();
  const child = spawn('powershell.exe', ['-NoProfile', '-Command', `node "${hook}" "${data.replaceAll('\\', '/')}"`], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.end(JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 'hang', turn_id: 't', cwd: root, prompt: 'hi' }));
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.resume();
  // The output pipe closing is what Codex waits for.
  await once(child.stdout, 'end');
  const seconds = (Date.now() - started) / 1000;
  try {
    assert(seconds < 10, `the hook's output stayed open for ${seconds} s`);
    assert.equal(output, '{}');
    await new Promise(resolve => setTimeout(resolve, 1500));
    const connection = connectionAt(data);
    assert.equal((await call(connection, '/health')).status, 'running');
    assert.match((await call(connection, '/ledger', { capture: 'hang', glance: true })).text, /^t1  in {8}hi$/m);
  } finally {
    await call(connectionAt(data), '/stop', {}).catch(() => undefined);
    for (let i = 0; i < 100 && fs.existsSync(path.join(data, 'daemon.json')); i++) await new Promise(resolve => setTimeout(resolve, 100));
    await new Promise(resolve => setTimeout(resolve, 500));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
