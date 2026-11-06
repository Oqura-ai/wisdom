import type { SessionStore } from './store.js';
import type { LedgerRecord } from './schema.js';
import { isSurfaceRecord, surfaceText } from './content.js';
import { nativeMessage } from './harnesses/index.js';

/** Cache source bytes only for the lifetime of one read. Several references can
 * point to the same native message without causing repeated file reads.
 */
export class EvidenceReader {
  private bodies = new Map<string, string | undefined>();
  constructor(private captures: SessionStore) {}

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
    if (raw === undefined || section !== 'content' || !isSurfaceRecord(record)) return raw;
    // Native lines are read through their harness adapter; hook bodies are already neutral.
    return surfaceText(record.type === 'source_record'
      ? nativeMessage(this.captures.get(record.captureId).manifest.harness, raw, record.toolCallId) : JSON.parse(raw));
  }
}

/** Every read is pinned to one committed revision, so its answer cannot move while a session records. */
export function evidenceVersion(captures: SessionStore, requested?: number): number {
  const version = requested ?? captures.database.revision;
  if (!Number.isSafeInteger(version) || version < 0 || version > captures.database.revision) {
    throw new Error(`Version ${requested} is not available: the ledger is at version ${captures.database.revision}.`);
  }
  return version;
}
