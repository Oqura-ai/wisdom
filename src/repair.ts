import fs from 'node:fs';
import path from 'node:path';
import { writeJson } from './ledger.js';
import { harnessHome } from './paths.js';
import { trackedByGit } from './connect.js';
import { hookState, installSkill, settingsFile, settingsFiles, skillState, type Place } from './harnesses/launch.js';
import { connectClaudeCode, installClaudeCode } from './harnesses/claude-code/launch.js';
import { connectCodex, installCodex } from './harnesses/codex/launch.js';
import { connectPi, installPi } from './harnesses/pi/launch.js';

type Harness = keyof typeof settingsFiles.home;
const harnesses: Harness[] = ['claude-code', 'codex', 'pi'];
const writers: Record<Harness, { home: (dataDir: string) => unknown; project: (dataDir: string) => unknown }> = {
  'claude-code': { home: installClaudeCode, project: connectClaudeCode },
  codex: { home: installCodex, project: connectCodex },
  pi: { home: installPi, project: connectPi },
};

/** One harness's Wisdom setup, in its home in `.wisdom` (`wisdom init`) or in the project's own
 * settings (`wisdom connect`), that no longer works as this copy of Wisdom would write it. */
export interface RepairTarget {
  harness: Harness; place: Place;
  /** `hooks`: they point at a copy of Wisdom that moved or is another one, so they record nothing.
   * `skill`: the reading skill is missing or older, so agents may not know how to read recordings. */
  problem: 'hooks' | 'skill';
  /** The files repair rewrites; each is backed up first. */
  files: string[];
}

export interface Backup { id: string; createdAt: string; targets: RepairTarget[]; items: { original: string; saved: string | null }[] }

/** What repair would change. A settings file git tracks is never rewritten, as with `wisdom connect`. */
export function repairTargets(dataDir: string): RepairTarget[] {
  const project = path.dirname(path.resolve(dataDir));
  return harnesses.flatMap(harness => (['home', 'project'] as const).flatMap((place): RepairTarget[] => {
    const hooks = hookState(dataDir, harness, place);
    if (hooks === 'none') return [];
    const settings = settingsFile(dataDir, harness, place);
    if (place === 'project' && trackedByGit(project, settings)) return [];
    const problem = hooks === 'stale' || hooks === 'other' ? 'hooks' : skillState(dataDir, harness, place) === 'current' ? undefined : 'skill';
    return problem ? [{ harness, place, problem, files: [settings, skillFolder(dataDir, harness, place)] }] : [];
  }));
}

/** Rewrite each broken setup the way `wisdom init` or `wisdom connect` would, after copying every
 * file it changes into `.wisdom/backups/<id>/`, so `restore` can put them back exactly.
 * A running harness keeps the hooks it started with until it restarts. Codex runs changed hooks
 * only after they are reviewed again in /hooks, so `codexReview` says when that is needed.
 */
export function repair(dataDir: string, now = new Date()): { backup: Backup; codexReview: boolean } {
  const targets = repairTargets(dataDir);
  if (!targets.length) throw new Error('Nothing to repair: every harness set up here runs this copy of Wisdom.');
  const id = now.toISOString().replace(/[:.]/g, '-');
  const folder = path.join(backupsDir(dataDir), id);
  fs.mkdirSync(folder, { recursive: true });
  const items = [...new Set(targets.flatMap(target => target.files))].map((original, index) => {
    if (!fs.existsSync(original)) return { original, saved: null };
    const saved = String(index);
    fs.cpSync(original, path.join(folder, saved), { recursive: true });
    return { original, saved };
  });
  const backup: Backup = { id, createdAt: now.toISOString(), targets, items };
  // The record of what was saved is written before anything is changed.
  writeJson(path.join(folder, 'backup.json'), backup);
  for (const { harness, place } of targets) {
    writers[harness][place](dataDir);
    if (place === 'project') installSkill(path.dirname(path.dirname(skillFolder(dataDir, harness, place))));
  }
  return { backup, codexReview: targets.some(target => target.harness === 'codex' && target.problem === 'hooks') };
}

/** Put back every file one repair changed, exactly as it was before it; a file that did not exist goes. */
export function restore(dataDir: string, id: string): Backup {
  if (!/^[0-9TZ-]+$/.test(id)) throw new Error(`No backup named ${id}`);
  const folder = path.join(backupsDir(dataDir), id);
  const backup = readBackup(folder);
  if (!backup) throw new Error(`No backup named ${id}`);
  for (const { original, saved } of backup.items) {
    fs.rmSync(original, { recursive: true, force: true });
    if (saved) fs.cpSync(path.join(folder, saved), original, { recursive: true });
    // Did not exist before: neither did a folder repair made for it, if nothing else is in it now.
    else try { fs.rmdirSync(path.dirname(original)); } catch { /* not empty, or gone */ }
  }
  return backup;
}

/** Repairs that can be undone, newest first. */
export function backups(dataDir: string): Backup[] {
  let names: string[];
  try { names = fs.readdirSync(backupsDir(dataDir)); } catch { return []; }
  return names.map(name => readBackup(path.join(backupsDir(dataDir), name))).filter((b): b is Backup => !!b)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function readBackup(folder: string): Backup | undefined {
  try { return JSON.parse(fs.readFileSync(path.join(folder, 'backup.json'), 'utf8')); } catch { return undefined; }
}

function backupsDir(dataDir: string): string {
  return path.join(dataDir, 'backups');
}

function skillFolder(dataDir: string, harness: Harness, place: Place): string {
  const base = place === 'home' ? harnessHome(dataDir, harness) : path.join(path.dirname(path.resolve(dataDir)), settingsFiles.project[harness].skills);
  return path.join(base, 'skills', 'wisdom-ledger');
}
