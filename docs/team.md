# Team mode

Wisdom works on one machine by default (local mode). Team mode lets a team read each
other's sessions from a commit, through the team's own git remote. Nothing goes to
Wisdom: sessions and records are hidden git refs in your own repository.

A repository is in team mode when it has a committed `wisdom-team.yaml` at its top.
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
   `prepare-commit-msg` hook adds one line to the message, `Wisdom-Record: r-…`, a readable
   backup that can follow the commit through amends, rebases and a squash merge on the server.
   What a reader relies on is a [commit link](#commit-links): when an amend or a rebase gives
   the commit a new sha, git's `post-rewrite` hook reports the old and new shas and Wisdom keeps
   a link between them.
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
   time. A piece the model left out (on a big commit it can run out of room before the end of
   the list) is filled from the plain guide, marked "From the record, no model", and the guide
   says how many: "for 5 of 95 items; 90 from the record, no model". Wisdom checks that the guide covers
   every piece, that every citation names a real step in one of the commit's sessions, and
   that it falls inside that session's window, and keeps what that check found. A guide that
   still fails is asked for once more with what was wrong (a citation of no real step, say). It cannot
   check that the explanation is right, so a guide is always shown as derived, never as
   evidence.
4. **Push.** Your own `git push` carries it all, for what you push: the commits the pushed
   branches reach, whichever branch is checked out (`git push origin main` from `feat/x`
   sends `main`'s records, not `feat/x`'s), and of those only the record versions the remote
   lacks, so a guide finished after one push goes with the next. Wisdom's `pre-push` hook waits for any
   guide still being written, writes any that is missing, then sends the commit links first
   (a few hundred bytes each, so a long session upload cannot take them down), then the
   sessions the records name, then the records. A record of a commit you amended or rebased
   away goes too, since a link points at it. When git names nothing to push (an up-to-date
   push), and for `wisdom team push` by hand, Wisdom goes by the branch checked out. Each session goes through the same export as
   `wisdom share`, with every possible secret redacted automatically. Each record is scanned
   with the same patterns, since its guide can quote a request (the plain guide does, word for
   word): when a version not yet on the remote holds one, those versions are replaced by one
   redacted version before the push, so none of them leaves. The sessions it cites keep their
   originals here. It never sends the `.wisdom/` folder or any login. A failure there never
   stops your push; it says so.
   Only commits made in team mode travel: a commit whose tree already holds
   `wisdom-team.yaml`. Work you recorded before team mode was turned on (local-mode records,
   their sessions, their guides) stays on your machine, and no guide is written for it at push.
5. **Review.** A reviewer runs `wisdom team fetch`, then `wisdom glance --commit <commit>`.
   Each piece points to the step that made it, checked against the fetched session, with
   the guide below. They open steps with `wisdom open t3/c2 --capture <session>`. The fetch
   brings only what the reviewer's own branches reach (not their copies of the remote's,
   `origin/*`): those commits' records and links, the records the links lead to, and the
   sessions those records name. To review a pull request, check out its branch first; a merged
   one's records come once you pull `main`. The deletion list always comes whole.
6. **CI.** `wisdom check --range <base>..<head>` checks the pull request: every commit with
   agent work has a guide that passed its check, and every session its record names is on
   the remote. This is the one check nobody can skip on their own machine. It fetches only
   the records and links of the range's commits (and those their links lead to), never a
   session: the remote's list says whether each is there. Only when a commit with no link
   names its records by `Wisdom-Record:` line alone does it fetch every record, still no
   session, since a line gives a record's ID, not its commit.

   In GitHub Actions it also shows its result on the pull request as a check run named
   **Wisdom**. Its title is one line ("3 of 4 commits explained by recorded sessions · 1 needs
   attention"), and its summary lists each commit that needs attention and why. With the
   [team's dashboard](#commits-for-your-team), the summary starts with a link that opens the pull
   request there, with its commits and the sessions behind them. GitHub's own **Details** button
   opens the Actions run instead: GitHub shows a check run posted with Actions' `GITHUB_TOKEN`
   that way, whatever link it is given. The dashboard updates a few minutes after each push.
   The check run only reports: pass or fail is the check's own. It needs `checks: write`. A
   pull request from a fork gets a read-only token, so there the check run is refused, and the
   job's own summary page shows the same.

A model writes guides by default. `wisdom guide off` stops calling a model for your own
commits: Wisdom writes a plain guide from the record instead, naming the step that made
each piece and quoting what was asked in that turn. It costs nothing and comes out the same
every time, but says nothing about why beyond those requests. Its writer is shown as
`Wisdom, no model (wisdom guide off)`, and the CI check accepts it. `wisdom guide on` turns
the model back on.

## Commands

| Command | What it does |
| --- | --- |
| `wisdom team init` | Writes `wisdom-team.yaml` with a new repo ID. An admin commits it. |
| `wisdom init`, `wisdom connect` | In a team-mode repository, also install the git hooks, and name any team command not trusted here yet. |
| `wisdom team trust` | Shows the commands `wisdom-team.yaml` runs on this machine (`check`, `guides.command`) and, on a yes, lets them run. See [Trusting the team's commands](#trusting-the-teams-commands). |
| `wisdom team hooks on\|off` | Installs or removes the four git hooks. |
| `wisdom guide on\|off` | Team mode: who writes your guides, a model reading the sessions (on, the default) or Wisdom from the record with no model (off). Local mode: whether a model writes one after each commit (off by default; on installs only `post-commit`). Each commit's job goes by the switch, and by the policy's `guides` writer, as they were at that commit. |
| `wisdom guide <commit>` | A model writes that commit's guide now, in either mode, from its record's window. In team mode it goes with your next push; in local mode it stays on this machine. |
| `wisdom glance --commit <commit>` | A commit's pieces, the steps that made them, and its guide. |
| `wisdom check --range A..B` | For CI: needs no data folder. Exit code 1 when a commit needs attention. In GitHub Actions, also a check run on the pull request, and the job's summary. |
| `wisdom team push` | Sends your links, sessions and records now, without a `git push`. |
| `wisdom team fetch` | Brings here, read-only, the records and links of the commits your own branches reach, and the teammates' sessions those records name; applies the whole deletion list. |
| `wisdom team sync on\|off` | Whether `git fetch` and `git pull` also bring the team's commit links and records. On adds two lines to the remote's fetch list in `.git/config`; off takes out exactly those. `wisdom init`, `wisdom connect` and `team hooks on` ask first; `team hooks off` undoes it. With no argument it says whether it is on. |
| `wisdom team relink --range A..B` | Links each commit in the range that has neither a record nor a link, from the merged pull request GitHub says made it, or else by its patch-id. Run by the [CI job](#ci) after each merge; anyone can run it later. Needs no data folder. |
| `wisdom team relink --commit-map FILE` | After `git filter-repo`: links each rewritten commit from filter-repo's own `.git/filter-repo/commit-map`. |
| `wisdom team delete <session>` | Removes a pushed session for everyone and adds it to the deletion list, so no clone pushes it back. Your own recording stays. With the team's dashboard and `gh`, it rebuilds the dashboard at once. |
| `wisdom team prune` | Removes pushed sessions older than `retentionDays`. |
| `wisdom commits deploy` | Sets up [the team's Commits dashboard](#commits-for-your-team): Vercel, the GitHub sign-in app, the CI file. `--public`: no sign-in, on purpose. Run again to fix the setup. |
| `wisdom commits build` | For CI: the dashboard from the remote, ready to deploy. Needs no data folder. |
| `wisdom commits prune` | For CI: removes the dashboard's older Vercel deployments. |

`--remote NAME` uses another remote than the policy's.

## The git hooks

| Hook | What it does | Can it stop git? |
| --- | --- | --- |
| `prepare-commit-msg` | Adds `Wisdom-Record: r-…` to the message. An amend keeps its line; a merge gets none. | No |
| `post-commit` | Starts the background job that keeps the record and has the guide written, detached so it outlives the agent's shell and session. Starts again any earlier job that died, and any links still waiting to be sent. git runs it for each commit a rebase replays too, so a rebased commit gets a record of its own as well as its link. | No |
| `post-rewrite` | After an amend or a rebase, keeps a link from each new commit to the commits it came from, exactly as git reports them (a fixup or squash: several). One line per run in `.wisdom/jobs.log`. | No |
| `pre-push` | Keeps the record and guide of any commit whose job died, waits for jobs still running (up to five minutes), writes missing guides, pushes links, then sessions, then records, with `--no-verify`. Links it could not send stay here and are retried in the background (30 s, 2 min, 10 min), then at the next commit and push; `wisdom doctor` shows them waiting. | No |

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

```yaml
version: 1
repoId: 5d0c3c1e-8a5b-4b8e-9d0e-2f1c7a3b9e11
remote: origin
identity: true
requireGuides: true
keepReferenced: true
retentionDays: 90
check: node scripts/scan-session.mjs
guides:
  model: claude-haiku-5-5
```

`wisdom team init` writes the file with these defaults and the optional ones commented out.

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
| `guides.turns` | `30` | How many steps the Claude Code writer may take reading the sessions, 5 to 60. |
| `guides.timeoutSeconds` | `150` | How long one guide may take to write, 30 to 300. |
| `guides.extra` | none | The team's own words, added after the writer's rules, such as "Name the tests run." Wisdom's check of the guide is the same. |
| `commits` | none | Written by `wisdom commits deploy`: the [team dashboard](#commits-for-your-team)'s `url`, its `vercelProject` and the `githubApp` it signs in with (`public: true` without one). Read by deploy when run again and by `team delete`. |
| `guides.command` | Claude Code (`claude -p --model <model>`, with only Wisdom's ledger tool) | Any other writer: it reads the prompt on stdin, prints the guide, and finds the model in `WISDOM_GUIDE_MODEL`. Use it for Codex, Pi, an API key, or a local model. It gets the cited steps already opened (up to 6,000 characters each, 60,000 in all) and may not use tools, so it does not read the rest of the window. The guide names its writer as the command followed by `(model not named)`, since the command picks its own model; set `guides.model` as well and it reads `<model> via <command>`. |

**Guides are written the same way for everyone.** In team mode the `guides` settings come from
this file only. What it leaves out is Wisdom's default, never a person's own value: the
`guides.model`, `turns`, `timeoutSeconds` and `extra` in someone's [`wisdom.yaml`](usage.md#settings)
are ignored, and `wisdom doctor` says so. Teammates read each other's guides, so one person
cannot make theirs shorter or steer them. Each person still decides with `wisdom guide off`
whether a model writes their own guides.

A repository that still has only `wisdom-team.json` (Wisdom 0.6.0-beta.0) is in local mode,
since that file is no longer read. `wisdom doctor`, `wisdom init`, team commands and `git push`
say so. To keep team mode, convert it to `wisdom-team.yaml`, with the same fields, and commit it.

## Trusting the team's commands

`check` and `guides.command` are commands Wisdom runs on every teammate's machine, as them,
through their shell. Anyone who can change `wisdom-team.yaml`, including a pull request you
check out to review, can change them. So each person trusts them once:

1. `wisdom init` and `wisdom connect` name any command not trusted here yet.
2. `wisdom team trust` shows each command and what it is for, and asks. On a yes, it keeps a
   sha256 of each command's exact text in `.wisdom/trusted-commands.json`, on this machine only.
   With no terminal to ask in, it trusts nothing.
3. A command whose text changes is untrusted again until you run `wisdom team trust` again.

Until then nothing is skipped: an untrusted `check` holds the session back (tried again at each
push, with the short cause "not trusted on this machine yet"), and an untrusted `guides.command`
writes no guide, so CI flags the commit. Only the command's text is compared, not a script it
runs: if `check` is `node scripts/scan.mjs`, a change to `scan.mjs` alone is not noticed, so
review changes to such scripts as you would the team file.

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
| `refs/wisdom/links/<commit>` | `refs/wisdom/<repo-id>/links/<commit>` | `link.json`: the commits this one came from, how (amend, rebase, squash or rebase merge, filter-repo) and on what basis. See [Commit links](#commit-links). |
| `refs/wisdom/fetched/links/<commit>`, `refs/wisdom/fetched/records/<commit>` | | Copies `git pull` brought once `wisdom team sync on`, and links `wisdom team fetch` brought. A namespace of their own, so a fetch that prunes never deletes a record or link of yours not pushed yet. |

`<recorder>` is a random ID made once per data folder, so two machines never clash. These
refs are never on a branch, never checked out, and not fetched by a plain `git clone`. A
`git push --mirror`, or a backup that copies every ref, does copy them.

Each step in a record keeps its file's hashes before and after, and its patch's hash. A
reader checks every step against the session it has: `changed since the commit` or
`session not available` marks only the steps affected.

## Commit links

Records are kept by commit sha, and an amend, a rebase, a squash or rebase merge on GitHub or
a history cleanup gives the work a new sha. A **link** says "this commit came from those", so a
reader finds the records again. It is a small object of its own beside the records: records,
sessions and commit messages are never changed. A link comes only from something that saw the
rewrite or can prove it, never from a commit message and never from a model:

| Basis | Written by | When |
| --- | --- | --- |
| `git` | git's own `post-rewrite` hook, on your machine | amend, rebase, fixup, squash in an interactive rebase |
| `github` | `wisdom team relink`, in the CI job after a merge | a squash merge: GitHub's API names the pull request, and its commits come from `refs/pull/<n>/head`, which GitHub keeps |
| `patch-id` | `wisdom team relink` | the same change (`git patch-id`) as exactly one recorded commit not on the branch: a rebase merge's commits, a rebase whose hooks did not run, a link that never left its clone. Each record keeps its commit's patch-id, so this works where the old commit is gone. |
| `order` | `wisdom team relink` | a commit of a rebase merge whose change differs (main edited the lines next to it), between two that matched, with as many left over on both sides. Shown as weaker. |
| `commit-map` | `wisdom team relink --commit-map` | `git filter-repo`'s own list |

A commit two different people link (your rebase, then CI's squash) is followed down: links of
links lead to the records. Where links and the message disagree, the link wins. A stronger link
replaces a weaker one as a new version on top, so its history stays.

What a reader shows, `glance --commit` and the CI check alike:

- its own record, when it has one. A rebased commit has one (git runs `post-commit` for it), and
  its link adds a line saying where it came from, and how to read that record.
- else its link: `squash merge of PR #12, from GitHub's pull request: it came from 2 commits;
  their records follow`, each under `── from: <commit>`. A one-to-one link whose change is not
  the same as the old commit's (an amend that changed files, a cleanup that removed one) says
  `its change differs from the commit it came from (edited in the rewrite)`.
- else the `Wisdom-Record:` lines its message carries (the backup), as below.
- else `no record or link: made without Wisdom, or not linked yet (wisdom team relink)`.

**The backup line.** GitHub puts the squashed commits' messages in its body, so their
`Wisdom-Record:` lines come along, and a reader uses their records when no link leads anywhere:
history from before links, or a repository without the CI job. To have GitHub copy them, set
the default squash message to "Pull request title and commit details" (repository Settings >
General > Pull Requests). Wisdom adds no warning line to each message: git strips lines starting
with `#`, a plain line can break git's trailer block, and it would be noise on every commit.

**Pull requests from forks.** A contributor can push Wisdom's refs only to their fork. At the
merge, the CI job reads the fork's address from the pull request, copies the records of its
commits and the sessions they name into the team's remote (sessions first), then links the merge.
A private fork the job cannot read stays unlinked, and says so.

**Getting them on every machine.** Pushes send links; `wisdom team fetch` brings them; with
`wisdom team sync on`, so does every `git fetch` and plain `git pull`. `git pull origin main`
names what to fetch, so git does not use the fetch list then; a plain `git pull` or `git fetch`
does.

## Commits for your team

A dashboard the whole team opens in the browser: what landed on main and how (merge, squash or
rebase), the open pull requests and active branches, each commit with how its record was found,
its pieces, its guide and its sessions, and a session's turns down to the chat view. It is the
same app as [`wisdom commits`](usage.md#commits-on-this-machine) on your machine, built from what
the team's remote holds instead, so every status is one the remote can prove: Wisdom checks
each step against its session and each guide again, on every build.

### Setting it up

An admin runs, once, in a checkout of the team-mode repository:

```text
wisdom commits deploy
```

It asks before each step that writes anywhere, and can be run again to fix the setup.

1. **Who may see it.** The link is open, but the data needs a GitHub sign-in by someone who can
   read the repository. `--public` deploys it with no sign-in, only on purpose: for a private
   repository it asks again.
2. **Vercel.** It runs on Vercel. The free Hobby plan is for personal and non-commercial use only,
   so a company's dashboard needs **Vercel Pro**. Only whoever deploys needs a Vercel seat:
   everyone else signs in with GitHub. Deploy logs in to Vercel, creates the project, and
   confirms its address with a placeholder page.
3. **The sign-in app.** A GitHub App, created from the terminal: you press "Create GitHub App"
   on GitHub, then install it on this repository only. It asks for **Metadata: read**, nothing
   else, and has no webhook. Its private key is used once, to check the installation, and never
   stored. Its client ID and secret, and a new key for the sign-in cookies, go into the Vercel
   project's environment.
4. **The CI token.** CI deploys with a Vercel token you create on Vercel's token page. It goes
   into the repository's secret `WISDOM_VERCEL_TOKEN`, through `gh secret set` (which asks you
   for it) or GitHub's secrets page. Wisdom never sees it.
5. **The CI file.** `.github/workflows/wisdom.yml`, one job calling Wisdom's reusable workflow
   (see [CI](#ci)), and a `commits:` section in `wisdom-team.yaml` with the dashboard's address.
   It offers to remove the older `wisdom-relink.yml`, since the new file relinks too. Commit both
   and push: the first build deploys the dashboard. `wisdom team init` offers all this too, and
   says no unless you say yes.

### Who sees what

- **Signing in** asks GitHub who you are and whether you can read the repository. Only a yes
  opens the data. Your GitHub token stays in your own browser, in a cookie encrypted with a key
  only the dashboard holds.
- **Losing access** on GitHub locks you out within 10 minutes: the dashboard asks GitHub again
  that often. A sign-in lasts at most 8 hours. When GitHub can't be asked, the dashboard shows
  nothing rather than guess.
- **The data is never a public file.** It sits inside the sign-in function, which reads it for
  you; no address reaches it around the sign-in.
- **Older builds are removed** after each deploy (`wisdom commits prune`): an old build still holds
  sessions deleted since. Vercel also keeps a build's own address behind its login by default.

### When it updates

| Event | What happens |
| --- | --- |
| A pull request opened or pushed | Built, so the open pull request shows. A fork's pull request is not: GitHub gives it no secrets |
| A push to the default branch (a merge) | `relink` first, so the merge's new commits link to their records, then built |
| Every 20 minutes | Built: sessions and records pushed between merges start no workflow (Wisdom's own refs never do) |
| `wisdom team delete`, `prune` | With `gh` installed and logged in, a build starts at once; otherwise the next one drops the session |
| By hand | Actions > wisdom > Run workflow |

One build runs at a time per repository, and a newer one replaces one still running. A build
reuses the turns of sessions unchanged since the last one (kept in the Actions cache).

### Limits

- **GitHub and Vercel only, for now.** The site is written for Vercel by a small adapter; other
  hosts would be others. Hosting the dashboard for you is part of the enterprise offering.
- **Size.** Everything the remote holds is read up front, so every click is quick. A Vercel
  function holds at most 250 MB: a build with more stops and says so. Faster, separate session
  storage is part of the enterprise offering; meanwhile `wisdom team prune` brings it down.
- **Not yet tried end to end on GitHub and Vercel.** Each part was checked live on its own (pushes
  of Wisdom's refs start no workflow, the app made from a manifest, Vercel keeping the data inside
  the function), and the whole flow is tested with stand-ins; the full run waits for the first
  release that carries it.

## CI

With [the team's dashboard](#commits-for-your-team), CI is one file that `wisdom commits deploy`
writes, calling Wisdom's reusable workflow, which checks pull requests, relinks after merges
and builds the dashboard:

```yaml
jobs:
  wisdom:
    uses: Oqura-ai/wisdom/.github/workflows/wisdom.yml@v1
    with:
      main: "main"
      wisdom-version: "0.6.0-beta.4"
      commits: true
      vercel-org-id: "team_..."
      vercel-project-id: "prj_..."
    secrets:
      VERCEL_TOKEN: ${{ secrets.WISDOM_VERCEL_TOKEN }}
```

`wisdom-version` is the Wisdom that wrote the file. Without it the workflow installs npm's
`latest`, which may be an older Wisdom without these jobs; move it when the team updates.
Without `commits: true` it only checks and relinks. Without the dashboard, the two jobs below do
the same written out in full: GitHub Actions, as an example:

```yaml
name: wisdom
on: pull_request
permissions:
  contents: read
  checks: write          # the result as a check run on the pull request
jobs:
  guides:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: actions/setup-node@v4
        with: { node-version: 24 }
      - run: npm install -g @oqura/wisdom@0.6.0-beta.4
      - run: wisdom check --range origin/${{ github.base_ref }}..HEAD
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

Pin the version your team uses (`wisdom --version`): plain `@oqura/wisdom` installs npm's
`latest`, which may be an older Wisdom without team mode, and the job fails with an unknown option.

And the job that links what GitHub makes at a merge. `wisdom team init` offers to write it as
`.github/workflows/wisdom-relink.yml`, and asks first. Without it, merges made with GitHub's
buttons stay unlinked (the backup line may still lead to their records) until someone runs
`wisdom team relink --range …` with a token; that still works later, since GitHub keeps every
pull request's commits.

```yaml
name: wisdom links
on:
  push:
    branches: ["main"]
permissions:
  contents: write        # to push Wisdom's link refs (refs/wisdom/...), never a branch
  pull-requests: read    # to ask which pull request made a commit
jobs:
  relink:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: actions/setup-node@v4
        with: { node-version: 24 }
      # Pinned: npm's latest may be an older Wisdom without relink. Update it with the team's.
      - run: npm install -g @oqura/wisdom@0.6.0-beta.4
      - run: wisdom team relink --range "${{ github.event.before }}..${{ github.sha }}"
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

`relink` asks GitHub through `GITHUB_API_URL` (set by Actions, GitHub Enterprise's included; not tested there),
for `GITHUB_REPOSITORY`, with `GITHUB_TOKEN`. Outside Actions it reads the repository from the
remote's URL. On a new branch or after a force push, `github.event.before` is not a commit there,
so it looks at the newest commit only, and says so. Like `check`, it fetches only the records
and links of the commits it looks at, never a session. When GitHub cannot say where a commit
came from, the patch-id step compares it with every record, so then every record is fetched
(still no session).

## Limits

- Tested against GitHub (a private repository): push, fetch, deletion, the CI check, and
  squash, rebase and merge-commit merges. Not yet against GitLab.
- The default writer needs Claude Code installed and logged in. Without it, and with no
  `guides.command`, commits with agent work get no guide and say why; `wisdom guide off`
  gives them Wisdom's plain guide instead.
- `git push --mirror` sends every ref, `refs/wisdom/*` included, in either mode. A normal
  push does not.
- A `pre-push` hook installed by 0.6.0-beta.2 or earlier is not given git's list of what is pushed,
  so it goes by the branch checked out. `wisdom team hooks on` writes the current one.
- A push looks at up to 2,000 commits of what it pushes, as it did of the branch checked out.
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
- Contributors from a fork cannot push hidden refs to the team's repository; the CI job copies
  them from a fork it can read, at the merge.
- Commit links: a cherry-pick where you resolved a conflict is not linked (its change differs, and
  git reports no pair for a cherry-pick). The original keeps its record. A commit of a rebase merge
  that cannot be paired, a change recorded twice (two records with one patch-id), and commits made
  on GitHub itself stay unlinked, and say so. Links are not signed yet: a reader checks each against
  the content (patch-id, the record's own commit), not who wrote it.
- `relink` asks only GitHub. On GitLab or elsewhere it links by patch-id only.
- The background job and `pre-push` read the recordings with their own connection to the
  database; a change the daemon has not yet seen when the commit is made is "not recorded".
