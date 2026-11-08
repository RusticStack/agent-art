// art_model hard-surface detail + render cost (0.7): PBR materials, height -> normal maps, baked
// AO, greebles, sweeps, trim sheets, booleans / merge, morph targets, LODs, impostors, proxies,
// cull data, GPU-instanced greebles, shadow flags. Every glb goes through a validator.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Engine } from '../src/engine.js';
import { decodePNG } from '../src/png.js';
import { buildModel } from '../src/model3d.js';
import { texResolver } from '../src/modelops.js';
import { heightToNormal, normPBR, MATERIAL_PRESETS } from '../src/surface.js';
import { greebleLayout } from '../src/greeble.js';
import { manifoldStats } from '../src/csg.js';
import { simplifyMesh } from '../src/lod.js';
import { octDecode, octEncode } from '../src/impostor.js';
import { faceBasis } from '../src/ctm.js';
import { helpText } from '../src/docs.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'agent-art-surf-'));
const near = (a, b, e = 1e-4) => Math.abs(a - b) <= e;

/** Parse + validate a .glb: chunks, bufferViews, accessors (in range, min/max), primitives, morph targets, instancing, textures. */
function loadGLB(file) {
  const buf = fs.readFileSync(file);
  assert.equal(buf.readUInt32LE(0), 0x46546c67, 'glTF magic');
  assert.equal(buf.readUInt32LE(8), buf.length, 'total length');
  const jlen = buf.readUInt32LE(12);
  const json = JSON.parse(buf.toString('utf8', 20, 20 + jlen));
  const bo = 20 + jlen, blen = buf.readUInt32LE(bo);
  assert.equal(bo + 8 + blen, buf.length);
  const bin = buf.subarray(bo + 8, bo + 8 + blen);
  for (const v of json.bufferViews) assert.ok(v.byteOffset % 4 === 0 && v.byteOffset + v.byteLength <= blen, 'bufferView inside BIN');
  const SIZE = { 5126: 4, 5123: 2, 5125: 4 }, COMP = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
  const read = (ai) => {
    const a = json.accessors[ai];
    assert.ok(a, `accessor ${ai}`);
    const v = json.bufferViews[a.bufferView], bytes = a.count * COMP[a.type] * SIZE[a.componentType];
    assert.ok(bytes <= v.byteLength, 'accessor fits its bufferView');
    const off = bin.byteOffset + v.byteOffset;
    const T = a.componentType === 5126 ? Float32Array : a.componentType === 5123 ? Uint16Array : Uint32Array;
    const out = Array.from(new T(bin.buffer.slice(off, off + bytes)));
    assert.ok(out.every(Number.isFinite), 'finite values');
    if (a.min) for (let i = 0; i < out.length; i++) { const k = i % COMP[a.type]; assert.ok(out[i] >= a.min[k] - 1e-6 && out[i] <= a.max[k] + 1e-6, 'accessor min/max'); }
    return out;
  };
  const image = (ti) => {
    const im = json.images[json.textures[ti].source], v = json.bufferViews[im.bufferView];
    return decodePNG(Buffer.from(bin.subarray(v.byteOffset, v.byteOffset + v.byteLength)));
  };
  for (const m of json.meshes) {
    for (const p of m.primitives) {
      const n = json.accessors[p.attributes.POSITION].count;
      for (const [k, ai] of Object.entries(p.attributes)) assert.equal(json.accessors[ai].count, n, `${k} count`);
      for (const i of read(p.indices)) assert.ok(i < n, 'index in range');
      const mat = json.materials[p.material];
      assert.ok(mat, 'material');
      for (const t of [mat.pbrMetallicRoughness.baseColorTexture, mat.pbrMetallicRoughness.metallicRoughnessTexture, mat.normalTexture, mat.emissiveTexture, mat.occlusionTexture]) if (t) assert.ok(json.textures[t.index], 'texture index');
      if (mat.occlusionTexture) assert.ok(p.attributes[`TEXCOORD_${mat.occlusionTexture.texCoord}`] !== undefined, 'occlusion texCoord attribute');
      const f = mat.pbrMetallicRoughness;
      assert.ok(f.metallicFactor >= 0 && f.metallicFactor <= 1 && f.roughnessFactor >= 0 && f.roughnessFactor <= 1, 'pbr factors 0..1');
      if (p.targets) {
        assert.equal(p.targets.length, m.weights.length, 'one weight per target');
        assert.equal(m.extras.targetNames.length, p.targets.length, 'target names');
        for (const t of p.targets) { assert.equal(json.accessors[t.POSITION].count, n); assert.equal(json.accessors[t.NORMAL].count, n); assert.ok(json.accessors[t.POSITION].min, 'target POSITION min/max'); }
      }
    }
  }
  json.nodes.forEach((n) => {
    if (n.mesh !== undefined) assert.ok(json.meshes[n.mesh]);
    const ins = n.extensions?.EXT_mesh_gpu_instancing;
    if (ins) {
      assert.ok(json.extensionsUsed.includes('EXT_mesh_gpu_instancing'));
      const c = json.accessors[ins.attributes.TRANSLATION].count;
      assert.equal(json.accessors[ins.attributes.ROTATION].count, c); assert.equal(json.accessors[ins.attributes.SCALE].count, c);
      const q = read(ins.attributes.ROTATION);
      for (let i = 0; i < q.length; i += 4) assert.ok(near(Math.hypot(q[i], q[i + 1], q[i + 2], q[i + 3]), 1, 1e-4), 'unit instance rotation');
    }
  });
  return { json, read, image };
}

function setup() {
  const e = new Engine({ home: tmp() });
  e.run('create', { name: 'hull', width: 16 });
  e.run('draw', { canvas: 'hull', commands: [{ op: 'rect', x: 0, y: 0, w: 16, h: 16, color: '#707680' }, { op: 'line', x1: 0, y1: 7, x2: 15, y2: 7, color: '#30343a' }] });
  e.run('create', { name: 'plate', width: 16 });
  e.run('draw', { canvas: 'plate', commands: [{ op: 'rect', x: 0, y: 0, w: 16, h: 16, color: '#808890' }] });
  return e;
}
const buildM = (e, parts, extra = {}) => buildModel({ name: 't', parts, ...extra }, { tex: texResolver(e), getModel: () => { throw new Error('no'); } });

test('normal maps from height: pixel-correct, crisp (no blur), bevel-aware, glTF green-up', () => {
  const W = 12, H = 12, h = new Float32Array(W * H);
  for (let y = 3; y < 9; y++) for (let x = 3; x < 9; x++) h[y * W + x] = 1; // raised 6x6 panel
  const px = (n, x, y) => [...n.subarray((y * W + x) * 4, (y * W + x) * 4 + 3)];
  const n1 = heightToNormal(h, W, H, { strength: 1, bevel: 1, wrap: false });
  assert.deepEqual(px(n1, 0, 0), [128, 128, 255], 'flat = (128,128,255)');
  assert.deepEqual(px(n1, 5, 5), [128, 128, 255], 'panel interior flat');
  assert.deepEqual(px(n1, 2, 5), [128, 128, 255], 'low side of the step stays flat');
  assert.ok(px(n1, 3, 5)[0] < 128 && px(n1, 3, 5)[1] === 128, 'left rim faces -x');
  assert.ok(px(n1, 8, 5)[0] > 128, 'right rim faces +x');
  assert.ok(px(n1, 5, 3)[1] > 128, 'top rim faces up (green > 128)');
  assert.ok(px(n1, 5, 8)[1] < 128, 'bottom rim faces down');
  assert.ok(px(n1, 3, 3)[0] < 128 && px(n1, 3, 3)[1] > 128, 'corner faces up-left');
  // 45° at strength 1 bevel 1: nx = -1/sqrt2
  assert.equal(px(n1, 3, 5)[0], Math.round((-Math.SQRT1_2 * 0.5 + 0.5) * 255));
  // crisp: only texels within `bevel` of a drop tilt
  let tilted = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (px(n1, x, y).join() !== '128,128,255') tilted++;
  assert.equal(tilted, 6 * 6 - 4 * 4, 'exactly the 1-texel rim');
  const n2 = heightToNormal(h, W, H, { strength: 1, bevel: 2, wrap: false });
  assert.ok(px(n2, 4, 5)[0] < 128, 'bevel 2 tilts the second texel too');
  assert.deepEqual(px(n2, 5, 5), [128, 128, 255], 'beyond the bevel stays flat');
  // wrap: a step across the tile border is seen from the other side
  const hw = new Float32Array(W * H); for (let y = 0; y < H; y++) { hw[y * W] = 1; hw[y * W + 1] = 1; }
  assert.ok(px(heightToNormal(hw, W, H, { wrap: true }), 0, 4)[0] < 128, 'wrapped neighbour at x = -1');
});

test('PBR: presets + part material -> glTF factors; metal/rough layers -> metallicRoughnessTexture; height layer -> normalTexture; emissive_panel; glass', () => {
  const e = setup();
  assert.equal(normPBR('bare_metal').metal, 1);
  assert.throws(() => normPBR('chrome'), /unknown material preset/);
  assert.throws(() => normPBR({ metal: 2 }), /0\.\.1/);
  e.run('create', { name: 'gun', width: 8 });
  e.run('draw', { canvas: 'gun', commands: [{ op: 'rect', x: 0, y: 0, w: 8, h: 8, color: '#555' }] });
  for (const l of ['metal', 'rough', 'height']) e.run('layer', { canvas: 'gun', action: 'add', name: l });
  e.run('draw', { canvas: 'gun', layer: 'metal', commands: [{ op: 'rect', x: 0, y: 0, w: 4, h: 8, color: '#ffffff' }] });
  e.run('draw', { canvas: 'gun', layer: 'rough', commands: [{ op: 'rect', x: 0, y: 0, w: 8, h: 4, color: '#333333' }] });
  e.run('draw', { canvas: 'gun', layer: 'height', commands: [{ op: 'rect', x: 2, y: 2, w: 4, h: 4, color: '#ffffff' }] });
  e.run('model_create', { name: 'm', parts: [
    { type: 'box', w: 16, h: 16, d: 16, texture: 'hull', material: 'bare_metal' },
    { type: 'box', w: 8, h: 8, d: 8, texture: 'gun', at: [20, 0, 0] },
    { type: 'box', w: 8, h: 2, d: 8, texture: 'plate', material: 'emissive_panel', at: [-20, 0, 0] },
    { type: 'box', w: 8, h: 8, d: 8, color: '#9fd8ff', material: 'glass', at: [0, 0, 20] },
    { type: 'box', w: 8, h: 8, d: 8, texture: 'plate', material: { metal: 0.5, rough: 0.25 }, at: [0, 0, -20] },
  ] });
  const x = e.run('model_export', { name: 'm', path: path.join(tmp(), 'm.glb') });
  const { json, image } = loadGLB(x.file);
  const mat = (n) => json.materials.find((m) => m.name.startsWith(n));
  const bm = mat('hull_bare_metal');
  assert.deepEqual([bm.pbrMetallicRoughness.metallicFactor, bm.pbrMetallicRoughness.roughnessFactor], [1, 0.35]);
  const cm = mat('plate_m50r25');
  assert.deepEqual([cm.pbrMetallicRoughness.metallicFactor, cm.pbrMetallicRoughness.roughnessFactor], [0.5, 0.25]);
  const gm = json.materials.find((m) => m.name === 'gun');
  assert.deepEqual([gm.pbrMetallicRoughness.metallicFactor, gm.pbrMetallicRoughness.roughnessFactor], [1, 1], 'maps carry the factors');
  const mr = image(gm.pbrMetallicRoughness.metallicRoughnessTexture.index);
  const at = (img, x2, y2) => [...img.data.subarray((y2 * img.width + x2) * 4, (y2 * img.width + x2) * 4 + 4)];
  assert.deepEqual(at(mr, 1, 6), [255, 255, 255, 255], 'metal layer -> B 255, unpainted rough -> G 255');
  assert.deepEqual(at(mr, 6, 1), [255, 51, 0, 255], 'rough layer #333 -> G 51, unpainted metal -> B 0');
  const nm = image(gm.normalTexture.index);
  assert.deepEqual(at(nm, 0, 0).slice(0, 3), [128, 128, 255], 'flat outside the raised square');
  assert.ok(at(nm, 2, 4)[0] < 128, 'left rim of the height square');
  // the colour texture does not contain the data layers
  const base = image(gm.pbrMetallicRoughness.baseColorTexture.index);
  assert.deepEqual(at(base, 1, 1).slice(0, 3), [0x55, 0x55, 0x55]);
  const em = mat('plate_emissive_panel');
  assert.ok(em.emissiveTexture, 'emissive_panel glows with its albedo');
  const gl = json.materials.find((m) => m.alphaMode === 'BLEND');
  assert.ok(gl && gl.doubleSided && gl.extras.glass, 'material:"glass" = glass part');
  // atlas keeps per-texture PBR in a metallicRoughness atlas
  const xa = e.run('model_export', { name: 'm', path: path.join(tmp(), 'ma.glb'), atlas: true });
  const A = loadGLB(xa.file);
  const am = A.json.materials.find((m) => m.name === 'atlas');
  if (am) assert.ok(am.pbrMetallicRoughness.metallicRoughnessTexture, 'atlas carries a metallicRoughness atlas');
});

test('plain exports gain no new glTF data (byte-compatible path)', () => {
  const e = setup();
  e.run('model_create', { name: 'p', parts: [{ type: 'box', w: 16, h: 16, d: 16, texture: 'hull', bevel: 2 }, { type: 'wall', texture: 'hull', at: [30, 0, 0] }] });
  const { json } = loadGLB(e.run('model_export', { name: 'p', path: path.join(tmp(), 'p.glb') }).file);
  assert.equal(json.extensionsUsed, undefined);
  for (const m of json.materials) { assert.equal(m.pbrMetallicRoughness.metallicFactor, 0); assert.equal(m.pbrMetallicRoughness.roughnessFactor, 1); assert.equal(m.occlusionTexture, undefined); assert.equal(m.normalTexture, undefined); }
  for (const m of json.meshes) for (const p of m.primitives) { assert.equal(p.targets, undefined); assert.equal(p.attributes.COLOR_0, undefined); assert.equal(p.attributes.TEXCOORD_1, undefined); }
  const meta = JSON.parse(fs.readFileSync(path.join(path.dirname(e.run('model_export', { name: 'p', path: path.join(tmp(), 'p2.glb') }).file), 'p2.meta.json'), 'utf8'));
  for (const k of ['ao', 'lods', 'impostor', 'collision', 'parts_stats', 'cull', 'morphs']) assert.equal(meta[k], undefined, k);
});

test('baked AO: deterministic, darker in the crevice than in the open, vertex + lightmap modes', () => {
  const e = setup();
  e.run('model_create', { name: 'ao', parts: [{ type: 'floor', w: 96, d: 96, texture: 'plate' }, { type: 'box', w: 16, h: 24, d: 16, texture: 'hull' }] });
  const dir = tmp();
  const a1 = e.run('model_export', { name: 'ao', path: path.join(dir, 'a1.glb'), bake_ao: { samples: 16 } });
  const a2 = e.run('model_export', { name: 'ao', path: path.join(dir, 'a2.glb'), bake_ao: { samples: 16 } });
  assert.ok(fs.readFileSync(a1.file).equals(fs.readFileSync(a2.file)), 'two bakes are byte-identical');
  const G = loadGLB(a1.file);
  const mat = G.json.materials.find((m) => m.occlusionTexture);
  assert.ok(mat && mat.occlusionTexture.texCoord === 1);
  const ao = G.image(mat.occlusionTexture.index);
  // sample the lightmap at the floor right next to the box and at the floor corner
  const floorPrim = G.json.meshes[0].primitives.find((p) => G.json.materials[p.material].name.startsWith('plate'));
  const P = G.read(floorPrim.attributes.POSITION), L = G.read(floorPrim.attributes.TEXCOORD_1), I = G.read(floorPrim.indices);
  const sampleAt = (x, z) => {
    // barycentric search over the floor's top triangles (y = 0)
    for (let t = 0; t < I.length; t += 3) {
      const v = [0, 1, 2].map((k) => I[t + k]);
      if (v.some((i) => Math.abs(P[i * 3 + 1]) > 1e-6)) continue;
      const [a, b, c] = v.map((i) => [P[i * 3], P[i * 3 + 2]]);
      const d = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
      const l1 = ((b[1] - c[1]) * (x - c[0]) + (c[0] - b[0]) * (z - c[1])) / d, l2 = ((c[1] - a[1]) * (x - c[0]) + (a[0] - c[0]) * (z - c[1])) / d, l3 = 1 - l1 - l2;
      if (l1 < -1e-6 || l2 < -1e-6 || l3 < -1e-6) continue;
      const u = l1 * L[v[0] * 2] + l2 * L[v[1] * 2] + l3 * L[v[2] * 2], w = l1 * L[v[0] * 2 + 1] + l2 * L[v[1] * 2 + 1] + l3 * L[v[2] * 2 + 1];
      return ao.data[(Math.floor(w * ao.height) * ao.width + Math.floor(u * ao.width)) * 4];
    }
    throw new Error(`no floor at ${x},${z}`);
  };
  const crevice = sampleAt(9 / 32, 0), open = sampleAt(44 / 32, 44 / 32);
  assert.ok(crevice < open - 40, `contact shadow next to the box (${crevice}) darker than open floor (${open})`);
  assert.ok(open > 230, `open floor stays bright (${open})`);
  // vertex mode: COLOR_0
  const v = e.run('model_export', { name: 'ao', path: path.join(dir, 'av.glb'), bake_ao: { mode: 'vertex', samples: 16 } });
  const GV = loadGLB(v.file);
  const prims = GV.json.meshes[0].primitives;
  assert.ok(prims.every((p) => p.attributes.COLOR_0 !== undefined && GV.json.accessors[p.attributes.COLOR_0].type === 'VEC3'));
  const col = prims.flatMap((p) => GV.read(p.attributes.COLOR_0));
  assert.ok(Math.min(...col) < 0.75 && Math.max(...col) <= 1, 'vertex AO spans dark contact corners');
});

test('greebles: seed-deterministic, non-overlapping, grid-snapped, avoid mask, LOD-tagged; box faces; GPU instancing', () => {
  const e = setup();
  const ctx = { tex: texResolver(e) };
  const L1 = greebleLayout({ w: 96, d: 64, seed: 7 }, ctx), L2 = greebleLayout({ w: 96, d: 64, seed: 7 }, ctx), L3 = greebleLayout({ w: 96, d: 64, seed: 8 }, ctx);
  assert.deepEqual(L1, L2, 'same seed, same layout');
  assert.notDeepEqual(L1.pieces, L3.pieces, 'another seed, another layout');
  assert.ok(L1.pieces.length > 20 && L1.coverage > 0.3, `${L1.pieces.length} pieces, coverage ${L1.coverage}`);
  const overlap = (a, b) => a.u < b.u + b.fx && b.u < a.u + a.fx && a.v < b.v + b.fz && b.v < a.v + a.fz;
  for (let i = 0; i < L1.pieces.length; i++) for (let j = i + 1; j < L1.pieces.length; j++) assert.ok(!overlap(L1.pieces[i], L1.pieces[j]), 'pieces never overlap');
  const G = greebleLayout({ w: 64, d: 64, seed: 2, grid: 4, avoid: [[0, 0, 32, 64]] }, ctx);
  for (const p of G.pieces) {
    assert.ok(near(p.u % 4, 0) && near(p.v % 4, 0) && near(p.sx % 4, 0) && near(p.sz % 4, 0), 'snapped to the 4 px grid');
    assert.ok(p.u >= 32 - 1e-9, 'avoid rect keeps the left half clear');
  }
  // meshes: same seed -> identical geometry; faces tagged for LOD drop
  const g1 = buildM(e, [{ type: 'greeble', w: 64, d: 48, seed: 5 }]).mesh, g2 = buildM(e, [{ type: 'greeble', w: 64, d: 48, seed: 5 }]).mesh;
  const flat = (m) => [...m.groups.values()].flatMap((g) => g.pos);
  assert.deepEqual(flat(g1), flat(g2));
  assert.ok(g1.faces.every(({ f }) => f.greeble === (f.gh <= 2 ? 1 : 2) && f.gh > 0), 'auto drop level: flat pieces at LOD 1, tall ones at LOD 2');
  assert.ok(buildM(e, [{ type: 'greeble', w: 64, d: 48, seed: 5, drop_lod: 3 }]).mesh.faces.every(({ f }) => f.greeble === 3));
  assert.ok(g1.bounds().min[1] >= -1e-6, 'pieces stand on the region');
  // box face greebles sit on that face, inside its rectangle
  const b = buildM(e, [{ type: 'box', w: 64, h: 16, d: 48, texture: 'hull', greebles: [{ face: 'front', seed: 1 }] }]).mesh;
  let onFront = 0;
  for (const { g, f } of b.faces) if (f.greeble) for (let v = f.v; v < f.v + f.vc; v++) { assert.ok(g.pos[v * 3 + 2] >= 24 - 1e-6, 'front greebles stand out of z = d/2'); onFront++; }
  assert.ok(onFront > 0);
  // user model as a piece
  e.run('model_create', { name: 'knob', parts: [{ type: 'cylinder', r: 2, h: 3, color: '#f00' }], greeble_kind: 'knob' });
  const u = e.run('model_create', { name: 'gk', parts: [{ type: 'greeble', w: 32, d: 32, kinds: { knob: 1 }, seed: 3 }] });
  assert.ok(u.parts[0].greebles.pieces > 0 && u.parts[0].greebles.kinds.includes('knob'));
  // GPU instancing: EXT_mesh_gpu_instancing nodes, triangles count every instance
  e.run('model_create', { name: 'gi', parts: [{ type: 'floor', w: 64, d: 64, texture: 'plate' }, { type: 'greeble', w: 64, d: 64, seed: 4, instanced: true, kinds: ['panel', 'vent'], size: [4, 8], grid: 4 }] });
  const merged = e.run('model_info', { name: 'gi' }).triangles;
  const x = e.run('model_export', { name: 'gi', path: path.join(tmp(), 'gi.glb') });
  const { json } = loadGLB(x.file);
  const inst = json.nodes.filter((n) => n.extensions?.EXT_mesh_gpu_instancing);
  assert.ok(inst.length > 0);
  assert.equal(x.triangles, merged, 'instanced export counts the same triangles as the merged model');
});

test('sweeps: closed tubes, mitred polyline, hanging-cable sag, trim strip UVs; trim sheets on bevels', () => {
  const e = setup();
  const t = buildM(e, [{ type: 'tube', path: [[0, 0, 0], [32, 0, 0], [32, 0, 32]], r: 2, sides: 8, texture: 'plate' }]).mesh;
  const s = manifoldStats(t);
  assert.equal(s.open, 0, 'capped tube is closed'); assert.equal(s.nonManifold, 0);
  const c = buildM(e, [{ type: 'tube', from: [0, 40, 0], to: [64, 40, 0], sag: 10, r: 0.5, sides: 4 }]).mesh;
  assert.ok(near(c.bounds().min[1], 30 - 0.5, 0.2), `cable dips by sag (${c.bounds().min[1]})`);
  const sm = buildM(e, [{ type: 'tube', path: [[0, 0, 0], [10, 10, 0], [20, 0, 5], [30, 5, 5]], curve: 'catmull', segments: 4, r: 1 }]).mesh;
  assert.ok(sm.triangles > 0 && manifoldStats(sm).open === 0);
  const tr = e.run('model_trim', { canvas: 'trim' });
  assert.deepEqual(tr.strips.bevel, [8, 6]);
  assert.throws(() => e.run('model_trim', { canvas: 'trim' }), /exists/);
  const pipe = buildM(e, [{ type: 'tube', path: [[0, 0, 0], [0, 32, 0]], r: 2, trim: 'trim:pipe' }]).mesh;
  const g = [...pipe.groups.values()].find((x) => x.tex.canvas === 'trim');
  const [y0, h] = tr.strips.pipe;
  for (let i = 1; i < g.uv.length; i += 2) assert.ok(g.uv[i] * 64 >= y0 - 1e-6 && g.uv[i] * 64 <= y0 + h + 1e-6, 'tube v inside the pipe strip');
  // bevelled box: chamfers move to the trim sheet (mode 3), v inside the bevel strip, u at world scale
  const bb = buildModel({ name: 'b', parts: [{ type: 'box', w: 32, h: 16, d: 16, bevel: 2, texture: 'hull', trim: 'trim:bevel' }] }, { tex: texResolver(e), getModel: () => null }).mesh;
  const tg = [...bb.groups.values()].find((x) => x.tex.canvas === 'trim');
  assert.ok(tg && tg.faces.length === 20, `12 chamfers + 8 corners on the sheet (${tg?.faces.length})`);
  for (const f of tg.faces) for (let v = f.v; v < f.v + f.vc; v++) { const vv = tg.uv[v * 2 + 1] * 64; assert.ok(vv > 8 && vv < 14, `v ${vv} in the bevel strip`); }
  assert.throws(() => buildM(e, [{ type: 'box', trim: 'trim:nope' }]), /no strip "nope"/);
  // mark an existing canvas as a sheet
  e.run('create', { name: 'sheet2', width: 32, height: 16 });
  assert.deepEqual(e.run('model_trim', { canvas: 'sheet2', strips: { a: [0, 8], b: [8, 8] } }).strips.b, [8, 8]);
  assert.throws(() => e.run('model_trim', { canvas: 'sheet2', strips: { c: [12, 8] } }), /inside/);
});

test('booleans: subtract / union / intersect stay closed and manifold with exact volumes; merge drops internal faces', () => {
  const e = setup();
  const vol = (mesh) => { let v = 0; for (const g of mesh.groups.values()) for (let i = 0; i < g.idx.length; i += 3) { const p = (k) => [g.pos[g.idx[i + k] * 3], g.pos[g.idx[i + k] * 3 + 1], g.pos[g.idx[i + k] * 3 + 2]]; const [A, B, C] = [p(0), p(1), p(2)]; v += (A[0] * (B[1] * C[2] - B[2] * C[1]) - A[1] * (B[0] * C[2] - B[2] * C[0]) + A[2] * (B[0] * C[1] - B[1] * C[0])) / 6; } return v; };
  const cases = [
    ['hole', [{ type: 'box', id: 'h', w: 32, h: 32, d: 32, texture: 'hull' }, { type: 'box', w: 8, h: 8, d: 40, at: [0, 12, 0], boolean: 'subtract', target: 'h' }], 32 ** 3 - 8 * 8 * 32],
    ['notch', [{ type: 'box', w: 32, h: 32, d: 32, texture: 'hull' }, { type: 'box', w: 16, h: 16, d: 16, at: [16, 24, 16], boolean: 'subtract' }], 32 ** 3 - 8 * 8 * 8],
    ['union', [{ type: 'box', w: 32, h: 32, d: 32, texture: 'hull' }, { type: 'box', w: 16, h: 16, d: 16, at: [16, 24, 16], color: '#f00', boolean: 'union' }], 32 ** 3 + 16 ** 3 - 8 ** 3],
    ['intersect', [{ type: 'box', w: 32, h: 32, d: 32, texture: 'hull' }, { type: 'box', w: 16, h: 16, d: 16, at: [16, 24, 16], boolean: 'intersect' }], 8 ** 3],
    ['cylinder', [{ type: 'box', w: 32, h: 16, d: 32, texture: 'hull' }, { type: 'cylinder', r: 6, h: 20, segments: 12, at: [0, -2, 0], boolean: 'subtract' }], null],
  ];
  for (const [name, parts, v] of cases) {
    const r = buildM(e, parts);
    const s = manifoldStats(r.mesh);
    assert.deepEqual([s.open, s.nonManifold, s.flipped], [0, 0, 0], `${name}: closed, manifold, consistent winding (${JSON.stringify(s)})`);
    if (v !== null) assert.ok(Math.abs(vol(r.mesh) - v) < 1e-3 * v, `${name} volume ${vol(r.mesh)} vs ${v}`);
    else assert.ok(vol(r.mesh) < 32 * 16 * 32 && vol(r.mesh) > 32 * 16 * 32 - Math.PI * 36 * 16 * 1.01, `${name} volume`);
  }
  // the cut walls follow world UVs; cutters are not emitted
  const cut = e.run('model_create', { name: 'cut', parts: [{ type: 'wall', id: 'w', w: 64, h: 64, d: 8, texture: 'hull' }, { type: 'box', w: 16, h: 24, d: 16, at: [0, 0, 0], boolean: 'subtract', target: 'w' }] });
  assert.deepEqual(cut.parts[1].boolean, { op: 'subtract', target: 0 });
  assert.throws(() => buildM(e, [{ type: 'box', boolean: 'subtract' }]), /earlier part/);
  // merge: two touching boxes lose their shared wall faces
  const two = [{ type: 'box', w: 16, h: 16, d: 16, texture: 'hull' }, { type: 'box', w: 16, h: 16, d: 16, at: [16, 0, 0], texture: 'hull' }];
  const plain = buildM(e, two), merged = buildM(e, two, { merge: true });
  assert.equal(plain.mesh.triangles - merged.mesh.triangles, 4, 'the two coincident 16x16 faces dropped');
  assert.deepEqual(merged.merged, { welded: 0, dropped_triangles: 4 });
  assert.equal(manifoldStats(merged.mesh).nonManifold, 0);
});

test('morph targets: named glTF targets with deltas that reproduce the variant; topology changes are refused', () => {
  const e = setup();
  e.run('model_create', { name: 'door', parts: [{ type: 'box', w: 32, h: 40, d: 4, texture: 'hull' }, { type: 'box', id: 'leaf', w: 16, h: 32, d: 2, at: [0, 4, 3], pivot: [-8, 0, 0], color: '#a84' }], morphs: { open: { set: { leaf: { rotate: [0, -90, 0] } } }, up: { set: { leaf: { at: [0, 12, 3] } } } } });
  const x = e.run('model_export', { name: 'door', path: path.join(tmp(), 'door.glb') });
  assert.deepEqual(x.morphs, ['open', 'up']);
  const G = loadGLB(x.file);
  const m = G.json.meshes[0];
  assert.deepEqual(m.extras.targetNames, ['open', 'up']);
  assert.deepEqual(m.weights, [0, 0]);
  // "up" moves only the leaf, by 8 px = 0.25 units in y
  let moved = 0;
  for (const p of m.primitives) {
    const d = G.read(p.targets[1].POSITION);
    for (let i = 0; i < d.length; i += 3) { if (Math.abs(d[i + 1]) > 1e-6) { assert.ok(near(d[i + 1], 8 / 32, 1e-5)); moved++; } assert.ok(near(d[i], 0) && near(d[i + 2], 0)); }
  }
  assert.ok(moved > 0);
  // "open": the leaf's far edge swings out to +z
  let maxZ = -Infinity;
  for (const p of m.primitives) { const P = G.read(p.attributes.POSITION), d = G.read(p.targets[0].POSITION); for (let i = 0; i < P.length; i += 3) maxZ = Math.max(maxZ, P[i + 2] + d[i + 2]); }
  assert.ok(near(maxZ, (3 + 16) / 32, 1e-4), `open door reaches z ${maxZ}`);
  const pv = e.run('model_preview', { name: 'door', views: ['top'], morph: { up: 1 } });
  assert.ok(pv.image.length > 100);
  e.run('model_update', { name: 'door', morphs: { bad: { set: { leaf: { bevel: 1 } } } } });
  assert.throws(() => e.run('model_export', { name: 'door', path: path.join(tmp(), 'bad.glb') }), /morph "bad"/);
});

test('LODs: triangle ratios, texture-preserving collapses, greebles dropped, monotonic switch distances, nodes or files', () => {
  const e = setup();
  e.run('model_create', { name: 'tower', parts: [
    { type: 'floor', w: 128, d: 128, texture: 'plate', array: { count: 4, cell_step: [1, 0, 0] } },
    { type: 'column', w: 16, h: 96, segments: 16, texture: 'hull', at: [16, 0, 0] },
    { type: 'tube', path: [[-40, 8, 20], [0, 30, 20], [40, 8, 20]], curve: 'catmull', segments: 8, r: 3, sides: 10, texture: 'hull' },
    { type: 'greeble', w: 64, d: 64, seed: 2, at: [60, 0, 60] },
  ] });
  const x = e.run('model_export', { name: 'tower', path: path.join(tmp(), 'tower.glb'), lods: [1, 0.5, 0.2] });
  const { json } = loadGLB(x.file);
  const L = x.lods;
  assert.equal(L.length, 3);
  assert.ok(L[1].triangles <= Math.ceil(L[0].triangles * 0.5) + 2 && L[2].triangles <= Math.ceil(L[0].triangles * 0.2) + 2, `ratios ${L.map((l) => l.triangles)}`);
  assert.ok(L[2].triangles > 20, 'still a shape');
  assert.ok(L[1].distance > 0 && L[2].distance >= L[1].distance, 'switch distances grow');
  const group = json.nodes.find((n) => n.extras?.lod_group);
  assert.deepEqual(group.children.map((i) => json.nodes[i].name), ['tower_LOD0', 'tower_LOD1', 'tower_LOD2']);
  assert.equal(x.triangles, L[0].triangles, 'stats count LOD0 only');
  // texture preservation on a flat world-tiled floor: every LOD vertex keeps the planar UV of its position
  const ctx = { tex: texResolver(e), getModel: () => null };
  const floor = buildModel({ name: 'f', parts: [{ type: 'floor', w: 32, d: 32, texture: 'plate', array: { count: 6, cell_step: [1, 0, 0] } }] }, ctx).mesh;
  const r = simplifyMesh(floor, { ratio: 0.3, level: 1 });
  assert.ok(r.triangles < floor.triangles * 0.5, `${r.triangles} of ${floor.triangles}`);
  let checked = 0;
  for (const g of r.mesh.groups.values()) for (const f of g.faces) {
    const { t, b } = faceBasis(f.n);
    // triangles still lying in the top plane: their texture must not move
    if (f.n[1] < 0.99 || [0, 1, 2].some((k) => Math.abs(g.pos[(f.v + k) * 3 + 1]) > 1e-9)) continue;
    checked++;
    for (let v = f.v; v < f.v + f.vc; v++) {
      const p = [g.pos[v * 3], g.pos[v * 3 + 1], g.pos[v * 3 + 2]];
      // finalize shifts the lattice by uv_origin [16, 0, 16]
      const q = [p[0] - 16, p[1], p[2] - 16];
      assert.ok(near(g.uv[v * 2], (q[0] * t[0] + q[1] * t[1] + q[2] * t[2]) / 16, 1e-6) && near(g.uv[v * 2 + 1], -(q[0] * b[0] + q[1] * b[1] + q[2] * b[2]) / 16, 1e-6), 'planar UV preserved');
    }
  }
  assert.ok(checked >= 2, 'top triangles checked');
  const bb = (m) => m.bounds();
  assert.deepEqual(bb(r.mesh), bb(floor), 'bounds kept');
  // files mode
  const dir = tmp();
  const xf = e.run('model_export', { name: 'tower', path: path.join(dir, 't.glb'), lods: [1, 0.4], lod_mode: 'files' });
  assert.ok(fs.existsSync(path.join(dir, 't_lod1.glb')));
  loadGLB(path.join(dir, 't_lod1.glb'));
  assert.equal(xf.lods[1].level, 1);
  // preview a LOD level
  const pv = e.run('model_preview', { name: 'tower', lod: 2, views: ['iso'] });
  assert.equal(pv.lod.level, 2);
});

test('impostors: octahedral + ring atlas layout, cells, encode/decode, side files', () => {
  for (const hemi of [true, false]) for (let i = 0; i < 50; i++) {
    const th = i * 0.7, ph = (hemi ? 0.5 : 1) * Math.acos(1 - 2 * ((i * 0.37) % 1));
    const d = [Math.sin(ph) * Math.cos(th), Math.cos(ph), Math.sin(ph) * Math.sin(th)];
    const [u, v] = octEncode(d, hemi), r = octDecode(u, v, hemi);
    assert.ok(d.every((x, k) => near(x, r[k], 1e-6)), `decode(encode(d)) = d (${hemi})`);
  }
  const e = setup();
  e.run('model_create', { name: 'blk', parts: [{ type: 'box', w: 32, h: 64, d: 24, texture: 'hull' }, { type: 'box', w: 12, h: 12, d: 12, at: [0, 64, 0], color: '#c80' }] });
  const dir = tmp();
  const x = e.run('model_export', { name: 'blk', path: path.join(dir, 'blk.glb'), impostor: { grid: 4, size: 32 } });
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'blk.impostor.json'), 'utf8'));
  assert.deepEqual(meta.atlas_px, [128, 128]);
  assert.equal(meta.cells.length, 16);
  const cover = new Set();
  for (const c of meta.cells) {
    assert.equal(c.rect[2], 32);
    const k = `${c.rect[0]},${c.rect[1]}`; assert.ok(!cover.has(k), 'cells do not overlap'); cover.add(k);
    assert.ok(near(Math.hypot(...c.dir), 1, 1e-5) && c.dir[1] >= -1e-9, 'unit, upper hemisphere');
    assert.ok(c.pixels > 50, 'every cell shows the model');
    const [u, v] = octEncode(c.dir, true), col = Math.floor(((u + 1) / 2) * 4), row = Math.floor(((v + 1) / 2) * 4);
    assert.deepEqual([col * 32, row * 32], c.rect.slice(0, 2), 'encode(dir) finds the cell');
  }
  for (const f of ['blk.impostor.png', 'blk.impostor_n.png', 'blk.impostor_d.png']) {
    const img = decodePNG(fs.readFileSync(path.join(dir, f)));
    assert.deepEqual([img.width, img.height], [128, 128]);
  }
  assert.ok(x.impostor.switch_distance > 0);
  e.run('model_export', { name: 'blk', path: path.join(dir, 'ring.glb'), impostor: { layout: 'ring', angles: 8, size: 24 } });
  const ring = JSON.parse(fs.readFileSync(path.join(dir, 'ring.impostor.json'), 'utf8'));
  assert.deepEqual([ring.cols, ring.rows, ring.cells.length], [3, 3, 8]);
  assert.ok(near(ring.cells[2].yaw, 90) && near(ring.cells[2].dir[0], 1, 1e-9));
});

test('proxies, stats, cull rooms + auto portals, shadow flags', () => {
  const e = setup();
  e.run('model_create', { name: 'ship', parts: [{ type: 'box', w: 64, h: 16, d: 32, texture: 'hull' }, { type: 'wedge', w: 32, h: 8, d: 16, at: [0, 16, 0], color: '#888', cast_shadow: false }, { type: 'cylinder', r: 4, h: 12, at: [20, 16, 0], receive_shadow: false }] });
  const x = e.run('model_export', { name: 'ship', path: path.join(tmp(), 'ship.glb'), collision: 'hull', occluder: { type: 'boxes', max_boxes: 8 }, stats: true });
  const G = loadGLB(x.file), meta = JSON.parse(fs.readFileSync(x.meta, 'utf8'));
  const col = G.json.nodes.find((n) => n.name === 'ship_collision'), occ = G.json.nodes.find((n) => n.name === 'ship_occluder');
  assert.ok(col.extras.collision && col.extras.visible === false && occ.extras.occluder);
  assert.ok(meta.collision.triangles <= 124, `hull stays low-poly (${meta.collision.triangles})`);
  // the hull is convex: every hull vertex is behind every hull face plane
  const hp = G.json.meshes[col.mesh].primitives[0], P = G.read(hp.attributes.POSITION), I = G.read(hp.indices);
  for (let t = 0; t < I.length; t += 3) {
    const [a, b, c] = [0, 1, 2].map((k) => [P[I[t + k] * 3], P[I[t + k] * 3 + 1], P[I[t + k] * 3 + 2]]);
    const u = b.map((v, k) => v - a[k]), w = c.map((v, k) => v - a[k]), n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
    for (let i = 0; i < P.length; i += 3) assert.ok((P[i] - a[0]) * n[0] + (P[i + 1] - a[1]) * n[1] + (P[i + 2] - a[2]) * n[2] <= 1e-5, 'convex');
  }
  // occluder boxes stay inside the main body (conservative)
  for (const bx of meta.occluder.boxes) for (let k = 0; k < 3; k++) assert.ok(bx.min[k] >= x.bounds_units.min[k] - 1e-6 && bx.max[k] <= x.bounds_units.max[k] + 1e-6);
  assert.equal(x.triangles, e.run('model_info', { name: 'ship' }).triangles, 'proxies are not counted');
  assert.equal(meta.parts_stats.length, 3);
  assert.ok(meta.parts_stats[0].bounds.size[0] === 2);
  // shadow flags split the root into flagged nodes
  const flags = G.json.nodes.filter((n) => n.extras && 'cast_shadow' in n.extras).map((n) => [n.extras.cast_shadow, n.extras.receive_shadow]).sort();
  assert.deepEqual(flags, [[false, true], [true, false], [true, true]]);
  // cull: two rooms joined by a doorway in the dividing wall
  e.run('model_create', { name: 'deck', parts: [
    { type: 'floor', w: 128, d: 64, at: [48, 0, 16], texture: 'plate' },
    { type: 'wall', w: 24, h: 48, d: 4, at: [48, 0, -4], turn: 1 }, { type: 'wall', w: 24, h: 48, d: 4, at: [48, 0, 36], turn: 1 },
  ], cull: { rooms: [{ name: 'a', min: [-16, 0, -16], max: [48, 48, 48] }, { name: 'b', min: [48, 0, -16], max: [112, 48, 48] }, { name: 'c', min: [112, 0, -16], max: [176, 48, 48] }] } });
  const cx = e.run('model_export', { name: 'deck', path: path.join(tmp(), 'deck.glb') });
  const cm = JSON.parse(fs.readFileSync(cx.meta, 'utf8')).cull;
  assert.equal(cm.portals.length, 2, 'doorway a|b and the open side b|c');
  const door = cm.portals.find((p) => p.rooms.join() === 'a,b');
  assert.ok(door.min[2] >= 8 / 32 - 1e-6 && door.max[2] <= 24 / 32 + 1e-6, `doorway spans the gap between the walls (${door.min[2]}..${door.max[2]})`);
  assert.deepEqual(cm.pvs.a.sort(), ['a', 'b', 'c']);
  const names = loadGLB(cx.file).json.nodes.map((n) => n.name);
  assert.ok(names.includes('room_a') && names.includes('room_b'));
});

test('docs: art_help 3d covers the new surface and render-cost features', () => {
  const t = helpText({ topic: '3d' });
  for (const k of ['greeble', 'tube', 'trim', 'boolean', 'morphs', 'bake_ao', 'lods', 'impostor', 'collision', 'cull', 'material', 'bump']) assert.ok(t.includes(k), k);
  assert.ok(Object.keys(MATERIAL_PRESETS).every((p) => t.includes(p)));
});
