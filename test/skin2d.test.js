// 2D skinning (art_rig skin / weights / shapes / chain / export) + 2D constraints: weights sum to 1
// with <= 4 influences, the rest pose reproduces the drawing pixel for pixel, deformed frames use
// only the drawing's colours, byte-identical determinism, existing cutout rigs unchanged (golden
// hashes recorded on main 7bfa3f8), lattice cuts, shapes / correctives, CCD / aim / look_at /
// copy_rotation / limits, the chain helper, art_anim clips on a skinned rig, the runtime JSON
// export, the weights image + UI route and the MCP / help wiring.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { Engine } from '../src/engine.js';
import { startServer } from '../src/server.js';
import { TOOLS } from '../src/mcp.js';
import { helpText } from '../src/docs.js';
import { normalizeRig, renderPose, solvePose, animatePoses, resolvePose } from '../src/rig.js';
import { getRig } from '../src/rigops.js';
import { buildSkinMesh, latticeMesh, pruneWeights, deformVerts, shapeWeights } from '../src/skin2d.js';
import { decodePNG } from '../src/png.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'agent-art-skin2d-'));
const OUT = '#20181c';
const colors = (data) => { const s = new Set(); for (let i = 0; i < data.length; i += 4) if (data[i + 3]) s.add((data[i] << 16 | data[i + 1] << 8 | data[i + 2]).toString(16).padStart(6, '0') + data[i + 3].toString(16)); return s; };
const opaque = (data) => { let n = 0; for (let i = 3; i < data.length; i += 4) if (data[i]) n++; return n; };
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);

/** A 2-bone arm drawn as ONE sprite in the upper cell (+ a "crease" variant), forearm = bone. */
function armRig(e, name = 'arm') {
  e.run('rig_create', {
    name, frame: [48, 48], root: [24, 8],
    parts: { upper: { w: 7, h: 28, pivot: [3, 1], variants: ['crease'] }, fore: { w: 1, h: 13, pivot: [0, 0], parent: 'upper', at: [0, 13], bone: true } },
    poses: { bend: { fore: { rot: -90 } }, half: { upper: { rot: 20 }, fore: { rot: -50 } } },
    presets: { wave: { keys: [{ parts: {} }, { pose: 'bend' }, { pose: 'half' }], frames: 6, fps: 8 } },
  });
  const cells = e.run('rig_info', { name, full: true }).cells.side;
  const cmds = [];
  for (const k of ['upper', 'upper:crease']) {
    const [x, y] = cells[k];
    cmds.push({ op: 'rect', x, y, w: 7, h: 28, color: '#c08050', outline: OUT }, { op: 'line', x1: x + 2, y1: y + 2, x2: x + 2, y2: y + 25, color: '#e0a070' }, { op: 'rect', x: x + 1, y: y + 12, w: 5, h: 2, color: '#904020' });
    if (k === 'upper:crease') cmds.push({ op: 'line', x1: x + 1, y1: y + 14, x2: x + 5, y2: y + 14, color: OUT });
  }
  e.run('draw', { canvas: `${name}_parts`, layer: 'parts', commands: cmds });
}

/** humanoid_hd with each arm / leg drawn as ONE sprite in the upper_arm / thigh cell (forearm / shin absorbed). */
function hdSkinned(e, name = 'hero', { skin = true } = {}) {
  e.run('rig_create', { name, template: 'humanoid_hd', frame: [64, 96] });
  const P = e.run('rig_info', { name, full: true }).parts;
  const long = { upper_arm_f: P.upper_arm_f.h + P.forearm_f.h - 2, upper_arm_b: P.upper_arm_b.h + P.forearm_b.h - 2, thigh_f: P.thigh_f.h + P.shin_f.h - 2, thigh_b: P.thigh_b.h + P.shin_b.h - 2 };
  e.run('rig_update', { name, parts: Object.fromEntries(Object.entries(long).map(([k, h]) => [k, { h }])) });
  const info = e.run('rig_info', { name, full: true });
  const PAL = { arm: '#7a8a5a', hand: '#d8a070', leg: '#5a6a7a', body: '#6a7a4a', head: '#e0b090', foot: '#3a3020' };
  const kind = (k) => (k.startsWith('head') ? 'head' : /hand/.test(k) ? 'hand' : /arm/.test(k) ? 'arm' : /foot/.test(k) ? 'foot' : /thigh|shin/.test(k) ? 'leg' : 'body');
  const cmds = [];
  for (const [v, cells] of Object.entries(info.cells)) for (const [k0, [x, y, w, h]] of Object.entries(cells)) {
    const k = k0.split(':')[0];
    if (/^(forearm|shin)_/.test(k) || ['weapon', 'cape', 'gear_back', 'gear_hip'].includes(k)) continue;
    cmds.push({ op: 'rect', x, y, w, h, color: PAL[kind(k)], outline: OUT });
    if (long[k] && w > 3) cmds.push({ op: 'line', x1: x + 2, y1: y + 2, x2: x + 2, y2: y + h - 3, color: '#a0b080' }, { op: 'rect', x: x + 1, y: y + Math.round(h / 2) - 1, w: w - 2, h: 2, color: '#4a3a2a' });
    void v;
  }
  e.run('draw', { canvas: `${name}_parts`, layer: 'parts', commands: cmds });
  if (skin) e.run('rig_skin', { name, skin: { arm_f: { part: 'upper_arm_f', absorb: ['forearm_f'] }, arm_b: { part: 'upper_arm_b', absorb: ['forearm_b'] }, leg_f: { part: 'thigh_f', absorb: ['shin_f'] }, leg_b: { part: 'thigh_b', absorb: ['shin_b'] } } });
  return info;
}

test('skin2d: weights sum to 1 with <= 4 influences (heat, distance, rigid, a whole drawn character on every bone)', () => {
  // pruning: 6 influences -> the 4 strongest, sum exactly 1, ties to the lower bone index
  const p = pruneWeights([0.1, 0.3, 0.3, 0.05, 0.2, 0.05, 0.001]);
  assert.deepEqual(p.j, [1, 2, 4, 0]);
  assert.equal(pruneWeights([0.5, 0.495, 0.004, 0.001]).over, false);
  assert.ok(Math.abs(p.w.reduce((s, x) => s + x, 0) - 1) < 1e-12);
  assert.ok(p.over);
  const e = new Engine({ home: tmp() });
  armRig(e);
  for (const method of ['heat', 'distance', 'rigid']) {
    e.run('rig_skin', { name: 'arm', skin: { arm: { part: 'upper', absorb: ['fore'], method, ...(method === 'rigid' ? { blend: 3 } : {}) } } });
    const { d, rig } = getRig(e, 'arm');
    const b = buildSkinMesh(rig, d, rig.skin.arm, 'side');
    const n = b.verts.length / 2;
    for (let i = 0; i < n; i++) {
      assert.ok(b.counts[i] >= 1 && b.counts[i] <= 4, `${method}: vertex ${i} has ${b.counts[i]} influences`);
      let s = 0;
      for (let c = 0; c < b.counts[i]; c++) { s += b.weights[i * 4 + c]; assert.ok(b.weights[i * 4 + c] > 0); }
      assert.ok(Math.abs(s - 1) < 1e-12, `${method}: vertex ${i} sums to ${s}`);
    }
    const w = e.run('rig_weights', { name: 'arm', bone: 'fore' });
    assert.ok(w.pass, w.summary);
    assert.equal(w.meshes.arm.side.unweighted, 0);
    assert.ok(Buffer.isBuffer(w.image));
  }
  // whole character: the rest render of a cutout humanoid as one canvas drawing, bound to every bone
  hdSkinned(e, 'cut', { skin: false });
  e.run('rig_animate', { name: 'cut', animation: 'rest', view: 'side', keys: [{ parts: {} }], frames: 1, loop: false, canvas: 'cut_rest' });
  e.run('rig_create', { name: 'one', template: 'humanoid_hd', frame: [64, 96], views: ['side'], mirror: {} });
  const r = e.run('rig_skin', { name: 'one', skin: { body: { canvas: 'cut_rest', bones: 'all' } } });
  const rep = r.meshes.body.side;
  assert.equal(rep.non_normalised, 0);
  assert.equal(rep.unweighted, 0);
  assert.ok(rep.max_influences <= 4 && rep.bones >= 18, JSON.stringify(rep));
  const { d, rig } = getRig(e, 'one');
  const b = buildSkinMesh(rig, d, rig.skin.body, 'side');
  for (let i = 0; i < b.verts.length / 2; i++) { let s = 0; for (let c = 0; c < b.counts[i]; c++) s += b.weights[i * 4 + c]; assert.ok(Math.abs(s - 1) < 1e-12 && b.counts[i] <= 4); }
});

test('skin2d: the rest pose reproduces the drawing pixel for pixel (part host, absorbed parts, canvas, 8 directions)', () => {
  const e = new Engine({ home: tmp() });
  armRig(e);
  const before = e.run('rig_preview', { name: 'arm', view: 'side', scale: 1 }).image;
  e.run('rig_skin', { name: 'arm', skin: { arm: { part: 'upper', absorb: ['fore'] } } });
  assert.deepEqual(decodePNG(e.run('rig_preview', { name: 'arm', view: 'side', scale: 1 }).image).data, decodePNG(before).data);
  // canvas source: a drawn sprite bound to all bones renders as itself at rest
  hdSkinned(e, 'cut', { skin: false });
  e.run('rig_animate', { name: 'cut', animation: 'rest', view: 'side', keys: [{ parts: {} }], frames: 1, loop: false, canvas: 'cut_rest' });
  e.run('rig_create', { name: 'one', template: 'humanoid_hd', frame: [64, 96], views: ['side'], mirror: {} });
  e.run('rig_skin', { name: 'one', skin: { body: { canvas: 'cut_rest' } } });
  const one = getRig(e, 'one');
  assert.deepEqual(renderPose(one.rig, one.d, {}, 'side'), e.get('cut_rest').composite());
  // 8 directions: skinned limbs at rest == the cutout render without the absorbed parts, in every view
  const info = hdSkinned(e, 'hero');
  const h = getRig(e, 'hero');
  const absorbed = ['forearm_f', 'forearm_b', 'shin_f', 'shin_b'];
  const plain = structuredClone(h.def); delete plain.skin;
  const rigid = normalizeRig(plain);
  for (const v of [...info.views, ...Object.keys(info.mirror)]) {
    const a = renderPose(h.rig, h.d, {}, v), b = renderPose(rigid, h.d, {}, v, new Map(), { hide: absorbed });
    assert.ok(Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0, `view ${v}: rest pose differs from the drawing`);
    assert.ok(opaque(a) > 300);
  }
});

test('skin2d: deformed frames use only the drawing\'s colours; skinned elbow bends in one piece (no hinge gap)', () => {
  const e = new Engine({ home: tmp() });
  hdSkinned(e, 'hero');
  const art = colors(e.get('hero_parts').layers.find((l) => l.name === 'parts').data);
  for (const v of ['side', 'front_side', 'back', 'side_left']) {
    const r = e.run('rig_animate', { name: 'hero', preset: 'walk', view: v, canvas: `walk_${v}` });
    const data = e.get(`walk_${v}`).composite();
    for (const c of colors(data)) assert.ok(art.has(c), `${v}: colour ${c} is not in the drawing`);
    assert.ok(r.frames[1] - r.frames[0] >= 7);
  }
  // skinned vs rigid elbow at 90 degrees: one 4-connected blob vs a hinge
  armRig(e);
  e.run('rig_skin', { name: 'arm', skin: { arm: { part: 'upper', absorb: ['fore'] } } });
  const img = decodePNG(e.run('rig_preview', { name: 'arm', pose: 'bend', view: 'side', scale: 1 }).image);
  const W = img.width, H = img.height, seen = new Uint8Array(W * H);
  let comps = 0;
  for (let i = 0; i < W * H; i++) {
    if (seen[i] || !img.data[i * 4 + 3] || img.data[i * 4] > 200 && img.data[i * 4 + 1] < 120) continue; // skip the ground-line dashes
    comps++;
    const st = [i]; seen[i] = 1;
    while (st.length) { const q = st.pop(), x = q % W, y = (q - x) / W; for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const X = x + dx, Y = y + dy, k = Y * W + X; if (X >= 0 && Y >= 0 && X < W && Y < H && !seen[k] && img.data[k * 4 + 3] && !(img.data[k * 4] > 200 && img.data[k * 4 + 1] < 120)) { seen[k] = 1; st.push(k); } } }
  }
  assert.equal(comps, 1, 'the bent skinned arm is one piece');
  const armCols = colors(e.get('arm_parts').layers.find((l) => l.name === 'parts').data);
  const anim = e.run('rig_animate', { name: 'arm', preset: 'wave', view: 'side' });
  for (const c of colors(e.get('arm').composite())) assert.ok(armCols.has(c), `arm colour ${c}`);
  assert.equal(anim.frames[1] - anim.frames[0] + 1, 6);
});

test('skin2d: deterministic (byte-identical renders and export twice) and existing cutout rigs render byte-identical to main', () => {
  const run = () => {
    const e = new Engine({ home: tmp() });
    hdSkinned(e, 'hero');
    e.run('rig_animate', { name: 'hero', preset: 'walk', view: 'front_side', canvas: 'w' });
    const x = e.run('rig_export', { name: 'hero', presets: ['walk'], views: ['side'] });
    return [sha(e.get('w').composite()), sha(fs.readFileSync(x.file))];
  };
  assert.deepEqual(run(), run());
  // goldens: the same cutout rigs and clips hashed on main before 2D skinning (7bfa3f8; hd_walk_back re-hashed after #12 back-view holding)
  const e = new Engine({ home: tmp() });
  const COLS = ['#5a6a7a', '#7a8a5a', '#d8a070', '#e0b090', '#303338', '#6a7a4a', '#3a3020', '#c040c0', '#c8a040'];
  const paint = (name) => {
    const cells = e.run('rig_info', { name }).cells;
    const cmds = [];
    let i = 0;
    for (const v of Object.keys(cells)) for (const [, [x, y, w, h]] of Object.entries(cells[v])) {
      cmds.push({ op: 'rect', x, y, w, h, color: COLS[i % COLS.length] });
      if (w > 2 && h > 2) cmds.push({ op: 'line', x1: x, y1: y, x2: x + w - 1, y2: y + h - 1, color: '#101018' });
      i++;
    }
    e.run('draw', { canvas: `${name}_parts`, layer: 'parts', commands: cmds });
  };
  const hash = (c) => crypto.createHash('sha256').update(e.get(c).composite()).digest('hex').slice(0, 16);
  const got = {};
  e.run('rig_create', { name: 'g1', template: 'humanoid', frame: [32, 32] });
  paint('g1');
  for (const v of ['side', 'front', 'side_left']) { e.run('rig_animate', { name: 'g1', preset: 'walk', view: v, canvas: `g1_${v}` }); got[`humanoid_walk_${v}`] = hash(`g1_${v}`); }
  e.run('rig_create', { name: 'g2', template: 'humanoid_hd', frame: [64, 96], weapon: { class: 'rifle' } });
  paint('g2');
  for (const v of ['side', 'front_side', 'back']) { e.run('rig_animate', { name: 'g2', preset: 'walk', view: v, canvas: `g2_${v}`, constraints: 'warn' }); got[`hd_walk_${v}`] = hash(`g2_${v}`); }
  e.run('anim_skeleton', { name: 'hd', template: 'humanoid_hd', frame: [64, 96] });
  e.run('anim_skin', { name: 's1', skeleton: 'hd' });
  paint('s1');
  e.run('anim_render', { skin: 's1', clip: 'walk', view: 'front', canvas: 's1_walk' });
  got.anim_walk_front = hash('s1_walk');
  assert.deepEqual(got, {
    humanoid_walk_side: 'efa385138a07abd2', humanoid_walk_front: '6ecf1df0e9d7a8fd', humanoid_walk_side_left: '75130cfd19ee0668',
    hd_walk_side: '69ed60c88ee6b952', hd_walk_front_side: '2d8349114609f95a', hd_walk_back: '9d26e0448534871a', anim_walk_front: '9f58f3e104460817',
  });
});

test('skin2d: the lattice is cut where pixels do not connect (a 1px gap keeps two legs apart)', () => {
  // two 3px bars, 1px apart, inside the same 8px lattice cells
  const w = 7, h = 16, mask = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (const x of [0, 1, 2, 4, 5, 6]) mask[y * w + x] = 1;
  const L = latticeMesh(mask, w, h, 8);
  const left = new Set(), right = new Set();
  for (let t = 0; t < L.tris.length / 3; t++) for (let k = 0; k < 3; k++) (L.triComp[t] === 0 ? left : right).add(L.tris[3 * t + k]);
  for (const v of left) assert.ok(!right.has(v), 'the two bars share no vertex');
  // heat weights: a bone in the left bar does not leak into the right bar
  const e = new Engine({ home: tmp() });
  e.run('rig_create', { name: 'legs', frame: [16, 24], root: [4, 2], parts: { hips: { w: 7, h: 16, pivot: [1, 0] }, l: { w: 1, h: 14, pivot: [0, 0], parent: 'hips', at: [0, 1], bone: true }, r: { w: 1, h: 14, pivot: [0, 0], parent: 'hips', at: [4, 1], bone: true } } });
  const c = e.run('rig_info', { name: 'legs', full: true }).cells.side.hips;
  e.run('draw', { canvas: 'legs_parts', layer: 'parts', commands: [{ op: 'rect', x: c[0], y: c[1], w: 3, h: 16, color: '#808080' }, { op: 'rect', x: c[0] + 4, y: c[1], w: 3, h: 16, color: '#606060' }] });
  e.run('rig_skin', { name: 'legs', skin: { legs: { part: 'hips', bones: ['l', 'r'], density: 8 } } });
  const { d, rig } = getRig(e, 'legs');
  const b = buildSkinMesh(rig, d, rig.skin.legs, 'side');
  const leftV = new Set();
  for (let t = 0; t < b.tris.length / 3; t++) if (b.triComp[t] === 0) for (let k = 0; k < 3; k++) leftV.add(b.tris[3 * t + k]);
  assert.ok(leftV.size >= 4);
  for (const i of leftV) {
    const wr = [0, 1, 2, 3].reduce((s, k) => s + (k < b.counts[i] && b.bones[b.joints[i * 4 + k]] === 'r' ? b.weights[i * 4 + k] : 0), 0);
    assert.ok(wr < 0.01, `left-bar vertex ${i} has ${wr} of the right bone`);
  }
});

test('skin2d: deform shapes: sculpt, variant swap, joint-angle driver, keys tween shape weights', () => {
  const e = new Engine({ home: tmp() });
  armRig(e);
  e.run('rig_skin', { name: 'arm', skin: { arm: { part: 'upper', absorb: ['fore'] } } });
  const r = e.run('rig_shapes', { name: 'arm', mesh: 'arm', shapes: { crease: { variant: 'crease', fit: false, driver: { bone: 'fore', from: 0, to: -90 } }, bulge: { sculpt: [{ region: { circle: [3, 8, 5], soft: 2 }, inflate: 1.5 }] } } });
  assert.deepEqual(r.shapes.side.map((s) => s.shape), ['crease', 'bulge']);
  assert.ok(r.shapes.side.find((s) => s.shape === 'bulge').max_offset > 1);
  const { d, rig } = getRig(e, 'arm');
  const b = buildSkinMesh(rig, d, rig.skin.arm, 'side');
  const at = (pose) => { const sp = solvePose(rig, pose, 'side'); return shapeWeights(rig, b, sp.world, sp.P); };
  assert.deepEqual([...at({})], [0, 0]);
  assert.ok(Math.abs(at(resolvePose(rig, { pose: 'bend' }))[0] - 1) < 1e-9);
  assert.ok(Math.abs(at({ fore: { rot: -45 } })[0] - 0.5) < 1e-9);
  assert.equal(at({ shapes: { bulge: 0.25 } })[1], 0.25);
  // the crease line (outline colour across the arm) appears only when the elbow is bent
  const creaseRow = (pose) => { const img = renderPose(rig, d, pose, 'side'); let n = 0; for (let i = 0; i < img.length; i += 4) if (img[i + 3] && img[i] === 0x20 && img[i + 1] === 0x18) n++; return n; };
  assert.ok(creaseRow({ fore: { rot: -80 } }) > creaseRow({ fore: { rot: -30 } }));
  // keys tween shape weights; sculpted shape moves the silhouette
  const P = animatePoses(rig, { keys: [{ parts: {}, shapes: { bulge: 0 } }, { parts: {}, shapes: { bulge: 1 } }], frames: 3, loop: false });
  assert.deepEqual(P.map((p) => p.shapes.bulge), [0, 0.5, 1]);
  assert.ok(opaque(renderPose(rig, d, P[2], 'side')) > opaque(renderPose(rig, d, P[0], 'side')));
  const dv = deformVerts(rig, b, solvePose(rig, {}, 'side').VP, solvePose(rig, {}, 'side').world, { shapes: { bulge: 1 } }, solvePose(rig, {}, 'side').world);
  assert.ok(dv.sw[1] === 1);
  // preview takes shape weights
  assert.ok(e.run('rig_preview', { name: 'arm', view: 'side', shapes: { bulge: 1 } }).image.length > 100);
  assert.throws(() => e.run('rig_shapes', { name: 'arm', mesh: 'arm', shapes: { bad: { driver: { bone: 'nope', from: 0, to: 1 }, sculpt: [{ move: [1, 0] }] } } }), /driver needs bone/);
});

test('skin2d: chains and constraints: CCD with limits, aim, look_at spread over a chain, copy_rotation', () => {
  const e = new Engine({ home: tmp() });
  const parts = { base: { w: 2, h: 2, pivot: [1, 1] } };
  let prev = 'base';
  for (let i = 1; i <= 6; i++) { parts[`t${i}`] = { w: 1, h: 6, pivot: [0, 0], parent: prev, at: [0, 6], bone: true }; prev = `t${i}`; }
  parts.eye = { w: 4, h: 2, pivot: [0, 1], parent: 'base', at: [0, -1] };
  parts.neck = { w: 2, h: 4, pivot: [1, 3], parent: 'base', at: [6, 0] };
  parts.head = { w: 6, h: 4, pivot: [0, 2], parent: 'neck', at: [0, -3] };
  parts.twin = { w: 1, h: 3, pivot: [0, 0], parent: 'base', at: [-4, 0] };
  e.run('rig_create', { name: 'ch', frame: [80, 80], root: [40, 10], parts, limits: { t3: [-20, 20] }, constrain: [{ type: 'aim', part: 'eye', target: 'look' }, { type: 'look_at', part: 'head', target: [70, 2], chain: ['neck'], limit: 40 }, { type: 'copy_rotation', part: 'twin', from: 't1', invert: true }] });
  const { rig } = getRig(e, 'ch');
  const sp = solvePose(rig, { ik: { t6: { target: [55, 38], chain: 5 } }, t1: { rot: 10 }, targets: { look: [40, 70] } }, 'side');
  assert.ok(Math.hypot(sp.world.t6.x - 55, sp.world.t6.y - 38) < 0.6, `CCD tip at ${sp.world.t6.x},${sp.world.t6.y}`);
  assert.ok(Math.abs(sp.VP.t3.rot) <= 20 + 1e-9, 'limit respected');
  // aim: the eye's drawn axis (+x) points at the named target straight below
  assert.ok(Math.abs(((sp.world.eye.rot % 360) + 360) % 360 - 90) < 1e-6);
  // look_at: the head turns toward the target but no more than the limit from the neck; the neck takes a share
  assert.ok(Math.abs(sp.VP.neck.rot) > 1);
  // copy_rotation (inverted, local)
  assert.ok(Math.abs(sp.VP.twin.rot + sp.VP.t1.rot) < 1e-9);
  // an unreachable target with a hard limit everywhere stays within the limits
  e.run('rig_update', { name: 'ch', limits: Object.fromEntries([1, 2, 3, 4, 5].map((i) => [`t${i}`, [-10, 10]])) });
  const { rig: r2 } = getRig(e, 'ch');
  const s2 = solvePose(r2, { ik: { t6: { target: [5, 10], chain: 5 } } }, 'side');
  for (let i = 1; i <= 5; i++) assert.ok(Math.abs(s2.VP[`t${i}`]?.rot ?? 0) <= 10 + 1e-9);
  // keys keep the chain length when tweened; pose validation knows chain:n
  const P = animatePoses(rig, { keys: [{ parts: {}, ik: { t6: { target: [55, 38], chain: 5 } } }, { parts: {}, ik: { t6: { target: [30, 40], chain: 5 } } }], frames: 4 });
  assert.ok(P.every((p) => p.ik.t6.chain === 5));
  e.run('rig_pose', { name: 'ch', pose: 'reach', parts: {}, ik: { t6: { target: [50, 40], chain: 6 } } });
  assert.throws(() => e.run('rig_pose', { name: 'ch', pose: 'bad', parts: {}, ik: { t6: { target: [50, 40], chain: 9 } } }), /chain:9 needs 9/);
  assert.throws(() => e.run('rig_update', { name: 'ch', constrain: [{ type: 'spin', part: 'eye' }] }), /type must be/);
});

test('skin2d: chain helper sweeps a drawn strap along bone segments; the CCD end pins it', () => {
  const e = new Engine({ home: tmp() });
  e.run('rig_create', { name: 'sl', frame: [64, 48], root: [10, 10], parts: { gun: { w: 40, h: 6, pivot: [0, 3] }, strap: { w: 3, h: 30, pivot: [1, 0], parent: 'gun', at: [2, 2] } } });
  const c = e.run('rig_info', { name: 'sl', full: true }).cells.side;
  e.run('draw', { canvas: 'sl_parts', layer: 'parts', commands: [{ op: 'rect', x: c.gun[0], y: c.gun[1], w: 40, h: 6, color: '#303338' }, { op: 'rect', x: c.strap[0], y: c.strap[1], w: 3, h: 30, color: '#6a5030', outline: OUT }] });
  const r = e.run('rig_chain', { name: 'sl', part: 'strap', bones: 5, secondary: true });
  assert.deepEqual(r.bones, ['strap_1', 'strap_2', 'strap_3', 'strap_4', 'strap_5']);
  assert.equal(r.tip, 'strap_5');
  assert.equal(r.weights.side.unweighted, 0);
  const { d, rig } = getRig(e, 'sl');
  assert.ok(rig.parts.strap_3.bone && rig.secondary.strap_2);
  // pin the strap's far end to the gun's muzzle end: a hanging sling
  const pose = { ik: { strap_5: { target: { part: 'gun', at: [26, 2] }, chain: 5 } } };
  const sp = solvePose(rig, pose, 'side');
  assert.ok(Math.hypot(sp.world.strap_5.x - (10 + 26), sp.world.strap_5.y - 12) < 0.6, `tip at ${sp.world.strap_5.x}, ${sp.world.strap_5.y}`);
  assert.ok(opaque(renderPose(rig, d, pose, 'side', new Map(), { only: ['strap'] })) > 60);
  e.run('rig_animate', { name: 'sl', animation: 'sway', keys: [{ parts: { gun: { rot: -8 } } }, { parts: { gun: { rot: 8 } } }], frames: 6, secondary: true });
});

test('skin2d: art_anim library clips play on a skinned rig (same bone names), batch strips stay in the palette', () => {
  const e = new Engine({ home: tmp() });
  e.run('anim_skeleton', { name: 'hd', template: 'humanoid_hd', frame: [64, 96] });
  e.run('anim_skin', { name: 'sk', skeleton: 'hd' });
  const P = e.run('rig_info', { name: 'sk', full: true }).parts;
  e.run('rig_update', { name: 'sk', parts: { upper_arm_f: { h: P.upper_arm_f.h + P.forearm_f.h - 2 } } });
  const cells = e.run('rig_info', { name: 'sk', full: true }).cells;
  const cmds = [];
  for (const v of Object.keys(cells)) for (const [k0, [x, y, w, h]] of Object.entries(cells[v])) { if (k0.includes(':') || /forearm_f|weapon|cape|gear/.test(k0)) continue; cmds.push({ op: 'rect', x, y, w, h, color: /arm/.test(k0) ? '#7a8a5a' : '#5a6a7a', outline: OUT }); }
  e.run('draw', { canvas: 'sk_parts', layer: 'parts', commands: cmds });
  e.run('anim_render', { skin: 'sk', clip: 'walk', view: 'side', canvas: 'rigid_walk' });
  e.run('rig_skin', { name: 'sk', skin: { arm: { part: 'upper_arm_f', absorb: ['forearm_f'] } } });
  const r = e.run('anim_render', { skin: 'sk', clip: 'walk', view: 'side', canvas: 'skin_walk' });
  assert.ok(r.frames[1] > r.frames[0]);
  assert.ok(Buffer.compare(Buffer.from(e.get('rigid_walk').composite()), Buffer.from(e.get('skin_walk').composite())) !== 0);
  const art = colors(e.get('sk_parts').layers.find((l) => l.name === 'parts').data);
  for (const c of colors(e.get('skin_walk').composite())) assert.ok(art.has(c));
  const b = e.run('anim_batch', { skins: ['sk'], clips: ['walk'], views: ['side', 'front'], out: path.join(e.home, 'assets') });
  assert.equal(b.files, 2);
});

test('skin2d: export JSON (bones, meshes, weights, shapes, baked clips) reproduces the deformation; layered strips', () => {
  const e = new Engine({ home: tmp() });
  armRig(e);
  e.run('rig_skin', { name: 'arm', skin: { arm: { part: 'upper', absorb: ['fore'], shapes: { bulge: { sculpt: [{ region: { circle: [3, 8, 5] }, inflate: 1 }] }, crease: { variant: 'crease', fit: false, driver: { bone: 'fore', from: 0, to: -90 } } } } } });
  const x = e.run('rig_export', { name: 'arm', layers: true });
  const J = JSON.parse(fs.readFileSync(x.file, 'utf8'));
  assert.equal(J.format, 'agent-art-skin2d');
  const M = J.meshes[0];
  assert.equal(M.vertices.length, M.uvs.length);
  assert.equal(M.joints.length, (M.vertices.length / 2) * 4);
  for (let i = 0; i < M.weights.length; i += 4) assert.equal(Math.round(M.weights.slice(i, i + 4).reduce((s, v) => s + v, 0) * 1e4), 1e4);
  assert.ok(M.triangles.every((t) => t < M.vertices.length / 2));
  assert.deepEqual(M.replaces, ['upper', 'fore']);
  assert.ok(fs.existsSync(path.join(x.dir, M.texture)) && M.shapes.find((s) => s.name === 'crease').texture);
  const clip = J.clips.wave_side;
  assert.equal(clip.frames.length, 6);
  assert.ok(clip.layers.upper && fs.existsSync(path.join(x.dir, clip.layers.upper)));
  // runtime deformation from the JSON alone == the engine's deformVerts (frame 1: elbow bent)
  const { d, rig } = getRig(e, 'arm');
  const b = buildSkinMesh(rig, d, rig.skin.arm, 'side');
  const poses = animatePoses(rig, { keys: [{ parts: {} }, { pose: 'bend' }, { pose: 'half' }], frames: 6 });
  const sp = solvePose(rig, poses[2], 'side');
  const ref = deformVerts(rig, b, sp.VP, sp.world, sp.P, solvePose(rig, {}, 'side').world).pos;
  const fr = clip.frames[2];
  const bones = J.bones.map((x2) => x2.name);
  const bindOf = (k) => J.bones[k].bind.side;
  const sw = fr.shapes || {};
  const n = M.vertices.length / 2;
  // vertex -> lattice vertex: by bind position (pages only duplicate)
  const lat = new Map(); for (let i = 0; i < b.verts.length / 2; i++) lat.set(`${b.verts[2 * i] + b.origin[0]},${b.verts[2 * i + 1] + b.origin[1]}`, i);
  let maxErr = 0;
  for (let i = 0; i < n; i++) {
    let vx = M.vertices[2 * i], vy = M.vertices[2 * i + 1];
    for (const s of M.shapes || []) { const w = sw[s.name] || 0; vx += w * s.offsets[2 * i]; vy += w * s.offsets[2 * i + 1]; }
    let X = 0, Y = 0;
    for (let c = 0; c < 4; c++) {
      const w = M.weights[i * 4 + c];
      if (!w) continue;
      const k = M.joints[i * 4 + c], [bx, by] = bindOf(k), [tx, ty, rot, sx, sy] = fr.bones[bones[k]];
      const cs = Math.cos(rot * Math.PI / 180), sn = Math.sin(rot * Math.PI / 180), lx = (vx - bx) * sx, ly = (vy - by) * sy;
      X += w * (tx + cs * lx - sn * ly); Y += w * (ty + sn * lx + cs * ly);
    }
    const li = lat.get(`${M.vertices[2 * i]},${M.vertices[2 * i + 1]}`);
    maxErr = Math.max(maxErr, Math.hypot(X - ref[2 * li], Y - ref[2 * li + 1]));
  }
  assert.ok(maxErr < 0.02, `runtime deformation off by ${maxErr}px`);
});

test('skin2d: weights paint (regions, weight canvas), validation, weights image, UI route, MCP + help wiring', async () => {
  const e = new Engine({ home: tmp() });
  armRig(e);
  e.run('rig_skin', { name: 'arm', skin: { arm: { part: 'upper', absorb: ['fore'], paint: [{ bone: 'fore', region: { below: 20 }, value: 1 }, { bone: 'upper', region: { above: 5 } }] } } });
  let { d, rig } = getRig(e, 'arm');
  let b = buildSkinMesh(rig, d, rig.skin.arm, 'side');
  const wOf = (i, bone) => [0, 1, 2, 3].reduce((s, k) => s + (k < b.counts[i] && b.bones[b.joints[i * 4 + k]] === bone ? b.weights[i * 4 + k] : 0), 0);
  for (let i = 0; i < b.verts.length / 2; i++) { if (b.verts[2 * i + 1] >= 20) assert.equal(wOf(i, 'fore'), 1); if (b.verts[2 * i + 1] <= 5) assert.equal(wOf(i, 'upper'), 1); }
  // weight canvas (grey = weight of fore), the drawing's size
  e.run('create', { name: 'wfore', width: 7, height: 28 });
  e.run('draw', { canvas: 'wfore', commands: [{ op: 'rect', x: 0, y: 0, w: 7, h: 14, color: '#000000' }, { op: 'rect', x: 0, y: 14, w: 7, h: 14, color: '#ffffff' }] });
  e.run('rig_skin', { name: 'arm', skin: { arm: { part: 'upper', absorb: ['fore'], weight_canvas: { canvas: 'wfore', bone: 'fore' } } } });
  ({ d, rig } = getRig(e, 'arm'));
  b = buildSkinMesh(rig, d, rig.skin.arm, 'side');
  for (let i = 0; i < b.verts.length / 2; i++) { if (b.verts[2 * i + 1] >= 16) assert.ok(wOf(i, 'fore') > 0.99); if (b.verts[2 * i + 1] <= 12) assert.ok(wOf(i, 'fore') < 0.01); }
  // validation
  assert.throws(() => e.run('rig_skin', { name: 'arm', skin: { x: { part: 'nope' } } }), /unknown part "nope"/);
  assert.throws(() => e.run('rig_skin', { name: 'arm', skin: { x: { part: 'upper', method: 'magic' } } }), /method must be/);
  assert.throws(() => e.run('rig_skin', { name: 'arm', skin: { x: { part: 'fore' } } }), /is a bone/);
  assert.throws(() => e.run('rig_skin', { name: 'arm', skin: { x: { canvas: 'missing' } } }), /no canvas "missing"/);
  assert.throws(() => e.run('rig_weights', { name: 'arm', mesh: 'zzz' }), /no mesh "zzz"/);
  const info = e.run('rig_info', { name: 'arm' });
  assert.deepEqual(info.skin.arm.bones, ['upper', 'fore']);
  assert.equal(info.parts.fore.bone, true);
  // UI route: the weights image
  const port = 7930 + Math.floor(Math.random() * 50);
  const srv = await startServer(e, { port });
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/rig/arm/weights.png?mesh=arm&bone=fore`);
    assert.equal(res.status, 200);
    const png = decodePNG(Buffer.from(await res.arrayBuffer()));
    assert.ok(png.width > 14 && png.height >= 28);
  } finally { await new Promise((r) => { srv.close(() => r()); srv.closeAllConnections?.(); }); }
  // removal leaves a plain cutout rig
  e.run('rig_skin', { name: 'arm', skin: null });
  assert.equal(getRig(e, 'arm').rig.skin, undefined);
  // MCP + help
  const t = TOOLS.find((x) => x.name === 'art_rig');
  for (const a of ['skin', 'weights', 'shapes', 'chain', 'export']) assert.ok(t.inputSchema.properties.action.enum.includes(a));
  assert.match(helpText({ topic: 'skin2d' }), /pixel for pixel/);
});

test('skin2d: constraint numbers are validated (look_at limit / share, offset, axis, weight)', () => {
  const e = new Engine({ home: tmp() });
  const parts = { base: { w: 2, h: 2, pivot: [1, 1] }, neck: { w: 2, h: 4, pivot: [1, 3], parent: 'base', at: [6, 0] }, head: { w: 6, h: 4, pivot: [0, 2], parent: 'neck', at: [0, -3] }, twin: { w: 1, h: 3, pivot: [0, 0], parent: 'base', at: [-4, 0] } };
  const mk = (c) => e.run('rig_create', { name: 'cv', frame: [40, 40], root: [20, 10], parts, constrain: [c], overwrite: true });
  const look = { type: 'look_at', part: 'head', target: [30, 2], chain: ['neck'] };
  assert.throws(() => mk({ ...look, limit: 'wide' }), /limit must be a finite number of degrees >= 0/);
  assert.throws(() => mk({ ...look, limit: -5 }), /limit must be/);
  assert.throws(() => mk({ ...look, share: ['half'] }), /share must list one finite fraction/);
  assert.throws(() => mk({ ...look, axis: 'x' }), /axis must be a finite number/);
  assert.throws(() => mk({ type: 'copy_rotation', part: 'twin', from: 'neck', offset: 'a' }), /offset must be a finite number/);
  assert.throws(() => mk({ type: 'copy_rotation', part: 'twin', from: 'neck', weight: 'w' }), /weight must be a finite number/);
  mk({ ...look, limit: 0, share: [0.5] });
  const sp = solvePose(getRig(e, 'cv').rig, {}, 'side');
  assert.ok(Object.values(sp.world).every((t) => Number.isFinite(t.rot)), 'finite rotations');
});
