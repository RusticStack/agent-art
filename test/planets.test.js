// art_planet (0.8): planets, cube-sphere LODs + quadtree tiles, equirect / cube maps, ground terrain,
// splat maps, instanced scatter, skyboxes, asteroid fields, FX. Every glb goes through a validator,
// every PNG through the 1024 px limit, and plain art_model exports stay byte-identical.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { Engine } from '../src/engine.js';
import { decodePNG } from '../src/png.js';
import { TOOLS } from '../src/mcp.js';
import { SKILLS } from '../src/skills.js';
import { helpText } from '../src/docs.js';
import { normPlanet, bakeEquirect, bakeFace, cubeSphere, facePatch, tileSkirt, heightAt, elevKm, dirToEquirect, equirectDir } from '../src/space/planet.js';
import { cubeDir, dirToCube, cubePoint, vnorm } from '../src/space/noise.js';
import { normTerrain, patchHeight, buildTerrain, splatWeights, latLonDir, localFrame } from '../src/space/terrain.js';
import { normSky, bakeSkyFaces, bakeSkyEquirect, skyGas } from '../src/space/skybox.js';
import { generateSystem } from '../src/space/ops.js';
import { mulberry32 } from '../src/util.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'agent-art-planet-'));
const tex1 = { key: 't', name: 't', width: 1, height: 1, data: Uint8ClampedArray.from([128, 128, 128, 255]) };

/** Parse + validate a .glb: chunks, bufferViews, accessors (bounds, min/max), primitives, textures, GPU instancing. -> {json, read} */
function validateGLB(file) {
  const buf = fs.readFileSync(file);
  assert.equal(buf.readUInt32LE(0), 0x46546c67, 'glTF magic');
  assert.equal(buf.readUInt32LE(4), 2, 'glTF version 2');
  assert.equal(buf.readUInt32LE(8), buf.length, 'total length');
  const jlen = buf.readUInt32LE(12);
  assert.equal(buf.readUInt32LE(16), 0x4e4f534a, 'JSON chunk');
  const json = JSON.parse(buf.toString('utf8', 20, 20 + jlen));
  const bo = 20 + jlen, blen = buf.readUInt32LE(bo);
  assert.equal(buf.readUInt32LE(bo + 4), 0x004e4942, 'BIN chunk');
  assert.equal(bo + 8 + blen, buf.length);
  assert.equal(json.buffers[0].byteLength, blen);
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
  for (const m of json.meshes) for (const p of m.primitives) {
    const n = json.accessors[p.attributes.POSITION].count;
    for (const [k, ai] of Object.entries(p.attributes)) assert.equal(json.accessors[ai].count, n, `${k} count`);
    const idx = read(p.indices);
    assert.equal(idx.length % 3, 0, 'triangle list');
    for (const i of idx) assert.ok(i < n, 'index in range');
    const nr = read(p.attributes.NORMAL);
    for (let i = 0; i < nr.length; i += 3) assert.ok(Math.abs(Math.hypot(nr[i], nr[i + 1], nr[i + 2]) - 1) < 1e-3, 'unit normals');
    const mat = json.materials[p.material];
    assert.ok(mat, 'material');
    for (const t of [mat.pbrMetallicRoughness.baseColorTexture, mat.pbrMetallicRoughness.metallicRoughnessTexture, mat.normalTexture, mat.emissiveTexture]) if (t) {
      const tx = json.textures[t.index];
      assert.ok(tx, 'texture index');
      const im = json.images[tx.source], v = json.bufferViews[im.bufferView];
      const png = decodePNG(Buffer.from(bin.subarray(v.byteOffset, v.byteOffset + v.byteLength)));
      assert.ok(png.width <= 1024 && png.height <= 1024, 'embedded texture <= 1024 px');
    }
  }
  for (const s of json.samplers) assert.equal(s.magFilter, 9728, 'NEAREST');
  for (const n of json.nodes) {
    if (n.mesh !== undefined) assert.ok(json.meshes[n.mesh], 'node mesh');
    for (const c of n.children || []) assert.ok(json.nodes[c], 'child node');
    const g = n.extensions?.EXT_mesh_gpu_instancing;
    if (g) {
      assert.ok(json.extensionsUsed.includes('EXT_mesh_gpu_instancing'));
      const counts = Object.values(g.attributes).map((ai) => json.accessors[ai].count);
      assert.ok(counts.every((c) => c === counts[0]), 'instancing attribute counts agree');
      const q = read(g.attributes.ROTATION);
      for (let i = 0; i < q.length; i += 4) assert.ok(Math.abs(Math.hypot(q[i], q[i + 1], q[i + 2], q[i + 3]) - 1) < 1e-3, 'unit quaternions');
    }
  }
  return { json, read };
}
const pngSize = (f) => { const b = fs.readFileSync(f); return [b.readUInt32BE(16), b.readUInt32BE(20)]; };
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));

test('planet: seed determinism (maps, heights, terrain, sky, system)', () => {
  const a = bakeEquirect(normPlanet({ preset: 'bloom', seed: 5 }), 64), b = bakeEquirect(normPlanet({ preset: 'bloom', seed: 5 }), 64), c = bakeEquirect(normPlanet({ preset: 'bloom', seed: 6 }), 64);
  assert.deepEqual(a.albedo, b.albedo);
  assert.deepEqual(a.heightKm, b.heightKm);
  assert.deepEqual(a.normal, b.normal);
  assert.notDeepEqual(a.albedo, c.albedo);
  const P = normPlanet({ preset: 'desert', seed: 2 }), t = normTerrain(P, { size: 128, grid: 32, chunks: 2 });
  assert.deepEqual(buildTerrain(P, t).heights, buildTerrain(normPlanet({ preset: 'desert', seed: 2 }), t).heights);
  const s1 = bakeSkyFaces(normSky({ seed: 3 }), 32), s2 = bakeSkyFaces(normSky({ seed: 3 }), 32);
  s1.faces.forEach((f, i) => assert.deepEqual(f, s2.faces[i]));
  assert.deepEqual(generateSystem({ seed: 9 }), generateSystem({ seed: 9 }));
});

test('cube-sphere: every LOD is watertight (no cracks between faces), shared vertices match bit for bit', () => {
  const P = normPlanet({ preset: 'barren', seed: 3 });
  for (const segs of [12, 6, 3]) {
    const gs = cubeSphere(P, segs, Array(6).fill(tex1));
    const key = (g, i) => `${g.pos[i * 3]},${g.pos[i * 3 + 1]},${g.pos[i * 3 + 2]}`;
    const edges = new Map(), nrm = new Map();
    let triCount = 0;
    for (const g of gs) {
      for (let i = 0; i < g.pos.length / 3; i++) {
        const k = key(g, i), n = [g.nrm[i * 3], g.nrm[i * 3 + 1], g.nrm[i * 3 + 2]].join(',');
        if (nrm.has(k)) assert.equal(nrm.get(k), n, 'shared vertex normals identical'); else nrm.set(k, n);
      }
      for (let t = 0; t < g.idx.length; t += 3) {
        triCount++;
        const v = [0, 1, 2].map((j) => key(g, g.idx[t + j]));
        for (let j = 0; j < 3; j++) { const e = [v[j], v[(j + 1) % 3]].sort().join('|'); edges.set(e, (edges.get(e) || 0) + 1); }
        // outward winding
        const p = [0, 1, 2].map((j) => [g.pos[g.idx[t + j] * 3], g.pos[g.idx[t + j] * 3 + 1], g.pos[g.idx[t + j] * 3 + 2]]);
        const e1 = p[1].map((x, k) => x - p[0][k]), e2 = p[2].map((x, k) => x - p[0][k]);
        const cr = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
        assert.ok(cr[0] * p[0][0] + cr[1] * p[0][1] + cr[2] * p[0][2] > 0, 'outward triangle');
      }
    }
    assert.equal(triCount, 12 * segs * segs);
    for (const [e, c] of edges) assert.equal(c, 2, `edge ${e} used ${c}x at ${segs} segs (crack)`);
    // closed genus-0 surface: V - E + F = 2
    assert.equal(nrm.size - edges.size + triCount, 2);
  }
});

test('quadtree tiles: equal-level tiles share edges exactly (also across faces); skirts cover the gap to a coarser neighbour', () => {
  const P = normPlanet({ preset: 'desert', seed: 4 }), n = 8;
  const grid = (g) => (i, j) => [g.pos[(j * (n + 1) + i) * 3], g.pos[(j * (n + 1) + i) * 3 + 1], g.pos[(j * (n + 1) + i) * 3 + 2]];
  // same level, across a cube edge: face 4 (pz) right edge == face 0 (px) left edge, vertex for vertex
  for (const L of [0, 2]) {
    const k = 1 << L, A = grid(facePatch(P, tex1, 4, (k - 1) * n, 0, n, n << L)), B = grid(facePatch(P, tex1, 0, 0, 0, n, n << L));
    for (let j = 0; j <= n; j++) assert.deepEqual(A(n, j), B(0, j));
  }
  // same level, same face: neighbours share the edge
  const L1 = grid(facePatch(P, tex1, 2, 0, 0, n, 2 * n)), R1 = grid(facePatch(P, tex1, 2, n, 0, n, 2 * n));
  for (let j = 0; j <= n; j++) assert.deepEqual(L1(n, j), R1(0, j));
  // one level apart: coarse (face 4, L1, 0_0) right edge vs fine (L2, 2_0 and 2_1) left edges
  const C = grid(facePatch(P, tex1, 4, 0, 0, n, n << 1));
  const coarse = Array.from({ length: n + 1 }, (_, j) => C(n, j));
  const gapTo = (p) => {
    let best = Infinity;
    for (let q = 0; q < n; q++) {
      const a = coarse[q], b = coarse[q + 1], ab = b.map((v, i) => v - a[i]), ap = p.map((v, i) => v - a[i]);
      const t = Math.max(0, Math.min(1, (ab[0] * ap[0] + ab[1] * ap[1] + ab[2] * ap[2]) / (ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2)));
      best = Math.min(best, Math.hypot(...ap.map((v, i) => v - ab[i] * t)));
    }
    return best;
  };
  const sc = tileSkirt(P, 4, 1, 0, 0, n);
  let worst = 0;
  for (const y of [0, 1]) {
    const F = grid(facePatch(P, tex1, 4, 2 * n, y * n, n, n << 2)), sf = tileSkirt(P, 4, 2, 2, y, n);
    for (let j = 0; j <= n; j++) { const g = gapTo(F(0, j)); worst = Math.max(worst, g); assert.ok(g <= Math.min(sc, sf), `gap ${g} > skirt ${Math.min(sc, sf)}`); }
    if (y === 0) assert.ok(gapTo(F(0, 0)) < 1e-9, 'shared corner');
  }
  assert.ok(worst > 0, 'the levels really differ (skirts are needed)');
  // a skirted tile has its 4 skirt strips: (n+1)^2 grid + 4 (n+1) skirt vertices, 2n^2 + 8n triangles
  const sk = facePatch(P, tex1, 4, 0, 0, n, n, { skirt: sc });
  assert.equal(sk.pos.length / 3, (n + 1) ** 2 + 4 * (n + 1));
  assert.equal(sk.idx.length / 3, 2 * n * n + 8 * n);
});

test('equirect and cube maps agree (same field, both projections)', () => {
  // projection round trips
  const r = mulberry32(1);
  for (let i = 0; i < 200; i++) {
    const d = vnorm([r() - 0.5, r() - 0.5, r() - 0.5]);
    const c = dirToCube(d), d2 = cubeDir(c.face, c.s, c.t);
    assert.ok(Math.hypot(d[0] - d2[0], d[1] - d2[1], d[2] - d2[2]) < 1e-9, 'cube round trip');
    const [u, v] = dirToEquirect(d), d3 = equirectDir(u, v);
    assert.ok(Math.hypot(d[0] - d3[0], d[1] - d3[1], d[2] - d3[2]) < 1e-9, 'equirect round trip');
  }
  const P = normPlanet({ preset: 'ice', seed: 8, dither: false }), W = 512, eq = bakeEquirect(P, W), S = 64;
  let lo = Infinity, hi = -Infinity;
  for (const v of eq.heightKm) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
  let err = 0, n = 0, same = 0;
  for (let f = 0; f < 6; f++) {
    const m = bakeFace(P, f, S);
    for (let y = 0; y < S; y += 3) for (let x = 0; x < S; x += 3) {
      const d = vnorm(cubePoint(f, (2 * (x + 0.5)) / S - 1, (2 * (y + 0.5)) / S - 1)), [u, v] = dirToEquirect(d);
      const ex = Math.min(W - 1, Math.floor(u * W)), ey = Math.min(W / 2 - 1, Math.floor((1 - v) * (W / 2)));
      err += Math.abs(m.heightKm[y * S + x] - eq.heightKm[ey * W + ex]); n++;
      const a = (y * S + x) * 4, b = (ey * W + ex) * 4;
      if (Math.abs(m.albedo[a] - eq.albedo[b]) + Math.abs(m.albedo[a + 1] - eq.albedo[b + 1]) + Math.abs(m.albedo[a + 2] - eq.albedo[b + 2]) < 60) same++;
      // the exact field value at the texel direction is the face value
      if (x === 0 && y === 0) assert.ok(Math.abs(m.heightKm[0] - elevKm(P, d)) < 1e-4);
    }
  }
  assert.ok(err / n < 0.03 * (hi - lo), `mean height gap ${err / n} km`);
  assert.ok(same / n > 0.8, `albedo agreement ${same / n}`);
  // sky: equirect gas field vs cube faces
  const sky = normSky({ seed: 2, dither: false, stars: { count: 0 } }), sf = bakeSkyFaces(sky, 64), se = bakeSkyEquirect(sky, 256, 64);
  let sd = 0, sn = 0;
  for (let f = 0; f < 6; f++) for (let y = 2; y < 64; y += 6) for (let x = 2; x < 64; x += 6) {
    const d = vnorm(cubePoint(f, (2 * (x + 0.5)) / 64 - 1, (2 * (y + 0.5)) / 64 - 1)), [u, v] = dirToEquirect(d);
    const b = (Math.min(127, Math.floor((1 - v) * 128)) * 256 + Math.min(255, Math.floor(u * 256))) * 4, a = (y * 64 + x) * 4;
    for (let k = 0; k < 3; k++) sd += Math.abs(sf.faces[f][a + k] - se[b + k]);
    sn += 3;
    assert.ok(skyGas(sky, d).every(Number.isFinite));
  }
  assert.ok(sd / sn < 12, `sky mean channel gap ${sd / sn}`);
});

test('terrain: patch heights come from the planet field at the sample point', () => {
  const P = normPlanet({ preset: 'desert', seed: 4 });
  const t = normTerrain(P, { lat: 18, lon: -40, size: 512, grid: 64, chunks: 2, detail: { amplitude: 0 }, mesas: 0, cliffs: 0 });
  const H = patchHeight(P, t), d0 = latLonDir(18, -40);
  assert.ok(Math.abs(H.base - elevKm(P, d0) * 1000) < 1e-6, 'base elevation = planet elevation at lat/lon');
  assert.ok(Math.abs(H.at(0, 0)) < 1e-6, 'patch centre at 0');
  // off-centre: (bilinear coarse sampling of the) planet field
  for (const [x, z] of [[100, -60], [-200, 180], [250, 250]]) {
    const exact = elevKm(P, H.dir(x, z)) * 1000 - H.base;
    assert.ok(Math.abs(H.at(x, z) - exact) < 0.5, `height gap ${H.at(x, z) - exact} m at ${x},${z}`);
  }
  // the orbit map shows the same elevation (within one texel of the 1024 equirect)
  const eq = bakeEquirect(P, 256), [u, v] = dirToEquirect(d0);
  const e = eq.heightKm[Math.floor((1 - v) * 128) * 256 + Math.floor(u * 256)] * 1000;
  assert.ok(Math.abs(e - H.base) < 0.06 * P.relief_km * 1000, `orbit map ${e} vs ground ${H.base}`);
  assert.equal(heightAt(P, d0), heightAt(P, latLonDir(18, -40)));
  // with detail on, the difference is bounded by the detail amplitude
  const t2 = normTerrain(P, { lat: 18, lon: -40, size: 512, grid: 64, chunks: 2, mesas: 0, cliffs: 0 }), H2 = patchHeight(P, t2);
  assert.ok(Math.abs(H2.at(120, 40) - H2.planet(120, 40)) <= t2.detail.amplitude * 1.4 + 1e-9);
});

test('terrain: the patch frame (+X east, +Y up, +Z south) is right-handed, so it places rigidly on the planet', () => {
  for (const [lat, lon] of [[18, -40], [-60, 170], [89.9, 0], [0, 0]]) {
    const F = localFrame(latLonDir(lat, lon)), s = F.north.map((v) => -v);
    const c = [F.east[1] * F.up[2] - F.east[2] * F.up[1], F.east[2] * F.up[0] - F.east[0] * F.up[2], F.east[0] * F.up[1] - F.east[1] * F.up[0]];
    assert.ok(Math.abs(c[0] * s[0] + c[1] * s[1] + c[2] * s[2] - 1) < 1e-9, `det [east, up, south] at ${lat}, ${lon}`);
    assert.ok(Math.abs(F.east[0] * F.north[0] + F.east[1] * F.north[1] + F.east[2] * F.north[2]) < 1e-9, 'east _|_ north');
  }
});

test('terrain: splat weights always sum to 255', () => {
  const r = mulberry32(4);
  for (let i = 0; i < 2000; i++) {
    const w = splatWeights(r() * 2, r(), r());
    assert.equal(w.reduce((a, b) => a + b, 0), 255);
    assert.ok(w.every((v) => Number.isInteger(v) && v >= 0));
  }
  assert.deepEqual(splatWeights(0, 0.5, 0), [255, 0, 0, 0]);
  assert.equal(splatWeights(5, 0.5, 0)[1], 255);
});

test('art_planet ops: files, glb validity, texture limits, scatter counts, anchors', () => {
  const home = tmp(), e = new Engine({ home });
  const p = e.run('planet_create', { name: 'kethra', preset: 'bloom', seed: 7, equirect: 128, face: 32, lods: [8, 4, 2], tiles: { levels: 1, segments: 4, px: 16 } });
  assert.ok(Buffer.isBuffer(p.image));
  assert.deepEqual(p.lods.map((l) => l.triangles), [768, 192, 48]);
  assert.ok(p.lods[1].distance > 0 && p.lods[2].distance >= p.lods[1].distance);
  const dir = p.dir, meta = JSON.parse(fs.readFileSync(path.join(dir, 'kethra.planet.json'), 'utf8'));
  for (const k of ['albedo', 'height', 'height16', 'normal', 'roughness', 'clouds', 'night']) assert.ok(fs.existsSync(path.join(dir, meta.equirect.files[k])), k);
  assert.ok(meta.atmosphere.shell_radius > meta.radius);
  const g = validateGLB(path.join(dir, 'kethra.glb'));
  for (const n of ['kethra', 'kethra_lods', 'kethra_LOD0', 'kethra_LOD2', 'kethra_clouds', 'kethra_atmosphere']) assert.ok(g.json.nodes.some((x) => x.name === n), n);
  assert.ok(g.json.nodes.find((x) => x.name === 'kethra_atmosphere').extras.atmosphere.density > 0);
  const tiles = JSON.parse(fs.readFileSync(path.join(dir, 'kethra.tiles.json'), 'utf8'));
  assert.equal(tiles.tiles.length, 6 * 5);
  for (const t of tiles.tiles) { validateGLB(path.join(dir, t.file)); for (const c of t.children) assert.ok(tiles.tiles.some((x) => x.id === c)); }
  assert.ok(tiles.tiles.filter((t) => t.level === 1).every((t) => t.error <= tiles.tiles.find((x) => x.id === `${t.face}/0/0_0`).error + 1e-9));
  // gas giant with rings
  const gg = e.run('planet_create', { name: 'gg', preset: 'gas', seed: 1, equirect: 128, face: 32, lods: [6, 3], tiles: false });
  const gj = validateGLB(path.join(gg.dir, 'gg.glb')).json;
  const ring = gj.nodes.find((x) => x.name === 'gg_rings');
  assert.ok(ring && ring.extras.rings.outer > ring.extras.rings.inner);
  assert.equal(gj.materials[gj.meshes[ring.mesh].primitives[0].material].alphaMode, 'BLEND');
  // terrain from the stored planet
  const t = e.run('planet_terrain', { planet: 'kethra', lat: 10, lon: 20, size: 256, grid: 32, chunks: 2, rocks: 30, grass: 40, crystals: 5, arches: 1 });
  const td = t.dir, tm = JSON.parse(fs.readFileSync(path.join(td, 'kethra_lz.terrain.json'), 'utf8'));
  assert.equal(tm.chunk_files.length, 4);
  for (const c of tm.chunk_files) {
    const cj = validateGLB(path.join(td, c.file)).json;
    assert.ok(cj.nodes.some((n) => n.extras?.collision));
    assert.equal(cj.nodes.find((n) => n.extras?.lod_group).children.length, 3);
  }
  const hf = JSON.parse(fs.readFileSync(path.join(td, 'kethra_lz.heightfield.json'), 'utf8'));
  assert.equal(hf.heights.length, 33 * 33);
  assert.ok(tm.anchors.some((a) => a.kind === 'landing_pad'));
  // instanced scatter count: requested == placed == glb instancing accessors
  const sc = JSON.parse(fs.readFileSync(path.join(td, 'kethra_lz.scatter.json'), 'utf8'));
  const pj = validateGLB(path.join(td, 'kethra_lz_props.glb')).json;
  for (const [kind, want] of [['rocks', 30], ['grass', 40], ['crystals', 5]]) {
    assert.equal(sc.kinds[kind].requested, want);
    assert.equal(sc.kinds[kind].placed, want, `${kind} placed`);
    const inGlb = pj.nodes.filter((n) => n.extras?.scatter === kind).reduce((s, n) => s + pj.accessors[n.extensions.EXT_mesh_gpu_instancing.attributes.TRANSLATION].count, 0);
    assert.equal(inGlb, want, `${kind} instances in glb`);
  }
  const splat = decodePNG(fs.readFileSync(path.join(td, 'kethra_lz_splat.png')));
  for (let i = 0; i < splat.data.length; i += 4) assert.equal(splat.data[i] + splat.data[i + 1] + splat.data[i + 2] + splat.data[i + 3], 255);
  // kits, sky, fx
  const rk = e.run('planet_rocks', { planet: 'kethra', kinds: ['boulder', 'shard', 'crystal', 'grass', 'mesa', 'arch'], variants: 1 });
  validateGLB(rk.glb);
  const ast = e.run('planet_asteroids', { field: { count: 120 } });
  assert.equal(ast.instances, 120);
  const aj = validateGLB(path.join(ast.dir, 'asteroids_field.glb')).json;
  assert.equal(aj.nodes.filter((n) => n.extras?.lod === 0).reduce((s, n) => s + n.extras.count, 0), 120);
  validateGLB(path.join(ast.dir, 'asteroids_kit.glb'));
  e.run('planet_skybox', { size: 64 });
  e.run('planet_fx', {});
  const sys = e.run('planet_system', { seed: 2, count: 8, cell: 48 });
  assert.equal(sys.bodies.length, 8);
  assert.equal(new Set(sys.bodies.filter((b) => b.kind === 'planet').map((b) => b.preset)).size, 6);
  // texture limit on every game texture written (the system strip is an overview image)
  for (const f of walk(path.join(home, 'exports')).filter((f) => f.endsWith('.png') && !f.endsWith('_strip.png'))) {
    const [w, h] = pngSize(f);
    assert.ok(w <= 1024 && h <= 1024, `${path.basename(f)} is ${w}x${h}`);
  }
  assert.throws(() => e.run('planet_create', { name: 'big', preset: 'ice', equirect: 2048 }), /1024/);
  assert.throws(() => e.run('planet_terrain', { planet: 'gg' }), /gas giant/);
  assert.throws(() => e.run('planet_terrain', { planet: 'nope' }), /No planet "nope"/);
  assert.throws(() => e.run('planet_create', { name: 'x', preset: 'plasma' }), /preset must be one of/);
  // bad numbers fail fast with a readable message (no NaN output, no huge render before the size check)
  const lz = { planet: 'kethra', grid: 32, chunks: 2, preview_size: 32 };
  for (const [op, a, re] of [
    ['planet_terrain', { ...lz, lon: 'abc' }, /lon/], ['planet_terrain', { ...lz, grid: 0, chunks: 1 }, /grid/], ['planet_terrain', { ...lz, grid: -8 }, /grid/],
    ['planet_terrain', { ...lz, detail: { wavelength: 0 } }, /detail/], ['planet_terrain', { ...lz, skirt: 'x' }, /skirt/], ['planet_terrain', { ...lz, tile_px: 100000 }, /tile_px/],
    ['planet_terrain', { ...lz, preview_size: 50000 }, /preview_size/], ['planet_create', { name: 'x', preset: 'desert', preview_size: 50000 }, /preview_size/],
    ['planet_create', { name: 'x', preset: 'desert', real_radius_km: 0 }, /real_radius_km/], ['planet_create', { name: 'x', preset: 'desert', hue: 'x' }, /hue/],
    ['planet_asteroids', { field: { count: 10, inner: 'x' } }, /inner/], ['planet_asteroids', { field: { count: 10, size: 5 } }, /field.size/], ['planet_asteroids', { field: { count: 10 }, preview_size: 1e5 }, /preview_size/],
    ['planet_system', { count: 4, cell: 0 }, /cell/], ['planet_skybox', { size: 16, stars: { count: 1e9 } }, /stars/],
  ]) assert.throws(() => e.run(op, a), re, `${op} ${JSON.stringify(a)}`);
});

test('existing exports stay byte-identical (no art_planet features used)', () => {
  const e = new Engine({ home: tmp() });
  e.run('create', { name: 'stone', width: 16 });
  e.run('draw', { canvas: 'stone', commands: [{ op: 'noise', colors: ['#555', '#777', '#999'], seed: 2 }] });
  e.run('model_create', { name: 'kit', parts: [{ type: 'floor', w: 64, d: 64, texture: 'stone' }, { type: 'wall', w: 64, h: 64, d: 8, texture: 'stone', at: [0, 0, -28] }, { type: 'cylinder', r: 8, h: 40, texture: 'stone', at: [20, 0, 0] }] });
  e.run('model_create', { name: 'prop', origin: 'bottom', parts: [{ type: 'box', w: 20, h: 10, d: 30, texture: 'stone', bevel: 2 }, { type: 'cylinder', r: 6, h: 12, texture: 'stone', at: [0, 10, 0] }, { type: 'wedge', w: 10, h: 6, d: 10, texture: 'stone', at: [0, 22, 0] }] });
  const h = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
  // hashes recorded on main (8567dbc) before art_planet existed
  const want = {
    'kit.glb': '7360574e569704c71434ea75b92d6cd17689446683b0c21354b44ef59273e9d3',
    'prop.glb': '282396abb22d99aa023f610fb7a4d197a64a9760bd56c880051d9921008c70ec',
    'kit_i.glb': '7360574e569704c71434ea75b92d6cd17689446683b0c21354b44ef59273e9d3',
    'prop_l.glb': '78c2b0381f6495437a51c532fdad031ae7cf2273ddfea8f49aa6b5b9750921c2',
  };
  for (const [n, a] of [['kit', {}], ['prop', {}], ['kit', { instances: true, path: 'kit_i.glb' }], ['prop', { lods: [1, 0.5], path: 'prop_l.glb' }]]) {
    const r = e.run('model_export', { name: n, ...a });
    assert.equal(h(r.file), want[path.basename(r.file)], path.basename(r.file));
  }
});

test('art_planet is wired into MCP, help and skills', () => {
  const t = TOOLS.find((x) => x.name === 'art_planet');
  assert.ok(t);
  assert.deepEqual(t.inputSchema.properties.action.enum, ['planet', 'system', 'terrain', 'rocks', 'asteroids', 'skybox', 'fx', 'info']);
  assert.match(helpText({ topic: 'planets' }), /PLANETS AND SPACE/);
  assert.match(SKILLS['planets-space'].body, /ShaderMaterial/);
  assert.match(SKILLS['planets-space'].body, /tiles\.json/);
  const e = new Engine({ home: tmp() });
  assert.ok(e.run('planet_info', {}).planet_presets.gas);
});
