import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hookEvents, hookSettings, inspectHooks, requireTrustedHooks } from '../src/harnesses/codex/launch.js';

test('installed Codex loads invocation-scoped Wisdom hooks and requires trust (no model call)', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wisdom-codex-installed-'));
  const homeDir = path.join(root, 'home'); fs.mkdirSync(homeDir);
  const workspace = path.join(root, 'project'); fs.mkdirSync(workspace);
  try {
    const settings = hookSettings();
    const result = await inspectHooks(process.env.WISDOM_CODEX_BIN ?? 'codex', settings.args, workspace,
      { ...process.env, CODEX_HOME: homeDir });
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
