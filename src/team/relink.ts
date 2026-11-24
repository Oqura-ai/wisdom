import fs from 'node:fs';
import path from 'node:path';
import { FETCHED_RECORDS, git, gitError, gitText, patchId, readFile, recordRefs, recordText, remoteRef, topLevel, type Policy } from './gitrefs.js';
import { linkRef, pairCommits, parseCommitMap, readLink, writeLink, type CommitLink } from './links.js';
import { githubApi, type GitHubApi, type PullRequest } from './github.js';
import { FETCHED, fetchRefs, policyOrThrow, sessionKey } from './team.js';
import type { CommitRecord } from './commits.js';

/** `wisdom team relink`: write the links nobody could write when the rewrite happened, then send
 * them. Every link comes from something that proves it, never from a commit message:
 *
 *   --range A..B          each commit in the range with neither a record nor a link:
 *                         1. GitHub: the merged pull request that made it. One commit on main
 *                            for the pull request is a squash merge, linked to all its commits;
 *                            several are a rebase merge, paired one by one (links.ts pairCommits).
 *                            A pull request from a fork has its records and sessions copied
 *                            from the fork first.
 *                         2. Otherwise the same change (patch-id) as exactly one recorded commit
 *                            that is not on the branch: a rebase whose hooks did not run, or a
 *                            link that never left its clone.
 *   --commit-map FILE     git filter-repo's own list of old and new commits.
 *
 * Run by the CI job after each push to the default branch, or by anyone, later: GitHub keeps
 * `refs/pull/<n>/head`, so a missed run can be repaired. Needs no data folder.
 */

export interface RelinkResult { remote: string; lines: string[]; written: number; pushed: number }

const ZERO = /^0+$/;

/** The commits of `A..B`, oldest first, merges left out (a merge commit keeps the commits it
 * joins, so they need no link). A base that is all zeros (a new branch) or unknown here (a force
 * push) leaves just B. */
function rangeCommits(project: string, range: string, lines: string[]): string[] {
  if (range.startsWith('-') || !range.includes('..')) throw new Error(`"${range}" is not a range: use A..B.`);
  const [base, head] = range.split(/\.\.\.?/);
  const known = (rev: string) => { try { git(project, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`]); return true; } catch { return false; } };
  if (!known(head)) throw new Error(`${head} is not a commit here.`);
  if (!base || ZERO.test(base) || !known(base)) {
    lines.push(`${base || 'the base'} is not a commit here (a new branch, or a force push), so only ${head.slice(0, 12)} is looked at`);
    return gitText(project, ['rev-list', '--no-merges', '--max-count=1', head]).split('\n').filter(Boolean);
  }
  return gitText(project, ['rev-list', '--no-merges', '--reverse', `${base}..${head}`]).split('\n').filter(Boolean);
}

const singleParent = (project: string, sha: string) => gitText(project, ['log', '-1', '--format=%P', sha]).split(' ').filter(Boolean).length === 1;

function parseRecord(text: string | undefined): CommitRecord | undefined {
  try { return text ? JSON.parse(text) as CommitRecord : undefined; } catch { return undefined; }
}

/** Every record here by its commit's patch-id: the one stored in it, else worked out from the
 * commit when this clone has it. Commits in `skip` (on the branch itself) are left out. */
function recordsByPatchId(project: string, skip: Set<string>): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const [commit] of recordRefs(project)) {
    if (skip.has(commit)) continue;
    const id = parseRecord(recordText(project, commit))?.patchId ?? patchId(project, commit);
    if (id) (index.get(id) ?? index.set(id, []).get(id)!).push(commit);
  }
  return index;
}

/** A pull request from a fork: its contributor could push Wisdom's refs only to the fork. Copy
 * the records of its commits, and the sessions they name, into this repository's remote, sessions
 * first, so a record never names a session the remote lacks. Returns how many records came. */
function copyFromFork(project: string, remote: string, policy: Policy, pull: PullRequest, commits: string[], lines: string[]): number {
  const fork = pull.fork!;
  const base = `refs/wisdom/${policy.repoId}/`;
  let listed: Map<string, string>;
  try {
    const out = gitText(project, ['ls-remote', fork.cloneUrl, `${base}*`]);
    listed = new Map(out ? out.split('\n').map(line => { const [sha, ref] = line.split('\t'); return [ref, sha] as [string, string]; }) : []);
  } catch (error) { lines.push(`PR #${pull.number} came from the fork ${fork.fullName}, which could not be read: ${gitError(error)}`); return 0; }
  const wanted = commits.filter(commit => listed.has(`${base}records/${commit}`) && !readFile(project, `refs/wisdom/records/${commit}`, 'record.json'));
  if (!wanted.length) { lines.push(`PR #${pull.number} came from the fork ${fork.fullName}, which has no Wisdom records of its commits`); return 0; }
  git(project, ['fetch', '--no-tags', '--no-prune', '--quiet', fork.cloneUrl, ...wanted.map(commit => `+${base}records/${commit}:refs/wisdom/records/${commit}`)]);
  const keys = [...new Set(wanted.flatMap(commit => parseRecord(recordText(project, commit))?.sessions.filter(s => s.recorder).map(s => sessionKey(s.recorder!, s.id)) ?? []))]
    .filter(key => listed.has(`${base}sessions/${key}`));
  if (keys.length) {
    git(project, ['fetch', '--no-tags', '--no-prune', '--quiet', fork.cloneUrl, ...keys.map(key => `+${base}sessions/${key}:${FETCHED}${key}`)]);
    git(project, ['push', '--quiet', '--no-verify', remote, ...keys.map(key => `${FETCHED}${key}:${base}sessions/${key}`)]);
  }
  git(project, ['push', '--quiet', '--no-verify', remote, ...wanted.map(commit => `refs/wisdom/records/${commit}:${base}records/${commit}`)]);
  lines.push(`PR #${pull.number} came from the fork ${fork.fullName}: copied ${wanted.length} record${wanted.length === 1 ? '' : 's'} and ${keys.length} session${keys.length === 1 ? '' : 's'} to ${remote}`);
  return wanted.length;
}

/** Ask GitHub about the commits nobody linked, and link those a merged pull request made.
 * Returns the commits it linked. */
async function linkPullRequests(project: string, remote: string, policy: Policy, api: GitHubApi, open: string[], write: (link: Omit<CommitLink, 'kind' | 'version' | 'writtenAt' | 'writer'>) => void, lines: string[]): Promise<Set<string>> {
  const linked = new Set<string>();
  const byPull = new Map<number, { pull: PullRequest; mains: string[] }>();
  for (const sha of open) {
    let pulls: PullRequest[];
    try { pulls = await api.pullsForCommit(sha); }
    catch (error) { lines.push(`GitHub not asked further: ${error instanceof Error ? error.message : error}`); return linked; }
    const pull = pulls.find(p => p.merged);
    if (!pull) continue;
    (byPull.get(pull.number) ?? byPull.set(pull.number, { pull, mains: [] }).get(pull.number)!).mains.push(sha);
  }
  for (const [number, { pull, mains }] of byPull) {
    let commits: string[];
    try { commits = await api.pullCommits(number); }
    catch (error) { lines.push(`PR #${number}: its commits could not be listed: ${error instanceof Error ? error.message : error}`); continue; }
    // GitHub keeps every pull request's commits under refs/pull/<n>/head, after the merge too.
    try { git(project, ['fetch', '--no-tags', '--no-prune', '--quiet', remote, `refs/pull/${number}/head`]); }
    catch (error) { lines.push(`PR #${number}: refs/pull/${number}/head could not be fetched (${gitError(error)}), so only records already here are used`); }
    if (pull.fork) copyFromFork(project, remote, policy, pull, commits, lines);
    if (mains.length === 1 && singleParent(project, mains[0])) {
      write({ commit: mains[0], from: commits, how: 'squash-merge', basis: 'github', pr: number });
      linked.add(mains[0]);
      continue;
    }
    const pairs = pairCommits(mains.map(sha => ({ sha, patchId: patchId(project, sha) })), commits.map(sha => ({ sha, patchId: patchId(project, sha) })));
    let unpaired = 0;
    for (const pair of pairs) {
      if (!pair.pr) { unpaired++; continue; }
      write({ commit: pair.main, from: [pair.pr], how: 'rebase-merge', basis: pair.basis === 'order' ? 'order' : 'patch-id', pr: number });
      linked.add(pair.main);
    }
    if (unpaired) lines.push(`PR #${number}: ${unpaired} commit${unpaired === 1 ? '' : 's'} of its rebase merge could not be paired with its own commits, so ${unpaired === 1 ? 'it stays' : 'they stay'} unlinked`);
  }
  return linked;
}

export async function relink(cwd: string, options: { range?: string; commitMap?: string; remote?: string; env?: NodeJS.ProcessEnv }): Promise<RelinkResult> {
  const project = topLevel(cwd);
  const policy = policyOrThrow(project);
  const remote = options.remote ?? policy.remote ?? 'origin';
  const env = options.env ?? process.env;
  if (!options.range && !options.commitMap) throw new Error('Use: wisdom team relink --range <base>..<head>, or --commit-map <git filter-repo\'s commit-map file>');
  const writer = env.GITHUB_ACTIONS === 'true' ? 'github-actions' : 'wisdom team relink';
  fetchRefs(project, remote, policy);
  const lines: string[] = [];
  const written: string[] = [];
  const write = (link: Omit<CommitLink, 'kind' | 'version' | 'writtenAt' | 'writer'>) => {
    if (writeLink(project, { ...link, writer }) !== 'kept') written.push(link.commit);
  };

  if (options.commitMap) {
    let text: string;
    try { text = fs.readFileSync(options.commitMap, 'utf8'); } catch (error) { throw new Error(`Cannot read ${options.commitMap}: ${error instanceof Error ? error.message : error}`); }
    let count = 0;
    for (const [old, next] of parseCommitMap(text)) {
      // Only commits with something to point to: filter-repo lists Wisdom's own ref commits too.
      if (!recordText(project, old) && !readLink(project, old)) continue;
      write({ commit: next, from: [old], how: 'filter-repo', basis: 'commit-map' });
      count++;
    }
    lines.push(`${count} commit${count === 1 ? '' : 's'} linked from git filter-repo's commit map`);
  }

  if (options.range) {
    const commits = rangeCommits(project, options.range, lines);
    const open = commits.filter(sha => !recordText(project, sha) && !readLink(project, sha));
    lines.push(`${commits.length} commit${commits.length === 1 ? '' : 's'} in ${options.range}, ${open.length} with neither a record nor a link`);
    let left = open;
    if (open.length) {
      const api = githubApi(project, remote, env);
      if (api) {
        const done = await linkPullRequests(project, remote, policy, api, open, write, lines);
        left = open.filter(sha => !done.has(sha));
      } else lines.push(`GitHub not asked: ${remote} is not a GitHub remote and GITHUB_REPOSITORY is not set`);
    }
    if (left.length) {
      const onBranch = new Set(gitText(project, ['rev-list', '--max-count=5000', commits.at(-1)!]).split('\n'));
      const index = recordsByPatchId(project, onBranch);
      for (const sha of left) {
        const id = patchId(project, sha);
        const matches = id ? [...new Set(index.get(id) ?? [])] : [];
        if (matches.length === 1) write({ commit: sha, from: matches, how: 'rewrite', basis: 'patch-id' });
        else if (matches.length > 1) lines.push(`${sha.slice(0, 12)} is the same change as ${matches.length} recorded commits (${matches.map(m => m.slice(0, 12)).join(', ')}), so it is not linked to any`);
      }
    }
  }

  const refs = [...new Set(written)].map(linkRef);
  if (refs.length) {
    try { git(project, ['push', '--quiet', '--no-verify', remote, ...refs.map(ref => `${ref}:${remoteRef(policy.repoId, ref)}`)]); }
    catch (error) { throw new Error(`${refs.length} link${refs.length === 1 ? ' was' : 's were'} written here but could not be pushed to ${remote}: ${gitError(error)}. Run wisdom team relink again, or push them with: wisdom team push`); }
  }
  lines.push(`${refs.length} link${refs.length === 1 ? '' : 's'} written and pushed to ${remote}`);
  return { remote, lines, written: refs.length, pushed: refs.length };
}

// ---------- the CI job ----------

export const workflowFile = (project: string) => path.join(project, '.github', 'workflows', 'wisdom-relink.yml');

/** The GitHub Actions job that runs relink after every push to the default branch: the one place
 * that sees a squash or rebase merge GitHub made. */
export function workflowText(branch: string): string {
  return `# Wisdom: after each push to ${branch} (a merge included), link the commits GitHub made
# (squash and rebase merges) to the records of the pull request's commits. See docs/team.md#ci.
name: wisdom links
on:
  push:
    branches: [${JSON.stringify(branch)}]
permissions:
  contents: write        # to push Wisdom's link refs (refs/wisdom/...), never a branch
  pull-requests: read    # to ask which pull request made a commit
jobs:
  relink:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: actions/setup-node@v4
        with: { node-version: 24 }
      - run: npm install -g @oqura/wisdom
      - run: wisdom team relink --range "\${{ github.event.before }}..\${{ github.sha }}"
        env:
          GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}
`;
}

/** The remote's default branch as this clone knows it, else the branch checked out, else main. */
export function defaultBranch(project: string, remote = 'origin'): string {
  try { return gitText(project, ['symbolic-ref', '--short', `refs/remotes/${remote}/HEAD`]).replace(`${remote}/`, ''); } catch { /* not known */ }
  try { return gitText(project, ['symbolic-ref', '--short', 'HEAD']); } catch { return 'main'; }
}

/** Write the workflow file, never over one that is there. Returns the path, or undefined when kept. */
export function writeWorkflow(project: string, branch = defaultBranch(project)): string | undefined {
  const file = workflowFile(project);
  if (fs.existsSync(file)) return undefined;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, workflowText(branch));
  return file;
}

/** Whether `git pull` brings the team's links and records (wisdom team sync). */
export const syncSpecs = (policy: Policy) => [`+refs/wisdom/${policy.repoId}/links/*:refs/wisdom/fetched/links/*`, `+refs/wisdom/${policy.repoId}/records/*:${FETCHED_RECORDS}*`];

function fetchConfig(project: string, remote: string): string[] {
  try { return gitText(project, ['config', '--get-all', `remote.${remote}.fetch`]).split('\n').filter(Boolean); } catch { return []; }
}

export function syncOn(project: string, remoteName?: string): { remote: string; on: boolean } {
  const policy = policyOrThrow(project);
  const remote = remoteName ?? policy.remote ?? 'origin';
  const have = fetchConfig(project, remote);
  return { remote, on: syncSpecs(policy).every(spec => have.includes(spec)) };
}

/** `wisdom team sync on|off`: add to or take from the remote's fetch list in .git/config the two
 * lines that make `git fetch` and `git pull` bring the team's links and records, into their own
 * namespace (refs/wisdom/fetched/). Only those two lines are ever added or removed. Sessions are
 * not on the list: they are large, and come with `wisdom team fetch`. */
export function setSync(project: string, on: boolean, remoteName?: string): { remote: string; changed: boolean } {
  const policy = policyOrThrow(project);
  const remote = remoteName ?? policy.remote ?? 'origin';
  try { gitText(project, ['config', '--get', `remote.${remote}.url`]); }
  catch { throw new Error(`There is no remote named "${remote}" here. Name another with --remote, or set "remote" in wisdom-team.yaml.`); }
  const have = fetchConfig(project, remote);
  let changed = false;
  for (const spec of syncSpecs(policy)) {
    if (on && !have.includes(spec)) { git(project, ['config', '--add', `remote.${remote}.fetch`, spec]); changed = true; }
    if (!on && have.includes(spec)) { git(project, ['config', '--unset-all', '--fixed-value', `remote.${remote}.fetch`, spec]); changed = true; }
  }
  return { remote, changed };
}

