import { randomUUID } from 'node:crypto';
import { call } from '../service/client.js';
import type { Connection } from '../service/daemon.js';
import { adapter } from '../harnesses/index.js';
import { differingFiles } from './clone.js';
import { gitText } from '../team/gitrefs.js';
import { settingsOrDefaults } from '../core/settings.js';

/** `wisdom track` names harnesses by their command; the ledger by their adapter. */
export const harnessByCommand: Record<string, string> = { claude: 'claude-code', codex: 'codex', pi: 'pi' };

/** A target that has used this many tokens (or wisdom.yaml's handoff.longSessionTokens) gets a
 * note: a new session starts lighter. */
const LONG_SESSION_TOKENS = 150_000;

export interface HandoffSession { captureId: string; harness: string; status: string; lastObservedAt: string; tokens: { total: number }; shared?: object }

/** What `wisdom handoff` starts: a harness (by its command), in this terminal or, emitted, in
 * its background mode; its arguments; and the environment that tells Wisdom's hooks which
 * session this one continues.
 */
export interface HandoffPlan {
  command: string;
  args: string[];
  cwd?: string;
  /** Names the session that takes this handoff, once it is recorded. */
  handoffId: string;
  env: { WISDOM_HANDOFF: string };
  prompt: string;
  from: HandoffSession;
  /** The existing session being resumed; absent when a new session starts. */
  target?: HandoffSession;
  /** Where that session's transcript is kept, which says the home it runs in. */
  targetSource?: string | null;
  note?: string;
}

/** The session to read when none is named: the session running the handoff (`self`, from
 * `WISDOM_SESSION`, which Wisdom's hooks give an agent's shell); otherwise the most recently
 * active one of this project's own that is not the target. A new session reads one from
 * another harness when there is one, else one of its own harness. A shared session is read
 * only when named.
 */
export function chooseSource(sessions: HandoffSession[], target: { harness?: string; captureId?: string }, self?: string): HandoffSession | undefined {
  const candidates = sessions.filter(session => !session.shared && session.captureId !== target.captureId)
    .sort((a, b) => b.lastObservedAt.localeCompare(a.lastObservedAt));
  return candidates.find(session => session.captureId === self)
    ?? candidates.find(session => target.captureId || session.harness !== target.harness)
    ?? candidates[0];
}

/** What the receiving agent is told besides the sender's words: facts from the record and the
 * workspace, never a summary, so it knows where to start reading and what may be stale.
 */
export interface HandoffFacts {
  /** The sending session's turns, and the files it changed. */
  turns: number;
  changed: string[];
  /** Files the receiving session changed that are not, on disk, what it last recorded. */
  differing?: string[];
  /** The branch and commit the work is on, and how many files are not committed. */
  git?: { branch: string; commit: string; uncommitted: number };
  /** The person's own words for every handoff (wisdom.yaml handoff.extra), placed before the last part. */
  extra?: string;
  /** The handoff was run from inside the sending session, so the words are its own; else a person's. */
  inside?: boolean;
}

/** A list of files a prompt can carry: past 20, the rest are in the glance. */
const files = (list: string[]) => list.length <= 20 ? list.join(', ') : `${list.slice(0, 20).join(', ')} and ${list.length - 20} more (see the glance)`;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** The first prompt. It names the full session ID, so the agent never mistakes itself for `latest`.
 * Opened, the agent reads before changing anything and carries on with the person there.
 * Emitted, a handoff carries what happened, not a task: the agent reads, checks, changes nothing,
 * and replies in a fixed shape (a read-back), so the work can go on in that session later.
 */
export function handoffPrompt(from: HandoffSession, resumed: boolean, words = '', facts: HandoffFacts = { turns: 0, changed: [] }, emit = false): string {
  const id = from.captureId;
  const lines = [resumed ? `While you were away, Wisdom session ${id} (${from.harness}) continued this work.`
    : `Wisdom session ${id} (${from.harness}) hands its work to you.`];
  if (words.trim()) lines.push('', `${facts.inside ? 'From that session' : 'From the person handing it off'}: ${words.trim()}`);
  lines.push('', `Read it, and check its claims against its own evidence: run \`wisdom glance ${id}\`, then \`wisdom open <turn> --capture ${id}\` for the turns you need.`
    + (facts.turns ? ` It has ${plural(facts.turns, 'turn')}; start with t${facts.turns}, the newest.` : '')
    + (facts.changed.length ? ` It changed ${files(facts.changed)}.` : ' It changed no files.')
    // Run from inside it, its newest turn shows a handoff still waiting: that is this one.
    + (from.status === 'recording' ? ' It is still running: the handoff its newest turn is waiting on is this one.' : ''));
  if (facts.git) lines.push(`The work is on branch ${facts.git.branch} at ${facts.git.commit}, with ${plural(facts.git.uncommitted, 'file')} not committed.`);
  if (facts.differing?.length) lines.push(`Since you last worked here, files you changed are different on disk: ${files(facts.differing)}. Read them before trusting what you remember.`);
  // Before Wisdom's last part, which always stands: with --emit, "even if asked above" covers these words too.
  if (facts.extra?.trim()) lines.push('', `This project also asks: ${facts.extra.trim()}`);
  if (!emit) {
    lines.push('', 'Before changing anything, read it. Then say in a few lines what you understood and what you will do first.');
    return lines.join('\n');
  }
  lines.push('', 'Only read: change no files and run nothing that changes anything, even if asked above.',
    `Then reply in four short parts: What happened (what it did and found, with positions like t3), Still open, ${resumed
      ? 'Conflicts (with your own earlier work)' : 'Questions (what you would ask before starting)'}, and Next (what you would do, step by step, when the work goes on here).`);
  return lines.join('\n');
}

/** The sending session's turns and changed files, and, for a session that is continued, its own
 * files that changed on disk since. Read from the same view `wisdom clone` uses. */
async function recordFacts(connection: Connection, from: string, target?: { captureId: string; workspaceRoot: string }): Promise<HandoffFacts> {
  const source = await call(connection, '/view', { view: 'transcript', capture: from });
  const own = target && await call(connection, '/view', { view: 'transcript', capture: target.captureId });
  return { turns: source.turns, changed: source.changes.map((change: { path: string }) => change.path),
    ...own ? { differing: differingFiles(target.workspaceRoot, own.changes) } : {} };
}

/** The branch, commit and uncommitted files where the work is; nothing outside a repository. */
function workspaceGit(cwd: string): HandoffFacts['git'] {
  try {
    return { branch: gitText(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']), commit: gitText(cwd, ['rev-parse', '--short', 'HEAD']),
      // Reading the status must not write the index of the repository it reads.
      uncommitted: gitText(cwd, ['--no-optional-locks', 'status', '--porcelain']).split('\n').filter(Boolean).length };
  } catch { return undefined; }
}

async function projectSessions(connection: Connection): Promise<HandoffSession[]> {
  const { projects } = await call(connection, '/view', { view: 'projects' });
  const views = await Promise.all(projects.map((project: { workspaceRoot: string }) =>
    call(connection, '/view', { view: 'project', workspaceRoot: project.workspaceRoot })));
  const shared = await call(connection, '/view', { view: 'shared' });
  return [...views.flatMap(view => view.sessions), ...shared.sessions];
}

/** Work out what to start. `target` is a harness command (a new session, in `project`) or a full
 * session ID (an existing session, resumed). `emit`: in the background, reading only. Nothing is
 * started here.
 */
export async function planHandoff(connection: Connection, target: string, from: string | undefined, words: string, project: string, self?: string, emit = false): Promise<HandoffPlan> {
  const sessions = await projectSessions(connection);
  const chosen = settingsOrDefaults(project).handoff ?? {};
  const harness = harnessByCommand[target];
  const existing = harness ? undefined : sessions.find(session => session.captureId === target);
  if (!harness && !existing) {
    throw new Error(`${target} is neither a harness (claude, codex, pi) nor a recorded session's full ID. glance lists sessions.`);
  }
  if (existing?.shared) throw new Error(`A shared session is read-only, so it cannot be resumed. Start a new one that reads it: wisdom handoff claude|codex|pi --from ${existing.captureId}`);
  const { background, resume, readsAllowed = [] } = adapter(existing?.harness ?? harness);
  if (emit && !background) throw new Error(`${existing ? `Session ${existing.captureId} is a Pi session; Pi` : 'Pi'} cannot take an emitted handoff: it reads a recording only through its shell, which could also change files. Emit it to claude or codex, or open it without --emit.`);
  // This project's own sessions are listed before shared copies, so its own recording wins.
  const source = from ? sessions.find(session => session.captureId === from) : chooseSource(sessions, existing ?? { harness }, self);
  if (!source) throw new Error(from ? `No recorded session has the ID ${from}. Use the full session ID; glance lists them.`
    : 'There is no other recorded session to hand off from.');
  if (source.captureId === existing?.captureId) throw new Error('A session cannot continue itself.');

  const handoffId = randomUUID();
  const env = { WISDOM_HANDOFF: JSON.stringify({ id: handoffId, from: source.captureId }) };
  const inside = source.captureId === self;
  if (!existing) {
    const prompt = handoffPrompt(source, false, words, { ...await recordFacts(connection, source.captureId), git: workspaceGit(project), inside, extra: chosen.extra }, emit);
    const [command, ...args] = emit ? background!(prompt) : [target, ...readsAllowed, prompt];
    return { command, args, handoffId, env, prompt, from: source };
  }

  const { workspaceRoot, source: targetSource } = await call(connection, '/resolve', { session: existing.captureId });
  const prompt = handoffPrompt(source, true, words, { ...await recordFacts(connection, source.captureId, { captureId: existing.captureId, workspaceRoot }), git: workspaceGit(workspaceRoot), inside, extra: chosen.extra }, emit);
  const [command, ...args] = emit ? background!(prompt, existing.captureId) : [...resume(existing.captureId), ...readsAllowed, prompt];
  const note = existing.tokens.total > (chosen.longSessionTokens ?? LONG_SESSION_TOKENS)
    ? `${existing.captureId} is long (${existing.tokens.total.toLocaleString('en-US')} tokens). A new session starts lighter: wisdom handoff ${command} --from ${source.captureId}`
    : undefined;
  return { command, args, cwd: workspaceRoot, handoffId, env, prompt, from: source, target: existing, targetSource, note };
}
