// Pure canvas-viewer logic (unit-tested): frame rects, status texts, onion neighbours, GIF URL, live change plan.
import type { AnyEvent, CanvasInfo, Rect } from '@/lib/api/types';
import { canvasGif } from '@/lib/api/urls';

export function frameRect(stripW: number, stripH: number, fh: number, frame: number, frameMode: boolean): Rect {
  return frameMode ? { x: 0, y: frame * fh, w: stripW, h: fh } : { x: 0, y: 0, w: stripW, h: stripH };
}

export const frameCount = (stripH: number, fh: number): number => Math.max(1, Math.round(stripH / (fh || stripH || 1)));

export function onionNeighbours(frame: number, n: number, frameMode: boolean): { prev: number | null; next: number | null } | null {
  if (!frameMode) return null;
  return { prev: frame > 0 ? frame - 1 : null, next: frame < n - 1 ? frame + 1 : null };
}

export const zoomText = (z: number): string => (z >= 1 ? `${z}×` : `1/${Math.round(1 / z)}`);

export function hoverText(p: [number, number] | null, c: { hex: string; a: number } | null | undefined, frameHeight: number | null | undefined, frameMode: boolean): string {
  if (!p) return '';
  const y = p[1];
  const fr = frameHeight && !frameMode ? `  frame ${Math.floor(y / frameHeight)} (y ${y % frameHeight})` : '';
  return `x ${p[0]}  y ${y}${fr}  ${c && c.a ? c.hex : 'transparent'}`;
}

export function metaText(i: Pick<CanvasInfo, 'name' | 'width' | 'height' | 'frames' | 'frameHeight'> & { colors?: { unique: number }; undo?: number }, snapshot: boolean): string {
  const fh = i.frameHeight;
  return `${i.name} · ${i.width}×${fh || i.height}${i.frames > 1 ? ` × ${i.frames} frames` : ''}${i.colors ? ` · ${i.colors.unique} colours` : ''}${i.undo !== undefined ? ` · undo ${i.undo}` : ''}${snapshot ? ' · read-only snapshot' : ''}`;
}

export const gifUrl = (name: string, tag: string): string => canvasGif(name, { scale: 4, download: true, animation: tag || undefined });

export const frameLabel = (frame: number, n: number, frameMode: boolean): string => (frameMode ? `${frame} / ${n - 1}` : `${n} frames`);

export interface ChangePlan { flashRect: Rect | null; jumpToFrame: number | null; thumbFlash: number | null; refit: boolean; reload: boolean; deleted: boolean }

/** What a live event means for the open canvas. */
export function planChange(ev: AnyEvent, s: { name: string; snap: boolean; frameMode: boolean; frameHeight: number | null | undefined; frame: number; following: boolean }): ChangePlan {
  const none: ChangePlan = { flashRect: null, jumpToFrame: null, thumbFlash: null, refit: false, reload: false, deleted: false };
  if (s.snap) return none;
  if (ev.type === 'resync') return { ...none, reload: true };
  if (ev.type === 'deleted' && (ev as { canvas?: string }).canvas === s.name) return { ...none, deleted: true };
  if (ev.type !== 'change' || (ev as { canvas?: string }).canvas !== s.name) return none;
  const e = ev as { dirty?: Rect | null; source?: string; op?: string };
  const plan: ChangePlan = { ...none, reload: true, refit: e.op === 'transform' };
  if (e.dirty && e.source === 'agent') {
    const fh = s.frameHeight;
    if (s.frameMode && fh) {
      const f = Math.floor(e.dirty.y / fh);
      let cur = s.frame;
      if (s.following && e.dirty.y + e.dirty.h <= (f + 1) * fh) { plan.jumpToFrame = f; cur = f; }
      if (f === cur) plan.flashRect = { ...e.dirty, y: e.dirty.y - f * fh };
      plan.thumbFlash = f;
    } else plan.flashRect = e.dirty;
  }
  return plan;
}
