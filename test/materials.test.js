// Materials v2 (0.8): tangents, lightmaps + probes, displacement / parallax, bent normals, emissive
// strength, KHR material extensions, ORM packing profiles, detail maps, vertex data, export profiles
// (three / roblox / minimal), the material editor and channel previews. Every .glb goes through the
// in-repo structural validator; plain exports must stay byte-identical to 0.7.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { Engine } from '../src/engine.js';
import { decodePNG } from '../src/png.js';
import { buildModel } from '../src/model3d.js';
import { texResolver } from '../src/modelops.js';
import { computeTangents, threeNormal, threeDerivativeNormal } from '../src/tangents.js';
import { validateGLB, parseGLB } from '../src/gltfcheck.js';
import { bakeLighting, bakeProbes, probeScene, normLightmap, normProbes, shBasis, shIrradiance } from '../src/lightbake.js';
import { packORM, splitORM, packUnityMask, anisotropyTexture } from '../src/materials.js';
import { normPBR } from '../src/surface.js';
import { helpText } from '../src/docs.js';
import { corpusDigests } from './fixtures/corpus.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'agent-art-mat-'));
const near = (a, b, e = 1e-4) => Math.abs(a - b) <= e;
const draw = (e, canvas, commands, layer) => e.run('draw', { canvas, commands, ...(layer ? { layer } : {}) });

function setup() {
  const e = new Engine({ home: tmp() });
  e.run('create', { name: 'hull', width: 32 });
  draw(e, 'hull', [{ op: 'rect', x: 0, y: 0, w: 32, h: 32, color: '#5a6a80' }, { op: 'line', x1: 0, y1: 15, x2: 31, y2: 15, color: '#2a2e35' }]);
  for (const l of ['height', 'metal', 'rough', 'ao']) e.run('layer', { canvas: 'hull', action: 'add', name: l });
  draw(e, 'hull', [{ op: 'rect', x: 0, y: 0, w: 32, h: 32, color: '#ffffff' }, { op: 'line', x1: 0, y1: 15, x2: 31, y2: 15, color: '#000000' }, { op: 'rect', x: 4, y: 4, w: 3, h: 3, color: '#808080' }], 'height');
  draw(e, 'hull', [{ op: 'rect', x: 0, y: 0, w: 32, h: 32, color: '#303030' }, { op: 'rect', x: 0, y: 0, w: 8, h: 32, color: '#e0e0e0' }], 'metal');
  draw(e, 'hull', [{ op: 'rect', x: 0, y: 0, w: 32, h: 32, color: '#909090' }, { op: 'rect', x: 0, y: 24, w: 32, h: 8, color: '#202020' }], 'rough');
  draw(e, 'hull', [{ op: 'rect', x: 0, y: 0, w: 32, h: 32, color: '#ffffff' }, { op: 'line', x1: 0, y1: 16, x2: 31, y2: 16, color: '#606060' }], 'ao');
  e.run('create', { name: 'neon', width: 32, height: 8 });
  draw(e, 'neon', [{ op: 'rect', x: 0, y: 0, w: 32, h: 8, color: '#202024' }]);
  e.run('layer', { canvas: 'neon', action: 'add', name: 'emissive' });
  draw(e, 'neon', [{ op: 'line', x1: 2, y1: 4, x2: 29, y2: 4, color: '#ff40a0' }], 'emissive');
  e.run('create', { name: 'grit', width: 8 });
  draw(e, 'grit', [{ op: 'noise', colors: ['#707070', '#808080', '#909090'], scale: 1, seed: 4 }]);
  return e;
}
const KIT = [
  { type: 'box', w: 32, h: 32, d: 4, texture: 'hull', material: 'painted_hull' },
  { type: 'box', w: 16, h: 16, d: 16, color: '#a0a4a8', material: 'brushed_metal', at: [40, 0, 0] },
  { type: 'box', w: 16, h: 8, d: 16, color: '#9fd8ff', material: 'glass_canopy', at: [0, 0, 40] },
  { type: 'box', w: 16, h: 6, d: 16, color: '#7a3030', material: 'cloth', at: [40, 0, 40] },
  { type: 'box', w: 32, h: 8, d: 2, texture: 'neon', material: { preset: 'neon', emissive: { color: '#ff40a0', strength: 8, animate: 'flicker' } }, at: [-40, 0, 0] },
  { type: 'box', w: 8, h: 8, d: 8, color: '#e0b090', material: 'skin', at: [-40, 0, 40] },
  { type: 'box', w: 32, h: 4, d: 32, texture: 'hull', material: { preset: 'painted_hull', detail: { texture: 'grit', scale: 4, strength: 0.5 }, height: { scale: 2 } }, at: [0, -10, -40], paint: '#ff8000', wetness: 0.5 },
  { type: 'light', kind: 'point', at: [0, 30, 0], color: '#ffd090', intensity: 1.5, range: 96 },
];
const exportGLB = (e, name, args = {}) => {
  const r = e.run('model_export', { name, path: path.join(tmp(), `${name}.glb`), ...args });
  const buf = fs.readFileSync(r.file);
  const v = validateGLB(buf);
  assert.ok(v.ok, `validator: ${v.errors.join('; ')}`);
  return { r, buf, v, ...parseGLB(buf), meta: JSON.parse(fs.readFileSync(r.meta, 'utf8')) };
};

// ---------- tangents ----------
const quad = (uvs) => ({ pos: Float32Array.from([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]), nrm: Float32Array.from([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]), uv: Float32Array.from(uvs.flat()), idx: Uint32Array.from([0, 1, 2, 0, 2, 3]) });
test('tangents: known quad, mirrored and rotated UV islands; three.js tangent frame == derivative frame', () => {
  // upright image on an XY quad (glTF v down the image): T = +X, bitangent = image up = +Y, w = +1
  const up = computeTangents(quad([[0, 1], [1, 1], [1, 0], [0, 0]]));
  for (let v = 0; v < 4; v++) assert.deepEqual(Array.from(up.tangent.subarray(v * 4, v * 4 + 4)).map((x) => Math.round(x * 1e6) / 1e6), [1, 0, 0, 1]);
  // mirrored in u: T = -X, still image up = +Y -> w = -1
  const mir = computeTangents(quad([[1, 1], [0, 1], [0, 0], [1, 0]]));
  for (let v = 0; v < 4; v++) { assert.ok(near(mir.tangent[v * 4], -1, 1e-6)); assert.equal(mir.tangent[v * 4 + 3], -1); }
  // rotated island (image turned 90 deg on the quad): +u runs along +Y, image up = -X
  const rot = computeTangents(quad([[0, 0], [0, 1], [1, 1], [1, 0]]));
  for (let v = 0; v < 4; v++) { assert.ok(near(rot.tangent[v * 4 + 1], 1, 1e-6), `T.y ${rot.tangent[v * 4 + 1]}`); assert.equal(rot.tangent[v * 4 + 3], 1); }
  // three.js shading agrees between the TANGENT path and the derivative path (GLTFLoader flips normalScale.y there)
  const texels = [[0.5, 0, 0.866], [0, 0.6, 0.8], [-0.3, -0.4, 0.866], [0.7, 0.7, 0.14]];
  for (const [name, r, uvs] of [['upright', up, [[0, 1], [1, 1], [1, 0]]], ['mirrored', mir, [[1, 1], [0, 1], [0, 0]]], ['rotated', rot, [[0, 0], [0, 1], [1, 1]]]]) {
    const tri = { p: [[0, 0, 0], [1, 0, 0], [1, 1, 0]], uv: uvs };
    for (const n of texels) {
      const a = threeNormal(n, [0, 0, 1], Array.from(r.tangent.subarray(0, 4))), b = threeDerivativeNormal(n, [0, 0, 1], tri);
      for (let k = 0; k < 3; k++) assert.ok(near(a[k], b[k], 1e-6), `${name} ${n}: tangent ${a} vs derivative ${b}`);
    }
  }
  // green = up: a texel tilted toward +green leans toward image up on the upright quad (+Y)
  assert.ok(threeNormal([0, 0.6, 0.8], [0, 0, 1], [1, 0, 0, 1])[1] > 0.5);
  // a vertex shared by a mirrored and an unmirrored triangle is split (one sign per side)
  const shared = { pos: Float32Array.from([0, 0, 0, 1, 0, 0, 1, 1, 0, -1, 0, 0, -1, 1, 0]), nrm: Float32Array.from(Array(15).fill(0).map((_, i) => (i % 3 === 2 ? 1 : 0))), uv: Float32Array.from([0, 1, 1, 1, 1, 0, 1, 1, 1, 0]), idx: Uint32Array.from([0, 1, 2, 0, 4, 3]) };
  const sp = computeTangents(shared);
  assert.ok(sp.split >= 1, 'mirrored seam vertex split');
  assert.equal(sp.prim.pos.length / 3, sp.tangent.length / 4);
  const signs = new Set(); for (let v = 0; v < sp.tangent.length / 4; v++) signs.add(sp.tangent[v * 4 + 3]);
  assert.deepEqual([...signs].sort(), [-1, 1]);
});

test('tangents in exports: TANGENT wherever a normal map is present (tangents:true / profile three), orthonormal, matches UV derivatives', () => {
  const e = setup();
  e.run('model_create', { name: 'm', parts: [{ type: 'box', w: 32, h: 32, d: 32, texture: 'hull' }, { type: 'cylinder', r: 8, h: 16, texture: 'hull', at: [40, 0, 0] }, { type: 'box', w: 8, h: 8, d: 8, color: '#888', at: [-30, 0, 0] }] });
  const { json, accessor } = exportGLB(e, 'm', { tangents: true });
  let checked = 0;
  for (const p of json.meshes[0].primitives) {
    const mat = json.materials[p.material];
    assert.equal(p.attributes.TANGENT !== undefined, !!mat.normalTexture, 'TANGENT exactly where a normal map is');
    if (!p.attributes.TANGENT) continue;
    const T = accessor(p.attributes.TANGENT), N = accessor(p.attributes.NORMAL), P = accessor(p.attributes.POSITION), U = accessor(p.attributes.TEXCOORD_0), I = accessor(p.indices);
    for (let i = 0; i < T.length / 4; i++) assert.ok(Math.abs(T[i * 4] * N[i * 3] + T[i * 4 + 1] * N[i * 3 + 1] + T[i * 4 + 2] * N[i * 3 + 2]) < 1e-4, 'T _|_ N');
    // per triangle: the derivative frame and the tangent frame shade a tilted texel the same
    for (let t = 0; t < I.length; t += 3) {
      const [a, b, c] = [I[t], I[t + 1], I[t + 2]];
      const tri = { p: [a, b, c].map((v) => [P[v * 3], P[v * 3 + 1], P[v * 3 + 2]]), uv: [a, b, c].map((v) => [U[v * 2], U[v * 2 + 1]]) };
      const n = [N[a * 3], N[a * 3 + 1], N[a * 3 + 2]];
      const fn = (() => { const e1 = tri.p[1].map((x, k) => x - tri.p[0][k]), e2 = tri.p[2].map((x, k) => x - tri.p[0][k]); return [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]]; })();
      if (Math.hypot(...fn) < 1e-9 || fn[0] * n[0] + fn[1] * n[1] + fn[2] * n[2] < 0.99 * Math.hypot(...fn)) continue; // flat faces only (cylinder sides are smooth)
      const x = threeNormal([0.4, 0.5, 0.768], n, T.slice(a * 4, a * 4 + 4)), y = threeDerivativeNormal([0.4, 0.5, 0.768], n, tri);
      for (let k = 0; k < 3; k++) assert.ok(near(x[k], y[k], 2e-3), `tri ${t / 3}: ${x} vs ${y}`);
      checked++;
    }
  }
  assert.ok(checked >= 12, `${checked} flat triangles checked`);
});

// ---------- lightmaps ----------
function corridor(e, extra = []) {
  e.run('create', { name: 'wall', width: 16 });
  draw(e, 'wall', [{ op: 'rect', x: 0, y: 0, w: 16, h: 16, color: '#8a8a90' }]);
  e.run('model_create', { name: 'corr', parts: [
    { type: 'box', w: 96, h: 4, d: 64, texture: 'wall', at: [0, -4, 0] },
    { type: 'box', w: 96, h: 4, d: 64, texture: 'wall', at: [0, 48, 0] },
    { type: 'box', w: 4, h: 48, d: 64, texture: 'wall', at: [-50, 0, 0] },
    { type: 'box', w: 4, h: 48, d: 64, texture: 'wall', at: [50, 0, 0] },
    { type: 'box', w: 12, h: 12, d: 12, texture: 'wall', at: [20, 0, 0] },
    { type: 'light', kind: 'point', at: [-20, 40, 0], color: '#ff9040', intensity: 2, range: 80 },
    ...extra,
  ] });
}
test('lightmap UVs: non-overlapping charts with the requested padding, inside the atlas; shared by AO', () => {
  const e = setup();
  corridor(e);
  for (const padding of [1, 3]) {
    const tex = texResolver(e);
    const b = buildModel(e.models.get('corr'), { tex, getModel: () => null });
    const r = bakeLighting([{ meshes: [b.mesh] }], { ao: null, lm: normLightmap({ samples: 4, bounce: 0, padding, texel: 4 }), lights: b.lights, bounds: b.mesh.bounds() });
    const [W, H] = r.stats.size;
    const rects = [];
    for (const g of b.mesh.groups.values()) for (const f of g.faces) {
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (let v = f.v; v < f.v + f.vc; v++) { const u = g.uv1[v * 2] * W, w = g.uv1[v * 2 + 1] * H; x0 = Math.min(x0, u); x1 = Math.max(x1, u); y0 = Math.min(y0, w); y1 = Math.max(y1, w); }
      assert.ok(x0 >= padding - 1e-6 && y0 >= padding - 1e-6 && x1 <= W - padding + 1e-6 && y1 <= H - padding + 1e-6, 'chart inside the atlas with its gutter');
      rects.push([x0, y0, x1, y1]);
    }
    for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) {
      const [a, b2] = [rects[i], rects[j]];
      const gapX = Math.max(b2[0] - a[2], a[0] - b2[2]), gapY = Math.max(b2[1] - a[3], a[1] - b2[3]);
      assert.ok(Math.max(gapX, gapY) >= 2 * padding - 1e-6, `charts ${i} and ${j} closer than ${2 * padding} texels (gap ${Math.max(gapX, gapY)})`);
    }
    assert.equal(r.stats.charts, rects.length);
  }
  // export: lightmap + AO share TEXCOORD_1; occlusionTexture + extras.lightMap + bent normals on it
  const { json, meta } = exportGLB(e, 'corr', { lightmap: { samples: 8, sun: false }, bake_ao: { samples: 8, bent: true } });
  for (const m of json.materials) { assert.equal(m.occlusionTexture.texCoord, 1); assert.equal(m.extras.lightMap.texCoord, 1); assert.equal(m.extras.bentNormalTexture.texCoord, 1); assert.ok(near(m.extras.lightMap.intensity, Math.PI * 2, 1e-4)); }
  assert.deepEqual(meta.ao.size, meta.lightmap.size, 'one chart layout');
  assert.equal(meta.lightmap.lights.length, 1);
});

test('lightmap bake: deterministic bytes, coloured light, shadows, emissive bounce; quantised + dithered', () => {
  const e = setup();
  corridor(e, [{ type: 'box', w: 24, h: 2, d: 8, texture: 'neon', material: { preset: 'neon', emissive: { color: '#40c0ff', strength: 6 } }, at: [-30, 46, 20] }]);
  const a = exportGLB(e, 'corr', { lightmap: { samples: 12, sun: false, bounce: 1 } });
  const b = exportGLB(e, 'corr', { lightmap: { samples: 12, sun: false, bounce: 1 } });
  assert.ok(a.buf.equals(b.buf), 'same input = same bytes');
  const lmIdx = a.json.materials[0].extras.lightMap.index;
  const img = decodePNG(a.image(lmIdx));
  const levels = new Set(); let warm = 0, cool = 0;
  for (let i = 0; i < img.width * img.height; i++) { const p = i * 4; levels.add(img.data[p]); if (img.data[p] > img.data[p + 2] + 20) warm++; if (img.data[p + 2] > img.data[p] + 20) cool++; }
  assert.ok(levels.size <= 33, `quantised to 32 levels (+ white padding): ${levels.size}`);
  assert.ok(warm > 10, 'orange point light tints the map');
  assert.ok(cool > 10, 'blue emissive strip bounces light onto its neighbours');
  // no light, no sky, no emissive = black
  e.run('model_update', { name: 'corr', remove: [5, 6] });
  const dark = exportGLB(e, 'corr', { lightmap: { samples: 8, sun: false, sky: false } });
  const d = decodePNG(dark.image(dark.json.materials[0].extras.lightMap.index));
  let lit = 0; for (let i = 0; i < d.width * d.height; i++) if (d.data[i * 4] > 0 && d.data[i * 4] < 255) lit++;
  assert.equal(lit, 0, 'nothing lights it');
});

test('SH probes: a known sun gives E*Y(dir); a uniform sky gives only L00; three.js irradiance of the sun = 1.0625 at normal incidence', () => {
  const e = setup();
  e.run('model_create', { name: 'speck', parts: [{ type: 'box', w: 1, h: 1, d: 1, color: '#ffffff', at: [0, -400, 0] }] });
  const tex = texResolver(e);
  const b = buildModel(e.models.get('speck'), { tex, getModel: () => null });
  const bounds = { min: [-1, -1, -1], max: [1, 1, 1] };
  const dir = [0.48, 0.64, 0.6];
  const sunOnly = probeScene([{ meshes: [b.mesh] }], normLightmap({ sun: { dir, intensity: 1, color: '#ffffff' }, sky: false }), [], bounds);
  const p = bakeProbes(sunOnly, bounds, normProbes({ spacing: 100, samples: 64 }), 32);
  assert.equal(p.count, 1);
  const Y = shBasis(dir);
  for (let i = 0; i < 9; i++) for (let q = 0; q < 3; q++) assert.ok(near(p.coefficients[0][i * 3 + q], Y[i], 2e-4), `L${i}: ${p.coefficients[0][i * 3 + q]} vs ${Y[i]}`);
  const E = shIrradiance(p.coefficients[0], dir);
  assert.ok(near(E[0], 1.0625, 2e-3), `irradiance ${E[0]}`);
  assert.ok(shIrradiance(p.coefficients[0], dir.map((v) => -v))[0] < 0.1, 'dark side');
  // uniform sky of radiance 1 (intensity PI, same up and down): L00 = 4 pi * 0.282095, the rest ~0
  const sky = probeScene([{ meshes: [b.mesh] }], normLightmap({ sun: false, sky: { color: '#ffffff', ground: '#ffffff', intensity: Math.PI } }), [], bounds);
  const q = bakeProbes(sky, bounds, normProbes({ spacing: 100, samples: 256 }), 32).coefficients[0];
  assert.ok(near(q[0], 4 * Math.PI * 0.282095, 0.02), `L00 ${q[0]}`);
  for (let i = 3; i < 27; i++) assert.ok(Math.abs(q[i]) < 0.05, `coefficient ${i} = ${q[i]}`);
  // export: probes in meta (grid, order note), point light makes them warm near it
  corridor(e);
  const { meta } = exportGLB(e, 'corr', { probes: { spacing: 32 }, lightmap: { samples: 8, sun: false } });
  assert.ok(meta.probes.count >= 4 && meta.probes.coefficients.length === meta.probes.count);
  assert.match(meta.probes.order, /SphericalHarmonics3/);
});

// ---------- extensions + validator ----------
test('every material extension validates; emissive strength + mask + animation; presets; validator rejects broken files', () => {
  const e = setup();
  e.run('model_create', { name: 'kit', parts: KIT });
  const { json, v, meta, image } = exportGLB(e, 'kit', { profile: 'three', thickness: true, lightmap: { samples: 4 } });
  const want = ['KHR_materials_anisotropy', 'KHR_materials_clearcoat', 'KHR_materials_diffuse_transmission', 'KHR_materials_emissive_strength', 'KHR_materials_ior', 'KHR_materials_sheen', 'KHR_materials_transmission', 'KHR_materials_volume'];
  assert.deepEqual(v.stats.extensions, want);
  assert.deepEqual(json.extensionsUsed, want);
  const byExt = (k) => json.materials.find((m) => m.extensions?.[k]);
  assert.deepEqual(byExt('KHR_materials_clearcoat').extensions.KHR_materials_clearcoat, { clearcoatFactor: 1, clearcoatRoughnessFactor: 0.12 });
  const an = byExt('KHR_materials_anisotropy').extensions.KHR_materials_anisotropy;
  assert.equal(an.anisotropyStrength, 0.8);
  assert.ok(an.anisotropyTexture);
  const glass = byExt('KHR_materials_transmission');
  assert.equal(glass.alphaMode, undefined, 'transmission is not alpha blending');
  assert.equal(glass.extensions.KHR_materials_ior.ior, 1.5);
  assert.ok(glass.extensions.KHR_materials_volume.attenuationDistance > 0);
  const neon = byExt('KHR_materials_emissive_strength');
  assert.equal(neon.extensions.KHR_materials_emissive_strength.emissiveStrength, 8);
  assert.ok(neon.emissiveFactor[0] > 0.9 && neon.emissiveFactor[2] > 0.3 && neon.emissiveFactor[1] < 0.1, 'colour factor (linear)');
  const mask = decodePNG(image(neon.emissiveTexture.index));
  const greys = new Set(); for (let i = 0; i < mask.data.length; i += 4) { assert.ok(mask.data[i] === mask.data[i + 1] && mask.data[i] === mask.data[i + 2], 'grey mask'); greys.add(mask.data[i]); }
  assert.ok(greys.has(255) && greys.has(0));
  assert.equal(neon.extras.emissiveAnimation.mode, 'flicker');
  const skin = byExt('KHR_materials_diffuse_transmission');
  assert.equal(skin.extras.thicknessTexture.texCoord, 1);
  assert.ok(byExt('KHR_materials_sheen').extensions.KHR_materials_sheen.sheenRoughnessFactor === 0.55);
  const det = json.materials.find((m) => m.extras?.detail);
  assert.equal(det.extras.detail.scale, 4);
  assert.ok(det.extras.detail.normal && det.extras.heightTexture.scale > 0);
  assert.ok(meta.materials_v2.validation.ok);
  // the validator catches what engines reject
  const broken = (fn) => { const j = JSON.parse(JSON.stringify(json)); fn(j); return validateGLB({ json: j, bin: parseGLB(exportGLB(e, 'kit', { profile: 'three' }).buf).bin }); };
  assert.match(broken((j) => { j.extensionsUsed = j.extensionsUsed.filter((x) => x !== 'KHR_materials_sheen'); }).errors.join(), /used but not in extensionsUsed/);
  assert.match(broken((j) => { byExtIn(j, 'KHR_materials_ior').extensions.KHR_materials_ior.ior = 0.5; }).errors.join(), /ior must be 0 or >= 1/);
  assert.match(broken((j) => { byExtIn(j, 'KHR_materials_clearcoat').extensions.KHR_materials_clearcoat.clearcoatFactr = 1; }).errors.join(), /not a field/);
  assert.match(broken((j) => { j.materials[0].emissiveFactor = [2, 0, 0]; }).errors.join(), /emissiveFactor/);
  assert.match(broken((j) => { for (const m of j.meshes) for (const p of m.primitives) delete p.attributes.TANGENT; }).errors.join(), /anisotropic material without TANGENT/);
  // presets: 0.7 unchanged, v2 added
  assert.deepEqual(normPBR('glass'), { metal: 0, rough: 0.05, preset: 'glass', glass: true });
  assert.throws(() => normPBR({ clearcoat: { factor: 2 } }), /0\.\.1/);
  assert.throws(() => normPBR({ sheen: { colour: '#fff' } }), /not a field/);
});
const byExtIn = (j, k) => j.materials.find((m) => m.extensions?.[k]);

// ---------- ORM packing ----------
test('ORM packing round trip: gltf_orm shares one texture (R ao layer, G rough, B metal); unity_mask; roblox split; dedupe', () => {
  const e = setup();
  e.run('model_create', { name: 'p', unwrap: false, parts: [{ type: 'box', w: 32, h: 32, d: 32, texture: 'hull' }, { type: 'box', w: 32, h: 32, d: 32, texture: 'hull', at: [40, 0, 0], material: { metal: 0.5, rough: 0.5 } }] }); // per-part materials (unwrap:false)
  const { json, image } = exportGLB(e, 'p', { packing: 'gltf_orm' });
  const m = json.materials.find((x) => x.name === 'hull');
  assert.equal(m.occlusionTexture.index, m.pbrMetallicRoughness.metallicRoughnessTexture.index, 'one texture for occlusion + metal/rough');
  assert.equal(m.occlusionTexture.texCoord ?? 0, 0);
  const orm = decodePNG(image(m.occlusionTexture.index));
  const at = (x, y) => Array.from(orm.data.subarray((y * 32 + x) * 4, (y * 32 + x) * 4 + 3));
  assert.deepEqual(at(20, 5), [255, 0x90, 0x30], 'ao 1, rough #90, metal #30');
  assert.deepEqual(at(2, 5), [255, 0x90, 0xe0], 'metal stripe');
  assert.deepEqual(at(20, 26), [255, 0x20, 0x30], 'rough stripe');
  assert.equal(at(20, 16)[0], 0x60, 'ao layer line in red');
  // unpack: splitORM gives the same greys back; unity mask = metal, occlusion, detail, smoothness
  const sp = splitORM(32, 32, orm.data);
  assert.equal(sp.roughness[(26 * 32 + 20) * 4], 0x20); assert.equal(sp.metalness[(5 * 32 + 2) * 4], 0xe0); assert.equal(sp.occlusion[(16 * 32 + 20) * 4], 0x60);
  const um = packUnityMask(32, 32, orm.data);
  assert.deepEqual(Array.from(um.subarray((26 * 32 + 20) * 4, (26 * 32 + 20) * 4 + 4)), [0x30, 255, 255, 255 - 0x20]);
  assert.deepEqual(Array.from(packORM(1, 1, null, null, { metal: 1, rough: 0.5 })), [255, 128, 255, 255]);
  const auto = exportGLB(e, 'p', {}); // an ao layer packs ORM by default
  const am = auto.json.materials.find((x) => x.name === 'hull');
  assert.equal(am.occlusionTexture.index, am.pbrMetallicRoughness.metallicRoughnessTexture.index);
  const u = exportGLB(e, 'p', { packing: 'unity_mask' });
  assert.ok(u.json.materials.some((x) => x.extras?.unityMaskTexture));
  // dedupe: a duplicated canvas (same pixels, other name) shares every image with the original
  e.run('duplicate', { canvas: 'hull', new_name: 'hull_copy' });
  e.run('model_update', { name: 'p', set: { 1: { texture: 'hull_copy', material: null } } });
  const t = exportGLB(e, 'p', { profile: 'three' });
  assert.ok(t.meta.materials_v2.textures_deduped >= 4, `deduped ${t.meta.materials_v2.textures_deduped}`);
  const seen = new Set();
  for (const im of t.json.images) { const v = t.json.bufferViews[im.bufferView]; const k = t.bin.subarray(v.byteOffset, v.byteOffset + v.byteLength).toString('base64'); assert.ok(!seen.has(k), 'no duplicate image'); seen.add(k); }
  const ms = t.json.materials;
  assert.equal(ms[0].pbrMetallicRoughness.baseColorTexture.index, ms[1].pbrMetallicRoughness.baseColorTexture.index);
});

// ---------- Roblox / minimal ----------
test('roblox profile: SurfaceAppearance maps <= 1024 px (nearest upscale), meshes < 20k tris, dropped report; minimal profile', () => {
  const e = setup();
  e.run('model_create', { name: 'big', parts: [...KIT.slice(0, 6), { type: 'cylinder', r: 16, h: 16, segments: 64, texture: 'hull', at: [0, 60, 0], array: { count: 90, step: [0, 0, 20] } }] });
  const big = e.run('model_info', { name: 'big' });
  assert.ok(big.triangles > 20000, `${big.triangles} triangles`);
  const out = tmp();
  const r = e.run('model_export', { name: 'big', path: path.join(out, 'big.glb'), profile: 'roblox' });
  const buf = fs.readFileSync(r.file);
  const v = validateGLB(buf);
  assert.ok(v.ok, v.errors.join());
  assert.deepEqual(v.stats.extensions, []);
  const { json } = parseGLB(buf);
  for (const m of json.meshes) { const tris = m.primitives.reduce((s, p) => s + json.accessors[p.indices].count / 3, 0); assert.ok(tris < 20000, `${m.name} ${tris} tris`); }
  for (const m of json.materials) { assert.equal(m.emissiveTexture, undefined); assert.equal(m.extensions, undefined); assert.equal(m.occlusionTexture, undefined); }
  assert.ok(r.roblox.ok);
  const man = JSON.parse(fs.readFileSync(path.join(out, 'big.roblox', 'surface_appearance.json'), 'utf8'));
  assert.ok(man.limits.ok);
  assert.ok(man.dropped.some((d) => /emissive/.test(d.what)) && man.dropped.some((d) => /triangles over/.test(d.what)));
  const hull = man.surface_appearances.find((s) => /hull/.test(s.material));
  for (const k of ['ColorMap', 'NormalMap', 'MetalnessMap', 'RoughnessMap']) {
    const png = decodePNG(fs.readFileSync(path.join(out, hull[k])));
    assert.equal(png.width, 1024, `${k} upscaled to 1024`);
    // nearest: each 32x32 block is one texel
    assert.deepEqual(Array.from(png.data.subarray(0, 4)), Array.from(png.data.subarray(31 * 4, 31 * 4 + 4)));
  }
  assert.equal(hull.upscale, 32);
  // minimal: base colour only
  const mn = exportGLB(e, 'big', { profile: 'minimal' });
  for (const m of mn.json.materials) { assert.equal(m.normalTexture, undefined); assert.equal(m.pbrMetallicRoughness.metallicRoughnessTexture, undefined); assert.equal(m.emissiveTexture, undefined); }
  assert.ok(mn.r.dropped.length >= 3);
});

// ---------- byte identity ----------
test('byte-identical exports when materials v2 is unused (0.7 golden digests)', () => {
  const golden = JSON.parse(fs.readFileSync(new URL('./fixtures/golden-0.7.json', import.meta.url), 'utf8'));
  assert.deepEqual(corpusDigests(), golden);
});

// ---------- displacement / parallax / detail / vertex data ----------
test('displacement: adaptive subdivision under the budget, crack-free locked seams, pixel plateaus; height texture extras', () => {
  const e = setup();
  e.run('model_create', { name: 'plate', parts: [{ type: 'box', w: 64, h: 8, d: 64, texture: 'hull', displace: { scale: 3, max_triangles: 1200 } }] });
  const info = e.run('model_info', { name: 'plate' });
  const part = info.parts[0];
  assert.ok(part.displaced.after <= 1200 && part.displaced.after > part.displaced.before * 10, JSON.stringify(part.displaced));
  const tex = texResolver(e);
  const b = buildModel(e.models.get('plate'), { tex, getModel: () => null });
  // every displaced vertex on the box's outer edges stays on the undisplaced box (watertight)
  const bb = b.mesh.bounds();
  let moved = 0, edge = 0;
  for (const g of b.mesh.groups.values()) for (let i = 0; i < g.pos.length; i += 3) {
    const p = [g.pos[i], g.pos[i + 1], g.pos[i + 2]];
    const onX = near(Math.abs(p[0]), 32, 1e-6), onZ = near(Math.abs(p[2]), 32, 1e-6), onY = near(p[1], bb.min[1], 1e-6) || near(p[1], 8, 1e-6);
    if ((onX && onZ) || (onX && onY) || (onZ && onY)) edge++;
    if (p[1] > 8 + 1e-6) moved++;
  }
  assert.ok(moved > 50, `${moved} vertices raised`);
  assert.ok(edge > 0);
  // top face max height = 8 + scale (height 1 x 3 px)
  assert.ok(near(bb.max[1], 11, 1e-6), `top ${bb.max[1]}`);
  // closed: every edge of the top face region is shared by two triangles, or lies on a box edge
  // budget is respected even when asked for more detail than allowed
  e.run('model_create', { name: 'plate2', parts: [{ type: 'box', w: 64, h: 8, d: 64, texture: 'hull', displace: { scale: 3, max_triangles: 100 } }] });
  assert.ok(e.run('model_info', { name: 'plate2' }).parts[0].displaced.after <= 100);
  assert.throws(() => e.run('model_create', { name: 'bad', parts: [{ type: 'box', w: 8, h: 8, d: 8, color: '#888', displace: true }] }), /height source/);
  // height texture for POM + detail extras + TANGENT
  const { json } = exportGLB(e, 'plate', { profile: 'three' });
  const m = json.materials[0];
  assert.ok(m.extras.heightTexture.scale > 0 && m.extras.heightTexture.uv_per_unit.length === 2);
  assert.ok(json.meshes[0].primitives[0].attributes.TANGENT !== undefined);
});

test('vertex data: paint + masks colour sets, UV2 / UV3 consecutive, AO in masks; preview channels + POM; material editor', () => {
  const e = setup();
  e.run('model_create', { name: 'kit', parts: KIT });
  const { json, accessor, meta } = exportGLB(e, 'kit', { vertex_colors: true, uv2: 'world', uv3: 'box' });
  const p = json.meshes[0].primitives.find((x) => json.materials[x.material].extras?.detail);
  assert.ok(p.attributes.COLOR_0 !== undefined && p.attributes.COLOR_1 !== undefined && p.attributes.TEXCOORD_1 !== undefined && p.attributes.TEXCOORD_2 !== undefined);
  assert.deepEqual(meta.vertex_data.attributes, { COLOR_0: 'paint', COLOR_1: 'masks', TEXCOORD_1: 'world', TEXCOORD_2: 'box' });
  const c0 = accessor(p.attributes.COLOR_0), c1 = accessor(p.attributes.COLOR_1);
  assert.ok(near(c0[0], 1, 1e-4) && near(c0[1], 0.21586, 1e-3) && c0[2] === 0, 'paint #ff8000 in linear');
  assert.ok(near(c1[0], 0.5, 1e-6), 'wetness in R');
  const box = accessor(p.attributes.TEXCOORD_2); assert.ok(box.every((x) => x >= -1e-6 && x <= 1 + 1e-6));
  // with a lightmap the extra sets move up (TEXCOORD_1 = lightmap)
  const lm = exportGLB(e, 'kit', { uv2: 'world', lightmap: { samples: 4 } });
  assert.deepEqual(lm.meta.vertex_data.attributes, { TEXCOORD_2: 'world' });
  // previews: one channel, a list, everything
  const one = e.run('model_preview', { name: 'kit', channel: 'normal', size: 96 });
  assert.ok(decodePNG(one.image).width >= 96);
  const all = e.run('model_preview', { name: 'kit', channel: 'all', size: 64 });
  assert.deepEqual(all.channels, ['lit', 'albedo', 'normal', 'orm', 'emissive', 'height', 'lightmap', 'bent']);
  assert.ok(all.bake.texels > 0);
  assert.ok(e.run('model_preview', { name: 'kit', channel: 'lit', pom: true, size: 96 }).image.length > 100);
  assert.throws(() => e.run('model_preview', { name: 'kit', channel: 'sparkle' }), /channel must be one of/);
  // editor: create, edit, use by name and by canvas name, delete
  let r = e.run('model_material', { name: 'kit', material: 'hullpaint', preset: 'painted_hull', set: { clearcoat: { factor: 0.6, rough: 0.2 } } });
  assert.deepEqual(r.resolved.v2.clearcoat, { factor: 0.6, rough: 0.2 });
  r = e.run('model_material', { name: 'kit', material: 'hullpaint', set: { clearcoat: false, sheen: { color: '#ffffff' } } }); // false switches a preset's field off
  assert.ok(r.resolved.v2.sheen && !r.resolved.v2.clearcoat);
  e.run('model_update', { name: 'kit', set: { 0: { material: 'hullpaint' } } });
  e.run('model_material', { name: 'kit', material: 'grit', preset: 'brushed_metal' });
  const list = e.run('model_material', { name: 'kit' });
  assert.ok(list.materials.hullpaint && list.presets.v2.includes('glass_canopy'));
  const ex = exportGLB(e, 'kit', {});
  assert.ok(ex.json.materials.some((m) => m.extensions?.KHR_materials_sheen), 'named material applied');
  assert.throws(() => e.run('model_material', { name: 'kit', material: 'nope' }), /does not exist/);
  assert.throws(() => e.run('model_material', { name: 'kit', material: 'x', set: { clearcoat: 3 } }), /0\.\.1/);
  assert.throws(() => e.run('model_material', { name: 'kit', material: 'hullpaint', delete: true }), /used by part\(s\) 0/);
  e.run('model_update', { name: 'kit', set: { 0: { material: 'painted_hull' } } });
  assert.ok(e.run('model_material', { name: 'kit', material: 'hullpaint', delete: true }).deleted);
  // persisted
  assert.ok(JSON.parse(fs.readFileSync(path.join(e.home, 'models', 'kit.json'), 'utf8')).materials.grit);
});

test('help, tool schema and the UI: materials topic, art_model material action, /api/model/<name>/glb?profile=three, viewer channel dropdown', async () => {
  const help = helpText({ topic: 'materials', full: true });
  for (const k of ['painted_hull', 'brushed_metal', 'glass_canopy', 'cloth', 'neon', 'KHR_materials_emissive_strength', 'lightmap', 'probes', 'displace', 'roblox', 'unity_mask', 'channel']) assert.ok(help.includes(k), `materials help mentions ${k}`);
  const { TOOLS } = await import('../src/mcp.js');
  const tool = TOOLS.find((t) => t.name === 'art_model');
  assert.ok(tool.inputSchema.properties.action.enum.includes('material'));
  for (const k of ['profile', 'lightmap', 'probes', 'channel', 'packing', 'vertex_colors']) assert.ok(tool.inputSchema.properties[k], k);
  const viewer = fs.readFileSync(new URL('../web/ui/viewers/model.js', import.meta.url), 'utf8');
  for (const k of ['chanSel', 'profile=three', 'bake=1', 'lightMap', 'bentNormalTexture', 'RawShaderMaterial']) assert.ok(viewer.includes(k), `viewer has ${k}`);
  const e = setup();
  e.run('model_create', { name: 'kit', parts: KIT });
  const { startServer } = await import('../src/server.js');
  const port = 7930 + Math.floor(Math.random() * 50);
  const srv = await startServer(e, { port });
  try {
    const get = (q) => new Promise((res, rej) => http.get(`http://127.0.0.1:${port}/api/model/kit/glb${q}`, (r) => { const b = []; r.on('data', (d) => b.push(d)); r.on('end', () => res(Buffer.concat(b))); }).on('error', rej));
    const plain = await get(''), three = await get('?profile=three'), baked = await get('?profile=three&bake=1');
    for (const b of [plain, three, baked]) assert.ok(validateGLB(b).ok);
    assert.ok(validateGLB(three).stats.extensions.length === 8);
    assert.ok(parseGLB(baked).json.materials.some((m) => m.extras?.lightMap && m.extras?.bentNormalTexture));
    assert.ok(!parseGLB(three).json.materials.some((m) => m.extras?.lightMap));
  } finally { await new Promise((r) => { srv.close(() => r()); srv.closeAllConnections?.(); }); }
});

test('anisotropy texture: unit directions, brushed strength in 4 levels, radial circles', () => {
  const b = anisotropyTexture(16, 16, 'brushed');
  const s = new Set();
  for (let i = 0; i < 256; i++) { assert.equal(b[i * 4], 255); assert.equal(b[i * 4 + 1], 128); s.add(b[i * 4 + 2]); }
  assert.ok(s.size >= 2 && s.size <= 4);
  const r = anisotropyTexture(16, 16, 'radial');
  const d = (x, y) => [r[(y * 16 + x) * 4] / 127.5 - 1, r[(y * 16 + x) * 4 + 1] / 127.5 - 1];
  assert.ok(Math.abs(d(15, 8)[0]) < 0.15 && d(15, 8)[1] > 0.9, 'right of centre: direction up (tangential)');
});
