'use client';

import { useEffect, useState } from 'react';
import type { Change, Commit, Index } from '@contract';
import { useData, useManifest } from '@/lib/data';
import { go, useRoute, type Route } from '@/lib/route';
import { STATUS, TONE, ago, plural, reasonWords, short } from '@/lib/words';
import { Dot, StateNote } from './bits';
import { MainView } from './MainView';

const THEMES = ['light', 'dark', 'night'] as const;

export function App() {
  const route = useRoute();
  const { manifest, newer, error } = useManifest();
  const index = useData<Index>(manifest ? 'index.json' : undefined);
  // What the panel previews: a card picked on a canvas. Going elsewhere clears it.
  const [selected, setSelected] = useState<string>();
  useEffect(() => setSelected(undefined), [route]);

  return (
    <div className="shell">
      <TopBar repository={manifest?.repository} mode={manifest?.mode} readAt={manifest?.snapshot.readAt} newer={newer} />
      <div className="body">
        <Nav route={route} index={index.data} />
        <main className="main">
          {error ? <StateNote title="No Commits data here yet">{error} The Commits build writes it (wisdom commits deploy, or wisdom commits on this machine).</StateNote>
            : index.error ? <StateNote title="This build could not be read">{index.error}</StateNote>
            : !index.data ? <StateNote title="Reading…" />
            : <View route={route} index={index.data} selected={selected} onSelect={setSelected} />}
        </main>
        <aside className="inspector"><Panel selected={selected} /></aside>
      </div>
    </div>
  );
}

function View({ route, index, selected, onSelect }: { route: Route; index: Index; selected?: string; onSelect: (key?: string) => void }) {
  switch (route.view) {
    case 'main': return <MainView index={index} selected={selected} onSelect={onSelect} />;
    default: return <StateNote title="Not built yet">This page comes in the next part of the Commits app.</StateNote>;
  }
}

function TopBar({ repository, mode, readAt, newer }: { repository?: string; mode?: 'team' | 'local'; readAt?: string; newer: boolean }) {
  const [theme, setTheme] = useState<string>();
  useEffect(() => setTheme(document.documentElement.dataset.theme), []);
  const pick = (t: string) => {
    document.documentElement.dataset.theme = t;
    try { localStorage.setItem('wisdom-theme', t); } catch { /* a private window: the choice lasts this page */ }
    setTheme(t);
  };
  // "read from origin 2 min ago" moves on by itself.
  const [, tick] = useState(0);
  useEffect(() => { const timer = setInterval(() => tick(n => n + 1), 30_000); return () => clearInterval(timer); }, []);
  return (
    <header className="topbar">
      <span className="wordmark">wisdom</span>
      {repository && <span className="chip">{repository}</span>}
      {mode === 'team' && <span className="chip soft">Commits · read from the remote {ago(readAt)}</span>}
      {mode === 'local' && <span className="chip soft">Commits · this machine <span className="live">&nbsp;● live</span></span>}
      {newer && <button className="fresh" onClick={() => window.location.reload()}>New data · reload</button>}
      <span className="spacer" />
      <span className="seg" role="radiogroup" aria-label="Theme">
        {THEMES.map(t => <button key={t} role="radio" aria-checked={theme === t} className={theme === t ? 'on' : ''} onClick={() => pick(t)}>{t[0].toUpperCase() + t.slice(1)}</button>)}
      </span>
    </header>
  );
}

function Nav({ route, index }: { route: Route; index?: Index }) {
  const recent = index?.branches.filter(b => Date.now() - Date.parse(b.lastActiveAt) <= 30 * 86_400_000).length;
  const item = (to: Route, label: string, count: number | undefined, on: boolean) => (
    <button className={on ? 'on' : ''} onClick={() => go(to)}><span className="text">{label}</span>{count !== undefined && <span className="count">{count}</span>}</button>
  );
  const onBranches = route.view === 'branches';
  return (
    <nav className="nav">
      <div className="group">Project</div>
      {item({ view: 'main' }, index?.main ?? 'main', index?.changes.entries.length, route.view === 'main')}
      {item({ view: 'branches' }, 'Active branches', recent, onBranches)}
      <div className="group">Explore</div>
      {item({ view: 'people' }, 'People', index?.people.length, route.view === 'people')}
      {item({ view: 'sessions' }, 'Sessions', index?.sessions.length, route.view === 'sessions')}
    </nav>
  );
}

/** The right panel: a preview of what was picked on a canvas, one click from its page. */
function Panel({ selected }: { selected?: string }) {
  const [kind, key] = selected ? [selected.slice(0, selected.indexOf(':')), selected.slice(selected.indexOf(':') + 1)] : [];
  const change = useData<Change>(kind === 'change' ? `change/${key}.json` : undefined).data;
  const commit = useData<Commit>(kind === 'commit' ? `commit/${key}.json` : undefined).data;
  if (selected === 'earlier') return <div className="helptext"><span className="kicker">Before team mode</span><h3>Earlier commits</h3>
    <p>Commits from before the team file was committed can never have records. git log has them.</p></div>;
  if (change) return (
    <>
      <span className="kicker">{change.pr ? `Pull request #${change.pr} · ${change.state}` : `Change · ${change.state}`}</span>
      <h3>{change.title}</h3>
      <p className={`small t-${TONE[change.status]}`} style={{ marginTop: 6 }}><Dot status={change.status} /> {STATUS[change.status]}</p>
      <div className="facts"><span><b>{change.commits.length}</b> commits</span><span><b>{change.sessions.length}</b> sessions</span><span>by <b>{change.author}</b></span></div>
      {change.needs.length > 0 && <ul className="helptext">{change.needs.map((r, k) => <li key={k}>{reasonWords(r)}{r.commit ? ` (${short(r.commit)})` : ''}</li>)}</ul>}
      <p style={{ marginTop: 12 }}><button className="pos big" onClick={() => go({ view: 'change', id: change.id })}>Open {change.pr ? `#${change.pr}` : 'the change'} ›</button></p>
    </>
  );
  if (commit) return (
    <>
      <span className="kicker">Commit {short(commit.sha)}</span>
      <h3>{commit.subject}</h3>
      <p className={`small t-${TONE[commit.status]}`} style={{ marginTop: 6 }}><Dot status={commit.status} /> {STATUS[commit.status]}</p>
      <div className="facts"><span><b>{commit.files.length}</b> files</span><span><b>{plural(commit.sessions, 'session')}</b></span><span>by <b>{commit.author}</b></span></div>
      {commit.reasons.length > 0 && <ul className="helptext">{commit.reasons.slice(0, 3).map((r, k) => <li key={k}>{reasonWords(r)}</li>)}</ul>}
      <p style={{ marginTop: 12 }}><button className="pos big" onClick={() => go({ view: 'commit', sha: commit.sha })}>Open the commit ›</button></p>
    </>
  );
  return (
    <div className="helptext">
      <span className="kicker">How to read this</span><h3>Shallow to deep</h3>
      <p>main shows what landed. A change opens to its commits, a commit to its pieces and the sessions behind them, a session to its turns.</p>
      <p>Colour is a status only: <span className="t-good">all good</span>, <span className="t-warn">look closer</span>, <span className="t-bad">needs attention</span>, <span className="t-none">no record</span>.
        Every status is what the remote can prove: Wisdom re-checks each step and guide against the sessions here.</p>
      <p>Click a card on a canvas to preview it here.</p>
    </div>
  );
}
