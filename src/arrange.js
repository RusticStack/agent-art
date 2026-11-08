// Triangle arrangement for the robust booleans (meshbool.js): intersection segments between
// triangles with SYMBOLIC endpoint keys, so every triangle that touches an intersection point uses
// the very same point object (watertight by construction, no T-junction search), and the split of
// one triangle into the faces of its planar graph (segments + boundary), holes included.
//
// Point keys (computed once, shared by all triangles):
//   v<pid>                 an input vertex (on the other plane within eps)
//   e<a>_<b>f<tri>         input edge a-b crossing the plane of triangle tri
//   E<edge>|<edge>         two input edges crossing (coplanar or touching triangles)
//   x<t1>,<t2>,<t3>        three triangles meeting in a point (two segments crossing inside a triangle)
import { sub3, cross3, dot3, norm3, len3, pointOf } from './meshkit.js';

/**
 * Shared state of one boolean run: soup S, planes, eps, the global point table.
 */
export class Arrangement {
  constructor(S, eps) {
    this.S = S; this.eps = eps;
    this.pts = new Map(); // key -> [x, y, z]
    this.planes = new Array(S.nt);
  }
  tp(t) { const { P, T } = this.S; return [pointOf(P, T[t * 3]), pointOf(P, T[t * 3 + 1]), pointOf(P, T[t * 3 + 2])]; }
  tid(t) { const T = this.S.T; return [T[t * 3], T[t * 3 + 1], T[t * 3 + 2]]; }
  plane(t) {
    let p = this.planes[t];
    if (!p) { const [a, b, c] = this.tp(t), n = norm3(cross3(sub3(b, a), sub3(c, a))); p = this.planes[t] = [n, dot3(n, a)]; }
    return p;
  }
  /** Signed distance of point id q to the plane of t, snapped to 0 within eps. */
  dist(q, t) { const [n, w] = this.plane(t), P = this.S.P; const s = n[0] * P[q * 3] + n[1] * P[q * 3 + 1] + n[2] * P[q * 3 + 2] - w; return Math.abs(s) <= this.eps ? 0 : s; }
  point(key, make) { let p = this.pts.get(key); if (!p) { p = make(); p.key = key; this.pts.set(key, p); } return p; }
  vtx(id) { return this.point(`v${id}`, () => pointOf(this.S.P, id)); }
  /** Crossing of edge a-b (point ids) with the plane of tri, computed in canonical order. */
  edgePlane(a, b, tri) {
    if (a > b) [a, b] = [b, a];
    return this.point(`e${a}_${b}f${tri}`, () => {
      const da = this.dist(a, tri), db = this.dist(b, tri), s = da / (da - db), P = this.S.P;
      return [P[a * 3] + (P[b * 3] - P[a * 3]) * s, P[a * 3 + 1] + (P[b * 3 + 1] - P[a * 3 + 1]) * s, P[a * 3 + 2] + (P[b * 3 + 2] - P[a * 3 + 2]) * s];
    });
  }
  /** Interval of triangle X on the plane of tri `other`: [] (none / a single touch), or two points. */
  interval(X, other) {
    const ids = this.tid(X), d = ids.map((q) => this.dist(q, other));
    const out = [];
    for (let k = 0; k < 3; k++) if (d[k] === 0) out.push({ p: this.vtx(ids[k]), edge: null, vert: ids[k] });
    for (let k = 0; k < 3; k++) {
      const j = (k + 1) % 3;
      if (d[k] * d[j] < 0) out.push({ p: this.edgePlane(ids[k], ids[j], other), edge: [Math.min(ids[k], ids[j]), Math.max(ids[k], ids[j])] });
    }
    return out.length === 2 ? out : [];
  }
}

const ekeyStr = (e) => `${e[0]}_${e[1]}`;
/** Distance from q to segment a-b and the parameter along it. */
function segDist(q, a, b) {
  const d = sub3(b, a), L2 = dot3(d, d) || 1e-300, t = dot3(sub3(q, a), d) / L2, tc = Math.max(0, Math.min(1, t));
  const f = [a[0] + d[0] * tc - q[0], a[1] + d[1] * tc - q[1], a[2] + d[2] * tc - q[2]];
  return [len3(f), t];
}

/**
 * Intersection segment of triangles t and u (non-coplanar), with canonical endpoint keys, or null.
 * Ties between the two intervals' endpoints are broken by a rule that does not depend on which
 * of the two triangles asks (vertex keys first, then the smaller key).
 */
export function triSegment(A, t, u) {
  const It = A.interval(t, u), Iu = A.interval(u, t);
  if (!It.length || !Iu.length) return null;
  const L = cross3(A.plane(t)[0], A.plane(u)[0]);
  if (len3(L) < 1e-12) return null;
  const s = (x) => dot3(x.p, L);
  const sortI = (I) => (s(I[0]) <= s(I[1]) ? I : [I[1], I[0]]);
  const [t0, t1] = sortI(It), [u0, u1] = sortI(Iu);
  const ll = len3(L);
  const pick = (x, y, lo) => {
    const dx = (s(x) - s(y)) / ll;
    if (Math.abs(dx) <= A.eps) return pref(x, y);
    return lo ? (dx > 0 ? x : y) : (dx < 0 ? x : y);
  };
  const lo = pick(t0, u0, true), hi = pick(t1, u1, false);
  if ((s(hi) - s(lo)) / ll <= A.eps) return null;
  return [canon(A, lo, t, u), canon(A, hi, t, u)];
}
const rank = (x) => (x.vert !== undefined ? 0 : 1);
function pref(x, y) {
  const rx = rank(x), ry = rank(y);
  if (rx !== ry) return rx < ry ? x : y;
  return x.p.key <= y.p.key ? x : y;
}
/** An edge x plane point that also lies on an edge of the other triangle is an edge x edge point. */
function canon(A, x, t, u) {
  if (!x.edge) return x.p;
  for (const tri of [t, u]) {
    const ids = A.tid(tri);
    for (let k = 0; k < 3; k++) {
      const e = [Math.min(ids[k], ids[(k + 1) % 3]), Math.max(ids[k], ids[(k + 1) % 3])];
      if (e[0] === x.edge[0] && e[1] === x.edge[1]) continue;
      const [d] = segDist(x.p, pointOf(A.S.P, e[0]), pointOf(A.S.P, e[1]));
      if (d <= A.eps) {
        const ks = [ekeyStr(x.edge), ekeyStr(e)].sort();
        return A.point(`E${ks[0]}|${ks[1]}`, () => x.p.slice());
      }
    }
  }
  return x.p;
}

// ---------- 2D helpers in the plane of triangle t ----------
function projector(n) {
  const ax = Math.abs(n[0]) >= Math.abs(n[1]) && Math.abs(n[0]) >= Math.abs(n[2]) ? 0 : Math.abs(n[1]) >= Math.abs(n[2]) ? 1 : 2;
  const [i, j] = ax === 0 ? [1, 2] : ax === 1 ? [2, 0] : [0, 1];
  const sg = n[ax] < 0 ? -1 : 1;
  return (p) => [p[i], p[j] * sg];
}
const area2 = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]);

/**
 * Coplanar u inside t's plane: u's edges clipped to t as segments (endpoints: u's vertices inside
 * t, edge x edge crossings). -> [[p, q]]
 */
export function coplanarSegments(A, t, u) {
  const pr = projector(A.plane(t)[0]), eps = A.eps;
  const ti = A.tid(t), ui = A.tid(u);
  const T2 = ti.map((i) => pr(pointOf(A.S.P, i)));
  const inside = (q) => { for (let k = 0; k < 3; k++) if (area2(T2[k], T2[(k + 1) % 3], q) < -eps * 1e-3) return false; return true; };
  const segs = [];
  for (let k = 0; k < 3; k++) {
    const a = ui[k], b = ui[(k + 1) % 3], pa = pointOf(A.S.P, a), pb = pointOf(A.S.P, b), a2 = pr(pa), b2 = pr(pb);
    const ue = [Math.min(a, b), Math.max(a, b)];
    // parameters where the edge enters / leaves t
    const pts = [];
    if (inside(a2)) pts.push([0, A.vtx(a)]);
    if (inside(b2)) pts.push([1, A.vtx(b)]);
    for (let m = 0; m < 3; m++) {
      const c = ti[m], d = ti[(m + 1) % 3], c2 = T2[m], d2 = T2[(m + 1) % 3];
      const te = [Math.min(c, d), Math.max(c, d)];
      if (te[0] === ue[0] && te[1] === ue[1]) continue;
      const den = (b2[0] - a2[0]) * (d2[1] - c2[1]) - (b2[1] - a2[1]) * (d2[0] - c2[0]);
      if (Math.abs(den) < 1e-18) continue;
      const s = ((c2[0] - a2[0]) * (d2[1] - c2[1]) - (c2[1] - a2[1]) * (d2[0] - c2[0])) / den;
      const r = ((c2[0] - a2[0]) * (b2[1] - a2[1]) - (c2[1] - a2[1]) * (b2[0] - a2[0])) / den;
      if (s <= 1e-12 || s >= 1 - 1e-12 || r <= 1e-12 || r >= 1 - 1e-12) continue;
      const ks = [ekeyStr(ue), ekeyStr(te)].sort();
      pts.push([s, A.point(`E${ks[0]}|${ks[1]}`, () => [pa[0] + (pb[0] - pa[0]) * s, pa[1] + (pb[1] - pa[1]) * s, pa[2] + (pb[2] - pa[2]) * s])]);
    }
    pts.sort((x, y) => x[0] - y[0]);
    for (let m = 0; m + 1 < pts.length; m++) {
      const mid = [(pts[m][1][0] + pts[m + 1][1][0]) / 2, (pts[m][1][1] + pts[m + 1][1][1]) / 2, (pts[m][1][2] + pts[m + 1][1][2]) / 2];
      if (pts[m][1] !== pts[m + 1][1] && inside(pr(mid))) segs.push([pts[m][1], pts[m + 1][1]]);
    }
  }
  return segs;
}

/** Point where the planes of three triangles meet (null if nearly parallel). */
function planes3(A, a, b, c) {
  const [n1, d1] = A.plane(a), [n2, d2] = A.plane(b), [n3, d3] = A.plane(c);
  const c23 = cross3(n2, n3), det = dot3(n1, c23);
  if (Math.abs(det) < 1e-9) return null;
  const c31 = cross3(n3, n1), c12 = cross3(n1, n2);
  return [0, 1, 2].map((k) => (d1 * c23[k] + d2 * c31[k] + d3 * c12[k]) / det);
}

/**
 * Split triangle t by its segments [[p, q, u]] (+ extra points on its edges, from neighbours)
 * into the faces of the planar graph. -> faces:
 * [{tris: [[p, q, r]] (3D point objects, t's orientation), inner: [x,y,z] (a point strictly inside)}]
 */
export function splitTriangle(A, t, segs, extra) {
  const eps = A.eps;
  const pr = projector(A.plane(t)[0]);
  const ti = A.tid(t), corners = ti.map((i) => A.vtx(i));
  // local points (dedupe by key, then by distance)
  const pts = [];
  const local = new Map();
  const add = (p) => {
    if (local.has(p.key)) return local.get(p.key);
    for (const q of pts) if (Math.abs(q.p[0] - p[0]) <= eps && Math.abs(q.p[1] - p[1]) <= eps && Math.abs(q.p[2] - p[2]) <= eps && len3(sub3(q.p, p)) <= eps) { local.set(p.key, q); return q; }
    const q = { p, d2: pr(p), i: pts.length };
    pts.push(q); local.set(p.key, q);
    return q;
  };
  corners.forEach(add);
  if (extra) extra.forEach(add);
  let S2 = segs.map(([p, q, u]) => [add(p), add(q), u]).filter(([a, b]) => a !== b);
  // segment x segment crossings (three triangles meeting)
  for (let i = 0; i < S2.length; i++) for (let j = i + 1; j < S2.length; j++) {
    const [a, b, u1] = S2[i], [c, d, u2] = S2[j];
    if (a === c || a === d || b === c || b === d || u1 === u2) continue;
    const A2 = a.d2, B2 = b.d2, C2 = c.d2, D2 = d.d2;
    const den = (B2[0] - A2[0]) * (D2[1] - C2[1]) - (B2[1] - A2[1]) * (D2[0] - C2[0]);
    if (Math.abs(den) < 1e-18) continue;
    const s = ((C2[0] - A2[0]) * (D2[1] - C2[1]) - (C2[1] - A2[1]) * (D2[0] - C2[0])) / den;
    const r = ((C2[0] - A2[0]) * (B2[1] - A2[1]) - (C2[1] - A2[1]) * (B2[0] - A2[0])) / den;
    if (s <= 1e-9 || s >= 1 - 1e-9 || r <= 1e-9 || r >= 1 - 1e-9) continue;
    const ids = [t, u1, u2].sort((x, y) => x - y);
    const p = A.point(`x${ids.join(',')}`, () => planes3(A, ids[0], ids[1], ids[2]) || [a.p[0] + (b.p[0] - a.p[0]) * s, a.p[1] + (b.p[1] - a.p[1]) * s, a.p[2] + (b.p[2] - a.p[2]) * s]);
    add(p);
  }
  // edges: boundary pieces + segment pieces, split at every local point lying on them
  const E = new Map();
  const addE = (a, b) => { if (a === b) return; const k = a.i < b.i ? `${a.i}_${b.i}` : `${b.i}_${a.i}`; if (!E.has(k)) E.set(k, [a, b]); };
  const splitAdd = (a, b) => {
    const on = [];
    for (const q of pts) { if (q === a || q === b) continue; const [d, s] = segDist(q.p, a.p, b.p); if (d <= eps && s > 0 && s < 1) on.push([s, q]); }
    on.sort((x, y) => x[0] - y[0]);
    let last = a;
    for (const [, q] of on) { addE(last, q); last = q; }
    addE(last, b);
  };
  const cq = corners.map((c) => local.get(c.key));
  for (let k = 0; k < 3; k++) splitAdd(cq[k], cq[(k + 1) % 3]);
  for (const [a, b] of S2) splitAdd(a, b);
  // adjacency, then drop dangling edges
  const adj = new Map(pts.map((q) => [q, new Set()]));
  for (const [a, b] of E.values()) { adj.get(a).add(b); adj.get(b).add(a); }
  let changed = true;
  while (changed) {
    changed = false;
    for (const [q, s] of adj) if (s.size === 1) { const [o] = s; adj.get(o).delete(q); s.clear(); changed = true; }
  }
  // faces: half-edge walk (face on the left, CCW)
  const out = new Map();
  for (const [q, s] of adj) out.set(q, [...s].sort((x, y) => Math.atan2(x.d2[1] - q.d2[1], x.d2[0] - q.d2[0]) - Math.atan2(y.d2[1] - q.d2[1], y.d2[0] - q.d2[0])));
  const used = new Set();
  const cycles = [];
  for (const [q, nbs] of out) for (const r of nbs) {
    const k0 = `${q.i}>${r.i}`;
    if (used.has(k0)) continue;
    const cyc = [];
    let a = q, b = r, guard = 0;
    while (guard++ < 100000) {
      const k = `${a.i}>${b.i}`;
      if (used.has(k)) break;
      used.add(k); cyc.push(a);
      const list = out.get(b), idx = list.indexOf(a);
      const c = list[(idx - 1 + list.length) % list.length];
      a = b; b = c;
    }
    let ar = 0;
    for (let k = 0; k < cyc.length; k++) { const p = cyc[k].d2, q2 = cyc[(k + 1) % cyc.length].d2; ar += p[0] * q2[1] - q2[0] * p[1]; }
    cycles.push({ cyc, area: ar / 2 });
  }
  const faces = cycles.filter((c) => c.area > 0);
  const holes = cycles.filter((c) => c.area < 0 && !c.cyc.some((q) => cq.includes(q)));
  for (const f of faces) f.holes = [];
  const pip = (q, cyc) => { let inside = false; for (let i = 0, j = cyc.length - 1; i < cyc.length; j = i++) { const a = cyc[i].d2, b = cyc[j].d2; if ((a[1] > q[1]) !== (b[1] > q[1]) && q[0] < ((b[0] - a[0]) * (q[1] - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside; } return inside; };
  for (const h of holes) {
    const probe = h.cyc[0].d2;
    let best = null;
    for (const f of faces) { if (f.cyc.some((q) => h.cyc.includes(q))) continue; if (pip(probe, f.cyc) && (!best || f.area < best.area)) best = f; }
    if (best) best.holes.push(h.cyc);
  }
  const res = [];
  for (const f of faces) {
    const tris = earcutHoles(f.cyc, f.holes, eps);
    if (!tris.length) continue;
    // interior probe: centroid of the largest triangle
    let bt = tris[0], ba = -1;
    for (const tr of tris) { const a2 = area2(tr[0].d2, tr[1].d2, tr[2].d2); if (a2 > ba) { ba = a2; bt = tr; } }
    const inner = [0, 1, 2].map((k) => (bt[0].p[k] + bt[1].p[k] + bt[2].p[k]) / 3);
    res.push({ tris: tris.map((tr) => tr.map((q) => q.p)), inner });
  }
  return res;
}

/**
 * Ear clipping of a CCW polygon of local points with CW holes (holes bridged to the outer ring
 * first). Zero-area ears are skipped, and an ear with another ring point within eps of it (points
 * on a split edge) is not cut; a stuck polygon falls back to a fan over its remaining non-degenerate triangles. -> [[a, b, c]]
 */
function earcutHoles(outer, holes, eps = 0) {
  let ring = outer.slice();
  const segsOf = () => { const s = []; for (const r of [ring, ...holes]) for (let i = 0; i < r.length; i++) s.push([r[i], r[(i + 1) % r.length]]); return s; };
  const cross = (a, b, c, d) => {
    if (a === c || a === d || b === c || b === d) return false;
    const o1 = area2(a.d2, b.d2, c.d2), o2 = area2(a.d2, b.d2, d.d2), o3 = area2(c.d2, d.d2, a.d2), o4 = area2(c.d2, d.d2, b.d2);
    return o1 * o2 < 0 && o3 * o4 < 0;
  };
  for (const h of [...holes].sort((x, y) => Math.max(...y.map((q) => q.d2[0])) - Math.max(...x.map((q) => q.d2[0])))) {
    const hi = h.reduce((m, q, i) => (q.d2[0] > h[m].d2[0] ? i : m), 0), hv = h[hi];
    const segs = segsOf();
    let best = -1, bd = Infinity;
    for (let i = 0; i < ring.length; i++) {
      const v = ring[i];
      const d = (v.d2[0] - hv.d2[0]) ** 2 + (v.d2[1] - hv.d2[1]) ** 2;
      if (d >= bd) continue;
      if (segs.some(([a, b]) => cross(hv, v, a, b))) continue;
      best = i; bd = d;
    }
    if (best < 0) continue;
    const hr = [...h.slice(hi), ...h.slice(0, hi)];
    ring = [...ring.slice(0, best + 1), ...hr, hv, ...ring.slice(best)];
  }
  const out = [];
  const idx = ring.slice();
  let guard = 0;
  // p inside or on the boundary of a-b-c (on = within eps of an edge: points on a split edge block the ear)
  const onL = (a, b, p) => area2(a, b, p) >= -eps * Math.hypot(b[0] - a[0], b[1] - a[1]);
  const inT = (p, a, b, c) => onL(a, b, p) && onL(b, c, p) && onL(c, a, p);
  while (idx.length > 3 && guard++ < 20000) {
    let cut = false;
    for (let i = 0; i < idx.length; i++) {
      const a = idx[(i - 1 + idx.length) % idx.length], b = idx[i], c = idx[(i + 1) % idx.length];
      const ar = area2(a.d2, b.d2, c.d2);
      if (ar <= 0) { if (ar === 0 && (a === c || collinearDrop(a, b, c))) { idx.splice(i, 1); cut = true; break; } continue; }
      let ok = true;
      for (const d of idx) { if (d === a || d === b || d === c) continue; if (d.p === a.p || d.p === b.p || d.p === c.p) continue; if (inT(d.d2, a.d2, b.d2, c.d2)) { ok = false; break; } }
      if (!ok) continue;
      out.push([a, b, c]); idx.splice(i, 1); cut = true; break;
    }
    if (!cut) {
      // degenerate leftovers (collinear runs): fan what has area
      for (let i = 1; i + 1 < idx.length; i++) if (area2(idx[0].d2, idx[i].d2, idx[i + 1].d2) > 0) out.push([idx[0], idx[i], idx[i + 1]]);
      return out;
    }
  }
  if (idx.length === 3 && area2(idx[0].d2, idx[1].d2, idx[2].d2) > 0) out.push([idx[0], idx[1], idx[2]]);
  return out;
}
/** b is a spike vertex of a collinear back-and-forth run (a, b, c on a line, b outside a-c). */
function collinearDrop(a, b, c) {
  const d1 = [b.d2[0] - a.d2[0], b.d2[1] - a.d2[1]], d2 = [c.d2[0] - b.d2[0], c.d2[1] - b.d2[1]];
  return d1[0] * d2[0] + d1[1] * d2[1] < 0;
}
