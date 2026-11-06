# Handoff and share

Status: agreed in discussion on 2026-11-06. All five phases are built, last checked 2026-11-07. Not yet tested: a model answering on a cloned Claude Code or Codex session, and cloning under a different login.

Two ways to carry agent work forward, built from one set of parts:

- **Handoff:** continue work in another session, often another harness, on the same machine. The next agent reads the earlier session from Wisdom's record.
- **Share:** send a session to a teammate as one file. They either read it, or clone it into their own harness and carry on.

## The model

Every case is a choice of where the session comes from and what you do with it.

| | Read it, in any harness | Clone it, same harness only |
| --- | --- | --- |
| **My session** | `wisdom handoff` | `wisdom clone`, for example onto another account |
| **A shared session** | Query it, or `wisdom handoff` from it | `wisdom clone`: carry on the teammate's work |

**Read** means the next agent starts with empty context and a prompt naming the session. It reads what it needs with `wisdom glance` and `wisdom open`, and treats it as someone else's evidence. This works between any harnesses, and costs only what the agent reads.

**Clone** means a new session that already holds the old conversation, through a copy of the harness's own transcript. The agent remembers it as its own work. This only works within one harness, costs the whole history up front, and inherits earlier assumptions along with the context.

## Decisions

- Wisdom stays local to each project. Sharing is a file that a person sends, never a shared folder or service.
- Clones go into the same harness only. A Claude Code transcript can't become a Codex session: the tools, formats and what each model remembers producing all differ. To change harness, read.
- A clone is recorded from the clone onward. The copied history isn't recorded again as the new session's turns; it is linked to where it already lives.
- The dashboard shows a clone's history as a collapsed **Cloned history (N turns)** block that links to the source. Nothing is stored twice.
- Handoff can target a new session in any harness, or an existing session.
- Sharing sends whole sessions, after a secret check with a preview and a confirmation.

## Commands

```text
wisdom handoff <harness | session-id> [--from <session>] [-- your words]
wisdom share <session…> [--out <file>] [--yes]
wisdom import <file>                     # or drop the file into .wisdom/shared/
wisdom clone <session>
```

## Shared parts

### The link record

A new record type, `session_link`, with a `kind` and the other session's ID:

| Kind | Written into | Shown in the glance |
| --- | --- | --- |
| `continues` | A new session started by handoff | Header: `continues 0f3c8a1e (claude-code)` |
| `continued-after` | An existing session resumed by handoff, at the turn it resumed | `t5  continued after 01a1aca0 (codex)` |
| `cloned` | A cloned session | `history  cloned from 0f3c8a1e at version 45 · 12 turns` |

A new session's ID only exists once the harness starts, so the CLI sets `WISDOM_CONTINUES=<id>` (or `WISDOM_CLONE=<note>`) on the harness process. Hooks and the Pi extension run inside it, read the variable, and send it with the first event. If a harness doesn't pass its environment to hooks, a file in `.wisdom/pending-links/` that the first hook claims is the fallback. Whether each harness passes it through is still to be checked.

### Reading across stores

Shared sessions live in their own read-only stores and are never merged into the project's database. `captures.get(id)` looks in the project first, then in shared stores, so `glance`, `open`, the dashboard and handoff work the same on both. When a shared session's ID matches a local one, the local session wins and the shared one is reached by its share ID.

## Phase 0: test cloning (no repo changes)

In throwaway folders, copy one real Claude Code session and one Codex session under new IDs, rewrite their folder paths, and resume each, with the same login and with a second login. This answers whether a clone resumes at all, and whether recorded reasoning (Claude Code's signed thinking, Codex's encrypted reasoning) must be removed. Phase 4 depends on it.

## Phase 1: handoff (size S)

- **New session:** `wisdom handoff codex` picks the session, by default the newest from another harness, and prints which one. It writes a first prompt, for example: *Continue from Wisdom session `<full ID>` (claude-code). Read it with `wisdom glance <ID>` before changing anything.* Your words after `--` are added. It then starts the harness the same way `wisdom track` does.
- **Existing session:** `wisdom handoff <session-id> --from <other>` resumes that session the same way `wisdom resume` does, with a prompt like: *While you were away, Codex session `<ID>` continued this work. Read it before going on.* The resumed session gets a `continued-after` link at that turn.
- **A session still running:** a harness won't accept outside input into a live session, so the command says so and prints the prompt for you to paste.
- **Long sessions:** when the target session is very long, the command suggests a new session instead, because the old context plus the reading can fill the window quickly.
- The full session ID always goes in the prompt, so an agent never mistakes itself for `latest`.
- **Still to check:** whether Pi takes a first prompt on the command line, and whether Claude Code and Codex take a resume ID and a prompt together.
- **Changes:** `cli.ts`, `schema.ts` (record type, optional hook field), the Claude Code and Codex hooks, the Pi extension, `captures.ts`, `discovery.ts` (glance lines), the dashboard header, [vocabulary](../vocabulary.md), the skill, and tests.
- **Built, 2026-11-06:** as above, with the link shown at the top of the glance (`continued after <id> · at t5` for a resumed session) rather than on the turn line. Real Claude Code 2.1.318 and Codex 0.164.0 passed `WISDOM_HANDOFF` to their hooks; Pi reads it in its own process. Claude Code, Codex and Pi all take a first prompt, and a resume ID with a prompt, on the command line.

## Phase 2: share (size M)

- **The file** is one gzipped JSONL stream, built with Node's own `zlib`:
  - line 1, a manifest: format number, Wisdom version, harness and version, version pin, project name, sessions, checksums;
  - every record of each session, as stored;
  - file entries for payloads, the native transcript and subagent transcripts.
- **Never included:** harness homes (logins), the spool, `daemon.json`.
- **Built by the daemon** through a new read-only route, `POST /export`, pinned to one version, so a session still recording comes out consistent.
- **Secret check:** scans every body for common key patterns (`sk-…`, `ghp_…`, `AKIA…`, private key headers, `KEY=value` lines) and lists full paths and the username. It shows each finding with its position (`t3/c2 · line 14`) and writes nothing until you confirm or pass `--yes`. The preview says a scan can miss things.

**Built, 2026-11-06.** Decided in discussion: when the check finds something, stop and let the person choose (redact all, one by one, keep all, cancel); paths and the username are reported, not replaced. Details:
- Read through a new dashboard view, `export`, not a new route: the daemon names the records and files at one version, and the CLI reads the files. The transcript copy is read only up to the bytes indexed at that version.
- Redaction replaces the exact value everywhere in the file, longer values first, with `[redacted by sender: <kind>]`. The header lists each redaction's kind and places, the number of findings kept, and the patches a redaction edited. Payload file names keep their original hash; each file line carries the checksum of its content as written.
- Findings are masked: a long key shows its prefix and last four characters, anything shorter only its first two.
- `--yes` was dropped: `--redact` or `--keep-secrets` must say what to do, and with neither, no terminal means nothing is written.
- The default output is `.wisdom/shared-out/`. A file written inside the project gets a warning to keep it out of git.
- `CAPTURE_API` is 11: hook events may carry a handoff, and the export view exists.

## Phase 3: read shared sessions (size M–L)

- `wisdom import`, or a file dropped into `.wisdom/shared/`, unpacks into `.wisdom/shared/<share-id>/` and builds a separate `ledger.sqlite` from the records. It's a derived index that can be deleted and rebuilt.
- **`SharedStore`** opens that database read-only. Opening a project's data folder today writes to it (it marks sessions interrupted and scans harness homes), so shared stores get their own reader with none of that. It offers the lookups `discovery.ts` and `views.ts` use: a session's manifest, its records at a version, and its bodies.
- **Labels:** the glance says `shared by <sender> · as recorded on their machine`. Versions belong to the shared copy, so `--at` stays valid. The dashboard lists shared sessions in their own section.
- Handoff from a shared session needs no extra code once this exists.
- This adds a place to read from, not a new way to read, so the [data policy](../policy.md) rule for new moves doesn't apply. Its integration rules do: read-only, explicit, nothing leaves the machine unless a person runs a command.

**Built, 2026-11-06.** As above, with these details:
- The read layer depends on a `SessionStore` interface (`database`, `get`, `dataDir`, and `shared` for a copy). `Captures` and `SharedStore` both implement it; recording code is unchanged.
- The daemon routes `/ledger` and `/view` by session: this project's own first, then shared copies. `latest`, exports and the plain list stay with the project; the list adds a "shared with you" section.
- A share ID is the first 16 hex characters of the file's SHA-256, so the same file imported twice is one copy. Building happens in `<share-id>.importing` and is renamed when complete; a folder left `.importing` is never read.
- Every session ID and file path in a share is checked against a fixed shape before anything is written, so a crafted file cannot write outside its folder.
- Records are inserted exactly as stored (`LedgerDatabase.insert`), keeping the sender's links.
- A clash with a session recorded here: the project's own recording wins, and the import says so. Addressing the shared copy separately was left out until someone needs it.
- Handoff can read a shared session (`--from`), never resume one, and never picks one by default.

## Phase 4: clone (size M per harness, after Phase 0)

1. The source can be a shared session or one of your own, in the same harness as the clone.
   A clone always creates a new session. It refuses a session ID that already exists, in the harness home or in the ledger, so it can never overwrite or disturb a session.
2. Each adapter gets `cloneNative(lines, newId, cwd)`. It writes the new session ID and your folder into the copy: on every line for Claude Code, in the header for Codex and Pi. If Phase 0 requires it, it also removes recorded reasoning. The source is never changed.
3. The copy goes where the harness expects it: Claude Code `projects/<folder>/<id>.jsonl`, Codex `sessions/<date>/rollout-…`, Pi its sessions folder.
4. **File check:** records hold each changed file's content hash after the session's last change. The clone compares them with your disk and warns, for example *3 of 5 files differ from what this session remembers*.
5. A clone note in `.wisdom/clones/<new-id>.json` holds the source, its version, and how many lines and bytes were copied.
6. The session starts the same way `wisdom resume` does.

**How a clone is recorded:**
- The note is read at the session's first event, so Wisdom knows exactly which lines are copied and nothing is guessed.
- The native transcript is still mirrored in full, byte for byte, with lines 1–N marked as copied.
- Copied prompts don't become turns, and copied usage stays out of totals (`beforeCapture`, as today).
- A `cloned` link is written, plus a `history-cloned` gap: *history cloned; its file changes were made elsewhere*.
- New prompts are `t1`, `t2`, … The first model call resends the whole history, and that usage counts.
- The dashboard's chat view opens with the collapsed **Cloned history (N turns)** block, linking to the source.

**Built, 2026-11-07.** As above, with these details:
- Phase 0 was folded in: a real Pi session cloned and resumed in full with a scripted model (11 messages loaded); Claude Code 2.1.318 and Codex 0.164.0, without a login, found and opened a clone where they reject an unknown ID. A model answering on cloned history, and other logins, are not tested. Nothing removes recorded reasoning yet.
- Adapters gained `cloneLine` (Claude Code: `sessionId` and `cwd` on every line; Codex: the session's own `session_meta` and each `turn_context`; Pi: the header) and `sessionFile` (where each harness looks).
- A new `transcript` view, routed to your own or a shared store, names the transcript copy up to the bytes indexed at one version, its turn count, and each changed file's last content hash.
- The clone note is written first, with `wx`, then the transcript, also `wx`. The ID is fresh and checked against the home, the notes and the ledger.
- On the session's first event, live or found in its file, `Captures` reads the note, links the clone, adds a `history-cloned` gap and marks the copied line IDs, so copied prompts never become turns. Files that differ are reported, not blocking.
- The dashboard shows `cloned from` and `cloned into` chips, and a collapsed **Cloned history** block in the chat view.

## Phase 5: docs and checks

[Usage](../usage.md), [vocabulary](../vocabulary.md), [limitations](../limitations.md) and the reading skill, so agents know what `continues`, `continued after` and `cloned` mean. One real run per harness, as for the skill, and the full package install check.

## Risks, most serious first

| Risk | Affects | Answer |
| --- | --- | --- |
| Recorded reasoning may not survive another login | Clone | Phase 0. If it fails, remove it from the clone. |
| Secrets reach someone else, or their model provider | Share, clone | Secret check with preview before sharing and before cloning |
| Files don't match what a clone remembers | Clone | File check before starting, with a plain warning |
| The sender's paths and username | Share, clone | Shown before sending. Rewritten in a clone's copy; old paths inside tool output stay. |
| A shared file can be edited | Share | Checksums catch damage only. Everything is labelled *as recorded on the sender's machine*. |
| Recorded text carries instructions | All | The skill already says tool output is data, not instructions |
| Harness formats change | Clone | `cloneNative` per adapter, covered by tests on real fixtures |

## Order

| Phase | Depends on | Size |
| --- | --- | --- |
| 0 · Clone test | Nothing | Small, some model usage |
| 1 · Handoff | Nothing | S |
| 2 · Share | Nothing | M |
| 3 · Read shared | 2 | M–L |
| 4 · Clone | 0, and 3 for shared sources | M per harness |
| 5 · Docs and checks | Each phase | Alongside |

## Open questions

- Is a second Claude Code or Codex login available, for the cross-account part of Phase 0?
- Should handoff default to the newest session from another harness (current proposal), or always ask?
- Should the handoff prompt only say "read it first", or also "run the tests before changing anything"?

## Out of scope

Converting a session between harnesses, merging shared sessions into a project's database, shared folders or services, and anything the [later ideas](../roadmap.md) cover.
