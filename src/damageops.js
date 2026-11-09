// art_model damage / fracture actions and the damage export (states as nodes or files, the
// blend-ready intact mesh + threshold masks, fracture chunks, FX sockets, Roblox profile).
// Plain exports never come here: <name>.glb stays byte-for-byte the same; the damage outputs are
// extra files next to it (<name>.damage.glb + .damage.json + .damage_mask.png).
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { Mesh } from './model3d.js';
import { normDamage, damageState, damageMasks, bakeDecals, explode, implode, STATE_PRESETS, DAMAGE_KINDS, FX_KINDS } from './damage.js';
import { fracturePart, FRACTURE_METHODS } from './fracture.js';
import { makeCamera, renderCamera } from './raster3d.js';
import { packImages } from './sheet.js';
import { encodePNG } from './png.js';
import { writeGLB } from './glb.js';
import { expandDef } from './kitparts.js';
import { exportV2, finishV2 } from './matops.js';
import { ROBUST_THRESHOLD } from './csg.js';
import { simplifyMesh, switchDistance } from './lod.js';
import { normLods, normLodScreen } from './modelexport.js';
import { rigInfo } from './modelrig.js';
import { splitRig, addRig, transferSkin } from './damagerig.js';
import { skinScene, splitByBones, ROBLOX_MAX_BONES } from './skin3d.js';
import { validateGLB as validateSkinned } from './gltfvalidate.js';
import { validateGLB as checkGLB } from './gltfcheck.js';
import { isSkinned } from './skinops.js';
import { bakeAO, normAO } from './bake.js';
import { normLightmap, normThickness, bakeLighting } from './lightbake.js';

const f6 = (v) => +(+v).toFixed(6);
const groupsOf = (mesh) => [...mesh.groups.values()].filter((g) => g.idx.length);
const DAMAGE_KEYS = ['states', 'kind', 'seed', 'rigid', 'roles', 'inner', 'frame', 'sparks', 'palette', 'close'];
const ROBLOX_TRIS = 20000;
/** Fracture work budget: sum over groups of (pieces + 3 x debris) booleans x part input triangles (~30 us each). */
export const FRACTURE_BUDGET = 250000;
const noSkin = (def, what) => {
  if (isSkinned(def)) throw new Error(`${what}: model "${def.name}" is skinned (skeleton + skin); damage states and fracture are static rigid meshes and would drop the skin: use them on a rigid copy of the model (export damage:false skips them here)`);
};

/** Shared camera over several meshes -> labelled contact sheet PNG. */
function sheet(items, view = 'game', size = 192, columns) {
  const S = Math.max(64, Math.min(512, Math.round(Number(size) || 192)));
  const fit = [];
  for (const { mesh } of items) { const b = mesh.bounds(); for (const x of [b.min[0], b.max[0]]) for (const y of [b.min[1], b.max[1]]) for (const z of [b.min[2], b.max[2]]) fit.push([x, y, z]); }
  const cam = makeCamera(view, S, S, fit, {});
  const imgs = items.map((it) => ({ img: renderCamera(groupsOf(it.mesh), cam, S, S), label: it.label }));
  const img = packImages(imgs, { labels: true, checker: false, columns: columns ?? Math.min(imgs.length, 4) });
  return encodePNG(img.width, img.height, img.data);
}

/** Model part reference (index | name | id) -> index. */
function partRef(def, k) {
  if (typeof k === 'number' || /^\d+$/.test(String(k))) { const i = Number(k); if (!def.parts[i]) throw new Error(`fracture: no part ${i}`); return i; }
  const i = def.parts.findIndex((p) => p && (p.name === k || p.id === k));
  if (i < 0) throw new Error(`fracture: no part ${JSON.stringify(k)} (indices 0..${def.parts.length - 1} or names: ${def.parts.filter((p) => p?.name).map((p) => p.name).join(', ') || 'none'})`);
  return i;
}
const CHUNK_COLORS = [[214, 96, 77], [244, 165, 66], [236, 212, 84], [125, 190, 92], [72, 168, 150], [79, 140, 201], [130, 104, 196], [196, 98, 168], [160, 120, 80], [110, 120, 130]];
const colTex = (c, k) => ({ key: `chunkcol:${k}`, name: `chunk_${k}`, width: 1, height: 1, data: Uint8ClampedArray.from([...c, 255]) });

/** Normalize fracture groups: [{part, pieces?, method?, seed?, inside?, debris?, density?, group?, parent?}]. */
export function normFracture(v, def) {
  const list = Array.isArray(v) ? v : v?.groups;
  if (!Array.isArray(list) || !list.length || list.length > 16) throw new Error('fracture parts must be [{part:<name|index>, pieces?:8 (2-64), method?:"voronoi"|"slice", seed?, inside?:<texture>, debris?:0, density?:600 kg/m^3, group?, parent?:<group>, close?:"auto"|"cleanup"|false}] (1-16 groups)');
  const names = new Set();
  const out = list.map((g0, i) => {
    const g = typeof g0 === 'string' || typeof g0 === 'number' ? { part: g0 } : g0;
    if (!g || typeof g !== 'object' || g.part === undefined) throw new Error(`fracture ${i}: needs part:<name|index>`);
    const pi = partRef(def, g.part);
    const group = g.group ?? (def.parts[pi].name || def.parts[pi].id || `part_${pi}`);
    if (!/^[A-Za-z0-9_.-]{1,48}$/.test(group)) throw new Error(`fracture ${i}: group must be 1-48 letters, digits, _ - .`);
    if (names.has(group)) throw new Error(`fracture: group "${group}" twice`);
    names.add(group);
    const method = g.method ?? 'voronoi';
    if (!FRACTURE_METHODS.includes(method)) throw new Error(`fracture ${i}: method must be ${FRACTURE_METHODS.join('|')}`);
    const pieces = Math.round(Number(g.pieces ?? 8));
    if (!(pieces >= 2 && pieces <= 64)) throw new Error(`fracture ${i}: pieces must be 2..64`);
    const density = Number(g.density ?? 600);
    if (!(density > 0)) throw new Error(`fracture ${i}: density must be > 0 (kg per m^3 = per unit^3)`);
    const boolean = g.boolean ?? 'auto';
    if (!['auto', 'bsp', 'robust'].includes(boolean)) throw new Error(`fracture ${i}: boolean must be auto (BSP for small parts, robust above ${ROBUST_THRESHOLD} triangles), bsp or robust`);
    const close = g.close ?? 'auto';
    if (!['auto', 'cleanup', false].includes(close)) throw new Error(`fracture ${i}: close must be "auto" (open parts: cleanup hole fill, then voxel remesh), "cleanup" (hole fill only) or false (refuse open parts)`);
    return { part: g.part, pi, group, method, pieces, boolean, seed: Math.round(Number(g.seed ?? 1)), inside: g.inside ?? '#3a3d44', debris: Math.max(0, Math.min(16, Math.round(Number(g.debris ?? 0)))), density, parent: g.parent ?? null, close };
  });
  for (const g of out) if (g.parent !== null && !names.has(g.parent)) throw new Error(`fracture group "${g.group}": parent "${g.parent}" is not a fracture group (${[...names].join(', ')})`);
  return out;
}

const FRACTURE_CACHE = new Map(), FRACTURE_CACHE_MAX = 32;
const texDigest = (h, t) => { h.update(`|${t.key}|${t.width}x${t.height}|`); if (t.data) h.update(Buffer.from(t.data.buffer, t.data.byteOffset, t.data.byteLength)); };
/** Content key of one fracture job: the part mesh (positions, normals, uvs, textures) + the group options. */
function fractureKey(mesh, g, inside) {
  const h = crypto.createHash('sha1');
  h.update(JSON.stringify([g.pieces, g.method, g.seed, g.debris, g.group, g.boolean, ...(g.close !== 'auto' ? [g.close] : [])]));
  texDigest(h, inside);
  for (const gr of mesh.groups.values()) {
    texDigest(h, gr.tex);
    h.update(Buffer.from(Float64Array.from(gr.pos).buffer)); h.update(Buffer.from(Float64Array.from(gr.nrm).buffer)); h.update(Buffer.from(Float64Array.from(gr.uv).buffer)); h.update(Buffer.from(Uint32Array.from(gr.idx).buffer));
  }
  return h.digest('hex');
}
/** Fracture every group of a built model (budgeted; results cached in memory by content). -> [{...group, result}] */
export function runFracture(built, def, groups) {
  const soup = explode(built.mesh);
  const jobs = groups.map((g) => {
    const faces = soup.faces.filter((F) => F.rec.pi === g.pi);
    if (!faces.length) throw new Error(`fracture "${g.group}": part ${g.pi} has no faces (hidden, consumed by a boolean, or a model instance)`);
    const mesh = implode({ faces, overlays: [] });
    return { g, mesh, work: (g.pieces + 3 * g.debris) * mesh.triangles };
  });
  const total = jobs.reduce((s, j) => s + j.work, 0);
  if (total > FRACTURE_BUDGET) throw new Error(`fracture: ${total} work units over the budget of ${FRACTURE_BUDGET} (sum over groups of (pieces + 3 x debris) x part triangles: ${jobs.map((j) => `${j.g.group} (${j.g.pieces}+3x${j.g.debris}) x ${j.mesh.triangles}`).join(', ')}): fewer pieces / debris / groups, or decimate the part first`);
  return jobs.map(({ g, mesh }) => {
    const inside = built.tex(g.inside);
    const key = fractureKey(mesh, g, inside);
    let res = FRACTURE_CACHE.get(key);
    if (res) { FRACTURE_CACHE.delete(key); FRACTURE_CACHE.set(key, res); } // LRU touch
    else {
      res = fracturePart(mesh, { pieces: g.pieces, method: g.method, seed: g.seed, inside, debris: g.debris, name: g.group, boolean: g.boolean, close: g.close });
      FRACTURE_CACHE.set(key, res);
      while (FRACTURE_CACHE.size > FRACTURE_CACHE_MAX) FRACTURE_CACHE.delete(FRACTURE_CACHE.keys().next().value);
    }
    return { ...g, result: res };
  });
}

/** Contact sheet: whole model with the fractured parts exploded, one colour per chunk (interior faces darker). */
function explodedImage(built, fr, view, size) {
  const soup = explode(built.mesh);
  const cut = new Set(fr.map((g) => g.pi));
  const rest = implode({ faces: soup.faces.filter((F) => !cut.has(F.rec.pi)), overlays: [] });
  const ex = rest.clone(), whole = built.mesh;
  let k = 0;
  for (const g of fr) {
    const C = g.result.center;
    for (const c of g.result.chunks.filter((x) => x.level === 1)) {
      const col = CHUNK_COLORS[k++ % CHUNK_COLORS.length];
      const m = new Mesh();
      for (const gr of c.mesh.groups.values()) {
        const inner = gr.tex.key === built.tex(g.inside).key;
        const t = colTex(inner ? col.map((v) => Math.round(v * 0.45)) : col, `${k}${inner ? 'i' : ''}`);
        const tg = m.group(t);
        const base = tg.pos.length / 3;
        for (const v of gr.pos) tg.pos.push(v); for (const v of gr.nrm) tg.nrm.push(v); for (const v of gr.uv) tg.uv.push(v);
        for (const i of gr.idx) tg.idx.push(base + i);
      }
      const d = [0, 1, 2].map((q) => (c.center[q] - C[q]) * 0.6);
      m.transform([1, 0, 0, d[0], 0, 1, 0, d[1], 0, 0, 1, d[2]]);
      ex.add(m);
    }
  }
  return sheet([{ mesh: whole, label: 'intact' }, { mesh: ex, label: 'exploded' }], view, size, 2);
}

/** A built model swapped to one damage state (previews / sprite renders). */
export function damagedBuilt(def, built, state) {
  if (!def.damage) throw new Error(`model "${def.name}" has no damage states (art_model damage {name, states:["scuffed","damaged","wrecked"]})`);
  const spec = normDamage(def.damage);
  if (state === 'intact') return built;
  const st = spec.states.find((s) => s.name === state);
  if (!st) throw new Error(`damage: no state "${state}" (states: intact, ${spec.states.map((s) => s.name).join(', ')})`);
  const s = damageState(built, def, spec, st);
  // keep the layout / shift (part-attached sockets, named nodes): the rig is re-derived from the damaged
  // mesh, whose faces keep their node tags, so only the mesh changes
  return { ...built, mesh: s.mesh, _rig: undefined, _rigF: undefined };
}

/** Engine ops, bound to modelops internals (getModel, build, saveModel). */
export function damageOps({ getModel, build, saveModel }) {
  return {
    /** Store damage states on a model and preview them (intact -> each state). */
    model_damage(a, source) {
      const def = getModel(this, a.name);
      if (a.delete || a.states === null) {
        const next = { ...def }; delete next.damage;
        saveModel(this, next, source, 'damage removed');
        return { model: def.name, damage: null };
      }
      const input = { ...(def.damage || {}) };
      for (const k of DAMAGE_KEYS) if (a[k] !== undefined) { if (a[k] === null) delete input[k]; else input[k] = a[k]; }
      const spec = normDamage(input);
      const xdef = expandDef(def); // kit parts expanded: part indices / names as the exporter sees them
      const built = build(this, xdef);
      const t0 = performance.now();
      const states = spec.states.map((st) => ({ st, s: damageState(built, xdef, spec, st) }));
      const ms = Math.round(performance.now() - t0);
      const image = sheet([{ mesh: built.mesh, label: 'intact' }, ...states.map(({ st, s }) => ({ mesh: s.mesh, label: `${st.name} ${st.amount}` }))], a.view ?? 'game', a.size ?? 192);
      saveModel(this, { ...def, damage: input }, source, 'damage states');
      return {
        model: def.name, kind: spec.kind, seed: spec.seed,
        states: [{ name: 'intact', amount: 0, triangles: built.mesh.triangles }, ...states.map(({ st, s }) => ({ name: st.name, amount: st.amount, triangles: s.mesh.triangles, features: Object.fromEntries(Object.entries(s.stats).filter(([, v]) => v)), sockets: s.sockets.map((x) => x.name), ...(s.decal ? { decal: s.decal.size } : {}) }))],
        image, ms,
        next: `art_model preview {name:"${def.name}", damage:"${spec.states[spec.states.length - 1].name}"} for one state; render {name, damage:<state>, canvas} = sprite prop frames; fracture {name, parts:[{part, pieces}]} = pre-fractured chunks; export {name} also writes ${def.name}.damage.glb (+ .damage.json manifest, .damage_mask.png)`,
      };
    },
    /** Store pre-fracture groups on a model; reply with chunk stats and an exploded view. */
    model_fracture(a, source) {
      const def = getModel(this, a.name);
      if (a.delete || a.groups === null || a.parts === null) {
        const next = { ...def }; delete next.fracture;
        saveModel(this, next, source, 'fracture removed');
        return { model: def.name, fracture: null };
      }
      // skinned models fracture too: the chunks are rigid and ride the nearest bone in the damage export
      const input = a.groups ?? (a.parts !== undefined ? a.parts : def.fracture?.groups);
      if (!input) throw new Error('fracture needs parts:[{part:<name|index>, pieces?:8, method?:"voronoi"|"slice", seed?, inside?, debris?, density?, group?, parent?}]');
      const xdef = expandDef(def);
      const groups = normFracture(input, xdef);
      const built = build(this, xdef);
      const t0 = performance.now();
      const fr = runFracture(built, xdef, groups);
      const ms = Math.round(performance.now() - t0);
      const scale = Number(def.scale ?? 32);
      saveModel(this, { ...def, fracture: { groups: input } }, source, 'fracture groups');
      return {
        model: def.name,
        groups: fr.map((g) => ({
          group: g.group, part: g.part, parent: g.parent, method: g.method, boolean: g.boolean, seed: g.seed, chunks: g.result.chunks.filter((c) => c.level === 1).length, debris: g.result.chunks.filter((c) => c.level === 2).length,
          volume_units3: f6(g.result.volume_px3 / scale ** 3), chunk_volume_error: f6(g.result.error), watertight: g.result.chunks.every((c) => c.watertight), mass_kg: f6((g.result.volume_px3 / scale ** 3) * g.density),
          triangles: g.result.chunks.filter((c) => c.level === 1).reduce((s, c) => s + c.mesh.triangles, 0),
          ...(g.result.closed ? { closed: g.result.closed } : {}),
        })),
        image: explodedImage(built, fr, a.view ?? 'game', a.size ?? 224), ms,
        next: `export {name:"${def.name}"} writes ${def.name}.damage.glb with <group>_chunk_NN nodes (pivot = centre of mass, collision hull children) + the manifest`,
      };
    },
  };
}

// ---------- export ----------
/** Rotation (quaternion) taking -Z to dir. */
function quatTo(dir) {
  const a = [0, 0, -1], d = dir, c = a[0] * d[0] + a[1] * d[1] + a[2] * d[2];
  if (c > 0.999999) return [0, 0, 0, 1];
  if (c < -0.999999) return [0, 1, 0, 0];
  const ax = [a[1] * d[2] - a[2] * d[1], a[2] * d[0] - a[0] * d[2], a[0] * d[1] - a[1] * d[0]];
  const q = [ax[0], ax[1], ax[2], 1 + c], l = Math.hypot(...q);
  return q.map((v) => f6(v / l));
}

/** Does this export write damage outputs? (def.damage / def.fracture, unless damage:false) */
export function wantsDamage(def, a) {
  if (a.damage === false) return false;
  return !!(a.damage || def.damage || def.fracture);
}

/**
 * Damage export. a.damage: true | {mode?:"nodes"|"files"|"blend", masks?:true, vertex?:false|"attribute"|"color",
 * profile?:"roblox", mask_channels?:false, texel?:1, max_size?:1024}; lods / lod_screen / up from the export args.
 * -> {files, result, manifest}
 */
export function damageExport(engine, def, built, a, { file, scale, skinned = null }) {
  if (isSkinned(def) && !skinned) noSkin(def, 'damage export');
  const o = a.damage && typeof a.damage === 'object' ? a.damage : {};
  const texel = o.texel === undefined ? undefined : Number(o.texel);
  if (texel !== undefined && !(Number.isFinite(texel) && texel >= 0.05 && texel <= 64)) throw new Error('damage.texel must be a number 0.05..64 (model px per mask texel, default 1)');
  const maxSize = o.max_size === undefined ? undefined : Number(o.max_size);
  if (maxSize !== undefined && !(Number.isInteger(maxSize) && maxSize >= 16 && maxSize <= 2048)) throw new Error('damage.max_size must be an integer 16..2048 (mask atlas px, default 1024)');
  const mode = o.mode ?? 'nodes';
  if (!['nodes', 'files', 'blend'].includes(mode)) throw new Error('damage.mode must be nodes (one .damage.glb with state nodes), files (one glb per state) or blend (the intact blend mesh + masks only)');
  // the materials v2 profile:"roblox" export implies the Roblox damage profile; three / minimal do not
  const profile = o.profile ?? (a.profile === 'roblox' ? 'roblox' : null);
  if (profile !== null && profile !== 'roblox') throw new Error('damage.profile must be "roblox" (states as separate MeshParts <= 20k tris, masks baked into colour)');
  const roblox = profile === 'roblox';
  const masks = !roblox && o.masks !== false && !!def.damage;
  const vertex = !roblox && o.vertex ? (o.vertex === 'color' ? 'COLOR_0' : '_DAMAGE') : null;
  const lods = normLods(o.lods ?? a.lods);
  const screen = normLodScreen(a.lod_screen);
  const base = file.replace(/\.glb$/i, '');
  const bn = path.basename(base);
  const side = [];
  const spec = def.damage ? normDamage(def.damage) : null;
  const t0 = performance.now();
  // ---- states
  const states = spec ? spec.states.map((st) => ({ st, s: damageState(built, def, spec, st, { texel, maxSize }) })) : [];
  // ---- blend-ready intact: chart UVs (TEXCOORD_1), dents morph, masks, vertex channel
  let blend = null;
  if (spec && (masks || vertex)) {
    blend = damageMasks(built, def, spec, { vertex: !!vertex, texel, maxSize });
    side.push([`${base}.damage_mask.png`, encodePNG(blend.mask.width, blend.mask.height, blend.mask.data)]);
    if (o.mask_channels) for (const [i, ch] of ['r', 'g', 'b', 'a'].entries()) {
      const d = new Uint8ClampedArray(blend.mask.width * blend.mask.height * 4);
      for (let p = 0; p < d.length; p += 4) { const v = blend.mask.data[p + i]; d[p] = v; d[p + 1] = v; d[p + 2] = v; d[p + 3] = 255; }
      side.push([`${base}.damage_mask_${ch}.png`, encodePNG(blend.mask.width, blend.mask.height, d)]);
    }
  }
  // ---- fracture
  const fr = def.fracture ? runFracture(built, def, normFracture(def.fracture.groups, def)) : [];
  // ---- rigs: a rigid rig (named parts / sockets / clips) is kept in every state; a skinned model
  // keeps its armature and every state mesh is skinned on it (weights from the intact skinned mesh)
  const rinfo = skinned ? null : rigInfo(def, built);
  let skinBase = null;
  if (skinned) {
    // skinned: LOD levels, the Roblox profile, baked AO / light (on the bind = rest pose) and fracture
    // (rigid chunks on their nearest bone) all keep the one armature
    const { S: SK, sk } = skinned();
    const fps = Number(a.fps ?? 30);
    if (!(fps >= 1 && fps <= 120)) throw new Error('fps must be 1..120');
    const maxBones = Math.round(Number(o.max_bones ?? a.max_bones ?? ROBLOX_MAX_BONES));
    if (!(maxBones >= 4 && maxBones <= 256)) throw new Error('max_bones must be 4..256 (Roblox: 50 bones per skinned MeshPart)');
    skinBase = { sc: skinScene(def.name, SK, sk, { fps }), sk, bones: SK.bones.length, transfer: 0, maxBones, roblox: roblox ? { meshes: [], max_joints: 0, max_influences: 0 } : null, chunks: 0 };
  }

  // ---- scene builder (shared by nodes / files / blend)
  const scene = () => {
    const S = { meshes: [], nodes: [], anims: new Map() };
    if (skinBase) {
      // the armature (bones + sockets) first: the shared skin's joints and skeleton are these indices
      const sc = skinBase.sc;
      S.nodes = structuredClone(sc.nodes.slice(0, sc.meshNode));
      S.skins = structuredClone(sc.skins);
      S.armature = 0;
    }
    return S;
  };
  const addMesh = (S, name, mesh) => { S.meshes.push({ name, groups: [...mesh.groups.values()] }); return S.meshes.length - 1; };
  const node = (S, n) => { S.nodes.push(n); return S.nodes.length - 1; };
  // carry: the blend mesh on every level (chart UVs, damage RGBA and the dent morph ride through the
  // collapses); ratios are of the level-0 mesh, as for the states
  const lodLevels = (mesh, carry = false) => {
    if (!lods) return null;
    const out = [{ level: 0, mesh, triangles: mesh.triangles, error: 0 }];
    for (let i = 1; i < lods.length; i++) { const r = simplifyMesh(mesh, { ratio: lods[i], level: i, keepOverlays: i === 1, carry }); out.push({ level: i, mesh: r.mesh, triangles: r.triangles, error: r.error }); }
    let prev = 0;
    for (const L of out) { L.distance = L.level ? Math.max(prev, f6(switchDistance(L.error / scale, screen))) : 0; prev = L.distance; }
    return out;
  };
  // rigid rig: the levels are made per rig node (each piece simplified in its rest frame)
  const rigLevels = (mesh, carry = false) => {
    if (!lods) return null;
    const p0 = splitRig(mesh, rinfo);
    const out = [{ level: 0, pieces: p0, triangles: mesh.triangles, error: 0 }];
    for (let i = 1; i < lods.length; i++) {
      const pieces = new Map();
      let tris = 0, err = 0;
      for (const [k, m] of p0) {
        if (!m.triangles) continue;
        const r = simplifyMesh(m, { ratio: lods[i], level: i, keepOverlays: i === 1, carry });
        pieces.set(k, r.mesh); tris += r.triangles; err = Math.max(err, r.error);
      }
      out.push({ level: i, pieces, triangles: tris, error: err });
    }
    let prev = 0;
    for (const L of out) { L.distance = L.level ? Math.max(prev, f6(switchDistance(L.error / scale, screen))) : 0; prev = L.distance; }
    return out;
  };
  const levelsOf = (mesh, carry = false) => (rinfo ? rigLevels(mesh, carry) : lodLevels(mesh, carry));
  const capRoblox = (mesh, what) => {
    if (!roblox || mesh.triangles <= ROBLOX_TRIS) return { mesh, simplified: false };
    const r = simplifyMesh(mesh, { ratio: (ROBLOX_TRIS * 0.95) / mesh.triangles, level: 1, keepOverlays: false });
    if (r.triangles > ROBLOX_TRIS) throw new Error(`roblox profile: ${what} has ${mesh.triangles} triangles and simplifies only to ${r.triangles} (MeshPart limit ${ROBLOX_TRIS}): fewer dents / segments`);
    return { mesh: r.mesh, simplified: true };
  };
  /**
   * A skinned mesh on node id. Roblox: no morph targets (MeshParts have no blend shapes), <= 4
   * influences per vertex, <= maxBones joints per MeshPart (meshes using more are split into several
   * skinned meshes, each with its own skin over the same bone nodes).
   */
  const skinnedOn = (S, id, nm, sm) => {
    if (!roblox) { S.nodes[id].mesh = addMesh(S, nm, sm); S.nodes[id].skin = 0; return; }
    const m = new Mesh();
    for (const [k, g] of sm.groups) { const { morphs, ...rest } = g; m.groups.set(k, rest); }
    let infl = 0;
    for (const g of m.groups.values()) if (g.skin) for (let v = 0; v < g.skin.w.length / 4; v++) { let c = 0; for (let q = 0; q < 4; q++) if (g.skin.w[v * 4 + q] > 0) c++; infl = Math.max(infl, c); }
    const used = new Set();
    for (const g of m.groups.values()) if (g.skin) g.skin.w.forEach((w, i) => { if (w > 0) used.add(g.skin.j[i]); });
    const R = skinBase.roblox;
    R.max_influences = Math.max(R.max_influences, infl);
    if (used.size <= skinBase.maxBones) {
      S.nodes[id].mesh = addMesh(S, nm, m); S.nodes[id].skin = 0;
      R.meshes.push({ node: nm, joints: used.size, triangles: m.triangles }); R.max_joints = Math.max(R.max_joints, used.size);
      return;
    }
    const all = S.skins[0], pieces = splitByBones(m, skinBase.maxBones);
    const over = pieces.find((pc) => pc.joints.length > skinBase.maxBones);
    if (over) throw new Error(`roblox profile: ${nm} has triangles weighted to ${over.joints.length} bones (max_bones ${skinBase.maxBones}): raise max_bones (Roblox allows 50) or skin with fewer influences`);
    pieces.forEach((pc, k) => {
      const si = S.skins.length;
      S.skins.push({ name: `${all.name}_${nm}_${k}`, joints: pc.joints.map((j) => all.joints[j]), skeleton: all.skeleton, ibm: pc.joints.map((j) => all.ibm[j]) });
      const pn = `${nm}_part${k}`;
      const pid = k === 0 ? id : node(S, { name: pn });
      S.nodes[pid].mesh = addMesh(S, k === 0 ? nm : pn, pc.mesh); S.nodes[pid].skin = si;
      if (k > 0) (S.nodes[id].children || (S.nodes[id].children = [])).push(pid);
      R.meshes.push({ node: k === 0 ? nm : pn, joints: pc.joints.length, triangles: pc.mesh.triangles, skin: si }); R.max_joints = Math.max(R.max_joints, pc.joints.length);
    });
  };
  const manifest = { model: def.name, generator: 'agent-art', px_per_unit: scale, up: a.up === 'z' ? 'z' : 'y', mode, profile: profile || 'web', default_state: 'intact', states: [], fracture: null, blend: null };
  /** One state (or intact) under a parent: node with mesh (or LOD children) + fx socket children. */
  const stateNodes = (S, name, label, mesh, sockets, extras, levels, overlays = null) => {
    const id = node(S, { name: `${name}_${label}`, children: [], extras: { damage_state: label, ...extras } });
    const rec = { name: label, node: `${name}_${label}`, triangles: mesh.triangles, ...extras };
    if (rinfo) {
      // rigid rig: one rig copy per level, the state's mesh split over its nodes (rest frames)
      const lv = levels || [{ level: 0, pieces: splitRig(mesh, rinfo), triangles: mesh.triangles }];
      const ovp = overlays ? [{ pieces: splitRig(overlays.mesh, rinfo), suffix: 'overlays', extras: overlays.extras }] : [];
      if (levels) rec.lods = [];
      for (const L of lv) {
        const prefix = levels ? `${name}_${label}_LOD${L.level}` : `${name}_${label}_rig`;
        const r = addRig(S, def, rinfo, L.pieces, prefix, { addMesh, node, anims: S.anims, hidden: L.level > 0, extraPieces: L.level === 0 ? ovp : [] });
        if (levels) S.nodes[r.root].extras = { ...S.nodes[r.root].extras, lod: L.level, distance: L.distance };
        S.nodes[id].children.push(r.root);
        if (levels) rec.lods.push({ level: L.level, node: prefix, triangles: L.triangles, distance: L.distance });
        if (L.level === 0) rec.rig = { root: prefix, nodes: r.nodes.length, ...(ovp.length ? { overlays: 'per rig node: <node>_overlays' } : {}) };
      }
    } else if (skinBase) {
      // skinned: the state mesh (and every LOD level) is a skinned mesh on the shared armature
      // (skin 0); the intact bind mesh keeps its weights, other meshes take them from the bind surface
      // (decimated levels included: the weights ride through the collapses by surface transfer)
      const bindIntact = label === 'intact' && !blend;
      const skinOf = (m, level) => {
        if (bindIntact && level === 0) {
          if (!roblox) return skinBase.sk.mesh;
          const c = capRoblox(skinBase.sk.mesh, 'intact');
          if (!c.simplified) return skinBase.sk.mesh;
          m = c.mesh;
        }
        const t = transferSkin(skinBase.sk.mesh, m);
        skinBase.transfer = Math.max(skinBase.transfer, t.max_distance);
        return t.mesh;
      };
      const lv = levels || [{ level: 0, mesh }];
      if (levels) rec.lods = [];
      for (const L of lv) {
        const nm = levels ? `${name}_${label}_LOD${L.level}` : `${name}_${label}`;
        const target = levels ? node(S, { name: nm, extras: { lod: L.level, distance: L.distance }, ...(L.level ? { lodHidden: true } : {}) }) : id;
        if (levels) S.nodes[id].children.push(target);
        skinnedOn(S, target, nm, skinOf(L.mesh, L.level));
        if (bindIntact && L.level === 0 && !roblox) S.intactSkin = target;
        if (levels) rec.lods.push({ level: L.level, node: nm, triangles: L.mesh.triangles, distance: L.distance });
      }
      rec.skin = { skin: 0, weights: bindIntact ? 'bind (the skinned export)' : 'transferred from the intact bind surface (closest point)', ...(levels ? { lods: 'every level skinned (weights transferred from the bind surface)' } : {}) };
      if (overlays) {
        const on = `${name}_${label}_overlays`;
        const oid = node(S, { name: on, extras: overlays.extras });
        skinnedOn(S, oid, on, transferSkin(skinBase.sk.mesh, overlays.mesh).mesh);
        (levels ? S.nodes[S.nodes[id].children[0]] : S.nodes[id]).children = [...((levels ? S.nodes[S.nodes[id].children[0]] : S.nodes[id]).children || []), oid];
        rec.overlays_node = on;
      }
    } else if (levels) {
      rec.lods = [];
      for (const L of levels) {
        const lid = node(S, { name: `${name}_${label}_LOD${L.level}`, mesh: addMesh(S, `${name}_${label}_LOD${L.level}`, L.mesh), extras: { lod: L.level, distance: L.distance }, ...(L.level ? { lodHidden: true } : {}) });
        S.nodes[id].children.push(lid);
        rec.lods.push({ level: L.level, node: `${name}_${label}_LOD${L.level}`, triangles: L.triangles, distance: L.distance });
      }
    } else S.nodes[id].mesh = addMesh(S, `${name}_${label}`, mesh);
    rec.sockets = [];
    for (const s of sockets || []) {
      const sn = `${name}_${label}_${s.name}`;
      S.nodes[id].children.push(node(S, { name: sn, translation: s.pos, rotation: quatTo(s.dir), extras: { fx: s.fx, socket: s.name, state: label, intensity: s.intensity, direction: s.dir } }));
      rec.sockets.push({ name: s.name, node: sn, fx: s.fx, position: s.pos.map((v) => f6(v / scale)), direction: s.dir, intensity: s.intensity });
    }
    if (!S.nodes[id].children.length) delete S.nodes[id].children;
    return { id, rec };
  };
  // roblox: the intact MeshPart is capped like the states and carries no LOD levels
  const robloxIntact = roblox && spec ? capRoblox(built.mesh, 'intact') : null;
  const intactMesh = blend && !roblox ? blend.mesh : robloxIntact ? robloxIntact.mesh : built.mesh;
  const addStates = (S, parent, only) => {
    if (!spec) return;
    if (!only || only === 'intact') {
      const shellMorph0 = blend?.overlays ? [...blend.overlays.groups.values()].some((g) => g.morphs) : false;
      const ovr = blend?.overlays && !roblox && (rinfo || skinBase) ? { mesh: blend.overlays, extras: { overlays: true, ...(shellMorph0 ? { morph: 'damage' } : {}) } } : null;
      const { id, rec } = stateNodes(S, def.name, 'intact', intactMesh, [], { amount: 0, visible: true, ...(blend ? { blend: { morph: 'damage', uv_set: 1, mask: path.basename(`${base}.damage_mask.png`) } } : {}), ...(robloxIntact?.simplified ? { simplified_for_roblox: true } : {}) }, roblox ? null : levelsOf(intactMesh, !!blend), ovr);
      if (parent !== null) S.nodes[parent].children.push(id);
      if (blend?.overlays && !roblox && !ovr) {
        // the intact mesh's overlay shells: sibling mesh under the intact node, with the same "damage"
        // morph (weight = blend) so the shells stay on the dented surface
        const shellMorph = [...blend.overlays.groups.values()].some((g) => g.morphs);
        const oid = node(S, { name: `${def.name}_intact_overlays`, mesh: addMesh(S, `${def.name}_intact_overlays`, blend.overlays), extras: { overlays: true, ...(shellMorph ? { morph: 'damage' } : {}) } });
        (S.nodes[id].children || (S.nodes[id].children = [])).push(oid);
        rec.overlays_node = `${def.name}_intact_overlays`;
      }
      if (!only) manifest.states.push(rec); else manifest._last = rec;
    }
    for (const { st, s } of states) {
      if (only && only !== st.name) continue;
      let mesh = roblox ? bakeDecals(s) : s.mesh;
      let simplified = false;
      if (roblox) ({ mesh, simplified } = capRoblox(mesh, `state ${st.name}`));
      const { id, rec } = stateNodes(S, def.name, st.name, mesh, s.sockets, { amount: st.amount, visible: false, features: Object.fromEntries(Object.entries(s.stats).filter(([, v]) => v)), ...(simplified ? { simplified_for_roblox: true } : {}) }, roblox ? null : levelsOf(mesh));
      if (parent !== null) S.nodes[parent].children.push(id);
      if (!only) manifest.states.push(rec); else manifest._last = rec;
    }
  };
  const addFracture = (S, parent) => {
    if (!fr.length) return;
    const fid = node(S, { name: `${def.name}_fracture`, children: [], extras: { fracture: true, visible: false } });
    if (parent !== null) S.nodes[parent].children.push(fid);
    const gid = new Map();
    manifest.fracture = { groups: [] };
    for (const g of fr) {
      const id = node(S, { name: `${def.name}_${g.group}`, children: [], extras: { break_group: g.group, part: g.pi, parent_group: g.parent } });
      gid.set(g.group, id);
      const rec = { group: g.group, node: `${def.name}_${g.group}`, part: g.part, parent: g.parent, method: g.method, boolean: g.boolean, seed: g.seed, pieces: g.pieces, density_kg_m3: g.density, volume: f6(g.result.volume_px3 / scale ** 3), mass_kg: f6((g.result.volume_px3 / scale ** 3) * g.density), chunk_volume_error: f6(g.result.error), ...(g.result.closed ? { closed: g.result.closed } : {}), chunks: [] };
      const cnode = new Map(), ccenter = new Map(g.result.chunks.map((c) => [c.name, c.center]));
      for (const c of g.result.chunks) {
        // debris hangs under its level-1 chunk node (origin on that chunk's centre, no rotation at rest,
        // skinned or not): its translation is relative to the parent chunk's centre
        const pc = c.parent ? ccenter.get(c.parent) : null, at = pc ? c.center.map((v, k) => v - pc[k]) : c.center;
        let m = c.mesh.clone().transform([1, 0, 0, -c.center[0], 0, 1, 0, -c.center[1], 0, 0, 1, -c.center[2]]);
        if (roblox) m = capRoblox(m, `chunk ${c.name}`).mesh;
        const cn = `${def.name}_${c.name}`;
        const id2 = node(S, { name: cn, mesh: addMesh(S, cn, m), translation: at, children: [], extras: { chunk: c.name, break_group: g.group, level: c.level, parent_chunk: c.parent, mass_kg: f6((c.volume_px3 / scale ** 3) * g.density) } });
        if (c.hull) {
          const hm = c.hull.clone().transform([1, 0, 0, -c.center[0], 0, 1, 0, -c.center[1], 0, 0, 1, -c.center[2]]);
          S.nodes[id2].children.push(node(S, { name: `${cn}_collision`, mesh: addMesh(S, `${cn}_collision`, hm), proxy: true, extras: { collision: true, proxy: 'hull', visible: false } }));
        }
        cnode.set(c.name, id2);
        let bone = null;
        if (skinBase && !c.parent) {
          // skinned: a rigid chunk rides the bone that weighs most on its surface (closest points on
          // the bind surface); local matrix = inverse rest world of the bone x chunk centre
          const t = transferSkin(skinBase.sk.mesh, c.mesh), acc = new Map();
          for (const g2 of t.mesh.groups.values()) g2.skin.w.forEach((w, i) => { if (w > 0) acc.set(g2.skin.j[i], (acc.get(g2.skin.j[i]) || 0) + w); });
          const j = [...acc].sort((x, y) => y[1] - x[1] || x[0] - y[0])[0][0];
          const sk0 = skinBase.sc.skins[0], I = sk0.ibm[j], C = c.center;
          bone = S.nodes[sk0.joints[j]].name;
          delete S.nodes[id2].translation;
          S.nodes[id2].matrix = [I[0], I[1], I[2], I[0] * C[0] + I[1] * C[1] + I[2] * C[2] + I[3], I[4], I[5], I[6], I[4] * C[0] + I[5] * C[1] + I[6] * C[2] + I[7], I[8], I[9], I[10], I[8] * C[0] + I[9] * C[1] + I[10] * C[2] + I[11]];
          S.nodes[id2].extras = { ...S.nodes[id2].extras, bone, visible: false };
          (S.nodes[sk0.joints[j]].children || (S.nodes[sk0.joints[j]].children = [])).push(id2);
          (S.nodes[id].extras.chunks || (S.nodes[id].extras.chunks = [])).push(cn);
          skinBase.chunks++;
        } else (c.parent ? S.nodes[cnode.get(c.parent)] : S.nodes[id]).children.push(id2);
        rec.chunks.push({ name: c.name, ...(bone ? { bone } : {}), node: cn, level: c.level, parent: c.parent, volume: f6(c.volume_px3 / scale ** 3), mass_kg: f6((c.volume_px3 / scale ** 3) * g.density), center: c.center.map((v) => f6(v / scale)), bounds: { min: c.min.map((v) => f6(v / scale)), max: c.max.map((v) => f6(v / scale)) }, collision: c.hull ? { node: `${cn}_collision`, type: 'hull', vertices: c.hullVerts } : null, triangles: c.mesh.triangles, watertight: c.watertight });
      }
      manifest.fracture.groups.push(rec);
    }
    for (const g of fr) (g.parent ? S.nodes[gid.get(g.parent)] : S.nodes[fid]).children.push(gid.get(g.group));
    for (const n of S.nodes) if (n.children && !n.children.length) delete n.children;
  };
  const glbOpts = { scale, up: a.up, name: def.name, ...(vertex ? { dmgAttr: vertex } : {}) };
  // materials v2 (#15): the damage glbs carry the same material extensions / packing / tangents,
  // vertex colour sets and extra UV sets as the plain export. The damage mask UVs take the first free
  // TEXCOORD after the AO / lightmap UVs (TEXCOORD_1) and uv2 / uv3, so baked AO, lightmaps and
  // thickness work on damage exports too (baked per file: every state / LOD level / chunk occludes
  // only itself, all share one lightmap). The Roblox damage profile has its own path (one UV set).
  const v2Args = { ...a };
  for (const k of ['probes']) delete v2Args[k];
  const aoSpec = roblox ? null : normAO(a.bake_ao), lmSpec = roblox ? null : normLightmap(a.lightmap), thSpec = roblox ? null : normThickness(a.thickness);
  if (aoSpec && a.bake_ao && typeof a.bake_ao === 'object' && a.bake_ao.bent) aoSpec.bent = true;
  const bakeInfo = {};
  /** Bake AO / lightmap / thickness on own copies of a file's meshes -> glb options. */
  const bake = (S) => {
    if (!aoSpec && !lmSpec && !thSpec) return null;
    const meshes = S.meshes.map((m) => { const mm = new Mesh(); for (const g of m.groups) mm.groups.set(g.overlay ? `ov:${g.tex.key}` : g.tex.key, g); return mm.cloneFull(); });
    const sets = meshes.map((mm, i) => ({ mm, i })).filter(({ mm, i }) => !/_collision$/.test(S.meshes[i].name) && [...mm.groups.values()].some((g) => !g.overlay && g.faces?.length)).map(({ mm }) => ({ meshes: [mm] }));
    const out = {};
    if (sets.length) {
      if (lmSpec || thSpec || aoSpec?.bent) {
        const r = bakeLighting(sets, { ao: aoSpec, lm: lmSpec, thickness: thSpec, lights: built.lights || [], bounds: built.mesh.bounds() });
        if (r.ao) out.ao = r.ao;
        for (const k of ['lightmap', 'bent', 'thickness']) if (r[k]) out[k] = r[k];
        bakeInfo.lightmap = { size: r.stats.size, texel_px: r.stats.texel_px, charts: r.stats.charts, sets: sets.length };
      } else {
        const { stats, map } = bakeAO(sets, aoSpec);
        if (map) out.ao = map;
        bakeInfo.ao = { ...stats, sets: sets.length };
      }
    }
    S.meshes = S.meshes.map((m, i) => ({ ...m, groups: [...meshes[i].groups.values()] }));
    return out;
  };
  /** The damage mask UV set the writer picks for the blend mesh: after TEXCOORD_1 (AO / lightmap) and the uv2 / uv3 sets. */
  const fixUvSet = (meshes, nodes) => {
    const g = meshes.flatMap((m) => [...m.groups]).find((x) => x.uvd && !x.overlay);
    if (!g) return;
    const set = (g.uv1 ? 2 : 1) + (g.vattr ? Object.keys(g.vattr).filter((k) => k.startsWith('TEXCOORD_')).length : 0);
    for (const n of nodes) if (n.extras?.blend) n.extras.blend.uv_set = set;
    bakeInfo.uv_set = set;
  };
  if (v2Args.profile === 'roblox') delete v2Args.profile;
  let v2Report = null;
  let validation = null;
  const write = (S, f, extras) => {
    const baked = roblox ? null : bake(S);
    const st = roblox ? null : exportV2(def, built, v2Args, { meshes: S.meshes, nodes: S.nodes, ext: baked ? { glbOpts: baked, meta: {} } : null, scale, file: f, info: null, skinned: !!skinBase });
    fixUvSet(st ? st.meshes : S.meshes, st ? st.nodes : S.nodes);
    // rig clips (merged over the states) + the skeleton clips (morph weights on the intact bind mesh only)
    const animations = [...S.anims.values()];
    if (skinBase) for (const an of skinBase.sc.animations) {
      const ch = an.channels.flatMap((c) => (c.path !== 'weights' ? [c] : S.intactSkin !== undefined ? [{ ...c, node: S.intactSkin }] : []));
      if (ch.length) animations.push({ ...an, channels: ch });
    }
    const sceneOut = { meshes: st ? st.meshes : S.meshes, nodes: st ? st.nodes : S.nodes, ...(animations.length ? { animations } : {}), ...(S.skins ? { skins: S.skins } : {}) };
    const { glb, stats } = writeGLB(sceneOut, { ...glbOpts, ...(baked && baked.ao ? { ao: baked.ao } : {}), ...(st ? { ...st.glbOpts, v2: st.v2 } : {}), extras: { damage: extras } });
    if (st) { finishV2(st, glb, stats); v2Report = st.result.materials_v2; }
    if (rinfo || skinBase) {
      // rigged / skinned damage files go through both validators (node graph, animations, skins, attributes)
      const v1 = checkGLB(glb), v2s = validateSkinned(glb);
      if (!v1.ok || !v2s.ok) throw new Error(`damage export: ${path.basename(f)} failed glTF validation: ${[...(v1.errors || []), ...(v2s.errors || [])].slice(0, 4).join('; ')}`);
      validation = 'ok';
    }
    side.push([f, glb]);
    return { file: path.basename(f), bytes: glb.length, triangles: stats.triangles, nodes: stats.nodes, materials: stats.materials, ...(st ? { materials_v2: { valid: st.result.materials_v2.valid, extensions: st.result.materials_v2.extensions } } : {}) };
  };
  const outFiles = [];
  if (mode === 'nodes' || roblox) {
    const S = scene();
    const root = node(S, { name: `${def.name}_damage`, children: [], extras: { damage_root: true, states: ['intact', ...states.map(({ st }) => st.name)], manifest: `${bn}.damage.json` } });
    if (skinBase) S.nodes[root].children.push(S.armature);
    addStates(S, root);
    addFracture(S, root);
    const f = roblox ? `${base}.damage.roblox.glb` : `${base}.damage.glb`;
    outFiles.push(write(S, f, { states: manifest.states.map((s) => s.name), manifest: `${bn}.damage.json` }));
    manifest.file = path.basename(f);
  } else if (mode === 'files') {
    for (const label of spec ? ['intact', ...states.map(({ st }) => st.name)] : []) {
      const S = scene();
      addStates(S, null, label);
      const f = `${base}_${label}.glb`;
      const r = write(S, f, { state: label });
      manifest._last.file = r.file;
      manifest.states.push(manifest._last);
      outFiles.push(r);
    }
    if (fr.length) { const S = scene(); addFracture(S, null); outFiles.push(write(S, `${base}_fracture.glb`, { fracture: true })); manifest.fracture.file = path.basename(`${base}_fracture.glb`); }
  } else {
    if (!blend) throw new Error('damage.mode "blend" needs damage states (masks / vertex channel come from them)');
    const S = scene();
    addStates(S, null, 'intact');
    manifest.states.push(manifest._last);
    const r = write(S, `${base}.blend.glb`, { blend: true });
    manifest.file = r.file;
    outFiles.push(r);
  }
  delete manifest._last;
  if (blend) {
    manifest.blend = {
      node: `${def.name}_intact${lods ? '_LOD0' : rinfo ? '_rig' : ''}`, morph: 'damage', uv_set: (bakeInfo.uv_set ?? 1) === 1 ? 'TEXCOORD_1 (chart UVs, unique per face)' : `TEXCOORD_${bakeInfo.uv_set} (chart UVs, unique per face; TEXCOORD_1 = the AO / lightmap UVs${bakeInfo.uv_set === 3 ? ', TEXCOORD_2 = uv2' : bakeInfo.uv_set > 3 ? ', TEXCOORD_2 / TEXCOORD_3 = uv2 / uv3' : ''})`, mask: path.basename(`${base}.damage_mask.png`), mask_size: [blend.mask.width, blend.mask.height], texel_px: blend.texel_px,
      channels: { r: 'scorch + soot', g: 'dent', b: 'holes (bullets, cracks, glass holes, breach)', a: 'edge wear + scratches' }, coverage: blend.coverage,
      encoding: 'threshold: a texel shows its damage once blend >= 1 - value/255 (value = (1 - onset) x coverage), so one blend 0..1 grows the damage continuously; dent morph weight = blend',
      ...(vertex ? { vertex: { attribute: vertex, channels: 'RGBA = scorch, dent, holes, wear (same encoding, 0..1)' } } : {}),
      note: `Geometry that changes topology (panel loss, glass holes, breaches, bends) lives in the state nodes; blend covers the surface + dents on the intact mesh${lods ? ' and every LOD level (each <name>_intact_LODn carries the morph and the mask UVs)' : ' (LOD0 only)'}${blend.overlays && [...blend.overlays.groups.values()].some((g) => g.morphs) ? '; the overlay shells node carries the same morph' : ''}.`,
    };
  }
  if (rinfo) manifest.rig = { root: def.name, nodes: rinfo.nodes.map((n) => n.name), sockets: rinfo.sockets.map((s) => s.name), clips: Object.keys(def.clips || {}), validation, note: 'Every state (and LOD level) holds a copy of the rig: <model>_<state>_rig (LODs: <model>_<state>_LODn) with one node per rig node (<prefix>_<node>, rest TRS, its piece of the damaged mesh) and the socket nodes. One animation per clip drives the matching nodes of every state, so a damaged door opens and a wrecked turret turns; only the visible state shows.' };
  if (skinBase) manifest.skin = {
    armature: def.name, bones: skinBase.bones, skin: 0, clips: skinBase.sc.animations.map((x) => x.name), weight_transfer_max_px: f6(skinBase.transfer), validation,
    ...(lods ? { lods: 'every state LOD level is skinned on skin 0 (weights transferred from the bind surface onto the decimated mesh)' } : {}),
    ...(skinBase.chunks ? { fracture: `${skinBase.chunks} rigid chunks parented to their nearest bone (the bone weighing most on the chunk surface; chunk extras.bone, node matrix = inverse rest world of the bone x chunk centre, hidden until the break)` } : {}),
    ...(skinBase.roblox ? { roblox: { max_bones: skinBase.maxBones, max_influences: skinBase.roblox.max_influences, max_joints_per_mesh: skinBase.roblox.max_joints, skins: 1 + skinBase.roblox.meshes.filter((m) => m.skin).length, meshes: skinBase.roblox.meshes, note: `Roblox skinned MeshParts: <= ${skinBase.maxBones} bones per mesh (meshes over it are split into <node>_partN, each with its own skin over the same bones), <= 4 influences per vertex, <= ${ROBLOX_TRIS} triangles, no morph targets` } } : {}),
    note: 'Every state node is a skinned mesh on the one armature (skin 0, shared joints and inverse bind matrices). The intact state keeps the bind weights; damaged states (and LOD levels) take the weights of the closest point on the bind surface, so dents, cuts and inner backing follow the bones. Shape (morph) weights animate the intact bind mesh only. Baked AO / lightmap / thickness are baked on the bind (rest) pose.',
  };
  if (roblox) manifest.roblox = { tri_limit: ROBLOX_TRIS, note: 'Each state and chunk node is its own MeshPart (<= 20k triangles, simplified when needed). Masks, morphs and the second UV set are dropped: decals are baked into a per-state colour atlas (TEXCOORD_0). Swap MeshParts (Transparency 1 / 0) to change state; fx sockets become Attachments.' };
  if (v2Report) manifest.materials_v2 = { profile: v2Report.profile, extensions: v2Report.extensions, valid: v2Report.valid, note: aoSpec || lmSpec || thSpec || a.vertex_colors || a.uv2 || a.uv3 ? 'materials v2 as in the plain export, with its vertex colour sets, uv2 / uv3, AO, lightmap and thickness (TEXCOORD_1); the damage masks sample their own UV set (blend.uv_set)' : "materials v2 as in the plain export; vertex colour sets, uv2 / uv3, lightmaps and thickness stay on the plain export (TEXCOORD_1 + COLOR_0 / _DAMAGE carry the damage masks here)" };
  if (bakeInfo.ao || bakeInfo.lightmap) manifest.bake = { ...(bakeInfo.ao ? { ao: bakeInfo.ao } : {}), ...(bakeInfo.lightmap ? { lightmap: bakeInfo.lightmap } : {}), note: 'AO / lightmap on TEXCOORD_1 (occlusionTexture texCoord 1, material extras.lightMap), baked per file: every state, LOD level and chunk occludes only itself and they share one lightmap; the damage masks use blend.uv_set' };
  manifest.fx_kinds = FX_KINDS;
  manifest.usage = 'three.js: gltf.scene.getObjectByName("<model>_<state>") per state (extras.visible = default visibility; toggle .visible). fx sockets: child nodes "<model>_<state>_fx_<kind>_<n>" (userData.fx = spark|smoke|fire|steam|leak|flicker; -Z = emit direction). Blend: intact mesh morphTargetInfluences[dict.damage] = blend and a shader that samples the mask on uv1 (threshold encoding above). Fracture: hide the part, show <model>_<group> chunks; each chunk node origin = centre of mass, userData.mass_kg, child *_collision = convex hull (hidden).';
  const ms = Math.round(performance.now() - t0);
  side.push([`${base}.damage.json`, Buffer.from(JSON.stringify(manifest, null, 2))]);
  return {
    after() { for (const [f, buf] of side) fs.writeFileSync(f, buf); },
    files: side.map(([f]) => f),
    result: { damage: { files: side.map(([f]) => path.basename(f)), mode, profile: profile || 'web', states: manifest.states.map((s) => ({ name: s.name, triangles: s.triangles, sockets: s.sockets?.length ?? 0, ...(s.lods ? { lods: s.lods.map((l) => l.triangles) } : {}) })), ...(manifest.fracture ? { fracture: manifest.fracture.groups.map((g) => ({ group: g.group, chunks: g.chunks.length })) } : {}), ...(blend ? { mask: `${blend.mask.width}x${blend.mask.height}`, intact_note: 'the blend-ready intact node is not identical to the plain <name>.glb: its vertices are split along the chart-UV seams (unique mask UVs per face, so more vertices) and it carries the dent morph + mask channels; at blend 0 it looks the same' } : {}), glbs: outFiles, ms } },
    manifest,
  };
}

export { DAMAGE_KINDS, STATE_PRESETS };
