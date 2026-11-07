# Agents

How agents read recorded sessions. This guide is about using Wisdom from an agent. To work on Wisdom's own code, see [development](development.md).

## Two moves

- **Glance:** the sessions, or one session's shape and one entry per turn.
- **Open:** one turn, tool call or subagent, whole.

Agents address evidence by position (`t3`, `t3/c2`, `a1`, `outside`), never by copying record IDs. See the [vocabulary](vocabulary.md) for every word a reply can contain.

## The skill

`wisdom init` copies the [wisdom-ledger skill](../skills/wisdom-ledger/SKILL.md) into each harness's home in `.wisdom/`, so every session there has it, however it was started. `init`, `track` and `resume` replace the copy, so it stays in step with your Wisdom version. `wisdom doctor` reports it if it's missing or outdated.

The skill teaches the agent to run the CLI in its shell, inside the project:

```sh
wisdom glance                    # recorded sessions, newest first
wisdom glance latest             # one session: its shape and every turn
wisdom open t3 --capture latest  # turn 3, whole
```

The CLI finds `.wisdom/` by itself and starts the background service if it's stopped.

For a harness Wisdom doesn't support, or one started outside its Wisdom home, copy `skills/wisdom-ledger/` through that harness's own skill mechanism.

## Things an agent should know

The skill covers these too.

**`latest` can be the agent itself.** Inside a recorded session, the agent's own session is often the newest. To read an earlier one, run `wisdom glance` and name its ID.

**A shell can cut long output.** A Wisdom reply can hold up to 80,000 characters, and a harness may show less than that:

| Harness | What happens to long shell output |
| --- | --- |
| Claude Code | Tested at 67 KB: saved to a file, with a short preview and a notice. |
| Codex | Tested at 17,552 tokens: 7,552 of them cut from the middle, with a warning. |
| Pi | Documented as 2,000 lines or 50 KB, with the rest saved to a file. Not tested with Wisdom. |

Wisdom's own `complete` then describes Wisdom's answer, not what the agent saw. The agent should read the saved file, or read in pages at a fixed version:

```sh
wisdom open t3 --capture <session> --at <version> --from 1 | head -n 300
wisdom open t3 --capture <session> --at <version> --from 301 | head -n 300
```

**A sandbox can block starting the service.** Codex's sandbox on Windows allowed reading through a running service, but not starting a stopped one. Hooks normally start it first. If it isn't running, run `wisdom daemon start` outside the sandbox.

## MCP (optional)

Most agents don't need this. It's for an agent with no shell, or if you prefer a tool over a command. The server exposes one read-only tool, `ledger`, with five parameters: `capture`, `glance`, `open`, `from` and `at`. It returns the same text as the CLI, and it can't start a harness or edit code. `wisdom track` already passes it to Claude Code and Codex. In a project set up with `wisdom connect`, agents read with the skill; add the tool as below if you want it there too.

To add it to another agent:

```json
{
  "mcpServers": {
    "wisdom": {
      "command": "wisdom",
      "args": ["mcp", "--data", "/path/to/your-project/.wisdom"]
    }
  }
}
```

On Windows, where `wisdom` is a `.cmd` file that some agents can't start directly, use `"command": "cmd"` and `"args": ["/c", "wisdom", "mcp", "--data", "C:/path/to/your-project/.wisdom"]`.

Starting the MCP server can start the local daemon, including normal recovery of interrupted captures. In a clone of the repository, use `node` with the path to `dist/src/cli.js`, never `npm run`: npm's banner corrupts the protocol on stdout.

## HTTP

The CLI and MCP both use `POST /ledger` on the local daemon, authenticated with the token in `.wisdom/daemon.json`. They read that file and never hard-code the port.

## What Wisdom changes

Files inside the project's `.wisdom/` folder, and, after `wisdom connect`, Wisdom's own entries in the project's harness settings and skill folders, kept out of git. Your global harness configuration is never touched. See [two ways to record](usage.md#two-ways-to-record).
