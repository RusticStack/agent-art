// Attribute-aware, error-bounded mesh simplification (the engine behind art_model decimate, cluster
// LOD group simplification and quad retopo). Quadric-error (Garland-Heckbert) HALF-EDGE collapses on
// position-welded connectivity: vertices only ever move onto existing neighbours, so every output
// vertex is an input vertex (cluster borders stay bit-identical between levels).
//  - corner attributes (UV, normal, vertex colour) are re-evaluated with each triangle's own affine
//    map; skin joints / weights are taken from the target vertex (never blended across joints)
//  - constrained edges: open borders, material borders, UV / normal / colour / skin seams and
//    feature edges (dihedral > feature_angle) only slide along themselves; points where 1 or >= 3
//    constrained edges meet are corners and never move; locked points (cluster group borders) never move
//  - error bound: every triangle carries sample points of the original surface (centroids, edge
//    midpoints, collapsed vertices); a collapse is rejected when any affected sample would end up
//    farther than max_error from the new triangles, so the one-sided distance original -> result is
//    bounded (and measured) by construction
//  - link condition (stays manifold), no flipped / collapsed triangles
import { soupOf, meshFromTris, pointOf, closestOnTri, ekey } from './meshkit.js';

class Heap {
  constructor() { this.c = []; this.u = []; this.v = []; this.su = []; this.sv = []; }
  get size() { return this.c.length; }
  less(a, b) { const C = this.c; return C[a] < C[b] || (C[a] === C[b] && (this.u[a] < this.u[b] || (this.u[a] === this.u[b] && this.v[a] < this.v[b]))); }
  sw(a, b) { for (const A of [this.c, this.u, this.v, this.su, this.sv]) { const t = A[a]; A[a] = A[b]; A[b] = t; } }
  push(c, u, v, su, sv) {
    this.c.push(c); this.u.push(u); this.v.push(v); this.su.push(su); this.sv.push(sv);
    let i = this.c.length - 1;
    while (i > 0) { const p = (i - 1) >> 1; if (!this.less(i, p)) break; this.sw(i, p); i = p; }
  }
  pop() {
    const top = [this.c[0], this.u[0], this.v[0], this.su[0], this.sv[0]];
    const last = this.c.length - 1;
    if (last > 0) this.sw(0, last);
    for (const A of [this.c, this.u, this.v, this.su, this.sv]) A.pop();
    let i = 0;
    for (;;) {
      const l = 2 * i + 1, r = l + 1;
      let m = i;
      if (l < this.c.length && this.less(l, m)) m = l;
      if (r < this.c.length && this.less(r, m)) m = r;
      if (m === i) break;
      this.sw(i, m); i = m;
    }
    return top;
  }
}

const triN = (A, B, C) => { const u = [B[0] - A[0], B[1] - A[1], B[2] - A[2]], v = [C[0] - A[0], C[1] - A[1], C[2] - A[2]]; return [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]; };
const SAMPLE_W = [[1 / 3, 1 / 3, 1 / 3], [0.5, 0.5, 0], [0, 0.5, 0.5], [0.5, 0, 0.5]];

/**
 * Simplify soup triangles. opts: {tris (subset ids; default all), target (triangles; 0 = as far as
 * the bound allows), maxError (px; Infinity = unbounded), measure (track the sample error even
 * without a bound), locked (Uint8Array per point), lockBorders (open borders never move),
 * featureAngle (deg, 0 = off), seams (true), attrWeight (1)}.
 * -> {tris: [{p:[a,b,c] point ids, uv, n, c?, sj?, sw?, g, f}], error (px, sampled one-sided
 *    max distance original -> result; null when not measured), qem (max sqrt QEM cost), collapses, source}
 */
export function simplifySoup(S, opts = {}) {
  const { P, np } = S;
  const ids = opts.tris ? Array.from(opts.tris) : Array.from({ length: S.nt }, (_, i) => i);
  // context: triangles around the region that stay as they are but take part in the link
  // condition (no fins / doubled edges against a neighbouring region simplified separately)
  const ctx = opts.context ? Array.from(opts.context) : [];
  const nOwn = ids.length;
  for (const t of ctx) ids.push(t);
  // the internal samples are sparser than a Hausdorff measurement: keep a 10 % margin so the
  // measured distance stays under the bound on curved surfaces too
  const bound = Number.isFinite(opts.maxError) ? Number(opts.maxError) * 0.9 : Infinity;
  const track = bound < Infinity || !!opts.measure;
  const featureCos = opts.featureAngle > 0 ? Math.cos((opts.featureAngle * Math.PI) / 180) : -2;
  const seams = opts.seams !== false, attrW = Number(opts.attrWeight ?? 1);
  const locked = opts.locked || null;
  const pos = (i) => pointOf(P, i);
  // triangle records
  const T = ids.map((t, q) => {
    const r = { p: [S.T[t * 3], S.T[t * 3 + 1], S.T[t * 3 + 2]], g: S.G[t], f: S.F[t], alive: true, frozen: q >= nOwn,
      uv: [0, 1, 2].map((k) => [S.UV[t * 6 + k * 2], S.UV[t * 6 + k * 2 + 1]]), n: [0, 1, 2].map((k) => [S.N[t * 9 + k * 3], S.N[t * 9 + k * 3 + 1], S.N[t * 9 + k * 3 + 2]]) };
    if (S.C) r.c = [0, 1, 2].map((k) => Array.from(S.C.subarray(t * 12 + k * 4, t * 12 + k * 4 + 4)));
    if (S.SJ) { r.sj = [0, 1, 2].map((k) => Array.from(S.SJ.subarray(t * 12 + k * 4, t * 12 + k * 4 + 4))); r.sw = [0, 1, 2].map((k) => Array.from(S.SW.subarray(t * 12 + k * 4, t * 12 + k * 4 + 4))); }
    if (track) {
      const [A, B, C] = r.p.map(pos), s = [];
      for (const w of SAMPLE_W) for (let k = 0; k < 3; k++) s.push(w[0] * A[k] + w[1] * B[k] + w[2] * C[k]);
      r.s = s;
    }
    return r;
  });
  const inc = new Map();
  const incOf = (i) => { let l = inc.get(i); if (!l) { l = []; inc.set(i, l); } return l; };
  T.forEach((t, ti) => { for (const a of t.p) incOf(a).push(ti); });
  const live = (i) => { const l = (inc.get(i) || []).filter((ti) => T[ti].alive); inc.set(i, l); return l; };
  // quadrics
  const Q = new Map();
  const qOf = (i) => { let q = Q.get(i); if (!q) { q = new Float64Array(10); Q.set(i, q); } return q; };
  const addPlane = (i, n, d, w) => { const [a, b, c] = n, q = qOf(i); q[0] += a * a * w; q[1] += a * b * w; q[2] += a * c * w; q[3] += a * d * w; q[4] += b * b * w; q[5] += b * c * w; q[6] += b * d * w; q[7] += c * c * w; q[8] += c * d * w; q[9] += d * d * w; };
  for (const t of T) {
    if (t.frozen) continue;
    const [A, B, C] = t.p.map(pos), n = triN(A, B, C), l = Math.hypot(...n);
    if (l < 1e-14) continue;
    const nn = n.map((x) => x / l), d = -(nn[0] * A[0] + nn[1] * A[1] + nn[2] * A[2]);
    for (const a of t.p) addPlane(a, nn, d, l / 2); // area-weighted
  }
  // edges + constraints
  const edges = new Map();
  T.forEach((t, ti) => { for (let k = 0; k < 3; k++) { const key = ekey(t.p[k], t.p[(k + 1) % 3], np); const l = edges.get(key); if (l) l.push(ti); else edges.set(key, [ti]); } });
  const cornerAt = (t, p) => t.p.indexOf(p);
  const attrsDiffer = (t1, t2, a) => {
    const i = cornerAt(t1, a), j = cornerAt(t2, a);
    if (Math.abs(t1.uv[i][0] - t2.uv[j][0]) > 1e-5 || Math.abs(t1.uv[i][1] - t2.uv[j][1]) > 1e-5) return true;
    const n1 = t1.n[i], n2 = t2.n[j];
    if (n1[0] * n2[0] + n1[1] * n2[1] + n1[2] * n2[2] < 0.9995) return true;
    if (t1.c && t1.c[i].some((v, k) => Math.abs(v - t2.c[j][k]) > 1e-3)) return true;
    if (t1.sw && (t1.sj[i].some((v, k) => v !== t2.sj[j][k]) || t1.sw[i].some((v, k) => Math.abs(v - t2.sw[j][k]) > 1e-4))) return true;
    return false;
  };
  const constrained = new Set(), cdeg = new Map(), lockP = new Set(), border = new Set();
  const stats = { open: 0, material: 0, seam: 0, feature: 0, locked: 0 };
  for (const [key, l] of edges) {
    const a = Math.floor(key / np), b = key % np;
    let kind = null;
    if (l.length === 1) kind = 'open';
    else if (l.length > 2) { kind = 'open'; lockP.add(a); lockP.add(b); }
    else {
      const t1 = T[l[0]], t2 = T[l[1]];
      if (t1.g !== t2.g) kind = 'material';
      else if (seams && (attrsDiffer(t1, t2, a) || attrsDiffer(t1, t2, b))) kind = 'seam';
      else if (featureCos > -2) {
        const n1 = triN(...t1.p.map(pos)), n2 = triN(...t2.p.map(pos)), l1 = Math.hypot(...n1), l2 = Math.hypot(...n2);
        if (l1 > 1e-14 && l2 > 1e-14 && (n1[0] * n2[0] + n1[1] * n2[1] + n1[2] * n2[2]) / (l1 * l2) < featureCos) kind = 'feature';
      }
    }
    if (!kind) continue;
    stats[kind]++;
    constrained.add(key);
    border.add(a); border.add(b);
    cdeg.set(a, (cdeg.get(a) || 0) + 1); cdeg.set(b, (cdeg.get(b) || 0) + 1);
    if (kind === 'open' && opts.lockBorders) { lockP.add(a); lockP.add(b); }
    // perpendicular constraint planes keep the line in place
    for (const ti of l) {
      const t = T[ti], n = triN(...t.p.map(pos)), PA = pos(a), PB = pos(b), e = [PB[0] - PA[0], PB[1] - PA[1], PB[2] - PA[2]];
      let m = [e[1] * n[2] - e[2] * n[1], e[2] * n[0] - e[0] * n[2], e[0] * n[1] - e[1] * n[0]];
      const ml = Math.hypot(...m);
      if (ml < 1e-14) continue;
      m = m.map((x) => x / ml);
      const d = -(m[0] * PA[0] + m[1] * PA[1] + m[2] * PA[2]), w = 4 * Math.hypot(...e) ** 2;
      addPlane(a, m, d, w); addPlane(b, m, d, w);
    }
  }
  for (const [p, d] of cdeg) if (d !== 2) lockP.add(p); // feature corners / line ends
  if (locked) for (const t of T) for (const p of t.p) if (locked[p]) lockP.add(p);
  if (ctx.length) { const own = new Set(); for (let q = 0; q < nOwn; q++) for (const p of T[q].p) own.add(p); for (let q = nOwn; q < T.length; q++) for (const p of T[q].p) if (!own.has(p)) lockP.add(p); }
  stats.locked = lockP.size;
  const evalQ = (i, j, p) => {
    const [x, y, z] = p;
    let s = 0;
    for (const q of [Q.get(i), Q.get(j)]) { if (!q) continue; s += q[0] * x * x + 2 * q[1] * x * y + 2 * q[2] * x * z + 2 * q[3] * x + q[4] * y * y + 2 * q[5] * y * z + 2 * q[6] * y + q[7] * z * z + 2 * q[8] * z + q[9]; }
    return Math.max(0, s);
  };
  const groupsAt = (i) => new Set(live(i).map((ti) => T[ti].g));
  const ver = new Map();
  const vOf = (i) => ver.get(i) || 0;
  const attrPenalty = (u, v) => {
    if (!(attrW > 0) || (!S.C && !S.SJ)) return 0;
    const sh = live(u).find((ti) => T[ti].p.includes(v));
    if (sh === undefined) return 0;
    const t = T[sh], i = cornerAt(t, u), j = cornerAt(t, v);
    let d = 0;
    if (t.c) for (let k = 0; k < 4; k++) d = Math.max(d, Math.abs(t.c[i][k] - t.c[j][k]));
    if (t.sw) {
      const wu = new Map(), wv = new Map();
      t.sj[i].forEach((jj, k) => wu.set(jj, (wu.get(jj) || 0) + t.sw[i][k]));
      t.sj[j].forEach((jj, k) => wv.set(jj, (wv.get(jj) || 0) + t.sw[j][k]));
      let l1 = 0;
      for (const k of new Set([...wu.keys(), ...wv.keys()])) l1 += Math.abs((wu.get(k) || 0) - (wv.get(k) || 0));
      d = Math.max(d, l1 / 2);
    }
    const A = pos(u), B = pos(v);
    return attrW * d * ((A[0] - B[0]) ** 2 + (A[1] - B[1]) ** 2 + (A[2] - B[2]) ** 2);
  };
  const heap = new Heap();
  const pushEdge = (u, v) => { if (lockP.has(u)) return; heap.push(evalQ(u, v, pos(v)) + attrPenalty(u, v), u, v, vOf(u), vOf(v)); };
  for (const key of [...edges.keys()].sort((a, b) => a - b)) { const a = Math.floor(key / np), b = key % np; pushEdge(a, b); pushEdge(b, a); }
  let alive = nOwn;
  const target = Math.max(0, Math.floor(opts.target ?? 0));
  let maxErr = 0, qem = 0, collapses = 0;
  const nb = (i) => { const s2 = new Set(); for (const ti of live(i)) for (const p of T[ti].p) if (p !== i) s2.add(p); return s2; };
  const distToRing = (q, ring) => {
    let best = Infinity, bi = -1;
    for (const [ti, A, B, C] of ring) { const r = closestOnTri(q, A[0], A[1], A[2], B[0], B[1], B[2], C[0], C[1], C[2]); if (r[3] < best) { best = r[3]; bi = ti; } }
    return [Math.sqrt(best), bi];
  };
  while (alive > target && heap.size) {
    const [cost, u, v, su, sv] = heap.pop();
    if (su !== vOf(u) || sv !== vOf(v)) continue;
    const tu = live(u);
    if (!tu.length) continue;
    const shared = tu.filter((ti) => T[ti].p.includes(v));
    if (!shared.length) continue;
    if (border.has(u)) {
      if (!border.has(v) || !constrained.has(ekey(u, v, np))) continue;
      const gu = groupsAt(u), gv = groupsAt(v);
      let ok = true;
      for (const g of gu) if (!gv.has(g)) ok = false;
      if (!ok) continue;
    }
    const nu = nb(u), nv = nb(v);
    let common = 0;
    for (const w of nu) if (nv.has(w)) common++;
    if (common > shared.length) continue;
    const PV = pos(v);
    let bad = false;
    for (const ti of tu) {
      const t = T[ti];
      if (t.p.includes(v)) continue;
      const n0 = triN(...t.p.map(pos)), n1 = triN(...t.p.map((p) => (p === u ? PV : pos(p)))), l0 = Math.hypot(...n0), l1 = Math.hypot(...n1);
      if (l1 < 1e-9 * Math.max(1, l0) || (n0[0] * n1[0] + n0[1] * n1[1] + n0[2] * n1[2]) / (l0 * l1) < 0.3) { bad = true; break; }
    }
    if (bad) continue;
    // error bound: samples of every triangle around u (and u itself) against v's new ring
    let reassign = null, worst = 0;
    if (track) {
      const ring = [];
      for (const ti of tu) { const t = T[ti]; if (t.p.includes(v)) continue; ring.push([ti, ...t.p.map((p) => (p === u ? PV : pos(p)))]); }
      for (const ti of live(v)) { const t = T[ti]; if (t.p.includes(u) || t.frozen) continue; ring.push([ti, ...t.p.map(pos)]); }
      if (!ring.length) continue;
      reassign = [];
      const pts = [pos(u)];
      for (const ti of tu) { const s = T[ti].s; for (let k = 0; k < s.length; k += 3) pts.push([s[k], s[k + 1], s[k + 2]]); }
      for (const q of pts) {
        const [d, bi] = distToRing(q, ring);
        if (d > worst) worst = d;
        if (d > bound) { bad = true; break; }
        reassign.push([q, bi]);
      }
      if (bad) continue;
    }
    // collapse u -> v
    const keepSkin = (() => { if (!S.SJ) return null; const t = T[shared.find((ti) => T[ti].g === T[tu[0]].g) ?? shared[0]], k = cornerAt(t, v); return [t.sj[k], t.sw[k]]; })();
    for (const ti of tu) {
      const t = T[ti];
      if (t.p.includes(v)) { t.alive = false; alive--; if (track) t.s = []; continue; }
      const k = t.p.indexOf(u);
      const [A, B, C] = t.p.map(pos), n = triN(A, B, C), nl = n[0] * n[0] + n[1] * n[1] + n[2] * n[2] || 1;
      const w = [0, 1, 2].map((m) => { const X = [A, B, C][(m + 1) % 3], Y = [A, B, C][(m + 2) % 3], c = triN(PV, X, Y); return (c[0] * n[0] + c[1] * n[1] + c[2] * n[2]) / nl; });
      t.uv[k] = [0, 1].map((c) => w[0] * t.uv[0][c] + w[1] * t.uv[1][c] + w[2] * t.uv[2][c]);
      const nn = [0, 1, 2].map((c) => w[0] * t.n[0][c] + w[1] * t.n[1][c] + w[2] * t.n[2][c]), nnl = Math.hypot(...nn) || 1;
      t.n[k] = nn.map((x) => x / nnl);
      if (t.c) t.c[k] = [0, 1, 2, 3].map((c) => w[0] * t.c[0][c] + w[1] * t.c[1][c] + w[2] * t.c[2][c]);
      if (t.sj && keepSkin) { t.sj[k] = keepSkin[0].slice(); t.sw[k] = keepSkin[1].slice(); }
      t.p[k] = v;
      if (track) t.s = [];
      incOf(v).push(ti);
    }
    if (reassign) for (const [q, bi] of reassign) T[bi].s.push(q[0], q[1], q[2]);
    if (worst > maxErr) maxErr = worst;
    const qu = Q.get(u), qv = qOf(v);
    if (qu) for (let k = 0; k < 10; k++) qv[k] += qu[k];
    for (const w of nu) if (constrained.has(ekey(u, w, np))) constrained.add(ekey(v, w, np));
    inc.set(u, []);
    ver.set(u, vOf(u) + 1); ver.set(v, vOf(v) + 1);
    qem = Math.max(qem, Math.sqrt(cost));
    collapses++;
    for (const w of nb(v)) { pushEdge(v, w); pushEdge(w, v); }
  }
  const out = [];
  for (const t of T) if (t.alive && !t.frozen) out.push({ p: t.p.slice(), uv: t.uv, n: t.n, ...(t.c ? { c: t.c } : {}), ...(t.sj ? { sj: t.sj, sw: t.sw } : {}), g: t.g, f: t.f });
  return { tris: out, error: track ? maxErr : null, qem, collapses, source: nOwn, constraints: stats };
}

/** simplifySoup output -> meshFromTris records (positions from the soup). */
export const soupRecords = (S, tris) => tris.map((t) => ({ ...t, p: t.p.map((i) => pointOf(S.P, i)) }));

/**
 * Decimate a mesh (px). opts: {ratio | triangles, maxError (px, guaranteed sampled bound),
 * featureAngle (deg), seams, attrWeight, lockBorders}. -> {mesh, triangles, source, error (px),
 * qem, constraints}
 */
export function decimateMesh(mesh, opts = {}) {
  const S = soupOf(mesh);
  const target = opts.triangles !== undefined ? Math.max(1, Math.floor(opts.triangles)) : opts.ratio !== undefined ? Math.max(1, Math.floor(S.nt * opts.ratio)) : Number.isFinite(opts.maxError) ? 0 : Math.floor(S.nt / 2);
  const r = simplifySoup(S, { ...opts, target, measure: true });
  const out = meshFromTris(soupRecords(S, r.tris), S.groups);
  return { mesh: out, triangles: out.triangles, source: S.nt, error: r.error, qem: r.qem, constraints: r.constraints, collapses: r.collapses };
}
