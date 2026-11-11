import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { diagnose } from '../src/setup/doctor.js';
import { skillState } from '../src/harnesses/launch.js';
import { installClaudeCode } from '../src/harnesses/claude-code/launch.js';
import { installCodex } from '../src/harnesses/codex/launch.js';
import { installPi, launchPi } from '../src/harnesses/pi/launch.js';

const shipped = fileURLToPath(new URL('../../skills/wisdom-ledger/SKILL.md', import.meta.url));
const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'wisdom-skill-'));

test('init puts the reading skill in every harness home, and nothing outside them', () => {
  const data = temp();
  try {
    assert.equal(skillState(data, 'claude-code'), 'missing');
    const homes = { 'claude-code': installClaudeCode(data), codex: installCodex(data).home, pi: installPi(data) };
    for (const [harness, home] of Object.entries(homes)) {
      assert.equal(fs.readFileSync(path.join(home, 'skills', 'wisdom-ledger', 'SKILL.md'), 'utf8'), fs.readFileSync(shipped, 'utf8'));
      assert.equal(skillState(data, harness as keyof typeof homes), 'current');
    }
  } finally { fs.rmSync(data, { recursive: true, force: true }); }
});

test('installing again replaces an old skill and leaves other skills alone', () => {
  const data = temp();
  try {
    const home = installClaudeCode(data);
    const installed = path.join(home, 'skills', 'wisdom-ledger', 'SKILL.md');
    const theirs = path.join(home, 'skills', 'theirs', 'SKILL.md');
    fs.mkdirSync(path.dirname(theirs), { recursive: true });
    fs.writeFileSync(theirs, 'mine');
    fs.writeFileSync(installed, 'an older version');
    fs.writeFileSync(path.join(path.dirname(installed), 'removed-since.md'), 'old');
    assert.equal(skillState(data, 'claude-code'), 'outdated');
    installClaudeCode(data);
    assert.equal(skillState(data, 'claude-code'), 'current');
    assert(!fs.existsSync(path.join(path.dirname(installed), 'removed-since.md')));
    assert.equal(fs.readFileSync(theirs, 'utf8'), 'mine');
  } finally { fs.rmSync(data, { recursive: true, force: true }); }
});

test('doctor says when a harness home is missing the skill, and how to fix it', async () => {
  const data = temp();
  try {
    const home = installPi(data);
    fs.rmSync(path.join(home, 'skills'), { recursive: true });
    const checks = await diagnose(data, { claude: 'wisdom-test-none', codex: 'wisdom-test-none', pi: () => '1.2.0' });
    const pi = checks.find(check => check.name === 'Pi')!;
    assert.equal(pi.level, 'note');
    assert.match(pi.detail, /reading skill is missing/);
    assert.equal(pi.fix, 'wisdom init');
    installPi(data);
    const fixed = (await diagnose(data, { claude: 'wisdom-test-none', codex: 'wisdom-test-none', pi: () => '1.2.0' })).find(check => check.name === 'Pi')!;
    assert.equal(fixed.level, 'ok');
    assert.equal(fixed.detail, 'hooks in place, skill installed, version 1.2.0');
  } finally { fs.rmSync(data, { recursive: true, force: true }); }
});

test('the skill teaches the wisdom command first, and Pi no longer needs a launch flag', () => {
  const skill = fs.readFileSync(shipped, 'utf8');
  assert.match(skill, /wisdom glance latest/);
  assert.match(skill, /wisdom open t3 --capture latest/);
  const data = temp();
  try {
    assert(!launchPi({ entry: 'pi.js', args: [], dataDir: data }).args.includes('--skill'));
  } finally { fs.rmSync(data, { recursive: true, force: true }); }
});
