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
- **Tokens:** usage per harness, model, capture and request: fresh input, cache read, cache write, output, reasoning and cache hit rate, with the cost the harness reports. Codex reports none, so the dashboard estimates it from tokens at OpenAI's standard API prices ([src/prices.ts](../src/prices.ts), dated) and says so once on the page. Agents reading the ledger see only reported cost. Usage comes from each harness's native transcript, indexed while it is copied.
- **Continue a session:** each session shows a command to copy that continues it from any terminal, with its folder and harness home set so it keeps recording.
- **Health:** a line at the top of every page with `wisdom doctor`'s checks, refreshed every minute. Open it for each check and its fix, **Repair…** for broken hooks or an older reading skill (backed up first, restorable), and earlier backups. See [usage](usage.md#health-storage-and-repair-in-the-dashboard).
- **Storage:** on the overview, the project's disk space by session, database and harness home, the largest sessions, and **Clean up…** for sessions not active for 30 days (or another number).
- **Delete:** each session page has **Delete**. A dialog shows what goes, the linked sessions still recording, and, for a connected session, a choice to delete the harness's own copy too. See [deleting a session](usage.md#deleting-a-session).
- **Display:** Light, Dark and Night themes and the text size (100, 125 or 150%, default 150%). The choice is remembered per browser, and the first visit follows the system setting.

Claude Code's internal helper agents (prompt suggestions, recaps) are recorded but folded out of the tree.

## Access

The dashboard reads through its own read-only daemon route, `POST /view`: project counts and tokens, a capture's records, one turn, one record's bodies. Agents use the [ledger](agents.md) instead. It binds to loopback, the daemon token stays on the dashboard's server, and requests not addressed to localhost are refused, because recordings are unredacted.

Two routes change something: deleting sessions (`/delete`) and repairing hooks (`/repair`). They take only a JSON request from the dashboard's own page, so another website open in the browser cannot trigger them: it cannot send JSON without a cross-origin check this server never passes, and a form it posts carries its own origin, which is refused. Health (`/doctor`) and storage (`/storage`) only read.

To change it while working on Wisdom, see [development](development.md#dashboard).
