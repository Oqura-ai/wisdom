# Contributing to Wisdom

Thanks for helping. Wisdom records what coding agents do, so a bug can quietly misstate who
changed what or leak a secret. Please read this page before opening a pull request.

## Set up

Node.js 24 or newer.

```sh
git clone https://github.com/Oqura-ai/wisdom.git
cd wisdom
npm ci
npm test
```

On Windows PowerShell with scripts blocked, use `npm.cmd`. Tests run from `dist/`, so build
before running a single file: `npm run build`, then `node --test dist/test/<name>.test.js`.
More in [development](docs/development.md).

## Before you open a pull request

1. **Automated checks.** Run `npm run check` and `npm test`. Add a test for the behaviour you
   changed, named for what a user would observe.
2. **Live checks, when your change needs them.** Some behaviour only shows with real agents, a
   real model, a real git host or Windows. [Live testing](docs/live-testing.md#what-needs-a-live-run-and-why)
   maps the folders you touched to the checks to run; the [live test plan](docs/live-test-plan.md)
   has each one step by step.
3. **Docs.** Update the page that describes what you changed, and [limitations](docs/limitations.md)
   if you add or remove one.
4. **In the pull request**, say which live checks you ran, on which OS and agent versions, and
   anything that did not go as expected.

| If you changed | Run at least |
| --- | --- |
| `src/harnesses/`, `integrations/`, `src/record/` | Plan sections 1 and 2, and 8.3 |
| `src/team/commits.ts` (attribution) | 2.1–2.13, especially 2.9, and the measurement in 9 |
| `src/team/writer.ts`, `plain.ts`, `guides.ts` (guides) | 4.1–4.16 |
| `src/team/team.ts`, `githooks.ts`, `gitrefs.ts` (push, fetch, hooks) | Sections 3, 5, 6 and 7 |
| `src/share/`, secret patterns | 5.4, 5.4b and 5.7 |
| Anything that starts processes or deletes files | The cases above on Windows |
| The dashboard | Open it on a project with many sessions and a large commit |

## Rules

- **Evidence stays honest.** Changes to recording, storage or reading follow the
  [data policy](docs/policy.md). Never cut or reword tool output or patches, and never label a
  change as made by a session that only saw it.
- **Never commit `.wisdom/`.** It holds unredacted transcripts and agent logins.
- **Test against a private remote.** Live team-mode runs push sessions; never point a test clone
  at a public repository, and plant only fake secrets.
- **Hooks never block.** A Wisdom hook must not fail or stall an agent, a commit or a push.
- **Docs** live in `docs/` with lowercase, hyphenated names, listed in [docs/index.md](docs/index.md).

## Coding agents

If an agent works on this repository for you, point it at [AGENTS.md](AGENTS.md). Agents can't
run the live checks alone, since they need your logins and a private remote: ask yours which
ones your change needs.

## License

By contributing you agree that your work is licensed under [Apache 2.0](LICENSE).
