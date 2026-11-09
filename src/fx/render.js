// art_fx pipeline: options -> frames -> flipbook sheet (<= 1024 px, Roblox grid) + engine metadata,
// and the metadata schema check every export goes through.
import { FX, FX_TYPES, WEAPONS, SURFACES, FP_FRAME, FP_MUZZLE, FP_AIMS, FP_AIM_STEP } from './effects.js';
import { DECAL_KINDS, decalAtlas } from './decals.js';
import { fields, resolve, packSheet, lockRamp, colorsOf, seedOf, MAX_TEX, frameDiff } from './raster.js';
import { RECIPES } from '../audio/sfx.js';

export const BLENDS = ['additive', 'alpha', 'premultiplied', 'distortion', 'mixed'];
export const FACINGS = ['camera', 'camera_up', 'camera_axis', 'velocity', 'surface', 'screen'];
export const ALL_TYPES = [...FX_TYPES, 'decal'];
export const MUZZLE_VIEWS = ['side', 'front_side', 'back_side', 'front', 'fp'];
const DEG = Math.PI / 180;
const HEX = /^#[0-9a-f]{6}$/i;
const ID_RE = /^[A-Za-z0-9_\-.]{1,64}$/;

/** Normalised options for one effect (throws on bad input before any rendering). */
export function normFx(a = {}) {
  const type = a.type;
  if (!ALL_TYPES.includes(type)) throw new Error(`type must be one of ${ALL_TYPES.join(', ')} (got ${JSON.stringify(type)})`);
  const o = { type, seed: a.seed ?? 1, hue: Number(a.hue ?? 0), palette: a.palette_rgb ?? null };
  if (!Number.isFinite(o.hue)) throw new Error('"hue" must be a number (degrees)');
  if (type === 'decal') {
    const kinds = a.variant === undefined || a.variant === 'all' ? Object.keys(DECAL_KINDS) : [].concat(a.variant);
    for (const k of kinds) if (!DECAL_KINDS[k]) throw new Error(`decal variant: all | ${Object.keys(DECAL_KINDS).join(' | ')} (or a list; got "${k}")`);
    o.variant = a.variant === undefined || a.variant === 'all' ? 'all' : kinds.join('+'); o.kinds = kinds;
    o.variants = Math.round(Number(a.variants ?? 4));
    if (!(o.variants >= 1 && o.variants <= 16)) throw new Error('"variants" must be 1..16');
    o.cell = [Math.round(Number(a.size ?? 32)), Math.round(Number(a.size ?? 32))];
    o.id = a.name ?? (o.variant === 'all' ? 'decals' : `decal_${kinds.join('_')}`);
    if (!ID_RE.test(o.id)) throw new Error('"name" must be 1-64 chars of letters, digits, _ - .');
    return o;
  }
  const T = FX[type];
  o.variant = a.variant ?? T.variants[0];
  if (!T.variants.includes(o.variant)) throw new Error(`${type} variant must be one of ${T.variants.join(', ')} (got ${JSON.stringify(o.variant)})`);
  if (type === 'muzzle') {
    o.view = a.view ?? 'side';
    if (!MUZZLE_VIEWS.includes(o.view)) throw new Error(`muzzle view: ${MUZZLE_VIEWS.join(' | ')}`);
    o.suppressed = !!a.suppressed;
    const anchor = a.anchor ?? FP_MUZZLE, frame = a.frame_size ?? FP_FRAME;
    o.aim = a.aim_deg !== undefined ? (Number(a.aim_deg) * Math.PI) / 180 : Math.atan2(frame[1] / 2 - anchor[1], frame[0] / 2 - anchor[0]);
    if (!Number.isFinite(o.aim)) throw new Error('"aim_deg" / "anchor" must be numbers');
    if (o.view === 'fp') { o.aims = aimList(a.aims, o.aim); if (Array.isArray(a.aims)) o.aim = o.aims[nearestAim(o.aims, o.aim)]; }
    else if (a.aims !== undefined) throw new Error('"aims" is for view:"fp" (first-person flashes)');
  }
  if (a.color !== undefined) { if (!HEX.test(a.color)) throw new Error('"color" must be #rrggbb'); o.color = a.color; }
  if (type === 'strobe') { o.mode = a.mode ?? 'pulse'; if (!['pulse', 'beacon'].includes(o.mode)) throw new Error('strobe mode: pulse | beacon'); }
  const d = T.defaults(o);
  let cell = d.cell;
  if (a.size !== undefined) {
    const s = [].concat(a.size).map((v) => Math.round(Number(v)));
    cell = s.length === 1 ? (d.cell[0] === d.cell[1] ? [s[0], s[0]] : [s[0], Math.max(4, Math.round((s[0] * d.cell[1]) / d.cell[0]))]) : s;
  }
  if (!(cell.length === 2 && cell.every((v) => v >= 4 && v <= 256))) throw new Error('"size" must be 4..256 px (or [w, h])');
  if (type === 'particles' && (cell[0] !== 8 || cell[1] !== 8)) throw new Error('particles cells are fixed at 8x8');
  o.cell = cell;
  o.frames = type === 'particles' ? FX.particles.cells.length : Math.round(Number(a.frames ?? d.frames));
  if (!(o.frames >= 1 && o.frames <= 64)) throw new Error('"frames" must be 1..64');
  o.fps = Number(a.fps ?? d.fps);
  if (!(Number.isFinite(o.fps) && o.fps >= 1 && o.fps <= 120)) throw new Error('"fps" must be 1..120');
  o.loop = d.loop; o.blend = d.blend;
  o.id = a.name ?? [type, o.variant, o.view, o.suppressed ? 'sup' : null, o.mode && o.mode !== 'pulse' ? o.mode : null].filter(Boolean).join('_');
  if (!ID_RE.test(o.id)) throw new Error('"name" must be 1-64 chars of letters, digits, _ - .');
  return o;
}

/**
 * fp aim variants (radians, sorted, the base aim included): aims = N (1..9, spread FP_AIM_STEP deg
 * around the base aim; default FP_AIMS) | [deg, ...] (explicit screen angles) | false / 1 = one.
 */
function aimList(v, base) {
  if (v === false || v === 1) return [base];
  const wrap = (r) => Math.atan2(Math.sin(r), Math.cos(r));
  let list;
  if (Array.isArray(v)) {
    if (!v.length || v.length > 9 || !v.every((x) => typeof x === 'number' && Number.isFinite(x))) throw new Error('"aims" must be 1..9 (variants around the base aim) or a list of 1-9 screen angles in degrees');
    list = v.map((d) => wrap(d * DEG));
  } else {
    const n = v === undefined ? FP_AIMS : Math.round(Number(v));
    if (!(n >= 1 && n <= 9)) throw new Error('"aims" must be 1..9 (variants around the base aim) or a list of 1-9 screen angles in degrees');
    list = Array.from({ length: n }, (_, k) => (k === (n - 1) / 2 ? base : wrap(base + (k - (n - 1) / 2) * FP_AIM_STEP * DEG)));
  }
  const seen = new Set();
  return list.filter((r) => { const k = Math.round(r / DEG * 100); if (seen.has(k)) return false; seen.add(k); return true; }).sort((x, y) => x - y);
}
/** Index of the aim variant nearest a screen angle (radians). */
export function nearestAim(aims, r) {
  let best = 0, bd = Infinity;
  aims.forEach((a, i) => { const d = Math.abs(Math.atan2(Math.sin(r - a), Math.cos(r - a))); if (d < bd - 1e-9) { bd = d; best = i; } });
  return best;
}

/** Time of frame k: loops sample [0, 1) (frame N would be frame 0), one-shots [0, 1]. */
export const frameTime = (o, k) => (o.loop ? k / o.frames : o.frames > 1 ? k / (o.frames - 1) : 0);

function rampsOf(o) {
  const R = FX[o.type].ramps(o);
  return { E: R.E.map((r) => lockRamp(r, o.palette)), M: R.M.map((r) => lockRamp(r, o.palette)) };
}
/** One frame at any time t (tests: loop continuity t = 1 vs 0). -> RGBA Uint8ClampedArray */
export function renderAt(o, t, k = 0, cache = {}) {
  const T = FX[o.type], st = cache.st ?? (cache.st = T.build(o));
  if (T.raw) return T.raw(o, st, t);
  const F = fields(o.cell[0], o.cell[1]);
  T.frame(F, o, st, t, k);
  return resolve(F, cache.ramps ?? (cache.ramps = rampsOf(o)), { blend: o.blend === 'mixed' ? (T.cellBlend?.[T.cells?.[k]] ?? 'alpha') : o.blend });
}

/** Render every frame + the sheet + metadata. -> {o, frames, sheet, straight?, meta} (meta.file filled by the caller). */
export function renderFx(o) {
  if (o.type === 'decal') return renderDecals(o);
  const cache = {}, frames = [];
  for (let k = 0; k < o.frames; k++) frames.push(renderAt(o, frameTime(o, k), k, cache));
  const sheet = packSheet(frames, o.cell[0], o.cell[1]);
  const straight = straightOf(o, sheet);
  // fp aim variants: the base aim is the main sheet; every other aim is drawn again (same seed,
  // same particles), never a rotated bitmap
  const variants = [];
  if (o.aims && o.aims.length > 1) {
    for (const aim of o.aims) {
      if (aim === o.aim) { variants.push({ aim, base: true }); continue; }
      const ov = { ...o, aim }, c2 = {}, fr = [];
      for (let k = 0; k < o.frames; k++) fr.push(renderAt(ov, frameTime(o, k), k, c2));
      const sh = packSheet(fr, o.cell[0], o.cell[1]);
      variants.push({ aim, sheet: sh, straight: straightOf(o, sh), frames: fr });
    }
  }
  const T = FX[o.type], m = T.meta(o), dur = Math.round((o.frames / o.fps) * 1000);
  if (variants.length) m.fp = { ...m.fp, aims: variants.map((v) => ({ aim_deg: +(v.aim / DEG).toFixed(2), file: null, ...(o.blend === 'premultiplied' ? { straight: null } : {}) })), pick: 'nearest aim_deg to the muzzle\'s screen aim (deg, atan2 of anchor -> frame centre; or the socket rotation)' };
  const meta = {
    id: o.id, type: o.type, variant: o.variant, ...(o.view ? { view: o.view } : {}), ...(o.type === 'muzzle' ? { suppressed: o.suppressed } : {}), ...(o.mode ? { mode: o.mode } : {}),
    seed: o.seed, file: null, sheet: [sheet.width, sheet.height], cell: o.cell, grid: [sheet.grid.cols, sheet.grid.rows], frames: o.frames, fps: o.fps, loop: o.loop, duration_ms: dur, blend: o.blend,
    pivot: m.pivot, pivot_uv: [+(m.pivot[0] / o.cell[0]).toFixed(4), +(m.pivot[1] / o.cell[1]).toFixed(4)], facing: m.facing, size_m: m.size_m, px_per_m: +(o.cell[0] / m.size_m).toFixed(2),
    emitters: m.emitters ?? [], light: m.light ?? null, fp: m.fp ?? null, sound: m.sound ?? [], ...(m.decal !== undefined ? { decal: m.decal } : {}),
    ...(m.cells ? { cells: m.cells, cell_blend: m.cell_blend } : {}), ...(m.views ? { views: m.views } : {}),
    roblox: {
      flipbook: sheet.grid.roblox ?? null, light_emission: o.blend === 'additive' ? 1 : o.blend === 'premultiplied' ? 0.5 : 0, file: null,
      note: sheet.grid.roblox ? `ParticleEmitter: FlipbookLayout ${sheet.grid.roblox}, FlipbookMode ${o.loop ? 'Loop' : 'OneShot'}, Lifetime ${(dur / 1000).toFixed(2)} s` : o.cell[0] !== o.cell[1] ? 'non-square cells: use a Beam (tracers) or a SurfaceGui / ImageLabel with ImageRectOffset per frame' : `pad: ${sheet.grid.padded} empty cells; use 4, 16 or 64 frames for an exact flipbook`,
    },
    palette_locked: !!o.palette && m.palette_locked !== false, colors: colorsOf([sheet.data]).length,
    ...(m.notes ? { notes: m.notes } : {}),
  };
  return { o, frames, sheet, straight, meta, ...(variants.length ? { variants } : {}) };
}
/** Roblox / straight-alpha fallback of a premultiplied sheet: glow pixels (alpha 0, colour set) become opaque. */
function straightOf(o, sheet) {
  if (o.blend !== 'premultiplied') return null;
  const s = { ...sheet, data: sheet.data.slice() };
  for (let i = 0; i < s.data.length; i += 4) if (!s.data[i + 3] && (s.data[i] | s.data[i + 1] | s.data[i + 2])) s.data[i + 3] = 255;
  return s;
}

function renderDecals(o) {
  const A = decalAtlas({ kinds: o.kinds, variants: o.variants, cell: o.cell[0], seed: o.seed, palette: o.palette, hue: o.hue });
  const meta = {
    id: o.id, type: 'decal', variant: o.variant, seed: o.seed, file: null, maps: { albedo: null, normal: null, height: null, emissive: null }, sheet: [A.width, A.height], cell: o.cell, grid: [o.variants, o.kinds.length],
    frames: 1, fps: 0, loop: false, duration_ms: 0, blend: 'alpha', pivot: [o.cell[0] / 2, o.cell[1] / 2], pivot_uv: [0.5, 0.5], facing: 'surface', size_m: 0.12 * (o.cell[0] / 32), px_per_m: +(o.cell[0] / (0.12 * (o.cell[0] / 32))).toFixed(2),
    emitters: [], light: null, fp: null, sound: [], cells: A.cells, kinds: Object.fromEntries(o.kinds.map((k) => [k, DECAL_KINDS[k].about])),
    material: { alpha_test: 0.5, normal_scale: 1, height_scale_m: 0.01, emissive_strength: A.emissive ? 4 : 0, polygon_offset: [-1, -4], notes: 'height: 0.5 = the surface (128 grey); normal: tangent space, +Y up (OpenGL / three.js); scorch / energy_burn sized ~4x a bullet hole in the world (scale the quad, not the texels)' },
    roblox: { flipbook: null, light_emission: 0, file: null, note: 'Decal / SurfaceAppearance on a small part (ColorMap = albedo cell, NormalMap = normal cell): crop cells into separate images, Roblox has no UV rect for decals' },
    palette_locked: !!o.palette, colors: colorsOf([A.albedo]).length,
  };
  return { o, decal: A, meta };
}

// ---------- schema ----------
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const pair = (v, lo = -Infinity) => Array.isArray(v) && v.length === 2 && v.every(isNum) && v[0] <= v[1] && v[0] >= lo;
const curve = (c, check, tmax = 1) => Array.isArray(c) && c.length >= 1 && c.every((p, i) => Array.isArray(p) && p.length === 2 && isNum(p[0]) && p[0] >= 0 && p[0] <= tmax && (i === 0 || p[0] >= c[i - 1][0]) && check(p[1]));
/** -> list of problems (empty = valid). */
export function validateFxMeta(m) {
  const e = [], req = (c, msg) => { if (!c) e.push(`${m?.id ?? '?'}: ${msg}`); };
  if (!m || typeof m !== 'object') return ['meta must be an object'];
  req(typeof m.id === 'string' && ID_RE.test(m.id), 'id');
  req(ALL_TYPES.includes(m.type), 'type');
  req(BLENDS.includes(m.blend), 'blend');
  req(Number.isInteger(m.frames) && m.frames >= 1 && m.frames <= 64, 'frames 1..64');
  req(isNum(m.fps) && m.fps >= 0, 'fps');
  req(typeof m.loop === 'boolean', 'loop boolean');
  req(Array.isArray(m.cell) && m.cell.length === 2 && m.cell.every((v) => Number.isInteger(v) && v > 0), 'cell [w, h]');
  req(Array.isArray(m.sheet) && m.sheet.every((v) => Number.isInteger(v) && v > 0 && v <= MAX_TEX), `sheet <= ${MAX_TEX} px`);
  req(Array.isArray(m.grid) && m.grid.length === 2 && m.grid[0] * m.cell?.[0] <= m.sheet?.[0] && m.grid[1] * m.cell?.[1] <= m.sheet?.[1], 'grid fits the sheet');
  req(m.type === 'decal' || m.frames <= m.grid?.[0] * m.grid?.[1], 'frames fit the grid');
  req(Array.isArray(m.pivot) && m.pivot.length === 2 && m.pivot[0] >= 0 && m.pivot[1] >= 0 && m.pivot[0] <= m.cell?.[0] && m.pivot[1] <= m.cell?.[1], 'pivot inside the cell');
  req(FACINGS.includes(m.facing), 'facing');
  req(isNum(m.size_m) && m.size_m > 0, 'size_m > 0');
  req(typeof m.file === 'string' && m.file.endsWith('.png'), 'file');
  req(Array.isArray(m.sound) && m.sound.every((s) => typeof s === 'string' && RECIPES[s]), 'sound = art_audio recipe names');
  req(Array.isArray(m.emitters), 'emitters list');
  for (const [i, x] of (m.emitters || []).entries()) {
    const w = (c, msg) => req(c, `emitters[${i}].${msg}`);
    w(typeof x.cell === 'string' && /^(particles|fx):[a-z0-9_]+$/.test(x.cell), 'cell = particles:<name> | fx:<id>');
    w(pair(x.count, 0), 'count [min, max]');
    w(x.rate_per_s === undefined || (isNum(x.rate_per_s) && x.rate_per_s > 0), 'rate_per_s');
    w(x.velocity && Array.isArray(x.velocity.dir) && x.velocity.dir.length === 3 && x.velocity.dir.every(isNum) && isNum(x.velocity.cone_deg) && x.velocity.cone_deg >= 0 && x.velocity.cone_deg <= 180 && pair(x.velocity.speed_mps, 0), 'velocity {dir, cone_deg, speed_mps}');
    w(isNum(x.gravity_mps2), 'gravity_mps2');
    w(isNum(x.drag) && x.drag >= 0, 'drag');
    w(pair(x.lifetime_s, 0), 'lifetime_s');
    w(curve(x.size_over_life, (v) => isNum(v) && v >= 0), 'size_over_life [[t, s]]');
    w(curve(x.color_over_life, (v) => HEX.test(v)), 'color_over_life [[t, #hex]]');
    w(x.alpha_over_life === undefined || curve(x.alpha_over_life, (v) => isNum(v) && v >= 0 && v <= 1), 'alpha_over_life');
  }
  if (m.light !== null) req(m.light && HEX.test(m.light.color) && isNum(m.light.radius_m) && m.light.radius_m > 0 && curve(m.light.intensity, (v) => isNum(v) && v >= 0, Infinity), 'light {color, radius_m, intensity [[ms, v]]} | null');
  if (m.fp !== null) req(m.fp && (!m.fp.shake || (isNum(m.fp.shake.amp_px) && isNum(m.fp.shake.decay_ms))) && (!m.fp.flash || (HEX.test(m.fp.flash.color) && isNum(m.fp.flash.alpha) && isNum(m.fp.flash.ms))), 'fp {shake, flash} | null');
  if (m.fp?.aims !== undefined) req(Array.isArray(m.fp.aims) && m.fp.aims.length >= 2 && m.fp.aims.every((v, i) => isNum(v.aim_deg) && (v.file === null || (typeof v.file === 'string' && v.file.endsWith('.png'))) && (i === 0 || v.aim_deg > m.fp.aims[i - 1].aim_deg)) && (m.fp.aims.every((v) => v.file === null) || m.fp.aims.some((v) => v.file === m.file)) && m.fp.aims.some((v) => Math.abs(v.aim_deg - m.fp.aim_deg) < 0.01), 'fp.aims [{aim_deg (ascending), file (null until written)}] including the base sheet');
  if (m.views !== undefined) req(m.views && typeof m.views === 'object' && ['E', 'W', 'SE', 'SW', 'NE', 'NW', 'S', 'N'].every((k) => m.views[k] && typeof m.views[k].fx === 'string'), 'views {E, W, SE, SW, NE, NW, S, N: {fx, flip_x?}}');
  req(m.roblox && 'flipbook' in m.roblox && isNum(m.roblox.light_emission), 'roblox');
  if (m.type === 'decal') req(m.maps && typeof m.maps.albedo === 'string' && typeof m.maps.normal === 'string' && typeof m.maps.height === 'string' && m.cells && typeof m.cells === 'object', 'decal maps + cells');
  return e;
}

/**
 * Loop seam score: the jump last -> first frame against the largest jump between consecutive frames.
 * <= 1 means the wrap is no bigger than any step inside the loop.
 */
export function loopSeam(frames) {
  if (frames.length < 3) return 0;
  let mx = 0;
  for (let k = 1; k < frames.length; k++) mx = Math.max(mx, frameDiff(frames[k - 1], frames[k]));
  return mx ? frameDiff(frames[frames.length - 1], frames[0]) / mx : 0;
}

// ---------- batch presets ----------
/** Every effect: all muzzle classes x views (+ suppressed side), every other type x variant, decal atlas, particles. */
export function presetItems(name = 'all') {
  const items = [];
  if (name === 'all' || name === 'muzzle') for (const c of Object.keys(WEAPONS)) {
    for (const view of ['side', 'front', 'fp']) items.push({ type: 'muzzle', variant: c, view });
    if (!['launcher', 'energy', 'plasma'].includes(c)) items.push({ type: 'muzzle', variant: c, view: 'side', suppressed: true });
    // 0.9.1: every 8-way facing has its own sprite (3/4 views, suppressed front / 3/4)
    for (const view of ['front_side', 'back_side']) items.push({ type: 'muzzle', variant: c, view });
    if (!['launcher', 'energy', 'plasma'].includes(c)) for (const view of ['front_side', 'back_side', 'front']) items.push({ type: 'muzzle', variant: c, view, suppressed: true });
  }
  if (name === 'muzzle') return items;
  if (name === 'impact') return Object.keys(SURFACES).map((s) => ({ type: 'impact', variant: s }));
  if (name !== 'all') throw new Error('preset: all | muzzle | impact');
  for (const t of FX_TYPES) if (t !== 'muzzle') for (const v of FX[t].variants) items.push({ type: t, variant: v });
  items.push({ type: 'strobe', variant: 'red', mode: 'beacon' });
  items.push({ type: 'decal' });
  return items;
}
export { seedOf };
