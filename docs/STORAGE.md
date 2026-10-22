# SQLite storage and code map

Node 24's built-in `node:sqlite` supplies `DatabaseSync`. There is no ORM or extra
database service. The daemon remains the single writer and local query endpoint.

```text
Pi hooks + native JSONL + workspace observations
                     |
              Captures / Ledger
                     |
          .wisdom/ledger.sqlite
                     |
          one SQL selection engine
                     |
              HTTP / CLI / MCP

.wisdom/sessions/<capture>/pi-session.jsonl  (native evidence)
.wisdom/sessions/<capture>/payloads/<sha256> (hook bodies / patches)
```

## Tables

The executable DDL is in [database.ts](../src/database.ts). SQLite `user_version=1`
is the database layout version; API `queryVersion=3` and record `schemaVersion=1`
describe different contracts.

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
payloads appear when queried. Do not infer complete evidence after interruption.

## Storage and backup

SQLite is authoritative. New captures store metadata only in the database, and
write native mirrors and payload files under their capture directory. Historical
Wisdom manifests and event/change JSONL are ignored and left untouched; there is
no importer or metadata dual-write. Existing SQLite records need no migration
for query API version 3.

Stop the daemon before copying the **whole data directory** for a coherent backup.
Do not copy just `ledger.sqlite` from a running WAL database. Native transcripts
cannot recreate missing hook events or exact file observations, so deleting the
database is not a rebuild strategy.

Recording captures become interrupted after daemon restart because the in-memory
workspace baseline cannot be safely reconstructed as if no time had passed.
Reload Pi to start a new capture. Old captures remain queryable.

## Reading the implementation

| File | Responsibility |
| --- | --- |
| [schema.ts](../src/schema.ts) | Zod wire validation and record/manifest types. |
| [vocabulary.ts](../src/vocabulary.ts) | Resource names, fields, relation names, presets and discovery definitions. |
| [database.ts](../src/database.ts) | DDL, metadata persistence, indexed lookups and request-link derivation. |
| [ledger.ts](../src/ledger.ts) | Payloads, native byte copying and evidence envelopes. |
| [captures.ts](../src/captures.ts) | Recording lifecycle and hook/file coordination. |
| [workspace.ts](../src/workspace.ts) | File baselines, scoped observations and patch creation. |
| [selection.ts](../src/selection.ts) | Whitelisted fields/operators compiled to parameterized SQL. |
| [composable-query.ts](../src/composable-query.ts) | Preset expansion, scoped pages, relation expansion, projection, budgets and coverage. |
| [query.ts](../src/query.ts) | Strict dispatch: selection, clean presentation, sessions and inspection. |
| [evidence.ts](../src/evidence.ts) | Query-local body cache and indexed exact inspection. |
| [content.ts](../src/content.ts) / [cursor.ts](../src/cursor.ts) | Shared text extraction and opaque cursor encoding. |
| [clean-query.ts](../src/clean-query.ts) | Bounded conversation selection and formatting in the daemon. |
| [daemon.ts](../src/daemon.ts) | Local authenticated HTTP and lifecycle. |
| [pi-extension.ts](../src/pi-extension.ts) | Pi hooks that send observations and wait at tool boundaries. |
| [client.ts](../src/client.ts) | Daemon descriptor lookup, authenticated calls and background startup. |
| [mcp.ts](../src/mcp.ts) / [cli.ts](../src/cli.ts) | Two clients of the same query contract. |

Custom root selection runs in SQLite; includes fetch bounded related pages
internally. One client request can involve several SQL statements. This avoids
client-side ID discovery, not all internal lookups. Queries run synchronously in
the daemon's event loop, so no hook append interleaves with their current execution.
Every selection additionally filters by `readVersion`, allowing later continuation
requests to see the same evidence boundary.

SQLite avoids loading the complete record history into maps at startup. Capture
manifests and live file baselines are still in memory. Coverage scans the selected
scope; summary substring search is not an FTS index. Large native records or payload inspections can
still allocate their full body before slicing. These are explicit scalability
limits, not a claim of unlimited query performance. Bound the workspace and query
scope before considering FTS, asynchronous IO, or a separate query worker.
