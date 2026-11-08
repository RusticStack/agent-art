// Rigs: layout, poses, tweened animation, mirror views, variants, relayout, guide isolation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Engine } from '../src/engine.js';
import { decodePNG } from '../src/png.js';
import { normalizeRig, animatePoses } from '../src/rig.js';

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
