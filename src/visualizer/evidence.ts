/**
 * Where the Commits builder's sessions come from, and the two checks it re-runs on them.
 *
 * `storeEvidence` wraps any session stores: the step check is discovery.ts's `checkStep` (a
 * step's file hashes and patch against its session), the guide check is guides.ts's
 * `checkGuide`, both the same code `glance --commit` and `wisdom check` use. Turns are
 * assembled by conversation.ts, as the Usage dashboard shows them, never cut (docs/policy.md).
 *
 * `remoteSessions` is the team source: the session refs a fetch brought into a clone (a CI
 * runner's), each share file imported read-only, the deletion list applied.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listRefs, readFile, refSafe } from '../team/gitrefs.js';
import { FETCHED, readDeleted } from '../team/team.js';
import { checkGuide } from '../team/guides.js';
import { checkStep } from '../read/discovery.js';
import { conversation } from '../read/conversation.js';
import { EvidenceReader } from '../storage/evidence.js';
import { SharedLibrary } from '../share/shared.js';
import type { SessionStore } from '../storage/store.js';
import type { LedgerRecord } from '../core/schema.js';
import type { Evidence } from './build.js';

/** The user's own inputs, in recorded order: the ledger's turns (t1, t2, ...). */
function turnRecords(store: SessionStore, id: string): LedgerRecord[] {
  return store.database.records(`capture_id=? AND type='input'`, [id], 'ORDER BY seq').filter(r => !r.agentId && !r.internalAgent);
}

const TITLE = 120;
function promptText(store: SessionStore, record: LedgerRecord): string {
  try {
    const raw = new EvidenceReader(store).read(record, 'data');
    const text = raw === undefined ? '' : String(JSON.parse(raw)?.text ?? '');
    return text;
  } catch { return ''; }
}
const when = (record: LedgerRecord) => record.sourceTimestamp ?? record.observedAt;

export function storeEvidence(stores: (id: string) => SessionStore | undefined, ids: () => string[]): Evidence {
  const has = (id: string) => { const store = stores(id); if (!store) return undefined; try { store.get(id); return store; } catch { return undefined; } };
  return {
    session(id) {
      const store = has(id);
      if (!store) return undefined;
      const manifest = store.get(id).manifest;
      const turns = turnRecords(store, id);
      const title = turns.length ? promptText(store, turns[0]).replace(/\s+/g, ' ').trim().slice(0, TITLE) : '';
      const last = turns.at(-1);
      return { harness: manifest.harness, title, turns: turns.length, lastActiveAt: manifest.endedAt ?? (last ? when(last) : manifest.startedAt) };
    },
    step: step => checkStep(stores, step),
    guide: (text, record) => checkGuide(text, record, stores, ids),
    turns(id) {
      const store = has(id);
      if (!store) return [];
      return turnRecords(store, id).map((record, k) => ({
        turn: k + 1, at: when(record), request: promptText(store, record),
        items: () => conversation(store, { captureId: id, requestId: record.id }).items,
      }));
    },
  };
}

/** The sessions a fetch brought into this clone, as read-only stores in `dir` (a cache folder
 * reused between builds: the same share file is imported once). Deleted sessions are skipped. */
export function remoteSessions(project: string, dir: string): { stores: (id: string) => SessionStore | undefined; ids: () => string[]; keys: Map<string, string> } {
  const library = new SharedLibrary(dir);
  const deleted = new Set(readDeleted(project).map(d => d.key));
  const byId = new Map<string, SessionStore>(), keys = new Map<string, string>();
  for (const [ref, sha] of listRefs(project, FETCHED)) {
    const key = ref.slice(FETCHED.length);
    if (deleted.has(key)) continue;
    const bytes = readFile(project, sha, 'session.wisdom-share');
    if (!bytes) continue;
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'wisdom-commits-'));
    try {
      const file = path.join(temp, `${refSafe(key)}.wisdom-share`);
      fs.writeFileSync(file, bytes);
      const { store } = library.import(file);
      for (const id of store.ids) { byId.set(id, store); keys.set(id, key); }
    } catch (error) {
      console.error(`Could not read the session ${key}: ${error instanceof Error ? error.message : error}`);
    } finally { fs.rmSync(temp, { recursive: true, force: true }); }
  }
  return { stores: id => byId.get(id), ids: () => [...byId.keys()], keys };
}
