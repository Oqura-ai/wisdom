# Wisdom vocabulary

The words an agent reads in ledger responses, and the record names behind them.
The ledger is implemented in [src/discovery.ts](../src/discovery.ts); its request
schema is `ledgerSchema` in [src/schema.ts](../src/schema.ts).

## Requests

One tool (`ledger` over MCP, `POST /ledger` over HTTP, `glance`/`open` in the CLI), five parameters:

| Parameter | Meaning |
| --- | --- |
| `glance: true` | Without `capture`: recorded sessions, newest first. With `capture`: the session's shape and one entry per turn. |
| `open` | A position, returned whole (see below). |
| `capture` | A session ID, a unique prefix of 8 or more characters, or `latest` (the most recently started session with a turn; if none has one, the most recently started). Required with `open`. |
| `from` | Line to continue from, as a limited response's last line states. |
| `at` | Read version to pin. Every response states its version. |

Exactly one of `glance` and `open` is sent. Errors say what to send instead.

## Positions

| Position | What it is |
| --- | --- |
| `t3` | Turn 3: the third input the user gave, in recorded order. A subagent's task is not a turn. |
| `t3/c2` | The second tool call of turn 3, in recorded order. Opening it shows its full input and output and its patches, with no de-duplication. |
| `a1` | The first subagent of the capture, numbered by its first recorded evidence. It opens with the same layers as a turn. |
| `a1/c2` | The second tool call of subagent 1. |
| (glance header) | `session <id>` is the harness's own session ID, which names the recording; `resume with: wisdom resume <full session ID>` continues it under recording. |
| (glance header) | `shared copy from <project>, shared <time> · read-only, as recorded on the sender's machine`: a session imported from a share file. `redacted by sender ×N`: values the sender replaced with `[redacted by sender: <kind>]`. |
| (glance header) | `cloned from <id> (<harness>) at version N · 12 turns`: this session began as a copy of that one, made by `wisdom clone`. Its first turns happened there and are read there; this session's turns start after them. Record type `session_link`, with a `history-cloned` gap. |
| (glance header) | `continues <id> (<harness>)`: this session was started by `wisdom handoff` to carry on that session's work. `continued after <id> (<harness>) · at t5`: this session was resumed by a handoff, and from t5 it carries on after that session. Record type `session_link`. |
| `outside` | Calls and changes recorded outside any turn (before the first input, or idle edits by other processes). |
| `p1` | A patch, numbered within the response that shows it. It is a label, not an address: open its turn or call. |

Positions are stable at a version: records are append-only, so a number never moves to
other evidence.

## Response grammar

| Text | Meaning |
| --- | --- |
| `in` | The user's input, in full. A subagent's input is shown as `task`. `in (from session file)` when no hook reported it and it was read from the harness's own session file. `in (harness notice)` when the harness wrote it to wake the agent, such as a finished background command; the agent's work after it is a turn, but it is not a person's prompt. |
| `out` | In a glance: the start (240 characters, whitespace joined) of the turn's last assistant reply. `(from hook)` when the harness's final-reply hook is the only copy. |
| `reply` | An assistant reply, whole, as recorded. `reply (from hook)` when only the hook has it. |
| `thinking  redacted · 1.1 s` | The harness recorded that thinking happened, not its text (Claude Code omits it; Codex encrypts it). |
| `c1  Edit src/a.ts · ok · 61 ms · → p1` | A call: tool, target, status, duration, the patches observed while it ran, and any subagent it started (`→ a1`). |
| `input and output repeat p1` | The tool's input and output are the change itself (an edit or write), shown once as the patch. Open the call for the raw input and output. |
| `output  file content, N characters` | A successful file read, listed by size. Open the call to read it. |
| `p1  path · modify · +2 −1 · observed during c1` | A patch: path, operation, line counts, attribution. The raw unified diff follows, indented. |
| `change  path · p3 · not made by a recorded tool call` | A change inside a turn with no tool running. |
| `not recorded  …` | A recording gap or a recovery gap, as the recorder logged it. |
| `unreadable  record …` | A stored body could not be read; the reason follows. |
| `⤷ ` | The continued piece of a line longer than 2,000 characters. |
| `complete · N lines` | The whole answer. |
| `limited · lines 1–N of M · continue: {…}` | The answer stopped at the ceiling (80,000 characters). Send the request shown. |

Tool rules per harness ([types.ts](../src/harnesses/types.ts) `toolView`):

| Harness | `patch` (input and output shown as the patch) | `file` (successful output listed by size) |
| --- | --- | --- |
| Claude Code | `Write`, `Edit`, `MultiEdit`, `NotebookEdit` | `Read` |
| Pi | `edit`, `write` | `read` |
| Codex | `apply_patch` | none |

A `patch` call with no recorded change, or one that failed, is shown in full. Every other
tool is shown in full. Unknown tools are always shown in full.

## Status words

| Word | Meaning |
| --- | --- |
| `ok` / `failed` | The harness reported success or an error. A finished tool is not correct code. |
| `outcome not recorded` | A result was recorded without a success flag. |
| `script step` | A call that is the harness's own scripting of tools (Codex `exec`, `wait`), shown whole. The actions it ran are their own calls, such as `Bash`. Their link is only timing, and a glance counts only the actions. |
| `reported-by-harness` | A change the harness reported for a tool when Wisdom observed none (the daemon was down, for example). The diff is the harness's claim, not an observation. |
| `pending` | No result yet, while the session records. |
| `no result recorded` | No result, and the session is no longer recording. |
| `result from transcript` | No result hook arrived; the result was taken from the harness's own transcript. |
| `seen only in transcript` | The call appears in the transcript with no hook for it. |

## Records behind the text

| Name | Meaning | Caveat |
| --- | --- | --- |
| Workspace | Canonical project directory | Windows casing is normalized. |
| Harness | The coding agent recorded (`pi`, `claude-code`, `codex`) | |
| Session | The harness's logical conversation (`sessionId`) | One session has one capture; a resume or a pause continues it. |
| Capture | The record of one harness session, named by that session's ID | A resume continues it; `/clear` or `/new` starts another. |
| Record | One immutable observation | `seq` orders records within a capture. |
| Version | Global SQLite append revision | Fixes the evidence a read sees. It is not a filesystem snapshot. |
| Request (`input`) | A user input as the harness reported it | Records arrival, not when a queued input was consumed. |
| `toolCallId` | The harness's call/result ID | Unique only within a capture. |
| Patch | UTF-8 unified diff of an observed creation, modification or deletion | Creation and deletion diff from or to empty, so contents are visible. Binary or non-UTF-8 files have no patch (`patch not recorded: binary-or-non-utf8`). Renames are a delete and a create. |
| Payload | An exact stored hook body or patch | SHA-256 addressed, inside the capture directory. |
| Usage | Tokens and cost one model response reported | Counted once per response; history from before a capture is excluded; cost only where the harness reports it. |
| Gap | A known missing or limited observation | Listed as `not recorded`; three or more of one kind share a line: `<kind> ×N · first (seq a): … · last (seq b): …`. |

`observed during c1` (record value `observed-during-tool`) means the change was seen while
that call ran. Other active calls and external writers may have contributed; overlapping
calls are kept in `activeToolCallIds`. `external-or-unknown` means no tool call was running.

Assistant text and native transcript lines are linked to the input that was most recent
when they arrived, or to a recorded native turn ID. That link is temporal; after steering,
compaction or queued input it can be wrong about intent.

## Dashboard views

The dashboard reads `POST /view` (`projects`, `project`, `capture`, `turn`, `record`,
`native-result`). These return records as stored, for drawing; agents use the ledger.
