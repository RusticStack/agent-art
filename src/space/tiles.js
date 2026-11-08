// Tileable pixel-art material tiles (terrain splat layers, rock skins) from a palette ramp.
// Periodic value noise / Voronoi on an integer lattice, so every tile wraps seamlessly.
// Ground materials (authorTile) are painted with Agent Art's own texture ops (cells, noise,
// scatter, line) on an in-memory canvas, exactly as an agent would author them by hand.
import { mulberry32, bayer } from '../util.js';
import { seedOf, rampPick, clamp01, hexRGB, toHex, shiftColor } from './noise.js';
import { Doc } from '../doc.js';

/** Ground material recipes: name -> (ramp hex[], seed, size) -> art_draw commands. */
const RECIPES = {
  // cracked rock plates: shaded Voronoi plates, dark cracks, grit + a few lit chips
  plates: (r, s, S) => [
    { op: 'cells', colors: r.slice(0, 4), gap_color: r[0], size: Math.round(S / 4.5), gap: 1, jitter: 0.9, variation: 1, seed: s },
    { op: 'noise', colors: ['keep', r[0]], weights: [0.95, 0.05], scale: 1, seed: s + 1 },
    { op: 'scatter', colors: [r[r.length - 1]], density: 0.012, size: 1, seed: s + 2 },
  ],
  // wind ripples: soft sand noise, sinuous crests (lit) with a shadow line under each
  ripples: (r, s, S) => {
    const cmds = [{ op: 'noise', colors: [r[1], r[2], r[2], r[3]], weights: [0.2, 0.35, 0.3, 0.15], scale: 3, despeckle: 1, seed: s }];
    const rr = mulberry32(seedOf(s, 7)), n = 5, k = 1 + Math.floor(rr() * 2);
    for (let i = 0; i < n; i++) {
      const y0 = (i + rr() * 0.4) * (S / n), a = 2 + rr() * 2, ph = rr() * Math.PI * 2;
      for (const dy of [-S, 0, S]) {
        const crest = [], shadow = [];
        for (let x = -2; x <= S + 2; x += 2) {
          const y = y0 + dy + a * Math.sin((x / S) * Math.PI * 2 * k + ph) + 1.5 * Math.sin((x / S) * Math.PI * 2 * (k + 2) + ph * 2);
          crest.push([x, Math.round(y)]); shadow.push([x, Math.round(y) + 1]);
        }
        cmds.push({ op: 'line', points: shadow, color: r[0] }, { op: 'line', points: crest, color: r[r.length - 1] });
      }
    }
    cmds.push({ op: 'noise', colors: ['keep', r[1]], weights: [0.9, 0.1], scale: 1, seed: s + 3 });
    return cmds;
  },
  // gravel: tiny shaded stones, a few bigger pebbles
  gravel: (r, s) => [
    { op: 'cells', colors: r.slice(1, 4), gap_color: r[0], size: 5, gap: 1, jitter: 1, variation: 1, seed: s },
    { op: 'noise', colors: ['keep', r[1]], weights: [0.85, 0.15], scale: 1, seed: s + 5 },
    { op: 'scatter', colors: [r[r.length - 1], r[2]], density: 0.03, size: 2, seed: s + 1 },
    { op: 'scatter', colors: [r[0]], density: 0.04, size: 1, seed: s + 2 },
  ],
  // dried mud: big flat plates curling at the edges, dark crack network
  mud: (r, s, S) => [
    { op: 'cells', colors: [r[1], r[2], r[2], r[3]], gap_color: r[0], size: Math.round(S / 3.6), gap: 2, jitter: 0.85, variation: 1, profile: 'flat', depth: 2, seed: s },
    { op: 'noise', colors: ['keep', r[1]], weights: [0.9, 0.1], scale: 1, seed: s + 1 },
  ],
  // ice crust: large pale plates, blue cracks, white sparkle
  ice: (r, s, S) => [
    { op: 'cells', colors: r.slice(-4), gap_color: r[1], size: Math.round(S / 3.2), gap: 1, jitter: 0.8, variation: 1, profile: 'flat', depth: 2, seed: s },
    { op: 'noise', colors: ['keep', r[r.length - 2]], weights: [0.85, 0.15], scale: 2, seed: s + 1 },
    { op: 'scatter', colors: ['#ffffff'], density: 0.01, size: 1, seed: s + 2 },
  ],
  // toxic crust: rust flakes split by acid-yellow seams
  toxic: (r, s, S, accent) => [
    { op: 'cells', colors: r.slice(0, 4), gap_color: accent || r[r.length - 1], size: Math.round(S / 7), gap: 1, jitter: 0.9, variation: 1, seed: s },
    { op: 'scatter', colors: [accent || r[r.length - 1]], density: 0.015, size: 1, seed: s + 1 },
  ],
  // moss / low growth: clumpy greens with bright tips
  moss: (r, s) => [
    { op: 'noise', colors: r.slice(0, 4), weights: [0.2, 0.35, 0.3, 0.15], scale: 2, despeckle: 1, seed: s },
    { op: 'scatter', colors: [r[r.length - 1]], density: 0.04, size: 1, seed: s + 1 },
  ],
  // snow: smooth drifts
  snow: (r, s) => [
    { op: 'noise', colors: r.slice(-3), weights: [0.25, 0.5, 0.25], scale: 5, despeckle: 2, seed: s },
    { op: 'scatter', colors: ['#ffffff'], density: 0.008, size: 1, seed: s + 1 },
  ],
  // basalt with glowing seams (lava lowlands)
  glow: (r, s, S, accent) => [
    { op: 'cells', colors: r.slice(0, 4), gap_color: accent || '#ff7a1a', size: Math.round(S / 5), gap: 1, jitter: 0.9, variation: 1, seed: s },
  ],
  // regolith: fine dust with pebbles
  regolith: (r, s) => [
    { op: 'noise', colors: r.slice(1, 4), weights: [0.3, 0.45, 0.25], scale: 2, seed: s },
    { op: 'scatter', colors: [r[0], r[r.length - 1]], density: 0.025, size: 2, seed: s + 1 },
  ],
};
export const GROUND_KINDS = Object.keys(RECIPES);

/**
 * One ground material tile authored with Agent Art draw ops. ramp: colours dark -> light (4+).
 * accent: crack / seam colour for toxic and glow. -> {width, height, data, emissive?, commands}
 */
export function authorTile(kind, ramp, { size = 64, seed = 1, accent = null } = {}) {
  if (!RECIPES[kind]) throw new Error(`ground tile kind must be one of ${GROUND_KINDS.join(', ')}`);
  const hex = ramp.map((c) => (Array.isArray(c) ? toHex(c) : c));
  while (hex.length < 4) hex.push(toHex(shiftColor(hexRGB(hex[hex.length - 1]), 0, 1, 1.15)));
  const acc = accent ? (Array.isArray(accent) ? toHex(accent) : accent) : null;
  const commands = RECIPES[kind](hex, seed % 100000, size, acc);
  const d = new Doc({ name: `tile_${kind}`, width: size, height: size });
  d.execute(commands);
  const data = d.composite();
  let emissive = null;
  if (kind === 'glow') {
    const g = hexRGB(acc || '#ff7a1a');
    emissive = new Uint8ClampedArray(size * size * 4);
    for (let i = 0; i < data.length; i += 4) if (data[i] === g[0] && data[i + 1] === g[1] && data[i + 2] === g[2]) emissive.set([g[0], g[1], g[2], 255], i);
  }
  return { width: size, height: size, data: Uint8ClampedArray.from(data), emissive, commands };
}

/** Tileable organic blob mask (0..1 per texel) for material transitions / edge tiles. */
export function edgeMask(size, seed) {
  const n = tileFbm(seedOf(seed, 77), size, 3, 4), m = new Float32Array(size * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) m[y * size + x] = clamp01((n(x, y) - 0.25) / 0.5);
  return m;
}
/** Edge / transition tile: material over transparency where mask < cover, with a 1 px dark rim. */
export function edgeTile(tile, mask, cover, rim) {
  const S = tile.width, out = new Uint8ClampedArray(S * S * 4);
  const inside = (x, y) => mask[(((y % S) + S) % S) * S + (((x % S) + S) % S)] < cover;
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    if (!inside(x, y)) continue;
    const o = (y * S + x) * 4, edge = !inside(x + 1, y) || !inside(x - 1, y) || !inside(x, y + 1) || !inside(x, y - 1);
    if (edge) out.set([rim[0], rim[1], rim[2], 255], o); else out.set(tile.data.subarray(o, o + 4), o);
  }
  return { width: S, height: S, data: out };
}
/** Box-downsampled copy (factor k) of a tile: the far-LOD mip used for coarse chunk textures. */
export function tileMip(tile, k) {
  const S = tile.width / k, out = new Uint8ClampedArray(S * S * 4);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const acc = [0, 0, 0];
    for (let j = 0; j < k; j++) for (let i = 0; i < k; i++) { const o = ((y * k + j) * tile.width + x * k + i) * 4; for (let c = 0; c < 3; c++) acc[c] += tile.data[o + c]; }
    out.set([acc[0] / (k * k), acc[1] / (k * k), acc[2] / (k * k), 255], (y * S + x) * 4);
  }
  return { width: S, height: S, data: out };
}

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
