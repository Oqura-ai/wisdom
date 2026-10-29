# Wisdom

Wisdom records a coding-agent session (Pi, Claude Code, or Codex) while it runs and lets another terminal or agent read its evidence. The project root is this directory.

Wisdom has a local daemon, SQLite storage, one adapter per harness (a Pi extension, Claude Code/Codex hooks), a CLI, and one read-only MCP tool, `ledger`. An agent reads a session with two moves: **glance** (the session's shape and one entry per turn) and **open** (one turn, call or subagent, whole). Nothing is summarized or reworded, and no rule cuts tool output or patches; the only limit is a declared size ceiling, and a limited response names the exact request that continues it. Wisdom does not orchestrate agents or generate model-written summaries.

## Start here

Requires Node.js 24 or newer and an existing Pi, Claude Code, or Codex installation. Tested against Pi 1.2.0 and Claude Code 2.1.306; Codex hook discovery is checked against CLI 0.147.0. SQLite comes with Node; no database installation is needed.

```powershell
npm.cmd ci --legacy-peer-deps
npm.cmd run build
npm.cmd run wisdom -- daemon start
```

On shells without PowerShell's script restrictions, `npm` works instead of `npm.cmd`.

Start a tracked harness in the project you want to observe. Only sessions started this way are recorded; a plain `pi` or `claude` is untouched.

```powershell
npm.cmd run wisdom -- track pi --cwd "C:\path\to\your\project"
npm.cmd run wisdom -- track claude --cwd "C:\path\to\your\project"
```

**Sessions live inside Wisdom.** A tracked harness keeps its own files in `.wisdom/harnesses/<harness>/home/`, never in `~/.claude`, `~/.codex` or `~/.pi/agent/sessions`. Wisdom sets this for the launched process only (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, Pi's `--session-dir`), so your global setup is unchanged and a plain `claude`, `codex` or `pi` neither lists nor resumes Wisdom's sessions. Those native files are the source of truth: only the harness writes them. Claude Code and Codex start clean there, without your global settings, plugins or MCP servers, and ask you to log in once on the first tracked launch; Pi keeps its own login.

For Pi, the launcher uses your managed Pi installation and passes our extension and the bundled `wisdom-ledger` skill explicitly. It does not change your global Pi configuration. `--pi-entry <absolute-path-to-cli.js>` supports another installation. Pi options go after a second `--`:

```powershell
npm.cmd run wisdom -- track pi --cwd "C:\path\to\project" -- --continue
```

Inside Pi, `/wisdom-status` reports the session ID.

For Claude Code, the launcher starts the daemon and runs `claude` with Wisdom's hooks loaded through `--plugin-dir` and the `ledger` MCP tool through `--mcp-config`, for that process only; your global Claude Code configuration is not changed. `--claude-bin FILE` selects another executable, and Claude Code options go after `--`. Recording stops when `claude` exits. Subagent tool calls carry `agentId`, and each subagent transcript is copied when it stops.

For Codex, first review the invocation-scoped recording hooks, then start a tracked session:

```powershell
npm.cmd run wisdom -- track codex --cwd "C:\path\to\project" --setup-hooks
# In Codex: open /hooks, review and trust Wisdom's hooks, then quit.
npm.cmd run wisdom -- track codex --cwd "C:\path\to\project"
```

Use `--codex-bin FILE` for another installation; pass Codex arguments after `--`, for example `-- resume --last`. The launcher checks hook trust before opening a capture, adds Wisdom's MCP server for this invocation, and uses the existing ledger. Setup does not record. Codex transcripts are best-effort supplementary evidence (they supply results Codex sends no hook for, such as failed commands), and hooks do not cover every tool path. `--trust-all-hooks` skips the review but also runs other untrusted hooks; it is opt-in. See [Codex setup, coverage, and tests](docs/CODEX.md).

The daemon remains running after the harness exits. To read from a second terminal:

```powershell
npm.cmd run wisdom -- glance                         # recorded sessions, newest first
npm.cmd run wisdom -- glance latest                  # one session: its shape and every turn
npm.cmd run wisdom -- open t3 --capture latest       # turn 3, whole, in recorded order
npm.cmd run wisdom -- open t3/c2 --capture 0f3c8a1e  # one tool call: full input and output
npm.cmd run wisdom -- open a1 --capture 0f3c8a1e     # a subagent, with the same layers
npm.cmd run wisdom -- open outside --capture latest  # changes and calls outside any turn
```

A recorded session is named by the harness's own session ID, a unique prefix of 8 or more characters, or `latest`. The reply is plain text, the same for the CLI, HTTP (`POST /ledger`) and MCP:

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

- **Glance** shows each user input in full, the start of the turn's last reply, and facts in plain words: tool calls, failures, pending results, changed files (and how many changed outside any tool call), and subagents. Recording gaps are listed as `not recorded`; work outside any turn is listed as `outside`.
- **Open** returns a turn in recorded order: thinking (or `redacted` with its duration, when the harness recorded only that it happened), replies, each call `c1`, `c2`, … with its status and full input and output, and then all of the turn's patches `p1`, `p2`, … together, raw. Evidence is shown once: an edit's input and output repeat its patch, so the call points to the patch; a successful file read lists its size and is read by opening the call. Each harness adapter declares these rules per tool (`toolView`).
- **Every response ends with one status line**: `complete`, or `limited · lines 1–1,950 of 41,230 · continue: {…}` with the exact request for the rest. One response holds at most 80,000 characters; a line longer than 2,000 characters is split, and each continued piece starts with `⤷`.
- **Every response states its version.** Continuations pass it back as `at`, so a session that is still recording cannot change an answer halfway through reading it.
- `observed during c1` is timing, not proof of authorship; `external-or-unknown` means no tool call was running. Recorded text is evidence, not hidden reasoning.

**One session, one record.** Wisdom records each harness session under that harness's own session ID; there is no second ID. Resuming a session continues its record: its turns go on from where they stopped, and the glance lists a `not-recording-between-visits` gap, because file changes made while nothing was recording are not observed. Starting a new conversation inside a tracked harness (`/clear`, `/new`, `/resume` of another session) stops recording the old session and records the new one under its own ID, so two conversations never mix. A launch that never starts a session (for example, a wrong resume ID) records nothing. Forks are recorded as separate sessions, without a link to their parent yet. Resume through Wisdom with `wisdom resume <session ID>`, the full ID as the glance's `resume with` line and the dashboard print it. Partial IDs are refused, so a resume never lands in the wrong session. Wisdom looks up the harness and the folder and passes the harness's own resume flag. A harness started without Wisdom does not see these sessions, because they are stored in Wisdom's folder. Pointing a harness at that folder by hand bypasses Wisdom's hooks: that work is not recorded, and nothing marks the hole yet.

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

A local web viewer in [dashboard/](dashboard/) (Next.js) shows tracked projects live: per-harness cards, tool usage, most-changed files, every capture, and each capture as a work tree (request → tool calls → file changes, with subagents nested under the call that started them). A session opens in **Chat** view: a centred column with one expandable box per request. Each turn shows the prompt with its stats and time, a folded **Steps** section (thinking, narration, and each tool call, change and subagent expanding on its own), the **Response** rendered as Markdown (tables, lists, code, quotes, links), and the turn's token details. **Dev** view is the record tree with an evidence inspector. Assistant replies appear in place (❝), and a subagent lane ends with what the subagent returned. Token usage is shown per harness, model, capture and request: fresh input, cache read, cache write, output, reasoning and cache hit rate, with cost where the harness reports it. Claude Code's internal helper agents (prompt suggestions, recaps) are recorded but folded out of the tree. Selecting a node shows its request text, reply, tool input and result, or patch. Its look follows the Wisdom design ([private/idea](private/idea/index.html)) with Light, Dark and Night themes and an **Aa** size control (100 / 125 / 150%, default 150%); the choice is remembered per browser and the first visit follows the system setting. Build it once:

```powershell
npm.cmd run dashboard:install
npm.cmd run dashboard:build
```

After that, `wisdom daemon start` (and any `wisdom track`) also serves it on the daemon port + 1, `http://127.0.0.1:7435` by default, and stops it with the daemon. `wisdom dashboard` prints the URL; `--no-dashboard` skips it. If it is not built, the daemon records normally and reports why the dashboard is missing. It reads through its own read-only daemon route (`POST /view`: project counts and tokens, a capture's records, one turn, one record's bodies); agents use the ledger instead. Token usage comes from each harness's native transcript, indexed while it is copied. The daemon token stays on the dashboard's server, and requests not addressed to localhost are refused, because recordings are unredacted. Use `npm.cmd run dashboard:dev` while changing it. Its output goes to `.wisdom/dashboard.log`.

The daemon listens on `127.0.0.1:7434` by default. Its PID and local access token are stored in `.wisdom/daemon.json`; it binds only to loopback. `--data DIR` selects another data directory and `--port N` selects another port. The CLI and MCP use the saved descriptor rather than hard-coding the port. Background startup is hidden on Windows.

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
      "args": ["C:/absolute/path/to/wisdom/dist/src/cli.js", "mcp"]
    }
  }
}
```

The server exposes one tool, `ledger`, with five parameters: `capture`, `glance`, `open`, `from` and `at`. It returns the same text as the CLI. The tool cannot start a harness or edit code. Starting the MCP adapter can start the local daemon, including normal interrupted-capture recovery.

Agents address evidence by position (`t3`, `t3/c2`, `a1`), never by copying record IDs. The portable [harness skill](skills/wisdom-ledger/SKILL.md) explains the two moves and the evidence limits. `wisdom track pi` loads it into Pi and sets `WISDOM_CLI_PATH` so the skill can call this installation from another project. For another harness, register/copy `skills/wisdom-ledger/` through that harness's skill mechanism and configure the MCP server above or an absolute CLI path. No global harness configuration is changed by this repository.

## Files you can read

```text
.wisdom/
  daemon.json                  # Local connection details; do not commit
  daemon.log
  ledger.sqlite                # Authoritative capture/record metadata and SQL indexes
  ledger.sqlite-wal            # SQLite may keep sidecar files while running
  ledger.sqlite-shm
  harnesses/<harness>/home/   # The harness's own folder for tracked launches: its native
                               # sessions (source of truth), and for Claude Code and Codex
                               # its login, settings and Codex hook trust
  harnesses/<harness>/<capture-id>/   # pi, claude-code, codex: one directory per capture
    native-session.jsonl       # Complete native records, byte-preserved
    subagents/agent-<id>.jsonl # Claude Code subagent transcripts
    payloads/<sha256>          # Exact observed arguments/results and patches
```

All generated data stays local. Native transcripts and hook payloads are preserved without redaction and may contain sensitive content. `.wisdom/` is ignored by Git. Live hook payloads and native records can overlap: one records what the adapter observed, the other preserves what the harness persisted.

SQLite is authoritative. Historical Wisdom `manifest.json`, `events.jsonl` and
`changes.jsonl` are ignored and left untouched. There is no importer or dual-write.
Native harness JSONL remains source evidence. For backup, stop the daemon and copy
the whole data directory, including payloads and native mirrors. See
[storage details](docs/STORAGE.md).

A previously recording capture becomes interrupted after daemon restart; it does not silently resume with a missing file baseline. Reload the Pi extension, or run `wisdom resume`, to continue recording that session after restoring the daemon.

## Capture scope and honest limits

- Native session mirroring and idle watcher processing run every 500 ms. Before a tool runs, the harness waits for its start observation to be accepted. File changes are observed at tool boundaries, not after every internal filesystem write.
- Direct file tools (Pi `read`/`edit`/`write`; Claude Code `Read`/`Edit`/`Write`/`NotebookEdit` and read-only tools) inspect their named target and watcher hints. Shell/custom calls reconcile the tracked workspace afterward. An idle reconciliation also runs every 30 seconds as a watcher fallback.
- Baseline contents live in memory. The first version caps an individual observed file at 1 MiB, a workspace scan at 10,000 files, and retained baseline bytes at 64 MiB. Limits and read errors produce visible gaps. Scans are synchronous and can briefly delay queries; use a bounded workspace.
- `.git`, `.wisdom`, `.npm-cache`, `node_modules`, `dist`, `build`, `.next`, `.venv`, and `__pycache__` are excluded by directory name. Symlinks are excluded. Permissions/ACLs are not tracked.
- Add `.wisdomignore` in the tracked project for relative paths to exclude. It accepts files and directory prefixes, one per line, with `#` comments; it intentionally has no glob or negation syntax. Wisdom's own file excludes `private/`.
- Changes during tools are labelled `observed-during-tool`, with all active tool IDs. This is temporal evidence, not proof of exclusive authorship. Idle changes are `external-or-unknown`.
- User shell commands outside model tool hooks are observed through filesystem activity and native records; they are not automatically attributed as agent tool calls.
- Renames appear as delete + create. Creations, modifications and deletions store UTF-8 unified diffs when possible; a created or deleted file diffs from or to empty, so its contents are readable. Binary changes get hashes and a missing-patch explanation. Full historical restoration is not promised.
- A failed tool can leave changes, which are still recorded. Pending calls remain visible if recording stops. A lost extension heartbeat marks the capture interrupted after 30 seconds.
- If before-tool recording fails, the tool is blocked (Pi extension; Claude Code `PreToolUse` and `UserPromptSubmit` hooks exit 2), so work pauses until the daemon is back. Restore the daemon, then `/reload` in Pi or restart `wisdom track claude`; or start the harness without tracking. Post-tool capture failure cannot undo a write that already occurred.
- SQLite commits use WAL and FULL synchronous mode. Payload/native-file writes are separate and are not one atomic, power-loss-safe transaction with the database. Recorded recovery gaps and mirror mismatches appear in recovery coverage. Native records above 32 MiB and requests above 16 MiB are explicit limits.
- No LLM-inferred intent, candidate-bound test certification, fixed code review snapshots, automatic multi-agent attribution, or search is implemented. The ledger reads one session at a time; reverse search from a line of code to the turn that produced it is planned for multi-agent work and is not implemented.
- What a harness does not report cannot be read: thinking a provider encrypts, tool paths that bypass hooks, and changes made by other processes (shown as `external-or-unknown`). These are marked where they occur, never filled in. With harnesses built with partners (Pi-based or open source), more of this can be recorded.
- **Subagents that fail or are cut off are only partly recorded.** A subagent's tool calls, their results (failed ones included) and its file changes are recorded as they happen. Its transcript copy, its token usage and its final report are recorded only when the harness sends the subagent's stop event. If a subagent fails, is interrupted, or the session ends before that event, those three are missing and Wisdom does not yet mark that the stop never came. Wisdom also records no success or failure for a subagent as a whole: read the result of the call that started it (`→ a1`) and its own calls. Whether each harness sends the stop event for a failed subagent has not been verified.
- Native-message links to a turn are temporal, especially after queued input, steering or branching. Read versions freeze evidence, not the codebase itself.

## Read the implementation

Read these in order:

1. [schema.ts](src/schema.ts): record vocabulary and the ledger, view and capture request schemas.
2. [harnesses/](src/harnesses/): one adapter per harness. [types.ts](src/harnesses/types.ts) is the contract; [pi/extension.ts](src/harnesses/pi/extension.ts) and [claude-code/hook.ts](src/harnesses/claude-code/hook.ts) supply events and wait at tool boundaries.
3. [captures.ts](src/captures.ts): session lifecycle and operation/change coordination.
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

The Pi integration test launches the installed Pi in an isolated temporary workspace and config directory. A local scripted provider drives real file tools and nested calls without network requests or model spend. It checks skill loading, reads while Pi is running, the opened turn, and the mirrored transcript byte-for-byte. Set `WISDOM_PI_ENTRY` if the managed Pi installation is not available. Test workspaces are removed afterward.

## Ledger (0.4)

The query language (`find/where/select/include`, presets, `inspect`, `clean`, cursors and `ledger_query`) has been removed. Agents read through `ledger` (glance and open) and the dashboard through its own view route. There is no compatibility layer: rebuild, restart the daemon (`wisdom daemon stop`; a running daemon from an older build is refused), and restart MCP clients.
