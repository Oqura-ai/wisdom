'use client';

import type { Session } from '@/lib/api';
import { HarnessIcon, SessionFacts, StatusDot, since } from './bits';

export function SessionList({ sessions, titles, selected, onSelect }: { sessions: Session[]; titles: Map<string, string>; selected?: string; onSelect: (id: string) => void }) {
  if (!sessions.length) return <div className="empty small">No sessions for this filter.</div>;
  return (
    <ul className="sessions">
      {sessions.map(session => (
        <li key={session.captureId}>
          <button className={session.captureId === selected ? 'session on' : 'session'} onClick={() => onSelect(session.captureId)}>
            <div className="row">
              <HarnessIcon harness={session.harness} size="small" />
              <SessionTitle session={session} titles={titles} />
              <StatusDot status={session.status} />
              <span className="muted small">{since(session.lastObservedAt)}</span>
            </div>
            <SessionFacts session={session} />
          </button>
        </li>
      ))}
    </ul>
  );
}

/** A session reads as its first prompt; the ID stays available on hover. */
export function SessionTitle({ session, titles }: { session: Session; titles: Map<string, string> }) {
  const title = titles.get(session.captureId);
  return <span className={title ? 'session-title' : 'session-title muted'} title={session.captureId}>
    {title ?? (session.requests ? session.captureId.slice(0, 8) : 'No prompts recorded')}</span>;
}
