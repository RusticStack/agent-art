// 3D models: builder geometry (closed, outward, UVs, greedy merge), .glb validity, preview, art_model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Engine } from '../src/engine.js';
import { decodePNG } from '../src/png.js';
import { packResult } from '../src/server.js';
import { runTool, TOOLS } from '../src/mcp.js';
import { helpText } from '../src/docs.js';
import { SKILLS } from '../src/skills.js';
import { buildModel, BUILDERS } from '../src/model3d.js';
import { texResolver } from '../src/modelops.js';
import { renderViews } from '../src/raster3d.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'agent-art-3d-'));

function setup() {
  const e = new Engine({ home: tmp() });
  e.run('create', { name: 'stone', width: 32 });
  e.run('draw', { canvas: 'stone', commands: [{ op: 'cells', colors: ['#555560', '#777780', '#9999a0'], gap_color: '#30303a', size: 6 }] });
  // L-shaped sprite with transparency
  e.run('create', { name: 'ell', width: 8, height: 8 });
  e.run('draw', { canvas: 'ell', commands: [{ op: 'rect', x: 0, y: 0, w: 3, h: 8, color: '#c33' }, { op: 'rect', x: 3, y: 5, w: 5, h: 3, color: '#33c' }] });
  e.run('create', { name: 'sq', width: 16 });
  e.run('draw', { canvas: 'sq', commands: [{ op: 'rect', x: 0, y: 0, w: 8, h: 16, color: '#f00' }, { op: 'rect', x: 8, y: 0, w: 8, h: 16, color: '#00f' }] });
  // height map: left half white (thick), right half dark grey
  e.run('create', { name: 'ell_h', width: 8, height: 8 });
  e.run('draw', { canvas: 'ell_h', commands: [{ op: 'rect', x: 0, y: 0, w: 4, h: 8, color: '#fff' }, { op: 'rect', x: 4, y: 0, w: 4, h: 8, color: '#808080' }] });
  // candle profile (right half) with an emissive flame layer
  e.run('create', { name: 'candle', width: 8, height: 16 });
  e.run('draw', { canvas: 'candle', commands: [{ op: 'rect', x: 0, y: 4, w: 3, h: 10, color: '#eee' }, { op: 'rect', x: 0, y: 14, w: 5, h: 2, color: '#a73' }, { op: 'rect', x: 0, y: 1, w: 1, h: 3, color: '#fc0' }] });
  e.run('layer', { canvas: 'candle', action: 'add', name: 'emissive' });
  e.run('draw', { canvas: 'candle', layer: 'emissive', commands: [{ op: 'rect', x: 0, y: 1, w: 1, h: 3, color: '#ffa000' }] });
  e.run('create', { name: 'crack', width: 16 });
  e.run('draw', { canvas: 'crack', commands: [{ op: 'line', x1: 4, y1: 0, x2: 9, y2: 15, color: '#000', width: 2 }] });
  return e;
}

const build = (e, parts) => buildModel({ name: 't', parts }, { tex: texResolver(e), getModel: () => { throw new Error('no'); } }).mesh;

/** Signed volume (divergence theorem) and the area-weighted normal sum: closed + outward => volume > 0 and sum ~ 0. */
function solidStats(mesh) {
  let vol = 0, sx = 0, sy = 0, sz = 0, bad = 0, area = 0;
  for (const g of mesh.groups.values()) {
    const P = g.pos, N = g.nrm;
    for (let i = 0; i < g.idx.length; i += 3) {
      const [a, b, c] = [g.idx[i], g.idx[i + 1], g.idx[i + 2]];
      const p = (k) => [P[k * 3], P[k * 3 + 1], P[k * 3 + 2]];
      const A = p(a), B = p(b), C = p(c);
      const u = [B[0] - A[0], B[1] - A[1], B[2] - A[2]], v = [C[0] - A[0], C[1] - A[1], C[2] - A[2]];
      const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
      vol += (A[0] * (B[1] * C[2] - B[2] * C[1]) - A[1] * (B[0] * C[2] - B[2] * C[0]) + A[2] * (B[0] * C[1] - B[1] * C[0])) / 6;
      sx += n[0]; sy += n[1]; sz += n[2];
      area += Math.hypot(...n) / 2;
      // vertex normals agree with the winding (outward)
      const vn = [0, 1, 2].map((k) => [N[g.idx[i + k] * 3], N[g.idx[i + k] * 3 + 1], N[g.idx[i + k] * 3 + 2]]);
      if (vn.some((m) => m[0] * n[0] + m[1] * n[1] + m[2] * n[2] <= 0)) bad++;
    }
  }
  return { vol, open: Math.hypot(sx, sy, sz) / 2 / Math.max(1, area), bad };
}
const uvs = (mesh) => [...mesh.groups.values()].flatMap((g) => g.uv);

test('extrude: closed outward solid, edge-texel walls, greedy merge, depth_map relief', () => {
  const e = setup();
  const sq = build(e, [{ type: 'extrude', canvas: 'sq', depth: 4 }]);
  assert.equal(sq.triangles, 12, 'opaque square = 2 caps + 4 merged walls');
  let s = solidStats(sq);
  assert.ok(Math.abs(s.vol - 16 * 16 * 4) < 1e-6 && s.open < 1e-9 && s.bad === 0, JSON.stringify(s));
  assert.ok(uvs(sq).every((v) => v >= 0 && v <= 1));
  // voxel mode follows the silhouette exactly: volume = opaque px * depth
  const ell = build(e, [{ type: 'extrude', canvas: 'ell', depth: 3, mode: 'voxel' }]);
  s = solidStats(ell);
  assert.ok(Math.abs(s.vol - (24 + 15) * 3) < 1e-6 && s.open < 1e-9 && s.bad === 0, JSON.stringify(s));
  assert.ok(ell.triangles <= 2 * (2 * 2 + 6), `L shape merged into few quads (${ell.triangles})`);
  // quad mode: front/back quads cover the bbox (alpha mask), walls follow the silhouette (6 runs)
  const ellq = build(e, [{ type: 'extrude', canvas: 'ell', depth: 3 }]);
  assert.equal(ellq.triangles, 4 + 2 * 6);
  // wall UVs sit on the edge texel: the top wall of the L's foot samples row 5 (blue)
  const g = [...ellq.groups.values()][0];
  let found = false;
  for (let i = 0; i < g.nrm.length / 3; i++) if (g.nrm[i * 3 + 1] > 0.9 && g.pos[i * 3] > 0) { found = true; assert.equal(Math.floor(g.uv[i * 2 + 1] * 8), 5); }
  assert.ok(found);
  // relief: thickness from luminance (left 8 px, right ~4 px)
  const rel = build(e, [{ type: 'extrude', canvas: 'ell', depth_map: 'ell_h', depth: 8 }]);
  s = solidStats(rel);
  assert.ok(s.open < 1e-9 && s.bad === 0, JSON.stringify(s));
  const expected = 3 * 8 * 8 + 3 * 8 + 4 * 3 * Math.round((128 / 255) * 8); // x<4 white rows, x>=4 grey
  assert.ok(Math.abs(s.vol - expected) < 1e-6, `relief volume ${s.vol} vs ${expected}`);
});

test('kit pieces and primitives are closed, outward and low-poly', () => {
  const e = setup();
  const cases = {
    wall: [{ type: 'wall', texture: 'stone' }, 32 * 64 * 8, 12],
    floor: [{ type: 'floor', texture: 'stone' }, 32 * 4 * 32, 12],
    box: [{ type: 'box', texture: 'stone' }, 32 * 32 * 32, 12],
    stairs: [{ type: 'stairs', steps: 4, rise: 8, run: 8, w: 32 }, 32 * 8 * 8 * 10, null],
    corner: [{ type: 'corner' }, (32 * 8 + 24 * 8) * 64, null],
    pillar: [{ type: 'pillar' }, null, 36],
    column: [{ type: 'column', texture: 'stone' }, null, null],
    arch: [{ type: 'arch', texture: 'stone', span: 16 }, null, null],
    arch_solid: [{ type: 'arch', style: 'solid' }, null, null],
    vault: [{ type: 'vault' }, null, null],
    roof: [{ type: 'roof', w: 32, d: 32, h: 16 }, 32 * 32 * 16 / 2, 8],
    cylinder: [{ type: 'cylinder', r: 8, h: 16, segments: 12 }, 16 * 6 * 64 * Math.sin(Math.PI / 6), null],
    prism: [{ type: 'prism', r: 8, h: 16 }, null, 6 * 2 + 4 * 2],
    shape: [{ type: 'shape', points: [[0, 0], [16, 0], [16, 8], [8, 16], [0, 8]], d: 4 }, (128 + 64) * 4, null],
    wall_ruined: [{ type: 'wall', texture: 'stone', broken: { seed: 4 }, holes: 'crack' }, null, null],
    floor_ruined: [{ type: 'floor', texture: 'stone', broken: true }, null, null],
    arch_ruined: [{ type: 'arch', texture: 'stone', broken: true }, null, null],
    lathe: [{ type: 'lathe', canvas: 'candle', segments: 8 }, null, null],
    lathe_smooth: [{ type: 'lathe', canvas: 'candle', segments: 8, smooth: true }, null, null],
  };
  for (const [name, [part, vol, tris]] of Object.entries(cases)) {
    const m = build(e, [part]);
    const s = solidStats(m);
    assert.ok(s.open < 1e-6, `${name} not closed (${s.open})`);
    assert.equal(s.bad, 0, `${name}: ${s.bad} triangles with inward normals`);
    assert.ok(s.vol > 0, `${name} volume ${s.vol}`);
    if (vol !== null) assert.ok(Math.abs(s.vol - vol) / vol < 1e-6, `${name} volume ${s.vol} vs ${vol}`);
    if (tris !== null) assert.equal(m.triangles, tris, name);
    assert.ok(m.triangles < 1500, `${name}: ${m.triangles} triangles`);
  }
  // ruins remove material but stay well under the plain piece
  const plain = solidStats(build(e, [{ type: 'wall' }])).vol, ruined = solidStats(build(e, [{ type: 'wall', broken: { seed: 4 }, holes: 'crack' }])).vol;
  assert.ok(ruined < plain * 0.95 && ruined > plain * 0.3, `${ruined} vs ${plain}`);
  // stepped lathe volume = sum of N-gon areas per row
  const N = 8, r = [0, 1, 1, 1, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 5, 5];
  const latheVol = r.reduce((sum, rr) => sum + (N / 2) * rr * rr * Math.sin((2 * Math.PI) / N), 0);
  assert.ok(Math.abs(solidStats(build(e, [{ type: 'lathe', canvas: 'candle', segments: N }])).vol - latheVol) < 1e-6);
  // every builder is covered
  for (const t of Object.keys(BUILDERS)) assert.doesNotThrow(() => build(e, [{ type: t, canvas: 'candle', texture: 'stone', points: [[0, 0], [8, 0], [4, 8]] }]), t);
});

test('textures: world tiling keeps 1 texel = 1 px; lathe/extrude UVs stay in 0..1; transforms and grid', () => {
  const e = setup();
  const wall = build(e, [{ type: 'wall', texture: 'stone', w: 64, h: 64 }]);
  const g = [...wall.groups.values()][0];
  // front face spans 64 px -> 2 texture repeats
  const fu = [];
  for (let i = 0; i < g.nrm.length / 3; i++) if (g.nrm[i * 3 + 2] > 0.9) fu.push(g.uv[i * 2]);
  assert.equal(Math.max(...fu) - Math.min(...fu), 2);
  assert.ok(uvs(build(e, [{ type: 'lathe', canvas: 'candle' }])).every((v) => v >= 0 && v <= 1));
  // cell + turn + array: 3 floor tiles side by side at the 32 px grid, turned 90° (still 32 wide)
  const fl = build(e, [{ type: 'floor', texture: 'stone', cell: [1, 0, 0], turn: 1, array: { count: 3, cell_step: [1, 0, 0] } }]);
  const b = fl.bounds();
  assert.deepEqual([b.min[0], b.max[0], b.min[1], b.max[1]], [16, 112, -4, 0]);
  // negative scale mirrors without turning the solid inside out
  const s = solidStats(build(e, [{ type: 'stairs', scale: [-1, 1, 1] }]));
  assert.ok(s.vol > 0 && s.bad === 0);
});

/** Minimal GLB parser + validator. */
function parseGLB(buf) {
  assert.equal(buf.readUInt32LE(0), 0x46546c67, 'magic glTF');
  assert.equal(buf.readUInt32LE(4), 2, 'version 2');
  assert.equal(buf.readUInt32LE(8), buf.length, 'total length');
  const jlen = buf.readUInt32LE(12);
  assert.equal(buf.readUInt32LE(16), 0x4e4f534a, 'JSON chunk');
  assert.equal(jlen % 4, 0, 'JSON chunk padded to 4');
  const json = JSON.parse(buf.toString('utf8', 20, 20 + jlen));
  const bo = 20 + jlen;
  assert.equal(bo % 4, 0, 'BIN chunk aligned');
  const blen = buf.readUInt32LE(bo);
  assert.equal(buf.readUInt32LE(bo + 4), 0x004e4942, 'BIN chunk');
  assert.equal(blen % 4, 0, 'BIN chunk padded');
  assert.equal(bo + 8 + blen, buf.length);
  const bin = buf.subarray(bo + 8, bo + 8 + blen);
  assert.equal(json.buffers[0].byteLength, blen);
  assert.equal(json.asset.version, '2.0');
  for (const v of json.bufferViews) {
    assert.ok(v.byteOffset % 4 === 0 && v.byteOffset + v.byteLength <= blen, 'bufferView inside BIN and aligned');
  }
  const SIZE = { 5126: 4, 5123: 2, 5125: 4 }, COMP = { SCALAR: 1, VEC2: 2, VEC3: 3 };
  const read = (ai) => {
    const a = json.accessors[ai], v = json.bufferViews[a.bufferView];
    const bytes = a.count * COMP[a.type] * SIZE[a.componentType];
    assert.ok(bytes <= v.byteLength, 'accessor fits its bufferView');
    const off = bin.byteOffset + v.byteOffset + (a.byteOffset || 0);
    const T = a.componentType === 5126 ? Float32Array : a.componentType === 5123 ? Uint16Array : Uint32Array;
    return { a, data: new T(bin.buffer.slice(off, off + bytes)) };
  };
  for (const m of json.meshes) for (const p of m.primitives) {
    const { a, data } = read(p.attributes.POSITION);
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < data.length; i++) { min[i % 3] = Math.min(min[i % 3], data[i]); max[i % 3] = Math.max(max[i % 3], data[i]); }
    assert.deepEqual(a.min, min, 'POSITION min');
    assert.deepEqual(a.max, max, 'POSITION max');
    const n = read(p.attributes.NORMAL).data;
    for (let i = 0; i < n.length; i += 3) assert.ok(Math.abs(Math.hypot(n[i], n[i + 1], n[i + 2]) - 1) < 1e-4, 'unit normals');
    assert.equal(read(p.attributes.TEXCOORD_0).a.count, a.count);
    const idx = read(p.indices).data;
    assert.equal(idx.length % 3, 0);
    for (const i of idx) assert.ok(i < a.count, 'index in range');
    assert.ok(json.materials[p.material]);
  }
  for (const im of json.images) {
    const v = json.bufferViews[im.bufferView];
    assert.equal(im.mimeType, 'image/png');
    assert.ok(bin.subarray(v.byteOffset, v.byteOffset + 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), 'PNG magic');
    decodePNG(Buffer.from(bin.subarray(v.byteOffset, v.byteOffset + v.byteLength)));
  }
  for (const s of json.samplers) assert.deepEqual([s.magFilter, s.minFilter, s.wrapS, s.wrapT], [9728, 9728, 10497, 10497]);
  return json;
}

test('glb export: valid binary glTF, materials, emissive, meta.json, instances, atlas', () => {
  const e = setup();
  const dir = tmp();
  e.run('model_create', { name: 'candle3d', parts: [{ type: 'lathe', canvas: 'candle' }, { type: 'extrude', canvas: 'ell', at: [16, 0, 0] }, { type: 'wall', texture: 'stone', at: [0, 0, -16] }] });
  const r = e.run('model_export', { name: 'candle3d', path: path.join(dir, 'candle3d') });
  assert.ok(r.file.endsWith('.glb'));
  const json = parseGLB(fs.readFileSync(r.file));
  assert.equal(json.meshes.length, 1);
  const byName = Object.fromEntries(json.materials.map((m) => [m.name, m]));
  assert.ok(byName.candle.emissiveTexture && byName.candle.emissiveFactor.join() === '1,1,1', 'emissive from the "emissive" layer');
  // only texels the UVs reference decide alpha: the lathe samples opaque profile pixels only
  assert.equal(byName.candle.alphaMode, undefined, 'lathe references no transparent texel');
  assert.ok(byName.ell.alphaMode === undefined || byName.ell.alphaCutoff === 0.5);
  assert.equal(byName.stone.alphaMode, undefined, 'opaque texture stays OPAQUE');
  const meta = JSON.parse(fs.readFileSync(r.meta, 'utf8'));
  assert.equal(meta.units.px_per_unit, 32);
  assert.equal(meta.triangles, r.triangles);
  assert.ok(meta.bounds.size[1] > 1.9 && meta.bounds.size[1] < 2.1, 'wall 64 px = 2 units tall');
  // layout of kit models: baked (one mesh) vs instances (shared meshes + nodes)
  e.run('model_create', { name: 'wall_a', parts: [{ type: 'wall', texture: 'stone' }] });
  e.run('model_create', { name: 'floor_a', parts: [{ type: 'floor', texture: 'stone' }] });
  e.run('model_create', { name: 'room', parts: [{ type: 'model', model: 'floor_a', array: { count: 3, cell_step: [1, 0, 0] } }, { type: 'model', model: 'wall_a', cell: [0, 0, -1], array: { count: 3, cell_step: [1, 0, 0] } }] });
  const baked = parseGLB(fs.readFileSync(e.run('model_export', { name: 'room', path: path.join(dir, 'room.glb') }).file));
  assert.equal(baked.meshes.length, 1);
  const inst = e.run('model_export', { name: 'room', path: path.join(dir, 'room_i.glb'), instances: true });
  const ij = parseGLB(fs.readFileSync(inst.file));
  assert.equal(ij.meshes.length, 2);
  assert.equal(ij.nodes.length, 6);
  assert.equal(inst.triangles, 6 * 12);
  assert.ok(ij.nodes.every((n) => n.mesh !== undefined && (!n.matrix || n.matrix.length === 16)));
  assert.equal(ij.nodes.filter((n) => n.matrix).length, 5, 'identity placement omits matrix');
  assert.equal(ij.nodes[1].matrix[12], 1, 'second floor tile one unit along x');
  // z-up wrapper
  const zj = parseGLB(fs.readFileSync(e.run('model_export', { name: 'wall_a', path: path.join(dir, 'wall_z.glb'), up: 'z' }).file));
  assert.equal(zj.nodes[zj.scenes[0].nodes[0]].name, 'z_up');
  // atlas: image-mapped textures + colours share one material
  e.run('model_create', { name: 'props', parts: [{ type: 'extrude', canvas: 'ell' }, { type: 'extrude', canvas: 'sq', at: [20, 0, 0] }, { type: 'box', color: '#844', w: 4, h: 4, d: 4, at: [40, 0, 0] }] });
  const at = parseGLB(fs.readFileSync(e.run('model_export', { name: 'props', path: path.join(dir, 'props.glb'), atlas: true }).file));
  assert.equal(at.materials.length, 1);
  assert.equal(at.meshes[0].primitives.length, 1);
  // cycles are rejected
  assert.throws(() => e.run('model_update', { name: 'wall_a', add: [{ type: 'model', model: 'room' }] }), /includes itself/);
});

test('preview: every view renders pixels; culling and orientation are right; fast', () => {
  const e = setup();
  const m = build(e, [{ type: 'extrude', canvas: 'sq', depth: 4 }]);
  const groups = [...m.groups.values()];
  const sheet = renderViews(groups, {});
  assert.deepEqual(sheet.views.map((v) => v.view), ['game', 'front', 'side', 'top', 'iso']);
  for (const v of sheet.views) assert.ok(v.pixels > 50, `${v.view}: ${v.pixels} px`);
  // front view: red (image left) on the left; back view: mirrored
  const side = (view) => {
    const img = renderViews(groups, { views: [view], size: 64, labels: false });
    const px = (x) => img.data.subarray((32 * 64 + x) * 4, (32 * 64 + x) * 4 + 3);
    return [px(16), px(48)];
  };
  const [fl, fr] = side('front');
  assert.ok(fl[0] > fl[2] && fr[2] > fr[0], `front ${fl} ${fr}`);
  const [bl, br] = side('back');
  assert.ok(bl[2] > bl[0] && br[0] > br[2], `back ${bl} ${br}`);
  // a ~20k triangle diorama renders all views in well under a second
  e.run('model_create', { name: 'big', parts: [{ type: 'lathe', canvas: 'candle', segments: 64, smooth: true, array: { count: 24, step: [12, 0, 0] } }, { type: 'wall', texture: 'stone', w: 256, broken: { seed: 2 }, holes: 'crack', res: 2, at: [0, 0, -16] }] });
  const t0 = performance.now();
  const p = e.run('model_preview', { name: 'big' });
  const ms = performance.now() - t0;
  assert.ok(p.triangles > 15000, `${p.triangles} tris`);
  assert.ok(ms < 3000, `preview took ${ms} ms`);
  const img = decodePNG(p.image);
  assert.ok(img.width > 300 && img.height > 300);
});

test('art_model through runTool (MCP path), help topic and skill', async () => {
  const e = setup();
  const call = async (op, args) => packResult(await e.run(op, args));
  const created = await runTool('art_model', { action: 'create', name: 'arch_a', parts: [{ type: 'arch', texture: 'stone', span: 24 }], preview: true }, call);
  assert.ok(created.some((c) => c.type === 'image'));
  assert.equal(JSON.parse(created[0].text).model, 'arch_a');
  const upd = JSON.parse((await runTool('art_model', { action: 'update', name: 'arch_a', set: { 0: { broken: { seed: 2 } } } }, call))[0].text);
  assert.ok(upd.triangles > 0);
  const info = JSON.parse((await runTool('art_model', { action: 'info', name: 'arch_a' }, call))[0].text);
  assert.equal(info.parts_def[0].broken.seed, 2);
  const list = JSON.parse((await runTool('art_model', { action: 'list' }, call))[0].text);
  assert.deepEqual(list.models.map((m) => m.name), ['arch_a']);
  const pv = await runTool('art_model', { action: 'preview', name: 'arch_a', views: ['game'] }, call);
  assert.equal(pv[1].type, 'image');
  const out = path.join(tmp(), 'arch_a.glb');
  const ex = JSON.parse((await runTool('art_model', { action: 'export', name: 'arch_a', path: out }, call))[0].text);
  assert.ok(fs.existsSync(ex.file) && fs.existsSync(ex.meta));
  // bad input explains itself
  await assert.rejects(runTool('art_model', { action: 'create', name: 'bad', parts: [{ type: 'wal' }] }, call), /unknown part type "wal"/);
  await assert.rejects(runTool('art_model', { action: 'create', name: 'bad', parts: [{ type: 'arch', w: 10, span: 16 }] }, call), /usage: arch/);
  // persisted: a fresh engine on the same home sees the model
  assert.ok(new Engine({ home: e.home }).run('model_list').models.length === 1);
  assert.ok(TOOLS.some((t) => t.name === 'art_model'));
  assert.match(helpText({ topic: '3d' }), /gothic|Gothic/);
  assert.ok(SKILLS['3d-kit']);
});

// ---------- ship / vehicle kit: translucency, tapered + bevelled primitives, loft, planes, mirror, pivot, radial arrays, wrap, insets ----------
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps * Math.max(1, Math.abs(b));
function assertSolid(name, m, vol) {
  const s = solidStats(m);
  assert.ok(s.open < 1e-6, `${name} not closed (${s.open})`);
  assert.equal(s.bad, 0, `${name}: ${s.bad} triangles with inward normals`);
  assert.ok(s.vol > 0, `${name} volume ${s.vol}`);
  if (vol !== undefined) assert.ok(near(s.vol, vol), `${name} volume ${s.vol} vs ${vol}`);
  return s;
}
const ngon = (r, N) => (N / 2) * r * r * Math.sin((2 * Math.PI) / N);

test('glass / opacity: glTF BLEND with opacity factor, double-sided glass, shared image, preview blends', () => {
  const e = setup();
  const dir = tmp();
  e.run('model_create', { name: 'canopy', parts: [
    { type: 'box', texture: 'stone', w: 32, h: 8, d: 32 },
    { type: 'box', texture: 'stone', w: 16, h: 8, d: 16, at: [0, 8, 0], glass: true },
    { type: 'box', color: '#3af', w: 8, h: 8, d: 8, at: [0, 16, 0], opacity: 0.5 },
  ] });
  const r = e.run('model_export', { name: 'canopy', path: path.join(dir, 'canopy.glb') });
  const json = parseGLB(fs.readFileSync(r.file));
  const byName = Object.fromEntries(json.materials.map((m) => [m.name, m]));
  assert.equal(byName.stone.alphaMode, undefined, 'opaque part stays OPAQUE');
  assert.equal(byName.stone.doubleSided, undefined);
  const glass = byName.stone_glass;
  assert.equal(glass.alphaMode, 'BLEND');
  assert.equal(glass.doubleSided, true, 'glass is double-sided');
  assert.equal(glass.pbrMetallicRoughness.baseColorFactor[3], 0.35, 'glass default opacity');
  assert.equal(glass.extras.depthWrite, false);
  assert.equal(glass.alphaCutoff, undefined, 'BLEND has no cutoff');
  const tint = json.materials.find((m) => m.name.endsWith('_a50'));
  assert.equal(tint.alphaMode, 'BLEND');
  assert.equal(tint.pbrMetallicRoughness.baseColorFactor[3], 0.5);
  assert.ok(!tint.doubleSided, 'plain opacity stays single-sided');
  // glass and the opaque box sample the same PNG
  assert.equal(json.images.length, 2, 'stone image shared by the glass variant');
  assert.equal(glass.pbrMetallicRoughness.baseColorTexture.index, byName.stone.pbrMetallicRoughness.baseColorTexture.index);
  // atlas leaves translucent materials alone
  const at = parseGLB(fs.readFileSync(e.run('model_export', { name: 'canopy', path: path.join(dir, 'canopy_at.glb'), atlas: true }).file));
  assert.ok(at.materials.some((m) => m.alphaMode === 'BLEND'));
  // preview: the glass box tints, it does not hide what is behind it
  const p = e.run('model_preview', { name: 'canopy', views: ['front'] });
  assert.ok(p.views[0].pixels > 50);
  assert.throws(() => e.run('model_create', { name: 'bad', parts: [{ type: 'box', opacity: 2 }] }), /opacity must be a number 0\.\.1/);
});

test('wedge, tapered box, bevelled box, frustum and cone: closed, outward, exact volumes and triangle counts', () => {
  const e = setup();
  // default wedge = ramp: top collapsed to the back edge
  const ramp = build(e, [{ type: 'wedge', w: 32, h: 16, d: 32 }]);
  assertSolid('ramp', ramp, (32 * 32 * 16) / 2);
  assert.equal(ramp.triangles, 8, 'bottom, back, slope (2 each) + 2 triangular sides');
  assert.deepEqual(ramp.bounds(), { min: [-16, 0, -16], max: [16, 16, 16] });
  // ridge (top_w 0), and a trapezoid top shifted forward
  assertSolid('ridge', build(e, [{ type: 'wedge', w: 32, h: 16, d: 32, top_w: 0, top_d: 32, shift: [0, 0] }]), (32 * 32 * 16) / 2);
  const trap = build(e, [{ type: 'wedge', w: 32, h: 16, d: 32, top_w: 16, top_d: 16, shift: [4, 8] }]);
  assertSolid('trapezoid wedge', trap, (16 / 6) * (32 * 32 + 4 * 24 * 24 + 16 * 16));
  assert.deepEqual(trap.bounds().max, [16, 16, 16]);
  // taper: front face (+z) scaled about its centre (a nose)
  const nose = build(e, [{ type: 'box', w: 16, h: 16, d: 32, taper: 0.5 }]);
  assertSolid('taper', nose, (32 / 6) * (16 * 16 + 4 * 12 * 12 + 8 * 8));
  assert.equal(nose.triangles, 12);
  const zs = [];
  const g = [...nose.groups.values()][0];
  for (let i = 0; i < g.pos.length; i += 3) if (near(g.pos[i + 2], 16)) zs.push([g.pos[i], g.pos[i + 1]]);
  assert.ok(zs.length && zs.every(([x, y]) => Math.abs(x) <= 4 + 1e-9 && y >= 4 - 1e-9 && y <= 12 + 1e-9), 'nose face is 8x8 centred');
  assertSolid('taper to a point', build(e, [{ type: 'box', w: 16, h: 16, d: 32, taper: [0, 0] }]), (32 * 16 * 16) / 3);
  // bevel: 6 faces + 12 chamfer strips (2 tris) + 8 corner triangles; volume = box - edge prisms - corners
  const bev = build(e, [{ type: 'box', w: 16, h: 16, d: 16, bevel: 2 }]);
  assertSolid('bevel', bev, 16 ** 3 - 12 * (4 / 2) * (16 - 4) - (8 * (5 * 8)) / 6);
  assert.equal(bev.triangles, 44);
  assert.deepEqual(bev.bounds(), { min: [-8, 0, -8], max: [8, 16, 8] });
  assert.throws(() => build(e, [{ type: 'box', bevel: 2, taper: 0.5 }]), /cannot be combined/);
  // frustum + cone (exact N-gon volumes)
  const N = 12;
  const fr = build(e, [{ type: 'cylinder', r_bottom: 8, r_top: 4, h: 16, segments: N }]);
  const A0 = ngon(8, N), A1 = ngon(4, N);
  assertSolid('frustum', fr, (16 / 3) * (A0 + A1 + Math.sqrt(A0 * A1)));
  assert.equal(fr.triangles, 2 * N + 2 * (N - 2));
  const cone = build(e, [{ type: 'cone', r: 8, h: 12, segments: N }]);
  assertSolid('cone', cone, (12 / 3) * ngon(8, N));
  assert.equal(cone.triangles, N + (N - 2), 'cone: one triangle per segment, no top cap');
  // slanted smooth normals: the cone side leans outward and up
  const cg = [...cone.groups.values()][0];
  let up = 0;
  for (let i = 0; i < cg.nrm.length; i += 3) if (cg.nrm[i + 1] > 0.1 && cg.nrm[i + 1] < 0.99) up++;
  assert.ok(up > 0, 'cone side normals tilt up');
  assertSolid('inverted cone (r_bottom 0)', build(e, [{ type: 'cylinder', r_top: 6, r_bottom: 0, h: 10, segments: 8 }]), (10 / 3) * ngon(6, 8));
  assert.throws(() => build(e, [{ type: 'cylinder', r_top: 0, r_bottom: 0 }]), /must be > 0/);
});

test('shape: plane "zy" side profiles, loft (scale_end), clear error for unknown planes', () => {
  const e = setup();
  const tri = [[0, 0], [16, 0], [0, 8]];
  // zy: profile [z, y], thickness along x (centred)
  const side = build(e, [{ type: 'shape', plane: 'zy', points: tri, d: 4 }]);
  assertSolid('shape zy', side, 64 * 4);
  assert.deepEqual(side.bounds(), { min: [-2, 0, 0], max: [2, 8, 16] });
  // xy and xz unchanged
  assert.deepEqual(build(e, [{ type: 'shape', points: tri, d: 4 }]).bounds(), { min: [0, 0, -2], max: [16, 8, 2] });
  assert.deepEqual(build(e, [{ type: 'shape', plane: 'xz', points: tri, d: 4 }]).bounds(), { min: [0, 0, 0], max: [16, 4, 8] });
  assert.throws(() => build(e, [{ type: 'shape', plane: 'yz', points: tri }]), /shape plane must be "xy".*"xz".*"zy".*got "yz"/s);
  // loft: square hull section 16x16 narrowing to 8x8 at the nose (+z), 32 long
  const sq = [[-8, 0], [8, 0], [8, 16], [-8, 16]];
  const hull = build(e, [{ type: 'shape', points: sq, d: 32, scale_end: [0.5, 0.5] }]);
  assertSolid('loft', hull, (32 / 6) * (256 + 4 * 144 + 64));
  assert.deepEqual(hull.bounds(), { min: [-8, 0, -16], max: [8, 16, 16] });
  const hg = [...hull.groups.values()][0];
  for (let i = 0; i < hg.pos.length; i += 3) if (near(hg.pos[i + 2], 16)) assert.ok(Math.abs(hg.pos[i]) <= 4 + 1e-9 && hg.pos[i + 1] >= 4 - 1e-9 && hg.pos[i + 1] <= 12 + 1e-9, 'nose section 8x8 about the bbox centre');
  // loft type (default 0.5), non-uniform scale (bent walls are split into triangles), a point nose, a zy loft
  assertSolid('loft type', build(e, [{ type: 'loft', points: sq, d: 32 }]), (32 / 6) * (256 + 4 * 144 + 64));
  assertSolid('loft non-uniform', build(e, [{ type: 'loft', points: sq, d: 32, scale_end: [0.25, 1] }]), (32 / 6) * (256 + 4 * (10 * 16) + 4 * 16));
  assertSolid('loft to a point', build(e, [{ type: 'loft', points: sq, d: 30, scale_end: 0 }]), (30 * 256) / 3);
  const zl = build(e, [{ type: 'loft', plane: 'zy', points: [[0, 0], [32, 0], [32, 8], [0, 8]], d: 16, scale_end: [1, 0.5] }]);
  assertSolid('loft zy', zl, (16 / 6) * (256 + 4 * 32 * 6 + 32 * 4));
});

test('mirror: mirrored copies keep outward winding and normals; lists give every combination', () => {
  const e = setup();
  // an asymmetric wedge off to the right
  const part = { type: 'wedge', w: 16, h: 8, d: 16, top_w: 4, top_d: 8, shift: [5, 2], at: [20, 0, 0] };
  const one = build(e, [part]);
  const both = build(e, [{ ...part, mirror: 'x' }]);
  const v1 = assertSolid('wedge', one).vol;
  assertSolid('mirrored wedge', both, 2 * v1);
  assert.equal(both.triangles, 2 * one.triangles);
  assert.equal(both.bounds().min[0], -28);
  assert.equal(both.bounds().max[0], 28);
  // the mirrored copy faces the other way: its outer side normals point to -x
  for (const g of both.groups.values()) for (let i = 0; i < g.pos.length; i += 3) if (near(g.pos[i], -28) && Math.abs(g.nrm[i + 1]) < 0.5 && Math.abs(g.nrm[i + 2]) < 0.5) assert.ok(g.nrm[i] < -0.9, 'outer side of the mirrored copy faces -x');
  // glb stays valid (unit normals, indices in range)
  e.run('model_create', { name: 'wings', parts: [{ type: 'wedge', w: 16, h: 4, d: 16, top_w: 4, shift: [6, 0], at: [16, 0, 0], mirror: 'x' }] });
  parseGLB(fs.readFileSync(e.run('model_export', { name: 'wings', path: path.join(tmp(), 'wings.glb') }).file));
  // ["x","z"] = four copies (quadrants); y mirror flips upside down
  const quad = build(e, [{ type: 'box', w: 4, h: 4, d: 4, at: [10, 0, 10], mirror: ['x', 'z'] }]);
  assertSolid('quad mirror', quad, 4 * 64);
  assert.deepEqual(quad.bounds(), { min: [-12, 0, -12], max: [12, 4, 12] });
  assertSolid('y mirror', build(e, [{ type: 'box', w: 4, h: 4, d: 4, at: [0, 2, 0], mirror: 'y' }]), 2 * 64);
  assert.throws(() => build(e, [{ type: 'box', mirror: 'w' }]), /mirror must be "x", "y", "z"/);
});

test('rotation pivot and radial arrays about a centre', () => {
  const e = setup();
  const r6 = (b) => ({ min: b.min.map((v) => +v.toFixed(6) + 0), max: b.max.map((v) => +v.toFixed(6) + 0) });
  // rotate about the part origin (bottom-centre) vs about its centre via pivot
  assert.deepEqual(r6(build(e, [{ type: 'box', w: 16, h: 16, d: 16, rotate: [0, 0, 90] }]).bounds()), { min: [-16, -8, -8], max: [0, 8, 8] });
  assert.deepEqual(r6(build(e, [{ type: 'box', w: 16, h: 16, d: 16, rotate: [0, 0, 90], pivot: [0, 8, 0] }]).bounds()), { min: [-8, 0, -8], max: [8, 16, 8] });
  // pivot + at: rotation happens about the pivot, then the part moves by at
  assert.deepEqual(r6(build(e, [{ type: 'box', w: 16, h: 16, d: 16, rotate: [0, 0, 90], pivot: [0, 8, 0], at: [5, 0, 0] }]).bounds()), { min: [-3, 0, -8], max: [13, 16, 8] });
  // order X then Y then Z (fixed axes): a +y bar rotated X 90 points +z, then Y 90 turns it to +x
  const bar = r6(build(e, [{ type: 'box', w: 2, h: 16, d: 2, rotate: [90, 90, 0] }]).bounds());
  assert.ok(near(bar.max[0], 16) && near(bar.min[0], 0), `X then Y: ${JSON.stringify(bar)}`);
  // radial array: 4 engines at 90° about the world origin
  const ring = build(e, [{ type: 'box', w: 4, h: 4, d: 4, at: [20, 0, 0], array: { count: 4, rotate: [0, 90, 0], about: [0, 0, 0] } }]);
  assertSolid('ring', ring, 4 * 64);
  const centres = [[20, 0], [0, -20], [-20, 0], [0, 20]], hit = new Set();
  for (const g of ring.groups.values()) for (let i = 0; i < g.pos.length; i += 3) {
    const k = centres.findIndex(([x, z]) => Math.abs(g.pos[i] - x) <= 2 + 1e-9 && Math.abs(g.pos[i + 2] - z) <= 2 + 1e-9);
    assert.ok(k >= 0, `vertex ${g.pos[i]},${g.pos[i + 2]} is on one of the 4 engines`);
    hit.add(k);
  }
  assert.equal(hit.size, 4, 'every copy placed around the centre');
  // about off the origin, plus a step (spiral)
  assert.deepEqual(r6(build(e, [{ type: 'box', w: 2, h: 2, d: 2, at: [10, 0, 5], array: { count: 2, rotate: [0, 180, 0], about: [0, 0, 5], step: [0, 4, 0] } }]).bounds()), { min: [-11, 0, 4], max: [11, 6, 6] });
  // without about the copies still turn in place (old behaviour)
  assert.deepEqual(r6(build(e, [{ type: 'box', w: 4, h: 4, d: 4, at: [20, 0, 0], array: { count: 4, rotate: [0, 90, 0] } }]).bounds()), { min: [18, 0, -2], max: [22, 4, 2] });
  assert.throws(() => build(e, [{ type: 'box', array: { count: 2, about: 5 } }]), /array.about must be/);
});

test('cylinder wrap:"once"|"repeat" and u_offset place the texture on one side', () => {
  const e = setup();
  const sideUV = (part) => {
    const out = [];
    for (const g of build(e, [part]).groups.values()) {
      if (g.tex.canvas !== 'sq') continue;
      for (let i = 0; i < g.nrm.length / 3; i++) out.push({ n: [g.nrm[i * 3], g.nrm[i * 3 + 2]], u: g.uv[i * 2], v: g.uv[i * 2 + 1] });
    }
    return out;
  };
  const span = (s, k) => Math.max(...s.map((p) => p[k])) - Math.min(...s.map((p) => p[k]));
  const base = { type: 'cylinder', r: 8, h: 16, segments: 12, side: 'sq', cap: '#444' };
  // once: one copy round, image centre (u 0.5) facing the front (+z); v fitted 0..1
  let s = sideUV({ ...base, wrap: 'once' });
  const front = s.filter((p) => p.n[1] > 0.99);
  assert.ok(front.length && front.every((p) => near(p.u, 0.5) || near(p.u, 1.5)), `front u ${front.map((p) => p.u)}`);
  assert.ok(near(span(s, 'u'), 1), 'exactly one copy round');
  assert.ok(s.every((p) => p.v === 0 || p.v === 1));
  // u_offset 0.25: the image centre turns a quarter toward +x
  s = sideUV({ ...base, wrap: 'once', u_offset: 0.25 });
  const right = s.filter((p) => p.n[0] > 0.99);
  assert.ok(right.length && right.every((p) => near(p.u, 0.5)), `right u ${right.map((p) => p.u)}`);
  // repeat: an integer number of copies (seamless); default from the circumference, or repeat:n
  s = sideUV({ ...base, wrap: 'repeat' });
  assert.ok(near(span(s, 'u'), Math.round((2 * Math.PI * 8) / 16)));
  s = sideUV({ ...base, wrap: 'repeat', repeat: 2 });
  assert.ok(near(span(s, 'u'), 2));
  assert.ok(near(span(s, 'v'), 1), 'repeat: v tiles with the world (16 px = 1)');
  // default unchanged (tile:false = stretched, u 0 at the front)
  s = sideUV({ ...base, tile: false });
  assert.ok(s.filter((p) => p.n[1] > 0.99).some((p) => near(p.u, 0) || near(p.u, 1)));
  assert.throws(() => build(e, [{ ...base, wrap: 'clamp' }]), /wrap must be "once" or "repeat"/);
});

test('inset panels: recesses and raised panels on box faces without CSG', () => {
  const e = setup();
  const B = 32 ** 3;
  assertSolid('recess', build(e, [{ type: 'box', texture: 'stone', w: 32, h: 32, d: 32, insets: [{ face: 'front', rect: [8, 8, 16, 16], depth: 4 }] }]), B - 16 * 16 * 4);
  assertSolid('raised', build(e, [{ type: 'box', w: 32, h: 32, d: 32, insets: [{ face: 'top', rect: [4, 4, 8, 8], depth: -2 }] }]), B + 8 * 8 * 2);
  // hangar mouth touching the bottom edge, a hatch in the side's corner, two intakes on the back
  const hull = build(e, [{ type: 'box', texture: 'stone', w: 32, h: 32, d: 32, insets: [
    { face: 'front', rect: [8, 16, 16, 16], depth: 24, texture: 'sq' },
    { face: 'right', rect: [0, 0, 8, 8], depth: 2 },
    { face: 'back', rect: [2, 2, 8, 4], depth: 3 }, { face: 'back', rect: [22, 2, 8, 4], depth: 3 },
  ] }]);
  assertSolid('hull', hull, B - 16 * 16 * 24 - 64 * 2 - 2 * 32 * 3);
  assert.ok(hull.triangles < 120, `${hull.triangles} tris`);
  assert.ok([...hull.groups.values()].some((g) => g.tex.canvas === 'sq'), 'panel texture on the recess floor');
  // the standalone inset part: box + one panel (panel = floor texture); default rect = centred half
  const ins = build(e, [{ type: 'inset', w: 32, h: 16, d: 16, face: 'front', rect: [4, 4, 24, 8], depth: 3, texture: 'stone', panel: 'sq' }]);
  assertSolid('inset part', ins, 32 * 16 * 16 - 24 * 8 * 3);
  assert.ok([...ins.groups.values()].some((g) => g.tex.canvas === 'sq'));
  assertSolid('inset default rect', build(e, [{ type: 'inset', w: 32, h: 32, d: 32, depth: 2 }]), B - 16 * 16 * 2);
  assert.throws(() => build(e, [{ type: 'box', w: 16, h: 16, d: 16, insets: [{ face: 'front', rect: [8, 8, 16, 16], depth: 2 }] }]), /must lie inside the front face/);
  assert.throws(() => build(e, [{ type: 'box', w: 16, h: 16, d: 16, insets: [{ face: 'front', rect: [0, 0, 8, 8], depth: 16 }] }]), /less than the box thickness/);
  assert.throws(() => build(e, [{ type: 'box', insets: [{ face: 'side', rect: [0, 0, 4, 4] }] }]), /inset face must be one of/);
});

test('origin hint, art_help 3d and the art_model schema document the ship kit', () => {
  const e = setup();
  const r = e.run('model_create', { name: 'ship', parts: [{ type: 'box', w: 8, h: 8, d: 8, at: [40, 4, 0] }] });
  assert.match(r.next, /origin:"bottom"/);
  const c = e.run('model_create', { name: 'kit', parts: [{ type: 'wall' }] });
  assert.doesNotMatch(c.next, /origin:"bottom"/, 'centred kit pieces get no hint');
  const b = e.run('model_update', { name: 'ship', origin: 'bottom' });
  assert.deepEqual(b.bounds_px.min, [-4, 0, -4]);
  const help = helpText({ topic: '3d' });
  for (const k of ['wedge', 'taper', 'bevel', 'r_top', 'loft', 'scale_end', '"zy"', 'mirror', 'pivot', 'X then Y then Z', 'about', 'origin:"bottom"', 'wrap', 'u_offset', 'inset', 'glass', 'opacity', 'BLEND']) assert.ok(help.includes(k), `art_help 3d mentions ${k}`);
  const tool = TOOLS.find((t) => t.name === 'art_model');
  for (const k of ['wedge', 'loft', 'inset', 'glass', 'mirror', 'pivot', 'about']) assert.ok(tool.description.includes(k), `art_model description mentions ${k}`);
});
