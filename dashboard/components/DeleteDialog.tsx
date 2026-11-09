'use client';

import { useEffect, useRef, useState } from 'react';
import { deleteSessions, previewDelete, type DeleteResult, type RemovalPlan } from '@/lib/api';
import { HarnessIcon, harnessLabel, plural } from './bits';

const linkWords = { continues: 'continues', 'continued-after': 'continued after', cloned: 'cloned from', 'continued-by': 'continued by', 'cloned-by': 'cloned into' } as const;

export function bytes(value: number): string {
  if (value < 1024) return `${value} B`;
  const units = ['KB', 'MB', 'GB'];
  let size = value / 1024, unit = 0;
  while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit++; }
  return `${size < 10 ? size.toFixed(1) : Math.round(size)} ${units[unit]}`;
}

/** Deleting sessions, after reading exactly what goes. The daemon's preview lists the files,
 * the sessions still recording that link to them, and a connected session's own files in the
 * person's harness home, which go only if ticked. Nothing happens until Delete is pressed.
 */
export function DeleteDialog({ sessions, titles, onClose, onDeleted }: { sessions: string[]; titles: Map<string, string>;
  onClose: () => void; onDeleted: (deleted: string[]) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [plans, setPlans] = useState<(RemovalPlan | { session: string; error: string })[]>();
  const [harnessCopy, setHarnessCopy] = useState(false);
  const [working, setWorking] = useState(false);
  const [results, setResults] = useState<DeleteResult[]>();
  const [error, setError] = useState<string>();

  useEffect(() => { dialog.current?.showModal(); }, []);
  useEffect(() => { previewDelete(sessions).then(r => setPlans(r.results), e => setError(e.message)); }, [sessions]);

  const ready = (plans ?? []).filter((p): p is RemovalPlan => !('error' in p) && !p.recording);
  const refused = (plans ?? []).filter(p => 'error' in p || p.recording);
  const copies = ready.filter(p => p.harnessCopy.length > 0 || p.history.some(h => h.harnessCopy));
  // Lines in a harness's own prompt history (what its up arrow recalls) that go with the session.
  const historyLines = (copy: boolean) => ready.flatMap(p => p.history.filter(h => h.harnessCopy === copy));
  const lineCount = (entries: { lines: number }[]) => plural(entries.reduce((sum, h) => sum + h.lines, 0), 'line');
  const linked = ready.flatMap(p => p.linked.map(link => ({ ...link, of: p.session })));
  const total = ready.reduce((sum, p) => sum + p.bytes + (harnessCopy ? p.harnessCopyBytes : 0), 0);
  const name = (id: string) => titles.get(id) ?? id.slice(0, 8);

  const confirm = async () => {
    setWorking(true);
    try {
      const { results } = await deleteSessions(ready.map(p => p.session), harnessCopy);
      setResults(results);
      const deleted = results.filter(r => !r.error).map(r => r.session);
      if (deleted.length && results.every(r => !r.error && !r.kept?.length)) onDeleted(deleted);
    } catch (e) { setError((e as Error).message); }
    finally { setWorking(false); }
  };
  const close = () => {
    const deleted = results?.filter(r => !r.error).map(r => r.session) ?? [];
    if (deleted.length) onDeleted(deleted); else onClose();
  };

  return (
    <dialog ref={dialog} className="delete-dialog" onCancel={e => { e.preventDefault(); if (!working) close(); }}>
      <h3>{sessions.length === 1 ? 'Delete this session?' : `Delete ${plural(sessions.length, 'session')}?`}</h3>
      {error && <p className="bad">{error}</p>}
      {!plans && !error && <p className="muted">Reading what would be deleted…</p>}

      {results ? (
        <>
          {results.map(r => r.error
            ? <p key={r.session} className="bad">{name(r.session)}: {r.error}</p>
            : <p key={r.session}>Deleted <strong>{name(r.session)}</strong>.{(r.kept?.length ?? 0) > 0 && <> These were kept:</>}</p>)}
          <ul className="paths">{results.flatMap(r => r.kept ?? []).map(path => <li key={path}><code>{path}</code></li>)}</ul>
          <div className="actions"><button className="ghost" onClick={close}>Close</button></div>
        </>
      ) : plans && (
        <>
          {ready.length > 0 && (
            <ul className="delete-list">
              {ready.map(p => (
                <li key={p.session}>
                  <HarnessIcon harness={p.harness} size="small" />
                  <span className="title" title={p.session}>{name(p.session)}</span>
                  <span className="muted mono">{bytes(p.bytes)}</span>
                </li>
              ))}
            </ul>
          )}
          <p className="small">{ready.length > 1 ? 'Their records, evidence and transcripts' : 'Its record, evidence and transcript'} in this project
            are deleted for good. Sessions that link to {ready.length > 1 ? 'them' : 'it'} will say “a deleted session”. Their own prompts and
            tool output are not changed, so they may still mention {ready.length > 1 ? 'an ID' : 'its ID'}.</p>
          {historyLines(false).length > 0 && (
            <div className="small">{ready.length > 1 ? 'Their' : 'Its'} prompts also leave the harness’s prompt history ({lineCount(historyLines(false))}); every other line stays:
              <ul className="paths">{historyLines(false).map(h => <li key={h.file}><code>{h.file}</code></li>)}</ul></div>
          )}

          {linked.length > 0 && (
            <div className="delete-warn">
              <strong>Still recording, and linked to {ready.length === 1 ? 'this session' : 'these sessions'}:</strong>
              <ul>{linked.map(l => <li key={`${l.of}-${l.session}`}><HarnessIcon harness={l.harness} size="small" /> {name(l.session)}
                <span className="muted"> · {linkWords[l.kind]} {name(l.of)}</span></li>)}</ul>
              Its agent may still read {ready.length === 1 ? 'this session' : 'them'}; after the delete, those reads fail.
            </div>
          )}

          {copies.length > 0 && (
            <label className="delete-copy">
              <input type="checkbox" checked={harnessCopy} onChange={e => setHarnessCopy(e.target.checked)} />
              <span>Also delete {copies.length === 1 ? `${harnessLabel[copies[0]!.harness] ?? copies[0]!.harness}’s own copy` : 'the harnesses’ own copies'} ({bytes(copies.reduce((s, p) => s + p.harnessCopyBytes, 0))}).
                Without it, the harness can still resume the session, but Wisdom will not record it again.
                <ul className="paths">{copies.flatMap(p => p.harnessCopy).map(path => <li key={path}><code>{path}</code></li>)}
                  {historyLines(true).map(h => <li key={h.file}><code>{h.file}</code> · {plural(h.lines, 'line')} of this session; every other line stays</li>)}</ul></span>
            </label>
          )}

          {ready.some(p => p.outside.length > 0) && (
            <div className="small muted">Kept, as they are outside this project’s files:
              <ul className="paths">{ready.flatMap(p => p.outside).map(path => <li key={path}><code>{path}</code></li>)}</ul></div>
          )}

          {refused.length > 0 && (
            <div className="small">{refused.map(p => <p key={p.session} className="bad">{name(p.session)}: {'error' in p ? p.error : 'still recording; it can be deleted once it ends.'}</p>)}</div>
          )}

          <div className="actions">
            <button className="ghost" onClick={close} disabled={working}>Cancel</button>
            <button className="danger" onClick={confirm} disabled={working || !ready.length}>
              {working ? 'Deleting…' : `Delete${ready.length > 1 ? ` ${ready.length}` : ''} · ${bytes(total)}`}</button>
          </div>
        </>
      )}
    </dialog>
  );
}
