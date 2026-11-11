import test from 'node:test';
import assert from 'node:assert/strict';
import { stripVTControlCharacters, styleText } from 'node:util';
import { paint } from '../src/terminal.js';

const style = (format: Parameters<typeof styleText>[0], text: string) => styleText(format, text, { validateStream: false });

const glance = [
  'session 5bc7493f-0b4e-40e8-88af-0e72d65bab04 · claude-code 2.1.296 · recording · version 12',
  'resume with: wisdom resume 5bc7493f-0b4e-40e8-88af-0e72d65bab04',
  '2 turns · 3 tool calls · 1 failed · 1 pending · 1 change · 0 subagents · 1,200 tokens',
  'not recorded  oversize-file:big.tgz (seq 1)',
  '',
  't1  in        fix the failing test',
  '    out       The test passes now.',
  '    3 tool calls · 1 failed · changed src/a.ts',
  '',
  't2  in',
  '        a pasted prompt',
  '        + with a line that looks like a diff',
  '    no tool calls · no changes',
  '',
  'complete · 14 lines',
].join('\n');

const open = [
  't1 · session 5bc7493f · version 12 · 1,200 tokens',
  'in        fix the failing test',
  '',
  'thinking  redacted · 202 ms (it happened; its text was not recorded)',
  'reply',
  '    - a list in a reply is not a removed line',
  'c1  Bash npm test · failed · 2.0 s',
  '    input     {"command":"npm test"}',
  '    output',
  '        1 failing',
  'c2  Edit src/a.ts · ok · 12 ms · → p1',
  '    input and output repeat p1 · open t1/c2 to read them',
  '',
  'p1  src/a.ts · modified · +1 −1 · observed during c2',
  '    --- src/a.ts',
  '    +++ src/a.ts',
  '    @@ -1,1 +1,1 @@',
  '    -old',
  '    +new',
  '',
  'limited · lines 1–20 of 90 · continue: {"capture":"5bc7493f","open":"t1","at":12,"from":21}',
].join('\n');

const list = [
  'sessions · 2, newest first · version 12',
  '',
  '5bc7493f-0b4e-40e8-88af-0e72d65bab04  codex  recording  2026-11-09 08:46Z  16 turns  c:\\project',
  '',
  'To read one, glance its ID or its first 8 characters.',
].join('\n');

test('the painted text is the ledger text: colour is added, no word changes', () => {
  for (const text of [glance, open, list]) {
    const painted = paint(text);
    assert.notEqual(painted, text);
    assert.equal(stripVTControlCharacters(painted), text);
  }
});

test('colour marks what went wrong, what is open and what changed', () => {
  const lines = (text: string) => paint(text).split('\n');
  const g = lines(glance), o = lines(open);
  assert.ok(g[2].includes(style('red', '1 failed')) && g[2].includes(style('yellow', '1 pending')));
  assert.ok(g[0].includes(style('green', 'recording')) && g[0].includes(style('yellow', 'claude-code')));
  assert.ok(g[7].includes(style('red', '1 failed')));
  assert.ok(o[6].includes(style('red', 'failed')) && o[10].includes(style('green', 'ok')));
  assert.equal(o[17], style('red', '    -old'));
  assert.equal(o[18], style('green', '    +new'));
  assert.equal(o[20], style('yellow', open.split('\n')[20]));
  assert.ok(lines(list)[2].includes(style('green', 'codex')));
});

test('a diff is coloured only inside a patch', () => {
  assert.equal(paint(glance).split('\n')[11], style('bold', '        + with a line that looks like a diff'));
  assert.equal(paint(open).split('\n')[5], '    - a list in a reply is not a removed line');
});

test('with a width, long lines and blocks are shortened and say how to read the whole', () => {
  const pasted = Array.from({ length: 8 }, (_, i) => `        pasted line ${i + 1}`);
  const fitted = stripVTControlCharacters(paint([
    'session 5bc7493f-0b4e-40e8-88af-0e72d65bab04 · codex · closed · version 12',
    '',
    't1  in',
    ...pasted,
    `    out       ${'word '.repeat(30)}`,
    '    no tool calls · no changes',
    '',
    'complete · 14 lines',
  ].join('\n'), 60)).split('\n');
  assert.deepEqual(fitted.slice(2, 7), ['t1  in', ...pasted.slice(0, 3), '        … 5 more lines · wisdom open t1 --capture 5bc7493f']);
  assert.equal(fitted[7], `    out       ${'word '.repeat(30)}`.slice(0, 59) + '…');
  assert.equal(fitted.at(-1), 'shortened to fit the terminal · --plain prints the whole text, as agents read it');

  const turn = stripVTControlCharacters(paint([
    't1 · session 5bc7493f · version 12 · 1,200 tokens',
    `reply     ${'word '.repeat(20).trim()}`,
    'c1  Bash · ok · 2.0 s',
    '    output',
    ...pasted,
    '',
    'p1  a.ts · modified · +1 −0 · observed during c1',
    `    +${'x'.repeat(100)}`,
  ].join('\n'), 60)).split('\n');
  assert.deepEqual(turn.slice(1, 4), [`reply     ${'word '.repeat(10).trim()}`, `          ${'word '.repeat(10).trim()}`, '']);
  assert.equal(turn[12], '        … 2 more lines · wisdom open t1/c1 --capture 5bc7493f');
  assert.equal(turn[15], `    +${'x'.repeat(100)}`);
});

test('the fitted session list is in columns and counts sessions with no turns', () => {
  const fitted = stripVTControlCharacters(paint([
    'sessions · 3, newest first · version 12',
    '',
    'a74144ff-2d8e-4f74-8421-88e75330c9e0  codex  recording  2026-11-10 12:42Z  1 turn  c:\\project',
    '078f3079-0c07-47f7-bd83-b3c6ea6458ca  claude-code  closed  2026-11-10 12:42Z  0 turns  c:\\project',
    '5bc7493f-0b4e-40e8-88af-0e72d65bab04  claude-code  closed  2026-11-09 08:46Z  16 turns  c:\\project',
    '',
    'shared with you · 1, read-only',
    '',
    '6619f146-1931-4d43-8f78-43b6ede94c7c  pi  2026-11-09 11:30Z  19 turns  from wisdom, shared 2026-11-09 13:34Z',
  ].join('\n'), 150)).split('\n');
  assert.deepEqual(fitted.slice(2, 5), [
    'a74144ff-2d8e-4f74-8421-88e75330c9e0  codex        recording    2026-11-10 12:42Z     1 turn  c:\\project',
    '5bc7493f-0b4e-40e8-88af-0e72d65bab04  claude-code  closed       2026-11-09 08:46Z   16 turns  c:\\project',
    '1 session with no turns is not listed',
  ]);
  assert.equal(fitted[8], '6619f146-1931-4d43-8f78-43b6ede94c7c  pi                        2026-11-09 11:30Z   19 turns  from wisdom, shared 2026-11-09 13:34Z');
});
