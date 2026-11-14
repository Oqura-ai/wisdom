import path from 'node:path';
import { conversation, type Change, type Subagent, type TurnItem } from './conversation.js';
import { resolveCapture } from './discovery.js';
import { EvidenceReader } from '../storage/evidence.js';
import { adapter } from '../harnesses/index.js';
import type { LedgerRecord, Manifest } from '../core/schema.js';
import type { SessionStore } from '../storage/store.js';

/** One session as a Markdown document anyone can read: every prompt and reply in full, each
 * tool call folded with its whole input and output, every patch raw. Nothing is summarized or
 * cut; folding only decides what is open at first. Calls and subagents are numbered as the
 * ledger numbers them, so `t3/c2` here is `t3/c2` in `wisdom open`.
 */
export function sessionMarkdown(store: SessionStore, ref: string): { readVersion: number; captureId: string; markdown: string } {
  const readVersion = store.database.revision;
  const manifest = resolveCapture(store, ref, readVersion);
  const records = store.database.records('capture_id=? AND revision<=?', [manifest.captureId, readVersion], 'ORDER BY seq')
    .filter(record => !record.internalAgent);
  const turns = records.filter(record => record.type === 'input' && !record.agentId);
  const agents = [...new Set(records.filter(r => r.agentId && r.type !== 'usage').map(r => r.agentId!))];
  const views = turns.map(turn => conversation(store, { captureId: manifest.captureId, requestId: turn.id, readVersion }));
  const render = new Renderer(manifest, agents);

  const tokens = views.reduce((sum, view) => sum + view.tokens.total, 0);
  const calls = records.filter(r => r.type === 'tool_started').length;
  const failed = records.filter(r => r.type === 'tool_finished' && r.isError === true).length;
  const changes = records.filter(r => r.type === 'file_change').length;
  const title = firstLine(views[0]?.request.text.text) ?? manifest.captureId;
  const out: string[] = [
    `# ${escape(title)} · ${manifest.harness} session ${manifest.captureId.slice(0, 8)}`, '',
    [`${manifest.harness}${manifest.harnessVersion ? ` ${manifest.harnessVersion}` : ''}`, minute(manifest.startedAt), count(turns.length, 'turn'),
      count(calls, 'tool call'), failed ? `${failed} failed` : '', count(changes, 'change'), tokens ? `${tokens.toLocaleString('en-US')} tokens` : '']
      .filter(Boolean).join(' · '), '',
    `Session \`${manifest.captureId}\`, read at version ${readVersion}. Recorded evidence in recorded order: nothing below is summarized or reworded.`,
  ];
  if (store.shared) out.push('', `A shared copy from ${escape(store.shared.project)}, as recorded on the sender's machine.`);
  for (const link of records.filter(r => r.type === 'session_link')) out.push('', `*${escape(link.summary)}*`);

  const gapsBefore = (seq: number, after = 0) => records.filter(r => r.type === 'gap' && r.seq < seq && r.seq >= after);
  const notRecorded = (gaps: LedgerRecord[]) => gaps.map(gap => `> **Not recorded:** ${escape(gap.summary)}`);
  const firstGaps = notRecorded(gapsBefore(turns[0]?.seq ?? Infinity));
  if (firstGaps.length) out.push('', ...firstGaps);

  views.forEach((view, index) => {
    const turn = turns[index]!;
    out.push('', `## t${index + 1} · ${escape(firstLine(view.request.text.text) ?? '(no text)')}`, '', '**Prompt**', '', quote(view.request.text.text));
    if (view.request.images) out.push('', `*${count(view.request.images, 'image')} attached*`);
    out.push(...render.items(view.items, `t${index + 1}`));
    const patches = allChanges(view.items);
    if (patches.length) out.push('', '**Changes**', ...patches.flatMap(change => render.change(change)));
    const gaps = notRecorded(gapsBefore(turns[index + 1]?.seq ?? Infinity, turn.seq));
    if (gaps.length) out.push('', ...gaps);
    if (view.issues.length) out.push('', ...view.issues.map(issue => `> **Unreadable:** record ${issue.id}: ${escape(issue.reason)}`));
  });

  const outside = records.filter(r => r.type === 'file_change' && !r.requestId);
  if (outside.length) {
    const reader = new EvidenceReader(store);
    out.push('', '## Outside any turn', '', 'Changes recorded while no prompt was being worked on.');
    for (const record of outside) {
      let patch: string | undefined;
      try { patch = reader.read(record, 'patch'); } catch { patch = undefined; }
      out.push(...render.change({ kind: 'change', id: record.id, at: record.observedAt, path: record.path, operation: record.operation,
        attribution: record.attribution, worktree: record.worktree, patch: patch === undefined ? undefined : { text: patch }, patchUnavailable: record.patchUnavailable }));
    }
  }
  if (!turns.length) out.push('', '*No turns recorded.*');
  out.push('', '---', '', `Recorded with [Wisdom](https://github.com/Oqura-ai/wisdom).`, '');
  return { readVersion, captureId: manifest.captureId, markdown: out.join('\n') };
}

class Renderer {
  private harness;
  constructor(private manifest: Manifest, private agents: string[]) { this.harness = adapter(manifest.harness); }

  /** Items in recorded order. Calls are numbered within their turn or subagent. */
  items(items: TurnItem[], scope: string): string[] {
    const tools = items.filter((item): item is Extract<TurnItem, { kind: 'tool' }> => item.kind === 'tool');
    const out: string[] = [];
    for (const item of items) {
      if (item.kind === 'text') out.push('', item.source === 'hook' ? '**Reply** *(from hook)*' : '**Reply**', '', item.text.text.trim());
      else if (item.kind === 'thinking') {
        out.push('', item.redacted || !item.text.text
          ? `*Thinking: redacted${item.durationMs ? `, ${seconds(item.durationMs)}` : ''}. It happened; its text was not recorded.*`
          : fold(`Thinking${item.durationMs ? ` · ${seconds(item.durationMs)}` : ''}`, [fence(item.text.text)]));
      } else if (item.kind === 'subagent') out.push('', fold(this.agentLabel(item.subagent, 'not linked to a call'), this.subagent(item.subagent)));
      else if (item.kind === 'tool') {
        const c = `${scope}/c${tools.indexOf(item) + 1}`;
        const body = ['**Input**', '', fence(item.input?.text ?? '(none recorded)'), '', '**Output**', '', fence(item.output?.text ?? '(no result recorded)')];
        out.push('', fold(`${c} · ${item.name}${this.target(item)} · ${this.status(item)}`, body));
        if (item.subagent) out.push('', fold(this.agentLabel(item.subagent, `started by ${c}`), this.subagent(item.subagent)));
      }
    }
    return out;
  }

  change(change: Change): string[] {
    const where = `${change.worktree ? `${change.worktree}: ` : ''}${change.path ?? '(unknown path)'}`;
    const head = `\`${where}\` · ${change.operation ?? 'change'}${change.attribution ? ` · ${change.attribution}` : ''}`;
    return ['', head, '', change.patch ? fence(change.patch.text, 'diff') : `*No patch recorded${change.patchUnavailable ? `: ${escape(change.patchUnavailable)}` : ''}.*`];
  }

  private subagent(subagent: Subagent): string[] {
    const n = `a${this.agents.indexOf(subagent.agentId) + 1}`;
    return [...(subagent.task ? ['**Task**', '', quote(subagent.task.text)] : []), ...this.items(subagent.items, n),
      ...(subagent.report ? ['', '**Report**', '', subagent.report.text.trim()] : [])];
  }

  private agentLabel(subagent: Subagent, how: string): string {
    return `a${this.agents.indexOf(subagent.agentId) + 1} · subagent${subagent.agentType ? ` (${subagent.agentType})` : ''} · ${how}`;
  }

  private target(item: Extract<TurnItem, { kind: 'tool' }>): string {
    let input: unknown;
    try { input = item.input ? JSON.parse(item.input.text) : undefined; } catch { input = undefined; }
    const target = this.harness.toolTarget(item.name, input);
    if (!target) return '';
    const inside = path.relative(this.manifest.workspaceRoot, target);
    return ` · ${inside && !inside.startsWith('..') && !path.isAbsolute(inside) ? inside.replaceAll('\\', '/') : target}`;
  }

  private status(item: Extract<TurnItem, { kind: 'tool' }>): string {
    if (this.harness.isScriptStep(item.name)) return 'script step';
    if (item.status === 'ok') return 'ok';
    if (item.status === 'error') return 'failed';
    if (item.status === 'pending') return this.manifest.status === 'recording' ? 'pending' : 'no result recorded';
    return 'outcome not recorded';
  }
}

/** Every change a turn made, its calls' and its subagents' included, in recorded order. */
function allChanges(items: TurnItem[]): Change[] {
  return items.flatMap(item => item.kind === 'change' ? [item]
    : item.kind === 'tool' ? [...item.changes, ...(item.subagent ? allChanges(item.subagent.items) : [])]
    : item.kind === 'subagent' ? allChanges(item.subagent.items) : []);
}

/** A collapsible block. The summary is HTML, so it is escaped; the body is Markdown. */
function fold(summary: string, body: string[]): string {
  return [`<details><summary>${html(summary)}</summary>`, '', ...body, '', '</details>'].join('\n');
}

/** A code block whose fence is longer than any run of backticks inside it, so no content can close it early. */
function fence(text: string, language = ''): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map(run => run.length));
  const marks = '`'.repeat(Math.max(3, longest + 1));
  return `${marks}${language}\n${text.replace(/\n+$/, '')}\n${marks}`;
}

const quote = (text: string) => text.replace(/\n+$/, '').split('\n').map(line => `> ${line}`.trimEnd()).join('\n');
const html = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
/** Text placed in a heading or a line of prose, where Markdown would otherwise read its symbols. */
const escape = (text: string) => text.replace(/([\\`*_#<>[\]|])/g, '\\$1');
const firstLine = (text?: string) => text?.trim().split('\n')[0]?.slice(0, 80) || undefined;
const count = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const minute = (iso: string) => `${iso.slice(0, 16).replace('T', ' ')}Z`;
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
