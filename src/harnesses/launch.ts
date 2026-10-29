import fs from 'node:fs';
import path from 'node:path';

/** The folder a harness keeps its own files in when Wisdom launches it. Its sessions
 * never reach the user's global harness folders, so they are not listed or resumed outside Wisdom.
 */
export function harnessHome(dataDir: string, harness: string): string {
  const home = path.join(dataDir, 'harnesses', harness, 'home');
  fs.mkdirSync(home, { recursive: true });
  return home;
}

/** What `wisdom track <harness>` runs. A launcher whose hooks report to the daemon
 * sets `launch`; otherwise (Pi) the harness opens its own captures.
 */
export interface Launch {
  command: string;
  args: string[];
  env?: Record<string, string>;
  /** Interactive hook review only; do not start the recorder or MCP. */
  setupOnly?: boolean;
  launch?: { harness: string; harnessVersion?: string };
}
