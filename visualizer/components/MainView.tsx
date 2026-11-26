'use client';

import { useState } from 'react';
import type { Change, Index, MainEntry, MainPage, Status } from '@contract';
import { load, useMany } from '@/lib/data';
import { go } from '@/lib/route';
import { COLOR, HOW, LINE, BASIS, RANK, SINCE, STATUS, plural, reasonWords, short, trunc } from '@/lib/words';
import { Avatar, Dot, Head, Legend, Needs, type NeedItem } from './bits';
import { Canvas } from './Canvas';

const entryKey = (e: MainEntry) => e.kind === 'change' ? `change:${e.change}` : `commit:${e.commit.sha}`;
const entryStatus = (e: MainEntry): Status => e.kind === 'change' ? e.status : e.commit.status;
const open = (e: MainEntry) => e.kind === 'change' ? go({ view: 'change', id: e.change }) : go({ view: 'commit', sha: e.commit.sha });

/** Level 0: main, what has landed on it. */
export function MainView({ index, selected, onSelect }: { index: Index; selected?: string; onSelect: (key?: string) => void }) {
  // Later pages come when asked: main shows the last 10 changes by default.
  const [pages, setPages] = useState<MainPage[]>([index.changes]);
  const entries = pages.flatMap(page => page.entries);
  const last = pages[pages.length - 1];
  const since = SINCE[index.since ?? 'team-mode'];
  const changes = useMany<Change>(entries.flatMap(e => e.kind === 'change' ? [`change/${e.change}.json`] : []));
  const byId = new Map((changes ?? []).flatMap(c => c ? [[c.id, c] as const] : []));

  const count = (st: Status) => entries.filter(e => entryStatus(e) === st).length;
  const needs: NeedItem[] = entries.filter(e => entryStatus(e) !== 'good')
    .sort((a, b) => RANK[entryStatus(b)] - RANK[entryStatus(a)])
    .map(e => e.kind === 'change'
      ? { status: e.status, label: <code>{byId.get(e.change)?.pr ? `#${e.change}` : trunc(e.title, 24)}</code>, why: `${e.title}${e.reasons[0] ? ` · ${reasonWords(e.reasons[0])}` : ''}`, open: () => open(e) }
      : { status: e.commit.status, label: <code>{short(e.commit.sha)}</code>, why: `${e.commit.subject}${e.commit.reasons[0] ? ` · ${reasonWords(e.commit.reasons[0])}` : ''}`, open: () => open(e) });

  const more = async () => { if (last.next) { const page = await load<MainPage>(last.next); setPages(current => [...current, page]); } };

  return (
    <>
      <div className="card">
        <span className="kicker">What has landed</span><h1>{index.main}</h1>
        <div className="facts">
          <span><b>{entries.length}</b> {entries.length === 1 ? 'change' : 'changes'}{last.next ? ' shown' : ` since ${since}`}</span>
          <span><b>{index.sessions.length}</b> sessions recorded</span>
          {last.earlier && <span><b>{last.earlier.commits}</b> earlier commits, before {since}</span>}
        </div>
        <p className="verdict">
          {entries.length ? <>{count('good')} of {entries.length} are explained by recorded sessions
            {count('attention') > 0 && <> · <span className="t-bad">{count('attention')} need{count('attention') === 1 ? 's' : ''} attention</span></>}
            {count('look') > 0 && <> · <span className="t-warn">{count('look')} need{count('look') === 1 ? 's' : ''} a closer look</span></>}
            {count('none') > 0 && <> · {count('none')} {count('none') === 1 ? 'has' : 'have'} no record</>}.</> : `Nothing has landed since ${since}.`}
        </p>
        <Needs items={needs} />
      </div>

      {entries.length > 0 && (
        <div className="card">
          <Head title="How each change landed" sub="Oldest on the left · click a card to preview it" />
          <MainCanvas entries={entries} earlier={last.earlier?.commits} since={since} changes={byId} selected={selected} onSelect={onSelect} />
        </div>
      )}

      <div className="card">
        <Head title="History" sub="Newest first · click a row to open it" />
        <table>
          <thead><tr><th>Change</th><th>How it landed</th><th>Commits</th><th>Sessions</th><th>By</th></tr></thead>
          <tbody>
            {entries.map(e => e.kind === 'change' ? (
              <tr key={entryKey(e)} className="click" onClick={() => open(e)}>
                <td><span className="lead"><Dot status={e.status} />{byId.get(e.change)?.pr && <code>#{e.change}</code>} {e.title}</span>
                  {e.reasons[0] && <div className="note">{reasonWords(e.reasons[0])}</div>}</td>
                <td className="how">{HOW[e.how]} <span className="muted mono">{e.onMain.map(short).join(' ')}</span></td>
                <td className="num">{e.commits}</td><td className="num">{e.sessions}</td><td><Avatar name={e.author} /></td>
              </tr>
            ) : (
              <tr key={entryKey(e)} className="click" onClick={() => open(e)}>
                <td><span className="lead"><Dot status={e.commit.status} /><code>{short(e.commit.sha)}</code> {e.commit.subject}</span>
                  {e.commit.reasons[0] && <div className="note">{reasonWords(e.commit.reasons[0])}</div>}</td>
                <td className="how">direct</td><td className="num">1</td><td className="num">{e.commit.sessions || <span className="muted">—</span>}</td>
                <td><Avatar name={e.commit.author} /></td>
              </tr>
            ))}
            {last.next && <tr className="click folded" onClick={more}><td colSpan={5}>Show older changes ›</td></tr>}
            {last.earlier && <tr className="folded"><td colSpan={5}>{last.earlier.commits} earlier commits, before {since} <span className="small">· none can have a record</span></td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}

/** main's canvas: one card per change that landed, and how it landed. A squash is a comb of the
 * commits it came from (not on main any more); a merge commit's branch dips under main and comes
 * back; a rebase ties each new commit to the one it came from. A link's line says how we know. */
function MainCanvas({ entries, earlier, since, changes, selected, onSelect }: { entries: MainEntry[]; earlier?: number; since: string; changes: Map<string, Change>;
  selected?: string; onSelect: (key?: string) => void }) {
  const LANE = 164, CH = 46, GY = 56, GAP = 64;
  type Item = { e?: MainEntry; x0: number; w: number; cx: number };
  const items: Item[] = [];
  let x = 30;
  const oldestFirst = [...entries].reverse();
  if (earlier) { items.push({ x0: x, w: 128, cx: x + 64 }); x += 128 + GAP; }
  for (const e of oldestFirst) {
    const w = e.kind === 'change' && e.how === 'rebase' ? e.onMain.length * 112 - 8 : 160;
    if (e.kind === 'change' && e.how === 'merge') x += 36; // room for the branch to leave main
    items.push({ e, x0: x, w, cx: x + w / 2 });
    x += w + GAP;
  }
  const W = x + 40, H = LANE + 130;
  const keyOf = (item: Item) => item.e ? entryKey(item.e) : 'earlier';

  const card = (item: Item, x0: number, w: number, l1: React.ReactNode, l2: string, st: Status | undefined, tip: string, k = 0) => (
    <g key={`${keyOf(item)}:${k}`} className={`node ${selected === keyOf(item) ? 'sel' : ''} ${item.e ? '' : 'dashed'}`} data-pick={keyOf(item)}>
      <title>{tip}</title>
      <rect className="box" x={x0} y={LANE - CH / 2} width={w} height={CH} rx={6} />
      {st && <circle cx={x0 + 13} cy={LANE - 6} r={3.5} fill={COLOR[st]} />}
      <text x={x0 + (st ? 22 : 10)} y={LANE - 2} style={{ fill: 'var(--ink)' }}>{l1}</text>
      <text x={x0 + (st ? 9 : 10)} y={LANE + 15} style={{ fill: 'var(--muted)' }}>{l2}</text>
    </g>
  );
  const ghost = (gx: number, sha: string, k: string) => (
    <g key={k} className="ghost"><circle cx={gx} cy={GY} r={6} /><text x={gx} y={GY - 12} textAnchor="middle" className="id" style={{ fill: 'var(--muted)' }}>{short(sha)}</text></g>
  );

  return (
    <>
      <Canvas id="main" width={W} height={H} short onPick={key => onSelect(key === selected ? undefined : key)}>
        <text x={20} y={GY + 4} className="lane-label">not on main</text>
        <text x={20} y={LANE - CH / 2 - 10} className="lane-label">main</text>
        <line x1={20} y1={LANE} x2={W - 64} y2={LANE} stroke="var(--line-strong)" strokeWidth={2} />
        <text x={W - 56} y={LANE + 4} className="id" style={{ fill: 'var(--faint)' }}>HEAD</text>
        {items.map(item => {
          const dim = selected && selected !== keyOf(item) ? 'dim' : '';
          const e = item.e;
          if (!e) return <g key="earlier" className={dim}>{card(item, item.x0, item.w, `${earlier} earlier`, since === 'team mode' ? 'before team mode' : 'before recording', undefined, `${earlier} commits from before ${since}: none can have a record`)}</g>;
          if (e.kind === 'direct') {
            const c = e.commit;
            return <g key={keyOf(item)} className={dim}>{card(item, item.x0, item.w, <tspan className="id">{short(c.sha)}</tspan>,
              c.status === 'none' ? 'direct · no record' : `direct · ${plural(c.sessions, 'session')}`, c.status, `${short(c.sha)} ${c.subject} · ${STATUS[c.status]}`)}</g>;
          }
          const change = changes.get(e.change);
          const title = `${change?.pr ? `#${e.change} ` : ''}${trunc(e.title, change?.pr ? 15 : 20)}`;
          const tip = `${e.title} · ${HOW[e.how]} · ${plural(e.commits, 'commit')} · ${plural(e.sessions, 'session')} · ${STATUS[e.status]}`;
          if (e.how === 'squash') {
            const from = change?.landed?.onMain[0]?.from;
            const ghosts = from?.commits ?? [];
            const n = ghosts.length, sp = 56, gx0 = item.cx - (n - 1) * sp / 2, mid = GY + 32, cls = LINE[from?.basis ?? ''] ?? '';
            return (
              <g key={keyOf(item)} className={dim}>
                {n > 0 && <g><title>{`${short(e.onMain[0])} is a squash merge, ${BASIS[from!.basis]}. It came from ${plural(n, 'commit')}; their records stand for it.`}</title>
                  {ghosts.map((_, i) => <path key={i} className={`link ${cls}`} d={`M${gx0 + i * sp} ${GY + 6} V ${mid}`} />)}
                  <path className={`link ${cls}`} d={`M${gx0} ${mid} H ${gx0 + (n - 1) * sp} M${item.cx} ${mid} V ${LANE - CH / 2}`} />
                  {ghosts.map((sha, i) => ghost(gx0 + i * sp, sha, sha))}</g>}
                {card(item, item.x0, item.w, title, `squash · ${e.commits} commits → 1`, e.status, tip)}
              </g>
            );
          }
          if (e.how === 'merge') {
            const dy = LANE + 76;
            const own = change?.commits ?? [];
            return (
              <g key={keyOf(item)} className={dim}>
                <path className="wire" style={{ stroke: 'var(--muted)', strokeWidth: 1.5 }} d={`M${item.x0 - 32} ${LANE} V ${dy} H ${item.cx} V ${LANE + CH / 2}`}><title>merge commit: the branch&apos;s commits are on main themselves</title></path>
                <circle cx={item.x0 - 32} cy={LANE} r={4} fill="var(--surface)" stroke="var(--muted)" strokeWidth={1.5} />
                {own.slice(0, 3).map((c, i) => { const dx = item.x0 + 2 + i * 70; return <g key={c.sha}><circle cx={dx} cy={dy} r={5} fill="var(--surface)" stroke={COLOR[c.status]} strokeWidth={1.5} /><text x={dx + 10} y={dy + 4} className="id">{short(c.sha)}</text></g>; })}
                {own.length > 3 && <text x={item.x0 + 2 + 3 * 70} y={dy + 4} style={{ fill: 'var(--muted)' }}>+{own.length - 3}</text>}
                {change?.branch && <text x={item.x0 - 32} y={dy + 24} className="lane-label">{change.branch}</text>}
                {card(item, item.x0, item.w, title, `merge commit · ${plural(e.commits, 'commit')}`, e.status, tip)}
              </g>
            );
          }
          // A rebase: each commit on main, tied to the one it came from; the line says how we know.
          const onMain = change?.landed?.onMain ?? e.onMain.map(sha => ({ sha, from: undefined }));
          return (
            <g key={keyOf(item)} className={dim}>
              {onMain.map((m, i) => {
                const x0 = item.x0 + i * 112, cx = x0 + 52, orig = m.from?.commits[0];
                const origStatus = change?.commits.find(c => c.sha === orig)?.status;
                const st: Status = m.from?.basis === 'order' ? 'attention' : origStatus ?? e.status;
                return (
                  <g key={m.sha}>
                    {orig && <g><title>{`${short(m.sha)} came from ${short(orig)}: rebase merge, ${BASIS[m.from!.basis]}`}</title>
                      <path className={`link ${LINE[m.from!.basis] ?? ''}`} d={`M${cx} ${GY + 6} V ${LANE - CH / 2}`} />{ghost(cx, orig, `g-${m.sha}`)}</g>}
                    {card(item, x0, 104, <tspan className="id">{short(m.sha)}</tspan>, `${change?.pr ? `#${e.change} · ` : ''}${i + 1} of ${onMain.length}`, st, tip, i)}
                  </g>
                );
              })}
              <path className="wire" d={`M${item.x0} ${LANE + CH / 2 + 10} v5 H ${item.x0 + item.w} v-5`} />
              <text x={item.x0} y={LANE + CH / 2 + 32} className="lane-label">{title} · rebased</text>
            </g>
          );
        })}
      </Canvas>
      <Legend>
        <span><i className="ghost" /> a commit not on main any more</span><span><i className="line" /> git or GitHub said so</span>
        <span><i className="line patch" /> same change</span><span><i className="line order" /> position only</span>
      </Legend>
    </>
  );
}
