# SQLite storage and code map

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

.wisdom/harnesses/<harness>/home/                             (the harness's own files: native sessions, the source of truth)
.wisdom/harnesses/<harness>/<capture>/native-session.jsonl    (native evidence)
.wisdom/harnesses/<harness>/<capture>/payloads/<sha256>       (hook bodies / patches)
.wisdom/harnesses/claude-code/<capture>/subagents/agent-<id>.jsonl

```

## Tables

The executable DDL is in [database.ts](../src/database.ts). SQLite `user_version=1`
is the database layout version; record `schemaVersion=1` and the daemon's
`captureApi` (checked by clients before they record or read) describe different contracts.

| Table | Columns | Purpose |
| --- | --- | --- |
| `captures` | `id` PK, `session_id`, `workspace_root`, `manifest`, `recovery_gaps` | Capture lifecycle, workspace/session identity, scope and recorded recovery notes. Manifest and gaps are JSON strings. |
| `records` | `revision` integer PK autoincrement, `id` unique, `capture_id` FK, `seq`, `type`, `parent_id`, `request_id`, `tool_call_id`, `tool_name`, `source_entry_id`, `path`, `role`, `is_error`, `observation_id`, `body` | Immutable evidence metadata and indexed relationship columns; `body` preserves the complete JSON envelope, including optional fields. |

Constraints enforce `(capture_id,seq)` and `(capture_id,observation_id)` uniqueness.
Repeated observation IDs are acknowledged without recording another hook event.
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
write native mirrors and payload files under their capture directory. Historical
Wisdom manifests and event/change JSONL are ignored and left untouched; there is
no importer or metadata dual-write. The ledger reads records as they are; a
change to how evidence is shown never rewrites stored evidence.

Stop the daemon before copying the **whole data directory** for a coherent backup.
Do not copy just `ledger.sqlite` from a running WAL database. Native transcripts
cannot recreate missing hook events or exact file observations, so deleting the
database is not a rebuild strategy.

Recording captures become interrupted after daemon restart because the in-memory
workspace baseline cannot be safely reconstructed as if no time had passed.
Continue recording with `wisdom resume <session>` (or `/reload` in Pi). Old captures remain readable.

## Reading the implementation

| File | Responsibility |
| --- | --- |
| [schema.ts](../src/schema.ts) | Zod wire validation and record/manifest types. |
| [database.ts](../src/database.ts) | DDL, metadata persistence, indexed lookups and request-link derivation. |
| [ledger.ts](../src/ledger.ts) | Payloads, native byte copying and evidence envelopes. |
| [captures.ts](../src/captures.ts) | Recording lifecycle and hook/file coordination. |
| [workspace.ts](../src/workspace.ts) | File baselines, scoped observations and patch creation. |
| [discovery.ts](../src/discovery.ts) | The agent-facing ledger: positions, glance, open, de-duplication by `toolView`, the ceiling and continuation. |
| [conversation.ts](../src/conversation.ts) | One turn assembled in recorded order (replies, thinking, calls, results, changes, nested subagents); shared by the ledger and the dashboard. |
| [evidence.ts](../src/evidence.ts) | Read-local body cache and the version boundary. |
| [content.ts](../src/content.ts) | Surface text extraction and the surface-role definition. |
| [views.ts](../src/views.ts) | The dashboard's reads (`POST /view`). |
| [daemon.ts](../src/daemon.ts) | Local authenticated HTTP and lifecycle. |
| [harnesses/types.ts](../src/harnesses/types.ts) | The adapter contract: tool targets, direct file tools, how each tool is shown (`toolView`), and native-line reading. |
| [harnesses/pi/](../src/harnesses/pi/) | Pi adapter, extension and launcher. |
| [harnesses/claude-code/](../src/harnesses/claude-code/) | Claude Code adapter, hook mapping and launcher; the plugin lives in [integrations/claude-code/](../integrations/claude-code/). |
| [harnesses/codex/](../src/harnesses/codex/) | Codex adapter, hook mapping, trust preflight and launcher. See [Codex recording](CODEX.md). |
| [client.ts](../src/client.ts) | Daemon descriptor lookup, authenticated calls and background startup. |
| [mcp.ts](../src/mcp.ts) / [cli.ts](../src/cli.ts) | Two clients of the same ledger; both return its text unchanged. |
| [stats.ts](../src/stats.ts) | Dashboard project inventory and per-harness, capture, tool, file and model counts and token usage in SQL. Usage records come from each adapter's `nativeEntry().usage` ([harnesses/types.ts](../src/harnesses/types.ts)). |
| [dashboard.ts](../src/dashboard.ts) / [dashboard/](../dashboard/) | Optional Next.js live viewer started by the daemon; reads through `/view`. |

A read runs synchronously in the daemon's event loop, so no hook append interleaves
with it, and every read filters by version, so a continuation sees the same evidence.
A glance reads one capture's structural records and the inputs' bodies; opening a turn
reads that turn's records and bodies. Capture manifests and live file baselines are in
memory. Large bodies are read whole before the response is cut at the ceiling. These are
explicit scalability limits, not a claim of unlimited read performance.
