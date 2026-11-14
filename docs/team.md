# Team mode

Wisdom works on one machine by default (local mode). Team mode lets a team read each
other's sessions from a commit, through the team's own git remote. Nothing goes to
Wisdom: sessions and records are hidden git refs in your own repository.

A repository is in team mode when it has a committed `wisdom-team.json` at its top.
Without that file, Wisdom changes no commit message and pushes nothing, and by default
installs no git hooks and calls no model, so you can use Wisdom in any project, including open
source ones whose owners don't. See [Guides in local mode](#guides-in-local-mode).

## Guides in local mode

A guide is for anyone coming back to a commit, you included, so local mode has guides too.
Everything stays on your machine.

| Guide | How | Model | Stored |
| --- | --- | --- | --- |
| **Plain guide** | Always: `wisdom glance --commit <commit>` builds it from the commit's record when you read it, citing the step that made each piece and quoting what was asked in that turn. The same record gives the same text | None | Never: it is built each time |
| **Model guide, on request** | `wisdom guide <commit>`: a model writes it now, from the window kept in the commit's record (your previous commit on the branch up to this one), the same writer and check as team mode | Claude Haiku 5.5 through your Claude Code | In the commit's record, `refs/wisdom/records/<commit>`, in your own `.git` |
| **Model guide after each commit** | Opt-in: `wisdom guide on` installs one git hook, `post-commit`, in `.git/hooks`; `wisdom guide off` removes it. Off by default | Same | Same |

What `wisdom guide on` does not do in local mode: it adds no `prepare-commit-msg` (your commit
messages stay exactly as you write them), no `pre-push`, and it never pushes anything. A
hooks folder your repository tracks (Husky's `.husky/`, a `core.hooksPath` inside the
repository) is shared with your team, so Wisdom does not write into it and prints the line
to add instead.

`wisdom guide <commit>` needs the commit's kept record, recorded agent work, and the sessions
the record names. If a session was deleted since, it says so and writes nothing; the record
stays as it was. A model guide stored in a record is shown instead of the plain one.

**What leaves your machine in local mode:** a normal `git push` sends branches and tags only,
never `refs/wisdom/*`, `.wisdom/` (kept out by `.git/info/exclude`) or `.git/hooks`. A
`git push --mirror` sends every ref, so it would send your commit records and guides too. The
session text a model guide reads goes to the model's provider through your Claude Code login,
as it would in any Claude Code session.

## The workflow

1. **Record.** Agents work as usual. Every tool call and its diff is recorded locally.
2. **Commit.** Nobody waits and nothing changes in how anyone commits. Wisdom's
   `prepare-commit-msg` hook adds one line to the message, `Wisdom-Record: r-…`, which
   follows the commit through amends, rebases and a squash merge on the server.
3. **Record and guide, in the background.** The `post-commit` hook starts a job that keeps
   the commit's record (each piece, the step that made it) and, when the commit holds
   agent work, has a **guide** written: a short account for reviewers. It is written in
   two filters. First, without a model, the record shortlists the sessions whose recorded
   steps made the commit, and a **window** for each: its turns since your previous commit
   on this branch (the newest earlier commit this machine kept a record of, so never a
   pulled one), up to this commit. Then a cheap model, by default Claude Haiku 5.5 through
   your own Claude Code login, reads those windows with Wisdom's read-only ledger tool (its
   only tool) and writes the guide. It may read the whole window, because the reason for a
   change often sits in an earlier turn than the edit. Besides one paragraph per piece, the
   guide has a short section, "Beyond the edits", for what the edits alone do not show: where
   the agent did not do what was asked (or did it differently), reasons given in other turns,
   and the tests or checks run in the window and what they reported. A commit with more than
   30 pieces gets one item per set of steps that made several of them (a tool call that wrote
   2,000 files is one item listing its files), so its guide stays short enough to write in
   time. Wisdom checks that the guide covers
   every piece, that every citation names a real step in one of the commit's sessions, and
   that it falls inside that session's window, and keeps what that check found. It cannot
   check that the explanation is right, so a guide is always shown as derived, never as
   evidence.
4. **Push.** Your own `git push` carries everything. Wisdom's `pre-push` hook waits for any
   guide still being written, writes any that is missing, then sends the sessions those
   records name, then the records. Each session goes through the same export as
   `wisdom share`, with every possible secret redacted automatically. Each record is scanned
   with the same patterns, since its guide can quote a request (the plain guide does, word for
   word): when a version not yet on the remote holds one, those versions are replaced by one
   redacted version before the push, so none of them leaves. The sessions it cites keep their
   originals here. It never sends the `.wisdom/` folder or any login. A failure there never
   stops your push; it says so.
   Only commits made in team mode travel: a commit whose tree already holds
   `wisdom-team.json`. Work you recorded before team mode was turned on (local-mode records,
   their sessions, their guides) stays on your machine, and no guide is written for it at push.
5. **Review.** A reviewer runs `wisdom team fetch`, then `wisdom glance --commit <commit>`.
   Each piece points to the step that made it, checked against the fetched session, with
   the guide below. They open steps with `wisdom open t3/c2 --capture <session>`.
6. **CI.** `wisdom check --range <base>..<head>` checks the pull request: every commit with
   agent work has a guide that passed its check, and every session its record names is on
   the remote. This is the one check nobody can skip on their own machine.

A model writes guides by default. `wisdom guide off` stops calling a model for your own
commits: Wisdom writes a plain guide from the record instead, naming the step that made
each piece and quoting what was asked in that turn. It costs nothing and comes out the same
every time, but says nothing about why beyond those requests. Its writer is shown as
`Wisdom, no model (wisdom guide off)`, and the CI check accepts it. `wisdom guide on` turns
the model back on.

## Commands

| Command | What it does |
| --- | --- |
| `wisdom team init` | Writes `wisdom-team.json` with a new repo ID. An admin commits it. |
| `wisdom init`, `wisdom connect` | In a team-mode repository, also install the git hooks. |
| `wisdom team hooks on\|off` | Installs or removes the three git hooks. |
| `wisdom guide on\|off` | Team mode: who writes your guides, a model reading the sessions (on, the default) or Wisdom from the record with no model (off). Local mode: whether a model writes one after each commit (off by default; on installs only `post-commit`). Each commit's job goes by the switch, and by the policy's `guides` writer, as they were at that commit. |
| `wisdom guide <commit>` | A model writes that commit's guide now, in either mode, from its record's window. In team mode it goes with your next push; in local mode it stays on this machine. |
| `wisdom glance --commit <commit>` | A commit's pieces, the steps that made them, and its guide. |
| `wisdom check --range A..B` | For CI: needs no data folder. Exit code 1 when a commit needs attention. |
| `wisdom team push` | Sends your sessions and records now, without a `git push`. |
| `wisdom team fetch` | Brings teammates' sessions here, read-only, and applies the deletion list. |
| `wisdom team delete <session>` | Removes a pushed session for everyone and adds it to the deletion list, so no clone pushes it back. Your own recording stays. |
| `wisdom team prune` | Removes pushed sessions older than `retentionDays`. |

`--remote NAME` uses another remote than the policy's.

## The git hooks

| Hook | What it does | Can it stop git? |
| --- | --- | --- |
| `prepare-commit-msg` | Adds `Wisdom-Record: r-…` to the message. An amend keeps its line; a merge gets none. | No |
| `post-commit` | Starts the background job that keeps the record and has the guide written, detached so it outlives the agent's shell and session. Starts again any earlier job that died. | No |
| `pre-push` | Keeps the record and guide of any commit whose job died, waits for jobs still running (up to five minutes), writes missing guides, pushes sessions then records with `--no-verify`. | No |

Each commit's job has a file in `.wisdom/jobs/` while it runs, naming its process, and writes
one line to `.wisdom/jobs.log` when it ends: the commit, whether the record was kept, the
guide's writer and check, the writer's seconds and cost (when Claude Code reports it), and the
job's seconds. A job that died (its process gone, or never started) is started again by the
next commit or by the daemon, up to three times in all; after that the next `git push` or
`wisdom guide <commit>` keeps its record, labelled `record kept later` when that is more than
two minutes after the commit. A dead job never holds up a push.

They go into whatever folder git runs hooks from, `core.hooksPath` included. A hook that
was already there is kept as `<name>.pre-wisdom` and runs first; `wisdom team hooks off`
puts it back. A hooks folder the repository tracks (Husky's `.husky/`) belongs to the
team, so Wisdom does not write into it and prints the lines to add instead. While the hooks
are installed, the daemon's own commit watcher stands aside.

## The policy file

```json
{
  "version": 1,
  "repoId": "5d0c3c1e-8a5b-4b8e-9d0e-2f1c7a3b9e11",
  "remote": "origin",
  "identity": true,
  "requireGuides": true,
  "keepReferenced": true,
  "retentionDays": 90,
  "check": "node scripts/scan-session.mjs",
  "guides": { "model": "claude-haiku-5-5" }
}
```

| Field | Default | Meaning |
| --- | --- | --- |
| `repoId` | made by `team init` | Names this repository's refs on the remote, so one session repository can serve several. |
| `remote` | `origin` | Where sessions and records go. |
| `identity` | `true` | Each pushed session names its recorder's git name and email, labelled "git config": git does not verify it. |
| `requireGuides` | `true` | The CI check fails a commit with agent work and no guide that passed its check. |
| `retentionDays` | none | `wisdom team prune` removes pushed sessions older than this. |
| `keepReferenced` | `true` | Prune keeps sessions a pushed record still names. |
| `check` | none | Your own command, run on each session file before it is pushed, with the file's path last. It may change the file; a non-zero exit stops that session's upload. Wisdom's own filter is basic. Add your rules here. A session held back this way is tried again at each push, which says so in one line with a short cause (refused, could not run here, timed out), never the command's own output. |
| `guides.model` | `claude-haiku-5-5` | The model that writes guides. |
| `guides.command` | Claude Code (`claude -p --model <model>`, with only Wisdom's ledger tool) | Any other writer: it reads the prompt on stdin, prints the guide, and finds the model in `WISDOM_GUIDE_MODEL`. Use it for Codex, Pi, an API key, or a local model. It gets the cited steps already opened (up to 6,000 characters each, 60,000 in all) and may not use tools, so it does not read the rest of the window. The guide names its writer as the command followed by `(model not named)`, since the command picks its own model; set `guides.model` as well and it reads `<model> via <command>`. |

## What a guide costs

The writer starts from the record, the request of each turn involved and each cited step
(up to 20,000 characters handed to it), then reads the sessions' windows itself, in at most
30 model turns. What it reads grows with how much happened since your previous commit:
small commits made often keep guides cheap. In the first live tests (2026-11-13) a guide took
15,000 to 70,000 tokens and cost $0.0013 to $0.0081 at Claude Haiku 5.5's API price ($0.10
in, $0.50 out per million tokens); a long window costs more. On a subscription, it comes
from your plan. Each job's line in `.wisdom/jobs.log` shows its cost. `wisdom guide off`
costs nothing.

The writer's run is no one's session. Its hooks ignore it (`WISDOM_GUIDE_WRITER`), it runs
Claude Code with `--no-session-persistence` so no session file is kept, and the daemon never
records a session file whose first request is a guide writer's prompt. That matters when an
agent started with `wisdom track` commits: the writer then runs in that agent's home, which
is Wisdom's own.

## Where things live

| Locally | On the remote | Holds |
| --- | --- | --- |
| `refs/wisdom/records/<commit>` | `refs/wisdom/<repo-id>/records/<commit>` | `record.json`: each piece, its steps, each step's file and patch hashes, the guide and its check. |
| `refs/wisdom/sessions/<recorder>/<session>` | `refs/wisdom/<repo-id>/sessions/<recorder>/<session>` | `session.wisdom-share` (the redacted export) and `meta.json`. Each push adds a version on top of the last. |
| `refs/wisdom/deleted` | `refs/wisdom/<repo-id>/deleted` | The deletion list. |

`<recorder>` is a random ID made once per data folder, so two machines never clash. These
refs are never on a branch, never checked out, and not fetched by a plain `git clone`. A
`git push --mirror`, or a backup that copies every ref, does copy them.

Each step in a record keeps its file's hashes before and after, and its patch's hash. A
reader checks every step against the session it has: `changed since the commit` or
`session not available` marks only the steps affected.

A commit rewritten where Wisdom did not see it, such as a squash merge on GitHub, has no
record of its own. GitHub puts the squashed commits' messages in its body, so their
`Wisdom-Record:` lines come along, and `glance --commit` and the CI check read their
records instead. Those lines are the only link from the squashed commit to its records, so
keep them when you edit a squash message. To have GitHub copy them for you, set the default
squash message to "Pull request title and commit details" (repository Settings > General >
Pull Requests). Wisdom adds no warning line to each message: git strips lines starting with
`#`, a plain line can break git's trailer block, and it would be noise on every commit.

## CI

GitHub Actions, as an example:

```yaml
name: wisdom
on: pull_request
jobs:
  guides:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: actions/setup-node@v4
        with: { node-version: 24 }
      - run: npm install -g @oqura/wisdom
      - run: wisdom check --range origin/${{ github.base_ref }}..HEAD
```

## Limits

- Tested against GitHub (a private repository): push, fetch, deletion, the CI check, and
  squash, rebase and merge-commit merges. Not yet against GitLab.
- The default writer needs Claude Code installed and logged in. Without it, and with no
  `guides.command`, commits with agent work get no guide and say why; `wisdom guide off`
  gives them Wisdom's plain guide instead.
- `git push --mirror` sends every ref, `refs/wisdom/*` included, in either mode. A normal
  push does not.
- `wisdom guide <commit>` cannot write a guide once a session its record names was deleted.
  If you delete sessions often, `wisdom guide on` writes guides while they still exist.
- The window starts at your previous commit on the branch that this machine recorded. A
  session that only discussed or researched the work, and made none of the commit, is not
  shortlisted, so the guide cannot see it: keep one session per task.
- The check proves each citation exists and sits inside its window, not that the sentence
  citing it is right.
- A session is pushed whole, as one compressed file per version, about 100 KB for a typical
  session. Git cannot store only the difference between two compressed versions, so a session
  pushed after several commits costs its full size each time. Unrelated work in the same
  session travels too: one session per task keeps it out.
- A deleted session leaves every listing, but GitHub keeps its objects until its own cleanup,
  so someone with read access who knows the hash can still fetch it. A commit record removed
  from the remote stays in clones that fetched it; there is no command to delete a record.
- A huge commit (thousands of files) takes minutes to record, and its model guide can run out
  of time; the record says so, and CI flags it.
- Contributors from a fork cannot push hidden refs to the team's repository.
- The background job and `pre-push` read the recordings with their own connection to the
  database; a change the daemon has not yet seen when the commit is made is "not recorded".
