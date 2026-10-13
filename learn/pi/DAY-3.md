# Day 3: expose and inspect the ledger

## Goal

By the end of Day 3, the same SQLite ledger powers a read-only API and a minimal post-session dashboard. A consumer can begin with a small run summary and progressively request evidence, causal neighbors, raw records, artifacts, or gaps.

Time budget: approximately 10 hours of focused work.

## Mental model

The API and dashboard are projections. They do not own session truth.

```text
raw evidence -> normalized ledger -> read model -> API/dashboard/export
```

If the dashboard needs a field, add it to a documented read model or query. Do not create hidden UI-only state that changes the meaning of the ledger.

## Block 1 - Learn read models and progressive disclosure (60 minutes)

### Concepts

- A write model protects integrity; a read model serves a consumer efficiently.
- Progressive disclosure begins with identity, status, coverage, and links, then lets the consumer fetch detail.
- Pagination and stable ordering are correctness concerns, not merely performance features.
- A handoff is a selection/projection over the ledger, not a replacement for it.
- A summary is derived and disposable. Evidence links remain authoritative.

### Exercise

Design three views of the same run:

1. **Run card:** ID, runtime, start/end, status, event count, error count, gap count.
2. **Timeline item:** event identity, kind, time/order, actor, short display payload, evidence link.
3. **Evidence detail:** normalized event, raw source record, edges, artifacts, derivation rule, gaps.

Write down which consumer needs each view and which fields should not appear in the smallest view.

## Block 2 - Learn the HTTP contract (75 minutes)

### Read

- [HTTP semantics, RFC 9110](https://www.rfc-editor.org/rfc/rfc9110)
- [Problem Details for HTTP APIs, RFC 9457](https://www.rfc-editor.org/rfc/rfc9457)
- [Hono documentation](https://hono.dev/docs/)
- [Hono validation guidance](https://hono.dev/docs/guides/validation)
- [URL standard](https://url.spec.whatwg.org/), focusing on query parameters and encoding

### Design principles

- Use nouns for resources.
- Keep the first API read-only.
- Return stable IDs and links.
- Distinguish `404` from an empty result.
- Validate path and query parameters.
- Use one documented error shape.
- Paginate event collections with a stable cursor based on capture/order identity, not an unstable array offset.
- Never expose an arbitrary local path supplied by the caller.
- Raw endpoints should retrieve only registered source records.
- Default to bounded response sizes.

### Initial endpoint contract

Implement:

```text
GET /api/health
GET /api/runs
GET /api/runs/:runId
GET /api/runs/:runId/events
GET /api/runs/:runId/gaps
GET /api/events/:eventId
GET /api/events/:eventId/causes
GET /api/events/:eventId/effects
GET /api/events/:eventId/raw
GET /api/sessions/:sessionId/lineage
GET /api/runs/:runId/handoff
```

Suggested query parameters:

```text
kind=<event kind>
after=<opaque cursor>
limit=<bounded integer>
includePayload=false|true
edgeType=<edge kind>
```

Do not create a generic SQL endpoint.

## Block 3 - Define response contracts (60 minutes)

Write TypeScript response types before handlers.

### Run summary

Include:

- Wisdom run/session IDs;
- provider/runtime and observed version;
- start/end/status;
- counts by important event class;
- capture completeness state;
- number of coverage gaps;
- links to events, gaps, and handoff projection.

### Event detail

Include:

- normalized event;
- provenance/source-record identity;
- derivation rule and confidence where applicable;
- incoming/outgoing edges grouped by type;
- linked artifacts;
- relevant coverage gaps;
- raw-record URL rather than always embedding raw content.

### Error shape

Use `application/problem+json` fields from RFC 9457:

```text
type
title
status
detail
instance
```

Do not leak stack traces or database paths.

### Handoff projection

The first handoff response is not an LLM prompt. It is a compact manifest containing:

- run and session identity;
- original user request when observed;
- latest settled status;
- changed/linked artifacts when known;
- failed and passing verification events when known;
- unresolved gaps;
- IDs/URLs for requesting full evidence.

Every statement in the handoff must point to source event IDs. Do not generate an uncited narrative summary during this sprint.

## Block 4 - Implement the API (2 hours)

Suggested modules:

```text
src/api/
  app.ts
  errors.ts
  pagination.ts
  serializers.ts
  routes/
    runs.ts
    events.ts
    sessions.ts
```

### Requirements

- Inject repositories into the API rather than opening global database connections in handlers.
- Make list limits explicit and capped.
- Produce deterministic event order.
- Keep raw payload inclusion opt-in.
- Set local-only binding by default.
- Return a schema/API version header or top-level field.
- Close the database and HTTP server cleanly.

### Security check

Even for localhost:

- Bind to `127.0.0.1`, not all interfaces, unless explicitly configured.
- Do not serve the complete `data/` directory statically.
- Do not accept a filesystem path and read it.
- Escape displayed text in the browser.
- Avoid putting raw prompts or paths into server logs.
- Mark sensitive fields so future sharing policies can filter them.

## Block 5 - Build a minimal dashboard (2 hours)

Use plain HTML, CSS, and browser JavaScript. The purpose is to test the data model, not select a frontend framework.

### Screen 1: run list

Show:

- runtime;
- start time and duration;
- status;
- event/tool/error/gap counts;
- completeness warning.

### Screen 2: run timeline

Show ordered items for:

- user and assistant messages;
- tool start/completion;
- errors and retries;
- compaction;
- process lifecycle.

Provide filters by event kind. Preserve capture order even when provider timestamps are missing or contradictory.

### Screen 3: event inspector

Show:

- normalized fields;
- raw source record on demand;
- causes and effects;
- correlations and lineage separately;
- artifacts;
- confidence/derivation rule;
- coverage gaps.

Do not draw a large force-directed graph. A list of typed incoming and outgoing edges will teach you more and be easier to verify.

## Block 6 - Validate with a controlled scenario (90 minutes)

Run the Day 1 demonstration again, then import both the raw journal and Pi session file.

Use the product to answer:

1. What was Pi asked to do?
2. When did the accepted run actually settle?
3. Which tool call failed?
4. Which event contains its authoritative final result?
5. Which file or artifact is linked to the work?
6. Which verification passed?
7. Which links are observed, which are derived, and which are unknown?
8. What model-visible context lineage does Pi's session tree show?
9. Does the handoff manifest cite evidence for every claim?

If an answer comes only from reading the raw JSON manually, decide whether the normalizer lacks a useful stable concept or whether the raw-only detail should remain provider-specific.

## Block 7 - Study OpenRig's integration seam (60 minutes)

Only after the standalone demonstration passes, compare it with:

```text
private/openrig/packages/daemon/src/adapters/pi-runner.ts
private/openrig/packages/daemon/src/adapters/pi-runner-protocol.ts
private/openrig/packages/daemon/src/adapters/pi-runtime-adapter.ts
```

Observe that OpenRig already:

- launches Pi with `--mode rpc`;
- receives each structured Pi stdout line;
- sends user `prompt`, `steer`, `follow_up`, and `abort` commands;
- calls `get_state` for session identity;
- calls `get_entries` and carries `lastEntryId` for durable catch-up;
- maps selected live events into pane summaries and activity state.

Write an integration proposal, but do not patch the runner during this sprint. Identify:

- the exact capture hook before records are reduced to pane summaries;
- how journal-write failure would be surfaced;
- how to avoid blocking Pi stdout consumption;
- how `lastEntryId` can support recovery without pretending live events and session entries are identical;
- which tests must prove launch/resume behavior remains unchanged.

## Required tests

- Run list is bounded and deterministically ordered.
- Cursor pagination returns every event exactly once across pages.
- Unknown run/event IDs return `404` problem details.
- Invalid limits and cursors return `400` problem details.
- Raw record retrieval cannot read arbitrary filesystem paths.
- Event detail separates causal, correlation, and lineage relationships.
- Handoff claims cite valid event IDs.
- Raw payload is excluded by default where specified.
- HTML escapes message/tool content.
- API tests use fixtures and spend no model credits.
- End-to-end test imports fixtures, starts the API, and queries the expected causal chain.

## Final architecture review

Create a short `DESIGN-REVIEW.md` inside the lab answering:

1. What is authoritative?
2. What is derived and rebuildable?
3. What can be queried but not safely claimed as causal?
4. How is incomplete capture represented?
5. How does the design evolve when Codex is added?
6. Which Pi-specific assumptions leaked into the canonical schema?
7. What would break if Pi changed its event format tomorrow?
8. What is the narrowest safe OpenRig integration point?

## Pass condition

You pass Day 3 when a new consumer can discover a run, inspect its progression and evidence through the API, and construct a bounded handoff without understanding Pi's files or trusting an uncited summary.

The dashboard being attractive is not a pass condition. The records being truthful and navigable is.
