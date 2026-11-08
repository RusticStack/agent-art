// Mesh-processing core shared by the large-mesh tools (robust booleans, voxel / quad remesh,
// error-bounded decimation, cluster LOD, visibility): a welded triangle "soup" with per-corner
// attributes, a flat triangle BVH (closest point, box overlap, ray hits), a filtered exact
// orientation predicate, winding-number inside tests, Hausdorff distance, manifold reports and a
// cleanup pass. Pure JS, deterministic (no randomness, stable orders).
import { Mesh } from './model3d.js';

// ---------- small vector helpers ----------
export const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const len3 = (a) => Math.hypot(a[0], a[1], a[2]);
export const norm3 = (a) => { const l = len3(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

// ---------- triangle soup ----------
/** Face record props carried to processed meshes (pid / tag / material / rig node / shadow flags / greeble drop). */
export const SOUP_FACE_PROPS = ['pid', 'tag', 'mat', 'node', 'cs', 'rs', 'greeble', 'gh', 'pi'];

/**
 * Mesh -> soup: positions welded at 1e-4 px (shared connectivity across materials), triangles with
 * their own corner UVs / normals (+ vertex colours g.col and skin g.skin {j, w} when present, 4 per
 * vertex), the source group and face record. Degenerate (repeated point) triangles are dropped;
 * overlay shells are left out. -> {P, np, T, nt, G, F, UV, N, C?, SJ?, SW?, groups}
 */
export function soupOf(mesh, { quant = 1e4 } = {}) {
  const groups = [...mesh.groups.values()].filter((g) => !g.overlay && g.faces && g.idx.length);
  const pid = new Map(), P = [];
  const point = (x, y, z) => {
    const k = `${Math.round(x * quant)},${Math.round(y * quant)},${Math.round(z * quant)}`;
    let i = pid.get(k);
    if (i === undefined) { i = P.length / 3; pid.set(k, i); P.push(x, y, z); }
    return i;
  };
  let cap = 0;
  for (const g of groups) cap += g.idx.length / 3;
  const hasC = groups.some((g) => g.col), hasS = groups.some((g) => g.skin);
  const T = new Int32Array(cap * 3), G = new Int32Array(cap), F = new Array(cap), UV = new Float64Array(cap * 6), N = new Float64Array(cap * 9);
  const C = hasC ? new Float32Array(cap * 12).fill(1) : null, SJ = hasS ? new Uint16Array(cap * 12) : null, SW = hasS ? new Float32Array(cap * 12) : null;
  let nt = 0;
  groups.forEach((g, gi) => {
    for (const f of g.faces) for (let i = f.i; i < f.i + f.ic; i += 3) {
      const v = [g.idx[i], g.idx[i + 1], g.idx[i + 2]];
      const p = v.map((x) => point(g.pos[x * 3], g.pos[x * 3 + 1], g.pos[x * 3 + 2]));
      if (p[0] === p[1] || p[1] === p[2] || p[0] === p[2]) continue;
      T[nt * 3] = p[0]; T[nt * 3 + 1] = p[1]; T[nt * 3 + 2] = p[2];
      G[nt] = gi; F[nt] = f;
      for (let k = 0; k < 3; k++) {
        UV[nt * 6 + k * 2] = g.uv[v[k] * 2]; UV[nt * 6 + k * 2 + 1] = g.uv[v[k] * 2 + 1];
        for (let c = 0; c < 3; c++) N[nt * 9 + k * 3 + c] = g.nrm[v[k] * 3 + c];
        if (C && g.col) for (let c = 0; c < 4; c++) C[nt * 12 + k * 4 + c] = g.col[v[k] * 4 + c];
        if (SJ && g.skin) for (let c = 0; c < 4; c++) { SJ[nt * 12 + k * 4 + c] = g.skin.j[v[k] * 4 + c]; SW[nt * 12 + k * 4 + c] = g.skin.w[v[k] * 4 + c]; }
      }
      nt++;
    }
  });
  return { P: Float64Array.from(P), np: P.length / 3, T: T.subarray(0, nt * 3), nt, G: G.subarray(0, nt), F: F.slice(0, nt), UV: UV.subarray(0, nt * 6), N: N.subarray(0, nt * 9), C: C ? C.subarray(0, nt * 12) : null, SJ: SJ ? SJ.subarray(0, nt * 12) : null, SW: SW ? SW.subarray(0, nt * 12) : null, groups };
}

/** Geometric (unnormalized) normal of soup triangle t. */
export function triNormal(P, T, t) {
  const a = T[t * 3] * 3, b = T[t * 3 + 1] * 3, c = T[t * 3 + 2] * 3;
  const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2], vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
  return [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
}
export const pointOf = (P, i) => [P[i * 3], P[i * 3 + 1], P[i * 3 + 2]];

/**
 * Triangles -> Mesh. tris = [{p:[[x,y,z]x3], uv:[[u,v]x3], n:[[x,y,z]x3], g (group index), f (face
 * record), c?:[[r,g,b,a]x3], sj?, sw?}], groups = source groups (tex). Consecutive triangles of one
 * face record share one output face record (mode 0: UVs are final).
 */
export function meshFromTris(tris, groups) {
  const out = new Mesh();
  let last = null, lastG = null, rec = null;
  for (const t of tris) {
    const og = out.group(groups[t.g].tex);
    if (t.c && !og.col) og.col = new Array((og.pos.length / 3) * 4).fill(1);
    if (t.sj && !og.skin) og.skin = { j: new Array((og.pos.length / 3) * 4).fill(0), w: new Array((og.pos.length / 3) * 4).fill(0) };
    const base = og.pos.length / 3;
    const n = norm3(cross3(sub3(t.p[1], t.p[0]), sub3(t.p[2], t.p[0])));
    for (let k = 0; k < 3; k++) {
      og.pos.push(t.p[k][0], t.p[k][1], t.p[k][2]);
      const nk = t.n ? t.n[k] : n;
      og.nrm.push(nk[0], nk[1], nk[2]);
      og.uv.push(t.uv ? t.uv[k][0] : 0, t.uv ? t.uv[k][1] : 0);
      if (og.col) { const c = t.c ? t.c[k] : [1, 1, 1, 1]; og.col.push(c[0], c[1], c[2], c[3]); }
      if (og.skin) { const j = t.sj ? t.sj[k] : [0, 0, 0, 0], w = t.sw ? t.sw[k] : [1, 0, 0, 0]; og.skin.j.push(...j); og.skin.w.push(...w); }
    }
    if (rec && last === t.f && lastG === og && t.f !== undefined && t.f !== null && !t.split) {
      og.idx.push(base, base + 1, base + 2);
      rec.vc += 3; rec.ic += 3;
    } else {
      const i0 = og.idx.length;
      og.idx.push(base, base + 1, base + 2);
      rec = { v: base, vc: 3, i: i0, ic: 3, n, mode: 0 };
      if (t.f) for (const k of SOUP_FACE_PROPS) if (t.f[k] !== undefined) rec[k] = t.f[k];
      if (t.quad) rec.quad = true;
      og.faces.push(rec);
    }
    last = t.f; lastG = og;
  }
  return out;
}

/** Soup triangle t as a meshFromTris record (optionally with positions replaced). */
export function soupTri(S, t, pos) {
  const p = pos || [0, 1, 2].map((k) => pointOf(S.P, S.T[t * 3 + k]));
  const r = { p, uv: [0, 1, 2].map((k) => [S.UV[t * 6 + k * 2], S.UV[t * 6 + k * 2 + 1]]), n: [0, 1, 2].map((k) => [S.N[t * 9 + k * 3], S.N[t * 9 + k * 3 + 1], S.N[t * 9 + k * 3 + 2]]), g: S.G[t], f: S.F[t] };
  if (S.C) r.c = [0, 1, 2].map((k) => Array.from(S.C.subarray(t * 12 + k * 4, t * 12 + k * 4 + 4)));
  if (S.SJ) { r.sj = [0, 1, 2].map((k) => Array.from(S.SJ.subarray(t * 12 + k * 4, t * 12 + k * 4 + 4))); r.sw = [0, 1, 2].map((k) => Array.from(S.SW.subarray(t * 12 + k * 4, t * 12 + k * 4 + 4))); }
  return r;
}

/**
 * Attributes of soup triangle t evaluated at point q (barycentric of q projected on the triangle's
 * plane; extrapolates outside, which keeps world-tiled UVs exact across a flat face).
 */
export function attrsAt(S, t, q) {
  const A = pointOf(S.P, S.T[t * 3]), B = pointOf(S.P, S.T[t * 3 + 1]), Cc = pointOf(S.P, S.T[t * 3 + 2]);
  const w = baryOf(A, B, Cc, q);
  const uv = [0, 1].map((c) => w[0] * S.UV[t * 6 + c] + w[1] * S.UV[t * 6 + 2 + c] + w[2] * S.UV[t * 6 + 4 + c]);
  const n = norm3([0, 1, 2].map((c) => w[0] * S.N[t * 9 + c] + w[1] * S.N[t * 9 + 3 + c] + w[2] * S.N[t * 9 + 6 + c]));
  const r = { uv, n };
  if (S.C) r.c = [0, 1, 2, 3].map((c) => w[0] * S.C[t * 12 + c] + w[1] * S.C[t * 12 + 4 + c] + w[2] * S.C[t * 12 + 8 + c]);
  if (S.SJ) {
    // skin: the nearest corner's joints + weights (indices cannot be blended)
    const k = w[0] >= w[1] && w[0] >= w[2] ? 0 : w[1] >= w[2] ? 1 : 2;
    r.sj = Array.from(S.SJ.subarray(t * 12 + k * 4, t * 12 + k * 4 + 4)); r.sw = Array.from(S.SW.subarray(t * 12 + k * 4, t * 12 + k * 4 + 4));
  }
  return r;
}
/** Barycentric weights of q (projected onto the plane of a, b, c). */
export function baryOf(a, b, c, q) {
  const n = cross3(sub3(b, a), sub3(c, a)), nl = dot3(n, n) || 1;
  const w0 = dot3(cross3(sub3(b, q), sub3(c, q)), n) / nl, w1 = dot3(cross3(sub3(c, q), sub3(a, q)), n) / nl;
  return [w0, w1, 1 - w0 - w1];
}

// ---------- robust orientation ----------
const F64 = new Float64Array(1), U32 = new Uint32Array(F64.buffer);
/** x (finite double) = m * 2^e with m a BigInt. */
function decompose(x) {
  if (x === 0) return { m: 0n, e: 0 };
  F64[0] = x;
  const lo = U32[0], hi = U32[1], sign = hi >>> 31, ex = (hi >>> 20) & 0x7ff;
  let m = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);
  let e;
  if (ex === 0) e = -1074; else { m |= 1n << 52n; e = ex - 1075; }
  return { m: sign ? -m : m, e };
}
/** Exact sign of the 3x3 determinant [b-a; c-a; d-a] (BigInt arithmetic on the exact doubles). */
function orient3dExact(a, b, c, d) {
  const xs = [...a, ...b, ...c, ...d].map(decompose);
  const e0 = Math.min(...xs.filter((x) => x.m !== 0n).map((x) => x.e), 0);
  const v = xs.map((x) => x.m << BigInt(x.e - e0));
  const [ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz] = v;
  const m = [bx - ax, by - ay, bz - az, cx - ax, cy - ay, cz - az, dx - ax, dy - ay, dz - az];
  const det = m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);
  return det > 0n ? 1 : det < 0n ? -1 : 0;
}
/**
 * Sign of orient3d(a, b, c, d) = det[b-a; c-a; d-a] (> 0: d on the side the normal (b-a)x(c-a)
 * points to). Floating-point filter (Shewchuk's error bound) with an exact BigInt fallback.
 */
export function orient3d(a, b, c, d) {
  const bx = b[0] - a[0], by = b[1] - a[1], bz = b[2] - a[2], cx = c[0] - a[0], cy = c[1] - a[1], cz = c[2] - a[2], dx = d[0] - a[0], dy = d[1] - a[1], dz = d[2] - a[2];
  const m1 = cy * dz - cz * dy, m2 = cx * dz - cz * dx, m3 = cx * dy - cy * dx;
  const det = bx * m1 - by * m2 + bz * m3;
  const perm = Math.abs(bx) * (Math.abs(cy * dz) + Math.abs(cz * dy)) + Math.abs(by) * (Math.abs(cx * dz) + Math.abs(cz * dx)) + Math.abs(bz) * (Math.abs(cx * dy) + Math.abs(cy * dx));
  const bound = 1e-15 * perm + 1e-300;
  if (det > bound) return 1;
  if (det < -bound) return -1;
  orient3d.exact++;
  return orient3dExact(a, b, c, d);
}
orient3d.exact = 0;

// ---------- BVH over triangles ----------
/** Closest point on triangle abc to p (Ericson 5.1.5). -> [x, y, z, d2] */
export function closestOnTri(p, ax, ay, az, bx, by, bz, cx, cy, cz) {
  const abx = bx - ax, aby = by - ay, abz = bz - az, acx = cx - ax, acy = cy - ay, acz = cz - az;
  const apx = p[0] - ax, apy = p[1] - ay, apz = p[2] - az;
  const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
  let x, y, z;
  if (d1 <= 0 && d2 <= 0) { x = ax; y = ay; z = az; } else {
    const bpx = p[0] - bx, bpy = p[1] - by, bpz = p[2] - bz;
    const d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz;
    if (d3 >= 0 && d4 <= d3) { x = bx; y = by; z = bz; } else {
      const vc = d1 * d4 - d3 * d2;
      if (vc <= 0 && d1 >= 0 && d3 <= 0) { const v = d1 / (d1 - d3); x = ax + abx * v; y = ay + aby * v; z = az + abz * v; } else {
        const cpx = p[0] - cx, cpy = p[1] - cy, cpz = p[2] - cz;
        const d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz;
        if (d6 >= 0 && d5 <= d6) { x = cx; y = cy; z = cz; } else {
          const vb = d5 * d2 - d1 * d6;
          if (vb <= 0 && d2 >= 0 && d6 <= 0) { const w = d2 / (d2 - d6); x = ax + acx * w; y = ay + acy * w; z = az + acz * w; } else {
            const va = d3 * d6 - d5 * d4;
            if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) { const w = (d4 - d3) / (d4 - d3 + (d5 - d6)); x = bx + (cx - bx) * w; y = by + (cy - by) * w; z = bz + (cz - bz) * w; } else {
              const den = 1 / (va + vb + vc), v = vb * den, w = vc * den;
              x = ax + abx * v + acx * w; y = ay + aby * v + acy * w; z = az + abz * v + acz * w;
            }
          }
        }
      }
    }
  }
  const dx = p[0] - x, dy = p[1] - y, dz = p[2] - z;
  return [x, y, z, dx * dx + dy * dy + dz * dz];
}

/**
 * Flat BVH over triangles (P point coords, T point indices; tris = subset of triangle ids or all).
 * Midpoint split of the centroid bounds, leaves of <= 4. Queries: closest, overlap, ray, inside.
 */
export class TriBVH {
  constructor(P, T, tris = null, { leaf = 4 } = {}) {
    this.P = P; this.T = T;
    const ids = tris ? Int32Array.from(tris) : Int32Array.from({ length: T.length / 3 }, (_, i) => i);
    this.ids = ids;
    const n = ids.length, cen = new Float64Array(n * 3), tb = new Float64Array(n * 6);
    for (let k = 0; k < n; k++) {
      const t = ids[k];
      for (let c = 0; c < 3; c++) {
        const a = P[T[t * 3] * 3 + c], b = P[T[t * 3 + 1] * 3 + c], d = P[T[t * 3 + 2] * 3 + c];
        tb[k * 6 + c] = Math.min(a, b, d); tb[k * 6 + 3 + c] = Math.max(a, b, d); cen[k * 3 + c] = (a + b + d) / 3;
      }
    }
    // build over a permutation of 0..n-1 (k = position in ids)
    const ord = Int32Array.from({ length: n }, (_, i) => i);
    const cap = Math.max(1, 2 * Math.ceil(n / Math.max(1, leaf)) + 2);
    let box = new Float64Array(cap * 6), left = new Int32Array(cap), start = new Int32Array(cap), cnt = new Int32Array(cap);
    let nn = 0;
    const grow = () => {
      const c2 = box.length / 6 * 2;
      const nb = new Float64Array(c2 * 6); nb.set(box); box = nb;
      const nl = new Int32Array(c2); nl.set(left); left = nl;
      const ns = new Int32Array(c2); ns.set(start); start = ns;
      const nc = new Int32Array(c2); nc.set(cnt); cnt = nc;
    };
    const st = [[0, n]];
    nn = 1;
    const stackNode = [0];
    while (st.length) {
      const [s, e] = st.pop(), node = stackNode.pop();
      if (node * 6 + 6 > box.length) grow();
      let mn0 = Infinity, mn1 = Infinity, mn2 = Infinity, mx0 = -Infinity, mx1 = -Infinity, mx2 = -Infinity;
      let c0 = Infinity, c1 = Infinity, c2 = Infinity, C0 = -Infinity, C1 = -Infinity, C2 = -Infinity;
      for (let i = s; i < e; i++) {
        const k = ord[i];
        if (tb[k * 6] < mn0) mn0 = tb[k * 6]; if (tb[k * 6 + 1] < mn1) mn1 = tb[k * 6 + 1]; if (tb[k * 6 + 2] < mn2) mn2 = tb[k * 6 + 2];
        if (tb[k * 6 + 3] > mx0) mx0 = tb[k * 6 + 3]; if (tb[k * 6 + 4] > mx1) mx1 = tb[k * 6 + 4]; if (tb[k * 6 + 5] > mx2) mx2 = tb[k * 6 + 5];
        const x = cen[k * 3], y = cen[k * 3 + 1], z = cen[k * 3 + 2];
        if (x < c0) c0 = x; if (x > C0) C0 = x; if (y < c1) c1 = y; if (y > C1) C1 = y; if (z < c2) c2 = z; if (z > C2) C2 = z;
      }
      box[node * 6] = mn0; box[node * 6 + 1] = mn1; box[node * 6 + 2] = mn2; box[node * 6 + 3] = mx0; box[node * 6 + 4] = mx1; box[node * 6 + 5] = mx2;
      if (e - s <= leaf) { left[node] = -1; start[node] = s; cnt[node] = e - s; continue; }
      const ex = [C0 - c0, C1 - c1, C2 - c2], ax = ex[0] >= ex[1] && ex[0] >= ex[2] ? 0 : ex[1] >= ex[2] ? 1 : 2;
      const mid = [c0 + C0, c1 + C1, c2 + C2][ax] / 2;
      let i = s, j = e - 1;
      while (i <= j) { if (cen[ord[i] * 3 + ax] < mid) i++; else { const t = ord[i]; ord[i] = ord[j]; ord[j] = t; j--; } }
      let m = i;
      if (m === s || m === e) m = (s + e) >> 1; // all centroids equal along the axis
      while (nn + 2 > box.length / 6) grow();
      const L = nn++, R = nn++;
      left[node] = L; start[node] = R; cnt[node] = 0;
      st.push([s, m]); stackNode.push(L); st.push([m, e]); stackNode.push(R);
    }
    this.box = box; this.left = left; this.start = start; this.cnt = cnt; this.nodes = nn;
    this.ord = Int32Array.from(ord, (k) => ids[k]); // leaf ranges -> triangle ids
  }
  get size() { return this.ids.length; }
  boxDist2(node, p) {
    const b = this.box, o = node * 6;
    let d = 0;
    for (let c = 0; c < 3; c++) { const v = p[c] < b[o + c] ? b[o + c] - p[c] : p[c] > b[o + 3 + c] ? p[c] - b[o + 3 + c] : 0; d += v * v; }
    return d;
  }
  /** Closest point on the triangles to p. -> {tri, d2, q} | null (none within maxD). */
  closest(p, maxD = Infinity) {
    if (!this.ids.length) return null;
    const { P, T, ord } = this;
    let best = maxD === Infinity ? Infinity : maxD * maxD, bt = -1, bq = null;
    const st = [0];
    while (st.length) {
      const node = st.pop();
      if (this.boxDist2(node, p) > best) continue;
      if (this.left[node] < 0) {
        for (let i = this.start[node], e = i + this.cnt[node]; i < e; i++) {
          const t = ord[i], a = T[t * 3] * 3, b = T[t * 3 + 1] * 3, c = T[t * 3 + 2] * 3;
          const r = closestOnTri(p, P[a], P[a + 1], P[a + 2], P[b], P[b + 1], P[b + 2], P[c], P[c + 1], P[c + 2]);
          if (r[3] < best || (r[3] === best && t < bt)) { best = r[3]; bt = t; bq = r; }
        }
        continue;
      }
      const L = this.left[node], R = this.start[node], dl = this.boxDist2(L, p), dr = this.boxDist2(R, p);
      if (dl < dr) { st.push(R); st.push(L); } else { st.push(L); st.push(R); }
    }
    return bt < 0 ? null : { tri: bt, d2: best, q: [bq[0], bq[1], bq[2]] };
  }
  /** Triangle ids whose box overlaps [mn, mx] (pushed into out, in BVH order). */
  overlap(mn, mx, out = []) {
    if (!this.ids.length) return out;
    const b = this.box, st = [0];
    while (st.length) {
      const node = st.pop(), o = node * 6;
      if (b[o] > mx[0] || b[o + 1] > mx[1] || b[o + 2] > mx[2] || b[o + 3] < mn[0] || b[o + 4] < mn[1] || b[o + 5] < mn[2]) continue;
      if (this.left[node] < 0) { for (let i = this.start[node], e = i + this.cnt[node]; i < e; i++) out.push(this.ord[i]); continue; }
      st.push(this.start[node]); st.push(this.left[node]);
    }
    return out;
  }
  /** Every ray hit (no culling): cb(tri, t) for 0 < t < tmax. */
  ray(o, d, tmax, cb) {
    if (!this.ids.length) return;
    const { P, T, ord, box } = this;
    const inv = [1 / d[0], 1 / d[1], 1 / d[2]];
    const st = [0];
    while (st.length) {
      const node = st.pop(), q = node * 6;
      let t0 = 0, t1 = tmax;
      for (let c = 0; c < 3; c++) {
        let a = (box[q + c] - o[c]) * inv[c], b = (box[q + 3 + c] - o[c]) * inv[c];
        if (a > b) { const t = a; a = b; b = t; }
        if (Number.isNaN(a)) a = -Infinity; if (Number.isNaN(b)) b = Infinity;
        if (a > t0) t0 = a; if (b < t1) t1 = b;
        if (t0 > t1) break;
      }
      if (t0 > t1) continue;
      if (this.left[node] < 0) {
        for (let i = this.start[node], e = i + this.cnt[node]; i < e; i++) {
          const t = ord[i], a = T[t * 3] * 3, b = T[t * 3 + 1] * 3, c = T[t * 3 + 2] * 3;
          const e1x = P[b] - P[a], e1y = P[b + 1] - P[a + 1], e1z = P[b + 2] - P[a + 2], e2x = P[c] - P[a], e2y = P[c + 1] - P[a + 1], e2z = P[c + 2] - P[a + 2];
          const px = d[1] * e2z - d[2] * e2y, py = d[2] * e2x - d[0] * e2z, pz = d[0] * e2y - d[1] * e2x;
          const det = e1x * px + e1y * py + e1z * pz;
          if (Math.abs(det) < 1e-18) continue;
          const id = 1 / det, sx = o[0] - P[a], sy = o[1] - P[a + 1], sz = o[2] - P[a + 2];
          const u = (sx * px + sy * py + sz * pz) * id;
          if (u < 0 || u > 1) continue;
          const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
          const v = (d[0] * qx + d[1] * qy + d[2] * qz) * id;
          if (v < 0 || u + v > 1) continue;
          const tt = (e2x * qx + e2y * qy + e2z * qz) * id;
          if (tt > 0 && tt < tmax) cb(t, tt);
        }
        continue;
      }
      st.push(this.start[node]); st.push(this.left[node]);
    }
  }
  /** Nearest hit distance (Infinity when none). */
  first(o, d, tmax = Infinity) { let best = tmax; this.ray(o, d, best, (t, tt) => { if (tt < best) best = tt; }); return best; }
  /** Winding number of the triangles along a ray (+1 per exit through an outward face). */
  windingRay(p, d) {
    let w = 0;
    this.ray(p, d, Infinity, (t) => { const n = triNormal(this.P, this.T, t); const s = n[0] * d[0] + n[1] * d[1] + n[2] * d[2]; w += s > 0 ? 1 : s < 0 ? -1 : 0; });
    return w;
  }
  /** Inside (non-zero winding) by majority of three fixed skew rays: robust to holes and self-overlap. */
  inside(p) {
    let v = 0;
    for (const d of INSIDE_DIRS) if (this.windingRay(p, d) !== 0) v++;
    return v >= 2;
  }
}
export const INSIDE_DIRS = [norm3([0.6123, 0.7071, 0.3536]), norm3([-0.5187, 0.3122, 0.7959]), norm3([0.2711, -0.8513, 0.4492])];

// ---------- connectivity ----------
/** Undirected edge key of points a, b. */
export const ekey = (a, b, np) => (a < b ? a * np + b : b * np + a);
/** Edge map: key -> [tri ids] over soup triangles (or the given subset). */
export function edgeMap(T, np, tris = null) {
  const E = new Map();
  const n = tris ? tris.length : T.length / 3;
  for (let q = 0; q < n; q++) {
    const t = tris ? tris[q] : q;
    for (let k = 0; k < 3; k++) {
      const key = ekey(T[t * 3 + k], T[t * 3 + ((k + 1) % 3)], np);
      const l = E.get(key);
      if (l) l.push(t); else E.set(key, [t]);
    }
  }
  return E;
}

/**
 * Manifold report of a mesh: edges, open (1 triangle), nonManifold (> 2), flipped (two triangles,
 * same direction), nonManifoldVertices (triangle fan around a point is not one connected fan),
 * components, closed (no open / non-manifold edges).
 */
export function manifoldReport(mesh) {
  const S = soupOf(mesh, { quant: 1e5 });
  const { T, np, nt } = S;
  const E = edgeMap(T, np);
  let open = 0, nonManifold = 0, flipped = 0;
  for (const [key, l] of E) {
    if (l.length === 1) open++;
    else if (l.length > 2) nonManifold++;
    else {
      const a = Math.floor(key / np), b = key % np;
      const dir = (t) => { for (let k = 0; k < 3; k++) { const x = T[t * 3 + k], y = T[t * 3 + ((k + 1) % 3)]; if (x === a && y === b) return 1; if (x === b && y === a) return -1; } return 0; };
      if (dir(l[0]) === dir(l[1])) flipped++;
    }
  }
  // vertex fans
  const inc = Array.from({ length: np }, () => []);
  for (let t = 0; t < nt; t++) for (let k = 0; k < 3; k++) inc[T[t * 3 + k]].push(t);
  let nmv = 0;
  for (let v = 0; v < np; v++) {
    const ts = inc[v];
    if (ts.length < 2) continue;
    const par = new Map(ts.map((t) => [t, t]));
    const find = (x) => { while (par.get(x) !== x) { par.set(x, par.get(par.get(x))); x = par.get(x); } return x; };
    const byOther = new Map();
    for (const t of ts) for (let k = 0; k < 3; k++) { const o = T[t * 3 + k]; if (o === v) continue; const l = byOther.get(o); if (l !== undefined) { const a = find(l), b = find(t); if (a !== b) par.set(a, b); } else byOther.set(o, t); }
    const roots = new Set(ts.map(find));
    if (roots.size > 1) nmv++;
  }
  const comps = components(S);
  return { triangles: nt, vertices: np, edges: E.size, open, nonManifold, flipped, nonManifoldVertices: nmv, components: comps.count, closed: open === 0 && nonManifold === 0 };
}

/** Connected components of soup triangles (shared points). -> {count, of: Int32Array tri -> comp} */
export function components(S, tris = null) {
  const par = new Int32Array(S.np).map((_, i) => i);
  const find = (x) => { while (par[x] !== x) { par[x] = par[par[x]]; x = par[x]; } return x; };
  const list = tris || Array.from({ length: S.nt }, (_, i) => i);
  for (const t of list) { const a = find(S.T[t * 3]), b = find(S.T[t * 3 + 1]), c = find(S.T[t * 3 + 2]); if (a !== b) par[a] = b; const b2 = find(b); if (find(c) !== b2) par[find(c)] = b2; }
  const id = new Map(), of = new Int32Array(S.nt).fill(-1);
  for (const t of list) { const r = find(S.T[t * 3]); if (!id.has(r)) id.set(r, id.size); of[t] = id.get(r); }
  return { count: id.size, of };
}

// ---------- distances ----------
/** Sample points of a soup: every point + per triangle centroid and edge midpoints (+ denser for big triangles). */
export function samplePoints(S, { perTri = 4 } = {}) {
  const out = [];
  for (let i = 0; i < S.np; i++) out.push(S.P[i * 3], S.P[i * 3 + 1], S.P[i * 3 + 2]);
  const W = [[1 / 3, 1 / 3, 1 / 3], [0.5, 0.5, 0], [0, 0.5, 0.5], [0.5, 0, 0.5], [2 / 3, 1 / 6, 1 / 6], [1 / 6, 2 / 3, 1 / 6], [1 / 6, 1 / 6, 2 / 3], [0.25, 0.5, 0.25], [0.5, 0.25, 0.25], [0.25, 0.25, 0.5]];
  const ws = W.slice(0, Math.max(1, Math.min(W.length, perTri)));
  for (let t = 0; t < S.nt; t++) {
    const a = S.T[t * 3] * 3, b = S.T[t * 3 + 1] * 3, c = S.T[t * 3 + 2] * 3;
    for (const w of ws) for (let k = 0; k < 3; k++) out.push(w[0] * S.P[a + k] + w[1] * S.P[b + k] + w[2] * S.P[c + k]);
  }
  return out;
}
/**
 * Two-sided Hausdorff distance between meshes (px), sampled: points of each (vertices, centroids,
 * edge midpoints, interior points) to the closest point of the other. -> {ab, ba, max, mean_ab, mean_ba}
 */
export function hausdorff(A, B, { perTri = 10 } = {}) {
  const SA = A.P ? A : soupOf(A), SB = B.P ? B : soupOf(B);
  const one = (S1, S2) => {
    const bvh = new TriBVH(S2.P, S2.T);
    const pts = samplePoints(S1, { perTri });
    let mx = 0, sum = 0, n = 0;
    for (let i = 0; i < pts.length; i += 3) { const r = bvh.closest([pts[i], pts[i + 1], pts[i + 2]]); if (!r) continue; const d = Math.sqrt(r.d2); if (d > mx) mx = d; sum += d; n++; }
    return { max: mx, mean: n ? sum / n : 0 };
  };
  const ab = one(SA, SB), ba = one(SB, SA);
  return { ab: ab.max, ba: ba.max, max: Math.max(ab.max, ba.max), mean_ab: ab.mean, mean_ba: ba.mean };
}

// ---------- cleanup ----------
/**
 * Cleanup pass: weld points closer than `weld` px, drop degenerate / zero-area and duplicate
 * triangles (opposite duplicates cancel), make winding consistent per connected piece (BFS over
 * 2-triangle edges) and outward for closed pieces (positive signed volume), fill open boundary
 * loops of <= holes edges (ear clipping in the loop's best-fit plane; the new faces take the
 * neighbouring triangle's material and UV map). -> {mesh, report}
 */
export function cleanupMesh(mesh, { weld = 1e-3, holes = 16, winding = true, area = 1e-10 } = {}) {
  const S = soupOf(mesh, { quant: 1 / Math.max(1e-6, weld) });
  const { P, np } = S;
  const T = Int32Array.from(S.T);
  const rep = { degenerate: 0, duplicates: 0, flipped: 0, reversed_pieces: 0, holes_filled: 0, hole_triangles: 0 };
  const alive = new Uint8Array(S.nt).fill(1);
  // degenerate (zero area)
  for (let t = 0; t < S.nt; t++) { const n = triNormal(P, T, t); if (len3(n) <= area) { alive[t] = 0; rep.degenerate++; } }
  // duplicates
  const seen = new Map();
  for (let t = 0; t < S.nt; t++) {
    if (!alive[t]) continue;
    const s = [T[t * 3], T[t * 3 + 1], T[t * 3 + 2]].sort((a, b) => a - b).join(',');
    if (seen.has(s)) {
      const o = seen.get(s);
      // same orientation: drop the copy; opposite: both are an internal double wall
      const sameDir = cyc(T, t, o);
      alive[t] = 0; rep.duplicates++;
      if (!sameDir && alive[o]) { alive[o] = 0; rep.duplicates++; }
    } else seen.set(s, t);
  }
  let live = [];
  for (let t = 0; t < S.nt; t++) if (alive[t]) live.push(t);
  // winding: BFS over manifold edges
  if (winding) {
    const E = edgeMap(T, np, live);
    const done = new Uint8Array(S.nt), comp = new Int32Array(S.nt).fill(-1);
    let nc = 0;
    for (const s of live) {
      if (done[s]) continue;
      const q = [s]; done[s] = 1; comp[s] = nc;
      while (q.length) {
        const t = q.pop();
        for (let k = 0; k < 3; k++) {
          const a = T[t * 3 + k], b = T[t * 3 + ((k + 1) % 3)];
          const l = E.get(ekey(a, b, np));
          if (!l || l.length !== 2) continue;
          const o = l[0] === t ? l[1] : l[0];
          if (done[o]) continue;
          // o must use the edge as b -> a
          let ok = false;
          for (let m = 0; m < 3; m++) if (T[o * 3 + m] === b && T[o * 3 + ((m + 1) % 3)] === a) ok = true;
          if (!ok) { const x = T[o * 3 + 1]; T[o * 3 + 1] = T[o * 3 + 2]; T[o * 3 + 2] = x; flipCorners(S, o); rep.flipped++; }
          done[o] = 1; comp[o] = nc; q.push(o);
        }
      }
      nc++;
    }
    // outward: signed volume per closed piece
    const vol = new Float64Array(nc), openC = new Uint8Array(nc);
    for (const [, l] of E) if (l.length !== 2) for (const t of l) openC[comp[t]] = 1;
    for (const t of live) {
      const a = pointOf(P, T[t * 3]), b = pointOf(P, T[t * 3 + 1]), c = pointOf(P, T[t * 3 + 2]);
      vol[comp[t]] += dot3(a, cross3(b, c)) / 6;
    }
    for (const t of live) if (!openC[comp[t]] && vol[comp[t]] < 0) { const x = T[t * 3 + 1]; T[t * 3 + 1] = T[t * 3 + 2]; T[t * 3 + 2] = x; flipCorners(S, t); }
    for (let c = 0; c < nc; c++) if (!openC[c] && vol[c] < 0) rep.reversed_pieces++;
  }
  // holes: boundary loops
  const extra = [];
  if (holes > 0) {
    const E = edgeMap(T, np, live);
    const nextOf = new Map(), triOf = new Map();
    for (const [, l] of E) {
      if (l.length !== 1) continue;
      const t = l[0];
      for (let k = 0; k < 3; k++) {
        const a = T[t * 3 + k], b = T[t * 3 + ((k + 1) % 3)];
        const l2 = E.get(ekey(a, b, np));
        if (l2.length === 1) { if (!nextOf.has(b)) { nextOf.set(b, a); triOf.set(b, t); } } // loop runs opposite to the faces
      }
    }
    const used = new Set();
    for (const s of [...nextOf.keys()].sort((a, b) => a - b)) {
      if (used.has(s)) continue;
      const loop = [s];
      used.add(s);
      let cur = nextOf.get(s), ok = true;
      while (cur !== s) {
        if (cur === undefined || used.has(cur) || loop.length > holes) { ok = false; break; }
        loop.push(cur); used.add(cur); cur = nextOf.get(cur);
      }
      if (!ok || loop.length < 3) continue;
      const tris = earClip(loop.map((i) => pointOf(P, i)));
      if (!tris) continue;
      const src = triOf.get(s);
      for (const [i, j, k] of tris) {
        const p = [loop[i], loop[j], loop[k]].map((x) => pointOf(P, x));
        const at = p.map((q) => attrsAt(S, src, q));
        const n = norm3(cross3(sub3(p[1], p[0]), sub3(p[2], p[0])));
        extra.push({ p, uv: at.map((x) => x.uv), n: [n, n, n], g: S.G[src], f: S.F[src], ...(S.C ? { c: at.map((x) => x.c) } : {}), ...(S.SJ ? { sj: at.map((x) => x.sj), sw: at.map((x) => x.sw) } : {}) });
      }
      rep.holes_filled++; rep.hole_triangles += tris.length;
    }
  }
  const S2 = { ...S, T };
  const out = live.map((t) => soupTri(S2, t)).concat(extra);
  rep.points = np; rep.corners = countCorners(mesh);
  return { mesh: meshFromTris(out, S.groups), report: rep };
}
const cyc = (T, a, b) => { // same cyclic order?
  const A = [T[a * 3], T[a * 3 + 1], T[a * 3 + 2]], B = [T[b * 3], T[b * 3 + 1], T[b * 3 + 2]];
  const k = B.indexOf(A[0]);
  return B[(k + 1) % 3] === A[1];
};
function flipCorners(S, t) {
  const sw = (arr, w) => { if (!arr) return; for (let c = 0; c < w; c++) { const x = arr[t * w * 3 + w + c]; arr[t * w * 3 + w + c] = arr[t * w * 3 + 2 * w + c]; arr[t * w * 3 + 2 * w + c] = x; } };
  sw(S.UV, 2); sw(S.N, 3); sw(S.C, 4); sw(S.SJ, 4); sw(S.SW, 4);
}
function countCorners(mesh) { let n = 0; for (const g of mesh.groups.values()) if (!g.overlay) n += g.pos.length / 3; return n; }

/** Ear clipping of a (roughly planar) 3D polygon. -> [[i, j, k]] | null */
export function earClip(pts) {
  let nrm = [0, 0, 0];
  for (let i = 0; i < pts.length; i++) { const a = pts[i], b = pts[(i + 1) % pts.length]; nrm[0] += (a[1] - b[1]) * (a[2] + b[2]); nrm[1] += (a[2] - b[2]) * (a[0] + b[0]); nrm[2] += (a[0] - b[0]) * (a[1] + b[1]); }
  if (len3(nrm) < 1e-12) return null;
  nrm = norm3(nrm);
  const ux = norm3(Math.abs(nrm[0]) < 0.9 ? cross3(nrm, [1, 0, 0]) : cross3(nrm, [0, 1, 0])), uy = cross3(nrm, ux);
  const q = pts.map((p) => [dot3(p, ux), dot3(p, uy)]);
  const idx = pts.map((_, i) => i), out = [];
  const ar = (a, b, c) => (q[b][0] - q[a][0]) * (q[c][1] - q[a][1]) - (q[c][0] - q[a][0]) * (q[b][1] - q[a][1]);
  let guard = 0;
  while (idx.length > 3 && guard++ < 10000) {
    let cut = false;
    for (let i = 0; i < idx.length; i++) {
      const a = idx[(i + idx.length - 1) % idx.length], b = idx[i], c = idx[(i + 1) % idx.length];
      if (ar(a, b, c) <= 1e-12) continue;
      let inside = false;
      for (const d of idx) {
        if (d === a || d === b || d === c) continue;
        if (ar(a, b, d) >= 0 && ar(b, c, d) >= 0 && ar(c, a, d) >= 0) { inside = true; break; }
      }
      if (inside) continue;
      out.push([a, b, c]); idx.splice(i, 1); cut = true; break;
    }
    if (!cut) return null;
  }
  if (idx.length === 3) out.push([idx[0], idx[1], idx[2]]);
  return out;
}

/** Morton code (30 bit) of a point normalized into [mn, mx]. */
export function morton(p, mn, ext) {
  const sp = (v) => { v = Math.max(0, Math.min(1023, Math.floor(v * 1023))); v = (v | (v << 16)) & 0x030000ff; v = (v | (v << 8)) & 0x0300f00f; v = (v | (v << 4)) & 0x030c30c3; v = (v | (v << 2)) & 0x09249249; return v; };
  return (sp((p[0] - mn[0]) / ext[0]) * 4 + sp((p[1] - mn[1]) / ext[1]) * 2 + sp((p[2] - mn[2]) / ext[2])) >>> 0;
}

/** Axis-aligned bounds of a soup's points. */
export function soupBounds(S) {
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < S.np; i++) for (let k = 0; k < 3; k++) { const v = S.P[i * 3 + k]; if (v < mn[k]) mn[k] = v; if (v > mx[k]) mx[k] = v; }
  return { min: mn, max: mx, diag: Math.hypot(mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]) };
}
