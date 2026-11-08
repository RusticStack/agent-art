// Tileable pixel-art material tiles (terrain splat layers, rock skins) from a palette ramp.
// Periodic value noise / Voronoi on an integer lattice, so every tile wraps seamlessly.
import { mulberry32, bayer } from '../util.js';
import { seedOf, rampPick, clamp01, hexRGB } from './noise.js';

/** Periodic 2D value noise: period p lattice cells across the tile. */
function pnoise(seed, p) {
  const r = mulberry32(seedOf(seed, p * 131 + 7));
  const v = new Float32Array(p * p).map(() => r());
  return (x, y) => {
    const fx = Math.floor(x), fy = Math.floor(y), tx = x - fx, ty = y - fy;
    const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
    const at = (i, j) => v[(((j % p) + p) % p) * p + (((i % p) + p) % p)];
    const a = at(fx, fy), b = at(fx + 1, fy), c = at(fx, fy + 1), d = at(fx + 1, fy + 1);
    return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
  };
}
/** Periodic fbm over a tile of `size` px: base period `p0` cells, doubling per octave. -> 0..1 */
export function tileFbm(seed, size, p0 = 4, octaves = 3) {
  const ns = Array.from({ length: octaves }, (_, o) => pnoise(seed + o * 17, p0 << o));
  return (x, y) => {
    let s = 0, n = 0, a = 1;
    for (let o = 0; o < octaves; o++) { const p = p0 << o; s += ns[o]((x / size) * p, (y / size) * p) * a; n += a; a *= 0.5; }
    return s / n;
  };
}
/** Periodic Voronoi: -> (x, y) => {d1, d2, id} (distances in px). */
function tileVoronoi(seed, size, cells) {
  const r = mulberry32(seedOf(seed, 99)), pts = [];
  const g = Math.max(1, Math.round(Math.sqrt(cells)));
  for (let j = 0; j < g; j++) for (let i = 0; i < g; i++) pts.push([((i + 0.15 + r() * 0.7) * size) / g, ((j + 0.15 + r() * 0.7) * size) / g, r()]);
  return (x, y) => {
    let d1 = Infinity, d2 = Infinity, id = 0;
    for (const p of pts) for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
      const d = Math.hypot(x - p[0] - ox * size, y - p[1] - oy * size);
      if (d < d1) { d2 = d1; d1 = d; id = p[2]; } else if (d < d2) d2 = d;
    }
    return { d1, d2, id };
  };
}

export const TILE_KINDS = ['ground', 'rock', 'ripple', 'crack', 'moss', 'strata', 'glow', 'snow'];
/**
 * One tileable tile. kind: ground | rock | ripple | crack | moss | strata | glow | snow.
 * ramp: [[r,g,b] dark -> light] (or hex strings). -> {width, height, data, emissive?}
 */
export function makeTile(kind, ramp, { size = 32, seed = 1, glow = null, dither = true } = {}) {
  if (!TILE_KINDS.includes(kind)) throw new Error(`tile kind must be one of ${TILE_KINDS.join(', ')}`);
  ramp = ramp.map((c) => (Array.isArray(c) ? c : hexRGB(c)));
  const S = size, data = new Uint8ClampedArray(S * S * 4), em = glow ? new Uint8ClampedArray(S * S * 4) : null;
  const n = tileFbm(seed, S, 4, 3), n2 = tileFbm(seed + 5, S, 8, 2);
  const vor = kind === 'rock' || kind === 'crack' || kind === 'glow' ? tileVoronoi(seed, S, kind === 'rock' ? 9 : 6) : null;
  const glowC = glow ? (Array.isArray(glow) ? glow : hexRGB(glow)) : null;
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    let t = n(x, y), gap = false, hot = 0;
    if (kind === 'rock') {
      const v = vor(x, y), e = v.d2 - v.d1;
      gap = e < 1.2;
      t = clamp01(0.25 + v.id * 0.35 + Math.min(1, e / 5) * 0.35 - (y % S) * 0 + (n2(x, y) - 0.5) * 0.3);
    } else if (kind === 'ripple') t = clamp01(0.5 + 0.45 * Math.sin(((y + n(x, y) * 10) / S) * Math.PI * 2 * 4) * 0.8 + (n2(x, y) - 0.5) * 0.3);
    else if (kind === 'crack' || kind === 'glow') {
      const v = vor(x, y), e = v.d2 - v.d1;
      gap = e < (kind === 'glow' ? 1.6 : 0.9);
      if (kind === 'glow' && gap) hot = 1 - e / 1.6;
      t = clamp01(0.45 + (n(x, y) - 0.5) * 0.8);
    } else if (kind === 'moss') t = clamp01(n(x, y) * 0.6 + (n2(x, y) > 0.62 ? 0.45 : 0));
    else if (kind === 'strata') t = clamp01(((Math.floor((y + n(x, y) * 3) / 4) * 0.37) % 1) * 0.8 + (n2(x, y) - 0.5) * 0.25);
    else if (kind === 'snow') t = clamp01(0.65 + (n(x, y) - 0.5) * 0.5);
    else t = clamp01(t + (n2(x, y) - 0.5) * 0.35);
    let c = gap ? ramp[0] : rampPick(ramp, t, dither, x, y);
    // sparse highlight specks (pixel-art grit)
    if (!gap && kind !== 'snow' && ((x * 7 + y * 13 + seed) % 23 === 0) && bayer(x, y) > 0.6) c = ramp[ramp.length - 1];
    const o = (y * S + x) * 4;
    data[o] = c[0]; data[o + 1] = c[1]; data[o + 2] = c[2]; data[o + 3] = 255;
    if (em && hot > 0) { const k = 0.5 + 0.5 * hot; em[o] = glowC[0] * k; em[o + 1] = glowC[1] * k; em[o + 2] = glowC[2] * k; em[o + 3] = 255; data.set(glowC.map((v) => v * 0.6), o); }
  }
  return { width: S, height: S, data, emissive: em };
}
