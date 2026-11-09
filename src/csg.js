// Mesh booleans for art_model parts (subtract / union / intersect): BSP-tree CSG (the classic
// csg.js algorithm) on the parts' triangles, carrying per-vertex normal + UV and the source face
// record (texture, UV mode, part id, overlays, ...). World-tiled faces get fresh world UVs after
// placement; image-mapped faces interpolate their UVs. A T-junction pass then splits every edge at
// the vertices lying on it, so the result is edge-manifold (closed solids stay watertight).
// Also: merge (weld near vertices + drop internal coincident faces) and an edge-manifold check.
import { Mesh } from './model3d.js';
import { robustBoolean } from './meshbool.js';

const EPS = 1e-4;
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const norm = (a) => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const lerpV = (a, b, t) => ({ p: a.p.map((v, k) => v + (b.p[k] - v) * t), n: a.n.map((v, k) => v + (b.n[k] - v) * t), uv: [a.uv[0] + (b.uv[0] - a.uv[0]) * t, a.uv[1] + (b.uv[1] - a.uv[1]) * t] });

class Poly {
  constructor(verts, shared, plane) {
    this.verts = verts; this.shared = shared;
    this.plane = plane || Plane.from(verts[0].p, verts[1].p, verts[2].p);
  }
  flip() { this.verts.reverse(); for (const v of this.verts) v.n = v.n.map((x) => -x); this.plane = this.plane.flipped(); this.flipped = !this.flipped; }
}
class Plane {
  constructor(n, w) { this.n = n; this.w = w; }
  static from(a, b, c) { const n = norm(cross(sub(b, a), sub(c, a))); return new Plane(n, dot(n, a)); }
  flipped() { return new Plane(this.n.map((x) => -x), -this.w); }
  /** csg.js splitPolygon: coplanar polygons go to cf (same facing) or cb, spanning ones are split. */
  split(poly, cf, cb, front, back) {
    const COP = 0, FR = 1, BK = 2, SP = 3;
    let pt = 0;
    const types = poly.verts.map((v) => { const t = dot(this.n, v.p) - this.w; const ty = t < -EPS ? BK : t > EPS ? FR : COP; pt |= ty; return ty; });
    if (pt === COP) (dot(this.n, poly.plane.n) > 0 ? cf : cb).push(poly);
    else if (pt === FR) front.push(poly);
    else if (pt === BK) back.push(poly);
    else {
      const f = [], b = [];
      for (let i = 0; i < poly.verts.length; i++) {
        const j = (i + 1) % poly.verts.length, ti = types[i], tj = types[j], vi = poly.verts[i], vj = poly.verts[j];
        if (ti !== BK) f.push(ti === COP ? { ...vi, p: vi.p.slice(), n: vi.n.slice(), uv: vi.uv.slice() } : vi);
        if (ti !== FR) b.push(ti === COP ? { ...vi, p: vi.p.slice(), n: vi.n.slice(), uv: vi.uv.slice() } : vi);
        if ((ti | tj) === SP) {
          const t = (this.w - dot(this.n, vi.p)) / dot(this.n, sub(vj.p, vi.p));
          const v = lerpV(vi, vj, t);
          f.push(v); b.push({ p: v.p.slice(), n: v.n.slice(), uv: v.uv.slice() });
        }
      }
      if (f.length >= 3) front.push(new Poly(f, poly.shared, poly.plane));
      if (b.length >= 3) back.push(new Poly(b, poly.shared, poly.plane));
    }
  }
}
class Node {
  constructor(polys) { this.plane = null; this.front = null; this.back = null; this.polys = []; if (polys) this.build(polys); }
  invert() {
    const st = [this];
    while (st.length) {
      const n = st.pop();
      for (const p of n.polys) p.flip();
      if (n.plane) n.plane = n.plane.flipped();
      [n.front, n.back] = [n.back, n.front];
      if (n.front) st.push(n.front);
      if (n.back) st.push(n.back);
    }
  }
  clipPolygons(polys) {
    if (!this.plane) return polys.slice();
    let front = [], back = [];
    for (const p of polys) this.plane.split(p, front, back, front, back);
    if (this.front) front = this.front.clipPolygons(front);
    back = this.back ? this.back.clipPolygons(back) : [];
    return front.concat(back);
  }
  clipTo(bsp) {
    const st = [this];
    while (st.length) {
      const n = st.pop();
      n.polys = bsp.clipPolygons(n.polys);
      if (n.front) st.push(n.front);
      if (n.back) st.push(n.back);
    }
  }
  all() {
    const out = [], st = [this];
    while (st.length) { const n = st.pop(); for (const p of n.polys) out.push(p); if (n.front) st.push(n.front); if (n.back) st.push(n.back); }
    return out;
  }
  build(polys) {
    const st = [[this, polys]];
    while (st.length) {
      const [node, list] = st.pop();
      if (!list.length) continue;
      if (!node.plane) node.plane = list[0].plane;
      const front = [], back = [];
      for (const p of list) node.plane.split(p, node.polys, node.polys, front, back);
      if (front.length) { if (!node.front) node.front = new Node(); st.push([node.front, front]); }
      if (back.length) { if (!node.back) node.back = new Node(); st.push([node.back, back]); }
    }
  }
}

/** Mesh base faces -> BSP polygons (one per triangle, so every polygon is convex). Overlay shells are dropped. */
function toPolys(mesh) {
  const out = [];
  for (const g of mesh.groups.values()) {
    if (!g.faces) continue;
    for (const f of g.faces) {
      const shared = { tex: g.tex, f };
      for (let i = f.i; i < f.i + f.ic; i += 3) {
        const vs = [0, 1, 2].map((k) => { const v = g.idx[i + k]; return { p: [g.pos[v * 3], g.pos[v * 3 + 1], g.pos[v * 3 + 2]], n: [g.nrm[v * 3], g.nrm[v * 3 + 1], g.nrm[v * 3 + 2]], uv: [g.uv[v * 2], g.uv[v * 2 + 1]] }; });
        if (len(cross(sub(vs[1].p, vs[0].p), sub(vs[2].p, vs[0].p))) < 1e-9) continue;
        out.push(new Poly(vs, shared));
      }
    }
  }
  return out;
}

const qk = (p) => `${Math.round(p[0] / EPS / 10)},${Math.round(p[1] / EPS / 10)},${Math.round(p[2] / EPS / 10)}`;
/** Split polygon edges at vertices of other polygons lying on them (removes T-junctions). */
function fixTJunctions(polys) {
  const pts = new Map();
  for (const p of polys) for (const v of p.verts) { const k = qk(v.p); if (!pts.has(k)) pts.set(k, v.p); }
  const P = [...pts.values()];
  if (!P.length) return polys;
  // uniform grid over the points
  let mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (const p of P) for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], p[k]); mx[k] = Math.max(mx[k], p[k]); }
  const ext = Math.max(mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2], 1e-3);
  const cs = Math.max(ext / Math.max(1, Math.cbrt(P.length) * 2), 1e-3);
  const cell = (p) => [0, 1, 2].map((k) => Math.floor((p[k] - mn[k]) / cs));
  const grid = new Map();
  for (const p of P) { const c = cell(p).join(','); if (!grid.has(c)) grid.set(c, []); grid.get(c).push(p); }
  const tol = 1e-4;
  return polys.map((poly) => {
    const vs = poly.verts, out = [];
    let changed = false;
    for (let i = 0; i < vs.length; i++) {
      const a = vs[i], b = vs[(i + 1) % vs.length];
      out.push(a);
      const d = sub(b.p, a.p), L2 = dot(d, d);
      if (L2 < 1e-12) continue;
      const c0 = cell([Math.min(a.p[0], b.p[0]), Math.min(a.p[1], b.p[1]), Math.min(a.p[2], b.p[2])]), c1 = cell([Math.max(a.p[0], b.p[0]), Math.max(a.p[1], b.p[1]), Math.max(a.p[2], b.p[2])]);
      if ((c1[0] - c0[0] + 1) * (c1[1] - c0[1] + 1) * (c1[2] - c0[2] + 1) > 4096) continue;
      const hits = [];
      for (let x = c0[0]; x <= c1[0]; x++) for (let y = c0[1]; y <= c1[1]; y++) for (let z = c0[2]; z <= c1[2]; z++) {
        for (const q of grid.get(`${x},${y},${z}`) || []) {
          const t = dot(sub(q, a.p), d) / L2;
          if (t <= 1e-6 || t >= 1 - 1e-6) continue;
          const foot = [a.p[0] + d[0] * t, a.p[1] + d[1] * t, a.p[2] + d[2] * t];
          if (len(sub(foot, q)) < tol) hits.push(t);
        }
      }
      if (!hits.length) continue;
      hits.sort((x, y) => x - y);
      let last = 0;
      for (const t of hits) { if (t - last < 1e-7) continue; const v = lerpV(a, b, t); out.push(v); last = t; changed = true; }
    }
    if (!changed) return poly;
    const np = new Poly(out, poly.shared, poly.plane);
    np.tj = true;
    return np;
  });
}

const FACE_PROPS = ['pid', 'tag', 'ov', 'mat', 'node', 'trim', 'edge', 'greeble', 'gh', 'cs', 'rs', 'trimmed', 'pi', 'fill'];
/** Polygons -> Mesh faces (fan, or a centroid fan for polygons that gained T-junction points). */
function toMesh(polys) {
  const m = new Mesh();
  for (const poly of polys) {
    const { tex, f } = poly.shared;
    const g = m.group(tex), base = g.pos.length / 3, i0 = g.idx.length;
    let vs = poly.verts;
    const pushV = (v) => { g.pos.push(v.p[0], v.p[1], v.p[2]); const n = norm(v.n); g.nrm.push(n[0], n[1], n[2]); g.uv.push(v.uv[0], v.uv[1]); };
    if (poly.tj) {
      const c = vs.reduce((acc, v) => ({ p: acc.p.map((x, k) => x + v.p[k] / vs.length), n: acc.n.map((x, k) => x + v.n[k] / vs.length), uv: [acc.uv[0] + v.uv[0] / vs.length, acc.uv[1] + v.uv[1] / vs.length] }), { p: [0, 0, 0], n: [0, 0, 0], uv: [0, 0] });
      vs.forEach(pushV); pushV(c);
      const ci = base + vs.length;
      for (let i = 0; i < vs.length; i++) {
        const a = base + i, b = base + ((i + 1) % vs.length);
        if (len(cross(sub(vs[(i + 1) % vs.length].p, vs[i].p), sub(c.p, vs[i].p))) < 1e-10) continue;
        g.idx.push(ci, a, b);
      }
    } else {
      vs.forEach(pushV);
      for (let i = 1; i + 1 < vs.length; i++) {
        if (len(cross(sub(vs[i].p, vs[0].p), sub(vs[i + 1].p, vs[0].p))) < 1e-10) continue;
        g.idx.push(base, base + i, base + i + 1);
      }
    }
    const rec = { v: base, vc: g.pos.length / 3 - base, i: i0, ic: g.idx.length - i0, n: poly.plane.n.slice(), mode: f.mode };
    for (const k of FACE_PROPS) if (f[k] !== undefined) rec[k] = f[k];
    // cutter walls of image-mapped faces keep their (interpolated) UVs; world-tiled faces are re-mapped on the flipped normal
    g.faces.push(rec);
  }
  return m;
}

/** BSP boolean of two closed polygon sets. */
function csg(op, pa, pb) {
  const a = new Node(pa), b = new Node(pb);
  if (op === 'union') { a.clipTo(b); b.clipTo(a); b.invert(); b.clipTo(a); b.invert(); a.build(b.all()); }
  else if (op === 'subtract') { a.invert(); a.clipTo(b); b.clipTo(a); b.invert(); b.clipTo(a); b.invert(); a.build(b.all()); a.invert(); }
  else { a.invert(); b.clipTo(a); b.invert(); a.clipTo(b); b.clipTo(a); a.build(b.all()); a.invert(); }
  return a.all();
}
/** Connected components of polygons (shared vertex positions) with their bounding boxes. */
function components(polys) {
  const parent = polys.map((_, i) => i);
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const owner = new Map();
  polys.forEach((p, i) => { for (const v of p.verts) { const k = qk(v.p); if (owner.has(k)) { const a = find(owner.get(k)), b = find(i); if (a !== b) parent[a] = b; } else owner.set(k, i); } });
  const groups = new Map();
  polys.forEach((p, i) => { const r = find(i); if (!groups.has(r)) groups.set(r, { polys: [], min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] }); const c = groups.get(r); c.polys.push(p); for (const v of p.verts) for (let k = 0; k < 3; k++) { c.min[k] = Math.min(c.min[k], v.p[k]); c.max[k] = Math.max(c.max[k], v.p[k]); } });
  return [...groups.values()];
}
const overlaps = (a, b) => [0, 1, 2].every((k) => a.min[k] <= b.max[k] + EPS && b.min[k] <= a.max[k] + EPS);

/** Above this many input triangles (A + B) booleans use the robust BVH / arrangement path (meshbool.js). */
export const ROBUST_THRESHOLD = 4000;
const baseTris = (m) => { let n = 0; for (const g of m.groups.values()) if (!g.overlay) n += g.idx.length / 3; return n; };

/**
 * Boolean of two placed meshes: op subtract (a - b) | union | intersect -> new Mesh. opts.method:
 * "auto" (default: BSP below ROBUST_THRESHOLD input triangles, robust above), "bsp", "robust".
 * BSP works per closed piece: pieces of A whose box misses B pass through untouched (subtract /
 * union) or drop (intersect), so greebles and trims away from a cut keep their exact triangles.
 */
export function booleanMesh(op, A, B, opts = {}) {
  if (!['subtract', 'union', 'intersect'].includes(op)) throw new Error(`boolean must be "subtract", "union" or "intersect" (got ${JSON.stringify(op)})`);
  const method = opts.method ?? 'auto';
  if (!['auto', 'bsp', 'robust'].includes(method)) throw new Error(`boolean method must be "auto", "bsp" or "robust" (got ${JSON.stringify(method)})`);
  if (method === 'robust' || (method === 'auto' && baseTris(A) + baseTris(B) > (opts.threshold ?? ROBUST_THRESHOLD))) return robustBoolean(op, A, B, opts).mesh;
  const ca = components(toPolys(A)), pb = toPolys(B);
  const bb = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  for (const p of pb) for (const v of p.verts) for (let k = 0; k < 3; k++) { bb.min[k] = Math.min(bb.min[k], v.p[k]); bb.max[k] = Math.max(bb.max[k], v.p[k]); }
  const res = [];
  const hit = ca.filter((c) => overlaps(c, bb)), miss = ca.filter((c) => !overlaps(c, bb));
  if (op !== 'intersect') for (const c of miss) res.push(...c.polys);
  if (op === 'subtract') for (const c of hit) res.push(...csg('subtract', c.polys, pb.map((p) => new Poly(p.verts.map((v) => ({ ...v, p: v.p.slice(), n: v.n.slice(), uv: v.uv.slice() })), p.shared, p.plane))));
  else if (op === 'intersect') for (const c of hit) res.push(...csg('intersect', c.polys, pb.map((p) => new Poly(p.verts.map((v) => ({ ...v, p: v.p.slice(), n: v.n.slice(), uv: v.uv.slice() })), p.shared, p.plane))));
  else {
    // union: fold the overlapping pieces into the cutter one closed piece at a time
    let acc = pb;
    for (const c of hit) acc = csg('union', c.polys, acc);
    res.push(...acc);
  }
  const out = toMesh(fixTJunctions(res));
  // overlay shells of the target ride along (cut geometry has none)
  for (const g of A.groups.values()) if (g.overlay) out.add({ groups: new Map([[g.tex.key, g]]) });
  return out;
}

/**
 * Edge-manifold check (positions welded at 1e-4 px): every undirected edge used by exactly two
 * triangles with opposite orientation. -> {edges, open, nonManifold, flipped}
 */
export function manifoldStats(mesh) {
  const id = new Map(), key = (g, v) => { const k = qk([g.pos[v * 3], g.pos[v * 3 + 1], g.pos[v * 3 + 2]]); if (!id.has(k)) id.set(k, id.size); return id.get(k); };
  const E = new Map();
  for (const g of mesh.groups.values()) {
    if (g.overlay) continue;
    for (let t = 0; t < g.idx.length; t += 3) {
      const c = [0, 1, 2].map((k) => key(g, g.idx[t + k]));
      if (c[0] === c[1] || c[1] === c[2] || c[0] === c[2]) continue;
      for (let k = 0; k < 3; k++) {
        const a = c[k], b = c[(k + 1) % 3], ek = a < b ? `${a}_${b}` : `${b}_${a}`;
        const e = E.get(ek) || { n: 0, dir: 0 };
        e.n++; e.dir += a < b ? 1 : -1;
        E.set(ek, e);
      }
    }
  }
  let open = 0, nonManifold = 0, flipped = 0;
  for (const e of E.values()) { if (e.n === 1) open++; else if (e.n > 2) nonManifold++; else if (e.dir !== 0) flipped++; }
  return { edges: E.size, open, nonManifold, flipped };
}

/** Keep only referenced vertices, each face's vertices contiguous again (face v/vc ranges stay valid). Damage blend data (uvd, dmg, morphs) rides along when present. */
export function compactGroup(g) {
  const pos = [], nrm = [], uv = [], idx = [], faces = [];
  const uvd = g.uvd ? [] : null, dmg = g.dmg ? [] : null, morphs = g.morphs ? g.morphs.map((t) => ({ name: t.name, pos: [], nrm: [] })) : null;
  for (const f of g.faces) {
    const map = new Map(), base = pos.length / 3, i0 = idx.length;
    for (let i = f.i; i < f.i + f.ic; i++) {
      const v = g.idx[i];
      if (!map.has(v)) {
        map.set(v, base + map.size); pos.push(g.pos[v * 3], g.pos[v * 3 + 1], g.pos[v * 3 + 2]); nrm.push(g.nrm[v * 3], g.nrm[v * 3 + 1], g.nrm[v * 3 + 2]); uv.push(g.uv[v * 2], g.uv[v * 2 + 1]);
        if (uvd) uvd.push(g.uvd[v * 2], g.uvd[v * 2 + 1]);
        if (dmg) for (let c = 0; c < 4; c++) dmg.push(g.dmg[v * 4 + c]);
        if (morphs) morphs.forEach((t, k) => { for (let c = 0; c < 3; c++) { t.pos.push(g.morphs[k].pos[v * 3 + c]); t.nrm.push(g.morphs[k].nrm[v * 3 + c]); } });
      }
      idx.push(map.get(v));
    }
    faces.push({ ...f, v: base, vc: map.size, i: i0, ic: idx.length - i0 });
  }
  Object.assign(g, { pos, nrm, uv, idx, faces });
  if (uvd) g.uvd = uvd;
  if (dmg) g.dmg = dmg;
  if (morphs) g.morphs = morphs;
}

/**
 * merge: weld vertices closer than `weld` px (snap to one position), then drop internal faces:
 * triangles covered by an opposite-facing coplanar triangle set (touching boxes, stacked kit
 * pieces). -> {mesh, welded, dropped}
 */
export function mergeMesh(mesh, { weld = 0.01, internal = true } = {}) {
  let welded = 0;
  if (weld > 0) {
    const cells = new Map(), cs = weld * 2;
    const snapTo = (p) => {
      const c = p.map((v) => Math.floor(v / cs));
      for (let x = -1; x <= 1; x++) for (let y = -1; y <= 1; y++) for (let z = -1; z <= 1; z++) {
        for (const q of cells.get(`${c[0] + x},${c[1] + y},${c[2] + z}`) || []) if (len(sub(p, q)) <= weld) return q;
      }
      const k = c.join(',');
      if (!cells.has(k)) cells.set(k, []);
      cells.get(k).push(p);
      return p;
    };
    for (const g of mesh.groups.values()) for (let i = 0; i < g.pos.length; i += 3) {
      const p = [g.pos[i], g.pos[i + 1], g.pos[i + 2]], q = snapTo(p);
      if (q !== p) { if (q[0] !== p[0] || q[1] !== p[1] || q[2] !== p[2]) welded++; g.pos[i] = q[0]; g.pos[i + 1] = q[1]; g.pos[i + 2] = q[2]; }
    }
  }
  let dropped = 0;
  if (internal) {
    const tris = [];
    for (const g of mesh.groups.values()) {
      if (!g.faces) continue;
      for (const f of g.faces) for (let i = f.i; i < f.i + f.ic; i += 3) {
        const P = [0, 1, 2].map((k) => { const v = g.idx[i + k]; return [g.pos[v * 3], g.pos[v * 3 + 1], g.pos[v * 3 + 2]]; });
        const cr = cross(sub(P[1], P[0]), sub(P[2], P[0]));
        if (len(cr) < 1e-9) continue;
        const n = norm(cr);
        tris.push({ g, f, i, P, n, d: dot(n, P[0]) });
      }
    }
    const pk = (n, d) => `${n.map((v) => Math.round(v * 1000)).join(',')}|${Math.round(d * 100)}`;
    const byPlane = new Map();
    for (const t of tris) { const k = pk(t.n, t.d); if (!byPlane.has(k)) byPlane.set(k, []); byPlane.get(k).push(t); }
    const inTri = (q, T, n) => {
      for (let k = 0; k < 3; k++) { const a = T[k], b = T[(k + 1) % 3]; if (dot(cross(sub(b, a), sub(q, a)), n) < -1e-6) return false; }
      return true;
    };
    const drop = new Set();
    for (const t of tris) {
      const opp = byPlane.get(pk(t.n.map((v) => -v), -t.d));
      if (!opp) continue;
      const c = [0, 1, 2].map((k) => (t.P[0][k] + t.P[1][k] + t.P[2][k]) / 3);
      const probes = [c, ...t.P.map((p) => p.map((v, k) => v + (c[k] - v) * 0.02))];
      if (probes.every((q) => opp.some((o) => inTri(q, o.P, o.n)))) drop.add(t);
    }
    if (drop.size) {
      const dropIdx = new Map();
      for (const t of drop) { if (!dropIdx.has(t.g)) dropIdx.set(t.g, new Set()); dropIdx.get(t.g).add(t.i); }
      for (const [g, set] of dropIdx) {
        const idx = [], faces = [];
        for (const f of g.faces) {
          const i0 = idx.length;
          for (let i = f.i; i < f.i + f.ic; i += 3) if (!set.has(i)) idx.push(g.idx[i], g.idx[i + 1], g.idx[i + 2]);
          if (idx.length > i0) faces.push({ ...f, i: i0, ic: idx.length - i0 });
        }
        g.idx = idx; g.faces = faces;
        compactGroup(g);
      }
      dropped = drop.size;
    }
  }
  return { mesh, welded, dropped };
}
