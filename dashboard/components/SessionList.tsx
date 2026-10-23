'use client';

import type { Session } from '@/lib/api';
import { HarnessBadge, StatusDot, since, tokens } from './bits';

export function SessionList({ sessions, selected, onSelect }: { sessions: Session[]; selected?: string; onSelect: (id: string) => void }) {
  if (!sessions.length) return <div className="empty small">No captures for this filter.</div>;
  return (
    <ul className="sessions">
      {sessions.map(session => (
        <li key={session.captureId}>
          <button className={session.captureId === selected ? 'session on' : 'session'} onClick={() => onSelect(session.captureId)}>
            <div className="row">
              <HarnessBadge harness={session.harness} compact />
              <StatusDot status={session.status} />
              <span className="mono muted">{session.captureId.slice(0, 8)}</span>
              <span className="spacer" />
              <span className="muted small">{since(session.lastObservedAt)}</span>
            </div>
            <div className="row metrics">
              <span>{session.requests} req</span><span>{session.tools} tools</span>
              <span className={session.failures ? 'bad' : ''}>{session.failures} fail</span>
              <span>{session.changes} Δ</span>
              {session.subagents > 0 && <span className="accent">{session.subagents} sub</span>}
              {session.gaps > 0 && <span className="warn">{session.gaps} gap</span>}
              {session.tokens.total > 0 && <span title="tokens">{tokens(session.tokens.total)} tok</span>}
              {session.evidenceMissing && <span className="bad" title="Evidence folder missing on disk">no evidence</span>}
            </div>
          </button>
        </li>
      ))}
    </ul>
  );
}
