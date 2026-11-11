import path from 'node:path';
import { applyPatch, diffArrays, parsePatch, reversePatch, structuredPatch } from 'diff';
import { hash } from '../storage/ledger.js';
import { EvidenceReader } from '../storage/evidence.js';
import { scope } from '../record/workspace.js';
import { git } from './gitrefs.js';
import type { LedgerRecord } from '../core/schema.js';
import type { SessionStore } from '../storage/store.js';

/** Which recorded steps made a commit, or the changes staged for one. Read-only: it asks git
 * for the files and follows the recorded file changes, by the hash of each file's whole
 * contents, from the file as it was before to the file as committed. A hash match is exact,
 * so a session is never linked because it touched the same file name, only because it
 * produced these bytes.
 */

export interface CommitInfo { sha: string; parent?: string; subject: string; committedAt: string; tree: string }

/** One piece of the commit (a hunk) and what produced it. `steps` are indexes into the
 * file's chain; `unexplained` counts its lines no recorded step accounts for. */
export interface Piece { header: string; steps: number[]; unexplained: number;
  /** The chain explains the file, but git's diff lines this hunk up differently: every step is listed. */
  byFile?: true }

export interface FileWork {
  path: string;
  operation: 'create' | 'modify' | 'delete';
  /** Why the file has no pieces: outside this project, excluded from recording, binary. */
  note?: 'outside-project' | 'not-watched' | 'binary';
  added: number; removed: number;
  /** The recorded changes, oldest first, that lead to the committed file. */
  chain: LedgerRecord[];
  /** The chain reaches back to the file as it was before the commit. */
  complete: boolean;
  /** Line-level pieces; absent when a step's patch is missing, so only the file is matched. */
  pieces?: Piece[];
  /** Why lines could not be matched, when `pieces` is absent but a chain exists. */
  lineGap?: string;
}

/** What to read: a commit against its first parent, or the index against `parent` (HEAD). */
export interface Target { parent?: string; rev: string | 'index'; until: number }

/** Changes observed this long after the commit's time still count: git stores whole seconds. */
const SLACK_MS = 1_000;

/** The forms a file can have on disk: as git writes it to this checkout (line endings and
 * filters applied) and as stored. An agent can write either (a new file with LF line endings
 * where git checks out CRLF), and the recorder hashed what was on disk. Empty when the file
 * does not exist there. */
function forms(cwd: string, rev: string | undefined, file: string): Buffer[] {
  if (!rev) return [];
  const spec = rev === 'index' ? `:${file}` : `${rev}:${file}`;
  const found: Buffer[] = [];
  for (const args of [['cat-file', '--filters', spec], ['cat-file', 'blob', spec]]) {
    try { const bytes = git(cwd, args); if (!found.some(other => other.equals(bytes))) found.push(bytes); } catch { /* not there */ }
  }
  return found;
}

/** Text the way the recorder decides it: UTF-8 that round-trips and has no NUL byte. */
function text(bytes: Buffer | undefined): string | null {
  if (!bytes) return '';
  const value = bytes.toString('utf8');
  return !bytes.includes(0) && Buffer.from(value).equals(bytes) ? value : null;
}

const lines = (value: string) => value ? value.split(/(?<=\n)/) : [];

export function readCommit(project: string, ref: string): CommitInfo {
  if (ref.startsWith('-')) throw new Error(`"${ref}" is not a commit.`);
  let out: string;
  try { out = git(project, ['log', '-1', '--format=%H%n%P%n%cI%n%T%n%s', `${ref}^{commit}`, '--']).toString('utf8'); }
  catch (error: any) {
    const reason = String(error?.stderr ?? error).trim().split('\n')[0];
    throw new Error(`git cannot read commit "${ref}" in ${project}: ${reason}`);
  }
  const [sha, parents, committedAt, tree, ...subject] = out.replace(/\n$/, '').split('\n');
  return { sha, parent: parents.split(' ').filter(Boolean)[0], committedAt, tree, subject: subject.join('\n') };
}

/** The recorded changes, oldest first, from one of the file's states `froms` to `to` (content
 * hashes; null is "no file"). Walks back from the newest change that produced `to`, each step
 * from a change that produced the one after it. Two sessions open in one project both see an
 * edit; the copy seen during a tool call is the one kept.
 */
export function chainOf(changes: LedgerRecord[], froms: (string | null)[], to: string | null): { chain: LedgerRecord[]; complete: boolean } {
  const chain: LedgerRecord[] = [];
  if (froms.includes(to)) return { chain, complete: true };
  let target = to;
  let bound = changes.length;
  while (bound > 0) {
    let i = bound - 1;
    while (i >= 0 && (changes[i].afterHash ?? null) !== target) i--;
    if (i < 0) break;
    const same = (r: LedgerRecord) => (r.afterHash ?? null) === target && (r.beforeHash ?? null) === (changes[i].beforeHash ?? null)
      && Math.abs(Date.parse(r.observedAt) - Date.parse(changes[i].observedAt)) <= 2_000;
    let first = i;
    while (first > 0 && same(changes[first - 1])) first--;
    const group = changes.slice(first, i + 1);
    const pick = group.find(r => r.attribution === 'observed-during-tool') ?? group.at(-1)!;
    chain.unshift(pick);
    target = pick.beforeHash ?? null;
    bound = first;
    if (froms.includes(target)) return { chain, complete: true };
  }
  return { chain, complete: false };
}

/** Each line of the committed file, and of the base, tied to the step that wrote or removed
 * it. Texts are rebuilt backwards from the committed file by undoing each recorded patch. */
function blame(chain: LedgerRecord[], patches: string[], committed: string) {
  const states = [committed];
  for (let k = chain.length - 1; k >= 0; k--) {
    const [patch] = parsePatch(patches[k]);
    const before = applyPatch(states[0], reversePatch(patch));
    if (before === false) return undefined;
    states.unshift(before);
  }
  let origin: (number | 'base')[] = lines(states[0]).map(() => 'base' as const);
  // The base line each current line came from, so a base line's removal can be found.
  let baseIndex: (number | undefined)[] = origin.map((_, i) => i);
  const removedBy = new Map<number, number>();
  for (let k = 0; k < chain.length; k++) {
    const next: typeof origin = [], nextBase: typeof baseIndex = [];
    let at = 0;
    for (const part of diffArrays(lines(states[k]), lines(states[k + 1]))) {
      const count = part.value.length;
      if (part.added) { for (let n = 0; n < count; n++) { next.push(k); nextBase.push(undefined); } continue; }
      if (part.removed) {
        for (let n = 0; n < count; n++) { const b = baseIndex[at + n]; if (b !== undefined) removedBy.set(b, k); }
      } else for (let n = 0; n < count; n++) { next.push(origin[at + n]); nextBase.push(baseIndex[at + n]); }
      at += count;
    }
    origin = next; baseIndex = nextBase;
  }
  return { base: states[0], origin, removedBy };
}

function excluded(file: string, excludedPaths: string[]): boolean {
  const parts = file.split('/');
  return parts.some(part => scope.excludedDirectories.includes(part))
    || excludedPaths.some(prefix => file === prefix || file.startsWith(prefix + '/'));
}

/** Each changed file of a commit or of the index, with the recorded steps that made it.
 * `project` is the folder Wisdom records; files elsewhere in the repository are listed as such. */
export function workFor(store: SessionStore, version: number, project: string, target: Target): FileWork[] {
  const prefix = git(project, ['rev-parse', '--show-prefix']).toString('utf8').trim();
  const listing = git(project, target.rev === 'index'
    ? ['diff', '--cached', '-z', '--no-renames', '--name-status', ...(target.parent ? [target.parent] : ['--root'])]
    : target.parent ? ['diff-tree', '-r', '-z', '--no-renames', '--name-status', target.parent, target.rev]
    : ['diff-tree', '-r', '-z', '--no-renames', '--name-status', '--root', '--no-commit-id', target.rev]).toString('utf8').split('\0').filter(Boolean);
  const manifests = store.database.manifests();
  const excludedPaths = [...new Set(manifests.flatMap(m => m.scope?.excludedPaths ?? []))];
  const reader = new EvidenceReader(store);
  const files: FileWork[] = [];

  for (let i = 0; i + 1 < listing.length; i += 2) {
    const status = listing[i], repoPath = listing[i + 1];
    const operation = status === 'A' ? 'create' : status === 'D' ? 'delete' : 'modify';
    const work: FileWork = { path: repoPath, operation, added: 0, removed: 0, chain: [], complete: false };
    files.push(work);
    if (prefix && !repoPath.startsWith(prefix)) { work.note = 'outside-project'; continue; }
    const file = repoPath.slice(prefix.length);
    work.path = file;
    const befores = forms(project, target.parent, repoPath);
    const afters = operation === 'delete' ? [] : forms(project, target.rev, repoPath);
    const changes = excluded(file, excludedPaths) ? [] : store.database.records(`type='file_change' AND path=? AND revision<=?`, [file, version])
      .filter(r => Date.parse(r.observedAt) <= target.until + SLACK_MS)
      .sort((a, b) => a.observedAt.localeCompare(b.observedAt) || a.seq - b.seq);
    // The committed form the recording reached; a complete chain beats a longer one.
    const fromHashes = befores.length ? befores.map(bytes => hash(bytes)) : [null];
    let pick = 0, found = chainOf(changes, fromHashes, afters.length ? hash(afters[0]) : null);
    for (let k = 1; k < afters.length; k++) {
      const other = chainOf(changes, fromHashes, hash(afters[k]));
      if (other.complete && !found.complete || other.complete === found.complete && other.chain.length > found.chain.length) { found = other; pick = k; }
    }
    const { chain, complete } = found;
    const after = afters[pick];
    // The parent in the form the chain starts from, else in the same form as the commit.
    const start = complete ? chain[0]?.beforeHash ?? (after ? hash(after) : null) : undefined;
    const before = befores.find(bytes => hash(bytes) === start) ?? befores[Math.min(pick, befores.length - 1)];
    const beforeText = text(before), afterText = text(after);
    if (beforeText !== null && afterText !== null) {
      const diff = structuredPatch('a', 'b', beforeText, afterText, '', '', { context: 0 });
      for (const hunk of diff.hunks) for (const line of hunk.lines) {
        if (line.startsWith('+')) work.added++; else if (line.startsWith('-')) work.removed++;
      }
    } else work.note = 'binary';
    if (excluded(file, excludedPaths)) { work.note = 'not-watched'; continue; }
    work.chain = chain; work.complete = complete;
    if (work.note === 'binary' || !chain.length) continue;

    const patches: string[] = [];
    for (const step of chain) {
      let patch: string | undefined;
      try { patch = reader.read(step, 'patch'); } catch { patch = undefined; }
      if (patch === undefined) break;
      patches.push(patch);
    }
    if (patches.length < chain.length) { work.lineGap = 'a recorded patch is missing, so lines are matched by file only'; continue; }
    const traced = blame(chain, patches, afterText!);
    if (!traced) { work.lineGap = 'the recorded patches do not rebuild the file, so lines are matched by file only'; continue; }

    work.pieces = [];
    for (const hunk of structuredPatch('a', 'b', beforeText!, afterText!, '', '', { context: 0 }).hunks) {
      const steps = new Set<number>();
      let unexplained = 0;
      const newFrom = hunk.newLines ? hunk.newStart - 1 : hunk.newStart;
      const oldFrom = hunk.oldLines ? hunk.oldStart - 1 : hunk.oldStart;
      // With a complete chain the base is the parent's file, so a line the chain carried over
      // unchanged is not new work: git's diff and the chain only lined repeated lines up differently.
      for (let n = 0; n < hunk.newLines; n++) {
        const origin = traced.origin[newFrom + n];
        if (typeof origin === 'number') steps.add(origin); else if (!complete) unexplained++;
      }
      for (let n = 0; n < hunk.oldLines; n++) {
        // Only a chain that starts at the parent's file can say who removed a parent line.
        const step = complete ? traced.removedBy.get(oldFrom + n) : undefined;
        if (step !== undefined) steps.add(step); else if (!complete) unexplained++;
      }
      const byFile = !steps.size && !unexplained;
      // Git's numbering, so the header matches `git show`: an empty range names the line before it.
      const range = (start: number, count: number) => `${count ? start : start - 1},${count}`;
      work.pieces.push({ header: `@@ -${range(hunk.oldStart, hunk.oldLines)} +${range(hunk.newStart, hunk.newLines)} @@`,
        steps: byFile ? chain.map((_, k) => k) : [...steps].sort((a, b) => a - b), unexplained, byFile: byFile || undefined });
    }
  }
  return files;
}

/** The project a data folder belongs to: `.wisdom/` sits in it. */
export function projectOf(store: SessionStore): string {
  return path.dirname(store.dataDir);
}

// ---------- the stored record ----------

/** One recorded step a piece cites, with what protects it: the change's file hashes and its
 * patch's hash. A reader checks these against the session it has, step by step, so trimming
 * or redacting one turn later flags only the commits that point at that turn. */
export interface RecordStep { session: string; position: string; attribution?: string; before: string | null; after: string | null; patch?: string }
export interface RecordPiece { header: string; steps: number[]; unexplained: number; byFile?: true }
export interface RecordFile {
  path: string; operation: FileWork['operation']; note?: FileWork['note']; added: number; removed: number;
  complete: boolean; lineGap?: string;
  /** Indexes into `steps`: the file's chain, oldest first. */
  chain: number[];
  pieces?: RecordPiece[];
}
export interface RecordSession { id: string; harness: string; recorder?: string; positions: string[] }
/** A guide is written by a model for reviewers, from the record and the steps it cites. It is
 * derived, never evidence: Wisdom checks that it covers every item and that each citation
 * exists, and keeps what that check found. */
export interface RecordGuide { text: string; writtenAt: string; writer: string; problems: string[]; derived: true }

/** Kept in `refs/wisdom/records/<commit>` (record.json), made when the commit is noticed. */
export interface CommitRecord {
  kind: 'wisdom-commit-record'; version: 1;
  commit: CommitInfo;
  /** `commit` when kept at commit time; `now` when worked out on request and never stored. */
  made: 'commit' | 'now';
  madeAt: string; wisdomVersion: string; recorder?: string;
  /** The `Wisdom-Record:` line in the commit's message. It survives what changes the hash
   * (amend, rebase, a squash merge on the server), so a reader can find this record again. */
  recordId?: string;
  steps: RecordStep[];
  files: RecordFile[];
  sessions: RecordSession[];
  guide?: RecordGuide;
  /** Why there is no guide, when it is on purpose (the person turned guides off) or failed. */
  guideMissing?: string;
}

/** Recorded steps an agent's tool call made: what makes a commit "agent work". */
export const agentWork = (record: CommitRecord) => record.steps.some(step => step.attribution === 'observed-during-tool');

/** The record for these files. `position` places a recorded change in its session. */
export function toRecord(files: FileWork[], position: (record: LedgerRecord) => string, harnessOf: (id: string) => string,
  base: Omit<CommitRecord, 'kind' | 'version' | 'steps' | 'files' | 'sessions'>): CommitRecord {
  const steps: RecordStep[] = [];
  const index = new Map<string, number>();
  const sessions = new Map<string, RecordSession>();
  const step = (record: LedgerRecord): number => {
    const known = index.get(record.id);
    if (known !== undefined) return known;
    const at = position(record);
    steps.push({ session: record.captureId, position: at, attribution: record.attribution, before: record.beforeHash ?? null, after: record.afterHash ?? null, patch: record.patchRef });
    index.set(record.id, steps.length - 1);
    const session = sessions.get(record.captureId) ?? sessions.set(record.captureId, { id: record.captureId, harness: harnessOf(record.captureId), recorder: base.recorder, positions: [] }).get(record.captureId)!;
    if (!session.positions.includes(at)) session.positions.push(at);
    return steps.length - 1;
  };
  const recordFiles = files.map(file => {
    const chain = file.chain.map(step);
    return { path: file.path, operation: file.operation, note: file.note, added: file.added, removed: file.removed, complete: file.complete,
      lineGap: file.lineGap, chain,
      pieces: file.pieces?.map(piece => ({ header: piece.header, steps: piece.steps.map(k => chain[k]), unexplained: piece.unexplained, byFile: piece.byFile })) };
  });
  return { kind: 'wisdom-commit-record', version: 1, ...base, steps, files: recordFiles, sessions: [...sessions.values()] };
}
