// Rigs: layout, poses, tweened animation, mirror views, variants, relayout, guide isolation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Engine } from '../src/engine.js';
import { decodePNG } from '../src/png.js';
import { normalizeRig, animatePoses, poseAnchors, solvePose, plantFeet, simulateSecondary } from '../src/rig.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'agent-art-r-'));

function makeRig(e) {
  const r = e.run('rig_create', {
    name: 'bot', frame: [16, 16], views: ['side', 'front'], mirror: { side_left: 'side' }, root: [8, 10],
    parts: {
      body: { w: 6, h: 6, pivot: [3, 5] },
      arm_f: { w: 2, h: 5, pivot: [1, 0], parent: 'body', at: [2, -4], z: 1 },
      arm_b: { w: 2, h: 5, pivot: [1, 0], parent: 'body', at: [-2, -4], z: -1 },
      eye: { w: 2, h: 2, pivot: [0, 0], parent: 'body', at: [1, -3], z: 2, variants: ['closed'], views: { front: { hidden: true } } },
    },
  });
  const c = r.cells;
  const cmds = [];
  for (const v of ['side', 'front']) {
    const [bx, by, bw, bh] = c[v].body;
    cmds.push({ op: 'rect', x: bx, y: by, w: bw, h: bh, color: v === 'side' ? '#ff0000' : '#00ff00' });
    for (const p of ['arm_f', 'arm_b']) { const [x, y, w, h] = c[v][p]; cmds.push({ op: 'rect', x, y, w, h, color: '#0000ff' }); }
    const [ex, ey] = c[v].eye;
    cmds.push({ op: 'rect', x: ex, y: ey, w: 2, h: 2, color: '#ffffff' });
    const [cx, cy] = c[v]['eye:closed'];
    cmds.push({ op: 'rect', x: cx, y: cy + 1, w: 2, h: 1, color: '#000000' });
  }
  e.run('draw', { canvas: 'bot_parts', layer: 'parts', commands: cmds });
  return r;
}

const colorsIn = (e, canvas, frame) => {
  const r = e.run('read', { canvas, frame });
  const used = new Set(r.rows.join('').split(''));
  return new Set([...used].filter((ch) => ch !== '.').map((ch) => r.legend[ch]));
};

test('rig layout validates and lists cells', () => {
  assert.throws(() => normalizeRig({ frame: [16, 16], parts: {} }), /needs "parts"/);
  assert.throws(() => normalizeRig({ frame: [16, 16], parts: { a: { w: 2, h: 2, parent: 'zz' } } }), /unknown parent/);
  assert.throws(() => normalizeRig({ frame: [16, 16], parts: { a: { w: 2, h: 2, parent: 'b' }, b: { w: 2, h: 2, parent: 'a' } } }), /cycle/);
  assert.throws(() => normalizeRig({ frame: [16, 16], views: ['side'], mirror: { left: 'front' }, parts: { a: { w: 2, h: 2 } } }), /drawn source view/);
  const e = new Engine({ home: tmp() });
  const r = makeRig(e);
  assert.deepEqual(Object.keys(r.cells), ['side', 'front']);
  assert.ok(r.cells.side['eye:closed']);
  assert.equal(e.get('bot_parts').meta.build, false);
});

test('rig preview renders views; guides never leak; variants + hidden per view', () => {
  const e = new Engine({ home: tmp() });
  makeRig(e);
  const pv = e.run('rig_preview', { name: 'bot', scale: 2 });
  assert.deepEqual(pv.views, ['side', 'front', 'side_left']);
  assert.ok(decodePNG(pv.image).width > 32);
  e.run('rig_pose', { name: 'bot', pose: 'blink', parts: { eye: { variant: 'closed' } } });
  e.run('rig_animate', { name: 'bot', animation: 'idle', view: 'side', keys: [{ pose: 'blink' }], frames: 1, loop: false });
  const used = colorsIn(e, 'bot');
  assert.ok(used.has('#000000') && !used.has('#ffffff'), 'closed eye variant used');
  assert.ok(![...used].some((c) => /^#5a8cff|^#ff3c3c/i.test(c)), 'cell guide colors must not reach frames');
  e.run('rig_animate', { name: 'bot', animation: 'front', view: 'front', keys: [{ parts: {} }], frames: 1, loop: false });
  const front = colorsIn(e, 'bot', 1);
  assert.ok(front.has('#00ff00') && !front.has('#ffffff') && !front.has('#000000'), 'front view uses its own cells and hides the eye');
  assert.throws(() => e.run('rig_pose', { name: 'bot', pose: 'x', parts: { nope: { rot: 1 } } }), /unknown part/);
  assert.throws(() => e.run('rig_pose', { name: 'bot', pose: 'x', parts: { eye: { variant: 'wink' } } }), /no variant/);
});

test('rig animate: tweened frames, tag, replace in place, mirror view flips', () => {
  const e = new Engine({ home: tmp() });
  makeRig(e);
  e.run('rig_pose', { name: 'bot', pose: 'up', parts: { arm_f: { rot: -90 }, body: { y: -2 } } });
  e.run('rig_pose', { name: 'bot', pose: 'down', parts: {} });
  const r = e.run('rig_animate', { name: 'bot', animation: 'wave', view: 'side', keys: [{ pose: 'down' }, { pose: 'up' }], frames: 8, fps: 16 });
  assert.deepEqual(r.frames, [0, 7]);
  const d = e.get('bot');
  assert.deepEqual(d.animations.wave.frames, [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.equal(d.animations.wave.durations[0], 63);
  // in-betweens differ from the keys
  const f = (i) => e.run('read', { canvas: 'bot', frame: i }).rows.join('');
  assert.notEqual(f(0), f(2));
  assert.notEqual(f(2), f(4));
  // re-animating the same tag with the same length replaces in place
  e.run('rig_animate', { name: 'bot', animation: 'wave', view: 'side', keys: [{ pose: 'down' }, { pose: 'up' }], frames: 8, fps: 8 });
  assert.equal(e.get('bot').frames, 8);
  assert.equal(e.get('bot').animations.wave.durations[0], 125);
  // a different length moves it to the end
  e.run('rig_animate', { name: 'bot', animation: 'still', view: 'side', keys: [{ pose: 'down' }], frames: 1, loop: false });
  e.run('rig_animate', { name: 'bot', animation: 'wave', view: 'side', keys: [{ pose: 'down' }, { pose: 'up' }], frames: 4 });
  assert.equal(e.get('bot').frames, 5);
  assert.deepEqual(e.get('bot').animations.wave.frames, [1, 2, 3, 4]);
  // mirror view = horizontally flipped side view around the root
  e.run('rig_animate', { name: 'bot', canvas: 'm', animation: 'a', view: 'side', keys: [{ pose: 'down' }], frames: 1, loop: false });
  e.run('rig_animate', { name: 'bot', canvas: 'm', animation: 'b', view: 'side_left', keys: [{ pose: 'down' }], frames: 1, loop: false });
  const A = e.run('read', { canvas: 'm', frame: 0 }), B = e.run('read', { canvas: 'm', frame: 1 });
  const row = (r, y) => r.rows[y].split('').map((ch) => (ch === '.' ? '.' : r.legend[ch]));
  for (let y = 0; y < 16; y++) assert.deepEqual(row(B, y), row(A, y).map((_, x) => row(A, y)[15 - x]), `row ${y} mirrored`);
});

test('plant_feet keeps the lowest pixel on the ground; rig update keeps pixels', () => {
  const e = new Engine({ home: tmp() });
  makeRig(e);
  e.run('rig_pose', { name: 'bot', pose: 'jump', parts: { body: { y: -3 } } });
  e.run('rig_animate', { name: 'bot', animation: 'j', view: 'side', keys: [{ parts: {} }, { pose: 'jump' }], frames: 4, plant_feet: true });
  const c = e.run('critique', { canvas: 'bot', animation: 'j' });
  assert.ok(!c.animation.issues.some((i) => i.id === 'ground_line'), JSON.stringify(c.animation.issues));
  const before = e.run('rig_info', { name: 'bot' }).cells.side.arm_f;
  e.run('rig_update', { name: 'bot', parts: { body: { w: 8 } } });
  const after = e.run('rig_info', { name: 'bot' }).cells.side.arm_f;
  assert.equal(after[0], before[0] + 2, 'cells after the wider body shift right');
  const r = e.run('read', { canvas: 'bot_parts', layer: 'parts', x: after[0], y: after[1], w: 2, h: 5 });
  assert.equal(r.legend[r.rows[0][0]], '#0000ff', 'arm pixels moved with their cell');
});

test('animatePoses timing: loop vs non-loop and shortest rotation', () => {
  const rig = normalizeRig({ frame: [8, 8], parts: { a: { w: 2, h: 2 } }, poses: { p0: { a: { rot: 170 } }, p1: { a: { rot: -170 } } } });
  const loop = animatePoses(rig, { keys: [{ pose: 'p0' }, { pose: 'p1' }], frames: 4, loop: true });
  assert.equal(loop.length, 4);
  const mid = animatePoses(rig, { keys: [{ pose: 'p0', ease: 'linear' }, { pose: 'p1', ease: 'linear' }], frames: 3, loop: false });
  assert.equal(Math.round(mid[1].a.rot), 180, 'rotates the short way through 180');
  assert.equal(mid[2].a.rot, -170);
});

test('templates: overridable starting points, presets animate, squash scales', () => {
  const e = new Engine({ home: tmp() });
  const r = e.run('rig_create', { name: 'hero', frame: [32, 32], template: 'humanoid', parts: { head: { w: 14 }, arm_b: null, tail: { w: 3, h: 6, pivot: [1, 0], parent: 'body', at: [-3, -2], z: -5 } } });
  assert.ok(r.presets.includes('walk') && r.guide);
  assert.ok(!r.cells.side.arm_b && r.cells.side.tail && r.cells.side.head[2] === 14, 'overrides applied');
  // fill every cell so frames have pixels
  const cmds = [];
  for (const v of Object.keys(r.cells)) for (const [x, y, w, h] of Object.values(r.cells[v])) cmds.push({ op: 'rect', x, y, w, h, color: '#a03030' });
  e.run('draw', { canvas: 'hero_parts', layer: 'parts', commands: cmds });
  const w = e.run('rig_animate', { name: 'hero', preset: 'walk', view: 'side' });
  assert.equal(w.animation, 'walk');
  assert.equal(w.frames[1] - w.frames[0] + 1, 8);
  const f = e.run('rig_animate', { name: 'hero', preset: 'walk', view: 'front', frames: 16, fps: 24 });
  assert.equal(f.animation, 'walk_front');
  assert.equal(f.frames[1] - f.frames[0] + 1, 16);
  assert.throws(() => e.run('rig_animate', { name: 'hero', preset: 'nope' }), /no preset/);
  e.run('rig_update', { name: 'hero', presets: { wave: { keys: [{ parts: {} }, { parts: { arm_f: { rot: -150 } } }], frames: 6, fps: 8 } } });
  assert.equal(e.run('rig_animate', { name: 'hero', preset: 'wave' }).frames.length, 2);
  // blob squash: wider and shorter than rest
  const b = e.run('rig_create', { name: 'slime', frame: [24, 24], template: 'blob' });
  const [x, y, bw, bh] = b.cells.front.body;
  e.run('draw', { canvas: 'slime_parts', layer: 'parts', commands: [{ op: 'rect', x, y, w: bw, h: bh, color: '#30a040' }] });
  e.run('rig_pose', { name: 'slime', pose: 'rest', parts: {} });
  e.run('rig_animate', { name: 'slime', animation: 'cmp', view: 'front', keys: [{ pose: 'rest' }, { pose: 'squash' }], frames: 2, loop: false });
  const bbox = (i) => { const rows = e.run('read', { canvas: 'slime', frame: i }).rows; const ys = rows.map((row, j) => (/[^.]/.test(row) ? j : -1)).filter((j) => j >= 0); const xs = rows.flatMap((row) => [...row].map((c, k) => (c !== '.' ? k : -1)).filter((k) => k >= 0)); return [Math.max(...xs) - Math.min(...xs) + 1, ys.length]; };
  const [w0, h0] = bbox(0), [w1, h1] = bbox(1);
  assert.ok(w1 > w0 && h1 < h0, `squash ${w0}x${h0} -> ${w1}x${h1}`);
  assert.ok(e.run('rig_templates', {}).flyer);
});

test('turnaround: one tagged frame per view on one canvas', () => {
  const e = new Engine({ home: tmp() });
  makeRig(e);
  const r = e.run('rig_turnaround', { name: 'bot' });
  assert.deepEqual(Object.keys(r.frames), ['side', 'front', 'side_left']);
  const d = e.get('bot');
  assert.equal(d.frames, 3);
  assert.deepEqual(d.animations.front.frames, [1]);
});

test('anchors per frame + paper-doll only/hide layers stack exactly', () => {
  const e = new Engine({ home: tmp() });
  makeRig(e);
  e.run('rig_pose', { name: 'bot', pose: 'up', parts: { body: { y: -2 }, arm_f: { rot: -90 } } });
  e.run('rig_animate', { name: 'bot', animation: 'w', view: 'side', keys: [{ parts: {} }, { pose: 'up' }], frames: 4 });
  e.run('rig_animate', { name: 'bot', canvas: 'body', animation: 'w', view: 'side', keys: [{ parts: {} }, { pose: 'up' }], frames: 4, hide: ['eye'] });
  e.run('rig_animate', { name: 'bot', canvas: 'eye', animation: 'w', view: 'side', keys: [{ parts: {} }, { pose: 'up' }], frames: 4, only: ['eye'] });
  const an = e.get('bot').meta.anchors.w;
  assert.equal(an.length, 4);
  assert.deepEqual(an[0].body, [8, 10, 0]);
  assert.notEqual(an[2].body[1], an[0].body[1], 'body anchor moves with the pose');
  // layers: body + eye composite == full character, frame by frame
  for (let f = 0; f < 4; f++) {
    const full = e.run('read', { canvas: 'bot', frame: f }), b = e.run('read', { canvas: 'body', frame: f }), y = e.run('read', { canvas: 'eye', frame: f });
    const col = (r, x, yy) => { const ch = r.rows[yy][x]; return ch === '.' ? null : r.legend[ch]; };
    for (let yy = 0; yy < 16; yy++) for (let x = 0; x < 16; x++) assert.equal(col(full, x, yy), col(y, x, yy) ?? col(b, x, yy), `f${f} ${x},${yy}`);
  }
  const out = path.join(tmp(), 'sheet');
  const r = e.run('export_animation', { canvas: 'bot', format: 'spritesheet', path: out, scale: 2 });
  const j = JSON.parse(fs.readFileSync(r.json, 'utf8'));
  assert.deepEqual(Object.values(j.frames)[0].anchors.body, { x: 16, y: 20, rot: 0 });
});

test('rig update saves poses and info returns full pose data', () => {
  const e = new Engine({ home: tmp() });
  makeRig(e);
  e.run('rig_update', { name: 'bot', poses: { wave: { arm_f: { rot: -120 } } } });
  const info = e.run('rig_info', { name: 'bot' });
  assert.deepEqual(info.poses.wave, { arm_f: { rot: -120 } });
  e.run('rig_update', { name: 'bot', poses: { wave: null } });
  assert.equal(e.run('rig_info', { name: 'bot' }).poses.wave, undefined);
});

// ---- rig hd: per-view poses, IK, foot planting, secondary motion, humanoid_hd, sampling ----

test('per-view pose overrides apply in their view (and mirrors), and tween', () => {
  const e = new Engine({ home: tmp() });
  makeRig(e);
  e.run('rig_pose', { name: 'bot', pose: 'reach', parts: { arm_f: { rot: -40 } }, views: { front: { arm_f: { rot: 90 }, body: { y: -2 } } } });
  const rig = normalizeRig(e.get('bot_parts').meta.rig);
  const side = poseAnchors(rig, 'reach', 'side'), front = poseAnchors(rig, 'reach', 'front'), left = poseAnchors(rig, 'reach', 'side_left');
  assert.equal(side.arm_f[2], -40);
  assert.equal(front.arm_f[2], 90, 'front override replaces the base rotation');
  assert.equal(front.body[1], side.body[1] - 2, 'front override adds fields too');
  assert.equal(left.arm_f[2], 40, 'mirror view uses its source view (side) pose, flipped');
  const poses = animatePoses(rig, { keys: [{ parts: {}, ease: 'linear' }, { pose: 'reach', ease: 'linear' }], frames: 3, loop: false });
  assert.equal(poseAnchors(rig, poses[1], 'front').arm_f[2], 45, 'override tweens in its view');
  assert.equal(poseAnchors(rig, poses[1], 'side').arm_f[2], -20, 'base tweens in other views');
  // mirror_pairs swaps parts inside view overrides too
  const sw = animatePoses(rig, { keys: [{ pose: 'reach', mirror_pairs: true }], frames: 1, loop: false });
  assert.equal(poseAnchors(rig, sw[0], 'front').arm_b[2], 90);
  assert.throws(() => e.run('rig_pose', { name: 'bot', pose: 'x', parts: {}, views: { side_left: { arm_f: { rot: 1 } } } }), /drawn view/);
  // rendered frames differ between views as the override says
  e.run('rig_animate', { name: 'bot', canvas: 'pv', animation: 'f', view: 'front', keys: [{ pose: 'reach' }], frames: 1, loop: false });
  assert.deepEqual(e.get('pv').meta.anchors.f[0].arm_f.slice(2), [90]);
});

function chainRig() {
  return normalizeRig({
    frame: [64, 64], root: [20, 20], sampling: 'rotsprite',
    parts: {
      body: { w: 6, h: 10, pivot: [3, 0] },
      upper: { w: 2, h: 12, pivot: [1, 0], parent: 'body', at: [0, 2] },
      lower: { w: 2, h: 12, pivot: [1, 0], parent: 'upper', at: [0, 11] },
      hand: { w: 2, h: 3, pivot: [1, 0], parent: 'lower', at: [0, 11] },
      gun: { w: 10, h: 2, pivot: [2, 1], parent: 'body', at: [8, 6] },
    },
  });
}

test('two-bone IK reaches absolute and part-relative targets within 1px, bend picks the side', () => {
  const rig = chainRig();
  const dist = (p, q) => Math.hypot(p.x - q[0], p.y - q[1]);
  for (const target of [[34, 30], [12, 36], [28, 18], [22, 40]]) for (const bend of [1, -1]) {
    const { world } = solvePose(rig, { ik: { hand: { target, bend } } }, 'side');
    assert.ok(dist(world.hand, target) < 1, `hand ${world.hand.x.toFixed(2)},${world.hand.y.toFixed(2)} reaches ${target} (bend ${bend})`);
  }
  // bend 1 puts the joint toward +x for a target straight below, -1 toward -x
  const kneeA = solvePose(rig, { ik: { hand: { target: [20, 38], bend: 1 } } }, 'side').world.lower;
  const kneeB = solvePose(rig, { ik: { hand: { target: [20, 38], bend: -1 } } }, 'side').world.lower;
  assert.ok(kneeA.x > 20 && kneeB.x < 20, `${kneeA.x} / ${kneeB.x}`);
  // relative to another part's pivot, in that part's rotated frame (e.g. a weapon grip)
  const P = { body: { rot: 10 }, ik: { hand: { target: { part: 'gun', at: [4, 0] }, bend: -1, rot: 0 } } };
  const { world } = solvePose(rig, P, 'side');
  const g = world.gun, r = (g.rot * Math.PI) / 180;
  assert.ok(dist(world.hand, [g.x + 4 * Math.cos(r), g.y + 4 * Math.sin(r)]) < 1, 'hand on the grip');
  assert.ok(Math.abs(world.hand.rot) < 1e-6, 'rot sets the end part world rotation');
  // unreachable targets clamp along the line instead of failing
  const far = solvePose(rig, { ik: { hand: { target: [60, 20] } } }, 'side').world;
  assert.ok(far.hand.x > far.upper.x + 21, 'arm fully extended toward a far target');
  // keys: IK is solved per frame after FK; targets tween; a key without IK blends back to FK
  const poses = animatePoses(rig, { keys: [{ parts: {}, ik: { hand: { target: [34, 30] } } }, { parts: {}, ik: { hand: { target: [26, 38] } } }], frames: 4, loop: false });
  for (const p of poses) assert.ok(dist(solvePose(rig, p, 'side').world.hand, p.ik.hand.target) < 1);
  const fade = animatePoses(rig, { keys: [{ parts: {}, ik: { hand: { target: [34, 30] } }, ease: 'linear' }, { parts: {}, ease: 'linear' }], frames: 3, loop: false });
  assert.equal(fade[1].ik.hand.weight, 0.5);
  assert.throws(() => solvePose(rig, { ik: { upper: { target: [0, 0] } } }, 'side'), /grandparent/);
});

test('plant pins standing feet and keeps walking stance feet on the ground (humanoid_hd)', () => {
  const e = new Engine({ home: tmp() });
  e.run('rig_create', { name: 'hd', frame: [64, 96], template: 'humanoid_hd' });
  const def = e.get('hd_parts').meta.rig;
  const rig = normalizeRig(def);
  for (const view of ['side', 'front', 'front_side']) {
    const idle = plantFeet(rig, animatePoses(rig, { keys: def.presets.idle.keys, frames: 12 }), view);
    const feet = idle.map((p) => solvePose(rig, p, view).world.foot_f);
    for (const f of feet) assert.ok(Math.hypot(f.x - feet[0].x, f.y - feet[0].y) < 1, `${view}: idle foot stays put`);
  }
  const ground = solvePose(rig, {}, 'side').world.foot_f.y;
  const walk = plantFeet(rig, animatePoses(rig, { keys: def.presets.walk.keys, frames: 16 }), 'side');
  const planted = walk.filter((p) => p.views?.side?.ik?.foot_f);
  assert.ok(planted.length >= 4 && planted.length < 16, `contact frames ${planted.length}`);
  for (const p of planted) assert.ok(Math.abs(solvePose(rig, p, 'side').world.foot_f.y - ground) < 1, 'stance ankle on the ground row');
  const xs = planted.map((p) => solvePose(rig, p, 'side').world.foot_f.x);
  const steps = xs.slice(1).map((x, i) => x - xs[i]).filter((d) => Math.abs(d) < 10);
  assert.ok(Math.max(...steps) - Math.min(...steps) < 1, 'stance foot moves at constant speed (no skating)');
  const r = e.run('rig_animate', { name: 'hd', preset: 'idle', view: 'side', plant: true });
  assert.equal(r.notes, undefined);
});

test('secondary motion lags its parent and loops seamlessly', () => {
  const rig = normalizeRig({
    frame: [48, 48], root: [24, 10],
    parts: { body: { w: 4, h: 4, pivot: [2, 0] }, tail: { w: 2, h: 14, pivot: [1, 0], parent: 'body' } },
    secondary: { tail: { stiffness: 0.2, damping: 0.15 } },
  });
  const n = 16;
  const keys = [{ parts: { body: { rot: -30 } } }, { parts: { body: { rot: 30 } } }];
  const poses = animatePoses(rig, { keys, frames: n });
  const sim = simulateSecondary(rig, poses, 'side');
  const body = poses.map((p) => solvePose(rig, p, 'side').world.body.rot);
  const tail = sim.map((p) => solvePose(rig, p, 'side').world.tail.rot);
  assert.ok(tail.some((t, i) => Math.abs(t - body[i]) > 3), 'tail differs from the rigid FK');
  const peak = (a) => a.indexOf(Math.max(...a));
  const lag = (peak(tail) - peak(body) + n) % n;
  assert.ok(lag >= 1 && lag <= n / 2, `tail peaks ${lag} frames after the body`);
  // seamless: a twice-as-long loop of the same motion gives the same frames (periodic steady state)
  const twice = simulateSecondary(rig, [...poses, ...poses], 'side').map((p) => solvePose(rig, p, 'side').world.tail.rot);
  for (let f = 0; f < n; f++) assert.ok(Math.abs(twice[f + n] - tail[f]) < 0.5 && Math.abs(twice[f] - tail[f]) < 0.5, `frame ${f}: ${twice[f + n]} vs ${tail[f]}`);
  // the step across the loop seam is no bigger than the steps inside the loop
  const steps = tail.map((t, i) => Math.abs(tail[(i + 1) % n] - t));
  assert.ok(steps[n - 1] <= Math.max(...steps.slice(0, n - 1)) + 0.5, 'no jump at the seam');
  // stiffness 1 = rigid; non-looping runs once from rest
  const rigid = simulateSecondary(rig, poses, 'side', { config: { tail: { stiffness: 1, damping: 0.3, gravity: 0, inertia: 1 } } });
  assert.deepEqual(rigid.map((p) => solvePose(rig, p, 'side').world.tail.rot), body);
  const once = simulateSecondary(rig, animatePoses(rig, { keys, frames: 6, loop: false }), 'side', { loop: false });
  assert.equal(Math.round(solvePose(rig, once[0], 'side').world.tail.rot), -30, 'non-loop starts at rest on the FK pose');
});

test('humanoid_hd: creates at 64x96..160x240 and animates every preset in every view', () => {
  const e = new Engine({ home: tmp() });
  const r = e.run('rig_create', { name: 'hd', frame: [64, 96], template: 'humanoid_hd' });
  const want = ['pelvis', 'torso', 'chest', 'neck', 'head', 'upper_arm_f', 'upper_arm_b', 'forearm_f', 'forearm_b', 'hand_f', 'hand_b', 'thigh_f', 'thigh_b', 'shin_f', 'shin_b', 'foot_f', 'foot_b', 'gear_back', 'gear_hip', 'weapon', 'cape'];
  for (const p of want) assert.ok(r.cells.side[p], `part ${p}`);
  assert.deepEqual(r.views, ['side', 'front_side', 'front', 'back_side', 'back']);
  assert.deepEqual(r.mirror_views, ['side_left', 'front_side_left', 'back_side_left']);
  const info = e.run('rig_info', { name: 'hd' });
  assert.equal(info.sampling, 'rotsprite');
  assert.equal(info.parts.weapon.parent, 'hand_f');
  assert.ok(info.secondary.cape && info.feet.includes('foot_f'));
  const frames = { idle: 12, walk: 16, run: 12, crouch_walk: 16, aim: 1, shoot: 6, reload: 24, hurt: 8, death: 20, throw: 12 };
  for (const [p, n] of Object.entries(frames)) assert.equal(info.presets[p].frames, n, `${p} frames`);
  // front/back walks foreshorten the thighs (knees lift) instead of rotating them sideways
  assert.ok(info.poses.walk_pass.views.front.thigh_b.sy < 1 && info.poses.walk_pass.views.front.thigh_b.rot === 0);
  assert.ok(info.poses.aim.ik.hand_f && info.poses.aim.ik.hand_b.target.part === 'weapon', 'aim: both hands on the gun via IK');
  assert.equal(info.poses.reload_hip.ik.hand_b.target.part, 'gear_hip', 'reload: off hand to the hip pouch');
  const cmds = [];
  for (const v of Object.keys(r.cells)) for (const [k, [x, y, w, h]] of Object.entries(r.cells[v])) cmds.push({ op: 'rect', x, y, w, h, color: k.startsWith('head') ? '#d0a080' : '#406080' });
  e.run('draw', { canvas: 'hd_parts', layer: 'parts', commands: cmds });
  const views = [...r.views, ...r.mirror_views];
  for (const [p, n] of Object.entries(frames)) for (const v of views) {
    const a = e.run('rig_animate', { name: 'hd', canvas: `hd_${v}_${p}`, preset: p, view: v });
    assert.equal(a.frames[1] - a.frames[0] + 1, n, `${p} ${v}`);
    const rows = e.run('read', { canvas: `hd_${v}_${p}`, frame: a.frames[1] }).rows;
    assert.ok(rows.some((row) => /[^.]/.test(row)), `${p} ${v} has pixels`);
  }
  // aim: the off hand reaches the weapon's foregrip in every view
  const rig = normalizeRig(e.get('hd_parts').meta.rig);
  for (const v of r.views) {
    const { world, VP } = solvePose(rig, 'aim', v);
    const g = world.weapon, at = VP.ik.hand_b.target.at, rr = (g.rot * Math.PI) / 180;
    assert.ok(Math.hypot(world.hand_b.x - (g.x + at[0] * Math.cos(rr) - at[1] * Math.sin(rr)), world.hand_b.y - (g.y + at[0] * Math.sin(rr) + at[1] * Math.cos(rr))) < 1, `${v}: off hand on the weapon`);
  }
  // larger frames scale the parts; a removed variant no longer breaks hurt/death
  const big = e.run('rig_create', { name: 'big', frame: [160, 240], template: 'humanoid_hd', parts: { head: { variants: [] } } });
  assert.ok(big.cells.side.thigh_f[3] > 2 * r.cells.side.thigh_f[3]);
  assert.ok(!big.cells.side['head:blink']);
  for (const p of ['hurt', 'death']) e.run('rig_animate', { name: 'big', canvas: `big_${p}`, preset: p, view: 'side' });
  assert.throws(() => e.run('rig_create', { name: 'tiny', frame: [24, 24], template: 'humanoid_hd' }), /at least 32x48/);
  // too many frames for one canvas: a clear error naming the fix
  assert.throws(() => { for (let i = 0; i < 12; i++) e.run('rig_animate', { name: 'big', canvas: 'full', preset: 'reload', view: 'side', animation: `r${i}` }); }, /another canvas/);
});

test('old humanoid template survives removing the blink variant used by hurt/death', () => {
  const e = new Engine({ home: tmp() });
  const r = e.run('rig_create', { name: 'h', frame: [32, 32], template: 'humanoid', parts: { head: { variants: [] } } });
  assert.ok(!r.cells.side['head:blink']);
  e.run('rig_animate', { name: 'h', preset: 'hurt', view: 'side' });
  e.run('rig_animate', { name: 'h', preset: 'death', view: 'side' });
  assert.equal(e.run('rig_info', { name: 'h' }).sampling, 'nearest8', 'old templates keep the old sampling');
});

test('sampling: a rotated 2px-wide limb stays 2px wide (rotsprite, smooth)', () => {
  for (const sampling of ['rotsprite', 'smooth']) {
    const e = new Engine({ home: tmp() });
    const r = e.run('rig_create', { name: 'l', frame: [48, 48], root: [24, 8], sampling, parts: { limb: { w: 2, h: 24, pivot: [1, 0] } } });
    const [x, y] = r.cells.side.limb;
    e.run('draw', { canvas: 'l_parts', layer: 'parts', commands: [{ op: 'rect', x, y, w: 1, h: 24, color: '#202020' }, { op: 'rect', x: x + 1, y, w: 1, h: 24, color: '#e0e0e0' }] });
    const angles = [];
    for (let a = -85; a <= 85; a += 5) angles.push(a);
    e.run('rig_animate', { name: 'l', animation: 'spin', view: 'side', keys: angles.map((a, i) => ({ parts: { limb: { rot: a } }, t: i / angles.length, ease: 'step' })), frames: angles.length });
    const runs = [];
    angles.forEach((a, f) => {
      const rows = e.run('read', { canvas: 'l', frame: f }).rows.map((row) => [...row].map((c) => c !== '.'));
      // measure across the limb: rows for steep limbs, columns for flat ones, skipping both ends
      const lines = Math.abs(a) <= 45 ? rows : rows[0].map((_, i) => rows.map((row) => row[i]));
      const filled = lines.map((l) => l.filter(Boolean).length);
      const idx = filled.map((c, i) => (c ? i : -1)).filter((i) => i >= 0);
      for (const i of idx.slice(3, -3)) runs.push([a, filled[i]]);
    });
    assert.ok(runs.length > 300);
    assert.deepEqual(runs.filter(([, n]) => n < 2 || n > 3), [], `${sampling}: every cross-section is 2-3 px`);
    const near = runs.filter(([a]) => Math.abs(a) <= 15 || Math.abs(a) >= 75);
    assert.ok(near.filter(([, n]) => n === 2).length / near.length > 0.8, `${sampling}: near-axis limbs stay exactly 2px`);
  }
  // only colours the part already has (no blending)
  const e = new Engine({ home: tmp() });
  const r = e.run('rig_create', { name: 'c', frame: [32, 32], root: [16, 4], sampling: 'rotsprite', parts: { limb: { w: 3, h: 16, pivot: [1, 0] } } });
  const [x, y] = r.cells.side.limb;
  e.run('draw', { canvas: 'c_parts', layer: 'parts', commands: [{ op: 'rect', x, y, w: 3, h: 16, color: '#336699' }, { op: 'rect', x: x + 1, y, w: 1, h: 16, color: '#99ccff' }] });
  e.run('rig_animate', { name: 'c', animation: 'r', view: 'side', keys: [{ parts: { limb: { rot: 33 } } }], frames: 1, loop: false });
  assert.deepEqual([...colorsIn(e, 'c', 0)].sort(), ['#336699', '#99ccff']);
  assert.throws(() => normalizeRig({ frame: [8, 8], sampling: 'bilinear', parts: { a: { w: 2, h: 2 } } }), /sampling/);
});

test('spritesheet export: json:false skips the sidecar', () => {
  const e = new Engine({ home: tmp() });
  makeRig(e);
  e.run('rig_animate', { name: 'bot', animation: 'w', view: 'side', keys: [{ parts: {} }], frames: 1, loop: false });
  const dir = tmp();
  const a = e.run('export_animation', { canvas: 'bot', format: 'spritesheet', path: path.join(dir, 'a'), json: false });
  assert.ok(a.json == null, 'no sidecar path'); // json:false leaves json unset
  assert.ok(fs.existsSync(path.join(dir, 'a.png')) && !fs.existsSync(path.join(dir, 'a.json')));
  const b = e.run('export_animation', { canvas: 'bot', format: 'spritesheet', path: path.join(dir, 'b') });
  assert.ok(fs.existsSync(b.json), 'default still writes the json');
});

test('plant: depth-plane leg IK lengthens a foreshortened bone even when the other is at full length', () => {
  const e = new Engine({ home: tmp() });
  e.run('rig_create', { name: 'hd', frame: [128, 192], template: 'humanoid_hd' });
  const def = e.get('hd_parts').meta.rig;
  const rig = normalizeRig(def);
  for (const view of ['front', 'back']) {
    const ground = solvePose(rig, {}, view).world.foot_f.y;
    const poses = plantFeet(rig, animatePoses(rig, { keys: def.presets.crouch_walk.keys, frames: 16 }), view);
    let n = 0;
    for (const p of poses) for (const foot of rig.feet) if (p.views?.[view]?.ik?.[foot]) {
      n++;
      const y = solvePose(rig, p, view).world[foot].y;
      assert.ok(Math.abs(y - ground) < 1, `${view} ${foot}: planted ankle ${y.toFixed(2)} on ground ${ground}`);
    }
    assert.ok(n > 0);
  }
});

test('rig hd input validation: feet, plant as a string, non-numeric IK targets', () => {
  const parts = { body: { w: 4, h: 4, pivot: [2, 0] }, thigh: { w: 2, h: 6, pivot: [1, 0], parent: 'body' }, shin: { w: 2, h: 6, pivot: [1, 0], parent: 'thigh', at: [0, 5] }, foot_x: { w: 2, h: 2, pivot: [1, 0], parent: 'shin', at: [0, 5] } };
  assert.deepEqual(normalizeRig({ frame: [32, 32], parts, feet: 'foot_x' }).feet, ['foot_x']);
  assert.throws(() => normalizeRig({ frame: [32, 32], parts, feet: 5 }), /must be an array/);
  const rig = normalizeRig({ frame: [32, 32], parts });
  assert.throws(() => solvePose(rig, { ik: { foot_x: { target: ['a', 3] } } }, 'side'), /two numbers/);
  const e = new Engine({ home: tmp() });
  e.run('rig_create', { name: 'hd', frame: [64, 96], template: 'humanoid_hd' });
  // plant:'foot_f' plants that foot only, exactly like plant:['foot_f'] (not every rig foot)
  for (const [c, plant] of [['str', 'foot_f'], ['arr', ['foot_f']], ['all', true]]) e.run('rig_animate', { name: 'hd', preset: 'walk', view: 'side', canvas: c, plant, secondary: false });
  const A = (c) => JSON.stringify(e.get(c).meta.anchors.walk);
  assert.equal(A('str'), A('arr'));
  assert.notEqual(A('str'), A('all'));
});

test('tweens keep the 0.3 direction for a rotation difference of exactly -180 degrees', async () => {
  const { lerpPose } = await import('../src/rig.js');
  const rig = normalizeRig({ frame: [16, 16], parts: { a: { w: 2, h: 2 } } });
  const mid = (x, y) => lerpPose(rig, { a: { rot: x } }, { a: { rot: y } }, 0.5).a.rot;
  assert.equal(mid(0, -180), -90);
  assert.equal(mid(90, -90), 0);
  assert.equal(mid(-90, 90), 0);
  assert.equal(mid(0, 540), 90);
});
