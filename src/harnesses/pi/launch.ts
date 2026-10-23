import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Launch } from '../launch.js';

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

/** Pi opens and closes its own capture from inside the extension. */
export function launchPi(options: { entry?: string; args: string[] }): Launch {
  return { command: process.execPath, args: [piEntry(options.entry),
    '--extension', fileURLToPath(new URL('./extension.js', import.meta.url)),
    '--skill', fileURLToPath(new URL('../../../../skills/wisdom-ledger', import.meta.url)), ...options.args] };
}
