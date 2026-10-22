# Following evidence without loading a whole session

These are request bodies for `ledger_query` (MCP), `/query` (local HTTP), or `wisdom query --file request.json`. Custom queries can start from workspace/path/session scope without first fetching record IDs. The full contract is in [NOMENCLATURE.md](NOMENCLATURE.md).

## Standard views

```json
{"preset":"intent","scope":{"workspaceRoot":"C:/projects/app"},"limit":10}
```

Presets are `intent`, `timeline`, `changes`, `failures`, `file-history`, and `interaction-review`. Each also has a CLI command:

```powershell
node dist/src/cli.js interaction-review CAPTURE
node dist/src/cli.js changes --workspace C:/projects/app
node dist/src/cli.js file-history --workspace C:/projects/app --path src/auth.ts
```

## Surface interaction, patches and outputs together

```json
{
  "preset": "interaction-review",
  "captureId": "CAPTURE",
  "limit": 5,
  "maxChars": 12000
}
```

The root is recorded input. Each item contains `content`, `messages.items`, `changes.items`, and `outputs.items`, plus evidence references. Tool-call argument bodies are omitted. No reasoning is synthesized. Messages are surface text, with thinking blocks omitted. Creation/deletion records may have no patch; their reason is explicit.

## Start at the edit and include the intent in one request

```json
{
  "find": "changes",
  "scope": {"workspaceRoot": "C:/projects/app"},
  "where": {"path": "src/auth.ts", "tool.isError": true},
  "select": ["path", "operation", "patch", "attribution"],
  "include": {
    "request": {"select": ["content"]},
    "outputs": {"select": ["toolName", "isError", "content"]}
  }
}
```

This selects file changes correlated with an error result and brings their recorded input and output along. Remove `tool.isError` to inspect all outcomes. Include `tools:{"select":["toolName","data"]}` when arguments become relevant.

## Query all captures of a logical session

```json
{
  "find": "requests",
  "scope": {"sessionIds": ["PI-SESSION-ID"]},
  "where": {"text": {"contains": "authentication"}},
  "select": ["content"],
  "include": {"changes": {"select": ["path", "patch"], "limit": 20}}
}
```

Summary text filtering is case-insensitive with `contains`. A resumed session may have multiple captures. Native history copied on resume may overlap; file observations belong to the individual capture period.

For new queries, retain `readVersion` to keep an investigation consistent. Root `nextCursor` retains it automatically. Relation `nextQuery` can be submitted directly. Body truncation returns an `inspect` request; follow its section offsets for more. `maxChars` bounds body text, not the entire JSON envelope.

## Discover captures

```json
{"op":"sessions","limit":10}
```

This is a live inventory. Continue with its `nextCursor`.

## Open one patch

```json
{"op":"inspect","captureId":"CAPTURE","id":"CHANGE_RECORD","sections":["patch"],"maxChars":4000,"readVersion":180}
```

Use an actual returned `readVersion`. If `nextOffset` is present, repeat with
`contentOffset` set to that number. Fragments may split JSON or diff hunks.

## Join a change to its tool and native evidence

```json
{"find":"changes","captureId":"CAPTURE","where":{"path":"src/auth.ts"},"include":{"tools":{"select":["toolName","data"],"include":{"source":{"select":["data"]}}},"outputs":{"select":["content","isError"]}}}
```

Native evidence can arrive later than hooks. A nested tool may have no native
message; empty source results do not prove it never ran.

## Failures and side effects

```json
{"preset":"failures","captureId":"CAPTURE"}
```

A successful tool can also introduce a bug. Failure filtering is one entry point.

## Conversation content without metadata

```json
{"preset":"timeline","scope":{"sessionIds":["PI-SESSION-ID"]},"clean":true,"limit":100,"maxChars":32000}
```

Returns ordered `{user}`, `{assistant}` and `{tool,input,output}` objects.
It refuses oversized results; narrow scope/filters or raise limits. Use normal
views for patches, attribution, coverage and continuation.

## Coverage gaps at a fixed boundary

```json
{"find":"events","captureId":"CAPTURE","where":{"type":"gap"},"readVersion":180}
```

Use a returned revision to freeze evidence. Capture lifecycle status remains live.
Per-capture `lastSeq` is descriptive, not an alternative read boundary.
`where.text` searches summaries only; inspect bodies for deeper analysis.

## Things queries must not imply

- An operation's occurrence does not prove it caused all contemporaneous changes.
- A test after an edit does not prove it tested an immutable candidate.
- Historical transcript records are not historical filesystem snapshots.
- An intent excerpt does not capture every reason behind an action.
- A hierarchy is a navigation view; explicit tool IDs and source references carry the relationships.
