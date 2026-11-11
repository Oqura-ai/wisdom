import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { writeJson } from './ledger.js';
import { connectedFile, readConnected, type Connected } from './paths.js';
import { userHome } from './harnesses/index.js';
import { hookState, installSkill, removeSkill, settingsFile, settingsFiles } from './harnesses/launch.js';
import { connectClaudeCode, disconnectClaudeCode } from './harnesses/claude-code/launch.js';
import { connectCodex, disconnectCodex } from './harnesses/codex/launch.js';
import { connectPi, disconnectPi } from './harnesses/pi/launch.js';

export type Connectable = keyof typeof settingsFiles.home;
const connectors: Record<Connectable, { connect: (dataDir: string) => string; disconnect: (dataDir: string) => void }> = {
  'claude-code': { connect: connectClaudeCode, disconnect: disconnectClaudeCode },
  codex: { connect: connectCodex, disconnect: disconnectCodex },
  pi: { connect: connectPi, disconnect: disconnectPi },
};

const BEGIN = '# wisdom connect: local settings naming this machine (wisdom disconnect removes this block)';
const END = '# end wisdom connect';
const DATA_BEGIN = '# wisdom: this project\'s recordings and logins, never committed';
const DATA_END = '# end wisdom data folder';

/** Record these harnesses with the person's own login: Wisdom's hook or extension in the
 * project's own settings, and the reading skill beside them. Nothing reaches git: the files
 * go in `.git/info/exclude`, and a settings file git already tracks is left alone.
 */
export function connect(dataDir: string, harnesses: Connectable[], now = new Date()): { connected: Connectable[]; tracked: string[]; files: string[]; excluded: boolean } {
  const project = path.dirname(path.resolve(dataDir));
  const tracked = harnesses.map(harness => settingsFile(dataDir, harness, 'project')).filter(file => trackedByGit(project, file));
  const connected = harnesses.filter(harness => !tracked.includes(settingsFile(dataDir, harness, 'project')));
  const files = connected.map(harness => connectors[harness].connect(dataDir));
  for (const folder of new Set(connected.map(harness => settingsFiles.project[harness].skills))) {
    installSkill(path.join(project, folder));
    files.push(path.join(project, folder, 'skills', 'wisdom-ledger'));
  }
  const before = readConnected(dataDir);
  const after: Connected = { ...before };
  for (const harness of connected) after[harness] = { since: before[harness]?.since ?? now.toISOString(), home: userHome(harness) };
  writeJson(connectedFile(dataDir), after);
  const excluded = setExcluded(project, files.map(file => '/' + path.relative(project, file).replaceAll('\\', '/') + (fs.statSync(file).isDirectory() ? '/' : '')));
  return { connected, tracked, files, excluded };
}

/** Take Wisdom out of the project's settings and skill folders, exactly what connect added.
 * Recordings are kept.
 */
export function disconnect(dataDir: string): Connectable[] {
  const project = path.dirname(path.resolve(dataDir));
  const was = Object.keys(readConnected(dataDir)) as Connectable[];
  for (const harness of Object.keys(connectors) as Connectable[]) {
    // A file that does not name Wisdom is not touched, not even rewritten.
    if (hookState(dataDir, harness, 'project') !== 'none' && !trackedByGit(project, settingsFile(dataDir, harness, 'project'))) connectors[harness].disconnect(dataDir);
  }
  for (const folder of new Set(Object.values(settingsFiles.project).map(files => files.skills))) removeSkill(path.join(project, folder));
  fs.rmSync(connectedFile(dataDir), { force: true });
  setExcluded(project, []);
  return was;
}

/** Whether git tracks a file. Without git, or outside a repository, nothing is tracked. */
export function trackedByGit(project: string, file: string): boolean {
  try {
    execFileSync('git', ['ls-files', '--error-unmatch', '--', path.relative(project, file).replaceAll('\\', '/')], { cwd: project, windowsHide: true, stdio: 'ignore' });
    return true;
  } catch { return false; }
}

/** Replace Wisdom's block in the repository's own `info/exclude` (git's per-clone ignore file,
 * never committed) with these patterns, or remove it. Without a repository there is nothing to do.
 */
function setExcluded(project: string, patterns: string[], begin = BEGIN, end = END): boolean {
  let file: string;
  try {
    file = path.resolve(project, execFileSync('git', ['rev-parse', '--git-path', 'info/exclude'], { cwd: project, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim());
  } catch { return false; }
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const kept = text.replace(new RegExp(`${escape(begin)}[\\s\\S]*?${escape(end)}\\r?\\n?`), '');
  const block = patterns.length ? `${kept && !kept.endsWith('\n') ? '\n' : ''}${begin}\n${patterns.join('\n')}\n${end}\n` : '';
  if (kept + block === text) return true;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, kept + block);
  return true;
}

/** Keep `.wisdom/` out of git without changing a file the project shares: in a repository it goes
 * in `info/exclude`, in its own block, because `wisdom disconnect` must not expose it. The
 * pattern has no leading slash, so it covers every Wisdom project in the repository, subfolders
 * included. Outside a repository it goes in `.gitignore`, where a later `git init` will honour it.
 */
export function ignoreDataFolder(project: string): void {
  if (setExcluded(project, ['.wisdom/'], DATA_BEGIN, DATA_END)) return;
  const ignore = path.join(project, '.gitignore');
  const lines = fs.existsSync(ignore) ? fs.readFileSync(ignore, 'utf8').split(/\r?\n/) : [];
  const ignored = lines.some(line => ['.wisdom', '.wisdom/', '/.wisdom', '/.wisdom/'].includes(line.trim()));
  if (!ignored) fs.appendFileSync(ignore, (lines.length && lines.at(-1) !== '' ? '\n' : '') + '.wisdom/\n');
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
