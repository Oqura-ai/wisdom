'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { firstPrompt, view as read, type Project, type ProjectStats, type Session } from '@/lib/api';
import { Overview } from './Overview';
import { SessionList } from './SessionList';
import { WorkTree } from './WorkTree';
import { DisplayMenu, HarnessBadge, LiveBadge, Wordmark, projectName, shortPath } from './bits';

type Live = { status: 'connecting' | 'live' | 'offline'; readVersion?: number; error?: string };

function useLive(): Live {
  const [live, setLive] = useState<Live>({ status: 'connecting' });
  useEffect(() => {
    const source = new EventSource('/api/live');
    source.addEventListener('state', event => setLive(JSON.parse((event as MessageEvent).data)));
    source.onerror = () => setLive(current => ({ ...current, status: 'offline', error: 'Dashboard server unreachable' }));
    return () => source.close();
  }, []);
  return live;
}

/** Each session's first prompt, read once: it never changes after it is recorded.
 * ponytail: one capture read per session; a title field on the project view would be cheaper.
 */
function useSessionTitles(sessions?: Session[]): Map<string, string> {
  const [titles, setTitles] = useState(new Map<string, string>());
  const tried = useRef(new Set<string>());
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      for (const { captureId, requests } of sessions ?? []) {
        if (cancelled) return;
        if (!requests || tried.current.has(captureId)) continue;
        tried.current.add(captureId);
        const title = await firstPrompt(captureId).catch(() => undefined);
        if (title) setTitles(current => new Map(current).set(captureId, title));
      }
    })();
    return () => { cancelled = true; };
  }, [sessions]);
  return titles;
}

/** URL holds the view state, so a refresh or a shared link reopens the same session. */
function useUrlState() {
  const read = () => {
    const params = new URLSearchParams(typeof window === 'undefined' ? '' : window.location.search);
    return { workspace: params.get('w') ?? undefined, capture: params.get('c') ?? undefined, harness: params.get('h') ?? undefined };
  };
  // Start empty so server and browser render the same markup, then read the URL.
  const [state, setState] = useState<ReturnType<typeof read>>({ workspace: undefined, capture: undefined, harness: undefined });
  useEffect(() => {
    setState(read());
    const onPop = () => setState(read()); window.addEventListener('popstate', onPop); return () => window.removeEventListener('popstate', onPop);
  }, []);
  const update = useCallback((next: Partial<ReturnType<typeof read>>) => {
    setState(current => {
      const merged = { ...current, ...next };
      const params = new URLSearchParams();
      if (merged.workspace) params.set('w', merged.workspace);
      if (merged.capture) params.set('c', merged.capture);
      if (merged.harness) params.set('h', merged.harness);
      window.history.pushState(null, '', params.size ? `?${params}` : window.location.pathname);
      return merged;
    });
  }, []);
  return [state, update] as const;
}

export function Dashboard() {
  const live = useLive();
  const [view, setView] = useUrlState();
  const [projects, setProjects] = useState<Project[]>();
  const [stats, setStats] = useState<ProjectStats>();
  const [error, setError] = useState<string>();
  // The session drawer floats over the page; the main view always keeps the full width.
  const [drawer, setDrawer] = useState(false);
  useEffect(() => {
    if (!drawer) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setDrawer(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [drawer]);

  // Refetch summaries only when the ledger revision moves.
  useEffect(() => {
    if (live.status !== 'live') return;
    read<{ projects: Project[] }>({ view: 'projects' }).then(result => { setProjects(result.projects); setError(undefined); }, e => setError(e.message));
  }, [live.status, live.readVersion]);
  const workspace = view.workspace ?? projects?.[0]?.workspaceRoot;
  useEffect(() => {
    if (live.status !== 'live' || !workspace) return;
    read<ProjectStats>({ view: 'project', workspaceRoot: workspace }).then(setStats, e => setError(e.message));
  }, [live.status, live.readVersion, workspace]);

  // Most recently active first, the same order and time everywhere sessions are listed.
  const sessions = useMemo(() => (stats?.sessions ?? []).filter(s => !view.harness || s.harness === view.harness)
    .sort((a, b) => b.lastObservedAt.localeCompare(a.lastObservedAt)), [stats, view.harness]);
  const selected = stats?.sessions.find(s => s.captureId === view.capture);
  const titles = useSessionTitles(stats?.sessions);

  // A session page keeps the list beside it, for moving between sessions; on a narrow
  // window (see .docked in globals.css) the list floats and closes once a session is picked.
  const shell = useRef<HTMLDivElement>(null);
  const narrow = () => (shell.current?.clientWidth ?? 0) < 1100;
  const inSession = Boolean(view.capture);
  useEffect(() => { setDrawer(inSession && !narrow()); }, [inSession]);
  // A new page starts at its top, not where the last one was scrolled to.
  const main = useRef<HTMLElement>(null);
  useEffect(() => { main.current?.scrollTo(0, 0); }, [view.capture]);

  return (
    <div className="shell" ref={shell}>
      <header className="topbar">
        <button className="drawer-toggle" aria-expanded={drawer} aria-controls="sessions-drawer" onClick={() => setDrawer(!drawer)}>
          <i className={`chevron ${drawer ? 'back' : ''}`} aria-hidden />Sessions</button>
        <button className="plain" title="Project overview" onClick={() => setView({ capture: undefined })}><Wordmark /></button>
        {projects && projects.length > 1
          ? <span className="select-wrap"><select className="project" value={workspace ?? ''} onChange={e => setView({ workspace: e.target.value, capture: undefined })}>
              {projects.map(p => <option key={p.workspaceRoot} value={p.workspaceRoot}>{shortPath(p.workspaceRoot)}</option>)}
            </select></span>
          : workspace && <button className="plain project-name" title={workspace} onClick={() => setView({ capture: undefined })}>{projectName(workspace)}</button>}
        <div className="spacer" />
        <LiveBadge status={live.status} readVersion={live.readVersion} />
        <DisplayMenu />
      </header>

      {live.status === 'offline' && <div className="banner">Daemon offline: {live.error}. Start it with <code>wisdom daemon start</code>; this page reconnects by itself.</div>}
      {error && live.status === 'live' && <div className="banner">{error}</div>}

      <div className={`body ${inSession ? 'docked' : ''} ${drawer ? 'list-open' : ''}`}>
        {drawer && <div className="scrim" onClick={() => setDrawer(false)} aria-hidden />}
        <aside id="sessions-drawer" className={`sidebar ${drawer ? 'open' : ''}`} aria-hidden={!drawer} inert={!drawer}>
          <div className="filters">
            <button className={!view.harness ? 'chip on' : 'chip'} onClick={() => setView({ harness: undefined })}>All</button>
            {stats?.harnesses.map(h => (
              <button key={h.harness} className={view.harness === h.harness ? 'chip on' : 'chip'} onClick={() => setView({ harness: h.harness })}>
                <HarnessBadge harness={h.harness} compact /> {h.captures}
              </button>
            ))}
          </div>
          <SessionList sessions={sessions} titles={titles} selected={view.capture} onSelect={capture => { setView({ capture }); if (narrow()) setDrawer(false); }} />
        </aside>

        <main className="main" ref={main}>
          {selected
            ? <WorkTree key={selected.captureId} session={selected} readVersion={live.readVersion} onBack={() => setView({ capture: undefined })} />
            : stats ? <Overview stats={stats} sessions={sessions} titles={titles} harness={view.harness} onOpen={capture => setView({ capture })} />
            : <div className="empty">{projects && !projects.length
              ? <>No sessions recorded yet. Start one with <code>wisdom track pi|claude|codex --cwd &lt;project&gt;</code>.</>
              : 'Loading…'}</div>}
        </main>
      </div>
    </div>
  );
}
