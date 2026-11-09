// Pure layers-view helpers (unit-tested): stack normalisation, colours, hit tests, overlap / outline masks,
// the z-order lane chart layout, the "Flag layering" review draft, and a bounded-parallel map.
import type { CanvasLayer, RawStackEntry } from '@/lib/api/types';
import type { ReviewDraft } from '../types';

export interface StackEntry {
  part: string; z: number; rule: string; hidden: boolean; why_hidden?: string; parent: string | null;
  /** Canvas mode: the layer index (bottom = 0). */
  index?: number;
}

/** Accept the derived shape or the rig agent's rig_layers / rig_debug_render shapes. */
export function normStack(raw: RawStackEntry[] | null | undefined): StackEntry[] {
  return (raw || []).map((e, i) => ({
    part: e.part ?? e.name ?? e.layer ?? `#${i}`, z: e.z ?? e.order ?? i, rule: e.rule ?? e.reason ?? e.why ?? '',
    hidden: !!(e.hidden ?? (e.visible === false)), why_hidden: e.why_hidden, parent: e.parent ?? null,
  }));
}

/** Canvas layers as a stack (bottom = layer 0). */
export function canvasStack(layers: Pick<CanvasLayer, 'name' | 'visible' | 'opacity' | 'blend'>[]): StackEntry[] {
  return layers.map((l, i) => ({
    part: l.name, z: i, parent: null, hidden: !l.visible, index: i,
    rule: `layer ${i}${l.blend && l.blend !== 'normal' ? ` · ${l.blend}` : ''}${l.opacity < 1 ? ` · ${Math.round(l.opacity * 100)}%` : ''}`,
  }));
}

/** Colour of the part at draw index i of n. */
export const hue = (i: number, n: number): string => `hsl(${Math.round((i / Math.max(1, n)) * 300)},85%,55%)`;

/** Indices of the visible parts (in draw order) that drew pixel (px, py), topmost first. alpha = RGBA per part. */
export function hitTest(alpha: ArrayLike<number>[], W: number, px: number, py: number, visible: number[]): number[] {
  if (px < 0 || py < 0 || px >= W) return [];
  const o = (py * W + px) * 4 + 3;
  const hits: number[] = [];
  for (let k = visible.length - 1; k >= 0; k--) { const a = alpha[visible[k]]; if (a && o < a.length && a[o]) hits.push(visible[k]); }
  return hits;
}

/** 1 where at least two visible parts drew the pixel. */
export function overlapMask(alpha: ArrayLike<number>[], W: number, H: number, visible: number[]): Uint8Array {
  const m = new Uint8Array(W * H);
  for (let p = 0; p < W * H; p++) {
    let n = 0;
    for (const i of visible) if (alpha[i][p * 4 + 3] && ++n >= 2) break;
    if (n >= 2) m[p] = 1;
  }
  return m;
}

/** 1 on opaque pixels that touch the image border or a transparent 4-neighbour. */
export function outlineMask(alpha: ArrayLike<number>, W: number, H: number): Uint8Array {
  const m = new Uint8Array(W * H);
  const A = (x: number, y: number) => alpha[(y * W + x) * 4 + 3];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (!A(x, y)) continue;
    if (x === 0 || y === 0 || x === W - 1 || y === H - 1 || !A(x - 1, y) || !A(x + 1, y) || !A(x, y - 1) || !A(x, y + 1)) m[y * W + x] = 1;
  }
  return m;
}

/** RGBA for the overlap hatch at 1:1: masked pixels on the (x + y) odd checker get the colour. */
export function hatchRgba(mask: Uint8Array, W: number, H: number, rgba: [number, number, number, number]): Uint8ClampedArray {
  const d = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const p = y * W + x;
    if (mask[p] && ((x + y) & 1)) d.set(rgba, p * 4);
  }
  return d;
}

/**
 * RGBA for an outline at W × (H * rows): each edge pixel paints its top `band` sub-rows (legacy drew a
 * strip of height max(1, scale / 4) at the top of each edge pixel). Draw it scaled to W*s × H*s.
 */
export function outlineRgba(mask: Uint8Array, W: number, H: number, rows: number, band: number, rgba: [number, number, number, number]): Uint8ClampedArray {
  const d = new Uint8ClampedArray(W * H * rows * 4);
  const b = Math.max(1, Math.min(rows, band));
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (!mask[y * W + x]) continue;
    for (let r = 0; r < b; r++) d.set(rgba, ((y * rows + r) * W + x) * 4);
  }
  return d;
}

export interface LaneFrame { stack: StackEntry[] }
export interface LaneLayout {
  height: number; left: number; plotW: number; rowH: number;
  /** x of each frame. */
  xs: number[];
  /** One lane per part: polyline segments (broken where the part is missing or hidden) and the label y. */
  lanes: { part: string; segs: [number, number][][]; labelY: number }[];
  /** y of the stripe for rank k (k odd lanes are shaded). */
  rankY(rank: number): number;
}

/** Lane chart geometry (rank 0 = bottom of the stack = bottom lane). parts = union of parts over frames. */
export function laneLayout(frames: LaneFrame[], parts: string[], width: number, rowH = 14): LaneLayout {
  const height = Math.max(40, parts.length * rowH + 16);
  const left = 90, plotW = width - left - 10, n = Math.max(1, frames.length);
  const fx = (i: number) => left + (n === 1 ? plotW / 2 : (i / (n - 1)) * plotW);
  const rankY = (rank: number) => height - 10 - rank * rowH;
  const xs = frames.map((_, i) => fx(i));
  const lanes = parts.map((p) => {
    const segs: [number, number][][] = [];
    let cur: [number, number][] | null = null, last: number | null = null;
    frames.forEach((f, i) => {
      const rank = f.stack.findIndex((s) => s.part === p);
      const e = f.stack[rank];
      if (!e || e.hidden) { cur = null; return; }
      const Y = rankY(rank);
      if (!cur) { cur = []; segs.push(cur); }
      cur.push([fx(i), Y]);
      last = Y;
    });
    const r0 = frames[0]?.stack.findIndex((s) => s.part === p) ?? -1;
    return { part: p, segs, labelY: (r0 >= 0 ? rankY(r0) : last ?? 10) + 3 };
  });
  return { height, left, plotW, rowH, xs, lanes, rankY };
}

/** x of the frame marker (same mapping as the lanes). */
export const laneFrameX = (l: LaneLayout, frame: number, n: number): number => l.left + (n <= 1 ? l.plotW / 2 : (frame / (n - 1)) * l.plotW);

/** Frame under a click at x (CSS px from the lanes' left edge); legacy mapping, clamped by the caller. */
export const laneFrameAt = (x: number, width: number, n: number): number => Math.floor(((x - 90) / Math.max(1, width - 100)) * Math.max(1, n));

/** Union of parts over frames, first appearance order. */
export const laneParts = (frames: LaneFrame[]): string[] => [...new Set(frames.flatMap((f) => f.stack.map((s) => s.part)))];

/** Selection: toggle a part, keep at most two (first in, first out). */
export function toggleSel(sel: string[], part: string): string[] {
  const i = sel.indexOf(part);
  if (i >= 0) return sel.filter((p) => p !== part);
  const next = [...sel, part];
  return next.length > 2 ? next.slice(-2) : next;
}

export const flagLabel = (sel: string[]): string => (sel.length === 2 ? `Flag: ${sel[0]} above ${sel[1]}?` : 'Flag layering (select 2)');

/**
 * The review draft for two selected parts. asset = the output canvas of the clip, else the rig (rest pose),
 * or the canvas in canvas mode. frame: the absolute frame on the output canvas (tag frame list), or the frame
 * in canvas mode; none on the rest pose.
 */
export function flagDraft(o: {
  mode: 'rig' | 'canvas'; rig: string | null; canvasName: string | null; sel: string[]; view: string; clip: string; frame: number;
  tagFrames?: (canvas: string, tag: string) => number[] | undefined;
}): ReviewDraft | null {
  if (o.sel.length !== 2) return null;
  const [a, b] = o.sel;
  const i = o.clip.indexOf('/');
  const [canvas, tag] = i < 0 ? [o.clip, ''] : [o.clip.slice(0, i), o.clip.slice(i + 1)];
  const asset = o.mode === 'canvas' ? `canvas:${o.canvasName}` : canvas ? `canvas:${canvas}` : `rig:${o.rig}`;
  const frame = o.mode === 'canvas' || canvas ? (canvas && tag ? o.tagFrames?.(canvas, tag)?.[o.frame] ?? o.frame : o.frame) : undefined;
  const d: ReviewDraft = { asset };
  if (frame !== undefined) d.frame = frame;
  if (o.view) d.view = o.view;
  if (tag) d.tag = tag;
  return { ...d, part: `${a},${b}`, category: 'layering', note: `${a} should be above ${b}`, priority: 'high' };
}

/** Map with at most `limit` calls in flight; results in input order. Rejects on the first failure. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (x: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); } };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, worker));
  return out;
}
