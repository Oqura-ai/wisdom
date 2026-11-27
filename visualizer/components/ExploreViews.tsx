'use client';

import type { Index, Manifest, MainEntry } from '@contract';
import { go } from '@/lib/route';
import { ago, short } from '@/lib/words';
import { Avatar, Dot } from './bits';
import { SessionItem } from './SessionsPanel';

const toggle = (selected: string | undefined, key: string, onSelect: (key?: string) => void) => onSelect(selected === key ? undefined : key);

/** Everyone who committed or recorded since team mode, by username: a few columns, the rest in the panel. */
export function PeopleView({ index, mode, selected, onSelect }: { index: Index; mode: 'team' | 'local'; selected?: string; onSelect: (key?: string) => void }) {
  return (
    <div className="card">
      <span className="kicker">Explore</span><h1>People</h1>
      <p className="small muted" style={{ margin: '6px 0 14px' }}>Everyone who committed or recorded {mode === 'team' ? 'since team mode' : 'on this machine'}, by username · click one</p>
      <table>
        <thead><tr><th>Person</th><th>Commits</th><th>Sessions</th><th>Changes</th><th>Last active</th></tr></thead>
        <tbody>
          {index.people.map(p => (
            <tr key={p.username} className={`click ${selected === `person:${p.username}` ? 'on' : ''}`} onClick={() => toggle(selected, `person:${p.username}`, onSelect)}>
              <td className="nowrap"><span className="lead"><Avatar name={p.username} /> {p.username}</span></td>
              <td className="num">{p.commits}</td><td className="num">{p.sessions || <span className="muted">—</span>}</td><td className="num">{p.changes || <span className="muted">—</span>}</td>
              <td className="small muted nowrap">{ago(p.lastActiveAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Every session a record names, newest first. One a record names but this build lacks is red. */
export function SessionsView({ index, mode, selected, onSelect }: { index: Index; mode: 'team' | 'local'; selected?: string; onSelect: (key?: string) => void }) {
  const where = mode === 'team' ? 'On the remote' : 'Here';
  return (
    <div className="card">
      <span className="kicker">Explore</span><h1>Sessions</h1>
      <p className="small muted" style={{ margin: '6px 0 14px' }}>Sessions a commit&apos;s record names, newest first · click one to read its turns</p>
      <table>
        <thead><tr><th>Session</th><th>By</th><th>Turns</th><th>Commits pointing here</th><th>{where}</th></tr></thead>
        <tbody>
          {index.sessions.map(s => (
            <tr key={s.key} className={`click ${selected === `session:${s.key}` ? 'on' : ''}`} onClick={() => toggle(selected, `session:${s.key}`, onSelect)}>
              <td><code>{short(s.id)}</code>{s.title && <div className="note">{s.title}</div>}</td>
              <td><Avatar name={s.person} /></td>
              <td className="num">{s.turns || <span className="muted">—</span>}</td>
              <td><span className="row">{s.commits.map(sha => <button key={sha} className="pos" onClick={e => { e.stopPropagation(); go({ view: 'commit', sha }); }}>{short(sha)}</button>)}</span></td>
              <td className={`small ${s.turns ? '' : 't-bad'}`}>{s.turns ? 'yes' : 'missing: named by a record'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** A person in the panel: only what this build holds, their changes and the sessions they recorded. */
export function PersonPanel({ name, index, manifest }: { name: string; index: Index; manifest: Manifest }) {
  const person = index.people.find(p => p.username === name);
  if (!person) return null;
  const landed = index.changes.entries.filter(e => (e.kind === 'change' ? e.author : e.commit.author) === name);
  const branches = index.branches.filter(b => b.author === name);
  const sessions = index.sessions.filter(s => s.person === name);
  const open = (e: MainEntry) => e.kind === 'change' ? go({ view: 'change', id: e.change }) : go({ view: 'commit', sha: e.commit.sha });
  return (
    <>
      <span className="kicker">Person</span><h3 className="row" style={{ gap: 10 }}><Avatar name={name} /> {name}</h3>
      <div className="facts"><span><b>{person.commits}</b> commits</span><span><b>{person.sessions}</b> sessions</span><span><b>{person.changes}</b> changes</span></div>
      <p className="small muted" style={{ marginTop: 10 }}>Only what this build holds: their commits and the sessions they recorded. How their machine is set up is not known here.</p>
      <span className="kicker" style={{ marginTop: 16 }}>Recent on {index.main}</span>
      {landed.map(e => (
        <div key={e.kind === 'change' ? e.change : e.commit.sha} className="row small" style={{ margin: '4px 0' }}>
          <Dot status={e.kind === 'change' ? e.status : e.commit.status} />
          <button className="pos" onClick={() => open(e)}>{e.kind === 'change' ? /^\d+$/.test(e.change) ? `#${e.change}` : short(e.change) : short(e.commit.sha)}</button>
          {e.kind === 'change' ? e.title : e.commit.subject}
        </div>
      ))}
      {!landed.length && <p className="small muted">None in the latest changes.</p>}
      {branches.length > 0 && <><span className="kicker" style={{ marginTop: 16 }}>Active branches</span>
        {branches.map(b => <div key={b.name} className="row small" style={{ margin: '4px 0' }}><Dot status={b.status} /><code>{b.name}</code></div>)}</>}
      <span className="kicker" style={{ marginTop: 16, marginBottom: 8 }}>Sessions recorded</span>
      <div className="plist">{sessions.map(s => <SessionItem key={s.key} s={s} manifest={manifest} />)}</div>
      {!sessions.length && <p className="small muted">None in this build.</p>}
    </>
  );
}
