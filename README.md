# Wisdom

Wisdom records a coding-agent session (Pi, Claude Code, or Codex) while it runs and lets another terminal or agent read its evidence. The project root is this directory.

Wisdom has a local daemon, SQLite storage, one adapter per harness (a Pi extension, Claude Code/Codex hooks), a CLI, and one read-only MCP tool, `ledger`. An agent reads a session with two moves: **glance** (the session's shape and one entry per turn) and **open** (one turn, call or subagent, whole). Nothing is summarized or reworded, and no rule cuts tool output or patches; the only limit is a declared size ceiling, and a limited response names the exact request that continues it. Wisdom does not orchestrate agents or generate model-written summaries.

## Start here

Requires Node.js 24 or newer and an existing Pi, Claude Code, or Codex installation. Tested against Pi 1.2.0 and Claude Code 2.1.306; Codex hooks are checked against CLI 0.164.0. SQLite comes with Node; no database installation is needed.

```powershell
npm.cmd ci --legacy-peer-deps
npm.cmd run build
```

On shells without PowerShell's script restrictions, `npm` works instead of `npm.cmd`.

Make the project you want to observe a Wisdom project, once:

```powershell
npm.cmd run wisdom -- init --cwd "C:\path\to\your\project"
```

`init` creates `.wisdom/` in the project (and adds it to `.gitignore`), writes Wisdom's hooks into a home folder for each installed harness inside it, and starts the daemon. Running it again repairs the hooks. Every other command finds `.wisdom/` from the current folder (or `--cwd`) upward, the way git finds `.git`; `--data DIR` names it directly.

**The harness home is the fence.** Each harness keeps all its own files in `.wisdom/harnesses/<harness>/home/`: settings with Wisdom's hooks, login, and sessions (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `PI_CODING_AGENT_DIR`). Any process that uses that home loads the hooks, however it was started: a `/fork` running in the background, a `/branch`, a resume, a worktree. So every session there is recorded, and nothing outside it is: `~/.claude`, `~/.codex` and `~/.pi/agent` are never touched, and a plain `claude`, `codex` or `pi` neither records nor sees these sessions. Each harness starts clean in its home and asks you to log in once.

`track` is the short way to start a harness with its home set:

```powershell
npm.cmd run wisdom -- track claude --cwd "C:\path\to\your\project"
npm.cmd run wisdom -- track pi --cwd "C:\path\to\your\project"
npm.cmd run wisdom -- track codex --cwd "C:\path\to\your\project" --setup-hooks   # first time: open /hooks, trust Wisdom's hooks, quit
npm.cmd run wisdom -- track codex --cwd "C:\path\to\your\project"
```

Harness options go after `--` (`-- --continue`, `-- resume --last`). `--claude-bin`, `--codex-bin` and `--pi-entry` select other installations. `track` also starts the daemon and passes the `ledger` MCP tool (Claude Code, Codex) or the `wisdom-ledger` skill (Pi). Inside Pi, `/wisdom-status` reports the session.

Codex runs hooks only after you trust them in its `/hooks` screen, in Wisdom's Codex home; `track codex` checks this first. `--trust-all-hooks` skips the review but also runs other untrusted hooks; it is opt-in. Until the hooks are trusted, Codex sessions are read from their files only. See [Codex setup, coverage, and tests](docs/CODEX.md).

**Wisdom never stops the harness.** Each hook sends its event to the daemon. If the daemon is down or refuses, the hook keeps the event in `.wisdom/spool/`, starts the daemon, and shows a warning; the daemon records kept events in order when it is back, marked `delivered-late`. File changes made while it was down are not observed, and the glance says so.

**Nothing in the home goes unnoticed.** Every 10 seconds the daemon looks at the session files in the harness homes. A session file with no record, unchanged for two minutes (hooks untrusted or disabled, for example), becomes a record read from that file: its typed prompts appear as `in (from session file)`, its replies, calls and results as the harness wrote them, with a `not-recorded-live` gap (no hook events, no observed file changes). Lines a session gained while nothing recorded are read the same way.

The daemon remains running after the harness exits. To read from a second terminal:

```powershell
npm.cmd run wisdom -- glance                         # recorded sessions, newest first
npm.cmd run wisdom -- glance latest                  # one session: its shape and every turn
npm.cmd run wisdom -- open t3 --capture latest       # turn 3, whole, in recorded order
npm.cmd run wisdom -- open t3/c2 --capture 0f3c8a1e  # one tool call: full input and output
npm.cmd run wisdom -- open a1 --capture 0f3c8a1e     # a subagent, with the same layers
npm.cmd run wisdom -- open outside --capture latest  # changes and calls outside any turn
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
- **Every response ends with one status line**: `complete`, or `limited · lines 1–1,950 of 41,230 · continue: {…}` with the exact request for the rest. One response holds at most 80,000 characters; a line longer than 2,000 characters is split, and each continued piece starts with `⤷`.
- **Every response states its version.** Continuations pass it back as `at`, so a session that is still recording cannot change an answer halfway through reading it.
- `observed during c1` is timing, not proof of authorship; `external-or-unknown` means no tool call was running. Recorded text is evidence, not hidden reasoning.

**One session, one record.** Wisdom records each harness session under that harness's own session ID; there is no second ID, and no launcher in between: the session each event names is its record. Two sessions running at once (a background `/fork`, two terminals) are two records, both recording. A session ends with the harness's own end event, or after 10 minutes with no event and no tool running (`idle`); its next event continues it. Resuming a session continues its record: its turns go on from where they stopped, and the glance lists a `not-recording-between-visits` gap, because file changes made while nothing was recording are not observed. Forks and branches are recorded as separate sessions, without a link to their parent yet. When a harness moves a session's file (Claude Code does on entering a worktree), the copy follows it. Work done in a folder outside the one being watched (a worktree elsewhere) is marked `outside-watched-folder`. Resume through Wisdom with `wisdom resume <session ID>`, the full ID as the glance's `resume with` line and the dashboard print it. Partial IDs are refused, so a resume never lands in the wrong session.

See the [vocabulary](docs/NOMENCLATURE.md), the [storage/code map](docs/STORAGE.md), and the [data-layer policy](docs/POLICY.md).

## What is running?

```text
Pi extension ─────┐
Claude Code hooks ┼ local HTTP ── daemon ── SQLite
Codex hooks ──────┘                │
                 ledger (glance/open) · dashboard views
                                 │
                  CLI / MCP (agents) · live dashboard (people)
```

### Live dashboard

A local web viewer in [dashboard/](dashboard/) (Next.js) shows tracked projects live: per-harness cards, tool usage, most-changed files, every capture, and each capture as a work tree (request → tool calls → file changes, with subagents nested under the call that started them). A session opens in **Chat** view: a centred column with one expandable box per request. Each turn shows the prompt with its stats and time, a folded **Steps** section (thinking, narration, and each tool call, change and subagent expanding on its own), the **Response** rendered as Markdown (tables, lists, code, quotes, links), and the turn's token details. **Dev** view is the record tree with an evidence inspector. Assistant replies appear in place (❝), and a subagent lane ends with what the subagent returned. Token usage is shown per harness, model, capture and request: fresh input, cache read, cache write, output, reasoning and cache hit rate, with cost where the harness reports it. Claude Code's internal helper agents (prompt suggestions, recaps) are recorded but folded out of the tree. Selecting a node shows its request text, reply, tool input and result, or patch. Each session shows a command to copy that continues it from any terminal, with its folder and harness home set so it keeps recording. Its look follows the Wisdom design ([private/idea](private/idea/index.html)) with Light, Dark and Night themes and an **Aa** size control (100 / 125 / 150%, default 150%); the choice is remembered per browser and the first visit follows the system setting. Build it once:

```powershell
npm.cmd run dashboard:install
npm.cmd run dashboard:build
```

After that, `wisdom daemon start` (and `init`, any `track`, or a hook that starts the daemon) also serves it on the daemon port + 1, `http://127.0.0.1:7435` by default, and stops it with the daemon. `wisdom dashboard` prints the URL; `--no-dashboard` skips it. If it is not built, the daemon records normally and reports why the dashboard is missing. It reads through its own read-only daemon route (`POST /view`: project counts and tokens, a capture's records, one turn, one record's bodies); agents use the ledger instead. Token usage comes from each harness's native transcript, indexed while it is copied. The daemon token stays on the dashboard's server, and requests not addressed to localhost are refused, because recordings are unredacted. Use `npm.cmd run dashboard:dev` while changing it. Its output goes to `.wisdom/dashboard.log`.

The daemon listens on `127.0.0.1:7434` by default; when another project's daemon holds that port, it takes the next free pair (7436, 7438, …). Its port, PID and local access token are stored in `.wisdom/daemon.json`; it binds only to loopback. `--port N` asks for one port exactly. The CLI and MCP use the saved descriptor rather than hard-coding the port. Background startup is hidden on Windows.

```powershell
npm.cmd run wisdom -- daemon status
npm.cmd run wisdom -- daemon stop
# Foreground mode, useful for developing the daemon:
npm.cmd run wisdom -- daemon run
```

Background startup errors go to `.wisdom/daemon.log`.

## MCP for another agent

Configure a local stdio MCP server with Node directly; npm's banner would interfere with MCP stdout:

```json
{
  "mcpServers": {
    "wisdom": {
      "command": "node",
      "args": ["C:/absolute/path/to/wisdom/dist/src/cli.js", "mcp", "--data", "C:/path/to/project/.wisdom"]
    }
  }
}
```

The server exposes one tool, `ledger`, with five parameters: `capture`, `glance`, `open`, `from` and `at`. It returns the same text as the CLI. The tool cannot start a harness or edit code. Starting the MCP adapter can start the local daemon, including normal interrupted-capture recovery.

Agents address evidence by position (`t3`, `t3/c2`, `a1`), never by copying record IDs. The portable [harness skill](skills/wisdom-ledger/SKILL.md) explains the two moves and the evidence limits. `wisdom track` loads it into Pi and sets `WISDOM_CLI_PATH` so the skill can call this installation from another project. For another harness, register/copy `skills/wisdom-ledger/` through that harness's skill mechanism and configure the MCP server above or an absolute CLI path. No global harness configuration is changed by this repository.

## Files you can read

```text
.wisdom/
  wisdom.json                  # Marks the project; written by wisdom init
  daemon.json                  # Local connection details; do not commit
  daemon.log
  ledger.sqlite                # Authoritative capture/record metadata and SQL indexes
  ledger.sqlite-wal            # SQLite may keep sidecar files while running
  ledger.sqlite-shm
  spool/<harness>/<session>/   # Events a hook kept while the daemon was down
  harnesses/<harness>/home/    # The harness's own folder: settings with Wisdom's hooks,
                               # login, Codex hook trust, and its native sessions (source of truth)
  harnesses/<harness>/<capture-id>/   # pi, claude-code, codex: one directory per capture
    native-session.jsonl       # Complete native records, byte-preserved
    subagents/agent-<id>.jsonl # Claude Code subagent transcripts
    payloads/<sha256>          # Exact observed arguments/results and patches
```

All generated data stays local. Native transcripts and hook payloads are preserved without redaction and may contain sensitive content. `.wisdom/` is ignored by Git. Live hook payloads and native records can overlap: one records what the adapter observed, the other preserves what the harness persisted.

SQLite is authoritative. Native harness JSONL remains source evidence. For backup, stop the daemon and copy
the whole data directory, including payloads and native mirrors. See
[storage details](docs/STORAGE.md).

A previously recording capture becomes interrupted after daemon restart; it does not silently resume with a missing file baseline. The session's next event continues it, with a gap for the time in between. A turn that had not settled stays open, so its calls and reply stay in it.

## Keeping it private, and moving it

`.wisdom/` holds each harness's login (`.wisdom/harnesses/claude-code/home/.credentials.json`) and unredacted sessions. `wisdom init` adds it to `.gitignore`, but that only keeps it out of git: leave it out of zips, copies, shared drives and synced folders. A copy of `.wisdom/` is a copy of your login.

To move a project or the Wisdom checkout, stop the daemon first (`wisdom daemon stop`). Then:

- **The project moved:** recording goes on, because each hook reports to the home it runs in. When the daemon next starts, recorded sessions follow the project, with a `project-moved` gap, since older records still name the old folder.
- **The Wisdom checkout moved:** hooks cannot run, because their file is gone. Run `wisdom init` in the project; `track` and `resume` also repair them, and other commands warn until then. Sessions from that time are read from their files, marked `not-recorded-live`.
- **Codex in either case:** a changed hook command must be reviewed in `/hooks` again.

## Capture scope and honest limits

**Codex's own report.** Codex 0.164 runs tools from a script (`exec`, polled with `wait`), so a call appears as a `script step` beside the real `Bash` or `apply_patch`, with no stated link between them. How a tool ended comes from what Codex recorded it ran, joined by ID. A change Wisdom could not observe, because its daemon was down, is taken from Codex's report and labelled `reported-by-harness`.

**Linked git worktrees.** A session started in a worktree belongs to its main project. Each session watches its project and any worktree it works in, and records those changes with the worktree's name and branch and paths relative to it. A worktree gets its baseline when the session first works there, so checking it out is not logged as changes, and a `worktree-entered` gap marks what came before. Files changing in a worktree the session never worked in get one `other-worktree` gap and no diffs: a tool that writes there from another folder, such as a shell `cd`, is recorded that way.

- Native session mirroring and idle watcher processing run every 500 ms. Before a tool runs, the harness waits for its start observation to be delivered (or kept in the spool). File changes are observed at tool boundaries, not after every internal filesystem write.
- Direct file tools (Pi `read`/`edit`/`write`; Claude Code `Read`/`Edit`/`Write`/`NotebookEdit` and read-only tools) inspect their named target and watcher hints. Shell/custom calls reconcile the tracked workspace afterward. An idle reconciliation also runs every 30 seconds as a watcher fallback.
- Baseline contents live in memory. The first version caps an individual observed file at 1 MiB, a workspace scan at 10,000 files, and retained baseline bytes at 64 MiB. Limits and read errors produce visible gaps. Scans are synchronous and can briefly delay queries; use a bounded workspace.
- `.git`, `.wisdom`, `.npm-cache`, `node_modules`, `dist`, `build`, `.next`, `.venv`, and `__pycache__` are excluded by directory name. Symlinks are excluded. Permissions/ACLs are not tracked.
- Add `.wisdomignore` in the tracked project for relative paths to exclude. It accepts files and directory prefixes, one per line, with `#` comments; it intentionally has no glob or negation syntax. Wisdom's own file excludes `private/`.
- Changes during tools are labelled `observed-during-tool`, with all active tool IDs. This is temporal evidence, not proof of exclusive authorship. Idle changes are `external-or-unknown`.
- User shell commands outside model tool hooks are observed through filesystem activity and native records; they are not automatically attributed as agent tool calls.
- Renames appear as delete + create. Creations, modifications and deletions store UTF-8 unified diffs when possible; a created or deleted file diffs from or to empty, so its contents are readable. Binary changes get hashes and a missing-patch explanation. Full historical restoration is not promised.
- A failed tool can leave changes, which are still recorded. Pending calls remain visible if recording stops.
- If recording fails, nothing is blocked: the event is kept in the spool and a warning is shown (Claude Code and Codex hooks exit 1, Pi shows a notice). What the spool cannot hold is the file baseline: changes made while the daemon was down have no patch. A session whose hooks never ran has only what its own file says.
- SQLite commits use WAL and FULL synchronous mode. Payload/native-file writes are separate and are not one atomic, power-loss-safe transaction with the database. Recorded recovery gaps and mirror mismatches appear in recovery coverage. Native records above 32 MiB and requests above 16 MiB are explicit limits.
- No LLM-inferred intent, candidate-bound test certification, fixed code review snapshots, automatic multi-agent attribution, or search is implemented. The ledger reads one session at a time; reverse search from a line of code to the turn that produced it is planned for multi-agent work and is not implemented.
- What a harness does not report cannot be read: thinking a provider encrypts, tool paths that bypass hooks, and changes made by other processes (shown as `external-or-unknown`). These are marked where they occur, never filled in. With harnesses built with partners (Pi-based or open source), more of this can be recorded.
- **Subagents that fail or are cut off are only partly recorded.** A subagent's tool calls, their results (failed ones included) and its file changes are recorded as they happen. Its transcript copy, its token usage and its final report are recorded only when the harness sends the subagent's stop event. If a subagent fails, is interrupted, or the session ends before that event, those three are missing and Wisdom does not yet mark that the stop never came. Wisdom also records no success or failure for a subagent as a whole: read the result of the call that started it (`→ a1`) and its own calls. Whether each harness sends the stop event for a failed subagent has not been verified.
- Native-message links to a turn are temporal, especially after queued input, steering or branching. Read versions freeze evidence, not the codebase itself.

## Read the implementation

Read these in order:

1. [schema.ts](src/schema.ts): record vocabulary and the ledger, view and capture request schemas.
2. [harnesses/](src/harnesses/): one adapter per harness. [types.ts](src/harnesses/types.ts) is the contract; each harness's `launch.ts` writes its hooks into its home; [pi/extension.ts](src/harnesses/pi/extension.ts), [claude-code/hook.ts](src/harnesses/claude-code/hook.ts) and [codex/hook.ts](src/harnesses/codex/hook.ts) send events through [client.ts](src/client.ts) `deliver`.
3. [captures.ts](src/captures.ts): routing by session, the spool, the session-file scan, and operation/change coordination.
4. [workspace.ts](src/workspace.ts): scoped file observation and diff generation.
5. [database.ts](src/database.ts) and [ledger.ts](src/ledger.ts): SQLite, payloads and native mirroring.
6. [discovery.ts](src/discovery.ts): the agent-facing ledger (glance, open, positions, the ceiling). [conversation.ts](src/conversation.ts) assembles one turn in recorded order; [evidence.ts](src/evidence.ts) reads exact bodies at a version; [content.ts](src/content.ts) extracts surface text; [stats.ts](src/stats.ts) and [views.ts](src/views.ts) serve the dashboard.
7. [daemon.ts](src/daemon.ts): small HTTP boundary and daemon lifecycle.
8. [cli.ts](src/cli.ts), [client.ts](src/client.ts), [mcp.ts](src/mcp.ts): human/agent interfaces.

The design notes in [notes/README.md](notes/README.md) explain the later review architecture. They include future work; this README describes the implemented boundary.

## Verification

```powershell
npm.cmd test
npm.cmd run test:pi
```

The first suite checks live reads, exact edit patches, failure side effects, partial native records, continuation of limited responses at a fixed version, positions and error messages, nested calls and subagents, MCP, restart recovery, and SQLite persistence.

The Pi integration test starts the installed Pi with its agent folder set up as `wisdom init` does, in an isolated temporary workspace. A local scripted provider drives real file tools and nested calls without network requests or model spend. It checks skill loading, reads while Pi is running, the opened turn, and the mirrored transcript byte-for-byte. Set `WISDOM_PI_ENTRY` if the managed Pi installation is not available. Test workspaces are removed afterward.
