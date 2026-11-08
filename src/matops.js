// art_model materials v2 glue: the export stage (profiles three / roblox / minimal, packing,
// vertex data, TANGENT, extension hooks, Roblox SurfaceAppearance maps + report, validation),
// the material editor (art_model material) and channel previews (preview {channel}).
import path from 'node:path';
import { Mesh } from './model3d.js';
import { encodePNG } from './png.js';
import { normPBR, MATERIAL_PRESETS } from './surface.js';
import { V2_PRESETS, makeV2, normProfile, wantsV2, normVertexColors, normUVSet, attachVertexData, splitORM, packORM, fitTexture, materialOcclusion } from './materials.js';
import { simplifyMesh } from './lod.js';
import { validateGLB } from './gltfcheck.js';
import { renderViews } from './raster3d.js';
import { packImages } from './sheet.js';
import { bakeLighting, normLightmap, normThickness } from './lightbake.js';
import { normAO } from './bake.js';
import { CHANNELS } from './shade2.js';

const ROBLOX_TRIS = 20000, ROBLOX_TEX = 1024;
const groupsOfMeshes = (meshes) => meshes.flatMap((m) => [...m.groups]);
const safe = (s) => String(s).replace(/[^A-Za-z0-9_.-]+/g, '_').slice(0, 64) || 'mat';

/** Strip a texture down for a profile (cached per texture object). */
function strippedTex(t, profile, cache) {
  if (cache.has(t)) return cache.get(t);
  const keep = { key: t.key, canvas: t.canvas, name: t.name, width: t.width, height: t.height, data: t.data, ...(t.imageKey ? { imageKey: t.imageKey } : {}), ...(t.material ? { material: t.material } : {}), ...(t.pbr ? { pbr: t.pbr } : {}), ...(t.ctm ? { ctm: t.ctm } : {}) };
  if (profile === 'roblox') {
    if (t.normal) { keep.normal = t.normal; if (t.normalKey) keep.normalKey = t.normalKey; }
    if (t.mr) { keep.mr = t.mr; if (t.mrKey) keep.mrKey = t.mrKey; }
  }
  cache.set(t, keep);
  return keep;
}

/**
 * The v2 export stage (assembleGLB): mutates the scene's groups as the options ask, returns the
 * writer hooks. -> null (0.7 export) | {meshes, v2, meta, result, side: [[file, Buffer]], validate}
 */
export function exportV2(def, built, args, { meshes, nodes, ext, scale, file, info }) {
  const groups = groupsOfMeshes(meshes.map((m) => ({ groups: [...m.groups] })));
  if (!wantsV2(args, groups)) return null;
  const prof = normProfile(args);
  // an "ao" canvas layer only means something in an ORM texture: pack by default
  if (!prof.packing && !prof.profile && groups.some((g) => g.tex && g.tex.aoData)) prof.packing = 'gltf_orm';
  const meta = {}, result = {}, side = [];
  meshes = meshes.map((m) => ({ ...m, groups: [...m.groups] }));
  const dropped = [];
  const drop = (what, why) => { if (!dropped.some((d) => d.what === what)) dropped.push({ what, why }); };
  let glbOpts = ext ? { ...ext.glbOpts } : {};
  // ---- profiles that drop data
  if (prof.profile === 'minimal' || prof.profile === 'roblox') {
    const cache = new Map();
    for (const m of meshes) for (const g of m.groups) {
      if (g.overlay) { if (prof.profile === 'roblox') drop('overlay decal shells', 'Roblox MeshParts have one UV set and no vertex alpha'); continue; }
      const t = g.tex;
      if (t.emissive) drop('emissive', prof.profile === 'roblox' ? 'SurfaceAppearance has no emissive map: use a Neon part, a SurfaceLight or a PointLight' : 'minimal = base colour only');
      if (t.v2) drop('material extensions (clearcoat / anisotropy / transmission / sheen / subsurface / emissive strength / detail / height)', prof.profile === 'roblox' ? 'SurfaceAppearance is Color + Normal + Metalness + Roughness' : 'minimal = base colour only');
      if (prof.profile === 'minimal' && t.normal) drop('normal maps', 'minimal = base colour only');
      if (prof.profile === 'minimal' && t.mr) drop('metallicRoughness maps', 'minimal = base colour only');
      if (g.ao) { drop('vertex AO (COLOR_0)', 'profile drops vertex colours'); delete g.ao; }
      if (g.uv1) { drop('baked AO / lightmap (TEXCOORD_1)', prof.profile === 'roblox' ? 'Roblox lights MeshParts itself (one UV set)' : 'minimal = one UV set'); delete g.uv1; }
      if (g.morphs && prof.profile === 'roblox') { drop('morph targets', 'Roblox MeshParts have no morph targets (FACS is for heads only)'); delete g.morphs; }
      g.tex = strippedTex(t, prof.profile, cache);
    }
    for (const k of ['ao', 'lightmap', 'bent', 'thickness']) if (glbOpts[k]) { delete glbOpts[k]; }
    if (args.vertex_colors || args.uv2 || args.uv3) drop('vertex colours / extra UV sets', `${prof.profile} profile`);
    if (ext && ext.meta.probes) drop('light probes', 'meta only; not used by this profile');
    if (built.gpu && prof.profile === 'roblox') drop('EXT_mesh_gpu_instancing', 'merged into the mesh (Roblox has no GPU instancing in imports)');
  }
  // ---- Roblox: meshes under 20k triangles
  if (prof.profile === 'roblox') {
    const meshParts = [];
    meshes = meshes.map((m) => {
      const tris = m.groups.reduce((s, g) => s + g.idx.length / 3, 0);
      if (tris < ROBLOX_TRIS) { meshParts.push({ mesh: m.name, triangles: tris }); return m; }
      const mm = new Mesh();
      for (const g of m.groups) mm.groups.set(g.overlay ? `ov:${g.tex.key}` : g.tex.key, g);
      const r = simplifyMesh(mm, { ratio: (ROBLOX_TRIS - 500) / tris, level: 1 });
      meshParts.push({ mesh: m.name, triangles: r.triangles, simplified_from: tris });
      drop(`triangles over ${ROBLOX_TRIS} in mesh ${m.name}`, `simplified ${tris} -> ${r.triangles} (MeshPart limit)`);
      return { ...m, groups: [...r.mesh.groups.values()].filter((g) => g.idx.length) };
    });
    // glb textures over 1024 px are halved until they fit
    for (const m of meshes) for (const g of m.groups) {
      const t = g.tex;
      if (Math.max(t.width, t.height) <= ROBLOX_TEX) continue;
      const f = fitTexture(t.width, t.height, t.data, ROBLOX_TEX, false);
      g.tex = { ...t, width: f.width, height: f.height, data: f.data, ...(t.normal ? { normal: fitTexture(t.width, t.height, t.normal, ROBLOX_TEX, false).data } : {}), ...(t.mr ? { mr: fitTexture(t.width, t.height, t.mr, ROBLOX_TEX, false).data } : {}), key: `${t.key}#rbx` };
      drop(`texture ${t.name} at ${t.width}x${t.height}`, `downscaled to ${f.width}x${f.height} (1024 px limit)`);
    }
    // SurfaceAppearance maps: Color / Normal / Metalness / Roughness per material, nearest-upscaled
    const dir = `${file.replace(/\.glb$/i, '')}.roblox`, rel = path.basename(dir);
    const seen = new Map(), mats = [];
    for (const m of meshes) for (const g of m.groups) {
      if (g.overlay || seen.has(g.tex.key)) continue;
      const t = g.tex, name = safe(t.name || t.key);
      const W = t.width, H = t.height, tiny = W * H <= 16;
      const target = tiny ? 4 : ROBLOX_TEX;
      const mr = t.mr || packORM(W, H, null, null, t.pbr || { metal: 0, rough: 1 });
      const sp = splitORM(W, H, mr);
      const flatN = new Uint8ClampedArray(W * H * 4); for (let i = 0; i < W * H; i++) flatN.set([128, 128, 255, 255], i * 4);
      const maps = { ColorMap: t.data, NormalMap: t.normal || flatN, MetalnessMap: sp.metalness, RoughnessMap: sp.roughness };
      const files = {};
      let up = 1;
      for (const [k, data] of Object.entries(maps)) {
        const f = fitTexture(W, H, data, target, true);
        up = f.scale;
        const fn = `${name}_${k.replace('Map', '').toLowerCase()}.png`;
        side.push([path.join(dir, fn), encodePNG(f.width, f.height, f.data)]);
        files[k] = `${rel}/${fn}`;
      }
      let alpha = false;
      for (let i = 3; i < t.data.length; i += 4) if (t.data[i] < 255) { alpha = true; break; }
      const entry = { material: t.name || t.key, ...files, size: [W * up, H * up], upscale: up, ...(t.normal ? {} : { normal: 'flat' }), ...(t.mr ? {} : { metalness: t.pbr ? t.pbr.metal : 0, roughness: t.pbr ? t.pbr.rough : 1 }), AlphaMode: alpha ? 'Transparency' : 'Overlay' };
      seen.set(t.key, entry);
      mats.push(entry);
    }
    const manifest = {
      generator: 'agent-art', model: def.name, glb: path.basename(file), mesh_parts: meshParts, surface_appearances: mats, dropped,
      limits: { triangles_per_meshpart: ROBLOX_TRIS, texture_px: ROBLOX_TEX, ok: meshParts.every((x) => x.triangles < ROBLOX_TRIS) && mats.every((x) => Math.max(...x.size) <= ROBLOX_TEX) },
      notes: [
        'Import the .glb with the 3D Importer (one MeshPart per material; export atlas:true for one MeshPart + one SurfaceAppearance), then add a SurfaceAppearance per MeshPart with these four maps.',
        'Roblox samples textures bilinearly: maps are nearest-upscaled by an integer factor (upscale) so texels stay crisp.',
        'NormalMap: tangent space, OpenGL / glTF convention (+Y = green up), same as the .glb.',
        'Units: the .glb is in units = px / px_per_unit; Roblox treats 1 unit as 1 stud on import unless rescaled.',
      ],
    };
    side.push([path.join(dir, 'surface_appearance.json'), Buffer.from(JSON.stringify(manifest, null, 2))]);
    meta.roblox = { dir: rel, mesh_parts: meshParts, materials: mats.length, dropped, limits: manifest.limits, manifest: `${rel}/surface_appearance.json` };
    result.roblox = { dir, mesh_parts: meshParts.length, max_triangles: Math.max(0, ...meshParts.map((x) => x.triangles)), maps: mats.length * 4, ok: manifest.limits.ok, dropped: dropped.map((d) => d.what) };
  } else if (prof.profile === 'minimal') {
    meta.minimal = { dropped };
    result.dropped = dropped.map((d) => d.what);
  }
  // ---- vertex data (paint / masks / AO colour sets, UV2 / UV3)
  if (prof.profile !== 'minimal' && prof.profile !== 'roblox' && (args.vertex_colors || args.uv2 || args.uv3)) {
    const colors = normVertexColors(args.vertex_colors), uv2 = normUVSet(args.uv2, 'uv2'), uv3 = normUVSet(args.uv3, 'uv3');
    const b = built.mesh.bounds();
    const { mapping } = attachVertexData(meshes.flatMap((m) => m.groups), { colors, uv2, uv3, bounds: b, scale });
    meta.vertex_data = { attributes: mapping, note: 'COLOR_n are linear RGBA. paint = part paint colour (white default); masks = R wetness (part wetness), G AO (vertex AO when baked, else 1), B height 0..1 over the model, A 1. world = planar world units along the face axis (detail / triplanar masks), box = model bounds 0..1. three.js: COLOR_1 -> geometry.attributes.color_1, TEXCOORD_2 -> uv2 (custom shader attribute).' };
    result.vertex_data = mapping;
  }
  const v2 = makeV2({ ...prof, scale, lightmap: glbOpts.lightmap, bent: glbOpts.bent, thickness: glbOpts.thickness });
  meta.materials_v2 = { profile: prof.profile, packing: prof.packing, tangents: prof.tangents, note: 'TANGENT = MikkTSpace-compatible (w = handedness, bitangent = cross(N, T) * w = image up). Extensions: see materials[].extensions; agent-art extras: lightMap, heightTexture, bentNormalTexture, thicknessTexture, detail, unityMaskTexture, emissiveAnimation. three.js hookups: docs/materials/README.md' };
  return { meshes, nodes, v2, glbOpts, meta, result, side };
}

/** After writeGLB: validation + report into meta / result. */
export function finishV2(stage, glb, stats) {
  const v = validateGLB(glb);
  const rep = stats.v2 || {};
  stage.meta.materials_v2 = { ...stage.meta.materials_v2, extensions: v.stats.extensions, textures_deduped: rep.textures_deduped || 0, tangent_primitives: rep.tangents || 0, split_vertices: rep.split_vertices || 0, materials: rep.materials || {}, validation: { ok: v.ok, errors: v.errors, warnings: v.warnings.length } };
  stage.result.materials_v2 = { profile: stage.meta.materials_v2.profile, extensions: v.stats.extensions, textures: stats.textures, deduped: rep.textures_deduped || 0, tangents: rep.tangents || 0, valid: v.ok, ...(v.ok ? {} : { errors: v.errors.slice(0, 5) }) };
  return v;
}

// ---------- material editor ----------
const MAT_RE = /^[A-Za-z0-9_\-.]{1,64}$/;
/** Resolved material summary (for list / material results). */
export function describeMaterial(spec, named) {
  const r = normPBR(spec, named);
  if (!r) return null;
  const out = { metal: r.metal, rough: r.rough };
  if (r.preset) out.preset = r.preset;
  if (r.glass) out.glass = true;
  if (r.emissive) out.emissive = true;
  if (r.v2) out.v2 = r.v2;
  return out;
}
/**
 * art_model material {name, material?, preset?, set?:{..}, delete?}: list (no material), or create /
 * edit / delete a model material. Model materials apply to parts with material:"<name>" and to
 * every face textured with a canvas of the same name (when the part has no material).
 */
export function materialOp(def, a) {
  const mats = { ...(def.materials || {}) };
  if (a.material === undefined) return { list: true, mats };
  if (!MAT_RE.test(String(a.material))) throw new Error('material name must be 1-64 letters, digits, _ - .');
  const name = String(a.material);
  if (a.delete) {
    if (!Object.hasOwn(mats, name)) throw new Error(`model has no material "${name}"`);
    const users = def.parts.map((p, i) => (p && (p.material === name || (p.material && typeof p.material === 'object' && p.material.preset === name)) ? p.name ?? p.id ?? i : null)).filter((x) => x !== null);
    if (users.length) throw new Error(`material "${name}" is used by part(s) ${users.join(', ')}: give them another material first`);
    delete mats[name];
    return { mats, name, deleted: true };
  }
  const prev = mats[name];
  let spec = typeof prev === 'string' ? { preset: prev } : { ...(prev || {}) };
  if (a.preset !== undefined) spec = a.preset === null ? Object.fromEntries(Object.entries(spec).filter(([k]) => k !== 'preset')) : { ...spec, preset: a.preset };
  if (a.set !== undefined) {
    if (!a.set || typeof a.set !== 'object' || Array.isArray(a.set)) throw new Error('material set must be {field: value} (null removes a field): metal, rough, emissive, clearcoat, anisotropy, transmission, ior, sheen, subsurface, height, detail');
    for (const [k, v] of Object.entries(a.set)) if (v === null) delete spec[k]; else spec[k] = v;
  }
  if (a.preset === undefined && a.set === undefined && prev === undefined) throw new Error(`material "${name}" does not exist: give preset:"<${[...Object.keys(MATERIAL_PRESETS), ...Object.keys(V2_PRESETS)].join('|')}>" and/or set:{..}`);
  if (Object.hasOwn(spec, 'preset') && spec.preset === name) throw new Error(`material "${name}" cannot use itself as preset`);
  const probe = { ...mats, [name]: spec };
  describeMaterial(spec, probe); // validates
  mats[name] = spec;
  return { mats, name, spec, resolved: describeMaterial(spec, mats) };
}
/** Which channels a built texture has (material list / UI). */
export function textureChannels(t) {
  return {
    albedo: true, ...(t.normal ? { normal: true } : {}), ...(t.mr ? { metal_rough: 'map' } : t.pbr ? { metal_rough: [t.pbr.metal, t.pbr.rough] } : {}), ...(t.emissive ? { emissive: true } : {}),
    ...(t.heightOf ? { height: true } : {}), ...(t.aoData ? { ao_layer: true } : {}), ...(t.v2 ? { v2: Object.keys(t.v2) } : {}), ...(t.detail ? { detail: t.detail.name } : {}),
  };
}

// ---------- channel previews ----------
/**
 * preview {channel: "<channel>" | [channels] | "all", views?, size?, pom?, bake?} -> image + info.
 * Bake channels (lightmap, ao, bent, thickness, uv1) run a quick bake on the preview mesh.
 */
export function channelPreview(def, built, a) {
  const t0 = performance.now();
  let list = a.channel === 'all' ? ['lit', 'albedo', 'normal', 'orm', 'emissive', 'height', 'lightmap', 'bent'] : [].concat(a.channel);
  for (const c of list) if (!CHANNELS.includes(c)) throw new Error(`channel must be one of ${CHANNELS.join(', ')} (or "all", or a list)`);
  const mesh = built.mesh.clone();
  const needBake = list.some((c) => ['lightmap', 'ao', 'bent', 'thickness', 'uv1'].includes(c)) || (a.bake && list.includes('lit'));
  let bakeInfo = null;
  if (needBake) {
    const lmWanted = list.includes('lightmap') || list.includes('uv1') || (a.bake && list.includes('lit'));
    const lmo = lmWanted ? normLightmap({ samples: 16, bounce: 1, ...(typeof a.lightmap === 'object' ? a.lightmap : {}) }) : null;
    const aoo = list.some((c) => c === 'ao' || c === 'bent') ? { ...normAO({ samples: 16 }), bent: list.includes('bent') } : null;
    const th = list.includes('thickness') ? normThickness(true) : null;
    const r = bakeLighting([{ meshes: [mesh] }], { ao: aoo, lm: lmo, thickness: th, lights: built.lights || [], bounds: mesh.bounds() });
    for (const g of mesh.groups.values()) {
      if (g.overlay) continue;
      if (r.ao) g.aoTex = r.ao;
      if (r.lightmap) g.lmTex = r.lightmap;
      if (r.bent) g.bentTex = r.bent;
      if (r.thickness) g.thTex = r.thickness;
    }
    bakeInfo = r.stats;
  }
  const groups = [...mesh.groups.values()].filter((g) => g.idx.length);
  const views = a.views || [a.view || 'game'];
  const size = a.size ?? (list.length > 1 ? 192 : 384);
  const items = list.map((ch) => {
    const img = renderViews(groups, { views, size, labels: false, raster: { channel: ch === 'lit' ? null : ch, pom: !!a.pom } });
    return { img, label: ch };
  });
  const sheet = items.length === 1 ? items[0].img : packImages(items.map((it) => ({ img: it.img, label: it.label })), { labels: true, checker: false, columns: Math.min(items.length, a.columns ?? 4) });
  const mats = {};
  for (const g of groups) if (!g.overlay) mats[g.tex.name || g.tex.key] = textureChannels(g.tex);
  return { image: encodePNG(sheet.width, sheet.height, sheet.data), channels: list, materials: mats, ...(bakeInfo ? { bake: bakeInfo } : {}), triangles: mesh.triangles, ms: Math.round(performance.now() - t0) };
}
