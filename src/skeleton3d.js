// 3D skeletons for art_model skinning: a bone hierarchy (rest pose, joint limits, IK chains,
// constraints), bone templates (humanoid / exosuit share the art_anim humanoid_hd bone names, so 2D
// and 3D skeletons share clips; quadruped, chain, landing_gear), bones from rigid-rig parts or from
// an art_anim library skeleton, clip sampling (keys, easing, events, morph weights, IK targets) and
// the pose solver (FK -> limits -> IK -> constraints).
//
// Units: model px (32 px = 1 m), Y up, the character faces +Z (glTF forward). Bone rest frames are
// axis-aligned unless a bone has rotate:[x,y,z] (bones made from rotated rigid parts), which keeps
// Roblox happy (bones frozen at rotation 0). Side names follow art_anim: _f = the side nearest the
// camera in the 2D side view = the character's right (-X), _b = its left (+X).
import { matMul, mT, IDENT, applyP } from './model3d.js';
import { qMul, qEuler, qSlerp, quatOfMat } from './modelrig.js';
import { trsMatrix } from './glb.js';

export const BONE_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const D2R = Math.PI / 180;
const r4 = (v) => Math.round(v * 1e4) / 1e4;
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const nrm = (a) => { const l = len(a); return l > 1e-12 ? mul(a, 1 / l) : [0, 0, 0]; };
const lerp3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
export const vecs = { sub, add, mul, dot, cross, len, nrm };

// ---------- quaternions / matrices ----------
export const qConj = (q) => [-q[0], -q[1], -q[2], q[3]];
const qN = (q) => { const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1; return q.map((v) => v / l); };
export const qRot = (q, v) => { const p = qMul(qMul(q, [v[0], v[1], v[2], 0]), qConj(q)); return [p[0], p[1], p[2]]; };
/** Shortest-arc rotation taking direction a onto direction b. */
export function qFromTo(a, b) {
  const u = nrm(a), v = nrm(b), d = dot(u, v);
  if (d > 1 - 1e-12) return [0, 0, 0, 1];
  if (d < -1 + 1e-12) { let ax = cross([1, 0, 0], u); if (len(ax) < 1e-6) ax = cross([0, 1, 0], u); ax = nrm(ax); return [ax[0], ax[1], ax[2], 0]; }
  const c = cross(u, v);
  return qN([c[0], c[1], c[2], 1 + d]);
}
/** Euler degrees [x,y,z] (R = Rz * Ry * Rx, the art_model rotate order) of a quaternion. */
export function eulerOfQuat(q) {
  const m = trsMatrix([0, 0, 0], q, [1, 1, 1]);
  const b = Math.asin(Math.max(-1, Math.min(1, -m[8])));
  const a = Math.atan2(m[9], m[10]), c = Math.atan2(m[4], m[0]);
  return [a, b, c].map((v) => v / D2R);
}
/** Inverse of an affine 3x4 matrix. */
export function inv34(M) {
  const [a, b, c, , d, e, f, , g, h, i] = M;
  const A = e * i - f * h, B = f * g - d * i, C = d * h - e * g, det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-14) throw new Error('singular bone matrix (zero scale?)');
  const k = 1 / det;
  const R = [A * k, (c * h - b * i) * k, (b * f - c * e) * k, 0, B * k, (a * i - c * g) * k, (c * d - a * f) * k, 0, C * k, (b * g - a * h) * k, (a * e - b * d) * k, 0];
  const t = [M[3], M[7], M[11]];
  R[3] = -(R[0] * t[0] + R[1] * t[1] + R[2] * t[2]); R[7] = -(R[4] * t[0] + R[5] * t[1] + R[6] * t[2]); R[11] = -(R[8] * t[0] + R[9] * t[1] + R[10] * t[2]);
  return R;
}
const rotOnly = (M) => { const sx = Math.hypot(M[0], M[4], M[8]) || 1, sy = Math.hypot(M[1], M[5], M[9]) || 1, sz = Math.hypot(M[2], M[6], M[10]) || 1; return [M[0] / sx, M[1] / sy, M[2] / sz, 0, M[4] / sx, M[5] / sy, M[6] / sz, 0, M[8] / sx, M[9] / sy, M[10] / sz, 0]; };
const posOf = (M) => [M[3], M[7], M[11]];

const vec3 = (v, name) => {
  if (!Array.isArray(v) || v.length !== 3 || v.some((x) => !Number.isFinite(Number(x)))) throw new Error(`${name} must be [x,y,z] numbers (got ${JSON.stringify(v)})`);
  return v.map(Number);
};

// ---------- templates (px at the default height; character faces +Z, feet on y = 0) ----------
const mirrorX = (bones, from, to) => {
  const out = {};
  for (const [n, b] of Object.entries(bones)) if (n.endsWith(from)) {
    const m = n.slice(0, -from.length) + to;
    // mirroring across X keeps rotations about X and flips those about Y and Z
    const limits = b.limits ? Object.fromEntries(Object.entries(b.limits).map(([ax, [lo, hi]]) => [ax, ax === 'x' ? [lo, hi] : [-hi, -lo]])) : undefined;
    out[m] = { ...b, head: [-b.head[0], b.head[1], b.head[2]], ...(b.tail ? { tail: [-b.tail[0], b.tail[1], b.tail[2]] } : {}), ...(limits ? { limits } : {}), ...(b.parent && b.parent.endsWith(from) ? { parent: b.parent.slice(0, -from.length) + to } : {}) };
  }
  return out;
};
function bipedBones(P) {
  const f = {
    thigh_f: { parent: 'pelvis', head: [-P.hipX, P.hip, 0], limits: { x: [-120, 60], y: [-45, 45], z: [-60, 30] } },
    shin_f: { parent: 'thigh_f', head: [-P.hipX, P.knee, 0], limits: { x: [0, 160], y: [-10, 10], z: [-10, 10] } },
    foot_f: { parent: 'shin_f', head: [-P.hipX, P.ankle, 0], tail: [-P.hipX, 0.5 * P.k, P.toe], limits: { x: [-50, 50] } },
    upper_arm_f: { parent: 'chest', head: [-P.shX, P.sh, 0], limits: { x: [-180, 90], y: [-90, 90], z: [-180, 30] } },
    forearm_f: { parent: 'upper_arm_f', head: [-P.shX, P.elbow, 0], limits: { x: [-160, 0], y: [-90, 90], z: [-10, 10] } },
    hand_f: { parent: 'forearm_f', head: [-P.shX, P.wrist, 0], tail: [-P.shX, P.wrist - P.hand, 0], limits: { x: [-80, 80], z: [-40, 40] } },
  };
  return {
    pelvis: { parent: null, head: [0, P.pelvis, 0], tail: [0, P.torso, 0] },
    torso: { parent: 'pelvis', head: [0, P.torso, 0], limits: { x: [-60, 60], y: [-40, 40], z: [-30, 30] } },
    chest: { parent: 'torso', head: [0, P.chest, 0], limits: { x: [-40, 40], y: [-40, 40], z: [-30, 30] } },
    neck: { parent: 'chest', head: [0, P.neck, 0], limits: { x: [-45, 45], y: [-60, 60], z: [-30, 30] } },
    head: { parent: 'neck', head: [0, P.head, 0], tail: [0, P.top, 0], limits: { x: [-60, 60], y: [-80, 80], z: [-40, 40] } },
    ...f, ...mirrorX(f, '_f', '_b'),
  };
}
const bipedIK = { leg_f: { bones: ['thigh_f', 'shin_f', 'foot_f'], pole: [0, 0, 1] }, leg_b: { bones: ['thigh_b', 'shin_b', 'foot_b'], pole: [0, 0, 1] }, arm_f: { bones: ['upper_arm_f', 'forearm_f', 'hand_f'], pole: [0, 0, -1] }, arm_b: { bones: ['upper_arm_b', 'forearm_b', 'hand_b'], pole: [0, 0, -1] } };
const scaleBones = (bones, k, off = [0, 0, 0]) => {
  for (const b of Object.values(bones)) { b.head = b.head.map((v, i) => r4(v * k + off[i])); if (b.tail) b.tail = b.tail.map((v, i) => r4(v * k + off[i])); }
  return bones;
};

export const SKELETON_TEMPLATES = {
  /** 1.8 m human (58 px): art_anim humanoid_hd bone names, two-bone IK legs / arms. */
  humanoid(o) {
    const H = 58, k = Number(o.height ?? H) / H;
    const bones = bipedBones({ k: 1, pelvis: 30, torso: 33, chest: 39, neck: 47, head: 50, top: 58, hipX: 3, hip: 29, knee: 16, ankle: 2.5, toe: 5, shX: 6.5, sh: 46, elbow: 37, wrist: 29, hand: 4 });
    return { bones: scaleBones(bones, k), ik: structuredClone(bipedIK), height: H * k, notes: 'humanoid: humanoid_hd bone names (_f = right/-X, _b = left/+X), faces +Z; IK chains leg_f leg_b arm_f arm_b' };
  },
  /** 2.5 m powered exosuit / small mech (80 px): humanoid bone names (art_anim clips retarget) + backpack and shoulder pads. */
  exosuit(o) {
    const H = 80, k = Number(o.height ?? H) / H;
    const bones = bipedBones({ k: 1, pelvis: 40, torso: 45, chest: 54, neck: 66, head: 69, top: 78, hipX: 6.5, hip: 39, knee: 21, ankle: 4.5, toe: 9, shX: 13, sh: 64, elbow: 51, wrist: 39, hand: 6 });
    bones.backpack = { parent: 'chest', head: [0, 60, -7], tail: [0, 46, -9], limits: { x: [-10, 10] } };
    bones.shoulder_pad_f = { parent: 'upper_arm_f', head: [-14, 67, 0], tail: [-17, 63, 0] };
    bones.shoulder_pad_b = { parent: 'upper_arm_b', head: [14, 67, 0], tail: [17, 63, 0] };
    return { bones: scaleBones(bones, k), ik: structuredClone(bipedIK), height: H * k, notes: 'exosuit: humanoid bone names + backpack, shoulder_pad_f/b; faces +Z' };
  },
  /** Dog-sized quadruped (withers 26 px): legs _fl _fr _bl _br (front/back, left +X / right -X), tail chain. */
  quadruped(o) {
    const H = 32, k = Number(o.height ?? H) / H;
    const leg = (s, x, z, parent) => ({
      [`upper_${s}`]: { parent, head: [x, 22, z], limits: { x: [-80, 80] } },
      [`lower_${s}`]: { parent: `upper_${s}`, head: [x, 12, z + (s[0] === 'f' ? 1 : -2)], limits: { x: s[0] === 'f' ? [-140, 0] : [0, 140] } },
      [`paw_${s}`]: { parent: `lower_${s}`, head: [x, 2, z], tail: [x, 0, z + 3] },
    });
    const bones = {
      pelvis: { parent: null, head: [0, 24, -14], tail: [0, 25, -4] },
      spine: { parent: 'pelvis', head: [0, 25, -4] }, chest: { parent: 'spine', head: [0, 25, 8] },
      neck: { parent: 'chest', head: [0, 27, 13] }, head: { parent: 'neck', head: [0, 31, 17], tail: [0, 30, 25] },
      tail_0: { parent: 'pelvis', head: [0, 25, -17] }, tail_1: { parent: 'tail_0', head: [0, 22, -23] }, tail_2: { parent: 'tail_1', head: [0, 18, -28], tail: [0, 15, -32] },
      ...leg('fl', 5, 9, 'chest'), ...leg('fr', -5, 9, 'chest'), ...leg('bl', 5, -14, 'pelvis'), ...leg('br', -5, -14, 'pelvis'),
    };
    const ik = Object.fromEntries(['fl', 'fr', 'bl', 'br'].map((s) => [`leg_${s}`, { bones: [`upper_${s}`, `lower_${s}`, `paw_${s}`], pole: s[0] === 'f' ? [0, 0, -1] : [0, 0, 1] }]));
    return { bones: scaleBones(bones, k), ik, height: H * k, notes: 'quadruped: pelvis > spine > chest > neck > head, tail_0..2, legs upper/lower/paw_fl|fr|bl|br; faces +Z' };
  },
  /** Tentacle / cable / hose / flag edge: count bones from `from` to `to` (default hanging 32 px down from y=32). */
  chain(o) {
    const fin = (v, what, def) => {
      if (v === undefined || v === null) return def;
      const x = Number(v);
      if (typeof v === 'boolean' || !Number.isFinite(x)) throw new Error(`chain.${what} must be a finite number (got ${JSON.stringify(v)})`);
      return x;
    };
    const n = Math.max(2, Math.min(64, Math.round(fin(o.count, 'count', 8))));
    const A = o.from ? vec3(o.from, 'chain.from') : [0, fin(o.height, 'height', 32), 0];
    const B = o.to ? vec3(o.to, 'chain.to') : [A[0], A[1] - fin(o.length, 'length', fin(o.height, 'height', 32)), A[2]];
    const bones = {};
    for (let i = 0; i < n; i++) bones[`chain_${i}`] = { parent: i ? `chain_${i - 1}` : null, head: lerp3(A, B, i / n).map(r4), limits: { x: [-90, 90], y: [-90, 90], z: [-90, 90] } };
    bones.chain_tip = { parent: `chain_${n - 1}`, head: B.map(r4), tail: add(B, mul(nrm(sub(B, A)), len(sub(B, A)) / n / 2)).map(r4) };
    return { bones, ik: { chain: { bones: [...Array(n).keys()].map((i) => `chain_${i}`).concat('chain_tip') } }, height: Math.abs(A[1] - B[1]), notes: `chain: chain_0..${n - 1} + chain_tip from ${JSON.stringify(A)} to ${JSON.stringify(B)}; IK chain "chain" (CCD)` };
  },
  /** Ship landing gear (40 px): mount > strut_upper > strut_lower (slides, at:[0,dy,0]) > boot (squash with scale) > pad. */
  landing_gear(o) {
    const H = 40, k = Number(o.height ?? H) / H;
    const bones = {
      mount: { parent: null, head: [0, 40, 0], tail: [0, 37, 0] },
      strut_upper: { parent: 'mount', head: [0, 37, 0], tail: [0, 22, 0], limits: { x: [-30, 30], z: [-30, 30] } },
      strut_lower: { parent: 'strut_upper', head: [0, 22, 0], tail: [0, 9, 0] },
      boot: { parent: 'strut_lower', head: [0, 9, 0], tail: [0, 3, 0] },
      pad: { parent: 'boot', head: [0, 3, 0], tail: [0, 0, 0], limits: { x: [-25, 25], z: [-25, 25] } },
    };
    return { bones: scaleBones(bones, k), ik: {}, height: H * k, notes: 'landing_gear: mount > strut_upper > strut_lower (telescopes: at) > boot (deforming bellows: scale) > pad' };
  },
};
export const SKELETON_TEMPLATE_NAMES = Object.keys(SKELETON_TEMPLATES);

/** Roblox R15 names for the humanoid / exosuit bones (export profile:"roblox", r15:true). */
export const R15_NAMES = {
  pelvis: 'LowerTorso', torso: 'UpperTorso', chest: 'Chest', neck: 'Neck', head: 'Head',
  upper_arm_f: 'RightUpperArm', forearm_f: 'RightLowerArm', hand_f: 'RightHand', upper_arm_b: 'LeftUpperArm', forearm_b: 'LeftLowerArm', hand_b: 'LeftHand',
  thigh_f: 'RightUpperLeg', shin_f: 'RightLowerLeg', foot_f: 'RightFoot', thigh_b: 'LeftUpperLeg', shin_b: 'LeftLowerLeg', foot_b: 'LeftFoot',
};

// ---------- skeleton specs ----------
/**
 * Expand a skeleton request into a stored skeleton {template?, bones, ik, constraints, poses, clips}:
 * template (+ fit to the model bounds), bones from rigid parts (parts:true), or from an art_anim
 * library skeleton (library: <def>), then bones:{name:{..}|null} patches.
 */
export function expandSkeleton(spec, { bounds, partsRig, library } = {}) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) throw new Error('skeleton must be {template?:humanoid|exosuit|quadruped|chain|landing_gear, from_parts?, library?, bones?, ik?, constraints?, fit?}');
  let base = { bones: {}, ik: {} }, note = 'custom bones';
  if (spec.template !== undefined) {
    const t = SKELETON_TEMPLATES[spec.template];
    if (!t) throw new Error(`unknown skeleton template "${spec.template}" (${SKELETON_TEMPLATE_NAMES.join(', ')})`);
    base = t(spec);
    note = base.notes;
    if (spec.fit && bounds) {
      // scale to the model height, feet on its bottom, centred on X/Z
      const h = bounds.max[1] - bounds.min[1];
      if (h > 0) {
        const k = h / base.height, cx = (bounds.min[0] + bounds.max[0]) / 2, cz = (bounds.min[2] + bounds.max[2]) / 2;
        scaleBones(base.bones, k, [cx, bounds.min[1], cz]);
        note += `; fitted x${r4(k)} to the model (${r4(h)} px tall)`;
      }
    }
  } else if (spec.from_parts) {
    if (!partsRig) throw new Error('from_parts needs named parts (parts with name / parent = a rigid rig)');
    base = { bones: partsRig, ik: {} };
    note = `bones from ${Object.keys(partsRig).length} named parts (joint = part pivot)`;
  } else if (spec.library !== undefined) {
    if (!library) throw new Error('library: no art_anim skeleton loaded');
    base = { bones: library.bones, ik: library.ik || {} };
    note = library.notes;
  }
  const bones = structuredClone(base.bones);
  for (const [n, b] of Object.entries(spec.bones || {})) {
    if (b === null) { delete bones[n]; continue; }
    bones[n] = { ...(bones[n] || {}), ...b };
  }
  const ik = { ...structuredClone(base.ik || {}), ...(spec.ik || {}) };
  for (const [k, v] of Object.entries(ik)) if (v === null) delete ik[k];
  const out = { ...(spec.template !== undefined ? { template: spec.template } : {}), bones, ...(Object.keys(ik).length ? { ik } : {}) };
  for (const k of ['constraints', 'poses', 'clips']) if (spec[k] !== undefined && spec[k] !== null) out[k] = structuredClone(spec[k]);
  resolveSkeleton(out); // validate
  return { skeleton: out, note };
}

/**
 * Bones from a rigid rig (rigInfo of a model with named parts): joint = part pivot, rest rotation
 * = the part's rotation, tail toward the far end of the part's mesh.
 */
export function bonesFromRig(info) {
  const out = {};
  for (const n of info.nodes) {
    if (n.root) continue;
    const b = n.mesh.bounds(), c = [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
    const wc = applyP(n.R, c);
    const tail = len(wc) > 0.25 ? add(n.joint, mul(wc, 2)) : add(n.joint, [0, -4, 0]);
    const rot = eulerOfQuat(quatOfMat(n.R)).map(r4);
    out[n.name] = { parent: n.parent === info.root ? null : n.parent, head: n.joint.map(r4), tail: tail.map(r4), ...(rot.some((v) => Math.abs(v) > 1e-6) ? { rotate: rot } : {}) };
  }
  return out;
}

/** Resolved skeleton: ordered bones (parents first) with rest world / local transforms. */
export function resolveSkeleton(sk) {
  if (!sk || typeof sk.bones !== 'object' || !Object.keys(sk.bones).length) throw new Error('skeleton needs bones:{name:{parent?, head:[x,y,z]}} or a template');
  const names = Object.keys(sk.bones);
  if (names.length > 255) throw new Error(`${names.length} bones: max 255`);
  for (const n of names) if (!BONE_RE.test(n)) throw new Error(`bone name "${n}" must be 1-64 letters, digits, _ - .`);
  const raw = new Map();
  for (const n of names) {
    const b = sk.bones[n];
    if (!b || typeof b !== 'object') throw new Error(`bone "${n}" must be {parent?, head:[x,y,z], tail?, rotate?, limits?}`);
    if (b.parent !== undefined && b.parent !== null && !sk.bones[b.parent]) throw new Error(`bone "${n}": parent "${b.parent}" is not a bone (bones: ${names.join(', ')})`);
    for (const ax of Object.keys(b.limits || {})) {
      const l = b.limits[ax];
      if (!['x', 'y', 'z'].includes(ax) || !Array.isArray(l) || l.length !== 2 || !(Number(l[0]) <= Number(l[1]))) throw new Error(`bone "${n}": limits must be {x?|y?|z?:[min, max] deg}`);
    }
    raw.set(n, { name: n, parent: b.parent ?? null, head: vec3(b.head, `bone "${n}" head`), tail: b.tail ? vec3(b.tail, `bone "${n}" tail`) : null, rotate: b.rotate ? vec3(b.rotate, `bone "${n}" rotate`) : null, limits: b.limits || null });
  }
  // order: parents first; loops rejected
  const order = [], state = new Map();
  const visit = (n, path) => {
    if (state.get(n) === 2) return;
    if (state.get(n) === 1) throw new Error(`bone parents loop: ${[...path, n].join(' > ')}`);
    state.set(n, 1);
    const p = raw.get(n).parent;
    if (p) visit(p, [...path, n]);
    state.set(n, 2);
    order.push(raw.get(n));
  };
  for (const n of names) visit(n, []);
  const byName = new Map(order.map((b, i) => [b.name, Object.assign(b, { i, children: [] })]));
  for (const b of order) if (b.parent) byName.get(b.parent).children.push(b.name);
  for (const b of order) {
    if (!b.tail) {
      const c = b.children.map((x) => byName.get(x).head).filter((h) => len(sub(h, b.head)) > 1e-3);
      if (c.length === 1) b.tail = c[0];
      else if (c.length > 1) b.tail = mul(c.reduce(add), 1 / c.length);
      else { const p = b.parent ? byName.get(b.parent) : null; const d = p ? nrm(sub(b.head, p.head)) : [0, 1, 0]; b.tail = add(b.head, mul(len(d) ? d : [0, 1, 0], 4)); }
    }
    b.length = len(sub(b.tail, b.head));
    const R = b.rotate ? trsMatrix([0, 0, 0], qEuler(b.rotate), [1, 1, 1]) : IDENT;
    b.rest = matMul(mT(...b.head), R);
    b.restQ = b.rotate ? qN(qEuler(b.rotate)) : [0, 0, 0, 1];
    const P = b.parent ? byName.get(b.parent) : null;
    if (P) {
      const L = matMul(inv34(P.rest), b.rest);
      b.t = posOf(L); b.q = quatOfMat(rotOnly(L));
    } else { b.t = b.head.slice(); b.q = b.restQ.slice(); }
    b.ibm = inv34(b.rest);
  }
  const ik = {};
  for (const [n, c] of Object.entries(sk.ik || {})) {
    if (!c || !Array.isArray(c.bones) || c.bones.length < 2) throw new Error(`ik chain "${n}" needs bones:[root, ..., end] (2+ bones, each the parent of the next)`);
    for (const x of c.bones) if (!byName.has(x)) throw new Error(`ik chain "${n}": "${x}" is not a bone`);
    for (let i = 1; i < c.bones.length; i++) {
      let p = byName.get(c.bones[i]).parent, ok = false;
      for (let g = 0; p && g < 64; g++, p = byName.get(p).parent) if (p === c.bones[i - 1]) { ok = true; break; }
      if (!ok) throw new Error(`ik chain "${n}": "${c.bones[i - 1]}" is not an ancestor of "${c.bones[i]}"`);
    }
    ik[n] = { name: n, bones: c.bones.slice(), pole: c.pole ? vec3(c.pole, `ik chain "${n}" pole`) : null, orient: c.orient ?? 'fk' };
  }
  const constraints = (sk.constraints || []).map((c, i) => {
    if (!c || !['aim', 'look_at', 'copy_rotation'].includes(c.type)) throw new Error(`constraints[${i}].type must be aim | look_at | copy_rotation`);
    if (!byName.has(c.bone)) throw new Error(`constraints[${i}]: bone "${c.bone}" is not a bone`);
    if (c.type === 'copy_rotation' && !byName.has(c.from)) throw new Error(`constraints[${i}] (copy_rotation): from "${c.from}" is not a bone`);
    if (c.type !== 'copy_rotation' && c.target === undefined) throw new Error(`constraints[${i}] (${c.type}) needs target: <bone> | [x,y,z] px | <key target name>`);
    const w = Number(c.weight ?? 1);
    if (!(w >= 0 && w <= 1)) throw new Error(`constraints[${i}].weight must be 0..1`);
    return { ...c, weight: w, ...(c.axis ? { axis: nrm(vec3(c.axis, `constraints[${i}].axis`)) } : {}), ...(c.up ? { up: nrm(vec3(c.up, `constraints[${i}].up`)) } : {}) };
  });
  return { bones: order, byName, ik, constraints, poses: sk.poses || {}, clips: sk.clips || {}, spec: sk };
}

// ---------- poses / clips ----------
const EASES = ['linear', 'smooth', 'step', 'in', 'out'];
const ease = (u, k) => (k === 'step' ? (u >= 1 ? 1 : 0) : k === 'smooth' ? u * u * (3 - 2 * u) : k === 'in' ? u * u : k === 'out' ? 1 - (1 - u) * (1 - u) : u);
const clampLim = (rot, lim) => (lim ? rot.map((v, k) => { const l = lim['xyz'[k]]; return l ? Math.max(Number(l[0]), Math.min(Number(l[1]), v)) : v; }) : rot);

/** Offsets {bones|parts:{b:{rot,at,scale}}, pose?} -> Map bone -> {rot, at, scale} (limits applied to rot). */
export function boneOffsets(S, key = {}, where = 'pose') {
  const out = new Map();
  const put = (parts, w) => {
    if (parts === undefined || parts === null) return;
    if (typeof parts !== 'object' || Array.isArray(parts)) throw new Error(`${w}: bones must be {<bone>: {rot?:[x,y,z] deg, at?:[dx,dy,dz] px, scale?}}`);
    for (const [n, o] of Object.entries(parts)) {
      const b = S.byName.get(n);
      if (!b) throw new Error(`${w}: "${n}" is not a bone (bones: ${S.bones.map((x) => x.name).join(', ')})`);
      if (o === null) { out.delete(n); continue; }
      if (typeof o !== 'object') throw new Error(`${w}: ${n} must be {rot?, at?, scale?}`);
      for (const k of Object.keys(o)) if (!['rot', 'at', 'scale'].includes(k)) throw new Error(`${w}: ${n}.${k} is not a pose field (rot:[x,y,z] deg, at:[dx,dy,dz] px, scale)`);
      const v = (x, d, nm) => (x === undefined || x === null ? [d, d, d] : typeof x === 'number' ? [x, x, x] : vec3(x, `${n}.${nm}`));
      out.set(n, { rot: clampLim(v(o.rot, 0, 'rot'), b.limits), at: v(o.at, 0, 'at'), scale: v(o.scale, 1, 'scale') });
    }
  };
  if (key.pose !== undefined && key.pose !== null && key.pose !== 'rest') {
    const p = S.poses[key.pose];
    if (!p) throw new Error(`${where}: unknown skeleton pose "${key.pose}" (poses: ${Object.keys(S.poses).join(', ') || 'none'})`);
    put(p.bones ?? p.parts, `pose "${key.pose}"`);
  }
  put(key.bones ?? key.parts, where);
  return out;
}
const localOf = (b, o) => (o ? { t: add(b.t, o.at), q: o.rot.some((v) => v) ? qN(qMul(b.q, qEuler(o.rot))) : b.q.slice(), s: o.scale.slice() } : { t: b.t.slice(), q: b.q.slice(), s: [1, 1, 1] });

/** Validated clip -> {keys:[{t, ease, local: Map bone -> TRS, morphs, ik, targets}], duration, loop, events, plant}. */
export function skelClipKeys(S, clip, morphNames = []) {
  if (!clip || !Array.isArray(clip.keys) || !clip.keys.length) throw new Error('clip needs keys: [{t (s), bones?:{<bone>:{rot,at,scale}}, pose?, morphs?:{<shape>:w}, ik?:{<chain>:{target, weight?}}, targets?:{<name>:[x,y,z]}, ease?}]');
  const keys = clip.keys.map((k, i) => {
    if (!k || typeof k !== 'object') throw new Error(`key ${i} must be an object`);
    const t = k.t === undefined && i === 0 ? 0 : Number(k.t);
    if (!Number.isFinite(t) || t < 0) throw new Error(`key ${i}: t must be seconds >= 0`);
    const e = k.ease ?? clip.ease ?? 'linear';
    if (!EASES.includes(e)) throw new Error(`key ${i}: ease must be ${EASES.join('|')}`);
    const off = boneOffsets(S, k, `key ${i}`);
    const local = new Map(S.bones.map((b) => [b.name, localOf(b, off.get(b.name))]));
    const morphs = {};
    for (const [n, w] of Object.entries(k.morphs || {})) {
      if (!morphNames.includes(n)) throw new Error(`key ${i}: morph "${n}" is not a shape of this skin (shapes: ${morphNames.join(', ') || 'none'})`);
      if (!(Number(w) >= -1 && Number(w) <= 2)) throw new Error(`key ${i}: morph ${n} weight must be a number (0..1)`);
      morphs[n] = Number(w);
    }
    const ik = {};
    for (const [n, s] of Object.entries(k.ik || {})) {
      if (!S.ik[n]) throw new Error(`key ${i}: "${n}" is not an ik chain (chains: ${Object.keys(S.ik).join(', ') || 'none'})`);
      if (s === null) continue;
      const tg = s.target ?? s;
      let target;
      if (Array.isArray(tg)) target = { p: vec3(tg, `key ${i} ik.${n}.target`) };
      else if (tg && tg.bone) { if (!S.byName.has(tg.bone)) throw new Error(`key ${i}: ik.${n}.target.bone "${tg.bone}" is not a bone`); target = { bone: tg.bone, at: tg.at ? vec3(tg.at, 'at') : [0, 0, 0] }; }
      else throw new Error(`key ${i}: ik.${n} needs target:[x,y,z] (model px) | {bone, at?}`);
      ik[n] = { ...target, weight: Number(s.weight ?? 1), ...(s.pole ? { pole: vec3(s.pole, 'pole') } : {}) };
    }
    const targets = {};
    for (const [n, p] of Object.entries(k.targets || {})) targets[n] = vec3(p, `key ${i} targets.${n}`);
    return { t, ease: e, local, morphs, ik, targets };
  });
  for (let i = 1; i < keys.length; i++) if (!(keys[i].t > keys[i - 1].t)) throw new Error(`key ${i}: t must be greater than key ${i - 1}'s (strictly increasing seconds)`);
  const last = keys[keys.length - 1].t;
  const duration = clip.duration !== undefined ? Number(clip.duration) : last;
  if (!(duration >= last)) throw new Error(`duration ${clip.duration} is shorter than the last key (t ${last})`);
  if (clip.loop && duration > last + 1e-9) keys.push({ ...keys[0], t: duration, ease: clip.close_ease ?? 'linear', closing: true });
  const events = (clip.events || []).map((ev) => {
    if (!ev || typeof ev.name !== 'string' || !Number.isFinite(Number(ev.t))) throw new Error('events must be [{t (seconds), name}]');
    if (Number(ev.t) < 0 || Number(ev.t) > duration + 1e-9) throw new Error(`event "${ev.name}" at ${ev.t}s is outside the clip (0..${duration}s)`);
    return { t: Number(ev.t), name: ev.name };
  }).sort((a, b) => a.t - b.t);
  let plant = null;
  if (clip.plant) {
    const p = clip.plant === true ? {} : clip.plant;
    const chains = p.chains || Object.keys(S.ik).filter((c) => /^leg/.test(c));
    for (const c of chains) if (!S.ik[c]) throw new Error(`plant: "${c}" is not an ik chain`);
    plant = { chains, ground: p.ground !== undefined ? Number(p.ground) : null, threshold: Number(p.threshold ?? 0.75) };
  }
  return { keys, duration, loop: !!clip.loop, events, plant, fps: clip.fps };
}

/** Pose state at time t: local TRS per bone + morph weights + IK goals + named targets. */
export function sampleSkelClip(S, ck, time) {
  const { keys } = ck;
  let i = keys.length - 1;
  while (i > 0 && keys[i].t > time + 1e-9) i--;
  const a = keys[i], b = i + 1 < keys.length ? keys[i + 1] : a;
  const span = b.t - a.t, u = span > 0 ? ease(Math.max(0, Math.min(1, (time - a.t) / span)), b.ease) : 0;
  const local = new Map();
  for (const bone of S.bones) {
    const A = a.local.get(bone.name), B = b.local.get(bone.name);
    local.set(bone.name, u === 0 ? A : { t: lerp3(A.t, B.t, u), q: u === 1 ? B.q : qSlerp(A.q, B.q, u), s: lerp3(A.s, B.s, u) });
  }
  const morphs = {};
  for (const n of new Set([...Object.keys(a.morphs), ...Object.keys(b.morphs)])) morphs[n] = (a.morphs[n] ?? 0) + ((b.morphs[n] ?? 0) - (a.morphs[n] ?? 0)) * u;
  const ik = {};
  for (const n of new Set([...Object.keys(a.ik), ...Object.keys(b.ik)])) {
    const A = a.ik[n], B = b.ik[n];
    const base = A || B, other = B || A;
    ik[n] = { ...base, weight: (A ? A.weight : 0) + ((B ? B.weight : 0) - (A ? A.weight : 0)) * u };
    if (base.p && other.p) ik[n].p = lerp3(base.p, other.p, A && B ? u : 0);
    if (base.bone && other.bone && base.bone === other.bone) ik[n].at = lerp3(base.at, other.at, A && B ? u : 0);
  }
  const targets = {};
  for (const n of new Set([...Object.keys(a.targets), ...Object.keys(b.targets)])) targets[n] = a.targets[n] && b.targets[n] ? lerp3(a.targets[n], b.targets[n], u) : a.targets[n] || b.targets[n];
  return { local, morphs, ik, targets, plant: ck.plant };
}
/** Static pose state (a stored pose / bones offsets). */
export function poseState(S, key = {}, morphs = {}) {
  const off = boneOffsets(S, key);
  return { local: new Map(S.bones.map((b) => [b.name, localOf(b, off.get(b.name))])), morphs: { ...morphs }, ik: {}, targets: {} };
}

// ---------- solver ----------
function worldAll(S, local, pre) {
  const W = new Map();
  for (const b of S.bones) {
    const L = local.get(b.name);
    const M = trsMatrix(L.t, L.q, L.s);
    W.set(b.name, b.parent ? matMul(W.get(b.parent), M) : pre ? matMul(pre, M) : M);
  }
  return W;
}
const worldQ = (W, n) => quatOfMat(rotOnly(W.get(n)));
/** Rotate bone n by a world-space delta (keeps its children attached). */
function applyWorldDelta(S, local, W, n, delta) {
  const b = S.byName.get(n);
  const pq = b.parent ? worldQ(W, b.parent) : [0, 0, 0, 1];
  const nq = qN(qMul(delta, worldQ(W, n)));
  const L = local.get(n);
  let q = qN(qMul(qConj(pq), nq));
  if (b.limits) {
    const e = clampLim(eulerOfQuat(qMul(qConj(b.q), q)), b.limits);
    q = qN(qMul(b.q, qEuler(e)));
  }
  local.set(n, { ...L, q });
}
function solveChain(S, local, pre, chain, goal) {
  let W = worldAll(S, local, pre);
  const bones = chain.bones, end = bones[bones.length - 1];
  const keepQ = chain.orient === 'fk' ? worldQ(W, end) : null;
  const P = (n) => posOf(W.get(n));
  const T = goal.p;
  if (bones.length === 3) {
    // analytic two-bone with pole
    const [a, b] = bones;
    const A = P(a), B = P(b), C = P(end);
    const la = len(sub(B, A)), lb = len(sub(C, B));
    const toT = sub(T, A), dist = Math.max(Math.abs(la - lb) + 1e-4, Math.min(la + lb - 1e-4, len(toT)));
    const dir = len(toT) > 1e-9 ? nrm(toT) : nrm(sub(C, A));
    let pole = goal.pole || chain.pole;
    let bend = pole ? sub(pole, mul(dir, dot(pole, dir))) : sub(sub(B, A), mul(dir, dot(sub(B, A), dir)));
    if (len(bend) < 1e-6) bend = cross(dir, [1, 0, 0]);
    if (len(bend) < 1e-6) bend = cross(dir, [0, 0, 1]);
    bend = nrm(bend);
    const cosA = Math.max(-1, Math.min(1, (la * la + dist * dist - lb * lb) / (2 * la * dist)));
    const B2 = add(A, mul(add(mul(dir, cosA), mul(bend, Math.sqrt(1 - cosA * cosA))), la));
    applyWorldDelta(S, local, W, a, qFromTo(sub(B, A), sub(B2, A)));
    W = worldAll(S, local, pre);
    const Bn = posOf(W.get(b)), Cn = posOf(W.get(end));
    applyWorldDelta(S, local, W, b, qFromTo(sub(Cn, Bn), sub(add(A, mul(dir, dist)), Bn)));
  } else {
    // CCD
    for (let it = 0; it < 24; it++) {
      for (let j = bones.length - 2; j >= 0; j--) {
        const J = posOf(W.get(bones[j])), E = posOf(W.get(end));
        if (len(sub(E, J)) < 1e-6 || len(sub(T, J)) < 1e-6) continue;
        applyWorldDelta(S, local, W, bones[j], qFromTo(sub(E, J), sub(T, J)));
        W = worldAll(S, local, pre);
      }
      if (len(sub(posOf(W.get(end)), T)) < 0.01) break;
    }
  }
  if (keepQ) { W = worldAll(S, local, pre); applyWorldDelta(S, local, W, end, qMul(keepQ, qConj(worldQ(W, end)))); }
}

/**
 * Solve a pose state: FK, IK (key goals, then clip foot planting), constraints. pre = 3x4 applied
 * above the root (render angles). -> {world: Map bone -> 3x4, skin: Map bone -> world * inverseBind,
 * local (solved), morphs (with driven correctives filled in by the caller), ik: {chain: miss px}}
 */
export function solvePoseState(S, state, { pre = null, drivers = [] } = {}) {
  const local = new Map([...state.local].map(([k, v]) => [k, { t: v.t.slice(), q: v.q.slice(), s: v.s.slice() }]));
  // everything is solved in model space; pre (render angle) is applied to the result
  let W = worldAll(S, local, null);
  const miss = {};
  const goals = [];
  for (const [n, g] of Object.entries(state.ik || {})) {
    if (!(g.weight > 0)) continue;
    const chain = S.ik[n], end = chain.bones[chain.bones.length - 1];
    let p = g.p ? g.p : applyP(W.get(g.bone), g.at);
    if (g.weight < 1) p = lerp3(posOf(W.get(end)), p, g.weight);
    goals.push([chain, { p, pole: g.pole }]);
  }
  for (const [chain, goal] of goals) solveChain(S, local, null, chain, goal);
  if (goals.length) W = worldAll(S, local, null);
  if (state.plant) {
    // feet plant: an effector below (ground + threshold) is held on the ground; IK bends the knee
    for (const c of state.plant.chains) {
      const chain = S.ik[c], end = chain.bones[chain.bones.length - 1];
      const ground = state.plant.ground ?? S.byName.get(end).head[1];
      const E = posOf(W.get(end));
      if (E[1] < ground + state.plant.threshold) {
        solveChain(S, local, null, chain, { p: [E[0], ground, E[2]] });
        W = worldAll(S, local, null);
      }
    }
  }
  for (const [chain, goal] of goals) miss[chain.name] = r4(len(sub(posOf(W.get(chain.bones[chain.bones.length - 1])), goal.p)));
  // constraints, in order
  for (const c of S.constraints) {
    const w = c.weight;
    if (!(w > 0)) continue;
    if (c.type === 'copy_rotation') {
      const src = S.byName.get(c.from), dst = S.byName.get(c.bone);
      const d = qMul(qConj(src.q), local.get(c.from).q);
      let e = eulerOfQuat(d);
      if (c.axes) e = e.map((v, k) => (c.axes.includes('xyz'[k]) ? v : 0));
      if (c.invert) e = e.map((v, k) => (c.invert.includes('xyz'[k]) ? -v : v));
      const base = c.mix === 'add' ? local.get(c.bone).q : dst.q;
      const target = qN(qMul(base, qEuler(e.map((v) => v * w))));
      local.set(c.bone, { ...local.get(c.bone), q: target });
    } else {
      const tp = typeof c.target === 'string' ? (S.byName.has(c.target) ? posOf(W.get(c.target)) : state.targets?.[c.target] || null) : vec3(c.target, 'target');
      if (!tp) continue; // a key target that this clip does not set
      const b = S.byName.get(c.bone), M = W.get(c.bone), H = posOf(M);
      const wq = worldQ(W, c.bone);
      const axisL = c.axis || nrm(qRot(qConj(b.restQ), sub(b.tail, b.head)));
      const cur = qRot(wq, axisL), want = sub(tp, H);
      if (len(want) < 1e-6) continue;
      let delta = qFromTo(cur, want);
      if (c.type === 'look_at') {
        // keep the bone's up axis as close to world up as the aim allows (no roll)
        const upL = c.up || [0, 1, 0], wUp = c.world_up ? nrm(vec3(c.world_up, 'world_up')) : [0, 1, 0];
        const nq = qMul(delta, wq), f = nrm(want), u = qRot(nq, upL);
        const pu = nrm(sub(u, mul(f, dot(u, f)))), pw = nrm(sub(wUp, mul(f, dot(wUp, f))));
        if (len(pu) > 0.5 && len(pw) > 0.5) { const ang = Math.atan2(dot(cross(pu, pw), f), dot(pu, pw)); const h = ang / 2; delta = qMul([f[0] * Math.sin(h), f[1] * Math.sin(h), f[2] * Math.sin(h), Math.cos(h)], delta); }
      }
      if (w < 1) delta = qSlerp([0, 0, 0, 1], delta, w);
      applyWorldDelta(S, local, W, c.bone, delta);
    }
    W = worldAll(S, local, null);
  }
  if (pre) for (const [k, M] of W) W.set(k, matMul(pre, M));
  const skin = new Map(S.bones.map((b) => [b.name, matMul(W.get(b.name), b.ibm)]));
  // driven shapes (correctives): weight from a bone's local rotation about one axis
  const morphs = { ...(state.morphs || {}) };
  for (const d of drivers) {
    const b = S.byName.get(d.bone);
    const e = eulerOfQuat(qMul(qConj(b.q), local.get(d.bone).q))['xyz'.indexOf(d.axis)];
    const span = d.to - d.from;
    morphs[d.name] = Math.max(0, Math.min(1, span ? (e - d.from) / span : 0)) * (d.weight ?? 1);
  }
  return { world: W, skin, local, morphs, ik: miss };
}

// ---------- art_anim library -> 3D ----------
/**
 * 3D bones from an art_anim library skeleton (rig def): side view gives depth (z) and height,
 * the front view gives width (x). height = px tall of the 3D skeleton.
 */
export function bonesFromLibrary(rig, solvePose, { height = 58 } = {}) {
  const side = rig.views.includes('side') ? 'side' : rig.views[0];
  const front = rig.views.includes('front') ? 'front' : null;
  const Ws = solvePose(rig, {}, side).world, Wf = front ? solvePose(rig, {}, front).world : null;
  const names = rig.order;
  const ys = names.map((n) => Ws[n].y);
  const ground = Math.max(...names.map((n) => Ws[n].y + (rig.parts[n].h ?? 0) - (rig.parts[n].pivot?.[1] ?? 0)));
  const top = Math.min(...ys.map((y, i) => y - (rig.parts[names[i]].pivot?.[1] ?? 0)));
  const k = height / Math.max(1, ground - top);
  const [rx] = rig.root;
  const bones = {};
  for (const n of names) {
    const p = rig.parts[n];
    const z = (Ws[n].x - rx) * k, y = (ground - Ws[n].y) * k;
    // front view: the character faces the camera, so screen right = its left = +X
    let x = Wf ? (Wf[n].x - rx) * k : 0;
    if (!Wf && /_f$/.test(n)) x = -3 * k; else if (!Wf && /_b$/.test(n)) x = 3 * k;
    if (Wf && /_f$/.test(n) && x > 0) x = -x; // keep _f on the right (-X) side
    const down = ((p.h ?? 4) - (p.pivot?.[1] ?? 0)) * k;
    bones[n] = { parent: p.parent ?? null, head: [x, y, z].map(r4), tail: [x, y - Math.max(1, down * 0.8), z].map(r4) };
  }
  const ik = {};
  for (const s of ['f', 'b']) {
    if (bones[`thigh_${s}`] && bones[`shin_${s}`] && bones[`foot_${s}`]) ik[`leg_${s}`] = { bones: [`thigh_${s}`, `shin_${s}`, `foot_${s}`], pole: [0, 0, 1] };
    if (bones[`upper_arm_${s}`] && bones[`forearm_${s}`] && bones[`hand_${s}`]) ik[`arm_${s}`] = { bones: [`upper_arm_${s}`, `forearm_${s}`, `hand_${s}`], pole: [0, 0, -1] };
  }
  return { bones, ik, notes: `bones from the art_anim skeleton (${names.length} parts, side view = depth, ${front ? 'front view = width' : 'no front view: _f/_b offset 3 px'}), ${r4(k)} 3D px per 2D px` };
}

/**
 * Retarget an evaluated art_anim clip (2D frames) onto a 3D skeleton by bone name: each 2D part's
 * rotation relative to its (mapped) parent becomes a rotation about the bone's X axis (the 2D side
 * view is the Y-Z plane, character facing +Z), the root part's translation moves the root bone,
 * scaled by the leg-length ratio. -> {clip: {keys, loop, duration, events}, mapped, dropped, k}
 */
export function retargetFrom2D(S, rig, solvePose, ev, { map = {}, view = 'side', scale } = {}) {
  const fps = Number(ev.fps || 10), n = ev.poses.length;
  const to3 = (n2) => map[n2] ?? n2;
  const mapped = rig.order.filter((n2) => S.byName.has(to3(n2)));
  const dropped = rig.order.filter((n2) => !S.byName.has(to3(n2)));
  if (!mapped.length) throw new Error(`retarget: no 2D part maps to a bone (2D parts: ${rig.order.join(', ')}; map:{<2D part>:<bone>})`);
  const from3 = new Map(mapped.map((n2) => [to3(n2), n2]));
  const rest = solvePose(rig, {}, view).world;
  // nearest mapped 2D ancestor of a 3D bone (so extra 3D bones in between keep the chain right)
  const parent2 = (b3) => { for (let p = S.byName.get(b3).parent; p; p = S.byName.get(p).parent) if (from3.has(p)) return from3.get(p); return null; };
  // leg-length ratio (3D px per 2D px)
  let k = Number(scale);
  if (!(k > 0)) {
    const leg2 = ['thigh_f', 'shin_f', 'foot_f'].every((x) => rest[x]) ? Math.hypot(rest.foot_f.x - rest.thigh_f.x, rest.foot_f.y - rest.thigh_f.y) : 0;
    const L = ['thigh_f', 'shin_f', 'foot_f'].map(to3);
    const leg3 = L.every((x) => S.byName.has(x)) ? len(sub(S.byName.get(L[2]).head, S.byName.get(L[0]).head)) : 0;
    k = leg2 > 0 && leg3 > 0 ? leg3 / leg2 : 1;
  }
  const roots2 = mapped.filter((n2) => !rig.parts[n2].parent);
  const keys = [];
  for (let f = 0; f < n; f++) {
    const W = solvePose(rig, ev.poses[f], view).world;
    const bones = {};
    for (const n2 of mapped) {
      const b3 = to3(n2), b = S.byName.get(b3), p2 = parent2(b3);
      const rot2 = (W[n2].rot - (p2 ? W[p2].rot : 0)) - (rest[n2].rot - (p2 ? rest[p2].rot : 0));
      const o = {};
      if (Math.abs(rot2) > 1e-4) {
        // world-axis rotation about X, expressed in the bone's rest frame
        const qx = [Math.sin((rot2 * D2R) / 2), 0, 0, Math.cos((rot2 * D2R) / 2)];
        const e = b.rotate ? eulerOfQuat(qMul(qMul(qConj(b.restQ), qx), b.restQ)) : [rot2, 0, 0];
        o.rot = e.map(r4);
      }
      if (roots2.includes(n2) && !b.parent) {
        const dx = (W[n2].x - rest[n2].x) * k, dy = (W[n2].y - rest[n2].y) * k;
        if (Math.abs(dx) > 1e-4 || Math.abs(dy) > 1e-4) o.at = [0, r4(-dy), r4(dx)];
      }
      if (Object.keys(o).length) bones[b3] = o;
    }
    keys.push({ t: r4(f / fps), bones });
  }
  const loop = ev.loop !== false;
  const duration = r4(loop ? n / fps : Math.max(0, n - 1) / fps);
  const events = (ev.events || []).map((e) => ({ t: r4(e.frame !== undefined ? e.frame / fps : Math.min(1, Number(e.t ?? 0)) * duration), name: e.name })).filter((e) => e.t <= duration);
  return { clip: { keys, loop, duration, ...(events.length ? { events } : {}), fps }, mapped: mapped.map((n2) => (to3(n2) === n2 ? n2 : `${n2}->${to3(n2)}`)), dropped, k: r4(k) };
}
