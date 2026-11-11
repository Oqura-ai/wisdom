#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { call, connectionAt, ensureDaemon } from './service/client.js';
import { startDaemon, type Connection } from './service/daemon.js';
import { diagnose, formatChecks, wisdomVersion } from './setup/doctor.js';
import { harnessByCommand, planHandoff } from './sessions/handoff.js';
import { connect, disconnect, ignoreDataFolder, type Connectable } from './setup/connect.js';
import { planClone } from './sessions/clone.js';
import { chooseRedactions, defaultSharePath, draftShare, findSecrets, formatFindings, homePlaces, writeShare } from './share/share.js';
import { redactSecrets } from './share/secrets.js';
import { serveMcp } from './service/mcp.js';
import { findDataDir, marker, movedFrom } from './core/paths.js';
import { writeJson } from './storage/ledger.js';
import { installPi, launchPi, piCommand } from './harnesses/pi/launch.js';
import { installClaudeCode, launchClaudeCode } from './harnesses/claude-code/launch.js';
import { installCodex, launchCodex } from './harnesses/codex/launch.js';
import { adapter, resumeCommands, sessionPlace } from './harnesses/index.js';
import { hookState, resolveCommand, settingsFile, staleHooks, type Command, type Launch, type Place } from './harnesses/launch.js';

const help = `Wisdom records your coding agents' sessions, so you and your agents can read them.

Set up
  wisdom connect                  Record claude, codex and pi started here, with your own login
  wisdom disconnect               Stop that, taking out what connect added; recordings are kept
  wisdom init                     Record agents started with wisdom track, each with its own login here
  wisdom doctor                   Check that everything is working

Run an agent
  wisdom track claude|codex|pi    Start an agent in this project, recording
  wisdom resume <session-id>      Continue a recorded session (takes the full ID)
  wisdom handoff <claude|codex|pi|session-id> [--from <session-id>]
                                  Continue work in a new or existing session, which
                                  reads the other session first

Read a session
  wisdom dashboard                Print the address of the live dashboard
  wisdom glance                   List recorded sessions, newest first
  wisdom glance <session>         Show one session's shape and every turn
  wisdom open <position> --capture <session>
                                  Read one turn, tool call or subagent, whole

Share a session
  wisdom share <session>...       Write a file to send a teammate, after a check for secrets
  wisdom import <file>            Read a teammate's shared file here, read-only
  wisdom export <session>         Write a session as Markdown anyone can read, after a check for secrets
  wisdom clone <session>          Carry a session on as a new one, in the same agent

Background service
  wisdom daemon start|stop|status
  wisdom daemon run               Run it in the foreground

Other
  wisdom mcp                      Serve the optional read-only MCP tool
  wisdom --version

<session>   a session ID, its first 8 or more characters, or latest
<position>  t3 (a turn), t3/c2 (a tool call), a1 (a subagent), a1/c2, or outside

Options
  --cwd DIR, --data DIR           Use the project at DIR, or the data folder DIR
  --from N, --at VERSION          glance, open: read from a line, at a fixed version
  --from <session-id>             handoff: the session to read (default: the newest other one)
  --port N, --no-dashboard        daemon: choose a port, or skip the dashboard
  --claude-bin, --codex-bin FILE  track: use another installation (Pi: --pi-entry FILE)
  --setup-hooks                   track codex: review Wisdom's hooks, first time only
  --trust-all-hooks               track codex: skip the review, for every hook in that run
  -- ARGUMENTS                    track: pass the rest to the agent; handoff: add to its prompt
  --out FILE                      share, export: where to save (default: .wisdom/shared-out/); export: - prints it
  --redact, --keep-secrets        share, export: replace what the check finds, or keep it, without asking

Docs: https://github.com/Oqura-ai/wisdom
`;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const separator = args.indexOf('--');
  const harnessArgs = separator < 0 ? [] : args.slice(separator + 1);
  const { positionals, values } = parseArgs({ args: separator < 0 ? args : args.slice(0, separator), allowPositionals: true,
    options: {
      data: { type: 'string' }, port: { type: 'string' }, cwd: { type: 'string' }, 'pi-entry': { type: 'string' },
      help: { type: 'boolean' }, version: { type: 'boolean' }, capture: { type: 'string' }, from: { type: 'string' }, at: { type: 'string' },
      'claude-bin': { type: 'string' }, 'no-dashboard': { type: 'boolean' }, out: { type: 'string' }, redact: { type: 'boolean' }, 'keep-secrets': { type: 'boolean' }, json: { type: 'boolean' }, 'codex-bin': { type: 'string' }, 'setup-hooks': { type: 'boolean' }, 'trust-all-hooks': { type: 'boolean' },
    } });
  const [command, first] = positionals;
  if (values.version) { console.log(wisdomVersion()); return; }
  if (!command || values.help) { console.log(help); return; }
  const options: Record<string, string[]> = {
    init: ['cwd', 'port', 'pi-entry', 'claude-bin', 'codex-bin'], connect: ['cwd', 'port', 'pi-entry', 'claude-bin', 'codex-bin'], disconnect: ['cwd'],
    daemon: ['cwd', 'port', 'no-dashboard'], dashboard: ['cwd'], doctor: ['cwd', 'json'], track: ['port', 'cwd', 'pi-entry', 'claude-bin', 'codex-bin', 'setup-hooks', 'trust-all-hooks'], mcp: ['cwd', 'port'],
    resume: ['cwd', 'port', 'pi-entry', 'claude-bin', 'codex-bin', 'trust-all-hooks'],
    handoff: ['cwd', 'port', 'from', 'pi-entry', 'claude-bin', 'codex-bin', 'trust-all-hooks'],
    share: ['cwd', 'port', 'out', 'redact', 'keep-secrets'], import: ['cwd', 'port'], export: ['cwd', 'port', 'out', 'redact', 'keep-secrets'],
    clone: ['cwd', 'port', 'pi-entry', 'claude-bin', 'codex-bin', 'trust-all-hooks'],
    glance: ['cwd', 'from', 'at'], open: ['cwd', 'capture', 'from', 'at'],
  };
  const allowed = options[command];
  if (!allowed) throw new Error(['start', 'stop', 'status'].includes(command) ? `Unknown command: ${command}. Did you mean: wisdom daemon ${command}?` : `Unknown command: ${command}. Run: wisdom --help`);
  for (const key of Object.keys(values)) if (key !== 'data' && !allowed.includes(key)) throw new Error(`--${key} is not valid for ${command}`);
  if (separator >= 0 && !['track', 'handoff'].includes(command)) throw new Error('Arguments after -- are only supported by track and handoff');
  if (command !== 'share' && positionals.length > (['daemon', 'track', 'resume', 'handoff', 'import', 'export', 'clone', 'glance', 'open'].includes(command) ? 2 : 1)) throw new Error('Unexpected positional arguments');

  const port = values.port === undefined ? undefined : Number(values.port);
  if (port !== undefined && (!Number.isInteger(port) || port < 0 || port > 65535)) throw new Error('--port needs a number from 0 to 65535.');
  if (command === 'init') { await init(path.resolve(values.cwd ?? process.cwd()), values, port); return; }
  if (command === 'connect') { await connectProject(path.resolve(values.cwd ?? process.cwd()), values, port); return; }
  const explicit = values.data ?? process.env.WISDOM_DATA_DIR;
  const start = path.resolve(values.cwd ?? process.cwd());
  const found = explicit ? path.resolve(explicit) : findDataDir(start);
  if (!found) throw new Error(`${start} is not inside a Wisdom project. Run: wisdom init`);
  const dataDir = found;
  if (command === 'disconnect') {
    const was = disconnect(dataDir);
    console.log(`Wisdom is disconnected from ${path.dirname(dataDir)}: its hooks and reading skill are out of the project's settings${was.length ? ` (${was.map(harness => names[harness]).join(', ')})` : ''}. Your recordings are kept.`);
    return;
  }
  if (command === 'doctor') {
    const checks = await diagnose(dataDir);
    // --json: for the dashboard's health strip, which the daemon fills by running this.
    if (values.json) console.log(JSON.stringify({ version: wisdomVersion(), project: path.dirname(dataDir),
      checks: checks.map(({ level, name, detail, fix }) => ({ level, name, detail, fix })) }));
    else console.log(formatChecks(path.dirname(dataDir), checks));
    if (checks.some(check => check.level === 'problem')) process.exitCode = 1;
    return;
  }
  // track and resume write the hooks again themselves.
  const stale = ['track', 'resume', 'disconnect'].includes(command) ? [] : staleHooks(dataDir);
  if (stale.length) console.error(`Wisdom's hooks for ${stale.join(', ')} point to a Wisdom build that has moved, so they cannot run. Run: wisdom init`);
  if (command === 'daemon') {
    if (first === 'run') {
      const daemon = await runDaemon(dataDir, port, !values['no-dashboard']);
      console.error(`Wisdom listening at ${daemon.connection.url}; data: ${dataDir}`);
      const viewer = (await call(daemon.connection, '/health')).dashboard;
      console.error(viewer.url ? `Dashboard: ${viewer.url}` : `Dashboard not started: ${viewer.reason}`);
      const stop = () => void daemon.close();
      process.once('SIGINT', stop); process.once('SIGTERM', stop);
      await daemon.closed;
      process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
    } else if (first === 'start') {
      await showRunning(await ensureDaemon(dataDir, port, !values['no-dashboard']));
    } else if (first === 'status') await showRunning(connectionAt(dataDir));
    else if (first === 'stop') await stopDaemon(dataDir);
    else throw new Error('Use: wisdom daemon start|stop|status|run');
    return;
  }
  if (command === 'dashboard') {
    const viewer = (await call(connectionAt(dataDir), '/health')).dashboard;
    if (!viewer.url) throw new Error(`Dashboard not running: ${viewer.reason}`);
    console.log(viewer.url); return;
  }
  if (command === 'track') { process.exitCode = await track(first, values, harnessArgs, dataDir, port); return; }
  if (command === 'resume') {
    // The ledger knows the harness, folder and full ID; the harness gets its own resume flag.
    if (!first) throw new Error('Use: wisdom resume SESSION-ID (the full ID; glance lists them)');
    const session = await call(await ensureDaemon(dataDir, port), '/resolve', { session: first });
    const [harness, ...args] = adapter(session.harness).resume(session.captureId);
    console.error(`Resuming ${session.harness} session ${session.captureId}`);
    // A session continues in the home it ran in: Wisdom's, or the person's own in a connected project.
    process.exitCode = await track(harness, { ...values, cwd: session.workspaceRoot }, args, dataDir, port, {}, sessionPlace(dataDir, session.harness, session.source)); return;
  }
  if (command === 'handoff') { process.exitCode = await handoff(first, values, harnessArgs.join(' '), dataDir, port); return; }
  if (command === 'share') { process.exitCode = await share(positionals.slice(1), values, dataDir, port); return; }
  if (command === 'import') { await importShare(first, dataDir, port); return; }
  if (command === 'export') { process.exitCode = await exportMarkdown(first, values, dataDir, port); return; }
  if (command === 'clone') { process.exitCode = await clone(first, values, dataDir, port); return; }
  if (command === 'mcp') { await serveMcp(await ensureDaemon(dataDir, port)); return; }
  // glance and open: the same request an agent sends through MCP, printed as the same text.
  const number = (flag: string, value?: string) => {
    if (value !== undefined && !/^\d+$/.test(value)) throw new Error(`${flag} needs a whole number.`);
    return value === undefined ? undefined : Number(value);
  };
  const reading = { from: number('--from', values.from), at: number('--at', values.at) };
  if (command === 'open' && !first) throw new Error('Use: wisdom open POSITION --capture CAPTURE|latest');
  const input = command === 'glance' ? { capture: first, glance: true, ...reading } : { capture: values.capture, open: first, ...reading };
  console.log((await call(await ensureDaemon(dataDir), '/ledger', input)).text);
}

/** What the running service is, in the same words whichever command asked. */
async function showRunning(connection: Connection): Promise<void> {
  const health = await call(connection, '/health');
  const viewer = health.dashboard;
  console.log('Wisdom is running.');
  console.log(`  Address    ${connection.url} (PID ${connection.pid})`);
  console.log(`  Dashboard  ${dashboardLine(viewer)}`);
  console.log(`  Sessions   ${health.captures}`);
}

function dashboardLine(viewer: any): string {
  if (!viewer.url) return `not started. ${viewer.reason}`;
  return viewer.status === 'exited' ? `stopped unexpectedly. Read ${viewer.log}` : viewer.url;
}

/** Stopping something already stopped is not a failure, and "stopped" is only said once it is. */
async function stopDaemon(dataDir: string): Promise<void> {
  const file = path.join(dataDir, 'daemon.json');
  if (!fs.existsSync(file)) { console.log('Wisdom is not running.'); return; }
  try { await call(connectionAt(dataDir), '/stop', {}); }
  catch (error) {
    if (error instanceof Error && error.message.includes('not answering')) { console.log('Wisdom is not running.'); return; }
    throw error;
  }
  for (let attempt = 0; attempt < 50 && fs.existsSync(file); attempt++) await new Promise(resolve => setTimeout(resolve, 100));
  console.log(fs.existsSync(file) ? 'Wisdom is stopping.' : 'Wisdom stopped.');
}

/** The daemon's default port is 7434; when another project's daemon holds it, the next
 * free pair is used (daemon.json says which). An explicit --port is used as given.
 */
async function runDaemon(dataDir: string, port: number | undefined, dashboard: boolean) {
  for (let candidate = port ?? 7434; ; candidate += 2) {
    try { return await startDaemon(dataDir, candidate, { dashboardPort: dashboard && candidate ? candidate + 1 : undefined }); }
    catch (error: any) { if (port !== undefined || error?.code !== 'EADDRINUSE' || candidate >= 7434 + 40) throw error; }
  }
}

/** Make a folder a Wisdom project: its data folder, Wisdom's hooks in each installed
 * harness's home there, and a running daemon. Running it again repairs the hooks.
 */
async function init(project: string, values: any, port?: number): Promise<void> {
  const { dataDir, fresh } = makeProject(project);
  console.log(fresh ? `Wisdom is set up in ${project}` : `Wisdom was already set up in ${project}. Its hooks and skills are refreshed.`);
  const known = fresh ? undefined : movedFrom(dataDir);
  if (known) console.log(`This project moved from ${known}. Its recorded sessions follow it when the daemon starts.`);
  console.log('\nStart an agent:');
  const found = installedHarnesses(values);
  const installed = (harness: Connectable, install: () => unknown, next: string) => {
    if (!found.includes(harness)) { console.log(`  ${names[harness].padEnd(12)} not installed. Run wisdom init again after installing it.`); return; }
    install();
    console.log(`  ${names[harness].padEnd(12)} ${next}`);
  };
  installed('claude-code', () => installClaudeCode(dataDir), 'wisdom track claude');
  installed('codex', () => installCodex(dataDir), 'wisdom track codex --setup-hooks, trust its hooks in /hooks, then wisdom track codex');
  installed('pi', () => installPi(dataDir), 'wisdom track pi');
  const connection = await ensureDaemon(dataDir, port);
  console.log(`\nDashboard: ${dashboardLine((await call(connection, '/health')).dashboard)}`);
  console.log('\nEach agent asks you to log in once for this project. Your global agent settings are not touched.');
  console.log('Keep .wisdom/ private: it holds your sessions and agent logins, unredacted. Git ignores it, but leave it out of zips and synced folders.');
}

const names: Record<Connectable, string> = { 'claude-code': 'Claude Code', codex: 'Codex', pi: 'Pi' };

/** Make a folder a Wisdom project: its data folder, marked, and kept out of git, since session
 * files and payloads are stored unredacted.
 */
function makeProject(project: string): { dataDir: string; fresh: boolean } {
  if (!fs.existsSync(project)) throw new Error(`${project} does not exist`);
  const dataDir = path.join(project, '.wisdom');
  const fresh = !fs.existsSync(path.join(dataDir, marker));
  fs.mkdirSync(dataDir, { recursive: true });
  if (fresh) writeJson(path.join(dataDir, marker), { project, createdAt: new Date().toISOString() });
  ignoreDataFolder(project);
  return { dataDir, fresh };
}

/** The harnesses that run here: each is asked for its version. */
function installedHarnesses(values: any): Connectable[] {
  const programs: Record<Connectable, () => Command> = {
    'claude-code': () => resolveCommand(values['claude-bin'] ?? 'claude'),
    codex: () => resolveCommand(values['codex-bin'] ?? 'codex'),
    pi: () => piCommand(values['pi-entry']),
  };
  return (Object.keys(programs) as Connectable[]).filter(harness => {
    try { const { command, args } = programs[harness](); execFileSync(command, [...args, '--version'], { windowsHide: true, stdio: 'ignore' }); return true; }
    catch { return false; }
  });
}

/** Record plain `claude`, `codex` and `pi` in this project with the person's own login. */
async function connectProject(project: string, values: any, port?: number): Promise<void> {
  const { dataDir, fresh } = makeProject(project);
  const found = installedHarnesses(values);
  const result = connect(dataDir, found);
  console.log(`${fresh ? 'Wisdom is set up in' : 'Wisdom is connected in'} ${project}. Start your agent here as you always do, with your own login:\n`);
  const next: Record<Connectable, string> = {
    'claude-code': 'claude   (start it in this folder, not a subfolder)',
    codex: 'codex    (trust this project if it asks, then review Wisdom\'s hooks once in /hooks)',
    pi: 'pi       (start it in this folder, and trust this project when it asks)',
  };
  for (const harness of Object.keys(names) as Connectable[]) {
    const line = result.connected.includes(harness) ? next[harness]
      : !found.includes(harness) ? 'not installed. Run wisdom connect again after installing it.'
      : `not connected: git tracks ${path.relative(project, settingsFile(dataDir, harness, 'project'))}, and Wisdom will not put this machine's paths in it. Use wisdom track ${harness === 'claude-code' ? 'claude' : harness}.`;
    console.log(`  ${names[harness].padEnd(12)} ${line}`);
  }
  console.log(`\nWisdom added its hook and reading skill to: ${result.files.map(file => path.relative(project, file)).join(', ') || 'nothing'}.`);
  console.log(result.excluded ? 'They are listed in .git/info/exclude, so git ignores them and they never reach your teammates. wisdom disconnect removes them.'
    : 'This folder is not a git repository, so nothing was excluded from git. wisdom disconnect removes them.');
  await ensureDaemon(dataDir, port);
  console.log('Keep .wisdom/ private: it holds your sessions, unredacted. Git ignores it, but leave it out of zips and synced folders.');
}

/** Start a harness in this project. Tracked (`place` home), it runs with its home in the
 * project's data folder, whose hooks record it. Connected (`place` project), it runs with the
 * person's own home and login, and the project's settings record it.
 */
async function track(harness: string | undefined, values: any, args: string[], dataDir: string, port?: number, env: Record<string, string> = {}, place: Place = 'home'): Promise<number> {
  const name = harnessByCommand[harness ?? ''];
  if (place === 'project' && name && hookState(dataDir, name as Connectable, 'project') === 'none') {
    throw new Error(`This ${names[name as Connectable]} session runs with your own login, and this project is not connected, so it would not be recorded. Run: wisdom connect`);
  }
  // Claude Code and Pi load a project's settings only when started in its own folder (verified on
  // 2.1.319 and 1.2.0), so a connected session starts there; Codex finds them from any folder below.
  const asked = path.resolve(values.cwd ?? process.cwd());
  const cwd = place === 'project' && name !== 'codex' ? path.dirname(path.resolve(dataDir)) : asked;
  if (path.relative(cwd, asked)) console.error(`Starting in ${cwd}, the project's folder: there ${names[name as Connectable]} loads the settings that record it.`);
  const cliPath = fileURLToPath(new URL('./cli.js', import.meta.url));
  if (values['pi-entry'] && harness !== 'pi') throw new Error('--pi-entry applies only to track pi');
  if (values['claude-bin'] && harness !== 'claude') throw new Error('--claude-bin applies only to track claude');
  if ((values['codex-bin'] || values['setup-hooks'] || values['trust-all-hooks']) && harness !== 'codex') {
    throw new Error('--codex-bin, --setup-hooks and --trust-all-hooks apply only to track codex');
  }
  const launch: Launch = harness === 'pi' ? launchPi({ entry: values['pi-entry'], args, dataDir, place })
    : harness === 'claude' ? launchClaudeCode({ command: values['claude-bin'], args, dataDir, cliPath, place })
    : harness === 'codex' ? await launchCodex({ command: values['codex-bin'], args, dataDir, cliPath, cwd, setupHooks: values['setup-hooks'], trustAllHooks: values['trust-all-hooks'], place })
    : (() => { throw new Error('Use: wisdom track pi|claude|codex'); })();
  if (launch.setupOnly) console.error('Open /hooks in Codex, review and trust the Wisdom hooks, then quit and run wisdom track codex. '
    + 'Until they are trusted, sessions are read from their files only.');
  else {
    await ensureDaemon(dataDir, port);
    console.error(place === 'project' ? 'Wisdom records this session through the project\'s settings, with your own login.'
      : 'Wisdom is recording sessions in this harness home.');
  }
  // The ledger skill calls this installation's CLI from the project.
  return runHarness(launch, cwd, { ...process.env, ...env, ...launch.env, WISDOM_CLI_PATH: cliPath });
}

/** Write one file a teammate can read: chosen sessions, their evidence, no logins. What looks
 * like a secret is shown first, and is redacted in the file, kept, or the share cancelled.
 */
async function share(refs: string[], values: any, dataDir: string, port?: number): Promise<number> {
  if (!refs.length) throw new Error('Use: wisdom share SESSION... [--out FILE] [--redact | --keep-secrets]');
  if (values.redact && values['keep-secrets']) throw new Error('--redact and --keep-secrets are alternatives; choose one.');
  const draft = await draftShare(await ensureDaemon(dataDir, port), refs);
  if (draft.findings.length) console.log(formatFindings(draft.findings));
  const prompt = process.stdin.isTTY ? createInterface({ input: process.stdin, output: process.stdout }) : undefined;
  let redact;
  try { redact = await chooseRedactions(draft.findings, { redact: values.redact, keep: values['keep-secrets'] }, prompt && (question => prompt.question(question))); }
  finally { prompt?.close(); }
  if (!redact) { console.log('Cancelled. Nothing was written.'); return 1; }
  const out = path.resolve(values.out ?? defaultSharePath(dataDir, draft));
  const { file, bytes } = writeShare(draft, redact, out);
  const records = draft.sessions.reduce((n, session) => n + session.records.length, 0);
  const files = draft.pieces.length - records;
  const size = bytes < 1024 * 1024 ? `${Math.ceil(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  console.log(`\nSaved ${file} (${size}): ${draft.sessions.length === 1 ? '1 session' : `${draft.sessions.length} sessions`}, ${records} records, ${files} files.`);
  if (redact.length) console.log(`Redacted ${redact.length === 1 ? '1 value' : `${redact.length} values`} in this file. Your recording is unchanged.`);
  if (draft.findings.length > redact.length) console.log(`Kept ${draft.findings.length - redact.length} you chose to keep.`);
  if (draft.unscanned) console.log(`${draft.unscanned} files are not text, so the check could not read them.`);
  if (draft.homePlaces) console.log(`Your home folder path appears in ${draft.homePlaces} places, and it includes your username.`);
  const project = path.dirname(dataDir);
  if (!path.relative(project, file).startsWith('..') && path.relative(dataDir, file).startsWith('..')) console.log('This file is inside your project. Keep it out of git.');
  console.log('No logins are included. The check can miss secrets, so look through what you send.');
  return 0;
}

/** Carry a session on as a new session of the same harness in this project: its history
 * copied, recorded from the clone onward. The original, own or shared, is never changed.
 */
async function clone(ref: string | undefined, values: any, dataDir: string, port?: number): Promise<number> {
  if (!ref) throw new Error('Use: wisdom clone SESSION');
  const project = path.resolve(values.cwd ?? path.dirname(dataDir));
  const plan = await planClone(await ensureDaemon(dataDir, port), dataDir, ref, project);
  const { manifest, turns, sharedFrom } = plan.source;
  console.error(`Cloned ${manifest.harness} session ${manifest.captureId}${sharedFrom ? ` (shared from ${sharedFrom})` : ''}, ${turns === 1 ? '1 turn' : `${turns} turns`}, into new session ${plan.sessionId}.`);
  console.error('Wisdom records it from here on. The cloned turns stay readable in the original.');
  if (plan.differing.length) {
    const shown = plan.differing.slice(0, 5).join(', ') + (plan.differing.length > 5 ? `, and ${plan.differing.length - 5} more` : '');
    console.error(`Note: ${plan.differing.length === 1 ? '1 file differs' : `${plan.differing.length} files differ`} on disk from what this session remembers: ${shown}.`);
  }
  try { return await track(plan.command, { ...values, cwd: project }, plan.args, dataDir, port, {}, plan.place); }
  catch (error) {
    // The copy is already saved, so say how to start it once the agent can run.
    const later = resumeCommands(dataDir, plan.source.manifest.harness, plan.sessionId, project, plan.file);
    console.error(`${error instanceof Error ? error.message : error}\nThe clone is saved as session ${plan.sessionId}. Start it later with:\n  ${process.platform === 'win32' ? later.powershell : later.posix}`);
    return 1;
  }
}

/** One session as Markdown, for people without Wisdom: a PR, an issue, docs. The same check
 * for secrets as share runs first. Messages go to stderr, so `--out -` prints only the document.
 */
async function exportMarkdown(ref: string | undefined, values: any, dataDir: string, port?: number): Promise<number> {
  if (!ref) throw new Error('Use: wisdom export SESSION [--out FILE|-] [--redact | --keep-secrets]');
  if (values.redact && values['keep-secrets']) throw new Error('--redact and --keep-secrets are alternatives; choose one.');
  const { captureId, markdown } = await call(await ensureDaemon(dataDir, port), '/view', { view: 'markdown', capture: ref });
  // A finding is placed by the turn heading above it.
  const place = (index: number) => [...markdown.slice(0, index).matchAll(/^## (t\d+|Outside any turn)/gm)].at(-1)?.[1] ?? 'header';
  const findings = findSecrets([{ text: markdown, place }]);
  if (findings.length) console.error(formatFindings(findings));
  const prompt = process.stdin.isTTY ? createInterface({ input: process.stdin, output: process.stderr }) : undefined;
  let redact;
  try { redact = await chooseRedactions(findings, { redact: values.redact, keep: values['keep-secrets'] }, prompt && (question => prompt.question(question))); }
  finally { prompt?.close(); }
  if (!redact) { console.error('Cancelled. Nothing was written.'); return 1; }
  const document = redactSecrets(markdown, new Map(redact.map(finding => [finding.value, finding.kind])));
  if (values.out === '-') { process.stdout.write(document); return 0; }
  const out = path.resolve(values.out ?? path.join(dataDir, 'shared-out', `${captureId.slice(0, 8)}.md`));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, document);
  console.error(`Saved ${out}.`);
  if (redact.length) console.error(`Redacted ${redact.length === 1 ? '1 value' : `${redact.length} values`} in this file. Your recording is unchanged.`);
  if (findings.length > redact.length) console.error(`Kept ${findings.length - redact.length} you chose to keep.`);
  const home = homePlaces([document]);
  if (home) console.error(`Your home folder path appears in ${home} places, and it includes your username.`);
  if (!path.relative(path.dirname(dataDir), out).startsWith('..') && path.relative(dataDir, out).startsWith('..')) console.error('This file is inside your project. Keep it out of git.');
  console.error('The check can miss secrets, so look through it before you post it.');
  return 0;
}

/** Read a teammate's share file in this project. The daemon builds a read-only copy; this
 * project's own recordings are never touched.
 */
async function importShare(file: string | undefined, dataDir: string, port?: number): Promise<void> {
  if (!file) throw new Error('Use: wisdom import FILE');
  const result = await call(await ensureDaemon(dataDir, port), '/import', { file: path.resolve(file) });
  const when = (iso: string) => `${iso.slice(0, 16).replace('T', ' ')}Z`;
  const count = result.sessions.length === 1 ? '1 shared session' : `${result.sessions.length} shared sessions`;
  console.log(`${result.added ? 'Imported' : 'Already imported:'} ${count} from ${result.shared.project}, shared ${when(result.shared.sharedAt)}:`);
  for (const session of result.sessions) console.log(`  ${session.captureId}  ${session.harness}  ${session.turns === 1 ? '1 turn' : `${session.turns} turns`}`);
  if (result.shared.redactions) console.log(`The sender redacted ${result.shared.redactions === 1 ? '1 value' : `${result.shared.redactions} values`}.`);
  for (const id of result.alsoRecordedHere) console.log(`${id} is also recorded in this project, so reads show your own recording.`);
  console.log(`Read-only, as recorded on the sender's machine. Read it with: wisdom glance ${result.sessions[0].captureId.slice(0, 8)}`);
}

/** Continue work in another session that reads this one first: a new session in any
 * harness, or an existing one resumed. A running session cannot take outside input, so
 * for one the prompt is printed to paste instead.
 */
async function handoff(target: string | undefined, values: any, words: string, dataDir: string, port?: number): Promise<number> {
  if (!target) throw new Error('Use: wisdom handoff claude|codex|pi|SESSION-ID [--from SESSION-ID]');
  const plan = await planHandoff(await ensureDaemon(dataDir, port), target, values.from, words);
  if (plan.target?.status === 'recording') {
    console.error(`Session ${plan.target.captureId} is still running, so Wisdom cannot start it. Paste this into it instead:\n`);
    console.log(plan.prompt);
    return 1;
  }
  if (plan.note) console.error(`Note: ${plan.note}`);
  console.error(plan.target
    ? `Resuming ${plan.target.harness} session ${plan.target.captureId}; it reads ${plan.from.harness} session ${plan.from.captureId} first.`
    : `Starting a new ${plan.command} session; it reads ${plan.from.harness} session ${plan.from.captureId} first.`);
  // A resumed session continues in the home it ran in; a new one runs connected when this project is.
  const place = plan.target ? sessionPlace(dataDir, plan.target.harness, plan.targetSource)
    : hookState(dataDir, harnessByCommand[plan.command] as Connectable, 'project') === 'none' ? 'home' : 'project';
  return track(plan.command, { ...values, cwd: plan.cwd ?? values.cwd }, plan.args, dataDir, port, plan.env, place);
}

function runHarness(launch: Launch, cwd: string, env: NodeJS.ProcessEnv): Promise<number> {
  const child = spawn(launch.command, launch.args, { cwd, stdio: 'inherit', windowsHide: true, env });
  return new Promise((resolve, reject) => {
    child.once('error', reject); child.once('exit', code => resolve(code ?? 1));
  });
}

// A reader that stops early (`| head`, `| Select-Object -First`) is not a failure.
process.stdout.on('error', (error: NodeJS.ErrnoException) => { if (error.code === 'EPIPE') process.exit(0); throw error; });

main().catch(error => { console.error(errorText(error)); process.exitCode = 1; });

/** Node's own message for an unknown option talks about positional arguments. */
function errorText(error: any): string {
  if (error?.code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION') return `Unknown option ${/'([^']+)'/.exec(error.message)?.[1] ?? ''}. Run: wisdom --help`;
  return error instanceof Error ? error.message : String(error);
}
