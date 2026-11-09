'use client';

import { useCallback, useEffect, useState } from 'react';
import { health as readHealth, repairPlan, restoreBackup, runRepair, type Backup, type Check, type Health, type RepairTarget } from '@/lib/api';
import { harnessLabel, plural, since } from './bits';

const placeWords = { home: 'its home in .wisdom (wisdom track)', project: 'this project’s own settings (wisdom connect)' } as const;
const problemWords = { hooks: 'its hooks point to a copy of Wisdom that moved or is another one, so nothing is recorded', skill: 'its reading skill is missing or older' } as const;

/** `wisdom doctor`, at the top of every page: one quiet line when all is well, the problems and
 * how to fix them when not. Repair rewrites only Wisdom's own hooks and skill, after backing up
 * every file it changes; each backup can be restored. Starting and stopping the daemon stay in
 * the terminal: this page is served by the daemon, so it cannot start it, and stopping it would close the page.
 */
export function HealthStrip({ recording }: { recording: number }) {
  const [report, setReport] = useState<Health>();
  const [checking, setChecking] = useState(false);
  const [open, setOpen] = useState(false);
  const [plan, setPlan] = useState<{ targets: RepairTarget[]; backups: Backup[] }>();
  const [confirming, setConfirming] = useState<'repair' | Backup>();
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState<{ text: string; tone?: 'bad' | 'warn' }>();

  const refresh = useCallback(async (fresh = false) => {
    setChecking(true);
    try {
      const [checks, repairs] = await Promise.all([readHealth(fresh), repairPlan().catch(() => undefined)]);
      setReport(checks); setPlan(repairs);
    } catch (error) { setReport({ error: (error as Error).message, checkedAt: new Date().toISOString() }); }
    finally { setChecking(false); }
  }, []);
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 60_000);
    return () => clearInterval(timer);
  }, [refresh]);

  const checks = report?.checks ?? [];
  const problems = checks.filter(c => c.level === 'problem');
  const notes = checks.filter(c => c.level === 'note' && c.fix);
  const repairable = plan?.targets ?? [];
  const tone = report?.error || problems.length ? 'bad' : notes.length || repairable.length ? 'warn' : 'good';
  const headline = !report ? 'Checking…' : report.error ? 'Health check failed'
    : problems.length ? `${plural(problems.length, 'problem')}${notes.length ? ` · ${plural(notes.length, 'note')}` : ''}`
    : notes.length ? plural(notes.length, 'note') : 'Recording works';

  const confirm = async () => {
    setWorking(true); setMessage(undefined);
    try {
      if (confirming === 'repair') {
        const { backup, codexReview } = await runRepair();
        setMessage({ text: `Repaired ${backup.targets.map(t => harnessLabel[t.harness] ?? t.harness).join(', ')}. The files before are backed up as ${backup.id}.`
          + (codexReview ? ' Codex will record again once you review Wisdom’s hooks in /hooks.' : '')
          + (recording ? ' Sessions already running keep their old hooks until they restart.' : ''), tone: codexReview || recording ? 'warn' : undefined });
      } else if (confirming) {
        await restoreBackup(confirming.id);
        setMessage({ text: `Restored the files from ${confirming.id}, as they were before that repair.`, tone: 'warn' });
      }
      setConfirming(undefined);
      await refresh(true);
    } catch (error) { setMessage({ text: (error as Error).message, tone: 'bad' }); }
    finally { setWorking(false); }
  };

  return (
    <div className={`health h-${tone}`}>
      <button className="health-line" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="health-dot" aria-hidden />
        <span className="health-title">Health</span>
        <span>{headline}</span>
        {repairable.length > 0 && <span className="health-tag">repair available</span>}
        <span className="spacer" />
        {report?.checkedAt && <span className="muted small">checked {since(report.checkedAt)}</span>}
        <i className={`chevron ${open ? 'open' : ''}`} aria-hidden />
      </button>

      {open && (
        <div className="health-body">
          {report?.error && <p className="bad">{report.error}</p>}
          <ul className="checks">{checks.map(check => <CheckRow key={check.name} check={check} />)}</ul>

          {repairable.length > 0 && confirming !== 'repair' && (
            <div className="health-actions">
              <span>{plural(repairable.length, 'setup')} can be repaired here.</span>
              <button className="ghost" onClick={() => setConfirming('repair')}>Repair…</button>
            </div>
          )}
          {confirming === 'repair' && (
            <div className="repair-confirm">
              <strong>Repair rewrites Wisdom’s hooks and reading skill, as wisdom init or wisdom connect would:</strong>
              <ul>{repairable.map(t => <li key={`${t.harness}-${t.place}`}>{harnessLabel[t.harness] ?? t.harness}, in {placeWords[t.place]}: {problemWords[t.problem]}.</li>)}</ul>
              <p className="small">First, every file it changes is copied into <code>.wisdom/backups/</code>, so it can be restored below:</p>
              <ul className="paths">{[...new Set(repairable.flatMap(t => t.files))].map(f => <li key={f}><code>{f}</code></li>)}</ul>
              <p className="small">Other settings in those files are kept. What it can disturb:</p>
              <ul className="small">
                {recording > 0 && <li>{plural(recording, 'session')} recording now keep{recording === 1 ? 's' : ''} the hooks {recording === 1 ? 'it' : 'they'} started with until restarted.</li>}
                {repairable.some(t => t.harness === 'codex' && t.problem === 'hooks') && <li>Codex runs changed hooks only after you review them again in <code>/hooks</code>; until then its sessions are read from their files only.</li>}
                <li>Nothing else: sessions, logins and recordings are not touched.</li>
              </ul>
              <div className="actions">
                <button className="ghost" onClick={() => setConfirming(undefined)} disabled={working}>Cancel</button>
                <button className="danger" onClick={confirm} disabled={working}>{working ? 'Repairing…' : 'Back up and repair'}</button>
              </div>
            </div>
          )}

          {(plan?.backups.length ?? 0) > 0 && (
            <details className="backups">
              <summary>Backups from earlier repairs · {plan!.backups.length}</summary>
              <ul>{plan!.backups.map(b => (
                <li key={b.id}>
                  <span>{since(b.createdAt)} · {b.targets.map(t => harnessLabel[t.harness] ?? t.harness).join(', ')}</span>
                  {confirming === b ? <>
                    <span className="warn small">Put back {plural(b.items.length, 'file')} as they were before this repair?</span>
                    <button className="ghost" onClick={() => setConfirming(undefined)} disabled={working}>Cancel</button>
                    <button className="danger" onClick={confirm} disabled={working}>{working ? 'Restoring…' : 'Restore'}</button>
                  </> : <button className="ghost" onClick={() => setConfirming(b)}>Restore…</button>}
                </li>
              ))}</ul>
            </details>
          )}

          {message && <p className={message.tone ?? ''}>{message.text}</p>}
          <div className="health-actions">
            <span className="muted small">Starting and stopping the daemon stay in the terminal: this page is served by it.</span>
            <button className="ghost" onClick={() => void refresh(true)} disabled={checking}>{checking ? 'Checking…' : 'Check again'}</button>
          </div>
        </div>
      )}
    </div>
  );
}

function CheckRow({ check }: { check: Check }) {
  const [copied, setCopied] = useState(false);
  // A fix is a command only when it starts with one; some are steps in a harness.
  const command = check.fix && /^(wisdom|codex|claude|pi)\b/.test(check.fix) && !/[:,]/.test(check.fix) ? check.fix : undefined;
  return (
    <li className={`check c-${check.level}`}>
      <span className="check-level">{check.level}</span>
      <span className="check-name">{check.name}</span>
      <span className="check-detail">{check.detail}
        {check.fix && <span className="check-fix"> fix: <code>{check.fix}</code>
          {command && <button className="plain" onClick={() => void navigator.clipboard.writeText(command).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); })}>{copied ? 'copied' : 'copy'}</button>}</span>}
      </span>
    </li>
  );
}
