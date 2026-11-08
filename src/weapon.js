// Weapon handling for 2D rigs (art_rig): a held prop with named grip points, attachments that
// mount on sockets, tactical carry states, two-bone hand solving with wrist orientation, reach
// limits, a body collision volume (capsules) with a minimum standoff, muzzle discipline,
// front-view readability (foreshortening floor + yaw cant) and per-frame validation metrics.
//
// The weapon is solved once per frame in a 3D body proxy built from the base view (x forward,
// y down, z lateral: the base view's FK gives x/y, the rest front view gives each part's lateral
// offset), then projected into every drawn view. Hands are solved in each view onto the projected
// grips with the bone foreshortening of the 3D arm solution, so contact holds in all 8 directions.
import { worldOf, applyIK, partIn, poseOf, ikChain, viewPose } from './rig.js';
import { HANDLING_CLASSES, CARRY, DEFAULT_POINTS, DEFAULT_SOCKETS, ATTACHMENT_TYPES } from './handling.js';

export { ATTACHMENT_TYPES };

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;
const adiff = (a, b) => { let d = (b - a) % 360; if (d > 180) d -= 360; if (d < -180) d += 360; return d; };
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len3 = (a) => Math.hypot(a[0], a[1], a[2]);
const norm3 = (a) => { const l = len3(a) || 1; return mul(a, 1 / l); };
const rot2 = (deg, x, y) => { const r = deg * D2R, c = Math.cos(r), s = Math.sin(r); return [x * c - y * s, x * s + y * c]; };
const r2 = (v) => Math.round(v * 100) / 100;

/** Weapon classes -> kind (long gun / pistol): every gun member of the shared handling classes. */
export const WEAPON_CLASSES = Object.fromEntries(Object.values(HANDLING_CLASSES).filter((c) => c.kind === 'long' || c.kind === 'pistol').flatMap((c) => c.members.map((m) => [m, c.kind])));
/** View yaw (deg) of the character relative to the base side view: screen x = x cos - z sin (z + = near side). */
export const VIEW_YAW = { side: 0, front_side: 45, front: 90, back_side: -45, back: -90 };

// Built-in carry states (shared handling data, handling.js CARRY)
const LONG_STATES = CARRY.long;
const PISTOL_STATES = CARRY.pistol;
export const CARRY_STATES = { long: Object.keys(LONG_STATES), pistol: Object.keys(PISTOL_STATES) };
const STATE_KEYS = ['point', 'ref', 'at', 'angle', 'lateral', 'lock', 'fire', 'weld', 'eye', 'cup', 'hidden', 'exempt', 'follow', 'hold', 'base'];

// default points as fractions of the weapon cell (drawn pointing RIGHT in the base view)
const LONG_POINTS = DEFAULT_POINTS.long, PISTOL_POINTS = DEFAULT_POINTS.pistol;
const LONG_SOCKETS = DEFAULT_SOCKETS.long, PISTOL_SOCKETS = DEFAULT_SOCKETS.pistol;
const POINT_NAMES = ['stock', 'grip_main', 'grip_support', 'muzzle', 'optic', 'mag', 'charge'];

/** Default points and sockets of a weapon cell [w, h] (cell px): {points:{name:{x, y, angle, slide}}, sockets:{name:[x, y]}}. */
export function weaponDefaults(kind, [w, h]) {
  const P = kind === 'pistol' ? PISTOL_POINTS : LONG_POINTS, S = kind === 'pistol' ? PISTOL_SOCKETS : LONG_SOCKETS;
  const points = {};
  for (const [k, v] of Object.entries(P)) { const p = pointSpec(v, k, [w, h]); if (p.angle === null) p.angle = 0; p.slide = k === 'grip_support'; points[k] = p; }
  return { points, sockets: Object.fromEntries(Object.entries(S).map(([k, f]) => [k, [f[0] * w, f[1] * h]])) };
}

function pointSpec(v, where, frac = null) {
  if (v === undefined || v === null) return null;
  const o = Array.isArray(v) ? { at: v } : v;
  if (!o || !Array.isArray(o.at) || o.at.length !== 2 || !o.at.every((n) => Number.isFinite(Number(n)))) throw new Error(`${where} must be [x, y] (cell px) or {at:[x, y], angle?}`);
  const at = o.at.map(Number);
  return { x: frac ? at[0] * frac[0] : at[0], y: frac ? at[1] * frac[1] : at[1], angle: o.angle !== undefined ? Number(o.angle) : null, slide: !!o.slide };
}

/** Pixel extents of a part cell in a view: art (opaque columns/rows) or null. */
const artOf = (W, name, view) => W.art?.[name]?.[view] || null;

/**
 * Validate + normalize the rig "weapon" setting and adapt the rig: the weapon becomes a root
 * part (placed by the solver every frame) and attachment parts mount on its sockets.
 */
export function normalizeWeapon(rig, cfg) {
  if (cfg === true) cfg = {};
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) throw new Error('rig "weapon" must be {part?, class?, points?, attachments?, attach?, carry?, ...} (art_help {topic:"rig"})');
  const part = cfg.part ?? 'weapon';
  if (!rig.parts[part]) throw new Error(`weapon.part "${part}" is not a part (parts: ${rig.order.join(', ')})`);
  const cls = cfg.class ?? (cfg.kind === 'pistol' ? 'pistol' : 'rifle');
  const kind = cfg.kind ?? WEAPON_CLASSES[cls];
  if (!kind || !['long', 'pistol'].includes(kind)) throw new Error(`weapon.class must be one of ${Object.keys(WEAPON_CLASSES).join(', ')} (or kind:"long"|"pistol")`);
  const hands = { main: cfg.hands?.main ?? 'hand_f', support: cfg.hands?.support ?? 'hand_b' };
  for (const [role, h] of Object.entries(hands)) {
    if (!rig.parts[h]) throw new Error(`weapon.hands.${role}: no part "${h}" (a hand with a forearm and an upper arm, e.g. hand_f)`);
    ikChain(rig, h);
  }
  if (hands.main === hands.support) throw new Error('weapon.hands: main and support must be different hands');
  const base = cfg.base_view ?? (rig.views.includes('side') ? 'side' : rig.views[0]);
  if (!rig.views.includes(base)) throw new Error(`weapon.base_view "${base}" is not a drawn view`);
  const P = rig.parts[part], frac = [P.w, P.h];
  const pv = partIn(rig, part, base).pivot;
  const defP = kind === 'pistol' ? PISTOL_POINTS : LONG_POINTS, defS = kind === 'pistol' ? PISTOL_SOCKETS : LONG_SOCKETS;
  const points = {};
  for (const k of POINT_NAMES) {
    const user = cfg.points?.[k];
    const p = user !== undefined ? pointSpec(user, `weapon.points.${k}`) : defP[k] ? pointSpec(defP[k], k, frac) : null;
    if (p) { if (p.angle === null) p.angle = defP[k]?.angle ?? 0; if (user !== undefined && typeof user === 'object' && !Array.isArray(user) && user.slide === undefined) p.slide = k === 'grip_support'; else if (user !== undefined && Array.isArray(user)) p.slide = k === 'grip_support'; points[k] = p; }
  }
  for (const k of Object.keys(cfg.points || {})) if (!POINT_NAMES.includes(k)) throw new Error(`weapon.points.${k}: points are ${POINT_NAMES.join(', ')}`);
  if (!points.grip_main) throw new Error('weapon.points.grip_main is required');
  const sockets = {};
  for (const [k, v] of Object.entries({ ...Object.fromEntries(Object.entries(defS).map(([n, f]) => [n, [f[0] * frac[0], f[1] * frac[1]]])), ...(cfg.sockets || {}) })) {
    const s = pointSpec(v, `weapon.sockets.${k}`);
    sockets[k] = [s.x, s.y];
  }
  // attachments: sub-props mounted on sockets; may take over grip_support / muzzle / optic
  const attachments = {};
  for (const [name, a0] of Object.entries(cfg.attachments || {})) {
    if (!/^[\w-]+$/.test(name)) throw new Error(`weapon.attachments: bad name "${name}"`);
    const a = typeof a0 === 'string' ? { type: a0 } : { ...a0 };
    const T = a.type ? ATTACHMENT_TYPES[a.type] : null;
    if (a.type && !T) throw new Error(`weapon.attachments.${name}.type must be one of ${Object.keys(ATTACHMENT_TYPES).join(', ')}`);
    const ap = a.part ?? `att_${name}`;
    if (!rig.parts[ap]) throw new Error(`weapon.attachments.${name}: no part "${ap}" (add the attachment as a part, e.g. parts:{${ap}:{w,h,pivot}}, or give part:<name>)`);
    const socket = a.socket ?? T?.socket ?? 'underbarrel';
    if (!sockets[socket]) throw new Error(`weapon.attachments.${name}: unknown socket "${socket}" (sockets: ${Object.keys(sockets).join(', ')})`);
    const cell = rig.parts[ap], af = [cell.w, cell.h];
    const over = {};
    for (const k of ['grip_support', 'muzzle', 'optic']) {
      const p = a[k] !== undefined ? pointSpec(a[k], `weapon.attachments.${name}.${k}`) : T?.[k] ? pointSpec(T[k], k, af) : null;
      if (p) { if (p.angle === null) p.angle = T?.[k]?.angle ?? points[k]?.angle ?? 0; p.slide = false; over[k] = p; }
    }
    attachments[name] = { name, part: ap, socket, type: a.type ?? null, over };
  }
  const attach = cfg.attach !== undefined ? [].concat(cfg.attach || []) : Object.keys(attachments);
  for (const n of attach) if (!attachments[n]) throw new Error(`weapon.attach: unknown attachment "${n}" (attachments: ${Object.keys(attachments).join(', ') || 'none'})`);
  // custom / overridden states
  const builtIn = kind === 'pistol' ? PISTOL_STATES : LONG_STATES;
  const states = { ...builtIn };
  for (const [n, s] of Object.entries(cfg.states || {})) {
    if (!/^[\w-]+$/.test(n)) throw new Error(`weapon.states: bad name "${n}"`);
    if (!s || typeof s !== 'object') throw new Error(`weapon.states.${n} must be an object`);
    for (const k of Object.keys(s)) if (!STATE_KEYS.includes(k)) throw new Error(`weapon.states.${n}.${k} is not a state field (${STATE_KEYS.join(', ')})`);
    const from = s.base ? states[s.base] : builtIn[n];
    if (s.base && !from) throw new Error(`weapon.states.${n}.base: unknown state "${s.base}"`);
    states[n] = { ...(from || { point: 'grip_main', at: [0.3, 0.6], angle: 30, lock: ['main', 'support'] }), ...s };
    for (const k of ['angle', 'lateral', 'follow']) if (s[k] !== undefined && !Number.isFinite(Number(s[k]))) throw new Error(`weapon.states.${n}.${k} must be a number`);
    if (s.at !== undefined && s.at !== 'pocket' && !(Array.isArray(s.at) && s.at.length === 2 && s.at.every((v) => Number.isFinite(Number(v))))) throw new Error(`weapon.states.${n}.at must be [forward, down] (arm lengths) or "pocket"`);
  }
  const carry = cfg.carry ?? (kind === 'pistol' ? 'low' : 'ready_low');
  if (!states[carry]) throw new Error(`weapon.carry "${carry}" is not a state (${Object.keys(states).join(', ')})`);
  const poses = {};
  for (const [p, s] of Object.entries(cfg.poses || {})) { if (!states[typeof s === 'string' ? s : s?.state]) throw new Error(`weapon.poses.${p}: unknown carry state ${JSON.stringify(s)}`); poses[p] = s; }
  const chain = (h) => ikChain(rig, h);
  const W = {
    part, class: cls, kind, hands, base, points, sockets, attachments, attach, states, carry, poses,
    chains: { main: chain(hands.main), support: chain(hands.support) },
    palm: {}, reach: clamp(Number(cfg.reach ?? 0.98), 0.6, 0.999), cells: cfg.cells === 'view' ? 'view' : 'side',
    // aim_floor / aim_cant: a firing state toward the camera keeps a short barrel canted INWARD
    // (muzzle toward the centre line: aimed at the viewer) instead of the outward carry cant
    foreshorten: cfg.foreshorten === false ? null : { floor: clamp(Number(cfg.foreshorten?.floor ?? 0.42), 0, 1), cant: clamp(Number(cfg.foreshorten?.cant ?? 16), 0, 60), aim_floor: clamp(Number(cfg.foreshorten?.aim_floor ?? 0.24), 0.05, 1), aim_cant: clamp(Number(cfg.foreshorten?.aim_cant ?? 9), 0, 60) },
    min_visible: clamp(Number(cfg.min_visible ?? 0.2), 0, 1), min_visible_back: clamp(Number(cfg.min_visible_back ?? (kind === 'pistol' ? 0 : 0.05)), 0, 1), head: cfg.head ?? (rig.parts.head ? 'head' : null),
    views: cfg.views || {}, cfg,
  };
  // the hands' palm points (hand cell px): where the grip sits in the hand
  for (const role of ['main', 'support']) {
    const h = rig.parts[hands[role]];
    const user = cfg.palm?.[role] ?? (Array.isArray(cfg.palm) ? cfg.palm : undefined);
    W.palm[role] = user ? pointSpec(user, `weapon.palm.${role}`) : { x: h.w / 2, y: Math.min(h.h - 1, Math.max(h.pivot[1] + 1, h.h * 0.56)) };
  }
  if (W.head) {
    const hp = rig.parts[W.head];
    W.eye = cfg.eye ? pointSpec(cfg.eye, 'weapon.eye') : { x: hp.w * 0.74, y: hp.h * 0.46 };
  }
  // the weapon is placed by the solver: make it a root; attachments ride on their sockets
  rig.parts[part] = { ...P, parent: null, at: [0, 0], views: Object.fromEntries(Object.entries(P.views || {}).map(([v, o]) => [v, { ...o, at: undefined }])) };
  if (!rig.roots.includes(part)) rig.roots.push(part);
  for (const a of Object.values(attachments)) {
    const c = rig.parts[a.part], cp = partIn(rig, a.part, base).pivot;
    const s = sockets[a.socket];
    a.mount = [s[0] - pv[0], s[1] - pv[1]];
    a.pivot = cp;
    rig.parts[a.part] = { ...c, parent: part, at: a.mount.slice(), views: Object.fromEntries(Object.entries(c.views || {}).map(([v, o]) => [v, { ...o, at: undefined }])) };
  }
  // magazine (optional part, default "mag"): rides in the mag well at the mag point; a pose hides it
  // while a hand carries it (a part with art:"mag" on the hand) during a reload
  const magPart = cfg.mag_part ?? (rig.parts.mag && rig.parts.mag.parent !== undefined ? 'mag' : null);
  if (magPart) {
    if (!rig.parts[magPart]) throw new Error(`weapon.mag_part "${magPart}" is not a part`);
    if (!points.mag) throw new Error('weapon.mag_part needs a mag point (weapon.points.mag)');
    const c = rig.parts[magPart];
    W.mag = { part: magPart, mount: [points.mag.x - pv[0], points.mag.y - pv[1]] };
    rig.parts[magPart] = { ...c, parent: part, at: W.mag.mount.slice(), views: Object.fromEntries(Object.entries(c.views || {}).map(([v, o]) => [v, { ...o, at: undefined }])) };
  }
  // lateral offsets (z) of every part from the rest front view (screen x of the front view = z)
  W.lat = {};
  if (rig.views.includes('front')) {
    const Wf = worldOf(rig, {}, 'front');
    // lateral z: + = the near side (toward the camera in the side view), which the front view shows at -x
    for (const n of rig.order) W.lat[n] = -(Wf[n].x - rig.root[0]);
  } else for (const n of rig.order) W.lat[n] = 0;
  for (const [n, z] of Object.entries(cfg.lateral || {})) W.lat[n] = Number(z) || 0;
  // arm lengths (base view, rest): shoulder -> elbow -> wrist
  W.arm = {};
  for (const role of ['main', 'support']) {
    const [, fore, hand] = W.chains[role];
    const a1 = partIn(rig, fore, base).at, a2 = partIn(rig, hand, base).at;
    W.arm[role] = { L1: Math.hypot(a1[0], a1[1]), L2: Math.hypot(a2[0], a2[1]) };
    if (!(W.arm[role].L1 > 0 && W.arm[role].L2 > 0)) throw new Error(`weapon: the ${role} arm (${W.chains[role].join(' > ')}) needs non-zero bone lengths (at)`);
  }
  W.A = W.arm.main.L1 + W.arm.main.L2;
  W.standoff = Number(cfg.standoff ?? W.A * 0.06);
  W.pocketUser = cfg.pocket ? pointSpec(cfg.pocket, 'weapon.pocket') : null;
  // body capsule parts
  const has = (n) => !!rig.parts[n];
  W.spine = cfg.body?.spine ?? ['pelvis', 'torso', 'chest', 'neck'].filter(has);
  if (!W.spine.length && has('body')) W.spine = ['body'];
  W.chest = cfg.body?.chest ?? (has('chest') ? 'chest' : W.spine[W.spine.length - 1] ?? null);
  W.legs = cfg.body?.legs ?? [['thigh_f', 'shin_f', 'foot_f'], ['thigh_b', 'shin_b', 'foot_b'], ['leg_f'], ['leg_b']].filter((c) => c.every(has));
  return W;
}

// ---------- geometry ----------
/** Radius of a part across its long axis (art if drawn, else a fraction of the cell). */
function radiusOf(rig, W, name, view, axis = 'w') {
  const art = artOf(W, name, view);
  const p = rig.parts[name];
  if (art && art.n) return Math.max(1, (axis === 'w' ? art.x1 - art.x0 + 1 : art.y1 - art.y0 + 1) * 0.46);
  return Math.max(1, (axis === 'w' ? p.w : p.h) * 0.34);
}

/** Body capsules in the 3D proxy from base-view world transforms. */
function bodyCapsules(rig, W, Wb, freeArms) {
  const caps = [];
  const P3 = (n, off = [0, 0]) => { const T = Wb[n], [dx, dy] = rot2(T.rot, off[0], off[1]); return [T.x + dx, T.y + dy, W.lat[n] ?? 0]; };
  const hasFront = rig.views.includes('front');
  const cap = (kind, name, a, b, r, rz) => caps.push({ kind, name, a, b, r, rz: rz || r });
  // spine: each spine part from its pivot to the next one's pivot (the last one up to the head's pivot)
  for (let i = 0; i < W.spine.length; i++) {
    const n = W.spine[i], next = W.spine[i + 1] ?? (W.head && rig.parts[W.head] ? W.head : null);
    const r = radiusOf(rig, W, n, W.base), rz = hasFront ? radiusOf(rig, W, n, 'front') : r;
    const a = P3(n);
    const b = next ? P3(next) : P3(n, [0, -rig.parts[n].h * 0.8]);
    if (n === 'neck') { cap('torso', n, a, b, Math.min(r, rz) * 0.9, Math.min(r, rz) * 0.9); continue; }
    cap('torso', n, a, b, r, rz);
  }
  if (W.head) {
    const h = rig.parts[W.head], r = radiusOf(rig, W, W.head, W.base) * 0.9;
    const c = P3(W.head, [0, -h.h * 0.45]);
    cap('head', W.head, c, c, r, hasFront ? radiusOf(rig, W, W.head, 'front') * 0.9 : r);
  }
  for (const leg of W.legs) for (let i = 0; i < leg.length; i++) {
    const n = leg[i], next = leg[i + 1];
    const r = radiusOf(rig, W, n, W.base) * 0.9;
    if (/^foot/.test(n)) { const f = rig.parts[n]; const c = P3(n, [f.w * 0.3, 0]); cap('foot', n, c, P3(n, [f.w * 0.6, f.h * 0.3]), Math.max(1.5, f.h * 0.45)); continue; }
    cap('leg', n, P3(n), next ? P3(next) : P3(n, [0, rig.parts[n].h * 0.9]), r);
  }
  for (const role of freeArms) {
    const [up, fore, hand] = W.chains[role];
    cap('arm', up, P3(up), P3(fore), radiusOf(rig, W, up, W.base) * 0.85);
    cap('arm', fore, P3(fore), P3(hand), radiusOf(rig, W, fore, W.base) * 0.85);
  }
  return caps;
}

/** Depth (px) a sphere at q with radius rq sits inside a capsule (elliptical cross-section). */
function capDepth(c, q, rq) {
  const ab = sub(c.b, c.a), L2 = dot(ab, ab);
  const t = L2 > 1e-9 ? clamp(dot(sub(q, c.a), ab) / L2, 0, 1) : 0;
  const d = sub(q, add(c.a, mul(ab, t)));
  const dist = Math.hypot(d[0], d[1], d[2] * (c.r / c.rz));
  return c.r + rq - dist;
}

/** Collision samples of the weapon (+ active attachments) in weapon-local px (relative to the pivot). */
function weaponSamples(rig, W, active) {
  const key = active.join(',');
  W._samples = W._samples || {};
  if (W._samples[key]) return W._samples[key];
  const pv = partIn(rig, W.part, W.base).pivot;
  const out = [];
  const gm = W.points.grip_main, gs = W.points.grip_support;
  const rx0 = gm.x - pv[0] - rig.parts[W.part].w * 0.06, rx1 = (gs ? gs.x : gm.x + rig.parts[W.part].w * 0.25) - pv[0];
  const region = (x) => (x < rx0 ? 'stock' : x <= rx1 ? 'receiver' : 'barrel');
  const fromArt = (name, ox, oy, pvt) => {
    const art = artOf(W, name, W.base);
    if (!art || !art.cols) return false;
    const cols = art.cols, step = Math.max(1, Math.round(cols.length / 28));
    for (let x = 0; x < cols.length; x += step) {
      const c = cols[x];
      if (!c) continue;
      const lx = x + 0.5 - pvt[0] + ox, ly = (c[0] + c[1] + 1) / 2 - pvt[1] + oy;
      out.push({ x: lx, y: ly, r: Math.max(0.75, (c[1] - c[0] + 1) / 2), region: name === W.part ? region(lx) : 'attachment' });
    }
    return true;
  };
  if (!fromArt(W.part, 0, 0, pv)) {
    // no art yet: a line from the stock (or the grip) to the muzzle, plus the magazine
    const p0 = W.points.stock || gm, p1 = W.points.muzzle || { x: rig.parts[W.part].w, y: gm.y };
    const r = Math.max(1, rig.parts[W.part].h * 0.22), n = Math.max(4, Math.round(Math.hypot(p1.x - p0.x, p1.y - p0.y) / 3));
    for (let i = 0; i <= n; i++) { const x = lerp(p0.x, p1.x, i / n) - pv[0], y = lerp(p0.y, p1.y, i / n) - pv[1]; out.push({ x, y, r, region: region(x) }); }
    if (W.points.mag) out.push({ x: W.points.mag.x - pv[0], y: W.points.mag.y - pv[1] - r * 0.5, r, region: 'receiver' });
  }
  for (const n of active) {
    const a = W.attachments[n];
    if (!fromArt(a.part, a.mount[0], a.mount[1], a.pivot)) {
      const c = rig.parts[a.part];
      out.push({ x: a.mount[0] + c.w / 2 - a.pivot[0], y: a.mount[1] + c.h / 2 - a.pivot[1], r: Math.max(1, Math.min(c.w, c.h) * 0.4), region: 'attachment' });
    }
  }
  W._samples[key] = out;
  return out;
}

// ---------- carry states ----------
/** State definition (+ inline overrides) of a carry reference. */
function stateOf(W, c) {
  const name = typeof c === 'string' ? c : c?.state ?? W.carry;
  const s = W.states[name];
  if (!s) throw new Error(`unknown carry state "${name}" (states: ${Object.keys(W.states).join(', ')})`);
  if (typeof c === 'object' && c) {
    const o = { ...s };
    for (const k of STATE_KEYS) if (c[k] !== undefined) o[k] = c[k];
    return { name, ...o };
  }
  return { name, ...s };
}

/** Local weapon point (relative to the base-view pivot), with an attachment taking it over. */
function localPoint(rig, W, name, active) {
  const pv = partIn(rig, W.part, W.base).pivot;
  for (const n of active) {
    const a = W.attachments[n], o = a.over[name];
    if (o) return { x: a.mount[0] + o.x - a.pivot[0], y: a.mount[1] + o.y - a.pivot[1], angle: o.angle, slide: false, from: n };
  }
  const p = W.points[name];
  return p ? { x: p.x - pv[0], y: p.y - pv[1], angle: p.angle, slide: p.slide } : null;
}

/** The weapon's placement for one carry state in the 3D proxy (before reach / collision correction). */
function placeState(rig, W, s, ctx) {
  const { Wb, S3, chestRot, active } = ctx;
  const refRole = s.ref === 'support' ? 'support' : 'main';
  const sh = W.chains[refRole][0];
  const S = S3(sh);
  const theta = Number(s.angle ?? 0) + Number(s.follow ?? 1) * chestRot;
  const u = [Math.cos(theta * D2R), Math.sin(theta * D2R), 0], n = [-Math.sin(theta * D2R), Math.cos(theta * D2R), 0];
  const A = W.arm[refRole];
  const Alen = A.L1 + A.L2;
  let pointName = s.point === 'ground' ? 'grip_main' : s.point;
  let lp = localPoint(rig, W, pointName, active);
  if (!lp) { pointName = 'grip_main'; lp = localPoint(rig, W, 'grip_main', active); }
  const latRef = S[2];
  let T;
  if (s.at === 'pocket') {
    const pk = pocketOf(rig, W, ctx, s.weld ? -0.14 : 0.16);
    T = [S[0] + pk[0], S[1] + pk[1], pk[2]];
  } else if (s.point === 'ground') {
    // on the ground in front of the body: lowest weapon sample on the rest ground row
    const pel = W.spine[0] ? Wb[W.spine[0]] : { x: rig.root[0], y: rig.root[1] };
    const samples = weaponSamples(rig, W, active);
    const low = Math.max(...samples.map((q) => q.y + q.r));
    T = [pel.x + Number(s.at?.[0] ?? 0.75) * Alen, ctx.ground - low + lp.y, latRef * Number(s.lateral ?? 0.3)];
  } else {
    const at = Array.isArray(s.at) ? s.at.map(Number) : [0.3, 0.6];
    const [dx, dy] = rot2(chestRot, at[0] * Alen, at[1] * Alen);
    T = [S[0] + dx, S[1] + dy, latRef * Number(s.lateral ?? 1)];
  }
  let O = sub(T, add(mul(u, lp.x), mul(n, lp.y)));
  O[2] = T[2];
  if (s.at === 'pocket' && ctx.torsoPen) {
    const fwd = [Math.cos(chestRot * D2R), Math.sin(chestRot * D2R), 0];
    for (let k = 0; k < 60 && ctx.torsoPen(O, { u, n }) > 0.3; k++) O = add(O, mul(fwd, 0.5));
  }
  if (s.eye && W.head && ctx.eye) {
    const op = localPoint(rig, W, 'optic', active);
    if (op) { const oy = O[1] + u[1] * op.x + n[1] * op.y; O = [O[0], O[1] + (ctx.eye[1] - oy), O[2]]; }
  }
  const lock = { main: 0, support: 0 };
  for (const r of s.lock || []) if (r === 'main' || r === 'support') lock[r] = 1;
  if (s.cup && W.kind !== 'pistol') lock.support = lock.support && localPoint(rig, W, 'grip_support', active) ? 1 : 0;
  return {
    O, theta, lock, name: s.name, point: pointName, shouldered: s.at === 'pocket', fire: !!s.fire, aimF: s.fire ? 1 : 0, exempt: !!s.exempt, weld: s.weld ? 1 : 0,
    hidden: s.hidden ? 1 : 0, cup: !!s.cup || (W.kind === 'pistol' && !localPoint(rig, W, 'grip_support', active)), hold: s.hold || null, follow: Number(s.follow ?? 1),
  };
}

/** Shoulder pocket: in front of the main shoulder on the chest surface (chest frame), lateral inboard. */
function pocketOf(rig, W, ctx, drop = 0.16) {
  const sh = W.chains.main[0];
  const S = ctx.S3(sh);
  const z = S[2] * 0.62;
  if (W.pocketUser) { const [dx, dy] = rot2(ctx.chestRot, W.pocketUser.x, W.pocketUser.y); return [dx, dy, z]; }
  const chest = W.chest;
  let dx = W.arm.main.L1 * 0.32;
  if (chest && ctx.Wb[chest]) {
    const r = radiusOf(rig, W, chest, W.base), rz = rig.views.includes('front') ? radiusOf(rig, W, chest, 'front') : r;
    const surf = r * Math.sqrt(Math.max(0.05, 1 - (z / Math.max(rz, 1e-6)) ** 2));
    const samples = weaponSamples(rig, W, ctx.active).filter((q) => q.region === 'stock');
    const rs = samples.length ? Math.max(...samples.map((q) => q.r)) * 0.8 : 1;
    const art = artOf(W, chest, W.base), pv = partIn(rig, chest, W.base).pivot;
    const axis = art && art.n ? (art.x0 + art.x1 + 1) / 2 - pv[0] : 0;
    // chest axis x relative to the shoulder in the chest frame
    const C = ctx.Wb[chest], rel = rot2(-ctx.chestRot, C.x - ctx.Wb[sh].x, C.y - ctx.Wb[sh].y);
    dx = rel[0] + axis + surf + rs + 0.5;
  }
  // aiming shrugs the stock up into the pocket under the cheek; carrying keeps it lower
  const [px, py] = rot2(ctx.chestRot, dx, W.arm.main.L1 * drop);
  return [px, py, z];
}

function blendPlacement(a, b, t) {
  if (t <= 0) return a;
  if (t >= 1) return b;
  const pick = t < 0.5 ? a : b;
  return {
    ...pick, O: a.O.map((v, i) => lerp(v, b.O[i], t)), theta: a.theta + adiff(a.theta, b.theta) * t,
    lock: { main: lerp(a.lock.main, b.lock.main, t), support: lerp(a.lock.support, b.lock.support, t) },
    weld: lerp(a.weld, b.weld, t), aimF: lerp(a.aimF ?? 0, b.aimF ?? 0, t), hidden: lerp(a.hidden, b.hidden, t), shouldered: a.shouldered && b.shouldered, blend: [a.name, b.name, r2(t)],
  };
}

/** Resolve a (possibly tweened) carry into a placement. */
function placement(rig, W, carry, ctx) {
  if (carry && typeof carry === 'object' && Array.isArray(carry.mix)) return blendPlacement(placement(rig, W, carry.mix[0], ctx), placement(rig, W, carry.mix[1], ctx), Number(carry.mix[2]));
  return placeState(rig, W, stateOf(W, carry ?? W.carry), ctx);
}

/** Tween two pose carries (state names / objects / mixes) for animatePoses. */
export function lerpCarry(a, b, t) {
  if (a === undefined && b === undefined) return undefined;
  if (t <= 0 || JSON.stringify(a) === JSON.stringify(b)) return a;
  if (t >= 1) return b;
  return { mix: [a ?? null, b ?? null, t] };
}

// ---------- the 3D solve ----------
function frameOf(theta) { return { u: [Math.cos(theta * D2R), Math.sin(theta * D2R), 0], n: [-Math.sin(theta * D2R), Math.cos(theta * D2R), 0] }; }
const at3 = (O, f, p) => [O[0] + f.u[0] * p.x + f.n[0] * p.y, O[1] + f.u[1] * p.x + f.n[1] * p.y, O[2]];

/** Two-bone arm in 3D: elbow toward the pole. */
function arm3(S, T, L1, L2, pole) {
  const d = sub(T, S), D = len3(d);
  const Dc = clamp(D, Math.abs(L1 - L2) + 1e-6, L1 + L2 - 1e-6);
  const dir = D > 1e-9 ? mul(d, 1 / D) : [0, 1, 0];
  const a = Math.acos(clamp((L1 * L1 + Dc * Dc - L2 * L2) / (2 * L1 * Dc), -1, 1));
  let p = sub(pole, mul(dir, dot(pole, dir)));
  if (len3(p) < 1e-6) p = Math.abs(dir[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  p = norm3(sub(p, mul(dir, dot(p, dir))));
  const E = add(S, mul(add(mul(dir, Math.cos(a)), mul(p, Math.sin(a))), L1));
  const Wr = add(S, mul(dir, Dc));
  return { E, W: Wr, D, reach: D / (L1 + L2) };
}

/**
 * Solve the weapon for one pose in the 3D proxy: placement from the carry state, support-grip
 * slide and move-back for reach, push-out for collision (forward first, then outward; about the
 * stock when shouldered), plus metrics.
 */
function solve3D(rig, W0, P, tune) {
  // mirrored handedness: a view of the config with the hand roles swapped (the weapon moves to the other shoulder)
  const W = P.hands_mirrored ? { ...W0, hands: { main: W0.hands.support, support: W0.hands.main }, chains: { main: W0.chains.support, support: W0.chains.main }, arm: { main: W0.arm.support, support: W0.arm.main }, palm: { main: W0.palm.support, support: W0.palm.main } } : W0;
  const roles = W.hands, chains = W.chains;
  // base-view FK with every non-hand IK (planted feet) applied: the body the weapon must clear
  const VPb = viewPose(rig, P, W.base);
  if (VPb.ik) { const ik = { ...VPb.ik }; for (const r of ['main', 'support']) delete ik[roles[r]]; VPb.ik = Object.keys(ik).length ? ik : undefined; }
  const Wb = worldOf(rig, applyIK(rig, VPb, W.base), W.base);
  const S3 = (n) => [Wb[n].x, Wb[n].y, W.lat[n] ?? 0];
  const chestRot = W.chest && Wb[W.chest] ? Wb[W.chest].rot : 0;
  const active = (tune?.attach ?? W.attach).filter((n) => W.attachments[n]);
  let eye = null;
  if (W.head && Wb[W.head]) { const T = Wb[W.head], hp = partIn(rig, W.head, W.base).pivot, [dx, dy] = rot2(T.rot, W.eye.x - hp[0], W.eye.y - hp[1]); eye = [T.x + dx, T.y + dy]; }
  if (W0.ground === undefined) { const R = worldOf(rig, {}, W.base); const ft = W.legs.flat().filter((n) => /^foot|^leg/.test(n)); W0.ground = ft.length ? Math.max(...ft.map((n) => R[n].y + rig.parts[n].h - 1 - rig.parts[n].pivot[1])) : rig.root[1]; }
  const torso = bodyCapsules(rig, W, Wb, []).filter((c) => c.kind === 'torso');
  const torsoPen = (Ow, f) => { let worst = 0; for (const q of weaponSamples(rig, W, active)) { const p = at3(Ow, f, q); for (const c of torso) worst = Math.max(worst, capDepth(c, p, q.r + (q.region === 'receiver' ? W.standoff : 0))); } return worst; };
  const ctx = { Wb, S3, chestRot, active, eye, ground: W0.ground, torsoPen };
  const pl = placement(rig, W, P.carry ?? W.carry, ctx);
  const flags = [];
  let { O, theta } = pl;
  const f0 = frameOf(theta);
  const gm = localPoint(rig, W, 'grip_main', active);
  let gs = localPoint(rig, W, 'grip_support', active);
  const lock = { ...pl.lock };
  if (pl.hold === 'support') { lock.main = 0; }
  // grips: the support hand cups the trigger hand on one-handed weapons
  const palm = (role) => W.palm[role];
  const handPivot = (role) => partIn(rig, roles[role], W.base).pivot;
  const wristOf = (role, Ow, f, grip, alpha) => {
    const g = at3(Ow, f, grip), r = Math.atan2(f.u[1], f.u[0]) * R2D + alpha;
    const pp = palm(role), hp = handPivot(role), [dx, dy] = rot2(r, pp.x - hp[0], pp.y - hp[1]);
    return { grip: g, wrist: [g[0] - dx, g[1] - dy, g[2]], rot: r };
  };
  const cupOf = (f) => { const h = rig.parts[roles.main]; return { x: gm.x + h.h * 0.12, y: gm.y + h.h * 0.24, angle: gm.angle + 14 }; };
  const supportGrip = (f, slide = 0) => (pl.cup || !gs ? cupOf(f) : { ...gs, x: gs.x - slide });
  const holdGrip = pl.hold === 'support' ? gm : null; // one-handed carry in the support hand: it holds the main grip
  // shoulder protraction: a reaching shoulder slides forward / inward (scapula) up to a limit,
  // only as far as the reach needs (the support side protracts more, as when blading in)
  const protractMax = { main: W.arm.main.L1 * 0.14, support: W.arm.support.L1 * 0.36 };
  const shoulderFor = (role, wrist) => {
    const A = W.arm[role], S = S3(chains[role][0]);
    const d = sub(wrist, S), need = len3(d) - W.reach * (A.L1 + A.L2);
    if (need <= 0) return { S, off: [0, 0, 0] };
    const dir = norm3([d[0], d[1] * 0.25, d[2]]);
    const k = Math.min(need + 0.25, protractMax[role]);
    let off = mul(dir, k);
    // moving along dir shortens the reach by less than k when dir is off-axis: refine once
    const gain = len3(d) - len3(sub(wrist, add(S, off)));
    if (gain > 1e-6 && gain < need + 0.25) off = mul(dir, Math.min(protractMax[role], k * (need + 0.25) / gain));
    return { S: add(S, off), off };
  };
  const reachOf = (role, Ow, f, slide = 0) => {
    const A = W.arm[role];
    const grip = role === 'main' ? gm : holdGrip || supportGrip(f, slide);
    const w = wristOf(role, Ow, f, grip, grip.angle ?? 0);
    return len3(sub(w.wrist, shoulderFor(role, w.wrist).S)) / (A.L1 + A.L2);
  };
  const reachOK = (Ow, f, slide = 0) => (lock.main < 0.5 || reachOf('main', Ow, f) <= W.reach + 1e-6) && (lock.support < 0.5 || reachOf('support', Ow, f, slide) <= W.reach + 1e-6);
  // 1. reach: slide the support hand back along a rail, then move the weapon back along its axis
  let slide = 0;
  if (lock.support >= 0.5 && !pl.cup && gs && gs.slide && reachOf('support', O, f0) > W.reach) {
    const max = Math.max(0, (gs.x - gm.x) * 0.55);
    if (reachOf('support', O, f0, max) <= W.reach) { let lo = 0, hi = max; for (let i = 0; i < 18; i++) { const m = (lo + hi) / 2; if (reachOf('support', O, f0, m) <= W.reach) hi = m; else lo = m; } slide = hi; } else slide = max;
    flags.push('support_slid');
  }
  if (!reachOK(O, f0, slide)) {
    if (!pl.shouldered) {
      const back = (d) => sub(O, mul(f0.u, d));
      const maxB = W.A * 0.9;
      if (reachOK(back(maxB), f0, slide)) { let lo = 0, hi = maxB; for (let i = 0; i < 20; i++) { const m = (lo + hi) / 2; if (reachOK(back(m), f0, slide)) hi = m; else lo = m; } O = back(hi); flags.push('moved_back'); }
      else { O = back(maxB); flags.push('out_of_reach'); }
    } else flags.push('out_of_reach');
  }
  // 2. collision with the body capsules (free arms are obstacles too)
  const free = ['main', 'support'].filter((r) => lock[r] < 0.5);
  const caps = bodyCapsules(rig, W, Wb, free);
  const samples = weaponSamples(rig, W, active);
  const penOf = (Ow, f) => {
    let worst = 0, hit = null;
    for (const s of samples) {
      const q = at3(Ow, f, s);
      for (const c of caps) {
        if (c.kind === 'head' && (s.region === 'stock' || pl.weld)) continue; // cheek weld = contact
        const extra = s.region === 'receiver' && c.kind === 'torso' ? W.standoff : 0;
        const d = capDepth(c, q, s.r + extra);
        if (d > worst) { worst = d; hit = c.name; }
      }
    }
    return { pen: worst, hit };
  };
  let f = f0;
  let col = penOf(O, f);
  const TOL = 0.6;
  if ((col.pen > TOL || !reachOK(O, f0, slide)) && !pl.hidden) {
    const fwd = [Math.cos(chestRot * D2R), Math.sin(chestRot * D2R), 0], outward = [0, 0, Math.sign(S3(chains.main[0])[2]) || 1];
    let best = null, least = { O, f: f0, score: col.pen, pen: col, tag: null };
    const excess = (Oc, fc) => Math.max(0, lock.main >= 0.5 ? reachOf('main', Oc, fc) - W.reach : 0) + Math.max(0, lock.support >= 0.5 ? reachOf('support', Oc, fc, slide) - W.reach : 0);
    const consider = (Oc, fc, cost, tag) => {
      if (best && cost >= best.cost) return;
      const ex = excess(Oc, fc);
      const p = penOf(Oc, fc);
      if (p.pen <= TOL && ex <= 1e-6) { best = { O: Oc, f: fc, cost, tag, pen: p }; return; }
      const score = Math.max(0, p.pen - TOL) + 40 * ex;
      if (score < least.score - 1e-6) least = { O: Oc, f: fc, score, pen: p, tag };
    };
    const stk = localPoint(rig, W, pl.point, active) || gm;
    const step = W.A / 30;
    if (pl.shouldered) {
      // keep the stock in the pocket: turn about it (muzzle up or down), then push forward off it
      const pivot = at3(O, f0, stk);
      // the pocket is a region: the stock may also slide inward on the chest (toward the support side)
      for (let j = 0; j <= 12; j++) for (let k = 0; k <= 14; k++) for (const sgn of [-1, 1]) {
        if (!j && !k) continue;
        const th = theta + sgn * k * 2, fc = frameOf(th), pj = add(pivot, mul(outward, -j * step));
        consider(sub(pj, [fc.u[0] * stk.x + fc.n[0] * stk.y, fc.u[1] * stk.x + fc.n[1] * stk.y, 0]), fc, k * 2 * 0.25 + j * step * 2, j ? 'pocket_inward' : 'turned');
      }
      for (let i = 1; i <= 15; i++) consider(add(O, mul(fwd, i * step)), f0, 1.5 + i * step * 3, 'pushed_forward');
    } else {
      // forward first, then outward; backward / inward only to bring a grip into reach
      for (let i = -20; i <= 30; i++) for (let j = -12; j <= 18; j++) {
        if (!i && !j) continue;
        const cost = (i < 0 ? 2.5 : 1) * Math.abs(i) * step + (j < 0 ? 2.5 : 1.6) * Math.abs(j) * step;
        consider(add(add(O, mul(fwd, i * step)), mul(outward, j * step)), f0, cost, j > 0 ? 'pushed_out' : j < 0 ? 'pulled_in' : i > 0 ? 'pushed_forward' : 'moved_back');
      }
    }
    if (best) { O = best.O; f = best.f; theta = Math.atan2(f.u[1], f.u[0]) * R2D; col = best.pen; flags.push(best.tag); const k = flags.indexOf('out_of_reach'); if (k >= 0) flags.splice(k, 1); }
    else {
      if (least.tag) { O = least.O; f = least.f; theta = Math.atan2(f.u[1], f.u[0]) * R2D; col = least.pen; flags.push(least.tag); }
      if (col.pen > TOL) flags.push('penetrates');
    }
  }
  // 3. muzzle discipline
  if (tune?.fix && !pl.fire && !pl.exempt) {
    for (let k = 0; k < 6 && muzzleFlag(rig, W, O, f, theta, pl, caps, active); k++) { theta += 8; const fc = frameOf(theta); const pv = at3(O, f, gm); O = sub(pv, [fc.u[0] * gm.x + fc.n[0] * gm.y, fc.u[1] * gm.x + fc.n[1] * gm.y, 0]); f = fc; }
  }
  const flag = pl.hidden >= 0.5 ? null : muzzleFlag(rig, W, O, f, theta, pl, caps, active);
  const reach = { main: lock.main >= 0.5 ? reachOf('main', O, f) : null, support: lock.support >= 0.5 ? reachOf('support', O, f, slide) : null };
  // 3D arm solutions (for bone foreshortening and the elbow side in every view)
  const arms = {};
  for (const role of ['main', 'support']) {
    const A = W.arm[role];
    const grip = role === 'main' ? gm : holdGrip || supportGrip(f, slide);
    const w = wristOf(role, O, f, grip, grip.angle ?? 0);
    const sp = lock[role] >= 0.5 ? shoulderFor(role, w.wrist) : { S: S3(chains[role][0]), off: [0, 0, 0] };
    const S = sp.S;
    const pole = norm3([-0.15, 1, (Math.sign(S3(chains[role][0])[2]) || 1) * (role === 'main' ? 0.7 : 0.45)]);
    arms[role] = { ...arm3(S, w.wrist, A.L1, A.L2, pole), S, grip, A, protract: sp.off };
  }
  return { O, theta, f, pl, lock, slide, flags, pen: col.pen, hit: col.hit, flag, reach, arms, roles, chains, active, gm, supportGrip: holdGrip || supportGrip(f, slide), S3, Wb, eye, caps, W };
}

/** Muzzle discipline: the muzzle ray must miss the own body; outside firing states it points down. */
function muzzleFlag(rig, W, O, f, theta, pl, caps, active) {
  if (pl.exempt || pl.hidden >= 0.5) return null;
  const m = localPoint(rig, W, 'muzzle', active);
  if (m) {
    const M = at3(O, f, m);
    for (let d = 2; d <= W.A * 3; d += 2) {
      const q = add(M, mul(f.u, d));
      for (const c of caps) if (c.kind !== 'arm' && capDepth(c, q, 0.5) > 0) return `points at own ${c.name}`;
    }
  }
  if (!pl.fire && pl.name !== 'ready_high' && theta > -15 && theta < 10) return `muzzle level (${r2(theta)} deg) outside a firing state: flags squadmates`;
  return null;
}

// ---------- per-view projection ----------
function viewAxes(W, view) {
  const yaw = Number(W.views?.[view]?.yaw ?? VIEW_YAW[view] ?? 0);
  return { x: Math.cos(yaw * D2R), z: Math.sin(yaw * D2R), yaw };
}

/**
 * Solve a pose for one drawn view with the weapon: places the weapon (+ attachments), locks the
 * hands onto their grips (wrist rotation, foreshortened bones, elbows matching the 3D arm),
 * welds the cheek to the optic line when shouldered, then solves the remaining pose IK.
 * -> {VP, report}
 */
export function solveHeld(rig, P, src) {
  const W = rig.weapon;
  const tune = P._weapon || null;
  const s = solve3D(rig, W, P, tune);
  const VP = viewPose(rig, P, src);
  const ax = viewAxes(W, src);
  const proj = (d) => [ax.x * d[0] - ax.z * d[2], d[1]];
  const ik = { ...(VP.ik || {}) };
  for (const r of ['main', 'support']) if (s.lock[r] >= 0.999) delete ik[s.roles[r]];
  // pose IK ends of the locked hands blend with the lock; keep them for the free share
  const freeIK = {};
  for (const r of ['main', 'support']) if (ik[s.roles[r]]) { freeIK[r] = ik[s.roles[r]]; delete ik[s.roles[r]]; }
  delete VP.ik;
  // weapon in this view
  let Wv = worldOf(rig, VP, src);
  const anchorRole = s.pl.ref === 'support' || s.pl.hold === 'support' ? 'support' : 'main';
  const shA = s.chains[anchorRole][0];
  const anc = localPoint(rig, W, s.pl.point, s.active) || s.gm;
  const anc3 = at3(s.O, s.f, anc);
  const pa = proj(sub(anc3, s.S3(shA)));
  const ancScr = [Wv[shA].x + pa[0], Wv[shA].y + pa[1]];
  const side = Math.abs(s.O[2]) > 2 ? Math.sign(s.O[2]) : Math.sign(s.S3(s.chains.main[0])[2]) || 1;
  let { Mu, L, canted } = projectWeapon(W, s.f.u, src, { aimF: tune?.cant !== undefined ? 0 : s.pl.aimF ?? 0, weld: s.pl.weld, out: Math.sign(s.S3(s.chains.main[0])[2]) || 1, side, tune });
  const viewCell = W.cells === 'view' && src !== W.base;
  const flipW = !viewCell && Mu[0] < 0;
  const phi = flipW ? Math.atan2(-Mu[1], -Mu[0]) * R2D : Math.atan2(Mu[1], Mu[0]) * R2D;
  const sxs = viewCell ? 1 : flipW ? -L : L;
  const scr = (p) => { const [dx, dy] = rot2(phi, sxs * (p.x - anc.x), p.y - anc.y); return [ancScr[0] + dx, ancScr[1] + dy]; };
  const handDir = (alpha) => { const hl = rot2(alpha, 0, 1); const [dx, dy] = rot2(phi, sxs * hl[0], hl[1]); return [dx, dy]; };
  const O2 = scr({ x: 0, y: 0 });
  // pose IK targets on weapon points: {weapon:"mag", at?:[dx,dy]} (weapon cell px), also inside tweened mixes
  const resolveT = (t) => {
    if (!t || Array.isArray(t) || typeof t !== 'object') return t;
    if (t.mix) return { mix: [resolveT(t.mix[0]), resolveT(t.mix[1]), t.mix[2]] };
    if (t.weapon === undefined) return t;
    const pv = partIn(rig, W.part, W.base).pivot, q = W.sockets[t.weapon];
    const p = localPoint(rig, W, t.weapon, s.active) || (q ? { x: q[0] - pv[0], y: q[1] - pv[1] } : null);
    if (!p) throw new Error(`ik target {weapon:"${t.weapon}"}: points are ${POINT_NAMES.join(', ')}; sockets ${Object.keys(W.sockets).join(', ')}`);
    const o = (t.at || [0, 0]).map(Number);
    return scr({ x: p.x + o[0], y: p.y + o[1] });
  };
  for (const r of Object.keys(freeIK)) freeIK[r] = { ...freeIK[r], target: resolveT(freeIK[r].target) };
  // cheek weld: turn the head so the eye sits on the optic line (base view; projected tilt elsewhere)
  let weld = 0;
  if (s.pl.weld > 0 && W.head && s.eye && Wv[W.head]) {
    const op = localPoint(rig, W, 'optic', s.active);
    if (op) {
      const T = s.Wb[W.head], hp = partIn(rig, W.head, W.base).pivot, o3 = at3(s.O, s.f, op);
      const tanT = Math.tan(s.theta * D2R);
      const miss = (d) => { const [ex, ey] = rot2(T.rot + d, W.eye.x - hp[0], W.eye.y - hp[1]); const X = T.x + ex, Y = T.y + ey; return Y - (o3[1] + tanT * (X - o3[0])); };
      const lim = Number(W.cfg.weld_limit ?? 18);
      let lo = -lim, hi = lim;
      if (miss(lo) * miss(hi) <= 0) { for (let i = 0; i < 24; i++) { const m = (lo + hi) / 2; if (miss(lo) * miss(m) <= 0) hi = m; else lo = m; } weld = (lo + hi) / 2; }
      else weld = Math.abs(miss(lo)) < Math.abs(miss(hi)) ? lo : hi;
      weld *= s.pl.weld * Math.abs(ax.x);
      if (Math.abs(weld) > 1e-6) VP[W.head] = { ...(VP[W.head] || {}), rot: Number(VP[W.head]?.rot ?? 0) + weld };
    }
    // facing the camera: the cheek goes down onto the stock, so the head tilts toward it
    if (ax.yaw > 0 && Math.abs(ax.z) > 0.3) {
      const st = localPoint(rig, W, 'stock', s.active) || anc;
      const side = Math.sign(scr(st)[0] - Wv[W.head].x) || 1;
      const tilt = s.pl.weld * Number(W.cfg.weld_tilt ?? 10) * Math.abs(ax.z) * side;
      if (Math.abs(tilt) > 1e-6) { VP[W.head] = { ...(VP[W.head] || {}), rot: Number(VP[W.head]?.rot ?? 0) + tilt }; weld += tilt; }
    }
  }
  // weapon (root part) + attachments
  const wpi = partIn(rig, W.part, src);
  const hide = s.pl.hidden >= 0.5;
  // draw order from depth: a weapon held in front of the torso is drawn over it, one behind it
  // under it (the authored view z is kept when it already agrees); layer rules / pins override
  const layer = weaponLayer(rig, W, s, src, ax, P, tune);
  const zw = layer.z;
  if (layer.supportZ !== undefined) VP[s.roles.support] = { ...(VP[s.roles.support] || {}), z: layer.supportZ };
  VP[W.part] = { x: O2[0] - rig.root[0] - wpi.at[0], y: O2[1] - rig.root[1] - wpi.at[1], rot: phi, sx: viewCell ? 1 : L, sy: 1, ...(flipW ? { flipx: true } : {}), ...(viewCell || src === W.base ? {} : { cell: W.base }), ...(hide ? { hide: true } : {}), ...(zw !== undefined ? { z: zw } : {}) };
  for (const [n, a] of Object.entries(W.attachments)) {
    const on = s.active.includes(n);
    const psx = rig.scaleChildren ? (viewCell ? 1 : L) : 1;
    VP[a.part] = { x: a.mount[0] * ((viewCell ? 1 : L) - psx), y: 0, rot: 0, sx: viewCell ? 1 : L, sy: 1, ...(viewCell || src === W.base ? {} : { cell: W.base }), ...(!on || hide ? { hide: true } : {}), ...(zw !== undefined ? { z: zw + 0.01 } : {}) };
  }
  if (W.mag) {
    // the magazine rides in the mag well (just under the receiver) unless the pose took it out
    const psx = rig.scaleChildren ? (viewCell ? 1 : L) : 1, own = VP[W.mag.part];
    VP[W.mag.part] = { x: W.mag.mount[0] * ((viewCell ? 1 : L) - psx), y: 0, rot: 0, sx: viewCell ? 1 : L, sy: 1, ...(viewCell || src === W.base ? {} : { cell: W.base }), ...(hide || own?.hide ? { hide: true } : {}), ...(zw !== undefined ? { z: zw - 0.005 } : {}) };
  }
  // hands
  const grips = {};
  const handOut = {};
  for (const role of ['main', 'support']) {
    const w = s.lock[role];
    const [up, fore, hand] = s.chains[role];
    const grip = role === 'main' ? s.gm : s.supportGrip;
    const g = role === 'support' && s.pl.cup && s.pl.hold !== 'support' ? null : scr(grip);
    if (!(w > 0.001)) {
      if (freeIK[role]) ik[s.roles[role]] = freeIK[role];
      continue;
    }
    // the grip point in screen space (a cup sits on the trigger hand's palm)
    let gp = g;
    if (!gp) gp = scr(grip);
    const d = handDir(grip.angle ?? 0), Lh = Math.hypot(d[0], d[1]);
    const rh = Math.atan2(-d[0], d[1]) * R2D;
    const syh = clamp(Lh, 0.6, 1);
    const hp = partIn(rig, hand, src).pivot, pp = s.W.palm[role];
    const [ox, oy] = rot2(rh, pp.x - hp[0], (pp.y - hp[1]) * syh);
    const target = [gp[0] - ox, gp[1] - oy];
    // locked solution on a copy
    const Q = { ...VP };
    const arm = s.arms[role];
    // protracted shoulder: move the upper arm's joint in its parent's frame
    const pd = proj(arm.protract || [0, 0, 0]);
    if (Math.abs(pd[0]) + Math.abs(pd[1]) > 1e-6) {
      const par = rig.parts[up].parent, [lx, ly] = rot2(-(par ? Wv[par].rot : 0), pd[0], pd[1]);
      Q[up] = { ...(Q[up] || {}), x: Number(Q[up]?.x ?? 0) + lx, y: Number(Q[up]?.y ?? 0) + ly };
    }
    if (rig.scaleChildren) {
      const su = clamp(Math.hypot(...proj(sub(arm.E, arm.S))) / arm.A.L1, 0.3, 1), sf = clamp(Math.hypot(...proj(sub(arm.W, arm.E))) / arm.A.L2, 0.3, 1);
      Q[up] = { ...(Q[up] || {}), sy: su };
      Q[fore] = { ...(Q[fore] || {}), sy: sf };
    }
    Q[hand] = { ...(Q[hand] || {}), sy: syh, sx: 1 };
    let Wq = worldOf(rig, Q, src);
    const S2 = [Wq[up].x, Wq[up].y];
    const l1 = Math.hypot(Wq[fore].x - S2[0], Wq[fore].y - S2[1]), l2 = Math.hypot(Wq[hand].x - Wq[fore].x, Wq[hand].y - Wq[fore].y);
    const D = Math.hypot(target[0] - S2[0], target[1] - S2[1]);
    if (rig.scaleChildren && D > (l1 + l2) * 0.997) {
      // the view's bones are foreshortened too much for this target: lengthen toward full length
      const su = poseOf(rig, Q, up).sy, sf = poseOf(rig, Q, fore).sy;
      const ra = arm.A.L1 * (1 - su), rb = arm.A.L2 * (1 - sf);
      const k = ra + rb > 1e-9 ? clamp((D / 0.997 - (l1 + l2)) / (ra + rb), 0, 1) : 0;
      Q[up] = { ...Q[up], sy: su + k * (1 - su) };
      Q[fore] = { ...Q[fore], sy: sf + k * (1 - sf) };
      Wq = worldOf(rig, Q, src);
    }
    if (rig.scaleChildren) {
      // target inside the minimum reach |l1 - l2| (pointing at the camera): shorten the longer bone
      const a1 = Math.hypot(Wq[fore].x - Wq[up].x, Wq[fore].y - Wq[up].y), a2 = Math.hypot(Wq[hand].x - Wq[fore].x, Wq[hand].y - Wq[fore].y);
      const D2 = Math.hypot(target[0] - Wq[up].x, target[1] - Wq[up].y);
      if (Math.abs(a1 - a2) > D2 * 0.9) {
        const long = a1 > a2 ? up : fore, cur = poseOf(rig, Q, long).sy, other = Math.min(a1, a2), full = a1 > a2 ? a1 : a2;
        Q[long] = { ...Q[long], sy: Math.max(0.12, cur * ((other + D2 * 0.85) / full)) };
        Wq = worldOf(rig, Q, src);
      }
    }
    // elbow side: the one closest to the projected 3D elbow
    const pe = proj(sub(arm.E, arm.S)), Ev = [Wv[up].x + pd[0] + pe[0], Wv[up].y + pd[1] + pe[1]];
    if (rig.scaleChildren && ax.yaw < 0 && Math.abs(ax.x) < 0.5 && W.cfg.back_elbow !== false) {
      // seen from behind the arm points mostly away from the camera, so 2D IK on short projected
      // bones folds it (elbow flipped above the shoulder). Use the 3D arm projected instead: the
      // upper arm runs to the projected elbow, the forearm from there to the grip (bone lengths =
      // the projected distances, capped at full length), so the elbow sits where the 3D one is.
      const su = poseOf(rig, Q, up).sy, sf = poseOf(rig, Q, fore).sy;
      const full1 = Math.hypot(Wq[fore].x - Wq[up].x, Wq[fore].y - Wq[up].y) / (su || 1), full2 = Math.hypot(Wq[hand].x - Wq[fore].x, Wq[hand].y - Wq[fore].y) / (sf || 1);
      const l1 = Math.hypot(Ev[0] - Wq[up].x, Ev[1] - Wq[up].y), l2 = Math.hypot(target[0] - Ev[0], target[1] - Ev[1]);
      if (full1 > 1e-6 && full2 > 1e-6 && l2 <= full2 * 1.02) {
        Q[up] = { ...Q[up], sy: clamp(l1 / full1, 0.12, 1) };
        Q[fore] = { ...Q[fore], sy: clamp(l2 / full2, 0.12, 1) };
        Wq = worldOf(rig, Q, src);
      }
    }
    let bend = 1, bestD = Infinity;
    for (const b of [1, -1]) {
      const R = applyIK(rig, { ...Q, ik: { [hand]: { target, bend: b } } }, src);
      const We = worldOf(rig, R, src)[fore];
      const dd = Math.hypot(We.x - Ev[0], We.y - Ev[1]);
      if (dd < bestD - 1e-9) { bestD = dd; bend = b; }
    }
    if (tune?.flip_elbow?.includes(role)) bend = -bend;
    const L = applyIK(rig, { ...Q, ik: { [hand]: { target, bend, rot: rh } } }, src);
    if (w >= 0.999) { for (const n of [up, fore, hand]) VP[n] = L[n]; }
    else {
      // fade between the free arm (pose IK / FK) and the locked arm
      const F = freeIK[role] ? applyIK(rig, { ...VP, ik: { [hand]: freeIK[role] } }, src) : VP;
      for (const n of [up, fore, hand]) {
        const a = poseOf(rig, F, n), b = poseOf(rig, L, n);
        VP[n] = { ...(VP[n] || {}), x: lerp(a.x, b.x, w), y: lerp(a.y, b.y, w), rot: a.rot + adiff(a.rot, b.rot) * w, sy: lerp(a.sy, b.sy, w), sx: lerp(a.sx, b.sx, w) };
      }
    }
    grips[role] = gp;
    handOut[role] = { hand, up, fore, target, bend, grip: gp, palm: pp, weight: w };
  }
  for (const [end, e] of Object.entries(ik)) if (e?.target) ik[end] = { ...e, target: resolveT(e.target) };
  const out = Object.keys(ik).length ? applyIK(rig, { ...VP, ik }, src) : VP;
  delete out.ik;
  if (Object.keys(ik).length) out.ik = ik;
  return { VP: out, report: { s, view: src, grips, hands: handOut, canted, L, weld, phi, flip: flipW, scr, layer } };
}

/**
 * Screen direction of the weapon axis u (3D proxy, x forward, y down, z near side) in a drawn view,
 * with the readability rules: barrel toward the camera -> outward cant + length floor when carried,
 * inward cant + short floor when aimed (aimF), back-facing views -> muzzle angled out past the
 * silhouette (longer when shouldered, weld). Shared by the solver and the weapon world sheets so a
 * sheet cell and a frame agree. -> {Mu:[dx, dy] (length = foreshortening), L, canted}
 */
export function projectWeapon(W, u, view, { aimF = 0, weld = 0, out = 1, side = 1, tune = null } = {}) {
  const ax = viewAxes(W, view);
  const proj = (d) => [ax.x * d[0] - ax.z * d[2], d[1]];
  let Mu = proj(u);
  let L = Math.hypot(Mu[0], Mu[1]);
  const fs = W.foreshorten ? { floor: tune?.floor ?? W.foreshorten.floor, cant: tune?.cant ?? W.foreshorten.cant } : null;
  let canted = false;
  // the back view proper (back_side keeps the 2D rule below: the barrel already reads there)
  const backFacing = fs && ax.yaw < 0 && Math.abs(ax.x) < 0.5;
  if (backFacing) {
    // back-facing views: the gun is in front of the body, away from the camera. Yaw it OUTWARD in 3D
    // (about the vertical axis, toward the weapon side) just enough that the barrel reads past the
    // silhouette (outward share >= sin(back_cant)) and is at least back_floor long, then project:
    // the pitch is kept (a level gun stays level), the result is continuous over frames, and it
    // does not depend on the carry state, so sheet cells and frames agree.
    const outS = Math.sign(-ax.z * side) || 1;
    const minX = Math.sin(Number(W.cfg.foreshorten?.back_cant ?? 45) * D2R);
    const Lmin = Number(tune?.back_floor ?? W.cfg.foreshorten?.back_floor ?? 0.55);
    const yawed = (c) => { const k = Math.cos(c), q = Math.sin(c); return proj([u[0] * k - u[2] * q, u[1], u[0] * q + u[2] * k]); };
    const good = (m) => { const l = Math.hypot(m[0], m[1]); return l >= Lmin - 1e-6 && (m[0] * outS) / (l || 1) >= minX - 1e-6; };
    if (!good(Mu)) {
      // the yaw sign that moves the projection outward, then the smallest angle that is good
      const sg = yawed(0.2)[0] * outS > yawed(-0.2)[0] * outS ? 1 : -1;
      let lo = 0, hi = Math.PI / 2;
      if (good(yawed(sg * hi))) { for (let i = 0; i < 30; i++) { const m = (lo + hi) / 2; if (good(yawed(sg * m))) hi = m; else lo = m; } }
      Mu = yawed(sg * hi);
      L = Math.hypot(Mu[0], Mu[1]);
      // one length for every yawed back view (back_floor): the projected length would otherwise
      // swing with the pitch (0.7 at 30 deg, 1.0 at 45), which pitch-stepped sheet cells cannot follow
      Mu = [Mu[0] * Lmin / (L || 1), Mu[1] * Lmin / (L || 1)]; L = Lmin;
      canted = 'back';
    }
    if (L < 0.05) { Mu = [Mu[0] / (L || 1) * 0.05, Mu[1] / (L || 1) * 0.05]; L = 0.05; }
    return { Mu, L, canted };
  }
  if (fs && L < fs.floor - 1e-9 && view !== W.base) {
    // barrel toward / away from the camera: carried, yaw it outward a little and keep a readable
    // length; aimed (firing states), keep it short and canted INWARD so the muzzle sits near the
    // centre line and the gun reads as pointing at the viewer (blended by the firing weight)
    const f = clamp(Number(aimF), 0, 1);
    const cdeg = lerp(fs.cant, -W.foreshorten.aim_cant, f), floor = lerp(fs.floor, W.foreshorten.aim_floor, f), c = cdeg * D2R;
    const uc = [u[0] * Math.cos(c), u[1], Math.hypot(u[0], u[2]) * Math.sin(c) * out];
    Mu = proj(uc);
    L = Math.hypot(Mu[0], Mu[1]);
    if (L < 1e-6) { Mu = [(f >= 0.5 ? 1 : -1) * ax.z * out || 1, 0]; L = 1; }
    if (L < floor) { Mu = [Mu[0] * floor / L, Mu[1] * floor / L]; L = floor; }
    canted = f >= 0.5 ? 'inward' : true;
  }
  // back_side views: keep the muzzle angled out past the silhouette on the weapon side so it reads
  if (fs && ax.yaw < 0 && Math.abs(ax.x) < 0.8) {
    const outS = Math.sign(-ax.z * side) || 1;
    const minX = Math.sin(Number(W.cfg.foreshorten?.back_cant ?? 45) * D2R);
    const dx = Mu[0] / L, dy = Mu[1] / L;
    if (dx * outS < minX) {
      // shouldered aim: long enough to clear a broad torso (back_floor; the grips stay in reach)
      const wb = clamp(weld / 0.25, 0, 1);
      const Lb = Math.max(L, lerp(L, Number(W.cfg.foreshorten?.back_floor ?? 0.55), wb));
      Mu = [outS * minX * Lb, (Math.sign(dy) || 1) * Math.sqrt(1 - minX * minX) * Lb]; L = Lb; canted = true;
    }
  }
  if (L < 0.05) { Mu = [Mu[0] / (L || 1) * 0.05, Mu[1] / (L || 1) * 0.05]; L = 0.05; }
  return { Mu, L, canted };
}

/** Depth toward the camera of a 3D proxy point in a view. */
const depthIn = (ax, p) => p[0] * ax.z + p[2] * ax.x;

/**
 * Weapon draw order in one view: projected depth of the weapon vs the torso decides front /
 * back; weapon.layer {above:[parts], below:[parts], pin:{<view>: "front"|"back"|z}} override.
 * -> {z (undefined = authored), reason, front}
 */
function weaponLayer(rig, W, s, src, ax, P, tune) {
  const zOf = (n) => partIn(rig, n, src).z;
  const torso = W.spine.filter((n) => rig.parts[n]);
  const zt = torso.length ? torso.map(zOf) : [0];
  const tMax = Math.max(...zt), tMin = Math.min(...zt);
  const authored = zOf(W.part);
  const g3 = at3(s.O, s.f, s.gm);
  const chest = W.chest && s.Wb[W.chest] ? [s.Wb[W.chest].x, s.Wb[W.chest].y, 0] : [rig.root[0], rig.root[1], 0];
  const rel = depthIn(ax, g3) - depthIn(ax, chest);
  const front = rel > 0.5;
  let z, reason;
  if (tune?.z !== undefined) { z = tune.z; reason = 'auto-fix: raised to stay visible'; }
  else if (P.hands_mirrored) { z = partIn(rig, s.roles.main, src).z - 0.5; reason = 'mirrored hands: under the main hand'; }
  else if (front && authored <= tMax) { z = tMax + 0.3; reason = `held ${r2(rel)}px in front of the torso: over ${torso.join('/')}`; }
  else if (!front && rel < -0.5 && authored >= tMin) { z = tMin - 0.3; reason = `held ${r2(-rel)}px behind the torso: under ${torso.join('/')}`; }
  else reason = `authored view z (${front ? 'in front of' : 'level with / behind'} the torso)`;
  // aimed at the camera: the gun is nearer the viewer than the forearms and the trigger hand behind
  // the receiver (over them); a long gun's support hand is further forward on the handguard, so it
  // stays on top (raised when needed); a pistol's slide is in front of both cupped hands
  let supportZ;
  if ((s.pl.aimF ?? 0) >= 0.5 && ax.z > 0.5 && front && tune?.z === undefined) {
    const fz = Math.max(...['main', 'support'].map((r) => zOf(W.chains[r][1])));
    const mz = zOf(W.chains.main[2]), sz = zOf(W.chains.support[2]);
    const pistol = W.kind === 'pistol' || s.pl.cup;
    const want = (pistol ? Math.max(fz, mz, sz) : Math.max(fz, mz)) + 0.05;
    if ((z ?? authored) !== want) { z = want; reason = pistol ? 'aimed at the camera: the slide over the forearms and both hands' : 'aimed at the camera: over the forearms and the trigger hand, under the support hand'; }
    if (!pistol && sz <= want) supportZ = want + 0.05;
  }
  const L = W.cfg.layer || {};
  const pin = L.pin?.[src] ?? L.pin?.all;
  if (pin !== undefined && tune?.z === undefined) {
    z = pin === 'front' ? tMax + 0.3 : pin === 'back' ? tMin - 0.3 : Number(pin);
    reason = `pinned ${pin} (weapon.layer.pin.${L.pin?.[src] !== undefined ? src : 'all'})`;
  } else if (tune?.z === undefined) {
    const cur = z ?? authored;
    for (const n of L.above || []) if (rig.parts[n] && cur <= zOf(n)) { z = Math.max(z ?? cur, zOf(n) + 0.1); reason = `weapon.layer.above includes ${n}`; }
    for (const n of L.below || []) if (rig.parts[n] && (z ?? authored) >= zOf(n)) { z = zOf(n) - 0.1; reason = `weapon.layer.below includes ${n}`; }
  }
  return { z, reason, front, depth: r2(rel), torso: [tMin, tMax], ...(supportZ !== undefined && tune?.z === undefined && pin === undefined ? { supportZ } : {}) };
}

/**
 * Frame metrics of a solved pose: hand-to-grip distance, limb over-extension and inverted
 * elbows, weapon-body penetration, muzzle flags. (Visibility needs pixels: see rigops.)
 */
export function weaponMetrics(rig, solved) {
  const W = rig.weapon, R = solved.weapon;
  if (!R) return null;
  const { s } = R;
  const ax = viewAxes(W, R.view);
  const world = solved.world;
  const back = ax.yaw < 0 && Math.abs(ax.x) < 0.8;
  const exempt = s.pl.exempt || (s.pl.blend && s.pl.blend.some((n) => W.states[n]?.exempt));
  const out = { back, exempt: !!exempt, state: s.pl.blend ? `${s.pl.blend[0]}>${s.pl.blend[1]}` : s.pl.name, hand_grip: {}, reach: {}, elbow_inverted: [], penetration: r2(Math.max(0, s.pen)), hit: s.pen > 0.6 ? s.hit : null, muzzle: s.flag, hidden: s.pl.hidden >= 0.5, corrections: s.flags.slice(), canted: R.canted };
  // layering: a weapon held in front of the torso must be drawn over it; a locked hand in front
  // of the torso and over it on screen must not be drawn under it
  out.layer = [];
  const ly = R.layer;
  if (ly && !out.hidden) {
    const zOf = (n) => poseOf(rig, solved.VP, n).z ?? partIn(rig, n, R.view).z;
    if (ly.front && zOf(W.part) <= ly.torso[1]) out.layer.push(`weapon drawn under the torso while held ${ly.depth}px in front of it`);
    const C = W.chest && world[W.chest] ? world[W.chest] : null;
    if (ly.front && C) for (const role of ['main', 'support']) {
      const h = R.hands[role];
      if (!h || h.weight < 0.999) continue;
      const hw = partIn(rig, W.chest, R.view).w / 2, T = world[h.hand];
      if (Math.abs(T.x - C.x) < hw * 0.7 && T.y < C.y && zOf(h.hand) < ly.torso[0]) out.layer.push(`${role} hand drawn under the torso while its grip is in front`);
    }
  }
  for (const role of ['main', 'support']) {
    const h = R.hands[role];
    if (!h || h.weight < 0.999) continue;
    const T = world[h.hand], hp = partIn(rig, h.hand, R.view).pivot, v = poseOf(rig, solved.VP, h.hand);
    const [dx, dy] = rot2(T.rot, (h.palm.x - hp[0]) * v.sx, (h.palm.y - hp[1]) * v.sy);
    out.hand_grip[role] = r2(Math.hypot(T.x + dx - h.grip[0], T.y + dy - h.grip[1]));
    out.reach[role] = s.reach[role] !== null ? r2(s.reach[role]) : null;
    // inverted elbow: the elbow above the shoulder -> wrist line (side-like views)
    if (Math.abs(ax.x) >= 0.95) {
      const S = world[h.up], E = world[h.fore], Wr = world[h.hand];
      const vx = Wr.x - S.x, vy = Wr.y - S.y, L = Math.hypot(vx, vy) || 1;
      let nx = -vy / L, ny = vx / L;
      if (ny < 0) { nx = -nx; ny = -ny; }
      const sd = (E.x - S.x) * nx + (E.y - S.y) * ny;
      if (sd < -1.5 && Math.abs(vy) / L < 0.92) out.elbow_inverted.push(role);
    }
  }
  // seen from behind: the elbow stays below the shoulder when the 3D elbow is (no arm raised over
  // the shoulder), and arm parts in front of the body are drawn under the whole trunk
  out.elbow_raised = [];
  if (back && !out.hidden) {
    for (const role of ['main', 'support']) {
      const h = R.hands[role], A = s.arms[role];
      if (!h || h.weight < 0.999 || !A) continue;
      const S = world[h.up], E = world[h.fore];
      if (A.E[1] > A.S[1] + 1 && E.y < S.y - 1.5) out.elbow_raised.push(role);
    }
    const dep = solved.depth;
    if (dep) {
      const zOf = (n) => poseOf(rig, solved.VP, n).z ?? partIn(rig, n, R.view).z;
      const trunk = Math.min(...W.spine.filter((n) => rig.parts[n]).map(zOf));
      for (const role of ['main', 'support']) {
        const heldArm = R.hands[role]?.weight >= 0.999;
        s.chains[role].forEach((n, k) => {
          const d = dep[n];
          if (!d || poseOf(rig, solved.VP, n).hide) return;
          // a forearm / hand on the gun is in front of the body unless clearly nearer the camera
          const inFront = d.state === 'below' || (heldArm && k > 0 && d.state === 'authored');
          const sp = poseOf(rig, solved.VP, n).split, z = sp ? sp.z[sp.z.length - 1] : zOf(n);
          if (inFront && z >= trunk) out.layer.push(`${n} drawn over the torso from behind while in front of the body`);
        });
      }
    }
  }
  return out;
}

/** Per-part pixel extents of the art (base + front views) so collision uses the drawn silhouette. */
export function weaponArt(rig, composite, docWidth, cellOf) {
  const W = rig.weapon;
  if (!W) return;
  W.art = {};
  W._samples = {};
  const names = new Set([W.part, ...Object.values(W.attachments).map((a) => a.part), ...W.spine, W.head, W.chest, ...W.legs.flat(), ...W.chains.main, ...W.chains.support].filter(Boolean));
  for (const n of names) for (const view of [W.base, 'front']) {
    if (!rig.views.includes(view)) continue;
    const c = cellOf(rig, n, view);
    const cols = new Array(c.w).fill(null);
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, cnt = 0;
    for (let y = 0; y < c.h; y++) for (let x = 0; x < c.w; x++) {
      if (!composite[((c.y + y) * docWidth + c.x + x) * 4 + 3]) continue;
      cnt++;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      const col = cols[x];
      if (!col) cols[x] = [y, y]; else { if (y < col[0]) col[0] = y; if (y > col[1]) col[1] = y; }
    }
    (W.art[n] = W.art[n] || {})[view] = cnt ? { n: cnt, x0, x1, y0, y1, cols } : { n: 0 };
  }
}

/** Arm chains held by the weapon in a pose (for mirror_pairs: these keep their side). */
export function heldParts(rig, P) {
  const W = rig.weapon;
  if (!W) return null;
  let st;
  const first = (c) => (c && typeof c === 'object' && Array.isArray(c.mix) ? first(c.mix[0] ?? c.mix[1]) : c);
  try { st = stateOf(W, first(P.carry) ?? W.carry); } catch { return null; }
  const out = new Set();
  const lock = new Set(st.lock || []);
  if (st.hold === 'support') lock.add('support');
  for (const r of lock) for (const n of W.chains[r] || []) out.add(n);
  return out;
}

export { POINT_NAMES };
