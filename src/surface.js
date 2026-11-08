// Surface detail for art_model textures: PBR material presets and factors, metallicRoughness maps
// from "metal" / "rough" canvas layers, pixel-correct normal maps from a "height" layer (or a
// <canvas>_h canvas, or a derived height), and trim sheets (named horizontal strips of one canvas).
//
// Everything here only runs when a model, part or canvas asks for it, so plain models export
// byte-for-byte as before.
import { mulberry32, hash3 } from './util.js';

// ---------- PBR ----------
/**
 * Named material presets (glTF metallic-roughness). painted_metal is a dielectric paint over metal
 * (low metalness reads as worn paint at pixel scale); emissive_panel glows with its own albedo when
 * the texture has no emissive layer; glass = the glass:true part material.
 */
export const MATERIAL_PRESETS = {
  painted_metal: { metal: 0.2, rough: 0.55 },
  bare_metal: { metal: 1, rough: 0.35 },
  rubber: { metal: 0, rough: 0.92 },
  plastic: { metal: 0, rough: 0.45 },
  glass: { metal: 0, rough: 0.05, glass: true },
  emissive_panel: { metal: 0, rough: 0.6, emissive: true },
  fabric: { metal: 0, rough: 1 },
};
const unit = (v, name) => {
  const x = Number(v);
  if (!Number.isFinite(x) || x < 0 || x > 1) throw new Error(`material ${name} must be a number 0..1 (got ${JSON.stringify(v)})`);
  return x;
};
/** "bare_metal" | {preset?, metal?, rough?, emissive?} -> {metal, rough, preset?, glass?, emissive?} | null. */
export function normPBR(v) {
  if (v === undefined || v === null || v === false) return null;
  let base = {};
  if (typeof v === 'string') v = { preset: v };
  if (typeof v !== 'object' || Array.isArray(v)) throw new Error(`material must be a preset name (${Object.keys(MATERIAL_PRESETS).join('|')}) or {metal:0..1, rough:0..1, preset?}`);
  if (v.preset !== undefined) {
    base = MATERIAL_PRESETS[v.preset];
    if (!base) throw new Error(`unknown material preset "${v.preset}" (presets: ${Object.keys(MATERIAL_PRESETS).join(', ')})`);
  }
  for (const k of Object.keys(v)) if (!['preset', 'metal', 'rough', 'emissive'].includes(k)) throw new Error(`material.${k} is not a field (preset, metal, rough, emissive)`);
  const out = { metal: unit(v.metal ?? base.metal ?? 0, 'metal'), rough: unit(v.rough ?? base.rough ?? 1, 'rough') };
  if (v.preset) out.preset = v.preset;
  if (base.glass) out.glass = true;
  if (v.emissive ?? base.emissive) out.emissive = true;
  return out;
}
export const pbrKey = (m) => `${m.metal}:${m.rough}${m.emissive ? 'e' : ''}`;

const lum = (d, p) => (0.2126 * d[p] + 0.7152 * d[p + 1] + 0.0722 * d[p + 2]) / 255;

/**
 * glTF metallicRoughness texture (G = roughness, B = metalness, R = 255) from "metal" / "rough"
 * layer data (luminance x alpha; unpainted texels take the factor). The factors are baked in, so
 * the material factors become 1.
 */
export function mrTexture(W, H, metalData, roughData, pbr = { metal: 0, rough: 1 }) {
  const out = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    const p = i * 4;
    const pick = (d, def) => {
      if (!d || !d[p + 3]) return def;
      const a = d[p + 3] / 255;
      return lum(d, p) * a + def * (1 - a);
    };
    out[p] = 255;
    out[p + 1] = Math.round(pick(roughData, pbr.rough) * 255);
    out[p + 2] = Math.round(pick(metalData, pbr.metal) * 255);
    out[p + 3] = 255;
  }
  return out;
}

// ---------- height -> normal ----------
/** Height (0..1 per texel) from a layer / canvas: luminance x alpha (unpainted = 0). */
export function heightFromData(data, W, H) {
  const h = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) h[i] = data[i * 4 + 3] ? lum(data, i * 4) * (data[i * 4 + 3] / 255) : 0;
  return h;
}
/**
 * Derived height for textures without a height source (opt-in, bump.auto):
 * "luminance" = brightness quantised to `levels` steps (crisp plateaus, not a blur);
 * "panels" = dark panel lines / seams (luminance below the texture mean by more than `threshold`)
 * become grooves, everything else is the surface.
 */
export function autoHeight(data, W, H, mode = 'luminance', { levels = 4, threshold = 0.12 } = {}) {
  const h = new Float32Array(W * H);
  if (mode === 'luminance') {
    const L = Math.max(1, Math.round(levels));
    for (let i = 0; i < W * H; i++) h[i] = data[i * 4 + 3] ? Math.round(lum(data, i * 4) * L) / L : 0;
    return h;
  }
  if (mode === 'panels') {
    let s = 0, n = 0;
    for (let i = 0; i < W * H; i++) if (data[i * 4 + 3]) { s += lum(data, i * 4); n++; }
    const mean = n ? s / n : 0.5;
    for (let i = 0; i < W * H; i++) h[i] = data[i * 4 + 3] && lum(data, i * 4) >= mean - threshold ? 1 : 0;
    return h;
  }
  throw new Error(`bump.auto must be "luminance" or "panels" (got ${JSON.stringify(mode)})`);
}

/**
 * Pixel-correct tangent-space normal map from a height field: no blur. Only texels within `bevel`
 * texels of a drop to a LOWER neighbour tilt (the high side gets the chamfer, the low side stays
 * flat), so a raised panel gets a crisp bevelled rim and a recess a crisp inner rim. strength =
 * height in texels of a full 0..1 step (1 = 45° bevels at bevel 1). wrap = tiling neighbours
 * (seamless world-tiled textures). glTF convention: +X right, +Y up in the image (green = up),
 * flat = (128,128,255).
 */
export function heightToNormal(h, W, H, { strength = 1, bevel = 1, wrap = true } = {}) {
  const b = Math.max(1, Math.round(bevel));
  const at = (x, y) => {
    if (wrap) { x = ((x % W) + W) % W; y = ((y % H) + H) % H; } else { x = Math.max(0, Math.min(W - 1, x)); y = Math.max(0, Math.min(H - 1, y)); }
    return h[y * W + x];
  };
  const out = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const c = h[y * W + x];
    let mR = 0, mL = 0, mU = 0, mD = 0;
    for (let k = 1; k <= b; k++) {
      mR = Math.max(mR, c - at(x + k, y)); mL = Math.max(mL, c - at(x - k, y));
      mU = Math.max(mU, c - at(x, y - k)); mD = Math.max(mD, c - at(x, y + k));
    }
    const sx = ((mR - mL) * strength) / b, sy = ((mU - mD) * strength) / b;
    const l = Math.hypot(sx, sy, 1);
    const p = (y * W + x) * 4;
    out[p] = Math.round(((sx / l) * 0.5 + 0.5) * 255);
    out[p + 1] = Math.round(((sy / l) * 0.5 + 0.5) * 255);
    out[p + 2] = Math.round(((1 / l) * 0.5 + 0.5) * 255);
    out[p + 3] = 255;
  }
  return out;
}

/** bump: number | true | {strength?, bevel?, auto?, levels?, threshold?, invert?, wrap?} -> normalized | null. */
export function normBump(v) {
  if (v === undefined || v === null || v === false) return null;
  if (v === true) v = {};
  if (typeof v === 'number') v = { strength: v };
  if (typeof v !== 'object' || Array.isArray(v)) throw new Error('bump must be a strength number or {strength?:1, bevel?:1, auto?:"luminance"|"panels", levels?, threshold?, invert?}');
  for (const k of Object.keys(v)) if (!['strength', 'bevel', 'auto', 'levels', 'threshold', 'invert', 'wrap'].includes(k)) throw new Error(`bump.${k} is not a field (strength, bevel, auto, levels, threshold, invert, wrap)`);
  const strength = Number(v.strength ?? 1), bevel = Number(v.bevel ?? 1);
  if (!Number.isFinite(strength) || strength < 0 || strength > 16) throw new Error('bump strength must be 0..16');
  if (!Number.isFinite(bevel) || bevel < 1 || bevel > 8) throw new Error('bump bevel must be 1..8 texels');
  const out = { strength, bevel: Math.round(bevel) };
  if (v.auto !== undefined) { if (!['luminance', 'panels'].includes(v.auto)) throw new Error('bump.auto must be "luminance" or "panels"'); out.auto = v.auto; }
  if (v.levels !== undefined) out.levels = Number(v.levels);
  if (v.threshold !== undefined) out.threshold = Number(v.threshold);
  if (v.invert) out.invert = true;
  if (v.wrap === false) out.wrap = false;
  return out;
}
export const bumpKey = (b) => `${b.strength}:${b.bevel}:${b.auto || ''}:${b.levels ?? ''}:${b.threshold ?? ''}:${b.invert ? 'i' : ''}${b.wrap === false ? 'c' : ''}`;

/** Normal map for a texture under a bump spec: height source (layer / _h canvas) or derived; null if none. */
export function bumpNormal(t, bump) {
  let h = t.heightOf ? t.heightOf() : null;
  if (!h && bump.auto) h = autoHeight(t.data, t.width, t.height, bump.auto, bump);
  if (!h) return null;
  if (bump.invert) h = h.map((v) => 1 - v);
  return heightToNormal(h, t.width, t.height, bump);
}

// ---------- trim sheets ----------
/** meta.trim = {strips:{name:[y, h]}} -> validated strips for a W x H canvas. */
export function trimStrips(meta, W, H, canvas) {
  const s = meta?.trim?.strips;
  if (!s || typeof s !== 'object') throw new Error(`canvas "${canvas}" is not a trim sheet (art_model trim {canvas:"${canvas}", strips:{name:[y,h]}} marks one, or makes a new one)`);
  const out = {};
  for (const [k, v] of Object.entries(s)) {
    if (!Array.isArray(v) || v.length !== 2) throw new Error(`trim strip "${k}" must be [y, h] px`);
    const [y, h] = v.map(Number);
    if (!(y >= 0 && h >= 1 && y + h <= H)) throw new Error(`trim strip "${k}" [${y},${h}] must lie inside the ${W}x${H} sheet`);
    out[k] = [y, h];
  }
  return out;
}
/** trim:"sheet:strip" | {sheet, strip, faces?, scale?, flip?} -> {sheet, strip, faces, scale, flip}. */
export function normTrim(v) {
  if (v === undefined || v === null || v === false) return null;
  if (typeof v === 'string') {
    const i = v.lastIndexOf(':');
    if (i <= 0 || i === v.length - 1) throw new Error(`trim must be "<sheet canvas>:<strip>" (got ${JSON.stringify(v)})`);
    v = { sheet: v.slice(0, i), strip: v.slice(i + 1) };
  }
  if (typeof v !== 'object' || !v.sheet || !v.strip) throw new Error('trim must be "sheet:strip" or {sheet, strip, faces?:"auto"|"all"|"edges", scale?:1, flip?}');
  const faces = v.faces ?? 'auto';
  if (!['auto', 'all', 'edges'].includes(faces)) throw new Error('trim.faces must be "auto" (bevels, inset walls, thin edge faces), "edges" (thin faces only) or "all"');
  const scale = Number(v.scale ?? 1);
  if (!(scale > 0)) throw new Error('trim.scale must be > 0');
  return { sheet: v.sheet, strip: v.strip, faces, scale, flip: !!v.flip, max: v.max === undefined ? undefined : Number(v.max) };
}

const hex = (s) => { const n = parseInt(s.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
/** Built-in trim strip styles: [name, rows, painter(x, y, h, rnd) -> {c:[r,g,b], h (height 0..1), m (metal), r (rough), e? (emissive rgb)}]. */
const STRIP_STYLES = {
  plate: (o) => (x, y, h) => ({ c: y === 0 ? o.light : y === h - 1 ? o.dark : o.base, h: y === 0 || y === h - 1 ? 0.6 : 1, m: 0.2, r: 0.55 }),
  bevel: (o) => (x, y, h) => { const t = y / Math.max(1, h - 1); return { c: mix(o.light, o.dark, t), h: 1 - t * 0.8, m: 0.9, r: 0.35 }; },
  bolts: (o) => (x, y, h) => {
    const cy = Math.floor(h / 2), bolt = x % 8 === 3 && Math.abs(y - cy) <= 0;
    const ring = (x % 8 === 2 || x % 8 === 4) && y === cy;
    return { c: bolt ? o.light : ring ? o.dark : y === 0 ? o.light : y === h - 1 ? o.dark : o.base, h: bolt ? 1 : ring ? 0.7 : 0.5, m: bolt ? 1 : 0.2, r: bolt ? 0.3 : 0.55 };
  },
  hazard: (o) => (x, y, h) => { const k = Math.floor((x + y) / 4) % 2; return { c: y === 0 || y === h - 1 ? o.dark : k ? o.accent : hex('#1c1c20'), h: y === 0 || y === h - 1 ? 0.5 : 1, m: 0, r: 0.7 }; },
  grate: (o) => (x, y, h) => { const slot = x % 3 === 2 && y > 0 && y < h - 1; return { c: slot ? hex('#101014') : y === 0 ? o.light : o.base, h: slot ? 0 : 1, m: 0.8, r: 0.45 }; },
  seam: (o) => (x, y, h) => { const mid = Math.floor(h / 2); const g = y === mid; return { c: g ? hex('#141418') : y === mid - 1 ? o.dark : y === mid + 1 ? o.light : o.base, h: g ? 0 : 1, m: 0.2, r: 0.6 }; },
  rib: (o) => (x, y, h) => { const k = y % 3; return { c: k === 0 ? o.light : k === 2 ? o.dark : o.base, h: k === 2 ? 0.3 : 1, m: 0.7, r: 0.4 }; },
  rubber: (o, rnd) => (x, y, h) => ({ c: mix(hex('#26262a'), hex('#1a1a1d'), hash3(x, y, 7)), h: 1, m: 0, r: 0.95 }),
  light: (o) => (x, y, h) => { const edge = y === 0 || y === h - 1; return { c: edge ? o.dark : o.glow, h: edge ? 1 : 0.6, m: 0, r: 0.6, e: edge ? null : o.glow }; },
  pipe: (o) => (x, y, h) => { const t = Math.abs(y - (h - 1) / 2) / Math.max(1, (h - 1) / 2); return { c: mix(o.light, o.dark, t), h: 1 - t * t, m: 1, r: 0.3 }; },
};
const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
export const TRIM_STYLES = Object.keys(STRIP_STYLES);
/** Default sci-fi hull / corridor trim sheet (64 x 64). */
export const DEFAULT_TRIM = [
  { name: 'plate', style: 'plate', h: 8 }, { name: 'bevel', style: 'bevel', h: 6 }, { name: 'bolts', style: 'bolts', h: 6 },
  { name: 'seam', style: 'seam', h: 5 }, { name: 'hazard', style: 'hazard', h: 8 }, { name: 'grate', style: 'grate', h: 8 },
  { name: 'rib', style: 'rib', h: 6 }, { name: 'pipe', style: 'pipe', h: 6 }, { name: 'rubber', style: 'rubber', h: 4 },
  { name: 'light', style: 'light', h: 4 }, { name: 'plate_dark', style: 'plate', h: 3, base: '#3a3e46' },
];
/**
 * Paint a trim sheet: strips stacked top-down, each `h` rows, tiling horizontally. Returns colour,
 * height, metal, rough and emissive layers + meta.trim.strips {name:[y,h]}.
 */
export function paintTrimSheet({ width = 64, strips = DEFAULT_TRIM, colors = {}, seed = 1 } = {}) {
  const W = Math.round(width);
  if (!(W >= 8 && W <= 1024)) throw new Error('trim width must be 8..1024');
  const list = strips.map((s, i) => {
    if (!s || typeof s.name !== 'string' || !/^[\w.-]{1,32}$/.test(s.name)) throw new Error(`strip ${i}: name (1-32 letters, digits, _ - .) is required`);
    const style = s.style ?? s.name;
    if (!STRIP_STYLES[style]) throw new Error(`strip "${s.name}": style must be one of ${TRIM_STYLES.join(', ')}`);
    const h = Math.round(Number(s.h ?? 6));
    if (!(h >= 1 && h <= 64)) throw new Error(`strip "${s.name}": h must be 1..64 rows`);
    return { ...s, style, h };
  });
  const H = list.reduce((a, s) => a + s.h, 0);
  if (H > 1024) throw new Error('trim sheet taller than 1024 rows');
  const pal = { base: hex(colors.base ?? '#5a606a'), light: hex(colors.light ?? '#8a909a'), dark: hex(colors.dark ?? '#2e3238'), accent: hex(colors.accent ?? '#d8a020'), glow: hex(colors.glow ?? '#7fd8ff') };
  const L = (n) => new Uint8ClampedArray(W * H * 4);
  const color = L(), height = L(), metal = L(), rough = L(), emissive = L();
  const meta = {};
  const rnd = mulberry32(Math.round(seed) || 1);
  let y0 = 0, anyE = false;
  for (const s of list) {
    const o = { ...pal, ...(s.base ? { base: hex(s.base) } : {}), ...(s.accent ? { accent: hex(s.accent) } : {}), ...(s.glow ? { glow: hex(s.glow) } : {}) };
    const paint = STRIP_STYLES[s.style](o, rnd);
    for (let y = 0; y < s.h; y++) for (let x = 0; x < W; x++) {
      const v = paint(x, y, s.h), p = ((y0 + y) * W + x) * 4;
      color.set([...v.c, 255], p);
      const g = Math.round(v.h * 255); height.set([g, g, g, 255], p);
      const m = Math.round(v.m * 255); metal.set([m, m, m, 255], p);
      const r = Math.round(v.r * 255); rough.set([r, r, r, 255], p);
      if (v.e) { emissive.set([...v.e, 255], p); anyE = true; }
    }
    meta[s.name] = [y0, s.h];
    y0 += s.h;
  }
  return { width: W, height: H, layers: { color, height, metal, rough, ...(anyE ? { emissive } : {}) }, strips: meta };
}
