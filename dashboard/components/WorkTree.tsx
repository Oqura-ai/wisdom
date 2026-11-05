'use client';

import { useEffect, useMemo, useState } from 'react';
import { captureEvents, type EventRecord, type Session } from '@/lib/api';
import { buildTree, subtreeStats, tokensByRequest, toolState, type TreeNode } from '@/lib/tree';
import { Inspector } from './Inspector';
import { BackButton, Face, HarnessIcon, StatusDot, UserAvatar, cost, harnessLabel, plural, sessionLength, since, tokens } from './bits';
import { TokenBar } from './TokenBar';
import { ChatView, toolTargets } from './ChatView';

type View = 'chat' | 'dev';
function useView(): [View, (view: View) => void] {
  const [view, setView] = useState<View>('chat');
  useEffect(() => { try { if (localStorage.getItem('wisdom-view') === 'dev') setView('dev'); } catch { /* default */ } }, []);
  return [view, (next: View) => { setView(next); try { localStorage.setItem('wisdom-view', next); } catch { /* still applies */ } }];
}

/** One capture as a tree: request → tool calls → file changes, subagents nested
 * under the call that started them. Refreshes when the ledger revision moves.
 */
export function WorkTree({ session, readVersion, onBack }: { session: Session; readVersion?: number; onBack: () => void }) {
  const [data, setData] = useState<{ readVersion: number; events: EventRecord[]; usage: EventRecord[] }>();
  const [error, setError] = useState<string>();
  const [selected, setSelected] = useState<TreeNode>();
  const [opened, setOpened] = useState<Set<string>>(new Set());
  const [onlyProblems, setOnlyProblems] = useState(false);
  const [view, setView] = useView();
  const [copied, setCopied] = useState(false);
  // Ready to paste in any terminal: it sets the session's folder and its harness home.
  const resume = typeof navigator !== 'undefined' && /Windows/.test(navigator.userAgent) ? session.resume.powershell : session.resume.posix;
  const copyResume = () => void navigator.clipboard.writeText(resume).then(() => {
    setCopied(true); setTimeout(() => setCopied(false), 1500);
  });

  useEffect(() => { captureEvents(session.captureId).then(setData, e => setError(e.message)); }, [session.captureId, readVersion]);
  const tree = useMemo(() => buildTree(data?.events ?? []), [data]);
  const gaps = data?.events.filter(e => e.type === 'gap') ?? [];
  const usage = useMemo(() => tokensByRequest(data?.usage ?? []), [data]);
  const requests = tree.roots.filter(node => node.kind === 'request');
  const length = sessionLength(session);
  const details = (id: string) => [`${harnessLabel[session.harness] ?? session.harness} ${session.harnessVersion ?? ''}`.trim(), id, `started ${since(session.startedAt)}`, length, session.endReason].filter(Boolean).join(' · ');
  const outsideFiles = tree.unlinked.filter(node => node.kind === 'change');

  // The Dev rows name what each call acted on. The capture view has no tool input, so read it
  // from the turns. ponytail: one read per request on each ledger change; fine at session scale.
  const [targets, setTargets] = useState(new Map<string, string>());
  useEffect(() => {
    if (view !== 'dev' || !data) return;
    let cancelled = false;
    const ids = data.events.filter(e => e.type === 'input' && !e.agentId).map(e => e.id);
    void Promise.all(ids.map(id => toolTargets(session.captureId, id).catch(() => [] as [string, string][])))
      .then(found => { if (!cancelled) setTargets(new Map(found.flat())); });
    return () => { cancelled = true; };
  }, [view, data, session.captureId]);

  const toggle = (key: string) => setOpened(current => {
    const next = new Set(current); if (next.has(key)) next.delete(key); else next.add(key); return next;
  });
  const hasProblem = (node: TreeNode): boolean => (node.kind === 'tool' && ['error', 'pending'].includes(toolState(node)))
    || node.children.some(hasProblem);

  const render = (node: TreeNode, depth: number) => {
    if (onlyProblems && !hasProblem(node)) return null;
    // Problems only has to reach the problems, so it opens the way to them.
    const open = onlyProblems || opened.has(node.key);
    return (
      <li key={node.key}>
        <NodeRow node={node} depth={depth} open={open} selected={selected?.key === node.key}
          target={node.record.toolCallId ? targets.get(node.record.toolCallId) : undefined}
          tokenTotal={node.kind === 'request' ? usage.byRequest.get(node.record.id)?.total : undefined}
          onToggle={() => toggle(node.key)} onSelect={() => setSelected(node)} />
        {open && node.children.length > 0 && <ul>{node.children.map(child => render(child, depth + 1))}</ul>}
      </li>
    );
  };

  return (
    <div className="session-view">
      <div className="session-head">
        <BackButton onClick={onBack} label="Overview" />
        <StatusDot status={session.status} />
        <HarnessIcon harness={session.harness} size="large" live={session.status === 'recording'} />
        <span className="session-meta" title={details(session.captureId)}>{details(session.captureId.slice(0, 8))}</span>
        <span className="themes" role="radiogroup" aria-label="View">
          {(['chat', 'dev'] as const).map(option => (
            <button key={option} role="radio" aria-checked={view === option} className={view === option ? 'on' : ''} onClick={() => setView(option)}
              title={option === 'chat' ? 'Read the session like a conversation' : 'Records, links and evidence'}>{option}</button>
          ))}
        </span>
      </div>
      <div className="resume-line">
        <span className="label">resume</span>
        <code title="Continues this session with recording. The home stays set in this terminal, so harness commands run there also use this project.">{resume}</code>
        <button onClick={copyResume} title="Copy the command">{copied ? 'copied' : 'copy'}</button>
      </div>
      <div className="session-metrics">
        {([['requests', session.requests], ['tools', session.tools], ['failures', session.failures],
          ['changes', session.changes], ['subagents', session.subagents], ['gaps', session.gaps]] as const).filter(([, value]) => value > 0).map(([label, value]) => (
          <div key={label} className={`metric ${label === 'failures' ? 'bad' : ''} ${label === 'gaps' ? 'warn' : ''}`}>
            <b>{value}</b><span>{value === 1 ? label.slice(0, -1) : label}</span>
          </div>
        ))}
        <div className="metric" title={`Tokens across ${plural(session.tokens.calls, 'model response')} in this capture, subagents included`}>
          <b>{tokens(session.tokens.total)}</b><span>tokens</span>
        </div>
        <div className="metric" title={session.tokens.costUsd === null ? 'Not reported by this harness' : session.tokens.costBehind ? 'The harness last reported this before its latest model responses' : 'Reported by the harness'}>
          <b>{session.tokens.costUsd === null ? '—' : cost(session.tokens.costUsd)}</b><span>{session.tokens.costBehind ? 'cost so far' : 'cost'}</span>
        </div>
      </div>
      {error && <div className="banner">{error}</div>}
      {session.evidenceMissing && <div className="banner">This capture's evidence folder is missing on disk. Its records remain, but request text, tool input and output, patches and the transcript copy cannot be shown.</div>}
      {session.tokens.calls > 0 && <TokenBar tokens={session.tokens} showCost={false} />}
      {gaps.length > 0 && (
        <details className="gaps"><summary>{plural(gaps.length, 'coverage gap')}</summary>
          <ul>{gaps.map(g => <li key={g.id} className="mono small">{g.summary}</li>)}</ul></details>
      )}
      {view === 'chat' && data && <ChatView session={session} readVersion={data.readVersion} requests={requests} usage={usage.byRequest} />}
      {view === 'chat' && outsideFiles.length > 0 && (
        <div className="turn-files"><span className="eyebrow">Changed outside any request</span>{outsideFiles.map(node => <code key={node.key}>{node.record.path}</code>)}</div>
      )}
      {view === 'dev' && <div className="split">
        <div className="tree card">
          <label className="toggle"><input type="checkbox" checked={onlyProblems} onChange={e => setOnlyProblems(e.target.checked)} /> Problems only</label>
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
        </div>
        <Inspector captureId={session.captureId} readVersion={data?.readVersion} node={selected} onClose={() => setSelected(undefined)} />
      </div>}
    </div>
  );
}

const stateLabel = { ok: 'ok', error: 'failed', pending: 'no result', unknown: 'recorded' };
const stateTitle = {
  ok: 'Result recorded as successful.',
  error: 'Result recorded as an error.',
  pending: 'No result recorded: still running, or the result never arrived.',
  unknown: 'A result was recorded, but the harness did not report success or failure.',
};

function NodeRow({ node, depth, open, selected, target, tokenTotal, onToggle, onSelect }: { node: TreeNode; depth: number; open: boolean; selected: boolean; target?: string; tokenTotal?: number; onToggle: () => void; onSelect: () => void }) {
  const r = node.record;
  const counts = node.children.length ? subtreeStats(node) : undefined;
  const state = node.kind === 'tool' ? toolState(node) : undefined;
  const icon = { request: '▸', reply: '❝', tool: '⚙', change: r.operation === 'create' ? '+' : r.operation === 'delete' ? '−' : '±', subagent: '⑂', gap: '!', note: '·' }[node.kind];
  const label = node.kind === 'request' ? r.summary || '(empty request)'
    : node.kind === 'tool' ? r.toolName
    : node.kind === 'change' ? `${r.path}${r.worktree ? ` · worktree ${r.worktree}` : ''}`
    : node.kind === 'subagent' ? `subagent ${node.agentId?.slice(-8)}`
    : r.type === 'session_compact' ? 'session compacted'
    : r.type === 'subagent_stopped' ? (r.summary && r.summary !== 'subagent_stopped' ? `returned: ${r.summary}` : 'subagent finished')
    : r.summary;
  return (
    <div className={`node k-${node.kind} ${state ? `t-${state}` : ''} ${selected ? 'on' : ''}`} style={{ paddingLeft: 8 + depth * 18 }} onClick={onSelect}>
      <button className="twisty" onClick={e => { e.stopPropagation(); onToggle(); }} disabled={!node.children.length}>
        {node.children.length ? <i className={`chevron ${open ? 'open' : ''}`} aria-hidden /> : null}
      </button>
      <span className="icon">{node.kind === 'request' ? (node.agentId ? <Face tone="sub" size="small" /> : <UserAvatar size="small" />)
        : node.kind === 'subagent' ? <Face tone="sub" size="small" /> : icon}</span>
      <span className={['request', 'reply'].includes(node.kind) ? 'label' : 'label mono'} title={target}>{node.kind === 'tool' ? <><b>{label}</b> {target && <span className="node-target">{target}</span>}</> : label}</span>
      {state && <span className={`state st-${state}`} title={stateTitle[state]}>{stateLabel[state]}</span>}
      {node.result?.resultBasis && <span className="tag" title="Result taken from the harness transcript; no result hook arrived">transcript</span>}
      {node.kind === 'change' && <span className={`tag ${r.attribution === 'observed-during-tool' ? '' : 'warn'}`}>{r.attribution === 'observed-during-tool' ? 'during tool' : 'external/unknown'}</span>}
      <span className="spacer" />
      {tokenTotal ? <span className="tag" title="Tokens of the model responses during this request">{tokens(tokenTotal)} tokens</span> : null}
      {counts && (counts.tools > 0 || counts.changes > 0) && (
        <span className="counts muted small">{[counts.tools && plural(counts.tools, 'tool'), counts.changes && plural(counts.changes, 'change')].filter(Boolean).join(' · ')}
          {counts.errors ? <b className="bad"> · {counts.errors} failed</b> : null}</span>
      )}
      <span className="muted small time">{new Date(r.sourceTimestamp ?? r.observedAt).toLocaleTimeString()}</span>
    </div>
  );
}
