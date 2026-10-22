# Query shapes

Replace example scopes/paths with the requested project. Send these objects to
`ledger_query`, or save JSON to a file and pass it to the Wisdom CLI. These are
literal structured queries; no natural-language translation service is involved.

Read the conversation and edits together without loading call arguments:

```json
{
  "preset": "interaction-review",
  "scope": {"workspaceRoot": "C:/projects/app"},
  "limit": 5,
  "maxChars": 12000
}
```

Find relevant edit evidence and its recorded intent/output in one request:

```json
{
  "find": "changes",
  "scope": {"workspaceRoot": "C:/projects/app"},
  "where": {"path": "src/auth.ts", "tool.isError": true},
  "select": ["path", "operation", "patch", "attribution", "activeToolCallIds"],
  "include": {
    "request": {"select": ["content"]},
    "outputs": {"select": ["toolName", "isError", "content"]}
  }
}
```

Remove `tool.isError` when investigating a bug introduced by an apparently
successful tool. Root filters do not filter the evidence returned by includes.
Add `tools:{"select":["toolName","data","status"]}` to `include` only when raw
call arguments are relevant. `content` on requests/messages is surface text;
`data` is raw evidence and can contain thinking blocks and arguments.

Find requests by a phrase and include their changes:

```json
{
  "find": "requests",
  "scope": {"sessionIds": ["PI-SESSION-ID"]},
  "where": {"text": {"contains": "authentication"}},
  "select": ["content"],
  "include": {"changes": {"select": ["path", "patch", "attribution"], "limit": 20}}
}
```

`where.text` searches summaries only. Select `data` or inspect a chosen record
for full-body analysis; there is no full-body search operation.

```json
{"op":"inspect","captureId":"CAPTURE","id":"RECORD","sections":["data"],"readVersion":180}
```

Use a returned revision, not the illustrative number above. For content only:

```json
{"preset":"timeline","captureId":"CAPTURE","clean":true,"limit":100,"maxChars":32000}
```

Clean mode has no continuation or provenance metadata. Narrow the query if it
exceeds its limits; use normal views for evidence relationships and patches.

Responses have root `items`, `readVersion`, `nextCursor`, `coverage`, and `issues`.
Relations have `items`, `truncated`, and `nextQuery`; submit `nextQuery` directly.
Bodies have `available`, `text`, `totalChars`, `truncated`, and, if needed, `inspect`.
Surface-content inspection returns the underlying raw record from offset zero.
Further body pages use `contentOffset` from `sections.data.nextOffset` (or patch).
When an expansion-budget continuation says it restarts a relation, deduplicate
records by `id`. Keep the scope and filters unchanged when reusing root cursors.

For coverage gaps, query `find=events` with `where.type="gap"` at the same scope
and `readVersion`. `currentStatus` is live lifecycle metadata; all selected
evidence is fixed at the returned version. Older native history may lack hook
request links, so an empty interaction review does not prove no earlier work exists.
