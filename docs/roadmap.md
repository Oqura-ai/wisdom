# Roadmap

Where Wisdom is heading. These are plans, not promises, and the order can change. What exists today is in the [usage guide](usage.md), and current gaps are in [limitations](limitations.md).

**Effort:** S is a small change, M touches several files, L is a new part of the tool.

## Now: a finished local tool

| Work | What you get | Effort | Status |
| --- | --- | --- | --- |
| Health and controls in the dashboard | See problems, and repair hooks (backed up, restorable) from a project's own dashboard | M | Done |
| Storage and delete | See how much space sessions use, and delete one or many old ones with a confirmation | M | Done |
| Search across sessions | Find a prompt, reply, command or file name, then jump to it | L | Planned |
| Mark failed subagents, link forks to parents | Fewer sessions that look complete when they aren't | M | Planned |
| Clone under another login | `wisdom clone` of a teammate's session, confirmed to resume under your own login | S | Untested |

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
