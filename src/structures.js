// Structural, neon and light builders for art_model (ships, stations, colonies, cities):
// truss / girder generator with cross-bracing, beams, revolve (dishes, tanks, domes), rocks,
// wing panels, catwalks with grating and railings, landing pads with markings, neon tube text /
// shapes (pixel font or a canvas), lit sign boxes, hologram cards, fog / god-ray cards (additive,
// soft banded falloff) and light / marker points (exported as node extras).
//
// Builders are plain function declarations (hoisted), so model3d.js can register them even when
// this module is imported first.
import { Mesh, uvFace, boxFaces, faceTexer, mT, mRX, mRY, mRZ, matMul } from './model3d.js';
import { sweep } from './sweep.js';
import { mulberry32, hash3, BAYER4 } from './util.js';
import { FONTS } from './fonts.js';
import { parseColor } from './color.js';

const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const norm = (a) => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const num = (v, d, name) => { const x = Number(v ?? d); if (!Number.isFinite(x)) throw new Error(`"${name}" must be a number (got ${JSON.stringify(v)})`); return x; };
const pos = (v, d, name) => { const x = num(v, d, name); if (!(x > 0)) throw new Error(`"${name}" must be > 0`); return x; };
const v3 = (v, d, name) => { if (v === undefined || v === null) return d; if (!Array.isArray(v) || v.length !== 3 || v.some((x) => !Number.isFinite(Number(x)))) throw new Error(`${name} must be [x,y,z] px`); return v.map(Number); };
const rgba = (c) => { const p = parseColor(c); return [p[0], p[1], p[2], p[3] ?? 255]; };

// ---------- generated textures (procedural pixel textures; no canvas needed) ----------
/** A texture object made in code (cached per ctx by key). paint(data, w, h) fills RGBA. */
export function genTex(ctx, key, w, h, paint, extra = {}) {
  const cache = ctx.genCache || (ctx.genCache = new Map());
  if (cache.has(key)) return cache.get(key);
  const data = new Uint8ClampedArray(w * h * 4);
  const r = paint(data, w, h) || {};
  const t = { key: `gen:${key}`, name: key.replace(/[^A-Za-z0-9_]+/g, '_').slice(0, 48), width: w, height: h, data, gen: true, ...r, ...extra };
  cache.set(key, t);
  return t;
}
/** ctx whose tex() also accepts generated texture objects. */
export const withGen = (ctx) => (ctx.genAware ? ctx : { ...ctx, genAware: true, tex: (r) => (r && typeof r === 'object' && r.gen ? r : ctx.tex(r)) });
/** Emissive variant of a colour / texture: the albedo glows (neon, screens, glow strips). */
export function glowTex(ctx, ref) {
  const base = ctx.tex(ref ?? '#ff3fd0');
  const cache = ctx.genCache || (ctx.genCache = new Map());
  const k = `${base.key}#glow`;
  if (!cache.has(k)) cache.set(k, { ...base, key: k, name: `${base.name || 'c'}_glow`, imageKey: base.imageKey ?? base.key, emissive: base.data, emissiveKey: `${base.imageKey ?? base.key}#self`, gen: true });
  return cache.get(k);
}
const ADDITIVE = (opacity = 0.8) => ({ opacity, glass: false, double_sided: true, blend: true, additive: true });

// ---------- beams ----------
/** Square (or n-sided) beam from A to B, thickness s px: 4 side faces (+ caps), world-tiled. */
export function beamFaces(m, tex, A, B, s, { up = null, caps = false, sides = 4 } = {}) {
  const d = sub(B, A), l = len(d);
  if (l < 1e-6) return m;
  const ax = mul(d, 1 / l);
  let u = up || (Math.abs(ax[1]) > 0.9 ? [0, 0, 1] : [0, 1, 0]);
  u = norm(sub(u, mul(ax, dot(u, ax))));
  const v = cross(ax, u), h = s / 2;
  const ring = [];
  for (let k = 0; k < sides; k++) { const a = (2 * Math.PI * (k + 0.5)) / sides, c = Math.cos(a) * h * Math.SQRT2, sn = Math.sin(a) * h * Math.SQRT2; ring.push(add(mul(u, c), mul(v, sn))); }
  for (let k = 0; k < sides; k++) {
    const p = ring[k], q = ring[(k + 1) % sides];
    const P = [add(A, p), add(A, q), add(B, q), add(B, p)];
    const n = norm(add(p, q));
    m.face(tex, P, n, uvFace(P, n, tex, true), n, 1);
  }
  if (caps) for (const [E, n] of [[A, mul(ax, -1)], [B, ax]]) { const P = ring.map((r) => add(E, r)); m.face(tex, P, n, uvFace(P, n, tex, true), n, 1); }
  return m;
}

/**
 * Truss / girder / scaffold: chords along from -> to (or length along axis), bays of `bay` px,
 * section box (4 chords) | tri (3) | flat (2, a planar girder), bracing warren (zigzag) | pratt
 * (verticals + diagonals) | x (cross-braced) | k, frames at every bay, chord / brace sizes px.
 */
export function truss(a, ctx) {
  let A = v3(a.from, null, 'from'), B = v3(a.to, null, 'to');
  if (!A || !B) {
    const L = pos(a.length ?? a.l, 128, 'length'), axis = a.axis ?? 'x';
    const d = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] }[axis];
    if (!d) throw new Error('truss axis must be x|y|z (or from/to)');
    A = [0, 0, 0]; B = mul(d, L);
    if (axis !== 'y') { const off = { x: [-L / 2, 0, 0], z: [0, 0, -L / 2] }[axis]; A = add(A, off); B = add(B, off); }
  }
  const L = len(sub(B, A));
  if (L < 1) throw new Error('truss is shorter than 1 px');
  const w = pos(a.w, 12, 'w'), h = pos(a.h, a.w ?? 12, 'h');
  const section = a.section ?? 'box', style = a.style ?? a.bracing ?? 'warren';
  if (!['box', 'tri', 'flat'].includes(section)) throw new Error('truss section must be box|tri|flat');
  if (!['warren', 'pratt', 'x', 'k', 'none'].includes(style)) throw new Error('truss style must be warren|pratt|x|k|none');
  const bay = pos(a.bay, Math.max(w, h), 'bay');
  const n = Math.max(1, Math.round(L / bay));
  const cs = pos(a.chord, Math.max(1.5, Math.min(w, h) / 6), 'chord'), bs = pos(a.brace, cs * 0.6, 'brace');
  const tex = ctx.tex(a.texture ?? a.color ?? '#6a6f78'), btex = a.brace_texture !== undefined ? ctx.tex(a.brace_texture) : tex;
  const ax = norm(sub(B, A));
  let up = a.up ? norm(v3(a.up, null, 'up')) : Math.abs(ax[1]) > 0.9 ? [0, 0, 1] : [0, 1, 0];
  up = norm(sub(up, mul(ax, dot(up, ax))));
  const side = cross(ax, up);
  // chord offsets in the section plane
  const off = section === 'box' ? [[-1, -1], [1, -1], [1, 1], [-1, 1]] : section === 'tri' ? [[-1, -1], [1, -1], [0, 1]] : [[0, -1], [0, 1]];
  const C = off.map(([x, y]) => add(mul(side, (x * w) / 2), mul(up, (y * h) / 2)));
  const at = (k, i) => add(add(A, mul(ax, (L * i) / n)), C[k]);
  const m = new Mesh();
  for (let k = 0; k < C.length; k++) beamFaces(m, tex, at(k, 0), at(k, n), cs, { up: k % 2 ? up : side, caps: a.caps !== false });
  const faces = C.length === 2 ? [[0, 1]] : C.map((_, k) => [k, (k + 1) % C.length]);
  for (let i = 0; i <= n; i++) if (style === 'pratt' || style === 'x' || style === 'k' || i === 0 || i === n || a.frames) for (const [p, q] of faces) beamFaces(m, btex, at(p, i), at(q, i), bs);
  if (style !== 'none') for (let i = 0; i < n; i++) for (const [fi, [p, q]] of faces.entries()) {
    const flip = (i + fi) % 2 === 1;
    if (style === 'warren') beamFaces(m, btex, flip ? at(p, i) : at(q, i), flip ? at(q, i + 1) : at(p, i + 1), bs);
    else if (style === 'pratt') beamFaces(m, btex, at(p, i), at(q, i + 1), bs);
    else if (style === 'x') { beamFaces(m, btex, at(p, i), at(q, i + 1), bs); beamFaces(m, btex, at(q, i), at(p, i + 1), bs); }
    else if (style === 'k') { const mid2 = mul(add(at(p, i + 1), at(q, i + 1)), 0.5); beamFaces(m, btex, at(p, i), mid2, bs); beamFaces(m, btex, at(q, i), mid2, bs); }
  }
  m.trussStats = { bays: n, chords: C.length, length: L };
  return m;
}

/** Single beam / strut / girder: from, to, s (thickness px), sides?:4. */
export function beam(a, ctx) {
  const A = v3(a.from, [0, 0, 0], 'from'), B = v3(a.to, [0, 32, 0], 'to');
  return beamFaces(new Mesh(), ctx.tex(a.texture ?? a.color ?? '#6a6f78'), A, B, pos(a.s ?? a.size, 3, 's'), { caps: a.caps !== false, sides: Math.max(3, Math.round(num(a.sides, 4, 'sides'))), up: a.up ? v3(a.up, null, 'up') : null });
}

// ---------- revolve (profile in r, y) ----------
/**
 * Revolve a profile [[r, y], ...] px about the y axis: dishes, tanks, silos, domes, nozzles.
 * segments?:16, arc?:360 deg, smooth?:true (shared normals; false = faceted), texture (u around
 * wrap?:n, v = profile length px), inside?:false (also / only inner faces: double_sided material).
 */
export function revolve(a, ctx) {
  const prof = a.profile ?? [[0, 0], [8, 0], [8, 24], [5, 30], [0, 31]];
  if (!Array.isArray(prof) || prof.length < 2 || prof.some((p) => !Array.isArray(p) || p.length < 2 || !Number.isFinite(Number(p[0])) || !Number.isFinite(Number(p[1])))) throw new Error('revolve needs profile: [[r, y], ...] px (2+ points, r >= 0)');
  const P = prof.map((p) => [Math.max(0, Number(p[0])), Number(p[1])]);
  const N = Math.max(3, Math.min(96, Math.round(num(a.segments, 16, 'segments'))));
  const arc = (Math.max(1, Math.min(360, num(a.arc, 360, 'arc'))) * Math.PI) / 180, full = arc >= 2 * Math.PI - 1e-6;
  const tex = ctx.tex(a.texture ?? a.color ?? '#7d838d');
  const smooth = a.smooth !== false;
  const sl = [0];
  for (let i = 1; i < P.length; i++) sl.push(sl[i - 1] + Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]));
  // profile normals (2D, outward = +r side of the path direction)
  const seg = (i) => { const dr = P[i + 1][0] - P[i][0], dy = P[i + 1][1] - P[i][1], l = Math.hypot(dr, dy) || 1; return [dy / l, -dr / l]; };
  const segN = P.slice(0, -1).map((_, i) => seg(i));
  // orientation: profiles may run top -> bottom; flip so normals point away from the axis on average
  const avgR = segN.reduce((s, n) => s + n[0], 0);
  const sgn = avgR < 0 ? -1 : 1;
  const wrap = Number(a.wrap ?? Math.max(1, Math.round((2 * Math.PI * Math.max(...P.map((p) => p[0]))) / Math.max(1, tex.width))));
  const m = new Mesh();
  const steps = full ? N : N;
  const ang = (j) => (full ? (2 * Math.PI * j) / N : -arc / 2 + (arc * j) / steps);
  const vtxN = (i, which) => {
    if (!smooth) return segN[which];
    const A = segN[Math.max(0, i - 1)], B = segN[Math.min(segN.length - 1, i)];
    if (A[0] * B[0] + A[1] * B[1] < 0.5) return segN[which];
    const s = [A[0] + B[0], A[1] + B[1]], l = Math.hypot(...s) || 1;
    return [s[0] / l, s[1] / l];
  };
  for (let i = 0; i < P.length - 1; i++) {
    if (P[i][0] < 1e-6 && P[i + 1][0] < 1e-6) continue;
    for (let j = 0; j < steps; j++) {
      const th0 = ang(j), th1 = ang(j + 1);
      const pt = (k, th) => [P[k][0] * Math.sin(th), P[k][1], P[k][0] * Math.cos(th)];
      const nn = (k, th) => { const n2 = vtxN(k, i); return [n2[0] * Math.sin(th) * sgn, n2[1] * sgn, n2[0] * Math.cos(th) * sgn]; };
      const Q = [pt(i, th0), pt(i, th1), pt(i + 1, th1), pt(i + 1, th0)];
      const Nn = [nn(i, th0), nn(i, th1), nn(i + 1, th1), nn(i + 1, th0)];
      const UV = [[(wrap * j) / N, sl[i] / tex.height], [(wrap * (j + 1)) / N, sl[i] / tex.height], [(wrap * (j + 1)) / N, sl[i + 1] / tex.height], [(wrap * j) / N, sl[i + 1] / tex.height]];
      const thm = (th0 + th1) / 2, n2 = segN[i];
      const nominal = [n2[0] * Math.sin(thm) * sgn, n2[1] * sgn, n2[0] * Math.cos(thm) * sgn];
      if (a.inside !== 'only') m.face(tex, Q, smooth ? Nn : nominal, UV, nominal, 0);
      if (a.inside) m.face(tex, Q, smooth ? Nn.map((x) => mul(x, -1)) : mul(nominal, -1), UV, mul(nominal, -1), 0);
    }
  }
  return m;
}
/** Dome / sphere: r, h?:r (height of the cap), sphere?:false, segments, rings. */
export function dome(a, ctx) {
  const r = pos(a.r, 8, 'r'), rings = Math.max(2, Math.round(num(a.rings, 4, 'rings')));
  const h = num(a.h, r, 'h'), sphere = !!a.sphere;
  const prof = [];
  const a0 = sphere ? -Math.PI / 2 : 0;
  for (let k = 0; k <= rings * (sphere ? 2 : 1); k++) { const th = a0 + (Math.PI / 2) * (k / rings); prof.push([r * Math.cos(th), (h * Math.sin(th))]); }
  if (!sphere && a.base !== false) prof.unshift([0, 0]);
  return revolve({ ...a, profile: prof, segments: a.segments ?? 12 }, ctx);
}

// ---------- rock (anchors for platforms; not terrain) ----------
/** Faceted boulder / outcrop: w, h, d, seed, detail?:1 (lat 6 x lon 10 per level), rough?:0.25. */
export function rock(a, ctx) {
  const w = pos(a.w, 64, 'w'), h = pos(a.h, 40, 'h'), d = pos(a.d, a.w ?? 64, 'd');
  const seed = Math.round(num(a.seed, 1, 'seed')), det = Math.max(1, Math.min(3, Math.round(num(a.detail, 1, 'detail'))));
  const rough = Math.max(0, Math.min(0.6, num(a.rough, 0.25, 'rough')));
  const la = 5 * det + 1, lo = 8 * det + 2;
  const tex = ctx.tex(a.texture ?? a.color ?? '#5d5650');
  const flat = a.flat_top ?? 0.15;
  const V = [];
  for (let i = 0; i <= la; i++) {
    const row = [];
    const ph = -Math.PI / 2 + (Math.PI * i) / la;
    for (let j = 0; j < lo; j++) {
      const th = (2 * Math.PI * j) / lo;
      const k = 1 + rough * (hash3(i * 31 + 7, j * 17 + 3, seed) * 2 - 1);
      let y = Math.sin(ph) * k;
      if (y > 1 - flat) y = 1 - flat + (y - 1 + flat) * 0.3;
      row.push([Math.cos(ph) * Math.sin(th) * k * (w / 2), (y * 0.5 + 0.5) * h, Math.cos(ph) * Math.cos(th) * k * (d / 2)]);
    }
    V.push(row);
  }
  const m = new Mesh();
  const c = [0, h / 2, 0];
  for (let i = 0; i < la; i++) for (let j = 0; j < lo; j++) {
    const Q = [V[i][j], V[i][(j + 1) % lo], V[i + 1][(j + 1) % lo], V[i + 1][j]];
    for (const T of [[Q[0], Q[1], Q[2]], [Q[0], Q[2], Q[3]]]) {
      let n = norm(cross(sub(T[1], T[0]), sub(T[2], T[0])));
      const fc = mul(add(add(T[0], T[1]), T[2]), 1 / 3);
      if (len(cross(sub(T[1], T[0]), sub(T[2], T[0]))) < 1e-6) continue;
      if (dot(n, sub(fc, c)) < 0) n = mul(n, -1);
      m.face(tex, T, n, uvFace(T, n, tex, true), n, 1);
    }
  }
  return m;
}

// ---------- wing / fin panel ----------
/**
 * Wing, fin or stabiliser panel from the root (x = 0) to the tip (x = span): root / tip chord
 * along z, sweep (px the tip leading edge sits behind the root's), thick / tip_thick, dihedral
 * (deg; 90 = vertical fin), section hex (flat top, chamfered edges) | diamond | flat.
 */
export function wingPanel(a, ctx) {
  const span = pos(a.span, 48, 'span'), root = pos(a.root ?? a.chord, 40, 'root'), tip = num(a.tip, root * 0.45, 'tip');
  const sweepPx = num(a.sweep, root * 0.4, 'sweep'), th = pos(a.thick, 4, 'thick'), tth = num(a.tip_thick, th * 0.5, 'tip_thick');
  const dih = (num(a.dihedral, 0, 'dihedral') * Math.PI) / 180;
  const ft = faceTexer(a, ctx, '#7d838d');
  const sec = a.section ?? 'hex';
  // section in (z, y) for chord c and thickness t, leading edge at z0 (front = +z)
  const S = (z0, c, t) => {
    if (sec === 'flat') return [[z0, t / 2], [z0 - c, t / 2], [z0 - c, -t / 2], [z0, -t / 2]];
    if (sec === 'diamond') return [[z0, 0], [z0 - c * 0.4, t / 2], [z0 - c, 0], [z0 - c * 0.4, -t / 2]];
    return [[z0, 0], [z0 - c * 0.2, t / 2], [z0 - c * 0.8, t / 2], [z0 - c, 0], [z0 - c * 0.8, -t / 2], [z0 - c * 0.2, -t / 2]];
  };
  const R = S(root / 2, root, th), T = S(root / 2 - sweepPx, Math.max(0.5, tip), Math.max(0.2, tth));
  const place = (p, x) => [x * Math.cos(dih) - p[1] * Math.sin(dih), x * Math.sin(dih) + p[1] * Math.cos(dih), p[0]];
  const RW = R.map((p) => place(p, 0)), TW = T.map((p) => place(p, span));
  const cen = mul(add(RW.reduce(add), TW.reduce(add)), 1 / (RW.length * 2));
  const m = new Mesh();
  const emit = (P) => {
    let n = [0, 0, 0];
    for (let i = 0; i < P.length; i++) { const p = P[i], q = P[(i + 1) % P.length]; n = add(n, [(p[1] - q[1]) * (p[2] + q[2]), (p[2] - q[2]) * (p[0] + q[0]), (p[0] - q[0]) * (p[1] + q[1])]); }
    if (len(n) < 1e-9) return;
    n = norm(n);
    const fc = mul(P.reduce(add), 1 / P.length);
    if (dot(n, sub(fc, cen)) < 0) n = mul(n, -1);
    const t = ft(n);
    return m.face(t, P, n, uvFace(P, n, t, true), n, 1);
  };
  for (let i = 0; i < RW.length; i++) { const j = (i + 1) % RW.length; const f = emit([RW[i], RW[j], TW[j], TW[i]]); if (f && (i === 0 || i === RW.length / 2)) f.edge = true; }
  emit(TW.slice().reverse());
  if (a.root_cap !== false) emit(RW);
  return m;
}

// ---------- catwalk / walkway ----------
/** Grating texture: metal bars with see-through holes (alpha MASK). */
export function grateTex(ctx, color = '#4a5058') {
  const c = rgba(color), d = c.map((v, i) => (i < 3 ? v * 0.6 : v)), l = c.map((v, i) => (i < 3 ? Math.min(255, v * 1.25) : v));
  return genTex(ctx, `grate:${color}`, 16, 16, (D, W) => {
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
      const bar = x % 4 === 0 || y % 8 === 0, edge = x % 4 === 1 || y % 8 === 1;
      if (bar || edge) D.set(bar ? c : y % 8 === 1 ? l : d, (y * W + x) * 4);
    }
  });
}
/**
 * Catwalk / walkway / bridge deck along z: len, w, deck?:2 (thickness), grating texture (default a
 * see-through grate) | texture, rails?:both|left|right|none, rail_h?:34, post_every?:32, kick?:true.
 */
export function catwalk(a, ctx) {
  const L = pos(a.len ?? a.d, 96, 'len'), w = pos(a.w, 40, 'w'), th = pos(a.deck, 2, 'deck');
  const rails = a.rails ?? 'both', rh = pos(a.rail_h, 34, 'rail_h'), every = pos(a.post_every, 32, 'post_every');
  const deckT = a.texture !== undefined ? ctx.tex(a.texture) : a.grate_color === undefined ? ctx.tex('kit_grate') : grateTex(ctx, a.grate_color);
  const railT = ctx.tex(a.rail ?? a.rail_texture ?? 'kit_hazard'), frameT = ctx.tex(a.frame ?? 'kit_metal_dark');
  const m = new Mesh();
  boxFaces(m, [-w / 2, -th, -L / 2], [w / 2, 0, L / 2], (n) => (n[1] > 0.5 || n[1] < -0.5 ? deckT : frameT), true);
  // side stringers
  for (const sx of [-1, 1]) boxFaces(m, [sx * w / 2 - (sx > 0 ? 2 : 0), -th - 4, -L / 2], [sx * w / 2 + (sx > 0 ? 0 : 2), -th, L / 2], () => frameT, true);
  const sides = rails === 'both' ? [-1, 1] : rails === 'left' ? [1] : rails === 'right' ? [-1] : [];
  const np = Math.max(1, Math.round(L / every));
  for (const sx of sides) {
    const x = sx * (w / 2 - 1);
    for (let i = 0; i <= np; i++) { const z = -L / 2 + (L * i) / np; beamFaces(m, railT, [x, 0, z], [x, rh, z], 1.6, { caps: true }); }
    beamFaces(m, railT, [x, rh, -L / 2], [x, rh, L / 2], 1.8, { caps: true });
    beamFaces(m, railT, [x, rh * 0.5, -L / 2], [x, rh * 0.5, L / 2], 1.2, { caps: true });
    if (a.kick !== false) boxFaces(m, [x - 0.5, 0, -L / 2], [x + 0.5, 4, L / 2], () => frameT, true);
  }
  m.markers = [{ kind: 'walk', pos: [0, 0, 0], dir: [0, 0, 1], data: { w, d: L, room: a.room ?? 'catwalk' } }];
  return m;
}

// ---------- cargo container ----------
/** Corrugated container texture of a colour (ribs, rust speckle, door bars on the ends). */
function containerTex(ctx, color, end) {
  const c = rgba(color);
  return genTex(ctx, `container:${color}:${end ? 'end' : 'side'}`, 16, 16, (D) => {
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
      const rib = end ? (x === 5 || x === 10 ? 0.62 : x === 0 || x === 15 ? 0.7 : 1) : x % 4 === 0 ? 0.68 : x % 4 === 1 ? 1.12 : 0.92;
      const rim = y === 0 || y === 15 ? 0.6 : 1, rust = hash3(x, y, 77) > 0.94 ? 0.75 : 1, n = 0.96 + hash3(x, y, 5) * 0.08;
      const k = rib * rim * rust * n;
      D.set([Math.min(255, c[0] * k), Math.min(255, c[1] * k), Math.min(255, c[2] * k), 255], (y * 16 + x) * 4);
    }
  });
}
/** Shipping / cargo container: w, h, d, color (corrugated sides, barred doors on the +z / -z ends). */
export function container(a, ctx) {
  const w = pos(a.w, 40, 'w'), h = pos(a.h, 40, 'h'), d = pos(a.d, 96, 'd');
  const col = a.color ?? '#8a3a2a';
  const hx = /^#[0-9a-fA-F]{6}$/.test(col) ? col.slice(1).toLowerCase() : null;
  const side = a.texture !== undefined ? ctx.tex(a.texture) : hx ? ctx.tex(`kit_container_${hx}`) : containerTex(ctx, col, false), end = a.texture !== undefined ? side : hx ? ctx.tex(`kit_container_end_${hx}`) : containerTex(ctx, col, true);
  const m = new Mesh();
  boxFaces(m, [-w / 2, 0, -d / 2], [w / 2, h, d / 2], (n) => (Math.abs(n[2]) > 0.5 ? end : side), true);
  return m;
}

// ---------- landing pad ----------
/** Pad marking texture: ring + cross / H / number, hazard border (fitted once on the top face). */
function padTex(ctx, a) {
  const S = 64, mark = String(a.mark ?? 'H').toUpperCase().slice(0, 3), base = rgba(a.color ?? '#3a3d42'), line = rgba(a.line ?? '#d8d2c0'), haz = rgba(a.hazard ?? '#d09a28'), dark = rgba('#1c1d20');
  return genTex(ctx, `pad:${mark}:${a.color}:${a.line}:${a.hazard}`, S, S, (D) => {
    const set = (x, y, c) => { if (x >= 0 && y >= 0 && x < S && y < S) D.set(c, (y * S + x) * 4); };
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const n = hash3(x, y, 9) * 14 - 7;
      set(x, y, [base[0] + n, base[1] + n, base[2] + n, 255]);
      const r = Math.hypot(x - S / 2 + 0.5, y - S / 2 + 0.5);
      if (r > 24 && r < 26.5) set(x, y, line);
      if (x < 3 || y < 3 || x >= S - 3 || y >= S - 3) set(x, y, ((x + y) >> 2) % 2 ? haz : dark);
    }
    const G = FONTS['7x9'].glyphs, chars = [...mark];
    const sc = 2, gw = chars.reduce((s, ch) => s + ((G[ch] || G['?'])[0].length + 1) * sc, -sc);
    let cx = Math.round(S / 2 - gw / 2);
    for (const ch of chars) {
      const g = G[ch] || G['?'];
      g.forEach((row, gy) => [...row].forEach((v, gx) => { if (v === '1') for (let k = 0; k < sc * sc; k++) set(cx + gx * sc + (k % sc), Math.round(S / 2 - (9 * sc) / 2) + gy * sc + Math.floor(k / sc), line); }));
      cx += (g[0].length + 1) * sc;
    }
  });
}
/** Landing pad: w (square side, or round:true diameter), h?:4 thickness, mark?:"H"|"07", lights?:8 rim lights. */
export function landingPad(a, ctx) {
  const w = pos(a.w, 192, 'w'), h = pos(a.h, 4, 'h'), round = !!a.round;
  const top = padTex(ctx, a), sideT = ctx.tex(a.side ?? '#2b2d31');
  const m = new Mesh();
  if (round) {
    const N = Math.max(8, Math.round(num(a.segments, 16, 'segments')));
    const ring = [...Array(N).keys()].map((j) => { const t = (2 * Math.PI * j) / N; return [Math.sin(t) * w / 2, Math.cos(t) * w / 2]; });
    const topP = ring.map(([x, z]) => [x, h, z]);
    m.polygon(top, topP, [0, 1, 0], topP.map((p) => [p[0] / w + 0.5, p[2] / w + 0.5]), [...Array(N - 2).keys()].map((k) => [0, k + 1, k + 2]), 0);
    for (let j = 0; j < N; j++) { const [x0, z0] = ring[j], [x1, z1] = ring[(j + 1) % N]; const P = [[x0, h, z0], [x1, h, z1], [x1, 0, z1], [x0, 0, z0]], n = norm([(x0 + x1) / 2, 0, (z0 + z1) / 2]); m.face(sideT, P, n, uvFace(P, n, sideT, true), n, 1); }
  } else {
    boxFaces(m, [-w / 2, 0, -w / 2], [w / 2, h, w / 2], (n) => (n[1] > 0.5 ? top : sideT), false);
  }
  const nl = Math.max(0, Math.round(num(a.lights, 8, 'lights')));
  if (nl) {
    const lamp = glowTex(ctx, a.light_color ?? '#ffb040');
    m.markers = [];
    for (let k = 0; k < nl; k++) {
      const t = (2 * Math.PI * k) / nl, r = round ? w / 2 - 3 : w / 2 - 3;
      const p = round ? [Math.sin(t) * r, h, Math.cos(t) * r] : (() => { const s = k % 4, f = Math.floor(k / 4) / Math.max(1, Math.ceil(nl / 4)) - 0.5 + 0.5 / Math.max(1, Math.ceil(nl / 4)); const q = [[f * w, w / 2 - 3], [w / 2 - 3, -f * w], [-f * w, -w / 2 + 3], [-w / 2 + 3, f * w]][s]; return [q[0], h, q[1]]; })();
      boxFaces(m, [p[0] - 1.5, h, p[2] - 1.5], [p[0] + 1.5, h + 1.5, p[2] + 1.5], () => lamp, true);
      if (k % 2 === 0) m.markers.push({ kind: 'light', pos: [p[0], h + 3, p[2]], data: { type: 'point', color: a.light_color ?? '#ffb040', intensity: 0.6, range: 64 } });
    }
  }
  return m;
}

// ---------- neon ----------
/** Lit pixel grid of text in a pixel font (rows top-down). */
export function textPixels(text, font = '5x7', spacing = 1) {
  const F = FONTS[font];
  if (!F) throw new Error(`neon font must be one of ${Object.keys(FONTS).join(', ')}`);
  const lines = String(text).toUpperCase().split('\n');
  const rows = [];
  const lh = F.h + 2;
  const width = Math.max(...lines.map((l) => [...l].reduce((s, ch) => s + (F.glyphs[ch] || F.glyphs['?'])[0].length + spacing, -spacing)), 1);
  for (let li = 0; li < lines.length; li++) {
    const block = [...Array(F.h)].map(() => new Array(width).fill(0));
    let x = 0;
    for (const ch of lines[li]) {
      const g = F.glyphs[ch] || F.glyphs['?'];
      g.forEach((row, gy) => [...row].forEach((v, gx) => { if (v === '1') block[gy][x + gx] = 1; }));
      x += g[0].length + spacing;
    }
    const lw = x - spacing, shift = Math.floor((width - lw) / 2);
    for (const r of block) rows.push([...Array(width)].map((_, i) => (i - shift >= 0 ? r[i - shift] : 0)));
    if (li < lines.length - 1) for (let k = 0; k < lh - F.h; k++) rows.push(new Array(width).fill(0));
  }
  return { w: width, h: rows.length, at: (x, y) => (x >= 0 && y >= 0 && x < width && y < rows.length ? rows[y][x] : 0) };
}
/**
 * Pixel grid -> tube strokes: orthogonal neighbours join, a diagonal joins only where no orthogonal
 * path exists; degree-2 chains become polylines (collinear points merged); lone pixels become dots.
 */
export function pixelStrokes(G) {
  const id = (x, y) => y * G.w + x, edges = new Map();
  const link = (a, b) => { (edges.get(a) || edges.set(a, new Set()).get(a)).add(b); (edges.get(b) || edges.set(b, new Set()).get(b)).add(a); };
  const lit = [];
  for (let y = 0; y < G.h; y++) for (let x = 0; x < G.w; x++) {
    if (!G.at(x, y)) continue;
    lit.push([x, y]);
    if (!edges.has(id(x, y))) edges.set(id(x, y), new Set());
    if (G.at(x + 1, y)) link(id(x, y), id(x + 1, y));
    if (G.at(x, y + 1)) link(id(x, y), id(x, y + 1));
    if (G.at(x + 1, y + 1) && !G.at(x + 1, y) && !G.at(x, y + 1)) link(id(x, y), id(x + 1, y + 1));
    if (G.at(x - 1, y + 1) && !G.at(x - 1, y) && !G.at(x, y + 1)) link(id(x, y), id(x - 1, y + 1));
  }
  const xy = (k) => [k % G.w, Math.floor(k / G.w)];
  const used = new Set(), ek = (a, b) => (a < b ? `${a},${b}` : `${b},${a}`);
  const lines = [], dots = [];
  const walk = (start, next) => {
    const path = [start, next];
    used.add(ek(start, next));
    let prev = start, cur = next;
    while (edges.get(cur).size === 2) {
      const nx = [...edges.get(cur)].find((o) => o !== prev);
      if (used.has(ek(cur, nx))) break;
      used.add(ek(cur, nx));
      path.push(nx); prev = cur; cur = nx;
      if (nx === start) break;
    }
    return path;
  };
  for (const [k, s] of edges) if (s.size === 0) dots.push(xy(k));
  for (const [k, s] of edges) if (s.size !== 2 && s.size) for (const o of s) if (!used.has(ek(k, o))) lines.push(walk(k, o));
  for (const [k, s] of edges) for (const o of s) if (!used.has(ek(k, o))) lines.push(walk(k, o));
  const simplify = (p) => {
    const P = p.map(xy), out = [P[0]];
    for (let i = 1; i < P.length - 1; i++) { const a = out[out.length - 1], b = P[i], c = P[i + 1]; if ((b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]) !== 0) out.push(b); }
    out.push(P[P.length - 1]);
    return out;
  };
  return { lines: lines.map(simplify), dots, pixels: lit.length };
}
/**
 * Neon tube text / shapes (emissive sweeps): text + font?:"5x7" | canvas (opaque pixels = the
 * tube path, 1 px strokes) | strokes:[[[x,y],..],..] (2D polylines, y up). px?:4 (model px per
 * glyph pixel), r?:0.9 tube radius, sides?:6, color, backing?:true (dark plate behind), glow light.
 */
export function neon(a, ctx) {
  const px = pos(a.px, 4, 'px'), r = pos(a.r, Math.max(0.5, px * 0.22), 'r'), sides = Math.max(3, Math.round(num(a.sides, 6, 'sides')));
  let strokes, gw, gh;
  if (a.strokes) {
    if (!Array.isArray(a.strokes) || !a.strokes.length) throw new Error('neon strokes must be [[[x,y],...], ...] (glyph px, y up)');
    strokes = a.strokes.map((s) => s.map((p) => [Number(p[0]), -Number(p[1])]));
    const xs = strokes.flat().map((p) => p[0]), ys = strokes.flat().map((p) => p[1]);
    gw = Math.max(...xs) - Math.min(...xs) + 1; gh = Math.max(...ys) - Math.min(...ys) + 1;
    const x0 = Math.min(...xs), y0 = Math.min(...ys);
    strokes = strokes.map((s) => s.map((p) => [p[0] - x0, p[1] - y0]));
  } else {
    let G;
    if (a.text !== undefined) G = textPixels(a.text, a.font ?? '5x7', a.spacing ?? 1);
    else if (a.canvas) { const t = ctx.tex(a.canvas); G = { w: t.width, h: t.height, at: (x, y) => x >= 0 && y >= 0 && x < t.width && y < t.height && t.data[(y * t.width + x) * 4 + 3] >= 128 }; }
    else throw new Error('neon needs text, canvas (pixel strokes) or strokes');
    const st = pixelStrokes(G);
    strokes = [...st.lines, ...st.dots.map((d) => [[d[0] - 0.2, d[1]], [d[0] + 0.2, d[1]]])];
    gw = G.w; gh = G.h;
  }
  const tube = glowTex(ctx, a.color ?? '#ff3fd0');
  const tctx = { ...ctx, tex: () => tube };
  const m = new Mesh();
  const W = gw * px, H = gh * px;
  const toW = ([x, y]) => [(x + 0.5) * px - W / 2, H - (y + 0.5) * px, 0];
  let length = 0;
  for (const s of strokes) {
    if (s.length < 2) continue;
    const path = s.map(toW);
    for (let i = 1; i < path.length; i++) length += len(sub(path[i], path[i - 1]));
    m.add(sweep({ path, r, sides, caps: true, texture: 'neon' }, tctx));
  }
  if (a.backing !== false) {
    const bt = ctx.tex(a.backing_color ?? '#15161a'), pad = px * 1.2;
    boxFaces(m, [-W / 2 - pad, -pad, -r - 2], [W / 2 + pad, H + pad, -r - 0.5], () => bt, true);
  }
  m.markers = [{ kind: 'light', pos: [0, H / 2, r + 6], data: { type: 'point', color: a.color ?? '#ff3fd0', intensity: Math.min(3, 0.4 + length / 400), range: Math.max(48, W * 1.2), neon: true } }];
  m.neonStats = { strokes: strokes.length, tube_px: Math.round(length), size_px: [W, H] };
  return m;
}

/** Text texture: lit glyph pixels on a dark field (emissive), for sign boxes and screens. */
export function textTex(ctx, text, { color = '#ffd040', bg = '#101114', font = '5x7', pad = 2, scanlines = false } = {}) {
  const G = textPixels(text, font);
  const W = G.w + pad * 2, H = G.h + pad * 2;
  const c = rgba(color), b = rgba(bg);
  const t = genTex(ctx, `text:${text}:${color}:${bg}:${font}:${scanlines}`, W, H, (D) => {
    const E = new Uint8ClampedArray(W * H * 4);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const on = G.at(x - pad, y - pad);
      const p = (y * W + x) * 4;
      if (on) { D.set(c, p); E.set(c, p); } else if (G.at(x - pad - 1, y - pad) || G.at(x - pad + 1, y - pad) || G.at(x - pad, y - pad - 1) || G.at(x - pad, y - pad + 1)) { const h = [c[0] * 0.25 + b[0] * 0.75, c[1] * 0.25 + b[1] * 0.75, c[2] * 0.25 + b[2] * 0.75, 255]; D.set(h, p); E.set([c[0] * 0.3, c[1] * 0.3, c[2] * 0.3, 255], p); } else D.set(scanlines && y % 2 ? b.map((v, i) => (i < 3 ? v * 0.7 : v)) : b, p);
    }
    return { emissive: E };
  });
  return t;
}
/** Lit sign box: w, h, d?:4, text, color, bg, font, frame colour; the front face shows the text (emissive). */
export function signBox(a, ctx) {
  const text = String(a.text ?? 'OPEN');
  const face = textTex(ctx, text, { color: a.color ?? '#ffd040', bg: a.bg ?? '#101114', font: a.font ?? '5x7' });
  const h = pos(a.h, 24, 'h'), w = pos(a.w, Math.round((h * face.width) / face.height), 'w'), d = pos(a.d, 4, 'd');
  const frame = ctx.tex(a.frame ?? '#2a2c31');
  const m = new Mesh();
  boxFaces(m, [-w / 2, 0, -d / 2], [w / 2, h, d / 2], (n) => (n[2] > 0.5 || (a.double && n[2] < -0.5) ? face : frame), false);
  m.markers = [{ kind: 'light', pos: [0, h / 2, d / 2 + 6], data: { type: 'point', color: a.color ?? '#ffd040', intensity: 0.8, range: Math.max(48, w), sign: true } }];
  return m;
}
/** Hologram card: w, h, text?, color, opacity?:0.7 (additive, double-sided, scanlines). */
export function holo(a, ctx) {
  const w = pos(a.w, 32, 'w'), h = pos(a.h, 24, 'h'), op = Math.max(0.05, Math.min(1, num(a.opacity, 0.7, 'opacity')));
  const c = rgba(a.color ?? '#40e0ff');
  const base = a.text !== undefined ? textTex(ctx, String(a.text), { color: a.color ?? '#40e0ff', bg: '#000000', font: a.font ?? '5x7', scanlines: true }) : null;
  const T = genTex(ctx, `holo:${a.text ?? ''}:${a.color}:${op}`, base ? base.width : 16, base ? base.height : 16, (D, W, H) => {
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const p = (y * W + x) * 4;
      const lit = base ? base.data[p] + base.data[p + 1] + base.data[p + 2] > 120 && base.emissive[p + 3] : (x === 0 || y === 0 || x === W - 1 || y === H - 1 || ((x * 7 + y * 3) % 11 === 0));
      const scan = y % 2 ? 0.55 : 1;
      const al = lit ? 255 * scan : y % 3 === 0 ? 40 : 18;
      D.set([c[0], c[1], c[2], al], p);
    }
    return { emissive: D };
  }, { material: ADDITIVE(op) });
  const m = new Mesh();
  const P = [[-w / 2, h, 0], [w / 2, h, 0], [w / 2, 0, 0], [-w / 2, 0, 0]];
  m.face(T, P, [0, 0, 1], [[0, 0], [1, 0], [1, 1], [0, 1]], null, 0);
  return m;
}

// ---------- fake volumetrics ----------
/** Soft banded falloff texture (pixel-art: Bayer-dithered steps). kind radial | vertical | beam. */
function falloffTex(ctx, kind, color, steps = 5) {
  const c = rgba(color), S = 32;
  return genTex(ctx, `fall:${kind}:${color}:${steps}`, S, S, (D) => {
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const u = (x + 0.5) / S * 2 - 1, v = (y + 0.5) / S;
      let f;
      if (kind === 'radial') f = Math.max(0, 1 - Math.hypot(u, v * 2 - 1));
      else if (kind === 'vertical') f = Math.max(0, 1 - Math.abs(u)) * (1 - v);
      else f = Math.max(0, 1 - Math.abs(u) / (0.3 + 0.7 * v)) * (1 - v * 0.85); // beam: narrow at the top, widening down
      f = f * f * (3 - 2 * f);
      const dither = (BAYER4[y & 3][x & 3] + 0.5) / 16 - 0.5;
      const q = Math.max(0, Math.min(steps, Math.round(f * steps + dither))) / steps;
      D.set([c[0], c[1], c[2], Math.round(q * 255)], (y * S + x) * 4);
    }
  });
}
/**
 * Fog / god-ray card: crossed additive planes (cross?:2) of w x h px with a soft banded falloff
 * (falloff?:radial|vertical|beam), color, opacity?:0.35, dir?:[x,y,z] (beam axis; default down),
 * steps?:5. Cheap fake volumetrics: light shafts, haze over vents, dust in a hangar.
 */
export function fogCard(a, ctx) {
  const w = pos(a.w, 48, 'w'), h = pos(a.h, 96, 'h'), op = Math.max(0.02, Math.min(1, num(a.opacity, 0.35, 'opacity')));
  const kind = a.falloff ?? (a.type === 'god_ray' ? 'beam' : 'radial');
  if (!['radial', 'vertical', 'beam'].includes(kind)) throw new Error('fog_card falloff must be radial|vertical|beam');
  const base = falloffTex(ctx, kind, a.color ?? '#a0c8ff', Math.max(2, Math.min(12, Math.round(num(a.steps, 5, 'steps')))));
  const T = { ...base, key: `${base.key}|a${op}`, imageKey: base.key, material: ADDITIVE(op) };
  const n = Math.max(1, Math.min(6, Math.round(num(a.cross, 2, 'cross'))));
  const m = new Mesh();
  for (let k = 0; k < n; k++) {
    const th = (Math.PI * k) / n, s = Math.sin(th), c = Math.cos(th);
    // card hangs from y = 0 down to -h (a light shaft from a ceiling lamp), centred
    const P = [[-c * w / 2, 0, -s * w / 2], [c * w / 2, 0, s * w / 2], [c * w / 2, -h, s * w / 2], [-c * w / 2, -h, -s * w / 2]];
    m.face(T, P, [-s, 0, c], [[0, 0], [1, 0], [1, 1], [0, 1]], null, 0);
  }
  if (a.dir) {
    const d = norm(v3(a.dir, null, 'dir'));
    // rotate -Y onto d
    const f = [0, -1, 0], ax = cross(f, d), sn = len(ax), cs = dot(f, d);
    if (sn > 1e-6) {
      const k = mul(ax, 1 / sn), ang = Math.atan2(sn, cs);
      const rot = (p) => add(add(mul(p, Math.cos(ang)), mul(cross(k, p), Math.sin(ang))), mul(k, dot(k, p) * (1 - Math.cos(ang))));
      m.map(rot, rot);
    } else if (cs < 0) m.map((p) => [p[0], -p[1], p[2]], (q) => [q[0], -q[1], q[2]]);
  }
  return m;
}

// ---------- lights + markers (node extras on export) ----------
/**
 * Light marker: color, intensity?:1, range?:160 px, kind?:point|spot, dir?:[0,-1,0], angle?:45,
 * bulb?:true (a tiny emissive box), cast_shadow?:false. Exported as an empty node light_<n> with
 * extras.light {type, color, intensity, range (units), dir, angle} for the game to place real lights.
 */
export function light(a, ctx) {
  const kind = a.kind ?? 'point';
  if (!['point', 'spot'].includes(kind)) throw new Error('light kind must be point|spot');
  const color = a.color ?? '#ffe0b0';
  rgba(color);
  const m = new Mesh();
  const bulb = a.bulb ?? true;
  if (bulb) { const s = typeof bulb === 'number' ? bulb : 2; const t = glowTex(ctx, color); boxFaces(m, [-s / 2, -s / 2, -s / 2], [s / 2, s / 2, s / 2], () => t, true); }
  const data = { type: kind, color, intensity: num(a.intensity, 1, 'intensity'), range: pos(a.range, 160, 'range') };
  if (kind === 'spot') { data.angle = num(a.angle, 45, 'angle'); }
  if (a.shadow !== undefined) data.shadow = !!a.shadow;
  m.markers = [{ kind: 'light', pos: [0, 0, 0], dir: kind === 'spot' ? norm(v3(a.dir, [0, -1, 0], 'dir')) : null, data }];
  return m;
}
/** Generic marker (spawn points, door spawns, nav nodes, MFD screens): kind, data?:{}, dir?. Empty node + extras. */
export function marker(a) {
  if (!/^[\w.-]{1,32}$/.test(String(a.kind ?? 'marker'))) throw new Error('marker needs kind: "spawn"|"door"|"nav"|"screen"|... (1-32 letters, digits, _ - .)');
  const m = new Mesh();
  m.markers = [{ kind: a.kind ?? 'marker', pos: [0, 0, 0], dir: a.dir ? norm(v3(a.dir, null, 'dir')) : null, data: a.data && typeof a.data === 'object' ? a.data : {} }];
  return m;
}

// ---------- decals (stencils, serials, labels, arrows, chevrons, logotypes) ----------
const ARROW = ['0000100000', '0000110000', '1111111000', '1111111100', '1111111000', '0000110000', '0000100000'];
/**
 * A decal: one alpha-cut quad facing +z (put it 0.2 px off a surface) with a pixel texture: text
 * (pixel font, stencil gaps optional), arrow (dir left|right|up|down), chevrons (warning), stripes
 * (hazard band) or a logotype (text + underline bar). px = model px per decal pixel (32 px / m:
 * 0.5 px pixels = 1.6 cm). glow:true makes it emissive (lit headers).
 */
export function decal(a, ctx) {
  const kind = a.kind ?? (a.text !== undefined ? 'text' : 'arrow');
  const col = rgba(a.color ?? '#e8e4d8'), bg = a.bg ? rgba(a.bg) : null, px = pos(a.px, 0.5, 'px');
  let w, h, at;
  if (kind === 'text' || kind === 'logo') {
    const T = textPixels(String(a.text ?? 'LABEL'), a.font ?? (kind === 'logo' ? '7x9' : '3x5'), 1);
    const pad = bg ? 1 : 0, bar = kind === 'logo' ? 3 : 0;
    w = T.w + pad * 2; h = T.h + pad * 2 + bar;
    at = (x, y) => (y >= T.h + pad + 1 && y < T.h + pad + bar && kind === 'logo' ? 1 : T.at(x - pad, y - pad) ? (a.stencil && (x - pad) % 4 === 2 && (y - pad) === Math.floor(T.h / 2) ? 0 : 1) : 0);
  } else if (kind === 'arrow') {
    w = 10; h = 7;
    const d = a.dir ?? 'right';
    at = (x, y) => { let X = x, Y = y; if (d === 'left') X = 9 - x; if (d === 'up' || d === 'down') { X = d === 'up' ? 9 - y : y; Y = x; } return ARROW[Y]?.[X] === '1' ? 1 : 0; };
    if (d === 'up' || d === 'down') { w = 7; h = 10; }
  } else if (kind === 'chevrons') {
    const n = Math.max(1, Math.round(num(a.count, 3, 'count')));
    w = n * 6; h = 8;
    at = (x, y) => { const k = (x % 6) - Math.abs(y - 3.5) + 0.5; return k >= 0 && k < 3 ? 1 : 0; };
  } else if (kind === 'stripes') {
    w = Math.max(4, Math.round(num(a.len, 32, 'len'))); h = 4;
    at = (x, y) => (((x + y) >> 1) % 2 ? 1 : 2);
  } else throw new Error('decal kind must be text|logo|arrow|chevrons|stripes');
  const second = rgba(a.color2 ?? '#1c1d20');
  const key = `decal:${kind}:${a.text ?? ''}:${a.dir ?? ''}:${a.count ?? ''}:${a.len ?? ''}:${a.color ?? ''}:${a.color2 ?? ''}:${a.bg ?? ''}:${a.font ?? ''}:${a.stencil ? 1 : 0}:${a.glow ? 1 : 0}`;
  const t = genTex(ctx, key, w, h, (D, W) => {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const v = at(x, y);
      if (v === 1) D.set(col, (y * W + x) * 4);
      else if (v === 2) D.set(second, (y * W + x) * 4);
      else if (bg) D.set(bg, (y * W + x) * 4);
    }
    return a.glow ? { emissive: D, decal: true } : { decal: true };
  });
  const m = new Mesh(), W2 = (w * px) / 2, H2 = (h * px) / 2;
  m.face(t, [[-W2, -H2, 0], [W2, -H2, 0], [W2, H2, 0], [-W2, H2, 0]], [[0, 0, 1], [0, 0, 1], [0, 0, 1], [0, 0, 1]], [[0, 1], [1, 1], [1, 0], [0, 0]], [0, 0, 1], 0);
  return m;
}

/** Transform markers of a mesh by a 3x4 matrix (positions + directions). */
export function transformMarkers(list, M) {
  const ap = (p) => [M[0] * p[0] + M[1] * p[1] + M[2] * p[2] + M[3], M[4] * p[0] + M[5] * p[1] + M[6] * p[2] + M[7], M[8] * p[0] + M[9] * p[1] + M[10] * p[2] + M[11]];
  const ad = (d) => norm([M[0] * d[0] + M[1] * d[1] + M[2] * d[2], M[4] * d[0] + M[5] * d[1] + M[6] * d[2], M[8] * d[0] + M[9] * d[1] + M[10] * d[2]]);
  return list.map((k) => ({ ...k, pos: ap(k.pos), dir: k.dir ? ad(k.dir) : k.dir }));
}
export { mT, mRX, mRY, mRZ, matMul, mulberry32 };
