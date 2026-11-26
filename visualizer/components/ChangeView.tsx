'use client';

import { useState } from 'react';
import type { Change, Commit, CommitSummary, Index, Manifest, SessionSummary, SessionTurns, Status } from '@contract';
import { sessionPath } from '@contract';
import { useData, useMany } from '@/lib/data';
import { go } from '@/lib/route';
import { BASIS, COLOR, HOW, LINE, RANK, STATUS, TONE, plural, reasonWords, short } from '@/lib/words';
import { Avatar, Crumbs, Dot, FoundPath, Head, Legend, Needs, Seg, StateNote, type NeedItem } from './bits';
import { Canvas } from './Canvas';

const isMerge = (c: CommitSummary) => c.parents.length > 1;

/** Level 1: a change, open or merged: a pull request, or (on this machine) a branch's work. */
export function ChangeView({ id, index, manifest, selected, onSelect, onMainPick }: { id: string; index: Index; manifest: Manifest;
  selected?: string; onSelect: (key?: string) => void; onMainPick: (key: string) => void }) {
  const { data: change, error, missing } = useData<Change>(`change/${id}.json`);
  const [mode, setMode] = useState<'canvas' | 'list'>('canvas');
  // Each commit's file says which turns it points to and whether it has a guide.
  const commits = useMany<Commit>(change ? change.commits.map(c => `commit/${c.sha}.json`) : []);
  if (missing) return <StateNote title="No such change in this build">It may have been renamed, or it is older than this build reads.</StateNote>;
  if (error) return <StateNote title="This change could not be read">{error}</StateNote>;
  if (!change) return <StateNote title="Reading…" />;

  const byCommit = new Map((commits ?? []).flatMap(c => c ? [[c.sha, c] as const] : []));
  const real = change.commits.filter(c => !isMerge(c));
  const sessions = change.sessions.map(key => index.sessions.find(s => s.key === key)).filter((s): s is SessionSummary => !!s);
  const people = new Set([change.author, ...change.commits.map(c => c.author), ...sessions.map(s => s.person)]);
  const open = change.state === 'open';
  const name = change.pr ? `#${change.pr} ${change.title}` : change.title;
  const from = change.branch ? <> from <code>{change.branch}</code></> : null;
  const who = open ? <>{change.author} wants to merge {plural(change.commits.length, 'commit')}{from} into <code>{index.main}</code></>
    : change.state === 'merged' ? <>{change.author} merged {plural(change.commits.length, 'commit')}{from}{change.landed ? ` · ${HOW[change.landed.how]}` : ''}</>
    : <>{change.author}&apos;s {plural(change.commits.length, 'commit')}{from} · closed without merging</>;

  // The page opens with what needs a look: the change's own reasons first (a position-only link
  // is about main's commit, not the branch's), then its commits, worst first.
  const needs: NeedItem[] = [
    ...change.needs.filter(r => !r.commit || !change.commits.some(c => c.sha === r.commit)).map(r => ({
      status: 'attention' as Status, label: <code>{r.commit ? short(r.commit) : '—'}</code>, why: reasonWords(r),
      open: () => r.commit && go({ view: 'commit', sha: r.commit, change: change.id }) })),
    ...real.filter(c => c.status !== 'good').sort((a, b) => RANK[b.status] - RANK[a.status]).map(c => ({
      status: c.status, label: <code>{short(c.sha)}</code>, why: `${c.subject}${c.reasons[0] ? ` · ${reasonWords(c.reasons[0])}` : ''}`,
      open: () => go({ view: 'commit', sha: c.sha, change: change.id }) })),
  ];

  return (
    <>
      <Crumbs parts={[open ? { label: 'Active branches', open: () => go({ view: 'branches' }) } : { label: index.main, open: () => go({ view: 'main' }) }, { label: name }]} />
      <div className="card">
        <span className="kicker">{change.pr ? `Pull request #${change.pr} · ${change.state}` : `${change.branch ? 'Branch' : 'Change'} · ${change.state}`}</span>
        <h1>{change.title}</h1>
        <div className="row small muted" style={{ marginTop: 8 }}><Avatar name={change.author} /> {who}</div>
        <div className="facts"><span><b>{change.commits.length}</b> commits</span><span><b>{sessions.length}</b> sessions</span><span><b>{people.size}</b> {people.size === 1 ? 'person' : 'people'}</span></div>
        <p className="verdict">{sentence(real, change)}</p>
        <Needs items={needs} more={() => setMode('list')} />
      </div>
      {change.landed && <Landed change={change} onMainPick={onMainPick} />}
      <div className="card">
        <Head title="Commits and sessions" sub={mode === 'canvas' ? 'Each commit and the turns it points to' : 'Click a commit to open it'}>
          <span className="spacer" /><Seg label="Show as" value={mode} options={[['canvas', 'Canvas'], ['list', 'List']]} onChange={setMode} />
        </Head>
        {mode === 'canvas'
          ? <ChangeCanvas change={change} commits={byCommit} sessions={sessions} manifest={manifest} selected={selected} onSelect={onSelect} />
          : <CommitTable change={change} commits={byCommit} />}
      </div>
    </>
  );
}

/** One sentence for a set of commits; merge commits never count. */
function sentence(real: CommitSummary[], change: Change): React.ReactNode {
  const n = (st: Status) => real.filter(c => c.status === st).length;
  const [bad, look, none, good] = (['attention', 'look', 'none', 'good'] as Status[]).map(n);
  const order = change.landed?.onMain.some(m => m.from?.basis === 'order');
  if (!real.length) return 'No commits of its own.';
  if (!bad && !look && !none) return <>All {plural(real.length, 'commit')} are explained by recorded steps.{order && <> <span className="t-bad">One commit on main is tied to its commit by position only.</span></>}</>;
  const parts = [
    bad > 0 && <span key="b" className="t-bad">{bad} need{bad === 1 ? 's' : ''} attention</span>,
    look > 0 && <span key="w" className="t-warn">{look} need{look === 1 ? 's' : ''} a closer look</span>,
    none > 0 && <span key="n">{none} {none === 1 ? 'has' : 'have'} no record</span>,
    good > 0 && <span key="g">{good} {good === 1 ? 'is' : 'are'} all good</span>,
  ].filter(Boolean);
  return <>{parts.flatMap((part, k) => k ? [' · ', part] : [part])}.</>;
}

/** How a merged change reached main, and how each commit there ties back to the change's. */
function Landed({ change, onMainPick }: { change: Change; onMainPick: (key: string) => void }) {
  const landed = change.landed!;
  const branch = change.branch ? <code>{change.branch}</code> : 'the branch';
  const n = change.commits.length;
  let body: React.ReactNode;
  if (landed.how === 'merge') body = <>
    <p className="small">A merge commit, <code>{short(landed.onMain[0].sha)}</code>, joined {branch} into main. The {plural(n, 'commit')} are on main themselves, each with its own record, so nothing needed a link.</p>
    <FoundPath used="record" /></>;
  else if (landed.how === 'squash') {
    const m = landed.onMain[0];
    body = <>
      <p className="small">One new commit, <code>{short(m.sha)}</code>, was made from the {plural(n, 'commit')}. It has no record of its own:
        {m.from ? <> a link ({BASIS[m.from.basis]}, written by <code>{m.from.writer}</code>) leads to the {plural(m.from.commits.length, 'commit')} it came from, and their records stand for it.</> : <> no link leads back to the commits it came from.</>}</p>
      <FoundPath used={m.from ? 'link' : 'unlinked'} /></>;
  } else body = <>
    <p className="small">Each commit got a new sha on main. A link ties each to the commit it came from:</p>
    <table className="pairs"><tbody>
      {landed.onMain.map(m => {
        const orig = m.from?.commits[0];
        return (
          <tr key={m.sha}>
            <td>{orig ? <button className="pos" onClick={() => go({ view: 'commit', sha: orig, change: change.id })}>{short(orig)}</button> : <span className="muted">—</span>}</td>
            <td className="muted">→</td><td><code>{short(m.sha)}</code> on main</td>
            <td>{m.from ? <span className={`label ${m.from.basis === 'order' ? 'bad' : 'lb-rec'}`}>{BASIS[m.from.basis]}</span> : <span className="label bad">no link</span>}
              {m.from?.basis === 'order' && <div className="small muted" style={{ marginTop: 4 }}>The change is not identical, so the pairing is a judgement of order, not of content.</div>}</td>
          </tr>
        );
      })}
    </tbody></table>
    <div style={{ marginTop: 10 }}><FoundPath used="link" /></div></>;
  return (
    <div className="card">
      <Head title="How it landed on main" sub={HOW[landed.how][0].toUpperCase() + HOW[landed.how].slice(1)} />
      {body}
      <p className="small" style={{ margin: '12px 0 0' }}><button className="pos" onClick={() => onMainPick(`change:${change.id}`)}>See it on main&apos;s canvas ›</button></p>
    </div>
  );
}

function guideWord(c?: Commit): React.ReactNode {
  if (!c) return <span className="muted">—</span>;
  if (c.guide) return c.guide.problems.length ? <span className="t-bad">failed its check</span> : 'yes';
  if (c.guideMissing || c.reasons.some(r => r.code === 'no-guide')) return <span className="t-bad">missing</span>;
  return <span className="muted">—</span>;
}

function CommitTable({ change, commits }: { change: Change; commits: Map<string, Commit> }) {
  return (
    <table>
      <thead><tr><th>Commit</th><th>By</th><th>Sessions</th><th>Guide</th><th>Status</th></tr></thead>
      <tbody>
        {change.commits.map(c => (
          <tr key={c.sha} className="click" onClick={() => go({ view: 'commit', sha: c.sha, change: change.id })}>
            <td><span className="lead"><Dot status={c.status} /><code>{short(c.sha)}</code> {c.subject}</span>{c.reasons[0] && <div className="note">{reasonWords(c.reasons[0])}</div>}</td>
            <td><Avatar name={c.author} /></td>
            <td className="num">{c.sessions || <span className="muted">—</span>}</td>
            <td className="small">{isMerge(c) ? <span className="muted">—</span> : guideWord(commits.get(c.sha))}</td>
            <td className={`small t-${TONE[c.status]}`}>{isMerge(c) && c.status === 'none' ? 'merge' : STATUS[c.status]}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ---------- the canvas: commits on the branch above, sessions below, straight wires ----------

/** At most this many turn boxes in one snippet; a longer stretch shows two, ⋯, two. */
const MAX_BOXES = 5;
/** A stretch of consecutive turns with the same owner: a commit of this change, another commit, or none. */
type Snip = { from: number; to: number; owner?: string; other?: boolean; x: number; w: number };

/** Which commit each turn belongs to. The change's own commits come from their pieces (each step
 * names its turn), or the record's window when the session is not here; other commits from the
 * session's turn list. */
function owners(key: string, change: Change, commits: Map<string, Commit>, listing?: SessionTurns): Map<number, { sha: string; other?: boolean }> {
  const out = new Map<number, { sha: string; other?: boolean }>();
  for (const c of change.commits) {
    const file = commits.get(c.sha);
    if (!file) continue;
    for (const f of file.files) for (const p of f.pieces) for (const s of p.steps) if (s.session === key && s.turn && !out.has(s.turn)) out.set(s.turn, { sha: c.sha });
    const named = file.sessionsNamed.find(s => s.key === key);
    if (named?.turns) for (let t = named.turns[0]; t <= named.turns[1]; t++) if (!out.has(t)) out.set(t, { sha: c.sha });
  }
  for (const t of listing?.turnList ?? []) if (!out.has(t.turn) && t.cited[0]) out.set(t.turn, { sha: t.cited[0], other: true });
  return out;
}

function ChangeCanvas({ change, commits, sessions, manifest, selected, onSelect }: { change: Change; commits: Map<string, Commit>; sessions: SessionSummary[];
  manifest: Manifest; selected?: string; onSelect: (key?: string) => void }) {
  // A session's turn list, when this build has it (a session not on the remote has none).
  const listings = useMany<SessionTurns>(sessions.map(s => `${sessionPath(s.key)}/index.json`).filter(path => path in manifest.files));
  const listingOf = (key: string) => listings?.find(l => l?.key === key);

  const X0 = 300, GAP = 140, CW = 112, CH = 46, LANE_MAIN = 44, LANE = 140, TOP = 250, ROW = 44, CELL = 14, STEP = 17;
  const cs = change.commits;
  const xOf = new Map(cs.map((c, i) => [c.sha, X0 + i * GAP]));
  const lastX = X0 + Math.max(0, cs.length - 1) * GAP;

  // Each session as snippets: a snippet sits just left of the commit it belongs to, never over the one before.
  const rows = sessions.map(s => {
    const own = owners(s.key, change, commits, listingOf(s.key));
    const present = !!listingOf(s.key) || s.turns > 0;
    const last = Math.max(present ? s.turns : 0, ...own.keys());
    const turns = present ? Array.from({ length: last }, (_, i) => i + 1) : [...own.keys()].sort((a, b) => a - b);
    const snips: Snip[] = [];
    for (const t of turns) {
      const o = own.get(t), prev = snips.at(-1);
      if (prev && prev.to === t - 1 && prev.owner === o?.sha) prev.to = t;
      else snips.push({ from: t, to: t, owner: o?.sha, other: o?.other, x: 0, w: 0 });
    }
    let cursor = 200;
    for (const g of snips) {
      g.w = Math.min(g.to - g.from + 1, MAX_BOXES) * STEP;
      const want = g.owner && !g.other && xOf.has(g.owner) ? xOf.get(g.owner)! - 26 - g.w : cursor;
      g.x = Math.max(want, cursor);
      cursor = g.x + g.w + 24;
    }
    return { s, snips, missing: !present, end: cursor };
  });
  const rowY = (i: number) => TOP + i * ROW;
  const merged = change.state === 'merged' && change.landed;
  const W = Math.max(X0 + cs.length * GAP + 60 + (merged ? 260 : 0), ...rows.map(r => r.end + 40));
  const H = TOP + Math.max(1, rows.length) * ROW + 40;

  // A picked snippet is `session:<key>#<from>-<to>`: it highlights like its session, and its frame.
  const [kind, key] = selected ? [selected.slice(0, selected.indexOf(':')), selected.slice(selected.indexOf(':') + 1).split('#')[0]] : [];
  const cites = (sha: string, session: string) => rows.some(r => r.s.key === session && r.snips.some(g => g.owner === sha && !g.other));
  const pick = (k: string) => onSelect(k === selected ? undefined : k);

  return (
    <>
      <Canvas id={`change-${change.id}`} width={W} height={H} onPick={pick}>
        <text x={20} y={LANE_MAIN - 12} className="lane-label">main</text>
        {change.branch && <text x={122} y={LANE - CH / 2 - 10} className="lane-label">{change.branch}</text>}
        <line x1={20} y1={LANE_MAIN} x2={W - 20} y2={LANE_MAIN} stroke="var(--line-strong)" strokeWidth={2} />
        <path className="wire" style={{ stroke: 'var(--accent)', strokeWidth: 2, opacity: .55 }} d={`M110 ${LANE_MAIN} V ${LANE} H ${lastX}`} />
        <circle cx={110} cy={LANE_MAIN} r={5} fill="var(--surface)" stroke="var(--faint)" strokeWidth={2} />
        {change.base && <text x={122} y={LANE_MAIN - 10} className="id">{short(change.base)}</text>}
        {/* a merge from main into the branch comes down from main */}
        {cs.filter(isMerge).map(c => { const mx = xOf.get(c.sha)!; return (
          <g key={`m-${c.sha}`}>
            <path className="wire" style={{ strokeDasharray: '5 4', strokeWidth: 1.5 }} d={`M${mx - 44} ${LANE_MAIN} V ${LANE - CH / 2 - 10} H ${mx} V ${LANE - CH / 2}`} />
            <circle cx={mx - 44} cy={LANE_MAIN} r={5} fill="var(--surface)" stroke="var(--faint)" strokeWidth={2} />
            <text x={mx - 32} y={LANE_MAIN - 10} className="id">{short(c.parents[1])}</text>
          </g>
        ); })}
        {/* a merged change ends where it joined main, said the way it joined */}
        {merged && (() => {
          const landed = change.landed!, ex = lastX + CW / 2 + 44;
          const words = landed.how === 'merge' ? `merge commit ${short(landed.onMain[0].sha)}` : landed.how === 'squash' ? `squashed into ${short(landed.onMain[0].sha)}`
            : landed.how === 'rebase' ? `rebased as ${landed.onMain.map(m => short(m.sha)).join(', ')}` : `landed as ${landed.onMain.map(m => short(m.sha)).join(', ')}`;
          return <g>
            <path className="wire" style={{ stroke: 'var(--accent)', strokeWidth: 2, opacity: .55, strokeDasharray: landed.how === 'merge' ? undefined : '5 4' }} d={`M${lastX + CW / 2} ${LANE} H ${ex} V ${LANE_MAIN}`} />
            <circle cx={ex} cy={LANE_MAIN} r={5} fill="var(--surface)" stroke="var(--accent)" strokeWidth={2} />
            <text x={ex + 12} y={LANE_MAIN - 10}>{words}</text>
          </g>;
        })()}
        {/* an amended commit: the one it replaced, as on main's canvas */}
        {cs.filter(c => c.from?.how === 'amend').map(c => { const x = xOf.get(c.sha)!, gy = LANE - CH / 2 - 26, was = c.from!.commits[0]; return (
          <g key={`a-${c.sha}`} className="ghost"><title>{`${short(c.sha)} was amended from ${short(was)}: ${BASIS[c.from!.basis]}`}</title>
            <path className={`link ${LINE[c.from!.basis] ?? ''}`} d={`M${x} ${gy + 6} V ${LANE - CH / 2}`} /><circle cx={x} cy={gy} r={6} />
            <text x={x + 11} y={gy + 4} className="id" style={{ fill: 'var(--muted)' }}>{short(was)} · amended</text></g>
        ); })}

        <text x={20} y={TOP - 22} className="lane-label">Sessions</text>
        {!rows.length && <text x={20} y={TOP + 8} style={{ fill: 'var(--muted)' }}>No session points to these commits.</text>}
        {/* wires first, under everything: from a commit's bottom straight down to its snippet, then across */}
        {rows.flatMap((r, i) => r.snips.filter(g => g.owner && !g.other && xOf.has(g.owner)).map(g => {
          const x = xOf.get(g.owner!)!, y = rowY(i) - 7, b = g.x + g.w - STEP + CELL;
          const hi = kind === 'commit' && key === g.owner || kind === 'session' && key === r.s.key;
          return <path key={`w-${r.s.key}-${g.from}`} className={`wire ${hi ? 'hi' : ''}`} d={`M${x} ${LANE + CH / 2} V ${y} H ${g.x} V ${y + 4} M${b} ${y} V ${y + 4}`} />;
        }))}
        {rows.map((r, i) => {
          const y = rowY(i), s = r.s;
          const dim = kind === 'commit' && !cites(key!, s.key) || kind === 'session' && key !== s.key;
          return (
            <g key={s.key} className={dim ? 'dim' : ''}>
              <g className="slabel" data-pick={`session:${s.key}`}><title>{`${s.title || s.id} · ${s.person} · ${plural(s.turns, 'turn')}${r.missing ? ' · not on the remote' : ''}`}</title>
                <rect className="box" x={20} y={y - 6} width={164} height={26} rx={6} fill="var(--surface)" stroke="var(--line)" />
                <text x={30} y={y + 11} className="id" style={{ fill: 'var(--ink)' }}>{short(s.id)}</text>
                <text x={100} y={y + 11} style={{ fill: 'var(--muted)' }}>{s.person.slice(0, 8)}</text>
                {r.missing && <text x={176} y={y + 11} textAnchor="end" style={{ fill: 'var(--bad)' }}>missing</text>}
              </g>
              {r.snips.map(g => {
                const n = g.to - g.from + 1, shown = n <= MAX_BOXES ? Array.from({ length: n }, (_, k) => k) : [0, 1, 3, 4];
                const owner = g.owner ? short(g.owner) : 'no commit';
                const picked = selected === `session:${s.key}#${g.from}-${g.to}`;
                return (
                  <g key={g.from} className="turn snip" data-pick={`session:${s.key}#${g.from}-${g.to}`}>
                    <title>{`${short(s.id)} t${g.from}${n > 1 ? `–t${g.to}` : ''} · ${plural(n, 'turn')} · ${owner}${g.other ? ' (another change)' : ''}`}</title>
                    <rect className="frame" x={g.x - 5} y={y - 5} width={g.w + 6} height={CELL + 10} rx={5} fill={picked ? 'var(--surface)' : 'transparent'} stroke={picked ? 'var(--accent)' : 'transparent'} strokeWidth={1.5} />
                    {shown.map(slot => <rect key={slot} className={`tb ${g.owner ? '' : 'none'} ${r.missing ? 'held' : ''}`} style={g.other ? { opacity: .4 } : undefined}
                      x={g.x + slot * STEP} y={y} width={CELL} height={CELL} rx={3} />)}
                    {n > MAX_BOXES && <><text x={g.x + 2 * STEP + 2} y={y + 11} style={{ fill: 'var(--muted)' }}>⋯</text>
                      <text x={g.x} y={y + CELL + 15} style={{ fill: 'var(--faint)', fontSize: 11 }}>{n} turns</text></>}
                  </g>
                );
              })}
            </g>
          );
        })}
        {/* commit cards */}
        {cs.map(c => {
          const x = xOf.get(c.sha)!;
          const dim = kind === 'session' && !cites(c.sha, key!);
          const tip = `${short(c.sha)} ${c.subject} · ${isMerge(c) && c.status === 'none' ? 'merge' : STATUS[c.status]}`;
          return (
            <g key={c.sha} className={`node ${kind === 'commit' && key === c.sha ? 'sel' : ''} ${dim ? 'dim' : ''}`} data-pick={`commit:${c.sha}`}><title>{tip}</title>
              <rect className="box" x={x - CW / 2} y={LANE - CH / 2} width={CW} height={CH} rx={6} />
              <circle cx={x - CW / 2 + 13} cy={LANE - 6} r={3.5} fill={COLOR[c.status]} />
              <text x={x - CW / 2 + 22} y={LANE - 2} className="id" style={{ fill: 'var(--ink)' }}>{short(c.sha)}</text>
              <text x={x - CW / 2 + 9} y={LANE + 15} style={{ fill: 'var(--muted)' }}>{isMerge(c) ? 'merge' : c.sessions ? plural(c.sessions, 'session') : 'no record'}</text>
            </g>
          );
        })}
      </Canvas>
      <Legend>
        <span><i className="tbox" /> turns a commit points to</span><span><i className="box" /> no commit</span>
        {cs.some(c => c.from?.how === 'amend') && <span><i className="ghost" /> before an amend</span>}
      </Legend>
    </>
  );
}
