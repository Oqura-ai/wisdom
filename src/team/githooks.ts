import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { buildRecord } from '../read/discovery.js';
import { ReadStore } from '../storage/readstore.js';
import { startDetached } from '../service/client.js';
import { agentWork, readCommit, type CommitRecord } from './commits.js';
import { commitFiles, git, gitText, listRefs, oldPolicyNote, patchId, readFile, readPolicy, recordIds, recordRef, recorderId, resolve, setRef, teamCommit, type Policy } from './gitrefs.js';
import { writeGuide } from './writer.js';
import { guidesOn } from './guides.js';
import { problemSummary, writtenBy } from './plain.js';
import { push, pushHistory, pushLinks, type PushResult } from './team.js';
import { parseRewrites, writeLink } from './links.js';

/** What git gave the hook on stdin; empty when there is none. */
function readStdin(): string {
  try { return fs.readFileSync(0, 'utf8'); } catch { return ''; }
}

/** Team mode's git hooks, copying the infrastructure Entire proved, with four hooks:
 *
 *   prepare-commit-msg  adds `Wisdom-Record: r-…` to every commit message, a readable backup
 *                       link that can survive amend, rebase and a squash merge on the server
 *   post-commit         starts a background job that keeps the commit's record and has the
 *                       guide written; the commit itself never waits
 *   post-rewrite        after an amend or a rebase, keeps a link from each new commit to the
 *                       commits it came from, as git reports them (links.ts)
 *   pre-push            waits for those jobs, writes any guide still missing, then pushes the
 *                       links, the sessions and the records along with the person's own push
 *
 * They go into whatever folder git runs hooks from (core.hooksPath included). A hook already
 * there is kept and run first, as `<name>.pre-wisdom`. A hooks folder the repository tracks
 * (Husky's `.husky/`) is shared with the team, so Wisdom does not write into it. None of them
 * ever fails a commit or a push: CI is where a missing guide is enforced.
 *
 * In local mode there are none, unless the person runs `wisdom guide on`: then only
 * post-commit, so a model writes a guide after each commit. The commit message stays as it
 * is, and nothing is pushed: the record and its guide live in this clone's refs/wisdom.
 */

export const HOOKS = ['prepare-commit-msg', 'post-commit', 'post-rewrite', 'pre-push'] as const;
/** The one hook `wisdom guide on` installs in a local-mode repository. */
export const LOCAL_HOOKS = ['post-commit'] as const;
type HookName = typeof HOOKS[number];
const MARK = '# wisdom team-mode hook';
const bin = fileURLToPath(new URL('../bin.js', import.meta.url));
const unix = (file: string) => file.replaceAll('\\', '/');

export function hooksDir(project: string): string {
  return path.resolve(project, gitText(project, ['rev-parse', '--git-path', 'hooks']));
}

const ours = (file: string) => fs.existsSync(file) && fs.readFileSync(file, 'utf8').includes(MARK);

export function hooksInstalled(project: string): boolean {
  try { const dir = hooksDir(project); return HOOKS.every(name => ours(path.join(dir, name))); } catch { return false; }
}

/** Wisdom's post-commit hook keeps each commit's record (team mode, or local `wisdom guide on`). */
export function postCommitInstalled(project: string): boolean {
  try { return ours(path.join(hooksDir(project), 'post-commit')); } catch { return false; }
}

function script(name: string, dataDir: string): string {
  const call = `"${unix(process.execPath)}" "${unix(bin)}" githook ${name} --data "${unix(dataDir)}" "$@"`;
  // pre-push and post-rewrite read git's list on stdin; a chained hook gets it too, and so does
  // Wisdom: post-rewrite the old and new shas, pre-push the commits being pushed (policy 5.22).
  // Every other call reads nothing.
  const stdin = name === 'pre-push' || name === 'post-rewrite';
  const chain = stdin
    ? 'input=$(cat)\nif [ -x "$0.pre-wisdom" ]; then printf \'%s\\n\' "$input" | "$0.pre-wisdom" "$@" || exit $?; fi\n'
    : 'if [ -x "$0.pre-wisdom" ]; then "$0.pre-wisdom" "$@" || exit $?; fi\n';
  const run = stdin ? `printf '%s\\n' "$input" | ${call} || true` : `${call} </dev/null || true`;
  return `#!/bin/sh\n${MARK}: ${name}. Remove with: wisdom team hooks off (team mode) or wisdom guide off (local mode)\n${chain}${run}\nexit 0\n`;
}

export function installHooks(project: string, dataDir: string, names: readonly HookName[] = HOOKS): { dir: string; chained: string[] } {
  const dir = hooksDir(project);
  const inside = path.relative(project, dir);
  if (!inside.startsWith('..') && !path.isAbsolute(inside) && gitText(project, ['ls-files', '--', inside])) {
    throw new Error(`Git runs hooks from ${dir}, a folder this repository tracks (Husky, say), so Wisdom will not write into it. `
      + `Add these lines to its hooks instead: ${names.map(name => `${name}: ${script(name, dataDir).split('\n').find(line => line.includes('githook'))}`).join('; ')}`);
  }
  fs.mkdirSync(dir, { recursive: true });
  const chained: string[] = [];
  for (const name of names) {
    const file = path.join(dir, name);
    if (fs.existsSync(file) && !ours(file) && !fs.existsSync(`${file}.pre-wisdom`)) { fs.renameSync(file, `${file}.pre-wisdom`); chained.push(name); }
    fs.writeFileSync(file, script(name, dataDir), { mode: 0o755 });
  }
  return { dir, chained };
}

export function removeHooks(project: string, names: readonly HookName[] = HOOKS): string[] {
  const dir = hooksDir(project);
  const removed: string[] = [];
  for (const name of names) {
    const file = path.join(dir, name);
    if (!ours(file)) continue;
    fs.rmSync(file);
    if (fs.existsSync(`${file}.pre-wisdom`)) fs.renameSync(`${file}.pre-wisdom`, file);
    removed.push(name);
  }
  return removed;
}

// ---------- running them ----------

const jobsDir = (dataDir: string) => path.join(dataDir, 'jobs');
/** A job alive longer than this is stuck; one not started within JOB_START_MS never will be. */
const JOB_STALE_MS = 10 * 60_000;
const JOB_START_MS = 30_000;
/** How long `git push` waits for jobs still writing guides. */
const PUSH_WAIT_MS = 5 * 60_000;
/** A dead job is started again this many times in all; after that pre-push or `wisdom guide <commit>` finishes it. */
const MAX_ATTEMPTS = 3;
/** A record kept this long after its commit is labelled `later`. */
const LATE_MS = 2 * 60_000;

/** One commit's job, in `.wisdom/jobs/<sha>`: when it was started, how often, and, once its
 * process runs, that process's ID, so a job that died is told apart from one still running. */
export interface Job { sha: string; at: string; attempts: number; pid?: number;
  /** As they were at the commit (live tests 4.9, 6.3): the person's guide switch and the
   * policy's writer. Flipping either right after a commit does not change that commit's guide. */
  settings?: JobSettings }
export interface JobSettings { guides: boolean; writer?: Policy['guides'] }

/** The guide switch and writer now, for a job about to start. */
function settingsNow(project: string, dataDir: string): JobSettings {
  const policy = readPolicy(project);
  return { guides: guidesOn(dataDir, !!policy), ...(policy?.guides ? { writer: policy.guides } : {}) };
}

function readJob(dataDir: string, sha: string): Job | undefined {
  const file = path.join(jobsDir(dataDir), sha);
  let text: string;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return undefined; }
  try { const job = JSON.parse(text); if (job && typeof job.at === 'string') return { attempts: 1, ...job, sha }; } catch { /* the older form */ }
  // A job file written before 2026-11-13 holds only the time it was made.
  return { sha, at: text.trim() || new Date().toISOString(), attempts: 1 };
}

function writeJob(dataDir: string, job: Job): void {
  fs.mkdirSync(jobsDir(dataDir), { recursive: true });
  fs.writeFileSync(path.join(jobsDir(dataDir), job.sha), JSON.stringify(job));
}

const dropJob = (dataDir: string, sha: string) => fs.rmSync(path.join(jobsDir(dataDir), sha), { force: true });

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error: any) { return error?.code === 'EPERM'; }
}

/** The commit jobs here, running (its process is alive, or it is still starting) or dead (it
 * never started, its process is gone, or it is stuck). A dead job never holds anything up. */
export function jobs(dataDir: string): { running: Job[]; dead: Job[] } {
  const running: Job[] = [], dead: Job[] = [];
  const dir = jobsDir(dataDir);
  for (const sha of fs.existsSync(dir) ? fs.readdirSync(dir).filter(name => /^[0-9a-f]{40,64}$/.test(name)) : []) {
    const job = readJob(dataDir, sha);
    if (!job) continue;
    const age = Date.now() - Date.parse(job.at);
    (job.pid ? alive(job.pid) && age < JOB_STALE_MS : age < JOB_START_MS) ? running.push(job) : dead.push(job);
  }
  return { running, dead };
}

/** Start a commit's job, detached, so it outlives the commit, the agent's shell and its session. */
function startJob(dataDir: string, sha: string, attempts: number, settings?: JobSettings): void {
  writeJob(dataDir, { sha, at: new Date().toISOString(), attempts, ...(settings ? { settings } : {}) });
  startDetached([bin, 'githook', 'record', '--data', dataDir, sha]);
}

/** Start again each job that died, up to MAX_ATTEMPTS in all. Run after each commit and on the
 * daemon's timer. Past that, pre-push or `wisdom guide <commit>` keeps the record. */
export function retryJobs(dataDir: string): string[] {
  const retried: string[] = [];
  for (const job of jobs(dataDir).dead) if (job.attempts < MAX_ATTEMPTS) { startJob(dataDir, job.sha, job.attempts + 1, job.settings); retried.push(job.sha); }
  return retried;
}

/** One line per job in `.wisdom/jobs.log`, appended and closed at once, so jobs never block each other. */
function jobLine(dataDir: string, line: string): void {
  try { fs.appendFileSync(path.join(dataDir, 'jobs.log'), `${new Date().toISOString()} ${line}\n`); } catch { /* the log is a convenience */ }
}

function jobSummary(record: CommitRecord, started: number, how: string): string {
  const guide = record.guide;
  const written = guide ? `guide by ${writtenBy(guide)}, ${guide.problems.length ? `check: ${problemSummary(guide.problems)}` : 'check passed'}`
    + `${guide.seconds !== undefined ? `, writer ${guide.seconds} s` : ''}${guide.costUsd !== undefined ? `, $${guide.costUsd.toFixed(4)}` : ''}`
    : record.guideMissing ? `no guide: ${record.guideMissing}` : agentWork(record) ? 'no guide stored' : 'no guide (no agent work)';
  return `${record.commit.sha.slice(0, 12)} ${how} · record ${record.made === 'later' ? 'kept later' : 'kept'} · ${written} · ${Math.round((Date.now() - started) / 1000)} s`;
}

/** Store a commit's record as a new version of its ref, on top of the one before. */
function keepRecord(project: string, sha: string, record: CommitRecord): void {
  setRef(project, recordRef(sha), commitFiles(project, { 'record.json': JSON.stringify(record, null, 2) + '\n' },
    `wisdom record for ${sha}`, resolve(project, recordRef(sha))));
}

/** Keep the record for one commit, unless one is kept already, then have its guide written
 * and kept with it, unless it has one. `requested` (wisdom guide <commit>) has a model write the
 * guide even when one is there; `guide: false` keeps the record only. */
export function recordCommit(dataDir: string, sha: string, options: { requested?: boolean; guide?: boolean; settings?: JobSettings } = {}): CommitRecord {
  const project = path.dirname(dataDir);
  const current = readPolicy(project);
  // The writer as it was at the commit, when the job carries it.
  const policy = current && options.settings ? { ...current, guides: options.settings.writer } : current;
  const store = new ReadStore(dataDir);
  try {
    const kept = readFile(project, recordRef(sha), 'record.json');
    let record: CommitRecord;
    if (kept) record = JSON.parse(kept.toString('utf8')) as CommitRecord;
    else {
      const commit = readCommit(project, sha);
      const made = Date.now() - Date.parse(commit.committedAt) > LATE_MS ? 'later' : 'commit';
      record = buildRecord(store, store.database.revision, project, commit, { made, recorder: recorderId(dataDir) });
      // Only team mode adds the link line; in local mode a line in the message was carried
      // from another commit (a squash), and names that one.
      if (policy) record.recordId = recordIds(project, sha)[0];
      const id = patchId(project, sha);
      if (id) record.patchId = id;
      keepRecord(project, sha, record);
    }
    if (options.guide !== false && (options.requested || (!record.guide && !record.guideMissing))) {
      const { guide, missing } = writeGuide(store, record, dataDir, policy, options.requested, options.settings?.guides);
      if (guide || missing) { record.guide = guide; record.guideMissing = missing; keepRecord(project, sha, record); }
    }
    return record;
  } finally { store.close(); }
}

/** A commit this person made here: one parent, and git's committer email is theirs. */
function madeHere(project: string, sha: string): boolean {
  const [parents, committer] = gitText(project, ['log', '-1', '--format=%P%n%ce', sha]).split('\n');
  if (parents.trim().split(' ').filter(Boolean).length !== 1) return false;
  let me = '';
  try { me = gitText(project, ['config', 'user.email']); } catch { /* no identity set */ }
  return !me || committer === me;
}

/** `wisdom guide <commit>`: a model writes the guide of one commit now, from its kept record
 * and the window stored in it, in any mode. It replaces a guide already there, as a new
 * version of the record's ref. A commit of yours whose job after the commit died gets its
 * record kept now (`record kept later`). It refuses, and writes nothing, when the commit has
 * no record and is not yours, has no agent work, or a session it must read is no longer here. */
export function guideCommit(dataDir: string, ref: string): CommitRecord {
  const project = path.dirname(dataDir);
  let sha: string;
  try { sha = gitText(project, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]); } catch { throw new Error(`${ref} is not a commit here.`); }
  const short = sha.slice(0, 12);
  let bytes = readFile(project, recordRef(sha), 'record.json');
  if (!bytes && madeHere(project, sha) && jobs(dataDir).running.every(job => job.sha !== sha)) {
    recordCommit(dataDir, sha, { guide: false });
    dropJob(dataDir, sha);
    bytes = readFile(project, recordRef(sha), 'record.json');
  }
  if (!bytes) throw new Error(`No record was kept for ${short}: Wisdom keeps one for the commits you make while it records. `
    + `wisdom glance --commit ${short} works out its pieces now, but a guide needs the kept record and its window.`);
  const record = JSON.parse(bytes.toString('utf8')) as CommitRecord;
  if (!agentWork(record)) throw new Error(`${short} has no recorded agent work, so there is nothing for a guide to explain.`);
  const store = new ReadStore(dataDir);
  try {
    const here = new Set(store.database.manifests().map(m => m.captureId));
    const gone = record.sessions.filter(session => !here.has(session.id)).map(session => session.id);
    if (gone.length) throw new Error(`No guide written: the guide must read ${gone.length === 1 ? 'session' : 'sessions'} ${gone.join(', ')}, `
      + `which ${gone.length === 1 ? 'is' : 'are'} no longer recorded here (deleted, or made on another machine). The record stays as it is.`);
    const { guide, missing } = writeGuide(store, record, dataDir, readPolicy(project), true);
    if (!guide) throw new Error(`No guide written: ${missing ?? 'the writer gave none'}. The record stays as it is.`);
    record.guide = guide; delete record.guideMissing;
    keepRecord(project, sha, record);
    return record;
  } finally { store.close(); }
}

/** Keep the record and guide of each commit whose job died, here and now (pre-push). */
function finishDeadJobs(dataDir: string, log: (line: string) => void): void {
  for (const job of jobs(dataDir).dead) {
    const started = Date.now();
    try { jobLine(dataDir, jobSummary(recordCommit(dataDir, job.sha, { settings: job.settings }), started, 'finished at push (its job had died)')); }
    catch (error) { log(`Wisdom could not keep the record of ${job.sha.slice(0, 12)}: ${error instanceof Error ? error.message : error}`); }
    finally { dropJob(dataDir, job.sha); }
  }
}

/** Records reachable from HEAD that have agent work and neither a guide nor a reason for none,
 * and no job still writing one. */
/** Commits of `history` (the push's, pushHistory) whose record still has no guide. */
function waitingForGuides(project: string, running: string[], history: Set<string>): string[] {
  return [...listRefs(project, 'refs/wisdom/records/')].flatMap(([ref]) => {
    const commit = ref.slice('refs/wisdom/records/'.length);
    // Records of commits from before team mode was turned on are not pushed, so they get no guide here either.
    if (!history.has(commit) || running.includes(commit) || !teamCommit(project, commit)) return [];
    const bytes = readFile(project, ref, 'record.json');
    const record = bytes ? JSON.parse(bytes.toString('utf8')) as CommitRecord : undefined;
    return record && agentWork(record) && !record.guide && !record.guideMissing ? [commit] : [];
  });
}

const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// ---------- the links outbox ----------

/** Links a push could not send stay in this clone's refs: the outbox is simply "links here the
 * remote lacks". This file only says a retry is due, and which process is doing it, so the next
 * commit does not start a second one. */
const outboxFile = (dataDir: string) => path.join(dataDir, 'links-outbox.json');
/** `tips`: the commits of the pushes whose links wait (git's pre-push list), so the retry sends
 * only theirs; absent when a push had no list, and then the retry goes by HEAD. */
interface Outbox { since: string; cause: string; attempts: number; pid?: number; tips?: string[] }
/** How long the background retry waits before each attempt. */
const LINK_RETRY_MS = [30_000, 120_000, 600_000];

export function readOutbox(dataDir: string): Outbox | undefined {
  try { return JSON.parse(fs.readFileSync(outboxFile(dataDir), 'utf8')) as Outbox; } catch { return undefined; }
}

/** Note that links are waiting, and start the background retry unless one is running. `tips`:
 * the commits of the push whose links could not go, added to those already waiting. */
export function queueLinks(dataDir: string, cause: string, tips?: string[]): void {
  const before = readOutbox(dataDir);
  const all = before?.tips || tips ? [...new Set([...before?.tips ?? [], ...tips ?? []])] : undefined;
  if (before?.pid && alive(before.pid)) {
    // The retry running reads the file before each attempt: it takes these commits too.
    if (all && all.length !== (before.tips?.length ?? 0)) fs.writeFileSync(outboxFile(dataDir), JSON.stringify({ ...before, tips: all }));
    return;
  }
  fs.writeFileSync(outboxFile(dataDir), JSON.stringify({ since: before?.since ?? new Date().toISOString(), cause, attempts: before?.attempts ?? 0, ...(all ? { tips: all } : {}) }));
  startDetached([bin, 'githook', 'links', '--data', dataDir]);
}

/** What git's pre-push hook reads on stdin, one `<local ref> <local sha> <remote ref> <remote sha>`
 * per ref being pushed: the local commits pushed (a deleted ref gives none). Undefined when git
 * gave no list (nothing to update, or a hook installed before the list was passed on). */
export function parsePushed(input: string): string[] | undefined {
  const lines = input.split(/\r?\n/).map(line => line.trim().split(/\s+/)).filter(parts => parts.length >= 4 && /^[0-9a-f]{40,64}$/.test(parts[1]));
  if (!lines.length) return undefined;
  return [...new Set(lines.map(parts => parts[1]).filter(sha => !/^0+$/.test(sha)))];
}

/** One attempt to send the waiting links. Clears the outbox when nothing is left to send. */
export function sendQueuedLinks(dataDir: string): { sent: number } | { failed: string } {
  const project = path.dirname(dataDir);
  try {
    const { links } = pushLinks(project, undefined, readOutbox(dataDir)?.tips);
    fs.rmSync(outboxFile(dataDir), { force: true });
    jobLine(dataDir, `links outbox · ${links} link${links === 1 ? '' : 's'} sent`);
    return { sent: links };
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    const box = readOutbox(dataDir);
    if (box) fs.writeFileSync(outboxFile(dataDir), JSON.stringify({ ...box, cause, attempts: box.attempts + 1 }));
    jobLine(dataDir, `links outbox · not sent: ${cause}`);
    return { failed: cause };
  }
}

/** `wisdom githook <name>`: what each hook does. It never throws: a hook must not fail git.
 * `input` is what git gave the hook on stdin (post-rewrite's old and new shas, pre-push's refs
 * being pushed); read here when not given. */
export function runGitHook(name: string, args: string[], dataDir: string, log: (line: string) => void = line => process.stderr.write(line + '\n'), input?: string): void {
  const project = path.dirname(dataDir);
  try {
    // Local mode runs only what `wisdom guide on` installed: the job after each commit. A job
    // goes by the switch as it was at its commit.
    const snapshot = name === 'record' && args[0] ? readJob(dataDir, args[0])?.settings : undefined;
    if (!readPolicy(project) && !((name === 'post-commit' && guidesOn(dataDir, false)) || (name === 'record' && (snapshot?.guides ?? guidesOn(dataDir, false))))) {
      if (name === 'record' && args[0]) dropJob(dataDir, args[0]);
      // Hooks a 0.6.0-beta.0 team setup installed still run: say once per push why nothing goes.
      const old = name === 'pre-push' ? oldPolicyNote(project) : undefined;
      if (old) log(`Wisdom: ${old}`);
      return;
    }
    if (name === 'prepare-commit-msg') {
      const [file, source] = args;
      if (!file || source === 'merge') return;
      // An amend keeps its line: the record follows the commit through the rewrite.
      if (source === 'commit' && /^Wisdom-Record:/m.test(fs.readFileSync(file, 'utf8'))) return;
      git(project, ['interpret-trailers', '--in-place', '--if-exists', 'addIfDifferent', '--trailer', `Wisdom-Record: r-${randomBytes(6).toString('hex')}`, file]);
    } else if (name === 'post-commit') {
      startJob(dataDir, gitText(project, ['rev-parse', 'HEAD']), 1, settingsNow(project, dataDir));
      retryJobs(dataDir);
      // Links still waiting from an earlier push get another try, in the background.
      const box = readOutbox(dataDir);
      if (box && !(box.pid && alive(box.pid))) queueLinks(dataDir, box.cause);
    } else if (name === 'post-rewrite') {
      // git ran an amend or a rebase: each new commit, and the commits it came from, exactly.
      const how = args[0] === 'amend' ? 'amend' : 'rebase';
      const writer = recorderId(dataDir);
      let count = 0;
      for (const [commit, from] of parseRewrites(input ?? readStdin())) if (writeLink(project, { commit, from, how, basis: 'git', writer }) !== 'kept') count++;
      if (count) jobLine(dataDir, `post-rewrite (${how}) · ${count} link${count === 1 ? '' : 's'} kept`);
    } else if (name === 'links') {
      // The outbox's background retry: a few tries, further apart each time.
      const box = readOutbox(dataDir);
      if (!box) return;
      fs.writeFileSync(outboxFile(dataDir), JSON.stringify({ ...box, pid: process.pid }));
      for (const wait of LINK_RETRY_MS) {
        sleep(wait);
        // A push in the meantime sent them and cleared the outbox: nothing left to do.
        if (!readOutbox(dataDir)) return;
        if ('sent' in sendQueuedLinks(dataDir)) return;
      }
      const left = readOutbox(dataDir);
      if (left) fs.writeFileSync(outboxFile(dataDir), JSON.stringify({ ...left, pid: undefined }));
    } else if (name === 'record') {
      const sha = args[0];
      const started = Date.now();
      const job = readJob(dataDir, sha);
      writeJob(dataDir, { sha, at: job?.at ?? new Date().toISOString(), attempts: job?.attempts ?? 1, pid: process.pid, ...(job?.settings ? { settings: job.settings } : {}) });
      try { jobLine(dataDir, jobSummary(recordCommit(dataDir, sha, { settings: job?.settings }), started, job && job.attempts > 1 ? `job (attempt ${job.attempts})` : 'job')); }
      catch (error) { jobLine(dataDir, `${sha.slice(0, 12)} job failed after ${Math.round((Date.now() - started) / 1000)} s: ${error instanceof Error ? error.message : error}`); }
      finally { dropJob(dataDir, sha); }
    } else if (name === 'pre-push') {
      const [remote] = args;
      // Only the records of the commits being pushed go (policy 5.22), not all HEAD reaches.
      const tips = parsePushed(input ?? readStdin());
      // A commit whose job died gets its record and guide now; commits just made may still
      // have theirs being written (a guide that reads its sessions takes a minute or two).
      finishDeadJobs(dataDir, log);
      let running = jobs(dataDir).running;
      for (let waited = 0; running.length && waited < PUSH_WAIT_MS; waited += 250) {
        if (waited === 0) log(`Wisdom: waiting for ${running.length} commit guide${running.length === 1 ? '' : 's'} to be written…`);
        sleep(250);
        running = jobs(dataDir).running;
      }
      finishDeadJobs(dataDir, log);
      for (const sha of waitingForGuides(project, running.map(job => job.sha), pushHistory(project, tips))) recordCommit(dataDir, sha);
      const store = new ReadStore(dataDir);
      try {
        let result: PushResult;
        try { result = push(store, dataDir, remote, tips); }
        catch (error) {
          // The push stopped part way (the remote could not be reached, or refused the sessions).
          // Links go first, so they may be there already; one quick try says, and any still
          // waiting go to the outbox, retried in the background.
          if (listRefs(project, 'refs/wisdom/links/').size) {
            try { pushLinks(project, remote, tips); } catch (linkError) { queueLinks(dataDir, linkError instanceof Error ? linkError.message : String(linkError), tips); }
          }
          throw error;
        }
        log(`Wisdom: ${result.records} commit record${result.records === 1 ? '' : 's'}${result.links ? `, ${result.links} commit link${result.links === 1 ? '' : 's'}` : ''} and ${result.sessions.filter(s => s.state.startsWith('new')).length} session version(s) sent to ${result.remote}.`
          + (result.recordRedactions ? ` ${result.recordRedactions} possible secret${result.recordRedactions === 1 ? '' : 's'} redacted in the records first.` : '')
          + (result.missing.length ? ` Not on the remote, so reviewers cannot open them: ${result.missing.join(', ')}` : ''));
        const held = result.sessions.filter(s => s.heldBack);
        if (held.length) log(`Wisdom: held back ${held.map(s => `${s.id.slice(0, 8)} (${s.heldBack})`).join(', ')}; it is tried again at each push.`);
        if (result.linksFailed) {
          log(`Wisdom: commit links not sent (${result.linksFailed}); retrying in the background. Your push is not affected.`);
          queueLinks(dataDir, result.linksFailed, tips);
        } else if (readOutbox(dataDir)) fs.rmSync(outboxFile(dataDir), { force: true });
      } finally { store.close(); }
    }
  } catch (error) {
    log(`Wisdom could not run its ${name} hook: ${error instanceof Error ? error.message : error}. Your ${name.startsWith('pre-push') ? 'push' : 'commit'} is not affected.`);
  }
}
