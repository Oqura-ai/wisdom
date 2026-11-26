/**
 * The Commits data contract: the files the builder writes and the Commits app reads.
 *
 * One builder, two sources (team: a clone of the remote, built in CI; local: this machine's
 * refs and recordings, live), one app. The app reads these files only, never git or the daemon,
 * so it can be served as static files behind the sign-in (design policy 5.19-5.26).
 *
 * Layout, all under the data folder:
 *   manifest.json                what was read and what was written; the app polls it for new data
 *   index.json                   the first page of main, active branches, people, sessions
 *   main/<page>.json             later pages of main (page 2 onward)
 *   change/<id>.json             one change: an open or merged pull request, or a branch's work
 *   commit/<sha>.json            one commit: how its record was found, its pieces, guide, sessions
 *   session/<key>/index.json     one session's turn list
 *   session/<key>/t<N>.json      one turn, in recorded order (opening a turn loads only this)
 *
 * Statuses and their reasons are decided by the builder, from what this snapshot can prove;
 * the app only shows them. The builder re-runs both checks itself on the snapshot (a guide's
 * check, guides.ts, and each step's hashes against its session), never trusting what a record
 * says it found. Everything here is plain JSON: no functions, no dates as objects.
 *
 * This file holds types only (and the version number), so the browser app can import it.
 */
import type { LinkBasis, LinkHow } from '../team/links.js';
import type { TurnItem } from '../read/conversation.js';

/** Raised when a file's shape changes in a way an older app cannot read. */
export const CONTRACT_VERSION = 1;

// ---------- statuses ----------

/** good: all good. look: look closer. attention: needs attention. none: no record (grey). */
export type Status = 'good' | 'look' | 'attention' | 'none';

/** Why a status is what it is. A fixed list, never raw error output (policy 5.9). */
export type ReasonCode =
  // look closer
  | 'outside-step'       // a piece no recorded step made
  | 'two-sessions'       // a piece two sessions both made
  // needs attention
  | 'session-missing'    // a session the record names is not in this snapshot
  | 'record-missing'     // a Wisdom-Record line, but no such record
  | 'order-link'         // linked by position only: the change is not identical
  | 'no-guide'           // agent work with no guide
  | 'guide-problems'     // a guide that failed its check
  // no record
  | 'no-record';         // no line, no record, no link

export interface Reason {
  code: ReasonCode;
  /** The thing it is about, when there is one: a session key, a file path, the commit a link names. */
  session?: string; path?: string; commit?: string;
  /** Fixed words for `record-missing`/`no-guide`/`no-record` causes, as `wisdom check` words them. */
  detail?: string;
}

/** A thing's status with the reasons behind it, worst first. Empty `reasons` only for `good`. */
export interface Verdict { status: Status; reasons: Reason[] }

// ---------- manifest.json ----------

export interface Manifest {
  contract: typeof CONTRACT_VERSION;
  wisdomVersion: string;
  /** team: read from a remote (deployed). local: this machine only (wisdom commits). */
  mode: 'team' | 'local';
  /** owner/name when known (GitHub), shown in the top bar. */
  repository?: string;
  builtAt: string;
  /** What this build read: one listing of refs, taken once at the start, so no page mixes two moments. */
  snapshot: {
    /** The remote's name or URL in team mode; absent in local mode. */
    remote?: string;
    readAt: string;
    /** The default branch's tip at that moment. */
    head: string;
  };
  /** Every input ref and its object id: the builder compares these to rebuild only what changed. */
  inputs: Record<string, string>;
  /** Every file written (path relative to the data folder) and its sha256: the app compares
   * these with what it has open to say "new data, reload". */
  files: Record<string, string>;
}

// ---------- shared pieces ----------

export interface Person {
  /** A username only (git name or GitHub login), never an email. */
  username: string;
  initials: string;
}

/** A commit as a row: enough to draw it on a canvas or list it. */
export interface CommitSummary extends Verdict {
  sha: string;
  subject: string;
  author: string;
  committedAt: string;
  /** All parents, first parent first. Two or more: a merge commit. */
  parents: string[];
  /** Sessions behind it, counted, not named by harness. */
  sessions: number;
  /** Set when a link says this commit came from others (amend, rebase, squash). */
  from?: CommitOrigin;
}

/** Where a rewritten commit came from, as its link says. */
export interface CommitOrigin {
  commits: string[];
  how: LinkHow;
  basis: LinkBasis;
  /** A recorder ID or the CI job. */
  writer: string;
  pr?: number;
}

// ---------- index.json and main/<page>.json ----------

export interface Index {
  /** The default branch's name. */
  main: string;
  /** The first page of main, newest first. */
  changes: MainPage;
  /** Branches with work not on main, active within `branchDays` (the app filters 7/30/90 from these). */
  branches: BranchSummary[];
  /** How far back `branches` reaches, in days (90, so every filter has its data). */
  branchDays: number;
  people: PersonSummary[];
  sessions: SessionSummary[];
}

/** One page of main's first-parent line, newest first. */
export interface MainPage {
  entries: MainEntry[];
  /** The next page's path (`main/2.json`), absent on the last page. */
  next?: string;
  /** On the last page: the commits from before team mode, folded into one line. */
  earlier?: { commits: number; oldest: string; newest: string };
}

/** One change that landed on main: a merged pull request (or branch), or a commit made straight on it. */
export type MainEntry =
  | ({ kind: 'change'; change: string; title: string; author: string; landedAt: string; how: LandHow;
      /** The commits it put on main's first-parent line (one for a squash or merge, several for a rebase). */
      onMain: string[]; commits: number; sessions: number } & Verdict)
  | { kind: 'direct'; commit: CommitSummary };

/** How a change landed: drawn on the canvas as a merge dip, a squash comb, or rebase ties. */
export type LandHow = 'merge' | 'squash' | 'rebase' | 'unknown';

export interface BranchSummary extends Verdict {
  name: string;
  /** The change page it opens to, when it has one (an open pull request; in local mode, any branch). */
  change?: string;
  author: string;
  lastActiveAt: string;
  /** Its commits not on main, newest first, at most 10 (`commits` counts them all). */
  recent: CommitSummary[];
  commits: number;
  sessions: number;
}

export interface PersonSummary extends Person {
  commits: number; sessions: number; changes: number;
  lastActiveAt: string;
}

export interface SessionSummary {
  key: string;
  /** The harness's own session ID. */
  id: string;
  /** Kept as a plain fact; the views never colour by it. */
  harness: string;
  person: string;
  title: string;
  turns: number;
  /** The commits whose records name it. */
  commits: string[];
  lastActiveAt: string;
}

// ---------- change/<id>.json ----------

export interface Change extends Verdict {
  /** The pull request number as text, or `b-<branch>` for a branch with no pull request. */
  id: string;
  /** Absent in local mode (no pull request numbers there) and for a branch with none. */
  pr?: number;
  title: string;
  state: 'open' | 'merged' | 'closed';
  author: string;
  branch: string;
  /** The commit on main it starts from. */
  base: string;
  /** Its commits, oldest first, as the branch had them. */
  commits: CommitSummary[];
  /** When merged: what it put on main, and how each new commit ties back to these commits. */
  landed?: { how: LandHow; at: string; onMain: { sha: string; merge?: true; from?: CommitOrigin }[] };
  sessions: string[];
  /** At most three things that need a look, worst first: the page opens with these. */
  needs: Reason[];
}

// ---------- commit/<sha>.json ----------

export interface Commit extends CommitSummary {
  message: string;
  /** The change it belongs to, when there is one. */
  change?: string;
  /** How its record was found, in the reader's order (policy 5.13): own record, link, Wisdom-Record line, unlinked. */
  found: { by: 'record' | 'link' | 'line' | 'unlinked'; recordId?: string; link?: CommitOrigin;
    /** Fixed words when unlinked or when the line names no record here. */
    cause?: string };
  pieces: Piece[];
  /** Absent when there is none; then `guideMissing` or a `no-guide` reason says why. */
  guide?: { text: string; writer: string; writtenAt: string; problems: string[]; costUsd?: number; seconds?: number };
  guideMissing?: string;
  /** The sessions its record names, present or not. */
  sessionsNamed: CommitSession[];
}

/** One piece of the commit's diff (a hunk, or a whole file when that is how it was matched). */
export interface Piece {
  path: string;
  header: string;
  added: number; removed: number;
  /** recorded: made by one recorded step. two-sessions: two sessions both made it. outside: no
   * recorded step made it. no-record: the commit has no record. */
  state: 'recorded' | 'two-sessions' | 'outside' | 'no-record';
  /** The steps that made it, oldest first. */
  steps: StepRef[];
}

export interface StepRef {
  session: string;
  /** The turn, and the ledger position (`t3/c2`, `t3/a1/c1`) for `wisdom open`. */
  turn: number; position: string;
  /** A subagent's ID, when one made it. */
  agent?: string;
  /** observed-during-tool / external-or-unknown, unchanged from the record. */
  attribution?: string;
}

export interface CommitSession {
  key: string; id: string; harness: string; person: string;
  /** Whether this snapshot has it. Missing: the commit needs attention. */
  present: boolean;
  /** The turns inside the record's window, first and last. */
  turns?: [number, number];
}

// ---------- session/<key>/index.json and t<N>.json ----------

export interface SessionTurns extends SessionSummary {
  turnList: { turn: number; request: string; at: string; steps: number; changes: number }[];
}

/** One turn as the Usage dashboard shows it: the same items, assembled in recorded order. */
export interface Turn {
  session: string; turn: number; at: string;
  request: string;
  items: TurnItem[];
  /** The commits that cite a step in this turn. */
  cited: string[];
}
