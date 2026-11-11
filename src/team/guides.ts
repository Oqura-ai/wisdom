import fs from 'node:fs';
import path from 'node:path';
import { ledger } from '../read/discovery.js';
import type { CommitRecord } from './commits.js';
import type { SessionStore } from '../storage/store.js';

/** Commit guides: a short account of a commit for the people who review it, written by a
 * cheap model after the commit (see writer.ts) and checked here. A guide is derived, never
 * evidence. The check proves it covers every item and that every citation names a real
 * step; it cannot prove the explanation is right, and the reader is told so.
 */

export const citation = /\[((?:t|a)\d+(?:\/c\d+)?|outside) ([A-Za-z0-9._-]{8,})\]/g;

export interface Item { key: string; label: string; recorded: boolean }

/** One item per piece of each file, or the whole file when it has no pieces. */
export function items(record: CommitRecord): Item[] {
  const describe = (indexes: number[]) => {
    const by = new Map<string, string[]>();
    for (const k of indexes) {
      const step = record.steps[k];
      const list = by.get(step.session) ?? by.set(step.session, []).get(step.session)!;
      const label = step.attribution === 'observed-during-tool' ? step.position : `${step.position} (changed outside any recorded step)`;
      if (!list.includes(label)) list.push(label);
    }
    return [...by].map(([id, labels]) => `${labels.join(', ')} in session ${id.slice(0, 8)}`).join('; ');
  };
  return record.files.flatMap(file => {
    if (file.pieces) return file.pieces.map(piece => ({ key: `${file.path} ${piece.header}`, recorded: piece.steps.length > 0,
      label: piece.steps.length ? describe(piece.steps) + (piece.unexplained ? ` · ${piece.unexplained} lines not recorded` : '') : 'not recorded' }));
    const label = file.note === 'outside-project' ? 'outside this project' : file.note === 'not-watched' ? 'excluded from recording'
      : file.chain.length ? `whole file from ${describe(file.chain)}` : 'not recorded';
    return [{ key: `${file.path} (${file.operation})`, label, recorded: file.chain.length > 0 }];
  });
}

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
 * a citation that names no real step. Empty when it passes. */
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
    catch (error) { problems.push(`${whole}: ${error instanceof Error ? error.message : error}`); }
  }
  return problems;
}

// ---------- the person's own switch ----------

const configFile = (dataDir: string) => path.join(dataDir, 'config.json');

/** Guides are written by default; a person can turn them off for their own commits. Their
 * records then say so, and the team's CI decides what that means. */
export function guidesOn(dataDir: string): boolean {
  try { return JSON.parse(fs.readFileSync(configFile(dataDir), 'utf8')).guides !== false; } catch { return true; }
}

export function setGuides(dataDir: string, on: boolean): void {
  let config: Record<string, unknown> = {};
  try { config = JSON.parse(fs.readFileSync(configFile(dataDir), 'utf8')); } catch { /* a new file */ }
  config.guides = on;
  fs.writeFileSync(configFile(dataDir), JSON.stringify(config, null, 2) + '\n');
}
