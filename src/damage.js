// Damage states for art_model: variants of a built model (px, after world UVs / CTM / overlays)
// at a damage amount 0..1. One seeded feature set per model (every feature has an onset amount),
// so scuffed is a subset of damaged is a subset of wrecked, and the same set feeds the per-texel
// masks (continuous intact -> wrecked blend on one mesh) and the vertex damage channel.
// Geometry: dents / crumples (edge-consistent subdivision + displacement with falloff, scaled by
// part rigidity), panel loss (plate removed, inner backing + frame + exposed wiring revealed) and
// offset (hinged out), bent thin parts, glass shard holes, hull breaches (BSP subtract with a
// curled rim and exposed ribs), emissive screens / lamps killed. Surface: scorch + soot,
// scratches, edge wear, bullet-hole clusters, glass / screen cracks (pixel-art decal shell over
// a per-face chart atlas). FX sockets (spark, smoke, fire, steam, leak, flicker) for the game.
// Nothing here runs unless a model has damage states, so plain builds / exports are unchanged.
import { Mesh } from './model3d.js';
import { faceBasis } from './ctm.js';
import { mulberry32, hash3, BAYER4 } from './util.js';
import { booleanMesh, manifoldStats } from './csg.js';
import { closeOpenMesh } from './remesh.js';
import { sweep } from './sweep.js';

const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const norm = (a) => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (a, b, t) => a + (b - a) * t;
/** Rotate v about unit axis k by angle a (rad). */
const rotAxis = (v, k, a) => { const c = Math.cos(a), s = Math.sin(a); return add(add(mul(v, c), mul(cross(k, v), s)), mul(k, dot(k, v) * (1 - c))); };

// ---------- spec ----------
export const DAMAGE_KINDS = ['generic', 'door', 'terminal', 'console', 'crate', 'barrel', 'glass', 'light', 'hull', 'engine'];
export const STATE_PRESETS = { intact: 0, scuffed: 0.25, damaged: 0.6, wrecked: 1 };
export const FEATURES = ['dents', 'panels', 'bend', 'glass', 'scorch', 'scratches', 'wear', 'bullets', 'wires', 'breach', 'emissive'];
export const FX_KINDS = ['spark', 'smoke', 'fire', 'steam', 'leak', 'flicker'];
/** Per-kind feature weights (1 = generic). */
const KIND_W = {
  generic: {},
  door: { panels: 0.6, bend: 0.5, breach: 0 },
  terminal: { glass: 1.5, emissive: 1, panels: 0.8, breach: 0 },
  console: { glass: 1.3, emissive: 1, panels: 1, breach: 0 },
  crate: { dents: 1.4, panels: 1.3, breach: 0, scorch: 0.8 },
  barrel: { dents: 1.6, panels: 0.6, breach: 0 },
  glass: { glass: 2, dents: 0.2, panels: 0, breach: 0, scorch: 0.5, bend: 0.3 },
  light: { glass: 1.5, emissive: 1, breach: 0 },
  hull: { breach: 1.5, dents: 1.2, panels: 1.2, scorch: 1.3, bullets: 1.3 },
  engine: { bend: 1.2, scorch: 1.8, panels: 1.3, breach: 0.8 },
};
const NAME_RE = /^[A-Za-z0-9_.-]{1,48}$/;

/** def.damage -> normalized spec (throws on bad input). */
export function normDamage(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) throw new Error('damage must be {states:[{name, amount?, seed?, regions?, features?}], kind?, seed?, rigid?, roles?, inner?, frame?, sparks?}');
  const kind = d.kind ?? 'generic';
  if (!DAMAGE_KINDS.includes(kind)) throw new Error(`damage kind must be one of ${DAMAGE_KINDS.join(', ')}`);
  const seed = Math.round(Number(d.seed ?? 1));
  if (!Number.isFinite(seed)) throw new Error('damage seed must be an integer');
  const list = d.states ?? ['scuffed', 'damaged', 'wrecked'];
  if (!Array.isArray(list) || !list.length || list.length > 8) throw new Error('states must be a list of 1-8 states: "scuffed"|"damaged"|"wrecked" or {name, amount 0..1, seed?, regions?, features?}');
  const seen = new Set();
  const states = list.map((s0, i) => {
    const s = typeof s0 === 'string' ? { name: s0 } : s0;
    if (!s || typeof s !== 'object' || !NAME_RE.test(s.name || '')) throw new Error(`state ${i}: needs name (1-48 letters, digits, _ - .)`);
    if (s.name === 'intact') throw new Error('state "intact" is implicit (the undamaged model); name the damaged states');
    if (seen.has(s.name)) throw new Error(`state "${s.name}" is listed twice`);
    seen.add(s.name);
    const amount = Number(s.amount ?? STATE_PRESETS[s.name]);
    if (!(amount >= 0 && amount <= 1)) throw new Error(`state "${s.name}": amount must be 0..1 (custom states need an amount; presets scuffed 0.25, damaged 0.6, wrecked 1)`);
    const feats = {};
    if (s.features !== undefined) {
      if (!s.features || typeof s.features !== 'object') throw new Error(`state "${s.name}": features must be {${FEATURES.join('|')}: weight 0..3}`);
      for (const [k, v] of Object.entries(s.features)) {
        if (!FEATURES.includes(k)) throw new Error(`state "${s.name}": unknown feature "${k}" (${FEATURES.join(', ')})`);
        const w = v === true ? 1 : v === false ? 0 : Number(v);
        if (!(w >= 0 && w <= 3)) throw new Error(`state "${s.name}": features.${k} must be 0..3`);
        feats[k] = w;
      }
    }
    const regions = s.regions === undefined ? null : normRegions(s.regions, s.name);
    const sseed = s.seed === undefined ? seed : Math.round(Number(s.seed));
    if (!Number.isFinite(sseed)) throw new Error(`state "${s.name}": seed must be an integer`);
    return { name: s.name, amount, seed: sseed, regions, features: feats };
  });
  const rigid = {};
  if (d.rigid !== undefined) {
    if (!d.rigid || typeof d.rigid !== 'object') throw new Error('rigid must be {<part name|index>: 0..1} (1 = never dents or bends)');
    for (const [k, v] of Object.entries(d.rigid)) { const r = Number(v); if (!(r >= 0 && r <= 1)) throw new Error(`rigid.${k} must be 0..1`); rigid[k] = r; }
  }
  const roles = {};
  if (d.roles !== undefined) {
    if (!d.roles || typeof d.roles !== 'object') throw new Error('roles must be {panels?, glass?, screens?, lights?, bend?, leaf?, breach?, keep?: [part names|indices]}');
    for (const [k, v] of Object.entries(d.roles)) {
      if (!['panels', 'glass', 'screens', 'lights', 'bend', 'leaf', 'breach', 'keep'].includes(k)) throw new Error(`roles.${k}: unknown role (panels, glass, screens, lights, bend, leaf, breach, keep)`);
      roles[k] = [].concat(v);
    }
  }
  const close = d.close ?? 'auto';
  if (!['auto', false].includes(close)) throw new Error('damage close must be "auto" (an open breach host is closed by the cleanup hole fill so the breach is a real boolean cut) or false (open hosts get the subdivide-and-drop hole)');
  return { kind, seed, states, rigid, roles, inner: d.inner ?? '#23262c', frame: d.frame ?? '#555a63', sparks: d.sparks !== false, palette: d.palette || null, close };
}
function normRegions(v, sn) {
  const list = [].concat(v);
  return list.map((r) => {
    if (typeof r === 'string' || typeof r === 'number') return { parts: [r], amount: 1 };
    if (!r || typeof r !== 'object') throw new Error(`state "${sn}": regions are part names / indices or {parts?:[..], at?:[x,y,z] px, r?:px, amount?}`);
    const o = { parts: r.parts ? [].concat(r.parts) : null, amount: Number(r.amount ?? 1) };
    if (r.at !== undefined) {
      if (!Array.isArray(r.at) || r.at.length !== 3 || r.at.some((x) => !Number.isFinite(Number(x)))) throw new Error(`state "${sn}": region at must be [x,y,z] px`);
      o.at = r.at.map(Number); o.r = Number(r.r ?? 16);
      if (!(o.r > 0)) throw new Error(`state "${sn}": region r must be > 0 px`);
    }
    if (!(o.amount >= 0 && o.amount <= 3)) throw new Error(`state "${sn}": region amount must be 0..3`);
    return o;
  });
}

// ---------- triangle soup (faces keep their records) ----------
const vtx = (g, v) => ({ p: [g.pos[v * 3], g.pos[v * 3 + 1], g.pos[v * 3 + 2]], n: [g.nrm[v * 3], g.nrm[v * 3 + 1], g.nrm[v * 3 + 2]], uv: [g.uv[v * 2], g.uv[v * 2 + 1]] });
/** Mesh -> {faces:[{tex, rec, V:[{p,n,uv,r(rest)}], T:[[a,b,c]]}], overlays:[{tex, V, T}]} */
export function explode(mesh) {
  const faces = [], overlays = [];
  for (const g of mesh.groups.values()) {
    if (g.overlay) {
      const V = [];
      for (let i = 0; i < g.pos.length / 3; i++) { const v = vtx(g, i); v.uv0 = [g.uv0[i * 2], g.uv0[i * 2 + 1]]; v.a = g.alpha[i]; v.node = g.vnode ? g.vnode[i] : undefined; v.r = v.p.slice(); V.push(v); }
      const T = [];
      for (let i = 0; i < g.idx.length; i += 3) T.push([g.idx[i], g.idx[i + 1], g.idx[i + 2]]);
      overlays.push({ tex: g.tex, V, T });
      continue;
    }
    for (const f of g.faces) {
      const map = new Map(), V = [], T = [];
      const at = (v) => { let j = map.get(v); if (j === undefined) { j = V.length; map.set(v, j); const x = vtx(g, v); x.r = x.p.slice(); V.push(x); } return j; };
      for (let v = f.v; v < f.v + f.vc; v++) at(v);
      for (let i = f.i; i < f.i + f.ic; i += 3) T.push([at(g.idx[i]), at(g.idx[i + 1]), at(g.idx[i + 2])]);
      const { v: _v, vc: _vc, i: _i, ic: _ic, ...rec } = f;
      rec.n = f.n.slice();
      faces.push({ tex: g.tex, rec, V, T });
    }
  }
  return { faces, overlays };
}
/** Soup -> Mesh (unused vertices dropped). opts.uvd: write chart UVs (v.cu) as g.uvd (the damage mask UV set; its own TEXCOORD after any AO / lightmap UVs); opts.uv1: the same as g.uv1; opts.dmg: per-vertex damage RGBA (v.dmg) as g.dmg; opts.morph: {name} = displaced positions as a morph target (rest = v.r). */
export function implode(soup, opts = {}) {
  const m = new Mesh();
  for (const F of soup.faces) {
    if (!F.T.length) continue;
    const g = m.group(F.tex), base = g.pos.length / 3, i0 = g.idx.length, map = new Map();
    if (opts.uv1 && !g.uv1) g.uv1 = [];
    if (opts.uvd && !g.uvd) g.uvd = [];
    if (opts.dmg && !g.dmg) g.dmg = [];
    if (opts.morph && !g.morphs) g.morphs = [{ name: opts.morph.name, pos: [], nrm: [] }];
    for (const t of F.T) for (const k of t) if (!map.has(k)) {
      map.set(k, base + map.size);
      const v = F.V[k];
      const P = opts.morph ? v.r : v.p, N = opts.morph ? (v.rn || v.n) : v.n;
      g.pos.push(P[0], P[1], P[2]); g.nrm.push(N[0], N[1], N[2]); g.uv.push(v.uv[0], v.uv[1]);
      if (opts.uv1) g.uv1.push(...(v.cu || [0, 0]));
      if (opts.uvd) g.uvd.push(...(v.cu || [0, 0]));
      if (opts.dmg) g.dmg.push(...(v.dmg || [0, 0, 0, 0]));
      if (opts.morph) { g.morphs[0].pos.push(v.p[0], v.p[1], v.p[2]); g.morphs[0].nrm.push(v.n[0], v.n[1], v.n[2]); }
    }
    for (const t of F.T) g.idx.push(map.get(t[0]), map.get(t[1]), map.get(t[2]));
    g.faces.push({ ...F.rec, n: F.rec.n.slice(), v: base, vc: map.size, i: i0, ic: g.idx.length - i0 });
  }
  for (const O of soup.overlays) {
    if (!O.T.length) continue;
    const g = m.group(O.tex, true), base = g.pos.length / 3, map = new Map();
    if (opts.morph && !g.morphs) g.morphs = [{ name: opts.morph.name, pos: [], nrm: [] }];
    for (const t of O.T) for (const k of t) if (!map.has(k)) {
      map.set(k, base + map.size);
      const v = O.V[k];
      if (opts.morph) { const P = v.r || v.p, N = v.rn || v.n; g.pos.push(P[0], P[1], P[2]); g.nrm.push(N[0], N[1], N[2]); g.morphs[0].pos.push(v.p[0], v.p[1], v.p[2]); g.morphs[0].nrm.push(v.n[0], v.n[1], v.n[2]); }
      else { g.pos.push(v.p[0], v.p[1], v.p[2]); g.nrm.push(v.n[0], v.n[1], v.n[2]); }
      g.uv.push(v.uv[0], v.uv[1]); g.uv0.push(v.uv0[0], v.uv0[1]); g.alpha.push(v.a);
      if (v.node !== undefined || g.vnode) { if (!g.vnode) g.vnode = new Array(g.pos.length / 3 - 1).fill(null); g.vnode.push(v.node ?? null); }
    }
    for (const t of O.T) g.idx.push(map.get(t[0]), map.get(t[1]), map.get(t[2]));
  }
  return m;
}
const midV = (a, b) => {
  const v = { p: [(a.p[0] + b.p[0]) * 0.5, (a.p[1] + b.p[1]) * 0.5, (a.p[2] + b.p[2]) * 0.5], n: norm(add(a.n, b.n)), uv: [(a.uv[0] + b.uv[0]) * 0.5, (a.uv[1] + b.uv[1]) * 0.5] };
  v.r = a.r && b.r ? [(a.r[0] + b.r[0]) * 0.5, (a.r[1] + b.r[1]) * 0.5, (a.r[2] + b.r[2]) * 0.5] : v.p.slice();
  if (a.uv0) { v.uv0 = [(a.uv0[0] + b.uv0[0]) * 0.5, (a.uv0[1] + b.uv0[1]) * 0.5]; v.a = (a.a + b.a) * 0.5; v.node = a.node; }
  if (a.cu && b.cu) v.cu = [(a.cu[0] + b.cu[0]) * 0.5, (a.cu[1] + b.cu[1]) * 0.5];
  return v;
};
/**
 * Edge-based subdivision of a face / overlay piece: an edge splits when need(pa, pb) (a pure
 * function of the two end positions), so faces sharing an edge split it the same way and the
 * surface stays crack-free under displacement. Mid-points are (a + b) / 2 (order independent).
 */
function subdivide(F, need, iters, budget) {
  for (let it = 0; it < iters; it++) {
    if (budget.left <= 0) return;
    const mids = new Map();
    const mid = (i, j) => { const k = i < j ? `${i}_${j}` : `${j}_${i}`; let m = mids.get(k); if (m === undefined) { m = F.V.length; F.V.push(midV(F.V[i], F.V[j])); mids.set(k, m); } return m; };
    const out = [];
    let any = false;
    for (const t of F.T) {
      const s = [need(F.V[t[0]].r, F.V[t[1]].r), need(F.V[t[1]].r, F.V[t[2]].r), need(F.V[t[2]].r, F.V[t[0]].r)];
      const n = s[0] + s[1] + s[2];
      if (!n || budget.left <= 0) { out.push(t); continue; }
      any = true;
      if (n === 3) {
        const [a, b, c] = t, ab = mid(a, b), bc = mid(b, c), ca = mid(c, a);
        out.push([a, ab, ca], [ab, b, bc], [ca, bc, c], [ab, bc, ca]);
        budget.left -= 3;
        continue;
      }
      // rotate so the (first) split edge is a-b
      let r = 0;
      if (n === 1) r = s.indexOf(true);
      else r = !s[0] ? 1 : !s[1] ? 2 : 0; // two splits: edges r and r+1 split
      const a = t[r], b = t[(r + 1) % 3], c = t[(r + 2) % 3];
      if (n === 1) { const ab = mid(a, b); out.push([a, ab, c], [ab, b, c]); budget.left -= 1; }
      else { const ab = mid(a, b), bc = mid(b, c); out.push([ab, b, bc], [a, ab, bc], [a, bc, c]); budget.left -= 2; }
    }
    F.T = out;
    if (!any) return;
  }
}
/** Per-face smooth normals from the current (deformed) positions; flat faces keep theirs. */
function renormal(F) {
  const acc = F.V.map(() => [0, 0, 0]);
  for (const [a, b, c] of F.T) { const n = cross(sub(F.V[b].p, F.V[a].p), sub(F.V[c].p, F.V[a].p)); for (const k of [a, b, c]) acc[k] = add(acc[k], n); }
  F.V.forEach((v, i) => { if (len(acc[i]) > 1e-12) { v.rn = v.rn || v.n; v.n = norm(acc[i]); } });
}
const triArea = (P, Q, R) => len(cross(sub(Q, P), sub(R, P))) / 2;

// ---------- noise ----------
function vnoise(p, cell, seed) {
  const x = p[0] / cell, y = p[1] / cell, z = p[2] / cell;
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z), fx = x - xi, fy = y - yi, fz = z - zi;
  const h = (a, b, c) => hash3(Math.imul(a, 73856093) ^ Math.imul(c, 83492791), b, seed);
  const s = (t) => t * t * (3 - 2 * t);
  const l = (a, b, t) => a + (b - a) * s(t);
  return l(l(l(h(xi, yi, zi), h(xi + 1, yi, zi), fx), l(h(xi, yi + 1, zi), h(xi + 1, yi + 1, zi), fx), fy), l(l(h(xi, yi, zi + 1), h(xi + 1, yi, zi + 1), fx), l(h(xi, yi + 1, zi + 1), h(xi + 1, yi + 1, zi + 1), fx), fy), fz);
}

// ---------- part analysis ----------
/** Parts of a built model (faces tagged with pi = part index) with bounds, area and roles. */
export function analyseParts(soup, def, spec) {
  const parts = new Map();
  let total = 0;
  for (const F of soup.faces) {
    const pi = F.rec.pi ?? -1;
    let P = parts.get(pi);
    if (!P) parts.set(pi, (P = { pi, faces: [], min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity], area: 0, glass: false, emissive: false, def: def.parts[pi] || null, normals: new Map() }));
    P.faces.push(F);
    for (const v of F.V) for (let k = 0; k < 3; k++) { if (v.p[k] < P.min[k]) P.min[k] = v.p[k]; if (v.p[k] > P.max[k]) P.max[k] = v.p[k]; }
    let a = 0;
    for (const [i, j, k] of F.T) a += triArea(F.V[i].p, F.V[j].p, F.V[k].p);
    F.area = a; P.area += a; total += a;
    const nk = F.rec.n.map((v) => Math.round(v * 100)).join(',');
    P.normals.set(nk, (P.normals.get(nk) || 0) + a);
    if (F.tex.material?.glass || (F.tex.material && F.tex.material.opacity < 1)) P.glass = true;
    if (F.tex.emissive) P.emissive = true;
  }
  const byRef = (k) => {
    if (typeof k === 'number' || /^\d+$/.test(String(k))) return Number(k);
    const i = def.parts.findIndex((p) => p && (p.name === k || p.id === k));
    if (i < 0) throw new Error(`damage: no part ${JSON.stringify(k)} (part indices or names: ${def.parts.map((p, j) => p?.name ?? j).join(', ')})`);
    return i;
  };
  const role = (r) => new Set((spec.roles[r] || []).map(byRef));
  const R = Object.fromEntries(['panels', 'glass', 'screens', 'lights', 'bend', 'leaf', 'breach', 'keep'].map((k) => [k, spec.roles[k] ? role(k) : null]));
  const list = [...parts.values()].filter((P) => P.pi >= 0);
  const vol = (P) => P.max.reduce((s, v, k) => s * Math.max(0.5, v - P.min[k]), 1);
  const biggest = list.reduce((b, P) => (!b || vol(P) > vol(b) ? P : b), null);
  // sizes first: the door leaf guess compares every part
  for (const P of list) { P.size = P.max.map((v, k) => v - P.min[k]); P.center = P.min.map((v, k) => (v + P.max[k]) / 2); }
  for (const P of list) {
    const srt = [...P.size].sort((a, b) => a - b);
    let mainN = null, best = -1;
    for (const [k, a] of P.normals) if (a > best) { best = a; mainN = k.split(',').map((v) => Number(v) / 100); }
    P.mainN = norm(mainN || [0, 0, 1]);
    const keep = R.keep?.has(P.pi);
    P.isGlass = R.glass ? R.glass.has(P.pi) : P.glass;
    P.isScreen = R.screens ? R.screens.has(P.pi) : P.emissive && spec.kind !== 'light' && !P.isGlass;
    P.isLight = R.lights ? R.lights.has(P.pi) : P.emissive && spec.kind === 'light';
    P.isPanel = !keep && (R.panels ? R.panels.has(P.pi) : P !== biggest && !P.isGlass && !P.isScreen && !P.isLight && !P.emissive && srt[0] <= Math.min(6, srt[1] * 0.3) && srt[1] >= 4 && srt[1] * srt[2] >= 24);
    P.isBend = !keep && (R.bend ? R.bend.has(P.pi) : P !== biggest && !P.isGlass && srt[2] >= 4 * Math.max(1, srt[1]) && srt[2] >= 10 && srt[1] <= 3);
    // engine pods: nozzles / cones knocked askew (hinged, never lost)
    P.isAskew = !keep && spec.kind === 'engine' && P !== biggest && !P.isGlass && ['cylinder', 'cone', 'lathe', 'prism'].includes(P.def?.type) && srt[1] >= 6;
    P.isLeaf = R.leaf ? R.leaf.has(P.pi) : spec.kind === 'door' && P === leafGuess(list, biggest);
    P.isBreach = R.breach ? R.breach.has(P.pi) : P === biggest && !P.isGlass;
    const rk = Object.keys(spec.rigid).find((k) => byRef(k) === P.pi);
    P.rigid = rk !== undefined ? spec.rigid[rk] : P.isGlass ? 1 : P.isScreen ? 0.8 : 0.25;
  }
  return { parts, list, total, biggest };
}
function leafGuess(list, biggest) {
  // the door leaf: the biggest thin slab (not the frame)
  let best = null, bv = -1;
  for (const P of list) {
    const s = [...P.size].sort((a, b) => a - b);
    if (s[0] > s[1] * 0.35 || P.isGlass) continue;
    const v = s[1] * s[2];
    if (v > bv) { bv = v; best = P; }
  }
  return best || biggest;
}

// ---------- seeded feature set ----------
/** Area-weighted random point on the faces passing ok(F): {F, p, n} or null. */
function sampler(faces, rnd, ok) {
  const items = [];
  let tot = 0;
  for (const F of faces) {
    if (!ok(F)) continue;
    for (const [i, j, k] of F.T) { const a = triArea(F.V[i].r, F.V[j].r, F.V[k].r); if (a < 1e-6) continue; tot += a; items.push({ F, t: [i, j, k], c: tot }); }
  }
  return () => {
    if (!items.length) return null;
    const x = rnd() * tot;
    let lo = 0, hi = items.length - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (items[m].c < x) lo = m + 1; else hi = m; }
    const it = items[lo];
    let u = rnd(), v = rnd();
    if (u + v > 1) { u = 1 - u; v = 1 - v; }
    const [A, B, C] = it.t.map((q) => it.F.V[q].r);
    return { F: it.F, p: [0, 1, 2].map((k) => A[k] + (B[k] - A[k]) * u + (C[k] - A[k]) * v), n: it.F.rec.n };
  };
}
const regionW = (regions, F, p) => {
  if (!regions) return 1;
  let w = 0;
  for (const r of regions) {
    if (r.parts && !r.parts.some((k) => k === F.rec.pi || k === F.rec.pname)) continue;
    if (r.at && len(sub(p, r.at)) > r.r) continue;
    w = Math.max(w, r.amount);
  }
  return w;
};

/**
 * The model's damage features for one seed / region set: every feature carries an onset (the
 * amount where it appears) and strength. -> {dents, scorch, bullets, scratches, cracks, panels,
 * bends, glassHoles, breaches, wires(later), scale}
 */
export function featureSet(soup, info, spec, st, def) {
  const rnd = mulberry32((st.seed * 2654435761) ^ 0x5bd1e995);
  const W = { ...(KIND_W[spec.kind] || {}), ...st.features };
  const w = (k) => W[k] ?? 1;
  for (const F of soup.faces) if (F.rec.pi !== undefined && def.parts[F.rec.pi]) F.rec.pname = def.parts[F.rec.pi].name ?? def.parts[F.rec.pi].id;
  const b = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  for (const F of soup.faces) for (const v of F.V) for (let k = 0; k < 3; k++) { b.min[k] = Math.min(b.min[k], v.r[k]); b.max[k] = Math.max(b.max[k], v.r[k]); }
  const diag = len(sub(b.max, b.min)) || 1;
  const S = Math.max(0.6, Math.min(4, diag / 48)); // feature size scale (a 48 px prop = 1)
  const partOf = (F) => info.parts.get(F.rec.pi ?? -1);
  const solid = (F) => { const P = partOf(F); return P && !P.isGlass; };
  const inRegion = (F, p) => regionW(st.regions, F, p);
  const pick = (ok) => { const s = sampler(soup.faces, rnd, ok); return () => { for (let t = 0; t < 12; t++) { const r = s(); if (!r) return null; const rw = inRegion(r.F, r.p); if (rw > 0) { r.rw = rw; return r; } } return null; }; };
  const A = info.total;
  const count = (per1000, lo, hi, k) => (w(k) <= 0 ? 0 : Math.max(lo, Math.min(hi, Math.round((A / 1000) * per1000 * w(k)))));
  const out = { dents: [], scorch: [], bullets: [], scratches: [], cracks: [], panels: [], bends: [], glassHoles: [], breaches: [], screens: [], lights: [], scale: S, diag, bounds: b };
  // dents (pushed in; crates / barrels bulge out when they burst)
  const pd = pick((F) => solid(F) && (partOf(F).rigid < 1));
  for (let i = 0, n = count(0.5, 2, 28, 'dents'); i < n; i++) {
    const s = pd(); if (!s) break;
    const onset = 0.08 + 0.85 * rnd();
    const out1 = (spec.kind === 'crate' || spec.kind === 'barrel') && onset > 0.75 && rnd() < 0.5;
    out.dents.push({ c: s.p, dir: mul(s.n, out1 ? 1 : -1), r: (3 + 7 * rnd()) * S, depth: (0.25 + 0.25 * rnd()), onset, rw: s.rw });
  }
  // scorch + soot plumes
  const ps = pick((F) => !!partOf(F));
  for (let i = 0, n = count(0.18, 1, 9, 'scorch'); i < n; i++) { const s = ps(); if (!s) break; out.scorch.push({ c: s.p, r: (3 + 7 * rnd()) * S, onset: 0.3 + 0.65 * rnd(), seed: Math.floor(rnd() * 1e6), rw: s.rw }); }
  // bullet-hole clusters (holes on the face plane around a centre)
  for (let i = 0, n = count(0.3, 1, 14, 'bullets'); i < n; i++) {
    const s = ps(); if (!s) break;
    const { t, b: bb } = faceBasis(s.n), onset = 0.12 + 0.8 * rnd(), k = 2 + Math.floor(rnd() * 5), spread = (2 + 4 * rnd()) * Math.sqrt(S);
    const holes = [];
    for (let j = 0; j < k; j++) { const a = rnd() * Math.PI * 2, d = spread * Math.sqrt(rnd()); holes.push({ c: add(s.p, add(mul(t, Math.cos(a) * d), mul(bb, Math.sin(a) * d))), r: 0.55 + 0.5 * rnd() }); }
    out.bullets.push({ c: s.p, n: s.n, holes, onset: Math.min(0.97, onset + j0(rnd)), rw: s.rw, glass: partOf(s.F).isGlass });
  }
  // scratches: short in-plane segments
  for (let i = 0, n = count(4, 2, 160, 'scratches'); i < n; i++) {
    const s = ps(); if (!s) break;
    const { t, b: bb } = faceBasis(s.n), a = rnd() * Math.PI, L = (2 + 6 * rnd()) * Math.sqrt(S);
    const d = add(mul(t, Math.cos(a) * L), mul(bb, Math.sin(a) * L));
    out.scratches.push({ a: s.p, b: add(s.p, d), n: s.n, onset: 0.02 + 0.6 * rnd(), rw: s.rw });
  }
  // part-level features
  const parts = info.list;
  const order = (pred) => parts.filter(pred).map((P) => ({ P, k: rnd() })).sort((x, y) => x.k - y.k).map((x) => x.P);
  for (const P of order((P) => P.isAskew && !P.isPanel)) out.panels.push({ P, lost: false, onset: 0.6 + 0.25 * rnd(), hinge: Math.floor(rnd() * 4), angle: 10 + 12 * rnd(), seed: Math.floor(rnd() * 1e6), wires: 0 });
  for (const P of order((P) => P.isPanel && !P.isLeaf)) {
    const rw = regionW(st.regions, { rec: { pi: P.pi, pname: P.def?.name ?? P.def?.id } }, P.center);
    if (rw <= 0 || w('panels') <= 0) continue;
    const lost = rnd() < 0.55;
    out.panels.push({ P, lost, onset: Math.min(0.98, (lost ? 0.62 : 0.42) + 0.33 * rnd() / Math.max(0.5, w('panels'))), hinge: Math.floor(rnd() * 4), angle: 12 + 26 * rnd(), wires: 1 + Math.floor(rnd() * 3), seed: Math.floor(rnd() * 1e6) });
  }
  for (const P of order((P) => P.isLeaf)) {
    if (w('panels') <= 0) continue;
    out.panels.push({ P, leaf: true, lost: false, onset: 0.45, hinge: 0, angle: 0, seed: Math.floor(rnd() * 1e6), wires: 2 });
  }
  for (const P of order((P) => P.isBend && !P.isPanel)) {
    if (w('bend') <= 0 || regionW(st.regions, { rec: { pi: P.pi, pname: P.def?.name ?? P.def?.id } }, P.center) <= 0) continue;
    const L = Math.max(...P.size);
    out.bends.push({ P, onset: 0.55 + 0.4 * rnd(), angle: (12 + 24 * rnd()) * Math.min(1.5, w('bend')) * Math.min(1, 28 / L), dir: rnd() * Math.PI * 2 });
  }
  for (const P of order((P) => P.isGlass || P.isScreen || P.isLight)) {
    if (w('glass') <= 0 && w('emissive') <= 0) continue;
    // impact on the part's main face
    const faces = P.faces.filter((F) => dot(F.rec.n, P.mainN) > 0.9);
    const s = sampler(faces.length ? faces : P.faces, rnd, () => true)();
    if (!s) continue;
    const shatter = spec.kind === 'glass' ? 0.8 : 0.4;
    const r = Math.max(2, Math.min(P.size[0] + P.size[1] + P.size[2], 64) * (0.12 + shatter * 0.35 * rnd()));
    const rays = [];
    const { t, b: bb } = faceBasis(P.mainN);
    const nr = 5 + Math.floor(rnd() * 5);
    for (let j = 0; j < nr; j++) {
      let a = (j / nr) * Math.PI * 2 + rnd() * 0.6, p = s.p;
      const L = r * (1.4 + 1.6 * rnd()), steps = 3 + Math.floor(rnd() * 3);
      for (let q = 0; q < steps; q++) { a += (rnd() - 0.5) * 0.7; const np = add(p, mul(add(mul(t, Math.cos(a)), mul(bb, Math.sin(a))), L / steps)); rays.push({ a: p, b: np }); p = np; }
    }
    const ring = [];
    for (let j = 0; j < 10; j++) { const a0 = (j / 10) * Math.PI * 2, a1 = a0 + Math.PI / 5 * (0.6 + 0.3 * rnd()), rr = r * (0.9 + 0.3 * rnd()); ring.push({ a: add(s.p, add(mul(t, Math.cos(a0) * rr), mul(bb, Math.sin(a0) * rr))), b: add(s.p, add(mul(t, Math.cos(a1) * rr), mul(bb, Math.sin(a1) * rr))) }); }
    const crackOnset = P.isGlass ? 0.25 + 0.2 * rnd() : 0.4 + 0.15 * rnd();
    out.cracks.push({ P, c: s.p, n: P.mainN, segs: [...rays, ...ring], onset: crackOnset });
    if (w('glass') > 0) {
      const big = spec.kind === 'glass' ? 0.9 : 0.55;
      out.glassHoles.push({ P, c: s.p, n: P.mainN, r: r * (P.isGlass ? 1 : 0.5), rmax: Math.max(...P.size) * (P.isGlass ? big : 0.3), onset: Math.min(0.97, P.isGlass ? crackOnset + 0.25 + 0.15 * rnd() : 0.74 + 0.16 * rnd()), seed: Math.floor(rnd() * 1e6) });
    }
    if (P.isScreen) out.screens.push({ P, onset: 0.7 + 0.2 * rnd() });
    if (P.isLight) out.lights.push({ P, onset: 0.4 + 0.15 * rnd(), off: 0.75 + 0.2 * rnd() });
  }
  if (w('breach') > 0) for (const P of order((P) => P.isBreach)) {
    const faces = P.faces.filter((F) => F.area > 64 * S && Math.abs(F.rec.n[1]) < 0.9);
    const s = sampler(faces.length ? faces : P.faces.filter((F) => F.area > 16), rnd, () => true)();
    if (!s) continue;
    const rw = regionW(st.regions, s.F, s.p);
    if (rw <= 0) continue;
    const thick = Math.abs(dot(P.size, s.n.map(Math.abs)));
    // keep the opening inside its face: radius <= 0.42 x the face's smaller extent, centre clamped by R
    const { t: ft, b: fb } = faceBasis(s.n), ext = [ft, fb].map((ax) => { const d = s.F.V.map((v) => dot(v.r, ax)); return [Math.min(...d), Math.max(...d)]; });
    const R = Math.min((5 + 6 * rnd()) * S * Math.min(1.6, w('breach')), Math.sqrt(s.F.area) * 0.42, 0.42 * Math.min(...ext.map(([lo, hi]) => hi - lo)));
    if (R < 2.5) continue;
    [ft, fb].forEach((ax, k) => { const [lo, hi] = ext[k], d = dot(s.p, ax), cd = Math.min(hi - R * 1.05, Math.max(lo + R * 1.05, d)); s.p = add(s.p, mul(ax, cd - d)); });
    const nv = 11 + Math.floor(rnd() * 5), jag = [];
    for (let j = 0; j < nv; j++) jag.push(0.62 + 0.38 * rnd());
    out.breaches.push({ P, F: s.F, c: s.p, n: s.n, r: R, jag, thick, onset: spec.kind === 'hull' ? 0.55 + 0.3 * rnd() : 0.86 + 0.1 * rnd(), seed: Math.floor(rnd() * 1e6) });
    break;
  }
  return out;
}
const j0 = (rnd) => (rnd() - 0.5) * 0.05;

// ---------- decal evaluation (shared by decal atlas, masks and the vertex channel) ----------
const segDist = (p, a, b) => { const d = sub(b, a), L = dot(d, d); const t = L ? clamp01(dot(sub(p, a), d) / L) : 0; return len(sub(p, add(a, mul(d, t)))); };
const grow = (amount, onset) => (amount < onset ? 0 : Math.min(1, 0.35 + (amount - onset) / 0.3));
/**
 * Channel values at a rest-space surface point (normal n): scorch / soot / hole / ring / crack /
 * scratch, each 0..1 at `amount`; with amount = null the mask encoding (1 - onset) * coverage.
 */
function evalAt(fs, p, n, amount, wearD) {
  const r = { scorch: 0, soot: 0, hole: 0, ring: 0, crack: 0, scratch: 0, wear: 0, dent: 0 };
  const mask = amount === null;
  const on = (onset) => (mask ? 1 - onset : grow(amount, onset));
  for (const s of fs.scorch) {
    const g = on(s.onset); if (!g) continue;
    const d = sub(p, s.c);
    const dl = len(d) / s.r;
    const nz = vnoise(p, 3, s.seed);
    if (dl < 1.3) r.scorch = Math.max(r.scorch, clamp01((1 - dl * (0.8 + 0.4 * nz)) * 1.6) * g * s.rw);
    // soot plume: above the centre, stretched upward
    if (d[1] > 0) { const ds = Math.hypot(d[0], d[1] / 2.4, d[2]) / s.r; if (ds < 1.2) r.soot = Math.max(r.soot, clamp01((1 - ds * (0.7 + 0.6 * nz)) * 1.3) * g * 0.8 * s.rw); }
  }
  for (const c of fs.bullets) {
    const g = on(c.onset); if (!g) continue;
    if (Math.abs(dot(sub(p, c.c), c.n)) > 2.5 || dot(n, c.n) < 0.8) continue;
    for (const h of c.holes) {
      const d = len(sub(p, h.c));
      if (d < h.r) r.hole = Math.max(r.hole, g);
      else if (d < h.r + 1.05) r.ring = Math.max(r.ring, g);
      else if (d < h.r + 2.6) r.soot = Math.max(r.soot, 0.55 * g * (1 - (d - h.r - 1.05) / 1.6));
    }
  }
  for (const s of fs.scratches) {
    const g = on(s.onset); if (!g) continue;
    if (dot(n, s.n) < 0.8 || Math.abs(dot(sub(p, s.a), s.n)) > 1) continue;
    if (segDist(p, s.a, s.b) < 0.5) r.scratch = Math.max(r.scratch, g);
  }
  for (const c of fs.cracks) {
    const g = on(c.onset); if (!g) continue;
    if (dot(n, c.n) < 0.8 || Math.abs(dot(sub(p, c.c), c.n)) > 1.5) continue;
    for (const s of c.segs) if (segDist(p, s.a, s.b) < 0.5) { r.crack = Math.max(r.crack, g); break; }
  }
  if (wearD !== undefined) {
    const wa = mask ? 1 - 0.05 : grow(amount, 0.05);
    const width = 0.45 + 0.75 * (mask ? 1 : amount);
    if (wearD < width && vnoise(p, 2.2, 77) > (mask ? 0.45 : 0.7 - 0.25 * amount)) r.wear = wa * (fs.wearW ?? 1);
  }
  for (const d of fs.dents) {
    const g = on(d.onset); if (!g) continue;
    const x = len(sub(p, d.c)) / d.r;
    if (x < 1) r.dent = Math.max(r.dent, (1 - x * x) ** 2 * (mask ? 1 - d.onset : 1));
  }
  return r;
}

// ---------- per-face charts ----------
/** Planar chart per face on its rest positions (faceBasis), shelf-packed with a 1-texel gutter. */
function packCharts(faces, { texel = 1, maxSize = 1024, blank = true } = {}) {
  if (!(Number.isFinite(texel) && texel > 0)) throw new Error('damage texel must be a finite number > 0 (px per mask texel)');
  const charts = [];
  for (const F of faces) {
    const { t, b } = faceBasis(F.rec.n);
    let s0 = Infinity, s1 = -Infinity, q0 = Infinity, q1 = -Infinity, d = 0;
    for (const v of F.V) { const s = dot(v.r, t), q = dot(v.r, b); s0 = Math.min(s0, s); s1 = Math.max(s1, s); q0 = Math.min(q0, q); q1 = Math.max(q1, q); d += dot(v.r, F.rec.n) / F.V.length; }
    charts.push({ F, t, b, s0, s1, q0, q1, d });
  }
  let tx = texel, W = 16, H = 16;
  for (let tries = 0; tries < 24; tries++) {
    for (const c of charts) { c.w = Math.max(1, Math.ceil((c.s1 - c.s0) / tx - 1e-6)) + 2; c.h = Math.max(1, Math.ceil((c.q1 - c.q0) / tx - 1e-6)) + 2; }
    const area = charts.reduce((s, c) => s + c.w * c.h, 0) + (blank ? 16 : 0);
    W = 16; while (W * W < area * 1.2) W *= 2;
    for (const c of charts) while (W < c.w) W *= 2;
    const order = charts.map((c, i) => i).sort((a, b) => charts[b].h - charts[a].h || charts[b].w - charts[a].w || a - b);
    let x = blank ? 4 : 0, y = 0, rowH = blank ? 4 : 0;
    for (const i of order) { const c = charts[i]; if (x + c.w > W) { x = 0; y += rowH; rowH = 0; } c.x = x; c.y = y; x += c.w; rowH = Math.max(rowH, c.h); }
    H = 16; while (H < y + rowH) H *= 2;
    if (W <= maxSize && H <= maxSize) break;
    tx *= 1.5;
  }
  if (W > maxSize || H > maxSize) throw new Error(`damage mask: the charts need ${W}x${H} px, over max_size ${maxSize}: a larger texel or max_size`);
  for (const c of charts) for (const v of c.F.V) v.cu = [(c.x + 1 + (dot(v.r, c.t) - c.s0) / tx) / W, (c.y + 1 + (dot(v.r, c.b) - c.q0) / tx) / H];
  return { charts, W, H, texel: tx, blankUV: [2 / W, 2 / H] };
}
/** Distance (rest space, in the face plane) to the face's sharp boundary edges, for edge wear. */
function wearEdges(soup) {
  const key = (p) => p.map((v) => Math.round(v * 100)).join(',');
  const E = new Map();
  for (const F of soup.faces) {
    const cnt = new Map();
    for (const t of F.T) for (let k = 0; k < 3; k++) { const a = t[k], b = t[(k + 1) % 3], ek = a < b ? `${a}_${b}` : `${b}_${a}`; cnt.set(ek, (cnt.get(ek) || 0) + 1); }
    F.bnd = [];
    for (const [ek, c] of cnt) if (c === 1) { const [a, b] = ek.split('_').map(Number); F.bnd.push([F.V[a].r, F.V[b].r]); }
    for (const [A, B] of F.bnd) { const k = [key(A), key(B)].sort().join('|'); if (!E.has(k)) E.set(k, []); E.get(k).push(F.rec.n); }
  }
  for (const F of soup.faces) F.sharp = F.bnd.filter(([A, B]) => { const ns = E.get([key(A), key(B)].sort().join('|')) || []; return ns.length < 2 || ns.some((n) => dot(n, F.rec.n) < 0.85); });
}
const PAL = { soot: [23, 21, 26], scorch: [43, 34, 32], scorch2: [70, 54, 49], hole: [8, 8, 10], ring: [111, 112, 118], scratch: [185, 189, 196], wear: [143, 148, 156], crack: [223, 233, 238] };
export function damagePalette(over) {
  const p = { ...PAL };
  if (over && typeof over === 'object') for (const [k, v] of Object.entries(over)) if (p[k] && typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v)) p[k] = [1, 3, 5].map((i) => parseInt(v.slice(i, i + 2), 16));
  return p;
}
/** Decal texel colour (pixel-art damage palette, ordered dither on gradients) or null. */
function decalColor(r, x, y, pal, tint) {
  if (r.hole > 0.5) return pal.hole;
  if (r.crack > 0.5) return pal.crack;
  if (r.ring > 0.5) return pal.ring;
  if (r.scratch > 0.5) return tint ? tint.scratch : pal.scratch;
  const th = (BAYER4[y & 3][x & 3] + 0.5) / 16;
  const s = Math.max(r.scorch, r.soot * 0.9);
  if (s > 0.05) { const lv = s * 3 + (th - 0.5) * 0.45; if (lv > 2.2) return pal.soot; if (lv > 1.35) return pal.scorch; if (lv > 0.7) return pal.scorch2; }
  if (r.wear > 0.5) return tint ? tint.wear : pal.wear;
  return null;
}
/** Wear / scratch colours of a base texture: its mean colour lifted toward bare metal. */
const TINT = new Map();
function tintOf(t, pal) {
  if (TINT.has(t.key)) return TINT.get(t.key);
  let r = 0, g = 0, b = 0, n = 0;
  const d = t.data || [];
  for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 127) { r += d[i]; g += d[i + 1]; b += d[i + 2]; n++; }
  const avg = n ? [r / n, g / n, b / n] : [128, 128, 128];
  const mix = (c, k) => avg.map((v, i) => Math.round(v + (c[i] - v) * k));
  const v = { wear: mix(pal.wear, 0.55).map((x) => Math.min(255, x + 18)), scratch: mix(pal.scratch, 0.6).map((x) => Math.min(255, x + 24)) };
  TINT.set(t.key, v);
  return v;
}
/** Paint charts with fn(chart, i, j, p) -> [r,g,b,a] | null (gutter = clamped copy). */
function paintCharts(pack, fn, bg = [0, 0, 0, 0]) {
  const { W, H, texel } = pack, data = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) data.set(bg, i * 4);
  let used = 0;
  for (const c of pack.charts) {
    const iw = c.w - 2, ih = c.h - 2, vals = new Array(iw * ih);
    let any = false;
    for (let j = 0; j < ih; j++) for (let i = 0; i < iw; i++) {
      const s = c.s0 + (i + 0.5) * texel, q = c.q0 + (j + 0.5) * texel;
      const p = add(add(mul(c.t, s), mul(c.b, q)), mul(c.F.rec.n, c.d));
      const v = fn(c, c.x + 1 + i, c.y + 1 + j, p, s, q);
      vals[j * iw + i] = v; if (v) any = true;
    }
    c.used = any; if (any) used++;
    if (!any) continue;
    for (let j = -1; j <= ih; j++) for (let i = -1; i <= iw; i++) {
      const v = vals[Math.max(0, Math.min(ih - 1, j)) * iw + Math.max(0, Math.min(iw - 1, i))];
      if (v) data.set(v, ((c.y + 1 + j) * W + c.x + 1 + i) * 4);
    }
  }
  return { width: W, height: H, data, used };
}
const distToEdges = (F, p) => { let d = Infinity; for (const [A, B] of F.sharp || []) d = Math.min(d, segDist(p, A, B)); return d; };

// ---------- geometry helpers ----------
/** Oriented box (centre, axes [u,v,w] unit, half sizes) with planar world UVs. */
function obox(m, tex, c, ax, h, uvTex) {
  const corner = (sx, sy, sz) => add(c, add(add(mul(ax[0], sx * h[0]), mul(ax[1], sy * h[1])), mul(ax[2], sz * h[2])));
  const F = [[2, 1], [2, -1], [0, 1], [0, -1], [1, 1], [1, -1]];
  for (const [k, sgn] of F) {
    const n = mul(ax[k], sgn), o = [0, 1, 2].filter((q) => q !== k);
    const P = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => { const s = [0, 0, 0]; s[k] = sgn; s[o[0]] = a; s[o[1]] = b; return corner(s[0], s[1], s[2]); });
    const { t, b } = faceBasis(n), tw = uvTex.width || 1, th = uvTex.height || 1;
    m.face(tex, P, n, P.map((p) => [dot(p, t) / tw, -dot(p, b) / th]), n, 0);
  }
}
const colorTex = (hex, key) => {
  const c = typeof hex === 'string' && /^#[0-9a-f]{6}$/i.test(hex) ? [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) : [40, 42, 48];
  return { key: key || `color:${hex}`, name: `dmg_${String(hex).replace(/[^0-9a-z]/gi, '')}`, width: 1, height: 1, data: Uint8ClampedArray.from([...c, 255]) };
};

/** Faces / overlay triangles inside a box (expanded by pad) -> predicate. */
const inBox = (min, max, pad) => (p) => p[0] >= min[0] - pad && p[0] <= max[0] + pad && p[1] >= min[1] - pad && p[1] <= max[1] + pad && p[2] >= min[2] - pad && p[2] <= max[2] + pad;
function overlayTris(soup, pred) {
  const out = [];
  for (const O of soup.overlays) O.T.forEach((t, i) => { if (t.every((k) => pred(O.V[k].r))) out.push([O, i]); });
  return out;
}

// ---------- one damage state ----------
/**
 * Build a damage state from a built model. built: {mesh (px, final), tex (resolver)}.
 * -> {mesh, sockets:[{name, fx, pos, dir, intensity}], stats, fs (feature set), decal}
 */
export function damageState(built, def, spec, st, opts = {}) {
  const soup = explode(built.mesh);
  const info = analyseParts(soup, def, spec);
  const fs = featureSet(soup, info, spec, st, def);
  const a = st.amount;
  const S = fs.scale;
  const budget = { left: Math.max(4000, Math.min(60000, built.mesh.triangles * 10)) };
  const stats = { dents: 0, panels_lost: 0, panels_offset: 0, bent: 0, glass_holes: 0, breaches: 0, bullets: 0, scorch: 0, scratches: 0, cracks: 0, wires: 0, emissive_off: 0 };
  const sockets = [];
  const sock = (fx, pos, dir, intensity = 1) => sockets.push({ fx, pos: pos.map((v) => +v.toFixed(3)), dir: norm(dir).map((v) => +v.toFixed(4)), intensity: +Math.min(1, intensity).toFixed(3) });
  const tex = (ref) => (built.tex ? built.tex(ref) : colorTex(ref));
  const innerT = tex(spec.inner), frameT = tex(spec.frame);
  const add2 = new Mesh();
  const rnd = mulberry32(st.seed * 7919 + 13);

  // --- riders: smaller parts lying inside an active panel / leaf (door window, stripe, bolts)
  // follow its transform or removal, and get no part features of their own.
  const pvol = (P) => P.size.reduce((m, v) => m * Math.max(0.5, v), 1);
  const activeP = fs.panels.filter((pn) => a >= pn.onset).sort((x, y) => pvol(y.P) - pvol(x.P));
  const riders = new Map(activeP.map((pn) => [pn, []]));
  for (const Q of info.list) {
    if (Q === info.biggest) continue;
    const host = activeP.find((pn) => pn.P !== Q && pvol(pn.P) > pvol(Q) && [0, 1, 2].every((k) => Q.min[k] >= pn.P.min[k] - 1.5 && Q.max[k] <= pn.P.max[k] + 1.5));
    if (host) { riders.get(host).push(Q); Q.ridden = host.P; }
  }

  // --- panels: lost (removed, backing + frame + wires) or offset (hinged out); door leaf jammed / blown
  for (const pn of fs.panels) {
    if (a < pn.onset || pn.P.ridden) continue;
    const P0 = pn.P, n = P0.mainN;
    const P = { ...P0, faces: [...P0.faces, ...riders.get(pn).flatMap((Q) => Q.faces)] };
    const { t, b } = faceBasis(n);
    const ht = Math.abs(dot(P.size, t.map(Math.abs))) / 2, hb = Math.abs(dot(P.size, b.map(Math.abs))) / 2, hn = Math.abs(dot(P.size, n.map(Math.abs))) / 2;
    const ovs = overlayTris(soup, inBox(P.min, P.max, 0.6));
    if (pn.leaf) {
      // door leaf: jammed (slid part-open + tilted) at damaged, blown out (falls outward about its bottom) at wrecked
      const blown = a >= 0.85;
      const bottom = [P.center[0], P.min[1], P.center[2]];
      const side = Math.abs(t[1]) < 0.5 ? t : b;
      const M = (p) => (blown ? add(rotAxis(sub(p, bottom), norm(cross([0, 1, 0], n)), (72 * Math.PI) / 180), add(bottom, mul(n, hn * 2 + 1))) : add(rotAxis(sub(p, bottom), n, (5 * Math.PI) / 180), add(bottom, mul(side, Math.max(ht, hb) * 0.45))));
      const Mn = (v) => (blown ? rotAxis(v, norm(cross([0, 1, 0], n)), (72 * Math.PI) / 180) : rotAxis(v, n, (5 * Math.PI) / 180));
      for (const F of P.faces) { for (const v of F.V) { v.p = M(v.r); v.r = v.p.slice(); v.n = Mn(v.n); } F.rec.n = Mn(F.rec.n); }
      for (const [O, i] of ovs) for (const k of O.T[i]) { const v = O.V[k]; if (!v.moved) { v.p = M(v.r); v.r = v.p.slice(); v.n = Mn(v.n); v.moved = true; } }
      stats.panels_offset++;
      sock('spark', add(P.center, mul(side, -Math.max(ht, hb))), n, a);
      if (blown) sock('smoke', [P.center[0], P.max[1], P.center[2]], [0, 1, 0], a);
      continue;
    }
    if (pn.lost) {
      for (const F of P.faces) F.T = [];
      for (const [O, i] of ovs) O.T[i] = null;
      stats.panels_lost++;
      // inner layer: dark backing at the panel's back plane + two frame ribs + wires across the opening
      const back = sub(P.center, mul(n, hn - 0.15));
      obox(add2, innerT, back, [t, b, n], [Math.max(0.5, ht - 0.4), Math.max(0.5, hb - 0.4), 0.15], innerT);
      const ribW = Math.max(0.6, Math.min(ht, hb) * 0.12);
      obox(add2, frameT, add(back, mul(n, 0.15 + Math.min(hn, 1))), [t, b, n], [Math.max(0.5, ht - 0.6), ribW, Math.min(hn, 1)], frameT);
      obox(add2, frameT, add(back, mul(n, 0.15 + Math.min(hn, 1))), [t, b, n], [ribW, Math.max(0.5, hb - 0.6), Math.min(hn, 1)], frameT);
      const wr = mulberry32(pn.seed);
      const WCOL = ['#b8402e', '#d8b23a', '#2a2a2e', '#3d6fb0'];
      for (let k = 0; k < pn.wires; k++) {
        const side = wr() < 0.5 ? t : b, other = side === t ? b : t, hs = side === t ? ht : hb, ho = side === t ? hb : ht;
        const off = (wr() - 0.5) * 1.6 * ho;
        const from = add(add(back, mul(n, 0.4 + Math.min(hn, 1) * 2)), add(mul(side, -hs * 0.9), mul(other, off)));
        const end = 0.3 + 0.6 * wr();
        const to = add(add(back, mul(n, 0.4 + Math.min(hn, 1) * 2 + 1.2 * wr())), add(mul(side, hs * (end * 2 - 1)), mul(other, off + (wr() - 0.5) * ho)));
        try { add2.add(sweep({ from, to, sag: Math.min(3, hs * 0.3), r: Math.max(0.35, 0.3 * S), sides: 5, segments: 6, texture: WCOL[k % WCOL.length], caps: true }, { tex })); } catch { continue; }
        stats.wires++;
        sock('spark', to, n, a);
        if (spec.sparks) obox(add2, sparkTex(), to, [t, b, n], [0.35, 0.35, 0.35], sparkTex());
      }
      if (a > 0.7 && wr() < 0.6) sock('smoke', add(back, mul(n, 2)), [0, 1, 0], a * 0.7);
      continue;
    }
    // offset: hinge about one footprint edge, swung outward
    const e = pn.hinge, axes = [t, b], ax = axes[e % 2], sgn = e < 2 ? 1 : -1, hl = e % 2 ? hb : ht;
    const pivot = add(sub(P.center, mul(n, hn)), mul(ax, sgn * hl));
    const k = norm(cross(ax, n)), ang = (-sgn * pn.angle * Math.min(1, 0.4 + (a - pn.onset) / 0.4) * Math.PI) / 180;
    const M = (p) => add(pivot, rotAxis(sub(p, pivot), k, ang));
    for (const F of P.faces) { for (const v of F.V) { v.p = M(v.r); v.r = v.p.slice(); v.n = rotAxis(v.n, k, ang); } F.rec.n = rotAxis(F.rec.n, k, ang); }
    for (const [O, i] of ovs) for (const kk of O.T[i]) { const v = O.V[kk]; if (!v.moved) { v.p = M(v.r); v.r = v.p.slice(); v.n = rotAxis(v.n, k, ang); v.moved = true; } }
    stats.panels_offset++;
  }
  for (const O of soup.overlays) O.T = O.T.filter(Boolean);

  // --- bent parts: rotation growing along the long axis (subdivided along it first)
  for (const bd of fs.bends) {
    if (a < bd.onset || bd.P.ridden) continue;
    const P = bd.P, ax = P.size.indexOf(Math.max(...P.size));
    const lo = P.min[ax], hi = P.max[ax], L = hi - lo;
    const mc = fs.bounds.min.map((v, k) => (v + fs.bounds.max[k]) / 2);
    const baseLow = ax === 1 ? true : Math.abs(lo - mc[ax]) <= Math.abs(hi - mc[ax]);
    const dirA = [0, 0, 0]; dirA[ax] = baseLow ? 1 : -1;
    const perp = norm(add(mul(ax === 0 ? [0, 1, 0] : [1, 0, 0], Math.cos(bd.dir)), mul(ax === 2 ? [0, 1, 0] : [0, 0, 1], Math.sin(bd.dir))));
    const k = norm(cross(dirA, perp));
    const pivot = P.center.slice(); pivot[ax] = baseLow ? lo : hi;
    const theta = (bd.angle * Math.min(1, 0.4 + (a - bd.onset) / 0.4) * Math.PI) / 180;
    const need = (A, B) => { if (!(A[ax] >= lo - 1e-6 && A[ax] <= hi + 1e-6 && B[ax] >= lo - 1e-6 && B[ax] <= hi + 1e-6)) return false; return Math.abs(A[ax] - B[ax]) > L / 6 + 1e-6; };
    for (const F of P.faces) subdivide(F, need, 4, budget);
    const deform = (v) => { const tt = clamp01(Math.abs(v.r[ax] - pivot[ax]) / L), ang = theta * tt * tt; v.p = add(pivot, rotAxis(sub(v.r, pivot), k, ang)); v.n = rotAxis(v.n, k, ang); };
    for (const F of P.faces) { for (const v of F.V) deform(v); renormal(F); for (const v of F.V) v.r = v.p.slice(); }
    for (const [O, i] of overlayTris(soup, inBox(P.min, P.max, 0.6))) for (const kk of O.T[i]) { const v = O.V[kk]; if (!v.bent) { deform(v); v.r = v.p.slice(); v.bent = true; } }
    stats.bent++;
    sock('steam', add(pivot, mul(dirA, L)), dirA, a * 0.6);
  }

  // --- screens / lights: emissive killed (screens darkened), flicker socket on lamps
  for (const sc of [...fs.screens, ...fs.lights.map((l) => ({ ...l, onset: l.off, light: true }))]) {
    const P = sc.P;
    if (a >= sc.onset) {
      for (const F of P.faces) if (F.tex.emissive) F.tex = deadTex(F.tex, !sc.light);
      stats.emissive_off++;
      sock('spark', add(P.center, mul(P.mainN, 0.5)), P.mainN, a);
    }
  }
  for (const l of fs.lights) if (a >= l.onset && a < l.off) sock('flicker', l.P.center, l.P.mainN, 1);

  // --- glass / screen shard holes: subdivide near the impact, cut a jagged hole
  for (const gh of fs.glassHoles) {
    if (a < gh.onset || gh.P.ridden) continue;
    const P = gh.P, { t, b } = faceBasis(gh.n), jr = mulberry32(gh.seed);
    const jag = Array.from({ length: 14 }, () => 0.55 + 0.45 * jr());
    const R = lerp(gh.r, Math.max(gh.r, gh.rmax), clamp01((a - gh.onset) / Math.max(0.05, 1 - gh.onset)));
    const radius = (p) => { const d = sub(p, gh.c), x = dot(d, t), y = dot(d, b), ang = (Math.atan2(y, x) / (Math.PI * 2) + 1) % 1, f = ang * 14, i0 = Math.floor(f) % 14; return { d: Math.hypot(x, y), r: R * lerp(jag[i0], jag[(i0 + 1) % 14], f - Math.floor(f)) }; };
    const target = Math.max(1, R / 7);
    const need = (A, B) => { const L = len(sub(A, B)); if (L <= target) return false; return segDist(gh.c, A, B) < R * 1.1 + 1 || Math.abs(radius(A).d - R) < R * 0.4 + L; };
    for (const F of P.faces) {
      subdivide(F, need, 6, budget);
      F.T = F.T.filter((tt) => { const c = mul(add(add(F.V[tt[0]].r, F.V[tt[1]].r), F.V[tt[2]].r), 1 / 3), q = radius(c); return q.d > q.r; });
    }
    for (const O of soup.overlays) O.T = O.T.filter((tt) => { const c = mul(add(add(O.V[tt[0]].r, O.V[tt[1]].r), O.V[tt[2]].r), 1 / 3), q = radius(c); return !(q.d < q.r && inBox(P.min, P.max, 0.6)(c)); });
    stats.glass_holes++;
    gh.R = R;
    if (P.isScreen || P.isLight) sock('spark', gh.c, gh.n, a);
  }

  // --- hull breach: BSP subtract a jagged prism from the host part, curled rim petals, exposed ribs
  for (const br of fs.breaches) {
    if (a < br.onset) continue;
    const P = br.P, n = br.n, { t, b } = faceBasis(n);
    const R = br.r * Math.min(1, 0.55 + (a - br.onset) / 0.3);
    const through = br.thick <= 10;
    const depth = through ? br.thick + 2 : Math.min(10 * S, br.thick * 0.5);
    const outline = br.jag.map((j, i) => { const ang = (i / br.jag.length) * Math.PI * 2; return add(br.c, add(mul(t, Math.cos(ang) * R * j), mul(b, Math.sin(ang) * R * j))); });
    const host = { faces: P.faces };
    let hostMesh = implode({ faces: host.faces, overlays: [] });
    let ms = manifoldStats(hostMesh), closedHost = false;
    if ((ms.open || ms.nonManifold) && spec.close !== false) {
      // open host (a plate made of separate faces, a part with a gap): close it with the #19 cleanup
      // hole fill (no voxel fallback: the host keeps its look) so the breach is a real boolean cut
      const c = closeOpenMesh(hostMesh, { voxel: false });
      if (c) { hostMesh = c.mesh; ms = manifoldStats(hostMesh); closedHost = true; stats.closed_hosts = (stats.closed_hosts || 0) + 1; }
    }
    const cut = new Mesh();
    const top = outline.map((p) => add(p, mul(n, 1))), bot = outline.map((p) => sub(p, mul(n, depth)));
    const uvp = (p) => [dot(p, t) / (innerT.width || 1), -dot(p, b) / (innerT.height || 1)];
    cut.face(innerT, top, n, top.map(uvp), n, 0);
    cut.face(innerT, [...bot].reverse(), mul(n, -1), [...bot].reverse().map(uvp), mul(n, -1), 0);
    for (let i = 0; i < outline.length; i++) {
      const j = (i + 1) % outline.length, Q = [top[i], top[j], bot[j], bot[i]];
      const fn = norm(cross(sub(top[j], top[i]), n));
      cut.face(innerT, Q, fn, Q.map((p) => [dot(p, fn[1] > 0.9 ? t : norm(cross([0, 1, 0], fn))) / (innerT.width || 1), -p[1] / (innerT.height || 1)]), fn, 0);
    }
    const inPoly = (c) => { const d = sub(c, br.c), x = dot(d, t), y = dot(d, b), ang = (Math.atan2(y, x) / (Math.PI * 2) + 1) % 1, f = ang * br.jag.length, i0 = Math.floor(f) % br.jag.length; return Math.hypot(x, y) < R * lerp(br.jag[i0], br.jag[(i0 + 1) % br.jag.length], f - Math.floor(f)) && dot(d, n) > -depth - 0.5; };
    if (ms.open === 0 && ms.nonManifold === 0) {
      const res = booleanMesh('subtract', hostMesh, cut);
      // the hole-fill caps only made the open host cuttable: what derives from them is not part of the look
      const rs = explode(res);
      if (closedHost) rs.faces = rs.faces.filter((F) => !F.rec.fill);
      for (const F of rs.faces) F.rec.pi = P.pi;
      // replace the host faces in place
      const idx = soup.faces.indexOf(P.faces[0]);
      const hostSet = new Set(P.faces);
      soup.faces = soup.faces.filter((F) => !hostSet.has(F));
      soup.faces.splice(Math.max(0, idx), 0, ...rs.faces);
      P.faces = rs.faces;
      br.csg = true;
    } else {
      // open host (plate, plane): subdivide + drop the triangles inside the outline
      const need = (A, B) => len(sub(A, B)) > Math.max(1, R / 6) && segDist(br.c, A, B) < R * 1.2;
      for (const F of P.faces) { subdivide(F, need, 6, budget); F.T = F.T.filter((tt) => !inPoly(mul(add(add(F.V[tt[0]].r, F.V[tt[1]].r), F.V[tt[2]].r), 1 / 3))); }
      br.csg = false;
    }
    for (const O of soup.overlays) O.T = O.T.filter((tt) => !inPoly(mul(add(add(O.V[tt[0]].r, O.V[tt[1]].r), O.V[tt[2]].r), 1 / 3)));
    // curled rim petals (double-sided), host colour outside, inner colour inside
    const hostTex = br.F.tex;
    for (let i = 0; i < outline.length; i++) {
      if (rnd() < 0.3) continue;
      const A = outline[i], B = outline[(i + 1) % outline.length], mid = mul(add(A, B), 0.5);
      const radial = norm(sub(mid, br.c)), tip = add(add(mid, mul(radial, (0.6 + 1.2 * rnd()) * S * 0.8)), mul(n, (0.8 + 1.6 * rnd()) * S * 0.7));
      const Q = [A, B, tip], fn = norm(cross(sub(B, A), sub(tip, A)));
      const uvh = Q.map((p) => [dot(p, t) / (hostTex.width || 1), -dot(p, b) / (hostTex.height || 1)]);
      add2.face(hostTex, Q, fn, uvh, fn, 0);
      add2.face(innerT, [A, tip, B], mul(fn, -1), [A, tip, B].map(uvp), mul(fn, -1), 0);
    }
    // exposed frame: ribs crossing the opening, set back inside
    const back = sub(br.c, mul(n, through ? br.thick + 1.5 : depth * 0.6));
    const ribW = Math.max(0.8, R * 0.09);
    obox(add2, frameT, back, [t, b, n], [R * 0.9, ribW, ribW], frameT);
    obox(add2, frameT, add(back, mul(t, R * 0.3)), [t, b, n], [ribW, R * 0.9, ribW], frameT);
    if (through) obox(add2, innerT, sub(back, mul(n, ribW + 0.6)), [t, b, n], [R * 0.95, R * 0.95, 0.25], innerT);
    for (let k = 0; k < 2; k++) {
      const from = add(add(back, mul(n, ribW)), mul(t, -R * 0.55)), to = add(add(back, mul(n, ribW + 0.6 + depth * 0.25 * rnd())), add(mul(t, R * (0.05 + 0.4 * rnd())), mul(b, (rnd() - 0.5) * R * 0.6)));
      try { add2.add(sweep({ from, to, sag: R * 0.12, r: Math.max(0.35, 0.28 * S), sides: 5, segments: 6, texture: k ? '#d8b23a' : '#b8402e', caps: true }, { tex })); stats.wires++; sock('spark', to, n, a); } catch { /* degenerate cable */ }
    }
    sock(spec.kind === 'engine' || a > 0.9 ? 'fire' : 'smoke', add(br.c, mul(n, 1)), n, a);
    if (spec.kind === 'hull') sock('leak', add(br.c, mul(n, 0.5)), n, a * 0.8);
    stats.breaches++;
  }

  // --- dents: subdivide near the impacts, displace with falloff x (1 - rigidity)
  const dents = fs.dents.filter((d) => a >= d.onset);
  if (dents.length) {
    const rigid = (F) => info.parts.get(F.rec.pi ?? -1)?.rigid ?? 0.25;
    const need = (A, B) => {
      const L = len(sub(A, B));
      if (L <= 1.25) return false;
      for (const d of dents) if (L > d.r / 2.5 && segDist(d.c, A, B) < d.r + 1e-6) return true;
      return false;
    };
    const disp = (p, rg) => {
      let o = [0, 0, 0];
      for (const d of dents) {
        const x = len(sub(p, d.c)) / d.r;
        if (x >= 1) continue;
        const g = grow(a, d.onset) * d.rw, wv = (1 - x * x) ** 2;
        const crumple = a > 0.7 ? (vnoise(p, 1.8, 91) - 0.5) * 0.5 * (a - 0.7) / 0.3 : 0;
        o = add(o, mul(d.dir, d.r * d.depth * g * (wv + crumple * wv)));
      }
      return mul(o, 1 - rg);
    };
    for (const F of soup.faces) {
      const P = info.parts.get(F.rec.pi ?? -1);
      if (!P || P.isGlass || rigid(F) >= 1 || !F.T.length) continue;
      if (!F.V.some((v) => dents.some((d) => len(sub(v.r, d.c)) < d.r + 30))) continue;
      subdivide(F, need, 6, budget);
      let moved = false;
      for (const v of F.V) { const o = disp(v.r, rigid(F)); if (o[0] || o[1] || o[2]) { v.p = add(v.r, o); moved = true; } }
      if (moved) renormal(F);
    }
    for (const O of soup.overlays) {
      subdivide(O, need, 6, budget);
      for (const v of O.V) { const o = disp(v.r, 0.25); v.p = add(v.r, o); }
    }
    stats.dents = dents.length;
  }
  // added geometry: tag it so it is never mistaken for a model part
  add2.tagFaces({ pi: -1, dmg: true });
  const extra = explode(add2);
  soup.faces.push(...extra.faces);

  // --- surface decals: scorch, soot, scratches, wear, bullet holes, cracks
  wearEdges(soup);
  const active = {
    scorch: fs.scorch.filter((s) => a >= s.onset), bullets: fs.bullets.filter((s) => a >= s.onset), scratches: fs.scratches.filter((s) => a >= s.onset), cracks: fs.cracks.filter((s) => a >= s.onset), dents: [], wearW: a > 0.05 ? 1 : 0,
  };
  stats.scorch = active.scorch.length; stats.bullets = active.bullets.reduce((s, c) => s + c.holes.length, 0); stats.scratches = active.scratches.length; stats.cracks = active.cracks.length;
  const pal = damagePalette(spec.palette);
  let decal = null;
  const decalFaces = soup.faces.filter((F) => F.T.length && F.rec.pi !== -1 && touches(F, active, a));
  if (decalFaces.length && opts.decals !== false) {
    const pack = packCharts(decalFaces, { texel: opts.texel ?? 1, maxSize: opts.maxSize ?? 1024, blank: false });
    const img = paintCharts(pack, (c, x, y, p) => { const r = evalAt(active, p, c.F.rec.n, a, distToEdges(c.F, p)); const col = decalColor(r, x, y, pal, tintOf(c.F.tex, pal)); return col ? [...col, 255] : null; });
    const dtex = { key: `damage:${def.name}:${st.name}`, name: `damage_${st.name}`, width: img.width, height: img.height, data: img.data };
    // overlay shell over the used charts: deformed positions lifted along the normal
    const ov = { tex: dtex, V: [], T: [] };
    for (const c of pack.charts) {
      if (!c.used) continue;
      const F = c.F, base = ov.V.length;
      for (const v of F.V) ov.V.push({ p: add(v.p, mul(v.n, 0.2)), n: v.n.slice(), uv: v.cu.slice(), uv0: v.uv.slice(), a: 1, node: F.rec.node, r: v.r });
      for (const tt of F.T) ov.T.push(tt.map((k) => base + k));
    }
    soup.overlays.push(ov);
    decal = { size: [img.width, img.height], charts: img.used, texel_px: +pack.texel.toFixed(3), tex: dtex, pack };
  }

  // --- fx sockets from surface damage
  const scorchBig = [...active.scorch].sort((x, y) => y.r - x.r);
  scorchBig.slice(0, a > 0.8 ? 2 : 1).forEach((s, i) => { if (a > 0.45) sock(i === 0 && a > 0.85 ? 'fire' : 'smoke', s.c, [0, 1, 0], a); });
  if (spec.kind === 'barrel' || spec.kind === 'engine') {
    const low = [...active.bullets].sort((x, y) => x.c[1] - y.c[1])[0];
    if (low && a > 0.5) sock('leak', low.c, low.n, a);
  }
  if (spec.kind === 'engine' && a > 0.5) { const P = info.biggest; if (P) sock('steam', [P.center[0], P.max[1], P.center[2]], [0, 1, 0], a); }
  // names: fx_<kind>_<n>
  const seen = {};
  for (const s of sockets) { seen[s.fx] = (seen[s.fx] || 0) + 1; s.name = `fx_${s.fx}_${seen[s.fx]}`; }
  const mesh = implode(soup);
  return { mesh, sockets, stats, fs, decal, soup };
}
const touches = (F, act, a) => a > 0.05 || act.scorch.length > 0 || act.bullets.length > 0;
let SPARK = null;
const sparkTex = () => SPARK || (SPARK = { key: 'damage:spark', name: 'damage_spark', width: 1, height: 1, data: Uint8ClampedArray.from([255, 214, 120, 255]), emissive: Uint8ClampedArray.from([255, 214, 120, 255]), emissiveKey: 'damage:spark#e' });
const DEAD = new Map();
function deadTex(t, darken) {
  const k = `${t.key}|dead${darken ? 'd' : ''}`;
  if (DEAD.has(k)) return DEAD.get(k);
  const data = Uint8ClampedArray.from(t.data);
  const f = darken ? 0.3 : 0.55;
  for (let i = 0; i < data.length; i += 4) { data[i] *= f; data[i + 1] *= f; data[i + 2] = Math.min(255, data[i + 2] * f + 6); }
  const v = { ...t, key: k, name: `${t.name || t.key}_dead`, data, imageKey: undefined, emissive: undefined, emissiveKey: undefined };
  DEAD.set(k, v);
  return v;
}

// ---------- intact blend mesh + masks + vertex channel ----------
/**
 * Intact model prepared for a continuous blend: subdivided where the dents of the full feature
 * set land, per-face chart UVs (g.uvd -> the first free TEXCOORD: 1, or after the AO / lightmap / extra UV sets), a "damage" morph target (dent displacement at
 * amount 1), optional per-vertex damage RGBA (g.dmg) and the RGBA threshold mask atlas.
 * Mask channels: R scorch+soot, G dent, B holes (bullets, cracks, glass holes, breach), A wear +
 * scratches; value = (1 - onset) x coverage, i.e. a texel is damaged once blend >= 1 - value/255.
 */
export function damageMasks(built, def, spec, opts = {}) {
  const soup = explode(built.mesh);
  const info = analyseParts(soup, def, spec);
  const st = { name: 'blend', amount: 1, seed: spec.seed, regions: null, features: {} };
  const fs = featureSet(soup, info, spec, st, def);
  const budget = { left: Math.max(4000, Math.min(60000, built.mesh.triangles * 10)) };
  const dents = fs.dents;
  const rigid = (F) => info.parts.get(F.rec.pi ?? -1)?.rigid ?? 0.25;
  const need = (A, B) => { const L = len(sub(A, B)); if (L <= 1.25) return false; for (const d of dents) if (L > d.r / 2.5 && segDist(d.c, A, B) < d.r + 1e-6) return true; return false; };
  for (const F of soup.faces) {
    const P = info.parts.get(F.rec.pi ?? -1);
    if (opts.morph !== false && P && !P.isGlass && rigid(F) < 1 && F.V.some((v) => dents.some((d) => len(sub(v.r, d.c)) < d.r + 30))) subdivide(F, need, 6, budget);
    let moved = false;
    for (const v of F.V) {
      let o = [0, 0, 0];
      if (P && !P.isGlass && opts.morph !== false) for (const d of dents) { const x = len(sub(v.r, d.c)) / d.r; if (x < 1) o = add(o, mul(d.dir, d.r * d.depth * d.rw * (1 - x * x) ** 2)); }
      o = mul(o, 1 - rigid(F));
      if (o[0] || o[1] || o[2]) moved = true;
      v.p = add(v.r, o);
    }
    if (moved) renormal(F);
  }
  // model overlay shells (grime, moss, ...) follow the dent morph: subdivided where the dents land
  // like the base faces, displaced by the same field with the rigidity of the nearest base vertex
  const shellMorph = opts.morph !== false && opts.overlayMorph !== false && dents.length && soup.overlays.some((o) => o.T.length);
  if (shellMorph) {
    const cell = 8, near = new Map(), ck = (p) => p.map((x) => Math.floor(x / cell)).join(',');
    for (const F of soup.faces) { const rg = rigid(F); for (const v of F.V) { const k = ck(v.r); if (!near.has(k)) near.set(k, []); near.get(k).push([v.r, rg]); } }
    const rigAt = (p) => {
      const c = p.map((x) => Math.floor(x / cell));
      let best = Infinity, rg = 0.25;
      for (let x = -1; x <= 1; x++) for (let y = -1; y <= 1; y++) for (let z = -1; z <= 1; z++) for (const [q, r] of near.get(`${c[0] + x},${c[1] + y},${c[2] + z}`) || []) { const d = len(sub(p, q)); if (d < best) { best = d; rg = r; } }
      return rg;
    };
    const ob = { left: Math.max(2000, Math.min(30000, budget.left + 2000)) };
    for (const O of soup.overlays) {
      if (!O.T.length) continue;
      if (O.V.some((v) => dents.some((d) => len(sub(v.r, d.c)) < d.r + 30))) subdivide(O, need, 6, ob);
      let moved = false;
      for (const v of O.V) {
        let o = [0, 0, 0];
        for (const d of dents) { const x = len(sub(v.r, d.c)) / d.r; if (x < 1) o = add(o, mul(d.dir, d.r * d.depth * d.rw * (1 - x * x) ** 2)); }
        o = mul(o, 1 - rigAt(v.r));
        if (o[0] || o[1] || o[2]) moved = true;
        v.p = add(v.r, o);
      }
      if (moved) renormal(O);
    }
  } else for (const O of soup.overlays) for (const v of O.V) v.p = v.r.slice();
  wearEdges(soup);
  const holes = { ...fs, dents: fs.dents, wearW: 1 };
  const pack = packCharts(soup.faces.filter((F) => F.T.length), { texel: opts.texel ?? 1, maxSize: opts.maxSize ?? 1024 });
  const glassHole = (p, n) => { let v = 0; for (const g of fs.glassHoles) if (dot(n, g.n) > 0.8 && Math.abs(dot(sub(p, g.c), g.n)) < 1.5) { const d = len(sub(p, g.c)), R = Math.max(g.r, g.rmax); if (d < R) v = Math.max(v, (1 - g.onset) * (1 - d / R) * 0.5 + (d < g.r ? (1 - g.onset) * 0.5 : 0)); } for (const br of fs.breaches) if (dot(n, br.n) > 0.8) { const d = len(sub(p, br.c)); if (d < br.r) v = Math.max(v, 1 - br.onset); } return v; };
  const enc = (p, n, F) => {
    const r = evalAt(holes, p, n, null, distToEdges(F, p));
    return [Math.round(255 * clamp01(Math.max(r.scorch, r.soot))), Math.round(255 * clamp01(r.dent)), Math.round(255 * clamp01(Math.max(r.hole, r.crack, glassHole(p, n)))), Math.round(255 * clamp01(Math.max(r.wear, r.scratch)))];
  };
  const img = paintCharts(pack, (c, x, y, p) => { const v = enc(p, c.F.rec.n, c.F); return v[0] || v[1] || v[2] || v[3] ? v : null; });
  if (opts.vertex) for (const F of soup.faces) for (const v of F.V) v.dmg = enc(v.r, F.rec.n, F).map((x) => x / 255);
  // faces whose chart stayed empty sample the blank texel block at the atlas origin
  for (const c of pack.charts) if (!c.used) for (const v of c.F.V) v.cu = pack.blankUV.slice();
  // model overlay shells (grime, moss, ...): their own mesh (overlay primitives cannot share the
  // base primitives' attributes), with the same "damage" morph so they stay on the dented surface
  const mesh = implode({ faces: soup.faces, overlays: [] }, { uvd: true, dmg: !!opts.vertex, morph: opts.morph === false ? null : { name: 'damage' } });
  const overlays = soup.overlays.some((o) => o.T.length) ? implode({ faces: [], overlays: soup.overlays }, shellMorph ? { morph: { name: 'damage' } } : {}) : null;
  const ch = { r: 0, g: 0, b: 0, a: 0 }, px = img.width * img.height;
  for (let i = 0; i < px; i++) { if (img.data[i * 4]) ch.r++; if (img.data[i * 4 + 1]) ch.g++; if (img.data[i * 4 + 2]) ch.b++; if (img.data[i * 4 + 3]) ch.a++; }
  return { mesh, overlays, mask: { key: `damage_mask:${def.name}`, name: 'damage_mask', width: img.width, height: img.height, data: img.data }, coverage: Object.fromEntries(Object.entries(ch).map(([k, v]) => [k, +(v / px).toFixed(4)])), texel_px: +pack.texel.toFixed(3), charts: pack.charts.length, fs };
}

/**
 * Bake a state's decal shell into colour (Roblox profile: one UV set, no overlay primitives):
 * every decal face gets a unique texture = its base texture sampled per chart texel with the
 * decal composited over it; the shell is dropped.
 */
export function bakeDecals(state) {
  if (!state.decal) return implode({ faces: state.soup.faces, overlays: state.soup.overlays.filter((o) => !o.tex.key.startsWith('damage:')) });
  const { pack, tex: dtex } = state.decal;
  const W = pack.W, H = pack.H, out = new Uint8ClampedArray(W * H * 4);
  const baked = { key: `${dtex.key}#baked`, name: `${dtex.name}_baked`, width: W, height: H, data: out };
  for (const c of pack.charts) {
    if (!c.used) continue;
    const F = c.F, t = F.tex;
    // (s, q) of the face triangles for barycentric UV lookup
    const T2 = F.T.map((tt) => tt.map((k) => ({ s: dot(F.V[k].r, c.t), q: dot(F.V[k].r, c.b), uv: F.V[k].uv })));
    for (let j = -1; j <= c.h - 2; j++) for (let i = -1; i <= c.w - 2; i++) {
      const s = c.s0 + (Math.max(0, Math.min(c.w - 3, i)) + 0.5) * pack.texel, q = c.q0 + (Math.max(0, Math.min(c.h - 3, j)) + 0.5) * pack.texel;
      let uv = null, best = Infinity;
      for (const [A, B, C] of T2) {
        const ar = (B.s - A.s) * (C.q - A.q) - (C.s - A.s) * (B.q - A.q);
        if (Math.abs(ar) < 1e-12) continue;
        const l1 = ((B.s - s) * (C.q - q) - (C.s - s) * (B.q - q)) / ar, l2 = ((C.s - s) * (A.q - q) - (A.s - s) * (C.q - q)) / ar, l3 = 1 - l1 - l2;
        const m = Math.min(l1, l2, l3);
        if (-m < best) { best = -m; uv = [A.uv[0] * l1 + B.uv[0] * l2 + C.uv[0] * l3, A.uv[1] * l1 + B.uv[1] * l2 + C.uv[1] * l3]; }
        if (m >= 0) break;
      }
      const x = ((Math.floor((uv ? uv[0] : 0) * t.width) % t.width) + t.width) % t.width, y = ((Math.floor((uv ? uv[1] : 0) * t.height) % t.height) + t.height) % t.height;
      const o = ((c.y + 1 + j) * W + c.x + 1 + i) * 4, si = (y * t.width + x) * 4;
      const dd = dtex.data;
      if (dd[o + 3] >= 128) out.set([dd[o], dd[o + 1], dd[o + 2], 255], o);
      else out.set([t.data[si], t.data[si + 1], t.data[si + 2], t.data[si + 3]], o);
    }
    F.tex = t.material ? { ...baked, key: `${baked.key}|${t.material.opacity}${t.material.glass ? 'g' : ''}`, material: t.material } : baked;
    for (const v of F.V) v.uv = v.cu.slice();
    F.rec.mode = 0;
  }
  return implode({ faces: state.soup.faces, overlays: state.soup.overlays.filter((o) => o.tex !== dtex) });
}
