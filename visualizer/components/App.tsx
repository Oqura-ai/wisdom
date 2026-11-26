'use client';

import { useEffect, useRef, useState } from 'react';
import type { Change, Commit, Index, Manifest } from '@contract';
import { useData, useManifest } from '@/lib/data';
import { go, useRoute, type Route } from '@/lib/route';
import { PLACE, SINCE, STATUS, TONE, ago, plural, reasonWords, setPlace, short } from '@/lib/words';
import { Dot, StateNote } from './bits';
import { BranchesView } from './BranchesView';
import { ChangeView } from './ChangeView';
import { CommitView } from './CommitView';
import { PeopleView, PersonPanel, SessionsView } from './ExploreViews';
import { MainView } from './MainView';
import { SessionsPanel, parseOpening } from './SessionsPanel';

const THEMES = ['light', 'dark', 'night'] as const;

export function App() {
  const route = useRoute();
  const { manifest, newer, error } = useManifest();
  const index = useData<Index>(manifest ? 'index.json' : undefined);
  // The words for where the evidence is follow the build: the remote, or this machine.
  if (manifest) setPlace(manifest.mode);
  // What the panel previews: a card picked on a canvas. Going elsewhere clears it, unless the
  // move was made to show something there ("See it on main's canvas").
  const [selected, setSelected] = useState<string>();
  const pending = useRef<string>(undefined);
  useEffect(() => { setSelected(pending.current); pending.current = undefined; }, [route]);
  const pickOnMain = (key: string) => { pending.current = key; go({ view: 'main' }); };

  return (
    <div className="shell">
      <TopBar repository={manifest?.repository} mode={manifest?.mode} readAt={manifest?.snapshot.readAt} newer={newer} />
      <div className="body">
        <Nav route={route} index={index.data} />
        <main className="main">
          {error ? <StateNote title="No Commits data here yet">{error} The Commits build writes it (wisdom commits deploy, or wisdom commits on this machine).</StateNote>
            : index.error ? <StateNote title="This build could not be read">{index.error}</StateNote>
            : !index.data ? <StateNote title="Reading…" />
            : <View route={route} index={index.data} manifest={manifest!} selected={selected} onSelect={setSelected} onMainPick={pickOnMain} />}
        </main>
        <aside className="inspector">{index.data && manifest && <Panel route={route} index={index.data} manifest={manifest} selected={selected} />}</aside>
      </div>
    </div>
  );
}

function View({ route, index, manifest, selected, onSelect, onMainPick }: { route: Route; index: Index; manifest: Manifest; selected?: string;
  onSelect: (key?: string) => void; onMainPick: (key: string) => void }) {
  switch (route.view) {
    case 'main': return <MainView index={index} selected={selected} onSelect={onSelect} />;
    case 'branches': return <BranchesView index={index} mode={manifest.mode} selected={selected} onSelect={onSelect} />;
    case 'commit': return <CommitView key={route.sha} sha={route.sha} via={route.change} index={index} manifest={manifest} onSelect={onSelect} />;
    case 'change': return <ChangeView key={route.id} id={route.id} index={index} manifest={manifest} selected={selected} onSelect={onSelect} onMainPick={onMainPick} />;
    case 'people': return <PeopleView index={index} mode={manifest.mode} selected={selected} onSelect={onSelect} />;
    case 'sessions': return <SessionsView index={index} mode={manifest.mode} selected={selected} onSelect={onSelect} />;
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
  // A change page belongs under Active branches while its branch is active, under main once landed.
  const activeChange = route.view === 'change' ? route.id : route.view === 'commit' ? route.change : undefined;
  const onBranches = route.view === 'branches' || !!activeChange && !!index?.branches.some(b => b.change === activeChange)
    || route.view === 'commit' && !!index?.branches.some(b => b.recent.some(c => c.sha === route.sha));
  const onMain = !onBranches && (route.view === 'main' || route.view === 'change' || route.view === 'commit');
  return (
    <nav className="nav">
      <div className="group">Project</div>
      {item({ view: 'main' }, index?.main ?? 'main', index?.changes.entries.length, onMain)}
      {item({ view: 'branches' }, 'Active branches', recent, onBranches)}
      <div className="group">Explore</div>
      {item({ view: 'people' }, 'People', index?.people.length, route.view === 'people')}
      {item({ view: 'sessions' }, 'Sessions', index?.sessions.length, route.view === 'sessions')}
    </nav>
  );
}

/** The right panel: a preview of what was picked on a canvas, one click from its page. */
function Panel({ route, index, manifest, selected }: { route: Route; index: Index; manifest: Manifest; selected?: string }) {
  const [kind, key] = selected ? [selected.slice(0, selected.indexOf(':')), selected.slice(selected.indexOf(':') + 1)] : [];
  const change = useData<Change>(kind === 'change' ? `change/${key}.json` : undefined).data;
  const commit = useData<Commit>(kind === 'commit' ? `commit/${key}.json` : undefined).data;
  const branch = kind === 'branch' ? index.branches.find(b => b.name === key) : undefined;
  // Sessions open in the panel scoped to the page: behind this commit, in this change, or all.
  const pageCommit = useData<Commit>(route.view === 'commit' ? `commit/${route.sha}.json` : undefined).data;
  const pageChange = useData<Change>(route.view === 'change' ? `change/${route.id}.json` : undefined).data;
  const opening = parseOpening(selected);
  if (opening || route.view === 'commit' && !selected) {
    const [keys, scope, here] = pageCommit ? [pageCommit.sessionsNamed.map(s => s.key), `behind ${short(pageCommit.sha)}`,
      new Set([pageCommit.sha, ...(pageCommit.from && pageCommit.from.how !== 'amend' ? pageCommit.from.commits : [])])]
      : pageChange ? [pageChange.sessions, pageChange.pr ? `in #${pageChange.pr}` : 'in this change', new Set(pageChange.commits.map(c => c.sha))]
      : [index.sessions.map(s => s.key), 'in this project', undefined];
    return <SessionsPanel key={selected ?? ''} keys={keys} scope={scope} opening={opening} here={here} index={index} manifest={manifest} />;
  }
  if (kind === 'person' && key) return <PersonPanel name={key} index={index} manifest={manifest} />;
  if (branch) return (
    <>
      <span className="kicker">Branch · no pull request yet</span>
      <h3><code style={{ fontSize: 14 }}>{branch.name}</code></h3>
      <p className={`small t-${TONE[branch.status]}`} style={{ marginTop: 6 }}><Dot status={branch.status} /> {STATUS[branch.status]} <span className="muted">· {ago(branch.lastActiveAt)}</span></p>
      {branch.reasons.length > 0 && <ul className="helptext">{branch.reasons.slice(0, 3).map((r, k) => <li key={k}>{reasonWords(r)}{r.commit ? ` (${short(r.commit)})` : ''}</li>)}</ul>}
      <span className="kicker" style={{ marginTop: 12 }}>Commits{branch.commits > branch.recent.length ? `, the newest ${branch.recent.length} of ${branch.commits}` : ''}</span>
      {branch.recent.map(c => (
        <div key={c.sha} className="row small" style={{ margin: '4px 0' }}>
          <Dot status={c.status} /><button className="pos" onClick={() => go({ view: 'commit', sha: c.sha })}>{short(c.sha)}</button> {c.subject}
        </div>
      ))}
      <p className="small muted" style={{ marginTop: 12 }}>{plural(branch.sessions, 'session')} behind it, by <b>{branch.author}</b>. It gets a full page, with its canvas, once a pull request is opened.</p>
    </>
  );
  if (selected === 'earlier') return <div className="helptext"><span className="kicker">Before {SINCE[index.since ?? 'team-mode']}</span><h3>Earlier commits</h3>
    <p>{index.since === 'recording' ? 'Commits from before Wisdom first recorded a commit here' : 'Commits from before the team file was committed'} can never have records. git log has them.</p></div>;
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
  if (route.view === 'change') return (
    <div className="helptext">
      <span className="kicker">How to read it</span><h3>Drag the canvas, click anything</h3>
      <p>Commit cards sit on the branch. Below, each session is a row of snippets: one per stretch of turns a commit points to, at most five boxes, with ⋯ when there are more.
        A straight wire runs from a commit to its snippet: that pointer is what a commit&apos;s record stores.</p>
      <p>Click a commit card to preview it here, then open its page. Click a snippet and its session opens here with that stretch marked; a turn opens to the chat view.</p>
      <p>Faded boxes are turns another change&apos;s commit points to; dashed ones, turns no commit points to.</p>
    </div>
  );
  if (route.view === 'people') return <div className="helptext"><span className="kicker">People</span><h3>Click a person</h3><p>Their recent changes and the sessions they recorded open here.</p></div>;
  if (route.view === 'sessions') return <div className="helptext"><span className="kicker">Sessions</span><h3>Click a session</h3><p>It opens here with its turns; a turn opens to the chat view, as the Usage dashboard shows it.</p></div>;
  if (route.view === 'branches') return (
    <div className="helptext">
      <span className="kicker">Active branches</span><h3>Work not on main yet</h3>
      <p>Branches with commits not on main, by when they were last active. One with an open pull request opens to its page; one without shows a preview here.</p>
    </div>
  );
  return (
    <div className="helptext">
      <span className="kicker">How to read this</span><h3>Shallow to deep</h3>
      <p>main shows what landed. A change opens to its commits, a commit to its pieces and the sessions behind them, a session to its turns.</p>
      <p>Colour is a status only: <span className="t-good">all good</span>, <span className="t-warn">look closer</span>, <span className="t-bad">needs attention</span>, <span className="t-none">no record</span>.
        Every status is what {PLACE.name} can prove: Wisdom re-checks each step and guide against the sessions here.</p>
      <p>Click a card on a canvas to preview it here.</p>
    </div>
  );
}
