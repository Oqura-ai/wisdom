import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { commitFiles, gitText, recordRef, setRef } from '../src/team/gitrefs.js';
import { LedgerDatabase } from '../src/storage/database.js';
import { ReadStore } from '../src/storage/readstore.js';
import type { CommitRecord } from '../src/team/commits.js';
import { buildLocal, commitsDataDir, localMain, localSignature } from '../src/visualizer/local.js';
import { serveCommits } from '../src/visualizer/serve.js';
import { commitsStateFile } from '../src/service/commits.js';
import type * as C from '../src/visualizer/contract.js';

/** A repository with no team file and no remote: two commits from before Wisdom, then a
 * recorded one on main, and a recorded one on a branch. An empty recording beside it. */
function project() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wisdom-commits-local-'));
  const run = (...args: string[]) => gitText(dir, args);
  run('init', '-q', '-b', 'main');
  run('config', 'user.name', 'maya'); run('config', 'user.email', 'maya@example.com');
  const commit = (file: string, message: string) => {
    fs.writeFileSync(path.join(dir, file), message);
    run('add', '-A'); run('commit', '-q', '-m', message);
    return run('rev-parse', 'HEAD');
  };
  const record = (sha: string, subject: string) => {
    const value: CommitRecord = {
      kind: 'wisdom-commit-record', version: 1, commit: { sha, subject, committedAt: '2026-11-26T10:00:00Z', tree: '' },
      made: 'commit', madeAt: '2026-11-26T10:00:00Z', wisdomVersion: 'test', recorder: 'r1',
      steps: [{ session: 's1', position: 't1/c1', attribution: 'observed-during-tool', before: null, after: 'h' }],
      files: [{ path: `${subject}.txt`, operation: 'modify' as never, added: 1, removed: 0, complete: true, chain: [0], pieces: [{ header: '@@ -1 +1 @@', steps: [0], unexplained: 0 }] }],
      sessions: [{ id: 's1', harness: 'claude-code', recorder: 'r1', positions: ['t1/c1'] }],
    };
    setRef(dir, recordRef(sha), commitFiles(dir, { 'record.json': JSON.stringify(value) }, 'record'));
  };
  fs.writeFileSync(path.join(dir, '.gitignore'), '.wisdom/\n');
  commit('a.txt', 'Old work');
  commit('b.txt', 'Older work');
  const login = commit('login.txt', 'Add login');
  record(login, 'login');
  run('checkout', '-q', '-b', 'feat/y');
  const y = commit('y.txt', 'Try y');
  record(y, 'y');
  run('checkout', '-q', 'main');
  const dataDir = path.join(dir, '.wisdom');
  fs.mkdirSync(dataDir);
  new LedgerDatabase(path.join(dataDir, 'ledger.sqlite')).close();
  return { dir, dataDir, login, y, commit };
}

test('local Commits: this machine only, history before Wisdom folded, every branch its own page', () => {
  const p = project();
  assert.equal(localMain(p.dir), 'main');
  const built = buildLocal(p.dir, p.dataDir);
  assert.ok(built);
  assert.equal(built.manifest.mode, 'local');
  assert.equal(built.manifest.snapshot.remote, undefined, 'nothing is read from a remote');
  const read = (file: string) => JSON.parse(fs.readFileSync(path.join(commitsDataDir(p.dataDir), file), 'utf8'));
  const index = read('index.json') as C.Index;
  assert.equal(index.since, 'recording');
  assert.equal(index.changes.earlier?.commits, 2, 'the two commits from before Wisdom fold into one line');
  assert.deepEqual(index.changes.entries.map(e => e.kind === 'direct' ? e.commit.sha : e.change), [p.login]);
  const login = read(`commit/${p.login}.json`) as C.Commit;
  assert.equal(login.status, 'attention', 'its session is not in this machine\'s recordings');
  // Missing is said once: never also as a step that "changed" (the record has no guide either).
  assert.deepEqual(login.reasons.map(r => r.code), ['session-missing', 'no-guide']);
  assert.deepEqual(index.branches.map(b => [b.name, b.change]), [['feat/y', 'b-feat_y']]);
  assert.equal((read('change/b-feat_y.json') as C.Change).state, 'open');
});

test('local Commits: the signature moves with a commit, so a build follows it', () => {
  const p = project();
  const store = new ReadStore(p.dataDir);
  try {
    const before = localSignature(p.dir, store);
    assert.equal(localSignature(p.dir, store), before);
    p.commit('c.txt', 'Another change');
    assert.notEqual(localSignature(p.dir, store), before);
  } finally { store.close(); }
});

function get(url: string, pathname: string, options: { host?: string; method?: string } = {}): Promise<{ status: number; type?: string; body: string }> {
  const target = new URL(pathname, url);
  return new Promise((resolve, reject) => {
    const request = http.request({ host: target.hostname, port: target.port, path: pathname, method: options.method ?? 'GET',
      headers: { host: options.host ?? target.host } }, response => {
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode ?? 0, type: response.headers['content-type'], body: Buffer.concat(chunks).toString('utf8') }));
    });
    request.on('error', reject);
    request.end();
  });
}

test('local Commits is served on loopback, under its own name only, and stays live', async () => {
  const p = project();
  const app = fs.mkdtempSync(path.join(os.tmpdir(), 'wisdom-commits-app-'));
  fs.writeFileSync(path.join(app, 'index.html'), '<!doctype html><title>Commits</title>');
  const served = await serveCommits(p.dataDir, 0, app);
  try {
    assert.equal(JSON.parse(fs.readFileSync(commitsStateFile(p.dataDir), 'utf8')).url, served.url, 'it says where it listens');
    assert.match((await get(served.url, '/')).body, /Commits/);
    assert.match((await get(served.url, '/people')).body, /Commits/, 'any page path is the app (it routes in its hash)');
    const manifest = await get(served.url, '/data/manifest.json');
    assert.equal(manifest.status, 200);
    assert.match(manifest.type ?? '', /json/);
    const head = (JSON.parse(manifest.body) as C.Manifest).snapshot.head;
    // Never anything outside the app and its data: the recordings sit right beside them.
    assert.equal((await get(served.url, '/data/..%2f..%2fledger.sqlite')).status, 404);
    assert.equal((await get(served.url, '/..%2fledger.sqlite')).status, 404);
    assert.equal((await get(served.url, '/', { host: 'evil.example:80' })).status, 403, 'another hostname pointed here is refused');
    assert.equal((await get(served.url, '/', { method: 'POST' })).status, 405);

    const next = p.commit('d.txt', 'Live change');
    let seen = head;
    for (let attempt = 0; attempt < 50 && seen === head; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 200));
      seen = (JSON.parse((await get(served.url, '/data/manifest.json')).body) as C.Manifest).snapshot.head;
    }
    assert.equal(seen, next, 'a new commit is built without being asked');
  } finally { await served.close(); }
  assert.equal(fs.existsSync(commitsStateFile(p.dataDir)), false);
});
