import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { gitText } from '../src/team/gitrefs.js';
import { checkRunText, reportCheck } from '../src/team/checkrun.js';
import type { CheckedCommit } from '../src/team/team.js';

const commit = (n: number, recorded: boolean, problems: string[] = []): CheckedCommit => ({ sha: String(n).repeat(40).slice(0, 40), subject: `Change ${n}`, recorded, problems });

test('the check run says the check\'s result in one line, worst first, and leads to the pull request on the dashboard', () => {
  const result = { ok: false, text: '3 commits · 1 need attention', commits: [commit(1, true), commit(2, true, ['agent work without a guide']), commit(3, false)] };
  const run = checkRunText(result, 'https://wisdom-app.vercel.app/', 124);
  assert.equal(run.title, '1 of 3 commits explained by recorded sessions · 1 needs attention · 1 without a record');
  assert.equal(run.ok, false, 'it reports the check\'s own outcome, never another');
  assert.match(run.summary, /\*\*Needs attention\*\*\n\n- `2222222` Change 2: agent work without a guide/);
  assert.match(run.summary, /\*\*No record\*\*.*These fail nothing\.\n\n- `3333333` Change 3: no record/s);
  assert.equal(run.detailsUrl, 'https://wisdom-app.vercel.app/#/change/124');
  assert.match(run.summary, /It updates a few minutes after each push/);
  assert.match(run.text!, /^```text\n3 commits/);

  const clean = checkRunText({ ok: true, text: '', commits: [commit(1, true), commit(2, true)] });
  assert.equal(clean.title, '2 of 2 commits explained by recorded sessions');
  assert.equal(clean.detailsUrl, undefined, 'no dashboard: no Details link, the summary stands alone');
  assert.match(clean.summary, /Every commit with a record passes/);
  assert.equal(checkRunText({ ok: true, text: '', commits: [] }).title, 'No commits to check');
});

test('in GitHub Actions: posted on the pull request\'s own head, written to the job summary, and a refusal changes nothing', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wisdom-checkrun-'));
  gitText(dir, ['init', '-q', '-b', 'main']);
  fs.writeFileSync(path.join(dir, 'wisdom-team.yaml'), 'version: 1\nrepoId: testrepo1\ncommits:\n  url: "https://wisdom-app.vercel.app"\n');
  const event = path.join(dir, 'event.json'), summary = path.join(dir, 'summary.md');
  fs.writeFileSync(event, JSON.stringify({ pull_request: { number: 124, head: { sha: 'a'.repeat(40) } } }));
  const posted: any[] = [];
  let refuse = false;
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      if (refuse) { response.writeHead(403); response.end('{}'); return; }
      posted.push({ url: request.url, auth: request.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
      response.writeHead(201, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ html_url: 'https://github.com/acme/app/runs/1' }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const env = { GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'acme/app', GITHUB_TOKEN: 'tok', GITHUB_SHA: 'b'.repeat(40), GITHUB_EVENT_PATH: event, GITHUB_STEP_SUMMARY: summary,
    GITHUB_API_URL: `http://127.0.0.1:${(server.address() as { port: number }).port}` };
  const result = { ok: false, text: 'the check\'s own text', commits: [commit(1, true, ['session 1234abcd is not on origin'])] };
  try {
    // Outside Actions: nothing posted, nothing written.
    assert.deepEqual(await reportCheck(dir, 'origin', result, {}), []);
    assert.equal(posted.length, 0);

    const lines = await reportCheck(dir, 'origin', result, env);
    assert.deepEqual(lines, ['Check run posted: https://github.com/acme/app/runs/1']);
    const [{ url, auth, body }] = posted;
    assert.equal(url, '/repos/acme/app/check-runs');
    assert.equal(auth, 'Bearer tok');
    assert.equal(body.head_sha, 'a'.repeat(40), 'the pull request\'s head, not the merge GitHub made for the run');
    assert.deepEqual([body.name, body.status, body.conclusion], ['Wisdom', 'completed', 'failure']);
    assert.equal(body.details_url, 'https://wisdom-app.vercel.app/#/change/124');
    assert.equal(body.output.title, '0 of 1 commit explained by recorded sessions · 1 needs attention');
    assert.match(fs.readFileSync(summary, 'utf8'), /^## Wisdom\n\n\*\*0 of 1 commit explained by recorded sessions · 1 needs attention\*\*/);

    // A fork's read-only token: refused, said in one line, and the job summary still has it.
    refuse = true;
    fs.rmSync(summary);
    const refused = await reportCheck(dir, 'origin', result, env);
    assert.match(refused[0], /^Check run not posted: GitHub answered 403 \(a pull request from a fork/);
    assert.match(fs.readFileSync(summary, 'utf8'), /needs attention/);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
