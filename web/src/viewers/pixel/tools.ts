// Pure paint-tool maths shared by PixelView (and its tests): zoom ladder, Bresenham, shapes, commands.
import type { DrawCommand } from '@/lib/api/client';
import { clamp } from '@/lib/util/format';

export const ZOOMS = [0.0625, 0.125, 0.25, 0.5, 1, 2, 3, 4, 5, 6, 8, 10, 12, 16, 20, 24, 32, 40, 48, 64];
export type Pt = [number, number];

/** Next ladder step from any zoom (an off-ladder zoom steps to its neighbour in the given direction). */
export function stepZoom(zoom: number, d: 1 | -1): number {
  let i = ZOOMS.findIndex((z) => z >= zoom);
  if (i < 0) i = ZOOMS.length - 1;
  // off the ladder: up goes to the next step at or above, down to the step below
  if (ZOOMS[i] !== zoom) return d > 0 ? ZOOMS[i] : ZOOMS[Math.max(0, zoom > ZOOMS[ZOOMS.length - 1] ? ZOOMS.length - 1 : i - 1)];
  return ZOOMS[clamp(i + d, 0, ZOOMS.length - 1)];
}

/** Largest ladder step that fits w×h (times tiles) into the stage with 32 px padding. */
export function fitZoom(stageW: number, stageH: number, w: number, h: number, tiles = 1, pad = 32): number {
  const z = Math.min((stageW - pad) / (w * tiles), (stageH - pad) / (h * tiles));
  let best = ZOOMS[0];
  for (const s of ZOOMS) if (s <= z) best = s;
  return best;
}

/** Ladder step nearest to z. */
export function snapZoom(z: number): number {
  let best = ZOOMS[0];
  for (const s of ZOOMS) if (Math.abs(Math.log(s / z)) < Math.abs(Math.log(best / z))) best = s;
  return best;
}

export function bresenham(x0: number, y0: number, x1: number, y1: number): Pt[] {
  const pts: Pt[] = [];
  const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  for (;;) {
    pts.push([x0, y0]);
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x0 += sx; }
    if (e2 <= dx) { err += dx; y0 += sy; }
  }
  return pts;
}

/** Rectangle cells: outline, or every cell when filled. */
export function rectPoints(a: Pt, b: Pt, filled: boolean): Pt[] {
  const [x0, x1] = [Math.min(a[0], b[0]), Math.max(a[0], b[0])];
  const [y0, y1] = [Math.min(a[1], b[1]), Math.max(a[1], b[1])];
  const out: Pt[] = [];
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (filled || x === x0 || x === x1 || y === y0 || y === y1) out.push([x, y]);
  return out;
}

/** Normalised region [x, y, w, h] of a drag from a to b (any direction). */
export function normBox(a: Pt, b: Pt): [number, number, number, number] {
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.abs(b[0] - a[0]) + 1, Math.abs(b[1] - a[1]) + 1];
}

/** A review drag: a single cell is a point, else a region. */
export function reviewPick(a: Pt, b: Pt): { point: Pt } | { region: [number, number, number, number] } {
  const r = normBox(a, b);
  return r[2] === 1 && r[3] === 1 ? { point: [r[0], r[1]] } : { region: r };
}

export type ShapeTool = 'line' | 'rect';
/** The command a finished line / rectangle sends. */
export function shapeCommand(tool: ShapeTool, start: Pt, end: Pt, color: string, filled: boolean): DrawCommand {
  if (tool === 'line') return { op: 'line', x1: start[0], y1: start[1], x2: end[0], y2: end[1], color };
  const [x, y, w, h] = normBox(start, end);
  return filled ? { op: 'rect', x, y, w, h, color } : { op: 'rect', x, y, w, h, fill: false, color };
}

/** Pencil / eraser stroke: one pixels command with the joined point set. */
export function strokeCommand(points: Iterable<Pt>, color: string): DrawCommand {
  return { op: 'pixels', color, points: [...points] };
}

/** Extend a free-hand stroke from last to p (Bresenham-joined, deduplicated). */
export function extendStroke(pts: Map<string, Pt>, last: Pt, p: Pt): void {
  for (const q of bresenham(last[0], last[1], p[0], p[1])) pts.set(q.join(','), q);
}
