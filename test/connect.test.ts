import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { call } from '../src/client.js';
import { startDaemon } from '../src/daemon.js';
import { connect, disconnect } from '../src/connect.js';
import { adapter, resumeCommands, sessionPlace, userHome } from '../src/harnesses/index.js';
import { hookState } from '../src/harnesses/launch.js';
import { connectedFile, harnessHome, marker, readConnected } from '../src/paths.js';

const hasGit = spawnSync('git', ['--version'], { windowsHide: true }).status === 0;
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
const json = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8'));

function project(name: string) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `wisdom-connect-${name}-`)));
  const data = path.join(root, '.wisdom');
  fs.mkdirSync(data);
  fs.writeFileSync(path.join(data, marker), JSON.stringify({ project: root }));
  return { root, data };
}

test('connect puts Wisdom in the project\'s own settings, kept out of git; disconnect takes out exactly that', { skip: !hasGit }, () => {
  const { root, data } = project('files');
  try {
    git(root, 'init', '-q');
    const excludeFile = path.join(root, '.git', 'info', 'exclude');
    const gitsOwn = fs.readFileSync(excludeFile, 'utf8');
    // The person's own local Claude Code settings, and a Pi settings file the team commits.
    const theirs = { hooks: [{ type: 'command', command: 'echo mine' }] };
    const local = { permissions: { allow: ['Bash(ls)'] }, hooks: { Stop: [theirs] } };
    fs.mkdirSync(path.join(root, '.claude'));
    fs.writeFileSync(path.join(root, '.claude', 'settings.local.json'), JSON.stringify(local));
    fs.mkdirSync(path.join(root, '.pi'));
    fs.writeFileSync(path.join(root, '.pi', 'settings.json'), '{"theme":"dark"}');
    git(root, 'add', '.pi/settings.json');

    const first = connect(data, ['claude-code', 'codex', 'pi'], new Date('2026-11-07T10:00:00.000Z'));
    assert.deepEqual(first.connected, ['claude-code', 'codex']);
    assert.deepEqual(first.tracked, [path.join(root, '.pi', 'settings.json')], 'a file git tracks would carry this machine\'s paths to teammates');
    assert.equal(fs.readFileSync(path.join(root, '.pi', 'settings.json'), 'utf8'), '{"theme":"dark"}');

    const claude = json(path.join(root, '.claude', 'settings.local.json'));
    assert.deepEqual(claude.permissions, local.permissions);
    assert.deepEqual(claude.hooks.Stop[0], theirs);
    assert.match(claude.hooks.PreToolUse[0].hooks[0].command, /^node ".*integrations\/claude-code\/hook\.mjs" ".*" project$/);
    assert.equal(claude.hooks.PreToolUse[0].matcher, '*');
    assert.match(json(path.join(root, '.codex', 'hooks.json')).hooks.SessionStart[0].hooks[0].command, /integrations\/codex\/hook\.mjs" ".*" project$/);
    for (const folder of ['.claude', '.agents']) assert(fs.existsSync(path.join(root, folder, 'skills', 'wisdom-ledger', 'SKILL.md')));
    assert.equal(hookState(data, 'claude-code', 'project'), 'current');
    assert.equal(hookState(data, 'claude-code', 'home'), 'none', 'connect leaves wisdom track\'s homes alone');

    const exclude = fs.readFileSync(path.join(root, '.git', 'info', 'exclude'), 'utf8');
    for (const pattern of ['/.claude/settings.local.json', '/.codex/hooks.json', '/.claude/skills/wisdom-ledger/', '/.agents/skills/wisdom-ledger/']) {
      assert(exclude.split('\n').includes(pattern), pattern);
    }
    assert.doesNotMatch(git(root, 'status', '--porcelain', '--untracked-files=all'), /\.claude|\.codex|\.agents/);
    assert.deepEqual(readConnected(data)['claude-code'], { since: '2026-11-07T10:00:00.000Z', home: userHome('claude-code') });

    // Connecting again repairs without doubling anything, and keeps the first connection time.
    connect(data, ['claude-code', 'codex'], new Date('2026-11-08T10:00:00.000Z'));
    assert.equal(json(path.join(root, '.claude', 'settings.local.json')).hooks.Stop.length, 2);
    assert.equal(fs.readFileSync(path.join(root, '.git', 'info', 'exclude'), 'utf8').split('# wisdom connect').length, 2);
    assert.equal(readConnected(data)['claude-code']?.since, '2026-11-07T10:00:00.000Z');

    assert.deepEqual(disconnect(data), ['claude-code', 'codex']);
    assert.deepEqual(json(path.join(root, '.claude', 'settings.local.json')), local);
    assert(!fs.existsSync(path.join(root, '.codex')), 'a folder only Wisdom used is removed');
    assert(!fs.existsSync(path.join(root, '.agents')));
    assert(!fs.existsSync(path.join(root, '.claude', 'skills')));
    assert.equal(fs.readFileSync(path.join(root, '.pi', 'settings.json'), 'utf8'), '{"theme":"dark"}');
    assert.equal(fs.readFileSync(excludeFile, 'utf8'), gitsOwn, 'git\'s own exclude file is back exactly as it was');
    assert(!fs.existsSync(connectedFile(data)));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('the project\'s copy of the hook stands aside in a tracked session, so nothing is recorded twice', async () => {
  const { root, data } = project('aside');
  const daemon = await startDaemon(data, 0);
  try {
    const hook = path.resolve('integrations', 'claude-code', 'hook.mjs');
    // Run apart from this process, which serves the daemon the hook reports to.
    const run = (session: string, home: string) => new Promise<number | null>(resolve => {
      const child = spawn(process.execPath, [hook, data, 'project'], { windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'],
        env: { ...process.env, CLAUDE_CONFIG_DIR: home } });
      child.on('exit', resolve);
      child.stdin.end(JSON.stringify({ session_id: session, cwd: root, hook_event_name: 'UserPromptSubmit', prompt: 'hello' }));
    });
    // Tracked: Claude Code's home is Wisdom's, whose own copy of the hook records the session.
    assert.equal(await run('tracked-session', harnessHome(data, 'claude-code')), 0);
    // Connected: the person's own home, so the project's copy is the one that records.
    assert.equal(await run('connected-session', ''), 0);
    const sessions = (await call(daemon.connection, '/ledger', { glance: true })).text;
    assert.doesNotMatch(sessions, /tracked-session/);
    assert.match(sessions, /connected-session/);
  } finally { await daemon.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('a connected harness\'s own home gives this project\'s sessions since connecting, and nothing else', async () => {
  const { root, data } = project('scan');
  const own = fs.mkdtempSync(path.join(os.tmpdir(), 'wisdom-own-home-'));
  const other = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wisdom-other-project-')));
  const since = new Date(Date.now() - 30 * 60_000);
  fs.writeFileSync(connectedFile(data), JSON.stringify({ 'claude-code': { since: since.toISOString(), home: own } }));
  const session = (id: string, cwd: string, minutesAgo: number) => {
    const file = adapter('claude-code').sessionFile(own, id, cwd, new Date());
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ type: 'user', sessionId: id, cwd, uuid: `${id}-u1`, timestamp: new Date().toISOString(),
      message: { role: 'user', content: `asked in ${id}` } }) + '\n');
    const when = new Date(Date.now() - minutesAgo * 60_000);
    fs.utimesSync(file, when, when);
  };
  session('here-since', root, 10);
  session('here-before', root, 60);
  session('elsewhere', other, 10);
  const daemon = await startDaemon(data, 0);
  try {
    daemon.captures.scan();
    const sessions = (await call(daemon.connection, '/ledger', { glance: true })).text;
    assert.match(sessions, /here-since/);
    assert.doesNotMatch(sessions, /here-before/, 'what ran before connecting is not taken');
    assert.doesNotMatch(sessions, /elsewhere/, 'another project\'s session in the same home is not taken');
    const found = daemon.captures.get('here-since').manifest;
    // It ran in the person's own home, so it resumes there, without Wisdom's home.
    assert.equal(sessionPlace(data, 'claude-code', found.source), 'project');
    assert.doesNotMatch(resumeCommands(data, 'claude-code', 'here-since', root, found.source).powershell, /CLAUDE_CONFIG_DIR/);
    assert.match(resumeCommands(data, 'claude-code', 'x', root, path.join(harnessHome(data, 'claude-code'), 'projects', 'x.jsonl')).powershell, /CLAUDE_CONFIG_DIR/);
  } finally {
    await daemon.close();
    for (const dir of [root, own, other]) fs.rmSync(dir, { recursive: true, force: true });
  }
});
