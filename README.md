# Wisdom

[![License: Apache 2.0](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
![Node 24+](https://img.shields.io/badge/node-%3E%3D24-green.svg)

See what your coding agents actually did.

Wisdom records Claude Code, Codex and Pi sessions while they run: every prompt, reply, tool call and file change, as it happened. You read them in a live dashboard, and your agents read them through the CLI or MCP. Everything stays on your machine. Nothing is summarized or reworded, and anything Wisdom could not record is marked as missing.

## Install

You need [Node.js 24 or newer](https://nodejs.org) and at least one of Claude Code, Codex or Pi.

```sh
npm install -g @oqura/wisdom
```

On Windows PowerShell with restricted scripts, use `npm.cmd` and `wisdom.cmd`.

See [installation](docs/installation.md) for updating, moving and uninstalling.

## Quick start

Turn on recording for a project, once:

```sh
cd your-project
wisdom init
```

This creates a private `.wisdom/` folder in the project, adds it to `.gitignore`, connects the harnesses you have installed and teaches them to read recordings, and starts a small background service. Your global harness settings are not touched.

Start your agent through Wisdom:

```sh
wisdom track claude
wisdom track pi
wisdom track codex --setup-hooks   # Codex, first time: trust Wisdom's hooks in /hooks, then quit
wisdom track codex
```

Each harness keeps its files in the project's `.wisdom/` folder, so it asks you to log in once.

See what happened:

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

If something looks wrong, ask Wisdom:

```sh
wisdom doctor
```

It checks the service, the dashboard and each harness, changes nothing, and prints the command that fixes each problem.

> [!WARNING]
> `.wisdom/` holds unredacted sessions and each harness's login. It is kept out of git, but leave it out of zips, shared drives and synced folders too.

## Hand work on, and share it

```sh
wisdom handoff codex               # out of Claude Code? Codex starts by reading that session
wisdom share 0f3c8a1e              # one file for a teammate, after a check for secrets
wisdom import 0f3c8a1e-….wisdom-share   # your teammate reads it, read-only
wisdom clone 0f3c8a1e              # carry a session on, its history included, in the same agent
```

Nothing is summarized: the next agent reads the record itself. A share holds no logins, and what the check finds is redacted in the file, kept, or the share cancelled. See [handing work on](docs/usage.md#handing-work-on), [sharing](docs/usage.md#sharing-a-session) and [cloning](docs/usage.md#cloning-a-session).

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

## Let your agents read sessions

`wisdom init` also gives each harness a skill that teaches it to read recordings, so you can just ask:

> Look at my last session. What did you change, and did any tests fail?

The agent answers from the record, using `wisdom glance` and `wisdom open` in its shell, even in a brand-new chat. There is nothing else to set up. If an agent has no shell, Wisdom also offers a read-only MCP tool. See [agents](docs/agents.md).

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
- **Separate login per project.** Sessions started with plain `claude`, `codex` or `pi` outside the project's Wisdom home are not recorded.
- **Some sessions are only partly recorded.** A subagent that fails before it stops loses its report, and forks don't link to their parent yet.

See [limitations](docs/limitations.md) for the full list and the effort each one needs.

## Roadmap

Next up are search and recording without a separate login. After that come session handoffs between developers and evidence for code review. See the [roadmap](docs/roadmap.md).

## License

[Apache 2.0](LICENSE). See [NOTICE](NOTICE).
