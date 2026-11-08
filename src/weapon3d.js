// Weapon handling for first-person 3D rigs (art_model, view space: origin = the eye, -Z forward,
// +Y up, 32 px = 1 m): a gun model with named grip points (sockets or part points) and
// attachments, carry states as transforms of the whole gun, two-bone arms solved onto the grips
// with wrist orientation, reach limits (support hand slides back along the rail, then the gun
// moves back), a dead zone of body capsules the gun is pushed out of, muzzle discipline and
// per-frame metrics. Used by art_model render / animate {hold} and art_model check.
import { matMul, mT, IDENT, applyP, mRX, mRY, mRZ, cross, dot, norm } from './model3d.js';
import { posedWorld, lookRotation, quatOfMat, qMul, qEuler, rotT } from './modelrig.js';
import { trsMatrix } from './glb.js';

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const r2 = (v) => Math.round(v * 100) / 100;
const rotOnly = (M) => [M[0], M[1], M[2], 0, M[4], M[5], M[6], 0, M[8], M[9], M[10], 0];
const rotApply = (M, v) => [M[0] * v[0] + M[1] * v[1] + M[2] * v[2], M[4] * v[0] + M[5] * v[1] + M[6] * v[2], M[8] * v[0] + M[9] * v[1] + M[10] * v[2]];
/** Orthonormalized rotation of a 3x4 (drops scale). */
function ortho(M) {
  const x = norm([M[0], M[4], M[8]]), y0 = [M[1], M[5], M[9]];
  const z = norm(cross(x, y0)), y = cross(z, x);
  return [x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0];
}

/** First-person carry states: a transform of the whole gun about the trigger grip. aim = optic on the eye line. */
const LONG3 = {
  hip: { rot: [0, 0, 0], at: [0, 0, 0], lock: ['main', 'support'], fire: true },
  aim: { aim: true, at: [0, 0, 2.2], lock: ['main', 'support'], fire: true, weld: true },
  ready_low: { rot: [-20, 5, 0], at: [-0.5, -0.6, 0.6], lock: ['main', 'support'] },
  ready_high: { rot: [30, 0, 0], at: [0, 1.5, -2], lock: ['main', 'support'] },
  sprint: { rot: [-28, 30, -20], at: [-1.5, 0.6, 1], lock: ['main', 'support'] },
  reload: { rot: [-22, 0, -16], at: [-0.8, -1.6, 0.5], lock: ['main', 'support'], support_grip: 'mag' },
  holster: { hidden: true, rot: [-60, 0, 0], at: [0, -14, 0], lock: [] },
};
const PISTOL3 = {
  aim: { aim: true, at: [0, 0, 1], lock: ['main', 'support'], fire: true },
  compressed: { at: [-1.2, -1.6, 4.2], rot: [0, 0, 0], lock: ['main', 'support'], fire: true },
  low: { rot: [-30, 0, 0], at: [0, -0.4, 0.5], lock: ['main', 'support'] },
  reload: { rot: [-24, 0, -18], at: [-0.6, -1.4, 0.4], lock: ['main', 'support'], support_grip: 'mag' },
  holster: { hidden: true, rot: [-70, 0, 0], at: [0, -14, 0], lock: [] },
};
export const CARRY3 = { long: Object.keys(LONG3), pistol: Object.keys(PISTOL3) };

/** Body dead zone in view space (px at 32 px / m): head, chest, shoulders. */
function bodyCapsules(k = 1) {
  const P = (v) => v.map((x) => x * k);
  return [
    { kind: 'head', name: 'head', a: P([0, 0.8, 2.2]), b: P([0, 0.8, 2.2]), r: 3.3 * k, rz: 3.3 * k },
    { kind: 'torso', name: 'chest', a: P([0, -9, 8.6]), b: P([0, -30, 9.2]), r: 6.2 * k, rz: 8.6 * k },
    { kind: 'torso', name: 'shoulder_r', a: P([6, -6.4, 3.4]), b: P([6, -6.4, 3.4]), r: 2.1 * k, rz: 2.1 * k },
    { kind: 'torso', name: 'shoulder_l', a: P([-6, -6.4, 3.4]), b: P([-6, -6.4, 3.4]), r: 2.1 * k, rz: 2.1 * k },
  ];
}
function capDepth(c, q, rq) {
  const ab = sub(c.b, c.a), L2 = dot(ab, ab);
  const t = L2 > 1e-9 ? clamp(dot(sub(q, c.a), ab) / L2, 0, 1) : 0;
  const d = sub(q, add(c.a, mul(ab, t)));
  return c.r + rq - Math.hypot(d[0] * (c.r / c.rz), d[1], d[2]);
}

/** A grip / point spec: socket name, or {part, at:[x,y,z] (model px, rest), look?, up?, slide?}. */
function pointSpec(info, built, v, where) {
  if (typeof v === 'string') {
    const s = info.sockets.find((x) => x.key === v || x.name === v);
    if (!s) throw new Error(`${where}: no socket "${v}" (sockets: ${info.sockets.map((x) => x.key).join(', ') || 'none'})`);
    return { node: s.parent, t: s.t, R: rotOnly(trsMatrix([0, 0, 0], s.q, [1, 1, 1])) };
  }
  if (!v || typeof v !== 'object' || !Array.isArray(v.at)) throw new Error(`${where} must be a socket name or {part, at:[x,y,z], look?, up?}`);
  const node = v.part ?? info.root;
  const P = info.byName.get(node);
  if (!P) throw new Error(`${where}: "${node}" is not a node`);
  const sh = built.shift || [0, 0, 0];
  const W = [v.at[0] + sh[0], v.at[1] + sh[1], v.at[2] + sh[2]];
  const PT = rotT(P.R);
  return { node, t: rotApply(PT, sub(W, P.joint)), R: matMul(PT, lookRotation(v.look || [0, 0, -1], v.up || [0, 1, 0])) };
}

/**
 * Normalize a gun model's "weapon" setting against its rig info: grips (main, support, stock,
 * muzzle, optic), grip frames (look = knuckle direction, up = back of the hand), attachments.
 */
export function normalizeWeapon3D(def, info, built) {
  const cfg = def.weapon === true ? {} : def.weapon;
  if (!cfg || typeof cfg !== 'object') throw new Error('model "weapon" must be {kind?, grips?, frames?, attachments?, attach?, carry?}');
  const kind = cfg.kind ?? (/pistol/.test(def.template || '') ? 'pistol' : 'long');
  if (!['long', 'pistol'].includes(kind)) throw new Error('weapon.kind must be "long" or "pistol"');
  const sockets = new Set(info.sockets.map((s) => s.key));
  const dflt = { grip_main: 'grip_r', grip_support: 'grip_l', muzzle: 'muzzle', optic: 'sight' };
  const grips = {};
  for (const k of ['grip_main', 'grip_support', 'stock', 'muzzle', 'optic', 'mag']) {
    const v = cfg.grips?.[k] ?? (dflt[k] && sockets.has(dflt[k]) ? dflt[k] : undefined);
    if (v !== undefined) grips[k] = { ...pointSpec(info, built, v, `weapon.grips.${k}`), slide: k === 'grip_support' && cfg.grips?.slide !== false && kind === 'long' };
  }
  if (!grips.grip_main) throw new Error('weapon.grips.grip_main is required (a socket like "grip_r" or {part, at})');
  // hand frames on each grip: knuckles (look) and back of the hand (up), in the gun's rest frame
  const frames = {
    grip_main: { look: [0, -0.35, -1], up: [1, 0.25, 0] },
    mag: { look: [0.2, 0.2, -1], up: [-1, 0, 0] },
    grip_support: kind === 'pistol' ? { look: [0.15, -0.3, -1], up: [-1, 0.3, 0] } : { look: [0.35, 0.05, -1], up: [0, -1, 0.1] },
    ...(cfg.frames || {}),
  };
  const attachments = {};
  for (const [n, a] of Object.entries(cfg.attachments || {})) {
    const parts = [].concat(a.parts || a.part || []);
    for (const p of parts) if (!info.byName.has(p)) throw new Error(`weapon.attachments.${n}: "${p}" is not a node`);
    const over = {};
    for (const k of ['grip_support', 'muzzle', 'optic']) if (a[k] !== undefined) over[k] = { ...pointSpec(info, built, a[k], `weapon.attachments.${n}.${k}`), slide: false };
    attachments[n] = { parts, over, frame: a.frame || null };
  }
  const attach = cfg.attach !== undefined ? [].concat(cfg.attach) : Object.keys(attachments);
  for (const n of attach) if (!attachments[n]) throw new Error(`weapon.attach: unknown attachment "${n}"`);
  const builtIn = kind === 'pistol' ? PISTOL3 : LONG3;
  const states = { ...builtIn };
  // custom states: base:<state> inherits a built-in (or earlier) state; fields override it
  for (const [n, s] of Object.entries(cfg.states || {})) {
    if (!s || typeof s !== 'object') throw new Error(`weapon.states.${n} must be {base?, rot?, at?, aim?, lock?, fire?, hidden?}`);
    const from = s.base ? states[s.base] : builtIn[n];
    if (s.base && !from) throw new Error(`weapon.states.${n}.base: unknown state "${s.base}"`);
    states[n] = { ...(from || { lock: ['main', 'support'] }), ...s };
  }
  const carry = cfg.carry ?? (kind === 'pistol' ? 'low' : 'hip');
  if (!states[carry]) throw new Error(`weapon.carry "${carry}" is not a state (${Object.keys(states).join(', ')})`);
  return { kind, grips, frames, attachments, attach, states, carry, reach: clamp(Number(cfg.reach ?? 0.98), 0.6, 0.999), standoff: Number(cfg.standoff ?? 1.2), scale: Number(def.scale ?? 32) / 32 };
}

/** The arms of an arms model: chains main / support (upper > fore > hand), auto from *_r / *_l names. */
export function armsChains(def, info) {
  const cfg = def.arms || {};
  const pick = (side) => [`upper_arm_${side}`, `forearm_${side}`, `hand_${side}`];
  const chains = { main: cfg.main || pick('r'), support: cfg.support || pick('l') };
  for (const [role, c] of Object.entries(chains)) {
    if (!Array.isArray(c) || c.length !== 3) throw new Error(`arms.${role} must be [upper, fore, hand] node names`);
    for (const n of c) if (!info.byName.has(n)) throw new Error(`arms model "${def.name}": no node "${n}" (an arms rig needs upper_arm_r > forearm_r > hand_r and _l, or arms:{main:[..], support:[..]})`);
    if (info.byName.get(c[1]).parent !== c[0] || info.byName.get(c[2]).parent !== c[1]) throw new Error(`arms.${role}: ${c.join(' > ')} must be a parent chain`);
  }
  const out = { chains };
  for (const [role, [u, f, h]] of Object.entries(chains)) {
    const F = info.byName.get(f), H = info.byName.get(h);
    const hb = H.mesh.triangles ? H.mesh.bounds() : { min: [-1, -0.5, -3], max: [1, 0.5, 0] };
    const kn = H.children.length ? norm(info.byName.get(H.children[0]).t) : [0, 0, -1];
    out[role] = { L1: len(F.t), L2: len(H.t), d1: norm(F.t), d2: norm(H.t), knuckle: len(kn) ? kn : [0, 0, -1], palm: [(hb.min[0] + hb.max[0]) / 2, hb.min[1], (hb.min[2] + hb.max[2]) / 2] };
  }
  return out;
}

/** Rotation taking local axis `from` (with local up) onto world `to` (with world up). */
const alignRot = (from, upFrom, to, upTo) => matMul(lookRotation(to, upTo), rotT(lookRotation(from, upFrom)));

function stateOf(W, carry) {
  const name = typeof carry === 'string' ? carry : carry?.state ?? W.carry;
  const s = W.states[name];
  if (!s) throw new Error(`unknown carry state "${name}" (states: ${Object.keys(W.states).join(', ')})`);
  return { name, ...s, ...(typeof carry === 'object' ? carry : {}) };
}

/** World frame (position, rotation 3x4) of a grip spec under a posed gun. */
function gripWorld(world, g) {
  const M = matMul(world.get(g.node), trsMatrix(g.t, [0, 0, 0, 1], [1, 1, 1]));
  return { pos: [M[3], M[7], M[11]], R: ortho(matMul(rotOnly(world.get(g.node)), g.R)) };
}

/**
 * Solve one frame: gun (info + local pose) carried in a state, arms (info + base pose) holding it.
 * -> {pre (gun root transform), arms (Map node -> local TRS), metrics}
 */
export function solveHold3D(gun, arms, { gunPose = new Map(), armsPose = new Map(), carry, attach, fix = false } = {}) {
  const W = gun.weapon, A = arms.chainsInfo;
  const st = stateOf(W, carry);
  const active = (attach ?? W.attach).filter((n) => W.attachments[n]);
  const grip = (k) => { for (const n of active) if (W.attachments[n].over[k]) return { ...W.attachments[n].over[k], att: n }; return W.grips[k]; };
  const gm = grip('grip_main'), opt = grip('optic'), muz = grip('muzzle');
  // the support hand's grip in this state (reload: the magazine, following it out and in)
  const supportKey = st.support_grip && W.grips[st.support_grip] ? st.support_grip : 'grip_support';
  const gsp = supportKey === 'grip_support' ? grip('grip_support') : W.grips[supportKey];
  // carry transform about the trigger grip (rest gun pose)
  const rest = posedWorld(gun.info, gunPose, { mesh: false });
  const G0 = gripWorld(rest.world, gm).pos;
  let pre = IDENT;
  const rot = st.rot || [0, 0, 0];
  if (rot.some((v) => v)) pre = matMul(mT(G0[0], G0[1], G0[2]), matMul(mRZ(rot[2]), matMul(mRY(rot[1]), matMul(mRX(rot[0]), mT(-G0[0], -G0[1], -G0[2])))));
  if (st.aim && opt) {
    // level the optic line and put it on the eye line (x = y = 0), keeping its distance
    const o = gripWorld(rest.world, opt);
    const fwd = norm([-o.R[2], -o.R[6], -o.R[10]]);
    const level = alignRot(fwd, [0, 1, 0], [0, 0, -1], [0, 1, 0]);
    const piv = o.pos;
    pre = matMul(mT(piv[0], piv[1], piv[2]), matMul(level, mT(-piv[0], -piv[1], -piv[2])));
    const p2 = applyP(pre, piv);
    pre = matMul(mT(-p2[0], -p2[1], 0), pre);
  }
  const at = (st.at || [0, 0, 0]).map((v) => v * W.scale);
  pre = matMul(mT(at[0], at[1], at[2]), pre);
  const lock = { main: (st.lock || []).includes('main') ? 1 : 0, support: (st.lock || []).includes('support') ? 1 : 0 };
  const flags = [];
  // arms: shoulders from the arms' base pose
  const ab = posedWorld(arms.info, armsPose, { mesh: false });
  const shoulder = (role) => { const M = ab.world.get(A.chains[role][0]); return [M[3], M[7], M[11]]; };
  const handFrame = (role, g, world, slide = 0) => {
    const gw = gripWorld(world, g);
    const fr = W.frames[role === 'main' ? 'grip_main' : supportKey] || W.frames.grip_support;
    const att = g.att ? W.attachments[g.att].frame : null;
    const look = rotApply(gw.R, (att || fr).look || [0, 0, -1]), up = rotApply(gw.R, (att || fr).up || [0, 1, 0]);
    const Rh = alignRot(A[role].knuckle, [0, 1, 0], norm(look), norm(up));
    let pos = gw.pos;
    if (slide) pos = add(pos, mul(rotApply(gw.R, [0, 0, 1]), slide));
    const wrist = sub(pos, rotApply(Rh, A[role].palm));
    return { grip: pos, Rh, wrist };
  };
  const posed = (P) => posedWorld(gun.info, gunPose, { mesh: false, pre: P });
  const reachOf = (role, world, slide = 0) => { const g = role === 'main' ? gm : gsp; if (!g) return 0; return len(sub(handFrame(role, g, world, slide).wrist, shoulder(role))) / (A[role].L1 + A[role].L2); };
  const reachOK = (world, slide = 0) => (!lock.main || reachOf('main', world) <= W.reach) && (!lock.support || !gsp || reachOf('support', world, slide) <= W.reach);
  let world = posed(pre).world;
  let slide = 0;
  if (lock.support && gsp && gsp.slide && reachOf('support', world) > W.reach) {
    let lo = 0, hi = 6 * W.scale;
    if (reachOf('support', world, hi) <= W.reach) { for (let i = 0; i < 18; i++) { const m = (lo + hi) / 2; if (reachOf('support', world, m) <= W.reach) hi = m; else lo = m; } }
    slide = hi; flags.push('support_slid');
  }
  // gun axis (muzzle forward) for move-back
  const axis = () => { const m = muz ? gripWorld(world, muz) : gripWorld(world, gm); return norm([-m.R[2], -m.R[6], -m.R[10]]); };
  if (!reachOK(world, slide) && !st.aim) {
    const ax = axis();
    let lo = 0, hi = 12 * W.scale;
    const back = (d) => matMul(mT(-ax[0] * d, -ax[1] * d, -ax[2] * d), pre);
    if (reachOK(posed(back(hi)).world, slide)) { for (let i = 0; i < 18; i++) { const m = (lo + hi) / 2; if (reachOK(posed(back(m)).world, slide)) hi = m; else lo = m; } pre = back(hi); flags.push('moved_back'); }
    else flags.push('out_of_reach');
    world = posed(pre).world;
  } else if (!reachOK(world, slide)) flags.push('out_of_reach');
  // dead zone: gun vertices vs body capsules (head excluded at the cheek weld)
  const caps = bodyCapsules(W.scale).filter((c) => !(st.weld && c.kind === 'head'));
  const verts = [];
  for (const n of gun.info.nodes) {
    if (!n.mesh.triangles) continue;
    const skip = Object.entries(W.attachments).some(([an, a]) => !active.includes(an) && a.parts.includes(n.name));
    if (skip) continue;
    for (const g of n.mesh.groups.values()) for (let i = 0; i < g.pos.length; i += 3 * Math.max(1, Math.floor(g.pos.length / 3 / 60))) verts.push([n.name, [g.pos[i], g.pos[i + 1], g.pos[i + 2]]]);
  }
  // the stock seats against the shoulder (the pocket): contact there is intended
  const stockNode = W.grips.stock?.node;
  const penOf = (P) => {
    const wd = posed(P).world;
    let worst = 0, hit = null;
    for (const [n, v] of verts) {
      const q = applyP(wd.get(n), v);
      for (const c of caps) {
        if (n === stockNode && (st.weld || /^shoulder/.test(c.name))) continue; const d = capDepth(c, q, c.kind === 'torso' ? W.standoff * W.scale : 0.2); if (d > worst) { worst = d; hit = c.name; } }
    }
    return { pen: worst, hit };
  };
  let col = st.hidden ? { pen: 0, hit: null } : penOf(pre);
  if (col.pen > 0.3 && !st.hidden) {
    let best = null;
    const step = 0.5 * W.scale;
    for (let i = 0; i <= 20 && !best; i++) for (let j = 0; j <= 12; j++) {
      if (!i && !j) continue;
      const cost = i + 1.6 * j;
      if (best && cost >= best.cost) continue;
      const P = matMul(mT(j * step, 0, -i * step), pre);
      if (!reachOK(posed(P).world, slide) && (lock.main || lock.support)) continue;
      const c = penOf(P);
      if (c.pen <= 0.3) best = { P, cost, col: c, tag: j ? 'pushed_out' : 'pushed_forward' };
    }
    if (best) { pre = best.P; col = best.col; flags.push(best.tag); world = posed(pre).world; }
    else flags.push('penetrates');
  }
  // muzzle discipline
  let muzzle = null;
  const fwdOf = () => { const m = gripWorld(world, muz || gm); return { pos: m.pos, fwd: norm([-m.R[2], -m.R[6], -m.R[10]]) }; };
  const flagOf = () => {
    if (st.hidden || st.exempt) return null;
    const { pos, fwd } = fwdOf();
    for (let d = 1; d < 120; d += 1.5) { const q = add(pos, mul(fwd, d * W.scale)); for (const c of bodyCapsules(W.scale)) if (capDepth(c, q, 0.2) > 0) return `points at own ${c.name}`; }
    if (!st.fire && st.name !== 'ready_high' && fwd[1] > -Math.sin(10 * Math.PI / 180)) return `muzzle not down (${r2(Math.asin(clamp(fwd[1], -1, 1)) * 180 / Math.PI)} deg) outside a firing state`;
    return null;
  };
  muzzle = flagOf();
  if (fix && muzzle) {
    for (let k = 0; k < 6 && muzzle; k++) {
      const g = gripWorld(world, gm).pos;
      pre = matMul(mT(g[0], g[1], g[2]), matMul(mRX(-8), matMul(mT(-g[0], -g[1], -g[2]), pre)));
      world = posed(pre).world;
      muzzle = flagOf();
    }
    flags.push('muzzle_lowered');
  }
  // arms: two-bone IK per locked hand, wrist oriented to the grip
  const armsTRS = new Map();
  const handsOut = {};
  for (const role of ['main', 'support']) {
    const g = role === 'main' ? gm : gsp;
    if (!lock[role] || !g) continue;
    const [u, f, h] = A.chains[role];
    const hf = handFrame(role, g, world, role === 'support' ? slide : 0);
    const S = shoulder(role), a = A[role];
    const d = sub(hf.wrist, S), D = len(d), Dc = clamp(D, Math.abs(a.L1 - a.L2) + 1e-4, a.L1 + a.L2 - 1e-4);
    const dir = D > 1e-9 ? mul(d, 1 / D) : [0, 0, -1];
    const cosA = clamp((a.L1 * a.L1 + Dc * Dc - a.L2 * a.L2) / (2 * a.L1 * Dc), -1, 1), sinA = Math.sqrt(1 - cosA * cosA);
    const side = Math.sign(S[0]) || 1;
    let pole = [side * 0.6, -1, 0.25];
    pole = sub(pole, mul(dir, dot(pole, dir)));
    pole = len(pole) > 1e-6 ? norm(pole) : [0, -1, 0];
    const E = add(S, mul(add(mul(dir, cosA), mul(pole, sinA)), a.L1));
    const Wr = add(S, mul(dir, Dc));
    // world rotations -> local TRS under the (fixed) parent
    const parentR = ortho(ab.world.get(arms.info.byName.get(u).parent));
    const Ru = alignRot(a.d1, [0, 1, 0], norm(sub(E, S)), pole.map((v) => -v));
    const Rf = alignRot(a.d2, [0, 1, 0], norm(sub(Wr, E)), pole.map((v) => -v));
    const local = (Rp, Rw, node) => ({ t: arms.info.byName.get(node).t.slice(), q: quatOfMat(matMul(rotT(Rp), Rw)), s: [1, 1, 1] });
    armsTRS.set(u, local(parentR, Ru, u));
    armsTRS.set(f, local(Ru, Rf, f));
    armsTRS.set(h, local(Rf, hf.Rh, h));
    handsOut[role] = { hand: h, grip: hf.grip, reach: r2(D / (a.L1 + a.L2)), palm: a.palm };
  }
  // carry the arms' own pose for every other node
  for (const [n, v] of armsPose) if (!armsTRS.has(n)) armsTRS.set(n, v);
  // metrics: contact point vs grip
  const aw = posedWorld(arms.info, armsTRS, { mesh: false }).world;
  const hand_grip = {}, reach = {};
  for (const [role, o] of Object.entries(handsOut)) {
    const c = applyP(aw.get(o.hand), o.palm);
    hand_grip[role] = r2(len(sub(c, o.grip)));
    reach[role] = o.reach;
  }
  const hidden = !!st.hidden;
  return {
    pre, arms: armsTRS, hidden, active,
    metrics: { state: st.name, hand_grip, reach, penetration: r2(Math.max(0, col.pen)), hit: col.pen > 0.3 ? col.hit : null, muzzle, hidden, corrections: flags },
  };
}

/** Violations of one frame (+ visibility when measured). */
export function frameIssues3D(m, visible, W) {
  const out = [];
  for (const [r, v] of Object.entries(m.hand_grip)) if (v > 0.6 * W.scale) out.push(`${r} hand ${v}px off its grip`);
  for (const [r, v] of Object.entries(m.reach)) if (v > W.reach + 0.005) out.push(`${r} arm over-extended (${v} of its length)`);
  if (m.corrections.includes('out_of_reach') && !out.some((x) => /over-extended/.test(x))) out.push('a grip is out of reach');
  if (m.penetration > 0.5) out.push(`gun ${m.penetration}px inside the ${m.hit}`);
  if (m.muzzle) out.push(m.muzzle);
  if (!m.hidden && visible) {
    if (visible.onscreen < 0.015) out.push(`gun off screen (${Math.round(visible.onscreen * 1000) / 10}% of the frame)`);
    else if (visible.visible < 0.2) out.push(`gun only ${Math.round(visible.visible * 100)}% visible past the arms`);
  }
  return out;
}

/** Quaternion -> euler degrees [x, y, z] for R = Rz * Ry * Rx (art_model pose rot). */
export function eulerOfQuat(q) {
  const M = trsMatrix([0, 0, 0], q, [1, 1, 1]);
  const b = Math.asin(clamp(-M[8], -1, 1));
  const a = Math.atan2(M[9], M[10]), c = Math.atan2(M[4], M[0]);
  return [a, b, c].map((v) => Math.round((v * 180) / Math.PI * 1000) / 1000);
}
/** Local TRS -> pose offset {rot} relative to the node's rest rotation (q = rest * qEuler(rot)). */
export function offsetOf(node, trs) {
  const inv = [-node.q[0], -node.q[1], -node.q[2], node.q[3]];
  const rot = eulerOfQuat(qMul(inv, trs.q));
  const at = trs.t.map((v, i) => Math.round((v - node.t[i]) * 1e4) / 1e4);
  return { rot, ...(at.some((v) => Math.abs(v) > 1e-4) ? { at } : {}) };
}
export { qEuler };
