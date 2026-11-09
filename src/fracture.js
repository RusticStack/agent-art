// Pre-fractured breakables for art_model: a closed part is cut into N convex-cell chunks (seeded
// Voronoi cells, or recursive plane slices), each chunk = BSP intersect (csg.js) of the part with
// one cell, so chunks are watertight and their volumes add up to the part. Interior faces come
// from the cell walls and carry the "inside" material. Debris: the biggest chunks split again
// (level 2). Per chunk: volume, mass estimate, centre of mass, bounds, convex collision hull.
// Robust booleans / voxel remesh (PR #19 mesh-processing) can replace csg.js here for big parts.
import { Mesh } from './model3d.js';
import { booleanMesh, manifoldStats } from './csg.js';
import { convexHull, hullMesh } from './proxies.js';
import { mulberry32 } from './util.js';
import { faceBasis } from './ctm.js';
import { closeOpenMesh } from './remesh.js';
import { unionAll } from './meshbool.js';
import { manifoldReport } from './meshkit.js';

const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const norm = (a) => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

export const FRACTURE_METHODS = ['voronoi', 'slice'];

/** Signed volume (px^3) and centre of mass of a closed mesh (base groups). */
export function meshVolume(mesh) {
  let V = 0;
  const c = [0, 0, 0];
  for (const g of mesh.groups.values()) {
    if (g.overlay) continue;
    for (let i = 0; i < g.idx.length; i += 3) {
      const P = [0, 1, 2].map((k) => { const v = g.idx[i + k]; return [g.pos[v * 3], g.pos[v * 3 + 1], g.pos[v * 3 + 2]]; });
      const v = dot(P[0], cross(P[1], P[2])) / 6;
      V += v;
      for (let k = 0; k < 3; k++) c[k] += v * (P[0][k] + P[1][k] + P[2][k]) / 4;
    }
  }
  return { volume: V, center: Math.abs(V) > 1e-12 ? c.map((x) => x / V) : [0, 0, 0] };
}

// ---------- convex cells (list of outward polygons) ----------
function boxCell(min, max) {
  const [x0, y0, z0] = min, [x1, y1, z1] = max;
  return [
    [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], [[x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]],
    [[x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]], [[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]],
    [[x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]], [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]],
  ];
}
/** Keep the part of a convex cell with dot(n, x) <= w; the cut gets a cap polygon (outward = n). */
export function clipCell(faces, n, w, eps = 1e-7) {
  const out = [], cut = [];
  for (const F of faces) {
    const kept = [];
    for (let i = 0; i < F.length; i++) {
      const a = F[i], b = F[(i + 1) % F.length], da = dot(n, a) - w, db = dot(n, b) - w;
      if (da <= eps) kept.push(a);
      if (Math.abs(da) <= eps) cut.push(a);
      if ((da < -eps && db > eps) || (da > eps && db < -eps)) { const p = add(a, mul(sub(b, a), da / (da - db))); kept.push(p); cut.push(p); }
    }
    const k = dedupe(kept);
    if (k.length >= 3) out.push(k);
  }
  const c = dedupe(cut);
  if (c.length >= 3) {
    const ctr = mul(c.reduce(add, [0, 0, 0]), 1 / c.length);
    const { t, b } = faceBasis(n);
    // basis (t, b) with t x b = n: counter-clockwise in it faces +n
    const sgn = dot(cross(t, b), n) > 0 ? 1 : -1;
    c.sort((p, q) => sgn * (Math.atan2(dot(sub(p, ctr), b), dot(sub(p, ctr), t)) - Math.atan2(dot(sub(q, ctr), b), dot(sub(q, ctr), t))));
    out.push(c);
  }
  return out;
}
function dedupe(P) {
  const out = [];
  for (const p of P) if (!out.some((q) => len(sub(p, q)) < 1e-6)) out.push(p);
  return out;
}
const cellVolume = (faces) => {
  let V = 0;
  for (const F of faces) for (let i = 1; i + 1 < F.length; i++) V += dot(F[0], cross(F[i], F[i + 1])) / 6;
  return V;
};
const cellCenter = (faces) => { const pts = faces.flat(); return mul(pts.reduce(add, [0, 0, 0]), 1 / pts.length); };
/** Cell polygons -> closed Mesh with the inside texture (planar world UVs, 1 texel = 1 px). */
function cellMesh(faces, tex) {
  const m = new Mesh();
  for (const F of faces) {
    let n = [0, 0, 0];
    for (let i = 1; i + 1 < F.length; i++) n = add(n, cross(sub(F[i], F[0]), sub(F[i + 1], F[0])));
    if (len(n) < 1e-9) continue;
    n = norm(n);
    const { t, b } = faceBasis(n);
    m.face(tex, F, n, F.map((p) => [dot(p, t) / (tex.width || 1), -dot(p, b) / (tex.height || 1)]), n, 0);
  }
  return m;
}

/** Point inside a closed mesh (ray parity along a skewed direction). */
function inside(tris, p) {
  const d = norm([0.5773, 0.5779, 0.5767]);
  let hits = 0;
  for (const [A, B, C] of tris) {
    const e1 = sub(B, A), e2 = sub(C, A), h = cross(d, e2), a = dot(e1, h);
    if (Math.abs(a) < 1e-12) continue;
    const f = 1 / a, s = sub(p, A), u = f * dot(s, h);
    if (u < 0 || u > 1) continue;
    const q = cross(s, e1), v = f * dot(d, q);
    if (v < 0 || u + v > 1) continue;
    if (f * dot(e2, q) > 1e-9) hits++;
  }
  return hits % 2 === 1;
}
const trisOf = (mesh) => { const T = []; for (const g of mesh.groups.values()) { if (g.overlay) continue; for (let i = 0; i < g.idx.length; i += 3) T.push([0, 1, 2].map((k) => { const v = g.idx[i + k]; return [g.pos[v * 3], g.pos[v * 3 + 1], g.pos[v * 3 + 2]]; })); } return T; };

/** Convex cells covering the box [min, max]: seeded Voronoi (sites inside the solid) or plane slices. */
function cells(mesh, min, max, { pieces, method, seed }) {
  const rnd = mulberry32((seed * 2246822519) ^ 0x27d4eb2f);
  const lo = min.map((v) => v - 1), hi = max.map((v) => v + 1);
  const size = sub(max, min);
  if (method === 'slice') {
    let list = [boxCell(lo, hi)];
    let guard = 0;
    while (list.length < pieces && guard++ < pieces * 8) {
      // split the biggest cell by a plane through a point near its centre, normal mostly across its longest extent
      list.sort((A, B) => cellVolume(B) - cellVolume(A));
      const C = list[0], pts = C.flat();
      const cmin = [0, 1, 2].map((k) => Math.min(...pts.map((p) => p[k]))), cmax = [0, 1, 2].map((k) => Math.max(...pts.map((p) => p[k])));
      const ext = sub(cmax, cmin), ax = ext.indexOf(Math.max(...ext));
      const nrm = [rnd() - 0.5, rnd() - 0.5, rnd() - 0.5].map((v, k) => (k === ax ? v + (rnd() < 0.5 ? -1.6 : 1.6) : v * 0.9));
      const n = norm(nrm), o = add(cellCenter(C), mul(ext, (rnd() - 0.5) * 0.35));
      const A = clipCell(C, n, dot(n, o)), B = clipCell(C, mul(n, -1), -dot(n, o));
      if (A.length < 4 || B.length < 4) continue;
      list = [A, B, ...list.slice(1)];
    }
    return list;
  }
  // voronoi: rejection-sample sites inside the solid
  const T = trisOf(mesh), sites = [];
  for (let tries = 0; sites.length < pieces && tries < pieces * 60; tries++) {
    const p = [0, 1, 2].map((k) => min[k] + size[k] * (0.04 + 0.92 * rnd()));
    if (inside(T, p) && !sites.some((q) => len(sub(p, q)) < 0.4)) sites.push(p);
  }
  while (sites.length < pieces) sites.push([0, 1, 2].map((k) => min[k] + size[k] * (0.1 + 0.8 * rnd())));
  return sites.map((s, i) => {
    let C = boxCell(lo, hi);
    for (let j = 0; j < sites.length; j++) {
      if (j === i) continue;
      const n = norm(sub(sites[j], s)), m = mul(add(s, sites[j]), 0.5);
      C = clipCell(C, n, dot(n, m));
      if (C.length < 4) break;
    }
    return C;
  }).filter((C) => C.length >= 4);
}

/**
 * Fracture a closed part mesh. opts: {pieces 2..64, method voronoi|slice, seed, inside (texture),
 * debris (number of the biggest chunks split again into 3), density (mass per unit^3), scale (px
 * per unit), name, close ('auto' default: an open / non-manifold part is closed first by the cleanup
 * path, then a voxel remesh; false = refuse open parts)}. -> {chunks:[{name, level, parent, mesh,
 * volume_px3, center, min, max, hull}], volume_px3, error, closed?: {method, before, after}}
 */
export function fracturePart(mesh0, opts) {
  const pieces = Math.max(2, Math.min(64, Math.round(Number(opts.pieces ?? 8))));
  const method = opts.method ?? 'voronoi';
  if (!FRACTURE_METHODS.includes(method)) throw new Error(`fracture method must be ${FRACTURE_METHODS.join(' or ')}`);
  const seed = Math.round(Number(opts.seed ?? 1));
  // booleans: csg.js booleanMesh (#19): "auto" = BSP for small parts, the robust BVH / arrangement path
  // (meshbool.js) above ROBUST_THRESHOLD input triangles; "bsp" / "robust" force one
  const boolMethod = opts.boolean ?? 'auto';
  const ms = manifoldStats(mesh0);
  let mesh = mesh0, closed = null;
  if (ms.open || ms.nonManifold) {
    const close = opts.close ?? 'auto';
    const hint = `fracture boxes, cylinders, wedges, extrusions; merge:true or a boolean union first for assemblies`;
    if (close === false) throw new Error(`fracture: part "${opts.name}" is not a closed solid (${ms.open} open edges, ${ms.nonManifold} non-manifold) and close:false: ${hint}, or drop close:false to close it automatically`);
    closed = closeOpenMesh(mesh0, { voxel: close !== 'cleanup' });
    if (!closed) throw new Error(`fracture: part "${opts.name}" is not a closed solid (${ms.open} open edges, ${ms.nonManifold} non-manifold) and could not be closed (cleanup hole fill and voxel remesh failed): ${hint}`);
    mesh = closed.mesh;
  }
  // a part built from several touching closed shells (a column = plinth + shaft + capital) is united
  // first: cut separately, the shells of a chunk would touch along non-manifold edges
  let merged = null;
  const shells = manifoldReport(mesh).components;
  if (shells > 1) {
    try {
      const u = unionAll(mesh).mesh, us = manifoldStats(u);
      if (!us.open && !us.nonManifold && !us.flipped && meshVolume(u).volume > 1e-6) { mesh = u; merged = { shells }; }
    } catch { /* keep the shells */ }
  }
  const whole = meshVolume(mesh);
  if (!(whole.volume > 1e-6)) throw new Error(`fracture: part "${opts.name}" has no volume (inside-out or flat)`);
  const b = mesh.bounds();
  const tex = opts.inside;
  // debris cells are the parent's convex cell clipped by sub-cells, intersected with the ORIGINAL
  // part (one boolean per chunk): re-cutting a boolean result can leave T-junctions.
  const clipTo = (S, C) => {
    const ctr = cellCenter(C);
    for (const F of C) {
      let n = [0, 0, 0];
      for (let i = 1; i + 1 < F.length; i++) n = add(n, cross(sub(F[i], F[0]), sub(F[i + 1], F[0])));
      if (len(n) < 1e-12) continue;
      n = norm(n);
      let w = dot(n, F[0]);
      if (dot(n, ctr) > w) { n = mul(n, -1); w = -w; }
      S = clipCell(S, n, w);
      if (S.length < 4) return null;
    }
    return S;
  };
  const cut = (src, n, sd, level, parent, prefix, parentCell) => {
    const out = [];
    const cl = cells(src, src.bounds().min, src.bounds().max, { pieces: n, method, seed: sd });
    for (const C0 of cl) {
      const C = parentCell ? clipTo(C0, parentCell) : C0;
      if (!C) continue;
      const m = booleanMesh('intersect', mesh, cellMesh(C, tex), { method: boolMethod });
      const v = meshVolume(m);
      if (!(v.volume > 1e-4)) continue;
      out.push({ mesh: m, volume_px3: v.volume, center: v.center, level, parent, cell: C });
    }
    out.forEach((c, i) => { c.name = `${prefix}_${String(i).padStart(2, '0')}`; });
    return out;
  };
  const base = (opts.name || 'part').replace(/[^A-Za-z0-9_.-]/g, '_');
  const l1 = cut(mesh, pieces, seed, 1, null, `${base}_chunk`);
  let chunks = [...l1];
  const debris = Math.max(0, Math.min(16, Math.round(Number(opts.debris ?? 0))));
  if (debris) {
    const big = [...l1].sort((x, y) => y.volume_px3 - x.volume_px3).slice(0, debris);
    for (const c of big) chunks.push(...cut(c.mesh, 3, seed * 31 + l1.indexOf(c) + 7, 2, c.name, `${c.name}_debris`, c.cell));
  }
  for (const c of chunks) {
    const bb = c.mesh.bounds();
    c.min = bb.min; c.max = bb.max;
    const ms2 = manifoldStats(c.mesh);
    c.watertight = ms2.open === 0 && ms2.nonManifold === 0 && ms2.flipped === 0;
    c.manifold = ms2;
    const pts = [];
    for (const g of c.mesh.groups.values()) for (let i = 0; i < g.pos.length; i += 3) pts.push([g.pos[i], g.pos[i + 1], g.pos[i + 2]]);
    const h = convexHull(pts, 48);
    c.hull = h ? hullMesh(h, { key: 'proxy:collision', name: 'collision_proxy', width: 1, height: 1, data: Uint8ClampedArray.from([255, 0, 255, 255]) }) : null;
    c.hullVerts = h ? h.verts.length : 0;
  }
  const sum1 = l1.reduce((s, c) => s + c.volume_px3, 0);
  return { chunks, volume_px3: whole.volume, center: whole.center, bounds: b, level1_volume_px3: sum1, error: Math.abs(sum1 - whole.volume) / whole.volume, method, pieces, seed, ...(merged ? { merged } : {}), ...(closed ? { closed: { method: closed.method, before: closed.before, after: closed.after, triangles: mesh.triangles, ms: closed.ms } } : {}) };
}
