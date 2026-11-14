import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { draftFrom, writeShare, type Exported } from '../share/share.js';
import { view } from '../read/views.js';
import { agentWork, projectOf, type CommitRecord } from './commits.js';
import { commitFiles, deleteRef, git, gitError, gitIdentity, gitText, listRefs, readFile, readPolicy, recordIds, recordRef, recorderId, recordsWithIds, teamCommit,
  refSafe, remoteRef, resolve, sessionRef, setRef, type Policy } from './gitrefs.js';
import { writeJson } from '../storage/ledger.js';
import { redactSecrets, scanSecrets } from '../share/secrets.js';
import type { SessionStore } from '../storage/store.js';
import type { SharedLibrary } from '../share/shared.js';

/** Team mode: sessions and commit records travel through the team's own git remote as hidden
 * refs, never a branch and never to Wisdom. Sessions go first, then the records that point to
 * them, so a record never names a session the remote lacks. Every session goes through the
 * share export, its secrets always redacted (no one is there to ask), never the raw `.wisdom/`
 * folder and never logins. Each push adds a version on top of the last, fast-forward only.
 */

const DELETED = 'refs/wisdom/deleted';
const FETCHED = 'refs/wisdom/fetched/sessions/';

interface Deleted { key: string; deletedAt: string; reason: 'deleted' | 'retention' }

function policyOrThrow(project: string): Policy {
  const policy = readPolicy(project);
  if (!policy) throw new Error(`This repository has no wisdom-team.json, so Wisdom is in local mode: nothing is pushed. An admin starts team mode with: wisdom team init`);
  return policy;
}

/** The remote's Wisdom refs for this repository. */
function remoteRefs(project: string, remote: string, policy: Policy): Map<string, string> {
  let out: string;
  try { out = gitText(project, ['ls-remote', remote, `refs/wisdom/${policy.repoId}/*`]); }
  catch (error) { throw new Error(`Cannot reach the remote "${remote}": ${gitError(error)}. Name another with --remote, or set "remote" in wisdom-team.json.`); }
  return new Map(out ? out.split('\n').map(line => { const [sha, ref] = line.split('\t'); return [ref, sha] as [string, string]; }) : []);
}

function readDeleted(project: string): Deleted[] {
  const bytes = readFile(project, DELETED, 'deleted.json');
  try { return bytes ? JSON.parse(bytes.toString('utf8')) : []; } catch { return []; }
}

/** Bring the deletion list and others' sessions and records here. Missing refs are fine. */
function fetchRefs(project: string, remote: string, policy: Policy, refs = remoteRefs(project, remote, policy)): Map<string, string> {
  const base = `refs/wisdom/${policy.repoId}/`;
  const specs = [`+${base}records/*:refs/wisdom/records/*`, `+${base}sessions/*:${FETCHED}*`];
  if (refs.has(`${base}deleted`)) specs.push(`+${base}deleted:${DELETED}`);
  if ([...refs.keys()].length) git(project, ['fetch', '--no-tags', '--quiet', remote, ...specs]);
  return refs;
}

const sessionKey = (recorder: string, id: string) => `${recorder}/${refSafe(id)}`;

/** Records reachable from HEAD that the remote does not have yet, of commits made in team mode
 * (teamCommit): work recorded before the policy file was committed is not sent. */
function unpushedRecords(project: string, policy: Policy, refs: Map<string, string>): { ref: string; sha: string; record: CommitRecord }[] {
  const history = new Set(gitText(project, ['rev-list', '--max-count=2000', 'HEAD']).split('\n'));
  return [...listRefs(project, 'refs/wisdom/records/')].flatMap(([ref, sha]) => {
    const commit = ref.slice('refs/wisdom/records/'.length);
    if (!history.has(commit) || refs.get(remoteRef(policy.repoId, ref)) === sha || !teamCommit(project, commit)) return [];
    const bytes = readFile(project, ref, 'record.json');
    return bytes ? [{ ref, sha, record: JSON.parse(bytes.toString('utf8')) as CommitRecord }] : [];
  });
}

/** Why the project's check stopped a session, in a few fixed words: its own output can quote
 * the very thing it refused, so it is never shown. */
function checkFailure(error: unknown): string {
  const e = error as { status?: number | null; signal?: string | null; code?: string; stderr?: Buffer | string };
  if (e.code === 'ETIMEDOUT' || e.signal) return 'the project\'s check timed out';
  const said = String(e.stderr ?? '');
  if (e.status === 127 || e.code === 'ENOENT' || /is not recognized|command not found|not found|No such file/i.test(said)) return 'the project\'s check could not run here';
  return 'refused by the project\'s check';
}

/** Records reachable from HEAD that are on the remote already, as this clone has them. */
function pushedRecords(project: string, policy: Policy, refs: Map<string, string>): CommitRecord[] {
  const history = new Set(gitText(project, ['rev-list', '--max-count=2000', 'HEAD']).split('\n'));
  return [...listRefs(project, 'refs/wisdom/records/')].flatMap(([ref]) => {
    if (!history.has(ref.slice('refs/wisdom/records/'.length)) || !refs.has(remoteRef(policy.repoId, ref))) return [];
    const bytes = readFile(project, ref, 'record.json');
    try { return bytes ? [JSON.parse(bytes.toString('utf8')) as CommitRecord] : []; } catch { return []; }
  });
}

/** A new version of one session on its ref: the redacted share file, and who recorded it. */
function sessionVersion(captures: SessionStore, project: string, dataDir: string, policy: Policy, id: string): { ref: string; sha: string; changed: boolean; note?: string } {
  const me = recorderId(dataDir);
  const ref = sessionRef(sessionKey(me, id));
  const parent = resolve(project, ref);
  const lastSeq = captures.database.lastSeq(id);
  const previous = parent ? readFile(project, parent, 'meta.json') : undefined;
  if (previous && JSON.parse(previous.toString('utf8')).lastSeq === lastSeq) return { ref, sha: parent!, changed: false };
  const exported = view(captures, { view: 'export', capture: id }) as Exported;
  const draft = draftFrom([exported]);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'wisdom-push-'));
  try {
    const file = path.join(temp, 'session.wisdom-share');
    // Pushing is unattended, so every finding is redacted, in this file only.
    writeShare(draft, draft.findings, file);
    if (policy.check) {
      try { execSync(`${policy.check} "${file}"`, { cwd: project, stdio: 'pipe', windowsHide: true, timeout: 120_000 }); }
      catch (error) { return { ref, sha: parent ?? '', changed: false, note: checkFailure(error) }; }
    }
    const manifest = exported.manifest;
    const meta = { sessionId: id, harness: manifest.harness, recorder: me, startedAt: manifest.startedAt, lastSeq,
      pushedAt: new Date().toISOString(), redactions: draft.findings.length,
      ...(policy.identity !== false ? { identity: gitIdentity(project) } : {}) };
    const sha = commitFiles(project, { 'session.wisdom-share': fs.readFileSync(file), 'meta.json': JSON.stringify(meta, null, 2) + '\n' },
      `wisdom session ${id}`, parent);
    setRef(project, ref, sha);
    return { ref, sha, changed: true, note: draft.findings.length ? `${draft.findings.length} possible secrets redacted` : undefined };
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}

/** Every string in a value with what the secret scan finds redacted, as in a share file. */
function redactStrings(value: unknown, found: Map<string, string>): unknown {
  if (typeof value === 'string') {
    const matches = scanSecrets(value);
    if (!matches.length) return value;
    for (const match of matches) found.set(match.value, match.kind);
    return redactSecrets(value, new Map(matches.map(match => [match.value, match.kind])));
  }
  if (Array.isArray(value)) return value.map(item => redactStrings(item, found));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactStrings(item, found)]));
  return value;
}

/** A record is pushed as its ref, every version in it. Its guide is text, and may quote a request
 * (the plain guide does, verbatim) or anything the model read, so before a push every version
 * not on the remote yet is scanned with the share file's patterns. When one holds something,
 * the versions not yet pushed are replaced by one redacted version on top of the remote's (or
 * alone), so no unredacted version leaves. The record is derived, not evidence: the sessions it
 * cites keep their originals. Returns how many values were redacted. */
function redactRecord(project: string, ref: string, remoteSha: string | undefined): number {
  const onRemote = remoteSha && (() => { try { git(project, ['cat-file', '-e', `${remoteSha}^{commit}`]); return true; } catch { return false; } })();
  let versions: string[];
  try { versions = gitText(project, ['rev-list', ref, ...(onRemote ? [`^${remoteSha}`] : [])]).split('\n').filter(Boolean); }
  catch { return 0; }
  if (!versions.some(version => scanSecrets(readFile(project, version, 'record.json')?.toString('utf8') ?? '').length)) return 0;
  const found = new Map<string, string>();
  const latest = JSON.parse(readFile(project, ref, 'record.json')!.toString('utf8'));
  const clean = redactStrings(latest, found);
  setRef(project, ref, commitFiles(project, { 'record.json': JSON.stringify(clean, null, 2) + '\n' },
    `wisdom record, ${found.size} possible secret(s) redacted before push`, onRemote ? remoteSha : undefined));
  return found.size;
}

export interface PushResult { remote: string;
  /** `heldBack`: the short cause, when the session was not pushed and Wisdom retries it at the next push. */
  sessions: { id: string; state: string; heldBack?: string }[]; records: number; missing: string[];
  /** Values the secret scan redacted in the commit records pushed. */
  recordRedactions: number }

/** `wisdom team push`: sessions first, then the records that name them, then a check that the
 * remote holds every session those records name. */
export function push(captures: SessionStore, dataDir: string, remoteName?: string): PushResult {
  const project = projectOf(captures);
  const policy = policyOrThrow(project);
  const remote = remoteName ?? policy.remote ?? 'origin';
  const me = recorderId(dataDir);
  const refs = fetchRefs(project, remote, policy);
  const deleted = new Set(readDeleted(project).map(d => d.key));
  const records = unpushedRecords(project, policy, refs);
  const own = new Set(captures.database.manifests().map(m => m.captureId));
  const mine = (record: CommitRecord) => record.sessions.filter(s => (s.recorder ?? me) === me && own.has(s.id)).map(s => s.id);
  // A session held back at an earlier push (the project's check refused it, or could not run)
  // while its record went: a record on the remote names it, the remote lacks it. Each push
  // tries it again, until it goes or the team deletes it.
  const onRemote = (id: string) => refs.has(remoteRef(policy.repoId, sessionRef(sessionKey(me, id))));
  const heldBack = new Set(pushedRecords(project, policy, refs).flatMap(mine).filter(id => !onRemote(id) && !deleted.has(sessionKey(me, id))));
  const wanted = [...new Set([...records.flatMap(({ record }) => mine(record)), ...heldBack])];
  const sessions: PushResult['sessions'] = [];
  const specs: string[] = [];
  for (const id of wanted) {
    if (deleted.has(sessionKey(me, id))) { sessions.push({ id, state: 'deleted by the team, not pushed' }); continue; }
    const version = sessionVersion(captures, project, dataDir, policy, id);
    if (!version.sha) { sessions.push({ id, state: `not pushed: ${version.note}`, heldBack: version.note }); continue; }
    const target = remoteRef(policy.repoId, version.ref);
    if (refs.get(target) !== version.sha) specs.push(`${version.ref}:${target}`);
    sessions.push({ id, state: [version.changed ? 'new version' : 'unchanged', version.note].filter(Boolean).join(', ') });
  }
  if (specs.length) {
    try { git(project, ['push', '--quiet', '--no-verify', remote, ...specs]); }
    catch (error) { throw new Error(`Sessions could not be pushed to ${remote}, so no records were pushed: ${gitError(error)}`); }
  }
  let recordRedactions = 0;
  for (const { ref } of records) recordRedactions += redactRecord(project, ref, refs.get(remoteRef(policy.repoId, ref)));
  const recordSpecs = records.map(({ ref }) => `${ref}:${remoteRef(policy.repoId, ref)}`);
  if (recordSpecs.length) {
    try { git(project, ['push', '--quiet', '--no-verify', remote, ...recordSpecs]); }
    catch (error) { throw new Error(`Records could not be pushed to ${remote}: ${gitError(error)}`); }
  }
  // Ready check: every session a pushed record names is on the remote.
  const after = remoteRefs(project, remote, policy);
  const missing = [...new Set(records.flatMap(({ record }) => record.sessions.map(s => sessionKey(s.recorder ?? me, s.id))))]
    .filter(key => !after.has(remoteRef(policy.repoId, sessionRef(key))));
  return { remote, sessions, records: records.length, missing, recordRedactions };
}

interface Imports { [key: string]: { commit: string; shareId: string } }
const importsFile = (dataDir: string) => path.join(dataDir, 'team-imports.json');

/** `wisdom team fetch`: teammates' sessions become read-only copies here (a newer version
 * replaces the older one), their records become readable, and the deletion list is applied. */
export function fetchTeam(captures: SessionStore, library: SharedLibrary, dataDir: string, remoteName?: string): { imported: string[]; removed: string[]; notRemoved: number; records: number } {
  const project = projectOf(captures);
  const policy = policyOrThrow(project);
  const remote = remoteName ?? policy.remote ?? 'origin';
  const me = recorderId(dataDir);
  library.finishRemovals();
  fetchRefs(project, remote, policy);
  const imports: Imports = fs.existsSync(importsFile(dataDir)) ? JSON.parse(fs.readFileSync(importsFile(dataDir), 'utf8')) : {};
  const deleted = new Set(readDeleted(project).map(d => d.key));
  const imported: string[] = [], removed: string[] = [];
  for (const [ref, sha] of listRefs(project, FETCHED)) {
    const key = ref.slice(FETCHED.length);
    if (key.startsWith(`${me}/`) || deleted.has(key) || imports[key]?.commit === sha) continue;
    const bytes = readFile(project, sha, 'session.wisdom-share');
    if (!bytes) continue;
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'wisdom-fetch-'));
    try {
      const file = path.join(temp, `${refSafe(key)}.wisdom-share`);
      fs.writeFileSync(file, bytes);
      const { store } = library.import(file);
      if (imports[key] && imports[key].shareId !== store.shared.shareId) library.remove(imports[key].shareId);
      imports[key] = { commit: sha, shareId: store.shared.shareId };
      imported.push(key);
    } finally { fs.rmSync(temp, { recursive: true, force: true }); }
  }
  for (const key of deleted) {
    // A copy whose folder could not be deleted yet stays on the library's pending list, which
    // finishes it at the next fetch or daemon start; it is not counted as removed until then.
    if (imports[key]) { if (library.remove(imports[key].shareId)) removed.push(key); delete imports[key]; }
    deleteRef(project, `${FETCHED}${key}`);
    if (key.startsWith(`${me}/`)) deleteRef(project, sessionRef(key));
  }
  writeJson(importsFile(dataDir), imports);
  return { imported, removed, notRemoved: library.pending.length, records: listRefs(project, 'refs/wisdom/records/').size };
}

/** Add keys to the team's deletion list and remove their refs from the remote. The list is
 * shared, so another clone cannot push a deleted session back. */
function deleteKeys(project: string, remote: string, policy: Policy, keys: string[], reason: Deleted['reason']): void {
  if (!keys.length) return;
  for (let attempt = 0; attempt < 2; attempt++) {
    const refs = fetchRefs(project, remote, policy);
    const list = readDeleted(project);
    const known = new Set(list.map(d => d.key));
    const now = new Date().toISOString();
    for (const key of keys) if (!known.has(key)) list.push({ key, deletedAt: now, reason });
    const parent = resolve(project, DELETED);
    const sha = commitFiles(project, { 'deleted.json': JSON.stringify(list, null, 2) + '\n' }, `wisdom: ${reason} ${keys.length} session(s)`, parent);
    const specs = [`${sha}:refs/wisdom/${policy.repoId}/deleted`,
      ...keys.map(key => remoteRef(policy.repoId, sessionRef(key))).filter(ref => refs.has(ref)).map(ref => `:${ref}`)];
    try { git(project, ['push', '--quiet', '--no-verify', remote, ...specs]); }
    catch (error) { if (attempt) throw new Error(`The deletion could not be pushed: ${gitError(error)}`); continue; }
    setRef(project, DELETED, sha);
    for (const key of keys) { deleteRef(project, `${FETCHED}${key}`); deleteRef(project, sessionRef(key)); }
    return;
  }
}

/** `wisdom team delete <session>`: by its ID, a prefix, or its full key (recorder/session). */
export function deleteTeamSession(captures: SessionStore, dataDir: string, name: string, remoteName?: string): string {
  const project = projectOf(captures);
  const policy = policyOrThrow(project);
  const remote = remoteName ?? policy.remote ?? 'origin';
  const refs = fetchRefs(project, remote, policy);
  const prefix = `refs/wisdom/${policy.repoId}/sessions/`;
  const keys = [...refs.keys()].filter(ref => ref.startsWith(prefix)).map(ref => ref.slice(prefix.length));
  const matches = keys.filter(key => key === name || key.split('/')[1] === refSafe(name) || (name.length >= 8 && key.split('/')[1]?.startsWith(name)));
  if (matches.length !== 1) throw new Error(matches.length ? `"${name}" matches ${matches.length} pushed sessions: ${matches.join(', ')}. Use the full key.` : `No pushed session matches "${name}".`);
  deleteKeys(project, remote, policy, matches, 'deleted');
  return matches[0];
}

/** `wisdom team prune`: remove pushed sessions older than the policy's retention, keeping any
 * a pushed record still names when the policy says so. */
export function prune(captures: SessionStore, remoteName?: string, now = Date.now()): string[] {
  const project = projectOf(captures);
  const policy = policyOrThrow(project);
  if (!policy.retentionDays) throw new Error('wisdom-team.json sets no retentionDays, so nothing is pruned.');
  const remote = remoteName ?? policy.remote ?? 'origin';
  fetchRefs(project, remote, policy);
  const referenced = new Set<string>();
  if (policy.keepReferenced !== false) {
    for (const [ref] of listRefs(project, 'refs/wisdom/records/')) {
      const bytes = readFile(project, ref, 'record.json');
      const record = bytes ? JSON.parse(bytes.toString('utf8')) as CommitRecord : undefined;
      for (const s of record?.sessions ?? []) if (s.recorder) referenced.add(sessionKey(s.recorder, s.id));
    }
  }
  const cutoff = now - policy.retentionDays * 86_400_000;
  const old = [...listRefs(project, FETCHED)].flatMap(([ref, sha]) => {
    const key = ref.slice(FETCHED.length);
    const meta = readFile(project, sha, 'meta.json');
    const startedAt = meta ? Date.parse(JSON.parse(meta.toString('utf8')).startedAt) : NaN;
    return Number.isFinite(startedAt) && startedAt < cutoff && !referenced.has(key) ? [key] : [];
  });
  deleteKeys(project, remote, policy, old, 'retention');
  return old;
}

/** `wisdom check --range base..head`, for CI: every commit of the PR with agent work has a
 * checked guide, and every session its record names is on the remote. Needs no data folder. */
export function prCheck(cwd: string, range: string, remoteName?: string): { ok: boolean; text: string } {
  const policy = policyOrThrow(cwd);
  const remote = remoteName ?? policy.remote ?? 'origin';
  const refs = fetchRefs(cwd, remote, policy);
  if (range.startsWith('-')) throw new Error(`"${range}" is not a range.`);
  const commits = gitText(cwd, ['rev-list', '--no-merges', '--reverse', range]).split('\n').filter(Boolean);
  const lines: string[] = [];
  let failed = 0;
  for (const sha of commits) {
    const subject = gitText(cwd, ['log', '-1', '--format=%s', sha]);
    lines.push(`${sha.slice(0, 12)}  ${subject}`);
    // A commit rewritten on the server (a squash merge) has no record under its own hash; the
    // records its message names through their Wisdom-Record lines stand for it.
    const own = readFile(cwd, recordRef(sha), 'record.json')?.toString('utf8');
    const ownId = own ? (JSON.parse(own) as CommitRecord).recordId : undefined;
    const carried = recordsWithIds(cwd, recordIds(cwd, sha).filter(id => id !== ownId)).filter(found => found.commit !== sha).map(found => found.text);
    const texts = [...own ? [own] : [], ...carried];
    if (!texts.length) { lines.push('    no record: made without Wisdom, or its record was not pushed (wisdom team push)'); continue; }
    if (carried.length) lines.push(`    carries ${carried.length} recorded commit${carried.length === 1 ? '' : 's'} through their Wisdom-Record lines`);
    let problems = 0;
    for (const text of texts) {
      const record = JSON.parse(text) as CommitRecord;
      const agent = agentWork(record);
      const missing = record.sessions.filter(s => s.recorder && !refs.has(remoteRef(policy.repoId, sessionRef(sessionKey(s.recorder, s.id))))).map(s => s.id);
      const found = [
        ...(agent && !record.guide && policy.requireGuides !== false ? [`agent work without a guide${record.guideMissing ? ` (${record.guideMissing})` : ''}`] : []),
        ...(agent && record.guide?.problems.length ? [`the guide did not pass its check: ${record.guide.problems.join('; ')}`] : []),
        ...missing.map(id => `session ${id.slice(0, 8)} is not on ${remote}`),
      ];
      problems += found.length;
      lines.push(`    ${found.length ? found.join(' · ') : [agent ? 'agent work' : 'no agent work recorded', record.guide ? `guide by ${record.guide.writer}` : '', `${record.sessions.length} sessions`].filter(Boolean).join(' · ')}`);
    }
    if (problems) failed++;
  }
  lines.unshift(`${commits.length} commits · ${failed ? `${failed} need attention` : 'all good'}`, '');
  return { ok: !failed, text: lines.join('\n') };
}
