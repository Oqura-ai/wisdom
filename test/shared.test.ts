import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { call } from '../src/client.js';
import { startDaemon, type Connection } from '../src/daemon.js';
import { chooseSource, type HandoffSession } from '../src/handoff.js';
import { draftShare, writeShare } from '../src/share.js';
import { SharedLibrary } from '../src/shared.js';
import { marker } from '../src/paths.js';

const bin = fileURLToPath(new URL('../src/bin.js', import.meta.url));
const secret = 'sk-proj-abcdefghijklmnopqrstuvwxyz123456';

function project(name: string) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `wisdom-${name}-`)));
  const data = path.join(root, '.wisdom');
  fs.mkdirSync(data);
  fs.writeFileSync(path.join(data, marker), JSON.stringify({ project: root }));
  return { root, data };
}

/** A sender's project with one session, shared with its secret redacted. */
async function shareFrom(sessionId = 'sent-session') {
  const sender = project('sender');
  const daemon = await startDaemon(sender.data, 0);
  const send = (type: string, extra: Record<string, unknown>) => call(daemon.connection, '/observe', { harness: 'claude-code', cwd: sender.root,
    observation: { observationId: randomUUID(), sessionId, type, ...extra } });
  await send('input', { data: { text: 'Fix the login test.' } });
  await send('tool_started', { toolCallId: 'b1', toolName: 'Bash', data: { input: { command: 'npm test' } } });
  await send('tool_finished', { toolCallId: 'b1', toolName: 'Bash', isError: true, data: { response: { stdout: `failed with key ${secret}` } } });
  const draft = await draftShare(daemon.connection, [sessionId]);
  const file = path.join(sender.root, 'out.wisdom-share');
  writeShare(draft, draft.findings, file);
  return { sender, daemon, file };
}

const glance = async (c: Connection, capture?: string): Promise<string> => (await call(c, '/ledger', { ...(capture ? { capture } : {}), glance: true })).text;
const cleanup = async (...items: ({ close: () => Promise<void> } | { root: string })[]) => {
  for (const item of items) 'close' in item ? await item.close() : fs.rmSync(item.root, { recursive: true, force: true });
};

test('a teammate imports a shared file and reads it like their own, labelled and read-only', async () => {
  const { sender, daemon: senderDaemon, file } = await shareFrom();
  const receiver = project('receiver');
  const daemon = await startDaemon(receiver.data, 0);
  try {
    const c = daemon.connection;
    const imported = await call(c, '/import', { file });
    assert.equal(imported.added, true);
    assert.deepEqual(imported.sessions.map((s: any) => [s.captureId, s.turns]), [['sent-session', 1]]);
    assert.equal(imported.shared.project, path.basename(sender.root));

    const list = await glance(c);
    assert.match(list, /^shared with you · 1, read-only$/m);
    assert.match(list, new RegExp(`^sent-session  claude-code  .+  1 turn  from ${path.basename(sender.root)}, shared `, 'm'));

    const header = await glance(c, 'sent-session');
    assert.match(header, new RegExp(`^shared copy from ${path.basename(sender.root)}, shared .+ · read-only, as recorded on the sender's machine$`, 'm'));
    assert.match(header, /^redacted by sender ×1$/m);
    assert.doesNotMatch(header, /resume with/);
    const turn = (await call(c, '/ledger', { capture: 'sent-session', open: 't1' })).text;
    assert.match(turn, /\[redacted by sender: openai-key\]/);
    assert(!turn.includes(secret));

    const { sessions } = await call(c, '/view', { view: 'shared' });
    assert.equal(sessions[0].shared.project, path.basename(sender.root));
    assert.equal(sessions[0].resume, undefined, 'a shared session has no resume command');
    const events = await call(c, '/view', { view: 'capture', captureId: 'sent-session' });
    assert(events.events.some((e: any) => e.type === 'tool_finished' && e.isError));

    const again = await call(c, '/import', { file });
    assert.equal(again.added, false, 'the same file imported twice is one copy');
    assert.equal(fs.readdirSync(path.join(receiver.data, 'shared')).length, 1);
  } finally { await cleanup(daemon, senderDaemon, receiver, sender); }
});

test('wisdom import says what it imported, and that it is read-only', async () => {
  const { sender, daemon: senderDaemon, file } = await shareFrom();
  const receiver = project('cli-import');
  const daemon = await startDaemon(receiver.data, 0);
  try {
    // The daemon runs in this process, so the CLI must not block its event loop.
    const run = () => new Promise<string>(resolve => execFile(process.execPath, [bin, 'import', file], { cwd: receiver.root }, (e, out, err) => resolve(e ? err : out)));
    assert.equal(await run(), [
      `Imported 1 shared session from ${path.basename(sender.root)}, shared ${/shared (\S+ \S+Z)/.exec(await glance(daemon.connection, 'sent-session'))?.[1] ?? ''}:`,
      '  sent-session  claude-code  1 turn',
      'The sender redacted 1 value.',
      "Read-only, as recorded on the sender's machine. Read it with: wisdom glance sent-ses",
      '',
    ].join('\n'));
    assert.match(await run(), /^Already imported: 1 shared session from /);
  } finally { await cleanup(daemon, senderDaemon, receiver, sender); }
});

test('shared copies survive a daemon restart, and a cut-off import is never read', async () => {
  const { sender, daemon: senderDaemon, file } = await shareFrom();
  const receiver = project('restart');
  let daemon = await startDaemon(receiver.data, 0);
  try {
    await call(daemon.connection, '/import', { file });
    fs.mkdirSync(path.join(receiver.data, 'shared', 'half.importing'));
    fs.writeFileSync(path.join(receiver.data, 'shared', 'half.importing', 'info.json'), '{}');
    await daemon.close();
    daemon = await startDaemon(receiver.data, 0);
    assert.match(await glance(daemon.connection), /^shared with you · 1, read-only$/m);
  } finally { await cleanup(daemon, senderDaemon, receiver, sender); }
});

test('a file dropped into the shared folder is imported by itself, once it stops changing', async () => {
  const { sender, daemon: senderDaemon, file } = await shareFrom();
  const receiver = project('drop');
  const library = new SharedLibrary(path.join(receiver.data, 'shared'));
  try {
    fs.mkdirSync(library.dir, { recursive: true });
    const dropped = path.join(library.dir, 'from-alex.wisdom-share');
    fs.copyFileSync(file, dropped);
    library.poll(Date.now());
    assert.equal(library.all.length, 0, 'a file still being written is left alone');
    library.poll(Date.now() + 10_000);
    assert.equal(library.all.length, 1);
    assert(!fs.existsSync(dropped), 'the dropped file is moved into its copy');

    fs.writeFileSync(path.join(library.dir, 'broken.wisdom-share'), 'not a share');
    library.poll(Date.now() + 20_000);
    assert(fs.existsSync(path.join(library.dir, 'broken.wisdom-share.rejected')));
  } finally { library.close(); await cleanup(senderDaemon, receiver, sender); }
});

test('a share file that names a path outside its own folder is refused, and nothing is written', async () => {
  const { sender, daemon: senderDaemon, file } = await shareFrom();
  const receiver = project('unsafe');
  const library = new SharedLibrary(path.join(receiver.data, 'shared'));
  try {
    const lines = zlib.gunzipSync(fs.readFileSync(file)).toString('utf8').trimEnd().split('\n');
    const index = lines.findIndex(line => line.includes('"kind":"file"'));
    lines[index] = lines[index]!.replace(/"path":"[^"]+"/, '"path":"../../escaped.txt"');
    const crafted = path.join(receiver.root, 'crafted.wisdom-share');
    fs.writeFileSync(crafted, zlib.gzipSync(lines.join('\n') + '\n'));
    assert.throws(() => library.import(crafted), /holds a file Wisdom will not write: "sent-session\/\.\.\/\.\.\/escaped\.txt"/);
    assert(!fs.existsSync(path.join(receiver.data, 'escaped.txt')) && !fs.existsSync(path.join(receiver.root, 'escaped.txt')));
    assert.equal(library.all.length, 0);
  } finally { library.close(); await cleanup(senderDaemon, receiver, sender); }
});

test('when a shared session is also recorded here, reads show this project\'s own recording', async () => {
  const { sender, daemon, file } = await shareFrom();
  try {
    const imported = await call(daemon.connection, '/import', { file });
    assert.deepEqual(imported.alsoRecordedHere, ['sent-session']);
    const header = await glance(daemon.connection, 'sent-session');
    assert.match(header, /^resume with: wisdom resume sent-session$/m);
    assert.doesNotMatch(header, /shared copy/);
  } finally { await cleanup(daemon, sender); }
});

test('handoff reads a shared session only when named, and never resumes one', async () => {
  const session = (captureId: string, lastObservedAt: string, shared?: object): HandoffSession =>
    ({ captureId, harness: 'claude-code', status: 'closed', lastObservedAt, tokens: { total: 0 }, shared });
  assert.equal(chooseSource([session('mine', '2026-01-01'), session('theirs', '2026-01-09', {})], { harness: 'codex' })?.captureId, 'mine');

  const { sender, daemon: senderDaemon, file } = await shareFrom();
  const receiver = project('handoff-shared');
  const daemon = await startDaemon(receiver.data, 0);
  try {
    await call(daemon.connection, '/import', { file });
    // The daemon runs in this process, so the CLI must not block its event loop.
    const stderr = await new Promise<string>(resolve => execFile(process.execPath, [bin, 'handoff', 'sent-session'], { cwd: receiver.root }, (_e, _o, err) => resolve(err)));
    assert.match(stderr, /^A shared session is read-only, so it cannot be resumed\. Start a new one that reads it: wisdom handoff claude\|codex\|pi --from sent-session/);
  } finally { await cleanup(daemon, senderDaemon, receiver, sender); }
});
