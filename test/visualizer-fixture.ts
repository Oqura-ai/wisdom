/** The Commits test repository, shared by visualizer.test.ts and `npm run commits:sample`
 * (sample data for the app). Not a test file itself. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { commitFiles, gitText, recordRef, setRef } from '../src/team/gitrefs.js';
import { writeLink } from '../src/team/links.js';
import type { CommitRecord } from '../src/team/commits.js';
import type { BuildInput, Evidence } from '../src/visualizer/build.js';

/** A repository with each way a change lands on main, records and links written straight into
 * Wisdom's refs (no harness, no daemon), and a branch with work not on main. */
export function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wisdom-visualizer-'));
  const run = (...args: string[]) => gitText(dir, args);
  run('init', '-q', '-b', 'main');
  run('config', 'user.name', 'maya'); run('config', 'user.email', 'maya@example.com');
  const commit = (file: string, text: string, message: string) => {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), text);
    run('add', '-A'); run('commit', '-q', '-m', message);
    return run('rev-parse', 'HEAD');
  };
  const record = (sha: string, subject: string, options: { sessions?: string[]; guide?: string; twoSessions?: boolean; parent?: string } = {}) => {
    const sessions = options.sessions ?? ['s1'];
    const steps = sessions.map((id, k) => ({ session: id, position: `t${k + 1}/c1`, attribution: 'observed-during-tool', before: null, after: `h${k}` }));
    const value: CommitRecord = {
      kind: 'wisdom-commit-record', version: 1, commit: { sha, parent: options.parent, subject, committedAt: '2026-11-20T10:00:00Z', tree: '' },
      made: 'commit', madeAt: '2026-11-20T10:00:00Z', wisdomVersion: 'test', recorder: 'r1', steps,
      files: [{ path: `${subject}.txt`, operation: 'modify' as never, added: 1, removed: 0, complete: true, chain: steps.map((_, k) => k),
        pieces: [{ header: '@@ -1 +1 @@', steps: options.twoSessions ? steps.map((_, k) => k) : [0], unexplained: 0 }] }],
      sessions: sessions.map(id => ({ id, harness: 'claude-code', recorder: 'r1', positions: ['t1/c1'] })),
      guide: { text: options.guide ?? '## Summary\nfine', writtenAt: '2026-11-20T10:01:00Z', writer: 'test', problems: [], derived: true },
    };
    setRef(dir, recordRef(sha), commitFiles(dir, { 'record.json': JSON.stringify(value) }, 'record'));
  };

  commit('README.md', 'hello', 'Before team mode');
  const teamOn = commit('wisdom-team.yaml', 'repoId: test\n', 'Turn on team mode');
  // A merge commit: the branch's commit stays on main.
  run('checkout', '-q', '-b', 'chore/express-5');
  const x1 = commit('package.json', '{}', 'Bump express to 5.1');
  record(x1, 'x1');
  run('checkout', '-q', 'main');
  run('merge', '-q', '--no-ff', '-m', 'Merge pull request #121 from org/chore/express-5', '-m', 'Bump express to 5.1', 'chore/express-5');
  // A squash merge: the pull request's commits are gone from git, their records and the link stay.
  const g1 = 'a'.repeat(40), g2 = 'b'.repeat(40);
  record(g1, 'g1'); record(g2, 'g2', { sessions: ['sX'] });
  const s124 = commit('health.ts', 'ok', 'Healthcheck endpoint (#124)');
  writeLink(dir, { commit: s124, from: [g1, g2], how: 'squash-merge', basis: 'github', writer: 'ci', pr: 124 });
  // A direct commit whose guide fails its check.
  const d1 = commit('Dockerfile', 'FROM node', 'Pin Node 24');
  record(d1, 'd1', { guide: 'BAD guide' });
  // A rebase merge: two new commits, the second linked by position only.
  const o1 = 'c'.repeat(40), o2 = 'd'.repeat(40);
  record(o1, 'o1'); record(o2, 'o2');
  const r1 = commit('docs/a.md', 'a', 'Fix doc links');
  const r2 = commit('docs/b.md', 'b', 'Reword setup');
  writeLink(dir, { commit: r1, from: [o1], how: 'rebase-merge', basis: 'patch-id', writer: 'ci', pr: 126 });
  writeLink(dir, { commit: r2, from: [o2], how: 'rebase-merge', basis: 'order', writer: 'ci', pr: 126 });
  // Work not on main yet: one piece made by two sessions.
  run('checkout', '-q', '-b', 'feat/x');
  const f1 = commit('x.ts', 'x', 'Try backoff');
  record(f1, 'f1', { sessions: ['s1', 's2'], twoSessions: true });
  run('checkout', '-q', 'main');
  return { dir, teamOn, x1, s124, d1, r1, r2, f1, g1, g2 };
}

export const evidence: Evidence = {
  session: id => id === 'sX' ? undefined : { harness: 'claude-code', title: `session ${id}`, turns: 3 },
  step: () => 'ok',
  guide: text => text.includes('BAD') ? ['t9 names no real step'] : [],
};

export const input = (dir: string, mode: 'team' | 'local'): BuildInput => ({ project: dir, mode, main: { name: 'main', ref: 'refs/heads/main' },
  branches: [{ name: 'feat/x', ref: 'refs/heads/feat/x' }, { name: 'chore/express-5', ref: 'refs/heads/chore/express-5' }],
  evidence, wisdomVersion: 'test', now: new Date() });
