// Materials v2 for art_model exports: glTF material extensions (emissive strength + mask + animated
// flicker / pulse, clearcoat, anisotropy, transmission / volume / ior, sheen, diffuse transmission
// for subsurface), height textures for parallax, tiling detail maps, ORM channel packing profiles
// (gltf_orm / roblox / unity_mask), texture dedupe, TANGENT and extra vertex data (colour sets,
// UV2 / UV3), and the export profiles three / roblox / minimal.
//
// Everything is opt-in: a material field, a canvas layer, or an export option turns it on. A model
// that uses none of it never builds a v2 writer, so its .glb stays byte-for-byte the 0.7 output.
import crypto from 'node:crypto';
import { computeTangents } from './tangents.js';

// ---------- colour helpers ----------
const hexRGB = (s, what) => {
  const m = typeof s === 'string' && s.match(/^#?([0-9a-f]{6})$/i);
  if (!m) throw new Error(`${what} must be a "#rrggbb" colour (got ${JSON.stringify(s)})`);
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
export const srgbToLinear = (c) => { const v = c / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
export const linearToSrgb = (v) => (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055);
const lin3 = (s, what) => hexRGB(s, what).map((c) => +srgbToLinear(c).toFixed(5));
const f5 = (v) => +(+v).toFixed(5);

// ---------- material spec ----------
/**
 * New presets (0.8). The 0.7 presets (painted_metal, bare_metal, rubber, plastic, glass,
 * emissive_panel, fabric) are unchanged so existing models export the same bytes.
 */
export const V2_PRESETS = {
  painted_hull: { metal: 0.2, rough: 0.6, clearcoat: { factor: 1, rough: 0.12 } },
  brushed_metal: { metal: 1, rough: 0.38, anisotropy: { strength: 0.8, rotation: 0, pattern: 'brushed' } },
  glass_canopy: { metal: 0, rough: 0.04, transmission: { factor: 0.95, ior: 1.5, thickness: 1, attenuation: { color: '#cfe8ff', distance: 96 } } },
  cloth: { metal: 0, rough: 0.9, sheen: { color: '#b8bcc8', rough: 0.55 } },
  neon: { metal: 0, rough: 0.4, emissive: { strength: 6 } },
  skin: { metal: 0, rough: 0.55, subsurface: { factor: 0.45, color: '#ff9a80' } },
};
export const V2_KEYS = ['clearcoat', 'anisotropy', 'transmission', 'ior', 'sheen', 'subsurface', 'height', 'detail'];
const unit = (v, name) => { const x = Number(v); if (!Number.isFinite(x) || x < 0 || x > 1) throw new Error(`material ${name} must be 0..1 (got ${JSON.stringify(v)})`); return x; };
const pos = (v, name, max = 1e6) => { const x = Number(v); if (!Number.isFinite(x) || x < 0 || x > max) throw new Error(`material ${name} must be a number 0..${max} (got ${JSON.stringify(v)})`); return x; };
const objOf = (v, name, numKey) => {
  if (v === true) return {};
  if (typeof v === 'number') return { [numKey]: v };
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error(`material ${name} must be true, a number or an object`);
  return v;
};
const only = (o, keys, name) => { for (const k of Object.keys(o)) if (!keys.includes(k)) throw new Error(`material ${name}.${k} is not a field (${keys.join(', ')})`); };
const FLICKER = ['flicker', 'pulse', 'strobe', 'sputter'];

/**
 * v2 fields of a material spec (user fields over the preset's) -> normalized v2 object or null.
 * emissive {color?, strength?:1, animate?:{mode, hz, min, max, seed}}, clearcoat {factor, rough},
 * anisotropy {strength, rotation deg, pattern brushed|flat|radial}, transmission {factor, ior,
 * thickness px, attenuation {color, distance px}}, ior, sheen {color, rough}, subsurface {factor,
 * color}, height {scale px, bias px}, detail {texture, normal?, scale, strength}.
 */
export function normV2(v, base = {}) {
  const pick = (k) => (v[k] !== undefined ? v[k] : base[k]);
  const out = {};
  const em = pick('emissive');
  if (em !== undefined && em !== true && em !== false && em !== null) {
    const o = typeof em === 'number' ? { strength: em } : em;
    if (typeof o !== 'object' || Array.isArray(o)) throw new Error('material emissive must be true, a strength number or {color?, strength?, animate?}');
    only(o, ['color', 'strength', 'animate', 'mask'], 'emissive');
    const e = { strength: pos(o.strength ?? 1, 'emissive.strength', 1000) };
    if (o.color !== undefined) e.color = lin3(o.color, 'emissive.color');
    if (o.mask === false) e.mask = false;
    if (o.animate !== undefined && o.animate !== null && o.animate !== false) {
      const a = typeof o.animate === 'string' ? { mode: o.animate } : o.animate;
      if (!a || typeof a !== 'object') throw new Error('emissive.animate must be "flicker"|"pulse"|"strobe"|"sputter" or {mode, hz?, min?, max?, seed?}');
      only(a, ['mode', 'hz', 'min', 'max', 'seed', 'duty'], 'emissive.animate');
      if (!FLICKER.includes(a.mode)) throw new Error(`emissive.animate.mode must be one of ${FLICKER.join(', ')}`);
      e.animate = { mode: a.mode, hz: pos(a.hz ?? (a.mode === 'pulse' ? 0.5 : a.mode === 'strobe' ? 2 : 12), 'animate.hz', 120), min: unit(a.min ?? (a.mode === 'pulse' ? 0.35 : 0.2), 'animate.min'), max: pos(a.max ?? 1, 'animate.max', 10), seed: Math.round(Number(a.seed ?? 1)) || 1, ...(a.mode === 'strobe' ? { duty: unit(a.duty ?? 0.15, 'animate.duty') } : {}) };
    }
    if (e.strength !== 1 || e.color || e.animate || e.mask === false) out.emissive = e;
  }
  const cc = pick('clearcoat');
  if (cc !== undefined && cc !== false && cc !== null) { const o = objOf(cc, 'clearcoat', 'factor'); only(o, ['factor', 'rough'], 'clearcoat'); out.clearcoat = { factor: unit(o.factor ?? 1, 'clearcoat.factor'), rough: unit(o.rough ?? 0.1, 'clearcoat.rough') }; }
  const an = pick('anisotropy');
  if (an !== undefined && an !== false && an !== null) {
    const o = objOf(an, 'anisotropy', 'strength'); only(o, ['strength', 'rotation', 'pattern'], 'anisotropy');
    const pattern = o.pattern ?? 'brushed';
    if (!['brushed', 'flat', 'radial'].includes(pattern)) throw new Error('anisotropy.pattern must be brushed (streaked map along +u), flat (factors only) or radial (turned / spun metal)');
    out.anisotropy = { strength: unit(o.strength ?? 0.8, 'anisotropy.strength'), rotation: Number(o.rotation ?? 0), pattern };
    if (!Number.isFinite(out.anisotropy.rotation)) throw new Error('anisotropy.rotation must be degrees');
  }
  const tr = pick('transmission');
  if (tr !== undefined && tr !== false && tr !== null) {
    const o = objOf(tr, 'transmission', 'factor'); only(o, ['factor', 'ior', 'thickness', 'attenuation'], 'transmission');
    out.transmission = { factor: unit(o.factor ?? 1, 'transmission.factor'), thickness: pos(o.thickness ?? 0, 'transmission.thickness (px)') };
    if (o.ior !== undefined) out.ior = pos(o.ior, 'transmission.ior', 10);
    if (o.attenuation) { only(o.attenuation, ['color', 'distance'], 'transmission.attenuation'); out.transmission.attenuation = { color: lin3(o.attenuation.color ?? '#ffffff', 'attenuation.color'), distance: pos(o.attenuation.distance ?? 64, 'attenuation.distance (px)') }; }
  }
  const ior = pick('ior');
  if (ior !== undefined && ior !== null) { const x = pos(ior, 'ior', 10); if (x !== 0 && x < 1) throw new Error('material ior must be 0 or >= 1 (glass 1.5, water 1.33)'); out.ior = x; }
  const sh = pick('sheen');
  if (sh !== undefined && sh !== false && sh !== null) { const o = objOf(sh, 'sheen', 'rough'); only(o, ['color', 'rough'], 'sheen'); out.sheen = { color: lin3(o.color ?? '#ffffff', 'sheen.color'), rough: unit(o.rough ?? 0.5, 'sheen.rough') }; }
  const ss = pick('subsurface');
  if (ss !== undefined && ss !== false && ss !== null) { const o = objOf(ss, 'subsurface', 'factor'); only(o, ['factor', 'color'], 'subsurface'); out.subsurface = { factor: unit(o.factor ?? 0.5, 'subsurface.factor'), color: lin3(o.color ?? '#ffffff', 'subsurface.color') }; }
  const ht = pick('height');
  if (ht !== undefined && ht !== false && ht !== null) { const o = objOf(ht, 'height', 'scale'); only(o, ['scale', 'bias'], 'height'); out.height = { scale: pos(o.scale ?? 2, 'height.scale (px)', 256), bias: Number(o.bias ?? 0) }; if (!Number.isFinite(out.height.bias)) throw new Error('material height.bias must be px'); }
  const dt = pick('detail');
  if (dt !== undefined && dt !== false && dt !== null) {
    const o = typeof dt === 'string' ? { texture: dt } : dt;
    if (!o || typeof o !== 'object' || !o.texture) throw new Error('material detail must be "<detail canvas>" or {texture:<canvas>, normal?:<canvas>, scale?:4, strength?:0.5}');
    only(o, ['texture', 'normal', 'scale', 'strength'], 'detail');
    out.detail = { texture: String(o.texture), ...(o.normal ? { normal: String(o.normal) } : {}), scale: pos(o.scale ?? 4, 'detail.scale', 256), strength: unit(o.strength ?? 0.5, 'detail.strength') };
    if (!(out.detail.scale > 0)) throw new Error('material detail.scale must be > 0 (detail texels per base texel)');
  }
  return Object.keys(out).length ? out : null;
}
export const v2Key = (v2) => (v2 ? `|v2:${JSON.stringify(v2)}` : '');

// ---------- texture builders ----------
const lum = (d, p) => (0.2126 * d[p] + 0.7152 * d[p + 1] + 0.0722 * d[p + 2]) / 255;
/** Emissive mask from an emissive layer: per texel max channel x alpha (grey), so a colour factor tints it. */
export function emissiveMask(W, H, data) {
  const out = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) { const p = i * 4, m = Math.round((Math.max(data[p], data[p + 1], data[p + 2]) * data[p + 3]) / 255); out[p] = m; out[p + 1] = m; out[p + 2] = m; out[p + 3] = 255; }
  return out;
}
/**
 * KHR_materials_anisotropy texture: R/G = direction in tangent space (*0.5+0.5), B = strength.
 * brushed: direction +u (rotation via anisotropyRotation), strength streaked per row (4 levels,
 * seeded hash) so the highlight breaks into brush lines at pixel scale; radial: direction around
 * the texture centre (spun / turned metal).
 */
export function anisotropyTexture(W, H, pattern = 'brushed') {
  const out = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const p = (y * W + x) * 4;
    let dx = 1, dy = 0, s = 1;
    if (pattern === 'brushed') {
      let h = Math.imul(y + 17, 0x9e3779b1) ^ Math.imul((x >> 3) + 3, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
      s = 0.55 + 0.15 * ((h >>> 0) % 4); // 0.55 .. 1.0 in 4 steps
    } else if (pattern === 'radial') {
      const cx = x + 0.5 - W / 2, cy = -(y + 0.5 - H / 2), l = Math.hypot(cx, cy) || 1;
      dx = -cy / l; dy = cx / l; // tangential (circles round the centre)
    }
    out[p] = Math.round((dx * 0.5 + 0.5) * 255); out[p + 1] = Math.round((dy * 0.5 + 0.5) * 255); out[p + 2] = Math.round(s * 255); out[p + 3] = 255;
  }
  return out;
}
/** Material-space occlusion (ORM red) from an "ao" layer, else cavity from the height field, else null. */
export function materialOcclusion(t) {
  const W = t.width, H = t.height;
  if (t.aoData) {
    const out = new Uint8Array(W * H);
    for (let i = 0; i < W * H; i++) { const a = t.aoData[i * 4 + 3] / 255; out[i] = Math.round((lum(t.aoData, i * 4) * a + (1 - a)) * 255); }
    return out;
  }
  const h = t.heightOf ? t.heightOf() : null;
  if (!h) return null;
  // cavity: a texel lower than its 8 neighbours' max darkens by the drop (crisp, 4 levels)
  const out = new Uint8Array(W * H);
  let any = false;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const c = h[y * W + x];
    let mx = c;
    for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) mx = Math.max(mx, h[((y + j + H) % H) * W + ((x + i + W) % W)]);
    const d = Math.min(1, mx - c);
    const v = 1 - Math.round(d * 3) / 3 * 0.5;
    out[y * W + x] = Math.round(v * 255);
    if (out[y * W + x] < 255) any = true;
  }
  return any ? out : null;
}
/** ORM (R occlusion, G roughness, B metalness) from an MR texture (or factors) and occlusion. */
export function packORM(W, H, mr, occ, pbr = { metal: 0, rough: 1 }) {
  const out = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    const p = i * 4;
    out[p] = occ ? occ[i] : 255;
    out[p + 1] = mr ? mr[p + 1] : Math.round(pbr.rough * 255);
    out[p + 2] = mr ? mr[p + 2] : Math.round(pbr.metal * 255);
    out[p + 3] = 255;
  }
  return out;
}
/** Unity HDRP / URP mask map: R metallic, G occlusion, B detail mask, A smoothness (1 - roughness). */
export function packUnityMask(W, H, orm, detailMask = 255) {
  const out = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) { const p = i * 4; out[p] = orm[p + 2]; out[p + 1] = orm[p]; out[p + 2] = detailMask; out[p + 3] = 255 - orm[p + 1]; }
  return out;
}
/** Split an ORM / MR texture into greyscale maps {occlusion, roughness, metalness} (Roblox SurfaceAppearance). */
export function splitORM(W, H, orm) {
  const mk = (ch) => { const o = new Uint8ClampedArray(W * H * 4); for (let i = 0; i < W * H; i++) { const v = orm[i * 4 + ch]; o[i * 4] = v; o[i * 4 + 1] = v; o[i * 4 + 2] = v; o[i * 4 + 3] = 255; } return o; };
  return { occlusion: mk(0), roughness: mk(1), metalness: mk(2) };
}
/** Greyscale height texture (0..1 -> 0..255). */
export function heightTexture(W, H, h) {
  const out = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) { const v = Math.round(Math.max(0, Math.min(1, h[i])) * 255); out[i * 4] = v; out[i * 4 + 1] = v; out[i * 4 + 2] = v; out[i * 4 + 3] = 255; }
  return out;
}
/** Nearest-neighbour integer upscale (or power-of-two downscale) so the largest side fits `max` (Roblox filters bilinearly). */
export function fitTexture(W, H, data, max = 1024, upscale = true) {
  let k = 1;
  if (Math.max(W, H) > max) { let d = 1; while (Math.max(W, H) / d > max) d *= 2; const w = Math.max(1, Math.floor(W / d)), h = Math.max(1, Math.floor(H / d)); const out = new Uint8ClampedArray(w * h * 4); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out.set(data.subarray(((y * d) * W + x * d) * 4, ((y * d) * W + x * d) * 4 + 4), (y * w + x) * 4); return { width: w, height: h, data: out, scale: 1 / d }; }
  if (upscale) while (Math.max(W, H) * k * 2 <= max) k *= 2;
  if (k === 1) return { width: W, height: H, data, scale: 1 };
  const w = W * k, h = H * k, out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out.set(data.subarray((((y / k) | 0) * W + ((x / k) | 0)) * 4, (((y / k) | 0) * W + ((x / k) | 0)) * 4 + 4), (y * w + x) * 4);
  return { width: w, height: h, data: out, scale: k };
}

// ---------- export options ----------
export const PROFILES = ['three', 'roblox', 'minimal'];
export const PACKINGS = ['gltf_orm', 'roblox', 'unity_mask'];
/** Does this export need the v2 writer? (export options, or v2 data on any group texture). */
export function wantsV2(a, groups) {
  if (a.profile !== undefined || a.tangents || a.packing || a.vertex_colors || a.uv2 || a.uv3 || a.lightmap || a.thickness || (a.bake_ao && a.bake_ao.bent)) return true;
  for (const g of groups) if (g.tex && (g.tex.v2 || g.tex.aoData)) return true;
  return false;
}
export function normProfile(a) {
  if (a.profile !== undefined && !PROFILES.includes(a.profile)) throw new Error(`profile must be one of ${PROFILES.join(', ')} (three = everything, roblox = SurfaceAppearance maps <= 1024 px + meshes < 20k tris, minimal = geometry + base colour)`);
  if (a.packing !== undefined && !PACKINGS.includes(a.packing)) throw new Error(`packing must be one of ${PACKINGS.join(', ')}`);
  const profile = a.profile || null;
  const packing = a.packing || (profile === 'three' ? 'gltf_orm' : profile === 'roblox' ? 'roblox' : null);
  return { profile, packing, tangents: a.tangents ?? (profile === 'three' ? true : profile === 'roblox' ? false : profile === 'minimal' ? false : true) };
}

/** Vertex data option: true | {color0?, color1?} sets of "paint" | "masks" | "ao" | "height". */
const VSETS = ['paint', 'masks', 'ao', 'height'];
export function normVertexColors(v) {
  if (!v) return null;
  const o = v === true ? { color0: 'paint', color1: 'masks' } : typeof v === 'string' ? { color0: v } : v;
  if (typeof o !== 'object' || Array.isArray(o)) throw new Error('vertex_colors must be true or {color0?:"paint"|"masks"|"ao"|"height", color1?:...}');
  only(o, ['color0', 'color1'], 'vertex_colors');
  for (const k of ['color0', 'color1']) if (o[k] !== undefined && !VSETS.includes(o[k])) throw new Error(`vertex_colors.${k} must be one of ${VSETS.join(', ')}`);
  if (o.color1 && !o.color0) throw new Error('vertex_colors.color1 needs color0 (glTF COLOR_n sets are consecutive)');
  return o;
}
const UVSETS = ['world', 'box', 'lightmap', 'uv0'];
export function normUVSet(v, name) {
  if (v === undefined || v === null || v === false) return null;
  const s = v === true ? (name === 'uv2' ? 'world' : 'box') : v;
  if (!UVSETS.includes(s)) throw new Error(`${name} must be one of ${UVSETS.join(', ')} (world = planar world units along the face axis, box = model bounds 0..1, lightmap = TEXCOORD_1 copy, uv0 = copy)`);
  return s;
}

/**
 * Per-vertex data on the base groups of meshes (before welding): g.vattr = {COLOR_0, COLOR_1,
 * TEXCOORD_n: {size, data}}. Face props: paint (rgba 0..1), wet (0..1), set by part paint /
 * wetness. bounds (px) for "height" / "box". -> {mapping: {attribute: set}}
 */
export function attachVertexData(groups, { colors, uv2, uv3, bounds, scale }) {
  const mapping = {};
  const [mn, mx] = [bounds.min, bounds.max];
  const sz = mx.map((v, k) => v - mn[k] || 1);
  for (const g of groups) {
    if (g.overlay || !g.faces) continue;
    const vc = g.pos.length / 3, va = {};
    const per = new Array(vc).fill(null);
    for (const f of g.faces) for (let v = f.v; v < f.v + f.vc; v++) per[v] = f;
    const setData = (set) => {
      const d = new Float32Array(vc * 4);
      for (let i = 0; i < vc; i++) {
        const f = per[i] || {}, y = (g.pos[i * 3 + 1] - mn[1]) / sz[1], ao = g.ao ? g.ao[i] : 1;
        const c = set === 'paint' ? (f.paint || [1, 1, 1, 1]) : set === 'masks' ? [f.wet ?? 0, ao, Math.max(0, Math.min(1, y)), 1] : set === 'ao' ? [ao, ao, ao, 1] : [y, y, y, 1];
        d.set(c.map((x) => Math.max(0, Math.min(1, x))), i * 4);
      }
      return d;
    };
    if (colors?.color0) { va.COLOR_0 = { size: 4, data: setData(colors.color0) }; mapping.COLOR_0 = colors.color0; }
    if (colors?.color1) { va.COLOR_1 = { size: 4, data: setData(colors.color1) }; mapping.COLOR_1 = colors.color1; }
    let next = g.uv1 ? 2 : 1;
    for (const set of [uv2, uv3]) {
      if (!set) continue;
      const d = new Float32Array(vc * 2);
      for (let i = 0; i < vc; i++) {
        const f = per[i], n = f ? f.n : [0, 1, 0], p = [g.pos[i * 3], g.pos[i * 3 + 1], g.pos[i * 3 + 2]];
        const ax = Math.abs(n[0]) >= Math.abs(n[1]) && Math.abs(n[0]) >= Math.abs(n[2]) ? 0 : Math.abs(n[1]) >= Math.abs(n[2]) ? 1 : 2;
        const [a, b] = ax === 0 ? [2, 1] : ax === 1 ? [0, 2] : [0, 1];
        if (set === 'world') { d[i * 2] = p[a] / scale; d[i * 2 + 1] = -p[b] / scale; }
        else if (set === 'box') { d[i * 2] = (p[a] - mn[a]) / sz[a]; d[i * 2 + 1] = 1 - (p[b] - mn[b]) / sz[b]; }
        else if (set === 'lightmap') { d[i * 2] = g.uv1 ? g.uv1[i * 2] : 0; d[i * 2 + 1] = g.uv1 ? g.uv1[i * 2 + 1] : 0; }
        else { d[i * 2] = g.uv[i * 2]; d[i * 2 + 1] = g.uv[i * 2 + 1]; }
      }
      va[`TEXCOORD_${next}`] = { size: 2, data: d };
      mapping[`TEXCOORD_${next}`] = set;
      next++;
    }
    if (Object.keys(va).length) g.vattr = va;
  }
  return { mapping };
}

// ---------- the v2 glTF writer hooks ----------
const flickerDoc = 'three.js: const base = mat.emissiveIntensity; each frame mat.emissiveIntensity = base * emissiveLevel(anim, clock.elapsedTime) (docs/materials/README.md). pulse = min + (max-min) * (0.5 - 0.5 cos(2 pi hz t)); strobe = max while frac(hz t) < duty else min; flicker / sputter = seeded hash per 1/hz step (sputter drops to 0 sometimes).';

/**
 * Build the writer hooks for writeGLB. o: {profile, packing, tangents, scale, lightmap?, bent?,
 * thickness?, aoTexel?} -> hooks {hash, mr, material, prepare, attributes, finish, report}.
 */
export function makeV2(o) {
  const used = new Set();
  const report = { materials: {}, textures_deduped: 0, tangents: 0, split_vertices: 0 };
  const scale = o.scale;
  const minimal = o.profile === 'minimal', roblox = o.profile === 'roblox';
  return {
    profile: o.profile, packing: o.packing, report, used, bakedUV: !!(o.lightmap || o.bent || o.thickness),
    /** content hash for texture dedupe */
    hash(w, h, data) { return crypto.createHash('sha1').update(`${w}x${h}`).update(Buffer.from(data.buffer, data.byteOffset, data.byteLength)).digest('hex'); },
    deduped() { report.textures_deduped++; },
    /** metallicRoughness texture under the packing profile; may stash an ORM for occlusion. */
    mr(t, texture, name, ik, m) {
      if (o.packing === 'gltf_orm' || o.packing === 'unity_mask') {
        const occ = materialOcclusion(t);
        const orm = packORM(t.width, t.height, t.mr, occ);
        const info = texture(`${t.mrKey ?? ik + '#mr'}#orm`, t.width, t.height, orm, name + '_orm');
        m._orm = { info, occ: !!occ, data: orm };
        return info;
      }
      return texture(t.mrKey ?? ik + '#mr', t.width, t.height, t.mr, name + '_mr');
    },
    /** extensions + extras on a finished glTF material (before it is pushed). */
    material(m, t, { texture, overlay, noAO, name, ik }) {
      const v2 = !overlay ? t.v2 || null : null;
      const info = {};
      const ext = (k, body) => { m.extensions = { ...(m.extensions || {}), [k]: body }; used.add(k); info[k] = body; };
      const extras = (k, v) => { m.extras = { ...(m.extras || {}), [k]: v }; };
      const pbr = m.pbrMetallicRoughness;
      // ORM: occlusion shares the packed texture (texCoord 0) unless a baked AO lightmap holds it
      if (!overlay && (o.packing === 'gltf_orm' || o.packing === 'unity_mask')) {
        if (!m._orm && t.aoData) {
          const occ = materialOcclusion(t), orm = packORM(t.width, t.height, null, occ, t.pbr || { metal: pbr.metallicFactor, rough: pbr.roughnessFactor });
          m._orm = { info: texture(`${ik}#orm`, t.width, t.height, orm, name + '_orm'), occ: true, data: orm };
          pbr.metallicRoughnessTexture = m._orm.info; pbr.metallicFactor = 1; pbr.roughnessFactor = 1;
        }
        if (m._orm && m._orm.occ && !m.occlusionTexture) m.occlusionTexture = { ...m._orm.info };
        if (m._orm) info.orm = { texture: m._orm.info.index, occlusion: m.occlusionTexture ? (m.occlusionTexture.texCoord === 1 ? 'baked AO (TEXCOORD_1)' : 'ORM red') : 'none' };
        if (m._orm && o.packing === 'unity_mask') { const mk = packUnityMask(t.width, t.height, m._orm.data, t.detail ? Math.round(t.detail.strength * 255) : 255); extras('unityMaskTexture', texture(`${ik}#unity`, t.width, t.height, mk, name + '_mask')); info.unity_mask = true; }
      }
      delete m._orm;
      if (v2 && !minimal && !roblox) {
        if (v2.emissive) {
          const e = v2.emissive;
          if (e.color) {
            m.emissiveFactor = e.color;
            if (t.emissive && e.mask !== false) m.emissiveTexture = texture(`${t.emissiveKey ?? ik + '#e'}#mask`, t.width, t.height, emissiveMask(t.width, t.height, t.emissive), name + '_emissive_mask');
            else delete m.emissiveTexture;
          } else if (!m.emissiveFactor) m.emissiveFactor = [1, 1, 1];
          if (!m.emissiveTexture && !e.color) m.emissiveTexture = texture(`${ik}#self`, t.width, t.height, t.data, name + '_emissive');
          if (e.strength !== 1) ext('KHR_materials_emissive_strength', { emissiveStrength: f5(e.strength) });
          if (e.animate) extras('emissiveAnimation', { ...e.animate, base_strength: e.strength, usage: flickerDoc });
          info.emissive = { strength: e.strength, ...(e.color ? { color: e.color } : {}), ...(e.animate ? { animate: e.animate.mode } : {}) };
        }
        if (v2.clearcoat) ext('KHR_materials_clearcoat', { clearcoatFactor: v2.clearcoat.factor, clearcoatRoughnessFactor: v2.clearcoat.rough });
        if (v2.anisotropy) {
          const a = v2.anisotropy, body = { anisotropyStrength: a.strength, anisotropyRotation: f5((a.rotation * Math.PI) / 180) };
          if (a.pattern !== 'flat') { const W = t.width * t.height > 1 ? t.width : 16, H = t.width * t.height > 1 ? t.height : 16; body.anisotropyTexture = texture(`aniso:${a.pattern}:${W}x${H}`, W, H, anisotropyTexture(W, H, a.pattern), `anisotropy_${a.pattern}`); }
          ext('KHR_materials_anisotropy', body);
        }
        if (v2.transmission) {
          const tr = v2.transmission;
          ext('KHR_materials_transmission', { transmissionFactor: tr.factor });
          if (tr.thickness > 0 || tr.attenuation) ext('KHR_materials_volume', { thicknessFactor: f5(tr.thickness / scale), ...(tr.attenuation ? { attenuationColor: tr.attenuation.color, attenuationDistance: f5(tr.attenuation.distance / scale) } : {}) });
          // transmission is physically see-through: an opaque surface, not alpha blending
          if (m.alphaMode === 'BLEND' && !(t.material && t.material.opacity < 1 && !t.material.glass)) { delete m.alphaMode; if (pbr.baseColorFactor) delete pbr.baseColorFactor; if (m.extras) { delete m.extras.transparent; delete m.extras.depthWrite; delete m.extras.opacity; } }
        }
        if (v2.ior !== undefined) ext('KHR_materials_ior', { ior: v2.ior });
        if (v2.sheen) ext('KHR_materials_sheen', { sheenColorFactor: v2.sheen.color, sheenRoughnessFactor: v2.sheen.rough });
        if (v2.subsurface) {
          ext('KHR_materials_diffuse_transmission', { diffuseTransmissionFactor: v2.subsurface.factor, diffuseTransmissionColorFactor: v2.subsurface.color });
          if (o.thickness && !noAO) extras('thicknessTexture', { ...texture('sss#thickness', o.thickness.width, o.thickness.height, o.thickness.data, 'thickness'), texCoord: 1, scale: f5(o.thickness.distance / scale), usage: 'SSS thickness on TEXCOORD_1 (white = thick = less light through): transmitted light *= exp(-thickness_units * k) (docs/materials/README.md)' });
        }
        if (v2.detail && t.detail) {
          const d = t.detail;
          const det = { texture: texture(`detail:${d.key}`, d.width, d.height, d.data, `detail_${d.name}`), scale: d.scale, strength: d.strength, uv_scale: [f5((t.width * d.scale) / d.width), f5((t.height * d.scale) / d.height)], usage: 'detail uv = uv0 * uv_scale (scale = detail texels per base texel); albedo *= mix(1, 2 * detail.rgb, strength) with the detail texture read as linear data (mid grey = no change); normal += TBN * (detail normal.xy * strength) (docs/materials/README.md)' };
          if (d.normal) det.normal = texture(`detailn:${d.key}`, d.width, d.height, d.normal, `detail_${d.name}_normal`);
          extras('detail', det);
          info.detail = { scale: d.scale, strength: d.strength };
        }
      }
      // height texture for parallax (three profile: every material with a height source; or material height)
      if (!overlay && !minimal && !roblox && t.heightOf && (v2?.height || o.profile === 'three')) {
        const h = t.heightOf();
        if (h) {
          const hs = v2?.height || { scale: 2, bias: 0 };
          extras('heightTexture', { ...texture(`${ik}#height`, t.width, t.height, heightTexture(t.width, t.height, h), name + '_height'), texCoord: 0, scale: f5(hs.scale / scale), bias: f5(hs.bias / scale), uv_per_unit: [f5(scale / t.width), f5(scale / t.height)], usage: 'surface offset along the normal = (height * scale + bias) units; POM depth = scale. three.js snippet: docs/materials/README.md (pixel-snapped parallax occlusion)' });
          info.height = { scale_px: hs.scale };
        }
      }
      // baked light (TEXCOORD_1, unique charts): lightmap, bent normals
      const opaque = !(m.alphaMode === 'BLEND');
      if (!overlay && !noAO && opaque && o.lightmap && !minimal && !roblox) {
        const L = o.lightmap;
        extras('lightMap', { ...texture('lm#map', L.width, L.height, L.data, 'lightmap'), texCoord: 1, intensity: f5(L.range * Math.PI), range: L.range, encoding: 'sRGB', usage: 'three.js: mat.lightMap = tex (channel 1, colorSpace SRGB, NEAREST, flipY false); mat.lightMapIntensity = extras.lightMap.intensity (= range * PI: texel 1 = albedo x range)' });
      }
      if (!overlay && !noAO && opaque && o.bent && !minimal && !roblox) extras('bentNormalTexture', { ...texture('ao#bent', o.bent.width, o.bent.height, o.bent.data, 'bent_normals'), texCoord: 1, space: 'object', usage: 'object-space bent normal (rgb * 2 - 1, mesh local frame): ambient / env lookups use it instead of the normal; specular occlusion = saturate(dot(bent, R) * 0.5 + ao) (docs/materials/README.md)' });
      if (Object.keys(info).length) report.materials[name] = info;
    },
    /** per primitive before its attributes are written: tangents (may split vertices). */
    prepare(p) {
      if (p.overlay || minimal) return p;
      const t = p.tex;
      const needs = o.tangents && (t.normal || (t.v2 && (t.v2.anisotropy || t.v2.detail || t.v2.height)) || (o.profile === 'three' && t.heightOf));
      if (!needs) return p;
      const r = computeTangents(p, { uv1: 2, ao: 1, dmg: 4, uvd: 2 });
      r.prim.tangent = r.tangent;
      report.tangents++;
      report.split_vertices += r.split;
      return r.prim;
    },
    /** extra attributes (TANGENT, colour sets, UV sets). */
    attributes(p, attributes, write) {
      if (p.tangent) attributes.TANGENT = write(p.tangent, 'VEC4');
      if (p.vattr) for (const [k, a] of Object.entries(p.vattr)) attributes[k] = write(a.data, a.size === 4 ? 'VEC4' : a.size === 3 ? 'VEC3' : 'VEC2');
    },
    /** extensionsUsed (sorted, after the 0.7 ones). */
    finish(json) {
      if (used.size) json.extensionsUsed = [...new Set([...(json.extensionsUsed || []), ...[...used].sort()])];
    },
  };
}
