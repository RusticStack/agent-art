// Handling classes, shared by every weapon pipeline (third-person rigs, runtime weapon layers,
// first-person viewmodels): the class table, the standard grip geometry and tolerance, the carry
// positions, the default weapon points, and the conform validator. Pure data + math: no rig, view,
// sprite frame or camera assumptions.
//
// Units: geometry is in BODY UNITS, 1/98 of a standing figure's height (sole to crown), so one
// table serves a 64x96 sprite, a 128x192 sprite and a first-person arm rig alike; a consumer scales
// by its own unit (scaleGeometry). Weapon space: x = along the barrel (forward +), y = across it in
// the weapon plane (down +), z = lateral (optional, 3D consumers). Offsets are from grip_main (the
// trigger hand).

/**
 * Classes. kind: long | pistol (two-handed guns), melee | thrown | item | null (no gun geometry).
 * cell: the class's standard weapon size [length, height] in body units (guns). geometry: class
 * whose grip geometry this one uses (dmr / shotgun keep the rifle grips so rifle hands fit them).
 * third_person: the handling class a third-person character exports (animation sets).
 * hands: hands on the item in the ready / aim states.
 */
export const HANDLING_CLASSES = {
  pistol: { kind: 'pistol', members: ['pistol', 'handgun', 'revolver'], cell: [14, 9], hands: 2, third_person: 'pistol' },
  smg: { kind: 'long', members: ['smg'], cell: [26, 10], hands: 2, third_person: 'smg' },
  rifle: { kind: 'long', members: ['rifle', 'carbine', 'energy'], cell: [32, 10], hands: 2, third_person: 'rifle' },
  dmr: { kind: 'long', members: ['dmr'], cell: [42, 11], geometry: 'rifle', hands: 2, third_person: 'rifle' },
  shotgun: { kind: 'long', members: ['shotgun'], cell: [36, 10], geometry: 'rifle', hands: 2, third_person: 'rifle' },
  lmg: { kind: 'long', members: ['lmg'], cell: [42, 13], hands: 2, third_person: 'lmg' },
  sniper: { kind: 'long', members: ['sniper'], cell: [46, 11], hands: 2, third_person: 'sniper' },
  launcher: { kind: 'long', members: ['launcher'], cell: [40, 12], hands: 2, third_person: 'launcher' },
  knife: { kind: 'melee', members: ['knife', 'melee'], cell: null, hands: 1, third_person: 'none' },
  grenade: { kind: 'thrown', members: ['grenade', 'throwable'], cell: null, hands: 1, third_person: 'none' },
  med: { kind: 'item', members: ['med', 'medkit', 'syringe'], cell: null, hands: 2, third_person: 'none' },
  tablet: { kind: 'item', members: ['tablet', 'device'], cell: null, hands: 2, third_person: 'none' },
  unarmed: { kind: null, members: ['unarmed', 'fists'], cell: null, hands: 0, third_person: 'none' },
  none: { kind: null, members: ['none', 'crew'], cell: null, hands: 0, third_person: 'none' },
};

/** The class of a weapon / item name ("carbine" -> rifle, "dmr" -> dmr). Throws on unknown names. */
export function classOf(name) {
  for (const [c, d] of Object.entries(HANDLING_CLASSES)) if (c === name || d.members.includes(name)) return c;
  throw new Error(`unknown weapon class "${name}" (handling classes: ${Object.entries(HANDLING_CLASSES).map(([c, d]) => `${c} (${d.members.join(', ')})`).join('; ')})`);
}
/** The third-person handling class (animation set) of a name ("dmr" -> rifle). */
export const thirdPersonClass = (name) => HANDLING_CLASSES[classOf(name)].third_person;
/** Gun kind of a name: long | pistol | melee | thrown | item | null. */
export const kindOf = (name) => HANDLING_CLASSES[classOf(name)].kind;

// default points as fractions of the weapon cell (drawn pointing RIGHT / +x), by kind
export const DEFAULT_POINTS = {
  long: { stock: [0, 0.42], grip_main: { at: [0.3, 0.78], angle: 16 }, grip_support: { at: [0.64, 0.56], angle: -100, slide: true }, muzzle: [1, 0.3], optic: [0.38, 0.05], mag: [0.44, 0.92], charge: [0.27, 0.14] },
  pistol: { stock: [0, 0.3], grip_main: { at: [0.24, 0.8], angle: 18 }, muzzle: [1, 0.22], optic: [0.62, 0], mag: [0.24, 1], charge: [0.1, 0.12] },
};
export const DEFAULT_SOCKETS = {
  long: { underbarrel: [0.66, 0.66], top: [0.4, 0], muzzle: [1, 0.3] },
  pistol: { underbarrel: [0.7, 0.55], top: [0.55, 0], muzzle: [1, 0.22] },
};
/** Attachment types: default socket and the grip / muzzle / optic they take over (fractions of the attachment cell). */
export const ATTACHMENT_TYPES = {
  vertical_grip: { socket: 'underbarrel', grip_support: { at: [0.5, 0.72], angle: 6 } },
  angled_grip: { socket: 'underbarrel', grip_support: { at: [0.42, 0.55], angle: -38 } },
  bipod: { socket: 'underbarrel', grip_support: { at: [0.5, 0.45], angle: -4 } },
  suppressor: { socket: 'muzzle', muzzle: [1, 0.5] },
  optic: { socket: 'top', optic: [0.5, 0.1] },
  light: { socket: 'underbarrel' },
};

/**
 * Carry positions by kind (body-relative, view independent). at = [forward, down] of the
 * reference point from the reference shoulder in ARM LENGTHS ("pocket" = the shoulder pocket);
 * angle = muzzle angle in deg (+ = down); lateral = weapon plane offset as a fraction of the
 * shoulder's lateral offset; lock = hands held on their grips; fire = a firing position; weld =
 * cheek on the stock; follow = how much the chest's rotation turns the weapon. These are the
 * class "carry heights": the same for every gun of a kind.
 */
export const CARRY = {
  long: {
    aim: { point: 'stock', at: 'pocket', angle: 0, lock: ['main', 'support'], fire: true, weld: true, follow: 1 },
    ready_low: { point: 'stock', at: 'pocket', angle: 36, lock: ['main', 'support'], follow: 0.35 },
    ready_high: { point: 'grip_main', at: [0.32, 0.5], angle: -42, lateral: 0.55, lock: ['main', 'support'], follow: 0.6 },
    hip: { point: 'grip_main', at: [0.36, 0.74], angle: 2, lateral: 0.85, lock: ['main', 'support'], fire: true, follow: 0.5 },
    sprint: { point: 'grip_main', at: [0.3, 0.66], angle: 52, lateral: 0.4, lock: ['main', 'support'], follow: 0.5 },
    // reload: the gun comes up to the chest, muzzle high, mag well turned to the support hand;
    // reload_charge: the support hand works the charging handle
    reload: { point: 'grip_main', at: [0.34, 0.46], angle: -24, lateral: 1, lock: ['main'], follow: 0.5 },
    reload_charge: { point: 'grip_main', at: [0.3, 0.42], angle: -30, lateral: 0.9, lock: ['main'], follow: 0.5 },
    slung: { point: 'grip_main', at: [0.3, 1.02], angle: 74, lateral: 0.25, lock: [], follow: 1 },
    one_hand_low: { point: 'grip_support', ref: 'support', at: [0.12, 0.97], angle: 66, lateral: 1.15, lock: ['support'], follow: 0.6 },
    drop: { point: 'ground', at: [0.45, 0], angle: 0, lateral: 1.5, lock: [], exempt: true, follow: 0 },
    holster: { hidden: true, point: 'stock', at: 'pocket', angle: 70, lock: [], exempt: true, follow: 1 },
  },
};
CARRY.pistol = {
  aim: { point: 'grip_main', at: [0.9, 0], angle: 0, lateral: 0, lock: ['main', 'support'], cup: true, fire: true, eye: true, follow: 0.6 },
  compressed: { point: 'grip_main', at: [0.42, 0.36], angle: 4, lateral: 0.25, lock: ['main', 'support'], cup: true, fire: true, follow: 0.6 },
  low: { point: 'grip_main', at: [0.62, 0.68], angle: 42, lateral: 0.15, lock: ['main', 'support'], cup: true, follow: 0.6 },
  reload: { point: 'grip_main', at: [0.5, 0.44], angle: 20, lateral: 0.3, lock: ['main'], follow: 0.6 },
  reload_charge: { point: 'grip_main', at: [0.46, 0.4], angle: 24, lateral: 0.3, lock: ['main'], follow: 0.6 },
  one_hand_low: { point: 'grip_main', ref: 'support', at: [0.1, 0.97], angle: 70, lateral: 1.15, lock: ['support'], hold: 'support', follow: 0.6 },
  drop: CARRY.long.drop,
  holster: { hidden: true, point: 'grip_main', at: [0.05, 1.05], angle: 80, lateral: 1.3, lock: [], exempt: true, follow: 1 },
};

// 4 significant digits: unit independent (px, body units, metres)
const r1 = (v) => Number(v.toPrecision(4)) + 0;
const ptAt = (v) => (Array.isArray(v) ? v : v.at);

/**
 * Standard grip geometry of a class in body units: offsets from grip_main [along, across] of the
 * support grip, the stock and the muzzle (of the class's standard cell), and the tolerance
 * [along, across] for the support grip, stock and foregrip attachments. null for classes without
 * a gun (knife, grenade, med, tablet, unarmed, none).
 */
export function gripGeometry(name) {
  const cls = classOf(name), C = HANDLING_CLASSES[cls];
  const G = HANDLING_CLASSES[C.geometry || cls];
  if (!G.cell || !DEFAULT_POINTS[G.kind]) return null;
  const [L, H] = G.cell, P = DEFAULT_POINTS[G.kind], g = ptAt(P.grip_main);
  const off = (k) => (P[k] ? [r1((ptAt(P[k])[0] - g[0]) * L), r1((ptAt(P[k])[1] - g[1]) * H)] : null);
  const [ML, MH] = C.cell;
  return {
    class: cls, kind: G.kind, geometry: C.geometry || cls, cell: C.cell,
    support: off('grip_support'), stock: off('stock'),
    muzzle: [r1((ptAt(DEFAULT_POINTS[C.kind].muzzle)[0] - g[0]) * ML), r1((ptAt(DEFAULT_POINTS[C.kind].muzzle)[1] - g[1]) * MH)],
    tolerance: { support: [r1(Math.max(2, L * 0.06)), 1.5], stock: [2, 1.5], attachment: [3, 2] },
  };
}

/**
 * Scale a geometry (body units) by a consumer's unit: {u, uw?} px (or world units) per body unit;
 * uw (widths / lengths along the barrel) defaults to u.
 */
export function scaleGeometry(G, { u, uw = u }) {
  if (!G) return null;
  const s = (p) => (p ? [r1(p[0] * uw), r1(p[1] * u)] : null);
  return {
    ...G, cell: [Math.max(2, Math.round(G.cell[0] * uw)), Math.max(1, Math.round(G.cell[1] * u))],
    support: s(G.support), stock: s(G.stock), muzzle: s(G.muzzle),
    tolerance: Object.fromEntries(Object.entries(G.tolerance).map(([k, t]) => [k, [r1(Math.max(t[0] * uw, k === 'support' ? G.cell[0] * uw * 0.06 : 0)), r1(t[1] * u)]])),
  };
}

/**
 * conform: a weapon's grips against its class geometry.
 * points: {grip_main, grip_support?, stock?} as [x, y] or [x, y, z] in the consumer's units
 * (x along the barrel, y across / down, z lateral); attachments: {name: grip_support point} for
 * foregrips (checked with the attachment tolerance); unit: {u, uw?} (default 1 = body units).
 * -> {pass, class, checks:[{point, offset, standard, along, across, lateral?, tolerance, ok, issue?}], fixed?:{points}}
 */
export function conform(name, points, { unit = { u: 1 }, attachments = {}, fix = false } = {}) {
  const G = scaleGeometry(gripGeometry(name), unit);
  if (!G) return { pass: true, class: classOf(name), checks: [], note: 'no gun geometry for this class' };
  const g = points.grip_main;
  if (!g) return { pass: false, class: G.class, checks: [{ point: 'grip_main', ok: false, issue: 'missing grip_main' }] };
  const checks = [];
  const test = (point, at, std, tol) => {
    if (!std) return;
    if (!at) { checks.push({ point, ok: false, issue: `missing ${point}` }); return; }
    const off = [r1(at[0] - g[0]), r1(at[1] - g[1])];
    const along = r1(off[0] - std[0]), across = r1(off[1] - std[1]);
    const lateral = at.length > 2 && g.length > 2 ? r1(at[2] - g[2]) : null;
    const ok = Math.abs(along) <= tol[0] && Math.abs(across) <= tol[1] && (lateral === null || Math.abs(lateral) <= tol[1]);
    checks.push({ point, offset: off, standard: std, along, across, ...(lateral !== null ? { lateral } : {}), tolerance: tol, ok });
  };
  test('grip_support', points.grip_support, G.support, G.tolerance.support);
  test('stock', points.stock, G.stock, G.tolerance.stock);
  for (const [n, p] of Object.entries(attachments)) if (p) test(`grip_support (${n})`, p, G.support, G.tolerance.attachment);
  const out = { pass: checks.every((c) => c.ok), class: G.class, geometry: G.geometry, checks };
  if (fix && !out.pass) {
    const pts = { ...points };
    const put = (k, std) => { if (std && pts[k]) pts[k] = [r1(g[0] + std[0]), r1(g[1] + std[1]), ...(pts[k].length > 2 ? [g[2] ?? 0] : [])]; };
    put('grip_support', G.support); put('stock', G.stock);
    out.fixed = { points: pts, note: 'points moved to the class geometry; redraw the art so the grips sit there' };
  }
  return out;
}
