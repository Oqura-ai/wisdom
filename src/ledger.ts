import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { LedgerRecord, Manifest } from './schema.js';
import { preview } from './schema.js';
import { LedgerDatabase } from './database.js';

export const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');

export function writeJson(file: string, value: unknown): void {
  fs.writeFileSync(file + '.tmp', JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(file + '.tmp', file);
}

/** One capture's native mirror and payload files, backed by the shared database. */
export class Ledger {
  readonly recoveryGaps: string[] = [];
  private sourceOffset = 0;
  private sourceStopped = false;
  private gaps = new Set<string>();

  constructor(readonly dir: string, public manifest: Manifest, readonly database: LedgerDatabase, create = false) {
    if (create) {
      fs.mkdirSync(path.join(dir, 'payloads'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'pi-session.jsonl'), '', { flag: 'wx' });
      this.saveManifest();
    }
    this.recoveryGaps.splice(0, this.recoveryGaps.length, ...this.database.recovery(manifest.captureId));
    const row = this.database.sql.prepare(`SELECT coalesce(max(
      coalesce(json_extract(body,'$.sourceOffset'),0) + coalesce(json_extract(body,'$.sourceLength'),0)),0) AS n
      FROM records WHERE capture_id=?`).get(manifest.captureId)!;
    this.sourceOffset = Number(row.n);
    const mirror = path.join(dir, 'pi-session.jsonl');
    if (fs.existsSync(mirror) && fs.statSync(mirror).size !== this.sourceOffset) {
      this.recoveryGaps.push('Native mirror byte count differs from indexed references; further mirroring stopped.');
      this.sourceStopped = true;
    }
  }

  saveManifest(): void { this.database.saveManifest(this.manifest); }

  listRecords(): LedgerRecord[] {
    return this.database.records('capture_id=?', [this.manifest.captureId], 'ORDER BY seq');
  }

  findToolStart(toolCallId: string): LedgerRecord | undefined {
    return this.database.records("capture_id=? AND tool_call_id=? AND type='tool_started'",
      [this.manifest.captureId, toolCallId], 'ORDER BY seq LIMIT 1')[0];
  }

  hasObservation(id: string): boolean {
    return !!this.database.sql.prepare('SELECT 1 FROM records WHERE capture_id=? AND observation_id=?')
      .get(this.manifest.captureId, id);
  }

  get lastSeq(): number { return this.database.lastSeq(this.manifest.captureId); }

  append(fields: Omit<LedgerRecord, 'schemaVersion' | 'captureId' | 'id' | 'seq' | 'observedAt'>): LedgerRecord {
    const record: LedgerRecord = { ...fields, schemaVersion: 1, captureId: this.manifest.captureId,
      id: randomUUID(), seq: this.lastSeq + 1, observedAt: new Date().toISOString() };
    this.database.append(record);
    return record;
  }

  gap(kind: string, detail: string): void {
    const key = `${kind}:${detail}`;
    if (this.gaps.has(key)) return;
    this.gaps.add(key);
    this.append({ type: 'gap', summary: key });
  }

  payload(value: unknown): string {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    const name = hash(text);
    const file = path.join(this.dir, 'payloads', name);
    if (!fs.existsSync(file)) fs.writeFileSync(file, text);
    return name;
  }

  readPayload(ref: string): string {
    if (!/^[a-f0-9]{64}$/.test(ref)) throw new Error('Invalid payload reference');
    return fs.readFileSync(path.join(this.dir, 'payloads', ref), 'utf8');
  }

  readSource(record: LedgerRecord): string {
    if (record.sourceOffset === undefined || record.sourceLength === undefined) return '';
    const fd = fs.openSync(path.join(this.dir, 'pi-session.jsonl'), 'r');
    try {
      const bytes = Buffer.alloc(record.sourceLength);
      fs.readSync(fd, bytes, 0, bytes.length, record.sourceOffset);
      return bytes.toString('utf8');
    } finally { fs.closeSync(fd); }
  }

  /** Preserve native bytes. No line parser that treats Unicode separators as newlines. */
  syncSource(): void {
    const source = this.manifest.source;
    if (!source || !fs.existsSync(source) || this.sourceStopped) return;
    const size = fs.statSync(source).size;
    if (size < this.sourceOffset) {
      this.sourceStopped = true;
      this.gap('source-rewritten', 'Native source became smaller; further mirroring stopped.'); return;
    }
    if (size === this.sourceOffset) return;
    const fd = fs.openSync(source, 'r');
    try {
      // Bound each poll; subsequent polls drain a large backlog. A native line
      // larger than this bound is an explicit gap, not silent truncation.
      const bytes = Buffer.alloc(Math.min(size - this.sourceOffset, 32 * 1024 * 1024));
      const count = fs.readSync(fd, bytes, 0, bytes.length, this.sourceOffset);
      let start = 0;
      for (let end = bytes.subarray(0, count).indexOf(10); end >= 0;
        end = bytes.subarray(0, count).indexOf(10, start)) {
        const line = bytes.subarray(start, end + 1);
        fs.appendFileSync(path.join(this.dir, 'pi-session.jsonl'), line);
        this.recordSourceLine(line, this.sourceOffset + start);
        start = end + 1;
      }
      this.sourceOffset += start;
      if (!start && count === 32 * 1024 * 1024) this.gap('source-line-oversize', 'Native record exceeds 32 MiB.');
    } finally { fs.closeSync(fd); }
  }

  private recordSourceLine(line: Buffer, offset: number): void {
    try {
      const entry = JSON.parse(line.toString('utf8'));
      const message = entry.message;
      const content = message?.content;
      const text = typeof content === 'string' ? content : Array.isArray(content)
        ? content.filter((block: any) => block.type === 'text').map((block: any) => block.text).join(' ') : entry.type;
      this.append({ type: 'source_record', summary: preview(text), role: message?.role,
        toolCallId: message?.toolCallId, toolName: message?.toolName,
        sourceEntryId: entry.id, sourceParentId: entry.parentId, sourceTimestamp: entry.timestamp, isError: message?.isError,
        sourceOffset: offset, sourceLength: line.length });
      // Assistant messages can contain several tool calls. Explicit IDs connect
      // them to results; adjacency and parentId are not call/result correlation.
      if (Array.isArray(content)) for (const block of content) {
        if (block.type === 'toolCall' && block.id) this.append({ type: 'source_tool_call',
          toolCallId: block.id, toolName: block.name, sourceEntryId: entry.id,
          summary: `${block.name}: ${preview(block.arguments)}`, sourceOffset: offset, sourceLength: line.length });
      }
    } catch (error) {
      if (error instanceof SyntaxError) this.gap('malformed-native-record', `byte ${offset}`);
      else throw error;
    }
  }
}
