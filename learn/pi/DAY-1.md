# Day 1: understand Pi and capture raw truth

## Goal

By the end of Day 1, a standalone TypeScript program launches Pi in RPC mode and durably records everything it can observe without normalizing or discarding provider data.

Time budget: approximately 10 hours of focused work.

## Mental model to acquire

You are building a protocol recorder, not a transcript exporter.

Pi has four relevant surfaces:

1. **RPC stdin:** commands sent by the host, such as `prompt`, `get_state`, and `get_entries`.
2. **RPC stdout:** command responses and live session events.
3. **Process stderr/lifecycle:** diagnostics, spawn errors, and exit information.
4. **Session JSONL:** durable context entries used for resume, branching, compaction, and context reconstruction.

They have different meanings. Never merge them merely because timestamps are close.

## Block 1 - Map Pi's contracts (90 minutes)

### Read

Read these Pi sources in this order:

1. [RPC mode](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md)
2. [JSON event stream](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/json.md)
3. [Session file format](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/session-format.md)
4. [SDK overview](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md)

Then inspect the same files bundled with your installed Pi version. Online `main` is for understanding the current design; installed files and declarations define what your executable actually supports.

### Produce

In `JOURNAL.md`, build a table with these columns:

| Record | Direction/surface | Durable in Pi? | Correlation ID | Final or streaming? | Wisdom treatment |
|---|---|---|---|---|---|

Include at least:

- command
- response
- `agent_start`
- `agent_end`
- `agent_settled`
- `turn_start`
- `turn_end`
- `message_start`
- `message_update`
- `message_end`
- `tool_execution_start`
- `tool_execution_update`
- `tool_execution_end`
- retry and compaction events
- session header
- session message entry
- compaction entry
- branch summary
- context edit
- stderr line
- process exit

### Comprehension gate

Answer without looking:

1. Why does a successful `prompt` response not mean the work is complete?
2. Why is `agent_end` not always the final lifecycle event?
3. Which record should be treated as the authoritative final assistant message?
4. Why must an RPC client split only on LF instead of using Node's generic `readline` behavior?
5. Why does RPC mode need `get_state` to discover the session ID and session file?
6. How is a Pi session branch represented?
7. What does compaction change: raw history, model-visible context, or both?

Do not continue until you can answer all seven.

## Block 2 - Learn subprocess streams and framing (90 minutes)

### Read

- [Node.js child processes](https://nodejs.org/api/child_process.html), focusing on `spawn`, `stdio`, lifecycle events, Windows behavior, and pipe capacity.
- [Node.js backpressure guide](https://nodejs.org/learn/modules/backpressuring-in-streams).
- [JSON specification, RFC 8259](https://www.rfc-editor.org/rfc/rfc8259).
- [JSON Lines format](https://jsonlines.org/).

### Concepts

Understand these before coding:

- A stream chunk is not a protocol record.
- One chunk may contain half a record, one record, or many records.
- UTF-8 characters may span byte chunks.
- Stdout backpressure can stall the child process if the parent stops reading.
- Stdin writes can also signal backpressure.
- Stdout is protocol data; stderr is diagnostics. Both must be captured, but they are not interchangeable.
- Process `exit`, `error`, and `close` events have different meanings.

### Micro-lab

Before touching Pi, implement and test an LF decoder that accepts arbitrary byte chunks and emits complete record bytes.

Test inputs must include:

- one JSON object in one chunk;
- one record split at every possible byte position;
- several records in one chunk;
- CRLF input;
- an empty line;
- a final unterminated line at process close;
- a multibyte UTF-8 character split across chunks;
- `U+2028` and `U+2029` inside a JSON string;
- malformed JSON that must be preserved rather than dropped.

The decoder may identify a parse failure, but it must return the original bytes or exact decoded line to the journal.

### Gate

Run the tests repeatedly with randomized chunk boundaries. The emitted records must be identical regardless of chunking.

## Block 3 - Observe Pi manually (60 minutes)

Use a disposable directory containing one tiny file. Do not use the OpenRig repository for intentional failures.

First observe single-invocation JSON mode. Then start RPC mode and send commands manually or through a minimal scratch script.

Capture examples of:

- `get_state` request and response;
- a prompt response;
- lifecycle events through `agent_settled`;
- one tool call;
- one failed tool result;
- Pi's stderr;
- the corresponding session JSONL entries.

Compare live event fields with persisted entry fields. Look specifically for identifiers that exist in one surface but not the other.

### Produce

Draw four columns on paper or in `JOURNAL.md`:

```text
host command | live event | session entry | filesystem/Git effect
```

Connect only relationships that you can prove from identifiers or documented protocol behavior. Mark all other attractive-looking links with `?`.

## Block 4 - Design the raw envelope (60 minutes)

The raw archive must preserve provider truth and recorder truth separately.

Design a versioned envelope similar to:

```ts
interface RawRecordEnvelopeV1 {
  schemaVersion: 1;
  captureId: string;
  captureSessionId: string;
  captureSequence: number;
  observedAt: string;
  source: {
    runtime: "pi";
    runtimeVersion?: string;
    surface: "rpc-stdin" | "rpc-stdout" | "stderr" | "process" | "session-file";
    locator?: string;
  };
  content: {
    encoding: "utf-8";
    raw: string;
    parsed?: unknown;
    parseError?: string;
  };
  integrity: {
    algorithm: "sha256";
    value: string;
  };
}
```

This is a starting point, not a mandatory final shape. Decide and document:

- Whether the hash covers raw record bytes or the enclosing JSON.
- Whether the LF delimiter is included in the hash.
- How a final unterminated line is represented.
- Whether `observedAt` is wall-clock time, monotonic elapsed time, or both.
- How you distinguish a host-generated process event from a Pi-emitted event.
- How you record the exact command without exposing credentials.

### Rules

- Never use timestamps as identity.
- Keep a monotonically increasing recorder sequence for deterministic capture order.
- Keep Pi's identifiers unchanged.
- Do not add causal fields yet.
- Do not silently redact after hashing; define redaction before persistence or store a clear coverage gap.
- Never capture the full environment. Use an allowlist of harmless process metadata.

## Block 5 - Build the capture harness (3 hours)

Create `lab/` and implement these responsibilities as separate modules:

```text
src/
  cli.ts
  pi-process.ts
  lf-decoder.ts
  raw-envelope.ts
  raw-journal.ts
  integrity.ts
```

### `pi-process.ts`

- Launch `pi --mode rpc` using `spawn` with an argument array, not a shell command string.
- Keep stdin, stdout, and stderr separate.
- Consume stdout and stderr immediately.
- Observe spawn, error, exit, and close.
- Support graceful abort and forced cleanup.
- Request `get_state` after the protocol is ready enough to accept commands.

### `lf-decoder.ts`

- Split only on byte `0x0A`/LF.
- Accept optional CR before LF.
- Preserve malformed records.
- Flush remaining bytes on close.

### `raw-journal.ts`

- Append one envelope per line to a journal JSONL file.
- Serialize writes so records cannot interleave.
- Flush at meaningful lifecycle boundaries.
- Never rewrite a completed record.
- Surface write failures loudly and stop claiming complete capture.

### `cli.ts`

Support only what the lab requires:

```text
capture --cwd <path> --out <journal>
send-prompt <text>
abort
stop
```

The CLI may initially use a fixed controlled prompt if interactive input would consume too much time.

## Block 6 - Capture one real run (60 minutes)

Use the final demonstration scenario from `README.md`.

After Pi settles:

1. Record `get_state`.
2. Copy or import the referenced session file as a read-only source.
3. Record file size, modification time, and SHA-256.
4. Stop the child cleanly.
5. Confirm that the journal remains readable after the process exits.

Do not mutate Pi's session file and do not claim a file copy is the original. Preserve its source locator and hash.

## Required tests

- Decoder invariance under randomized chunks.
- Malformed JSON preservation.
- Stderr preservation.
- Write ordering under concurrent stdout/stderr activity.
- Unique `captureId` and monotonic `captureSequence`.
- Hash verification detects one-byte modification.
- Process close flushes an unterminated final record.
- Secrets fixture proves environment variables are not serialized.
- Fake Pi child test avoids model use and emits scripted stdout/stderr/exit behavior.

## Day 1 exit review

Write one page answering:

1. What can the live stream tell Wisdom that the session file cannot?
2. What can the session file tell Wisdom that the live stream cannot reliably tell it?
3. Which failures could make your journal incomplete?
4. How will a later consumer know capture was incomplete?
5. Which identifiers will be candidates for normalization tomorrow?

### Pass condition

You pass Day 1 when a real Pi process can exit and you can prove that every observed record was retained with source, order, raw content, and integrity metadata.

You do not pass merely because a terminal transcript looks complete.
