# Development

## Setup

Node.js 24 or newer. On Windows PowerShell with restricted scripts, use `npm.cmd`.

```sh
git clone https://github.com/Oqura-ai/wisdom.git
cd wisdom
npm ci
npm run build
```

Run your build with `npm run wisdom -- <command>`, for example `npm run wisdom -- init --cwd /path/to/project`.

Compiled output lives in `dist/`. Tests import from there, not from `src/`, so a stale `dist/` can hide source changes.

## Tests

```sh
npm run check        # type-check only
npm test             # build, then the full suite
npm run test:pi      # build, then the Pi integration test (needs an installed Pi)
npm run test:codex   # installed Codex hook discovery and trust, no model calls
```

Run one file after building with `node --test dist/test/ledger.test.js`, and filter with `--test-name-pattern="<regex>"`. No linter is configured.

- `npm test` checks live reads, exact edit patches, failure side effects, partial native records, continuation of limited responses at a fixed version, positions and error messages, nested calls and subagents, MCP, restart recovery, SQLite persistence, `wisdom doctor`, handoff links, the secret check and share file format, importing and reading shared sessions, cloning, Markdown export, and what the npm package contains.
- The Pi integration test starts the installed Pi with its agent folder set up as `wisdom init` does, in an isolated temporary workspace. A local scripted provider drives real file tools and nested calls with no network requests or model spend. It checks that Pi loads the skill from its home, reads while Pi is running, the opened turn, and the mirrored transcript byte for byte. It starts Pi the way `wisdom track pi` does; set `WISDOM_PI_ENTRY` to use another installation.
- `WISDOM_CODEX_BIN` overrides the Codex executable for its test.

Real agents, model guides, a git host, two people at once and Windows file handling need a live run. [Live testing](live-testing.md) says which changes need which checks.

## Dashboard

```sh
npm run dashboard:install   # once
npm run dashboard:dev       # live development on port 7435
npm run dashboard:build     # what the daemon runs and the package ships
```

`dashboard:build` runs `next build` in standalone mode, then [scripts/bundle-dashboard.mjs](../scripts/bundle-dashboard.mjs) assembles `dist-dashboard/`: it adds the static files, removes this machine's paths, restores the bundled packages' licenses, and fails if a native binary got in. The daemon runs `dist-dashboard/server.js`.

## Packaging

The `files` list in [package.json](../package.json) decides what ships: the compiled `dist/src` without source maps, `dist-dashboard`, `integrations`, `skills`, the license and the README. [test/package.test.ts](../test/package.test.ts) fails if tests, docs or other development files get in.

To try the package as a user would:

```sh
npm pack
npm install -g ./oqura-wisdom-<version>.tgz
wisdom doctor
```

`npm pack` runs `prepack`, which builds the code and the dashboard, so `npm run dashboard:install` must have run first.

To publish, you need to be a member of the `oqura` organization on npm:

```sh
npm publish
```

`prepublishOnly` runs the tests first. The dashboard bundle has only been built on Windows so far. It holds no native binaries, but run it on macOS and Linux before promising them.

## Reading the code

Read these in order:

1. [schema.ts](../src/core/schema.ts): record vocabulary and the ledger, view and capture request schemas.
2. [harnesses/](../src/harnesses/): one adapter per harness. [types.ts](../src/harnesses/types.ts) is the contract, and each harness's `launch.ts` writes its hooks into its home. [pi/extension.ts](../src/harnesses/pi/extension.ts), [claude-code/hook.ts](../src/harnesses/claude-code/hook.ts) and [codex/hook.ts](../src/harnesses/codex/hook.ts) send events through `deliver` in [client.ts](../src/service/client.ts).
3. [captures.ts](../src/record/captures.ts): routing by session, the spool, the session-file scan, and operation/change coordination.
4. [workspace.ts](../src/record/workspace.ts): scoped file observation and diff generation.
5. [database.ts](../src/storage/database.ts) and [ledger.ts](../src/storage/ledger.ts): SQLite, payloads and native mirroring.
6. [discovery.ts](../src/read/discovery.ts): the agent-facing ledger (glance, open, positions, the ceiling). [conversation.ts](../src/read/conversation.ts) assembles one turn in recorded order, [evidence.ts](../src/storage/evidence.ts) reads exact bodies at a version, and [content.ts](../src/core/content.ts) extracts surface text. [stats.ts](../src/read/stats.ts) and [views.ts](../src/read/views.ts) serve the dashboard.
7. [daemon.ts](../src/service/daemon.ts): the small HTTP boundary and daemon lifecycle.
8. [cli.ts](../src/cli.ts), [client.ts](../src/service/client.ts), [mcp.ts](../src/service/mcp.ts), [doctor.ts](../src/setup/doctor.ts): human and agent interfaces.

[Architecture](architecture.md) has the storage details and a file-by-file map.

## Rules for changes

- Changes to how evidence is recorded, stored or read follow the [data policy](policy.md), including its checklist.
- Use `node:test` and `node:assert/strict`. Name tests `test/*.test.ts` and describe observable behaviour in their titles. Isolate filesystem and database tests in temporary directories, and close daemons during cleanup.
- Add regression coverage for changed behaviour, and run `npm run check` and `npm test` before submitting. If the change touches an area in [live testing](live-testing.md#what-needs-a-live-run-and-why), run those checks too and list them in the PR.
- Never commit `.wisdom/`. It holds unredacted transcripts and harness logins.
- Docs live in `docs/`, with lowercase, hyphenated filenames.
