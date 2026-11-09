// Rigs: consistent multi-view, multi-animation assets.
// A rig has parts (drawn once per view on a "parts" canvas), joints (pivot + parent + rest
// offset), and poses (per-part offset/rotation/variant, optional per-view overrides and two-bone
// IK). Frames are generated from the same part pixels, so a character cannot drift between
// frames, animations or directions, and in-betweens can be tweened at any frame rate.
// Per frame: view overrides -> FK -> IK -> render (rotation sampled per rig "sampling" mode).
import { upscale } from './pixelops.js';
import { normalizeWeapon, solveHeld, lerpCarry, heldParts } from './weapon.js';
import { normalizeDepth, applyDepth } from './depth.js';
import { normalizeSkin, skinView, drawSkin } from './skin2d.js';
import { normalizeConstraints, applyConstraints, solveCCD, ccdChain } from './chain2d.js';

const NAME = /^[\w-]+$/;
const GAP = 1;
const RESERVED = new Set(['views', 'ik', 'shapes', 'targets']);
export const SAMPLING = ['nearest8', 'rotsprite', 'smooth'];
const D2R = Math.PI / 180;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;
/** Shortest signed angle difference b - a in degrees [-180..180]; exactly -180 stays -180 (the 0.3 tween direction). */
const adiff = (a, b) => { let d = (b - a) % 360; if (d > 180) d -= 360; if (d < -180) d += 360; return d; };

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
    // art:"<part>" = draw another part's cell (a magazine in the hand, a prop handed over): no own cell
    const share = p.art !== undefined ? def.parts[p.art] : null;
    if (p.art !== undefined) {
      if (!share || p.art === name) throw new Error(`part "${name}": art "${p.art}" must name another part`);
      if (share.art !== undefined) throw new Error(`part "${name}": art "${p.art}" draws another part's cell itself; point at the part that owns the cell`);
    }
    const w = Number(p.w ?? share?.w), h = Number(p.h ?? share?.h);
    if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1) throw new Error(`part "${name}" needs integer w,h`);
    const pivot = p.pivot ?? share?.pivot ?? [Math.floor(w / 2), Math.floor(h / 2)];
    parts[name] = {
      w, h, pivot: [Number(pivot[0]), Number(pivot[1])], parent: p.parent ?? null, at: p.at ? [Number(p.at[0]), Number(p.at[1])] : [0, 0],
      z: Number(p.z ?? 0), variants: ['base', ...((share ? share.variants : p.variants) || []).filter((v) => v !== 'base')], views: { ...(p.views || {}) },
    };
    if (share) { parts[name].art = p.art; parts[name].w = Number(share.w); parts[name].h = Number(share.h); }
    if (p.hide) parts[name].hide = true;
    // bone:true = a bone without a drawing (a skinned sprite's elbow, a cable segment): never drawn
    if (p.bone) parts[name].bone = true;
    // link:{<view>: "<drawn view>" | {view, flip?}} = this view draws the cell of another view
    for (const [v, l] of Object.entries(p.link || {})) parts[name].views[v] = { ...(parts[name].views[v] || {}), link: l };
  }
  for (const name of order) {
    const par = parts[name].parent;
    if (par && !parts[par]) throw new Error(`part "${name}" has unknown parent "${par}"`);
    // cycle check
    let k = par, guard = 0;
    while (k) { if (k === name || guard++ > 64) throw new Error(`parent cycle at part "${name}"`); k = parts[k].parent; }
    for (const [v, o] of Object.entries(parts[name].views)) {
      if (!views.includes(v)) throw new Error(`part "${name}" has settings for unknown view "${v}"`);
      if (o?.link !== undefined) {
        const lv = typeof o.link === 'string' ? o.link : o.link?.view;
        if (!views.includes(lv) || lv === v) throw new Error(`part "${name}": link for view "${v}" must name another drawn view (${views.filter((x) => x !== v).join(', ')})`);
      }
    }
  }
  const roots = order.filter((n) => !parts[n].parent);
  // layout: one column per (part, variant), one row band per view; art-sharing parts have none
  const columns = [];
  let x = 0;
  for (const name of order) for (const variant of parts[name].variants) {
    if (parts[name].art) continue;
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
  const rig = {
    frame, views, mirror, parts, order, roots, pairs,
    root: def.root ? [Number(def.root[0]), Number(def.root[1])] : [Math.floor(frame[0] / 2), Math.floor(frame[1] * 0.75)],
    poses: def.poses || {}, layout: { columns, rowH, width, height },
    sampling, secondary, feet, scaleChildren: !!def.scale_children,
  };
  if (def.variant_sets) rig.variantSets = normalizeVariantSets(parts, def.variant_sets);
  // weapon handling (opt-in): the weapon part is placed by the solver, hands lock onto its grips
  if (def.weapon) {
    if (parts.carry) throw new Error('"carry" is reserved in poses of a rig with a weapon; rename that part');
    rig.weapon = normalizeWeapon(rig, def.weapon);
  }
  // depth model (opt-in): per-frame draw order from a 3D proxy, z rules, split parts
  if (def.depth) rig.depth = normalizeDepth(rig, def.depth);
  // 2D skinning (opt-in): drawn sprites bound to the bones as deforming meshes
  if (def.skin && Object.keys(def.skin).length) rig.skin = normalizeSkin(rig, def.skin);
  // constraints / joint limits (opt-in): aim, look_at, copy_rotation, limits (CCD respects them)
  if (def.constrain?.length || (def.limits && Object.keys(def.limits).length)) rig.constrain = normalizeConstraints(rig, def.constrain, def.limits);
  return rig;
}

/** variant_sets: {heavy: {chest:"plate", head:"helmet"}} -> validated map (set -> part -> variant). */
export function normalizeVariantSets(parts, sets) {
  if (!sets || typeof sets !== 'object' || Array.isArray(sets)) throw new Error('rig "variant_sets" must be {<set>: {<part>: <variant>}}');
  const out = {};
  for (const [s, map] of Object.entries(sets)) {
    if (!NAME.test(s)) throw new Error(`variant_sets: bad set name "${s}"`);
    if (!map || typeof map !== 'object' || Array.isArray(map)) throw new Error(`variant_sets.${s} must be {<part>: <variant>}`);
    for (const [p, v] of Object.entries(map)) {
      if (!parts[p]) throw new Error(`variant_sets.${s}: unknown part "${p}"`);
      if (!parts[p].variants.includes(v)) throw new Error(`variant_sets.${s}: part "${p}" has no variant "${v}" (variants: ${parts[p].variants.join(', ')})`);
    }
    out[s] = { ...map };
  }
  return out;
}

/**
 * The variant a part renders with under an equipment set (animate variant:"heavy"): the set's
 * mapping (variant_sets) or a variant named like the set; a pose variant v (blink) combines as
 * "<set>_<v>" when the part has it, else the pose variant wins.
 */
export function setVariant(rig, name, poseVariant, sets) {
  const p = rig.parts[name];
  for (const s of sets) {
    const want = rig.variantSets?.[s] ? rig.variantSets[s][name] : p.variants.includes(s) ? s : null;
    if (!want) continue;
    if (poseVariant && poseVariant !== 'base') return p.variants.includes(`${want}_${poseVariant}`) ? `${want}_${poseVariant}` : poseVariant;
    return want;
  }
  return poseVariant;
}

/** Cell of a part (variant) in a drawn view on the parts canvas. */
export function cellOf(rig, part, view, variant = 'base') {
  const vi = rig.views.indexOf(view);
  if (vi < 0) throw new Error(`unknown view "${view}" (drawn views: ${rig.views.join(', ')})`);
  const owner = rig.parts[part]?.art || part;
  const col = rig.layout.columns.find((c) => c.part === owner && c.variant === variant);
  if (!col) throw new Error(`part "${part}" has no variant "${variant}"`);
  const p = rig.parts[part];
  return { x: col.x, y: vi * rig.layout.rowH, w: p.w, h: p.h };
}

/** Per-view part settings (at, z, hidden, pivot) with fallbacks. */
export function partIn(rig, name, view) {
  const p = rig.parts[name], o = p.views[view] || {};
  const out = { ...p, at: o.at ? [Number(o.at[0]), Number(o.at[1])] : p.at, z: o.z ?? p.z, hidden: !!o.hidden, pivot: o.pivot ? [Number(o.pivot[0]), Number(o.pivot[1])] : p.pivot };
  if (o.link !== undefined) out.link = typeof o.link === 'string' ? { view: o.link, flip: false } : { view: o.link.view, flip: !!o.link.flip };
  return out;
}

const ease = (t, kind) => (kind === 'linear' ? t : kind === 'step' ? 0 : t * t * (3 - 2 * t));

/**
 * Pose values for a part: {x, y, rot, sx, sy, variant, hide}, plus the solver-only fields flipx
 * (mirror the cell about its pivot), cell (draw the cell of another drawn view) and z (draw order).
 */
export function poseOf(rig, pose, name) {
  const v = (typeof pose === 'string' ? rig.poses[pose] : pose)?.[name] || {};
  // a part with hide:true in the rig (a magazine in the hand) is hidden until a pose sets hide:false
  const hide = v.hide !== undefined ? !!v.hide : !!rig.parts[name]?.hide;
  return { x: Number(v.x ?? 0), y: Number(v.y ?? 0), rot: Number(v.rot ?? 0), sx: Number(v.sx ?? 1) || 1, sy: Number(v.sy ?? 1) || 1, variant: v.variant ?? null, hide, flipx: !!v.flipx, cell: v.cell ?? null, z: v.z ?? null, split: v.split ?? null };
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

/**
 * Arm chains that hold something in a pose and so keep their side under mirror_pairs: with a
 * weapon, the hands its carry state locks; otherwise every two-bone chain with an IK end that is
 * not a foot (a hand on a prop). Legs, the body and free arms still swap.
 */
function heldChains(rig, p) {
  const w = heldParts(rig, p);
  if (w) return w;
  const out = new Set();
  const feet = new Set(rig.feet || []);
  const ends = new Set([...Object.keys(p.ik || {}), ...Object.values(p.views || {}).flatMap((o) => Object.keys(o?.ik || {}))]);
  for (const e of ends) {
    if (feet.has(e) || !rig.parts[e]) continue;
    const B = rig.parts[e].parent, A = B && rig.parts[B]?.parent;
    if (A) for (const n of [e, B, A]) out.add(n);
  }
  return out;
}

/**
 * Swap paired parts (leg_f <-> leg_b) everywhere in a pose: parts, view overrides, IK ends and
 * targets. Pairs in a held arm chain keep their side (handedness) unless all is set.
 */
function swapPairs(rig, p, all = false) {
  const sw = new Map();
  const held = all ? new Set() : heldChains(rig, p);
  for (const [a, b] of rig.pairs) { if (held.has(a) || held.has(b)) continue; sw.set(a, b); sw.set(b, a); }
  const parts = (o) => {
    const r = {};
    for (const [k, v] of Object.entries(o)) if (!RESERVED.has(k) && v !== undefined) r[sw.get(k) ?? k] = v;
    if (o.ik) r.ik = Object.fromEntries(Object.entries(o.ik).map(([k, e]) => [sw.get(k) ?? k, e && { ...e, target: swapTarget(sw, e.target) }]));
    return r;
  };
  const out = parts(p);
  if (p.shapes) out.shapes = p.shapes;
  if (p.targets) out.targets = p.targets;
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
  // deform shape weights {shape: 0..1} and named constraint targets {name: [x,y] | {part, at}}
  if (key.shapes) p.shapes = { ...(p.shapes || {}), ...structuredClone(key.shapes) };
  if (key.targets) p.targets = { ...(p.targets || {}), ...structuredClone(key.targets) };
  // z keyframes: key.z = {part: z} (draw order for this key; steps at the tween midpoint)
  if (key.z) for (const [n, z] of Object.entries(key.z)) {
    if (!rig.parts[n]) throw new Error(`key z: unknown part "${n}"`);
    p[n] = { ...(p[n] || {}), z: z === null ? null : Number(z) };
  }
  if (rig.weapon) {
    // carry state: key > pose > weapon.poses mapping (by pose name) > weapon default
    if (key.carry !== undefined) p.carry = key.carry;
    else if (p.carry === undefined && key.pose !== undefined && rig.weapon.poses[key.pose] !== undefined) p.carry = rig.weapon.poses[key.pose];
  }
  // mirror_pairs keeps held hands on their side; mirror_hands also swaps them (handedness)
  if (key.mirror_pairs || key.mirror_hands) p = swapPairs(rig, p, !!key.mirror_hands);
  if (key.mirror_hands && rig.weapon) p.hands_mirrored = !p.hands_mirrored;
  return p;
}

function lerpParts(rig, a, b, t) {
  const out = {};
  for (const name of rig.order) {
    const pa = poseOf(rig, a, name), pb = poseOf(rig, b, name);
    out[name] = { x: lerp(pa.x, pb.x, t), y: lerp(pa.y, pb.y, t), rot: pa.rot + adiff(pa.rot, pb.rot) * t, sx: lerp(pa.sx, pb.sx, t), sy: lerp(pa.sy, pb.sy, t), variant: t < 0.5 ? pa.variant : pb.variant, hide: t < 0.5 ? pa.hide : pb.hide };
    // z keyframes step at the midpoint (like variants): no in-between order that could flicker
    if (pa.z !== null || pb.z !== null) { const z = t < 0.5 ? pa.z : pb.z; if (z !== null) out[name].z = z; }
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
      if (ea.chain !== undefined || eb.chain !== undefined) r.chain = ea.chain ?? eb.chain;
      if (ea.rot !== undefined && eb.rot !== undefined) { r.rot = ea.rot + adiff(ea.rot, eb.rot) * t; r.rot_weight = lerp(rw(ea), rw(eb), t); }
      else if (ea.rot !== undefined) { r.rot = ea.rot; r.rot_weight = rw(ea) * (1 - t); }
      else if (eb.rot !== undefined) { r.rot = eb.rot; r.rot_weight = rw(eb) * t; }
      out[end] = r;
    } else if (ea) out[end] = { ...ea, weight: w(ea) * (1 - t) };
    else out[end] = { ...eb, weight: w(eb) * t };
  }
  return out;
}

/** Blend shape weights (a shape missing on one side is 0 there). */
function lerpShapes(A, B, t) {
  const out = {};
  for (const k of new Set([...Object.keys(A || {}), ...Object.keys(B || {})])) out[k] = lerp(Number(A?.[k] ?? 0), Number(B?.[k] ?? 0), t);
  return out;
}

/** Blend named constraint targets (one side only: held). */
function lerpTargets(A, B, t) {
  const out = {};
  for (const k of new Set([...Object.keys(A || {}), ...Object.keys(B || {})])) out[k] = A?.[k] === undefined ? B[k] : B?.[k] === undefined ? A[k] : lerpTarget(A[k], B[k], t);
  return out;
}

/** Blend two poses at t (0..1) per part, per view override and per IK end. Variants/hide switch at the midpoint. */
export function lerpPose(rig, a, b, t) {
  const A = asPose(rig, a), B = asPose(rig, b);
  const out = lerpParts(rig, A, B, t);
  const ik = lerpIK(A.ik, B.ik, t);
  if (ik) out.ik = ik;
  if (A.shapes || B.shapes) out.shapes = lerpShapes(A.shapes, B.shapes, t);
  if (A.targets || B.targets) out.targets = lerpTargets(A.targets, B.targets, t);
  if (rig.weapon) {
    const c = lerpCarry(A.carry, B.carry, t);
    if (c !== undefined) out.carry = c;
    if (t < 0.5 ? A.hands_mirrored : B.hands_mirrored) out.hands_mirrored = true;
  }
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
function partImage(cache, partsDoc, rig, name, view, variant, rows = null) {
  const key = `${rig.parts[name]?.art || name}|${view}|${variant}|${partsDoc.version ?? 0}${rows ? `|${rows[0]}-${rows[1]}` : ''}`;
  if (cache.has(key)) return cache.get(key);
  const c = cellOf(rig, name, view, variant);
  // art layers only: the "cells" guide layer must never leak into frames
  const comp = compositeArt(partsDoc, cache);
  const W = partsDoc.width;
  const block = new Uint8ClampedArray(c.w * c.h * 4);
  // rows [a, b): one piece of a split part (cell rows from the pivot end to the cut, or after it)
  for (let y = 0; y < c.h; y++) if (!rows || (y >= rows[0] && y < rows[1])) block.set(comp.subarray(((c.y + y) * W + c.x) * 4, ((c.y + y) * W + c.x + c.w) * 4), y * c.w * 4);
  const big = upscale(block, c.w, c.h, 8).data;
  const img = { w: c.w, h: c.h, block, big, block32: new Uint32Array(block.buffer, block.byteOffset, c.w * c.h), big32: new Uint32Array(big.buffer, big.byteOffset, c.w * c.h * 64) };
  cache.set(key, img);
  return img;
}

/**
 * World transforms (pivot position + rotation) of every part in a drawn view, parent-first. A
 * part posed with flipx (and everything under it) is mirrored about its pivot: flip:true.
 */
export function worldOf(rig, VP, src) {
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
    let ox = p.at[0] * psx + v.x;
    const oy = p.at[1] * psy + v.y;
    if (base.flip) ox = -ox;
    const r = base.rot * D2R;
    const pos = { x: base.x + ox * Math.cos(r) - oy * Math.sin(r), y: base.y + ox * Math.sin(r) + oy * Math.cos(r), rot: base.rot + (base.flip ? -v.rot : v.rot) };
    if (!!base.flip !== v.flipx) pos.flip = true;
    world[name] = pos;
    return pos;
  };
  for (const n of rig.order) solve(n);
  return world;
}

/** World point of an IK target: [x,y] (frame px of the drawn view) | {part, at?:[dx,dy]} (in that part's rotated frame). */
export function targetPoint(rig, t, W) {
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
export function applyIK(rig, VP, src) {
  if (!VP.ik) return VP;
  const set = (n, k, val) => { VP[n] = { ...(VP[n] || {}), [k]: val }; };
  for (const [end, e] of Object.entries(VP.ik)) {
    if (!e) continue;
    const w = clamp(Number(e.weight ?? 1), 0, 1);
    if (!(w > 0)) continue;
    // chain > 2: CCD over that many ancestors (tails, cables, straps); joint limits respected
    if (Number(e.chain) > 2) { solveCCD(rig, VP, src, end, e); if (e.rot !== undefined && e.rot !== null) { const W2 = worldOf(rig, VP, src); set(end, 'rot', poseOf(rig, VP, end).rot + clamp(Number(e.rot_weight ?? 1), 0, 1) * w * adiff(W2[end].rot, Number(e.rot))); } continue; }
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
  const r = solveCore(rig, pose, view);
  // depth model: per-frame z from the 3D proxy (z rules, split parts); clips pass their decisions
  // (with hysteresis) in pose._depth, a single pose is decided on its own
  if (rig.depth) applyDepth(rig, r.P, r);
  return r;
}

/** FK + IK (+ weapon handling) of a pose in a view, without the depth pass. */
export function solveCore(rig, pose, view) {
  let src = view, flip = false;
  if (rig.mirror[view]) { src = rig.mirror[view]; flip = true; }
  if (!rig.views.includes(src)) throw new Error(`unknown view "${view}" (views: ${[...rig.views, ...Object.keys(rig.mirror)].join(', ')})`);
  const P = typeof pose === 'string' ? resolvePose(rig, { pose }) : pose || {};
  if (rig.weapon) {
    // weapon handling: weapon placement, locked hands, cheek weld, then the remaining pose IK
    const h = solveHeld(rig, P, src);
    if (rig.constrain) applyConstraints(rig, h.VP, src, P);
    return { src, flip, VP: h.VP, world: worldOf(rig, h.VP, src), weapon: h.report, P };
  }
  const VP = applyIK(rig, viewPose(rig, P, src), src);
  if (rig.constrain) applyConstraints(rig, VP, src, P);
  return { src, flip, VP, world: worldOf(rig, VP, src), P };
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
  const [RW, RH] = rig.frame;
  // pad:[left, top, right, bottom] = a bigger frame around the rig frame (the root moves by left/top);
  // a mirror view renders its source with left/right swapped, so the padding lands on the right side
  const pad = opts.pad ? opts.pad.map((n) => Math.max(0, Math.round(Number(n) || 0))) : null;
  const FW = RW + (pad ? pad[0] + pad[2] : 0), FH = RH + (pad ? pad[1] + pad[3] : 0);
  const { src, flip: flip0, VP, world, P } = solvePose(rig, pose, view);
  // opts.mirror: draw the view mirrored about the root column (a paired partner staged in depth)
  const flip = !!flip0 !== !!opts.mirror;
  const ox = pad ? (flip ? pad[2] : pad[0]) : 0, oy = pad ? pad[1] : 0;
  // skinned meshes replace their host part (+ absorbed parts) in the views they are drawn in
  const skin = rig.skin ? skinView(rig, partsDoc, src, cache) : null;
  const out = new Uint8ClampedArray(FW * FH * 4);
  const out32 = new Uint32Array(out.buffer);
  const sets = opts.variant ? [].concat(opts.variant) : null;
  const sampling = opts.sampling ?? rig.sampling;
  const entries = [];
  rig.order.forEach((name, i) => {
    const p = partIn(rig, name, src), v = poseOf(rig, VP, name);
    if (p.hidden || v.hide || (opts.only && !opts.only.includes(name)) || (opts.hide && opts.hide.includes(name))) return;
    const z = v.z ?? p.z;
    if (p.bone) return;
    if (skin && skin.replaced.has(name)) {
      // a mesh without its own z draws at the highest z of its host and absorbed parts this frame,
      // so a hand it absorbs keeps the z a pose / weapon lock gives it (over the weapon)
      const zOf = (n) => { if (!rig.parts[n]) return -Infinity; const q = partIn(rig, n, src), w = poseOf(rig, VP, n); return q.hidden || w.hide ? -Infinity : Number(w.z ?? q.z); };
      for (const b of skin.meshes) if (b.host === name) entries.push({ name, i, p, v, z: b.z ?? Math.max(z, ...b.absorb.map(zOf)), rows: null, skin: b });
      return;
    }
    // split part: the rows from the pivot to the cut and the rest get their own z (one piece in
    // front of the reference part, one behind it)
    if (v.split && v.split.cut > 0 && v.split.cut < p.h) {
      entries.push({ name, i, p, v, z: v.split.z[0], rows: [0, v.split.cut] });
      entries.push({ name, i, p, v, z: v.split.z[1], rows: [v.split.cut, p.h] });
    } else entries.push({ name, i, p, v, z, rows: null });
  });
  if (skin) skin.meshes.forEach((b, k) => { if (!b.host && (!opts.only || opts.only.includes(b.name)) && !(opts.hide && opts.hide.includes(b.name))) entries.push({ name: b.name, i: rig.order.length + k, p: null, v: null, z: b.z, rows: null, skin: b }); });
  const list = entries.sort((a, b) => a.z - b.z || a.i - b.i);
  const trace = opts.trace || null;
  if (trace) { trace.order = []; trace.frame = [FW, FH]; }
  for (const { name, p: pv, v, rows, z, skin: sb } of list) {
    if (sb) {
      const box = trace ? [Infinity, Infinity, -Infinity, -Infinity, 0] : null;
      const mark = box ? (x, y) => { if (x < box[0]) box[0] = x; if (y < box[1]) box[1] = y; if (x > box[2]) box[2] = x; if (y > box[3]) box[3] = y; box[4]++; } : null;
      drawSkin(rig, sb, VP, world, P, skin.bind, out32, FW, FH, ox, oy, { sampling: opts.sampling === 'nearest8' ? 'nearest8' : undefined, mark, layerMask: opts.skinBones || null });
      if (trace) trace.order.push({ part: name, z: Math.round(z * 1000) / 1000, skin: sb.name, box: box[4] ? box.slice(0, 4) : null, px: box[4] });
      continue;
    }
    const T = world[name];
    // cell: draw another drawn view's cell (weapons projected from their side cell; link: a view
    // that reuses another view's drawing, optionally mirrored)
    const linkTo = pv.link && rig.views.includes(pv.link.view) ? pv.link : null;
    const cellView = v.cell && v.cell !== src && rig.views.includes(v.cell) ? v.cell : linkTo ? linkTo.view : src;
    const p = cellView === src ? pv : { ...partIn(rig, name, cellView), z: pv.z };
    // equipment set (animate variant:"heavy"), then a pose variant; a variant the part no longer has draws the base cell
    const want = sets ? setVariant(rig, name, v.variant, sets) : v.variant;
    const variant = want && p.variants.includes(want) ? want : 'base';
    const img = partImage(cache, partsDoc, rig, name, cellView, variant, rows);
    const px = Math.round(T.x) + ox, py = Math.round(T.y) + oy; // pixel-snapped pivot position
    // stable rotation: a drawing angle fixed by the caller (quantized with hysteresis across frames)
    const wrot = opts.rot && opts.rot[name] !== undefined ? opts.rot[name] : T.rot;
    const rot = ((wrot % 360) + 360) % 360;
    const rad = (-rot * Math.PI) / 180, cos = Math.cos(rad), sin = Math.sin(rad);
    // squash & stretch around the pivot; a flipped part (weapon facing left) mirrors its cell
    const mir = !!T.flip !== !!(linkTo && linkTo.flip && cellView === linkTo.view);
    const sx = (mir ? -1 : 1) * Math.max(0.05, v.sx), sy = Math.max(0.05, v.sy);
    const exact = !mir && (Math.abs(rot) < 1e-6 || Math.abs(rot - 360) < 1e-6) && Math.abs(sx - 1) < 1e-6 && Math.abs(sy - 1) < 1e-6;
    const box = trace ? [Infinity, Infinity, -Infinity, -Infinity, 0] : null;
    const mark = box ? (x, y) => { if (x < box[0]) box[0] = x; if (y < box[1]) box[1] = y; if (x > box[2]) box[2] = x; if (y > box[3]) box[3] = y; box[4]++; } : null;
    if (!exact && sampling !== 'nearest8') {
      // forward-transform the cell corners for a tight bbox
      const fc = Math.cos(rot * D2R), fs = Math.sin(rot * D2R);
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const [cx, cy] of [[0, 0], [p.w, 0], [0, p.h], [p.w, p.h]]) {
        const lx = (cx - p.pivot[0]) * sx, ly = (cy - p.pivot[1]) * sy;
        const X = px + lx * fc - ly * fs, Y = py + lx * fs + ly * fc;
        x0 = Math.min(x0, X); y0 = Math.min(y0, Y); x1 = Math.max(x1, X); y1 = Math.max(y1, Y);
      }
      const bx = Math.floor(x0) - 1, by = Math.floor(y0) - 1, bw = Math.ceil(x1) - bx + 2, bh = Math.ceil(y1) - by + 2;
      const buf = sampleRotated(img, p, sampling === 'rotsprite' ? 8 : 1, px, py, cos, sin, sx, sy, bx, by, bw, bh);
      for (let j = 0; j < bh; j++) {
        const y = by + j;
        if (y < 0 || y >= FH) continue;
        for (let i = 0; i < bw; i++) {
          const x = bx + i, c = buf[j * bw + i];
          if (c && x >= 0 && x < FW) { out32[y * FW + x] = c; if (mark) mark(x, y); }
        }
      }
    } else {
      const R = Math.ceil(Math.hypot(p.w, p.h) * Math.max(1, Math.abs(sx), sy)) + 1;
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
        if (mark) mark(x, y);
      }
    }
    if (trace) trace.order.push({ part: name, z: Math.round(z * 1000) / 1000, ...(rows ? { piece: rows[0] === 0 ? 'pivot' : 'tip' } : {}), box: box[4] ? box.slice(0, 4) : null, px: box[4] });
  }
  // mirror views flip about the root column (shifted by the padding on each side)
  const fx = (x) => (rig.root[0] + ox) + (rig.root[0] + (pad ? pad[0] : 0)) - 1 - x;
  if (trace && flip) for (const e of trace.order) if (e.box) e.box = [fx(e.box[2]), e.box[1], fx(e.box[0]), e.box[3]];
  if (flip) {
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

/**
 * Stable rotation for a clip: each part's drawing angle is quantized to `step` degrees and only
 * moves on when the solved angle leaves the current step by more than hold x step (hysteresis),
 * so slow limbs do not shimmer pixel by pixel and near-zero angles snap to the crisp exact blit.
 * Joint positions stay exact. -> one {part: deg} map per frame (renderPose opts.rot)
 */
export function stableRotations(rig, poses, view, { step = 3, hold = 0.75 } = {}) {
  const prev = {};
  const st = Math.max(0.5, Number(step) || 3), h = Math.min(1.5, Math.max(0.5, Number(hold) || 0.75));
  return poses.map((P) => {
    const { world } = solvePose(rig, P, view);
    const out = {};
    for (const n of rig.order) {
      const raw = world[n].rot;
      let q = Math.round(raw / st) * st;
      if (prev[n] !== undefined && Math.abs(adiff(prev[n], raw)) <= st * h) q = prev[n];
      prev[n] = q;
      out[n] = q;
    }
    return out;
  });
}

/** Events {t (0..1) | frame, name} -> [{frame, name}] for n frames (loop: t * n, else t * (n - 1)). */
export function eventFrames(events, n, loop) {
  if (!events) return [];
  if (!Array.isArray(events)) throw new Error('events must be [{t (0..1) | frame, name}]');
  return events.map((e, i) => {
    if (!e || typeof e.name !== 'string' || !e.name) throw new Error(`events[${i}] needs a name`);
    const f = e.frame !== undefined ? Math.round(Number(e.frame)) : Math.round(Number(e.t ?? 0) * (loop ? n : n - 1));
    if (!Number.isFinite(f)) throw new Error(`events[${i}] needs t (0..1) or frame`);
    return { frame: loop ? ((f % n) + n) % n : Math.min(n - 1, Math.max(0, f)), name: e.name };
  }).sort((a, b) => a.frame - b.frame);
}

/** Set fields of a part inside pose.views[view] (creating the override). */
function setInView(P, view, part, fields) {
  P.views = P.views || {};
  P.views[view] = P.views[view] || {};
  P.views[view][part] = { ...(P.views[view][part] || {}), ...fields };
}

/**
 * Lowest row of a foot as drawn (its cell box scaled by sx / sy and turned by its world rotation
 * about the pivot), in the solved view's frame px. null when the foot is hidden.
 */
export function footLow(rig, solved, foot) {
  const p = partIn(rig, foot, solved.src), v = poseOf(rig, solved.VP, foot), W = solved.world[foot];
  if (!W || p.hidden || v.hide) return null;
  const r = W.rot * D2R, c = Math.cos(r), s = Math.sin(r), fx = W.flip ? -1 : 1;
  let low = -Infinity;
  for (const x of [-p.pivot[0], p.w - 1 - p.pivot[0]]) for (const y of [-p.pivot[1], p.h - 1 - p.pivot[1]]) low = Math.max(low, W.y + fx * x * v.sx * s + y * v.sy * c);
  return low;
}

/** The ground row of a view: the lowest drawn foot row of the rest pose. */
export function groundRow(rig, view, feet = rig.feet) {
  const rest = solvePose(rig, {}, view);
  return Math.max(...(feet || []).map((f) => footLow(rig, rest, f) ?? -Infinity));
}

/**
 * Ground contact (melee clips): a foot drawn below the view's ground row is lifted onto it by
 * two-bone leg IK (front / back with scale_children: in depth, the leg foreshortens toward the
 * viewer; otherwise in the screen plane, the knee kept on its side), the foot keeping its world
 * rotation. Frames with no sinking foot are returned untouched.
 */
export function groundFeet(rig, poses, view, feet = rig.feet, { tol = 0.25 } = {}) {
  const src = rig.mirror[view] || view;
  const deep = /^(front|back)$/.test(src) && rig.scaleChildren;
  const g = groundRow(rig, view, feet);
  if (!Number.isFinite(g)) return poses;
  for (const f of feet) ikChain(rig, f);
  return poses.map((P0) => {
    let P = P0;
    for (let it = 0; it < 4; it++) {
      const s = solvePose(rig, P, view);
      const fix = [];
      for (const foot of feet) { const low = footLow(rig, s, foot); if (low !== null && low > g + tol) fix.push([foot, low - g]); }
      if (!fix.length) break;
      if (P === P0) P = structuredClone(P0);
      P.views = P.views || {};
      P.views[src] = P.views[src] || {};
      const ik = { ...(P.views[src].ik || {}) };
      for (const [foot, d] of fix) {
        const [A, B] = ikChain(rig, foot), W = s.world, a = W[A], b = W[B], e = W[foot];
        const bend = (b.x - a.x) * (e.y - a.y) - (b.y - a.y) * (e.x - a.x) >= 0 ? 1 : -1;
        ik[foot] = { ...(ik[foot] || {}), target: [e.x, e.y - d], bend, plane: deep ? 'depth' : 'screen', rot: e.rot, weight: 1, rot_weight: 1 };
      }
      P.views[src].ik = ik;
    }
    return P;
  });
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
