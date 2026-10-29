# Repository Guidelines

## Project Structure & Module Organization
Wisdom records Pi, Claude Code, and Codex sessions through a local daemon and SQLite ledger. Agents read a session through the ledger (glance and open) over CLI or MCP.

- `src/`: TypeScript source. `harnesses/` contains adapters and launchers; `daemon.ts`, `captures.ts`, and `workspace.ts` handle recording; `database.ts` and `ledger.ts` own storage; `discovery.ts` serves the agent-facing ledger and `views.ts` the dashboard.
- `integrations/`: Claude Code and Codex hooks; `skills/wisdom-ledger/`: agent-facing reading instructions.
- `test/`: automated tests; `test/fixtures/`: scripted integration provider.
- `docs/`: vocabulary, storage, Codex, and the data-layer policy ([POLICY.md](docs/POLICY.md)). `notes/` describes future architecture, not implemented behavior.
- `dist/`: generated JavaScript; `.wisdom/`: local runtime data. Both are Git-ignored.

## Build, Test, and Development Commands
Use Node.js 24 or newer. On restricted PowerShell installations, replace `npm` with `npm.cmd`.

- `npm ci --legacy-peer-deps`: install locked dependencies.
- `npm run build`: compile source and tests into `dist/`.
- `npm run check`: type-check without emitting files.
- `npm test`: build and run `dist/test/*.test.js`.
- `npm run test:pi`: build and run the installed-Pi integration test; set `WISDOM_PI_ENTRY` for a custom Pi entry point.
- `npm run test:codex`: check installed Codex hook discovery without model calls.
- `npm run wisdom -- daemon run`: run the daemon in the foreground.
- `npm run wisdom -- track claude --cwd <project>`: launch a tracked session; use `pi` for Pi.

## Coding Style & Naming Conventions
Follow existing TypeScript style: two-space indentation, single-quoted strings, semicolons, camelCase functions/variables, and PascalCase types/classes. Use descriptive lowercase, hyphenated filenames where appropriate, such as `claude-code/`. Keep `.js` extensions in relative imports for NodeNext ESM resolution. Strict TypeScript checking is enabled; no formatter or linter is configured.

## Testing Guidelines
Use `node:test` and `node:assert/strict`. Name regular tests `test/*.test.ts` and describe observable behavior in test titles. After building, run a focused file with `node --test dist/test/ledger.test.js`. Isolate filesystem/database tests in temporary directories and close daemons during cleanup. Add regression coverage for changed behavior; no numeric coverage threshold is configured. Run `npm run check` and `npm test` before submitting.

## Commit & Pull Request Guidelines
History is sparse: subjects include `project init`, `README.md`, and a `feat:` commit. Prefer concise, imperative subjects with a relevant prefix, such as `fix: keep continuation at the stated version`. PRs should describe behavior changes, link relevant issues, report validation, and update affected documentation.

## Security & Configuration
Never commit `.wisdom/`: transcripts and payloads are unredacted. Tracked harnesses store their sessions in `.wisdom/harnesses/<harness>/home/`, never in the global harness folders. Launch stdio MCP with `node dist/src/cli.js mcp`; npm banners interfere with its protocol.
