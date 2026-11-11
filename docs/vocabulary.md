# Wisdom vocabulary

The words an agent reads in ledger responses, and the record names behind them.
The ledger is implemented in [src/read/discovery.ts](../src/read/discovery.ts); its request
schema is `ledgerSchema` in [src/core/schema.ts](../src/core/schema.ts).

## Requests

One tool (`ledger` over MCP, `POST /ledger` over HTTP, `glance`/`open` in the CLI), six parameters:

| Parameter | Meaning |
| --- | --- |
| `glance: true` | Without `capture`: recorded sessions, newest first. With `capture`: the session's shape and one entry per turn. |
| `open` | A position, returned whole (see below). |
| `capture` | A session ID, a unique prefix of 8 or more characters, or `latest` (the most recently started session with a turn; if none has one, the most recently started). Required with `open`. |
| `commit` | With `glance` and no `capture` (`wisdom glance --commit <commit>`): a git commit in this project (a hash, branch or `HEAD`). Each changed piece of it, with the recorded steps that made it. See [Commits](#commits). |
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

## Commits

`glance` with `commit` reads a git commit through the recordings. Nothing is stored; the
same commit at the same version gives the same text. It is implemented in
[src/team/commits.ts](../src/team/commits.ts).

| Text | Meaning |
| --- | --- |
| `commit 1a2b3c4d5e6f · <subject> · committed <time> · version N` | The commit, and the version every position below is read at. |
| `parent … · 4 files · 5 pieces: 4 from recorded steps, 1 not recorded` | A piece is one hunk of the commit's diff against its first parent (no context lines). A merge is read against its first parent. |
| `the commit's own diff: git show <hash>` | The diff itself is not repeated; each piece's `@@` header matches git's. |
| `@@ -2,1 +2,1 @@  t1/c1 in session 7e1f2a3b` | The recorded step that wrote these lines or removed them. Several steps and sessions are listed together, separated by `;` between sessions. |
| `t4 (changed outside any recorded step)` | The step is a change a session saw while no tool call ran (`external-or-unknown`): a person, a formatter, a pull. `outside` when it fell between turns. |
| `not recorded` | No recorded change explains it: made before recording, while nothing was recording, or in a session whose data is gone. `2 lines not recorded` beside steps: part of the piece. |
| `whole file from …` | Lines could not be matched (binary, a missing patch), so the steps that produced the committed file are listed. `earlier changes not recorded`: the steps reach the committed file, but not back to the parent's. |
| `outside this project, not recorded here` | The file is in the repository but not in the folder Wisdom records. |
| `not recorded: excluded from recording` | The path is excluded (`node_modules`, `.wisdomignore`, …). |
| `lined up by file, not by line` | The steps explain the file, but git's diff lines this hunk up differently (repeated lines), so all of the file's steps are listed. |
| `sessions` | Each session with a step in the commit, and its positions. Open them with `capture` and `open`. |
| `record kept when the commit was made, <time>` | Read from the record Wisdom kept in `refs/wisdom/records/<commit>`. `worked out now from the recordings`: no record was kept, so it was worked out on request. |
| `(changed since the commit)` | A kept step whose session no longer has that exact change (its hashes differ). |
| `(session not available)` | A kept step whose session is not here: deleted, or a teammate's not fetched (`wisdom team fetch`). |
| `guide · written by claude-haiku-5-5 via Claude Code, <time> · derived, not evidence · …` | A model's account of the commit for reviewers, written after it (team mode). The line ends with what Wisdom's check found: that it covers every piece and its citations exist (not that it is right), or what did not pass. |
| `guide · none: <reason>` | A commit with agent work and no guide, and why: turned off by the person who committed, no writer installed, the writer failed. |
| `its message carries N recorded commits through their Wisdom-Record lines` | A commit made from others (a squash merge, a cherry-pick): their records follow, each under `── carried: <commit>`. |
| `read Wisdom · N calls · C characters returned, about T tokens` | In a session's glance: how much this session read from Wisdom. Tokens are estimated at four characters each. |

How a piece is matched: each recorded change stores a hash of the whole file before and
after it. Starting from the committed file, Wisdom follows the recorded changes back, each
one whose result is the file the next one started from, until it reaches the parent's
file. The lines are then traced through those changes' patches. A session is linked only
because it produced these exact bytes, never because it touched the same file name.
Changes recorded after the commit's time are not used. Where two sessions saw the same
edit, the one that saw it during a tool call is used. The committed file is compared both
as git checks it out and as stored, so line-ending conversion does not break a match.

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
