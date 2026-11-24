import { gitText } from './gitrefs.js';

/** The one place Wisdom asks GitHub anything: which pull request made a commit on the default
 * branch, and which commits that pull request had. Used only by `wisdom team relink`, in the CI
 * job after a merge, where no git hook on anyone's machine saw GitHub squash or rebase the
 * work. Read-only. Another forge (GitLab) would be another module with the same two questions.
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

export interface GitHubApi {
  repository: string;
  /** The pull requests GitHub associates with a commit (merged into the default branch). */
  pullsForCommit(sha: string): Promise<PullRequest[]>;
  /** A pull request's commits, oldest first (GitHub lists at most 250). */
  pullCommits(number: number): Promise<string[]>;
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
      const shas: string[] = [];
      for (let page = 1; page <= 3; page++) {
        const commits = await get(`/pulls/${number}/commits?per_page=100&page=${page}`) as any[];
        shas.push(...commits.map(commit => String(commit.sha)));
        if (commits.length < 100) break;
      }
      return shas;
    },
  };
}
