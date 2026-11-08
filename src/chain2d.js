// 2D constraints and chains for rigs (art_rig): CCD IK for chains longer than two bones (tails,
// cables, straps, hoses, slings), joint limits on local rotation, and per-frame constraints
// (aim, look_at spread over a chain, copy_rotation). Applied after FK / two-bone IK; rigs without
// "constrain" / "limits" and IK ends without chain > 2 never reach this file.
import { worldOf, poseOf, partIn, targetPoint } from './rig.js';

const D2R = Math.PI / 180;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const adiff = (a, b) => { let d = (b - a) % 360; if (d > 180) d -= 360; if (d < -180) d += 360; return d; };
const wrap = (a) => adiff(0, a);
export const CONSTRAINT_TYPES = ['aim', 'look_at', 'copy_rotation'];

/** Validate rig "constrain" (list) + "limits" ({part: [min, max]} local degrees). */
export function normalizeConstraints(rig, list, limits) {
  const out = { list: [], limits: {} };
  for (const [p, l] of Object.entries(limits || {})) {
    if (!rig.parts[p]) throw new Error(`limits: unknown part "${p}"`);
    if (!Array.isArray(l) || l.length !== 2 || !l.every((v) => Number.isFinite(Number(v))) || Number(l[0]) > Number(l[1])) throw new Error(`limits.${p} must be [min, max] local rotation in degrees (min <= max)`);
    out.limits[p] = [Number(l[0]), Number(l[1])];
  }
  if (list !== undefined && !Array.isArray(list)) throw new Error('rig "constrain" must be a list: [{type:"aim"|"look_at"|"copy_rotation", part, target|from, ...}]');
  for (const [i, c0] of (list || []).entries()) {
    const w = `constrain[${i}]`;
    if (!c0 || !CONSTRAINT_TYPES.includes(c0.type)) throw new Error(`${w}.type must be ${CONSTRAINT_TYPES.join(' | ')}`);
    if (!rig.parts[c0.part]) throw new Error(`${w}: unknown part "${c0.part}"`);
    const c = { ...c0, weight: clamp(Number(c0.weight ?? 1), 0, 1) };
    if (c.type === 'copy_rotation') {
      if (!rig.parts[c.from]) throw new Error(`${w}: copy_rotation needs from:<part>`);
      if (c.space !== undefined && !['local', 'world'].includes(c.space)) throw new Error(`${w}.space must be local | world`);
    } else {
      const t = c.target;
      const ok = typeof t === 'string' ? /^[\w-]+$/.test(t) : Array.isArray(t) ? t.length === 2 && t.every((v) => Number.isFinite(Number(v))) : !!(t?.part && rig.parts[t.part]);
      if (!ok) throw new Error(`${w}: ${c.type} needs target:[x,y] (frame px) | {part, at?} | "<name>" (a pose's targets:{<name>: [x,y] | {part, at?}})`);
      if (c.type === 'look_at') {
        c.chain = [].concat(c.chain || []);
        for (const n of c.chain) if (!rig.parts[n]) throw new Error(`${w}.chain: unknown part "${n}"`);
        if (c.share !== undefined && (!Array.isArray(c.share) || c.share.length !== c.chain.length)) throw new Error(`${w}.share must list one fraction per chain part`);
        c.limit = Number(c.limit ?? 75);
      }
    }
    out.list.push(c);
  }
  return out;
}

const set = (VP, n, k, v) => { VP[n] = { ...(VP[n] || {}), [k]: v }; };
const localRot = (rig, VP, n) => poseOf(rig, VP, n).rot;

/** Drawn direction of a part at bind (pivot -> first child / cell centre), degrees. */
function boneAxis(rig, name, src) {
  const kids = rig.order.filter((c) => rig.parts[c].parent === name);
  const p = partIn(rig, name, src);
  if (kids.length) { const k = partIn(rig, kids[0], src); if (Math.hypot(k.at[0], k.at[1]) > 1e-6) return Math.atan2(k.at[1], k.at[0]) / D2R; }
  const cx = p.w / 2 - p.pivot[0], cy = p.h / 2 - p.pivot[1];
  return Math.hypot(cx, cy) > 1e-6 ? Math.atan2(cy, cx) / D2R : 0;
}

/** Apply joint limits (clamp local rotation). */
export function applyLimits(rig, VP) {
  const L = rig.constrain?.limits;
  if (!L) return VP;
  for (const [n, [a, b]] of Object.entries(L)) { const r = wrap(localRot(rig, VP, n)); if (r < a || r > b) set(VP, n, 'rot', clamp(r, a, b)); }
  return VP;
}

/** The n ancestors of an IK end, nearest first (the bones CCD rotates). */
export function ccdChain(rig, end, n) {
  if (!rig.parts[end]) throw new Error(`ik: unknown part "${end}"`);
  const out = [];
  for (let k = rig.parts[end].parent; k && out.length < n; k = rig.parts[k].parent) out.push(k);
  if (out.length < n) throw new Error(`ik: "${end}" has only ${out.length} ancestors; chain:${n} needs ${n}`);
  return out;
}

/**
 * CCD IK: rotate the chain bones (nearest the end first) so the end part's pivot reaches the
 * target; joint limits are respected each step; weight blends with FK.
 */
export function solveCCD(rig, VP, src, end, e) {
  const n = Math.round(Number(e.chain));
  const chain = ccdChain(rig, end, n);
  const w = clamp(Number(e.weight ?? 1), 0, 1);
  const fk = Object.fromEntries(chain.map((b) => [b, localRot(rig, VP, b)]));
  let W = worldOf(rig, VP, src);
  const T = targetPoint(rig, e.target, W);
  const L = rig.constrain?.limits || {};
  const iters = clamp(Math.round(Number(e.iterations ?? 40)), 1, 128);
  // damped CCD: at most `damp` degrees per bone per pass spreads the bend along the chain (a
  // cable sags in an arc instead of kinking at the last joints)
  const damp = Math.max(1, Number(e.damp ?? 12));
  for (let it = 0; it < iters; it++) {
    for (const b of chain) {
      W = worldOf(rig, VP, src);
      const pb = W[b], pe = W[end];
      const a1 = Math.atan2(pe.y - pb.y, pe.x - pb.x), a2 = Math.atan2(T[1] - pb.y, T[0] - pb.x);
      if (Math.hypot(pe.x - pb.x, pe.y - pb.y) < 1e-6) continue;
      let r = localRot(rig, VP, b) + clamp(adiff(a1 / D2R, a2 / D2R), -damp, damp) * (pb.flip ? -1 : 1);
      if (L[b]) r = clamp(wrap(r), L[b][0], L[b][1]);
      set(VP, b, 'rot', r);
    }
    W = worldOf(rig, VP, src);
    if (Math.hypot(W[end].x - T[0], W[end].y - T[1]) < 0.05) break;
  }
  if (w < 1) for (const b of chain) set(VP, b, 'rot', fk[b] + adiff(fk[b], localRot(rig, VP, b)) * w);
  return VP;
}

/** Resolve a constraint target: [x,y] | {part, at} | "<name>" from the pose's targets. */
function targetOf(rig, c, P, W) {
  let t = c.target;
  if (typeof t === 'string') {
    t = P?.targets?.[t];
    if (t === undefined) return null; // no target for this frame: the constraint rests
  }
  return targetPoint(rig, t, W);
}

/** Per-frame constraints (in list order), then joint limits. P = the resolved pose (targets). */
export function applyConstraints(rig, VP, src, P) {
  const C = rig.constrain;
  if (!C) return VP;
  for (const c of C.list) {
    if (!(c.weight > 0)) continue;
    let W = worldOf(rig, VP, src);
    if (c.type === 'copy_rotation') {
      const off = Number(c.offset ?? 0), k = c.invert ? -1 : 1;
      if (c.space === 'world') {
        const want = k * W[c.from].rot + off;
        set(VP, c.part, 'rot', localRot(rig, VP, c.part) + c.weight * adiff(W[c.part].rot, want));
      } else {
        const want = k * localRot(rig, VP, c.from) + off, cur = localRot(rig, VP, c.part);
        set(VP, c.part, 'rot', cur + c.weight * adiff(cur, want));
      }
      continue;
    }
    const T = targetOf(rig, c, P, W);
    if (!T) continue;
    const axis = c.axis !== undefined ? Number(c.axis) : boneAxis(rig, c.part, src);
    const aimAt = () => { const p = W[c.part]; return Math.atan2(T[1] - p.y, T[0] - p.x) / D2R - axis; };
    if (c.type === 'aim') {
      set(VP, c.part, 'rot', localRot(rig, VP, c.part) + c.weight * adiff(W[c.part].rot, aimAt()));
      continue;
    }
    // look_at: the turn (clamped to +-limit from the rest direction) is shared by the chain
    // (neck, chest, ...) and the part itself takes the rest
    const parentRot = rig.parts[c.part].parent ? W[rig.parts[c.part].parent].rot : 0;
    const want = parentRot + clamp(adiff(parentRot, aimAt()), -c.limit, c.limit);
    const total = adiff(W[c.part].rot, want) * c.weight;
    const share = c.share ? c.share.map(Number) : c.chain.map(() => 1 / (c.chain.length + 1));
    c.chain.slice().reverse().forEach((b, i) => { const s = share[c.chain.length - 1 - i]; set(VP, b, 'rot', localRot(rig, VP, b) + total * s); });
    W = worldOf(rig, VP, src);
    const want2 = (rig.parts[c.part].parent ? W[rig.parts[c.part].parent].rot : 0) + clamp(adiff(rig.parts[c.part].parent ? W[rig.parts[c.part].parent].rot : 0, aimAt()), -c.limit, c.limit);
    set(VP, c.part, 'rot', localRot(rig, VP, c.part) + c.weight * adiff(W[c.part].rot, want2));
  }
  return applyLimits(rig, VP);
}
