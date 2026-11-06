# Harnesses

A harness is the coding agent Wisdom records. Each one has its own adapter, and none is central. They all record into the same ledger and read the same way.

| | Claude Code | Codex | Pi |
| --- | --- | --- | --- |
| How it reports | Hooks in `settings.json` | Hooks in `hooks.json`, once trusted | Extension in `settings.json` |
| Its home in `.wisdom/harnesses/` | `claude-code/home` | `codex/home` | `pi/home` |
| Variable that sets the home | `CLAUDE_CONFIG_DIR` | `CODEX_HOME` | `PI_CODING_AGENT_DIR` |
| First run | `wisdom track claude`, log in once | `wisdom track codex --setup-hooks`, trust hooks, log in | `wisdom track pi`, `/login` once |
| How agents read | Skill in its home, plus the optional `ledger` tool through `wisdom track` | Skill in its home, plus the optional `ledger` tool through `wisdom track` | Skill in its home |
| Handoff | Takes a first prompt, and a resume ID with one; hooks pass the handoff on | Same | Same; the extension reads it in-process |
| Clone | Found and opened without a login | Found and opened without a login | Resumed in full with a scripted model |
| Last tested version | 2.1.317 | 0.164.0 (the minimum accepted) | 1.2.0 |
| Thinking | When recorded, otherwise `redacted` | Usually encrypted, shown as `redacted` | When recorded |
| Cost | Total per session | Not reported; the dashboard estimates it from tokens | Per message |

`wisdom doctor` shows each harness's state in a project, and says when you're past the last tested version. A newer version may work fine, but native formats can change.

On Claude Code 2.1.317 and Codex 0.164.0, real sessions with only the skill and a shell found the skill by themselves and read recordings with `wisdom glance` and `wisdom open`. See [agents](agents.md).

Each harness starts clean in its home and asks you to log in once. Your global settings, plugins and MCP servers don't apply there. See [how recording works](usage.md#how-recording-works).

## Claude Code

`wisdom init` writes Wisdom's ten command hooks to `.wisdom/harnesses/claude-code/home/settings.json`, keeping any other hooks there. Any Claude Code process using that home loads them, including a background `/fork`, a `/branch`, a resume or a worktree.

```sh
wisdom track claude
wisdom track claude -- --continue
```

`--claude-bin FILE` selects another executable. Claude Code's transcript format is internal, so its hooks are the primary evidence and the transcript backs them up.

- Entering a worktree moves a session's file. The copy follows it.
- `/fork` runs as a background process, recorded as its own session, and can outlive the terminal it started from.
- A finished background command wakes the agent through the prompt hook. It's a turn, shown as `in (harness notice)`, not something a person asked.
- Internal helper agents (prompt suggestions, recaps) are recorded but folded out of the dashboard's tree.
- `/rewind` adds no marker, and restoring code with it has not been tried.

## Pi

`wisdom init` adds Wisdom's extension to `.wisdom/harnesses/pi/home/settings.json`. Wisdom reuses your own Pi installation and doesn't install another agent.

```sh
wisdom track pi
wisdom track pi -- --continue
```

`--pi-entry FILE` selects another installation. Inside Pi, `/wisdom-status` reports the session. Wisdom chooses where Pi stores sessions, so `--session-dir` is refused, and a session file outside Wisdom can't be tracked.

- `/tree` moves within one session without a marker in the ledger.
- Runs with a real model through the installed package haven't been done yet. The integration test loads the skill from Pi's home and drives real file tools with a scripted provider.

## Codex

Codex sessions in a Wisdom project are recorded in the same SQLite ledger as Pi and Claude Code, read through the same glance and open. Old desktop/IDE sessions are not imported.

### Setup

`wisdom init` writes Wisdom's ten command hooks to `.wisdom/harnesses/codex/home/hooks.json`, Codex's home in the project (`CODEX_HOME`). Codex keeps this project's sessions, its login and its hook-trust decisions there, not in `~/.codex`; your global Codex settings, plugins and MCP servers do not apply. Any Codex process with that home loads the hooks, however it was started.

Codex runs a hook only after you trust it. Review once:

```sh
wisdom track codex --setup-hooks
```

Open `/hooks` in Codex, review and trust Wisdom's ten hooks, then quit. Then:

```sh
wisdom track codex
wisdom track codex -- resume --last
```

`--codex-bin FILE` selects another executable. Node 24+ must be available as `node` on the child's PATH. CLI 0.164.0 is the minimum version accepted (hooks in `hooks.json` verified there: listed as user hooks, enabled, untrusted until reviewed); `track codex` checks that all ten hooks load and are trusted before starting. Moving the Wisdom installation or the project changes the hook command, so run `wisdom init` again and review again. `wisdom doctor` shows whether the hooks are trusted. Configuration/profile arguments are included in the check. Use Wisdom's `--cwd`; remote attachment and Codex workspace overrides are unsupported.

Until the hooks are trusted, nothing is lost: the daemon reads each session from its rollout file once the file is quiet, marked `not-recorded-live`.

#### Skipping the review: `--trust-all-hooks` (opt-in)

```sh
wisdom track codex --trust-all-hooks
```

This passes Codex's `--dangerously-bypass-hook-trust` for the session, and Wisdom prints a warning. The bypass covers **every** enabled hook in that run, not only Wisdom's: any `.codex/hooks.json` shipped by the repository runs without review. Use it only in repositories you trust. The check still requires all ten Wisdom hooks to be loaded and enabled.

### The hook never blocks

Verified against Codex CLI 0.147.0 by real runs; not repeated on 0.164.0. Codex runs each hook through `powershell.exe -NoProfile -Command` on Windows.

| Hook output | Codex behaviour |
| --- | --- |
| `PreToolUse` JSON `permissionDecision: "deny"` | Tool blocked |
| Exit code 2 (documented as blocking) | Logged as "Failed"; the tool still runs |
| Hook crash, or timeout (40 s) | Logged as "Failed"; the tool still runs |
| `{}` from Wisdom plus a deny from another hook | Tool blocked: a user's own deny always wins |

Wisdom's hook always prints `{}` ("no opinion"; Stop and SubagentStop require JSON). It never denies, never changes tool input and never adds model context, so your own hooks behave as they do without Wisdom. When the daemon cannot take an event, the hook keeps it in `.wisdom/spool/`, starts the daemon through `Start-Process` on Windows (a child started with `spawn` holds the hook's output pipe, so Codex waits for its 40 s timeout and then kills it), and exits 1 with a warning; the daemon records it later, marked `delivered-late`. Each event is one request (the observation and its raw `harness_event` together) with a 10-second limit, and starting the daemon takes at most 10 more, inside Codex's 40-second timeout. If Wisdom's build cannot load ([integrations/codex/hook.mjs](../integrations/codex/hook.mjs)), the event cannot be kept: the hook says so and answers `{}`.

Not covered by hooks: a hook process Codex cannot start (`node` missing from PATH), and tools that bypass hooks. A result without a recorded start appears as a `missing-tool-start` gap, and the rollout file still holds what Codex wrote.

### Evidence and lifecycle

- Storage: `.wisdom/harnesses/codex/<capture-id>/`, with byte-preserved native JSONL, `subagents/agent-<id>.jsonl`, and payloads referenced by SQLite.
- Normalized observations supply the same ledger views as other harnesses. Separate `harness_event` records (children of their observation) preserve original hook JSON objects; the ledger does not show them as turns or calls.
- Native `turnId` links keep overlapping turns separate. `recorded-turn` identifies native turn matching; temporal file attribution remains `observed-during-tool`.
- Each session is one capture, named by its own ID, however Codex was started. Resume continues it; `/new`, `/clear` and `/fork` sessions are their own captures, all recording until Codex quits (Codex ends every session it opened then) or they are idle for 10 minutes. Compaction within the same session is retained as an event. A subagent's events name its own rollout file; they do not count as a transcript switch, and a subagent's rollout is never taken for a session.
- Subagent tool calls carry `agentId`. The `spawn_agent` result supplies `childAgentId`, so the call shows `→ a1` and `open a1` returns everything the subagent did, with the same layers as a turn. Subagent transcripts are copied at stop as preserved evidence, not separately indexed conversations. Missing tool-level identity does not establish main-agent authorship.
- Shell and patch tools trigger workspace reconciliation, so their file changes are recorded even when hooks lack detail.

#### How a tool runs, and where its result comes from

Since at least 0.164.0 the model usually calls `exec`: JavaScript in a sealed V8 isolate that calls `tools.exec_command` and `tools.apply_patch`. A script running past its yield time returns a cell ID, and the model polls it with `wait`. One action appears in three places:

| Where | Name | ID | Holds |
| --- | --- | --- | --- |
| `response_item` (the model's view) | `exec`, `wait` | `call_…` | The script and its printed output |
| `event_msg` `item_completed` (what ran) | `CommandExecution`, `FileChange` | `exec-…` | Status, exit code, output, the exact diff |
| Hook `PreToolUse`, `PostToolUse` | `Bash`, `apply_patch` | `exec-…` | Input and response; hooks do not fire for `exec` or `wait` |

So hooks give live timing and file snapshots, and `item_completed` gives outcomes, joined by ID. `exec` and `wait` are shown as `script step` and not counted as tool calls; no record states which script ran which action, so Wisdom claims no link. A hook without an outcome takes it from the item if it is already in the rollout; otherwise a `tool_finished` with `resultBasis: "native-transcript"` is added when the turn ends. A failed command's exit code is what Codex reports: it runs commands through `powershell.exe -Command` on Windows, which reports 1 for most failures.

On 0.147.0, Codex sent **no `PostToolUse` for a failed command**. When a turn ends (`Stop`), or the capture closes, a still-open tool whose result is in the rollout is finished from it, with `isError` from its `Exit code: N` envelope. Finishing waits for the turn end because parallel calls can show a result before their own hook runs; a result hook that arrives later is kept as evidence and is not a gap. A tool with no result anywhere stays without a result (`no result recorded` in the ledger), and the capture ends `interrupted`.

A change Wisdom did not observe for a tool (the daemon was down, or its baseline came after) is recorded from the `FileChange` item, labelled `reported-by-harness`. Successful commands with no recorded outcome keep `isError` unknown. A session read only from its rollout shows each action and how it ended, but no diffs.

#### Work that hooks do not see

- Hosted tools such as WebSearch fire no hooks.
- The `node_repl` MCP server installed by the Codex desktop app can run shell commands and patches inside one `mcp__node_repl__js` call; hooks see only that outer call. File changes are still recorded by reconciliation. When `node_repl` appears enabled in Wisdom's Codex `config.toml`, `track codex` prints a note; to see each command, add `-- -c mcp_servers.node_repl.enabled=false`. The check reads the config file only and is best-effort.

Missing transcripts, pending tools, interrupted captures, and hook coverage limitations remain visible. Native transcript parsing is version-sensitive. See the official [hook contract](https://learn.chatgpt.com/docs/hooks) and [configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference).

### Validation

Automated tests cover normalization, hook processes (including the shim with no build), transcript results, subagent links, storage, attribution and the ledger. `npm run test:codex` checks the installed CLI's hook discovery and trust requirements in an isolated Codex home, without model calls.

A live session on Codex 0.164.0 recorded through the hooks-in-home setup. The "hook never blocks" table above and the session lifecycle behaviour come from runs on 0.147.0 and have not been repeated on 0.164.0. `reported-by-harness` has only run in tests.

Codex can move sessions out of rollout files (`codex migrate-rollouts`, and its home already holds a `thread_history` database). On 0.164.0 rollouts are still written, but Wisdom's session scan, outcomes and reported diffs all read them, so check this at each Codex upgrade.
