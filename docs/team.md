# Team mode

Wisdom works on one machine by default (local mode). Team mode lets a team read each
other's sessions from a commit, through the team's own git remote. Nothing goes to
Wisdom: sessions and records are hidden git refs in your own repository.

A repository is in team mode when it has a committed `wisdom-team.json` at its top.
Without that file, Wisdom installs no git hooks, changes no commit message, pushes nothing
and writes no guides, so you can use Wisdom in any project, including open source ones whose
owners don't.

## The workflow

1. **Record.** Agents work as usual. Every tool call and its diff is recorded locally.
2. **Commit.** Nobody waits and nothing changes in how anyone commits. Wisdom's
   `prepare-commit-msg` hook adds one line to the message, `Wisdom-Record: r-…`, which
   follows the commit through amends, rebases and a squash merge on the server.
3. **Record and guide, in the background.** The `post-commit` hook starts a job that keeps
   the commit's record (each piece, the step that made it) and, when the commit holds
   agent work, has a **guide** written: a short account for reviewers. A cheap model writes
   it, by default Claude Haiku 5.5 through your own Claude Code login, from the record and
   the steps it cites. Wisdom checks that the guide covers every piece and that every
   citation names a real step, and keeps what that check found. It cannot check that the
   explanation is right, so a guide is always shown as derived, never as evidence.
4. **Push.** Your own `git push` carries everything. Wisdom's `pre-push` hook waits for any
   guide still being written, writes any that is missing, then sends the sessions those
   records name, then the records. Each session goes through the same export as
   `wisdom share`, with every possible secret redacted automatically. It never sends the
   `.wisdom/` folder or any login. A failure there never stops your push; it says so.
5. **Review.** A reviewer runs `wisdom team fetch`, then `wisdom glance --commit <commit>`.
   Each piece points to the step that made it, checked against the fetched session, with
   the guide below. They open steps with `wisdom open t3/c2 --capture <session>`.
6. **CI.** `wisdom check --range <base>..<head>` checks the pull request: every commit with
   agent work has a guide that passed its check, and every session its record names is on
   the remote. This is the one check nobody can skip on their own machine.

Guides are on by default. `wisdom guide off` turns them off for your own commits; their
records then say "turned off by the person who committed", and the team's CI decides what
that means. `wisdom guide on` turns them back on.

## Commands

| Command | What it does |
| --- | --- |
| `wisdom team init` | Writes `wisdom-team.json` with a new repo ID. An admin commits it. |
| `wisdom init`, `wisdom connect` | In a team-mode repository, also install the git hooks. |
| `wisdom team hooks on\|off` | Installs or removes the three git hooks. |
| `wisdom guide on\|off` | Have guides written for your commits (on by default). |
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
| `post-commit` | Starts the background job that keeps the record and has the guide written. | No |
| `pre-push` | Waits for those jobs (up to two minutes), writes missing guides, pushes sessions then records with `--no-verify`. | No |

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
| `check` | none | Your own command, run on each session file before it is pushed, with the file's path last. It may change the file; a non-zero exit stops that session's upload. Wisdom's own filter is basic. Add your rules here. |
| `guides.model` | `claude-haiku-5-5` | The model that writes guides. |
| `guides.command` | Claude Code (`claude -p --model <model>`) | Any other writer: it reads the prompt on stdin, prints the guide, and finds the model in `WISDOM_GUIDE_MODEL`. Use it for Codex, Pi, an API key, or a local model. |

## What a guide costs

The writer reads the record, the person's request for each turn involved, and each cited
step (up to 6,000 characters per step, 60,000 in all; a cut says so). That is about 5,000
to 20,000 tokens in and 1,000 out: roughly $0.001 to $0.003 per commit with agent work at
Claude Haiku 5.5's API price ($0.10 in, $0.50 out per million tokens). On a subscription,
it comes from your plan. The writer's own Claude Code session is never recorded.

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
records instead.

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

- Tested against a git remote on disk, not yet against GitHub or GitLab.
- The default writer needs Claude Code installed and logged in. Without it, and with no
  `guides.command`, commits with agent work get no guide and say why.
- A session is pushed whole, as one file per version (git compresses the similar versions).
  Unrelated work in the same session travels too: one session per task keeps it out.
- Contributors from a fork cannot push hidden refs to the team's repository.
- The background job and `pre-push` read the recordings with their own connection to the
  database; a change the daemon has not yet seen when the commit is made is "not recorded".
