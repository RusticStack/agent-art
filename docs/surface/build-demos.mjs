// Rebuilds the 0.7 hard-surface demo renders in docs/surface/:
//   node docs/surface/build-demos.mjs [out dir]
// A spaceship hull section and a carrier corridor module, before / after (greebles, trim sheet,
// PBR, height normals, baked AO), LOD0/1/2 and the impostor atlas. Prints triangles and timings.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Engine } from '../../src/engine.js';
import { buildModel } from '../../src/model3d.js';
import { texResolver } from '../../src/modelops.js';
import { renderViews, renderCamera, makeCamera } from '../../src/raster3d.js';
import { bakeAO } from '../../src/bake.js';
import { simplifyMesh } from '../../src/lod.js';
import { greeblePiece } from '../../src/greeble.js';
import { packImages } from '../../src/sheet.js';
import { encodePNG, decodePNG } from '../../src/png.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(process.argv[2] || here);
fs.mkdirSync(OUT, { recursive: true });
const e = new Engine({ home: fs.mkdtempSync(path.join(os.tmpdir(), 'aa-demo-')) });
const draw = (canvas, commands, layer) => e.run('draw', { canvas, commands, ...(layer ? { layer } : {}) });
const log = [];

// ---------- textures ----------
e.run('create', { name: 'hull_plate', width: 32 });
draw('hull_plate', [
  { op: 'noise', colors: ['#5b626d', '#626974', '#686f7a'], scale: 4, seed: 3 },
  { op: 'line', x1: 0, y1: 0, x2: 31, y2: 0, color: '#2a2e35' }, { op: 'line', x1: 0, y1: 0, x2: 0, y2: 31, color: '#2a2e35' },
  { op: 'line', x1: 16, y1: 1, x2: 16, y2: 15, color: '#30353c' }, { op: 'line', x1: 1, y1: 16, x2: 31, y2: 16, color: '#30353c' },
  { op: 'line', x1: 1, y1: 1, x2: 31, y2: 1, color: '#767d88' }, { op: 'line', x1: 1, y1: 17, x2: 31, y2: 17, color: '#717883' },
  { op: 'pixels', points: [[3, 3], [28, 3], [3, 28], [28, 28], [13, 3], [19, 3]], color: '#8e95a0' },
]);
// a flat copy (no data layers) for the "before" renders
e.run('duplicate', { canvas: 'hull_plate', new_name: 'hull_flat' });
for (const l of ['height', 'metal', 'rough']) e.run('layer', { canvas: 'hull_plate', action: 'add', name: l });
draw('hull_plate', [
  { op: 'rect', x: 0, y: 0, w: 32, h: 32, color: '#bfbfbf' }, { op: 'line', x1: 0, y1: 0, x2: 31, y2: 0, color: '#000000' }, { op: 'line', x1: 0, y1: 0, x2: 0, y2: 31, color: '#000000' },
  { op: 'line', x1: 16, y1: 1, x2: 16, y2: 15, color: '#404040' }, { op: 'line', x1: 1, y1: 16, x2: 31, y2: 16, color: '#404040' },
  { op: 'pixels', points: [[3, 3], [28, 3], [3, 28], [28, 28], [13, 3], [19, 3]], color: '#ffffff' },
], 'height');
draw('hull_plate', [{ op: 'rect', x: 0, y: 0, w: 32, h: 32, color: '#383838' }, { op: 'pixels', points: [[3, 3], [28, 3], [3, 28], [28, 28], [13, 3], [19, 3]], color: '#e6e6e6' }], 'metal');
draw('hull_plate', [{ op: 'rect', x: 0, y: 0, w: 32, h: 32, color: '#8a8a8a' }, { op: 'line', x1: 0, y1: 0, x2: 31, y2: 0, color: '#d8d8d8' }, { op: 'line', x1: 0, y1: 0, x2: 0, y2: 31, color: '#d8d8d8' }], 'rough');

e.run('create', { name: 'deck', width: 32 });
draw('deck', [{ op: 'noise', colors: ['#464b53', '#4c5159', '#51565e'], scale: 3, seed: 5 }, { op: 'rect', x: 0, y: 0, w: 32, h: 32, color: '#2c3036', fill: false }, { op: 'rect', x: 16, y: 0, w: 1, h: 32, color: '#2c3036' }, { op: 'bevel', light: '#5c626b', dark: '#33373e', size: 1, region: { x: 1, y: 1, w: 15, h: 30 } }, { op: 'bevel', light: '#5c626b', dark: '#33373e', size: 1, region: { x: 17, y: 1, w: 15, h: 30 } }]);
e.run('duplicate', { canvas: 'deck', new_name: 'deck_flat' });
e.run('layer', { canvas: 'deck', action: 'add', name: 'height' });
draw('deck', [{ op: 'rect', x: 0, y: 0, w: 32, h: 32, color: '#ffffff' }, { op: 'rect', x: 0, y: 0, w: 32, h: 32, color: '#000000', fill: false }, { op: 'rect', x: 16, y: 0, w: 1, h: 32, color: '#000000' }], 'height');
e.run('meta', { canvas: 'deck', meta: { material: { metal: 0.6, rough: 0.5 } } });

e.run('create', { name: 'glow', width: 8 });
draw('glow', [{ op: 'rect', x: 0, y: 0, w: 8, h: 8, color: '#8fe0ff' }]);
e.run('layer', { canvas: 'glow', action: 'add', name: 'emissive' });
draw('glow', [{ op: 'rect', x: 0, y: 0, w: 8, h: 8, color: '#7fd8ff' }], 'emissive');
e.run('model_trim', { canvas: 'hull_trim', colors: { base: '#5a606a', light: '#8a909a', dark: '#2c3036', accent: '#d09a28', glow: '#7fd8ff' } });

// ---------- spaceship hull section ----------
const hullBase = [
  { type: 'box', id: 'hull', w: 160, h: 40, d: 96, texture: 'hull_flat' },
  { type: 'box', w: 28, h: 10, d: 96, at: [0, 40, 0], texture: 'hull_flat' },
  { type: 'box', w: 52, h: 22, d: 30, at: [0, 0, 36], boolean: 'subtract', target: 'hull' },
  { type: 'cylinder', r_bottom: 9, r_top: 7, h: 14, segments: 12, rotate: [-90, 0, 0], at: [-50, 20, -48], mirror: 'x', color: '#4a4f57' },
  { type: 'cylinder', r: 5, h: 2, segments: 12, rotate: [-90, 0, 0], at: [-50, 20, -61], mirror: 'x', texture: 'glow' },
];
const hullAfter = [
  { type: 'box', id: 'hull', w: 160, h: 40, d: 96, bevel: 3, texture: 'hull_plate', material: 'painted_metal', trim: 'hull_trim:bevel', greebles: [
    { face: 'top', seed: 11, grid: 2, density: 0.35, size: [4, 16], height: [1, 4], avoid: [[64, 0, 32, 96]], texture: 'hull_flat', dark: '#3a3f47', accent: '#c8902a' },
    { face: 'right', seed: 12, density: 0.4, size: [2, 8], height: [0.5, 2.5], kinds: { vent: 3, pipe: 2, bolts: 2, panel: 3, heatsink: 1, hatch: 1 }, avoid: [[0, 7, 96, 6], [0, 25, 96, 5]], texture: 'hull_flat', dark: '#3a3f47', accent: '#c8902a' },
    { face: 'left', seed: 13, density: 0.4, size: [2, 8], height: [0.5, 2.5], kinds: { vent: 3, pipe: 2, bolts: 2, panel: 3, heatsink: 1, hatch: 1 }, avoid: [[0, 7, 96, 6], [0, 25, 96, 5]], texture: 'hull_flat', dark: '#3a3f47', accent: '#c8902a' },
  ] },
  { type: 'box', w: 28, h: 10, d: 96, at: [0, 40, 0], bevel: 2, texture: 'hull_plate', material: 'painted_metal', trim: 'hull_trim:bevel' },
  { type: 'box', w: 52, h: 22, d: 30, at: [0, 0, 36], boolean: 'subtract', target: 'hull' },
  { type: 'box', w: 50, h: 1.5, d: 2, at: [0, 20.5, 21.5], trim: { sheet: 'hull_trim', strip: 'light', faces: 'all' } },
  { type: 'box', w: 50, h: 2, d: 1, at: [0, 0, 47], trim: { sheet: 'hull_trim', strip: 'hazard', faces: 'all' } },
  { type: 'cylinder', r_bottom: 9, r_top: 7, h: 14, segments: 12, rotate: [-90, 0, 0], at: [-50, 20, -48], mirror: 'x', color: '#4a4f57', material: 'bare_metal' },
  { type: 'cylinder', r: 5, h: 2, segments: 12, rotate: [-90, 0, 0], at: [-50, 20, -61], mirror: 'x', texture: 'glow', material: 'emissive_panel' },
  { type: 'tube', path: [[-78, 30, 44], [-82, 30, 44], [-82, 30, -40], [-60, 30, -46]], r: 2, sides: 8, trim: 'hull_trim:pipe', mirror: 'x' },
  { type: 'tube', path: [[-82, 12, 40], [-83, 12, 40], [-83, 12, -44]], r: 1.25, sides: 6, trim: 'hull_trim:pipe', mirror: 'x' },
  { type: 'tube', from: [-12, 50, 30], to: [-12, 50, -30], sag: 3, r: 0.6, sides: 4, color: '#24272c', mirror: 'x' },
];
e.run('model_create', { name: 'hull_before', parts: hullBase, origin: 'bottom' });
e.run('model_create', { name: 'hull_after', parts: hullAfter, origin: 'bottom' });

// ---------- carrier corridor module ----------
const corrBase = [
  { type: 'floor', w: 64, d: 128, texture: 'deck_flat' },
  { type: 'box', w: 4, h: 48, d: 128, at: [-34, 0, 0], texture: 'hull_flat' },
  { type: 'box', w: 4, h: 48, d: 128, at: [34, 0, 0], texture: 'hull_flat' },
  { type: 'box', w: 72, h: 4, d: 128, at: [0, 48, 0], texture: 'hull_flat' },
  { type: 'box', id: 'bulkhead', w: 72, h: 52, d: 4, at: [0, 0, -66], texture: 'hull_flat' },
  { type: 'box', w: 24, h: 36, d: 8, at: [0, 0, -66], boolean: 'subtract', target: 'bulkhead' },
];
const rib = (z) => [
  { type: 'box', w: 6, h: 48, d: 4, at: [-29, 0, z], bevel: 1, color: '#4a4f57', material: 'bare_metal', trim: 'hull_trim:rib' },
  { type: 'box', w: 6, h: 48, d: 4, at: [29, 0, z], bevel: 1, color: '#4a4f57', material: 'bare_metal', trim: 'hull_trim:rib' },
  { type: 'box', w: 64, h: 5, d: 4, at: [0, 43, z], bevel: 1, color: '#4a4f57', material: 'bare_metal', trim: 'hull_trim:rib' },
];
const corrAfter = [
  { type: 'floor', w: 64, d: 128, texture: 'deck' },
  { type: 'box', w: 16, h: 0.5, d: 128, at: [0, 0, 0], trim: { sheet: 'hull_trim', strip: 'grate', faces: 'all' } },
  { type: 'box', w: 2, h: 0.6, d: 128, at: [-25, 0, 0], trim: { sheet: 'hull_trim', strip: 'hazard', faces: 'all' }, mirror: 'x' },
  { type: 'box', w: 4, h: 48, d: 128, at: [-34, 0, 0], texture: 'hull_plate', material: 'painted_metal', insets: [{ face: 'right', rect: [8, 10, 112, 22], depth: 1.5 }] },
  { type: 'box', w: 4, h: 48, d: 128, at: [34, 0, 0], texture: 'hull_plate', material: 'painted_metal', insets: [{ face: 'left', rect: [8, 10, 112, 22], depth: 1.5 }] },
  { type: 'box', w: 72, h: 4, d: 128, at: [0, 48, 0], texture: 'hull_plate', material: 'painted_metal' },
  ...[-48, -16, 16, 48].flatMap(rib),
  { type: 'box', w: 6, h: 1, d: 120, at: [0, 47, 0], trim: { sheet: 'hull_trim', strip: 'light', faces: 'all' } },
  { type: 'greeble', w: 20, d: 110, at: [-30.5, 21, 0], rotate: [0, 0, -90], seed: 21, density: 0.6, size: [2, 7], height: [0.5, 2], kinds: { vent: 3, bolts: 2, panel: 3, block: 2, heatsink: 1 }, texture: 'hull_flat', dark: '#2f3339', accent: '#c8902a', mirror: 'x', avoid: [-48, -16, 16, 48].map((z) => [0, z + 52, 20, 6]) },
  // far bulkhead: a doorway cut with a boolean, a recessed door behind it
  { type: 'box', id: 'bulkhead', w: 72, h: 52, d: 4, at: [0, 0, -66], bevel: 1, texture: 'hull_plate', material: 'painted_metal', trim: 'hull_trim:bevel' },
  { type: 'box', w: 24, h: 36, d: 8, at: [0, 0, -66], boolean: 'subtract', target: 'bulkhead' },
  { type: 'box', w: 28, h: 2, d: 5, at: [0, 36, -66], trim: { sheet: 'hull_trim', strip: 'hazard', faces: 'all' } },
  { type: 'box', w: 24, h: 36, d: 1, at: [0, 0, -69], texture: 'hull_plate', material: 'painted_metal', insets: [{ face: 'front', rect: [2, 2, 20, 32], depth: -0.5, texture: 'hull_flat' }] },
  { type: 'tube', path: [[-27, 40, 64], [-27, 40, -40], [-27, 34, -52], [-27, 34, -64]], r: 1.6, sides: 8, trim: 'hull_trim:pipe', mirror: 'x' },
  { type: 'tube', path: [[-28, 37, 64], [-28, 37, -64]], r: 1, sides: 6, trim: 'hull_trim:pipe', mirror: 'x' },
  ...[-32, 0, 32].map((z) => ({ type: 'tube', from: [-20, 42.5, z - 14], to: [-20, 42.5, z + 14], sag: 4, r: 0.5, sides: 4, color: '#1f2226', mirror: 'x' })),
];
e.run('model_create', { name: 'corr_before', parts: corrBase });
e.run('model_create', { name: 'corr_after', parts: corrAfter });

// ---------- renders ----------
const ctx = { tex: texResolver(e), getModel: (n) => e.models.get(n) };
const built = (n) => buildModel(e.models.get(n), ctx).mesh;
const groups = (m) => [...m.groups.values()].filter((g) => g.idx.length);
const HULL_VIEW = { yaw: 35, pitch: 28, perspective: true, fov: 30, label: '3/4' };
const shot = (mesh, view, S) => {
  if (view.pos) { const img = renderCamera(groups(mesh), makeCamera(view, S, S, [], { fov: view.fov }), S, S); return img; }
  const r = renderViews(groups(mesh), { views: [view], size: S, labels: false });
  return r;
};
const sheet = (items, file, columns) => {
  const img = packImages(items, { labels: true, checker: false, columns: columns ?? items.length });
  fs.writeFileSync(path.join(OUT, file), encodePNG(img.width, img.height, img.data));
  log.push(`${file}: ${img.width}x${img.height}`);
};
const t = (label, fn) => { const t0 = performance.now(); const r = fn(); log.push(`${label}: ${Math.round(performance.now() - t0)} ms`); return r; };

const hb = built('hull_before'), ha = built('hull_after');
const haAO = ha.clone();
const aoStats = t('hull AO bake (texture, 24 samples)', () => bakeAO([{ meshes: [haAO] }], { samples: 24 }).stats);
const plainOf = (m) => { const c = m.clone(); for (const g of c.groups.values()) g.tex = { ...g.tex, pbr: null, mr: null, normal: null }; return c; };
sheet([
  { img: shot(hb, HULL_VIEW, 384), label: `BEFORE ${hb.triangles} TRIS` },
  { img: shot(plainOf(ha), HULL_VIEW, 384), label: `+ GREEBLES TRIM ${ha.triangles}` },
  { img: shot(ha, HULL_VIEW, 384), label: '+ PBR + HEIGHT NORMALS' },
  { img: shot(haAO, HULL_VIEW, 384), label: '+ BAKED AO' },
], 'hull_before_after.png', 2);
const CORR_VIEW = { pos: [8, 26, 150], look: [0, 18, 0], fov: 50, label: 'corridor' };
const cb = built('corr_before'), ca = built('corr_after');
const caAO = ca.clone();
const caoStats = t('corridor AO bake (texture, 24 samples)', () => bakeAO([{ meshes: [caAO] }], { samples: 24 }).stats);
sheet([
  { img: shot(cb, CORR_VIEW, 384), label: `BEFORE ${cb.triangles} TRIS` },
  { img: shot(plainOf(ca), CORR_VIEW, 384), label: `+ KIT TRIM GREEBLES ${ca.triangles}` },
  { img: shot(ca, CORR_VIEW, 384), label: '+ PBR + HEIGHT NORMALS' },
  { img: shot(caAO, CORR_VIEW, 384), label: '+ BAKED AO' },
], 'corridor_before_after.png', 2);
// close-up of the normal maps + PBR on the hull roof
sheet([
  { img: shot(plainOf(ha), { yaw: 20, pitch: 55, perspective: true, fov: 14, label: 'roof' }, 384), label: 'ALBEDO ONLY' },
  { img: shot(haAO, { yaw: 20, pitch: 55, perspective: true, fov: 14, label: 'roof' }, 384), label: 'NORMALS PBR AO' },
], 'hull_closeup.png', 2);
// LODs
const lods = [1, 0.5, 0.2].map((r, i) => (i ? t(`hull LOD${i} simplify`, () => simplifyMesh(ha, { ratio: r, level: i })) : { mesh: ha, triangles: ha.triangles, error: 0 }));
sheet(lods.map((l, i) => ({ img: shot(l.mesh, HULL_VIEW, 320), label: `LOD${i} ${l.triangles} TRIS ERR ${l.error.toFixed(1)}PX` })), 'hull_lods.png', 3);
// impostor via a real export
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-demo-x-'));
const x = t('hull export (ao + lods + impostor + collision + occluder)', () => e.run('model_export', { name: 'hull_after', path: path.join(dir, 'hull.glb'), bake_ao: { samples: 24 }, lods: [1, 0.5, 0.2], impostor: { grid: 8, size: 64 }, collision: 'hull', occluder: 'boxes' }));
const xc = t('corridor export (ao + collision boxes)', () => e.run('model_export', { name: 'corr_after', path: path.join(dir, 'corr.glb'), bake_ao: { samples: 24 }, collision: 'boxes', lods: [1, 0.5, 0.25] }));
const big = (f) => { const im = decodePNG(fs.readFileSync(path.join(dir, f))); return { img: im, label: f.replace('hull.', '').replace('.png', '').toUpperCase() }; };
sheet([big('hull.impostor.png'), big('hull.impostor_n.png'), big('hull.impostor_d.png')], 'hull_impostor.png', 3);
// greeble kit sheet
const kinds = ['panel', 'vent', 'pipe', 'conduit', 'antenna', 'bolts', 'hatch', 'heatsink', 'nozzle', 'dome', 'cables', 'tank', 'block'];
const kitItems = kinds.map((k, i) => {
  const [sx, sz] = { pipe: [16, 5], conduit: [12, 8], bolts: [14, 2], cables: [16, 6], tank: [14, 6], heatsink: [12, 10] }[k] || [12, 12];
  const m = greeblePiece(k, sx, sz, 4, { main: 'hull_flat', dark: '#3a3f47', accent: '#c8902a' }, ctx);
  return { img: shot(m, { yaw: 35, pitch: 30, label: k }, 128), label: `${k.toUpperCase()} ${m.triangles}` };
});
sheet(kitItems, 'greeble_kit.png', 7);

const meta = JSON.parse(fs.readFileSync(x.meta, 'utf8'));
const report = {
  hull: { before: hb.triangles, after: ha.triangles, export: { bytes: x.bytes, triangles: x.triangles, materials: x.materials, nodes: x.nodes }, lods: x.lods, ao: aoStats, impostor: x.impostor && { atlas: x.impostor.atlas, cells: x.impostor.cells, switch_distance: x.impostor.switch_distance }, collision: meta.collision && { type: meta.collision.type, triangles: meta.collision.triangles }, occluder: meta.occluder && { boxes: meta.occluder.boxes.length } },
  corridor: { before: cb.triangles, after: ca.triangles, export: { bytes: xc.bytes, triangles: xc.triangles, materials: xc.materials }, lods: xc.lods, ao: caoStats },
  greeble_kit: kitItems.map((k) => k.label),
};
console.log(log.join('\n'));
console.log(JSON.stringify(report, null, 1));
