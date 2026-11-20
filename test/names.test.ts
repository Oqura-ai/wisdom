import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { call } from '../src/service/client.js';
import { startDaemon, type Connection } from '../src/service/daemon.js';
import { adapter } from '../src/harnesses/index.js';
import { sessionName } from '../src/core/schema.js';
import { defaultSharePath, draftShare, fileLabel, readShare, writeShare } from '../src/share/share.js';
import { planHandoff } from '../src/sessions/handoff.js';
import { harnessHome, marker } from '../src/core/paths.js';

const line = (root: string, entry: object) => JSON.stringify({ sessionId: 'name-me', cwd: root, timestamp: '2026-01-01T10:00:00.000Z', ...entry });

/** A project whose Claude Code home holds one finished session, found and recorded from its file. */
async function recorded(extra: object[] = []) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wisdom-names-')));
  const data = path.join(root, '.wisdom');
  fs.mkdirSync(data);
  fs.writeFileSync(path.join(data, marker), JSON.stringify({ project: root }));
  const file = path.join(harnessHome(data, 'claude-code'), 'projects', 'p', 'name-me.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, [line(root, { type: 'user', uuid: 'u1', message: { role: 'user', content: 'fix the login page' } }),
    line(root, { type: 'assistant', uuid: 'm1', message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'Fixed.' }] } }),
    ...extra.map(entry => JSON.stringify(entry))].join('\n') + '\n');
  const quiet = new Date(Date.now() - 10 * 60_000);
  fs.utimesSync(file, quiet, quiet);
  const daemon = await startDaemon(data, 0);
  daemon.captures.scan();
  return { root, data, daemon };
}

const session = async (c: Connection, root: string) =>
  (await call(c, '/view', { view: 'project', workspaceRoot: root })).sessions.find((s: any) => s.captureId === 'name-me');

test('a name is one line of at most 100 characters, with nothing that could move or hide text', () => {
  assert.equal(sessionName('  fix\nlogin\r\n page \t'), 'fix login page');
  assert.equal(sessionName('t3 done sessions · 1'), 't3 done sessions · 1', 'no line separator survives');
  assert.equal(sessionName('safe‮evil\u0007'), 'safeevil', 'no direction override or control character');
  assert.equal(sessionName('team 👨‍👩‍👧'), 'team 👨‍👩‍👧', 'an emoji built with joiners stays whole');
  assert.equal(sessionName('a'.repeat(150)), 'a'.repeat(100));
  assert.equal(sessionName('😀'.repeat(150)), '😀'.repeat(100), 'cut by character, never in half');
  assert.equal(sessionName(' \n\t '), '');
});

test('each harness gives only the name a person chose', () => {
  const claude = adapter('claude-code');
  assert.equal(claude.nativeName({ type: 'custom-title', customTitle: 'Login fix', sessionId: 's' }), 'Login fix');
  assert.equal(claude.nativeName({ type: 'ai-title', aiTitle: 'Made up', sessionId: 's' }), undefined, 'Claude Code made this one up');
  assert.equal(claude.nativeName({ type: 'agent-name', agentName: 'Made up', sessionId: 's' }), undefined);
  assert.equal(claude.nativeName({ type: 'user', message: { role: 'user', content: 'custom-title' } }), undefined);
  const pi = adapter('pi');
  assert.equal(pi.nativeName({ type: 'session_info', name: 'Refactor auth' }), 'Refactor auth');
  assert.equal(pi.nativeName({ type: 'session_info' }), '', 'a session_info with no name removes it');
  assert.equal(pi.nativeName({ type: 'message' }), undefined);
  assert.equal(adapter('codex').nativeName({ type: 'session_meta', payload: { thread_name: 'x' } }), undefined);
});

test('a name given in the harness is read from its file, and the newest wins', async () => {
  const { root, daemon } = await recorded([{ type: 'custom-title', customTitle: 'First name', sessionId: 'name-me' },
    { type: 'ai-title', aiTitle: 'Claude made this up', sessionId: 'name-me' },
    { type: 'custom-title', customTitle: 'Login\nfix', sessionId: 'name-me' }]);
  try {
    const found = await session(daemon.connection, root);
    assert.equal(found.harnessName, 'Login fix');
    assert.equal(found.name, undefined);
  } finally {
    await daemon.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('naming a session in Wisdom keeps it across a restart, changes no evidence, and an empty name removes it', async () => {
  const { root, data, daemon } = await recorded([{ type: 'custom-title', customTitle: 'From Claude', sessionId: 'name-me' }]);
  let restarted: Awaited<ReturnType<typeof startDaemon>> | undefined;
  try {
    const c = daemon.connection;
    const version = (await call(c, '/ledger', { glance: true })).text.match(/version (\d+)/)![1];
    const before = (await call(c, '/ledger', { capture: 'name-me', glance: true, at: Number(version) })).text;
    assert.deepEqual(await call(c, '/name', { session: 'name-me', name: '  Login\npage  ' }), { session: 'name-me', name: 'Login page' });
    const named = await session(c, root);
    assert.deepEqual([named.name, named.harnessName], ['Login page', 'From Claude']);
    assert.equal((await call(c, '/ledger', { capture: 'name-me', glance: true, at: Number(version) })).text, before,
      'a name is not evidence: the ledger reads the same at the same version');
    const markdown = await call(c, '/view', { view: 'markdown', capture: 'name-me' });
    assert.match(markdown.markdown, /^# Login page · claude-code session name-me/);

    await daemon.close();
    restarted = await startDaemon(data, 0);
    assert.equal((await session(restarted.connection, root)).name, 'Login page', 'kept in the manifest');
    assert.deepEqual(await call(restarted.connection, '/name', { session: 'name-me', name: ' \n ' }), { session: 'name-me' });
    const cleared = await session(restarted.connection, root);
    assert.deepEqual([cleared.name, cleared.harnessName], [undefined, 'From Claude']);
    await assert.rejects(call(restarted.connection, '/name', { session: 'nobody', name: 'x' }), /No recorded session has the ID nobody/);
    await assert.rejects(call(restarted.connection, '/name', { session: 'name-me' }), /name/);
  } finally {
    await (restarted ?? daemon).close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('resume finds a session by a name only it has, and never guesses', async () => {
  const { root, data, daemon } = await recorded();
  try {
    const c = daemon.connection;
    // A second finished session in the same home, named in Claude Code.
    const file = path.join(harnessHome(data, 'claude-code'), 'projects', 'p', 'other-one.jsonl');
    fs.writeFileSync(file, [JSON.stringify({ type: 'user', sessionId: 'other-one', cwd: root, uuid: 'u9', timestamp: '2026-01-02T10:00:00.000Z', message: { role: 'user', content: 'hi' } }),
      JSON.stringify({ type: 'custom-title', customTitle: 'Other one', sessionId: 'other-one' })].join('\n') + '\n');
    const quiet = new Date(Date.now() - 10 * 60_000);
    fs.utimesSync(file, quiet, quiet);
    daemon.captures.scan();
    await call(c, '/name', { session: 'name-me', name: 'Login fix' });
    const resolve = (session: string, byName = true) => call(c, '/resolve', { session, byName }).then(found => found.captureId as string);

    assert.equal(await resolve('login FIX'), 'name-me', 'any letter case');
    assert.equal(await resolve('Other one'), 'other-one', 'a name given in the harness');
    assert.equal(await resolve('other-one'), 'other-one', 'an ID is an ID');
    await assert.rejects(resolve('Login'), /No recorded session has the ID or name "Login"/, 'a part of a name is not the name');
    await assert.rejects(resolve('Login fix', false), /No recorded session has the ID Login fix/, 'without byName, an ID only (clone checks that a new ID is free)');

    // A session named like another session's ID: the ID wins.
    await call(c, '/name', { session: 'other-one', name: 'name-me' });
    assert.equal(await resolve('name-me'), 'name-me');

    await call(c, '/name', { session: 'other-one', name: 'login fix' });
    await assert.rejects(resolve('Login fix'), (error: Error) => {
      assert.match(error.message, /^2 sessions are named "Login fix", so none was opened: /);
      assert.match(error.message, /name-me \(claude-code, started .*\), other-one \(claude-code, started .*\)\. Use the ID, or rename one\.$/);
      return true;
    });
  } finally {
    await daemon.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('handoff, clone, share and export take a name too, tried last: an agent word, an ID, a prefix and latest mean what they did', async () => {
  const { root, data, daemon } = await recorded();
  try {
    const c = daemon.connection;
    const file = path.join(harnessHome(data, 'claude-code'), 'projects', 'p', 'other-one.jsonl');
    fs.writeFileSync(file, JSON.stringify({ type: 'user', sessionId: 'other-one', cwd: root, uuid: 'u9', timestamp: '2026-01-02T10:00:00.000Z', message: { role: 'user', content: 'hi' } }) + '\n');
    const quiet = new Date(Date.now() - 10 * 60_000);
    fs.utimesSync(file, quiet, quiet);
    daemon.captures.scan();
    await call(c, '/name', { session: 'name-me', name: 'claude' });
    await call(c, '/name', { session: 'other-one', name: 'Fix login' });
    const plan = (target: string, from?: string) => planHandoff(c, target, from, '', root);

    assert.equal((await plan('claude', 'name-me')).target, undefined, 'claude is the agent, never the session named claude');
    assert.equal((await plan('fix LOGIN', 'name-me')).target?.captureId, 'other-one', 'a name, in any letter case');
    assert.equal((await plan('codex', 'Fix login')).from.captureId, 'other-one', '--from takes a name');
    await assert.rejects(plan('nobody'), /nobody is neither a harness \(claude, codex, pi\) nor a recorded session's full ID or name/);

    const resolved = async (capture: string) => (await call(c, '/view', { view: 'markdown', capture })).captureId;
    assert.equal(await resolved('Fix login'), 'other-one', 'export takes a name');
    assert.equal((await call(c, '/view', { view: 'transcript', capture: 'fix login' })).manifest.captureId, 'other-one', 'clone and handoff --from take a name');
    assert.equal((await call(c, '/view', { view: 'export', capture: 'Fix login' })).manifest.captureId, 'other-one', 'share takes a name');
    // A name that is also another session's ID prefix: the prefix wins, as it always did.
    await call(c, '/name', { session: 'name-me', name: 'other-on' });
    assert.equal(await resolved('other-on'), 'other-one');
    assert.equal(await resolved('latest'), 'other-one', 'latest is the newest session, whatever the names');
    await assert.rejects(resolved('Fix'), /No session matches "Fix"/, 'part of a name is not a name');

    await call(c, '/name', { session: 'name-me', name: 'fix login' });
    await assert.rejects(resolved('Fix login'), /2 sessions are named "Fix login", so none was opened/);
    await assert.rejects(plan('Fix login'), /2 sessions are named "Fix login"/);
  } finally {
    await daemon.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a share or export file starts with the session\'s name, unless the name looks like a secret', () => {
  assert.equal(fileLabel({ name: 'Fix the Login page!' }), 'fix-the-login-page-');
  assert.equal(fileLabel({ harnessName: 'Café crème' }), 'cafe-creme-', 'accents become plain letters');
  assert.equal(fileLabel({ name: '日本語' }), '', 'nothing left to name it by');
  assert.equal(fileLabel({}), '');
  assert.equal(fileLabel({ name: 'try sk-proj-abcdefghijklmnopqrstuvwxyz123456' }), '', 'a file name is never redacted, so it holds no possible secret');
  assert.equal(fileLabel({ name: 'a'.repeat(60) }), `${'a'.repeat(40)}-`);
  const draft = { sessions: [{ manifest: { captureId: '7e1f2a3b-0000', name: 'Fix login' } }] } as any;
  assert.equal(path.basename(defaultSharePath('D', draft, new Date('2026-11-20T15:00:00Z'))), 'fix-login-7e1f2a3b-20261120-1500.wisdom-share');
});

test('a name leaves in a share file only after the secret check, and is redacted with the rest', async () => {
  const key = 'sk-proj-abcdefghijklmnopqrstuvwxyz123456';
  const { root, daemon } = await recorded();
  try {
    const c = daemon.connection;
    await call(c, '/name', { session: 'name-me', name: `try ${key}` });
    const draft = await draftShare(c, ['name-me']);
    assert.deepEqual(draft.findings.map(f => [f.kind, f.places]), [['openai-key', ['session name']]]);
    const out = path.join(root, 'out.wisdom-share');
    writeShare(draft, draft.findings, out);
    assert(!fs.readFileSync(out).includes(key));
    const shared = readShare(out);
    assert.equal(shared.manifests[0]!.name, 'try [redacted by sender: openai-key]');
    assert.equal(shared.records.length, draft.sessions[0]!.records.length, 'names add no record');
  } finally {
    await daemon.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
