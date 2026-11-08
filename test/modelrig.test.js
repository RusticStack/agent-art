// art_model rigs: named parts -> glTF nodes, poses + clips -> glTF animations, sockets, templates,
// sprite renders (frames, layers, quantize, socket anchors) and art_rig ik_from.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Engine } from '../src/engine.js';
import { decodePNG } from '../src/png.js';
import { buildModel } from '../src/model3d.js';
import { texResolver } from '../src/modelops.js';
import { rigInfo, clipKeys, sampleClip, qSlerp, posedWorld, resolveOffsets } from '../src/modelrig.js';
import { trsMatrix } from '../src/glb.js';
import { helpText } from '../src/docs.js';
import { TOOLS } from '../src/mcp.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'agent-art-rig3d-'));
const near = (a, b, eps = 1e-4) => Math.abs(a - b) <= eps;
const nearV = (a, b, eps = 1e-4, msg = '') => assert.ok(a.length === b.length && a.every((v, i) => near(v, b[i], eps)), `${msg} ${JSON.stringify(a)} vs ${JSON.stringify(b)}`);

/** Parse + validate a .glb: chunks, bufferViews, accessors (in range), meshes, nodes tree, animation samplers. */
function loadGLB(file) {
  const buf = fs.readFileSync(file);
  assert.equal(buf.readUInt32LE(0), 0x46546c67);
  assert.equal(buf.readUInt32LE(8), buf.length);
  const jlen = buf.readUInt32LE(12);
  const json = JSON.parse(buf.toString('utf8', 20, 20 + jlen));
  const bo = 20 + jlen, blen = buf.readUInt32LE(bo);
  assert.equal(bo + 8 + blen, buf.length);
  const bin = buf.subarray(bo + 8, bo + 8 + blen);
  assert.equal(json.buffers[0].byteLength, blen);
  for (const v of json.bufferViews) assert.ok(v.byteOffset % 4 === 0 && v.byteOffset + v.byteLength <= blen, 'bufferView inside BIN');
  const SIZE = { 5126: 4, 5123: 2, 5125: 4 }, COMP = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
  const read = (ai) => {
    const a = json.accessors[ai];
    assert.ok(a, `accessor ${ai} exists`);
    const v = json.bufferViews[a.bufferView];
    const bytes = a.count * COMP[a.type] * SIZE[a.componentType];
    assert.ok(bytes <= v.byteLength, 'accessor fits its bufferView');
    const off = bin.byteOffset + v.byteOffset + (a.byteOffset || 0);
    const T = a.componentType === 5126 ? Float32Array : a.componentType === 5123 ? Uint16Array : Uint32Array;
    return Array.from(new T(bin.buffer.slice(off, off + bytes)));
  };
  for (const m of json.meshes) {
    assert.ok(m.primitives.length >= 1, 'mesh has primitives');
    for (const p of m.primitives) {
      const n = json.accessors[p.attributes.POSITION].count;
      for (const i of read(p.indices)) assert.ok(i < n, 'index in range');
      assert.ok(json.materials[p.material]);
    }
  }
  const children = new Set();
  json.nodes.forEach((n, i) => {
    if (n.mesh !== undefined) assert.ok(json.meshes[n.mesh], 'node mesh exists');
    for (const c of n.children || []) { assert.ok(json.nodes[c] && c !== i, 'child exists'); assert.ok(!children.has(c), 'one parent per node'); children.add(c); }
    if (n.rotation) assert.ok(near(Math.hypot(...n.rotation), 1, 1e-5), 'unit quaternion');
  });
  for (const r of json.scenes[0].nodes) assert.ok(!children.has(r), 'scene roots are not children');
  for (const an of json.animations || []) {
    for (const s of an.samplers) {
      const t = read(s.input), out = read(s.output), ia = json.accessors[s.input];
      assert.equal(ia.type, 'SCALAR');
      assert.deepEqual([ia.min[0], ia.max[0]], [t[0], t[t.length - 1]], 'input min/max');
      for (let i = 1; i < t.length; i++) assert.ok(t[i] > t[i - 1], 'times strictly increasing');
      assert.equal(json.accessors[s.output].count, t.length, 'one output per input');
      assert.ok(['LINEAR', 'STEP'].includes(s.interpolation));
      assert.ok(out.every(Number.isFinite));
    }
    for (const c of an.channels) {
      assert.ok(an.samplers[c.sampler], 'channel sampler in range');
      assert.ok(json.nodes[c.target.node], 'channel node in range');
      assert.ok(['translation', 'rotation', 'scale'].includes(c.target.path));
      assert.equal(json.accessors[an.samplers[c.sampler].output].type, c.target.path === 'rotation' ? 'VEC4' : 'VEC3');
    }
  }
  return { json, read };
}
/** World positions (units) of every mesh vertex through the node tree. */
function worldPoints(g) {
  const { json, read } = g, pts = [];
  const walk = (i, P) => {
    const n = json.nodes[i];
    const L = n.matrix ? [n.matrix[0], n.matrix[4], n.matrix[8], n.matrix[12], n.matrix[1], n.matrix[5], n.matrix[9], n.matrix[13], n.matrix[2], n.matrix[6], n.matrix[10], n.matrix[14]] : trsMatrix(n.translation, n.rotation, n.scale);
    const W = mul(P, L);
    if (n.mesh !== undefined) for (const p of json.meshes[n.mesh].primitives) {
      const v = read(p.attributes.POSITION);
      for (let k = 0; k < v.length; k += 3) pts.push(ap(W, [v[k], v[k + 1], v[k + 2]]));
    }
    for (const c of n.children || []) walk(c, W);
  };
  for (const r of json.scenes[0].nodes) walk(r, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]);
  return pts;
}
const mul = (A, B) => { const r = []; for (let i = 0; i < 3; i++) { for (let j = 0; j < 3; j++) r[i * 4 + j] = A[i * 4] * B[j] + A[i * 4 + 1] * B[4 + j] + A[i * 4 + 2] * B[8 + j]; r[i * 4 + 3] = A[i * 4] * B[3] + A[i * 4 + 1] * B[7] + A[i * 4 + 2] * B[11] + A[i * 4 + 3]; } return r; };
const ap = (M, p) => [M[0] * p[0] + M[1] * p[1] + M[2] * p[2] + M[3], M[4] * p[0] + M[5] * p[1] + M[6] * p[2] + M[7], M[8] * p[0] + M[9] * p[1] + M[10] * p[2] + M[11]];
const bbox = (pts) => { const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity]; for (const p of pts) for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], p[k]); mx[k] = Math.max(mx[k], p[k]); } return { mn, mx }; };

const ARM_PARTS = [
  { type: 'box', w: 4, h: 4, d: 4, color: '#808080' }, // unnamed: root mesh
  { type: 'box', name: 'upper', w: 2, h: 8, d: 2, color: '#c04040', at: [0, 4, 0] },
  { type: 'box', name: 'lower', parent: 'upper', w: 2, h: 6, d: 2, color: '#40c040', at: [0, 12, 0], rotate: [0, 0, 90] },
  { type: 'box', parent: 'lower', w: 2, h: 2, d: 2, color: '#4040c0', at: [-6, 12, 0] }, // unnamed child: merges into "lower"
];

test('rig export: named parts -> nodes with parent links and local TRS; unnamed parts merge; world geometry unchanged', () => {
  const e = new Engine({ home: tmp() });
  const dir = tmp();
  const c = e.run('model_create', { name: 'arm', parts: ARM_PARTS, sockets: { tip: { part: 'lower', at: [-6, 13, 0], look: [-1, 0, 0] } } });
  assert.deepEqual(c.rig.tree, { arm: { upper: { lower: {} } } });
  assert.deepEqual(c.rig.nodes.map((n) => [n.name, n.triangles]), [['arm', 12], ['upper', 12], ['lower', 24]]);
  const x = e.run('model_export', { name: 'arm', path: path.join(dir, 'arm.glb') });
  const g = loadGLB(x.file), { json } = g;
  const byName = Object.fromEntries(json.nodes.map((n, i) => [n.name, { ...n, i }]));
  assert.deepEqual(json.scenes[0].nodes, [byName.arm.i], 'one root: the model');
  assert.ok(byName.arm.children.includes(byName.upper.i) && byName.upper.children.includes(byName.lower.i), 'arm > upper > lower');
  assert.ok(byName.lower.children.includes(byName.socket_tip.i), 'socket under its part');
  assert.equal(json.meshes.length, 3, 'root mesh + one mesh per named part');
  // local transforms: upper joint at [0,4,0] (no pivot = part origin); lower joint 8 px above it, rotated 90° about z
  nearV(byName.upper.translation, [0, 4 / 32, 0], 1e-6, 'upper translation');
  assert.equal(byName.upper.rotation, undefined);
  nearV(byName.lower.translation, [0, 8 / 32, 0], 1e-6, 'lower translation (parent space)');
  nearV(byName.lower.rotation, [0, 0, Math.SQRT1_2, Math.SQRT1_2], 1e-6, 'lower rotation');
  // socket: at [-6,13,0] model px -> lower frame (rotated -90° about z, from joint [0,12,0]): [1, 6, 0]; look -X = local -Z
  nearV(byName.socket_tip.translation, [1 / 32, 6 / 32, 0], 1e-5, 'socket translation');
  const q = byName.socket_tip.rotation, Wl = mul(trsMatrix([0, 0, 0], [0, 0, Math.SQRT1_2, Math.SQRT1_2]), trsMatrix([0, 0, 0], q));
  nearV([-Wl[2], -Wl[6], -Wl[10]], [-1, 0, 0], 1e-5, 'socket forward = look');
  // the scene graph reproduces the merged (un-rigged) model exactly
  const pts = worldPoints(g), b = bbox(pts);
  const info = e.run('model_info', { name: 'arm' });
  nearV(b.mn.map((v) => v * 32), info.bounds_px.min, 1e-3, 'world min');
  nearV(b.mx.map((v) => v * 32), info.bounds_px.max, 1e-3, 'world max');
  const meta = JSON.parse(fs.readFileSync(x.meta, 'utf8'));
  assert.equal(meta.rig.nodes.find((n) => n.name === 'lower').parent, 'upper');
  assert.match(meta.rig.note, /Motor6D/);
  // rig.merge:false: every part its own node (auto-named), still the same geometry
  e.run('model_update', { name: 'arm', rig: { merge: false } });
  const g2 = loadGLB(e.run('model_export', { name: 'arm', path: path.join(dir, 'arm2.glb') }).file);
  assert.deepEqual(g2.json.nodes.filter((n) => n.mesh !== undefined).map((n) => n.name), ['box_0', 'upper', 'lower', 'box_3']);
  assert.ok(g2.json.nodes.find((n) => n.name === 'lower').children.includes(g2.json.nodes.findIndex((n) => n.name === 'box_3')), 'unnamed child is a child node');
  nearV(bbox(worldPoints(g2)).mx, b.mx, 1e-5);
  // a model without names still exports one mesh, one node, no animations
  e.run('model_create', { name: 'plain', parts: [ARM_PARTS[0], { ...ARM_PARTS[1], name: undefined }] });
  const p = loadGLB(e.run('model_export', { name: 'plain', path: path.join(dir, 'plain.glb') }).file).json;
  assert.equal(p.nodes.length, 1); assert.equal(p.meshes.length, 1); assert.equal(p.animations, undefined);
  // validation
  assert.throws(() => e.run('model_create', { name: 'bad', parts: [{ type: 'box', name: 'a' }, { type: 'box', name: 'a' }] }), /used twice/);
  assert.throws(() => e.run('model_create', { name: 'bad', parts: [{ type: 'box', name: 'a', parent: 'nope' }] }), /not a named part/);
  assert.throws(() => e.run('model_create', { name: 'bad', parts: [{ type: 'box', name: 'a', parent: 'b' }, { type: 'box', name: 'b', parent: 'a' }] }), /loops/);
});

test('poses + clips export glTF animations whose samples match the pose interpolation; events in extras', () => {
  const e = new Engine({ home: tmp() });
  const dir = tmp();
  e.run('model_create', { name: 'arm', parts: ARM_PARTS });
  e.run('model_pose', { name: 'arm', pose: 'bent', parts: { lower: { rot: [0, 0, -90], at: [1, 0, 0] }, upper: { rot: [30, 0, 0] } } });
  assert.throws(() => e.run('model_pose', { name: 'arm', pose: 'x', parts: { elbow: { rot: [0, 0, 1] } } }), /not a node/);
  const a = e.run('model_animate', { name: 'arm', clip: 'bend', keys: [{ t: 0, parts: {} }, { t: 0.5, pose: 'bent' }, { t: 1, parts: { lower: { scale: 2 } } }], events: [{ t: 0.25, name: 'click' }] });
  assert.equal(a.duration, 1);
  e.run('model_animate', { name: 'arm', clip: 'wave', loop: true, duration: 2, keys: [{ t: 0, parts: {} }, { t: 1, pose: 'bent', ease: 'smooth' }] });
  e.run('model_animate', { name: 'arm', clip: 'snap', keys: [{ t: 0, parts: {} }, { t: 0.2, pose: 'bent', ease: 'step' }] });
  assert.throws(() => e.run('model_animate', { name: 'arm', clip: 'bad', keys: [{ t: 0.5, parts: {} }, { t: 0.5, parts: {} }] }), /strictly increasing/);
  const x = e.run('model_export', { name: 'arm', path: path.join(dir, 'arm.glb') });
  assert.deepEqual(x.animations, ['bend', 'wave', 'snap']);
  const g = loadGLB(x.file), { json, read } = g;
  const def = JSON.parse(fs.readFileSync(path.join(e.home, 'models', 'arm.json'), 'utf8'));
  const info = rigInfo(def, buildModel(def, { tex: texResolver(e), getModel: () => null }), true);
  const sampleGLTF = (an, node, pathName, t) => {
    const ch = an.channels.find((c) => c.target.node === node && c.target.path === pathName);
    const s = an.samplers[ch.sampler], T = read(s.input), V = read(s.output), k = pathName === 'rotation' ? 4 : 3;
    let i = 0;
    while (i < T.length - 1 && T[i + 1] <= t + 1e-6) i++;
    const at = (j) => V.slice(j * k, j * k + k);
    if (i >= T.length - 1 || s.interpolation === 'STEP') return at(i);
    const u = (t - T[i]) / (T[i + 1] - T[i]);
    return k === 4 ? qSlerp(at(i), at(i + 1), u) : at(i).map((v, c) => v + (at(i + 1)[c] - v) * u);
  };
  const nodeIdx = (n) => json.nodes.findIndex((x) => x.name === n);
  for (const [clip, times] of [['bend', [0, 0.1, 0.25, 0.5, 0.8, 1]], ['wave', [0, 0.2, 1 / 3, 1, 1.5, 2]], ['snap', [0, 0.1, 0.2]]]) {
    const an = json.animations.find((x) => x.name === clip);
    const ck = clipKeys(def, info, def.clips[clip]);
    for (const t of times) {
      const ref = sampleClip(info, ck, t);
      for (const [n, trs] of ref) {
        const ch = (p) => an.channels.some((c) => c.target.node === nodeIdx(n) && c.target.path === p);
        if (ch('rotation')) {
          const q = sampleGLTF(an, nodeIdx(n), 'rotation', t), d = Math.abs(q[0] * trs.q[0] + q[1] * trs.q[1] + q[2] * trs.q[2] + q[3] * trs.q[3]);
          assert.ok(d > 1 - 1e-5, `${clip} ${n} rotation at ${t}s`);
        }
        if (ch('translation')) nearV(sampleGLTF(an, nodeIdx(n), 'translation', t).map((v) => v * 32), trs.t, 1e-3, `${clip} ${n} translation at ${t}s`);
        if (ch('scale')) nearV(sampleGLTF(an, nodeIdx(n), 'scale', t), trs.s, 1e-4, `${clip} ${n} scale at ${t}s`);
      }
    }
  }
  const bend = json.animations.find((x) => x.name === 'bend');
  assert.deepEqual(bend.extras.events, [{ t: 0.25, name: 'click' }]);
  assert.ok(bend.samplers.every((s) => s.interpolation === 'LINEAR'));
  assert.ok(json.animations.find((x) => x.name === 'snap').samplers.every((s) => s.interpolation === 'STEP'));
  const wave = json.animations.find((x) => x.name === 'wave');
  assert.equal(wave.extras.loop, true);
  assert.ok(json.accessors[wave.samplers[0].input].count >= 60, 'smooth clip baked at 30 fps');
  nearV(json.accessors[wave.samplers[0].input].max, [2], 1e-6, 'loop closes at duration');
  // previews of a pose and a clip contact sheet
  const pv = e.run('model_preview', { name: 'arm', pose: 'bent', views: ['side', 'fp'] });
  assert.equal(pv.views.length, 2);
  const cs = e.run('model_preview', { name: 'arm', clip: 'bend', frames: 6, view: 'side' });
  assert.equal(cs.frames.length, 6);
  assert.ok(decodePNG(cs.image).width > 300);
});

test('templates fp_arms / fp_rifle / fp_pistol: create, override, pose, animate, export valid .glb', () => {
  const e = new Engine({ home: tmp() });
  const dir = tmp();
  const rifle = e.run('model_create', { name: 'rifle', template: 'fp_rifle', textures: { metal: '#202024' }, set: { magazine: { h: 5 } } });
  assert.deepEqual(Object.keys(rifle.rig.tree.rifle), ['receiver']);
  for (const p of ['barrel', 'handguard', 'stock', 'magazine', 'bolt', 'charging_handle', 'optic', 'trigger']) assert.ok(p in rifle.rig.tree.rifle.receiver, p);
  assert.deepEqual(rifle.rig.sockets.map((s) => s.name).sort(), ['socket_grip_l', 'socket_grip_r', 'socket_mag_well', 'socket_muzzle', 'socket_sight']);
  assert.deepEqual(Object.keys(rifle.rig.clips).sort(), ['fire', 'reload_empty', 'reload_tactical']);
  const info = e.run('model_info', { name: 'rifle' });
  assert.equal(info.parts_def.find((p) => p.name === 'magazine').h, 5, 'set by part name');
  e.run('model_pose', { name: 'rifle', pose: 'cant', parts: { receiver: { rot: [0, 0, -20] } } });
  e.run('model_animate', { name: 'rifle', clip: 'inspect', keys: [{ t: 0, parts: {} }, { t: 0.6, pose: 'cant', ease: 'smooth' }, { t: 1.2, parts: {} }] });
  const pistol = e.run('model_create', { name: 'pistol', template: 'fp_pistol' });
  assert.deepEqual(Object.keys(pistol.rig.clips).sort(), ['fire', 'reload']);
  const arms = e.run('model_create', { name: 'arms', template: 'fp_arms', textures: { sleeve: '#405060' } });
  const chain = (s) => arms.rig.tree.arms[`clavicle_${s}`][`upper_arm_${s}`][`forearm_${s}`][`hand_${s}`];
  for (const s of ['r', 'l']) assert.deepEqual(Object.keys(chain(s)).sort(), [`fingers_${s}`, `thumb_${s}`]);
  assert.deepEqual(arms.rig.poses, ['rest', 'grip_rifle', 'grip_pistol']);
  assert.deepEqual(Object.keys(arms.rig.clips), ['idle_breathe']);
  for (const n of ['rifle', 'pistol', 'arms']) {
    const x = e.run('model_export', { name: n, path: path.join(dir, `${n}.glb`) });
    const { json } = loadGLB(x.file);
    assert.ok(json.animations.length >= 1);
    for (const an of json.animations) assert.ok(an.channels.length > 0);
  }
  const rj = loadGLB(path.join(dir, 'rifle.glb')).json;
  const reload = rj.animations.find((a) => a.name === 'reload_empty');
  assert.ok(reload.extras.events.some((ev) => ev.name === 'mag_out'));
  const magIdx = rj.nodes.findIndex((n) => n.name === 'magazine'), chIdx = rj.nodes.findIndex((n) => n.name === 'charging_handle');
  assert.ok(reload.channels.some((c) => c.target.node === magIdx && c.target.path === 'translation'), 'magazine moves');
  assert.ok(reload.channels.some((c) => c.target.node === chIdx && c.target.path === 'translation'), 'charging handle cycles');
  // grip pose puts the palms on the weapon sockets (view space shared by the templates)
  for (const [gun, pose] of [['rifle', 'grip_rifle'], ['pistol', 'grip_pistol']]) {
    const load = (n) => { const def = JSON.parse(fs.readFileSync(path.join(e.home, 'models', `${n}.json`), 'utf8')); return [def, rigInfo(def, buildModel(def, { tex: texResolver(e), getModel: () => null }), true)]; };
    const [, gi] = load(gun), [ad, ai] = load('arms');
    const sockets = posedWorld(gi, new Map(), { mesh: false }).sockets, hands = posedWorld(ai, resolveOffsets(ad, ai, { pose }), { mesh: false }).world;
    for (const s of ['r', 'l']) {
      const palm = ap(hands.get(`hand_${s}`), [0, 0, -1.5]), g = sockets.get(`socket_grip_${s}`).pos;
      assert.ok(Math.hypot(palm[0] - g[0], palm[1] - g[1], palm[2] - g[2]) < 0.15, `${pose}: palm ${s} on ${gun} socket_grip_${s}`);
    }
  }
  const rr = e.run('model_render', { name: 'arms', canvas: 'arms_c', pose: 'grip_rifle', size: [48, 32], camera: 'fp' });
  assert.equal(rr.count, 1);
  assert.throws(() => e.run('model_create', { name: 'x', template: 'fp_tank' }), /unknown template/);
});

test('render: frames, size, only/hide layers, quantize, outline, socket anchors on the projected point', () => {
  const e = new Engine({ home: tmp() });
  e.run('model_create', {
    name: 'gun', parts: [
      { type: 'box', name: 'body', w: 12, h: 4, d: 4, color: '#a05030' },
      { type: 'box', name: 'mag', parent: 'body', w: 2, h: 5, d: 2, color: '#3050a0', at: [2, -5, 0], pivot: [0, 5, 0] },
      { type: 'box', name: 'mark', parent: 'body', w: 1, h: 1, d: 1, color: '#00ff00', at: [5, 6, 0] },
    ],
    sockets: { muzzle: { part: 'body', at: [5, 6.5, 0], look: [1, 0, 0] }, grip: { part: 'mag', at: [2, -3, 0] } },
  });
  e.run('model_animate', { name: 'gun', clip: 'drop', keys: [{ t: 0, parts: {} }, { t: 1, parts: { mag: { at: [0, -6, 0] } } }] });
  const cam = { pos: [0, 0, 40], look: [0, 0, 0], fov: 60 };
  const r = e.run('model_render', { name: 'gun', canvas: 'gun_s', clip: 'drop', frames: 5, size: [64, 48], camera: cam });
  assert.equal(r.count, 5);
  const d = e.docs.get('gun_s');
  assert.equal(d.width, 64); assert.equal(d.frameHeight, 48); assert.equal(d.frames, 5);
  assert.deepEqual(d.animations.drop.frames, [0, 1, 2, 3, 4]);
  // anchors = the camera projection of the socket (independent maths)
  const f = 24 / Math.tan(Math.PI / 6);
  const proj = (p) => [32 + (p[0] / (40 - p[2])) * f - 0.5, 24 - (p[1] / (40 - p[2])) * f - 0.5];
  const A = d.meta.anchors.drop;
  assert.equal(A.length, 5);
  for (let i = 0; i < 5; i++) {
    const dy = -6 * (i / 4);
    nearV(A[i].socket_muzzle.slice(0, 2), proj([5, 6.5, 0]), 0.1, `muzzle frame ${i}`);
    nearV(A[i].socket_grip.slice(0, 2), proj([2, -3 + dy, 0]), 0.1, `grip frame ${i}`);
    assert.ok(Math.abs(A[i].socket_muzzle[2]) < 0.5, 'muzzle points right on screen (rot 0)');
  }
  // the green marker box sits on the muzzle anchor (within 1 px)
  const px = d.frameData(0);
  let wx = 0, wy = 0, wn = 0;
  for (let y = 0; y < 48; y++) for (let x = 0; x < 64; x++) { const o = (y * 64 + x) * 4; if (px[o + 1] > px[o] + 50 && px[o + 1] > px[o + 2] + 50 && px[o + 3]) { wx += x; wy += y; wn++; } }
  assert.ok(wn > 0, 'marker drawn');
  assert.ok(Math.hypot(wx / wn - A[0].socket_muzzle[0], wy / wn - A[0].socket_muzzle[1]) < 1, 'marker under the anchor');
  // transparent background
  assert.equal(px[3], 0);
  // only / hide: the mag layer + the gun without the mag stack into the full render
  e.run('model_render', { name: 'gun', canvas: 'gun_body', clip: 'drop', frames: 5, size: [64, 48], camera: cam, hide: ['mag'] });
  e.run('model_render', { name: 'gun', canvas: 'gun_mag', clip: 'drop', frames: 5, size: [64, 48], camera: cam, only: ['mag'] });
  const body = e.docs.get('gun_body').frameData(4), mag = e.docs.get('gun_mag').frameData(4), full = d.frameData(4);
  const count = (x, pred) => { let n = 0; for (let i = 0; i < x.length; i += 4) if (x[i + 3] && pred(x, i)) n++; return n; };
  const blue = (x, i) => x[i + 2] > x[i] + 40;
  assert.equal(count(body, blue), 0, 'hide:[mag] has no mag pixels');
  assert.ok(count(mag, blue) > 0 && count(mag, (x, i) => !blue(x, i)) === 0, 'only:[mag] has only mag pixels');
  for (let i = 0; i < full.length; i += 4) assert.equal(!!full[i + 3], !!(body[i + 3] || mag[i + 3]), 'layers cover the full render');
  assert.deepEqual(e.docs.get('gun_mag').meta.anchors.drop, A, 'layers share anchors');
  // quantize to 3 colours with dither, plus an outline colour
  e.run('model_render', { name: 'gun', canvas: 'gun_q', pose: undefined, size: [64, 48], camera: cam, quantize: { colors: 3, dither: true }, outline: '#000000' });
  const q = e.docs.get('gun_q').frameData(0), cols = new Set();
  for (let i = 0; i < q.length; i += 4) if (q[i + 3]) cols.add(`${q[i]},${q[i + 1]},${q[i + 2]}`);
  assert.ok(cols.size <= 4 && cols.has('0,0,0'), `3 colours + outline (got ${cols.size})`);
  // angle sweep: row-major grid, tagged "angles"
  const s = e.run('model_render', { name: 'gun', canvas: 'gun_sw', sweep: { yaw: [-20, 20, 10], pitch: [-10, 10, 10] }, size: [32, 32], camera: 'side' });
  assert.equal(s.count, 15);
  assert.deepEqual(s.grid.yaw, [-20, -10, 0, 10, 20]);
  assert.equal(e.docs.get('gun_sw').animations.angles.frames.length, 15);
  // spritesheet json carries the anchors
  const out = tmp();
  const ex = e.run('export_animation', { canvas: 'gun_s', format: 'spritesheet', path: path.join(out, 'gun_s') });
  const js = JSON.parse(fs.readFileSync(ex.json, 'utf8'));
  assert.ok(Object.values(js.frames)[2].anchors.socket_grip, 'spritesheet frames[].anchors');
});

test('art_rig animate ik_from: hands follow a rendered gun clip\'s anchors frame by frame', () => {
  const e = new Engine({ home: tmp() });
  e.run('model_create', {
    name: 'gun', parts: [{ type: 'box', name: 'body', w: 10, h: 3, d: 3, color: '#a05030' }],
    sockets: { grip_r: { part: 'body', at: [-2, 0, 0] } },
  });
  e.run('model_animate', { name: 'gun', clip: 'kick', keys: [{ t: 0, parts: {} }, { t: 0.2, parts: { body: { at: [-2, 3, 0] } } }, { t: 0.4, parts: {} }] });
  e.run('model_render', { name: 'gun', canvas: 'gun_k', clip: 'kick', frames: 6, size: [64, 64], camera: 'front', zoom: 2 });
  const A = e.docs.get('gun_k').meta.anchors.kick;
  e.run('rig_create', {
    name: 'arm', frame: [64, 64], views: ['side'], root: [16, 16],
    parts: {
      body: { w: 4, h: 6, pivot: [2, 0] },
      upper: { w: 2, h: 14, pivot: [1, 0], parent: 'body', at: [0, 2] },
      lower: { w: 2, h: 14, pivot: [1, 0], parent: 'upper', at: [0, 13] },
      hand: { w: 2, h: 3, pivot: [1, 0], parent: 'lower', at: [0, 13] },
    },
  });
  const r = e.run('rig_animate', { name: 'arm', animation: 'kick', canvas: 'arm_k', ik_from: { canvas: 'gun_k', animation: 'kick', map: { hand: { anchor: 'socket_grip_r', bend: -1 } } } });
  assert.equal(r.frames[1] - r.frames[0] + 1, 6, 'same frame count');
  const out = e.docs.get('arm_k');
  assert.deepEqual(out.animations.kick.durations, e.docs.get('gun_k').animations.kick.durations, 'same timing');
  const H = out.meta.anchors.kick;
  for (let i = 0; i < 6; i++) assert.ok(Math.hypot(H[i].hand[0] - A[i].socket_grip_r[0], H[i].hand[1] - A[i].socket_grip_r[1]) <= 1, `frame ${i}: hand ${H[i].hand} on ${A[i].socket_grip_r}`);
  assert.ok(new Set(A.map((p) => p.socket_grip_r[1])).size > 1, 'the target moves');
  assert.throws(() => e.run('rig_animate', { name: 'arm', animation: 'x', ik_from: { canvas: 'gun_k', animation: 'nope', map: { hand: 'socket_grip_r' } } }), /no anchors/);
});

test('docs: art_help 3d covers rigs, clips and pre-rendered sprites; schema lists the new actions', () => {
  const help = helpText({ topic: '3d' });
  for (const k of ['RIGS & CLIPS', 'PRE-RENDERED SPRITES', 'socket_grip_r', 'fp_rifle', 'reload_empty', 'ik_from', 'sweep', 'quantize', 'Motor6D']) assert.ok(help.includes(k), `art_help 3d mentions ${k}`);
  const tool = TOOLS.find((t) => t.name === 'art_model');
  for (const a of ['pose', 'animate', 'render']) assert.ok(tool.inputSchema.properties.action.enum.includes(a));
  assert.ok(TOOLS.find((t) => t.name === 'art_rig').inputSchema.properties.ik_from);
});
