import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Ledger } from './ledger.js';
import { LedgerDatabase } from './database.js';
import { Workspace, scope } from './workspace.js';
import { preview, type Observation, type Manifest, type LedgerRecord } from './schema.js';

interface RunningCapture {
  ledger: Ledger;
  workspace: Workspace;
  active: Map<string, { toolName: string; path?: string; recordId: string }>;
  currentTurn?: string;
  lastSeen: number;
  lastReconcile: number;
}

/** Owns session lifecycle. Closed captures remain queryable; only live ones watch files. */
export class Captures {
  readonly ledgers = new Map<string, Ledger>();
  readonly database: LedgerDatabase;
  private running = new Map<string, RunningCapture>();

  constructor(readonly root: string) {
    fs.mkdirSync(root, { recursive: true });
    this.database = new LedgerDatabase(path.join(path.dirname(root), 'ledger.sqlite'));
    try {
      for (const manifest of this.database.manifests()) {
        const ledger = new Ledger(path.join(root, manifest.captureId), manifest, this.database);
        if (manifest.status === 'recording') {
          manifest.status = 'interrupted'; manifest.endReason = 'daemon-restarted';
          manifest.endedAt = new Date().toISOString(); ledger.saveManifest();
        }
        this.ledgers.set(manifest.captureId, ledger);
      }
    } catch (error) { this.database.close(); throw error; }
  }

  open(input: { piSessionId: string; workspaceRoot: string; source: string | null }): Manifest {
    // Pi can return a relative session path when --session-dir was relative.
    // Resolve it against Pi's workspace, never the daemon's working directory.
    input = { ...input, workspaceRoot: path.resolve(input.workspaceRoot),
      source: input.source ? path.resolve(input.workspaceRoot, input.source) : null };
    const id = randomUUID();
    const ignoreFile = path.join(input.workspaceRoot, '.wisdomignore');
    const excludedPaths = fs.existsSync(ignoreFile) ? fs.readFileSync(ignoreFile, 'utf8').split(/\r?\n/)
      .map(line => line.trim().replaceAll('\\', '/').replace(/\/$/, ''))
      .filter(line => line && !line.startsWith('#')) : [];
    if (excludedPaths.some(value => value.includes('*') || value.startsWith('/') || value.split('/').includes('..'))) {
      throw new Error('.wisdomignore accepts relative file/directory paths, without globs or ..');
    }
    // Recorder files must never become evidence of the agent editing its project.
    const dataRelative = path.relative(fs.realpathSync(input.workspaceRoot), path.dirname(this.root)).replaceAll('\\', '/');
    if (!dataRelative) throw new Error('The daemon data directory cannot be the tracked workspace root.');
    if (!dataRelative.startsWith('../') && !path.isAbsolute(dataRelative)) excludedPaths.push(dataRelative);
    if (input.source) {
      const sourceRelative = path.relative(fs.realpathSync(input.workspaceRoot), input.source).replaceAll('\\', '/');
      if (sourceRelative && !sourceRelative.startsWith('../') && !path.isAbsolute(sourceRelative)) excludedPaths.push(sourceRelative);
    }
    const manifest: Manifest = { schemaVersion: 1, captureId: id, ...input,
      workspaceRoot: fs.realpathSync(input.workspaceRoot), startedAt: new Date().toISOString(), status: 'recording',
      scope: { ...scope, excludedPaths } };
    const ledger = new Ledger(path.join(this.root, id), manifest, this.database, true);
    this.ledgers.set(id, ledger);
    try {
      const workspace = new Workspace(ledger);
      this.running.set(id, { ledger, workspace, active: new Map(), lastSeen: Date.now(), lastReconcile: Date.now() });
      ledger.append({ type: 'capture_started', summary: 'Live capture started; file baseline is in memory.' });
      if (!input.source) ledger.gap('native-session-unavailable', 'Pi persistence is disabled; extension observations remain available.');
      ledger.syncSource();
      return manifest;
    } catch (error) {
      this.degrade(id, error); throw error;
    }
  }

  get(id: string): Ledger {
    const ledger = this.ledgers.get(id);
    if (!ledger) throw new Error(`Unknown capture: ${id}`);
    return ledger;
  }

  heartbeat(id: string): void {
    const capture = this.running.get(id);
    if (!capture) throw new Error('Capture is not recording. Reload the Pi extension to start a new capture.');
    capture.lastSeen = Date.now();
  }

  observe(id: string, observation: Observation): LedgerRecord | undefined {
    this.heartbeat(id);
    const capture = this.running.get(id)!;
    const { ledger, workspace, active } = capture;
    if (ledger.hasObservation(observation.observationId)) return undefined;
    const data = observation.data as any;
    try {
      if (observation.type === 'tool_started') {
        if (!observation.toolCallId || !observation.toolName) throw new Error('Tool start requires toolCallId and toolName');
        workspace.flush(active.size ? { toolCallId: [...active.keys()][0], activeToolCallIds: [...active.keys()] } : {});
        // Explicit file targets are inspected synchronously before the hook returns.
        const target = typeof data?.input?.path === 'string' ? data.input.path : undefined;
        if (target) workspace.observe(target, active.size ? { toolCallId: [...active.keys()][0], activeToolCallIds: [...active.keys()] } : {});
      }
      const { data: payload, ...metadata } = observation;
      const record = ledger.append({ ...metadata,
        role: observation.type === 'message' && typeof data?.role === 'string' ? data.role : undefined,
        // A result belongs to its original start even if another input arrived
        // while it ran. Do not move a long-running tool to the newest request.
        parentId: observation.type === 'tool_finished' && observation.toolCallId && active.has(observation.toolCallId)
          ? active.get(observation.toolCallId)!.recordId
          : observation.parentToolCallId ? active.get(observation.parentToolCallId)?.recordId : capture.currentTurn,
        dataRef: payload === undefined ? undefined : ledger.payload(payload),
        summary: observation.type === 'input' ? preview(data?.text)
          : observation.type === 'message' ? preview(data?.content)
          : `${observation.type}${observation.toolName ? ': ' + observation.toolName : ''}${observation.isError ? ' (error)' : ''}`
      });
      if (observation.type === 'input') capture.currentTurn = record.id;
      if (observation.type === 'tool_started') active.set(observation.toolCallId!, {
        toolName: observation.toolName!, path: typeof data?.input?.path === 'string' ? data.input.path : undefined,
        recordId: record.id
      });
      if (observation.type === 'tool_finished') {
        const call = active.get(observation.toolCallId!);
        if (!call) ledger.gap('missing-tool-start', observation.toolCallId ?? 'unknown');
        const context = { toolCallId: observation.toolCallId, activeToolCallIds: [...active.keys()] };
        if (call?.path) workspace.observe(call.path, context);
        // Shell/custom tools may write anywhere inside scope. A bounded scan is
        // the correctness fallback; direct read/edit/write calls avoid it.
        if (!call || !['read', 'edit', 'write'].includes(call.toolName)) workspace.reconcile(context);
        else workspace.flush(context);
        active.delete(observation.toolCallId!);
      }
      if (observation.type === 'agent_settled') {
        if (active.size) ledger.gap('unfinished-tools-at-settle', [...active.keys()].join(','));
        workspace.flush();
      }
      ledger.syncSource();
      return record;
    } catch (error) { this.degrade(id, error); throw error; }
  }

  poll(): void {
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
      workspace.reconcile(active.size ? { toolCallId: [...active.keys()][0], activeToolCallIds: [...active.keys()] } : {});
      // Drain the source backlog before closing. Each read is bounded.
      let previous = -1;
      while (previous !== ledger.lastSeq) { previous = ledger.lastSeq; ledger.syncSource(); }
      ledger.append({ type: 'capture_closed', summary: reason,
        dataRef: ledger.payload({ pendingToolCallIds: [...active.keys()] }) });
      if (ledger.manifest.source && fs.existsSync(ledger.manifest.source)) {
        const originalBytes = fs.statSync(ledger.manifest.source).size;
        const copiedBytes = fs.statSync(path.join(ledger.dir, 'pi-session.jsonl')).size;
        if (originalBytes !== copiedBytes) ledger.gap('source-copy-incomplete', `Source has ${originalBytes} bytes; mirror has ${copiedBytes}.`);
      }
      ledger.manifest.status = interrupted || active.size > 0 ? 'interrupted' : 'closed';
      ledger.manifest.endedAt = new Date().toISOString(); ledger.manifest.endReason = reason;
      ledger.saveManifest();
    } finally { workspace.close(); this.running.delete(id); }
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
