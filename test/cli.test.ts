import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { call } from '../src/service/client.js';
import { startDaemon } from '../src/service/daemon.js';

const bin = fileURLToPath(new URL('../src/bin.js', import.meta.url));
const run = (cwd: string, ...args: string[]) => spawnSync(process.execPath, [bin, ...args], { cwd, encoding: 'utf8', windowsHide: true });
const temp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wisdom-cli-')));
const none = ['--claude-bin', 'wisdom-test-none', '--codex-bin', 'wisdom-test-none', '--pi-entry', 'wisdom-test-none'];

test('a person reads plain sentences from init, status and stop, never JSON', () => {
  const project = temp();
  try {
    const init = run(project, 'init', '--port', '0', ...none);
    assert.equal(init.status, 0, init.stderr);
    assert.equal(init.stdout, [
      `Wisdom is set up in ${project}`,
      'Settings: wisdom.yaml, every default shown and commented out.',
      '',
      'Start an agent:',
      '  Claude Code  not installed. Run wisdom init again after installing it.',
      '  Codex        not installed. Run wisdom init again after installing it.',
      '  Pi           not installed. Run wisdom init again after installing it.',
      '',
      'Dashboard: not started. Not started with this daemon.',
      'Commits:   not started. Not started with this daemon.',
      '',
      'Each agent asks you to log in once for this project. Your global agent settings are not touched.',
      'Keep .wisdom/ private: it holds your sessions and agent logins, unredacted. Git ignores it, but leave it out of zips and synced folders.',
      '',
    ].join('\n'));
    assert.match(fs.readFileSync(path.join(project, '.gitignore'), 'utf8'), /\.wisdom\//);
    assert.match(run(project, 'init', '--port', '0', ...none).stdout, /^Wisdom was already set up in .*\. Its hooks and skills are refreshed\.\n/);

    const status = run(project, 'daemon', 'status').stdout;
    assert.match(status, /^Wisdom is running\.\n {2}Address {4}http:\/\/127\.0\.0\.1:\d+ \(PID \d+\)\n {2}Dashboard {2}not started\. Not started with this daemon\.\n {2}Commits {4}not started\. Not started with this daemon\.\n {2}Sessions {3}0\n$/);
    assert.equal(run(project, 'daemon', 'start').stdout, status);

    const glance = run(project, 'glance').stdout;
    assert.equal(glance, 'No sessions are recorded yet.\n\ncomplete · 1 line\n');

    const stopped = run(project, 'daemon', 'stop');
    assert.deepEqual([stopped.stdout, stopped.status], ['Wisdom stopped.\n', 0]);
    assert(!fs.existsSync(path.join(project, '.wisdom', 'daemon.json')), 'it says stopped only once it has stopped');
    const again = run(project, 'daemon', 'stop');
    assert.deepEqual([again.stdout, again.stderr, again.status], ['Wisdom is not running.\n', '', 0]);
    assert.match(run(project, 'daemon', 'status').stderr, /^Wisdom daemon is not running\. Run: wisdom daemon start\n$/);
  } finally {
    run(project, 'daemon', 'stop');
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('the daemon starts from wisdom.yaml\'s port and leaves the dashboard out when it says so; a broken file means the defaults', () => {
  const project = temp();
  const first = 40000 + 2 * Math.floor(Math.random() * 5000);
  try {
    assert.equal(run(project, 'init', '--port', '0', ...none).status, 0);
    run(project, 'daemon', 'stop');
    fs.writeFileSync(path.join(project, 'wisdom.yaml'), `version: 1\ndaemon:\n  port: ${first}\n  dashboard: false\n`);
    run(project, 'daemon', 'start');
    const { url } = JSON.parse(fs.readFileSync(path.join(project, '.wisdom', 'daemon.json'), 'utf8'));
    const port = Number(new URL(url).port);
    assert(port >= first && port <= first + 40 && (port - first) % 2 === 0, `${port} is ${first} or a pair after it`);
    assert.match(run(project, 'daemon', 'status').stdout, /Dashboard {2}not started/);
    run(project, 'daemon', 'stop');

    fs.writeFileSync(path.join(project, 'wisdom.yaml'), 'version: 1\ndaemon:\n  prot: 1\n');
    run(project, 'daemon', 'start', '--no-dashboard');
    assert(fs.existsSync(path.join(project, '.wisdom', 'daemon.json')), 'a typo never keeps the daemon from starting');
    assert.match(run(project, 'doctor').stdout, /Settings.*prot/);
  } finally {
    run(project, 'daemon', 'stop');
    fs.rmSync(project, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
});

test('init sets up no harness wisdom.yaml turns off', () => {
  const project = temp();
  try {
    fs.writeFileSync(path.join(project, 'wisdom.yaml'), 'version: 1\nharnesses:\n  claude: false\n  codex: false\n');
    const init = run(project, 'init', '--port', '0', ...none);
    assert.equal(init.status, 0, init.stderr);
    assert.match(init.stdout, /\n {2}Claude Code {2}off in wisdom\.yaml, so not set up\.\n {2}Codex {8}off in wisdom\.yaml, so not set up\.\n {2}Pi {11}not installed\./);
    assert(!fs.existsSync(path.join(project, '.wisdom', 'harnesses', 'claude-code')), 'nothing written for Claude Code');
  } finally {
    run(project, 'daemon', 'stop');
    fs.rmSync(project, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
});

test('mistakes get one short line that says what to do', () => {
  const dir = temp();
  try {
    const said = (...args: string[]) => { const result = run(dir, ...args); assert.equal(result.status, 1); return result.stderr.trim(); };
    assert.equal(said('stop'), 'Unknown command: stop. Did you mean: wisdom daemon stop?');
    assert.equal(said('status'), 'Unknown command: status. Did you mean: wisdom daemon status?');
    assert.equal(said('bogus'), 'Unknown command: bogus. Run: wisdom --help');
    assert.equal(said('glance', '--nope'), 'Unknown option --nope. Run: wisdom --help');
    assert.equal(said('daemon', 'start', '--port', 'abc'), '--port needs a number from 0 to 65535.');
    fs.mkdirSync(path.join(dir, '.wisdom'));
    fs.writeFileSync(path.join(dir, '.wisdom', 'wisdom.json'), '{}');
    assert.equal(said('glance', '--from', 'abc'), '--from needs a whole number.');
    assert.equal(said('open', 't1', '--capture', 'x', '--at', '1.5'), '--at needs a whole number.');
    assert.equal(said('daemon', 'bogus'), 'Use: wisdom daemon start|stop|status|run');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the session list reads as plain text, for a person and for an agent', async () => {
  const root = temp();
  const data = path.join(root, '.wisdom');
  const folder = path.join(data, 'harnesses', 'claude-code', 'home', 'projects', 'p');
  fs.mkdirSync(folder, { recursive: true });
  const id = 'plain-list-session';
  const file = path.join(folder, `${id}.jsonl`);
  fs.writeFileSync(file, JSON.stringify({ type: 'user', sessionId: id, cwd: root, uuid: 'u1', timestamp: '2026-01-01T10:00:00.000Z', message: { role: 'user', content: 'hello' } }) + '\n');
  const quiet = new Date(Date.now() - 10 * 60_000);
  fs.utimesSync(file, quiet, quiet);
  const daemon = await startDaemon(data, 0);
  try {
    daemon.captures.scan();
    const text: string = (await call(daemon.connection, '/ledger', { glance: true })).text;
    assert.match(text, /^sessions · 1, newest first · version \d+$/m);
    assert.match(text, /^To read one, glance its ID or its first 8 characters\.$/m);
    assert.doesNotMatch(text, /[{}]/);
  } finally {
    await daemon.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a daemon.json left by an earlier run, whose port another project\'s daemon now holds, reads as not running', async () => {
  const root = temp();
  const other = await startDaemon(path.join(root, 'other', '.wisdom'), 0);
  const project = path.join(root, 'project');
  const data = path.join(project, '.wisdom');
  fs.mkdirSync(data, { recursive: true });
  fs.writeFileSync(path.join(data, 'wisdom.json'), '{}');
  fs.writeFileSync(path.join(data, 'daemon.json'), JSON.stringify({ ...other.connection, token: 'from-an-earlier-run' }));
  try {
    await assert.rejects(call(JSON.parse(fs.readFileSync(path.join(data, 'daemon.json'), 'utf8')), '/health'), /daemon is not answering/);
    // Not `run`: a synchronous child would hold this process, and with it the other daemon.
    const stopped = await promisify(execFile)(process.execPath, [bin, 'daemon', 'stop'], { cwd: project, encoding: 'utf8', windowsHide: true });
    assert.deepEqual([stopped.stdout, stopped.stderr], ['Wisdom is not running.\n', '']);
    assert.equal((await call(other.connection, '/health')).status, 'running', 'the other project\'s daemon is left alone');
  } finally {
    await other.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('help is grouped by what a person wants to do', () => {
  const help = run(os.tmpdir(), '--help').stdout;
  for (const heading of ['Set up', 'Run an agent', 'Read a session', 'Background service']) assert.match(help, new RegExp(`^${heading}$`, 'm'));
  assert.doesNotMatch(help, /CAPTURE|POSITION|harness/);
});
