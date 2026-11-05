import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { home, installSkill, readSettings, saveSettings, type Launch } from '../launch.js';

/** Reuse the user's Pi installation; do not install another agent. */
export function piEntry(explicit?: string): string {
  if (explicit) return path.resolve(explicit);
  const root = path.join(os.homedir(), '.pi', 'agent', 'install');
  const version = fs.readFileSync(path.join(root, 'current-version'), 'utf8').trim();
  if (!/^[a-zA-Z0-9._-]+$/.test(version) || version === '..') throw new Error('Invalid managed Pi version');
  const pkg = path.join(root, 'releases', version, 'node_modules', '@earendil-works', 'pi-coding-agent');
  const metadata = JSON.parse(fs.readFileSync(path.join(pkg, 'package.json'), 'utf8'));
  return path.join(pkg, typeof metadata.bin === 'string' ? metadata.bin : metadata.bin.pi);
}

/** The managed Pi version, or undefined when Pi is not installed that way. */
export function piVersion(): string | undefined {
  try { return fs.readFileSync(path.join(os.homedir(), '.pi', 'agent', 'install', 'current-version'), 'utf8').trim() || undefined; }
  catch { return undefined; }
}

/** Pi's agent folder (PI_CODING_AGENT_DIR) in Wisdom's folder, with Wisdom's extension
 * in its settings. Sessions, login and settings stay there; ~/.pi/agent is never touched.
 */
export function installPi(dataDir: string): string {
  const folder = home(dataDir, 'pi');
  const file = path.join(folder, 'settings.json');
  const settings = readSettings(file);
  const extension = fileURLToPath(new URL('./extension.js', import.meta.url));
  const others = (Array.isArray(settings.extensions) ? settings.extensions : [])
    .filter((item: unknown) => typeof item !== 'string' || !/harnesses[\\/]pi[\\/]extension\.js$/.test(item));
  settings.extensions = [...others, extension];
  saveSettings(file, settings);
  installSkill(folder);
  return folder;
}

export function launchPi(options: { entry?: string; args: string[]; dataDir: string }): Launch {
  const folder = installPi(options.dataDir);
  options.args.forEach((arg, i) => {
    if (/^--session-dir(?:=|$)/.test(arg)) throw new Error('Wisdom chooses where Pi stores sessions; remove --session-dir.');
    const value = arg === '--session' ? options.args[i + 1] : arg.startsWith('--session=') ? arg.slice(10) : undefined;
    if (value && /[\\/]/.test(value) && path.relative(folder, path.resolve(value)).startsWith('..')) {
      throw new Error('Resume a Wisdom session by its ID; a session file outside Wisdom cannot be tracked.');
    }
  });
  return { command: process.execPath, env: { PI_CODING_AGENT_DIR: folder },
    args: [piEntry(options.entry), ...options.args] };
}
