# Dashboard

A local web viewer that shows a project's recorded sessions live. It ships with the package and starts with the daemon, on the daemon's port + 1 (`http://127.0.0.1:7435` by default).

```sh
wisdom dashboard       # prints the address
```

Start the daemon with `--no-dashboard` to skip it. It never affects recording: if it can't start, capture continues, and `wisdom doctor` says why. Its output goes to `.wisdom/dashboard.log`.

## What it shows

- **Overview:** per-harness cards, tool usage, most-changed files, and every capture.
- **Chat view:** a session opens here, as a centred column with one expandable box per request. Each turn shows the prompt with its stats and time, a folded **Steps** section (thinking, narration, and each tool call, change and subagent expanding on its own), the **Response** rendered as Markdown, and the turn's token details.
- **Dev view:** the record tree (request → tool calls → file changes, with subagents nested under the call that started them) with an evidence inspector. Selecting a node shows its request text, reply, tool input and result, or patch. A subagent lane ends with what the subagent returned.
- **Tokens:** usage per harness, model, capture and request: fresh input, cache read, cache write, output, reasoning and cache hit rate, with cost where the harness reports it. Usage comes from each harness's native transcript, indexed while it is copied.
- **Continue a session:** each session shows a command to copy that continues it from any terminal, with its folder and harness home set so it keeps recording.
- **Display:** Light, Dark and Night themes and the text size (100, 125 or 150%, default 150%). The choice is remembered per browser, and the first visit follows the system setting.

Claude Code's internal helper agents (prompt suggestions, recaps) are recorded but folded out of the tree.

## Access

The dashboard reads through its own read-only daemon route, `POST /view`: project counts and tokens, a capture's records, one turn, one record's bodies. Agents use the [ledger](agents.md) instead. It binds to loopback, the daemon token stays on the dashboard's server, and requests not addressed to localhost are refused, because recordings are unredacted.

To change it while working on Wisdom, see [development](development.md#dashboard).
