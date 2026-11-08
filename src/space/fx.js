// Space effect sprites as pixel art (RGBA, meant for additive or alpha planes): sun disc + corona,
// lens-flare element sheet, debris cloud card, dust-storm card frames, lightning-storm frames.
import { mulberry32, bayer } from '../util.js';
import { seedOf, hexRGB, clamp01, smoothstep, texLimit } from './noise.js';
import { tileFbm } from './tiles.js';

const img = (W, H) => ({ width: W, height: H, data: new Uint8ClampedArray(W * H * 4) });
const put = (im, x, y, c, a) => {
  if (x < 0 || y < 0 || x >= im.width || y >= im.height || a <= 0) return;
  const o = (y * im.width + x) * 4, da = im.data[o + 3] / 255, oa = a + da * (1 - a);
  for (let k = 0; k < 3; k++) im.data[o + k] = (c[k] * a + im.data[o + k] * da * (1 - a)) / oa;
  im.data[o + 3] = oa * 255;
};
const steps = (v, n, x, y, dither = true) => Math.min(1, Math.floor(v * n + (dither ? bayer(x, y) : 0.5)) / n);

/** Star classes -> colour (original scale, not a real catalogue). */
export const SUN_COLORS = { white: '#f4f6ff', yellow: '#fff1c4', orange: '#ffc27a', red: '#ff8a5a', blue: '#b8d0ff' };

/** Sun sprite: hard disc + banded corona + 4 or 6 spikes. */
export function sunSprite({ size = 256, color = 'yellow', spikes = 4, seed = 1 } = {}) {
  texLimit(size, size, 'sun');
  const c = hexRGB(SUN_COLORS[color] ?? color), im = img(size, size), R = size / 2, core = size * 0.11, r = mulberry32(seedOf(seed, 401));
  const rays = Array.from({ length: 24 }, () => 0.6 + r() * 0.8);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const dx = x + 0.5 - R, dy = y + 0.5 - R, d = Math.hypot(dx, dy), a = Math.atan2(dy, dx);
    let v = d < core ? 1 : Math.pow(core / d, 1.6) * 0.9;
    v *= 0.85 + 0.15 * rays[Math.floor(((a + Math.PI) / (2 * Math.PI)) * 24) % 24];
    for (let k = 0; k < spikes; k++) {
      const ang = (k / spikes) * Math.PI, along = Math.abs(dx * Math.cos(ang) + dy * Math.sin(ang)), across = Math.abs(-dx * Math.sin(ang) + dy * Math.cos(ang));
      if (across < 1.2) v = Math.max(v, (1 - along / R) * 0.8);
    }
    v *= smoothstep(R, R * 0.8, d);
    const q = d < core ? 1 : steps(clamp01(v), 6, x, y);
    if (q > 0) put(im, x, y, d < core * 0.75 ? [255, 255, 255] : c, q);
  }
  return im;
}

/** Lens-flare elements in one sheet (cells: glow disc, ring, hex ghost, anamorphic streak). */
export function flareSheet({ cell = 64, color = '#a8c8ff' } = {}) {
  const c = hexRGB(color), W = cell * 4, im = img(W, cell), R = cell / 2;
  for (let k = 0; k < 4; k++) for (let y = 0; y < cell; y++) for (let x = 0; x < cell; x++) {
    const dx = x + 0.5 - R, dy = y + 0.5 - R, d = Math.hypot(dx, dy) / R;
    let v = 0;
    if (k === 0) v = Math.pow(clamp01(1 - d), 2);
    else if (k === 1) v = Math.exp(-(((d - 0.8) / 0.06) ** 2)) * 0.8;
    else if (k === 2) { const a = Math.atan2(dy, dx), hex = Math.cos(Math.PI / 6) / Math.cos(((a % (Math.PI / 3)) + Math.PI / 3) % (Math.PI / 3) - Math.PI / 6); v = d < hex * 0.85 ? 0.35 + 0.25 * (d / hex) : 0; }
    else v = Math.exp(-((dy / (cell * 0.04)) ** 2)) * clamp01(1 - Math.abs(dx) / R);
    const q = steps(v, 5, x, y);
    if (q > 0) put(im, k * cell + x, y, c, q);
  }
  return { ...im, cells: ['glow', 'ring', 'hex', 'streak'], cell };
}

/** Debris cloud card: tileable scattered chunky specks (dark rock, lit rims). */
export function debrisCard({ size = 256, seed = 1, colors = ['#3a3236', '#5a4e4a', '#8a7a6a'] } = {}) {
  texLimit(size, size, 'debris');
  const im = img(size, size), r = mulberry32(seedOf(seed, 411)), cs = colors.map(hexRGB);
  const n = Math.round(size * size * 0.004);
  for (let i = 0; i < n; i++) {
    const cx = r() * size, cy = r() * size, s = 1 + Math.floor(Math.pow(r(), 3) * 5);
    for (let y = -s; y <= s; y++) for (let x = -s; x <= s; x++) {
      if (Math.abs(x) + Math.abs(y) * (0.6 + r() * 0.8) > s) continue;
      const lit = x + y < -s * 0.4 ? 2 : x + y > s * 0.4 ? 0 : 1;
      put(im, ((Math.round(cx + x) % size) + size) % size, ((Math.round(cy + y) % size) + size) % size, cs[lit], 1);
    }
  }
  return im;
}

/** Dust-storm card frames (tileable fbm alpha, drifting): sheet of `frames` cells side by side. */
export function dustStorm({ size = 256, frames = 4, seed = 1, color = '#c89a6a' } = {}) {
  texLimit(size * frames, size, 'dust storm sheet');
  const im = img(size * frames, size), c = hexRGB(color), f1 = tileFbm(seedOf(seed, 421), size, 3, 4), f2 = tileFbm(seedOf(seed, 422), size, 5, 3);
  for (let k = 0; k < frames; k++) {
    const sh = Math.round((k / frames) * size);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const v = f1((x + sh) % size, y) * 0.7 + f2((x + sh * 2) % size, (y + sh) % size) * 0.5 - 0.35;
      const q = steps(clamp01(v * 1.4), 5, x, y) * 0.8;
      if (q > 0) put(im, k * size + x, y, c.map((cv) => cv * (0.75 + 0.25 * q)), q);
    }
  }
  return { ...im, frames, cell: size };
}

/** Lightning frames: branching bolts by midpoint displacement + 1 px glow; sheet of `frames` cells. */
export function lightning({ size = 128, frames = 4, seed = 1, color = '#c8b8ff' } = {}) {
  texLimit(size * frames, size, 'lightning sheet');
  const im = img(size * frames, size), c = hexRGB(color), r = mulberry32(seedOf(seed, 431));
  const bolt = (ox, x0, y0, x1, y1, depth, w) => {
    const pts = [[x0, y0], [x1, y1]];
    for (let it = 0; it < 6; it++) {
      for (let i = pts.length - 1; i > 0; i--) {
        const a = pts[i - 1], b = pts[i], len = Math.hypot(b[0] - a[0], b[1] - a[1]);
        pts.splice(i, 0, [(a[0] + b[0]) / 2 + (r() - 0.5) * len * 0.45, (a[1] + b[1]) / 2 + (r() - 0.5) * len * 0.15]);
      }
    }
    for (let i = 1; i < pts.length; i++) {
      const [ax, ay] = pts[i - 1], [bx, by] = pts[i], n = Math.ceil(Math.hypot(bx - ax, by - ay));
      for (let s = 0; s <= n; s++) {
        const x = Math.round(ax + ((bx - ax) * s) / (n || 1)), y = Math.round(ay + ((by - ay) * s) / (n || 1));
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) put(im, ox + Math.max(0, Math.min(size - 1, x + dx)), y + dy, c, 0.35 * w);
        put(im, ox + Math.max(0, Math.min(size - 1, x)), y, [255, 255, 255], w);
      }
      if (depth > 0 && r() < 0.06) { const ang = (r() - 0.5) * 1.6; bolt(ox, bx, by, bx + Math.sin(ang) * size * 0.3, by + Math.cos(ang) * size * 0.3, depth - 1, w * 0.7); }
    }
  };
  for (let k = 0; k < frames; k++) bolt(k * size, size * (0.3 + r() * 0.4), 0, size * (0.2 + r() * 0.6), size - 1, 2, k === frames - 1 ? 0.5 : 1);
  return { ...im, frames, cell: size };
}
