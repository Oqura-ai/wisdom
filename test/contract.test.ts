import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { startDaemon } from '../src/daemon.js';
import { call } from '../src/client.js';
import { querySchema } from '../src/schema.js';

const run = promisify(execFile);
const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));

test('removed operations and mixed contracts fail explicitly', async () => {
  for (const op of ['browse', 'search', 'follow']) {
    assert.equal(querySchema.safeParse({ op, captureId: 'c' }).success, false);
    await assert.rejects(run(process.execPath, [cli, op, 'c']), /Unknown command/);
  }
  for (const flag of ['--through', '--json']) {
    await assert.rejects(run(process.execPath, [cli, 'timeline', 'c', flag]), /Unknown option/);
  }
  for (const request of [
    { preset: 'timeline', captureId: 'c', throughSeq: 1 },
    { op: 'inspect', captureId: 'c', id: 'r', include: { tools: {} } },
    { op: 'sessions', clean: true }, { op: 'describe', where: {} },
  ]) assert.equal(querySchema.safeParse(request).success, false);
  const { stdout } = await run(process.execPath, [cli, 'vocabulary']);
  assert.equal(JSON.parse(stdout).queryVersion, 3);
});

test('inspection respects revisions and shared path filters work through HTTP and CLI', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wisdom-contract-'));
  const workspace = path.join(root, 'project'); fs.mkdirSync(workspace);
  const data = path.join(root, 'data');
  const daemon = await startDaemon(data, 0);
  try {
    const { captureId } = await call(daemon.connection, '/captures', { workspaceRoot: workspace, piSessionId: 's', source: null });
    const ledger = daemon.captures.get(captureId);
    const record = ledger.append({ type: 'file_change', path: 'src/auth.ts', operation: 'modify', summary: 'Changed auth',
      patchRef: ledger.payload('patch text') });
    const version = daemon.captures.database.revision;
    const late = ledger.append({ type: 'input', summary: 'Later input', dataRef: ledger.payload({ text: 'Later' }) });
    const inspected = await call(daemon.connection, '/query', { op: 'inspect', captureId, id: record.id, sections: ['patch'], readVersion: version });
    assert.equal(inspected.readVersion, version);
    assert.equal(inspected.sections.patch.text, 'patch text');
    await assert.rejects(call(daemon.connection, '/query', { op: 'inspect', captureId, id: late.id, readVersion: version }), /not found/);
    for (const filter of ['src\\auth.ts', { eq: 'src\\auth.ts' }, { in: ['src\\auth.ts'] }]) {
      const result = await call(daemon.connection, '/query', { find: 'changes', captureId, where: { path: filter } });
      assert.deepEqual(result.items.map((item: any) => item.id), [record.id]);
    }
    const { stdout } = await run(process.execPath, [cli, 'file-history', captureId, '--data', data, '--path', 'src\\auth.ts']);
    assert.equal(JSON.parse(stdout).items[0].id, record.id);
  } finally { await daemon.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('clean queries skip unrelated evidence bodies and share CLI/HTTP output', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wisdom-clean-contract-'));
  const workspace = path.join(root, 'project'); fs.mkdirSync(workspace);
  const data = path.join(root, 'data');
  const daemon = await startDaemon(data, 0);
  try {
    const { captureId } = await call(daemon.connection, '/captures', { workspaceRoot: workspace, piSessionId: 's', source: null });
    const ledger = daemon.captures.get(captureId);
    ledger.append({ type: 'input', summary: 'Hello', dataRef: ledger.payload({ text: 'Hello' }) });
    const discarded = ledger.payload({ diagnostic: 'Unrelated gap body' });
    ledger.append({ type: 'gap', summary: 'Missing optional diagnostic', dataRef: discarded });
    fs.unlinkSync(path.join(ledger.dir, 'payloads', discarded));
    const expected = [{ user: 'Hello' }];
    assert.deepEqual(await call(daemon.connection, '/query', { preset: 'timeline', captureId, clean: true }), expected);
    const { stdout } = await run(process.execPath, [cli, 'timeline', captureId, '--data', data, '--clean']);
    assert.deepEqual(JSON.parse(stdout), expected);
  } finally { await daemon.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
