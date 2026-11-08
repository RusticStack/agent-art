// Animation library: skeletons (a rig definition without art, with named proportions and masks),
// clips authored once per skeleton (keys + events, override / additive layers with masks), skins
// (a drawn art_rig bound to a skeleton, with equipment and loadouts) and retargeting between
// skeletons. Everything here is pure; libops.js stores the assets and renders them.
import { normalizeRig, worldOf, animatePoses, poseOf, viewPose, lerpPose, partIn } from './rig.js';

const r3 = (v) => Math.round(v * 1000) / 1000;
const lerp = (a, b, t) => a + (b - a) * t;
const adiff = (a, b) => { let d = (b - a) % 360; if (d > 180) d -= 360; if (d < -180) d += 360; return d; };
export const LIB_NAME = /^[\w.-]{1,58}$/;

// ---------- skeletons ----------
/** Proportion groups: part-name patterns whose bone length (and cell height) a factor scales. */
export const PROP_GROUPS = {
  legs: /^(thigh|shin|leg)(_|$)/, feet: /^foot(_|$)/, arms: /^(upper_arm|forearm|arm)(_|$)/, hands: /^hand(_|$)/,
  spine: /^(pelvis|torso|chest|neck|body)$/, head: /^head$/,
};
const PROP_KEYS = [...Object.keys(PROP_GROUPS), 'width', 'scale'];

/** Validate named proportions {stocky:{legs:0.92, spine:1.05, width:1.12, ...}}. */
export function normalizeProportions(props) {
  const out = {};
  for (const [n, p] of Object.entries(props || {})) {
    if (!LIB_NAME.test(n)) throw new Error(`proportions: bad name "${n}"`);
    if (!p || typeof p !== 'object') throw new Error(`proportions.${n} must be {${PROP_KEYS.join(', ')}}: factors`);
    for (const [k, v] of Object.entries(p)) {
      if (!PROP_KEYS.includes(k)) throw new Error(`proportions.${n}.${k}: groups are ${PROP_KEYS.join(', ')}`);
      if (!(Number(v) >= 0.5 && Number(v) <= 2)) throw new Error(`proportions.${n}.${k} must be a factor 0.5..2`);
    }
    out[n] = Object.fromEntries(Object.entries(p).map(([k, v]) => [k, Number(v)]));
  }
  return out;
}

/** Parts that belong to a held weapon (not scaled with the body). */
function propParts(def) {
  const W = def.weapon ? (def.weapon.part ?? 'weapon') : null;
  const out = new Set();
  const under = (n) => { for (let k = n, g = 0; k && g < 32; k = def.parts[k]?.parent, g++) if (k === W) return true; return false; };
  for (const n of Object.keys(def.parts)) if (W && under(n)) out.add(n);
  for (const [n, p] of Object.entries(def.parts)) if (p.art && out.has(p.art)) out.add(n);
  return out;
}

/** Lowest drawn row of the rest pose in the base view (feet bottoms, else cell bottoms). */
function restLow(def) {
  const rig = normalizeRig({ ...def, weapon: undefined, depth: undefined });
  const base = rig.views.includes('side') ? 'side' : rig.views[0];
  const W = worldOf(rig, {}, base);
  const names = rig.feet?.length ? rig.feet : rig.order;
  return Math.max(...names.map((n) => { const p = partIn(rig, n, base); return W[n].y + p.h - 1 - p.pivot[1]; }));
}

/**
 * A skeleton definition with proportions applied: bone lengths (child joints along the bone and
 * cell heights) per group, widths, overall scale; the root moves so the feet stay on the ground.
 */
export function applyProportions(def, prop) {
  if (!prop || !Object.keys(prop).length) return structuredClone(def);
  const out = structuredClone(def);
  const fixed = propParts(def);
  const s = Number(prop.scale ?? 1), kw = s * Number(prop.width ?? 1);
  const kOf = (n) => { if (fixed.has(n)) return 1; for (const [g, re] of Object.entries(PROP_GROUPS)) if (re.test(n)) return s * Number(prop[g] ?? 1); return s; };
  const kwOf = (n) => (fixed.has(n) ? 1 : kw);
  for (const [n, p] of Object.entries(out.parts)) {
    const k = kOf(n), w = kwOf(n);
    if (!p.art) {
      p.h = Math.max(1, Math.round(p.h * k));
      p.w = Math.max(1, Math.round(p.w * w));
    }
    if (p.pivot) p.pivot = [Math.round(p.pivot[0] * (p.art ? 1 : w)), Math.round(p.pivot[1] * (p.art ? 1 : k))];
    const par = p.parent;
    const kp = par ? kOf(par) : s, wp = par ? kwOf(par) : kw;
    if (p.at) p.at = [r3(p.at[0] * wp), r3(p.at[1] * kp)];
    for (const o of Object.values(p.views || {})) {
      if (o.at) o.at = [r3(o.at[0] * wp), r3(o.at[1] * kp)];
      if (o.pivot) o.pivot = [Math.round(o.pivot[0] * w), Math.round(o.pivot[1] * k)];
    }
  }
  const before = restLow(def), after = restLow(out);
  out.root = [out.root?.[0] ?? def.root[0], r3((out.root?.[1] ?? def.root[1]) + (before - after))];
  return out;
}

/** Default masks: lower = pelvis + legs, upper = everything else (spine, arms, head, weapon). */
export function defaultMasks(def) {
  const names = Object.keys(def.parts);
  const isLeg = (n) => /^(thigh|shin|foot|leg)(_|$)/.test(n);
  const lower = names.filter((n) => isLeg(n) || n === 'pelvis');
  const arms = names.filter((n) => /^(upper_arm|forearm|hand|arm|mag_hand)(_|$)/.test(n) || n === 'mag_hand');
  const upper = names.filter((n) => !lower.includes(n));
  const head = names.filter((n) => /^(neck|head)$/.test(n));
  return { lower, upper, arms, head, all: names };
}

// ---------- clips ----------
/** Validate a clip definition against a skeleton rig (keys tween, layers / masks exist). */
export function normalizeClip(c, rig, sk, getClip) {
  if (!c || typeof c !== 'object') throw new Error('clip must be an object');
  if (!LIB_NAME.test(c.name || '')) throw new Error('clip needs a "name" (letters, digits, _ - .)');
  if (!c.keys && !c.layers) throw new Error(`clip "${c.name}" needs keys:[{pose|parts, t?, ease?, carry?, z?}] and/or layers:[{clip, mask?, weight?, additive?}]`);
  const out = { name: c.name, skeleton: sk.name };
  for (const k of ['keys', 'frames', 'fps', 'loop', 'events', 'plant', 'secondary', 'carry', 'mask', 'additive', 'ref', 'layers', 'duration', 'notes']) if (c[k] !== undefined) out[k] = structuredClone(c[k]);
  if (out.keys) animatePoses(rig, { keys: out.keys, frames: out.frames ?? out.keys.length, loop: out.loop !== false }); // throws on bad keys
  if (out.mask !== undefined) maskOf(out.mask, rig, sk);
  for (const [i, l] of (out.layers || []).entries()) {
    if (!l || !l.clip) throw new Error(`clip "${c.name}" layers[${i}] needs {clip, mask?, weight?, additive?}`);
    if (l.clip === c.name) throw new Error(`clip "${c.name}" layers[${i}] uses itself`);
    if (!getClip(l.clip)) throw new Error(`clip "${c.name}" layers[${i}]: no clip "${l.clip}" for skeleton "${sk.name}"`);
    if (l.mask !== undefined) maskOf(l.mask, rig, sk);
    if (l.weight !== undefined && !(Number(l.weight) >= 0 && Number(l.weight) <= 1)) throw new Error(`clip "${c.name}" layers[${i}].weight must be 0..1`);
  }
  if (out.events) for (const [i, e] of out.events.entries()) if (!e?.name) throw new Error(`clip "${c.name}" events[${i}] needs {t (0..1) | frame, name}`);
  return out;
}

/** A mask: a skeleton mask name, a part list, or {include?:[parts|masks], exclude?:[...]}. */
export function maskOf(m, rig, sk) {
  if (m === undefined || m === null || m === 'all') return new Set(rig.order);
  const masks = sk.masks || {};
  const expand = (x) => { if (masks[x]) return masks[x]; if (rig.parts[x]) return [x]; throw new Error(`mask: "${x}" is neither a mask (${Object.keys(masks).join(', ')}) nor a part`); };
  if (typeof m === 'string') return new Set(expand(m).filter((n) => rig.parts[n]));
  if (Array.isArray(m)) return new Set(m.flatMap(expand).filter((n) => rig.parts[n]));
  if (typeof m === 'object') {
    const inc = m.include ? m.include.flatMap(expand) : rig.order;
    const exc = new Set((m.exclude || []).flatMap(expand));
    return new Set(inc.filter((n) => rig.parts[n] && !exc.has(n)));
  }
  throw new Error('mask must be a mask name, a list of parts / masks, or {include?, exclude?}');
}

/** Resample a frame list to n frames (by normalized time, tweening neighbours). */
function resample(rig, poses, n, loop) {
  const m = poses.length;
  if (m === n) return poses;
  return Array.from({ length: n }, (_, f) => {
    const t = loop ? f / n : n > 1 ? f / (n - 1) : 0;
    const x = loop ? t * m : t * (m - 1);
    const i = Math.floor(x), u = x - i;
    const a = poses[loop ? i % m : Math.min(i, m - 1)], b = poses[loop ? (i + 1) % m : Math.min(i + 1, m - 1)];
    return u < 1e-6 ? a : lerpPose(rig, a, b, u);
  });
}

/**
 * Combine a layer frame into a base frame for the parts in the mask: override (blend toward the
 * layer by weight) or additive (add the layer's offset from its reference frame). Done per drawn
 * view on the flattened per-view pose, so projected view overrides and per-view IK combine too.
 */
function combine(rig, base, layer, ref, mask, w, additive) {
  const out = {};
  for (const [k, v] of Object.entries(base)) if (k !== 'views' && k !== 'ik') out[k] = structuredClone(v);
  if (base.ik) out.ik = structuredClone(base.ik);
  out.views = {};
  for (const v of rig.views) {
    const B = viewPose(rig, base, v), L = viewPose(rig, layer, v), R = ref ? viewPose(rig, ref, v) : null;
    const o = {};
    for (const n of rig.order) {
      if (!mask.has(n)) { if (base.views?.[v]?.[n]) o[n] = structuredClone(base.views[v][n]); continue; }
      const b = poseOf(rig, B, n), l = poseOf(rig, L, n);
      if (additive) {
        const r = poseOf(rig, R, n);
        o[n] = { x: b.x + w * (l.x - r.x), y: b.y + w * (l.y - r.y), rot: b.rot + w * adiff(r.rot, l.rot), sx: b.sx * (1 + w * (l.sx / r.sx - 1)), sy: b.sy * (1 + w * (l.sy / r.sy - 1)), hide: b.hide, ...(b.variant ? { variant: b.variant } : {}), ...(b.z !== null ? { z: b.z } : {}) };
      } else {
        const p = w < 0.5 ? b : l;
        o[n] = { x: lerp(b.x, l.x, w), y: lerp(b.y, l.y, w), rot: b.rot + adiff(b.rot, l.rot) * w, sx: lerp(b.sx, l.sx, w), sy: lerp(b.sy, l.sy, w), hide: p.hide, ...(p.variant ? { variant: p.variant } : {}), ...(p.z !== null ? { z: p.z } : {}) };
      }
    }
    // IK: ends outside the mask stay; inside it the layer takes over by weight (override) or the base keeps them (additive)
    const ik = {};
    for (const [e, s] of Object.entries(B.ik || {})) {
      if (!mask.has(e) || additive) ik[e] = s;
      else if (w < 1) ik[e] = { ...s, weight: Number(s.weight ?? 1) * (1 - w) };
    }
    if (!additive) for (const [e, s] of Object.entries(L.ik || {})) if (mask.has(e) && (!ik[e] || w >= 0.5)) ik[e] = { ...s, weight: Number(s.weight ?? 1) * w };
    if (Object.keys(ik).length) o.ik = ik;
    out.views[v] = o;
  }
  // per-view IK is complete in every view: drop the shared base IK so viewPose does not re-add masked ends
  delete out.ik;
  if (!additive && layer.carry !== undefined && w >= 0.5) out.carry = layer.carry;
  return out;
}

/**
 * Evaluate a clip on a rig: keys tweened into frames, then each layer (another clip, evaluated
 * the same way, resampled to this clip's frame count) combined through its mask. Events of the
 * clip and of layers with events:true come back as {t, name}.
 * getClip(name) -> clip (already retargeted for this rig). -> {poses, events, frames, fps, loop}
 */
export function evalClip(rig, clip, getClip, sk, depth = 0) {
  if (depth > 6) throw new Error(`clip "${clip.name}": layers nest too deep (a layer cycle?)`);
  const loop = clip.loop !== false;
  const layers = clip.layers || [];
  let n = clip.frames ?? (clip.keys ? clip.keys.length : null);
  let poses = null, fps = clip.fps, events = [...(clip.events || [])];
  if (clip.keys) poses = animatePoses(rig, { keys: clip.keys, frames: n, loop });
  for (const [i, l] of layers.entries()) {
    const lc = getClip(l.clip);
    if (!lc) throw new Error(`clip "${clip.name}": no layer clip "${l.clip}"`);
    const L = evalClip(rig, lc, getClip, sk, depth + 1);
    if (!poses) { // no keys: the first layer is the base
      if (n === null || n === undefined) n = L.poses.length;
      poses = resample(rig, L.poses, n, loop);
      fps = fps ?? L.fps;
      if (l.events !== false) events.push(...L.events);
      if (i === 0 && !l.mask && !l.additive && (l.weight ?? 1) >= 1) continue;
    }
    const lp = resample(rig, L.poses, n, loop);
    const mask = maskOf(l.mask ?? lc.mask, rig, sk);
    const additive = !!(l.additive ?? lc.additive);
    const w = Number(l.weight ?? 1);
    const ref = additive ? (lc.ref !== undefined ? animatePoses(rig, { keys: [lc.ref], frames: 1, loop: false })[0] : L.poses[0]) : null;
    poses = poses.map((P, f) => combine(rig, P, lp[f], ref, mask, w, additive));
    if (l.events) events.push(...L.events);
  }
  return { poses, events, frames: poses.length, fps: fps ?? 10, loop };
}

// ---------- retargeting ----------
/** Hip height of the rest pose in the base view (root to the lowest foot point). */
function hipHeight(def) {
  return Math.max(1, restLow(def) - def.root[1]);
}

/**
 * Retarget clip keys from one skeleton definition to another: part names mapped (map, else same
 * name; parts the target lacks are dropped), named poses inlined from the source, translations
 * scaled by the hip-height ratio, frame-px IK targets moved relative to the root, part-relative
 * targets scaled. Rotations carry over unchanged. -> {keys, dropped:[parts], k}
 */
export function retargetKeys(keys, from, to, map = {}) {
  const k = hipHeight(to) / hipHeight(from);
  const rA = from.root, rB = to.root;
  const name = (n) => map[n] ?? n;
  const dropped = new Set();
  const tgt = (t) => {
    if (!t) return t;
    if (Array.isArray(t)) return [r3((t[0] - rA[0]) * k + rB[0]), r3((t[1] - rA[1]) * k + rB[1])];
    if (t.mix) return { mix: [tgt(t.mix[0]), tgt(t.mix[1]), t.mix[2]] };
    if (t.part) return { ...t, part: name(t.part), ...(t.at ? { at: t.at.map((v) => r3(v * k)) } : {}) };
    return { ...t }; // {weapon: point}: weapon cell px, the same gun
  };
  const parts = (o) => {
    const r = {};
    for (const [n, v] of Object.entries(o || {})) {
      if (n === 'views' || n === 'ik') continue;
      const m = name(n);
      if (!to.parts[m]) { dropped.add(n); continue; }
      r[m] = { ...v, ...(v?.x !== undefined ? { x: r3(v.x * k) } : {}), ...(v?.y !== undefined ? { y: r3(v.y * k) } : {}) };
    }
    if (o?.ik) {
      const ik = {};
      for (const [e, s] of Object.entries(o.ik)) { if (!s) continue; const m = name(e); if (!to.parts[m]) { dropped.add(e); continue; } ik[m] = { ...s, target: tgt(s.target) }; }
      if (Object.keys(ik).length) r.ik = ik;
    }
    return r;
  };
  const out = keys.map((key) => {
    const o = {};
    for (const f of ['t', 'ease', 'mirror_pairs', 'mirror_hands', 'carry']) if (key[f] !== undefined) o[f] = key[f];
    let P = key.pose !== undefined ? from.poses?.[key.pose] : key.parts;
    if (key.pose !== undefined && !P) throw new Error(`retarget: the source skeleton has no pose "${key.pose}"`);
    // a named pose keeps the carry state its name mapped to on the source (weapon.poses)
    if (key.pose !== undefined && o.carry === undefined && from.weapon?.poses?.[key.pose] !== undefined) o.carry = from.weapon.poses[key.pose];
    P = structuredClone(P || {});
    if (key.views) { P.views = { ...(P.views || {}) }; for (const [v, x] of Object.entries(key.views)) P.views[v] = { ...(P.views[v] || {}), ...x }; }
    if (key.ik) P.ik = { ...(P.ik || {}), ...key.ik };
    const body = parts(P);
    if (P.views) body.views = Object.fromEntries(Object.entries(P.views).filter(([v]) => (to.views || ['side']).includes(v)).map(([v, x]) => [v, parts(x)]));
    if (P.carry !== undefined && o.carry === undefined) o.carry = P.carry;
    o.parts = body;
    if (key.z) o.z = Object.fromEntries(Object.entries(key.z).map(([n, z]) => [name(n), z]).filter(([n]) => to.parts[n]));
    return o;
  });
  return { keys: out, dropped: [...dropped], k: r3(k) };
}

/** Retarget a whole clip (keys, ref pose) to another skeleton definition. */
export function retargetClip(clip, from, to, map) {
  const out = structuredClone(clip);
  const notes = [];
  if (clip.keys) { const r = retargetKeys(clip.keys, from, to, map); out.keys = r.keys; if (r.dropped.length) notes.push(`dropped parts the target lacks: ${r.dropped.join(', ')}`); out.retarget = { k: r.k }; }
  if (clip.ref !== undefined) out.ref = retargetKeys([clip.ref], from, to, map).keys[0];
  if (Array.isArray(clip.mask)) out.mask = clip.mask.map((n) => map?.[n] ?? n);
  return { clip: out, notes };
}
