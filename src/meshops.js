// art_model mesh-processing actions: boolean, remesh, decimate, cluster_lod, visibility. Results of
// boolean / remesh / decimate are saved as new models with one "baked" part (the processed mesh,
// stored beside the model as <name>.mesh.bin with its textures), so they preview, export, LOD and
// rebuild like any other model. Units in the API are model units (metres at 32 px = 1 m).
import fs from 'node:fs';
import path from 'node:path';
import { Mesh } from './model3d.js';
import { booleanMesh } from './csg.js';
import { robustBoolean, unionAll } from './meshbool.js';
import { voxelRemesh, quadRemesh, cleanupRemesh } from './remesh.js';
import { decimateMesh } from './simplify.js';
import { buildClusterDAG, discreteLods, splitParts, clustersMesh, writeClod, uniformCut } from './clusterlod.js';
import { parseClod, selectClusters, lookAtPlanes } from './clodselect.js';
import { occluderBoxes, cellsAndPortals, boxTris, cellIndexOf } from './visibility.js';
import { manifoldReport, hausdorff, meshFromTris } from './meshkit.js';
import { writeGLB } from './glb.js';
import { exportV2, finishV2 } from './matops.js';
import { encodePNG } from './png.js';
import { packImages } from './sheet.js';
import { renderMeshViz, idTex } from './meshviz.js';
import { switchDistance } from './lod.js';
import { normCull } from './proxies.js';

const NAME_RE = /^[A-Za-z0-9_\-.]{1,64}$/;
const r4 = (v) => +(+v).toFixed(4);
const num = (v, name, { min = -Infinity, def } = {}) => {
  if (v === undefined || v === null) return def;
  const x = Number(v);
  if (!Number.isFinite(x) || x < min) throw new Error(`${name} must be a number${min > -Infinity ? ` >= ${min}` : ''} (got ${JSON.stringify(v)})`);
  return x;
};

// ---------- baked meshes ----------
const TYPED = { Uint8ClampedArray, Uint8Array, Float32Array, Uint16Array, Uint32Array, Int32Array, Float64Array };
/** Serialize a mesh (base + overlay groups, textures included) -> Buffer. */
export function packMesh(mesh) {
  const bins = [];
  const enc = (v) => {
    if (v === null || v === undefined || typeof v === 'function') return undefined;
    if (ArrayBuffer.isView(v)) { bins.push(Buffer.from(v.buffer, v.byteOffset, v.byteLength)); return { $bin: bins.length - 1, type: v.constructor.name }; }
    if (Array.isArray(v)) return v.map(enc);
    if (typeof v === 'object') { const o = {}; for (const [k, x] of Object.entries(v)) { if (k === 'heightOf' || k === 'ctm') continue; const e = enc(x); if (e !== undefined) o[k] = e; } return o; }
    return v;
  };
  const groups = [...mesh.groups.values()].map((g) => {
    const o = { tex: enc(g.tex), overlay: !!g.overlay, pos: enc(Float32Array.from(g.pos)), nrm: enc(Float32Array.from(g.nrm)), uv: enc(Float32Array.from(g.uv)), idx: enc(Uint32Array.from(g.idx)) };
    if (g.overlay) { o.uv0 = enc(Float32Array.from(g.uv0)); o.alpha = enc(Float32Array.from(g.alpha)); }
    if (g.col) o.col = enc(Float32Array.from(g.col));
    if (g.skin) o.skin = { j: enc(Uint16Array.from(g.skin.j)), w: enc(Float32Array.from(g.skin.w)) };
    if (g.faces) {
      // ov (overlay specs) is dropped: the overlay shells are already baked into overlay groups
      const props = [], pk = new Map(), F = new Uint32Array(g.faces.length * 6), FN = new Float32Array(g.faces.length * 3);
      g.faces.forEach((f, i) => {
        const { v, vc, i: ii, ic, n, mode, ov, ...rest } = f;
        FN.set(n, i * 3);
        const key = JSON.stringify(rest);
        if (!pk.has(key)) { pk.set(key, props.length); props.push(rest); }
        F.set([v, vc, ii, ic, 0, pk.get(key)], i * 6); // mode 0: UVs are final (no world re-tiling)
      });
      o.faces = enc(F); o.fn = enc(FN); o.props = props;
    }
    return o;
  });
  const json = Buffer.from(JSON.stringify({ version: 1, groups, bins: bins.map((b) => b.length) }));
  const head = Buffer.alloc(8); head.writeUInt32LE(0x4853454d, 0); head.writeUInt32LE(json.length, 4); // "MESH"
  return Buffer.concat([head, json, ...bins]);
}
/** Buffer -> Mesh. */
export function unpackMesh(buf) {
  if (buf.readUInt32LE(0) !== 0x4853454d) throw new Error('not a baked mesh file');
  const jl = buf.readUInt32LE(4), J = JSON.parse(buf.subarray(8, 8 + jl).toString());
  const bins = [];
  let off = 8 + jl;
  for (const n of J.bins) { bins.push(buf.subarray(off, off + n)); off += n; }
  const dec = (v) => {
    if (Array.isArray(v)) return v.map(dec);
    if (v && typeof v === 'object') {
      if (v.$bin !== undefined) { const b = bins[v.$bin], T = TYPED[v.type]; const copy = new Uint8Array(b.length); copy.set(b); return new T(copy.buffer, 0, b.length / T.BYTES_PER_ELEMENT); }
      const o = {}; for (const [k, x] of Object.entries(v)) o[k] = dec(x); return o;
    }
    return v;
  };
  const m = new Mesh();
  for (const G of J.groups) {
    const tex = dec(G.tex);
    const g = m.group(tex, G.overlay);
    g.pos = Array.from(dec(G.pos)); g.nrm = Array.from(dec(G.nrm)); g.uv = Array.from(dec(G.uv)); g.idx = Array.from(dec(G.idx));
    if (G.overlay) { g.uv0 = Array.from(dec(G.uv0)); g.alpha = Array.from(dec(G.alpha)); }
    if (G.col) g.col = Array.from(dec(G.col));
    if (G.skin) g.skin = { j: Array.from(dec(G.skin.j)), w: Array.from(dec(G.skin.w)) };
    if (G.faces) {
      const F = dec(G.faces), FN = dec(G.fn);
      g.faces = [];
      for (let i = 0, k = 0; i < F.length; i += 6, k += 3) {
        const [v, vc, ii, ic, mode, pi] = F.subarray(i, i + 6);
        g.faces.push({ v, vc, i: ii, ic, n: [FN[k], FN[k + 1], FN[k + 2]], mode, ...G.props[pi] });
      }
    }
  }
  return m;
}
const bakedCache = new Map();
/** Baked mesh of model `name` in the workspace models folder (cached by mtime). */
export function loadBaked(dir, name) {
  if (!NAME_RE.test(name || '')) throw new Error(`baked part: mesh must be a model name (got ${JSON.stringify(name)})`);
  const file = path.join(dir, `${name}.mesh.bin`);
  if (!fs.existsSync(file)) throw new Error(`baked part: no baked mesh "${name}" (made by art_model boolean / remesh / decimate)`);
  const st = fs.statSync(file), c = bakedCache.get(file);
  if (c && c.mtime === st.mtimeMs && c.size === st.size) return c.mesh;
  const mesh = unpackMesh(fs.readFileSync(file));
  bakedCache.set(file, { mtime: st.mtimeMs, size: st.size, mesh });
  return mesh;
}

// ---------- shared ----------
const manifoldBrief = (m) => { const r = manifoldReport(m); return { closed: r.closed, open_edges: r.open, non_manifold_edges: r.nonManifold, non_manifold_vertices: r.nonManifoldVertices, flipped_edges: r.flipped, shells: r.components }; };
const preview = (mesh, a, wire) => {
  if (!a.preview) return {};
  const img = renderMeshViz(mesh, { view: a.view && typeof a.view === 'string' ? a.view : 'iso', size: a.size ?? 320, wire });
  return { image: encodePNG(img.width, img.height, img.data) };
};

/**
 * The actions. api = modelops internals: {getModel, build, saveModel, modelDir}.
 */
export function meshOpsFor(api) {
  const { getModel, build, saveModel, modelDir, hasModel } = api;
  const scaleOf = (def) => Number(def.scale ?? 32);
  const sourceMesh = (engine, def) => build(engine, def).mesh;
  const outName = (engine, a, def, suffix) => {
    const n = a.out ?? `${def.name}_${suffix}`;
    if (typeof n !== 'string' || !NAME_RE.test(n)) throw new Error('out must be a model name: 1-64 letters, digits, _ - .');
    if (n === def.name && !a.overwrite) throw new Error(`out "${n}" is the source model; pick another name (or overwrite:true to replace it with the baked result)`);
    // an existing model is never replaced silently; the default name may be re-derived from the same source
    if (n !== def.name && hasModel(engine, n) && !a.overwrite && !(a.out === undefined && getModel(engine, n).baked?.from === def.name)) throw new Error(`Model "${n}" exists (overwrite:true replaces it with the baked result; or pick another out name)`);
    return n;
  };
  const saveBaked = (engine, def, out, mesh, info, source) => {
    const dir = modelDir(engine);
    fs.writeFileSync(path.join(dir, `${out}.mesh.bin.tmp`), packMesh(mesh));
    fs.renameSync(path.join(dir, `${out}.mesh.bin.tmp`), path.join(dir, `${out}.mesh.bin`));
    const nd = { name: out, parts: [{ type: 'baked', mesh: out }], ...(def.scale !== undefined ? { scale: def.scale } : {}), ...(def.grid !== undefined ? { grid: def.grid } : {}), ...(def.project ? { project: def.project } : {}), baked: { from: def.name, ...info, at: Date.now() }, created: Date.now() };
    saveModel(engine, nd, source, `${info.action} ${def.name} -> ${out}`);
    return nd;
  };
  const exportPath = (engine, def, a, ext = '.glb') => {
    let file = engine.resolvePath(a.path || `${def.name}${ext}`, engine.exportDir);
    if (/[\\/]$/.test(a.path || '') || (fs.existsSync(file) && fs.statSync(file).isDirectory())) file = path.join(file, `${def.name}${ext}`);
    if (!file.toLowerCase().endsWith(ext)) {
      // "v.json" for ".vis.json" -> "v.vis.json" (not "v.json.vis.json")
      const tail = path.extname(ext);
      if (tail !== ext && file.toLowerCase().endsWith(tail)) file = file.slice(0, -tail.length);
      file += ext;
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    return file;
  };
  const cellsOf = (def, built, a, scale) => {
    if (Array.isArray(a.cells)) return a.cells.map((c, i) => {
      if (!c || typeof c.name !== 'string' || !Array.isArray(c.min) || !Array.isArray(c.max)) throw new Error(`cells[${i}] must be {name, min:[x,y,z], max:[x,y,z]} (units)`);
      return { name: c.name, min: c.min.map((v) => Number(v) * scale), max: c.max.map((v) => Number(v) * scale) };
    });
    if (def.cull) return normCull(def.cull, built.grid).rooms;
    // parts tagged room:"<name>": the union of their bounds
    const rooms = new Map();
    def.parts.forEach((p, i) => {
      if (!p || typeof p.room !== 'string' || !built.partBounds[i]) return;
      const b = built.partBounds[i], r = rooms.get(p.room);
      rooms.set(p.room, r ? { name: p.room, min: r.min.map((v, k) => Math.min(v, b.min[k])), max: r.max.map((v, k) => Math.max(v, b.max[k])) } : { name: p.room, min: b.min.slice(), max: b.max.slice() });
    });
    return [...rooms.values()];
  };
  const visibilityOf = (engine, def, built, mesh, a, scale) => {
    const v = a.visibility === true || a.visibility === undefined ? {} : a.visibility;
    const cells = cellsOf(def, built, { ...a, ...v }, scale);
    const U = (p) => p.map((x) => r4(x / scale));
    const out = { units: 'model units (px / px_per_unit)' };
    if (cells.length) {
      const cp = cellsAndPortals(mesh, cells, { step: num(v.step ?? a.step, 'step', { min: 0.01, def: 0.25 }) * scale, probe: num(v.probe, 'probe', { min: 0.01, def: 0.4 }) * scale, depth: v.depth ?? a.depth, pvs: v.pvs !== false });
      out.cells = cp.cells.map((c) => ({ name: c.name, min: U(c.min), max: U(c.max) }));
      out.portals = cp.portals.map((p) => ({ id: p.id, cells: p.cells, min: U(p.min), max: U(p.max), center: U(p.center), normal: p.normal, samples: p.samples }));
      out.pvs = cp.pvs;
      out.stats = cp.stats;
    }
    if (v.occluder !== false) {
      const oc = occluderBoxes(mesh, { ...(v.occluder?.voxel ? { voxel: Number(v.occluder.voxel) * scale } : {}), resolution: v.occluder?.resolution ?? 48, maxBoxes: v.occluder?.max_boxes ?? 32 });
      out.occluders = { type: 'boxes', conservative: true, boxes: oc.boxes.map((b) => ({ min: U(b.min), max: U(b.max) })), voxel: r4(oc.stats.voxel_px / scale), solid_voxels: oc.stats.solid_voxels };
    }
    out.note = 'Runtime: find the camera cell (point in box), draw it + pvs[cell] (or walk portals through the frustum); occluder boxes are inside the surface (safe for occlusion queries / software occlusion).';
    return { vis: out, cells };
  };

  return {
    /**
     * boolean {name, op?:"union"|"subtract"|"intersect", with?:<model>, out?, method?:"auto"|"robust"|"bsp"}:
     * without `with`, union of every closed shell of the model into one (hidden interior faces removed).
     */
    model_boolean(a, source) {
      const def = getModel(this, a.name), t0 = performance.now();
      const op = a.op ?? 'union';
      if (!['union', 'subtract', 'intersect'].includes(op)) throw new Error('op must be union, subtract or intersect');
      const A = sourceMesh(this, def);
      let res;
      if (a.with) {
        const B = sourceMesh(this, getModel(this, a.with));
        const method = a.method ?? 'robust';
        res = method === 'bsp' ? { mesh: booleanMesh(op, A, B, { method: 'bsp' }), stats: { method: 'bsp' } } : robustBoolean(op, A, B);
      } else {
        if (op !== 'union') throw new Error(`${op} needs with:"<model>" (the cutter / other operand); without it boolean unions the model's shells`);
        res = unionAll(A);
      }
      const out = outName(this, a, def, op);
      const before = A.triangles, mf = manifoldBrief(res.mesh);
      saveBaked(this, def, out, res.mesh, { action: 'boolean', op, with: a.with }, source);
      return { model: out, op, triangles_in: before, triangles: res.mesh.triangles, manifold: mf, stats: res.stats, ms: Math.round(performance.now() - t0), ...preview(res.mesh, a, false), next: `art_model preview {name:"${out}"} | cluster_lod {name:"${out}"} | export {name:"${out}"}` };
    },
    /**
     * remesh {name, method:"voxel"|"quad"|"cleanup", out?, voxel? (units) | resolution?, sharp?, faces?, symmetry?, feature_angle?}
     */
    model_remesh(a, source) {
      const def = getModel(this, a.name), scale = scaleOf(def), t0 = performance.now();
      const method = a.method ?? 'voxel';
      const src = sourceMesh(this, def);
      let r;
      if (method === 'voxel') r = voxelRemesh(src, { ...(a.voxel !== undefined ? { voxel: num(a.voxel, 'voxel', { min: 1e-6 }) * scale } : {}), ...(a.resolution !== undefined ? { resolution: num(a.resolution, 'resolution', { min: 1 }) } : {}), sharp: a.sharp, simplify: a.simplify, ...(a.max_error !== undefined ? { max_error: num(a.max_error, 'max_error', { min: 0 }) * scale } : {}), feature_angle: a.feature_angle });
      else if (method === 'quad') r = quadRemesh(src, { faces: a.faces, feature_angle: a.feature_angle, symmetry: a.symmetry, iterations: a.iterations });
      else if (method === 'cleanup') r = cleanupRemesh(src, { weld: a.weld !== undefined ? num(a.weld, 'weld', { min: 0 }) * scale : undefined, holes: a.holes });
      else throw new Error('method must be voxel (watertight shell from any soup), quad (quad-dominant retopology) or cleanup (weld, degenerates, winding, small holes)');
      const out = outName(this, a, def, method);
      const h = hausdorff(src, r.mesh, { perTri: 4 });
      saveBaked(this, def, out, r.mesh, { action: 'remesh', method }, source);
      return {
        model: out, method, triangles_in: src.triangles, triangles: r.mesh.triangles, manifold: manifoldBrief(r.mesh),
        hausdorff_units: { result_to_source: r4(h.ba / scale), source_to_result: r4(h.ab / scale), note: 'source_to_result includes hidden interior faces of the source (they are gone from a voxel shell)' },
        stats: r.stats, ms: Math.round(performance.now() - t0), ...preview(r.mesh, a, method === 'quad' ? 'faces' : 'tris'),
      };
    },
    /** decimate {name, out?, ratio? | triangles? | max_error? (units, guaranteed), feature_angle? (45), seams?} */
    model_decimate(a, source) {
      const def = getModel(this, a.name), scale = scaleOf(def), t0 = performance.now();
      const src = sourceMesh(this, def);
      const maxError = a.max_error !== undefined ? num(a.max_error, 'max_error', { min: 0 }) * scale : Infinity;
      if (a.ratio === undefined && a.triangles === undefined && maxError === Infinity) throw new Error('decimate needs ratio (0..1), triangles (target count) or max_error (units: the largest allowed distance from the source)');
      const r = decimateMesh(src, { ratio: a.ratio !== undefined ? num(a.ratio, 'ratio', { min: 0 }) : undefined, triangles: a.triangles !== undefined ? num(a.triangles, 'triangles', { min: 1 }) : undefined, maxError, featureAngle: num(a.feature_angle, 'feature_angle', { min: 0, def: 45 }), seams: a.seams !== false, attrWeight: a.attr_weight });
      const h = hausdorff(src, r.mesh);
      const out = outName(this, a, def, 'dec');
      saveBaked(this, def, out, r.mesh, { action: 'decimate', ratio: a.ratio, triangles: a.triangles, max_error: a.max_error }, source);
      return {
        model: out, triangles_in: r.source, triangles: r.triangles, ratio: r4(r.triangles / Math.max(1, r.source)),
        error_units: { bound: maxError === Infinity ? null : r4(maxError / scale), tracked: r4(r.error / scale), hausdorff: r4(h.max / scale), source_to_result: r4(h.ab / scale), result_to_source: r4(h.ba / scale) },
        constraints: r.constraints, manifold: manifoldBrief(r.mesh), ms: Math.round(performance.now() - t0), ...preview(r.mesh, a, 'tris'),
      };
    },
    /**
     * cluster_lod {name, path?, cluster_size?:128, group_size?:4, levels?:4, max_part_tris?:20000,
     * lod_screen?:{height, fov, px}, visibility?, distances?:[m, m, m] (preview)}
     */
    model_cluster_lod(a) {
      const def = getModel(this, a.name), scale = scaleOf(def), t0 = performance.now();
      const built = build(this, def), mesh = built.mesh;
      const ls = a.lod_screen ?? {};
      if (typeof ls !== 'object' || Array.isArray(ls)) throw new Error('lod_screen must be {height?, fov?, px?}');
      const screen = { height: num(ls.height, 'lod_screen.height', { min: 1, def: 720 }), fov: num(ls.fov, 'lod_screen.fov', { min: 1, def: 70 }), px: num(ls.px, 'lod_screen.px', { min: 0.01, def: 1 }) };
      if (screen.fov >= 179) throw new Error(`lod_screen.fov must be 1..179 degrees (got ${JSON.stringify(ls.fov)})`);
      const levels = Math.min(8, Math.round(num(a.levels, 'levels', { min: 1, def: 4 })));
      const maxPart = Math.max(100, Math.round(num(a.max_part_tris, 'max_part_tris', { min: 1, def: 20000 })));
      if (a.lightmap || a.thickness || a.bake_ao) throw new Error('cluster_lod does not bake lightmap / thickness / bake_ao; bake them with art_model export (profile, packing, tangents and vertex_colors work here)');
      const dag = buildClusterDAG(mesh, { clusterSize: num(a.cluster_size, 'cluster_size', { min: 1, def: 128 }), groupSize: num(a.group_size, 'group_size', { min: 1, def: 4 }), seams: a.seams });
      const lods = discreteLods(dag, { levels });
      const file = exportPath(this, { name: `${def.name}_lod` }, a); // default <name>_lod.glb: model export keeps <name>.glb
      const base = file.replace(/\.glb$/i, ''), clodFile = `${base}.clod`;
      // discrete LOD nodes: <name>_lods > <name>_LOD<i> > <name>_LOD<i>_p<k> (<= max_part_tris each)
      const meshes = [], nodes = [{ name: `${def.name}_lods`, children: [], extras: { lod_group: true } }];
      const lodLevels = lods.map((L) => {
        const parts = splitParts(dag, L.clusters, maxPart);
        const ln = { name: `${def.name}_LOD${L.level}`, children: [], extras: {} };
        nodes.push(ln); nodes[0].children.push(nodes.length - 1);
        const li = nodes.length - 1;
        const dist = L.level === 0 ? 0 : switchDistance(L.tau / scale, screen);
        parts.forEach((pc, k) => {
          const m = clustersMesh(dag, pc);
          meshes.push({ name: `${def.name}_LOD${L.level}_p${k}`, groups: [...m.groups.values()] });
          nodes.push({ name: `${def.name}_LOD${L.level}_p${k}`, mesh: meshes.length - 1, extras: { lod: L.level, part: k, triangles: m.triangles, clusters: pc.length }, ...(L.level ? { lodHidden: true } : {}) });
          nodes[li].children.push(nodes.length - 1);
        });
        ln.extras = { lod: L.level, distance: r4(dist), error: L.level ? r4(L.tau / scale) : 0, triangles: L.triangles, parts: parts.length };
        return { level: L.level, triangles: L.triangles, error: L.level ? r4(L.tau / scale) : 0, distance: r4(dist), parts: parts.map((pc) => pc.reduce((s, c) => s + c.tris.length, 0)) };
      });
      nodes[0].extras.levels = lodLevels.map((l) => ({ level: l.level, distance: l.distance, triangles: l.triangles }));
      // visibility (cells / portals / pvs / occluders) in the same sidecar
      let vis = null;
      if (a.visibility) {
        const v = visibilityOf(this, def, built, mesh, a, scale);
        vis = v.vis;
        if (v.cells.length) vis.cluster_cell = dag.clusters.map((c) => cellIndexOf(v.cells, c.bounds));
      }
      const clod = writeClod(dag, { scale, extra: { screen, lods: lodLevels, glb: path.basename(file), ...(vis ? { visibility: vis } : {}) } });
      // materials v2 (glass / neon / paint extensions, packing, tangents, vertex colours): same stage as model export
      const v2a = {}; for (const k of ['profile', 'packing', 'tangents', 'vertex_colors', 'uv2', 'uv3']) if (a[k] !== undefined) v2a[k] = a[k];
      const v2 = exportV2(def, built, v2a, { meshes, nodes, ext: null, scale, file, info: null });
      const { glb, stats } = writeGLB({ meshes: v2 ? v2.meshes : meshes, nodes }, { scale, name: def.name, extras: { cluster_lod: { file: path.basename(clodFile), format: 'agent-art cluster LOD v1 (docs/meshproc/README.md)', clusters: dag.clusters.length, levels: dag.stats.levels } }, ...(v2 ? { ...v2.glbOpts, v2: v2.v2 } : {}) });
      if (v2) finishV2(v2, glb, stats);
      fs.writeFileSync(file, glb);
      if (v2) for (const [f, buf] of v2.side) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, buf); }
      fs.writeFileSync(clodFile, clod);
      const meta = {
        name: def.name, file: path.basename(file), clod: path.basename(clodFile), generator: 'agent-art', px_per_unit: scale,
        cluster_lod: { ...dag.stats, root_error: r4(dag.stats.root_error_px / scale), bytes: clod.length },
        lods: { levels: lodLevels, screen, max_part_tris: maxPart, note: 'Discrete LODs cut from the cluster DAG (uniform error). Roblox: one MeshPart per <name>_LOD<i>_p<k> node (<= max_part_tris). three.js: THREE.LOD with each <name>_LOD<i> at extras.distance, or stream the .clod with clodselect.js.' },
        ...(vis ? { visibility: { cells: vis.cells?.length ?? 0, portals: vis.portals?.length ?? 0, occluders: vis.occluders?.boxes.length ?? 0 } } : {}),
        ...(v2 ? v2.meta : {}),
      };
      fs.writeFileSync(`${base}.meta.json`, JSON.stringify(meta, null, 2));
      const res = { file, clod: clodFile, meta: `${base}.meta.json`, bytes: { glb: glb.length, clod: clod.length }, clusters: dag.stats, lods: lodLevels, glb_triangles: stats.triangles, ...(vis ? { visibility: meta.visibility } : {}), ...(v2 ? v2.result : {}), ms: Math.round(performance.now() - t0) };
      // preview: clusters colour-coded at three camera distances (+ culling stats)
      if (a.preview || a.distances) {
        const h = parseClod(clod);
        const b = mesh.bounds(), ctr = b.min.map((v, k) => (v + b.max[k]) / 2 / scale), R = Math.hypot(...b.max.map((v, k) => v - b.min[k])) / 2 / scale;
        const ds = (a.distances || [R * 1.2, R * 6, R * 30]).map(Number);
        const dir = [0.62, 0.36, 0.7], dl = Math.hypot(...dir);
        const panels = [], sel = [];
        for (const d of ds) {
          const pos = ctr.map((v, k) => v + (dir[k] / dl) * d);
          const cam = { position: pos, fov: screen.fov, height: screen.height, planes: lookAtPlanes({ position: pos, target: ctr, fov: screen.fov, aspect: 16 / 9, near: 0.05, far: d + R * 4 }) };
          const s = selectClusters(h, cam, { pixelError: screen.px });
          const m = clustersMesh(dag, s.clusters.map((i) => dag.clusters[i]), { colorTex: idTex });
          const fit = []; for (const x of [b.min[0], b.max[0]]) for (const y of [b.min[1], b.max[1]]) for (const z of [b.min[2], b.max[2]]) fit.push([x, y, z]);
          const img = renderMeshViz(m, { view: 'iso', size: a.size ?? 256, wire: false, fit });
          panels.push({ img, label: `${r4(d)}u ${s.triangles}t` });
          sel.push({ distance: r4(d), triangles: s.triangles, ...s.stats });
        }
        const sheet = packImages(panels, { labels: true, checker: false, columns: panels.length });
        res.image = encodePNG(sheet.width, sheet.height, sheet.data);
        res.selection = sel;
      }
      return res;
    },
    /** visibility {name, path?, cells?:[{name, min, max}] (units), step?, depth?, occluder?:{voxel?, max_boxes?} | false} */
    model_visibility(a) {
      const def = getModel(this, a.name), scale = scaleOf(def), t0 = performance.now();
      const built = build(this, def);
      const { vis, cells } = visibilityOf(this, def, built, built.mesh, { ...a, visibility: { occluder: a.occluder, pvs: a.pvs, depth: a.depth, step: a.step } }, scale);
      if (!cells.length) vis.cells_note = 'no cells: pass cells:[{name, min, max}] (units), set the model cull:{rooms}, or tag parts room:"<name>"';
      const file = exportPath(this, def, a, '.vis.json');
      fs.writeFileSync(file, JSON.stringify(vis, null, 2));
      return { file, cells: vis.cells?.length ?? 0, portals: vis.portals ?? [], pvs: vis.pvs ?? {}, occluders: vis.occluders?.boxes.length ?? 0, ms: Math.round(performance.now() - t0) };
    },
  };
}

/** Occluder boxes as a mesh (for previews). */
export const occluderMesh = (boxes, tex) => meshFromTris(boxTris(boxes).map((p) => ({ p, g: 0, f: { mat: 'occluder' } })), [{ tex }]);
export { uniformCut };
