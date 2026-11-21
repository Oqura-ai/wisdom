#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { call, connectionAt, ensureDaemon, startDetached } from './service/client.js';
import { startDaemon, type Connection } from './service/daemon.js';
import { diagnose, formatChecks, wisdomVersion } from './setup/doctor.js';
import { handoffPrompt, harnessByCommand, planHandoff } from './sessions/handoff.js';
import { connect, disconnect, ignoreDataFolder, ignoreSettingsFile, type Connectable } from './setup/connect.js';
import { usePrices } from './read/prices.js';
import { guidePrompt, guideSettings } from './team/writer.js';
import type { CommitRecord } from './team/commits.js';
import type { SessionStore } from './storage/store.js';
import { DEFAULT_MODEL, harnessOn, harnessPath, SETTINGS_FILE, settingsOrDefaults, shownAs, writeSettings, type Settings } from './core/settings.js';
import { planClone } from './sessions/clone.js';
import { chooseRedactions, defaultSharePath, draftShare, findSecrets, formatFindings, homePlaces, writeShare } from './share/share.js';
import { redactSecrets } from './share/secrets.js';
import { prCheck } from './team/team.js';
import { oldPolicyNote, POLICY_FILE, policyCommands, readPolicy, trustCommands, trusted, writePolicy } from './team/gitrefs.js';
import { guideCommit, installHooks, LOCAL_HOOKS, removeHooks, runGitHook } from './team/githooks.js';
import { guidesOn, setGuides } from './team/guides.js';
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
  wisdom.yaml                     Your settings for the project: init and connect write it, with
                                  every default; change a line to change one

Run an agent
  wisdom track claude|codex|pi    Start an agent in this project, recording
  wisdom resume <session-id>      Continue a recorded session (takes the full ID)
  wisdom handoff <claude|codex|pi|session-id> [--from <session-id>] ["what it should know"]
                                  Continue work in a new or existing session, which reads the
                                  other session first
  wisdom handoff ... --emit       The same in the background, while you keep working: it reads
                                  the session, changes nothing, and its reply is printed when it
                                  is done (Ctrl+C stops waiting, not the handoff). Continue there
                                  later with wisdom resume

Read a session
  wisdom dashboard                Print the address of the live dashboard
  wisdom glance                   List recorded sessions, newest first
  wisdom glance <session>         Show one session's shape and every turn
  wisdom glance --commit <commit> Show which recorded steps made each piece of a git commit
  wisdom open <position> --capture <session>
                                  Read one turn, tool call or subagent, whole

Team mode (a repository with wisdom-team.yaml)
  wisdom team init                Start team mode: write wisdom-team.yaml for an admin to commit
  wisdom team hooks on|off        Wisdom's git hooks: a link line on each commit, its record and
                                  guide written after it, and both sent with your push (init and
                                  connect turn them on in a team-mode repository)
  wisdom team trust               Read the commands wisdom-team.yaml runs on this machine (check,
                                  guides.command) and let them run; asked again if one changes
  wisdom guide on|off             Whether a model (Haiku 5.5, or guides.model: wisdom-team.yaml's
                                  in team mode, wisdom.yaml's in local mode) writes a guide after
                                  each commit, reading its sessions since your last commit. Team mode: on by
                                  default; off, Wisdom writes a plain guide from the record.
                                  Local mode: off by default; on installs one post-commit hook,
                                  changes no commit message and pushes nothing
  wisdom guide <commit>           Have a model write that commit's guide now, any mode, from its
                                  record's window. Without one, glance --commit shows a plain
                                  guide built from the record in local mode
  wisdom check --range A..B       In CI: each agent commit has a guide, its sessions are pushed
  wisdom team push|fetch          Send your sessions and commit records now, or read teammates'
  wisdom team delete <session>    Remove a pushed session for everyone
  wisdom team prune               Remove pushed sessions older than the policy keeps them

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
  --remote NAME, --range A..B     team, check: another remote than the policy's; the PR's commits
  --from <session-id>             handoff: the session to read (default: the one running it, or the newest other one)
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
      help: { type: 'boolean' }, version: { type: 'boolean' }, capture: { type: 'string' }, commit: { type: 'string' }, remote: { type: 'string' }, range: { type: 'string' }, from: { type: 'string' }, at: { type: 'string' },
      'claude-bin': { type: 'string' }, 'no-dashboard': { type: 'boolean' }, out: { type: 'string' }, redact: { type: 'boolean' }, 'keep-secrets': { type: 'boolean' }, json: { type: 'boolean' }, 'codex-bin': { type: 'string' }, 'setup-hooks': { type: 'boolean' }, 'trust-all-hooks': { type: 'boolean' }, emit: { type: 'boolean' },
    } });
  const [command, first] = positionals;
  if (values.version) { console.log(wisdomVersion()); return; }
  if (!command || values.help) { console.log(help); return; }
  // Run by Wisdom's own git hooks; never fails, so a hook never fails git.
  if (command === 'githook') { if (first && values.data) runGitHook(first, positionals.slice(2), path.resolve(values.data)); return; }
  // Started by `wisdom handoff --emit`, in a process of its own: runs one background harness.
  if (command === 'handoff-run') { if (first) await runBackgroundHarness(first); return; }
  const options: Record<string, string[]> = {
    init: ['cwd', 'port', 'pi-entry', 'claude-bin', 'codex-bin'], connect: ['cwd', 'port', 'pi-entry', 'claude-bin', 'codex-bin'], disconnect: ['cwd'],
    daemon: ['cwd', 'port', 'no-dashboard'], dashboard: ['cwd'], doctor: ['cwd', 'json'], track: ['port', 'cwd', 'pi-entry', 'claude-bin', 'codex-bin', 'setup-hooks', 'trust-all-hooks'], mcp: ['cwd', 'port'],
    resume: ['cwd', 'port', 'pi-entry', 'claude-bin', 'codex-bin', 'trust-all-hooks'],
    handoff: ['cwd', 'port', 'from', 'emit', 'pi-entry', 'claude-bin', 'codex-bin', 'trust-all-hooks'],
    share: ['cwd', 'port', 'out', 'redact', 'keep-secrets'], import: ['cwd', 'port'], export: ['cwd', 'port', 'out', 'redact', 'keep-secrets'],
    clone: ['cwd', 'port', 'pi-entry', 'claude-bin', 'codex-bin', 'trust-all-hooks'],
    glance: ['cwd', 'commit', 'from', 'at'], open: ['cwd', 'capture', 'from', 'at'],
    guide: ['cwd'], check: ['cwd', 'range', 'remote'], team: ['cwd', 'remote'],
  };
  const allowed = options[command];
  if (!allowed) throw new Error(['start', 'stop', 'status'].includes(command) ? `Unknown command: ${command}. Did you mean: wisdom daemon ${command}?` : `Unknown command: ${command}. Run: wisdom --help`);
  for (const key of Object.keys(values)) if (key !== 'data' && !allowed.includes(key)) throw new Error(`--${key} is not valid for ${command}`);
  if (separator >= 0 && !['track', 'handoff'].includes(command)) throw new Error('Arguments after -- are only supported by track and handoff');
  // A handoff's words may follow its target without `--`: PowerShell drops a `--` it is given.
  if (!['share', 'handoff'].includes(command) && positionals.length >(['guide', 'team'].includes(command) ? 3 : ['daemon', 'track', 'resume', 'handoff', 'import', 'export', 'clone', 'glance', 'open'].includes(command) ? 2 : 1)) throw new Error('Unexpected positional arguments');

  const port = values.port === undefined ? undefined : Number(values.port);
  if (port !== undefined && (!Number.isInteger(port) || port < 0 || port > 65535)) throw new Error('--port needs a number from 0 to 65535.');
  if (command === 'init') { await init(path.resolve(values.cwd ?? process.cwd()), values, port); return; }
  if (command === 'connect') { await connectProject(path.resolve(values.cwd ?? process.cwd()), values, port); return; }
  // These two work in any git checkout, with no data folder: an admin's first step, and CI.
  if (command === 'check' && values.range) {
    const result = prCheck(path.resolve(values.cwd ?? process.cwd()), values.range, values.remote);
    console.log(result.text); if (!result.ok) process.exitCode = 1; return;
  }
  if (command === 'team' && first === 'init') {
    const { file, policy, created } = writePolicy(path.resolve(values.cwd ?? process.cwd()));
    console.log(created ? `Wrote ${file} (repo ID ${policy.repoId}). Commit it to turn team mode on for everyone; remove it to go back to local mode.` : `${POLICY_FILE} is already there: ${file}`);
    return;
  }
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
      // Hooks start the daemon too, so a broken wisdom.yaml means the defaults here, never no daemon.
      const { daemon: chosen, prices } = settingsOrDefaults(path.dirname(dataDir));
      usePrices(prices);
      const daemon = await runDaemon(dataDir, port, !values['no-dashboard'] && chosen?.dashboard !== false, chosen?.port);
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
  if (command === 'handoff') { process.exitCode = await handoff(first, values, [...positionals.slice(2), ...harnessArgs].join(' '), dataDir, port); return; }
  if (command === 'share') { process.exitCode = await share(positionals.slice(1), values, dataDir, port); return; }
  if (command === 'import') { await importShare(first, dataDir, port); return; }
  if (command === 'export') { process.exitCode = await exportMarkdown(first, values, dataDir, port); return; }
  if (command === 'clone') { process.exitCode = await clone(first, values, dataDir, port); return; }
  if (command === 'mcp') { await serveMcp(await ensureDaemon(dataDir, port)); return; }
  if (command === 'guide' || command === 'check' || command === 'team') { process.exitCode = await teamCommand(command, positionals.slice(1), values, dataDir); return; }
  // glance and open: the same request an agent sends through MCP, printed as the same text.
  const number = (flag: string, value?: string) => {
    if (value !== undefined && !/^\d+$/.test(value)) throw new Error(`${flag} needs a whole number.`);
    return value === undefined ? undefined : Number(value);
  };
  const reading = { from: number('--from', values.from), at: number('--at', values.at) };
  if (command === 'open' && !first) throw new Error('Use: wisdom open POSITION --capture CAPTURE|latest');
  const input = command === 'glance' ? { capture: first, glance: true, commit: values.commit, ...reading } : { capture: values.capture, open: first, ...reading };
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

/** The daemon's first port is 7434, or wisdom.yaml's daemon.port; when another project's daemon
 * holds it, the next free pair is used (daemon.json says which). An explicit --port is used as given.
 */
async function runDaemon(dataDir: string, port: number | undefined, dashboard: boolean, first = 7434) {
  for (let candidate = port ?? first; ; candidate += 2) {
    try { return await startDaemon(dataDir, candidate, { dashboardPort: dashboard && candidate ? candidate + 1 : undefined }); }
    catch (error: any) { if (port !== undefined || error?.code !== 'EADDRINUSE' || candidate >= first + 40) throw error; }
  }
}

/** Make a folder a Wisdom project: its data folder, Wisdom's hooks in each installed
 * harness's home there, and a running daemon. Running it again repairs the hooks.
 */
async function init(project: string, values: any, port?: number): Promise<void> {
  const { dataDir, fresh, settings } = makeProject(project);
  console.log(fresh ? `Wisdom is set up in ${project}` : `Wisdom was already set up in ${project}. Its hooks and skills are refreshed.`);
  if (settings) console.log(settings);
  teamHooks(project, dataDir);
  const known = fresh ? undefined : movedFrom(dataDir);
  if (known) console.log(`This project moved from ${known}. Its recorded sessions follow it when the daemon starts.`);
  console.log('\nStart an agent:');
  const chosen = settingsOrDefaults(project);
  const found = installedHarnesses(values, project, chosen);
  const installed = (harness: Connectable, install: () => unknown, next: string) => {
    if (!harnessOn(chosen, harness)) { console.log(`  ${names[harness].padEnd(12)} off in ${SETTINGS_FILE}, so not set up.`); return; }
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

/** The handoff prompt as wisdom.yaml shows it: made by the code that makes every handoff's, with
 * example facts, so it can never differ from what is sent. */
function promptsShown(): string {
  const from = { captureId: 'SESSION-ID', harness: 'claude-code', status: 'ended', lastObservedAt: '', tokens: { total: 0 } };
  const facts = { turns: 4, changed: ['src/app.ts'], git: { branch: 'main', commit: '83b3a31', uncommitted: 1 }, extra: '<handoff.extra>' };
  const emitted = handoffPrompt(from, false, '', facts, true).split('\n');
  return shownAs('The handoff prompt Wisdom sends, with example facts (to read; not a setting):',
    handoffPrompt(from, false, '<your words>', facts))
    + shownAs('With --emit, it ends instead:', emitted.slice(emitted.indexOf('Only read: change no files and run nothing that changes anything, even if asked above.')).join('\n'))
    + shownAs('The commit guide prompt (Claude Code writer), up to its per-commit part (to read; not a setting):', guidePromptShown());
}

/** The guide writer's prompt for an example commit with no steps: its rules and shape, which
 * every commit's prompt starts with, cut before the commit's own items and evidence. */
function guidePromptShown(): string {
  const record = { kind: 'wisdom-commit-record', version: 1, made: 'now', madeAt: '', wisdomVersion: '', steps: [], files: [], sessions: [],
    commit: { sha: 'COMMIT', parent: undefined, committedAt: '', tree: '', subject: '<subject>' } } as unknown as CommitRecord;
  const lines = guidePrompt({} as SessionStore, record, true, '<guides.extra>').split('\n');
  return lines.slice(0, lines.indexOf('## Sessions')).join('\n').trimEnd();
}

/** Make a folder a Wisdom project: its data folder, marked, and kept out of git, since session
 * files and payloads are stored unredacted.
 */
function makeProject(project: string): { dataDir: string; fresh: boolean; settings: string | undefined } {
  if (!fs.existsSync(project)) throw new Error(`${project} does not exist`);
  const dataDir = path.join(project, '.wisdom');
  const fresh = !fs.existsSync(path.join(dataDir, marker));
  fs.mkdirSync(dataDir, { recursive: true });
  if (fresh) writeJson(path.join(dataDir, marker), { project, createdAt: new Date().toISOString() });
  ignoreDataFolder(project);
  const excluded = ignoreSettingsFile(project);
  const written = writeSettings(project, promptsShown());
  const settings = written === 'written' ? `Settings: ${SETTINGS_FILE}, every default shown and commented out.${excluded ? ' Git ignores it.' : ''}`
    : written === 'refreshed' ? `Settings: ${SETTINGS_FILE} shows this version's defaults now.`
    : written === 'kept' ? undefined
    : `Settings: ${written.invalid}. Until it is fixed, Wisdom uses its defaults.`;
  return { dataDir, fresh, settings };
}

/** In a team-mode repository, Wisdom's git hooks; in a local one, only the post-commit hook,
 * and only when the person turned guides on (wisdom guide on). Run again, it repairs them. */
function teamHooks(project: string, dataDir: string): void {
  try {
    const policy = readPolicy(project);
    if (!policy) {
      const old = oldPolicyNote(project);
      if (old) console.log(old);
      if (!guidesOn(dataDir, false)) return;
      const { dir } = installHooks(project, dataDir, LOCAL_HOOKS);
      console.log(`Guides after each commit are on (wisdom guide on): Wisdom's post-commit hook is in ${dir}. Turn it off with: wisdom guide off`);
      return;
    }
    const { dir, chained } = installHooks(project, dataDir);
    console.log(`Team mode: Wisdom's git hooks are in ${dir}${chained.length ? ` (your own ${chained.join(', ')} still ${chained.length === 1 ? 'runs' : 'run'} first)` : ''}. Turn them off with: wisdom team hooks off`);
    const waiting = policyCommands(policy).filter(command => !trusted(dataDir, command));
    if (waiting.length) console.log(`${POLICY_FILE} asks to run ${waiting.map(command => `\`${command}\``).join(' and ')} on this machine. `
      + 'Nothing runs until you read it and trust it: wisdom team trust');
  } catch (error) { console.log(`Wisdom's git hooks are not installed. ${error instanceof Error ? error.message : error}`); }
}

/** The harnesses that run here: each is asked for its version. */
function installedHarnesses(values: any, project: string, settings: Settings): Connectable[] {
  const programs: Record<Connectable, () => Command> = {
    'claude-code': () => resolveCommand(values['claude-bin'] ?? harnessPath(project, settings, 'claude-code') ?? 'claude'),
    codex: () => resolveCommand(values['codex-bin'] ?? harnessPath(project, settings, 'codex') ?? 'codex'),
    pi: () => piCommand(values['pi-entry'] ?? harnessPath(project, settings, 'pi')),
  };
  return (Object.keys(programs) as Connectable[]).filter(harness => harnessOn(settings, harness)).filter(harness => {
    try { const { command, args } = programs[harness](); execFileSync(command, [...args, '--version'], { windowsHide: true, stdio: 'ignore' }); return true; }
    catch { return false; }
  });
}

/** Record plain `claude`, `codex` and `pi` in this project with the person's own login. */
async function connectProject(project: string, values: any, port?: number): Promise<void> {
  const { dataDir, fresh, settings } = makeProject(project);
  teamHooks(project, dataDir);
  const chosen = settingsOrDefaults(project);
  const found = installedHarnesses(values, project, chosen);
  const result = connect(dataDir, found);
  console.log(`${fresh ? 'Wisdom is set up in' : 'Wisdom is connected in'} ${project}. Start your agent here as you always do, with your own login:\n`);
  const next: Record<Connectable, string> = {
    'claude-code': 'claude   (start it in this folder, not a subfolder)',
    codex: 'codex    (trust this project if it asks, then review Wisdom\'s hooks once in /hooks)',
    pi: 'pi       (start it in this folder, and trust this project when it asks)',
  };
  for (const harness of Object.keys(names) as Connectable[]) {
    const line = !harnessOn(chosen, harness)
      ? `off in ${SETTINGS_FILE}, so not set up.${result.kept.includes(harness) ? ' Its earlier connection was left as it was; wisdom disconnect removes all of Wisdom\'s.' : ''}`
      : result.connected.includes(harness) ? next[harness]
      : result.kept.includes(harness) ? `not found now, so its earlier connection was left as it was (git still ignores its files). Run wisdom connect again where ${harness === 'claude-code' ? 'claude' : harness} is on PATH to refresh it.`
      : !found.includes(harness) ? 'not installed. Run wisdom connect again after installing it.'
      : `not connected: git tracks ${path.relative(project, settingsFile(dataDir, harness, 'project'))}, and Wisdom will not put this machine's paths in it. Use wisdom track ${harness === 'claude-code' ? 'claude' : harness}.`;
    console.log(`  ${names[harness].padEnd(12)} ${line}`);
  }
  console.log(`\nWisdom added its hook${chosen.skill === false ? '' : ' and reading skill'} to: ${result.files.map(file => path.relative(project, file)).join(', ') || 'nothing'}.`);
  console.log(result.excluded ? 'They are listed in .git/info/exclude, so git ignores them and they never reach your teammates. wisdom disconnect removes them.'
    : 'This folder is not a git repository, so nothing was excluded from git. wisdom disconnect removes them.');
  await ensureDaemon(dataDir, port);
  if (settings) console.log(settings);
  console.log('Keep .wisdom/ private: it holds your sessions, unredacted. Git ignores it, but leave it out of zips and synced folders.');
}

/** Start a harness in this project. Tracked (`place` home), it runs with its home in the
 * project's data folder, whose hooks record it. Connected (`place` project), it runs with the
 * person's own home and login, and the project's settings record it. With `output`, it runs
 * in the background (see runHarness).
 */
async function track(harness: string | undefined, values: any, args: string[], dataDir: string, port?: number, env: Record<string, string> = {}, place: Place = 'home', output?: Output): Promise<number> {
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
  // Another installation: the flag, or else the one wisdom.yaml names.
  const project = path.dirname(path.resolve(dataDir));
  const chosen = settingsOrDefaults(project);
  const launch: Launch = harness === 'pi' ? launchPi({ entry: values['pi-entry'] ?? harnessPath(project, chosen, 'pi'), args, dataDir, place })
    : harness === 'claude' ? launchClaudeCode({ command: values['claude-bin'] ?? harnessPath(project, chosen, 'claude-code'), args, dataDir, cliPath, place })
    : harness === 'codex' ? await launchCodex({ command: values['codex-bin'] ?? harnessPath(project, chosen, 'codex'), args, dataDir, cliPath, cwd, setupHooks: values['setup-hooks'], trustAllHooks: values['trust-all-hooks'], place })
    : (() => { throw new Error('Use: wisdom track pi|claude|codex'); })();
  if (launch.setupOnly) console.error('Open /hooks in Codex, review and trust the Wisdom hooks, then quit and run wisdom track codex. '
    + 'Until they are trusted, sessions are read from their files only.');
  else {
    await ensureDaemon(dataDir, port);
    console.error(place === 'project' ? 'Wisdom records this session through the project\'s settings, with your own login.'
      : 'Wisdom is recording sessions in this harness home.');
  }
  // The ledger skill calls this installation's CLI from the project.
  const own = { ...env, ...launch.env, WISDOM_CLI_PATH: cliPath };
  return output ? runInBackground(launch, cwd, own, output) : runHarness(launch, cwd, { ...withoutCaller(process.env), ...own });
}

/** The session that ran this command keeps its WISDOM_SESSION: a harness started here is another session. */
function withoutCaller(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const { WISDOM_SESSION: _caller, ...rest } = env;
  return rest;
}

/** What to do with possible secrets: a flag, else wisdom.yaml's share.secrets, else ask. A choice
 * the file made is said, so nothing is redacted or kept without a line saying why. */
function secretsChoice(values: any, settings: Settings, found: number, say: (line: string) => void): { redact?: boolean; keep?: boolean } {
  if (values.redact || values['keep-secrets']) return { redact: values.redact, keep: values['keep-secrets'] };
  const chosen = settings.share?.secrets ?? 'ask';
  if (chosen !== 'ask' && found) say(chosen === 'redact' ? `Redacting them all, as ${SETTINGS_FILE} says (share.secrets: redact).` : `Keeping them as they are, as ${SETTINGS_FILE} says (share.secrets: keep).`);
  return { redact: chosen === 'redact', keep: chosen === 'keep' };
}

/** Write one file a teammate can read: chosen sessions, their evidence, no logins. What looks
 * like a secret is shown first, and is redacted in the file, kept, or the share cancelled.
 */
async function share(refs: string[], values: any, dataDir: string, port?: number): Promise<number> {
  if (!refs.length) throw new Error('Use: wisdom share SESSION... [--out FILE] [--redact | --keep-secrets]');
  if (values.redact && values['keep-secrets']) throw new Error('--redact and --keep-secrets are alternatives; choose one.');
  const chosen = settingsOrDefaults(path.dirname(path.resolve(dataDir)));
  const draft = await draftShare(await ensureDaemon(dataDir, port), refs);
  if (draft.findings.length) console.log(formatFindings(draft.findings));
  const prompt = process.stdin.isTTY ? createInterface({ input: process.stdin, output: process.stdout }) : undefined;
  let redact;
  try { redact = await chooseRedactions(draft.findings, secretsChoice(values, chosen, draft.findings.length, console.log), prompt && (question => prompt.question(question))); }
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
  const chosen = settingsOrDefaults(path.dirname(path.resolve(dataDir)));
  const findings = findSecrets([{ text: markdown, place }]);
  if (findings.length) console.error(formatFindings(findings));
  const prompt = process.stdin.isTTY ? createInterface({ input: process.stdin, output: process.stderr }) : undefined;
  let redact;
  try { redact = await chooseRedactions(findings, secretsChoice(values, chosen, findings.length, console.error), prompt && (question => prompt.question(question))); }
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

/** Continue work in another session that reads this one first: a new session in any harness,
 * or an existing one resumed, opened in this terminal. Emitted, it runs in the background instead
 * and changes nothing (each adapter's `background` holds it to reading); this command waits and
 * prints its reply, and stopping the wait (Ctrl+C) leaves it working. The work goes on in that
 * session later, with `wisdom resume`. A running session cannot take outside input, so for one
 * the prompt is printed to paste instead.
 */
async function handoff(target: string | undefined, values: any, words: string, dataDir: string, port?: number): Promise<number> {
  if (!target) throw new Error('Use: wisdom handoff claude|codex|pi|SESSION-ID [--from SESSION-ID] [--emit] ["what it should know"]');
  const connection = await ensureDaemon(dataDir, port);
  const emit = Boolean(values.emit);
  const plan = await planHandoff(connection, target, values.from, words, path.dirname(path.resolve(dataDir)), process.env.WISDOM_SESSION, emit);
  if (plan.target?.status === 'recording') {
    console.error(`Session ${plan.target.captureId} is still running, so Wisdom cannot start it. Paste this into it instead,`
      + ` or hand the work to a new session: wisdom handoff ${plan.command} --from ${plan.from.captureId}${emit ? ' --emit' : ''}\n`);
    console.log(plan.prompt);
    return 1;
  }
  if (plan.note) console.error(`Note: ${plan.note}`);
  const reads = `it reads ${plan.from.harness} session ${plan.from.captureId} first.`;
  console.error(emit ? `Handing off to ${plan.target ? `${plan.target.harness} session ${plan.target.captureId}` : `a new ${plan.command} session`}, in the background; ${reads}`
    : plan.target ? `Resuming ${plan.target.harness} session ${plan.target.captureId}; ${reads}` : `Starting a new ${plan.command} session; ${reads}`);
  // A resumed session continues in the home it ran in; a new one runs connected when this project is.
  const place = plan.target ? sessionPlace(dataDir, plan.target.harness, plan.targetSource)
    : hookState(dataDir, harnessByCommand[plan.command] as Connectable, 'project') === 'none' ? 'home' : 'project';
  if (!emit) return track(plan.command, { ...values, cwd: plan.cwd ?? values.cwd }, plan.args, dataDir, port, plan.env, place);
  const folder = path.join(dataDir, 'handoffs');
  fs.mkdirSync(folder, { recursive: true });
  const base = path.join(folder, plan.handoffId);
  const output = { reply: `${base}.txt`, log: `${base}.log`, code: `${base}.code`, spec: `${base}.json` };
  process.once('SIGINT', () => { console.error(`\nStopped waiting. The handoff goes on; its answer will be in ${output.reply}`); process.exit(130); });
  const code = await track(plan.command, { ...values, cwd: plan.cwd ?? values.cwd }, plan.args, dataDir, port, plan.env, place, output);
  if (code !== 0) {
    const last = fs.readFileSync(output.log, 'utf8').trim().split(/\r?\n/).at(-1);
    console.error(`Handoff failed: ${plan.command} exited with code ${code}${last ? `: ${last}` : ''}. Its log: ${output.log}`);
    return code;
  }
  // Its hooks report the session it ran in; without them Wisdom cannot say which it was.
  const session: string | undefined = plan.target?.captureId
    ?? await call(connection, '/resolve', { handoff: plan.handoffId }).then(found => found.captureId, () => undefined);
  const reply = fs.readFileSync(output.reply, 'utf8').trim();
  console.log(session ? `Handoff complete: ${plan.target ? `${plan.target.harness} session ${session} continued after` : `new ${plan.command} session ${session} continues`} ${plan.from.captureId}.`
    : `Handoff finished, but Wisdom has no record of it: ${plan.command}'s hooks did not report. Run: wisdom doctor`);
  if (reply) console.log(`\n${reply}`);
  if (session) console.log(`\nRead what it did: wisdom glance ${session}`);
  return 0;
}

/** A harness running in the background: what it prints (its answer), what it reports (its
 * log), its exit code, written last, and what to start, for the process that runs it. */
interface Output { reply: string; log: string; code: string; spec: string }

function runHarness(launch: Launch, cwd: string, env: NodeJS.ProcessEnv): Promise<number> {
  const child = spawn(launch.command, launch.args, { cwd, stdio: 'inherit', windowsHide: true, env });
  return new Promise((resolve, reject) => {
    child.once('error', reject); child.once('exit', code => resolve(code ?? 1));
  });
}

/** Start a harness in the background through `wisdom handoff-run`, in a process of its own that
 * is not this one's child: on Windows a terminal's Ctrl+C can end a command with every process
 * it started, detached or not (seen in VS Code's terminal). Started like the daemon, the harness
 * outlives this command, which only waits for its exit code. `env` is what Wisdom adds, never
 * the whole environment, since it is written to a file.
 */
async function runInBackground(launch: Launch, cwd: string, env: Record<string, string>, output: Output): Promise<number> {
  writeJson(output.spec, { command: launch.command, args: launch.args, cwd, env, reply: output.reply, log: output.log, code: output.code });
  startDetached([fileURLToPath(new URL('./cli.js', import.meta.url)), 'handoff-run', output.spec]);
  while (!fs.existsSync(output.code)) await new Promise(resolve => setTimeout(resolve, 250));
  return Number(fs.readFileSync(output.code, 'utf8'));
}

/** `wisdom handoff-run`: run one background harness, its output to files, then its exit code,
 * which the waiting `wisdom handoff --emit` reads. */
function runBackgroundHarness(specFile: string): Promise<void> {
  const spec = JSON.parse(fs.readFileSync(specFile, 'utf8'));
  fs.rmSync(specFile, { force: true });
  const files = [fs.openSync(spec.reply, 'w'), fs.openSync(spec.log, 'w')];
  const child = spawn(spec.command, spec.args, { cwd: spec.cwd, env: { ...withoutCaller(process.env), ...spec.env }, stdio: ['ignore', ...files], windowsHide: true });
  files.forEach(file => fs.closeSync(file));
  return new Promise(resolve => {
    const done = (code: number, why?: string) => { if (why) fs.appendFileSync(spec.log, `${why}\n`); fs.writeFileSync(spec.code, String(code)); resolve(); };
    child.once('error', error => done(1, String(error))); child.once('exit', code => done(code ?? 1));
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

/** The model a guide of this person's is written with: the team file's in team mode, else
 * wisdom.yaml's, else Haiku. */
function guideModel(project: string): string {
  const { model } = guideSettings(readPolicy(project), project);
  return model === DEFAULT_MODEL ? 'Claude Haiku 5.5' : model;
}

/** `wisdom team trust`: show the commands the team file runs on this machine, and trust them
 * only on a yes. With no terminal to ask in, nothing is trusted. */
async function trustTeamCommands(project: string, dataDir: string): Promise<number> {
  const policy = readPolicy(project);
  if (!policy) throw new Error(oldPolicyNote(project) ?? `This repository has no ${POLICY_FILE}, so it is in local mode and runs no team command.`);
  const commands = policyCommands(policy);
  if (!commands.length) { console.log(`${POLICY_FILE} runs no command on this machine, so there is nothing to trust.`); return 0; }
  const fresh = commands.filter(command => !trusted(dataDir, command));
  if (!fresh.length) { console.log(`Every command ${POLICY_FILE} runs here is trusted already:\n${commands.map(command => `  ${command}`).join('\n')}`); return 0; }
  console.log(`${POLICY_FILE} asks to run these on this machine, as you, through your shell:`);
  if (policy.check && fresh.includes(policy.check)) console.log(`  check (on each session before your push sends it):\n    ${policy.check}`);
  if (policy.guides?.command && fresh.includes(policy.guides.command)) console.log(`  guides.command (writes each commit's guide):\n    ${policy.guides.command}`);
  console.log('Anyone who can change that file can change these, so read them first. A script a command runs is not checked, only the command\'s text.');
  if (!process.stdin.isTTY) { console.log('Nothing trusted: run wisdom team trust in a terminal, where it can ask you.'); return 1; }
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  let answer: string;
  try { answer = (await prompt.question('Trust them? [y/N] ')).trim().toLowerCase(); }
  finally { prompt.close(); }
  if (answer !== 'y' && answer !== 'yes') { console.log('Nothing trusted. They do not run here until you trust them.'); return 1; }
  trustCommands(dataDir, fresh);
  console.log('Trusted, by their exact text, on this machine only. If one changes, it stops running until you run wisdom team trust again.');
  return 0;
}

/** guide, check and team. Settings change files here; sharing asks the daemon, which holds
 * the recordings and teammates' copies. */
async function teamCommand(command: string, args: string[], values: { remote?: string }, dataDir: string): Promise<number> {
  const project = path.dirname(dataDir);
  const [action, session] = args;
  if (command === 'guide') {
    if (!action) throw new Error('Use: wisdom guide on|off, or wisdom guide <commit> to have a model write one commit\'s guide now. A commit\'s guide is shown by wisdom glance --commit <commit>.');
    const team = !!readPolicy(project);
    if (action === 'on' || action === 'off') {
      setGuides(dataDir, action === 'on');
      if (team) {
        console.log(action === 'on' ? `A model writes the guides of your commits with agent work, reading their sessions since your previous commit (${guideModel(project)} through your Claude Code, unless wisdom-team.yaml names another writer).`
          : 'No model writes your commit guides: Wisdom writes a plain one from each commit\'s record, citing the steps that made it and quoting what was asked in their turns. It costs nothing and does not explain why beyond those requests.');
        return 0;
      }
      if (action === 'off') {
        const removed = removeHooks(project, LOCAL_HOOKS);
        console.log(`No model writes guides after your commits${removed.length ? '; Wisdom\'s post-commit hook is removed' : ''}. `
          + 'wisdom glance --commit still shows a plain guide built from the record, and wisdom guide <commit> writes a model guide on request.');
        return 0;
      }
      try {
        const { dir, chained } = installHooks(project, dataDir, LOCAL_HOOKS);
        console.log(`After each commit with agent work, a model now writes its guide (${guideModel(project)} through your Claude Code), reading its sessions since your previous commit. `
          + `Wisdom's post-commit hook is in ${dir}${chained.length ? ' (your own post-commit still runs first)' : ''}. `
          + 'Your commit messages are not changed, and nothing is pushed: guides stay in this clone\'s refs/wisdom. Turn it off with: wisdom guide off');
        return 0;
      } catch (error) {
        console.log(`Guides after each commit are on, but the hook that starts them is not installed. ${error instanceof Error ? error.message : error}`);
        return 1;
      }
    }
    const record = guideCommit(dataDir, action);
    const sha = record.commit.sha.slice(0, 12);
    console.log(`Guide written by ${record.guide!.writer} for ${sha} · ${record.guide!.problems.length ? `did not pass Wisdom's check: ${record.guide!.problems.join('; ')}` : 'it passed Wisdom\'s check'}.`);
    console.log(`Kept in refs/wisdom/records/${record.commit.sha}${team ? ', and sent with your next push' : ', on this machine only'}. Read it: wisdom glance --commit ${sha}`);
    return 0;
  }
  if (command === 'check') throw new Error('Use: wisdom check --range <base>..<head>, in CI. A commit\'s guide is written and checked by itself after the commit.');
  if (action === 'trust') return trustTeamCommands(project, dataDir);
  if (action === 'hooks') {
    if (session === 'off') { const removed = removeHooks(project); console.log(removed.length ? `Removed Wisdom's ${removed.join(', ')} hooks.` : 'Wisdom\'s git hooks were not installed.'); return 0; }
    if (session !== 'on') throw new Error('Use: wisdom team hooks on|off');
    if (!readPolicy(project)) throw new Error(`This repository has no ${POLICY_FILE}, so it is in local mode and needs no git hooks.`);
    const { dir, chained } = installHooks(project, dataDir);
    console.log(`Wisdom's git hooks are in ${dir}${chained.length ? `; your own ${chained.join(', ')} still run first` : ''}.`);
    return 0;
  }
  const connection = await ensureDaemon(dataDir);
  if (action === 'push') {
    const result = await call(connection, '/team', { action: 'push', remote: values.remote });
    for (const s of result.sessions) console.log(`session ${s.id}: ${s.state}${s.heldBack ? ' (tried again at each push)' : ''}`);
    console.log(`${result.records} commit record${result.records === 1 ? '' : 's'} pushed to ${result.remote}.${result.recordRedactions ? ` ${result.recordRedactions} possible secret${result.recordRedactions === 1 ? '' : 's'} redacted in them first.` : ''}`);
    if (result.missing.length) { console.log(`Not on ${result.remote} yet, so reviewers cannot open them: ${result.missing.join(', ')}`); return 1; }
    console.log('Ready: every session these records name is on the remote.');
    return 0;
  }
  if (action === 'fetch') {
    const result = await call(connection, '/team', { action: 'fetch', remote: values.remote });
    console.log(`${result.imported.length} teammate session${result.imported.length === 1 ? '' : 's'} updated, ${result.removed.length} removed by the team's deletion list, ${result.records} commit records here.`);
    if (result.notRemoved) console.log(`${result.notRemoved} removed teammate cop${result.notRemoved === 1 ? 'y is' : 'ies are'} still on disk (a file was in use). Wisdom deletes ${result.notRemoved === 1 ? 'it' : 'them'} at the next team fetch or when it starts.`);
    return 0;
  }
  if (action === 'delete') {
    if (!session) throw new Error('Use: wisdom team delete <session>');
    const result = await call(connection, '/team', { action: 'delete', session, remote: values.remote });
    console.log(`Deleted ${result.key} from the team remote and added it to the deletion list, so no clone pushes it back. Your own recording here is kept.`);
    return 0;
  }
  if (action === 'prune') {
    const result = await call(connection, '/team', { action: 'prune', remote: values.remote });
    console.log(result.removed.length ? `Removed ${result.removed.length} pushed sessions older than the policy keeps them.` : 'Nothing is older than the policy keeps.');
    return 0;
  }
  throw new Error('Use: wisdom team init|trust|hooks on|off|push|fetch|delete <session>|prune');
}
