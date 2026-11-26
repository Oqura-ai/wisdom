import { catFiles, commitFiles, FETCHED_LINKS, listRefs, readFile, recordText, resolve, setRef } from './gitrefs.js';
import type { CommitRecord } from './commits.js';

/** Commit links: how a commit that git or GitHub rewrote finds the records of the commits it
 * came from. An amend, a rebase, a squash or rebase merge on GitHub, a history cleanup: each
 * gives the work a new sha, and records are kept by sha. A link says "this commit came from
 * those", and comes only from something that saw the rewrite or can prove it:
 *
 *   git          git's own post-rewrite hook, which hands over the exact old and new shas
 *   github       GitHub's API: the pull request that made this commit, and its commits
 *   commit-map   git filter-repo's own old-to-new list
 *   patch-id     the same change (`git patch-id`), on a commit nobody linked
 *   order        a commit of a rebase merge whose change differs, between two that matched
 *
 * Never from a commit message or anything a person types, and never from a model. A link is
 * a new object beside the records: records, sessions and messages are never changed. One ref
 * per new commit, `refs/wisdom/links/<sha>` (link.json), so a lookup is one read and two
 * writers never conflict. A stronger link replaces a weaker one as a new version on top of it,
 * so its history stays.
 */

export type LinkHow = 'amend' | 'rebase' | 'squash-merge' | 'rebase-merge' | 'filter-repo' | 'rewrite';
export type LinkBasis = 'git' | 'github' | 'commit-map' | 'patch-id' | 'order';

export interface CommitLink {
  kind: 'wisdom-commit-link'; version: 1;
  /** The new commit, and the commits it came from (several for a squash or a fixup). */
  commit: string; from: string[];
  how: LinkHow; basis: LinkBasis;
  /** The pull request, when GitHub made the commit. */
  pr?: number;
  writtenAt: string;
  /** Who wrote it: a recorder ID (a person's data folder), or the CI job. */
  writer: string;
}

const STRENGTH: Record<LinkBasis, number> = { git: 3, github: 3, 'commit-map': 3, 'patch-id': 2, order: 1 };
/** Links that rest on a record of what happened, not on comparing content. */
export const exact = (basis: LinkBasis) => STRENGTH[basis] === 3;

export const linkRef = (commit: string) => `refs/wisdom/links/${commit}`;

function parse(bytes: Buffer | undefined): CommitLink | undefined {
  if (!bytes) return undefined;
  try {
    const link = JSON.parse(bytes.toString('utf8')) as CommitLink;
    return link?.kind === 'wisdom-commit-link' && Array.isArray(link.from) && STRENGTH[link.basis] ? link : undefined;
  } catch { return undefined; }
}

/** This clone's own link for a commit. */
export function ownLink(cwd: string, commit: string): CommitLink | undefined {
  return parse(readFile(cwd, linkRef(commit), 'link.json'));
}

/** The link for a commit: this clone's own, or a copy a pull or fetch brought, the stronger
 * of the two (this clone's own when they are as strong). */
export function readLink(cwd: string, commit: string): CommitLink | undefined {
  const own = ownLink(cwd, commit);
  const fetched = parse(readFile(cwd, `${FETCHED_LINKS}${commit}`, 'link.json'));
  if (!own || !fetched) return own ?? fetched;
  return STRENGTH[fetched.basis] > STRENGTH[own.basis] ? fetched : own;
}

/** Every link here, by commit, read in one git process: the same choice as `readLink` makes
 * for each (the stronger of this clone's own and a fetched copy, its own when as strong). */
export function loadLinks(cwd: string): Map<string, CommitLink> {
  const read = (prefix: string) => {
    const refs = [...listRefs(cwd, prefix).keys()];
    const bytes = catFiles(cwd, refs.map(ref => `${ref}:link.json`));
    return new Map(refs.flatMap((ref, k) => { const link = parse(bytes[k]); return link ? [[ref.slice(prefix.length), link] as const] : []; }));
  };
  const links = read('refs/wisdom/links/');
  for (const [commit, fetched] of read(FETCHED_LINKS)) {
    const own = links.get(commit);
    if (!own || STRENGTH[fetched.basis] > STRENGTH[own.basis]) links.set(commit, fetched);
  }
  return links;
}

export type LinkWrite = 'written' | 'kept' | 'joined' | 'replaced';

/** Keep a link here, unless an as-strong one is already kept. Two links from git for the same
 * commit are joined (a fixup gives git's hook its pairs in two goes: once while amending, once
 * at the end of the rebase). A stronger link replaces a weaker one, on top of it. */
export function writeLink(cwd: string, given: Omit<CommitLink, 'kind' | 'version' | 'writtenAt'> & { writtenAt?: string }): LinkWrite {
  const from = [...new Set(given.from)].filter(sha => sha !== given.commit);
  if (!from.length) return 'kept';
  const before = ownLink(cwd, given.commit);
  let link: CommitLink = { kind: 'wisdom-commit-link', version: 1, ...given, from, writtenAt: given.writtenAt ?? new Date().toISOString() };
  let outcome: LinkWrite = 'written';
  if (before) {
    if (before.basis === 'git' && link.basis === 'git') {
      const joined = [...new Set([...before.from, ...from])];
      if (joined.length === before.from.length) return 'kept';
      link = { ...link, from: joined, how: before.how === 'rebase' || link.how === 'rebase' ? 'rebase' : link.how };
      outcome = 'joined';
    } else if (STRENGTH[link.basis] > STRENGTH[before.basis]) outcome = 'replaced';
    else return 'kept';
  }
  const ref = linkRef(given.commit);
  setRef(cwd, ref, commitFiles(cwd, { 'link.json': JSON.stringify(link, null, 2) + '\n' }, `wisdom link for ${given.commit}`, resolve(cwd, ref)));
  return outcome;
}

/** A record a commit leads to through its links, or the commit where the way stops. */
export interface Linked {
  /** The commit whose record this is (or would be). */
  commit: string;
  /** Its record, when it is here. Absent: neither a record nor a link of it is here. */
  record?: CommitRecord;
  /** The links followed to get here, the new commit's first. */
  via: CommitLink[];
}

/** Follow a commit's links down to records. Undefined when the commit has no link. A commit
 * that was itself rewritten earlier (amended, then squashed) has a link of its own, followed
 * the same way. Each commit is visited once, so a loop of links ends. */
export function followLinks(cwd: string, commit: string, depth = 20): Linked[] | undefined {
  const top = readLink(cwd, commit);
  if (!top) return undefined;
  const found: Linked[] = [];
  const seen = new Set([commit]);
  const walk = (link: CommitLink, via: CommitLink[], left: number) => {
    for (const from of link.from) {
      if (seen.has(from)) continue;
      seen.add(from);
      const text = recordText(cwd, from);
      let record: CommitRecord | undefined;
      try { record = text ? JSON.parse(text) as CommitRecord : undefined; } catch { record = undefined; }
      if (record) { found.push({ commit: from, record, via: [...via, link] }); continue; }
      const next = left > 0 ? readLink(cwd, from) : undefined;
      if (next) walk(next, [...via, link], left - 1);
      else found.push({ commit: from, via: [...via, link] });
    }
  };
  walk(top, [], depth);
  return found;
}

/** How a link came about, in plain words. */
export function linkWords(link: CommitLink): string {
  const pr = link.pr ? ` of PR #${link.pr}` : '';
  const how = { amend: 'amended', rebase: 'rebased', 'squash-merge': `squash merge${pr}`, 'rebase-merge': `rebase merge${pr}`,
    'filter-repo': 'history rewritten by git filter-repo', rewrite: 'rewritten' }[link.how];
  const basis = { git: 'git reported the rewrite', github: 'from GitHub\'s pull request', 'commit-map': 'from git filter-repo\'s commit map',
    'patch-id': 'paired by patch-id: the same change', order: 'paired by position only, since its change differs: a weaker link' }[link.basis];
  return `${how}, ${basis}`;
}

/** What git's post-rewrite hook reads on stdin, one `<old> <new> [extra]` per line, as each new
 * commit with the commits it came from (a fixup or squash gives several). */
export function parseRewrites(input: string): Map<string, string[]> {
  const pairs = new Map<string, string[]>();
  for (const line of input.split(/\r?\n/)) {
    const [old, next] = line.trim().split(/\s+/);
    if (!/^[0-9a-f]{40,64}$/.test(old ?? '') || !/^[0-9a-f]{40,64}$/.test(next ?? '') || old === next) continue;
    const list = pairs.get(next) ?? pairs.set(next, []).get(next)!;
    if (!list.includes(old)) list.push(old);
  }
  return pairs;
}

/** git filter-repo's `.git/filter-repo/commit-map`: a header line, then `<old> <new>` per commit.
 * A commit filter-repo dropped maps to all zeros and is left out. */
export function parseCommitMap(text: string): [string, string][] {
  const out: [string, string][] = [];
  for (const line of text.split(/\r?\n/)) {
    const [old, next] = line.trim().split(/\s+/);
    if (!/^[0-9a-f]{40,64}$/.test(old ?? '') || !/^[0-9a-f]{40,64}$/.test(next ?? '') || /^0+$/.test(next) || old === next) continue;
    out.push([old, next]);
  }
  return out;
}

export interface Pairing { main: string; pr?: string; basis?: 'patch-id' | 'order' }

/** Pair the commits a rebase merge put on main with the pull request's commits, both oldest
 * first. First by patch-id (the same change); then each commit left over that sits between two
 * pairs (or the ends) with exactly as many left over on the pull request's side between the same
 * two pairs, in the same order. Anything else stays unpaired: a guess is never written. */
export function pairCommits(main: { sha: string; patchId?: string }[], pr: { sha: string; patchId?: string }[]): Pairing[] {
  const to = new Array<number>(main.length).fill(-1);
  const used = new Set<number>();
  main.forEach((commit, i) => {
    if (!commit.patchId) return;
    const j = pr.findIndex((other, k) => !used.has(k) && other.patchId === commit.patchId);
    if (j >= 0) { to[i] = j; used.add(j); }
  });
  const basis: Pairing['basis'][] = to.map(j => j >= 0 ? 'patch-id' : undefined);
  const anchors = [[-1, -1], ...to.flatMap((j, i) => j >= 0 ? [[i, j]] : []), [main.length, pr.length]];
  for (let k = 1; k < anchors.length; k++) {
    const [a, x] = anchors[k - 1], [b, y] = anchors[k];
    if (y <= x || b - a !== y - x) continue;
    for (let i = a + 1; i < b; i++) { const j = x + (i - a); if (!used.has(j)) { to[i] = j; used.add(j); basis[i] = 'order'; } }
  }
  return main.map((commit, i) => to[i] >= 0 ? { main: commit.sha, pr: pr[to[i]].sha, basis: basis[i] } : { main: commit.sha });
}
