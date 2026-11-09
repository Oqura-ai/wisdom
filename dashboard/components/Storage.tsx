'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { storage as readStorage, type Session, type Storage } from '@/lib/api';
import { DeleteDialog, bytes } from './DeleteDialog';
import { HarnessIcon, harnessLabel, plural, since } from './bits';
import { SessionTitle } from './SessionList';

/** Where this project's disk space goes, and the way to free it: a clean-up that lists old
 * sessions to choose from. Nothing is deleted on a schedule; every delete is chosen and confirmed.
 */
export function StorageCard({ sessions, titles, onOpen, onDeleted }: { sessions: Session[]; titles: Map<string, string>;
  onOpen: (id: string) => void; onDeleted: () => void }) {
  const [data, setData] = useState<Storage>();
  const [error, setError] = useState<string>();
  const [cleaning, setCleaning] = useState(false);
  // Sizes are read once per page and after each delete; walking every folder on each ledger change would be wasteful.
  const count = sessions.length;
  useEffect(() => { readStorage().then(setData, e => setError(e.message)); }, [count]);
  const sizes = useMemo(() => new Map(data?.sessions.map(s => [s.session, s.bytes])), [data]);

  if (error) return <section className="card"><h2>Storage</h2><p className="bad">{error}</p></section>;
  if (!data) return null;
  const sessionBytes = data.sessions.reduce((sum, s) => sum + s.bytes, 0);
  const parts: [string, number, string][] = [
    ['sessions', sessionBytes, 'Each session’s evidence: copied transcripts, tool inputs and outputs, patches'],
    ['database', data.database, 'The index of every record (ledger.sqlite)'],
    ...data.homes.map(h => [`${harnessLabel[h.harness] ?? h.harness} home`, h.bytes,
      'The harness’s own folder in .wisdom: its settings, login and its own session files'] as [string, number, string]),
    ['other', data.other, 'Logs, backups, shared files and the spool'],
  ];
  const largest = data.sessions.slice(0, 5);

  return (
    <section className="card storage">
      <header className="storage-head">
        <h2>Storage</h2>
        <span className="storage-total">{bytes(data.total)}</span>
        <span className="spacer" />
        <button className="ghost" onClick={() => setCleaning(true)}>Clean up…</button>
      </header>
      <div className="storage-bar" role="img" aria-label={parts.map(([label, value]) => `${label} ${bytes(value)}`).join(', ')}>
        {parts.filter(([, value]) => value > 0).map(([label, value], index) => (
          <span key={label} className={`seg s${index % 5}`} style={{ width: `${Math.max(0.5, (value / Math.max(1, data.total)) * 100)}%` }} title={`${label}: ${bytes(value)}`} />
        ))}
      </div>
      <ul className="storage-legend">
        {parts.map(([label, value, about], index) => <li key={label} title={about}><span className={`swatch s${index % 5}`} />{label} <b>{bytes(value)}</b></li>)}
      </ul>
      {largest.length > 0 && <>
        <div className="list-heading">Largest sessions</div>
        <ul className="storage-sessions">
          {largest.map(s => {
            const session = sessions.find(x => x.captureId === s.session);
            return (
              <li key={s.session}>
                <button className="row-link" onClick={() => onOpen(s.session)}>
                  <HarnessIcon harness={s.harness} size="small" />
                  {session ? <SessionTitle session={session} titles={titles} /> : <code>{s.session.slice(0, 8)}</code>}
                </button>
                <span className="muted small">{session ? since(session.lastObservedAt) : ''}</span>
                <b className="mono">{bytes(s.bytes)}</b>
              </li>
            );
          })}
        </ul>
      </>}
      {cleaning && <CleanupDialog sessions={sessions} sizes={sizes} titles={titles} onClose={() => setCleaning(false)}
        onDeleted={() => { setCleaning(false); onDeleted(); }} />}
    </section>
  );
}

const DAY = 86_400_000;

/** Pick sessions not active for N days (30 unless changed), one by one or all at once. The
 * delete dialog then shows exactly what goes, the linked sessions still recording, and asks.
 */
function CleanupDialog({ sessions, sizes, titles, onClose, onDeleted }: { sessions: Session[]; sizes: Map<string, number>; titles: Map<string, string>;
  onClose: () => void; onDeleted: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [days, setDays] = useState(30);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [review, setReview] = useState<string[]>();
  useEffect(() => { if (!review) dialog.current?.showModal(); }, [review]);

  const old = useMemo(() => sessions.filter(s => s.status !== 'recording' && Date.now() - Date.parse(s.lastObservedAt) >= days * DAY)
    .sort((a, b) => a.lastObservedAt.localeCompare(b.lastObservedAt)), [sessions, days]);
  // Changing the days keeps only choices still in the list.
  useEffect(() => { setPicked(current => new Set([...current].filter(id => old.some(s => s.captureId === id)))); }, [old]);
  const total = (ids: Iterable<string>) => [...ids].reduce((sum, id) => sum + (sizes.get(id) ?? 0), 0);
  const toggle = (id: string) => setPicked(current => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const all = old.length > 0 && picked.size === old.length;

  if (review) return <DeleteDialog sessions={review} titles={titles} onClose={() => setReview(undefined)} onDeleted={onDeleted} />;
  return (
    <dialog ref={dialog} className="delete-dialog" onCancel={e => { e.preventDefault(); onClose(); }}>
      <h3>Clean up old sessions</h3>
      <label className="days">Sessions not active for
        <input type="number" min={0} max={3650} value={days} onChange={e => setDays(Math.max(0, Math.min(3650, Number(e.target.value) || 0)))} />
        days or more</label>
      {old.length === 0 ? <p className="muted">No finished session is that old.</p> : <>
        <label className="pick-all"><input type="checkbox" checked={all} onChange={() => setPicked(all ? new Set() : new Set(old.map(s => s.captureId)))} />
          Select all · {plural(old.length, 'session')} · {bytes(total(old.map(s => s.captureId)))}</label>
        <ul className="delete-list">
          {old.map(s => (
            <li key={s.captureId}>
              <input type="checkbox" checked={picked.has(s.captureId)} onChange={() => toggle(s.captureId)} aria-label={`Select ${titles.get(s.captureId) ?? s.captureId}`} />
              <HarnessIcon harness={s.harness} size="small" />
              <span className="title" title={s.captureId}><SessionTitle session={s} titles={titles} /></span>
              <span className="muted small">{since(s.lastObservedAt)}</span>
              <span className="muted mono">{bytes(sizes.get(s.captureId) ?? 0)}</span>
            </li>
          ))}
        </ul>
      </>}
      <p className="small muted">Sessions still recording are not listed. Nothing is deleted until you confirm on the next step.</p>
      <div className="actions">
        <button className="ghost" onClick={onClose}>Cancel</button>
        <button className="ghost" disabled={!picked.size} onClick={() => setReview([...picked])}>
          Review {picked.size ? `${picked.size} selected · ${bytes(total(picked))}` : 'selected'}</button>
        <button className="danger" disabled={!old.length} onClick={() => setReview(old.map(s => s.captureId))}>Delete all {old.length || ''}…</button>
      </div>
    </dialog>
  );
}
