// Shell layout (L1–L5, N1–N4): pane sizes, pane visibility, the timeline dock, the narrow layout and
// its drawers. Persisted as legacy: agent-art:sizes { 'browser-w': n, ... } (rounded px, only the keys
// the user changed), agent-art:panes { browser, side }, agent-art:dock 'right' | 'bottom'.
import { store } from '@/lib/util/storage';

export type SizeKey = 'browser-w' | 'side-w' | 'insp-h' | 'bottom-h';
export const SIZE_KEYS: readonly SizeKey[] = ['browser-w', 'side-w', 'insp-h', 'bottom-h'];
export type Dock = 'right' | 'bottom';
export type Drawer = 'browser' | 'side' | null;

export const NARROW_PX = 860;
export const COMPACT_PX = 1100;

/** CSS defaults (tokens.css, compact media query) in px, for the splitters' aria values and drag start. */
export function defaultSize(key: SizeKey, vw: number, vh: number): number {
  const compact = vw <= COMPACT_PX;
  switch (key) {
    case 'browser-w': return compact ? 230 : 280;
    case 'side-w': return compact ? 300 : 360;
    case 'insp-h': return Math.round(vh * 0.46);
    case 'bottom-h': return 260;
  }
}

function readSizes(): Record<SizeKey, number | null> {
  const raw = store.get<Record<string, unknown>>('sizes', {});
  const out = { 'browser-w': null, 'side-w': null, 'insp-h': null, 'bottom-h': null } as Record<SizeKey, number | null>;
  if (raw && typeof raw === 'object') for (const k of SIZE_KEYS) { const v = raw[k]; if (typeof v === 'number' && Number.isFinite(v) && v > 0) out[k] = Math.round(v); }
  return out;
}

export class Layout {
  /** null = the CSS default */
  sizes = $state<Record<SizeKey, number | null>>(readSizes());
  panes = $state<{ browser: boolean; side: boolean }>(this.readPanes());
  dock = $state<Dock>(store.get<string>('dock', 'right') === 'bottom' ? 'bottom' : 'right');
  narrow = $state(false);
  /** narrow layout only; never persisted (fixes N3) */
  drawer = $state<Drawer>(null);
  vw = $state(typeof window === 'undefined' ? 1680 : window.innerWidth);
  vh = $state(typeof window === 'undefined' ? 980 : window.innerHeight);

  private readPanes(): { browser: boolean; side: boolean } {
    const p = store.get<{ browser?: unknown; side?: unknown }>('panes', { browser: true, side: true });
    return { browser: p?.browser !== false, side: p?.side !== false };
  }

  /** Current size in px (stored, else the CSS default). */
  px(key: SizeKey): number { return this.sizes[key] ?? defaultSize(key, this.vw, this.vh); }
  /** Is the pane on screen (wide: panes; narrow: its drawer)? */
  shown(which: 'browser' | 'side'): boolean { return this.narrow ? this.drawer === which : this.panes[which]; }

  /** `[` / `]` and the pane buttons: narrow toggles the drawer, wide toggles the pane and persists. */
  togglePane(which: 'browser' | 'side'): void {
    if (this.narrow) { this.drawer = this.drawer === which ? null : which; return; }
    this.panes = { ...this.panes, [which]: !this.panes[which] };
    store.set('panes', this.panes);
  }
  closeDrawer(): void { this.drawer = null; }
  toggleDock(): void {
    this.dock = this.dock === 'bottom' ? 'right' : 'bottom';
    store.set('dock', this.dock);
  }
  setSize(key: SizeKey, px: number): void { this.sizes = { ...this.sizes, [key]: Math.round(px) }; }
  /** Persist the sizes the user set (drag end, key press). */
  commitSizes(): void {
    const out: Partial<Record<SizeKey, number>> = {};
    for (const k of SIZE_KEYS) { const v = this.sizes[k]; if (v !== null) out[k] = v; }
    store.set('sizes', out);
  }
  /** Double-click on a splitter: back to the CSS default. */
  resetSize(key: SizeKey): void { this.sizes = { ...this.sizes, [key]: null }; this.commitSizes(); }
  setNarrow(on: boolean): void {
    if (this.narrow === on) return;
    this.narrow = on;
    this.drawer = null;
  }
  setViewport(w: number, h: number): void { this.vw = w; this.vh = h; }
}

export const layout = new Layout();
