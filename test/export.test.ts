import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { call } from '../src/client.js';
import { startDaemon, type Connection } from '../src/daemon.js';
import { adapter } from '../src/harnesses/index.js';
import { draftShare, writeShare } from '../src/share.js';
import { harnessHome, marker } from '../src/paths.js';

const bin = fileURLToPath(new URL('../src/bin.js', import.meta.url));
const secret = 'sk-proj-abcdefghijklmnopqrstuvwxyz123456';

function project(name: string) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `wisdom-export-${name}-`)));
  const data = path.join(root, '.wisdom');
  fs.mkdirSync(data);
  fs.writeFileSync(path.join(data, marker), JSON.stringify({ project: root }));
  return { root, data };
}

/** A live session: a prompt, a failed Bash call whose output holds a fence and a key, a file it
 * changed, and the reply the Stop hook reported.
 */
async function recorded() {
  const { root, data } = project('live');
  fs.writeFileSync(path.join(root, 'notes.txt'), 'before\n');
  const daemon = await startDaemon(data, 0);
  const send = (type: string, extra: Record<string, unknown> = {}) => call(daemon.connection, '/observe', { harness: 'claude-code', cwd: root,
    observation: { observationId: randomUUID(), sessionId: 'export-me', type, ...extra } });
  await send('input', { data: { text: 'Fix the *invoice* rounding\nand run the tests.' } });
  await send('tool_started', { toolCallId: 'b1', toolName: 'Bash', data: { input: { command: 'npm test' } } });
  fs.writeFileSync(path.join(root, 'notes.txt'), 'after\n');
  await send('tool_finished', { toolCallId: 'b1', toolName: 'Bash', isError: true, data: { response: { stdout: `failed:\n\`\`\`\nkey ${secret}\n\`\`\`` } } });
  await send('agent_settled', { data: { lastAssistantMessage: 'Rounding is fixed.' } });
  return { root, data, daemon };
}

const markdown = async (c: Connection, capture: string): Promise<string> => (await call(c, '/view', { view: 'markdown', capture })).markdown;
// The daemon runs in this process, so the CLI must not block its event loop.
const run = (cwd: string, ...args: string[]) => new Promise<{ code: number; stdout: string; stderr: string }>(resolve =>
  execFile(process.execPath, [bin, 'export', ...args], { cwd }, (error, stdout, stderr) => resolve({ code: error ? Number((error as any).code ?? 1) : 0, stdout, stderr })));

test('a session reads as Markdown: prompts and replies in full, each call folded with its whole input and output, patches raw', async () => {
  const { root, daemon } = await recorded();
  try {
    const md = await markdown(daemon.connection, 'export-me');
    assert.match(md, /^# Fix the \\\*invoice\\\* rounding · claude-code session export-m$/m);
    assert.match(md, /^claude-code · .+ · 1 turn · 1 tool call · 1 failed · 1 change$/m);
    assert.match(md, /^## t1 · Fix the \\\*invoice\\\* rounding$/m);
    assert.match(md, /^\*\*Prompt\*\*\n\n> Fix the \*invoice\* rounding\n> and run the tests\.$/m);
    assert.match(md, /^<details><summary>t1\/c1 · Bash · failed<\/summary>$/m);
    assert.match(md, /^````\n\{\n {2}"stdout": "failed:\\n```\\nkey sk-proj/m, 'a fence longer than the output\'s own backticks');
    assert.match(md, /^\*\*Reply\*\* \*\(from hook\)\*\n\nRounding is fixed\.$/m);
    assert.match(md, /^`notes\.txt` · modify · observed-during-tool\n\n```diff\n[\s\S]*-before\n\+after\n```$/m);
    assert.match(md, /Recorded with \[Wisdom\]\(https:\/\/github\.com\/Oqura-ai\/wisdom\)\.\n$/);
  } finally {
    await daemon.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('thinking is folded when its text was recorded, and named when it was not', async () => {
  const { root, data } = project('thinking');
  const id = 'thinking-session';
  const file = adapter('claude-code').sessionFile(harnessHome(data, 'claude-code'), id, root, new Date());
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const line = (o: object) => JSON.stringify({ sessionId: id, cwd: root, ...o });
  fs.writeFileSync(file, [line({ type: 'user', uuid: 'u1', timestamp: '2026-01-01T10:00:00.000Z', message: { role: 'user', content: 'Plan it.' } }),
    line({ type: 'assistant', uuid: 'm1', timestamp: '2026-01-01T10:00:05.000Z', message: { id: 'm1', role: 'assistant',
      content: [{ type: 'thinking', thinking: 'Check the tests first.' }, { type: 'thinking', thinking: '' }, { type: 'text', text: 'Planned.' }] } })].join('\n') + '\n');
  const quiet = new Date(Date.now() - 10 * 60_000);
  fs.utimesSync(file, quiet, quiet);
  const daemon = await startDaemon(data, 0);
  try {
    daemon.captures.scan();
    const md = await markdown(daemon.connection, id);
    assert.match(md, /^<details><summary>Thinking<\/summary>\n\n```\nCheck the tests first\.\n```\n\n<\/details>$/m);
    assert.match(md, /^\*Thinking: redacted\. It happened; its text was not recorded\.\*$/m);
    assert.match(md, /^> \*\*Not recorded:\*\* not-recorded-live:/m, 'a gap shows where it happened');
  } finally {
    await daemon.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('wisdom export checks for secrets first: it refuses without a choice, redacts when asked, and can print to stdout', async () => {
  const { root, data, daemon } = await recorded();
  try {
    const refused = await run(root, 'export-me');
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /^Found 1 possible secret:\n {2}1 {2}openai-key {9}sk-pro…3456 {7}t1/m);
    assert.match(refused.stderr, /nothing was written/);
    assert(!fs.existsSync(path.join(data, 'shared-out')));

    const printed = await run(root, 'export-me', '--redact', '--out', '-');
    assert.equal(printed.code, 0, printed.stderr);
    assert.match(printed.stdout, /^# Fix the/);
    assert(!printed.stdout.includes(secret) && printed.stdout.includes('[redacted by sender: openai-key]'));
    assert.doesNotMatch(printed.stdout, /Saved|Redacted 1/, 'messages stay out of the document');

    const kept = await run(root, 'export-me', '--keep-secrets');
    assert.equal(kept.code, 0, kept.stderr);
    assert.match(kept.stderr, new RegExp(`^Saved ${path.join(data, 'shared-out', 'export-m.md').replaceAll('\\', '\\\\')}\\.$`, 'm'));
    assert(fs.readFileSync(path.join(data, 'shared-out', 'export-m.md'), 'utf8').includes(secret));
  } finally {
    await daemon.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a session shared with you exports too, saying it is a shared copy', async () => {
  const { root, daemon: senderDaemon } = await recorded();
  const receiver = project('receiver');
  const daemon = await startDaemon(receiver.data, 0);
  try {
    const draft = await draftShare(senderDaemon.connection, ['export-me']);
    const file = path.join(root, 'out.wisdom-share');
    writeShare(draft, draft.findings, file);
    await call(daemon.connection, '/import', { file });
    const md = await markdown(daemon.connection, 'export-me');
    assert.match(md, new RegExp(`^A shared copy from ${path.basename(root)}, as recorded on the sender's machine\\.$`, 'm'));
    assert.match(md, /\[redacted by sender: openai-key\]/);
  } finally {
    await daemon.close(); await senderDaemon.close();
    fs.rmSync(receiver.root, { recursive: true, force: true }); fs.rmSync(root, { recursive: true, force: true });
  }
});
