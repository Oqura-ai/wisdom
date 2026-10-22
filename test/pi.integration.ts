import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startDaemon } from '../src/daemon.js';
import { call } from '../src/client.js';

test('installed Pi records real write/edit/failing/nested tools and can be queried mid-session', { timeout: 30000 }, async () => {
  const project = fileURLToPath(new URL('../../', import.meta.url));
  const install = path.join(os.homedir(), '.pi', 'agent', 'install');
  const version = process.env.WISDOM_PI_ENTRY ? 'custom installation'
    : fs.readFileSync(path.join(install, 'current-version'), 'utf8').trim();
  const entry = process.env.WISDOM_PI_ENTRY ?? path.join(install, 'releases', version, 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'bundle', 'cli.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wisdom-pi-test-'));
  const workspace = path.join(root, 'workspace'); fs.mkdirSync(workspace);
  const dataDir = path.join(root, 'data');
  const daemon = await startDaemon(dataDir, 0);
  const child = spawn(process.execPath, [entry, '--mode', 'rpc', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-context-files',
    '--no-mcp', '--provider', 'wisdom-test', '--model', 'scripted', '--thinking', 'off',
    '--extension', path.join(project, 'dist', 'src', 'pi-extension.js'),
    '--skill', path.join(project, 'skills', 'wisdom-ledger'),
    '--extension', path.join(project, 'test', 'fixtures', 'scripted-provider.mjs'),
    '--session-dir', path.join(root, 'native')], {
    cwd: workspace, windowsHide: true,
    env: { ...process.env, WISDOM_DATA_DIR: dataDir, PI_CODING_AGENT_DIR: path.join(root, 'pi-home') },
    stdio: ['pipe', 'pipe', 'pipe']
  });
  let stderr = '', buffer = '';
  const messages: any[] = [];
  child.stderr.on('data', bytes => { stderr += bytes.toString(); });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    buffer += chunk;
    for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) {
      const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
      try { messages.push(JSON.parse(line)); } catch { stderr += '\n' + line; }
    }
  });
  let spawnError: unknown;
  child.on('error', error => { spawnError = error; });
  const waitFor = async (predicate: () => boolean) => {
    for (let attempt = 0; attempt < 400; attempt++) {
      if (predicate()) return;
      if (spawnError || child.exitCode !== null) throw new Error(`Pi exited: ${String(spawnError)} ${stderr}\n${JSON.stringify(messages.slice(-5))}`);
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error(`Timed out: ${stderr}\n${JSON.stringify(messages.slice(-8))}`);
  };
  try {
    child.stdin.write(JSON.stringify({ id: 'commands', type: 'get_commands' }) + '\n');
    await waitFor(() => messages.some(m => m.id === 'commands'));
    const commands = messages.find(m => m.id === 'commands');
    assert(JSON.stringify(commands).includes('wisdom-status'), `Extension not loaded: ${JSON.stringify(commands)} ${stderr}`);
    assert(JSON.stringify(commands).includes('wisdom-ledger'), `Harness skill not loaded: ${JSON.stringify(commands)}`);
    await waitFor(() => daemon.captures.ledgers.size === 1);
    const captureId = [...daemon.captures.ledgers.keys()][0];
    child.stdin.write(JSON.stringify({ id: 'prompt', type: 'prompt', message: 'Run the local recording fixture.' }) + '\n');
    await waitFor(() => daemon.captures.get(captureId).listRecords().some(r => r.type === 'tool_started' && r.toolName === 'nested_writer'));
    const live = await call(daemon.connection, '/query', { preset: 'timeline', captureId });
    assert(live.coverage[0].pendingToolCount > 0);
    await waitFor(() => messages.some(m => m.type === 'agent_settled'));
    child.stdin.end();
    await new Promise<void>((resolve, reject) => { child.once('exit', code => code === 0 ? resolve() : reject(new Error(stderr))); });
    const ledger = daemon.captures.get(captureId);
    assert.equal(ledger.manifest.status, 'closed');
    assert.equal(fs.readFileSync(path.join(workspace, 'example.txt'), 'utf8'), 'hello wisdom\n');
    const changes = ledger.listRecords().filter(r => r.type === 'file_change');
    assert(changes.some(r => r.path === 'example.txt' && r.operation === 'modify'));
    assert(changes.some(r => r.path === 'leftover.txt' && r.operation === 'create'));
    assert.equal(changes.filter(r => r.path === 'nested.txt').length, 1);
    assert(ledger.listRecords().some(r => r.type === 'tool_finished' && r.toolName === 'partial_failure' && r.isError));
    assert(ledger.listRecords().some(r => r.parentToolCallId));
    assert(ledger.listRecords().some(r => r.type === 'source_record' && r.role === 'user'));
    assert.deepEqual(fs.readFileSync(path.join(ledger.dir, 'pi-session.jsonl')), fs.readFileSync(ledger.manifest.source!));
    const review = await call(daemon.connection, '/query', { preset: 'interaction-review', captureId, maxChars: 32000 });
    assert.equal(review.items.length, 1);
    assert(review.items[0].changes.items.some((r: any) => r.path === 'example.txt' && r.patch.available));
    assert(review.items[0].outputs.items.some((r: any) => r.toolName === 'partial_failure' && r.isError));
    assert(review.items[0].messages.items.some((r: any) => r.role === 'assistant'));
    console.log(`Verified installed Pi ${version}: ${changes.length} file observations, live queries, native source mirrored byte-for-byte.`);
  } finally {
    if (child.exitCode === null) child.kill();
    await daemon.close();
    // Wait for handles to close before deleting the isolated test workspace on Windows.
    await new Promise(resolve => setTimeout(resolve, 100));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
