// Renders the first-person viewmodel demos in docs/fp/ (contact sheets + GIFs) from exported
// assets, through the same runtime compositor the tests check against the game.
// Usage: node scripts/fp-demos.js [assetDir]   (assets are generated when missing)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Engine } from '../src/engine.js';
import { compositeFromFiles } from '../src/fpops.js';
import { CENTRE } from '../src/fp.js';
import { packImages } from '../src/sheet.js';
import { encodePNG } from '../src/png.js';
import { encodeGIF } from '../src/gif.js';
import { colorsOf } from '../src/fppaint.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOCS = path.join(ROOT, 'docs', 'fp');
fs.mkdirSync(DOCS, { recursive: true });
const out = path.resolve(process.argv[2] || path.join(os.tmpdir(), 'agent-art-fp-demo'));
const e = new Engine({ home: fs.mkdtempSync(path.join(os.tmpdir(), 'agent-art-fp-home-')) });
const t0 = performance.now();
const log = (...a) => console.log(`[${Math.round((performance.now() - t0) / 1000)}s]`, ...a);

if (!fs.existsSync(path.join(out, 'manifest', 'fp_guns.json')) || process.env.FP_REBUILD) {
  log('sweep', JSON.stringify(e.run('fp_sweep', { out, guns: ['rifle', 'pistol'], mags: ['rifle_mag_30', 'pistol_mag'], items: ['knife', 'frag'] }).guns));
}
if (!fs.existsSync(path.join(out, 'manifest', 'fp.json')) || process.env.FP_REBUILD) {
  log('batch rifle', e.run('fp_batch', { out, classes: ['rifle'], clips: ['idle', 'ads_idle', 'reload_empty', 'inspect'] }).frames);
  log('batch pistol / knife / grenade', e.run('fp_batch', { out, classes: ['pistol', 'knife', 'grenade'], clips: ['idle', 'reload', 'slash', 'throw', 'cook'] }).frames);
}

const BG = [58, 52, 46, 255];
/** One frame as the game shows it, with the ADS shift (active sight to the screen centre) when asked. */
function frame(a, ads = false) {
  const r = compositeFromFiles(out, { ...a, background: null });
  let { data } = r;
  if (ads && r.sight) {
    const dx = Math.round(CENTRE[0] - r.sight[0]), dy = Math.round(CENTRE[1] - r.sight[1]);
    const d = new Uint8ClampedArray(data.length);
    for (let y = 0; y < r.height; y++) for (let x = 0; x < r.width; x++) {
      const sx = x - dx, sy = y - dy;
      if (sx < 0 || sy < 0 || sx >= r.width || sy >= r.height) continue;
      d.set(data.subarray((sy * r.width + sx) * 4, (sy * r.width + sx) * 4 + 4), (y * r.width + x) * 4);
    }
    data = d;
  }
  const img = new Uint8ClampedArray(data.length);
  for (let i = 0; i < data.length; i += 4) img.set(data[i + 3] ? data.subarray(i, i + 4) : BG, i);
  if (ads) for (const [x, y] of [[0, 0], [-3, 0], [3, 0], [0, -3], [0, 3]]) img.set([255, 255, 255, 255], ((CENTRE[1] + y) * r.width + CENTRE[0] + x) * 4);
  return { width: r.width, height: r.height, data: img, colors: colorsOf(r.data).size };
}
const zoom = (im, k) => {
  const W = im.width * k, H = im.height * k, d = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const s = (Math.floor(y / k) * im.width + Math.floor(x / k)) * 4; d.set(im.data.subarray(s, s + 4), (y * W + x) * 4); }
  return { width: W, height: H, data: d };
};
function sheet(file, items, columns, k = 1) {
  const s = packImages(items.map((it) => ({ img: k > 1 ? zoom(it.img, k) : it.img, label: it.label })), { labels: true, checker: false, columns });
  fs.writeFileSync(path.join(DOCS, file), encodePNG(s.width, s.height, s.data));
  log(file, `${s.width}x${s.height}`);
}
function gif(file, frames, ms) {
  fs.writeFileSync(path.join(DOCS, file), encodeGIF(frames[0].width, frames[0].height, frames.map((f) => ({ data: f.data, delay: ms }))));
  log(file, frames.length, 'frames');
}
const nFrames = (cls, clip) => JSON.parse(fs.readFileSync(path.join(out, 'manifest', 'fp.json'), 'utf8')).sprites[`fp_${cls}`].anims[clip].frames;

// 1. two loadouts on the same rifle arms clips
const A = { optic: 'reflex', muzzle: 'suppressor', underbarrel: 'vertical_grip' }, B = { optic: 'scope_4x', muzzle: 'compensator', underbarrel: 'angled_grip' };
const cols = [['idle', 0, false], ['ads_idle', 0, true], ['reload_empty', 8, false], ['reload_empty', 14, false], ['reload_empty', 20, false], ['reload_empty', 26, false]];
const items = [];
let maxColors = 0;
for (const [name, att] of [['A', A], ['B', B]]) for (const [clip, f, ads] of cols) {
  const im = frame({ class: 'rifle', clip, frame: f, attachments: att }, ads);
  maxColors = Math.max(maxColors, im.colors);
  items.push({ img: im, label: `${name} ${clip} ${f}` });
}
sheet('loadouts.png', items, 3);
log('colours per frame (max)', maxColors);
// 2. look sway: the gun turning through its sweep under the same arms frame
const sway = [];
for (const p of [8, 0, -8]) for (const y of [-12, -6, 0, 6, 12]) sway.push({ img: frame({ class: 'rifle', clip: 'idle', frame: 0, attachments: A, yaw_offset: y, pitch_offset: p }), label: `yaw ${y} pitch ${p}` });
sheet('look-sway.png', sway, 5);
// 3. pistol reload, 4. knife slash, 5. grenade throw, 6. inspect
const run = (cls, clip, step, columns, file, att = {}) => {
  const n = nFrames(cls, clip), its = [];
  for (let f = 0; f < n; f += step) its.push({ img: frame({ class: cls, clip, frame: f, attachments: att }), label: `${clip} ${f}` });
  sheet(file, its, columns);
  return n;
};
run('pistol', 'reload', 3, 5, 'pistol-reload.png');
run('knife', 'slash', 2, 3, 'knife-slash.png');
run('grenade', 'throw', 2, 4, 'grenade-throw.png');
run('rifle', 'inspect', 4, 3, 'inspect.png', A);
// GIFs (2x)
for (const [cls, clip, att, ms, file] of [['rifle', 'reload_empty', A, 83, 'rifle-reload-empty.gif'], ['rifle', 'inspect', B, 100, 'rifle-inspect.gif'], ['pistol', 'reload', {}, 83, 'pistol-reload.gif']]) {
  const n = nFrames(cls, clip), fr = [];
  for (let f = 0; f < n; f++) fr.push(zoom(frame({ class: cls, clip, frame: f, attachments: att }), 2));
  gif(file, fr, ms);
}
log('done', out);
