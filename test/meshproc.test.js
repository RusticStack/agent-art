// Mesh processing: robust booleans, voxel / quad remesh, error-bounded decimation, cluster LOD DAG
// (+ .clod sidecar and runtime selector), visibility, and the art_model actions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { Engine } from '../src/engine.js';
import { TOOLS } from '../src/mcp.js';
import { helpText } from '../src/docs.js';
import { booleanMesh, ROBUST_THRESHOLD } from '../src/csg.js';
import { robustBoolean, unionAll } from '../src/meshbool.js';
import { manifoldReport, hausdorff, soupOf, pointOf, dot3, cross3 } from '../src/meshkit.js';
import { voxelRemesh, quadRemesh, cleanupRemesh } from '../src/remesh.js';
import { decimateMesh } from '../src/simplify.js';
import { buildClusterDAG, writeClod, discreteLods, splitParts } from '../src/clusterlod.js';
import { parseClod, selectClusters, clusterInfo, clusterTriangles, lookAtPlanes, CLUSTER_STRIDE } from '../src/clodselect.js';
import { cellsAndPortals, occluderBoxes } from '../src/visibility.js';
import { packMesh, unpackMesh } from '../src/meshops.js';
import * as FX from '../src/meshfixtures.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'agent-art-meshproc-'));
const md5 = (b) => crypto.createHash('md5').update(b).digest('hex');
const volume = (m) => { const S = soupOf(m); let v = 0; for (let t = 0; t < S.nt; t++) v += dot3(pointOf(S.P, S.T[t * 3]), cross3(pointOf(S.P, S.T[t * 3 + 1]), pointOf(S.P, S.T[t * 3 + 2]))) / 6; return v; };
const watertight = (m, what) => {
  const r = manifoldReport(m);
  assert.equal(r.open, 0, `${what}: open edges`);
  assert.equal(r.nonManifold, 0, `${what}: non-manifold edges`);
  assert.equal(r.flipped, 0, `${what}: inconsistent winding`);
  return r;
};

// shared big fixtures (built once)
let hullCache = null;
const unionHull = () => hullCache || (hullCache = unionAll(FX.kitbashHull({ detail: 2, greebles: 60 })).mesh);

test('robust booleans: closed, manifold, same volumes as the BSP path', () => {
  const A = FX.sphereMesh([0, 0, 0], 100, { seg: 48, rings: 24 }), B = FX.boxMesh([20, -50, -50], [160, 50, 50], { n: 3 });
  const vA = volume(A), vB = volume(B);
  for (const op of ['union', 'subtract', 'intersect']) {
    const r = robustBoolean(op, A, B);
    const rep = watertight(r.mesh, op);
    assert.equal(rep.nonManifoldVertices, 0, `${op}: non-manifold vertices`);
    const v = volume(r.mesh), vb = volume(booleanMesh(op, A, B, { method: 'bsp' }));
    assert.ok(Math.abs(v - vb) < 1e-6 * vA, `${op}: volume ${v} vs bsp ${vb}`);
  }
  const vi = volume(robustBoolean('intersect', A, B).mesh), vu = volume(robustBoolean('union', A, B).mesh);
  assert.ok(Math.abs(vu - (vA + vB - vi)) < 1e-6 * vA, 'inclusion-exclusion');
  // curved x curved
  const S1 = FX.sphereMesh([0, 0, 0], 100, { seg: 64, rings: 32 }), S2 = FX.sphereMesh([60, 20, 10], 80, { seg: 64, rings: 32 });
  for (const op of ['union', 'subtract', 'intersect']) watertight(robustBoolean(op, S1, S2).mesh, `sphere ${op}`);
});

test('robust booleans: degenerate contacts (shared faces, an edge lying in a face) leave no open edges', () => {
  // coincident faces: two boxes sharing the x = 10 plane
  const a = FX.boxMesh([0, 0, 0], [10, 10, 10]), b = FX.boxMesh([10, 0, 0], [20, 10, 10]);
  const u = robustBoolean('union', a, b).mesh;
  watertight(u, 'face-touching union');
  assert.ok(Math.abs(volume(u) - 2000) < 1e-6);
  assert.ok(Math.abs(volume(robustBoolean('subtract', FX.boxMesh([0, 0, 0], [20, 10, 10]), b).mesh) - 1000) < 1e-6);
  // a cylinder whose side edge lies exactly in a box face (edge contact): no open edges
  const e = new Engine({ home: tmp() });
  e.run('create', { name: 'hull', width: 16 });
  e.run('model_create', { name: 'touch', parts: [{ type: 'box', w: 40, h: 16, d: 40, at: [30, 20, 10], texture: 'hull' }, { type: 'cylinder', r: 10, h: 60, segments: 16, at: [0, 30, 0], texture: 'hull' }] });
  const r = e.run('model_boolean', { name: 'touch' });
  assert.equal(r.manifold.open_edges, 0);
});

test('unionAll: a kitbashed ship (138k triangles) becomes one closed manifold shell in seconds', () => {
  const big = FX.kitbashHull({ detail: 5, greebles: 400 });
  assert.ok(big.triangles > 130000, `${big.triangles} input triangles`);
  const t0 = performance.now();
  const r = unionAll(big);
  const ms = performance.now() - t0;
  const rep = watertight(r.mesh, 'union_all');
  assert.equal(rep.nonManifoldVertices, 0);
  assert.ok(r.stats.removed_triangles > 0, 'hidden interior faces removed');
  assert.ok(volume(r.mesh) < volume(big), 'overlaps counted once');
  assert.ok(ms < 30000, `union_all took ${Math.round(ms)} ms`);
});

test('csg booleanMesh: method auto keeps the BSP path (byte-identical) below the threshold', () => {
  const A = FX.boxMesh([0, 0, 0], [32, 32, 32]), B = FX.sphereMesh([30, 16, 16], 12, { seg: 12, rings: 6 });
  assert.ok(A.triangles + B.triangles < ROBUST_THRESHOLD);
  const key = (m) => md5(packMesh(m));
  assert.equal(key(booleanMesh('subtract', A, B)), key(booleanMesh('subtract', A, B, { method: 'bsp' })));
  assert.notEqual(key(booleanMesh('subtract', A, B, { method: 'robust' })), key(booleanMesh('subtract', A, B, { method: 'bsp' })));
  assert.throws(() => booleanMesh('subtract', A, B, { method: 'magic' }), /method/);
});

test('voxel remesh: watertight manifold shell from an overlapping greeble pile, attributes transferred', () => {
  const blob = FX.greebleBlob({ count: 40, seed: 3 });
  for (const resolution of [24, 48]) {
    const r = voxelRemesh(blob, { resolution });
    const rep = watertight(r.mesh, `voxel ${resolution}`);
    assert.equal(rep.nonManifoldVertices, 0);
    const h = hausdorff(blob, r.mesh, { perTri: 4 });
    assert.ok(h.ba <= r.stats.voxel_px * 1.5, `remesh -> source ${h.ba} px vs voxel ${r.stats.voxel_px}`);
    // UVs / materials come from the source (fixture textures, no fallback material)
    const src = new Set([...blob.groups.values()].map((g) => g.tex.key));
    for (const g of r.mesh.groups.values()) assert.ok(src.has(g.tex.key));
  }
});

test('quad remesh: quad-dominant, closed, close to the source, symmetric on request', () => {
  const s = FX.sphereMesh([0, 0, 0], 64, { seg: 32, rings: 16 });
  const r = quadRemesh(s, { faces: 300 });
  watertight(r.mesh, 'quad sphere');
  assert.ok(r.stats.quad_ratio > 0.6, `quad ratio ${r.stats.quad_ratio}`);
  assert.ok(hausdorff(s, r.mesh).max < 4, 'within 4 px of the source');
  const quads = [...r.mesh.groups.values()].flatMap((g) => g.faces).filter((f) => f.ic === 6).length;
  assert.equal(quads, r.stats.quads);
  const sym = quadRemesh(FX.kitbashHull({ detail: 1, greebles: 0 }), { faces: 800, symmetry: 'z' });
  assert.ok(sym.stats.symmetry, 'symmetry applied');
  // mirrored: every vertex has a twin across z = 0
  const S = soupOf(sym.mesh), key = (x, y, z) => `${Math.round(x * 100)},${Math.round(y * 100)},${Math.round(z * 100)}`;
  const set = new Set(); for (let i = 0; i < S.np; i++) set.add(key(S.P[i * 3], S.P[i * 3 + 1], S.P[i * 3 + 2]));
  let miss = 0; for (let i = 0; i < S.np; i++) if (!set.has(key(S.P[i * 3], S.P[i * 3 + 1], -S.P[i * 3 + 2]))) miss++;
  assert.ok(miss <= S.np * 0.01, `${miss} of ${S.np} vertices without a mirror twin`);
  // cleanup: duplicate-free, consistent winding
  const c = cleanupRemesh(FX.sphereMesh([0, 0, 0], 20, { seg: 12, rings: 6 }));
  watertight(c.mesh, 'cleanup');
});

test('decimate: error bound in px is respected by the measured Hausdorff distance', () => {
  const s = FX.sphereMesh([0, 0, 0], 320, { seg: 128, rings: 64 });
  for (const maxError of [1, 4]) {
    const r = decimateMesh(s, { maxError });
    const h = hausdorff(s, r.mesh, { perTri: 10 });
    assert.ok(h.max <= maxError, `bound ${maxError}: hausdorff ${h.max}`);
    assert.ok(r.triangles < s.triangles * 0.5, `${r.triangles} of ${s.triangles}`);
    watertight(r.mesh, `decimated ${maxError}`);
  }
  // flat box: collapses to its 12 triangles, UVs stay on each face
  const b = FX.boxMesh([0, 0, 0], [64, 64, 64], { n: 16 });
  assert.equal(decimateMesh(b, { maxError: 0.01 }).triangles, 12);
});

test('decimate: skin weights (JOINTS/WEIGHTS) and vertex colours survive', () => {
  const bar = FX.skinnedBar({ n: 16 });
  const before = [...bar.groups.values()][0];
  assert.ok(before.skin, 'fixture is skinned');
  const r = decimateMesh(bar, { ratio: 0.3 });
  assert.ok(r.triangles < bar.triangles);
  for (const g of r.mesh.groups.values()) {
    assert.ok(g.skin && g.skin.j.length === (g.pos.length / 3) * 4 && g.skin.w.length === g.skin.j.length, 'skin per vertex');
    for (let v = 0; v < g.pos.length / 3; v++) {
      const w = g.skin.w.slice(v * 4, v * 4 + 4).reduce((a, b) => a + b, 0);
      assert.ok(Math.abs(w - 1) < 1e-4, `weights sum ${w}`);
      // the far end stays bound to joint 1, the near end to joint 0
      // the near end stays bound to joint 0, the far end to joint 1
      const x = g.pos[v * 3], w1 = g.skin.j[v * 4 + 1] === 1 ? g.skin.w[v * 4 + 1] : g.skin.j[v * 4] === 1 ? g.skin.w[v * 4] : 0;
      if (x < 16) assert.ok(w1 < 1e-4, `near end weight ${w1}`); else if (x > 240) assert.ok(w1 > 1 - 1e-4, `far end weight ${w1}`);
    }
  }
});

test('cluster LOD DAG: <= 128 triangles per cluster, monotonic error, every cut crack-free', () => {
  const src = unionHull();
  const dag = buildClusterDAG(src);
  assert.ok(dag.stats.levels >= 3, `${dag.stats.levels} levels`);
  assert.ok(dag.stats.root_triangles < src.triangles * 0.2, 'DAG reduces');
  for (const c of dag.clusters) {
    assert.ok(c.tris.length <= 128, `cluster ${c.id}: ${c.tris.length} tris`);
    assert.ok(c.error <= c.parentError, `cluster ${c.id}: error ${c.error} > parent ${c.parentError}`);
    // lod spheres nest: own lod sphere inside the parent lod sphere
    if (c.parentError !== Infinity) {
      const d = Math.hypot(c.lod[0] - c.parentLod[0], c.lod[1] - c.parentLod[1], c.lod[2] - c.parentLod[2]);
      assert.ok(d + c.lod[3] <= c.parentLod[3] * (1 + 1e-6) + 1e-6, `cluster ${c.id}: lod sphere not nested`);
    }
  }
  const clod = writeClod(dag, { scale: 32 });
  const h = parseClod(clod);
  assert.equal(h.count, dag.clusters.length);
  const b = src.bounds(), ctr = b.min.map((v, k) => (v + b.max[k]) / 64), R = Math.hypot(...b.max.map((v, k) => v - b.min[k])) / 64;
  const prev = [];
  for (const d of [R * 0.6, R * 2, R * 8, R * 40, R * 400]) {
    const cam = { position: [ctr[0] + d * 0.6, ctr[1] + d * 0.4, ctr[2] + d * 0.7], fov: 70, height: 1080 };
    const s = selectClusters(h, cam, { frustum: false, cone: false });
    // crack-free: the selected triangles form a closed edge-manifold surface
    const id = new Map(), E = new Map();
    const vid = (p) => { const k = p.map((v) => Math.round(v * 1e4)).join(','); if (!id.has(k)) id.set(k, id.size); return id.get(k); };
    let tris = 0;
    for (const i of s.clusters) for (const tri of clusterTriangles(h, i)) {
      tris++;
      const v = tri.map(vid);
      for (let k = 0; k < 3; k++) { const a = v[k], c = v[(k + 1) % 3], key = a < c ? `${a}_${c}` : `${c}_${a}`; E.set(key, (E.get(key) || 0) + 1); }
    }
    let bad = 0; for (const n of E.values()) if (n !== 2) bad++;
    assert.equal(bad, 0, `cut at distance ${d.toFixed(1)}: ${bad} open / non-manifold edges`);
    assert.equal(tris, s.triangles);
    prev.push(s.triangles);
  }
  for (let i = 1; i < prev.length; i++) assert.ok(prev[i] <= prev[i - 1], `farther cuts are not heavier: ${prev}`);
  assert.ok(prev[prev.length - 1] < prev[0] / 2, `far cut ${prev.at(-1)} vs near ${prev[0]}`);
  // record layout
  assert.equal(h.f32.length, (h.count * CLUSTER_STRIDE) / 4);
  const c0 = clusterInfo(h, 0);
  assert.ok(c0.triangles > 0 && c0.radius > 0);
  // discrete LODs for Roblox: parts of <= 20k triangles
  const lods = discreteLods(dag, { levels: 4 });
  assert.equal(lods[0].triangles, src.triangles);
  for (let i = 1; i < lods.length; i++) assert.ok(lods[i].triangles < lods[i - 1].triangles);
  for (const L of lods) for (const part of splitParts(dag, L.clusters, 20000)) assert.ok(part.reduce((n, c) => n + c.tris.length, 0) <= 20000);
});

test('cluster selector: frustum and back-face cone culling only remove invisible clusters', () => {
  const dag = buildClusterDAG(FX.sphereMesh([0, 0, 0], 320, { seg: 64, rings: 32 }));
  const h = parseClod(writeClod(dag, { scale: 32 }));
  const pos = [0, 0, 60];
  const cam = { position: pos, fov: 60, height: 720, planes: lookAtPlanes({ position: pos, target: [0, 0, 0], fov: 60, aspect: 1, near: 0.1, far: 1000 }) };
  const all = selectClusters(h, cam, { frustum: false, cone: false }), cul = selectClusters(h, cam);
  assert.ok(cul.stats.cone_culled > 0, 'back half of the sphere cone-culled');
  assert.ok(cul.triangles < all.triangles);
  // every culled cluster really faces away: all its triangle normals point away from the camera
  const kept = new Set(cul.clusters);
  for (const i of all.clusters) {
    if (kept.has(i)) continue;
    for (const [a, b, c] of clusterTriangles(h, i)) {
      const n = cross3([b[0] - a[0], b[1] - a[1], b[2] - a[2]], [c[0] - a[0], c[1] - a[1], c[2] - a[2]]);
      assert.ok(dot3(n, [a[0] - pos[0], a[1] - pos[1], a[2] - pos[2]]) >= -1e-6, `culled cluster ${i} has a front-facing triangle`);
    }
  }
});

test('visibility: portals through doorways, PVS and conservative occluders', () => {
  let shell = FX.boxMesh([0, 0, 0], [320, 96, 128]);
  const cut = (a, b) => { shell = robustBoolean('subtract', shell, FX.boxMesh(a, b)).mesh; };
  cut([8, 8, 8], [104, 88, 120]); cut([112, 8, 8], [208, 88, 120]); cut([216, 8, 8], [312, 88, 120]);
  cut([100, 8, 48], [116, 72, 80]); cut([204, 8, 48], [220, 72, 80]); cut([300, 20, 40], [330, 70, 90]);
  const cells = [{ name: 'a', min: [8, 8, 8], max: [104, 88, 120] }, { name: 'b', min: [112, 8, 8], max: [208, 88, 120] }, { name: 'c', min: [216, 8, 8], max: [312, 88, 120] }];
  const r = cellsAndPortals(shell, cells, { step: 4 });
  const pairs = r.portals.map((p) => [...p.cells].sort().join('-')).sort();
  assert.deepEqual(pairs, ['a-b', 'b-c', 'c-outside']);
  const ab = r.portals.find((p) => p.cells.includes('a') && p.cells.includes('b'));
  assert.ok(ab.min[1] >= 8 - 4 && ab.max[1] <= 72 + 4 && ab.min[2] >= 48 - 4 && ab.max[2] <= 80 + 4, 'portal matches the door opening');
  assert.ok(r.pvs.a.includes('b') && r.pvs.a.includes('c'));
  const o = occluderBoxes(FX.sphereMesh([0, 0, 0], 100), { resolution: 32 });
  assert.ok(o.boxes.length > 0);
  for (const b of o.boxes) for (let c = 0; c < 8; c++) {
    const p = [c & 1 ? b.max[0] : b.min[0], c & 2 ? b.max[1] : b.min[1], c & 4 ? b.max[2] : b.min[2]];
    assert.ok(Math.hypot(...p) <= 100, 'occluder box inside the surface');
  }
});

test('baked mesh format round-trips exactly', () => {
  const m = decimateMesh(FX.skinnedBar({ n: 8 }), { ratio: 0.5 }).mesh;
  const buf = packMesh(m), back = unpackMesh(buf);
  assert.equal(md5(packMesh(back)), md5(buf));
  assert.equal(back.triangles, m.triangles);
});

test('art_model boolean / remesh / decimate / cluster_lod / visibility (MCP), deterministic, persisted', async () => {
  const home = tmp();
  const e = new Engine({ home });
  e.run('create', { name: 'hull', width: 16 });
  e.run('draw', { canvas: 'hull', commands: [{ op: 'rect', x: 0, y: 0, w: 16, h: 8, color: '#778' }, { op: 'rect', x: 0, y: 8, w: 16, h: 8, color: '#556' }] });
  e.run('model_create', { name: 'ship', parts: [
    { type: 'box', w: 96, h: 24, d: 64, texture: 'hull' },
    { type: 'box', w: 40, h: 16, d: 40, at: [30, 20, 10], texture: 'hull' },
    { type: 'cylinder', r: 12, h: 50, segments: 24, at: [-20, 10, 0], texture: 'hull' },
  ] });
  // greeble pieces are open shells (no bottoms): voxel remesh makes the whole deck watertight
  e.run('model_create', { name: 'deck', parts: [{ type: 'model', model: 'ship' }, { type: 'greeble', w: 80, d: 50, at: [0, 24, 0], seed: 2, texture: 'hull' }] });
  // the art_model tool's own dispatch (same as the MCP server, without the content wrapping)
  const artModel = TOOLS.find((t) => t.name === 'art_model');
  const tool = async (a) => artModel.run(async (op, args) => e.run(op, args, 'agent'), a);
  const u = await tool({ action: 'boolean', name: 'ship' });
  assert.equal(u.model, 'ship_union');
  assert.ok(u.manifold.closed, JSON.stringify(u.manifold));
  assert.ok(u.triangles > 0 && u.stats.removed_triangles >= 0);
  const v = await tool({ action: 'remesh', name: 'deck', method: 'voxel', voxel: 0.1, preview: true });
  assert.ok(v.manifold.closed && v.manifold.non_manifold_vertices === 0);
  assert.ok(v.image && v.image.length > 100, 'preview image');
  const q = await tool({ action: 'remesh', name: 'deck_voxel', method: 'quad', faces: 200 });
  assert.ok(q.stats.quads > 0);
  const d = await tool({ action: 'decimate', name: 'ship_union', max_error: 0.05 });
  assert.ok(d.error_units.hausdorff <= 0.05, `hausdorff ${d.error_units.hausdorff} u`);
  assert.ok(d.triangles <= d.triangles_in);
  await assert.rejects(tool({ action: 'decimate', name: 'ship' }), /ratio|triangles|max_error/);
  await assert.rejects(tool({ action: 'boolean', name: 'ship', op: 'subtract' }), /with/);
  // baked models build, preview and export like any other model, also after a restart
  const e2 = new Engine({ home });
  assert.equal(e2.run('model_info', { name: 'ship_union_dec' }).triangles, d.triangles);
  const x1 = e2.run('model_export', { name: 'ship_union_dec' });
  assert.equal(x1.triangles, d.triangles);
  // cluster_lod: glb + .clod + meta, deterministic bytes
  const c1 = await tool({ action: 'cluster_lod', name: 'ship_union', preview: true, visibility: { cells: [{ name: 'fore', min: [-1.5, 0, -1], max: [0, 1, 1] }, { name: 'aft', min: [0, 0, -1], max: [1.5, 1, 1] }] } });
  assert.ok(fs.existsSync(c1.file) && fs.existsSync(c1.clod) && fs.existsSync(c1.meta));
  assert.ok(c1.image && c1.selection.length === 3);
  const g1 = fs.readFileSync(c1.file), k1 = fs.readFileSync(c1.clod);
  const h = parseClod(k1);
  assert.equal(h.json.visibility.cells.length, 2);
  assert.equal(h.json.visibility.cluster_cell.length, h.count);
  const c2 = await tool({ action: 'cluster_lod', name: 'ship_union', visibility: { cells: [{ name: 'fore', min: [-1.5, 0, -1], max: [0, 1, 1] }, { name: 'aft', min: [0, 0, -1], max: [1.5, 1, 1] }] } });
  assert.equal(md5(fs.readFileSync(c2.file)), md5(g1), 'glb byte-identical across runs');
  assert.equal(md5(fs.readFileSync(c2.clod)), md5(k1), '.clod byte-identical across runs');
  const meta = JSON.parse(fs.readFileSync(c1.meta, 'utf8'));
  assert.equal(meta.lods.levels[0].triangles, u.triangles);
  const glbJson = JSON.parse(g1.toString('utf8', 20, 20 + g1.readUInt32LE(12)));
  assert.ok(glbJson.nodes.some((n) => n.name === 'ship_union_LOD0_p0'));
  assert.equal(glbJson.asset.extras.cluster_lod.file, path.basename(c1.clod));
  // visibility action
  const vis = await tool({ action: 'visibility', name: 'ship', cells: [{ name: 'fore', min: [-1.5, 0, -1], max: [0, 1, 1] }, { name: 'aft', min: [0, 0, -1], max: [1.5, 1, 1] }] });
  assert.ok(fs.existsSync(vis.file) && vis.occluders > 0);
  // delete removes the baked mesh file too
  e.run('model_delete', { name: 'ship_union_dec' });
  assert.ok(!fs.existsSync(path.join(home, 'models', 'ship_union_dec.mesh.bin')));
  // docs
  const help = helpText({ topic: '3d', full: true });
  for (const w of ['MESH PROCESSING', 'cluster_lod', 'remesh', 'decimate', 'visibility', 'clodselect']) assert.ok(help.includes(w), w);
});

test('three.js GLTFLoader loads the cluster LOD glb (optional: AGENT_ART_THREE)', async (t) => {
  let GLTFLoader;
  try {
    const dir = process.env.AGENT_ART_THREE;
    if (!dir) throw new Error('unset');
    await import(pathToFileURL(path.join(dir, 'three', 'build', 'three.module.js')).href);
    ({ GLTFLoader } = await import(pathToFileURL(path.join(dir, 'three', 'examples', 'jsm', 'loaders', 'GLTFLoader.js')).href));
  } catch { t.skip('three.js not available (set AGENT_ART_THREE=<dir with node_modules/three>)'); return; }
  const e = new Engine({ home: tmp() });
  e.run('create', { name: 'hull', width: 8 });
  e.run('model_create', { name: 'pod', parts: [{ type: 'box', w: 64, h: 32, d: 48, texture: 'hull' }, { type: 'cylinder', r: 14, h: 40, segments: 32, at: [0, 20, 0], texture: 'hull' }] });
  e.run('model_boolean', { name: 'pod' });
  const r = e.run('model_cluster_lod', { name: 'pod_union' });
  const buf = fs.readFileSync(r.file);
  // textures need a DOM in GLTFLoader: strip them (geometry and nodes are what we check)
  const jl = buf.readUInt32LE(12), json = JSON.parse(buf.toString('utf8', 20, 20 + jl)), bin = buf.subarray(28 + jl);
  for (const m of json.materials || []) if (m.pbrMetallicRoughness) delete m.pbrMetallicRoughness.baseColorTexture;
  delete json.textures; delete json.images; delete json.samplers;
  let js = Buffer.from(JSON.stringify(json)); js = Buffer.concat([js, Buffer.alloc((4 - (js.length % 4)) % 4, 0x20)]);
  const hd = Buffer.alloc(12); hd.writeUInt32LE(0x46546c67, 0); hd.writeUInt32LE(2, 4); hd.writeUInt32LE(28 + js.length + bin.length, 8);
  const c1 = Buffer.alloc(8); c1.writeUInt32LE(js.length, 0); c1.writeUInt32LE(0x4e4f534a, 4);
  const c2 = Buffer.alloc(8); c2.writeUInt32LE(bin.length, 0); c2.writeUInt32LE(0x004e4942, 4);
  const out = Buffer.concat([hd, c1, js, c2, Buffer.from(bin)]);
  const gltf = await new Promise((res, rej) => new GLTFLoader().parse(out.buffer.slice(out.byteOffset, out.byteOffset + out.length), '', res, rej));
  let tris = 0;
  gltf.scene.traverse((o) => { if (o.isMesh && o.name.includes('_LOD0')) tris += (o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count) / 3; });
  assert.ok(tris > 0);
  assert.equal(gltf.scene.getObjectByName('pod_union_LOD1').userData.lod, 1);
});

test('derived meshes never overwrite another existing model unless overwrite:true', () => {
  const e = new Engine({ home: tmp() });
  e.run('model_create', { name: 'm', parts: [{ type: 'box', w: 32, h: 32, d: 32 }, { type: 'box', w: 16, h: 16, d: 16, at: [20, 0, 0] }] });
  e.run('model_create', { name: 'keep', parts: [{ type: 'cylinder', r: 8, h: 20 }] });
  for (const [op, extra] of [['model_decimate', { ratio: 0.5 }], ['model_remesh', { method: 'cleanup' }], ['model_boolean', {}]]) {
    assert.throws(() => e.run(op, { name: 'm', out: 'keep', ...extra }), /Model "keep" exists \(overwrite:true/, op);
  }
  assert.ok(!JSON.parse(fs.readFileSync(path.join(e.home, 'models', 'keep.json'), 'utf8')).baked, 'keep untouched');
  // default out name: re-deriving from the same source replaces the previous result
  e.run('model_decimate', { name: 'm', ratio: 0.5 });
  e.run('model_decimate', { name: 'm', ratio: 0.4 });
  // explicit overwrite replaces
  assert.equal(e.run('model_decimate', { name: 'm', ratio: 0.5, out: 'keep', overwrite: true }).model, 'keep');
  assert.equal(JSON.parse(fs.readFileSync(path.join(e.home, 'models', 'keep.json'), 'utf8')).baked.from, 'm');
});

test('cluster_lod keeps materials v2 (glass) and validates its numbers', async () => {
  const { validateGLB, parseGLB } = await import('../src/gltfcheck.js');
  const e = new Engine({ home: tmp() });
  e.run('model_create', { name: 'pod', parts: [{ type: 'box', w: 48, h: 24, d: 32, color: '#778' }, { type: 'box', w: 16, h: 8, d: 16, color: '#9fd8ff', material: 'glass_canopy', at: [0, 16, 0] }] });
  const r = e.run('model_cluster_lod', { name: 'pod', levels: 2 });
  const buf = fs.readFileSync(r.file), v = validateGLB(buf);
  assert.ok(v.ok, JSON.stringify(v.errors));
  const { json } = parseGLB(buf);
  assert.ok(json.extensionsUsed.includes('KHR_materials_transmission'), JSON.stringify(json.extensionsUsed));
  assert.ok(r.materials_v2 && r.materials_v2.valid);
  for (const [k, bad] of [['levels', 'abc'], ['cluster_size', 'x'], ['group_size', -1], ['lod_screen', { fov: 0 }], ['lod_screen', { height: 'tall' }], ['lod_screen', { fov: 200 }]]) {
    assert.throws(() => e.run('model_cluster_lod', { name: 'pod', [k]: bad }), new RegExp(k), `${k}: ${JSON.stringify(bad)}`);
  }
  assert.throws(() => e.run('model_cluster_lod', { name: 'pod', lightmap: true }), /lightmap/);
});

test('visibility .json path is not doubled; remesh resolution must be >= 1', () => {
  const e = new Engine({ home: tmp() });
  e.run('model_create', { name: 'pod', parts: [{ type: 'box', w: 48, h: 24, d: 32, color: '#778' }] });
  // visibility: a .json path is not doubled
  const vis = e.run('model_visibility', { name: 'pod', path: 'out/v.json' });
  assert.equal(path.basename(vis.file), 'v.vis.json');
  assert.equal(path.basename(e.run('model_visibility', { name: 'pod', path: 'out/w.vis.json' }).file), 'w.vis.json');
  assert.throws(() => e.run('model_remesh', { name: 'pod', method: 'voxel', resolution: -3 }), /resolution/);
});
