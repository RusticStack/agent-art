// Hand-drawn first-person arms (art_fp batch with a 2D skin): the same clips and the same 3D solve
// (fpclips.js solveClip: two-bone IK, hands locked onto the drawn gun anchors) drive drawn sprites
// instead of the procedural part sprites. A 2D skin is a set of canvases (meta.fp2d.kind "arm"):
//   upper / fore arm, per view (side | away | toward: how the bone points relative to the eye),
//     with joint (the shoulder / elbow end) and end (the elbow / wrist end) points;
//   hand POSES (trigger, trigger_off, thumb_release, support, vgrip, agrip, mag_pinch, open, relaxed,
//     fist, grenade), per view (back | palm | edge), with wrist and grip (the point that sits on the
//     gun anchor) points; optional layers "back" (behind the gun) and "front" (over it).
// Each part is placed along its projected bone (rotation, foreshortening along the bone, perspective
// size across it) with nearest sampling from a Scale2x upscale, so frames hold only the skin's
// colours. Right-side drawings are mirrored for the left arm (or draw side:"l" variants). The hand
// pose comes from the clip's finger preset per frame (and thumb_release on mag / slide release
// events). Seam for 2D mesh skinning: setDeformer(skin, fn) bends a fore arm or hand sprite before it
// is placed (fn({part, side, pose, view, sprite, bone, frame}) -> sprite).
import { F, FRAME, add, sub, mul, dot, norm, col, project, clamp, r1 } from './fp.js';
import { FINGERS, SKINS, solveArm, handFrame, partSprite, renderBones, ARM, NEAR_BONE } from './fparms.js';
import { LIGHT } from './fp.js';
import { upscale } from './pixelops.js';
import { GUIDES } from './fp2d.js';

const R2D = 180 / Math.PI;
/** Drawing scale of arm templates and traced parts: px per cm (a hand at about 30 cm from the eye). */
export const ARM_PX_PER_CM = 6;
export const LIMB_VIEWS = { toward: 45, side: 90, away: 135 };
export const HAND_VIEWS = ['back', 'palm', 'edge'];
export const HAND_POSES = ['trigger', 'trigger_off', 'thumb_release', 'support', 'vgrip', 'agrip', 'mag_pinch', 'open', 'relaxed', 'fist', 'grenade', 'pinch'];
/** Finger preset of a clip key -> hand pose drawing. */
export const POSE_OF = { trigger: 'trigger', trigger_off: 'trigger_off', support_under: 'support', pistol_cup: 'support', vgrip: 'vgrip', agrip: 'agrip', mag_grasp: 'mag_pinch', pinch: 'pinch', open_palm: 'open', flat_touch: 'open', relaxed: 'relaxed', fist: 'fist', knife_hammer: 'fist', grenade_hold: 'grenade', pin_pull: 'grenade' };
/** A missing pose drawing falls back along this list (then any pose). */
export const POSE_FALLBACK = { trigger_off: ['trigger'], thumb_release: ['trigger'], vgrip: ['support'], agrip: ['support', 'vgrip'], relaxed: ['open', 'support'], open: ['relaxed', 'support'], grenade: ['fist', 'mag_pinch'], mag_pinch: ['support', 'fist'], fist: ['grenade', 'trigger'], support: ['open', 'relaxed'], trigger: ['fist', 'support'], pinch: ['mag_pinch', 'fist'] };
/** Preset a 3D finger pose for each hand pose (trace from the 3D skin). */
const PRESET_OF = { trigger: 'trigger', trigger_off: 'trigger_off', thumb_release: 'trigger_off', support: 'support_under', vgrip: 'vgrip', agrip: 'agrip', mag_pinch: 'mag_grasp', open: 'open_palm', relaxed: 'relaxed', fist: 'fist', grenade: 'grenade_hold', pinch: 'pinch' };

const DEFORMERS = new Map();
/** Optional deformer for a 2D skin (the 2D mesh skinning seam): fn({part, side, pose, view, sprite, bone, frame}) -> sprite | undefined. */
export function setDeformer(skin, fn) { if (fn) DEFORMERS.set(skin, fn); else DEFORMERS.delete(skin); }

// ---------- skins from canvases ----------
const BIG = new WeakMap();
function bigOf(img) {
  let b = BIG.get(img);
  if (!b) { const k = Math.max(img.width, img.height) <= 110 ? 4 : 2; b = { ...upscale(img.data, img.width, img.height, k), k }; BIG.set(img, b); }
  return b;
}
function layerData(doc, name) { const i = doc.layers.findIndex((l) => l.name === name); return i < 0 ? null : doc.composite({ layer: i }); }
/** One part drawing: {part, view, pose, side, img, layers?: {back, front}, origin, axis, len, px_per_cm, ref}. */
function partOf(doc) {
  const m = doc.meta.fp2d;
  const hand = m.part === 'hand';
  const a = hand ? m.grip : m.joint, b = hand ? m.wrist : m.end;
  if (!a || !b) throw new Error(`arm canvas "${doc.name}": needs ${hand ? 'wrist and grip' : 'joint and end'} points (art_fp template makes them)`);
  // axis: joint -> end for limbs; wrist -> grip for hands (origin = grip, the point on the anchor)
  const ax = hand ? [a[0] - b[0], a[1] - b[1]] : [b[0] - a[0], b[1] - a[1]];
  const len = Math.hypot(ax[0], ax[1]) || 1;
  const img = { width: doc.width, height: doc.height, data: doc.composite({ exclude: [GUIDES] }) };
  const lay = (n) => { const d = layerData(doc, n); return d && d.some((v, i) => (i & 3) === 3 && v) ? { width: doc.width, height: doc.height, data: d } : null; };
  const back = lay('back'), front = lay('front'), trigger = lay('trigger');
  const layers = back || front || trigger ? { back, front, trigger } : null;
  return { name: doc.name, part: m.part, view: m.view || (hand ? 'back' : 'side'), pose: m.pose || null, side: m.side || 'r', img, layers, origin: a, axis: [ax[0] / len, ax[1] / len], len, px_per_cm: Number(m.px_per_cm ?? ARM_PX_PER_CM), up: m.up || (hand ? null : '-x'), thumb: m.thumb || 'up', version: `${doc.version}:${doc.updated}` };
}
/** A 2D arm skin by name (canvases with meta.fp2d {kind:"arm", skin}), or null. */
export function skin2dOf(engine, name) {
  if (!engine?.docs || !name) return null;
  const docs = [...engine.docs.values()].filter((d) => d.meta?.fp2d?.kind === 'arm' && d.meta.fp2d.skin === name).sort((a, b) => a.name.localeCompare(b.name));
  if (!docs.length) return null;
  const parts = { upper: [], fore: [], hand: [] };
  for (const d of docs) { const p = partOf(d); if (parts[p.part]) parts[p.part].push(p); }
  if (!parts.hand.length) throw new Error(`2D skin "${name}" has no hand drawings (art_fp template {kind:"arm", part:"hand", pose:"trigger"} or trace)`);
  return { kind: '2d', name, parts, key: docs.map((d) => `${d.name}@${d.version}:${d.updated}`).join('|'), deformer: DEFORMERS.get(name) || null };
}
/** 2D skins in an engine: names. */
export const skins2d = (engine) => [...new Set([...(engine?.docs?.values() || [])].filter((d) => d.meta?.fp2d?.kind === 'arm' && d.meta.fp2d.skin).map((d) => d.meta.fp2d.skin))].sort();

/** The pose drawing of a hand: exact, then the fallbacks, then any. */
export function pickHand(skin, pose, view, side) {
  const tried = [pose, ...(POSE_FALLBACK[pose] || [])];
  for (const p of tried) {
    const list = skin.parts.hand.filter((h) => h.pose === p);
    if (list.length) return pickView(list, view, side, true);
  }
  return pickView(skin.parts.hand, view, side, true);
}
function pickView(list, view, side, hand) {
  const own = list.filter((x) => x.side === side);
  const L = own.length ? own : list;
  if (hand) {
    const order = { back: ['back', 'edge', 'palm'], palm: ['palm', 'edge', 'back'], edge: ['edge', 'back', 'palm'] }[view] || ['back'];
    for (const v of order) { const x = L.find((p) => p.view === v); if (x) return x; }
    return L[0];
  }
  let best = L[0], bd = Infinity;
  for (const p of L) { const d = Math.abs((LIMB_VIEWS[p.view] ?? 90) - view); if (d < bd) { bd = d; best = p; } }
  return best;
}

// ---------- placement ----------
/**
 * Draw sprite part `sp` (or one of its layers) into buf: sprite origin at frame point O, sprite axis
 * along screen angle theta, sa px per sprite px along the axis, sc across it, m = 1 or -1 (mirror
 * across the axis). Nearest sampling at destination pixel centres from the Scale2x upscale.
 */
function place(buf, sp, img, O, theta, sa, sc, m, depthAt, force, handTag, cls = 1) {
  const B = bigOf(img), k = B.k;
  const c = Math.cos(theta), s = Math.sin(theta);
  const ux = sp.axis[0], uy = sp.axis[1], px = -uy, py = ux; // sprite axis + its perpendicular (y down)
  // forward corners for the bounding box
  const corners = [[0, 0], [img.width, 0], [0, img.height], [img.width, img.height]].map(([X, Y]) => {
    const dx = X - sp.origin[0], dy = Y - sp.origin[1];
    const al = (dx * ux + dy * uy) * sa, ac = (dx * px + dy * py) * sc * m;
    return [O[0] + al * c - ac * s, O[1] + al * s + ac * c];
  });
  const { W, H } = buf;
  const x0 = Math.max(0, Math.floor(Math.min(...corners.map((p) => p[0])))), x1 = Math.min(W - 1, Math.ceil(Math.max(...corners.map((p) => p[0]))));
  const y0 = Math.max(0, Math.floor(Math.min(...corners.map((p) => p[1])))), y1 = Math.min(H - 1, Math.ceil(Math.max(...corners.map((p) => p[1]))));
  let n = 0;
  for (let yy = y0; yy <= y1; yy++) for (let xx = x0; xx <= x1; xx++) {
    const dx = xx + 0.5 - O[0], dy = yy + 0.5 - O[1];
    const at = (dx * c + dy * s) / sa, ac = (m * (-dx * s + dy * c)) / sc;
    const u = sp.origin[0] + at * ux + ac * px, v = sp.origin[1] + at * uy + ac * py;
    const U = Math.floor(u * k), V = Math.floor(v * k);
    if (U < 0 || V < 0 || U >= B.width || V >= B.height) continue;
    const si = (V * B.width + U) * 4;
    if (B.data[si + 3] < 128) continue;
    const o = yy * W + xx;
    buf.rgba[o * 4] = B.data[si]; buf.rgba[o * 4 + 1] = B.data[si + 1]; buf.rgba[o * 4 + 2] = B.data[si + 2]; buf.rgba[o * 4 + 3] = 255;
    buf.depth[o] = depthAt(xx, yy);
    buf.force[o] = force;
    buf.hand[o] = handTag;
    buf.cls[o] = cls;
    n++;
  }
  return n;
}
const perpSign = (theta, v) => Math.sign(-v[0] * Math.sin(theta) + v[1] * Math.cos(theta));

/** Nearest finger preset of blended finger values (when a clip blends two keys). */
export function presetOf(f) {
  if (typeof f === 'string') return f;
  let best = 'relaxed', bd = Infinity;
  for (const [n, p] of Object.entries(FINGERS)) {
    const d = [...p.index.map((v, i) => v - f.index[i]), ...p.group.map((v, i) => v - f.group[i]), ...p.thumb.map((v, i) => v - f.thumb[i])].reduce((s, v) => s + v * v, 0);
    if (d < bd) { bd = d; best = n; }
  }
  return best;
}
/** Hand pose of a solved hand in a frame: the clip's finger preset, thumb_release on release events. */
export function handPose(frame, side) {
  const h = frame.hands[side];
  const pose = POSE_OF[presetOf(h.pose ?? h.fingers ?? 'relaxed')] || 'relaxed';
  if (side === 'R' && (pose === 'trigger' || pose === 'trigger_off') && (frame.events || []).some((e) => /mag_release|slide_release/.test(e))) return 'thumb_release';
  return pose;
}

/**
 * Render the arms of one solved frame with a 2D skin. -> {rgba, depth (cm), force (0 = split by
 * depth, 1 = back layer, 2 = front layer), hand (1 = R, 2 = L hand pixel), W, H, poses: {R, L},
 * parts: [{side, part, sprite}]}
 */
export function renderArms2d(frame, skin, size = FRAME, o = {}) {
  const [W, H] = size;
  const buf = { W, H, rgba: new Uint8ClampedArray(W * H * 4), depth: new Float32Array(W * H).fill(Infinity), force: new Uint8Array(W * H), hand: new Uint8Array(W * H), cls: new Uint8Array(W * H) };
  const holding = {}, palms = {};
  const arms = ['R', 'L'].map((side) => {
    const h = frame.hands[side];
    const bones = h.bones;
    const z = bones.filter((b) => b.kind === 'upper' || b.kind === 'fore' || b.kind === 'palm').reduce((s, b) => s - (b.A[2] + b.B[2]) / 2, 0) / 3;
    return { side, h, bones, z };
  }).sort((a, b) => b.z - a.z);
  const poses = {}, used = [];
  for (const { side, h, bones } of arms) {
    const s = side.toLowerCase();
    for (const kind of ['upper', 'fore']) {
      const b = bones.find((x) => x.kind === kind);
      if (!b || !skin.parts[kind].length) continue;
      const zA = -b.A[2], zB = -b.B[2];
      if ((zA + zB) / 2 < NEAR_BONE) continue;
      const pA = project(b.A), pB = project(b.B);
      const C = mul(add(b.A, b.B), 0.5), zc = Math.max(4, -C[2]);
      const toCam = norm(mul(C, -1));
      const tilt = Math.acos(clamp(dot(toCam, col(b.frame, 1)), -1, 1)) * R2D;
      let sp = pickView(skin.parts[kind], tilt, s, false);
      if (skin.deformer && kind === 'fore') sp = skin.deformer({ part: kind, side, view: sp.view, sprite: sp, bone: b, frame }) || sp;
      let theta = Math.atan2(pB[1] - pA[1], pB[0] - pA[0]);
      const L2 = Math.hypot(pB[0] - pA[0], pB[1] - pA[1]);
      if (L2 < 0.5) { const pz = project(add(b.A, col(b.frame, 2))); theta = Math.atan2(pz[1] - pA[1], pz[0] - pA[0]); }
      const sc = (F / zc) / sp.px_per_cm, sa = Math.max(0.25 * sc, L2 / sp.len);
      // mirror so the drawing's "up" side (the part's -x: the outside of a right arm) faces the way it does on screen
      const upRef = sub(project(add(b.A, mul(col(b.frame, 0), -3))), pA);
      const ss = perpSign(theta, upRef);
      const m = ss ? -ss : side === 'R' ? 1 : -1;
      const dAx = pB[0] - pA[0], dAy = pB[1] - pA[1], LL = dAx * dAx + dAy * dAy || 1;
      place(buf, sp, sp.img, pA, theta, sa, sc, m, (px, py) => { const t = clamp(((px + 0.5 - pA[0]) * dAx + (py + 0.5 - pA[1]) * dAy) / LL, 0, 1); return zA + (zB - zA) * t; }, 0, 0);
      used.push({ side, part: kind, sprite: sp.name });
    }
    // hand: the pose drawing with its grip point on the palm (= the gun anchor when holding)
    const palm = bones.find((x) => x.kind === 'palm');
    if (!palm) continue;
    const zW = -palm.A[2], zP = -h.palm[2];
    if ((zW + zP) / 2 < NEAR_BONE) continue;
    const ov = o.override?.[side] || {};
    const pose = ov.pose || handPose(frame, side);
    poses[side] = pose;
    const toCam = norm(mul(h.palm, -1));
    const dd = dot(toCam, col(palm.frame, 2));
    const view = dd > 0.35 ? 'back' : dd < -0.35 ? 'palm' : 'edge';
    let sp = pickHand(skin, pose, view, s);
    if (skin.deformer) sp = skin.deformer({ part: 'hand', side, pose, view, sprite: sp, bone: palm, frame }) || sp;
    const pW = project(palm.A), p0 = project(h.palm), pP = [p0[0] + (ov.dx || 0), p0[1] + (ov.dy || 0)];
    let theta = Math.atan2(pP[1] - pW[1], pP[0] - pW[0]);
    const L2 = Math.hypot(pP[0] - pW[0], pP[1] - pW[1]);
    if (L2 < 0.5) { const pz = project(add(palm.A, mul(col(palm.frame, 1), 2))); theta = Math.atan2(pz[1] - pW[1], pz[0] - pW[0]); }
    const sc = (F / Math.max(4, zP)) / sp.px_per_cm, sa = clamp(L2 / sp.len, 0.5 * sc, 1.15 * sc);
    const tau = side === 'R' ? -1 : 1;
    const thumbRef = sub(project(add(palm.A, mul(col(palm.frame, 0), tau * 3))), pW);
    const ss = perpSign(theta, thumbRef), ts = sp.thumb === 'down' ? 1 : -1;
    const m = ss ? ts * ss : side === 'R' ? 1 : -1;
    const hold = !!h.target2 || !!h.held || frame.item?.hand === side || (side === 'L' && frame.mag?.state === 'hand');
    holding[side] = hold; palms[side] = { at: pP, z: zP, len: (sp.len / sp.px_per_cm) * (F / Math.max(4, zP)) };
    const tag = side === 'R' ? 1 : 2, zh = () => zP;
    // layers back / front decide only while the hand holds something; a free hand splits by depth
    // cls: 2 = behind the held object (palm, far fingers), 3 = over it (near fingers, thumb), 4 = the trigger finger (through the guard)
    if (sp.layers) {
      if (sp.layers.back) place(buf, sp, sp.layers.back, pP, theta, sa, sc, m, zh, hold ? 1 : 0, tag, 2);
      if (sp.layers.front) place(buf, sp, sp.layers.front, pP, theta, sa, sc, m, zh, hold ? 2 : 0, tag, 3);
      if (sp.layers.trigger) place(buf, sp, sp.layers.trigger, pP, theta, sa, sc, m, zh, hold ? 2 : 0, tag, 4);
    } else place(buf, sp, sp.img, pP, theta, sa, sc, m, zh, hold ? 2 : 0, tag, 3);
    used.push({ side, part: 'hand', sprite: sp.name, pose, view });
  }
  return { ...buf, poses, parts: used, holding, palms };
}

// ---------- templates and tracing ----------
/** Blank layout of an arm part canvas: size, points, guide commands. */
export function armTemplate(part, o = {}) {
  const s = Number(o.px_per_cm ?? ARM_PX_PER_CM);
  const G = '#ff40ff', G2 = '#40c0ff';
  if (part === 'hand') {
    const palmL = ARM.palm * s, fing = (ARM.finger[0] + ARM.finger[1]) * s, wHalf = (ARM.palmW / 2) * s;
    const width = Math.ceil(palmL + fing + 16), height = Math.ceil(wHalf * 2 + 4 * s + 16);
    const wrist = [8, Math.round(height / 2) + 0.5], grip = [r1(8 + palmL / 2), wrist[1]];
    const guides = [
      { op: 'rect', x: 8, y: Math.round(wrist[1] - wHalf), w: Math.round(palmL), h: Math.round(wHalf * 2), color: G2, fill: false },
      { op: 'line', x1: Math.round(8 + palmL), y1: Math.floor(wrist[1]), x2: width - 4, y2: Math.floor(wrist[1]), color: G2 },
      { op: 'pixels', color: G, points: [[Math.floor(wrist[0]), Math.floor(wrist[1])], [Math.floor(grip[0]), Math.floor(grip[1])], [Math.floor(grip[0]) - 1, Math.floor(grip[1])], [Math.floor(grip[0]) + 1, Math.floor(grip[1])], [Math.floor(grip[0]), Math.floor(grip[1]) - 1], [Math.floor(grip[0]), Math.floor(grip[1]) + 1]] },
      { op: 'pixels', color: G, points: [[Math.floor(grip[0]), Math.floor(wrist[1] - wHalf - 2 * s)]] }, // thumb side marker (up)
    ];
    return { width, height, points: { wrist, grip }, guides, px_per_cm: s, note: 'fingers point right, back of the hand toward you (view back), thumb on the marked (upper) side; grip = the point that sits on the gun anchor; layers back (behind the gun) / front (over it)' };
  }
  const L = (part === 'upper' ? ARM.upper : ARM.fore) * s, r = (part === 'upper' ? ARM.r_upper[0] : ARM.r_fore[0]) * s;
  const width = Math.ceil(L + 2 * r + 12), height = Math.ceil(2 * r + 12);
  const joint = [Math.round(r + 6) + 0.5, Math.round(height / 2) + 0.5], end = [r1(joint[0] + L), joint[1]];
  const guides = [
    { op: 'line', x1: Math.floor(joint[0]), y1: Math.floor(joint[1]), x2: Math.floor(end[0]), y2: Math.floor(end[1]), color: G2 },
    { op: 'ellipse', x: Math.floor(joint[0] - r), y: Math.floor(joint[1] - r), w: Math.round(2 * r), h: Math.round(2 * r), color: G2, fill: false },
    { op: 'pixels', color: G, points: [[Math.floor(joint[0]), Math.floor(joint[1])], [Math.floor(end[0]), Math.floor(end[1])]] },
  ];
  return { width, height, points: { joint, end }, guides, px_per_cm: s, note: `${part === 'upper' ? 'shoulder' : 'elbow'} on the left joint, ${part === 'upper' ? 'elbow' : 'wrist'} on the right end; the outside of the arm up (view side; away = the far end foreshortened)` };
}

/**
 * Editable canvases traced from a procedural 3D skin (#16's part sprites), meta filled so they are a
 * 2D skin as they are: upper / fore (views side and away) and hand poses (views back and palm).
 * -> [{name, width, height, data, meta}]
 */
export function traceSkin(skin3d, name, o = {}) {
  if (!SKINS[skin3d]) throw new Error(`unknown 3D skin "${skin3d}" (${Object.keys(SKINS).join(', ')})`);
  const s = Number(o.px_per_cm ?? ARM_PX_PER_CM), out = [];
  const L3 = [LIGHT[0], LIGHT[1], LIGHT[2]];
  const crop = (rgba, W, H, pts) => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (rgba[(y * W + x) * 4 + 3]) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    for (const p of pts) { x0 = Math.min(x0, Math.floor(p[0])); x1 = Math.max(x1, Math.ceil(p[0])); y0 = Math.min(y0, Math.floor(p[1])); y1 = Math.max(y1, Math.ceil(p[1])); }
    x0 -= 2; y0 -= 2; x1 += 3; y1 += 3;
    const w = x1 - x0, h = y1 - y0, d = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const X = x0 + x, Y = y0 + y; if (X < 0 || Y < 0 || X >= W || Y >= H) continue; d.set(rgba.subarray((Y * W + X) * 4, (Y * W + X) * 4 + 4), (y * w + x) * 4); }
    return { w, h, d, x0, y0 };
  };
  const parts = o.parts ? [].concat(o.parts) : ['upper', 'fore', 'hand'];
  for (const part of parts.filter((p) => p !== 'hand')) {
    for (const [view, tilt] of [['side', 90], ['away', 135]]) {
      const t = tilt / R2D, sp = partSprite(part, skin3d, [0, Math.cos(t), Math.sin(t)], s, L3);
      const end = [sp.ax + sp.axis[0] * (part === 'upper' ? ARM.upper : ARM.fore) * s * Math.sin(t), sp.ay + sp.axis[1] * (part === 'upper' ? ARM.upper : ARM.fore) * s * Math.sin(t)];
      out.push({ name: `${name}_${part}_${view}`, width: sp.width, height: sp.height, data: sp.data, meta: { fp2d: { kind: 'arm', skin: name, part, view, joint: [sp.ax, sp.ay], end: end.map(r1), px_per_cm: s, up: '-x', traced_from: skin3d } } });
    }
  }
  if (parts.includes('hand')) {
    const poses = o.poses ? [].concat(o.poses) : HAND_POSES;
    const [W, H] = FRAME, P = [0, 0, -F / s];
    for (const pose of poses) for (const view of o.views ? [].concat(o.views) : ['back', 'palm']) {
      const R = handFrame([1, 0, 0], view === 'back' ? [0, 0, 1] : [0, 0, -1]);
      const sol = solveArm('r', P, R, FINGERS[PRESET_OF[pose]]);
      const bones = sol.bones.filter((b) => !/^(upper|fore)$/.test(b.kind));
      const buf = renderBones(bones, skin3d, [W, H]);
      const pw = project(sol.wrist), pp = project(sol.palm);
      const wrist = [pw[0], pw[1]], grip = [pp[0], pp[1]];
      // layers: what lies on the eye's side of the held grip (palm centre + 1.9 cm toward the palm side) is front
      const zg = -add(sol.palm, mul(col(R, 1), -1.9))[2];
      const back = new Uint8ClampedArray(W * H * 4), front = new Uint8ClampedArray(W * H * 4), trig = new Uint8ClampedArray(W * H * 4);
      // trigger poses: the visible index finger is its own layer (it goes through the guard)
      const tb = pose === 'trigger' || pose === 'thumb_release' ? renderBones(bones.filter((b) => /^index/.test(b.name)), skin3d, [W, H]) : null;
      for (let i = 0; i < W * H; i++) {
        if (!buf.rgba[i * 4 + 3]) continue;
        const L = tb && tb.rgba[i * 4 + 3] && tb.depth[i] <= buf.depth[i] + 0.05 ? trig : buf.depth[i] < zg ? front : back;
        L.set(buf.rgba.subarray(i * 4, i * 4 + 4), i * 4);
      }
      const c = crop(buf.rgba, W, H, [wrist, grip]);
      const cut = (img) => { const d = new Uint8ClampedArray(c.w * c.h * 4); for (let y = 0; y < c.h; y++) for (let x = 0; x < c.w; x++) { const X = c.x0 + x, Y = c.y0 + y; if (X < 0 || Y < 0 || X >= W || Y >= H) continue; d.set(img.subarray((Y * W + X) * 4, (Y * W + X) * 4 + 4), (y * c.w + x) * 4); } return d; };
      const thumbP = project(sol.tips.thumb), ax = [grip[0] - wrist[0], grip[1] - wrist[1]];
      const thumb = -ax[1] * (thumbP[0] - wrist[0]) + ax[0] * (thumbP[1] - wrist[1]) > 0 ? 'down' : 'up';
      out.push({ name: `${name}_hand_${pose}_${view}`, width: c.w, height: c.h, data: c.d, layers: { back: cut(back), front: cut(front), ...(tb ? { trigger: cut(trig) } : {}) }, meta: { fp2d: { kind: 'arm', skin: name, part: 'hand', pose, view, wrist: [r1(wrist[0] - c.x0), r1(wrist[1] - c.y0)], grip: [r1(grip[0] - c.x0), r1(grip[1] - c.y0)], px_per_cm: s, thumb, traced_from: skin3d } } });
    }
  }
  return out;
}
