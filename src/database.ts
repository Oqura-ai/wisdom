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
    this.sql.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;');
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
    return this.sql.prepare('SELECT manifest FROM captures').all().map(row => JSON.parse(String(row.manifest)));
  }

  saveManifest(manifest: Manifest): void {
    this.sql.prepare(`INSERT INTO captures(id, session_id, workspace_root, manifest) VALUES(?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET manifest=excluded.manifest`).run(
      manifest.captureId, manifest.piSessionId, workspaceKey(manifest.workspaceRoot), JSON.stringify(manifest));
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
    if (!record.requestId && record.type.startsWith('source_')) {
      const input = this.sql.prepare("SELECT id FROM records WHERE capture_id=? AND type='input' ORDER BY seq DESC LIMIT 1").get(record.captureId);
      if (input) { record.requestId = String(input.id); record.linkBasis = 'observed-input-window'; }
    }
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

  get revision(): number { return Number(this.sql.prepare('SELECT coalesce(max(revision),0) AS n FROM records').get()!.n); }
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
