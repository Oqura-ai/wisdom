# Codex recording

`wisdom track codex` records newly launched local CLI sessions in the same SQLite ledger as Pi and Claude Code, read through the same glance and open. It does not import old desktop/IDE sessions.

## Setup

Build with `npm.cmd run build`, then run:

```powershell
npm.cmd run wisdom -- track codex --cwd C:\project --setup-hooks
```

Open `/hooks` in Codex, review and trust Wisdom's ten command hooks, then quit. Setup is an ordinary, unrecorded Codex session; submit work only after starting the tracked invocation:

```powershell
npm.cmd run wisdom -- track codex --cwd C:\project
npm.cmd run wisdom -- track codex --cwd C:\project -- resume --last
```

`--codex-bin FILE` selects another executable. Node 24+ must be available as `node` on the child's PATH. CLI 0.147.0 is the minimum version accepted; a capability check also verifies that the recording hooks load and are trusted. Moving the Wisdom checkout or changing hook definitions may require another review.

The launcher passes hook/MCP settings for this invocation and sets `CODEX_HOME` to `.wisdom/harnesses/codex/home/`, so Codex keeps this project's sessions, its login and its hook-trust decisions there, not in `~/.codex`. Log in once on the first tracked launch; `--setup-hooks` reviews trust in that same folder. Wisdom does not edit global configuration, and your global Codex settings, plugins and MCP servers do not apply to tracked sessions. Configuration/profile arguments are included in the preflight check. Use Wisdom's `--cwd`; remote attachment and Codex workspace overrides are unsupported.

### Skipping the review: `--trust-all-hooks` (opt-in)

```powershell
npm.cmd run wisdom -- track codex --cwd C:\project --trust-all-hooks
```

This passes Codex's `--dangerously-bypass-hook-trust` for the session, and Wisdom prints a warning. The bypass covers **every** enabled hook in that run, not only Wisdom's: your global hooks and any `.codex/hooks.json` shipped by the repository run without review. Use it only in repositories you trust. The preflight still requires all ten Wisdom hooks to be loaded and enabled. `--setup-hooks` remains the default path.

If an older Wisdom daemon is running, stop it when its active captures can be interrupted, then restart it after rebuilding. Capture API version 4 adds raw-event batching, transcript-based tool results and subagent links.

## How recording fails closed

Verified against Codex CLI 0.147.0 by real runs:

| Hook output | Codex behaviour |
| --- | --- |
| `PreToolUse` JSON `permissionDecision: "deny"` | Tool blocked |
| `UserPromptSubmit` JSON `decision: "block"` | Prompt blocked before the model runs |
| Exit code 2 (documented as blocking) | Logged as "Failed"; **the tool still runs** |
| Hook crash, or timeout (40 s) | Logged as "Failed"; **the tool still runs** |
| `{}` from Wisdom plus a deny from another hook | Tool blocked: a user's own deny always wins |

So when Wisdom cannot record a prompt or tool, its hook exits 0 and prints the denial. A blocked call reports "Wisdom cannot record this PreToolUse … work stays paused until recording works." For other events (Stop, SubagentStop, PostToolUse…), a block would mean something else or cannot undo work, so the hook reports the failure without a decision.

To keep the hook from failing open:

- [integrations/codex/hook.mjs](../integrations/codex/hook.mjs) blocks prompts and tools itself if Wisdom's build cannot be loaded (for example, before `npm run build`).
- Each event is one daemon request (the observation and its raw `harness_event` together), with a 10-second limit, well inside Codex's 40-second hook timeout.
- If the input cannot be parsed, the event name is recovered from the raw text, so a broken `PreToolUse` is still denied.

Still not covered: a hook process that Codex cannot start at all (for example `node` missing from PATH), disabled hooks, and tools that bypass hooks. Wisdom cannot prevent those calls, but a result without a recorded start appears as a `missing-tool-start` gap.

Wisdom's hook never changes tool input, never adds model context, and prints `{}` ("no opinion") whenever recording succeeds. Your own hooks behave as they do without Wisdom.

## Evidence and lifecycle

- Storage: `.wisdom/harnesses/codex/<capture-id>/`, with byte-preserved native JSONL, `subagents/agent-<id>.jsonl`, and payloads referenced by SQLite.
- Normalized observations supply the same ledger views as other harnesses. Separate `harness_event` records (children of their observation) preserve original hook JSON objects; the ledger does not show them as turns or calls.
- Native `turnId` links keep overlapping turns separate. `recorded-turn` identifies native turn matching; temporal file attribution remains `observed-during-tool`.
- Each launcher invocation creates a capture. Resume preserves the native session identity. A session/transcript switch during a capture stops recording; restart through Wisdom. Compaction within the same session is retained as an event. A subagent's events name its own rollout file; they do not count as a transcript switch.
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

A live run on Codex 0.147.0 (`track codex --trust-all-hooks -- exec …`) recorded a shell edit, a failed command (from the transcript, as an error), and a subagent's command reachable by opening the subagent (`open a1`). After the model stopped the daemon mid-session, its next tool was blocked with Wisdom's message. Repeat that kind of run after trusting hooks locally, then glance at it and open its turns.
