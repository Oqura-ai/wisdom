import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { harnessHome, type Launch } from '../launch.js';

/** Reuse the user's Pi installation; do not install another agent. */
function piEntry(explicit?: string): string {
  if (explicit) return path.resolve(explicit);
  const root = path.join(os.homedir(), '.pi', 'agent', 'install');
  const version = fs.readFileSync(path.join(root, 'current-version'), 'utf8').trim();
  if (!/^[a-zA-Z0-9._-]+$/.test(version) || version === '..') throw new Error('Invalid managed Pi version');
  const pkg = path.join(root, 'releases', version, 'node_modules', '@earendil-works', 'pi-coding-agent');
  const metadata = JSON.parse(fs.readFileSync(path.join(pkg, 'package.json'), 'utf8'));
  return path.join(pkg, typeof metadata.bin === 'string' ? metadata.bin : metadata.bin.pi);
}

/** Pi opens and closes its own capture from inside the extension. Its sessions are
 * stored in Wisdom's folder, not in ~/.pi/agent/sessions; the login stays Pi's own.
 */
export function launchPi(options: { entry?: string; args: string[]; dataDir: string }): Launch {
  const home = harnessHome(options.dataDir, 'pi');
  options.args.forEach((arg, i) => {
    if (/^--session-dir(?:=|$)/.test(arg)) throw new Error('Wisdom chooses where Pi stores sessions; remove --session-dir.');
    const value = arg === '--session' ? options.args[i + 1] : arg.startsWith('--session=') ? arg.slice(10) : undefined;
    if (value && /[\\/]/.test(value) && path.relative(home, path.resolve(value)).startsWith('..')) {
      throw new Error('Resume a Wisdom session by its ID; a session file outside Wisdom cannot be tracked.');
    }
  });
  return { command: process.execPath, args: [piEntry(options.entry), '--session-dir', home,
    '--extension', fileURLToPath(new URL('./extension.js', import.meta.url)),
    '--skill', fileURLToPath(new URL('../../../../skills/wisdom-ledger', import.meta.url)), ...options.args] };
}
