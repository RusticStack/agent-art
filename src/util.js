// Shared numeric helpers: seeded randomness, hashing, dithering, argument parsing.

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hash3(x, y, seed) {
  // murmur3-style finalizer per input: a single mixing round left neighbouring lattice
  // rows correlated (visible banding in tiled noise)
  let h = Math.imul(seed ^ 0x9e3779b9, 0x85ebca6b);
  h = Math.imul(h ^ x ^ (h >>> 15), 0xcc9e2d51);
  h = Math.imul(h ^ (h >>> 13) ^ Math.imul(y, 0x1b873593), 0x85ebca6b);
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

export const smooth = (t) => t * t * (3 - 2 * t);

export const BAYER4 = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
];

/** Ordered-dither threshold in (0,1) for pixel x,y. */
export const bayer = (x, y) => (BAYER4[y & 3][x & 3] + 0.5) / 16;

export const int = (v, name) => {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`"${name}" must be a number (got ${JSON.stringify(v)})`);
  return Math.round(n);
};

export const num = (v, name, def) => {
  if (v === undefined || v === null) return def;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`"${name}" must be a number (got ${JSON.stringify(v)})`);
  return n;
};

/** Quantize a 0..1 value into `steps` bands with optional ordered dithering at x,y. */
export function band(v, steps, dither, x, y) {
  if (!steps || steps <= 0) return v;
  const p = v * steps;
  let i = Math.floor(p);
  if (dither && p - i > bayer(x, y)) i++;
  else if (!dither && p - i >= 0.5) i++;
  return Math.max(0, Math.min(steps, i)) / steps;
}

export const BLEND_MODES = ['normal', 'multiply', 'screen', 'add', 'overlay', 'darken', 'lighten', 'soft-light'];

/** Per-channel blend of backdrop d with source s (0..255). */
export function blendChannel(mode, d, s) {
  switch (mode) {
    case 'multiply': return (d * s) / 255;
    case 'screen': return 255 - ((255 - d) * (255 - s)) / 255;
    case 'add': return Math.min(255, d + s);
    case 'overlay': return d < 128 ? (2 * d * s) / 255 : 255 - (2 * (255 - d) * (255 - s)) / 255;
    case 'darken': return Math.min(d, s);
    case 'lighten': return Math.max(d, s);
    case 'soft-light': {
      const a = d / 255, b = s / 255;
      return 255 * (b < 0.5 ? a - (1 - 2 * b) * a * (1 - a) : a + (2 * b - 1) * ((a <= 0.25 ? ((16 * a - 12) * a + 4) * a : Math.sqrt(a)) - a));
    }
    default: return s;
  }
}

/** Names that become path segments (files under the asset root / library / canvas store): 1-64 letters, digits, _ - ., never "." or "..". */
const SAFE_NAME = /^[A-Za-z0-9_\-.]{1,64}$/;
export function checkName(n, what) {
  if (typeof n !== 'string' || !SAFE_NAME.test(n) || /^\.+$/.test(n)) throw new Error(`${what} ${JSON.stringify(n)} must be 1-64 letters, digits, _ - . (it names files under the asset root)`);
  return n;
}
