// art_model skinning ops: skeleton (templates / rigid parts / art_anim library + cable helper),
// skin (weights + shapes), weights (weights_check + heat-map preview), skeletal animate / pose /
// retarget from art_anim clips, and the hooks render / preview / export use for skinned models.
// Models without def.skeleton + def.skin never reach this file, so their exports are unchanged.
import fs from 'node:fs';
import path from 'node:path';
import { Mesh } from './model3d.js';
import { rigInfo } from './modelrig.js';
import { attachMorphs, normLods, normLodScreen } from './modelexport.js';
import { normAO } from './bake.js';
import { normLightmap, normThickness } from './lightbake.js';
import { meshOfGroups, bakeRest, lodSet } from './restbake.js';
import { transferSkin } from './damagerig.js';
import { normalizeRig, solvePose } from './rig.js';
import { evalClip } from './animlib.js';
import { expandSkeleton, resolveSkeleton, bonesFromRig, bonesFromLibrary, retargetFrom2D, skelClipKeys, sampleSkelClip, poseState, solvePoseState, boneOffsets, SKELETON_TEMPLATE_NAMES } from './skeleton3d.js';
import { skinMesh, deformMesh, skelSockets, skinScene, robloxProfile, ROBLOX_MAX_BONES } from './skin3d.js';
import { validateGLB } from './gltfvalidate.js';
import { exportV2, finishV2 } from './matops.js';
import { renderViews } from './raster3d.js';
import { encodePNG } from './png.js';

const r4 = (v) => Math.round(v * 1e4) / 1e4;
export const isSkinned = (def) => !!(def && def.skeleton && def.skin);

/** Shape names of a skin in skinMesh order (variant shapes first, then sculpted), without building. */
export function shapeNames(def) {
  const shapes = def.skin?.shapes || {};
  const variant = Object.keys({ ...(def.morphs || {}), ...shapes }).filter((n) => { const s = shapes[n] ?? def.morphs?.[n]; return s && (s.set || s.model); });
  return [...variant, ...Object.keys(shapes).filter((n) => shapes[n]?.sculpt && !variant.includes(n))];
}

function partIndexOf(def) {
  return (k, where) => {
    if (/^\d+$/.test(String(k))) { const i = Number(k); if (!def.parts[i]) throw new Error(`${where}: no part ${i}`); return i; }
    const i = def.parts.findIndex((p) => p && (p.name === k || p.id === k));
    if (i < 0) throw new Error(`${where}: no part ${JSON.stringify(k)} (indices or part names / ids: ${def.parts.filter((p) => p?.name || p?.id).map((p) => p.name || p.id).join(', ') || 'none'})`);
    return i;
  };
}

/**
 * Resolved skeleton + skinned mesh of a model (cached on the build). ctx: {engine, build, variantOf, tex}.
 */
export function skinnedOf(ctx, def, built) {
  if (built._skinned) return built._skinned;
  const S = resolveSkeleton(def.skeleton);
  const spec = def.skin;
  const pIdx = partIndexOf(def);
  const rigid = new Map(Object.entries(spec.rigid || {}).map(([k, b]) => {
    if (!S.byName.has(b)) throw new Error(`skin.rigid.${k}: "${b}" is not a bone`);
    return [pIdx(k, 'skin.rigid'), b];
  }));
  const owners = new Map();
  const ownerBone = (pi, p, deform) => {
    if (owners.has(pi)) return owners.get(pi);
    let b = null;
    if (pi >= 0) {
      const part = def.parts[pi];
      if (rigid.has(pi)) b = rigid.get(pi);
      else if (part?.bone !== undefined) { if (!S.byName.has(part.bone)) throw new Error(`part ${pi}: bone "${part.bone}" is not a bone`); b = part.bone; }
      else {
        // the part's own name, then its named parents
        for (let q = part, g = 0; q && g < 64 && !b; g++) {
          if (q.name && S.byName.has(q.name)) b = q.name;
          q = q.parent ? def.parts.find((x) => x && x.name === q.parent) : null;
        }
      }
    }
    if (!b) {
      // nearest bone to the part centre (overlays: to the vertex)
      const pb = pi >= 0 ? built.partBounds?.[pi] : null;
      const c = pb ? pb.min.map((v, k) => (v + pb.max[k]) / 2) : p;
      let best = Infinity;
      for (const bone of deform) {
        const ab = [bone.tail[0] - bone.head[0], bone.tail[1] - bone.head[1], bone.tail[2] - bone.head[2]], l2 = ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2;
        const t = l2 > 1e-12 ? Math.max(0, Math.min(1, ((c[0] - bone.head[0]) * ab[0] + (c[1] - bone.head[1]) * ab[1] + (c[2] - bone.head[2]) * ab[2]) / l2)) : 0;
        const d = Math.hypot(c[0] - bone.head[0] - ab[0] * t, c[1] - bone.head[1] - ab[1] * t, c[2] - bone.head[2] - ab[2] * t);
        if (d < best - 1e-9) { best = d; b = bone.name; }
      }
    }
    if (pi >= 0) owners.set(pi, b);
    return b;
  };
  const sk = skinMesh(spec, {
    S, built, def, partIndex: pIdx, ownerBone,
    canvas: (n) => ctx.tex(n),
    variantShapes: (mesh, variant) => attachMorphs({ ...def, morphs: variant }, { mesh, shift: built.shift }, { variantDef: ctx.variantOf(def), buildDef: (d) => ctx.build(d, { tex: built.tex }) }),
  });
  built._skinned = { S, sk };
  return built._skinned;
}

/** Pose states for render / preview: a skeleton clip sampled n times, or one pose. */
export function skinSamples(S, sk, a) {
  if (a.clip !== undefined) {
    const clip = S.clips[a.clip];
    if (!clip) throw new Error(`unknown skeleton clip "${a.clip}" (clips: ${Object.keys(S.clips).join(', ') || 'none'}; art_model animate {name, clip, keys:[{t, bones}]} or retarget:{skeleton, clip})`);
    const ck = skelClipKeys(S, clip, sk.morphNames);
    const count = Math.max(1, Math.min(240, Math.round(Number(a.frames ?? Math.max(1, Math.round(ck.duration * (a.fps ?? 15)) + (ck.loop ? 0 : 1))))));
    const step = ck.loop ? ck.duration / count : count > 1 ? ck.duration / (count - 1) : 0;
    const samples = [];
    for (let i = 0; i < count; i++) { const time = i * step; samples.push({ time, state: sampleSkelClip(S, ck, time) }); }
    return { samples, ms: Math.max(10, Math.round((ck.loop ? ck.duration / count : step || ck.duration || 0.1) * 1000)), loop: ck.loop, events: ck.events, duration: ck.duration };
  }
  const morphs = a.morph && typeof a.morph === 'object' ? a.morph : {};
  return { samples: [{ time: 0, state: poseState(S, { pose: a.pose, bones: a.bones ?? a.parts }, morphs) }], ms: a.duration ?? 100, loop: a.loop };
}

/** Posed world {mesh, sockets} of a skinned sample under an optional render-angle matrix. */
export function skinPosed(S, sk, state, pre = null) {
  const solved = solvePoseState(S, state, { pre, drivers: sk.drivers });
  return { mesh: deformMesh(sk.mesh, solved, S, sk.morphNames), sockets: skelSockets(S, solved), solved };
}

/** Weight heat map of one bone: the bind mesh recoloured (blue 0 .. red 1) for preview. */
export function weightHeatMesh(S, sk, bone) {
  const b = S.byName.get(bone);
  if (!b) throw new Error(`weights: "${bone}" is not a bone (bones: ${S.bones.map((x) => x.name).join(', ')})`);
  const levels = 8, out = new Mesh();
  const texOf = (k) => {
    const t = k / (levels - 1), c = [Math.round(40 + 215 * t), Math.round(60 + 120 * (1 - Math.abs(t - 0.5) * 2)), Math.round(255 * (1 - t))];
    return { key: `heat${k}`, name: `heat${k}`, width: 1, height: 1, data: Uint8ClampedArray.from([...c, 255]) };
  };
  const texs = Array.from({ length: levels }, (_, k) => texOf(k));
  for (const g of sk.mesh.groups.values()) {
    if (g.overlay) continue;
    for (let t = 0; t < g.idx.length; t += 3) {
      let w = 0;
      for (let k = 0; k < 3; k++) { const v = g.idx[t + k]; for (let c = 0; c < 4; c++) if (g.skin.j[v * 4 + c] === b.i) w += g.skin.w[v * 4 + c] / 3; }
      const og = out.group(texs[Math.min(levels - 1, Math.round(w * (levels - 1)))]), base = og.pos.length / 3;
      for (let k = 0; k < 3; k++) { const v = g.idx[t + k]; og.pos.push(g.pos[v * 3], g.pos[v * 3 + 1], g.pos[v * 3 + 2]); og.nrm.push(g.nrm[v * 3], g.nrm[v * 3 + 1], g.nrm[v * 3 + 2]); og.uv.push(0.5, 0.5); }
      og.idx.push(base, base + 1, base + 2);
    }
  }
  return out;
}

/** In-memory skinned .glb (+ validation) for export / the UI viewer. */
export function assembleSkinned(ctx, def, built, { scale, up, file, args = {} }) {
  const { S, sk } = skinnedOf(ctx, def, built);
  if (!sk.mesh.triangles) throw new Error('model has no triangles to export');
  const fps = Number(args.fps ?? 30);
  if (!(fps >= 1 && fps <= 120)) throw new Error('fps must be 1..120');
  const scene = skinScene(def.name, S, sk, { fps });
  if (args.profile !== undefined && args.profile !== null && !['three', 'roblox', 'minimal'].includes(args.profile)) throw new Error('profile must be one of three, roblox, minimal (three = everything, roblox = SurfaceAppearance maps + skinned MeshPart limits, minimal = geometry + base colour)');
  // LOD levels (every level skinned on the one armature: the weights ride through the decimation by
  // surface transfer from the bind mesh) and AO / lightmap / thickness baked on the bind (rest) pose
  const lods = normLods(args.lods), screen = normLodScreen(args.lod_screen);
  if (lods && args.profile === 'roblox') throw new Error('lods: Roblox makes the LODs of a MeshPart itself (RenderFidelity): export the roblox profile without lods');
  const ao = normAO(args.bake_ao), lm = normLightmap(args.lightmap), thick = normThickness(args.thickness);
  if (ao && args.bake_ao && typeof args.bake_ao === 'object' && args.bake_ao.bent) ao.bent = true;
  const lodMeta = {}, bakeOpts = {};
  if (lods || ao || lm || thick) {
    const bind = meshOfGroups(sk.mesh.groups.values());
    const levels = lods ? lodSet([bind], lods, { scale, screen }) : [{ level: 0, ratio: 1, meshes: [bind], triangles: bind.triangles, distance: 0, error_px: 0 }];
    let transfer = 0;
    for (const L of levels.slice(1)) { const t = transferSkin(sk.mesh, L.meshes[0]); L.meshes[0] = t.mesh; transfer = Math.max(transfer, t.max_distance); }
    if (ao || lm || thick) {
      const r = bakeRest(levels.map((L) => [{ mesh: L.meshes[0], world: null }]), { ao, lm, thickness: thick, lights: built.lights || [], bounds: bind.bounds() });
      Object.assign(bakeOpts, r.glbOpts);
      lodMeta.bake = { ...(ao ? { ao: ao.mode } : {}), ...(lm ? { lightmap: true } : {}), ...(thick ? { thickness: true } : {}), ...r.stats, pose: 'bind (rest)', note: 'AO / lightmap / thickness baked on the bind (rest) pose on TEXCOORD_1; the skinned mesh carries them as it deforms (the light of the rest pose)' };
    }
    scene.meshes[0] = { ...scene.meshes[0], groups: [...levels[0].meshes[0].groups.values()] };
    if (lods) {
      for (const L of levels.slice(1)) {
        scene.meshes.push({ name: `${def.name}_LOD${L.level}`, groups: [...L.meshes[0].groups.values()] });
        scene.nodes.push({ name: `${def.name}_mesh_LOD${L.level}`, mesh: scene.meshes.length - 1, skin: 0, lodHidden: true, extras: { lod: L.level, distance: L.distance } });
      }
      scene.nodes[scene.meshNode] = { ...scene.nodes[scene.meshNode], extras: { ...(scene.nodes[scene.meshNode].extras || {}), lod: 0, distance: 0 } };
      lodMeta.lods = { levels: levels.map((L) => ({ level: L.level, node: L.level ? `${def.name}_mesh_LOD${L.level}` : `${def.name}_mesh`, triangles: L.triangles, distance: L.distance })), weight_transfer_max_px: +transfer.toFixed(6), note: 'Every level is a skinned mesh on skin 0 (the same joints); show one level by camera distance (levels[i].distance, units). Shapes (morph targets) animate LOD0.' };
    }
  }
  let roblox = null;
  if (args.profile === 'roblox') roblox = robloxProfile(scene, S, { maxBones: Math.round(Number(args.max_bones ?? ROBLOX_MAX_BONES)), r15: !!args.r15 });
  // materials v2 (extensions, packing, tangents, vertex colours, profiles) on the skinned scene, as on static exports
  scene.meshes = scene.meshes.map((m) => ({ ...m, groups: [...m.groups] }));
  const v2 = exportV2(def, built, args, { meshes: scene.meshes, nodes: scene.nodes, ext: null, scale, file, info: null, skinned: true });
  if (v2) scene.meshes = v2.meshes;
  const { glb, stats } = ctx.writeGLB(scene, { scale, up, name: def.name, extras: { skin: { bones: S.bones.length, clips: Object.keys(scene.clips), shapes: sk.morphNames, ...(roblox ? { profile: 'roblox' } : {}), ...(lodMeta.lods ? { lods: lodMeta.lods.levels.length } : {}) } }, ...bakeOpts, ...(v2 ? { ...v2.glbOpts, v2: v2.v2 } : {}) });
  const v = validateGLB(glb);
  if (!v.ok) throw new Error(`skinned glb failed validation: ${v.errors.slice(0, 4).join('; ')}`);
  if (v2) finishV2(v2, glb, stats);
  const f6 = (x) => +(+x).toFixed(6);
  const meta = {
    skin: {
      bones: S.bones.map((b) => ({ name: b.name, parent: b.parent, head: b.head.map((x) => f6(x / scale)), ...(b.limits ? { limits: b.limits } : {}) })),
      ik: Object.fromEntries(Object.entries(S.ik).map(([k, c]) => [k, c.bones])), clips: scene.clips, shapes: sk.morphNames,
      drivers: sk.drivers.map((d) => ({ shape: d.name, bone: d.bone, axis: d.axis, from: d.from, to: d.to })),
      weights: { method: sk.report.method, max_influences: sk.report.max_influences, unweighted: sk.report.unweighted, non_normalised: sk.report.non_normalised },
      validation: v.stats, ...(roblox ? { roblox } : {}), ...lodMeta,
      note: 'glTF skin: mesh node <name>_mesh (skin 0) at the scene root, joints = bone nodes under the armature node <name>; inverseBindMatrices = inverse rest world (units). three.js: GLTFLoader -> SkinnedMesh; AnimationMixer plays the clips (IK, plants, constraints and corrective-shape drivers are baked per frame). Shapes = morph targets on the skinned primitives (mesh.extras.targetNames); morph first, then skin.',
    },
  };
  return {
    glb, stats, built, info: null, rigClips: scene.clips, ctm: {}, ctmNames: [], v2,
    ext: { after() {}, meta, result: { skin: { bones: S.bones.length, joints_per_mesh: scene.skins.map((s) => s.joints.length), clips: Object.keys(scene.clips), shapes: sk.morphNames, validation: v.ok ? 'ok' : v.errors, ...(roblox ? { roblox: { meshes: roblox.meshes, warnings: roblox.warnings, renamed: roblox.renamed } } : {}), ...(lodMeta.lods ? { lods: lodMeta.lods.levels.map((L) => L.triangles), weight_transfer_max_px: lodMeta.lods.weight_transfer_max_px } : {}), ...(lodMeta.bake ? { bake: { pose: 'bind (rest)', ...(lodMeta.bake.size ? { size: lodMeta.bake.size } : {}) } } : {}) } } },
  };
}

// ---------- library ----------
const libFile = (engine, ...p) => path.join(engine.home, 'library', ...p);
function loadLib(engine, kind, ...names) {
  const f = libFile(engine, kind, ...names.slice(0, -1), `${names[names.length - 1]}.json`);
  if (!fs.existsSync(f)) return null;
  return JSON.parse(fs.readFileSync(f, 'utf8'));
}
function librarySkeleton(engine, name) {
  const sk = loadLib(engine, 'skeletons', name);
  if (!sk) throw new Error(`no art_anim skeleton "${name}" (art_anim skeleton {name:"${name}", template:"humanoid_hd", frame:[128,192]} first)`);
  return { sk, rig: normalizeRig({ ...sk.def, depth: undefined }) };
}

// ---------- ops ----------
const skelSummary = (S, extra = {}) => {
  const tree = (n) => Object.fromEntries(S.byName.get(n).children.map((c) => [c, tree(c)]));
  return {
    bones: S.bones.length, tree: Object.fromEntries(S.bones.filter((b) => !b.parent).map((b) => [b.name, tree(b.name)])),
    ik: Object.fromEntries(Object.entries(S.ik).map(([k, c]) => [k, c.bones])), constraints: S.constraints.length,
    poses: Object.keys(S.poses), clips: Object.fromEntries(Object.entries(S.clips).map(([k, c]) => [k, { duration: Number(c.duration ?? c.keys?.[c.keys.length - 1]?.t ?? 0), loop: !!c.loop, keys: c.keys?.length ?? 0 }])),
    sockets: Object.keys(S.spec.sockets || {}).map((k) => `socket_${k}`), ...extra,
  };
};
/** Summary block for create / update / info of a model with a skeleton. */
export function skeletonInfo(def) {
  try { return skelSummary(resolveSkeleton(def.skeleton), { skinned: !!def.skin }); } catch (e) { return { error: e.message }; }
}

/** Per-call context for skinnedOf / assembleSkinned from the modelops helpers. */
export const skinCtx = (base, engine, built) => ({ tex: built.tex, build: (d, o) => base.build(engine, d, o), variantOf: (def) => base.variantOf(engine, def), writeGLB: base.writeGLB });

export function skinOps(base) {
  const { getModel, saveModel, build } = base;
  return {
    /** skeleton {name, skeleton:{template|from_parts|library, fit?, height?, bones?, ik?, constraints?, sockets?, cable?} | null} */
    model_skeleton(a, source) {
      const def = getModel(this, a.name);
      if (a.skeleton === null || a.delete) {
        const next = { ...def }; delete next.skeleton; delete next.skin;
        saveModel(this, next, source, 'skeleton removed');
        return { model: def.name, skeleton: null, skin: null };
      }
      const spec = a.skeleton;
      if (!spec || typeof spec !== 'object') throw new Error(`skeleton needs skeleton:{template:${SKELETON_TEMPLATE_NAMES.join('|')}, fit?, height?} | {from_parts:true} | {library:"<art_anim skeleton>"} | {bones:{name:{parent?, head:[x,y,z], tail?, limits?}}} (+ ik?, constraints?, sockets?, cable?)`);
      const built = build(this, def);
      let partsRig = null, library = null;
      if (spec.from_parts) {
        const info = rigInfo(def, built, false);
        if (!info || !info.rigged) throw new Error('from_parts needs named parts (name / parent on parts make the rigid rig)');
        partsRig = bonesFromRig(info);
      }
      if (spec.library !== undefined) { const { rig } = librarySkeleton(this, spec.library); library = bonesFromLibrary(rig, solvePose, { height: Number(spec.height ?? 58) }); }
      const { skeleton, note } = expandSkeleton(spec, { bounds: built.mesh.bounds(), partsRig, library });
      // keep poses / clips / sockets the new bones still support
      const kept = [];
      for (const k of ['poses', 'clips', 'sockets']) if (spec[k] === undefined && def.skeleton?.[k]) skeleton[k] = def.skeleton[k];
      if (spec.sockets) skeleton.sockets = spec.sockets;
      for (const [k, s] of Object.entries(skeleton.sockets || {})) {
        if (!s || !skeleton.bones[s.bone] || !Array.isArray(s.at)) throw new Error(`sockets.${k} must be {bone, at:[x,y,z] model px, look?:[x,y,z]}`);
      }
      const S = resolveSkeleton(skeleton);
      for (const k of ['poses', 'clips']) for (const [n, c] of Object.entries(skeleton[k] || {})) {
        try { if (k === 'clips') skelClipKeys(S, c, shapeNames(def)); else boneOffsets(S, c); kept.push(n); } catch { delete skeleton[k][n]; }
      }
      let parts = def.parts, skin = def.skin;
      if (spec.cable) {
        // cable / hose helper: a tube swept through the chain's joints, auto (heat) weights
        const c = spec.cable === true ? {} : spec.cable;
        const chain = c.bones || S.ik[c.chain ?? 'chain']?.bones || S.bones.map((b) => b.name);
        for (const b of chain) if (!S.byName.has(b)) throw new Error(`cable.bones: "${b}" is not a bone`);
        const pts = chain.map((b) => S.byName.get(b).head);
        const last = S.byName.get(chain[chain.length - 1]);
        if (Math.hypot(...last.tail.map((v, k) => v - last.head[k])) > 0.5) pts.push(last.tail);
        const id = c.id ?? 'cable';
        const tube = { type: 'tube', id, path: pts.map((p) => p.map(r4)), r: Number(c.r ?? 1.5), sides: Math.round(Number(c.sides ?? 8)), texture: c.texture ?? '#3a3d42', curve: c.curve ?? 'catmull', segments: Math.round(Number(c.segments ?? 3)), ...(c.r_end !== undefined ? { r_end: Number(c.r_end) } : {}) };
        parts = [...def.parts.filter((p) => p && p.id !== id), tube];
        if (!skin) skin = { method: 'heat', smooth: 2 };
      }
      const next = { ...def, parts, skeleton };
      if (skin) next.skin = skin;
      if (next.skin) { const b2 = build(this, next); skinnedOf(skinCtx(base, this, b2), next, b2); }
      saveModel(this, next, source, `skeleton ${spec.template ?? (spec.from_parts ? 'from parts' : spec.library ? `library ${spec.library}` : 'bones')}`);
      return {
        model: def.name, note, skeleton: skelSummary(S), ...(kept.length ? { kept } : {}), ...(spec.cable ? { cable: parts[parts.length - 1].path.length + ' path points' } : {}),
        next: next.skin ? `art_model weights {name:"${def.name}"} checks the weights; animate {name, clip, keys:[{t, bones:{<bone>:{rot}}}]} or retarget:{skeleton, clip}` : `art_model skin {name:"${def.name}", skin:{method:"heat"|"distance"|"rigid", smooth?, blend?, paint?, shapes?}} binds the mesh`,
      };
    },
    /** skin {name, skin:{method?, parts?, rigid?, blend?, smooth?, falloff?, heat?, exclude?, subdivide?, paint?, shapes?} | null} */
    model_skin(a, source) {
      const def = getModel(this, a.name);
      if (!def.skeleton) throw new Error(`model "${def.name}" has no skeleton (art_model skeleton {name, skeleton:{template:"humanoid", fit:true}} first)`);
      if (a.skin === null || a.delete) { const next = { ...def }; delete next.skin; saveModel(this, next, source, 'skin removed'); return { model: def.name, skin: null }; }
      const spec = a.skin === undefined || a.skin === true ? {} : a.skin;
      if (typeof spec !== 'object' || Array.isArray(spec)) throw new Error('skin must be {method?, ...}');
      const next = { ...def, skin: spec };
      const built = build(this, next);
      const t0 = performance.now();
      const { S, sk } = skinnedOf(skinCtx(base, this, built), next, built);
      for (const [n, c] of Object.entries(S.clips)) { try { skelClipKeys(S, c, sk.morphNames); } catch (e) { throw new Error(`clip "${n}": ${e.message} (remove the morph from its keys or keep the shape)`); } }
      saveModel(this, next, source, `skin ${spec.method ?? 'heat'}`);
      return { model: def.name, weights: compactReport(sk.report), shapes: sk.morphNames, drivers: sk.drivers.map((d) => `${d.name} <- ${d.bone}.${d.axis} ${d.from}..${d.to} deg`), ms: Math.round(performance.now() - t0), next: `art_model weights {name:"${def.name}", bone:"<bone>"} = heat map; preview {name, clip|pose|bones}; export {name, profile?:"roblox"}` };
    },
    /** weights {name, bone?}: weights_check (unweighted, > 4 influences before pruning, non-normalised) + heat map of a bone. */
    model_weights(a) {
      const def = getModel(this, a.name);
      if (!isSkinned(def)) throw new Error(`model "${def.name}" is not skinned (skeleton + skin first)`);
      const built = build(this, def);
      const { S, sk } = skinnedOf(skinCtx(base, this, built), def, built);
      const r = sk.report;
      const out = {
        model: def.name, pass: r.ok, weights: compactReport(r),
        summary: r.ok ? `PASS: ${r.vertices} weight vertices, <= 4 influences, normalised${r.over_4_influences ? ` (${r.over_4_influences} pruned from > 4)` : ''}${r.unused_bones.length ? `; unused bones: ${r.unused_bones.join(', ')}` : ''}` : `FAIL: ${r.unweighted} unweighted, ${r.non_normalised} not normalised`,
      };
      if (a.bone) {
        const m = weightHeatMesh(S, sk, a.bone);
        const img = renderViews([...m.groups.values()].filter((g) => g.idx.length), { views: a.views || ['front', 'side'], size: a.size ?? 192 });
        out.image = encodePNG(img.width, img.height, img.data);
        out.bone = a.bone;
        out.legend = 'blue = 0, red = 1 (8 levels, per triangle)';
      }
      return out;
    },
  };
}
const compactReport = (r) => { const { per_bone, ...rest } = r; return { ...rest, per_bone: Object.fromEntries(Object.entries(per_bone).filter(([, v]) => v)) }; };
export { compactReport };

/** animate on a skinned model: keys (bones / pose / morphs / ik / targets) or retarget from an art_anim clip. */
export function skelAnimate(engine, ctx, def, a, source) {
  if (!/^[\w.-]{1,64}$/.test(a.clip || '')) throw new Error('animate needs a "clip" name');
  const skeleton = { ...def.skeleton, clips: { ...(def.skeleton.clips || {}) } };
  const S = resolveSkeleton(skeleton);
  let clip, report = {};
  if (a.keys === null || a.delete) {
    delete skeleton.clips[a.clip];
  } else {
    if (a.retarget) {
      const rt = a.retarget;
      const { sk, rig } = librarySkeleton(engine, rt.skeleton);
      const name2 = rt.clip ?? a.clip;
      const cache = new Map();
      const getClip = (n) => { if (!cache.has(n)) cache.set(n, loadLib(engine, 'clips', sk.name, n)); return cache.get(n); };
      const c2 = getClip(name2);
      if (!c2) throw new Error(`art_anim skeleton "${sk.name}" has no clip "${name2}"`);
      const ev = evalClip(rig, c2, getClip, sk);
      const r = retargetFrom2D(S, rig, solvePose, ev, { map: rt.map || {}, view: rt.view ?? 'side', scale: rt.scale });
      clip = r.clip;
      if (a.loop !== undefined) clip.loop = !!a.loop;
      const plant = a.plant ?? (c2.plant || c2.plant_feet ? true : undefined);
      if (plant && Object.keys(S.ik).some((c) => /^leg/.test(c))) clip.plant = plant;
      clip.retarget = { skeleton: sk.name, clip: name2, k: r.k };
      report = { retarget: { from: `${sk.name}/${name2}`, frames: ev.poses.length, fps: ev.fps, mapped: r.mapped.length, dropped: r.dropped, k: r.k } };
    } else {
      clip = { keys: a.keys };
      for (const k of ['loop', 'events', 'duration', 'ease', 'plant']) if (a[k] !== undefined && a[k] !== null) clip[k] = a[k];
    }
    if (a.events && a.retarget) clip.events = a.events;
    const ck = skelClipKeys(S, clip, shapeNames(def));
    skeleton.clips[a.clip] = clip;
    report = { ...report, duration: ck.duration, keys: ck.keys.length, loop: ck.loop, events: ck.events, ...(ck.plant ? { plant: ck.plant.chains } : {}) };
  }
  if (!Object.keys(skeleton.clips).length) delete skeleton.clips;
  ctx.saveModel(engine, { ...def, skeleton }, source, `skeleton clip ${a.clip}`);
  return { model: def.name, clip: a.clip, ...(clip ? report : { deleted: true }), clips: Object.keys(skeleton.clips || {}), next: `art_model preview {name:"${def.name}", clip:"${a.clip}", frames:6} to check it; render {name, clip, sweep:{yaw:[0,315,45]}} = 8-direction sprites; export = glTF animation` };
}

/** pose on a skinned model: named bone offsets. */
export function skelPose(engine, ctx, def, a, source) {
  if (!/^[\w.-]{1,64}$/.test(a.pose || '')) throw new Error('pose needs a "pose" name');
  const skeleton = { ...def.skeleton, poses: { ...(def.skeleton.poses || {}) } };
  const S = resolveSkeleton(skeleton);
  if ((a.bones ?? a.parts) === null || a.delete) delete skeleton.poses[a.pose];
  else {
    const bones = a.bones ?? a.parts;
    if (!bones || typeof bones !== 'object') throw new Error('pose needs bones:{<bone>:{rot?, at?, scale?}}');
    boneOffsets(S, { bones });
    skeleton.poses[a.pose] = { bones };
  }
  ctx.saveModel(engine, { ...def, skeleton }, source, `skeleton pose ${a.pose}`);
  return { model: def.name, pose: a.pose, poses: Object.keys(skeleton.poses), bones: S.bones.map((b) => b.name) };
}

export { validateGLB };
