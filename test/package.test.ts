import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));

test('the npm package holds what an install runs, and nothing else', () => {
  const pkg = JSON.parse(fs.readFileSync(new URL('package.json', `file:///${root.replaceAll('\\', '/')}`), 'utf8'));
  assert.equal(pkg.name, '@oqura/wisdom');
  assert.equal(pkg.license, 'Apache-2.0');
  assert.equal(pkg.private, undefined);
  assert.equal(pkg.bin.wisdom, 'dist/src/bin.js');

  const listed = JSON.parse(execSync('npm pack --dry-run --json --ignore-scripts', { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
  const files: string[] = listed[0].files.map((file: { path: string }) => file.path.replaceAll('\\', '/'));
  for (const needed of ['LICENSE', 'NOTICE', 'README.md', 'package.json', 'dist/src/bin.js', 'dist/src/cli.js',
    'dist/src/harnesses/pi/extension.js', 'integrations/claude-code/hook.mjs', 'integrations/codex/hook.mjs', 'skills/wisdom-ledger/SKILL.md']) {
    assert(files.includes(needed), `${needed} is in the package`);
  }
  const unwanted = /^(?:src|test|docs|notes|experiment|private|scripts|dashboard|\.claude|\.wisdom|dist\/test)\/|^(?:CLAUDE|AGENTS)\.md$|\.map$/;
  assert.deepEqual(files.filter(file => !file.startsWith('dist-dashboard/') && unwanted.test(file)), []);
});
