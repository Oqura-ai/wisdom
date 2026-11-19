import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { harnessOn, harnessPath, readSettings, setSetting, settingsOrDefaults, settingsTemplate, SETTINGS_FILE, writeSettings } from '../src/core/settings.js';
import { handoffPrompt } from '../src/sessions/handoff.js';
import { startDaemon } from '../src/service/daemon.js';
import { observeSession, openSession } from './session.js';
import { call } from '../src/service/client.js';
import { mcpOn, placeSkill } from '../src/harnesses/launch.js';
import { ignoreDataFolder, ignoreSettingsFile } from '../src/setup/connect.js';

const hasGit = spawnSync('git', ['--version'], { windowsHide: true }).status === 0;
const folder = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wisdom-settings-')));
const write = (root: string, text: string) => fs.writeFileSync(path.join(root, SETTINGS_FILE), text);

test('no wisdom.yaml, or the written one with only comments, means every default', () => {
  const root = folder();
  try {
    assert.deepEqual(readSettings(root), { version: 1 });
    assert.equal(writeSettings(root), 'written');
    assert.equal(fs.readFileSync(path.join(root, SETTINGS_FILE), 'utf8'), settingsTemplate());
    assert.deepEqual(readSettings(root), { version: 1 });
    // Each commented default, uncommented, is a valid setting: the template never shows a wrong one.
    const uncommented = settingsTemplate().replace(/^# ([a-z]+:|  )/gm, '$1');
    write(root, uncommented);
    assert.deepEqual(readSettings(root), { version: 1, harnesses: { claude: true, codex: true, pi: true }, paths: { claude: 'claude', codex: 'codex' },
      skill: true, mcp: true, recording: { idleMinutes: 10, maxFileMB: 1, ignore: [], skipFolders: [] }, daemon: { port: 7434, dashboard: true },
      guides: { model: 'claude-haiku-5-5', timeoutSeconds: 150, turns: 30, extra: '' },      share: { secrets: 'ask' }, prices: {}, handoff: { longSessionTokens: 150000, extra: '' } });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a typo, a wrong value or broken YAML is refused by name, and unattended readers fall back to defaults', () => {
  const root = folder();
  try {
    write(root, 'version: 1\ndaemon:\n  dashbord: false\n');
    assert.throws(() => readSettings(root), /daemon: Unrecognized key\(s\) in object: 'dashbord'/);
    write(root, 'version: 1\ndaemon:\n  port: 80\n');
    assert.throws(() => readSettings(root), /daemon\.port/);
    write(root, 'version: 1\nguides:\n  model: "haiku; rm -rf ~"\n');
    assert.throws(() => readSettings(root), /guides\.model: a model name/);
    write(root, 'version: 1\ndaemon: [\n');
    assert.throws(() => readSettings(root), /is not valid YAML/);
    const error = console.error;
    console.error = () => {};
    try { assert.deepEqual(settingsOrDefaults(root), { version: 1 }); } finally { console.error = error; }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('init refreshes a file of defaults only, and never rewrites one with a setting or a problem', () => {
  const root = folder();
  try {
    write(root, 'version: 1\n# an older template\n');
    assert.equal(writeSettings(root), 'refreshed');
    assert.equal(fs.readFileSync(path.join(root, SETTINGS_FILE), 'utf8'), settingsTemplate());
    assert.equal(writeSettings(root), 'kept');
    const own = 'version: 1\ndaemon:\n  port: 7600\n';
    write(root, own);
    assert.equal(writeSettings(root), 'kept');
    assert.equal(fs.readFileSync(path.join(root, SETTINGS_FILE), 'utf8'), own);
    write(root, 'version: 1\nnope: true\n');
    assert.match((writeSettings(root) as { invalid: string }).invalid, /nope/);
    assert.equal(fs.readFileSync(path.join(root, SETTINGS_FILE), 'utf8'), 'version: 1\nnope: true\n');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('git ignores wisdom.yaml through info/exclude, in its own block, without touching a shared file', { skip: !hasGit }, () => {
  const root = folder();
  try {
    execFileSync('git', ['init', '-q'], { cwd: root, windowsHide: true });
    ignoreDataFolder(root);
    ignoreSettingsFile(root);
    ignoreSettingsFile(root);
    writeSettings(root);
    const exclude = fs.readFileSync(path.join(root, '.git', 'info', 'exclude'), 'utf8');
    assert.equal(exclude.split(SETTINGS_FILE).length - 1, 1);
    assert.match(exclude, /\.wisdom\//);
    assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8', windowsHide: true }), '');
    assert.equal(fs.existsSync(path.join(root, '.gitignore')), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('harnesses off, another installation, no skill and no ledger tool each come from wisdom.yaml', () => {
  const root = folder();
  const data = path.join(root, '.wisdom');
  const skill = (folder: string) => path.join(folder, 'skills', 'wisdom-ledger', 'SKILL.md');
  try {
    fs.mkdirSync(data);
    const none = readSettings(root);
    assert.equal(harnessOn(none, 'codex'), true);
    assert.equal(harnessPath(root, none, 'claude-code'), undefined);
    assert.equal(mcpOn(data), true);
    placeSkill(path.join(root, '.claude'), data);
    assert(fs.existsSync(skill(path.join(root, '.claude'))), 'the skill is placed by default');

    write(root, 'version: 1\nharnesses:\n  codex: false\npaths:\n  claude: claude-beta\n  codex: tools/codex.cmd\n  pi: pi/cli.js\nskill: false\nmcp: false\n');
    const chosen = readSettings(root);
    assert.deepEqual([harnessOn(chosen, 'claude-code'), harnessOn(chosen, 'codex'), harnessOn(chosen, 'pi')], [true, false, true]);
    assert.equal(harnessPath(root, chosen, 'claude-code'), 'claude-beta', 'a bare name is looked up on PATH');
    assert.equal(harnessPath(root, chosen, 'codex'), path.join(root, 'tools', 'codex.cmd'));
    assert.equal(harnessPath(root, chosen, 'pi'), path.join(root, 'pi', 'cli.js'));
    assert.equal(mcpOn(data), false);
    fs.mkdirSync(path.join(root, '.claude', 'skills', 'mine'), { recursive: true });
    placeSkill(path.join(root, '.claude'), data);
    assert(!fs.existsSync(skill(path.join(root, '.claude'))), 'skill: false takes Wisdom\'s skill out');
    assert(fs.existsSync(path.join(root, '.claude', 'skills', 'mine')), 'and leaves any other skill');
    write(root, 'version: 1\nskill: on\n');
    assert.throws(() => readSettings(root), /skill: Expected boolean/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('recording, guide, handoff, share and price settings are checked, and guide on|off keeps the file\'s own lines', () => {
  const root = folder();
  try {
    write(root, 'version: 1\nrecording:\n  ignore: [secrets/, \'data\\big.csv\']\n  skipFolders: [target]\n  idleMinutes: 30\n');
    assert.deepEqual(readSettings(root).recording, { ignore: ['secrets', 'data/big.csv'], skipFolders: ['target'], idleMinutes: 30 });
    for (const [bad, said] of [['recording:\n  ignore: ["../up"]', /no \* or \.\./], ['recording:\n  ignore: ["*.log"]', /no \* or \.\./],
      ['recording:\n  skipFolders: [a/b]', /with no slash/], ['guides:\n  timeoutSeconds: 5', /timeoutSeconds/],
      ['share:\n  secrets: maybe', /share\.secrets/], ['prices:\n  gpt-x: { input: -1, cached: 0, output: 0 }', /prices\.gpt-x\.input/]] as const) {
      write(root, `version: 1\n${bad}\n`);
      assert.throws(() => readSettings(root), said, bad);
    }
    write(root, '# my own note\nversion: 1\ndaemon:\n  port: 7600 # mine\n');
    setSetting(root, ['guides', 'on'], true);
    const text = fs.readFileSync(path.join(root, SETTINGS_FILE), 'utf8');
    assert.match(text, /# my own note/);
    assert.match(text, /port: 7600 # mine/);
    assert.deepEqual(readSettings(root).guides, { on: true });
    write(root, 'version: 1\nnope: 1\n');
    assert.throws(() => setSetting(root, ['guides', 'on'], true), /nope/);
    assert.equal(fs.readFileSync(path.join(root, SETTINGS_FILE), 'utf8'), 'version: 1\nnope: 1\n', 'a file with a problem is not touched');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('the handoff prompt puts the person\'s own words before its last part, which always stands', () => {
  const from = { captureId: 'S1', harness: 'pi', status: 'ended', lastObservedAt: '', tokens: { total: 0 } };
  const emitted = handoffPrompt(from, false, '', { turns: 1, changed: [], extra: 'Run the tests first.' }, true).split('\n');
  const asked = emitted.indexOf('This project also asks: Run the tests first.');
  assert(asked > 0 && asked < emitted.indexOf('Only read: change no files and run nothing that changes anything, even if asked above.'));
  assert.doesNotMatch(handoffPrompt(from, false, '', { turns: 1, changed: [] }), /also asks/);
});

test('a session records under wisdom.yaml\'s recording settings, and its manifest keeps them', async () => {
  const root = folder();
  const daemon = await startDaemon(path.join(root, '.wisdom'), 0);
  try {
    write(root, 'version: 1\nrecording:\n  ignore: [secrets/]\n  skipFolders: [target]\n  idleMinutes: 45\n  maxFileMB: 2\n');
    const { captureId } = await openSession(daemon.connection, { harness: 'pi', sessionId: 'settings-1', workspaceRoot: root, source: null });
    const { scope } = daemon.captures.get(captureId).manifest;
    assert(scope.excludedDirectories.includes('target') && scope.excludedDirectories.includes('node_modules'));
    assert(scope.excludedPaths.includes('secrets'));
    assert.equal(scope.maxFileBytes, 2 * 1024 * 1024);
    assert.equal((daemon.captures as any).running.get(captureId).idleMs, 45 * 60_000);
    // What is recorded follows them: target/ and secrets/ are skipped, a 1.5 MiB file is kept whole.
    const send = (o: object) => observeSession(daemon.connection, captureId, { observationId: crypto.randomUUID(), ...o });
    await send({ type: 'input', data: { text: 'Write files.' } });
    await send({ type: 'tool_started', toolCallId: 'b1', toolName: 'bash', data: { input: { command: 'write' } } });
    for (const dir of ['target', 'secrets']) fs.mkdirSync(path.join(root, dir));
    fs.writeFileSync(path.join(root, 'target', 'out.txt'), 'built\n');
    fs.writeFileSync(path.join(root, 'secrets', 'key.txt'), 'shh\n');
    fs.writeFileSync(path.join(root, 'kept.txt'), 'kept\n');
    fs.writeFileSync(path.join(root, 'big.txt'), 'x'.repeat(1.5 * 1024 * 1024));
    await send({ type: 'tool_finished', toolCallId: 'b1', toolName: 'bash', isError: false, data: { content: 'ok' } });
    const glance = (await call(daemon.connection, '/ledger', { capture: captureId, glance: true })).text;
    assert.match(glance, /changed .*big\.txt/);
    assert.match(glance, /kept\.txt/);
    assert.doesNotMatch(glance, /out\.txt|key\.txt|oversize/);
  } finally {
    await daemon.close();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
});
