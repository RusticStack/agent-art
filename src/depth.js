// Depth model for 2D rotated-sprite rigs (opt-in rig "depth"): per-frame draw order from a 3D proxy.
//
// The proxy is the same one the weapon solver uses: the base (side) view's FK gives each joint's
// forward x and height y, the rest front view gives its lateral offset z (near side +). In a view
// rotated by yaw psi the depth toward the camera is  d = (x - root.x) sin(psi) + z cos(psi).
// A z rule compares a limb (and the rest of its chain) with a reference part (the chest): the limb
// goes over the reference when it is in front of the reference's front surface, under it when it is
// behind its back surface, and keeps the authored order in between (so an arm hanging at the side of
// the torso does not change). Clips decide frame by frame with hysteresis, so the order never
// flickers on a limb that hovers at a surface. A split rule cuts a bone that crosses the surface
// into two pieces with their own z (a forearm reaching across the chest: elbow behind, hand in front).
import { partIn, poseOf, solveCore, worldOf } from './rig.js';
import { VIEW_YAW } from './weapon.js';

const D2R = Math.PI / 180;
const r2 = (v) => Math.round(v * 100) / 100;
const rot2 = (deg, x, y) => { const r = deg * D2R, c = Math.cos(r), s = Math.sin(r); return [x * c - y * s, x * s + y * c]; };

/** Single-child chain below a part (upper_arm -> forearm -> hand), the part first. */
function chainOf(rig, part) {
  const out = [part];
  for (let k = part, guard = 0; guard < 16; guard++) {
    const kids = rig.order.filter((n) => rig.parts[n].parent === k && !rig.parts[n].art && !rig.parts[n].hide);
    // follow the child that continues the limb (the longest cell), ignore riders (gear, props)
    const next = kids.filter((n) => /arm|hand|leg|thigh|shin|foot|fore|wing|tail/.test(n)).sort((a, b) => rig.parts[b].h - rig.parts[a].h)[0];
    if (!next) break;
    out.push(next);
    k = next;
  }
  return out;
}

/** Default rules: every limb chain hanging from the chest (arms) against the chest. */
function autoRules(rig) {
  const ref = rig.parts.chest ? 'chest' : rig.parts.torso ? 'torso' : rig.parts.body ? 'body' : null;
  if (!ref) return [];
  return rig.order.filter((n) => rig.parts[n].parent === ref && /arm/.test(n) && !/fore/.test(n)).map((n) => ({ part: n, ref, chain: true, split: true }));
}

/**
 * rig.depth: true | {rules?:[{part, ref, chain?:true, split?:false, views?:[...]}], auto?:true,
 * margin?:px, base_view?, yaw?:{view:deg}, lateral?:{part:px}, thickness?:{part:[depth, width]}}
 */
export function normalizeDepth(rig, cfg) {
  if (cfg === true) cfg = {};
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) throw new Error('rig "depth" must be true or {rules?:[{part, ref, chain?, split?, views?}], margin?, yaw?}');
  const base = cfg.base_view ?? (rig.views.includes('side') ? 'side' : rig.views[0]);
  if (!rig.views.includes(base)) throw new Error(`depth.base_view "${base}" is not a drawn view`);
  const yaw = {};
  for (const v of rig.views) yaw[v] = Number(cfg.yaw?.[v] ?? VIEW_YAW[v] ?? 0);
  const raw = cfg.rules ?? (cfg.auto === false ? [] : autoRules(rig));
  if (!Array.isArray(raw)) throw new Error('depth.rules must be an array of {part, ref, chain?, split?, views?}');
  const rules = raw.map((r, i) => {
    if (!r || !rig.parts[r.part]) throw new Error(`depth.rules[${i}]: unknown part "${r?.part}"`);
    if (!rig.parts[r.ref]) throw new Error(`depth.rules[${i}]: unknown ref "${r.ref}"`);
    if (r.views) for (const v of r.views) if (!rig.views.includes(v)) throw new Error(`depth.rules[${i}]: views must be drawn views (${rig.views.join(', ')})`);
    const parts = r.chain === false ? [r.part] : chainOf(rig, r.part);
    if (parts.includes(r.ref)) throw new Error(`depth.rules[${i}]: ref "${r.ref}" is inside the chain of "${r.part}"`);
    return { part: r.part, ref: r.ref, parts, split: !!r.split, views: r.views ? new Set(r.views) : null };
  });
  // riders: parts hanging from a chain member that are not in the chain (a magazine in the hand)
  const inChain = new Set(rules.flatMap((r) => r.parts));
  const riders = {};
  for (const n of rig.order) { const p = rig.parts[n].parent; if (p && inChain.has(p) && !inChain.has(n)) riders[n] = p; }
  // lateral offsets (z, + = near side) from the rest front view, else from the _f/_b names
  const lat = {};
  if (rig.views.includes('front')) {
    const Wf = worldOf(rig, {}, 'front');
    for (const n of rig.order) lat[n] = -(Wf[n].x - rig.root[0]);
  } else {
    const s = rig.frame[0] * 0.07;
    for (const n of rig.order) lat[n] = /_(f|front|r|right)$/.test(n) ? s : /_(b|back|l|left)$/.test(n) ? -s : 0;
  }
  for (const [n, z] of Object.entries(cfg.lateral || {})) if (rig.parts[n]) lat[n] = Number(z) || 0;
  const margin = Math.max(0.5, Number(cfg.margin ?? rig.frame[1] * 0.012));
  return { base, yaw, rules, riders, lat, margin, thickness: cfg.thickness || {}, cfg };
}

/** Bone ends of a part in the base view: pivot and tip (the next chain joint, else the cell's far end). */
function boneEnds(rig, W, name, next, base) {
  const T = W[name], p = partIn(rig, name, base);
  if (next && W[next]) return { a: [T.x, T.y], b: [W[next].x, W[next].y], len: Math.hypot(W[next].x - T.x, W[next].y - T.y), local: partIn(rig, next, base).at };
  const ly = p.h - 1 - p.pivot[1], [dx, dy] = rot2(T.rot, 0, ly);
  return { a: [T.x, T.y], b: [T.x + dx, T.y + dy], len: Math.abs(ly), local: [0, ly] };
}

/** Depth of the reference part's centre and its half thickness toward the camera in a view. */
function refDepth(rig, D, W, ref, s, c) {
  const T = W[ref], p = partIn(rig, ref, D.base);
  const [dx, dy] = rot2(T.rot, p.w / 2 - p.pivot[0], p.h / 2 - p.pivot[1]);
  const d = (T.x + dx - rig.root[0]) * s + D.lat[ref] * c;
  // torso thickness: the cell width is its width across (front view) and ~0.75 of it front-to-back
  const [deep, wide] = D.thickness[ref] ?? [p.w * 0.75, p.w];
  return { d, half: (Math.abs(s) * deep + Math.abs(c) * wide) / 2 };
}

/**
 * Decide the depth order of one pose in a drawn view. prev = the previous frame's states (clips),
 * so a limb within the margin of a surface keeps its side. -> {dec: {part: {z?, split?, state}}, states}
 */
export function decideDepth(rig, P, view, solved, prev = null) {
  const D = rig.depth, src = rig.mirror[view] || view;
  const psi = D.yaw[src] ?? 0, s = Math.sin(psi * D2R), c = Math.cos(psi * D2R);
  const Wb = solveCore(rig, P, D.base).world;
  const VP = solved.VP;
  const dOf = (pt, lat) => (pt[0] - rig.root[0]) * s + lat * c;
  const zOf = (n) => { const v = poseOf(rig, VP, n); return v.z ?? partIn(rig, n, src).z; };
  const dec = {}, states = {};
  const m = D.margin;
  const W = rig.weapon;
  const locked = new Set();
  const held = new Set();
  if (W && solved.weapon) for (const r of ['main', 'support']) { const h = solved.weapon.hands?.[r]; if (h?.weight >= 0.999) { locked.add(h.hand); for (const n of [h.up, h.fore, h.hand]) held.add(n); } }
  const zWeapon = W ? zOf(W.part) : null;
  // back-facing views, arms holding the gun: an arm level with the torso cannot be inside it; an
  // upper arm past the torso's centre (away from the camera) is in front of the body, and a forearm /
  // hand on the gun (in front of the body, drawn under the torso from behind) is too unless it is
  // clearly nearer the camera than the back surface: both are hidden by the torso. "below" also goes under
  // the whole trunk (the ref and its parents), not just the ref, so the arm reaching to a hip grip
  // is not drawn over the lower torso.
  const backView = psi < -1e-6 && D.cfg.back_occlusion !== false;
  for (const rule of D.rules) {
    if (rule.views && !rule.views.has(src)) continue;
    const R = refDepth(rig, D, Wb, rule.ref, s, c);
    const zRef = zOf(rule.ref);
    let zTrunk = zRef;
    if (backView) for (let p = rig.parts[rule.ref]?.parent; p; p = rig.parts[p]?.parent) zTrunk = Math.min(zTrunk, zOf(p));
    const front = R.d + R.half, back = R.d - R.half;
    rule.parts.forEach((n, k) => {
      if (poseOf(rig, VP, n).hide) return;
      const key = `${n}|${rule.ref}`;
      const e = boneEnds(rig, Wb, n, rule.parts[k + 1], D.base);
      const latB = rule.parts[k + 1] ? D.lat[rule.parts[k + 1]] : D.lat[n];
      const d0 = dOf(e.a, D.lat[n]), d1 = dOf(e.b, latB), dm = (d0 + d1) / 2;
      const was = prev?.[key] ?? null;
      const bh = backView && held.has(n), zr = backView ? zTrunk : zRef;
      const side = (d) => (d > front + m ? 'above' : d < back - m ? 'below' : bh && (k > 0 || d < R.d - m) ? 'below' : null);
      let st = side(dm);
      if (!st && was === 'above' && dm > front - m) st = 'above';
      if (!st && was === 'below' && dm < (bh ? R.d + m : back + m)) st = 'below';
      states[key] = st;
      const za = partIn(rig, n, src).z;
      const zFor = (state) => {
        if (state === 'above') { let z = za > zRef ? za : zRef + 0.1 + 0.01 * k; if (locked.has(n) && zWeapon !== null) z = Math.max(z, zWeapon + 0.05 + 0.01 * k); return z; }
        if (state === 'below') return za < zr ? za : zr - 0.5 + 0.01 * k;
        return za;
      };
      const z = zFor(st);
      const out = { state: st ?? 'authored', depth: r2(dm - R.d), ref: rule.ref };
      if (Math.abs(z - za) > 1e-9) out.z = z;
      // split: the bone crosses a surface -> pivot piece and tip piece get their own order
      if (rule.split && e.len > 2) {
        const sa = side(d0) ?? (st && Math.abs(d0 - dm) < m ? st : null), sb = side(d1) ?? (st && Math.abs(d1 - dm) < m ? st : null);
        if (sa !== sb && Math.abs(zFor(sa) - zFor(sb)) > 1e-9) {
          const surf = (sa === 'above' || sb === 'above') ? front + m : bh ? R.d - m : back - m;
          const t = Math.min(0.95, Math.max(0.05, (surf - d0) / ((d1 - d0) || 1e-9)));
          const p = partIn(rig, n, D.base);
          const cut = Math.round(p.pivot[1] + t * (e.local[1] ?? e.len));
          if (cut > 0 && cut < p.h) { out.split = { cut, z: [zFor(sa), zFor(sb)] }; out.state = `split ${sa ?? 'authored'}/${sb ?? 'authored'}`; }
        }
      }
      dec[n] = out;
    });
  }
  // riders keep their offset to the chain member they hang from
  for (const [n, par] of Object.entries(D.riders)) {
    if (!dec[par] || dec[par].z === undefined) continue;
    const za = partIn(rig, n, src).z, zp = partIn(rig, par, src).z;
    dec[n] = { state: `rides on ${par}`, z: dec[par].z + Math.sign(za - zp || 1) * 0.005 };
  }
  return { dec, states };
}

/** Write depth decisions into a solved pose (r.VP): pose._depth[view] from a clip pass, else decided now. */
export function applyDepth(rig, P, r) {
  const view = r.src;
  let dec = P?._depth?.[view];
  if (!dec) dec = decideDepth(rig, P, view, r, null).dec;
  for (const [n, o] of Object.entries(dec)) {
    if (o.z === undefined && !o.split) continue;
    // an explicit pose z (z keyframes) wins over the depth model
    const own = P?.[n]?.z ?? P?.views?.[view]?.[n]?.z;
    if (own !== undefined && own !== null) continue;
    r.VP[n] = { ...(r.VP[n] || {}), ...(o.z !== undefined ? { z: o.z } : {}), ...(o.split ? { split: o.split } : {}) };
  }
  r.depth = dec;
  return r;
}

/** Clip pass: decide every frame in order with hysteresis -> poses with _depth for the drawn view. */
export function depthPass(rig, poses, view, { loop = true } = {}) {
  if (!rig.depth) return poses;
  const src = rig.mirror[view] || view;
  let prev = null;
  const run = (P) => { const r = solveCore(rig, P, view); const { dec, states } = decideDepth(rig, P, view, r, prev); prev = states; return dec; };
  // loops: settle the state on the last frame first so frame 0 continues the loop seamlessly
  if (loop && poses.length > 1) run(poses[poses.length - 1]);
  return poses.map((P) => ({ ...P, _depth: { ...(P._depth || {}), [src]: run(P) } }));
}

/**
 * Draw-order analysis of a rendered clip (per-frame traces from renderPose {trace}):
 * order flips between overlapping parts that flip back within `window` frames (z-flicker).
 */
export function findFlicker(traces, { window = 2, loop = true } = {}) {
  const n = traces.length;
  if (n < 3) return [];
  const label = (e) => (e.piece ? `${e.part}:${e.piece}` : e.part);
  const overl = (a, b) => a.box && b.box && a.box[0] <= b.box[2] && b.box[0] <= a.box[2] && a.box[1] <= b.box[3] && b.box[1] <= a.box[3];
  // per frame: pair -> +1 (first name over) / -1, only when the two overlap on screen
  const sign = traces.map((t) => {
    const m = new Map();
    t.order.forEach((a, i) => t.order.forEach((b, j) => {
      if (j <= i || a.part === b.part || !overl(a, b)) return;
      const [x, y] = [label(a), label(b)].sort();
      m.set(`${x}>${y}`, label(a) === x ? -1 : 1); // a (index i) is drawn under b: -1 when a is x
    }));
    return m;
  });
  const out = new Map();
  const keys = new Set(sign.flatMap((m) => [...m.keys()]));
  for (const k of keys) {
    const at = (f) => sign[((f % n) + n) % n].get(k) ?? 0;
    const end = loop ? n : n - 1;
    for (let f = 1; f <= end; f++) {
      const a = at(f - 1), b = at(f);
      if (!a || !b || a === b) continue;
      for (let w = 1; w <= window; w++) {
        if (!loop && f + w >= n) break;
        const c = at(f + w);
        if (c === a) { if (!out.has(k)) out.set(k, []); out.get(k).push(f % n); break; }
        if (c && c !== b) break;
      }
    }
  }
  return [...out.entries()].map(([pair, frames]) => { const [a, b] = pair.split('>'); return { pair: [a, b], frames: [...new Set(frames)].sort((x, y) => x - y) }; });
}

/** Layer validator for one frame: drawn order vs the depth decisions of overlapping rule parts. */
export function layerIssues(rig, trace, dec) {
  const issues = [];
  if (!dec) return issues;
  const pos = new Map();
  trace.order.forEach((e, i) => { if (!pos.has(e.part)) pos.set(e.part, { i, e }); });
  const overl = (a, b) => a.box && b.box && a.box[0] <= b.box[2] && b.box[0] <= a.box[2] && a.box[1] <= b.box[3] && b.box[1] <= a.box[3];
  for (const [n, o] of Object.entries(dec)) {
    if (!o.ref || o.split || !/^(above|below)$/.test(o.state)) continue;
    const A = pos.get(n), B = pos.get(o.ref);
    if (!A || !B || !overl(A.e, B.e)) continue;
    const over = A.i > B.i;
    if (o.state === 'above' && !over) issues.push(`${n} drawn under ${o.ref} although ${Math.abs(o.depth)}px in front of it`);
    if (o.state === 'below' && over) issues.push(`${n} drawn over ${o.ref} although ${Math.abs(o.depth)}px behind it`);
  }
  return issues;
}

/** Bottom-to-top part names of a traced frame (split pieces as part:pivot / part:tip). */
export const orderOf = (trace) => trace.order.filter((e) => e.px).map((e) => (e.piece ? `${e.part}:${e.piece}` : e.part));
