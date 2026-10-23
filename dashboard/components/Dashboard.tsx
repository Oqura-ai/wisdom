'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ledger, type Project, type ProjectStats } from '@/lib/api';
import { Overview } from './Overview';
import { SessionList } from './SessionList';
import { WorkTree } from './WorkTree';
import { HarnessBadge, LiveBadge, ThemeSwitch, Wordmark, shortPath } from './bits';

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

  // Refetch summaries only when the ledger revision moves.
  useEffect(() => {
    if (live.status !== 'live') return;
    ledger<{ projects: Project[] }>({ op: 'stats' }).then(result => { setProjects(result.projects); setError(undefined); }, e => setError(e.message));
  }, [live.status, live.readVersion]);
  const workspace = view.workspace ?? projects?.[0]?.workspaceRoot;
  useEffect(() => {
    if (live.status !== 'live' || !workspace) return;
    ledger<ProjectStats>({ op: 'stats', workspaceRoot: workspace }).then(setStats, e => setError(e.message));
  }, [live.status, live.readVersion, workspace]);

  const sessions = useMemo(() => (stats?.sessions ?? []).filter(s => !view.harness || s.harness === view.harness), [stats, view.harness]);
  const selected = stats?.sessions.find(s => s.captureId === view.capture);

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand"><Wordmark /><span className="tagline">ledger</span></div>
        <select className="project" value={workspace ?? ''} onChange={e => setView({ workspace: e.target.value, capture: undefined })}>
          {!projects?.length && <option value="">No tracked projects yet</option>}
          {projects?.map(p => <option key={p.workspaceRoot} value={p.workspaceRoot}>{shortPath(p.workspaceRoot)} · {p.captures} captures</option>)}
        </select>
        <div className="spacer" />
        <ThemeSwitch />
        <LiveBadge status={live.status} readVersion={live.readVersion} />
      </header>

      {live.status === 'offline' && <div className="banner">Daemon offline: {live.error}. Start it with <code>wisdom daemon start</code>; this page reconnects by itself.</div>}
      {error && live.status === 'live' && <div className="banner">{error}</div>}

      <div className="body">
        <aside className="sidebar">
          <div className="filters">
            <button className={!view.harness ? 'chip on' : 'chip'} onClick={() => setView({ harness: undefined })}>All</button>
            {stats?.harnesses.map(h => (
              <button key={h.harness} className={view.harness === h.harness ? 'chip on' : 'chip'} onClick={() => setView({ harness: h.harness })}>
                <HarnessBadge harness={h.harness} compact /> {h.captures}
              </button>
            ))}
          </div>
          <SessionList sessions={sessions} selected={view.capture} onSelect={capture => setView({ capture })} />
        </aside>

        <main className="main">
          {selected
            ? <WorkTree key={selected.captureId} session={selected} readVersion={live.readVersion} onBack={() => setView({ capture: undefined })} />
            : stats ? <Overview stats={stats} harness={view.harness} onOpen={capture => setView({ capture })} />
            : <div className="empty">{projects && !projects.length
              ? <>No sessions recorded yet. Start one with <code>wisdom track pi|claude|codex --cwd &lt;project&gt;</code>.</>
              : 'Loading…'}</div>}
        </main>
      </div>
    </div>
  );
}
