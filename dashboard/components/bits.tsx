'use client';

import { useEffect, useState } from 'react';

export const harnessLabel: Record<string, string> = { pi: 'Pi', 'claude-code': 'Claude Code', codex: 'Codex' };

/** The reference's agent avatar: a pastel face whose tone names the harness or role. */
export function Face({ tone, size, mood }: { tone: string; size?: 'small' | 'large'; mood?: 'happy' }) {
  return <span className={`face t-${tone} ${size ?? ''} ${mood ?? ''}`} aria-hidden><span className="eyes"><i /><i /></span></span>;
}

/** A harness's own mark (dashboard/assets/icons) on a small rounded tile. Pi's mark
 * is black in the light theme and white in dark and night: it follows the theme
 * chosen in the dashboard, not the operating system's setting.
 */
export function HarnessIcon({ harness, size, live }: { harness: string; size?: 'small' | 'large'; live?: boolean }) {
  const mark = harness === 'claude-code'
    ? <svg viewBox="0 0 24 24" aria-hidden><path fill="#D97757" fillRule="evenodd" clipRule="evenodd"
        d="M20.998 10.949H24v3.102h-3v3.028h-1.487V20H18v-2.921h-1.487V20H15v-2.921H9V20H7.488v-2.921H6V20H4.487v-2.921H3V14.05H0V10.95h3V5h17.998v5.949zM6 10.949h1.488V8.102H6v2.847zm10.51 0H18V8.102h-1.49v2.847z" /></svg>
    : harness === 'pi'
    ? <svg viewBox="0 0 800 800" aria-hidden><path fill="currentColor" fillRule="evenodd"
        d="M165.29 165.29H517.36V400H400V517.36H282.65V634.72H165.29ZM282.65 282.65V400H400V282.65Z" /><path fill="currentColor" d="M517.36 400H634.72V634.72H517.36Z" /></svg>
    : harness === 'codex'
    ? <img src="/icons/codex.png" alt="" />
    : <span className="mono">{harness.slice(0, 2)}</span>;
  return <span className={`harness-icon hi-${harness} ${size ?? ''}`} title={harnessLabel[harness] ?? harness}>{mark}{live && <i className="live-dot" />}</span>;
}

/** The user: the agent face made human with black hair and headphones. */
export function UserAvatar({ size }: { size?: 'small' | 'large' }) {
  return (
    <span className={`user-avatar ${size ?? ''}`} aria-hidden>
      <svg viewBox="0 0 40 40">
        <path className="ua-band" d="M7.5 21 C7.5 10 13 5 20 5 C27 5 32.5 10 32.5 21" />
        <circle className="ua-face" cx="20" cy="22" r="12" />
        <path className="ua-shade" d="M8.6 25 C14 30 25 31 31.2 25.5 C30 31 25.5 34 20 34 C14 34 9.8 30 8.6 25 Z" />
        <ellipse className="ua-shine" cx="14" cy="27" rx="2.6" ry="4" transform="rotate(25 14 27)" />
        <path className="ua-hair" d="M8 21.5 C7.6 13 13 9 20 9 C27.4 9 32.4 13.4 32 21 C30.2 17.6 27.4 15.6 23.6 15.2 C24.4 16.4 24.6 17.4 24.4 18.2 C21.4 15.8 17.8 15.4 14.4 16.6 C12 17.4 9.8 19.2 8 21.5 Z" />
        <rect className="ua-eye" x="15.2" y="22" width="1.8" height="3.6" rx=".9" />
        <rect className="ua-eye" x="23" y="22" width="1.8" height="3.6" rx=".9" />
        <rect className="ua-cup" x="4.6" y="17.5" width="5" height="9.5" rx="2.4" />
        <rect className="ua-cup" x="30.4" y="17.5" width="5" height="9.5" rx="2.4" />
        <rect className="ua-pad" x="6" y="19.3" width="1.6" height="5.9" rx=".8" />
        <rect className="ua-pad" x="32.4" y="19.3" width="1.6" height="5.9" rx=".8" />
      </svg>
    </span>
  );
}

export function BackButton({ onClick, label }: { onClick: () => void; label: string }) {
  return <button className="ghost back" onClick={onClick}><img src="/icons/back-button-96.png" alt="" />{label}</button>;
}

export function HarnessBadge({ harness, compact, face = true }: { harness: string; compact?: boolean; face?: boolean }) {
  const label = harnessLabel[harness] ?? harness;
  return <span className={`harness h-${harness}`}>{face && <HarnessIcon harness={harness} size="small" />}{compact ? label.split(' ')[0] : label}</span>;
}

export function Wordmark() {
  return <span className="wordmark" aria-label="wisdom">wisd<Face tone="user" />m</span>;
}

const scales = [['1', '100'], ['1.25', '125'], ['1.5', '150']] as const;

/** UI scale in percent. 150 is the default; remembered per browser like the theme. */
export function ScaleSwitch() {
  const [scale, setScale] = useState<string>();
  useEffect(() => { setScale(document.documentElement.dataset.scale ?? '1.5'); }, []);
  const choose = (next: string) => {
    document.documentElement.dataset.scale = next;
    try { localStorage.setItem('wisdom-scale', next); } catch { /* still applies to this page */ }
    setScale(next);
  };
  return (
    <span className="themes" role="radiogroup" aria-label="Text size" title="Text and layout size">
      <span className="aa" aria-hidden>Aa</span>
      {scales.map(([value, label]) => (
        <button key={value} role="radio" aria-checked={scale === value} className={scale === value ? 'on' : ''} onClick={() => choose(value)}>{label}</button>
      ))}
    </span>
  );
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
