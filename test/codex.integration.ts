import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hookEvents, inspectHooks, installCodex, requireTrustedHooks } from '../src/harnesses/codex/launch.js';
import { resolveCommand } from '../src/harnesses/launch.js';

test('installed Codex loads the Wisdom hooks from its home in the data folder and requires trust (no model call)', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wisdom-codex-installed-'));
  const workspace = path.join(root, 'project'); fs.mkdirSync(workspace);
  try {
    const settings = installCodex(path.join(root, 'data'));
    const result = await inspectHooks(resolveCommand(process.env.WISDOM_CODEX_BIN ?? 'codex'), [], workspace,
      { ...process.env, CODEX_HOME: settings.home });
    assert.deepEqual(result.data[0].errors, []);
    const hooks = result.data[0].hooks.filter((hook: any) => hook.command === settings.command);
    assert.equal(hooks.length, hookEvents.length);
    assert(hooks.every((hook: any) => hook.enabled && hook.trustStatus === 'untrusted'));
    assert.throws(() => requireTrustedHooks(result, settings.command), /setup-hooks/);
  } finally {
    // The app-server process is terminated by inspectHooks; Windows releases its
    // handles asynchronously, so retry the cleanup instead of failing the check.
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});
