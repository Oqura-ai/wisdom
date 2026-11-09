# Usage

## Commands

| Command | What it does |
| --- | --- |
| `wisdom connect` | Record plain `claude`, `codex` and `pi` started in this project, with your own login: Wisdom's hook and reading skill in the project's own settings, kept out of git. Running it again repairs them. See [two ways to record](#two-ways-to-record). |
| `wisdom disconnect` | Take out exactly what `connect` added. Recordings are kept. |
| `wisdom init` | Make a folder a Wisdom project for `wisdom track`: `.wisdom/`, hooks and the reading skill in each harness's home there, the daemon. Running it again repairs them. |
| `wisdom track claude\|codex\|pi` | Start a harness with its home in the project, under its own login there. Harness options go after `--`, such as `-- --continue`. |
| `wisdom resume <session-id>` | Continue a recorded session in its harness and folder, still recording. Takes the full ID only, so a resume never lands in the wrong session. |
| `wisdom handoff <harness\|session-id> [--from <session-id>]` | Continue work in a new session of any harness, or an existing session, that reads another session first. See [handing work on](#handing-work-on). |
| `wisdom share <session>...` | Write one file to send a teammate, after a check for secrets. See [sharing a session](#sharing-a-session). |
| `wisdom import <file>` | Read a teammate's shared file in this project, read-only. See [reading a shared session](#reading-a-shared-session). |
| `wisdom clone <session>` | Carry a session on as a new session of the same harness, its history copied. See [cloning a session](#cloning-a-session). |
| `wisdom export <session>` | Write a session as Markdown anyone can read, after a check for secrets. See [exporting a session](#exporting-a-session). |
| `wisdom glance [session\|latest]` | List recorded sessions, or show one session's shape and every turn. |
| `wisdom open <position> --capture <session\|latest>` | Read one turn, tool call or subagent, whole. |
| `wisdom dashboard` | Print the address of the live dashboard. |
| `wisdom doctor` | Check that everything is working. See [installation](installation.md#check-a-project). |
| `wisdom daemon start\|run\|status\|stop` | Control the background service. `run` stays in the foreground. |
| `wisdom mcp` | Serve the optional `ledger` tool over MCP. See [agents](agents.md). |

Every command finds `.wisdom/` from the current folder upward, the way git finds `.git`. `--cwd DIR` starts looking from another folder, and `--data DIR` or `WISDOM_DATA_DIR` names the data folder directly. `--claude-bin`, `--codex-bin` and `--pi-entry` select other installations of a harness.

## How recording works

### Two ways to record

**Connected: your own login.** `wisdom connect` puts Wisdom's hook in the project's own harness settings: `.claude/settings.local.json`, `.codex/hooks.json` and `.pi/settings.json`, with the reading skill in `.claude/skills/` and `.agents/skills/`. Then `claude`, `codex` and `pi`, started in the project as you always do, record with your normal login. Nothing reaches git: those paths go in `.git/info/exclude`, your clone's own ignore file, and a settings file git already tracks is left alone. Wisdom only adds its own entries and keeps everything else in those files; `wisdom disconnect` takes them out again. Your global harness settings are not touched.

What each harness loads, verified on Claude Code 2.1.319, Codex 0.166.0 and Pi 1.2.0:

- **Claude Code** records when started in the project's top folder. Started in a subfolder, it does not load the project's settings, so it is not recorded.
- **Codex** asks once to trust the project, and Wisdom's hooks must then be reviewed once in its `/hooks`. It records from the project's folder or any below it, but it ignores the project's hooks inside a git worktree ([openai/codex#27133](https://github.com/openai/codex/issues/27133)).
- **Pi** records when started in the project's top folder, once you trust the project when it asks.

Your harness keeps its sessions in its own home (`~/.claude`, `~/.codex`, `~/.pi/agent`). Wisdom copies this project's sessions from there, and its safety net reads only this project's session files changed since you connected. A clone made in a connected project goes into that home, so it resumes under your login.

**Tracked: a home of its own.** `wisdom init` and `wisdom track` keep each harness's whole home inside the project, as described below. It needs one login per project, and it records what connected recording can't: a session started from a subfolder, Codex in a worktree, and every process that uses the home. Both can be set up in one project; a tracked session there is recorded once, by its home's hook, while the project's copy stands aside.

`wisdom resume`, `handoff` and `clone` keep a session in the home it ran in. A new session from `handoff` runs connected when the project is connected. A connected Claude Code or Pi session they start begins in the project's folder, wherever you ran the command, since only there does it load the settings that record it.

### Tracked recording

**The harness home is the fence.** Each harness keeps all its own files in `.wisdom/harnesses/<harness>/home/`: settings with Wisdom's hooks, login, and sessions (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `PI_CODING_AGENT_DIR`). Any process that uses that home loads the hooks, however it was started: a `/fork` running in the background, a `/branch`, a resume, a worktree. So every session there is recorded. `~/.claude`, `~/.codex` and `~/.pi/agent` are never touched (unless you choose to delete a connected session's own copy there, see [deleting a session](#deleting-a-session)), and a plain `claude`, `codex` or `pi` doesn't see these sessions; it records only if the project is connected.

`wisdom track` is the short way to start a harness with its home set. It also starts the daemon, and passes the optional `ledger` MCP tool to Claude Code and Codex. Each home holds the skill that teaches agents to read recordings. See [agents](agents.md).

### Either way

**Wisdom never stops the harness.** Each hook sends its event to the daemon. If the daemon is down or refuses, the hook keeps the event in `.wisdom/spool/`, starts the daemon, and shows a warning. The daemon records kept events in order when it is back, marked `delivered-late`. File changes made while it was down are not observed, and the glance says so.

**Nothing in the home goes unnoticed.** Every 10 seconds the daemon looks at the session files in the harness homes, and, for a connected harness, at this project's session files in your own home changed since you connected. A session file with no record, unchanged for two minutes (hooks untrusted or disabled, for example), becomes a record read from that file. Its typed prompts appear as `in (from session file)`, its replies, calls and results as the harness wrote them, with a `not-recorded-live` gap (no hook events, no observed file changes). Lines a session gained while nothing recorded are read the same way.

**One session, one record.** Wisdom records each harness session under that harness's own session ID. There is no second ID and no launcher in between. Two sessions running at once (a background `/fork`, two terminals) are two records, both recording. A session ends with the harness's own end event, or after 10 minutes with no event and no tool running (`idle`), and its next event continues it. Resuming continues its record: its turns go on from where they stopped, and the glance lists a `not-recording-between-visits` gap, because file changes made while nothing was recording are not observed. Forks and branches are recorded as separate sessions, without a link to their parent yet. When a harness moves a session's file (Claude Code does on entering a worktree), the copy follows it.

**Linked git worktrees.** A session started in a worktree belongs to its main project. Each session watches its project and any worktree it works in, and records those changes with the worktree's name and branch and paths relative to it. A worktree gets its baseline when the session first works there, so checking it out is not logged as changes, and a `worktree-entered` gap marks what came before. Files changing in a worktree the session never worked in get one `other-worktree` gap and no diffs. Work in a folder outside the one being watched is marked `outside-watched-folder`.

## Handing work on

When an agent runs out mid-task, or you want another harness to carry on, hand the work on:

```sh
wisdom handoff codex                          # a new Codex session reads the newest session from another harness
wisdom handoff pi --from 0f3c8a1e-…           # name the session to read, by its full ID
wisdom handoff 0f3c8a1e-… --from 01a1aca0-…   # resume an existing session, which reads what happened since
wisdom handoff codex -- also run the tests    # add your own words to its first prompt
```

The new or resumed session starts with a first prompt that names the other session's full ID and tells the agent to read it with `wisdom glance` and `wisdom open` before changing anything. Nothing is summarized: the agent reads the record itself, through the skill in its home.

Each session says how it is linked. The glance shows `continues <id> (<harness>)` for a new session, or `continued after <id> (<harness>) · at t5` for an existing one, and the dashboard shows the link from both ends. One handoff links one session: a `/clear` or `/new` later in the same process is not a continuation.

A session that is still running can't take outside input, so a handoff into one starts nothing and prints the prompt for you to paste. A very long existing session gets a note suggesting a new session instead, because its old context plus the reading can fill the window quickly. Codex needs its hooks trusted, as for `wisdom track codex`.

## Sharing a session

```sh
wisdom share 0f3c8a1e                       # one session, by its ID or first 8+ characters
wisdom share 0f3c8a1e 01a1aca0 --out a.wisdom-share
```

This writes one file holding the sessions' records, their payloads and patches, and the harness's own transcript copy. It never holds logins, the spool or the daemon's details. By default it goes to `.wisdom/shared-out/`, which git ignores, so a file can't be committed by accident. Send it however you like. Your teammate reads it with `wisdom import`.

Before anything is written, Wisdom checks for values that look like secrets (API keys, tokens, private keys, `PASSWORD=` and similar) and for personal details a harness writes into its own transcript (email addresses, and Claude Code's organization ID), and lists each one, masked, with where it appears:

```text
Found 2 possible secrets:
  1  openai-key         sk-pro…3456       t1 · Bash output  (and 2 other places)
  2  secret-assignment  hu…               t1 · patch of notes.txt

Redact all and share? [r] redact all  [c] choose one by one  [k] keep all  [x] cancel:
```

- **Redact** replaces the value with `[redacted by sender: <kind>]` everywhere it appears in the file. Your own recording is never changed. The file lists each redaction, never its value, and names any patch a redaction edited.
- **Keep** sends the value as it is, for example a fake key a test depends on.
- **Cancel**, or any answer not understood, writes nothing.

Without a terminal to ask in, `--redact` or `--keep-secrets` says what to do. Without either, nothing is written. The check also says how often your home folder path appears, since it includes your username. It finds the shapes it knows and will miss others, so look through what you send.

## Reading a shared session

```sh
wisdom import 0f3c8a1e-20261106-1402.wisdom-share
```

Or drop the file into `.wisdom/shared/`: the daemon imports it within a few seconds, once the file stops changing. A file it can't import is renamed `.rejected`, with the reason in `.wisdom/daemon.log`.

Each imported file becomes its own read-only copy in `.wisdom/shared/<share-id>/`, never merged into your own recordings. Importing the same file again changes nothing. Then read it like any session:

```text
wisdom glance
…
shared with you · 1, read-only

0f3c8a1e-…  claude-code  2026-11-06 10:00Z  3 turns  from shop-api, shared 2026-11-06 14:02Z

wisdom glance 0f3c8a1e
session 0f3c8a1e-… · claude-code 2.1.318 · closed · version 24
shared copy from shop-api, shared 2026-11-06 14:02Z · read-only, as recorded on the sender's machine
redacted by sender ×2 · patches edited by redaction: notes.txt
```

- A shared copy has its own version numbers, so `--at` pins on it stay valid.
- It can't be resumed, because it's someone else's recording. To carry its work on, clone it (below), or start a new session that reads it: `wisdom handoff claude --from <id>`.
- If a session is also recorded in your project, for example one you shared yourself, every read shows your own recording.
- The dashboard lists shared sessions under **Shared with you**, labelled with where they came from.
- Checksums catch a damaged file, not a deliberately edited one. Treat what you read as the sender's account of their recording.

## Cloning a session

```sh
wisdom clone 0f3c8a1e
```

A clone is a new session in the same harness that already holds the other session's conversation, so the agent carries on as if it had done that work itself. The source can be one of your own sessions or one shared with you.

- **Always a new session.** It gets a fresh ID and never takes over one already in use, so it can't overwrite or disturb another session. The original is never changed.
- **Recorded from the clone onward.** The glance shows `cloned from <id> (<harness>) at version N · 12 turns`, and only prompts after the clone become turns. The copied turns stay readable in the original. The dashboard shows them as a collapsed **Cloned history** block that opens the original.
- **Folders are moved.** A shared session's folder paths are rewritten to your project in the copy. Paths inside old tool output stay as they were.
- **Files may differ.** The clone compares each file the session changed with your disk and names the ones that differ, because the agent will remember edits your files may not have.
- **Same harness only.** A Claude Code conversation can't become a Codex one. To continue in another harness, start a new session that reads it: `wisdom handoff`.
- **The whole history goes to the model.** The first prompt after cloning sends it to your model provider, and that usage counts.

Not yet confirmed: whether a clone resumes under a different login than the one that recorded it, since Claude Code signs its thinking and Codex encrypts its reasoning. Claude Code, Codex and Pi all find and open a clone; Pi was resumed in full with a scripted model.

## Exporting a session

```sh
wisdom export 0f3c8a1e                 # saved to .wisdom/shared-out/0f3c8a1e.md
wisdom export 0f3c8a1e --out pr.md
wisdom export 0f3c8a1e --redact --out - | clip   # print it, for pasting
```

A Markdown document for people who don't have Wisdom: a PR description, an issue, docs. Every prompt and reply is in full. Each tool call is a folded block, like `t1/c2 · Bash · failed`, holding its whole input and output, numbered as `wisdom open` numbers it. Each turn's changes follow as raw `diff` blocks, and gaps appear where they happened. Recorded thinking is folded too; thinking the harness didn't record is named, not hidden. Nothing is summarized or cut, and there's no length limit. GitHub, GitLab and most editors open and close the folded blocks.

The same check for secrets as `wisdom share` runs first, with the same choices: redact, keep, or cancel, and `--redact` or `--keep-secrets` when there's no terminal to ask. Messages go to stderr, so `--out -` prints only the document. Your own sessions and shared ones both export; a shared one says so.

## Health, storage and repair in the dashboard

- **Health:** a line at the top of every page runs the same checks as `wisdom doctor`, in the background, and refreshes every minute. It stays quiet when recording works; open it for each check and the command that fixes it.
- **Repair:** when a harness's hooks point to a copy of Wisdom that moved or is another one, or its reading skill is missing or older, **Repair…** rewrites them the way `wisdom init` or `wisdom connect` would. It first copies every file it changes into `.wisdom/backups/<time>/`, and each backup can be restored from the same place. Sessions already running keep the hooks they started with until they restart, and Codex runs changed hooks only after you review them again in `/hooks`. A project settings file that git tracks is never rewritten.
- **What stays in the terminal:** starting and stopping the daemon. The dashboard is served by the daemon, so it can't start it, and stopping it would close the page.
- **Storage:** the overview shows the project's disk space: each session's evidence, the database, each harness home in `.wisdom`, and the rest, with the largest sessions. **Clean up…** lists sessions not active for 30 days (change the number), to pick one by one or delete all; the delete dialog below then shows exactly what goes. Nothing is ever deleted on a schedule.

## Deleting a session

Open a session in the dashboard and press **Delete**. Nothing is deleted until you have read what goes and confirmed:

- **What goes:** the session's record and evidence (`.wisdom/harnesses/<harness>/<id>/`), and its transcript and other per-session files in the project's harness home. The dialog lists them with their size. Deleted rows are overwritten inside `ledger.sqlite`, not just unlinked.
- **Linked sessions:** a session that continues it, or was cloned from it, keeps its own evidence and now says `continues a deleted session`. If one of them is still recording, the dialog names it: its agent may still read the session you are deleting, and those reads will fail.
- **A connected session's own copy:** for a session recorded with `wisdom connect`, the harness keeps its transcript in your own harness folder (such as `~/.claude`). A checkbox, off by default, deletes it too; then the harness can no longer resume the session. Left off, the harness can still resume it, but Wisdom does not record it again.
- **Refused:** a session still recording, until it ends.

Deleting cannot be undone. Wisdom keeps only a hash of the session's ID (`.wisdom/deleted.json`), so it never records that session again. Other sessions' prompts and tool output are not edited, so they may still mention its ID, and the harness's shared history files are not changed.

## Reading a session

```sh
wisdom glance                         # recorded sessions, newest first
wisdom glance latest                  # one session: its shape and every turn
wisdom open t3 --capture latest       # turn 3, whole, in recorded order
wisdom open t3/c2 --capture 0f3c8a1e  # one tool call: full input and output
wisdom open a1 --capture 0f3c8a1e     # a subagent, with the same layers
wisdom open outside --capture latest  # changes and calls outside any turn
```

A recorded session is named by the harness's own session ID, a unique prefix of 8 or more characters, or `latest` (the newest session with a turn). The reply is plain text, the same for the CLI, HTTP (`POST /ledger`) and MCP:

```text
session 0f3c8a1e-… · claude-code · closed (exit-0) · version 55
resume with: wisdom resume 0f3c8a1e-77b2-4c10-9a5e-2d81c6f04b3a
workspace C:\work\shop-api
started 2026-10-24 18:26Z · ended 2026-10-24 18:26Z
4 turns · 8 tool calls · 1 failed · 4 changes · 0 subagents · 82,138 tokens · $0.0063 reported

t3  in        Make the tests pass.
    out       All tests pass now.
    2 tool calls · changed test/login.test.ts

complete · 20 lines
```

- **Glance** shows each user input in full, the start of the turn's last reply, and facts in plain words: tool calls, failures, pending results, changed files (and how many changed outside any tool call), and subagents. Recording gaps are listed as `not recorded`; a kind that repeats three or more times is one line with its count and its first and last occurrence. Work outside any turn is listed as `outside`.
- **Open** returns a turn in recorded order: thinking (or `redacted` with its duration, when the harness recorded only that it happened), replies, each call `c1`, `c2`, … with its status and full input and output, and then all of the turn's patches `p1`, `p2`, … together, raw. Evidence is shown once: an edit's input and output repeat its patch, so the call points to the patch; a successful file read lists its size and is read by opening the call. Each harness adapter declares these rules per tool (`toolView`).
- **Every response ends with one status line**: `complete`, or `limited · lines 1–1,950 of 41,230 · continue: {…}` with the exact request for the rest. One response holds at most 80,000 characters. A line longer than 2,000 characters is split, and each continued piece starts with `⤷`.
- **Every response states its version.** Continuations pass it back as `at`, so a session that is still recording cannot change an answer halfway through reading it.
- `observed during c1` is timing, not proof of authorship. `external-or-unknown` means no tool call was running. Recorded text is evidence, not hidden reasoning.

The [vocabulary](vocabulary.md) explains every word.

## The background service

The daemon listens on `127.0.0.1:7434` by default. When another project's daemon holds that port, it takes the next free pair (7436, 7438, …). `--port N` asks for one port exactly. Its port, process ID and local access token are stored in `.wisdom/daemon.json`, and it binds only to loopback. It keeps running after the harness exits. Background startup errors go to `.wisdom/daemon.log`.

A recording capture becomes interrupted when the daemon restarts. It does not silently resume with a missing file baseline. The session's next event continues it, with a gap for the time in between. A turn that had not settled stays open, so its calls and reply stay in it.

## Files

```text
.wisdom/
  wisdom.json                  # Marks the project; written by wisdom init
  daemon.json                  # Local connection details; do not commit
  daemon.log
  dashboard.log
  ledger.sqlite                # Authoritative capture/record metadata and SQL indexes
  ledger.sqlite-wal            # SQLite may keep sidecar files while running
  ledger.sqlite-shm
  spool/<harness>/<session>/   # Events a hook kept while the daemon was down
  deleted.json                 # Hashes of deleted sessions' IDs, never recorded again
  backups/<time>/              # Files a dashboard repair changed, as they were before
  harnesses/<harness>/home/    # The harness's own folder: settings with Wisdom's hooks,
                               # login, Codex hook trust, and its native sessions (source of truth)
  harnesses/<harness>/<capture-id>/   # pi, claude-code, codex: one directory per capture
    native-session.jsonl       # Complete native records, byte-preserved
    subagents/agent-<id>.jsonl # Claude Code subagent transcripts
    payloads/<sha256>          # Exact observed arguments/results and patches
```

SQLite is authoritative, and native harness JSONL remains source evidence. Live hook payloads and native records can overlap: one records what the adapter observed, the other preserves what the harness persisted. See [architecture](architecture.md).

To exclude files from observation, add `.wisdomignore` to the project: relative files and directory prefixes, one per line, with `#` comments. It has no glob or negation syntax.

## Privacy

All generated data stays local. Native transcripts and hook payloads are preserved without redaction and may contain sensitive content. `.wisdom/` also holds each harness's login (such as `.wisdom/harnesses/claude-code/home/.credentials.json`).

`wisdom init` adds `.wisdom/` to `.gitignore`, but that only keeps it out of git. Leave it out of zips, copies, shared drives and synced folders. A copy of `.wisdom/` is a copy of your login.
