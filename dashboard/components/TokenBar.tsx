'use client';

import type { Tokens } from '@/lib/api';
import { cost, tokens } from './bits';

const segments = [
  ['input', 'fresh input', 'Input tokens not served from cache'],
  ['cacheRead', 'cache read', 'Input served from the prompt cache'],
  ['cacheWrite', 'cache write', 'Input written to the prompt cache'],
  ['output', 'output', 'Generated tokens, reasoning included'],
] as const;

/** One stacked bar of the additive token buckets, with an exact legend. */
export function TokenBar({ tokens: t, compact }: { tokens: Tokens; compact?: boolean }) {
  const total = Math.max(1, t.total);
  const cacheShare = t.input + t.cacheRead + t.cacheWrite ? t.cacheRead / (t.input + t.cacheRead + t.cacheWrite) : 0;
  return (
    <div className={compact ? 'tokenbar' : 'tokenbar card'}>
      <div className="stack" title={`${t.total} tokens`}>
        {segments.map(([key, label]) => t[key] > 0 &&
          <span key={key} className={`seg-${key}`} style={{ width: `${(t[key] / total) * 100}%` }} title={`${label}: ${t[key]}`} />)}
      </div>
      <div className="legend">
        {segments.map(([key, label, title]) => (
          <span key={key} title={title}><i className={`seg-${key}`} />{label} <b>{tokens(t[key])}</b></span>
        ))}
        {t.reasoning > 0 && <span title="Part of output">reasoning <b>{tokens(t.reasoning)}</b></span>}
        <span title="Share of input served from cache">cache hit <b>{Math.round(cacheShare * 100)}%</b></span>
        <span title="Only cost reported by the harness itself">cost <b>{cost(t.costUsd)}</b></span>
      </div>
    </div>
  );
}
