'use client';

import type { Status } from '@contract';
import { STATUS, TONE, initials } from '@/lib/words';

export const Dot = ({ status }: { status: Status }) => <span className={`dot s-${TONE[status]}`} title={STATUS[status]} />;

export const Avatar = ({ name }: { name: string }) => <span className="avatar" title={name}>{initials(name)}</span>;

export const Avatars = ({ names }: { names: string[] }) => <span className="avatars">{[...new Set(names)].filter(Boolean).map(name => <Avatar key={name} name={name} />)}</span>;

export const Head = ({ title, sub, children }: { title: string; sub?: string; children?: React.ReactNode }) => (
  <header className="card-head"><h2>{title}</h2>{sub && <span className="sub">{sub}</span>}{children}</header>
);

export interface NeedItem { status: Status; label: React.ReactNode; why: string; open: () => void }

/** "Needs a look": the worst first, at most three, each one click into its page. */
export function Needs({ items, more }: { items: NeedItem[]; more?: () => void }) {
  if (!items.length) return null;
  return (
    <div className="needs">
      {items.slice(0, 3).map((item, k) => (
        <div key={k} className="item" role="link" tabIndex={0} onClick={item.open} onKeyDown={e => { if (e.key === 'Enter') item.open(); }}>
          <Dot status={item.status} />{item.label}<span className="why">{item.why}</span><span className="spacer" />
          <span className={`small t-${TONE[item.status]} nowrap`}>{STATUS[item.status]}</span>
        </div>
      ))}
      {items.length > 3 && more && <button className="more" onClick={more}>{items.length - 3} more in the list ›</button>}
    </div>
  );
}

export function StateNote({ title, children }: { title: string; children?: React.ReactNode }) {
  return <div className="card state-note"><b>{title}</b>{children}</div>;
}

export const Legend = ({ children }: { children: React.ReactNode }) => (
  <div className="legend">
    <span><Dot status="good" /> all good</span><span><Dot status="look" /> look closer</span><span><Dot status="attention" /> needs attention</span>
    <span><Dot status="none" /> no record</span>{children}
  </div>
);
