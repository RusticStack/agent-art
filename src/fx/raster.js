// Combat-FX raster core: float fields (emission + matter density + light) splatted by seeded
// particles, resolved to crisp pixels through hue-shifted ramps with ordered (Bayer) dithering.
// Every pixel colour comes from a ramp entry, so a palette lock (ramps snapped to the project
// palette) keeps the whole sheet on-palette. Alpha is always 0 or 255 (1-bit, Roblox-safe).
import { bayer, hash3, mulberry32 } from '../util.js';
import { hslToRgb, makeRamp } from '../color.js';
import { seedOf, hexRGB, toHex, clamp01, MAX_TEX, texLimit } from '../space/noise.js';

export { seedOf, hexRGB, toHex, clamp01, MAX_TEX, texLimit, mulberry32, hash3, bayer };
export const lerp = (a, b, t) => a + (b - a) * t;
export const smooth01 = (t) => { t = clamp01(t); return t * t * (3 - 2 * t); };
export const frac = (v) => v - Math.floor(v);

// ---------- ramps ----------
/** Emission ramp, dark -> core: hue drifts warm (+) toward the core, lightness rises, saturation drops at white. */
export function heatRamp(hue, { steps = 6, drift = 38, sat = 1, core = true } = {}) {
  const out = [];
  for (let i = 0; i < steps; i++) {
    const t = steps === 1 ? 1 : i / (steps - 1);
    const h = hue - drift * 0.6 + drift * t, l = 0.22 + 0.62 * t + (core && i === steps - 1 ? 0.12 : 0), s = sat * (1 - 0.55 * t * t);
    out.push(hslToRgb(h, s, Math.min(0.97, l)));
  }
  return out;
}
/** Matter ramp (smoke, dust, debris, liquid), shadow -> light: color.js makeRamp (shadows cool, lights warm). */
export function matterRamp(base, { steps = 4, spread = 0.5, hueShift = 16 } = {}) {
  return makeRamp(base, { steps, spread, hueShift }).map(hexRGB);
}
/** Snap every ramp colour to the nearest palette colour (luma-weighted), keeping ramp order. */
export function lockRamp(ramp, pal) {
  if (!pal || !pal.length) return ramp;
  return ramp.map((c) => {
    let best = pal[0], bd = Infinity;
    for (const p of pal) { const e = (p[0] - c[0]) ** 2 * 0.3 + (p[1] - c[1]) ** 2 * 0.59 + (p[2] - c[2]) ** 2 * 0.11; if (e < bd) { bd = e; best = p; } }
    return best.slice(0, 3);
  });
}
const pick = (ramp, t, x, y) => {
  const n = ramp.length, p = clamp01(t) * (n - 1);
  let i = Math.floor(p);
  if (p - i > bayer(x, y)) i++;
  return ramp[Math.min(n - 1, i)];
};

// ---------- fields ----------
/** One frame of fields. E = emission (0..1+), D = matter density, L = density-weighted light, M = matter ramp id. */
export function fields(W, H) {
  const n = W * H;
  return { W, H, E: new Float32Array(n), EK: new Uint8Array(n), D: new Float32Array(n), L: new Float32Array(n), M: new Uint8Array(n), MD: new Float32Array(n) };
}
const inb = (F, x, y) => x >= 0 && y >= 0 && x < F.W && y < F.H;
/** Add emission v at pixel (ramp k: 0 = main emission ramp, 1 = secondary). */
export function emit(F, x, y, v, k = 0) {
  x = Math.floor(x); y = Math.floor(y);
  if (!inb(F, x, y) || !(v > 0)) return;
  const i = y * F.W + x;
  if (k !== F.EK[i] && v > F.E[i]) F.EK[i] = k;
  F.E[i] += v;
}
/** Add matter density d with light l (0 shadow .. 1 lit) using ramp m. */
export function matter(F, x, y, d, l, m = 0) {
  x = Math.floor(x); y = Math.floor(y);
  if (!inb(F, x, y) || !(d > 0)) return;
  const i = y * F.W + x;
  F.D[i] += d; F.L[i] += d * l;
  if (d >= F.MD[i]) { F.MD[i] = d; F.M[i] = m; }
}
/** Soft emissive disc (radius r px, falloff power p). Radius below 0.7 px still lights one pixel. */
export function glow(F, cx, cy, r, v, { p = 1.5, k = 0 } = {}) {
  if (r < 0.7) { emit(F, cx, cy, v, k); return; }
  const x0 = Math.floor(cx - r), x1 = Math.ceil(cx + r), y0 = Math.floor(cy - r), y1 = Math.ceil(cy + r);
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy) / r;
    if (d < 1) emit(F, x, y, v * Math.pow(1 - d, p), k);
  }
}
/** Lit spherical puff (smoke, dust, mist): density falls off to the rim, lit from `light` (unit 2D, screen). */
export function puff(F, cx, cy, r, d, { m = 0, light = [-0.55, -0.83], under = 0, lift = 0.15 } = {}) {
  if (r < 0.7) { matter(F, cx, cy, d, 0.6, m); return; }
  const x0 = Math.floor(cx - r), x1 = Math.ceil(cx + r), y0 = Math.floor(cy - r), y1 = Math.ceil(cy + r);
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const nx = (x + 0.5 - cx) / r, ny = (y + 0.5 - cy) / r, q = nx * nx + ny * ny;
    if (q >= 1) continue;
    const nz = Math.sqrt(1 - q), lit = clamp01(0.5 + 0.5 * (nx * light[0] + ny * light[1]) + nz * lift) * (1 - under) + under * clamp01(ny * 0.5 + 0.5);
    matter(F, x, y, d * (1 - q * q), lit, m);
  }
}
/** Emissive line from (x0,y0) to (x1,y1): width w px, value v0 at the start -> v1 at the end. */
export function streak(F, x0, y0, x1, y1, w, v0, v1 = v0, k = 0) {
  const len = Math.hypot(x1 - x0, y1 - y0), n = Math.max(1, Math.ceil(len * 1.5));
  for (let s = 0; s <= n; s++) {
    const t = s / n, x = lerp(x0, x1, t), y = lerp(y0, y1, t), v = lerp(v0, v1, t);
    if (w <= 1.2) emit(F, x, y, v / 1.5, k);
    else glow(F, x, y, w / 2, v / 1.5, { p: 0.8, k });
  }
}
/** Matter line (chips trails, liquid strands). */
export function mline(F, x0, y0, x1, y1, d, l, m = 0) {
  const len = Math.hypot(x1 - x0, y1 - y0), n = Math.max(1, Math.ceil(len * 1.5));
  for (let s = 0; s <= n; s++) { const t = s / n; matter(F, lerp(x0, x1, t), lerp(y0, y1, t), d / 1.5, l, m); }
}
/** Emissive ring (radius r, width w). */
export function ring(F, cx, cy, r, w, v, { k = 0, sx = 1, sy = 1, mask = null } = {}) {
  const R = r + w, x0 = Math.floor(cx - R * sx), x1 = Math.ceil(cx + R * sx), y0 = Math.floor(cy - R * sy), y1 = Math.ceil(cy + R * sy);
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const dx = (x + 0.5 - cx) / sx, dy = (y + 0.5 - cy) / sy, d = Math.hypot(dx, dy), e = 1 - Math.abs(d - r) / w;
    if (e > 0) emit(F, x, y, v * e * (mask ? mask(dx, dy) : 1), k);
  }
}
/** Filled polygon (matter or emission) by even-odd scanline. pts = [[x,y]...]. */
export function poly(F, pts, fn) {
  const ys = pts.map((p) => p[1]), y0 = Math.floor(Math.min(...ys)), y1 = Math.ceil(Math.max(...ys));
  for (let y = y0; y <= y1; y++) {
    const yc = y + 0.5, xs = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      if ((a[1] <= yc) !== (b[1] <= yc)) xs.push(a[0] + ((yc - a[1]) / (b[1] - a[1])) * (b[0] - a[0]));
    }
    xs.sort((p, q) => p - q);
    for (let i = 0; i + 1 < xs.length; i += 2) for (let x = Math.round(xs[i]); x < Math.round(xs[i + 1]); x++) fn(x, y);
  }
}
/** Jagged midpoint-displaced polyline (arcs, cracks) -> points. */
export function bolt(r, x0, y0, x1, y1, { iters = 4, jitter = 0.35 } = {}) {
  let pts = [[x0, y0], [x1, y1]];
  for (let it = 0; it < iters; it++) {
    const nx = [pts[0]];
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i], len = Math.hypot(b[0] - a[0], b[1] - a[1]), px = -(b[1] - a[1]) / (len || 1), py = (b[0] - a[0]) / (len || 1), o = (r() - 0.5) * len * jitter;
      nx.push([(a[0] + b[0]) / 2 + px * o, (a[1] + b[1]) / 2 + py * o], b);
    }
    pts = nx;
  }
  return pts;
}

// ---------- resolve ----------
/**
 * Fields -> RGBA. blend: additive | alpha | premultiplied. ramps: {E:[main, secondary?], M:[ramp per matter id]}.
 * cut = emission threshold (dithered). Emission wins over matter; in premultiplied sheets a glow pixel
 * with no matter under it gets alpha 0 (pure additive), everything else alpha 255.
 */
export function resolve(F, ramps, { blend = 'additive', cut = 0.1, mcut = 0.12, gain = 1 } = {}) {
  const { W, H } = F, out = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x, o = i * 4, th = bayer(x, y), e = F.E[i] * gain, d = F.D[i];
    const md = d > mcut * (0.35 + 1.3 * th);
    if (e > cut * (0.35 + 1.3 * th)) {
      const ramp = ramps.E[F.EK[i]] || ramps.E[0], c = pick(ramp, (e - cut) / (1 - cut), x, y);
      out[o] = c[0]; out[o + 1] = c[1]; out[o + 2] = c[2]; out[o + 3] = blend === 'premultiplied' && !md ? 0 : 255;
    } else if (md) {
      const ramp = ramps.M[F.M[i]] || ramps.M[0], c = pick(ramp, F.L[i] / d, x, y);
      out[o] = c[0]; out[o + 1] = c[1]; out[o + 2] = c[2]; out[o + 3] = 255;
    }
  }
  return out;
}

// ---------- sheets ----------
/** Roblox-friendly square grid for n frames: 1, 2x2, 4x4, 8x8 (cells padded empty when n < g*g). */
export function gridFor(n, cw, ch) {
  const sq = cw === ch;
  let g = n <= 1 ? 1 : n <= 4 ? 2 : n <= 16 ? 4 : n <= 64 ? 8 : 0;
  if (!g) throw new Error(`${n} frames: at most 64 per sheet (Roblox flipbooks are 2x2, 4x4 or 8x8)`);
  if (!sq) { const cols = Math.max(1, Math.min(n, Math.floor(MAX_TEX / cw))); return { cols, rows: Math.ceil(n / cols), roblox: null }; }
  return { cols: g, rows: g, roblox: n === g * g ? `Grid${g}x${g}` : null, padded: g * g - n };
}
/** Lay frames (RGBA arrays of cw x ch) into one sheet <= 1024 px. */
export function packSheet(frames, cw, ch) {
  const G = gridFor(frames.length, cw, ch), W = G.cols * cw, H = G.rows * ch;
  texLimit(W, H, `fx sheet (${frames.length} frames of ${cw}x${ch})`);
  const data = new Uint8ClampedArray(W * H * 4);
  frames.forEach((f, k) => {
    const ox = (k % G.cols) * cw, oy = Math.floor(k / G.cols) * ch;
    for (let y = 0; y < ch; y++) data.set(f.subarray(y * cw * 4, (y + 1) * cw * 4), ((oy + y) * W + ox) * 4);
  });
  return { width: W, height: H, data, grid: G };
}
/** Composite one effect frame over a backdrop the way the engine draws it (preview only). */
export function compositeOver(bg, fr, blend, x0 = 0, y0 = 0, fw = null) {
  const W = bg.width, w = fw ?? fr.width, h = fr.data.length / 4 / w;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const X = x0 + x, Y = y0 + y;
    if (X < 0 || Y < 0 || X >= W || Y >= bg.height) continue;
    const s = (y * w + x) * 4, o = (Y * W + X) * 4, a = fr.data[s + 3];
    const r = fr.data[s], g = fr.data[s + 1], b = fr.data[s + 2];
    if (!a && !(r | g | b)) continue;
    if (blend === 'additive' || (blend === 'premultiplied' && !a)) { bg.data[o] = Math.min(255, bg.data[o] + r); bg.data[o + 1] = Math.min(255, bg.data[o + 1] + g); bg.data[o + 2] = Math.min(255, bg.data[o + 2] + b); }
    else if (a) { bg.data[o] = r; bg.data[o + 1] = g; bg.data[o + 2] = b; }
    bg.data[o + 3] = 255;
  }
  return bg;
}
export function backdrop(W, H, c = [26, 28, 34]) {
  const data = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < data.length; i += 4) { data[i] = c[0]; data[i + 1] = c[1]; data[i + 2] = c[2]; data[i + 3] = 255; }
  return { width: W, height: H, data };
}
/** Tangent-space normal map from a height field (0..1), clamped at the cell edge. strength = px of relief. */
export function normalFromHeight(h, W, H, strength = 2) {
  const out = new Uint8ClampedArray(W * H * 4), at = (x, y) => h[Math.min(H - 1, Math.max(0, y)) * W + Math.min(W - 1, Math.max(0, x))];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const dx = (at(x + 1, y) - at(x - 1, y)) * strength, dy = (at(x, y + 1) - at(x, y - 1)) * strength, l = Math.hypot(dx, dy, 1), o = (y * W + x) * 4;
    out[o] = Math.round(((-dx / l) * 0.5 + 0.5) * 255); out[o + 1] = Math.round(((dy / l) * 0.5 + 0.5) * 255); out[o + 2] = Math.round(((1 / l) * 0.5 + 0.5) * 255); out[o + 3] = 255;
  }
  return out;
}
/** Mean absolute RGBA difference between two frames (0..255). */
export function frameDiff(a, b) { let s = 0; for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]); return s / a.length; }
/** Distinct opaque-or-glow colours of a set of RGBA arrays -> ['#rrggbb'...]. */
export function colorsOf(list) {
  const set = new Set();
  for (const d of list) for (let i = 0; i < d.length; i += 4) if (d[i + 3] || d[i] || d[i + 1] || d[i + 2]) set.add((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]);
  return [...set].sort((a, b) => a - b).map((v) => '#' + v.toString(16).padStart(6, '0'));
}
