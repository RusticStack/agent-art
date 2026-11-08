// Regression tests for issues reported by the showcase and pack agents.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Engine } from '../src/engine.js';
import { decodePNG } from '../src/png.js';
import { hash3 } from '../src/util.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'agent-art-f-'));
const px = (e, canvas, x, y, layer) => {
  const r = e.run('read', { canvas, x, y, w: 1, h: 1, layer });
  return r.rows[0] === '.' ? null : r.legend[r.rows[0]];
};
const names = (e, c) => e.get(c).layers.map((l) => l.name);

test('layer add: position, select:false, blend/opacity; move position/select', () => {
  const e = new Engine({ home: tmp() });
  e.run('create', { name: 'c', width: 8, height: 8 });
  e.run('layer', { canvas: 'c', action: 'add', name: 'a' });
  e.run('layer', { canvas: 'c', action: 'select', layer: 'base' });
  e.run('layer', { canvas: 'c', action: 'add', name: 'top', position: 'top', blend: 'screen', opacity: 0.5, select: false });
  const d = e.get('c');
  assert.deepEqual(names(e, 'c'), ['base', 'a', 'top']);
  assert.equal(d.layers[d.active].name, 'base');
  assert.equal(d.layers[2].blend, 'screen');
  assert.equal(d.layers[2].opacity, 0.5);
  e.run('layer', { canvas: 'c', action: 'add', name: 'under', position: 'bottom' });
  assert.deepEqual(names(e, 'c'), ['under', 'base', 'a', 'top']);
  assert.equal(d.layers[d.active].name, 'under');
  e.run('layer', { canvas: 'c', action: 'move', layer: 'under', position: 'top' });
  assert.deepEqual(names(e, 'c'), ['base', 'a', 'top', 'under']);
  e.run('layer', { canvas: 'c', action: 'select', layer: 'base' });
  e.run('layer', { canvas: 'c', action: 'move', layer: 'top', position: 'bottom', select: true });
  assert.equal(d.layers[d.active].name, 'top');
  assert.throws(() => e.run('layer', { canvas: 'c', action: 'add', position: 'sideways' }), /position/);
});

test('flatten refuses to drop hidden layers silently; stamp_visible composites', () => {
  const e = new Engine({ home: tmp() });
  e.run('create', { name: 'c', width: 4, height: 4, background: '#102030' });
  e.run('layer', { canvas: 'c', action: 'add', name: 'hid' });
  e.run('draw', { canvas: 'c', layer: 'hid', commands: [{ op: 'rect', color: '#ff0000' }] });
  e.run('layer', { canvas: 'c', action: 'visibility', layer: 'hid', visible: false });
  e.run('layer', { canvas: 'c', action: 'add', name: 'lit', blend: 'add' });
  e.run('draw', { canvas: 'c', layer: 'lit', commands: [{ op: 'pixels', points: [[0, 0]], color: '#101010' }] });
  e.run('layer', { canvas: 'c', action: 'stamp_visible', name: 'st' });
  assert.equal(px(e, 'c', 0, 0, 'st'), '#203040');
  assert.equal(names(e, 'c').at(-1), 'st');
  assert.ok(e.get('c').layers.filter((l) => l.name !== 'st').every((l) => !l.visible));
  e.run('undo', { canvas: 'c' });
  assert.throws(() => e.run('layer', { canvas: 'c', action: 'flatten' }), /hidden layer.*"hid"/);
  e.run('layer', { canvas: 'c', action: 'flatten', keep_hidden: true });
  assert.deepEqual(names(e, 'c'), ['base', 'hid']);
  assert.equal(px(e, 'c', 0, 0, 'base'), '#203040');
  e.run('layer', { canvas: 'c', action: 'flatten', discard_hidden: true });
  assert.deepEqual(names(e, 'c'), ['base']);
});

test('on_empty is consistent: default paints empty pixels, false leaves them', () => {
  const e = new Engine({ home: tmp() });
  for (const op of [
    { op: 'light', x: 4, y: 4, radius: 4, intensity: 1, steps: 0 },
    { op: 'fog', to: 0.8, steps: 0 },
    { op: 'vignette', strength: 1, radius: 0, steps: 0 },
    { op: 'rays', x: 0, y: 0, angle: 45, spread: 60, count: 2, width: 30, alpha: 1, steps: 0 },
  ]) {
    e.run('create', { name: 'a', width: 8, height: 8, overwrite: true });
    e.run('draw', { canvas: 'a', commands: [op] });
    assert.ok(e.run('info', { canvas: 'a' }).colors.unique > 0, `${op.op} default should paint empty`);
    e.run('create', { name: 'b', width: 8, height: 8, overwrite: true });
    e.run('draw', { canvas: 'b', commands: [{ ...op, on_empty: false }] });
    assert.equal(e.run('info', { canvas: 'b' }).colors.unique, 0, `${op.op} on_empty:false should leave empty`);
  }
});

test('glow: gain/normalize brighten tiny emitters; wrap blooms across edges', () => {
  const e = new Engine({ home: tmp() });
  const mk = (name, extra) => {
    e.run('create', { name, width: 16, height: 16, background: '#000000', overwrite: true });
    e.run('draw', { canvas: name, commands: [{ op: 'pixels', points: [[0, 8]], color: '#ffffff' }, { op: 'glow', radius: 3, threshold: 0.5, ...extra }] });
    return (x, y) => parseInt((px(e, name, x, y) || '#000000').slice(1, 3), 16);
  };
  const plain = mk('g1', {});
  const boosted = mk('g2', { normalize: true });
  assert.ok(boosted(2, 8) > plain(2, 8), `normalize ${boosted(2, 8)} vs ${plain(2, 8)}`);
  assert.equal(plain(15, 8), 0);
  const wrapped = mk('g3', { wrap: true, gain: 4 });
  assert.ok(wrapped(15, 8) > 0, 'wrap should bloom onto the opposite edge');
});

test('cast_shadow soft spreads a banded penumbra', () => {
  const e = new Engine({ home: tmp() });
  const run = (soft) => {
    e.run('create', { name: 's', width: 24, height: 24, overwrite: true });
    e.run('layer', { canvas: 's', action: 'add', name: 'obj' });
    e.run('draw', { canvas: 's', layer: 'obj', commands: [{ op: 'rect', x: 10, y: 6, w: 4, h: 10, color: '#fff' }] });
    e.run('draw', { canvas: 's', layer: 'base', commands: [{ op: 'cast_shadow', from_layer: 'obj', dx: 0, dy: 0, color: '#000000c0', soft }] });
    const d = e.get('s').layers[0].data;
    let n = 0;
    const alphas = new Set();
    for (let i = 3; i < d.length; i += 4) if (d[i]) { n++; alphas.add(d[i]); }
    return { n, alphas };
  };
  const hard = run(0), soft = run(2);
  assert.ok(soft.n > hard.n, `soft ${soft.n} vs hard ${hard.n}`);
  assert.equal(hard.alphas.size, 1);
  assert.ok(soft.alphas.size > 1 && soft.alphas.size <= 4, `bands ${[...soft.alphas]}`);
});

test('iso: anchor center, fractional at, inset', () => {
  const e = new Engine({ home: tmp() });
  const box = (args) => {
    e.run('create', { name: 'i', width: 64, height: 48, overwrite: true });
    const r = e.run('draw', { canvas: 'i', commands: [{ op: 'iso_tile', tile: 32, origin: [32, 8], color: '#6a5', ...args }] });
    return r.dirty;
  };
  const full = box({ at: [0, 0] });
  assert.deepEqual([full.x, full.y, full.w], [16, 8, 32]);
  const small = box({ at: [0, 0], w: 16, anchor: 'center' });
  // 16px diamond centred on the 32px cell centre (32, 16)
  assert.equal(small.x + small.w / 2, 32);
  assert.equal(small.y + Math.floor(small.h / 2), 16);
  const ins = box({ at: [0, 0], inset: 2 });
  assert.deepEqual([ins.x, ins.y, ins.w], [20, 10, 24]);
  const half = box({ at: [0.5, 0] });
  assert.equal(half.x, 24);
  assert.throws(() => box({ at: [0, 'a'] }), /"at"/);
  assert.throws(() => box({ at: [0, 0], anchor: 'middle' }), /anchor/);
});

test('outline: of colors, region, from_layer, honours mask', () => {
  const e = new Engine({ home: tmp() });
  e.run('create', { name: 'o', width: 12, height: 6 });
  e.run('draw', { canvas: 'o', commands: [
    { op: 'rect', x: 1, y: 1, w: 3, h: 3, color: '#ff0000' },
    { op: 'rect', x: 7, y: 1, w: 3, h: 3, color: '#0000ff' },
    { op: 'outline', color: '#000000', of: '#ff0000' },
  ] });
  assert.equal(px(e, 'o', 0, 2), '#000000');
  assert.equal(px(e, 'o', 6, 2), null, 'blue shape is not outlined');
  e.run('draw', { canvas: 'o', commands: [{ op: 'outline', color: '#00ff00', x: 6, y: 0, w: 6, h: 3 }] });
  assert.equal(px(e, 'o', 6, 2), '#00ff00');
  assert.equal(px(e, 'o', 8, 4), null, 'outside region untouched');
  e.run('layer', { canvas: 'o', action: 'add', name: 'ol' });
  e.run('draw', { canvas: 'o', layer: 'ol', commands: [{ op: 'outline', from_layer: 'base', color: '#ffffff', of: '#0000ff', mode: 'inner' }] });
  assert.equal(px(e, 'o', 7, 1, 'ol'), '#ffffff');
  assert.equal(px(e, 'o', 8, 2, 'ol'), null);
  // mask: only write on empty pixels -> inner outline (on painted pixels) writes nothing
  const r = e.run('draw', { canvas: 'o', layer: 'base', commands: [{ op: 'outline', color: '#ffff00', mode: 'inner', mask: 'transparent' }] });
  assert.ok(!r.dirty, 'masked inner outline should not paint');
});

test('noise: hash has no row correlation; despeckle removes lone pixels', () => {
  // neighbouring rows of the lattice hash must be (nearly) uncorrelated
  let s = 0, n = 0;
  for (let x = 0; x < 64; x++) for (let y = 0; y < 64; y++) { s += (hash3(x, y, 21) - 0.5) * (hash3(x, y + 1, 21) - 0.5); n++; }
  assert.ok(Math.abs(s / n) < 0.01, `row correlation ${s / n}`);
  const e = new Engine({ home: tmp() });
  const lone = (despeckle) => {
    e.run('create', { name: 'n', width: 16, height: 16, overwrite: true });
    e.run('draw', { canvas: 'n', commands: [{ op: 'noise', colors: ['#111111', '#555555', '#999999'], scale: 3, octaves: 2, seed: 21, despeckle }] });
    const r = e.run('read', { canvas: 'n' }).rows;
    const at = (x, y) => r[(y + 16) % 16][(x + 16) % 16];
    let c = 0;
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
      const me = at(x, y);
      if (![at(x + 1, y), at(x - 1, y), at(x, y + 1), at(x, y - 1)].includes(me)) c++;
    }
    return c;
  };
  const before = lone(0), after = lone(2);
  assert.ok(after < before || before === 0, `lone ${before} -> ${after}`);
  assert.ok(after <= 2, `lone after despeckle ${after}`);
});

test('filmstrip: no fake durations without an animation; wide frames get short cells', () => {
  const e = new Engine({ home: tmp() });
  e.run('create', { name: 'w', width: 64, height: 8, frames: 3 });
  const fs1 = e.run('filmstrip', { canvas: 'w', scale: 1, labels: true });
  const img = decodePNG(fs1.image);
  // one label line under an 8px-tall cell: far less than the old 64px square cell
  assert.ok(img.height < 40, `filmstrip height ${img.height}`);
  e.run('animation', { canvas: 'w', action: 'tag', name: 'run', from: 0, to: 2, duration: 80 });
  const fs2 = e.run('filmstrip', { canvas: 'w', animation: 'run', scale: 1 });
  assert.ok(decodePNG(fs2.image).height > img.height, 'tagged filmstrip adds the duration line');
});

test('sheet: small canvases fill their cell in mixed-size projects', () => {
  const e = new Engine({ home: tmp() });
  e.run('project_create', { name: 'm' });
  for (const n of ['s1', 's2', 's3']) e.run('create', { name: n, project: 'm', width: 160, height: 90 });
  e.run('create', { name: 'icon', project: 'm', width: 16, height: 16, background: '#ff0000' });
  const sh = e.run('sheet', { project: 'm', labels: false, columns: 4 });
  const img = decodePNG(sh.image);
  let red = 0;
  for (let i = 0; i < img.data.length; i += 4) if (img.data[i] === 255 && img.data[i + 1] === 0) red++;
  assert.ok(red >= 100 * 100, `icon covers ${red} px`);
});

test('weak-model fixes: region arrays, empty undo, folder export paths', () => {
  const e = new Engine({ home: tmp() });
  e.run('create', { name: 'r', width: 16, height: 8 });
  e.run('draw', { canvas: 'r', commands: [{ op: 'rect', x: 0, y: 0, w: 6, h: 6, color: '#808080' }, { op: 'rect', x: 9, y: 0, w: 6, h: 6, color: '#808080' }] });
  e.run('draw', { canvas: 'r', commands: [{ op: 'shade', colors: ['#202020', '#505050', '#808080', '#b0b0b0', '#e0e0e0'], region: [8, 0, 8, 8] }] });
  const rows = e.run('read', { canvas: 'r' });
  const left = new Set(rows.rows.map((row) => row.slice(0, 6)).join('').replace(/\./g, ''));
  assert.equal(left.size, 1, 'region:[x,y,w,h] limits shading to the right shape');
  e.run('create', { name: 'u', width: 4, height: 4 });
  assert.throws(() => e.run('undo', { canvas: 'u' }), /nothing to undo/);
  const out = path.join(tmp(), 'sheets') + '/';
  const r = e.run('export_animation', { canvas: 'r', format: 'spritesheet', path: out });
  assert.ok(r.png.replaceAll(path.sep, '/').endsWith('sheets/r.png'), r.png);
});
