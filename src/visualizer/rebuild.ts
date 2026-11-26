/**
 * After `wisdom team delete` or `prune` removed sessions for everyone (design policy 5.25): the
 * team's dashboard still shows them until its next build. With `gh` there and logged in, start
 * that build now (the CI file has `workflow_dispatch` for this); otherwise say when they go.
 */
import { gitText } from '../team/gitrefs.js';
import { repositoryFromUrl } from '../team/github.js';
import { readDeployState, type Run } from './deploy.js';

/** The workflow file `wisdom commits deploy` writes in a team's repository. */
export const TEAM_WORKFLOW = 'wisdom.yml';

/** What to tell the person, or undefined when this repository has no dashboard. */
export function rebuildDashboard(project: string, remote: string, gh: (args: string[]) => Run | undefined): string | undefined {
  const { url } = readDeployState(project);
  if (!url) return undefined;
  let repository: string | undefined;
  try { repository = repositoryFromUrl(gitText(project, ['remote', 'get-url', remote])); } catch { repository = undefined; }
  const later = `The team's dashboard (${url}) still shows it until its next build, within 20 minutes. To rebuild now: Actions > wisdom > Run workflow on GitHub${repository ? ` (https://github.com/${repository}/actions/workflows/${TEAM_WORKFLOW})` : ''}.`;
  if (!repository) return later;
  const started = gh(['workflow', 'run', TEAM_WORKFLOW, '--repo', repository]);
  if (started?.status === 0) return `The team's dashboard is rebuilding now, so it leaves ${url} within minutes.`;
  return started ? `${later} (gh could not start it: ${(started.stderr || started.stdout).trim().split('\n')[0]})` : later;
}
