import type { LandHow, Reason, Status } from '@contract';

/** The words and colours of a status. Colour means a status only. */
export const STATUS: Record<Status, string> = { good: 'all good', look: 'look closer', attention: 'needs attention', none: 'no record' };
/** The stylesheet's class suffix for a status (s-good, t-warn...). */
export const TONE: Record<Status, 'good' | 'warn' | 'bad' | 'none'> = { good: 'good', look: 'warn', attention: 'bad', none: 'none' };
export const COLOR: Record<Status, string> = { good: 'var(--good)', look: 'var(--warn)', attention: 'var(--bad)', none: 'var(--faint)' };
export const RANK: Record<Status, number> = { good: 0, none: 1, look: 2, attention: 3 };

export const HOW: Record<LandHow, string> = { squash: 'squash merge', merge: 'merge commit', rebase: 'rebase merge', unknown: 'landed' };
export const BASIS: Record<string, string> = { git: 'git reported the rewrite', github: 'from GitHub\'s pull request', 'commit-map': 'from filter-repo\'s commit map',
  'patch-id': 'the same change (patch-id)', order: 'by position only' };
/** A link line's style says how we know: solid, dashed, dotted red. */
export const LINE: Record<string, string> = { git: '', github: '', 'commit-map': '', 'patch-id': 'patch', order: 'order' };

/** Where this build's evidence is, in words: the team's remote, or this machine (set once from the manifest). */
export const PLACE = { on: 'on the remote', name: 'the remote' };
export function setPlace(mode: 'team' | 'local') {
  Object.assign(PLACE, mode === 'local' ? { on: 'on this machine', name: 'this machine' } : { on: 'on the remote', name: 'the remote' });
}

/** One reason in plain words, as a reviewer reads it. */
export function reasonWords(reason: Reason): string {
  const where = reason.path ? ` in ${reason.path}` : '';
  switch (reason.code) {
    case 'outside-step': return `a change outside any recorded step${where}`;
    case 'two-sessions': return `a piece two sessions both made${where}`;
    case 'session-missing': return `session ${short(reason.session?.split('/').pop() ?? '')} is not ${PLACE.on}`;
    case 'record-missing': return reason.detail ?? `its record is not ${PLACE.on}`;
    case 'order-link': return 'tied to its commit by position only';
    case 'no-guide': return reason.detail ? `no guide: ${reason.detail}` : 'no guide';
    case 'guide-problems': return `the guide did not pass its check${reason.detail ? `: ${reason.detail}` : ''}`;
    case 'step-changed': return `a cited step${reason.detail ? ` (${reason.detail})` : ''} is no longer in its session as recorded`;
    case 'no-record': return 'no record: made without Wisdom, or the line was removed';
  }
}

/** Where main's recorded history starts, in words: "since team mode", "before Wisdom recorded here". */
export const SINCE: Record<'team-mode' | 'recording', string> = { 'team-mode': 'team mode', recording: 'Wisdom recorded here' };

export const short =(sha: string) => sha.slice(0, 7);
export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
export const trunc = (text: string, n: number) => text.length > n ? `${text.slice(0, n - 1)}…` : text;

export function ago(iso: string | undefined, now = Date.now()): string {
  if (!iso) return '';
  const minutes = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${plural(hours, 'hour')} ago`;
  return `${plural(Math.round(hours / 24), 'day')} ago`;
}

export const initials = (name: string) => (name.match(/[A-Za-z0-9]+/g) ?? ['?']).slice(0, 2).map(part => part[0].toUpperCase()).join('');
