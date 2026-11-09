// Remeshing for art_model remesh: voxel (signed-distance voxelisation + dual contouring with sharp
// features) and quad-dominant retopology, plus the cleanup pass (meshkit cleanupMesh).
//
// voxel: inside/outside at every grid point from the winding number along grid-axis rays (all
//   three axes, majority vote), so non-manifold, open-ish and self-intersecting soups (kitbash
//   greeble piles) voxelise as their union. Critical (non well-composed) configurations are filled
//   so the dual surface is a closed 2-manifold. One vertex per surface cell placed by a QEF on the
//   ray hits (Hermite data: exact crossing points + face normals) -> sharp edges and corners
//   survive; sharp:false = surface nets (mass point). Flat regions are then collapsed (error <=
//   0.25 voxel, feature edges kept) and UVs / materials / colours are transferred back by
//   closest-point projection onto the source.
// quad: cleanup, feature-preserving simplification to ~2x the target face count, tangential
//   relaxation projected back onto the source, valence-improving edge flips, then greedy pairing of
//   triangles into quads (corner angles near 90 deg, planar, never across feature / material
//   edges). symmetry:"x"|"y"|"z" retopologises one half and mirrors it (seam welded).
import { Mesh } from './model3d.js';
import { soupOf, TriBVH, meshFromTris, attrsAt, pointOf, edgeMap, ekey, cleanupMesh, soupBounds, triNormal, sub3, cross3, dot3, norm3, len3, closestOnTri, hausdorff } from './meshkit.js';
import { simplifySoup } from './simplify.js';
import { manifoldStats } from './csg.js';

const GEO_TEX = { key: 'remesh:geo', name: 'remesh', width: 1, height: 1, data: Uint8ClampedArray.from([200, 200, 200, 255]) };

/** Plain geometry mesh (one group) from points + triangles. */
function geoMesh(V, F) {
  const m = new Mesh(), g = m.group(GEO_TEX);
  for (const [a, b, c] of F) {
    const p = [V[a], V[b], V[c]], n = norm3(cross3(sub3(p[1], p[0]), sub3(p[2], p[0]))), base = g.pos.length / 3, i0 = g.idx.length;
    for (const q of p) { g.pos.push(q[0], q[1], q[2]); g.nrm.push(n[0], n[1], n[2]); g.uv.push(0, 0); }
    g.idx.push(base, base + 1, base + 2);
    g.faces.push({ v: base, vc: 3, i: i0, ic: 3, n, mode: 0 });
  }
  return m;
}

/**
 * Transfer source attributes onto geometry triangles by closest-point projection: each triangle
 * takes the material + face record of the source triangle closest to its centroid, its corners
 * that triangle's affine UV / colour map; normals = the new geometry (flat).
 * tris: [[p, q, r]] -> meshFromTris records.
 */
export function transferAttributes(S, bvh, tris, { quadOf = null } = {}) {
  const recs = [];
  const quadSrc = new Map(), quadF = new Map();
  tris.forEach((p, i) => {
    let src;
    const qid = quadOf ? quadOf[i] : -1;
    if (qid >= 0 && quadSrc.has(qid)) src = quadSrc.get(qid);
    else {
      const c = qid >= 0 && quadOf.centers ? quadOf.centers[qid] : [0, 1, 2].map((k) => (p[0][k] + p[1][k] + p[2][k]) / 3);
      const r = bvh.closest(c);
      src = r ? r.tri : 0;
      if (qid >= 0) quadSrc.set(qid, src);
    }
    const at = p.map((q) => attrsAt(S, src, q));
    const n = norm3(cross3(sub3(p[1], p[0]), sub3(p[2], p[0])));
    let f = S.F[src];
    if (quadOf) { if (qid >= 0) { if (!quadF.has(qid)) quadF.set(qid, { ...f, quad: true }); f = quadF.get(qid); } else f = { ...f }; }
    const r = { p, uv: at.map((x) => x.uv), n: [n, n, n], g: S.G[src], f, ...(qid >= 0 ? { quad: true } : {}) };
    if (S.C) r.c = at.map((x) => x.c);
    if (S.SJ) { r.sj = at.map((x) => x.sj); r.sw = at.map((x) => x.sw); }
    recs.push(r);
  });
  return recs;
}

// ---------- voxel ----------
/**
 * Inside / outside at the points o + h * (i, j, k) of an n[0] x n[1] x n[2] grid: non-zero winding
 * number along grid-axis rays, majority of the three axes. -> {inside: Uint8Array, lines (per axis:
 * Map line -> sorted hits [coord, tri, sign]), count}
 */
export function windingOccupancy(S, bvh, o, h, n) {
  const cells = n[0] * n[1] * n[2];
  const I = (i, j, k) => (k * n[1] + j) * n[0] + i;
  const votes = new Uint8Array(cells);
  const lines = [new Map(), new Map(), new Map()];
  for (const [a, b, c] of [[0, 1, 2], [1, 2, 0], [2, 0, 1]]) {
    const d = [0, 0, 0]; d[a] = 1;
    for (let jb = 0; jb < n[b]; jb++) for (let jc = 0; jc < n[c]; jc++) {
      const org = [0, 0, 0]; org[a] = o[a] - h; org[b] = o[b] + jb * h; org[c] = o[c] + jc * h;
      const hits = [];
      bvh.ray(org, d, (n[a] + 2) * h, (t, tt) => { const nn = triNormal(S.P, S.T, t); hits.push([org[a] + tt, t, nn[a] > 0 ? 1 : nn[a] < 0 ? -1 : 0]); });
      if (!hits.length) continue;
      hits.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
      lines[a].set(jb * n[c] + jc, hits);
      let w = 0, q = 0;
      for (let ia = 0; ia < n[a]; ia++) {
        const x = o[a] + ia * h;
        while (q < hits.length && hits[q][0] < x) { w -= hits[q][2]; q++; }
        if (w !== 0) { const idx = [0, 0, 0]; idx[a] = ia; idx[b] = jb; idx[c] = jc; votes[I(idx[0], idx[1], idx[2])]++; }
      }
    }
  }
  const inside = new Uint8Array(cells);
  let count = 0;
  for (let i = 0; i < cells; i++) if (votes[i] >= 2) { inside[i] = 1; count++; }
  return { inside, lines, count };
}

/**
 * Voxel remesh. opts: {voxel (px) | resolution (cells on the longest side, default 64), sharp
 * (true), simplify (true: collapse flat regions, error <= 0.25 voxel), transfer (true), maxCells}.
 * -> {mesh, stats}
 */
export function voxelRemesh(mesh, opts = {}) {
  const t0 = performance.now();
  const S = soupOf(mesh);
  if (!S.nt) throw new Error('voxel remesh: the model has no triangles');
  const bb = soupBounds(S), ext = bb.max.map((v, k) => v - bb.min[k]);
  const longest = Math.max(...ext, 1e-6);
  const h = opts.voxel ? Number(opts.voxel) : longest / Math.max(4, Math.min(512, Math.round(Number(opts.resolution ?? 64))));
  if (!(h > 0)) throw new Error('voxel size must be > 0');
  // odd offset: grid lines dodge the axis-aligned edges kit pieces are made of
  const o = bb.min.map((v) => v - 1.5 * h + h * 0.1372);
  const n = ext.map((e) => Math.ceil((e + 3 * h) / h) + 1);
  const cells = n[0] * n[1] * n[2];
  if (cells > (opts.maxCells ?? 24e6)) throw new Error(`voxel grid ${n.join('x')} is too large (${cells} points); use a bigger voxel or a lower resolution`);
  const bvh = new TriBVH(S.P, S.T);
  const I = (i, j, k) => (k * n[1] + j) * n[0] + i;
  const axes = [[0, 1, 2], [1, 2, 0], [2, 0, 1]];
  const { inside, lines, count: inCount } = windingOccupancy(S, bvh, o, h, n);
  // well-composed: fill 2D checkerboards and 3D antipodal pairs until none are left
  let filled = 0;
  for (let pass = 0; pass < 32; pass++) {
    let ch = 0;
    const set = (i, j, k) => { const x = I(i, j, k); if (!inside[x]) { inside[x] = 1; ch++; } };
    for (let k = 0; k < n[2]; k++) for (let j = 0; j < n[1]; j++) for (let i = 0; i < n[0]; i++) {
      for (const [du, dv] of [[[1, 0, 0], [0, 1, 0]], [[0, 1, 0], [0, 0, 1]], [[0, 0, 1], [1, 0, 0]]]) {
        const i1 = i + du[0], j1 = j + du[1], k1 = k + du[2], i2 = i + dv[0], j2 = j + dv[1], k2 = k + dv[2], i3 = i + du[0] + dv[0], j3 = j + du[1] + dv[1], k3 = k + du[2] + dv[2];
        if (i3 >= n[0] || j3 >= n[1] || k3 >= n[2]) continue;
        const a0 = inside[I(i, j, k)], a1 = inside[I(i1, j1, k1)], a2 = inside[I(i2, j2, k2)], a3 = inside[I(i3, j3, k3)];
        if (a0 === a3 && a1 === a2 && a0 !== a1) { if (!a0) { set(i, j, k); set(i3, j3, k3); } else { set(i1, j1, k1); set(i2, j2, k2); } }
      }
      if (i + 1 < n[0] && j + 1 < n[1] && k + 1 < n[2]) {
        const v = [];
        for (let c = 0; c < 8; c++) v.push(inside[I(i + (c & 1), j + ((c >> 1) & 1), k + ((c >> 2) & 1))]);
        const s = v.reduce((x, y) => x + y, 0);
        if (s === 2 || s === 6) {
          const want = s === 2 ? 1 : 0;
          for (let c = 0; c < 4; c++) if (v[c] === want && v[7 - c] === want) { // antipodal pair
            if (s === 2) set(i + (((c + 1) & 1)), j + ((c >> 1) & 1), k + ((c >> 2) & 1));
            else set(i + (c & 1), j + ((c >> 1) & 1), k + ((c >> 2) & 1));
            break;
          }
        }
      }
    }
    filled += ch;
    if (!ch) break;
  }
  const tGrid = performance.now();
  // hermite: crossing on a grid edge (axis a from point idx to idx + 1 along a)
  const crossing = (a, idx) => {
    const [, b, c] = axes[a];
    const hits = lines[a].get(idx[b] * n[c] + idx[c]);
    const x0 = o[a] + idx[a] * h, x1 = x0 + h;
    if (hits) {
      let best = null;
      for (const ht of hits) if (ht[0] >= x0 && ht[0] <= x1 && (!best || Math.abs(ht[0] - (x0 + x1) / 2) < Math.abs(best[0] - (x0 + x1) / 2))) best = ht;
      if (best) { const p = [o[0] + idx[0] * h, o[1] + idx[1] * h, o[2] + idx[2] * h]; p[a] = best[0]; return [p, norm3(triNormal(S.P, S.T, best[1]))]; }
    }
    const m = [o[0] + idx[0] * h, o[1] + idx[1] * h, o[2] + idx[2] * h]; m[a] += h / 2;
    const r = bvh.closest(m);
    const p = r ? r.q.slice() : m;
    for (let k = 0; k < 3; k++) if (k !== a) p[k] = m[k];
    p[a] = Math.max(x0, Math.min(x1, p[a]));
    return [p, r ? norm3(triNormal(S.P, S.T, r.tri)) : [0, 0, 0]];
  };
  // cell vertices
  const V = [], cellV = new Map();
  const sharp = opts.sharp !== false;
  const cellVertex = (i, j, k) => {
    const key = I(i, j, k);
    if (cellV.has(key)) return cellV.get(key);
    const pts = [], nrms = [];
    for (let a = 0; a < 3; a++) {
      const [, b, c] = axes[a];
      for (let u = 0; u < 2; u++) for (let v = 0; v < 2; v++) {
        const idx = [i, j, k]; idx[b] += u; idx[c] += v;
        const e = [...idx]; e[a] += 1;
        if (inside[I(idx[0], idx[1], idx[2])] === inside[I(e[0], e[1], e[2])]) continue;
        const [p, nn] = crossing(a, idx);
        pts.push(p); nrms.push(nn);
      }
    }
    const mass = pts.reduce((s, p) => [s[0] + p[0] / pts.length, s[1] + p[1] / pts.length, s[2] + p[2] / pts.length], [0, 0, 0]);
    let x = mass;
    if (sharp && pts.length) {
      const lam = 0.05;
      const M = [lam, 0, 0, 0, lam, 0, 0, 0, lam], r = [lam * mass[0], lam * mass[1], lam * mass[2]];
      pts.forEach((p, q) => { const nn = nrms[q], d = dot3(nn, p); for (let a = 0; a < 3; a++) { for (let b = 0; b < 3; b++) M[a * 3 + b] += nn[a] * nn[b]; r[a] += nn[a] * d; } });
      const sol = solve3(M, r);
      if (sol) x = sol;
      const lo = [o[0] + i * h, o[1] + j * h, o[2] + k * h];
      x = x.map((v, a) => Math.max(lo[a], Math.min(lo[a] + h, v)));
    }
    V.push(x); cellV.set(key, V.length - 1);
    return V.length - 1;
  };
  const F = [];
  for (let k = 1; k < n[2] - 1; k++) for (let j = 1; j < n[1] - 1; j++) for (let i = 1; i < n[0] - 1; i++) {
    const here = inside[I(i, j, k)];
    for (let a = 0; a < 3; a++) {
      const e = [i, j, k]; e[a] += 1;
      if (e[a] >= n[a] - 1 && a >= 0 && e[a] >= n[a]) continue;
      if (e[0] >= n[0] || e[1] >= n[1] || e[2] >= n[2]) continue;
      const there = inside[I(e[0], e[1], e[2])];
      if (here === there) continue;
      const [, b, c] = axes[a];
      const cellAt = (db, dc) => { const q = [i, j, k]; q[b] += db; q[c] += dc; return cellVertex(q[0], q[1], q[2]); };
      let quad = [cellAt(-1, -1), cellAt(0, -1), cellAt(0, 0), cellAt(-1, 0)];
      if (!here) quad = quad.reverse();
      // diagonal: the split whose two triangle normals agree best
      const [q0, q1, q2, q3] = quad.map((x) => V[x]);
      const nA = cross3(sub3(q1, q0), sub3(q2, q0)), nB = cross3(sub3(q2, q0), sub3(q3, q0)), nC = cross3(sub3(q1, q0), sub3(q3, q0)), nD = cross3(sub3(q2, q1), sub3(q3, q1));
      const agree = (x, y) => dot3(x, y) / ((len3(x) * len3(y)) || 1);
      if (agree(nA, nB) >= agree(nC, nD)) { F.push([quad[0], quad[1], quad[2]], [quad[0], quad[2], quad[3]]); }
      else { F.push([quad[0], quad[1], quad[3]], [quad[1], quad[2], quad[3]]); }
    }
  }
  const tDC = performance.now();
  let geo = geoMesh(V, F.filter(([a, b, c]) => a !== b && b !== c && a !== c));
  const dcTris = geo.triangles;
  if (opts.simplify !== false) {
    const G = soupOf(geo);
    const r = simplifySoup(G, { maxError: Number(opts.max_error ?? 0.25 * h), featureAngle: Number(opts.feature_angle ?? 35), seams: false });
    geo = geoMesh(Array.from({ length: G.np }, (_, i) => pointOf(G.P, i)), r.tris.map((t) => t.p));
  }
  const tSimp = performance.now();
  let out = geo;
  if (opts.transfer !== false) {
    const G = soupOf(geo);
    const tris = [];
    for (let t = 0; t < G.nt; t++) tris.push([0, 1, 2].map((k) => pointOf(G.P, G.T[t * 3 + k])));
    out = meshFromTris(transferAttributes(S, bvh, tris), S.groups);
  }
  const t1 = performance.now();
  return {
    mesh: out,
    stats: { voxel_px: +h.toFixed(4), grid: n, inside_points: inCount, filled_critical: filled, dc_triangles: dcTris, triangles: out.triangles, source: S.nt, sharp,
      ms: { total: Math.round(t1 - t0), voxelise: Math.round(tGrid - t0), contour: Math.round(tDC - tGrid), simplify: Math.round(tSimp - tDC), transfer: Math.round(t1 - tSimp) } },
  };
}
function solve3(M, r) {
  const [a, b, c, d, e, f, g, h, i] = M;
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  if (Math.abs(det) < 1e-14) return null;
  return [
    (r[0] * (e * i - f * h) - b * (r[1] * i - f * r[2]) + c * (r[1] * h - e * r[2])) / det,
    (a * (r[1] * i - f * r[2]) - r[0] * (d * i - f * g) + c * (d * r[2] - r[1] * g)) / det,
    (a * (e * r[2] - r[1] * h) - b * (d * r[2] - r[1] * g) + r[0] * (d * h - e * g)) / det,
  ];
}

// ---------- quad retopology ----------
/** Keep the side of plane x[axis] >= at; crossing triangles are clipped (shared cut points). -> soup-like {V, F, src} */
function clipHalf(S, axis, at) {
  const V = [], map = new Map(), F = [], src = [];
  const vid = (i) => { const k = `v${i}`; if (!map.has(k)) { map.set(k, V.length); V.push(pointOf(S.P, i)); } return map.get(k); };
  const cutPt = (a, b) => {
    const k = a < b ? `e${a}_${b}` : `e${b}_${a}`;
    if (!map.has(k)) { const A = pointOf(S.P, Math.min(a, b)), B = pointOf(S.P, Math.max(a, b)), s = (at - A[axis]) / (B[axis] - A[axis]); const p = [0, 1, 2].map((c) => A[c] + (B[c] - A[c]) * s); p[axis] = at; map.set(k, V.length); V.push(p); }
    return map.get(k);
  };
  for (let t = 0; t < S.nt; t++) {
    const ids = [S.T[t * 3], S.T[t * 3 + 1], S.T[t * 3 + 2]], d = ids.map((i) => S.P[i * 3 + axis] - at);
    if (d.every((x) => x >= 0)) { F.push(ids.map(vid)); src.push(t); continue; }
    if (d.every((x) => x <= 0)) continue;
    const poly = [];
    for (let k = 0; k < 3; k++) {
      const j = (k + 1) % 3;
      if (d[k] >= 0) poly.push(vid(ids[k]));
      if ((d[k] > 0 && d[j] < 0) || (d[k] < 0 && d[j] > 0)) poly.push(cutPt(ids[k], ids[j]));
    }
    for (let k = 1; k + 1 < poly.length; k++) { F.push([poly[0], poly[k], poly[k + 1]]); src.push(t); }
  }
  return { V, F, src };
}

/**
 * Quad-dominant retopology. opts: {faces (target face count; default source / 4), feature_angle
 * (40), symmetry ("x"|"y"|"z" about the bounds centre, or {axis, at}), iterations (3)}.
 * -> {mesh (quads = face records of two triangles with quad:true), stats}
 */
export function quadRemesh(mesh, opts = {}) {
  const t0 = performance.now();
  const clean = cleanupMesh(mesh, { holes: 0 });
  const S = soupOf(clean.mesh);
  if (!S.nt) throw new Error('quad remesh: the model has no triangles');
  const srcBVH = new TriBVH(S.P, S.T);
  const featureAngle = Number(opts.feature_angle ?? 40);
  const sym = opts.symmetry ? (typeof opts.symmetry === 'string' ? { axis: opts.symmetry } : opts.symmetry) : null;
  let axis = -1, at = 0;
  if (sym) {
    axis = ['x', 'y', 'z'].indexOf(sym.axis);
    if (axis < 0) throw new Error('symmetry must be "x", "y", "z" or {axis, at}');
    const bb = soupBounds(S);
    at = sym.at !== undefined ? Number(sym.at) : (bb.min[axis] + bb.max[axis]) / 2;
  }
  // working geometry (one half when symmetric)
  let work;
  if (sym) { const h = clipHalf(S, axis, at); const m = new Mesh(); const tmp = geoMesh(h.V, h.F); m.add(tmp); work = soupOf(m); }
  else work = soupOf(geoMesh(Array.from({ length: S.np }, (_, i) => pointOf(S.P, i)), Array.from({ length: S.nt }, (_, t) => [S.T[t * 3], S.T[t * 3 + 1], S.T[t * 3 + 2]])));
  const wantFaces = Math.max(4, Math.round(Number(opts.faces ?? Math.max(8, S.nt / 4)) / (sym ? 2 : 1)));
  // 1. feature-preserving simplification to ~2 triangles per wanted quad
  const r = simplifySoup(work, { target: wantFaces * 2, featureAngle, seams: false, lockBorders: !!sym });
  let V = Array.from({ length: work.np }, (_, i) => pointOf(work.P, i));
  let F = r.tris.map((t) => t.p.slice());
  // compact
  { const used = new Map(), V2 = []; F = F.map((f) => f.map((i) => { if (!used.has(i)) { used.set(i, V2.length); V2.push(V[i]); } return used.get(i); })); V = V2; }
  const featureOf = () => {
    const E = new Map();
    F.forEach((f, fi) => { for (let k = 0; k < 3; k++) { const a = f[k], b = f[(k + 1) % 3], key = a < b ? `${a}_${b}` : `${b}_${a}`; if (!E.has(key)) E.set(key, []); E.get(key).push(fi); } });
    const fn = F.map((f) => norm3(cross3(sub3(V[f[1]], V[f[0]]), sub3(V[f[2]], V[f[0]]))));
    const cosF = Math.cos((featureAngle * Math.PI) / 180);
    const feat = new Set(), fixed = new Uint8Array(V.length);
    for (const [key, l] of E) {
      if (l.length !== 2 || dot3(fn[l[0]], fn[l[1]]) < cosF) { feat.add(key); const [a, b] = key.split('_').map(Number); fixed[a] = 1; fixed[b] = 1; }
    }
    return { E, fn, feat, fixed };
  };
  // 2. tangential relaxation projected onto the source
  const iters = Math.max(0, Math.min(10, Math.round(Number(opts.iterations ?? 3))));
  for (let it = 0; it < iters; it++) {
    const { fixed } = featureOf();
    const nb = V.map(() => new Set());
    for (const f of F) for (let k = 0; k < 3; k++) { nb[f[k]].add(f[(k + 1) % 3]); nb[f[k]].add(f[(k + 2) % 3]); }
    const inc = V.map(() => []);
    F.forEach((f, fi) => { for (const a of f) inc[a].push(fi); });
    for (let v = 0; v < V.length; v++) {
      if (fixed[v] || !nb[v].size) continue;
      const avg = [0, 0, 0];
      for (const w of nb[v]) for (let k = 0; k < 3; k++) avg[k] += V[w][k] / nb[v].size;
      const tgt = [0, 1, 2].map((k) => V[v][k] + (avg[k] - V[v][k]) * 0.5);
      const pr = srcBVH.closest(tgt);
      const np2 = pr ? pr.q : tgt;
      const before = inc[v].map((fi) => cross3(sub3(V[F[fi][1]], V[F[fi][0]]), sub3(V[F[fi][2]], V[F[fi][0]])));
      const old = V[v];
      V[v] = np2;
      const ok = inc[v].every((fi, q) => { const n1 = cross3(sub3(V[F[fi][1]], V[F[fi][0]]), sub3(V[F[fi][2]], V[F[fi][0]])); return dot3(n1, before[q]) > 0.2 * len3(n1) * len3(before[q]) && len3(n1) > 1e-9; });
      if (!ok) V[v] = old;
    }
  }
  // 3. valence-improving flips on flat interior edges
  let flips = 0;
  for (let pass = 0; pass < 3; pass++) {
    const { E, fn, feat } = featureOf();
    const val = new Int32Array(V.length);
    for (const key of E.keys()) { const [a, b] = key.split('_').map(Number); val[a]++; val[b]++; }
    const done = new Set();
    let ch = 0;
    for (const [key, l] of E) {
      if (l.length !== 2 || feat.has(key) || done.has(l[0]) || done.has(l[1])) continue;
      const [a, b] = key.split('_').map(Number), f1 = F[l[0]], f2 = F[l[1]];
      if (dot3(fn[l[0]], fn[l[1]]) < Math.cos((15 * Math.PI) / 180)) continue;
      const c = f1.find((x) => x !== a && x !== b), d = f2.find((x) => x !== a && x !== b);
      if (c === undefined || d === undefined || c === d) continue;
      if (E.has(c < d ? `${c}_${d}` : `${d}_${c}`)) continue;
      const dev = (x, t) => Math.abs(x - t);
      const before = dev(val[a], 6) + dev(val[b], 6) + dev(val[c], 6) + dev(val[d], 6);
      const after = dev(val[a] - 1, 6) + dev(val[b] - 1, 6) + dev(val[c] + 1, 6) + dev(val[d] + 1, 6);
      if (after >= before) continue;
      // keep orientation: f1 has a->b (or b->a); new triangles (c, d, ...) follow it
      const k1 = f1.indexOf(a), ab = f1[(k1 + 1) % 3] === b;
      const n1 = ab ? [c, a, d] : [c, d, a], n2 = ab ? [c, d, b] : [c, b, d];
      const nn1 = cross3(sub3(V[n1[1]], V[n1[0]]), sub3(V[n1[2]], V[n1[0]])), nn2 = cross3(sub3(V[n2[1]], V[n2[0]]), sub3(V[n2[2]], V[n2[0]]));
      if (dot3(nn1, fn[l[0]]) <= 0.3 * len3(nn1) || dot3(nn2, fn[l[0]]) <= 0.3 * len3(nn2)) continue;
      F[l[0]] = n1; F[l[1]] = n2; done.add(l[0]); done.add(l[1]);
      val[a]--; val[b]--; val[c]++; val[d]++;
      ch++;
    }
    flips += ch;
    if (!ch) break;
  }
  // 4. pair triangles into quads
  const { E, fn, feat } = featureOf();
  const cand = [];
  for (const [key, l] of E) {
    if (l.length !== 2 || feat.has(key)) continue;
    const [a, b] = key.split('_').map(Number), f1 = F[l[0]], f2 = F[l[1]];
    const c = f1.find((x) => x !== a && x !== b), d = f2.find((x) => x !== a && x !== b);
    // quad (a, d, b, c) or ordered from f1's winding
    const k1 = f1.indexOf(a), ab = f1[(k1 + 1) % 3] === b;
    const quad = ab ? [a, d, b, c] : [b, d, a, c];
    const P4 = quad.map((x) => V[x]);
    let worst = 0;
    for (let k = 0; k < 4; k++) {
      const p = P4[k], u = norm3(sub3(P4[(k + 3) % 4], p)), w = norm3(sub3(P4[(k + 1) % 4], p));
      const ang = (Math.acos(Math.max(-1, Math.min(1, dot3(u, w)))) * 180) / Math.PI;
      worst = Math.max(worst, Math.abs(ang - 90));
    }
    const q = (1 - worst / 90) * Math.max(0, dot3(fn[l[0]], fn[l[1]]));
    if (q > 0.35) cand.push([q, l[0], l[1], quad]);
  }
  cand.sort((x, y) => y[0] - x[0] || x[1] - y[1]);
  const paired = new Int32Array(F.length).fill(-1), quads = [];
  for (const [, f1, f2, quad] of cand) { if (paired[f1] >= 0 || paired[f2] >= 0) continue; paired[f1] = paired[f2] = quads.length; quads.push(quad); }
  // 5. emit (quads: two triangles in one face record), mirror the half when symmetric
  let tris = [], quadOf = [];
  const centers = quads.map((q) => [0, 1, 2].map((k) => (V[q[0]][k] + V[q[1]][k] + V[q[2]][k] + V[q[3]][k]) / 4));
  quads.forEach((q, qi) => { tris.push([V[q[0]], V[q[1]], V[q[2]]], [V[q[0]], V[q[2]], V[q[3]]]); quadOf.push(qi, qi); });
  F.forEach((f, fi) => { if (paired[fi] < 0) { tris.push(f.map((x) => V[x])); quadOf.push(-1); } });
  if (sym) {
    const mir = (p) => { const q = p.slice(); q[axis] = 2 * at - p[axis]; return q; };
    const nq = quads.length, n0 = tris.length;
    for (let i = 0; i < n0; i++) { const t = tris[i]; tris.push([mir(t[0]), mir(t[2]), mir(t[1])]); quadOf.push(quadOf[i] >= 0 ? quadOf[i] + nq : -1); }
    for (let i = 0; i < nq; i++) centers.push(mir(centers[i]));
  }
  quadOf.centers = centers;
  const out = meshFromTris(transferAttributes(S, srcBVH, tris, { quadOf }), S.groups);
  const nQuads = quads.length * (sym ? 2 : 1), nTris = tris.length - nQuads * 2;
  const vh = new Map();
  { const val = new Map(); for (const key of E.keys()) for (const x of key.split('_')) val.set(x, (val.get(x) || 0) + 1); for (const v of val.values()) vh.set(v, (vh.get(v) || 0) + 1); }
  const t1 = performance.now();
  return {
    mesh: out,
    stats: { quads: nQuads, triangles_left: nTris, faces: nQuads + nTris, quad_ratio: +(nQuads / Math.max(1, nQuads + nTris)).toFixed(3), source: mesh.triangles, feature_edges: feat.size, flips, symmetry: sym ? { axis: sym.axis, at } : null, valence: Object.fromEntries([...vh].sort((a, b) => a[0] - b[0])), cleanup: clean.report, ms: Math.round(t1 - t0) },
  };
}

/**
 * Close an open / non-manifold part so booleans (fracture, breaches) can cut it: the #19 cleanup
 * path first (weld + hole fill + winding), then a voxel remesh (fills any opening; textures are
 * transferred) when allowed. A result counts only when it is closed and has volume.
 * opts: {voxel?: true (allow the voxel fallback), resolution?: 48, minVolume?: px^3}.
 * -> {mesh, method: "cleanup"|"voxel", before: {open, nonManifold}, after: {open, nonManifold}, ms} | null
 */
export function closeOpenMesh(mesh, opts = {}) {
  const t0 = performance.now();
  const before = manifoldStats(mesh);
  const vol = (m) => { let v = 0; for (const g of m.groups.values()) { if (g.overlay) continue; for (let i = 0; i < g.idx.length; i += 3) { const a = g.idx[i] * 3, b = g.idx[i + 1] * 3, c = g.idx[i + 2] * 3; v += (g.pos[a] * (g.pos[b + 1] * g.pos[c + 2] - g.pos[b + 2] * g.pos[c + 1]) - g.pos[a + 1] * (g.pos[b] * g.pos[c + 2] - g.pos[b + 2] * g.pos[c]) + g.pos[a + 2] * (g.pos[b] * g.pos[c + 1] - g.pos[b + 1] * g.pos[c])) / 6; } } return v; };
  const minVol = opts.minVolume ?? (() => { const b = mesh.bounds(), e = b.max.map((x, k) => x - b.min[k]); return Math.max(1e-4, 1e-3 * e[0] * e[1] * e[2]); })();
  const ok = (m) => { const s = manifoldStats(m); return s.open === 0 && s.nonManifold === 0 && vol(m) > minVol ? s : null; };
  const tries = [['cleanup', () => cleanupMesh(mesh, { weld: 1e-3, holes: 64, winding: true }).mesh]];
  if (opts.voxel !== false) tries.push(['voxel', () => voxelRemesh(mesh, { resolution: opts.resolution ?? 48 }).mesh]);
  for (const [method, run] of tries) {
    let m;
    try { m = run(); } catch { continue; }
    const s = m && ok(m);
    if (s) return { mesh: m, method, before: { open: before.open, nonManifold: before.nonManifold }, after: { open: s.open, nonManifold: s.nonManifold }, ms: Math.round(performance.now() - t0) };
  }
  return null;
}

/** Cleanup as a remesh method (meshkit cleanupMesh). */
export function cleanupRemesh(mesh, opts = {}) {
  const r = cleanupMesh(mesh, { weld: Number(opts.weld ?? 1e-3), holes: Math.round(Number(opts.holes ?? 16)), winding: opts.winding !== false });
  return { mesh: r.mesh, stats: { ...r.report, triangles: r.mesh.triangles, source: mesh.triangles } };
}

export { hausdorff, closestOnTri, edgeMap, ekey };
