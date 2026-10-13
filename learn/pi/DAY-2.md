# Day 2: normalize records into a causal ledger

## Goal

By the end of Day 2, raw Pi records can be imported repeatedly into SQLite without duplication. The database separates chronological order, protocol correlation, session lineage, and supported causal relationships.

Time budget: approximately 10 hours of focused work.

## The four relationships you must not confuse

### 1. Capture order

Record A reached the collector before record B. This is recorder-local order, represented by `captureSequence`.

It does not automatically mean A caused B.

### 2. Protocol correlation

A response repeats a command ID, or a tool result repeats a tool-call ID. This establishes that two records belong to the same protocol interaction.

Correlation is stronger than timestamp proximity but is not always a causal claim.

### 3. Session lineage

A Pi session entry points to `parentId`, or a session header points to a parent session. This describes the branch/path used to reconstruct session context.

Lineage is not identical to execution causality. A prior message can be an ancestor in the active context without directly causing every later action.

### 4. Causality

The source contract or a deterministic rule establishes that one event produced, triggered, retried, superseded, or verified another event.

Your schema must preserve the first three without mislabeling them as the fourth.

## Block 1 - Learn event logs and projections (75 minutes)

### Read/watch

- Watch [Event Sourcing by Greg Young, GOTO 2014](https://www.youtube.com/watch?v=8JKjvY4etTY).
- Read [Event Sourcing by Martin Fowler](https://martinfowler.com/eaaDev/EventSourcing.html).
- Re-read the Pi [session context-building section](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/session-format.md#context-building).

### Learn

- An append-only event history and a current-state projection are different products.
- A projection should be rebuildable from its authoritative inputs.
- Schema versioning is required because old events outlive current code.
- Replaying events is not the same as rerunning side effects.
- Wisdom's raw journal is evidence; the normalized database is a query model derived from evidence.

Do not call the normalized database the only source of truth. A normalizer will be wrong eventually; the raw archive lets you rebuild it.

### Exercise

On paper, derive three projections from the same five-event sequence:

- a chronological timeline;
- current run status;
- tool-call failure count.

Then change the projection rule without changing the events. This is the mental model for future migrations.

## Block 2 - Learn causal order (90 minutes)

### Read/watch

- Read at least sections 1 and 2 of Leslie Lamport's [Time, Clocks, and the Ordering of Events in a Distributed System](https://lamport.azurewebsites.net/pubs/time-clocks.pdf).
- Use Lamport's [video/tutorial index](https://lamport.azurewebsites.net/video/intro.html) if the paper is unfamiliar.
- Read the [OpenTelemetry overview of spans, parent IDs, events, and links](https://opentelemetry.io/docs/specs/otel/overview/).
- Skim the [W3C PROV primer](https://www.w3.org/TR/prov-primer/) for entities, activities, agents, generation, and derivation.

### Learn

- Wall-clock time does not prove causality.
- "Happened before" is a partial order, not necessarily one total sequence.
- Two records may be concurrent or unrelated even if their timestamps differ.
- Parent/child is appropriate for one dominant causal chain; links/edges are needed for multiple dependencies.
- Provenance asks where a fact or artifact came from and which activity generated it.

For this local single-process MVP, you do not need to implement Lamport or vector clocks. You do need to stop treating timestamps as proof.

### Exercise

Classify each statement as observed, derived, inferred, or unknown:

1. A response has the same request ID as a command.
2. A tool result has the same `toolCallId` as a tool call.
3. A file changed between two filesystem snapshots taken around a tool event.
4. A bash tool changed the file because it occurred one millisecond earlier.
5. A passing test verifies the exact user requirement.
6. One Pi session entry has another entry's ID in `parentId`.

Expected lesson: statements 4 and 5 require evidence you probably do not possess.

## Block 3 - Design the canonical vocabulary (75 minutes)

Keep the first schema deliberately small.

### Core records

```text
source_records   Immutable index of every raw envelope.
sessions         Provider conversation/session identity.
runs             One accepted unit of agent work.
actors           User, agent, tool, process, or system identity.
events           Normalized occurrences.
event_edges      Typed relationships between events.
artifacts        Files, session files, command output blobs, or Git states.
event_artifacts  Typed event-to-artifact relationships.
coverage_gaps    Known missing or ambiguous observations.
```

### Event envelope

Design a versioned TypeScript discriminated union. Common fields should include:

```ts
interface EventBase {
  schemaVersion: 1;
  eventId: string;
  sourceRecordId: string;
  sessionId?: string;
  runId?: string;
  actorId?: string;
  kind: string;
  occurredAt?: string;
  observedAt: string;
  captureSequence: number;
  payload: unknown;
}
```

Start with these kinds:

```text
run.started
run.completed
run.settled
turn.started
turn.completed
message.started
message.updated
message.completed
tool.started
tool.updated
tool.completed
retry.started
retry.completed
compaction.started
compaction.completed
session.entry
process.started
process.stderr
process.exited
```

Do not create a different event kind for every Pi field. Put provider-specific fields in the payload and preserve the raw link.

### Edge vocabulary

Use explicit types, for example:

```text
correlates_with    Shared stable protocol identifier.
lineage_parent     Pi session tree parent.
caused_by          Source or deterministic protocol rule establishes causation.
produced           Activity generated an output/artifact.
retried            New attempt retries an earlier attempt.
superseded         Later record replaces earlier model-visible context.
verified_by        Only when verification scope is explicit.
```

Store edge confidence and derivation rule. Keep causal edges acyclic. Non-causal links such as correlation may form a general graph and should not be forced into the causal DAG.

### Coverage gaps

A gap should say:

- what relationship or record is missing;
- which source/run it affects;
- why it is missing;
- whether recovery might be possible;
- which adapter/version observed the gap.

Example: a live event lacks a durable session-entry ID, so it cannot yet be linked to a persisted entry.

## Block 4 - Learn SQLite durability and constraints (90 minutes)

### Read

- [SQLite transactions](https://www.sqlite.org/lang_transaction.html)
- [SQLite foreign keys](https://www.sqlite.org/foreignkeys.html)
- [SQLite Write-Ahead Logging](https://www.sqlite.org/wal.html)
- [SQLite isolation](https://www.sqlite.org/isolation.html)
- [SQLite JSON functions](https://www.sqlite.org/json1.html)
- [SQLite FTS5](https://www.sqlite.org/fts5.html), optional for this sprint
- [`better-sqlite3` documentation](https://github.com/WiseLibs/better-sqlite3/blob/master/docs/api.md)

### Decisions to make

- Enable foreign keys explicitly.
- Choose WAL only after understanding its files and checkpoint behavior.
- Wrap one source import in a transaction.
- Use relational columns for fields you filter or join frequently.
- Use JSON for provider payloads, not as an excuse to avoid a schema.
- Put a unique constraint on source identity.
- Store timestamps as normalized text plus capture sequence; do not rely on timestamps for stable ordering.
- Keep database migrations versioned.

### Recommended uniqueness rule

Define a deterministic source key from stable provenance, for example:

```text
runtime + surface + source locator + source record identity/offset + raw hash
```

The precise formula is your decision. It must make importing the same bytes twice a no-op while allowing two genuinely repeated provider events to remain separate if they occurred at different source positions.

## Block 5 - Implement schema and importer (3 hours)

Add modules such as:

```text
src/ledger/
  database.ts
  migrations.ts
  schema.ts
  source-repository.ts
  event-repository.ts
  edge-repository.ts
  gap-repository.ts
src/pi/
  normalize-live-record.ts
  normalize-session-entry.ts
  import-journal.ts
  import-session.ts
```

### Ingestion stages

Implement these as visible stages, even if they initially run in one process:

```text
read raw envelope
  -> validate envelope version
  -> register source record idempotently
  -> classify Pi record
  -> emit zero or more normalized events
  -> resolve stable correlations
  -> create supported edges
  -> record unresolved gaps
  -> commit transaction
```

### Normalization rules

Every rule should have a stable name such as:

```text
pi.rpc.command-response.v1
pi.tool-call-id.v1
pi.session-parent.v1
pi.capture-order.v1
```

Store the rule name on derived edges. This lets a future migration explain why an edge exists and rebuild it when a rule changes.

### Identity guidance

- Preserve Pi IDs in namespaced source-ID columns.
- Generate Wisdom IDs independently.
- Do not assume Pi event IDs, entry IDs, tool-call IDs, request IDs, session IDs, and run IDs share one namespace.
- A stable ID should survive reimport.
- A random ID created on every import will break idempotency unless mapped through a stable source key.

## Block 6 - Build graph queries (60 minutes)

Implement queries for:

- ordered events in a run;
- raw source record for an event;
- immediate incoming and outgoing edges;
- recursive ancestors through causal edges;
- recursive descendants through causal edges;
- all records correlated by one tool-call ID;
- unresolved coverage gaps;
- session-entry lineage separate from causal ancestry.

Use recursive common-table expressions for ancestry. Add cycle protection and a depth limit even though causal-edge insertion should reject cycles.

## Required tests

- Importing the same journal twice creates no duplicates.
- Two identical payloads at different source positions remain two source records.
- A transaction failure leaves no half-imported source.
- Unknown event types remain accessible through raw records and create no crash.
- Unknown fields survive inside provider payloads.
- Command/response IDs correlate correctly.
- Tool calls/results correlate correctly.
- Session `parentId` creates lineage, not an automatic `caused_by` edge.
- Out-of-order timestamps do not change capture order.
- Missing identifiers create a coverage gap.
- Causal cycle insertion fails.
- Schema migration from an empty database succeeds repeatedly.
- Rebuilding the normalized database from raw fixtures produces the same logical result.

## Day 2 exit review

Explain these in your own words:

1. Why is the normalized ledger a projection rather than the only source of truth?
2. Why is Pi's `parentId` useful but insufficient for Wisdom's causality?
3. What evidence permits a `caused_by` edge?
4. Why are coverage gaps data rather than log messages?
5. How does your uniqueness rule avoid both duplicate imports and accidental event collapse?
6. Which parts of the graph can be rebuilt after a normalizer bug is fixed?

### Pass condition

You pass Day 2 when you can delete the SQLite database, rebuild it deterministically from raw fixtures, and obtain the same runs, events, links, and gaps without touching the original Pi records.
