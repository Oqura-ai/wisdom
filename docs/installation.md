# Installation

## Requirements

- Node.js 24 or newer. SQLite comes with Node, so there is no database to install.
- At least one harness: Claude Code, Codex (0.164.0 or newer) or Pi. See [harnesses](harnesses.md) for the versions tested.

## Install

```sh
npm install -g @oqura/wisdom
```

Install it globally, not through `npx`. Each project's hooks store the path to the installed copy, and an `npx` copy lives in a cache folder that can disappear.

On Windows PowerShell with restricted scripts, use `npm.cmd` and `wisdom.cmd` in place of `npm` and `wisdom`.

Check it worked:

```sh
wisdom --version
```

Then follow the [quick start](../README.md#quick-start).

## Check a project

```sh
wisdom doctor
```

Run it inside a project, or pass `--cwd`. It reports the background service, the dashboard, each harness's hooks and version, Codex hook trust, and any events waiting to be recorded. It changes nothing and starts nothing. It exits with code 1 if it finds a problem, and prints the command that fixes each one.

| Level | Meaning |
| --- | --- |
| `ok` | Working. |
| `note` | Worth knowing, such as the service being stopped (it starts by itself) or a harness newer than the last tested version. |
| `problem` | Recording or reading is affected until you run the fix. |

## Update

```sh
wisdom daemon stop                  # in each project
npm install -g @oqura/wisdom@latest
wisdom doctor
```

## When hooks stop working

Hooks store the full path to the installed copy of Wisdom. They stop working, or run an old copy, when that path changes:

- You move the installation.
- You switch Node versions with a version manager such as nvm, because global packages usually live under each Node version. Install Wisdom again under the new version.

Your agent keeps working either way, because Wisdom never blocks it. Live recording stops, and those sessions are read later from the harness's own files, with less detail and no observed file changes. `wisdom doctor` reports this, and so do other `wisdom` commands when the old copy is gone. To repair it, run this in the project:

```sh
wisdom init
```

`wisdom track` and `wisdom resume` also repair hooks. Codex asks you to trust a changed hook again in `/hooks`.

## Move a project

Stop the service first, with `wisdom daemon stop`, then move the folder. Recording carries on, because each hook reports to the home folder it runs in. When the service next starts, recorded sessions follow the project, with a `project-moved` gap, since older records still name the old folder. With Codex, review the changed hook again in `/hooks`.

## Back up

Stop the service, then copy the whole `.wisdom/` folder, including payloads and native copies. A copy of `.wisdom/` is a copy of your harness logins, so treat it like a password.

## Uninstall

1. In each project, stop the service:

   ```sh
   wisdom daemon stop
   ```

2. Remove the package:

   ```sh
   npm uninstall -g @oqura/wisdom
   ```

3. Decide what to do with your recordings. Uninstalling keeps them. To delete a project's recordings and its harness logins for good:

   ```sh
   rm -rf .wisdom                        # macOS, Linux
   Remove-Item -Recurse -Force .wisdom   # Windows PowerShell
   ```

   You can also remove the `.wisdom/` line from the project's `.gitignore`.

If you connected a project, run `wisdom disconnect` in it first, so its settings no longer name Wisdom. There is nothing else to undo. Wisdom never changes `~/.claude`, `~/.codex` or `~/.pi/agent`, so a plain `claude`, `codex` or `pi` is exactly as it was.

If you uninstalled before stopping a service, it keeps running until you end it. Its process ID is in `.wisdom/daemon.json`.
