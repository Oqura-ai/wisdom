import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { LedgerRecord, Manifest } from './schema.js';
import { preview } from './schema.js';
import { LedgerDatabase } from './database.js';
import { adapter } from './harnesses/index.js';
import type { NativeEntry } from './harnesses/types.js';

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
  private sourceTurnId?: string;
  private sourceModel?: string;
  private gaps = new Set<string>();

  constructor(readonly dir: string, public manifest: Manifest, readonly database: LedgerDatabase, create = false) {
    if (create) {
      fs.mkdirSync(path.join(dir, 'payloads'), { recursive: true });
      fs.writeFileSync(this.mirror, '', { flag: 'wx' });
      this.saveManifest();
    }
    this.recoveryGaps.splice(0, this.recoveryGaps.length, ...this.database.recovery(manifest.captureId));
    const row = this.database.sql.prepare(`SELECT coalesce(max(
      coalesce(json_extract(body,'$.sourceOffset'),0) + coalesce(json_extract(body,'$.sourceLength'),0)),0) AS n
      FROM records WHERE capture_id=?`).get(manifest.captureId)!;
    this.sourceOffset = Number(row.n);
    const mirror = this.mirror;
    if (fs.existsSync(mirror) && fs.statSync(mirror).size !== this.sourceOffset) {
      this.recoveryGaps.push('Native mirror byte count differs from indexed references; further mirroring stopped.');
      this.sourceStopped = true;
    }
  }

  /** Byte copy of the harness's native transcript. Pre-harness captures used Pi's name. */
  get mirror(): string { return path.join(this.dir, this.manifest.harness ? 'native-session.jsonl' : 'pi-session.jsonl'); }

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
    const fd = fs.openSync(this.mirror, 'r');
    try {
      const bytes = Buffer.alloc(record.sourceLength);
      fs.readSync(fd, bytes, 0, bytes.length, record.sourceOffset);
      return bytes.toString('utf8');
    } finally { fs.closeSync(fd); }
  }

  /** Preserve native bytes. No line parser that treats Unicode separators as newlines. */
  /** Mirror new native lines. `stopBefore` leaves the first matching line (and all
   * after it) for a later sync, so it is linked to evidence recorded in between.
   */
  syncSource(stopBefore?: (entry: NativeEntry) => boolean): void {
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
        if (stopBefore) {
          let entry: NativeEntry | undefined;
          try { entry = adapter(this.manifest.harness).nativeEntry(JSON.parse(line.toString('utf8'))); } catch { /* recorded as a gap below */ }
          if (entry && stopBefore(entry)) break;
        }
        fs.appendFileSync(this.mirror, line);
        this.recordSourceLine(line, this.sourceOffset + start);
        start = end + 1;
      }
      this.sourceOffset += start;
      if (!start && count === 32 * 1024 * 1024) this.gap('source-line-oversize', 'Native record exceeds 32 MiB.');
    } finally { fs.closeSync(fd); }
  }

  /** One usage record per model response the transcript reports. Counted once per key
   * in stats; lines from before this capture (resumed history) are marked, not dropped.
   */
  recordUsage(entry: NativeEntry, context: { sourceModel?: string; agentId?: string; requestId?: string; sourceEntryId?: string; turnId?: string;
    sourceTimestamp?: string; sourceOffset?: number; sourceLength?: number }): void {
    const { sourceModel, ...source } = context;
    for (const usage of entry.usage ?? []) {
      const model = usage.model ?? sourceModel;
      const tokens = usage.input + usage.cacheRead + usage.cacheWrite + usage.output;
      this.append({ type: 'usage', ...source, usageKey: usage.key, usageScope: usage.scope, model, provider: usage.provider,
        beforeCapture: entry.timestamp && entry.timestamp < this.manifest.startedAt ? true : undefined,
        usage: { input: usage.input, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite, output: usage.output,
          reasoning: usage.reasoning, costUsd: usage.costUsd },
        summary: usage.scope === 'session-total' ? `usage: session cost $${usage.costUsd?.toFixed(4)}`
          : `usage: ${model ?? 'model'} ${tokens} tokens (${usage.output} out)` });
    }
  }

  /** Index usage from an existing mirror (captures recorded before usage indexing).
   * Reads the byte-preserved copies only; the manifest's usageIndexed flag prevents repeats.
   */
  backfillUsage(): void {
    if (this.manifest.usageIndexed) return;
    const harness = adapter(this.manifest.harness);
    // Link each response to the request its transcript line was linked to when it was
    // mirrored live; "latest input" would be wrong now that every input exists.
    const requestAt = new Map(this.database.sql.prepare(`SELECT json_extract(body,'$.sourceOffset') AS offset, request_id AS requestId
      FROM records WHERE capture_id=? AND type='source_record' AND request_id IS NOT NULL`).all(this.manifest.captureId)
      .map(row => [Number(row.offset), String(row.requestId)]));
    const agentRequest = new Map(this.database.sql.prepare(`SELECT json_extract(body,'$.agentId') AS agentId, request_id AS requestId
      FROM records WHERE capture_id=? AND type='subagent_stopped' AND request_id IS NOT NULL`).all(this.manifest.captureId)
      .map(row => [String(row.agentId), String(row.requestId)]));
    let model: string | undefined;
    if (fs.existsSync(this.mirror)) {
      const bytes = fs.readFileSync(this.mirror);
      let start = 0;
      for (let end = bytes.indexOf(10); end >= 0; end = bytes.indexOf(10, start)) {
        const line = bytes.subarray(start, end + 1);
        try {
          const entry = harness.nativeEntry(JSON.parse(line.toString('utf8')));
          if (entry.model) model = entry.model;
          this.recordUsage(entry, { sourceModel: model, requestId: requestAt.get(start), sourceEntryId: entry.id,
            sourceTimestamp: entry.timestamp, sourceOffset: start, sourceLength: line.length });
        } catch { /* Malformed lines were already reported as gaps when mirrored. */ }
        start = end + 1;
      }
    }
    const subagents = path.join(this.dir, 'subagents');
    for (const file of fs.existsSync(subagents) ? fs.readdirSync(subagents) : []) {
      const agentId = /^agent-(.+)\.jsonl$/.exec(file)?.[1];
      if (!agentId) continue;
      let agentModel: string | undefined;
      for (const line of fs.readFileSync(path.join(subagents, file), 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          const entry = harness.nativeEntry(JSON.parse(line));
          if (entry.model) agentModel = entry.model;
          this.recordUsage(entry, { agentId, sourceModel: agentModel, requestId: agentRequest.get(agentId), sourceEntryId: entry.id, sourceTimestamp: entry.timestamp });
        } catch { /* Preserved copy; parse failures are not new evidence. */ }
      }
    }
    this.manifest.usageIndexed = true;
    this.saveManifest();
  }

  private recordSourceLine(line: Buffer, offset: number): void {
    try {
      const entry = adapter(this.manifest.harness).nativeEntry(JSON.parse(line.toString('utf8')));
      if (entry.turnId) this.sourceTurnId = entry.turnId;
      if (entry.model) this.sourceModel = entry.model;
      const source = { sourceEntryId: entry.id ?? `byte:${offset}:${hash(line)}`, sourceParentId: entry.parentId, sourceTimestamp: entry.timestamp,
        turnId: this.sourceTurnId, sourceOffset: offset, sourceLength: line.length };
      if (!entry.messages.length) this.append({ type: 'source_record', summary: preview(entry.kind), ...source });
      this.recordUsage(entry, { ...source, sourceModel: this.sourceModel });
      // One native line can hold several messages, such as parallel tool results.
      for (const message of entry.messages) {
        const content = message.content;
        const text = typeof content === 'string' ? content : Array.isArray(content)
          ? content.filter((block: any) => block?.type === 'text').map((block: any) => block.text).join(' ') : entry.kind;
        this.append({ type: 'source_record', summary: preview(text), role: message.role,
          toolCallId: message.toolCallId, toolName: message.toolName, isError: message.isError, ...source });
        // Assistant messages can contain several tool calls. Explicit IDs connect
        // them to results; adjacency and parentId are not call/result correlation.
        if (Array.isArray(content)) for (const block of content as any[]) {
          if (block?.type === 'toolCall' && block.id) this.append({ type: 'source_tool_call',
            toolCallId: block.id, toolName: block.name, ...source,
            summary: `${block.name}: ${preview(block.arguments)}` });
        }
      }
    } catch (error) {
      if (error instanceof SyntaxError) this.gap('malformed-native-record', `byte ${offset}`);
      else throw error;
    }
  }
}
