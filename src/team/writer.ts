import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ledger } from '../read/discovery.js';
import { EvidenceReader } from '../storage/evidence.js';
import { onPath, resolveCommand } from '../harnesses/launch.js';
import { agentWork, type CommitRecord, type RecordGuide } from './commits.js';
import { checkGuide, guidesOn, items } from './guides.js';
import type { Policy } from './gitrefs.js';
import type { SessionStore } from '../storage/store.js';

/** The guide writer: a short-lived, cheap model that reads a commit's record and the steps it
 * cites, and writes the guide. It is clerical work, so it does not need the model that wrote
 * the code, and it has no stake in flattering that work. By default it is Claude Code, headless,
 * on Haiku 5.5, with the person's own login; a team can name another command and model in
 * wisdom-team.json. The prompt goes in on stdin and the guide comes out on stdout.
 *
 * Its own session must not be recorded, so it runs with WISDOM_GUIDE_WRITER set, which every
 * Wisdom hook obeys, and outside the project.
 */

export const DEFAULT_MODEL = 'claude-haiku-5-5';
const STEP_CHARS = 6_000;
const EVIDENCE_CHARS = 60_000;

/** The person's request that opened a turn, by its position (t3 or t3/c2). */
function turnRequest(store: SessionStore, id: string, position: string): string | undefined {
  const turn = /^t(\d+)/.exec(position)?.[1];
  if (!turn) return undefined;
  const inputs = store.database.records("capture_id=? AND type='input'", [id], 'ORDER BY seq').filter(r => !r.agentId && !r.internalAgent);
  const record = inputs[Number(turn) - 1];
  if (!record) return undefined;
  try { return JSON.parse(new EvidenceReader(store).read(record, 'data') ?? '{}').text; } catch { return undefined; }
}

const cut = (text: string, limit: number) => text.length <= limit ? text : `${text.slice(0, limit)}\n[cut here for this guide: ${text.length - limit} more characters; open the step to read all of it]`;

export function guidePrompt(store: SessionStore, record: CommitRecord): string {
  const list = items(record);
  const evidence: string[] = [];
  let budget = EVIDENCE_CHARS;
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
      if (asked) { const text = cut(asked, 2_000); budget -= text.length; evidence.push(`### What the person asked in ${turn}, session ${step.session.slice(0, 8)}`, text, ''); }
    }
    let opened: string;
    try { opened = ledger(store, { capture: step.session, open: step.position }); } catch (error) { opened = `(could not be read: ${error instanceof Error ? error.message : error})`; }
    const text = cut(opened, Math.min(STEP_CHARS, Math.max(budget, 500)));
    budget -= text.length;
    evidence.push(`### ${step.position} in session ${step.session.slice(0, 8)}`, text, '');
  }
  const skipped = record.steps.length - seen.size;
  return [
    'You write a commit guide for the people who will review this commit. It is clerical work: say what each part of the commit does and why, from the evidence below, in plain words.',
    'Rules:',
    '- Use only the evidence below. Never guess intent the evidence does not show; say "the record does not say why" instead.',
    '- Cite the steps you relied on exactly as [t3/c2 7e1f2a3b]: a position, a space, the session\'s first 8 characters. Cite only positions that appear below.',
    '- Every item made by a recorded step needs at least one citation. For an item marked "not recorded", say what changed and that no recording explains it.',
    '- One to three short sentences per item. Do not use tools. Output only the guide, nothing before or after it.',
    '',
    'The guide has exactly this shape, with every item line copied unchanged:',
    '',
    '## Summary',
    '<one to three sentences: what this commit does>',
    '',
    '## Items',
    ...list.flatMap(item => [`- ${item.key} · ${item.label}`, '  <what it does and why, with citations>']),
    '',
    `Commit ${record.commit.sha.slice(0, 12)}: ${record.commit.subject}`,
    '',
    '## Evidence',
    '',
    ...evidence,
    ...(skipped > 0 ? [`(${skipped} more steps were not included, to keep this short.)`] : []),
  ].join('\n');
}

/** The command that writes, and how it is named in the record. Undefined when none is there. */
function writerCommand(policy: Policy | undefined): { run: (prompt: string) => ReturnType<typeof spawnSync>; name: string } | undefined {
  const model = policy?.guides?.model ?? DEFAULT_MODEL;
  const env = { ...process.env, WISDOM_GUIDE_WRITER: '1', WISDOM_GUIDE_MODEL: model };
  const options = { cwd: os.tmpdir(), env, encoding: 'utf8' as const, timeout: 180_000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 };
  if (policy?.guides?.command) {
    const command = policy.guides.command;
    return { name: `${model} via ${command}`, run: prompt => spawnSync(command, { ...options, input: prompt, shell: true }) };
  }
  const installed = process.platform === 'win32' ? onPath('claude')
    : (process.env.PATH ?? '').split(path.delimiter).map(dir => path.join(dir, 'claude')).find(file => fs.existsSync(file));
  if (!installed) return undefined;
  let claude: ReturnType<typeof resolveCommand>;
  try { claude = resolveCommand(installed); } catch { return undefined; }
  return { name: `${model} via Claude Code`, run: prompt => spawnSync(claude.command, [...claude.args, '-p', '--model', model], { ...options, input: prompt }) };
}

/** The guide as written: from its summary on, without a code fence around it. */
function clean(output: string): string {
  const text = output.replace(/^\s*```(?:markdown|md)?\s*\n/, '').replace(/\n```\s*$/, '');
  const start = text.indexOf('## Summary');
  return (start >= 0 ? text.slice(start) : text).trim() + '\n';
}

/** Write the guide for a record, or say why there is none. Only commits with agent work get one. */
export function writeGuide(store: SessionStore, record: CommitRecord, dataDir: string, policy: Policy | undefined): { guide?: RecordGuide; missing?: string } {
  if (!agentWork(record)) return {};
  if (!guidesOn(dataDir)) return { missing: 'turned off by the person who committed (wisdom guide off)' };
  const writer = writerCommand(policy);
  if (!writer) return { missing: 'no guide writer: Claude Code is not installed and wisdom-team.json names no guides.command' };
  const ids = () => store.database.manifests().map(m => m.captureId);
  const stores = (id: string) => ids().includes(id) ? store : undefined;
  let prompt = guidePrompt(store, record);
  let text = '', problems: string[] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = writer.run(prompt);
    if (result.status !== 0 || !String(result.stdout ?? '').trim()) {
      return { missing: `the guide writer failed: ${String(result.stderr ?? result.error ?? 'no output').trim().split('\n').at(-1)}` };
    }
    text = clean(String(result.stdout));
    problems = checkGuide(text, record, stores, ids);
    if (!problems.length) break;
    prompt += `\n\nYour previous guide had these problems; write it again, fixing them:\n${problems.map(p => `- ${p}`).join('\n')}\n`;
  }
  return { guide: { text, writtenAt: new Date().toISOString(), writer: writer.name, problems, derived: true } };
}
