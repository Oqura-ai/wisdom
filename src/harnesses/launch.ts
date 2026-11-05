import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { harnessHome } from '../paths.js';
import { writeJson } from '../ledger.js';

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

/** `node "<integrations/<harness>/hook.mjs>" "<data folder>"`: the hook needs nothing else. */
export function hookCommand(harness: string, dataDir: string): string {
  const file = fileURLToPath(new URL(`../../../integrations/${harness}/hook.mjs`, import.meta.url)).replaceAll('\\', '/');
  const data = path.resolve(dataDir).replaceAll('\\', '/');
  if (/["\r\n]/.test(file + data)) throw new Error('Wisdom and its data folder cannot have quotes or newlines in their paths');
  return `node "${file}" "${data}"`;
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

/** Whether a harness home holds this copy of Wisdom's skill. */
export function skillState(dataDir: string, harness: string): 'missing' | 'outdated' | 'current' {
  const read = (file: string) => { try { return fs.readFileSync(file, 'utf8'); } catch { return undefined; } };
  const installed = read(path.join(harnessHome(dataDir, harness), 'skills', 'wisdom-ledger', 'SKILL.md'));
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
  const ours = (item: any) => Array.isArray(item?.hooks) && item.hooks.some((h: any) => typeof h?.command === 'string'
    && /integrations\/(?:claude-code|codex)\/hook\.mjs/.test(h.command.replaceAll('\\', '/')));
  for (const event of events) {
    result[event] = [...(result[event] ?? []).filter(item => !ours(item)),
      { ...entry(event), hooks: [{ type: 'command', command, ...hook(event) }] }];
  }
  return result;
}

export function saveSettings(file: string, value: unknown): void { writeJson(file, value); }

/** Harnesses whose home points at a Wisdom build that is no longer there (the install
 * moved). Their hooks cannot run, so only the session files can be read until init repairs them.
 */
export function staleHooks(dataDir: string): string[] {
  const files = hookFiles(dataDir);
  return Object.keys(files).filter(harness => files[harness]!.some(file => !fs.existsSync(file)));
}

/** How one harness's home is connected to this copy of Wisdom. `other` means its hooks run
 * a different copy, such as one left under a previous Node version.
 */
export function hookState(dataDir: string, harness: string): 'none' | 'stale' | 'other' | 'current' {
  const files = hookFiles(dataDir)[harness] ?? [];
  if (!files.length) return 'none';
  if (files.some(file => !fs.existsSync(file))) return 'stale';
  const expected = harness === 'pi' ? new URL('./pi/extension.js', import.meta.url) : new URL(`../../../integrations/${harness}/hook.mjs`, import.meta.url);
  const same = (file: string) => path.relative(fileURLToPath(expected), file) === '';
  return files.every(same) ? 'current' : 'other';
}

/** The Wisdom files each harness home names. */
function hookFiles(dataDir: string): Record<string, string[]> {
  const read = (harness: string, file: string) => { try { return readSettings(path.join(harnessHome(dataDir, harness), file)); } catch { return {}; } };
  const files: Record<string, string[]> = { 'claude-code': [], codex: [], pi: [] };
  for (const [harness, file] of [['claude-code', 'settings.json'], ['codex', 'hooks.json']] as const) {
    for (const items of Object.values(read(harness, file).hooks ?? {})) {
      for (const item of Array.isArray(items) ? items : []) for (const hook of item?.hooks ?? []) {
        const named = /"([^"]*integrations\/(?:claude-code|codex)\/hook\.mjs)"/.exec(String(hook?.command ?? ''))?.[1];
        if (named) files[harness]!.push(named);
      }
    }
  }
  const extensions = read('pi', 'settings.json').extensions;
  files.pi = (Array.isArray(extensions) ? extensions : []).filter((item: unknown) => typeof item === 'string' && /harnesses[\\/]pi[\\/]extension\.js$/.test(item));
  return files;
}
