// Visibility helpers for art_model visibility / cluster_lod: conservative occluder boxes, cells
// (rooms) + portals for interiors, and a sampled PVS between cells.
//  - occluders: voxels whose whole cube lies inside the solid (centre inside by winding number,
//    distance to the surface >= half the voxel diagonal), merged greedily into boxes; always inside
//    the visible surface, so occlusion culling with them never hides something visible
//  - cells: explicit boxes (cells / cull rooms) or the bounds of parts tagged room:"<name>"
//  - portals: every cell face is sampled with short rays across it; open samples are flood-filled
//    into openings. Openings into another cell are portals between them, openings whose rays
//    escape the model are portals to "outside" (hull doors, hatches, windows - works for ship
//    hulls with cut openings without knowing how they were made)
//  - PVS: cells reachable through <= depth portals, then confirmed by rays between sample points of
//    the two cells (sampled, not conservative: a missed sight line is possible on thin gaps)
import { soupOf, TriBVH, soupBounds } from './meshkit.js';
import { windingOccupancy } from './remesh.js';

/**
 * Conservative occluder boxes. opts: {voxel (px) | resolution (48), maxBoxes (32), minCells (2)}.
 * -> {boxes: [{min, max}] (px), stats}
 */
export function occluderBoxes(mesh, opts = {}) {
  const S = soupOf(mesh);
  if (!S.nt) return { boxes: [], stats: { boxes: 0 } };
  const bvh = new TriBVH(S.P, S.T);
  const bb = soupBounds(S), ext = bb.max.map((v, k) => v - bb.min[k]);
  const h = opts.voxel ? Number(opts.voxel) : Math.max(...ext, 1e-6) / Math.max(4, Math.min(256, Math.round(Number(opts.resolution ?? 48))));
  const o = bb.min.map((v) => v + h / 2 + h * 0.0137), n = ext.map((e) => Math.max(1, Math.floor(e / h)));
  const { inside } = windingOccupancy(S, bvh, o, h, n);
  const I = (i, j, k) => (k * n[1] + j) * n[0] + i;
  const half = (h * Math.sqrt(3)) / 2;
  const solid = new Uint8Array(inside.length);
  let cells = 0;
  for (let k = 0; k < n[2]; k++) for (let j = 0; j < n[1]; j++) for (let i = 0; i < n[0]; i++) {
    const x = I(i, j, k);
    if (!inside[x]) continue;
    const c = [o[0] + i * h, o[1] + j * h, o[2] + k * h];
    const r = bvh.closest(c, half);
    if (r && Math.sqrt(r.d2) < half) continue; // the surface passes through this cube
    solid[x] = 1; cells++;
  }
  // greedy boxes: grow x, then y, then z
  const used = new Uint8Array(solid.length), boxes = [];
  const free = (i, j, k) => i < n[0] && j < n[1] && k < n[2] && solid[I(i, j, k)] && !used[I(i, j, k)];
  for (let k = 0; k < n[2]; k++) for (let j = 0; j < n[1]; j++) for (let i = 0; i < n[0]; i++) {
    if (!free(i, j, k)) continue;
    let i1 = i; while (free(i1 + 1, j, k)) i1++;
    let j1 = j; for (;;) { let ok = true; for (let x = i; x <= i1; x++) if (!free(x, j1 + 1, k)) { ok = false; break; } if (!ok) break; j1++; }
    let k1 = k; for (;;) { let ok = true; for (let y = j; y <= j1 && ok; y++) for (let x = i; x <= i1; x++) if (!free(x, y, k1 + 1)) { ok = false; break; } if (!ok) break; k1++; }
    for (let z = k; z <= k1; z++) for (let y = j; y <= j1; y++) for (let x = i; x <= i1; x++) used[I(x, y, z)] = 1;
    const vol = (i1 - i + 1) * (j1 - j + 1) * (k1 - k + 1);
    boxes.push({ min: [o[0] + i * h - h / 2, o[1] + j * h - h / 2, o[2] + k * h - h / 2], max: [o[0] + i1 * h + h / 2, o[1] + j1 * h + h / 2, o[2] + k1 * h + h / 2], cells: vol });
  }
  boxes.sort((a, b) => b.cells - a.cells || a.min[0] - b.min[0] || a.min[1] - b.min[1] || a.min[2] - b.min[2]);
  const minCells = Math.max(1, Number(opts.minCells ?? 2));
  const kept = boxes.filter((b) => b.cells >= minCells).slice(0, Math.max(1, Math.round(Number(opts.maxBoxes ?? 32))));
  const volOf = (b) => (b.max[0] - b.min[0]) * (b.max[1] - b.min[1]) * (b.max[2] - b.min[2]);
  return { boxes: kept.map(({ min, max }) => ({ min, max })), stats: { voxel_px: +h.toFixed(4), grid: n, solid_voxels: cells, boxes: kept.length, candidates: boxes.length, volume_px3: Math.round(kept.reduce((s, b) => s + volOf(b), 0)) } };
}

/** Box mesh triangles of occluder boxes (px) for export / preview. */
export function boxTris(boxes) {
  const out = [];
  for (const { min, max } of boxes) {
    const c = (x, y, z) => [x ? max[0] : min[0], y ? max[1] : min[1], z ? max[2] : min[2]];
    const q = [[c(0, 0, 0), c(0, 1, 0), c(1, 1, 0), c(1, 0, 0)], [c(0, 0, 1), c(1, 0, 1), c(1, 1, 1), c(0, 1, 1)], [c(0, 0, 0), c(0, 0, 1), c(0, 1, 1), c(0, 1, 0)], [c(1, 0, 0), c(1, 1, 0), c(1, 1, 1), c(1, 0, 1)], [c(0, 0, 0), c(1, 0, 0), c(1, 0, 1), c(0, 0, 1)], [c(0, 1, 0), c(0, 1, 1), c(1, 1, 1), c(1, 1, 0)]];
    for (const f of q) out.push([f[0], f[1], f[2]], [f[0], f[2], f[3]]);
  }
  return out;
}

/**
 * Cells, portals and PVS. cells: [{name, min, max}] (px). opts: {step (px between face samples,
 * default 8), probe (px, 12), depth (PVS portal depth, 4), samples (per cell axis, 3), pvs (true)}.
 * -> {cells, portals: [{id, cells:[a, b], min, max, center, normal, samples}], pvs: {name: [names]}, stats}
 */
export function cellsAndPortals(mesh, cells, opts = {}) {
  const S = soupOf(mesh), bvh = new TriBVH(S.P, S.T);
  const bb = soupBounds(S), far = Math.max(bb.diag * 2, 1);
  const step = Math.max(0.5, Number(opts.step ?? 8)), probe = Math.max(0.5, Number(opts.probe ?? 12));
  const names = new Set();
  for (const c of cells) { if (names.has(c.name)) throw new Error(`cell "${c.name}" is listed twice`); names.add(c.name); }
  const inBox = (p, c, e = 0) => p[0] >= c.min[0] - e && p[0] <= c.max[0] + e && p[1] >= c.min[1] - e && p[1] <= c.max[1] + e && p[2] >= c.min[2] - e && p[2] <= c.max[2] + e;
  const cellAt = (p, not) => cells.find((c) => c !== not && inBox(p, c, 1e-6));
  const portals = [];
  const pairSeen = new Map();
  for (const c of cells) for (let ax = 0; ax < 3; ax++) for (const side of [-1, 1]) {
    const u = (ax + 1) % 3, w = (ax + 2) % 3;
    const plane = side < 0 ? c.min[ax] : c.max[ax];
    const nu = Math.max(1, Math.floor((c.max[u] - c.min[u]) / step)), nw = Math.max(1, Math.floor((c.max[w] - c.min[w]) / step));
    const su = (c.max[u] - c.min[u]) / nu, sw = (c.max[w] - c.min[w]) / nw;
    // per sample: target cell name ("outside") or null (blocked)
    const grid = new Array(nu * nw).fill(null);
    for (let a = 0; a < nu; a++) for (let b = 0; b < nw; b++) {
      const o = [0, 0, 0]; o[ax] = plane - side * probe; o[u] = c.min[u] + (a + 0.5) * su; o[w] = c.min[w] + (b + 0.5) * sw;
      const d = [0, 0, 0]; d[ax] = side;
      const hit = bvh.first(o, d, far);
      if (hit <= probe * 1.0001) continue; // a wall right at the face
      // the first other cell along the free part of the ray, else open space (outside)
      const free = Math.min(hit, far) - probe;
      let tgt = null;
      for (let t = probe / 4; t < free; t += probe / 4) {
        const q = [...o]; q[ax] = plane + side * t;
        const other = cellAt(q, c);
        if (other) { tgt = other.name; break; }
      }
      grid[a * nw + b] = tgt || (free > 2 * probe ? 'outside' : null);
    }
    // flood fill open samples into openings
    const seen = new Uint8Array(grid.length);
    for (let s0 = 0; s0 < grid.length; s0++) {
      if (!grid[s0] || seen[s0]) continue;
      const tgt = grid[s0], st = [s0];
      seen[s0] = 1;
      let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity, cnt = 0;
      while (st.length) {
        const x = st.pop(), a = Math.floor(x / nw), b = x % nw;
        cnt++; a0 = Math.min(a0, a); a1 = Math.max(a1, a); b0 = Math.min(b0, b); b1 = Math.max(b1, b);
        for (const [da, db] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const aa = a + da, bb2 = b + db; if (aa < 0 || bb2 < 0 || aa >= nu || bb2 >= nw) continue; const y = aa * nw + bb2; if (!seen[y] && grid[y] === tgt) { seen[y] = 1; st.push(y); } }
      }
      const min = [0, 0, 0], max = [0, 0, 0];
      min[ax] = max[ax] = plane; min[u] = c.min[u] + a0 * su; max[u] = c.min[u] + (a1 + 1) * su; min[w] = c.min[w] + b0 * sw; max[w] = c.min[w] + (b1 + 1) * sw;
      const pair = tgt === 'outside' ? [c.name, 'outside'] : [c.name, tgt].sort();
      // the same doorway seen from both cells: one portal spanning the wall between the two faces
      const key = `${pair.join('|')}|${ax}|${Math.round((min[u] + max[u]) / 2 / step)}|${Math.round((min[w] + max[w]) / 2 / step)}`;
      const prev = pairSeen.get(key);
      const normal = [0, 0, 0]; normal[ax] = pair[0] === c.name ? side : -side;
      const rec = { cells: pair, min, max, center: min.map((v, k) => (v + max[k]) / 2), normal, samples: cnt };
      if (prev) {
        for (let k = 0; k < 3; k++) { prev.min[k] = Math.min(prev.min[k], min[k]); prev.max[k] = Math.max(prev.max[k], max[k]); }
        prev.center = prev.min.map((v, k) => (v + prev.max[k]) / 2); prev.samples = Math.max(prev.samples, cnt);
        continue;
      }
      pairSeen.set(key, rec);
      portals.push(rec);
    }
  }
  portals.forEach((p, i) => { p.id = i; });
  // PVS
  const all = [...cells.map((c) => c.name), ...(portals.some((p) => p.cells[1] === 'outside') ? ['outside'] : [])];
  const adj = new Map(all.map((n) => [n, new Set()]));
  for (const p of portals) { adj.get(p.cells[0]).add(p.cells[1]); adj.get(p.cells[1]).add(p.cells[0]); }
  const depth = Math.max(1, Math.min(16, Math.round(Number(opts.depth ?? 4))));
  const ns = Math.max(2, Math.min(6, Math.round(Number(opts.samples ?? 3))));
  const pts = (c) => { const out = []; for (let i = 0; i < ns; i++) for (let j = 0; j < ns; j++) for (let k = 0; k < ns; k++) out.push([0, 1, 2].map((a) => c.min[a] + (c.max[a] - c.min[a]) * (0.1 + (0.8 * [i, j, k][a]) / (ns - 1)))); return out; };
  const samples = new Map(cells.map((c) => [c.name, pts(c)]));
  const sees = (A, B) => {
    for (const p of samples.get(A)) for (const q of samples.get(B)) {
      const d = [q[0] - p[0], q[1] - p[1], q[2] - p[2]], L = Math.hypot(...d);
      if (L < 1e-6) return true;
      if (bvh.first(p, d.map((v) => v / L), L) >= L) return true;
    }
    return false;
  };
  const pvs = {};
  let rays = 0;
  for (const a of all) {
    const reach = new Map([[a, 0]]);
    let front = [a];
    for (let d = 1; d <= depth && front.length; d++) { const nx = []; for (const x of front) for (const y of adj.get(x)) if (!reach.has(y)) { reach.set(y, d); nx.push(y); } front = nx; }
    const vis = [];
    for (const [b, d] of reach) {
      if (b === a) continue;
      if (opts.pvs === false || d <= 1 || a === 'outside' || b === 'outside') { vis.push(b); continue; }
      rays++;
      if (sees(a, b)) vis.push(b);
    }
    pvs[a] = vis.sort();
  }
  return { cells: cells.map((c) => ({ name: c.name, min: c.min, max: c.max })), portals, pvs, stats: { cells: cells.length, portals: portals.length, outside_portals: portals.filter((p) => p.cells[1] === 'outside').length, pvs_pairs_tested: rays } };
}

/** Index of the cell containing point p (px), -1 = outside. */
export function cellIndexOf(cells, p) {
  for (let i = 0; i < cells.length; i++) { const c = cells[i]; if (p[0] >= c.min[0] && p[0] <= c.max[0] && p[1] >= c.min[1] && p[1] <= c.max[1] && p[2] >= c.min[2] && p[2] <= c.max[2]) return i; }
  return -1;
}
