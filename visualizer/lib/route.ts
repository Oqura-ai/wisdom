'use client';

import { useEffect, useState } from 'react';

/** Where the reader is, in the page's hash: plain files on any host serve one page, and a link
 * to a change or a commit is still a link (#/change/124, #/commit/<sha>). */
export type Route =
  | { view: 'main' } | { view: 'branches' } | { view: 'people' } | { view: 'sessions' }
  | { view: 'change'; id: string }
  | { view: 'commit'; sha: string; change?: string };

export function parse(hash: string): Route {
  const [kind, a, b] = hash.replace(/^#\/?/, '').split('/').map(decodeURIComponent);
  if (kind === 'branches' || kind === 'people' || kind === 'sessions') return { view: kind };
  if (kind === 'change' && a) return { view: 'change', id: a };
  if (kind === 'commit' && a) return { view: 'commit', sha: a, ...(b ? { change: b } : {}) };
  return { view: 'main' };
}

export function href(route: Route): string {
  switch (route.view) {
    case 'main': return '#/';
    case 'change': return `#/change/${encodeURIComponent(route.id)}`;
    case 'commit': return `#/commit/${route.sha}${route.change ? `/${encodeURIComponent(route.change)}` : ''}`;
    default: return `#/${route.view}`;
  }
}

export const go = (route: Route) => { window.location.hash = href(route); };

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>({ view: 'main' });
  useEffect(() => {
    const update = () => setRoute(parse(window.location.hash));
    update();
    window.addEventListener('hashchange', update);
    return () => window.removeEventListener('hashchange', update);
  }, []);
  return route;
}
