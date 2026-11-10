// Sprite sheet layout + drawing (pure, unit-tested). Canvas mode: one row per animation tag (or one row
// of all frames). Export mode: frame rects and anchors from an Aseprite-style JSON, at their sheet positions.
import type { AnimTag, CanvasMeta } from '@/lib/api/types';
import { checker } from '@/lib/util/checker';
import { themeColors } from '@/lib/util/dom';

export const ANCHOR_COLORS = ['#f5a524', '#38bdf8', '#22c55e', '#e5484d', '#a78bfa', '#2dd4bf', '#f472b6', '#facc15'];
export const GAP = 6;
export const LABEL_H = 14;
export const MAX_SCALE = 12;
export const MAX_AUTO_SCALE = 8;
export const MAX_SIDE = 8192;
export const MAX_AREA = 32_000_000;

/** anchor name -> [x, y, rotation degrees?] */
export type Anchors = Record<string, number[]>;

/** A frame in the source image; row / col only in canvas mode. */
export interface SrcCell { x: number; y: number; w: number; h: number; row?: number; col?: number; label: string; sub?: string; anchors?: Anchors | null }
/** A frame placed on the sheet canvas (dx, dy in canvas pixels). */
export interface Cell { sx: number; sy: number; w: number; h: number; dx: number; dy: number; label: string; sub?: string; anchors?: Anchors | null }
export interface DrawOpts { scale?: number; showAnchors?: boolean; labels?: boolean }

/** Aseprite-style sheet JSON (only the fields the preview reads). */
export interface SheetJson {
  frames?: Record<string, SheetFrame> | SheetFrame[];
  meta?: { frameTags?: unknown[]; [k: string]: unknown };
}
export interface SheetFrame { frame: { x: number; y: number; w: number; h: number }; duration?: number; anchors?: Record<string, { x: number; y: number; rot?: number }>; filename?: string }

/** Canvas mode cells: one row per tag (anchors from meta.anchors[tag][i]), else one row of all frames. */
export function canvasCells(info: { frames: number; frameHeight: number | null; animations?: Record<string, AnimTag>; meta?: CanvasMeta }, imgW: number, imgH: number): { cells: SrcCell[]; rows: number; anchorNames: string[] } {
  const fh = info.frameHeight || imgH;
  const tags = Object.entries(info.animations || {});
  const anchors = info.meta?.anchors || {};
  const rows = tags.length
    ? tags.map(([n, t]) => ({ n: n as string | null, frames: t.frames, durations: t.durations }))
    : [{ n: null as string | null, frames: [...Array(info.frames).keys()], durations: [] as number[] }];
  const cells: SrcCell[] = [];
  rows.forEach((r, ri) => r.frames.forEach((f, ci) => cells.push({
    x: 0, y: f * fh, w: imgW, h: fh, row: ri, col: ci,
    label: `${r.n ? r.n + ' ' : ''}#${f}`,
    sub: r.durations[ci] ? `${r.durations[ci]}ms` : '',
    anchors: r.n ? anchors[r.n]?.[ci] ?? null : null,
  })));
  return { cells, rows: rows.length, anchorNames: Object.keys(anchors) };
}

/** Export mode cells from the sheet JSON; without frames, one cell covering the image. */
export function exportCells(j: SheetJson | null, png: string, imgW: number, imgH: number): SrcCell[] {
  if (!j?.frames) return [{ x: 0, y: 0, w: imgW, h: imgH, label: png }];
  return Object.entries(j.frames).map(([k, f]) => ({
    ...f.frame,
    label: Array.isArray(j.frames) ? f.filename ?? k : k,
    sub: f.duration ? `${f.duration}ms` : '',
    anchors: f.anchors ? Object.fromEntries(Object.entries(f.anchors).map(([n, a]) => [n, [a.x, a.y, a.rot ?? 0]])) : null,
  }));
}

interface Extent { maxW: number; maxH: number; cols: number; hasCols: boolean }
function extent(src: SrcCell[]): Extent {
  // loops, not Math.max(...arr): thousands of cells overflow the argument limit
  let maxW = 0, maxH = 0, cols = 1;
  for (const c of src) { if (c.w > maxW) maxW = c.w; if (c.h > maxH) maxH = c.h; if ((c.col ?? 0) + 1 > cols) cols = (c.col ?? 0) + 1; }
  return { maxW, maxH, cols, hasCols: src[0]?.col !== undefined };
}

/** Automatic scale 1..8 so a row fits the available width. */
export function autoScale(src: SrcCell[], boxWidth: number): number {
  const e = extent(src);
  const across = e.hasCols ? e.cols : Math.min(src.length, 8);
  const s = Math.floor((boxWidth - 40) / Math.max(1, across * (e.maxW + 4)));
  return Math.max(1, Math.min(MAX_AUTO_SCALE, Number.isFinite(s) ? s : 1));
}

/** Place the cells on the sheet canvas at scale s. */
export function layoutCells(src: SrcCell[], s: number, labels: boolean, exportMode: boolean): Cell[] {
  const e = extent(src);
  const lab = labels ? LABEL_H : 0;
  if (e.hasCols) {
    return src.map((c) => ({ sx: c.x, sy: c.y, w: c.w, h: c.h, dx: GAP + (c.col ?? 0) * (e.maxW * s + GAP), dy: GAP + (c.row ?? 0) * (e.maxH * s + GAP + lab), label: c.label, sub: c.sub, anchors: c.anchors }));
  }
  if (exportMode) {
    return src.map((c) => ({
      sx: c.x, sy: c.y, w: c.w, h: c.h,
      dx: GAP + c.x * s + Math.floor(c.x / Math.max(1, c.w)) * GAP,
      dy: GAP + c.y * s + Math.floor(c.y / Math.max(1, c.h)) * (GAP + lab),
      label: c.label.replace(/^.*?_(\w+_\d+)$/, '$1'), sub: c.sub, anchors: c.anchors,
    }));
  }
  return [];
}

/** Canvas size drawSheet will use for these cells. */
export function sheetSize(cells: Cell[], scale: number, labels: boolean): { W: number; H: number } {
  let W = 0, H = 0;
  for (const c of cells) { W = Math.max(W, c.dx + c.w * scale); H = Math.max(H, c.dy + c.h * scale + (labels ? LABEL_H : 0)); }
  return { W, H };
}

/** Largest scale <= s whose composed sheet stays inside the canvas limits (at least 1). */
export function clampSheetScale(src: SrcCell[], s: number, labels: boolean, exportMode: boolean): { scale: number; clamped: boolean } {
  for (let k = Math.max(1, Math.floor(s)); k >= 1; k--) {
    const { W, H } = sheetSize(layoutCells(src, k, labels, exportMode), k, labels);
    if ((W <= MAX_SIDE && H <= MAX_SIDE && W * H <= MAX_AREA) || k === 1) return { scale: k, clamped: k !== Math.floor(s) };
  }
  return { scale: 1, clamped: s > 1 };
}

/** Colour per anchor name, in first-seen order over the cells. */
export function anchorColors(cells: { anchors?: Anchors | null }[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const c of cells) if (c.anchors) for (const n of Object.keys(c.anchors)) if (!names.has(n)) names.set(n, ANCHOR_COLORS[names.size % ANCHOR_COLORS.length]);
  return names;
}

/** Draw the cells from img at scale onto canvas; returns anchor name -> colour (empty without anchors). */
export function drawSheet(canvas: HTMLCanvasElement, img: CanvasImageSource, cells: Cell[], { scale = 2, showAnchors = true, labels = true }: DrawOpts = {}): Map<string, string> {
  const { W, H } = sheetSize(cells, scale, labels);
  canvas.width = Math.max(1, W); canvas.height = Math.max(1, H);
  const names = new Map<string, string>();
  const cx = canvas.getContext('2d');
  if (!cx) return names;
  const tc = themeColors();   // chrome (background, labels) from the tokens; anchor colours encode data and stay literal
  cx.fillStyle = tc.canvasBg; cx.fillRect(0, 0, W, H);
  cx.imageSmoothingEnabled = false;
  for (const c of cells) {
    checker(cx, c.dx, c.dy, c.w * scale, c.h * scale, Math.max(4, scale * 2));
    cx.drawImage(img, c.sx, c.sy, c.w, c.h, c.dx, c.dy, c.w * scale, c.h * scale);
    cx.strokeStyle = 'rgba(255,255,255,.12)';
    cx.strokeRect(c.dx + 0.5, c.dy + 0.5, c.w * scale - 1, c.h * scale - 1);
    if (labels) {
      cx.fillStyle = tc.muted; cx.font = '10px ui-monospace, monospace';
      cx.fillText(`${c.label}${c.sub ? ' · ' + c.sub : ''}`, c.dx + 1, c.dy + c.h * scale + 11);
    }
    if (showAnchors && c.anchors) for (const [n, a] of Object.entries(c.anchors)) {
      if (!names.has(n)) names.set(n, ANCHOR_COLORS[names.size % ANCHOR_COLORS.length]);
      const col = names.get(n)!;
      const x = c.dx + (a[0] + 0.5) * scale, y = c.dy + (a[1] + 0.5) * scale;
      cx.strokeStyle = col; cx.lineWidth = 1;
      cx.beginPath(); cx.moveTo(x - 3, y); cx.lineTo(x + 3, y); cx.moveTo(x, y - 3); cx.lineTo(x, y + 3); cx.stroke();
      if (a[2]) { const r = (a[2] * Math.PI) / 180; cx.beginPath(); cx.moveTo(x, y); cx.lineTo(x + Math.cos(r) * 8, y + Math.sin(r) * 8); cx.stroke(); }
    }
  }
  return names;
}
