# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Wisdom records a running Pi session (Pi extension -> local daemon -> SQLite) and makes the evidence queryable via CLI and one read-only MCP tool (`ledger_query`). It does not orchestrate agents or generate model-written summaries. [README.md](README.md) is detailed and accurate about behavior and limits; the `notes/` folder describes *future* review architecture, not what is implemented.

## Commands

Node >= 24 required. On Windows PowerShell use `npm.cmd` if script execution is restricted.

```powershell
npm.cmd ci --legacy-peer-deps
npm.cmd run build          # tsc -> dist/ (tests run from dist, so always build first)
npm.cmd run check          # type-check only
npm.cmd test               # build + node --test dist/test/*.test.js
npm.cmd run test:pi        # build + Pi integration (needs installed Pi; WISDOM_PI_ENTRY overrides)
npm.cmd run wisdom -- daemon start|status|stop|run
npm.cmd run wisdom -- track --cwd <project>   # launch tracked Pi
```

Run a single test file (after building): `node --test dist/test/query.test.js`. Filter by name: add `--test-name-pattern="<regex>"`.

There is no linter configured. Compiled output lives in `dist/` (tests import from there, not `src/`), so stale `dist/` can mask source changes.

## Architecture (read across files)

- **Pi extension** ([src/pi-extension.ts](src/pi-extension.ts)) reports events over loopback HTTP and *blocks* a tool until its start observation is accepted. If before-tool recording fails, the tool is blocked by design.
- **Daemon** ([src/daemon.ts](src/daemon.ts)) is a thin HTTP boundary on `127.0.0.1:7434`; PID and token are in `.wisdom/daemon.json`, which the CLI/MCP read instead of hard-coding the port. [src/captures.ts](src/captures.ts) coordinates capture lifecycle and ties file changes to tool operations; [src/workspace.ts](src/workspace.ts) observes files and generates diffs.
- **Storage**: SQLite ([src/database.ts](src/database.ts), [src/ledger.ts](src/ledger.ts)) holds authoritative metadata; payloads (sha256-addressed) and byte-preserved native Pi JSONL live under `.wisdom/sessions/<capture-id>/`. Historical Wisdom manifests and event/change JSONL are ignored and left untouched; no importer remains. See [docs/STORAGE.md](docs/STORAGE.md).
- **Query layers**: [src/schema.ts](src/schema.ts) (record/query vocabulary, zod) -> [src/vocabulary.ts](src/vocabulary.ts), [src/selection.ts](src/selection.ts), [src/composable-query.ts](src/composable-query.ts) (parameterized SQL, `find/where/select/include`, presets) ; [src/query.ts](src/query.ts) dispatches strict selection, inventory and inspection operations; [src/evidence.ts](src/evidence.ts) reads bodies; [src/clean-query.ts](src/clean-query.ts) selects and formats `{user}/{assistant}/{tool}` arrays inside the daemon. CLI ([src/cli.ts](src/cli.ts)), HTTP client ([src/client.ts](src/client.ts)) and MCP ([src/mcp.ts](src/mcp.ts)) all share the same request schema and engine.
- Each Pi startup/resume/reload creates a new **capture ID**; Pi's session ID is stored separately and can span captures.

## Gotchas

- MCP must be launched with `node dist/src/cli.js mcp`, not `npm run`, because npm's banner corrupts stdout.
- Changes during a tool are labeled `observed-during-tool` (temporal, not proof of authorship); idle ones `external-or-unknown`. Preserve this honesty when touching attribution.
- `.wisdom/`, `dist/`, `.npm-cache/` are excluded from observation; `.wisdomignore` takes plain relative paths/prefixes only (no globs/negation).
- Native transcripts/payloads are stored unredacted; never commit `.wisdom/`.
- Vocabulary names are documented in [docs/NOMENCLATURE.md](docs/NOMENCLATURE.md); query examples in [docs/QUERY-EXAMPLES.md](docs/QUERY-EXAMPLES.md). The agent-facing skill is [skills/wisdom-ledger/SKILL.md](skills/wisdom-ledger/SKILL.md).
