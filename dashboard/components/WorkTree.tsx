'use client';

import { useEffect, useMemo, useState } from 'react';
import { captureEvents, type EventRecord, type Session } from '@/lib/api';
import { buildTree, subtreeStats, tokensByRequest, toolState, type TreeNode } from '@/lib/tree';
import { Inspector } from './Inspector';
import { Face, HarnessBadge, StatusDot, cost, duration, since, tokens } from './bits';
import { TokenBar } from './TokenBar';

/** One capture as a tree: request → tool calls → file changes, subagents nested
 * under the call that started them. Refreshes when the ledger revision moves.
 */
export function WorkTree({ session, readVersion, onBack }: { session: Session; readVersion?: number; onBack: () => void }) {
  const [data, setData] = useState<{ readVersion: number; events: EventRecord[]; usage: EventRecord[] }>();
  const [error, setError] = useState<string>();
  const [selected, setSelected] = useState<TreeNode>();
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [onlyProblems, setOnlyProblems] = useState(false);

  useEffect(() => { captureEvents(session.captureId).then(setData, e => setError(e.message)); }, [session.captureId, readVersion]);
  const tree = useMemo(() => buildTree(data?.events ?? []), [data]);
  const gaps = data?.events.filter(e => e.type === 'gap') ?? [];
  const usage = useMemo(() => tokensByRequest(data?.usage ?? []), [data]);

  const toggle = (key: string) => setCollapsed(current => {
    const next = new Set(current); if (next.has(key)) next.delete(key); else next.add(key); return next;
  });
  const hasProblem = (node: TreeNode): boolean => (node.kind === 'tool' && ['error', 'pending'].includes(toolState(node)))
    || node.children.some(hasProblem);

  const render = (node: TreeNode, depth: number) => {
    if (onlyProblems && !hasProblem(node)) return null;
    const open = !collapsed.has(node.key);
    return (
      <li key={node.key}>
        <NodeRow node={node} depth={depth} open={open} selected={selected?.key === node.key}
          tokenTotal={node.kind === 'request' ? usage.byRequest.get(node.record.id)?.total : undefined}
          onToggle={() => toggle(node.key)} onSelect={() => setSelected(node)} />
        {open && node.children.length > 0 && <ul>{node.children.map(child => render(child, depth + 1))}</ul>}
      </li>
    );
  };

  return (
    <div className="session-view">
      <div className="session-head">
        <button className="ghost" onClick={onBack}>← project</button>
        <StatusDot status={session.status} />
        <Face tone={session.harness} size="large" mood={session.status === 'recording' ? 'happy' : undefined} />
        <span className="title">{session.captureId.slice(0, 8)}</span>
        <HarnessBadge harness={session.harness} face={false} />
        <span className="mono muted">{session.captureId}</span>
        <span className="muted small">{session.harnessVersion}</span>
        <span className="spacer" />
        <span className="muted small">started {since(session.startedAt)} · {duration(session.startedAt, session.endedAt)}</span>
      </div>
      <div className="session-metrics">
        {[['requests', session.requests], ['replies', session.replies], ['tool calls', session.tools], ['failures', session.failures],
          ['file changes', session.changes], ['subagents', session.subagents], ['gaps', session.gaps]].map(([label, value]) => (
          <div key={label as string} className={`metric ${label === 'failures' && value ? 'bad' : ''} ${label === 'gaps' && value ? 'warn' : ''}`}>
            <b>{value}</b><span>{label}</span>
          </div>
        ))}
        <div className="metric wide" title="Tokens across every model response in this capture, subagents included">
          <b>{tokens(session.tokens.total)}</b><span>tokens · {session.tokens.calls} responses · {cost(session.tokens.costUsd)}</span>
        </div>
        <label className="toggle"><input type="checkbox" checked={onlyProblems} onChange={e => setOnlyProblems(e.target.checked)} /> problems only</label>
      </div>
      {error && <div className="banner">{error}</div>}
      {session.evidenceMissing && <div className="banner">This capture's evidence folder is missing on disk. Its records remain, but request text, tool input and output, patches and the transcript copy cannot be shown.</div>}
      {session.tokens.calls > 0 && <TokenBar tokens={session.tokens} />}
      <div className="split">
        <div className="tree card">
          {!data && <div className="empty small">Loading capture…</div>}
          {data && !tree.roots.length && !tree.unlinked.length && <div className="empty small">Nothing recorded yet.</div>}
          <ul className="nodes">{tree.roots.map(node => render(node, 0))}</ul>
          {tree.unlinked.length > 0 && (
            <>
              <div className="group-title">Outside a recorded request <span className="muted">idle or external changes, unlinked evidence</span></div>
              <ul className="nodes">{tree.unlinked.map(node => render(node, 0))}</ul>
            </>
          )}
          {tree.internalAgents > 0 && !onlyProblems && (
            <div className="muted small internal-note" title="Claude Code's own helpers, such as prompt suggestions and session recaps. They record no task work.">
              {tree.internalAgents} harness-internal helper agent{tree.internalAgents > 1 ? 's' : ''} hidden
            </div>
          )}
          {gaps.length > 0 && !onlyProblems && (
            <details className="gaps"><summary>{gaps.length} coverage gap{gaps.length > 1 ? 's' : ''}</summary>
              <ul>{gaps.map(g => <li key={g.id} className="mono small">{g.summary}</li>)}</ul></details>
          )}
        </div>
        <Inspector captureId={session.captureId} readVersion={data?.readVersion} node={selected} onClose={() => setSelected(undefined)} />
      </div>
    </div>
  );
}

const stateLabel = { ok: 'ok', error: 'error', pending: 'no result', unknown: 'recorded' };
const stateTitle = {
  ok: 'Result recorded as successful.',
  error: 'Result recorded as an error.',
  pending: 'No result recorded: still running, or the result never arrived.',
  unknown: 'A result was recorded, but the harness did not report success or failure.',
};

function NodeRow({ node, depth, open, selected, tokenTotal, onToggle, onSelect }: { node: TreeNode; depth: number; open: boolean; selected: boolean; tokenTotal?: number; onToggle: () => void; onSelect: () => void }) {
  const r = node.record;
  const counts = node.children.length ? subtreeStats(node) : undefined;
  const state = node.kind === 'tool' ? toolState(node) : undefined;
  const icon = { request: '▸', reply: '❝', tool: '⚙', change: r.operation === 'create' ? '+' : r.operation === 'delete' ? '−' : '±', subagent: '⑂', gap: '!', note: '·' }[node.kind];
  const label = node.kind === 'request' ? r.summary || '(empty request)'
    : node.kind === 'tool' ? r.toolName
    : node.kind === 'change' ? r.path
    : node.kind === 'subagent' ? `subagent ${node.agentId?.slice(-8)}`
    : r.type === 'subagent_stopped' ? (r.summary && r.summary !== 'subagent_stopped' ? `returned: ${r.summary}` : 'subagent finished')
    : r.summary;
  return (
    <div className={`node k-${node.kind} ${state ? `t-${state}` : ''} ${selected ? 'on' : ''}`} style={{ paddingLeft: 8 + depth * 18 }} onClick={onSelect}>
      <button className="twisty" onClick={e => { e.stopPropagation(); onToggle(); }} disabled={!node.children.length}>
        {node.children.length ? (open ? '▾' : '▸') : ''}
      </button>
      <span className="icon">{node.kind === 'request' ? <Face tone={node.agentId ? 'sub' : 'user'} size="small" />
        : node.kind === 'subagent' ? <Face tone="sub" size="small" /> : icon}</span>
      <span className={['request', 'reply'].includes(node.kind) ? 'label' : 'label mono'}>{label}</span>
      {state && <span className={`state st-${state}`} title={stateTitle[state]}>{stateLabel[state]}</span>}
      {node.result?.resultBasis && <span className="tag" title="Result taken from the harness transcript; no result hook arrived">transcript</span>}
      {node.kind === 'change' && <span className={`tag ${r.attribution === 'observed-during-tool' ? '' : 'warn'}`}>{r.attribution === 'observed-during-tool' ? 'during tool' : 'external/unknown'}</span>}
      {node.agentId && node.kind === 'tool' && <span className="tag accent">sub</span>}
      <span className="spacer" />
      {tokenTotal ? <span className="tag" title="Tokens of the model responses during this request">{tokens(tokenTotal)} tok</span> : null}
      {counts && (counts.tools > 0 || counts.changes > 0) && (
        <span className="counts muted small">{[counts.tools && `${counts.tools} tools`, counts.changes && `${counts.changes} Δ`].filter(Boolean).join(' · ')}
          {counts.errors ? <b className="bad"> · {counts.errors}✕</b> : null}</span>
      )}
      <span className="muted small time">{new Date(r.sourceTimestamp ?? r.observedAt).toLocaleTimeString()}</span>
    </div>
  );
}
