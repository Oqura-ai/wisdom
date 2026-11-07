# Wisdom

**Know what your coding agent actually did.**

[![License: Apache 2.0](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
![Node 24+](https://img.shields.io/badge/node-%3E%3D24-green.svg)
![Claude Code · Codex · Pi](https://img.shields.io/badge/agents-Claude%20Code%20·%20Codex%20·%20Pi-8A2BE2.svg)

## Why we built this

If you code with agents, you know the moment. You ask Claude to fix a failing test. Twenty minutes later it says *"All tests pass now."* The diff looks fine, so you commit it.

A week later something breaks, and you go looking for what happened in that session. Was the test fixed, or was the test changed until it passed? Did it run the full suite or one file? What else did it touch? The session is gone. All that's left is a diff and the agent's own summary, and the summary is the agent describing itself.

We kept running into this, and it gets worse the more you rely on agents:

- **You can't check the claim.** "Done, tests pass" is easy to say. What was actually run, what failed, and what was changed along the way usually isn't visible anywhere.
- **Every new session starts from zero.** The next agent, or the same one tomorrow, doesn't know what was tried last time. You end up explaining it all again.
- **Switching agents loses the thread.** When Claude runs out mid-task and you open Codex, you're copying context by hand.
- **Reviewers see the result, not the work.** A teammate gets a clean diff with no idea what was asked, what failed, or what was quietly dropped.

So we built Wisdom. It sits next to Claude Code, Codex and Pi and records every session as it happens: each prompt, each reply, each command with its real output, and each file change as an actual diff, tied to the step that made it. Nothing is summarized or reworded, and nothing leaves your computer.

The record answers those questions directly. You can open the session and see what really happened. Your agent can read it too, so you can just ask *"what did the last session change, and did the tests really pass?"* and get an answer from facts. When you switch to Codex, it starts by reading what Claude did. When a teammate reviews the work, you can send them the session itself, with secrets removed.

## Get started

You need [Node.js 24+](https://nodejs.org) and at least one of Claude Code, Codex or Pi.

```sh
npm install -g @oqura/wisdom
```

Then choose how to record your project.

### Option 1: Simple (recommended)

Keep using your agents exactly as you do now, with your own login.

```sh
cd your-project
wisdom connect
claude          # or codex, or pi
```

Start the agent in the project's own folder. The first time, Codex asks you to trust the project and to approve Wisdom's hooks in `/hooks`, and Pi asks you to trust the project. To stop recording, run `wisdom disconnect`.

### Option 2: More control

Each agent gets its own separate home inside the project's `.wisdom/` folder, and Wisdom changes nothing else in your project. It also records what Option 1 can't: sessions started from a subfolder, and Codex in a git worktree. Each agent asks you to log in once for this project.

```sh
cd your-project
wisdom init
wisdom track claude         # or: wisdom track pi
```

For Codex, approve Wisdom's hooks once with `wisdom track codex --setup-hooks` (open `/hooks`, trust them, quit), then use `wisdom track codex`.

You can use both options in the same project. More detail in [two ways to record](docs/usage.md#two-ways-to-record).

### See what happened

```sh
wisdom dashboard
```

This prints a local address. Open it in your browser to see every session as a conversation, with each command, file change, token count and cost.

> On Windows PowerShell, if scripts are blocked, type `wisdom.cmd` instead of `wisdom` (and `npm.cmd` for npm).

## Everyday use

| You want to… | Do this |
| --- | --- |
| See all recorded sessions | `wisdom dashboard`, or `wisdom glance` in the terminal |
| Read one session in the terminal | `wisdom glance latest`, then `wisdom open t3 --capture latest` for turn 3 in full |
| Ask your agent about past work | Just ask it, for example: *"look at my last session, what failed?"* |
| Continue a session later | `wisdom resume <session-id>` (the dashboard shows the exact command) |
| Move the work to another agent | `wisdom handoff codex` (or `claude`, `pi`): it starts by reading the last session |
| Give a session to a teammate | `wisdom share <session-id>`, and they run `wisdom import <file>` |
| Put a session in a PR or an issue | `wisdom export <session-id> --out session.md` |
| Check that everything works | `wisdom doctor` tells you what's wrong and the command that fixes it |
| Stop recording a project | Option 1: `wisdom disconnect`. Option 2: just stop using `wisdom track`. Your recordings are kept either way |

This is what `wisdom glance latest` shows:

```text
session 0f3c8a1e-… · claude-code · closed · version 55
4 turns · 8 tool calls · 1 failed · 4 changes · 82,138 tokens · $0.0063

t3  in        Make the tests pass.
    out       All tests pass now.
    2 tool calls · changed test/login.test.ts
```

## How it works

A small hook in the agent's settings passes each event (prompt, reply, command, file change) to a background service on your computer. The service saves it in the project's `.wisdom/` folder, along with the real file diffs it observes itself. With Option 1 the hook sits in your project's agent settings, kept out of git. With Option 2 it sits in the agent's own home inside `.wisdom/`.

Git ignores `.wisdom/`, but keep it private: it holds your sessions in full.

## Your agent can debug its own past

This is where Wisdom pays off day to day. Every agent you connect gets a small skill that teaches it to read the recordings on its own. You don't paste logs or explain history. You ask:

> *"Why does `jev_router/tool.py` look like this? Which session changed it, and was that on purpose?"*

The agent reads in two moves, the way you'd skim a session yourself:

1. **Glance** at the session: every request in full, plus the facts of each turn, such as tool calls, failures and the files changed. It spots the turn that touched the file.
2. **Open** that turn: what you asked, what the agent replied, every command with its real output, and then every change as a diff, each tied to the step that made it.

Here's a real turn it would read:

```text
t3  in        Add a one-line docstring to main() in jev_router/tool.py.

c4  Edit src/optim_jev/tools/jev_router/tool.py · ok · → p1
reply     I added a one-line docstring to main().

p1  src/optim_jev/tools/jev_router/tool.py · modify · +2 −1 · observed during c4
     def main() -> None:
    -    mode = sys.argv[1] if len(sys.argv) > 1 else ""
    +    """Dispatch a JSON request from stdin to the handler named by argv[1]."""
    +    mode =sys.argv[1] if len(sys.argv) > 1 else ""
```

The request says *docstring*. The reply says *docstring*. The diff shows it also changed the line below. The agent now knows the change, the intent behind it, and where the two don't match. It found this without reading the whole codebase, and without trusting anyone's summary.

The same goes for *"which test failed before you said it passed?"*, *"what did the last session try that didn't work?"* and *"pick up where Claude left off"*. The agent finds its way to the exact turn and reads the evidence, instead of guessing from the current code.

## Documentation

[Installation](docs/installation.md) · [Usage](docs/usage.md) · [Dashboard](docs/dashboard.md) · [Agents](docs/agents.md) · [Harnesses](docs/harnesses.md) · [Limitations](docs/limitations.md) · [Roadmap](docs/roadmap.md) · [All docs](docs/index.md)

Wisdom is early and has been tested on Windows so far. macOS and Linux are next. See [limitations](docs/limitations.md).

## Contributing

```sh
git clone https://github.com/Oqura-ai/wisdom.git && cd wisdom
npm ci && npm test
```

Start with [development](docs/development.md) and the [data policy](docs/policy.md). Coding agents working on this repo should read [AGENTS.md](AGENTS.md).

## License

[Apache 2.0](LICENSE)
