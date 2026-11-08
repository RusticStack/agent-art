// Seeded 3D noise, sphere projections and pixel-art helpers for the planet / space generators.
// Everything is a pure function of (seed, direction), so cube faces, equirect maps, quadtree tiles,
// ground patches and their LODs all sample the same field: seams line up by construction.
import { mulberry32, bayer } from '../util.js';

// ---------- seeds ----------
/** 32-bit seed from any number / string, plus a salt (independent channels from one seed). */
export function seedOf(seed, salt = 0) {
  let h = 0x811c9dc5 ^ (salt * 0x9e3779b1);
  const s = String(seed ?? 0);
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); h ^= h >>> 12; h = Math.imul(h, 0x297a2d39); h ^= h >>> 15;
  return h >>> 0;
}

// ---------- gradient noise ----------
const GX = [1, -1, 1, -1, 1, -1, 1, -1, 0, 0, 0, 0], GY = [1, 1, -1, -1, 0, 0, 0, 0, 1, -1, 1, -1], GZ = [0, 0, 0, 0, 1, 1, -1, -1, 1, 1, -1, -1];
const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
/** Improved Perlin noise with a seeded permutation: (x, y, z) -> about -1..1. */
export function perlin3(seed) {
  const r = mulberry32(seedOf(seed, 17));
  const p = new Uint8Array(512), g = new Uint8Array(512);
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) { const j = Math.floor(r() * (i + 1)); const t = p[i]; p[i] = p[j]; p[j] = t; }
  for (let i = 0; i < 512; i++) { p[i] = p[i & 255]; g[i] = p[i] % 12; }
  const gd = (h, x, y, z) => GX[h] * x + GY[h] * y + GZ[h] * z;
  return (x, y, z) => {
    const fx = Math.floor(x), fy = Math.floor(y), fz = Math.floor(z);
    const X = fx & 255, Y = fy & 255, Z = fz & 255;
    x -= fx; y -= fy; z -= fz;
    const u = fade(x), v = fade(y), w = fade(z);
    const A = p[X] + Y, AA = p[A] + Z, AB = p[A + 1] + Z, B = p[X + 1] + Y, BA = p[B] + Z, BB = p[B + 1] + Z;
    const l1 = (a, b, t) => a + t * (b - a);
    return 1.4 * l1(
      l1(l1(gd(g[AA], x, y, z), gd(g[BA], x - 1, y, z), u), l1(gd(g[AB], x, y - 1, z), gd(g[BB], x - 1, y - 1, z), u), v),
      l1(l1(gd(g[AA + 1], x, y, z - 1), gd(g[BA + 1], x - 1, y, z - 1), u), l1(gd(g[AB + 1], x, y - 1, z - 1), gd(g[BB + 1], x - 1, y - 1, z - 1), u), v),
      w,
    );
  };
}

/**
 * Fractal noise on a 3D point. o: {type: fbm|ridged|billow, octaves, frequency, lacunarity, gain}.
 * fbm/billow -> about -1..1 / 0..1; ridged -> 0..1 (sharp crests, for mountain chains and seams).
 */
export function fractal(n, x, y, z, o) {
  const oct = o.octaves ?? 5, lac = o.lacunarity ?? 2, gain = o.gain ?? 0.5;
  let f = o.frequency ?? 1, a = 1, sum = 0, norm = 0, w = 1;
  for (let i = 0; i < oct; i++) {
    // per-octave offset breaks the lattice alignment at the origin
    const v = n(x * f + i * 19.1, y * f + i * 7.3, z * f + i * 3.7);
    if (o.type === 'ridged') { let r = 1 - Math.abs(v); r *= r; r *= w; w = Math.min(1, r * 2); sum += r * a; }
    else if (o.type === 'billow') sum += Math.abs(v) * a;
    else sum += v * a;
    norm += a; a *= gain; f *= lac;
  }
  return sum / norm;
}

/** Domain warp: p + amount * (3 independent fbm fields at warp frequency). */
export function warp(ns, x, y, z, amount, freq, octaves = 3) {
  if (!amount) return [x, y, z];
  const o = { octaves, frequency: freq };
  return [x + amount * fractal(ns[0], x, y, z, o), y + amount * fractal(ns[1], x + 5.2, y + 1.3, z, o), z + amount * fractal(ns[2], x, y + 9.2, z + 2.8, o)];
}

export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const smoothstep = (a, b, v) => { const t = clamp01((v - a) / (b - a || 1e-9)); return t * t * (3 - 2 * t); };
export const lerp = (a, b, t) => a + (b - a) * t;
export const vnorm = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
export const vdot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const vcross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
/** Any orthonormal tangent pair for a unit vector (deterministic in d). */
export function tangents(d) {
  const t = Math.abs(d[1]) < 0.99 ? vnorm(vcross([0, 1, 0], d)) : vnorm(vcross([1, 0, 0], d));
  return [t, vcross(d, t)];
}

// ---------- projections ----------
// Equirect (three.js equirectUv convention): u = atan2(z, x) / 2pi + 0.5, v = asin(y) / pi + 0.5;
// image row 0 = north (v = 1). Column c / row r -> texel centre direction.
export function equirectDir(u, v) {
  const phi = (u - 0.5) * 2 * Math.PI, th = (v - 0.5) * Math.PI;
  return [Math.cos(phi) * Math.cos(th), Math.sin(th), Math.sin(phi) * Math.cos(th)];
}
/** Unit direction -> [u, v] (v = 1 north), as above. */
export function dirToEquirect(d) {
  return [Math.atan2(d[2], d[0]) / (2 * Math.PI) + 0.5, Math.asin(Math.max(-1, Math.min(1, d[1]))) / Math.PI + 0.5];
}
// Cube faces in OpenGL / three.js CubeTextureLoader order px nx py ny pz nz. s, t in 0..1 with
// t = 0 the top image row; sc = 2s-1, tc = 2t-1 (OpenGL cube map spec table).
export const FACES = ['px', 'nx', 'py', 'ny', 'pz', 'nz'];
/** Face + (sc, tc) in -1..1 (any scale, e.g. integer lattice) -> cube point (unnormalised). */
export function cubePoint(f, sc, tc, m = 1) {
  switch (f) {
    case 0: return [m, -tc, -sc];
    case 1: return [-m, -tc, sc];
    case 2: return [sc, m, tc];
    case 3: return [sc, -m, -tc];
    case 4: return [sc, -tc, m];
    default: return [-sc, -tc, -m];
  }
}
export const cubeDir = (f, s, t) => vnorm(cubePoint(f, 2 * s - 1, 2 * t - 1));
/** Unit direction -> {face, s, t}. */
export function dirToCube(d) {
  const ax = Math.abs(d[0]), ay = Math.abs(d[1]), az = Math.abs(d[2]);
  let f, sc, tc, ma;
  if (ax >= ay && ax >= az) { ma = ax; if (d[0] > 0) { f = 0; sc = -d[2]; tc = -d[1]; } else { f = 1; sc = d[2]; tc = -d[1]; } }
  else if (ay >= az) { ma = ay; if (d[1] > 0) { f = 2; sc = d[0]; tc = d[2]; } else { f = 3; sc = d[0]; tc = -d[2]; } }
  else { ma = az; if (d[2] > 0) { f = 4; sc = d[0]; tc = -d[1]; } else { f = 5; sc = -d[0]; tc = -d[1]; } }
  return { face: f, s: (sc / ma + 1) / 2, t: (tc / ma + 1) / 2 };
}

// ---------- colour + pixel helpers ----------
export function hexRGB(c) {
  if (Array.isArray(c)) return c.slice(0, 3).map(Number);
  const s = String(c).replace('#', '');
  const h = s.length === 3 ? s.split('').map((x) => x + x).join('') : s;
  if (!/^[0-9a-f]{6}([0-9a-f]{2})?$/i.test(h)) throw new Error(`colour must be #rrggbb (got ${JSON.stringify(c)})`);
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
export const toHex = (c) => '#' + c.slice(0, 3).map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
/** Pick a ramp entry for t in 0..1, banded with an optional Bayer threshold at pixel (x, y). */
export function rampPick(ramp, t, dither, x, y) {
  const n = ramp.length;
  if (n === 1) return ramp[0];
  const p = clamp01(t) * (n - 1);
  let i = Math.floor(p);
  if (p - i > (dither ? bayer(x, y) : 0.5)) i++;
  return ramp[Math.min(n - 1, i)];
}
/** HSL hue rotation (deg) and lightness / saturation scale of an RGB colour. */
export function shiftColor(c, dh = 0, ds = 1, dl = 1) {
  let [r, g, b] = c.map((v) => v / 255);
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  let h = 0, s = 0; const l = (mx + mn) / 2;
  if (mx !== mn) {
    const d = mx - mn;
    s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
    h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h *= 60;
  }
  h = (((h + dh) % 360) + 360) % 360; s = clamp01(s * ds); const L = clamp01(l * dl);
  const q = L < 0.5 ? L * (1 + s) : L + s - L * s, pp = 2 * L - q;
  const hk = h / 360;
  const tc = (t) => { t = ((t % 1) + 1) % 1; return t < 1 / 6 ? pp + (q - pp) * 6 * t : t < 0.5 ? q : t < 2 / 3 ? pp + (q - pp) * (2 / 3 - t) * 6 : pp; };
  return s === 0 ? [L * 255, L * 255, L * 255].map(Math.round) : [tc(hk + 1 / 3), tc(hk), tc(hk - 1 / 3)].map((v) => Math.round(v * 255));
}

/** Median-cut palette (n colours) from RGBA images (opaque texels only). */
export function medianCut(images, n) {
  const px = [];
  for (const d of images) for (let i = 0; i < d.length; i += 4 * 3) if (d[i + 3] > 127) px.push([d[i], d[i + 1], d[i + 2]]);
  if (!px.length) return [];
  const boxes = [px];
  while (boxes.length < n) {
    let bi = -1, bc = -1, br = 0;
    boxes.forEach((b, i) => {
      if (b.length < 2) return;
      for (let c = 0; c < 3; c++) { let lo = 255, hi = 0; for (const p of b) { if (p[c] < lo) lo = p[c]; if (p[c] > hi) hi = p[c]; } if (hi - lo > br) { br = hi - lo; bi = i; bc = c; } }
    });
    if (bi < 0) break;
    const b = boxes[bi].sort((x, y) => x[bc] - y[bc]);
    boxes.splice(bi, 1, b.slice(0, b.length >> 1), b.slice(b.length >> 1));
  }
  return boxes.filter((b) => b.length).map((b) => { const s = [0, 0, 0]; for (const p of b) for (let c = 0; c < 3; c++) s[c] += p[c]; return s.map((v) => Math.round(v / b.length)); });
}
/** Snap RGBA pixels to the nearest palette colour, optional ordered dither (strength in palette steps). */
export function quantize(d, W, pal, { dither = false, strength = 24 } = {}) {
  if (!pal || !pal.length) return d;
  const cache = new Map();
  for (let i = 0, k = 0; i < d.length; i += 4, k++) {
    if (d[i + 3] === 0) continue;
    const off = dither ? (bayer(k % W, Math.floor(k / W)) - 0.5) * strength : 0;
    const r = d[i] + off, g = d[i + 1] + off, b = d[i + 2] + off;
    const key = (Math.round(r) << 20) ^ (Math.round(g) << 10) ^ Math.round(b);
    let best = cache.get(key);
    if (best === undefined) {
      let bd = Infinity;
      for (let j = 0; j < pal.length; j++) { const p = pal[j], e = (p[0] - r) ** 2 * 0.3 + (p[1] - g) ** 2 * 0.59 + (p[2] - b) ** 2 * 0.11; if (e < bd) { bd = e; best = j; } }
      cache.set(key, best);
    }
    const p = pal[best];
    d[i] = p[0]; d[i + 1] = p[1]; d[i + 2] = p[2];
  }
  return d;
}
/** Nearest upscale of an RGBA image by integer k. */
export function upscale(img, k) {
  if (k <= 1) return img;
  const W = img.width * k, H = img.height * k, out = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const s = (Math.floor(y / k) * img.width + Math.floor(x / k)) * 4; out.set(img.data.subarray(s, s + 4), (y * W + x) * 4); }
  return { width: W, height: H, data: out };
}
/** Draw `src` image onto `dst` at (x, y) with alpha "over". */
export function blit(dst, src, x0, y0) {
  for (let y = 0; y < src.height; y++) {
    const dy = y0 + y; if (dy < 0 || dy >= dst.height) continue;
    for (let x = 0; x < src.width; x++) {
      const dx = x0 + x; if (dx < 0 || dx >= dst.width) continue;
      const s = (y * src.width + x) * 4, o = (dy * dst.width + dx) * 4, a = src.data[s + 3] / 255;
      if (!a) continue;
      const da = dst.data[o + 3] / 255, oa = a + da * (1 - a);
      for (let c = 0; c < 3; c++) dst.data[o + c] = (src.data[s + c] * a + dst.data[o + c] * da * (1 - a)) / oa;
      dst.data[o + 3] = oa * 255;
    }
  }
}
export const MAX_TEX = 1024;
/** Throw unless w, h are within the texture limit (1024 px: Roblox / mobile-safe). */
export function texLimit(w, h, what) {
  if (!(w >= 1 && h >= 1 && w <= MAX_TEX && h <= MAX_TEX)) throw new Error(`${what}: ${w}x${h} px is over the ${MAX_TEX} px texture limit (lower the size or tile it)`);
}
export const r4 = (v) => Math.round(v * 1e4) / 1e4;
