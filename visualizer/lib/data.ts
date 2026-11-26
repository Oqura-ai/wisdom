'use client';

import { useEffect, useState, useSyncExternalStore } from 'react';
import type { Manifest } from '@contract';

/** Where the Commits builder's files are: `data/` beside the page unless told otherwise. Every
 * read goes through here, so behind the sign-in each one passes its check. */
const BASE = (process.env.NEXT_PUBLIC_WISDOM_DATA ?? 'data').replace(/\/+$/, '');

const cache = new Map<string, Promise<unknown>>();

export class Missing extends Error {}

// Which build the reads are of. Team mode never moves it (the reader reloads when told a new
// build is there); local mode moves it with each new build, and every open read is read again.
let generation = 0;
const listeners = new Set<() => void>();
function renew() { cache.clear(); generation++; listeners.forEach(listener => listener()); }
const useGeneration = () => useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => generation, () => 0);

const once = async (file: string) => {
  const response = await fetch(`${BASE}/${file}`, { cache: 'no-cache' });
  if (response.status === 404) throw new Missing(`${file} is not in this build`);
  if (!response.ok) throw new Error(`${file}: HTTP ${response.status}`);
  return response.json();
};

/** One data file, read once per build. A read that fails is tried once more a moment later:
 * on this machine it may have landed while a new build was being moved in. */
export function load<T>(file: string): Promise<T> {
  let found = cache.get(file);
  if (!found) {
    found = once(file).catch(() => new Promise(resolve => setTimeout(resolve, 400)).then(() => once(file)));
    found.catch(() => cache.delete(file));
    cache.set(file, found);
  }
  return found as Promise<T>;
}

/** A file's data. When a new build comes in, the data shown stays until its new copy is read. */
export function useData<T>(file: string | undefined): { data?: T; error?: string; missing?: boolean } {
  const gen = useGeneration();
  const [state, setState] = useState<{ file?: string; data?: T; error?: string; missing?: boolean }>({});
  useEffect(() => {
    if (!file) return;
    let live = true;
    load<T>(file).then(data => { if (live) setState({ file, data }); },
      error => { if (live) setState({ file, error: error instanceof Error ? error.message : String(error), missing: error instanceof Missing }); });
    return () => { live = false; };
  }, [file, gen]);
  return state.file === file ? state : {};
}

/** Several files at once, in order; undefined until all are read (a missing one is undefined). */
export function useMany<T>(files: string[]): (T | undefined)[] | undefined {
  const gen = useGeneration();
  const key = files.join('\n');
  const [state, setState] = useState<{ key: string; data: (T | undefined)[] }>();
  useEffect(() => {
    let live = true;
    Promise.all(files.map(file => load<T>(file).catch(() => undefined))).then(data => { if (live) setState({ key, data }); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, gen]);
  return state?.key === key ? state.data : undefined;
}

/** The build this page shows. Team mode: asked every minute and when the tab comes back, and a
 * newer build is only announced (`newer`), never swapped in under the reader. Local mode (this
 * machine, live): asked every two seconds, and a newer build is shown at once, in place. */
export function useManifest(): { manifest?: Manifest; newer: boolean; error?: string } {
  const [shown, setShown] = useState<Manifest>();
  const [newer, setNewer] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    let live = true, asking = false, current: Manifest | undefined, timer: ReturnType<typeof setTimeout> | undefined;
    const ask = async () => {
      if (asking) return;
      asking = true;
      try {
        const response = await fetch(`${BASE}/manifest.json`, { cache: 'no-store' });
        if (!response.ok) throw new Error(response.status === 404 ? 'No build here yet.' : `manifest.json: HTTP ${response.status}`);
        const next = await response.json() as Manifest;
        if (!live) return;
        setError(undefined);
        const changed = !!current && (current.builtAt !== next.builtAt || current.files['index.json'] !== next.files['index.json']);
        if (!current) { current = next; setShown(next); }
        else if (changed && next.mode === 'local') { current = next; renew(); setShown(next); }
        else if (changed) setNewer(true);
      } catch (e) { if (live) setError(e instanceof Error ? e.message : String(e)); }
      asking = false;
      if (live) timer = setTimeout(ask, current?.mode === 'local' ? 2_000 : 60_000);
    };
    void ask();
    // Coming back asks now, in place of the next timed ask (never a second chain of them).
    const onFocus = () => { if (document.visibilityState === 'visible') { clearTimeout(timer); void ask(); } };
    document.addEventListener('visibilitychange', onFocus);
    return () => { live = false; clearTimeout(timer); document.removeEventListener('visibilitychange', onFocus); };
  }, []);
  return { manifest: shown, newer, error };
}
