import type { EventRecord, Tokens } from './api';

export type NodeKind = 'request' | 'reply' | 'tool' | 'change' | 'subagent' | 'gap' | 'note';
export interface TreeNode {
  key: string; kind: NodeKind; record: EventRecord; children: TreeNode[];
  /** For tools: the recorded result, if any. */
  result?: EventRecord;
  agentId?: string;
}

/** Build the work tree from recorded links only: hook parentage, call IDs and
 * childAgentId. Nothing is placed by guessing; unlinked evidence is grouped as such.
 */
export function buildTree(events: EventRecord[]): { roots: TreeNode[]; unlinked: TreeNode[]; agents: Map<string, TreeNode>; internalAgents: number } {
  const nodes = new Map<string, TreeNode>();
  // Harness-internal helpers (Claude Code prompt suggestions, recaps) did no task work.
  const internal = new Set(events.filter(e => e.internalAgent && e.agentId).map(e => e.agentId!));
  events = events.filter(e => !(e.agentId && internal.has(e.agentId)));
  const results = new Map<string, EventRecord>();
  for (const event of events) {
    if (event.type === 'tool_finished' && event.toolCallId) {
      // A hook result beats a transcript-derived one; keep the latest of each kind.
      const prior = results.get(event.toolCallId);
      if (!prior || prior.resultBasis || !event.resultBasis) results.set(event.toolCallId, event);
    }
  }
  const kindOf = (type: string, role?: string): NodeKind | undefined => type === 'input' ? 'request' : type === 'tool_started' ? 'tool'
    : ['source_record', 'message'].includes(type) && role === 'assistant' ? 'reply'
    // Gaps are listed once, in the coverage section, not as tree nodes.
    : type === 'file_change' ? 'change'
    : ['subagent_stopped', 'session_compact'].includes(type) ? 'note' : undefined;
  for (const event of events) {
    const kind = kindOf(event.type, event.role);
    if (!kind) continue;
    nodes.set(event.id, { key: event.id, kind, record: event, children: [], agentId: event.agentId,
      result: kind === 'tool' && event.toolCallId ? results.get(event.toolCallId) : undefined });
  }

  // Subagent lanes: each subagent's records hang under the call that started it.
  const agents = new Map<string, TreeNode>();
  const spawnOf = new Map<string, TreeNode>();
  for (const node of nodes.values()) {
    const child = node.result?.childAgentId;
    if (node.kind === 'tool' && child) spawnOf.set(child, node);
  }
  for (const event of events) {
    if (event.type === 'subagent_started' && event.agentId && !agents.has(event.agentId)) {
      agents.set(event.agentId, { key: `agent:${event.agentId}`, kind: 'subagent', record: event, children: [], agentId: event.agentId });
    }
  }
  for (const node of nodes.values()) {
    if (node.agentId && !agents.has(node.agentId)) {
      agents.set(node.agentId, { key: `agent:${node.agentId}`, kind: 'subagent', record: node.record, children: [], agentId: node.agentId });
    }
  }

  const roots: TreeNode[] = [];
  const unlinked: TreeNode[] = [];
  for (const node of nodes.values()) {
    const record = node.record;
    // A subagent's own request is its task; show it as the lane's first entry.
    const parent = record.parentId ? nodes.get(record.parentId) : undefined;
    if (node.kind === 'request' && !node.agentId) { roots.push(node); continue; }
    if (parent && parent !== node && (!node.agentId || parent.agentId === node.agentId)) { parent.children.push(node); continue; }
    if (node.agentId) { agents.get(node.agentId)!.children.push(node); continue; }
    if (record.requestId && nodes.get(record.requestId)) { nodes.get(record.requestId)!.children.push(node); continue; }
    unlinked.push(node);
  }
  for (const [agentId, lane] of agents) {
    const spawn = spawnOf.get(agentId);
    if (spawn) spawn.children.push(lane); else unlinked.push(lane);
  }
  // Order by when things happened. A transcript reply is mirrored after the hook that
  // follows it, so record order alone would show it one step late.
  const at = (node: TreeNode) => node.record.sourceTimestamp ?? node.record.observedAt;
  const byTime = (a: TreeNode, b: TreeNode) => at(a).localeCompare(at(b)) || a.record.seq - b.record.seq;
  const sort = (list: TreeNode[]) => { list.sort(byTime); for (const node of list) sort(node.children); };
  sort(roots); sort(unlinked);
  return { roots, unlinked, agents, internalAgents: internal.size };
}

/** Tokens per request: one count per model response, resumed history excluded. */
export function tokensByRequest(usage: EventRecord[]): { byRequest: Map<string, Tokens>; total: Tokens } {
  const empty = (): Tokens => ({ calls: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, total: 0, costUsd: null });
  const seen = new Set<string>();
  const byRequest = new Map<string, Tokens>();
  const total = empty();
  for (const record of [...usage].sort((a, b) => a.seq - b.seq)) {
    if (record.usageScope !== 'call' || record.beforeCapture || !record.usage) continue;
    const key = `${record.agentId ?? ''}:${record.usageKey}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const u = record.usage;
    for (const target of [total, ...(record.requestId ? [byRequest.get(record.requestId) ?? byRequest.set(record.requestId, empty()).get(record.requestId)!] : [])]) {
      target.calls++; target.input += u.input; target.cacheRead += u.cacheRead; target.cacheWrite += u.cacheWrite;
      target.output += u.output; target.reasoning += u.reasoning ?? 0; target.total += u.input + u.cacheRead + u.cacheWrite + u.output;
      if (typeof u.costUsd === 'number') target.costUsd = (target.costUsd ?? 0) + u.costUsd;
    }
  }
  return { byRequest, total };
}

export function toolState(node: TreeNode): 'ok' | 'error' | 'pending' | 'unknown' {
  if (!node.result) return 'pending';
  if (node.result.isError === true) return 'error';
  if (node.result.isError === false) return 'ok';
  return 'unknown';
}

/** Counts used for the compact per-node badges. */
export function subtreeStats(node: TreeNode): { tools: number; changes: number; errors: number } {
  const totals = { tools: 0, changes: 0, errors: 0 };
  const walk = (current: TreeNode) => {
    for (const child of current.children) {
      if (child.kind === 'tool') { totals.tools++; if (toolState(child) === 'error') totals.errors++; }
      if (child.kind === 'change') totals.changes++;
      walk(child);
    }
  };
  walk(node);
  return totals;
}
