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

test('cleanup kinds: art_anim skeletons, clips, skins, weapons and art_planet planets are registered assets', () => {
  const home = tmp();
  const e = new Engine({ home });
  e.run('anim_skeleton', { name: 'hum', template: 'humanoid_hd', frame: [48, 64] });
  e.run('anim_skin', { name: 'hero', skeleton: 'hum' });
  e.run('anim_weapon', { name: 'ak', class: 'rifle', frame: [48, 64] });
  e.run('planet_create', { name: 'mars', preset: 'desert', equirect: 64, preview_size: 32 });
  e.flush();
  // the rigs a skin / weapon draws on are used, not orphans
  const orphans = e.run('cleanup_flags', {}).orphans;
  for (const id of ['rig:hero', 'rig:weapon_ak', 'skeleton:hum', 'clip:hum/idle']) assert.ok(!orphans.includes(id), `${id} is not an orphan`);
  const by = blockedBy(e.run('cleanup_plan', { full: true, select: { ids: ['rig:hero', 'rig:weapon_ak', 'skeleton:hum'] } }));
  assert.ok(by['rig:hero'].includes('skin:hero'));
  assert.ok(by['rig:weapon_ak'].includes('weapon:ak'));
  assert.ok(by['skeleton:hum'].includes('skin:hero') && by['skeleton:hum'].includes('clip:hum/idle'));
  // selectable by kind, removed and restored byte for byte
  const files = ['library/skins/hero.json', 'library/weapons/ak.json', 'library/clips/hum/idle.json', 'planets/mars.json'].map((f) => path.join(home, f));
  const bytes = files.map((f) => fs.readFileSync(f));
  const p = e.run('cleanup_plan', { full: true, select: [{ kind: ['skin', 'weapon', 'planet'] }, { ids: ['clip:hum/idle'] }] });
  assert.deepEqual(p.items.map((x) => x.id).sort(), ['clip:hum/idle', 'planet:mars', 'skin:hero', 'weapon:ak']);
  const r = e.run('cleanup_apply', { plan_id: p.plan_id, confirm: true });
  for (const f of files) assert.ok(!fs.existsSync(f), `${f} moved to the trash`);
  assert.throws(() => e.run('anim_info', { skin: 'hero' }), /no skin "hero"/);
  // a whole skeleton goes with its clips (and the skin needing it) only on request
  assert.match(e.run('cleanup_plan', { select: { ids: ['skeleton:hum'] }, include_dependents: true }).remove.by_kind.clip + '', /^\d+$/);
  e.run('cleanup_restore', { ids: [r.trash] });
  files.forEach((f, i) => assert.deepEqual(fs.readFileSync(f), bytes[i]));
  assert.equal(e.run('anim_info', { skin: 'hero' }).rig, 'hero');
  const usage = e.run('cleanup_usage', {});
  for (const k of ['skeleton', 'clip', 'skin', 'weapon', 'planet']) assert.ok(usage.by_kind[k], `usage lists ${k}`);
});

test('cleanup exports: every file an export writes is linked (roblox maps, cluster LOD, planets, > 12 files)', () => {
  const home = tmp();
  const e = new Engine({ home });
  e.run('create', { name: 'tex', width: 16 });
  e.run('model_create', { name: 'hull', parts: [{ type: 'box', size: [32, 32, 32], texture: 'tex' }] });
  e.run('model_create', { name: 'src', parts: [{ type: 'cylinder', r: 16, h: 32, segments: 24, color: '#888888' }] });
  const ex = e.run('model_export', { name: 'hull', profile: 'roblox' });
  const cl = e.run('model_cluster_lod', { name: 'src' });
  e.run('planet_create', { name: 'mars', preset: 'desert', equirect: 64, preview_size: 32 });
  const sel = (id) => e.run('cleanup_plan', { full: true, select: { ids: [id] }, include_exports: true }).items.map((x) => x.id);
  const rel = (f) => `export:${path.relative(e.exportDir, f).replace(/\\/g, '/')}`;
  const hull = sel('model:hull');
  for (const f of fs.readdirSync(ex.roblox.dir)) assert.ok(hull.includes(rel(path.join(ex.roblox.dir, f))), `roblox ${f}`);
  assert.ok(hull.includes(rel(ex.file)) && hull.includes(rel(ex.meta)));
  const src = sel('model:src');
  for (const f of [cl.file, cl.clod, cl.meta]) assert.ok(src.includes(rel(f)), f);
  // a planet writes far more than 12 files: all of them are its exports
  const marsDir = path.join(e.exportDir, 'mars');
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((x) => (x.isDirectory() ? walk(path.join(d, x.name)) : [path.join(d, x.name)]));
  const all = walk(marsDir);
  assert.ok(all.length > 12);
  const mars = new Set(sel('planet:mars'));
  for (const f of all) assert.ok(mars.has(rel(f)), `planet file ${f}`);
  // only this op's files: an older file in the same folder is not swept in
  fs.writeFileSync(path.join(marsDir, 'readme.txt'), 'mine');
  fs.utimesSync(path.join(marsDir, 'readme.txt'), new Date(2000, 0, 1), new Date(2000, 0, 1));
  e.run('planet_create', { name: 'mars', preset: 'desert', equirect: 64, preview_size: 32 });
  assert.ok(!sel('planet:mars').includes('export:mars/readme.txt'));
  // a file another kept asset also exports (a shared manifest) stays
  e.run('graph_link', { from: 'model:src', rel: 'exports_to', to: `export:hull.meta.json` });
  const p = e.run('cleanup_plan', { full: true, select: { ids: ['model:hull'] }, include_exports: true });
  assert.ok(!p.items.some((x) => x.id === 'export:hull.meta.json'));
  assert.ok(p.warnings.some((w) => /hull\.meta\.json kept: also exported by model:src/.test(w)));
});
