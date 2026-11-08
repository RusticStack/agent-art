// Renders the hand-drawn first-person demos in docs/fp2d/. Everything in the all-2D sets is pixel
// art drawn with Agent Art's own drawing ops (scripts/fp2d-art.js): an SMG and a rifle as three key
// drawings each -> their full sweeps; a hand-drawn glove / sleeve skin gripping them; the hand /
// gun contact pass before and after; then mixed sources (2D gun + 3D arms, 3D gun + 2D arms). Every
// frame comes from the exported files through the runtime compositor (fp_composite), like docs/fp/.
// Usage: node scripts/fp2d-demos.js [assetDir]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Engine } from '../src/engine.js';
import { compositeFromFiles } from '../src/fpops.js';
import { CENTRE, steps } from '../src/fp.js';
import { KIT_BUILDS } from '../src/fpkit.js';
import { packImages } from '../src/sheet.js';
import { encodePNG, decodePNG } from '../src/png.js';
import { encodeGIF } from '../src/gif.js';
import { colorsOf } from '../src/fppaint.js';
import { unpackSheets } from '../src/fpsweep.js';
import { NOT_ART } from '../src/fp2d.js';
import { drawDemoSet } from './fp2d-art.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOCS = path.join(ROOT, 'docs', 'fp2d');
fs.mkdirSync(DOCS, { recursive: true });
for (const f of fs.readdirSync(DOCS)) fs.rmSync(path.join(DOCS, f));
const base = path.resolve(process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'agent-art-fp2d-demo-')));
const e = new Engine({ home: fs.mkdtempSync(path.join(os.tmpdir(), 'agent-art-fp2d-home-')) });
const t0 = performance.now();
const log = (...a) => console.log(`[${((performance.now() - t0) / 1000).toFixed(1)}s]`, ...a);
const BG = [58, 52, 46, 255];
const CLIPS = ['idle', 'ads_idle', 'fire', 'reload_empty', 'inspect'];

// 1. draw: SMG + rifle keys, magazine keys, the "ink" glove / sleeve skin
const made = drawDemoSet(e, { rifle: true });
log('drawn', made.gun.length + made.rifle.gun.length, 'gun keys,', made.mag.length + made.rifle.mag.length, 'mag keys,', made.arms.length, 'arm parts');
for (const c of [...made.gun, ...made.rifle.gun]) log(' anchors', c, JSON.stringify(e.run('fp_anchors', { canvas: c }).warnings || 'ok'));
e.run('fp_trace', { skin: 'mec', name: 'mec2d' });

// 2. all 2D first (no kit model is built: KIT_BUILDS stays 0), then the 3D kit for the mixed rows
const roots = Object.fromEntries(['all2d', 'before', 'gun2d', 'arms2d', 'traced'].map((k) => [k, path.join(base, k)]));
for (const k of Object.keys(KIT_BUILDS)) KIT_BUILDS[k] = 0;
const s2 = e.run('fp_sweep2d', { out: roots.all2d });
log('sweep2d', JSON.stringify(Object.fromEntries(Object.entries(s2.sweeps).map(([k, v]) => [k, { cell: v.cell, cells: v.cells, sheets: v.sheets, colors: v.colors, key_colors: v.key_colors, palette_ok: v.palette_ok, ms: v.ms }]))));
const report = {};
const run = (tag, o, classes = ['smg']) => {
  const b = e.run('fp_batch', { out: roots[tag], classes, clips: CLIPS, variants: false, ...o });
  const ck = e.run('fp_check', { out: roots[tag], classes });
  report[tag] = { frames: b.frames, ms_per_frame: Math.round((b.ms / b.frames) * 10) / 10, pass: ck.pass, worst: ck.worst, hand_checks: ck.hand_checks, contact_checks: ck.contact_checks, mag_visibility_checks: ck.mag_visibility_checks, nudged_hands: ck.nudged_hands, warnings: ck.warnings?.length || 0 };
  log(tag, JSON.stringify(report[tag]), ck.pass ? '' : JSON.stringify(ck.issues?.slice(0, 3)));
};
run('all2d', { skins: ['ink'], guns: { smg: 'vandal', rifle: 'warden' } }, ['smg', 'rifle']);
report.all2d.kit_models_built = { ...KIT_BUILDS };
log('kit models built by the all-2D set', JSON.stringify(KIT_BUILDS));
// the same set without the contact pass (before)
fs.cpSync(roots.all2d, roots.before, { recursive: true });
run('before', { skins: ['ink'], guns: { smg: 'vandal', rifle: 'warden' }, contact: false }, ['smg', 'rifle']);
e.run('fp_sweep', { out: roots.all2d, guns: ['smg'], mags: ['smg_mag'], attachments: [], items: [] });
for (const r of ['gun2d', 'arms2d', 'traced']) fs.cpSync(roots.all2d, roots[r], { recursive: true });
run('gun2d', { skins: ['mec'], guns: { smg: 'vandal' } });
run('arms2d', { skins: ['ink'] });
run('traced', { skins: ['mec2d'] });
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
const crop = (im, x0, y0, w, h) => { const d = new Uint8ClampedArray(w * h * 4); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const X = x0 + x, Y = y0 + y; if (X < 0 || Y < 0 || X >= im.width || Y >= im.height) continue; d.set(im.data.subarray((Y * im.width + X) * 4, (Y * im.width + X) * 4 + 4), (y * w + x) * 4); } return { width: w, height: h, data: d }; };
function sheet(file, items, columns, k = 1) {
  const s = packImages(items.map((it) => ({ img: k > 1 ? zoom(it.img, k) : it.img, label: it.label })), { labels: true, checker: false, columns });
  fs.writeFileSync(path.join(DOCS, file), encodePNG(s.width, s.height, s.data));
  log(file, `${s.width}x${s.height}`);
}
const art = (name) => { const d = e.get(name); return { width: d.width, height: d.height, data: d.composite({ exclude: NOT_ART }) }; };
const onBg = (im) => { const d = new Uint8ClampedArray(im.data.length); for (let i = 0; i < d.length; i += 4) d.set(im.data[i + 3] ? im.data.subarray(i, i + 4) : BG, i); return { ...im, data: d }; };
const nFrames = (root, cls, clip) => JSON.parse(fs.readFileSync(path.join(root, 'manifest', 'fp.json'), 'utf8')).sprites[`fp_${cls}`].anims[clip].frames;

// a. the drawings (what a person or agent draws), at 2x
sheet('keys-smg.png', [...made.gun, ...made.mag].map((n) => ({ img: onBg(art(n)), label: n })), 5, 2);
sheet('keys-rifle.png', [...made.rifle.gun, ...made.rifle.mag].map((n) => ({ img: onBg(art(n)), label: n })), 5, 2);
sheet('arm-parts.png', made.arms.map((n) => ({ img: onBg(art(n)), label: n.replace('ink_', '') })), 6, 2);
// contact zones of the SMG keys (painted masks: grip red, guard green, foregrip blue)
const zoneImg = (name) => {
  const d = e.get(name), im = onBg(art(name));
  const col = { mask_grip: [220, 60, 60], mask_guard: [60, 220, 90], mask_fore: [70, 120, 240], mask_pinch: [240, 200, 60] };
  for (const L of d.layers) { const c = col[L.name]; if (!c) continue; for (let i = 0; i < d.width * d.height; i++) if (L.data[i * 4 + 3] >= 128) for (let k = 0; k < 3; k++) im.data[i * 4 + k] = Math.round(im.data[i * 4 + k] * 0.45 + c[k] * 0.55); }
  return im;
};
sheet('zones.png', [...made.gun, made.mag[0]].map((n) => ({ img: zoneImg(n), label: `${n} zones` })), 4, 2);
// b. the sweep grids generated from the three keys
for (const [name, file] of [['vandal', 'sweep-grid.png'], ['warden', 'sweep-grid-rifle.png']]) {
  const gm = JSON.parse(fs.readFileSync(path.join(roots.all2d, 'manifest', 'fp_guns.json'), 'utf8')).sweeps[name];
  const cells = unpackSheets(gm, gm.sheets.map((s) => decodePNG(fs.readFileSync(path.join(roots.all2d, s)))));
  const cols = steps(gm.yaw), [cw, ch] = gm.cell;
  sheet(file, cells.map((c, i) => ({ img: onBg({ width: cw, height: ch, data: c }), label: `y${gm.yaw[0] + (i % cols) * gm.yaw[2]} p${gm.pitch[0] + Math.floor(i / cols) * gm.pitch[2]}` })), cols, 1);
}
// c. all 2D: the drawn arms gripping the drawn guns
let maxColors = 0;
const shots = (cls, gun, list) => list.map(([clip, f, ads]) => { const im = frame(roots.all2d, { class: cls, clip, frame: f, gun }, ads); maxColors = Math.max(maxColors, im.colors); return { img: im, label: `${clip} ${f}` }; });
sheet('smg-2d.png', shots('smg', 'vandal', [['idle', 0, false], ['ads_idle', 0, true], ['fire', 0, false], ['reload_empty', 6, false], ['reload_empty', 12, false], ['reload_empty', 17, false], ['reload_empty', 26, false], ['inspect', 6, false], ['inspect', 14, false]]), 3);
sheet('rifle-2d.png', shots('rifle', 'warden', [['idle', 0, false], ['ads_idle', 0, true], ['fire', 0, false], ['reload_empty', 8, false], ['reload_empty', 14, false], ['reload_empty', 26, false]]), 3);
log('colours per frame (max, all 2D)', maxColors);
for (const [cls, gun, file] of [['smg', 'vandal', 'reload-empty-smg-2d.gif'], ['rifle', 'warden', 'reload-empty-rifle-2d.gif']]) {
  const gf = Array.from({ length: nFrames(roots.all2d, cls, 'reload_empty') }, (_, f) => frame(roots.all2d, { class: cls, clip: 'reload_empty', frame: f, gun }));
  fs.writeFileSync(path.join(DOCS, file), encodeGIF(gf[0].width, gf[0].height, gf.map((f) => ({ data: f.data, delay: 83 }))));
  log(file, gf.length, 'frames');
}
// d. the contact pass: before (layers and depth only) / after (zones, trigger layer, nudges), zoomed on the hands
const pairs = [];
for (const [cls, gun, clip, f] of [['smg', 'vandal', 'idle', 0], ['smg', 'vandal', 'fire', 0], ['smg', 'vandal', 'reload_empty', 12], ['smg', 'vandal', 'reload_empty', 17], ['rifle', 'warden', 'idle', 0], ['rifle', 'warden', 'reload_empty', 14]]) {
  const [b0, a0] = ['before', 'all2d'].map((tag) => crop(frame(roots[tag], { class: cls, clip, frame: f, gun }), 150, 40, 200, 176));
  // changed pixels: finger pixels the contact pass moved behind the gun (magenta) on the after frame
  const diff = { ...a0, data: a0.data.slice() };
  let changed = 0;
  for (let i = 0; i < diff.data.length; i += 4) if (b0.data[i] !== a0.data[i] || b0.data[i + 1] !== a0.data[i + 1] || b0.data[i + 2] !== a0.data[i + 2]) { diff.data.set([255, 0, 200, 255], i); changed++; }
  pairs.push({ img: zoom(b0, 2), label: `before: ${cls} ${clip} ${f}` }, { img: zoom(a0, 2), label: `after: ${cls} ${clip} ${f}` }, { img: zoom(diff, 2), label: `changed: ${changed} px` });
}
sheet('contact-before-after.png', pairs, 3);
// e. mixed sources (after the all-2D sets): 2D gun + 3D arms, 3D gun + 2D arms, 3D gun + traced 2D arms
const mixed = [];
for (const [tag, label, gun] of [['all2d', 'all 2D', 'vandal'], ['gun2d', '2D gun + 3D arms', 'vandal'], ['arms2d', '3D gun + 2D arms', 'smg'], ['traced', '3D gun + traced 2D arms', 'smg']]) {
  for (const [clip, f, ads] of [['idle', 0, false], ['ads_idle', 0, true], ['reload_empty', 12, false], ['reload_empty', 17, false]]) mixed.push({ img: frame(roots[tag], { class: 'smg', clip, frame: f, gun }, ads), label: `${label}: ${clip} ${f}` });
}
sheet('mixed.png', mixed, 4);
log('done', base);
