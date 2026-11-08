// Renders the hand-drawn first-person demos in docs/fp2d/: an SMG drawn as three key drawings with
// Agent Art's own drawing ops (scripts/fp2d-art.js) -> its full sweep grid; hand-drawn arms gripping
// it; and mixed sources (2D gun + 3D arms, 3D gun + 2D arms). Every frame comes from the exported
// files through the runtime compositor (fp_composite), like docs/fp/.
// Usage: node scripts/fp2d-demos.js [assetDir]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Engine } from '../src/engine.js';
import { compositeFromFiles } from '../src/fpops.js';
import { CENTRE, steps } from '../src/fp.js';
import { packImages } from '../src/sheet.js';
import { encodePNG, decodePNG } from '../src/png.js';
import { encodeGIF } from '../src/gif.js';
import { colorsOf } from '../src/fppaint.js';
import { unpackSheets } from '../src/fpsweep.js';
import { GUIDES } from '../src/fp2d.js';
import { drawDemoSet } from './fp2d-art.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOCS = path.join(ROOT, 'docs', 'fp2d');
fs.mkdirSync(DOCS, { recursive: true });
const base = path.resolve(process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'agent-art-fp2d-demo-')));
const e = new Engine({ home: fs.mkdtempSync(path.join(os.tmpdir(), 'agent-art-fp2d-home-')) });
const t0 = performance.now();
const log = (...a) => console.log(`[${((performance.now() - t0) / 1000).toFixed(1)}s]`, ...a);
const BG = [58, 52, 46, 255];
const CLIPS = ['idle', 'ads_idle', 'reload_empty', 'inspect'];

// 1. draw: SMG keys (hip, ads, reload), magazine keys, the "ink" arms skin
const made = drawDemoSet(e);
log('drawn', made.gun.length, 'gun keys,', made.mag.length, 'mag keys,', made.arms.length, 'arm parts');
for (const c of made.gun) log(' anchors', c, JSON.stringify(e.run('fp_anchors', { canvas: c, suggest: true }).warnings || 'ok'));
e.run('fp_trace', { skin: 'mec', name: 'mec2d' });

// 2. sweeps: the drawn gun + magazine, and the 3D kit set for the mixed rows
const roots = { all2d: path.join(base, 'all2d'), gun2d: path.join(base, 'gun2d'), arms2d: path.join(base, 'arms2d'), traced: path.join(base, 'traced') };
const s2 = e.run('fp_sweep2d', { out: roots.all2d });
log('sweep2d', JSON.stringify(Object.fromEntries(Object.entries(s2.sweeps).map(([k, v]) => [k, { cell: v.cell, cells: v.cells, sheets: v.sheets, colors: v.colors, key_colors: v.key_colors, palette_ok: v.palette_ok, ms: v.ms }]))));
e.run('fp_sweep', { out: roots.all2d, guns: ['smg'], mags: ['smg_mag'], attachments: [], items: [] });
for (const r of ['gun2d', 'arms2d', 'traced']) fs.cpSync(roots.all2d, roots[r], { recursive: true });

// 3. arms: all 2D; 2D gun + 3D arms; 3D gun + 2D arms; 3D arms traced to 2D on the 3D gun
const runs = [
  ['all2d', { skins: ['ink'], guns: { smg: 'vandal' } }],
  ['gun2d', { skins: ['mec'], guns: { smg: 'vandal' } }],
  ['arms2d', { skins: ['ink'] }],
  ['traced', { skins: ['mec2d'] }],
];
const report = {};
for (const [tag, o] of runs) {
  const b = e.run('fp_batch', { out: roots[tag], classes: ['smg'], clips: CLIPS, variants: false, ...o });
  const ck = e.run('fp_check', { out: roots[tag], classes: ['smg'] });
  report[tag] = { frames: b.frames, batch_ms: b.ms, ms_per_frame: Math.round((b.ms / b.frames) * 10) / 10, pass: ck.pass, worst: ck.worst, hand_checks: ck.hand_checks, warnings: ck.warnings?.length || 0 };
  log(tag, JSON.stringify(report[tag]), ck.pass ? '' : JSON.stringify(ck.issues?.slice(0, 3)));
}
fs.writeFileSync(path.join(base, 'report.json'), JSON.stringify(report, null, 1));

/** A frame as the game shows it (ADS shift applied and the screen centre marked when asked). */
function frame(root, a, ads = false) {
  const r = compositeFromFiles(root, { ...a, background: null });
  let { data } = r;
  if (ads && r.sight) {
    const dx = Math.round(CENTRE[0] - r.sight[0]), dy = Math.round(CENTRE[1] - r.sight[1]), d = new Uint8ClampedArray(data.length);
    for (let y = 0; y < r.height; y++) for (let x = 0; x < r.width; x++) { const sx = x - dx, sy = y - dy; if (sx < 0 || sy < 0 || sx >= r.width || sy >= r.height) continue; d.set(data.subarray((sy * r.width + sx) * 4, (sy * r.width + sx) * 4 + 4), (y * r.width + x) * 4); }
    data = d;
  }
  const img = new Uint8ClampedArray(data.length);
  for (let i = 0; i < data.length; i += 4) img.set(data[i + 3] ? data.subarray(i, i + 4) : BG, i);
  if (ads) for (const [x, y] of [[0, 0], [-3, 0], [3, 0], [0, -3], [0, 3]]) img.set([255, 255, 255, 255], ((CENTRE[1] + y) * r.width + CENTRE[0] + x) * 4);
  return { width: r.width, height: r.height, data: img, colors: colorsOf(r.data).size };
}
const zoom = (im, k) => { const W = im.width * k, H = im.height * k, d = new Uint8ClampedArray(W * H * 4); for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const s = (Math.floor(y / k) * im.width + Math.floor(x / k)) * 4; d.set(im.data.subarray(s, s + 4), (y * W + x) * 4); } return { width: W, height: H, data: d }; };
function sheet(file, items, columns, k = 1, padBg = false) {
  const s = packImages(items.map((it) => ({ img: k > 1 ? zoom(it.img, k) : it.img, label: it.label })), { labels: true, checker: padBg, columns });
  fs.writeFileSync(path.join(DOCS, file), encodePNG(s.width, s.height, s.data));
  log(file, `${s.width}x${s.height}`);
}
const art = (name) => { const d = e.get(name); return { width: d.width, height: d.height, data: d.composite({ exclude: [GUIDES] }) }; };
const onBg = (im) => { const d = new Uint8ClampedArray(im.data.length); for (let i = 0; i < d.length; i += 4) d.set(im.data[i + 3] ? im.data.subarray(i, i + 4) : BG, i); return { ...im, data: d }; };

// a. the drawings (what a person or agent draws)
sheet('keys.png', [...made.gun.map((n) => ({ img: onBg(art(n)), label: n })), ...made.mag.map((n) => ({ img: onBg(art(n)), label: n }))], 5, 2);
sheet('arm-parts.png', made.arms.map((n) => ({ img: onBg(art(n)), label: n.replace('ink_', '') })), 7, 1);
// b. the sweep grid generated from the three keys (columns: yaw, rows: pitch)
const gm = JSON.parse(fs.readFileSync(path.join(roots.all2d, 'manifest', 'fp_guns.json'), 'utf8')).sweeps.vandal;
const cells = unpackSheets(gm, gm.sheets.map((s) => decodePNG(fs.readFileSync(path.join(roots.all2d, s)))));
const cols = steps(gm.yaw), [cw, ch] = gm.cell;
const grid = cells.map((c, i) => ({ img: onBg({ width: cw, height: ch, data: c }), label: `y${gm.yaw[0] + (i % cols) * gm.yaw[2]} p${gm.pitch[0] + Math.floor(i / cols) * gm.pitch[2]}` }));
sheet('sweep-grid.png', grid, cols, 1);
// c. hand-drawn arms gripping it: idle / ADS / reload_empty
const n = (root, clip) => JSON.parse(fs.readFileSync(path.join(root, 'manifest', 'fp.json'), 'utf8')).sprites.fp_smg.anims[clip].frames;
const shots = [['idle', 0, false], ['ads_idle', 0, true], ['reload_empty', 6, false], ['reload_empty', 10, false], ['reload_empty', 15, false], ['reload_empty', 20, false], ['reload_empty', 26, false], ['inspect', 12, false], ['inspect', 6, false]];
let maxColors = 0;
const arms = shots.map(([clip, f, ads]) => { const im = frame(roots.all2d, { class: 'smg', clip, frame: f, gun: 'vandal' }, ads); maxColors = Math.max(maxColors, im.colors); return { img: im, label: `${clip} ${f}` }; });
sheet('arms-2d.png', arms, 3);
log('colours per frame (max, all 2D)', maxColors);
// d. mixed sources: rows all-2D, 2D gun + 3D arms, 3D gun + 2D arms, 3D gun + traced 2D arms
const mixed = [];
for (const [tag, label, gun] of [['all2d', 'all 2D', 'vandal'], ['gun2d', '2D gun + 3D arms', 'vandal'], ['arms2d', '3D gun + 2D arms', 'smg'], ['traced', '3D gun + traced 2D arms', 'smg']]) {
  for (const [clip, f, ads] of [['idle', 0, false], ['ads_idle', 0, true], ['reload_empty', 10, false], ['reload_empty', 20, false]]) mixed.push({ img: frame(roots[tag], { class: 'smg', clip, frame: f, gun }, ads), label: `${label}: ${clip} ${f}` });
}
sheet('mixed.png', mixed, 4);
// e. GIF: all-2D reload_empty
const gf = Array.from({ length: n(roots.all2d, 'reload_empty') }, (_, f) => frame(roots.all2d, { class: 'smg', clip: 'reload_empty', frame: f, gun: 'vandal' }));
fs.writeFileSync(path.join(DOCS, 'reload-empty-2d.gif'), encodeGIF(gf[0].width, gf[0].height, gf.map((f) => ({ data: f.data, delay: 83 }))));
log('reload-empty-2d.gif', gf.length, 'frames');
log('done', base);
