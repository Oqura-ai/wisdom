/**
 * `wisdom check` in GitHub Actions, on a pull request (design policy 5.26): the result as GitHub's
 * own check run, beside the job's pass or fail. One status line as its title, what needs
 * attention as its summary, and Details leading to the pull request's page on the team's
 * dashboard when there is one. The same summary goes on the job's own summary page, which needs
 * no permission (a fork's pull request gets a read-only token, so its check run is refused).
 *
 * It only reports: pass or fail is the check's own (team.ts prCheck), and nothing here can change
 * it. Words are the dashboard's: "needs attention", "no record".
 */
import fs from 'node:fs';
import { readPolicy } from './gitrefs.js';
import { postCheckRun, type CheckRun } from './github.js';
import type { CheckedCommit } from './team.js';

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** The check run's words, from the check's result. `dashboard`: the team dashboard's address. */
export function checkRunText(result: { ok: boolean; text: string; commits: CheckedCommit[] }, dashboard?: string, pr?: number): Omit<CheckRun, 'name' | 'headSha'> {
  const { commits } = result;
  const attention = commits.filter(c => c.problems.length), unrecorded = commits.filter(c => !c.recorded);
  const good = commits.filter(c => c.recorded && !c.problems.length).length;
  const title = !commits.length ? 'No commits to check'
    : [`${good} of ${plural(commits.length, 'commit')} explained by recorded sessions`,
      attention.length ? `${attention.length} need${attention.length === 1 ? 's' : ''} attention` : '',
      unrecorded.length ? `${unrecorded.length} without a record` : ''].filter(Boolean).join(' · ');
  const line = (c: CheckedCommit, why: string) => `- \`${c.sha.slice(0, 7)}\` ${c.subject.replace(/[\r\n]+/g, ' ')}: ${why}`;
  const parts: string[] = [];
  if (attention.length) parts.push('**Needs attention**', '', ...attention.map(c => line(c, c.problems.join('; '))), '');
  if (unrecorded.length) parts.push('**No record**: made without Wisdom, not linked yet, or its record not pushed. These fail nothing.', '',
    ...unrecorded.map(c => line(c, 'no record')), '');
  if (!attention.length && commits.length) parts.push('Every commit with a record passes: a guide where there is agent work, and every session it names is on the remote.', '');
  const detailsUrl = dashboard && pr ? `${dashboard.replace(/\/+$/, '')}/#/change/${pr}` : undefined;
  if (detailsUrl) parts.push(`[Open this pull request on the team's dashboard](${detailsUrl}), with its commits and the sessions behind them. It updates a few minutes after each push.`);
  return { ok: result.ok, title, summary: parts.join('\n').trim(), text: `\`\`\`text\n${result.text}\n\`\`\``, ...(detailsUrl ? { detailsUrl } : {}) };
}

/** In GitHub Actions on a pull request: write the job summary and post the check run. Never
 * throws, and never changes the outcome: a refusal is one line in the log. */
export async function reportCheck(cwd: string, remote: string, result: { ok: boolean; text: string; commits: CheckedCommit[] }, env: NodeJS.ProcessEnv = process.env): Promise<string[]> {
  if (env.GITHUB_ACTIONS !== 'true') return [];
  const lines: string[] = [];
  // The pull request this run is about: GITHUB_SHA is the merge GitHub made for the run, so the
  // check goes on the pull request's own head, as its event names it.
  let event: { pull_request?: { number?: number; head?: { sha?: string } } } = {};
  try { if (env.GITHUB_EVENT_PATH) event = JSON.parse(fs.readFileSync(env.GITHUB_EVENT_PATH, 'utf8')); } catch { /* no event file */ }
  const pr = event.pull_request?.number, headSha = event.pull_request?.head?.sha ?? env.GITHUB_SHA;
  let dashboard: string | undefined;
  try { dashboard = (readPolicy(cwd) as { commits?: { url?: string } } | undefined)?.commits?.url; } catch { dashboard = undefined; }
  const run = checkRunText(result, dashboard, pr);

  if (env.GITHUB_STEP_SUMMARY) {
    try { fs.appendFileSync(env.GITHUB_STEP_SUMMARY, `## Wisdom\n\n**${run.title}**\n\n${run.summary}\n`); }
    catch (error) { lines.push(`Job summary not written: ${error instanceof Error ? error.message : error}`); }
  }
  if (!headSha) return [...lines, 'Check run not posted: no commit to post it on.'];
  try {
    const posted = await postCheckRun(cwd, remote, { name: 'Wisdom', headSha, ...run }, env);
    lines.push(`Check run posted${posted.url ? `: ${posted.url}` : ''}`);
  } catch (error) { lines.push(`Check run not posted: ${error instanceof Error ? error.message : error}. The job's summary has the same.`); }
  return lines;
}
