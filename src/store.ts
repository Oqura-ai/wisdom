import type { LedgerDatabase } from './database.js';
import type { Ledger } from './ledger.js';

/** Where a shared copy came from, shown wherever it is read. */
export interface SharedInfo {
  shareId: string;
  /** The sender's project folder name. */
  project: string;
  sharedAt: string;
  importedAt: string;
  /** How many values the sender redacted, and the patches those redactions edited. */
  redactions: number;
  patchesEdited: string[];
}

/** One session in a shared copy, as the session list shows it. */
export interface SharedSession { captureId: string; harness: string; startedAt: string; turns: number; project: string; sharedAt: string }

/** What reading needs from a place sessions are kept: this project's own recordings, or a
 * shared copy imported read-only. The ledger, views and stats read through this alone.
 */
export interface SessionStore {
  readonly dataDir: string;
  readonly database: LedgerDatabase;
  get(id: string): Ledger;
  /** Present only for a shared copy. */
  readonly shared?: SharedInfo;
}
