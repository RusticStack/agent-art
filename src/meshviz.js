// Previews for the mesh-processing actions: shaded render + depth-tested wireframe overlay (face
// record outlines: quads draw as quads, or every triangle edge), optional flat colour per
// face-record set (clusters). Software raster, used by art_model remesh / cluster_lod previews
// and the docs/meshproc demos.
import { makeCamera, renderCamera } from './raster3d.js';

/** Stable distinct colour for an integer id. -> [r, g, b] */
export function idColor(id) {
  let h = Math.imul((id + 1) ^ 0x9e3779b9, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
  const hue = ((h >>> 0) % 360) / 360, s = 0.55 + ((h >>> 9) % 30) / 100, v = 0.7 + ((h >>> 17) % 25) / 100;
  const i = Math.floor(hue * 6), f = hue * 6 - i, p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
  const [r, g, b] = [[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]][i % 6];
  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}
/** 1x1 colour texture for id. */
export const idTex = (id) => { const c = idColor(id); return { key: `viz:${id}`, name: `cluster_${id}`, width: 1, height: 1, data: Uint8ClampedArray.from([...c, 255]) }; };

/**
 * Render a mesh (px) with an optional wireframe. opts: {view ('iso'), size (256), wire:
 * 'faces' | 'tris' | false, wireColor [r,g,b], camera ({pos, look, fov}), fit (points)}.
 * -> {width, height, data}
 */
export function renderMeshViz(mesh, opts = {}) {
  const S = Math.max(64, Math.min(1024, Math.round(opts.size ?? 256)));
  const groups = [...mesh.groups.values()].filter((g) => g.idx.length);
  const b = mesh.bounds(), fit = opts.fit || [];
  if (!opts.fit) for (const x of [b.min[0], b.max[0]]) for (const y of [b.min[1], b.max[1]]) for (const z of [b.min[2], b.max[2]]) fit.push([x, y, z]);
  const cam = makeCamera(opts.camera || opts.view || 'iso', S, S, fit, { fov: opts.camera?.fov });
  const img = renderCamera(groups, cam, S, S);
  if (!opts.wire) return img;
  // depth buffer (larger = nearer: 1/z perspective, view-axis distance orthographic)
  const Z = new Float32Array(S * S).fill(-Infinity);
  const proj = (g, v) => cam.project([g.pos[v * 3], g.pos[v * 3 + 1], g.pos[v * 3 + 2]]);
  const edges = [];
  for (const g of groups) {
    const P = new Map();
    const pv = (v) => { let r = P.get(v); if (!r) { r = proj(g, v); P.set(v, r); } return r; };
    for (let t = 0; t < g.idx.length; t += 3) {
      const a = pv(g.idx[t]), c = pv(g.idx[t + 1]), d = pv(g.idx[t + 2]);
      if (a[4] || c[4] || d[4]) continue;
      const area = (c[0] - a[0]) * (d[1] - a[1]) - (d[0] - a[0]) * (c[1] - a[1]);
      if (Math.abs(area) < 1e-9) continue;
      const x0 = Math.max(0, Math.floor(Math.min(a[0], c[0], d[0]))), x1 = Math.min(S - 1, Math.ceil(Math.max(a[0], c[0], d[0])));
      const y0 = Math.max(0, Math.floor(Math.min(a[1], c[1], d[1]))), y1 = Math.min(S - 1, Math.ceil(Math.max(a[1], c[1], d[1])));
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        const px = x + 0.5, py = y + 0.5;
        const w0 = ((c[0] - px) * (d[1] - py) - (d[0] - px) * (c[1] - py)) / area, w1 = ((d[0] - px) * (a[1] - py) - (a[0] - px) * (d[1] - py)) / area, w2 = 1 - w0 - w1;
        if (w0 < 0 || w1 < 0 || w2 < 0) continue;
        const z = w0 * a[2] + w1 * c[2] + w2 * d[2];
        if (z > Z[y * S + x]) Z[y * S + x] = z;
      }
    }
    // wire edges: face record outlines (edges used once inside the record) or all triangle edges
    const recs = opts.wire === 'tris' || !g.faces ? [{ i: 0, ic: g.idx.length }] : g.faces;
    for (const f of recs) {
      const cnt = new Map();
      const key = (u, v) => { const pu = `${g.pos[u * 3]},${g.pos[u * 3 + 1]},${g.pos[u * 3 + 2]}`, pw = `${g.pos[v * 3]},${g.pos[v * 3 + 1]},${g.pos[v * 3 + 2]}`; return pu < pw ? `${pu}|${pw}` : `${pw}|${pu}`; };
      for (let t = f.i; t < f.i + f.ic; t += 3) for (let k = 0; k < 3; k++) {
        const u = g.idx[t + k], v = g.idx[t + ((k + 1) % 3)], kk = key(u, v);
        const e = cnt.get(kk);
        if (e) e.n++; else cnt.set(kk, { n: 1, u, v });
      }
      for (const e of cnt.values()) if (opts.wire === 'tris' || e.n === 1) edges.push([pv(e.u), pv(e.v)]);
    }
  }
  const col = opts.wireColor || [16, 20, 26];
  const zr = (() => { let mn = Infinity, mx = -Infinity; for (const z of Z) if (z > -Infinity) { if (z < mn) mn = z; if (z > mx) mx = z; } return mx > mn ? mx - mn : 1; })();
  const bias = zr * 0.004;
  for (const [a, c] of edges) {
    if (a[4] || c[4]) continue;
    const n = Math.ceil(Math.max(Math.abs(c[0] - a[0]), Math.abs(c[1] - a[1]))) + 1;
    for (let s = 0; s <= n; s++) {
      const t = s / n, x = Math.floor(a[0] + (c[0] - a[0]) * t), y = Math.floor(a[1] + (c[1] - a[1]) * t);
      if (x < 0 || y < 0 || x >= S || y >= S) continue;
      const z = a[2] + (c[2] - a[2]) * t;
      if (z + bias < Z[y * S + x]) continue;
      const o = (y * S + x) * 4;
      img.data[o] = col[0]; img.data[o + 1] = col[1]; img.data[o + 2] = col[2]; img.data[o + 3] = 255;
    }
  }
  return img;
}
