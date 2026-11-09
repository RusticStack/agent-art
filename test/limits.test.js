// The 0.9 limits pass: fp aim variants, diagonal muzzle sprites, steam sfx, damage UV set / LOD blend /
// rigs / sprite overlay / open meshes / overlay morph, gun disarm, depth-aware front / back contact
// checks, per-skeleton takedowns; plus the unchanged-output corpus (byte-identical to 0.9.0).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Engine } from '../src/engine.js';
import { decodePNG } from '../src/png.js';
import { renderSfx } from '../src/audio/sfx.js';
import { normFx, renderFx, validateFxMeta, presetItems } from '../src/fx/render.js';
import { validateGLB } from '../src/gltfvalidate.js';
import { validateGLB as checkGLB } from '../src/gltfcheck.js';
import { manifoldStats } from '../src/csg.js';
import { corpus } from './fixtures/limits-corpus.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'agent-art-limits-'));
const golden = JSON.parse(fs.readFileSync(new URL('./fixtures/limits-golden-0.9.json', import.meta.url), 'utf8'));
const glbJSON = (buf) => JSON.parse(buf.toString('utf8', 20, 20 + buf.readUInt32LE(12)));

test('limits corpus: everything that does not use a changed feature is byte-identical to 0.9.0', () => {
  const e = new Engine({ home: tmp() });
  const now = corpus(e, { decodePNG, renderSfx });
  const diff = Object.keys(golden).filter((k) => now[k] !== golden[k]);
  assert.equal(Object.keys(golden).length, 260);
  assert.deepEqual(diff, [], `changed: ${diff.slice(0, 10).join(', ')}`);
});

// ---------- art_fx ----------
test('fx fp muzzle: aim variants are drawn per aim (not rotated), listed with their aim for a nearest pick', () => {
  const home = tmp(), e = new Engine({ home }), dir = path.join(home, 'fx');
  const r = e.run('fx_make', { type: 'muzzle', variant: 'rifle', view: 'fp', seed: 3, path: dir });
  const aims = r.meta.fp.aims;
  assert.equal(aims.length, 5, 'default 5 variants');
  // 25 deg apart around the base aim (screen angles wrap at +-180, so compare on the circle)
  const deg = aims.map((v) => v.aim_deg), gaps = deg.map((d, i) => (i ? d - deg[i - 1] : d + 360 - deg[deg.length - 1]));
  assert.equal(gaps.filter((g) => Math.abs(g - 25) < 0.01).length, 4, `gaps ${gaps}`);
  assert.ok(aims.some((v) => v.file === r.meta.file) && aims.some((v) => Math.abs(v.aim_deg - r.meta.fp.aim_deg) < 0.01), 'the base sheet is one variant');
  const sheets = aims.map((v) => decodePNG(fs.readFileSync(path.join(dir, v.file))));
  for (const s of sheets) assert.deepEqual([s.width, s.height], [sheets[0].width, sheets[0].height]);
  for (let i = 1; i < sheets.length; i++) assert.ok(!Buffer.from(sheets[i].data).equals(Buffer.from(sheets[0].data)), `variant ${i} has its own pixels`);
  validateFxMeta(r.meta);
  // explicit degrees, one-aim (no variants) and the error path
  const r2 = e.run('fx_make', { type: 'muzzle', variant: 'pistol', view: 'fp', aims: [-30, 0, 30], path: dir, group: 'g2' });
  assert.equal(r2.meta.fp.aims.length, 3);
  const r3 = e.run('fx_make', { type: 'muzzle', variant: 'pistol', view: 'fp', aims: false, path: dir, group: 'g3' });
  assert.equal(r3.meta.fp.aims, undefined);
  assert.throws(() => e.run('fx_make', { type: 'muzzle', variant: 'rifle', view: 'side', aims: 3, path: dir }), /aims/);
});

test('fx muzzle diagonals: front_side / back_side are drawn per view; the per-view table names them', () => {
  const sheet = (view) => renderFx(normFx({ type: 'muzzle', variant: 'rifle', view, seed: 2 }));
  const side = sheet('side'), fs3 = sheet('front_side'), bs3 = sheet('back_side');
  assert.ok(!Buffer.from(fs3.sheet.data).equals(Buffer.from(side.sheet.data)) && !Buffer.from(bs3.sheet.data).equals(Buffer.from(fs3.sheet.data)));
  for (const r of [side, fs3, bs3]) validateFxMeta(r.meta);
  const t = side.meta.views;
  assert.equal(t.SE.fx, 'muzzle_rifle_front_side');
  assert.equal(t.NW.fx, 'muzzle_rifle_back_side');
  assert.equal(t.NW.flip_x, true);
  assert.ok(fs3.meta.pivot[0] > side.meta.pivot[0], 'room behind the muzzle for the 3/4-front star');
  const ids = presetItems('muzzle').map((x) => x.view);
  assert.ok(ids.includes('front_side') && ids.includes('back_side'), 'presets carry the diagonals');
});

test('fx steam: loop + one-shot sfx recipes wired into the metadata; analyze / critique pass', async () => {
  const { runTool } = await import('../src/mcp.js');
  const e = new Engine({ home: tmp() });
  const call = async (a) => (await runTool('art_audio', a, (op, args) => e.run(op, args))).map((c) => c.text || '').join('\n');
  const vent = renderFx(normFx({ type: 'steam', variant: 'vent', seed: 1 })).meta, leak = renderFx(normFx({ type: 'steam', variant: 'leak', seed: 1 })).meta;
  assert.deepEqual(vent.sound, ['steam_vent', 'steam_hiss']);
  assert.deepEqual(leak.sound, ['steam_leak', 'steam_hiss']);
  for (const r of ['steam_hiss', 'steam_vent', 'steam_leak']) {
    const s = renderSfx({ recipe: r, seed: 1 });
    assert.ok(s.chs[0].length > 1000, r);
    await call({ action: 'sfx', name: r, recipe: r, seed: 1 });
    const c = await call({ action: 'critique', name: r });
    assert.match(c, /score[^0-9]*(9\d|100)/i, `${r} critique: ${c.slice(0, 200)}`);
  }
});

// ---------- damage ----------
function crate(e) {
  e.run('create', { name: 'hull', width: 16 });
  e.run('draw', { canvas: 'hull', commands: [{ op: 'noise', colors: ['#5b626d', '#626974', '#686f7a'], scale: 3, seed: 3 }] });
  e.run('model_create', { name: 'crate', origin: 'bottom', parts: [{ type: 'box', id: 'body', w: 24, h: 24, d: 24, texture: 'hull' }, { type: 'box', id: 'lid', w: 26, h: 2, d: 26, at: [0, 24, 0], texture: 'hull' }] });
  e.run('model_damage', { name: 'crate', kind: 'crate', seed: 7, states: ['scuffed', 'damaged', 'wrecked'] });
}

test('damage masks move off TEXCOORD_1: AO / lightmap keep it, the mask UVs take the next free set', () => {
  const e = new Engine({ home: tmp() }), dir = tmp();
  crate(e);
  e.run('model_export', { name: 'crate', path: path.join(dir, 'crate.glb'), bake_ao: true, uv2: true });
  const glb = fs.readFileSync(path.join(dir, 'crate.damage.glb')), J = glbJSON(glb), man = JSON.parse(fs.readFileSync(path.join(dir, 'crate.damage.json'), 'utf8'));
  assert.ok(validateGLB(glb).ok && checkGLB(glb).ok);
  const intact = J.meshes.find((m) => m.name === 'crate_intact');
  for (const p of intact.primitives) {
    assert.ok(p.attributes.TEXCOORD_1 !== undefined && p.attributes.TEXCOORD_2 !== undefined && p.attributes.TEXCOORD_3 !== undefined, 'AO + uv2 + damage');
    assert.equal(J.materials[p.material].occlusionTexture?.texCoord, 1, 'AO on TEXCOORD_1');
  }
  assert.match(man.blend.uv_set, /^TEXCOORD_3/);
  assert.equal(J.nodes.find((n) => n.name === 'crate_intact').extras.blend.uv_set, 3);
  assert.ok(man.bake.ao, 'baked AO reported');
  // nothing baked: the mask stays on TEXCOORD_1 (unchanged default)
  const d2 = tmp();
  e.run('model_export', { name: 'crate', path: path.join(d2, 'crate.glb') });
  assert.match(JSON.parse(fs.readFileSync(path.join(d2, 'crate.damage.json'), 'utf8')).blend.uv_set, /^TEXCOORD_1 /);
});

test('damage blend works on every LOD: chart UVs, damage RGBA and the dent morph ride the collapses', () => {
  const e = new Engine({ home: tmp() }), dir = tmp();
  crate(e);
  e.run('model_export', { name: 'crate', path: path.join(dir, 'crate.glb'), damage: { lods: [1, 0.5, 0.25], vertex: 'attribute' } });
  const glb = fs.readFileSync(path.join(dir, 'crate.damage.glb')), J = glbJSON(glb), man = JSON.parse(fs.readFileSync(path.join(dir, 'crate.damage.json'), 'utf8'));
  assert.ok(validateGLB(glb).ok);
  const lods = man.states[0].lods;
  assert.equal(lods.length, 3);
  assert.ok(lods[1].triangles < lods[0].triangles && lods[2].triangles < lods[1].triangles);
  for (const L of lods) {
    const m = J.meshes.find((x) => x.name === L.node);
    for (const p of m.primitives.filter((q) => q.attributes.TEXCOORD_1 !== undefined || q.targets)) assert.ok(p.targets?.length === 1 && p.attributes.TEXCOORD_1 !== undefined && p.attributes._DAMAGE !== undefined, `${L.node}: morph + mask UVs + damage RGBA`);
    assert.ok(m.primitives.some((p) => p.targets), `${L.node} carries the dent morph`);
  }
  assert.match(man.blend.note, /every LOD level/);
});

test('damage on a rigid rig: hierarchy, sockets and clips per state; a damaged door still opens', () => {
  const e = new Engine({ home: tmp() }), dir = tmp();
  e.run('model_create', { name: 'locker', origin: 'bottom', parts: [
    { type: 'box', name: 'body', w: 24, h: 40, d: 16, color: '#667' },
    { type: 'box', name: 'door', parent: 'body', w: 22, h: 38, d: 2, at: [0, 1, 9], pivot: [-11, 0, 0], color: '#889' },
  ], sockets: { handle: { part: 'door', at: [8, 20, 10] } } });
  e.run('model_animate', { name: 'locker', clip: 'open', keys: [{ t: 0, parts: { door: { rot: [0, 0, 0] } } }, { t: 1, parts: { door: { rot: [0, -100, 0] } } }] });
  e.run('model_damage', { name: 'locker', kind: 'door', states: ['scuffed', 'damaged', 'wrecked'], seed: 4 });
  e.run('model_export', { name: 'locker', path: path.join(dir, 'locker.glb'), damage: { lods: [1, 0.5] } });
  const glb = fs.readFileSync(path.join(dir, 'locker.damage.glb')), J = glbJSON(glb), man = JSON.parse(fs.readFileSync(path.join(dir, 'locker.damage.json'), 'utf8'));
  assert.ok(validateGLB(glb).ok && checkGLB(glb).ok);
  assert.equal(man.rig.validation, 'ok');
  assert.deepEqual(man.rig.nodes, ['locker', 'body', 'door']);
  const byName = new Map(J.nodes.map((n, i) => [n.name, i]));
  for (const s of man.states) for (const L of s.lods) {
    const door = J.nodes[byName.get(`${L.node}_door`)];
    assert.ok(door && door.mesh !== undefined, `${L.node}_door is its own node with a mesh`);
    assert.ok(J.nodes[byName.get(`${L.node}_body`)].children.includes(byName.get(`${L.node}_door`)), 'door under body');
    assert.ok(byName.has(`${L.node}_socket_handle`), 'socket per state');
  }
  const open = J.animations.find((a) => a.name === 'open');
  const driven = new Set(open.channels.map((c) => J.nodes[c.target.node].name));
  for (const s of man.states) for (const L of s.lods) assert.ok(driven.has(`${L.node}_door`), `open drives ${L.node}_door`);
  // the door piece sits in its node's rest frame: world bounds = the part's model-space bounds
  const plain = glbJSON(fs.readFileSync(path.join(dir, 'locker.glb')));
  const pdoor = plain.nodes.find((n) => n.name === 'door'), ddoor = J.nodes[byName.get('locker_intact_LOD0_door')];
  assert.deepEqual(ddoor.translation, pdoor.translation);
  const acc = (j, n) => j.accessors[j.meshes[n.mesh].primitives[0].attributes.POSITION];
  const a = acc(plain, pdoor), b = acc(J, ddoor);
  for (let k = 0; k < 3; k++) { assert.ok(Math.abs(a.min[k] - b.min[k]) < 0.05 && Math.abs(a.max[k] - b.max[k]) < 0.05, 'intact door piece matches the plain export'); }
});

test('damage on a skinned model: every state is skinned on the shared armature with its weights', () => {
  const e = new Engine({ home: tmp() }), dir = tmp();
  e.run('model_create', { name: 'snake', parts: [{ type: 'tube', path: [[0, 32, 0], [0, 20, 0], [0, 8, 0], [0, 2, 0]], r: 3, sides: 8, texture: '#c84', segments: 4 }] });
  e.run('model_skeleton', { name: 'snake', skeleton: { template: 'chain', count: 3, from: [0, 32, 0], to: [0, 2, 0] } });
  e.run('model_skin', { name: 'snake', skin: { method: 'heat' } });
  e.run('model_damage', { name: 'snake', states: ['scuffed', 'wrecked'], seed: 2 });
  e.run('model_export', { name: 'snake', path: path.join(dir, 'snake.glb'), damage: { masks: false } });
  const glb = fs.readFileSync(path.join(dir, 'snake.damage.glb')), J = glbJSON(glb), man = JSON.parse(fs.readFileSync(path.join(dir, 'snake.damage.json'), 'utf8'));
  const v = validateGLB(glb);
  assert.ok(v.ok && checkGLB(glb).ok, v.errors?.join('; '));
  assert.equal(J.skins.length, 1);
  const skinned = J.nodes.filter((n) => n.skin === 0).map((n) => n.name);
  assert.deepEqual(skinned, ['snake_intact', 'snake_scuffed', 'snake_wrecked']);
  for (const n of J.nodes.filter((x) => x.skin === 0)) for (const p of J.meshes[n.mesh].primitives) assert.ok(p.attributes.JOINTS_0 !== undefined && p.attributes.WEIGHTS_0 !== undefined);
  assert.equal(man.states[0].skin.weights, 'bind (the skinned export)');
  assert.ok(man.skin.weight_transfer_max_px < 3, `weights from the bind surface (${man.skin.weight_transfer_max_px} px)`);
  assert.throws(() => e.run('model_export', { name: 'snake', path: path.join(dir, 's2.glb'), damage: { lods: [1, 0.5] } }), /skinned model: lods/);
});

test('sprite damage overlay: 0.25 / 0.6 / 1.0 read clearly on 128x192, palette-only, same spots per view', () => {
  const e = new Engine({ home: tmp() });
  const plate = ['#232a33', '#2e3640', '#3c4652', '#5a6878', '#7a8898', '#a4b0bc', '#c8d0d6'];
  e.run('create', { name: 'p', width: 128, height: 192 });
  e.run('draw', { canvas: 'p', commands: [{ op: 'rect', x: 14, y: 10, w: 100, h: 172, color: plate[3] }, { op: 'shade', colors: plate.slice(1, 6), of: plate[3] }, { op: 'outline', color: '#161a20' }] });
  const base = Buffer.from(e.get('p').composite());
  const pal = new Set([...plate, '#161a20']);
  const changed = [];
  for (const amount of [0.25, 0.6, 1]) {
    e.run('duplicate', { canvas: 'p', new_name: `p${amount}` });
    e.run('draw', { canvas: `p${amount}`, commands: [{ op: 'damage', amount, seed: 4, on: plate }] });
    const d = e.get(`p${amount}`).composite();
    let n = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i] !== base[i] || d[i + 1] !== base[i + 1] || d[i + 2] !== base[i + 2]) n++;
      if (d[i + 3]) assert.ok(pal.has('#' + [d[i], d[i + 1], d[i + 2]].map((v) => v.toString(16).padStart(2, '0')).join('')), 'palette only');
    }
    changed.push(n / (128 * 192));
  }
  assert.ok(changed[0] > 0.02, `0.25 visible (${(changed[0] * 100).toFixed(1)}% of the cell)`);
  assert.ok(changed[1] > changed[0] * 1.5 && changed[2] > changed[1] * 1.2, `grows: ${changed.map((c) => (c * 100).toFixed(1)).join(' / ')}%`);
  // same seed on a second view of the same box: the damage lands in the same box-relative spots
  e.run('create', { name: 'q', width: 128, height: 192 });
  e.run('draw', { canvas: 'q', commands: [{ op: 'rect', x: 14, y: 10, w: 100, h: 172, color: plate[3] }, { op: 'damage', amount: 0.6, seed: 4, on: plate }] });
  e.run('create', { name: 'q2', width: 128, height: 192 });
  e.run('draw', { canvas: 'q2', commands: [{ op: 'rect', x: 14, y: 10, w: 100, h: 172, color: plate[3] }, { op: 'damage', amount: 0.6, seed: 4, on: plate }] });
  assert.ok(Buffer.from(e.get('q').composite()).equals(Buffer.from(e.get('q2').composite())), 'deterministic per box');
});

test('open meshes: fracture and breaches close open parts first (close:false refuses); chunks stay watertight', () => {
  const e = new Engine({ home: tmp() });
  e.run('model_create', { name: 'pipe', origin: 'bottom', parts: [{ type: 'tube', id: 'duct', from: [-20, 10, 0], to: [20, 10, 0], r: 6, sides: 10, caps: false, color: '#8a6' }, { type: 'box', id: 'base', w: 30, h: 4, d: 12, color: '#666' }] });
  assert.throws(() => e.run('model_fracture', { name: 'pipe', parts: [{ part: 'duct', pieces: 5, seed: 2, close: false }] }), /open|closed|watertight/i);
  const r = e.run('model_fracture', { name: 'pipe', parts: [{ part: 'duct', pieces: 5, seed: 2 }] });
  assert.equal(r.groups[0].chunks, 5);
  assert.ok(r.groups[0].closed, 'reports how the part was closed');
  const dir = tmp();
  e.run('model_export', { name: 'pipe', path: path.join(dir, 'pipe.glb') });
  const man = JSON.parse(fs.readFileSync(path.join(dir, 'pipe.damage.json'), 'utf8'));
  assert.ok(man.fracture.groups[0].chunks.every((c) => c.watertight), 'every chunk watertight');
  assert.ok(man.fracture.groups[0].chunks.reduce((s, c) => s + c.volume, 0) > 0);
  // a breach on an open host (a capless duct): the host is closed first so the cut is a real boolean
  e.run('model_create', { name: 'duct', origin: 'bottom', parts: [{ type: 'tube', id: 'shell', from: [-40, 24, 0], to: [40, 24, 0], r: 22, sides: 6, caps: false, color: '#789' }] });
  const w = e.run('model_damage', { name: 'duct', kind: 'hull', states: ['wrecked'], seed: 5 }).states[1].features;
  assert.equal(w.breaches, 1);
  assert.equal(w.closed_hosts, 1);
  const w0 = e.run('model_damage', { name: 'duct', kind: 'hull', states: ['wrecked'], seed: 5, close: false }).states[1].features;
  assert.equal(w0.closed_hosts, undefined, 'close:false leaves the host open');
});

test('damage: intact overlay shells follow the dent morph', () => {
  const e = new Engine({ home: tmp() }), dir = tmp();
  e.run('create', { name: 'grime', width: 8 });
  e.run('draw', { canvas: 'grime', commands: [{ op: 'noise', colors: ['#3a3020', '#4a3c28'], scale: 2, seed: 1 }] });
  e.run('model_create', { name: 'tank', origin: 'bottom', parts: [{ type: 'wall', texture: '#777', w: 48, h: 32, overlays: [{ texture: 'grime', where: 'bottom', falloff: 16, jitter: 0 }] }] });
  e.run('model_damage', { name: 'tank', kind: 'barrel', states: ['scuffed', 'wrecked'], seed: 3 });
  e.run('model_export', { name: 'tank', path: path.join(dir, 'tank.glb') });
  const glb = fs.readFileSync(path.join(dir, 'tank.damage.glb')), J = glbJSON(glb);
  assert.ok(validateGLB(glb).ok);
  const ov = J.nodes.find((n) => n.name === 'tank_intact_overlays');
  assert.ok(ov, 'overlay shells node');
  assert.equal(ov.extras.morph, 'damage');
  assert.ok(J.meshes[ov.mesh].primitives.every((p) => p.targets?.length === 1), 'the shells carry the damage morph');
});

// ---------- melee ----------
test('gun disarm_front: every handling class, take or drop, per-frame gun track for both actors, melee_check passes', () => {
  const e = new Engine({ home: tmp() });
  for (const [cls, mode] of [['rifle', 'take'], ['pistol', 'take'], ['shotgun', 'drop'], ['sniper', 'take']]) {
    const n = `${cls}_${mode}`;
    e.run('anim_skeleton', { name: n, template: 'humanoid_hd', frame: [64, 96], weapon: { class: cls } });
    const lib = e.run('anim_melee', { skeleton: n, disarm: mode });
    assert.ok(lib.clips.includes('disarm_front_attacker') && lib.clips.includes('disarm_front_victim'), n);
    const c = e.run('anim_melee_check', { skeleton: n, clips: ['disarm_front_attacker'] }).clips.disarm_front_attacker;
    assert.ok(c.pass, `${n}: ${JSON.stringify(c.issues)}`);
    assert.equal(c.transfer_mode, mode);
    assert.ok(c.victim_released);
    if (mode === 'take') assert.ok(c.transfer_grip_px <= c.transfer_grip_tolerance_px);
    for (const v of ['front', 'back', 'side', 'front_side', 'back_side']) assert.ok(c.contact_by_view[v] <= c.contact_tolerance_px, `${n} ${v}`);
  }
  // the batch manifest: both actors get the gun track (owner switches at the transfer frame)
  e.run('anim_skin', { name: 'rs', skeleton: 'rifle_take' });
  const out = tmp();
  e.run('anim_batch', { skins: ['rs'], clips: ['disarm_front_attacker', 'disarm_front_victim'], views: ['side', 'front'], out });
  const man = JSON.parse(fs.readFileSync(path.join(out, 'manifest', 'characters.json'), 'utf8'));
  const anims = JSON.stringify(man);
  assert.match(anims, /"transfer"/);
  const find = (o, k, acc = []) => { if (o && typeof o === 'object') { if (o[k]) acc.push(o[k]); for (const v of Object.values(o)) find(v, k, acc); } return acc; };
  const tracks = find(man, 'transfer');
  assert.ok(tracks.length >= 4, 'attacker + victim x 2 views');
  for (const t of tracks) {
    assert.equal(t.mode, 'take');
    assert.equal(t.track[t.frame - 1].owner, 'victim');
    assert.equal(t.track[t.frame].owner, 'attacker');
  }
  assert.throws(() => e.run('anim_melee', { skeleton: 'rifle_take', disarm: 'keep' }), /disarm must be/);
  e.run('anim_skeleton', { name: 'kn', template: 'humanoid_hd', frame: [64, 96] });
  assert.throws(() => e.run('anim_melee', { skeleton: 'kn', weapon: 'combat_knife', disarm: 'take' }), /gun skeletons/);
});

test('paired checks are depth-aware in the front / back views (screen + side-view depth, lateral staging)', () => {
  const e = new Engine({ home: tmp() });
  e.run('anim_skeleton', { name: 'kn', template: 'humanoid_hd', frame: [64, 96] });
  e.run('anim_melee', { skeleton: 'kn', weapon: 'combat_knife' });
  const r = e.run('anim_melee_check', { skeleton: 'kn', clips: ['takedown_rear_attacker', 'disarm_front_attacker'] });
  for (const c of Object.values(r.clips)) {
    assert.ok(c.pass, JSON.stringify(c.issues));
    assert.ok('front' in c.contact_by_view && 'back' in c.contact_by_view, 'front / back measured');
    assert.ok(c.lateral_px && 'front' in c.lateral_px);
  }
  // the batch manifest stages the partner sideways per frame in front / back (partner_dx_track)
  e.run('anim_skin', { name: 'k1', skeleton: 'kn' });
  const out = tmp();
  e.run('anim_batch', { skins: ['k1'], clips: ['disarm_front_attacker'], views: ['side', 'front'], out });
  const s = fs.readFileSync(path.join(out, 'manifest', 'characters.json'), 'utf8');
  assert.match(s, /"partner_dx_track"/);
});

test('per-skeleton takedowns: heavy and light proportions refit the pair on their own rigs', () => {
  const e = new Engine({ home: tmp() });
  e.run('anim_skeleton', { name: 'kn', template: 'humanoid_hd', frame: [64, 96], proportions: { heavy: { width: 1.25, spine: 1.06, legs: 1.04 }, light: { width: 0.85, legs: 0.94, arms: 0.95 } } });
  e.run('anim_melee', { skeleton: 'kn', weapon: 'combat_knife' });
  e.run('anim_skin', { name: 'h', skeleton: 'kn', proportions: 'heavy' });
  e.run('anim_skin', { name: 'l', skeleton: 'kn', proportions: 'light' });
  const hl = e.run('anim_melee_check', { skeleton: 'kn', skin: 'h', victim_skin: 'l', clips: ['takedown_rear_attacker', 'disarm_front_attacker'] });
  assert.match(hl.refit, /proportions/);
  for (const [k, c] of Object.entries(hl.clips)) { assert.ok(c.pass, `heavy on light ${k}: ${JSON.stringify(c.issues)}`); assert.ok(Array.isArray(c.refit_offset)); }
  // light on heavy: the side-plane views meet; a 2.5D front-view arm cannot reach the taller victim's
  // head, and the depth-aware check reports it (front / back only) instead of passing it
  const lh = e.run('anim_melee_check', { skeleton: 'kn', skin: 'l', victim_skin: 'h', clips: ['takedown_rear_attacker'] }).clips.takedown_rear_attacker;
  for (const v of ['side', 'front_side', 'back_side']) assert.ok(lh.contact_by_view[v] <= lh.contact_tolerance_px, `light on heavy ${v}`);
  assert.ok(lh.issues.every((x) => /^(front|back): /.test(x)), JSON.stringify(lh.issues));
  // anim_paired renders the refit pair
  const p = e.run('anim_paired', { skin: 'h', victim_skin: 'l', pair: 'takedown_rear', view: 'side' });
  assert.ok(Array.isArray(p.refit_offset));
});
