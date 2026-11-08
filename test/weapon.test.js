// Weapon handling for 2D rigs (art_rig weapon): grips, reach, dead zone, carry states, mirroring,
// visibility, front-view readability, validation, layering, plus the humanoid_hd view fixes,
// equipment variant sets, compact replies and the HD critique budget.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Engine } from '../src/engine.js';
import { normalizeRig, solvePose, animatePoses, resolvePose, cellOf } from '../src/rig.js';
import { weaponMetrics, weaponArt } from '../src/weapon.js';
import { TOOLS } from '../src/mcp.js';
import { critiqueImage } from '../src/critique.js';
import { decodePNG } from '../src/png.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'agent-art-weapon-'));
const VIEWS = ['side', 'front_side', 'front', 'back_side', 'back'];
const ALL = [...VIEWS, 'side_left', 'front_side_left', 'back_side_left'];
const COLORS = { head: '#d8a888', weapon: '#202024', att: '#c020c0', hand: '#e0a070', arm: '#708050', leg: '#405070', foot: '#302010', body: '#506838' };
const kind = (k) => (k.startsWith('head') ? 'head' : k === 'weapon' ? 'weapon' : k.startsWith('att_') ? 'att' : /hand/.test(k) ? 'hand' : /arm/.test(k) ? 'arm' : /foot/.test(k) ? 'foot' : /thigh|shin/.test(k) ? 'leg' : 'body');

/** A humanoid_hd soldier with every cell filled (weapon + attachments only in the side row). */
function soldier(e, name, opts = {}) {
  const r = e.run('rig_create', { name, frame: opts.frame || [128, 192], template: 'humanoid_hd', ...opts.create });
  const cmds = [];
  for (const v of Object.keys(r.cells)) for (const [k, [x, y, w, h]] of Object.entries(r.cells[v])) {
    if ((k === 'weapon' || k.startsWith('att_')) && v !== 'side') continue;
    if (['cape', 'gear_back', 'gear_hip'].includes(k)) continue;
    const inset = k === 'weapon' || k.startsWith('att_') ? 0 : Math.floor(w * 0.16);
    const iy = k === 'weapon' ? Math.floor(h * 0.25) : 0;
    cmds.push({ op: 'rect', x: x + inset, y: y + iy, w: Math.max(1, w - 2 * inset), h: Math.max(1, h - 2 * iy), color: COLORS[kind(k)] });
  }
  e.run('draw', { canvas: `${name}_parts`, layer: 'parts', commands: cmds });
  return r;
}
/** The rig as the ops see it (normalized + drawn art for collision). */
function rigOf(e, name) {
  const d = e.get(`${name}_parts`);
  const rig = normalizeRig(d.meta.rig);
  const saved = d.layers; d.layers = saved.filter((l) => l.name !== 'cells');
  const comp = d.composite(); d.layers = saved;
  if (rig.weapon) weaponArt(rig, comp, d.width, cellOf);
  return rig;
}
const metrics = (rig, pose, view) => weaponMetrics(rig, solvePose(rig, pose, view));
const count = (data, rgb) => { let n = 0; for (let i = 0; i < data.length; i += 4) if (data[i + 3] && data[i] === rgb[0] && data[i + 1] === rgb[1] && data[i + 2] === rgb[2]) n++; return n; };
const GUN = [0x20, 0x20, 0x24];

test('complaint "grip not held": the support hand sits on the vertical grip attachment in every view and carry state', () => {
  const e = new Engine({ home: tmp() });
  soldier(e, 'vg', { create: { weapon: { class: 'rifle', attachments: { vgrip: 'vertical_grip' } } } });
  const rig = rigOf(e, 'vg');
  assert.ok(rig.parts.att_vgrip && rig.parts.att_vgrip.parent === 'weapon', 'the attachment mounts on the weapon');
  for (const carry of ['aim', 'ready_low', 'ready_high', 'hip', 'sprint']) for (const v of ALL) {
    const sp = solvePose(rig, { carry }, v);
    assert.equal(sp.weapon.s.supportGrip.from, 'vgrip', `${carry}: support grip moved to the attachment`);
    const m = weaponMetrics(rig, sp);
    assert.ok(m.hand_grip.main <= 1.5 && m.hand_grip.support <= 1.5, `${carry}/${v}: hands on grips ${JSON.stringify(m.hand_grip)}`);
    assert.deepEqual(m.elbow_inverted, [], `${carry}/${v}: elbows`);
  }
  // without the attachment the support hand goes back to the handguard
  const sp = solvePose(rig, { carry: 'aim', _weapon: { attach: [] } }, 'side');
  assert.equal(sp.weapon.s.supportGrip.from, undefined);
  assert.ok(weaponMetrics(rig, sp).hand_grip.support <= 1.5);
  // hands orient to the grip: the trigger hand follows the weapon's angle (+ the grip rake)
  for (const carry of ['aim', 'ready_low']) {
    const s2 = solvePose(rig, { carry }, 'side');
    const want = s2.weapon.phi + rig.weapon.points.grip_main.angle;
    assert.ok(Math.abs(((s2.world.hand_f.rot - want + 540) % 360) - 180) < 0.5, `${carry}: wrist rotation ${s2.world.hand_f.rot} vs ${want}`);
  }
});

test('complaint "arms not extended enough": reach limits slide the support hand / move the weapon back, never stretch a limb', () => {
  const e = new Engine({ home: tmp() });
  // a long rifle whose handguard grip sits at the very muzzle: out of reach as authored
  soldier(e, 'lr', { create: { weapon: { class: 'dmr', points: { grip_support: { at: [80, 9], angle: -100 } } } } });
  const rig = rigOf(e, 'lr');
  const A = rig.weapon.arm.support.L1 + rig.weapon.arm.support.L2;
  for (const carry of ['aim', 'ready_low', 'hip']) {
    const sp = solvePose(rig, { carry }, 'side');
    const m = weaponMetrics(rig, sp);
    assert.ok(m.reach.support <= rig.weapon.reach + 0.006, `${carry}: support reach ${m.reach.support}`);
    assert.ok(m.corrections.some((c) => ['support_slid', 'moved_back', 'pocket_inward', 'turned'].includes(c)), `${carry}: corrected (${m.corrections})`);
    assert.ok(m.hand_grip.support <= 1.5, `${carry}: hand on the (slid) grip`);
    // bones keep their length in the side view (no stretching)
    const W = sp.world, l1 = Math.hypot(W.forearm_b.x - W.upper_arm_b.x, W.forearm_b.y - W.upper_arm_b.y);
    assert.ok(l1 <= rig.weapon.arm.support.L1 + 0.01, 'upper arm not stretched');
    assert.ok(Math.hypot(sp.weapon.s.arms.support.W[0] - sp.weapon.s.arms.support.S[0], sp.weapon.s.arms.support.W[1] - sp.weapon.s.arms.support.S[1]) <= A + 1e-6);
  }
  // a fixed foregrip (no rail to slide on) far out of reach is flagged, and animate refuses it
  e.run('rig_update', { name: 'lr', weapon: { class: 'dmr', points: { grip_support: { at: [80, 9], angle: -100, slide: false } }, reach: 0.7 }, parts: {} });
  const bad = rigOf(e, 'lr');
  const m = metrics(bad, { carry: 'aim' }, 'side');
  assert.ok(m.reach.support > bad.weapon.reach || m.corrections.includes('out_of_reach'), JSON.stringify(m));
  assert.throws(() => e.run('rig_animate', { name: 'lr', preset: 'aim', view: 'side', canvas: 'lr_aim' }), /weapon constraints: .*(over-extended|out of reach).*Nothing was written/);
  assert.equal(e.docs.has('lr_aim'), false, 'refused: no canvas written');
  const w = e.run('rig_animate', { name: 'lr', preset: 'aim', view: 'side', canvas: 'lr_aim', constraints: 'warn' });
  assert.equal(w.weapon.pass, false);
  assert.ok(e.docs.has('lr_aim'));
});

test('complaint "rifle through the torso": the dead zone pushes the weapon out (forward first) and keeps a chest standoff; draw order follows depth', () => {
  const e = new Engine({ home: tmp() });
  soldier(e, 'tt', { create: { weapon: { class: 'rifle', states: { jammed: { base: 'hip', at: [-0.1, 0.45], angle: 0, lateral: 0 } } } } });
  const rig = rigOf(e, 'tt');
  const sp = solvePose(rig, { carry: 'jammed' }, 'side');
  const m = weaponMetrics(rig, sp);
  assert.ok(m.corrections.some((c) => /^pushed_(forward|out)$|^pulled_in$/.test(c)), `pushed out: ${m.corrections}`);
  assert.ok(m.penetration <= 1, `penetration ${m.penetration}`);
  assert.ok(sp.weapon.s.pen <= 0.6 + 1e-6);
  // every built-in state clears the body in the base view
  for (const st of rig.weapon.states && Object.keys(rig.weapon.states)) if (st !== 'jammed') assert.ok(metrics(rig, { carry: st }, 'side').penetration <= 1, st);
  // the reported case: authored weapon z under the torso in "side", held at low ready in front of it
  e.run('rig_update', { name: 'tt', parts: { weapon: { views: { side: { z: -5 } } } } });
  const low = rigOf(e, 'tt');
  const s2 = solvePose(low, { carry: 'ready_low' }, 'side');
  assert.ok(s2.weapon.layer.front, 'held in front of the torso');
  assert.ok(s2.VP.weapon.z > 3, `drawn over the chest (z ${s2.VP.weapon.z})`);
  assert.deepEqual(weaponMetrics(low, s2).layer, []);
  const lay = e.run('rig_layers', { name: 'tt', pose: 'idle_exhale', carry: 'ready_low', view: 'side' });
  const order = lay.order.map((x) => x[0]);
  assert.ok(order.indexOf('weapon') > order.indexOf('chest'), 'layers: weapon above the chest');
  assert.match(lay.order.find((x) => x[0] === 'weapon')[2], /in front of the torso/);
  const ex = e.run('rig_explain', { name: 'tt', pose: 'idle_exhale', carry: 'ready_low', view: 'side', part_a: 'chest', part_b: 'weapon' });
  assert.equal(ex.over, 'weapon');
  // a pin forces it back under (explicit rule), and the validator reports it
  e.run('rig_update', { name: 'tt', weapon: { class: 'rifle', layer: { pin: { side: 'back' } } } });
  const pinned = rigOf(e, 'tt');
  const s3 = solvePose(pinned, { carry: 'ready_low' }, 'side');
  assert.ok(s3.VP.weapon.z < 0);
  assert.match(weaponMetrics(pinned, s3).layer.join(), /under the torso/);
});

test('complaint 1: mirror_pairs keeps handedness (hands + weapon stay on their side); mirror_hands swaps it on purpose', () => {
  const e = new Engine({ home: tmp() });
  soldier(e, 'mp', { create: { weapon: { class: 'rifle' } } });
  const rig = rigOf(e, 'mp');
  const def = e.get('mp_parts').meta.rig;
  const walk = animatePoses(rig, { keys: def.presets.walk.keys, frames: 16 });
  for (const [f, P] of walk.entries()) for (const v of ['side', 'front_side', 'back_side']) {
    const sp = solvePose(rig, P, v);
    assert.equal(sp.weapon.hands.main.hand, 'hand_f', `frame ${f} ${v}: trigger hand stays hand_f`);
    const m = weaponMetrics(rig, sp);
    assert.ok(m.hand_grip.main <= 1.5 && m.hand_grip.support <= 1.5, `frame ${f} ${v}: ${JSON.stringify(m.hand_grip)}`);
  }
  // the weapon is on the same side of the body in both halves of the cycle (front view x)
  const side = (P) => Math.sign(solvePose(rig, P, 'front').world.weapon.x - solvePose(rig, P, 'front').world.chest.x);
  assert.equal(side(walk[2]), side(walk[10]));
  // legs still swap
  const k = resolvePose(rig, { pose: 'walk_contact', mirror_pairs: true });
  assert.equal(k.thigh_f.rot, rig.poses.walk_contact.thigh_b.rot);
  assert.equal(k.upper_arm_f?.rot, rig.poses.walk_contact.upper_arm_f?.rot, 'held arm chain not swapped');
  // explicit mirrored handedness: the weapon moves to the other hand / shoulder
  const mh = resolvePose(rig, { pose: 'aim', mirror_hands: true });
  const s2 = solvePose(rig, mh, 'side');
  assert.equal(s2.weapon.hands.main.hand, 'hand_b');
  assert.ok(weaponMetrics(rig, s2).hand_grip.main <= 1.5);
  assert.ok(Math.sign(solvePose(rig, mh, 'front').world.weapon.x - rig.root[0]) !== Math.sign(solvePose(rig, 'aim', 'front').world.weapon.x - rig.root[0]), 'other shoulder');
  // a rig without a weapon: an IK-held hand keeps its target, free arms still swap
  e.run('rig_create', { name: 'plain', frame: [64, 96], template: 'humanoid_hd' });
  const plain = normalizeRig(e.get('plain_parts').meta.rig);
  const held = resolvePose(plain, { parts: { upper_arm_b: { rot: 30 }, thigh_f: { rot: -20 } }, ik: { hand_f: { target: [40, 40] } }, mirror_pairs: true });
  assert.deepEqual(Object.keys(held.ik), ['hand_f'], 'IK stays on the holding hand');
  assert.equal(held.thigh_b.rot, -20, 'legs swap');
  const swapped = resolvePose(plain, { parts: {}, ik: { hand_f: { target: [40, 40] } }, mirror_hands: true });
  assert.deepEqual(Object.keys(swapped.ik), ['hand_b'], 'mirror_hands swaps the hands');
});

test('complaint 2: with a weapon every preset keeps it visible (throw slings it); without one the template is unchanged', () => {
  const e = new Engine({ home: tmp() });
  soldier(e, 'vis', { create: { weapon: { class: 'rifle' } } });
  for (const p of ['idle', 'walk', 'run', 'throw', 'hurt']) {
    const r = e.run('rig_animate', { name: 'vis', preset: p, view: 'side', canvas: `vis_${p}` });
    assert.equal(r.weapon.pass, true, `${p}: ${JSON.stringify(r.weapon.issues)}`);
    const d = e.get(`vis_${p}`);
    for (let f = r.frames[0]; f <= r.frames[1]; f++) assert.ok(count(d.frameData(f), GUN) > 20, `${p} frame ${f}: weapon pixels`);
  }
  const rig = rigOf(e, 'vis');
  assert.equal(solvePose(rig, 'throw_release', 'side').weapon.s.pl.name, 'slung');
  assert.equal(solvePose(rig, 'run_pass', 'side').weapon.s.pl.name, 'sprint');
  // pistol: holstered on throw is an explicit state; low ready otherwise
  soldier(e, 'pis', { create: { weapon: { class: 'pistol' } } });
  const pr = rigOf(e, 'pis');
  assert.equal(solvePose(pr, 'throw_release', 'side').weapon.s.pl.name, 'holster');
  assert.equal(solvePose(pr, 'walk_pass', 'side').weapon.s.pl.name, 'low');
  // the cup: the support hand wraps the trigger hand
  const sp = solvePose(pr, { carry: 'aim' }, 'side');
  assert.ok(Math.hypot(sp.world.hand_b.x - sp.world.hand_f.x, sp.world.hand_b.y - sp.world.hand_f.y) < 12, 'support hand cups the trigger hand');
  // no weapon setting: the template's old behaviour (weapon hidden outside aim / reload)
  e.run('rig_create', { name: 'old', frame: [64, 96], template: 'humanoid_hd' });
  const def = e.get('old_parts').meta.rig;
  assert.equal(def.weapon, undefined);
  assert.equal(def.poses.walk_pass.weapon.hide, true);
});

test('complaint 3: front views keep the weapon readable (yaw cant + foreshortening floor)', () => {
  const e = new Engine({ home: tmp() });
  soldier(e, 'fv', { create: { weapon: { class: 'rifle' } } });
  const rig = rigOf(e, 'fv');
  const front = solvePose(rig, { carry: 'aim' }, 'front');
  assert.ok(front.weapon.canted, 'pointing at the camera: canted');
  assert.ok(front.weapon.L >= rig.weapon.foreshorten.floor - 1e-9, `length ${front.weapon.L}`);
  const side = renderCount(e, 'fv', 'side'), fr = renderCount(e, 'fv', 'front');
  assert.ok(fr >= side * 0.3, `front weapon pixels ${fr} vs side ${side}`);
  // floor off: the barrel collapses toward a dot
  e.run('rig_update', { name: 'fv', weapon: { class: 'rifle', foreshorten: false } });
  const off = solvePose(rigOf(e, 'fv'), { carry: 'aim' }, 'front');
  assert.ok(off.weapon.L < 0.1);
});
function renderCount(e, name, view) {
  e.run('rig_animate', { name, animation: `c_${view}`, view, keys: [{ pose: 'aim' }], frames: 1, loop: false, canvas: `${name}_c_${view}`, carry: 'aim', constraints: 'off' });
  return count(e.get(`${name}_c_${view}`).frameData(0), GUN);
}

test('complaint 4: animate variant renders every part with an equipment set (no sheet swapping)', () => {
  const e = new Engine({ home: tmp() });
  e.run('rig_create', {
    name: 'arm', frame: [16, 16], views: ['side'], root: [8, 8],
    parts: { body: { w: 4, h: 4, pivot: [2, 2], variants: ['heavy'] }, head: { w: 4, h: 4, pivot: [2, 3], parent: 'body', at: [0, -2], variants: ['helmet', 'blink', 'helmet_blink'] } },
    variant_sets: { heavy: { body: 'heavy', head: 'helmet' } },
  });
  const c = e.run('rig_info', { name: 'arm' }).cells.side;
  const fill = (k, color) => { const [x, y, w, h] = c[k]; return { op: 'rect', x, y, w, h, color }; };
  e.run('draw', { canvas: 'arm_parts', layer: 'parts', commands: [fill('body', '#ff0000'), fill('body:heavy', '#00ff00'), fill('head', '#0000ff'), fill('head:helmet', '#ffff00'), fill('head:blink', '#00ffff'), fill('head:helmet_blink', '#ff00ff')] });
  e.run('rig_animate', { name: 'arm', animation: 'base', keys: [{ parts: {} }], frames: 1, canvas: 'a1' });
  e.run('rig_animate', { name: 'arm', animation: 'heavy', keys: [{ parts: {} }, { parts: { head: { variant: 'blink' } } }], frames: 2, canvas: 'a2', variant: 'heavy' });
  const f0 = e.get('a1').frameData(0), h0 = e.get('a2').frameData(0), h1 = e.get('a2').frameData(1);
  assert.ok(count(f0, [255, 0, 0]) && count(f0, [0, 0, 255]), 'base cells');
  assert.ok(count(h0, [0, 255, 0]) && count(h0, [255, 255, 0]) && !count(h0, [255, 0, 0]), 'heavy set: body + helmet');
  assert.ok(count(h1, [255, 0, 255]), 'pose variant blink combines with the set: helmet_blink');
  // a set name that is a plain part variant works too; unknown sets are rejected
  e.run('rig_animate', { name: 'arm', animation: 'h2', keys: [{ parts: {} }], frames: 1, canvas: 'a3', variant: 'helmet' });
  assert.ok(count(e.get('a3').frameData(0), [255, 255, 0]));
  assert.throws(() => e.run('rig_animate', { name: 'arm', animation: 'x', keys: [{ parts: {} }], variant: 'nope' }), /no set or part variant/);
});

test('complaint 5: art_rig info/create/update and art_info reply compactly; full:true / fields give the tables', async () => {
  const e = new Engine({ home: tmp() });
  const call = (op, a) => e.run(op, a);
  const rigTool = TOOLS.find((t) => t.name === 'art_rig'), infoTool = TOOLS.find((t) => t.name === 'art_info');
  const created = await rigTool.run(call, { action: 'create', name: 'big', frame: [128, 192], template: 'humanoid_hd', weapon: { class: 'rifle' } });
  const createdFull = e.run('rig_info', { name: 'big' });
  assert.ok(JSON.stringify(created).length < 9000, `create ${JSON.stringify(created).length} chars`);
  // compact cells rebuild the full table exactly
  for (const [v, parts] of Object.entries(createdFull.cells)) for (const [k, cell] of Object.entries(parts)) assert.deepEqual([created.cells.parts[k][0], created.cells.rows[v], created.cells.parts[k][1], created.cells.parts[k][2]], cell, `${v}/${k}`);
  const info = await rigTool.run(call, { action: 'info', name: 'big' });
  const full = await rigTool.run(call, { action: 'info', name: 'big', full: true });
  assert.ok(JSON.stringify(full).length > 30000, `full ${JSON.stringify(full).length}`);
  assert.ok(JSON.stringify(info).length < 8000, `info ${JSON.stringify(info).length} chars`);
  assert.ok(Array.isArray(info.poses) && info.presets.walk.frames === 16 && info.weapon.class === 'rifle');
  const only = await rigTool.run(call, { action: 'info', name: 'big', fields: ['poses'] });
  assert.deepEqual(Object.keys(only).sort(), ['poses', 'rig']);
  assert.deepEqual(only.poses, full.poses);
  const upd = await rigTool.run(call, { action: 'update', name: 'big', parts: { head: { w: 30 } } });
  assert.ok(JSON.stringify(upd).length < 4000);
  // art_info on the parts canvas (whole rig in meta) and an animation canvas (per-frame anchors)
  soldier(e, 'sz', { create: { weapon: { class: 'rifle' } } });
  e.run('rig_animate', { name: 'sz', preset: 'walk', view: 'side', canvas: 'sz_walk' });
  for (const c of ['sz_parts', 'sz_walk']) {
    const s = await infoTool.run(call, { canvas: c }), f = await infoTool.run(call, { canvas: c, full: true });
    assert.ok(JSON.stringify(f).length > 5000, `${c} full ${JSON.stringify(f).length}`);
    assert.ok(JSON.stringify(s).length < 2500, `${c} summary ${JSON.stringify(s).length} chars`);
    assert.deepEqual(f, e.run('info', { canvas: c }), 'full = the engine reply (the UI keeps it)');
  }
  const s = await infoTool.run(call, { canvas: 'sz_walk' });
  assert.equal(s.animations.walk_side.frames, 16);
  assert.equal(s.meta.anchors.walk_side, '16 frames');
});

test('complaint 6: art_critique colour budget scales with size (<= 32 low-res, 48-128 HD); HD ordered dithering is not noise', () => {
  const sprite = (w, h, ncol, dither = false) => {
    const d = new Uint8ClampedArray(w * h * 4);
    for (let y = Math.floor(h * 0.1); y < h * 0.9; y++) for (let x = Math.floor(w * 0.2); x < w * 0.8; x++) {
      let k = Math.floor(((y - h * 0.1) / (h * 0.8)) * ncol) % ncol;
      if (dither && (x + y) % 2) k = Math.min(ncol - 1, k + 1);
      const o = (y * w + x) * 4;
      d[o] = 40 + k * 3; d[o + 1] = 60 + ((k * 5) % 120); d[o + 2] = 90 + ((k * 7) % 100); d[o + 3] = 255;
    }
    return d;
  };
  const hd = critiqueImage(sprite(128, 192, 70), 128, 192);
  assert.ok(!hd.issues.some((i) => i.id === 'too_many_colors'), `HD 70 colours ok: ${hd.issues.map((i) => i.id)}`);
  assert.equal(hd.stats.style, 'hd');
  assert.ok(hd.stats.color_budget >= 48 && hd.stats.color_budget <= 128);
  assert.ok(critiqueImage(sprite(128, 192, 140), 128, 192).issues.some((i) => i.id === 'too_many_colors'), 'over 128 still flagged');
  const lo32 = new Uint8ClampedArray(32 * 32 * 4);
  for (let i = 0; i < 32 * 32; i++) { const k = i % 40; lo32.set([30 + k * 5, 200 - k * 4, 60 + ((k * 13) % 150), 255], i * 4); }
  const lo = critiqueImage(lo32, 32, 32, { kind: 'sprite' });
  assert.ok(lo.issues.some((i) => i.id === 'too_many_colors' && /<= (\d+)/.exec(i.message)[1] <= 32), 'low-res keeps <= 32');
  assert.equal(critiqueImage(sprite(128, 192, 70), 128, 192, { style: 'lowres' }).issues.some((i) => i.id === 'too_many_colors'), true, 'style:"lowres" forces the small budget');
  // checkerboard dither between two close shades over the whole sprite
  const dz = critiqueImage(sprite(128, 192, 8, true), 128, 192);
  assert.ok(!dz.issues.some((i) => i.id === 'noisy' || i.id === 'orphan_pixels'), `dither not noise: ${dz.issues.map((i) => i.id)}`);
  assert.ok(dz.stats.dithered > 20);
});

test('carry states, muzzle discipline and animate constraints refuse / fix / warn', () => {
  const e = new Engine({ home: tmp() });
  soldier(e, 'md', { create: { weapon: { class: 'rifle', states: { level: { base: 'ready_low', angle: 0, follow: 0 } } } } });
  const rig = rigOf(e, 'md');
  for (const st of ['ready_low', 'sprint', 'reload', 'slung']) {
    const m = metrics(rig, { carry: st }, 'side');
    assert.equal(m.muzzle, null, `${st}: muzzle down / forward-low`);
    assert.ok(solvePose(rig, { carry: st }, 'side').weapon.s.theta > 10, `${st} points down`);
  }
  assert.ok(solvePose(rig, { carry: 'ready_high' }, 'side').weapon.s.theta < -15, 'high ready: muzzle up');
  assert.match(metrics(rig, { carry: 'level' }, 'side').muzzle, /level/);
  assert.throws(() => e.run('rig_animate', { name: 'md', preset: 'idle', view: 'side', carry: 'level', canvas: 'x1' }), /weapon constraints/);
  const fixed = e.run('rig_animate', { name: 'md', preset: 'idle', view: 'side', carry: 'level', canvas: 'x2', constraints: 'fix' });
  assert.equal(fixed.weapon.pass, true, JSON.stringify(fixed.weapon));
  assert.ok(fixed.weapon.fixed > 0);
  assert.throws(() => e.run('rig_animate', { name: 'md', preset: 'idle', carry: 'nope' }), /unknown state/);
  assert.throws(() => e.run('rig_create', { name: 'bad', frame: [64, 96], template: 'humanoid_hd', weapon: { class: 'trebuchet' } }), /weapon.class/);
  // reload: the support hand leaves the gun for the hip pouch, then reaches the magazine
  const def = e.get('md_parts').meta.rig;
  const reload = animatePoses(rig, { keys: def.presets.reload.keys, frames: 24, loop: false });
  const st = reload.map((P) => weaponMetrics(rig, solvePose(rig, P, 'side')));
  assert.ok(st.some((m) => m.hand_grip.support === undefined), 'support hand free during the reload');
  assert.ok(st.every((m) => m.hand_grip.main <= 1.5), 'trigger hand stays on the grip');
});

test('art_rig check: every clip in every view passes for the rifle and pistol templates; reports per frame', () => {
  const e = new Engine({ home: tmp() });
  soldier(e, 'ck', { frame: [96, 144], create: { weapon: { class: 'rifle', attachments: { vgrip: 'vertical_grip' } } } });
  const r = e.run('rig_check', { name: 'ck', clips: ['idle', 'walk', 'aim', 'reload', 'throw'] });
  assert.equal(r.pass, true, r.summary + JSON.stringify(r.issues?.slice(0, 3)));
  assert.equal(Object.keys(r.clips.walk).length, 8, 'all 8 directions');
  assert.ok(r.worst.hand_grip <= 1.5 && r.worst.reach <= 0.99 && r.worst.penetration <= 1);
  const det = e.run('rig_check', { name: 'ck', clips: ['aim'], views: ['front'], detail: true });
  const fr = det.clips.aim.front.metrics[0];
  for (const k of ['hand_grip', 'reach', 'penetration', 'muzzle', 'visible', 'elbow_inverted']) assert.ok(k in fr, k);
  soldier(e, 'ckp', { frame: [96, 144], create: { weapon: { class: 'pistol' } } });
  assert.equal(e.run('rig_check', { name: 'ckp', clips: ['idle', 'aim', 'walk'] }).pass, true);
  e.run('rig_create', { name: 'nw', frame: [64, 96], template: 'humanoid_hd' });
  assert.throws(() => e.run('rig_check', { name: 'nw' }), /has no weapon/);
});

test('humanoid_hd fixes: near limbs on the correct screen side in 3/4, front and back; thighs over the pelvis; one tag convention; ground line at the feet', () => {
  const e = new Engine({ home: tmp() });
  e.run('rig_create', { name: 'h', frame: [128, 192], template: 'humanoid_hd' });
  const rig = normalizeRig(e.get('h_parts').meta.rig);
  const W = (v) => solvePose(rig, {}, v).world;
  // a right-facing figure turned toward the camera shows its near (_f) side on the LEFT of the
  // screen, and turned away on the RIGHT; the forward direction stays +x in the 3/4 views
  for (const [v, sign] of [['front_side', -1], ['front', -1], ['back_side', 1], ['back', 1]]) {
    for (const p of ['upper_arm_f', 'thigh_f']) assert.equal(Math.sign(W(v)[p].x - W(v).pelvis.x), sign, `${v}: ${p}`);
    for (const p of ['upper_arm_b', 'thigh_b']) assert.equal(Math.sign(W(v)[p].x - W(v).pelvis.x), -sign, `${v}: ${p}`);
  }
  for (const v of ['front', 'back']) for (const p of ['thigh_f', 'thigh_b']) assert.ok(rig.parts[p].views[v].z > rig.parts.pelvis.z, `${v}: ${p} drawn over the pelvis (no shorts look)`);
  // tags: always <preset>_<view>
  const c = e.run('rig_info', { name: 'h' }).cells;
  e.run('draw', { canvas: 'h_parts', layer: 'parts', commands: Object.values(c.side).map(([x, y, w, hh]) => ({ op: 'rect', x, y, w, h: hh, color: '#808080' })) });
  assert.equal(e.run('rig_animate', { name: 'h', preset: 'idle' }).animation, 'idle_side');
  assert.equal(e.run('rig_animate', { name: 'h', preset: 'idle', view: 'front', canvas: 'hf' }).animation, 'idle_front');
  // preview ground line: on the feet's contact row, not at the root (hip) height
  const ground = Math.max(...['foot_f', 'foot_b'].map((f) => W('side')[f].y + rig.parts[f].h - 1 - rig.parts[f].pivot[1]));
  assert.ok(ground > rig.root[1] + 40, 'feet far below the root');
  // in the rendered sheet the dashed red row sits directly under the lowest drawn (grey) pixel
  const png = decodePNG(e.run('rig_preview', { name: 'h', pose: 'idle_exhale', view: 'side', scale: 1 }).image);
  const px = (x, y) => png.data.subarray((y * png.width + x) * 4, (y * png.width + x) * 4 + 4);
  let lowGrey = -1, redRow = -1;
  for (let y = 0; y < png.height; y++) {
    let grey = 0, red = 0;
    for (let x = 0; x < png.width; x++) { const [r, g, b] = px(x, y); if (r === 128 && g === 128 && b === 128) grey++; if (r > g + 60 && r > b + 60) red++; }
    if (grey) lowGrey = y;
    if (red > 20 && redRow < 0) redRow = y;
  }
  assert.ok(lowGrey > 0 && redRow === lowGrey + 1, `ground line at row ${redRow}, feet end at ${lowGrey}`);
  const guide = fs.readFileSync(new URL('../docs/rig-hd-guide.md', import.meta.url), 'utf8');
  assert.match(guide, /tallest part cell \+ 1 px/);
  assert.match(guide, /0, 55, 110, 165, 220/);
  // the 55 px rows really are what cape:null gives
  const nc = e.run('rig_create', { name: 'nc', frame: [128, 192], template: 'humanoid_hd', parts: { cape: null } });
  assert.deepEqual(VIEWS.map((v) => nc.cells[v].pelvis[1]), [0, 55, 110, 165, 220]);
  assert.deepEqual(VIEWS.map((v) => e.run('rig_info', { name: 'h' }).cells[v].pelvis[1]), [0, 74, 148, 222, 296]);
});
