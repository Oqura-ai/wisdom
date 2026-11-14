import path from 'node:path';
import { LedgerDatabase } from './database.js';
import { Ledger } from './ledger.js';
import type { SessionStore } from './store.js';

/** This project's recordings, opened for reading by a process other than the daemon (a git
 * hook's background job). SQLite's WAL lets it read while the daemon writes. Unlike the
 * daemon's own store it changes nothing on opening: no session is marked interrupted.
 */
export class ReadStore implements SessionStore {
  readonly database: LedgerDatabase;
  private ledgers = new Map<string, Ledger>();

  constructor(readonly dataDir: string) {
    this.database = new LedgerDatabase(path.join(dataDir, 'ledger.sqlite'));
  }

  get(id: string): Ledger {
    const known = this.ledgers.get(id);
    if (known) return known;
    const manifest = this.database.manifests().find(m => m.captureId === id);
    if (!manifest) throw new Error(`No session has the ID ${id}.`);
    const ledger = new Ledger(path.join(this.dataDir, 'harnesses', manifest.harness, id), manifest, this.database);
    this.ledgers.set(id, ledger);
    return ledger;
  }

  close(): void { this.database.close(); }
}
