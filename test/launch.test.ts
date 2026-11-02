import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { installPi, launchPi } from '../src/harnesses/pi/launch.js';
import { installClaudeCode, launchClaudeCode } from '../src/harnesses/claude-code/launch.js';
import { installCodex } from '../src/harnesses/codex/launch.js';
import { startDaemon } from '../src/daemon.js';
import { call, spool } from '../src/client.js';
import { findDataDir } from '../src/paths.js';

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
  } finally { fs.rmSync(data, { recursive: true, force: true }); }
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

test('a session file nobody reported becomes a record read from it, its prompts marked as from the file', async () => {
  const root = temp('scan');
  const workspace = path.join(root, 'project'); fs.mkdirSync(workspace);
  const data = path.join(root, 'data');
  const folder = path.join(data, 'harnesses', 'claude-code', 'home', 'projects', 'project');
  fs.mkdirSync(path.join(folder, 'abc', 'subagents'), { recursive: true });
  const line = (value: object) => JSON.stringify({ sessionId: 'abc', cwd: workspace, ...value }) + '\n';
  const file = path.join(folder, 'abc.jsonl');
  fs.writeFileSync(file, line({ type: 'user', uuid: 'u1', message: { role: 'user', content: 'fix the bug' } })
    + line({ type: 'user', uuid: 'u0', isMeta: true, message: { role: 'user', content: 'not typed' } })
    + line({ type: 'assistant', uuid: 'a1', message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'Fixed it.' }] } })
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
    const glance = (await call(daemon.connection, '/ledger', { capture: 'abc', glance: true })).text;
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
    assert.deepEqual(resolved, { captureId: '01a1836b-bbbb', harness: 'codex', workspaceRoot: fs.realpathSync(workspace) });
    for (const partial of ['01a1836b', '01a1836b-b', 'latest']) {
      await assert.rejects(call(c, '/resolve', { session: partial }), /No recorded session has the ID/);
    }
    const glance = (await call(c, '/ledger', { capture: '01a1836b-aaaa', glance: true })).text;
    assert.match(glance, /^resume with: wisdom resume 01a1836b-aaaa$/m);
  } finally { await daemon.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
