# Codex recording

Codex sessions in a Wisdom project are recorded in the same SQLite ledger as Pi and Claude Code, read through the same glance and open. Old desktop/IDE sessions are not imported.

## Setup

`wisdom init` writes Wisdom's ten command hooks to `.wisdom/harnesses/codex/home/hooks.json`, Codex's home in the project (`CODEX_HOME`). Codex keeps this project's sessions, its login and its hook-trust decisions there, not in `~/.codex`; your global Codex settings, plugins and MCP servers do not apply. Any Codex process with that home loads the hooks, however it was started.

Codex runs a hook only after you trust it. Review once:

```powershell
npm.cmd run wisdom -- track codex --cwd C:\project --setup-hooks
```

Open `/hooks` in Codex, review and trust Wisdom's ten hooks, then quit. Then:

```powershell
npm.cmd run wisdom -- track codex --cwd C:\project
npm.cmd run wisdom -- track codex --cwd C:\project -- resume --last
```

`--codex-bin FILE` selects another executable. Node 24+ must be available as `node` on the child's PATH. CLI 0.164.0 is the minimum version accepted (hooks in `hooks.json` verified there: listed as user hooks, enabled, untrusted until reviewed); `track codex` checks that all ten hooks load and are trusted before starting. Moving the Wisdom checkout or the project changes the hook command, so run `wisdom init` again and review again. Configuration/profile arguments are included in the check. Use Wisdom's `--cwd`; remote attachment and Codex workspace overrides are unsupported.

Until the hooks are trusted, nothing is lost: the daemon reads each session from its rollout file once the file is quiet, marked `not-recorded-live`.

### Skipping the review: `--trust-all-hooks` (opt-in)

```powershell
npm.cmd run wisdom -- track codex --cwd C:\project --trust-all-hooks
```

This passes Codex's `--dangerously-bypass-hook-trust` for the session, and Wisdom prints a warning. The bypass covers **every** enabled hook in that run, not only Wisdom's: any `.codex/hooks.json` shipped by the repository runs without review. Use it only in repositories you trust. The check still requires all ten Wisdom hooks to be loaded and enabled.

## The hook never blocks

Verified against Codex CLI 0.147.0 by real runs:

| Hook output | Codex behaviour |
| --- | --- |
| `PreToolUse` JSON `permissionDecision: "deny"` | Tool blocked |
| Exit code 2 (documented as blocking) | Logged as "Failed"; the tool still runs |
| Hook crash, or timeout (40 s) | Logged as "Failed"; the tool still runs |
| `{}` from Wisdom plus a deny from another hook | Tool blocked: a user's own deny always wins |

Wisdom's hook always prints `{}` ("no opinion"; Stop and SubagentStop require JSON). It never denies, never changes tool input and never adds model context, so your own hooks behave as they do without Wisdom. When the daemon cannot take an event, the hook keeps it in `.wisdom/spool/`, starts the daemon, and exits 1 with a warning; the daemon records it later, marked `delivered-late`. Each event is one request (the observation and its raw `harness_event` together) with a 10-second limit, and starting the daemon takes at most 10 more, inside Codex's 40-second timeout. If Wisdom's build cannot load ([integrations/codex/hook.mjs](../integrations/codex/hook.mjs)), the event cannot be kept: the hook says so and answers `{}`.

Not covered by hooks: a hook process Codex cannot start (`node` missing from PATH), and tools that bypass hooks. A result without a recorded start appears as a `missing-tool-start` gap, and the rollout file still holds what Codex wrote.

## Evidence and lifecycle

- Storage: `.wisdom/harnesses/codex/<capture-id>/`, with byte-preserved native JSONL, `subagents/agent-<id>.jsonl`, and payloads referenced by SQLite.
- Normalized observations supply the same ledger views as other harnesses. Separate `harness_event` records (children of their observation) preserve original hook JSON objects; the ledger does not show them as turns or calls.
- Native `turnId` links keep overlapping turns separate. `recorded-turn` identifies native turn matching; temporal file attribution remains `observed-during-tool`.
- Each session is one capture, named by its own ID, however Codex was started. Resume continues it; `/new`, `/clear` and `/fork` sessions are their own captures, all recording until Codex quits (Codex ends every session it opened then) or they are idle for 10 minutes. Compaction within the same session is retained as an event. A subagent's events name its own rollout file; they do not count as a transcript switch, and a subagent's rollout is never taken for a session.
- Subagent tool calls carry `agentId`. The `spawn_agent` result supplies `childAgentId`, so the call shows `→ a1` and `open a1` returns everything the subagent did, with the same layers as a turn. Subagent transcripts are copied at stop as preserved evidence, not separately indexed conversations. Missing tool-level identity does not establish main-agent authorship.
- Shell and patch tools trigger workspace reconciliation, so their file changes are recorded even when hooks lack detail.

### Tool results that arrive only in the transcript

Codex sends **no `PostToolUse` for a failed command** (including a failed `apply_patch`) and has no failure hook. When a turn ends (`Stop`), or the capture closes, a still-open tool whose result is in the rollout is finished from it: the `tool_finished` record has `resultBasis: "native-transcript"`, and `isError` comes from Codex's `Exit code: N` envelope. Finishing waits for the turn end because parallel calls can show a result before their own hook runs; a result hook that arrives later is kept as evidence and is not a gap. A tool with no result anywhere stays without a result (`no result recorded` in the ledger), and the capture ends `interrupted`.

Successful commands whose response has no exit metadata keep `isError` unknown; their status is `completed`, meaning a result was recorded.

### Work that hooks do not see

- Hosted tools such as WebSearch fire no hooks.
- The `node_repl` MCP server installed by the Codex desktop app can run shell commands and patches inside one `mcp__node_repl__js` call; hooks see only that outer call. File changes are still recorded by reconciliation. When `node_repl` appears enabled in Wisdom's Codex `config.toml`, `track codex` prints a note; to see each command, add `-- -c mcp_servers.node_repl.enabled=false`. The check reads the config file only and is best-effort.

Missing transcripts, pending tools, interrupted captures, and hook coverage limitations remain visible. Native transcript parsing is version-sensitive. See the official [hook contract](https://learn.chatgpt.com/docs/hooks) and [configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference).

## Validation

`npm test` runs deterministic normalization, hook-process (including the shim with no build), transcript-result, subagent-link, storage, attribution, and ledger tests. `npm run test:codex` checks the installed CLI's hook discovery and trust requirements in an isolated Codex home, without model calls; `WISDOM_CODEX_BIN` overrides its executable.

A live run on Codex 0.147.0 (`track codex --trust-all-hooks -- exec …`) recorded a shell edit, a failed command (from the transcript, as an error), and a subagent's command reachable by opening the subagent (`open a1`). The hooks-in-home setup and the spool have not yet been exercised in a live Codex session; repeat that kind of run after trusting hooks locally, stop the daemon mid-session, then glance at it and open its turns.
