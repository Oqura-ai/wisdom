import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startDaemon } from '../src/daemon.js';
import { startDashboard } from '../src/dashboard.js';
import { diagnose, formatChecks } from '../src/doctor.js';
import { hookState } from '../src/harnesses/launch.js';
import { installClaudeCode } from '../src/harnesses/claude-code/launch.js';
import { installPi } from '../src/harnesses/pi/launch.js';
import { marker, spoolDir } from '../src/paths.js';

const bin = fileURLToPath(new URL('../src/bin.js', import.meta.url));
const absent = { claude: 'wisdom-test-no-such-harness', codex: 'wisdom-test-no-such-harness', pi: () => undefined };

function project() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wisdom-doctor-'));
  const data = path.join(root, '.wisdom');
  fs.mkdirSync(data);
  fs.writeFileSync(path.join(data, marker), JSON.stringify({ project: root }));
  return { root, data };
}
const named = (checks: Awaited<ReturnType<typeof diagnose>>, name: string) => checks.find(check => check.name === name)!;

test('doctor reports a stopped daemon and never starts one', async () => {
  const { root, data } = project();
  try {
    const checks = await diagnose(data, absent);
    assert.equal(named(checks, 'Daemon').level, 'note');
    assert.match(named(checks, 'Daemon').detail, /not running/);
    assert.equal(named(checks, 'Claude Code').detail, 'not installed');
    assert(!fs.existsSync(path.join(data, 'daemon.json')), 'no daemon was started');
    assert(!fs.existsSync(path.join(data, 'harnesses')), 'no hooks were written');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('doctor names hooks that lost their copy of Wisdom, and the command that repairs them', async () => {
  const { root, data } = project();
  try {
    installClaudeCode(data); installPi(data);
    assert.equal(hookState(data, 'claude-code'), 'current');
    assert.equal(hookState(data, 'codex'), 'none');
    const file = path.join(data, 'harnesses', 'claude-code', 'home', 'settings.json');
    const text = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(file, text.replaceAll('integrations/claude-code/hook.mjs', 'gone/integrations/claude-code/hook.mjs'));
    assert.equal(hookState(data, 'claude-code'), 'stale');
    const checks = await diagnose(data, absent);
    const claude = named(checks, 'Claude Code');
    assert.equal(claude.level, 'problem');
    assert.equal(claude.fix, 'wisdom init');
    const output = formatChecks(root, checks);
    assert.match(output, /problem\s+Claude Code\s+its hooks point to a copy of Wisdom that has moved or gone/);
    assert.match(output, /fix: wisdom init/);
    assert.match(output, /1 problem found\.$/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('doctor notices hooks that run another copy of Wisdom which still exists', () => {
  const { root, data } = project();
  try {
    const other = path.join(root, 'old-node', 'wisdom', 'integrations', 'claude-code');
    fs.mkdirSync(other, { recursive: true });
    fs.writeFileSync(path.join(other, 'hook.mjs'), '');
    const home = path.join(data, 'harnesses', 'claude-code', 'home');
    fs.mkdirSync(home, { recursive: true });
    const hook = path.join(other, 'hook.mjs').replaceAll('\\', '/');
    fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: `node "${hook}" "${data}"` }] }] } }));
    assert.equal(hookState(data, 'claude-code'), 'other');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('doctor reads a running daemon and counts events waiting in the spool', async () => {
  const { root, data } = project();
  const daemon = await startDaemon(data, 0);
  try {
    const folder = path.join(spoolDir(data), 'pi', 'session');
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'one.json'), '{}');
    const checks = await diagnose(data, absent);
    assert.equal(named(checks, 'Daemon').level, 'ok');
    assert.match(named(checks, 'Daemon').detail, /^running at http:\/\/127\.0\.0\.1:\d+ \(PID \d+\), 0 sessions$/);
    assert.match(named(checks, 'Spool').detail, /^1 event waiting/);
  } finally {
    await daemon.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a missing dashboard says how to get it and leaves recording alone', () => {
  const { root, data } = project();
  try {
    const dashboard = startDashboard(data, 0, path.join(root, 'not-built'));
    const state = dashboard.state();
    assert.equal(state.status, 'unavailable');
    assert.match((state as { reason: string }).reason, /Reinstall the package; in a clone, run npm run dashboard:install, then npm run dashboard:build\./);
    dashboard.close();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('the installed command prints its version, and --cwd works on every project command', () => {
  const { root, data } = project();
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'wisdom-empty-'));
  try {
    const run = (...args: string[]) => spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8', cwd: os.tmpdir() });
    assert.match(run('--version').stdout.trim(), /^\d+\.\d+\.\d+$/);
    const help = run('--help').stdout;
    assert.doesNotMatch(help, /npm/);
    assert.match(help, /wisdom doctor/);
    const status = run('daemon', 'status', '--cwd', root);
    assert.match(status.stderr, /Wisdom daemon is not running/);
    assert.doesNotMatch(status.stderr, /not valid/);
    assert.match(run('dashboard', '--cwd', root).stderr, /Wisdom daemon is not running/);
    assert.match(run('open', '--cwd', root).stderr, /Use: wisdom open POSITION/);
    assert.match(run('resume', '--cwd', root).stderr, /Use: wisdom resume SESSION-ID/);
    // These would start a daemon inside a project, so aim them at a folder that is not one:
    // the answer proves --cwd was accepted and used.
    for (const command of ['glance', 'mcp']) assert.match(run(command, '--cwd', empty).stderr, /is not inside a Wisdom project/);
    assert.match(run('doctor', '--cwd', root).stdout, /No problems found\.|problem/);
    assert(!fs.existsSync(path.join(data, 'daemon.json')), 'doctor started no daemon');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(empty, { recursive: true, force: true });
  }
});

test('outside a project, doctor says to run init', () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'wisdom-empty-'));
  try {
    const run = spawnSync(process.execPath, [bin, 'doctor', '--cwd', empty], { encoding: 'utf8' });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /is not inside a Wisdom project\. Run: wisdom init/);
  } finally { fs.rmSync(empty, { recursive: true, force: true }); }
});
