# Live testing

`npm test` checks Wisdom's logic in temporary folders, with no logins, no model calls and no
network. Some behaviour only shows up with real agents, a real model, a real git host and a
real operating system. Before you open a pull request that touches one of the areas below,
run the matching live checks and say in the PR which ones you ran.

This page says what to run and why. The [live test plan](live-test-plan.md) has every case
step by step: what to do, how to see the result, and what you should see.

## What is automated

| Command | What it covers |
| --- | --- |
| `npm test` | Recording, reading, positions and limits, secrets and sharing, clone and export, commit records and guides (with a stand-in writer), team push, fetch and delete against a git remote on disk, the CI check, hook installation, `wisdom doctor`, the npm package contents |
| `npm run test:pi` | The installed Pi, driven by a scripted provider: real file tools, no model spend |
| `npm run test:codex` | The installed Codex finds and trusts Wisdom's hooks; no model calls |

## What needs a live run, and why

| Area | Why the tests can't see it | Run it when you change |
| --- | --- | --- |
| Real agents recording | Claude Code and Codex need a login and a model; their hooks, exits and transcripts change between versions | `src/harnesses/`, `integrations/`, `src/record/` |
| Two agents at once | Attribution depends on real timing: one agent's long command while another edits | `src/team/commits.ts`, `src/record/` |
| Model guides | Only a real model run shows cost, time limits and whether the guide is honest | `src/team/writer.ts`, `src/team/plain.ts`, `src/team/guides.ts` |
| A real git host | Hidden refs, the host's secret scanning, CI, squash, rebase and merge buttons | `src/team/`, `docs/team.md` workflow |
| Two people | A teammate's view: fetched copies, wording, windows that ignore pulled commits | `src/team/team.ts`, `src/read/discovery.ts`, `src/share/` |
| Windows | File locks, shells, CRLF, hook processes and detached jobs | anything that starts processes or deletes files |
| Size | Thousands of files, long sessions, many pushed versions | `src/record/workspace.ts`, `src/team/`, the dashboard |

## Setting up a live run

- A **private** repository on your git host. Sessions are pushed to it, so never use a public one.
- Two clones with different git names and emails: one plays you, the other a teammate.
- In each clone: `wisdom connect` (or `wisdom init` and `wisdom track …`), with Claude Code, Codex and Pi installed and logged in.
- Install your build the way users do: `npm pack`, then `npm install -g ./oqura-wisdom-<version>.tgz`.
- A model guide costs about $0.001 to $0.01. A full run costs well under a dollar.

## The checklist

Each row is one scenario, with the plan section that has its steps. "Passes if" is what to look for; read the proof yourself, not only the command's summary line.

| # | Scenario | Plan | Passes if |
| --- | --- | --- | --- |
| 1 | Install, connect, one small edit in each agent; `wisdom glance`, `open`, `doctor` | [1](live-test-plan.md#1-install-and-local-basics) | Three sessions; `git status` clean; doctor finds nothing |
| 2 | Local mode: an agent edits, you commit; then two agents at once on different files, one running a long command | [2](live-test-plan.md#2-commits-in-local-mode-no-policy-file) (2.1–2.9) | Each piece names the step that made it, never the other agent's; a hand edit says `not recorded` |
| 3 | Local mode: a subagent edits; a linked worktree; a side branch; a tracked hooks folder (Husky) | [2](live-test-plan.md#2-commits-in-local-mode-no-policy-file) (2.10–2.20) | Subagent position `a1/…`; worktree matched; window ignores the side branch; Husky folder untouched, the line to add is printed |
| 4 | Team mode: commit `wisdom-team.json`; agents commit (Claude Code, Codex, Pi), you commit agent work, you commit a hand edit | [3](live-test-plan.md#3-team-mode-setup), [4](live-test-plan.md#4-commit-record-and-guide-a-real-model) (4.1–4.12b) | `Wisdom-Record:` line; a guide for agent work, none for a hand edit; `jobs.log` shows time and cost |
| 5 | Guides: reason in an earlier turn; the agent refuses part of a request; tests run in the window; `guide off`; no `claude` on PATH; `guides.command` | [4](live-test-plan.md#4-commit-record-and-guide-a-real-model) (4.8–4.16) | The guide cites the earlier turn and says where the agent departed; plain guide when off; "no guide writer" when missing; the label names the command |
| 6 | Push and fetch: plant a fake key in a prompt, push; teammate fetches and reads | [5](live-test-plan.md#5-push-and-fetch-through-the-git-host) (5.1–5.7) | The key is redacted in the pushed session and record; your recording keeps it; the teammate sees `[redacted …]` |
| 7 | A project `check` that refuses; push with the network off; push with nothing new | [5](live-test-plan.md#5-push-and-fetch-through-the-git-host) (5.5, 5.8–5.11) | The push goes through and says why a session stayed home; retried on the next push |
| 8 | CI: add the workflow; PRs with guides, guide off, no writer, a missing session, a commit without Wisdom; squash, rebase and merge-commit merges | [6](live-test-plan.md#6-pull-requests-and-ci) | Green and red where expected; after each merge `glance --commit` still reaches the records |
| 9 | Deletion: `wisdom team delete`; teammate fetches; push again; prune | [7](live-test-plan.md#7-deletion-and-retention) | Gone from the remote and from the teammate's disk; not pushed back |
| 10 | Stress: a 2,000-file commit; a lockfile update; stop the daemon mid-session; kill a guide job then push; a long window; `git push --mirror` | [8](live-test-plan.md#8-stress-and-failure) | Nothing lost; gaps stated honestly; the push repairs the missing guide |
| 11 | Measure: 20 or more pieces whose author you know, checked against the input of the call `glance --commit` names | [9](live-test-plan.md#9-measurement) | Count right, wrong and missed |

## Status of the last full run

2026-11-14, Windows 11, Claude Code 2.1.325, Codex 0.166.0, Pi 1.2.0, GitHub.

| Area | Result |
| --- | --- |
| 1–4, 6–9 | Pass. Bugs found on the way are fixed: a lost commit job, the writer's run recorded as a session, `wisdom connect` un-ignoring files, a deleted copy left on a teammate's disk, the writer label |
| 2, two agents at once | Fixed: a long command no longer takes another agent's edit |
| 5, guides | Fixed: the guide now says where the agent departed, reasons in other turns and tests run |
| 6, secrets | Fixed: commit records are scanned and redacted before push |
| 10, stress | Partly open, see below |
| 11, measurement | 30 of 31 checkable pieces right; the one wrong was the two-agent case, since fixed |
| PR from a fork | Not run: the test organisation does not allow forks of private repositories |

## Still open

- A huge commit (thousands of files) takes minutes to record, and its model guide runs out of time.
- The dashboard's project page hangs on a turn that changed thousands of files.
- `wisdom team fetch` can time out in the terminal when it has much to import; the daemon finishes the work.
- There is no command to delete a commit record, and a record removed from the remote stays in clones that fetched it.
- `wisdom doctor` does not yet check that a team's own `check` command can run on this machine.
- A pull request from a fork has not been tested.
