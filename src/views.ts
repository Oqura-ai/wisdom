import type { Captures } from './captures.js';
import type { LedgerRecord, ViewRequest } from './schema.js';
import { EvidenceReader, evidenceVersion } from './evidence.js';
import { conversation } from './conversation.js';
import { stats } from './stats.js';

/** The dashboard's reads. It draws whole sessions, so it receives records as stored;
 * agents read through the ledger in discovery.ts instead.
 */
export function view(captures: Captures, request: ViewRequest): unknown {
  switch (request.view) {
    case 'projects': return stats(captures, {});
    case 'project': return stats(captures, { workspaceRoot: request.workspaceRoot });
    case 'capture': return captureRecords(captures, request.captureId);
    case 'turn': return conversation(captures, { captureId: request.captureId, requestId: request.requestId, readVersion: request.readVersion, maxChars: 6000 });
    case 'record': return recordBodies(captures, request.captureId, request.id, request.readVersion);
    case 'native-result': return nativeResult(captures, request.captureId, request.toolCallId, request.readVersion);
  }
}

const structureTypes = ['input', 'tool_started', 'tool_finished', 'file_change', 'gap', 'subagent_started', 'subagent_stopped',
  'session_compact', 'capture_started', 'capture_closed'];

/** One capture at one version: its structure, the assistant's replies with text, and token usage. */
function captureRecords(captures: Captures, captureId: string) {
  const readVersion = captures.database.revision;
  const db = captures.database;
  const structure = db.records(`capture_id=? AND revision<=? AND type IN (${structureTypes.map(() => '?').join(',')})`, [captureId, readVersion, ...structureTypes]);
  const replies = db.records(`capture_id=? AND revision<=? AND type IN ('message','source_record') AND role='assistant'`, [captureId, readVersion])
    .filter(r => r.summary);
  const usage = db.records(`capture_id=? AND revision<=? AND type='usage'`, [captureId, readVersion]);
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
function recordBodies(captures: Captures, captureId: string, id: string, requested: number) {
  const readVersion = evidenceVersion(captures, requested);
  const record = captures.database.records('capture_id=? AND id=? AND revision<=?', [captureId, id, readVersion])[0];
  if (!record) throw new Error('Record not found at this version');
  const reader = new EvidenceReader(captures);
  return { type: record.type, content: body(reader, record, 'content'), data: body(reader, record, 'data'), patch: body(reader, record, 'patch') };
}

/** A result only the harness transcript holds: the native line with this call's result. */
function nativeResult(captures: Captures, captureId: string, toolCallId: string, requested: number) {
  const readVersion = evidenceVersion(captures, requested);
  const record = captures.database.records(`capture_id=? AND revision<=? AND type='source_record' AND role='toolResult' AND tool_call_id=?`,
    [captureId, readVersion, toolCallId], 'ORDER BY revision LIMIT 1')[0];
  return { content: record ? body(new EvidenceReader(captures), record, 'content') : undefined };
}
