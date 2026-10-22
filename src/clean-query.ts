import { selectionSchema, type Query } from './schema.js';
import type { Captures } from './captures.js';
import { messageContent as content } from './content.js';
import { EvidenceReader, evidenceVersion } from './evidence.js';
import { selectPage } from './composable-query.js';
import { surfaceRoles } from './vocabulary.js';

interface Entry {
  id: string; captureId: string; sessionId: string; type: string;
  role?: string; toolCallId?: string; toolName?: string; requestId?: string;
  sourceEntryId?: string; body: any;
}

function output(body: any): any {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body ?? null;
  // Native message envelopes contain provider metadata. Hook result bodies do
  // not: keep their meaningful extra fields (details, structuredContent, etc.).
  if (body.message || body.role === 'toolResult') return content((body.message ?? body).content);
  const { content: blocks, ...extra } = body;
  const text = content(blocks);
  const structured = extra.structuredContent;
  // Pi's shell result repeats stdout inside a timing/exit-status envelope.
  // Flatten only this recognized successful, untruncated duplicate. Arbitrary
  // structured results (and failed/truncated envelopes) retain their fields.
  if (structured && structured.output === text && structured.truncated === false && structured.exit_code === 0
    && Object.keys(structured).every(k => ['output', 'truncated', 'exit_code', 'wall_time_seconds'].includes(k))) {
    delete extra.structuredContent;
  }
  for (const key of Object.keys(extra)) {
    if (extra[key] === null || typeof extra[key] === 'object' && !Object.keys(extra[key]).length) delete extra[key];
  }
  if (!Object.keys(extra).length && blocks !== undefined) return text;
  return blocks === undefined ? extra : { content: text, ...extra };
}

/** Pure presentation: correlate tools within a capture, prefer hook records over
 * duplicate native evidence, and keep messages in recorded observation order.
 * A tool row is positioned at its start and contains its result when available.
 */
export function cleanEntries(entries: Entry[], mode = 'events'): Record<string, unknown>[] {
  const key = (e: Entry, id = e.toolCallId) => `${e.captureId}:${id}`;
  const starts = new Set(entries.filter(e => e.type === 'tool_started').map(e => key(e)));
  const finishes = new Map<string, Entry>();
  const inputs = new Map(entries.filter(e => e.type === 'input').map(e => [e.id, e]));
  for (const e of entries) if (e.type === 'tool_finished') finishes.set(key(e), e);
  const nativeResults = new Map<string, Entry>();
  for (const e of entries) {
    const message = e.body?.message ?? e.body;
    if (message?.role === 'toolResult') nativeResults.set(key(e, message.toolCallId), e);
  }
  const seenTools = new Set<string>();
  const seenSources = new Set<string>();
  const matchedInputs = new Set<string>();
  const rows: Record<string, unknown>[] = [];
  const showTools = ['events', 'tools', 'outputs'].includes(mode);
  const showUsers = ['events', 'requests', 'messages', 'intent'].includes(mode);
  const showAssistant = ['events', 'messages', 'intent'].includes(mode);

  function tool(e: Entry, id: string | undefined, name: string | undefined, input: unknown) {
    const identity = key(e, id ?? e.id);
    if (seenTools.has(identity)) return;
    seenTools.add(identity);
    const result = finishes.get(identity) ?? nativeResults.get(identity);
    if (showTools) rows.push({ tool: name ?? 'unknown', input: input ?? null,
      output: result ? output(result.body) : null });
  }

  for (const e of entries) {
    const body = e.body;
    if (e.type === 'input') {
      if (showUsers) rows.push({ user: body?.images?.length ? { text: body.text, images: body.images } : body?.text ?? null });
    } else if (e.type === 'tool_started') {
      tool(e, e.toolCallId, e.toolName, body?.input);
    } else if (e.type === 'tool_finished') {
      if (!starts.has(key(e))) tool(e, e.toolCallId, e.toolName, null);
    } else if (e.type === 'source_record' || e.type === 'message') {
      if (e.sourceEntryId) {
        const sourceKey = `${e.sessionId}:${e.sourceEntryId}`;
        if (seenSources.has(sourceKey)) continue;
        seenSources.add(sourceKey);
      }
      const message = body?.message ?? body;
      const text = content(message?.content, true);
      if (message?.role === 'user') {
        // Only collapse a matching native copy linked to a specific input, once.
        // Equal text alone must not erase deliberately repeated user messages.
        const input = e.requestId ? inputs.get(e.requestId) : undefined;
        if (input && !input.body?.images?.length && text === input.body?.text && !matchedInputs.has(input.id)) {
          matchedInputs.add(input.id); continue;
        }
        if (showUsers) rows.push({ user: text });
      } else if (message?.role === 'assistant') {
        if (showAssistant && text !== '' && text !== null && (!Array.isArray(text) || text.length)) rows.push({ assistant: text });
        for (const block of Array.isArray(message.content) ? message.content : []) {
          if (block.type === 'toolCall' && !starts.has(key(e, block.id))) tool(e, block.id, block.name, block.arguments);
        }
      } else if (message?.role === 'toolResult' && !starts.has(key(e, message.toolCallId))) {
        tool(e, message.toolCallId, message.toolName, null);
      }
    }
  }
  return rows;
}

/** Daemon-owned formatting reads only conversation records, using the same SQL
 * selection and body reader as detailed queries. No client compatibility path.
 */
export function cleanQuery(captures: Captures, request: Query): Record<string, unknown>[] {
  if (request.preset && !['intent', 'timeline', 'interaction-review'].includes(request.preset)
    || request.find === 'changes' || request.select || request.include || request.cursor) {
    throw new Error('Clean mode supports conversation selections without select/include/cursor. Use the normal view for patches and pagination.');
  }
  const version = evidenceVersion(captures, request.readVersion);
  const mode = request.preset === 'intent' ? 'intent' : request.find ?? 'events';
  const includeTools = ['events', 'tools', 'outputs'].includes(mode);
  const base = selectionSchema.parse({ find: 'events', captureId: request.captureId, scope: request.scope,
    where: request.where, readVersion: version, limit: 100 });
  // No gaps, file changes, administrative source entries or duplicate call
  // references are loaded just to throw them away during rendering.
  // Wider than resources.messages on purpose: tool-result messages pair outputs
  // with calls, and cleanEntries drops them again when tools are hidden.
  const roles = [...surfaceRoles, ...(includeTools ? ['toolResult'] : [])].map(role => `'${role}'`).join(',');
  const condition = `(r.type IN ('input','message'${includeTools ? ",'tool_started','tool_finished'" : ''})
    OR (r.type='source_record' AND r.role IN (${roles})))`;
  const entries: Entry[] = [];
  const reader = new EvidenceReader(captures);
  let cursor: string | undefined;
  let loadedChars = 0;
  do {
    const page = selectPage(captures, { ...base, cursor }, version, condition);
    for (const record of page.records) {
      const raw = reader.read(record, 'data');
      if (raw && raw.length > 4 * 1024 * 1024) throw new Error('Body exceeds clean-view read limit; use normal inspection.');
      loadedChars += raw?.length ?? 0;
      if (loadedChars > 16 * 1024 * 1024) throw new Error('Clean view exceeds 16 MiB of source evidence; narrow scope/where.');
      entries.push({ ...record, sessionId: captures.get(record.captureId).manifest.piSessionId,
        body: raw === undefined ? null : JSON.parse(raw) });
    }
    if (entries.length > 10000) throw new Error('Clean view exceeds 10,000 records; narrow scope/where.');
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  const rows = cleanEntries(entries, mode);
  if (rows.length > request.limit) throw new Error(`Clean view has ${rows.length} entries; raise --limit (maximum 100) or narrow scope/where. Nothing was truncated.`);
  if (JSON.stringify(rows).length > request.maxChars) throw new Error('Clean view exceeds maxChars; raise --max-chars (maximum 32000) or narrow scope/where. Nothing was truncated.');
  return rows;
}
