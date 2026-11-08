// Character melee for humanoid_hd skeletons (art_anim): a clip library authored once in body units
// (strikes, combos, kicks, shoves, block / parry, hit reactions, knockdown / get-up, paired
// takedowns), melee metadata on each clip (phases, damage type, stamina, hit sources, lunge root
// motion, paired alignment), and the per-frame / per-view evaluation the batch export and the
// validator share: events with frames, hit capsules + swept polygons in strip pixels and in body
// space, weapon sockets for runtime weapon layers, paired offsets per view. Pure; meleeops.js runs it.
import { projectPose } from './rigtemplates.js';
import { solvePose, partIn, poseOf } from './rig.js';
import { feetGround } from './rigops.js';
import { MELEE_WEAPONS, meleeWeapon, meleeCell, DAMAGE_TYPES, CM_PER_UNIT } from './meleekit.js';

const D2R = Math.PI / 180;
const r1 = (v) => Math.round(v * 10) / 10;
const r3 = (v) => Math.round(v * 1000) / 1000;
const HD_VIEWS = ['side', 'front_side', 'front', 'back_side', 'back'];
const YAW = { side: 0, front_side: 45, front: 90, back_side: 45, back: 90 };
/** Body yaw of a drawn / mirrored view: + = turned toward the camera (screen x = fwd cos - ...). */
export const VIEW_YAW8 = { side: 0, front_side: 45, front: 90, back_side: -45, back: -90, side_left: 180, front_side_left: 135, back_side_left: -135 };
/** The view an actor turned by `facing` degrees (0 = same as the reference, 180 = toward it) is seen from. */
export function turnedView(view, facing) {
  const y = (((VIEW_YAW8[view] + facing) % 360) + 540) % 360 - 180;
  const hit = Object.entries(VIEW_YAW8).find(([, v]) => Math.abs((((v - y) % 360) + 540) % 360 - 180) < 1);
  return hit ? hit[0] : view;
}
export const PHASES = ['windup', 'active', 'recovery'];
export const MELEE_EVENTS = ['windup', 'active_start', 'impact', 'active_end', 'recovery', 'sfx', 'vfx', 'block_start', 'block_end', 'parry_start', 'parry_end', 'sync', 'contact', 'release', 'disarm', 'down', 'up'];

// ---------- pose authoring (side view, body units, WORLD angles) ----------
// Angles: limbs 0 = hanging straight down, negative = swung forward (toward the facing, +x),
// positive = backward; the held weapon (and the shield) give the screen angle of their +x axis
// (0 = forward, -90 = up, 90 = down). Spine parts and the head take the template's local rotations.
const ARM = { f: ['upper_arm_f', 'forearm_f', 'hand_f'], b: ['upper_arm_b', 'forearm_b', 'hand_b'] };
const LEG = { f: ['thigh_f', 'shin_f', 'foot_f'], b: ['thigh_b', 'shin_b', 'foot_b'] };
const SPINE = ['pelvis', 'torso', 'chest', 'neck', 'head'];

/**
 * A side-view pose from a spec: {pelvis:{x,y,rot}, torso, chest, neck, head, arm_f:[upper, fore,
 * hand?], arm_b, leg_f:[thigh, shin, foot?], leg_b, weapon? (screen angle; null = hidden),
 * shield? (screen angle of its face normal: 0 = facing forward), hide?:[parts], show?:[parts]} ->
 * {parts (local rot, x/y in body units), aw (world angles for the projection fix-ups)}.
 */
function sidePose(spec0) {
  let spec = spec0;
  const P = {};
  for (const n of SPINE) if (spec[n]) P[n] = { ...spec[n] };
  const pel = Number(spec.pelvis?.rot ?? 0);
  const chestW = pel + Number(spec.torso?.rot ?? 0) + Number(spec.chest?.rot ?? 0);
  const aw = {};
  // planted legs: two-bone IK in body units so the ankle stays on its ground spot while the
  // pelvis lunges / sinks (knee forward); pin:{f?:[x, y], b?:[x, y]} ankle spots from the root
  for (const [s, at] of Object.entries(spec.pin || {})) {
    if (spec0[`leg_${s}`]) continue; // an explicit leg wins (kicks, falls)
    const hip = [Number(spec.pelvis?.x ?? 0) + (s === 'f' ? 1 : -1), Number(spec.pelvis?.y ?? 0)];
    const dx = at[0] - hip[0], dy = at[1] - hip[1];
    const d = Math.min(THIGH + SHIN - 0.05, Math.max(Math.abs(THIGH - SHIN) + 0.05, Math.hypot(dx, dy)));
    const phi = Math.atan2(-dx, dy) / D2R;
    const al = Math.acos((THIGH * THIGH + d * d - SHIN * SHIN) / (2 * THIGH * d)) / D2R, be = Math.acos((SHIN * SHIN + d * d - THIGH * THIGH) / (2 * SHIN * d)) / D2R;
    spec = { ...spec, [`leg_${s}`]: [r3(phi - al), r3(phi + be), 0] };
  }
  for (const s of ['f', 'b']) {
    const a = spec[`arm_${s}`];
    if (a) {
      const [ua, fa, hd = fa] = a;
      P[ARM[s][0]] = { rot: ua - chestW }; P[ARM[s][1]] = { rot: fa - ua }; P[ARM[s][2]] = { rot: hd - fa };
      aw[ARM[s][2]] = hd;
    } else aw[ARM[s][2]] = chestW;
    const l = spec[`leg_${s}`];
    if (l) {
      const [th, sh, ft = 0] = l;
      P[LEG[s][0]] = { rot: th - pel }; P[LEG[s][1]] = { rot: sh - th }; P[LEG[s][2]] = { rot: ft - sh };
    }
  }
  if (spec.weapon === null) P.weapon = { hide: true };
  else if (spec.weapon !== undefined) { P.weapon = { rot: spec.weapon - aw.hand_f, hide: false }; aw.weapon = spec.weapon; }
  if (spec.shield !== undefined && spec.shield !== null) {
    // the shield cell is drawn upright (face toward +x in side views): its "angle" tilts it
    const fbW = spec.arm_b ? spec.arm_b[1] : chestW;
    P.shield = { rot: spec.shield - fbW, hide: false };
    aw.shield = spec.shield;
  } else if (spec.shield === null) P.shield = { hide: true };
  for (const n of spec.hide || []) P[n] = { ...(P[n] || {}), hide: true };
  for (const n of spec.show || []) P[n] = { ...(P[n] || {}), hide: false };
  for (const [n, v] of Object.entries(spec.set || {})) P[n] = { ...(P[n] || {}), ...v };
  return { parts: P, aw };
}

/**
 * Pose for a skeleton: the side pose scaled to px, the other drawn views projected (template
 * rule) with the weapon foreshortened along its own axis, two-handed grips by IK on the haft,
 * and hand-set per-view fixes (lateral reactions, folded spines lying down).
 */
function buildPose(ctx, spec) {
  const { parts, u, views } = ctx;
  const { parts: side, aw } = sidePose(spec);
  const S = (o) => Object.fromEntries(Object.entries(o).filter(([k]) => ctx.parts[k]).map(([k, v]) => [k, { ...v, ...(v.x !== undefined ? { x: r3(v.x * u) } : {}), ...(v.y !== undefined ? { y: r3(v.y * u) } : {}) }]));
  const p = S(side);
  const twoHand = spec.two_hand && ctx.cell?.haft !== undefined && parts.weapon && !ctx.gun;
  const haftAt = twoHand ? [r3(ctx.cell.haft - ctx.cell.pivot[0]), 0] : null;
  const ikFor = (v) => (twoHand ? { hand_b: { target: { part: 'weapon', at: haftAt }, bend: v === 'front' ? 1 : -1 } } : null);
  if (twoHand) p.ik = ikFor('side');
  if (spec.ik?.side) p.ik = { ...(p.ik || {}), ...spec.ik.side };
  const out = { ...p };
  const vs = {};
  for (const v of views.filter((x) => x !== 'side' && HD_VIEWS.includes(x))) {
    const o = projectPose(parts, p, v);
    const cp = Math.cos(YAW[v] * D2R);
    const scr = (th) => Math.atan2(Math.sin(th * D2R) * cp, Math.cos(th * D2R)) / D2R;
    // weapon: its +x axis foreshortens with the yaw (not the limb rule), floor 0.35 so a blade
    // pointing at the camera still reads
    if (aw.weapon !== undefined && parts.weapon) {
      const w = aw.weapon * D2R, wv = Math.atan2(Math.sin(w), Math.cos(w) * cp) / D2R;
      o.weapon = { ...(o.weapon || {}), rot: r3(wv - scr(aw.hand_f)), sx: r3(Math.max(0.35, Math.hypot(Math.cos(w) * cp, Math.sin(w)))) };
    }
    for (const [k, f] of Object.entries(S(spec.fix?.[v] || {}))) o[k] = { ...(o[k] || {}), ...f };
    const ik = { ...(ikFor(v) || {}), ...(spec.ik?.[v] || {}) };
    if (Object.keys(ik).length) o.ik = ik;
    if (Object.keys(o).length) vs[v] = o;
  }
  if (Object.keys(vs).length) out.views = vs;
  if (spec.carry !== undefined) out.carry = spec.carry;
  return out;
}

// spine collapse toward the camera in front / back views (a body lying down would project upside down)
function folded(spine, legs, arms) {
  const f = { pelvis: { rot: 0, sy: spine[0] }, torso: { rot: 0, sy: spine[1] }, chest: { rot: 0, sy: spine[2] }, neck: { rot: 0, sy: spine[3] }, head: { rot: 0, sy: spine[4] }, cape: { rot: 0 } };
  for (const s of ['f', 'b']) Object.assign(f, { ['thigh_' + s]: { rot: 0, sy: legs[0] }, ['shin_' + s]: { rot: 0, sy: legs[1] }, ['foot_' + s]: { rot: 0 } });
  const A = { ...f, upper_arm_f: { rot: arms, sy: 0.9 }, forearm_f: { rot: arms / 2 }, upper_arm_b: { rot: -arms, sy: 0.9 }, forearm_b: { rot: -arms / 2 } };
  const B = { ...f, upper_arm_f: { rot: -arms, sy: 0.9 }, forearm_f: { rot: -arms / 2 }, upper_arm_b: { rot: arms, sy: 0.9 }, forearm_b: { rot: arms / 2 } };
  return { front: A, back: B };
}
/** Lateral lean for left / right reactions: side views twist, front / back views lean on screen. */
function lateral(dir, k = 1) {
  const s = dir === 'left' ? 1 : -1; // hit from the actor's left: the body leans to its right
  const lean = (d) => ({ torso: { rot: d * 6 * k }, chest: { rot: d * 7 * k }, neck: { rot: d * 4 * k }, head: { rot: d * 9 * k } });
  return { front: lean(-s), back: lean(s), front_side: lean(-s * 0.6), back_side: lean(s * 0.6) };
}

// ---------- the clip library ----------
const THIGH = 23, SHIN = 22; // humanoid_hd bone lengths (body units)
/** Ankle spot (body units from the root, y down) of a leg spec on a pelvis. */
function ankleOf(pelvis, [th, sh], s) {
  const dir = (a) => [-Math.sin(a * D2R), Math.cos(a * D2R)];
  const t = dir(th), k = dir(sh);
  return [r3((pelvis.x ?? 0) + (s === 'f' ? 1 : -1) + THIGH * t[0] + SHIN * k[0]), r3((pelvis.y ?? 0) + THIGH * t[1] + SHIN * k[1])];
}
const STANCE0 = { leg_f: [-20, -2, 0], leg_b: [17, 24, 0], pelvis: { x: 0, y: 2.4 } };
/** Ground spots of the guard stance feet; a planted pose keeps them (pin) whatever the pelvis does. */
const FEET = { f: ankleOf(STANCE0.pelvis, STANCE0.leg_f, 'f'), b: ankleOf(STANCE0.pelvis, STANCE0.leg_b, 'b') };
const GY = THIGH + SHIN; // the rest pose's ankle row: planted feet sit on the rig's ground
FEET.f[1] = GY; FEET.b[1] = GY;
const at = (s, dx = 0) => [r3(FEET[s][0] + dx), GY];
const STANCE = { pelvis: { x: 0, y: 2.4 }, pin: { f: at('f'), b: at('b') } };
/** Feet planted at the stance spots moved by df / db (a step), or lifted (null). */
const feet = (df = 0, db = 0) => ({ pin: { ...(df === null ? {} : { f: at('f', df) }), ...(db === null ? {} : { b: at('b', db) }) } });
const SPINE_GUARD = { torso: { rot: 8 }, chest: { rot: 3 }, neck: { rot: -3 }, head: { rot: -7 } };
const GUARD_B = [-24, -118, -128]; // support fist up by the chin
const BLOCK_B = [-50, -150, -150];

/**
 * Melee clip set for a skeleton. kind: knife | blade | baton | heavy | shield | rifle | pistol |
 * unarmed (what the main hand holds). -> [{name, spec keys, frames, fps, melee}] before px scaling.
 */
function library(kind, opts = {}) {
  const gun = kind === 'rifle' || kind === 'pistol';
  const W = opts.weapon ? meleeWeapon(opts.weapon) : null;
  const shield = !!opts.shield;
  const dmg = (k, d) => W?.damage?.[k] ?? d;
  const stam = (k) => Math.round((W?.stamina ?? 8) * k);
  const guardW = { knife: -24, blade: -40, baton: -50, heavy: -60, shield: -50, unarmed: null }[kind];
  const armF = { knife: [-38, -100, -92], blade: [-30, -95, -90], baton: [-28, -100, -95], heavy: [-40, -95, -88], shield: [-26, -98, -92], unarmed: [-34, -128, -132] }[kind] ?? [-34, -128, -132];
  const armB = shield ? [-28, -92, -92] : kind === 'heavy' ? [-40, -95, -88] : GUARD_B;
  const sh = shield ? { shield: 0 } : {};
  const base = (o = {}) => ({ ...STANCE, ...SPINE_GUARD, arm_f: armF, arm_b: armB, ...(gun ? {} : { weapon: guardW ?? null }), ...sh, two_hand: kind === 'heavy', ...o });
  const guard = base();
  const C = [];
  const add = (name, keys, frames, fps, melee, extra = {}) => C.push({ name, keys, frames, fps, loop: false, plant: false, melee, ...extra });
  // hit sources: weapon edge (cell line), gun points, limbs
  const edge = { part: 'weapon', line: 'edge' };
  const H = (k, damage, o = {}) => ({ damage, stamina: stam(k), ...o });

  if (kind === 'knife') {
    const wind = base({ chest: { rot: -8 }, torso: { rot: 4 }, arm_f: [55, -40, -60], weapon: -150, pelvis: { x: -1, y: 2.6 } });
    const cut = base({ chest: { rot: 12 }, torso: { rot: 12 }, arm_f: [-85, -92, -86], weapon: 12, pelvis: { x: 2.5, y: 3.2 } });
    const follow = base({ chest: { rot: 16 }, torso: { rot: 13 }, arm_f: [-35, -55, -40], weapon: 75, pelvis: { x: 2.5, y: 3.4 } });
    add('knife_slash', [[guard, 0], [wind, 0.28], [cut, 0.46, 'linear'], [follow, 0.62], [guard, 1]], 12, 18,
      H(1, dmg('slash', 'slash'), { windup: [0, 0.3], active: [[0.33, 0.6]], impact: [0.46], hits: [edge], sfx: [[0.33, 'swish_light']], vfx: [[0.46, 'slash_trail']] }));
    const draw = base({ arm_f: [30, -35, -10], weapon: 0, chest: { rot: -4 }, pelvis: { x: -1.5, y: 2.6 } });
    const thrust = base({ arm_f: [-82, -90, -90], weapon: 0, chest: { rot: 10 }, torso: { rot: 14 }, pelvis: { x: 4, y: 5 } });
    add('knife_stab', [[guard, 0], [draw, 0.3], [thrust, 0.5, 'linear'], [thrust, 0.58], [guard, 1]], 10, 18,
      H(1, dmg('stab', 'pierce'), { windup: [0, 0.32], active: [[0.4, 0.62]], impact: [0.5], hits: [edge], lunge: [[0, 0], [0.5, 5], [1, 0]], sfx: [[0.4, 'swish_short']], vfx: [[0.5, 'stab_spark']] }));
    const back = base({ chest: { rot: 14 }, torso: { rot: 10 }, arm_f: [-120, -150, -170], weapon: -100, pelvis: { x: 2, y: 2.6 } });
    add('knife_combo', [[guard, 0], [wind, 0.12], [cut, 0.22, 'linear'], [follow, 0.32], [back, 0.48, 'linear'], [draw, 0.62], [thrust, 0.76, 'linear'], [thrust, 0.82], [guard, 1]], 26, 18,
      H(2.2, dmg('slash', 'slash'), { windup: [0, 0.13], active: [[0.15, 0.31], [0.35, 0.5], [0.68, 0.84]], impact: [0.22, 0.44, 0.76], damage_per_hit: [dmg('slash', 'slash'), dmg('slash', 'slash'), dmg('stab', 'pierce')], hits: [edge], lunge: [[0, 0], [0.76, 4], [1, 0]], sfx: [[0.15, 'swish_light'], [0.36, 'swish_light'], [0.68, 'swish_short']], vfx: [[0.22, 'slash_trail'], [0.44, 'slash_trail'], [0.76, 'stab_spark']], combo: [{ from: 0, to: 0.34, next_by: 0.3 }, { from: 0.34, to: 0.6, next_by: 0.56 }, { from: 0.6, to: 1 }] }));
  }
  if (kind === 'blade' || kind === 'heavy') {
    const two = kind === 'heavy';
    const up = base({ chest: { rot: -10 }, torso: { rot: 0 }, neck: { rot: 2 }, head: { rot: -2 }, arm_f: two ? [-165, -185, -190] : [-170, -150, -140], ...(two ? { arm_b: [-150, -175, -180] } : {}), weapon: -120, pelvis: { x: -1.5, y: 2.6 } });
    const chop = base({ chest: { rot: 16 }, torso: { rot: 16 }, head: { rot: -14 }, arm_f: [-72, -78, -70], ...(two ? { arm_b: [-60, -85, -80] } : {}), weapon: 38, pelvis: { x: 4, y: 5 } });
    const thru = base({ chest: { rot: 22 }, torso: { rot: 20 }, head: { rot: -18 }, arm_f: [-28, -36, -30], ...(two ? { arm_b: [-20, -40, -40] } : {}), weapon: 96, pelvis: { x: 4.5, y: 5.6 } });
    add('heavy_swing', [[guard, 0], [up, 0.36], [up, 0.44], [chop, 0.58, 'linear'], [thru, 0.7], [thru, 0.78], [guard, 1]], 18, 16,
      H(two ? 1.6 : 1.2, dmg('swing', two ? 'blunt' : 'slash'), { windup: [0, 0.46], active: [[0.5, 0.7]], impact: [0.58], hits: [edge], lunge: [[0, 0], [0.58, 4], [0.78, 4], [1, 0]], sfx: [[0.48, 'swish_heavy']], vfx: [[0.58, two ? 'impact_heavy' : 'slash_trail']], stagger: two ? 'heavy' : 'light' }));
  }
  if (kind === 'baton' || kind === 'shield') {
    const raise = base({ chest: { rot: -6 }, arm_f: [-160, -120, -110], weapon: -110, pelvis: { x: -1, y: 2.2 } });
    const strike = base({ chest: { rot: 14 }, torso: { rot: 12 }, arm_f: [-78, -82, -76], weapon: 30, pelvis: { x: 3, y: 3.6 } });
    const after = base({ chest: { rot: 16 }, torso: { rot: 13 }, arm_f: [-40, -50, -40], weapon: 70, pelvis: { x: 3, y: 3.8 } });
    const shock = W?.shock;
    add('baton_strike', [[guard, 0], [raise, 0.3], [strike, 0.48, 'linear'], [after, 0.62], [guard, 1]], 12, 16,
      H(1, dmg('strike', 'blunt'), { windup: [0, 0.32], active: [[0.36, 0.6]], impact: [0.48], hits: [edge], ...(shock ? { shock: { from: W.cell.shock_from, damage: 'shock' } } : {}), sfx: [[0.36, 'swish_baton'], ...(shock ? [[0.48, 'stun_crack']] : [])], vfx: [[0.48, shock ? 'stun_arc' : 'impact_blunt']] }));
  }
  if (shield) {
    const brace = base({ chest: { rot: -2 }, torso: { rot: 4 }, arm_b: [-14, -80, -80], pelvis: { x: -2.5, y: 3.4 } });
    const bash = base({ chest: { rot: 14 }, torso: { rot: 16 }, head: { rot: -12 }, arm_b: [-60, -92, -92], arm_f: [-10, -70, -70], pelvis: { x: 5, y: 5.4 } });
    add('shield_bash', [[guard, 0], [brace, 0.3], [bash, 0.5, 'linear'], [bash, 0.6], [guard, 1]], 12, 16,
      H(1, 'blunt', { windup: [0, 0.32], active: [[0.38, 0.62]], impact: [0.5], hits: [{ part: 'shield', line: 'edge' }], lunge: [[0, 0], [0.5, 8], [0.6, 8], [1, 0]], sfx: [[0.38, 'shield_whoosh'], [0.5, 'shield_impact']], vfx: [[0.5, 'impact_heavy']], stagger: 'heavy', knockdown: true }));
    add('shield_up', [[guard, 0], [base({ arm_b: [-50, -95, -95], chest: { rot: -3 }, head: { rot: -2 } }), 0.4], [base({ arm_b: [-50, -95, -95], chest: { rot: -3 }, head: { rot: -2 } }), 1]], 8, 16,
      { kind: 'block', damage: null, stamina: 4, block: [0.35, 1], block_arc: 140, sfx: [[0.35, 'shield_ready']] });
  }
  if (gun) {
    const rifle = kind === 'rifle';
    // the weapon solver places the gun per carry state (hands locked on the grips); the strike
    // moves the reference point forward and turns the gun
    const ready = { state: rifle ? 'ready_low' : 'low' };
    const g = (carry, o = {}) => ({ ...STANCE, ...SPINE_GUARD, carry, ...o });
    if (rifle) {
      const cock = g({ state: 'ready_low', point: 'grip_main', at: [0.18, 0.62], angle: 62, lateral: 0.6 }, { chest: { rot: -8 }, torso: { rot: 4 }, pelvis: { x: -1.5, y: 2.6 } });
      const butt = g({ state: 'ready_low', point: 'stock', at: [0.98, 0.32], angle: -118, lateral: 0.3 }, { chest: { rot: 14 }, torso: { rot: 14 }, head: { rot: -12 }, pelvis: { x: 4, y: 4.4 } });
      const thru = g({ state: 'ready_low', point: 'stock', at: [0.8, 0.12], angle: -138, lateral: 0.3 }, { chest: { rot: 16 }, torso: { rot: 15 }, head: { rot: -14 }, pelvis: { x: 4, y: 4.6 } });
      add('butt_stroke', [[g(ready), 0], [cock, 0.3], [butt, 0.5, 'linear'], [thru, 0.6], [g(ready), 1]], 12, 16,
        H(1, 'blunt', { windup: [0, 0.32], active: [[0.38, 0.62]], impact: [0.5], hits: [{ part: 'weapon', points: ['grip_main', 'stock'] }], lunge: [[0, 0], [0.5, 4], [1, 0]], sfx: [[0.38, 'swish_heavy'], [0.5, 'butt_impact']], vfx: [[0.5, 'impact_blunt']], stagger: 'heavy' }));
    } else {
      const raise = g({ state: 'low', point: 'grip_main', at: [0.3, 0.05], angle: 115, lateral: 0.4 }, { chest: { rot: -6 }, pelvis: { x: -1, y: 2.4 } });
      const whip = g({ state: 'low', point: 'grip_main', at: [0.92, 0.55], angle: 150, lateral: 0.3 }, { chest: { rot: 14 }, torso: { rot: 12 }, head: { rot: -10 }, pelvis: { x: 3, y: 3.8 } });
      const after = g({ state: 'low', point: 'grip_main', at: [0.7, 0.85], angle: 160, lateral: 0.3 }, { chest: { rot: 16 }, torso: { rot: 13 }, pelvis: { x: 3, y: 3.9 } });
      add('pistol_whip', [[g(ready), 0], [raise, 0.3], [whip, 0.48, 'linear'], [after, 0.6], [g(ready), 1]], 12, 16,
        H(1, 'blunt', { windup: [0, 0.32], active: [[0.36, 0.6]], impact: [0.48], hits: [{ part: 'weapon', points: ['grip_main', 'muzzle'] }], sfx: [[0.36, 'swish_short'], [0.48, 'whip_impact']], vfx: [[0.48, 'impact_blunt']] }));
    }
  }
  // ---- every set: kick, shove, block, parry ----
  // guns: the carry states hold both hands; block / parry raise the gun across the body (ready_high / compressed)
  const gg = gun ? { carry: kind === 'rifle' ? 'ready_low' : 'low' } : {};
  const any = (o = {}) => (gun ? { ...STANCE, ...SPINE_GUARD, ...gg, ...o } : base(o));
  const chamber = any({ leg_f: [-88, -2, -20], torso: { rot: -4 }, chest: { rot: -4 }, head: { rot: 2 }, pelvis: { x: -2, y: 1.4 } });
  const extend = any({ leg_f: [-84, -78, -80], torso: { rot: -10 }, chest: { rot: -6 }, head: { rot: 8 }, pelvis: { x: 3, y: 1.6 } });
  add('kick', [[any(), 0], [chamber, 0.3], [extend, 0.48, 'linear'], [extend, 0.56], [chamber, 0.72], [any(), 1]], 14, 16,
    { damage: 'blunt', stamina: 12, windup: [0, 0.32], active: [[0.38, 0.6]], impact: [0.48], hits: [{ part: 'foot_f', line: 'sole' }], lunge: [[0, 0], [0.48, 3], [1, 0]], sfx: [[0.38, 'swish_kick'], [0.48, 'kick_impact']], vfx: [[0.48, 'impact_blunt']], stagger: 'heavy', push: 18 });
  const pull = any({ arm_f: [-10, -80, -80], arm_b: [-10, -80, -80], chest: { rot: -4 }, pelvis: { x: -1.5, y: 2.6 }, ...(gun ? {} : { weapon: guardW === null ? null : -60 }) });
  const push = any({ arm_f: [-80, -88, -96], arm_b: [-74, -84, -96], chest: { rot: 12 }, torso: { rot: 14 }, head: { rot: -10 }, pelvis: { x: 4, y: 4.6 }, ...(gun ? {} : { weapon: guardW === null ? null : -80 }) });
  add('shove', [[any(), 0], [pull, 0.3], [push, 0.48, 'linear'], [push, 0.56], [any(), 1]], 12, 16,
    { damage: 'blunt', stamina: 10, windup: [0, 0.32], active: [[0.38, 0.6]], impact: [0.48], hits: [{ part: 'hand_f', line: 'fist' }, { part: 'hand_b', line: 'fist' }], lunge: [[0, 0], [0.48, 5], [1, 0]], damage_scale: 0.2, stagger: 'heavy', push: 24, sfx: [[0.48, 'shove']] });
  const guardUp = any({ arm_f: [-60, -150, -150], arm_b: BLOCK_B, chest: { rot: -4 }, head: { rot: 4 }, ...(gun ? { carry: kind === 'rifle' ? 'ready_high' : 'compressed' } : { weapon: guardW === null ? null : -6 }), pelvis: { x: -1, y: 2.8 } });
  add('block', [[any(), 0], [guardUp, 0.35], [guardUp, 1]], 8, 16, { kind: 'block', damage: null, stamina: 6, block: [0.3, 1], block_arc: 100, sfx: [[0.3, 'block_ready']] });
  const deflect = any({ arm_f: [-95, -165, -170], arm_b: BLOCK_B, chest: { rot: -8 }, head: { rot: 6 }, ...(gun ? { carry: kind === 'rifle' ? 'ready_high' : 'compressed' } : { weapon: guardW === null ? null : -40 }), pelvis: { x: -1.5, y: 2.6 } });
  add('parry', [[any(), 0], [deflect, 0.25, 'linear'], [deflect, 0.42], [any(), 1]], 10, 18, { kind: 'parry', damage: null, stamina: 5, parry: [0.15, 0.45], block: [0.45, 0.7], block_arc: 90, sfx: [[0.25, 'parry_clang']], vfx: [[0.25, 'parry_spark']] });

  // ---- reactions (hidden weapon not forced: reactions keep the current hold) ----
  const keep = gun ? { ...gg } : { weapon: guardW ?? null };
  const R = (o) => ({ ...STANCE, arm_f: [-20, -60, -60], arm_b: [-15, -55, -55], ...keep, ...sh, ...o });
  const reacts = {
    front: { hit: R({ pelvis: { x: -2.5, y: 2.8 }, torso: { rot: -10 }, chest: { rot: -8 }, neck: { rot: -6 }, head: { rot: -14 }, arm_f: [-10, -40, -40], arm_b: [5, -30, -30] }), push: -6 },
    back: { hit: R({ pelvis: { x: 2.5, y: 3 }, torso: { rot: 18 }, chest: { rot: 10 }, neck: { rot: 8 }, head: { rot: 14 }, arm_f: [20, 0, 0], arm_b: [25, 5, 5] }), push: 6 },
    left: { hit: R({ pelvis: { y: 2.8 }, torso: { rot: 2 }, chest: { rot: -3, sx: 0.92 }, head: { rot: -6 }, arm_f: [-5, -30, -30] }), push: 0, fix: lateral('left') },
    right: { hit: R({ pelvis: { y: 2.8 }, torso: { rot: 2 }, chest: { rot: 3, sx: 0.92 }, head: { rot: 6 }, arm_b: [-5, -30, -30] }), push: 0, fix: lateral('right') },
  };
  const rest = R({ ...SPINE_GUARD });
  for (const [dir, rc] of Object.entries(reacts)) {
    const hit = { ...rc.hit, fix: rc.fix };
    const half = { ...rc.hit, fix: rc.fix && Object.fromEntries(Object.entries(rc.fix).map(([v, o]) => [v, Object.fromEntries(Object.entries(o).map(([p, x]) => [p, { rot: x.rot * 0.5 }]))])), pelvis: { ...(rc.hit.pelvis || {}), x: (rc.hit.pelvis?.x ?? 0) * 0.5 } };
    add(`hit_${dir}`, [[rest, 0], [hit, 0.25, 'linear'], [half, 0.55], [rest, 1]], 8, 16, { kind: 'reaction', direction: dir, damage: null, stamina: 0, sfx: [[0, 'grunt']], events: [[0.25, 'impact']] });
    const big = { ...hit, pelvis: { ...(hit.pelvis || {}), x: (hit.pelvis?.x ?? 0) * 1.6, y: 3.6 }, leg_f: dir === 'front' ? [-6, 10, 0] : [-30, -6, 0], leg_b: dir === 'front' ? [30, 40, 0] : [10, 18, 0] };
    add(`stagger_${dir}`, [[rest, 0], [hit, 0.15, 'linear'], [big, 0.4], [half, 0.7], [rest, 1]], 16, 16, { kind: 'reaction', direction: dir, damage: null, stamina: 0, lunge: [[0, 0], [0.4, rc.push], [1, rc.push]], interrupt: [[0, 0.6]], sfx: [[0, 'grunt_heavy']], events: [[0.15, 'impact']] });
  }
  // ---- knockdown (onto the back) and get-up ----
  const reel = R({ pelvis: { x: -4, y: 4 }, torso: { rot: -16 }, chest: { rot: -10 }, head: { rot: -18 }, arm_f: [40, 10, 10], arm_b: [50, 20, 20], leg_f: [-30, -6, 0], leg_b: [6, 30, 0] });
  const sit = R({ pelvis: { x: -12, y: 28, rot: -20 }, torso: { rot: -10 }, chest: { rot: -6 }, head: { rot: 10 }, arm_f: [40, 20, 60], arm_b: [55, 30, 70], pin: { f: at('f', 14), b: at('b', 22) }, fix: folded([1, 0.8, 0.8, 1, 1], [0.35, 0.6], 10) });
  const flat = R({ pelvis: { x: -16, y: 42, rot: -82 }, torso: { rot: -4 }, chest: { rot: -2 }, neck: { rot: 4 }, head: { rot: 8 }, arm_f: [-150, -170, -170], arm_b: [-130, -160, -160], leg_f: [-88, -92, -170], leg_b: [-84, -90, -175], fix: folded([0.45, 0.35, 0.3, 0.3, 0.6], [0.3, 0.2], 30) });
  add('knockdown', [[rest, 0], [reel, 0.22, 'linear'], [sit, 0.5], [flat, 0.72, 'linear'], [flat, 1]], 18, 16, { kind: 'reaction', direction: 'front', damage: null, stamina: 0, lunge: [[0, 0], [0.5, -6], [1, -8]], events: [[0.72, 'down']], sfx: [[0.72, 'body_fall']], vfx: [[0.72, 'dust_puff']], down: true });
  const kneel = R({ pelvis: { x: -6, y: 24, rot: 10 }, torso: { rot: 26 }, chest: { rot: 10 }, head: { rot: -26 }, arm_f: [-20, -40, -40], arm_b: [-30, -60, -60], leg_f: [-70, 0, 0], leg_b: [40, 110, 110], fix: folded([1, 0.9, 0.9, 1, 1], [0.4, 0.2], 6) });
  const crouchUp = R({ pelvis: { x: -3, y: 12 }, torso: { rot: 22 }, chest: { rot: 6 }, head: { rot: -20 }, leg_f: [-50, 4, 0], leg_b: [6, 70, 0] });
  add('get_up', [[flat, 0], [sit, 0.3], [kneel, 0.55], [crouchUp, 0.78], [rest, 1]], 18, 14, { kind: 'reaction', damage: null, stamina: 0, events: [[1, 'up']], interrupt: [[0.78, 1]], sfx: [[0.3, 'gear_rustle']] });
  return { clips: C, guard, rest };
}

/**
 * Paired takedowns: attacker + victim clips authored together on one skeleton, with a shared root
 * alignment. offset = victim root from the attacker root [forward, lateral] (body units, in the
 * attacker's facing frame); facing = victim facing relative to the attacker (0 = same way, 180 =
 * toward each other); contacts = [{t:[t0, t1], attacker, victim, at?}] parts whose points meet.
 */
function pairedLibrary(kind, guard, rest, opts = {}) {
  const out = [];
  const gun = kind === 'rifle' || kind === 'pistol';
  const knife = kind === 'knife';
  // guns free the grabbing hand: a rifle goes on the sling; a pistol stays in the main hand at the chest
  const gT = gun ? { carry: kind === 'rifle' ? 'slung' : 'reload' } : {};
  // victims on a gun skeleton: the gun slung / holstered (hands free)
  const vFree = gun ? { carry: kind === 'rifle' ? 'slung' : 'holster' } : {};
  const vArmed = { weapon: 0 }, vDisarmed = { weapon: null };
  const one = { two_hand: false };
  const V = (o) => ({ ...STANCE, ...SPINE_GUARD, arm_f: [-6, -26, -26], arm_b: [-4, -24, -24], ...(gun ? vFree : { weapon: null }), ...o });
  const A = (o) => ({ ...guard, ...one, ...o });
  // a foot in the air mid-step: its ankle pinned dx along the ground and h body units up
  const up = (o, side, dx, h = 6) => ({ ...o, pin: { ...(o.pin || STANCE.pin), [side]: [r3(FEET[side][0] + dx), r3(GY - h)] } });
  // 1. rear takedown with the knife (attacker behind, same facing): step in, grab, strike, lower
  {
    const vIdle = V({});
    const vGrab = V({ pelvis: { x: -2, y: 3.4 }, torso: { rot: -8 }, chest: { rot: -10 }, neck: { rot: -10 }, head: { rot: -18 }, arm_f: [-60, -150, -150], arm_b: [-50, -140, -140] });
    const vStab = V({ pelvis: { x: -1.5, y: 5 }, torso: { rot: -4 }, chest: { rot: -6 }, neck: { rot: -12 }, head: { rot: -20, variant: 'blink' }, arm_f: [-30, -90, -90], arm_b: [-20, -70, -70] });
    const vSag = V({ pelvis: { x: -1, y: 13 }, torso: { rot: 8 }, chest: { rot: 4 }, neck: { rot: 8 }, head: { rot: 16, variant: 'blink' }, arm_f: [8, 0, 0], arm_b: [10, 4, 4] });
    const vDown = V({ pelvis: { x: 4, y: 39, rot: 72 }, torso: { rot: 12 }, chest: { rot: 4 }, head: { rot: 10, variant: 'blink' }, arm_f: [70, 80, 80], arm_b: [60, 80, 80], leg_f: [94, 90, 160], leg_b: [88, 86, 150], fix: folded([0.5, 0.35, 0.3, 0.3, 0.6], [0.3, 0.15], 25) });
    const aStep = up(A({ pelvis: { x: 3, y: 2.6 }, arm_b: [-70, -110, -110], ...gT }), 'f', 3.5);
    const aGrab = A({ pelvis: { x: 6, y: 4.4 }, chest: { rot: 6 }, arm_b: [-100, -120, -100], arm_f: knife ? [30, -30, -20] : [-20, -80, -80], ...(knife ? { weapon: -10 } : {}), ...gT, ...feet(7, 0) });
    const aStab = A({ pelvis: { x: 6, y: 4.6 }, chest: { rot: 10 }, arm_b: [-100, -118, -100], arm_f: knife ? [-60, -40, -30] : [-80, -90, -90], ...(knife ? { weapon: 40 } : {}), ...gT, ...feet(7, 0) });
    const aLower = A({ pelvis: { x: 6, y: 13 }, torso: { rot: 26 }, chest: { rot: 10 }, head: { rot: -22 }, arm_b: [-60, -70, -70], arm_f: [-40, -60, -60], ...(knife ? { weapon: 60 } : {}), ...gT, ...feet(7, 0) });
    const aRise = up(A({ pelvis: { x: 6.5, y: 3.4 }, ...gT, ...feet(7, 0) }), 'b', 3.5);
    const aEnd = A({ pelvis: { x: 7, y: 2.4 }, ...feet(7, 7) });
    const vKneel = V({ pelvis: { x: 1, y: 19.5 }, torso: { rot: 30 }, chest: { rot: 12 }, neck: { rot: 10 }, head: { rot: 18, variant: 'blink' }, arm_f: [20, 10, 10], arm_b: [24, 14, 14], leg_f: [-6, 88, 160], leg_b: [2, 90, 160] });
    out.push({
      name: 'takedown_rear', offset: [16, 0], facing: 0, frames: 32, fps: 16, sync: 0.25,
      attacker: [[guard, 0], [aStep, 0.14], [aGrab, 0.25, 'linear'], [aGrab, 0.36], [aStab, 0.45, 'linear'], [aStab, 0.55], [aLower, 0.8], [aRise, 0.9], [aEnd, 1]],
      victim: [[vIdle, 0], [vIdle, 0.18], [vGrab, 0.25, 'linear'], [vGrab, 0.36], [vStab, 0.45, 'linear'], [vSag, 0.62], [vKneel, 0.72], [vDown, 0.84], [vDown, 1]], release: 0.62,
      contacts: [{ t: [0.25, 0.6], attacker: 'hand_b', victim: 'head' }],
      melee: { damage: knife ? 'pierce' : 'blunt', stamina: 20, lethal: true, windup: [0, 0.2], active: [[0.4, 0.5]], impact: [0.45], hits: knife ? [{ part: 'weapon', line: 'edge' }] : [{ part: 'hand_f', line: 'fist' }], root_end: 7, interrupt: { attacker: [[0, 0.22]], victim: [[0, 0.2]] }, sfx: [[0.25, 'grab_cloth'], [0.45, knife ? 'stab_flesh' : 'punch_heavy'], [0.82, 'body_fall']], vfx: [[0.45, knife ? 'blood_spray' : 'impact_blunt']], events: [[0.82, 'drop_body']] },
      victim_melee: { kind: 'reaction', direction: 'back', events: [[0.82, 'down']], down: true },
    });
  }
  // 2. front disarm + strike (facing each other): grab the weapon wrist, strike it, the weapon drops
  // (melee and unarmed sets: a gun skeleton keeps both hands on its gun in the carry states)
  if (!gun) {
    const vAim = V({ arm_f: [-80, -90, -90], arm_b: [-70, -88, -88], chest: { rot: 4 }, ...vArmed });
    const vGrabbed = V({ pelvis: { x: 1, y: 3 }, arm_f: [-90, -95, -95], arm_b: [-40, -70, -70], chest: { rot: 6 }, ...vArmed });
    const vStruck = V({ pelvis: { x: 5, y: 3.6 }, torso: { rot: -6 }, chest: { rot: -6 }, neck: { rot: -6 }, head: { rot: -16, variant: 'blink' }, arm_f: [-84, -82, -50], arm_b: [10, -20, -20], ...vDisarmed });
    const vStumble = up(V({ pelvis: { x: -4.5, y: 2.8 }, torso: { rot: -14 }, chest: { rot: -8 }, head: { rot: -18 }, arm_f: [10, -10, -10], arm_b: [25, 0, 0], ...vDisarmed }), 'f', -4);
    const vBack = V({ pelvis: { x: -6, y: 3.6 }, torso: { rot: -10 }, chest: { rot: -6 }, head: { rot: -12 }, arm_f: [10, -10, -10], arm_b: [20, 0, 0], ...vDisarmed, ...feet(-8, 0) });
    const aGrab = A({ pelvis: { x: 3, y: 4.2 }, arm_f: [-88, -96, -96], arm_b: [20, -60, -70] });
    const aStrike = A({ pelvis: { x: 12, y: 6 }, torso: { rot: 18 }, chest: { rot: 16 }, arm_f: [-60, -70, -70], arm_b: [-80, -96, -110] });
    out.push({
      name: 'disarm_front', offset: [40, 0], facing: 180, frames: 24, fps: 16, sync: 0.3,
      attacker: [[guard, 0], [aGrab, 0.3, 'linear'], [aGrab, 0.4], [aStrike, 0.5, 'linear'], [aStrike, 0.58], [guard, 1]],
      victim: [[vAim, 0], [vAim, 0.22], [vGrabbed, 0.3, 'linear'], [vGrabbed, 0.42], [vStruck, 0.5, 'linear'], [vStruck, 0.56], [vStumble, 0.66], [vBack, 0.78], [vBack, 1]],
      contacts: [{ t: [0.3, 0.45], attacker: 'hand_f', victim: 'hand_f', fit: true }, { t: [0.5, 0.54], attacker: 'hand_b', victim: 'hand_f' }],
      melee: { damage: 'blunt', stamina: 14, windup: [0, 0.28], active: [[0.46, 0.56]], impact: [0.5], hits: [{ part: 'hand_b', line: 'fist' }], interrupt: { attacker: [[0, 0.28]], victim: [[0, 0.25]] }, sfx: [[0.3, 'grab_gear'], [0.5, 'punch_heavy']], vfx: [[0.5, 'impact_blunt']], events: [[0.42, 'disarm']] },
      victim_melee: { kind: 'reaction', direction: 'front', events: [[0.42, 'disarm']], drops_weapon: 0.42 },
    });
  }
  // 3. shield bash knockdown (facing each other): step in behind the shield, bash, the victim goes down
  if (opts.shield) {
    const vIdle = V({ arm_f: [-40, -80, -80], arm_b: [-30, -70, -70] });
    const vHit = V({ pelvis: { x: -4, y: 4.4 }, torso: { rot: -18 }, chest: { rot: -12 }, head: { rot: -20, variant: 'blink' }, arm_f: [30, 10, 10], arm_b: [40, 20, 20] });
    const vSit = V({ pelvis: { x: -12, y: 28, rot: -20 }, torso: { rot: -10 }, chest: { rot: -6 }, head: { rot: 10 }, arm_f: [40, 20, 60], arm_b: [55, 30, 70], pin: { f: at('f', 14), b: at('b', 22) }, fix: folded([1, 0.8, 0.8, 1, 1], [0.35, 0.6], 10) });
    const vReel = V({ pelvis: { x: -8, y: 15, rot: -10 }, torso: { rot: -16 }, chest: { rot: -10 }, head: { rot: -6, variant: 'blink' }, arm_f: [36, 16, 30], arm_b: [48, 24, 40], pin: { f: at('f', 6), b: at('b', 10) } });
    const vLie = V({ pelvis: { x: -14, y: 36, rot: -50 }, torso: { rot: -8 }, chest: { rot: -4 }, head: { rot: 14, variant: 'blink' }, arm_f: [-60, -90, -60], arm_b: [-40, -80, -60], pin: { f: at('f', 17), b: at('b', 34) } });
    const vFlat = V({ pelvis: { x: -16, y: 42, rot: -82 }, torso: { rot: -4 }, chest: { rot: -2 }, neck: { rot: 4 }, head: { rot: 8, variant: 'blink' }, arm_f: [-150, -170, -170], arm_b: [-130, -160, -160], pin: { f: at('f', 19), b: at('b', 43) }, fix: folded([0.45, 0.35, 0.3, 0.3, 0.6], [0.3, 0.2], 30) });
    const aBrace = A({ chest: { rot: -2 }, torso: { rot: 4 }, arm_b: [-14, -80, -80], pelvis: { x: -2, y: 3.4 } });
    const aStep = up(A({ chest: { rot: 4 }, torso: { rot: 8 }, arm_b: [-30, -88, -88], pelvis: { x: 2, y: 2.8 } }), 'f', 3.5);
    const aBash = A({ chest: { rot: 14 }, torso: { rot: 16 }, head: { rot: -12 }, arm_b: [-60, -92, -92], arm_f: [-10, -70, -70], pelvis: { x: 6, y: 5 }, ...feet(7, 0) });
    const aRise = up(A({ pelvis: { x: 6.5, y: 3.4 }, ...feet(7, 0) }), 'b', 3.5);
    const aEnd = A({ pelvis: { x: 7, y: 2.4 }, ...feet(7, 7) });
    out.push({
      name: 'shield_knockdown', offset: [24, 0], facing: 180, frames: 24, fps: 16, sync: 0.42,
      attacker: [[guard, 0], [aBrace, 0.22], [aStep, 0.34], [aBash, 0.42, 'linear'], [aBash, 0.55], [aRise, 0.78], [aEnd, 1]],
      victim: [[vIdle, 0], [vIdle, 0.42], [vHit, 0.52, 'linear'], [vReel, 0.6], [vSit, 0.68], [vLie, 0.76], [vFlat, 0.84], [vFlat, 1]], release: 0.46,
      contacts: [{ t: [0.42, 0.44], attacker: 'shield', victim: 'chest' }],
      melee: { damage: 'blunt', stamina: 18, windup: [0, 0.3], active: [[0.36, 0.5]], impact: [0.42], hits: [{ part: 'shield', line: 'edge' }], root_end: 7, interrupt: { attacker: [[0, 0.3]], victim: [[0, 0.36]] }, sfx: [[0.42, 'shield_impact'], [0.84, 'body_fall']], vfx: [[0.42, 'impact_heavy'], [0.84, 'dust_puff']] },
      victim_melee: { kind: 'reaction', direction: 'front', events: [[0.84, 'down']], down: true },
    });
  }
  return out;
}

// ---------- clip definitions for a skeleton ----------
/** What the skeleton's main hand holds: a gun class, a melee weapon set, or bare hands. */
export function meleeKind(def, weapon) {
  if (def.weapon) return ['pistol', 'handgun', 'revolver'].includes(def.weapon.class) || def.weapon.kind === 'pistol' ? 'pistol' : 'rifle';
  if (!weapon) return 'unarmed';
  const W = meleeWeapon(weapon);
  if (!W) throw new Error(`melee weapon "${weapon}" unknown (${Object.keys(MELEE_WEAPONS).join(', ')})`);
  return W.shield ? 'shield' : W.set;
}

/**
 * Melee parts for a skeleton definition: the main-hand weapon cell sized for the melee weapon
 * (grip on the pivot) and a shield part on the support forearm. -> {parts patch, cell, shieldCell}
 */
export function meleeParts(def, { weapon, shield, shield_weapon = 'riot_shield' } = {}) {
  const [W, H] = def.frame;
  const u = (H - 4) / 98;
  const out = {};
  let cell = null, shieldCell = null;
  if (weapon && !def.weapon) {
    const M = meleeWeapon(weapon);
    if (!M) throw new Error(`melee weapon "${weapon}" unknown (${Object.keys(MELEE_WEAPONS).join(', ')})`);
    if (M.shield) throw new Error(`"${weapon}" is a shield: pass shield:true (the main hand keeps its weapon)`);
    cell = meleeCell(weapon, def.frame);
    if (def.parts.weapon) out.weapon = { ...def.parts.weapon, w: cell.w, h: cell.h, pivot: cell.pivot };
  }
  if (shield) {
    shieldCell = meleeCell(shield_weapon, def.frame);
    const fore = def.parts.forearm_b;
    if (!fore) throw new Error('shield: the skeleton has no forearm_b');
    // per view: in front of the torso when it faces the camera, behind the body seen from the back
    const z = { side: 5.5, front_side: 8.6, front: 9, back_side: -9, back: -9 };
    out.shield = { w: shieldCell.w, h: shieldCell.h, pivot: shieldCell.pivot, parent: 'forearm_b', at: [0, Math.round(fore.h * 0.55)], hide: true, views: Object.fromEntries(Object.keys(z).filter((v) => (def.views || []).includes(v)).map((v) => [v, { z: z[v] }])) };
  }
  return { parts: out, cell, shieldCell, u };
}

/** Scale a key spec list to a pose list on the skeleton (px). */
function keysOf(ctx, list) {
  return list.map(([spec, t, ease]) => ({ parts: buildPose(ctx, spec), t, ...(ease ? { ease } : {}) }));
}

/** Melee metadata normalised: times, damage type, sources. */
export function meleeMeta(m, extra = {}) {
  const o = { ...m, ...extra };
  for (const k of ['sfx', 'vfx', 'events']) if (o[k]) o[k] = o[k].map((e) => (Array.isArray(e) ? { t: e[0], name: e[1] } : e));
  if (o.lunge) o.lunge = o.lunge.map((e) => (Array.isArray(e) ? { t: e[0], x: e[1] } : e));
  if (o.damage && !DAMAGE_TYPES.includes(o.damage)) throw new Error(`melee damage "${o.damage}" (types: ${DAMAGE_TYPES.join(', ')})`);
  return o;
}

/**
 * The melee clip library for a skeleton definition (px keys), the paired definitions, and the
 * hit-source geometry. opts: {weapon, shield, clips?:[names]} -> {clips:[clip], kind}
 */
export function meleeLibrary(def, opts = {}) {
  const kind = meleeKind(def, opts.weapon);
  const [W, H] = def.frame;
  const u = (H - 4) / 98;
  const views = def.views || HD_VIEWS;
  const cell = opts.weapon && !def.weapon ? meleeCell(opts.weapon, def.frame) : null;
  const ctx = { parts: def.parts, u, views, cell, gun: !!def.weapon };
  const { clips, guard, rest } = library(kind, { weapon: opts.weapon, shield: !!opts.shield });
  const out = [];
  for (const c of clips) {
    const melee = meleeMeta(c.melee, { set: kind, ...(opts.weapon ? { weapon: opts.weapon } : {}) });
    out.push({ name: c.name, keys: keysOf(ctx, c.keys), frames: c.frames, fps: c.fps, loop: false, plant: c.plant, secondary: true, melee });
  }
  for (const p of pairedLibrary(kind, guard, rest, { shield: !!opts.shield })) {
    const pair = { offset: p.offset, facing: p.facing, sync: p.sync, ...(p.release !== undefined ? { release: p.release } : {}), contacts: p.contacts };
    const am = meleeMeta(p.melee, { set: kind, ...(opts.weapon ? { weapon: opts.weapon } : {}), paired: { role: 'attacker', partner: `${p.name}_victim`, ...pair } });
    const vm = meleeMeta({ damage: null, stamina: 0, ...p.victim_melee }, { paired: { role: 'victim', partner: `${p.name}_attacker`, ...pair } });
    out.push({ name: `${p.name}_attacker`, keys: keysOf(ctx, p.attacker), frames: p.frames, fps: p.fps, loop: false, plant: false, secondary: true, melee: am });
    out.push({ name: `${p.name}_victim`, keys: keysOf(ctx, p.victim), frames: p.frames, fps: p.fps, loop: false, plant: false, secondary: true, melee: vm });
  }
  const pick = opts.clips ? new Set([].concat(opts.clips)) : null;
  return { kind, clips: pick ? out.filter((c) => pick.has(c.name) || pick.has(c.name.replace(/_(attacker|victim)$/, ''))) : out, cell };
}

/** Validate stored melee metadata against a rig (parts exist, times ordered, types known). */
export function normalizeMelee(m, rig) {
  if (!m || typeof m !== 'object') throw new Error('melee must be {damage?, windup?, active?, impact?, hits?, lunge?, ...}');
  const T = (t, what) => { if (!(Number(t) >= 0 && Number(t) <= 1)) throw new Error(`melee.${what}: t must be 0..1`); return Number(t); };
  if (m.damage !== null && m.damage !== undefined && !DAMAGE_TYPES.includes(m.damage)) throw new Error(`melee.damage "${m.damage}" (types: ${DAMAGE_TYPES.join(', ')})`);
  if (m.windup) m.windup.forEach((t) => T(t, 'windup'));
  for (const w of m.active || []) { if (!Array.isArray(w) || w.length !== 2 || T(w[0], 'active') > T(w[1], 'active')) throw new Error('melee.active must be [[t0, t1], ...] with t0 <= t1'); }
  for (const h of m.hits || []) {
    if (!h.part || !rig.parts[h.part]) throw new Error(`melee.hits: part "${h.part}" not in the rig`);
    if (h.points && !(rig.weapon && h.points.every((p) => rig.weapon.points[p]))) throw new Error(`melee.hits: weapon points ${h.points} need a rig weapon with those points`);
  }
  return m;
}

// ---------- evaluation: events, hit volumes, sockets ----------
const frameOfT = (t, n) => Math.min(n - 1, Math.max(0, Math.round(Number(t) * (n - 1))));
const inWin = (f, w, n) => f >= frameOfT(w[0], n) && f <= frameOfT(w[1], n);

/**
 * Per-frame phase and the event list (frames) of a melee clip with n frames:
 * windup -> active_start -> impact -> active_end -> recovery per active window, plus sfx / vfx /
 * block / parry / paired events. -> {phase:[..], events:[{frame, name, ...}], windows:[[f0, f1]]}
 */
export function meleeEvents(m, n) {
  const windows = (m.active || []).map((w) => [frameOfT(w[0], n), frameOfT(w[1], n)]);
  const phase = Array.from({ length: n }, (_, f) => {
    if (windows.some(([a, b]) => f >= a && f <= b)) return 'active';
    if (m.parry && inWin(f, m.parry, n)) return 'parry';
    if (m.block && inWin(f, m.block, n)) return 'block';
    if (m.windup && f <= frameOfT(m.windup[1], n) && f < (windows[0]?.[0] ?? Infinity)) return 'windup';
    if (windows.length && f > windows[windows.length - 1][1]) return 'recovery';
    if (windows.length && windows.some(([, b], i) => f > b && f < (windows[i + 1]?.[0] ?? Infinity))) return 'recovery';
    return m.kind === 'reaction' ? 'reaction' : 'idle';
  });
  const ev = [];
  if (m.windup) ev.push({ frame: frameOfT(m.windup[0], n), name: 'windup' });
  windows.forEach(([a, b], i) => {
    ev.push({ frame: a, name: 'active_start', hit: i });
    const imp = m.impact?.[i];
    if (imp !== undefined) ev.push({ frame: Math.min(b, Math.max(a, frameOfT(imp, n))), name: 'impact', hit: i, ...(m.damage_per_hit ? { damage: m.damage_per_hit[i] } : m.damage ? { damage: m.damage } : {}) });
    ev.push({ frame: b, name: 'active_end', hit: i });
    if (b + 1 < n) ev.push({ frame: b + 1, name: 'recovery', hit: i });
  });
  if (m.block) { ev.push({ frame: frameOfT(m.block[0], n), name: 'block_start' }); ev.push({ frame: frameOfT(m.block[1], n), name: 'block_end' }); }
  if (m.parry) { ev.push({ frame: frameOfT(m.parry[0], n), name: 'parry_start' }); ev.push({ frame: frameOfT(m.parry[1], n), name: 'parry_end' }); }
  if (m.paired) ev.push({ frame: frameOfT(m.paired.sync, n), name: 'sync' });
  for (const c of m.paired?.contacts || []) ev.push({ frame: frameOfT(c.t[0], n), name: 'contact', part: m.paired.role === 'attacker' ? c.attacker : c.victim });
  for (const s of m.sfx || []) ev.push({ frame: frameOfT(s.t, n), name: 'sfx', sound: s.name });
  for (const s of m.vfx || []) ev.push({ frame: frameOfT(s.t, n), name: 'vfx', effect: s.name });
  for (const s of m.events || []) ev.push({ frame: frameOfT(s.t, n), name: s.name });
  const order = (e) => ['windup', 'block_start', 'parry_start', 'sync', 'contact', 'active_start', 'impact', 'disarm', 'active_end', 'recovery', 'parry_end', 'block_end'].indexOf(e.name);
  ev.sort((x, y) => x.frame - y.frame || order(x) - order(y));
  return { phase, events: ev, windows };
}

/**
 * Root motion per frame (body units forward, + = toward the facing) from lunge keys (piecewise
 * linear, smoothstep): the runtime moves the entity by it; the frames are drawn about that moving
 * root. (Paired clips keep both roots still, draw the step in the frames, and commit it with root_end.)
 */
export function rootMotion(m, n) {
  const L = m.lunge;
  if (!L?.length) return null;
  return Array.from({ length: n }, (_, f) => {
    const t = n > 1 ? f / (n - 1) : 0;
    let i = L.length - 1;
    while (i > 0 && L[i].t > t + 1e-9) i--;
    const a = L[i], b = L[i + 1] || a;
    const s = b.t > a.t ? Math.min(1, (t - a.t) / (b.t - a.t)) : 0;
    const e = s * s * (3 - 2 * s);
    return r3(a.x + (b.x - a.x) * e);
  });
}

/** Hit-source lines of a melee clip on a rig: [{part, from:[u,v], to:[u,v], r}] in cell px (cell of the base view). */
export function hitSources(rig, m, cell) {
  const u = (rig.frame[1] - 4) / 98;
  const out = [];
  for (const h of m.hits || []) {
    const p = rig.parts[h.part];
    if (!p) continue;
    if (h.points) {
      const W = rig.weapon, pv = partIn(rig, W.part, W.base).pivot;
      // weapon points are stored relative to the cell origin (x, y), like the cell
      const a = W.points[h.points[0]], b = W.points[h.points[1]];
      out.push({ part: h.part, from: [a.x, a.y], to: [b.x, b.y], r: r1(1.6 * u), pivot: pv });
      continue;
    }
    if (h.line === 'edge') {
      const c = h.part === 'shield' ? (cell?.shield ?? null) : (cell?.weapon ?? null);
      if (c) out.push({ part: h.part, from: c.edge[0], to: c.edge[1], r: c.radius, ...(c.shock_from ? { shock_from: c.shock_from } : {}) });
      else out.push({ part: h.part, from: [p.w * 0.35, p.h / 2], to: [p.w - 1, p.h / 2], r: r1(1.2 * u) });
    } else if (h.line === 'sole') out.push({ part: h.part, from: [Math.max(0, p.pivot[0] - 1), p.h - 1], to: [p.w - 1, p.h - 1], r: r1(1.8 * u) });
    else if (h.line === 'fist') out.push({ part: h.part, from: [p.w / 2, p.h * 0.55], to: [p.w / 2, p.h * 0.85], r: r1(Math.max(2, p.w * 0.55)) });
    else out.push({ part: h.part, from: [p.pivot[0], p.pivot[1]], to: [p.w / 2, p.h - 1], r: r1(1.5 * u) });
  }
  return out;
}

/** World (drawn view frame px) point of a cell point (u, v) on a solved part. */
function cellPoint(rig, solved, part, [uu, vv], src) {
  const T = solved.world[part], p = partIn(rig, part, src), v = poseOf(rig, solved.VP, part);
  const mir = !!T.flip;
  const sx = (mir ? -1 : 1) * Math.max(0.05, v.sx), sy = Math.max(0.05, v.sy);
  const lx = (uu - p.pivot[0]) * sx, ly = (vv - p.pivot[1]) * sy;
  const c = Math.cos(T.rot * D2R), s = Math.sin(T.rot * D2R);
  return [T.x + lx * c - ly * s, T.y + lx * s + ly * c];
}

/**
 * Hit volumes and weapon socket of one solved frame in a view: capsules [{a, b, r}] in frame px of
 * the drawn view (mirror views flipped), plus the raw points for sweeps.
 */
export function frameVolumes(rig, P, view, sources) {
  const solved = solvePose(rig, P, view);
  const src = solved.src;
  const caps = [];
  for (const s of sources) {
    const vp = poseOf(rig, solved.VP, s.part);
    if (vp.hide || partIn(rig, s.part, src).hidden) { caps.push(null); continue; }
    let a = cellPoint(rig, solved, s.part, s.from, src), b = cellPoint(rig, solved, s.part, s.to, src);
    if (solved.flip) { a = [2 * rig.root[0] - a[0], a[1]]; b = [2 * rig.root[0] - b[0], b[1]]; }
    caps.push({ a, b, r: s.r });
  }
  return { caps, solved };
}

const sub2 = (a, b) => [a[0] - b[0], a[1] - b[1]];
const dot2 = (a, b) => a[0] * b[0] + a[1] * b[1];
/** Distance from point p to segment ab. */
export function segDist(p, a, b) {
  const ab = sub2(b, a), t = Math.max(0, Math.min(1, dot2(sub2(p, a), ab) / (dot2(ab, ab) || 1)));
  return Math.hypot(p[0] - a[0] - ab[0] * t, p[1] - a[1] - ab[1] * t);
}
/** Point in polygon (even-odd) or within r of its boundary. */
/** Convex hull (counter-clockwise in screen space, y down: clockwise on screen) of 2D points. */
export function hull(pts) {
  const P = [...new Map(pts.map((q) => [`${q[0]},${q[1]}`, q])).values()].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (P.length < 3) return P;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], up = [];
  for (const q of P) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
  for (let i = P.length - 1; i >= 0; i--) { const q = P[i]; while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q); }
  return [...lo.slice(0, -1), ...up.slice(0, -1)];
}

export function inPoly(p, poly, r = 0) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > p[1]) !== (yj > p[1]) && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi || 1e-12) + xi) inside = !inside;
  }
  if (inside) return true;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) if (segDist(p, poly[j], poly[i]) <= r) return true;
  return false;
}

/**
 * Melee data of one rendered clip view: per active frame the capsules (frame px + padding) and the
 * swept polygon from the previous active frame (with the sub-frame arc), body-space volumes (side
 * view), weapon socket per frame (runtime weapon layers), events, phases, root motion.
 * poses: the final frame poses (fp.poses); sub: optional {poses, k} sub-frame poses (k per frame).
 */
export function meleeAnim(rig, poses, view, m, { pad = [0, 0, 0, 0], cell = null, sub = null } = {}) {
  const n = poses.length;
  const { phase, events, windows } = meleeEvents(m, n);
  const sources = hitSources(rig, m, cell);
  const ox = pad[0], oy = pad[1];
  const P2 = (p) => [r1(p[0] + ox), r1(p[1] + oy)];
  const u = (rig.frame[1] - 4) / 98;
  const ground = feetGround(rig, rig.views.includes('side') ? 'side' : rig.views[0]) ?? rig.root[1];
  const hits = [];
  const active = new Set();
  for (const [a, b] of windows) for (let f = a; f <= b; f++) active.add(f);
  const perFrame = poses.map((P) => frameVolumes(rig, P, view, sources).caps);
  const sideFrames = view === 'side' ? perFrame : poses.map((P) => frameVolumes(rig, P, 'side', sources).caps);
  for (let f = 0; f < n; f++) {
    if (!active.has(f)) continue;
    const caps = perFrame[f];
    const vols = [];
    caps.forEach((c, i) => {
      if (!c) return;
      const vol = { source: sources[i].part, a: P2(c.a), b: P2(c.b), r: sources[i].r };
      const prev = active.has(f - 1) && windows.some(([a0, b0]) => f - 1 >= a0 && f <= b0) ? perFrame[f - 1][i] : null;
      if (prev) {
        // swept area: convex hull of the line at f-1, the sub-frame lines between and the line at f
        // (convex, so a runtime can test it with one SAT / point-in-polygon pass)
        const mids = [];
        if (sub) for (let j = 1; j < sub.k; j++) { const q = sub.caps[(f - 1) * sub.k + j]?.[i]; if (q) mids.push(q); }
        vol.sweep = hull([prev, ...mids, c].flatMap((q) => [q.a, q.b]).map(P2));
      }
      const sc = sideFrames[f][i];
      if (sc) vol.space = { a: [r3((sc.a[0] - rig.root[0]) / u), r3((ground - sc.a[1]) / u), 0], b: [r3((sc.b[0] - rig.root[0]) / u), r3((ground - sc.b[1]) / u), 0], r: r3(sources[i].r / u) };
      if (sources[i].shock_from !== undefined) vol.shock_from = sources[i].shock_from;
      vols.push(vol);
    });
    const win = windows.findIndex(([a, b]) => f >= a && f <= b);
    hits.push({ frame: f, hit: win, volumes: vols });
  }
  const out = { set: m.set, ...(m.weapon ? { weapon: m.weapon } : {}), kind: m.kind ?? 'attack', damage: m.damage ?? null, ...(m.damage_per_hit ? { damage_per_hit: m.damage_per_hit } : {}), stamina: m.stamina ?? 0, phase, events, windows };
  if (hits.length) out.hits = hits;
  const rm = rootMotion(m, n);
  if (rm) out.root_motion = rm;
  for (const k of ['block', 'parry', 'block_arc', 'stagger', 'knockdown', 'push', 'damage_scale', 'direction', 'down', 'lethal', 'shock', 'drops_weapon', 'root_end']) if (m[k] !== undefined) out[k] = k === 'block' || k === 'parry' ? [frameOfT(m[k][0], n), frameOfT(m[k][1], n)] : k === 'drops_weapon' ? frameOfT(m[k], n) : m[k];
  if (m.interrupt) out.interrupt = Array.isArray(m.interrupt) ? m.interrupt.map((w) => [frameOfT(w[0], n), frameOfT(w[1], n)]) : Object.fromEntries(Object.entries(m.interrupt).map(([k, ws]) => [k, ws.map((w) => [frameOfT(w[0], n), frameOfT(w[1], n)])]));
  if (m.combo) out.combo = m.combo.map((c) => ({ from: frameOfT(c.from, n), to: frameOfT(c.to, n), ...(c.next_by !== undefined ? { next_by: frameOfT(c.next_by, n) } : {}) }));
  if (m.paired) out.paired = pairedOut(rig, m.paired, view, n);
  return { anim: out, sources, perFrame };
}

/** Paired metadata for a view: offsets in body units and px, the partner's view, draw order. */
export function pairedOut(rig, p, view, n) {
  const u = (rig.frame[1] - 4) / 98;
  const yaw = VIEW_YAW8[view] * D2R;
  const [f, l] = p.offset;
  // screen x of a forward / lateral offset in this view, depth toward the camera (+ = nearer)
  const dx = f * Math.cos(yaw) - l * Math.sin(yaw), depth = f * Math.sin(yaw) + l * Math.cos(yaw);
  const sign = p.role === 'victim' ? -1 : 1; // the victim's partner (attacker) sits at -offset
  const partnerView = turnedView(view, p.role === 'victim' ? -p.facing : p.facing);
  return {
    role: p.role, partner: p.partner, offset: p.offset, facing: p.facing, sync_frame: frameOfT(p.sync, n), ...(p.release !== undefined ? { release_frame: frameOfT(p.release, n) } : {}),
    partner_view: partnerView, partner_dx: r1(sign * dx * u), partner_depth: r1(sign * depth * u),
    order: sign * depth > 0 ? 'partner_front' : 'partner_behind',
    contacts: (p.contacts || []).map((c) => ({ frames: [frameOfT(c.t[0], n), frameOfT(c.t[1], n)], attacker: c.attacker, victim: c.victim })),
  };
}

export { HD_VIEWS, frameOfT, CM_PER_UNIT };
