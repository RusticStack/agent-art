// Robust mesh booleans for large meshes (10k-200k+ triangles): BVH-accelerated triangle-pair
// intersection, local plane splitting, winding-number classification and a T-junction repair, so
// closed inputs give a closed, edge-manifold result. Used by csg.js booleanMesh above a size
// threshold (or method:"robust") and by art_model boolean (multi-part union of a whole ship into
// one shell, hidden interior faces removed).
//
// Method, per triangle t of solid i:
//  1. candidates = triangles of other solids whose boxes overlap t and whose vertices are not all
//     strictly on one side of t's plane (and vice versa) - filtered exact orientation (meshkit
//     orient3d) decides the near-coplanar cases
//  2. t is split by the plane of every candidate (coplanar candidates: by their three edge planes),
//     vertices within eps of a plane snap onto it, so no slivers are invented
//  3. every piece now lies wholly inside, outside or ON (coplanar with) each other solid; it is
//     classified by its centroid: non-zero winding number (majority of three skew rays through the
//     solid's BVH) or a coplanar containing candidate (same / opposite facing). Unsplit triangles
//     are classified once per connected region (flood fill), not one by one
//  4. keep rules per op; pieces of the cutter kept inside A are flipped (subtract)
//  5. T-junctions: every edge of the kept pieces is split at the new vertices lying on it, pieces
//     are triangulated without degenerate fans and points are welded (tolerance ~1e-6 of the size)
// Attributes: each output corner takes its source triangle's affine UV / normal / colour map
// (world-tiled pixel textures stay exact), skin = nearest source corner.
import { Mesh } from './model3d.js';
import { soupOf, TriBVH, edgeMap, ekey, meshFromTris, attrsAt, pointOf, orient3d, soupBounds, sub3, cross3, dot3, norm3, len3 } from './meshkit.js';
import { Arrangement, triSegment, coplanarSegments, splitTriangle } from './arrange.js';

const centroid = (poly) => { const c = [0, 0, 0]; for (const p of poly) { c[0] += p[0]; c[1] += p[1]; c[2] += p[2]; } return [c[0] / poly.length, c[1] / poly.length, c[2] / poly.length]; };

/**
 * Boolean engine on solids of one soup. solidOf: Int32Array tri -> solid id. keep(i, status) ->
 * 0 drop | 1 keep | -1 keep flipped, status = {inside: Set of solids containing the piece,
 * onSame: Set, onOpp: Set}. -> {tris (meshFromTris records), stats}
 */
function booleanSolids(S, solidOf, nSolids, keep, opts = {}) {
  const t0 = performance.now();
  const { P, T, nt, np } = S;
  const bb = soupBounds(S), diag = Math.max(bb.diag, 1e-6);
  const eps = opts.eps ?? diag * 1e-7, weldTol = opts.weld ?? Math.max(diag * 1e-7, eps);
  const bvh = new TriBVH(P, T);
  // per-solid BVH + bounds + closedness (inside tests are only meaningful for closed solids)
  const solidTris = Array.from({ length: nSolids }, () => []);
  for (let t = 0; t < nt; t++) solidTris[solidOf[t]].push(t);
  const solidB = solidTris.map((l) => { const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity]; for (const t of l) for (let k = 0; k < 3; k++) for (let c = 0; c < 3; c++) { const v = P[T[t * 3 + k] * 3 + c]; if (v < mn[c]) mn[c] = v; if (v > mx[c]) mx[c] = v; } return { min: mn, max: mx }; });
  const solidBVH = new Array(nSolids).fill(null);
  const bvhOf = (j) => solidBVH[j] || (solidBVH[j] = new TriBVH(P, T, solidTris[j]));
  const E = edgeMap(T, np);
  const closed = new Uint8Array(nSolids).fill(1);
  for (const l of E.values()) if (l.length === 1) closed[solidOf[l[0]]] = 0;
  const tp = (t) => [pointOf(P, T[t * 3]), pointOf(P, T[t * 3 + 1]), pointOf(P, T[t * 3 + 2])];
  const planeOf = (t) => { const [a, b, c] = tp(t), n = norm3(cross3(sub3(b, a), sub3(c, a))); return [n, dot3(n, a)]; };
  const planes = new Array(nt);
  const plane = (t) => planes[t] || (planes[t] = planeOf(t));
  const sideAll = (t, u) => {
    // all of u's vertices strictly on one side of t's plane? (exact orientation near the plane)
    const [a, b, c] = tp(t), [n, w] = plane(t);
    let pos = 0, neg = 0;
    for (const q of tp(u)) {
      const s = dot3(n, q) - w;
      // beyond eps: float sign; within eps: touching (snapped), or the exact sign when eps is 0
      const sg = s > eps ? 1 : s < -eps ? -1 : eps > 0 ? 0 : orient3d(a, b, c, q);
      if (sg > 0) pos++; else if (sg < 0) neg++;
    }
    return pos === 3 || neg === 3;
  };
  // 1. candidates
  const cand = new Array(nt).fill(null);
  let pairs = 0;
  const hits = [];
  for (let t = 0; t < nt; t++) {
    const [a, b, c] = tp(t);
    const mn = [0, 1, 2].map((k) => Math.min(a[k], b[k], c[k]) - eps), mx = [0, 1, 2].map((k) => Math.max(a[k], b[k], c[k]) + eps);
    hits.length = 0;
    bvh.overlap(mn, mx, hits);
    let list = null;
    for (const u of hits) {
      if (solidOf[u] === solidOf[t]) continue;
      if (sideAll(t, u) || sideAll(u, t)) continue;
      (list || (list = [])).push(u);
    }
    if (list) { list.sort((x, y) => x - y); cand[t] = list; pairs += list.length; }
  }
  const tCand = performance.now();
  // 2. arrangement: intersection segments with shared symbolic endpoints, cut triangles split into
  // the faces of their planar graph; 3. classify each face by an interior point
  const AR = new Arrangement(S, eps);
  const out = []; // {tris: [[p,q,r]], src, flip}
  const insideOf = (q, i) => {
    const r = new Set();
    for (let j = 0; j < nSolids; j++) {
      if (j === i || !closed[j]) continue;
      const B = solidB[j];
      if (q[0] < B.min[0] - eps || q[1] < B.min[1] - eps || q[2] < B.min[2] - eps || q[0] > B.max[0] + eps || q[1] > B.max[1] + eps || q[2] > B.max[2] + eps) continue;
      if (bvhOf(j).inside(q)) r.add(j);
    }
    return r;
  };
  const inTri = (q, u) => {
    const [a, b, c] = tp(u), [n] = plane(u);
    for (const [x, y] of [[a, b], [b, c], [c, a]]) if (dot3(cross3(sub3(y, x), sub3(q, x)), n) < -eps * len3(sub3(y, x))) return false;
    return true;
  };
  let splitTris = 0, pieces = 0, dropPieces = 0, dropTris = 0, dropArea = 0;
  const triArea = ([a, b, c]) => len3(cross3(sub3(b, a), sub3(c, a))) / 2;
  let totalArea = 0;
  for (let t = 0; t < nt; t++) totalArea += triArea(tp(t));
  const cut = new Uint8Array(nt);
  // pass 1: intersection segments per triangle; segment endpoints lying on a triangle edge are
  // shared with the triangle on the other side of that edge (no T-junctions when only one of
  // the two is crossed, e.g. an edge lying in the other solid's face)
  const segsOf = new Map(), coplOf = new Map(), edgeExtra = new Map();
  const ek = (a, b) => (a < b ? `${a}_${b}` : `${b}_${a}`);
  for (let t = 0; t < nt; t++) {
    if (!cand[t]) continue;
    const ids = AR.tid(t);
    const segs = [], copl = [];
    for (const u of cand[t]) {
      if (ids.every((q) => AR.dist(q, u) === 0)) { copl.push(u); for (const sg of coplanarSegments(AR, t, u)) segs.push([sg[0], sg[1], u]); continue; }
      const sg = triSegment(AR, t, u);
      if (sg) segs.push([sg[0], sg[1], u]);
    }
    if (!segs.length && !copl.length) continue;
    segsOf.set(t, segs); coplOf.set(t, copl);
    const cs = tp(t);
    for (const sg of segs) for (const p of [sg[0], sg[1]]) for (let k = 0; k < 3; k++) {
      const x = cs[k], y = cs[(k + 1) % 3], d = sub3(y, x), L2 = dot3(d, d);
      const s = dot3(sub3(p, x), d) / L2;
      if (!(s > 0 && s < 1)) continue;
      const f = sub3(p, [x[0] + d[0] * s, x[1] + d[1] * s, x[2] + d[2] * s]);
      if (len3(f) > eps) continue;
      const key = ek(ids[k], ids[(k + 1) % 3]);
      if (!edgeExtra.has(key)) edgeExtra.set(key, new Map());
      edgeExtra.get(key).set(p.key, p);
    }
  }
  const work = new Set(segsOf.keys());
  const extraOf = new Map();
  if (edgeExtra.size) for (let t = 0; t < nt; t++) {
    const ids = AR.tid(t), ex = [];
    for (let k = 0; k < 3; k++) { const m = edgeExtra.get(ek(ids[k], ids[(k + 1) % 3])); if (m) ex.push(...m.values()); }
    if (ex.length) { extraOf.set(t, ex); work.add(t); }
  }
  for (const t of [...work].sort((x, y) => x - y)) {
    const i = solidOf[t], [nt0] = plane(t);
    const segs = segsOf.get(t) || [], copl = coplOf.get(t) || [];
    cut[t] = 1; splitTris++;
    const faces = splitTriangle(AR, t, segs, extraOf.get(t));
    for (const f of faces) {
      const q = f.inner;
      const st = { inside: insideOf(q, i), onSame: new Set(), onOpp: new Set() };
      for (const u of copl) if (inTri(q, u)) { const j = solidOf[u]; if (dot3(plane(u)[0], nt0) > 0) st.onSame.add(j); else st.onOpp.add(j); st.inside.delete(j); }
      const k = keep(i, st);
      pieces++;
      if (k) out.push({ tris: f.tris, src: t, flip: k < 0 });
      else { dropPieces++; for (const tr of f.tris) dropArea += triArea(tr); }
    }
  }
  const tSplit = performance.now();
  // uncut triangles: classify connected regions (same solid, nothing cut)
  const region = new Int32Array(nt).fill(-1);
  let regions = 0;
  const whole = (t) => AR.tid(t).map((q) => AR.vtx(q));
  for (let s0 = 0; s0 < nt; s0++) {
    if (cut[s0] || region[s0] >= 0) continue;
    const i = solidOf[s0], st = { inside: insideOf(centroid(tp(s0)), i), onSame: new Set(), onOpp: new Set() };
    const k = keep(i, st);
    const stack = [s0];
    region[s0] = regions;
    while (stack.length) {
      const t = stack.pop();
      if (k) out.push({ tris: [whole(t)], src: t, flip: k < 0 });
      else { dropTris++; dropArea += triArea(tp(t)); }
      for (let e = 0; e < 3; e++) {
        const l = E.get(ekey(T[t * 3 + e], T[t * 3 + ((e + 1) % 3)], np));
        for (const o of l) if (o !== t && region[o] < 0 && !cut[o] && solidOf[o] === i) { region[o] = regions; stack.push(o); }
      }
    }
    regions++;
  }
  const tClass = performance.now();
  // weld near-duplicate keys (touching configurations computed two ways), drop degenerates
  const snap = new Map();
  const W = (p) => {
    if (p.w) return p.w;
    const c = [Math.floor(p[0] / weldTol), Math.floor(p[1] / weldTol), Math.floor(p[2] / weldTol)];
    let best = null, bd = weldTol * weldTol;
    for (let x = -1; x <= 1; x++) for (let y = -1; y <= 1; y++) for (let z = -1; z <= 1; z++) {
      const l = snap.get(`${c[0] + x},${c[1] + y},${c[2] + z}`);
      if (l) for (const q of l) { const d = (q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2 + (q[2] - p[2]) ** 2; if (d <= bd) { bd = d; best = q; } }
    }
    if (!best) { best = [p[0], p[1], p[2]]; const k = c.join(','); const l = snap.get(k); if (l) l.push(best); else snap.set(k, [best]); }
    p.w = best;
    return best;
  };
  const tris = [];
  let dropped = 0;
  for (const o of out) for (const f0 of o.tris) {
    const f = f0.map(W);
    if (f[0] === f[1] || f[1] === f[2] || f[0] === f[2]) { dropped++; continue; }
    const p = o.flip ? [f[0], f[2], f[1]] : f;
    const at = p.map((q) => attrsAt(S, o.src, q));
    const r = { p, uv: at.map((x) => x.uv), n: at.map((x) => (o.flip ? x.n.map((v) => -v) : x.n)), g: S.G[o.src], f: S.F[o.src] };
    if (S.C) r.c = at.map((x) => x.c);
    if (S.SJ) { r.sj = at.map((x) => x.sj); r.sw = at.map((x) => x.sw); }
    tris.push(r);
  }
  const t1 = performance.now();
  return {
    tris,
    stats: { input: nt, output: tris.length, solids: nSolids, open_solids: closed.reduce((s, c) => s + (c ? 0 : 1), 0), candidate_pairs: pairs, split_triangles: splitTris, pieces, discarded: { triangles: dropTris, pieces: dropPieces, area_ratio: +(dropArea / (totalArea || 1)).toFixed(4) }, regions, dropped_slivers: dropped, points: AR.pts.size, exact_predicates: orient3d.exact,
      ms: { total: Math.round(t1 - t0), candidates: Math.round(tCand - t0), split: Math.round(tSplit - tCand), classify: Math.round(tClass - tSplit), stitch: Math.round(t1 - tClass) } },
  };
}

const tagged = (mesh, solid) => { const m = mesh.clone(); for (const g of m.groups.values()) if (g.faces) for (const f of g.faces) f._solid = solid; return m; };

/**
 * Robust boolean of two meshes: op "union" | "subtract" (A - B) | "intersect". Each operand is
 * one solid (non-zero winding over all of its triangles, so overlapping pieces inside an operand
 * are fine). Overlay shells of A ride along. -> {mesh, stats}
 */
export function robustBoolean(op, A, B, opts = {}) {
  if (!['subtract', 'union', 'intersect'].includes(op)) throw new Error(`boolean must be "subtract", "union" or "intersect" (got ${JSON.stringify(op)})`);
  const M = tagged(A, 0).add(tagged(B, 1));
  const S = soupOf(M);
  const solidOf = Int32Array.from(S.F, (f) => f._solid);
  const keep = (i, st) => {
    const j = 1 - i, inn = st.inside.has(j), same = st.onSame.has(j), opp = st.onOpp.has(j);
    if (op === 'union') return opp || inn ? 0 : same ? (i === 0 ? 1 : 0) : 1;
    if (op === 'intersect') return opp ? 0 : same ? (i === 0 ? 1 : 0) : inn ? 1 : 0;
    // subtract
    if (i === 0) return same || inn ? 0 : 1;
    return same || opp ? 0 : inn ? -1 : 0;
  };
  const r = booleanSolids(S, solidOf, 2, keep, opts);
  const out = meshFromTris(r.tris, S.groups);
  for (const g of A.groups.values()) if (g.overlay) out.add({ groups: new Map([[g.tex.key, g]]) });
  return { mesh: out, stats: { op, ...r.stats } };
}

/**
 * Union of every closed shell of a mesh (or a list of meshes) into one outer shell: shells are the
 * edge-connected pieces (each part, plate, pod, greeble), faces inside any other shell and
 * touching opposite faces are removed, coincident same-facing faces are kept once.
 * -> {mesh, stats}
 */
export function unionAll(input, opts = {}) {
  const M = Array.isArray(input) ? input.reduce((acc, m, i) => acc.add(tagged(m, i)), new Mesh()) : input.clone();
  const S = soupOf(M);
  const { T, np, nt } = S;
  // shells: triangles joined across 2-triangle edges only (touching pieces stay separate solids)
  const E = edgeMap(T, np);
  const par = Int32Array.from({ length: nt }, (_, i) => i);
  const find = (x) => { while (par[x] !== x) { par[x] = par[par[x]]; x = par[x]; } return x; };
  for (const l of E.values()) if (l.length === 2) { const a = find(l[0]), b = find(l[1]); if (a !== b) par[Math.max(a, b)] = Math.min(a, b); }
  const id = new Map(), solidOf = new Int32Array(nt);
  for (let t = 0; t < nt; t++) { const r = find(t); if (!id.has(r)) id.set(r, id.size); solidOf[t] = id.get(r); }
  const keep = (i, st) => {
    if (st.inside.size || st.onOpp.size) return 0;
    for (const j of st.onSame) if (j < i) return 0;
    return 1;
  };
  const r = booleanSolids(S, solidOf, id.size, keep, opts);
  const out = meshFromTris(r.tris, S.groups);
  return { mesh: out, stats: { op: 'union_all', removed_triangles: r.stats.discarded.triangles + r.stats.discarded.pieces, ...r.stats } };
}

/** Triangles of a Mesh (base groups). */
export const meshTris = (m) => { let n = 0; for (const g of m.groups.values()) if (!g.overlay) n += g.idx.length / 3; return n; };
