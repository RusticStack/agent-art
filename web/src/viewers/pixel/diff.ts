// Pixel difference of two equally sized RGBA buffers (compare overlay, "diff" mode).
import type { Rect } from '@/lib/api/types';

export const DIFF_COLOR: [number, number, number] = [0xff, 0x3d, 0xf2];

/** Exact RGBA comparison; two pixels with alpha 0 are equal whatever their RGB. Mask is magenta where different. */
export function diffMask(a: Uint8ClampedArray, b: Uint8ClampedArray, w: number, h: number): { mask: Uint8ClampedArray; changed: number; bbox: Rect | null } {
  const mask = new Uint8ClampedArray(w * h * 4);
  let changed = 0, x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const aa = a[i + 3], ba = b[i + 3];
      const same = aa === 0 && ba === 0 ? true : a[i] === b[i] && a[i + 1] === b[i + 1] && a[i + 2] === b[i + 2] && aa === ba;
      if (same) continue;
      changed++;
      mask[i] = DIFF_COLOR[0]; mask[i + 1] = DIFF_COLOR[1]; mask[i + 2] = DIFF_COLOR[2]; mask[i + 3] = 255;
      if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y;
    }
  }
  return { mask, changed, bbox: changed ? { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 } : null };
}
