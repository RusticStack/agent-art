// Export-side helpers for ships, structures and layouts: marker / light nodes (node extras),
// mesh splitting under a triangle limit (Roblox MeshPart: 20k), triangle budgets per scale class
// and draw-call counts. Nothing here runs unless a model has markers or an export asks for it.
import { Mesh } from './model3d.js';
import { simplifyMesh } from './lod.js';

const f6 = (v) => +(+v).toFixed(6);
export const ROBLOX_TRIS = 20000;

// ---------- scale classes ----------
/**
 * Triangle budgets (LOD0, whole model, exterior + walkable interior) and size bands. Ships: length in metres (32 px = 1 m).
 * mesh = max triangles per exported mesh (Roblox MeshPart limit); draw = draw-call guide.
 */
export const SCALE_CLASSES = {
  snub: { kind: 'ship', length_m: [0, 12], triangles: 6000, draw: 8, lods: [1, 0.5, 0.2], note: 'shuttle / escape pod / snub fighter' },
  fighter: { kind: 'ship', length_m: [8, 25], triangles: 14000, draw: 14, lods: [1, 0.5, 0.2], note: 'single-seat fighter / interceptor' },
  dropship: { kind: 'ship', length_m: [18, 45], triangles: 45000, draw: 18, lods: [1, 0.5, 0.25, 0.1], note: 'dropship / gunship / light hauler' },
  freighter: { kind: 'ship', length_m: [35, 120], triangles: 80000, draw: 24, lods: [1, 0.5, 0.25, 0.1], note: 'cargo hauler / freighter (split meshes)' },
  corvette: { kind: 'ship', length_m: [80, 220], triangles: 120000, draw: 32, lods: [1, 0.5, 0.25, 0.1], note: 'corvette / frigate (split meshes, impostor far)' },
  capital: { kind: 'ship', length_m: [200, 4000], triangles: 200000, draw: 48, lods: [1, 0.4, 0.15, 0.05], note: 'carrier / capital ring module (split meshes, impostor far, cull rooms inside)' },
  prop: { kind: 'kit', triangles: 1500, draw: 3, note: 'small prop' },
  kit_piece: { kind: 'kit', triangles: 3000, draw: 4, note: 'modular kit piece (corridor, tank, crane)' },
  room: { kind: 'kit', triangles: 8000, draw: 8, note: 'interior room / engine room' },
  building: { kind: 'kit', triangles: 25000, draw: 16, note: 'building / hangar / colony module' },
  district: { kind: 'kit', triangles: 150000, draw: 64, note: 'layout: colony, market district (instanced kit pieces, cull)' },
};
/** Ship class from its length (px). */
export function shipClass(lengthPx, scale = 32) {
  const m = lengthPx / scale;
  if (m < 10) return 'snub';
  if (m < 22) return 'fighter';
  if (m < 40) return 'dropship';
  if (m < 100) return 'freighter';
  if (m < 200) return 'corvette';
  return 'capital';
}
/** budget:"fighter" | number | {triangles, mesh?} -> {name, triangles, mesh} */
export function normBudget(v) {
  if (v === undefined || v === null || v === false) return null;
  if (typeof v === 'number') return { name: 'custom', triangles: v, mesh: ROBLOX_TRIS };
  if (typeof v === 'string') {
    const c = SCALE_CLASSES[v];
    if (!c) throw new Error(`budget must be a class (${Object.keys(SCALE_CLASSES).join('|')}), a triangle count or {triangles, mesh?}`);
    return { name: v, triangles: c.triangles, mesh: ROBLOX_TRIS, draw: c.draw };
  }
  if (typeof v === 'object' && Number(v.triangles) > 0) return { name: v.name ?? 'custom', triangles: Number(v.triangles), mesh: Number(v.mesh ?? ROBLOX_TRIS), draw: v.draw };
  throw new Error('budget must be a class name, a triangle count or {triangles, mesh?}');
}

// ---------- markers -> nodes ----------
/**
 * Marker nodes (lights, plumes, hardpoints, doors, spawns, screens) for the glTF scene.
 * rig: {info, index (name -> node index)} parents node-bound markers under their node.
 */
export function markerNodes(markers, scale, rig = null) {
  const out = [], counts = {};
  for (const k of markers) {
    const kind = k.kind || 'marker';
    const i = counts[kind] = (counts[kind] ?? -1) + 1;
    const name = kind === 'light' ? `light_${i}` : `${k.data?.socket ? `socket_${k.data.socket}` : `${kind}_${i}`}`;
    const extras = kind === 'light'
      ? { light: { type: k.data.type, color: k.data.color, intensity: k.data.intensity, range: f6(k.data.range / scale), ...(k.data.angle !== undefined ? { angle: k.data.angle } : {}), ...(k.dir ? { dir: k.dir.map(f6) } : {}), ...(k.data.shadow !== undefined ? { shadow: k.data.shadow } : {}), ...(k.data.neon ? { neon: true } : {}) } }
      : { marker: kind, ...Object.fromEntries(Object.entries(k.data || {}).map(([a, b]) => [a, typeof b === 'number' && ['w', 'h', 'd', 'r', 'len'].includes(a) ? f6(b / scale) : b])), ...(k.dir ? { dir: k.dir.map(f6) } : {}) };
    let parent = null, t = k.pos;
    if (rig && k.node && rig.info.byName.has(k.node)) {
      const n = rig.info.byName.get(k.node), R = n.R, d = [k.pos[0] - n.joint[0], k.pos[1] - n.joint[1], k.pos[2] - n.joint[2]];
      t = [R[0] * d[0] + R[4] * d[1] + R[8] * d[2], R[1] * d[0] + R[5] * d[1] + R[9] * d[2], R[2] * d[0] + R[6] * d[1] + R[10] * d[2]];
      parent = rig.index.get(k.node);
    }
    out.push({ node: { name, translation: t, extras }, parent });
  }
  return out;
}
/** Append marker nodes to a node list (rig: under their node or the root; plain: scene roots). */
export function addMarkerNodes(nodes, markers, scale, rig = null) {
  const list = markerNodes(markers, scale, rig);
  const next = nodes.slice();
  for (const { node, parent } of list) {
    next.push(node);
    const pi = parent ?? (rig ? 0 : null);
    if (pi !== null) next[pi] = { ...next[pi], children: [...(next[pi].children || []), next.length - 1] };
  }
  return { nodes: next, count: list.length, lights: list.filter((l) => l.node.extras.light).length };
}
/** Light / marker table for meta.json (units). */
export function markerMeta(markers, scale) {
  return markers.map((k) => ({ kind: k.kind, pos: k.pos.map((v) => f6(v / scale)), ...(k.dir ? { dir: k.dir.map(f6) } : {}), ...(k.node ? { node: k.node } : {}), ...(k.kind === 'light' ? { color: k.data.color, intensity: k.data.intensity, range: f6(k.data.range / scale), type: k.data.type } : { data: k.data }) }));
}

// ---------- triangle counting / splitting ----------
const groupTris = (g) => g.idx.length / 3;
/** Scene meshes with their groups as arrays (writeGLB takes iterables; iterators can only be read once). */
export const materialize = (meshes) => meshes.map((m) => (Array.isArray(m.groups) ? m : { ...m, groups: [...m.groups] }));
export const meshTriangles = (m) => m.groups.reduce((s, g) => s + groupTris(g), 0);
/** Triangles drawn by a scene (nodes x their mesh; proxies and hidden LOD levels excluded). */
export function sceneTriangles(meshes, nodes) {
  let t = 0;
  for (const n of nodes) if (n.mesh !== undefined && n.mesh !== null && !n.proxy && !n.lodHidden) t += meshTriangles(meshes[n.mesh]) * (n.instancing ? n.instancing.mats.length : 1);
  return t;
}
/** Draw calls of a scene: one per (visible node, material); GPU-instanced nodes count once. */
export function sceneDrawCalls(meshes, nodes) {
  let d = 0;
  for (const n of nodes) if (n.mesh !== undefined && n.mesh !== null && !n.proxy && !n.lodHidden) d += [...meshes[n.mesh].groups].filter((g) => g.idx.length).length;
  return d;
}

/** Copy triangles (by index list per group) of groups into a new Mesh-like {groups} (keeps per-vertex extras). */
function pickTris(groups, picks) {
  const out = new Mesh();
  groups.forEach((g, gi) => {
    const list = picks[gi];
    if (!list || !list.length) return;
    const key = g.overlay ? `ov:${g.tex.key}` : g.tex.key;
    const ng = { tex: g.tex, pos: [], nrm: [], uv: [], idx: [] };
    if (g.overlay) Object.assign(ng, { overlay: true, uv0: [], alpha: [] }); else ng.faces = [];
    const ao = g.ao ? [] : null, uv1 = g.uv1 ? [] : null;
    const remap = new Map();
    for (const t of list) for (let k = 0; k < 3; k++) {
      const v = g.idx[t * 3 + k];
      let j = remap.get(v);
      if (j === undefined) {
        j = ng.pos.length / 3; remap.set(v, j);
        ng.pos.push(g.pos[v * 3], g.pos[v * 3 + 1], g.pos[v * 3 + 2]); ng.nrm.push(g.nrm[v * 3], g.nrm[v * 3 + 1], g.nrm[v * 3 + 2]); ng.uv.push(g.uv[v * 2], g.uv[v * 2 + 1]);
        if (g.overlay) { ng.uv0.push(g.uv0[v * 2], g.uv0[v * 2 + 1]); ng.alpha.push(g.alpha[v]); }
        if (ao) ao.push(g.ao[v]);
        if (uv1) uv1.push(g.uv1[v * 2], g.uv1[v * 2 + 1]);
      }
      ng.idx.push(j);
    }
    if (ao) ng.ao = ao;
    if (uv1) ng.uv1 = uv1;
    out.groups.set(key, ng);
  });
  return out;
}
/** Split a mesh into spatial chunks of <= max triangles (recursive median cut on the longest axis). */
export function splitMesh(mesh, max = ROBLOX_TRIS) {
  const groups = [...mesh.groups.values()].filter((g) => g.idx.length);
  if (groups.some((g) => g.morphs)) throw new Error('split: morph-target meshes cannot be split (keep them under the limit)');
  const tris = [];
  groups.forEach((g, gi) => {
    for (let t = 0; t < g.idx.length / 3; t++) {
      const c = [0, 0, 0];
      for (let k = 0; k < 3; k++) { const v = g.idx[t * 3 + k]; c[0] += g.pos[v * 3] / 3; c[1] += g.pos[v * 3 + 1] / 3; c[2] += g.pos[v * 3 + 2] / 3; }
      tris.push({ gi, t, c });
    }
  });
  if (tris.length <= max) return [mesh];
  const chunks = [];
  const cut = (list) => {
    if (list.length <= max) { chunks.push(list); return; }
    const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    for (const x of list) for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], x.c[k]); mx[k] = Math.max(mx[k], x.c[k]); }
    const ax = [0, 1, 2].reduce((b, k) => (mx[k] - mn[k] > mx[b] - mn[b] ? k : b), 0);
    list.sort((a, b) => a.c[ax] - b.c[ax] || a.gi - b.gi || a.t - b.t);
    const h = Math.ceil(list.length / 2);
    cut(list.slice(0, h)); cut(list.slice(h));
  };
  cut(tris);
  return chunks.map((list) => {
    const picks = groups.map(() => []);
    for (const x of list) picks[x.gi].push(x.t);
    for (const p of picks) p.sort((a, b) => a - b);
    return pickTris(groups, picks);
  });
}
/**
 * Split every scene mesh over `max` triangles: the node keeps chunk 0, chunks 1.. become child
 * nodes <name>_part<k> (identity transform, same LOD / shadow extras). GPU-instanced and morph
 * meshes are left alone. -> {meshes, nodes, split:[{mesh, chunks, triangles}]}
 */
export function splitScene(meshes0, nodes, max = ROBLOX_TRIS) {
  const meshes = materialize(meshes0);
  const outMeshes = meshes.slice(), outNodes = nodes.map((n) => ({ ...n })), info = [];
  const done = new Map();
  meshes.forEach((m, mi) => {
    const mesh = { groups: new Map([...m.groups].filter((g) => g.idx.length).map((g, i) => [`${g.overlay ? 'ov:' : ''}${g.tex.key}#${i}`, g])) };
    const tris = meshTriangles({ groups: [...mesh.groups.values()] });
    if (tris <= max || [...mesh.groups.values()].some((g) => g.morphs)) return;
    const users = nodes.filter((n) => n.mesh === mi);
    if (users.some((n) => n.instancing)) return;
    const ms = new Mesh();
    for (const [k, g] of mesh.groups) ms.groups.set(k, g);
    const parts = splitMesh(ms, max);
    outMeshes[mi] = { name: `${m.name}_part0`, groups: [...parts[0].groups.values()] };
    const extra = parts.slice(1).map((p, k) => { outMeshes.push({ name: `${m.name}_part${k + 1}`, groups: [...p.groups.values()] }); return outMeshes.length - 1; });
    done.set(mi, extra);
    info.push({ mesh: m.name, triangles: tris, chunks: parts.length, max_chunk: Math.max(...parts.map((p) => p.triangles)) });
  });
  if (!done.size) return { meshes, nodes: outNodes, split: [] };
  const n0 = outNodes.length;
  for (let ni = 0; ni < n0; ni++) {
    const n = outNodes[ni];
    if (n.mesh === undefined || !done.has(n.mesh)) continue;
    const kids = [];
    for (const [k, mi] of done.get(n.mesh).entries()) {
      outNodes.push({ name: `${n.name}_part${k + 1}`, mesh: mi, ...(n.extras ? { extras: { ...n.extras, split_of: n.name } } : { extras: { split_of: n.name } }), ...(n.lodHidden ? { lodHidden: true } : {}) });
      kids.push(outNodes.length - 1);
    }
    outNodes[ni] = { ...n, children: [...(n.children || []), ...kids] };
  }
  return { meshes: outMeshes, nodes: outNodes, split: info };
}

// ---------- budget report ----------
/**
 * Budget report of a built model: triangles (LOD0), estimated LOD chain, draw calls, the parts
 * that cost the most, meshes needed under the Roblox limit, and the class verdict.
 */
export function budgetReport(def, built, { cls, scale = 32, lods = null } = {}) {
  const mesh = built.mesh;
  const instTris = built.instances.reduce((s, it) => s + it.mesh.triangles, 0);
  const tris = mesh.triangles + instTris;
  const b = mesh.bounds(), size = b.max.map((v, i) => v - b.min[i]);
  const length = Math.max(size[0], size[2]);
  const isShip = def.parts.some((p) => p && p.type === 'hull') || /ship|fighter|dropship|hauler|capital/.test(def.template || '');
  const name = cls ?? (isShip ? shipClass(length, scale) : tris > 60000 ? 'district' : tris > 9000 ? 'building' : tris > 3500 ? 'room' : tris > 1600 ? 'kit_piece' : 'prop');
  const C = SCALE_CLASSES[name];
  if (!C) throw new Error(`class must be one of ${Object.keys(SCALE_CLASSES).join(', ')}`);
  const ratios = lods || C.lods || [1, 0.5, 0.2];
  const levels = [{ level: 0, triangles: tris }];
  for (let i = 1; i < ratios.length; i++) {
    const r = simplifyMesh(mesh, { ratio: ratios[i], level: i });
    levels.push({ level: i, ratio: ratios[i], triangles: r.triangles + Math.round(instTris * ratios[i]) });
  }
  const groups = [...mesh.groups.values()].filter((g) => g.idx.length);
  const nodes = built.layout ? built.layout.nodes.length + 1 : 1;
  const top = [...built.parts].filter((p) => p.triangles).sort((x, y) => y.triangles - x.triangles).slice(0, 6).map((p) => ({ part: p.i, type: p.type, triangles: p.triangles, ...(built.def?.parts?.[p.i]?.name ? { name: built.def.parts[p.i].name } : {}) }));
  const meshesNeeded = Math.max(1, Math.ceil(tris / ROBLOX_TRIS));
  const verdict = tris <= C.triangles ? 'within budget' : `over by ${tris - C.triangles} triangles (${Math.round((tris / C.triangles) * 100)}%)`;
  return {
    class: name, class_note: C.note, budget: { triangles: C.triangles, draw_calls: C.draw, mesh_limit: ROBLOX_TRIS },
    triangles: tris, verdict, size_m: size.map((v) => +(v / scale).toFixed(2)),
    lod_estimate: levels,
    draw_calls: { merged: groups.length, ...(built.layout ? { rig_nodes: nodes } : {}), ...(built.instances.length ? { instances: built.instances.length, instanced_unique: new Set(built.instances.map((i) => i.model)).size } : {}) },
    materials: groups.length,
    meshes_under_20k: meshesNeeded,
    top_parts: top,
    advice: [
      tris > C.triangles ? 'lower hull rings / segments, drop greeble density, or move repeated pieces into instanced models' : null,
      tris > ROBLOX_TRIS ? 'export {split:true} splits meshes under 20k triangles (Roblox MeshPart limit)' : null,
      groups.length > C.draw ? 'many materials: share textures (kit textures, trim sheet) or export atlas:true' : null,
      built.layout ? 'rigged: export {static:true} (or static:"<pose>") bakes the pose so lods / impostor / cull apply' : null,
    ].filter(Boolean),
  };
}

// ---------- mood previews ----------
const hexRGB = (c) => { const m = /^#?([0-9a-f]{6})/i.exec(String(c)); if (!m) return [1, 1, 1]; const v = parseInt(m[1], 16); return [(v >> 16 & 255) / 255, (v >> 8 & 255) / 255, (v & 255) / 255]; };
/**
 * Render options for a dark, moody preview (preview only, never exported): low cool ambient, a dim
 * key light, a rim light from behind the model, and the model's light markers (engines, neon,
 * lamps) as coloured point lights. Every opaque surface is lit per pixel (normal maps, specular
 * highlights of the point lights, baked AO). mood: true | {ambient, ambient_color, key:{dir, color,
 * strength}, fill:false|{dir, color, strength}, rim:false|{dir?, color, strength}, lights:true|false, max_lights?:12 (per material
 * group, strongest first), gain, bg}.
 */
export function moodOpts(markers = [], mood = true) {
  const o = mood === true ? {} : mood;
  const amb = Number(o.ambient ?? 0.3);
  const ac = o.ambient_color ? hexRGB(o.ambient_color) : [0.62, 0.7, 1];
  const key = o.key || {};
  const kd = key.dir ? (() => { const d = key.dir.map(Number), l = Math.hypot(...d) || 1; return d.map((v) => v / l); })() : [-0.45, 0.75, 0.48];
  const gain = Number(o.gain ?? 1.6);
  const lights = o.lights === false ? [] : markers.filter((k) => k.kind === 'light').map((k) => ({ pos: k.pos, color: hexRGB(k.data.color), intensity: Number(k.data.intensity ?? 1) * gain, range: Number(k.data.range ?? 160) * 1.25 }));
  const bg = o.bg ? hexRGB(o.bg).map((v) => Math.round(v * 255)) : [9, 11, 16];
  const r = o.rim === false ? null : { ...(o.rim?.dir ? { dir: o.rim.dir.map(Number) } : {}), color: hexRGB(o.rim?.color ?? '#a8c4ff'), strength: Number(o.rim?.strength ?? 1.1) };
  const f = o.fill === false ? null : { dir: (o.fill?.dir ?? [-kd[0], 0.15, -kd[2]]).map(Number), color: hexRGB(o.fill?.color ?? '#5a78b0'), strength: Number(o.fill?.strength ?? 0.4) };
  return { mood: true, bg, light: kd, ambient: amb, ambient_color: ac.map((v) => v * amb), color: key.color ? hexRGB(key.color) : [1, 0.94, 0.86], light_strength: Number(key.strength ?? 1.35), lights, ...(r ? { rim: r } : {}), ...(f ? { fill: f } : {}), max_lights: Number(o.max_lights ?? 12) };
}
