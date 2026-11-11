import fs from 'node:fs';
import path from 'node:path';
import { createTwoFilesPatch } from 'diff';
import { Ledger, hash, writeJson } from '../storage/ledger.js';
import { LedgerDatabase } from '../storage/database.js';
import { SessionFiles, scope } from './workspace.js';
import { hookSchema, preview, type CloneNote, type Handoff, type HookEvent, type Observation, type Manifest, type LedgerRecord } from '../core/schema.js';
import { adapter, harnessNames } from '../harnesses/index.js';
import type { NativeEntry } from '../harnesses/types.js';
import { surfaceText } from '../core/content.js';
import { cloneNote, harnessHome, linkedWorktree, marker, movedFrom, readConnected, spoolDir, worktreeBranch, type Connected } from '../core/paths.js';

interface RunningCapture {
  ledger: Ledger;
  workspace: SessionFiles;
  active: Map<string, { toolName: string; path?: string; recordId: string; agentId?: string; turnId?: string }>;
  currentTurn?: string;
  turns: Map<string, string>;
  /** Tools closed from the native transcript; a late result hook is then not a gap. */
  transcriptFinished: Set<string>;
  /** Tools finished this turn: the transcript may still hold their outcome or their diff. */
  awaiting: Set<string>;
  lastSeen: number;
  lastReconcile: number;
}

/** A session with no event for this long, and no tool running, stops being watched.
 * Its next event continues it. Hooks have no heartbeat, so silence is the only signal. */
const IDLE_MS = 10 * 60_000;
/** A session file unchanged this long, with no record, is a session nobody reported. */
const QUIET_MS = 2 * 60_000;
const SCAN_MS = 10_000;

/** A session linked to one being deleted that is still recording: it may still read it. */
export interface LinkedSession { session: string; harness: string; kind: 'continues' | 'continued-after' | 'cloned' | 'continued-by' | 'cloned-by' }

export interface RemovalPlan { session: string; harness: string; status: string; recording: boolean;
  files: string[]; harnessCopy: string[]; outside: string[]; bytes: number; harnessCopyBytes: number; linked: LinkedSession[];
  /** Its lines in files every session shares (a prompt history). Those in the person's own harness
   * home (`harnessCopy`) go only with the harness's copy. */
  history: { file: string; lines: number; harnessCopy: boolean }[] }

/** Owns session lifecycle. Every harness session inside Wisdom's homes gets one record:
 * from its hooks while they report, and from its own file when they did not.
 */
export class Captures {
  readonly ledgers = new Map<string, Ledger>();
  readonly database: LedgerDatabase;
  private running = new Map<string, RunningCapture>();
  private lastScan = 0;
  /** Handoff IDs already linked to a session, read from the records on first use. */
  private handoffs?: Set<string>;
  /** Session files that name no session (a subagent's or helper's own file), or, in a person's
   * own home, belong to another project. */
  private notSessions = new Set<string>();
  /** This project's session files found in a connected harness's own home. */
  private ownSessionFiles = new Set<string>();
  /** SHA-256 of each session a person deleted: never recorded again, from a hook or a file. */
  private deleted: Set<string>;

  constructor(readonly dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.deleted = new Set(readDeleted(dataDir));
    this.database = new LedgerDatabase(path.join(dataDir, 'ledger.sqlite'));
    try {
      const project = movedFrom(dataDir);
      for (const manifest of this.database.manifests()) {
        const ledger = new Ledger(this.captureDir(manifest), manifest, this.database);
        if (project) this.followProject(ledger, project);
        if (manifest.status === 'recording') {
          manifest.status = 'interrupted'; manifest.endReason = 'daemon-restarted';
          manifest.endedAt = new Date().toISOString(); ledger.saveManifest();
        }
        this.ledgers.set(manifest.captureId, ledger);
      }
      if (project) writeJson(path.join(dataDir, marker), { ...JSON.parse(fs.readFileSync(path.join(dataDir, marker), 'utf8')), project: path.dirname(path.resolve(dataDir)) });
    } catch (error) { this.database.close(); throw error; }
  }

  /** The project folder moved: its sessions are in the new place. What was recorded before
   * still names the old folder, and the gap says so.
   */
  private followProject(ledger: Ledger, from: string): void {
    const here = path.dirname(path.resolve(this.dataDir));
    const moved = (file: string) => {
      const relative = path.relative(from, file);
      return relative.startsWith('..') || path.isAbsolute(relative) ? file : path.join(here, relative);
    };
    const { manifest } = ledger;
    manifest.workspaceRoot = moved(manifest.workspaceRoot);
    if (manifest.source) manifest.source = moved(manifest.source);
    ledger.saveManifest();
    ledger.gap('project-moved', `The project moved from ${from} to ${here}; paths recorded before this point name the old folder.`);
  }

  /** Each harness owns a directory, so one harness's files never mix with another's. */
  captureDir(manifest: Pick<Manifest, 'harness' | 'captureId'>): string {
    return path.join(this.dataDir, 'harnesses', manifest.harness, manifest.captureId);
  }

  private find(harness: string, sessionId: string): Ledger | undefined {
    return [...this.ledgers.values()].find(ledger => ledger.manifest.harness === harness && ledger.manifest.sessionId === sessionId);
  }

  /** The one entry point for hooks and the Pi extension. The session an event names is
   * its record: the first event opens it, an event after a pause continues it. Nothing
   * depends on how the harness was started or how many sessions one process visits.
   */
  route(event: HookEvent): LedgerRecord | undefined {
    const { harness, observation } = event;
    // A deleted session stays deleted, even if its harness goes on (a connected session resumed later).
    if (this.isDeleted(observation.sessionId)) return undefined;
    if (!event.late) this.drainSpool(harness, observation.sessionId);
    let ledger = this.find(harness, observation.sessionId);
    const opened = !ledger;
    if (!ledger || !this.running.has(ledger.manifest.captureId)) {
      // Codex ends every session it opened when it quits; one not being watched has nothing to close.
      if (observation.type === 'session_ended') return undefined;
      ledger = ledger ? this.resume(ledger, event) : this.open({ harness, sessionId: observation.sessionId,
        harnessVersion: event.harnessVersion, workspaceRoot: event.cwd, source: observation.source ?? null }, false, event.late ? undefined : event.cwd);
    }
    if (event.handoff) this.link(ledger, event.handoff, opened ? 'continues' : 'continued-after');
    const id = ledger.manifest.captureId;
    const record = this.observe(id, observation, event);
    if (observation.type === 'session_ended' && this.running.has(id)) {
      const reason = (observation.data as any)?.reason;
      this.close(id, typeof reason === 'string' && reason ? `session-ended: ${reason}` : 'session-ended');
    }
    return record;
  }

  /** The session a `wisdom handoff` started or resumed says which session it continues.
   * One handoff links one session: a /clear or /new later in the same process is not a
   * continuation. Handoffs already linked are read once, so a restart never links twice.
   */
  private link(ledger: Ledger, handoff: Handoff, kind: 'continues' | 'continued-after'): void {
    this.handoffs ??= new Set(this.database.records("type='session_link'").flatMap(record => record.link?.handoffId ?? []));
    if (this.handoffs.has(handoff.id)) return;
    this.handoffs.add(handoff.id);
    const fromHarness = this.ledgers.get(handoff.from)?.manifest.harness;
    ledger.append({ type: 'session_link', link: { kind, from: handoff.from, fromHarness, handoffId: handoff.id },
      summary: `${kind === 'continues' ? 'continues' : 'continued after'} ${handoff.from}${fromHarness ? ` (${fromHarness})` : ''}` });
  }

  /** A session `wisdom clone` made begins with another session's lines. They are linked to the
   * session they happened in, and never counted as this session's turns or file changes.
   */
  private linkClone(ledger: Ledger, clone: CloneNote): void {
    const turns = `${clone.turns} turn${clone.turns === 1 ? '' : 's'}`;
    // The session it was cloned from may have been deleted before this clone first ran.
    if (!clone.from) {
      ledger.append({ type: 'session_link', link: { kind: 'cloned', fromDeleted: true, turns: clone.turns }, summary: `cloned from a deleted session · ${turns}` });
      ledger.gap('history-cloned', `The first ${turns} happened in a deleted session; their file changes were made there, not here.`);
      return;
    }
    ledger.append({ type: 'session_link', link: { kind: 'cloned', from: clone.from, fromHarness: clone.fromHarness, version: clone.version, turns: clone.turns },
      summary: `cloned from ${clone.from} (${clone.fromHarness}) at version ${clone.version} · ${turns}` });
    ledger.gap('history-cloned', `The first ${turns} happened in ${clone.from}; their file changes were made there, not here.`);
  }

  /** One native session is one record, named by the harness's own session ID. A session
   * found only in its file is read from it whole and never watched.
   */
  private open(input: { harness: string; sessionId: string; harnessVersion?: string; workspaceRoot: string; source: string | null }, found = false, cwd?: string): Ledger {
    // A harness can report a relative session path (Pi does with a relative --session-dir).
    // Resolve it against the harness's workspace, never the daemon's working directory.
    input = { ...input, workspaceRoot: path.resolve(input.workspaceRoot),
      source: input.source ? path.resolve(input.workspaceRoot, input.source) : null };
    // A session started in a linked worktree belongs to its project, whichever folder it began in.
    const main = linkedWorktree(input.workspaceRoot)?.main;
    if (main && fs.existsSync(main)) input.workspaceRoot = main;
    if (!/^[A-Za-z0-9_-]+$/.test(input.sessionId)) throw new Error(`Unsupported session ID: ${input.sessionId}`);
    if (this.ledgers.has(input.sessionId)) throw new Error(`Session ${input.sessionId} is already recorded for another harness.`);
    const id = input.sessionId;
    const ignoreFile = path.join(input.workspaceRoot, '.wisdomignore');
    const excludedPaths = fs.existsSync(ignoreFile) ? fs.readFileSync(ignoreFile, 'utf8').split(/\r?\n/)
      .map(line => line.trim().replaceAll('\\', '/').replace(/\/$/, ''))
      .filter(line => line && !line.startsWith('#')) : [];
    if (excludedPaths.some(value => value.includes('*') || value.startsWith('/') || value.split('/').includes('..'))) {
      throw new Error('.wisdomignore accepts relative file/directory paths, without globs or ..');
    }
    // Recorder files must never become evidence of the agent editing its project.
    const dataRelative = path.relative(fs.realpathSync(input.workspaceRoot), this.dataDir).replaceAll('\\', '/');
    if (!dataRelative) throw new Error('The daemon data directory cannot be the tracked workspace root.');
    if (!dataRelative.startsWith('../') && !path.isAbsolute(dataRelative)) excludedPaths.push(dataRelative);
    if (input.source) {
      const sourceRelative = path.relative(fs.realpathSync(input.workspaceRoot), input.source).replaceAll('\\', '/');
      if (sourceRelative && !sourceRelative.startsWith('../') && !path.isAbsolute(sourceRelative)) excludedPaths.push(sourceRelative);
    }
    const now = new Date().toISOString();
    // A found session happened when its file says, not when the scan reached it.
    const file = found && input.source ? fs.statSync(input.source) : undefined;
    const lines = found && input.source ? nativeLines(input.harness, input.source) : undefined;
    const clone = readCloneNote(this.dataDir, input.sessionId);
    const cloned = clone && input.source ? clonedIds(input.harness, input.source, clone.bytes) : new Set<string>();
    const copied = lines ? this.copiedHistory(input.harness, input.source!, lines) : undefined;
    const copiedIds = new Set([...copied?.ids ?? [], ...cloned]);
    const manifest: Manifest = { schemaVersion: 1, captureId: id, ...input,
      workspaceRoot: fs.realpathSync(input.workspaceRoot), status: found ? 'closed' : 'recording',
      startedAt: lines?.dated.find(([id]) => !id || !copiedIds.has(id))?.[1] ?? (file ? new Date(Math.min(file.birthtimeMs, file.mtimeMs)).toISOString() : now),
      ...(found ? { endedAt: file ? file.mtime.toISOString() : now, endReason: 'found-in-session-file' } : {}),
      scope: { ...scope, excludedPaths } };
    const ledger = new Ledger(this.captureDir(manifest), manifest, this.database, true);
    this.ledgers.set(id, ledger);
    if (found) {
      ledger.append({ type: 'capture_started', summary: 'Found in the harness\'s session file; Wisdom did not see this session live.' });
      ledger.gap('not-recorded-live', 'Read from the harness\'s own session file: no hook events and no observed file changes.');
      if (clone) this.linkClone(ledger, clone);
      ledger.copiedEntries = copiedIds;
      const prompts = [...lines!.prompts].filter(id => copied!.ids.has(id)).length;
      if (prompts) ledger.gap('history-from-another-session',
        `${prompts} prompt${prompts === 1 ? '' : 's'} at the start of this file also appear in ${[...copied!.from].join(', ')}, which started earlier; they are that session's turns, not this one's.`);
      this.drain(ledger, true);
      return ledger;
    }
    try {
      this.watch(ledger, cwd);
      ledger.append({ type: 'capture_started', summary: 'Live capture started; file baseline is in memory.' });
      if (clone) { this.linkClone(ledger, clone); ledger.copiedEntries = cloned; }
      if (!input.source && input.harness === 'pi') ledger.gap('native-session-unavailable', 'Pi persistence is disabled; extension observations remain available.');
      if (input.harness === 'codex') ledger.gap('codex-hook-coverage',
        'Hosted/specialized tools may bypass hooks; transcript parsing is best-effort. Subagent tool identity is only available when supplied by Codex.');
      ledger.syncSource();
      return ledger;
    } catch (error) {
      this.degrade(id, error); throw error;
    }
  }

  /** Continue a record that was not being watched: after /resume, a pause, a restart or a
   * failure. Lines the harness wrote meanwhile are read from its file, prompts included,
   * unless the events that cover them are arriving from the spool.
   */
  private resume(ledger: Ledger, event: HookEvent): Ledger {
    const { manifest } = ledger;
    const ended = manifest.endedAt;
    manifest.status = 'recording'; manifest.harnessVersion = event.harnessVersion ?? manifest.harnessVersion;
    delete manifest.endedAt; delete manifest.endReason;
    ledger.saveManifest();
    try {
      if (event.observation.source) this.followSource(ledger, event.observation.source);
      if (!event.late) this.drain(ledger, true, promptLine(event.observation));
      this.watch(ledger, event.late ? undefined : event.cwd);
      this.restoreTurns(this.running.get(manifest.captureId)!);
      ledger.append({ type: 'capture_started', summary: 'Capture resumed; file baseline is in memory.' });
      ledger.gap('not-recording-between-visits', `File changes from ${ended ?? 'the last visit'} until this resume were not observed.`);
      return ledger;
    } catch (error) {
      this.degrade(manifest.captureId, error); throw error;
    }
  }

  /** A fork's file starts with its parent's lines, under the same IDs. A line an older
   * session file also holds is that session's, so its prompts are not this session's turns.
   */
  private copiedHistory(harness: string, source: string, own: NativeLines): { ids: Set<string>; from: Set<string> } {
    const ids = new Set<string>(), from = new Set<string>();
    const candidates = [...adapter(harness).sessionFiles(path.join(this.dataDir, 'harnesses', harness, 'home')), ...this.ownSessionFiles];
    for (const other of candidates) {
      if (path.resolve(other) === path.resolve(source)) continue;
      const lines = nativeLines(harness, other);
      if (!isOlder(lines, own)) continue;
      for (const id of own.ids) if (lines.ids.has(id)) { ids.add(id); if (lines.sessionId) from.add(lines.sessionId); }
    }
    return { ids, from };
  }

  /** Copy the whole backlog, each read bounded. */
  private drain(ledger: Ledger, prompts = false, stopBefore?: (entry: NativeEntry) => boolean): void {
    let previous = -1;
    while (previous !== ledger.lastSeq) { previous = ledger.lastSeq; ledger.syncSource(stopBefore, prompts); }
  }

  private watch(ledger: Ledger, cwd?: string): void {
    this.running.set(ledger.manifest.captureId, { ledger, workspace: new SessionFiles(ledger, cwd), active: new Map(), turns: new Map(),
      transcriptFinished: new Set(), awaiting: new Set(), lastSeen: Date.now(), lastReconcile: Date.now() });
  }

  /** The turns a record already has, so a session continuing after a restart keeps its
   * events in the turn they belong to. A settled turn is not reopened.
   */
  private restoreTurns(capture: RunningCapture): void {
    const rows = this.database.records("capture_id=? AND type IN ('input','agent_settled')", [capture.ledger.manifest.captureId], 'ORDER BY seq');
    for (const row of rows) if (row.type === 'input' && row.turnId) capture.turns.set(`${row.agentId ?? ''}:${row.turnId}`, row.id);
    const last = rows.at(-1);
    if (last?.type === 'input') capture.currentTurn = last.id;
  }

  get(id: string): Ledger {
    const ledger = this.ledgers.get(id);
    if (!ledger) throw new Error(`No recorded session has the ID ${id}. Use the full session ID; glance lists them.`);
    return ledger;
  }

  /** A harness may name a new file for the same session (Claude Code moves it into a
   * worktree's project folder). The copy follows; the file check still applies.
   */
  private followSource(ledger: Ledger, reported: string): void {
    const source = path.resolve(ledger.manifest.workspaceRoot, reported);
    if (!ledger.manifest.source) this.attachSource(ledger, { source });
    else if (source !== ledger.manifest.source) ledger.moveSource(source);
  }

  observe(id: string, observation: Observation, context: { cwd?: string; late?: { spooledAt: string } } = {}): LedgerRecord | undefined {
    const capture = this.running.get(id);
    if (!capture) throw new Error(`Session ${id} is not being recorded.`);
    capture.lastSeen = Date.now();
    const { ledger, workspace, active } = capture;
    if (ledger.hasObservation(observation.observationId)) return undefined;
    const data = observation.data as any;
    const harness = adapter(ledger.manifest.harness);
    // A spooled event arrives after its moment: the files no longer show what it saw.
    const live = !context.late;
    try {
      if (observation.source) this.followSource(ledger, observation.source);
      if (live && context.cwd) workspace.follow(context.cwd);
      // A worktree outside the project folder is watched, so it is not outside.
      if (context.cwd && outside(ledger.manifest.workspaceRoot, context.cwd) && !linkedWorktree(context.cwd)) {
        ledger.gap('outside-watched-folder', `The harness worked in ${context.cwd}; only ${ledger.manifest.workspaceRoot} is watched for file changes.`);
      }
      if (context.late) ledger.gap('delivered-late', 'Events kept while the daemon was down were recorded when it came back; file changes in that time were not observed.');
      // Transcript lines written before this event belong before it: mirror them first,
      // so a reply is linked to the request it answered, not to the next prompt. A
      // harness may write the new prompt itself first; that copy belongs to the new input.
      ledger.syncSource(promptLine(observation));
      // Claude Code's own helper agents (prompt suggestions, recaps) stop without a
      // type or transcript. They are recorded, but they are not task subagents.
      const internalAgent = observation.type === 'subagent_stopped' && !data?.agentType && ledger.manifest.harness === 'claude-code';
      if (observation.type === 'subagent_stopped' && !internalAgent) this.copySubagentTranscript(ledger, observation.agentId, data?.transcriptPath);
      if (observation.type === 'tool_started') {
        if (!observation.toolCallId || !observation.toolName) throw new Error('Tool start requires toolCallId and toolName');
        if (live) {
          workspace.flush(active.size ? { toolCallId: [...active.keys()][0], activeToolCallIds: [...active.keys()] } : {});
          // Explicit file targets are inspected synchronously before the hook returns.
          const target = harness.toolTarget(observation.toolName, data?.input);
          if (target) workspace.observe(target, active.size ? { toolCallId: [...active.keys()][0], activeToolCallIds: [...active.keys()] } : {});
        }
      }
      const { data: payload, sessionId: _sessionId, source: _source, harnessEvent, ...metadata } = observation;
      const turnKey = `${observation.agentId ?? ''}:${observation.turnId}`;
      // A start recorded before a daemon restart is no longer in memory, but it is recorded.
      const started = observation.type === 'tool_finished' && observation.toolCallId
        ? active.get(observation.toolCallId)?.recordId ?? ledger.findToolStart(observation.toolCallId)?.id : undefined;
      const record = ledger.append({ ...metadata, spooledAt: context.late?.spooledAt,
        // A result hook may not say how it went; what ran may already be in the transcript.
        isError: observation.type === 'tool_finished' && observation.toolCallId ? observation.isError ?? this.nativeOutcome(ledger, observation.toolCallId) : observation.isError,
        notice: observation.type === 'input' && typeof data?.text === 'string' && harness.isNotice(data.text) || undefined,
        role: observation.type === 'message' && typeof data?.role === 'string' ? data.role : undefined,
        // A result belongs to its original start even if another input arrived
        // while it ran. Do not move a long-running tool to the newest request.
        parentId: started
          ?? (observation.parentToolCallId ? active.get(observation.parentToolCallId)?.recordId
          : observation.turnId ? capture.turns.get(turnKey) : capture.currentTurn),
        dataRef: payload === undefined ? undefined : ledger.payload(payload),
        internalAgent: internalAgent || undefined,
        summary: observation.type === 'input' ? preview(data?.text)
          : observation.type === 'message' ? preview(data?.content)
          // The final reply of a turn or subagent, as the harness reported it.
          : ['agent_settled', 'subagent_stopped'].includes(observation.type) && typeof data?.lastAssistantMessage === 'string' && data.lastAssistantMessage
            ? preview(data.lastAssistantMessage)
          : `${observation.type}${observation.toolName ? ': ' + observation.toolName : ''}${observation.isError ? ' (error)' : ''}`
      });
      if (harnessEvent !== undefined) ledger.append({ type: 'harness_event', summary: `harness_event: ${observation.type}`,
        turnId: observation.turnId, agentId: observation.agentId, parentId: record.id, dataRef: ledger.payload(harnessEvent) });
      if (observation.type === 'input') capture.currentTurn = record.id;
      if (observation.type === 'input' && observation.turnId) capture.turns.set(turnKey, record.id);
      if (observation.type === 'tool_started') active.set(observation.toolCallId!, {
        toolName: observation.toolName!, path: harness.toolTarget(observation.toolName!, data?.input),
        recordId: record.id, agentId: observation.agentId, turnId: observation.turnId
      });
      if (observation.type === 'tool_finished') {
        if (!started) {
          ledger.gap('missing-tool-start', observation.toolCallId ?? 'unknown');
        }
        if (observation.toolCallId) capture.awaiting.add(observation.toolCallId);
        if (live) this.settleTool(capture, observation.toolCallId!);
        else active.delete(observation.toolCallId!);
      }
      if (observation.type === 'agent_settled') {
        this.finishFromTranscript(capture);
        if (active.size) ledger.gap('unfinished-tools-at-settle', [...active.keys()].join(','));
        if (live) workspace.flush();
      }
      ledger.syncSource();
      return record;
    } catch (error) { this.degrade(id, error); throw error; }
  }

  /** Attribute a finished tool's file effects, then stop treating it as running. */
  private settleTool(capture: RunningCapture, toolCallId: string): void {
    const { workspace, active, ledger } = capture;
    const call = active.get(toolCallId);
    const context = { toolCallId, activeToolCallIds: [...active.keys()] };
    if (call?.path) workspace.observe(call.path, context);
    // Shell/custom tools may write anywhere inside scope. A bounded scan is
    // the correctness fallback; direct read/edit/write calls avoid it.
    if (!call || !adapter(ledger.manifest.harness).isDirectFileTool(call.toolName)) workspace.reconcile(context);
    else workspace.flush(context);
    active.delete(toolCallId);
  }

  /** Some harnesses skip a result hook (Codex apply_patch). When the turn ends, a
   * tool whose result is in the native transcript is finished from that evidence.
   * Only at turn end: parallel calls can show a result before their own hook runs.
   */
  private finishFromTranscript(capture: RunningCapture): void {
    const { ledger, active, awaiting } = capture;
    if (!active.size && !awaiting.size) return;
    ledger.syncSource();
    for (const [toolCallId, call] of [...active]) {
      const result = this.database.records("capture_id=? AND type='source_record' AND role='toolResult' AND tool_call_id=?",
        [ledger.manifest.captureId, toolCallId], 'ORDER BY seq LIMIT 1')[0];
      if (!result) continue;
      // The result belongs to the same agent and turn as its call.
      ledger.append({ type: 'tool_finished', toolCallId, toolName: call.toolName, parentId: call.recordId,
        agentId: call.agentId, turnId: call.turnId, isError: result.isError, resultBasis: 'native-transcript', sourceEntryId: result.sourceEntryId,
        summary: `tool_finished: ${call.toolName} (result from native transcript; no result hook)` });
      capture.transcriptFinished.add(toolCallId);
      awaiting.add(toolCallId);
      this.settleTool(capture, toolCallId);
    }
    for (const toolCallId of awaiting) {
      const start = ledger.findToolStart(toolCallId);
      const finishes = this.database.records("capture_id=? AND type='tool_finished' AND tool_call_id=?", [ledger.manifest.captureId, toolCallId], 'ORDER BY seq');
      const outcome = this.nativeOutcome(ledger, toolCallId);
      if (outcome !== undefined && start && !finishes.some(r => typeof r.isError === 'boolean')) {
        ledger.append({ type: 'tool_finished', toolCallId, toolName: start.toolName, parentId: start.id, agentId: start.agentId, turnId: start.turnId,
          isError: outcome, resultBasis: 'native-transcript', summary: `tool_finished: ${start.toolName} (outcome from native transcript)` });
      }
      if (start) this.recordReportedChanges(capture, toolCallId, start);
    }
    awaiting.clear();
  }

  /** How the transcript says a tool ended, when it says. */
  private nativeOutcome(ledger: Ledger, toolCallId: string): boolean | undefined {
    return this.database.records("capture_id=? AND type='source_record' AND role='toolResult' AND tool_call_id=?", [ledger.manifest.captureId, toolCallId], 'ORDER BY seq')
      .find(r => typeof r.isError === 'boolean')?.isError;
  }

  /** A file the harness says this tool changed, with no observed change to show for it (the
   * daemon was down, or the baseline came after). Its report is kept, and says whose it is.
   */
  private recordReportedChanges(capture: RunningCapture, toolCallId: string, start: LedgerRecord): void {
    const { ledger } = capture;
    const { manifest } = ledger;
    const harness = adapter(manifest.harness);
    const seen = new Set(this.database.records("capture_id=? AND type='file_change' AND seq>=?", [manifest.captureId, start.seq], 'ORDER BY seq').map(r => `${r.worktree ?? ''}:${r.path}`));
    for (const result of this.database.records("capture_id=? AND type='source_record' AND role='toolResult' AND tool_call_id=?", [manifest.captureId, toolCallId], 'ORDER BY seq')) {
      let raw: unknown;
      try { raw = JSON.parse(ledger.readSource(result)); } catch { continue; }
      for (const change of harness.nativeChanges(raw)) {
        const file = path.resolve(manifest.workspaceRoot, change.path);
        const tree = linkedWorktree(path.dirname(file));
        const relative = path.relative(tree?.root ?? manifest.workspaceRoot, file).replaceAll('\\', '/');
        const shown = relative.startsWith('../') || path.isAbsolute(relative) ? file : relative;
        if (seen.has(`${tree?.name ?? ''}:${shown}`) || isExcluded(manifest, shown)) continue;
        const patch = change.diff !== undefined ? `--- ${shown}\n+++ ${shown}\n${change.diff}`
          : change.content !== undefined ? createTwoFilesPatch(change.operation === 'create' ? '/dev/null' : shown, change.operation === 'delete' ? '/dev/null' : shown,
            change.operation === 'create' ? '' : change.content, change.operation === 'create' ? change.content : '', '', '', { context: 3 }) : undefined;
        ledger.append({ type: 'file_change', path: shown, operation: change.operation, summary: `${change.operation}: ${shown}`,
          parentId: start.id, toolCallId, attribution: 'reported-by-harness', worktree: tree?.name, branch: tree ? worktreeBranch(tree) : undefined,
          patchRef: patch === undefined ? undefined : ledger.payload(patch), patchUnavailable: patch === undefined ? 'not-reported' : undefined });
      }
    }
  }

  poll(): void {
    this.drainSpool();
    for (const [id, capture] of this.running) {
      try {
        if (!capture.active.size && Date.now() - capture.lastSeen > IDLE_MS) { this.close(id, 'idle'); continue; }
        capture.ledger.syncSource();
        if (!capture.active.size) {
          capture.workspace.flush();
          if (Date.now() - capture.lastReconcile > 30000) {
            capture.workspace.reconcile({}); capture.lastReconcile = Date.now();
          }
        }
      } catch (error) { this.degrade(id, error); }
    }
    if (Date.now() - this.lastScan > SCAN_MS) { this.lastScan = Date.now(); this.scan(); }
  }

  /** Events a hook kept while the daemon was down, in the order they were kept. One
   * session's events are recorded before any newer event of that session.
   */
  drainSpool(harness?: string, sessionId?: string): void {
    const root = spoolDir(this.dataDir);
    const folders = harness && sessionId ? [path.join(root, harness, sessionId)]
      : listDirs(root).flatMap(h => listDirs(path.join(root, h)).map(s => path.join(root, h, s)));
    for (const folder of folders) {
      let names: string[];
      try { names = fs.readdirSync(folder).filter(name => name.endsWith('.json')).sort(); } catch { continue; }
      for (const name of names) {
        const file = path.join(folder, name);
        try {
          const event = hookSchema.parse(JSON.parse(fs.readFileSync(file, 'utf8')));
          if (!event.late) throw new Error('A spooled event must say when it was kept.');
          this.route(event);
          fs.rmSync(file);
        } catch (error) {
          // Kept beside the spool for a person to read; never retried in a loop.
          console.error(`Spooled event ${file} could not be recorded: ${String(error)}`);
          try { fs.renameSync(file, file + '.failed'); } catch { /* already moved */ }
        }
      }
      for (const empty of [folder, path.dirname(folder)]) try { fs.rmdirSync(empty); } catch { /* not empty, or gone */ }
    }
  }

  /** The homes whose session files belong here: each harness's home in Wisdom's folder, and, for
   * a harness `wisdom connect` connected, the person's own home from the moment it was connected.
   * That home holds every project's sessions, so there only this project's are taken.
   */
  private homes(): { harness: string; home: string; since?: number }[] {
    const connected = readConnected(this.dataDir);
    return harnessNames.flatMap(harness => {
      const own = connected[harness];
      return [{ harness, home: path.join(this.dataDir, 'harnesses', harness, 'home') }, ...own ? [{ harness, home: own.home, since: Date.parse(own.since) }] : []];
    });
  }

  /** Whether a session that ran in `cwd` worked in this project, or in one of its worktrees. */
  private inProject(cwd: string | undefined): boolean {
    if (!cwd) return false;
    const project = path.dirname(path.resolve(this.dataDir));
    const relative = path.relative(project, linkedWorktree(cwd)?.main ?? cwd);
    return !relative.startsWith('..') && !path.isAbsolute(relative);
  }

  /** The safety net: every session file in Wisdom's homes, and this project's in a connected
   * harness's own home, gets a record, whether or not its hooks ran. A quiet file with no record
   * is read whole; lines a session gained while nothing was recording are read when it goes quiet again.
   */
  scan(): void {
    const bySource = new Map([...this.ledgers.values()].filter(l => l.manifest.source).map(l => [l.manifest.source!, l]));
    for (const { harness, home, since } of this.homes()) {
      if (!fs.existsSync(home)) continue;
      for (const file of adapter(harness).sessionFiles(home)) {
        try {
          if (this.notSessions.has(file)) continue;
          const stat = fs.statSync(file);
          // Sessions from before the harness was connected are not this record's to take.
          if (since !== undefined && stat.mtimeMs < since) continue;
          if (Date.now() - stat.mtimeMs < QUIET_MS) continue;
          const known = bySource.get(file);
          if (known) {
            // Recorded here, so this project's: a later fork in this home may start with its lines.
            if (since !== undefined) this.ownSessionFiles.add(file);
            if (this.running.has(known.manifest.captureId) || stat.size <= known.sourcePosition) continue;
            known.gap('not-recorded-live', 'Lines the session file gained while nothing was recording were read from it; no hooks reported them.');
            this.drain(known, true);
            continue;
          }
          const { sessionId, cwd } = header(harness, file);
          if (!sessionId || this.isDeleted(sessionId)) { this.notSessions.add(file); continue; }
          if (since !== undefined) {
            // Another project's session in the person's own home: never read again.
            if (!this.inProject(cwd)) { this.notSessions.add(file); continue; }
            this.ownSessionFiles.add(file);
          }
          // A record that copies another file of this session (a moved file) is left as it is.
          if (this.find(harness, sessionId)) { this.notSessions.add(file); continue; }
          const workspaceRoot = cwd && fs.existsSync(cwd) ? cwd : path.dirname(this.dataDir);
          this.open({ harness, sessionId, workspaceRoot, source: file }, true);
        } catch (error) {
          this.notSessions.add(file);
          console.error(`Session file ${file} could not be read: ${String(error)}`);
        }
      }
    }
  }

  isDeleted(sessionId: string): boolean { return this.deleted.has(hash(sessionId)); }

  /** A person deletes a session: its record, its evidence folder, and its files in this
   * project's harness homes. A connected session's files in the person's own harness home
   * were made for this project too, but deleting them also ends the harness's own resume,
   * so they go only when asked (`harnessCopy`); otherwise they are listed as `kept`. Nothing
   * else outside the data folder is touched. A session still recording is refused. Its ID is
   * remembered only as a hash, so it is never recorded again.
   */
  remove(id: string, options: { harnessCopy?: boolean } = {}): { session: string; removed: string[]; kept: string[] } {
    const plan = this.removal(id);
    if (plan.recording) throw new Error(`Session ${id} is still recording; it can be deleted once it ends.`);
    const allowed = new Set([...plan.files, ...options.harnessCopy ? plan.harnessCopy : []]);
    const targets = [...plan.files, ...plan.harnessCopy, ...plan.outside];
    // Remembered first, so a scan between the steps below cannot record it again.
    this.deleted.add(hash(id));
    writeJson(deletedFile(this.dataDir), [...this.deleted].sort());
    this.database.forget(id);
    this.ledgers.delete(id);
    // A clone of it not yet recorded still links to it, as a deleted session.
    const clones = path.join(this.dataDir, 'clones');
    for (const name of fs.existsSync(clones) ? fs.readdirSync(clones).filter(name => name.endsWith('.json')) : []) {
      const file = path.join(clones, name);
      try {
        const note = JSON.parse(fs.readFileSync(file, 'utf8')) as CloneNote;
        if (note.from === id) { const { from: _from, ...rest } = note; writeJson(file, rest); }
      } catch { /* not a note */ }
    }
    const removed: string[] = [], kept: string[] = [];
    const reason = (error: unknown) => error instanceof Error ? error.message : String(error);
    for (const target of targets) {
      if (!allowed.has(target)) { kept.push(target); continue; }
      try { fs.rmSync(target, { recursive: true, force: true }); removed.push(target); }
      catch (error) { kept.push(`${target} (${reason(error)})`); }
    }
    const reader = adapter(plan.harness);
    for (const { file, lines, harnessCopy } of plan.history) {
      const label = `${file} (${lines} line${lines === 1 ? '' : 's'} of this session)`;
      if (harnessCopy && !options.harnessCopy) { kept.push(label); continue; }
      const sessionOf = reader.sharedHistory(path.dirname(file)).find(shared => shared.file === file)!.session;
      try { const taken = dropLines(file, line => sessionOf(line) === id); removed.push(`${file} (${taken} line${taken === 1 ? '' : 's'} of this session)`); }
      catch (error) { kept.push(`${label}: ${reason(error)}`); }
    }
    return { session: id, removed, kept };
  }

  /** Where this project's disk space goes: the database, each session's evidence folder, and each
   * harness home in `.wisdom` (its settings, login and the harness's own session files). */
  storage(): { total: number; database: number; sessions: { session: string; harness: string; bytes: number }[];
    homes: { harness: string; bytes: number }[]; other: number } {
    const database = ['ledger.sqlite', 'ledger.sqlite-wal', 'ledger.sqlite-shm'].reduce((sum, name) => sum + size(path.join(this.dataDir, name)), 0);
    const sessions = [...this.ledgers.values()].map(ledger => ({ session: ledger.manifest.captureId, harness: ledger.manifest.harness, bytes: size(ledger.dir) }))
      .sort((a, b) => b.bytes - a.bytes);
    const homes = harnessNames.map(harness => ({ harness, bytes: size(harnessHome(this.dataDir, harness)) })).filter(home => home.bytes > 0);
    const total = size(this.dataDir);
    const counted = database + sessions.reduce((sum, s) => sum + s.bytes, 0) + homes.reduce((sum, h) => sum + h.bytes, 0);
    return { total, database, sessions, homes, other: Math.max(0, total - counted) };
  }

  /** What deleting a session would do, for a person to read before confirming: the files that
   * go (`files`), a connected session's files in the person's own harness home that go only
   * when asked (`harnessCopy`), files that stay whatever is chosen (`outside`), their size, and
   * the sessions linked to it that are still recording, which may still read it.
   */
  removal(id: string): RemovalPlan {
    const ledger = this.get(id);
    const { harness, source, status } = ledger.manifest;
    const reader = adapter(harness);
    const connectedHome = readConnected(this.dataDir)[harness as keyof Connected]?.home;
    const targets = [...new Set([ledger.dir, cloneNote(this.dataDir, id), path.join(spoolDir(this.dataDir), harness, id),
      ...source ? [source] : [], ...reader.sessionTraces(harnessHome(this.dataDir, harness), id),
      ...connectedHome ? reader.sessionTraces(connectedHome, id) : []])].filter(target => fs.existsSync(target));
    // Outside the data folder, only what is in the connected home, and a transcript only when
    // its own lines say it is this session: a wrong path in a record never deletes another file.
    const ours = (target: string) => !!connectedHome && inside(connectedHome, target)
      && (target !== source || header(harness, target).sessionId === id);
    const files = targets.filter(target => inside(this.dataDir, target));
    const harnessCopy = targets.filter(target => !files.includes(target) && ours(target));
    const outside = targets.filter(target => !files.includes(target) && !harnessCopy.includes(target));
    const linked = new Map<string, LinkedSession>();
    const note = (other: string, kind: LinkedSession['kind']) => {
      const manifest = this.ledgers.get(other)?.manifest;
      if (manifest && other !== id && this.running.has(other)) linked.set(other, { session: other, harness: manifest.harness, kind });
    };
    for (const record of this.database.records("type='session_link' AND json_extract(body,'$.link.from')=?", [id])) {
      note(record.captureId, record.link!.kind === 'cloned' ? 'cloned-by' : 'continued-by');
    }
    for (const record of this.database.records("type='session_link' AND capture_id=?", [id])) {
      if (record.link?.from) note(record.link.from, record.link.kind);
    }
    const homes = [{ home: harnessHome(this.dataDir, harness), harnessCopy: false }, ...connectedHome ? [{ home: connectedHome, harnessCopy: true }] : []];
    const history = homes.flatMap(({ home, harnessCopy }) => reader.sharedHistory(home)
      .map(({ file, session }) => ({ file, lines: countLines(file, line => session(line) === id), harnessCopy })))
      .filter(entry => entry.lines > 0);
    return { session: id, harness, status, recording: this.running.has(id), files, harnessCopy, outside,
      bytes: files.reduce((sum, file) => sum + size(file), 0), harnessCopyBytes: harnessCopy.reduce((sum, file) => sum + size(file), 0),
      linked: [...linked.values()], history };
  }

  close(id: string, reason = 'quit', interrupted = false): void {
    const capture = this.running.get(id);
    if (!capture) return;
    const { ledger, workspace, active } = capture;
    try {
      if (ledger.manifest.harness === 'codex' && (!ledger.manifest.source || !fs.existsSync(ledger.manifest.source))) {
        ledger.gap('native-session-unavailable', 'Codex transcript unavailable; hook evidence remains available.');
      }
      this.drain(ledger);
      this.finishFromTranscript(capture);
      workspace.reconcile(active.size ? { toolCallId: [...active.keys()][0], activeToolCallIds: [...active.keys()] } : {});
      ledger.append({ type: 'capture_closed', summary: reason,
        dataRef: ledger.payload({ pendingToolCallIds: [...active.keys()] }) });
      if (ledger.manifest.source && fs.existsSync(ledger.manifest.source)) {
        const originalBytes = fs.statSync(ledger.manifest.source).size;
        const copiedBytes = ledger.sourcePosition;
        if (originalBytes !== copiedBytes) ledger.gap('source-copy-incomplete', `Source has ${originalBytes} bytes; ${copiedBytes} were read.`);
      }
      ledger.manifest.status = interrupted || active.size > 0 ? 'interrupted' : 'closed';
      ledger.manifest.endedAt = new Date().toISOString(); ledger.manifest.endReason = reason;
      ledger.saveManifest();
    } finally { workspace.close(); this.running.delete(id); }
  }

  /** A harness may only create its transcript after its first hook (Claude Code). */
  private attachSource(ledger: Ledger, data: any): void {
    const source = typeof data?.source === 'string' ? path.resolve(ledger.manifest.workspaceRoot, data.source) : undefined;
    if (source && !ledger.manifest.source) {
      ledger.manifest.source = source;
      const relative = path.relative(ledger.manifest.workspaceRoot, source).replaceAll('\\', '/');
      if (relative && !relative.startsWith('../') && !path.isAbsolute(relative)) ledger.manifest.scope.excludedPaths.push(relative);
    }
    ledger.saveManifest();
  }

  /** Subagent transcripts are complete when the subagent stops; keep one byte copy each. */
  private copySubagentTranscript(ledger: Ledger, agentId: string | undefined, transcript: unknown): void {
    if (!agentId || !/^[A-Za-z0-9_-]+$/.test(agentId) || typeof transcript !== 'string') return;
    if (!fs.existsSync(transcript)) { ledger.gap('subagent-transcript-missing', agentId); return; }
    fs.mkdirSync(path.join(ledger.dir, 'subagents'), { recursive: true });
    const copy = path.join(ledger.dir, 'subagents', `agent-${agentId}.jsonl`);
    fs.copyFileSync(transcript, copy);
    // Subagents spend tokens in their own transcript; index that usage under their ID.
    const harness = adapter(ledger.manifest.harness);
    let model: string | undefined;
    for (const line of fs.readFileSync(copy, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const entry = harness.nativeEntry(JSON.parse(line));
        if (entry.model) model = entry.model;
        ledger.recordUsage(entry, { agentId, sourceModel: model, sourceEntryId: entry.id, sourceTimestamp: entry.timestamp });
      } catch { ledger.gap('malformed-subagent-record', agentId); }
    }
  }

  /** One failure stops watching this session; its next event continues it with a gap. */
  private degrade(id: string, error: unknown): void {
    const ledger = this.ledgers.get(id);
    if (ledger) {
      ledger.manifest.status = 'degraded'; ledger.manifest.endReason = String(error);
      ledger.manifest.endedAt = new Date().toISOString();
      try { ledger.saveManifest(); ledger.gap('capture-error', String(error)); } catch { /* Disk failure may prevent recording itself. */ }
    }
    this.running.get(id)?.workspace.close(); this.running.delete(id);
    console.error(`Capture ${id} stopped: ${String(error)}`);
  }

  shutdown(): void {
    for (const id of [...this.running.keys()]) {
      try { this.close(id, 'daemon-stopped', true); } catch (error) { this.degrade(id, error); }
    }
  }
}

/** For an input event: the native line holding that prompt, which belongs to the input. */
function promptLine(observation: Observation): ((entry: NativeEntry) => boolean) | undefined {
  const data = observation.data as any;
  const prompt = observation.type === 'input' && typeof data?.text === 'string' ? data.text.trim() : '';
  return prompt ? entry => entry.messages.some(message => message.role === 'user' && surfaceText(message).trim().includes(prompt)) : undefined;
}

/** Paths Wisdom does not record, whoever reports them. */
function isExcluded(manifest: Manifest, file: string): boolean {
  const parts = file.split('/');
  return parts.some(part => manifest.scope.excludedDirectories.includes(part))
    || manifest.scope.excludedPaths.some(prefix => file === prefix || file.startsWith(prefix + '/'));
}

function outside(root: string, folder: string): boolean {
  let real: string;
  try { real = fs.realpathSync(folder); } catch { real = path.resolve(folder); }
  const relative = path.relative(root, real);
  return relative.startsWith('..') || path.isAbsolute(relative);
}

interface NativeLines { ids: Set<string>; prompts: Set<string>; dated: [string | undefined, string][]; forkedFrom: Set<string>; created: number; sessionId?: string }

/** Which of two session files holding the same lines wrote them first. A fork may say so;
 * otherwise the earlier first line; files that start with the same line, by when each was made.
 */
function isOlder(a: NativeLines, b: NativeLines): boolean {
  if (a.sessionId && b.forkedFrom.has(a.sessionId)) return true;
  if (b.sessionId && a.forkedFrom.has(b.sessionId)) return false;
  const [first, second] = [a.dated[0]?.[1], b.dated[0]?.[1]];
  if (!first || !second) return false;
  return first === second ? a.created < b.created : first < second;
}

/** Hashes of deleted sessions' IDs: enough to refuse them, not to say what they were. */
function deletedFile(dataDir: string): string {
  return path.join(dataDir, 'deleted.json');
}

function readDeleted(dataDir: string): string[] {
  try { const list = JSON.parse(fs.readFileSync(deletedFile(dataDir), 'utf8')); return Array.isArray(list) ? list.map(String) : []; }
  catch { return []; }
}

/** JSON lines of a shared file that `mine` claims; a line that is not JSON is never claimed. */
function countLines(file: string, mine: (entry: any) => boolean): number {
  let text: string;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return 0; }
  return text.split('\n').filter(line => claims(line, mine)).length;
}

function claims(line: string, mine: (entry: any) => boolean): boolean {
  try { return mine(JSON.parse(line)); } catch { return false; }
}

/** Take a session's lines out of a file its harness shares between sessions, keeping every other
 * byte. The harness may add a line meanwhile, so the file is rewritten only if it did not change
 * while it was read; otherwise it is read again (three tries, then it is left as it was).
 */
function dropLines(file: string, mine: (entry: any) => boolean): number {
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = fs.statSync(file);
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    const kept = lines.filter(line => !claims(line, mine));
    const taken = lines.length - kept.length;
    if (!taken) return 0;
    const temporary = `${file}.wisdom-${process.pid}.tmp`;
    fs.writeFileSync(temporary, kept.join('\n'));
    const now = fs.statSync(file);
    if (now.size !== before.size || now.mtimeMs !== before.mtimeMs) { fs.rmSync(temporary, { force: true }); continue; }
    fs.renameSync(temporary, file);
    return taken;
  }
  throw new Error('the harness kept writing to it; try again when it is idle');
}

/** Bytes in a file, or in every file below a folder. */
function size(target: string): number {
  try {
    const stat = fs.statSync(target);
    if (!stat.isDirectory()) return stat.size;
    return fs.readdirSync(target).reduce((sum, name) => sum + size(path.join(target, name)), 0);
  } catch { return 0; }
}

/** Whether `file` is inside `folder` (and is not the folder itself). */
function inside(folder: string, file: string): boolean {
  const relative = path.relative(path.resolve(folder), path.resolve(file));
  return !!relative && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function readCloneNote(dataDir: string, sessionId: string): CloneNote | undefined {
  try { return JSON.parse(fs.readFileSync(cloneNote(dataDir, sessionId), 'utf8')); } catch { return undefined; }
}

/** The line IDs in the first `bytes` of a cloned transcript: the copied history. */
function clonedIds(harness: string, file: string, bytes: number): Set<string> {
  const ids = new Set<string>();
  let text: string;
  try { text = fs.readFileSync(file).subarray(0, bytes).toString('utf8'); } catch { return ids; }
  for (const line of text.split('\n')) {
    try { const id = adapter(harness).nativeEntry(JSON.parse(line)).id; if (id) ids.add(id); } catch { /* not a JSON line */ }
  }
  return ids;
}

/** What a found session's file says about itself: its line IDs, their dates and what it was forked from. */
function nativeLines(harness: string, file: string): NativeLines {
  const reader = adapter(harness);
  const result: NativeLines = { ids: new Set(), prompts: new Set(), dated: [], forkedFrom: new Set(), created: 0 };
  let text: string;
  try { text = fs.readFileSync(file, 'utf8'); result.created = fs.statSync(file).birthtimeMs; } catch { return result; }
  for (const line of text.split('\n')) {
    let raw: any;
    try { raw = JSON.parse(line); } catch { continue; }
    const entry = reader.nativeEntry(raw);
    result.sessionId ??= reader.nativeSession(raw);
    if (entry.timestamp) result.dated.push([entry.id, entry.timestamp]);
    const parent = reader.nativeForkedFrom(raw);
    if (parent) result.forkedFrom.add(parent);
    if (entry.id) { result.ids.add(entry.id); if (reader.nativePrompt(raw)) result.prompts.add(entry.id); }
  }
  return result;
}

function listDirs(dir: string): string[] {
  try { return fs.readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name); } catch { return []; }
}

/** The session and folder a native file names in its first lines. */
function header(harness: string, file: string): { sessionId?: string; cwd?: string } {
  const fd = fs.openSync(file, 'r');
  let text: string;
  try {
    const bytes = Buffer.alloc(Math.min(fs.fstatSync(fd).size, 256 * 1024));
    text = bytes.subarray(0, fs.readSync(fd, bytes, 0, bytes.length, 0)).toString('utf8');
  } finally { fs.closeSync(fd); }
  const reader = adapter(harness);
  let sessionId: string | undefined, cwd: string | undefined;
  for (const line of text.split('\n').slice(0, 50)) {
    let entry: any;
    try { entry = JSON.parse(line); } catch { continue; }
    sessionId ??= reader.nativeSession(entry);
    cwd ??= reader.nativeCwd(entry);
    if (sessionId && cwd) break;
  }
  return { sessionId, cwd };
}
