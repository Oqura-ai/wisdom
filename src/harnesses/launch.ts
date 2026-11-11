import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { harnessHome } from '../core/paths.js';
import { writeJson } from '../storage/ledger.js';

/** What `wisdom track <harness>` runs: the harness with its home set to Wisdom's folder.
 * Recording does not depend on it; the hooks live in that home.
 */
export interface Launch {
  command: string;
  args: string[];
  env?: Record<string, string>;
  /** Interactive hook review only; do not start the MCP server. */
  setupOnly?: boolean;
}

/** A harness program as Node can start it: the file, and any arguments that come first. */
export interface Command { command: string; args: string[] }

/** Find a harness the way the person's shell would. On Windows, Node starts only `.exe` and
 * `.com` files by name, and refuses a `.cmd` without a shell (CVE-2024-27980), which would not
 * escape arguments. npm, pnpm and yarn install a command as a `.cmd` shim, so the shim is
 * followed to the program it starts: an `.exe` itself, a script with this Node. Elsewhere,
 * and when nothing is found, the command is started as named.
 */
export function resolveCommand(name: string): Command {
  if (process.platform !== 'win32') return { command: name, args: [] };
  const file = /[\\/]/.test(name) ? path.resolve(name) : onPath(name);
  if (!file) return { command: name, args: [] };
  const extension = path.extname(file).toLowerCase();
  if (['.cmd', '.bat'].includes(extension)) {
    const target = shimTarget(file);
    if (!target) throw new Error(`${file} does not name the program it starts; pass that program's path instead.`);
    return ['.exe', '.com'].includes(path.extname(target).toLowerCase()) ? { command: target, args: [] } : { command: process.execPath, args: [target] };
  }
  return ['.js', '.mjs', '.cjs'].includes(extension) ? { command: process.execPath, args: [file] } : { command: file, args: [] };
}

/** The first match on PATH, trying PATHEXT's runnable extensions in order, as cmd.exe does. */
function onPath(name: string): string | undefined {
  const runnable = ['.com', '.exe', '.bat', '.cmd'];
  const extensions = path.extname(name) ? [''] : (process.env.PATHEXT ?? runnable.join(';')).toLowerCase().split(';').filter(ext => runnable.includes(ext));
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    for (const extension of extensions) {
      const file = path.join(dir.replace(/^"(.*)"$/, '$1'), name + extension);
      if (isFile(file)) return file;
    }
  }
  return undefined;
}

/** The program a shim starts: its last quoted path that is a file. cmd-shim (npm, yarn) writes
 * it as `"%dp0%\…"`, pnpm as `"%~dp0\…"`, both relative to the shim; other shims in full.
 */
function shimTarget(file: string): string | undefined {
  const dir = path.dirname(file);
  return [...fs.readFileSync(file, 'utf8').matchAll(/"([^"]+)"/g)]
    .map(match => match[1].replace(/^%~?dp0%?[\\/]?/i, dir + path.sep))
    .filter(value => !value.includes('%')).map(value => path.resolve(dir, value)).filter(isFile).at(-1);
}

const isFile = (file: string) => { try { return fs.statSync(file).isFile(); } catch { return false; } };

/** `node "<integrations/<harness>/hook.mjs>" "<data folder>"`: the hook needs nothing else.
 * The copy `wisdom connect` puts in a project's settings ends with `project`, so it can stand
 * aside in a tracked session, whose home holds the same hook.
 */
export function hookCommand(harness: string, dataDir: string, project = false): string {
  const file = fileURLToPath(new URL(`../../../integrations/${harness}/hook.mjs`, import.meta.url)).replaceAll('\\', '/');
  const data = path.resolve(dataDir).replaceAll('\\', '/');
  if (/["\r\n]/.test(file + data)) throw new Error('Wisdom and its data folder cannot have quotes or newlines in their paths');
  return `node "${file}" "${data}"${project ? ' project' : ''}`;
}

/** Where a harness's settings name Wisdom: in its home in Wisdom's folder (`wisdom init`), and
 * in the project (`wisdom connect`), where its own login is used. Skills go under `<skills>/skills`.
 */
export const settingsFiles = {
  home: { 'claude-code': 'settings.json', codex: 'hooks.json', pi: 'settings.json' },
  project: {
    'claude-code': { settings: path.join('.claude', 'settings.local.json'), skills: '.claude' },
    codex: { settings: path.join('.codex', 'hooks.json'), skills: '.agents' },
    pi: { settings: path.join('.pi', 'settings.json'), skills: '.agents' },
  },
} as const;
export type Place = 'home' | 'project';

/** The settings file that names Wisdom for a harness, in its home or in the project. */
export function settingsFile(dataDir: string, harness: keyof typeof settingsFiles.home, place: Place): string {
  return place === 'home' ? path.join(harnessHome(dataDir, harness), settingsFiles.home[harness])
    : path.join(path.dirname(path.resolve(dataDir)), settingsFiles.project[harness].settings);
}

/** A harness home, created on first use. */
export function home(dataDir: string, harness: string): string {
  const folder = harnessHome(dataDir, harness);
  fs.mkdirSync(folder, { recursive: true });
  return folder;
}

const shippedSkill = fileURLToPath(new URL('../../../skills/wisdom-ledger/', import.meta.url));

/** Copy the reading skill into a harness home, so any session there knows how to read
 * recordings, however it was started. Wisdom owns this folder; each install replaces it.
 */
export function installSkill(folder: string): void {
  const target = path.join(folder, 'skills', 'wisdom-ledger');
  fs.rmSync(target, { recursive: true, force: true });
  fs.cpSync(shippedSkill, target, { recursive: true });
}

/** Take Wisdom's skill out of a folder's `skills`, leaving any other skill as it is. */
export function removeSkill(folder: string): void {
  fs.rmSync(path.join(folder, 'skills', 'wisdom-ledger'), { recursive: true, force: true });
  for (const empty of [path.join(folder, 'skills'), folder]) try { fs.rmdirSync(empty); } catch { /* not empty, or gone */ }
}

/** Whether a harness's home, or the project, holds this copy of Wisdom's skill. */
export function skillState(dataDir: string, harness: keyof typeof settingsFiles.home, place: Place = 'home'): 'missing' | 'outdated' | 'current' {
  const read = (file: string) => { try { return fs.readFileSync(file, 'utf8'); } catch { return undefined; } };
  const folder = place === 'home' ? harnessHome(dataDir, harness) : path.join(path.dirname(path.resolve(dataDir)), settingsFiles.project[harness].skills);
  const installed = read(path.join(folder, 'skills', 'wisdom-ledger', 'SKILL.md'));
  if (installed === undefined) return 'missing';
  return installed === read(path.join(shippedSkill, 'SKILL.md')) ? 'current' : 'outdated';
}

/** Read a harness's JSON settings, or none. */
export function readSettings(file: string): Record<string, any> {
  if (!fs.existsSync(file)) return {};
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${file} is not a JSON object`);
  return value;
}

/** Put Wisdom's hook under each event of a Claude-style `hooks` object, replacing an
 * earlier Wisdom hook (a moved install) and keeping every other hook as it was.
 */
export function withHooks(hooks: Record<string, any[]> | undefined, events: readonly string[], command: string,
  entry: (event: string) => Record<string, unknown>, hook: (event: string) => Record<string, unknown> = () => ({})): Record<string, any[]> {
  const result = { ...hooks };
  for (const event of events) {
    result[event] = [...(result[event] ?? []).filter(item => !isWisdomHook(item)),
      { ...entry(event), hooks: [{ type: 'command', command, ...hook(event) }] }];
  }
  return result;
}

/** A Claude-style `hooks` object without Wisdom's hooks: an event left with none is dropped,
 * and so is the whole object when nothing else remains. Every other hook stays as it was.
 */
export function withoutHooks(hooks: Record<string, any[]> | undefined): Record<string, any[]> | undefined {
  const result: Record<string, any[]> = {};
  for (const [event, items] of Object.entries(hooks ?? {})) {
    const kept = (Array.isArray(items) ? items : []).filter(item => !isWisdomHook(item));
    if (kept.length) result[event] = kept;
  }
  return Object.keys(result).length ? result : undefined;
}

const isWisdomHook = (item: any) => Array.isArray(item?.hooks) && item.hooks.some((h: any) => typeof h?.command === 'string'
  && /integrations\/(?:claude-code|codex)\/hook\.mjs/.test(h.command.replaceAll('\\', '/')));

export function saveSettings(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeJson(file, value);
}

/** Save settings that no longer name Wisdom; a file left empty is removed, and so is a folder
 * it leaves empty, since Wisdom made them.
 */
export function saveOrRemoveSettings(file: string, value: Record<string, unknown>): void {
  if (Object.keys(value).length) { saveSettings(file, value); return; }
  fs.rmSync(file, { force: true });
  try { fs.rmdirSync(path.dirname(file)); } catch { /* not empty */ }
}

/** Harnesses whose home or project settings point at a Wisdom build that is no longer there (the
 * install moved). Their hooks cannot run, so only the session files can be read until init repairs them.
 */
export function staleHooks(dataDir: string): string[] {
  return (['claude-code', 'codex', 'pi'] as const).filter(harness => (['home', 'project'] as const)
    .some(place => hookFiles(dataDir, harness, place).some(file => !fs.existsSync(file))));
}

/** How one harness's home, or the project, is connected to this copy of Wisdom. `other` means
 * its hooks run a different copy, such as one left under a previous Node version.
 */
export function hookState(dataDir: string, harness: keyof typeof settingsFiles.home, place: Place = 'home'): 'none' | 'stale' | 'other' | 'current' {
  const files = hookFiles(dataDir, harness, place);
  if (!files.length) return 'none';
  if (files.some(file => !fs.existsSync(file))) return 'stale';
  const expected = harness === 'pi' ? new URL('./pi/extension.js', import.meta.url) : new URL(`../../../integrations/${harness}/hook.mjs`, import.meta.url);
  const same = (file: string) => path.relative(fileURLToPath(expected), file) === '';
  return files.every(same) ? 'current' : 'other';
}

/** The Wisdom files a harness's settings name, in its home or in the project. */
function hookFiles(dataDir: string, harness: keyof typeof settingsFiles.home, place: Place): string[] {
  let settings: Record<string, any>;
  try { settings = readSettings(settingsFile(dataDir, harness, place)); } catch { return []; }
  if (harness === 'pi') return (Array.isArray(settings.extensions) ? settings.extensions : [])
    .filter((item: unknown): item is string => typeof item === 'string' && /harnesses[\\/]pi[\\/]extension\.js$/.test(item));
  const files: string[] = [];
  for (const items of Object.values(settings.hooks ?? {})) {
    for (const item of Array.isArray(items) ? items : []) for (const hook of item?.hooks ?? []) {
      const named = /"([^"]*integrations\/(?:claude-code|codex)\/hook\.mjs)"/.exec(String(hook?.command ?? ''))?.[1];
      if (named) files.push(named);
    }
  }
  return files;
}
