// LOD simplification for art_model exports: quadric-error (Garland-Heckbert) HALF-EDGE collapses
// (a vertex moves onto an existing neighbour, so no new positions are invented), on position-welded
// connectivity across all materials. Texture-preserving: every triangle keeps its own corner UVs
// and normals, and a corner that moves gets the value of that triangle's own affine UV / normal
// map at the new position (exact on flat regions, so pixel textures do not swim or stretch).
// Constraints: open borders and material borders only slide along themselves (no texture bleed),
// link condition (stays manifold), no flipped or collapsed triangles. Greeble faces are dropped
// from their drop level; overlay shells are dropped from LOD 1.
import { Mesh } from './model3d.js';
import { mergeMesh } from './csg.js';

const qkey = (x, y, z) => `${Math.round(x * 1e4)},${Math.round(y * 1e4)},${Math.round(z * 1e4)}`;

class Heap {
  constructor() { this.c = []; this.u = []; this.v = []; this.s = []; }
  get size() { return this.c.length; }
  push(c, u, v, s) {
    const { c: C, u: U, v: V, s: S } = this;
    let i = C.length; C.push(c); U.push(u); V.push(v); S.push(s);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (C[p] < C[i] || (C[p] === C[i] && (U[p] < U[i] || (U[p] === U[i] && V[p] <= V[i])))) break;
      this.sw(i, p); i = p;
    }
  }
  sw(a, b) { for (const A of [this.c, this.u, this.v, this.s]) { const t = A[a]; A[a] = A[b]; A[b] = t; } }
  pop() {
    const { c: C, u: U, v: V } = this;
    const top = [C[0], U[0], V[0], this.s[0]];
    const last = C.length - 1;
    if (last > 0) { this.sw(0, last); }
    C.pop(); U.pop(); V.pop(); this.s.pop();
    let i = 0;
    for (;;) {
      const l = 2 * i + 1, r = l + 1;
      let m = i;
      const less = (a, b) => C[a] < C[b] || (C[a] === C[b] && (U[a] < U[b] || (U[a] === U[b] && V[a] < V[b])));
      if (l < C.length && less(l, m)) m = l;
      if (r < C.length && less(r, m)) m = r;
      if (m === i) break;
      this.sw(i, m); i = m;
    }
    return top;
  }
}

/**
 * Simplify a final (baked) mesh to about `ratio` of its triangles. opts: {ratio, level (for greeble
 * drop), max_error px (stop early), keepOverlays}. -> {mesh, triangles, source, error (px, max
 * collapse error incl. dropped greebles), dropped_greebles}
 */
export function simplifyMesh(src0, { ratio = 0.5, level = 1, maxError = Infinity, keepOverlays = false } = {}) {
  // hidden faces pressed together (abutting kit pieces) would pin every seam: drop them first
  const src = mergeMesh(src0.clone(), { weld: 0, internal: true }).mesh;
  const groups = [...src.groups.values()];
  const P = [], pid = new Map();
  const point = (x, y, z) => { const k = qkey(x, y, z); let i = pid.get(k); if (i === undefined) { i = P.length / 3; pid.set(k, i); P.push(x, y, z); } return i; };
  const T = []; // {p:[a,b,c], g, uv:[[u,v]x3], n:[[x,y,z]x3], f, alive}
  let dropErr = 0, droppedG = 0, total = 0;
  const out = new Mesh();
  groups.forEach((g, gi) => {
    if (g.overlay) {
      if (keepOverlays) out.add({ groups: new Map([[g.tex.key, g]]) });
      return;
    }
    for (const f of g.faces) {
      const drop = f.greeble !== undefined && level >= f.greeble;
      for (let i = f.i; i < f.i + f.ic; i += 3) {
        total++;
        if (drop) { droppedG++; continue; }
        const vs = [g.idx[i], g.idx[i + 1], g.idx[i + 2]];
        const p = vs.map((v) => point(g.pos[v * 3], g.pos[v * 3 + 1], g.pos[v * 3 + 2]));
        if (p[0] === p[1] || p[1] === p[2] || p[0] === p[2]) continue;
        T.push({ p, g: gi, uv: vs.map((v) => [g.uv[v * 2], g.uv[v * 2 + 1]]), n: vs.map((v) => [g.nrm[v * 3], g.nrm[v * 3 + 1], g.nrm[v * 3 + 2]]), f, alive: true });
      }
      if (drop) dropErr = Math.max(dropErr, f.gh ?? 0);
    }
  });
  const np = P.length / 3;
  const pos = (i) => [P[i * 3], P[i * 3 + 1], P[i * 3 + 2]];
  const inc = Array.from({ length: np }, () => []);
  T.forEach((t, ti) => { for (const a of t.p) inc[a].push(ti); });
  const Q = new Float64Array(np * 10);
  const addPlane = (i, n, d, w) => {
    const [a, b, c] = n, q = [a * a, a * b, a * c, a * d, b * b, b * c, b * d, c * c, c * d, d * d];
    for (let k = 0; k < 10; k++) Q[i * 10 + k] += q[k] * w;
  };
  const triN = (A, B, C) => { const u = [B[0] - A[0], B[1] - A[1], B[2] - A[2]], v = [C[0] - A[0], C[1] - A[1], C[2] - A[2]]; return [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]; };
  for (const t of T) {
    const [A, B, C] = t.p.map(pos), n = triN(A, B, C), l = Math.hypot(...n);
    if (l < 1e-12) continue;
    const nn = n.map((x) => x / l), d = -(nn[0] * A[0] + nn[1] * A[1] + nn[2] * A[2]);
    for (const a of t.p) addPlane(a, nn, d, 1);
  }
  // edges: open borders and material borders get perpendicular constraint planes
  const edges = new Map();
  T.forEach((t, ti) => { for (let k = 0; k < 3; k++) { const a = t.p[k], b = t.p[(k + 1) % 3], key = a < b ? a * np + b : b * np + a; if (!edges.has(key)) edges.set(key, []); edges.get(key).push(ti); } });
  const border = new Uint8Array(np);
  const isBorderEdge = (list) => list.length !== 2 || T[list[0]].g !== T[list[1]].g;
  for (const [key, list] of edges) {
    if (!isBorderEdge(list)) continue;
    const a = Math.floor(key / np), b = key % np;
    border[a] = 1; border[b] = 1;
    for (const ti of list) {
      const t = T[ti], [A, B, C] = t.p.map(pos), n = triN(A, B, C), l = Math.hypot(...n);
      if (l < 1e-12) continue;
      const PA = pos(a), PB = pos(b), e = [PB[0] - PA[0], PB[1] - PA[1], PB[2] - PA[2]];
      let m = [e[1] * n[2] - e[2] * n[1], e[2] * n[0] - e[0] * n[2], e[0] * n[1] - e[1] * n[0]];
      const ml = Math.hypot(...m);
      if (ml < 1e-12) continue;
      m = m.map((x) => x / ml);
      const d = -(m[0] * PA[0] + m[1] * PA[1] + m[2] * PA[2]);
      addPlane(a, m, d, 4); addPlane(b, m, d, 4);
    }
  }
  const evalQ = (i, j, p) => {
    const [x, y, z] = p;
    let s = 0;
    for (const o of [i * 10, j * 10]) {
      const q = Q;
      s += q[o] * x * x + 2 * q[o + 1] * x * y + 2 * q[o + 2] * x * z + 2 * q[o + 3] * x + q[o + 4] * y * y + 2 * q[o + 5] * y * z + 2 * q[o + 6] * y + q[o + 7] * z * z + 2 * q[o + 8] * z + q[o + 9];
    }
    return Math.max(0, s);
  };
  const live = (i) => { inc[i] = inc[i].filter((ti) => T[ti].alive); return inc[i]; };
  const groupsAt = (i) => new Set(live(i).map((ti) => T[ti].g));
  const ver = new Uint32Array(np);
  const heap = new Heap();
  const pushEdge = (u, v) => heap.push(evalQ(u, v, pos(v)), u, v, ver[u] * 65536 + (ver[v] & 0xffff));
  for (const key of edges.keys()) { const a = Math.floor(key / np), b = key % np; pushEdge(a, b); pushEdge(b, a); }
  let alive = T.length;
  // the ratio is of the source triangles (before hidden faces and greebles are dropped)
  let srcTotal = 0;
  for (const g of src0.groups.values()) if (!g.overlay) srcTotal += g.idx.length / 3;
  const target = Math.max(4, Math.floor(srcTotal * ratio));
  let maxErr = 0;
  const edgeTris = (u, v) => live(u).filter((ti) => T[ti].p.includes(v));
  while (alive > target && heap.size) {
    const [cost, u, v, s] = heap.pop();
    if (s !== ver[u] * 65536 + (ver[v] & 0xffff)) continue;
    if (Math.sqrt(cost) > maxError) break;
    const tu = live(u);
    if (!tu.length) continue;
    const shared = edgeTris(u, v);
    if (!shared.length) continue;
    // borders slide only along a border edge onto a border point; material sets must be kept
    if (border[u]) {
      if (!border[v]) continue;
      const el = edges.get(u < v ? u * np + v : v * np + u)?.filter((ti) => T[ti].alive) || [];
      if (!isBorderEdge(el)) continue;
      const gu = groupsAt(u), gv = groupsAt(v);
      let ok = true;
      for (const g of gu) if (!gv.has(g)) ok = false;
      if (!ok) continue;
    }
    // link condition: the common neighbours of u and v are exactly the opposite corners of the edge's triangles
    const nb = (i) => { const s2 = new Set(); for (const ti of live(i)) for (const p of T[ti].p) if (p !== i) s2.add(p); return s2; };
    const nu = nb(u), nv = nb(v);
    let common = 0;
    for (const w of nu) if (nv.has(w)) common++;
    if (common > shared.length) continue;
    // no flips / slivers on the triangles that move
    const PV = pos(v);
    let bad = false;
    for (const ti of tu) {
      const t = T[ti];
      if (t.p.includes(v)) continue;
      const before = t.p.map(pos), after = t.p.map((p) => (p === u ? PV : pos(p)));
      const n0 = triN(...before), n1 = triN(...after), l0 = Math.hypot(...n0), l1 = Math.hypot(...n1);
      if (l1 < 1e-9 * Math.max(1, l0) || (n0[0] * n1[0] + n0[1] * n1[1] + n0[2] * n1[2]) / (l0 * l1) < 0.3) { bad = true; break; }
    }
    if (bad) continue;
    // collapse u -> v
    for (const ti of tu) {
      const t = T[ti];
      if (t.p.includes(v)) { t.alive = false; alive--; continue; }
      const k = t.p.indexOf(u);
      // corner attributes: the triangle's own affine maps evaluated at v (projected on its plane)
      const [A, B, C] = t.p.map(pos), n = triN(A, B, C), nl = n[0] * n[0] + n[1] * n[1] + n[2] * n[2];
      const bary = (q) => {
        const w = [0, 1, 2].map((m) => { const X = [A, B, C][(m + 1) % 3], Y = [A, B, C][(m + 2) % 3], c = triN(q, X, Y); return (c[0] * n[0] + c[1] * n[1] + c[2] * n[2]) / nl; });
        return w;
      };
      const w = bary(PV);
      t.uv[k] = [0, 1].map((c) => w[0] * t.uv[0][c] + w[1] * t.uv[1][c] + w[2] * t.uv[2][c]);
      const nn = [0, 1, 2].map((c) => w[0] * t.n[0][c] + w[1] * t.n[1][c] + w[2] * t.n[2][c]), nnl = Math.hypot(...nn) || 1;
      t.n[k] = nn.map((x) => x / nnl);
      t.p[k] = v;
      inc[v].push(ti);
    }
    for (let k = 0; k < 10; k++) Q[v * 10 + k] += Q[u * 10 + k];
    if (border[u]) border[v] = 1;
    inc[u] = [];
    ver[u]++; ver[v]++;
    maxErr = Math.max(maxErr, Math.sqrt(cost));
    // only edges touching v change cost (Q_v grew); stale entries of u and v fail their stamp
    for (const w of nb(v)) { pushEdge(v, w); pushEdge(w, v); }
  }
  // emit: one face record per surviving triangle (UV mode 0: the UVs are final)
  for (const t of T) {
    if (!t.alive) continue;
    const g = groups[t.g], og = out.group(g.tex), base = og.pos.length / 3, i0 = og.idx.length;
    for (let k = 0; k < 3; k++) { const p = pos(t.p[k]); og.pos.push(p[0], p[1], p[2]); og.nrm.push(...t.n[k]); og.uv.push(...t.uv[k]); }
    og.idx.push(base, base + 1, base + 2);
    const n = triN(...t.p.map(pos)), l = Math.hypot(...n) || 1;
    const rec = { v: base, vc: 3, i: i0, ic: 3, n: n.map((x) => x / l), mode: 0 };
    for (const key of ['pid', 'tag', 'mat', 'node', 'cs', 'rs']) if (t.f[key] !== undefined) rec[key] = t.f[key];
    og.faces.push(rec);
  }
  return { mesh: out, triangles: out.triangles, source: srcTotal, error: Math.max(maxErr, dropErr), dropped_greebles: droppedG };
}

/** Distance (units) at which a geometric error (units) projects to `px` screen pixels. */
export function switchDistance(errUnits, { height = 720, fov = 70, px = 1 } = {}) {
  return (errUnits * height) / (2 * Math.tan((fov * Math.PI) / 360) * px);
}
