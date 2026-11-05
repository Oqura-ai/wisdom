'use client';

import type { ProjectStats, Session } from '@/lib/api';
import { HarnessIcon, HarnessBadge, StatusDot, cost, harnessLabel, plural, projectName, sessionLength, since, tokens } from './bits';
import { SessionTitle } from './SessionList';
import { TokenBar } from './TokenBar';

/** Project view. Every row fills its width: totals, one card per harness (sharing the
 * row evenly), models, then tool usage beside hot files, then captures. Sections with
 * no data are left out rather than shown as empty boxes.
 */
export function Overview({ stats, sessions, titles, harness, onOpen }: { stats: ProjectStats; sessions: Session[]; titles: Map<string, string>; harness?: string; onOpen: (id: string) => void }) {
  const harnesses = stats.harnesses.filter(h => !harness || h.harness === harness);
  const tools = stats.toolUsage.filter(t => !harness || t.harness === harness).slice(0, 10);
  const maxCalls = Math.max(1, ...tools.map(t => t.calls));
  const anySubagents = sessions.some(s => s.subagents > 0);
  const files = stats.files.slice(0, 10);
  const maxFile = Math.max(1, ...files.map(f => f.changes));
  const models = stats.models.filter(m => !harness || m.harness === harness);
  const sum = (field: 'requests' | 'tools' | 'failures' | 'changes') => harnesses.reduce((n, h) => n + h[field], 0);
  const totalTokens = harnesses.reduce((n, h) => n + h.tokens.total, 0);
  const costs = harnesses.map(h => h.tokens.costUsd).filter((c): c is number => c !== null);
  const kpis: [string, string, string?][] = [
    ['sessions', String(sessions.length)], ['requests', String(sum('requests'))],
    ['tool calls', String(sum('tools'))], ['failures', String(sum('failures')), sum('failures') ? 'bad' : undefined],
    ['file changes', String(sum('changes'))], ['tokens', tokens(totalTokens)],
    ['reported cost', costs.length ? cost(costs.reduce((a, b) => a + b, 0)) : '—'],
  ];

  return (
    <div className="overview">
      <header className="project-head">
        <div>
          <h1>{projectName(stats.workspaceRoot)}</h1>
          <div className="subtitle">{stats.workspaceRoot}</div>
        </div>
      </header>

      <section className="kpis card">
        {kpis.map(([label, value, tone]) => <div key={label} className={`kpi ${tone ?? ''}`}><b>{value}</b><span>{label}</span></div>)}
      </section>

      <section className={`cards n-${Math.min(harnesses.length, 4)}`}>
        {harnesses.map(h => (
          <article key={h.harness} className={`card harness-card hc-${h.harness}`}>
            <header>
              <span className="who"><HarnessIcon harness={h.harness} size="large" live={h.recording > 0} />
                <span>{harnessLabel[h.harness] ?? h.harness}<span className="unit block">{plural(h.captures, 'session')}</span></span></span>
              {h.recording > 0 && <span className="rec">● recording {h.recording}</span>}
            </header>
            <dl>
              <div><dt>requests</dt><dd>{h.requests}</dd></div>
              <div><dt>tool calls</dt><dd>{h.tools}</dd></div>
              <div><dt>failures</dt><dd className={h.failures ? 'bad' : ''}>{h.failures}</dd></div>
              <div><dt>changes</dt><dd>{h.changes}</dd></div>
              {h.subagents > 0 && <div><dt>subagents</dt><dd>{h.subagents}</dd></div>}
              <div><dt>tokens</dt><dd>{tokens(h.tokens.total)}</dd></div>
              <div><dt>cost</dt><dd className={h.tokens.costUsd === null ? 'muted' : ''} title={h.tokens.costUsd === null ? 'Not reported by this harness' : 'Reported by the harness'}>
                {h.tokens.costUsd === null ? '—' : cost(h.tokens.costUsd)}</dd></div>
            </dl>
            {h.tokens.calls > 0
              ? <TokenBar tokens={h.tokens} compact showCost={false} />
              : <p className="footnote">No token usage recorded{h.gaps ? `; ${h.gaps} coverage gap${h.gaps > 1 ? 's' : ''}` : ''}.</p>}
          </article>
        ))}
      </section>

      {models.length > 0 && (
        <section className="card">
          <h2>Models</h2>
          <table className="table models">
            <thead><tr><th>harness</th><th>model</th><th>responses</th><th>fresh input</th><th>cache read</th><th>cache write</th><th>output</th><th>reasoning</th><th>total</th><th>cost</th></tr></thead>
            <tbody>{models.map(m => (
              <tr key={`${m.harness}:${m.model}`} className="static">
                <td><HarnessBadge harness={m.harness} compact /></td><td className="mono">{m.model}</td><td>{m.calls}</td>
                <td>{tokens(m.input)}</td><td>{tokens(m.cacheRead)}</td><td>{tokens(m.cacheWrite)}</td><td>{tokens(m.output)}</td>
                <td>{m.reasoning ? tokens(m.reasoning) : ''}</td><td><b>{tokens(m.total)}</b></td>
                <td className={m.costUsd === null ? 'muted small' : ''} title={m.costUsd === null && m.harness === 'claude-code' ? 'Claude Code reports cost per session, not per model; see the harness card and sessions.' : undefined}>
                  {m.costUsd === null && m.harness === 'claude-code' ? 'per session' : cost(m.costUsd)}</td>
              </tr>))}</tbody>
          </table>
          <p className="footnote">Fresh input excludes cache; reasoning is part of output. Each model response is counted once, subagents included, resumed history excluded. Cost is only what the harness reports: Pi per message, Claude Code as a session total; Codex reports none.</p>
        </section>
      )}

      {(tools.length > 0 || files.length > 0) && (
        <div className={`bento ${tools.length && files.length ? 'pair' : 'single'}`}>
          {tools.length > 0 && (
            <section className="card">
              <h2>Tool usage</h2>
              <ul className="bars">
                {tools.map(t => (
                  <li key={`${t.harness}:${t.toolName}`}>
                    <span className="label mono" title={`${t.toolName} (${harnessLabel[t.harness] ?? t.harness})`}><HarnessIcon harness={t.harness} size="small" />{t.toolName}</span>
                    <span className="bar"><span className={`fill hf-${t.harness}`} style={{ width: `${(t.calls / maxCalls) * 100}%` }} />
                      {t.failures > 0 && <span className="fill err" style={{ width: `${(t.failures / maxCalls) * 100}%` }} />}</span>
                    <span className="num">{t.calls}{t.failures > 0 && <em className="bad"> · {t.failures} failed</em>}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {files.length > 0 && (
            <section className="card">
              <h2>Most changed files</h2>
              <ul className="bars">
                {files.map(f => (
                  <li key={`${f.worktree ?? ''}:${f.path}`}>
                    <span className="label mono" title={f.worktree ? `${f.path} in worktree ${f.worktree}` : f.path}>{f.path}{f.worktree ? ` · ${f.worktree}` : ''}</span>
                    <span className="bar"><span className="fill neutral" style={{ width: `${(f.changes / maxFile) * 100}%` }} /></span>
                    <span className="num" title={plural(f.captures, 'session')}>{f.changes}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      )}

      <section className="card">
        <h2>Sessions</h2>
        <table className="table">
          <thead><tr><th>session</th><th>last active</th><th title="Start to end. Left blank when recording had gaps, since it would count idle time.">length</th><th>requests</th><th>tools</th><th>failed</th><th>changes</th>{anySubagents && <th>subagents</th>}<th>tokens</th><th>cost</th></tr></thead>
          <tbody>
            {sessions.map(s => (
              <tr key={s.captureId} onClick={() => onOpen(s.captureId)}>
                <td className="session-cell"><button className="row-link"><HarnessIcon harness={s.harness} size="small" /><SessionTitle session={s} titles={titles} /><StatusDot status={s.status} />{s.evidenceMissing && <span className="bad small">evidence missing</span>}</button></td>
                <td>{since(s.lastObservedAt)}</td>
                <td>{sessionLength(s)}</td>
                <td>{s.requests}</td><td>{s.tools}</td><td className={s.failures ? 'bad' : ''}>{s.failures}</td>
                <td>{s.changes}</td>{anySubagents && <td>{s.subagents || ''}</td>}
                <td>{s.tokens.total ? tokens(s.tokens.total) : ''}</td><td className="small" title={s.tokens.costBehind ? 'The harness last reported this before its latest model responses' : undefined}>{s.tokens.costUsd === null ? '' : `${cost(s.tokens.costUsd)}${s.tokens.costBehind ? ' so far' : ''}`}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="footnote">Counts are recorded evidence. Failures are tool results marked as errors; unknown outcomes are not counted.</p>
      </section>
    </div>
  );
}
