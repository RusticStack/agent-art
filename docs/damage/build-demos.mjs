// Rebuilds the damage + destruction demo renders in docs/damage/:
//   node docs/damage/build-demos.mjs [out dir]
// Interactables (crate, door, terminal, hull panel, barrel, glass pane, light, console, engine
// pod) at intact -> scuffed -> damaged -> wrecked, fracture exploded views in chunk colours, the
// blend mask channels, and a sprite helmet / armour plate damage overlay in three views. Every
// texture, model and effect is made with Agent Art's own ops. Prints stats (demo-stats.json).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Engine } from '../../src/engine.js';
import { packImages } from '../../src/sheet.js';
import { encodePNG, decodePNG } from '../../src/png.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(process.argv[2] || here);
fs.mkdirSync(OUT, { recursive: true });
const e = new Engine({ home: fs.mkdtempSync(path.join(os.tmpdir(), 'aa-dmg-demo-')) });
const draw = (canvas, commands, layer) => e.run('draw', { canvas, commands, ...(layer ? { layer } : {}) });
const stats = { models: {}, fracture: {}, exports: {}, sprite: {} };
const t00 = performance.now();

// ---------- textures (pixel art, drawn with ops) ----------
e.run('create', { name: 'plank', width: 16 });
draw('plank', [
  { op: 'noise', colors: ['#7a5630', '#835d34', '#8c6538'], scale: 3, seed: 2 },
  { op: 'rect', x: 0, y: 7, w: 16, h: 1, color: '#4e341b' }, { op: 'rect', x: 0, y: 15, w: 16, h: 1, color: '#4e341b' },
  { op: 'rect', x: 0, y: 0, w: 16, h: 1, color: '#9a7242' }, { op: 'rect', x: 0, y: 8, w: 16, h: 1, color: '#9a7242' },
  { op: 'pixels', points: [[3, 3], [11, 11], [12, 4]], color: '#5e4022' },
]);
e.run('create', { name: 'hull', width: 32 });
draw('hull', [
  { op: 'noise', colors: ['#5b626d', '#626974', '#686f7a'], scale: 4, seed: 3 },
  { op: 'line', x1: 0, y1: 0, x2: 31, y2: 0, color: '#2a2e35' }, { op: 'line', x1: 0, y1: 0, x2: 0, y2: 31, color: '#2a2e35' },
  { op: 'line', x1: 16, y1: 1, x2: 16, y2: 15, color: '#30353c' }, { op: 'line', x1: 1, y1: 16, x2: 31, y2: 16, color: '#30353c' },
  { op: 'line', x1: 1, y1: 1, x2: 31, y2: 1, color: '#767d88' }, { op: 'line', x1: 1, y1: 17, x2: 31, y2: 17, color: '#717883' },
  { op: 'pixels', points: [[3, 3], [28, 3], [3, 28], [28, 28]], color: '#8e95a0' },
]);
e.run('create', { name: 'paint', width: 16 });
draw('paint', [{ op: 'noise', colors: ['#3f5a73', '#44607a', '#4a6680'], scale: 3, seed: 4 }, { op: 'rect', x: 0, y: 0, w: 16, h: 16, color: '#2c3e50', fill: false }]);
e.run('create', { name: 'hazard', width: 8 });
draw('hazard', [{ op: 'rect', x: 0, y: 0, w: 8, h: 8, color: '#d9a028' }, { op: 'polygon', points: [[0, 0], [3, 0], [7, 4], [7, 7], [0, 0]], color: '#1e1e22' }, { op: 'polygon', points: [[0, 4], [3, 7], [0, 7]], color: '#1e1e22' }]);
e.run('create', { name: 'screen', width: 16, height: 12 });
draw('screen', [{ op: 'rect', x: 0, y: 0, w: 16, h: 12, color: '#0c2a30' }, { op: 'line', x1: 2, y1: 3, x2: 11, y2: 3, color: '#5fe0c8' }, { op: 'line', x1: 2, y1: 6, x2: 8, y2: 6, color: '#3fb8a8' }, { op: 'line', x1: 2, y1: 9, x2: 13, y2: 9, color: '#3fb8a8' }, { op: 'rect', x: 12, y: 5, w: 2, h: 2, color: '#f0c040' }]);
e.run('layer', { canvas: 'screen', action: 'add', name: 'emissive' });
draw('screen', [{ op: 'rect', x: 0, y: 0, w: 16, h: 12, color: '#0a2228' }, { op: 'line', x1: 2, y1: 3, x2: 11, y2: 3, color: '#5fe0c8' }, { op: 'line', x1: 2, y1: 6, x2: 8, y2: 6, color: '#3fb8a8' }, { op: 'line', x1: 2, y1: 9, x2: 13, y2: 9, color: '#3fb8a8' }, { op: 'rect', x: 12, y: 5, w: 2, h: 2, color: '#f0c040' }], 'emissive');
e.run('create', { name: 'lamp', width: 8 });
draw('lamp', [{ op: 'rect', x: 0, y: 0, w: 8, h: 8, color: '#fff2c0' }]);
e.run('layer', { canvas: 'lamp', action: 'add', name: 'emissive' });
draw('lamp', [{ op: 'rect', x: 0, y: 0, w: 8, h: 8, color: '#ffe8a0' }], 'emissive');
e.run('create', { name: 'pane', width: 8 });
draw('pane', [{ op: 'rect', x: 0, y: 0, w: 8, h: 8, color: '#9fd4e8' }, { op: 'line', x1: 1, y1: 6, x2: 6, y2: 1, color: '#d8f2fa' }]);

// ---------- models ----------
const M = (name, parts, more = {}) => e.run('model_create', { name, origin: 'bottom', parts, ...more });
M('crate', [
  { type: 'box', id: 'body', w: 24, h: 24, d: 24, texture: 'plank' },
  { type: 'box', id: 'plate_front', w: 16, h: 16, d: 1, at: [0, 4, 12.5], texture: 'paint' },
  { type: 'box', id: 'plate_side', w: 1, h: 16, d: 16, at: [12.5, 4, 0], texture: 'paint' },
  { type: 'box', w: 26, h: 2, d: 26, at: [0, 22.5, 0], color: '#4a4f57' },
  { type: 'box', w: 26, h: 2, d: 26, at: [0, -0.5, 0], color: '#4a4f57' },
]);
M('door', [
  { type: 'box', id: 'post_l', w: 4, h: 44, d: 6, at: [-16, 0, 0], texture: 'hull' },
  { type: 'box', id: 'post_r', w: 4, h: 44, d: 6, at: [16, 0, 0], texture: 'hull' },
  { type: 'box', id: 'lintel', w: 36, h: 4, d: 6, at: [0, 44, 0], texture: 'hull' },
  { type: 'box', id: 'leaf', w: 28, h: 43, d: 2, at: [0, 0.5, 0], texture: 'paint' },
  { type: 'box', id: 'stripe', w: 28, h: 3, d: 2.4, at: [0, 6, 0], texture: 'hazard' },
  { type: 'box', id: 'window', w: 10, h: 8, d: 2.6, at: [0, 28, 0], texture: 'pane', glass: true },
]);
M('terminal', [
  { type: 'box', id: 'base', w: 14, h: 26, d: 12, texture: 'paint' },
  { type: 'box', id: 'head', w: 20, h: 16, d: 6, at: [0, 26, 1], rotate: [-15, 0, 0], texture: 'hull' },
  { type: 'box', id: 'display', w: 16, h: 12, d: 1, at: [0, 28, 4.6], rotate: [-15, 0, 0], texture: 'screen' },
  { type: 'box', id: 'keys', w: 16, h: 1, d: 6, at: [0, 24, 8], rotate: [20, 0, 0], color: '#2c3038' },
  { type: 'cylinder', id: 'mast', r: 0.7, h: 12, at: [8, 38, -1], color: '#9aa0a8' },
]);
M('hull_panel', [
  { type: 'box', id: 'hull', w: 64, h: 40, d: 16, texture: 'hull' },
  { type: 'box', id: 'plate_a', w: 18, h: 12, d: 1, at: [-18, 22, 8.5], texture: 'paint' },
  { type: 'box', id: 'plate_b', w: 14, h: 10, d: 1, at: [16, 8, 8.5], texture: 'paint' },
  { type: 'tube', path: [[-30, 36, 9.5], [30, 36, 9.5]], r: 1.2, sides: 6, color: '#8a6a3a' },
  { type: 'box', w: 64, h: 2, d: 1, at: [0, 3, 8.5], texture: 'hazard' },
]);
M('barrel', [
  { type: 'cylinder', id: 'drum', r: 9, h: 26, segments: 14, texture: 'paint' },
  { type: 'cylinder', r: 9.6, h: 1.6, segments: 14, at: [0, 4, 0], color: '#3a3e45' },
  { type: 'cylinder', r: 9.6, h: 1.6, segments: 14, at: [0, 20, 0], color: '#3a3e45' },
  { type: 'cylinder', id: 'cap', r: 2, h: 1, at: [4, 26, 2], color: '#a03a2a' },
]);
M('glass_pane', [
  { type: 'box', w: 40, h: 3, d: 4, at: [0, 0, 0], texture: 'hull' },
  { type: 'box', w: 40, h: 3, d: 4, at: [0, 29, 0], texture: 'hull' },
  { type: 'box', w: 3, h: 26, d: 4, at: [-18.5, 3, 0], texture: 'hull' },
  { type: 'box', w: 3, h: 26, d: 4, at: [18.5, 3, 0], texture: 'hull' },
  { type: 'box', id: 'pane', w: 34, h: 26, d: 1, at: [0, 3, 0], texture: 'pane', glass: true },
]);
M('light', [
  { type: 'box', id: 'housing', w: 20, h: 6, d: 10, texture: 'hull' },
  { type: 'box', id: 'lens', w: 16, h: 4, d: 1, at: [0, 1, 5.5], texture: 'lamp' },
  { type: 'box', id: 'bracket', w: 24, h: 10, d: 2, at: [0, -2, -6], color: '#3a3e45' },
]);
M('console', [
  { type: 'box', id: 'desk', w: 40, h: 16, d: 14, texture: 'paint' },
  { type: 'box', id: 'top', w: 42, h: 2, d: 16, at: [0, 16, 0], texture: 'hull' },
  { type: 'box', id: 'scr_l', w: 14, h: 10, d: 1, at: [-10, 19, -4], rotate: [-10, 0, 0], texture: 'screen' },
  { type: 'box', id: 'scr_r', w: 14, h: 10, d: 1, at: [10, 19, -4], rotate: [-10, 0, 0], texture: 'screen' },
  { type: 'box', w: 30, h: 8, d: 2, at: [0, 18, -5.5], color: '#2c3038' },
]);
M('engine_pod', [
  { type: 'cylinder', id: 'nacelle', r: 10, h: 40, segments: 12, rotate: [90, 0, 0], at: [0, 12, -20], texture: 'hull' },
  { type: 'cylinder', id: 'nozzle', r_bottom: 8, r_top: 10.5, h: 10, segments: 12, rotate: [90, 0, 0], at: [0, 12, 20], color: '#3a3e45' },
  { type: 'box', id: 'fin_t', w: 1.5, h: 10, d: 18, at: [0, 21, -6], texture: 'paint' },
  { type: 'box', id: 'fin_l', w: 10, h: 1.5, d: 18, at: [-14, 11.25, -6], texture: 'paint' },
  { type: 'box', id: 'fin_r', w: 10, h: 1.5, d: 18, at: [14, 11.25, -6], texture: 'paint' },
  { type: 'cylinder', id: 'probe', r: 0.6, h: 14, at: [0, 22, -16], color: '#9aa0a8' },
]);

// ---------- damage states ----------
const KINDS = { crate: 'crate', door: 'door', terminal: 'terminal', hull_panel: 'hull', barrel: 'barrel', glass_pane: 'glass', light: 'light', console: 'console', engine_pod: 'engine' };
const sheets = {};
for (const [name, kind] of Object.entries(KINDS)) {
  const t0 = performance.now();
  const r = e.run('model_damage', { name, kind, seed: 7, states: ['scuffed', 'damaged', 'wrecked'], ...(kind === 'door' ? { roles: { leaf: ['leaf'] } } : {}), size: 160 });
  stats.models[name] = { kind, ms: Math.round(performance.now() - t0), states: r.states.map((s) => ({ name: s.name, triangles: s.triangles, features: s.features, sockets: s.sockets })) };
  sheets[name] = decodePNG(r.image);
}
const stack = (names, file) => {
  const items = names.map((n) => ({ img: sheets[n], label: n }));
  const img = packImages(items, { labels: true, checker: false, columns: 1 });
  fs.writeFileSync(path.join(OUT, file), encodePNG(img.width, img.height, img.data));
};
stack(['crate', 'door', 'terminal', 'hull_panel'], 'interactables.png');
stack(['barrel', 'glass_pane', 'light', 'console', 'engine_pod'], 'interactables_more.png');
// a close look at the hull breach + wrecked engine pod
for (const [name, file] of [['hull_panel', 'hull_breach.png'], ['engine_pod', 'engine_wrecked.png']]) {
  const p = e.run('model_preview', { name, damage: 'wrecked', views: ['game', 'front', 'side'], size: 256 });
  fs.writeFileSync(path.join(OUT, file), p.image);
}

// ---------- fracture ----------
const fr = [];
for (const [name, groups] of [
  ['crate', [{ part: 'body', pieces: 10, seed: 3, inside: '#3a2814', debris: 2 }]],
  ['door', [{ part: 'leaf', pieces: 8, method: 'slice', seed: 5, inside: '#2a2e35' }, { part: 'window', pieces: 6, seed: 2, inside: '#6fa4b8', parent: 'leaf' }]],
]) {
  const t0 = performance.now();
  const r = e.run('model_fracture', { name, groups, size: 256 });
  stats.fracture[name] = { ms: Math.round(performance.now() - t0), groups: r.groups };
  fr.push({ img: decodePNG(r.image), label: name });
}
{ const img = packImages(fr, { labels: true, checker: false, columns: 1 }); fs.writeFileSync(path.join(OUT, 'fracture_exploded.png'), encodePNG(img.width, img.height, img.data)); }

// ---------- export: state nodes + LODs + masks (+ the Roblox profile) ----------
const ex = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-dmg-export-'));
for (const name of ['crate', 'hull_panel', 'terminal']) {
  const t0 = performance.now();
  const r = e.run('model_export', { name, path: path.join(ex, `${name}.glb`), lods: [1, 0.5, 0.25], damage: { mask_channels: true, vertex: true } });
  const rb = e.run('model_export', { name, path: path.join(ex, 'roblox', `${name}.glb`), damage: { profile: 'roblox' } });
  stats.exports[name] = { ms: Math.round(performance.now() - t0), plain_bytes: r.bytes, damage: r.damage, roblox: rb.damage.glbs };
}
// mask channels of the hull panel: packed RGBA + R scorch, G dent, B holes, A wear
{
  const items = [];
  const big = (png, label) => { const d = decodePNG(png); const k = Math.max(1, Math.floor(256 / Math.max(d.width, d.height))); const W = d.width * k, H = d.height * k, o = new Uint8ClampedArray(W * H * 4); for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const s = (Math.floor(y / k) * d.width + Math.floor(x / k)) * 4; o.set([d.data[s], d.data[s + 1], d.data[s + 2], 255], (y * W + x) * 4); } items.push({ img: { width: W, height: H, data: o }, label }); };
  big(fs.readFileSync(path.join(ex, 'hull_panel.damage_mask.png')), 'rgb (packed)');
  for (const [c, l] of [['r', 'R scorch'], ['g', 'G dent'], ['b', 'B holes'], ['a', 'A wear']]) big(fs.readFileSync(path.join(ex, `hull_panel.damage_mask_${c}.png`)), l);
  const img = packImages(items, { labels: true, checker: false, columns: 5 });
  fs.writeFileSync(path.join(OUT, 'mask_channels.png'), encodePNG(img.width, img.height, img.data));
}
// blend sweep: the same seeded feature set at growing amounts (what the masks + morph encode)
{
  e.run('model_damage', { name: 'hull_panel', states: [{ name: 'b20', amount: 0.2 }, { name: 'b40', amount: 0.4 }, { name: 'b60', amount: 0.6 }, { name: 'b80', amount: 0.8 }, { name: 'b100', amount: 1 }], kind: 'hull', seed: 7, size: 144 });
  const r = e.run('model_damage', { name: 'hull_panel', size: 144 });
  fs.writeFileSync(path.join(OUT, 'hull_blend_sweep.png'), r.image);
}

// ---------- sprite armour: helmet + chest plate in three views, damage overlay by amount ----------
const H = 24;
e.run('create', { name: 'armour', width: H, height: H, frames: 3 });
const plate = ['#2e3640', '#3c4652', '#5a6878', '#7a8898', '#a4b0bc'];
const visor = '#4fc8e8';
const viewsCmd = [
  // front: helmet dome + visor, chest plate
  [{ op: 'ellipse', x: 6, y: 1, w: 12, h: 11, color: plate[2] }, { op: 'rect', x: 8, y: 5, w: 8, h: 3, color: visor }, { op: 'rect', x: 5, y: 12, w: 14, h: 11, color: plate[2] }, { op: 'rect', x: 11, y: 13, w: 2, h: 9, color: plate[1] }],
  // side
  [{ op: 'ellipse', x: 7, y: 1, w: 11, h: 11, color: plate[2] }, { op: 'rect', x: 15, y: 5, w: 3, h: 3, color: visor }, { op: 'rect', x: 8, y: 12, w: 9, h: 11, color: plate[2] }],
  // back
  [{ op: 'ellipse', x: 6, y: 1, w: 12, h: 11, color: plate[2] }, { op: 'rect', x: 5, y: 12, w: 14, h: 11, color: plate[2] }, { op: 'rect', x: 8, y: 14, w: 8, h: 6, color: plate[1] }],
];
viewsCmd.forEach((cmds, f) => e.run('draw', { canvas: 'armour', frame: f, commands: [...cmds, { op: 'shade', colors: plate, of: plate[2] }, { op: 'outline', color: '#161a20' }] }));
const base = e.get('armour').composite();
const palette0 = new Set();
for (let i = 0; i < base.length; i += 4) if (base[i + 3]) palette0.add((base[i] << 16) | (base[i + 1] << 8) | base[i + 2]);
const amounts = [0, 0.25, 0.6, 1];
const cells = [];
for (const am of amounts) {
  e.run('duplicate', { canvas: 'armour', new_name: `armour_${am}` });
  if (am) for (let f = 0; f < 3; f++) e.run('draw', { canvas: `armour_${am}`, frame: f, commands: [{ op: 'damage', amount: am, seed: 9, on: plate }] });
  const d = e.get(`armour_${am}`).composite();
  let extra = 0;
  for (let i = 0; i < d.length; i += 4) if (d[i + 3] && !palette0.has((d[i] << 16) | (d[i + 1] << 8) | d[i + 2])) extra++;
  stats.sprite[`amount_${am}`] = { off_palette_pixels: extra };
  for (let f = 0; f < 3; f++) {
    const k = 6, W = H * k, o = new Uint8ClampedArray(W * W * 4);
    for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) { const s = ((f * H + Math.floor(y / k)) * H + Math.floor(x / k)) * 4; const a = d[s + 3]; o.set(a ? [d[s], d[s + 1], d[s + 2], 255] : [34, 38, 46, 255], (y * W + x) * 4); }
    cells.push({ img: { width: W, height: W, data: o }, label: `${['front', 'side', 'back'][f]} ${am}` });
  }
}
{ const img = packImages(cells, { labels: true, checker: false, columns: 6 }); fs.writeFileSync(path.join(OUT, 'sprite_armour.png'), encodePNG(img.width, img.height, img.data)); }

stats.total_ms = Math.round(performance.now() - t00);
fs.writeFileSync(path.join(OUT, 'demo-stats.json'), JSON.stringify(stats, null, 1) + '\n');
console.log(JSON.stringify({ total_ms: stats.total_ms, models: Object.fromEntries(Object.entries(stats.models).map(([k, v]) => [k, v.states.map((s) => s.triangles)])) }));
