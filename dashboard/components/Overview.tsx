'use client';

import type { ProjectStats } from '@/lib/api';
import { Face, HarnessBadge, StatusDot, cost, duration, harnessLabel, shortPath, since, tokens } from './bits';
import { TokenBar } from './TokenBar';

/** Project view: per-harness modules, tool usage, hot files and recent captures. */
export function Overview({ stats, harness, onOpen }: { stats: ProjectStats; harness?: string; onOpen: (id: string) => void }) {
  const harnesses = stats.harnesses.filter(h => !harness || h.harness === harness);
  const tools = stats.toolUsage.filter(t => !harness || t.harness === harness).slice(0, 12);
  const maxCalls = Math.max(1, ...tools.map(t => t.calls));
  const sessions = stats.sessions.filter(s => !harness || s.harness === harness);
  const maxFile = Math.max(1, ...stats.files.map(f => f.changes));
  const models = stats.models.filter(m => !harness || m.harness === harness);

  return (
    <div className="overview">
      <div>
        <h1>{shortPath(stats.workspaceRoot).replace(/^…\//, '')}</h1>
        <div className="subtitle">{stats.workspaceRoot}</div>
      </div>

      <section className="cards">
        {harnesses.map(h => (
          <article key={h.harness} className={`card harness-card hc-${h.harness}`}>
            <header><span className="who"><Face tone={h.harness} size="large" mood={h.recording ? 'happy' : undefined} />{harnessLabel[h.harness] ?? h.harness}</span>
              {h.recording > 0 && <span className="rec">● recording {h.recording}</span>}</header>
            <div className="big">{h.captures}<span className="unit">captures</span></div>
            <dl>
              <div><dt>requests</dt><dd>{h.requests}</dd></div>
              <div><dt>tool calls</dt><dd>{h.tools}</dd></div>
              <div><dt>failures</dt><dd className={h.failures ? 'bad' : ''}>{h.failures}</dd></div>
              <div><dt>changes</dt><dd>{h.changes}</dd></div>
              <div><dt>subagents</dt><dd>{h.subagents}</dd></div>
              <div><dt>gaps</dt><dd className={h.gaps ? 'warn' : ''}>{h.gaps}</dd></div>
              <div><dt>replies</dt><dd>{h.replies}</dd></div>
              <div><dt>tokens</dt><dd>{tokens(h.tokens.total)}</dd></div>
              <div><dt>cost</dt><dd className={h.tokens.costUsd === null ? 'muted' : ''} title={h.tokens.costUsd === null ? 'Not reported by this harness' : 'Reported by the harness'}>
                {h.tokens.costUsd === null ? '—' : cost(h.tokens.costUsd)}</dd></div>
            </dl>
            <div className="ratio" title="failed tool results / tool calls">
              <span style={{ width: `${h.tools ? Math.min(100, (h.failures / h.tools) * 100) : 0}%` }} />
            </div>
          </article>
        ))}
      </section>

      <section className="card">
        <h2>Token usage</h2>
        {!harnesses.some(h => h.tokens.calls) && <div className="empty small">No token usage recorded. It comes from each harness's native transcript.</div>}
        <div className="token-rows">
          {harnesses.filter(h => h.tokens.calls).map(h => (
            <div key={h.harness} className="token-row"><HarnessBadge harness={h.harness} compact />
              <span className="mono small muted">{tokens(h.tokens.total)} · {h.tokens.calls} responses</span>
              <TokenBar tokens={h.tokens} compact /></div>
          ))}
        </div>
        {models.length > 0 && (
          <table className="table models">
            <thead><tr><th>harness</th><th>model</th><th>responses</th><th>fresh input</th><th>cache read</th><th>cache write</th><th>output</th><th>reasoning</th><th>total</th><th>cost</th></tr></thead>
            <tbody>{models.map(m => (
              <tr key={`${m.harness}:${m.model}`} className="static">
                <td><HarnessBadge harness={m.harness} compact /></td><td className="mono">{m.model}</td><td>{m.calls}</td>
                <td>{tokens(m.input)}</td><td>{tokens(m.cacheRead)}</td><td>{tokens(m.cacheWrite)}</td><td>{tokens(m.output)}</td>
                <td>{m.reasoning ? tokens(m.reasoning) : ''}</td><td><b>{tokens(m.total)}</b></td>
                <td className={m.costUsd === null ? 'muted small' : ''} title={m.costUsd === null && m.harness === 'claude-code' ? 'Claude Code reports cost per session, not per model; see the harness card and captures.' : undefined}>
                  {m.costUsd === null && m.harness === 'claude-code' ? 'per session' : cost(m.costUsd)}</td>
              </tr>))}</tbody>
          </table>
        )}
        <p className="footnote">Fresh input excludes cache; reasoning is part of output. Each model response is counted once, subagents included, resumed history excluded. Cost is only what the harness reports: Pi per message, Claude Code as a session total; Codex reports none.</p>
      </section>

      <div className="grid2">
        <section className="card">
          <h2>Tool usage</h2>
          {!tools.length && <div className="empty small">No tool calls yet.</div>}
          <ul className="bars">
            {tools.map(t => (
              <li key={`${t.harness}:${t.toolName}`}>
                <span className="label mono" title={`${t.toolName} (${t.harness})`}><i className={`hdot hd-${t.harness}`} />{t.toolName}</span>
                <span className="bar"><span className={`fill hf-${t.harness}`} style={{ width: `${(t.calls / maxCalls) * 100}%` }} />
                  {t.failures > 0 && <span className="fill err" style={{ width: `${(t.failures / maxCalls) * 100}%` }} />}</span>
                <span className="num">{t.calls}{t.failures > 0 && <em className="bad"> · {t.failures}✕</em>}</span>
              </li>
            ))}
          </ul>
        </section>
        <section className="card">
          <h2>Most changed files</h2>
          {!stats.files.length && <div className="empty small">No file changes yet.</div>}
          <ul className="bars">
            {stats.files.slice(0, 12).map(f => (
              <li key={f.path}>
                <span className="label mono" title={f.path}>{f.path}</span>
                <span className="bar"><span className="fill neutral" style={{ width: `${(f.changes / maxFile) * 100}%` }} /></span>
                <span className="num">{f.changes}<em className="muted"> · {f.captures} cap</em></span>
              </li>
            ))}
          </ul>
        </section>
      </div>

      <section className="card">
        <h2>Captures</h2>
        <table className="table">
          <thead><tr><th /><th>harness</th><th>capture</th><th>started</th><th>length</th><th>req</th><th>tools</th><th>fail</th><th>Δ</th><th>sub</th><th>tokens</th><th>cost</th><th>end</th></tr></thead>
          <tbody>
            {sessions.map(s => (
              <tr key={s.captureId} onClick={() => onOpen(s.captureId)}>
                <td><StatusDot status={s.status} /></td>
                <td><HarnessBadge harness={s.harness} compact /></td>
                <td className="mono">{s.captureId.slice(0, 8)}</td>
                <td>{since(s.startedAt)}</td>
                <td>{duration(s.startedAt, s.endedAt ?? (s.status === 'recording' ? undefined : s.lastObservedAt))}</td>
                <td>{s.requests}</td><td>{s.tools}</td><td className={s.failures ? 'bad' : ''}>{s.failures}</td>
                <td>{s.changes}</td><td>{s.subagents || ''}</td>
                <td>{s.tokens.total ? tokens(s.tokens.total) : ''}</td><td className="small">{s.tokens.costUsd === null ? '' : cost(s.tokens.costUsd)}</td>
                <td className="muted small">{s.evidenceMissing ? <span className="bad">evidence missing</span> : s.status === 'recording' ? 'recording' : s.endReason ?? s.status}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <p className="footnote">Counts are recorded evidence. Failures are tool results marked as errors; unknown outcomes are not counted.</p>
    </div>
  );
}
