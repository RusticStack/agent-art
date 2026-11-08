// Regenerates the docs/skinning demo images with the real art_model ops:
//   node docs/skinning/make-demos.mjs
// exosuit walk (art_anim humanoid_hd "walk" retargeted onto a skinned 3D exosuit), hanging cable
// sway (chain skeleton + cable helper, heat weights), landing gear compression (telescoping strut,
// squashing boot), corrective shoulder shape (with / without), exosuit 8-direction sprite sheet.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Engine } from '../../src/engine.js';
import { encodePNG } from '../../src/png.js';
import { encodeGIF } from '../../src/gif.js';

const OUT = path.dirname(fileURLToPath(import.meta.url));
const e = new Engine({ home: fs.mkdtempSync(path.join(os.tmpdir(), 'agent-art-skin-demo-')) });
const BG = [74, 82, 96, 255];
const log = (...a) => console.log(...a);

/** Frames of a canvas animation tag -> RGBA arrays. */
function framesOf(canvas, tag) {
  const d = e.docs.get(canvas);
  const an = d.animations[tag];
  return { frames: an.frames.map((f) => d.frameData(f)), w: d.width, h: d.frameHeight || d.height };
}
const upscale = (img, w, h, k, bg = BG) => {
  const W = w * k, H = h * k, out = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const s = (Math.floor(y / k) * w + Math.floor(x / k)) * 4, d = (y * W + x) * 4, a = img[s + 3] / 255;
    for (let c = 0; c < 3; c++) out[d + c] = Math.round(img[s + c] * a + bg[c] * (1 - a));
    out[d + 3] = 255;
  }
  return out;
};
/** Grid sheet of equally sized frames. */
function sheet(frames, w, h, cols, k = 1, gap = 2) {
  const rows = Math.ceil(frames.length / cols), W = cols * (w * k + gap) + gap, H = rows * (h * k + gap) + gap;
  const out = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < out.length; i += 4) out.set([18, 20, 24, 255], i);
  frames.forEach((f, i) => {
    const big = upscale(f, w, h, k), x0 = gap + (i % cols) * (w * k + gap), y0 = gap + Math.floor(i / cols) * (h * k + gap);
    for (let y = 0; y < h * k; y++) out.set(big.subarray(y * w * k * 4, (y + 1) * w * k * 4), ((y0 + y) * W + x0) * 4);
  });
  return { data: out, W, H };
}
const savePNG = (name, s) => { fs.writeFileSync(path.join(OUT, name), encodePNG(s.W, s.H, s.data)); log('wrote', name, `${s.W}x${s.H}`); };
const saveGIF = (name, frames, w, h, k, ms) => {
  const big = frames.map((f) => ({ data: upscale(f, w, h, k), delay: ms }));
  fs.writeFileSync(path.join(OUT, name), encodeGIF(w * k, h * k, big));
  log('wrote', name, `${frames.length} frames`);
};

// ---------- 1. exosuit (rigid armour plates + heat-weighted hoses), walk retargeted from art_anim ----------
const exoParts = [
  { type: 'box', w: 16, h: 8, d: 10, at: [0, 35, 0], texture: '#5c6470', bone: 'pelvis' },
  { type: 'box', w: 13, h: 10, d: 9, at: [0, 43, 0], texture: '#4b525c', bone: 'torso' },
  { type: 'box', w: 24, h: 13, d: 13, at: [0, 53, 0], texture: '#c8a23a', bevel: 1.5, bone: 'chest' },
  { type: 'box', w: 9, h: 10, d: 9, at: [0, 67, 0], texture: '#c8a23a', bevel: 1, bone: 'head' },
  { type: 'box', w: 7, h: 2.5, d: 1, at: [0, 71, 4.3], texture: '#58e0ff', bone: 'head' },
  { type: 'box', w: 15, h: 15, d: 7, at: [0, 47, -10], texture: '#3d434b', bone: 'backpack' },
];
for (const [s, x] of [['f', -1], ['b', 1]]) exoParts.push(
  { type: 'box', w: 9, h: 5, d: 11, at: [x * 15, 63.5, 0], texture: '#c8a23a', bevel: 1, bone: `shoulder_pad_${s}` },
  { type: 'box', w: 6, h: 13, d: 6, at: [x * 13, 51, 0], texture: '#4b525c', bone: `upper_arm_${s}` },
  { type: 'box', w: 7.5, h: 12, d: 7.5, at: [x * 13, 39.5, 0], texture: '#c8a23a', bevel: 1, bone: `forearm_${s}` },
  { type: 'box', w: 5.5, h: 6, d: 6, at: [x * 13, 33, 0.5], texture: '#2f343b', bone: `hand_${s}` },
  { type: 'box', w: 8, h: 18, d: 9, at: [x * 6.5, 21.5, 0], texture: '#c8a23a', bevel: 1, bone: `thigh_${s}` },
  { type: 'box', w: 7, h: 17, d: 7.5, at: [x * 6.5, 4.5, -0.5], texture: '#4b525c', bone: `shin_${s}` },
  { type: 'box', w: 8.5, h: 4.5, d: 15, at: [x * 6.5, 0, 2], texture: '#2f343b', bone: `foot_${s}` },
  // hoses: backpack to forearm, weighted by heat diffusion across chest / upper arm / forearm
  { type: 'tube', id: `hose_${s}`, path: [[x * 6, 54, -10], [x * 11, 58, -6], [x * 15.5, 54, -3], [x * 15.5, 46, -2.5], [x * 15, 42, -2]], curve: 'catmull', segments: 4, r: 1.1, sides: 6, texture: '#202327' },
);
e.run('model_create', { name: 'exo', parts: exoParts });
e.run('model_skeleton', { name: 'exo', skeleton: { template: 'exosuit' } });
const exoSkin = e.run('model_skin', { name: 'exo', skin: { method: 'heat', parts: ['hose_f', 'hose_b'], exclude: ['shoulder_pad_f', 'shoulder_pad_b'] } });
log('exo weights', JSON.stringify(exoSkin.weights).slice(0, 200));
e.run('anim_skeleton', { name: 'hd', template: 'humanoid_hd', frame: [128, 192] });
const rt = e.run('model_animate', { name: 'exo', clip: 'walk', retarget: { skeleton: 'hd', clip: 'walk' } });
log('retarget', JSON.stringify(rt.retarget), rt.duration);
const walk = e.run('model_render', { name: 'exo', clip: 'walk', frames: 16, camera: 'side', size: [72, 96], canvas: 'exo_walk_side', outline: '#101216', light: { ambient: 0.5 } });
{ const { frames, w, h } = framesOf(walk.canvas, walk.animation); saveGIF('exosuit-walk.gif', frames, w, h, 3, 1000 / 16); savePNG('exosuit-walk.png', sheet(frames.filter((_, i) => i % 2 === 0), w, h, 8, 2)); }

// ---------- 2. hanging cable (chain skeleton + cable helper, heat weights) ----------
e.run('model_create', { name: 'cable', parts: [{ type: 'box', w: 16, h: 3, d: 16, at: [0, 64, 0], texture: '#4b525c' }, { type: 'cylinder', r: 3.5, h: 5, at: [0, 3, 0], texture: '#ffcf4a', bone: 'chain_tip' }] });
e.run('model_skeleton', { name: 'cable', skeleton: { template: 'chain', count: 8, from: [0, 64, 0], to: [0, 8, 0], cable: { r: 1.2, sides: 8, texture: '#c8452f', segments: 4 } } });
e.run('model_skin', { name: 'cable', skin: { method: 'heat', parts: ['cable'], smooth: 2 } });
{
  const keys = [];
  for (let k = 0; k <= 8; k++) {
    const t = k / 8 * 2, bones = {};
    for (let i = 0; i < 8; i++) bones[`chain_${i}`] = { rot: [6 * Math.sin(2 * Math.PI * (t / 2) - i * 0.5), 0, 14 * Math.sin(2 * Math.PI * (t / 2) - i * 0.45) * (i === 0 ? 0.6 : 0.5)] };
    if (k < 8) keys.push({ t: +t.toFixed(4), bones, ease: 'linear' });
  }
  e.run('model_animate', { name: 'cable', clip: 'sway', loop: true, duration: 2, keys });
}
const cab = e.run('model_render', { name: 'cable', clip: 'sway', frames: 16, camera: 'front', size: [64, 80], canvas: 'cable_sway', outline: '#101216', light: { ambient: 0.5 } });
{ const { frames, w, h } = framesOf(cab.canvas, cab.animation); saveGIF('cable-sway.gif', frames, w, h, 3, 125); savePNG('cable-sway.png', sheet(frames.filter((_, i) => i % 2 === 0), w, h, 8, 2)); }

// ---------- 3. landing gear: telescoping strut, deforming boot ----------
const boot = [];
for (let i = 0; i <= 6; i++) boot.push([0, 9 - i, 0]);
e.run('model_create', { name: 'gear', parts: [
  { type: 'box', w: 40, h: 6, d: 22, at: [0, 41, 0], texture: '#8b6a3e', bevel: 1.5, bone: 'mount' },
  { type: 'box', w: 18, h: 4, d: 14, at: [0, 38, 0], texture: '#5c6470', bone: 'mount' },
  { type: 'cylinder', r: 2.6, h: 16, at: [0, 22, 0], texture: '#8a919c', bone: 'strut_upper' },
  { type: 'cylinder', r: 1.7, h: 14, at: [0, 9, 0], texture: '#d7dde4', bone: 'strut_lower' },
  { type: 'tube', id: 'boot', path: boot, r: 3.4, sides: 12, texture: '#2b2e33' },
  { type: 'cylinder', r: 6, h: 3, at: [0, 0, 0], texture: '#3d434b', bone: 'pad' },
] });
e.run('model_skeleton', { name: 'gear', skeleton: { template: 'landing_gear' } });
e.run('model_skin', { name: 'gear', skin: { method: 'rigid', parts: ['boot'], rigid: { boot: 'boot' }, paint: [{ bone: 'strut_lower', weight: 1, region: { above: 8.5 } }, { bone: 'pad', weight: 1, region: { below: 3.5 } }] } });
e.run('model_animate', { name: 'gear', clip: 'compress', loop: true, duration: 1.6, keys: [
  { t: 0, bones: {} },
  { t: 0.5, bones: { mount: { at: [0, -10, 0] }, strut_lower: { at: [0, 7.6, 0] }, boot: { scale: [1.3, 0.6, 1.3] }, pad: { scale: [1 / 1.3, 1 / 0.6, 1 / 1.3] } }, ease: 'out' },
  { t: 0.8, bones: { mount: { at: [0, -8.5, 0] }, strut_lower: { at: [0, 6.4, 0] }, boot: { scale: [1.25, 0.65, 1.25] }, pad: { scale: [1 / 1.25, 1 / 0.65, 1 / 1.25] } }, ease: 'smooth' },
  { t: 1.2, bones: {}, ease: 'smooth' },
], events: [{ t: 0.5, name: 'touchdown_max' }] });
const gr = e.run('model_render', { name: 'gear', clip: 'compress', frames: 16, camera: { yaw: 25, pitch: 12 }, size: [64, 64], canvas: 'gear_compress', outline: '#101216', light: { ambient: 0.5 } });
{ const { frames, w, h } = framesOf(gr.canvas, gr.animation); saveGIF('landing-gear.gif', frames, w, h, 4, 100); savePNG('landing-gear.png', sheet(frames.filter((_, i) => i % 2 === 0), w, h, 8, 3)); }

// ---------- 4. humanoid: corrective shoulder shape driven by upper_arm_f rotation ----------
const arm = (x) => [[x, 47.5, 0], [x, 46.5, 0], [x, 45.5, 0], [x, 44, 0], [x, 42, 0], [x, 39.5, 0], [x, 37, 0], [x, 34, 0], [x, 31, 0], [x, 28.5, 0]];
const leg = (x) => [[x, 29, 0], [x, 22, 0], [x, 16, 0], [x, 9, 0], [x, 2, 0]];
const humanParts = [
  { type: 'box', w: 8.6, h: 20, d: 6, at: [0, 28.5, 0], texture: '#3f6f8f', bone: 'chest' },
  { type: 'box', w: 5, h: 7, d: 5.5, at: [0, 50, 0], texture: '#e0b48c', bone: 'head' },
  { type: 'tube', id: 'arm_r', path: arm(-6.4), r: 1.9, sides: 10, texture: '#4f86a8' },
  { type: 'tube', id: 'arm_l', path: arm(6.4), r: 1.9, sides: 10, texture: '#4f86a8' },
  { type: 'tube', id: 'leg_r', path: leg(-2.6), r: 2.1, sides: 8, texture: '#2d3a48' },
  { type: 'tube', id: 'leg_l', path: leg(2.6), r: 2.1, sides: 8, texture: '#2d3a48' },
];
for (const corrective of [false, true]) {
  const name = corrective ? 'human_fixed' : 'human_lbs';
  e.run('model_create', { name, parts: humanParts });
  e.run('model_skeleton', { name, skeleton: { template: 'humanoid' } });
  // the arm root shares weight with the chest (a typical auto-weight result): LBS collapses the shoulder when the arm lifts
  const skin = { method: 'heat', parts: ['arm_r', 'arm_l', 'leg_r', 'leg_l'], paint: [{ bone: 'chest', weight: 0.6, region: { sphere: [-6.4, 47.5, 0, 3.4] } }, { bone: 'chest', weight: 0.6, region: { sphere: [6.4, 47.5, 0, 3.4] } }] };
  if (corrective) skin.shapes = { shoulder_fix_r: { sculpt: [{ sphere: [-6.4, 47, 0, 4.2], move: [-2.6, 1.8, 0] }, { sphere: [-6.4, 46.5, 0, 3.6], inflate: 1 }], driver: { bone: 'upper_arm_f', axis: 'z', from: 0, to: -90 } } };
  e.run('model_skin', { name, skin });
  e.run('model_animate', { name, clip: 'raise', loop: true, duration: 2, keys: [{ t: 0, bones: {} }, { t: 1, bones: { upper_arm_f: { rot: [0, 0, -95] }, forearm_f: { rot: [-10, 0, 0] } }, ease: 'smooth' }] });
}
const sh = [];
for (const name of ['human_lbs', 'human_fixed']) {
  const r = e.run('model_render', { name, clip: 'raise', frames: 8, camera: 'front', size: [72, 72], canvas: `${name}_raise`, outline: '#101216', light: { ambient: 0.5 } });
  sh.push(framesOf(r.canvas, r.animation));
}
{
  const { w, h } = sh[0];
  const pick = [0, 2, 4];
  savePNG('corrective-shoulder.png', sheet([...pick.map((i) => sh[0].frames[i]), ...pick.map((i) => sh[1].frames[i])], w, h, 3, 4));
  saveGIF('corrective-shoulder.gif', sh[0].frames.map((f, i) => { const out = new Uint8ClampedArray(w * 2 * h * 4); for (let y = 0; y < h; y++) { out.set(f.subarray(y * w * 4, (y + 1) * w * 4), y * w * 2 * 4); out.set(sh[1].frames[i].subarray(y * w * 4, (y + 1) * w * 4), (y * w * 2 + w) * 4); } return out; }), w * 2, h, 3, 160);
}
const heat = e.run('model_weights', { name: 'human_lbs', bone: 'upper_arm_f', views: ['front'], size: 256 });
fs.writeFileSync(path.join(OUT, 'weights-upper-arm.png'), heat.image);
log('weights', heat.summary);

// ---------- 5. exosuit -> 8-direction pixel sprites (quantized, outlined) ----------
const dirs = e.run('model_render', { name: 'exo', clip: 'walk', frames: 8, sweep: { yaw: [0, 315, 45] }, camera: 'front', size: [48, 64], canvas: 'exo_8dir', quantize: { colors: 16 }, outline: '#101216', light: { ambient: 0.45 } });
{
  const { frames, w, h } = framesOf(dirs.canvas, dirs.animation);
  // frames are angle-major (8 walk frames per direction): one row per direction
  savePNG('exosuit-8dir.png', sheet(frames, w, h, 8, 2));
  saveGIF('exosuit-8dir.gif', [0, 1, 2, 3, 4, 5, 6, 7].map((f) => { const W = w * 8, out = new Uint8ClampedArray(W * h * 4); for (let d = 0; d < 8; d++) for (let y = 0; y < h; y++) out.set(frames[d * 8 + f].subarray(y * w * 4, (y + 1) * w * 4), (y * W + d * w) * 4); return out; }), w * 8, h, 2, 110);
  log('8dir', dirs.count, dirs.colors, JSON.stringify(dirs.grid));
}
const ex = e.run('model_export', { name: 'exo', path: path.join(e.home, 'exo.glb') });
const rb = e.run('model_export', { name: 'exo', profile: 'roblox', r15: true, max_bones: 12, path: path.join(e.home, 'exo_roblox.glb') });
log('export', ex.bytes, JSON.stringify(ex.skin));
log('roblox', JSON.stringify(rb.skin.roblox));
