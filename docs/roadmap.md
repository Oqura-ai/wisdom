# Roadmap

Where Wisdom is heading. These are plans, not promises, and the order can change. What exists today is in the [usage guide](usage.md), and current gaps are in [limitations](limitations.md).

**Effort:** S is a small change, M touches several files, L is a new part of the tool.

## Now: a finished local tool

| Work | What you get | Effort | Status |
| --- | --- | --- | --- |
| npm package with a built-in dashboard | Install with one command | M | Done, not yet published |
| `wisdom doctor` | One command that says what's wrong and how to fix it | M | Done |
| Handoff between sessions and harnesses | `wisdom handoff`: a new or existing session reads another session first, and both show the link | S | Done |
| Share a session as one file | `wisdom share`: one file with no logins, after a secret check that redacts, keeps or cancels | M | Done |
| Read shared sessions | `wisdom import`: a teammate's file, read-only, in glance, open and the dashboard | M–L | Done |
| Export as Markdown | `wisdom export`: a session anyone can read in a PR, an issue or docs, after a secret check | S | Done |
| Clone a session | `wisdom clone`: carry your own or a teammate's session on in the same harness, recorded from the clone onward | M | Done; other logins untested |
| Health and controls in the dashboard | See problems, and start, stop or repair from a project's own dashboard | M | Under discussion |
| Storage and delete | See how much space sessions use, and delete one with a confirmation | M | Planned |
| Search across sessions | Find a prompt, reply, command or file name, then jump to it | L | Planned |
| Mark failed subagents, link forks to parents | Fewer sessions that look complete when they aren't | M | Planned |
| Tested on macOS and Linux | A promise beyond Windows | M | Planned |
| Connect projects | `wisdom connect`: run plain `claude`, `codex` or `pi` with your normal login and still record, in a project you choose | L | Done |

## Next: record without the extra setup

| Work | What you get | Effort |
| --- | --- | --- |
| Worth checking | A short list at the top of each session: a call that failed with no later success, a test that failed before a test file was edited, part of a session not recorded. Built from recorded facts, with no AI. | M |
| Sessions and commits | See the commits made during a session, and find the session behind a commit | M |
| Easier install | A one-line installer that includes Node, then a desktop app | L |

## Later: share the work

| Work | What you get | Effort |
| --- | --- | --- |
| Handoff files | Pick sessions, run a secret check, and send one small file with no logins inside. A teammate's agent reads it and continues, even in a different harness. | L |
| Review with evidence | Reviewers see what was asked, tried and dropped behind a PR, next to the diff | L |
| Team sharing | Shared evidence with permissions, retention and access controls | L |
| Agent-to-agent review | Agents hand work to each other with fixed review candidates. See the [design note](design/agent-review-architecture.md). | L |
