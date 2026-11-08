// First-person arms: a 3D skeleton in eye space (clavicle > upper arm > forearm > hand > finger
// chains: thumb, index, and middle+ring+pinky grouped, both sides) solved with two-bone IK onto
// hand targets, then drawn as 2D part sprites. Every bone's sprite is rendered once per view
// bucket (how the camera sees the bone: tilt to the bone axis, azimuth around it), light bucket
// and scale bucket from a small signed-distance model of the part with painted shading, then
// placed with RotSprite rotation at its projected joint. Same bucket -> the same pixels, so a
// still arm never shimmers and every colour comes from the skin's ramps.
import { F, LIGHT, FRAME, CENTRE, add, sub, mul, dot, cross, norm, len, col, fromCols, project, clamp } from './fp.js';
import { paint, MAT, drawRot } from './fppaint.js';

const D2R = Math.PI / 180, R2D = 180 / Math.PI;
export const NEAR_BONE = 12;

/** Bone lengths and radii (cm). */
export const ARM = { upper: 30, fore: 29, palm: 9, palmW: 8.4, palmT: 3.0, r_upper: [5.4, 4.6], r_fore: [4.4, 3.2], finger: [4.6, 4.0], thumb: [4.2, 3.4] };
/** Shoulder joints in eye space (the viewmodel sits the shoulders a little ahead of the eye). */
export const SHOULDER = { r: [16, -27, 5], l: [-15, -22, -13] };
const POLE = { r: [0.35, -1, 0.45], l: [-0.6, -1, 0.2] };

/**
 * Finger presets: index and grouped fingers [base, middle] curl (deg toward the palm), thumb
 * [abduction, flex, tip]. Blended per frame between keys.
 */
export const FINGERS = {
  relaxed: { index: [18, 24], group: [24, 30], thumb: [35, 15, 10] },
  trigger: { index: [32, 38], group: [84, 96], thumb: [28, 55, 30] },
  trigger_off: { index: [4, 6], group: [84, 96], thumb: [28, 55, 30] },
  support_under: { index: [52, 46], group: [58, 52], thumb: [48, 22, 14] },
  vgrip: { index: [86, 92], group: [90, 96], thumb: [24, 62, 32] },
  agrip: { index: [24, 20], group: [30, 26], thumb: [56, 18, 10] },
  mag_grasp: { index: [46, 40], group: [62, 56], thumb: [42, 30, 20] },
  pinch: { index: [56, 62], group: [96, 102], thumb: [20, 46, 26] },
  pistol_cup: { index: [42, 46], group: [46, 46], thumb: [16, 10, 6] },
  knife_hammer: { index: [92, 96], group: [96, 102], thumb: [30, 70, 40] },
  grenade_hold: { index: [42, 36], group: [48, 42], thumb: [42, 30, 20] },
  pin_pull: { index: [100, 100], group: [96, 106], thumb: [26, 40, 20] },
  open_palm: { index: [0, 0], group: [0, 0], thumb: [52, 0, 0] },
  fist: { index: [96, 106], group: [100, 110], thumb: [20, 80, 50] },
  flat_touch: { index: [6, 4], group: [40, 50], thumb: [30, 20, 10] },
};
export function blendFingers(a, b, t) {
  const A = FINGERS[a] || a, B = FINGERS[b] || b;
  const l = (x, y) => x.map((v, i) => v + (y[i] - v) * t);
  return { index: l(A.index, B.index), group: l(A.group, B.group), thumb: l(A.thumb, B.thumb) };
}

/** Skins: material per region (swappable; never re-animated). */
export const SKINS = {
  mec: { sleeve: MAT.mec_sleeve, cuff: MAT.mec_cuff, bracer: MAT.mec_plate, glove: MAT.mec_glove, knuckle: MAT.mec_knuckle, tip: MAT.mec_glove, mark: MAT.mec_mark },
  severance: { sleeve: MAT.sev_sleeve, cuff: MAT.sev_wrap, bracer: MAT.sev_plate, glove: MAT.sev_glove, knuckle: MAT.sev_plate, tip: MAT.skin, wrap: MAT.sev_wrap },
};

// ---------- pose solve ----------
/** Two-bone IK: shoulder S, target wrist T, pole -> {E (elbow), W (wrist), reach (0..1+), clamped}. */
export function twoBone(S, T, L1, L2, pole) {
  const d0 = sub(T, S), dist0 = len(d0), u = norm(d0);
  const max = (L1 + L2) * 0.999, dist = Math.min(dist0, max), min = Math.abs(L1 - L2) + 0.5;
  const dd = Math.max(min, dist);
  const a = Math.acos(clamp((L1 * L1 + dd * dd - L2 * L2) / (2 * L1 * dd), -1, 1));
  const v = norm(sub(pole, mul(u, dot(pole, u))));
  const E = add(S, mul(add(mul(u, Math.cos(a)), mul(v, Math.sin(a))), L1));
  const W = add(S, mul(u, dd));
  return { E, W, reach: dist0 / (L1 + L2), clamped: dist0 > max };
}

/** Hand frame from fingers direction + back-of-hand direction (eye space): columns s, d, b. */
export function handFrame(fingers, dorsal) {
  const b = norm(mul(fingers, -1));
  const d = norm(sub(dorsal, mul(b, dot(dorsal, b))));
  return fromCols(cross(d, b), d, b);
}

/**
 * Solve one arm: side r|l, palm centre target P (eye), hand frame R (columns s, d, b), finger
 * preset values, clavicle offset. -> bones [{name, A, B, frame, kind}] + metrics.
 */
export function solveArm(side, P, R, fingers, opts = {}) {
  const S = add(SHOULDER[side], opts.clavicle || [0, 0, 0]);
  const s = col(R, 0), d = col(R, 1), b = col(R, 2);
  const W = add(P, mul(b, ARM.palm / 2)); // wrist: half a palm back from the palm centre
  const ik = twoBone(S, W, ARM.upper, ARM.fore, opts.pole || POLE[side]);
  const Wr = ik.W, shift = sub(Wr, W); // a clamped reach moves the whole hand short of its target
  const Pr = add(P, shift);
  const bones = [];
  const frameAlong = (A, B, up) => { const ax = norm(sub(B, A)); const zz = norm(sub(up, mul(ax, dot(up, ax)))); return fromCols(cross(ax, zz), ax, zz); };
  // limb frames: local y along the bone, z toward the back of the hand / outside of the arm
  const out = side === 'r' ? [1, 0.2, 0] : [-1, 0.2, 0];
  bones.push({ name: `upper_${side}`, kind: 'upper', side, A: S, B: ik.E, frame: frameAlong(S, ik.E, out) });
  bones.push({ name: `fore_${side}`, kind: 'fore', side, A: ik.E, B: Wr, frame: frameAlong(ik.E, Wr, d) });
  const K = add(Wr, mul(b, -ARM.palm));
  bones.push({ name: `palm_${side}`, kind: 'palm', side, A: Wr, B: K, frame: fromCols(s, mul(b, -1), d) });
  // fingers: curl rotates the segment from -b toward -d (the palm side) about s
  const tau = side === 'r' ? -1 : 1; // thumb side along s
  const f = fingers || FINGERS.relaxed;
  const chain = (name, base, curls, lens, lat = 0) => {
    let A = base, ang = 0;
    curls.forEach((c, i) => {
      ang += c;
      const dir = norm(add(add(mul(b, -Math.cos(ang * D2R)), mul(d, -Math.sin(ang * D2R))), mul(s, lat)));
      const B = add(A, mul(dir, lens[i]));
      bones.push({ name: `${name}${i}_${side}`, kind: name === 'group' ? `group${i}` : `finger${i}`, side, A, B, frame: frameAlong(A, B, add(mul(d, Math.cos(ang * D2R)), mul(b, -Math.sin(ang * D2R)))) });
      A = B;
    });
    return A;
  };
  const tipI = chain('index', add(add(K, mul(s, tau * 2.6)), mul(d, -0.2)), f.index, ARM.finger, tau * 0.04);
  const tipG = chain('group', add(add(K, mul(s, -tau * 1.3)), mul(d, -0.3)), f.group, ARM.finger, -tau * 0.02);
  // thumb: from the base of the palm, abducted toward tau*s, flexing toward the palm and across it
  const [abd, f1, f2] = f.thumb;
  const T0 = add(add(add(Wr, mul(b, -2.2)), mul(s, tau * 3.4)), mul(d, -1.0));
  let A = T0, ang = 0;
  const base = norm(add(mul(b, -Math.cos(abd * D2R)), mul(s, tau * Math.sin(abd * D2R))));
  [f1, f2].forEach((c, i) => {
    ang += c;
    const across = mul(s, -tau * Math.sin(ang * D2R) * 0.55);
    const dir = norm(add(add(mul(base, Math.cos(ang * D2R)), mul(d, -Math.sin(ang * D2R) * 0.85)), across));
    const B = add(A, mul(dir, ARM.thumb[i]));
    bones.push({ name: `thumb${i}_${side}`, kind: `thumb${i}`, side, A, B, frame: frameAlong(A, B, d) });
    A = B;
  });
  return { bones, palm: Pr, wrist: Wr, elbow: ik.E, reach: ik.reach, clamped: ik.clamped, miss: len(shift), tips: { index: tipI, group: tipG, thumb: A } };
}

// ---------- part shapes (signed distance, part local: y along the bone, z = outside / back) ----------
const sdCapsule = (p, L, r0, r1) => { const t = clamp(p[1] / L, 0, 1); return Math.hypot(p[0], p[1] - t * L, p[2]) - (r0 + (r1 - r0) * t); };
const sdRoundBox = (p, c, h, r) => { const q = [Math.abs(p[0] - c[0]) - h[0], Math.abs(p[1] - c[1]) - h[1], Math.abs(p[2] - c[2]) - h[2]]; return Math.hypot(Math.max(q[0], 0), Math.max(q[1], 0), Math.max(q[2], 0)) + Math.min(Math.max(q[0], q[1], q[2]), 0) - r; };

/** Part model: {L, bound radius, sdf(p) -> [dist, material]} per bone kind and skin. */
export function partShape(kind, skin) {
  const K = SKINS[skin] || skin;
  switch (kind) {
    case 'upper': {
      const L = ARM.upper, [r0, r1] = ARM.r_upper;
      return { L, R: r0 + 1, sdf: (p) => {
        // sleeve with fold rings
        const fold = 0.25 * Math.sin(p[1] * 1.3) * (p[2] > -1 ? 1 : 0.5);
        return [sdCapsule(p, L, r0, r1) - fold, K.sleeve];
      } };
    }
    case 'fore': {
      const L = ARM.fore, [r0, r1] = ARM.r_fore;
      return { L, R: r0 + 1.6, sdf: (p) => {
        let d = sdCapsule(p, L, r0, r1), m = p[1] > L - 4.5 ? K.cuff : K.sleeve;
        if (p[1] < L - 4.5) d -= 0.22 * Math.sin(p[1] * 1.1 + p[0] * 0.6);
        // armour bracer on the outside of the forearm
        const br = sdRoundBox(p, [0, L * 0.55, r0 * 0.55], [r0 * 0.75, L * 0.24, 1.0], 0.5);
        if (br < d) { d = br; m = K.bracer; }
        if (K.wrap) { const band = Math.abs(((p[1] + 50) % 3.2) - 1.6) < 0.5 && p[1] > L * 0.2 && p[1] < L * 0.85; if (band && d < 0.4) { d -= 0.2; m = K.wrap; } }
        // glove cuff ring
        const cuff = sdCapsule([p[0], p[1] - (L - 2.4), p[2]], 2.6, r1 + 0.55, r1 + 0.35);
        if (cuff < d) { d = cuff; m = K.glove; }
        return [d, m];
      } };
    }
    case 'palm': {
      const L = ARM.palm, w = ARM.palmW / 2, t = ARM.palmT / 2;
      return { L, R: w + 1.2, sdf: (p) => {
        let d = sdRoundBox(p, [0, L / 2, 0], [w - 1, L / 2 - 1, t - 0.6], 1.0), m = K.glove;
        // knuckle armour across the back of the hand
        const kn = sdRoundBox(p, [0, L - 1.6, t + 0.2], [w - 1.2, 1.1, 0.45], 0.35);
        if (kn < d) { d = kn; m = K.knuckle; }
        const thenar = sdCapsule([p[0] + (skin === 'l' ? 0 : 0), p[1] - 1.5, p[2] + 0.6], 5, 1.8, 1.3);
        if (thenar < d) { d = thenar; m = K.glove; }
        return [d, m];
      } };
    }
    default: {
      // finger / thumb segments (group = three fingers side by side)
      const group = kind.startsWith('group'), i = Number(kind.slice(-1)), thumb = kind.startsWith('thumb');
      const L = thumb ? ARM.thumb[i] : ARM.finger[i], r = thumb ? 1.25 - i * 0.12 : group ? 1.05 : 1.0 - i * 0.08;
      const tipMat = i === 1 ? K.tip : K.glove;
      if (!group) return { L, R: r + 0.6, sdf: (p) => [sdCapsule(p, L, r, r * 0.9), p[1] > L * 0.45 && i === 1 ? tipMat : K.glove] };
      return { L, R: 3.6, sdf: (p) => {
        let best = Infinity;
        for (const [x, k] of [[1.9, 1], [0, 1.04], [-1.9, 0.86]]) best = Math.min(best, sdCapsule([p[0] - x, p[1], p[2]], L * k, r, r * 0.9));
        return [best, p[1] > L * 0.45 && i === 1 ? tipMat : K.glove];
      } };
    }
  }
}

// ---------- part sprites ----------
const CACHE = new Map();
let cachePx = 0;
const CACHE_PX = 24e6;
const q = (v, s) => Math.round(v / s) * s;
/**
 * Sprite of a part seen from bLocal (unit vector toward the camera in part space) at `scale` px per
 * cm, lit by light (camera space: x right, y up, z toward the viewer). Canonical orientation: the
 * bone axis points to +x on screen; the joint (part origin) is at the anchor.
 */
export function partSprite(kind, skin, bLocal, scale, light) {
  const tilt = Math.acos(clamp(bLocal[1], -1, 1)) * R2D, az = Math.atan2(bLocal[0], bLocal[2]) * R2D;
  const tq = q(tilt, 12), aq = tq < 6 || tq > 174 ? 0 : q(az, 30);
  const sq = Math.exp(q(Math.log(scale), 0.06));
  const la = q(Math.atan2(light[1], light[0]) * R2D, 30), lz = q(light[2], 0.25);
  const key = `${kind}|${typeof skin === 'string' ? skin : JSON.stringify(skin)}|${tq}|${aq}|${sq.toFixed(3)}|${la}|${lz}`;
  let sp = CACHE.get(key);
  if (sp) { CACHE.delete(key); CACHE.set(key, sp); return sp; }
  const shape = partShape(kind, skin);
  const t = tq * D2R, a = aq * D2R;
  const bc = [Math.sin(t) * Math.sin(a), Math.cos(t), Math.sin(t) * Math.cos(a)];
  // screen right = the bone axis projected (or the back-of-part axis when looking down the bone)
  let rc = sub([0, 1, 0], mul(bc, bc[1]));
  if (len(rc) < 1e-3) rc = sub([0, 0, 1], mul(bc, bc[2]));
  rc = norm(rc);
  const uc = cross(bc, rc);
  const lr = Math.hypot(light[0], light[1]) || 1;
  const L = norm([Math.cos(la * D2R) * lr, Math.sin(la * D2R) * lr, lz]);
  // bounds: the segment from 0 to L along y, radius R, projected
  const R = shape.R, ends = [[0, 0, 0], [0, shape.L, 0]];
  const xs = ends.map((e) => dot(e, rc)), ys = ends.map((e) => dot(e, uc));
  const x0 = (Math.min(...xs) - R) * sq, x1 = (Math.max(...xs) + R) * sq, y0 = (-Math.max(...ys) - R) * sq, y1 = (-Math.min(...ys) + R) * sq;
  const W = Math.max(1, Math.ceil(x1 - x0) + 2), H = Math.max(1, Math.ceil(y1 - y0) + 2), ox = -x0 + 1, oy = -y0 + 1;
  const N = W * H, mat = new Int16Array(N).fill(-1), nrm = new Float32Array(N * 3), depth = new Float32Array(N);
  const far = shape.L + R * 2 + 2;
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    const sx = (i + 0.5 - ox) / sq, sy = -(j + 0.5 - oy) / sq;
    let p = add(add(mul(rc, sx), mul(uc, sy)), mul(bc, far)), tt = 0, hit = -1;
    for (let k = 0; k < 64; k++) {
      const pp = add(p, mul(bc, -tt));
      const [dd, m] = shape.sdf(pp);
      if (dd < 0.02) { hit = m; p = pp; break; }
      tt += Math.max(0.05, dd);
      if (tt > far * 2) break;
    }
    if (hit < 0) continue;
    const e = 0.05, g = [shape.sdf(add(p, [e, 0, 0]))[0] - shape.sdf(add(p, [-e, 0, 0]))[0], shape.sdf(add(p, [0, e, 0]))[0] - shape.sdf(add(p, [0, -e, 0]))[0], shape.sdf(add(p, [0, 0, e]))[0] - shape.sdf(add(p, [0, 0, -e]))[0]];
    const n = norm(g), o = j * W + i;
    mat[o] = hit; nrm[o * 3] = dot(n, rc); nrm[o * 3 + 1] = dot(n, uc); nrm[o * 3 + 2] = dot(n, bc); depth[o] = tt * sq;
  }
  const data = paint(W, H, mat, nrm, depth, L, { edgeDepth: 2.2 * sq });
  sp = { width: W, height: H, data, ax: ox, ay: oy, axis: [dot([0, 1, 0], rc), -dot([0, 1, 0], uc)] };
  CACHE.set(key, sp);
  cachePx += W * H * 17;
  while (cachePx > CACHE_PX && CACHE.size > 1) { const [k, v] = CACHE.entries().next().value; CACHE.delete(k); cachePx -= v.width * v.height * 17; }
  return sp;
}
export const clearPartCache = () => { CACHE.clear(); cachePx = 0; };

/**
 * Draw arms bones into a frame buffer: painter's order (far to near), each bone's part sprite
 * rotated into place. -> {rgba, depth (cm), owner (bone index + 1), W, H}
 */
export function renderBones(bones, skin, frame = FRAME) {
  const [W, H] = frame;
  const buf = { W, H, rgba: new Uint8ClampedArray(W * H * 4), depth: new Float32Array(W * H).fill(Infinity), owner: new Uint16Array(W * H) };
  const order = bones.map((b, i) => ({ b, i, z: -(b.A[2] + b.B[2]) / 2 })).sort((x, y) => y.z - x.z);
  for (const { b, i } of order) {
    const zA = -b.A[2], zB = -b.B[2];
    // bones whose middle is closer than NEAR_BONE cm sit at the eye: their end caps would fill the frame
    if ((zA + zB) / 2 < NEAR_BONE) continue;
    const pA = project(b.A), pB = project(b.B);
    const C = mul(add(b.A, b.B), 0.5), zc = Math.max(4, -C[2]);
    const toCam = norm(mul(C, -1));
    const fr = b.frame; // columns: x, y (along), z
    const bLocal = [dot(toCam, col(fr, 0)), dot(toCam, col(fr, 1)), dot(toCam, col(fr, 2))];
    const scale = F / zc;
    // in-plane angle of the bone on screen (y down)
    let theta = Math.atan2(pB[1] - pA[1], pB[0] - pA[0]) * R2D;
    if (Math.hypot(pB[0] - pA[0], pB[1] - pA[1]) < 0.5) { const pz = project(add(b.A, col(fr, 2))); theta = Math.atan2(pz[1] - pA[1], pz[0] - pA[0]) * R2D; }
    // light in the canonical sprite space: rotate the screen light by -theta
    const Ls = [LIGHT[0], LIGHT[1]], c = Math.cos(-theta * D2R), s = Math.sin(-theta * D2R);
    // screen y is down; light y is up: rotate in y-up space by +theta
    const lx = Ls[0] * Math.cos(theta * D2R) - Ls[1] * Math.sin(theta * D2R), ly = Ls[0] * Math.sin(theta * D2R) + Ls[1] * Math.cos(theta * D2R);
    void c; void s;
    const sp = partSprite(b.kind, skin, bLocal, scale / 1, [lx, ly, LIGHT[2]]);
    // sprite canonical axis may be flipped (looking down the bone): correct theta by its own axis angle
    const spAng = Math.atan2(sp.axis[1], sp.axis[0]) * R2D;
    const X = Math.round(pA[0]), Y = Math.round(pA[1]);
    const dAx = pB[0] - pA[0], dAy = pB[1] - pA[1], L2 = dAx * dAx + dAy * dAy || 1;
    drawRot(buf, sp, sp.ax, sp.ay, X, Y, theta - spAng, (px, py) => { const t = clamp(((px + 0.5 - pA[0]) * dAx + (py + 0.5 - pA[1]) * dAy) / L2, 0, 1); return zA + (zB - zA) * t; }, i + 1);
  }
  return buf;
}
export { CENTRE };
