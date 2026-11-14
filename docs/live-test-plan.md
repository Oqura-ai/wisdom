# Live test plan

The full, step-by-step version of [live testing](live-testing.md). `npm test` uses stand-ins: a
fake guide writer, a git remote on disk, simulated hook events. This plan runs the real thing:
real agents, a real model writing guides, a real git host and a second person's clone. For each
case it says what to do, how to see the result, and what you should see.

Mark each case: ✅ as expected · ⚠️ works with a problem (write it down) · ❌ broken. A full run
takes about a day; the [checklist](live-testing.md#the-checklist) says which sections a change
needs.

## Setup

### The project

Make a new **private** repository on your git host (sessions are pushed to it, so never a public
one) with a small project:

| File | Why |
| --- | --- |
| `src/invoice.ts`, `src/format.ts`, `src/util.ts` | Ordinary code agents edit |
| `test/*.test.ts`, `package.json` with `"test": "node --test \"test/**/*.test.ts\""` | Agents run tests; CI runs them |
| `package-lock.json` | A big generated file |
| `assets/logo.png` | A binary file |
| `docs/notes.md` with CRLF endings, and `.gitattributes` | Line-ending conversion |
| A branch `stress` adding `vendor/` with 2,000 small files | The huge-commit case |

Leave some functions without comments: many cases ask an agent for a one-line comment, and an
agent that finds one already there correctly changes nothing.

### Two people on one machine

Clone the repository twice, as `alice/` and `bob/`, each with its own identity:

```sh
git config user.name "Alice (test)"; git config user.email alice@example.com   # in alice/
git config user.name "Bob (test)";   git config user.email bob@example.com     # in bob/
```

Each clone gets its own `.wisdom/` and its own daemon on its own port.

### Wisdom from your branch

Hooks store the full path of the installed copy, so install globally, never through `npx`:

```sh
wisdom daemon stop            # in every test clone, so no file is in use
npm pack                      # in your Wisdom checkout
npm install -g ./oqura-wisdom-<version>.tgz
wisdom --version              # your version, from the global install path
```

An `EBUSY` error during install means a daemon or dashboard is still running: stop it and
install again. After installing a new build, run `wisdom connect` again in each clone so the
agents' reading skill is current, and restart open agent sessions.

### Agents and cost

Claude Code, Codex and Pi installed and logged in. A model guide costs about $0.001 to $0.01
through your own Claude Code; a full run costs a few dollars of agent work and well under a
dollar of guides. The only secrets anywhere are fake ones you plant on purpose.

On Windows PowerShell with scripts blocked, use `wisdom.cmd` and `npm.cmd`.

## Seeing the proof

| To see | Run |
| --- | --- |
| Sessions | `wisdom glance`, `wisdom glance <id>`, `wisdom open t1/c1 --capture <id>` |
| A commit's pieces, window and guide | `wisdom glance --commit <sha>` |
| The stored record | `git show refs/wisdom/records/<full sha>:record.json`; versions: `git log --oneline refs/wisdom/records/<full sha>` |
| Wisdom refs here and on the remote | `git for-each-ref refs/wisdom`; `git ls-remote origin "refs/wisdom/*"` (hidden refs never show in the web UI) |
| A pushed session | `git fetch origin <ref>:refs/proof/s`, then `git show refs/proof/s:meta.json`; the share file is gzip, so search it after unpacking. Delete the ref afterwards: `git update-ref -d refs/proof/s` |
| Hooks | `ls .git/hooks` (Wisdom's start with `# wisdom`; your own become `<name>.pre-wisdom`) |
| Commit jobs | `.wisdom/jobs/` while one runs; `.wisdom/jobs.log`, one line per job (in PowerShell 5.1 read it with `Get-Content -Encoding utf8`) |
| Health | `wisdom doctor`; the health button in `wisdom dashboard` |

Read the proof yourself rather than trusting a summary line. For secrets, check the unpacked
share file and also count the `[redacted …]` markers: zero findings in an empty or wrong file
proves nothing.

## Where everything lives

| Place | What | Leaves the machine? |
| --- | --- | --- |
| `.wisdom/wisdom.json`, `ledger.sqlite` | The project marker; every record (inputs, calls, file changes, gaps) | Never |
| `.wisdom/harnesses/<harness>/<session>/` | A byte copy of the agent's transcript, payloads by hash | Never |
| `.wisdom/harnesses/<harness>/home/` | The agent's home for `wisdom track` (holds its login) | Never |
| `.wisdom/daemon.json`, `daemon.log`, `spool/` | The running daemon; events kept while it was down | Never |
| `.wisdom/config.json` | `guides: true/false` from `wisdom guide on/off` | Never |
| `.wisdom/jobs/`, `jobs.log` | A commit's record and guide job while it runs; its result line | Never |
| `.wisdom/recorder.json` | A random ID naming your sessions on the remote | Its ID, in ref names |
| `.wisdom/shared/`, `team-imports.json` | Teammates' sessions, read-only | Never |
| `.git/info/exclude` | Keeps `.wisdom/` and `wisdom connect`'s files out of git | Never |
| `.git/hooks/` | Team mode: `prepare-commit-msg`, `post-commit`, `pre-push`. Local mode with `wisdom guide on`: `post-commit` only | Never |
| The commit message | `Wisdom-Record: r-…` (team mode only) | With the commit |
| `refs/wisdom/records/<commit>` | The record: pieces, steps, window, a guide | Team mode: on push, redacted |
| `refs/wisdom/sessions/<recorder>/<session>` | `session.wisdom-share` (redacted) and `meta.json`, one version per push | Team mode: on push |
| `refs/wisdom/deleted`, `refs/wisdom/fetched/…` | The team's deletion list; teammates' refs as fetched | The list, yes |
| On the remote: `refs/wisdom/<repo-id>/{records,sessions,deleted}` | The team's copy | It is the remote |
| `wisdom-team.json` | The team policy | A tracked file |

## 1. Install and local basics

| # | Do | Proof | You should see |
| --- | --- | --- | --- |
| 1.1 | In alice: `wisdom init` | `ls .wisdom`; `git status`; `.git/info/exclude`; `ls .git/hooks` | `.wisdom/` with `wisdom.json`, `ledger.sqlite`, `harnesses/*/home`; `git status` clean; an exclude block naming `.wisdom/`; `.gitignore` unchanged; no Wisdom hooks |
| 1.2 | `wisdom connect` | `git status`; `.claude/settings.local.json` | Still clean; the settings name Wisdom's hook with `project` at the end |
| 1.3 | `wisdom track claude`, `track codex`, `track pi`; one small edit each | `wisdom glance` | Three sessions, three harnesses. Codex's first `/hooks` review session may appear as an empty fourth: expected |
| 1.4 | `wisdom glance <id>`; `wisdom open t1/c1 --capture <id>` | Output | The turn, the call, its patch |
| 1.5 | Ask an agent to read the last session with `wisdom glance` | `wisdom glance <that agent's session>` | `read Wisdom · N calls · C characters returned, about T tokens` |
| 1.6 | `wisdom doctor`; the dashboard's health button | Output; the popup | No problems |

## 2. Commits in local mode (no policy file)

Local mode calls no model and installs no git hook by default. A record is kept for each commit
you make while the daemon runs. It names its **window**: each session line ends `· window tA–tB`,
then `window: since your previous commit on this branch, <sha>`, or `from the start of these
sessions` when there is none.

When a kept record has agent work and no stored guide, `glance --commit` ends with a **plain
guide**, built when read and never stored:

```
guide · plain, built from the record now, no model · derived, not evidence · not stored; a model guide on request: wisdom guide <sha>
    ## Items
    - <file> @@ … @@ · t1/c3 in session 557d1563
      Made by [t1/c3 557d1563] (claude-code). Asked in t1: "<your request>".
```

| # | Do | Proof | You should see |
| --- | --- | --- | --- |
| 2.1 | An agent edits `src/invoice.ts`; **you** commit | `glance --commit HEAD`; the stored record | Each hunk → `t…/c… in session …`; `record kept when the commit was made`; the window; the plain guide, one item per hunk; no guide stored in the record |
| 2.2 | Edit `src/format.ts` yourself while a session runs; commit | `glance --commit HEAD` | `(changed outside any recorded step)`. Only your edit: no plain guide. The session that saw it is listed as a witness; in team mode it is pushed with the record |
| 2.3 | `wisdom daemon stop`, edit, commit, `wisdom daemon start` | `glance --commit HEAD` | `not recorded`; `worked out now`, or `record kept` if the daemon came back within 10 minutes |
| 2.4 | An agent replaces `assets/logo.png` | Same | `binary · whole file from t…` |
| 2.5 | An agent writes LF endings into `docs/notes.md` | Same | Matched to its step, not `not recorded` |
| 2.6 | An agent renames a file | Same | A delete and a create (known limit) |
| 2.7 | Add a path to `.wisdomignore`; an agent edits it | Same | `not recorded: excluded from recording` |
| 2.8 | Any local-mode commit | `git log -1 --format=%B`; `git status` | No `Wisdom-Record:` line; nothing tracked changed |
| 2.9 | **Two agents at once.** Claude: "first run `node -e "setTimeout(()=>{},45000)"`, then append a line to src/format.ts". About 5 s later, Codex: "append a line to src/util.ts". Commit both files | `glance --commit HEAD`; `wisdom open t1 --capture <each>` | Both sessions saw the util.ts change (`observed during c…`), but the commit gives it to the session whose call named the file or held the line (Codex); if neither did, it lists both. Never only the waiting session. Check the sessions really overlapped: the wait's start and end must bracket the other edit |
| 2.10 | An agent uses a subagent to edit | Same | Position `a1/c…` |
| 2.11 | `git worktree add ../wt -b wt`; an agent started in the main clone edits a file in `../wt`; commit in `../wt` | `glance --commit <sha>` | Matched by contents |
| 2.12 | **The window moves.** One session: t1 edit, commit A; t2 talk only; t3 edit, commit B | Records of A and B | B: `since <A>`, window `t1–t3`; t2 is inside although it changed nothing |
| 2.13 | **Another branch's commit.** `git checkout -b side`, edit, commit; back on your branch, edit, commit | The last record | The window starts at your previous commit on **your** branch, never at the side commit |
| 2.14 | `glance --commit HEAD` twice on a 2.1 commit | Both outputs; the record's version count | The same guide; still one version (reading writes nothing) |
| 2.15 | `wisdom guide HEAD` (a model guide on request) | Output; the record; `ls-remote` | `Guide written by claude-haiku-5-5 … it passed Wisdom's check`, `Kept in refs/wisdom/records/<sha>, on this machine only`; glance shows it instead of the plain one; nothing on the remote |
| 2.16 | `wisdom guide` on (a) a commit from before Wisdom ran, (b) a hand-edit commit, (c) a commit whose session you deleted | Output | (a) `No record was kept …`; (b) `… has no recorded agent work …`; (c) `No guide written: the guide must read session …`. No model is called |
| 2.17 | `wisdom guide on` in local mode | Output; `.git/hooks`; `.wisdom/config.json`; `git status` | Only a `post-commit` hook; `"guides": true`; messages unchanged, nothing pushed |
| 2.18 | With guides on: an agent edits, you commit, then `git push` | The message; `jobs.log`; the record; `ls-remote` | No `Wisdom-Record:`; a `jobs.log` line with writer seconds and cost; the guide in the record; the push sends no Wisdom refs |
| 2.19 | On a throwaway branch: track a `.husky/` folder, `git config core.hooksPath .husky`, `wisdom guide on` | Output; `git status` | Refuses to write into the tracked folder and prints the `post-commit` line to add. Then `git config --unset core.hooksPath` (it affects every branch) and delete the branch |
| 2.20 | `wisdom guide off` in local mode; an agent edits; commit | Output; hooks; glance | The hook removed; the plain guide again; earlier model guides kept |

## 3. Team mode setup

| # | Do | Proof | You should see |
| --- | --- | --- | --- |
| 3.1 | `wisdom team init`; commit and push `wisdom-team.json` | The file | `version`, a `repoId`, `remote: origin` |
| 3.2 | `wisdom init` in alice and bob | Output; `.git/hooks` | `Wisdom's git hooks are in …`; three hooks |
| 3.3 | `wisdom team hooks off`; add your own `.git/hooks/post-commit` (`echo mine`); `wisdom team hooks on`; commit | Output; hooks; the commit | `your own post-commit still runs first`; yours kept as `post-commit.pre-wisdom`; `mine` printed; the commit still gets its `Wisdom-Record:` line and record |
| 3.4 | On branch `husky`: tracked `.husky/`, `core.hooksPath .husky`, `wisdom team hooks on` | Output; `git status` | Refuses; prints the three lines to add; `.husky/` untouched. Unset `core.hooksPath` afterwards |
| 3.5 | `wisdom team hooks off`, then `on` | Hooks | Removed; then installed again with your own hook still chained |

## 4. Commit, record and guide (a real model)

The record shortlists the sessions that made the commit and each one's window. Then Claude Haiku,
through your Claude Code, with Wisdom's read-only `ledger` tool as its only tool, reads those
windows and writes the guide. Wisdom checks that it covers every piece and that every citation
exists, belongs to one of the commit's sessions and sits inside its window.

| # | Do | Proof | You should see |
| --- | --- | --- | --- |
| 4.1 | A Claude Code agent edits and **commits itself** | The commit returns at once; the message; `.wisdom/jobs/`; `jobs.log` after a minute | `Wisdom-Record: r-…`; a job file, then gone; `job · record kept · guide by claude-haiku-5-5 via Claude Code, reading the sessions' windows, check passed, writer N s, $0.00NN` |
| 4.2 | Read the guide | `glance --commit HEAD` | A summary, one item per piece, citations as `[t3/c2 …]` or `[t2 …]`. Judge by hand: right, plain, nothing invented |
| 4.3 | Time and cost | `jobs.log` | Write down seconds and cost per guide, for a one-turn window and a long one |
| 4.4 | The writer's own run, with an agent started by `wisdom track claude` and one from your own terminal | `wisdom glance` before and after; wait 3 minutes | No new session from the writer |
| 4.5 | A Codex agent commits; a Pi agent commits | Each record | Same as 4.1 |
| 4.6 | **You** commit an agent's edit | The record | A guide too |
| 4.7 | You commit only your own edit | The record; `jobs.log` | `not recorded`; `no guide (no agent work)` |
| 4.8 | `wisdom guide off`; an agent commits | `jobs.log`; glance | `guide by Wisdom, no model (wisdom guide off)` in about a second; each piece `Made by … Asked in …` |
| 4.9 | Set `"guides": { "command": "codex exec --skip-git-repo-check -" }` in `wisdom-team.json`; an agent edits; commit | `jobs.log`; glance | `guide by codex exec --skip-git-repo-check - (model not named)`; no cost shown (only Claude Code reports one). The switch and writer are fixed when you commit, so restoring the file right after is safe |
| 4.10 | In a terminal without `claude` on PATH, a Pi agent edits; commit | glance | `guide · none: no guide writer: Claude Code is not installed and wisdom-team.json names no guides.command`. Do not run `wisdom connect` in that terminal |
| 4.11 | `git commit --amend`; rebase a branch | Message; records | The same `Wisdom-Record:` line; a new record under each new hash |
| 4.12 | Three commits in a row in one agent turn | `.wisdom/jobs/`; `jobs.log` | Three `job ·` lines; three records with guides |
| 4.12b | The agent's last action is a commit; exit the agent at once | `jobs.log` after a minute | The record and guide arrive anyway; a job that died is retried (`attempt 2`) |
| 4.13 | **A reason in an earlier turn.** t1 states a rule with no edit ("discounts never exceed 50%, a client requirement"); t2 asks for the cap without saying why; commit | glance | The window holds t1–t2; the guide gives the reason and cites `[t1 …]` |
| 4.14 | The same with `wisdom guide off` | glance | The plain guide lacks the reason: the gap the model closes |
| 4.15 | Session X (Codex) only discusses; session Y (Claude) implements; commit | The record | Only Y is listed (known limit: one session per task) |
| 4.16 | **Where the agent departed.** t1: a question the agent answers; t2: ask for a comment that is wrong (it should correct you); t3: `npm test`; commit | glance | A `## Beyond the edits` section: the departure from the request, the reason from t1, and the test result |

## 5. Push and fetch through the git host

| # | Do | Proof | You should see |
| --- | --- | --- | --- |
| 5.1 | In alice: `git push` | Output | `Wisdom: N commit records and M session version(s) sent to origin.` |
| 5.1b | Branch from the commit **before** `wisdom-team.json`; an agent edits; commit; merge into main; push | `ls-remote`; output | That commit's record and session stay home; the merge commit has no record (git runs no post-commit for a merge) |
| 5.2 | Check the remote | `git ls-remote origin "refs/wisdom/*"` | `refs/wisdom/<repo-id>/records/<sha>` and `…/sessions/<recorder>/<session>` |
| 5.3 | What exactly was sent | `meta.json` of a pushed session | Harness, recorder, your git name and email with `"basis": "git config"`, `redactions` (distinct values); one commit per pushed version |
| 5.4 | Put a fake key (`sk-test-` and 20+ letters) and `DB_PASSWORD=fake…` in a prompt; commit; push | The unpacked share file; the pushed record; `wisdom open` locally | Neither value on the remote, `[redacted by sender: …]` in their place; your local session keeps them. Note what the host's own secret scanning says |
| 5.4b | The same with `wisdom guide off` (the plain guide quotes the request) | The pushed record | The quoted request is redacted too |
| 5.5 | Set `"check": "node -e process.exit(1)"`; an agent edits; commit; push | Output; `ls-remote` | The push goes through and names the session that stayed home with a short cause; the record is sent. Remove the check and push again: the session goes |
| 5.6 | In bob: `git pull`; `wisdom team fetch` | Output; `wisdom glance` | `N teammate sessions updated`; Alice's sessions listed as shared |
| 5.7 | Bob: `glance --commit <alice's sha>`; open a step; open the 5.4 session | Output | Steps without `(session not available)`; `[redacted …]` where Alice typed the key |
| 5.8 | Push with nothing new | Output | `0 commit records and 0 session version(s)` then `Everything up-to-date` |
| 5.9 | Bob: network off, push; network on, push | Output | Git fails before any hook runs; the next push sends everything |
| 5.10 | Size: mirror the remote into a scratch folder and measure code, sessions and records | `git clone --mirror`; object sizes | Write it down (about 100 KB per session version is typical) |
| 5.11 | Bob, after pulling Alice's commits: an agent edits; Bob commits | glance | The window starts at Bob's own previous commit, or `from the start of these sessions`; Alice's commits read `since the recorder's previous commit` on Bob's side |

## 6. Pull requests and CI

Add `.github/workflows/wisdom.yml` from [team mode](team.md#ci). If the published npm version is
older than your branch, commit your packed `.tgz` into the test repository and install it in the
workflow instead (`npm install -g ./<file>.tgz`): never publish a test version.

| # | Do | Proof | You should see |
| --- | --- | --- | --- |
| 6.1 | Push the workflow | The Actions tab | Runs on each PR |
| 6.2 | PR with an agent commit and a model guide | The check | Green: `agent work · guide by … · 1 sessions` |
| 6.3 | A guide-off agent commit (4.8) | The check | Green: `guide by Wisdom, no model (wisdom guide off)` |
| 6.3b | An agent commit with no writer (4.10) | The check | Red: `agent work without a guide (no guide writer …)` |
| 6.4 | An agent commit whose session stayed home (5.5) | The check | Red: `session … is not on origin` |
| 6.5 | A commit made with `wisdom team hooks off` | The check | `no record: …`, not counted as red |
| 6.6 | **Squash merge** | On main: `git log -1 --format=%B`; `glance --commit HEAD` | The body keeps `Wisdom-Record:`; `its message carries N recorded commits`, each under `── carried:` |
| 6.7 | Merge commit; rebase merge | `glance --commit HEAD^2`; `glance --commit HEAD` | The PR's commit has its own record; the rebased one carries the original |

Put several cases in one PR to save time: the check prints one line per commit.

## 7. Deletion and retention

| # | Do | Proof | You should see |
| --- | --- | --- | --- |
| 7.1 | Alice: `wisdom team delete <session>` | `ls-remote`; `git show refs/wisdom/deleted:deleted.json` | The ref gone here and on the remote; the key in the list; Alice's own recording kept |
| 7.2 | Bob: `wisdom team fetch`; read a commit that named it | Output; glance; `.wisdom/shared/` | `1 removed`; `(session not available)`; nothing of the session left on Bob's disk (imports and folders match, no `removing.json`) |
| 7.3 | Alice pushes again | `ls-remote` | Not pushed back |
| 7.4 | Set `"retentionDays": 1` (0 counts as unset); `wisdom team prune` | Output; the deletion list | With `keepReferenced`, only sessions no record names are removed |
| 7.5 | In an empty repo: `git fetch origin <a deleted session's commit sha>` | Output | Write down whether the host still serves it (GitHub does, until its own cleanup) |

## 8. Stress and failure

Run these on a throwaway branch you do not merge.

| # | Do | Proof | You should see |
| --- | --- | --- | --- |
| 8.1 | An agent runs `git checkout origin/stress -- vendor` (2,000 files); commit | `jobs.log` timing; the dashboard meanwhile | Every piece matched to that one step; write down the minutes. Known open: the record takes minutes and the model guide can time out |
| 8.2 | An agent runs an `npm install` that rewrites the lockfile; commit | `jobs.log`; glance | A short guide in seconds |
| 8.3 | An agent edits; `wisdom daemon stop` in another terminal; the agent edits again; commit | The record; the session | Both edits matched; the session states `not-recording-between-visits` and `delivered-late` |
| 8.4 | Commit, kill the job (its pid is in `.wisdom/jobs/<sha>.json`), push | `jobs.log`; output | `job (attempt 2) · record kept · guide …` |
| 8.4b | Push right after an agent commit | Output | `Wisdom: waiting for 1 commit guide to be written…`, then the push |
| 8.5 | `git push --mirror` to a scratch bare repo; a normal push to another | `git ls-remote <scratch> "refs/wisdom/*"` | The mirror carries every Wisdom ref, local-mode records and guides included (known, documented); the normal push carries none |
| 8.6 | A PR from a fork | The check | `no record: …` (a fork cannot push hidden refs) |
| 8.7 | Eight or so turns without committing, then one commit | `jobs.log`; glance | The window covers every turn; cost close to a one-turn guide; the guide still passes |
| 8.8 | With 2,000+ files in the working tree, exit Claude Code | The terminal | No `SessionEnd hook … failed: Hook cancelled` |

## 9. Measurement

Take 20 or more hunks from sections 2–8 whose author you know. The truth is independent of
Wisdom's answer: every line the commit added must appear in the **input** of the call that
`glance --commit` names. Do not count the patch Wisdom attached to that call, since it would only
confirm Wisdom's own guess. Count right, wrong, and `not recorded` that should have matched.

## Pitfalls from earlier runs

- **Ask for a change that is not already there.** An agent that finds the comment already written
  changes nothing, and the commit then has nothing in it.
- **One terminal with `claude` taken off PATH** stays that way until closed. Do not run
  `wisdom connect` or `wisdom track claude` in it.
- **Pasted terminal output wraps,** so words can look joined. Check a suspected typo in the code
  before reporting it.
- **`core.hooksPath` applies to the whole repository.** Unset it after 2.19 and 3.4, or no hook runs.
- **A long-running agent command is what makes 2.9 a real test.** Two quick edits one after the
  other prove nothing about sessions running at once.
- **Commit records are kept as made.** A fix to attribution or guides shows only on new commits;
  rerun the case.
- **Pushes go to your private test repository only.** Never point a test clone at a public remote.
