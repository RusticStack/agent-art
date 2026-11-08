// Rebuilds the mesh-processing demo renders in docs/meshproc/:
//   node docs/meshproc/build-demos.mjs [out dir]
// Boolean union of a kitbashed hull (before / after), voxel remesh of a greeble pile, quad
// retopology wireframe, cluster LOD colour-coded at three distances and culling stats. Prints
// triangles, errors and timings (also written to demo-stats.json).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { unionAll } from '../../src/meshbool.js';
import { voxelRemesh, quadRemesh } from '../../src/remesh.js';
import { decimateMesh } from '../../src/simplify.js';
import { buildClusterDAG, writeClod, clustersMesh } from '../../src/clusterlod.js';
import { parseClod, selectClusters, lookAtPlanes } from '../../src/clodselect.js';
import { manifoldReport, hausdorff } from '../../src/meshkit.js';
import { renderMeshViz, idTex } from '../../src/meshviz.js';
import { packImages } from '../../src/sheet.js';
import { encodePNG } from '../../src/png.js';
import * as FX from '../../src/meshfixtures.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(process.argv[2] || here);
fs.mkdirSync(OUT, { recursive: true });
const stats = {};
const time = (f) => { const t0 = performance.now(); const r = f(); return [r, Math.round(performance.now() - t0)]; };
const save = (name, panels, columns) => {
  const s = packImages(panels, { labels: true, checker: false, columns: columns ?? panels.length });
  fs.writeFileSync(path.join(OUT, name), encodePNG(s.width, s.height, s.data));
  console.log('wrote', name, `${s.width}x${s.height}`);
};
const mf = (m) => { const r = manifoldReport(m); return { triangles: r.triangles, closed: r.closed, open_edges: r.open, non_manifold_edges: r.nonManifold, non_manifold_vertices: r.nonManifoldVertices, shells: r.components }; };
const SIZE = 384;

// ---------- 1. boolean union of a kitbashed hull ----------
const hull = FX.kitbashHull({ detail: 1, greebles: 24 });
const [u, uMs] = time(() => unionAll(hull));
// cut-away (y > mid removed) shows the hidden interior faces the union drops
const cutaway = (m) => {
  const b = m.bounds(), mid = (b.min[1] + b.max[1]) / 2 + 2, out = m.clone();
  for (const g of out.groups.values()) {
    const idx = [];
    for (let t = 0; t < g.idx.length; t += 3) if (Math.max(g.pos[g.idx[t] * 3 + 1], g.pos[g.idx[t + 1] * 3 + 1], g.pos[g.idx[t + 2] * 3 + 1]) <= mid) idx.push(g.idx[t], g.idx[t + 1], g.idx[t + 2]);
    g.idx = idx; g.faces = null;
  }
  return out;
};
stats.boolean_union = { input: mf(hull), output: mf(u.mesh), discarded: u.stats.discarded, ms: uMs };
const big = FX.kitbashHull({ detail: 5, greebles: 400 });
const [ub, ubMs] = time(() => unionAll(big));
stats.boolean_union_large = { input_triangles: big.triangles, output: mf(ub.mesh), ms: ubMs };
save('boolean_union.png', [
  { img: renderMeshViz(hull, { size: SIZE, wire: 'tris', wireColor: [90, 200, 255] }), label: `before: ${hull.triangles} tris`, sub: `${stats.boolean_union.input.shells} overlapping shells` },
  { img: renderMeshViz(cutaway(hull), { size: SIZE, wire: 'tris', wireColor: [90, 200, 255] }), label: 'before, cut-away', sub: 'faces buried inside the hull' },
  { img: renderMeshViz(u.mesh, { size: SIZE, wire: 'tris', wireColor: [90, 200, 255] }), label: `union: ${u.mesh.triangles} tris`, sub: `${stats.boolean_union.output.shells} closed shell(s), ${uMs} ms` },
  { img: renderMeshViz(cutaway(u.mesh), { size: SIZE, wire: 'tris', wireColor: [90, 200, 255] }), label: 'union, cut-away', sub: `${Math.round(u.stats.discarded.area_ratio * 100)}% of the area dropped` },
], 2);

// ---------- 2. voxel remesh of a greeble pile ----------
const pile = FX.greebleBlob({ count: 60, seed: 5 });
const vox = [32, 64].map((resolution) => {
  const [r, ms] = time(() => voxelRemesh(pile, { resolution }));
  const h = hausdorff(pile, r.mesh, { perTri: 4 });
  return { r, ms, resolution, h };
});
stats.voxel_remesh = { input: mf(pile), runs: vox.map(({ r, ms, resolution, h }) => ({ resolution, voxel_px: r.stats.voxel_px, output: mf(r.mesh), remesh_to_source_px: +h.ba.toFixed(3), ms })) };
save('voxel_remesh.png', [
  { img: renderMeshViz(pile, { size: SIZE, wire: 'tris' }), label: `greeble pile: ${pile.triangles} tris`, sub: `${stats.voxel_remesh.input.shells} intersecting pieces` },
  ...vox.map(({ r, ms, resolution }) => ({ img: renderMeshViz(r.mesh, { size: SIZE, wire: 'tris' }), label: `voxel ${resolution}: ${r.mesh.triangles} tris`, sub: `watertight, ${ms} ms` })),
]);

// ---------- 3. quad retopology ----------
const sph = FX.sphereMesh([0, 0, 0], 96, { seg: 48, rings: 24 });
const [qs, qsMs] = time(() => quadRemesh(sph, { faces: 600 }));
const sym = FX.kitbashHull({ detail: 1, greebles: 0 });
const [qh, qhMs] = time(() => quadRemesh(sym, { faces: 1200, symmetry: 'z' }));
stats.quad_remesh = {
  sphere: { input: sph.triangles, quads: qs.stats.quads, triangles_left: qs.stats.triangles_left, quad_ratio: qs.stats.quad_ratio, hausdorff_px: +hausdorff(sph, qs.mesh).max.toFixed(3), closed: mf(qs.mesh).closed, ms: qsMs },
  hull_symmetric: { input: sym.triangles, quads: qh.stats.quads, quad_ratio: qh.stats.quad_ratio, feature_edges: qh.stats.feature_edges, closed: mf(qh.mesh).closed, ms: qhMs },
};
save('quad_retopo.png', [
  { img: renderMeshViz(sph, { size: SIZE, wire: 'tris' }), label: `sphere: ${sph.triangles} tris` },
  { img: renderMeshViz(qs.mesh, { size: SIZE, wire: 'faces' }), label: `quad: ${qs.stats.quads} quads`, sub: `quad ratio ${qs.stats.quad_ratio}` },
  { img: renderMeshViz(qh.mesh, { size: SIZE, wire: 'faces', view: 'top' }), label: `hull, symmetry z: ${qh.stats.quads} quads`, sub: `features kept, ratio ${qh.stats.quad_ratio}` },
]);

// ---------- 4. cluster LOD at three distances + culling ----------
const lodSrc = unionAll(FX.kitbashHull({ detail: 2, greebles: 60 })).mesh;
const [dag, dagMs] = time(() => buildClusterDAG(lodSrc));
const clod = writeClod(dag, { scale: 32 });
const h = parseClod(clod);
const b = lodSrc.bounds(), ctr = b.min.map((v, k) => (v + b.max[k]) / 64), R = Math.hypot(...b.max.map((v, k) => v - b.min[k])) / 64;
const dir = [0.62, 0.36, 0.7], dl = Math.hypot(...dir);
const fit = [];
for (const x of [b.min[0], b.max[0]]) for (const y of [b.min[1], b.max[1]]) for (const z of [b.min[2], b.max[2]]) fit.push([x, y, z]);
const cuts = [];
for (const d of [R * 1.2, R * 6, R * 30]) {
  const pos = ctr.map((v, k) => v + (dir[k] / dl) * d);
  const cam = { position: pos, fov: 70, height: 1080, planes: lookAtPlanes({ position: pos, target: ctr, fov: 70, aspect: 16 / 9, near: 0.05, far: d + R * 4 }) };
  const all = selectClusters(h, cam, { frustum: false, cone: false });
  const s = selectClusters(h, cam);
  const m = clustersMesh(dag, all.clusters.map((i) => dag.clusters[i]), { colorTex: idTex });
  cuts.push({ distance_units: +d.toFixed(2), cut_triangles: all.triangles, cut_clusters: all.clusters.length, drawn_triangles: s.triangles, ...s.stats, img: renderMeshViz(m, { size: SIZE, wire: false, fit }) });
}
stats.cluster_lod = {
  source_triangles: lodSrc.triangles, ...dag.stats, ms: dagMs, clod_bytes: clod.length,
  cuts: cuts.map(({ img, ...c }) => c),
};
save('cluster_lod.png', cuts.map((c) => ({ img: c.img, label: `${c.distance_units} u: ${c.cut_triangles} tris`, sub: `${c.cut_clusters} clusters` })));
// culling from a close camera: drawn clusters coloured, the rest dark grey (seen from above)
{
  const pos = [ctr[0] - R * 0.15, ctr[1] + R * 0.3, ctr[2] + R * 0.55], target = [ctr[0] + R * 0.7, ctr[1], ctr[2]];
  const cam = { position: pos, fov: 50, height: 1080, planes: lookAtPlanes({ position: pos, target, fov: 50, aspect: 16 / 9, near: 0.05, far: R * 10 }) };
  const all = selectClusters(h, cam, { frustum: false, cone: false }), s = selectClusters(h, cam);
  const keep = new Set(s.clusters);
  const grey = { key: 'viz:culled', name: 'culled', width: 1, height: 1, data: Uint8ClampedArray.from([52, 56, 64, 255]) };
  const m = clustersMesh(dag, all.clusters.map((i) => dag.clusters[i]), { colorTex: (id) => (keep.has(id) ? idTex(id) : grey) });
  stats.culling = { camera_units: pos.map((v) => +v.toFixed(2)), ...s.stats, lod_cut_triangles: all.triangles, drawn_triangles: s.triangles };
  save('culling.png', [{ img: renderMeshViz(m, { size: 512, wire: false, view: 'top' }), label: `drawn ${s.triangles} of ${all.triangles} tris`, sub: `frustum ${s.stats.frustum_culled}, cone ${s.stats.cone_culled} clusters culled` }]);
}

// ---------- 5. error-bounded decimation ----------
const ds = FX.sphereMesh([0, 0, 0], 320, { seg: 128, rings: 64 });
stats.decimate = [0.5, 1, 4].map((maxError) => {
  const [r, ms] = time(() => decimateMesh(ds, { maxError }));
  const hd = hausdorff(ds, r.mesh, { perTri: 10 });
  return { bound_px: maxError, input: ds.triangles, output: r.triangles, hausdorff_px: +hd.max.toFixed(4), ms };
});

fs.writeFileSync(path.join(OUT, 'demo-stats.json'), JSON.stringify(stats, null, 2) + '\n');
console.log(JSON.stringify(stats, null, 2));
