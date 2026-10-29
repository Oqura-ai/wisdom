import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { startDaemon } from '../src/daemon.js';
import { call } from '../src/client.js';

test('op=stats lists projects and aggregates one project per harness, capture, tool and file', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wisdom-stats-'));
  const project = path.join(root, 'project'); fs.mkdirSync(project);
  const other = path.join(root, 'other'); fs.mkdirSync(other);
  const daemon = await startDaemon(path.join(root, 'data'), 0);
  try {
    const c = daemon.connection;
    const open = (harness: string, workspaceRoot: string) => call(c, '/captures', { harness, sessionId: randomUUID(), workspaceRoot, source: null });
    const send = (id: string, body: Record<string, unknown>) => call(c, `/captures/${id}/observe`, { observationId: randomUUID(), ...body });
    const claude = (await open('claude-code', project)).captureId;
    await send(claude, { type: 'input', data: { text: 'edit' } });
    await send(claude, { type: 'tool_started', toolCallId: 'a', toolName: 'Write', data: { input: { file_path: path.join(project, 'a.txt') } } });
    fs.writeFileSync(path.join(project, 'a.txt'), 'one\n');
    await send(claude, { type: 'tool_finished', toolCallId: 'a', toolName: 'Write', isError: false });
    await send(claude, { type: 'tool_started', toolCallId: 'b', toolName: 'Bash', agentId: 'kid', data: { input: { command: 'x' } } });
    await send(claude, { type: 'tool_finished', toolCallId: 'b', toolName: 'Bash', agentId: 'kid', isError: true });
    await call(c, `/captures/${claude}/close`, {});
    const codex = (await open('codex', project)).captureId;
    await send(codex, { type: 'tool_started', toolCallId: 'c', toolName: 'Bash', data: { input: { command: 'y' } } });
    await open('pi', other);

    const inventory = await call(c, '/view', { view: 'projects' });
    assert.equal(inventory.projects.length, 2);
    const listed = inventory.projects.find((p: any) => p.harnesses.includes('codex'));
    assert.deepEqual(listed.harnesses, ['claude-code', 'codex']); assert.equal(listed.recording, 1);

    const stats = await call(c, '/view', { view: 'project', workspaceRoot: project });
    const byHarness = Object.fromEntries(stats.harnesses.map((h: any) => [h.harness, h]));
    assert.deepEqual([byHarness['claude-code'].tools, byHarness['claude-code'].failures, byHarness['claude-code'].changes, byHarness['claude-code'].subagents], [2, 1, 1, 1]);
    assert.equal(byHarness.codex.recording, 1); assert.equal(byHarness.pi, undefined);
    assert.equal(stats.sessions.length, 2);
    assert.deepEqual(stats.toolUsage.find((t: any) => t.harness === 'claude-code' && t.toolName === 'Bash'),
      { harness: 'claude-code', toolName: 'Bash', calls: 1, failures: 1 });
    assert.equal(stats.files[0].path, 'a.txt');
    // stats has its own strict contract; selection fields are refused.
    await assert.rejects(call(c, '/view', { view: 'projects', where: {} }));
  } finally { await daemon.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
