// Animation library (art_anim) + the 2D rotated-sprite tooling it relies on: skeletons with
// proportions, clip layers / masks / additive / events, retargeting, skins with equipment, batch
// render to game strips + manifest (padding, __front split, order metadata), glTF skin export,
// depth-based draw order (z rules, split parts, z keys, flicker detection), linked cells,
// consistency, stable rotation, export fixes, and the front-aim / reload clip fixes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Engine } from '../src/engine.js';
import { normalizeRig, solvePose, resolvePose, animatePoses, viewPose, poseOf, partIn, renderPose } from '../src/rig.js';
import { decodePNG } from '../src/png.js';
import { evalClip } from '../src/animlib.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'agent-art-lib-'));
const rigOf = (e, name) => normalizeRig(e.get(`${name}_parts`).meta.rig);
const PAL = { head: '#e0b090', weapon: '#303338', mag: '#c8a040', att: '#c040c0', arm: '#7a8a5a', hand: '#d8a070', leg: '#5a6a7a', body: '#6a7a4a', foot: '#3a3020', gear: '#ff00ff' };
const kind = (k) => (k.startsWith('head') ? 'head' : k === 'weapon' ? 'weapon' : k === 'mag' ? 'mag' : k.startsWith('att_') ? 'att' : k === 'gear_back' ? 'gear' : k.startsWith('gear') ? 'body' : /hand/.test(k) ? 'hand' : /arm/.test(k) ? 'arm' : /foot/.test(k) ? 'foot' : /thigh|shin/.test(k) ? 'leg' : 'body');
/** Flat art in every cell (weapon parts in the side row only), one colour per kind; head:helmet in yellow. */
function paint(e, name, { gear = false } = {}) {
  const cells = e.run('rig_info', { name }).cells;
  const cmds = [];
  for (const v of Object.keys(cells)) for (const [k0, [x, y, w, h]] of Object.entries(cells[v])) {
    const [k, variant] = k0.split(':');
    if (['weapon', 'mag'].includes(k) || k.startsWith('att_')) { if (v !== 'side') continue; }
    if (k === 'cape' || (!gear && k.startsWith('gear'))) continue;
    cmds.push({ op: 'rect', x, y, w, h, color: variant === 'helmet' ? '#ffff00' : PAL[kind(k)] });
  }
  e.run('draw', { canvas: `${name}_parts`, layer: 'parts', commands: cmds });
}
const count = (data, hex) => { const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)); let n = 0; for (let i = 0; i < data.length; i += 4) if (data[i + 3] && data[i] === c[0] && data[i + 1] === c[1] && data[i + 2] === c[2]) n++; return n; };
const lowest = (img, w, h) => { for (let y = h - 1; y >= 0; y--) for (let x = 0; x < w; x++) if (img[(y * w + x) * 4 + 3]) return y; return -1; };

function library(e, frame = [64, 96]) {
  return e.run('anim_skeleton', { name: 'hd', template: 'humanoid_hd', frame, weapon: { class: 'rifle', attachments: { vgrip: 'vertical_grip' } }, proportions: { heavy: { width: 1.15, spine: 1.05, arms: 1.04 }, lean: { width: 0.9, legs: 1.05 } } });
}

test('skeleton: template clips + standard composed clips, masks, proportions keep the feet on the ground', () => {
  const e = new Engine({ home: tmp() });
  const sk = library(e);
  for (const c of ['idle', 'walk', 'aim', 'reload', 'walk_aim', 'flinch', 'walk_hit']) assert.ok(sk.clips.includes(c), c);
  assert.equal(sk.class, 'rifle');
  assert.equal(sk.depth, true, 'library skeletons decide arm order from depth');
  assert.ok(sk.masks.lower >= 7 && sk.masks.upper > 10);
  e.run('anim_skin', { name: 'base', skeleton: 'hd' });
  e.run('anim_skin', { name: 'big', skeleton: 'hd', proportions: 'heavy' });
  const A = rigOf(e, 'base'), B = rigOf(e, 'big');
  assert.ok(B.parts.chest.w > A.parts.chest.w && B.parts.upper_arm_f.h >= A.parts.upper_arm_f.h, 'heavy: wider chest, longer arms');
  assert.equal(B.parts.weapon.w, A.parts.weapon.w, 'the gun keeps its size');
  // rest feet on the same ground row
  const low = (rig) => { const W = solvePose(rig, {}, 'side').world; return Math.max(...rig.feet.map((f) => W[f].y + rig.parts[f].h - 1 - rig.parts[f].pivot[1])); };
  assert.ok(Math.abs(low(A) - low(B)) <= 1, `feet ${low(A)} vs ${low(B)}`);
  assert.throws(() => e.run('anim_skin', { name: 'x', skeleton: 'hd', proportions: 'giant' }), /no proportions "giant"/);
  assert.throws(() => e.run('anim_skeleton', { name: 'bad', template: 'humanoid_hd', frame: [64, 96], proportions: { p: { tail: 2 } } }), /groups are/);
  const info = e.run('anim_info', { skeleton: 'hd' });
  assert.ok(info.clips.includes('walk_hit') && info.parts.includes('mag'));
});

test('clip layers: mask "upper" puts aim over the walk legs; additive flinch adds its offset; events come through', () => {
  const e = new Engine({ home: tmp() });
  library(e);
  e.run('anim_skin', { name: 's', skeleton: 'hd' });
  const rig = rigOf(e, 's');
  const walk = animatePoses(rig, { keys: rig.poses && JSON.parse(fs.readFileSync(path.join(e.home, 'library', 'clips', 'hd', 'walk.json'), 'utf8')).keys, frames: 16, loop: true });
  const fpOf = (clip, view = 'side') => {
    const r = e.run('anim_render', { skin: 's', clip, view, canvas: `c_${clip}_${view}`, constraints: 'off' });
    return r;
  };
  // walk_aim: legs from walk, weapon in the aim state (hands on the grips)
  const sk = JSON.parse(fs.readFileSync(path.join(e.home, 'library', 'skeletons', 'hd.json'), 'utf8'));
  assert.ok(sk.masks.upper.includes('weapon') && !sk.masks.upper.includes('thigh_f'));
  const r = fpOf('walk_aim');
  assert.equal(r.frames[1] - r.frames[0] + 1, 16);
  // evaluate directly: compare the flattened side pose of the legs with the walk, and the weapon state
  const getClip = (n) => JSON.parse(fs.readFileSync(path.join(e.home, 'library', 'clips', 'hd', `${n}.json`), 'utf8'));
  const wa = evalClip(rig, getClip('walk_aim'), getClip, sk);
  for (const f of [0, 5, 11]) {
    const L = viewPose(rig, wa.poses[f], 'side'), Wk = viewPose(rig, walk[f], 'side');
    for (const p of ['thigh_f', 'shin_b', 'pelvis']) assert.ok(Math.abs(poseOf(rig, L, p).rot - poseOf(rig, Wk, p).rot) < 1e-6, `frame ${f} ${p}`);
    const sv = solvePose(rig, wa.poses[f], 'side');
    assert.equal(sv.weapon.s.pl.name, 'aim', `frame ${f}: upper body aims`);
  }
  // additive: the flinch peak adds -9 deg to the chest on top of the walk; the legs are untouched
  const wh = evalClip(rig, getClip('walk_hit'), getClip, sk);
  const f = 4; // flinch peak (t 0.25 of its 8 frames -> 16-frame clip)
  const cw = poseOf(rig, viewPose(rig, walk[f], 'side'), 'chest').rot, ch = poseOf(rig, viewPose(rig, wh.poses[f], 'side'), 'chest').rot;
  assert.ok(Math.abs(ch - cw - -9) < 1.5, `chest ${cw} -> ${ch}`);
  assert.ok(Math.abs(poseOf(rig, viewPose(rig, wh.poses[f], 'side'), 'thigh_f').rot - poseOf(rig, viewPose(rig, walk[f], 'side'), 'thigh_f').rot) < 1e-6);
  assert.ok(wh.events.some((x) => x.name === 'hit'), 'layer events (events:true)');
  // a new clip: validation + save + info
  const c = e.run('anim_clip', { skeleton: 'hd', name: 'aim_flinch', layers: [{ clip: 'aim' }, { clip: 'flinch', additive: true }], frames: 8, fps: 16, loop: false, events: [{ t: 0.5, name: 'shout' }] });
  assert.equal(c.frames, 8);
  assert.throws(() => e.run('anim_clip', { skeleton: 'hd', name: 'bad', layers: [{ clip: 'nope' }] }), /no clip "nope"/);
  assert.throws(() => e.run('anim_clip', { skeleton: 'hd', name: 'bad', layers: [{ clip: 'walk', mask: 'tentacles' }] }), /neither a mask/);
});

test('retarget: rotations carry over, translations scale with hip height, named poses inline (with their carry)', () => {
  const e = new Engine({ home: tmp() });
  library(e);
  e.run('anim_skeleton', { name: 'tall', template: 'humanoid_hd', frame: [96, 144], weapon: { class: 'rifle' } });
  const r = e.run('anim_retarget', { clip: 'walk', from: 'hd', to: 'tall', name: 'walk_from_hd' });
  assert.ok(r.clips[0].scale > 1.3 && r.clips[0].scale < 1.7, JSON.stringify(r));
  const src = JSON.parse(fs.readFileSync(path.join(e.home, 'library', 'skeletons', 'hd.json'), 'utf8'));
  const out = JSON.parse(fs.readFileSync(path.join(e.home, 'library', 'clips', 'tall', 'walk_from_hd.json'), 'utf8'));
  const k0 = out.keys[0], P = src.def.poses.walk_contact;
  assert.equal(k0.parts.thigh_f.rot, P.thigh_f.rot);
  assert.ok(Math.abs(k0.parts.pelvis.y - P.pelvis.y * r.clips[0].scale) < 0.01);
  // a retargeted aim keeps its carry state; rendered on a tall skin the feet stay planted
  e.run('anim_retarget', { clip: 'aim', from: 'hd', to: 'tall', name: 'aim_from_hd' });
  assert.equal(JSON.parse(fs.readFileSync(path.join(e.home, 'library', 'clips', 'tall', 'aim_from_hd.json'), 'utf8')).keys[0].carry, 'aim');
  e.run('anim_skin', { name: 't', skeleton: 'tall' });
  paint(e, 't');
  const a = e.run('anim_render', { skin: 't', clip: 'walk_from_hd', view: 'side', canvas: 'tw', constraints: 'off' });
  const d = e.get('tw');
  const lows = [...Array(a.frames[1] - a.frames[0] + 1).keys()].map((f) => lowest(d.frameData(f), 96, 144));
  assert.ok(Math.max(...lows) - Math.min(...lows) <= 2, `feet rows ${lows}`);
});

test('batch: skins x loadouts x clips x views -> strips + manifest (auto padding for the barrel, anchor, events, order, __front)', () => {
  const e = new Engine({ home: tmp() });
  library(e);
  e.run('anim_skin', { name: 'mec', skeleton: 'hd', proportions: 'heavy', parts: { head: { variants: ['blink', 'helmet'] } }, equipment: { pack: { part: 'gear_back' }, helmet: { variant: 'helmet' } }, loadouts: { light: { equip: [] }, heavy: { equip: ['pack', 'helmet'] } } });
  paint(e, 'mec', { gear: true });
  const out = tmp();
  const b = e.run('anim_batch', { skins: ['mec'], loadouts: 'all', clips: ['aim', 'reload'], views: ['side', 'front'], out, front: 'auto' });
  assert.deepEqual(Object.keys(b.sets).sort(), ['mec_heavy', 'mec_light']);
  const man = JSON.parse(fs.readFileSync(path.join(out, 'manifest', 'characters.json'), 'utf8'));
  const S = man.sprites.mec_heavy;
  assert.ok(S.frame[0] > 64 && S.pad[0] === S.pad[2] && S.pad[0] % 2 === 0, `side barrel fits: frame ${S.frame} pad ${S.pad}`);
  assert.equal(S.anchor[0], 32 + S.pad[0]);
  const A = S.anims.reload_side;
  assert.equal(A.frames, 24);
  assert.deepEqual(A.events.map((x) => x.name), ['mag_out', 'mag_pouch', 'mag_in', 'charge', 'ready']);
  assert.ok(A.order.length >= 1 && A.order[0].frame === 0 && A.order[0].parts.includes('chest'));
  const png = decodePNG(fs.readFileSync(path.join(out, A.file)));
  assert.equal(png.width, 24 * S.frame[0]);
  assert.equal(png.height, S.frame[1]);
  // nothing touches the strip edge columns of a frame (the frame is big enough)
  for (let f = 0; f < 24; f++) for (let y = 0; y < png.height; y++) for (const x of [f * S.frame[0], (f + 1) * S.frame[0] - 1]) assert.equal(png.data[(y * png.width + x) * 4 + 3], 0, `frame ${f} touches its edge`);
  assert.ok(A.front && fs.existsSync(path.join(out, A.front)), 'front split strip');
  // loadouts: the pack (gear_back) only in heavy, the helmet variant only in heavy
  // body + __front strips together (the head goes to the front strip when it is drawn over the stock)
  const first = (set) => { const X = man.sprites[set].anims.aim_side; const b = decodePNG(fs.readFileSync(path.join(out, X.file))).data; if (!X.front) return b; const f = decodePNG(fs.readFileSync(path.join(out, X.front))).data; return Uint8ClampedArray.from([...b, ...f]); };
  assert.ok(count(first('mec_heavy'), PAL.gear) > 0 && count(first('mec_light'), PAL.gear) === 0, 'pack equipped only in heavy');
  assert.ok(count(first('mec_heavy'), '#ffff00') > 0 && count(first('mec_light'), '#ffff00') === 0, `helmet only in heavy: ${count(first('mec_heavy'), '#ffff00')} / ${count(first('mec_light'), '#ffff00')} head ${count(first('mec_heavy'), PAL.head)}`);
  // a broad skin aiming away from the camera still shows the gun (and the hands on the grips)
  const ab = e.run('anim_render', { skin: 'mec', clip: 'aim', view: 'back', loadout: 'heavy' });
  assert.equal(ab.weapon.pass, true, JSON.stringify(ab.weapon));
  // a second batch merges into the same manifest
  e.run('anim_skin', { name: 'sev', skeleton: 'hd', proportions: 'lean' });
  paint(e, 'sev');
  e.run('anim_batch', { skins: ['sev'], clips: ['idle'], views: ['side'], out });
  const man2 = JSON.parse(fs.readFileSync(path.join(out, 'manifest', 'characters.json'), 'utf8'));
  assert.ok(man2.sprites.mec_heavy && man2.sprites.sev.anims.idle_side);
  // a bad pad or view is refused before anything is rendered (a negative pad sheared the strips)
  for (const pad of [-4, 2.5, [1, 2], 'big']) assert.throws(() => e.run('anim_batch', { skins: ['sev'], clips: ['idle'], views: ['side'], out, pad }), /pad must be/);
  assert.throws(() => e.run('anim_batch', { skins: ['sev'], clips: ['idle'], views: ['../x'], out }), /unknown view/);
});

test('glTF skin export: one joint per part, skinned quads, clips as animations with events', () => {
  const e = new Engine({ home: tmp() });
  library(e);
  e.run('anim_skin', { name: 's', skeleton: 'hd' });
  paint(e, 's');
  const file = path.join(tmp(), 's.glb');
  const r = e.run('anim_gltf', { skin: 's', clips: ['walk', 'reload'], path: file });
  const buf = fs.readFileSync(file);
  assert.equal(buf.readUInt32LE(0), 0x46546c67);
  const jl = buf.readUInt32LE(12);
  const g = JSON.parse(buf.subarray(20, 20 + jl).toString('utf8'));
  const rig = rigOf(e, 's');
  assert.equal(g.skins[0].joints.length, rig.order.length);
  assert.equal(r.joints, rig.order.length);
  assert.deepEqual(g.animations.map((a) => a.name), ['walk', 'reload']);
  assert.equal(g.animations[0].channels.length, rig.order.length * 3);
  assert.ok(g.animations[1].extras.events.some((x) => x.name === 'mag_in'));
  const prim = g.meshes[0].primitives[0];
  assert.equal(g.accessors[prim.attributes.POSITION].count % 4, 0);
  assert.equal(g.accessors[prim.attributes.JOINTS_0].count, g.accessors[prim.attributes.POSITION].count);
});

test('depth model: arms go under the chest when behind it (back view, split at the surface), z keys flicker is caught, depth passes zcheck, UI layers endpoints', async () => {
  const e = new Engine({ home: tmp() });
  e.run('rig_create', { name: 'd', frame: [64, 96], template: 'humanoid_hd', depth: true });
  paint(e, 'd');
  const rig = rigOf(e, 'd');
  // reaching forward: from behind (back view) the arm goes away from the camera, behind the torso
  const reach = { upper_arm_b: { rot: -80 }, forearm_b: { rot: 0 } };
  const sv = solvePose(rig, reach, 'back');
  const zc = partIn(rig, 'chest', 'back').z;
  assert.ok(sv.depth.forearm_b.z < zc && sv.depth.hand_b.z < zc, JSON.stringify(sv.depth));
  assert.ok(sv.depth.upper_arm_b.split, 'the upper arm crosses the back surface: split');
  const trace = {};
  renderPose(rig, e.get('d_parts'), reach, 'back', new Map(), { trace });
  const ord = trace.order.map((x) => (x.piece ? `${x.part}:${x.piece}` : x.part));
  assert.ok(ord.indexOf('upper_arm_b:tip') < ord.indexOf('chest') && ord.indexOf('upper_arm_b:pivot') > ord.indexOf('chest'), ord.join(' '));
  // the same reach from the front_side: the far arm comes over the chest
  const fs3 = solvePose(rig, reach, 'front_side');
  const hb = fs3.depth.hand_b;
  assert.ok((hb.split ? hb.split.z[1] : hb.z) > partIn(rig, 'chest', 'front_side').z, JSON.stringify(hb));
  // an explicit z key wins over depth
  const P = resolvePose(rig, { parts: reach, z: { hand_b: 9 } });
  assert.equal(poseOf(rig, solvePose(rig, P, 'back').VP, 'hand_b').z, 9);
  // presets pass zcheck with depth (hysteresis: no flicker)
  const ok = e.run('rig_zcheck', { name: 'd', clips: ['walk', 'run'], views: ['front', 'front_side', 'back'] });
  assert.equal(ok.pass, true, ok.summary);
  // alternating z keys flicker: caught
  e.run('rig_update', { name: 'd', depth: false, presets: { flick: { keys: [0, 1, 2, 3, 4, 5].map((i) => ({ parts: { upper_arm_b: { rot: -30 }, forearm_b: { rot: -60 } }, z: { forearm_b: i % 2 ? 9 : -9, hand_b: i % 2 ? 9 : -9 }, ease: 'step' })), frames: 6, fps: 8, loop: true } } });
  const bad = e.run('rig_zcheck', { name: 'd', clips: ['flick'], views: ['side'] });
  assert.equal(bad.pass, false);
  assert.match(bad.issues[0].issues.join(), /z-flicker/);
  // the web UI's Layers endpoints are served by the solved ops: per-frame stacks with the depth rule
  const { rigLayers, rigDebugRender } = await import('../src/rigdebug.js');
  e.run('rig_update', { name: 'd', depth: true, presets: { reach: { keys: [{ parts: reach }], frames: 2, fps: 8, loop: false } } });
  e.run('rig_animate', { name: 'd', preset: 'reach', view: 'back', canvas: 'dr' });
  const L = rigLayers(e, 'd', { canvas: 'dr', tag: 'reach_back' });
  assert.match(L.source, /^rig_layers/);
  assert.equal(L.view, 'back');
  assert.equal(L.frames.length, 2);
  const fe = L.frames[0].stack.find((s) => s.part === 'forearm_b');
  assert.match(fe.rule, /^depth: below vs chest/);
  assert.deepEqual(L.frames[0].stack.filter((s) => !s.hidden).map((s) => s.z), L.frames[0].stack.filter((s) => !s.hidden).map((s) => s.z).sort((a, b) => a - b));
  const D = rigDebugRender(e, 'd', { canvas: 'dr', tag: 'reach_back', frame: '1' });
  assert.match(D.source, /^rig_debug_render/);
  assert.deepEqual(D.size, [64, 96]);
  assert.equal(decodePNG(Buffer.from(D.atlas, 'base64')).height, 96 * D.atlas_parts.length);
  assert.ok(D.atlas_parts.indexOf('forearm_b') < D.atlas_parts.indexOf('chest'), 'atlas in draw order');
  assert.ok(rigLayers(e, 'd', { view: 'front' }).frames.length === 1);
  // order metadata in the animation + spritesheet json
  e.run('rig_update', { name: 'd', depth: true });
  e.run('rig_animate', { name: 'd', preset: 'walk', view: 'back', canvas: 'dw' });
  assert.equal(e.get('dw').meta.order.walk_back.length, 16);
  const x = e.run('export_animation', { canvas: 'dw', format: 'spritesheet', path: path.join(tmp(), 'dw') });
  const js = JSON.parse(fs.readFileSync(x.json, 'utf8'));
  assert.ok(Object.values(js.frames)[0].order.includes('chest'));
});

test('linked cells, shared art, hidden-by-default parts, consistency and derive', () => {
  const e = new Engine({ home: tmp() });
  e.run('rig_create', {
    name: 'l', frame: [32, 32], views: ['side', 'back'], root: [16, 8], parts: {
      body: { w: 6, h: 10, pivot: [3, 0] },
      arm: { w: 3, h: 8, pivot: [1, 0], parent: 'body', at: [0, 2], link: { back: { view: 'side', flip: true } } },
      prop: { w: 4, h: 4, pivot: [2, 0], parent: 'body', at: [0, 9] },
      held: { art: 'prop', parent: 'arm', at: [0, 7], hide: true },
    },
  });
  const rig = rigOf(e, 'l');
  assert.ok(!e.run('rig_info', { name: 'l' }).cells.side.held, 'shared art has no own cell');
  const c = e.run('rig_info', { name: 'l' }).cells;
  e.run('draw', { canvas: 'l_parts', layer: 'parts', commands: [{ op: 'rect', x: c.side.body[0], y: c.side.body[1], w: 6, h: 10, color: '#00ff00' }, { op: 'rect', x: c.side.arm[0], y: c.side.arm[1], w: 3, h: 8, color: '#ff0000' }, { op: 'rect', x: c.side.prop[0], y: c.side.prop[1], w: 4, h: 4, color: '#0000ff' }] });
  const d = e.get('l_parts');
  const back = renderPose(rig, d, {}, 'back', new Map());
  assert.ok(count(back, '#ff0000') > 0, 'the back view draws the linked side cell');
  // held is hidden until a pose shows it; then it draws the prop's cell
  const blue0 = count(renderPose(rig, d, {}, 'side', new Map()), '#0000ff');
  const blue1 = count(renderPose(rig, d, { held: { hide: false }, prop: { hide: true } }, 'side', new Map()), '#0000ff');
  assert.equal(blue0, 16);
  assert.equal(blue1, 16);
  // consistency: body and prop are empty in "back"; derive copies them
  const r = e.run('rig_consistency', { name: 'l' });
  assert.equal(r.pass, false);
  assert.ok(r.issues.some((i) => i.part === 'body' && i.view === 'back' && i.kind === 'empty'));
  assert.ok(!r.issues.some((i) => i.part === 'arm'), 'linked views are not drawn: not empty');
  const dv = e.run('rig_derive', { name: 'l', from: 'side', to: ['back'] });
  assert.ok(dv.copied.includes('body/back'));
  // palette drift and bone length drift are reported
  e.run('draw', { canvas: 'l_parts', layer: 'parts', commands: [{ op: 'rect', x: c.back.body[0], y: c.back.body[1], w: 6, h: 10, color: '#123456' }, { op: 'rect', x: c.back.body[0], y: c.back.body[1] + 6, w: 6, h: 4, color: '#00000000' }] });
  const r2 = e.run('rig_consistency', { name: 'l' });
  assert.ok(r2.issues.some((i) => i.part === 'body' && i.kind === 'palette'), JSON.stringify(r2.issues));
  assert.ok(r2.issues.some((i) => i.part === 'body' && i.kind === 'length'), JSON.stringify(r2.issues));
  assert.throws(() => e.run('rig_create', { name: 'bad', frame: [8, 8], parts: { a: { w: 2, h: 2, link: { back: 'side' } } } }), /unknown view "back"/);
});

test('stable rotation: sub-step wobble renders identical frames; events land on frames', () => {
  const e = new Engine({ home: tmp() });
  e.run('rig_create', { name: 'st', frame: [48, 48], views: ['side'], root: [24, 4], sampling: 'rotsprite', parts: { stick: { w: 3, h: 40, pivot: [1, 0] } } });
  const c = e.run('rig_info', { name: 'st' }).cells.side.stick;
  e.run('draw', { canvas: 'st_parts', layer: 'parts', commands: [{ op: 'rect', x: c[0], y: c[1], w: 3, h: 40, color: '#ff0000' }, { op: 'rect', x: c[0] + 1, y: c[1], w: 1, h: 40, color: '#00ff00' }] });
  const keys = [0, 1.2, -1.1, 1.3].map((rot) => ({ parts: { stick: { rot } }, ease: 'step' }));
  e.run('rig_animate', { name: 'st', animation: 'wob', keys, frames: 4, canvas: 'w1', stable: true, events: [{ t: 0.5, name: 'mid' }] });
  e.run('rig_animate', { name: 'st', animation: 'wob', keys, frames: 4, canvas: 'w2' });
  const a = e.get('w1'), b = e.get('w2');
  const same = (d, i, j) => Buffer.compare(Buffer.from(d.frameData(i)), Buffer.from(d.frameData(j))) === 0;
  assert.ok(same(a, 0, 1) && same(a, 0, 2) && same(a, 0, 3), 'stable: one drawing');
  assert.ok(!same(b, 0, 1) || !same(b, 0, 2), 'unstable: the wobble shows');
  assert.deepEqual(a.meta.events.wob, [{ frame: 2, name: 'mid' }]);
});

test('export: layout "files" writes one strip per tag; bare relative paths are reported, ./ paths go to the working directory', () => {
  const cwd = tmp();
  const e = new Engine({ home: tmp(), cwd });
  e.run('rig_create', { name: 'h', frame: [32, 48], template: 'humanoid_hd' });
  paint(e, 'h');
  e.run('rig_animate', { name: 'h', preset: 'walk', canvas: 'hw' });
  e.run('rig_animate', { name: 'h', preset: 'idle', canvas: 'hw' });
  const rows = e.run('export_animation', { canvas: 'hw', format: 'spritesheet' });
  assert.equal(rows.rows, 2);
  assert.match(rows.layout_note, /layout:"files"/);
  const f = e.run('export_animation', { canvas: 'hw', format: 'spritesheet', layout: 'files', path: './sheets/hw' });
  assert.equal(f.strips, 2);
  for (const p of f.files) {
    assert.ok(p.startsWith(cwd), `${p} under ${cwd}`);
    const png = decodePNG(fs.readFileSync(p));
    assert.equal(png.height, 48);
  }
  assert.equal(decodePNG(fs.readFileSync(f.files.find((p) => /walk_side/.test(p)))).width, 16 * 32);
  const rel = e.run('export_animation', { canvas: 'hw', format: 'spritesheet', animation: 'walk_side', path: 'chars/hw' });
  assert.match(rel.note, /workspace exports folder/);
  assert.ok(rel.png.startsWith(e.exportDir));
});

test('front-view aim reads as aimed at the viewer; reload is a readable mag-out -> pouch -> mag-in -> charge sequence', () => {
  const e = new Engine({ home: tmp() });
  e.run('rig_create', { name: 'g', frame: [64, 96], template: 'humanoid_hd', weapon: { class: 'rifle', attachments: { vgrip: 'vertical_grip' } } });
  paint(e, 'g');
  const rig = rigOf(e, 'g');
  // front aim: short barrel canted toward the centre line, muzzle within the chest, gun over the
  // forearms and under the hands, cheek on the stock (head tilt)
  const sv = solvePose(rig, resolvePose(rig, { pose: 'aim' }), 'front');
  const R = sv.weapon, pv = partIn(rig, 'weapon', 'side').pivot, mz = rig.weapon.points.muzzle;
  const mx = R.scr({ x: mz.x - pv[0], y: mz.y - pv[1] })[0];
  assert.equal(R.canted, 'inward');
  assert.ok(Math.abs(mx - sv.world.chest.x) < rig.parts.chest.w / 2, `muzzle x ${mx} vs chest ${sv.world.chest.x}`);
  assert.match(R.layer.reason, /over the forearms and the trigger hand/);
  const z = (n) => poseOf(rig, sv.VP, n).z ?? partIn(rig, n, 'front').z;
  // forearms < trigger hand (behind the receiver) < gun < support hand (forward on the handguard)
  assert.ok(z('weapon') > z('forearm_f') && z('weapon') > z('forearm_b') && z('weapon') > z('hand_f') && z('weapon') < z('hand_b'), ['forearm_f', 'forearm_b', 'hand_f', 'weapon', 'hand_b'].map((n) => ` ${z(n)}`).join(', '));
  assert.ok(Math.abs(R.weld) > 2, `head tilt ${R.weld}`);
  // reload: events in order, the mag leaves the gun into the hand and comes back
  const def = e.get('g_parts').meta.rig, pr = def.presets.reload;
  const poses = animatePoses(rig, { keys: pr.keys, frames: 24, loop: false });
  const ev = Object.fromEntries(pr.events.map((x) => [x.name, Math.round(x.t * 23)]));
  assert.ok(ev.mag_out < ev.mag_pouch && ev.mag_pouch < ev.mag_in && ev.mag_in < ev.charge);
  const S = poses.map((P) => solvePose(rig, P, 'side'));
  const inHand = S.map((s) => !poseOf(rig, s.VP, 'mag_hand').hide && poseOf(rig, s.VP, 'mag').hide);
  for (let f = 0; f < 24; f++) assert.equal(inHand[f], f > ev.mag_out - 1 && f < ev.mag_in, `frame ${f}: mag ${inHand[f] ? 'in the hand' : 'in the gun'}`);
  // pouch: the support hand at the chest; charge: at the charging handle
  const W = S[ev.mag_pouch].world, chest = W.chest;
  assert.ok(Math.hypot(W.hand_b.x - chest.x, W.hand_b.y - chest.y) < rig.parts.chest.h, 'support hand at the chest pouch');
  const C = S[ev.charge], cp = rig.weapon.points.charge, ch = C.weapon.scr({ x: cp.x - pv[0] - 6 * (60 / 98), y: cp.y - pv[1] });
  assert.ok(Math.hypot(C.world.hand_b.x - ch[0], C.world.hand_b.y - ch[1]) < 8, 'support hand on the charging handle');
  // the reload carry reads differently from ready_low: muzzle up at the chest vs muzzle down
  assert.ok(S[ev.mag_pouch].weapon.s.theta < -15 && solvePose(rig, { carry: 'ready_low' }, 'side').weapon.s.theta > 10);
  // the template still passes the weapon check with the new sequence
  const chk = e.run('rig_check', { name: 'g', clips: ['reload', 'aim'] });
  assert.equal(chk.pass, true, chk.summary);
});
