import { describe, expect, it } from 'vitest';
import { diffMask } from './diff';

const img = (w: number, h: number, fill = [10, 20, 30, 255]) => { const d = new Uint8ClampedArray(w * h * 4); for (let i = 0; i < d.length; i += 4) d.set(fill, i); return d; };
const set = (d: Uint8ClampedArray, w: number, x: number, y: number, px: number[]) => d.set(px, (y * w + x) * 4);

describe('diffMask', () => {
  it('identical images', () => {
    const r = diffMask(img(4, 4), img(4, 4), 4, 4);
    expect(r.changed).toBe(0);
    expect(r.bbox).toBeNull();
    expect(r.mask.every((v) => v === 0)).toBe(true);
  });
  it('one changed pixel', () => {
    const a = img(4, 4), b = img(4, 4);
    set(b, 4, 2, 1, [10, 20, 31, 255]);
    const r = diffMask(a, b, 4, 4);
    expect(r.changed).toBe(1);
    expect(r.bbox).toEqual({ x: 2, y: 1, w: 1, h: 1 });
    expect([...r.mask.slice((1 * 4 + 2) * 4, (1 * 4 + 2) * 4 + 4)]).toEqual([0xff, 0x3d, 0xf2, 255]);
  });
  it('alpha-0 pixels with different RGB are equal', () => {
    const r = diffMask(img(2, 2, [1, 2, 3, 0]), img(2, 2, [200, 100, 50, 0]), 2, 2);
    expect(r.changed).toBe(0);
  });
  it('alpha difference counts', () => {
    expect(diffMask(img(1, 1, [1, 2, 3, 255]), img(1, 1, [1, 2, 3, 254]), 1, 1).changed).toBe(1);
  });
  it('bbox of two far-apart changes', () => {
    const a = img(10, 8), b = img(10, 8);
    set(b, 10, 1, 1, [0, 0, 0, 255]);
    set(b, 10, 8, 6, [0, 0, 0, 255]);
    const r = diffMask(a, b, 10, 8);
    expect(r.changed).toBe(2);
    expect(r.bbox).toEqual({ x: 1, y: 1, w: 8, h: 6 });
  });
});
