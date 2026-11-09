import { describe, expect, it } from 'vitest';
import { parseHex, pushRecent } from './colorPicker';
import { frameCount, frameLabel, frameRect, gifUrl, hoverText, metaText, onionNeighbours, planChange, zoomText } from './logic';

describe('canvas logic', () => {
  it('frameRect and frameCount', () => {
    expect(frameRect(16, 64, 16, 2, true)).toEqual({ x: 0, y: 32, w: 16, h: 16 });
    expect(frameRect(16, 64, 16, 2, false)).toEqual({ x: 0, y: 0, w: 16, h: 64 });
    expect(frameCount(64, 16)).toBe(4);
    expect(frameCount(24, 24)).toBe(1);
    expect(frameCount(10, 0)).toBe(1);
  });
  it('onion neighbours at the ends', () => {
    expect(onionNeighbours(0, 4, true)).toEqual({ prev: null, next: 1 });
    expect(onionNeighbours(3, 4, true)).toEqual({ prev: 2, next: null });
    expect(onionNeighbours(1, 4, false)).toBeNull();
  });
  it('hover text', () => {
    expect(hoverText(null, null, null, false)).toBe('');
    expect(hoverText([1, 2], { hex: '#ff0000', a: 255 }, null, false)).toBe('x 1  y 2  #ff0000');
    expect(hoverText([1, 20], { hex: '#00000000', a: 0 }, 16, false)).toBe('x 1  y 20  frame 1 (y 4)  transparent');
    expect(hoverText([1, 2], null, 16, true)).toBe('x 1  y 2  transparent');
  });
  it('meta line', () => {
    expect(metaText({ name: 'a', width: 16, height: 64, frames: 4, frameHeight: 16, colors: { unique: 5 }, undo: 2 }, false)).toBe('a · 16×16 × 4 frames · 5 colours · undo 2');
    expect(metaText({ name: 'a', width: 8, height: 8, frames: 1, frameHeight: null }, true)).toBe('a · 8×8 · read-only snapshot');
  });
  it('GIF URL per tag, zoom and frame labels', () => {
    expect(gifUrl('spark', '')).toBe('/api/canvas/spark/anim.gif?scale=4&download=1');
    expect(gifUrl('spark', 'spin up')).toBe('/api/canvas/spark/anim.gif?scale=4&download=1&animation=spin%20up');
    expect(zoomText(8)).toBe('8×');
    expect(zoomText(0.25)).toBe('1/4');
    expect(frameLabel(2, 4, true)).toBe('2 / 3');
    expect(frameLabel(2, 4, false)).toBe('4 frames');
  });

  describe('planChange', () => {
    const base = { name: 'c', snap: false, frameMode: true, frameHeight: 16, frame: 0, following: true };
    const change = (o: object) => ({ type: 'change', canvas: 'c', source: 'agent', op: 'draw', version: 2, ts: 1, ...o });
    it('other canvases and snapshots are ignored', () => {
      expect(planChange(change({ canvas: 'x' }), base).reload).toBe(false);
      expect(planChange(change({}), { ...base, snap: true }).reload).toBe(false);
    });
    it('follow jumps to the changed frame and flashes it in frame coordinates', () => {
      expect(planChange(change({ dirty: { x: 1, y: 33, w: 2, h: 2 } }), base)).toEqual({ flashRect: { x: 1, y: 1, w: 2, h: 2 }, jumpToFrame: 2, thumbFlash: 2, refit: false, reload: true, deleted: false });
    });
    it('without follow: no jump, no flash on another frame, thumb flashes', () => {
      const p = planChange(change({ dirty: { x: 1, y: 33, w: 2, h: 2 } }), { ...base, following: false });
      expect(p.jumpToFrame).toBeNull();
      expect(p.flashRect).toBeNull();
      expect(p.thumbFlash).toBe(2);
    });
    it('a dirty rect spanning frames does not jump', () => {
      expect(planChange(change({ dirty: { x: 0, y: 10, w: 2, h: 10 } }), base).jumpToFrame).toBeNull();
    });
    it('strip mode flashes the whole-strip rect; user edits do not flash', () => {
      expect(planChange(change({ dirty: { x: 0, y: 40, w: 1, h: 1 } }), { ...base, frameMode: false }).flashRect).toEqual({ x: 0, y: 40, w: 1, h: 1 });
      expect(planChange(change({ source: 'user', dirty: { x: 0, y: 0, w: 1, h: 1 } }), base).flashRect).toBeNull();
    });
    it('transform refits; deleted; resync reloads', () => {
      expect(planChange(change({ op: 'transform' }), base).refit).toBe(true);
      expect(planChange({ type: 'deleted', canvas: 'c', source: 'agent', ts: 1 }, base).deleted).toBe(true);
      expect(planChange({ type: 'resync' }, base).reload).toBe(true);
    });
  });
});

describe('colour picker helpers', () => {
  it('parseHex', () => {
    expect(parseHex('#abc')).toBe('#aabbccff');
    expect(parseHex('ABCDEF')).toBe('#abcdefff');
    expect(parseHex(' #ff000080 ')).toBe('#ff000080');
    expect(parseHex('#ff00')).toBeNull();
    expect(parseHex('zzzzzz')).toBeNull();
    expect(parseHex('')).toBeNull();
  });
  it('pushRecent dedupes, newest first, capped', () => {
    expect(pushRecent(['#aaaaaaff', '#bbbbbbff'], '#BBBBBBFF')).toEqual(['#bbbbbbff', '#aaaaaaff']);
    const many = Array.from({ length: 12 }, (_, i) => `#0000${String(i).padStart(2, '0')}ff`);
    const r = pushRecent(many, '#ffffffff');
    expect(r.length).toBe(12);
    expect(r[0]).toBe('#ffffffff');
    expect(r).not.toContain(many[11]);
  });
});
