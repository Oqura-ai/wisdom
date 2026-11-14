import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ledger } from '../read/discovery.js';
import { onPath, resolveCommand } from '../harnesses/launch.js';
import { agentWork, type CommitRecord, type RecordGuide } from './commits.js';
import { checkGuide, guidesOn } from './guides.js';
import { GUIDE_OPENING, items, plainGuide, turnRequest } from './plain.js';
import type { Policy } from './gitrefs.js';
import type { SessionStore } from '../storage/store.js';

/** The guide writer. A commit's guide is written in two filters:
 *
 *   1. Deterministic: the record shortlists the sessions whose recorded steps made the
 *      commit, and the window each may be read in, from this person's previous commit on the
 *      branch up to this one (commits.ts: windowStart, windowTurns).
 *   2. A model: a short-lived, cheap one, by default Claude Haiku 5.5 through the person's own
 *      Claude Code, explores those sessions inside their windows with Wisdom's read-only
 *      ledger tool, and writes the guide, citing what it read. The reason for a change often
 *      sits in an earlier turn than the edit, which is why it may read the whole window. It
 *      did not do the work, so it has no stake in flattering it.
 *
 * A team's own writer (guides.command in wisdom-team.json) reads a prompt on stdin with the
 * steps already opened, and may not use tools. A person who turns guides off (`wisdom guide
 * off`) gets a plain guide that Wisdom writes from the record, with no model at all.
 *
 * The writer's own session must not be recorded, so it runs with WISDOM_GUIDE_WRITER set,
 * which every Wisdom hook obeys, and outside the project.
 */

export const DEFAULT_MODEL = 'claude-haiku-5-5';
export const PLAIN_WRITER = 'Wisdom, no model (wisdom guide off)';
const STEP_CHARS = 6_000;
const EVIDENCE_CHARS = 60_000;
/** Exploring reads turns itself, so the steps handed to it up front are fewer. */
const EXPLORE_EVIDENCE_CHARS = 20_000;
const EXPLORE_TURNS = 30;
const bin = fileURLToPath(new URL('../bin.js', import.meta.url));

const cut = (text: string, limit: number) => text.length <= limit ? text : `${text.slice(0, limit)}\n[cut here for this guide: ${text.length - limit} more characters; open the step to read all of it]`;
const short = (id: string) => id.slice(0, 8);
const turns = (range: [number, number]) => range[0] === range[1] ? `t${range[0]}` : `t${range[0]}–t${range[1]}`;

/** Each cited step opened, with the request of its turn, within a character budget. */
function stepEvidence(store: SessionStore, record: CommitRecord, budgetChars: number): { evidence: string[]; skipped: number } {
  const evidence: string[] = [];
  let budget = budgetChars;
  const requests = new Set<string>();
  const seen = new Set<string>();
  for (const step of record.steps) {
    const key = `${step.session}:${step.position}`;
    if (seen.has(key) || budget <= 0) continue;
    seen.add(key);
    const turn = /^t\d+/.exec(step.position)?.[0];
    if (turn && !requests.has(`${step.session}:${turn}`)) {
      requests.add(`${step.session}:${turn}`);
      const asked = turnRequest(store, step.session, step.position);
      if (asked) { const text = cut(asked, 2_000); budget -= text.length; evidence.push(`### What the person asked in ${turn}, session ${short(step.session)}`, text, ''); }
    }
    let opened: string;
    try { opened = ledger(store, { capture: step.session, open: step.position }); } catch (error) { opened = `(could not be read: ${error instanceof Error ? error.message : error})`; }
    const text = cut(opened, Math.min(STEP_CHARS, Math.max(budget, 500)));
    budget -= text.length;
    evidence.push(`### ${step.position} in session ${short(step.session)}`, text, '');
  }
  return { evidence, skipped: record.steps.length - seen.size };
}

/** The prompt. `explore` tells the writer to read the sessions' windows with the ledger tool;
 * without it, the writer uses only the steps handed to it and no tools. */
export function guidePrompt(store: SessionStore, record: CommitRecord, explore = false): string {
  const list = items(record);
  const { evidence, skipped } = stepEvidence(store, record, explore ? EXPLORE_EVIDENCE_CHARS : EVIDENCE_CHARS);
  const sessions = record.sessions.map(session => `- ${session.id} (${session.harness}) · made ${session.positions.join(', ')}`
    + (session.turns ? ` · window ${turns(session.turns)}` : ''));
  const since = record.window?.since ? `since the person's previous commit on this branch (${record.window.since.commit.slice(0, 12)})` : 'from the start of each session';
  return [
    `${GUIDE_OPENING} Say what each part of the commit does and why, in plain words.`,
    'Rules:',
    explore
      ? '- Use only what the recordings show. Never guess intent they do not show; say "the recording does not say why" instead.'
      : '- Use only the evidence below. Never guess intent the evidence does not show; say "the record does not say why" instead.',
    '- Cite what you relied on exactly as [t3/c2 7e1f2a3b] (a tool call) or [t3 7e1f2a3b] (a whole turn): a position, a space, the session\'s first 8 characters.',
    explore
      ? '- Cite only the sessions listed under "Sessions", and only turns inside each one\'s window.'
      : '- Cite only positions that appear below.',
    '- Every item made by a recorded step needs at least one citation. For an item marked "not recorded", say what changed and that no recording explains it.',
    explore
      ? '- One to three short sentences per item. Output only the guide, nothing before or after it.'
      : '- One to three short sentences per item. Do not use tools. Output only the guide, nothing before or after it.',
    ...(explore ? [
      '',
      'How to read the recordings: you have one tool, ledger, which is read-only.',
      '- {"capture":"<session id>","glance":true} shows the session\'s turns: each request, its calls, the files changed.',
      '- {"capture":"<session id>","open":"t5"} opens a whole turn; "t5/c2" opens one call.',
      `The steps that made the commit are opened for you below. The reasons for a change often sit in an earlier turn than the edit, so glance at each session and open the turns of its window that explain the work before you write. Read only inside the windows: the work ${since} up to this commit.`,
      'Look in the windows for three things a reviewer needs and the edits alone do not show:',
      '- where the agent did not do what was asked, or did it differently: it refused part of a request, changed the approach, left something out, or said a request was wrong. Never restate a request as done when the recording shows it was not.',
      '- reasons given in other turns: an earlier answer, a plan, or an error that explains a later edit.',
      '- tests or checks run in the window: the command, and what it reported (passed, failed, how many), or that none was run.',
      '',
      '## Sessions',
      ...sessions,
    ] : []),
    '',
    'The guide has exactly this shape, with every item line copied unchanged:',
    '',
    '## Summary',
    '<one to three sentences: what this commit does>',
    '',
    '## Items',
    ...list.flatMap(item => [`- ${item.key} · ${item.label}`, '  <what it does and why, with citations>']),
    '',
    '## Beyond the edits',
    `Departed from the request: <where the agent did not do what was asked or did it differently, with citations; or "none ${explore ? 'found in the window' : 'shown in the evidence'}">`,
    'Reasons from other turns: <reasons stated in turns other than the edits, with citations; or "none">',
    `Tests run: <each test or check run, its command and result, with citations; or "none ${explore ? 'in the window' : 'shown in the evidence'}">`,
    '',
    `Commit ${record.commit.sha.slice(0, 12)}: ${record.commit.subject}`,
    '',
    explore ? '## The steps that made it' : '## Evidence',
    '',
    ...evidence,
    ...(skipped > 0 ? [`(${skipped} more steps were not included, to keep this short.)`] : []),
  ].join('\n');
}

/** One run's guide text and, when the writer reports it, its cost; or why there is none. */
type Output = { text?: string; costUsd?: number; failed?: string };
type Writer = { run: (prompt: string) => Output; name: string; explore: boolean };

const lastLine = (result: ReturnType<typeof spawnSync>) => String(result.stderr || result.error || 'no output').trim().split('\n').at(-1);

/** Claude Code's `--output-format json`: the final text in `result`, the run's cost in `total_cost_usd`. */
export function claudeOutput(stdout: string): Output {
  let parsed: any;
  try { parsed = JSON.parse(stdout); } catch { return { failed: 'Claude Code did not print its JSON result' }; }
  const costUsd = typeof parsed?.total_cost_usd === 'number' ? parsed.total_cost_usd : undefined;
  if (parsed?.is_error || typeof parsed?.result !== 'string' || !parsed.result.trim()) {
    return { costUsd, failed: `Claude Code ended with ${parsed?.subtype ?? 'an error'}${typeof parsed?.result === 'string' && parsed.result ? `: ${parsed.result.split('\n')[0]}` : ''}` };
  }
  return { text: parsed.result, costUsd };
}

/** The command that writes, and how it is named in the record. Undefined when none is there. */
function writerCommand(policy: Policy | undefined, dataDir: string): Writer | undefined {
  const model = policy?.guides?.model ?? DEFAULT_MODEL;
  const env = { ...process.env, WISDOM_GUIDE_WRITER: '1', WISDOM_GUIDE_MODEL: model };
  const options = { cwd: os.tmpdir(), env, encoding: 'utf8' as const, timeout: 150_000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 };
  if (policy?.guides?.command) {
    const command = policy.guides.command;
    // The command picks its own model unless the policy names one: say only what Wisdom knows.
    const name = policy.guides.model ? `${policy.guides.model} via ${command}` : `${command} (model not named)`;
    return { name, explore: false, run: prompt => {
      const result = spawnSync(command, { ...options, input: prompt, shell: true });
      return result.status === 0 && String(result.stdout ?? '').trim() ? { text: String(result.stdout) } : { failed: lastLine(result) };
    } };
  }
  const installed = process.platform === 'win32' ? onPath('claude')
    : (process.env.PATH ?? '').split(path.delimiter).map(dir => path.join(dir, 'claude')).find(file => fs.existsSync(file));
  if (!installed) return undefined;
  let claude: ReturnType<typeof resolveCommand>;
  try { claude = resolveCommand(installed); } catch { return undefined; }
  // Its only tool is Wisdom's read-only ledger for this project's data: no built-in tools, no
  // other MCP servers, a bounded number of turns. It keeps no session file: it runs in whatever
  // home the commit's process had (a tracked agent's is Wisdom's own, which the daemon reads),
  // and its run is not a session of anyone's.
  const config = path.join(os.tmpdir(), `wisdom-guide-mcp-${process.pid}.json`);
  const args = ['-p', '--model', model, '--output-format', 'json', '--no-session-persistence', '--tools', '', '--strict-mcp-config',
    '--mcp-config', config, '--allowedTools', 'mcp__wisdom__ledger', '--max-turns', String(EXPLORE_TURNS)];
  return { name: `${model} via Claude Code, reading the sessions' windows`, explore: true, run: prompt => {
    fs.writeFileSync(config, JSON.stringify({ mcpServers: { wisdom: { command: process.execPath, args: [bin, 'mcp', '--data', dataDir] } } }));
    try {
      const result = spawnSync(claude.command, [...claude.args, ...args], { ...options, input: prompt });
      const output = String(result.stdout ?? '').trim() ? claudeOutput(String(result.stdout)) : { failed: lastLine(result) };
      return result.status === 0 || output.failed ? output : { ...output, failed: lastLine(result) };
    } finally { fs.rmSync(config, { force: true }); }
  } };
}

/** The guide as written: from its summary on, without a code fence around it. */
function clean(output: string): string {
  const text = output.replace(/^\s*```(?:markdown|md)?\s*\n/, '').replace(/\n```\s*$/, '');
  const start = text.indexOf('## Summary');
  return (start >= 0 ? text.slice(start) : text).trim() + '\n';
}

/** Write the guide for a record, or say why there is none. Only commits with agent work get one.
 * After a commit, the person's switch decides who writes it (guidesOn); `requested` (wisdom
 * guide <commit>) always has the model write it. */
export function writeGuide(store: SessionStore, record: CommitRecord, dataDir: string, policy: Policy | undefined, requested = false,
  /** The person's switch as it was at the commit; read now when not given. */ on?: boolean): { guide?: RecordGuide; missing?: string } {
  if (!agentWork(record)) return {};
  const ids = () => store.database.manifests().map(m => m.captureId);
  const stores = (id: string) => ids().includes(id) ? store : undefined;
  if (!requested && !(on ?? guidesOn(dataDir, !!policy))) {
    const text = plainGuide(record, stores);
    return { guide: { text, writtenAt: new Date().toISOString(), writer: PLAIN_WRITER, problems: checkGuide(text, record, stores, ids), derived: true } };
  }
  const writer = writerCommand(policy, dataDir);
  if (!writer) return { missing: 'no guide writer: Claude Code is not installed and wisdom-team.json names no guides.command' };
  let prompt = guidePrompt(store, record, writer.explore);
  let text = '', problems: string[] = [], costUsd: number | undefined;
  const started = Date.now();
  for (let attempt = 0; attempt < 2; attempt++) {
    const output = writer.run(prompt);
    if (output.costUsd !== undefined) costUsd = (costUsd ?? 0) + output.costUsd;
    if (output.failed || !output.text) return { missing: `the guide writer failed: ${output.failed ?? 'no output'}` };
    text = clean(output.text);
    problems = checkGuide(text, record, stores, ids);
    if (!problems.length) break;
    prompt += `\n\nYour previous guide had these problems; write it again, fixing them:\n${problems.map(p => `- ${p}`).join('\n')}\n`;
  }
  return { guide: { text, writtenAt: new Date().toISOString(), writer: writer.name, problems, derived: true,
    seconds: Math.round((Date.now() - started) / 100) / 10, ...(costUsd === undefined ? {} : { costUsd }) } };
}
