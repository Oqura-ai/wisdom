/** Public query names live here. The engine and harness discovery share these
 * constants so a misspelled field cannot quietly change the meaning of a query.
 */
// The single definition of conversation surface. SQL selection and body reading
// both derive from it, so a new role cannot be a message in one view only.
export const surfaceRoles = ['user', 'assistant'] as const;
const roleList = surfaceRoles.map(role => `'${role}'`).join(',');

export function isSurfaceRecord(record: { type: string; role?: string }): boolean {
  const surfaceRole = (surfaceRoles as readonly string[]).includes(record.role ?? '');
  return record.type === 'input' || record.type === 'message' && (record.role === undefined || surfaceRole)
    || record.type === 'source_record' && surfaceRole;
}

export const resources = {
  requests: "r.type='input'",
  messages: `((r.type='message' AND (r.role IS NULL OR r.role IN (${roleList}))) OR (r.type='source_record' AND r.role IN (${roleList})))`,
  tools: "r.type='tool_started'",
  outputs: "r.type='tool_finished'",
  changes: "r.type='file_change'",
  events: '1=1',
} as const;

export const fields = [
  'id', 'captureId', 'sessionId', 'seq', 'observedAt', 'type', 'summary', 'parentId',
  'requestId', 'linkBasis', 'toolCallId', 'parentToolCallId', 'toolName', 'role', 'path',
  'operation', 'isError', 'attribution', 'activeToolCallIds', 'beforeHash', 'afterHash',
  'patchUnavailable', 'sourceEntryId', 'sourceParentId', 'sourceTimestamp',
  'content', 'data', 'patch', 'status',
] as const;

// Expressions are code, never user strings. Each filter value is a SQL binding.
export const filterColumns: Record<string, string> = {
  id: 'r.id', captureId: 'r.capture_id', sessionId: 'c.session_id', seq: 'r.seq',
  type: 'r.type', parentId: 'r.parent_id', requestId: 'r.request_id', toolCallId: 'r.tool_call_id',
  toolName: 'r.tool_name', path: 'r.path', role: 'r.role', isError: 'r.is_error',
  observedAt: "json_extract(r.body,'$.observedAt')", operation: "json_extract(r.body,'$.operation')",
  attribution: "json_extract(r.body,'$.attribution')", text: "json_extract(r.body,'$.summary')",
};

export const relations = ['request', 'messages', 'tools', 'outputs', 'changes', 'source', 'parent', 'children'] as const;
export const presets = {
  intent: { find: 'events', where: { surface: true }, select: ['type', 'role', 'content', 'linkBasis'] },
  timeline: { find: 'events' },
  changes: { find: 'changes', select: ['path', 'operation', 'attribution', 'activeToolCallIds', 'patch', 'patchUnavailable'] },
  failures: { find: 'outputs', where: { isError: true }, select: ['toolName', 'isError', 'content'],
    include: { tools: { select: ['toolName', 'summary'] }, changes: { select: ['path', 'patch', 'attribution'] } } },
  'file-history': { find: 'changes', select: ['path', 'operation', 'attribution', 'patch', 'patchUnavailable'] },
  'interaction-review': { find: 'requests', select: ['content'], include: {
    messages: { select: ['role', 'content', 'linkBasis'] },
    changes: { select: ['path', 'operation', 'patch', 'patchUnavailable', 'attribution', 'activeToolCallIds', 'linkBasis'] },
    outputs: { select: ['toolName', 'isError', 'content', 'linkBasis'] },
  } },
} as const;

export const vocabulary = {
  queryVersion: 3,
  terms: {
    workspace: 'Canonical project directory. File paths are relative to this directory.',
    sessionId: 'Pi logical session ID; one session can have several recording captures.',
    captureId: 'One continuous Wisdom recording period, with its own sequence numbers.',
    request: 'Recorded input event, not proof of when the model consumed queued input.',
    toolCallId: 'Harness call/result correlation ID, scoped to a capture.',
    requestId: 'Recorded input associated with an event. Inspect linkBasis before inferring causality.',
    linkBasis: 'recorded-parent follows hook parentage; observed-input-window is only temporal association.',
    readVersion: 'Global committed SQLite record revision; fixes the evidence visible to this query and its includes.',
    lastSeq: 'Latest visible per-capture sequence; use readVersion to fix the evidence boundary.',
    patch: 'Observed file delta. Attribution records an interval, not exclusive authorship.',
    content: 'Surface text for requests/messages; recorded JSON for outputs. Excludes thinking blocks from messages.',
    data: 'Explicit raw evidence opt-in; may include tool arguments or provider thinking blocks.',
    intent: 'Recorded requests and surface explanations, not inferred or hidden reasoning.',
  },
  resources: Object.keys(resources), fields, filters: [...Object.keys(filterColumns), 'surface', 'tool.name', 'tool.isError'],
  operators: ['eq', 'in', 'contains', 'gte', 'lte'], relations, presets,
  limits: { roots: 100, relationItems: 50, includeDepth: 3, expandedNodes: 500, contentChars: 32000 },
  notes: [
    'clean:true returns only ordered user/assistant/tool-input-output objects for conversation queries. It refuses oversized results instead of truncating; no coverage or reference metadata is returned.',
    'Supply captureId or scope (captureIds, sessionIds, workspaceRoot). Scope fields intersect.',
    'Filters are ANDed. Relationship filters use EXISTS and never remove unrelated included evidence.',
    'where.text searches deterministic summaries, not entire payloads or patches.',
    'content/patch/data share maxChars. Metadata is additional; maxChars is not a wire-size limit.',
    'Empty relationships can mean absent, pending, or unlinked evidence. Check coverage and tool status.',
    'Includes use {select, where, include, limit}; truncated relations return a directly usable nextQuery.',
  ],
};
