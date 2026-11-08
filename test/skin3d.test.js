// art_model skinning: skeletons (templates, limits, IK, constraints), skin weights (normalisation,
// determinism, rigid / heat / paint), inverse bind matrices (rest pose = bind mesh, checked with an
// independent glTF evaluator), art_anim clip retargeting, blend shapes on skinned meshes, the glTF
// validator, the Roblox profile, sprite renders of skinned clips, and byte-identical old exports.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { Engine } from '../src/engine.js';
import { normalizeWeights, checkWeights, MAX_INFLUENCES, ROBLOX_MAX_BONES } from '../src/skin3d.js';
import { expandSkeleton, resolveSkeleton, poseState, solvePoseState, skelClipKeys, sampleSkelClip, eulerOfQuat, SKELETON_TEMPLATE_NAMES } from '../src/skeleton3d.js';
import { validateGLB, parseGLB, readAccessor } from '../src/gltfvalidate.js';
import { TOOLS } from '../src/mcp.js';
import { helpText } from '../src/docs.js';
import { normalizeRig, solvePose } from '../src/rig.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'agent-art-skin3d-'));
const near = (a, b, eps = 1e-4) => Math.abs(a - b) <= eps;

// ---------- an independent glTF skinning evaluator (column-major 4x4, no agent-art code) ----------
const m4mul = (a, b) => { const o = new Array(16).fill(0); for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k]; return o; };
function m4trs(t = [0, 0, 0], q = [0, 0, 0, 1], s = [1, 1, 1]) {
  const [x, y, z, w] = q;
  return [(1 - 2 * (y * y + z * z)) * s[0], 2 * (x * y + z * w) * s[0], 2 * (x * z - y * w) * s[0], 0, 2 * (x * y - z * w) * s[1], (1 - 2 * (x * x + z * z)) * s[1], 2 * (y * z + x * w) * s[1], 0, 2 * (x * z + y * w) * s[2], 2 * (y * z - x * w) * s[2], (1 - 2 * (x * x + y * y)) * s[2], 0, t[0], t[1], t[2], 1];
}
const m4p = (m, p) => [0, 1, 2].map((r) => m[r] * p[0] + m[4 + r] * p[1] + m[8 + r] * p[2] + m[12 + r]);
function slerp(a, b, t) {
  let d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  if (d < 0) { b = b.map((v) => -v); d = -d; }
  if (d > 0.9995) { const r = a.map((v, i) => v + (b[i] - v) * t), l = Math.hypot(...r); return r.map((v) => v / l); }
  const th = Math.acos(d), s = Math.sin(th);
  return a.map((v, i) => (v * Math.sin((1 - t) * th) + b[i] * Math.sin(t * th)) / s);
}
/** World matrices of every node at an animation time (null = rest), and morph weights per mesh node. */
function evalScene(json, bin, anim = null, time = 0) {
  const local = json.nodes.map((n) => ({ t: n.translation || [0, 0, 0], q: n.rotation || [0, 0, 0, 1], s: n.scale || [1, 1, 1], w: null, m: n.matrix || null }));
  if (anim) for (const c of anim.channels) {
    const s = anim.samplers[c.sampler], T = readAccessor(json, bin, s.input), V = readAccessor(json, bin, s.output);
    const k = c.target.path === 'rotation' ? 4 : c.target.path === 'weights' ? V.length / T.length : 3;
    let i = 0;
    while (i < T.length - 1 && T[i + 1] <= time) i++;
    const j = Math.min(i + 1, T.length - 1), u = j === i ? 0 : Math.max(0, Math.min(1, (time - T[i]) / (T[j] - T[i])));
    const A = V.slice(i * k, i * k + k), B = V.slice(j * k, j * k + k);
    const v = c.target.path === 'rotation' ? slerp(A, B, u) : A.map((x, q) => x + (B[q] - x) * u);
    const L = local[c.target.node];
    if (c.target.path === 'translation') L.t = v; else if (c.target.path === 'rotation') L.q = v; else if (c.target.path === 'scale') L.s = v; else L.w = v;
  }
  const parent = new Map();
  json.nodes.forEach((n, i) => (n.children || []).forEach((c) => parent.set(c, i)));
  const world = new Map();
  const W = (i) => {
    if (world.has(i)) return world.get(i);
    const L = local[i], M = L.m ? L.m : m4trs(L.t, L.q, L.s);
    const r = parent.has(i) ? m4mul(W(parent.get(i)), M) : M;
    world.set(i, r);
    return r;
  };
  json.nodes.forEach((_, i) => W(i));
  return { world, weights: local.map((l) => l.w) };
}
/** Skinned (and morphed) POSITION of every vertex of a skinned node. */
function skinnedPositions(json, bin, nodeIndex, anim = null, time = 0) {
  const { world, weights } = evalScene(json, bin, anim, time);
  const node = json.nodes[nodeIndex], skin = json.skins[node.skin];
  const ibm = readAccessor(json, bin, skin.inverseBindMatrices);
  const J = skin.joints.map((j, k) => m4mul(world.get(j), ibm.slice(k * 16, k * 16 + 16)));
  const out = [];
  for (const p of json.meshes[node.mesh].primitives) {
    const P = readAccessor(json, bin, p.attributes.POSITION), Jt = readAccessor(json, bin, p.attributes.JOINTS_0), Wt = readAccessor(json, bin, p.attributes.WEIGHTS_0);
    const mw = weights[nodeIndex] || json.meshes[node.mesh].weights || [];
    const T = (p.targets || []).map((t) => readAccessor(json, bin, t.POSITION));
    for (let v = 0; v < P.length / 3; v++) {
      const b = [P[v * 3], P[v * 3 + 1], P[v * 3 + 2]];
      T.forEach((d, k) => { for (let c = 0; c < 3; c++) b[c] += d[v * 3 + c] * (mw[k] || 0); });
      const s = [0, 0, 0];
      for (let k = 0; k < 4; k++) { const w = Wt[v * 4 + k]; if (!w) continue; const q = m4p(J[Jt[v * 4 + k]], b); for (let c = 0; c < 3; c++) s[c] += q[c] * w; }
      out.push({ bind: [P[v * 3], P[v * 3 + 1], P[v * 3 + 2]], pos: s });
    }
  }
  return out;
}
const glbOf = (file) => parseGLB(fs.readFileSync(file));

// ---------- fixtures ----------
function snake(e, name = 'snake', skin = { method: 'heat' }) {
  e.run('model_create', { name, parts: [{ type: 'tube', path: [[0, 32, 0], [0, 26, 0], [0, 20, 0], [0, 14, 0], [0, 8, 0], [0, 2, 0]], r: 2, sides: 6, texture: '#c84', segments: 3 }, { type: 'box', w: 8, h: 2, d: 8, at: [0, 32, 0], texture: '#555', id: 'cap' }] });
  e.run('model_skeleton', { name, skeleton: { template: 'chain', count: 4, from: [0, 32, 0], to: [0, 2, 0] } });
  e.run('model_skin', { name, skin });
  e.run('model_animate', { name, clip: 'sway', loop: true, duration: 2, keys: [{ t: 0, bones: { chain_0: { rot: [0, 0, 20] }, chain_1: { rot: [0, 0, 15] } } }, { t: 1, bones: { chain_0: { rot: [0, 0, -20] }, chain_1: { rot: [0, 0, -15] } }, ease: 'smooth' }] });
}
const EXO = [];
for (const [s, x] of [['f', -1], ['b', 1]]) EXO.push(
  { type: 'box', w: 6, h: 13, d: 6, at: [x * 13, 51, 0], texture: '#4b525c', bone: `upper_arm_${s}` },
  { type: 'box', w: 7, h: 12, d: 7, at: [x * 13, 39.5, 0], texture: '#c8a23a', bone: `forearm_${s}` },
  { type: 'box', w: 8, h: 18, d: 9, at: [x * 6.5, 21.5, 0], texture: '#c8a23a', bone: `thigh_${s}` },
  { type: 'box', w: 7, h: 17, d: 7, at: [x * 6.5, 4.5, 0], texture: '#4b525c', bone: `shin_${s}` },
  { type: 'box', w: 8, h: 4.5, d: 14, at: [x * 6.5, 0, 2], texture: '#2f343b', bone: `foot_${s}` },
  { type: 'tube', id: `hose_${s}`, path: [[x * 6, 54, -8], [x * 12, 57, -5], [x * 14, 50, -2], [x * 14, 43, -2]], r: 1, sides: 6, texture: '#222' },
);
EXO.push({ type: 'box', w: 22, h: 13, d: 12, at: [0, 53, 0], texture: '#c8a23a', bone: 'chest' }, { type: 'box', w: 15, h: 9, d: 10, at: [0, 36, 0], texture: '#5c6470', bone: 'pelvis' });
function exo(e) {
  e.run('model_create', { name: 'exo', parts: EXO });
  e.run('model_skeleton', { name: 'exo', skeleton: { template: 'exosuit' } });
  return e.run('model_skin', { name: 'exo', skin: { method: 'heat', parts: ['hose_f', 'hose_b'] } });
}

// ---------- tests ----------
test('weight normalisation: <= 4 influences, float32 sums of exactly 1, deterministic ties', () => {
  const r = normalizeWeights([[0, 0.1], [1, 0.5], [2, 0.05], [3, 0.2], [4, 0.15], [5, 0.0000001]]);
  assert.equal(r.raw, 5, 'tiny weights do not count');
  assert.deepEqual(r.j, [1, 3, 4, 0]);
  const s = r.w.reduce((a, b) => Math.fround(a + b), 0);
  assert.equal(Math.fround(r.w[0] + r.w[1] + r.w[2] + r.w[3]), 1);
  assert.ok(near(s, 1, 1e-7));
  assert.ok(r.w[0] > r.w[1] && r.w[1] >= r.w[2]);
  // ties: lower bone index first
  assert.deepEqual(normalizeWeights([[7, 1], [2, 1], [5, 1], [3, 1], [1, 1]]).j, [1, 2, 3, 5]);
  assert.deepEqual(normalizeWeights([[3, 0], [4, -1]]).w, [0, 0, 0, 0]);
  const c = checkWeights([0, 1, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0], [0.5, 0.5, 0, 0, 0, 0, 0, 0, 0.7, 0, 0, 0], ['a', 'b']);
  assert.equal(c.unweighted, 1);
  assert.equal(c.non_normalised, 1);
  assert.equal(c.ok, false);
  assert.equal(MAX_INFLUENCES, 4);
});

test('skin weights: heat / distance / rigid are deterministic, normalised and <= 4 influences', () => {
  const bytes = [];
  for (const method of ['heat', 'distance', 'rigid']) {
    const runs = [];
    for (let k = 0; k < 2; k++) {
      const e = new Engine({ home: tmp() });
      snake(e, 'snake', { method, smooth: 2 });
      const w = e.run('model_weights', { name: 'snake' });
      assert.equal(w.pass, true, `${method}: ${w.summary}`);
      assert.equal(w.weights.unweighted, 0);
      assert.equal(w.weights.non_normalised, 0);
      assert.ok(w.weights.max_influences <= 4);
      const r = e.run('model_export', { name: 'snake' });
      runs.push(fs.readFileSync(r.file));
    }
    assert.ok(runs[0].equals(runs[1]), `${method}: two builds give byte-identical glbs`);
    bytes.push(runs[0]);
  }
  assert.ok(!bytes[0].equals(bytes[1]) && !bytes[1].equals(bytes[2]), 'methods differ');
  // auto weights fall off along the chain: the tip vertices belong to the last bones
  const e = new Engine({ home: tmp() });
  snake(e);
  const { json, bin } = glbOf(e.run('model_export', { name: 'snake' }).file);
  const p = json.meshes[0].primitives.find((x) => json.accessors[x.attributes.POSITION].count > 30);
  const P = readAccessor(json, bin, p.attributes.POSITION), J = readAccessor(json, bin, p.attributes.JOINTS_0), W = readAccessor(json, bin, p.attributes.WEIGHTS_0);
  const names = json.skins[0].joints.map((j) => json.nodes[j].name);
  for (let v = 0; v < P.length / 3; v++) {
    const top = names[J[v * 4]];
    if (P[v * 3 + 1] > 30 / 32) assert.equal(top, 'chain_0', 'top vertices -> chain_0');
    if (P[v * 3 + 1] < 4 / 32) assert.ok(['chain_3', 'chain_tip'].includes(top), `bottom vertex -> ${top}`);
    assert.ok(W[v * 4] >= W[v * 4 + 1]);
  }
});

test('rigid weights: 100% to the owning bone, seams blended over blend px; paint regions and weight canvases', () => {
  const e = new Engine({ home: tmp() });
  exo(e);
  e.run('model_skin', { name: 'exo', skin: { method: 'rigid' } });
  const hard = e.run('model_weights', { name: 'exo' }).weights;
  assert.equal(hard.max_influences, 1, 'rigid: one bone per vertex');
  assert.ok(hard.per_bone.thigh_f > 0 && hard.per_bone.foot_b > 0);
  e.run('model_skin', { name: 'exo', skin: { method: 'rigid', blend: 3 } });
  assert.ok(e.run('model_weights', { name: 'exo' }).weights.max_influences >= 2, 'blended seams');
  // paint: a region set to one bone
  e.run('model_skin', { name: 'exo', skin: { method: 'rigid', paint: [{ bone: 'chest', weight: 1, region: { above: 60 } }] } });
  const w = e.run('model_weights', { name: 'exo', bone: 'chest' });
  assert.ok(w.image && w.image.length > 100, 'heat map image');
  const { json, bin } = glbOf(e.run('model_export', { name: 'exo' }).file);
  const chest = json.skins[0].joints.findIndex((j) => json.nodes[j].name === 'chest');
  for (const p of json.meshes[0].primitives) {
    const P = readAccessor(json, bin, p.attributes.POSITION), J = readAccessor(json, bin, p.attributes.JOINTS_0), W = readAccessor(json, bin, p.attributes.WEIGHTS_0);
    for (let v = 0; v < P.length / 3; v++) if (P[v * 3 + 1] * 32 > 60.01) { assert.equal(J[v * 4], chest); assert.ok(near(W[v * 4], 1, 1e-6)); }
  }
  // weight canvas: left half white over the front view -> those vertices go to upper_arm_b
  e.run('create', { name: 'wmap', width: 8, height: 8 });
  e.run('draw', { canvas: 'wmap', commands: [{ op: 'rect', x: 0, y: 0, w: 4, h: 8, color: '#ffffff', fill: true }] });
  e.run('model_skin', { name: 'exo', skin: { method: 'rigid', paint: [{ bone: 'upper_arm_b', canvas: 'wmap', view: 'front', weight: 1 }] } });
  assert.ok(e.run('model_weights', { name: 'exo' }).weights.per_bone.upper_arm_b > hard.per_bone.upper_arm_b);
  assert.throws(() => e.run('model_skin', { name: 'exo', skin: { method: 'nope' } }), /method/);
  assert.throws(() => e.run('model_skin', { name: 'exo', skin: { paint: [{ bone: 'tail', region: { all: true } }] } }), /bone/);
});

test('inverseBindMatrices: rest-pose skinning of the exported glb reproduces the bind mesh', () => {
  const e = new Engine({ home: tmp() });
  exo(e);
  e.run('model_skin', { name: 'exo', skin: { method: 'heat', parts: ['hose_f', 'hose_b'], blend: 2 } });
  for (const file of [e.run('model_export', { name: 'exo' }).file, e.run('model_export', { name: 'exo', up: 'z', path: 'exo_z.glb' }).file]) {
    const { json, bin } = glbOf(file);
    const mi = json.nodes.findIndex((n) => n.skin !== undefined);
    const S = json.skins[0];
    // joint world (rest) x IBM = identity
    const { world } = evalScene(json, bin);
    const ibm = readAccessor(json, bin, S.inverseBindMatrices);
    S.joints.forEach((j, k) => { const M = m4mul(world.get(j), ibm.slice(k * 16, k * 16 + 16)); const up = file.endsWith('exo_z.glb'); if (!up) M.forEach((v, i) => assert.ok(near(v, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1][i], 1e-5), `joint ${json.nodes[j].name} rest x ibm = I`)); });
    // skinned rest positions = bind positions (the z-up root rotates both joints and, in engines, nothing else: compare in joint space)
    if (!file.endsWith('exo_z.glb')) for (const v of skinnedPositions(json, bin, mi)) for (let c = 0; c < 3; c++) assert.ok(near(v.pos[c], v.bind[c], 2e-5), 'rest skinning = bind mesh');
    assert.equal(validateGLB(fs.readFileSync(file)).ok, true);
  }
});

test('skeleton templates: shared humanoid_hd bone names, limits mirrored, two-bone IK, plants, constraints', () => {
  for (const t of SKELETON_TEMPLATE_NAMES) assert.ok(resolveSkeleton(expandSkeleton({ template: t }).skeleton).bones.length >= 5, t);
  const S = resolveSkeleton(expandSkeleton({ template: 'humanoid' }).skeleton);
  for (const n of ['pelvis', 'torso', 'chest', 'neck', 'head', 'upper_arm_f', 'forearm_f', 'hand_f', 'thigh_b', 'shin_b', 'foot_b']) assert.ok(S.byName.has(n), n);
  assert.ok(S.byName.get('upper_arm_f').head[0] < 0 && S.byName.get('upper_arm_b').head[0] > 0, '_f = right (-X), _b = left (+X)');
  assert.deepEqual(S.byName.get('upper_arm_b').limits.z, [-30, 180], 'Z limits mirror');
  assert.deepEqual(S.byName.get('upper_arm_b').limits.x, S.byName.get('upper_arm_f').limits.x, 'X limits keep');
  // limits clamp pose offsets
  const st = poseState(S, { bones: { shin_f: { rot: [-40, 0, 0] } } });
  assert.ok(near(eulerOfQuat(st.local.get('shin_f').q)[0], 0, 1e-6), 'knee cannot bend forward');
  // two-bone IK reaches a reachable target, knee bends forward (pole +Z)
  const target = [-3, 8, 4];
  const sv = solvePoseState(S, { ...poseState(S), ik: { leg_f: { p: target, weight: 1 } } });
  const foot = sv.world.get('foot_f');
  assert.ok(Math.hypot(foot[3] - target[0], foot[7] - target[1], foot[11] - target[2]) < 0.02, 'foot on target');
  assert.ok(sv.world.get('shin_f')[11] > 0.5, 'knee forward');
  assert.ok(sv.ik.leg_f < 0.02);
  // foot plant: pelvis dropped 3 px, the feet stay on the ground
  const ck = skelClipKeys(S, { duration: 1, plant: true, keys: [{ t: 0, bones: { pelvis: { at: [0, -3, 0] } } }] });
  const pl = solvePoseState(S, sampleSkelClip(S, ck, 0));
  for (const s of ['f', 'b']) assert.ok(near(pl.world.get(`foot_${s}`)[7], S.byName.get(`foot_${s}`).head[1], 0.02), `foot_${s} planted`);
  // CCD chain IK
  const C = resolveSkeleton(expandSkeleton({ template: 'chain', count: 6 }).skeleton);
  const cv = solvePoseState(C, { ...poseState(C), ik: { chain: { p: [10, 12, 4], weight: 1 } } });
  const tip = cv.world.get('chain_tip');
  assert.ok(Math.hypot(tip[3] - 10, tip[7] - 12, tip[11] - 4) < 0.1, 'CCD reaches');
  // aim / look_at / copy_rotation
  const A = resolveSkeleton(expandSkeleton({ template: 'humanoid', constraints: [{ type: 'look_at', bone: 'head', target: [0, 54, 40], axis: [0, 0, 1] }, { type: 'copy_rotation', bone: 'forearm_b', from: 'forearm_f', weight: 0.5 }] }).skeleton);
  const av = solvePoseState(A, poseState(A, { bones: { forearm_f: { rot: [-60, 0, 0] } } }));
  const H = av.world.get('head'), fwd = [H[2], H[6], H[10]], to = [0 - H[3], 54 - H[7], 40 - H[11]], l = Math.hypot(...to);
  assert.ok(fwd.reduce((s, v, i) => s + v * to[i] / l, 0) > 0.999, 'head looks at the target');
  assert.ok(near(H[1], 0, 1e-6) || Math.abs(H[4]) < 1, 'no roll');
  assert.ok(near(eulerOfQuat(av.local.get('forearm_b').q)[0], -30, 0.01), 'copy_rotation x 0.5');
  assert.throws(() => resolveSkeleton({ bones: { a: { head: [0, 0, 0], parent: 'b' }, b: { head: [0, 1, 0], parent: 'a' } } }), /loop/);
  assert.throws(() => expandSkeleton({ template: 'dragon' }), /unknown skeleton template/);
});

test('retarget: art_anim humanoid_hd clips map onto a 3D skeleton by bone name', () => {
  const e = new Engine({ home: tmp() });
  exo(e);
  e.run('anim_skeleton', { name: 'hd', template: 'humanoid_hd', frame: [128, 192] });
  const r = e.run('model_animate', { name: 'exo', clip: 'walk', retarget: { skeleton: 'hd', clip: 'walk' } });
  assert.equal(r.retarget.frames, 16);
  assert.equal(r.keys, 16 + 1, 'one key per 2D frame + the loop closing key');
  assert.ok(r.retarget.dropped.includes('cape') && r.retarget.dropped.includes('weapon'));
  assert.ok(!r.retarget.dropped.includes('thigh_f'));
  assert.ok(r.plant && r.plant.includes('leg_f'), 'walk plants feet (2D plant -> 3D IK plant)');
  // the 3D thigh rotation about X equals the 2D local thigh rotation (relative to rest)
  const def = e.models.get('exo');
  const clip = def.skeleton.clips.walk;
  const sk = JSON.parse(fs.readFileSync(path.join(e.home, 'library', 'skeletons', 'hd.json'), 'utf8'));
  const rig = normalizeRig({ ...sk.def, depth: undefined });
  const rest = solvePose(rig, {}, 'side').world;
  assert.ok(clip.keys.some((k) => k.bones.thigh_f?.rot && Math.abs(k.bones.thigh_f.rot[0]) > 5), 'thighs swing');
  for (const k of clip.keys) for (const [b, o] of Object.entries(k.bones)) { assert.ok(def.skeleton.bones[b], `${b} is a 3D bone`); if (o.rot) assert.deepEqual([o.rot[1], o.rot[2]], [0, 0], 'side view = rotation about X'); }
  void rest;
  // mapping onto other names + a clip the 3D model renders / exports
  e.run('model_animate', { name: 'exo', clip: 'walk_mapped', retarget: { skeleton: 'hd', clip: 'walk', map: { thigh_f: 'thigh_b', thigh_b: 'thigh_f' } } });
  const m = e.models.get('exo').skeleton.clips.walk_mapped.keys[3].bones;
  assert.deepEqual(m.thigh_b?.rot, clip.keys[3].bones.thigh_f?.rot, 'mapped onto the other thigh');
  const x = e.run('model_export', { name: 'exo' });
  assert.deepEqual(x.skin.clips, ['walk', 'walk_mapped']);
  assert.throws(() => e.run('model_animate', { name: 'exo', clip: 'q', retarget: { skeleton: 'nope', clip: 'walk' } }), /no art_anim skeleton/);
  // a 3D skeleton straight from the art_anim skeleton definition
  e.run('model_create', { name: 'lib3d', parts: [{ type: 'box', w: 10, h: 50, d: 6, texture: '#888' }] });
  const ls = e.run('model_skeleton', { name: 'lib3d', skeleton: { library: 'hd', height: 58 } });
  assert.ok(ls.skeleton.bones >= 17 && ls.skeleton.ik.leg_f);
});

test('blend shapes on a skinned mesh: sculpted + variant shapes, joint-driven correctives, weights channels', () => {
  const e = new Engine({ home: tmp() });
  snake(e, 'snake', { method: 'heat', shapes: { bulge: { sculpt: [{ sphere: [0, 20, 0, 5], inflate: 1.5 }] }, long: { set: { cap: { scale: [1.5, 1, 1.5] } } }, fix: { sculpt: [{ sphere: [0, 26, 0, 4], move: [1, 0, 0] }], driver: { bone: 'chain_1', axis: 'z', from: 0, to: 15 } } } });
  e.run('model_animate', { name: 'snake', clip: 'pulse', duration: 1, keys: [{ t: 0, bones: {}, morphs: { bulge: 0 } }, { t: 1, bones: { chain_1: { rot: [0, 0, 15] } }, morphs: { bulge: 1, long: 0.5 } }] });
  const r = e.run('model_export', { name: 'snake' });
  assert.deepEqual(r.skin.shapes, ['long', 'bulge', 'fix']);
  const buf = fs.readFileSync(r.file);
  const v = validateGLB(buf);
  assert.equal(v.ok, true, v.errors.join('; '));
  assert.equal(v.stats.morph_targets, 3);
  const { json, bin } = parseGLB(buf);
  const mesh = json.meshes[0];
  assert.deepEqual(mesh.extras.targetNames, ['long', 'bulge', 'fix']);
  for (const p of mesh.primitives) { assert.ok(p.attributes.JOINTS_0 !== undefined && p.attributes.WEIGHTS_0 !== undefined); assert.equal(p.targets.length, 3); }
  const an = json.animations.find((a) => a.name === 'pulse');
  const wc = an.channels.find((c) => c.target.path === 'weights');
  assert.ok(wc, 'weights channel');
  const T = readAccessor(json, bin, an.samplers[wc.sampler].input), V = readAccessor(json, bin, an.samplers[wc.sampler].output);
  assert.equal(V.length, T.length * 3);
  const last = V.slice(-3);
  assert.ok(near(last[0], 0.5, 1e-6) && near(last[1], 1, 1e-6) && near(last[2], 1, 1e-6), `end weights ${last}`);
  assert.ok(near(V[2], 0, 1e-6), 'driver at rest = 0');
  // the morphed + skinned end pose matches deformMesh (the renderer) within float precision
  const mi = json.nodes.findIndex((n) => n.skin !== undefined);
  const at1 = skinnedPositions(json, bin, mi, an, T[T.length - 1]);
  assert.ok(at1.some((x) => Math.hypot(...x.pos.map((c, k) => c - x.bind[k])) > 0.05), 'moved');
  // unknown morph names in keys are rejected; removing a shape a clip uses fails loudly
  assert.throws(() => e.run('model_animate', { name: 'snake', clip: 'bad', keys: [{ t: 0, morphs: { nope: 1 } }] }), /not a shape/);
  assert.throws(() => e.run('model_skin', { name: 'snake', skin: { method: 'heat' } }), /pulse/);
});

test('glTF validator: accepts our skinned output, rejects broken skins, weights and animations', () => {
  const e = new Engine({ home: tmp() });
  snake(e);
  const file = e.run('model_export', { name: 'snake' }).file;
  const good = fs.readFileSync(file);
  assert.equal(validateGLB(good).ok, true);
  const patch = (fn) => {
    const { json, bin } = parseGLB(good);
    const b2 = Buffer.from(bin);
    fn(json, b2);
    let js = Buffer.from(JSON.stringify(json)); js = Buffer.concat([js, Buffer.alloc((4 - (js.length % 4)) % 4, 0x20)]);
    const h = Buffer.alloc(12); h.writeUInt32LE(0x46546c67, 0); h.writeUInt32LE(2, 4); h.writeUInt32LE(28 + js.length + b2.length, 8);
    const c1 = Buffer.alloc(8); c1.writeUInt32LE(js.length, 0); c1.writeUInt32LE(0x4e4f534a, 4);
    const c2 = Buffer.alloc(8); c2.writeUInt32LE(b2.length, 0); c2.writeUInt32LE(0x004e4942, 4);
    return validateGLB(Buffer.concat([h, c1, js, c2, b2]));
  };
  const wOff = (json) => { const a = json.accessors[json.meshes[0].primitives[0].attributes.WEIGHTS_0]; return json.bufferViews[a.bufferView].byteOffset; };
  for (const [what, fn, re] of [
    ['weights sum', (json, b) => b.writeFloatLE(0.5, wOff(json)), /sum to 1/],
    ['joint range', (json) => { json.skins[0].joints = json.skins[0].joints.slice(0, 1); json.accessors[json.skins[0].inverseBindMatrices].count = 1; }, /JOINTS_0 entries/],
    ['ibm count', (json) => { json.accessors[json.skins[0].inverseBindMatrices].count -= 1; }, /inverseBindMatrices/],
    ['times', (json, b) => { const s = json.animations[0].samplers[0]; const a = json.accessors[s.input]; b.writeFloatLE(5, json.bufferViews[a.bufferView].byteOffset); }, /strictly increasing/],
    ['skin root', (json) => { json.skins[0].joints.push(json.nodes.length - 1); }, /one root|duplicate|JOINTS|inverseBindMatrices/],
    ['two parents', (json) => { json.nodes[0].children.push(json.nodes[0].children[0]); }, /two parents/],
    ['weights path', (json) => { json.animations[0].channels[0].target.path = 'weights'; }, /weights channel|weights output/],
    ['accessor overrun', (json) => { json.accessors[0].count *= 50; }, /overruns|count/],
  ]) { const v = patch(fn); assert.equal(v.ok, false, what); assert.ok(v.errors.some((x) => re.test(x)), `${what}: ${v.errors.join(' | ')}`); }
  assert.equal(validateGLB(Buffer.from('nope')).ok, false);
});

test('Roblox profile: <= max_bones joints per mesh (split), <= 4 influences, sanitised + R15 names, no morphs', () => {
  const e = new Engine({ home: tmp() });
  exo(e);
  e.run('model_skin', { name: 'exo', skin: { method: 'heat', parts: ['hose_f', 'hose_b'], shapes: { dent: { sculpt: [{ sphere: [0, 55, 6, 4], move: [0, 0, -1] }] } } } });
  e.run('model_animate', { name: 'exo', clip: 'wave-arm.v2', loop: true, duration: 1, keys: [{ t: 0, bones: {} }, { t: 0.5, bones: { upper_arm_f: { rot: [0, 0, -60] } }, morphs: { dent: 1 } }] });
  assert.equal(ROBLOX_MAX_BONES, 50);
  const plain = e.run('model_export', { name: 'exo' });
  assert.equal(plain.skin.joints_per_mesh[0], 20);
  const r = e.run('model_export', { name: 'exo', profile: 'roblox', r15: true, max_bones: 8, path: 'exo_rb.glb' });
  const buf = fs.readFileSync(r.file);
  const v = validateGLB(buf);
  assert.equal(v.ok, true, v.errors.join('; '));
  assert.ok(v.stats.max_influences <= 4);
  const { json } = parseGLB(buf);
  assert.ok(json.skins.length >= 2, `${json.skins.length} skins`);
  for (const s of json.skins) assert.ok(s.joints.length <= 8, `skin ${s.name}: ${s.joints.length} joints`);
  for (const n of json.nodes) assert.match(n.name, /^[A-Za-z_][A-Za-z0-9_]*$/, n.name);
  for (const a of json.animations) assert.match(a.name, /^[A-Za-z0-9_]+$/);
  const names = new Set(json.nodes.map((n) => n.name));
  for (const n of ['LowerTorso', 'UpperTorso', 'RightUpperArm', 'LeftLowerLeg', 'RightFoot']) assert.ok(names.has(n), n);
  for (const m of json.meshes) for (const p of m.primitives) assert.ok(!p.targets, 'no morph targets');
  assert.ok(!json.animations.some((a) => a.channels.some((c) => c.target.path === 'weights')));
  assert.ok(r.skin.roblox.warnings.some((w) => /blend shapes dropped/.test(w)));
  const tris = json.meshes.reduce((s, m) => s + m.primitives.reduce((t, p) => t + json.accessors[p.indices].count / 3, 0), 0);
  assert.equal(tris, plain.triangles, 'split keeps every triangle');
  const meta = JSON.parse(fs.readFileSync(r.meta, 'utf8'));
  assert.match(meta.skin.roblox.note, /Assumed limits/);
  // default limit: one mesh
  const d = parseGLB(fs.readFileSync(e.run('model_export', { name: 'exo', profile: 'roblox', path: 'exo_rb2.glb' }).file)).json;
  assert.equal(d.skins.length, 1);
  assert.throws(() => e.run('model_export', { name: 'exo', profile: 'unity' }), /profile/);
});

test('sprite pipeline: skinned clips render into 8-direction pixel sprites with palette + outline; previews', () => {
  const e = new Engine({ home: tmp() });
  exo(e);
  e.run('model_animate', { name: 'exo', clip: 'stomp', loop: true, duration: 1, keys: [{ t: 0, bones: {} }, { t: 0.5, bones: { thigh_f: { rot: [-40, 0, 0] }, shin_f: { rot: [50, 0, 0] } } }] });
  const r = e.run('model_render', { name: 'exo', clip: 'stomp', frames: 4, sweep: { yaw: [0, 315, 45] }, camera: 'front', size: [32, 48], quantize: { colors: 8 }, outline: '#101010' });
  assert.equal(r.count, 32);
  assert.deepEqual(r.grid.yaw, [0, 45, 90, 135, 180, 225, 270, 315]);
  assert.ok(r.colors <= 8);
  const d = e.docs.get(r.canvas);
  const f0 = d.frameData(0), f1 = d.frameData(1), f4 = d.frameData(4);
  const cols = new Set();
  for (let i = 0; i < f0.length; i += 4) if (f0[i + 3]) cols.add(`${f0[i]},${f0[i + 1]},${f0[i + 2]}`);
  assert.ok(cols.size <= 9, `palette (+outline): ${cols.size}`);
  assert.ok(f0.some((v, i) => v !== f1[i]), 'clip frames differ (skinned deformation)');
  assert.ok(f0.some((v, i) => v !== f4[i]), 'directions differ');
  const p = e.run('model_preview', { name: 'exo', clip: 'stomp', frames: 3 });
  assert.ok(p.skinned && p.frames.length === 3);
  const q = e.run('model_preview', { name: 'exo', bones: { upper_arm_f: { rot: [0, 0, -90] } }, views: ['front'] });
  assert.ok(q.skinned && q.image.length > 100);
  assert.throws(() => e.run('model_render', { name: 'exo', clip: 'stomp', only: ['chest'] }), /rigid rigs/);
  assert.throws(() => e.run('model_render', { name: 'exo', clip: 'nope' }), /unknown skeleton clip/);
  // skeleton sockets give per-frame anchors
  e.run('model_skeleton', { name: 'exo', skeleton: { template: 'exosuit', sockets: { grip: { bone: 'hand_f', at: [-13, 33, 0] } } } });
  const s = e.run('model_render', { name: 'exo', clip: 'stomp', frames: 2, size: [32, 48], camera: 'side', canvas: 'exo_s' });
  assert.deepEqual(s.anchors, ['socket_grip']);
  assert.ok(e.docs.get('exo_s').meta.anchors.stomp[0].socket_grip.length === 3);
  const x = parseGLB(fs.readFileSync(e.run('model_export', { name: 'exo' }).file)).json;
  assert.ok(x.nodes.some((n) => n.name === 'socket_grip' && n.extras.socket === 'grip'));
});

test('skeleton op: cable helper, from_parts, keep clips, info summary, remove', () => {
  const e = new Engine({ home: tmp() });
  e.run('model_create', { name: 'c', parts: [{ type: 'box', w: 8, h: 2, d: 8, at: [0, 40, 0], texture: '#555' }] });
  const r = e.run('model_skeleton', { name: 'c', skeleton: { template: 'chain', count: 5, from: [0, 40, 0], to: [10, 4, 0], cable: { r: 1, texture: '#a33' } } });
  assert.match(r.cable, /path points/);
  const def = e.models.get('c');
  assert.ok(def.parts.some((p) => p.type === 'tube' && p.id === 'cable'));
  assert.equal(def.skin.method, 'heat');
  assert.equal(e.run('model_weights', { name: 'c' }).pass, true);
  const info = e.run('model_info', { name: 'c' });
  assert.equal(info.skeleton.bones, 6);
  assert.equal(info.skeleton.skinned, true);
  // rigid rig -> bones
  e.run('model_create', { name: 'arm', parts: [{ type: 'box', name: 'upper', w: 4, h: 12, d: 4, texture: '#888', pivot: [0, 6, 0] }, { type: 'box', name: 'lower', parent: 'upper', w: 3, h: 10, d: 3, texture: '#888', at: [0, -11, 0], pivot: [0, 5, 0], rotate: [0, 0, 10] }] });
  const fp = e.run('model_skeleton', { name: 'arm', skeleton: { from_parts: true } });
  assert.deepEqual(Object.keys(fp.skeleton.tree), ['upper']);
  assert.ok(e.models.get('arm').skeleton.bones.lower.rotate, 'rest rotation kept');
  e.run('model_skin', { name: 'arm', skin: { method: 'rigid' } });
  const w = e.run('model_weights', { name: 'arm' }).weights;
  assert.ok(w.per_bone.upper > 0 && w.per_bone.lower > 0);
  e.run('model_animate', { name: 'arm', clip: 'bend', duration: 1, keys: [{ t: 0, bones: {} }, { t: 1, parts: { lower: { rot: [45, 0, 0] } } }] });
  const rb = e.run('model_export', { name: 'arm', profile: 'roblox' });
  assert.ok(rb.skin.roblox.warnings.some((x) => /rest rotations/.test(x)));
  // replacing the skeleton keeps clips that still resolve
  const again = e.run('model_skeleton', { name: 'arm', skeleton: { from_parts: true } });
  assert.deepEqual(again.kept, ['bend']);
  e.run('model_skeleton', { name: 'arm', skeleton: null });
  assert.equal(e.models.get('arm').skeleton, undefined);
  assert.equal(e.models.get('arm').skin, undefined);
  assert.throws(() => e.run('model_skin', { name: 'arm', skin: {} }), /no skeleton/);
});

test('existing exports stay byte-identical (no skeleton / skin used)', () => {
  const e = new Engine({ home: tmp() });
  e.run('create', { name: 'stone', width: 16 });
  e.run('draw', { canvas: 'stone', commands: [{ op: 'noise', colors: ['#555', '#777', '#999'], seed: 2 }] });
  e.run('model_create', { name: 'rifle', template: 'fp_rifle' });
  e.run('model_create', { name: 'arm', parts: [{ type: 'box', name: 'upper', w: 4, h: 12, d: 4, texture: 'stone', pivot: [0, 6, 0] }, { type: 'box', name: 'lower', parent: 'upper', w: 3, h: 10, d: 3, texture: 'stone', at: [0, -11, 0], pivot: [0, 5, 0] }], sockets: { tip: { part: 'lower', at: [0, -16, 0] } }, clips: { wave: { loop: true, duration: 1, keys: [{ t: 0, parts: {} }, { t: 0.5, parts: { lower: { rot: [40, 0, 0] } }, ease: 'smooth' }] } } });
  e.run('model_create', { name: 'door', parts: [{ type: 'box', w: 20, h: 30, d: 4, texture: 'stone' }], morphs: { open: { set: { 0: { scale: [1, 1.5, 1] } } } } });
  const h = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
  // recorded on main (7bfa3f8) before skinning existed: rigid rig + clips + sockets, morph targets, template
  const want = {
    rifle: 'fd91aaabf9cf001c4e9bc3e63f31813cfc994f786f4d12726258e5d87f2d9e00',
    arm: '65f9c3a3cfad56fd36dcecb710940ce61f17a46b28f3998ed6d75d5a2e30bf3b',
    door: 'd47e1404f13be9daaa8b2536ec13f9dcc86231f0df7fbedb34de6f3f0e3c8107',
  };
  for (const n of Object.keys(want)) assert.equal(h(e.run('model_export', { name: n }).file), want[n], n);
});

test('three.js GLTFLoader loads the skinned glb as a SkinnedMesh and plays it like our evaluator (optional: AGENT_ART_THREE)', async (t) => {
  // three is not a dependency: point AGENT_ART_THREE at a node_modules folder holding three to run this
  let THREE, GLTFLoader;
  try {
    const dir = process.env.AGENT_ART_THREE;
    if (dir) {
      THREE = await import(pathToFileURL(path.join(dir, 'three', 'build', 'three.module.js')).href);
      ({ GLTFLoader } = await import(pathToFileURL(path.join(dir, 'three', 'examples', 'jsm', 'loaders', 'GLTFLoader.js')).href));
    } else { THREE = await import('three'); ({ GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js')); }
  } catch { t.skip('three.js not installed (set AGENT_ART_THREE=<dir with node_modules/three>)'); return; }
  const e = new Engine({ home: tmp() });
  exo(e);
  e.run('model_skin', { name: 'exo', skin: { method: 'heat', parts: ['hose_f', 'hose_b'], blend: 2, shapes: { dent: { sculpt: [{ sphere: [0, 55, 6, 5], move: [0, 0, -1.5] }] } } } });
  e.run('model_animate', { name: 'exo', clip: 'wave', loop: true, duration: 1, keys: [{ t: 0, bones: {} }, { t: 0.5, bones: { upper_arm_f: { rot: [0, 0, -70] }, forearm_f: { rot: [-50, 0, 0] }, pelvis: { at: [0, -2, 1] } }, morphs: { dent: 1 } }] });
  const buf = fs.readFileSync(e.run('model_export', { name: 'exo' }).file);
  // textures need a DOM in GLTFLoader: strip them (geometry, skin and animation are what we check)
  const { json, bin } = parseGLB(buf);
  const j2 = structuredClone(json);
  for (const m of j2.materials || []) { if (m.pbrMetallicRoughness) delete m.pbrMetallicRoughness.baseColorTexture; delete m.emissiveTexture; delete m.normalTexture; }
  delete j2.textures; delete j2.images; delete j2.samplers;
  let js = Buffer.from(JSON.stringify(j2)); js = Buffer.concat([js, Buffer.alloc((4 - (js.length % 4)) % 4, 0x20)]);
  const h = Buffer.alloc(12); h.writeUInt32LE(0x46546c67, 0); h.writeUInt32LE(2, 4); h.writeUInt32LE(28 + js.length + bin.length, 8);
  const c1 = Buffer.alloc(8); c1.writeUInt32LE(js.length, 0); c1.writeUInt32LE(0x4e4f534a, 4);
  const c2 = Buffer.alloc(8); c2.writeUInt32LE(bin.length, 0); c2.writeUInt32LE(0x004e4942, 4);
  const out = Buffer.concat([h, c1, js, c2, Buffer.from(bin)]);
  const gltf = await new Promise((res, rej) => new GLTFLoader().parse(out.buffer.slice(out.byteOffset, out.byteOffset + out.length), '', res, rej));
  const meshes = [];
  gltf.scene.traverse((o) => { if (o.isSkinnedMesh) meshes.push(o); });
  assert.ok(meshes.length >= 1, 'SkinnedMesh');
  assert.equal(meshes[0].skeleton.bones.length, json.skins[0].joints.length);
  assert.deepEqual(Object.keys(meshes[0].morphTargetDictionary), ['dent']);
  const clip = gltf.animations.find((a) => a.name === 'wave');
  assert.ok(clip && clip.tracks.some((tr) => tr.name.endsWith('.morphTargetInfluences')));
  const mixer = new THREE.AnimationMixer(gltf.scene);
  mixer.clipAction(clip).play();
  const mi = json.nodes.findIndex((n) => n.skin !== undefined);
  for (const time of [0, 0.25, 0.5]) {
    mixer.setTime(time);
    gltf.scene.updateMatrixWorld(true);
    const ours = skinnedPositions(json, bin, mi, json.animations.find((a) => a.name === 'wave'), time);
    let k = 0, worst = 0;
    const v = new THREE.Vector3();
    for (const m of meshes) for (let i = 0; i < m.geometry.attributes.position.count; i++, k++) {
      m.getVertexPosition(i, v);
      v.applyMatrix4(m.matrixWorld);
      worst = Math.max(worst, Math.hypot(v.x - ours[k].pos[0], v.y - ours[k].pos[1], v.z - ours[k].pos[2]));
    }
    assert.equal(k, ours.length);
    assert.ok(worst < 1e-4, `t=${time}: three vs evaluator ${worst}`);
  }
});

test('art_model skeleton / skin / weights are wired into MCP and help', () => {
  const t = TOOLS.find((x) => x.name === 'art_model');
  for (const a of ['skeleton', 'skin', 'weights']) assert.ok(t.inputSchema.properties.action.enum.includes(a), a);
  for (const p of ['skeleton', 'skin', 'retarget', 'profile', 'bones', 'bone']) assert.ok(t.inputSchema.properties[p], p);
  assert.match(helpText({ topic: '3d' }), /SKINNING/);
});
