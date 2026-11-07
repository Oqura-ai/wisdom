import { randomUUID } from 'node:crypto';
import { call } from './client.js';
import type { Connection } from './daemon.js';
import { adapter } from './harnesses/index.js';

/** `wisdom track` names harnesses by their command; the ledger by their adapter. */
export const harnessByCommand: Record<string, string> = { claude: 'claude-code', codex: 'codex', pi: 'pi' };

/** A target this long already fills much of a context window before it reads anything. */
const LONG_SESSION_TOKENS = 150_000;

export interface HandoffSession { captureId: string; harness: string; status: string; lastObservedAt: string; tokens: { total: number }; shared?: object }

/** What `wisdom handoff` starts: a harness (by its command), its arguments, and the
 * environment that tells Wisdom's hooks which session this one continues.
 */
export interface HandoffPlan {
  command: string;
  args: string[];
  cwd?: string;
  env: { WISDOM_HANDOFF: string };
  prompt: string;
  from: HandoffSession;
  /** The existing session being resumed; absent when a new session starts. */
  target?: HandoffSession;
  /** Where that session's transcript is kept, which says the home it runs in. */
  targetSource?: string | null;
  note?: string;
}

/** The session to read when none is named: the most recently active one of this project's
 * own that is not the target, and from another harness when a new session starts. A shared
 * session is read only when named.
 */
export function chooseSource(sessions: HandoffSession[], target: { harness?: string; captureId?: string }): HandoffSession | undefined {
  return [...sessions].sort((a, b) => b.lastObservedAt.localeCompare(a.lastObservedAt))
    .find(session => !session.shared && session.captureId !== target.captureId && (target.captureId || session.harness !== target.harness));
}

/** The first prompt. It names the full session ID, so the agent never mistakes itself for `latest`. */
export function handoffPrompt(from: HandoffSession, resumed: boolean, words = ''): string {
  const read = `run \`wisdom glance ${from.captureId}\`, then \`wisdom open <turn> --capture ${from.captureId}\` for the turns you need.`;
  const prompt = resumed
    ? `While you were away, Wisdom session ${from.captureId} (${from.harness}) continued this work. Before going on, read it: ${read}`
    : `Continue the work from Wisdom session ${from.captureId} (${from.harness}). Before changing anything, read it: ${read}`;
  return words.trim() ? `${prompt}\n\n${words.trim()}` : prompt;
}

async function projectSessions(connection: Connection): Promise<HandoffSession[]> {
  const { projects } = await call(connection, '/view', { view: 'projects' });
  const views = await Promise.all(projects.map((project: { workspaceRoot: string }) =>
    call(connection, '/view', { view: 'project', workspaceRoot: project.workspaceRoot })));
  const shared = await call(connection, '/view', { view: 'shared' });
  return [...views.flatMap(view => view.sessions), ...shared.sessions];
}

/** Work out what to start. `target` is a harness command (a new session) or a full
 * session ID (an existing session, resumed). Nothing is started here.
 */
export async function planHandoff(connection: Connection, target: string, from: string | undefined, words: string): Promise<HandoffPlan> {
  const sessions = await projectSessions(connection);
  const harness = harnessByCommand[target];
  const existing = harness ? undefined : sessions.find(session => session.captureId === target);
  if (!harness && !existing) {
    throw new Error(`${target} is neither a harness (claude, codex, pi) nor a recorded session's full ID. glance lists sessions.`);
  }
  if (existing?.shared) throw new Error(`A shared session is read-only, so it cannot be resumed. Start a new one that reads it: wisdom handoff claude|codex|pi --from ${existing.captureId}`);
  // This project's own sessions are listed before shared copies, so its own recording wins.
  const source = from ? sessions.find(session => session.captureId === from) : chooseSource(sessions, existing ?? { harness });
  if (!source) throw new Error(from ? `No recorded session has the ID ${from}. Use the full session ID; glance lists them.`
    : 'There is no other recorded session to hand off from.');
  if (source.captureId === existing?.captureId) throw new Error('A session cannot continue itself.');

  const prompt = handoffPrompt(source, Boolean(existing), words);
  const env = { WISDOM_HANDOFF: JSON.stringify({ id: randomUUID(), from: source.captureId }) };
  if (!existing) return { command: target, args: [prompt], env, prompt, from: source };

  const { workspaceRoot, source: targetSource } = await call(connection, '/resolve', { session: existing.captureId });
  const [command, ...args] = adapter(existing.harness).resume(existing.captureId);
  const note = existing.tokens.total > LONG_SESSION_TOKENS
    ? `${existing.captureId} is long (${existing.tokens.total.toLocaleString('en-US')} tokens). A new session starts lighter: wisdom handoff ${command} --from ${source.captureId}`
    : undefined;
  return { command, args: [...args, prompt], cwd: workspaceRoot, env, prompt, from: source, target: existing, targetSource, note };
}
