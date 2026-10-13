# Annotated resources

Research checked: 2026-10-13.

Use this file as a syllabus, not a requirement to consume everything before writing code. Required resources are scheduled in the day files. Optional resources deepen the concepts after the vertical slice works.

## Source hierarchy

When sources disagree, use this order:

1. The installed `pi --help`, installed docs, and installed TypeScript declarations.
2. Pi's source code at the exact installed version/tag.
3. Current official Pi documentation on `main`.
4. OpenRig's adapter code for how this checkout integrates Pi.
5. Third-party articles and examples.

Record the version or commit you studied. Pi's protocol evolves.

## Pi: required primary sources

### [Pi RPC mode](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md)

Read fully on Day 1. It defines the subprocess boundary, command/response correlation, strict LF framing, backpressure requirements, lifecycle behavior, `get_state`, and error records.

Questions to answer:

- Which records carry request IDs?
- What does prompt acceptance mean?
- When is a run truly settled?
- What belongs on stdout versus stderr?

### [Pi JSON event stream](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/json.md)

Read fully on Day 1. This is the canonical event-shape reference shared by JSON and RPC modes. Pay special attention to final versus streaming message records, tool events, retries, compaction, and `agent_settled`.

### [Pi session file format](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/session-format.md)

Read fully across Days 1 and 2. This explains the JSONL entry tree, `id`/`parentId`, branching, compaction, context edits, system-message checkpoints, and how Pi rebuilds model-visible context.

Core lesson: stored session lineage and effective model context are related but not identical to the live execution stream.

### [Pi SDK](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md)

Skim on Day 1. It explains Pi's in-process alternative and `SessionManager`. Wisdom starts with RPC because OpenRig already uses the isolated subprocess boundary, but you should understand the tradeoff.

### [Pi coding-agent source](https://github.com/earendil-works/pi/tree/main/packages/coding-agent/src)

Use when documentation is ambiguous. Find the exact RPC record definitions, JSON event serialization, and session manager behavior. Prefer source from the installed version tag.

## OpenRig: required local sources

Read after the standalone lab works:

- `private/openrig/packages/daemon/src/adapters/pi-runner.ts`
- `private/openrig/packages/daemon/src/adapters/pi-runner-protocol.ts`
- `private/openrig/packages/daemon/src/adapters/pi-runtime-adapter.ts`

Focus on `handlePiLine`, `handleUserBlock`, `sendRpc`, `get_state`, `get_entries`, `lastEntryId`, and the post-turn cursor refresh.

The code demonstrates an important product gap: OpenRig consumes structured events for operational behavior but currently reduces many of them to activity signals and terminal summaries instead of preserving one comprehensive provider-neutral execution ledger.

## Streaming and subprocesses

### [Node.js child process documentation](https://nodejs.org/api/child_process.html)

Required. Study `spawn`, argument arrays, environment handling, stdio pipes, `error`, `exit`, and `close`. Note the Windows-specific behavior and finite pipe capacity.

### [Node.js backpressure guide](https://nodejs.org/learn/modules/backpressuring-in-streams)

Required. A recorder that blocks or stops reading can stall the agent it is observing. Understand `write()` return values, `drain`, and bounded buffering.

### [Node.js stream documentation](https://nodejs.org/api/stream.html)

Reference. Use it when implementing your decoder and serialized journal writer.

### [Node.js StringDecoder](https://nodejs.org/api/string_decoder.html)

Reference. Understand why UTF-8 characters can span chunks. Even if you frame at the byte level, decoding must not corrupt split multibyte characters.

### [Node.js filesystem documentation](https://nodejs.org/api/fs.html)

Reference. Study append behavior, file handles, flushing, rename semantics, and the difference between a resolved write promise and guaranteed storage durability.

## Data formats and identity

### [RFC 8259: JSON](https://www.rfc-editor.org/rfc/rfc8259)

Required. Know what JSON strings may contain and why a Unicode line separator is not an LF record delimiter.

### [JSON Lines](https://jsonlines.org/)

Required short read. It is a convention rather than a complex wire protocol: UTF-8, one JSON value per line, and `\n` terminators.

### [RFC 3339: timestamps](https://www.rfc-editor.org/rfc/rfc3339)

Reference. Use a consistent UTC representation, but remember that timestamps do not establish causality.

### [RFC 9562: UUIDs](https://www.rfc-editor.org/rfc/rfc9562)

Optional. Read the UUIDv7 section if you want time-sortable Wisdom IDs. Do not substitute sortable identity for source ordering or causality.

### [Node.js crypto documentation](https://nodejs.org/api/crypto.html)

Reference for SHA-256 integrity hashes. Define exactly which bytes are hashed.

## Event sourcing, causality, and provenance

### Video: [Event Sourcing - Greg Young, GOTO 2014](https://www.youtube.com/watch?v=8JKjvY4etTY)

Required on Day 2. Focus on append-only history, replay, projections, and tradeoffs. Wisdom uses some event-sourcing ideas; it does not need to adopt every CQRS pattern.

### [Event Sourcing - Martin Fowler](https://martinfowler.com/eaaDev/EventSourcing.html)

Required short companion. Use it to distinguish events from current state and to understand rebuildable projections.

### Paper: [Time, Clocks, and the Ordering of Events in a Distributed System](https://lamport.azurewebsites.net/pubs/time-clocks.pdf)

Required sections 1 and 2. This is the foundation for "happened before." The immediate practical lesson is that chronological timestamps and causal order are different.

### Video/tutorial: [Leslie Lamport's distributed-systems tutorial](https://lamport.azurewebsites.net/video/intro.html)

Recommended if the paper feels abstract. Watch the material connected to the time/clocks paper.

### [OpenTelemetry specification overview](https://opentelemetry.io/docs/specs/otel/overview/)

Required skim. Spans, parent span IDs, links, events, resources, and propagated context provide a mature comparison for Wisdom's run/event/edge model.

Do not blindly copy OpenTelemetry. An agent execution ledger needs raw provider evidence, artifacts, context lineage, and coverage gaps beyond ordinary tracing.

### [OpenTelemetry Context](https://opentelemetry.io/docs/specs/otel/context/)

Optional deeper read. Useful later when causality crosses child processes or several agents.

### [W3C Trace Context](https://www.w3.org/TR/trace-context/)

Optional. It shows a standard way to propagate trace and parent identifiers across process/service boundaries.

### [W3C PROV Primer](https://www.w3.org/TR/prov-primer/)

Required skim. Learn the distinctions among entity, activity, and agent and the meanings of generation, use, attribution, and derivation.

### Book: Designing Data-Intensive Applications, Martin Kleppmann

Optional but highly recommended long-term. Read chapters 1, 5, 7, 8, and 11. The book develops reliability, logs, ordering, transactions, and stream-processing intuition needed for Wisdom beyond the three-day sprint.

## TypeScript modeling

### [TypeScript narrowing](https://www.typescriptlang.org/docs/handbook/2/narrowing.html)

Required if discriminated unions are unfamiliar. Provider records and normalized event variants should narrow through explicit `type`/`kind` fields.

### [TypeScript handbook](https://www.typescriptlang.org/docs/handbook/intro.html)

Reference for strict typing, unknown input, and module behavior. Parse external JSON as `unknown`, validate it, then narrow it.

### [Node.js TypeScript support](https://nodejs.org/api/typescript.html)

Reference. The learning lab can follow OpenRig's TypeScript toolchain rather than relying on experimental runtime stripping behavior.

## SQLite and durable projections

### [Transactions](https://www.sqlite.org/lang_transaction.html)

Required. One import should either commit completely or leave no partial normalized state.

### [Foreign keys](https://www.sqlite.org/foreignkeys.html)

Required. Enable them explicitly and test violations.

### [Isolation](https://www.sqlite.org/isolation.html)

Required skim. Understand what readers see while a writer imports records.

### [Write-Ahead Logging](https://www.sqlite.org/wal.html)

Required before enabling WAL. Learn the purpose of `-wal`/`-shm` files and checkpointing.

### [JSON functions](https://www.sqlite.org/json1.html)

Reference. Use JSON payloads for source-specific fields while keeping frequently queried identity and relationship fields relational.

### [WITH and recursive CTEs](https://www.sqlite.org/lang_with.html)

Required for causal ancestor/descendant and session-lineage traversal.

### [FTS5](https://www.sqlite.org/fts5.html)

Optional after the sprint. Do not let search distract from correct ingestion and provenance.

### [`better-sqlite3` API](https://github.com/WiseLibs/better-sqlite3/blob/master/docs/api.md)

Required implementation reference for prepared statements, transactions, pragmas, and database lifecycle.

## API and dashboard

### [RFC 9110: HTTP semantics](https://www.rfc-editor.org/rfc/rfc9110)

Required sections as needed for methods, status codes, representation metadata, and caching.

### [RFC 9457: Problem Details](https://www.rfc-editor.org/rfc/rfc9457)

Required short read. Use one stable machine-readable error representation.

### [Hono documentation](https://hono.dev/docs/)

Required implementation reference. Start with routing, context, validation, and Node serving.

### [Hono testing](https://hono.dev/docs/guides/testing)

Required. Test the application in process without binding a public port.

### [WHATWG URL Standard](https://url.spec.whatwg.org/)

Reference for query parsing and encoding.

### [OWASP API Security Top 10](https://owasp.org/API-Security/)

Recommended skim. Even a localhost service can expose sensitive prompts, paths, code, and command output if bound or routed incorrectly.

## Testing

### [Vitest guide](https://vitest.dev/guide/)

Required implementation reference. Favor deterministic fixtures and fake Pi subprocesses for most tests.

### [Property-based testing with fast-check](https://fast-check.dev/)

Optional. Particularly useful for randomized stream chunk boundaries, malformed record sequences, and idempotency properties. Add it only if time permits; a deterministic randomized loop is acceptable for the sprint.

## What not to study during these three days

Defer these until the Pi vertical slice is trustworthy:

- vector databases and embeddings;
- knowledge graphs as a product category;
- CRDT implementation;
- consensus protocols such as Raft;
- Kafka deployment;
- graph databases;
- multi-agent planning algorithms;
- prompt-compression research;
- polished frontend architecture.

They may become relevant later, but none is required to prove raw preservation, causal modeling, idempotent normalization, or progressive retrieval for one Pi session.
