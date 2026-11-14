import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { call } from '../service/client.js';
import type { Connection } from '../service/daemon.js';
import { adapter, userHome } from '../harnesses/index.js';
import { hookState, settingsFiles, type Place } from '../harnesses/launch.js';
import { moveFolder } from '../harnesses/types.js';
import { hash } from '../storage/ledger.js';
import { cloneNote, harnessHome } from '../core/paths.js';
import type { CloneNote, Manifest } from '../core/schema.js';

interface Source { readVersion: number; manifest: Manifest; file?: string; bytes: number; turns: number;
  changes: { path: string; afterHash: string | null }[]; sharedFrom?: string }

export interface ClonePlan {
  /** The harness command and arguments that resume the copy, as `wisdom resume` would. */
  command: string;
  /** Where the copy runs: Wisdom's home for the harness, or the person's own in a connected project. */
  place: Place;
  args: string[];
  cwd: string;
  sessionId: string;
  file: string;
  source: Source;
  /** Files whose content on disk is not what the session last recorded. */
  differing: string[];
}

/** Recorded files whose content on disk is not what the session last recorded. */
export function differingFiles(cwd: string, changes: Source['changes']): string[] {
  return changes.filter(({ path: file, afterHash }) => {
    const target = path.join(cwd, file);
    if (afterHash === null) return fs.existsSync(target);
    try { return hash(fs.readFileSync(target)) !== afterHash; } catch { return true; }
  }).map(change => change.path);
}

/** A session's transcript as a new session's: every line rewritten by the harness's adapter
 * to name the new session and folder. A line that is not JSON is kept as it is.
 */
export function cloneTranscript(harness: string, text: string, clone: { from: string; sessionId: string; fromFolder: string; toFolder: string }): string {
  const move = moveFolder(clone.fromFolder, clone.toFolder);
  return text.split('\n').map(line => {
    if (!line.trim()) return line;
    try { return JSON.stringify(adapter(harness).cloneLine(JSON.parse(line), { from: clone.from, sessionId: clone.sessionId, move })); }
    catch { return line; }
  }).join('\n');
}

/** Copy a session, this project's own or a shared one, into a new session of the same harness
 * in this project. A clone is always a new session: it takes a fresh ID and refuses one that is
 * already in use, so it can never overwrite or disturb another session. The note is written
 * before the transcript, so the daemon never sees the copy without knowing what it is.
 */
export async function planClone(connection: Connection, dataDir: string, ref: string, cwd: string, now = new Date()): Promise<ClonePlan> {
  const source: Source = await call(connection, '/view', { view: 'transcript', capture: ref });
  const { manifest } = source;
  if (!source.file || !source.bytes) throw new Error(`${manifest.captureId} has no copy of its harness transcript, so it cannot be cloned. Read it instead, or hand off from it.`);
  const harness = adapter(manifest.harness);
  // A connected project runs the harness in the person's own home, so the copy goes there.
  const place: Place = hookState(dataDir, manifest.harness as keyof typeof settingsFiles.home, 'project') === 'none' ? 'home' : 'project';
  const home = place === 'project' ? userHome(manifest.harness) : harnessHome(dataDir, manifest.harness);
  const sessionId = randomUUID();
  const file = harness.sessionFile(home, sessionId, cwd, now);
  const note = cloneNote(dataDir, sessionId);
  const taken = fs.existsSync(file) || fs.existsSync(note) || harness.sessionFiles(home).some(existing => path.basename(existing).includes(sessionId))
    || await call(connection, '/resolve', { session: sessionId }).then(() => true, () => false);
  if (taken) throw new Error(`Session ID ${sessionId} is already in use, so nothing was cloned. Run the command again.`);

  const text = fs.readFileSync(source.file).subarray(0, source.bytes).toString('utf8');
  const copy = cloneTranscript(manifest.harness, text, { from: manifest.sessionId, sessionId, fromFolder: manifest.workspaceRoot, toFolder: cwd });
  fs.mkdirSync(path.dirname(note), { recursive: true });
  const written: CloneNote = { from: manifest.captureId, fromHarness: manifest.harness, version: source.readVersion, turns: source.turns,
    bytes: Buffer.byteLength(copy), createdAt: now.toISOString() };
  fs.writeFileSync(note, JSON.stringify(written, null, 2) + '\n', { flag: 'wx' });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, copy, { flag: 'wx' });
  const [command, ...args] = harness.resume(sessionId);
  return { command: command!, place, args, cwd, sessionId, file, source, differing: differingFiles(cwd, source.changes) };
}
