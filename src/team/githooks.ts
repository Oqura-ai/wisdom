import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { buildRecord } from '../read/discovery.js';
import { ReadStore } from '../storage/readstore.js';
import { startDetached } from '../service/client.js';
import { agentWork, readCommit, type CommitRecord } from './commits.js';
import { commitFiles, git, gitText, listRefs, readFile, readPolicy, recordIds, recordRef, recorderId, resolve, setRef } from './gitrefs.js';
import { writeGuide } from './writer.js';
import { push } from './team.js';

/** Team mode's git hooks, copying the infrastructure Entire proved, with three hooks, not five:
 *
 *   prepare-commit-msg  adds `Wisdom-Record: r-…` to every commit message, so the link
 *                       survives amend, rebase and a squash merge on the server
 *   post-commit         starts a background job that keeps the commit's record and has the
 *                       guide written; the commit itself never waits
 *   pre-push            waits for those jobs, writes any guide still missing, then pushes the
 *                       sessions and records along with the person's own push
 *
 * They go into whatever folder git runs hooks from (core.hooksPath included). A hook already
 * there is kept and run first, as `<name>.pre-wisdom`. A hooks folder the repository tracks
 * (Husky's `.husky/`) is shared with the team, so Wisdom does not write into it. None of them
 * ever fails a commit or a push: CI is where a missing guide is enforced.
 */

export const HOOKS = ['prepare-commit-msg', 'post-commit', 'pre-push'] as const;
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

function script(name: string, dataDir: string): string {
  const call = `"${unix(process.execPath)}" "${unix(bin)}" githook ${name} --data "${unix(dataDir)}" "$@"`;
  // pre-push reads the refs being pushed on stdin; a chained hook gets them too.
  const chain = name === 'pre-push'
    ? 'input=$(cat)\nif [ -x "$0.pre-wisdom" ]; then printf \'%s\\n\' "$input" | "$0.pre-wisdom" "$@" || exit $?; fi\n'
    : 'if [ -x "$0.pre-wisdom" ]; then "$0.pre-wisdom" "$@" || exit $?; fi\n';
  return `#!/bin/sh\n${MARK}: ${name}. Remove with: wisdom team hooks off\n${chain}${call} </dev/null || true\nexit 0\n`;
}

export function installHooks(project: string, dataDir: string): { dir: string; chained: string[] } {
  const dir = hooksDir(project);
  const inside = path.relative(project, dir);
  if (!inside.startsWith('..') && !path.isAbsolute(inside) && gitText(project, ['ls-files', '--', inside])) {
    throw new Error(`Git runs hooks from ${dir}, a folder this repository tracks (Husky, say), so Wisdom will not write into it. `
      + `Add these lines to its hooks instead: ${HOOKS.map(name => `${name}: ${script(name, dataDir).split('\n').find(line => line.includes('githook'))}`).join('; ')}`);
  }
  fs.mkdirSync(dir, { recursive: true });
  const chained: string[] = [];
  for (const name of HOOKS) {
    const file = path.join(dir, name);
    if (fs.existsSync(file) && !ours(file) && !fs.existsSync(`${file}.pre-wisdom`)) { fs.renameSync(file, `${file}.pre-wisdom`); chained.push(name); }
    fs.writeFileSync(file, script(name, dataDir), { mode: 0o755 });
  }
  return { dir, chained };
}

export function removeHooks(project: string): string[] {
  const dir = hooksDir(project);
  const removed: string[] = [];
  for (const name of HOOKS) {
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
const JOB_STALE_MS = 5 * 60_000;

/** Keep the record for one commit, then have its guide written and kept with it. */
export function recordCommit(dataDir: string, sha: string): CommitRecord {
  const project = path.dirname(dataDir);
  const store = new ReadStore(dataDir);
  try {
    const commit = readCommit(project, sha);
    const record = buildRecord(store, store.database.revision, project, commit, { made: 'commit', recorder: recorderId(dataDir) });
    record.recordId = recordIds(project, sha)[0];
    const keep = (value: CommitRecord) => setRef(project, recordRef(sha),
      commitFiles(project, { 'record.json': JSON.stringify(value, null, 2) + '\n' }, `wisdom record for ${sha}`, resolve(project, recordRef(sha))));
    keep(record);
    const { guide, missing } = writeGuide(store, record, dataDir, readPolicy(project));
    if (guide || missing) { record.guide = guide; record.guideMissing = missing; keep(record); }
    return record;
  } finally { store.close(); }
}

/** Records reachable from HEAD that have agent work and neither a guide nor a reason for none. */
function waitingForGuides(project: string): string[] {
  const history = new Set(gitText(project, ['rev-list', '--max-count=2000', 'HEAD']).split('\n'));
  return [...listRefs(project, 'refs/wisdom/records/')].flatMap(([ref]) => {
    const commit = ref.slice('refs/wisdom/records/'.length);
    if (!history.has(commit)) return [];
    const bytes = readFile(project, ref, 'record.json');
    const record = bytes ? JSON.parse(bytes.toString('utf8')) as CommitRecord : undefined;
    return record && agentWork(record) && !record.guide && !record.guideMissing ? [commit] : [];
  });
}

const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** `wisdom githook <name>`: what each hook does. It never throws: a hook must not fail git. */
export function runGitHook(name: string, args: string[], dataDir: string, log: (line: string) => void = line => process.stderr.write(line + '\n')): void {
  const project = path.dirname(dataDir);
  try {
    if (!readPolicy(project)) return;
    if (name === 'prepare-commit-msg') {
      const [file, source] = args;
      if (!file || source === 'merge') return;
      // An amend keeps its line: the record follows the commit through the rewrite.
      if (source === 'commit' && /^Wisdom-Record:/m.test(fs.readFileSync(file, 'utf8'))) return;
      git(project, ['interpret-trailers', '--in-place', '--if-exists', 'addIfDifferent', '--trailer', `Wisdom-Record: r-${randomBytes(6).toString('hex')}`, file]);
    } else if (name === 'post-commit') {
      const sha = gitText(project, ['rev-parse', 'HEAD']);
      fs.mkdirSync(jobsDir(dataDir), { recursive: true });
      fs.writeFileSync(path.join(jobsDir(dataDir), sha), new Date().toISOString());
      startDetached([bin, 'githook', 'record', '--data', dataDir, sha], path.join(dataDir, 'jobs.log'));
    } else if (name === 'record') {
      try { recordCommit(dataDir, args[0]); } finally { fs.rmSync(path.join(jobsDir(dataDir), args[0]), { force: true }); }
    } else if (name === 'pre-push') {
      const [remote] = args;
      // Commits just made may still have their record or guide being written.
      for (let waited = 0; waited < 120_000; waited += 250) {
        const running = fs.existsSync(jobsDir(dataDir)) ? fs.readdirSync(jobsDir(dataDir))
          .filter(job => Date.now() - fs.statSync(path.join(jobsDir(dataDir), job)).mtimeMs < JOB_STALE_MS) : [];
        if (!running.length) break;
        if (waited === 0) log(`Wisdom: waiting for ${running.length} commit guide${running.length === 1 ? '' : 's'} to be written…`);
        sleep(250);
      }
      for (const sha of waitingForGuides(project)) recordCommit(dataDir, sha);
      const store = new ReadStore(dataDir);
      try {
        const result = push(store, dataDir, remote);
        log(`Wisdom: ${result.records} commit record${result.records === 1 ? '' : 's'} and ${result.sessions.filter(s => s.state.startsWith('new')).length} session version(s) sent to ${result.remote}.`
          + (result.missing.length ? ` Not on the remote, so reviewers cannot open them: ${result.missing.join(', ')}` : ''));
      } finally { store.close(); }
    }
  } catch (error) {
    log(`Wisdom could not run its ${name} hook: ${error instanceof Error ? error.message : error}. Your ${name.startsWith('pre-push') ? 'push' : 'commit'} is not affected.`);
  }
}
