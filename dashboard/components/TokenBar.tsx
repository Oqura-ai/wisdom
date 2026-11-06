'use client';

import type { Tokens } from '@/lib/api';
import { cost, tokens } from './bits';

const segments = [
  ['input', 'fresh input', 'Input tokens not served from cache'],
  ['cacheRead', 'cache read', 'Input served from the prompt cache'],
  ['cacheWrite', 'cache write', 'Input written to the prompt cache'],
  ['output', 'output', 'Generated tokens, reasoning included'],
] as const;

/** One stacked bar of the additive token buckets, above its exact legend. */
export function TokenBar({ tokens: t, compact, showCost = true }: { tokens: Tokens; compact?: boolean; showCost?: boolean }) {
  const total = Math.max(1, t.total);
  return (
    <div className={compact ? 'tokenbar' : 'tokenbar card'}>
      <div className="stack" title={`${t.total} tokens`}>
        {segments.map(([key, label]) => t[key] > 0 &&
          <span key={key} className={`seg-${key}`} style={{ width: `${(t[key] / total) * 100}%` }} title={`${label}: ${t[key]}`} />)}
      </div>
      <TokenLegend tokens={t} showCost={showCost} />
    </div>
  );
}

/** Empty buckets are left out; cost is only what the harness reported. */
export function TokenLegend({ tokens: t, showCost = true }: { tokens: Tokens; showCost?: boolean }) {
  const input = t.input + t.cacheRead + t.cacheWrite;
  return (
    <div className="legend">
      {segments.map(([key, label, title]) => t[key] > 0 && (
        <span key={key} title={title}><i className={`seg-${key}`} />{label} <b>{tokens(t[key])}</b></span>
      ))}
      {t.reasoning > 0 && <span title="Part of output">reasoning <b>{tokens(t.reasoning)}</b></span>}
      {t.cacheRead > 0 && <span title="Share of input served from cache">cache hit <b>{Math.round((t.cacheRead / input) * 100)}%</b></span>}
      {showCost && <span title={t.costBehind ? 'The harness last reported this before its latest model responses' : t.costEstimated ? 'Estimated from tokens at OpenAI API prices' : 'Reported by the harness'}>cost <b>{cost(t.costUsd)}{t.costBehind ? ' so far' : ''}</b></span>}
    </div>
  );
}
