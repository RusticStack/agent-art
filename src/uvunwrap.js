// Model-level UV unwrap (art_model unwrap): ONE atlas for the whole model so its parts read as one
// object. Pure geometry, no engine: facets from the built triangles, hinge-unfolded charts
// (isometric: every facet keeps its true size, 1 atlas texel = `texel` model px everywhere), seams
// pushed to the least visible edges, upright shelf packing into a power-of-two atlas, and a texel
// map (which facet / point every atlas texel shows). All positions are in PATTERN space = built px
// minus the origin shift minus uv_origin, the space the world UVs (worldUV) tile in, so an
// axis-aligned face's chart coordinates equal its world UV times the texture size.
import { faceBasis } from './ctm.js';

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const norm = (a) => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const scl = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const addv = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];

export const UNWRAP_LIMITS = { facets: 20000, islands: 4096, maxSize: 2048, texels: 2048 * 2048, rays: 12e6 };
const NAME_RE = /^[A-Za-z0-9_\-.]{1,64}$/;
const DOS = ['all', 'layout', 'bake', 'cohesion', 'guide', 'view', 'project', 'check', 'clear'];
const METHODS = ['smart', 'box', 'faces', 'auto'];
/** Keys only an action uses (never stored in the model def). */
export const ACTION_KEYS = ['do', 'view', 'zoom', 'from', 'layer', 'overwrite'];
const KEYS = ['do', 'canvas', 'method', 'texel', 'pad', 'max_size', 'angle', 'front', 'max_island', 'parts', 'exclude', 'bake', 'cohesion', 'overwrite', 'view', 'zoom', 'from', 'layer'];
const BAKE = { tile: 'auto', fit: 'auto', fit_max: 0.13, top: null };
const COH = {
  ao: { samples: 16, distance: 24, strength: 1, levels: 4 },
  contact: { width: 4, strength: 1, line: true },
  edges: { width: 1, strength: 1, wear: 0.65, min_angle: 30 },
  grime: { height: 12, strength: 0.5, noise: 8 },
};
const COURSES = { h: 8, len: 16, bond: 'running', joint: 1, color: null, light: null, snap: 'parts', caps: 'edge', parts: null, jitter: 0 };
const COH_TOP = ['ao', 'contact', 'edges', 'grime', 'courses', 'overlays', 'palette', 'colors', 'dither', 'shadow', 'highlight', 'seed', 'across_nodes'];
const OV_WHERE = ['contact', 'cavity', 'top', 'bottom', 'edges', 'all'];

const unknown = (obj, allowed, where) => { for (const k of Object.keys(obj)) if (!allowed.includes(k)) throw new Error(`unwrap: unknown option "${where}${k}" (options: ${allowed.join(', ')})`); };
const numIn = (v, d, lo, hi, name, int = false) => {
  if (v === undefined || v === null) return d;
  const x = Number(v);
  if (!Number.isFinite(x) || x < lo || x > hi || (int && !Number.isInteger(x))) throw new Error(`unwrap: ${name} must be ${int ? 'an integer ' : ''}${lo}..${hi} (got ${JSON.stringify(v)})`);
  return x;
};
const sub0 = (v, defs, name) => {
  if (v === false) return null;
  if (v === undefined || v === null || v === true) return { ...defs };
  if (typeof v !== 'object' || Array.isArray(v)) throw new Error(`unwrap: cohesion.${name} must be an object, true or false`);
  unknown(v, Object.keys(defs), `cohesion.${name}.`);
  const o = { ...defs, ...v };
  for (const [k, d] of Object.entries(defs)) if (typeof d === 'number' && !Number.isFinite(Number(o[k]))) throw new Error(`unwrap: cohesion.${name}.${k} must be a number`); else if (typeof d === 'number') o[k] = Number(o[k]);
  return o;
};

/** cohesion option -> normalized passes (null = skip that pass) or null (no cohesion bake). */
export function normCohesion(v) {
  if (v === false) return null;
  const c = v === undefined || v === null || v === true ? {} : v;
  if (typeof c !== 'object' || Array.isArray(c)) throw new Error('unwrap: cohesion must be true, false or {ao, contact, edges, grime, courses, overlays, palette, ...}');
  unknown(c, COH_TOP, 'cohesion.');
  const o = {};
  for (const [k, d] of Object.entries(COH)) o[k] = sub0(c[k], d, k);
  if (o.ao) { o.ao.samples = Math.max(4, Math.min(64, Math.round(o.ao.samples))); o.ao.levels = Math.max(0, Math.min(16, Math.round(o.ao.levels))); if (!(o.ao.distance > 0)) throw new Error('unwrap: cohesion.ao.distance must be > 0'); }
  if (o.contact && !(o.contact.width > 0)) throw new Error('unwrap: cohesion.contact.width must be > 0');
  if (o.grime && !(o.grime.height > 0 && o.grime.noise > 0)) throw new Error('unwrap: cohesion.grime height / noise must be > 0');
  if (c.courses === undefined || c.courses === null || c.courses === false) o.courses = null;
  else {
    const s = c.courses === true ? {} : c.courses;
    if (typeof s !== 'object' || Array.isArray(s)) throw new Error('unwrap: cohesion.courses must be {h, len, bond, joint, snap, caps, ...} or true');
    unknown(s, Object.keys(COURSES), 'cohesion.courses.');
    const r = { ...COURSES, ...s };
    r.h = numIn(r.h, 8, 2, 256, 'courses.h'); r.len = numIn(r.len, 16, 2, 512, 'courses.len'); r.joint = numIn(r.joint, 1, 1, 4, 'courses.joint', true); r.jitter = numIn(r.jitter, 0, 0, 0.4, 'courses.jitter');
    if (!['running', 'stack', 'drums'].includes(r.bond)) throw new Error('unwrap: courses.bond must be running, stack or drums');
    if (!['parts', 'world'].includes(r.snap)) throw new Error('unwrap: courses.snap must be parts or world');
    if (!['edge', 'grid'].includes(r.caps)) throw new Error('unwrap: courses.caps must be edge or grid');
    if (r.parts !== null && !Array.isArray(r.parts)) throw new Error('unwrap: courses.parts must be a list of part indices or names');
    o.courses = r;
  }
  const ov = c.overlays ?? [];
  if (!Array.isArray(ov)) throw new Error('unwrap: cohesion.overlays must be [{texture, where, amount?, noise?, threshold?}]');
  o.overlays = ov.map((x) => {
    if (!x || typeof x !== 'object' || !x.texture) throw new Error('unwrap: cohesion.overlays entries need texture (+ where:contact|cavity|top|bottom|edges|all)');
    unknown(x, ['texture', 'where', 'amount', 'noise', 'threshold'], 'cohesion.overlays[].');
    const where = x.where ?? 'contact';
    if (!OV_WHERE.includes(where)) throw new Error(`unwrap: overlay where must be ${OV_WHERE.join('|')}`);
    return { texture: x.texture, where, amount: numIn(x.amount, 0.6, 0, 4, 'overlay amount'), noise: numIn(x.noise, 8, 1, 256, 'overlay noise'), threshold: numIn(x.threshold, 0.5, 0, 4, 'overlay threshold') };
  });
  const pal = c.palette ?? 'auto';
  if (!(pal === 'auto' || pal === 'project' || pal === 'canvas' || (Array.isArray(pal) && pal.length))) throw new Error('unwrap: cohesion.palette must be "auto", "project", "canvas" or ["#rrggbb", ...]');
  o.palette = pal;
  o.colors = numIn(c.colors, 32, 2, 256, 'cohesion.colors', true);
  o.dither = c.dither !== false;
  o.shadow = c.shadow ?? '#1a1420';
  o.highlight = c.highlight ?? '#fff2d0';
  o.seed = numIn(c.seed, 1, -1e9, 1e9, 'cohesion.seed', true);
  o.across_nodes = !!c.across_nodes;
  return o;
}

/** unwrap option (true | {...}) -> normalized options. Unknown keys throw. */
export function normUnwrap(v) {
  if (v === true || v === undefined || v === null) v = {};
  if (typeof v !== 'object' || Array.isArray(v)) throw new Error('unwrap must be true or {do?, texel?, max_size?, angle?, parts?, cohesion?, ...} (null on update removes it)');
  unknown(v, KEYS, '');
  const o = {};
  const d = v.do ?? 'all';
  if (Array.isArray(d)) { if (!d.length || d.some((x) => !['layout', 'bake', 'cohesion'].includes(x))) throw new Error('unwrap: do as a list takes layout, bake, cohesion'); o.do = [...d]; }
  else if (!DOS.includes(d)) throw new Error(`unwrap: do must be one of ${DOS.join(', ')}`);
  else o.do = d;
  o.canvas = v.canvas ?? null;
  if (o.canvas !== null && !NAME_RE.test(String(o.canvas))) throw new Error('unwrap: canvas must be 1-64 chars of letters, digits, _ - .');
  o.method = v.method ?? 'smart';
  if (!METHODS.includes(o.method)) throw new Error(`unwrap: method must be ${METHODS.join(', ')}`);
  o.texel = numIn(v.texel, 1, 1e-3, 8, 'texel');
  o.pad = numIn(v.pad, 2, 1, 8, 'pad', true);
  if (Number(v.max_size) > UNWRAP_LIMITS.maxSize) throw new Error(`unwrap: max_size ${v.max_size} is over the ${UNWRAP_LIMITS.maxSize} limit (use texel:2 or unwrap fewer parts)`);
  o.max_size = numIn(v.max_size, 1024, 64, UNWRAP_LIMITS.maxSize, 'max_size', true);
  if (o.max_size & (o.max_size - 1)) throw new Error('unwrap: max_size must be a power of two (64, 128, 256, 512, 1024, 2048)');
  o.angle = numIn(v.angle, 46, 1, 120, 'angle');
  const f = v.front ?? [0, 0.45, 1];
  if (!Array.isArray(f) || f.length !== 3 || f.some((x) => !Number.isFinite(Number(x))) || len(f.map(Number)) < 1e-6) throw new Error('unwrap: front must be [x,y,z] (toward the viewer)');
  o.front = f.map(Number);
  o.max_island = numIn(v.max_island, 512, 1, 4096, 'max_island');
  for (const k of ['parts', 'exclude']) {
    const x = v[k] ?? null;
    if (x !== null && (!Array.isArray(x) || x.some((y) => typeof y !== 'string' && !Number.isInteger(y)))) throw new Error(`unwrap: ${k} must be a list of part indices or names`);
    o[k] = x;
  }
  const b = v.bake ?? {};
  if (typeof b !== 'object' || Array.isArray(b)) throw new Error('unwrap: bake must be {tile?, fit?, fit_max?, top?}');
  unknown(b, Object.keys(BAKE), 'bake.');
  o.bake = { ...BAKE, ...b };
  if (!['auto', 'island', 'uv'].includes(o.bake.tile)) throw new Error('unwrap: bake.tile must be auto, island or uv');
  if (!['auto', true, false].includes(o.bake.fit)) throw new Error('unwrap: bake.fit must be "auto", true or false');
  o.bake.fit_max = numIn(o.bake.fit_max, 0.13, 0, 0.5, 'bake.fit_max');
  o.cohesion = normCohesion(v.cohesion);
  o.overwrite = !!v.overwrite;
  if (v.view !== undefined) o.view = v.view;
  o.zoom = numIn(v.zoom, 1, 1, 8, 'zoom', true);
  if (v.from !== undefined) o.from = String(v.from);
  o.layer = v.layer ?? 'paint';
  return o;
}

/** The stored form of an unwrap option: the caller's spec without the action-only keys (true when empty). */
export function storedUnwrap(v) {
  if (v === true || v === undefined || v === null) return true;
  const out = {};
  for (const [k, x] of Object.entries(v)) if (!ACTION_KEYS.includes(k)) out[k] = x;
  return Object.keys(out).length ? out : true;
}

/** FNV-1a 32-bit, hex. */
export function fnv(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, '0');
}

// ---------- facets + adjacency ----------
const vkey = (p) => `${Math.round(p[0] * 1000)},${Math.round(p[1] * 1000)},${Math.round(p[2] * 1000)}`;
/**
 * Facets (planar pieces) of the included faces, in pattern space, plus edge adjacency on welded
 * positions. A face whose vertices lie within 0.05 px of one plane is one facet; otherwise every
 * triangle is its own facet (CSG / displace / merge output). -> {facets, edges: Map<key, users[]>}
 */
export function facetsOf(mesh, anchor, include = () => true) {
  const facets = [];
  for (const g of mesh.groups.values()) {
    if (!g.faces || g.overlay) continue;
    for (const f of g.faces) {
      if (!include(g, f)) continue;
      const P = (v) => [g.pos[v * 3] - anchor[0], g.pos[v * 3 + 1] - anchor[1], g.pos[v * 3 + 2] - anchor[2]];
      const tris = [];
      for (let i = f.i; i < f.i + f.ic; i += 3) {
        const t = [g.idx[i], g.idx[i + 1], g.idx[i + 2]];
        if (len(cross(sub(P(t[1]), P(t[0])), sub(P(t[2]), P(t[0])))) > 1e-9) tris.push(t);
      }
      if (!tris.length) continue;
      const t0 = tris[0], p0 = P(t0[0]), n0 = norm(cross(sub(P(t0[1]), p0), sub(P(t0[2]), p0)));
      const planar = tris.every((t) => t.every((v) => Math.abs(dot(sub(P(v), p0), n0)) <= 0.05));
      for (const set of planar ? [tris] : tris.map((t) => [t])) {
        if (facets.length >= UNWRAP_LIMITS.facets) throw new Error(`unwrap: over ${UNWRAP_LIMITS.facets} facets (max ${UNWRAP_LIMITS.facets}): decimate / remesh first, or unwrap only parts:[..]`);
        facets.push(makeFacet(facets.length, g, f, set, P));
      }
    }
  }
  const edges = new Map();
  for (const F of facets) for (const [a, b, key] of F.bnd) { let u = edges.get(key); if (!u) edges.set(key, (u = [])); u.push({ fi: F.id, a, b }); }
  return { facets, edges };
}
function makeFacet(id, g, f, tris, P) {
  const verts = [], loc = new Map();
  const L = (v) => { let k = loc.get(v); if (k === undefined) { k = verts.length; loc.set(v, k); verts.push(v); } return k; };
  const lt = tris.map((t) => t.map(L));
  const pos = verts.map(P), uv = verts.map((v) => [g.uv[v * 2], g.uv[v * 2 + 1]]);
  const vk = pos.map(vkey);
  let s = [0, 0, 0], c = [0, 0, 0], A = 0;
  for (const [a, b, cc] of lt) {
    const cr = cross(sub(pos[b], pos[a]), sub(pos[cc], pos[a])), ar = len(cr) / 2;
    s = addv(s, cr); A += ar;
    c = addv(c, scl(addv(addv(pos[a], pos[b]), pos[cc]), ar / 3));
  }
  const n = norm(s);
  c = A > 0 ? scl(c, 1 / A) : pos[0];
  // boundary edges: triangle edges used once inside the facet (welded)
  const cnt = new Map();
  for (const t of lt) for (let k = 0; k < 3; k++) {
    const a = t[k], b = t[(k + 1) % 3];
    if (vk[a] === vk[b]) continue;
    const key = vk[a] < vk[b] ? `${vk[a]}|${vk[b]}` : `${vk[b]}|${vk[a]}`;
    const e = cnt.get(key);
    if (e) e.n++; else cnt.set(key, { n: 1, a, b });
  }
  const bnd = [...cnt].filter(([, e]) => e.n === 1).map(([key, e]) => [e.a, e.b, key]);
  // 3D direction in which the source texture's u grows (world-tiled faces only): charts keep it
  let su = null;
  if ((f.mode === 1 || f.mode === 2) && !f.ctm && g.tex.width * g.tex.height > 1) {
    const [a, b, cc] = lt[0], e1 = sub(pos[b], pos[a]), e2 = sub(pos[cc], pos[a]);
    const d11 = dot(e1, e1), d12 = dot(e1, e2), d22 = dot(e2, e2), det = d11 * d22 - d12 * d12;
    const du1 = uv[b][0] - uv[a][0], du2 = uv[cc][0] - uv[a][0];
    if (Math.abs(det) > 1e-12) { const gr = scl(addv(scl(e1, du1 * d22 - du2 * d12), scl(e2, du2 * d11 - du1 * d12)), 1 / det); if (len(gr) > 1e-9) su = norm(gr); }
  }
  return { id, g, f, verts, tris: lt, pos, uv, vk, n, area: A, c, bnd, su, pi: f.pi, node: f.node, src: { tex: g.tex, mode: f.mode, ctm: !!f.ctm } };
}

// ---------- charts ----------
class Heap {
  constructor() { this.a = []; this.seq = 0; }
  better(x, y) { return x.p > y.p || (x.p === y.p && x.s < y.s); }
  push(it) { it.s = this.seq++; const a = this.a; a.push(it); let i = a.length - 1; while (i > 0) { const j = (i - 1) >> 1; if (!this.better(a[i], a[j])) break; [a[i], a[j]] = [a[j], a[i]]; i = j; } }
  pop() {
    const a = this.a, top = a[0], last = a.pop();
    if (a.length) { a[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < a.length && this.better(a[l], a[m])) m = l; if (r < a.length && this.better(a[r], a[m])) m = r; if (m === i) break; [a[i], a[m]] = [a[m], a[i]]; i = m; } }
    return top;
  }
  get size() { return this.a.length; }
}
const area2 = (t) => (t[2] - t[0]) * (t[5] - t[1]) - (t[4] - t[0]) * (t[3] - t[1]);
/** 2D triangles [x0,y0,x1,y1,x2,y2] overlap (SAT), both shrunk toward their centroid by 0.02 px. */
function shrink(t) {
  const cx = (t[0] + t[2] + t[4]) / 3, cy = (t[1] + t[3] + t[5]) / 3, out = new Array(6);
  for (let k = 0; k < 3; k++) { const dx = t[k * 2] - cx, dy = t[k * 2 + 1] - cy, l = Math.hypot(dx, dy) || 1, s = Math.max(0, l - 0.02) / l; out[k * 2] = cx + dx * s; out[k * 2 + 1] = cy + dy * s; }
  return out;
}
function sat(A, B) {
  for (const T of [A, B]) for (let k = 0; k < 3; k++) {
    const x0 = T[k * 2], y0 = T[k * 2 + 1], x1 = T[((k + 1) % 3) * 2], y1 = T[((k + 1) % 3) * 2 + 1];
    const ax = -(y1 - y0), ay = x1 - x0;
    let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
    for (let j = 0; j < 3; j++) { const pa = A[j * 2] * ax + A[j * 2 + 1] * ay, pb = B[j * 2] * ax + B[j * 2 + 1] * ay; if (pa < a0) a0 = pa; if (pa > a1) a1 = pa; if (pb < b0) b0 = pb; if (pb > b1) b1 = pb; }
    if (a1 <= b0 + 1e-9 || b1 <= a0 + 1e-9) return false;
  }
  return true;
}
const ROLE = (n) => (n[1] > 0.7 ? 'top' : n[1] < -0.7 ? 'bottom' : Math.abs(n[0]) > Math.abs(n[2]) ? (n[0] > 0 ? 'right' : 'left') : n[2] > 0 ? 'front' : 'back');

/**
 * Charts of facets. smart = hinge unfold (rigid: zero stretch), seeded on the most visible facets,
 * high-visibility flat edges joined first so the remaining cuts sit where dot(n, front) is lowest;
 * box = connected same-direction regions projected along their axis; faces = one chart per facet.
 */
export function buildCharts(topo, o) {
  const { facets: F, edges } = topo;
  const fr = norm(o.front), vis = F.map((f) => 0.5 + 0.5 * dot(f.n, fr));
  const method = o.method === 'auto' ? (F.length > 6000 ? 'box' : 'smart') : o.method;
  const x2 = new Array(F.length), chartOf = new Int32Array(F.length).fill(-1);
  const dih = (a, b) => (Math.acos(Math.max(-1, Math.min(1, dot(F[a].n, F[b].n)))) * 180) / Math.PI;
  const placeBy = (f, O3, U, V, o2) => { const out = new Float64Array(f.pos.length * 2); f.pos.forEach((p, k) => { const d = sub(p, O3); out[k * 2] = o2[0] + dot(d, U); out[k * 2 + 1] = o2[1] + dot(d, V); }); return out; };
  const triOf = (f, X, t) => [X[t[0] * 2], X[t[0] * 2 + 1], X[t[1] * 2], X[t[1] * 2 + 1], X[t[2] * 2], X[t[2] * 2 + 1]];
  const axisOf = (n) => { const ax = Math.abs(n[0]) >= Math.abs(n[1]) && Math.abs(n[0]) >= Math.abs(n[2]) ? 0 : Math.abs(n[1]) >= Math.abs(n[2]) ? 1 : 2; return ax * 2 + (n[ax] >= 0 ? 0 : 1); };
  const axisDir = (k) => { const d = [0, 0, 0]; d[k >> 1] = k & 1 ? -1 : 1; return d; };
  const order = F.map((f) => f.id).sort((a, b) => vis[b] - vis[a] || F[b].area - F[a].area || a - b);
  const charts = [];
  for (const seed of order) {
    if (chartOf[seed] >= 0) continue;
    const chart = { id: charts.length, facets: [], sign: 1, bb: [Infinity, Infinity, -Infinity, -Infinity] };
    const grid = new Map(), CELL = 8;
    const sF = F[seed];
    const frame = method === 'box' ? faceBasis(axisDir(axisOf(sF.n))) : faceBasis(sF.n);
    const boxAxis = axisOf(sF.n);
    x2[seed] = placeBy(sF, [0, 0, 0], frame.t, scl(frame.b, -1), [0, 0]);
    chart.sign = Math.sign(area2(triOf(sF, x2[seed], sF.tris[0]))) || 1;
    // in-plane angle between the chart's u axis and the facet's own texture u: kept within 30 deg
    // across the chart, so unfolding never turns a pattern (bevel corners, a box's back face)
    const phiOf = (f, U) => (f.su ? Math.atan2(dot(cross(f.su, U), f.n), dot(f.su, U)) : null);
    chart.phi = phiOf(sF, frame.t);
    const accept = (fi) => {
      chartOf[fi] = chart.id; chart.facets.push(fi);
      const f = F[fi], X = x2[fi];
      for (let k = 0; k < f.pos.length; k++) { const x = X[k * 2], y = X[k * 2 + 1]; if (x < chart.bb[0]) chart.bb[0] = x; if (y < chart.bb[1]) chart.bb[1] = y; if (x > chart.bb[2]) chart.bb[2] = x; if (y > chart.bb[3]) chart.bb[3] = y; }
      for (const t of f.tris) {
        const T = shrink(triOf(f, X, t)), bx = [Math.min(T[0], T[2], T[4]), Math.min(T[1], T[3], T[5]), Math.max(T[0], T[2], T[4]), Math.max(T[1], T[3], T[5])];
        for (let gx = Math.floor(bx[0] / CELL); gx <= Math.floor(bx[2] / CELL); gx++) for (let gy = Math.floor(bx[1] / CELL); gy <= Math.floor(bx[3] / CELL); gy++) { const k = `${gx},${gy}`; let l = grid.get(k); if (!l) grid.set(k, (l = [])); l.push({ T, bx }); }
      }
    };
    const overlaps = (f, X) => {
      for (const t of f.tris) {
        const T = shrink(triOf(f, X, t)), bx = [Math.min(T[0], T[2], T[4]), Math.min(T[1], T[3], T[5]), Math.max(T[0], T[2], T[4]), Math.max(T[1], T[3], T[5])];
        const seen = new Set();
        for (let gx = Math.floor(bx[0] / CELL); gx <= Math.floor(bx[2] / CELL); gx++) for (let gy = Math.floor(bx[1] / CELL); gy <= Math.floor(bx[3] / CELL); gy++) {
          for (const q of grid.get(`${gx},${gy}`) || []) {
            if (seen.has(q)) continue; seen.add(q);
            if (q.bx[0] >= bx[2] || q.bx[2] <= bx[0] || q.bx[1] >= bx[3] || q.bx[3] <= bx[1]) continue;
            if (sat(T, q.T)) return true;
          }
        }
      }
      return false;
    };
    accept(seed);
    if (method !== 'faces') {
      const heap = new Heap();
      const offer = (a) => {
        for (const [la, lb, key] of F[a].bnd) {
          const us = edges.get(key);
          if (!us || us.length !== 2) continue;
          const other = us[0].fi === a ? us[1] : us[0];
          if (other.fi === a || chartOf[other.fi] >= 0) continue;
          heap.push({ p: (vis[a] + vis[other.fi]) / 2 - dih(a, other.fi) / 360, a, b: other.fi, la, lb, key });
        }
      };
      offer(seed);
      while (heap.size) {
        const e = heap.pop();
        const b = e.b;
        if (chartOf[b] >= 0) continue;
        const B = F[b];
        let X;
        if (method === 'box') {
          if (axisOf(B.n) !== boxAxis) continue;
          X = placeBy(B, [0, 0, 0], frame.t, scl(frame.b, -1), [0, 0]);
        } else {
          if (dih(e.a, b) > o.angle + 0.5) continue;
          const A = F[e.a], XA = x2[e.a];
          const P = A.pos[e.la], Q = A.pos[e.lb];
          const p2 = [XA[e.la * 2], XA[e.la * 2 + 1]], q2 = [XA[e.lb * 2], XA[e.lb * 2 + 1]];
          const ex = norm(sub(Q, P)), ey = cross(B.n, ex);
          const dl = Math.hypot(q2[0] - p2[0], q2[1] - p2[1]) || 1, d = [(q2[0] - p2[0]) / dl, (q2[1] - p2[1]) / dl];
          // a's centroid side of the hinge line; b goes to the other side
          let sideA = 0;
          { let sx = 0, sy = 0; for (let k = 0; k < A.pos.length; k++) { sx += XA[k * 2]; sy += XA[k * 2 + 1]; } sx /= A.pos.length; sy /= A.pos.length; sideA = Math.sign(d[0] * (sy - p2[1]) - d[1] * (sx - p2[0])); }
          for (const e2 of [[-d[1], d[0]], [d[1], -d[0]]]) {
            const U = addv(scl(ex, d[0]), scl(ey, e2[0])), V = addv(scl(ex, d[1]), scl(ey, e2[1]));
            const cand = placeBy(B, P, U, V, p2);
            const bc = [dot(sub(B.c, P), U) + p2[0], dot(sub(B.c, P), V) + p2[1]];
            const sideB = Math.sign(d[0] * (bc[1] - p2[1]) - d[1] * (bc[0] - p2[0]));
            if (sideA === 0 || sideB !== sideA) { X = cand; break; }
          }
          if (!X) continue;
        }
        if ((Math.sign(area2(triOf(B, X, B.tris[0]))) || 1) !== chart.sign) continue;
        let phi = null;
        if (method !== 'box' && B.su) {
          // chart u direction on B: the 3D direction of +x2 (rigid placement, so recover it from two vertices)
          const k1 = B.tris[0][0], k2 = B.tris[0][1], k3 = B.tris[0][2];
          const d1 = sub(B.pos[k2], B.pos[k1]), d2 = sub(B.pos[k3], B.pos[k1]);
          const a1 = [X[k2 * 2] - X[k1 * 2], X[k2 * 2 + 1] - X[k1 * 2 + 1]], a2 = [X[k3 * 2] - X[k1 * 2], X[k3 * 2 + 1] - X[k1 * 2 + 1]];
          const dt = a1[0] * a2[1] - a2[0] * a1[1];
          if (Math.abs(dt) > 1e-12) {
            const U = norm(scl(addv(scl(d1, a2[1]), scl(d2, -a1[1])), 1 / dt));
            phi = phiOf(B, U);
            if (chart.phi !== null && phi !== null) { let dphi = Math.abs(phi - chart.phi) % (2 * Math.PI); if (dphi > Math.PI) dphi = 2 * Math.PI - dphi; if (dphi > Math.PI / 6) continue; }
          }
        }
        let bb0 = chart.bb[0], bb1 = chart.bb[1], bb2 = chart.bb[2], bb3 = chart.bb[3];
        for (let k = 0; k < B.pos.length; k++) { const x = X[k * 2], y = X[k * 2 + 1]; bb0 = Math.min(bb0, x); bb1 = Math.min(bb1, y); bb2 = Math.max(bb2, x); bb3 = Math.max(bb3, y); }
        if (bb2 - bb0 > o.max_island || bb3 - bb1 > o.max_island) continue;
        if (overlaps(B, X)) continue;
        x2[b] = X;
        if (chart.phi === null && phi !== null) chart.phi = phi;
        accept(b);
        offer(b);
      }
    }
    charts.push(chart);
    if (charts.length > UNWRAP_LIMITS.islands) throw new Error(`unwrap: over ${UNWRAP_LIMITS.islands} islands: use method:"box", a larger angle, or decimate`);
  }
  // per chart: texel origin, size, ring, role, part
  const t = o.texel;
  for (const c of charts) {
    c.o = [Math.floor(c.bb[0] / t + 1e-6) * t, Math.floor(c.bb[1] / t + 1e-6) * t];
    c.w = Math.max(1, Math.ceil((c.bb[2] - c.o[0]) / t - 1e-6));
    c.h = Math.max(1, Math.ceil((c.bb[3] - c.o[1]) / t - 1e-6));
    c.area = c.facets.reduce((s, fi) => s + F[fi].area, 0);
    const byPart = new Map();
    for (const fi of c.facets) byPart.set(F[fi].pi, (byPart.get(F[fi].pi) || 0) + F[fi].area);
    c.pi = [...byPart].sort((x, y) => y[1] - x[1] || (x[0] ?? -1) - (y[0] ?? -1))[0][0];
    c.ring = null; c.sector = false;
  }
  // seams + ring detection (an edge whose two users are in one chart but at different 2D places)
  const seams = [];
  const at2 = (fi, l) => [x2[fi][l * 2], x2[fi][l * 2 + 1]];
  const sameVk = (B, vk) => B.vk.indexOf(vk);
  for (const [key, us] of edges) {
    if (us.length !== 2) continue;
    const [u0, u1] = us, ca = chartOf[u0.fi], cb = chartOf[u1.fi];
    const A = F[u0.fi], B = F[u1.fi];
    let cut = false, tr = null;
    if (ca === cb) {
      const ka = sameVk(B, A.vk[u0.a]), kb = sameVk(B, A.vk[u0.b]);
      const pa = at2(u0.fi, u0.a), pb = at2(u0.fi, u0.b), qa = at2(u1.fi, ka), qb = at2(u1.fi, kb);
      const d1 = [qa[0] - pa[0], qa[1] - pa[1]], d2 = [qb[0] - pb[0], qb[1] - pb[1]];
      if (Math.hypot(...d1) > 0.01 || Math.hypot(...d2) > 0.01) { cut = true; tr = { d1, d2, pa, pb, qa, qb }; }
    }
    if (ca === cb && !cut) continue;
    const d = (Math.acos(Math.max(-1, Math.min(1, dot(A.n, B.n)))) * 180) / Math.PI;
    seams.push({ key, a: u0, b: u1, vis: (vis[u0.fi] + vis[u1.fi]) / 2, dihedral: d, smooth: d < o.angle, cut });
    if (cut) {
      const c = charts[ca];
      if (c.ring || c.sector) continue;
      const { d1, d2, pa, qa } = tr;
      if (Math.hypot(d1[0] - d2[0], d1[1] - d2[1]) < 0.01 && Math.abs(d1[1]) < 0.01) c.ring = { L: Math.abs(d1[0]), u0: Math.min(pa[0], qa[0]) };
      else c.sector = true;
    }
  }
  for (const c of charts) {
    const ns = c.facets.map((fi) => F[fi].n);
    const roles = new Set(ns.map(ROLE));
    c.role = ns.every((n) => n[1] > 0.7) ? 'top' : ns.every((n) => n[1] < -0.7) ? 'bottom' : roles.size === 1 ? [...roles][0] : c.ring || ns.every((n) => Math.abs(n[1]) <= 0.7) ? 'strip' : 'mixed';
    if (c.ring) c.ring.N = c.facets.length;
  }
  return { charts, x2, chartOf, seams, vis, method };
}

// ---------- packing ----------
const pow2 = (v) => { let p = 1; while (p < v) p *= 2; return p; };
/** Upright shelf packing (no rotation, no rescale) into the smallest power-of-two atlas <= maxSize. */
export function packIslands(charts, { pad, max_size: maxSize, texel }) {
  const cells = charts.map((c) => ({ c, w: c.w + 2 * pad, h: c.h + 2 * pad }));
  const ord = [...cells].sort((a, b) => b.h - a.h || b.w - a.w || a.c.id - b.c.id);
  const widest = Math.max(1, ...cells.map((c) => c.w));
  let best = null;
  for (let W = Math.max(16, pow2(widest)); W <= maxSize; W *= 2) {
    let x = 0, y = 0, sh = 0;
    const pos = new Map();
    for (const cl of ord) {
      if (x + cl.w > W) { y += sh; x = 0; sh = 0; }
      pos.set(cl.c.id, [x, y]); x += cl.w; sh = Math.max(sh, cl.h);
    }
    const H = Math.max(16, pow2(y + sh));
    if (H > maxSize) continue;
    const cand = { W, H, pos };
    const sq = (c) => Math.abs(Math.log2(c.W / c.H));
    if (!best || W * H < best.W * best.H || (W * H === best.W * best.H && (sq(cand) < sq(best) || (sq(cand) === sq(best) && W < best.W)))) best = cand;
  }
  if (!best) {
    const area = cells.reduce((s, c) => s + c.w * c.h, 0);
    throw new Error(`unwrap: ${area} texels do not fit ${maxSize}x${maxSize} at texel ${texel} px. Fix: unwrap:{max_size:${Math.min(2048, maxSize * 2)}} | {texel:${texel * 2}} |${pad > 1 ? ` {pad:1} (less padding per island) |` : ''} parts:[..] (unwrap the hero parts, the rest stays tiled)`);
  }
  let used = 0;
  for (const c of charts) { const [x, y] = best.pos.get(c.id); c.rect = [x + pad, y + pad, c.w, c.h]; used += c.w * c.h; }
  return { W: best.W, H: best.H, fill: +(used / (best.W * best.H)).toFixed(3) };
}

// ---------- layout ----------
const r2 = (v) => Math.round(v * 100) / 100;
/** Geometry key of the included facets + options (cache key, computed before the layout). */
export function geoKey(topo, o) {
  let s = `${o.method}|${o.texel}|${o.pad}|${o.angle}|${o.front}|${o.max_island}|${o.max_size}|`;
  for (const f of topo.facets) { for (const p of f.pos) s += `${r2(p[0])},${r2(p[1])},${r2(p[2])};`; s += '/'; }
  return fnv(s);
}
/**
 * Model layout: facets -> charts -> packed islands. mesh = a plain build (per-part textures, origin
 * shift done). -> {W, H, fill, charts, facets, edges, seams, x2, chartOf, hash, anchor, ...}
 */
export function layoutOf(mesh, o, { anchor, include, topo: topo0 } = {}) {
  const topo = topo0 || facetsOf(mesh, anchor, include);
  if (!topo.facets.length) throw new Error('unwrap: no faces to unwrap (every part is excluded, glass / opacity, or materials v2)');
  const ch = buildCharts(topo, o);
  const pk = packIslands(ch.charts, o);
  for (const c of ch.charts) {
    const pts = [];
    for (const fi of c.facets) for (const p of topo.facets[fi].pos) pts.push(`${r2(p[0])},${r2(p[1])},${r2(p[2])}`);
    pts.sort();
    c.key = fnv(pts.join(';') + `|${o.texel}`);
  }
  const hash = fnv(ch.charts.map((c) => `${c.key}:${c.rect.join(',')}`).join(';') + `|${ch.method}|${o.texel}|${o.pad}|${o.angle}|${o.front}`);
  return { ...ch, ...pk, facets: topo.facets, edges: topo.edges, hash, anchor, texel: o.texel, pad: o.pad, angle: o.angle, front: o.front };
}

// ---------- texel map ----------
/**
 * Which facet / triangle / point each atlas texel shows (texel centre inside the triangle, lowest
 * facet id wins). Helpers: posAt(k) pattern position, nrmAt(k) facet normal (vertex normal on ring
 * charts), srcUV(k) the original UV, st(k) the island pattern coords (texel centre).
 */
export function texelMap(L) {
  const { W, H, texel: t } = L;
  const facet = new Int32Array(W * H).fill(-1), tri = new Int32Array(W * H).fill(-1), island = new Int32Array(W * H).fill(-1), bary = new Float32Array(W * H * 3);
  for (const c of L.charts) {
    const [rx, ry] = c.rect;
    for (const fi of [...c.facets].sort((a, b) => a - b)) {
      const F = L.facets[fi], X = L.x2[fi];
      F.tris.forEach((tr, ti) => {
        const P = tr.map((v) => [rx + (X[v * 2] - c.o[0]) / t, ry + (X[v * 2 + 1] - c.o[1]) / t]);
        const ar = (P[1][0] - P[0][0]) * (P[2][1] - P[0][1]) - (P[2][0] - P[0][0]) * (P[1][1] - P[0][1]);
        if (Math.abs(ar) < 1e-12) return;
        const x0 = Math.max(0, Math.floor(Math.min(P[0][0], P[1][0], P[2][0]))), x1 = Math.min(W - 1, Math.ceil(Math.max(P[0][0], P[1][0], P[2][0])));
        const y0 = Math.max(0, Math.floor(Math.min(P[0][1], P[1][1], P[2][1]))), y1 = Math.min(H - 1, Math.ceil(Math.max(P[0][1], P[1][1], P[2][1])));
        for (let j = y0; j <= y1; j++) for (let i = x0; i <= x1; i++) {
          const k = j * W + i;
          if (facet[k] >= 0) continue;
          const qx = i + 0.5, qy = j + 0.5;
          const l0 = ((P[1][0] - qx) * (P[2][1] - qy) - (P[2][0] - qx) * (P[1][1] - qy)) / ar;
          const l1 = ((P[2][0] - qx) * (P[0][1] - qy) - (P[0][0] - qx) * (P[2][1] - qy)) / ar;
          const l2 = 1 - l0 - l1;
          if (l0 < -1e-4 || l1 < -1e-4 || l2 < -1e-4) continue;
          facet[k] = fi; tri[k] = ti; island[k] = c.id; bary[k * 3] = l0; bary[k * 3 + 1] = l1; bary[k * 3 + 2] = l2;
        }
      });
    }
  }
  const lerp = (k, get) => {
    const F = L.facets[facet[k]], tr = F.tris[tri[k]];
    const a = get(F, tr[0]), b = get(F, tr[1]), c = get(F, tr[2]), w0 = bary[k * 3], w1 = bary[k * 3 + 1], w2 = bary[k * 3 + 2];
    return a.map((v, q) => v * w0 + b[q] * w1 + c[q] * w2);
  };
  const posAt = (k) => lerp(k, (F, v) => F.pos[v]);
  const srcUV = (k) => lerp(k, (F, v) => F.uv[v]);
  const nrmAt = (k) => {
    const F = L.facets[facet[k]];
    if (!L.charts[island[k]].ring) return F.n;
    const g = F.g;
    return norm(lerp(k, (F2, v) => { const gv = F2.verts[v]; return [g.nrm[gv * 3], g.nrm[gv * 3 + 1], g.nrm[gv * 3 + 2]]; }));
  };
  const st = (k) => {
    const c = L.charts[island[k]], i = k % W, j = (k - i) / W;
    return [c.o[0] + (i + 0.5 - c.rect[0]) * t, c.o[1] + (j + 0.5 - c.rect[1]) * t];
  };
  let filled = 0;
  for (let k = 0; k < W * H; k++) if (facet[k] >= 0) filled++;
  return { W, H, facet, tri, island, bary, posAt, srcUV, nrmAt, st, filled };
}

/** Grow filled texels into their empty 4-neighbours `pad` times (gutters, partly covered edge texels). ch = channels per texel. */
export function dilate(data, mask, W, H, pad, ch = 4) {
  const m = Uint8Array.from(mask);
  for (let it = 0; it < pad; it++) {
    const prev = Uint8Array.from(m);
    for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
      const k = j * W + i;
      if (prev[k]) continue;
      const src = j > 0 && prev[k - W] ? k - W : i > 0 && prev[k - 1] ? k - 1 : i < W - 1 && prev[k + 1] ? k + 1 : j < H - 1 && prev[k + W] ? k + W : -1;
      if (src < 0) continue;
      for (let q = 0; q < ch; q++) data[k * ch + q] = data[src * ch + q];
      m[k] = 1;
    }
  }
  return m;
}

// ---------- regroup: unwrapped faces -> one atlas group ----------
/**
 * Move every unwrapped face into ONE group textured with the atlas (UV = island texel coords).
 * Face records keep all their properties (part, node, overlays, material key, CTM flag, ...), so
 * rigs, lightmaps, skin weights and damage keep working. Emptied groups are dropped; the atlas group
 * comes first. Faces split into triangle facets become one face record per facet.
 */
export function regroup(mesh, L, atlasTex) {
  const byFace = new Map();
  for (const F of L.facets) { let l = byFace.get(F.f); if (!l) byFace.set(F.f, (l = [])); l.push(F); }
  const ag = { tex: atlasTex, pos: [], nrm: [], uv: [], idx: [], faces: [] };
  const t = L.texel;
  for (const F of L.facets) {
    const c = L.charts[L.chartOf[F.id]], X = L.x2[F.id], g = F.g;
    const base = ag.pos.length / 3, i0 = ag.idx.length;
    for (let k = 0; k < F.verts.length; k++) {
      const v = F.verts[k];
      ag.pos.push(g.pos[v * 3], g.pos[v * 3 + 1], g.pos[v * 3 + 2]); ag.nrm.push(g.nrm[v * 3], g.nrm[v * 3 + 1], g.nrm[v * 3 + 2]);
      ag.uv.push((c.rect[0] + (X[k * 2] - c.o[0]) / t) / L.W, (c.rect[1] + (X[k * 2 + 1] - c.o[1]) / t) / L.H);
    }
    for (const tr of F.tris) ag.idx.push(base + tr[0], base + tr[1], base + tr[2]);
    ag.faces.push({ ...F.f, n: F.f.n.slice(), v: base, vc: F.verts.length, i: i0, ic: ag.idx.length - i0, mode: 0, uvi: c.id });
  }
  const groups = new Map();
  const akey = atlasTex.key;
  groups.set(akey, ag);
  for (const [k, g] of mesh.groups) {
    if (g.overlay || !g.faces || !g.faces.some((f) => byFace.has(f))) { groups.set(k === akey ? `${k}|own` : k, g); continue; }
    const pos = [], nrm = [], uv = [], idx = [], faces = [];
    for (const f of g.faces) {
      if (byFace.has(f)) continue;
      const remap = new Map(), base = pos.length / 3, i0 = idx.length;
      const V = (v) => { let r = remap.get(v); if (r === undefined) { r = base + remap.size; remap.set(v, r); pos.push(g.pos[v * 3], g.pos[v * 3 + 1], g.pos[v * 3 + 2]); nrm.push(g.nrm[v * 3], g.nrm[v * 3 + 1], g.nrm[v * 3 + 2]); uv.push(g.uv[v * 2], g.uv[v * 2 + 1]); } return r; };
      for (let v = f.v; v < f.v + f.vc; v++) V(v);
      for (let i = f.i; i < f.i + f.ic; i++) idx.push(V(g.idx[i]));
      faces.push({ ...f, v: base, vc: remap.size, i: i0 });
    }
    if (faces.length) groups.set(k, { ...g, pos, nrm, uv, idx, faces });
  }
  mesh.groups = groups;
  return mesh;
}
