import path from 'node:path';
import { buildRecord } from '../read/discovery.js';
import { readCommit } from './commits.js';
import { hooksInstalled } from './githooks.js';
import { commitFiles, gitDirs, gitText, readHead, recordRef, refExists, recorderId, resolve, setRef } from './gitrefs.js';
import type { SessionStore } from '../storage/store.js';

/** Notices commits made in the project and keeps a record of each, in local git refs, so the
 * link survives the sessions it points to being cleaned up. No git hook is installed: a
 * project using Husky or its own hooks folder is never touched. Only commits by this person
 * (git's committer email), made while Wisdom runs, are recorded: not commits that arrive by
 * pull or checkout. Merges are not recorded. It never throws into the daemon.
 *
 * It runs on the daemon's timer, never inside a hook's request. HEAD is read from git's own
 * files, so the check costs no process; git runs only when a new commit has appeared.
 */
export class CommitWatcher {
  private head?: string;
  private lastPoll = 0;
  private hooks = false;
  private hooksCheckedAt = 0;

  readonly since = Date.now();

  constructor(private captures: SessionStore, private dataDir: string) {}

  get project(): string { return path.dirname(this.dataDir); }

  poll(force = false): string[] {
    const now = Date.now();
    if (!force && now - this.lastPoll < 1_000) return [];
    this.lastPoll = now;
    try {
      if (!gitDirs(this.project)) return [];
      // In team mode the git hooks keep records (and have guides written); this stands aside.
      if (now - this.hooksCheckedAt > 10_000) { this.hooks = hooksInstalled(this.project); this.hooksCheckedAt = now; }
      if (this.hooks && !force) return [];
      const fast = readHead(this.project);
      const head = fast === null ? resolve(this.project, 'HEAD') : fast;
      if (!head || head === this.head) return [];
      const previous = this.head;
      this.head = head;
      const list = previous ? gitText(this.project, ['rev-list', '--no-merges', '--max-count=50', `${previous}..${head}`]).split('\n').filter(Boolean) : [head];
      const made: string[] = [];
      for (const sha of list.reverse()) if (this.record(sha)) made.push(sha);
      return made;
    } catch (error) {
      console.error(`Wisdom could not record a commit: ${error instanceof Error ? error.message : error}`);
      return [];
    }
  }

  /** Keep a record for this commit, if it is this person's and new. */
  record(sha: string): boolean {
    const project = this.project;
    if (refExists(project, recordRef(sha))) return false;
    const [parents, committer] = gitText(project, ['log', '-1', '--format=%P%n%ce', sha]).split('\n');
    if (parents.trim().split(' ').length > 1) return false;
    let me = '';
    try { me = gitText(project, ['config', 'user.email']); } catch { /* no identity set: any committer */ }
    if (me && committer !== me) return false;
    const commit = readCommit(project, sha);
    if (Date.parse(commit.committedAt) < this.since - 10 * 60_000) return false;
    const record = buildRecord(this.captures, this.captures.database.revision, project, commit, { made: 'commit', recorder: recorderId(this.dataDir) });
    // No recordId: without Wisdom's hooks no line of the message is this commit's own; one
    // there was carried from another commit (a squash), and names that one.
    setRef(project, recordRef(sha), commitFiles(project, { 'record.json': JSON.stringify(record, null, 2) + '\n' }, `wisdom record for ${sha}`));
    return true;
  }
}
