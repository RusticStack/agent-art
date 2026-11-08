// Rigs: consistent multi-view, multi-animation assets.
// A rig has parts (drawn once per view on a "parts" canvas), joints (pivot + parent + rest
// offset), and poses (per-part offset/rotation/variant). Frames are generated from the same
// part pixels, so a character cannot drift between frames, animations or directions, and
// in-betweens can be tweened at any frame rate (rotation uses RotSprite-style sampling).
import { upscale } from './pixelops.js';

const NAME = /^[\w-]+$/;
const GAP = 1;

/** Validate + normalize a rig definition and compute the parts-canvas layout. */
export function normalizeRig(def) {
  const frame = def.frame;
  if (!Array.isArray(frame) || frame.length !== 2 || !frame.every((v) => Number.isInteger(v) && v > 0 && v <= 1024)) throw new Error('rig "frame" must be [width, height]');
  const views = def.views?.length ? def.views : ['side'];
  for (const v of views) if (!NAME.test(v)) throw new Error(`bad view name "${v}"`);
  const mirror = { ...(def.mirror || {}) };
  for (const [m, src] of Object.entries(mirror)) {
    if (!views.includes(src)) throw new Error(`mirror view "${m}" needs a drawn source view "${src}" (one of ${views.join(', ')})`);
    if (views.includes(m)) throw new Error(`"${m}" is both a drawn view and a mirror view`);
  }
  const parts = {};
  const order = Object.keys(def.parts || {});
  if (!order.length) throw new Error('rig needs "parts": {name: {w, h, pivot:[x,y], parent?, at?:[dx,dy], z?, variants?, views?}}');
  for (const name of order) {
    if (!NAME.test(name)) throw new Error(`bad part name "${name}"`);
    const p = def.parts[name];
    const w = Number(p.w), h = Number(p.h);
    if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1) throw new Error(`part "${name}" needs integer w,h`);
    const pivot = p.pivot ?? [Math.floor(w / 2), Math.floor(h / 2)];
    parts[name] = {
      w, h, pivot: [Number(pivot[0]), Number(pivot[1])], parent: p.parent ?? null, at: p.at ? [Number(p.at[0]), Number(p.at[1])] : [0, 0],
      z: Number(p.z ?? 0), variants: ['base', ...(p.variants || []).filter((v) => v !== 'base')], views: p.views || {},
    };
  }
  for (const name of order) {
    const par = parts[name].parent;
    if (par && !parts[par]) throw new Error(`part "${name}" has unknown parent "${par}"`);
    // cycle check
    let k = par, guard = 0;
    while (k) { if (k === name || guard++ > 64) throw new Error(`parent cycle at part "${name}"`); k = parts[k].parent; }
    for (const v of Object.keys(parts[name].views)) if (!views.includes(v)) throw new Error(`part "${name}" has settings for unknown view "${v}"`);
  }
  const roots = order.filter((n) => !parts[n].parent);
  // layout: one column per (part, variant), one row band per view
  const columns = [];
  let x = 0;
  for (const name of order) for (const variant of parts[name].variants) {
    columns.push({ part: name, variant, x });
    x += parts[name].w + GAP;
  }
  const rowH = Math.max(...order.map((n) => parts[n].h)) + GAP;
  const width = Math.max(1, x - GAP), height = views.length * rowH - GAP;
  // auto pairs for mirror_pairs (leg_f/leg_b, arm_l/arm_r, ...)
  const pairs = def.pairs || [];
  if (!def.pairs) {
    const suf = [['_f', '_b'], ['_l', '_r'], ['_front', '_back'], ['_left', '_right']];
    for (const n of order) for (const [a, b] of suf) if (n.endsWith(a) && parts[n.slice(0, -a.length) + b]) pairs.push([n, n.slice(0, -a.length) + b]);
  }
  return {
    frame, views, mirror, parts, order, roots, pairs,
    root: def.root ? [Number(def.root[0]), Number(def.root[1])] : [Math.floor(frame[0] / 2), Math.floor(frame[1] * 0.75)],
    poses: def.poses || {}, layout: { columns, rowH, width, height },
  };
}

/** Cell of a part (variant) in a drawn view on the parts canvas. */
export function cellOf(rig, part, view, variant = 'base') {
  const vi = rig.views.indexOf(view);
  if (vi < 0) throw new Error(`unknown view "${view}" (drawn views: ${rig.views.join(', ')})`);
  const col = rig.layout.columns.find((c) => c.part === part && c.variant === variant);
  if (!col) throw new Error(`part "${part}" has no variant "${variant}"`);
  const p = rig.parts[part];
  return { x: col.x, y: vi * rig.layout.rowH, w: p.w, h: p.h };
}

/** Per-view part settings (at, z, hidden, pivot) with fallbacks. */
function partIn(rig, name, view) {
  const p = rig.parts[name], o = p.views[view] || {};
  return { ...p, at: o.at ? [Number(o.at[0]), Number(o.at[1])] : p.at, z: o.z ?? p.z, hidden: !!o.hidden, pivot: o.pivot ? [Number(o.pivot[0]), Number(o.pivot[1])] : p.pivot };
}

const ease = (t, kind) => (kind === 'linear' ? t : kind === 'step' ? 0 : t * t * (3 - 2 * t));

/** Pose values for a part: {x, y, rot, sx, sy, variant, hide}. */
function poseOf(rig, pose, name) {
  const v = (typeof pose === 'string' ? rig.poses[pose] : pose)?.[name] || {};
  return { x: Number(v.x ?? 0), y: Number(v.y ?? 0), rot: Number(v.rot ?? 0), sx: Number(v.sx ?? 1) || 1, sy: Number(v.sy ?? 1) || 1, variant: v.variant ?? null, hide: !!v.hide };
}

/** Resolve a pose reference ({pose} | inline parts) and optional pair swap into a pose object. */
export function resolvePose(rig, key) {
  let p = key.pose !== undefined ? rig.poses[key.pose] : key.parts;
  if (key.pose !== undefined && !p) throw new Error(`unknown pose "${key.pose}" (have: ${Object.keys(rig.poses).join(', ') || 'none'})`);
  p = { ...(p || {}) };
  if (key.mirror_pairs) {
    for (const [a, b] of rig.pairs) [p[a], p[b]] = [p[b], p[a]];
    for (const k of Object.keys(p)) if (p[k] === undefined) delete p[k];
  }
  return p;
}

/** Blend two poses at t (0..1) per part. Variants/hide switch at the midpoint. */
export function lerpPose(rig, a, b, t) {
  const out = {};
  for (const name of rig.order) {
    const pa = poseOf(rig, a, name), pb = poseOf(rig, b, name);
    let dr = pb.rot - pa.rot;
    if (dr > 180) dr -= 360;
    if (dr < -180) dr += 360;
    out[name] = { x: pa.x + (pb.x - pa.x) * t, y: pa.y + (pb.y - pa.y) * t, rot: pa.rot + dr * t, sx: pa.sx + (pb.sx - pa.sx) * t, sy: pa.sy + (pb.sy - pa.sy) * t, variant: t < 0.5 ? pa.variant : pb.variant, hide: t < 0.5 ? pa.hide : pb.hide };
  }
  return out;
}

/** Poses for each frame of an animation from keys [{pose|parts, t?, ease?, mirror_pairs?}]. */
export function animatePoses(rig, { keys, frames, loop = true }) {
  if (!Array.isArray(keys) || !keys.length) throw new Error('animate needs "keys": [{pose:"name"}, ...]');
  const n = Math.max(1, Math.round(Number(frames ?? keys.length)));
  const ks = keys.map((k, i) => ({ pose: resolvePose(rig, k), t: k.t !== undefined ? Number(k.t) : loop ? i / keys.length : keys.length > 1 ? i / (keys.length - 1) : 0, ease: k.ease || 'smooth' }));
  for (let i = 1; i < ks.length; i++) if (!(ks[i].t >= ks[i - 1].t)) throw new Error('key "t" values must increase (0..1)');
  const out = [];
  for (let f = 0; f < n; f++) {
    const time = loop ? f / n : n > 1 ? f / (n - 1) : 0;
    let i = ks.length - 1;
    while (i > 0 && ks[i].t > time + 1e-9) i--;
    const a = ks[i];
    const b = i + 1 < ks.length ? ks[i + 1] : loop ? { ...ks[0], t: 1 } : a;
    const span = b.t - a.t;
    const u = span > 0 ? Math.min(1, (time - a.t) / span) : 0;
    out.push(lerpPose(rig, a.pose, b.pose, ease(u, b.ease)));
  }
  return out;
}

function compositeArt(doc, cache) {
  if (!cache.has('__art')) {
    const saved = doc.layers;
    doc.layers = saved.filter((l) => l.name !== 'cells');
    try { cache.set('__art', doc.composite()); } finally { doc.layers = saved; }
  }
  return cache.get('__art');
}

/** Lowest painted row of an RGBA frame (-1 if empty). */
export function lowestRow(data, w, h) {
  for (let y = h - 1; y >= 0; y--) for (let x = 0; x < w; x++) if (data[(y * w + x) * 4 + 3]) return y;
  return -1;
}

/** Shift a frame vertically by dy (positive = down), filling with transparent. */
export function shiftFrame(data, w, h, dy) {
  if (!dy) return data;
  const out = new Uint8ClampedArray(data.length);
  for (let y = 0; y < h; y++) {
    const sy = y - dy;
    if (sy < 0 || sy >= h) continue;
    out.set(data.subarray(sy * w * 4, (sy + 1) * w * 4), y * w * 4);
  }
  return out;
}

/** Cache of 8x Scale2x-upscaled part cells (for clean rotation sampling). */
function partImage(cache, partsDoc, rig, name, view, variant) {
  const key = `${name}|${view}|${variant}|${partsDoc.version ?? 0}`;
  if (cache.has(key)) return cache.get(key);
  const c = cellOf(rig, name, view, variant);
  // art layers only: the "cells" guide layer must never leak into frames
  const comp = compositeArt(partsDoc, cache);
  const W = partsDoc.width;
  const block = new Uint8ClampedArray(c.w * c.h * 4);
  for (let y = 0; y < c.h; y++) block.set(comp.subarray(((c.y + y) * W + c.x) * 4, ((c.y + y) * W + c.x + c.w) * 4), y * c.w * 4);
  const big = upscale(block, c.w, c.h, 8).data;
  const img = { w: c.w, h: c.h, block, big };
  cache.set(key, img);
  return img;
}

/** World transforms (translation + rotation) of every part, parent-first. */
function solver(rig, P, src) {
  const world = {};
  const solve = (name) => {
    if (world[name]) return world[name];
    const p = partIn(rig, name, src), v = poseOf(rig, P, name);
    const base = p.parent ? solve(p.parent) : { x: rig.root[0], y: rig.root[1], rot: 0 };
    const ox = p.at[0] + v.x, oy = p.at[1] + v.y;
    const r = (base.rot * Math.PI) / 180;
    const pos = { x: base.x + ox * Math.cos(r) - oy * Math.sin(r), y: base.y + ox * Math.sin(r) + oy * Math.cos(r), rot: base.rot + v.rot };
    world[name] = pos;
    return pos;
  };
  return solve;
}

/**
 * Per-part anchor points for one pose in a view: the pivot's frame position (pixel-snapped) and
 * world rotation, mirrored for mirror views. Game engines attach gear/effects to these.
 */
export function poseAnchors(rig, pose, view) {
  let src = view, flip = false;
  if (rig.mirror[view]) { src = rig.mirror[view]; flip = true; }
  const P = typeof pose === 'string' ? resolvePose(rig, { pose }) : pose || {};
  const solve = solver(rig, P, src);
  const out = {};
  for (const name of rig.order) {
    const T = solve(name);
    const x = Math.round(T.x), y = Math.round(T.y), rot = Math.round(((((T.rot % 360) + 540) % 360) - 180) * 10) / 10;
    out[name] = flip ? [2 * rig.root[0] - 1 - x, y, -rot] : [x, y, rot];
  }
  return out;
}

/**
 * Render one pose in a view to an RGBA frame. Mirror views render their source view and flip
 * around the root x. Parts are snapped to whole pixels; rotation samples the 8x image.
 */
export function renderPose(rig, partsDoc, pose, view, cache = new Map(), opts = {}) {
  const [FW, FH] = rig.frame;
  let src = view, flip = false;
  if (rig.mirror[view]) { src = rig.mirror[view]; flip = true; }
  if (!rig.views.includes(src)) throw new Error(`unknown view "${view}" (views: ${[...rig.views, ...Object.keys(rig.mirror)].join(', ')})`);
  const P = typeof pose === 'string' ? resolvePose(rig, { pose }) : pose || {};
  const solve = solver(rig, P, src);
  const out = new Uint8ClampedArray(FW * FH * 4);
  const list = rig.order.map((name, i) => ({ name, i, p: partIn(rig, name, src), v: poseOf(rig, P, name) }))
    .filter((e) => !e.p.hidden && !e.v.hide && (!opts.only || opts.only.includes(e.name)) && !(opts.hide && opts.hide.includes(e.name)))
    .sort((a, b) => a.p.z - b.p.z || a.i - b.i);
  for (const { name, p, v } of list) {
    const T = solve(name);
    const img = partImage(cache, partsDoc, rig, name, src, v.variant ?? 'base');
    const px = Math.round(T.x), py = Math.round(T.y); // pixel-snapped pivot position
    const rot = ((T.rot % 360) + 360) % 360;
    const rad = (-rot * Math.PI) / 180, cos = Math.cos(rad), sin = Math.sin(rad);
    const sx = Math.max(0.05, v.sx), sy = Math.max(0.05, v.sy); // squash & stretch around the pivot
    const R = Math.ceil(Math.hypot(p.w, p.h) * Math.max(1, sx, sy)) + 1;
    const exact = Math.abs(rot) < 1e-6 && Math.abs(sx - 1) < 1e-6 && Math.abs(sy - 1) < 1e-6;
    for (let y = py - R; y <= py + R; y++) for (let x = px - R; x <= px + R; x++) {
      if (x < 0 || y < 0 || x >= FW || y >= FH) continue;
      let c;
      if (exact) {
        const u = x - px + p.pivot[0], w2 = y - py + p.pivot[1];
        if (u < 0 || w2 < 0 || u >= p.w || w2 >= p.h) continue;
        const s = (w2 * p.w + u) * 4;
        if (!img.block[s + 3]) continue;
        c = img.block.subarray(s, s + 4);
      } else {
        // inverse-rotate the destination pixel centre into the part's 8x space
        const dx = x + 0.5 - px, dy = y + 0.5 - py;
        const u = ((dx * cos - dy * sin) / sx + p.pivot[0]) * 8, w2 = ((dx * sin + dy * cos) / sy + p.pivot[1]) * 8;
        const iu = Math.floor(u), iv = Math.floor(w2);
        if (iu < 0 || iv < 0 || iu >= p.w * 8 || iv >= p.h * 8) continue;
        const s = (iv * p.w * 8 + iu) * 4;
        if (!img.big[s + 3]) continue;
        c = img.big.subarray(s, s + 4);
      }
      out.set(c, (y * FW + x) * 4);
    }
  }
  if (flip) {
    const fx = (x) => 2 * rig.root[0] - 1 - x;
    const m = new Uint8ClampedArray(out.length);
    for (let y = 0; y < FH; y++) for (let x = 0; x < FW; x++) {
      const sx = fx(x);
      if (sx < 0 || sx >= FW) continue;
      m.set(out.subarray((y * FW + sx) * 4, (y * FW + sx) * 4 + 4), (y * FW + x) * 4);
    }
    return m;
  }
  return out;
}
