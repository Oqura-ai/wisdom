'use client';

import { useEffect, useState } from 'react';

export const harnessLabel: Record<string, string> = { pi: 'Pi', 'claude-code': 'Claude Code', codex: 'Codex' };

/** The reference's agent avatar: a pastel face whose tone names the harness or role. */
export function Face({ tone, size, mood }: { tone: string; size?: 'small' | 'large'; mood?: 'happy' }) {
  return <span className={`face t-${tone} ${size ?? ''} ${mood ?? ''}`} aria-hidden><span className="eyes"><i /><i /></span></span>;
}

export function HarnessBadge({ harness, compact, face = true }: { harness: string; compact?: boolean; face?: boolean }) {
  const label = harnessLabel[harness] ?? harness;
  return <span className={`harness h-${harness}`}>{face && <Face tone={harness} size="small" />}{compact ? label.split(' ')[0] : label}</span>;
}

export function Wordmark() {
  return <span className="wordmark" aria-label="wisdom">wisd<Face tone="user" />m</span>;
}

const themes = ['light', 'dark', 'night'] as const;
type Theme = typeof themes[number];

/** Light (the reference), dark (dusk) and night. Remembered per browser; the first
 * visit follows the system preference (see the script in app/layout.tsx).
 */
export function ThemeSwitch() {
  const [theme, setTheme] = useState<Theme>();
  useEffect(() => {
    const read = () => setTheme((document.documentElement.dataset.theme as Theme) ?? 'light');
    read();
    // Reflect changes made elsewhere (another control, devtools) as well as clicks here.
    const observer = new MutationObserver(read);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, []);
  const choose = (next: Theme) => {
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('wisdom-theme', next); } catch { /* private mode: still applies for this page */ }
    setTheme(next);
  };
  return (
    <span className="themes" role="radiogroup" aria-label="Theme">
      {themes.map(option => (
        <button key={option} role="radio" aria-checked={theme === option} className={theme === option ? 'on' : ''} onClick={() => choose(option)}>{option}</button>
      ))}
    </span>
  );
}

export function StatusDot({ status }: { status: string }) {
  return <span className={`dot s-${status}`} title={status} />;
}

export function LiveBadge({ status, readVersion }: { status: string; readVersion?: number }) {
  return <span className={`live l-${status}`}><span className="pulse" />{status === 'live' ? `live · rev ${readVersion}` : status}</span>;
}

export function shortPath(value: string): string {
  const parts = value.split(/[\\/]/).filter(Boolean);
  return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : value;
}

export function since(iso?: string): string {
  if (!iso) return '';
  const seconds = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (seconds < 60) return `${Math.floor(seconds)}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return new Date(iso).toLocaleDateString();
}

/** 1234 → 1.2k, 1234567 → 1.23M. */
export function tokens(value: number): string {
  if (value < 1000) return String(value);
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`;
  return `${(value / 1_000_000).toFixed(2)}M`;
}

/** Only harness-reported cost is shown; absent means not reported, never $0. */
export function cost(value: number | null | undefined): string {
  if (value === null || value === undefined) return 'not reported';
  return value < 0.01 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`;
}

export function duration(from: string, to?: string): string {
  const ms = Date.parse(to ?? new Date().toISOString()) - Date.parse(from);
  if (!Number.isFinite(ms) || ms < 0) return '';
  const minutes = Math.floor(ms / 60000);
  return minutes < 1 ? `${Math.round(ms / 1000)}s` : minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
