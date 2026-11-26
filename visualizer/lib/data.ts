'use client';

import { useEffect, useState } from 'react';
import type { Manifest } from '@contract';

/** Where the Commits builder's files are: `data/` beside the page unless told otherwise. Every
 * read goes through here, so behind the sign-in each one passes its check. */
const BASE = (process.env.NEXT_PUBLIC_WISDOM_DATA ?? 'data').replace(/\/+$/, '');

const cache = new Map<string, Promise<unknown>>();

export class Missing extends Error {}

/** One data file, read once per page load: a build never changes under an open page (the
 * manifest says when a new one is there, and the reader reloads). */
export function load<T>(file: string): Promise<T> {
  let found = cache.get(file);
  if (!found) {
    found = fetch(`${BASE}/${file}`, { cache: 'no-cache' }).then(async response => {
      if (response.status === 404) throw new Missing(`${file} is not in this build`);
      if (!response.ok) throw new Error(`${file}: HTTP ${response.status}`);
      return response.json();
    });
    found.catch(() => cache.delete(file));
    cache.set(file, found);
  }
  return found as Promise<T>;
}

export function useData<T>(file: string | undefined): { data?: T; error?: string; missing?: boolean } {
  const [state, setState] = useState<{ file?: string; data?: T; error?: string; missing?: boolean }>({});
  useEffect(() => {
    if (!file) return;
    let live = true;
    load<T>(file).then(data => { if (live) setState({ file, data }); },
      error => { if (live) setState({ file, error: error instanceof Error ? error.message : String(error), missing: error instanceof Missing }); });
    return () => { live = false; };
  }, [file]);
  return state.file === file ? state : {};
}

/** Several files at once, in order; undefined until all are read (a missing one is undefined). */
export function useMany<T>(files: string[]): (T | undefined)[] | undefined {
  const key = files.join('\n');
  const [state, setState] = useState<{ key: string; data: (T | undefined)[] }>();
  useEffect(() => {
    let live = true;
    Promise.all(files.map(file => load<T>(file).catch(() => undefined))).then(data => { if (live) setState({ key, data }); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return state?.key === key ? state.data : undefined;
}

/** The build this page shows, and whether a newer one is there: asked every minute and when
 * the tab comes back, never swapped in by itself. */
export function useManifest(): { manifest?: Manifest; newer: boolean; error?: string } {
  const [shown, setShown] = useState<Manifest>();
  const [newer, setNewer] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    let live = true;
    const ask = async () => {
      try {
        const response = await fetch(`${BASE}/manifest.json`, { cache: 'no-store' });
        if (!response.ok) throw new Error(response.status === 404 ? 'No build here yet.' : `manifest.json: HTTP ${response.status}`);
        const next = await response.json() as Manifest;
        if (!live) return;
        setError(undefined);
        setShown(current => {
          if (!current) return next;
          if (current.builtAt !== next.builtAt || current.files['index.json'] !== next.files['index.json']) setNewer(true);
          return current;
        });
      } catch (e) { if (live) setError(e instanceof Error ? e.message : String(e)); }
    };
    void ask();
    const timer = setInterval(ask, 60_000);
    const onFocus = () => { if (document.visibilityState === 'visible') void ask(); };
    document.addEventListener('visibilitychange', onFocus);
    return () => { live = false; clearInterval(timer); document.removeEventListener('visibilitychange', onFocus); };
  }, []);
  return { manifest: shown, newer, error };
}
