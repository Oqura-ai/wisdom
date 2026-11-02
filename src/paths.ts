import fs from 'node:fs';
import path from 'node:path';

/** A project is a Wisdom project when it holds `.wisdom/wisdom.json`, written by `wisdom init`. */
export const marker = 'wisdom.json';

/** The data folder of the project containing `start`, found like git finds `.git`. */
export function findDataDir(start: string): string | undefined {
  for (let dir = path.resolve(start); ; dir = path.dirname(dir)) {
    const data = path.join(dir, '.wisdom');
    if (fs.existsSync(path.join(data, marker))) return data;
    if (path.dirname(dir) === dir) return undefined;
  }
}

/** The folder a harness keeps all its own files in: settings with Wisdom's hooks, login,
 * and sessions. Any process started with it records, however it was started.
 */
export function harnessHome(dataDir: string, harness: string): string {
  return path.join(dataDir, 'harnesses', harness, 'home');
}

/** Events a hook could not deliver wait here, one file each, until the daemon reads them. */
export function spoolDir(dataDir: string): string {
  return path.join(dataDir, 'spool');
}
