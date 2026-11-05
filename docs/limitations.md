# Limitations

What doesn't work yet, what can't work, and roughly how much effort each one needs. Plans for these are in the [roadmap](roadmap.md).

**Effort:** S is a small change, M touches several files, L is a new part of the tool. These are rough sizes, not time estimates.

## At a glance

| Limitation | What it means for you | Effort |
| --- | --- | --- |
| Tested on Windows only | macOS and Linux are expected to work, but no real session has been recorded on them. | M |
| One dashboard per project | No single view of all projects, and each project runs its own daemon and dashboard. | L |
| The dashboard is read-only | Start, stop, repair and delete all happen in the terminal. | M |
| At most about 20 projects running at once | Each running project takes a pair of ports, and each daemon and dashboard stay in memory. | L |
| No search | You read one session at a time. | L |
| No delete command | Removing one recording means editing `.wisdom/` by hand. | M |
| Separate login per project | Each harness logs in once per project, and a plain `claude`, `codex` or `pi` is not recorded. | L |
| Failed subagents go unmarked | A subagent cut off before it stops loses its report, transcript and tokens, with no gap to say so. | M |
| Sessions aren't linked | Forks and `/clear` are a flat list, and `/rewind` isn't marked. | M |
| Long replies through a shell | A harness can cut long shell output. Claude Code saves it to a file and Codex removes the middle, both with a notice, and the skill teaches agents to read the rest. It relies on the agent following that. | S |
| A warning on the first event | When the daemon isn't running, the first hook shows a warning such as `SessionStart:startup hook error`. Nothing is lost, but it looks broken. | S |
| Large projects | Past 10,000 files or 64 MiB of retained contents, changes become gaps instead of diffs. | M |
| Sessions sharing a folder | Two sessions in one folder see each other's changes. These are labelled honestly but can't be separated. | L |
| Native formats can change | A new harness version can change what Wisdom reads. `wisdom doctor` shows when you're past the last tested version. | Ongoing |
| Database upgrades | There is no upgrade step yet. One will come with the first change to the database layout. | M |
| Nothing is redacted | Recordings keep secrets exactly as they appeared. They stay on your machine, and no sharing feature exists. | L |

## What can't be recorded

What a harness does not report cannot be read: thinking a provider encrypts, tool paths that bypass hooks, and changes made by other processes (shown as `external-or-unknown`). These are marked where they occur, never filled in.

## Details

### Recording

- Native session mirroring and idle watcher processing run every 500 ms. Before a tool runs, the harness waits for its start observation to be delivered, or kept in the spool. File changes are observed at tool boundaries, not after every internal filesystem write.
- Direct file tools (Pi `read`/`edit`/`write`; Claude Code `Read`/`Edit`/`Write`/`NotebookEdit` and read-only tools) inspect their named target and watcher hints. Shell and custom calls reconcile the tracked workspace afterward. An idle reconciliation also runs every 30 seconds as a watcher fallback.
- User shell commands outside model tool hooks are observed through filesystem activity and native records. They are not automatically attributed as agent tool calls.
- Changes during tools are labelled `observed-during-tool`, with all active tool IDs. This is temporal evidence, not proof of exclusive authorship. Idle changes are `external-or-unknown`.
- A failed tool can leave changes, which are still recorded. Pending calls remain visible if recording stops.
- If recording fails, nothing is blocked: the event is kept in the spool and a warning is shown (Claude Code and Codex hooks exit 1, Pi shows a notice). What the spool can't hold is the file baseline, so changes made while the daemon was down have no patch. A session whose hooks never ran has only what its own file says.
- Native-message links to a turn are temporal, especially after queued input, steering or branching. Read versions freeze evidence, not the codebase itself.

### Files

- Baseline contents live in memory. An individual observed file is capped at 1 MiB, a workspace scan at 10,000 files, and retained baseline bytes at 64 MiB. Limits and read errors produce visible gaps. Scans are synchronous and can briefly delay queries, so use a bounded workspace.
- `.git`, `.wisdom`, `.npm-cache`, `node_modules`, `dist`, `build`, `.next`, `.venv` and `__pycache__` are excluded by directory name. Symlinks are excluded. Permissions and ACLs are not tracked.
- Renames appear as delete + create. Creations, modifications and deletions store UTF-8 unified diffs when possible. A created or deleted file diffs from or to empty, so its contents are readable. Binary changes get hashes and a missing-patch explanation. Full historical restoration is not promised.

### Storage

- SQLite commits use WAL and FULL synchronous mode. Payload and native-file writes are separate and are not one atomic, power-loss-safe transaction with the database. Recorded recovery gaps and mirror mismatches appear in recovery coverage. Native records above 32 MiB and requests above 16 MiB are explicit limits.

### Subagents

- A subagent's tool calls, their results (failed ones included) and its file changes are recorded as they happen. Its transcript copy, its token usage and its final report are recorded only when the harness sends the subagent's stop event. If a subagent fails, is interrupted, or the session ends before that event, those three are missing and Wisdom does not yet mark that the stop never came.
- Wisdom records no success or failure for a subagent as a whole. Read the result of the call that started it (`→ a1`) and its own calls. Whether each harness sends the stop event for a failed subagent has not been verified.

### Not implemented

LLM-inferred intent, candidate-bound test certification, fixed code review snapshots, automatic multi-agent attribution, and search. Reverse search from a line of code to the turn that produced it is planned for multi-agent work.

Limits specific to one harness are in [harnesses](harnesses.md).
