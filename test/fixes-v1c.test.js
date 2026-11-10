// 1.0 fixes found while building the UV unwrap showcase panel.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Engine } from '../src/engine.js';
import { coursePeriod } from '../src/uvcheck.js';
import { packIslands } from '../src/uvunwrap.js';

/** A grey texture with a dark joint row every `period` px. */
function rows(w, h, period) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const p = (y * w + x) * 4, v = y % period === 0 ? 40 : 160 + ((x * 7 + y * 3) % 5);
    data[p] = data[p + 1] = data[p + 2] = v; data[p + 3] = 255;
  }
  return { width: w, height: h, data };
}

test('coursePeriod never reports the mirror lag (H-1) of a short period', () => {
  assert.equal(coursePeriod(rows(32, 32, 8)), 8);
  assert.equal(coursePeriod(rows(32, 32, 16)), 16);
  const p = coursePeriod(rows(32, 32, 11));
  assert.ok(p === null || p <= 16, `period ${p}`);
});

test('the atlas-size error suggests pad:1 when islands are padded', () => {
  const charts = Array.from({ length: 40 }, (_, i) => ({ id: i, w: 30, h: 30 }));
  assert.throws(() => packIslands(charts, { pad: 2, max_size: 128, texel: 1 }), /\{pad:1\}/);
  assert.throws(() => packIslands(charts, { pad: 1, max_size: 128, texel: 1 }), (e) => !/\{pad:1\}/.test(e.message));
});

test('cells takes size:[w, h]; a single number is unchanged', () => {
  const e = new Engine({ home: fs.mkdtempSync(path.join(os.tmpdir(), 'aa-cells-')) });
  const cmd = (size) => ({ op: 'cells', colors: ['#333333', '#777777', '#bbbbbb'], size, seed: 3 });
  e.run('create', { name: 'a', width: 32, height: 32 });
  e.run('create', { name: 'b', width: 32, height: 32 });
  e.run('draw', { canvas: 'a', commands: [cmd(8)] });
  e.run('draw', { canvas: 'b', commands: [cmd([8, 8])] });
  assert.deepEqual(e.run('read', { canvas: 'a', format: 'hex' }), e.run('read', { canvas: 'b', format: 'hex' }));
  e.run('create', { name: 'c', width: 32, height: 32 });
  e.run('draw', { canvas: 'c', commands: [cmd([16, 4])] });
  assert.notDeepEqual(e.run('read', { canvas: 'a', format: 'hex' }), e.run('read', { canvas: 'c', format: 'hex' }));
  assert.throws(() => e.run('draw', { canvas: 'c', commands: [cmd([1, 2, 3])] }), /\[w, h\]/);
});

test('art_critique intended:[[x,y]] keeps deliberate single pixels out of orphan_pixels', () => {
  const e = new Engine({ home: fs.mkdtempSync(path.join(os.tmpdir(), 'aa-crit-')) });
  e.run('create', { name: 'eyes', width: 16, height: 16 });
  const dots = [[3, 3], [6, 3], [9, 3], [12, 3], [3, 8], [12, 8]];
  e.run('draw', { canvas: 'eyes', commands: [{ op: 'rect', x: 1, y: 1, w: 14, h: 14, color: '#4d3a7c' }, { op: 'pixels', color: '#4ad8e0', points: dots }] });
  const has = (r) => (r.issues || []).some((i) => i.id === 'orphan_pixels');
  const before = e.run('critique', { canvas: 'eyes' });
  assert.ok(has(before), JSON.stringify(before.issues));
  assert.match(before.issues.find((i) => i.id === 'orphan_pixels').fix, /intended/);
  assert.ok(!has(e.run('critique', { canvas: 'eyes', intended: dots })));
  assert.throws(() => e.run('critique', { canvas: 'eyes', intended: [[1]] }), /intended/);
});

test('art_draw preview:{scale} renders at that scale; preview:true is unchanged', async () => {
  const { runTool } = await import('../src/mcp.js');
  const e = new Engine({ home: fs.mkdtempSync(path.join(os.tmpdir(), 'aa-prev-')) });
  e.run('create', { name: 'p', width: 16, height: 16 });
  const call = async (op, a) => e.run(op, a);
  const draw = (preview) => runTool('art_draw', { canvas: 'p', commands: [{ op: 'pixels', color: '#ff0000', points: [[1, 1]] }], preview }, call);
  const txt = async (p) => (await draw(p)).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  assert.match(await txt({ scale: 10 }), /"scale":\s*10\b/);
  assert.match(await txt(true), /"scale":\s*16\b/);
});

test('model render reports a model pushed out of the frame by zoom', () => {
  const e = new Engine({ home: fs.mkdtempSync(path.join(os.tmpdir(), 'aa-clip-')) });
  e.run('model_create', { name: 'tower', parts: [{ type: 'box', w: 32, h: 96, d: 32, color: '#888888' }], unwrap: false });
  const tight = e.run('model_render', { name: 'tower', canvas: 'tower_r', camera: 'game', size: [64, 64], zoom: 2 });
  assert.ok(tight.clipped && tight.clipped.px.top >= 1 && tight.clipped.px.bottom >= 1, JSON.stringify(tight.clipped));
  const fit = e.run('model_render', { name: 'tower', canvas: 'tower_f', camera: 'game', size: [64, 64] });
  assert.equal(fit.clipped, undefined);
});
