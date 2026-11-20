'use client';

import { useState } from 'react';
import { renameSession, type Session } from '@/lib/api';
import { HarnessBadge, SessionFacts, StatusDot, since } from './bits';

export function SessionList({ sessions, titles, selected, onSelect }: { sessions: Session[]; titles: Map<string, string>; selected?: string; onSelect: (id: string) => void }) {
  if (!sessions.length) return <div className="empty small">No sessions for this filter.</div>;
  return (
    <ul className="sessions">
      {sessions.map(session => (
        <li key={session.captureId}>
          <button className={session.captureId === selected ? 'session on' : 'session'} onClick={() => onSelect(session.captureId)}>
            <div className="row">
              <HarnessBadge harness={session.harness} compact />
              <StatusDot status={session.status} />
              <span className="spacer" />
              <span className="muted small">{since(session.lastObservedAt)}</span>
            </div>
            <SessionTitle session={session} titles={titles} />
            <SessionFacts session={session} />
          </button>
        </li>
      ))}
    </ul>
  );
}

/** A session reads as its name, or else its first prompt; the ID stays available on hover. */
export function SessionTitle({ session, titles }: { session: Session; titles: Map<string, string> }) {
  const title = titles.get(session.captureId);
  return <div className={title ? 'session-title' : 'session-title muted'} title={session.captureId}>
    {title ?? (session.requests ? session.captureId.slice(0, 8) : 'No prompts recorded')}</div>;
}

/** The session page's title, which a person can rename. An empty name goes back to the
 * harness's name or the first prompt. A shared copy keeps the name it came with.
 */
export function SessionName({ session, titles, onRenamed }: { session: Session; titles: Map<string, string>; onRenamed: () => void }) {
  const [editing, setEditing] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const title = titles.get(session.captureId);
  const save = async (name: string) => {
    setSaving(true); setError(undefined);
    try { await renameSession(session.captureId, name); setEditing(undefined); onRenamed(); }
    catch (e) { setError((e as Error).message); }
    finally { setSaving(false); }
  };
  if (editing !== undefined) return (
    <form className="session-name" onSubmit={e => { e.preventDefault(); void save(editing); }}>
      <input autoFocus value={editing} maxLength={100} disabled={saving} aria-label="Session name"
        placeholder={`Empty: ${session.harnessName ?? 'the first prompt'}`}
        onChange={e => setEditing(e.target.value)} onKeyDown={e => { if (e.key === 'Escape') setEditing(undefined); }} />
      <button className="ghost" type="submit" disabled={saving}>Save</button>
      <button className="ghost" type="button" disabled={saving} onClick={() => { setEditing(undefined); setError(undefined); }}>Cancel</button>
      {error && <span className="bad small">{error}</span>}
    </form>
  );
  return (
    <div className="session-name">
      <h1 className={title ? undefined : 'muted'} title={session.captureId}>{title ?? session.captureId.slice(0, 8)}</h1>
      {!session.shared && <button className="ghost" onClick={() => setEditing(session.name ?? '')}
        title="Name this session here. Its recording does not change.">Rename</button>}
    </div>
  );
}
