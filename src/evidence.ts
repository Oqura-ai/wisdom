import type { Captures } from './captures.js';
import type { LedgerRecord, InspectQuery } from './schema.js';
import { surfaceText } from './content.js';
import { isSurfaceRecord } from './vocabulary.js';

/** Cache source bytes only for the lifetime of one query. Several references can
 * point to the same native message without causing repeated file reads.
 */
export class EvidenceReader {
  private bodies = new Map<string, string | undefined>();
  constructor(private captures: Captures) {}

  read(record: LedgerRecord, section: 'data' | 'patch' | 'content'): string | undefined {
    const key = `${record.captureId}:${section === 'patch' ? record.patchRef
      : record.dataRef ?? `${record.sourceOffset}:${record.sourceLength}`}:${section === 'patch' ? 'patch' : 'data'}`;
    if (!this.bodies.has(key)) {
      const ledger = this.captures.get(record.captureId);
      this.bodies.set(key, section === 'patch' ? record.patchRef ? ledger.readPayload(record.patchRef) : undefined
        : record.dataRef ? ledger.readPayload(record.dataRef)
        : record.sourceOffset !== undefined ? ledger.readSource(record) : undefined);
    }
    const raw = this.bodies.get(key);
    return raw !== undefined && section === 'content' && isSurfaceRecord(record) ? surfaceText(JSON.parse(raw)) : raw;
  }
}

export function evidenceVersion(captures: Captures, requested?: number): number {
  const version = requested ?? captures.database.revision;
  if (!Number.isSafeInteger(version) || version < 0 || version > captures.database.revision) throw new Error('Invalid or unavailable readVersion');
  return version;
}

/** Inspect one indexed record. No capture-wide scan or coverage calculation. */
export function inspectEvidence(captures: Captures, request: InspectQuery) {
  const readVersion = evidenceVersion(captures, request.readVersion);
  const record = captures.database.records('capture_id=? AND id=? AND revision<=?',
    [request.captureId, request.id, readVersion])[0];
  if (!record) throw new Error('Record not found at this readVersion');
  const reader = new EvidenceReader(captures);
  const sections: Record<string, unknown> = {};
  let budget = request.maxChars;
  for (const section of request.sections) {
    const text = reader.read(record, section);
    if (text === undefined) { sections[section] = { available: false }; continue; }
    const fragment = text.slice(request.contentOffset, request.contentOffset + budget);
    const nextOffset = request.contentOffset + fragment.length;
    sections[section] = { available: true, text: fragment, totalChars: text.length,
      nextOffset: nextOffset < text.length ? nextOffset : null };
    budget -= fragment.length;
  }
  return { id: record.id, captureId: record.captureId, readVersion, sections };
}
