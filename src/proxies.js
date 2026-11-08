// Render-cost proxies for art_model exports: convex hulls and box sets (collision / occluder
// meshes), and room + portal visibility data (cull) for interior kit layouts.
import { Mesh } from './model3d.js';
import { bvhOf } from './bake.js';

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const norm = (a) => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

/** Unique opaque vertex positions of a mesh (px). */
function points(mesh) {
  const seen = new Map();
  for (const g of mesh.groups.values()) {
    if (g.overlay) continue;
    for (let i = 0; i < g.idx.length; i++) {
      const v = g.idx[i], p = [g.pos[v * 3], g.pos[v * 3 + 1], g.pos[v * 3 + 2]], k = p.map((x) => Math.round(x * 1000)).join(',');
      if (!seen.has(k)) seen.set(k, p);
    }
  }
  return [...seen.values()];
}

/**
 * 3D convex hull (incremental, with horizon edges) of points -> {verts, tris:[[a,b,c]] outward}.
 * Keeps it low-poly: only the support points along `dirs` Fibonacci directions are hulled.
 */
export function convexHull(pts0, dirs = 64) {
  let pts = pts0;
  if (dirs && pts.length > dirs) {
    const set = new Set();
    const ga = Math.PI * (3 - Math.sqrt(5));
    for (let i = 0; i < dirs; i++) {
      const y = 1 - (2 * (i + 0.5)) / dirs, r = Math.sqrt(1 - y * y), d = [Math.cos(ga * i) * r, y, Math.sin(ga * i) * r];
      let best = 0, bd = -Infinity;
      pts.forEach((p, k) => { const v = dot(p, d); if (v > bd + 1e-9) { bd = v; best = k; } });
      set.add(best);
    }
    pts = [...set].sort((a, b) => a - b).map((k) => pts0[k]);
  }
  if (pts.length < 4) return null;
  const eps = 1e-6 * Math.max(1, ...pts.map((p) => Math.max(Math.abs(p[0]), Math.abs(p[1]), Math.abs(p[2]))));
  // initial tetrahedron
  let i0 = 0, i1 = -1, i2 = -1, i3 = -1;
  for (let i = 1; i < pts.length; i++) if (pts[i][0] < pts[i0][0]) i0 = i;
  let bd = 0;
  pts.forEach((p, i) => { const d = len(sub(p, pts[i0])); if (d > bd) { bd = d; i1 = i; } });
  bd = 0;
  pts.forEach((p, i) => { const d = len(cross(sub(pts[i1], pts[i0]), sub(p, pts[i0]))); if (d > bd) { bd = d; i2 = i; } });
  bd = 0;
  const n0 = cross(sub(pts[i1], pts[i0]), sub(pts[i2], pts[i0]));
  pts.forEach((p, i) => { const d = Math.abs(dot(n0, sub(p, pts[i0]))); if (d > bd) { bd = d; i3 = i; } });
  if (i1 < 0 || i2 < 0 || i3 < 0 || bd < eps) return null;
  const faces = [];
  const mkFace = (a, b, c) => { const n = norm(cross(sub(pts[b], pts[a]), sub(pts[c], pts[a]))); return { v: [a, b, c], n, d: dot(n, pts[a]), alive: true }; };
  const cen = [0, 1, 2].map((k) => (pts[i0][k] + pts[i1][k] + pts[i2][k] + pts[i3][k]) / 4);
  for (const [a, b, c] of [[i0, i1, i2], [i0, i1, i3], [i0, i2, i3], [i1, i2, i3]]) {
    let f = mkFace(a, b, c);
    if (dot(f.n, cen) - f.d > 0) f = mkFace(a, c, b);
    faces.push(f);
  }
  const used = new Set([i0, i1, i2, i3]);
  for (let pi = 0; pi < pts.length; pi++) {
    if (used.has(pi)) continue;
    const p = pts[pi];
    const vis = faces.filter((f) => f.alive && dot(f.n, p) - f.d > eps);
    if (!vis.length) continue;
    const edgeCount = new Map();
    for (const f of vis) for (let k = 0; k < 3; k++) {
      const a = f.v[k], b = f.v[(k + 1) % 3];
      edgeCount.set(`${a},${b}`, [a, b]);
    }
    for (const f of vis) f.alive = false;
    for (const [k, [a, b]] of edgeCount) if (!edgeCount.has(`${b},${a}`)) faces.push(mkFace(a, b, pi));
    used.add(pi);
  }
  const live = faces.filter((f) => f.alive);
  const idx = new Map(), verts = [];
  const vi = (i) => { if (!idx.has(i)) { idx.set(i, verts.length); verts.push(pts[i]); } return idx.get(i); };
  return { verts, tris: live.map((f) => f.v.map(vi)) };
}

/** Hull -> Mesh (flat triangles, one colour texture). */
export function hullMesh(hull, tex) {
  const m = new Mesh();
  for (const t of hull.tris) {
    const P = t.map((i) => hull.verts[i]), n = norm(cross(sub(P[1], P[0]), sub(P[2], P[0])));
    m.face(tex, P, n, [[0, 0], [0, 0], [0, 0]], n, 0);
  }
  return m;
}

/**
 * Box set: voxelise the closed surface (cell px), flood-fill the outside, greedy-merge the solid
 * cells into boxes. occluder:true keeps only cells whose 6 neighbours are solid too (stays inside
 * the visible surface = never over-occludes). Grows the cell until <= maxBoxes.
 * -> {boxes:[{min, max} px], cell}
 */
export function boxSet(mesh, { cell, maxBoxes = 16, occluder = false } = {}) {
  const b = mesh.bounds();
  const ext = [0, 1, 2].map((k) => b.max[k] - b.min[k]);
  let c = cell ?? Math.max(1, Math.max(...ext) / 16);
  const tris = [];
  for (const g of mesh.groups.values()) {
    if (g.overlay) continue;
    for (let i = 0; i < g.idx.length; i += 3) tris.push([0, 1, 2].map((k) => { const v = g.idx[i + k]; return [g.pos[v * 3], g.pos[v * 3 + 1], g.pos[v * 3 + 2]]; }));
  }
  for (let attempt = 0; attempt < 8; attempt++) {
    const n = ext.map((e) => Math.max(1, Math.ceil(e / c - 1e-6)) + 2);
    const o = b.min.map((v) => v - c);
    const N = n[0] * n[1] * n[2];
    if (N > 3e6) { c *= 1.5; continue; }
    const at = (x, y, z) => (z * n[1] + y) * n[0] + x;
    const surf = new Uint8Array(N);
    for (const T of tris) {
      // sample the triangle densely enough to touch every cell it crosses
      const e = Math.max(len(sub(T[1], T[0])), len(sub(T[2], T[0])), len(sub(T[2], T[1])));
      const s = Math.max(1, Math.ceil((e / c) * 2));
      for (let i = 0; i <= s; i++) for (let j = 0; j <= s - i; j++) {
        const u = i / s, v = j / s, w = 1 - u - v;
        const p = [0, 1, 2].map((k) => T[0][k] * w + T[1][k] * u + T[2][k] * v);
        const q = p.map((x, k) => Math.min(n[k] - 1, Math.max(0, Math.floor((x - o[k]) / c))));
        surf[at(q[0], q[1], q[2])] = 1;
      }
    }
    // outside flood fill from the padded border
    const out = new Uint8Array(N), st = [0];
    out[0] = 1;
    while (st.length) {
      const id = st.pop(), x = id % n[0], y = Math.floor(id / n[0]) % n[1], z = Math.floor(id / (n[0] * n[1]));
      for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
        const X = x + dx, Y = y + dy, Z = z + dz;
        if (X < 0 || Y < 0 || Z < 0 || X >= n[0] || Y >= n[1] || Z >= n[2]) continue;
        const j = at(X, Y, Z);
        if (out[j] || surf[j]) continue;
        out[j] = 1; st.push(j);
      }
    }
    let solid = new Uint8Array(N);
    for (let i = 0; i < N; i++) solid[i] = out[i] ? 0 : 1;
    if (occluder) {
      const inner = new Uint8Array(N);
      for (let z = 1; z < n[2] - 1; z++) for (let y = 1; y < n[1] - 1; y++) for (let x = 1; x < n[0] - 1; x++) {
        const i = at(x, y, z);
        if (solid[i] && !surf[i] && solid[at(x + 1, y, z)] && solid[at(x - 1, y, z)] && solid[at(x, y + 1, z)] && solid[at(x, y - 1, z)] && solid[at(x, y, z + 1)] && solid[at(x, y, z - 1)]) inner[i] = 1;
      }
      solid = inner;
    }
    // greedy 3D merge
    const boxes = [], taken = new Uint8Array(N);
    for (let z = 0; z < n[2]; z++) for (let y = 0; y < n[1]; y++) for (let x = 0; x < n[0]; x++) {
      const i = at(x, y, z);
      if (!solid[i] || taken[i]) continue;
      let x1 = x; while (x1 + 1 < n[0] && solid[at(x1 + 1, y, z)] && !taken[at(x1 + 1, y, z)]) x1++;
      let y1 = y;
      grow: while (y1 + 1 < n[1]) { for (let xx = x; xx <= x1; xx++) if (!solid[at(xx, y1 + 1, z)] || taken[at(xx, y1 + 1, z)]) break grow; y1++; }
      let z1 = z;
      growz: while (z1 + 1 < n[2]) { for (let yy = y; yy <= y1; yy++) for (let xx = x; xx <= x1; xx++) if (!solid[at(xx, yy, z1 + 1)] || taken[at(xx, yy, z1 + 1)]) break growz; z1++; }
      for (let zz = z; zz <= z1; zz++) for (let yy = y; yy <= y1; yy++) for (let xx = x; xx <= x1; xx++) taken[at(xx, yy, zz)] = 1;
      const mn = [o[0] + x * c, o[1] + y * c, o[2] + z * c], mx = [o[0] + (x1 + 1) * c, o[1] + (y1 + 1) * c, o[2] + (z1 + 1) * c];
      // collision boxes never stick out of the model bounds
      boxes.push({ min: mn.map((v, k) => Math.max(v, b.min[k])), max: mx.map((v, k) => Math.min(v, b.max[k])) });
    }
    if (boxes.length <= maxBoxes || attempt === 7) return { boxes: boxes.sort((p, q) => vol(q) - vol(p)).slice(0, maxBoxes), cell: c };
    c *= 1.4;
  }
  return { boxes: [], cell: c };
}
const vol = (bx) => (bx.max[0] - bx.min[0]) * (bx.max[1] - bx.min[1]) * (bx.max[2] - bx.min[2]);

/** Boxes -> Mesh (12 triangles each). */
export function boxesMesh(boxes, tex) {
  const m = new Mesh();
  for (const { min: [x0, y0, z0], max: [x1, y1, z1] } of boxes) {
    const F = [
      [[0, 0, 1], [[x0, y1, z1], [x1, y1, z1], [x1, y0, z1], [x0, y0, z1]]], [[0, 0, -1], [[x1, y1, z0], [x0, y1, z0], [x0, y0, z0], [x1, y0, z0]]],
      [[1, 0, 0], [[x1, y1, z1], [x1, y1, z0], [x1, y0, z0], [x1, y0, z1]]], [[-1, 0, 0], [[x0, y1, z0], [x0, y1, z1], [x0, y0, z1], [x0, y0, z0]]],
      [[0, 1, 0], [[x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]]], [[0, -1, 0], [[x0, y0, z1], [x1, y0, z1], [x1, y0, z0], [x0, y0, z0]]],
    ];
    for (const [n, P] of F) m.face(tex, P, n, P.map(() => [0, 0]), n, 0);
  }
  return m;
}

/** collision / occluder spec: true | "hull" | "boxes" | {type, max_boxes, cell, hull_points} */
export function normProxy(v, def) {
  if (!v) return null;
  const o = v === true ? { type: def } : typeof v === 'string' ? { type: v } : v;
  const type = o.type ?? def;
  if (!['hull', 'boxes'].includes(type)) throw new Error('collision / occluder type must be "hull" (convex hull) or "boxes" (box set)');
  return { type, maxBoxes: Math.max(1, Math.min(256, Math.round(Number(o.max_boxes ?? 16)))), cell: o.cell === undefined ? undefined : Number(o.cell), hullPoints: Math.max(8, Math.min(512, Math.round(Number(o.hull_points ?? 64)))) };
}

/** Build a proxy mesh + description for export. */
export function buildProxy(mesh, spec, tex, occluder) {
  if (spec.type === 'hull') {
    const h = convexHull(points(mesh), spec.hullPoints);
    if (!h) throw new Error('convex hull: the model is flat or empty');
    return { mesh: hullMesh(h, tex), info: { type: 'hull', vertices: h.verts.length, triangles: h.tris.length } };
  }
  const bs = boxSet(mesh, { cell: spec.cell, maxBoxes: spec.maxBoxes, occluder });
  if (!bs.boxes.length) throw new Error(`${occluder ? 'occluder' : 'collision'} box set is empty (model too thin for cell ${bs.cell.toFixed(2)} px: pass cell)`);
  return { mesh: boxesMesh(bs.boxes, tex), info: { type: 'boxes', cell_px: +bs.cell.toFixed(3), boxes: bs.boxes } };
}

// ---------- rooms + portals ----------
const v3 = (v, name) => { if (!Array.isArray(v) || v.length !== 3 || v.some((x) => !Number.isFinite(Number(x)))) throw new Error(`${name} must be [x,y,z]`); return v.map(Number); };
/**
 * cull:{rooms:[{name, min:[x,y,z], max:[x,y,z]} | {name, cells:[[gx,gy,gz],[gx,gy,gz]]}], portals?:[{rooms:[a,b], min, max}], depth?:2, step?:2}
 * -> normalized rooms (px boxes) + explicit portals.
 */
export function normCull(c, grid) {
  if (!c || typeof c !== 'object' || !Array.isArray(c.rooms) || !c.rooms.length) throw new Error('cull needs rooms:[{name, min:[x,y,z], max:[x,y,z]} | {name, cells:[[gx,gy,gz],[gx,gy,gz]] (inclusive grid cells)}]');
  const names = new Set();
  const rooms = c.rooms.map((r, i) => {
    if (!r || typeof r.name !== 'string' || !/^[\w.-]{1,48}$/.test(r.name)) throw new Error(`cull room ${i}: name (1-48 letters, digits, _ - .) is required`);
    if (names.has(r.name)) throw new Error(`cull room "${r.name}" is listed twice`);
    names.add(r.name);
    let min, max;
    if (r.cells) {
      const [a, b] = r.cells.map((x, k) => v3(x, `room ${r.name} cells[${k}]`));
      min = [0, 1, 2].map((k) => Math.min(a[k], b[k]) * grid - (k === 1 ? 0 : grid / 2));
      max = [0, 1, 2].map((k) => (Math.max(a[k], b[k]) + 1) * grid - (k === 1 ? 0 : grid / 2));
    } else { min = v3(r.min, `room ${r.name} min`); max = v3(r.max, `room ${r.name} max`); }
    for (let k = 0; k < 3; k++) if (!(max[k] > min[k])) throw new Error(`cull room "${r.name}": max must be greater than min on every axis`);
    return { name: r.name, min, max };
  });
  const portals = (c.portals || []).map((p, i) => {
    if (!p || !Array.isArray(p.rooms) || p.rooms.length !== 2 || p.rooms.some((n) => !names.has(n))) throw new Error(`cull portal ${i}: rooms must be two room names`);
    return { rooms: p.rooms, min: v3(p.min, `portal ${i} min`), max: v3(p.max, `portal ${i} max`) };
  });
  return { rooms, portals, depth: Math.max(1, Math.min(16, Math.round(Number(c.depth ?? 2)))), step: Math.max(0.5, Number(c.step ?? 2)), probe: Math.max(1, Number(c.probe ?? 8)) };
}
const inBox = (p, r, e = 0) => p[0] >= r.min[0] - e && p[0] <= r.max[0] + e && p[1] >= r.min[1] - e && p[1] <= r.max[1] + e && p[2] >= r.min[2] - e && p[2] <= r.max[2] + e;

/**
 * Split a final mesh by room (triangle centroid; first room wins; "outside" otherwise), find
 * doorways where two room boxes share a face (sample the shared rectangle, short rays across it:
 * no hit = open; the open samples' bounding rectangle per pair is the portal), PVS = rooms reachable
 * through <= depth portals. -> {meshes: Map name -> Mesh, rooms, portals, pvs}
 */
export function cullLayout(mesh, cull) {
  const meshes = new Map();
  const tgt = (n) => { if (!meshes.has(n)) meshes.set(n, new Mesh()); return meshes.get(n); };
  for (const g of mesh.groups.values()) {
    if (g.overlay) {
      for (let t = 0; t < g.idx.length; t += 3) {
        const c = [0, 1, 2].map((k) => (g.pos[g.idx[t] * 3 + k] + g.pos[g.idx[t + 1] * 3 + k] + g.pos[g.idx[t + 2] * 3 + k]) / 3);
        const room = cull.rooms.find((r) => inBox(c, r))?.name ?? 'outside';
        const og = tgt(room).group(g.tex, true), base = og.pos.length / 3;
        for (let k = 0; k < 3; k++) { const v = g.idx[t + k]; og.pos.push(g.pos[v * 3], g.pos[v * 3 + 1], g.pos[v * 3 + 2]); og.nrm.push(g.nrm[v * 3], g.nrm[v * 3 + 1], g.nrm[v * 3 + 2]); og.uv.push(g.uv[v * 2], g.uv[v * 2 + 1]); og.uv0.push(g.uv0[v * 2], g.uv0[v * 2 + 1]); og.alpha.push(g.alpha[v]); }
        og.idx.push(base, base + 1, base + 2);
      }
      continue;
    }
    for (const f of g.faces) {
      for (let i = f.i; i < f.i + f.ic; i += 3) {
        const c = [0, 1, 2].map((k) => (g.pos[g.idx[i] * 3 + k] + g.pos[g.idx[i + 1] * 3 + k] + g.pos[g.idx[i + 2] * 3 + k]) / 3);
        const room = cull.rooms.find((r) => inBox(c, r, 1e-6))?.name ?? 'outside';
        const tg = tgt(room).group(g.tex), base = tg.pos.length / 3, i0 = tg.idx.length;
        for (let k = 0; k < 3; k++) { const v = g.idx[i + k]; tg.pos.push(g.pos[v * 3], g.pos[v * 3 + 1], g.pos[v * 3 + 2]); tg.nrm.push(g.nrm[v * 3], g.nrm[v * 3 + 1], g.nrm[v * 3 + 2]); tg.uv.push(g.uv[v * 2], g.uv[v * 2 + 1]); }
        tg.idx.push(base, base + 1, base + 2);
        tg.faces.push({ ...f, v: base, vc: 3, i: i0, ic: 3 });
      }
    }
  }
  const portals = cull.portals.map((p) => ({ ...p, auto: false }));
  if (!cull.portals.length) {
    const bvh = bvhOf([mesh]);
    for (let a = 0; a < cull.rooms.length; a++) for (let b = a + 1; b < cull.rooms.length; b++) {
      const A = cull.rooms[a], B = cull.rooms[b];
      for (let ax = 0; ax < 3; ax++) {
        const touch = Math.abs(A.max[ax] - B.min[ax]) < 1e-3 ? A.max[ax] : Math.abs(B.max[ax] - A.min[ax]) < 1e-3 ? A.min[ax] : null;
        if (touch === null) continue;
        const u = (ax + 1) % 3, w = (ax + 2) % 3;
        const lo = [Math.max(A.min[u], B.min[u]), Math.max(A.min[w], B.min[w])], hi = [Math.min(A.max[u], B.max[u]), Math.min(A.max[w], B.max[w])];
        if (!(hi[0] > lo[0] && hi[1] > lo[1])) continue;
        let mn = [Infinity, Infinity], mx = [-Infinity, -Infinity], open = 0;
        const s = cull.step;
        for (let x = lo[0] + s / 2; x < hi[0]; x += s) for (let y = lo[1] + s / 2; y < hi[1]; y += s) {
          const o = [0, 0, 0]; o[ax] = touch - cull.probe; o[u] = x; o[w] = y;
          const d = [0, 0, 0]; d[ax] = 1;
          if (bvh.hit(o, d, 2 * cull.probe) < 2 * cull.probe) continue;
          open++;
          mn = [Math.min(mn[0], x - s / 2), Math.min(mn[1], y - s / 2)]; mx = [Math.max(mx[0], x + s / 2), Math.max(mx[1], y + s / 2)];
        }
        if (!open) continue;
        const pmin = [0, 0, 0], pmax = [0, 0, 0];
        pmin[ax] = pmax[ax] = touch; pmin[u] = mn[0]; pmax[u] = mx[0]; pmin[w] = mn[1]; pmax[w] = mx[1];
        portals.push({ rooms: [A.name, B.name], min: pmin, max: pmax, auto: true, open_samples: open });
      }
    }
  }
  const adj = new Map(cull.rooms.map((r) => [r.name, new Set()]));
  for (const p of portals) { adj.get(p.rooms[0]).add(p.rooms[1]); adj.get(p.rooms[1]).add(p.rooms[0]); }
  const pvs = {};
  for (const r of cull.rooms) {
    const seen = new Set([r.name]);
    let front = [r.name];
    for (let d = 0; d < cull.depth; d++) { const nx = []; for (const n of front) for (const m of adj.get(n)) if (!seen.has(m)) { seen.add(m); nx.push(m); } front = nx; }
    pvs[r.name] = [...seen];
  }
  return { meshes, rooms: cull.rooms, portals, pvs };
}

