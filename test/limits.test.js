// The 0.9 limits pass: fp aim variants, diagonal muzzle sprites, steam sfx, damage UV set / LOD blend /
// rigs / sprite overlay / open meshes / overlay morph, gun disarm, depth-aware front / back contact
// checks, per-skeleton takedowns; plus the unchanged-output corpus (byte-identical to 0.9.0).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { Engine } from '../src/engine.js';
import { decodePNG } from '../src/png.js';
import { renderSfx } from '../src/audio/sfx.js';
import { normFx, renderFx, validateFxMeta, presetItems } from '../src/fx/render.js';
import { validateGLB } from '../src/gltfvalidate.js';
import { validateGLB as checkGLB } from '../src/gltfcheck.js';
import { manifoldStats } from '../src/csg.js';
import { corpus } from './fixtures/limits-corpus.js';
import { fitOffset, refitPaired, cellsOf } from '../src/meleeops.js';
import { getRig } from '../src/rigops.js';
import { retargetClip } from '../src/animlib.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'agent-art-limits-'));
const golden = JSON.parse(fs.readFileSync(new URL('./fixtures/limits-golden-0.9.json', import.meta.url), 'utf8'));
const glbJSON = (buf) => JSON.parse(buf.toString('utf8', 20, 20 + buf.readUInt32LE(12)));

const INTENDED = ['melee/kn/disarm_front_attacker.json', 'melee/kn/disarm_front_victim.json', 'melee/k1/characters.json'];
test('limits corpus: everything that does not use a changed feature is byte-identical to 0.9.0', () => {
  const e = new Engine({ home: tmp() });
  const now = corpus(e, { decodePNG, renderSfx });
  const diff = Object.keys(golden).filter((k) => now[k] !== golden[k] && !INTENDED.includes(k));
  assert.equal(Object.keys(golden).length, 260);
  assert.deepEqual(diff, [], `changed: ${diff.slice(0, 10).join(', ')}`);
  // the intentional change (CHANGELOG): the knife disarm_front fit now reaches its optimum (offset
  // 73.15; 0.9.0 stopped on the search bound at 70), so those clips and the batch manifest differ.
  // Ground contact (feet below the ground row lifted by leg IK) changes melee frame poses, not clip
  // files: of the corpus only that batch manifest (takedown_rear_victim frames) can see it.
  for (const k of INTENDED) assert.notEqual(now[k], golden[k], `${k} expected to change`);
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
});

test('skinned damage: LOD levels, the Roblox profile, baked light and fracture chunks on bones keep the armature', () => {
  const e = new Engine({ home: tmp() }), dir = tmp();
  e.run('model_create', { name: 'snake', parts: [{ type: 'tube', path: [[0, 32, 0], [0, 20, 0], [0, 8, 0], [0, 2, 0]], r: 3, sides: 8, texture: '#c84', segments: 4 }, { type: 'box', w: 6, h: 6, d: 6, at: [0, 8, 4], color: '#888' }] });
  e.run('model_skeleton', { name: 'snake', skeleton: { template: 'chain', count: 3, from: [0, 32, 0], to: [0, 2, 0] } });
  e.run('model_skin', { name: 'snake', skin: { method: 'heat' } });
  e.run('model_damage', { name: 'snake', states: ['scuffed', 'wrecked'], seed: 2 });
  assert.equal(e.run('model_fracture', { name: 'snake', groups: [{ part: 1, pieces: 4, seed: 1 }] }).groups[0].chunks, 4, 'skinned models fracture');
  const load = (k) => { const man = JSON.parse(fs.readFileSync(path.join(dir, `${k}.damage.json`), 'utf8')); const glb = fs.readFileSync(path.join(dir, man.file)); return { man, glb, J: glbJSON(glb) }; };
  const valid = (glb, what) => { const v = validateGLB(glb), c = checkGLB(glb); assert.ok(v.ok && c.ok, `${what}: ${[...(v.errors || []), ...(c.errors || [])].slice(0, 3).join('; ')}`); };
  // LODs: every state level is skinned on skin 0; the weights ride through the decimation
  e.run('model_export', { name: 'snake', path: path.join(dir, 'lods.glb'), damage: { lods: [1, 0.5, 0.25] } });
  let { man, glb, J } = load('lods');
  valid(glb, 'lods');
  const lodNodes = J.nodes.filter((n) => /_LOD\d$/.test(n.name) && n.mesh !== undefined);
  assert.equal(lodNodes.length, 9);
  for (const n of lodNodes) { assert.equal(n.skin, 0, n.name); for (const p of J.meshes[n.mesh].primitives) assert.ok(p.attributes.JOINTS_0 !== undefined && p.attributes.WEIGHTS_0 !== undefined, `${n.name} weights`); }
  const tris = (n) => J.meshes[n.mesh].primitives.reduce((s, p) => s + J.accessors[p.indices].count / 3, 0);
  for (const st of ['intact', 'scuffed', 'wrecked']) { const t = [0, 1, 2].map((l) => tris(J.nodes.find((x) => x.name === `snake_${st}_LOD${l}`))); assert.ok(t[0] > t[1] && t[1] > t[2], `${st} levels ${t}`); }
  assert.ok(man.skin.weight_transfer_max_px < 3, `${man.skin.weight_transfer_max_px}`);
  // fracture: rigid chunks parented to their nearest bone, hidden until the break
  const chunks = J.nodes.filter((n) => n.extras?.chunk);
  assert.equal(chunks.length, 4);
  const parentOf = new Map(); J.nodes.forEach((n, i) => (n.children || []).forEach((c) => parentOf.set(c, i)));
  const joints = new Set(J.skins[0].joints);
  for (const c of chunks) { const i = J.nodes.indexOf(c); assert.ok(joints.has(parentOf.get(i)), `${c.name} on a bone`); assert.equal(J.nodes[parentOf.get(i)].name, c.extras.bone); assert.equal(c.skin, undefined, 'chunks are rigid'); assert.equal(c.extras.visible, false); }
  assert.ok(chunks.some((c) => c.extras.bone === 'chain_2'), 'the box sits low: its chunks ride the lowest bones');
  assert.deepEqual(man.fracture.groups[0].chunks.map((c) => c.bone), chunks.map((c) => c.extras.bone));
  // rest placement: bone rest world x chunk matrix puts the chunk origin on its centre of mass
  const local = (n) => {
    if (n.matrix) return n.matrix;
    const [x, y, z, w] = n.rotation || [0, 0, 0, 1], t = n.translation || [0, 0, 0];
    return [1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w), 0, 2 * (x * y - z * w), 1 - 2 * (x * x + z * z), 2 * (y * z + x * w), 0, 2 * (x * z + y * w), 2 * (y * z - x * w), 1 - 2 * (x * x + y * y), 0, t[0], t[1], t[2], 1];
  };
  const mm = (A, B) => { const r = new Array(16).fill(0); for (let c = 0; c < 4; c++) for (let rr = 0; rr < 4; rr++) for (let k = 0; k < 4; k++) r[c * 4 + rr] += A[k * 4 + rr] * B[c * 4 + k]; return r; };
  const worldOf = (i) => (parentOf.has(i) ? mm(worldOf(parentOf.get(i)), local(J.nodes[i])) : local(J.nodes[i]));
  man.fracture.groups[0].chunks.forEach((c, k) => { const M = worldOf(J.nodes.indexOf(chunks[k])); for (let a = 0; a < 3; a++) assert.ok(Math.abs(M[12 + a] - c.center[a]) < 1e-3, `${c.name} rest centre ${M.slice(12, 15)} vs ${c.center}`); });
  // Roblox: MeshParts <= 20k tris, <= 4 influences, bones per mesh capped (split into skins over the same bones)
  e.run('model_export', { name: 'snake', path: path.join(dir, 'rb.glb'), damage: { profile: 'roblox' } });
  ({ man, glb, J } = load('rb'));
  valid(glb, 'roblox');
  assert.ok(man.skin.roblox.max_influences <= 4 && man.skin.roblox.max_joints_per_mesh <= 50, JSON.stringify(man.skin.roblox));
  for (const m of J.meshes) for (const p of m.primitives) assert.equal(p.targets, undefined, 'no morph targets on Roblox');
  assert.ok(J.nodes.filter((n) => n.skin !== undefined).length >= 3);
  // baked AO / lightmap on the bind (rest) pose
  e.run('model_export', { name: 'snake', path: path.join(dir, 'lm.glb'), bake_ao: true, lightmap: true, damage: true });
  ({ man, glb, J } = load('lm'));
  valid(glb, 'baked');
  assert.ok(man.bake?.lightmap, 'lightmap baked on the damage glb');
  const intact = J.nodes.find((n) => n.name === 'snake_intact');
  assert.ok(J.meshes[intact.mesh].primitives[0].attributes.TEXCOORD_1 !== undefined && intact.skin === 0);
  assert.equal(man.blend.uv_set.slice(0, 10), 'TEXCOORD_2');
  // a mesh weighted to more bones than max_bones splits into several skinned meshes (Roblox limit)
  e.run('model_create', { name: 'eel', parts: Array.from({ length: 8 }, (_, i) => ({ type: 'box', w: 6, h: 7, d: 6, at: [0, 4 + i * 8, 0], color: '#c84' })) });
  e.run('model_skeleton', { name: 'eel', skeleton: { template: 'chain', count: 8, from: [0, 64, 0], to: [0, 0, 0] } });
  e.run('model_skin', { name: 'eel', skin: { method: 'rigid' } });
  e.run('model_damage', { name: 'eel', states: ['wrecked'], seed: 2 });
  e.run('model_export', { name: 'eel', path: path.join(dir, 'eel.glb'), damage: { profile: 'roblox', max_bones: 4 } });
  const eel = JSON.parse(fs.readFileSync(path.join(dir, 'eel.damage.json'), 'utf8')), eg = fs.readFileSync(path.join(dir, eel.file)), EJ = glbJSON(eg);
  valid(eg, 'roblox split');
  assert.ok(eel.skin.roblox.max_joints_per_mesh <= 4 && EJ.skins.length > 1, JSON.stringify(eel.skin.roblox));
  for (const n of EJ.nodes.filter((x) => x.skin !== undefined)) assert.ok(EJ.skins[n.skin].joints.length <= 4, `${n.name}: ${EJ.skins[n.skin].joints.length} joints`);
});

test('plain export of rigged and skinned models with lods / bake_ao: rig, clips and skin kept, AO on the rest pose', () => {
  const e = new Engine({ home: tmp() }), dir = tmp();
  e.run('model_create', { name: 'locker', origin: 'bottom', parts: [
    { type: 'box', name: 'body', w: 24, h: 40, d: 16, color: '#667', segments: 4 },
    { type: 'cylinder', name: 'door', parent: 'body', r: 6, h: 38, segments: 24, at: [0, 1, 9], pivot: [-11, 0, 0], color: '#889' },
  ], sockets: { handle: { part: 'door', at: [8, 20, 10] } } });
  e.run('model_animate', { name: 'locker', clip: 'open', keys: [{ t: 0, parts: { door: { rot: [0, 0, 0] } } }, { t: 1, parts: { door: { rot: [0, -100, 0] } } }] });
  const plain = glbJSON(fs.readFileSync(e.run('model_export', { name: 'locker', path: path.join(dir, 'p.glb') }).file));
  const r = e.run('model_export', { name: 'locker', path: path.join(dir, 'l.glb'), lods: [1, 0.5, 0.25], bake_ao: { mode: 'texture' } });
  const glb = fs.readFileSync(r.file), J = glbJSON(glb);
  assert.ok(validateGLB(glb).ok && checkGLB(glb).ok);
  assert.deepEqual(r.animations, ['open']);
  assert.deepEqual(r.lods.map((l) => l.level), [0, 1, 2]);
  assert.ok(r.lods[0].triangles > r.lods[1].triangles && r.lods[1].triangles > r.lods[2].triangles, JSON.stringify(r.lods));
  // the rig is unchanged: same node TRS, the clip drives the door node, the LOD children ride it
  for (const n of plain.nodes) { const m = J.nodes.find((x) => x.name === n.name); assert.ok(m, n.name); assert.deepEqual(m.translation, n.translation); assert.deepEqual(m.rotation, n.rotation); }
  const door = J.nodes.findIndex((n) => n.name === 'door');
  const kids = J.nodes[door].children.map((c) => J.nodes[c].name);
  assert.ok(kids.includes('door_LOD1') && kids.includes('door_LOD2'), kids.join(','));
  assert.ok(J.animations[0].channels.some((c) => c.target.node === door));
  // AO: TEXCOORD_1 + occlusionTexture on every rig mesh (each LOD level occludes itself)
  for (const m of J.meshes) for (const p of m.primitives) { assert.ok(p.attributes.TEXCOORD_1 !== undefined, `${m.name} AO UVs`); assert.equal(J.materials[p.material].occlusionTexture?.texCoord, 1); }
  assert.equal(r.ao.pose, 'rest');
  // skinned: LOD levels skinned on skin 0 (weights carried), AO on the bind pose
  e.run('model_create', { name: 'snake', parts: [{ type: 'tube', path: [[0, 32, 0], [0, 20, 0], [0, 8, 0], [0, 2, 0]], r: 3, sides: 8, texture: '#c84', segments: 4 }] });
  e.run('model_skeleton', { name: 'snake', skeleton: { template: 'chain', count: 3, from: [0, 32, 0], to: [0, 2, 0] } });
  e.run('model_skin', { name: 'snake', skin: { method: 'heat' } });
  const s = e.run('model_export', { name: 'snake', path: path.join(dir, 's.glb'), lods: [1, 0.5, 0.25], bake_ao: true });
  const sg = fs.readFileSync(s.file), SJ = glbJSON(sg);
  assert.ok(validateGLB(sg).ok && checkGLB(sg).ok);
  assert.deepEqual(SJ.nodes.filter((n) => n.skin === 0).map((n) => n.name), ['snake_mesh', 'snake_mesh_LOD1', 'snake_mesh_LOD2']);
  for (const n of SJ.nodes.filter((x) => x.skin === 0)) for (const p of SJ.meshes[n.mesh].primitives) assert.ok(p.attributes.JOINTS_0 !== undefined && p.attributes.WEIGHTS_0 !== undefined && p.attributes.TEXCOORD_1 !== undefined, n.name);
  assert.ok(s.skin.lods[0] > s.skin.lods[1] && s.skin.lods[1] > s.skin.lods[2], JSON.stringify(s.skin.lods));
  assert.ok(s.skin.weight_transfer_max_px < 3);
  assert.equal(s.skin.bake.pose, 'bind (rest)');
  assert.throws(() => e.run('model_export', { name: 'snake', path: path.join(dir, 'r.glb'), lods: [1, 0.5], profile: 'roblox' }), /RenderFidelity/);
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
  // the batch manifest stages what depth staging leaves sideways per frame in front / back
  // (partner_dx_track: the takedown; the face-to-face disarm meets in depth, partner_flip, no track)
  e.run('anim_skin', { name: 'k1', skeleton: 'kn' });
  const out = tmp();
  e.run('anim_batch', { skins: ['k1'], clips: ['disarm_front_attacker', 'takedown_rear_attacker'], views: ['side', 'front'], out });
  const an = JSON.parse(fs.readFileSync(path.join(out, 'manifest', 'characters.json'), 'utf8')).sprites.k1.anims;
  assert.ok(Array.isArray(an.takedown_rear_attacker_front.melee.paired.partner_dx_track));
  assert.equal(an.disarm_front_attacker_front.melee.paired.partner_flip, true);
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
  // light on heavy: the foreshortened front / back arm falls short of the taller victim's head with a
  // planar solve (6.8 px vs 4 in 0.9 limits pass 1); the reach extends in depth there and it passes
  const lh = e.run('anim_melee_check', { skeleton: 'kn', skin: 'l', victim_skin: 'h', clips: ['takedown_rear_attacker'] }).clips.takedown_rear_attacker;
  assert.ok(lh.pass, `light on heavy takedown_rear: ${JSON.stringify(lh.issues)}`);
  for (const v of ['side', 'front_side', 'front', 'back_side', 'back']) assert.ok(lh.contact_by_view[v] <= lh.contact_tolerance_px, `light on heavy ${v}`);
  // same-proportion pairs keep passing
  for (const s of ['h', 'l']) { const c = e.run('anim_melee_check', { skeleton: 'kn', skin: s, victim_skin: s, clips: ['takedown_rear_attacker'] }).clips.takedown_rear_attacker; assert.ok(c.pass, `${s} on ${s}: ${JSON.stringify(c.issues)}`); }
  // anim_paired renders the refit pair
  const p = e.run('anim_paired', { skin: 'h', victim_skin: 'l', pair: 'takedown_rear', view: 'side' });
  assert.ok(Array.isArray(p.refit_offset));
});

test('front / back depth staging: the partner is drawn mirrored (partner_flip), lateral staging <= 8 px at 128x192', () => {
  const e = new Engine({ home: tmp() }), out = tmp();
  const lat = {};
  for (const [sk, mel, skel] of [['kn', { weapon: 'combat_knife' }, {}], ['rf', {}, { weapon: { class: 'rifle' } }]]) {
    e.run('anim_skeleton', { name: sk, template: 'humanoid_hd', frame: [128, 192], ...skel });
    e.run('anim_melee', { skeleton: sk, ...mel });
    const r = e.run('anim_melee_check', { skeleton: sk, clips: ['disarm_front_attacker', 'takedown_rear_attacker'] });
    for (const [k, c] of Object.entries(r.clips)) {
      lat[`${sk}/${k}`] = c.lateral_px;
      for (const v of ['front', 'back']) { assert.ok(Math.abs(c.lateral_px[v]) <= 8, `${sk} ${k} ${v}: lateral ${c.lateral_px[v]} px`); assert.ok(c.contact_by_view[v] <= c.contact_tolerance_px, `${sk} ${k} ${v}: contact ${c.contact_by_view[v]} px`); }
    }
  }
  // the knife disarm was staged 25.2 px sideways in 0.9 limits pass 1
  assert.ok(Math.abs(lat['kn/disarm_front_attacker'].front) <= 1, JSON.stringify(lat));
  // batch manifest: front / back of a face-to-face pair carry partner_flip (the runtime mirrors the
  // partner sprite about its root); same-facing pairs (takedown_rear) do not
  e.run('anim_skin', { name: 'k', skeleton: 'kn' });
  e.run('anim_batch', { skins: ['k'], clips: ['disarm_front_attacker', 'takedown_rear_attacker'], views: ['side', 'front', 'back'], out });
  const man = JSON.parse(fs.readFileSync(path.join(out, 'manifest', 'characters.json'), 'utf8'));
  const anims = man.sprites.k.anims;
  const pairedOf = (clip, view) => anims[`${clip}_${view}`].melee.paired;
  assert.equal(pairedOf('disarm_front_attacker', 'front')?.partner_flip, true);
  assert.equal(pairedOf('disarm_front_attacker', 'side')?.partner_flip, undefined);
  assert.equal(pairedOf('takedown_rear_attacker', 'front')?.partner_flip, undefined);
  // anim_paired draws the mirrored partner
  const p = e.run('anim_paired', { skin: 'k', pair: 'disarm_front', view: 'front' });
  assert.equal(p.partner_dx_track, undefined, 'no lateral staging left in the front view');
});

// ---------- paired fit determinism ----------
const PROPS = { heavy: { width: 1.25, spine: 1.06, legs: 1.04 }, light: { width: 0.85, legs: 0.94, arms: 0.95 } };
const SETS = [['kn', { weapon: 'combat_knife' }, {}], ['sh', { weapon: 'baton', shield: true }, {}], ['rf', {}, { weapon: { class: 'rifle' } }]];
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
/** Every paired clip of a knife, a shield and a rifle skeleton, refit for heavy on light and light on heavy, on a fresh engine. */
function pairedRefits() {
  const e = new Engine({ home: tmp() });
  const out = {};
  for (const [sk, mel, skel] of SETS) {
    e.run('anim_skeleton', { name: sk, template: 'humanoid_hd', frame: [64, 96], proportions: PROPS, ...skel });
    const m = e.run('anim_melee', { skeleton: sk, ...mel });
    for (const p of ['heavy', 'light']) e.run('anim_skin', { name: `${sk}_${p}`, skeleton: sk, proportions: p });
    for (const pair of m.paired) for (const [a, v] of [['heavy', 'light'], ['light', 'heavy']]) {
      const k = `${sk}/${pair}/${a}_on_${v}`;
      out[`${k}/check`] = JSON.stringify(e.run('anim_melee_check', { skeleton: sk, skin: `${sk}_${a}`, victim_skin: `${sk}_${v}`, clips: [`${pair}_attacker`] }).clips);
      const { image, ...rest } = e.run('anim_paired', { skin: `${sk}_${a}`, victim_skin: `${sk}_${v}`, pair, view: 'front', canvas: 'pp' });
      out[`${k}/paired`] = JSON.stringify(rest) + sha(image);
    }
    for (const f of fs.readdirSync(path.join(e.home, 'library', 'clips', sk)).sort()) out[`${sk}/clip/${f}`] = sha(fs.readFileSync(path.join(e.home, 'library', 'clips', sk, f)));
  }
  return { e, out };
}

test('paired fit: the offset search is deterministic and idempotent (interior optimum, absolute grid, tie = middle)', () => {
  // the minimum does not depend on where the search starts, and it is inside the window even when it
  // is far from the start (the knife disarm optimum sat on the old start +- 30 bound)
  const gaps = [{ ax: 40, vx: 0, k: 1 }, { ax: 30, vx: 2, k: 0.7071 }, { ax: 20, vx: -4, k: -0.7071 }];
  const r = [-200, 0, 16, 40, 70, 400].map((s) => fitOffset(gaps, 0.94, s));
  assert.ok(r.every((x) => x === r[0]), JSON.stringify(r));
  // a flat bottom (k = 0 views only) takes the middle of the tied run: one answer
  assert.equal(fitOffset([{ ax: 1, vx: 0, k: 0 }], 0.94, 12.3), fitOffset([{ ax: 1, vx: 0, k: 0 }], 0.94, 12.3));
  // two fresh engines: byte-identical melee_check reports, anim_paired output and clips, for every
  // paired clip of three melee sets and both proportion sets as attacker
  const A = pairedRefits(), B = pairedRefits();
  assert.ok(Object.keys(A.out).length >= 20);
  assert.deepEqual(Object.keys(A.out).filter((k) => A.out[k] !== B.out[k]), []);
  // refitting a refit pair returns it unchanged (offset and IK keys)
  const lib = (...p) => JSON.parse(fs.readFileSync(path.join(A.e.home, 'library', ...p), 'utf8'));
  for (const [sk] of SETS) {
    const skel = lib('skeletons', `${sk}.json`);
    for (const pair of fs.readdirSync(path.join(A.e.home, 'library', 'clips', sk)).filter((f) => f.endsWith('_attacker.json')).map((f) => f.slice(0, -14))) {
      for (const [a, v] of [['heavy', 'light'], ['light', 'heavy']]) {
        const sa = lib('skins', `${sk}_${a}.json`), sv = lib('skins', `${sk}_${v}.json`);
        const RA = getRig(A.e, sa.rig), RV = getRig(A.e, sv.rig);
        const att = retargetClip(lib('clips', sk, `${pair}_attacker.json`), skel.def, RA.def, sa.map).clip, vic = retargetClip(lib('clips', sk, `${pair}_victim.json`), skel.def, RV.def, sv.map).clip;
        const f1 = refitPaired(RA.rig, att, vic, cellsOf(skel), RV.rig), f2 = refitPaired(RA.rig, f1.att, f1.vic, cellsOf(skel), RV.rig);
        assert.deepEqual(f2.offset, f1.offset, `${sk} ${pair} ${a} on ${v}: refit offset ${f1.offset} -> ${f2.offset}`);
        assert.equal(JSON.stringify(f2.att), JSON.stringify(f1.att), `${sk} ${pair} ${a} on ${v}: refit clip changes on a second refit`);
      }
    }
  }
});

// ---------- ground contact ----------
test('ground contact: no foot sinks in any melee or paired clip, every view, both proportion sets (128x192); melee_check keeps the warning', () => {
  const e = new Engine({ home: tmp() });
  const sinking = (c) => (c.issues || []).filter((i) => /sinks/.test(i));
  for (const [sk, mel, skel] of [...SETS.slice(0, 2), ['rf', {}, { weapon: { class: 'rifle' } }]]) {
    e.run('anim_skeleton', { name: sk, template: 'humanoid_hd', frame: [128, 192], proportions: PROPS, ...skel });
    e.run('anim_melee', { skeleton: sk, ...mel });
    for (const p of ['heavy', 'light']) e.run('anim_skin', { name: `${sk}_${p}`, skeleton: sk, proportions: p });
    // the rifle set runs the base skeleton (its solo clips are slow under weapon handling); the knife and shield sets every pairing
    const runs = sk === 'rf' ? [{ skeleton: sk }] : [{ skeleton: sk }, { skin: `${sk}_heavy`, victim_skin: `${sk}_light` }, { skin: `${sk}_light`, victim_skin: `${sk}_heavy` }];
    for (const a of runs) {
      const r = e.run('anim_melee_check', a);
      assert.deepEqual(r.views, ['side', 'front_side', 'front', 'back_side', 'back']);
      for (const [n, c] of Object.entries(r.clips)) {
        assert.deepEqual(sinking(c), [], `${sk} ${JSON.stringify(a)} ${n}`);
        assert.ok(c.foot_sink_px <= 1, `${sk} ${n}: foot_sink_px ${c.foot_sink_px}`);
      }
    }
  }
  // the warning stays: the knockdown keys with ground:false (no ground contact) sink in front / back
  const kd = e.run('anim_info', { skeleton: 'kn', clip: 'knockdown', full: true });
  e.run('anim_clip', { skeleton: 'kn', name: 'kd_raw', keys: kd.keys, frames: kd.frames, fps: kd.fps, loop: false, secondary: true, melee: kd.melee, ground: false });
  const r = e.run('anim_melee_check', { skeleton: 'kn', clips: ['kd_raw', 'knockdown'] }).clips;
  assert.equal(r.knockdown.pass, true);
  assert.ok(r.kd_raw.foot_sink_px > 10, `ungrounded knockdown sinks ${r.kd_raw.foot_sink_px} px`);
  assert.match(sinking(r.kd_raw)[0], /^a foot sinks [\d.]+ px below the ground \(foot_[fb], (front|back)\w* frame \d+\)$/);
  assert.throws(() => e.run('anim_clip', { skeleton: 'kn', name: 'kd_bad', keys: kd.keys, frames: kd.frames, ground: 'yes' }), /ground must be true \| false/);
});
