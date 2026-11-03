# Current design notes

These notes capture the direction agreed on 2026-10-19. They are design decisions, not claims of implemented functionality. For the subjects below, use these notes ahead of the older day-by-day learning plans.

Implementation update, 2026-10-20: the project-root [README](../README.md) now documents the first live recorder, daemon, CLI, and read-only MCP query interface. It distinguishes the shipped scope from the future decisions below.

Storage/query update, 2026-10-20: [SQLite storage](../docs/STORAGE.md) and the [ledger vocabulary](../docs/NOMENCLATURE.md) supersede the earlier JSONL-only storage proposal. SQLite owns Wisdom metadata; Pi's native JSONL and payload files remain evidence. Agents read a session through two moves, glance and open (updated 2026-10-25; see [docs/POLICY.md](../docs/POLICY.md)). The future agent-review architecture below remains a separate, unimplemented stage.

- [Future agent architecture](agent-review-architecture.md): runtime-owned workspaces and evidence, OpenRig-style coordination, fixed review candidates.
- [One Pi session: storage](single-pi-storage.md): the current learning scope and a minimal data layout.
