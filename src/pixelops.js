// Pixel-art-safe resampling: Scale2x/Scale3x (EPX family) upscaling and RotSprite-style
// rotation. Neither invents new colors, so palettes and clean edges survive.

const same = (d, i, j) => d[i] === d[j] && d[i + 1] === d[j + 1] && d[i + 2] === d[j + 2] && d[i + 3] === d[j + 3];

/** Scale2x (AdvMAME2x). RGBA in -> RGBA out (2w x 2h). */
export function scale2x(src, w, h) {
  const W = w * 2, out = new Uint8ClampedArray(W * h * 2 * 4);
  const at = (x, y) => (Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))) * 4;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const P = at(x, y), A = at(x, y - 1), B = at(x + 1, y), C = at(x - 1, y), D = at(x, y + 1);
    let e0 = P, e1 = P, e2 = P, e3 = P;
    if (!same(src, C, B) && !same(src, A, D)) {
      if (same(src, C, A)) e0 = A;
      if (same(src, A, B)) e1 = B;
      if (same(src, D, C)) e2 = C;
      if (same(src, B, D)) e3 = D;
    }
    const o = ((y * 2) * W + x * 2) * 4;
    out.set(src.subarray(e0, e0 + 4), o);
    out.set(src.subarray(e1, e1 + 4), o + 4);
    out.set(src.subarray(e2, e2 + 4), o + W * 4);
    out.set(src.subarray(e3, e3 + 4), o + W * 4 + 4);
  }
  return out;
}

/** Scale3x (AdvMAME3x). */
export function scale3x(src, w, h) {
  const W = w * 3, out = new Uint8ClampedArray(W * h * 3 * 4);
  const at = (x, y) => (Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))) * 4;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const A = at(x - 1, y - 1), B = at(x, y - 1), C = at(x + 1, y - 1), D = at(x - 1, y), E = at(x, y), F = at(x + 1, y), G = at(x - 1, y + 1), H = at(x, y + 1), I = at(x + 1, y + 1);
    const e = Array(9).fill(E);
    if (!same(src, B, H) && !same(src, D, F)) {
      e[0] = same(src, D, B) ? D : E;
      e[1] = (same(src, D, B) && !same(src, E, C)) || (same(src, B, F) && !same(src, E, A)) ? B : E;
      e[2] = same(src, B, F) ? F : E;
      e[3] = (same(src, D, B) && !same(src, E, G)) || (same(src, D, H) && !same(src, E, A)) ? D : E;
      e[5] = (same(src, B, F) && !same(src, E, I)) || (same(src, H, F) && !same(src, E, C)) ? F : E;
      e[6] = same(src, D, H) ? D : E;
      e[7] = (same(src, D, H) && !same(src, E, I)) || (same(src, H, F) && !same(src, E, G)) ? H : E;
      e[8] = same(src, H, F) ? F : E;
    }
    for (let k = 0; k < 9; k++) {
      const o = ((y * 3 + Math.floor(k / 3)) * W + x * 3 + (k % 3)) * 4;
      out.set(src.subarray(e[k], e[k] + 4), o);
    }
  }
  return out;
}

/** Upscale by factor 2, 3, 4 (2x2), 6 (2x3), 8 (2x2x2) with EPX smoothing. */
export function upscale(src, w, h, factor) {
  const steps = { 2: [2], 3: [3], 4: [2, 2], 6: [2, 3], 8: [2, 2, 2] }[factor];
  if (!steps) throw new Error('scale2x/scale3x upscaling supports factor 2, 3, 4, 6 or 8');
  let d = src, cw = w, ch = h;
  for (const s of steps) {
    d = s === 2 ? scale2x(d, cw, ch) : scale3x(d, cw, ch);
    cw *= s; ch *= s;
  }
  return { data: d, width: cw, height: ch };
}

/**
 * RotSprite-style rotation of an RGBA block (w x h) by `deg` around (cx, cy) (block coords,
 * default centre). Upscales 8x with Scale2x, rotates with nearest sampling, samples back down.
 * Returns a w x h RGBA block (pixels rotated outside the block are lost — leave margin).
 */
export function rotsprite(src, w, h, deg, cx = w / 2, cy = h / 2) {
  const k = 8;
  const big = upscale(src, w, h, k);
  const BW = big.width, BH = big.height;
  const rad = (-deg * Math.PI) / 180; // inverse mapping
  const cos = Math.cos(rad), sin = Math.sin(rad);
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    // sample the centre of the destination pixel in the 8x space
    const dx = (x + 0.5 - cx) * k, dy = (y + 0.5 - cy) * k;
    const sx = Math.floor(cx * k + dx * cos - dy * sin), sy = Math.floor(cy * k + dx * sin + dy * cos);
    if (sx < 0 || sy < 0 || sx >= BW || sy >= BH) continue;
    const s = (sy * BW + sx) * 4;
    out.set(big.data.subarray(s, s + 4), (y * w + x) * 4);
  }
  return out;
}
