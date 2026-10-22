# Wisdom vocabulary

This is the developer reference for query version 3. The runtime library is
[src/vocabulary.ts](../src/vocabulary.ts). Run `node dist/src/cli.js vocabulary`
without a daemon, or send `{"op":"describe"}` to the daemon/MCP for discovery.

## Identity and evidence

| Name | Meaning | Scope / caveat |
| --- | --- | --- |
| Workspace | Canonical project directory | `scope.workspaceRoot`; Windows casing is normalized. |
| Session | Pi's logical conversation | `sessionId` in queries; `piSessionId` in manifests. One session may have multiple captures. |
| Capture | One Wisdom recording period | `captureId`; restarting/resuming Pi opens another capture. |
| Record / event | One immutable observation or source reference | `id`; unique across the database. |
| `seq` | Append position within one capture | The first record has sequence 1. |
| `readVersion` | Global SQLite append revision | Fixes all records and includes returned by a composable query. It is not a filesystem snapshot. |
| `lastSeq` | Latest visible sequence within a capture | Summary only; `readVersion` is the read boundary. |
| Request | Extension `input` event | This records arrival, not proof of when a queued input was consumed. |
| `requestId` | Input associated with an observation | Check `linkBasis`. Missing means unlinked, not nonexistent. |
| `parentId` | Immediate observed parent record | A result points to its start; a change points to the observed tool start when available. |
| `toolCallId` | Harness call/result ID | Join using **capture + toolCallId**, never toolCallId alone. |
| `sourceEntryId` | Entry ID in Pi's native transcript | Distinct from Wisdom's record ID. |
| `sourceParentId` | Pi transcript branch parent | Native branch structure is preserved, but is not interpreted as a filesystem history. |
| Patch | UTF-8 unified diff for an observed creation, modification or deletion | Creation and deletion diff from or to empty (`/dev/null`), so the file's contents are visible. Binary or non-UTF-8 sides have no patch and set `patchUnavailable`. |
| Payload | Exact stored hook body or patch | Content-addressed SHA-256 file within the capture directory. |
| Surface content | Recorded user/assistant text blocks | Excludes assistant thinking blocks and tool-call arguments. |
| Intent | Surface requests and explanations | No model-inferred intent, hidden reasoning, or claim that every reason was recorded. |
| Gap | Known missing/limited observation | Query events with `where.type="gap"`; also inspect recovery gaps. |

`linkBasis="recorded-parent"` follows the parent recorded by the hook observer.
`linkBasis="observed-input-window"` associates native records with the most recent
observed input at ingestion. The latter can be wrong for semantic intent after
steering, compaction, transcript branching, or delayed persistence. It is useful
navigation, not a causal assertion. Neither value proves the model consumed that input.

File `attribution="observed-during-tool"` means the change was seen during an
operation interval. `activeToolCallIds` preserves overlapping tools. External
writers may also have contributed. `external-or-unknown` identifies observations
without an active tool. This implementation does not solve parallel authorship.

## Query language

```json
{
  "find": "changes",
  "scope": {"workspaceRoot": "C:/projects/app"},
  "where": {"path": "src/auth.ts", "tool.isError": true},
  "select": ["path", "operation", "patch", "attribution"],
  "include": {
    "request": {"select": ["content"]},
    "outputs": {"select": ["content", "isError"]}
  },
  "limit": 20,
  "maxChars": 8000
}
```

| Property | Contract |
| --- | --- |
| `find` | `requests`, `messages`, `tools`, `outputs`, `changes`, or `events`. |
| `preset` | Named ordinary query: `intent`, `timeline`, `changes`, `failures`, `file-history`, `interaction-review`. |
| `captureId` | Shorthand for a single capture scope. |
| `scope` | `captureIds` and/or `sessionIds` arrays (1–100), and/or `workspaceRoot`. Supplied scope constraints intersect. At least one scope is required. |
| `where` | AND of field conditions. Values mean equality, or use `{eq}`, `{in}`, `{contains}`, `{gte}`, `{lte}`. Multiple operators on one field also AND together. |
| `select` | Fields to return. Identity and evidence references are always retained. An empty array selects identity only. |
| `include` | Relations to expand. Each accepts `select`, `where`, `include`, `limit`. |
| `limit` | Root page size 1–100, default 20. Includes default to 10, maximum 50. |
| `readVersion` | Optional existing global revision; omitted means current evidence. |
| `cursor` | Opaque continuation bound to the query and its original revision. Repeat the same query with this cursor. |
| `maxChars` | Shared body-character budget, 100–32,000; default 8,000. Metadata is additional. |
| `clean` | Conversation-only array with original content and no evidence wrappers. See below. |

`clean:true` works with `intent`, `timeline`, `interaction-review`, or
`find=events/requests/messages/tools/outputs`. Supply scope, optional `where`,
and optional `readVersion`. It is a fixed presentation; select/include, cursor,
inspection, inventory and changes presets are rejected. Filters apply to source
records before cleaning; filtered-out call halves can therefore appear as null.

Clean output consists of `{user: content}`, `{assistant: content}`, and
`{tool: name, input: arguments, output: result}`. A paired tool occupies its start
position. Only source copies linked to matching input and calls correlated by ID
are collapsed; repeated input text alone is never deduplicated. Empty assistant
tool-call/thinking-only messages and administrative records are omitted. Original
text is not paraphrased. Multiple text blocks are joined by newlines; non-text
blocks and arbitrary structured tool results remain structured. Pi's recognized
successful/untruncated shell stdout duplicate is unwrapped, removing its timing
and success envelope; failed/truncated structured envelopes retain their fields.

Clean mode runs in the daemon and reads relevant SQL pages at one readVersion. Because it
prints no continuation metadata, it errors when the final array exceeds `limit`
(default 20, max 100) or serialized `maxChars` (default 8,000, max 32,000), instead
of returning a partial conversation. Internal reads are capped at 10,000 relevant
records, 4 MiB per body, and 16 MiB total source bodies. Missing evidence
files cause an error. `output:null` means no captured result is available in the
selection. Clean output intentionally omits coverage, attribution, IDs and patches;
the standard response remains available for investigations requiring those facts.

Preset filters merge with explicit `where` values; explicit values override the
same preset key. Explicit `select` or `include` **replaces** that preset projection.
`file-history` requires `where.path`. Prefer workspace scope for history across
sessions, since unrelated projects can contain identical relative paths.

Filters: `id`, `captureId`, `sessionId`, `seq`, `type`, `parentId`, `requestId`,
`toolCallId`, `toolName`, `path`, `role`, `isError`, `observedAt`, `operation`,
`attribution`, `text`, `surface`, `tool.name`, `tool.isError`.

`text` searches the short deterministic summary, case-insensitively with
`contains`. It does not search all bodies. Paths are workspace-relative; both slash styles
are normalized to `/` in the shared filter compiler. Timestamps
use ISO strings; comparisons are lexical. `eq:null` tests absence; `in` does not
accept null. `surface` accepts a boolean. Relationship conditions use SQL EXISTS:
filtering a change by `tool.isError` finds its correlated hook result. It does not
mean every change in the same request failed.

Selectable fields are listed by `vocabulary.fields`. Most are the names above
plus `summary`, `observedAt`, `beforeHash`, `afterHash`, `operation`, `linkBasis`,
`activeToolCallIds`, and `patchUnavailable`. Special selections:

- `content`: surface text for requests/messages; serialized recorded JSON for tool outputs.
- `data`: original raw body, explicitly requested; may contain tool arguments and thinking blocks.
- `patch`: recorded unified diff, or `{available:false, reason}`.
- `status`: for tool starts, `completed`, `error`, or `pending-or-missing`. Completed means a result was recorded, not that the resulting code is correct.

## Relationships

| Relation | Starting from a request | Starting from a tool/output/change |
| --- | --- | --- |
| `request` | The request itself | Associated input via `requestId`. |
| `messages` | Associated recorded messages | Messages associated with that input. |
| `tools` | All starts associated with the input | Starts matching the same toolCallId. |
| `outputs` | All finishes associated with the input | Finishes matching the same toolCallId. |
| `changes` | All changes associated with the input | Changes matching the same toolCallId. |
| `source` | Empty unless there is an explicit source link | Native source records with the same toolCallId. A native record without a call ID returns itself. |
| `parent` | Recorded immediate parent, if present | Recorded immediate parent. |
| `children` | Direct recorded children | Direct recorded children. |

When a record lacks a call ID, tools/outputs/changes fall back to its associated
request. When it lacks both, the relation is empty. Nested operations with their
own IDs can be reached using `children`; a request-wide include also contains
their descendants through the stored request association. An include filter may
not override the keys that establish its relation.

Native pre-capture history remains available through `intent`/`messages`/`events`.
It is not manufactured into hook requests. Therefore `interaction-review`
includes interactions recorded during tracking, not every historical native turn.
Input hooks and native user messages may overlap; Wisdom preserves both kinds
of evidence rather than silently treating them as identical.

## Result and continuation vocabulary

Every root item has `id`, `captureId`, `sessionId`, and `evidence` references.
Each included relation returns `{items, truncated, nextQuery}`. Submit a returned
`nextQuery` directly when you need that relation's next page. Includes are capped
at depth 3 and 500 total expanded records. When the expansion budget interrupts a
relation mid-page, its continuation restarts that relation and says to deduplicate
by record ID. Root pagination is independent, via `nextCursor`.

Bodies return `{available, text, totalChars, truncated}`. Truncated bodies provide
an `inspect` request. For `content`, this opens the underlying raw evidence from
offset zero, since extracted surface-text offsets do not match raw JSON offsets.
For raw `data` and `patch`, the supplied offset continues after the excerpt.
Further inspection uses `sections.*.nextOffset`. Fragments need not be valid JSON
or whole diff hunks. Missing/unreadable evidence is reported in `issues`.

`coverage` covers the selected scope, **before root filters**: per-capture
`lastSeq`, `gapCount`, `pendingToolCount`, `recoveryGaps`, and `currentStatus`.
Only lifecycle status is live; evidence counts and includes use `readVersion`.
Zero matches does not prove an action never happened. An unknown/empty scope
returns zero records. Query `sessions` to check capture existence.

Selection, `op=inspect`, `op=sessions`, and `op=describe` have separate strict
schemas. Unknown fields/operators and mixed operation options are errors.
HTTP returns 400 with `error`; MCP marks the tool result as an error; the CLI exits
nonzero. No public raw SQL endpoint, automatic LLM query translation, GraphQL,
OR expressions, aggregates, arbitrary sort, or full-text index is implemented.

## Exact inspection and inventory

`{"op":"inspect","captureId":"CAPTURE","id":"RECORD","sections":["data","patch"]}`
reads one indexed record. Optional `readVersion` fixes visibility,
`contentOffset` defaults to 0, and `maxChars` is shared across sections.
The response contains `id`, `captureId`, `readVersion`, and `sections`.
Each section reports `available` and, when present, `text`, `totalChars`,
and `nextOffset`. Inspection does not scan capture-wide coverage.

`{"op":"sessions","limit":20}` lists capture manifests with `lastSeq` and
`nextCursor`. Repeat with that cursor for the next page. Inventory is live,
not a revision snapshot. `{"op":"describe"}` returns the query vocabulary.
