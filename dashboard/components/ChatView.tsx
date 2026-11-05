'use client';

import { useEffect, useState } from 'react';
import { Markdown } from './Markdown';
import { view, type Session, type Tokens } from '@/lib/api';
import type { TreeNode } from '@/lib/tree';
import { subtreeEnd, subtreeStats } from '@/lib/tree';
import { Face, HarnessIcon, UserAvatar, harnessLabel, plural, tokens as fmtTokens } from './bits';
import { TokenLegend } from './TokenBar';

interface Body { text: string; truncated?: true; totalChars?: number; recordId?: string }
interface Change { kind: 'change'; id: string; at: string; path?: string; operation?: string; attribution?: string; worktree?: string; branch?: string; patch?: Body; patchUnavailable?: string }
interface Subagent { agentId: string; agentType?: string; task?: Body; items: Item[]; report?: Body }
type Item =
  | { kind: 'text'; id: string; at: string; text: Body; source: string }
  | { kind: 'thinking'; id: string; at: string; text: Body; redacted?: boolean; durationMs?: number }
  | { kind: 'tool'; id: string; at: string; toolCallId: string; name: string; agentId?: string; input?: Body; output?: Body;
      status: 'ok' | 'error' | 'recorded' | 'pending'; resultBasis?: string; durationMs?: number; changes: Change[]; subagent?: Subagent; native?: true }
  | Change
  | { kind: 'subagent'; id: string; at: string; subagent: Subagent };
interface Turn { readVersion: number; harness: string; request: { id: string; at: string; text: Body; images?: number }; items: Item[]; tokens: Tokens }

/** The session read like a chat: one expandable box per turn. Inside, the prompt,
 * thinking, replies and tool calls appear in order; details stay folded until opened.
 */
export function ChatView({ session, requests, usage, readVersion }: { session: Session; requests: TreeNode[]; usage: Map<string, Tokens>; readVersion?: number }) {
  if (!requests.length) return <div className="card empty small">No requests recorded in this session yet.</div>;
  return (
    <div className="chat">
      {requests.map((node, index) => (
        <TurnBox key={node.key} index={index + 1} node={node} session={session} tokens={usage.get(node.record.id)} readVersion={readVersion} />
      ))}
    </div>
  );
}

function elapsed(from: string, to?: string): string {
  if (!to) return '';
  const ms = Date.parse(to) - Date.parse(from);
  if (!Number.isFinite(ms) || ms < 0) return '';
  return ms < 1000 ? `${ms}ms` : ms < 60000 ? `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s` : `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
}

/** One turn, as sketched: the prompt in a header (stats and time chips), then a box with
 * the steps (folded; each call opens on its own), the response, and the stats details.
 */
function TurnBox({ index, node, session, tokens, readVersion }: { index: number; node: TreeNode; session: Session; tokens?: Tokens; readVersion?: number }) {
  const [open, setOpen] = useState(false);
  const [turn, setTurn] = useState<Turn>();
  const [error, setError] = useState<string>();
  const counts = subtreeStats(node);
  // Load a turn only when it is opened; reload when the ledger moves while it is open.
  useEffect(() => {
    if (!open) return;
    view<Turn>({ view: 'turn', captureId: session.captureId, requestId: node.record.id }).then(t => { setTurn(t); setError(undefined); }, e => setError(e.message));
  }, [open, session.captureId, node.record.id, readVersion]);

  // The response is the turn's last reply; earlier narration belongs to the steps.
  const lastText = turn ? [...turn.items].reverse().find(item => item.kind === 'text') : undefined;
  const steps = turn ? turn.items.filter(item => item !== lastText) : [];
  const stats = [counts.tools && plural(counts.tools, 'tool'), counts.changes && plural(counts.changes, 'change'),
    tokens && tokens.total > 0 && `${fmtTokens(tokens.total)} tokens`].filter(Boolean).join(' · ');
  const took = elapsed(node.record.observedAt, subtreeEnd(node));

  return (
    <section className={`turn ${open ? 'open' : ''}`}>
      <div className="turn-row">
        <UserAvatar size="large" />
        <button className="turn-head" aria-expanded={open} onClick={() => setOpen(!open)}>
          <span className="turn-index">{String(index).padStart(2, '0')}</span>
          <span className="turn-title">{node.record.summary || '(empty request)'}</span>
          {stats && <span className="pill">{stats}{counts.errors > 0 && <b className="bad"> · {counts.errors} failed</b>}</span>}
          <span className="pill time-pill">{new Date(node.record.observedAt).toLocaleTimeString()}{took ? ` · ${took}` : ''}</span>
          <i className={`chevron ${open ? 'open' : ''}`} aria-hidden />
        </button>
      </div>
      {open && (
        <div className="turn-card card">
          {error && <div className="banner">{error}</div>}
          {!turn && !error && <div className="muted small">Loading turn…</div>}
          {turn && (
            <>
              {turn.request.text.text.length > 120 && <div className="prompt-full"><span className="eyebrow">Request</span><Markdown text={turn.request.text.text} /></div>}
              {counts.files.length > 0 && <div className="turn-files"><span className="eyebrow">Changed</span>{counts.files.map(file => <code key={file}>{file}</code>)}</div>}
              {steps.length > 0 && <Steps items={steps} harness={turn.harness} />}
              <div className="response">
                <span className="eyebrow">Response</span>
                {lastText && lastText.kind === 'text'
                  ? <><Markdown text={lastText.text.text} /><Clipped body={lastText.text} />
                    {lastText.source === 'hook' && <div className="muted small">Final reply as reported by the harness hook.</div>}</>
                  : <p className="muted small">No reply recorded for this turn{counts.errors ? '; a step failed' : ''}.</p>}
              </div>
              {turn.tokens.calls > 0 && <footer className="turn-stats"><TokenLegend tokens={turn.tokens} showCost={turn.tokens.costUsd !== null} /></footer>}
            </>
          )}
        </div>
      )}
    </section>
  );
}

/** The work behind a response: one folded box; each step inside opens on its own. */
function Steps({ items, harness }: { items: Item[]; harness: string }) {
  const tools = items.filter(item => item.kind === 'tool') as Extract<Item, { kind: 'tool' }>[];
  const thinking = items.filter(item => item.kind === 'thinking').length;
  const failed = tools.filter(tool => tool.status === 'error').length;
  const names = [...new Set(tools.map(tool => tool.name))];
  return (
    <details className="steps">
      <summary>
        <span className="eyebrow">Steps</span>
        <span className="steps-names">{names.slice(0, 6).join(' · ')}{names.length > 6 ? ` · +${names.length - 6}` : ''}</span>
        <span className="spacer" />
        <span className="muted small">{[tools.length && `${tools.length} call${tools.length > 1 ? 's' : ''}`, thinking && `${thinking} thought${thinking > 1 ? 's' : ''}`].filter(Boolean).join(' · ')}</span>
        {failed > 0 && <span className="state st-error">{failed} failed</span>}
      </summary>
      <div className="steps-body"><Items items={items} harness={harness} /></div>
    </details>
  );
}

function Items({ items, harness }: { items: Item[]; harness: string }) {
  return <>{items.map(item => <ItemView key={item.id} item={item} harness={harness} />)}</>;
}

function ItemView({ item, harness }: { item: Item; harness: string }) {
  if (item.kind === 'text') {
    return <div className="narration"><HarnessIcon harness={harness} size="small" /><div><Markdown text={item.text.text} /><Clipped body={item.text} /></div></div>;
  }
  if (item.kind === 'thinking') {
    const seconds = item.durationMs !== undefined ? ` for ${(item.durationMs / 1000).toFixed(item.durationMs < 10000 ? 1 : 0)}s` : '';
    return (
      <details className="fold thinking">
        <summary><span className="glyph">◌</span>Thought{seconds}{item.redacted && <span className="muted"> · text not recorded</span>}</summary>
        {item.redacted
          ? <p className="muted small">The harness recorded that the model reasoned here, but not the reasoning itself ({harness === 'codex'
            ? 'Codex stores reasoning encrypted; enable reasoning summaries to record a summary' : `${harnessLabel[harness] ?? harness} omitted the thinking text`}).</p>
          : <div className="thought"><Markdown text={item.text.text} /><Clipped body={item.text} /></div>}
      </details>
    );
  }
  if (item.kind === 'tool') return <ToolView tool={item} harness={harness} />;
  if (item.kind === 'change') return <ChangeView change={item} />;
  return <SubagentView subagent={item.subagent} harness={harness} />;
}

function target(tool: { name: string; input?: Body }): string {
  if (!tool.input) return '';
  try {
    const input = JSON.parse(tool.input.text);
    // Paths are shortened to their last two parts; commands and messages are shown as written.
    const path = input.file_path ?? input.path ?? input.notebook_path;
    if (typeof path === 'string') return path.split(/[\\/]/).filter(Boolean).slice(-2).join('/');
    const value = input.command ?? input.cmd ?? input.pattern ?? input.url ?? input.description ?? input.message;
    if (typeof value === 'string') return value;
  } catch { /* not JSON */ }
  return '';
}

/** What each tool call of a turn acted on, by call ID: a file or a command, as the chat shows it. */
export async function toolTargets(captureId: string, requestId: string): Promise<[string, string][]> {
  const turn = await view<Turn>({ view: 'turn', captureId, requestId });
  const found: [string, string][] = [];
  const walk = (items: Item[]) => {
    for (const item of items) {
      if (item.kind === 'tool') { found.push([item.toolCallId, target(item)]); if (item.subagent) walk(item.subagent.items); }
      else if (item.kind === 'subagent') walk(item.subagent.items);
    }
  };
  walk(turn.items);
  return found;
}

function ToolView({ tool, harness }: { tool: Extract<Item, { kind: 'tool' }>; harness: string }) {
  const label = { ok: 'ok', error: 'failed', recorded: 'done', pending: 'no result' }[tool.status];
  return (
    <details className={`fold tool st-${tool.status}`}>
      <summary>
        <span className="glyph">⚙</span><b>{tool.name}</b><span className="tool-target">{target(tool)}</span>
        <span className="spacer" />
        {tool.changes.length > 0 && <span className="tag">{plural(tool.changes.length, 'change')}</span>}
        {tool.subagent && <span className="tag">subagent</span>}
        {tool.resultBasis && <span className="tag" title="Result read from the harness transcript; no result hook arrived">transcript</span>}
        {tool.durationMs !== undefined && <span className="muted small">{tool.durationMs < 1000 ? `${tool.durationMs}ms` : `${(tool.durationMs / 1000).toFixed(1)}s`}</span>}
        <span className={`state st-${tool.status === 'recorded' ? 'unknown' : tool.status}`}>{label}</span>
      </summary>
      <div className="fold-body">
        {tool.input && <Section title="Input" body={tool.input} />}
        {tool.output ? <Section title="Output" body={tool.output} /> : <p className="muted small">{tool.status === 'pending' ? 'No result was recorded.' : 'No output body.'}</p>}
        {tool.changes.map(change => <ChangeView key={change.id} change={change} />)}
        {tool.subagent && <SubagentView subagent={tool.subagent} harness={harness} />}
      </div>
    </details>
  );
}

function ChangeView({ change }: { change: Change }) {
  const sign = change.operation === 'create' ? '+' : change.operation === 'delete' ? '−' : '±';
  return (
    <details className="fold change">
      <summary><span className="glyph add-glyph">{sign}</span><span className="mono">{change.path}</span>
        {change.worktree && <span className="tag" title={change.branch ? `Branch ${change.branch}` : undefined}>worktree {change.worktree}</span>}
        <span className="spacer" /><span className={`tag ${change.attribution === 'observed-during-tool' ? '' : 'warn'}`}>{change.attribution === 'observed-during-tool' ? 'during tool' : 'external/unknown'}</span></summary>
      {change.patch ? <Diff body={change.patch} /> : <p className="muted small">{change.patchUnavailable ?? 'No patch recorded.'}</p>}
    </details>
  );
}

function SubagentView({ subagent, harness }: { subagent: Subagent; harness: string }) {
  return (
    <details className="fold subagent-box">
      <summary><Face tone="sub" size="small" /><b>{subagent.agentType || 'Subagent'}</b><span className="muted mono small">{subagent.agentId.slice(-8)}</span></summary>
      <div className="fold-body">
        {subagent.task && <div className="sub-task"><span className="eyebrow">task</span><Markdown text={subagent.task.text} /></div>}
        <Items items={subagent.items} harness={harness} />
        {subagent.report && <div className="sub-report"><span className="eyebrow">returned</span><Markdown text={subagent.report.text} /></div>}
      </div>
    </details>
  );
}

function Section({ title, body }: { title: string; body: Body }) {
  let text = body.text;
  try { if (!body.truncated) text = JSON.stringify(JSON.parse(text), null, 2); } catch { /* plain text */ }
  return <div className="io"><span className="eyebrow">{title}</span><pre>{text}</pre><Clipped body={body} /></div>;
}

function Diff({ body }: { body: Body }) {
  const lines = body.text.split('\n').filter(line => !/^Index: /.test(line) && !/^=+$/.test(line));
  return (
    <pre className="diff">{lines.map((line, i) => (
      <span key={i} className={line.startsWith('+') && !line.startsWith('+++') ? 'add' : line.startsWith('-') && !line.startsWith('---') ? 'del' : line.startsWith('@@') ? 'hunk' : ''}>{line}{'\n'}</span>
    ))}</pre>
  );
}

function Clipped({ body }: { body: Body }) {
  return body.truncated ? <div className="muted small">Showing {body.text.length.toLocaleString()} of {body.totalChars?.toLocaleString()} characters. The full text is in the Dev view.</div> : null;
}
