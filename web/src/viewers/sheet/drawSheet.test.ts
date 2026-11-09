// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CanvasMeta } from '@/lib/api/types';
import { fakeBitmap, installCanvasStub, type StubCtx } from '@/test/canvasStub';
import { ANCHOR_COLORS, anchorColors, autoScale, canvasCells, clampSheetScale, drawSheet, exportCells, layoutCells, sheetSize, type SheetJson } from './drawSheet';

const twoTags = {
  frames: 4, frameHeight: 16,
  animations: { idle: { frames: [0, 1], durations: [100, 120] }, run: { frames: [2, 3], durations: [80, 0] } },
  meta: { anchors: { run: [{ hand: [3, 4, 90] }, { hand: [5, 6], foot: [1, 15] }] } } as CanvasMeta,
};

const fixture: SheetJson = {
  frames: {
    spark_spin_0: { frame: { x: 0, y: 0, w: 16, h: 16 }, duration: 100, anchors: { tip: { x: 8, y: 1, rot: 45 } } },
    spark_spin_1: { frame: { x: 16, y: 0, w: 16, h: 16 }, duration: 100 },
    spark_spin_2: { frame: { x: 0, y: 16, w: 16, h: 16 } },
  },
  meta: { frameTags: [{ name: 'spin' }] },
};

describe('sheet layout', () => {
  it('2-tag canvas: one row per tag, labels, durations, anchors by position in the tag', () => {
    const { cells, rows, anchorNames } = canvasCells(twoTags, 16, 64);
    expect(rows).toBe(2);
    expect(anchorNames).toEqual(['run']);
    expect(cells.map((c) => [c.row, c.col, c.y, c.label, c.sub])).toEqual([
      [0, 0, 0, 'idle #0', '100ms'], [0, 1, 16, 'idle #1', '120ms'], [1, 0, 32, 'run #2', '80ms'], [1, 1, 48, 'run #3', ''],
    ]);
    expect(cells[2].anchors).toEqual({ hand: [3, 4, 90] });
    expect(cells[0].anchors).toBeNull();
    const placed = layoutCells(cells, 2, true, false);
    // dx = 6 + col * (16*2 + 6); dy = 6 + row * (16*2 + 6 + 14)
    expect(placed.map((c) => [c.dx, c.dy])).toEqual([[6, 6], [44, 6], [6, 58], [44, 58]]);
    expect(sheetSize(placed, 2, true)).toEqual({ W: 76, H: 104 });
  });
  it('untagged canvas: one row of all frames', () => {
    const { cells, rows } = canvasCells({ frames: 3, frameHeight: null, animations: {} }, 8, 8);
    expect(rows).toBe(1);
    expect(cells.map((c) => c.label)).toEqual(['#0', '#1', '#2']);
    expect(cells[0].h).toBe(8);
  });
  it('export layout from a fixture JSON; without frames one cell covers the image', () => {
    const src = exportCells(fixture, 'spark.png', 32, 32);
    expect(src.map((c) => [c.x, c.y, c.label, c.sub])).toEqual([[0, 0, 'spark_spin_0', '100ms'], [16, 0, 'spark_spin_1', '100ms'], [0, 16, 'spark_spin_2', '']]);
    expect(src[0].anchors).toEqual({ tip: [8, 1, 45] });
    const placed = layoutCells(src, 2, true, true);
    expect(placed.map((c) => [c.dx, c.dy, c.label])).toEqual([[6, 6, 'spin_0'], [6 + 32 + 6, 6, 'spin_1'], [6, 6 + 32 + 20, 'spin_2']]);
    expect(exportCells(null, 'a.png', 40, 20)).toEqual([{ x: 0, y: 0, w: 40, h: 20, label: 'a.png' }]);
    expect(exportCells({ meta: {} }, 'a.png', 40, 20)).toHaveLength(1);
    const arr = exportCells({ frames: [{ filename: 'x_0', frame: { x: 0, y: 0, w: 4, h: 4 } }] }, 'x.png', 4, 4);
    expect(arr[0].label).toBe('x_0');
  });
  it('auto scale and the canvas limit clamp', () => {
    const { cells } = canvasCells(twoTags, 16, 64);
    expect(autoScale(cells, 400)).toBe(8);       // (400-40) / (2 * 20) = 9 -> max 8
    expect(autoScale(cells, 200)).toBe(4);
    expect(autoScale(cells, 0)).toBe(1);
    expect(autoScale(exportCells(null, 'a', 100, 10), 500)).toBe(4);   // (500-40) / 104
    expect(clampSheetScale(cells, 4, true, false)).toEqual({ scale: 4, clamped: false });
    const many = Array.from({ length: 5000 }, (_, i) => ({ x: 0, y: i * 64, w: 64, h: 64, row: 0, col: i, label: '' }));
    expect(autoScale(many, 1000)).toBe(1);   // no argument-limit overflow
    expect(clampSheetScale(many, 3, false, false)).toEqual({ scale: 1, clamped: true });
    const big = [{ x: 0, y: 0, w: 1000, h: 1000, row: 0, col: 0, label: '' }];
    expect(clampSheetScale(big, 12, true, false)).toEqual({ scale: 5, clamped: true });  // 5*1000+6 = 5006 px; area 5006*5020 < 32e6
  });
  it('anchor colours in first-seen order', () => {
    const { cells } = canvasCells(twoTags, 16, 64);
    expect([...anchorColors(cells)]).toEqual([['hand', ANCHOR_COLORS[0]], ['foot', ANCHOR_COLORS[1]]]);
  });
});

describe('drawSheet', () => {
  beforeEach(() => installCanvasStub());
  afterEach(() => vi.restoreAllMocks());
  it('sizes the canvas, draws every cell, returns the anchor colours', () => {
    const canvas = document.createElement('canvas');
    const { cells } = canvasCells(twoTags, 16, 64);
    const placed = layoutCells(cells, 2, true, false);
    const names = drawSheet(canvas, fakeBitmap(16, 64), placed, { scale: 2 });
    expect([canvas.width, canvas.height]).toEqual([76, 104]);
    expect([...names.keys()]).toEqual(['hand', 'foot']);
    const ctx = canvas.getContext('2d') as unknown as StubCtx;
    expect(ctx.calls.filter((c) => c.fn === 'drawImage')).toHaveLength(4);
    expect(ctx.calls.filter((c) => c.fn === 'fillText').map((c) => c.args[0])).toEqual(['idle #0 · 100ms', 'idle #1 · 120ms', 'run #2 · 80ms', 'run #3']);
    expect(ctx.imageSmoothingEnabled).toBe(false);
    const none = drawSheet(canvas, fakeBitmap(16, 64), placed, { scale: 2, showAnchors: false, labels: false });
    expect(none.size).toBe(0);
  });
});
