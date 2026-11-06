# Design notes

Earlier design decisions, agreed on 2026-10-19. They are not descriptions of what's built: for that, see the [usage guide](../usage.md) and [architecture](../architecture.md).

[Storage](../architecture.md) and the [ledger vocabulary](../vocabulary.md) supersede the earlier JSONL-only storage proposal. The future agent-review architecture below remains a separate, unimplemented stage.

- [Future agent architecture](agent-review-architecture.md): runtime-owned workspaces and evidence, OpenRig-style coordination, fixed review candidates.
- [One Pi session: storage](single-pi-storage.md): the current learning scope and a minimal data layout.
- [Handoff and share](handoff-and-share.md): continue work in another session or harness, and send a session to a teammate to read or clone. Draft, 2026-11-06.
