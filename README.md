# Wisdom

[![License: Apache 2.0](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
![Node 24+](https://img.shields.io/badge/node-%3E%3D24-green.svg)

**See what your coding agents actually did, not just what they said they did.**

Coding agents now write a lot of our code, but once a session ends, what happened in it is gone. You get a diff and a confident summary. You don't get the command that failed and was quietly retried, the test that was changed until it passed, or the file the agent edited without mentioning it. The next agent, or the teammate reviewing the work, starts from nothing.

Wisdom records your Claude Code, Codex and Pi sessions while they run: every prompt, reply, tool call and file change, with the real diff Wisdom observes itself. Then you, and your agents, can read exactly what happened.

- **Trust, but verify.** Each change is tied to the tool call that made it. Failures stay visible. Anything Wisdom couldn't record is marked as missing, never filled in.
- **Agents that remember.** Ask your agent "what did the last session change, and did any tests fail?" It answers from the record, even in a brand-new chat.
- **Hand work on.** Out of Claude Code credits halfway through? Codex starts by reading what Claude actually did, not a lossy summary.
- **Private by default.** Everything stays on your machine. Nothing is summarized, reworded or sent anywhere.

For example: an agent says it only added a docstring. Wisdom's recorded patch shows it also changed a line of code beside it. Hand the session to another agent, and it spots and fixes the slip from the record.

## Install

You need [Node.js 24 or newer](https://nodejs.org) and at least one of Claude Code, Codex or Pi.

```sh
npm install -g @oqura/wisdom
```

On Windows PowerShell with restricted scripts, use `npm.cmd` and `wisdom.cmd`. See [installation](docs/installation.md) for updating, moving and uninstalling.

## Quick start

### The simple way: keep using your agents as usual

Turn on recording for a project, once:

```sh
cd your-project
wisdom connect
```

Then start your agent in the project as you always do, with your own login. There's nothing extra to log in to:

```sh
claude
codex    # first time: trust the project if asked, then review Wisdom's hooks in /hooks
pi       # first time: trust the project when asked
```

Start Claude Code and Pi in the project's own folder, not a subfolder. Wisdom adds its hook to the project's agent settings and keeps those files out of git, and `wisdom disconnect` takes it all out again. Your global agent settings are never touched.

### The controlled way: everything inside `.wisdom/`

If you'd rather Wisdom change nothing outside its own folder, or you need to record a session started from a subfolder or Codex in a git worktree, give each agent its own home inside the project. Each agent asks you to log in once for that project.

```sh
cd your-project
wisdom init
wisdom track claude                # or: wisdom track pi
wisdom track codex --setup-hooks   # Codex, first time: trust Wisdom's hooks in /hooks, then quit
wisdom track codex
```

Both ways can be used in the same project, and their sessions show up together. See [two ways to record](docs/usage.md#two-ways-to-record).

## See what happened

```sh
wisdom dashboard                   # prints the address of the live dashboard
wisdom glance latest               # the session's shape and every turn
wisdom open t3 --capture latest    # turn 3, whole: replies, tool calls, patches
```

```text
session 0f3c8a1e-… · claude-code · closed (exit-0) · version 55
resume with: wisdom resume 0f3c8a1e-77b2-4c10-9a5e-2d81c6f04b3a
4 turns · 8 tool calls · 1 failed · 4 changes · 0 subagents · 82,138 tokens · $0.0063 reported

t3  in        Make the tests pass.
    out       All tests pass now.
    2 tool calls · changed test/login.test.ts

complete · 20 lines
```

The dashboard shows each session as a conversation or as a tree of requests, tool calls and file changes, with tokens and cost. Your agents read the same record: Wisdom gives each one a skill for it, so you can just ask

> Look at my last session. What did you change, and did any tests fail?

See [agents](docs/agents.md) and [dashboard](docs/dashboard.md).

If something looks wrong, run `wisdom doctor`. It checks everything, changes nothing, and prints the command that fixes each problem.

> [!WARNING]
> `.wisdom/` holds your sessions unredacted, and with the controlled way each agent's login too. Git ignores it, but leave it out of zips, shared drives and synced folders.

## Hand work on, and share it

```sh
wisdom handoff codex               # out of Claude Code? Codex starts by reading that session
wisdom share 0f3c8a1e              # one file for a teammate, after a check for secrets
wisdom import 0f3c8a1e-….wisdom-share   # your teammate reads it, read-only
wisdom clone 0f3c8a1e              # carry a session on, its history included, in the same agent
wisdom export 0f3c8a1e --out pr.md # Markdown anyone can read: a PR, an issue, docs
```

Nothing is summarized: the next agent reads the record itself. A share holds no logins, and whatever looks like a secret is redacted, kept, or the share cancelled, as you choose. See [handing work on](docs/usage.md#handing-work-on), [sharing](docs/usage.md#sharing-a-session), [cloning](docs/usage.md#cloning-a-session) and [exporting](docs/usage.md#exporting-a-session).

## Documentation

| Guide | What it covers |
| --- | --- |
| [Installation](docs/installation.md) | Install, update, move, uninstall |
| [Usage](docs/usage.md) | Commands, how recording works, handing work on, sharing and cloning, reading a session, privacy |
| [Dashboard](docs/dashboard.md) | The live viewer |
| [Harnesses](docs/harnesses.md) | Claude Code, Codex and Pi: setup and what each one records |
| [Limitations](docs/limitations.md) | What doesn't work yet, and how much work each item is |
| [Roadmap](docs/roadmap.md) | What's planned |

The [documentation index](docs/index.md) lists everything, including the architecture and data policy.

## For developers

```sh
git clone https://github.com/Oqura-ai/wisdom.git
cd wisdom
npm ci
npm test
npm run dashboard:install
npm run dashboard:build
npm run wisdom -- doctor
```

See [development](docs/development.md) for tests, packaging and the code map, and [architecture](docs/architecture.md) for how it fits together. Changes to how evidence is recorded or read follow the [data policy](docs/policy.md). Coding agents working on this repository should start with [AGENTS.md](AGENTS.md).

## Limitations

Wisdom is early. The main gaps today:

- **Tested on Windows only.** macOS and Linux are not verified yet.
- **The dashboard only shows.** Each project has its own, and starting, stopping and repairing happen in the terminal.
- **No search.** You read one session at a time.
- **No delete command.** Removing a recording means removing it by hand.
- **The simple way has limits.** Claude Code and Pi record only when started in the project's own folder, and Codex not in a git worktree. The controlled way covers those.
- **Some sessions are only partly recorded.** A subagent that fails before it stops loses its report, and forks don't link to their parent yet.

See [limitations](docs/limitations.md) for the full list and the effort each one needs.

## Roadmap

Next up is search. After that come session handoffs between developers and evidence for code review. See the [roadmap](docs/roadmap.md).

## License

[Apache 2.0](LICENSE). See [NOTICE](NOTICE).
