// Small formatting and timing helpers shared by the shell and the viewers.

export const clamp = (v: number, a: number, b: number): number => Math.max(a, Math.min(b, v));

export const fmtMs = (ms: number | null | undefined): string =>
  ms === undefined || ms === null ? '' : ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(ms < 10000 ? 2 : 1)} s`;

export const fmtTime = (ts: number): string => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

export const fmtBytes = (n: number): string =>
  n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;

export interface Debounced<A extends unknown[]> { (...a: A): void; cancel(): void; flush(): void }

/** Trailing debounce with cancel / flush. */
export function debounce<A extends unknown[]>(fn: (...a: A) => void, ms: number): Debounced<A> {
  let t: ReturnType<typeof setTimeout> | null = null;
  let last: A | null = null;
  const d = ((...a: A) => {
    last = a;
    if (t) clearTimeout(t);
    t = setTimeout(() => { t = null; const args = last!; last = null; fn(...args); }, ms);
  }) as Debounced<A>;
  d.cancel = () => { if (t) clearTimeout(t); t = null; last = null; };
  d.flush = () => { if (t) { clearTimeout(t); t = null; const args = last!; last = null; fn(...args); } };
  return d;
}

/** Coalesce calls into one per animation frame (falls back to a 16 ms timer without rAF). */
export function rafBatch(fn: () => void): { (): void; cancel(): void } {
  let id: number | null = null;
  const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (cb: FrameRequestCallback) => setTimeout(() => cb(performance.now()), 16) as unknown as number;
  const caf = typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame : (h: number) => clearTimeout(h);
  const run = (() => { if (id !== null) return; id = raf(() => { id = null; fn(); }); }) as { (): void; cancel(): void };
  run.cancel = () => { if (id !== null) caf(id); id = null; };
  return run;
}

/** "1.47s" style duration for audio meta. */
export const fmtSeconds = (s: number | undefined, digits = 2): string => (s === undefined || s === null || Number.isNaN(+s) ? '' : `${(+s).toFixed(digits)}s`);
