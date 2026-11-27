/**
 * `wisdom commits build`: the team's Commits dashboard, built in CI from a clone of the remote
 * (design policy 5.23, 5.25). Needs no data folder, as `wisdom team relink` doesn't.
 *
 *   1. Fetch everything Wisdom keeps on the remote: records, links, sessions and the deletion
 *      list (the dashboard reads it all, 5.23), never pruning.
 *   2. Ask GitHub for pull request titles, states, branches and usernames (github.ts).
 *   3. Build the data (build.ts), reusing the turns of sessions unchanged since the last build
 *      when the folder is kept between runs (the workflow caches it).
 *   4. Write the deployable site (site.ts): the app, and the data behind the sign-in gate unless
 *      the dashboard is public on purpose.
 *
 * Everything goes under one folder (`--out`, default `.wisdom-commits/`): `data/` (the build),
 * `sessions/` (imported share files, reused), `site/` (what `vercel deploy --prebuilt` uploads).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listRefs, refExists, topLevel } from '../team/gitrefs.js';
import { fetchRefs, policyOrThrow } from '../team/team.js';
import { defaultBranch } from '../team/relink.js';
import { githubApi } from '../team/github.js';
import { buildData, writeData } from './build.js';
import { remoteSessions, storeEvidence } from './evidence.js';
import { gatherGitHub } from './github.js';
import { writeVercelSite } from './site.js';

const bundledApp = fileURLToPath(new URL('../../../dist-commits/', import.meta.url));
const version = () => JSON.parse(fs.readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')).version as string;

export interface TeamBuild { lines: string[]; out: string; site: string; data: string }

export async function buildTeam(cwd: string, options: { out?: string; public?: boolean; main?: string; remote?: string; app?: string; env?: NodeJS.ProcessEnv } = {}): Promise<TeamBuild> {
  const project = topLevel(cwd);
  const env = options.env ?? process.env;
  let policy;
  try { policy = policyOrThrow(project); }
  catch (error) { throw new Error(`The team's Commits dashboard is built from a team-mode repository, one with wisdom-team.yaml: ${error instanceof Error ? error.message : error}`); }
  const remote = options.remote ?? policy.remote ?? 'origin';
  const out = path.resolve(project, options.out ?? '.wisdom-commits');
  const lines: string[] = [];

  // 1. Everything the remote holds for Wisdom; the builder reads it all.
  const refs = fetchRefs(project, remote, policy);
  lines.push(`Read ${refs.size} Wisdom ref${refs.size === 1 ? '' : 's'} from ${remote}`);

  const main = options.main ?? defaultBranch(project, remote);
  const mainRef = [`refs/remotes/${remote}/${main}`, `refs/heads/${main}`].find(ref => refExists(project, ref));
  if (!mainRef) throw new Error(`There is no branch ${main} here, on ${remote} or locally. Name the default branch with --main.`);
  // Every other branch on the remote, as this clone has them (actions/checkout with fetch-depth: 0 brings them all).
  const prefix = `refs/remotes/${remote}/`;
  const branches = [...listRefs(project, prefix).keys()].map(ref => ({ name: ref.slice(prefix.length), ref }))
    .filter(branch => branch.name !== 'HEAD' && branch.name !== main);

  // 2. GitHub's facts, when this is a GitHub repository. Without them titles come from merge
  // messages and names from git: the build never fails for want of them.
  const api = githubApi(project, remote, env);
  let github;
  if (api) {
    try {
      github = await gatherGitHub(api, project, mainRef);
      for (const warning of github.warnings) lines.push(`GitHub: ${warning}`);
    } catch (error) { lines.push(`GitHub not asked: ${error instanceof Error ? error.message : error}`); }
  } else lines.push(`GitHub not asked: ${remote} is not a GitHub remote and GITHUB_REPOSITORY is not set`);

  // 3. The data, with the team's sessions read from the share files the fetch brought.
  const shared = remoteSessions(project, path.join(out, 'sessions'));
  const input = { project, mode: 'team' as const, main: { name: main, ref: mainRef }, branches,
    evidence: storeEvidence(shared.stores, shared.ids, shared.version), ...(github ? { github } : {}),
    remote, ...(api ? { repository: api.repository } : {}), wisdomVersion: version() };
  const data = path.join(out, 'data');
  fs.mkdirSync(out, { recursive: true });
  // Built inside the repository: never something to commit, without touching the team's own files.
  fs.writeFileSync(path.join(out, '.gitignore'), '# Written by wisdom commits build: a build, never committed.\n*\n');
  const built = writeData(data, input, buildData(input));
  lines.push(`Built ${Object.keys(built.manifest.files).length} files (${built.made} made, ${built.reused} turns reused), ${shared.ids().length} session${shared.ids().length === 1 ? '' : 's'} read`);

  // 4. The site. A private dashboard needs the repository's name for its gate.
  const site = path.join(out, 'site');
  const repository = api?.repository;
  if (!options.public && !repository) throw new Error('The sign-in needs the GitHub repository (owner/name): set GITHUB_REPOSITORY, or use a GitHub remote.');
  const written = writeVercelSite(site, { app: options.app ?? bundledApp, data, gate: options.public ? 'public' : { repo: repository! } });
  // The CLI links the site to the team's project from these, as `vercel link` would.
  if (env.VERCEL_ORG_ID && env.VERCEL_PROJECT_ID)
    fs.writeFileSync(path.join(site, '.vercel', 'project.json'), JSON.stringify({ orgId: env.VERCEL_ORG_ID, projectId: env.VERCEL_PROJECT_ID }));
  lines.push(`Site written to ${path.relative(project, site) || site} (${written.files} files, data ${(written.dataBytes / 1048576).toFixed(1)} MB, ${options.public ? 'public: no sign-in' : `behind the GitHub sign-in for ${repository}`})`);
  return { lines, out, site, data };
}

// ---------- the team's one workflow file ----------

/** Where Wisdom's reusable workflow is, and the version a team's file follows (policy 5.26). */
export const REUSABLE = 'Oqura-ai/wisdom/.github/workflows/wisdom.yml@v1';

/** `.github/workflows/wisdom.yml` in a team's repository: one job calling Wisdom's reusable
 * workflow, which checks pull requests, relinks after merges, and (with `commits`) builds the
 * dashboard. The Vercel IDs are not secret, so they are written here; the token is a secret. */
export function teamWorkflowText(main: string, commits?: { orgId: string; projectId: string; public?: boolean }): string {
  const triggers = commits
    ? `on:
  pull_request:
  push:
    branches: [${JSON.stringify(main)}]
  # The backstop: sessions pushed between merges start no workflow, so the dashboard reads them here.
  schedule:
    - cron: '7,27,47 * * * *'
  workflow_dispatch:`
    : `on:
  pull_request:
  push:
    branches: [${JSON.stringify(main)}]`;
  // Pinned to the Wisdom that wrote the file: the workflow's default, npm's latest, may be an
  // older Wisdom without these jobs. Update it with the team's version.
  const settings = [`      main: ${JSON.stringify(main)}`, `      wisdom-version: ${JSON.stringify(version())}`];
  if (commits) settings.push('      commits: true', `      vercel-org-id: ${JSON.stringify(commits.orgId)}`, `      vercel-project-id: ${JSON.stringify(commits.projectId)}`,
    ...(commits.public ? ['      public: true   # no sign-in: anyone with the link sees everything'] : []));
  return `# Wisdom in CI: checks pull requests, links what GitHub makes at a merge${commits ? ', and builds the team\'s Commits dashboard' : ''}.
# Written by Wisdom; see docs/team.md#ci. The work is in Wisdom's reusable workflow (${REUSABLE}).
name: wisdom
${triggers}
permissions:
  contents: write        # relink pushes Wisdom's link refs (refs/wisdom/...), never a branch
  pull-requests: read
  checks: write          # the check's result, shown on each pull request
jobs:
  wisdom:
    uses: ${REUSABLE}
    with:
${settings.join('\n')}
${commits ? `    secrets:
      VERCEL_TOKEN: \${{ secrets.WISDOM_VERCEL_TOKEN }}
` : ''}`;
}
