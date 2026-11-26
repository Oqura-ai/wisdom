'use client';

import { useState } from 'react';
import type { Commit, Index, Manifest, SessionSummary, SessionTurns, Turn, TurnItem } from '@contract';
import { sessionPath } from '@contract';
import { useData, useMany } from '@/lib/data';
import { go } from '@/lib/route';
import { plural, short } from '@/lib/words';
import { Markdown } from './Markdown';

type Body = { text: string; truncated?: true; totalChars?: number };
type Tool = Extract<TurnItem, { kind: 'tool' }>;
type FileChange = Extract<TurnItem, { kind: 'change' }>;
type Sub = Extract<TurnItem, { kind: 'subagent' }>['subagent'];

/** What the panel was asked to open: a session, a stretch of its turns, or one turn. */
export interface Opening { key: string; turn?: number; from?: number; to?: number }

/** `session:<key>`, `session:<key>#<from>-<to>` (a snippet on a canvas), `turn:<key>#<n>`. */
export function parseOpening(selected?: string): Opening | undefined {
  const m = selected && /^(session|turn):([^#]+)(?:#(\d+)(?:-(\d+))?)?$/.exec(selected);
  if (!m) return undefined;
  if (m[1] === 'turn') return { key: m[2], turn: Number(m[3]) };
  return { key: m[2], ...(m[3] ? { from: Number(m[3]), to: Number(m[4] ?? m[3]) } : {}) };
}

/** Sessions in the right panel, one line each. A session opens to its turns, one line each; a
 * turn opens in place to the chat view, read from its own file only when opened. */
export function SessionsPanel({ keys, scope, opening, here, index, manifest }: { keys: string[]; scope: string; opening?: Opening;
  here?: Set<string>; index: Index; manifest: Manifest }) {
  const list = opening && !keys.includes(opening.key) ? [opening.key, ...keys] : keys;
  const sessions = list.map(k => index.sessions.find(s => s.key === k)).filter((s): s is SessionSummary => !!s);
  // The panel is remounted on each new opening (its key), so what starts open follows the last
  // click; "Collapse all" remounts the items closed.
  const [fold, setFold] = useState(0);
  return (
    <>
      <div className="panel-head"><h3 style={{ fontSize: 14 }}>Sessions {scope}</h3><span className="muted small">{sessions.length}</span><span className="spacer" />
        <button className="pos" onClick={() => setFold(n => n + 1)}>Collapse all</button></div>
      <div className="plist">
        {sessions.map(s => <SessionItem key={`${s.key}:${fold}`} s={s} opening={opening?.key === s.key && !fold ? opening : undefined}
          open={!fold && opening?.key === s.key} here={here} manifest={manifest} />)}
        {!sessions.length && <p className="small muted">No session here.</p>}
      </div>
    </>
  );
}

export function SessionItem({ s, open, opening, here, manifest }: { s: SessionSummary; open?: boolean; opening?: Opening; here?: Set<string>; manifest: Manifest }) {
  const missing = !s.turns;
  const listingPath = `${sessionPath(s.key)}/index.json`;
  const [shown, setShown] = useState(!!open);
  const listing = useData<SessionTurns>(shown && listingPath in manifest.files ? listingPath : undefined).data;
  const recorder = s.key.includes('/') ? s.key.slice(0, s.key.lastIndexOf('/')) : '';
  const isHere = (sha: string) => !!here?.has(sha);
  return (
    <details className="sp" open={open} onToggle={e => setShown((e.target as HTMLDetailsElement).open)}>
      <summary><span className={`bar ${missing ? 'held' : ''}`} />
        <span className="sp-title"><b>{s.title || s.id}</b><span className="sp-meta"><code>{short(s.id)}</code><span>{s.person}</span><span>{plural(s.turns, 'turn')}</span>
          {missing && <span className="t-bad">missing</span>}</span></span>
        <span className="sp-meta tags">{s.commits.map(sha => <span key={sha} className={`tag ${isHere(sha) ? 'this' : ''}`}>{short(sha)}</span>)}
          {!s.commits.length && <span className="tag none">no commit</span>}</span>
      </summary>
      <div>
        <div className="sp-facts">{s.person} · {s.harness}{recorder && <> · recorder <code>{recorder}</code></>} · session <code>{s.id}</code>
          {missing && <div className="t-bad">Not on the remote: a record names this session, but this build does not have it. Its turns can&apos;t be read here.</div>}</div>
        {!missing && shown && (listing ? listing.turnList.map(t => {
          const cited = t.cited.length > 0 && (!here || t.cited.some(isHere));
          const picked = opening?.from !== undefined && t.turn >= opening.from && t.turn <= opening.to!;
          return (
            <TurnLine key={t.turn} s={s} turn={t.turn} request={t.request} cited={t.cited} classes={`${cited ? 'cited' : ''} ${picked ? 'picked' : ''} ${picked && t.turn === opening!.from ? 'pick-first' : ''}`}
              open={opening?.turn === t.turn} isHere={isHere} manifest={manifest} />
          );
        }) : !(listingPath in manifest.files) ? <p className="small muted" style={{ padding: '8px 12px', margin: 0 }}>This build has no turn text for this session.</p>
          : <p className="small muted" style={{ padding: '8px 12px', margin: 0 }}>Reading…</p>)}
      </div>
    </details>
  );
}

function TurnLine({ s, turn, request, cited, classes, open, isHere, manifest }: { s: SessionSummary; turn: number; request: string; cited: string[]; classes: string;
  open?: boolean; isHere: (sha: string) => boolean; manifest: Manifest }) {
  const [shown, setShown] = useState(!!open);
  const tag = !cited.length ? <span className="tag none">no commit</span> : <span className={`tag ${cited.some(isHere) ? 'this' : ''}`}>{short(cited.find(isHere) ?? cited[0])}{cited.length > 1 ? ` +${cited.length - 1}` : ''}</span>;
  return (
    <details className={`tp ${classes}`} open={open} onToggle={e => setShown((e.target as HTMLDetailsElement).open)}>
      <summary><code>t{turn}</code><span className="req">{request}</span>{tag}</summary>
      {shown && <div className="tp-body"><ChatTurn s={s} turn={turn} cited={cited} manifest={manifest} /></div>}
    </details>
  );
}

// ---------- level 3: one turn, as the Usage dashboard lays it out ----------

const ICONS = { tool: 'M10.5 2.5a3 3 0 0 0-3.8 3.8L2.5 10.5l3 3 4.2-4.2a3 3 0 0 0 3.8-3.8l-1.9 1.9-1.6-.4-.4-1.6z', thought: 'M4 8h.01M8 8h.01M12 8h.01' };
const Icon = ({ name }: { name: keyof typeof ICONS }) => <svg className={`ico ico-${name}`} viewBox="0 0 16 16" aria-hidden="true"><path d={ICONS[name]} /></svg>;

/** The request, the steps on a rail (each folded), the response. The same as `wisdom open`. */
function ChatTurn({ s, turn, cited, manifest }: { s: SessionSummary; turn: number; cited: string[]; manifest: Manifest }) {
  const path = `${sessionPath(s.key)}/t${turn}.json`;
  const { data, error } = useData<Turn>(path in manifest.files ? path : undefined);
  // Which commit each file change of this turn went into, from those commits' pieces.
  const commits = useMany<Commit>(cited.map(sha => `commit/${sha}.json`));
  const inCommit = (file?: string) => file ? (commits ?? []).find(c => c?.files.some(f => f.path === file && f.pieces.some(p => p.steps.some(x => x.session === s.key && x.turn === turn))))?.sha : undefined;
  if (!(path in manifest.files)) return <p className="small muted" style={{ margin: 0 }}>This build has no text for this turn.</p>;
  if (error) return <p className="small t-bad" style={{ margin: 0 }}>{error}</p>;
  if (!data) return <p className="small muted" style={{ margin: 0 }}>Reading the turn…</p>;
  const last = [...data.items].reverse().find(item => item.kind === 'text');
  const steps = data.items.filter(item => item !== last);
  return (
    <>
      <div className="prompt"><span className="kicker">Request · {s.person}</span><Markdown text={data.request} /></div>
      {steps.length > 0 && <div className="steps">{steps.map(item => <Item key={item.id} item={item} harness={s.harness} inCommit={inCommit} />)}</div>}
      <div className="response"><span className="kicker">Response · {s.harness}</span>
        {last?.kind === 'text' ? <><Markdown text={last.text.text} /><Clipped body={last.text} /></> : <p className="muted small">No reply recorded for this turn.</p>}</div>
      <p className="foot">The same as <code>wisdom open t{turn} --capture {s.id}</code>.</p>
    </>
  );
}

function Item({ item, harness, inCommit }: { item: TurnItem; harness: string; inCommit: (file?: string) => string | undefined }) {
  if (item.kind === 'text') return <div className="narration"><Markdown text={item.text.text} /><Clipped body={item.text} /></div>;
  if (item.kind === 'thinking') {
    const seconds = item.durationMs !== undefined ? ` for ${(item.durationMs / 1000).toFixed(item.durationMs < 10000 ? 1 : 0)}s` : '';
    return (
      <details className="fold"><summary><Icon name="thought" /><span className="muted">Thought{seconds}{item.redacted ? ' · text not recorded' : ''}</span></summary>
        {!item.redacted && <div className="fold-body"><Markdown text={item.text.text} /><Clipped body={item.text} /></div>}</details>
    );
  }
  if (item.kind === 'tool') return <ToolItem tool={item} harness={harness} inCommit={inCommit} />;
  if (item.kind === 'change') return <ChangeItem change={item} inCommit={inCommit} />;
  return <SubagentItem sub={item.subagent} harness={harness} inCommit={inCommit} />;
}

function target(tool: Tool): string {
  if (!tool.input) return '';
  try {
    const input = JSON.parse(tool.input.text);
    const path = input.file_path ?? input.path ?? input.notebook_path;
    if (typeof path === 'string') return path.split(/[\\/]/).filter(Boolean).slice(-2).join('/');
    const value = input.command ?? input.cmd ?? input.pattern ?? input.url ?? input.description ?? input.message;
    if (typeof value === 'string') return value;
  } catch { /* not JSON */ }
  return '';
}

function ToolItem({ tool, harness, inCommit }: { tool: Tool; harness: string; inCommit: (file?: string) => string | undefined }) {
  const label = { ok: 'ok', error: 'failed', recorded: 'done', pending: 'no result' }[tool.status];
  return (
    <details className={`fold ${tool.status === 'error' ? 'failed' : ''}`}>
      <summary><Icon name="tool" /><b>{tool.name}</b><span className="target">{target(tool)}</span><span className="spacer" />
        {tool.changes.length > 0 && <span className="tag">{plural(tool.changes.length, 'change')}</span>}
        <span className={`state ${tool.status === 'error' ? 'bad' : tool.status === 'ok' ? 'ok' : ''}`}>{label}</span></summary>
      <div className="fold-body">
        {tool.input && <Section title="Input" body={tool.input} />}
        {tool.output ? <Section title="Output" body={tool.output} /> : <p className="muted small">{tool.status === 'pending' ? 'No result was recorded.' : 'No output body.'}</p>}
        {tool.changes.map(change => <ChangeItem key={change.id} change={change} inCommit={inCommit} />)}
        {tool.subagent && <SubagentItem sub={tool.subagent} harness={harness} inCommit={inCommit} />}
      </div>
    </details>
  );
}

function ChangeItem({ change, inCommit }: { change: FileChange; inCommit: (file?: string) => string | undefined }) {
  const sign = change.operation === 'create' ? '+' : change.operation === 'delete' ? '−' : '±';
  const sha = inCommit(change.path);
  return (
    <details className="fold">
      <summary><span className="mono">{sign}</span><span className="target">{change.path}</span><span className="spacer" />
        {sha && <span className="tag this">{short(sha)}</span>}
        <span className={`tag ${change.attribution === 'observed-during-tool' ? '' : 'warn'}`}>{change.attribution === 'observed-during-tool' ? 'during tool' : 'external/unknown'}</span></summary>
      <div className="fold-body">
        {change.patch ? <Diff body={change.patch} /> : <p className="muted small">{change.patchUnavailable ?? 'No patch recorded.'}</p>}
        {sha && <p className="small muted" style={{ margin: '6px 0 0' }}>In commit <button className="pos" onClick={() => go({ view: 'commit', sha })}>{short(sha)}</button></p>}
      </div>
    </details>
  );
}

function SubagentItem({ sub, harness, inCommit }: { sub: Sub; harness: string; inCommit: (file?: string) => string | undefined }) {
  return (
    <details className="fold"><summary><Icon name="tool" /><b>{sub.agentType || 'Subagent'}</b><span className="target">{sub.agentId.slice(-8)}</span></summary>
      <div className="fold-body"><div className="sub-box">
        {sub.task && <><span className="kicker">Task</span><Markdown text={sub.task.text} /></>}
        {sub.items.map(item => <Item key={item.id} item={item} harness={harness} inCommit={inCommit} />)}
        {sub.report && <><span className="kicker">Returned</span><Markdown text={sub.report.text} /></>}
      </div></div>
    </details>
  );
}

function Section({ title, body }: { title: string; body: Body }) {
  let text = body.text;
  try { if (!body.truncated) text = JSON.stringify(JSON.parse(text), null, 2); } catch { /* plain text */ }
  return <div><span className="kicker" style={{ marginTop: 6 }}>{title}</span><pre>{text}</pre><Clipped body={body} /></div>;
}

function Diff({ body }: { body: Body }) {
  const lines = body.text.split('\n').filter(line => !/^Index: /.test(line) && !/^=+$/.test(line));
  return <pre className="diff">{lines.map((line, i) => <span key={i} className={line.startsWith('+') && !line.startsWith('+++') ? 'add' : line.startsWith('-') && !line.startsWith('---') ? 'del' : ''}>{line}{'\n'}</span>)}</pre>;
}

/** Long text keeps its size: nothing is cut without saying so. */
function Clipped({ body }: { body: Body }) {
  return body.truncated ? <div className="muted small">Showing {body.text.length.toLocaleString()} of {body.totalChars?.toLocaleString()} characters. <code>wisdom open</code> on the recording has the rest.</div> : null;
}
