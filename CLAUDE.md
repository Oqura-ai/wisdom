# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Wisdom records a running coding-agent session (Pi, Claude Code, or Codex, via per-harness adapters -> local daemon -> SQLite) and lets agents read it through one read-only MCP tool (`ledger`) or the CLI, with two moves: `glance` and `open`. It does not orchestrate agents or generate model-written summaries. [README.md](README.md) is detailed and accurate about behavior and limits; the `notes/` folder describes *future* review architecture, not what is implemented.

## Commands

Node >= 24 required. On Windows PowerShell use `npm.cmd` if script execution is restricted.

```powershell
npm.cmd ci --legacy-peer-deps
npm.cmd run build          # tsc -> dist/ (tests run from dist, so always build first)
npm.cmd run check          # type-check only
npm.cmd test               # build + node --test dist/test/*.test.js
npm.cmd run test:pi        # build + Pi integration (needs installed Pi; WISDOM_PI_ENTRY overrides)
npm.cmd run test:codex     # installed CLI hook discovery/trust check; no model calls
npm.cmd run wisdom -- daemon start|status|stop|run
npm.cmd run wisdom -- track pi|claude|codex --cwd <project>   # launch a tracked harness
npm.cmd run wisdom -- resume <full-session-id>                 # continue a recorded session, recording
npm.cmd run wisdom -- glance latest; npm.cmd run wisdom -- open t3 --capture latest   # read a session
npm.cmd run dashboard:install; npm.cmd run dashboard:build    # live viewer, served by the daemon on port+1
```

Run a single test file (after building): `node --test dist/test/ledger.test.js`. Filter by name: add `--test-name-pattern="<regex>"`.

There is no linter configured. Compiled output lives in `dist/` (tests import from there, not `src/`), so stale `dist/` can mask source changes.

## Architecture (read across files)

- **Harness adapters** ([src/harnesses/](src/harnesses/)): no harness is central. Each implements [types.ts](src/harnesses/types.ts) (tool targets, direct file tools, native transcript reading) and owns its launcher. The core reaches harnesses only through [harnesses/index.ts](src/harnesses/index.ts). Pi uses an in-process extension; Claude Code uses hooks from [integrations/claude-code/](integrations/claude-code/), loaded per process via `--plugin-dir`. Both *block* a tool until its start observation is accepted (fail closed). Claude Code's transcript format is internal, so its hooks are the primary evidence.
- **Daemon** ([src/daemon.ts](src/daemon.ts)) is a thin HTTP boundary on `127.0.0.1:7434`; PID and token are in `.wisdom/daemon.json`, which the CLI/MCP read instead of hard-coding the port. [src/captures.ts](src/captures.ts) coordinates capture lifecycle and ties file changes to tool operations; [src/workspace.ts](src/workspace.ts) observes files and generates diffs.
- **Storage**: SQLite ([src/database.ts](src/database.ts), [src/ledger.ts](src/ledger.ts)) holds authoritative metadata; payloads (sha256-addressed) and byte-preserved native harness JSONL live under `.wisdom/harnesses/<harness>/<capture-id>/`. Historical Wisdom manifests and event/change JSONL are ignored and left untouched; no importer remains. See [docs/STORAGE.md](docs/STORAGE.md).
- **Read layers**: [src/discovery.ts](src/discovery.ts) is the agent-facing ledger (`POST /ledger`): positions (`t3`, `t3/c2`, `a1`, `outside`), `glance` and `open`, plain-text replies, one size ceiling (80,000 chars) with an exact `continue` request, every read pinned to a version. [src/conversation.ts](src/conversation.ts) assembles one turn in recorded order and is shared with the dashboard, whose reads are [src/views.ts](src/views.ts) (`POST /view`) and [src/stats.ts](src/stats.ts). Each harness adapter declares how its tools are shown (`toolView`: `patch`/`file`/`full`). CLI ([src/cli.ts](src/cli.ts)) and MCP ([src/mcp.ts](src/mcp.ts)) return the ledger text unchanged. Changes to this layer follow [docs/POLICY.md](docs/POLICY.md).
- One harness session is one capture, keyed by the harness's own **session ID** (`captureId` equals it). `wisdom track` registers a launch (`POST /launches`, `WISDOM_LAUNCH_ID`); each Claude Code/Codex hook names its session, and the daemon routes it to that session's capture, continuing it on resume and switching on `/clear` or `/new`. Pi's extension opens captures itself.

## Gotchas

- MCP must be launched with `node dist/src/cli.js mcp`, not `npm run`, because npm's banner corrupts stdout.
- Codex requires `track codex --setup-hooks` and `/hooks` review before recording (or opt-in `--trust-all-hooks`). Codex ignores hook exit code 2 and runs the tool after a hook crash: its hook must exit 0 and print a JSON deny/block. Read [docs/CODEX.md](docs/CODEX.md) for setup, coverage limits, and version checks.
- Changes during a tool are labeled `observed-during-tool` (temporal, not proof of authorship); idle ones `external-or-unknown`. Preserve this honesty when touching attribution.
- `.wisdom/`, `dist/`, `.npm-cache/` are excluded from observation; `.wisdomignore` takes plain relative paths/prefixes only (no globs/negation).
- Tracked harnesses keep their sessions in `.wisdom/harnesses/<harness>/home/` (per-process `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, Pi `--session-dir`), never in the global harness folders; Claude Code and Codex log in once there.
- Native transcripts/payloads are stored unredacted; never commit `.wisdom/`.
- Ledger words and positions are documented in [docs/NOMENCLATURE.md](docs/NOMENCLATURE.md); the agent-facing skill is [skills/wisdom-ledger/SKILL.md](skills/wisdom-ledger/SKILL.md). Never add a rule that cuts or rewords tool output or patches; see [docs/POLICY.md](docs/POLICY.md).
