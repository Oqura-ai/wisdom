import fs from 'node:fs';
import path from 'node:path';
import type { SessionStore } from './store.js';
import { resolveCapture } from './discovery.js';
import { sessionMarkdown } from './markdown.js';
import type { LedgerRecord, ViewRequest } from './schema.js';
import { EvidenceReader, evidenceVersion } from './evidence.js';
import { conversation } from './conversation.js';
import { stats } from './stats.js';
import { estimateCost } from './prices.js';

/** The dashboard's reads. It draws whole sessions, so it receives records as stored;
 * agents read through the ledger in discovery.ts instead.
 */
export function view(captures: SessionStore, request: Exclude<ViewRequest, { view: 'shared' }>): unknown {
  switch (request.view) {
    case 'projects': return stats(captures, {});
    case 'project': return stats(captures, { workspaceRoot: request.workspaceRoot });
    case 'capture': return captureRecords(captures, request.captureId);
    case 'turn': return conversation(captures, { captureId: request.captureId, requestId: request.requestId, readVersion: request.readVersion, maxChars: 6000 });
    case 'record': return recordBodies(captures, request.captureId, request.id, request.readVersion);
    case 'native-result': return nativeResult(captures, request.captureId, request.toolCallId, request.readVersion);
    case 'export': return exportCapture(captures, request.capture);
    case 'transcript': return transcript(captures, request.capture);
    case 'markdown': return sessionMarkdown(captures, request.capture);
  }
}

/** What `wisdom clone` copies: the harness transcript up to the bytes indexed at this version,
 * how many turns that holds, and each file's last recorded content, to compare with the disk.
 */
function transcript(captures: SessionStore, ref: string) {
  const readVersion = captures.database.revision;
  const manifest = resolveCapture(captures, ref, readVersion);
  const records = captures.database.records('capture_id=? AND revision<=?', [manifest.captureId, readVersion], 'ORDER BY seq');
  const bytes = Math.max(0, ...records.map(record => (record.sourceOffset ?? 0) + (record.sourceLength ?? 0)));
  const changes = new Map<string, string | null>();
  for (const record of records) if (record.type === 'file_change' && record.path && !record.worktree) changes.set(record.path, record.afterHash ?? null);
  return { readVersion, manifest, file: bytes ? captures.get(manifest.captureId).mirror : undefined, bytes,
    turns: records.filter(record => record.type === 'input' && !record.agentId).length,
    changes: [...changes].map(([file, afterHash]) => ({ path: file, afterHash })), sharedFrom: captures.shared?.project };
}

/** Everything a share file holds for one session, pinned to one version: the manifest, every
 * record as stored, and the evidence files those records reference. Files are named here and
 * read by the caller; the transcript copy is read only up to `nativeBytes`, the part indexed
 * at this version.
 */
function exportCapture(captures: SessionStore, ref: string) {
  const readVersion = captures.database.revision;
  const manifest = resolveCapture(captures, ref, readVersion);
  const { dir } = captures.get(manifest.captureId);
  const records = captures.database.records('capture_id=? AND revision<=?', [manifest.captureId, readVersion], 'ORDER BY seq');
  const payloads = [...new Set(records.flatMap(record => [record.dataRef, record.patchRef]).filter((ref): ref is string => !!ref))]
    .map(ref => `payloads/${ref}`);
  const subagents = fs.existsSync(path.join(dir, 'subagents')) ? fs.readdirSync(path.join(dir, 'subagents')).map(name => `subagents/${name}`) : [];
  const nativeBytes = Math.max(0, ...records.map(record => (record.sourceOffset ?? 0) + (record.sourceLength ?? 0)));
  const files = [...payloads, ...(nativeBytes ? ['native-session.jsonl'] : []), ...subagents].filter(file => fs.existsSync(path.join(dir, file)));
  return { readVersion, manifest, records, dir, files, nativeBytes };
}

const structureTypes = ['input', 'tool_started', 'tool_finished', 'file_change', 'gap', 'subagent_started', 'subagent_stopped',
  'session_compact', 'capture_started', 'capture_closed'];

/** One capture at one version: its structure, the assistant's replies with text, and token usage. */
function captureRecords(captures: SessionStore, captureId: string) {
  const readVersion = captures.database.revision;
  const db = captures.database;
  const structure = db.records(`capture_id=? AND revision<=? AND type IN (${structureTypes.map(() => '?').join(',')})`, [captureId, readVersion, ...structureTypes]);
  const replies = db.records(`capture_id=? AND revision<=? AND type IN ('message','source_record') AND role='assistant'`, [captureId, readVersion])
    .filter(r => r.summary);
  // A call with no reported cost (Codex) carries an estimate beside the record, never inside it.
  const usage = db.records(`capture_id=? AND revision<=? AND type='usage'`, [captureId, readVersion]).map(record =>
    record.usage && typeof record.usage.costUsd !== 'number' ? { ...record, estimatedCostUsd: estimateCost(record.model, record.usage) } : record);
  return { readVersion, events: [...structure, ...replies].sort((a, b) => a.seq - b.seq), usage };
}

const LIMIT = 16000;

function body(reader: EvidenceReader, record: LedgerRecord, section: 'content' | 'data' | 'patch') {
  try {
    const text = reader.read(record, section);
    if (text === undefined) return { available: false, reason: section === 'patch' ? record.patchUnavailable ?? 'No patch recorded' : 'No body recorded' };
    return { available: true, text: text.slice(0, LIMIT), totalChars: text.length, truncated: text.length > LIMIT };
  } catch (error) { return { available: false, reason: String(error) }; }
}

/** One record's evidence bodies: request or reply text, tool input or result, or patch. */
function recordBodies(captures: SessionStore, captureId: string, id: string, requested: number) {
  const readVersion = evidenceVersion(captures, requested);
  const record = captures.database.records('capture_id=? AND id=? AND revision<=?', [captureId, id, readVersion])[0];
  if (!record) throw new Error('Record not found at this version');
  const reader = new EvidenceReader(captures);
  return { type: record.type, content: body(reader, record, 'content'), data: body(reader, record, 'data'), patch: body(reader, record, 'patch') };
}

/** A result only the harness transcript holds: the native line with this call's result. */
function nativeResult(captures: SessionStore, captureId: string, toolCallId: string, requested: number) {
  const readVersion = evidenceVersion(captures, requested);
  const record = captures.database.records(`capture_id=? AND revision<=? AND type='source_record' AND role='toolResult' AND tool_call_id=?`,
    [captureId, readVersion, toolCallId], 'ORDER BY revision LIMIT 1')[0];
  return { content: record ? body(new EvidenceReader(captures), record, 'content') : undefined };
}
