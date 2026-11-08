// Ship hulls from design curves: a top-plan outline (half-width along the length), a side
// profile (top and bottom along the length) and cross-section stations (superellipse or polygon
// sections, blended between stations), lofted into one closed multi-section surface. Hard creases
// above a crease angle, soft chamfers from chamfered sections, and a quad-level relief pass:
// panel-line grooves (rings across the hull, seams along it), raised plates (armour / plate
// layering) and mask carving, each a level offset along the surface normal with walls between
// levels (no CSG; the surface stays closed).
//
// Parameters: t = 0 (tail, -z) .. 1 (nose, +z) along the length; u = 0 .. 1 around the section,
// starting at the top centre and running down the +x side (u 0.25), the keel (0.5) and up the -x
// side (0.75). The hull is centred on z (z = (t - 0.5) * length) and symmetric about x = 0.
//
// Walkable hulls: shell:<px> adds an inner skin (the hull gets a real wall thickness, so an
// interior can live inside the same model) and openings:[{t:[a,b], u:[a,b]}] cut doorways,
// hatches and canopy wells through both skins with rim walls that show the thickness.
import { Mesh } from './model3d.js';

const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const norm = (a) => { const l = len(a); return l > 1e-12 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0]; };
const clamp01 = (v) => Math.max(0, Math.min(1, v));
const fnum = (v, d, name) => { const x = Number(v ?? d); if (!Number.isFinite(x)) throw new Error(`hull ${name} must be a number (got ${JSON.stringify(v)})`); return x; };

// ---------- curves ----------
/** Monotone cubic (PCHIP) through knots [[t, v], ...] sorted by t; linear:true = straight segments. */
export function curve(knots, linear = false) {
  const K = knots.map((k) => [Number(k[0]), Number(k[1])]).sort((a, b) => a[0] - b[0]);
  if (K.length === 1) return () => K[0][1];
  const n = K.length, h = [], d = [];
  for (let i = 0; i < n - 1; i++) { h.push(K[i + 1][0] - K[i][0] || 1e-9); d.push((K[i + 1][1] - K[i][1]) / h[i]); }
  const m = new Array(n).fill(0);
  m[0] = d[0]; m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) {
    if (d[i - 1] * d[i] <= 0) m[i] = 0;
    else { const w1 = 2 * h[i] + h[i - 1], w2 = h[i] + 2 * h[i - 1]; m[i] = (w1 + w2) / (w1 / d[i - 1] + w2 / d[i]); }
  }
  return (t) => {
    if (t <= K[0][0]) return K[0][1];
    if (t >= K[n - 1][0]) return K[n - 1][1];
    let i = 0;
    while (i < n - 2 && t > K[i + 1][0]) i++;
    const s = (t - K[i][0]) / h[i];
    if (linear) return K[i][1] + (K[i + 1][1] - K[i][1]) * s;
    const s2 = s * s, s3 = s2 * s;
    return (2 * s3 - 3 * s2 + 1) * K[i][1] + (s3 - 2 * s2 + s) * h[i] * m[i] + (-2 * s3 + 3 * s2) * K[i + 1][1] + (s3 - s2) * h[i] * m[i + 1];
  };
}

// ---------- sections (unit space: x, y in -1..1; u from the top centre down the +x side) ----------
const NAMED = {
  round: { n: 2 }, ellipse: { n: 2 }, pill: { n: 3 }, soft_box: { n: 4 }, diamond: { n: 1 },
  box: { points: [[0, 1], [1, 1], [1, -1], [-1, -1], [-1, 1]], chamfer: 0.18 },
  hex: { points: [[0, 1], [0.55, 1], [1, 0.1], [0.75, -1], [-0.75, -1], [-1, 0.1], [-0.55, 1]] },
  wedge: { points: [[0, 1], [0.45, 1], [1, -0.35], [0.85, -1], [-0.85, -1], [-1, -0.35], [-0.45, 1]] },
  keel: { points: [[0, 1], [0.7, 0.8], [1, 0], [0.55, -0.7], [0, -1], [-0.55, -0.7], [-1, 0], [-0.7, 0.8]] },
  flat_bottom: { n: 2.6, n_bottom: 8 },
};
/** Chamfer a convex polygon's corners (fraction of the shorter adjacent edge). */
function chamferPoly(P, c) {
  if (!(c > 0)) return P;
  const out = [];
  for (let i = 0; i < P.length; i++) {
    const a = P[(i + P.length - 1) % P.length], b = P[i], e = P[(i + 1) % P.length];
    // the top-centre start point stays (it is a mid-edge point, not a corner)
    if (i === 0) { out.push(b); continue; }
    const l1 = Math.hypot(a[0] - b[0], a[1] - b[1]), l2 = Math.hypot(e[0] - b[0], e[1] - b[1]);
    const k = Math.min(c, 0.45 * Math.min(l1, l2));
    out.push([b[0] + ((a[0] - b[0]) / l1) * k, b[1] + ((a[1] - b[1]) / l1) * k], [b[0] + ((e[0] - b[0]) / l2) * k, b[1] + ((e[1] - b[1]) / l2) * k]);
  }
  return out;
}
/**
 * Section spec -> {at(u) -> [x, y] unit, corners: [u] (polygon vertices: kept as grid columns so
 * creases stay sharp)}. Spec: number (superellipse exponent: 2 ellipse, 4 rounded box, 1 diamond),
 * name (round|pill|soft_box|diamond|box|hex|wedge|keel|flat_bottom) or {n, n_bottom?, points?, chamfer?}.
 */
export function makeSection(spec) {
  let s = spec ?? 2.6;
  if (typeof s === 'number') s = { n: s };
  else if (typeof s === 'string') { if (!NAMED[s]) throw new Error(`hull section "${s}" unknown (${Object.keys(NAMED).join('|')}, a superellipse exponent, or {points:[[x,y],..] unit, chamfer?})`); s = NAMED[s]; }
  else if (!s || typeof s !== 'object') throw new Error('hull section must be a number, a name or {n | points}');
  if (s.points) {
    let P = s.points.map((p) => [Number(p[0]), Number(p[1])]);
    if (P.length < 3 || P.some((p) => !Number.isFinite(p[0]) || !Number.isFinite(p[1]))) throw new Error('hull section points must be [[x,y],...] (3+, unit -1..1, clockwise from the top centre)');
    // start at the top centre
    if (!(Math.abs(P[0][0]) < 1e-9 && P[0][1] > 0)) {
      let k = 0; P.forEach((p, i) => { if (p[1] > P[k][1] + 1e-9 || (Math.abs(p[1] - P[k][1]) < 1e-9 && Math.abs(p[0]) < Math.abs(P[k][0]))) k = i; });
      P = [[0, P[k][1]], ...P.slice(k), ...P.slice(0, k)];
    }
    P = chamferPoly(P, Number(s.chamfer ?? 0));
    const L = [0];
    for (let i = 0; i < P.length; i++) { const a = P[i], b = P[(i + 1) % P.length]; L.push(L[i] + Math.hypot(b[0] - a[0], b[1] - a[1])); }
    const tot = L[P.length];
    return {
      corners: L.slice(1, P.length).map((v) => v / tot),
      at(u) {
        const d = (((u % 1) + 1) % 1) * tot;
        let i = 0;
        while (i < P.length - 1 && L[i + 1] < d) i++;
        const a = P[i], b = P[(i + 1) % P.length], f = (d - L[i]) / (L[i + 1] - L[i] || 1);
        return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
      },
    };
  }
  const n = Math.max(0.5, Number(s.n ?? 2.6)), nb = Math.max(0.5, Number(s.n_bottom ?? n));
  return {
    corners: [],
    at(u) {
      const ph = 2 * Math.PI * u, sn = Math.sin(ph), c = Math.cos(ph), e = c >= 0 ? n : nb;
      return [Math.sign(sn) * Math.abs(sn) ** (2 / e), Math.sign(c) * Math.abs(c) ** (2 / e)];
    },
  };
}

// ---------- the hull surface ----------
/**
 * Validate hull params and return the analytic surface: {L, z(t), t(z), point(t,u), normal(t,u),
 * frame(t,u) -> {pos, n, fwd, side}, halfWidthAt(t, y), extentAt(t) -> {w, top, bottom}}.
 */
export function hullSurface(a) {
  const L = fnum(a.length, 320, 'length');
  if (!(L > 0)) throw new Error('hull length must be > 0 px');
  const W = fnum(a.width, 96, 'width'), H = fnum(a.height, 48, 'height');
  const knots = (v, name, cols) => {
    if (!Array.isArray(v) || v.length < 1 || v.some((k) => !Array.isArray(k) || k.length < cols || k.slice(0, cols).some((x) => !Number.isFinite(Number(x))))) throw new Error(`hull ${name} must be [[t, ${cols === 2 ? 'half_width' : 'top, bottom'}], ...] (t 0 = tail .. 1 = nose, px)`);
    for (const k of v) if (Number(k[0]) < 0 || Number(k[0]) > 1) throw new Error(`hull ${name} t must be 0..1 (0 = tail, 1 = nose), got ${k[0]}`);
    return v;
  };
  const plan = knots(a.plan ?? [[0, W * 0.32], [0.18, W * 0.5], [0.55, W * 0.5], [0.85, W * 0.3], [1, W * 0.04]], 'plan', 2);
  const prof = knots(a.profile ?? [[0, H * 0.75], [0.3, H], [0.7, H * 0.9], [1, H * 0.45]], 'profile', 2);
  const lin = a.interp === 'linear';
  const fw = curve(plan.map((k) => [k[0], Math.max(0, Number(k[1]))]), lin);
  const ft = curve(prof.map((k) => [k[0], Number(k[1])]), lin);
  const fb = curve(prof.map((k) => [k[0], Number(k[2] ?? 0)]), lin);
  for (const k of prof) if (Number(k[1]) < Number(k[2] ?? 0)) throw new Error(`hull profile at t ${k[0]}: top ${k[1]} is below bottom ${k[2] ?? 0}`);
  const st = (Array.isArray(a.sections) ? a.sections : [[0, a.section ?? 'flat_bottom']]).map((s) => {
    if (!Array.isArray(s) || s.length !== 2 || !Number.isFinite(Number(s[0]))) throw new Error('hull sections must be [[t, section], ...] (section: exponent | name | {points})');
    return { t: Number(s[0]), sec: makeSection(s[1]) };
  }).sort((x, y) => x.t - y.t);
  const sectionAt = (t, u) => {
    if (st.length === 1 || t <= st[0].t) return st[0].sec.at(u);
    if (t >= st[st.length - 1].t) return st[st.length - 1].sec.at(u);
    let i = 0;
    while (i < st.length - 2 && t > st[i + 1].t) i++;
    const f = (t - st[i].t) / (st[i + 1].t - st[i].t || 1), s = f * f * (3 - 2 * f);
    const p = st[i].sec.at(u), q = st[i + 1].sec.at(u);
    return [p[0] + (q[0] - p[0]) * s, p[1] + (q[1] - p[1]) * s];
  };
  const z = (t) => (t - 0.5) * L, tOf = (zz) => zz / L + 0.5;
  const extentAt = (t) => { const top = ft(t), bottom = fb(t); return { w: Math.max(0, fw(t)), top, bottom: Math.min(top, bottom) }; };
  const point = (t, u) => {
    const { w, top, bottom } = extentAt(t), [sx, sy] = sectionAt(t, u);
    return [w * sx, (top + bottom) / 2 + ((top - bottom) / 2) * sy, z(t)];
  };
  const centre = (t) => { const { top, bottom } = extentAt(t); return [0, (top + bottom) / 2, z(t)]; };
  const normal = (t, u) => {
    const e = 1e-3, du = 1e-3;
    const pu = sub(point(t, u + du), point(t, u - du));
    let pt = sub(point(Math.min(1, t + e), u), point(Math.max(0, t - e), u));
    if (len(pt) < 1e-9) pt = [0, 0, 1];
    let n = norm(cross(pt, pu));
    const out = sub(point(t, u), centre(t));
    if (len(n) < 1e-9) n = len(out) > 1e-9 ? norm(out) : [0, 0, t > 0.5 ? 1 : -1];
    if (dot(n, out) < 0) n = mul(n, -1);
    return n;
  };
  /** Surface frame for attaching parts: pos, n (outward), fwd (toward the nose, in the tangent plane), side = n x fwd (right-handed: side, n, fwd). */
  const frame = (t, u, lift = 0) => {
    const n = normal(t, u), p = add(point(t, u), mul(n, lift));
    let f = sub([0, 0, 1], mul(n, n[2]));
    if (len(f) < 1e-6) f = sub([0, 1, 0], mul(n, n[1]));
    f = norm(f);
    return { pos: p, n, fwd: f, side: cross(n, f) };
  };
  /** Inner half-width of the section at station t and height y (0 outside the section's height). */
  const halfWidthAt = (t, y) => {
    const { top, bottom } = extentAt(t);
    if (y <= bottom || y >= top) return 0;
    let best = 0;
    const N = 96;
    let prev = point(t, 0);
    for (let k = 1; k <= N / 2; k++) {
      const p = point(t, k / N);
      if ((prev[1] - y) * (p[1] - y) <= 0 && Math.abs(p[1] - prev[1]) > 1e-9) {
        const f = (y - prev[1]) / (p[1] - prev[1]);
        best = Math.max(best, prev[0] + (p[0] - prev[0]) * f);
      }
      prev = p;
    }
    return best;
  };
  const knotT = [...new Set([...plan.map((k) => Number(k[0])), ...prof.map((k) => Number(k[0])), ...st.map((s) => s.t)])].filter((t) => t > 0 && t < 1);
  return { L, z, tOf, point, normal, frame, halfWidthAt, extentAt, sectionAt, knotT, corners: st.flatMap((s) => s.sec.corners), stations: st };
}

// ---------- relief features (panel lines, plates, mask carving) ----------
const circ = (a, b) => { const d = Math.abs((((a - b) % 1) + 1.5) % 1 - 0.5); return d; };
function features(a, S) {
  const pl = a.panel_lines ?? null, rings = [], seams = [], plates = [];
  const perim = (() => { let s = 0, p = S.point(0.5, 0); for (let k = 1; k <= 64; k++) { const q = S.point(0.5, k / 64); s += len(sub(q, p)); p = q; } return Math.max(1, s); })();
  if (pl) {
    if (typeof pl !== 'object') throw new Error('panel_lines must be {rings?:[t..], every?:px, seams?:[u..], width?:1.5, depth?:1, texture?}');
    const w = fnum(pl.width, 1.5, 'panel_lines.width'), d = fnum(pl.depth, 1, 'panel_lines.depth');
    const rt = [...(pl.rings || [])].map(Number);
    if (pl.every) { const ev = Math.max(4, Number(pl.every)); for (let zz = -S.L / 2 + ev; zz < S.L / 2 - ev / 2; zz += ev) rt.push(S.tOf(zz)); }
    for (const t of rt) if (t > 0.01 && t < 0.99) rings.push({ t0: t - w / (2 * S.L), t1: t + w / (2 * S.L), depth: d });
    const mir = pl.mirror !== false;
    for (const u0 of (pl.seams || []).map(Number)) for (const u of mir && Math.abs(u0 - 0.5) > 1e-6 && u0 > 1e-6 ? [u0, 1 - u0] : [u0]) seams.push({ u, hw: w / (2 * perim), depth: d, t0: Number(pl.from ?? 0.02), t1: Number(pl.to ?? 0.98) });
  }
  for (const [k, p] of (a.plates || []).entries()) {
    if (!p || !Array.isArray(p.t) || !Array.isArray(p.u)) throw new Error(`plates[${k}] must be {t:[t0,t1], u:[u0,u1], lift?:1.5, texture?, mirror?:true}`);
    const t0 = Math.max(0.01, Math.min(...p.t.map(Number))), t1 = Math.min(0.99, Math.max(...p.t.map(Number)));
    const [ua, ub] = p.u.map(Number);
    const lift = fnum(p.lift, 1.5, `plates[${k}].lift`);
    const list = [[ua, ub]];
    if (p.mirror !== false && !(ua <= 0.5 && ub >= 0.5 && ua + ub === 1)) list.push([1 - ub, 1 - ua]);
    for (const [u0, u1] of list) plates.push({ t0, t1, u0, u1, depth: -Math.abs(lift), tex: p.texture });
  }
  let mask = null;
  if (a.carve) {
    const c = a.carve;
    if (!c.mask) throw new Error('carve needs mask: <canvas> (opaque pixels = recessed (depth > 0) or raised (depth < 0) hull quads; x = around from the top centre, y = nose (top row) .. tail)');
    mask = { ref: c.mask, depth: fnum(c.depth, 1.5, 'carve.depth'), tex: c.texture };
  }
  const holes = [];
  for (const [k, o] of (a.openings || []).entries()) {
    if (!o || !Array.isArray(o.t) || !Array.isArray(o.u)) throw new Error(`openings[${k}] must be {t:[t0,t1], u:[u0,u1] (u0 > u1 wraps through the top centre), id?}`);
    const t0 = clamp01(Math.min(...o.t.map(Number))), t1 = clamp01(Math.max(...o.t.map(Number)));
    const u0 = ((Number(o.u[0]) % 1) + 1) % 1, u1 = ((Number(o.u[1]) % 1) + 1) % 1;
    holes.push({ t0, t1, u0, u1, id: o.id ?? `opening_${k}` });
  }
  return { rings, seams, plates, mask, perim, holes };
}

/**
 * Hull builder. a: {length, width?, height?, plan?, profile?, sections?|section?, rings?, segments?,
 * crease?:40 deg, interp?, panel_lines?, plates?, carve?, texture|color, groove?, plate_texture?,
 * uv?:"tile"|"fit", caps?:true}.
 */
export function hull(a, ctx) {
  const S = hullSurface(a);
  const F = features(a, S);
  const NR = Math.max(4, Math.min(160, Math.round(fnum(a.rings, Math.max(8, Math.min(48, Math.round(S.L / 14))), 'rings'))));
  const NS = Math.max(4, Math.min(96, 2 * Math.round(fnum(a.segments, 16, 'segments') / 2)));
  const crease = Math.cos((fnum(a.crease, 40, 'crease') * Math.PI) / 180);
  // grid lines: uniform + curve knots + feature borders (+ polygon corners, so creases stay sharp)
  const T = new Set([0, 1]);
  for (let i = 1; i < NR; i++) T.add(i / NR);
  for (const t of S.knotT) T.add(t);
  for (const r of F.rings) { T.add(r.t0); T.add(r.t1); }
  for (const p of F.plates) { T.add(p.t0); T.add(p.t1); }
  for (const s of F.seams) { T.add(Math.max(0, s.t0)); T.add(Math.min(1, s.t1)); }
  for (const h of F.holes) { T.add(h.t0); T.add(h.t1); }
  // patch:{t, u} + inset: only that region of the surface, pushed inward (glazing panes set into the armour)
  const PT = a.patch ? { t0: clamp01(Math.min(...a.patch.t.map(Number))), t1: clamp01(Math.max(...a.patch.t.map(Number))), u0: ((Number(a.patch.u[0]) % 1) + 1) % 1, u1: ((Number(a.patch.u[1]) % 1) + 1) % 1 } : null;
  if (PT) { T.add(PT.t0); T.add(PT.t1); }
  const ts = [...T].map((t) => clamp01(t)).sort((x, y) => x - y).filter((t, i, A) => i === 0 || t - A[i - 1] > 1e-5);
  const U = new Set();
  for (let j = 0; j < NS; j++) U.add(j / NS);
  for (const c of S.corners) U.add(((c % 1) + 1) % 1);
  for (const s of F.seams) { U.add((((s.u - s.hw) % 1) + 1) % 1); U.add((((s.u + s.hw) % 1) + 1) % 1); }
  for (const p of F.plates) { U.add(((p.u0 % 1) + 1) % 1); U.add(((p.u1 % 1) + 1) % 1); }
  for (const h of F.holes) { U.add(h.u0); U.add(h.u1); }
  if (PT) { U.add(PT.u0); U.add(PT.u1); }
  const us = [...U].sort((x, y) => x - y).filter((u, i, A) => i === 0 || u - A[i - 1] > 1e-5);
  const nr = ts.length, nu = us.length;
  const P = ts.map((t) => us.map((u) => S.point(t, u))), N = ts.map((t) => us.map((u) => S.normal(t, u)));
  // mask sampler (u across, nose at the top row)
  let maskAt = null;
  if (F.mask) {
    const mt = ctx.tex(F.mask.ref);
    maskAt = (t, u) => { const x = Math.min(mt.width - 1, Math.floor((((u % 1) + 1) % 1) * mt.width)), y = Math.min(mt.height - 1, Math.floor((1 - t) * mt.height)); return mt.data[(y * mt.width + x) * 4 + 3] >= 128; };
  }
  // quad levels: > 0 recessed, < 0 raised (px along the normal)
  const level = [], qtex = [];
  const base = ctx.tex(a.texture ?? a.color ?? '#7d838d');
  const groove = ctx.tex(a.groove ?? a.panel_lines?.texture ?? '#23262c');
  const plateT = a.plate_texture !== undefined ? ctx.tex(a.plate_texture) : base;
  const carveT = F.mask?.tex !== undefined ? ctx.tex(F.mask.tex) : null;
  for (let i = 0; i < nr - 1; i++) {
    level.push([]); qtex.push([]);
    const tc = (ts[i] + ts[i + 1]) / 2;
    for (let j = 0; j < nu; j++) {
      const u0 = us[j], u1 = j + 1 < nu ? us[j + 1] : 1, uc = (u0 + u1) / 2;
      let L = 0, tx = base;
      if (i > 0 && i < nr - 2) {
        for (const p of F.plates) {
          const inU = p.u0 <= p.u1 ? uc > p.u0 && uc < p.u1 : uc > p.u0 || uc < p.u1;
          if (tc > p.t0 && tc < p.t1 && inU) { L = Math.min(L, p.depth); tx = p.tex !== undefined ? ctx.tex(p.tex) : plateT; }
        }
        if (maskAt && maskAt(tc, uc)) { L = F.mask.depth; tx = carveT ?? (L > 0 ? groove : plateT); }
        let g = 0;
        for (const r of F.rings) if (tc > r.t0 && tc < r.t1) g = Math.max(g, r.depth);
        for (const s of F.seams) if (tc > s.t0 && tc < s.t1 && circ(uc, s.u) < s.hw) g = Math.max(g, s.depth);
        if (g) { L = L < 0 ? L + g : Math.max(L, g); tx = groove; }
      }
      level[i].push(L); qtex[i].push(tx);
    }
  }
  // openings (quads cut through both skins) and the shell (inner skin, px inward along the normal)
  if (PT) {
    const inset = fnum(a.inset, 0, 'inset');
    for (let i = 0; i < nr - 1; i++) for (let j = 0; j < nu; j++) {
      const tc = (ts[i] + ts[i + 1]) / 2, uc = (us[j] + (j + 1 < nu ? us[j + 1] : 1)) / 2;
      level[i][j] = tc > PT.t0 && tc < PT.t1 && (PT.u0 <= PT.u1 ? uc > PT.u0 && uc < PT.u1 : uc > PT.u0 || uc < PT.u1) ? inset : NaN;
      qtex[i][j] = base;
    }
  }
  const shell = PT ? 0 : a.shell !== undefined ? fnum(a.shell, 6, 'shell') : F.holes.length ? 6 : 0;
  if (shell < 0) throw new Error('hull shell must be >= 0 px');
  const hole = level.map((row, i) => row.map((L0, j) => {
    if (Number.isNaN(L0)) return true;
    const tc = (ts[i] + ts[i + 1]) / 2, uc = (us[j] + (j + 1 < nu ? us[j + 1] : 1)) / 2;
    return F.holes.some((h) => tc > h.t0 && tc < h.t1 && (h.u0 <= h.u1 ? uc > h.u0 && uc < h.u1 : uc > h.u0 || uc < h.u1));
  }));
  const at = (i, j, L) => { const jj = j % nu, p = P[i][jj], n = N[i][jj]; return [p[0] - n[0] * L, p[1] - n[1] * L, p[2] - n[2] * L]; };
  // face normals per quad (at its level), then crease-aware vertex normals
  const fn = level.map((row, i) => row.map((L, j) => {
    const A = at(i, j, L), B = at(i, j + 1, L), C = at(i + 1, j + 1, L), D = at(i + 1, j, L);
    let n = norm(add(cross(sub(B, A), sub(D, A)), cross(sub(D, C), sub(B, C))));
    const o = mul(add(N[i][j], N[i + 1][(j + 1) % nu]), 0.5);
    if (len(n) < 1e-9) n = norm(o);
    if (dot(n, o) < 0) n = mul(n, -1);
    return n;
  }));
  const vnorm = (i, j, qi, qj) => {
    const L = level[qi][qj], n0 = fn[qi][qj];
    let s = [0, 0, 0];
    for (const [a2, b2] of [[i - 1, j - 1], [i - 1, j], [i, j - 1], [i, j]]) {
      if (a2 < 0 || a2 >= nr - 1) continue;
      const bb = ((b2 % nu) + nu) % nu;
      if (level[a2][bb] !== L) continue;
      const n1 = fn[a2][bb];
      if (dot(n0, n1) >= crease) s = add(s, n1);
    }
    const r = norm(s);
    return len(r) > 0 ? r : n0;
  };
  // UVs: tile = arc length around (px) x z (px), world scale; fit = u x (1 - t) once over the hull
  const fit = a.uv === 'fit';
  const arc = ts.map((t, i) => { const out = [0]; for (let j = 1; j <= nu; j++) out.push(out[j - 1] + len(sub(P[i][j % nu], P[i][j - 1]))); return out; });
  const uvOf = (tex, i, j) => {
    if (fit) return [j >= nu ? 1 : us[j], 1 - ts[i]];
    const half = arc[i][nu] / 2;
    return [(arc[i][Math.min(j, nu)] - half) / tex.width, -P[i][j % nu][2] / tex.height];
  };
  const m = new Mesh();
  for (let i = 0; i < nr - 1; i++) for (let j = 0; j < nu; j++) {
    if (hole[i][j]) continue;
    const L = level[i][j], tx = qtex[i][j];
    const C = [[i, j], [i, j + 1], [i + 1, j + 1], [i + 1, j]];
    const Pq = C.map(([a2, b2]) => at(a2, b2, L));
    if (len(cross(sub(Pq[2], Pq[0]), sub(Pq[3], Pq[1]))) < 1e-9 && len(cross(sub(Pq[1], Pq[0]), sub(Pq[2], Pq[0]))) < 1e-9) continue;
    const Nq = C.map(([a2, b2]) => vnorm(a2, b2, i, j));
    const f = m.face(tx, Pq, Nq, C.map(([a2, b2]) => uvOf(tx, a2, b2)), fn[i][j], 0);
    if (L) f.edge = false;
  }
  // walls between quads of different levels (facing the deeper side)
  const wall = (A0, B0, La, Lb, ia, ja, ib, jb, deeperC) => {
    const W = [A0(La), B0(La), B0(Lb), A0(Lb)];
    let n = norm(cross(sub(W[1], W[0]), sub(W[3], W[0])));
    const mid = mul(add(add(W[0], W[1]), add(W[2], W[3])), 0.25);
    if (len(n) < 1e-9) return;
    if (dot(n, sub(deeperC, mid)) < 0) n = mul(n, -1);
    const f = m.face(groove, W, n, W.map((p) => [p[0] / groove.width + p[2] / groove.width, -p[1] / groove.height]), n, 0);
    f.edge = true;
  };
  const qc = (i, j) => { const L = level[i][j]; return mul(add(add(at(i, j, L), at(i, j + 1, L)), add(at(i + 1, j, L), at(i + 1, j + 1, L))), 0.25); };
  for (let i = 0; i < nr - 1; i++) for (let j = 0; j < nu; j++) {
    if (hole[i][j]) continue;
    const L = level[i][j];
    // around (j | j + 1): edge from (i, j+1) to (i+1, j+1)
    const jn = (j + 1) % nu, Ln = level[i][jn];
    if (Ln !== L && !hole[i][jn]) wall((K) => at(i, j + 1, K), (K) => at(i + 1, j + 1, K), L, Ln, i, j, i, jn, Ln > L ? qc(i, jn) : qc(i, j));
    if (i + 1 < nr - 1) {
      const Lu = level[i + 1][j];
      if (Lu !== L && !hole[i + 1][j]) wall((K) => at(i + 1, j, K), (K) => at(i + 1, j + 1, K), L, Lu, i, j, i + 1, j, Lu > L ? qc(i + 1, j) : qc(i, j));
    }
  }
  // inner skin (reversed, facing the interior) and rims round the openings (show the thickness)
  // inner skin: offset along the normal, clamped where the section gets thin (no folding at noses / tails)
  const cen = ts.map((t) => { const e = S.extentAt(t); return Math.max(0.01, Math.min(e.w, (e.top - e.bottom) / 2)); });
  const inn = (i, j) => { const jj = j % nu, p = P[i][jj], n = N[i][jj], sh = Math.min(shell, cen[i] * 0.4); return [p[0] - n[0] * sh, p[1] - n[1] * sh, p[2] - n[2] * sh]; };
  // the outer quad (i, j) is emitted in [i,j],[i,j+1],[i+1,j+1],[i+1,j] order unless face() flips it to its normal
  const flipped = (i, j) => { const L = level[i][j], A = at(i, j, L), B = at(i, j + 1, L), C2 = at(i + 1, j + 1, L), D = at(i + 1, j, L); const g = add(cross(sub(B, A), sub(C2, A)), cross(sub(C2, A), sub(D, A))); return dot(g, fn[i][j]) < 0; };
  if (shell > 0) {
    const innerT = ctx.tex(a.inner ?? '#3c4047'), rimT = ctx.tex(a.rim ?? a.groove ?? '#23262c');
    for (let i = 0; i < nr - 1; i++) for (let j = 0; j < nu; j++) {
      if (hole[i][j]) continue;
      const C0 = [[i, j], [i, j + 1], [i + 1, j + 1], [i + 1, j]];
      const C = flipped(i, j) ? C0 : C0.slice().reverse(); // opposite of the outer quad's actual winding
      const Pq = C.map(([a2, b2]) => inn(a2, b2));
      const nIn = mul(fn[i][j], -1);
      if (len(cross(sub(Pq[2], Pq[0]), sub(Pq[3], Pq[1]))) < 1e-9 && len(cross(sub(Pq[1], Pq[0]), sub(Pq[2], Pq[0]))) < 1e-9) continue;
      // winding = the outer quad's reversed (keeps the skin closed even where a thin section folds); shading normal = inward
      const gN = add(cross(sub(Pq[1], Pq[0]), sub(Pq[2], Pq[0])), cross(sub(Pq[2], Pq[0]), sub(Pq[3], Pq[0])));
      m.face(innerT, Pq, C.map(() => nIn), C.map(([a2, b2]) => uvOf(innerT, a2, b2)), len(gN) > 1e-12 ? gN : nIn, 0);
    }
    // rim quad on the outer quad edge A -> B (in that quad's winding): B -> A on the outer skin, A -> B on
    // the inner skin, so it pairs with both skins; shading normal faces into the opening
    const rim = (A, B, L, holeC, fl) => {
      if (PT) return;
      const W = fl ? [at(A[0], A[1], L), at(B[0], B[1], L), inn(B[0], B[1]), inn(A[0], A[1])] : [at(B[0], B[1], L), at(A[0], A[1], L), inn(A[0], A[1]), inn(B[0], B[1])];
      const gN = add(cross(sub(W[1], W[0]), sub(W[2], W[0])), cross(sub(W[2], W[0]), sub(W[3], W[0])));
      if (len(gN) < 1e-12) return;
      let n = norm(gN);
      const mid = mul(add(add(W[0], W[1]), add(W[2], W[3])), 0.25);
      if (dot(n, sub(holeC, mid)) < 0) n = mul(n, -1);
      const f = m.face(rimT, W, n, W.map((p) => [(p[0] + p[2]) / rimT.width, -p[1] / rimT.height]), gN, 0);
      f.edge = true;
    };
    const hc = (i, j) => mul(add(add(P[i][j % nu], P[i][(j + 1) % nu]), add(P[i + 1][j % nu], P[i + 1][(j + 1) % nu])), 0.25);
    for (let i = 0; i < nr - 1; i++) for (let j = 0; j < nu; j++) {
      if (hole[i][j]) continue;
      const L = level[i][j], jn = (j + 1) % nu, jp = (j - 1 + nu) % nu, fl = flipped(i, j);
      if (hole[i][jn]) rim([i, j + 1], [i + 1, j + 1], L, hc(i, jn), fl);
      if (hole[i][jp]) rim([i + 1, j], [i, j], L, hc(i, jp), fl);
      if (i + 1 < nr - 1 && hole[i + 1][j]) rim([i + 1, j + 1], [i + 1, j], L, hc(i + 1, j), fl);
      if (i > 0 && hole[i - 1][j]) rim([i, j], [i, j + 1], L, hc(i - 1, j), fl);
    }
  }
  // end caps (tail t = 0, nose t = 1) where the section is open; a shelled hull also closes its
  // inner skin there, and an open end of a shelled hull gets an annulus rim
  if (!PT) for (const [i, nz] of [[0, -1], [nr - 1, 1]]) {
    const capped = a.caps !== false && !((a.caps === 'nose' && nz < 0) || (a.caps === 'tail' && nz > 0));
    if (shell > 0) {
      const { w: w0, top: tp0, bottom: bt0 } = S.extentAt(ts[i]);
      if (w0 >= 0.25 && tp0 - bt0 >= 0.25) {
        const rimT = ctx.tex(a.rim ?? a.groove ?? '#23262c'), innerT = ctx.tex(a.inner ?? '#3c4047');
        if (!capped) for (let j = 0; j < nu; j++) {
          const q = [P[i][j], P[i][(j + 1) % nu], inn(i, j + 1), inn(i, j)];
          let n = norm(cross(sub(q[1], q[0]), sub(q[3], q[0])));
          if (len(n) < 1e-9) continue;
          if (n[2] * nz < 0) n = mul(n, -1);
          m.face(rimT, q, q.map(() => n), q.map((p) => [p[0] / rimT.width, -p[1] / rimT.height]), n, 0);
        } else {
          const ring = us.map((_, j) => inn(i, j)), ctr = [0, (tp0 + bt0) / 2, ring[0][2]];
          const n = [0, 0, -nz];
          // one winding for the whole cap (from its total area), so it pairs with the inner skin's end ring
          let tot = 0;
          for (let j = 0; j < nu; j++) tot += cross(sub(ring[(j + 1) % nu], ctr), sub(ring[j], ctr))[2];
          const rev = tot * -nz < 0;
          for (let j = 0; j < nu; j++) {
            const tri = rev ? [ctr, ring[j], ring[(j + 1) % nu]] : [ctr, ring[(j + 1) % nu], ring[j]], gN = cross(sub(tri[1], tri[0]), sub(tri[2], tri[0]));
            if (len(gN) < 1e-12) continue;
            m.face(innerT, tri, [n, n, n], tri.map((p) => [p[0] / innerT.width, -p[1] / innerT.height]), gN, 0);
          }
        }
      }
    }
    if (!capped) continue;
    const ring = us.map((_, j) => P[i][j]);
    const { w, top, bottom } = S.extentAt(ts[i]);
    if (w < 0.25 || top - bottom < 0.25) continue;
    const ctr = [0, (top + bottom) / 2, ring[0][2]];
    const pts = [ctr, ...ring], n = [0, 0, nz];
    const tris = ring.map((_, j) => [0, j + 1, ((j + 1) % nu) + 1]);
    const tex = a.cap !== undefined ? ctx.tex(a.cap) : base;
    m.polygon(tex, pts, n, pts.map((p) => [p[0] / tex.width, -p[1] / tex.height]), tris, 0);
  }
  m.hullStats = { rings: nr, segments: nu, quads: (nr - 1) * nu, grooves: F.rings.length + F.seams.length, plates: F.plates.length, ...(shell ? { shell } : {}), ...(F.holes.length ? { openings: F.holes.map((h) => h.id) } : {}) };
  return m;
}

/** Placement of a part on a hull surface: at + rotate (Euler X,Y,Z deg) with local +Y = surface normal, +Z = toward the nose. */
export function hullPlacement(hullPart, spec) {
  const S = hullSurface(hullPart);
  const t = Number(spec.t ?? 0.5), u = Number(spec.u ?? 0);
  if (!Number.isFinite(t) || !Number.isFinite(u)) throw new Error('on_hull needs t (0 tail .. 1 nose) and u (0 top centre, 0.25 +x side, 0.5 keel, 0.75 -x side)');
  const fr = S.frame(clamp01(t), u, Number(spec.lift ?? 0));
  const off = hullPart.at ? hullPart.at.map(Number) : [0, 0, 0];
  // rotation matrix columns: local x = side, y = n, z = fwd
  const R = [[fr.side[0], fr.n[0], fr.fwd[0]], [fr.side[1], fr.n[1], fr.fwd[1]], [fr.side[2], fr.n[2], fr.fwd[2]]];
  return { pos: add(fr.pos, off), R, n: fr.n, fwd: fr.fwd };
}
