import fs from 'node:fs';
import path from 'node:path';
import type { Captures } from '../record/captures.js';
import { LedgerDatabase } from '../storage/database.js';
import { ledger } from '../read/discovery.js';
import { Ledger, hash, writeJson } from '../storage/ledger.js';
import type { ViewRequest } from '../core/schema.js';
import { readShare, type ShareFile } from './share.js';
import { stats } from '../read/stats.js';
import type { SessionStore, SharedInfo, SharedSession } from '../storage/store.js';
import { view } from '../read/views.js';

// A shared file names its own sessions and files. Anything outside these shapes could write
// outside the store's folder, so it is refused.
const safeId = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** A copy's folder is named by the first 16 hex characters of its share file's hash. */
const SHARE_ID = /^[a-f0-9]{16}$/;
const safeFile =/^(?:payloads\/[a-f0-9]{64}|native-session\.jsonl|subagents\/[A-Za-z0-9][A-Za-z0-9._-]*\.jsonl)$/;

interface StoreInfo { shareId: string; sourceName: string; importedAt: string; header: ShareFile['header'] }

/** One imported share file: its own database, built from the file's records, and its
 * sessions' evidence folders. Read-only: nothing records into it, and its versions are its own.
 */
export class SharedStore implements SessionStore {
  readonly database: LedgerDatabase;
  readonly shared: SharedInfo;
  private ledgers = new Map<string, Ledger>();

  constructor(readonly dataDir: string) {
    const info: StoreInfo = JSON.parse(fs.readFileSync(path.join(dataDir, 'info.json'), 'utf8'));
    this.database = new LedgerDatabase(path.join(dataDir, 'ledger.sqlite'));
    for (const manifest of this.database.manifests()) this.ledgers.set(manifest.captureId, new Ledger(path.join(dataDir, manifest.captureId), manifest, this.database));
    this.shared = { shareId: info.shareId, project: info.header.sessions[0]?.project ?? 'unknown', sharedAt: info.header.createdAt,
      importedAt: info.importedAt, redactions: info.header.redactions.length, patchesEdited: info.header.patchesEdited.map(p => p.path ?? '').filter(Boolean) };
  }

  get(id: string): Ledger {
    const found = this.ledgers.get(id);
    if (!found) throw new Error(`No shared session has the ID ${id}.`);
    return found;
  }

  get ids(): string[] { return [...this.ledgers.keys()]; }
}

/** A session ID or a unique prefix of 8 or more characters names this session. */
const names = (id: string, ref: string) => id === ref || (ref.length >= 8 && id.startsWith(ref));

/** Every shared file imported into this project, kept in `.wisdom/shared/<share-id>/`. A file
 * dropped into `.wisdom/shared/` is imported by itself.
 */
export class SharedLibrary {
  private stores = new Map<string, SharedStore>();
  private lastPoll = 0;

  /** A folder still `.importing` was cut off mid-import and is never read. One store that
   * cannot be opened is reported and skipped, so it never stops the daemon or the others.
   */
  constructor(readonly dir: string) {
    if (!fs.existsSync(dir)) return;
    this.finishRemovals();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.endsWith('.importing') || !fs.existsSync(path.join(dir, entry.name, 'info.json'))) continue;
      try { this.stores.set(entry.name, new SharedStore(path.join(dir, entry.name))); }
      catch (error) { console.error(`Could not open the shared copy in ${path.join(dir, entry.name)}: ${error instanceof Error ? error.message : error}`); }
    }
  }

  get all(): SharedStore[] { return [...this.stores.values()]; }

  /** The shared store holding this session, if exactly one does. */
  owner(ref: string): SharedStore | undefined {
    const exact = this.all.find(store => store.ids.includes(ref));
    if (exact) return exact;
    const matches = this.all.filter(store => store.ids.some(id => names(id, ref)));
    if (matches.length > 1) throw new Error(`"${ref}" matches sessions in ${matches.length} shared files; use more of the ID.`);
    return matches[0];
  }

  sessions(): SharedSession[] {
    return this.all.flatMap(store => store.database.manifests().map(manifest => ({
      captureId: manifest.captureId, harness: manifest.harness, startedAt: manifest.startedAt, project: store.shared.project, sharedAt: store.shared.sharedAt,
      turns: Number(store.database.sql.prepare(`SELECT count(*) AS n FROM records WHERE capture_id=? AND type='input' AND json_extract(body,'$.agentId') IS NULL`).get(manifest.captureId)!.n),
    })));
  }

  /** Build a read-only store from a share file. The same file imported twice is one store. */
  import(file: string): { store: SharedStore; added: boolean } {
    const bytes = fs.readFileSync(file);
    const shareId = hash(bytes).slice(0, 16);
    const existing = this.stores.get(shareId);
    if (existing) return { store: existing, added: false };
    const share = readShare(file);
    const ids = new Set(share.manifests.map(manifest => manifest.captureId));
    for (const id of ids) if (!safeId.test(id)) throw new Error(`${file} names a session with an unsafe ID: ${JSON.stringify(id)}.`);
    for (const { captureId, path: name } of share.files) {
      if (!ids.has(captureId) || !safeFile.test(name)) throw new Error(`${file} holds a file Wisdom will not write: ${JSON.stringify(`${captureId}/${name}`)}.`);
    }
    if (share.records.some(({ captureId, record }) => !ids.has(captureId) || record.captureId !== captureId)) throw new Error(`${file} holds records for a session it does not describe.`);

    const target = path.join(this.dir, shareId);
    const building = `${target}.importing`;
    fs.rmSync(building, { recursive: true, force: true });
    fs.mkdirSync(building, { recursive: true });
    fs.writeFileSync(path.join(building, 'share.wisdom-share'), bytes);
    const database = new LedgerDatabase(path.join(building, 'ledger.sqlite'));
    try {
      database.sql.exec('BEGIN');
      for (const manifest of share.manifests) database.saveManifest(manifest);
      for (const { record } of share.records) database.insert(record);
      database.sql.exec('COMMIT');
    } finally { database.close(); }
    for (const { captureId, path: name, encoding, content } of share.files) {
      const out = path.join(building, captureId, name);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, encoding === 'utf8' ? content : Buffer.from(content, 'base64'));
    }
    writeJson(path.join(building, 'info.json'), { shareId, sourceName: path.basename(file), importedAt: new Date().toISOString(), header: share.header } satisfies StoreInfo);
    fs.renameSync(building, target);
    const store = new SharedStore(target);
    this.stores.set(shareId, store);
    return { store, added: true };
  }

  /** Import files dropped into the shared folder once they have stopped changing. A file
   * that cannot be imported is renamed `.rejected`, and the reason goes to the daemon log.
   */
  poll(now = Date.now()): void {
    if (now - this.lastPoll < 2000 || !fs.existsSync(this.dir)) return;
    this.lastPoll = now;
    for (const entry of fs.readdirSync(this.dir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.wisdom-share')) continue;
      const file = path.join(this.dir, entry.name);
      if (now - fs.statSync(file).mtimeMs < 2000) continue;
      try { this.import(file); fs.rmSync(file); }
      catch (error) {
        console.error(`Could not import ${file}: ${error instanceof Error ? error.message : error}`);
        fs.renameSync(file, `${file}.rejected`);
      }
    }
  }

  /** Take one teammate's copy out (a newer version replaced it, or the team deleted it). True
   * once its folder is gone. It is listed in `removing.json` first, so a removal cut short (a
   * file held open for a moment, a killed daemon) is finished later, never forgotten. Copies
   * imported by hand are never passed here. */
  remove(shareId: string): boolean {
    if (!SHARE_ID.test(shareId)) return false;
    const store = this.stores.get(shareId);
    store?.database.close();
    this.stores.delete(shareId);
    this.setPending(shareId, true);
    return this.deleteFolder(shareId);
  }

  /** Copies whose removal has not finished yet. */
  get pending(): string[] {
    try { return (JSON.parse(fs.readFileSync(this.pendingFile, 'utf8')) as unknown[]).filter((id): id is string => typeof id === 'string' && SHARE_ID.test(id)); }
    catch { return []; }
  }

  /** Finish removals left half done: those listed as pending, and any folder missing its
   * `info.json` (only a cut-short removal leaves one: an import writes it before its folder gets
   * its name). Runs when the library opens, before any store is, and at each team fetch. */
  finishRemovals(): void {
    if (!fs.existsSync(this.dir)) return;
    const broken = fs.readdirSync(this.dir, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && SHARE_ID.test(entry.name) && !this.stores.has(entry.name) && !fs.existsSync(path.join(this.dir, entry.name, 'info.json')))
      .map(entry => entry.name);
    for (const id of new Set([...this.pending, ...broken])) {
      if (this.stores.has(id)) { this.stores.get(id)!.database.close(); this.stores.delete(id); }
      this.setPending(id, true);
      this.deleteFolder(id);
    }
  }

  private get pendingFile(): string { return path.join(this.dir, 'removing.json'); }

  private setPending(shareId: string, on: boolean): void {
    const now = this.pending.filter(id => id !== shareId);
    if (on) now.push(shareId);
    if (!now.length) { fs.rmSync(this.pendingFile, { force: true }); return; }
    fs.mkdirSync(this.dir, { recursive: true });
    writeJson(this.pendingFile, now);
  }

  /** Delete a copy's folder. Windows refuses to delete a file another program holds open, even
   * for a moment (a virus scanner reading a file just written), so it retries for a few seconds. */
  private deleteFolder(shareId: string): boolean {
    const folder = path.join(this.dir, shareId);
    try { fs.rmSync(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
    catch (error) { console.error(`Could not remove ${folder} yet: ${error instanceof Error ? error.message : error}. Wisdom tries again at the next team fetch and when it starts.`); }
    const gone = !fs.existsSync(folder);
    if (gone) this.setPending(shareId, false);
    return gone;
  }

  close(): void { for (const store of this.all) store.database.close(); }
}

/** Does this store hold the session a reference names? */
function holds(store: SessionStore, ref: string): boolean {
  return store.database.manifests().some(manifest => names(manifest.captureId, ref));
}

/** A ledger read goes to whichever store holds the session: this project's own first, then
 * shared copies. `latest` and the plain session list belong to this project.
 */
export function readLedger(captures: Captures, library: SharedLibrary, input: unknown): string {
  const ref = (input as { capture?: unknown })?.capture;
  const store = typeof ref === 'string' && ref !== 'latest' && !holds(captures, ref) ? library.owner(ref) : undefined;
  // A commit's steps can be in this project's sessions or in teammates' fetched copies.
  const stores = (id: string) => captures.database.manifests().some(m => m.captureId === id) ? captures
    : library.all.find(shared => shared.ids.includes(id));
  return store ? ledger(store, input) : ledger(captures, input, library.sessions(), stores);
}

/** A dashboard read, routed the same way. Exports stay with this project's own sessions. */
export function readView(captures: Captures, library: SharedLibrary, request: ViewRequest): unknown {
  if (request.view === 'shared') return { sessions: library.all.flatMap(sharedSessions) };
  const ref = 'captureId' in request ? request.captureId : request.view === 'transcript' || request.view === 'markdown' ? request.capture : undefined;
  const store = ref && !holds(captures, ref) ? library.owner(ref) : undefined;
  return view(store ?? captures, request);
}

/** A shared store's sessions as the dashboard lists them, each marked as shared. */
function sharedSessions(store: SharedStore) {
  const roots = [...new Set(store.database.manifests().map(manifest => manifest.workspaceRoot))];
  return roots.flatMap(workspaceRoot => (stats(store, { workspaceRoot }) as { sessions: object[] }).sessions);
}
