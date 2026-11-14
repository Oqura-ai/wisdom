import { EvidenceReader } from '../storage/evidence.js';
import type { CommitRecord } from './commits.js';
import type { SessionStore } from '../storage/store.js';

/** A commit's items and the plain guide: what a commit's record says, in sentences, with no
 * model. The plain guide is written by the team-mode job when a person turns the model off,
 * and in local mode it is built each time a commit is read (wisdom glance --commit), never
 * stored. Both read only the record and the request of each turn it cites, so the same record
 * gives the same text. */

/** The first sentence of every guide writer's prompt. The daemon recognises a session file
 * that starts with it as a writer's run, never a person's session (record/captures.ts). */
export const GUIDE_OPENING = 'You write a commit guide for the people who will review this commit.';

/** `steps`: indexes into the record's steps that made the item. */
export interface Item { key: string; label: string; recorded: boolean; steps: number[] }

/** Past this many items, pieces made by exactly the same steps become one item (live test 8.1:
 * one tool call made 2,000 files, and a guide of 2,000 items was never written in time). */
export const GROUP_AFTER = 30;
const LISTED_FILES = 8;

/** One item per piece of each file, or the whole file when it has no pieces. A commit with more
 * than GROUP_AFTER of them gets one item per set of steps that made two or more pieces, listing
 * their files; a piece made by steps no other piece shares keeps its own item. The writer, the
 * plain guide and the check all use this list, so they agree on it. */
export function items(record: CommitRecord): Item[] {
  const each = pieceItems(record);
  if (each.length <= GROUP_AFTER) return each.map(({ item }) => item);
  const groups = new Map<string, typeof each>();
  for (const entry of each) {
    const signature = `${entry.item.recorded}:${[...entry.item.steps].sort((a, b) => a - b).join(',')}:${entry.why}`;
    (groups.get(signature) ?? groups.set(signature, []).get(signature)!).push(entry);
  }
  let n = 0;
  return [...groups.values()].map(members => {
    if (members.length === 1) return members[0].item;
    const files = [...new Set(members.map(member => member.path))];
    const shown = files.slice(0, LISTED_FILES).join(', ') + (files.length > LISTED_FILES ? `, and ${files.length - LISTED_FILES} more` : '');
    const { recorded, steps } = members[0].item;
    return { key: `group ${++n}: ${members.length} pieces in ${files.length} files`, recorded, steps,
      label: `${members[0].why} · ${shown}` };
  });
}

/** Every piece as its own item, with its file and what made it (the label without line counts). */
function pieceItems(record: CommitRecord): { item: Item; path: string; why: string }[] {
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
    if (file.pieces) return file.pieces.map(piece => {
      const why = piece.steps.length ? describe(piece.steps) : 'not recorded';
      return { path: file.path, why: why + (piece.unexplained ? ' · partly not recorded' : ''),
        item: { key: `${file.path} ${piece.header}`, recorded: piece.steps.length > 0, steps: piece.steps,
          label: piece.steps.length ? why + (piece.unexplained ? ` · ${piece.unexplained} lines not recorded` : '') : 'not recorded' } };
    });
    const label = file.note === 'outside-project' ? 'outside this project' : file.note === 'not-watched' ? 'excluded from recording'
      : file.chain.length ? `whole file from ${describe(file.chain)}` : 'not recorded';
    return [{ path: file.path, why: label, item: { key: `${file.path} (${file.operation})`, label, recorded: file.chain.length > 0, steps: file.chain } }];
  });
}

/** The person's request that opened a turn, by its position (t3 or t3/c2). */
export function turnRequest(store: SessionStore, id: string, position: string): string | undefined {
  const turn = /^t(\d+)/.exec(position)?.[1];
  if (!turn) return undefined;
  const inputs = store.database.records("capture_id=? AND type='input'", [id], 'ORDER BY seq').filter(r => !r.agentId && !r.internalAgent);
  const record = inputs[Number(turn) - 1];
  if (!record) return undefined;
  try { return JSON.parse(new EvidenceReader(store).read(record, 'data') ?? '{}').text; } catch { return undefined; }
}

const REQUEST_CHARS = 300;

/** Each item's steps, cited, with the request of the turn each was made in. It says what and
 * where, never why beyond those requests. A long request is cut, and the cut says how to read
 * the rest. `stores` finds the store that holds a session; a session not found here gets its
 * step cited without its request. */
export function plainGuide(record: CommitRecord, stores: (id: string) => SessionStore | undefined): string {
  const asked = new Map<string, string | undefined>();
  const request = (session: string, position: string) => {
    const turn = /^t\d+/.exec(position)?.[0];
    if (!turn) return undefined;
    const key = `${session}:${turn}`;
    if (!asked.has(key)) { const store = stores(session); asked.set(key, store ? turnRequest(store, session, position) : undefined); }
    const text = asked.get(key)?.replace(/\s+/g, ' ').trim();
    if (!text) return undefined;
    const quoted = text.length > REQUEST_CHARS
      ? `"${text.slice(0, REQUEST_CHARS)}" [… ${text.length - REQUEST_CHARS} more characters: open ${turn} to read it all]` : `"${text}"`;
    return `Asked in ${turn}: ${quoted}`;
  };
  const out = ['## Summary', `${record.commit.subject.split('\n')[0]}. Written by Wisdom from the commit's record, without a model: `
    + 'which recorded step made each piece and what was asked in that turn. It does not say why beyond those requests.', '', '## Items'];
  for (const item of items(record)) {
    out.push(`- ${item.key} · ${item.label}`);
    if (!item.steps.length) { out.push(`  ${item.label === 'not recorded' ? 'No recording explains this change.' : `Not recorded: ${item.label}.`}`); continue; }
    const sentences: string[] = [];
    for (const k of item.steps) {
      const step = record.steps[k];
      const harness = record.sessions.find(s => s.id === step.session)?.harness;
      const cite = `[${step.position} ${step.session.slice(0, 8)}]`;
      sentences.push(step.attribution === 'observed-during-tool' ? `Made by ${cite}${harness ? ` (${harness})` : ''}.` : `Changed outside any recorded step, seen at ${cite}.`);
      const said = request(step.session, step.position);
      if (said && !sentences.includes(`${said}.`)) sentences.push(`${said}.`);
    }
    out.push(`  ${sentences.join(' ')}`);
  }
  return out.join('\n') + '\n';
}
