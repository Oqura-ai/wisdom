# Wisdom

Wisdom records a Pi session while it runs and makes its evidence queryable from another terminal or agent. The project root is this directory.

Wisdom has a local daemon, SQLite storage, a Pi extension, a CLI, and one read-only MCP query tool. Presets and composable queries let you retrieve intent, edits and tool outputs in one request. It does not orchestrate agents or generate model-written summaries. Intent views show recorded surface text with evidence references.

## Start here

Requires Node.js 24 or newer and an existing Pi installation. The extension was tested against the installed Pi 1.2.0. SQLite comes with Node; no database installation is needed.

```powershell
npm.cmd ci --legacy-peer-deps
npm.cmd run build
npm.cmd run wisdom -- daemon start
```

On shells without PowerShell's script restrictions, `npm` works instead of `npm.cmd`.

Start a tracked Pi in the project you want to observe:

```powershell
npm.cmd run wisdom -- track --cwd "C:\path\to\your\project"
```

The launcher uses your managed Pi installation and passes our extension and the bundled `wisdom-ledger` skill explicitly. It does not change your global Pi configuration. `--pi-entry <absolute-path-to-cli.js>` supports another installation. Pi options go after a second `--`:

```powershell
npm.cmd run wisdom -- track --cwd "C:\path\to\project" -- --continue
```

Inside Pi, `/wisdom-status` reports the capture ID. Each startup/resume/reload gets a new capture; Pi's conversation ID is stored separately. A resumed session's native copy includes its existing history, but file observations start when this capture starts.

The daemon remains running after Pi exits. To query from a second terminal:

```powershell
npm.cmd run wisdom -- sessions
npm.cmd run wisdom -- intent <capture-id>
npm.cmd run wisdom -- interaction-review <capture-id>
npm.cmd run wisdom -- failures <capture-id>
npm.cmd run wisdom -- changes --workspace "C:\path\to\project"
npm.cmd run wisdom -- file-history --workspace "C:\path\to\project" --path src/auth.ts
npm.cmd run wisdom -- vocabulary
```

`interaction-review` returns requests, surface messages, patches, and outputs together, omitting tool arguments. `changes` can span all tracked sessions in a workspace. Use `--session <pi-session-id>` to narrow to a logical session, or pass a capture ID for one recording. Query replies are structured JSON by default.

For conversation content without metadata wrappers:

```powershell
node dist/src/cli.js interaction-review --session <pi-session-id> --clean
node dist/src/cli.js intent --session <pi-session-id> --clean
node dist/src/cli.js timeline --session <pi-session-id> --clean
```

Clean mode returns an array of `{user}`, `{assistant}`, and `{tool, input, output}` objects. It preserves content without summarizing, joins tool results to their starts, and removes matching duplicate native copies. Text blocks become strings; other structured data remains structured. No IDs, timestamps, patches or coverage wrappers are included. Pending or missing tool results appear as `output: null`.

Use `"clean": true` in MCP/JSON queries. The daemon formats clean output; CLI, MCP and HTTP use the same service. Clean results exceeding `--limit` or `--max-chars` produce an error rather than silently truncating; raise those limits or narrow the query. Keep the normal view for provenance and coverage checks.

Read exact bodies by record ID:

```powershell
npm.cmd run wisdom -- inspect <capture-id> <record-id> --section data
npm.cmd run wisdom -- inspect <capture-id> <change-id> --section patch
```

All query commands return JSON. Use `--limit` and `--cursor` for preset pages;
`--read-version` fixes the evidence boundary. Inspection uses `--max-chars`
and `--offset` to read large bodies in parts. Record IDs differ from Pi tool-call
IDs. Use `include` to join related evidence without fetching intermediate IDs.

For a custom query, create a JSON request and use `query --file request.json`. Start at the data you know and select related evidence in the same request:

```json
{
  "find": "changes",
  "scope": {"workspaceRoot": "C:/path/to/project"},
  "where": {"path": "src/auth.ts", "tool.isError": true},
  "select": ["path", "patch", "attribution"],
  "include": {
    "request": {"select": ["content"]},
    "outputs": {"select": ["content", "isError"]}
  }
}
```

`readVersion` fixes all included evidence to the same database revision. Root pages return `nextCursor`; included relations return a directly usable `nextQuery`. Bodies share `maxChars` and report truncation explicitly. See the [vocabulary](docs/NOMENCLATURE.md), [query examples](docs/QUERY-EXAMPLES.md), and [storage/code map](docs/STORAGE.md).

## What is running?

```text
Pi extension ── local HTTP ── daemon ── SQLite
                                 │
                         indexed query engine
                                 │
                  CLI queries / MCP queries
```

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

The server exposes `ledger_query`. Use `op=describe` for discovery, `op=sessions` for capture inventory, a `preset` for standard views, or `find/where/select/include` for a custom projection. Use `op=inspect` for exact body pages. Requests use the same schema and engine as the CLI. The tool cannot start Pi or edit code. Starting the MCP adapter can start the local daemon, including normal interrupted-capture recovery.

Agents can query directly by workspace, path, session, or known capture without collecting intermediate record IDs. The portable [harness skill](skills/wisdom-ledger/SKILL.md) explains scope, progressive disclosure, and evidence limits. `wisdom track` loads it into Pi and sets `WISDOM_CLI_PATH` so the skill can call this installation from another project. For another harness, register/copy `skills/wisdom-ledger/` through that harness's skill mechanism and configure the MCP server above or an absolute CLI path. No global harness configuration is changed by this repository.

## Files you can read

```text
.wisdom/
  daemon.json                  # Local connection details; do not commit
  daemon.log
  ledger.sqlite                # Authoritative capture/record metadata and SQL indexes
  ledger.sqlite-wal            # SQLite may keep sidecar files while running
  ledger.sqlite-shm
  sessions/<capture-id>/
    pi-session.jsonl           # Complete native records, byte-preserved
    payloads/<sha256>          # Exact observed arguments/results and patches
```

All generated data stays local. Native transcripts and hook payloads are preserved without redaction and may contain sensitive content. `.wisdom/` is ignored by Git. Live hook payloads and native records can overlap: one records what the extension observed, the other preserves what Pi persisted.

SQLite is authoritative. Historical Wisdom `manifest.json`, `events.jsonl` and
`changes.jsonl` are ignored and left untouched. There is no importer or dual-write.
Native Pi JSONL remains source evidence. For backup, stop the daemon and copy
the whole data directory, including payloads and native mirrors. See
[storage details](docs/STORAGE.md).

A previously recording capture becomes interrupted after daemon restart; it does not silently resume with a missing file baseline. Reload the Pi extension to create a new capture after restoring the daemon.

## Capture scope and honest limits

- Native session mirroring and idle watcher processing run every 500 ms. Before a tool runs, Pi waits for its start observation to be accepted. File changes are observed at tool boundaries, not after every internal filesystem write.
- Direct `read`, `edit`, and `write` calls inspect their named target and watcher hints. Shell/custom calls reconcile the tracked workspace afterward. An idle reconciliation also runs every 30 seconds as a watcher fallback.
- Baseline contents live in memory. The first version caps an individual observed file at 1 MiB, a workspace scan at 10,000 files, and retained baseline bytes at 64 MiB. Limits and read errors produce visible gaps. Scans are synchronous and can briefly delay queries; use a bounded workspace.
- `.git`, `.wisdom`, `.npm-cache`, `node_modules`, `dist`, `build`, `.next`, `.venv`, and `__pycache__` are excluded by directory name. Symlinks are excluded. Permissions/ACLs are not tracked.
- Add `.wisdomignore` in the tracked project for relative paths to exclude. It accepts files and directory prefixes, one per line, with `#` comments; it intentionally has no glob or negation syntax. Wisdom's own file excludes `private/`.
- Changes during tools are labelled `observed-during-tool`, with all active tool IDs. This is temporal evidence, not proof of exclusive authorship. Idle changes are `external-or-unknown`.
- User shell commands outside model tool hooks are observed through filesystem activity and native records; they are not automatically attributed as agent tool calls.
- Renames appear as delete + create. Creations, modifications and deletions store UTF-8 unified diffs when possible; a created or deleted file diffs from or to empty, so its contents are readable. Binary changes get hashes and a missing-patch explanation. Full historical restoration is not promised.
- A failed tool can leave changes, which are still recorded. Pending calls remain visible if recording stops. A lost extension heartbeat marks the capture interrupted after 30 seconds.
- If before-tool recording fails, this tracking extension blocks that tool and reports the problem. Restore the daemon and `/reload`, or explicitly start Pi without tracking. Post-tool capture failure cannot undo a write that already occurred.
- SQLite commits use WAL and FULL synchronous mode. Payload/native-file writes are separate and are not one atomic, power-loss-safe transaction with the database. Recorded recovery gaps and mirror mismatches appear in recovery coverage. Native records above 32 MiB and requests above 16 MiB are explicit limits.
- No LLM-inferred intent, candidate-bound test certification, fixed code review snapshots, automatic multi-agent attribution, or full-text search engine is implemented. `where.text` searches summaries only; full-body search is not implemented. Exact IDs, tool links, request links and file paths have SQL indexes.
- Native-message `observed-input-window` links are temporal, especially after queued input, steering or branching. Read `linkBasis` and attribution before inferring causality. Read versions freeze evidence, not the codebase itself.

## Read the implementation

Read these in order:

1. [schema.ts](src/schema.ts): record and query vocabulary.
2. [pi-extension.ts](src/pi-extension.ts): how Pi supplies events and waits at tool boundaries.
3. [captures.ts](src/captures.ts): session lifecycle and operation/change coordination.
4. [workspace.ts](src/workspace.ts): scoped file observation and diff generation.
5. [database.ts](src/database.ts) and [ledger.ts](src/ledger.ts): SQLite, payloads and native mirroring.
6. [vocabulary.ts](src/vocabulary.ts), [selection.ts](src/selection.ts), [composable-query.ts](src/composable-query.ts): shared names, parameterized SQL and progressive projections; [query.ts](src/query.ts) dispatches operations, [evidence.ts](src/evidence.ts) reads exact bodies, [content.ts](src/content.ts) and [cursor.ts](src/cursor.ts) share text extraction and cursor encoding, and [clean-query.ts](src/clean-query.ts) formats conversation content.
7. [daemon.ts](src/daemon.ts): small HTTP boundary and daemon lifecycle.
8. [cli.ts](src/cli.ts), [client.ts](src/client.ts), [mcp.ts](src/mcp.ts): human/agent interfaces.

The design notes in [notes/README.md](notes/README.md) explain the later review architecture. They include future work; this README describes the implemented boundary.

## Verification

```powershell
npm.cmd test
npm.cmd run test:pi
```

The first suite checks live queries, exact edit patches, failure side effects, partial native records, stable pagination including related evidence, project isolation, nested calls, MCP, restart recovery, SQLite persistence, and projection/continuation behavior.

The Pi integration test launches the installed Pi in an isolated temporary workspace and config directory. A local scripted provider drives real file tools and nested calls without network requests or model spend. It checks skill loading, queries while Pi is running, the interaction-review projection, and the mirrored transcript byte-for-byte. Set `WISDOM_PI_ENTRY` if the managed Pi installation is not available. Test workspaces are removed afterward.

## API cleanup (0.3)

`browse`, `search`, `follow`, `--through`, and `--json` have been removed.
Use presets and `find/where/select/include`; all query responses are JSON and
`readVersion` is the only evidence boundary. Old cursors are unsupported.
Existing SQLite records and evidence files remain unchanged. Rebuild and restart
the daemon to use the new contract; restart MCP clients as well.
