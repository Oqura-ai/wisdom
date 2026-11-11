# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Wisdom records a running coding-agent session (Pi, Claude Code, or Codex, via per-harness adapters -> local daemon -> SQLite) and lets agents read it through the CLI (taught by a skill `wisdom init` copies into each harness home) or one optional read-only MCP tool (`ledger`), with two moves: `glance` and `open`. It does not orchestrate agents or generate model-written summaries. It ships on npm as `@oqura/wisdom`. [docs/usage.md](docs/usage.md) and [docs/limitations.md](docs/limitations.md) are detailed and accurate about behavior and limits; [docs/design/](docs/design/) describes *future* review architecture, not what is implemented.

## Commands

Node >= 24 required. On Windows PowerShell use `npm.cmd` if script execution is restricted.

```powershell
npm.cmd ci
npm.cmd run build          # tsc -> dist/ (tests run from dist, so always build first)
npm.cmd run check          # type-check only
npm.cmd test               # build + node --test dist/test/*.test.js
npm.cmd run test:pi        # build + Pi integration (needs installed Pi; WISDOM_PI_ENTRY overrides)
npm.cmd run test:codex     # installed CLI hook discovery/trust check; no model calls
npm.cmd run wisdom -- daemon start|status|stop|run
npm.cmd run wisdom -- connect --cwd <project>                  # record plain claude/codex/pi with the own login (disconnect undoes)
npm.cmd run wisdom -- init --cwd <project>                     # .wisdom/, hooks in each harness home, daemon
npm.cmd run wisdom -- track pi|claude|codex --cwd <project>   # start a harness with its home in .wisdom
npm.cmd run wisdom -- resume <full-session-id>                 # continue a recorded session, recording
npm.cmd run wisdom -- handoff codex|<session-id> [--from <id>]  # continue work in another session that reads this one first
npm.cmd run wisdom -- share <session> [--redact|--keep-secrets]  # one file for a teammate, after a secret check
npm.cmd run wisdom -- import <file>                            # read a teammate's share file, read-only
npm.cmd run wisdom -- clone <session>                          # a new session of the same harness holding that history
npm.cmd run wisdom -- export <session> [--out FILE|-]          # the session as Markdown, after a secret check
npm.cmd run wisdom -- glance latest; npm.cmd run wisdom -- open t3 --capture latest   # read a session
npm.cmd run wisdom -- doctor                                   # read-only health check of a project
npm.cmd run dashboard:install; npm.cmd run dashboard:build    # live viewer in dist-dashboard/, served by the daemon on port+1
npm.cmd pack                                                   # the package users install (prepack builds code and dashboard)
```

Run a single test file (after building): `node --test dist/test/ledger.test.js`. Filter by name: add `--test-name-pattern="<regex>"`.

There is no linter configured. Compiled output lives in `dist/` (tests import from there, not `src/`), so stale `dist/` can mask source changes.

## Architecture (read across files)

- **Source layout, one folder per domain** (map in [docs/architecture.md](docs/architecture.md#reading-the-implementation)): `src/cli.ts` and `src/bin.ts` (entry points; installed hooks and the package point at them, so they stay put), `core/` (types, paths), `storage/` (SQLite, payloads, `SessionStore`), `record/` (captures, file watching), `read/` (the ledger and dashboard views), `service/` (daemon, client, MCP), `setup/` (connect, doctor, repair), `sessions/` (clone, handoff), `share/` (share files, secrets, imported copies), `team/` (commit matching, records, git hooks, the guide writer, team mode), `harnesses/`. Tests stay flat in `test/`. Files that find others at runtime (`new URL(..., import.meta.url)`) count `../` from their folder.
- **Commits and team mode** ([docs/team.md](docs/team.md)): [src/team/commits.ts](src/team/commits.ts) matches each hunk of a commit to recorded steps by whole-file hashes; in local mode [watch.ts](src/team/watch.ts) keeps a record per own commit in `refs/wisdom/records/<commit>`. A committed `wisdom-team.json` turns on team mode: three git hooks ([githooks.ts](src/team/githooks.ts): a `Wisdom-Record:` line on each commit, a background job for the record and its guide, `pre-push` sending sessions then records), a guide written by a cheap model through the person's own Claude Code ([writer.ts](src/team/writer.ts), Haiku 5.5 by default, checked by [guides.ts](src/team/guides.ts)), `wisdom check --range` for CI, and `wisdom team fetch|delete|prune`. Hook processes read recordings through [storage/readstore.ts](src/storage/readstore.ts), never the daemon's store. Without that file nothing is pushed, written or changed in commit messages. Every Wisdom hook ignores events while `WISDOM_GUIDE_WRITER` is set.
- **Harness adapters** ([src/harnesses/](src/harnesses/)): no harness is central. Each implements [types.ts](src/harnesses/types.ts) (tool targets, direct file tools, native transcript reading, session files, typed prompts) and owns its installer and launcher (`launch.ts`). The core reaches harnesses only through [harnesses/index.ts](src/harnesses/index.ts). **The harness home is the fence**: `wisdom init` writes Wisdom's hooks into each harness's home in `.wisdom/harnesses/<harness>/home/` (Claude Code `settings.json`, Codex `hooks.json`, Pi `settings.json` extensions), so any process using that home records, however it was started. **Or the project is connected**: `wisdom connect` ([src/setup/connect.ts](src/setup/connect.ts)) puts the same hook, marked `project`, in the project's own harness settings (excluded via `.git/info/exclude`), so plain `claude`/`codex`/`pi` record with the person's own login; that copy stands aside in a tracked session, and `sessionPlace` keeps resume/handoff/clone in the home a session ran in. Never copy logins (refresh tokens rotate). Hooks ([integrations/](integrations/), `src/harnesses/*/hook.ts`, the Pi extension) send through `deliver` in [src/service/client.ts](src/service/client.ts); they **never block** the harness: an undeliverable event goes to `.wisdom/spool/` and the hook starts the daemon. Team mode's git hooks never fail a commit or a push either. Claude Code's transcript format is internal, so its hooks are the primary evidence.
- **Daemon** ([src/service/daemon.ts](src/service/daemon.ts)) is a thin HTTP boundary on `127.0.0.1:7434` (next free pair if taken); port, PID and token are in `.wisdom/daemon.json`, which the CLI/MCP read instead of hard-coding the port. [src/record/captures.ts](src/record/captures.ts) routes each event by session, drains the spool, scans harness homes for session files with no record, and ties file changes to tool operations; [src/record/workspace.ts](src/record/workspace.ts) observes files and generates diffs.
- **Storage**: SQLite ([src/storage/database.ts](src/storage/database.ts), [src/storage/ledger.ts](src/storage/ledger.ts)) holds authoritative metadata; payloads (sha256-addressed) and byte-preserved native harness JSONL live under `.wisdom/harnesses/<harness>/<capture-id>/`. See [docs/architecture.md](docs/architecture.md).
- **Stores**: the read layer depends only on `SessionStore` ([src/storage/store.ts](src/storage/store.ts)): the project's own `Captures`, or a read-only `SharedStore` built from a share file ([src/share/shared.ts](src/share/shared.ts)). The daemon routes each read to the store that holds the session, this project's own first.
- **Read layers**: [src/read/discovery.ts](src/read/discovery.ts) is the agent-facing ledger (`POST /ledger`): positions (`t3`, `t3/c2`, `a1`, `outside`), `glance` and `open`, plain-text replies, one size ceiling (80,000 chars) with an exact `continue` request, every read pinned to a version. [src/read/conversation.ts](src/read/conversation.ts) assembles one turn in recorded order and is shared with the dashboard, whose reads are [src/read/views.ts](src/read/views.ts) (`POST /view`) and [src/read/stats.ts](src/read/stats.ts). Each harness adapter declares how its tools are shown (`toolView`: `patch`/`file`/`full`). CLI ([src/cli.ts](src/cli.ts)) and MCP ([src/service/mcp.ts](src/service/mcp.ts)) return the ledger text unchanged. Changes to this layer follow [docs/policy.md](docs/policy.md).
- One harness session is one capture, keyed by the harness's own **session ID** (`captureId` equals it). Every hook posts `POST /observe` naming its harness, session and cwd; the first event opens the record, a later one after a pause (resume, idle, restart, failure) continues it with a gap. Parallel sessions (a background `/fork`) are separate records, all recording. A capture closes on the harness's end event or after 10 idle minutes. `wisdom clone` ([src/sessions/clone.ts](src/sessions/clone.ts)) writes `.wisdom/clones/<new-id>.json` before the copied transcript, so the daemon links the clone (`session_link` kind `cloned`) and never counts copied lines as turns; adapters rewrite lines with `cloneLine` and place files with `sessionFile`. `wisdom handoff` ([src/sessions/handoff.ts](src/sessions/handoff.ts)) sets `WISDOM_HANDOFF` on the harness it starts; hooks pass it on, and the daemon writes one `session_link` record per handoff. A session file in a home with no record becomes a `found-in-session-file` capture, its prompts read via the adapter's `nativePrompt` (`in (from session file)`).

## Gotchas

- MCP must be launched with `wisdom mcp` or `node dist/src/cli.js mcp`, not `npm run`, because npm's banner corrupts stdout.
- Hooks store the full path of the installed copy, so install globally, not through `npx`. `wisdom doctor` reports hooks that moved or run another copy; `wisdom init` repairs them.
- The `files` list in package.json decides what ships; [test/package.test.ts](test/package.test.ts) guards it. The bundle script removes build-machine paths and fails on native binaries.
- Codex runs Wisdom's hooks only after `/hooks` review in its home (`track codex --setup-hooks`, or opt-in `--trust-all-hooks`); untrusted, its sessions are read from their files only. Its hook must always print JSON (`{}`) because Stop/SubagentStop require it. Read [docs/harnesses.md](docs/harnesses.md#codex) for setup, coverage limits, and version checks.
- Changes during a tool are labeled `observed-during-tool` (temporal, not proof of authorship); idle ones `external-or-unknown`. Preserve this honesty when touching attribution.
- A linked git worktree is not part of its project's watch: each session watches the worktree it works in ([src/record/workspace.ts](src/record/workspace.ts), `SessionFiles`), and a session started in one belongs to the main project. A session that only sees files change there records an `other-worktree` gap, no diffs.
- `.wisdom/`, `dist/`, `.npm-cache/` are excluded from observation; `.wisdomignore` takes plain relative paths/prefixes only (no globs/negation).
- Harnesses keep everything in `.wisdom/harnesses/<harness>/home/` (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `PI_CODING_AGENT_DIR`), never in the global harness folders; each logs in once there. Commands find `.wisdom/` (marked by `wisdom.json`) from the cwd upward; tests pass explicit data folders.
- Native transcripts/payloads and harness logins are stored unredacted in `.wisdom/`; never commit or share it. `wisdom share` ([src/share/share.ts](src/share/share.ts), patterns in [src/share/secrets.ts](src/share/secrets.ts)) is the only way out: redaction happens in the shared file only, never in the recording. A hook reports to the data folder of the home it runs in, so a moved project keeps recording; it never recreates a missing folder.
- Docs use lowercase filenames under `docs/`, indexed in [docs/index.md](docs/index.md). Ledger words and positions are documented in [docs/vocabulary.md](docs/vocabulary.md); the agent-facing skill is [skills/wisdom-ledger/SKILL.md](skills/wisdom-ledger/SKILL.md). Never add a rule that cuts or rewords tool output or patches; see [docs/policy.md](docs/policy.md).
