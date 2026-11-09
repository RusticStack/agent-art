// The `Z` shading pie (plan 5.7b): four wedges in Blender's layout, left Wireframe, right Solid, top
// Rendered, bottom Material preview. Pure layout / key helpers plus a small DOM overlay (role="menu").
import { h } from '@/lib/util/dom';
import { MODE_LABELS, MODES, type ShadingMode } from './shading';

export type PieDir = 'left' | 'right' | 'top' | 'bottom';
export const PIE_LAYOUT: Record<PieDir, ShadingMode> = { left: 'wire', right: 'solid', top: 'rendered', bottom: 'material' };
export const PIE_RADIUS = 78;
/** Half size of the pie's bounding box (radius + half an item), used to keep it inside the stage. */
export const PIE_HALF = 130;

export function pieDirOf(mode: ShadingMode): PieDir {
  return (Object.keys(PIE_LAYOUT) as PieDir[]).find((d) => PIE_LAYOUT[d] === mode)!;
}
/** Item offset from the pie centre in CSS px (y down). */
export function pieOffset(dir: PieDir, r = PIE_RADIUS): { x: number; y: number } {
  switch (dir) {
    case 'left': return { x: -r, y: 0 };
    case 'right': return { x: r, y: 0 };
    case 'top': return { x: 0, y: -r };
    case 'bottom': return { x: 0, y: r };
  }
}
/** Pie centre: the pointer when known, else the stage centre; clamped so the whole pie stays inside. */
export function piePosition(pointer: { x: number; y: number } | null, w: number, hh: number, half = PIE_HALF): { x: number; y: number } {
  const p = pointer ?? { x: w / 2, y: hh / 2 };
  const cl = (v: number, max: number) => (max <= 2 * half ? max / 2 : Math.max(half, Math.min(max - half, v)));
  return { x: cl(p.x, w), y: cl(p.y, hh) };
}
/** A key pressed while the pie is open: pick (digit / Enter), move the highlight (arrows), close, or nothing. */
export type PieAction = { pick: ShadingMode } | { focus: ShadingMode } | { close: true } | null;
export function pieKey(key: string, code: string, focused: ShadingMode | null): PieAction {
  const d = /^Digit([1-4])$/.exec(code)?.[1] ?? (code === '' && /^[1-4]$/.test(key) ? key : null);
  if (d) return { pick: MODES[Number(d) - 1] };
  if (key === 'Escape') return { close: true };
  if (key === 'Enter' || key === ' ') return focused ? { pick: focused } : null;
  const dir: PieDir | null = key === 'ArrowLeft' ? 'left' : key === 'ArrowRight' ? 'right' : key === 'ArrowUp' ? 'top' : key === 'ArrowDown' ? 'bottom' : null;
  return dir ? { focus: PIE_LAYOUT[dir] } : null;
}

export interface PieHandle { el: HTMLElement; focus(mode: ShadingMode): void; focused(): ShadingMode | null; destroy(): void }

/** Build the pie overlay at (x, y) in stage coordinates. `pick(null)` closes without a choice. */
export function buildPie(at: { x: number; y: number }, current: ShadingMode, pick: (m: ShadingMode | null) => void): PieHandle {
  const ac = new AbortController();
  const items = new Map<ShadingMode, HTMLButtonElement>();
  const el = h('div', { class: 'shading-pie', role: 'menu', 'aria-label': 'Shading mode', style: { left: `${at.x}px`, top: `${at.y}px` } });
  let foc: ShadingMode | null = null;
  const focus = (m: ShadingMode) => { foc = m; for (const [k, b] of items) b.classList.toggle('focus', k === m); items.get(m)?.focus(); };
  for (const dir of ['left', 'right', 'top', 'bottom'] as PieDir[]) {
    const mode = PIE_LAYOUT[dir], o = pieOffset(dir);
    const n = MODES.indexOf(mode) + 1;
    const b = h('button', {
      type: 'button', class: `pie-item ${dir}`, role: 'menuitemradio', 'aria-checked': String(mode === current), dataset: { mode, dir },
      title: `${MODE_LABELS[mode]} (${n})`, style: { transform: `translate(calc(${o.x}px - 50%), calc(${o.y}px - 50%))` },
      on: { click: (e: Event) => { e.stopPropagation(); pick(mode); } },
    }, h('span', { class: 'pie-key mono', text: String(n) }), ' ' + MODE_LABELS[mode]);
    items.set(mode, b);
    el.append(b);
  }
  el.addEventListener('keydown', (e) => {
    const a = pieKey(e.key, e.code, foc);
    if (!a) return;
    e.preventDefault(); e.stopPropagation();
    if ('pick' in a) pick(a.pick);
    else if ('focus' in a) focus(a.focus);
    else pick(null);
  }, { signal: ac.signal });
  // pressing anywhere outside the items closes the pie; so does focus leaving it
  const outside = (e: Event) => { if (!(e.target instanceof Node) || !el.contains(e.target) || e.target === el) pick(null); };
  setTimeout(() => {
    if (ac.signal.aborted) return;
    document.addEventListener('pointerdown', outside, { signal: ac.signal, capture: true });
  }, 0);
  el.addEventListener('focusout', (e) => { const to = e.relatedTarget; if (to instanceof Node && !el.contains(to)) pick(null); }, { signal: ac.signal });
  return { el, focus, focused: () => foc, destroy: () => { ac.abort(); el.remove(); } };
}
