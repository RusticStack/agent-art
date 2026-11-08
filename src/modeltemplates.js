// Starter rigs for art_model create {template}: first-person arms and weapons in VIEW SPACE (the
// model origin is the eye / camera, -Z = forward, +Y = up, +X = right), metres-scaled px (32 px =
// 1 m), the Half-Life 1 / PSX viewmodel convention. Every part, texture slot, pose and clip is a
// starting point: create {template, textures?, set?:{<part name>:{..}}, add?, remove?, poses?, clips?, sockets?}.

// ---------- shared layout (the arms' grip poses are solved onto these weapon sockets) ----------
// The part numbers below are authored around y = -6; OFFSET_* lifts each weapon into view
// (about 15° below the centre of a 60° first-person camera).
export const OFFSET_RIFLE = [0, 3, 0], OFFSET_PISTOL = [0, 2.5, 0];
const RZ = 3; // rifle sits 3 px (~10 cm) closer than its part numbers below say
export const RIFLE = { x: 4, grip_r: [4, -8.9, -9.3 + RZ], grip_l: [4, -8.3, -18.5 + RZ], muzzle: [4, -6.2, -28.2 + RZ], sight: [4, -4.6, -10.6 + RZ], mag_well: [4, -7.5, -13 + RZ] };
export const PISTOL = { x: 3.5, grip_r: [3.5, -8.3, -10.2], grip_l: [3.1, -8.6, -10.4], muzzle: [3.5, -4.9, -15.8], sight: [3.5, -4.2, -9.9], mag_well: [3.5, -6.6, -10.6] };

const tex = (slots, k, def) => (slots && slots[k] !== undefined ? slots[k] : def);
/** A box limb along -Z from joint J (its back end) of length len: pivot = joint. */
const limb = (name, parent, J, len, w, h, t) => ({ type: 'box', name, ...(parent ? { parent } : {}), w, h, d: len, texture: t, at: [J[0], J[1] - h / 2, J[2] - len / 2], pivot: [0, h / 2, len / 2] });

// ---------- tiny 3D helpers for solving starter poses ----------
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const addv = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mulv = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const dotv = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const crossv = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const nrm = (a) => { const l = Math.hypot(...a) || 1; return mulv(a, 1 / l); };
/** 3x3 rotation (rows) taking local -Z to dir, local +Y toward up. */
function aim(dir, up = [0, 1, 0]) {
  const z = nrm(mulv(dir, -1)), x = nrm(crossv(up, z)), y = crossv(z, x);
  return [[x[0], y[0], z[0]], [x[1], y[1], z[1]], [x[2], y[2], z[2]]];
}
const mT3 = (A) => [[A[0][0], A[1][0], A[2][0]], [A[0][1], A[1][1], A[2][1]], [A[0][2], A[1][2], A[2][2]]];
const mm3 = (A, B) => A.map((r) => [0, 1, 2].map((j) => r[0] * B[0][j] + r[1] * B[1][j] + r[2] * B[2][j]));
/** Euler degrees [x,y,z] with R = Rz * Ry * Rx (the art_model rotate order). */
function euler(R) {
  const b = Math.asin(Math.max(-1, Math.min(1, -R[2][0])));
  const a = Math.atan2(R[2][1], R[2][2]), c = Math.atan2(R[1][0], R[0][0]);
  return [a, b, c].map((v) => Math.round((v * 180) / Math.PI * 10) / 10);
}
/**
 * Two-bone arm pose: shoulder S, bone lengths L1, L2 (rest = along -Z), wrist target T, elbow
 * toward pole. -> {upper: rot, fore: rot} pose offsets (deg, local to each parent).
 */
function solveArm(S, L1, L2, T, pole) {
  const d0 = sub(T, S), dist = Math.min(Math.hypot(...d0), L1 + L2 - 1e-3), u = nrm(d0);
  const a = Math.acos(Math.max(-1, Math.min(1, (L1 * L1 + dist * dist - L2 * L2) / (2 * L1 * dist))));
  const v = nrm(sub(pole, mulv(u, dotv(pole, u))));
  const E = addv(S, mulv(addv(mulv(u, Math.cos(a)), mulv(v, Math.sin(a))), L1));
  const R1 = aim(sub(E, S)), R2 = aim(sub(addv(S, mulv(u, dist)), E));
  return { upper: euler(R1), fore: euler(mm3(mT3(R1), R2)), dir2: nrm(sub(addv(S, mulv(u, dist)), E)) };
}

// ---------- fp_arms ----------
const ARM = { clav: 4, upper: 10, fore: 9.5, hand: 3, fingers: 2.6 };
function armParts(side, slots) {
  const s = side === 'r' ? 1 : -1, sleeve = tex(slots, 'sleeve', '#4b5a3c'), glove = tex(slots, 'glove', '#2b2a28'), cuff = tex(slots, 'cuff', tex(slots, 'sleeve', '#3e4a31'));
  const C = [1.6 * s, -5, 2], Sh = [6 * s, -6, 2], E = [6 * s, -6, 2 - ARM.upper], W = [6 * s, -6, E[2] - ARM.fore], K = [6 * s, -6, W[2] - ARM.hand];
  return [
    { type: 'box', name: `clavicle_${side}`, w: ARM.clav + 0.6, h: 1.6, d: 1.8, texture: sleeve, at: [C[0] + (s * ARM.clav) / 2, C[1] - 0.8, C[2]], pivot: [(-s * ARM.clav) / 2, 0.8, 0] },
    limb(`upper_arm_${side}`, `clavicle_${side}`, Sh, ARM.upper, 2.6, 2.6, sleeve),
    limb(`forearm_${side}`, `upper_arm_${side}`, E, ARM.fore, 2.2, 2.2, cuff),
    { ...limb(`hand_${side}`, `forearm_${side}`, W, ARM.hand, 2.6, 1.1, glove) },
    { ...limb(`fingers_${side}`, `hand_${side}`, K, ARM.fingers, 2.5, 0.9, glove) },
    { type: 'box', name: `thumb_${side}`, parent: `hand_${side}`, w: 0.8, h: 0.8, d: 2.2, texture: glove, at: [W[0] - s * 1.3, W[1] - 0.4, W[2] - 1.1], pivot: [0, 0.4, 1.1], rotate: [0, s * 25, 0] },
  ];
}
/** Pose putting both palms on two grip points (palm centre = socket). */
function gripPose(gR, gL, poleR = [0.6, -1, 0.2], poleL = [-0.6, -1, -0.2], extra = {}) {
  const parts = {};
  for (const [side, g, pole] of [['r', gR, poleR], ['l', gL, poleL]]) {
    const s = side === 'r' ? 1 : -1;
    const Sh = [6 * s, -6, 2];
    // wrist = palm centre pushed back along the forearm direction (half a hand)
    // the hand continues the forearm: iterate so the palm centre (half a hand past the wrist) lands on g
    let dir = nrm(sub(g, Sh)), sol;
    for (let it = 0; it < 6; it++) { sol = solveArm(Sh, ARM.upper, ARM.fore, sub(g, mulv(dir, ARM.hand / 2)), pole); dir = sol.dir2; }
    const { upper, fore } = sol;
    parts[`upper_arm_${side}`] = { rot: upper };
    parts[`forearm_${side}`] = { rot: fore };
    parts[`fingers_${side}`] = { rot: [-75, 0, 0] };
    parts[`thumb_${side}`] = { rot: [-20, -s * 35, 0] };
  }
  return { parts: { ...parts, ...extra } };
}
export function fpArms(o = {}) {
  const slots = o.textures || {};
  const P = lifted(PISTOL, OFFSET_PISTOL), Rf = lifted(RIFLE, OFFSET_RIFLE);
  const pistolL = gripPose(P.grip_r, P.grip_l, [0.7, -1, 0.3], [-0.7, -1, 0.3]);
  pistolL.parts.hand_l = { rot: [0, 0, -25] };
  const rifle = gripPose(Rf.grip_r, Rf.grip_l);
  const breathe = (dy) => ({ clavicle_r: { at: [0, dy, 0.1], rot: [0, 0, -1] }, clavicle_l: { at: [0, dy, 0.1], rot: [0, 0, 1] } });
  return {
    parts: [...armParts('r', slots), ...armParts('l', slots)],
    poses: {
      rest: { parts: {} },
      grip_rifle: rifle,
      grip_pistol: pistolL,
    },
    clips: {
      idle_breathe: { loop: true, duration: 3, keys: [{ t: 0, pose: 'grip_rifle' }, { t: 1.5, pose: 'grip_rifle', parts: breathe(-0.25), ease: 'smooth' }, { t: 3, pose: 'grip_rifle', ease: 'smooth' }] },
    },
    notes: 'fp_arms (view space: origin = eye, -Z forward, 32 px = 1 m). Chains clavicle > upper_arm > forearm > hand > fingers (+ thumb), _r and _l. Texture slots: textures:{sleeve, cuff, glove}. Poses rest, grip_rifle, grip_pistol (palms on the fp_rifle / fp_pistol grip sockets).',
  };
}

// ---------- fp_rifle ----------
export function fpRifle(o = {}) {
  const t = o.textures || {}, metal = tex(t, 'metal', '#2c2e33'), poly = tex(t, 'polymer', '#3b3c36'), mag = tex(t, 'magazine', '#35362f'), optic = tex(t, 'optic', '#1c1d21'), lens = tex(t, 'lens', '#5fb4d8');
  const x = RIFLE.x;
  return {
    parts: [
      { type: 'box', name: 'receiver', w: 1.8, h: 2.2, d: 8, texture: metal, at: [x, -7.5, -12 + RZ], pivot: [0, 1.1, 3.5] },
      { type: 'box', parent: 'receiver', w: 1.4, h: 3, d: 1.6, texture: poly, at: [x, -10.5, -9.3 + RZ], rotate: [-20, 0, 0], pivot: [0, 3, 0] },
      { type: 'cylinder', name: 'barrel', parent: 'receiver', r: 0.35, h: 12.2, segments: 8, texture: metal, rotate: [-90, 0, 0], at: [x, -6.2, -16 + RZ] },
      { type: 'box', name: 'handguard', parent: 'receiver', w: 2, h: 2, d: 8, texture: poly, at: [x, -7.4, -20 + RZ] },
      { type: 'box', name: 'stock', parent: 'receiver', w: 1.6, h: 2.6, d: 7, texture: poly, at: [x, -8.4, -4.5 + RZ] },
      { type: 'box', name: 'magazine', parent: 'receiver', w: 1.3, h: 4.2, d: 2, texture: mag, at: [x, -11.7, -13 + RZ], pivot: [0, 4.2, 0] },
      { type: 'box', name: 'trigger', parent: 'receiver', w: 0.3, h: 1, d: 0.3, texture: metal, at: [x, -8.5, -10.7 + RZ], pivot: [0, 1, 0] },
      { type: 'box', name: 'bolt', parent: 'receiver', w: 0.3, h: 1, d: 2.6, texture: '#55585e', at: [x + 1.05, -6.9, -11.4 + RZ] },
      { type: 'box', name: 'charging_handle', parent: 'receiver', w: 1.2, h: 0.4, d: 1.2, texture: metal, at: [x, -5.4, -8.4 + RZ] },
      { type: 'box', name: 'optic', parent: 'receiver', w: 1.2, h: 1.4, d: 4, texture: optic, at: [x, -5.3, -12.6 + RZ] },
      { type: 'box', parent: 'optic', w: 0.9, h: 0.9, d: 0.1, texture: lens, at: [x, -5.05, -14.65 + RZ] },
    ],
    sockets: {
      muzzle: { part: 'barrel', at: RIFLE.muzzle, look: [0, 0, -1] },
      sight: { part: 'optic', at: RIFLE.sight, look: [0, 0, -1] },
      grip_r: { part: 'receiver', at: RIFLE.grip_r },
      grip_l: { part: 'handguard', at: RIFLE.grip_l },
      mag_well: { part: 'receiver', at: RIFLE.mag_well, look: [0, -1, 0] },
    },
    poses: {
      fire_kick: { parts: { receiver: { at: [0, 0.15, 0.7], rot: [2.5, 0, 0] }, bolt: { at: [0, 0, 2.6] }, trigger: { rot: [-25, 0, 0] } } },
      bolt_locked: { parts: { bolt: { at: [0, 0, 2.6] } } },
      reload_tilt: { parts: { receiver: { at: [-0.8, -0.8, 0.5], rot: [6, 0, -14] } } },
    },
    clips: {
      fire: { duration: 0.1, keys: [{ t: 0, parts: {} }, { t: 0.03, pose: 'fire_kick' }, { t: 0.1, parts: {}, ease: 'smooth' }], events: [{ t: 0, name: 'shot' }, { t: 0.03, name: 'shell_eject' }] },
      reload_tactical: {
        duration: 2.2,
        keys: [
          { t: 0, parts: {} },
          { t: 0.3, pose: 'reload_tilt', ease: 'smooth' },
          { t: 0.45, pose: 'reload_tilt', parts: { magazine: { at: [0, -0.4, 0] } } },
          { t: 0.65, pose: 'reload_tilt', parts: { magazine: { at: [0, -9, 1.5], rot: [-12, 0, 0] } }, ease: 'smooth' },
          { t: 0.9, pose: 'reload_tilt', parts: { magazine: { at: [0, -16, 2], rot: [-20, 0, 0] } } },
          { t: 1.25, pose: 'reload_tilt', parts: { magazine: { at: [0, -9, 1.5], rot: [-12, 0, 0] } }, ease: 'smooth' },
          { t: 1.55, pose: 'reload_tilt', parts: { magazine: { at: [0, 0.2, 0] } }, ease: 'smooth' },
          { t: 1.6, pose: 'reload_tilt' },
          { t: 2.2, parts: {}, ease: 'smooth' },
        ],
        events: [{ t: 0.45, name: 'mag_release' }, { t: 0.65, name: 'mag_out' }, { t: 1.55, name: 'mag_in' }],
      },
      reload_empty: {
        duration: 2.8,
        keys: [
          { t: 0, pose: 'bolt_locked' },
          { t: 0.3, pose: 'reload_tilt', parts: { bolt: { at: [0, 0, 2.6] } }, ease: 'smooth' },
          { t: 0.45, pose: 'reload_tilt', parts: { bolt: { at: [0, 0, 2.6] }, magazine: { at: [0, -0.4, 0] } } },
          { t: 0.65, pose: 'reload_tilt', parts: { bolt: { at: [0, 0, 2.6] }, magazine: { at: [0, -9, 1.5], rot: [-12, 0, 0] } }, ease: 'smooth' },
          { t: 0.9, pose: 'reload_tilt', parts: { bolt: { at: [0, 0, 2.6] }, magazine: { at: [0, -16, 2], rot: [-20, 0, 0] } } },
          { t: 1.25, pose: 'reload_tilt', parts: { bolt: { at: [0, 0, 2.6] }, magazine: { at: [0, -9, 1.5], rot: [-12, 0, 0] } }, ease: 'smooth' },
          { t: 1.55, pose: 'reload_tilt', parts: { bolt: { at: [0, 0, 2.6] }, magazine: { at: [0, 0.2, 0] } }, ease: 'smooth' },
          { t: 1.6, pose: 'reload_tilt', parts: { bolt: { at: [0, 0, 2.6] } } },
          { t: 1.9, pose: 'reload_tilt', parts: { bolt: { at: [0, 0, 2.6] }, charging_handle: { at: [0, 0, 3.2] } }, ease: 'smooth' },
          { t: 2.0, pose: 'reload_tilt', parts: { bolt: { at: [0, 0, 2.6] } }, ease: 'linear' },
          { t: 2.05, pose: 'reload_tilt' },
          { t: 2.8, parts: {}, ease: 'smooth' },
        ],
        events: [{ t: 0.45, name: 'mag_release' }, { t: 0.65, name: 'mag_out' }, { t: 1.55, name: 'mag_in' }, { t: 1.9, name: 'charge' }, { t: 2.05, name: 'bolt_close' }],
      },
    },
    notes: 'fp_rifle (view space, -Z = muzzle, 32 px = 1 m). Texture slots: textures:{metal, polymer, magazine, optic, lens}. Sockets muzzle, sight (ADS: put it on screen centre), grip_r, grip_l, mag_well. Clips fire (bolt cycle), reload_tactical, reload_empty (+ charging handle). Pair with template fp_arms (pose grip_rifle).',
  };
}

// ---------- fp_pistol ----------
export function fpPistol(o = {}) {
  const t = o.textures || {}, metal = tex(t, 'metal', '#2a2b2f'), slideT = tex(t, 'slide', '#3a3c42'), poly = tex(t, 'polymer', '#2f302c'), mag = tex(t, 'magazine', '#26272a');
  const x = PISTOL.x;
  return {
    parts: [
      { type: 'box', name: 'frame', w: 1.0, h: 1.2, d: 5.6, texture: poly, at: [x, -6.6, -12.6], pivot: [0, 0.6, 2.4] },
      { type: 'box', parent: 'frame', w: 1.0, h: 3.2, d: 1.6, texture: poly, at: [x, -9.8, -10.4], rotate: [-15, 0, 0], pivot: [0, 3.2, 0] },
      { type: 'box', name: 'slide', parent: 'frame', w: 0.95, h: 1.0, d: 6, texture: slideT, at: [x, -5.4, -12.7] },
      { type: 'cylinder', name: 'barrel', parent: 'frame', r: 0.3, h: 6.2, segments: 8, texture: metal, rotate: [-90, 0, 0], at: [x, -4.9, -9.6] },
      { type: 'box', name: 'magazine', parent: 'frame', w: 0.8, h: 3.5, d: 1.3, texture: mag, at: [x, -10.1, -10.5], rotate: [-15, 0, 0], pivot: [0, 3.5, 0] },
      { type: 'box', name: 'trigger', parent: 'frame', w: 0.25, h: 0.8, d: 0.25, texture: metal, at: [x, -7.3, -11.5], pivot: [0, 0.8, 0] },
    ],
    sockets: {
      muzzle: { part: 'barrel', at: PISTOL.muzzle, look: [0, 0, -1] },
      sight: { part: 'slide', at: PISTOL.sight, look: [0, 0, -1] },
      grip_r: { part: 'frame', at: PISTOL.grip_r },
      grip_l: { part: 'frame', at: PISTOL.grip_l },
      mag_well: { part: 'frame', at: PISTOL.mag_well, look: [0, -1, 0] },
    },
    poses: {
      fire_kick: { parts: { frame: { at: [0, 0.2, 0.6], rot: [7, 0, 0] }, slide: { at: [0, 0, 2.4] }, trigger: { rot: [-25, 0, 0] } } },
      slide_locked: { parts: { slide: { at: [0, 0, 2.4] } } },
      reload_tilt: { parts: { frame: { at: [-0.6, -0.6, 0.4], rot: [10, 0, -18] } } },
    },
    clips: {
      fire: { duration: 0.14, keys: [{ t: 0, parts: {} }, { t: 0.035, pose: 'fire_kick' }, { t: 0.14, parts: {}, ease: 'smooth' }], events: [{ t: 0, name: 'shot' }, { t: 0.035, name: 'shell_eject' }] },
      reload: {
        duration: 1.7,
        keys: [
          { t: 0, parts: {} },
          { t: 0.25, pose: 'reload_tilt', ease: 'smooth' },
          { t: 0.35, pose: 'reload_tilt', parts: { magazine: { at: [0, -0.4, 0] } } },
          { t: 0.55, pose: 'reload_tilt', parts: { magazine: { at: [0, -12, 1], rot: [-10, 0, 0] } }, ease: 'smooth' },
          { t: 0.9, pose: 'reload_tilt', parts: { magazine: { at: [0, -8, 1] } }, ease: 'smooth' },
          { t: 1.15, pose: 'reload_tilt', parts: { magazine: { at: [0, 0.15, 0] } }, ease: 'smooth' },
          { t: 1.2, pose: 'reload_tilt' },
          { t: 1.7, parts: {}, ease: 'smooth' },
        ],
        events: [{ t: 0.35, name: 'mag_release' }, { t: 0.55, name: 'mag_out' }, { t: 1.15, name: 'mag_in' }],
      },
    },
    notes: 'fp_pistol (view space, -Z = muzzle, 32 px = 1 m). Texture slots: textures:{metal, slide, polymer, magazine}. Sockets muzzle, sight, grip_r, grip_l, mag_well. Clips fire (slide cycle), reload. Pair with fp_arms pose grip_pistol.',
  };
}

/** Move a whole template (parts + sockets) by d px. */
function placed(t, d) {
  const mv = (v) => [v[0] + d[0], v[1] + d[1], v[2] + d[2]];
  return { ...t, parts: t.parts.map((p) => ({ ...p, at: mv(p.at || [0, 0, 0]) })), sockets: Object.fromEntries(Object.entries(t.sockets).map(([k, s]) => [k, { ...s, at: mv(s.at) }])) };
}
const lifted = (S, d) => Object.fromEntries(Object.entries(S).map(([k, v]) => [k, Array.isArray(v) ? [v[0] + d[0], v[1] + d[1], v[2] + d[2]] : v]));

export const MODEL_TEMPLATES = { fp_arms: fpArms, fp_rifle: (o) => placed(fpRifle(o), OFFSET_RIFLE), fp_pistol: (o) => placed(fpPistol(o), OFFSET_PISTOL) };
