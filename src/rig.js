// Rigs: consistent multi-view, multi-animation assets.
// A rig has parts (drawn once per view on a "parts" canvas), joints (pivot + parent + rest
// offset), and poses (per-part offset/rotation/variant, optional per-view overrides and two-bone
// IK). Frames are generated from the same part pixels, so a character cannot drift between
// frames, animations or directions, and in-betweens can be tweened at any frame rate.
// Per frame: view overrides -> FK -> IK -> render (rotation sampled per rig "sampling" mode).
import { upscale } from './pixelops.js';

const NAME = /^[\w-]+$/;
const GAP = 1;
const RESERVED = new Set(['views', 'ik']);
export const SAMPLING = ['nearest8', 'rotsprite', 'smooth'];
const D2R = Math.PI / 180;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;
/** Shortest signed angle difference b - a in degrees (-180..180]. */
const adiff = (a, b) => { let d = (b - a) % 360; if (d > 180) d -= 360; if (d <= -180) d += 360; return d; };

/** Validate secondary-motion settings: {part: {stiffness 0..1, damping 0..1, gravity?, inertia?}}. */
export function normalizeSecondary(parts, sec) {
  const out = {};
  for (const [n, s] of Object.entries(sec || {})) {
    if (s === null || s === false) continue;
    if (!parts[n]) throw new Error(`secondary: unknown part "${n}"`);
    if (!parts[n].parent) throw new Error(`secondary: part "${n}" needs a parent (it swings around its pivot on the parent)`);
    const c = (v, d) => clamp(Number(v ?? d), 0, 1);
    out[n] = { stiffness: c(s?.stiffness, 0.5), damping: c(s?.damping, 0.3), gravity: Number(s?.gravity ?? 0) || 0, inertia: Number(s?.inertia ?? 1) || 0 };
  }
  return out;
}

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
    if (RESERVED.has(name)) throw new Error(`"${name}" is reserved in poses (per-view overrides / IK); pick another part name`);
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
  const sampling = def.sampling ?? 'nearest8';
  if (!SAMPLING.includes(sampling)) throw new Error(`rig "sampling" must be one of ${SAMPLING.join(', ')}`);
  const secondary = normalizeSecondary(parts, def.secondary);
  const chain2 = (n) => parts[n]?.parent && parts[parts[n].parent].parent;
  let feet;
  if (def.feet) {
    feet = typeof def.feet === 'string' ? [def.feet] : def.feet;
    if (!Array.isArray(feet)) throw new Error('rig "feet" must be an array of part names (e.g. ["foot_f", "foot_b"])');
    for (const f of feet) if (!chain2(f)) throw new Error(`feet: "${f}" must be a part with a parent and a grandparent (foot -> shin -> thigh)`);
  } else feet = order.filter((n) => /^foot/.test(n) && chain2(n));
  return {
    frame, views, mirror, parts, order, roots, pairs,
    root: def.root ? [Number(def.root[0]), Number(def.root[1])] : [Math.floor(frame[0] / 2), Math.floor(frame[1] * 0.75)],
    poses: def.poses || {}, layout: { columns, rowH, width, height },
    sampling, secondary, feet, scaleChildren: !!def.scale_children,
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

const asPose = (rig, p) => (typeof p === 'string' ? rig.poses[p] : p) || {};

/**
 * Flatten a pose for one drawn view: per-part fields of pose.views[view] are merged over the base
 * pose, and view IK entries over the base IK. Mirror views pass their source view.
 */
export function viewPose(rig, pose, view) {
  const P = asPose(rig, pose);
  const o = P.views?.[view];
  const out = {};
  for (const k of Object.keys(P)) if (!RESERVED.has(k)) out[k] = P[k];
  if (o) for (const [k, v] of Object.entries(o)) if (k !== 'ik' && v) out[k] = { ...(out[k] || {}), ...v };
  const ik = { ...(P.ik || {}) };
  for (const [k, v] of Object.entries(o?.ik || {})) ik[k] = v === null ? undefined : { ...(ik[k] || {}), ...v };
  for (const k of Object.keys(ik)) if (!ik[k]) delete ik[k];
  if (Object.keys(ik).length) out.ik = ik;
  return out;
}

function swapTarget(sw, t) {
  if (!t || Array.isArray(t)) return t;
  if (t.mix) return { mix: [swapTarget(sw, t.mix[0]), swapTarget(sw, t.mix[1]), t.mix[2]] };
  return t.part ? { ...t, part: sw.get(t.part) ?? t.part } : t;
}

/** Swap paired parts (leg_f <-> leg_b) everywhere in a pose: parts, view overrides, IK ends and targets. */
function swapPairs(rig, p) {
  const sw = new Map();
  for (const [a, b] of rig.pairs) { sw.set(a, b); sw.set(b, a); }
  const parts = (o) => {
    const r = {};
    for (const [k, v] of Object.entries(o)) if (!RESERVED.has(k) && v !== undefined) r[sw.get(k) ?? k] = v;
    if (o.ik) r.ik = Object.fromEntries(Object.entries(o.ik).map(([k, e]) => [sw.get(k) ?? k, e && { ...e, target: swapTarget(sw, e.target) }]));
    return r;
  };
  const out = parts(p);
  if (p.views) out.views = Object.fromEntries(Object.entries(p.views).map(([v, o]) => [v, parts(o || {})]));
  return out;
}

/** Resolve a pose reference ({pose} | inline parts, + key-level views/ik) and optional pair swap into a pose object. */
export function resolvePose(rig, key) {
  let p = key.pose !== undefined ? rig.poses[key.pose] : key.parts;
  if (key.pose !== undefined && !p) throw new Error(`unknown pose "${key.pose}" (have: ${Object.keys(rig.poses).join(', ') || 'none'})`);
  p = structuredClone(p || {});
  if (key.views) {
    p.views = { ...(p.views || {}) };
    for (const [v, o] of Object.entries(key.views)) p.views[v] = { ...(p.views[v] || {}), ...structuredClone(o) };
  }
  if (key.ik) p.ik = { ...(p.ik || {}), ...structuredClone(key.ik) };
  if (key.mirror_pairs) p = swapPairs(rig, p);
  return p;
}

function lerpParts(rig, a, b, t) {
  const out = {};
  for (const name of rig.order) {
    const pa = poseOf(rig, a, name), pb = poseOf(rig, b, name);
    out[name] = { x: lerp(pa.x, pb.x, t), y: lerp(pa.y, pb.y, t), rot: pa.rot + adiff(pa.rot, pb.rot) * t, sx: lerp(pa.sx, pb.sx, t), sy: lerp(pa.sy, pb.sy, t), variant: t < 0.5 ? pa.variant : pb.variant, hide: t < 0.5 ? pa.hide : pb.hide };
  }
  return out;
}

function lerpTarget(ta, tb, t) {
  if (t <= 0) return ta;
  if (t >= 1) return tb;
  if (Array.isArray(ta) && Array.isArray(tb)) return [lerp(+ta[0], +tb[0], t), lerp(+ta[1], +tb[1], t)];
  if (ta?.part && tb?.part && ta.part === tb.part) {
    const A = ta.at || [0, 0], B = tb.at || [0, 0];
    return { part: ta.part, at: [lerp(+A[0], +B[0], t), lerp(+A[1], +B[1], t)] };
  }
  return { mix: [ta, tb, t] }; // different kinds / parts: blend the solved world points
}

/** Blend IK specs. An end present in one key only fades its weight in/out (IK <-> FK blend). */
function lerpIK(A, B, t) {
  const ends = new Set([...Object.keys(A || {}), ...Object.keys(B || {})]);
  if (!ends.size) return null;
  const w = (e) => Number(e.weight ?? 1), rw = (e) => Number(e.rot_weight ?? 1);
  const out = {};
  for (const end of ends) {
    const ea = A?.[end], eb = B?.[end];
    if (ea && eb) {
      const r = { target: lerpTarget(ea.target, eb.target, t), bend: t < 0.5 ? ea.bend : eb.bend, plane: t < 0.5 ? ea.plane : eb.plane, weight: lerp(w(ea), w(eb), t) };
      if (ea.rot !== undefined && eb.rot !== undefined) { r.rot = ea.rot + adiff(ea.rot, eb.rot) * t; r.rot_weight = lerp(rw(ea), rw(eb), t); }
      else if (ea.rot !== undefined) { r.rot = ea.rot; r.rot_weight = rw(ea) * (1 - t); }
      else if (eb.rot !== undefined) { r.rot = eb.rot; r.rot_weight = rw(eb) * t; }
      out[end] = r;
    } else if (ea) out[end] = { ...ea, weight: w(ea) * (1 - t) };
    else out[end] = { ...eb, weight: w(eb) * t };
  }
  return out;
}

/** Blend two poses at t (0..1) per part, per view override and per IK end. Variants/hide switch at the midpoint. */
export function lerpPose(rig, a, b, t) {
  const A = asPose(rig, a), B = asPose(rig, b);
  const out = lerpParts(rig, A, B, t);
  const ik = lerpIK(A.ik, B.ik, t);
  if (ik) out.ik = ik;
  const vs = new Set([...Object.keys(A.views || {}), ...Object.keys(B.views || {})]);
  if (vs.size) {
    out.views = {};
    for (const v of vs) {
      const va = viewPose(rig, A, v), vb = viewPose(rig, B, v);
      const o = lerpParts(rig, va, vb, t);
      const vik = lerpIK(va.ik, vb.ik, t);
      if (vik) o.ik = vik;
      out.views[v] = o;
    }
  }
  return out;
}

/** Poses for each frame of an animation from keys [{pose|parts, views?, ik?, t?, ease?, mirror_pairs?}]. */
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

/** Cache of part cells: 1x block + 8x Scale2x upscale (for clean rotation sampling). */
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
  const img = { w: c.w, h: c.h, block, big, block32: new Uint32Array(block.buffer, block.byteOffset, c.w * c.h), big32: new Uint32Array(big.buffer, big.byteOffset, c.w * c.h * 64) };
  cache.set(key, img);
  return img;
}

/** World transforms (pivot position + rotation) of every part in a drawn view, parent-first. */
function worldOf(rig, VP, src) {
  const world = {};
  const solve = (name) => {
    if (world[name]) return world[name];
    const p = partIn(rig, name, src), v = poseOf(rig, VP, name);
    let base, psx = 1, psy = 1;
    if (p.parent) {
      base = solve(p.parent);
      // scale_children: a parent's sx/sy (foreshortening, breathing) also moves its children's joints
      if (rig.scaleChildren) { const pv = poseOf(rig, VP, p.parent); psx = pv.sx; psy = pv.sy; }
    } else base = { x: rig.root[0], y: rig.root[1], rot: 0 };
    const ox = p.at[0] * psx + v.x, oy = p.at[1] * psy + v.y;
    const r = base.rot * D2R;
    const pos = { x: base.x + ox * Math.cos(r) - oy * Math.sin(r), y: base.y + ox * Math.sin(r) + oy * Math.cos(r), rot: base.rot + v.rot };
    world[name] = pos;
    return pos;
  };
  for (const n of rig.order) solve(n);
  return world;
}

/** World point of an IK target: [x,y] (frame px of the drawn view) | {part, at?:[dx,dy]} (in that part's rotated frame). */
function targetPoint(rig, t, W) {
  if (Array.isArray(t)) {
    const p = [Number(t[0]), Number(t[1])];
    if (t.length !== 2 || !p.every(Number.isFinite)) throw new Error(`ik target [x,y] needs two numbers (got ${JSON.stringify(t)})`);
    return p;
  }
  if (t?.mix) {
    const a = targetPoint(rig, t.mix[0], W), b = targetPoint(rig, t.mix[1], W), u = Number(t.mix[2]);
    return [lerp(a[0], b[0], u), lerp(a[1], b[1], u)];
  }
  if (t?.part) {
    const P = W[t.part];
    if (!P) throw new Error(`ik target: unknown part "${t.part}"`);
    const [dx, dy] = (t.at || [0, 0]).map(Number), r = P.rot * D2R;
    return [P.x + dx * Math.cos(r) - dy * Math.sin(r), P.y + dx * Math.sin(r) + dy * Math.cos(r)];
  }
  throw new Error('ik target must be [x,y] (frame px) or {part, at?:[dx,dy]}');
}

/** The two-bone chain (end, parent, grandparent) of an IK end part, or throws. */
export function ikChain(rig, end) {
  const B = rig.parts[end]?.parent, A = B && rig.parts[B].parent;
  if (!rig.parts[end]) throw new Error(`ik: unknown part "${end}"`);
  if (!A) throw new Error(`ik: "${end}" needs a parent and a grandparent part (e.g. hand_f -> forearm_f -> upper_arm_f)`);
  return [A, B, end];
}

/**
 * Two-bone IK after FK: rotate grandparent A and parent B so the end part's pivot reaches the
 * target (clamped to reach). bend 1 = the joint points toward +x when the limb hangs down
 * (knees in a right-facing side view), -1 = toward -x (elbows). plane:"depth" (front/back views
 * with scale_children) bends toward the viewer instead: aims A and foreshortens both bones.
 * rot = world rotation for the end part afterwards (keep a weapon level). weight blends with FK.
 */
function applyIK(rig, VP, src) {
  if (!VP.ik) return VP;
  const set = (n, k, val) => { VP[n] = { ...(VP[n] || {}), [k]: val }; };
  for (const [end, e] of Object.entries(VP.ik)) {
    if (!e) continue;
    const w = clamp(Number(e.weight ?? 1), 0, 1);
    if (!(w > 0)) continue;
    const [A, B] = ikChain(rig, end);
    let W = worldOf(rig, VP, src);
    const T = targetPoint(rig, e.target, W);
    const pa = W[A], pb = W[B], pe = W[end];
    if (e.plane === 'depth' && rig.scaleChildren) {
      const D = Math.hypot(pe.x - pa.x, pe.y - pa.y), d = Math.hypot(T[0] - pa.x, T[1] - pa.y);
      if (D > 1e-6) {
        const sa = poseOf(rig, VP, A).sy, sb = poseOf(rig, VP, B).sy;
        // shorten both bones uniformly; lengthen each foreshortened bone toward its full length
        // (sy 1), so one bone already at full length does not lock the other
        let fa, fb;
        if (d <= D) fa = fb = Math.max(d / D, 0.25);
        else {
          const la = Math.hypot(pb.x - pa.x, pb.y - pa.y), lb = Math.hypot(pe.x - pb.x, pe.y - pb.y);
          const ra = sa < 1 ? la * (1 / Math.max(sa, 1e-6) - 1) : 0, rb = sb < 1 ? lb * (1 / Math.max(sb, 1e-6) - 1) : 0;
          const k = ra + rb > 1e-9 ? Math.min(1, (d - D) / (ra + rb)) : 0;
          fa = la > 1e-6 ? 1 + (k * ra) / la : 1;
          fb = lb > 1e-6 ? 1 + (k * rb) / lb : 1;
        }
        set(A, 'sy', sa * lerp(1, fa, w));
        set(B, 'sy', sb * lerp(1, fb, w));
        W = worldOf(rig, VP, src);
        const q = W[end], aim = adiff(Math.atan2(q.y - pa.y, q.x - pa.x) / D2R, Math.atan2(T[1] - pa.y, T[0] - pa.x) / D2R);
        set(A, 'rot', poseOf(rig, VP, A).rot + w * aim);
      }
    } else {
      const L1 = Math.hypot(pb.x - pa.x, pb.y - pa.y), L2 = Math.hypot(pe.x - pb.x, pe.y - pb.y);
      if (L1 > 1e-6 && L2 > 1e-6) {
        const tx = T[0] - pa.x, ty = T[1] - pa.y;
        const d = clamp(Math.hypot(tx, ty), Math.abs(L1 - L2) + 1e-6, L1 + L2 - 1e-6);
        const bend = Number(e.bend ?? 1) < 0 ? -1 : 1;
        const thT = Math.atan2(ty, tx);
        const alpha = Math.acos(clamp((L1 * L1 + d * d - L2 * L2) / (2 * L1 * d), -1, 1));
        const dir1 = thT - bend * alpha;
        const jx = pa.x + L1 * Math.cos(dir1), jy = pa.y + L1 * Math.sin(dir1);
        const dir2 = Math.atan2(T[1] - jy, T[0] - jx);
        const c1 = Math.atan2(pb.y - pa.y, pb.x - pa.x), c2 = Math.atan2(pe.y - pb.y, pe.x - pb.x);
        const d1 = adiff(c1 / D2R, dir1 / D2R), d2 = adiff((c2 / D2R) + d1, dir2 / D2R);
        set(A, 'rot', poseOf(rig, VP, A).rot + w * d1);
        set(B, 'rot', poseOf(rig, VP, B).rot + w * d2);
      }
    }
    if (e.rot !== undefined && e.rot !== null) {
      W = worldOf(rig, VP, src);
      const rw = clamp(Number(e.rot_weight ?? 1), 0, 1) * w;
      set(end, 'rot', poseOf(rig, VP, end).rot + rw * adiff(W[end].rot, Number(e.rot)));
    }
  }
  return VP;
}

/**
 * A pose ready for one view: resolves mirror views to their drawn source, merges per-view
 * overrides, then solves IK after FK. Returns {src, flip, VP (flat solved pose), world}.
 */
export function solvePose(rig, pose, view) {
  let src = view, flip = false;
  if (rig.mirror[view]) { src = rig.mirror[view]; flip = true; }
  if (!rig.views.includes(src)) throw new Error(`unknown view "${view}" (views: ${[...rig.views, ...Object.keys(rig.mirror)].join(', ')})`);
  const P = typeof pose === 'string' ? resolvePose(rig, { pose }) : pose || {};
  const VP = applyIK(rig, viewPose(rig, P, src), src);
  return { src, flip, VP, world: worldOf(rig, VP, src) };
}

/**
 * Per-part anchor points for one pose in a view: the pivot's frame position (pixel-snapped) and
 * world rotation, mirrored for mirror views. Game engines attach gear/effects to these.
 */
export function poseAnchors(rig, pose, view) {
  const { flip, world } = solvePose(rig, pose, view);
  const out = {};
  for (const name of rig.order) {
    const T = world[name];
    const x = Math.round(T.x), y = Math.round(T.y), rot = Math.round(((((T.rot % 360) + 540) % 360) - 180) * 10) / 10;
    out[name] = flip ? [2 * rig.root[0] - 1 - x, y, -rot] : [x, y, rot];
  }
  return out;
}

const SUB = [1 / 6, 0.5, 5 / 6]; // 3x3 supersampling offsets inside a destination pixel

/**
 * Supersampled rotation of one part into a bbox buffer: 3x3 samples per destination pixel
 * (in the 8x Scale2x image for "rotsprite", the 1x cell for "smooth"); a pixel is painted when
 * at least 5 of 9 samples hit the part (stable limb thickness), with the most frequent sampled
 * colour (only colours the part already has). Then a cleanup pass fills 1px holes and drops
 * stray single pixels.
 */
function sampleRotated(img, p, k, px, py, cos, sin, sx, sy, x0, y0, bw, bh) {
  const src = k === 8 ? img.big32 : img.block32, SW = p.w * k, SH = p.h * k;
  const buf = new Uint32Array(bw * bh);
  const cols = new Uint32Array(9), cnt = new Uint8Array(9);
  let painted = 0;
  for (let j = 0; j < bh; j++) for (let i = 0; i < bw; i++) {
    let hits = 0, nc = 0;
    for (const oy of SUB) for (const ox of SUB) {
      const dx = x0 + i + ox - px, dy = y0 + j + oy - py;
      const u = Math.floor(((dx * cos - dy * sin) / sx + p.pivot[0]) * k), v = Math.floor(((dx * sin + dy * cos) / sy + p.pivot[1]) * k);
      if (u < 0 || v < 0 || u >= SW || v >= SH) continue;
      const c = src[v * SW + u];
      if (!(c >>> 24)) continue;
      hits++;
      let m = 0;
      while (m < nc && cols[m] !== c) m++;
      if (m === nc) { cols[nc] = c; cnt[nc++] = 0; }
      cnt[m]++;
    }
    if (hits < 5) continue;
    let best = 0;
    for (let m = 1; m < nc; m++) if (cnt[m] > cnt[best]) best = m;
    buf[j * bw + i] = cols[best];
    painted++;
  }
  if (painted > 4) {
    const at = (i, j) => (i < 0 || j < 0 || i >= bw || j >= bh ? 0 : buf[j * bw + i]);
    const fix = buf.slice();
    for (let j = 0; j < bh; j++) for (let i = 0; i < bw; i++) {
      const c = buf[j * bw + i];
      if (!c) {
        const n4 = [at(i - 1, j), at(i + 1, j), at(i, j - 1), at(i, j + 1)];
        if (n4.every((q) => q)) { // pinhole: fill with the most common neighbour colour
          let best = n4[0], bc = 0;
          for (const q of n4) { const cc = n4.filter((z) => z === q).length; if (cc > bc) { bc = cc; best = q; } }
          fix[j * bw + i] = best;
        }
      } else {
        let any = false;
        for (let b = -1; b <= 1 && !any; b++) for (let a = -1; a <= 1; a++) if ((a || b) && at(i + a, j + b)) { any = true; break; }
        if (!any) fix[j * bw + i] = 0; // stray single pixel
      }
    }
    return fix;
  }
  return buf;
}

/**
 * Render one pose in a view to an RGBA frame. Mirror views render their source view and flip
 * around the root x. Parts are snapped to whole pixels; rotation sampling follows rig.sampling.
 */
export function renderPose(rig, partsDoc, pose, view, cache = new Map(), opts = {}) {
  const [FW, FH] = rig.frame;
  const { src, flip, VP, world } = solvePose(rig, pose, view);
  const out = new Uint8ClampedArray(FW * FH * 4);
  const out32 = new Uint32Array(out.buffer);
  const list = rig.order.map((name, i) => ({ name, i, p: partIn(rig, name, src), v: poseOf(rig, VP, name) }))
    .filter((e) => !e.p.hidden && !e.v.hide && (!opts.only || opts.only.includes(e.name)) && !(opts.hide && opts.hide.includes(e.name)))
    .sort((a, b) => a.p.z - b.p.z || a.i - b.i);
  for (const { name, p, v } of list) {
    const T = world[name];
    // a pose may name a variant the part no longer has (removed in an override): draw the base cell
    const variant = v.variant && p.variants.includes(v.variant) ? v.variant : 'base';
    const img = partImage(cache, partsDoc, rig, name, src, variant);
    const px = Math.round(T.x), py = Math.round(T.y); // pixel-snapped pivot position
    const rot = ((T.rot % 360) + 360) % 360;
    const rad = (-rot * Math.PI) / 180, cos = Math.cos(rad), sin = Math.sin(rad);
    const sx = Math.max(0.05, v.sx), sy = Math.max(0.05, v.sy); // squash & stretch around the pivot
    const exact = (Math.abs(rot) < 1e-6 || Math.abs(rot - 360) < 1e-6) && Math.abs(sx - 1) < 1e-6 && Math.abs(sy - 1) < 1e-6;
    if (!exact && rig.sampling !== 'nearest8') {
      // forward-transform the cell corners for a tight bbox
      const fc = Math.cos(rot * D2R), fs = Math.sin(rot * D2R);
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const [cx, cy] of [[0, 0], [p.w, 0], [0, p.h], [p.w, p.h]]) {
        const lx = (cx - p.pivot[0]) * sx, ly = (cy - p.pivot[1]) * sy;
        const X = px + lx * fc - ly * fs, Y = py + lx * fs + ly * fc;
        x0 = Math.min(x0, X); y0 = Math.min(y0, Y); x1 = Math.max(x1, X); y1 = Math.max(y1, Y);
      }
      const bx = Math.floor(x0) - 1, by = Math.floor(y0) - 1, bw = Math.ceil(x1) - bx + 2, bh = Math.ceil(y1) - by + 2;
      const buf = sampleRotated(img, p, rig.sampling === 'rotsprite' ? 8 : 1, px, py, cos, sin, sx, sy, bx, by, bw, bh);
      for (let j = 0; j < bh; j++) {
        const y = by + j;
        if (y < 0 || y >= FH) continue;
        for (let i = 0; i < bw; i++) {
          const x = bx + i, c = buf[j * bw + i];
          if (c && x >= 0 && x < FW) out32[y * FW + x] = c;
        }
      }
      continue;
    }
    const R = Math.ceil(Math.hypot(p.w, p.h) * Math.max(1, sx, sy)) + 1;
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
        // nearest8: inverse-rotate the destination pixel centre into the part's 8x space
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

/** Set fields of a part inside pose.views[view] (creating the override). */
function setInView(P, view, part, fields) {
  P.views = P.views || {};
  P.views[view] = P.views[view] || {};
  P.views[view][part] = { ...(P.views[view][part] || {}), ...fields };
}

/**
 * Foot planting (ik_feet / plant): per foot, frames whose FK ankle is within tol px of the rest
 * ground are contact frames; in each contact run the ankle is pinned to the ground row and its x
 * moves linearly from the run's first to last frame (a standing foot stays put, a walking stance
 * foot slides back at constant treadmill speed instead of skating), solved by two-bone IK.
 */
export function plantFeet(rig, poses, view, feet = rig.feet, { loop = true, tol } = {}) {
  const src = rig.mirror[view] || view;
  const out = poses.map((p) => structuredClone(p));
  const tl = tol ?? Math.max(1.5, rig.frame[1] * 0.02);
  const plane = /^(front|back)$/.test(src) && rig.scaleChildren ? 'depth' : 'screen';
  const rest = solvePose(rig, {}, view).world;
  const n = out.length;
  for (const foot of feet) {
    ikChain(rig, foot);
    const g = rest[foot].y;
    const pos = out.map((P) => solvePose(rig, P, view).world[foot]);
    const contact = pos.map((p) => p.y >= g - tl);
    if (!contact.some(Boolean)) continue;
    const targets = new Array(n).fill(null);
    if (contact.every(Boolean)) for (let f = 0; f < n; f++) targets[f] = [pos[0].x, g];
    else {
      const start = loop ? contact.indexOf(false) : 0;
      let f = 0;
      while (f < n) {
        if (!contact[(start + f) % n]) { f++; continue; }
        let m = 0;
        while (f + m < n && contact[(start + f + m) % n]) m++;
        const i0 = (start + f) % n, i1 = (start + f + m - 1) % n;
        for (let j = 0; j < m; j++) targets[(start + f + j) % n] = [lerp(pos[i0].x, pos[i1].x, m > 1 ? j / (m - 1) : 0), g];
        f += m;
      }
    }
    for (let f = 0; f < n; f++) {
      if (!targets[f]) continue;
      const P = out[f];
      P.views = P.views || {};
      P.views[src] = P.views[src] || {};
      P.views[src].ik = { ...(P.views[src].ik || {}), [foot]: { target: targets[f], bend: 1, plane } };
    }
  }
  return out;
}

/**
 * Secondary motion: each configured part follows its FK rotation through a damped angular
 * spring driven by its pivot's acceleration (inertia) and optional gravity, so capes, scarves,
 * straps and pouches lag and follow through. Loops are simulated until the state at the loop
 * seam repeats (at least twice), so frame 0 continues frame n-1 seamlessly.
 */
export function simulateSecondary(rig, poses, view, { loop = true, config } = {}) {
  const cfg = config || rig.secondary;
  const depth = (n) => { let d = 0; for (let k = rig.parts[n].parent; k; k = rig.parts[k].parent) d++; return d; };
  const names = rig.order.filter((n) => cfg[n]).sort((a, b) => depth(a) - depth(b));
  const out = poses.map((p) => structuredClone(p));
  const n = out.length;
  if (!names.length || n < 2) return out;
  const src = rig.mirror[view] || view;
  for (const name of names) {
    const c = cfg[name];
    if (c.stiffness >= 1) continue;
    const fr = out.map((P) => { const s = solvePose(rig, P, view); return { ...s.world[name], local: poseOf(rig, s.VP, name).rot }; });
    const p = partIn(rig, name, src);
    const cx = p.w / 2 - p.pivot[0], cy = p.h / 2 - p.pivot[1], L2 = Math.max(1, cx * cx + cy * cy);
    const k = 0.04 + 0.8 * c.stiffness, damp = Math.max(0.05, c.damping);
    const idx = (i) => (loop ? ((i % n) + n) % n : clamp(i, 0, n - 1));
    let th = fr[0].rot, om = 0;
    const res = new Array(n);
    const passes = loop ? 12 : 1;
    let prev = null;
    for (let pass = 0; pass < passes; pass++) {
      for (let f = 0; f < n; f++) {
        const p0 = fr[f], p1 = fr[idx(f - 1)], p2 = fr[idx(f - 2)];
        let ax = 0, ay = 0;
        if (loop || f >= 2) { ax = p0.x - 2 * p1.x + p2.x; ay = p0.y - 2 * p1.y + p2.y; }
        const r = th * D2R, rx = cx * Math.cos(r) - cy * Math.sin(r), ry = cx * Math.sin(r) + cy * Math.cos(r);
        const Fx = -ax * c.inertia, Fy = -ay * c.inertia + c.gravity;
        const tau = ((rx * Fy - ry * Fx) / L2) / D2R;
        om = om * (1 - damp) + k * adiff(th, p0.rot) + tau;
        th += om;
        const lag = adiff(p0.rot, th);
        if (Math.abs(lag) > 80) th = p0.rot + Math.sign(lag) * 80;
        res[f] = th;
      }
      if (loop && pass >= 1 && prev && Math.abs(adiff(prev[0], th)) < 0.02 && Math.abs(prev[1] - om) < 0.02) break;
      prev = [th, om];
    }
    for (let f = 0; f < n; f++) setInView(out[f], src, name, { rot: fr[f].local + adiff(fr[f].rot, res[f]) });
  }
  return out;
}
