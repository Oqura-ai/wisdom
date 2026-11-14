import fs from 'node:fs';
import path from 'node:path';
import { ledger } from '../read/discovery.js';
import { items } from './plain.js';
import type { CommitRecord } from './commits.js';
import type { SessionStore } from '../storage/store.js';

/** Commit guides: a short account of a commit for the people who review it, written after the
 * commit by a cheap model, or by Wisdom without one (see writer.ts, plain.ts), and checked
 * here. A guide is derived, never evidence. The check proves it covers every item and that
 * every citation names a real step; it cannot prove the explanation is right, and the reader
 * is told so.
 */

export const citation = /\[((?:t|a)\d+(?:\/c\d+)?|outside) ([A-Za-z0-9._-]{8,})\]/g;
export { items, type Item } from './plain.js';

/** Each item's paragraph: the lines under its `- key` line, up to the next item or heading. */
function paragraphs(text: string, keys: string[]): Map<string, string> {
  const result = new Map<string, string>();
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const key = keys.find(k => lines[i] === `- ${k}` || lines[i].startsWith(`- ${k} · `));
    if (!key) continue;
    const body: string[] = [];
    for (let j = i + 1; j < lines.length && !/^(- |#)/.test(lines[j]); j++) body.push(lines[j]);
    result.set(key, body.join('\n').trim());
  }
  return result;
}

/** What is wrong with a guide: a missing summary or item, a recorded item with no citation,
 * a citation that names no real step, a citation of a session the commit does not carry (its
 * reviewers may not have it), or of a turn outside that session's window. Empty when it passes. */
export function checkGuide(text: string, record: CommitRecord, stores: (id: string) => SessionStore | undefined, allIds: () => string[]): string[] {
  const problems: string[] = [];
  const summary = /## Summary\r?\n([\s\S]*?)(?=\r?\n## |$)/.exec(text)?.[1].trim();
  if (!summary) problems.push('There is no summary under "## Summary".');
  const list = items(record);
  const answers = paragraphs(text, list.map(item => item.key));
  for (const item of list) {
    const answer = answers.get(item.key);
    if (answer === undefined) { problems.push(`The item "- ${item.key}" is missing.`); continue; }
    if (!answer) { problems.push(`${item.key}: nothing is written for it.`); continue; }
    if (item.recorded && !/^skip:/i.test(answer) && !answer.match(citation)) problems.push(`${item.key}: made by a recorded step, but cites none.`);
  }
  for (const [whole, position, prefix] of text.matchAll(citation)) {
    const ids = allIds().filter(candidate => candidate === prefix || candidate.startsWith(prefix));
    if (ids.length !== 1) { problems.push(`${whole}: ${ids.length ? 'more than one session starts with' : 'no session starts with'} ${prefix}.`); continue; }
    const store = stores(ids[0]);
    try { if (!store) throw new Error('session not available'); ledger(store, { capture: ids[0], open: position }); }
    catch (error) { problems.push(`${whole}: ${error instanceof Error ? error.message : error}`); continue; }
    const session = record.sessions.find(s => s.id === ids[0]);
    if (!session) { problems.push(`${whole}: session ${prefix} did not make any of this commit, so it is not sent with it and reviewers may not have it.`); continue; }
    const turn = Number(/^t(\d+)/.exec(position)?.[1]);
    if (turn && session.turns && (turn < session.turns[0] || turn > session.turns[1])) {
      problems.push(`${whole}: outside this commit's window for that session (t${session.turns[0]}–t${session.turns[1]}).`);
    }
  }
  return problems;
}

// ---------- the person's own switch ----------

const configFile = (dataDir: string) => path.join(dataDir, 'config.json');

/** Whether a model writes this person's guides after each commit. In team mode it is on unless
 * they turned it off (off: Wisdom writes a plain guide from the record, plain.ts). In local mode
 * (`team` false) it is off unless they turned it on with `wisdom guide on`, which also installs
 * the one post-commit hook that starts the writer. */
export function guidesOn(dataDir: string, team = true): boolean {
  try {
    const value = JSON.parse(fs.readFileSync(configFile(dataDir), 'utf8')).guides;
    return typeof value === 'boolean' ? value : team;
  } catch { return team; }
}

export function setGuides(dataDir: string, on: boolean): void {
  let config: Record<string, unknown> = {};
  try { config = JSON.parse(fs.readFileSync(configFile(dataDir), 'utf8')); } catch { /* a new file */ }
  config.guides = on;
  fs.writeFileSync(configFile(dataDir), JSON.stringify(config, null, 2) + '\n');
}
