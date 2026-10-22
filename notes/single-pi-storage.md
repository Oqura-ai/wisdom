# One Pi session: minimal storage

Decision date: 2026-10-19. Status: proposed first storage contract; no recorder implementation is claimed.

Historical proposal: the 2026-10-20 implementation now uses authoritative SQLite metadata plus native JSONL and payload files. See [current storage](../docs/STORAGE.md) and [query vocabulary](../docs/NOMENCLATURE.md). Storage points below that the implementation superseded:

- **Layout:** `manifest.json` and `changes.jsonl` are not written. Capture manifests and all records live in `.wisdom/ledger.sqlite`; each capture directory holds only `pi-session.jsonl` and `payloads/`.
- **Import:** there is no historical-import mode or JSONL importer. Every capture is live observation; older Wisdom manifests and event/change JSONL are ignored and left untouched.
- **Database:** SQLite is the authoritative metadata store, not a rebuildable index.

The goals, attribution rules and review direction below still apply.

## Goal and limits

Explain one Pi session: what was requested, what tools ran, which files appeared/disappeared, and what edits were observed. Prioritize edit diffs. Do not snapshot the whole repository after each call or promise restoration of every historical state.

Creation/deletion/rename events can be lightweight. A creation filename alone cannot reconstruct or review the original contents. Reference retained write-tool arguments when available; a later fixed review candidate must contain actual new-file contents.

## Proposed layout

```text
.wisdom/sessions/<capture-id>/
  manifest.json       # Identity, source, workspace, capture scope and status
  pi-session.jsonl    # Preserved Pi session records; do not normalize in place
  changes.jsonl       # Append-only observed changes with evidence references
  payloads/           # Large patches/content, referenced by hash; optional initially
```

Use our capture ID separately from Pi's session ID: one Pi session can be resumed across captures. Ingest existing JSONL by copying it into a capture or pinning a retained immutable source. For live capture, track complete records and a source cursor; do not treat an unfinished final line as a complete event. Pi owns its live session file; our recorder must not write into it.

If a separately captured RPC journal already exists, reference and retain it as another source rather than pretending it is identical to Pi's session file. Rebuildable indexes can join both later.

## Manifest fields

- schemaVersion, captureId, piSessionId, source path and recorded source hash/size for an imported file.
- Workspace root, captured timestamps, and original recorded cwd separately (historical files can move).
- Capture mode: historical-import or live-observation.
- Included/excluded paths and whether contents, binary files, symlinks, and permissions are observed. Exclusions limit completeness.
- State such as importing, recording, closed, or interrupted; this describes capture, not proof of task completion.

## Change records

Each record carries schemaVersion, stable change ID, monotonic sequence, capture/workspace IDs, operation, path, optional oldPath, source entry ID, toolCallId when established, attribution basis, and observation status.

For edits, add beforeHash, afterHash, and an inline patch or payloadRef when actually captured. Hashes verify content identity; they do not restore content. Specify the hash algorithm and preserve byte/encoding semantics. Binary or unsupported changes are explicitly marked rather than represented by a misleading text diff.

Operations: create, modify, delete, rename. A confirmed rename can record both paths; otherwise preserve delete/create observations without inventing a rename.

Distinguish directly instrumented writes, changes observed during a tool interval, transcript-reported operations, and unknown/external changes. A tool call expresses an attempt; its result reports an outcome; neither alone is an independently observed workspace diff. Failed tools can leave changes.

Use Pi entry IDs and toolCallIds for links. Do not assume parentId means a file dependency, that adjacent records form a call/result pair, or that physical JSONL order is the only conversation branch. Preserve Pi's parent relationships.

## Historical file versus future recording

The existing October 13 session can provide prompts, calls, results, and some requested file contents. Import and index that evidence first. Missing before-images and unobserved shell effects cannot be recovered reliably from today's files. Mark them unavailable; do not manufacture historical patches.

For future live edits, instrument the execution boundary to capture before/after contents of touched files and derive patches. Merely reacting to asynchronous RPC start notifications does not guarantee capture before a write.

Shell commands need broader change observation. File watchers are hints, not complete causal evidence; shared writers, missed events, and transient create/delete operations remain limitations. Start with one agent and explicitly account for manual edits. Pre/post observation still misses intermediate writes inside a command.

## Storage growth

Keep small patches inline initially. Put large payloads in separate compressed, content-addressed files when needed; events contain references and hashes. Reuse retained session content by entry/block reference when appropriate instead of duplicating full write arguments. Detect missing/redacted/truncated sources rather than claiming reconstructability.

Do not persist a separate normalized copy of every message or add a database yet. Add a rebuildable SQLite index when real queries require it. Display summaries first and load patches on demand.

## First useful result

For the existing session, produce a source-linked timeline of tool attempts/results and reported file operations, explicitly showing where actual diffs are unavailable. Then record one fresh create/edit/rename/delete experiment with independent observations to validate the capture contract.

Later, when agent review is introduced, add runtime-owned baseline/candidate capture at task boundaries as described in [the architecture decision](agent-review-architecture.md). The lightweight timeline alone is not a substitute for a fixed review candidate.
