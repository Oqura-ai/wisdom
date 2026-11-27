'use client';

import { useState } from 'react';
import type { BranchSummary, Change, Index } from '@contract';
import { useMany } from '@/lib/data';
import { go } from '@/lib/route';
import { ago, reasonWords } from '@/lib/words';
import { Avatar, Dot, Head, Seg } from './bits';

const DAY = 86_400_000;
/** The filters: the last 30 days by default, 7 and 90 one click away (the builder reads 90). */
const SPANS: [number, string][] = [[7, '7 days'], [30, '30 days'], [90, '90 days']];

/** Work not on main yet, by when it was last active. Independent of main. */
export function BranchesView({ index, mode, selected, onSelect }: { index: Index; mode: 'team' | 'local'; selected?: string; onSelect: (key?: string) => void }) {
  const [days, setDays] = useState(30);
  const list = index.branches.filter(b => Date.now() - Date.parse(b.lastActiveAt) <= days * DAY)
    .sort((a, b) => Date.parse(b.lastActiveAt) - Date.parse(a.lastActiveAt));
  // In team mode a branch's change is its open pull request: its title goes in the row.
  const changes = useMany<Change>(list.flatMap(b => b.change ? [`change/${b.change}.json`] : []));
  const byId = new Map((changes ?? []).flatMap(c => c ? [[c.id, c] as const] : []));
  const team = mode === 'team';
  const open = (b: BranchSummary) => b.change ? go({ view: 'change', id: b.change }) : onSelect(selected === `branch:${b.name}` ? undefined : `branch:${b.name}`);

  return (
    <>
      <div className="card">
        <span className="kicker">Work not on {index.main} yet</span><h1>Active branches</h1>
        <div className="facts">
          <span><b>{list.length}</b> active in the last {days} days</span>
          {team && <span><b>{list.filter(b => b.change).length}</b> with an open pull request</span>}
        </div>
      </div>
      <div className="card">
        <Head title="Branches" sub="Most recent first · click one">
          <span className="spacer" /><Seg label="Active in the last" value={days} options={SPANS} onChange={setDays} />
        </Head>
        {list.length ? (
          <table>
            <thead><tr><th>Branch</th>{team && <th>Pull request</th>}<th>Last active</th><th>Commits</th><th>Sessions</th><th>By</th></tr></thead>
            <tbody>
              {list.map(b => {
                const change = b.change ? byId.get(b.change) : undefined;
                return (
                  <tr key={b.name} className={`click ${selected === `branch:${b.name}` ? 'on' : ''}`} onClick={() => open(b)}>
                    <td><span className="lead"><Dot status={b.status} /><code>{b.name}</code></span>{b.reasons[0] && <div className="note">{reasonWords(b.reasons[0])}</div>}</td>
                    {team && <td>{change?.pr ? <>#{change.pr} {change.title}</> : <span className="muted">no pull request yet</span>}</td>}
                    <td className="small muted nowrap">{ago(b.lastActiveAt)}</td>
                    <td className="num">{b.commits}</td>
                    <td className="num">{b.sessions || <span className="muted">—</span>}</td>
                    <td><Avatar name={b.author} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : <p className="small muted">No branch has work not on {index.main} from the last {days} days.{days < 90 && ' Try a longer span.'}</p>}
      </div>
    </>
  );
}
