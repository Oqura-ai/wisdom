import fs from 'node:fs';
import path from 'node:path';
import type { Captures } from './captures.js';
import { ledgerSchema, type LedgerRecord, type LedgerRequest, type Manifest } from './schema.js';
import { EvidenceReader, evidenceVersion } from './evidence.js';
import { betterResult, conversation, type Change, type Subagent, type TurnItem } from './conversation.js';
import { adapter } from './harnesses/index.js';

/** The agent-facing ledger. Two moves over one session: glance (its shape and one entry
 * per turn) and open (one position, whole). Responses are plain text in recorded order.
 * Nothing is summarized or reworded; tool outputs and patches are never cut by a rule.
 * The only limit is the ceiling below, and a limited response says exactly where to continue.
 */
export const CEILING = 80_000;
/** A longer line is split so the ceiling can always be met; continued pieces start with ⤷. */
const WRAP = 2_000;
const INDENT = '    ';

type Tool = Extract<TurnItem, { kind: 'tool' }>;
type Context = { captures: Captures; version: number; manifest: Manifest; reader: EvidenceReader };

export function ledger(captures: Captures, input: unknown): string {
  const parsed = ledgerSchema.safeParse(input);
  if (!parsed.success) throw new Error(`Invalid ledger request. ${parsed.error.issues.map(i => `${i.path.join('.') || 'request'}: ${i.message}`).join('; ')}. `
    + 'Use { glance: true } to list sessions, { capture, glance: true } for one session, or { capture, open: "t1" }.');
  const request = parsed.data;
  if (!!request.glance === !!request.open) throw new Error('Send exactly one of glance or open.');
  const version = evidenceVersion(captures, request.at);
  if (request.glance && !request.capture) return sessions(captures, version, request.from);
  if (!request.capture) throw new Error('open needs capture: an ID from glance, or "latest".');
  const manifest = resolveCapture(captures, request.capture, version);
  const context: Context = { captures, version, manifest, reader: new EvidenceReader(captures) };
  return request.glance ? glance(context, request.from) : open(context, request.open!, request.from);
}

function resolveCapture(captures: Captures, ref: string, version: number): Manifest {
  const manifests = captures.database.manifests();
  if (!manifests.length) throw new Error('No sessions are recorded yet.');
  if (ref === 'latest') {
    // A session nobody prompted has nothing to read; it stays listed by a plain glance.
    const prompted = new Set(captures.database.sql.prepare(`SELECT DISTINCT capture_id AS id FROM records
      WHERE type='input' AND json_extract(body,'$.agentId') IS NULL AND revision<=?`).all(version).map(row => String(row.id)));
    const candidates = manifests.filter(m => prompted.has(m.captureId));
    return (candidates.length ? candidates : manifests).reduce((a, b) => b.startedAt > a.startedAt ? b : a);
  }
  const exact = manifests.find(m => m.captureId === ref);
  if (exact) return exact;
  const matches = ref.length >= 8 ? manifests.filter(m => m.captureId.startsWith(ref)) : [];
  if (matches.length === 1) return matches[0];
  throw new Error(matches.length > 1 ? `"${ref}" matches ${matches.length} sessions; use more of the ID.`
    : `No session matches "${ref}". Glance without capture to list sessions.`);
}

// ---------- response assembly ----------

/** Cut at a line boundary under the ceiling. The footer is the only place a response
 * says whether it is complete, and it names the exact request that continues it.
 */
function respond(lines: string[], from: number | undefined, next: LedgerRequest): string {
  const all: string[] = [];
  let wrapped = false;
  for (const line of lines) {
    if (line.length <= WRAP) { all.push(line); continue; }
    wrapped = true;
    for (let i = 0; i < line.length; i += WRAP) all.push((i ? '⤷ ' : '') + line.slice(i, i + WRAP));
  }
  const start = (from ?? 1) - 1;
  if (start > 0 && start >= all.length) throw new Error(`from ${from} is past the end: this response has ${all.length} lines.`);
  let end = start, size = 0;
  while (end < all.length && (end === start || size + all[end].length + 1 <= CEILING)) size += all[end++].length + 1;
  const footer = end < all.length
    ? `limited · lines ${start + 1}–${end} of ${all.length} · continue: ${JSON.stringify({ ...next, from: end + 1 })}`
    : start > 0 ? `complete · lines ${start + 1}–${end} of ${all.length}` : `complete · ${all.length} lines`;
  return [...all.slice(start, end), '', footer + (wrapped ? ' · lines over 2,000 characters are split; ⤷ marks a continued piece' : '')].join('\n');
}

/** A body under its label: one line beside the label, more lines indented below it.
 * `lead` replaces the indent on the first line only (a turn's position).
 */
function block(out: string[], indent: string, label: string, text: string | undefined, lead = indent): void {
  if (text === undefined) return;
  const lines = text.replace(/(\r?\n)+$/, '').split(/\r?\n/);
  if (lines.length === 1) out.push(`${lead}${label.padEnd(8)}  ${lines[0]}`);
  else { out.push(`${lead}${label}`); for (const line of lines) out.push(`${indent}${INDENT}${line}`); }
}

const number = (n: number) => n.toLocaleString('en-US');
const minute = (iso?: string) => iso ? iso.slice(0, 16).replace('T', ' ') + 'Z' : '';
const plural = (n: number, word: string) => `${number(n)} ${word}${n === 1 ? '' : 's'}`;
const short = (id: string) => id.slice(0, 8);
const ms = (value?: number) => value === undefined ? '' : value >= 1000 ? `${(value / 1000).toFixed(1)} s` : `${value} ms`;

function rows(context: Context, where: string, bindings: (string | number)[] = []): LedgerRecord[] {
  return context.captures.database.records(`capture_id=? AND revision<=? AND ${where}`,
    [context.manifest.captureId, context.version, ...bindings], 'ORDER BY seq');
}

function json(context: Context, record: LedgerRecord): any {
  try { const raw = context.reader.read(record, 'data'); return raw === undefined ? undefined : JSON.parse(raw); }
  catch { return undefined; }
}

// ---------- session structure ----------

interface Shape {
  turns: LedgerRecord[];
  agents: string[];
  /** Main turn each subagent belongs to (by its spawning call, or its first linked record). */
  agentTurn: Map<string, string | undefined>;
  records: LedgerRecord[];
}

const structureTypes = ['input', 'tool_started', 'tool_finished', 'file_change', 'gap', 'subagent_started', 'subagent_stopped', 'agent_settled', 'usage'];

/** Turns are the user's own inputs, in recorded order; subagents are numbered by first appearance. */
function shape(context: Context): Shape {
  const records = rows(context, `(type IN (${structureTypes.map(() => '?').join(',')}) OR (type IN ('message','source_record') AND role='assistant'))`, structureTypes)
    .filter(r => !r.internalAgent);
  const turns = records.filter(r => r.type === 'input' && !r.agentId);
  const turnIds = new Set(turns.map(t => t.id));
  const agents: string[] = [];
  for (const r of records) if (r.agentId && !agents.includes(r.agentId) && r.type !== 'usage') agents.push(r.agentId);
  const agentTurn = new Map<string, string | undefined>();
  for (const agent of agents) {
    const spawn = records.find(r => r.type === 'tool_finished' && r.childAgentId === agent && r.requestId && turnIds.has(r.requestId));
    const linked = records.find(r => r.agentId === agent && r.requestId && turnIds.has(r.requestId));
    const first = records.find(r => r.agentId === agent)!;
    const before = turns.filter(t => t.seq < first.seq).at(-1);
    agentTurn.set(agent, spawn?.requestId ?? linked?.requestId ?? before?.id);
  }
  return { turns, agents, agentTurn, records };
}

/** Per call: the start, and the result a hook reported (preferred) or the transcript established. */
function calls(records: LedgerRecord[]) {
  const finishes = new Map<string, LedgerRecord>();
  for (const r of records) if (r.type === 'tool_finished' && r.toolCallId) {
    if (betterResult(finishes.get(r.toolCallId), r)) finishes.set(r.toolCallId, r);
  }
  const started = new Map<string, LedgerRecord>();
  for (const r of records) if (r.type === 'tool_started' && r.toolCallId && !started.has(r.toolCallId)) started.set(r.toolCallId, r);
  const list = [...started.values()];
  return { count: list.length, failed: list.filter(r => finishes.get(r.toolCallId!)?.isError === true).length,
    pending: list.filter(r => !finishes.has(r.toolCallId!)).length };
}

function changeFacts(records: LedgerRecord[]): string {
  const changes = records.filter(r => r.type === 'file_change');
  if (!changes.length) return 'no changes';
  const paths = [...new Set(changes.map(c => c.worktree ? `${c.path ?? '?'} in worktree ${c.worktree}` : c.path ?? '?'))];
  const outside = changes.filter(c => c.attribution === 'external-or-unknown').length;
  return `changed ${paths.join(', ')}${outside ? ` (${plural(outside, 'change')} outside any tool call)` : ''}`;
}

function callFacts(records: LedgerRecord[], recording: boolean): string {
  const c = calls(records);
  return [c.count ? plural(c.count, 'tool call') : 'no tool calls', c.failed ? `${number(c.failed)} failed` : '',
    c.pending ? `${number(c.pending)} ${recording ? 'pending' : 'without a recorded result'}` : ''].filter(Boolean).join(' · ');
}

/** Tokens once per model response; native history from before the capture is excluded. */
function tokens(records: LedgerRecord[]): { total: number; cost?: number; callsAfterCost: number } {
  const seen = new Set<string>();
  let total = 0, cost: number | undefined, sessionCost: number | undefined, callsAfterCost = 0;
  for (const r of records) {
    if (r.type !== 'usage' || !r.usage || r.beforeCapture) continue;
    if (r.usageScope === 'session-total') { sessionCost = r.usage.costUsd; callsAfterCost = 0; continue; }
    const key = `${r.agentId ?? ''}:${r.usageKey}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // A subagent's usage is indexed when it stops, so its place in the records is not its time.
    if (!r.agentId) callsAfterCost++;
    total += r.usage.input + r.usage.cacheRead + r.usage.cacheWrite + r.usage.output;
    if (typeof r.usage.costUsd === 'number') cost = (cost ?? 0) + r.usage.costUsd;
  }
  // A harness's running total is only as new as its last report.
  return { total, cost: sessionCost ?? cost, callsAfterCost: sessionCost === undefined ? 0 : callsAfterCost };
}

/** An input says so when it is not a person's prompt seen live: a notice the harness wrote,
 * or a prompt read from the session file because no hook reported it. */
const inLabel = (turn: LedgerRecord) => {
  const notes = [turn.notice ? 'harness notice' : '', turn.inputBasis === 'session-file' ? 'from session file' : ''].filter(Boolean);
  return notes.length ? `in (${notes.join(', ')})` : 'in';
};

/** Where a change happened, when that is a linked worktree: its path is relative to it. */
const place = (change: { path?: string; worktree?: string; branch?: string }) =>
  `${change.path ?? '?'}${change.worktree ? ` in worktree ${change.worktree}${change.branch ? ` (branch ${change.branch})` : ''}` : ''}`;

function inputText(context: Context, record: LedgerRecord): string {
  const data = json(context, record);
  if (data === undefined) return `[input body unavailable · ${record.summary}]`;
  return (data.text ?? '') + (data.images?.length ? `\n[${plural(data.images.length, 'image')} attached]` : '');
}

function lastReply(context: Context, records: LedgerRecord[]): string | undefined {
  const reply = records.filter(r => ['message', 'source_record'].includes(r.type) && r.role === 'assistant' && r.summary).at(-1);
  if (reply) return reply.summary.length >= 240 ? reply.summary + '…' : reply.summary;
  const settled = records.filter(r => r.type === 'agent_settled').at(-1);
  const text = settled ? json(context, settled)?.lastAssistantMessage : undefined;
  if (typeof text !== 'string' || !text.trim()) return undefined;
  const flat = text.replace(/\s+/g, ' ').trim();
  return (flat.length > 240 ? flat.slice(0, 240) + '…' : flat) + ' (from hook)';
}

// ---------- glance ----------

function sessions(captures: Captures, version: number, from?: number): string {
  const manifests = captures.database.manifests().sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  if (!manifests.length) return respond(['No sessions are recorded yet.'], from, { glance: true, at: version });
  const counts = new Map(captures.database.sql.prepare(`SELECT capture_id AS id, count(*) AS n FROM records
    WHERE type='input' AND json_extract(body,'$.agentId') IS NULL AND revision<=? GROUP BY capture_id`).all(version)
    .map(row => [String(row.id), Number(row.n)]));
  const lines = [`captures · ${number(manifests.length)}, newest first · version ${version}`, ''];
  for (const m of manifests) {
    lines.push(`${m.captureId}  ${m.harness}  ${m.status}  ${minute(m.startedAt)}  ${plural(counts.get(m.captureId) ?? 0, 'turn')}  ${m.workspaceRoot}`);
  }
  lines.push('', 'Glance one with { capture: "<id or first 8 characters>", glance: true }.');
  return respond(lines, from, { glance: true, at: version });
}


function glance(context: Context, from?: number): string {
  const { manifest, version } = context;
  const ledger = context.captures.get(manifest.captureId);
  const { turns, agents, agentTurn, records } = shape(context);
  const recording = manifest.status === 'recording';
  const main = records.filter(r => !r.agentId);
  const t = tokens(records);
  const lines: string[] = [
    `session ${manifest.captureId} · ${manifest.harness}${manifest.harnessVersion ? ` ${manifest.harnessVersion}` : ''} · ${manifest.status}${manifest.endReason ? ` (${manifest.endReason})` : ''} · version ${version}`,
    // A resume run outside Wisdom loads no hooks, so its work would never reach the ledger.
    `resume with: wisdom resume ${manifest.captureId}`,
    `workspace ${manifest.workspaceRoot}`,
    `started ${minute(manifest.startedAt)}${manifest.endedAt ? ` · ended ${minute(manifest.endedAt)}` : ''}`,
    [plural(turns.length, 'turn'), callFacts(records, recording), plural(records.filter(r => r.type === 'file_change').length, 'change'),
      plural(agents.length, 'subagent'), `${number(t.total)} tokens`, t.cost === undefined ? '' : `$${t.cost.toFixed(4)} reported${t.callsAfterCost ? ` before the last ${plural(t.callsAfterCost, 'model call')}` : ''}`].filter(Boolean).join(' · '),
  ];
  if (!fs.existsSync(ledger.dir)) lines.push('evidence folder missing: inputs, outputs and patches cannot be read');
  // A kind that repeats three or more times is one line with its count, first and last.
  // Every gap stays a record; only the glance line is shared.
  const gaps = records.filter(r => r.type === 'gap');
  const byKind = new Map<string, LedgerRecord[]>();
  for (const gap of gaps) {
    const kind = gap.summary.split(':', 1)[0];
    byKind.set(kind, [...byKind.get(kind) ?? [], gap]);
  }
  for (const same of byKind.values()) {
    if (same.length < 3) for (const gap of same) lines.push(`not recorded  ${gap.summary} (seq ${gap.seq})`);
    else {
      const [first, last] = [same[0], same.at(-1)!];
      const detail = (gap: LedgerRecord) => gap.summary.slice(gap.summary.indexOf(':') + 1);
      lines.push(`not recorded  ${first.summary.split(':', 1)[0]} ×${same.length} · first (seq ${first.seq}): ${detail(first)} · last (seq ${last.seq}): ${detail(last)}`);
    }
  }
  for (const gap of ledger.recoveryGaps) lines.push(`not recorded  ${gap}`);

  const byTurn = (id: string) => main.filter(r => r.requestId === id);
  turns.forEach((turn, index) => {
    const own = byTurn(turn.id);
    lines.push('');
    block(lines, INDENT, inLabel(turn), inputText(context, turn), `t${index + 1}`.padEnd(4));
    const out = lastReply(context, own);
    if (out) lines.push(`${INDENT}out       ${out}`);
    lines.push(`${INDENT}${[callFacts(own, recording), changeFacts(own)].join(' · ')}`);
    agents.forEach((agent, i) => {
      if (agentTurn.get(agent) !== turn.id) return;
      const work = records.filter(r => r.agentId === agent);
      const type = work.filter(r => r.type === 'subagent_started' || r.type === 'subagent_stopped')
        .map(r => json(context, r)?.agentType).find(t => typeof t === 'string' && t);
      lines.push(`${INDENT}subagent a${i + 1}${type ? ` (${type})` : ''} · ${callFacts(work, recording)} · ${changeFacts(work)}`);
    });
  });

  const outside = main.filter(r => !r.requestId && ['file_change', 'tool_started', 'tool_finished'].includes(r.type));
  const outsideWork = outside.some(r => r.type !== 'tool_finished');
  const unplaced = agents.filter(agent => !agentTurn.get(agent));
  if (outsideWork || unplaced.length) {
    lines.push('', `outside   ${[outsideWork ? `${callFacts(outside, recording)} · ${changeFacts(outside)}` : '',
      unplaced.length ? `subagents ${unplaced.map(a => `a${agents.indexOf(a) + 1}`).join(', ')}` : ''].filter(Boolean).join(' · ')} · open "outside"`);
  }
  if (!turns.length && !outsideWork && !unplaced.length) lines.push('', 'No turns recorded yet.');
  return respond(lines, from, { capture: manifest.captureId, glance: true, at: version });
}

// ---------- open ----------

function open(context: Context, position: string, from?: number): string {
  const match = /^(?:(t|a)(\d+)(?:\/c(\d+))?|(outside))$/.exec(position);
  if (!match) throw new Error(`"${position}" is not a position. Use t3 (a turn), t3/c2 (a tool call), a1 (a subagent), a1/c2, or outside.`);
  const next = { capture: context.manifest.captureId, open: position, at: context.version };
  if (match[4]) return respond(renderOutside(context), from, next);
  const s = shape(context);
  const index = Number(match[2]) - 1;
  const call = match[3] === undefined ? undefined : Number(match[3]);
  if (match[1] === 't') {
    const turn = s.turns[index];
    if (!turn) throw new Error(`t${index + 1} does not exist: this session has ${s.turns.length ? `t1–t${s.turns.length}` : 'no turns'} at version ${context.version}.`);
    const view = conversation(context.captures, { captureId: context.manifest.captureId, requestId: turn.id, readVersion: context.version });
    const header = `t${index + 1} · session ${short(context.manifest.captureId)} · version ${context.version} · ${number(view.tokens.total)} tokens`;
    const lines = [header];
    // A single call is opened to read its bodies; the turn's input is one glance away.
    if (call === undefined) { block(lines, '', inLabel(turn), inputText(context, turn)); lines.push(''); }
    const body = renderItems(context, s, view.items, `t${index + 1}`, call);
    if (!body.length) body.push('Nothing else is recorded in this turn yet: no thinking, replies, tool calls or changes.');
    return respond(lines.concat(body, issueLines(view.issues)), from, next);
  }
  const agent = s.agents[index];
  if (!agent) throw new Error(`a${index + 1} does not exist: this session has ${s.agents.length ? `a1–a${s.agents.length}` : 'no subagents'} at version ${context.version}.`);
  const turnId = s.agentTurn.get(agent);
  const subagent = turnId ? findSubagent(conversation(context.captures, { captureId: context.manifest.captureId, requestId: turnId, readVersion: context.version }).items, agent) : undefined;
  const turnNo = s.turns.findIndex(t => t.id === turnId) + 1;
  if (!subagent) {
    // Not placed under a turn: its records are still listed, in order, so nothing is hidden.
    const lines = [`a${index + 1} · session ${short(context.manifest.captureId)} · version ${context.version} · not linked to a turn`, ''];
    const own = new Set(s.records.filter(r => r.agentId === agent && r.toolCallId).map(r => r.toolCallId));
    for (const r of s.records.filter(r => r.agentId === agent || r.toolCallId && own.has(r.toolCallId))) {
      lines.push(`seq ${r.seq}  ${r.type}  ${r.summary}${r.isError ? ' · failed' : ''}`);
    }
    return respond(lines, from, next);
  }
  const lines = [`a${index + 1} · subagent${subagent.agentType ? ` (${subagent.agentType})` : ''} in t${turnNo} · session ${short(context.manifest.captureId)} · version ${context.version}`];
  block(lines, '', 'task', subagent.task?.text);
  lines.push('');
  const body = renderItems(context, s, subagent.items, `a${index + 1}`, call);
  if (call === undefined && subagent.report) { body.push(''); block(body, '', 'report', subagent.report.text); }
  return respond(lines.concat(body), from, next);
}

function findSubagent(items: TurnItem[], agent: string): Subagent | undefined {
  for (const item of items) {
    const subagent = item.kind === 'subagent' ? item.subagent : item.kind === 'tool' ? item.subagent : undefined;
    if (!subagent) continue;
    if (subagent.agentId === agent) return subagent;
    const nested = findSubagent(subagent.items, agent);
    if (nested) return nested;
  }
  return undefined;
}

function issueLines(issues: { id: string; reason: string }[]): string[] {
  return issues.length ? ['', ...issues.map(issue => `unreadable  record ${issue.id}: ${issue.reason}`)] : [];
}

/** Items in recorded order, calls numbered within their scope, all patches together at the end. */
function renderItems(context: Context, s: Shape, items: TurnItem[], scope: string, only?: number): string[] {
  const harness = adapter(context.manifest.harness);
  const recording = context.manifest.status === 'recording';
  const lines: string[] = [];
  const patches: { change: Change; owner?: string }[] = [];
  const tools = items.filter((item): item is Tool => item.kind === 'tool');
  if (only !== undefined && !tools[only - 1]) {
    throw new Error(`${scope}/c${only} does not exist: ${scope} has ${tools.length ? `c1–c${tools.length}` : 'no tool calls'}.`);
  }
  const patchRef = (change: Change, owner?: string) => { patches.push({ change, owner }); return `p${patches.length}`; };
  for (const item of items) {
    if (only !== undefined && !(item.kind === 'tool' && tools.indexOf(item) === only - 1)) continue;
    if (item.kind === 'text') block(lines, '', item.source === 'hook' ? 'reply (from hook)' : 'reply', item.text.text);
    else if (item.kind === 'thinking') {
      if (item.redacted || !item.text.text) lines.push(`thinking  redacted${item.durationMs ? ` · ${ms(item.durationMs)}` : ''} (it happened; its text was not recorded)`);
      else block(lines, '', `thinking${item.durationMs ? ` · ${ms(item.durationMs)}` : ''}`, item.text.text);
    } else if (item.kind === 'change') {
      lines.push(`change    ${place(item)} · ${patchRef(item)} · not made by a recorded tool call`);
    } else if (item.kind === 'subagent') {
      const n = s.agents.indexOf(item.subagent.agentId) + 1;
      lines.push(`subagent  a${n}${item.subagent.agentType ? ` (${item.subagent.agentType})` : ''} · not linked to a call · open a${n}`);
    } else {
      const c = tools.indexOf(item) + 1;
      const input = parse(item.input?.text);
      const target = relative(context, harness.toolTarget(item.name, input));
      const view = only !== undefined ? 'full' : harness.toolView(item.name);
      const refs = item.changes.map(change => patchRef(change, `c${c}`));
      const step = harness.isScriptStep(item.name);
      const status = step ? 'script step' : item.status === 'ok' ? 'ok' : item.status === 'error' ? 'failed'
        : item.status === 'pending' ? recording ? 'pending' : 'no result recorded' : 'outcome not recorded';
      const child = item.subagent ? s.agents.indexOf(item.subagent.agentId) + 1 : 0;
      lines.push([`c${c}  ${item.name}${target ? ` ${target}` : ''}`, status, ms(item.durationMs),
        item.resultBasis ? 'result from transcript' : '', item.native && !step ? 'seen only in transcript' : '',
        refs.length ? `→ ${refs.join(', ')}` : '', child ? `→ a${child} (open a${child})` : ''].filter(Boolean).join(' · '));
      // The change is the evidence: an edit's input and output repeat it, so they are shown once, as its patch.
      if (view === 'patch' && refs.length && item.status !== 'error') {
        lines.push(`${INDENT}input and output repeat ${refs.join(', ')} · open ${scope}/c${c} to read them`);
        continue;
      }
      block(lines, INDENT, 'input', compact(input, item.input?.text));
      if (view === 'file' && item.status === 'ok' && item.output) {
        lines.push(`${INDENT}output    file content, ${plural(item.output.text.length, 'character')} · open ${scope}/c${c} to read it`);
      } else if (item.output) block(lines, INDENT, 'output', item.output.text);
      else if (item.status !== 'pending') lines.push(`${INDENT}output    none recorded`);
    }
  }
  if (patches.length) lines.push('');
  patches.forEach(({ change, owner }, i) => {
    const stat = diffStat(change.patch?.text);
    const basis = change.attribution === 'observed-during-tool' && owner ? `observed during ${owner}` : change.attribution ?? 'attribution unknown';
    lines.push([`p${i + 1}  ${place(change)}`, change.operation, stat, basis].filter(Boolean).join(' · '));
    if (change.patch) for (const line of change.patch.text.replace(/\n$/, '').split(/\r?\n/)) {
      if (!/^Index: /.test(line) && !/^=+$/.test(line)) lines.push(INDENT + line);
    } else lines.push(`${INDENT}patch not recorded${change.patchUnavailable ? `: ${change.patchUnavailable}` : ''}`);
  });
  return lines;
}

function renderOutside(context: Context): string[] {
  const records = rows(context, "request_id IS NULL AND type IN ('file_change','tool_started','tool_finished')").filter(r => !r.agentId && !r.internalAgent);
  const lines = [`outside · session ${short(context.manifest.captureId)} · version ${context.version} · recorded with no turn (before the first input, or between turns)`, ''];
  const starts = records.filter(r => r.type === 'tool_started');
  for (const r of starts) {
    const result = records.find(f => f.type === 'tool_finished' && f.toolCallId === r.toolCallId);
    lines.push(`call  ${r.toolName ?? 'tool'} · ${result ? result.isError ? 'failed' : 'ok' : 'no result recorded'} · seq ${r.seq}`);
    block(lines, INDENT, 'input', compact(json(context, r)?.input));
  }
  const changes = records.filter(r => r.type === 'file_change');
  changes.forEach((r, i) => {
    let patch: string | undefined;
    try { patch = context.reader.read(r, 'patch'); } catch (error) { patch = undefined; lines.push(`unreadable  record ${r.id}: ${error}`); }
    lines.push([`p${i + 1}  ${place(r)}`, r.operation, diffStat(patch), r.attribution ?? 'attribution unknown', `seq ${r.seq}`].filter(Boolean).join(' · '));
    if (patch) for (const line of patch.replace(/\n$/, '').split(/\r?\n/)) { if (!/^Index: /.test(line) && !/^=+$/.test(line)) lines.push(INDENT + line); }
    else lines.push(`${INDENT}patch not recorded${r.patchUnavailable ? `: ${r.patchUnavailable}` : ''}`);
  });
  if (!starts.length && !changes.length) lines.push('Nothing was recorded outside a turn.');
  return lines;
}

function parse(text?: string): unknown {
  if (text === undefined) return undefined;
  try { return JSON.parse(text); } catch { return text; }
}

/** Short structured input stays on one line; longer input keeps its indented form. */
function compact(value: unknown, original?: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return value;
  const line = JSON.stringify(value);
  return line.length <= 200 ? line : original ?? JSON.stringify(value, null, 2);
}

function relative(context: Context, target?: string): string | undefined {
  if (!target) return undefined;
  const rel = path.isAbsolute(target) ? path.relative(context.manifest.workspaceRoot, target) : target;
  return (rel.startsWith('..') ? target : rel).replace(/\\/g, '/');
}

function diffStat(patch?: string): string {
  if (!patch) return '';
  let add = 0, del = 0;
  for (const line of patch.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) add++;
    else if (line.startsWith('-') && !line.startsWith('---')) del++;
  }
  return `+${add} −${del}`;
}
