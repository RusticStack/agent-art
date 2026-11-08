// Regenerates the docs/skin2d demo images with the real art_rig ops:
//   node docs/skin2d/make-demos.mjs
// rigid elbow hinge vs skinned bend, a drawn sleeve bending (with a crease corrective), a rifle
// sling (chain helper + CCD pin + secondary sway), an 8-direction humanoid_hd walk with skinned
// limbs, and a weights heat map.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Engine } from '../../src/engine.js';
import { encodePNG } from '../../src/png.js';
import { encodeGIF } from '../../src/gif.js';

const OUT = path.dirname(fileURLToPath(import.meta.url));
const e = new Engine({ home: fs.mkdtempSync(path.join(os.tmpdir(), 'agent-art-skin2d-demo-')) });
const BG = [74, 82, 96, 255];
const log = (...a) => console.log(...a);
const OL = '#22181e';

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
/** Frames side by side (one wide frame per step). */
const beside = (lists, w, h) => lists[0].map((_, i) => {
  const W = w * lists.length, out = new Uint8ClampedArray(W * h * 4);
  lists.forEach((l, k) => { for (let y = 0; y < h; y++) out.set(l[i].subarray(y * w * 4, (y + 1) * w * 4), (y * W + k * w) * 4); });
  return out;
});
const savePNG = (name, s) => { fs.writeFileSync(path.join(OUT, name), encodePNG(s.W, s.H, s.data)); log('wrote', name, `${s.W}x${s.H}`); };
const saveGIF = (name, frames, w, h, k, ms) => {
  fs.writeFileSync(path.join(OUT, name), encodeGIF(w * k, h * k, frames.map((f) => ({ data: upscale(f, w, h, k), delay: ms }))));
  log('wrote', name, `${frames.length} frames`);
};
const cellsOf = (rig) => e.run('rig_info', { name: rig, full: true }).cells;
const draw = (rig, commands) => e.run('draw', { canvas: `${rig}_parts`, layer: 'parts', commands });
/** A shaded, outlined block: fill with the mid tone, form-shade with the ramp, 1px outline. */
const block = (x, y, w, h, ramp, { shape = 'rect', light = 'top-left' } = {}) => [
  shape === 'ellipse' ? { op: 'ellipse', x, y, w, h, color: ramp[2] } : { op: 'rect', x, y, w, h, color: ramp[2] },
  { op: 'shade', x, y, w, h, colors: ramp, of: ramp[2], light },
  { op: 'outline', x, y, w, h, mode: 'inner', color: OL },
];
const SKIN = ['#6e3a2c', '#9a5a3e', '#c47e56', '#e0a676', '#f2c79a'];
const CLOTH = ['#1f2c46', '#2c3f63', '#3f5a88', '#5779aa', '#7a9cc8'];
const LEATHER = ['#3a2416', '#55361f', '#76502c', '#94693a', '#b2884e'];
const METAL = ['#1c1e22', '#2a2d33', '#3c4048', '#545a64', '#727a86'];
const OLIVE = ['#2a3220', '#3e4a2c', '#56653a', '#71804a', '#8e9c62'];

// ---------- 1. rigid hinge vs skinned bend ----------
const ANG = [0, -30, -60, -90, -120];
e.run('rig_create', { name: 'hinge', frame: [40, 44], root: [14, 6], parts: { upper: { w: 8, h: 16, pivot: [4, 1] }, fore: { w: 8, h: 15, pivot: [4, 1], parent: 'upper', at: [0, 13], z: 1 } } });
e.run('rig_create', { name: 'bend', frame: [40, 44], root: [14, 6], parts: { upper: { w: 8, h: 28, pivot: [4, 1] }, fore: { w: 1, h: 14, pivot: [0, 0], parent: 'upper', at: [0, 13], bone: true } } });
{
  const ch = cellsOf('hinge').side, cb = cellsOf('bend').side;
  draw('hinge', [...block(ch.upper[0], ch.upper[1], 8, 16, SKIN), ...block(ch.fore[0], ch.fore[1], 8, 15, SKIN)]);
  draw('bend', [...block(cb.upper[0], cb.upper[1], 8, 28, SKIN), { op: 'line', x1: cb.upper[0] + 2, y1: cb.upper[1] + 13, x2: cb.upper[0] + 5, y2: cb.upper[1] + 13, color: SKIN[1] }]);
  e.run('rig_skin', { name: 'bend', skin: { arm: { part: 'upper', absorb: ['fore'] } } });
  const keys = [...ANG, ...ANG.slice(1, -1).reverse()].map((a) => ({ parts: { upper: { rot: 15 }, fore: { rot: a } } }));
  for (const r of ['hinge', 'bend']) e.run('rig_animate', { name: r, animation: 'flex', view: 'side', keys, frames: 16, fps: 12, canvas: `${r}_flex` });
  const st = {};
  for (const r of ['hinge', 'bend']) { e.run('rig_animate', { name: r, animation: 'still', view: 'side', keys: ANG.map((a) => ({ parts: { upper: { rot: 15 }, fore: { rot: a } } })), frames: ANG.length, loop: false, ease: 'linear', canvas: `${r}_still` }); st[r] = framesOf(`${r}_still`, 'still').frames; }
  savePNG('elbow-hinge-vs-skin.png', sheet([...st.hinge, ...st.bend], 40, 44, ANG.length, 4));
  const A = framesOf('hinge_flex', 'flex'), B = framesOf('bend_flex', 'flex');
  saveGIF('elbow-hinge-vs-skin.gif', beside([A.frames, B.frames], 40, 44), 80, 44, 4, 1000 / 12);
  const w = e.run('rig_weights', { name: 'bend', bone: 'fore', scale: 10 });
  fs.writeFileSync(path.join(OUT, 'weights-elbow.png'), w.image); log('wrote weights-elbow.png', w.summary);
}

// ---------- 2. a drawn sleeve bending, with a crease corrective ----------
e.run('rig_create', { name: 'sleeve', frame: [56, 60], root: [18, 6], parts: {
  upper: { w: 13, h: 38, pivot: [6, 1], variants: ['crease'] },
  fore: { w: 1, h: 18, pivot: [0, 0], parent: 'upper', at: [0, 18], bone: true },
  hand: { w: 8, h: 9, pivot: [4, 0], parent: 'fore', at: [0, 18], z: 1 },
} });
{
  const c = cellsOf('sleeve').side;
  const sleeve = (x, y, crease) => [
    ...block(x, y, 13, 38, CLOTH),
    // fabric folds + seam, a cuff at the wrist
    { op: 'line', x1: x + 3, y1: y + 6, x2: x + 6, y2: y + 9, color: CLOTH[1] }, { op: 'line', x1: x + 7, y1: y + 24, x2: x + 10, y2: y + 27, color: CLOTH[1] },
    { op: 'line', x1: x + 9, y1: y + 2, x2: x + 9, y2: y + 30, color: CLOTH[3] },
    ...block(x, y + 31, 13, 7, LEATHER),
    ...(crease ? [{ op: 'line', x1: x + 1, y1: y + 16, x2: x + 5, y2: y + 19, color: OL }, { op: 'line', x1: x + 1, y1: y + 19, x2: x + 4, y2: y + 21, color: CLOTH[0] }, { op: 'line', x1: x + 7, y1: y + 18, x2: x + 11, y2: y + 17, color: CLOTH[1] }] : []),
  ];
  draw('sleeve', [...sleeve(c.upper[0], c.upper[1], false), ...sleeve(c['upper:crease'][0], c['upper:crease'][1], true), ...block(c.hand[0], c.hand[1], 8, 9, SKIN, { shape: 'ellipse' })]);
  e.run('rig_skin', { name: 'sleeve', skin: { sleeve: { part: 'upper', absorb: ['fore'], shapes: { crease: { variant: 'crease', fit: false, driver: { bone: 'fore', from: -20, to: -70 } } } } } });
  const keys = [0, -40, -80, -110, -80, -40].map((a, i) => ({ parts: { upper: { rot: 10 + i * 2 }, fore: { rot: a }, hand: { rot: a / 4 } } }));
  e.run('rig_animate', { name: 'sleeve', animation: 'bend', view: 'side', keys, frames: 18, fps: 12, canvas: 'sleeve_bend' });
  const { frames, w, h } = framesOf('sleeve_bend', 'bend');
  saveGIF('sleeve-bend.gif', frames, w, h, 4, 1000 / 12);
  savePNG('sleeve-bend.png', sheet(frames.filter((_, i) => i % 3 === 0), w, h, 6, 3));
}

// ---------- 3. rifle sling: chain helper, CCD pin, secondary sway ----------
e.run('rig_create', { name: 'sling', frame: [96, 56], root: [20, 14], parts: {
  gun: { w: 60, h: 12, pivot: [14, 5] },
  strap: { w: 3, h: 44, pivot: [1, 0], parent: 'gun', at: [-8, 3], z: -1 },
} });
{
  const c = cellsOf('sling').side, [x, y] = c.gun;
  draw('sling', [
    ...block(x, y + 2, 16, 7, LEATHER), ...block(x + 15, y + 1, 30, 6, METAL), ...block(x + 44, y + 2, 16, 3, METAL),
    ...block(x + 24, y + 6, 6, 6, METAL), ...block(x + 34, y + 6, 4, 5, LEATHER),
    ...block(c.strap[0], c.strap[1], 3, 44, OLIVE, { light: 'left' }),
  ]);
  e.run('rig_chain', { name: 'sling', part: 'strap', bones: 7, secondary: { stiffness: 0.3, damping: 0.2, gravity: 0.8 } });
  e.run('rig_update', { name: 'sling', limits: Object.fromEntries([1, 2, 3, 4, 5, 6].map((i) => [`strap_${i}`, [-40, 40]])) });
  const ik = { strap_7: { target: { part: 'gun', at: [24, 4] }, chain: 7 } };
  const keys = [0, 8, 2, -10, -4].map((r, i) => ({ parts: { gun: { rot: r, y: [0, -2, 0, 2, 0][i] } }, ik }));
  e.run('rig_animate', { name: 'sling', animation: 'carry', view: 'side', keys, frames: 20, fps: 12, canvas: 'sling_carry' });
  const { frames, w, h } = framesOf('sling_carry', 'carry');
  saveGIF('sling.gif', frames, w, h, 4, 1000 / 12);
  savePNG('sling.png', sheet(frames.filter((_, i) => i % 4 === 0), w, h, 5, 3));
}

// ---------- 4. 8-direction humanoid_hd walk with skinned arms and legs ----------
e.run('rig_create', { name: 'hero', template: 'humanoid_hd', frame: [64, 96] });
{
  const P = e.run('rig_info', { name: 'hero', full: true }).parts;
  const long = { upper_arm_f: P.upper_arm_f.h + P.forearm_f.h - 2, upper_arm_b: P.upper_arm_b.h + P.forearm_b.h - 2, thigh_f: P.thigh_f.h + P.shin_f.h - 2, thigh_b: P.thigh_b.h + P.shin_b.h - 2 };
  e.run('rig_update', { name: 'hero', parts: Object.fromEntries(Object.entries(long).map(([k, hh]) => [k, { h: hh }])) });
  const cells = cellsOf('hero');
  const cmds = [];
  const dark = (r) => [r[0], r[0], r[1], r[2], r[3]];
  for (const [v, cs] of Object.entries(cells)) for (const [k0, [x, y, w, h]] of Object.entries(cs)) {
    const [k, variant] = k0.split(':');
    if (/^(forearm|shin)_/.test(k) || ['weapon', 'cape', 'gear_back', 'gear_hip'].includes(k)) continue;
    const far = /_b$/.test(k) && /side/.test(v);
    const tone = (r) => (far ? dark(r) : r);
    if (k === 'head') {
      cmds.push(...block(x, y, w, h, tone(SKIN), { shape: 'ellipse' }));
      cmds.push({ op: 'rect', x, y, w, h: Math.max(2, Math.round(h * 0.35)), color: LEATHER[1] });
      if (v !== 'back' && v !== 'back_side') { const ex = v === 'side' ? x + w - 4 : x + Math.round(w / 2) - 3; cmds.push({ op: 'pixels', color: variant === 'blink' ? SKIN[1] : OL, points: v === 'side' ? [[ex + 1, y + Math.round(h * 0.5)]] : [[ex, y + Math.round(h * 0.5)], [ex + 5, y + Math.round(h * 0.5)]] }); }
    } else if (/upper_arm/.test(k)) {
      cmds.push(...block(x, y, w, h, tone(OLIVE)));
      cmds.push({ op: 'rect', x: x + 1, y: y + Math.round(h * 0.47), w: w - 2, h: 1, color: tone(OLIVE)[1] }, ...block(x, y + h - 5, w, 5, tone(LEATHER)));
    } else if (/thigh/.test(k)) {
      cmds.push(...block(x, y, w, h, tone(CLOTH)));
      cmds.push(...block(x, y + Math.round(h * 0.45), w, 4, tone(METAL)));
    } else if (/hand/.test(k)) cmds.push(...block(x, y, w, h, tone(SKIN), { shape: 'ellipse' }));
    else if (/foot/.test(k)) cmds.push(...block(x, y, w, h, tone(LEATHER)));
    else if (k === 'pelvis') cmds.push(...block(x, y, w, h, CLOTH));
    else cmds.push(...block(x, y, w, h, OLIVE));
  }
  draw('hero', cmds);
  const sk = e.run('rig_skin', { name: 'hero', skin: { arm_f: { part: 'upper_arm_f', absorb: ['forearm_f'] }, arm_b: { part: 'upper_arm_b', absorb: ['forearm_b'] }, leg_f: { part: 'thigh_f', absorb: ['shin_f'] }, leg_b: { part: 'thigh_b', absorb: ['shin_b'] } } });
  log('hero skin', sk.ms, 'ms', JSON.stringify(sk.meshes.arm_f.side));
  const views = ['side', 'front_side', 'front', 'back_side', 'back', 'side_left', 'front_side_left', 'back_side_left'].filter((v) => cells[v] || e.run('rig_info', { name: 'hero' }).mirror?.[v]);
  const rows = [];
  for (const v of views) { e.run('rig_animate', { name: 'hero', preset: 'walk', view: v, canvas: `hero_walk_${v}` }); rows.push(framesOf(`hero_walk_${v}`, `walk_${v}`).frames); }
  const n = rows[0].length;
  savePNG('walk-8dir.png', sheet(rows.flat(), 64, 96, n, 2));
  saveGIF('walk-8dir.gif', beside(rows.map((r) => r.slice(0, n)), 64, 96), 64 * rows.length, 96, 2, 100);
  log('views', views.join(', '));
  const w = e.run('rig_weights', { name: 'hero', mesh: 'leg_f', view: 'side', scale: 6 });
  fs.writeFileSync(path.join(OUT, 'weights-leg.png'), w.image); log('wrote weights-leg.png');
  const x = e.run('rig_export', { name: 'hero', presets: ['walk'], views: ['side'], layers: true });
  log('export', x.file, x.meshes, 'meshes', x.files, 'files');
}
