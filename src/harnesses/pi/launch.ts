import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { home, installSkill, readSettings, resolveCommand, saveOrRemoveSettings, saveSettings, settingsFile, type Command, type Launch, type Place } from '../launch.js';
import { userHome } from '../index.js';

/** Reuse the user's Pi installation; do not install another agent. An entry script named with
 * --pi-entry, else the release Pi's own installer made current, else `pi` on PATH (npm).
 */
export function piCommand(entry?: string): Command {
  if (entry) return { command: process.execPath, args: [path.resolve(entry)] };
  const root = path.join(os.homedir(), '.pi', 'agent', 'install');
  let version: string;
  try { version = fs.readFileSync(path.join(root, 'current-version'), 'utf8').trim(); }
  catch { return resolveCommand('pi'); }
  if (!/^[a-zA-Z0-9._-]+$/.test(version) || version === '..') throw new Error('Invalid managed Pi version');
  const pkg = path.join(root, 'releases', version, 'node_modules', '@earendil-works', 'pi-coding-agent');
  const metadata = JSON.parse(fs.readFileSync(path.join(pkg, 'package.json'), 'utf8'));
  return { command: process.execPath, args: [path.join(pkg, typeof metadata.bin === 'string' ? metadata.bin : metadata.bin.pi)] };
}

/** Pi's agent folder (PI_CODING_AGENT_DIR) in Wisdom's folder, with Wisdom's extension
 * in its settings. Sessions, login and settings stay there; ~/.pi/agent is never touched.
 */
export function installPi(dataDir: string): string {
  const folder = home(dataDir, 'pi');
  writeExtension(dataDir, 'home', true);
  installSkill(folder);
  return folder;
}

/** Wisdom's extension in the project's `.pi/settings.json` (verified on Pi 1.2.0: loaded once
 * the project is trusted, when Pi starts in the project's folder). Pi uses the person's own
 * agent folder and login. Returns the file.
 */
export function connectPi(dataDir: string): string {
  writeExtension(dataDir, 'project', true);
  return settingsFile(dataDir, 'pi', 'project');
}

/** Take Wisdom's extension out of the project's `.pi/settings.json`, leaving everything else. */
export function disconnectPi(dataDir: string): void {
  writeExtension(dataDir, 'project', false);
}

/** Add Wisdom's extension to one Pi settings file, replacing an earlier copy, or remove it. */
function writeExtension(dataDir: string, place: Place, add: boolean): void {
  const file = settingsFile(dataDir, 'pi', place);
  const settings = readSettings(file);
  const others = (Array.isArray(settings.extensions) ? settings.extensions : [])
    .filter((item: unknown) => typeof item !== 'string' || !/harnesses[\\/]pi[\\/]extension\.js$/.test(item));
  if (add) { settings.extensions = [...others, fileURLToPath(new URL('./extension.js', import.meta.url))]; saveSettings(file, settings); return; }
  if (others.length) settings.extensions = others; else delete settings.extensions;
  saveOrRemoveSettings(file, settings);
}

/** Pi with its agent folder in Wisdom's folder, or, in a connected project, with the person's
 * own, where the project's settings load Wisdom's extension.
 */
export function launchPi(options: { entry?: string; args: string[]; dataDir: string; place?: Place }): Launch {
  const own = options.place === 'project';
  const folder = own ? userHome('pi') : installPi(options.dataDir);
  options.args.forEach((arg, i) => {
    if (/^--session-dir(?:=|$)/.test(arg)) throw new Error('Wisdom chooses where Pi stores sessions; remove --session-dir.');
    const value = arg === '--session' ? options.args[i + 1] : arg.startsWith('--session=') ? arg.slice(10) : undefined;
    if (value && /[\\/]/.test(value) && path.relative(folder, path.resolve(value)).startsWith('..')) {
      throw new Error('Resume a Wisdom session by its ID; a session file outside Wisdom cannot be tracked.');
    }
  });
  const program = piCommand(options.entry);
  return { command: program.command, env: own ? {} : { PI_CODING_AGENT_DIR: folder }, args: [...program.args, ...options.args] };
}
