// Cluster LOD ("nanite-like") for art_model cluster_lod: the mesh is split into ~128-triangle
// clusters (meshlets) with bounds spheres and normal cones; clusters are grouped (~4, by shared
// edges), each group is simplified to half with its outer border locked, re-split into clusters,
// and so on until one cluster (or nothing simplifies) - a DAG. Every cluster stores its own error
// and lod sphere (= those of the group it was made from) and its parent group's error and sphere,
// so a runtime can pick a crack-free cut per frame by screen-space error (clodselect.js).
// Errors are geometric (px here, units in the file): the sampled one-sided distance of the group
// before -> after simplification, accumulated up the DAG (child max + own), so they are monotonic
// and bound the distance to the full-detail mesh. Classic discrete LODs come from uniform-error
// cuts of the same hierarchy, split into parts of <= max_part_tris (Roblox MeshPart limit 20k).
import { soupOf, pointOf, morton, ekey, soupBounds, meshFromTris, cross3, sub3, len3, norm3, dot3 } from './meshkit.js';
import { simplifySoup } from './simplify.js';
import { CLOD_MAGIC, CLUSTER_STRIDE, RANGE_STRIDE, NONE } from './clodselect.js';

/** Smallest-ish sphere around points (Ritter + a refinement pass). */
function sphereOf(pts) {
  if (!pts.length) return [0, 0, 0, 0];
  let a = pts[0], b = a, best = -1;
  for (const p of pts) { const d = (p[0] - a[0]) ** 2 + (p[1] - a[1]) ** 2 + (p[2] - a[2]) ** 2; if (d > best) { best = d; b = p; } }
  let c = b; best = -1;
  for (const p of pts) { const d = (p[0] - b[0]) ** 2 + (p[1] - b[1]) ** 2 + (p[2] - b[2]) ** 2; if (d > best) { best = d; c = p; } }
  let ctr = [(b[0] + c[0]) / 2, (b[1] + c[1]) / 2, (b[2] + c[2]) / 2], r = Math.sqrt(best) / 2;
  for (const p of pts) {
    const d = Math.hypot(p[0] - ctr[0], p[1] - ctr[1], p[2] - ctr[2]);
    if (d > r) { const nr = (r + d) / 2, k = (nr - r) / d; ctr = [ctr[0] + (p[0] - ctr[0]) * k, ctr[1] + (p[1] - ctr[1]) * k, ctr[2] + (p[2] - ctr[2]) * k]; r = nr; }
  }
  return [ctr[0], ctr[1], ctr[2], r * (1 + 1e-6) + 1e-9];
}
/** Sphere enclosing spheres [x, y, z, r]. */
function mergeSpheres(list) {
  let s = list[0].slice();
  for (const q of list.slice(1)) {
    const d = Math.hypot(q[0] - s[0], q[1] - s[1], q[2] - s[2]);
    if (d + q[3] <= s[3]) continue;
    if (d + s[3] <= q[3]) { s = q.slice(); continue; }
    const r = (d + s[3] + q[3]) / 2, k = (r - s[3]) / d;
    s = [s[0] + (q[0] - s[0]) * k, s[1] + (q[1] - s[1]) * k, s[2] + (q[2] - s[2]) * k, r];
  }
  s[3] = s[3] * (1 + 1e-6) + 1e-9;
  return s;
}

/**
 * Build the cluster DAG. opts: {clusterSize = 128, groupSize = 4, maxLevels = 24, seams (true),
 * featureAngle (0)}. -> {tris (all triangle records, point ids), clusters: [{tris, level, error,
 * lod, parentError, parentLod, group, parentGroup, bounds, cone}], groups, S, stats}
 */
export function buildClusterDAG(mesh, opts = {}) {
  const t0 = performance.now();
  const S = soupOf(mesh);
  if (!S.nt) throw new Error('cluster_lod: the model has no triangles');
  const CS = Math.max(16, Math.min(256, Math.round(Number(opts.clusterSize ?? 128))));
  const GS = Math.max(2, Math.min(32, Math.round(Number(opts.groupSize ?? 4))));
  const bb = soupBounds(S), ext = bb.max.map((v, k) => Math.max(1e-6, v - bb.min[k]));
  const TR = [];
  for (let t = 0; t < S.nt; t++) {
    const r = { p: [S.T[t * 3], S.T[t * 3 + 1], S.T[t * 3 + 2]], uv: [0, 1, 2].map((k) => [S.UV[t * 6 + k * 2], S.UV[t * 6 + k * 2 + 1]]), n: [0, 1, 2].map((k) => [S.N[t * 9 + k * 3], S.N[t * 9 + k * 3 + 1], S.N[t * 9 + k * 3 + 2]]), g: S.G[t], f: S.F[t] };
    if (S.C) r.c = [0, 1, 2].map((k) => Array.from(S.C.subarray(t * 12 + k * 4, t * 12 + k * 4 + 4)));
    if (S.SJ) { r.sj = [0, 1, 2].map((k) => Array.from(S.SJ.subarray(t * 12 + k * 4, t * 12 + k * 4 + 4))); r.sw = [0, 1, 2].map((k) => Array.from(S.SW.subarray(t * 12 + k * 4, t * 12 + k * 4 + 4))); }
    TR.push(r);
  }
  const P = S.P, np = S.np;
  const cen = (r) => [0, 1, 2].map((k) => (P[r.p[0] * 3 + k] + P[r.p[1] * 3 + k] + P[r.p[2] * 3 + k]) / 3);
  // ---- meshlets: greedy growth over edge adjacency, seeded in Morton order
  const meshlets = (ids) => {
    const E = new Map();
    for (const t of ids) for (let k = 0; k < 3; k++) { const key = ekey(TR[t].p[k], TR[t].p[(k + 1) % 3], np); const l = E.get(key); if (l) l.push(t); else E.set(key, [t]); }
    const C = new Map(ids.map((t) => [t, cen(TR[t])]));
    const order = ids.slice().sort((a, b) => morton(C.get(a), bb.min, ext) - morton(C.get(b), bb.min, ext) || a - b);
    const done = new Set(), out = [];
    for (const seed of order) {
      if (done.has(seed)) continue;
      const cl = [seed], pts = new Set(TR[seed].p);
      done.add(seed);
      const ctr = C.get(seed).slice();
      const front = new Set();
      const addFront = (t) => { for (let k = 0; k < 3; k++) for (const o of E.get(ekey(TR[t].p[k], TR[t].p[(k + 1) % 3], np))) if (!done.has(o)) front.add(o); };
      addFront(seed);
      while (cl.length < CS && front.size) {
        let best = -1, bs = -Infinity;
        for (const t of front) {
          const shared = TR[t].p.reduce((s, p) => s + (pts.has(p) ? 1 : 0), 0), c = C.get(t);
          const d = Math.hypot(c[0] - ctr[0], c[1] - ctr[1], c[2] - ctr[2]);
          const sc = shared * 1e6 - d;
          if (sc > bs || (sc === bs && t < best)) { bs = sc; best = t; }
        }
        front.delete(best);
        if (done.has(best)) continue;
        done.add(best); cl.push(best);
        for (const p of TR[best].p) pts.add(p);
        const c = C.get(best);
        for (let k = 0; k < 3; k++) ctr[k] += (c[k] - ctr[k]) / cl.length;
        addFront(best);
      }
      out.push(cl);
    }
    return out;
  };
  const clusters = [], groups = [];
  const triPts = (ids) => { const s = new Set(); for (const t of ids) for (const p of TR[t].p) s.add(p); return [...s].map((i) => pointOf(P, i)); };
  const makeCluster = (ids, level, err, lod, group) => {
    const b = sphereOf(triPts(ids));
    // normal cone: area-weighted mean normal, half angle to the farthest triangle normal
    let ax = [0, 0, 0];
    const ns = ids.map((t) => { const [A, B, Cc] = TR[t].p.map((i) => pointOf(P, i)), n = cross3(sub3(B, A), sub3(Cc, A)); ax = [ax[0] + n[0], ax[1] + n[1], ax[2] + n[2]]; return norm3(n); });
    ax = norm3(ax);
    let minDot = 1;
    for (const n of ns) minDot = Math.min(minDot, dot3(n, ax));
    const sinA = minDot <= 0 || len3(ax) < 0.5 ? 2 : Math.sqrt(Math.max(0, 1 - minDot * minDot));
    const c = { id: clusters.length, tris: ids, level, error: err, lod, parentError: Infinity, parentLod: lod, group, parentGroup: -1, bounds: b, cone: { axis: ax, cutoff: sinA } };
    clusters.push(c);
    return c;
  };
  let frontier = meshlets(Array.from({ length: S.nt }, (_, i) => i)).map((ids) => { const c = makeCluster(ids, 0, 0, null, -1); c.lod = c.bounds.slice(); c.parentLod = c.lod; return c; });
  const locked = new Uint8Array(np);
  let level = 0, simplified = 0, seamless = 0;
  const maxLevels = Math.max(1, Math.min(64, Math.round(Number(opts.maxLevels ?? 24))));
  while (frontier.length > 1 && level < maxLevels) {
    level++;
    // cluster adjacency by shared edges
    const owner = new Map();
    frontier.forEach((c, ci) => { for (const t of c.tris) for (let k = 0; k < 3; k++) { const key = ekey(TR[t].p[k], TR[t].p[(k + 1) % 3], np); const l = owner.get(key); if (l) { if (!l.includes(ci)) l.push(ci); } else owner.set(key, [ci]); } });
    const adj = frontier.map(() => new Map());
    for (const l of owner.values()) for (let a = 0; a < l.length; a++) for (let b = a + 1; b < l.length; b++) { adj[l[a]].set(l[b], (adj[l[a]].get(l[b]) || 0) + 1); adj[l[b]].set(l[a], (adj[l[b]].get(l[a]) || 0) + 1); }
    const ptTris = new Map();
    for (const c of frontier) for (const t of c.tris) for (const p of TR[t].p) { const l = ptTris.get(p); if (l) l.push(t); else ptTris.set(p, [t]); }
    const fo = frontier.map((c, ci) => ci).sort((a, b) => morton(frontier[a].bounds, bb.min, ext) - morton(frontier[b].bounds, bb.min, ext) || a - b);
    const gOf = new Int32Array(frontier.length).fill(-1), gl = [];
    for (const s of fo) {
      if (gOf[s] >= 0) continue;
      const g = [s]; gOf[s] = gl.length;
      while (g.length < GS) {
        let best = -1, bw = 0;
        for (const ci of g) for (const [o, w] of adj[ci]) if (gOf[o] < 0) { const tw = g.reduce((sum, x) => sum + (adj[x].get(o) || 0), 0); if (tw > bw || (tw === bw && o < best)) { bw = tw; best = o; } }
        if (best < 0) {
          // disconnected neighbours (greebles): the nearest ungrouped cluster within reach
          const cs = frontier[s].bounds;
          let bd = Infinity;
          for (const o of fo) if (gOf[o] < 0) { const q = frontier[o].bounds, d = Math.hypot(q[0] - cs[0], q[1] - cs[1], q[2] - cs[2]) - q[3] - cs[3]; if (d < bd && d < cs[3] * 2) { bd = d; best = o; } }
          if (best < 0) break;
        }
        g.push(best); gOf[best] = gl.length;
      }
      gl.push(g);
    }
    const next = [];
    let progress = false;
    for (const g of gl) {
      const members = g.map((ci) => frontier[ci]);
      const ids = members.flatMap((c) => c.tris);
      // lock the group border (edges shared with triangles outside the group) and open borders
      const inG = new Set(g);
      const lockedList = [];
      for (const c of members) for (const t of c.tris) for (let k = 0; k < 3; k++) {
        const a = TR[t].p[k], b = TR[t].p[(k + 1) % 3], l = owner.get(ekey(a, b, np));
        if (l.some((ci) => !inG.has(ci))) { if (!locked[a]) { locked[a] = 1; lockedList.push(a); } if (!locked[b]) { locked[b] = 1; lockedList.push(b); } }
      }
      // neighbouring triangles around the locked border join as frozen context (link condition)
      const own = new Set(ids), ctx = new Set();
      for (const p of lockedList) for (const t of ptTris.get(p) || []) if (!own.has(t)) ctx.add(t);
      const ctxList = [...ctx].sort((a, b) => a - b);
      const sub = subSoup(S, TR, [...ids, ...ctxList]);
      const ownIdx = ids.map((_, k) => k), ctxIdx = ctxList.map((_, k) => ids.length + k);
      const so = { tris: ownIdx, context: ctxIdx, target: Math.floor(ids.length / 2), locked, lockBorders: true, measure: true, seams: opts.seams !== false, featureAngle: Number(opts.featureAngle ?? 0) };
      let r = simplifySoup(sub, so);
      // a group pinned by UV / normal seams (flat-shaded, world-tiled pixel art) retries with the
      // seams free: far levels trade texture seams for triangles, material borders still hold
      if (r.tris.length > ids.length * 0.85 && so.seams && opts.seams !== 'strict') { r = simplifySoup(sub, { ...so, seams: false }); if (r.tris.length <= ids.length * 0.85) seamless++; }
      for (const p of lockedList) locked[p] = 0;
      if (r.tris.length > ids.length * 0.85 || !r.tris.length) { for (const c of members) next.push(c); continue; }
      progress = true; simplified++;
      const gid = groups.length;
      const err = Math.max(...members.map((c) => c.error)) + (r.error || 0);
      const lod = mergeSpheres(members.map((c) => c.lod));
      groups.push({ id: gid, level, children: members.map((c) => c.id), error: err, lod, before: ids.length, after: r.tris.length });
      for (const c of members) { c.parentError = err; c.parentLod = lod; c.parentGroup = gid; }
      const base = TR.length;
      for (const t of r.tris) TR.push(t);
      const made = meshlets(r.tris.map((_, k) => base + k));
      groups[gid].clusters = [];
      for (const m of made) { const c = makeCluster(m, level, err, lod, gid); groups[gid].clusters.push(c.id); next.push(c); }
    }
    frontier = next;
    if (!progress) break;
  }
  const leaves = clusters.filter((c) => c.level === 0).length, roots = clusters.filter((c) => c.parentError === Infinity);
  return {
    TR, S, clusters, groups,
    stats: { triangles: S.nt, clusters: clusters.length, leaf_clusters: leaves, roots: roots.length, groups: groups.length, levels: level, root_triangles: roots.reduce((s, c) => s + c.tris.length, 0), max_cluster_triangles: Math.max(...clusters.map((c) => c.tris.length)), root_error_px: Math.max(...roots.map((c) => c.error)), cluster_size: CS, group_size: GS, seam_free_groups: seamless, ms: Math.round(performance.now() - t0) },
  };
}

/** Soup over triangle records (point ids into S.P) for simplifySoup. */
function subSoup(S, TR, ids) {
  const n = ids.length, T = new Int32Array(n * 3), G = new Int32Array(n), F = new Array(n), UV = new Float64Array(n * 6), N = new Float64Array(n * 9);
  const C = S.C ? new Float32Array(n * 12) : null, SJ = S.SJ ? new Uint16Array(n * 12) : null, SW = S.SJ ? new Float32Array(n * 12) : null;
  ids.forEach((t, q) => {
    const r = TR[t];
    for (let k = 0; k < 3; k++) {
      T[q * 3 + k] = r.p[k]; UV[q * 6 + k * 2] = r.uv[k][0]; UV[q * 6 + k * 2 + 1] = r.uv[k][1];
      for (let c = 0; c < 3; c++) N[q * 9 + k * 3 + c] = r.n[k][c];
      if (C) for (let c = 0; c < 4; c++) C[q * 12 + k * 4 + c] = r.c[k][c];
      if (SJ) for (let c = 0; c < 4; c++) { SJ[q * 12 + k * 4 + c] = r.sj[k][c]; SW[q * 12 + k * 4 + c] = r.sw[k][c]; }
    }
    G[q] = r.g; F[q] = r.f;
  });
  return { P: S.P, np: S.np, T, nt: n, G, F, UV, N, C, SJ, SW, groups: S.groups };
}

/** Clusters of a camera-independent cut at geometric error tau (px): error <= tau < parentError. */
export function uniformCut(dag, tau) { return dag.clusters.filter((c) => c.error <= tau && c.parentError > tau); }

/**
 * Discrete LODs from the DAG: LOD0 = the leaf clusters, then the cut whose triangle count is
 * closest to below source * ratio^i. -> [{level, tau (px), clusters, triangles}]
 */
export function discreteLods(dag, { levels = 4, ratio = 0.5 } = {}) {
  const errs = [...new Set(dag.clusters.map((c) => c.error))].sort((a, b) => a - b);
  const count = (tau) => uniformCut(dag, tau).reduce((s, c) => s + c.tris.length, 0);
  const out = [{ level: 0, tau: -1, clusters: dag.clusters.filter((c) => c.level === 0), triangles: dag.stats.triangles }];
  let last = dag.stats.triangles;
  for (let i = 1; i < levels; i++) {
    const target = dag.stats.triangles * ratio ** i;
    let pick = null;
    for (const e of errs) { const n = count(e); if (n <= target) { pick = e; break; } }
    if (pick === null) pick = errs[errs.length - 1];
    const cl = uniformCut(dag, pick), n = cl.reduce((s, c) => s + c.tris.length, 0);
    if (n >= last) break;
    out.push({ level: i, tau: pick, clusters: cl, triangles: n });
    last = n;
  }
  return out;
}

/** Split a list of clusters into parts of <= maxTris triangles (Morton order of cluster centres). */
export function splitParts(dag, clusters, maxTris = 20000) {
  const b = soupBounds(dag.S), ext = b.max.map((v, k) => Math.max(1e-6, v - b.min[k]));
  const order = clusters.slice().sort((x, y) => morton(x.bounds, b.min, ext) - morton(y.bounds, b.min, ext) || x.id - y.id);
  const parts = [];
  let cur = [], n = 0;
  for (const c of order) {
    if (n + c.tris.length > maxTris && cur.length) { parts.push(cur); cur = []; n = 0; }
    cur.push(c); n += c.tris.length;
  }
  if (cur.length) parts.push(cur);
  return parts;
}

/** Mesh (px) of a set of clusters (face records of the source; optional per-cluster colour material). */
export function clustersMesh(dag, clusters, { colorTex = null } = {}) {
  const recs = [];
  for (const c of clusters) for (const t of c.tris) {
    const r = dag.TR[t];
    recs.push({ ...r, p: r.p.map((i) => pointOf(dag.S.P, i)), ...(colorTex ? { g: -1 - c.id } : {}) });
  }
  if (!colorTex) return meshFromTris(recs, dag.S.groups);
  const groups = new Map();
  const gl = [];
  for (const r of recs) { const id = -1 - r.g; if (!groups.has(id)) { groups.set(id, gl.length); gl.push({ tex: colorTex(id) }); } r.g = groups.get(id); }
  return meshFromTris(recs, gl);
}

/**
 * Serialize the DAG to a .clod buffer (format: docs/meshproc/README.md). scale = px per unit.
 * extra = JSON fields merged in (lods, visibility, screen). -> Buffer
 */
export function writeClod(dag, { scale = 32, extra = {} } = {}) {
  const { clusters, TR, S } = dag;
  const pos = [], nrm = [], uvs = [], col = S.C ? [] : null, idx = [], ranges = [];
  const recs = new ArrayBuffer(clusters.length * CLUSTER_STRIDE), F = new Float32Array(recs), U = new Uint32Array(recs);
  clusters.forEach((c, ci) => {
    const o = (ci * CLUSTER_STRIDE) / 4;
    const firstV = pos.length / 3, firstI = idx.length, firstR = ranges.length;
    const tris = c.tris.slice().sort((a, b) => TR[a].g - TR[b].g || a - b);
    const vmap = new Map(), cr = [];
    let rg = null;
    tris.forEach((t, k) => {
      const r = TR[t];
      if (!rg || rg[0] !== r.g) { rg = [r.g, k, 0]; cr.push(rg); }
      rg[2]++;
      for (let q = 0; q < 3; q++) {
        const p = r.p[q], key = `${p}|${r.uv[q][0]},${r.uv[q][1]}|${r.n[q][0]},${r.n[q][1]},${r.n[q][2]}${col ? `|${r.c[q].join(',')}` : ''}`;
        let v = vmap.get(key);
        if (v === undefined) {
          v = vmap.size; vmap.set(key, v);
          pos.push(S.P[p * 3] / scale, S.P[p * 3 + 1] / scale, S.P[p * 3 + 2] / scale); nrm.push(...r.n[q]); uvs.push(r.uv[q][0], r.uv[q][1]);
          if (col) col.push(...r.c[q]);
        }
        idx.push(v);
      }
    });
    for (const x of cr) ranges.push(x);
    const b = c.bounds.map((v, k) => v / scale), lod = c.lod.map((v) => v / scale), plod = c.parentLod.map((v) => v / scale);
    F[o] = b[0]; F[o + 1] = b[1]; F[o + 2] = b[2]; F[o + 3] = b[3];
    F[o + 4] = c.cone.axis[0]; F[o + 5] = c.cone.axis[1]; F[o + 6] = c.cone.axis[2]; F[o + 7] = c.cone.cutoff;
    F[o + 8] = lod[0]; F[o + 9] = lod[1]; F[o + 10] = lod[2]; F[o + 11] = lod[3];
    F[o + 12] = c.error / scale; F[o + 13] = c.parentError === Infinity ? Infinity : c.parentError / scale;
    F[o + 14] = plod[0]; F[o + 15] = plod[1]; F[o + 16] = plod[2]; F[o + 17] = plod[3];
    U[o + 18] = firstV; U[o + 19] = pos.length / 3 - firstV; U[o + 20] = firstI; U[o + 21] = c.tris.length;
    U[o + 22] = 0; U[o + 23] = 0; // set below (ranges are collected as triples)
    U[o + 24] = c.level; U[o + 25] = c.group < 0 ? NONE : c.group; U[o + 26] = c.parentGroup < 0 ? NONE : c.parentGroup;
    U[o + 27] = (c.parentError === Infinity ? 1 : 0) | (c.level === 0 ? 2 : 0);
    c._range = [firstR, cr.length];
    if (vmap.size > 65535) throw new Error('cluster has more than 65535 vertices');
  });
  // ranges: [material, first triangle (cluster relative), count]
  const R = new Uint32Array(ranges.length * 3);
  ranges.forEach((r, i) => { R[i * 3] = r[0]; R[i * 3 + 1] = r[1]; R[i * 3 + 2] = r[2]; });
  clusters.forEach((c, ci) => { const o = (ci * CLUSTER_STRIDE) / 4; U[o + 22] = c._range[0]; U[o + 23] = c._range[1]; delete c._range; });
  const parts = [], views = {};
  let off = 0;
  const put = (name, arr, extraInfo) => {
    const bytes = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
    const pad = (4 - (bytes.length % 4)) % 4;
    views[name] = { offset: off, byteLength: bytes.length, ...extraInfo };
    parts.push(Buffer.from(bytes)); if (pad) parts.push(Buffer.alloc(pad));
    off += bytes.length + pad;
  };
  put('clusters', new Uint8Array(recs), { count: clusters.length, stride: CLUSTER_STRIDE });
  put('positions', new Float32Array(pos), { count: pos.length / 3, type: 'f32x3' });
  put('normals', new Float32Array(nrm), { count: nrm.length / 3, type: 'f32x3' });
  put('uvs', new Float32Array(uvs), { count: uvs.length / 2, type: 'f32x2' });
  if (col) put('colors', new Float32Array(col), { count: col.length / 4, type: 'f32x4' });
  put('indices', new Uint16Array(idx), { count: idx.length, type: 'u16 (cluster-local: add the cluster first vertex)' });
  put('ranges', R, { count: ranges.length, stride: RANGE_STRIDE, type: 'u32 material, u32 first triangle (cluster relative), u32 triangle count' });
  const json = {
    format: 'agent-art cluster LOD', version: 1, units: 'glTF units (px / px_per_unit), +Y up', px_per_unit: scale,
    counts: { clusters: clusters.length, groups: dag.groups.length, vertices: pos.length / 3, indices: idx.length, ranges: ranges.length, levels: dag.stats.levels },
    cluster_size: dag.stats.cluster_size, group_size: dag.stats.group_size,
    materials: S.groups.map((g, i) => ({ index: i, name: g.tex.name || g.tex.key, key: g.tex.key })),
    cluster_fields: CLUSTER_FIELDS, views,
    root_error: Math.max(...clusters.filter((c) => c.parentError === Infinity).map((c) => c.error)) / scale,
    ...extra,
  };
  let js = Buffer.from(JSON.stringify(json));
  if (js.length % 4) js = Buffer.concat([js, Buffer.alloc(4 - (js.length % 4), 0x20)]);
  const bin = Buffer.concat(parts);
  const head = Buffer.alloc(12), ch = (n, type) => { const b = Buffer.alloc(8); b.writeUInt32LE(n, 0); b.writeUInt32LE(type, 4); return b; };
  head.writeUInt32LE(CLOD_MAGIC, 0); head.writeUInt32LE(1, 4); head.writeUInt32LE(12 + 8 + js.length + 8 + bin.length, 8);
  return Buffer.concat([head, ch(js.length, 0x4e4f534a), js, ch(bin.length, 0x004e4942), bin]);
}

/** Field table of the 112-byte cluster record (byte offset, type, meaning). */
export const CLUSTER_FIELDS = [
  [0, 'f32x3', 'bounds centre (culling sphere)'], [12, 'f32', 'bounds radius'],
  [16, 'f32x3', 'normal cone axis'], [28, 'f32', 'normal cone cutoff = sin(half angle); >= 1 = never cone-culled'],
  [32, 'f32x3', 'lod sphere centre (own)'], [44, 'f32', 'lod sphere radius'],
  [48, 'f32', 'error (units; 0 = full detail)'], [52, 'f32', 'parent error (units; +Infinity = root)'],
  [56, 'f32x3', 'parent lod sphere centre'], [68, 'f32', 'parent lod sphere radius'],
  [72, 'u32', 'first vertex'], [76, 'u32', 'vertex count'], [80, 'u32', 'first index'], [84, 'u32', 'triangle count'],
  [88, 'u32', 'first material range'], [92, 'u32', 'material range count'],
  [96, 'u32', 'level (0 = leaf)'], [100, 'u32', 'group it was made from (0xFFFFFFFF = leaf)'], [104, 'u32', 'parent group (0xFFFFFFFF = root)'], [108, 'u32', 'flags: 1 root, 2 leaf'],
];
