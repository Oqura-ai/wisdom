import fs from 'node:fs';
import path from 'node:path';
import { Ledger, writeJson } from './ledger.js';
import { LedgerDatabase } from './database.js';
import { SessionFiles, scope } from './workspace.js';
import { hookSchema, preview, type HookEvent, type Observation, type Manifest, type LedgerRecord } from './schema.js';
import { adapter, harnessNames } from './harnesses/index.js';
import type { NativeEntry } from './harnesses/types.js';
import { surfaceText } from './content.js';
import { linkedWorktree, marker, movedFrom, spoolDir } from './paths.js';

interface RunningCapture {
  ledger: Ledger;
  workspace: SessionFiles;
  active: Map<string, { toolName: string; path?: string; recordId: string; agentId?: string; turnId?: string }>;
  currentTurn?: string;
  turns: Map<string, string>;
  /** Tools closed from the native transcript; a late result hook is then not a gap. */
  transcriptFinished: Set<string>;
  lastSeen: number;
  lastReconcile: number;
}

/** A session with no event for this long, and no tool running, stops being watched.
 * Its next event continues it. Hooks have no heartbeat, so silence is the only signal. */
const IDLE_MS = 10 * 60_000;
/** A session file unchanged this long, with no record, is a session nobody reported. */
const QUIET_MS = 2 * 60_000;
const SCAN_MS = 10_000;

/** Owns session lifecycle. Every harness session inside Wisdom's homes gets one record:
 * from its hooks while they report, and from its own file when they did not.
 */
export class Captures {
  readonly ledgers = new Map<string, Ledger>();
  readonly database: LedgerDatabase;
  private running = new Map<string, RunningCapture>();
  private lastScan = 0;
  /** Session files that name no session (a subagent's or helper's own file). */
  private notSessions = new Set<string>();

  constructor(readonly dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true });
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
    if (!event.late) this.drainSpool(harness, observation.sessionId);
    let ledger = this.find(harness, observation.sessionId);
    if (!ledger || !this.running.has(ledger.manifest.captureId)) {
      // Codex ends every session it opened when it quits; one not being watched has nothing to close.
      if (observation.type === 'session_ended') return undefined;
      ledger = ledger ? this.resume(ledger, event) : this.open({ harness, sessionId: observation.sessionId,
        harnessVersion: event.harnessVersion, workspaceRoot: event.cwd, source: observation.source ?? null }, false, event.late ? undefined : event.cwd);
    }
    const id = ledger.manifest.captureId;
    const record = this.observe(id, observation, event);
    if (observation.type === 'session_ended' && this.running.has(id)) {
      const reason = (observation.data as any)?.reason;
      this.close(id, typeof reason === 'string' && reason ? `session-ended: ${reason}` : 'session-ended');
    }
    return record;
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
    const copied = lines ? this.copiedHistory(input.harness, input.source!, lines) : undefined;
    const manifest: Manifest = { schemaVersion: 1, captureId: id, ...input,
      workspaceRoot: fs.realpathSync(input.workspaceRoot), status: found ? 'closed' : 'recording',
      startedAt: lines?.dated.find(([id]) => !id || !copied!.ids.has(id))?.[1] ?? (file ? new Date(Math.min(file.birthtimeMs, file.mtimeMs)).toISOString() : now),
      ...(found ? { endedAt: file ? file.mtime.toISOString() : now, endReason: 'found-in-session-file' } : {}),
      scope: { ...scope, excludedPaths } };
    const ledger = new Ledger(this.captureDir(manifest), manifest, this.database, true);
    this.ledgers.set(id, ledger);
    if (found) {
      ledger.append({ type: 'capture_started', summary: 'Found in the harness\'s session file; Wisdom did not see this session live.' });
      ledger.gap('not-recorded-live', 'Read from the harness\'s own session file: no hook events and no observed file changes.');
      ledger.copiedEntries = copied!.ids;
      const prompts = [...lines!.prompts].filter(id => copied!.ids.has(id)).length;
      if (prompts) ledger.gap('history-from-another-session',
        `${prompts} prompt${prompts === 1 ? '' : 's'} at the start of this file also appear in ${[...copied!.from].join(', ')}, which started earlier; they are that session's turns, not this one's.`);
      this.drain(ledger, true);
      return ledger;
    }
    try {
      this.watch(ledger, cwd);
      ledger.append({ type: 'capture_started', summary: 'Live capture started; file baseline is in memory.' });
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
    for (const other of adapter(harness).sessionFiles(path.join(this.dataDir, 'harnesses', harness, 'home'))) {
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
      transcriptFinished: new Set(), lastSeen: Date.now(), lastReconcile: Date.now() });
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
    const { ledger, active } = capture;
    if (!active.size) return;
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
      this.settleTool(capture, toolCallId);
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

  /** The safety net: every session file in Wisdom's homes gets a record, whether or not
   * its hooks ran. A quiet file with no record is read whole; lines a session gained while
   * nothing was recording are read when it goes quiet again.
   */
  scan(): void {
    const bySource = new Map([...this.ledgers.values()].filter(l => l.manifest.source).map(l => [l.manifest.source!, l]));
    for (const harness of harnessNames) {
      const home = path.join(this.dataDir, 'harnesses', harness, 'home');
      if (!fs.existsSync(home)) continue;
      for (const file of adapter(harness).sessionFiles(home)) {
        try {
          if (this.notSessions.has(file)) continue;
          const stat = fs.statSync(file);
          if (Date.now() - stat.mtimeMs < QUIET_MS) continue;
          const known = bySource.get(file);
          if (known) {
            if (this.running.has(known.manifest.captureId) || stat.size <= known.sourcePosition) continue;
            known.gap('not-recorded-live', 'Lines the session file gained while nothing was recording were read from it; no hooks reported them.');
            this.drain(known, true);
            continue;
          }
          const { sessionId, cwd } = header(harness, file);
          if (!sessionId) { this.notSessions.add(file); continue; }
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
