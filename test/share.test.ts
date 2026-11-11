import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { call } from '../src/service/client.js';
import { startDaemon, type Connection } from '../src/service/daemon.js';
import { chooseRedactions, readShare, type Finding } from '../src/share/share.js';
import { harnessHome, marker } from '../src/core/paths.js';

const bin = fileURLToPath(new URL('../src/bin.js', import.meta.url));
const openai = 'sk-proj-abcdefghijklmnopqrstuvwxyz123456';
const password = 'hunter22secret';

/** A project with one recorded session: a prompt, and a Bash call whose output holds a key
 * and which writes a file holding a password.
 */
async function recorded() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wisdom-share-')));
  const data = path.join(root, '.wisdom');
  fs.mkdirSync(data);
  fs.writeFileSync(path.join(data, marker), JSON.stringify({ project: root }));
  fs.writeFileSync(path.join(root, 'notes.txt'), 'nothing yet\n');
  const daemon = await startDaemon(data, 0);
  const send = (type: string, extra: Record<string, unknown>) => call(daemon.connection, '/observe', { harness: 'claude-code', cwd: root,
    observation: { observationId: randomUUID(), sessionId: 'share-me', type, ...extra } });
  await send('input', { data: { text: 'Check the deploy settings.' } });
  await send('tool_started', { toolCallId: 'b1', toolName: 'Bash', data: { input: { command: 'cat .env' } } });
  fs.writeFileSync(path.join(root, 'notes.txt'), `DB_PASSWORD=${password}\n`);
  await send('tool_finished', { toolCallId: 'b1', toolName: 'Bash', isError: false, data: { response: { stdout: `OPENAI_KEY=${openai}` } } });
  return { root, data, daemon };
}

// The daemon runs in this process, so the CLI must not block its event loop.
const run = (cwd: string, ...args: string[]) => new Promise<{ code: number; stdout: string; stderr: string }>(resolve =>
  execFile(process.execPath, [bin, 'share', ...args], { cwd }, (error, stdout, stderr) => resolve({ code: error ? Number((error as any).code ?? 1) : 0, stdout, stderr })));

test('with secrets found and nobody to ask, share writes nothing and says what to do', async () => {
  const { root, data, daemon } = await recorded();
  try {
    const result = await run(root, 'share-me');
    assert.equal(result.code, 1);
    assert.match(result.stdout, /^Found 2 possible secrets:$/m);
    assert.match(result.stdout, /openai-key {9}sk-pro…3456 {7}t1 · Bash output/);
    assert.match(result.stdout, /secret-assignment {2}hu…/);
    assert(!result.stdout.includes(openai) && !result.stdout.includes(password), 'findings are masked');
    assert.match(result.stderr, /nothing was written\. Run again with --redact .* or --keep-secrets/);
    assert(!fs.existsSync(path.join(data, 'shared-out')));
  } finally {
    await daemon.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('--redact writes a file with every secret replaced, says so, and leaves the recording alone', async () => {
  const { root, data, daemon } = await recorded();
  try {
    const out = path.join(root, 'out.wisdom-share');
    const result = await run(root, 'share-me', '--redact', '--out', out);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Redacted 2 values in this file\. Your recording is unchanged\./);
    assert.match(result.stdout, /This file is inside your project\. Keep it out of git\./);

    const raw = zlib.gunzipSync(fs.readFileSync(out)).toString('utf8');
    assert(!raw.includes(openai) && !raw.includes(password), 'no secret anywhere in the file');
    assert.match(raw, /\[redacted by sender: openai-key\]/);
    const shared = readShare(out);
    assert.deepEqual(shared.header.redactions.map(r => r.kind).sort(), ['openai-key', 'secret-assignment']);
    assert.deepEqual(shared.header.patchesEdited, [{ captureId: 'share-me', path: 'notes.txt' }]);
    assert.equal(shared.manifests[0]!.captureId, 'share-me');
    assert(shared.records.some(({ record }) => record.type === 'file_change' && record.path === 'notes.txt'));
    assert(!shared.files.some(file => /home|credentials|daemon\.json|spool/.test(file.path)), 'no logins, spool or daemon details');

    const stored = fs.readdirSync(path.join(data, 'harnesses', 'claude-code', 'share-me', 'payloads'))
      .map(name => fs.readFileSync(path.join(data, 'harnesses', 'claude-code', 'share-me', 'payloads', name), 'utf8')).join('\n');
    assert(stored.includes(openai), 'the recording itself still holds what was recorded');
  } finally {
    await daemon.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('--keep-secrets sends them as they are, and the default file goes into the data folder', async () => {
  const { root, data, daemon } = await recorded();
  try {
    const result = await run(root, 'share-me', '--keep-secrets');
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Kept 2 you chose to keep\./);
    const [name] = fs.readdirSync(path.join(data, 'shared-out'));
    assert.match(name!, /^share-me-\d{8}-\d{4}\.wisdom-share$/);
    assert(zlib.gunzipSync(fs.readFileSync(path.join(data, 'shared-out', name!))).toString('utf8').includes(openai));
  } finally {
    await daemon.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a damaged or cut-short share file is refused when read', async () => {
  const { root, daemon } = await recorded();
  try {
    const out = path.join(root, 'out.wisdom-share');
    await run(root, 'share-me', '--redact', '--out', out);
    const lines = zlib.gunzipSync(fs.readFileSync(out)).toString('utf8').trimEnd().split('\n');
    const file = lines.findIndex(line => line.includes('"kind":"file"'));
    const damaged = [...lines]; damaged[file] = damaged[file]!.replace(/"content":"./, '"content":"X');
    fs.writeFileSync(out, zlib.gzipSync(damaged.join('\n')));
    assert.throws(() => readShare(out), /is damaged: .* does not match its checksum/);
    fs.writeFileSync(out, zlib.gzipSync(lines.slice(0, -2).join('\n')));
    assert.throws(() => readShare(out), /is incomplete/);
  } finally {
    await daemon.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('choosing one by one redacts unless told no, and an answer not understood cancels', async () => {
  const findings: Finding[] = [{ kind: 'a', value: '1', shown: '', places: [] }, { kind: 'b', value: '2', shown: '', places: [] }];
  const answers = (...replies: string[]) => async () => replies.shift() ?? '';
  assert.deepEqual((await chooseRedactions(findings, {}, answers('c', 'n', '')))!.map(f => f.kind), ['b']);
  assert.equal(await chooseRedactions(findings, {}, answers('maybe')), undefined);
  assert.deepEqual(await chooseRedactions(findings, {}, answers('k')), []);
  assert.deepEqual(await chooseRedactions([], {}), []);
});

test('the export view pins one version and names only the evidence its records use', async () => {
  const { root, daemon } = await recorded();
  try {
    const exported = await call(daemon.connection as Connection, '/view', { view: 'export', capture: 'share-me' });
    assert(exported.records.every((record: any) => record.captureId === 'share-me'));
    const refs = new Set(exported.records.flatMap((r: any) => [r.dataRef, r.patchRef]).filter(Boolean).map((ref: string) => `payloads/${ref}`));
    assert.deepEqual(exported.files.filter((f: string) => f.startsWith('payloads/')).sort(), [...refs].sort());
  } finally {
    await daemon.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a redacted transcript line can change length, and every record still points at its whole line', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wisdom-share-lines-')));
  const data = path.join(root, '.wisdom');
  fs.mkdirSync(data);
  fs.writeFileSync(path.join(data, marker), JSON.stringify({ project: root }));
  const email = 'someone.real@gmail.com';
  // A finished Claude Code session found from its file: the email sits in the first line, so
  // redacting it moves every line after it.
  const line = (entry: object) => JSON.stringify({ sessionId: 'lines-me', cwd: root, timestamp: '2026-01-01T10:00:00.000Z', ...entry });
  const file = path.join(harnessHome(data, 'claude-code'), 'projects', 'p', 'lines-me.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, [line({ type: 'user', uuid: 'u1', message: { role: 'user', content: `Mail ${email} the report.` } }),
    line({ type: 'assistant', uuid: 'm1', message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'Sent.' }] } })].join('\n') + '\n');
  const quiet = new Date(Date.now() - 10 * 60_000);
  fs.utimesSync(file, quiet, quiet);
  const daemon = await startDaemon(data, 0);
  try {
    daemon.captures.scan();
    const out = path.join(root, 'out.wisdom-share');
    const result = await run(root, 'lines-me', '--redact', '--out', out);
    assert.equal(result.code, 0, result.stderr);
    const shared = readShare(out);
    const native = Buffer.from(shared.files.find(f => f.path === 'native-session.jsonl')!.content, 'utf8');
    assert(!native.includes(email));
    const pointed = shared.records.filter(({ record }) => record.sourceOffset !== undefined);
    assert(pointed.length >= 2);
    for (const { record } of pointed) {
      const text = native.subarray(record.sourceOffset!, record.sourceOffset! + record.sourceLength!).toString('utf8');
      assert(text.endsWith('\n'), `${record.type} ends at its line's end`);
      JSON.parse(text);
    }
  } finally { await daemon.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
