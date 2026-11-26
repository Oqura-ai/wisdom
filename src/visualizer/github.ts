/**
 * What the Commits build asks GitHub, gathered before the build so the builder itself stays
 * plain and synchronous: the details of the pull requests main's line names (through merge
 * messages and commit links), the open ones, and the username behind each of their commits.
 *
 * Every question goes through team/github.ts. One that fails is skipped and said: the builder
 * then falls back to what git has (a merge message's title, a git author name).
 */
import { git } from '../team/gitrefs.js';
import { readLink } from '../team/links.js';
import type { GitHubApi, PullDetail } from '../team/github.js';

export interface GitHubFacts {
  pulls: Map<number, PullDetail>;
  open: PullDetail[];
  /** A commit's GitHub username, by its sha: the only way to name a squashed-away commit's author. */
  loginBySha: Map<string, string>;
  /** A git email's GitHub username, learnt from pull requests' commits: names the same person's other commits. Never shown. */
  loginByEmail: Map<string, string>;
  warnings: string[];
}

/** Pull requests asked about, newest first: enough for every page of main a team reads. */
export const PULL_LIMIT = 200;

export async function gatherGitHub(api: GitHubApi, project: string, mainRef: string, limit = PULL_LIMIT): Promise<GitHubFacts> {
  const facts: GitHubFacts = { pulls: new Map(), open: [], loginBySha: new Map(), loginByEmail: new Map(), warnings: [] };
  const numbers: number[] = [];
  let line: string[] = [];
  try { line = git(project, ['log', '--first-parent', '--format=%H%x1f%s', mainRef]).toString('utf8').split('\n').filter(Boolean); } catch { line = []; }
  for (const entry of line) {
    if (numbers.length >= limit) break;
    const [sha, subject] = entry.split('\x1f');
    const n = Number(/^Merge pull request #(\d+) /.exec(subject)?.[1] ?? readLink(project, sha)?.pr ?? 0);
    if (n && !numbers.includes(n)) numbers.push(n);
  }
  const ask = async <T>(what: string, question: () => Promise<T>): Promise<T | undefined> => {
    try { return await question(); } catch (error) { facts.warnings.push(`${what}: ${error instanceof Error ? error.message : error}`); return undefined; }
  };
  facts.open = await ask('open pull requests', () => api.openPulls()) ?? [];
  const all = [...numbers, ...facts.open.map(pull => pull.number).filter(n => !numbers.includes(n))];
  // A few at a time: GitHub limits how fast one token may ask.
  for (let start = 0; start < all.length; start += 8) {
    await Promise.all(all.slice(start, start + 8).map(async n => {
      const pull = facts.open.find(p => p.number === n) ?? await ask(`pull request #${n}`, () => api.pull(n));
      if (pull) facts.pulls.set(n, pull);
      for (const commit of await ask(`pull request #${n}'s commits`, () => api.pullAuthors(n)) ?? []) {
        if (!commit.login) continue;
        facts.loginBySha.set(commit.sha, commit.login);
        if (commit.email) facts.loginByEmail.set(commit.email.toLowerCase(), commit.login);
      }
    }));
  }
  return facts;
}
