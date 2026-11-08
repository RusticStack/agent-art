// 3D world-space UVs, smooth ruins, overlays (TEXCOORD_1) and connected textures (CTM).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Engine } from '../src/engine.js';
import { buildModel, BUILDERS, Mesh, mT, finalize } from '../src/model3d.js';
import { texResolver } from '../src/modelops.js';
import { ctmTileFor, BLOB_MASKS, generateCTM, composeCompact, methodMasks, CTM_METHODS } from '../src/ctm.js';
import { triangulateShape, contour, simplifyLoop, nestLoops } from '../src/poly2d.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'agent-art-ctm-'));
const blobRef = (x) => {
  let r = x & 85;
  if (x & 1 && x & 4 && x & 2) r |= 2;
  if (x & 4 && x & 16 && x & 8) r |= 8;
  if (x & 16 && x & 64 && x & 32) r |= 32;
  if (x & 64 && x & 1 && x & 128) r |= 128;
  return r;
};

/** Engine with a "coded" texture: pixel (x, y) = rgb(x*8, y*8, 77), so samples reveal texel coords. */
function setup() {
  const e = new Engine({ home: tmp() });
  const mk = (name, w, h, fill) => {
    e.run('create', { name, width: w, height: h });
    const d = e.get(name), data = d.layers[0].data;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.set(fill(x, y), (y * w + x) * 4);
  };
  mk('coded', 32, 32, (x, y) => [x * 8, y * 8, 77, 255]);
  mk('big', 64, 64, (x, y) => [x * 4, y * 4, 99, 255]);
  mk('plain', 32, 32, () => [200, 200, 190, 255]);
  mk('grime', 16, 16, (x, y) => ((x + y) % 3 ? [40, 30, 20, 255] : [0, 0, 0, 0]));
  mk('moss', 16, 16, (x, y) => ((x * 3 + y) % 4 ? [60, 140, 40, 255] : [0, 0, 0, 0]));
  mk('grass', 32, 32, () => [70, 150, 60, 255]);
  mk('crack', 16, 16, (x, y) => (Math.abs(x - 8 - (y - 8) / 3) < 1.5 && y > 3 && y < 13 ? [0, 0, 0, 255] : [0, 0, 0, 0]));
  return e;
}
const build = (e, parts, models = {}, extra = {}) => buildModel({ name: 't', parts, ...extra }, { tex: texResolver(e), getModel: (n) => ({ name: n, ...models[n] }) });

/** Texel sampled where the ray along -n hits a face at world point p (face normal ~ n). -> [x, y] texel or null. */
function texelAt(mesh, p, n) {
  for (const g of mesh.groups.values()) {
    if (g.overlay) continue;
    for (let i = 0; i < g.idx.length; i += 3) {
      const V = [0, 1, 2].map((k) => g.idx[i + k]);
      const P = V.map((v) => [g.pos[v * 3], g.pos[v * 3 + 1], g.pos[v * 3 + 2]]);
      const u = P[1].map((x, k) => x - P[0][k]), w = P[2].map((x, k) => x - P[0][k]);
      const fn = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
      const l = Math.hypot(...fn);
      if (l < 1e-9 || (fn[0] * n[0] + fn[1] * n[1] + fn[2] * n[2]) / l < 0.99) continue;
      const d = (p[0] - P[0][0]) * fn[0] / l + (p[1] - P[0][1]) * fn[1] / l + (p[2] - P[0][2]) * fn[2] / l;
      if (Math.abs(d) > 1e-4) continue;
      // barycentric in the dominant plane
      const ax = Math.abs(fn[0]) > Math.abs(fn[1]) ? (Math.abs(fn[0]) > Math.abs(fn[2]) ? 0 : 2) : Math.abs(fn[1]) > Math.abs(fn[2]) ? 1 : 2;
      const [i0, i1] = [0, 1, 2].filter((k) => k !== ax);
      const q = [p[i0], p[i1]], A = [P[0][i0], P[0][i1]], B = [P[1][i0], P[1][i1]], C = [P[2][i0], P[2][i1]];
      const den = (B[1] - C[1]) * (A[0] - C[0]) + (C[0] - B[0]) * (A[1] - C[1]);
      const l0 = ((B[1] - C[1]) * (q[0] - C[0]) + (C[0] - B[0]) * (q[1] - C[1])) / den;
      const l1 = ((C[1] - A[1]) * (q[0] - C[0]) + (A[0] - C[0]) * (q[1] - C[1])) / den;
      const l2 = 1 - l0 - l1;
      if (l0 < -1e-6 || l1 < -1e-6 || l2 < -1e-6) continue;
      const uv = [0, 1].map((c) => l0 * g.uv[V[0] * 2 + c] + l1 * g.uv[V[1] * 2 + c] + l2 * g.uv[V[2] * 2 + c]);
      const tw = g.tex.width, th = g.tex.height;
      const mod = (a, m) => ((a % m) + m) % m;
      return { x: mod(Math.floor(uv[0] * tw), tw), y: mod(Math.floor(uv[1] * th), th), tex: g.tex, uv };
    }
  }
  return null;
}
/** Texel coordinates on both sides of a point along direction dir (px), on faces facing n. */
function across(mesh, p, dir, n) {
  const a = texelAt(mesh, p.map((v, k) => v - dir[k] * 0.5), n), b = texelAt(mesh, p.map((v, k) => v + dir[k] * 0.5), n);
  assert.ok(a && b, `faces on both sides of ${p} (${!!a}, ${!!b})`);
  return [a, b];
}
const nextTexel = ([a, b], W = 32) => b.x === (a.x + 1) % W && b.y === a.y;

/** Closed 2-manifold: every directed edge has its reverse (positions welded). */
function closed(mesh) {
  const key = (g, v) => `${Math.round(g.pos[v * 3] * 1e3)},${Math.round(g.pos[v * 3 + 1] * 1e3)},${Math.round(g.pos[v * 3 + 2] * 1e3)}`;
  const edges = new Map();
  let vol = 0;
  for (const g of mesh.groups.values()) {
    if (g.overlay) continue;
    for (let i = 0; i < g.idx.length; i += 3) {
      const t = [0, 1, 2].map((k) => g.idx[i + k]);
      const K = t.map((v) => key(g, v));
      for (let k = 0; k < 3; k++) { const e = `${K[k]}>${K[(k + 1) % 3]}`; edges.set(e, (edges.get(e) || 0) + 1); }
      const P = t.map((v) => [g.pos[v * 3], g.pos[v * 3 + 1], g.pos[v * 3 + 2]]);
      const [A, B, C] = P;
      vol += (A[0] * (B[1] * C[2] - B[2] * C[1]) - A[1] * (B[0] * C[2] - B[2] * C[0]) + A[2] * (B[0] * C[1] - B[1] * C[0])) / 6;
    }
  }
  // T-junctions split edges: compare the multiset of undirected lengths instead of exact pairs
  let open = 0;
  for (const [e, c] of edges) { const [a, b] = e.split('>'); if ((edges.get(`${b}>${a}`) || 0) !== c) open++; }
  return { open, vol, edges: edges.size };
}

test('ctm: tile selection for all 256 neighbour sets (47 blob), compact, horizontal, vertical, repeat', () => {
  assert.equal(BLOB_MASKS.length, 47);
  const seen = new Set();
  for (let m = 0; m < 256; m++) {
    const k = ctmTileFor(m, 'full');
    assert.equal(BLOB_MASKS[k], blobRef(m), `mask ${m}`);
    seen.add(k);
    // array / object forms agree
    const arr = [...Array(8).keys()].map((i) => !!(m & (1 << i)));
    assert.equal(ctmTileFor(arr, 'full'), k);
    const K = ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'];
    assert.equal(ctmTileFor(Object.fromEntries(K.map((x, i) => [x, arr[i]])), 'full'), k);
    // overlay = blob of the complement
    assert.equal(BLOB_MASKS[ctmTileFor(m, 'overlay')], blobRef(~m & 255));
  }
  assert.equal(seen.size, 47);
  assert.equal(ctmTileFor(0, 'full'), 0);
  assert.equal(BLOB_MASKS[ctmTileFor(255, 'full')], 255);
  // corners only count with both edges
  assert.equal(ctmTileFor(2, 'full'), ctmTileFor(0, 'full'));
  assert.equal(BLOB_MASKS[ctmTileFor(1 | 2 | 4, 'full')], 7);
  // horizontal / vertical / h+v / top
  const W = 64, E = 4, N = 1, S = 16;
  assert.deepEqual([0, W, E, W | E].map((m) => ctmTileFor(m | N | S, 'horizontal')), [0, 1, 2, 3]);
  assert.deepEqual([0, N, S, N | S].map((m) => ctmTileFor(m | W | E, 'vertical')), [0, 1, 2, 3]);
  assert.equal(ctmTileFor(N | E | S | W, 'horizontal+vertical'), 15);
  assert.equal(ctmTileFor(E, 'horizontal+vertical'), 2);
  assert.equal(ctmTileFor(N, 'top'), 0);
  assert.equal(ctmTileFor(S, 'top'), 1);
  // compact quarters [tl, tr, br, bl]: 0 none, 1 all, 2 horizontal, 3 vertical, 4 inner corner
  assert.deepEqual(ctmTileFor(0, 'compact'), [0, 0, 0, 0]);
  assert.deepEqual(ctmTileFor(255, 'compact'), [1, 1, 1, 1]);
  assert.deepEqual(ctmTileFor(N | E | S | W, 'compact'), [4, 4, 4, 4]);
  assert.deepEqual(ctmTileFor(W | E, 'compact'), [2, 2, 2, 2]);
  assert.deepEqual(ctmTileFor(N | S, 'compact'), [3, 3, 3, 3]);
  // repeat: continuous over cells, wraps with negative cells
  const rep = (x, y) => ctmTileFor(0, 'repeat', { cell: [x, y], repeat: [3, 2] });
  assert.deepEqual([-1, 0, 1, 2, 3, 4].map((x) => rep(x, 0)), [2, 0, 1, 2, 0, 1]);
  assert.deepEqual([-1, 0, 1, 2].map((y) => rep(0, y)), [3, 0, 3, 0]);
  // random: deterministic per cell, respects weights
  const r1 = ctmTileFor(0, 'random', { cell: [3, 4, 5], weights: [1, 1, 1] });
  assert.equal(r1, ctmTileFor(0, 'random', { cell: [3, 4, 5], weights: [1, 1, 1] }));
  assert.equal(ctmTileFor(0, 'random', { cell: [3, 4, 5], weights: [0, 1, 0] }), 1);
  const counts = [0, 0];
  for (let x = 0; x < 400; x++) counts[ctmTileFor(0, 'random', { cell: [x, 0], weights: [3, 1] })]++;
  assert.ok(counts[0] > counts[1] * 1.8 && counts[1] > 40, `weights 3:1 -> ${counts}`);
  assert.throws(() => ctmTileFor(0, 'nope'), /unknown CTM method/);
});

test('ctm: generated tilesets (borders where unconnected), compact template -> 47, README reference matches', () => {
  const T = 16, base = { width: T, height: T, data: new Uint8ClampedArray(T * T * 4).fill(200) };
  const border = { width: 2, style: 'line', color: [0, 0, 0, 255] };
  const full = generateCTM({ method: 'full', base, border });
  assert.equal(full.meta.count, 47);
  assert.equal(full.width, 8 * T);
  const px = (img, k, x, y) => { const c = k % img.meta.cols, r = Math.floor(k / img.meta.cols); return img.data[((r * T + y) * img.width + c * T + x) * 4]; };
  for (const [k, m] of BLOB_MASKS.entries()) {
    // edge midpoints: border exactly where the neighbour is missing
    for (const [bit, x, y] of [[1, 8, 0], [4, T - 1, 8], [16, 8, T - 1], [64, 0, 8]]) assert.equal(px(full, k, x, y) === 0, !(m & bit), `tile ${k} mask ${m} bit ${bit}`);
    // inner corner notch when both edges connect but the diagonal does not
    if (m & 1 && m & 4) assert.equal(px(full, k, T - 1, 0) === 0, !(m & 2), `ne notch, mask ${m}`);
    assert.equal(px(full, k, 8, 8), 200); // interior stays base
  }
  // the 5 compact tiles compose every blob tile exactly
  const compact = generateCTM({ method: 'compact', base, border });
  assert.equal(compact.meta.count, 5);
  const tiles = [...Array(5).keys()].map((k) => { const t = new Uint8ClampedArray(T * T * 4); for (let y = 0; y < T; y++) t.set(compact.data.subarray((y * compact.width + k * T) * 4, (y * compact.width + k * T + T) * 4), y * T * 4); return t; });
  for (const [k, m] of BLOB_MASKS.entries()) {
    const c = composeCompact(tiles, m, T);
    for (let y = 0; y < T; y++) for (let x = 0; x < T; x++) assert.equal(c[(y * T + x) * 4], px(full, k, x, y), `compose mask ${m} at ${x},${y}`);
  }
  // hand-drawn compact template -> 47 identical to the generated set
  const fromTpl = generateCTM({ method: 'full', template: { width: 5 * T, height: T, data: compact.data } });
  assert.deepEqual(fromTpl.data, full.data);
  for (const mth of CTM_METHODS.filter((x) => !['random', 'repeat', 'overlay'].includes(x))) assert.equal(generateCTM({ method: mth, base, border }).meta.count, methodMasks(mth).length);
  assert.throws(() => generateCTM({ method: 'full', base, border: { width: 8 } }), /below half/);
  assert.throws(() => generateCTM({ method: 'repeat', base: { width: 20, height: 16, data: new Uint8ClampedArray(20 * 16 * 4) }, tile: 16 }), /multiple/);
  // README copy of the reference selection behaves identically
  const readme = fs.readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  const src = readme.slice(readme.indexOf('function ctmTileFor'), readme.indexOf('```', readme.indexOf('function ctmTileFor')));
  const fn = new Function(`${src}\nreturn ctmTileFor;`)();
  for (let m = 0; m < 256; m++) for (const mth of ['full', 'overlay', 'horizontal', 'vertical', 'horizontal+vertical', 'top']) assert.deepEqual(fn(m, mth), ctmTileFor(m, mth), `${mth} ${m}`);
  for (let m = 0; m < 256; m += 7) assert.deepEqual(fn(m, 'compact'), ctmTileFor(m, 'compact'));
  for (let x = -5; x < 5; x++) {
    assert.equal(fn(0, 'repeat', { cell: [x, 2], repeat: [3, 2] }), ctmTileFor(0, 'repeat', { cell: [x, 2], repeat: [3, 2] }));
    assert.equal(fn(0, 'random', { cell: [x, 2, 9], weights: [2, 1, 1], seed: 4 }), ctmTileFor(0, 'random', { cell: [x, 2, 9], weights: [2, 1, 1], seed: 4 }));
  }
});

test('world UVs: texture continues across offsets, turns, arrays and nested models', () => {
  const e = setup();
  // two walls at an odd offset, touching at x = 39
  let m = build(e, [{ type: 'wall', texture: 'coded', w: 32, h: 64, d: 8, at: [7, 0, 0] }, { type: 'wall', texture: 'coded', w: 32, h: 64, d: 8, at: [39, 0, 0] }]).mesh;
  for (const y of [5.5, 30.5, 60.5]) assert.ok(nextTexel(across(m, [23, y, 4], [1, 0, 0], [0, 0, 1])), `front seam at y ${y}`);
  // back faces too (u runs the other way)
  const back = across(m, [23, 20.5, -4], [-1, 0, 0], [0, 0, -1]);
  assert.ok(nextTexel(back), `back seam ${JSON.stringify(back.map((t) => [t.x, t.y]))}`);
  // array of turned walls along z (turn 1 = facing +x)
  m = build(e, [{ type: 'wall', texture: 'coded', w: 32, h: 64, d: 8, at: [3, 0, 5], turn: 1, array: { count: 3, step: [0, 0, 32] } }]).mesh;
  for (const z of [21, 53]) {
    const pair = across(m, [7, 10.5, z], [0, 0, -1], [1, 0, 0]);
    assert.ok(nextTexel(pair), `turned array seam at z ${z}: ${JSON.stringify(pair.map((t) => [t.x, t.y]))}`);
  }
  // floors: rows in x and z, odd offsets, plus a rotated copy (turn 2) that still lines up
  m = build(e, [{ type: 'floor', texture: 'big', at: [5, 0, 3], array: { count: 2, step: [32, 0, 0] } }, { type: 'floor', texture: 'big', at: [5, 0, 35], turn: 2 }]).mesh;
  assert.ok(nextTexel(across(m, [21, 0, 10.5], [1, 0, 0], [0, 1, 0]), 64), 'floor x seam');
  const zs = across(m, [10.5, 0, 19], [0, 0, 1], [0, 1, 0]);
  assert.ok(zs[1].y === (zs[0].y + 1) % 64 && zs[1].x === zs[0].x, `floor z seam across a turned piece ${JSON.stringify(zs.map((t) => [t.x, t.y]))}`);
  // nested models: a wall model placed twice by another model, odd offset
  const models = { w: { parts: [{ type: 'wall', texture: 'coded', w: 32, h: 64, d: 8 }] } };
  m = build(e, [{ type: 'model', model: 'w', at: [11, 0, 2] }, { type: 'model', model: 'w', at: [43, 0, 2] }], models).mesh;
  assert.ok(nextTexel(across(m, [27, 33.5, 6], [1, 0, 0], [0, 0, 1])), 'nested seam');
  // courses continue around a corner: same texel row on both walls at the same height
  m = build(e, [{ type: 'wall', texture: 'coded', w: 32, h: 64, d: 8, at: [0, 0, 0] }, { type: 'wall', texture: 'coded', w: 32, h: 64, d: 8, at: [20, 0, 12], turn: 1 }]).mesh;
  const a = texelAt(m, [10, 37.5, 4], [0, 0, 1]), b = texelAt(m, [24, 37.5, 20], [1, 0, 0]);
  assert.equal(a.y, b.y, 'courses line up around the corner');
  // instances: per-node meshes get the same world UVs as the baked layout? they stay local, so check extras instead (glb test)
});

test('smooth ruins: polygon outlines are closed, outward, low-poly; arch segments follow size; voxel style kept', () => {
  const e = setup();
  const stats = (parts) => { const m = build(e, parts).mesh; return { ...closed(m), tris: m.triangles, m }; };
  for (const p of [
    { type: 'wall', texture: 'plain', broken: { seed: 3, amount: 24 } },
    { type: 'wall', texture: 'plain', w: 64, holes: 'crack' },
    { type: 'wall', texture: 'plain', broken: true, holes: 'crack' },
    { type: 'floor', texture: 'plain', broken: { seed: 2 } },
    { type: 'arch', texture: 'plain', span: 24, broken: { seed: 9, amount: 18 } },
    { type: 'arch', texture: 'plain', span: 24, holes: 'crack' },
  ]) {
    const s = stats([p]);
    assert.equal(s.open, 0, `${p.type} ${JSON.stringify(p)} is closed (${s.open} open edges)`);
    assert.ok(s.vol > 0, `${p.type} outward volume`);
    assert.ok(s.tris < 600, `${p.type} low-poly (${s.tris} tris)`);
    // smooth: some side faces are not axis-aligned
    let slanted = 0;
    for (const g of s.m.groups.values()) for (const f of g.faces) if (f.n.filter((c) => Math.abs(c) > 0.05).length >= 2) slanted++;
    if (p.broken) assert.ok(slanted > 0, `${p.type} has slanted (non-voxel) edges`);
  }
  // voxel style: every face axis-aligned
  const v = stats([{ type: 'wall', texture: 'plain', broken: { seed: 3 }, style: 'voxel' }]);
  assert.ok(v.vol > 0); // greedy voxels keep T-junctions, so only the volume is checked here
  for (const g of v.m.groups.values()) for (const f of g.faces) assert.equal(f.n.filter((c) => Math.abs(c) > 1e-6).length, 1);
  // arch: bigger arches get more segments, solid stays closed
  const small = stats([{ type: 'arch', texture: 'plain', span: 12 }]), big = stats([{ type: 'arch', texture: 'plain', span: 96, w: 120 }]);
  assert.ok(big.tris > small.tris, `segments scale with size (${small.tris} -> ${big.tris})`);
  assert.ok(big.tris < 400);
  assert.equal(big.open, 0);
  const seg = stats([{ type: 'arch', texture: 'plain', span: 24, segments: 3 }]);
  assert.ok(seg.tris < stats([{ type: 'arch', texture: 'plain', span: 24, segments: 12 }]).tris);
  // poly2d: a square with a square hole
  const f = (x, y) => Math.min(Math.min(x, 10 - x, y, 10 - y), -Math.min(x - 3, 7 - x, y - 3, 7 - y));
  const shapes = nestLoops(contour(f, -1, -1, 12, 12, 1, 1).map((l) => simplifyLoop(l, 0.3)));
  assert.equal(shapes.length, 1);
  assert.equal(shapes[0].holes.length, 1);
  assert.ok(shapes[0].outer.length >= 4 && shapes[0].outer.length <= 6, `simplified to ${shapes[0].outer.length} points`);
  const { tris, pts } = triangulateShape(shapes[0]);
  // a polygon with one hole: n_outer + n_hole triangles, total area ~ 100 - 16
  assert.equal(tris.length, shapes[0].outer.length + shapes[0].holes[0].length);
  const area = tris.reduce((s2, [a, b, c]) => s2 + Math.abs((pts[b][0] - pts[a][0]) * (pts[c][1] - pts[a][1]) - (pts[b][1] - pts[a][1]) * (pts[c][0] - pts[a][0])) / 2, 0);
  assert.ok(Math.abs(area - 84) <= 2, `area ${area}`); // hole corners exactly on the grid may chamfer by half a cell
});

test('overlays: decal shells on TEXCOORD_1 with COLOR_0 strength; bottom/top gradients; glb + instance extras', () => {
  const e = setup();
  const parts = [
    { type: 'wall', texture: 'plain', w: 64, overlays: [{ texture: 'grime', where: 'bottom', falloff: 16, jitter: 0 }, { texture: 'moss', where: 'top', falloff: 8, map: 'face' }] },
  ];
  const r = build(e, parts);
  const ov = [...r.mesh.groups.values()].filter((g) => g.overlay);
  assert.equal(ov.length, 2);
  assert.ok(r.baked.overlay_shells >= 2);
  const grime = ov.find((g) => g.tex.canvas === 'grime');
  // grime: strong at the bottom, gone above the falloff
  let lo = 0, hi = 0;
  for (let i = 0; i < grime.alpha.length; i++) { const y = grime.pos[i * 3 + 1]; if (y < 2) lo = Math.max(lo, grime.alpha[i]); if (y > 20) hi = Math.max(hi, grime.alpha[i]); }
  assert.ok(lo > 0.8 && hi === 0, `bottom gradient (lo ${lo}, hi ${hi})`);
  // world map: overlay UV in its own texel scale
  const i0 = 0, p = [grime.pos[i0 * 3], grime.pos[i0 * 3 + 1], grime.pos[i0 * 3 + 2]];
  assert.equal(grime.uv0.length, grime.uv.length);
  assert.ok(Number.isFinite(grime.uv[0]) && Number.isFinite(p[0]));
  const moss = ov.find((g) => g.tex.canvas === 'moss');
  for (const v of moss.uv) assert.ok(v >= -1e-6 && v <= 1 + 1e-6, 'face map stretches 0..1');
  // export: TEXCOORD_1 + COLOR_0 + texCoord 1 + MASK
  e.run('model_create', { name: 'ovw', parts });
  e.run('model_create', { name: 'lay', parts: [{ type: 'model', model: 'ovw', at: [16, 0, 0] }, { type: 'model', model: 'ovw', at: [80, 0, 0], turn: 1 }] });
  const out = tmp();
  e.run('model_export', { name: 'ovw', path: path.join(out, 'ovw.glb') });
  const json = (f) => { const b = fs.readFileSync(f); const len = b.readUInt32LE(12); return JSON.parse(b.subarray(20, 20 + len).toString('utf8')); };
  const g = json(path.join(out, 'ovw.glb'));
  const prims = g.meshes.flatMap((m) => m.primitives);
  const op = prims.filter((pr) => pr.attributes.TEXCOORD_1 !== undefined);
  assert.equal(op.length, 2);
  for (const pr of op) {
    assert.ok(pr.attributes.COLOR_0 !== undefined);
    assert.equal(g.accessors[pr.attributes.COLOR_0].type, 'VEC4');
    const mat = g.materials[pr.material];
    assert.equal(mat.pbrMetallicRoughness.baseColorTexture.texCoord, 1);
    assert.equal(mat.alphaMode, 'MASK');
  }
  // instances: per-node world offset / rotation in extras
  e.run('model_export', { name: 'lay', path: path.join(out, 'lay.glb'), instances: true });
  const gl = json(path.join(out, 'lay.glb'));
  const inst = gl.nodes.filter((n) => n.extras?.world_offset);
  assert.equal(inst.length, 2);
  assert.deepEqual(inst[0].extras.world_offset, [0.5, 0, 0]);
  assert.equal(inst[0].extras.px_per_unit, 32);
  const q = inst[1].extras.world_rotation; // turn 1 = +90° about Y
  assert.ok(Math.abs(q[1] - Math.SQRT1_2) < 1e-5 && Math.abs(q[3] - Math.SQRT1_2) < 1e-5, `quaternion ${q}`);
});

test('ctm bake: tiles from neighbours across pieces (3x3 floor), walls fold around corners, repeat continuity, export json', () => {
  const e = setup();
  e.run('model_ctm', { name: 'pl_ctm', ctm: { base: 'plain', method: 'full', border: { width: 2, style: 'line', color: '#000' } } });
  const parts = [{ type: 'floor', texture: 'pl_ctm', cell: [0, 0, 0], array: { count: 3, cell_step: [1, 0, 0] } }, { type: 'floor', texture: 'pl_ctm', cell: [0, 0, 1], array: { count: 3, cell_step: [1, 0, 0] } }, { type: 'floor', texture: 'pl_ctm', cell: [0, 0, 2], array: { count: 3, cell_step: [1, 0, 0] } }];
  const r = build(e, parts);
  assert.ok(r.baked.ctm_cells >= 9);
  const tileAt = (m, p, n) => { const t = texelAt(m, p, n); const T = t.tex.ctm.tile; return Math.floor(t.uv[0] * t.tex.width / T) + Math.floor(t.uv[1] * t.tex.height / T) * t.tex.ctm.cols; };
  const up = [0, 1, 0];
  assert.equal(BLOB_MASKS[tileAt(r.mesh, [32, 0, 32], up)], 255, 'centre cell: all neighbours');
  assert.equal(BLOB_MASKS[tileAt(r.mesh, [0, 0, 0], up)], 4 | 8 | 16, 'NW corner cell: E, SE, S');
  assert.equal(BLOB_MASKS[tileAt(r.mesh, [64, 0, 64], up)], 1 | 64 | 128, 'SE corner cell: N, W, NW');
  assert.equal(BLOB_MASKS[tileAt(r.mesh, [32, 0, 0], up)], 4 | 8 | 16 | 32 | 64, 'N edge cell');
  // remove the centre: inner corners appear around it
  const holed = build(e, [...parts.slice(0, 1), { type: 'floor', texture: 'pl_ctm', cell: [0, 0, 1] }, { type: 'floor', texture: 'pl_ctm', cell: [2, 0, 1] }, parts[2]]);
  assert.equal(BLOB_MASKS[tileAt(holed.mesh, [32, 0, 0], up)], 4 | 64, 'N edge cell above a hole: only E and W');
  // tag connect: two rooms side by side do not connect
  e.run('model_ctm', { name: 'tag_ctm', ctm: { base: 'plain', method: 'full', connect: 'tag', border: { width: 2 } } });
  const rooms = build(e, [{ type: 'floor', texture: 'tag_ctm', cell: [0, 0, 0], ctm_tag: 'hall' }, { type: 'floor', texture: 'tag_ctm', cell: [1, 0, 0], ctm_tag: 'chapel' }, { type: 'floor', texture: 'tag_ctm', cell: [2, 0, 0], ctm_tag: 'chapel' }]);
  assert.equal(BLOB_MASKS[tileAt(rooms.mesh, [0, 0, 0], up)], 0);
  assert.equal(BLOB_MASKS[tileAt(rooms.mesh, [32, 0, 0], up)], 4);
  // horizontal trim on walls meeting at a corner: the run continues around it (no end caps there)
  e.run('model_ctm', { name: 'trim', ctm: { base: 'plain', method: 'horizontal', border: { width: 2 } } });
  const walls = build(e, [{ type: 'wall', texture: 'trim', w: 64, h: 32, d: 8, at: [16, 0, 0] }, { type: 'wall', texture: 'trim', w: 64, h: 32, d: 8, at: [52, 0, 28], turn: 1 }]);
  // front wall (faces +z) right end meets the side wall face (+x) at x = 48 (+d/2 = 52)
  const endFront = tileAt(walls.mesh, [44, 16, 4], [0, 0, 1]);
  assert.equal(endFront & 2, 2, `front run continues east around the corner (tile ${endFront})`);
  // the far end is capped (no fold around the piece's own end face)
  assert.equal(tileAt(walls.mesh, [-12, 16, 4], [0, 0, 1]) & 1, 0);
  assert.equal(tileAt(walls.mesh, [56, 16, 56], [1, 0, 0]) & 1, 0);
  // repeat: one 64x64 pattern over 2x2 cells continues texel by texel across pieces
  e.run('model_ctm', { name: 'big_rep', ctm: { base: 'big', method: 'repeat', tile: 32 } });
  const rp = build(e, [{ type: 'floor', texture: 'big_rep', cell: [0, 0, 0], array: { count: 4, cell_step: [1, 0, 0] } }]);
  const code = (t) => { const p = (t.y * t.tex.width + t.x) * 4; return [t.tex.data[p] / 4, t.tex.data[p + 1] / 4]; };
  for (const x of [16, 48, 80]) {
    const [a, b] = across(rp.mesh, [x, 0, 5.5], [1, 0, 0], up).map(code);
    assert.equal(b[0], (a[0] + 1) % 64, `repeat continues at x ${x}: ${a} -> ${b}`);
    assert.equal(a[1], b[1]);
  }
  // export: .ctm.json + tileset png next to the glb
  e.run('model_create', { name: 'hall', parts });
  const out = tmp();
  const x = e.run('model_export', { name: 'hall', path: path.join(out, 'hall.glb') });
  assert.ok(fs.existsSync(x.ctm));
  const cj = JSON.parse(fs.readFileSync(x.ctm, 'utf8'));
  assert.equal(cj.tilesets.pl_ctm.method, 'full');
  assert.equal(cj.tilesets.pl_ctm.masks.length, 47);
  assert.ok(fs.existsSync(path.join(out, 'pl_ctm.png')));
  assert.throws(() => e.run('model_ctm', { name: 'pl_ctm', ctm: { base: 'plain' } }), /exists/);
  assert.throws(() => e.run('model_ctm', { name: 'zz', ctm: { base: 'plain', method: 'bogus' } }), /method must be/);
});

test('ctm diorama: CTM floor + wall corner + overlays render in the game view; overlay ctm creeps from a neighbour', () => {
  const e = setup();
  e.run('model_ctm', { name: 'm_ctm', ctm: { base: 'plain', method: 'full', border: { width: 2, style: 'bevel' } } });
  e.run('model_ctm', { name: 'moss_ctm', ctm: { overlay: 'moss', method: 'overlay', from: 'grass' } });
  const ov = [{ texture: 'grime', where: ['bottom', 'corners'], falloff: 16 }, { texture: 'moss', where: 'top', falloff: 8 }];
  e.run('model_create', { name: 'dio', parts: [
    { type: 'floor', texture: 'm_ctm', cell: [0, 0, 0], array: { count: 3, cell_step: [1, 0, 0] } },
    { type: 'floor', texture: 'm_ctm', cell: [0, 0, 1], array: { count: 2, cell_step: [1, 0, 0] }, overlays: [{ texture: 'moss_ctm', from: 'grass' }] },
    { type: 'floor', texture: 'grass', cell: [2, 0, 1] },
    { type: 'wall', texture: 'coded', at: [0, 0, -20], array: { count: 3, step: [32, 0, 0] }, overlays: ov },
    { type: 'wall', texture: 'coded', at: [84, 0, 12], turn: 1, w: 56, overlays: ov },
  ] });
  const info = e.run('model_info', { name: 'dio' });
  assert.ok(info.baked.ctm_cells > 5 && info.baked.overlay_shells > 5, JSON.stringify(info.baked));
  assert.ok(info.materials.some((m) => m.startsWith('overlay:moss_ctm')), 'moss creeps onto the marble next to the grass');
  const t0 = performance.now();
  const p = e.run('model_preview', { name: 'dio', views: ['game'], size: 256 });
  const ms = performance.now() - t0;
  assert.ok(p.views[0].pixels > 256 * 256 * 0.15, `game view drawn (${p.views[0].pixels} px)`);
  assert.ok(ms < 3000, `preview ${ms.toFixed(0)} ms`);
  assert.ok(p.triangles < 6000, `${p.triangles} tris`);
});

test('finalize can be applied to a hand-built mesh (Mesh API)', () => {
  const tex = { key: 'k', canvas: 'k', width: 32, height: 32, data: new Uint8ClampedArray(32 * 32 * 4) };
  const ctx = { tex: () => tex };
  const m = new Mesh();
  for (let i = 0; i < 2; i++) m.add(BUILDERS.wall({ texture: 'k' }, ctx).transform(mT(i * 32 + 5, 0, 0)));
  const res = finalize(m, ctx, [0, 0, 0]);
  assert.deepEqual(res, { ctm_cells: 0, overlay_shells: 0 });
  assert.ok(nextTexel(across(m, [21, 3.5, 4], [1, 0, 0], [0, 0, 1])));
});
