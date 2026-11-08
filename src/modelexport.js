// art_model export / preview extras: morph targets, cast/receive shadow node split, GPU-instanced
// greebles (EXT_mesh_gpu_instancing), LOD chains with switch distances, baked AO, collision and
// occluder proxies, impostor atlases, room/portal cull data and per-part stats. Nothing here runs
// unless a model or an export asks for it, so plain exports stay byte-for-byte the same.
import fs from 'node:fs';
import path from 'node:path';
import { Mesh } from './model3d.js';
import { encodePNG } from './png.js';
import { Doc, Layer } from './doc.js';
import { bakeAO, normAO } from './bake.js';
import { simplifyMesh, switchDistance } from './lod.js';
import { normProxy, buildProxy, normCull, cullLayout } from './proxies.js';
import { normImpostor, bakeImpostor } from './impostor.js';
import { renderViews } from './raster3d.js';
import { quatOfMat } from './modelrig.js';
import { paintTrimSheet, trimStrips, TRIM_STYLES, DEFAULT_TRIM } from './surface.js';

const NAME_RE = /^[A-Za-z0-9_\-.]{1,64}$/;
const f6 = (v) => +(+v).toFixed(6);
const groupsOf = (mesh) => [...mesh.groups.values()].filter((g) => g.idx.length);
const hasFlags = (mesh) => mesh.faces.some(({ f }) => f.cs !== undefined || f.rs !== undefined);

/** Does this export need the extras pipeline? */
export function wantsExtras(def, built, a) {
  return !!(a.bake_ao || a.lods || a.impostor || a.collision || a.occluder || a.stats || a.cull || def.cull || def.morphs || built.gpu || hasFlags(built.mesh));
}

// ---------- morph targets ----------
/**
 * def.morphs:{open:{set:{<part>:{..}}} | {model:"<other model>"}} -> per-group morph positions on
 * built.mesh (same topology required: transforms and sizes may change, segment counts may not).
 */
export function attachMorphs(def, built, { variantDef, buildDef }) {
  const names = [];
  for (const [name, spec] of Object.entries(def.morphs || {})) {
    if (!/^[\w.-]{1,48}$/.test(name)) throw new Error(`morph name "${name}" must be 1-48 letters, digits, _ - .`);
    if (!spec || typeof spec !== 'object' || (!spec.set && !spec.model)) throw new Error(`morph "${name}" must be {set:{<part index|name|id>:{..patch}}} or {model:"<model with the same topology>"}`);
    const vdef = { ...variantDef(spec), origin: built.shift.map((v) => -v), morphs: undefined };
    const v = buildDef(vdef).mesh;
    const A = [...built.mesh.groups.values()], B = [...v.groups.values()];
    const why = (m) => new Error(`morph "${name}": ${m} (a morph may move, turn or resize parts, not change their segment counts, CTM layout or overlays)`);
    if (A.length !== B.length) throw why(`${B.length} materials vs ${A.length}`);
    A.forEach((g, i) => {
      const h = B[i];
      if (g.tex.key !== h.tex.key || g.pos.length !== h.pos.length || g.idx.length !== h.idx.length) throw why(`material ${g.tex.name} has ${h.pos.length / 3} vertices vs ${g.pos.length / 3}`);
      for (let k = 0; k < g.idx.length; k++) if (g.idx[k] !== h.idx[k]) throw why(`material ${g.tex.name} triangles differ`);
      if (g.overlay) throw why('overlay shells cannot morph');
      (g.morphs || (g.morphs = [])).push({ name, pos: h.pos.slice(), nrm: h.nrm.slice() });
    });
    names.push(name);
  }
  return names;
}

// ---------- node splits ----------
/** Split a mesh by a face key fn(f) (overlays go to the default key). -> Map key -> Mesh */
function splitBy(mesh, keyOf, overlayKey) {
  const out = new Map();
  const tgt = (k) => { if (!out.has(k)) out.set(k, new Mesh()); return out.get(k); };
  for (const g of mesh.groups.values()) {
    if (g.overlay) { tgt(overlayKey).add({ groups: new Map([[g.tex.key, g]]) }); continue; }
    for (const f of g.faces) {
      const tg = tgt(keyOf(f)).group(g.tex), base = tg.pos.length / 3, i0 = tg.idx.length;
      for (let v = f.v; v < f.v + f.vc; v++) { tg.pos.push(g.pos[v * 3], g.pos[v * 3 + 1], g.pos[v * 3 + 2]); tg.nrm.push(g.nrm[v * 3], g.nrm[v * 3 + 1], g.nrm[v * 3 + 2]); tg.uv.push(g.uv[v * 2], g.uv[v * 2 + 1]); }
      for (let i = f.i; i < f.i + f.ic; i++) tg.idx.push(g.idx[i] - f.v + base);
      tg.faces.push({ ...f, n: f.n.slice(), v: base, i: i0 });
    }
  }
  return out;
}
const flagKey = (f) => `${f.cs === false ? 0 : 1}${f.rs === false ? 0 : 1}`;
const flagExtras = (k) => ({ cast_shadow: k[0] === '1', receive_shadow: k[1] === '1' });

/** 3x4 matrix (px) -> TRS (translation px, quaternion, scale). */
function decompose(M) {
  const sx = Math.hypot(M[0], M[4], M[8]) || 1, sy = Math.hypot(M[1], M[5], M[9]) || 1, sz0 = Math.hypot(M[2], M[6], M[10]) || 1;
  const det = M[0] * (M[5] * M[10] - M[6] * M[9]) - M[1] * (M[4] * M[10] - M[6] * M[8]) + M[2] * (M[4] * M[9] - M[5] * M[8]);
  const sz = det < 0 ? -sz0 : sz0;
  const R = [M[0] / sx, M[1] / sy, M[2] / sz, 0, M[4] / sx, M[5] / sy, M[6] / sz, 0, M[8] / sx, M[9] / sy, M[10] / sz, 0];
  return { t: [M[3], M[7], M[11]], q: quatOfMat(R), s: [sx, sy, sz] };
}
function gpuNode(name, meshIndex, it, extras) {
  const t = [], r = [], s = [];
  for (const M of it.mats) { const d = decompose(M); t.push(...d.t); r.push(...d.q); s.push(...d.s); }
  return { name, mesh: meshIndex, instancing: { t, r, s, mats: it.mats }, extras: { gpu_instances: it.mats.length, greeble: true, ...(extras || {}) } };
}
const flatGpu = (gpu) => { const m = new Mesh(); for (const it of gpu || []) for (const M of it.mats) m.add(it.mesh.clone().transform(M)); return m; };

/** lods:[1, 0.5, 0.2] (first = 1 = LOD0) -> ratios. */
function normLods(v) {
  if (!v) return null;
  const list = v === true ? [1, 0.5, 0.2] : v;
  if (!Array.isArray(list) || list.length < 2 || list.some((x) => !(Number(x) > 0 && Number(x) <= 1))) throw new Error('lods must be a list of triangle ratios 0..1, first 1 = LOD0, e.g. [1, 0.5, 0.2]');
  const r = list.map(Number);
  for (let i = 1; i < r.length; i++) if (!(r[i] < r[i - 1])) throw new Error('lods ratios must decrease (e.g. [1, 0.5, 0.2])');
  if (r[0] !== 1) r.unshift(1);
  return r;
}
const unitsBox = (b, scale) => ({ min: b.min.map((v) => f6(v / scale)), max: b.max.map((v) => f6(v / scale)), size: b.max.map((v, i) => f6((v - b.min[i]) / scale)) });

/**
 * Plain (non-rig) export with extras. -> {meshes, nodes, glbOpts, meta (merged into meta.json),
 * result (merged into the tool result), after(file) (writes side files)}
 */
export function exportExtras(engine, def, built, a, { scale, file, info, meshes, nodes, writeGLB, variantDef, buildDef }) {
  const meta = {}, result = {}, side = [];
  const glbOpts = {};
  const lods = normLods(a.lods);
  const ao = normAO(a.bake_ao);
  const cullSpec = a.cull ?? def.cull;
  const screen = { height: Number(a.lod_screen?.height ?? 720), fov: Number(a.lod_screen?.fov ?? 70), px: Number(a.lod_screen?.px ?? 1) };
  if (!(screen.height > 0 && screen.fov > 0 && screen.fov < 180 && screen.px > 0)) throw new Error('lod_screen must be {height?:720 px > 0, fov?:70 deg (0..180), px?:1 > 0}');
  const root = built.mesh;
  const base = file.replace(/\.glb$/i, '');
  if (info || a.instances) {
    const what = [lods && 'lods', cullSpec && 'cull', def.morphs && 'morphs', info && ao && 'bake_ao'].filter(Boolean);
    if (what.length) throw new Error(`${what.join(', ')}: not available on ${info ? 'rigged models (named parts / sockets / clips)' : 'instances:true exports'} yet; export without ${what.join(' / ')}`);
  }
  // world copies of the layout instances + GPU pieces (occluders, impostor, proxies)
  const instWorld = new Mesh();
  for (const it of built.instances) instWorld.add(it.mesh.clone().transform(it.matrix));
  const gpuWorld = flatGpu(built.gpu);
  const whole = () => { const m = root.clone(); m.add(instWorld); m.add(gpuWorld); return m; };

  if (!info) {
    // ---- morphs on the root mesh
    if (def.morphs) {
      if (hasFlags(root) || cullSpec) throw new Error('morphs need the model in one mesh: drop cast_shadow / receive_shadow flags and cull, or put the moving part in its own model');
      const names = attachMorphs(def, built, { variantDef, buildDef });
      meta.morphs = { targets: names, note: 'glTF morph targets on the model mesh (mesh.extras.targetNames; three.js: mesh.morphTargetDictionary[name] -> morphTargetInfluences[i] = 0..1). Deltas = variant - base.' };
      result.morphs = names;
    }
    // ---- root parts: rooms, or shadow-flag groups, or the whole mesh
    let rootParts;
    let cull = null;
    if (cullSpec) {
      cull = cullLayout(root, normCull(cullSpec, built.grid));
      rootParts = [...cull.meshes].filter(([, m]) => m.triangles).map(([room, m]) => ({ name: `room_${room}`, mesh: m, extras: { room } }));
    } else if (hasFlags(root)) {
      rootParts = [...splitBy(root, flagKey, '11')].filter(([, m]) => m.triangles).map(([k, m]) => ({ name: k === '11' ? def.name : `${def.name}_${k[0] === '0' ? 'noshadow' : 'shadow'}${k[1] === '0' ? '_unlit' : ''}`, mesh: m, extras: flagExtras(k) }));
    } else rootParts = root.triangles ? [{ name: def.name, mesh: root }] : [];
    // ---- LOD levels (from the root mesh; GPU greebles follow their drop level)
    const lodMeshes = [];
    if (lods) {
      for (let i = 1; i < lods.length; i++) {
        const r = simplifyMesh(root, { ratio: lods[i], level: i });
        lodMeshes.push({ level: i, ratio: lods[i], ...r });
      }
    }
    // ---- AO bake (one lightmap for every LOD level; each level occludes itself)
    if (ao) {
      const sets = [{ meshes: rootParts.map((p) => p.mesh), occluders: [instWorld, gpuWorld] }, ...lodMeshes.map((l) => ({ meshes: [l.mesh] }))];
      if (built.gpu) for (const it of built.gpu) sets.push({ meshes: [it.mesh] });
      const { stats, map } = bakeAO(sets, ao);
      if (map) glbOpts.ao = map;
      meta.ao = { ...stats, note: ao.mode === 'vertex' ? 'per-vertex AO in COLOR_0 (three.js multiplies the base colour when vertexColors is on: GLTFLoader enables it for COLOR_0)' : 'AO lightmap = material occlusionTexture with texCoord 1 (TEXCOORD_1, unique per face); NEAREST sampled. three.js: aoMap on uv1, aoMapIntensity 1' + (ao.mode === 'both' ? '; plus per-vertex AO in COLOR_0' : '') };
      result.ao = stats;
    }
    // ---- nodes
    const outMeshes = [], outNodes = [];
    const addMesh = (name, mesh) => { outMeshes.push({ name, groups: mesh.groups.values() }); return outMeshes.length - 1; };
    const gpuNodes = (level) => {
      const ids = [];
      (built.gpu || []).forEach((it, k) => {
        const drop = it.mesh.faces[0]?.f.greeble ?? Infinity;
        if (level >= drop) return;
        const mi = it._mi ?? (it._mi = addMesh(`${def.name}_greeble_${k}`, it.mesh));
        outNodes.push(gpuNode(`${def.name}_greebles_${k}${lods ? `_LOD${level}` : ''}`, mi, it, { drop_lod: drop === Infinity ? null : drop }));
        if (level > 0) outNodes[outNodes.length - 1].lodHidden = true;
        ids.push(outNodes.length - 1);
      });
      return ids;
    };
    const instNodes = nodes.filter((n) => n.instance || (n.mesh !== undefined && n.name !== def.name));
    if (lods) {
      const levels = [{ level: 0, ratio: 1, triangles: root.triangles + (built.gpu || []).reduce((s, it) => s + it.mesh.triangles * it.mats.length, 0), error: 0 }];
      for (const l of lodMeshes) levels.push({ level: l.level, ratio: l.ratio, triangles: l.triangles + (built.gpu || []).filter((it) => (it.mesh.faces[0]?.f.greeble ?? Infinity) > l.level).reduce((s, it) => s + it.mesh.triangles * it.mats.length, 0), error: l.error });
      // recommended switch distances: the level's geometric error projects below `px` screen pixels
      let prev = 0;
      for (const L of levels) { L.distance = L.level ? Math.max(prev, f6(switchDistance(L.error / scale, screen))) : 0; L.error_px = f6(L.error); delete L.error; prev = L.distance; }
      const group = { name: `${def.name}_lods`, children: [], extras: { lod_group: true, levels: levels.map((L) => ({ level: L.level, distance: L.distance, triangles: L.triangles })) } };
      outNodes.push(group);
      // LOD0
      const l0 = { name: `${def.name}_LOD0`, children: [], extras: { lod: 0, distance: 0 } };
      outNodes.push(l0);
      group.children.push(outNodes.length - 1);
      for (const p of rootParts) { outNodes.push({ name: p.name, mesh: addMesh(p.name, p.mesh), ...(p.extras ? { extras: p.extras } : {}) }); l0.children.push(outNodes.length - 1); }
      for (const id of gpuNodes(0)) l0.children.push(id);
      const files = [];
      for (const l of lodMeshes) {
        const L = levels[l.level];
        if (a.lod_mode === 'files') {
          const lf = `${base}_lod${l.level}.glb`;
          const sub = writeGLB({ meshes: [{ name: `${def.name}_LOD${l.level}`, groups: l.mesh.groups.values() }], nodes: [{ name: `${def.name}_LOD${l.level}`, mesh: 0, extras: { lod: l.level, distance: L.distance } }] }, { scale, up: a.up, name: `${def.name}_LOD${l.level}`, ...(glbOpts.ao ? { ao: glbOpts.ao } : {}) });
          side.push([lf, sub.glb]);
          files.push(path.basename(lf));
          L.file = path.basename(lf);
          continue;
        }
        const node = { name: `${def.name}_LOD${l.level}`, mesh: addMesh(`${def.name}_LOD${l.level}`, l.mesh), extras: { lod: l.level, distance: L.distance }, lodHidden: true, children: [] };
        outNodes.push(node);
        group.children.push(outNodes.length - 1);
        for (const id of gpuNodes(l.level)) node.children.push(id);
        if (!node.children.length) delete node.children;
      }
      meta.lods = { mode: a.lod_mode === 'files' ? 'files' : 'nodes', screen, levels, note: 'Switch to level i when the camera is farther than levels[i].distance (units). nodes: <name>_lods group, children <name>_LOD0..n (extras.lod, extras.distance); three.js: const lod = new THREE.LOD(); for each child c: lod.addLevel(c, c.userData.distance). Greebles drop from their drop_lod; overlays from LOD 1.' };
      result.lods = levels.map((L) => ({ level: L.level, triangles: L.triangles, distance: L.distance }));
    } else {
      for (const p of rootParts) outNodes.push({ name: p.name, mesh: addMesh(p.name, p.mesh), ...(p.extras ? { extras: p.extras } : {}) });
      gpuNodes(0);
    }
    // layout instances (export instances:true) keep their nodes
    for (const n of instNodes) {
      const src = meshes[n.mesh];
      const mi = outMeshes.findIndex((m) => m.name === src.name && m.src === src);
      let idx = mi;
      if (idx < 0) { outMeshes.push({ ...src, src }); idx = outMeshes.length - 1; }
      outNodes.push({ ...n, mesh: idx });
    }
    if (cull) {
      const U = (v) => v.map((x) => f6(x / scale));
      meta.cull = {
        rooms: cull.rooms.map((r) => ({ name: r.name, node: `room_${r.name}`, min: U(r.min), max: U(r.max) })),
        portals: cull.portals.map((p, i) => ({ id: i, rooms: p.rooms, min: U(p.min), max: U(p.max), center: U(p.min.map((v, k) => (v + p.max[k]) / 2)), auto: p.auto })),
        pvs: cull.pvs, depth: normCull(cullSpec, built.grid).depth,
        usage: 'Each room is a node room_<name> (geometry outside every room: room_outside, always drawn). Per frame: find the room whose box holds the camera; draw that room and pvs[room]. Tighter: from the camera room walk portals breadth-first, keep a neighbour only if its portal rectangle is inside the view frustum (shrink the frustum to the portal for the next hop). Camera in no room: draw everything.',
      };
      result.cull = { rooms: cull.rooms.length, portals: cull.portals.length, pvs: cull.pvs };
    }
    meshes = outMeshes; nodes = outNodes;
  } else if (hasFlags(root) || def.parts.some((p) => p && (p.cast_shadow !== undefined || p.receive_shadow !== undefined))) {
    // rigs: shadow flags of named parts on their nodes
    for (const n of nodes) {
      const p = n.extras && n.extras.part !== undefined ? def.parts[n.extras.part] : null;
      if (p && (p.cast_shadow !== undefined || p.receive_shadow !== undefined)) n.extras = { ...n.extras, cast_shadow: p.cast_shadow !== false, receive_shadow: p.receive_shadow !== false };
    }
  }
  // ---- collision / occluder proxies (named nodes, extras flags; excluded from triangle stats)
  for (const [kind, v] of [['collision', a.collision], ['occluder', a.occluder]]) {
    const spec = normProxy(v, kind === 'collision' ? 'hull' : 'boxes');
    if (!spec) continue;
    const tex = { key: `proxy:${kind}`, name: `${kind}_proxy`, width: 1, height: 1, data: Uint8ClampedArray.from(kind === 'collision' ? [255, 0, 255, 255] : [0, 255, 255, 255]) };
    const pr = buildProxy(whole(), spec, tex, kind === 'occluder');
    meshes = [...meshes, { name: `${def.name}_${kind}`, groups: pr.mesh.groups.values() }];
    const node = { name: `${def.name}_${kind}`, mesh: meshes.length - 1, proxy: true, extras: { [kind]: true, proxy: pr.info.type, visible: false } };
    if (info) { nodes = [...nodes, node]; nodes[0] = { ...nodes[0], children: [...(nodes[0].children || []), nodes.length - 1] }; } else nodes = [...nodes, node];
    const U = (b) => ({ min: b.min.map((x) => f6(x / scale)), max: b.max.map((x) => f6(x / scale)) });
    meta[kind] = { node: node.name, type: pr.info.type, triangles: pr.mesh.triangles, ...(pr.info.boxes ? { boxes: pr.info.boxes.map(U), cell_units: f6(pr.info.cell_px / scale) } : { vertices: pr.info.vertices }), note: kind === 'collision' ? 'Hide the node (extras.visible false) and feed it to physics: hull = one convex shape; boxes = one box collider each (Roblox: Part per box, CanCollide)' : 'Occluder: conservative (inside the visible surface); hide it and use it for occlusion queries / software occlusion culling' };
    result[kind] = { type: pr.info.type, triangles: pr.mesh.triangles, ...(pr.info.boxes ? { boxes: pr.info.boxes.length } : {}) };
  }
  // ---- impostor atlas (far LOD)
  if (a.impostor) {
    const io = normImpostor(a.impostor);
    const w = whole();
    const imp = bakeImpostor(groupsOf(w), io);
    const files = { albedo: `${path.basename(base)}.impostor.png`, normal: `${path.basename(base)}.impostor_n.png`, depth: `${path.basename(base)}.impostor_d.png`, meta: `${path.basename(base)}.impostor.json` };
    side.push([`${base}.impostor.png`, encodePNG(imp.albedo.width, imp.albedo.height, imp.albedo.data)]);
    side.push([`${base}.impostor_n.png`, encodePNG(imp.normal.width, imp.normal.height, imp.normal.data)]);
    side.push([`${base}.impostor_d.png`, encodePNG(imp.depth.width, imp.depth.height, imp.depth.data)]);
    const im = imp.meta;
    const size = 2 * im.radius_px / scale;
    const json = {
      ...im, center: im.center_px.map((v) => f6(v / scale)), radius: f6(im.radius_px / scale), quad_size: f6(size), files,
      // where the billboard's cell resolution covers the object on screen, and never before the last LOD
      switch_distance: f6(Math.max((size * screen.height) / (2 * Math.tan((screen.fov * Math.PI) / 360) * io.size), meta.lods ? meta.lods.levels[meta.lods.levels.length - 1].distance : 0)),
      usage: io.layout === 'octahedral'
        ? `Billboard quad of side quad_size at center, facing the camera. d = normalize(camera - center) in model space; ${im.hemi ? 'hemi-octahedral: s = |dx|+|dy|+|dz|; u = (dx+dz)/s, v = (dx-dz)/s (y clamped >= 0)' : 'octahedral: s = |dx|+|dy|+|dz|; x = dx/s, z = dz/s; if dy < 0: (x, z) = ((1-|z|)*sign(x), (1-|x|)*sign(z)); u = x, v = z'}; cell col = floor((u+1)/2*grid), row = floor((v+1)/2*grid); sample rect of that cell (blend the 3 nearest for smooth turns). normal png = world normal*0.5+0.5, depth png = 255 near .. 0 far over [-radius, radius].`
        : 'Billboard quad of side quad_size at center, facing the camera around Y. yaw = atan2(dx, dz) (deg, 0 = +Z front); cell = round(yaw / (360/angles)) mod angles.',
    };
    side.push([`${base}.impostor.json`, Buffer.from(JSON.stringify(json, null, 2))]);
    meta.impostor = { files, layout: im.layout, cells: im.cells.length, atlas_px: im.atlas_px, cell_px: im.cell_px, switch_distance: json.switch_distance };
    result.impostor = { files: Object.values(files).map((n) => path.join(path.dirname(file), n)), atlas: `${im.atlas_px[0]}x${im.atlas_px[1]}`, cells: im.cells.length, switch_distance: json.switch_distance };
  }
  // ---- per-part stats
  if (a.stats || lods || a.impostor || a.collision || a.occluder) {
    meta.parts_stats = built.parts.map((p) => ({ i: p.i, type: p.type, triangles: p.triangles, ...(built.partBounds[p.i] ? { bounds: unitsBox(built.partBounds[p.i], scale) } : {}), ...(p.greebles ? { greebles: p.greebles.pieces } : {}), ...(p.gpu_instances ? { gpu_instances: p.gpu_instances } : {}) }));
  }
  return {
    meshes, nodes, glbOpts, meta, result,
    after() { for (const [f, buf] of side) fs.writeFileSync(f, buf); },
  };
}

// ---------- preview extras ----------
/** preview {ao?, lod?, morph?:{name: weight}, lods?, bump?} and models with GPU greebles. -> image result or null */
export function previewExtras(def, built, a, { variantDef, buildDef }) {
  if (!(a.ao || a.lod !== undefined || a.morph)) return null;
  const t0 = performance.now();
  let mesh = built.mesh.clone();
  if (a.morph) {
    if (typeof a.morph !== 'object') throw new Error('morph must be {<morph name>: weight 0..1}');
    const A = [...mesh.groups.values()], base0 = [...built.mesh.groups.values()];
    for (const [name, w] of Object.entries(a.morph)) {
      const spec = (def.morphs || {})[name];
      if (!spec) throw new Error(`unknown morph "${name}" (morphs: ${Object.keys(def.morphs || {}).join(', ') || 'none'})`);
      const v = buildDef({ ...variantDef(spec), origin: built.shift.map((x) => -x), morphs: undefined }).mesh;
      const B = [...v.groups.values()];
      A.forEach((g, i) => { const h = B[i], o = base0[i]; if (!h || h.pos.length !== g.pos.length) throw new Error(`morph "${name}" changes topology`); for (let k = 0; k < g.pos.length; k++) g.pos[k] += (h.pos[k] - o.pos[k]) * Number(w); });
    }
  }
  let lodInfo = null;
  if (a.lod !== undefined && Number(a.lod) > 0) {
    const ratios = normLods(a.lods ?? true);
    const lv = Math.min(ratios.length - 1, Math.round(Number(a.lod)));
    const r = simplifyMesh(mesh, { ratio: ratios[lv], level: lv });
    mesh = r.mesh;
    lodInfo = { level: lv, ratio: ratios[lv], triangles: r.triangles, source: r.source, error_px: +r.error.toFixed(3) };
  }
  let aoInfo = null;
  if (a.ao) aoInfo = bakeAO([{ meshes: [mesh] }], a.ao === true ? {} : a.ao).stats;
  const img = renderViews(groupsOf(mesh), { views: a.views, size: a.size ?? (a.views?.length === 1 ? 384 : 192) });
  return { image: encodePNG(img.width, img.height, img.data), views: img.views, triangles: mesh.triangles, ...(lodInfo ? { lod: lodInfo } : {}), ...(aoInfo ? { ao: aoInfo } : {}), ms: Math.round(performance.now() - t0) };
}

// ---------- trim sheets ----------
export const MODEL_EXTRA_OPS = {
  /**
   * Trim sheet: strips:{name:[y,h]} marks an existing canvas; otherwise paints a new sheet (strips:
   * [{name, style, h, base?, accent?, glow?}] or the default sci-fi set) with colour + height +
   * metal + rough (+ emissive) layers.
   */
  model_trim(a, source) {
    const name = a.canvas || a.name;
    if (!NAME_RE.test(name || '')) throw new Error('trim needs canvas: "<trim sheet canvas>" (1-64 letters, digits, _ - .)');
    if (a.strips && !Array.isArray(a.strips)) {
      const d = this.get(name);
      const strips = trimStrips({ trim: { strips: a.strips } }, d.width, d.height, name);
      d.meta = { ...(d.meta || {}), trim: { strips } };
      this.changed(d, { op: 'trim', source, label: 'trim sheet strips' });
      return { canvas: name, strips, use: `parts: trim:"${name}:${Object.keys(strips)[0]}" (bevels, inset walls, thin faces) or tube {trim:"${name}:<strip>"}` };
    }
    if (this.docs.has(name) && !a.overwrite) throw new Error(`Canvas "${name}" exists (overwrite:true repaints it; strips:{name:[y,h]} marks an existing sheet)`);
    const r = paintTrimSheet({ width: a.width ?? 64, strips: a.strips ?? DEFAULT_TRIM, colors: a.colors || {}, seed: a.seed ?? 1 });
    const d = new Doc({ name, width: r.width, height: r.height });
    d.layers[0].name = 'color';
    d.layers[0].data.set(r.layers.color);
    for (const k of ['height', 'metal', 'rough', 'emissive']) {
      if (!r.layers[k]) continue;
      const l = new Layer(k, r.width, r.height, r.layers[k]);
      if (k !== 'emissive') l.visible = false; // data layers: kept out of the 2D view and the colour texture
      d.layers.push(l);
    }
    d.meta = { trim: { strips: r.strips } };
    this.attach(d);
    this.changed(d, { op: 'trim', source, label: 'trim sheet', structural: true });
    return { canvas: name, size: `${r.width}x${r.height}`, strips: r.strips, layers: d.layers.map((l) => l.name), styles: TRIM_STYLES, use: `parts: trim:"${name}:bevel" (bevel chamfers, inset walls, thin faces) | trim:{sheet:"${name}", strip:"plate", faces:"all"} | tube {trim:"${name}:pipe"}` };
  },
};

