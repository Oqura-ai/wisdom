# Does the ledger help a reviewer?

Wisdom assumes that a reviewer who can read the session behind a change finds problems that a diff and a description hide, at a token cost worth paying. This experiment tests that on known problems. It runs from start to finish with no interaction.

## How it works

1. **Prepare (free).** Real Pi records a session in a small git project, with Wisdom's real extension, real tools, and real test runs that really fail. Only the model's words are scripted, by [lib/provider.mjs](lib/provider.mjs). Then the change is committed.
2. **Review.** Two reviewers read the same change, each with no file or shell access:
   - **Diff:** the commit message, the agent's report and the diff.
   - **Ledger:** the same, plus the `ledger` tool and the [skill](../skills/wisdom-ledger/SKILL.md).
3. **Judge.** A model compares each review with the case's list of known items, never told which reviewer wrote it. It quotes the words it relied on.
4. **Report.** [run.mjs](run.mjs) writes `report.md` and `results.json` in the run folder. Every prompt, review and judgement is saved in `runs/<run>/<case>/reviews/`.

**Why a scripted worker.** A real model told to plant a problem would have that instruction in its session, and the ledger reviewer would simply read it. A script leaves only what a session would really show.

## The cases

Each file in [cases/](cases/) holds the starting project, the prompts, the worker's steps and the known items.

| Case | Needs the session | Plain in the diff | Requested, so not a problem |
|---|---|---|---|
| `invoice-rounding` | Test expectations changed after it failed; refund rounding dropped, yet claimed | Leftover debug log | Rename of `TAX` |
| `config-migration` | Migration failed and its output was written by hand; a failing test was deleted | Hardcoded absolute path | Deleting `src/legacy.js` |
| `session-cleanup` | A file the user ruled out was edited; lifetime claimed changed but only the README was | Empty `catch` | Adding `listSessions` |

- **Needs the session:** the diff alone leaves out the request or the failure behind it. A sharp reviewer can still suspect some of these from a diff, and that counts for them.
- **Plain in the diff:** the control. Both reviewers should find these, so the ledger should not lower this score.
- **Requested:** looks like scope creep from a diff. Flagging it is a false alarm, so this measures whether context prevents wasted review time.

## Limits set before running

The ledger is **clearly better at a reasonable cost** only if all three hold:

| Measure | Limit |
|---|---|
| Problems needing the session, ledger minus diff | At least 30 points higher |
| Tokens per review, ledger against diff | At most 3 times |
| Requested work flagged | Not higher |

| Result | What to do next |
|---|---|
| All three hold | Build the link from sessions to commits |
| Finds more, but misses a limit | Reduce how much must be read before building anything new |
| Does not find clearly more | Rethink before building more |

## Running it

Needs a build (`npm.cmd run build`), Pi and a Claude Code login. Reviews use your Claude Code login and cost money; workers do not.

```powershell
node experiment/run.mjs prepare                  # record the sessions, free
node experiment/run.mjs review --dry             # show what would be sent, free
node experiment/run.mjs review --runs 1 --cases invoice-rounding   # a pilot of 2 reviews
node experiment/run.mjs review                   # the rest; finished reviews are not repeated
node experiment/run.mjs report
node experiment/run.mjs all                      # all of the above in one go
```

`--guide short` tells the ledger reviewer the session ID and the two moves instead of giving it the whole skill. `--budget` stops the run once that much is spent (default $3); finished reviews are kept, and running it again continues. `--model` and `--judge` change the models (default `haiku` and `sonnet`).

## How far to trust the result

- **Few and small:** 3 cases at 3 runs each shows a direction, not proof. The diffs are 37 to 62 lines, and real diffs are far larger, where a diff alone should do worse. So this probably understates the ledger on recall, and it also understates what the ledger costs to read.
- **Written by us:** the people testing the idea wrote the cases. Real agent sessions are the next step if this passes.
- **The judge is a model:** it may see signs of which reviewer it is reading, such as a mention of a turn. Its quotes are saved so a person can check them.
- **Scripted sessions** have no thinking text and show 0 tokens. Real sessions are longer, which would cost the ledger reviewer more.
