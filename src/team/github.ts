import { gitText } from './gitrefs.js';

/** The one place Wisdom asks GitHub anything: which pull request made a commit on the default
 * branch, and which commits that pull request had (`wisdom team relink`, in the CI job after a
 * merge, where no git hook on anyone's machine saw GitHub squash or rebase the work); and, for
 * the Commits build in CI, each pull request's title, state, branch and author, the open ones,
 * and the GitHub username behind each of their commits (usernames only, policy: never an email
 * in what is shown). Read-only but for one write: the check run `wisdom check` posts on a pull
 * request (postCheckRun). Another forge (GitLab) would be another module with the same questions.
 *
 * Where: GITHUB_API_URL (GitHub Enterprise, or a test's stand-in), else api.github.com.
 * Which repository: GITHUB_REPOSITORY (set in GitHub Actions), else the remote's URL.
 * Token: GITHUB_TOKEN or GH_TOKEN; a public repository answers without one, rate limited.
 */

export interface PullRequest {
  number: number;
  merged: boolean;
  /** The commit GitHub made when merging (the squash commit, or the last commit of a rebase merge). */
  mergeCommit?: string;
  /** Where its commits were pushed from, when that is not this repository (a fork). */
  fork?: { fullName: string; cloneUrl: string };
}

/** A pull request as the Commits dashboard shows it. */
export interface PullDetail {
  number: number;
  title: string;
  state: 'open' | 'merged' | 'closed';
  /** The GitHub username that opened it. */
  author: string;
  /** Its head branch's name, and whether that branch is in a fork. */
  branch: string; fork: boolean;
  mergedAt?: string;
}

/** Who made one of a pull request's commits on GitHub: the username, and the email git has for
 * it (used only to put a username on the same person's other commits, never shown). */
export interface PullAuthor { sha: string; login?: string; email?: string }

export interface GitHubApi {
  repository: string;
  /** The pull requests GitHub associates with a commit (merged into the default branch). */
  pullsForCommit(sha: string): Promise<PullRequest[]>;
  /** A pull request's commits, oldest first (GitHub lists at most 250). */
  pullCommits(number: number): Promise<string[]>;
  /** A pull request's commits with who made them on GitHub, oldest first (at most 250). */
  pullAuthors(number: number): Promise<PullAuthor[]>;
  pull(number: number): Promise<PullDetail>;
  /** The open pull requests, newest first (at most 300). */
  openPulls(): Promise<PullDetail[]>;
}

function detail(pull: any, repository: string): PullDetail {
  const headRepo = pull.head?.repo?.full_name;
  return { number: Number(pull.number), title: String(pull.title ?? ''), state: pull.merged_at ? 'merged' : pull.state === 'open' ? 'open' : 'closed',
    author: String(pull.user?.login ?? ''), branch: String(pull.head?.ref ?? ''), fork: !!headRepo && headRepo !== repository,
    ...(pull.merged_at ? { mergedAt: String(pull.merged_at) } : {}) };
}

/** owner/name from a GitHub remote URL (https, ssh, or git@host:owner/name). */
export function repositoryFromUrl(url: string): string | undefined {
  const match = /github\.com[:/]+([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(url.trim());
  return match ? `${match[1]}/${match[2]}` : undefined;
}

export function githubApi(cwd: string, remote: string, env: NodeJS.ProcessEnv = process.env): GitHubApi | undefined {
  let repository = env.GITHUB_REPOSITORY;
  if (!repository) {
    try { repository = repositoryFromUrl(gitText(cwd, ['remote', 'get-url', remote])); } catch { repository = undefined; }
  }
  if (!repository || !/^[^/\s]+\/[^/\s]+$/.test(repository)) return undefined;
  const base = (env.GITHUB_API_URL || 'https://api.github.com').replace(/\/+$/, '');
  const token = env.GITHUB_TOKEN || env.GH_TOKEN;
  const get = async (route: string): Promise<any> => {
    const response = await fetch(`${base}/repos/${repository}${route}`, {
      headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'wisdom-relink',
        ...(token ? { authorization: `Bearer ${token}` } : {}) },
    });
    if (!response.ok) throw new Error(`GitHub answered ${response.status} for ${route}${response.status === 401 || response.status === 403 || response.status === 404 ? ' (is GITHUB_TOKEN set, with pull-requests: read?)' : ''}`);
    return response.json();
  };
  return {
    repository,
    async pullsForCommit(sha) {
      const pulls = await get(`/commits/${sha}/pulls`) as any[];
      return pulls.map(pull => {
        const head = pull.head?.repo;
        const fork = head && head.full_name && head.full_name !== repository ? { fullName: String(head.full_name), cloneUrl: String(head.clone_url) } : undefined;
        return { number: Number(pull.number), merged: !!pull.merged_at, ...(pull.merge_commit_sha ? { mergeCommit: String(pull.merge_commit_sha) } : {}), ...(fork ? { fork } : {}) };
      });
    },
    async pullCommits(number) {
      return (await this.pullAuthors(number)).map(commit => commit.sha);
    },
    async pullAuthors(number) {
      const found: PullAuthor[] = [];
      for (let page = 1; page <= 3; page++) {
        const commits = await get(`/pulls/${number}/commits?per_page=100&page=${page}`) as any[];
        found.push(...commits.map(commit => ({ sha: String(commit.sha), ...(commit.author?.login ? { login: String(commit.author.login) } : {}),
          ...(commit.commit?.author?.email ? { email: String(commit.commit.author.email) } : {}) })));
        if (commits.length < 100) break;
      }
      return found;
    },
    async pull(number) {
      return detail(await get(`/pulls/${number}`), repository);
    },
    async openPulls() {
      const found: PullDetail[] = [];
      for (let page = 1; page <= 3; page++) {
        const pulls = await get(`/pulls?state=open&per_page=100&page=${page}`) as any[];
        found.push(...pulls.map(pull => detail(pull, repository)));
        if (pulls.length < 100) break;
      }
      return found;
    },
  };
}

/** What `wisdom check` reports on a pull request (GitHub's check run): a title, a summary and
 * text in Markdown, and where Details leads. */
export interface CheckRun { name: string; headSha: string; ok: boolean; title: string; summary: string; text?: string; detailsUrl?: string }

/** Post a check run on a commit (the only thing Wisdom ever writes through GitHub's API). Needs
 * a token with `checks: write`; a fork's pull request gets a read-only one, and is refused. */
export async function postCheckRun(cwd: string, remote: string, run: CheckRun, env: NodeJS.ProcessEnv = process.env): Promise<{ url?: string }> {
  let repository = env.GITHUB_REPOSITORY;
  if (!repository) {
    try { repository = repositoryFromUrl(gitText(cwd, ['remote', 'get-url', remote])); } catch { repository = undefined; }
  }
  if (!repository) throw new Error(`${remote} is not a GitHub repository, and GITHUB_REPOSITORY is not set`);
  const token = env.GITHUB_TOKEN || env.GH_TOKEN;
  if (!token) throw new Error('no GITHUB_TOKEN to post with');
  const base = (env.GITHUB_API_URL || 'https://api.github.com').replace(/\/+$/, '');
  // GitHub's limits on a check run's output.
  const cut = (text: string, max: number) => text.length > max ? `${text.slice(0, max - 40)}\n\n… cut at GitHub's limit; the job log has all of it.` : text;
  const response = await fetch(`${base}/repos/${repository}/check-runs`, {
    method: 'POST',
    headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'wisdom-check', authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      name: run.name, head_sha: run.headSha, status: 'completed', conclusion: run.ok ? 'success' : 'failure',
      ...(run.detailsUrl ? { details_url: run.detailsUrl } : {}),
      output: { title: cut(run.title, 255), summary: cut(run.summary, 65_000), ...(run.text ? { text: cut(run.text, 65_000) } : {}) },
    }),
  });
  if (!response.ok) throw new Error(`GitHub answered ${response.status}${response.status === 403 ? ' (a pull request from a fork gets a read-only token; otherwise give the job checks: write)' : ''}`);
  const body = await response.json() as { html_url?: string };
  return body.html_url ? { url: body.html_url } : {};
}
