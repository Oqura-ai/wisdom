import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import type { LedgerRecord, Manifest } from './schema.js';

/** SQLite owns metadata. Large evidence stays in content-addressed payload files.
 * There is one writer (the daemon), and every append is committed before ACK.
 * JSON preserves optional evidence fields; indexed columns serve relationships.
 */
export class LedgerDatabase {
  readonly sql: DatabaseSync;

  constructor(readonly file: string) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.sql = new DatabaseSync(file);
    // secure_delete: a deleted session's rows are overwritten with zeros, not left in free pages.
    this.sql.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON;');
    const version = Number(this.sql.prepare('PRAGMA user_version').get()!.user_version);
    if (version > 1) { this.sql.close(); throw new Error(`Unsupported database version ${version}`); }
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS captures (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL, workspace_root TEXT NOT NULL,
        manifest TEXT NOT NULL, recovery_gaps TEXT NOT NULL DEFAULT '[]'
      );
      CREATE INDEX IF NOT EXISTS captures_workspace ON captures(workspace_root, session_id);
      CREATE TABLE IF NOT EXISTS records (
        revision INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE, capture_id TEXT NOT NULL REFERENCES captures(id),
        seq INTEGER NOT NULL, type TEXT NOT NULL, parent_id TEXT, request_id TEXT,
        tool_call_id TEXT, tool_name TEXT, source_entry_id TEXT, path TEXT,
        role TEXT, is_error INTEGER, observation_id TEXT, body TEXT NOT NULL,
        UNIQUE(capture_id, seq), UNIQUE(capture_id, observation_id)
      );
      CREATE INDEX IF NOT EXISTS records_type ON records(capture_id, type, seq);
      CREATE INDEX IF NOT EXISTS records_tool ON records(capture_id, tool_call_id, seq);
      CREATE INDEX IF NOT EXISTS records_request ON records(capture_id, request_id, seq);
      CREATE INDEX IF NOT EXISTS records_parent ON records(capture_id, parent_id, seq);
      CREATE INDEX IF NOT EXISTS records_source ON records(capture_id, source_entry_id, seq);
      CREATE INDEX IF NOT EXISTS records_path ON records(path, capture_id, seq);
      PRAGMA user_version=1;
    `);
  }

  manifests(): Manifest[] {
    return this.sql.prepare('SELECT manifest FROM captures').all().map(row => {
      return JSON.parse(String(row.manifest)) as Manifest;
    });
  }

  saveManifest(manifest: Manifest): void {
    this.sql.prepare(`INSERT INTO captures(id, session_id, workspace_root, manifest) VALUES(?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET manifest=excluded.manifest, session_id=excluded.session_id, workspace_root=excluded.workspace_root`).run(
      manifest.captureId, manifest.sessionId, workspaceKey(manifest.workspaceRoot), JSON.stringify(manifest));
  }

  recovery(id: string): string[] {
    return JSON.parse(String(this.sql.prepare('SELECT recovery_gaps FROM captures WHERE id=?').get(id)?.recovery_gaps ?? '[]'));
  }

  append(record: LedgerRecord): void {
    // Hook parentage is stronger than temporal association. Preserve that difference.
    if (!record.requestId && record.parentId) {
      const parent = this.records('id=? AND capture_id=?', [record.parentId, record.captureId])[0];
      record.requestId = parent?.type === 'input' ? parent.id : parent?.requestId;
      if (record.requestId) record.linkBasis = 'recorded-parent';
    }
    // Transcript evidence and the usage it reports belong to the input window they arrived in.
    if (record.requestId && record.type === 'usage' && !record.linkBasis) record.linkBasis = 'observed-input-window';
    if (!record.requestId && (record.type.startsWith('source_') || record.type === 'usage')) {
      const input = record.turnId
        ? this.sql.prepare("SELECT id FROM records WHERE capture_id=? AND type='input' AND json_extract(body,'$.turnId')=? AND json_extract(body,'$.agentId') IS ? ORDER BY seq DESC LIMIT 1")
          .get(record.captureId, record.turnId, record.agentId ?? null)
        : this.sql.prepare("SELECT id FROM records WHERE capture_id=? AND type='input' ORDER BY seq DESC LIMIT 1").get(record.captureId);
      if (input) { record.requestId = String(input.id); record.linkBasis = record.turnId ? 'recorded-turn' : 'observed-input-window'; }
    }
    this.insert(record);
  }

  /** A record exactly as another database stored it (a shared copy): links already made there are kept. */
  insert(record: LedgerRecord): void {
    this.sql.prepare(`INSERT INTO records(id,capture_id,seq,type,parent_id,request_id,tool_call_id,
      tool_name,source_entry_id,path,role,is_error,observation_id,body) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      record.id, record.captureId, record.seq, record.type, record.parentId ?? null, record.requestId ?? null,
      record.toolCallId ?? null, record.toolName ?? null, record.sourceEntryId ?? null, record.path ?? null,
      record.role ?? null, record.isError === undefined ? null : Number(record.isError), record.observationId ?? null,
      JSON.stringify(record));
  }

  /** The SQL fragment is internal code only. User values always use bindings. */
  records(where: string, bindings: SQLInputValue[] = [], suffix = 'ORDER BY revision'): LedgerRecord[] {
    return this.sql.prepare(`SELECT body FROM records WHERE ${where} ${suffix}`).all(...bindings)
      .map(row => JSON.parse(String(row.body)) as LedgerRecord);
  }

  /** The newest revision ever written. Read from SQLite's own counter, not the rows, so deleting
   * the newest session never moves the version back and a version once given stays readable. */
  get revision(): number {
    return Number(this.sql.prepare(`SELECT max(coalesce((SELECT seq FROM sqlite_sequence WHERE name='records'),0),
      coalesce((SELECT max(revision) FROM records),0)) AS n`).get()!.n);
  }

  /** A person deleted this session: its rows go, and the words Wisdom wrote about it in other
   * sessions (their links to it, gaps naming it) no longer name it. Their recorded evidence
   * (prompts, tool output, native lines) is theirs and is never edited. One transaction, then
   * the write-ahead log is emptied so no copy of the rows stays beside the database.
   */
  forget(captureId: string): void {
    this.sql.exec('BEGIN IMMEDIATE');
    try {
      this.sql.prepare('DELETE FROM records WHERE capture_id=?').run(captureId);
      this.sql.prepare('DELETE FROM captures WHERE id=?').run(captureId);
      const update = this.sql.prepare('UPDATE records SET body=? WHERE id=?');
      for (const record of this.records("type='session_link' AND json_extract(body,'$.link.from')=?", [captureId])) {
        const { from: _from, fromHarness: _harness, ...link } = record.link!;
        const turns = link.turns === undefined ? '' : ` · ${link.turns} turn${link.turns === 1 ? '' : 's'}`;
        const summary = link.kind === 'cloned' ? `cloned from a deleted session${turns}`
          : `${link.kind === 'continues' ? 'continues' : 'continued after'} a deleted session`;
        update.run(JSON.stringify({ ...record, link: { ...link, fromDeleted: true }, summary }), record.id);
      }
      for (const record of this.records("type='gap' AND instr(body, ?) > 0", [captureId])) {
        update.run(JSON.stringify({ ...record, summary: record.summary?.replaceAll(captureId, 'a deleted session') }), record.id);
      }
      this.sql.exec('COMMIT');
    } catch (error) { this.sql.exec('ROLLBACK'); throw error; }
    this.sql.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  }
  lastSeq(id: string): number {
    return Number(this.sql.prepare('SELECT coalesce(max(seq),0) AS n FROM records WHERE capture_id=?').get(id)!.n);
  }
  close(): void { this.sql.close(); }
}

/** Windows path casing must not split one workspace into separate query scopes. */
export function workspaceKey(root: string): string {
  const resolved = path.resolve(root);
  const canonical = fs.existsSync(resolved) ? fs.realpathSync(resolved) : resolved;
  return process.platform === 'win32' ? canonical.toLowerCase() : canonical;
}
