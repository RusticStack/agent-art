// Rebuilds the materials v2 demo renders in docs/materials/:
//   node docs/materials/build-demos.mjs [out dir]
// Each image is a row of software-preview renders: the lit result first, then its channels.
// hull_clearcoat, brushed_metal, glass_canopy, fabric_seat, neon_sign, corridor_lightmap (AO only vs
// baked coloured lightmap), pom (flat vs parallax), detail (off vs on, up close). Prints timings,
// texture sizes and validator results; exports the .glb of each demo with profile "three".
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Engine } from '../../src/engine.js';
import { buildModel } from '../../src/model3d.js';
import { texResolver } from '../../src/modelops.js';
import { renderCamera, makeCamera } from '../../src/raster3d.js';
import { bakeLighting, normLightmap } from '../../src/lightbake.js';
import { normAO } from '../../src/bake.js';
import { packImages } from '../../src/sheet.js';
import { encodePNG } from '../../src/png.js';
import { validateGLB } from '../../src/gltfcheck.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(process.argv[2] || here);
fs.mkdirSync(OUT, { recursive: true });
const e = new Engine({ home: fs.mkdtempSync(path.join(os.tmpdir(), 'aa-matdemo-')) });
const draw = (canvas, commands, layer) => e.run('draw', { canvas, commands, ...(layer ? { layer } : {}) });
const log = [];

// ---------- textures ----------
e.run('create', { name: 'hull', width: 32 });
draw('hull', [
  { op: 'noise', colors: ['#56627a', '#5c6880', '#606c84'], scale: 4, seed: 3 },
  { op: 'line', x1: 0, y1: 0, x2: 31, y2: 0, color: '#262b35' }, { op: 'line', x1: 0, y1: 0, x2: 0, y2: 31, color: '#262b35' },
  { op: 'line', x1: 16, y1: 1, x2: 16, y2: 15, color: '#2c323c' }, { op: 'line', x1: 1, y1: 16, x2: 31, y2: 16, color: '#2c323c' },
  { op: 'rect', x: 20, y: 20, w: 8, h: 3, color: '#c89a2a' },
  { op: 'pixels', points: [[3, 3], [28, 3], [3, 28], [28, 28], [13, 3], [19, 3]], color: '#9aa4b4' },
]);
for (const l of ['height', 'metal', 'rough', 'ao']) e.run('layer', { canvas: 'hull', action: 'add', name: l });
draw('hull', [
  { op: 'rect', x: 0, y: 0, w: 32, h: 32, color: '#c0c0c0' }, { op: 'line', x1: 0, y1: 0, x2: 31, y2: 0, color: '#000000' }, { op: 'line', x1: 0, y1: 0, x2: 0, y2: 31, color: '#000000' },
  { op: 'line', x1: 16, y1: 1, x2: 16, y2: 15, color: '#303030' }, { op: 'line', x1: 1, y1: 16, x2: 31, y2: 16, color: '#303030' },
  { op: 'rect', x: 4, y: 20, w: 9, h: 8, color: '#707070' },
  { op: 'pixels', points: [[3, 3], [28, 3], [3, 28], [28, 28], [13, 3], [19, 3]], color: '#ffffff' },
], 'height');
draw('hull', [{ op: 'rect', x: 0, y: 0, w: 32, h: 32, color: '#383838' }, { op: 'pixels', points: [[3, 3], [28, 3], [3, 28], [28, 28], [13, 3], [19, 3]], color: '#f0f0f0' }], 'metal');
draw('hull', [{ op: 'rect', x: 0, y: 0, w: 32, h: 32, color: '#8a8a8a' }, { op: 'rect', x: 20, y: 20, w: 8, h: 3, color: '#d0d0d0' }], 'rough');
draw('hull', [{ op: 'rect', x: 0, y: 0, w: 32, h: 32, color: '#ffffff' }, { op: 'line', x1: 1, y1: 17, x2: 31, y2: 17, color: '#909090' }, { op: 'line', x1: 17, y1: 1, x2: 17, y2: 15, color: '#909090' }], 'ao');

e.run('create', { name: 'steel', width: 16 });
draw('steel', [{ op: 'noise', colors: ['#9ea3aa', '#a6abb2', '#aeb3ba'], scale: 1, seed: 9 }]);
e.run('create', { name: 'cloth', width: 16 });
draw('cloth', [{ op: 'noise', colors: ['#6e2a2e', '#7a3034', '#742c30'], scale: 1, seed: 6 }, { op: 'line', x1: 0, y1: 7, x2: 15, y2: 7, color: '#4e1c20' }, { op: 'line', x1: 7, y1: 0, x2: 7, y2: 15, color: '#4e1c20' }]);
e.run('create', { name: 'sign', width: 64, height: 16 });
draw('sign', [{ op: 'rect', x: 0, y: 0, w: 64, h: 16, color: '#18181c' }, { op: 'rect', x: 0, y: 0, w: 64, h: 16, color: '#2a2a30', fill: false }]);
e.run('layer', { canvas: 'sign', action: 'add', name: 'emissive' });
const glyphs = [
  [[4, 4], [4, 11], [5, 4], [6, 5], [7, 6], [8, 7], [9, 4], [9, 11], [9, 5], [9, 6], [9, 7], [9, 8], [9, 9], [9, 10], [4, 5], [4, 6], [4, 7], [4, 8], [4, 9], [4, 10]], // N
  [[13, 4], [14, 4], [15, 4], [16, 4], [13, 5], [13, 6], [13, 7], [14, 7], [15, 7], [13, 8], [13, 9], [13, 10], [13, 11], [14, 11], [15, 11], [16, 11]], // E
  [[20, 4], [20, 5], [20, 6], [20, 7], [20, 8], [20, 9], [20, 10], [21, 11], [22, 11], [23, 11], [24, 10], [24, 9], [24, 8], [24, 7], [24, 6], [24, 5], [24, 4], [21, 4], [22, 4], [23, 4]], // O
  [[28, 4], [28, 11], [29, 4], [30, 5], [31, 6], [32, 7], [33, 4], [33, 11], [33, 5], [33, 6], [33, 7], [33, 8], [33, 9], [33, 10], [28, 5], [28, 6], [28, 7], [28, 8], [28, 9], [28, 10]], // N
];
draw('sign', [{ op: 'pixels', points: glyphs.flat(), color: '#ff3a9a' }, { op: 'line', x1: 38, y1: 11, x2: 59, y2: 11, color: '#3ae0ff' }, { op: 'line', x1: 38, y1: 4, x2: 59, y2: 4, color: '#3ae0ff' }], 'emissive');
e.run('create', { name: 'wall', width: 32 });
draw('wall', [{ op: 'noise', colors: ['#6e7078', '#74767e', '#7a7c84'], scale: 3, seed: 2 }, { op: 'rect', x: 0, y: 0, w: 32, h: 32, color: '#4a4c54', fill: false }, { op: 'line', x1: 0, y1: 16, x2: 31, y2: 16, color: '#55575f' }]);
e.run('create', { name: 'deck', width: 32 });
draw('deck', [{ op: 'noise', colors: ['#50545c', '#565a62', '#5c6068'], scale: 3, seed: 5 }, { op: 'rect', x: 0, y: 0, w: 32, h: 32, color: '#33363c', fill: false }, { op: 'rect', x: 16, y: 0, w: 1, h: 32, color: '#33363c' }]);
e.run('create', { name: 'lamp', width: 8 });
draw('lamp', [{ op: 'rect', x: 0, y: 0, w: 8, h: 8, color: '#ffe0b0' }]);
e.run('layer', { canvas: 'lamp', action: 'add', name: 'emissive' });
draw('lamp', [{ op: 'rect', x: 0, y: 0, w: 8, h: 8, color: '#ffd8a0' }], 'emissive');
e.run('create', { name: 'strip', width: 8 });
draw('strip', [{ op: 'rect', x: 0, y: 0, w: 8, h: 8, color: '#80e8ff' }]);
e.run('layer', { canvas: 'strip', action: 'add', name: 'emissive' });
draw('strip', [{ op: 'rect', x: 0, y: 0, w: 8, h: 8, color: '#40d0ff' }], 'emissive');
e.run('create', { name: 'grit', width: 16 });
draw('grit', [{ op: 'noise', colors: ['#6c6c6c', '#7c7c7c', '#8c8c8c', '#9c9c9c'], scale: 1, seed: 11 }]);

// ---------- helpers ----------
const S = 256;
const buildOf = (def) => buildModel({ name: 'demo', ...def }, { tex: texResolver(e), getModel: (n) => e.models.get(n), materials: def.materials });
const unitv = (v) => { const l = Math.hypot(...v); return v.map((x) => x / l); };
const groupsOf = (mesh) => [...mesh.groups.values()].filter((g) => g.idx.length);
const shoot = (groups, cam, opts = {}) => renderCamera(groups, makeCamera(cam, S, S, []), S, S, opts);
/** add bloom from the over-bright buffer (box blur, 2 passes) */
function bloomed(groups, cam, opts = {}) {
  const glow = new Float32Array(S * S * 3);
  const img = shoot(groups, cam, { ...opts, glow });
  const blur = (src, r) => { const out = new Float32Array(src.length); for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) for (let k = 0; k < 3; k++) { let s = 0, n = 0; for (let j = -r; j <= r; j++) for (let i = -r; i <= r; i++) { const xx = x + i, yy = y + j; if (xx < 0 || yy < 0 || xx >= S || yy >= S) continue; s += src[(yy * S + xx) * 3 + k]; n++; } out[(y * S + x) * 3 + k] = s / n; } return out; };
  const b = blur(blur(glow, 4), 4);
  for (let i = 0; i < S * S; i++) for (let k = 0; k < 3; k++) img.data[i * 4 + k] = Math.min(255, img.data[i * 4 + k] + b[i * 3 + k] * 1.6);
  return img;
}
function sheet(file, items, title) {
  const s = packImages(items.map((it) => ({ img: it.img, label: it.label })), { labels: true, checker: false, columns: items.length });
  fs.writeFileSync(path.join(OUT, file), encodePNG(s.width, s.height, s.data));
  log.push(`${file}: ${title} (${s.width}x${s.height})`);
}
function exportDemo(name, def, args = {}) {
  e.run('model_create', { name, ...def, overwrite: true });
  const r = e.run('model_export', { name, path: path.join(os.tmpdir(), 'aa-matdemo-out', `${name}.glb`), profile: 'three', ...args });
  const v = validateGLB(fs.readFileSync(r.file));
  log.push(`  ${name}.glb: ${r.bytes} bytes, ${r.triangles} tris, extensions [${(r.materials_v2?.extensions || []).join(', ')}], valid ${v.ok}${v.ok ? '' : ' ' + v.errors.join('; ')}${r.lightmap ? `, lightmap ${r.lightmap.size.join('x')} in ${r.lightmap.ms} ms` : ''}${r.probes ? `, ${r.probes.count} probes in ${r.probes.ms} ms` : ''}`);
  return r;
}
const channelRow = (groups, cam, chans, lit = {}) => [{ img: lit.bloom ? bloomed(groups, cam, lit.opts || {}) : shoot(groups, cam, lit.opts || {}), label: 'lit' }, ...chans.map((c) => ({ img: shoot(groups, cam, { channel: c }), label: c }))];

// ---------- 1. painted hull panel, clearcoat ----------
{
  const def = { parts: [{ type: 'box', w: 64, h: 6, d: 64, bevel: 2, texture: 'hull', material: 'painted_hull' }, { type: 'box', w: 64, h: 6, d: 64, bevel: 2, texture: 'hull', material: 'painted_metal', at: [70, 0, 0] }] };
  const b = buildOf(def);
  const cam = { pos: [35, 20, 66], look: [35, 0, -4], fov: 64 };
  // light from behind the panels so the reflection / highlight faces the camera
  sheet('hull_clearcoat.png', channelRow(groupsOf(b.mesh), cam, ['albedo', 'normal', 'orm', 'clearcoat'], { opts: { light: unitv([0.1, 0.5, -0.86]) } }), 'painted hull panel: painted_hull (clearcoat, left) vs painted_metal (right), light from behind');
  exportDemo('demo_hull', def);
}
// ---------- 2. brushed metal, anisotropic ----------
{
  const def = { parts: [{ type: 'cylinder', r: 22, h: 10, segments: 24, texture: 'steel', tile: false, material: { preset: 'brushed_metal', anisotropy: { strength: 0.9, pattern: 'radial' } } }, { type: 'box', w: 40, h: 6, d: 40, texture: 'steel', material: 'brushed_metal', at: [54, 0, 0] }, { type: 'box', w: 40, h: 6, d: 40, texture: 'steel', material: 'bare_metal', at: [54, 0, -46] }] };
  const b = buildOf(def);
  const cam = { pos: [10, 46, 66], look: [26, 0, -12], fov: 54 };
  sheet('brushed_metal.png', channelRow(groupsOf(b.mesh), cam, ['albedo', 'anisotropy', 'tangent', 'rough'], { opts: { light: unitv([0.25, 0.5, -0.83]) } }), 'brushed metal: radial (spun disc) + brushed plate vs bare_metal (back), light from behind');
  exportDemo('demo_brushed', def);
}
// ---------- 3. glass canopy ----------
{
  const def = { parts: [
    { type: 'box', w: 48, h: 10, d: 64, texture: 'hull', material: 'painted_hull' },
    { type: 'box', w: 12, h: 10, d: 12, texture: 'cloth', material: 'cloth', at: [0, 10, 6] },
    { type: 'box', w: 30, h: 16, d: 36, bevel: 5, color: '#a8dcff', material: 'glass_canopy', at: [0, 10, 4] },
  ] };
  const b = buildOf(def);
  const cam = { pos: [52, 52, 70], look: [0, 12, 0], fov: 50 };
  sheet('glass_canopy.png', channelRow(groupsOf(b.mesh), cam, ['albedo', 'transmission', 'rough']), 'glass canopy: transmission + volume + ior (seat visible through it)');
  exportDemo('demo_canopy', def);
}
// ---------- 4. fabric seat ----------
{
  const def = { parts: [
    { type: 'box', w: 28, h: 8, d: 28, bevel: 3, texture: 'cloth', material: 'cloth' },
    { type: 'box', w: 28, h: 30, d: 7, bevel: 3, texture: 'cloth', material: 'cloth', at: [0, 4, -12] },
    { type: 'box', w: 28, h: 8, d: 28, bevel: 3, texture: 'cloth', material: 'fabric', at: [40, 0, 0] },
    { type: 'box', w: 28, h: 30, d: 7, bevel: 3, texture: 'cloth', material: 'fabric', at: [40, 4, -12] },
  ] };
  const b = buildOf(def);
  const cam = { pos: [20, 40, 78], look: [20, 10, 0], fov: 46 };
  sheet('fabric_seat.png', channelRow(groupsOf(b.mesh), cam, ['albedo', 'sheen', 'normal']), 'fabric seat: cloth (sheen, left) vs fabric (0.7, right)');
  exportDemo('demo_seat', def);
}
// ---------- 5. neon sign, emissive strength ----------
{
  const def = { parts: [
    { type: 'box', w: 64, h: 16, d: 2, texture: 'sign', material: { preset: 'neon', emissive: { strength: 6, animate: { mode: 'flicker', hz: 10 } } } },
    { type: 'box', w: 64, h: 16, d: 2, texture: 'sign', at: [0, -20, 0] },
    { type: 'box', w: 90, h: 4, d: 30, texture: 'deck', at: [0, -24, 10] },
  ] };
  const b = buildOf(def);
  const cam = { pos: [6, -2, 96], look: [0, -8, 0], fov: 50 };
  sheet('neon_sign.png', channelRow(groupsOf(b.mesh), cam, ['albedo', 'emissive'], { bloom: true }), 'neon sign: emissive strength 6 + flicker (top) vs strength 1 (0.7, bottom); bloom from the over-bright buffer');
  exportDemo('demo_neon', def);
}
// ---------- 6. corridor: AO only vs baked coloured lightmap ----------
let corridorStats = null;
{
  const parts = [
    { type: 'box', w: 64, h: 4, d: 192, texture: 'deck', at: [0, -4, 0] },
    { type: 'box', w: 64, h: 4, d: 192, texture: 'wall', at: [0, 48, 0] },
    { type: 'box', w: 4, h: 48, d: 192, texture: 'wall', at: [-34, 0, 0] },
    { type: 'box', w: 4, h: 48, d: 192, texture: 'wall', at: [34, 0, 0] },
    { type: 'box', w: 6, h: 8, d: 10, texture: 'wall', at: [-27, 0, 0], array: { count: 4, step: [0, 0, 44] } },
    { type: 'box', w: 8, h: 2, d: 8, texture: 'lamp', at: [0, 46, -66], array: { count: 3, step: [0, 0, 66] } },
    { type: 'light', kind: 'area', at: [0, 45.5, -66], size: [8, 8], color: '#ffc890', intensity: 1.4, range: 90, array: { count: 3, step: [0, 0, 66] } },
    { type: 'box', w: 2, h: 2, d: 150, texture: 'strip', material: { preset: 'neon', emissive: { color: '#40d0ff', strength: 2 } }, at: [31, 2, 0] },
    { type: 'box', w: 64, h: 48, d: 4, texture: 'wall', at: [0, 0, -98] },
  ];
  const def = { parts };
  const t0 = performance.now();
  const bAO = buildOf(def);
  const ao = bakeLighting([{ meshes: [bAO.mesh] }], { ao: normAO({ samples: 24 }), bounds: bAO.mesh.bounds() });
  for (const g of bAO.mesh.groups.values()) g.aoTex = ao.ao;
  const tAO = performance.now() - t0;
  const bLM = buildOf(def);
  const t1 = performance.now();
  const lm = bakeLighting([{ meshes: [bLM.mesh] }], { ao: normAO({ samples: 24 }), lm: normLightmap({ samples: 48, bounce: 2, sun: false, sky: { intensity: 0.08 }, texel: 4 }), lights: bLM.lights, bounds: bLM.mesh.bounds() });
  for (const g of bLM.mesh.groups.values()) { g.aoTex = lm.ao; g.lmTex = lm.lightmap; }
  const tLM = performance.now() - t1;
  corridorStats = { ao_ms: Math.round(tAO), lightmap_ms: Math.round(tLM), size: lm.stats.size, charts: lm.stats.charts, texels: lm.stats.texels, peak: lm.stats.peak };
  const cam = { pos: [-12, 26, 104], look: [6, 14, -40], fov: 62 };
  const flat = shoot(groupsOf(bAO.mesh), cam);
  const lit = bloomed(groupsOf(bLM.mesh), cam);
  const lmView = shoot(groupsOf(bLM.mesh), cam, { channel: 'lightmap' });
  const uv1 = shoot(groupsOf(bLM.mesh), cam, { channel: 'uv1' });
  // the lightmap texture itself
  const L = lm.lightmap, k = Math.max(1, Math.floor(S / Math.max(L.width, L.height)));
  const atlas = { width: S, height: S, data: new Uint8ClampedArray(S * S * 4) };
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) { const sx = Math.floor(x / k), sy = Math.floor(y / k), p = (y * S + x) * 4; if (sx < L.width && sy < L.height) atlas.data.set(L.data.subarray((sy * L.width + sx) * 4, (sy * L.width + sx) * 4 + 4), p); else atlas.data.set([20, 22, 28, 255], p); }
  sheet('corridor_lightmap.png', [{ img: flat, label: 'ao only' }, { img: lit, label: 'baked lightmap' }, { img: lmView, label: 'lightmap' }, { img: uv1, label: 'uv1 charts' }, { img: atlas, label: `atlas ${L.width}x${L.height}` }], 'corridor: AO only (0.7) vs baked coloured lightmap (3 warm area lights, cyan emissive strip bounce, 2 bounces)');
  e.run('model_create', { name: 'demo_corridor', parts, overwrite: true });
  const r = e.run('model_export', { name: 'demo_corridor', path: path.join(os.tmpdir(), 'aa-matdemo-out', 'demo_corridor.glb'), profile: 'three', lightmap: { samples: 48, bounce: 2, sun: false, sky: { intensity: 0.08 } }, bake_ao: { samples: 24, bent: true }, probes: { spacing: 48 } });
  const v = validateGLB(fs.readFileSync(r.file));
  log.push(`  demo_corridor.glb: ${r.bytes} bytes, ${r.triangles} tris, lightmap ${r.lightmap.size.join('x')} (${r.lightmap.charts} charts) bake ${r.bake_ms} ms, ${r.probes.count} probes in ${r.probes.ms} ms, valid ${v.ok}`);
}
// ---------- 7. POM vs flat ----------
{
  const tiles = (mat) => Array.from({ length: 8 }, (_, k) => ({ type: 'box', w: 16, h: 4, d: 16, texture: 'hull', material: mat, at: [-56, 0, -56 + k * 16], array: { count: 8, step: [16, 0, 0] } }));
  const def = { parts: tiles({ preset: 'painted_hull', height: { scale: 3 } }) };
  const b = buildOf(def);
  const cam = { pos: [-6, 14, 40], look: [2, 4, 0], fov: 50 };
  sheet('pom.png', [{ img: shoot(groupsOf(b.mesh), cam), label: 'flat (normal map)' }, { img: shoot(groupsOf(b.mesh), cam, { pom: true }), label: 'parallax (pixel-snapped)' }, { img: shoot(groupsOf(b.mesh), cam, { channel: 'height' }), label: 'height' }, { img: shoot(groupsOf(b.mesh), cam, { channel: 'normal' }), label: 'normal' }], 'parallax occlusion mapping vs flat, grazing view, 3 px depth');
  exportDemo('demo_pom', def);
}
// ---------- 8. detail map on vs off ----------
{
  const def = { parts: Array.from({ length: 8 }, (_, k) => ({ type: 'box', w: 16, h: 4, d: 16, texture: 'hull', material: { preset: 'painted_hull', detail: { texture: 'grit', scale: 8, strength: 0.6 } }, at: [-56, 0, -56 + k * 16], array: { count: 8, step: [16, 0, 0] } })) };
  const b = buildOf(def);
  const cam = { pos: [0, 16, 22], look: [3, 4, 4], fov: 50 };
  sheet('detail.png', [{ img: shoot(groupsOf(b.mesh), cam, { noDetail: true }), label: 'detail off' }, { img: shoot(groupsOf(b.mesh), cam), label: 'detail on' }, { img: shoot(groupsOf(b.mesh), cam, { channel: 'detail' }), label: 'detail' }, { img: shoot(groupsOf(b.mesh), cam, { channel: 'albedo' }), label: 'albedo' }], 'tiling detail map (scale 8, strength 0.6) on a hull plate seen from 9 px away');
  exportDemo('demo_detail', def);
}
console.log(log.join('\n'));
console.log('corridor bake:', JSON.stringify(corridorStats));
