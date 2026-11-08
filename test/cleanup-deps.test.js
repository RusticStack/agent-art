// art_cleanup dependency edges beyond plain texture fields: trim sheets ("sheet:strip" and
// {sheet}), baked mesh parts (boolean / remesh / decimate results), materials v2 detail maps,
// ruins / extrude masks and kit assembly texture slots must all block deleting what they use.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Engine } from '../src/engine.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'agent-art-cleanup-deps-'));
const blockedBy = (p) => Object.fromEntries((p.blocked || []).map((b) => [b.id, b.by.map((x) => x.split(' ')[0])]));

test('cleanup deps: trim sheets, baked meshes, material detail maps, masks and kit slots block removal', () => {
  const e = new Engine({ home: tmp() });
  e.run('model_trim', { canvas: 'hull_trim' });
  e.run('model_trim', { canvas: 'obj_trim' });
  e.run('model_create', { name: 'hull', parts: [{ type: 'box', size: [32, 32, 32], bevel: 2, trim: 'hull_trim:bevel' }] });
  e.run('model_create', { name: 'hull2', parts: [{ type: 'box', size: [32, 32, 32], bevel: 2, trim: { sheet: 'obj_trim', strip: 'bevel' } }] });
  e.run('model_create', { name: 'src', parts: [{ type: 'cylinder', r: 16, h: 32, segments: 16, color: '#888888' }] });
  e.run('model_decimate', { name: 'src', out: 'src_d', ratio: 0.5 });
  e.run('model_create', { name: 'user', parts: [{ type: 'baked', mesh: 'src_d' }] });
  for (const c of ['det', 'det_n', 'holes_mask', 'depth', 'noz', 'drk']) e.run('create', { name: c, width: 8 });
  e.run('model_create', { name: 'matm', parts: [{ type: 'box', size: [32, 32, 32], color: '#888888' }], materials: { m1: { detail: { texture: 'det', normal: 'det_n' } } } });
  e.run('model_create', { name: 'ruin', parts: [{ type: 'wall', size: [32, 32, 4], color: '#777777', holes: 'holes_mask' }, { type: 'extrude', canvas: 'det', depth_map: 'depth' }] });
  e.run('model_create', { name: 'ship', parts: [{ type: 'engine', textures: { nozzle: 'noz' }, dark: 'drk' }] });
  const want = { 'canvas:hull_trim': 'model:hull', 'canvas:obj_trim': 'model:hull2', 'model:src_d': 'model:user', 'canvas:det': 'model:matm', 'canvas:det_n': 'model:matm', 'canvas:holes_mask': 'model:ruin', 'canvas:depth': 'model:ruin', 'canvas:noz': 'model:ship', 'canvas:drk': 'model:ship' };
  const p = e.run('cleanup_plan', { full: true, select: { ids: Object.keys(want) } });
  const by = blockedBy(p);
  for (const [id, user] of Object.entries(want)) assert.ok(by[id]?.includes(user), `${id} should be blocked by ${user}: ${JSON.stringify(p.blocked)}`);
  const orphans = e.run('cleanup_flags', {}).orphans;
  for (const id of Object.keys(want)) assert.ok(!orphans.includes(id), `${id} is used, not an orphan`);
  assert.throws(() => e.run('cleanup_apply', { select: { ids: ['canvas:hull_trim'] }, confirm: true }), /refused, nothing removed/);
  assert.ok(e.docs.has('hull_trim'));
});
