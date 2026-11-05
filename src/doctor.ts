import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { call } from './client.js';
import { CAPTURE_API, type Connection } from './daemon.js';
import { harnessHome, movedFrom, spoolDir } from './paths.js';
import { hookCommand, hookState, skillState } from './harnesses/launch.js';
import { hookEvents, inspectHooks, requireTrustedHooks } from './harnesses/codex/launch.js';
import { piVersion } from './harnesses/pi/launch.js';

export type Level = 'ok' | 'note' | 'problem';
export interface Check { level: Level; name: string; detail: string; fix?: string }

/** The newest harness versions real sessions were recorded with. A newer one may well work;
 * doctor only says so, because native formats can change between versions.
 */
const testedWith = { 'claude-code': '2.1.317', codex: '0.164.0', pi: '1.2.0' };

export function wisdomVersion(): string {
  return JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;
}

/** The version a command-line harness reports, or undefined when it cannot be run. */
function versionOf(command: string): string | undefined {
  try {
    const text = execFileSync(command, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'] });
    return /\d+\.\d+\.\d+/.exec(text)?.[0] ?? 'unknown';
  } catch { return undefined; }
}

/** What is working and what is not, for one project. It changes nothing: it never starts the
 * daemon or writes hooks, so what it reports is the state you were in when you ran it.
 */
export async function diagnose(dataDir: string, bins: { claude?: string; codex?: string; pi?: () => string | undefined } = {}): Promise<Check[]> {
  const project = path.dirname(path.resolve(dataDir));
  const checks = [await daemonCheck(dataDir)];
  checks.push(dashboardCheck(dataDir, checks[0]!));
  const version = (key: keyof typeof testedWith, found: string) => found === testedWith[key] || found === 'unknown'
    ? `version ${found}` : `version ${found}, last tested with ${testedWith[key]}`;

  const harness = (name: string, key: keyof typeof testedWith, found: string | undefined): Check => {
    const state = hookState(dataDir, key);
    if (state === 'stale') return { level: 'problem', name, detail: 'its hooks point to a copy of Wisdom that has moved or gone, so live recording has stopped', fix: 'wisdom init' };
    if (state === 'other') return { level: 'problem', name, detail: 'its hooks run a different copy of Wisdom, such as one left under an earlier Node version', fix: 'wisdom init' };
    if (state === 'none') return found
      ? { level: 'note', name, detail: `installed (${version(key, found)}), but not set up in this project`, fix: 'wisdom init' }
      : { level: 'note', name, detail: 'not installed' };
    if (!found) return { level: 'note', name, detail: 'hooks are set up, but the harness itself was not found' };
    const differs = found !== testedWith[key] && found !== 'unknown';
    const skill = skillState(dataDir, key);
    if (skill !== 'current') return { level: 'note', name, detail: `hooks in place, ${version(key, found)}. Its reading skill is ${skill}, so its agents may not know how to read recordings.`, fix: 'wisdom init' };
    return { level: differs ? 'note' : 'ok', name, detail: `hooks in place, skill installed, ${version(key, found)}` };
  };
  checks.push(harness('Claude Code', 'claude-code', versionOf(bins.claude ?? 'claude')));
  const codexBin = bins.codex ?? 'codex';
  const codex = harness('Codex', 'codex', versionOf(codexBin));
  checks.push(codex.detail.startsWith('hooks in place') ? await codexTrust(codex, codexBin, dataDir, project) : codex);
  checks.push(harness('Pi', 'pi', (bins.pi ?? piVersion)()));

  const waiting = countFiles(spoolDir(dataDir));
  checks.push(waiting
    ? { level: 'note', name: 'Spool', detail: `${waiting} event${waiting === 1 ? '' : 's'} waiting, recorded when the daemon next starts`, fix: 'wisdom daemon start' }
    : { level: 'ok', name: 'Spool', detail: 'no events waiting' });
  const moved = movedFrom(dataDir);
  if (moved) checks.push({ level: 'note', name: 'Project', detail: `moved from ${moved}. Recorded sessions follow it when the daemon next starts.` });
  return checks;
}

async function daemonCheck(dataDir: string): Promise<Check & { health?: any }> {
  const name = 'Daemon';
  const file = path.join(dataDir, 'daemon.json');
  const stopped = { level: 'note' as const, name, detail: 'not running. It starts with the next hook or wisdom command.', fix: 'wisdom daemon start' };
  let connection: Connection;
  try { connection = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return stopped; }
  let health: any;
  try { health = await call(connection, '/health', undefined, 3000); } catch { return stopped; }
  if (health.captureApi !== CAPTURE_API) return { level: 'problem', name, detail: `running from a different version of Wisdom (PID ${connection.pid})`, fix: 'wisdom daemon stop, then wisdom daemon start', health };
  return { level: 'ok', name, detail: `running at ${connection.url} (PID ${connection.pid}), ${health.captures} session${health.captures === 1 ? '' : 's'}`, health };
}

function dashboardCheck(dataDir: string, daemon: Check & { health?: any }): Check {
  const name = 'Dashboard';
  const viewer = daemon.health?.dashboard;
  if (!viewer) return { level: 'note', name, detail: 'starts with the daemon' };
  if (viewer.url && viewer.status !== 'exited') return { level: 'ok', name, detail: viewer.url };
  if (viewer.url) return { level: 'problem', name, detail: `stopped unexpectedly. Read ${path.join(dataDir, 'dashboard.log')}` };
  return { level: 'note', name, detail: viewer.reason };
}

/** Codex runs a hook only after it is trusted, so being set up is not the same as working.
 * Reads Codex's hook list without starting a thread or calling a model.
 */
async function codexTrust(check: Check, command: string, dataDir: string, project: string): Promise<Check> {
  const fix = 'wisdom track codex --setup-hooks';
  try {
    const listed = await inspectHooks(command, [], project, { ...process.env, CODEX_HOME: harnessHome(dataDir, 'codex') });
    requireTrustedHooks(listed, hookCommand('codex', dataDir));
    return check;
  } catch (error) {
    const untrusted = error instanceof Error && error.message.includes('untrusted');
    return { level: 'note', name: check.name, detail: untrusted
      ? `hooks are not trusted yet (${hookEvents.length} to review), so sessions are read from their files only`
      : 'could not check hook trust', fix: untrusted ? fix : undefined };
  }
}

function countFiles(folder: string): number {
  try {
    return fs.readdirSync(folder, { recursive: true, withFileTypes: true }).filter(item => item.isFile() && item.name.endsWith('.json')).length;
  } catch { return 0; }
}

/** Plain text, one line per check, with the command that fixes it underneath. */
export function formatChecks(project: string, checks: Check[]): string {
  const lines = [`Wisdom ${wisdomVersion()} · Node ${process.versions.node}`, `Project ${project}`, ''];
  for (const check of checks) {
    lines.push(`${check.level.padEnd(8)} ${check.name.padEnd(12)} ${check.detail}`);
    if (check.fix) lines.push(`${' '.repeat(22)}fix: ${check.fix}`);
  }
  const problems = checks.filter(check => check.level === 'problem').length;
  lines.push('', problems ? `${problems} problem${problems === 1 ? '' : 's'} found.` : 'No problems found.');
  return lines.join('\n');
}
