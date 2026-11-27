'use client';

import { useEffect, useRef } from 'react';

type Camera = { x: number; y: number; k: number };
/** One camera per canvas, kept while the page is open, so going back finds it where it was. */
const cameras = new Map<string, Camera>();

/** A drawing at real size, so text stays readable: drag or scroll to move, Ctrl + scroll to zoom.
 * A click that did not drag picks the nearest element with `data-pick` (the drag's pointer
 * capture would otherwise swallow it). */
export function Canvas({ id, width, height, short, onPick, children }: {
  id: string; width: number; height: number; short?: boolean; onPick?: (key: string) => void; children: React.ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null), svg = useRef<SVGSVGElement>(null), vp = useRef<SVGGElement>(null);
  const pick = useRef(onPick);
  pick.current = onPick;

  useEffect(() => {
    const el = svg.current!, group = vp.current!, frame = box.current!;
    const rect = () => el.getBoundingClientRect();
    const cam = cameras.get(id) ?? (() => { const k = Math.min(1, Math.max(.8, rect().width / width)); const c = { x: 0, y: 0, k }; cameras.set(id, c); return c; })();
    const apply = () => group.setAttribute('transform', `translate(${cam.x} ${cam.y}) scale(${cam.k})`);
    apply();
    const at = (e: { clientX: number; clientY: number }) => { const r = rect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
    const zoomAt = (f: number, p: { x: number; y: number }) => {
      const k = Math.min(2.5, Math.max(.35, cam.k * f));
      cam.x = p.x - (p.x - cam.x) * (k / cam.k); cam.y = p.y - (p.y - cam.y) * (k / cam.k); cam.k = k; apply();
    };
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) zoomAt(e.deltaY < 0 ? 1.1 : 1 / 1.1, at(e));
      else { cam.x -= e.shiftKey ? e.deltaY : e.deltaX; cam.y -= e.shiftKey ? 0 : e.deltaY; apply(); }
    };
    let drag: { x: number; y: number; cx: number; cy: number; moved: boolean } | null = null;
    const down = (e: PointerEvent) => { drag = { x: e.clientX, y: e.clientY, cx: cam.x, cy: cam.y, moved: false }; el.setPointerCapture(e.pointerId); };
    const move = (e: PointerEvent) => {
      if (!drag) return;
      if (Math.abs(e.clientX - drag.x) + Math.abs(e.clientY - drag.y) > 4) { drag.moved = true; frame.classList.add('dragging'); }
      if (drag.moved) { cam.x = drag.cx + (e.clientX - drag.x); cam.y = drag.cy + (e.clientY - drag.y); apply(); }
    };
    const up = (e: PointerEvent) => {
      const was = drag; drag = null; frame.classList.remove('dragging');
      if (was && !was.moved) {
        const hit = document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-pick]');
        const key = hit?.getAttribute('data-pick');
        if (key) pick.current?.(key);
      }
    };
    el.addEventListener('wheel', wheel, { passive: false });
    el.addEventListener('pointerdown', down); el.addEventListener('pointermove', move); el.addEventListener('pointerup', up);
    const zoom = (how: 'in' | 'out' | 'fit') => {
      const r = rect();
      if (how === 'fit') { const k = Math.min(1, r.width / width, r.height / height); Object.assign(cam, { x: (r.width - width * k) / 2, y: Math.max(0, (r.height - height * k) / 2), k }); apply(); }
      else zoomAt(how === 'in' ? 1.2 : 1 / 1.2, { x: r.width / 2, y: r.height / 2 });
    };
    const buttons = [...frame.querySelectorAll<HTMLButtonElement>('[data-zoom]')];
    const onButton = (e: MouseEvent) => { e.stopPropagation(); zoom((e.currentTarget as HTMLButtonElement).dataset.zoom as 'in' | 'out' | 'fit'); };
    buttons.forEach(b => b.addEventListener('click', onButton));
    return () => {
      el.removeEventListener('wheel', wheel);
      el.removeEventListener('pointerdown', down); el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up);
      buttons.forEach(b => b.removeEventListener('click', onButton));
    };
  }, [id, width, height]);

  return (
    <div className={`canvas ${short ? 'short' : ''}`} ref={box}>
      <svg ref={svg}><g className="vp" ref={vp}>{children}</g></svg>
      <div className="tools">
        <button data-zoom="in" title="Zoom in" aria-label="Zoom in">+</button>
        <button data-zoom="out" title="Zoom out" aria-label="Zoom out">−</button>
        <button data-zoom="fit" title="Fit to view" aria-label="Fit to view">⤢</button>
      </div>
      <div className="hint">Drag or scroll to move · Ctrl + scroll to zoom</div>
    </div>
  );
}
