import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

// Hooks import this module (through the commit gate), so it stays free of the database.
function writeJson(file: string, value: unknown): void {
  fs.writeFileSync(file + '.tmp', JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(file + '.tmp', file);
}

/** Wisdom's hidden git refs. Nothing here touches a branch, the index or the working tree:
 * each record or session version is its own small commit under `refs/wisdom/`, which git
 * keeps and pushes like any ref but never checks out.
 *
 * Locally:   refs/wisdom/records/<commit>             one record per commit
 *            refs/wisdom/sessions/<recorder>/<session> one append-only history per session
 *            refs/wisdom/deleted                       the team's deletion list
 * On the team's remote, the same under refs/wisdom/<repo-id>/, so one session repository can
 * serve several code repositories.
 */

export interface GitOptions { input?: string | Buffer; env?: NodeJS.ProcessEnv }

export function git(cwd: string, args: string[], options: GitOptions = {}): Buffer {
  return execFileSync('git', ['-c', 'core.quotepath=off', ...args], { cwd, windowsHide: true, maxBuffer: 512 * 1024 * 1024,
    input: options.input, env: options.env ? { ...process.env, ...options.env } : undefined, stdio: ['pipe', 'pipe', 'pipe'] });
}
export const gitText = (cwd: string, args: string[], options?: GitOptions) => git(cwd, args, options).toString('utf8').trim();

/** The message git printed when it failed, for a person to read. */
export function gitError(error: unknown): string {
  const stderr = (error as { stderr?: Buffer | string })?.stderr;
  const lines = String(stderr ?? (error instanceof Error ? error.message : error)).trim().split(/\r?\n/).filter(Boolean);
  const main = lines.find(line => /^(fatal|error): /.test(line)) ?? lines.at(-1) ?? 'git failed';
  return main.replace(/^(fatal|error): /, '').replace(/\.$/, '');
}

/** The repository's git folder and its shared folder (they differ in a linked worktree),
 * found by walking up from `cwd`. Undefined outside a repository. */
export function gitDirs(cwd: string): { gitDir: string; common: string } | undefined {
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    const dotGit = path.join(dir, '.git');
    if (fs.existsSync(dotGit)) {
      let gitDir = dotGit;
      if (fs.statSync(dotGit).isFile()) {
        const named = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotGit, 'utf8'))?.[1]?.trim();
        if (!named) return undefined;
        gitDir = path.resolve(dir, named);
      }
      const commonFile = path.join(gitDir, 'commondir');
      const common = fs.existsSync(commonFile) ? path.resolve(gitDir, fs.readFileSync(commonFile, 'utf8').trim()) : gitDir;
      return { gitDir, common };
    }
    if (path.dirname(dir) === dir) return undefined;
  }
}

/** HEAD's commit, read from git's own files without starting git, since the daemon asks every
 * second and starting a process each time would hold up hooks. `null` when the files are in a
 * shape this does not read (then ask git); undefined when there is no commit yet. */
export function readHead(cwd: string): string | null | undefined {
  try {
    const dirs = gitDirs(cwd);
    if (!dirs) return undefined;
    // Newer git can keep refs in a reftable instead of files; only git reads those.
    if (fs.existsSync(path.join(dirs.common, 'reftable'))) return null;
    const head = fs.readFileSync(path.join(dirs.gitDir, 'HEAD'), 'utf8').trim();
    if (/^[0-9a-f]{40}$/.test(head)) return head;
    const ref = /^ref:\s*(refs\/\S+)$/.exec(head)?.[1];
    if (!ref) return null;
    for (const base of [dirs.gitDir, dirs.common]) {
      const file = path.join(base, ...ref.split('/'));
      if (fs.existsSync(file)) { const sha = fs.readFileSync(file, 'utf8').trim(); return /^[0-9a-f]{40}$/.test(sha) ? sha : null; }
    }
    const packed = path.join(dirs.common, 'packed-refs');
    if (fs.existsSync(packed)) {
      for (const line of fs.readFileSync(packed, 'utf8').split('\n')) {
        const [sha, name] = line.trim().split(' ');
        if (name === ref && /^[0-9a-f]{40}$/.test(sha)) return sha;
      }
    }
    return undefined;
  } catch { return null; }
}

export function isRepo(cwd: string): boolean {
  try { return gitText(cwd, ['rev-parse', '--is-inside-work-tree']) === 'true'; } catch { return false; }
}

export function topLevel(cwd: string): string { return gitText(cwd, ['rev-parse', '--show-toplevel']); }

export function refExists(cwd: string, ref: string): boolean {
  try { git(cwd, ['rev-parse', '-q', '--verify', `${ref}^{commit}`]); return true; } catch { return false; }
}

export function resolve(cwd: string, ref: string): string | undefined {
  try { return gitText(cwd, ['rev-parse', '-q', '--verify', `${ref}^{commit}`]); } catch { return undefined; }
}

/** Refs under a prefix, with what they point to. */
export function listRefs(cwd: string, prefix: string): Map<string, string> {
  const out = gitText(cwd, ['for-each-ref', '--format=%(refname) %(objectname)', prefix]);
  return new Map(out ? out.split('\n').map(line => { const [ref, sha] = line.split(' '); return [ref, sha] as [string, string]; }) : []);
}

/** Who Wisdom's own commits are by: the person's git identity, else a plain placeholder.
 * Committer is always Wisdom, so these commits are never mistaken for code commits. */
function identityEnv(cwd: string): NodeJS.ProcessEnv {
  const config = (key: string) => { try { return gitText(cwd, ['config', key]); } catch { return ''; } };
  const name = config('user.name') || 'Wisdom', email = config('user.email') || 'wisdom@localhost';
  return { GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: 'Wisdom', GIT_COMMITTER_EMAIL: 'wisdom@localhost' };
}

/** A commit holding these files, on top of `parent` when given. */
export function commitFiles(cwd: string, files: Record<string, string | Buffer>, message: string, parent?: string): string {
  const entries = Object.entries(files).sort(([a], [b]) => a.localeCompare(b)).map(([name, content]) => {
    if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Error(`Unsafe file name for a Wisdom ref: ${name}`);
    return `100644 blob ${gitText(cwd, ['hash-object', '-w', '--stdin'], { input: content })}\t${name}`;
  });
  const tree = gitText(cwd, ['mktree'], { input: entries.join('\n') + '\n' });
  return gitText(cwd, ['commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', message], { env: identityEnv(cwd) });
}

export function readFile(cwd: string, ref: string, name: string): Buffer | undefined {
  try { return git(cwd, ['cat-file', 'blob', `${ref}:${name}`]); } catch { return undefined; }
}

export function setRef(cwd: string, ref: string, sha: string, old?: string): void {
  git(cwd, ['update-ref', ref, sha, ...(old ? [old] : [])]);
}

export function deleteRef(cwd: string, ref: string): void { try { git(cwd, ['update-ref', '-d', ref]); } catch { /* already gone */ } }

/** A name git accepts as one ref component. */
export const refSafe = (value: string) => value.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '_').replace(/\.lock$/, '_lock') || '_';

export const recordRef = (commit: string) => `refs/wisdom/records/${commit}`;
export const sessionRef = (key: string) => `refs/wisdom/sessions/${key}`;
export const remoteRef = (repoId: string, local: string) => local.replace(/^refs\/wisdom\//, `refs/wisdom/${repoId}/`);

// ---------- policy and recorder ----------

/** `wisdom-team.json`, committed at the repository's top: its presence is team mode. Without
 * it Wisdom is in local mode, and nothing is pushed, gated or checked. */
export interface Policy {
  version: 1;
  /** Names this repository's refs on the remote; made once by `wisdom team init`. */
  repoId: string;
  /** The remote sessions and records go to. Default `origin`. */
  remote?: string;
  /** Put the recorder's git name and email in each session it pushes (default true). */
  identity?: boolean;
  /** An agent's commit waits for a checked guide, and the PR check needs one (default true). */
  requireGuides?: boolean;
  /** `wisdom team prune` removes pushed sessions older than this many days. */
  retentionDays?: number;
  /** Prune keeps sessions a pushed record still points to (default true). */
  keepReferenced?: boolean;
  /** A command run on each session file before it is pushed, with the file's path as its
   * last argument. It may change the file; a non-zero exit stops that session's upload. */
  check?: string;
  /** Who writes commit guides. `model` defaults to Claude Haiku 5.5 through Claude Code;
   * `command` names any other writer: it reads the prompt on stdin, prints the guide, and
   * finds the model in WISDOM_GUIDE_MODEL. A person turns guides off with `wisdom guide off`. */
  guides?: { model?: string; command?: string };
}

/** Every `Wisdom-Record:` line in a commit's message, last first: a squash or a revert can
 * carry several, and the commit's own is the one added last. */
export function recordIds(cwd: string, commit: string): string[] {
  try {
    const message = gitText(cwd, ['log', '-1', '--format=%B', commit]);
    return [...message.matchAll(/^Wisdom-Record:\s*(r-[a-f0-9]{8,})\s*$/gm)].map(match => match[1]).reverse();
  } catch { return []; }
}

/** Local records whose `Wisdom-Record:` line is one of these, found by reading each record. */
export function recordsWithIds(cwd: string, ids: string[]): { commit: string; text: string }[] {
  if (!ids.length) return [];
  const found: { commit: string; text: string }[] = [];
  for (const [ref] of listRefs(cwd, 'refs/wisdom/records/')) {
    const bytes = readFile(cwd, ref, 'record.json');
    if (!bytes) continue;
    const text = bytes.toString('utf8');
    const id = /"recordId":\s*"([^"]+)"/.exec(text)?.[1];
    if (id && ids.includes(id)) found.push({ commit: ref.slice('refs/wisdom/records/'.length), text });
  }
  return found.sort((a, b) => ids.indexOf(/"recordId":\s*"([^"]+)"/.exec(a.text)![1]) - ids.indexOf(/"recordId":\s*"([^"]+)"/.exec(b.text)![1]));
}

export const POLICY_FILE = 'wisdom-team.json';

/** Whether a commit was made in team mode: its tree holds the policy file. Work committed
 * before team mode was turned on (local mode) stays private: its records are never pushed and
 * no guide is written for them at push time. The same answer on every clone. */
export function teamCommit(cwd: string, sha: string): boolean {
  try { git(cwd, ['cat-file', '-e', `${sha}:${POLICY_FILE}`]); return true; } catch { return false; }
}

export function readPolicy(cwd: string): Policy | undefined {
  let top: string;
  try { top = topLevel(cwd); } catch { return undefined; }
  const file = path.join(top, POLICY_FILE);
  if (!fs.existsSync(file)) return undefined;
  const policy = JSON.parse(fs.readFileSync(file, 'utf8')) as Policy;
  if (policy.version !== 1 || typeof policy.repoId !== 'string' || !/^[A-Za-z0-9._-]{8,}$/.test(policy.repoId)) {
    throw new Error(`${file} is not a Wisdom team policy this version reads (version 1, a repoId of 8+ letters, digits, . _ -).`);
  }
  return policy;
}

export function writePolicy(cwd: string): { file: string; policy: Policy; created: boolean } {
  const file = path.join(topLevel(cwd), POLICY_FILE);
  if (fs.existsSync(file)) return { file, policy: readPolicy(cwd)!, created: false };
  const policy: Policy = { version: 1, repoId: randomUUID(), remote: 'origin', identity: true, requireGuides: true, keepReferenced: true };
  fs.writeFileSync(file, JSON.stringify(policy, null, 2) + '\n');
  return { file, policy, created: true };
}

/** A random ID made once per data folder: whose sessions these are, without naming anyone. */
export function recorderId(dataDir: string): string {
  const file = path.join(dataDir, 'recorder.json');
  try { const id = JSON.parse(fs.readFileSync(file, 'utf8')).id; if (typeof id === 'string' && /^[a-f0-9-]{36}$/.test(id)) return id; } catch { /* made below */ }
  const id = randomUUID();
  fs.mkdirSync(dataDir, { recursive: true });
  writeJson(file, { id, createdAt: new Date().toISOString() });
  return id;
}

/** The person's git identity, labelled as such: git does not verify it. */
export function gitIdentity(cwd: string): { name: string; email: string; basis: 'git config' } | undefined {
  try {
    const name = gitText(cwd, ['config', 'user.name']), email = gitText(cwd, ['config', 'user.email']);
    return name || email ? { name, email, basis: 'git config' } : undefined;
  } catch { return undefined; }
}
