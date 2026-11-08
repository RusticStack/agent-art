// Regression tests for the 0.3.0 fix pass: 3D (art_model) and the line draw op.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Engine } from '../src/engine.js';
import { texResolver } from '../src/modelops.js';
import { referencedAlpha } from '../src/glb.js';
import { simplifyPath } from '../src/poly2d.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'agent-art-v3d-'));
const glbJSON = (file) => { const b = fs.readFileSync(file); const n = b.readUInt32LE(12); return JSON.parse(b.toString('utf8', 20, 20 + n)); };
function setup3d() {
  const e = new Engine({ home: tmp() });
  const mk = (name, w, h, fill) => {
    e.run('create', { name, width: w, height: h });
    const d = e.get(name), data = d.layers[0].data;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.set(fill(x, y), (y * w + x) * 4);
  };
  mk('stone', 32, 32, (x, y) => [100 + (x % 4) * 10, 100 + (y % 4) * 10, 110, 255]);
  mk('marble', 32, 32, (x, y) => [200 + (x % 3), 200, 205 + (y % 3), 255]);
  mk('marble2', 32, 32, () => [180, 180, 190, 255]);
  mk('grime', 16, 16, (x, y) => ((x + y) % 3 ? [40, 30, 20, 255] : [0, 0, 0, 0]));
  return e;
}

// 3
test('model_create keeps model-level overlays and uv_origin (create, update, info)', () => {
  const e = setup3d();
  const parts = [{ type: 'wall', texture: 'stone', w: 64, h: 64, d: 8 }];
  const plain = e.run('model_create', { name: 'plain', parts });
  const r = e.run('model_create', { name: 'w', parts, overlays: [{ texture: 'grime', where: 'bottom', falloff: 16 }], uv_origin: [0, 0, 0] });
  assert.ok(r.baked && r.baked.overlay_shells > 0, 'model-level overlay is baked');
  assert.ok(r.triangles > plain.triangles);
  const saved = JSON.parse(fs.readFileSync(path.join(e.home, 'models', 'w.json'), 'utf8'));
  assert.deepEqual(saved.uv_origin, [0, 0, 0]);
  assert.equal(saved.overlays[0].texture, 'grime');
  assert.deepEqual(e.run('model_info', { name: 'w' }).options.uv_origin, [0, 0, 0]);
  e.run('model_update', { name: 'w', overlays: null });
  assert.equal(e.run('model_info', { name: 'w' }).triangles, plain.triangles, 'update overlays:null removes them');
});

// 4
test('ctm random with only variants uses variants[0] as the base', () => {
  const e = setup3d();
  const r = e.run('model_ctm', { name: 'mr', ctm: { method: 'random', variants: ['marble', 'marble2'], weights: [3, 1] } });
  assert.equal(r.tiles, 2);
  assert.equal(e.get('mr').meta.ctm.base, 'marble');
  assert.equal(r.size, '64x32');
});

// 5
test('emissive layer is excluded from the colour texture and only feeds the emissive texture', () => {
  const e = setup3d();
  e.run('create', { name: 'lamp', width: 8, height: 8 });
  e.run('draw', { canvas: 'lamp', commands: [{ op: 'rect', x: 0, y: 0, w: 8, h: 8, color: '#202020' }] });
  e.run('layer', { canvas: 'lamp', action: 'add', name: 'emissive' });
  e.run('draw', { canvas: 'lamp', layer: 'emissive', commands: [{ op: 'rect', x: 2, y: 2, w: 2, h: 2, color: '#ffcc00' }] });
  const t = texResolver(e)('lamp');
  const p = (2 * 8 + 2) * 4;
  assert.deepEqual([...t.data.subarray(p, p + 4)], [32, 32, 32, 255], 'albedo keeps the base colour');
  assert.deepEqual([...t.emissive.subarray(p, p + 4)], [255, 204, 0, 255]);
  // glow-only pixels keep their coverage (opaque black albedo, colour from emissive)
  e.run('create', { name: 'flame', width: 4, height: 4 });
  e.run('layer', { canvas: 'flame', action: 'add', name: 'emissive' });
  e.run('draw', { canvas: 'flame', layer: 'emissive', commands: [{ op: 'rect', x: 1, y: 1, w: 2, h: 2, color: '#ff8800' }] });
  const f = texResolver(e)('flame'), q = (1 * 4 + 1) * 4;
  assert.deepEqual([...f.data.subarray(q, q + 4)], [0, 0, 0, 255]);
});

// 6
test('full 47-tile CTM floor exports OPAQUE (the empty 48th atlas slot is not referenced)', () => {
  const e = setup3d();
  e.run('model_ctm', { name: 'marble_ctm', ctm: { base: 'marble', method: 'full', border: { width: 2 } } });
  const d = e.get('marble_ctm');
  assert.equal(d.meta.ctm.count, 47);
  const last = ((d.height - 1) * d.width + d.width - 1) * 4;
  assert.equal(d.layers[0].data[last + 3], 0, 'slot 48 is empty');
  e.run('model_create', { name: 'hall', parts: [{ type: 'floor', texture: 'marble_ctm', array: { count: 3, cell_step: [1, 0, 0] } }, { type: 'floor', texture: 'marble_ctm', cell: [0, 0, 1], array: { count: 3, cell_step: [1, 0, 0] } }] });
  const r = e.run('model_export', { name: 'hall', path: path.join(tmp(), 'hall.glb') });
  const m = glbJSON(r.file).materials.find((x) => x.name.startsWith('marble_ctm'));
  assert.ok(m);
  assert.equal(m.alphaMode, undefined);
  // a texture whose referenced texels are transparent still gets MASK
  const tex = { width: 2, height: 1, data: Uint8ClampedArray.from([255, 0, 0, 255, 0, 0, 0, 0]) };
  assert.equal(referencedAlpha(tex, [{ uv: Float32Array.from([0, 0, 0.5, 0, 0, 1]), idx: [0, 1, 2] }]), false);
  assert.equal(referencedAlpha(tex, [{ uv: Float32Array.from([0, 0, 1, 0, 0, 1]), idx: [0, 1, 2] }]), true);
});

// 7
test('overlay where:"all" with amount < 1 does not tessellate the faces', () => {
  const e = setup3d();
  const parts = [{ type: 'floor', texture: 'stone', w: 128, d: 128 }, { type: 'wall', texture: 'stone', w: 128, h: 96, d: 8, at: [0, 0, -64] }];
  const base = e.run('model_create', { name: 'a', parts }).triangles;
  const all = e.run('model_create', { name: 'b', parts, overlays: [{ texture: 'grime', where: 'all', amount: 0.6 }] }).triangles;
  assert.ok(all <= base * 2, `uniform overlay adds at most one shell per face (${base} -> ${all})`);
  // a real gradient still subdivides, but adaptively (less than with a fine detail)
  const grad = e.run('model_create', { name: 'c', parts, overlays: [{ texture: 'grime', where: 'bottom', falloff: 24 }] }).triangles;
  const fine = e.run('model_create', { name: 'd', parts, overlays: [{ texture: 'grime', where: 'bottom', falloff: 24, detail: 4 }] }).triangles;
  assert.ok(grad > base && grad < fine, `${base} < ${grad} < ${fine}`);
});

// 8
test('lathe simplifies one-pixel-per-row profiles before revolving', () => {
  const e = setup3d();
  e.run('create', { name: 'cone', width: 16, height: 16 });
  e.run('draw', { canvas: 'cone', commands: Array.from({ length: 16 }, (_, y) => ({ op: 'rect', x: 0, y, w: y + 1, h: 1, color: '#c96' })) });
  const simple = e.run('model_create', { name: 'c1', parts: [{ type: 'lathe', canvas: 'cone', segments: 12 }] }).triangles;
  const exact = e.run('model_create', { name: 'c2', parts: [{ type: 'lathe', canvas: 'cone', segments: 12, simplify: 0 }] }).triangles;
  assert.ok(simple <= 12 * 2 * 3, `cone: ${simple} triangles`);
  assert.ok(exact > simple * 4, `simplify:0 keeps the pixel steps (${exact} vs ${simple})`);
  // deliberate steps survive (a candle on a wide base): same bounds
  e.run('create', { name: 'cand', width: 8, height: 16 });
  e.run('draw', { canvas: 'cand', commands: [{ op: 'rect', x: 0, y: 0, w: 3, h: 12, color: '#eee' }, { op: 'rect', x: 0, y: 12, w: 6, h: 4, color: '#a73' }] });
  const b = e.run('model_create', { name: 'c3', parts: [{ type: 'lathe', canvas: 'cand', segments: 8 }] });
  assert.ok(Math.abs(b.bounds_px.size[0] - 12) < 0.01 && Math.abs(b.bounds_px.size[1] - 16) < 0.01, JSON.stringify(b.bounds_px));
  // the polyline helper: collinear merge + Douglas-Peucker
  assert.deepEqual(simplifyPath([[0, 0], [1, 0], [2, 0], [2, 1]]), [[0, 0], [2, 0], [2, 1]]);
  assert.deepEqual(simplifyPath([[0, 0], [0, 1], [1, 1], [1, 2], [2, 2]], 0.75), [[0, 0], [2, 2]]);
});

// 9
test('line width: thick lines are drawn and width is not reported as ignored', () => {
  const e = new Engine({ home: tmp() });
  e.run('create', { name: 'c', width: 16, height: 16 });
  const r = e.run('draw', { canvas: 'c', commands: [{ op: 'line', x1: 2, y1: 8, x2: 13, y2: 8, color: '#f00', width: 3 }, { op: 'curve', points: [[1, 1], [8, 6], [14, 1]], color: '#0f0', width: 2, brush: 'square' }] });
  assert.ok(!(r.notes || []).some((n) => /width|brush/.test(n)), JSON.stringify(r.notes));
  const rows = e.run('read', { canvas: 'c', x: 0, y: 6, w: 16, h: 5 }).rows;
  assert.equal(rows.filter((row) => row[7] !== '.').length, 3, 'a 3 px thick horizontal line');
});
