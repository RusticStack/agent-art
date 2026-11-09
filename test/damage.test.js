// Damage + destruction: art_model damage / fracture, the damage export (state nodes, LODs, masks,
// manifest, Roblox profile), the sprite damage overlay, and byte-identical plain exports.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Engine } from '../src/engine.js';
import { Mesh } from '../src/model3d.js';
import { fracturePart, meshVolume } from '../src/fracture.js';
import { manifoldStats } from '../src/csg.js';
import { decodePNG } from '../src/png.js';
import { corpus } from './fixtures/damage-corpus.js';
import { validateGLB } from '../src/gltfcheck.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'agent-art-damage-'));
const golden = JSON.parse(fs.readFileSync(new URL('./fixtures/damage-golden-0.8.json', import.meta.url), 'utf8'));

function parseGLB(buf) {
  assert.equal(buf.readUInt32LE(0), 0x46546c67, 'magic glTF');
  assert.equal(buf.readUInt32LE(8), buf.length, 'total length');
  const jlen = buf.readUInt32LE(12);
  const json = JSON.parse(buf.toString('utf8', 20, 20 + jlen));
  const bo = 20 + jlen, blen = buf.readUInt32LE(bo);
  assert.equal(bo + 8 + blen, buf.length);
  const bin = buf.subarray(bo + 8, bo + 8 + blen);
  const read = (ai) => {
    const A = json.accessors[ai], V = json.bufferViews[A.bufferView];
    const n = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[A.type] * A.count;
    const off = bin.byteOffset + V.byteOffset + (A.byteOffset || 0);
    const ab = bin.buffer.slice(off, off + n * (A.componentType === 5126 || A.componentType === 5125 ? 4 : 2));
    return A.componentType === 5126 ? new Float32Array(ab) : A.componentType === 5125 ? new Uint32Array(ab) : new Uint16Array(ab);
  };
  for (const A of json.accessors) {
    if (A.min && A.componentType === 5126) assert.ok(A.min.every(Number.isFinite) && A.max.every(Number.isFinite), 'finite accessor bounds');
  }
  return { json, read, node: (name) => json.nodes.find((n) => n.name === name) };
}

/** Small kit: textures + a crate and a hull panel with damage states. */
function kit(home = tmp()) {
  const e = new Engine({ home });
  e.run('create', { name: 'hull', width: 16 });
  e.run('draw', { canvas: 'hull', commands: [{ op: 'noise', colors: ['#5b626d', '#626974', '#686f7a'], scale: 3, seed: 3 }, { op: 'rect', x: 0, y: 0, w: 16, h: 16, color: '#2a2e35', fill: false }] });
  e.run('create', { name: 'plank', width: 16 });
  e.run('draw', { canvas: 'plank', commands: [{ op: 'noise', colors: ['#7a5630', '#835d34', '#8c6538'], scale: 3, seed: 2 }] });
  e.run('model_create', { name: 'crate', origin: 'bottom', parts: [
    { type: 'box', id: 'body', w: 24, h: 24, d: 24, texture: 'plank' },
    { type: 'box', id: 'lid', w: 26, h: 2, d: 26, at: [0, 24, 0], texture: 'hull' },
    { type: 'box', id: 'slat', w: 18, h: 18, d: 1.5, at: [0, 3, 12.75], texture: 'hull' },
  ] });
  e.run('model_create', { name: 'hull_panel', origin: 'bottom', parts: [
    { type: 'box', id: 'plate', w: 64, h: 32, d: 6, texture: 'hull' },
    { type: 'box', id: 'hatch', w: 16, h: 12, d: 1.5, at: [-16, 10, 3.75], texture: 'hull' },
    { type: 'cylinder', id: 'pipe', r: 1, h: 56, rotate: [0, 0, 90], at: [0, 26, 4.5], color: '#b08a4a' },
  ] });
  e.run('model_damage', { name: 'crate', kind: 'crate', seed: 7, states: ['scuffed', 'damaged', 'wrecked'] });
  e.run('model_damage', { name: 'hull_panel', kind: 'hull', seed: 11, states: ['scuffed', { name: 'damaged', amount: 0.6 }, 'wrecked'] });
  return e;
}

test('damage: states nest, carry features + fx sockets, and are deterministic by seed', () => {
  const e = kit();
  const r = e.run('model_damage', { name: 'hull_panel', size: 96 });
  assert.deepEqual(r.states.map((s) => s.name), ['intact', 'scuffed', 'damaged', 'wrecked']);
  const w = r.states.find((s) => s.name === 'wrecked');
  assert.ok(w.triangles > r.states[0].triangles, 'wrecked has more geometry (dents, rims, wires)');
  assert.ok(w.features.breaches >= 1, `hull breach at wrecked: ${JSON.stringify(w.features)}`);
  assert.ok(w.sockets.length >= 1 && w.sockets.every((s) => /^fx_(spark|smoke|fire|steam|leak|flicker)_\d+$/.test(s)), `fx sockets at wrecked: ${w.sockets}`);
  const same = kit().run('model_damage', { name: 'hull_panel', size: 96 });
  assert.deepEqual(same.states, r.states);
  assert.ok(Buffer.compare(same.image, r.image) === 0, 'contact sheet byte-identical');
  // another seed lands features elsewhere
  const e3 = kit();
  const other = e3.run('model_damage', { name: 'hull_panel', seed: 99, size: 96 });
  assert.notDeepEqual(other.states, r.states);
  // bad input is rejected with a hint
  assert.throws(() => e.run('model_damage', { name: 'crate', states: [{ name: 'x', amount: 2 }] }), /amount/);
  assert.throws(() => e.run('model_damage', { name: 'crate', kind: 'spaceship' }), /kind/);
});

test('damage export: byte-identical by seed (glb, masks, manifest)', () => {
  const files = (home) => {
    const e = kit(home), dir = tmp();
    e.run('model_export', { name: 'hull_panel', path: path.join(dir, 'hull_panel.glb'), lods: [1, 0.5], damage: { mask_channels: true, vertex: true } });
    e.run('model_fracture', { name: 'crate', groups: [{ part: 'body', pieces: 6, seed: 3, debris: 1 }] });
    e.run('model_export', { name: 'crate', path: path.join(dir, 'crate.glb'), damage: { mode: 'files' } });
    return Object.fromEntries(fs.readdirSync(dir).sort().map((f) => [f, fs.readFileSync(path.join(dir, f))]));
  };
  const A = files(tmp()), B = files(tmp());
  assert.deepEqual(Object.keys(A), Object.keys(B));
  for (const f of ['hull_panel.damage.glb', 'hull_panel.damage.json', 'hull_panel.damage_mask.png', 'hull_panel.damage_mask_r.png', 'crate_wrecked.glb', 'crate_fracture.glb', 'crate.damage.json']) assert.ok(A[f], `${f} written (${Object.keys(A).join(', ')})`);
  for (const f of Object.keys(A)) assert.ok(Buffer.compare(A[f], B[f]) === 0, `${f} identical`);
});

test('damage export: one glb with state nodes; every state keeps its LOD chain; sockets as nodes', () => {
  const e = kit(), dir = tmp();
  const r = e.run('model_export', { name: 'hull_panel', path: path.join(dir, 'hull_panel.glb'), lods: [1, 0.5, 0.25] });
  assert.ok(r.damage && r.damage.states.length === 4, JSON.stringify(r.damage));
  const g = parseGLB(fs.readFileSync(path.join(dir, 'hull_panel.damage.glb')));
  const man = JSON.parse(fs.readFileSync(path.join(dir, 'hull_panel.damage.json'), 'utf8'));
  assert.equal(man.model, 'hull_panel');
  assert.deepEqual(man.states.map((s) => s.name), ['intact', 'scuffed', 'damaged', 'wrecked']);
  const root = g.node('hull_panel_damage');
  assert.ok(root, 'damage root node');
  for (const s of man.states) {
    const n = g.node(s.node);
    assert.ok(n && root.children.includes(g.json.nodes.indexOf(n)), `${s.node} under the root`);
    assert.equal(s.lods.length, 3, `${s.name}: LOD0..2`);
    for (const L of s.lods) {
      const ln = g.node(L.node);
      assert.ok(ln && ln.mesh !== undefined && n.children.includes(g.json.nodes.indexOf(ln)), `${L.node}`);
    }
    for (let i = 1; i < s.lods.length; i++) assert.ok(s.lods[i].triangles <= s.lods[i - 1].triangles, `${s.name} LOD${i} not heavier`);
    for (const so of s.sockets) {
      const sn = g.node(so.node);
      assert.ok(sn && ['spark', 'smoke', 'fire', 'steam', 'leak', 'flicker'].includes(sn.extras.fx), `socket ${so.node}`);
    }
  }
  assert.ok(man.states.at(-1).sockets.length > 0, 'wrecked has fx sockets');
  // the plain export is still written next to it
  assert.ok(fs.existsSync(path.join(dir, 'hull_panel.glb')));
});

test('damage masks: values in range, uv1 inside [0,1], every damaged texel covered by its UV chart', () => {
  const e = kit(), dir = tmp();
  e.run('model_export', { name: 'hull_panel', path: path.join(dir, 'hull_panel.glb'), damage: { vertex: true } });
  const man = JSON.parse(fs.readFileSync(path.join(dir, 'hull_panel.damage.json'), 'utf8'));
  assert.ok(man.blend && man.blend.morph === 'damage');
  const mask = decodePNG(fs.readFileSync(path.join(dir, man.blend.mask)));
  assert.deepEqual([mask.width, mask.height], man.blend.mask_size);
  const g = parseGLB(fs.readFileSync(path.join(dir, 'hull_panel.damage.glb')));
  const n = g.node(man.blend.node);
  const mesh = g.json.meshes[n.mesh];
  assert.ok(mesh.extras?.targetNames?.includes('damage') || mesh.primitives.some((p) => p.targets?.length), 'dent morph target');
  const W = mask.width, H = mask.height, cover = new Uint8Array(W * H);
  let prims = 0;
  for (const p of mesh.primitives) {
    if (p.attributes.TEXCOORD_1 === undefined) continue;
    prims++;
    const uv = g.read(p.attributes.TEXCOORD_1), idx = g.read(p.indices);
    for (let i = 0; i < uv.length; i++) assert.ok(uv[i] >= 0 && uv[i] <= 1, `uv1 in [0,1] (${uv[i]})`);
    if (p.attributes._DAMAGE !== undefined) for (const v of g.read(p.attributes._DAMAGE)) assert.ok(v >= 0 && v <= 1, 'vertex damage 0..1');
    // rasterise each uv1 triangle (+1 texel dilation) to the mask grid
    for (let t = 0; t < idx.length; t += 3) {
      const P = [0, 1, 2].map((k) => [uv[idx[t + k] * 2] * W, uv[idx[t + k] * 2 + 1] * H]);
      const x0 = Math.max(0, Math.floor(Math.min(...P.map((q) => q[0])) - 1)), x1 = Math.min(W - 1, Math.ceil(Math.max(...P.map((q) => q[0])) + 1));
      const y0 = Math.max(0, Math.floor(Math.min(...P.map((q) => q[1])) - 1)), y1 = Math.min(H - 1, Math.ceil(Math.max(...P.map((q) => q[1])) + 1));
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) cover[y * W + x] = 1;
    }
  }
  assert.ok(prims > 0, 'intact mesh carries TEXCOORD_1');
  let damaged = 0, stray = 0;
  for (let i = 0; i < W * H; i++) {
    const d = mask.data.subarray(i * 4, i * 4 + 4);
    if (d[0] || d[1] || d[2] || d[3] < 255 && d[3] > 0) { damaged++; if (!cover[i]) stray++; }
  }
  assert.ok(damaged > 0, 'mask carries damage');
  assert.equal(stray, 0, `${stray} damaged texels outside every uv1 chart`);
  for (const k of ['r', 'g', 'b', 'a']) assert.ok(man.blend.coverage[k] >= 0 && man.blend.coverage[k] <= 1, `coverage ${k}`);
});

test('fracture: watertight manifold chunks whose volumes sum to the part; deterministic; hulls + debris', () => {
  const tex = (k) => ({ key: k, name: k, width: 1, height: 1, data: Uint8ClampedArray.from([200, 100, 50, 255]) });
  const box = (w, h, d) => {
    const m = new Mesh(), T = tex('a');
    const F = [[[1, 0, 0], [[w, 0, 0], [w, h, 0], [w, h, d], [w, 0, d]]], [[-1, 0, 0], [[0, 0, 0], [0, 0, d], [0, h, d], [0, h, 0]]], [[0, 1, 0], [[0, h, 0], [0, h, d], [w, h, d], [w, h, 0]]], [[0, -1, 0], [[0, 0, 0], [w, 0, 0], [w, 0, d], [0, 0, d]]], [[0, 0, 1], [[0, 0, d], [w, 0, d], [w, h, d], [0, h, d]]], [[0, 0, -1], [[0, 0, 0], [0, h, 0], [w, h, 0], [w, 0, 0]]]];
    for (const [n, P] of F) m.face(T, P, n, P.map(() => [0, 0]), n, 0);
    return m;
  };
  for (const method of ['voronoi', 'slice']) {
    const m = box(20, 14, 12), whole = meshVolume(m).volume;
    const r = fracturePart(m, { pieces: 9, seed: 4, method, inside: tex('in'), debris: 2, name: 'b' });
    const L1 = r.chunks.filter((c) => c.level === 1), L2 = r.chunks.filter((c) => c.level === 2);
    assert.ok(L1.length >= 6 && L1.length <= 9, `${method}: ${L1.length} chunks`);
    assert.equal(L2.length, 6, 'debris: 2 chunks x 3');
    for (const c of r.chunks) {
      const ms = manifoldStats(c.mesh);
      assert.ok(c.watertight && ms.open === 0 && ms.nonManifold === 0 && ms.flipped === 0, `${c.name} watertight + manifold ${JSON.stringify(ms)}`);
      assert.ok(c.volume_px3 > 0 && c.hullVerts >= 4 && c.hull, `${c.name} volume + hull`);
      for (let k = 0; k < 3; k++) assert.ok(c.center[k] >= c.min[k] - 1e-6 && c.center[k] <= c.max[k] + 1e-6, 'centre inside bounds');
      assert.ok([...c.mesh.groups.values()].some((g) => g.tex.key === 'in'), `${c.name} has inside faces`);
    }
    const sum = L1.reduce((s, c) => s + c.volume_px3, 0);
    assert.ok(Math.abs(sum - whole) / whole < 1e-6, `${method}: level-1 volumes ${sum} vs ${whole}`);
    for (const p of L1.filter((c) => L2.some((d) => d.parent === c.name))) {
      const kids = L2.filter((d) => d.parent === p.name).reduce((s, d) => s + d.volume_px3, 0);
      assert.ok(Math.abs(kids - p.volume_px3) / p.volume_px3 < 1e-6, 'debris volumes sum to the parent chunk');
    }
    const again = fracturePart(box(20, 14, 12), { pieces: 9, seed: 4, method, inside: tex('in'), debris: 2, name: 'b' });
    assert.deepEqual(again.chunks.map((c) => [c.name, c.volume_px3, c.center]), r.chunks.map((c) => [c.name, c.volume_px3, c.center]));
  }
  // through the model ops: break groups with a parent, mass from density
  const e = kit();
  const r = e.run('model_fracture', { name: 'crate', groups: [{ part: 'body', pieces: 8, seed: 2, debris: 1, density: 500 }, { part: 'slat', pieces: 3, method: 'slice', parent: 'body' }] });
  assert.equal(r.groups.length, 2);
  for (const g of r.groups) assert.ok(g.watertight && g.chunk_volume_error < 1e-6, JSON.stringify(g));
  assert.equal(r.groups[1].parent, 'body');
  // debris chunks are cut from the original part (never a boolean of a boolean): watertight for every seed
  for (let seed = 1; seed <= 5; seed++) {
    const d = e.run('model_fracture', { name: 'crate', groups: [{ part: 'body', pieces: 10, seed, debris: 2 }] }).groups[0];
    assert.ok(d.watertight && d.debris === 6 && d.chunk_volume_error < 1e-6, `seed ${seed}: ${JSON.stringify(d)}`);
  }
  assert.ok(r.groups[0].mass_kg > 0);
  assert.throws(() => e.run('model_fracture', { name: 'crate', groups: [{ part: 'nope' }] }), /part/);
});

test('materials v2 + damage: the damage glb keeps the v2 extensions / tangents, validates, and the plain export is unchanged', () => {
  const e = kit();
  e.run('model_create', { name: 'v2crate', origin: 'bottom', parts: [
    { type: 'box', id: 'body', w: 24, h: 24, d: 24, texture: 'hull', material: 'painted_hull', bump: { auto: 'panels' } },
    { type: 'box', id: 'pane', w: 16, h: 10, d: 1, at: [0, 6, 12.5], color: '#9fd8ff', material: 'glass_canopy' },
  ] });
  const dir = tmp(), dir2 = tmp();
  const plain = e.run('model_export', { name: 'v2crate', path: path.join(dir, 'v2crate.glb'), profile: 'three' });
  e.run('model_damage', { name: 'v2crate', kind: 'crate', seed: 3 });
  const r = e.run('model_export', { name: 'v2crate', path: path.join(dir2, 'v2crate.glb'), profile: 'three', damage: { vertex: true } });
  assert.ok(Buffer.compare(fs.readFileSync(plain.file), fs.readFileSync(r.file)) === 0, 'plain v2 glb unchanged by the damage export');
  assert.ok(r.materials_v2 && r.damage, 'both reports');
  const buf = fs.readFileSync(path.join(dir2, 'v2crate.damage.glb'));
  const v = validateGLB(buf);
  assert.ok(v.ok, JSON.stringify(v.errors?.slice(0, 5)));
  const g = parseGLB(buf);
  const used = g.json.extensionsUsed || [];
  for (const x of parseGLB(fs.readFileSync(r.file)).json.extensionsUsed || []) assert.ok(used.includes(x), `damage glb uses ${x} too (${used})`);
  const prims = g.json.meshes.flatMap((m) => m.primitives);
  const plainTangents = parseGLB(fs.readFileSync(r.file)).json.meshes.flatMap((m) => m.primitives).some((p) => p.attributes.TANGENT !== undefined);
  assert.ok(plainTangents, 'fixture: the plain v2 export has tangents');
  assert.ok(prims.some((p) => p.attributes.TANGENT !== undefined && p.attributes._DAMAGE !== undefined), 'tangents + damage channel on one primitive');
  const withDmg = prims.filter((p) => p.attributes._DAMAGE !== undefined);
  assert.ok(withDmg.length > 0, 'vertex damage channel');
  for (const p of withDmg) assert.equal(g.json.accessors[p.attributes._DAMAGE].count, g.json.accessors[p.attributes.POSITION].count, 'damage channel follows tangent vertex splits');
  const man = JSON.parse(fs.readFileSync(path.join(dir2, 'v2crate.damage.json'), 'utf8'));
  assert.ok(man.materials_v2?.valid && man.profile === 'web', JSON.stringify(man.materials_v2));
  // profile:"roblox" on the export implies the Roblox damage profile
  const rb = e.run('model_export', { name: 'v2crate', path: path.join(tmp(), 'v2crate.glb'), profile: 'roblox', damage: true });
  assert.equal(rb.damage.profile, 'roblox');
});

test('fracture through the robust boolean path (#19 meshbool): watertight, volumes sum', () => {
  const e = kit();
  const r = e.run('model_fracture', { name: 'crate', groups: [{ part: 'body', pieces: 8, seed: 4, debris: 1, boolean: 'robust' }] });
  const g = r.groups[0];
  assert.ok(g.watertight && g.chunk_volume_error < 1e-6 && g.boolean === 'robust', JSON.stringify(g));
  assert.throws(() => e.run('model_fracture', { name: 'crate', groups: [{ part: 'body', boolean: 'magic' }] }), /boolean/);
});

test('roblox profile: per-state MeshParts <= 20k triangles, no masks / morphs / second UV set', () => {
  const e = kit(), dir = tmp();
  e.run('model_fracture', { name: 'crate', groups: [{ part: 'body', pieces: 5, seed: 1 }] });
  const r = e.run('model_export', { name: 'crate', path: path.join(dir, 'crate.glb'), damage: { profile: 'roblox' } });
  const f = r.damage.glbs.map((x) => (typeof x === 'string' ? x : x.file)).find((x) => /roblox/.test(x));
  assert.ok(f, JSON.stringify(r.damage.glbs));
  const g = parseGLB(fs.readFileSync(path.isAbsolute(f) ? f : path.join(dir, f)));
  for (const m of g.json.meshes) {
    let tris = 0;
    for (const p of m.primitives) {
      assert.equal(p.targets, undefined, 'no morph targets');
      assert.equal(p.attributes.TEXCOORD_1, undefined, 'no second UV set');
      assert.equal(p.attributes._DAMAGE, undefined, 'no damage attribute');
      tris += g.json.accessors[p.indices].count / 3;
    }
    assert.ok(tris <= 20000, `${m.name}: ${tris} triangles`);
  }
  const man = JSON.parse(fs.readFileSync(path.join(dir, 'crate.damage.json'), 'utf8'));
  assert.equal(man.profile, 'roblox');
  assert.ok(man.roblox?.tri_limit === 20000 && man.fracture?.groups.length === 1);
});

test('sprite damage overlay: palette-only, same relative spot per view by seed', () => {
  const e = new Engine({ home: tmp() });
  const plate = ['#2e3640', '#3c4652', '#5a6878', '#7a8898', '#a4b0bc'];
  e.run('create', { name: 'a', width: 24, height: 24 });
  e.run('draw', { canvas: 'a', commands: [{ op: 'rect', x: 4, y: 4, w: 16, h: 16, color: plate[2] }, { op: 'shade', colors: plate, of: plate[2] }, { op: 'outline', color: '#161a20' }] });
  const colours = (d) => { const s = new Set(); for (let i = 0; i < d.length; i += 4) if (d[i + 3]) s.add((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]); return s; };
  const pal = colours(e.get('a').composite());
  for (const amount of [0.25, 0.6, 1]) {
    e.run('duplicate', { canvas: 'a', new_name: `a${amount}` });
    const msg = e.run('draw', { canvas: `a${amount}`, commands: [{ op: 'damage', amount, seed: 5, on: plate }] });
    const d = e.get(`a${amount}`).composite();
    for (const c of colours(d)) assert.ok(pal.has(c), `amount ${amount}: off-palette #${c.toString(16)} (${JSON.stringify(msg)})`);
    assert.ok(Buffer.compare(Buffer.from(d), Buffer.from(e.get('a').composite())) !== 0, `amount ${amount} changes pixels`);
  }
  // explicit palette restricts output to it
  e.run('duplicate', { canvas: 'a', new_name: 'ap' });
  e.run('draw', { canvas: 'ap', commands: [{ op: 'damage', amount: 1, seed: 5, palette: plate, on: plate }] });
  for (const c of colours(e.get('ap').composite())) assert.ok(pal.has(c));
  // same seed on a shifted copy -> the same pattern, shifted (per-view consistency)
  e.run('create', { name: 'b', width: 24, height: 24 });
  e.run('draw', { canvas: 'b', commands: [{ op: 'rect', x: 6, y: 6, w: 16, h: 16, color: plate[2] }, { op: 'shade', colors: plate, of: plate[2] }, { op: 'outline', color: '#161a20' }] });
  const before = e.get('b').composite();
  const a0 = e.get('a').composite();
  // the undamaged sprites match under the shift; so must the damaged ones
  const shifted = (A, B) => { for (let y = 0; y < 22; y++) for (let x = 0; x < 22; x++) { const i = (y * 24 + x) * 4, j = ((y + 2) * 24 + x + 2) * 4; for (let k = 0; k < 4; k++) if (A[i + k] !== B[j + k]) return false; } return true; };
  assert.ok(shifted(a0, before), 'fixture: shifted copies');
  e.run('draw', { canvas: 'b', commands: [{ op: 'damage', amount: 0.6, seed: 5, on: plate }] });
  assert.ok(shifted(e.get('a0.6').composite(), e.get('b').composite()), 'same seed -> same relative placement');
  assert.throws(() => e.run('draw', { canvas: 'a', commands: [{ op: 'damage', kinds: ['lasers'] }] }), /kinds/);
});

test('feature unused: plain exports are byte-identical to main (0.8.0 golden digests, incl. materials v2)', () => {
  const e = new Engine({ home: tmp() });
  assert.deepEqual(corpus(e, decodePNG), golden);
});

test('damage: preview a state, delete removes the states, no damage files without damage', () => {
  const e = kit();
  const p = e.run('model_preview', { name: 'crate', damage: 'wrecked', size: 64 });
  assert.ok(p.image?.length > 100);
  assert.throws(() => e.run('model_preview', { name: 'crate', damage: 'melted' }), /no state/);
  const d = e.run('model_damage', { name: 'crate', delete: true });
  assert.equal(d.damage, null);
  assert.throws(() => e.run('model_preview', { name: 'crate', damage: 'wrecked' }), /no damage states/);
  // with no damage / fracture, export writes no damage files
  const dir = tmp();
  const r = e.run('model_export', { name: 'crate', path: path.join(dir, 'crate.glb') });
  assert.equal(r.damage, undefined);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['crate.glb', 'crate.meta.json']);
});

// ---------- regressions (PR #22 review) ----------
test('damage render / preview on a model with part-attached sockets keeps the rig (named nodes + socket anchors)', () => {
  const e = new Engine({ home: tmp() });
  e.run('create', { name: 'out', width: 32 });
  e.run('model_create', { name: 'gun', parts: [{ type: 'box', name: 'a', w: 8, h: 8, d: 8, color: '#777' }, { type: 'box', name: 'b', parent: 'a', w: 4, h: 4, d: 4, at: [0, 8, 0], color: '#999' }], sockets: { muzzle: { part: 'b', at: [0, 10, 0] } } });
  e.run('model_damage', { name: 'gun', states: ['scuffed', 'wrecked'], seed: 3 });
  for (const st of ['scuffed', 'wrecked']) {
    const r = e.run('model_render', { name: 'gun', damage: st, canvas: 'out', size: 32 });
    assert.ok(JSON.stringify(r.anchors).includes('socket_muzzle'), JSON.stringify(r.anchors));
  }
  e.run('model_create', { name: 'fighter', template: 'fighter' });
  e.run('model_damage', { name: 'fighter', states: ['scuffed'] });
  assert.ok(e.run('model_render', { name: 'fighter', damage: 'scuffed', canvas: 'out', size: 32 }).count >= 1);
  assert.ok(e.run('model_preview', { name: 'fighter', damage: 'scuffed', size: 64 }).image.length > 100);
});

test('roblox damage profile: the intact MeshPart is capped at 20k triangles and has no LOD nodes', () => {
  const e = new Engine({ home: tmp() }), dir = tmp();
  e.run('model_create', { name: 'drum', parts: [{ type: 'cylinder', r: 16, h: 16, segments: 6000, color: '#888' }] });
  e.run('model_damage', { name: 'drum', states: ['scuffed'] });
  const r = e.run('model_export', { name: 'drum', path: path.join(dir, 'drum.glb'), damage: { profile: 'roblox', lods: [1, 0.5] } });
  const intact = r.damage.states.find((s) => s.name === 'intact');
  assert.ok(intact.triangles <= 20000 && !intact.lods, JSON.stringify(intact));
  const g = parseGLB(fs.readFileSync(path.join(dir, 'drum.damage.roblox.glb')));
  assert.ok(!g.json.nodes.some((n) => /_LOD\d$/.test(n.name)), 'no LOD nodes');
  const man = JSON.parse(fs.readFileSync(path.join(dir, 'drum.damage.json'), 'utf8'));
  assert.equal(man.states[0].simplified_for_roblox, true);
});

test('damage export validates texel / max_size / lods / lod_screen / mode before writing anything', () => {
  const e = kit(), dir = tmp(), file = path.join(dir, 'crate.glb');
  e.run('model_export', { name: 'crate', path: file });
  const snap = () => Object.fromEntries(fs.readdirSync(dir).map((f) => [f, fs.readFileSync(path.join(dir, f)).toString('base64')]));
  const before = snap();
  const bad = [
    [{ damage: { texel: 0 } }, /texel/], [{ damage: { texel: -1 } }, /texel/], [{ damage: { texel: 0.01 } }, /texel/], [{ damage: { texel: 'x' } }, /texel/],
    [{ damage: { max_size: 16384 } }, /max_size/], [{ damage: { max_size: 100.5 } }, /max_size/], [{ damage: { max_size: 8 } }, /max_size/],
    [{ damage: { lods: [1, 0.5, 0.8] } }, /decrease/], [{ damage: { lods: [1, 0.5] }, lod_screen: { height: 'x' } }, /lod_screen/],
    [{ damage: { mode: 'nope' } }, /damage.mode/], [{ damage: { profile: 'unreal' } }, /damage.profile/],
    [{ damage: { texel: 0 }, profile: 'three' }, /texel/],
  ];
  for (const [args, re] of bad) assert.throws(() => e.run('model_export', { name: 'crate', path: file, ...args }), re, JSON.stringify(args));
  assert.deepEqual(snap(), before, 'a rejected damage export writes nothing');
  const ok = e.run('model_export', { name: 'crate', path: file, damage: { texel: 2, max_size: 256 } });
  assert.ok(ok.damage.mask.split('x').every((v) => Number(v) <= 256), ok.damage.mask);
});

test('fracture: total work budget with a clear error; unchanged groups come from the cache', () => {
  const e = new Engine({ home: tmp() }), dir = tmp();
  e.run('model_create', { name: 'drum', parts: [{ type: 'cylinder', id: 'c', r: 16, h: 16, segments: 1000, color: '#888' }, { type: 'box', id: 'b', w: 8, h: 8, d: 8, at: [40, 0, 0], color: '#777' }] });
  assert.throws(() => e.run('model_fracture', { name: 'drum', groups: [{ part: 'c', pieces: 64 }] }), /budget of 250000/);
  assert.throws(() => e.run('model_fracture', { name: 'drum', groups: [{ part: 'b', pieces: 4 }, { part: 'c', pieces: 40, debris: 16 }] }), /budget/);
  const a1 = e.run('model_fracture', { name: 'drum', groups: [{ part: 'b', pieces: 12, seed: 2, debris: 2 }] });
  const a2 = e.run('model_fracture', { name: 'drum', groups: [{ part: 'b', pieces: 12, seed: 2, debris: 2 }] });
  assert.deepEqual(a2.groups, a1.groups);
  assert.ok(a2.ms <= Math.max(5, a1.ms / 2), `cached fracture ${a2.ms} ms vs ${a1.ms} ms`);
  const r = e.run('model_export', { name: 'drum', path: path.join(dir, 'drum.glb') });
  assert.equal(r.damage.fracture[0].chunks, a1.groups[0].chunks + a1.groups[0].debris);
  const a3 = e.run('model_fracture', { name: 'drum', groups: [{ part: 'b', pieces: 7, seed: 2 }] });
  assert.equal(a3.groups[0].chunks, 7, 'changed options re-run');
});

test('damage states, LODs and fracture on skinned models export skinned', () => {
  const e = new Engine({ home: tmp() });
  e.run('model_create', { name: 'snake', parts: [{ type: 'tube', path: [[0, 32, 0], [0, 20, 0], [0, 8, 0], [0, 2, 0]], r: 2, sides: 6, texture: '#c84', segments: 3 }] });
  e.run('model_skeleton', { name: 'snake', skeleton: { template: 'chain', count: 3, from: [0, 32, 0], to: [0, 2, 0] } });
  e.run('model_skin', { name: 'snake', skin: { method: 'heat' } });
  // damage states keep the skin (every state is skinned on the one armature; see test/limits.test.js)
  assert.ok(e.run('model_damage', { name: 'snake', states: ['scuffed'] }).states.length === 2);
  // skinned fracture (rigid chunks on bones) and damage LODs: see test/limits.test.js
  assert.ok(e.run('model_fracture', { name: 'snake', groups: [{ part: 0, pieces: 3 }] }).groups.length === 1);
  assert.ok(e.run('model_export', { name: 'snake', path: path.join(tmp(), 'snake.glb'), damage: { lods: [1, 0.5] } }).damage.states[0].lods.length === 2);
  e.run('model_fracture', { name: 'snake', delete: true });
  assert.ok(e.run('model_export', { name: 'snake', path: path.join(tmp(), 'snake.glb'), damage: true }).damage, 'skinned damage export');
  assert.ok(e.run('model_export', { name: 'snake', path: path.join(tmp(), 'snake.glb') }).file, 'plain skinned export still works');
});

test('rigged damage: the dent morph of every non-root rig piece is a delta in its own frame (not shifted by the joint)', async () => {
  const { validateGLB: validateSkin, parseGLB: parse, readAccessor } = await import('../src/gltfvalidate.js');
  const e = new Engine({ home: tmp() }), dir = tmp();
  e.run('model_create', { name: 'locker', origin: 'bottom', parts: [
    { type: 'box', name: 'body', w: 24, h: 40, d: 16, color: '#667' },
    { type: 'box', name: 'door', parent: 'body', w: 22, h: 38, d: 2, at: [0, 1, 9], pivot: [-11, 0, 0], color: '#889' },
  ] });
  e.run('model_damage', { name: 'locker', kind: 'door', states: ['wrecked'], seed: 4 });
  e.run('model_export', { name: 'locker', path: path.join(dir, 'locker.glb'), bake_ao: true, lightmap: true, damage: { lods: [1, 0.5] } });
  const glb = fs.readFileSync(path.join(dir, 'locker.damage.glb'));
  const v = validateSkin(glb), c = validateGLB(glb);
  assert.ok(v.ok && c.ok, [...(v.errors || []), ...(c.errors || [])].slice(0, 3).join('; '));
  const { json, bin } = parse(glb);
  let checked = 0;
  for (const n of json.nodes.filter((x) => x.mesh !== undefined && /_(door|body)$/.test(x.name))) for (const p of json.meshes[n.mesh].primitives) if (p.targets) {
    const d = readAccessor(json, bin, p.targets[0].POSITION);
    let still = 0;
    for (let i = 0; i < d.length; i += 3) if (Math.hypot(d[i], d[i + 1], d[i + 2]) < 1e-5) still++;
    // the dent moves part of the surface; the rest of the piece stays put (a joint offset moved every vertex)
    assert.ok(still > d.length / 3 / 5, `${n.name}: ${still} of ${d.length / 3} vertices unmoved by the dent`);
    checked++;
  }
  assert.ok(checked >= 4, `${checked} rig pieces with the dent morph`);
});
