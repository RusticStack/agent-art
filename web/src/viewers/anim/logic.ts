// Pure animation-player maths (unit-tested): auto scale, canvas size limits, status line.
import type { AnimTag } from '@/lib/api/types';

export const MAX_SCALE = 16;
/** Browser canvas limits we stay under (5, shared pitfalls checklist). */
export const MAX_SIDE = 8192;
export const MAX_AREA = 32_000_000;

/** Largest integer scale (1..16) at which cols x rows cells of w x fh fit the stage box (legacy padding). */
export function fitScale(box: { width: number; height: number }, w: number, fh: number, cols: number, rows: number): number {
  const fit = Math.floor(Math.min((box.width - 24 * cols) / (w * cols), (box.height - 40 * rows) / (fh * rows)));
  return Math.min(MAX_SCALE, Math.max(1, Number.isFinite(fit) ? fit : 1));
}

/** Clamp an integer scale so a w x h image drawn at it stays inside the canvas limits. */
export function clampScale(scale: number, w: number, h: number): { scale: number; clamped: boolean } {
  const s = Math.max(1, Math.floor(scale));
  const bySide = Math.floor(MAX_SIDE / Math.max(1, w, h));
  const byArea = Math.floor(Math.sqrt(MAX_AREA / Math.max(1, w * h)));
  const max = Math.max(1, Math.min(bySide, byArea));
  return s > max ? { scale: max, clamped: true } : { scale: s, clamped: false };
}

export function statusText(name: string, tag: string, info: { frames: number; animations?: Record<string, AnimTag> }, fps: number, views: number, cappedAt: number | null = null): string {
  const t = tag ? info.animations?.[tag] : undefined;
  let s = `${name} · `;
  if (tag && t) {
    const ms = t.durations.reduce((a, b) => a + b, 0);
    s += `${tag}: ${t.frames.length} frames, ${ms} ms${t.loop === false ? ', no loop' : ''}${t.direction && t.direction !== 'forward' ? `, ${t.direction}` : ''}`;
  } else s += `${info.frames} frames @ ${fps} fps`;
  if (views > 1) s += ` · ${views} views`;
  if (cappedAt !== null) s += ` · scale capped at ${cappedAt}× (canvas size limit)`;
  return s;
}

/** Image pixel under a client point on a cell canvas drawn at any CSS size. */
export function cellPixel(r: { left: number; top: number; width: number; height: number }, clientX: number, clientY: number, w: number, fh: number): [number, number] {
  return [Math.floor(((clientX - r.left) / (r.width || 1)) * w), Math.floor(((clientY - r.top) / (r.height || 1)) * fh)];
}
