// Painted pixel shading for fp sprites. Every surface pixel takes a colour from its material's
// hue-shifted ramp (no colour outside the ramps, so sheets are palette-stable): banded light from
// the upper left, a sky term and tight speculars on metal, lit bevel / rim highlights, a dark
// selective outline on the shadow side, and 4x4 ordered dither on band edges. Inputs are per-pixel
// material ids, normals and depth (from the 3D rasterizer for guns and items, from the SDF part
// renderer for arms), so one look covers the whole viewmodel.
import { makeRamp, parseColor, toHex } from './color.js';
import { upscale } from './pixelops.js';

const BAYER4 = [[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]];

/**
 * Materials: base colour (the albedo kit models use), ramp size / spread, metal (speculars + sky
 * reflection), spec strength, flat (emissive: one colour, no shading), soft (cloth: wrapped light).
 */
const MATERIAL_DEFS = {
  gunmetal: { hex: '#4a4f58', steps: 8, spread: 0.7, hue: 14, metal: true, spec: 0.9 },
  steel: { hex: '#6a7079', steps: 8, spread: 0.72, hue: 12, metal: true, spec: 1 },
  blued: { hex: '#30343c', steps: 7, spread: 0.56, hue: 16, metal: true, spec: 0.8 },
  polymer: { hex: '#3f413a', steps: 7, spread: 0.56, hue: 16, spec: 0.25 },
  polymer_tan: { hex: '#8a7a5c', steps: 7, spread: 0.55, hue: 14, spec: 0.2 },
  polymer_od: { hex: '#55603f', steps: 7, spread: 0.55, hue: 16, spec: 0.2 },
  mag_steel: { hex: '#46474a', steps: 7, spread: 0.6, hue: 12, metal: true, spec: 0.7 },
  brass: { hex: '#b08a3a', steps: 7, spread: 0.6, hue: 10, metal: true, spec: 1 },
  shell_red: { hex: '#9c3226', steps: 6, spread: 0.5, hue: 14, spec: 0.3 },
  glass: { hex: '#2c5f7a', steps: 6, spread: 0.6, hue: 10, metal: true, spec: 1.2 },
  reticle: { hex: '#ff3b2f', flat: true },
  screen: { hex: '#3fd0e0', steps: 4, spread: 0.3, hue: 6, flat: true },
  rubber: { hex: '#262624', steps: 6, spread: 0.4, hue: 14, spec: 0.15 },
  od_green: { hex: '#4b5a3c', steps: 7, spread: 0.55, hue: 18, spec: 0.2 },
  blade: { hex: '#8d939b', steps: 8, spread: 0.7, hue: 10, metal: true, spec: 1.2 },
  cloth_white: { hex: '#d3d0c4', steps: 6, spread: 0.45, hue: 16, soft: true },
  hazard: { hex: '#c9a227', steps: 6, spread: 0.5, hue: 12, spec: 0.3 },
  cross_red: { hex: '#b8322b', steps: 5, spread: 0.45, hue: 12 },
  // arms skins
  mec_sleeve: { hex: '#4b5a3c', steps: 7, spread: 0.55, hue: 18, soft: true },
  mec_plate: { hex: '#4a5058', steps: 8, spread: 0.6, hue: 14, metal: true, spec: 0.7 },
  mec_glove: { hex: '#3c3e40', steps: 7, spread: 0.56, hue: 16, spec: 0.3 },
  mec_knuckle: { hex: '#555c66', steps: 7, spread: 0.62, hue: 14, metal: true, spec: 0.6 },
  mec_cuff: { hex: '#3b4134', steps: 6, spread: 0.5, hue: 16, soft: true },
  mec_mark: { hex: '#d9d6c8', steps: 4, spread: 0.3, hue: 8 },
  sev_sleeve: { hex: '#6b4a33', steps: 7, spread: 0.55, hue: 16, soft: true },
  sev_wrap: { hex: '#9a8466', steps: 7, spread: 0.55, hue: 16, soft: true },
  sev_plate: { hex: '#7a4a2e', steps: 7, spread: 0.6, hue: 14, metal: true, spec: 0.5 },
  sev_glove: { hex: '#5a3f2b', steps: 7, spread: 0.5, hue: 16, spec: 0.35 },
  skin: { hex: '#b98a6a', steps: 7, spread: 0.5, hue: 14, soft: true },
};

const rgb = (h) => parseColor(h).slice(0, 3);
export const MATERIALS = [];
const byHex = new Map(), byName = new Map();
/** Register a material (name, def) -> id. Unknown albedo colours get a material on the fly. */
export function material(name, d) {
  if (byName.has(name)) return byName.get(name);
  const ramp = d.flat && !d.steps ? [rgb(d.hex)] : makeRamp(d.hex, { steps: d.steps ?? 6, spread: d.spread ?? 0.5, hueShift: d.hue ?? 16 }).map(rgb);
  const id = MATERIALS.length;
  MATERIALS.push({ id, name, hex: d.hex.toLowerCase(), ramp, metal: !!d.metal, spec: d.spec ?? 0, flat: !!d.flat, soft: !!d.soft });
  byName.set(name, id);
  if (!byHex.has(d.hex.toLowerCase())) byHex.set(d.hex.toLowerCase(), id);
  return id;
}
for (const [n, d] of Object.entries(MATERIAL_DEFS)) material(n, d);
export const MAT = Object.fromEntries(Object.keys(MATERIAL_DEFS).map((n) => [n, byName.get(n)]));
/** Albedo hex of a material name (what kit models use as part colours). */
export const HEX = Object.fromEntries(Object.entries(MATERIAL_DEFS).map(([n, d]) => [n, d.hex]));
export function materialOfRGB(r, g, b) {
  const hex = toHex([r, g, b]).toLowerCase();
  return byHex.get(hex) ?? material(`c${hex.slice(1)}`, { hex, steps: 6, spread: 0.5 });
}

/**
 * Remap every ramp onto a palette (project palette quantize): each ramp colour -> its nearest
 * palette colour (redmean distance). Returns a function material id -> ramp.
 */
export function rampsFor(palette) {
  if (!palette || !palette.length) return (id) => MATERIALS[id].ramp;
  const P = palette.map((c) => (Array.isArray(c) ? c : rgb(c)));
  const near = (c) => {
    let best = P[0], bd = Infinity;
    for (const p of P) { const rm = (c[0] + p[0]) / 2, dd = (2 + rm / 256) * (c[0] - p[0]) ** 2 + 4 * (c[1] - p[1]) ** 2 + (2 + (255 - rm) / 256) * (c[2] - p[2]) ** 2; if (dd < bd) { bd = dd; best = p; } }
    return best;
  };
  const cache = new Map();
  return (id) => { if (!cache.has(id)) cache.set(id, MATERIALS[id].ramp.map(near)); return cache.get(id); };
}

/**
 * Paint: buffers of a W x H render -> RGBA. mat: Int16Array (-1 = empty), nrm: Float32Array xyz
 * (camera space, +z toward the viewer), depth: Float32Array (bigger = farther), light: unit vector
 * in camera space. opts: {ramps (id -> ramp), dither (default true), outline (default true),
 * edgeDepth (depth jump that counts as an edge, default 1.5), ditherOffset: [x, y]}.
 */
export function paint(W, H, mat, nrm, depth, light, opts = {}) {
  const out = new Uint8ClampedArray(W * H * 4);
  const ramps = opts.ramps || ((id) => MATERIALS[id].ramp);
  const dither = opts.dither !== false, outline = opts.outline !== false, edgeDepth = opts.edgeDepth ?? 1.5;
  const [ox, oy] = opts.ditherOffset || [0, 0];
  const Hh = (() => { const h = [light[0], light[1], light[2] + 1]; const l = Math.hypot(...h); return h.map((v) => v / l); })();
  const at = (x, y) => (x < 0 || y < 0 || x >= W || y >= H ? -1 : y * W + x);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x, m = mat[i];
    if (m < 0) continue;
    const M = MATERIALS[m], ramp = ramps(m), n = ramp.length;
    let idx;
    if (M.flat) idx = n - 1;
    else {
      const nx = nrm[i * 3], ny = nrm[i * 3 + 1], nz = nrm[i * 3 + 2];
      const ndl = nx * light[0] + ny * light[1] + nz * light[2];
      let I = M.soft ? 0.18 + 0.82 * Math.pow(Math.max(0, ndl * 0.6 + 0.4), 1.3) : 0.12 + 0.95 * Math.max(0, ndl) + 0.08 * ny;
      if (M.metal) {
        I = 0.12 + 0.7 * Math.max(0, ndl) + 0.18 * ny;
        const ndh = Math.max(0, nx * Hh[0] + ny * Hh[1] + nz * Hh[2]);
        I += M.spec * 0.75 * Math.pow(ndh, 28);
      } else if (M.spec) {
        const ndh = Math.max(0, nx * Hh[0] + ny * Hh[1] + nz * Hh[2]);
        I += M.spec * 0.45 * Math.pow(ndh, 16);
      }
      // edges: silhouette (empty / much farther neighbour) and creases (normal break)
      let sil = false, crease = false, litEdge = 0;
      for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
        const j = at(x + dx, y + dy);
        if (j < 0 || mat[j] < 0 || depth[j] - depth[i] > edgeDepth) { sil = true; litEdge += dx * light[0] - dy * light[1]; continue; }
        const d = nx * nrm[j * 3] + ny * nrm[j * 3 + 1] + nz * nrm[j * 3 + 2];
        if (d < 0.82 && ndl > nrm[j * 3] * light[0] + nrm[j * 3 + 1] * light[1] + nrm[j * 3 + 2] * light[2]) crease = true;
      }
      if (crease) I += M.metal ? 0.16 : 0.1;
      if (sil) I += litEdge > 0.15 ? 0.14 : -0.12;
      let f = Math.max(0, Math.min(1, I)) * (n - 1);
      if (dither) f += ((BAYER4[(y + oy) & 3][(x + ox) & 3] + 0.5) / 16 - 0.5) * 0.55;
      idx = Math.max(0, Math.min(n - 1, Math.round(f)));
      if (outline && sil && litEdge <= 0.15) idx = Math.min(idx, 0);
    }
    const c = ramp[idx];
    out[i * 4] = c[0]; out[i * 4 + 1] = c[1]; out[i * 4 + 2] = c[2]; out[i * 4 + 3] = 255;
  }
  return out;
}

/** Distinct opaque colours of RGBA images. */
export function colorsOf(...imgs) {
  const s = new Set();
  for (const d of imgs) for (let i = 0; i < d.length; i += 4) if (d[i + 3] >= 128) s.add((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]);
  return s;
}
/** Every ramp colour (the fp palette). */
export function fpPalette() {
  const s = new Set();
  for (const m of MATERIALS) for (const c of m.ramp) s.add((c[0] << 16) | (c[1] << 8) | c[2]);
  return s;
}

// ---------- RotSprite drawing with depth ----------
const BIG = new WeakMap();
/** RotSprite upscale factor by sprite size: 8x for small parts (fingers), 4x / 2x for big ones (forearms) where 8x costs a lot and adds nothing visible. */
export const rotFactor = (sp) => { const m = Math.max(sp.width, sp.height); return m <= 40 ? 8 : m <= 110 ? 4 : 2; };
/** Scale2x upscale of a sprite by its RotSprite factor (cached on the sprite object). */
export function big8(sp) {
  let b = BIG.get(sp);
  if (!b) { const k = rotFactor(sp); b = { ...upscale(sp.data, sp.width, sp.height, k), k }; BIG.set(sp, b); }
  return b;
}
/**
 * Draw sprite sp ({width, height, data}) rotated deg (clockwise, y down) about its pixel anchor
 * [ax, ay] placed at integer frame pixel (X, Y), RotSprite sampling (Scale2x upscale, nearest, sampled
 * at destination pixel centres): no new colours. Painter's: overwrites. dst: {W, H, rgba, depth?,
 * owner?}; depthAt(px, py) -> depth for written pixels; owner tag written per pixel.
 * Big sprites use a 4x / 2x upscale (rotFactor) instead of 8x.
 */
export function drawRot(dst, sp, ax, ay, X, Y, deg, depthAt, owner) {
  const B = big8(sp), k = B.k, BW = B.width, BH = B.height;
  const r = (deg * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
  const R = Math.ceil(Math.hypot(Math.max(ax, sp.width - ax), Math.max(ay, sp.height - ay))) + 1;
  const { W, H, rgba } = dst;
  for (let py = Math.max(0, Y - R); py <= Math.min(H - 1, Y + R); py++) for (let px = Math.max(0, X - R); px <= Math.min(W - 1, X + R); px++) {
    const qx = px + 0.5 - X, qy = py + 0.5 - Y;
    const u = Math.floor((ax + qx * c + qy * s) * k), v = Math.floor((ay - qx * s + qy * c) * k);
    if (u < 0 || v < 0 || u >= BW || v >= BH) continue;
    const si = (v * BW + u) * 4;
    if (B.data[si + 3] < 128) continue;
    const o = py * W + px;
    rgba[o * 4] = B.data[si]; rgba[o * 4 + 1] = B.data[si + 1]; rgba[o * 4 + 2] = B.data[si + 2]; rgba[o * 4 + 3] = 255;
    if (dst.depth) dst.depth[o] = depthAt ? depthAt(px, py) : 0;
    if (dst.owner) dst.owner[o] = owner;
  }
}
