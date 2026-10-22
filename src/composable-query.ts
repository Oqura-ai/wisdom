import { selectionSchema, type LedgerRecord, type Query } from './schema.js';
import type { Captures } from './captures.js';
import { hash } from './ledger.js';
import { fields, presets, relations } from './vocabulary.js';
import { selection, type Resource } from './selection.js';
import { decodeCursor, encodeCursor } from './cursor.js';
import { EvidenceReader, evidenceVersion } from './evidence.js';

interface Expansion { select?: string[]; where?: Record<string, unknown>; include?: Record<string, Expansion>; limit?: number }
const defaults = ['seq', 'observedAt', 'type', 'summary', 'path', 'toolCallId', 'toolName', 'isError', 'attribution', 'linkBasis', 'status'];

function validateProjection(spec: Expansion, depth = 0): void {
  if (depth > 3) throw new Error('Include depth exceeds 3');
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) throw new Error('Include must be an object');
  for (const key of Object.keys(spec)) if (!['select', 'where', 'include', 'limit'].includes(key)) throw new Error(`Unknown include option: ${key}`);
  if (spec.select !== undefined && (!Array.isArray(spec.select) || spec.select.length > 30 || spec.select.some(f => !fields.includes(f as any)))) {
    throw new Error('Unknown select field; use op=describe for the vocabulary');
  }
  if (spec.limit !== undefined && (!Number.isInteger(spec.limit) || spec.limit < 1 || spec.limit > 50)) throw new Error('Include limit must be 1–50');
  if (spec.where !== undefined && (!spec.where || typeof spec.where !== 'object' || Array.isArray(spec.where))) throw new Error('where must be an object');
  if (spec.include !== undefined && (!spec.include || typeof spec.include !== 'object' || Array.isArray(spec.include))) throw new Error('include must be an object');
  for (const [name, nested] of Object.entries(spec.include ?? {})) {
    if (!relations.includes(name as any)) throw new Error(`Unknown relation: ${name}`);
    validateProjection(nested, depth + 1);
  }
}

/** Presets are ordinary queries. Explicit projections replace preset projections;
 * filters combine, with explicit values overriding the same preset field.
 */
export function expandPreset(request: Query): Query {
  if (!request.preset) return request;
  const preset = presets[request.preset];
  const expanded = selectionSchema.parse({ ...preset, ...request, find: request.find ?? preset.find,
    where: { ...('where' in preset ? preset.where : {}), ...request.where },
    select: request.select ?? ('select' in preset ? preset.select : undefined),
    include: request.include ?? ('include' in preset ? preset.include : undefined) });
  if (request.preset === 'file-history' && !expanded.where?.path) throw new Error('file-history requires where.path (CLI: --path)');
  return expanded;
}

function signature(request: Query): string {
  return hash(JSON.stringify({ ...request, cursor: undefined, readVersion: undefined }));
}

export function selectPage(captures: Captures, request: Query, version: number, extraCondition = '1=1') {
  let after = 0;
  if (request.cursor) {
    const cursor = decodeCursor(request.cursor);
    if (cursor.signature !== signature(request) || cursor.readVersion !== version || typeof cursor.after !== 'number' || !Number.isSafeInteger(cursor.after) || cursor.after < 0) {
      throw new Error('Cursor does not match this query or readVersion');
    }
    after = cursor.after;
  }
  const { from, bindings } = selection(request, version, after);
  const rows = captures.database.sql.prepare(`SELECT r.body,r.revision ${from} AND (${extraCondition}) ORDER BY r.revision LIMIT ?`)
    .all(...bindings, request.limit + 1);
  const visible = rows.slice(0, request.limit);
  const nextCursor = rows.length > request.limit ? encodeCursor({ signature: signature(request),
    readVersion: version, after: Number(visible.at(-1)!.revision) }) : null;
  return { records: visible.map(row => JSON.parse(String(row.body)) as LedgerRecord), nextCursor };
}

/** Relations return normal queries, also used as continuations. No hidden RPC ID
 * lookup dance: the caller can filter leaves and include ancestors in one call.
 */
function relationQuery(record: LedgerRecord, relation: string, spec: Expansion, version: number): Query {
  let find: Resource = 'events';
  let where: Record<string, unknown>;
  const requestId = record.type === 'input' ? record.id : record.requestId;
  switch (relation) {
    case 'request': find = 'requests'; where = { id: requestId ?? '__unlinked__' }; break;
    case 'parent': where = { id: record.parentId ?? '__unlinked__' }; break;
    case 'children': where = { parentId: record.id }; break;
    case 'source': where = record.toolCallId ? { toolCallId: record.toolCallId, type: { in: ['source_record', 'source_tool_call'] } }
      : { id: record.type.startsWith('source_') ? record.id : '__unlinked__' }; break;
    default:
      find = relation as Resource;
      where = record.type === 'input' ? { requestId: record.id }
        : record.toolCallId && relation !== 'messages' ? { toolCallId: record.toolCallId }
        : { requestId: requestId ?? '__unlinked__' };
  }
  // Relation keys cannot be overwritten to escape their parent association.
  for (const key of Object.keys(spec.where ?? {})) if (key in where) throw new Error(`Include filter cannot override relation key ${key}`);
  return selectionSchema.parse({ find, captureId: record.captureId, readVersion: version,
    where: { ...spec.where, ...where }, select: spec.select, include: spec.include, limit: spec.limit ?? 10 });
}

export function composableQuery(captures: Captures, original: Query): unknown {
  const request = expandPreset(original);
  const projection: Expansion = { select: request.select, include: request.include as Expansion['include'] };
  validateProjection(projection);
  let version = request.readVersion ?? captures.database.revision;
  if (request.cursor && request.readVersion === undefined) {
    version = decodeCursor(request.cursor).readVersion as number;
  }
  evidenceVersion(captures, version);
  // Validate the entire tree even when the root query returns zero rows.
  function validateFilters(spec: Expansion): void {
    selection(selectionSchema.parse({ find: 'events', captureId: '_validation_', where: spec.where }), version, 0);
    for (const nested of Object.values(spec.include ?? {})) validateFilters(nested);
  }
  validateFilters(projection);
  let budget = request.maxChars;
  let nodes = 0;
  const issues: { id: string; section: string; reason: string }[] = [];
  const reader = new EvidenceReader(captures);

  function evidence(record: LedgerRecord, field: 'data' | 'content' | 'patch'): unknown {
    let text: string;
    try {
      const body = reader.read(record, field);
      if (body === undefined) return { available: false, reason: field === 'patch' ? record.patchUnavailable ?? 'No patch recorded' : 'No body recorded' };
      text = body;
    } catch (error) {
      const reason = String(error); issues.push({ id: record.id, section: field, reason });
      return { available: false, reason };
    }
    const excerpt = text.slice(0, budget); budget -= excerpt.length;
    const truncated = excerpt.length < text.length;
    // Continuations read the original section; surface content may be extracted
    // from a larger JSON source, so its offsets must not be applied to raw data.
    return { available: true, text: excerpt, totalChars: text.length, truncated,
      ...(truncated ? { inspect: { op: 'inspect', captureId: record.captureId, id: record.id, readVersion: version,
        sections: [field === 'patch' ? 'patch' : 'data'], contentOffset: field === 'content' ? 0 : excerpt.length,
        maxChars: 8000 }, continuationNote: field === 'content' ? 'Inspect returns the underlying raw evidence from offset zero.' : undefined } : {}) };
  }

  function project(record: LedgerRecord, spec: Expansion, reservedRoots = 0): Record<string, unknown> {
    nodes++;
    const output: Record<string, unknown> = { id: record.id, captureId: record.captureId,
      sessionId: captures.get(record.captureId).manifest.piSessionId,
      evidence: { recordId: record.id, toolCallId: record.toolCallId, requestId: record.requestId,
        sourceEntryId: record.sourceEntryId, linkBasis: record.linkBasis } };
    for (const field of spec.select ?? defaults) {
      if (field === 'content' || field === 'data' || field === 'patch') output[field] = evidence(record, field);
      else if (field === 'status' && record.type === 'tool_started') {
        const result = captures.database.records('capture_id=? AND tool_call_id=? AND type=? AND revision<=?',
          [record.captureId, record.toolCallId ?? '', 'tool_finished', version], 'ORDER BY seq DESC LIMIT 1')[0];
        output.status = result ? (result.isError ? 'error' : 'completed') : 'pending-or-missing';
      } else if (field in record) output[field] = (record as any)[field];
    }
    for (const [name, nested] of Object.entries(spec.include ?? {})) {
      const query = relationQuery(record, name, nested, version);
      if (nodes >= 500 - reservedRoots) { output[name] = { items: [], truncated: true, nextQuery: query }; continue; }
      const result = selectPage(captures, query, version);
      const items: unknown[] = [];
      let exhausted = false;
      for (const child of result.records) {
        if (nodes >= 500 - reservedRoots) { exhausted = true; break; }
        items.push(project(child, nested, reservedRoots));
      }
      output[name] = { items, truncated: exhausted || !!result.nextCursor,
        nextQuery: exhausted ? query : result.nextCursor ? { ...query, cursor: result.nextCursor } : null,
        ...(exhausted ? { note: 'Expansion budget reached; nextQuery restarts this relation. Deduplicate by id.' } : {}) };
    }
    return output;
  }

  const result = selectPage(captures, request, version);
  const items = result.records.map((record, index) => project(record, projection, result.records.length - index - 1));
  // Coverage ignores root filters: a matching successful tool must not hide a
  // gap elsewhere in the same capture. Scope and evidence version still apply.
  const coverageSelection = selection({ ...request, find: 'events', where: {} }, version, 0);
  const coverage = captures.database.sql.prepare(`SELECT r.capture_id,
    max(r.seq) AS lastSeq, sum(r.type='gap') AS gapCount,
    sum(r.type='tool_started' AND NOT EXISTS (SELECT 1 FROM records f WHERE f.capture_id=r.capture_id
      AND f.tool_call_id=r.tool_call_id AND f.type='tool_finished' AND f.revision<=r_boundary.version)) AS pendingToolCount
    ${coverageSelection.from} GROUP BY r.capture_id`).all(...coverageSelection.bindings).map(row => ({ ...row,
      currentStatus: captures.get(String(row.capture_id)).manifest.status,
      recoveryGaps: captures.get(String(row.capture_id)).recoveryGaps }));
  return { queryVersion: 3, find: request.find ?? 'events', readVersion: version, items,
    nextCursor: result.nextCursor, coverage, issues,
    budget: { contentCharsUsed: request.maxChars - budget, expandedNodes: nodes },
    notes: ['Surface text is recorded evidence, not inferred reasoning.',
      'Current capture status is live metadata; records and includes are fixed at readVersion.',
      'Input-window links are temporal; file attribution is observational, not exclusive authorship.'] };
}
