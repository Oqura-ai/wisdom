/**
 * The Commits builder: one snapshot of a clone (team: the remote's refs fetched into a CI clone;
 * local: this machine's own) turned into the files of contract.ts.
 *
 * It reads git and Wisdom's refs only. Sessions come in through `Evidence`, so the builder
 * itself never opens a store: the caller decides where sessions live (a CI runner's imported
 * share files, or this machine's recordings). Every status is decided here, from what the
 * snapshot proves: the guide check and each step's hashes are re-run through `Evidence`,
 * never taken from what a record says it found (design policy 5.20-5.23).
 *
 * Reader order, as everywhere (policy 5.13): own record, then links, then Wisdom-Record lines.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { catFiles, git, listRefs, POLICY_FILE, recordRefs, refSafe } from '../team/gitrefs.js';
import { loadLinks, type CommitLink, type LinkBasis, type LinkHow } from '../team/links.js';
import { agentWork, type CommitRecord, type RecordStep } from '../team/commits.js';
import { problemSummary } from '../team/plain.js';
import { CONTRACT_VERSION, sessionPath } from './contract.js';
import type * as C from './contract.js';
import type { TurnItem } from '../read/conversation.js';
import type { GitHubFacts } from './github.js';

// ---------- inputs ----------

/** What the snapshot holds of sessions, and the two checks that need them. */
export interface Evidence {
  /** A session this snapshot has; undefined when it is not here. */
  session(id: string): { harness: string; title: string; turns: number; lastActiveAt?: string } | undefined;
  /** Whether the session a step cites still has that exact change (its file hashes and patch). */
  step(step: RecordStep): 'ok' | 'changed' | 'missing';
  /** What is wrong with a guide, checked against the sessions here (guides.ts). Empty: it passes. */
  guide(text: string, record: CommitRecord): string[];
  /** A session's turns in recorded order; each turn's items are assembled only when written. */
  turns?(id: string): { turn: number; at: string; request: string; items: () => TurnItem[] }[];
  /** A session's version, when known: while it is the same, its turn files are reused. */
  version?(id: string): string | undefined;
}

/** A file made only when written; with `session`, copied from the previous build instead while
 * that session's version is the same. */
export class Later {
  constructor(readonly make: () => unknown, readonly session?: { key: string; version: string }) {}
}

export interface BuildInput {
  project: string;
  mode: 'team' | 'local';
  /** The default branch's name, and the ref to read it from (`refs/remotes/origin/main` in CI). */
  main: { name: string; ref: string };
  /** Other branches with work, by name and the ref to read. */
  branches: { name: string; ref: string }[];
  evidence: Evidence;
  /** Pull request titles, states, branches and usernames, gathered first (github.ts). Without
   * them (local mode, another forge, GitHub unreachable) titles come from merge messages and
   * names from git, a GitHub noreply address still giving its username. */
  github?: GitHubFacts;
  remote?: string;
  repository?: string;
  wisdomVersion: string;
  now?: Date;
}

// The contract writes the link kinds out for the browser; these fail to compile if they drift from links.ts.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const howMatches: Same<LinkHow, C.LinkHow> = true, basisMatches: Same<LinkBasis, C.LinkBasis> = true;
void howMatches; void basisMatches;

/** Changes per page of main. */
export const MAIN_PAGE = 10;
/** How far back branches are listed; the app filters 7, 30 and 90 days from these. */
export const BRANCH_DAYS = 90;

// ---------- git ----------

/** `email` only puts a username on the commit; it is never written out. */
interface GitCommit { sha: string; parents: string[]; author: string; email: string; committedAt: string; subject: string; body: string }

const FORMAT = '%H%x1f%P%x1f%an%x1f%ae%x1f%cI%x1f%s%x1f%B%x1e';
function logCommits(project: string, args: string[]): GitCommit[] {
  let out: string;
  try { out = git(project, ['log', `--format=${FORMAT}`, ...args]).toString('utf8'); } catch { return []; }
  return out.split('\x1e').map(chunk => chunk.replace(/^\r?\n/, '')).filter(Boolean).map(chunk => {
    const [sha, parents, author, email, committedAt, subject, body] = chunk.split('\x1f');
    return { sha, parents: parents.split(' ').filter(Boolean), author, email, committedAt, subject, body: body ?? '' };
  });
}

/** A GitHub noreply address names its username: `12345+maya@users.noreply.github.com`. */
const noreplyLogin = (email: string) => /^(?:\d+\+)?([^@]+)@users\.noreply\.github\.com$/i.exec(email)?.[1];

const recordLines = (body: string) => [...body.matchAll(/^Wisdom-Record:\s*(r-[a-f0-9]{8,})\s*$/gm)].map(match => match[1]);
const turnOf = (position: string) => { const match = /^t(\d+)/.exec(position); return match ? Number(match[1]) : undefined; };
const agentOf = (position: string) => /(?:^|\/)(a\d+)(?:\/|$)/.exec(position)?.[1];
const initials = (name: string) => (name.match(/[A-Za-z0-9]+/g) ?? ['?']).slice(0, 2).map(part => part[0].toUpperCase()).join('');

// ---------- statuses ----------

const ATTENTION = new Set<C.ReasonCode>(['session-missing', 'record-missing', 'order-link', 'no-guide', 'guide-problems', 'step-changed']);
const LOOK = new Set<C.ReasonCode>(['outside-step', 'two-sessions']);
const rank = (code: C.ReasonCode) => ATTENTION.has(code) ? 0 : LOOK.has(code) ? 1 : 2;

/** The worst reason decides; reasons come worst first, each said once. */
export function verdict(reasons: C.Reason[]): C.Verdict {
  const seen = new Set<string>();
  const unique = reasons.filter(reason => { const key = JSON.stringify(reason); if (seen.has(key)) return false; seen.add(key); return true; });
  unique.sort((a, b) => rank(a.code) - rank(b.code));
  const worst = unique[0];
  const status: C.Status = !worst ? 'good' : ATTENTION.has(worst.code) ? 'attention' : LOOK.has(worst.code) ? 'look' : 'none';
  return { status, reasons: unique };
}

// ---------- the builder ----------

export function buildData(input: BuildInput): Map<string, unknown> {
  const { project, evidence } = input;
  const now = input.now ?? new Date();
  const files = new Map<string, unknown>();

  // Every record in the snapshot, by commit and by its Wisdom-Record ID. A record that names
  // another commit than the one it is kept under is not shown, as `glance --commit` does.
  // All read in one git process each: records, then links.
  const byCommit = new Map<string, CommitRecord>(), byId = new Map<string, CommitRecord>();
  const kept = [...recordRefs(project)];
  const recordBytes = catFiles(project, kept.map(([, ref]) => `${ref}:record.json`));
  kept.forEach(([commit], k) => {
    try {
      const record = JSON.parse(recordBytes[k]?.toString('utf8') ?? 'null') as CommitRecord | null;
      if (record?.kind !== 'wisdom-commit-record' || record.commit.sha !== commit) return;
      byCommit.set(commit, record);
      if (record.recordId) byId.set(record.recordId, record);
    } catch { /* an unreadable record is no record */ }
  });
  const links = loadLinks(project);
  const linkOf = (sha: string) => links.get(sha);
  // Commits links name that this clone does not have (squashed away): read from their records, never asked of git.
  const linkedFrom = [...new Set([...links.values()].flatMap(link => link.from))];
  const inGit = catFiles(project, linkedFrom.map(sha => `${sha}^{commit}`), true);
  const absent = new Set(linkedFrom.filter((_, k) => !inGit[k]));

  const github = input.github;
  /** Usernames only: GitHub's for the commit, else the one its email was seen with, else a
   * noreply address's, else git's author name. */
  const username = (sha: string, email: string, name: string) =>
    github?.loginBySha.get(sha) ?? (email ? github?.loginByEmail.get(email.toLowerCase()) ?? noreplyLogin(email) : undefined) ?? name;
  const known = new Map<string, GitCommit>();
  const learn = (list: GitCommit[]) => {
    for (const commit of list) { commit.author = username(commit.sha, commit.email, commit.author); known.set(commit.sha, commit); }
    return list;
  };
  /** A commit from git, or, for one this clone does not have (squashed away), from its record. */
  const gitCommit = (sha: string, fallbackAuthor = ''): GitCommit => {
    const found = known.get(sha) ?? (absent.has(sha) ? undefined : learn(logCommits(project, ['-1', sha]))[0]);
    if (found) return found;
    const record = byCommit.get(sha);
    return { sha, parents: record?.commit.parent ? [record.commit.parent] : [], author: username(sha, '', fallbackAuthor), email: '',
      committedAt: record?.commit.committedAt ?? '', subject: record?.commit.subject ?? '(not in this clone)', body: '' };
  };

  const sessions = new Map<string, C.SessionSummary>();
  const keyOf = (s: CommitRecord['sessions'][number]) => s.recorder ? `${s.recorder}/${s.id}` : s.id;

  // ----- one commit -----
  const commits = new Map<string, C.Commit>();
  /** Commits a change put on main (a squash's commit, a rebase's new shas, a merge commit): they
   * get their own page, standing for the commits they came from, but they are not counted again
   * (a session's commits, a person's commits, a turn's citing commits name the originals). */
  const standIns = new Set<string>();
  const analyse = (sha: string, fallbackAuthor?: string, standIn = false): C.Commit => {
    const cached = commits.get(sha);
    if (cached) return cached;
    const info = gitCommit(sha, fallbackAuthor);
    const own = byCommit.get(sha);
    const link = linkOf(sha);
    const origin = link ? originOf(link) : undefined;
    const reasons: C.Reason[] = [];
    let records: CommitRecord[] = [];
    let found: C.Commit['found'];

    if (own) {
      records = [own];
      found = { by: 'record', ...(own.recordId ? { recordId: own.recordId } : {}), ...(origin ? { link: origin } : {}) };
    } else if (link) {
      const reached = follow(sha);
      records = reached.flatMap(item => item.record ? [item.record] : []);
      for (const item of reached) if (!item.record) reasons.push({ code: 'record-missing', commit: item.commit, detail: 'no record of a commit it came from' });
      found = { by: 'link', link: origin, ...(records.length ? {} : { cause: 'no record of the commits it came from is here' }) };
    } else {
      const ids = recordLines(info.body);
      records = ids.flatMap(id => { const record = byId.get(id); return record && record.commit.sha !== sha ? [record] : []; });
      const absent = ids.filter(id => !byId.has(id));
      for (const id of absent) reasons.push({ code: 'record-missing', detail: `its Wisdom-Record line names ${id}, which is not here` });
      found = records.length ? { by: 'line' } : absent.length ? { by: 'line', cause: 'its Wisdom-Record line names a record that is not here' }
        : { by: 'unlinked', cause: 'no Wisdom-Record line, no record, no link: made without Wisdom, or the line was removed' };
    }
    if (link?.basis === 'order') reasons.push({ code: 'order-link', commit: link.from[0] });
    if (!records.length && !reasons.length && info.parents.length < 2) reasons.push({ code: 'no-record' });

    const fileChanges: C.FileChange[] = [];
    const named: C.CommitSession[] = [];
    let guide: C.Commit['guide'], guideMissing: string | undefined;
    for (const record of records) {
      for (const s of record.sessions) {
        const here = evidence.session(s.id);
        const key = keyOf(s);
        if (!here) reasons.push({ code: 'session-missing', session: key });
        if (!named.some(n => n.key === key)) named.push({ key, id: s.id, harness: here?.harness ?? s.harness, person: info.author, present: !!here, ...(s.turns ? { turns: s.turns } : {}) });
        if (standIn) continue;
        const summary = sessions.get(key) ?? { key, id: s.id, harness: here?.harness ?? s.harness, person: info.author, title: here?.title ?? '',
          turns: here?.turns ?? 0, commits: [], lastActiveAt: here?.lastActiveAt ?? info.committedAt, path: sessionPath(key) };
        if (!summary.commits.includes(sha)) summary.commits.push(sha);
        if (info.committedAt > summary.lastActiveAt) summary.lastActiveAt = info.committedAt;
        sessions.set(key, summary);
      }
      const states = record.steps.map(step => evidence.step(step));
      record.steps.forEach((step, k) => {
        const s = record.sessions.find(x => x.id === step.session);
        if (states[k] === 'changed') reasons.push({ code: 'step-changed', session: s ? keyOf(s) : step.session, detail: step.position });
      });
      const ref = (k: number): C.StepRef => {
        const step = record.steps[k];
        const s = record.sessions.find(x => x.id === step.session);
        const turn = turnOf(step.position), agent = agentOf(step.position);
        return { session: s ? keyOf(s) : step.session, position: step.position, ...(turn ? { turn } : {}), ...(agent ? { agent } : {}),
          ...(step.attribution ? { attribution: step.attribution } : {}) };
      };
      for (const file of record.files) {
        if (file.note === 'outside-project') continue;
        const groups = file.note === 'not-watched' ? [{ header: 'whole file', steps: [] as number[], unexplained: 0 }]
          : file.pieces ?? [{ header: 'whole file', steps: file.chain, unexplained: 0 }];
        const pieces: C.Piece[] = groups.map(group => {
          // A step made by no recorded tool call is not a recorded step (attribution external-or-unknown).
          const steps = group.steps.filter(k => record.steps[k]?.attribution !== 'external-or-unknown');
          const bySession = new Set(steps.map(k => record.steps[k].session));
          const state: C.Piece['state'] = !steps.length ? 'outside' : bySession.size > 1 ? 'two-sessions' : 'recorded';
          if (state === 'outside' || group.unexplained) reasons.push({ code: 'outside-step', path: file.path });
          if (state === 'two-sessions') reasons.push({ code: 'two-sessions', path: file.path });
          return { header: group.header, state, unexplained: group.unexplained, steps: steps.map(ref) };
        });
        fileChanges.push({ path: file.path, operation: file.operation, added: file.added, removed: file.removed,
          ...(file.note === 'binary' ? { binary: true as const } : {}), pieces });
      }
      if (agentWork(record)) {
        if (!record.guide) reasons.push({ code: 'no-guide', ...(record.guideMissing ? { detail: record.guideMissing } : {}) });
        else {
          const problems = evidence.guide(record.guide.text, record);
          if (problems.length) reasons.push({ code: 'guide-problems', detail: problemSummary(problems) });
        }
      }
      if (record.guide && !guide) {
        const g = record.guide;
        guide = { text: g.text, writer: g.writer, writtenAt: g.writtenAt, problems: evidence.guide(g.text, record),
          ...(g.costUsd !== undefined ? { costUsd: g.costUsd } : {}), ...(g.seconds !== undefined ? { seconds: g.seconds } : {}),
          ...(g.filled ? { filled: g.filled, items: g.items } : {}) };
      }
      if (!record.guide && record.guideMissing && !guideMissing) guideMissing = record.guideMissing;
    }

    const commit: C.Commit = {
      sha, subject: info.subject, author: info.author, committedAt: info.committedAt, parents: info.parents,
      sessions: named.length, ...(origin ? { from: origin } : {}), ...verdict(reasons),
      message: info.body.trimEnd() || info.subject, found, files: fileChanges,
      ...(guide ? { guide } : {}), ...(guideMissing ? { guideMissing } : {}), sessionsNamed: named,
    };
    commits.set(sha, commit);
    return commit;
  };

  /** A commit's links followed down to records, as links.ts does, from the records read above. */
  const follow = (sha: string): { commit: string; record?: CommitRecord }[] => {
    const out: { commit: string; record?: CommitRecord }[] = [];
    const seen = new Set([sha]);
    const walk = (link: CommitLink, left: number) => {
      for (const from of link.from) {
        if (seen.has(from)) continue;
        seen.add(from);
        const record = byCommit.get(from);
        if (record) { out.push({ commit: from, record }); continue; }
        const next = left > 0 ? linkOf(from) : undefined;
        if (next) walk(next, left - 1); else out.push({ commit: from });
      }
    };
    const top = linkOf(sha);
    if (top) walk(top, 20);
    return out;
  };

  const summary = (commit: C.Commit): C.CommitSummary => ({ sha: commit.sha, subject: commit.subject, author: commit.author,
    committedAt: commit.committedAt, parents: commit.parents, sessions: commit.sessions, ...(commit.from ? { from: commit.from } : {}),
    status: commit.status, reasons: commit.reasons });

  // ----- changes -----
  const changes = new Map<string, C.Change>();
  const changeOf = (id: string, base: Omit<C.Change, 'status' | 'reasons' | 'sessions' | 'needs' | 'id'>, extra: C.Reason[] = []): C.Change => {
    const all = [...base.commits.flatMap(c => c.reasons.map(reason => ({ ...reason, commit: reason.commit ?? c.sha }))), ...extra];
    const v = verdict(all);
    const keys = [...new Set(base.commits.flatMap(c => commits.get(c.sha)?.sessionsNamed.map(s => s.key) ?? []))];
    const change: C.Change = { id, ...base, ...v, sessions: keys, needs: v.reasons.filter(reason => rank(reason.code) < 2).slice(0, 3) };
    changes.set(id, change);
    return change;
  };

  // ----- main's first-parent line -----
  const line = learn(logCommits(project, ['--first-parent', input.main.ref]));
  // In team mode, commits from before the team file was committed can never have records: they fold into one line.
  // One git process asks every commit of the line whether it has the team file.
  const hasPolicy = catFiles(project, line.map(commit => `${commit.sha}:${POLICY_FILE}`), true);
  let teamFrom = line.length;
  const teamMode = line.length > 0 && !!hasPolicy[0];
  if (teamMode) {
    teamFrom = hasPolicy.findIndex(found => !found);
    if (teamFrom < 0) teamFrom = line.length;
  } else {
    // Without team mode (local, no team file), history before Wisdom first recorded a commit on
    // this line folds the same way: nothing older can have a record, and a long history would
    // otherwise be a page per commit, rebuilt live.
    const recorded = line.map(commit => byCommit.has(commit.sha) || !!linkOf(commit.sha) || recordLines(commit.body).length > 0);
    teamFrom = recorded.lastIndexOf(true) + 1;
  }
  const landed = line.slice(0, teamFrom), earlier = line.slice(teamFrom);
  const entries: C.MainEntry[] = [];
  for (let i = 0; i < landed.length; i++) {
    const top = landed[i];
    const link = linkOf(top.sha);
    if (top.parents.length > 1) {
      // A merge commit: its branch's own commits are on main themselves.
      const pr = /^Merge pull request #(\d+) from \S+?\/(\S+)/.exec(top.subject);
      const branchName = pr?.[2] ?? /^Merge branch '([^']+)'/.exec(top.subject)?.[1] ?? '';
      const own = learn(logCommits(project, ['--reverse', `${top.parents[0]}..${top.parents[1]}`]));
      const id = pr ? pr[1] : `m-${top.sha.slice(0, 12)}`;
      const list = own.map(c => summary(analyse(c.sha)));
      const about = pr ? github?.pulls.get(Number(pr[1])) : undefined;
      const title = about?.title || (pr ? (top.body.split('\n').slice(1).find(l => l.trim())?.trim() ?? top.subject) : top.subject);
      const change = changeOf(id, { ...(pr ? { pr: Number(pr[1]) } : {}), title, state: 'merged', author: about?.author || own[0]?.author || top.author, branch: about?.branch || branchName,
        base: top.parents[0], commits: list, landed: { how: 'merge', at: top.committedAt, onMain: [{ sha: top.sha, merge: true }] } });
      entries.push(mainChange(change, top, [top.sha], 'merge'));
      continue;
    }
    if (link && (link.how === 'squash-merge' || link.how === 'rebase-merge') && link.pr) {
      // A rebase merge put several commits on main: gather the run of commits from the same pull request.
      const run = [top];
      if (link.how === 'rebase-merge') {
        while (i + 1 < landed.length) {
          const next = linkOf(landed[i + 1].sha);
          if (next?.how !== 'rebase-merge' || next.pr !== link.pr) break;
          run.push(landed[++i]);
        }
      }
      run.reverse();
      const from = run.flatMap(c => linkOf(c.sha)?.from ?? []);
      const list = from.map(sha => summary(analyse(sha, top.author)));
      const linkReasons = run.flatMap(c => commitsLinkReasons(c.sha));
      const how: C.LandHow = link.how === 'squash-merge' ? 'squash' : 'rebase';
      const about = github?.pulls.get(link.pr);
      const change = changeOf(String(link.pr), { pr: link.pr, title: about?.title || top.subject.replace(/\s*\(#\d+\)$/, ''), state: 'merged',
        author: about?.author || list[0]?.author || top.author, branch: about?.branch ?? '', base: run[0].parents[0] ?? '', commits: list,
        landed: { how, at: top.committedAt, onMain: run.map(c => { const l = linkOf(c.sha)!; return { sha: c.sha, from: originOf(l) }; }) } }, linkReasons);
      entries.push(mainChange(change, top, run.map(c => c.sha), how));
      continue;
    }
    entries.push({ kind: 'direct', commit: summary(analyse(top.sha)) });
  }
  for (const change of changes.values()) for (const m of change.landed?.onMain ?? []) {
    if (commits.has(m.sha)) continue;
    const page = analyse(m.sha, change.author, true);
    page.change = change.id;
    standIns.add(m.sha);
  }
  function commitsLinkReasons(sha: string): C.Reason[] {
    const link = linkOf(sha);
    return link?.basis === 'order' ? [{ code: 'order-link', commit: sha }] : [];
  }
  function mainChange(change: C.Change, top: GitCommit, onMain: string[], how: C.LandHow): C.MainEntry {
    return { kind: 'change', change: change.id, title: change.title, author: change.author, landedAt: top.committedAt, how, onMain,
      commits: change.commits.length, sessions: change.sessions.length, status: change.status, reasons: change.reasons };
  }

  // ----- branches with work not on main -----
  const cutoff = now.getTime() - BRANCH_DAYS * 86_400_000;
  const branchList: C.BranchSummary[] = [];
  for (const branch of input.branches) {
    if (branch.name === input.main.name) continue;
    const own = learn(logCommits(project, ['--reverse', `${input.main.ref}..${branch.ref}`]));
    if (!own.length) continue;
    const tip = own[own.length - 1];
    if (Date.parse(tip.committedAt) < cutoff) continue;
    const list = own.map(c => summary(analyse(c.sha)));
    const v = verdict(list.flatMap(c => c.reasons.map(reason => ({ ...reason, commit: reason.commit ?? c.sha }))));
    const keys = new Set(list.flatMap(c => commits.get(c.sha)?.sessionsNamed.map(s => s.key) ?? []));
    // A branch with an open pull request opens to it. Local mode has no pull request numbers
    // (policy 5.20): there every branch opens to its own page.
    const pull = input.mode === 'team' ? github?.open.find(p => p.branch === branch.name && !p.fork) : undefined;
    const id = pull ? String(pull.number) : input.mode === 'local' ? `b-${refSafe(branch.name)}` : undefined;
    if (id) changeOf(id, { ...(pull ? { pr: pull.number } : {}), title: pull?.title || branch.name, state: 'open', author: pull?.author || own[0].author,
      branch: branch.name, base: own[0].parents[0] ?? '', commits: list });
    branchList.push({ name: branch.name, ...(id ? { change: id } : {}), author: tip.author, lastActiveAt: tip.committedAt,
      recent: [...list].reverse().slice(0, 10), commits: list.length, sessions: keys.size, ...v });
  }
  branchList.sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt));

  // ----- people -----
  const people = new Map<string, C.PersonSummary>();
  const touch = (name: string, at: string) => {
    if (!name) return undefined;
    const person = people.get(name) ?? { username: name, initials: initials(name), commits: 0, sessions: 0, changes: 0, lastActiveAt: at };
    if (at > person.lastActiveAt) person.lastActiveAt = at;
    people.set(name, person);
    return person;
  };
  for (const commit of commits.values()) { if (standIns.has(commit.sha)) continue; const p = touch(commit.author, commit.committedAt); if (p) p.commits++; }
  for (const change of changes.values()) { const p = touch(change.author, change.landed?.at ?? ''); if (p) p.changes++; }
  for (const s of sessions.values()) { const p = touch(s.person, s.lastActiveAt); if (p) p.sessions++; }

  // ----- pages -----
  const pages: C.MainPage[] = [];
  for (let start = 0; start < entries.length || !pages.length; start += MAIN_PAGE) pages.push({ entries: entries.slice(start, start + MAIN_PAGE) });
  pages.forEach((page, k) => { if (k + 1 < pages.length) page.next = `main/${k + 2}.json`; });
  if (earlier.length) pages[pages.length - 1].earlier = { commits: earlier.length, oldest: earlier[earlier.length - 1].sha, newest: earlier[0].sha };

  const index: C.Index = { main: input.main.name, since: teamMode ? 'team-mode' : 'recording', changes: pages[0], branches: branchList, branchDays: BRANCH_DAYS,
    people: [...people.values()].sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt)),
    sessions: [...sessions.values()].sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt)) };
  files.set('index.json', index);
  pages.slice(1).forEach((page, k) => files.set(`main/${k + 2}.json`, page));
  for (const change of changes.values()) {
    files.set(`change/${change.id}.json`, change);
    for (const c of change.commits) { const full = commits.get(c.sha); if (full && !full.change) full.change = change.id; }
  }
  for (const commit of commits.values()) files.set(`commit/${commit.sha}.json`, commit);

  // ----- sessions, one file per turn -----
  const cited = new Map<string, Map<number, Set<string>>>();
  for (const commit of commits.values()) for (const file of commit.files) for (const piece of file.pieces) for (const step of piece.steps) {
    if (step.turn === undefined || standIns.has(commit.sha)) continue;
    const turns = cited.get(step.session) ?? cited.set(step.session, new Map()).get(step.session)!;
    (turns.get(step.turn) ?? turns.set(step.turn, new Set()).get(step.turn)!).add(commit.sha);
  }
  if (evidence.turns) for (const s of sessions.values()) {
    const turns = evidence.turns(s.id);
    if (!turns.length) continue;
    const base = s.path;
    const citedBy = (turn: number) => [...cited.get(s.key)?.get(turn) ?? []];
    const listing: C.SessionTurns = { ...s, turnList: turns.map(t => ({ turn: t.turn, request: t.request, at: t.at, cited: citedBy(t.turn) })) };
    files.set(`${base}/index.json`, listing);
    const version = evidence.version?.(s.id);
    for (const t of turns) files.set(`${base}/t${t.turn}.json`, new Later((): C.Turn => ({ session: s.key, turn: t.turn, at: t.at, request: t.request, items: t.items() }),
      version ? { key: s.key, version } : undefined));
  }
  return files;
}

function originOf(link: CommitLink): C.CommitOrigin {
  return { commits: link.from, how: link.how, basis: link.basis, writer: link.writer, ...(link.pr ? { pr: link.pr } : {}) };
}

// ---------- writing ----------

const json = (value: unknown) => JSON.stringify(value);
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

/** Write the files and their manifest into `dir`, replacing what was there. Built beside it
 * and moved in, so a reader never sees half a build. The manifest is written last. A turn
 * whose session has the same version as in the build already in `dir` is copied from it;
 * `reused` counts those, `made` the files made now. */
export function writeData(dir: string, input: BuildInput, files: Map<string, unknown>): { manifest: C.Manifest; made: number; reused: number } {
  const head = git(input.project, ['rev-parse', input.main.ref]).toString('utf8').trim();
  const inputs: Record<string, string> = {};
  for (const [ref, sha] of listRefs(input.project, 'refs/wisdom/')) inputs[ref] = sha;
  const tips = new Map([...listRefs(input.project, 'refs/heads/'), ...listRefs(input.project, 'refs/remotes/')]);
  for (const branch of [input.main, ...input.branches]) { const sha = tips.get(branch.ref); if (sha) inputs[branch.ref] = sha; }

  let previous: C.Manifest | undefined;
  try { previous = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')) as C.Manifest; } catch { previous = undefined; }
  // A build by another contract version is never reused.
  if (previous?.contract !== CONTRACT_VERSION) previous = undefined;

  const building = `${dir}.building`;
  fs.rmSync(building, { recursive: true, force: true });
  const written: Record<string, string> = {}, sessions: Record<string, string> = {};
  let made = 0, reused = 0;
  for (const [name, value] of files) {
    const out = path.join(building, ...name.split('/'));
    fs.mkdirSync(path.dirname(out), { recursive: true });
    if (value instanceof Later && value.session) {
      sessions[value.session.key] = value.session.version;
      const old = path.join(dir, ...name.split('/'));
      if (previous?.sessions?.[value.session.key] === value.session.version && previous.files[name] && fs.existsSync(old)) {
        fs.copyFileSync(old, out);
        written[name] = previous.files[name];
        reused++;
        continue;
      }
    }
    // A turn is assembled only now, so a big build never holds every transcript at once.
    const text = json(value instanceof Later ? value.make() : value);
    fs.writeFileSync(out, text);
    written[name] = sha256(text);
    made++;
  }
  const manifest: C.Manifest = { contract: CONTRACT_VERSION, wisdomVersion: input.wisdomVersion, mode: input.mode,
    ...(input.repository ? { repository: input.repository } : {}), builtAt: (input.now ?? new Date()).toISOString(),
    snapshot: { ...(input.remote ? { remote: input.remote } : {}), readAt: (input.now ?? new Date()).toISOString(), head }, inputs, sessions, files: written };
  fs.mkdirSync(building, { recursive: true });
  fs.writeFileSync(path.join(building, 'manifest.json'), json(manifest));
  // A file the server is sending can hold the old folder for a moment on Windows: retry briefly.
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  fs.renameSync(building, dir);
  return { manifest, made, reused };
}
