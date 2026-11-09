import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { call } from '../src/client.js';
import { startDaemon } from '../src/daemon.js';
import { backups, repair, repairTargets, restore } from '../src/repair.js';
import { harnessHome, marker } from '../src/paths.js';
import { hookState, skillState } from '../src/harnesses/launch.js';
import { installClaudeCode } from '../src/harnesses/claude-code/launch.js';

function project() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wisdom-repair-')));
  const data = path.join(root, '.wisdom');
  fs.mkdirSync(data);
  fs.writeFileSync(path.join(data, marker), JSON.stringify({ project: root }));
  return { root, data };
}

/** Claude Code's home as a moved install leaves it: its hook names a Wisdom copy that is gone. */
function staleClaude(data: string): { file: string; text: string } {
  const file = path.join(harnessHome(data, 'claude-code'), 'settings.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const text = JSON.stringify({ theme: 'dark', hooks: { Stop: [{ hooks: [{ type: 'command',
    command: `node "C:/gone/wisdom/integrations/claude-code/hook.mjs" "${data.replaceAll('\\', '/')}"` }] }] } }, null, 2) + '\n';
  fs.writeFileSync(file, text);
  return { file, text };
}

test('repair backs up what it changes, rewrites broken hooks, and restore puts every byte back', () => {
  const { root, data } = project();
  try {
    const { file, text } = staleClaude(data);
    assert.equal(hookState(data, 'claude-code'), 'stale');
    const [target] = repairTargets(data);
    assert.deepEqual({ harness: target!.harness, place: target!.place, problem: target!.problem }, { harness: 'claude-code', place: 'home', problem: 'hooks' });

    const { backup, codexReview } = repair(data, new Date('2026-11-09T10:00:00Z'));
    assert.equal(codexReview, false);
    assert.equal(hookState(data, 'claude-code'), 'current');
    assert.equal(skillState(data, 'claude-code'), 'current');
    // Settings Wisdom does not own are kept.
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).theme, 'dark');
    assert.deepEqual(repairTargets(data), []);
    assert.deepEqual(backups(data).map(b => b.id), [backup.id]);

    restore(data, backup.id);
    assert.equal(fs.readFileSync(file, 'utf8'), text);
    // The skill did not exist before the repair, so restoring removes it.
    assert.equal(fs.existsSync(path.join(harnessHome(data, 'claude-code'), 'skills')), false);
    assert.equal(hookState(data, 'claude-code'), 'stale');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an outdated reading skill is repaired on its own, and nothing working is touched', () => {
  const { root, data } = project();
  try {
    assert.throws(() => repair(data), /Nothing to repair/);
    installClaudeCode(data);
    assert.deepEqual(repairTargets(data), []);
    const skill = path.join(harnessHome(data, 'claude-code'), 'skills', 'wisdom-ledger', 'SKILL.md');
    fs.writeFileSync(skill, 'an older skill');
    const [target] = repairTargets(data);
    assert.equal(target!.problem, 'skill');
    repair(data);
    assert.equal(skillState(data, 'claude-code'), 'current');
    assert.throws(() => restore(data, '../../elsewhere'), /No backup/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the daemon reports storage, health and repairs', async () => {
  const { root, data } = project();
  staleClaude(data);
  const daemon = await startDaemon(data, 0);
  try {
    const c = daemon.connection;
    await call(c, '/observe', { harness: 'pi', cwd: root, observation: { observationId: randomUUID(), sessionId: 'sized', type: 'input', data: { text: 'hello' } } });
    const storage = await call(c, '/storage', {});
    assert.equal(storage.sessions[0].session, 'sized');
    assert.ok(storage.sessions[0].bytes > 0 && storage.database > 0);
    assert.ok(storage.total >= storage.database + storage.sessions[0].bytes);

    const health = await call(c, '/doctor', { fresh: true }, 120_000);
    const claude = health.checks.find((check: any) => check.name === 'Claude Code');
    assert.equal(claude.level, 'problem');
    assert.ok(health.checks.some((check: any) => check.name === 'Daemon'));

    const plan = await call(c, '/repair', { action: 'plan' });
    assert.equal(plan.targets.length, 1);
    const done = await call(c, '/repair', { action: 'repair' });
    assert.equal(done.backup.targets[0].harness, 'claude-code');
    assert.deepEqual((await call(c, '/repair', { action: 'plan' })).targets, []);
  } finally {
    await daemon.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
