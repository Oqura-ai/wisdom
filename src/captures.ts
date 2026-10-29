import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Ledger } from './ledger.js';
import { LedgerDatabase } from './database.js';
import { Workspace, scope } from './workspace.js';
import { preview, type Observation, type Manifest, type LedgerRecord } from './schema.js';
import { adapter } from './harnesses/index.js';
import { surfaceText } from './content.js';

interface RunningCapture {
  ledger: Ledger;
  workspace: Workspace;
  active: Map<string, { toolName: string; path?: string; recordId: string; agentId?: string; turnId?: string }>;
  currentTurn?: string;
  turns: Map<string, string>;
  /** Tools closed from the native transcript; a late result hook is then not a gap. */
  transcriptFinished: Set<string>;
  lastSeen: number;
  lastReconcile: number;
}

/** One `wisdom track` process. It may visit several native sessions (/clear, /resume);
 * each session is its own capture, and only the current one records.
 */
interface Launch {
  harness: string;
  harnessVersion?: string;
  workspaceRoot: string;
  current?: string;
  lastSeen: number;
}

/** Owns session lifecycle. Closed captures remain queryable; only live ones watch files. */
export class Captures {
  readonly ledgers = new Map<string, Ledger>();
  readonly database: LedgerDatabase;
  private running = new Map<string, RunningCapture>();
  private launches = new Map<string, Launch>();

  constructor(readonly dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.database = new LedgerDatabase(path.join(dataDir, 'ledger.sqlite'));
    try {
      for (const manifest of this.database.manifests()) {
        const ledger = new Ledger(this.captureDir(manifest), manifest, this.database);
        if (manifest.status === 'recording') {
          manifest.status = 'interrupted'; manifest.endReason = 'daemon-restarted';
          manifest.endedAt = new Date().toISOString(); ledger.saveManifest();
        }
        this.ledgers.set(manifest.captureId, ledger);
      }
    } catch (error) { this.database.close(); throw error; }
  }

  /** Each harness owns a directory, so one harness's files never mix with another's. */
  captureDir(manifest: Pick<Manifest, 'harness' | 'captureId'>): string {
    return path.join(this.dataDir, 'harnesses', manifest.harness, manifest.captureId);
  }

  /** One native session is one capture. Opening a session that already has a capture
   * (a resume, or Pi's /reload) continues that capture with a new visit.
   */
  open(input: { harness: string; sessionId: string; harnessVersion?: string; workspaceRoot: string; source: string | null }): Manifest {
    // A harness can report a relative session path (Pi does with a relative --session-dir).
    // Resolve it against the harness's workspace, never the daemon's working directory.
    input = { ...input, workspaceRoot: path.resolve(input.workspaceRoot),
      source: input.source ? path.resolve(input.workspaceRoot, input.source) : null };
    const existing = [...this.ledgers.values()].find(ledger =>
      ledger.manifest.harness === input.harness && ledger.manifest.sessionId === input.sessionId);
    if (existing) return this.resume(existing, input);
    // The harness's own session ID is the capture's ID: there is no second ID to learn.
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
    const manifest: Manifest = { schemaVersion: 1, captureId: id, ...input,
      workspaceRoot: fs.realpathSync(input.workspaceRoot), startedAt: new Date().toISOString(), status: 'recording',
      scope: { ...scope, excludedPaths } };
    const ledger = new Ledger(this.captureDir(manifest), manifest, this.database, true);
    this.ledgers.set(id, ledger);
    try {
      this.watch(ledger);
      ledger.append({ type: 'capture_started', summary: 'Live capture started; file baseline is in memory.' });
      if (!input.source && input.harness === 'pi') ledger.gap('native-session-unavailable', 'Pi persistence is disabled; extension observations remain available.');
      if (input.harness === 'codex') ledger.gap('codex-hook-coverage',
        'Hosted/specialized tools may bypass hooks; transcript parsing is best-effort. Subagent tool identity is only available when supplied by Codex.');
      ledger.syncSource();
      return manifest;
    } catch (error) {
      this.degrade(id, error); throw error;
    }
  }

  private resume(ledger: Ledger, input: { harnessVersion?: string; workspaceRoot: string; source: string | null }): Manifest {
    const { manifest } = ledger;
    if (this.running.has(manifest.captureId)) throw new Error(`Session ${manifest.sessionId} is already being recorded by another Wisdom launch.`);
    if (fs.realpathSync(input.workspaceRoot) !== manifest.workspaceRoot) {
      throw new Error(`Session ${manifest.sessionId} was recorded in ${manifest.workspaceRoot}; resume it with that --cwd.`);
    }
    const ended = manifest.endedAt;
    manifest.status = 'recording'; manifest.harnessVersion = input.harnessVersion ?? manifest.harnessVersion;
    delete manifest.endedAt; delete manifest.endReason;
    ledger.saveManifest();
    try {
      this.watch(ledger);
      ledger.append({ type: 'capture_started', summary: 'Capture resumed; file baseline is in memory.' });
      ledger.gap('not-recording-between-visits', `File changes from ${ended ?? 'the last visit'} until this resume were not observed.`);
      if (input.source) this.attachSource(ledger, { source: input.source });
      ledger.syncSource();
      return manifest;
    } catch (error) {
      this.degrade(manifest.captureId, error); throw error;
    }
  }

  private watch(ledger: Ledger): void {
    this.running.set(ledger.manifest.captureId, { ledger, workspace: new Workspace(ledger), active: new Map(), turns: new Map(),
      transcriptFinished: new Set(), lastSeen: Date.now(), lastReconcile: Date.now() });
  }

  /** A launch knows its harness and workspace, not yet its session: the harness names
   * it in its first hook. A launch that never names one records nothing.
   */
  launch(input: { harness: string; harnessVersion?: string; workspaceRoot: string }): string {
    const id = randomUUID();
    this.launches.set(id, { ...input, workspaceRoot: fs.realpathSync(input.workspaceRoot), lastSeen: Date.now() });
    return id;
  }

  private launchOf(id: string): Launch {
    const launch = this.launches.get(id);
    if (!launch) throw new Error('Unknown Wisdom launch. Start the harness again with wisdom track.');
    launch.lastSeen = Date.now();
    return launch;
  }

  /** Route a hook to the capture of the session it names. Switching session (/clear,
   * /new, /resume) closes the previous capture; a later visit to it continues it.
   */
  observeLaunch(id: string, observation: Observation): LedgerRecord | undefined {
    const launch = this.launchOf(id);
    const sessionId = observation.sessionId;
    if (!sessionId) throw new Error('The hook did not name its session.');
    const current = launch.current ? this.ledgers.get(launch.current) : undefined;
    if (current?.manifest.sessionId === sessionId) return this.observe(current.manifest.captureId, observation);
    // Codex ends every session it opened when it quits; only the current one is recording.
    if (observation.type === 'session_ended') return undefined;
    if (current && this.running.has(current.manifest.captureId)) this.close(current.manifest.captureId, 'session-switched');
    launch.current = this.open({ harness: launch.harness, sessionId, harnessVersion: launch.harnessVersion,
      workspaceRoot: launch.workspaceRoot, source: observation.source ?? null }).captureId;
    return this.observe(launch.current, observation);
  }

  heartbeatLaunch(id: string): void {
    const launch = this.launchOf(id);
    if (launch.current && this.running.has(launch.current)) this.heartbeat(launch.current);
  }

  closeLaunch(id: string, reason: string): Manifest | undefined {
    const launch = this.launchOf(id);
    this.launches.delete(id);
    if (!launch.current) return undefined;
    this.close(launch.current, reason);
    return this.get(launch.current).manifest;
  }

  get(id: string): Ledger {
    const ledger = this.ledgers.get(id);
    if (!ledger) throw new Error(`No recorded session has the ID ${id}. Use the full session ID; glance lists them.`);
    return ledger;
  }

  heartbeat(id: string): void {
    const capture = this.running.get(id);
    if (!capture) throw new Error('Capture is not recording. Start a new capture with wisdom track, or /reload in Pi.');
    capture.lastSeen = Date.now();
  }

  observe(id: string, observation: Observation): LedgerRecord | undefined {
    this.heartbeat(id);
    const capture = this.running.get(id)!;
    const { ledger, workspace, active } = capture;
    if (ledger.hasObservation(observation.observationId)) return undefined;
    const data = observation.data as any;
    const harness = adapter(ledger.manifest.harness);
    try {
      if (observation.sessionId) {
        if (observation.source && ledger.manifest.source
          && path.resolve(ledger.manifest.workspaceRoot, observation.source) !== ledger.manifest.source) {
          throw new Error('Native transcript changed; start a new tracked capture before continuing.');
        }
        this.attachSource(ledger, { source: observation.source });
      }
      if (observation.type === 'session_started') this.attachSource(ledger, data);
      // Transcript lines written before this event belong before it: mirror them first,
      // so a reply is linked to the request it answered, not to the next prompt. A
      // harness may write the new prompt itself first; that copy belongs to the new input.
      const prompt = observation.type === 'input' && typeof data?.text === 'string' ? data.text.trim() : '';
      ledger.syncSource(prompt ? entry => entry.messages.some(message => message.role === 'user'
        && surfaceText(message).trim().includes(prompt)) : undefined);
      // Claude Code's own helper agents (prompt suggestions, recaps) stop without a
      // type or transcript. They are recorded, but they are not task subagents.
      const internalAgent = observation.type === 'subagent_stopped' && !data?.agentType && ledger.manifest.harness === 'claude-code';
      if (observation.type === 'subagent_stopped' && !internalAgent) this.copySubagentTranscript(ledger, observation.agentId, data?.transcriptPath);
      if (observation.type === 'tool_started') {
        if (!observation.toolCallId || !observation.toolName) throw new Error('Tool start requires toolCallId and toolName');
        workspace.flush(active.size ? { toolCallId: [...active.keys()][0], activeToolCallIds: [...active.keys()] } : {});
        // Explicit file targets are inspected synchronously before the hook returns.
        const target = harness.toolTarget(observation.toolName, data?.input);
        if (target) workspace.observe(target, active.size ? { toolCallId: [...active.keys()][0], activeToolCallIds: [...active.keys()] } : {});
      }
      const { data: payload, sessionId: _sessionId, source: _source, harnessEvent, ...metadata } = observation;
      const turnKey = `${observation.agentId ?? ''}:${observation.turnId}`;
      const record = ledger.append({ ...metadata,
        role: observation.type === 'message' && typeof data?.role === 'string' ? data.role : undefined,
        // A result belongs to its original start even if another input arrived
        // while it ran. Do not move a long-running tool to the newest request.
        parentId: observation.type === 'tool_finished' && observation.toolCallId && active.has(observation.toolCallId)
          ? active.get(observation.toolCallId)!.recordId
          : observation.parentToolCallId ? active.get(observation.parentToolCallId)?.recordId
          : observation.turnId ? capture.turns.get(turnKey) : capture.currentTurn,
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
        if (!active.has(observation.toolCallId!) && !capture.transcriptFinished.has(observation.toolCallId!)) {
          ledger.gap('missing-tool-start', observation.toolCallId ?? 'unknown');
        }
        this.settleTool(capture, observation.toolCallId!);
      }
      if (observation.type === 'agent_settled') {
        this.finishFromTranscript(capture);
        if (active.size) ledger.gap('unfinished-tools-at-settle', [...active.keys()].join(','));
        workspace.flush();
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
    for (const [id, launch] of this.launches) if (Date.now() - launch.lastSeen > 30000) this.launches.delete(id);
    for (const [id, capture] of this.running) {
      try {
        if (Date.now() - capture.lastSeen > 30000) { this.close(id, 'extension-heartbeat-lost', true); continue; }
        capture.ledger.syncSource();
        if (!capture.active.size) {
          capture.workspace.flush();
          if (Date.now() - capture.lastReconcile > 30000) {
            capture.workspace.reconcile({}); capture.lastReconcile = Date.now();
          }
        }
      } catch (error) { this.degrade(id, error); }
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
      // Drain the source backlog before closing. Each read is bounded.
      let previous = -1;
      while (previous !== ledger.lastSeq) { previous = ledger.lastSeq; ledger.syncSource(); }
      this.finishFromTranscript(capture);
      workspace.reconcile(active.size ? { toolCallId: [...active.keys()][0], activeToolCallIds: [...active.keys()] } : {});
      ledger.append({ type: 'capture_closed', summary: reason,
        dataRef: ledger.payload({ pendingToolCallIds: [...active.keys()] }) });
      if (ledger.manifest.source && fs.existsSync(ledger.manifest.source)) {
        const originalBytes = fs.statSync(ledger.manifest.source).size;
        const copiedBytes = fs.statSync(ledger.mirror).size;
        if (originalBytes !== copiedBytes) ledger.gap('source-copy-incomplete', `Source has ${originalBytes} bytes; mirror has ${copiedBytes}.`);
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

  private degrade(id: string, error: unknown): void {
    const ledger = this.ledgers.get(id);
    if (ledger) {
      ledger.manifest.status = 'degraded'; ledger.manifest.endReason = String(error);
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
