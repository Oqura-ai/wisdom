# Architecture

```text
Pi extension ─────┐
Claude Code hooks ┼ local HTTP ── daemon ── SQLite
Codex hooks ──────┘                │
                 ledger (glance/open) · dashboard views
                                 │
                  CLI / MCP (agents) · live dashboard (people)
```

Harness adapters send events to a local daemon, which stores them in SQLite beside byte-preserved copies of each harness's own session files. Agents and people read the same evidence through different views. Sessions imported from share files are kept as separate read-only stores, and each read goes to the store that holds the session. To read the code in order, start with [development](development.md#reading-the-code).

## Storage

Node 24's built-in `node:sqlite` supplies `DatabaseSync`. There is no ORM or extra
database service. The daemon remains the single writer and the only reader.

```text
Harness adapters (Pi extension, Claude Code/Codex hooks) + native JSONL + workspace observations
                     |
              Captures / Ledger
                     |
          .wisdom/ledger.sqlite
                     |
   ledger (glance/open)   dashboard views
                     |
     HTTP /ledger: CLI, MCP    HTTP /view: dashboard

.wisdom/wisdom.json                                           (marks the project; written by wisdom init)
.wisdom/spool/<harness>/<session>/<event>.json                (events a hook kept while the daemon was down)
.wisdom/harnesses/<harness>/home/                             (the harness's own files: settings with Wisdom's hooks, login, native sessions, the source of truth)
.wisdom/harnesses/<harness>/<capture>/native-session.jsonl    (native evidence)
.wisdom/harnesses/<harness>/<capture>/payloads/<sha256>       (hook bodies / patches)
.wisdom/harnesses/claude-code/<capture>/subagents/agent-<id>.jsonl

```

## Tables

The executable DDL is in [database.ts](../src/storage/database.ts). SQLite `user_version=1`
is the database layout version; record `schemaVersion=1` and the daemon's
`captureApi` (checked by clients before they record or read) describe different contracts.

| Table | Columns | Purpose |
| --- | --- | --- |
| `captures` | `id` PK, `session_id`, `workspace_root`, `manifest`, `recovery_gaps` | Capture lifecycle, workspace/session identity, scope and recorded recovery notes. Manifest and gaps are JSON strings. |
| `records` | `revision` integer PK autoincrement, `id` unique, `capture_id` FK, `seq`, `type`, `parent_id`, `request_id`, `tool_call_id`, `tool_name`, `source_entry_id`, `path`, `role`, `is_error`, `observation_id`, `body` | Immutable evidence metadata and indexed relationship columns; `body` preserves the complete JSON envelope, including optional fields. |

Constraints enforce `(capture_id,seq)` and `(capture_id,observation_id)` uniqueness.
Repeated observation IDs are acknowledged without recording another hook event.

Wisdom copies a native file only if it is that harness's file for that session: its
first line is a JSON object and none of its first 200 lines names another session
(`source-incompatible` otherwise). If the harness rewrites its file shorter, the copy
keeps every byte already read, a `source-rewritten` gap is recorded, and copying goes on
from the file's new end; the manifest's `sourceShift` holds the difference between the
read position and the copy's size, so it survives a restart.
Indexes support workspace/session selection and capture-scoped type, tool,
request, parent, source, and path traversal. `is_error` uses nullable 0/1.
The JSON envelope holds `dataRef`, `patchRef`, native byte offsets/lengths,
file hashes, operation, active tool IDs, attribution, summary, and timestamps.
This keeps optional evidence extensible without introducing a table per event kind.

Payloads are written before their metadata reference is committed. The recorder
uses WAL, foreign keys, a 5-second busy timeout, and SQLite FULL synchronous
commits. Native mirror and payload writes are separate filesystem operations,
not one atomic transaction with SQLite; they do not have an explicit fsync
guarantee. A crash can leave an orphan payload or unindexed mirror bytes. Such
mirror mismatches stop further copying and appear in recovery coverage. Missing
payloads appear as `unreadable` when read. Do not infer complete evidence after interruption.

## Storage and backup

SQLite is authoritative. New captures store metadata only in the database, and
write native mirrors and payload files under their capture directory. The ledger reads records as they are; a
change to how evidence is shown never rewrites stored evidence.

Stop the daemon before copying the **whole data directory** for a coherent backup.
Do not copy just `ledger.sqlite` from a running WAL database. Native transcripts
cannot recreate missing hook events or exact file observations, so deleting the
database is not a rebuild strategy.

Recording captures become interrupted after daemon restart because the in-memory
workspace baseline cannot be safely reconstructed as if no time had passed.
The session's next hook event continues it, with a gap for the time in between; events kept in the spool meanwhile are recorded first. Old captures remain readable.

## Reading the implementation

The source is grouped by domain, so a change to one usually stays in one folder. Imports
between folders follow one direction where possible: `core` and `storage` know nothing of
the others; `record` writes evidence; `read` only reads it; `service` ties them together.

| Folder | Domain | Files |
| --- | --- | --- |
| [src/](../src/) | Entry points. Installed hooks and the npm package point here, so these stay put. | [bin.ts](../src/bin.ts) checks the Node version, then loads [cli.ts](../src/cli.ts), every command. |
| [core/](../src/core/) | Shared types and small helpers. | [schema.ts](../src/core/schema.ts) wire validation and record/manifest types; [paths.ts](../src/core/paths.ts) data folders, harness homes, worktrees; [content.ts](../src/core/content.ts) surface text extraction. |
| [storage/](../src/storage/) | Where evidence lives. | [database.ts](../src/storage/database.ts) DDL, indexed lookups, request links; [ledger.ts](../src/storage/ledger.ts) payloads, native byte copying; [store.ts](../src/storage/store.ts) `SessionStore`, what the read layer needs; [evidence.ts](../src/storage/evidence.ts) body cache and the version boundary. |
| [record/](../src/record/) | Turning hook events into records. | [captures.ts](../src/record/captures.ts) recording lifecycle and hook/file coordination; [workspace.ts](../src/record/workspace.ts) file baselines and patches. |
| [read/](../src/read/) | What agents and the dashboard read. Changes here follow [policy](policy.md). | [discovery.ts](../src/read/discovery.ts) the ledger (glance, open, commits, positions, the ceiling); [conversation.ts](../src/read/conversation.ts) one turn in recorded order; [views.ts](../src/read/views.ts) the dashboard's `/view`; [stats.ts](../src/read/stats.ts) counts and token usage; [markdown.ts](../src/read/markdown.ts) `wisdom export`; [prices.ts](../src/read/prices.ts) cost estimates. |
| [service/](../src/service/) | The background service and talking to it. | [daemon.ts](../src/service/daemon.ts) local HTTP and lifecycle; [client.ts](../src/service/client.ts) finding, calling and starting it; [mcp.ts](../src/service/mcp.ts) the MCP tool; [dashboard.ts](../src/service/dashboard.ts) starts the viewer in [dashboard/](../dashboard/). |
| [setup/](../src/setup/) | Installing, checking and repairing. | [connect.ts](../src/setup/connect.ts) `connect`/`disconnect` and keeping `.wisdom/` out of git; [doctor.ts](../src/setup/doctor.ts) the health check; [repair.ts](../src/setup/repair.ts) repair with backups. |
| [sessions/](../src/sessions/) | Operations on one session. | [handoff.ts](../src/sessions/handoff.ts) `wisdom handoff`; [clone.ts](../src/sessions/clone.ts) `wisdom clone`. |
| [share/](../src/share/) | Sessions leaving or arriving as files. | [share.ts](../src/share/share.ts) the share file format; [secrets.ts](../src/share/secrets.ts) secret patterns and redaction; [shared.ts](../src/share/shared.ts) imported copies and routing reads to them. |
| [team/](../src/team/) | Commits and [team mode](team.md). | [commits.ts](../src/team/commits.ts) matching a commit's pieces to recorded steps, and the record format; [watch.ts](../src/team/watch.ts) noticing commits in local mode; [githooks.ts](../src/team/githooks.ts) team mode's three git hooks and their background job; [writer.ts](../src/team/writer.ts) the guide writer (a cheap model through Claude Code, or a configured command); [guides.ts](../src/team/guides.ts) checking a guide, and the person's on/off switch; [gitrefs.ts](../src/team/gitrefs.ts) hidden refs, link lines and the policy file; [team.ts](../src/team/team.ts) push, fetch, delete, prune, the CI check. [storage/readstore.ts](../src/storage/readstore.ts) lets those hook processes read recordings while the daemon writes. |
| [harnesses/](../src/harnesses/) | One folder per agent; the core reaches them only through [index.ts](../src/harnesses/index.ts). | [types.ts](../src/harnesses/types.ts) the adapter contract; [launch.ts](../src/harnesses/launch.ts) what adapters share (finding a harness, hook commands, the skill); [pi/](../src/harnesses/pi/), [claude-code/](../src/harnesses/claude-code/) (run by [integrations/claude-code/hook.mjs](../integrations/claude-code/hook.mjs)), [codex/](../src/harnesses/codex/) (see [harnesses](harnesses.md#codex)). |

A read runs synchronously in the daemon's event loop, so no hook append interleaves
with it, and every read filters by version, so a continuation sees the same evidence.
A glance reads one capture's structural records and the inputs' bodies; opening a turn
reads that turn's records and bodies. Capture manifests and live file baselines are in
memory. Large bodies are read whole before the response is cut at the ceiling. These are
explicit scalability limits, not a claim of unlimited read performance.
