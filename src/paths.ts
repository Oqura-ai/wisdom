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

/** The folder this project was in when it was last seen, if that is not where it is now. */
export function movedFrom(dataDir: string): string | undefined {
  try {
    const { project } = JSON.parse(fs.readFileSync(path.join(dataDir, marker), 'utf8'));
    return typeof project === 'string' && path.relative(project, path.dirname(path.resolve(dataDir))) ? project : undefined;
  } catch { return undefined; }
}

/** The folder a harness keeps all its own files in: settings with Wisdom's hooks, login,
 * and sessions. Any process started with it records, however it was started.
 */
export function harnessHome(dataDir: string, harness: string): string {
  return path.join(dataDir, 'harnesses', harness, 'home');
}

/** The data folder a hook reports to. The home this process really uses wins: a project
 * moved or copied still names its old folder in its hook command. A folder that no longer
 * exists is never recreated, so a move cannot leave a second, empty project behind.
 */
export function hookDataDir(harness: string, home: string | undefined, named: string | undefined): string {
  if (home) {
    const data = path.resolve(home, '..', '..', '..');
    if (path.resolve(harnessHome(data, harness)) === path.resolve(home) && fs.existsSync(path.join(data, marker))) return data;
  }
  if (!named) throw new Error('the hook names no Wisdom data folder; run wisdom init again');
  if (!fs.existsSync(named)) throw new Error(`its Wisdom data folder ${named} no longer exists; if the project moved, run wisdom init there`);
  return named;
}

export interface Worktree { root: string; main: string; name: string; gitDir: string }

/** `dir` when it is a linked git worktree: its `.git` is a file naming the main repository.
 * A submodule's `.git` file names something else, and it stays part of its project.
 */
export function worktreeAt(dir: string): Worktree | undefined {
  let text: string;
  try { text = fs.readFileSync(path.join(dir, '.git'), 'utf8'); } catch { return undefined; }
  const match = /^gitdir:\s*(.+?)[\\/]\.git[\\/]worktrees[\\/]([^\\/\r\n]+)\s*$/.exec(text);
  if (!match) return undefined;
  return { root: dir, main: path.resolve(match[1]!), name: match[2]!, gitDir: path.resolve(match[1]!, '.git', 'worktrees', match[2]!) };
}

/** The linked worktree containing `folder`, found the way git finds its repository. */
export function linkedWorktree(folder: string): Worktree | undefined {
  for (let dir = path.resolve(folder); ; dir = path.dirname(dir)) {
    const git = path.join(dir, '.git');
    if (fs.existsSync(git)) return fs.statSync(git).isFile() ? worktreeAt(dir) : undefined;
    if (path.dirname(dir) === dir) return undefined;
  }
}

/** The branch a linked worktree is on now; a detached checkout has none. */
export function worktreeBranch(tree: Worktree): string | undefined {
  try { return /^ref: refs\/heads\/(.+?)\s*$/.exec(fs.readFileSync(path.join(tree.gitDir, 'HEAD'), 'utf8'))?.[1]; } catch { return undefined; }
}

/** The note `wisdom clone` leaves for the session it creates. */
export function cloneNote(dataDir: string, sessionId: string): string {
  return path.join(dataDir, 'clones', `${sessionId}.json`);
}

/** Events a hook could not deliver wait here, one file each, until the daemon reads them. */
export function spoolDir(dataDir: string): string {
  return path.join(dataDir, 'spool');
}
