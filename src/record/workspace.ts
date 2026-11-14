import fs from 'node:fs';
import path from 'node:path';
import { createTwoFilesPatch } from 'diff';
import { hash, Ledger } from '../storage/ledger.js';
import { linkedWorktree, worktreeAt, worktreeBranch, type Worktree } from '../core/paths.js';
import type { Manifest } from '../core/schema.js';

export const scope: Manifest['scope'] = {
  excludedDirectories: ['.git', '.wisdom', '.npm-cache', 'node_modules', 'dist', 'build', '.next', '.venv', '__pycache__'],
  excludedPaths: [],
  maxFileBytes: 1024 * 1024, maxFiles: 10000, maxTotalBytes: 64 * 1024 * 1024
};
interface FileState { hash: string; text: string | null; size: number }

/** Observe bytes, not claims about writes. Baseline contents stay only in memory. */
export class Workspace {
  private files = new Map<string, FileState>();
  private dirty = new Set<string>();
  private watcher?: fs.FSWatcher;
  private rescan = false;
  private memoryBytes = 0;
  private unknown = new Set<string>();
  readonly root: string;

  /** `tree`: watch this linked worktree instead of the project. `elsewhere` hears of changes
   * in a linked worktree below the root, which is not this folder's to record.
   */
  constructor(private ledger: Ledger, private tree?: Worktree, private elsewhere?: (tree: Worktree) => void) {
    this.root = fs.realpathSync(tree?.root ?? ledger.manifest.workspaceRoot);
    // Watch before walking, so edits arriving during baseline collection are
    // reconciled afterward. This still isn't an atomic filesystem snapshot.
    try {
      this.watcher = fs.watch(this.root, { recursive: true }, (_event, filename) => {
        if (!filename) this.rescan = true;
        else {
          const file = this.relative(filename.toString());
          if (file !== null) this.dirty.add(file);
        }
      });
      this.watcher.on('error', error => { this.ledger.gap('watcher-error', error.message); this.rescan = true; });
    } catch (error) {
      this.ledger.gap('watcher-unavailable', String(error));
      this.rescan = true;
    }
    try { this.reconcile({}, true); }
    catch (error) { this.close(); throw error; }
  }

  private relative(file: string): string | null {
    const absolute = path.resolve(this.root, file);
    const relative = path.relative(this.root, absolute);
    if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) return null;
    const parts = relative.split(path.sep);
    if (parts.some(part => scope.excludedDirectories.includes(part))) return null;
    const normalized = parts.join('/');
    if (this.ledger.manifest.scope.excludedPaths.some(prefix => normalized === prefix || normalized.startsWith(prefix + '/'))) return null;
    if (absolute === this.ledger.dir || absolute.startsWith(this.ledger.dir + path.sep)) return null;
    return parts.join('/');
  }

  private read(file: string): FileState | null | undefined {
    try {
      const absolute = path.join(this.root, file);
      if (fs.lstatSync(absolute).isSymbolicLink()) { this.ledger.gap('symlink-excluded', file); return undefined; }
      const real = fs.realpathSync(absolute);
      if (!real.startsWith(this.root + path.sep)) { this.ledger.gap('outside-workspace', file); return undefined; }
      const stat = fs.statSync(absolute);
      if (!stat.isFile()) return undefined;
      if (stat.size > scope.maxFileBytes) { this.ledger.gap('oversize-file', file); return undefined; }
      if (this.memoryBytes - (this.files.get(file)?.size ?? 0) + stat.size > scope.maxTotalBytes) {
        this.ledger.gap('baseline-memory-limit', file); return undefined;
      }
      const bytes = fs.readFileSync(absolute);
      const text = bytes.toString('utf8');
      return { hash: hash(bytes), size: bytes.length,
        text: !bytes.includes(0) && Buffer.from(text).equals(bytes) ? text : null };
    } catch (error: any) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
      this.ledger.gap('file-read-error', `${file}: ${error.message}`); return undefined;
    }
  }

  /** The linked worktree a path below the root belongs to, if any. */
  private linkedAt(relative: string): Worktree | undefined {
    const parts = relative.split('/');
    for (let i = 1; i <= parts.length; i++) {
      const tree = worktreeAt(path.join(this.root, ...parts.slice(0, i)));
      if (tree) return tree;
    }
    return undefined;
  }

  observe(file: string, context: { toolCallId?: string; activeToolCallIds?: string[] }): void {
    const relative = this.relative(file);
    if (!relative) return;
    const linked = this.linkedAt(relative);
    if (linked) { this.elsewhere?.(linked); return; }
    this.record(relative, context);
  }

  private record(file: string, context: { toolCallId?: string; activeToolCallIds?: string[] }, initial = false): void {
    const relative = this.relative(file);
    if (!relative) return;
    const before = this.files.get(relative);
    const after = this.read(relative);
    if (after === undefined) {
      // Unknown state breaks the before-image chain; don't invent a later diff.
      if (before) { this.memoryBytes -= before.size; this.files.delete(relative); }
      this.unknown.add(relative);
      return;
    }
    if (this.unknown.delete(relative)) {
      this.ledger.gap('baseline-reestablished', `${relative}: contents were previously unavailable; no historical patch claimed.`);
      if (after) { this.files.set(relative, after); this.memoryBytes += after.size; }
      return;
    }
    if (before?.hash === after?.hash) return;
    if (!initial) {
      const operation = !before ? 'create' : !after ? 'delete' : 'modify';
      // A created or deleted file is a patch from or to empty, so readers see its
      // contents. A missing side counts as empty text; binary sides get no patch.
      const patch = before?.text !== null && after?.text !== null
        ? createTwoFilesPatch(before ? relative : '/dev/null', after ? relative : '/dev/null',
          before?.text ?? '', after?.text ?? '', '', '', { context: 3 }) : undefined;
      this.ledger.append({ type: 'file_change', path: relative, operation,
        summary: `${operation}: ${relative}`, beforeHash: before?.hash ?? null, afterHash: after?.hash ?? null,
        parentId: context.toolCallId ? this.ledger.findToolStart(context.toolCallId)?.id : undefined,
        attribution: context.toolCallId ? 'observed-during-tool' : 'external-or-unknown', ...context,
        worktree: this.tree?.name, branch: this.tree ? worktreeBranch(this.tree) : undefined,
        patchRef: patch === undefined ? undefined : this.ledger.payload(patch),
        patchUnavailable: patch === undefined ? 'binary-or-non-utf8' : undefined });
    }
    this.memoryBytes -= before?.size ?? 0;
    if (after) { this.files.set(relative, after); this.memoryBytes += after.size; }
    else this.files.delete(relative);
  }

  /** Full reconciliation for shell/custom tools and periodic watcher recovery. */
  reconcile(context: { toolCallId?: string; activeToolCallIds?: string[] }, initial = false): void {
    const seen = new Set<string>();
    let count = 0;
    const visit = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const absolute = path.join(dir, entry.name);
        const file = this.relative(absolute);
        if (!file) continue;
        if (entry.isSymbolicLink()) { this.ledger.gap('symlink-excluded', file); continue; }
        if (entry.isDirectory()) { if (!worktreeAt(absolute)) visit(absolute); }
        else if (entry.isFile()) {
          if (++count > scope.maxFiles) throw new Error(`Workspace exceeds ${scope.maxFiles} files. Use a smaller --cwd.`);
          seen.add(file); this.record(file, context, initial);
        }
      }
    };
    visit(this.root);
    for (const file of this.files.keys()) if (!seen.has(file)) this.record(file, context, initial);
    this.dirty.clear(); this.rescan = false;
  }

  flush(context: { toolCallId?: string; activeToolCallIds?: string[] } = {}): void {
    if (this.rescan) { this.reconcile(context); return; }
    const pending = [...this.dirty]; this.dirty.clear();
    for (const file of pending) {
      this.observe(file, context);
      // A directory rename can produce just one watcher notification.
      if (fs.existsSync(path.join(this.root, file)) && fs.lstatSync(path.join(this.root, file)).isDirectory()) {
        this.reconcile(context); break;
      }
      for (const known of this.files.keys()) if (known.startsWith(file + '/')) this.record(known, context);
    }
  }

  close(): void { this.watcher?.close(); }
}

/** The files one session is answerable for: its project, and each linked worktree it has
 * worked in. Another session's worktree is that session's to record; this one only says
 * files changed there, so nothing goes unmarked.
 */
export class SessionFiles {
  private main: Workspace;
  private trees = new Map<string, Workspace>();
  private noted = new Set<string>();
  private cwd?: string;

  constructor(private ledger: Ledger, cwd?: string) {
    this.main = new Workspace(ledger, undefined, tree => this.noteElsewhere(tree));
    if (cwd) { this.cwd = cwd; this.start(cwd); }
  }

  private all(): Workspace[] { return [this.main, ...this.trees.values()]; }

  private noteElsewhere(tree: Worktree): void {
    if (this.trees.has(key(tree)) || this.noted.has(key(tree))) return;
    this.noted.add(key(tree));
    this.ledger.gap('other-worktree', `Files changed in worktree ${tree.name} (${tree.root}), where this session has not worked; their diffs are not in this record.`);
  }

  /** Begin watching the linked worktree holding `folder`, from this moment. */
  private start(folder: string): boolean {
    const tree = linkedWorktree(folder);
    if (!tree || this.trees.has(key(tree))) return false;
    try {
      this.trees.set(key(tree), new Workspace(this.ledger, tree, other => this.noteElsewhere(other)));
      return true;
    } catch (error) {
      this.ledger.gap('worktree-not-watched', `${tree.root}: ${String(error)}`);
      return false;
    }
  }

  /** The session reports working in `folder`. A worktree it enters now has a baseline only from now. */
  follow(folder: string): void {
    this.cwd = folder;
    this.enter(folder);
  }

  private enter(folder: string): void {
    if (this.start(folder)) {
      const tree = linkedWorktree(folder)!;
      this.ledger.gap('worktree-entered', `Watching worktree ${tree.name} (${tree.root}) from here; changes made in it before this point are not recorded.`);
    }
  }

  /** A file a tool names may be relative to where the session is, and may be in a worktree. */
  observe(file: string, context: { toolCallId?: string; activeToolCallIds?: string[] }): void {
    const absolute = path.resolve(this.cwd ?? this.main.root, file);
    this.enter(path.dirname(absolute));
    for (const workspace of this.all()) workspace.observe(absolute, context);
  }

  flush(context: { toolCallId?: string; activeToolCallIds?: string[] } = {}): void { for (const workspace of this.all()) workspace.flush(context); }
  reconcile(context: { toolCallId?: string; activeToolCallIds?: string[] }): void { for (const workspace of this.all()) workspace.reconcile(context); }
  close(): void { for (const workspace of this.all()) workspace.close(); }
}

const key = (tree: Worktree) => process.platform === 'win32' ? path.resolve(tree.root).toLowerCase() : path.resolve(tree.root);
