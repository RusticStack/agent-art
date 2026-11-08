// Melee weapons: original 2251 sci-fi designs as art_model kit templates (cm, -Z = forward, grip
// on the origin, Y up, edge / strike face on -Y), with the sockets a hit sweep needs (grip, guard,
// tip, edge_a -> edge_b = the edge / strike line, strike = the zone centre) and rig clips (stun arc
// toggle, telescoping baton, folding vibro-blade, deploying shield). The same table gives the 2D
// weapon cell a humanoid_hd character holds (body units: 1/98 of the standing height) and the
// damage / stamina defaults of every strike made with it. Pure data; meleeops.js renders it.

/** Damage types a hit can carry. */
export const DAMAGE_TYPES = ['blunt', 'slash', 'pierce', 'shock'];
/** Centimetres per body unit (98 units = a 180 cm figure). */
export const CM_PER_UNIT = 180 / 98;

const steel = '#aeb6be', dark = '#2a2c31', grip = '#34362f', rubber = '#1f2023', od = '#4a5038', hazard = '#c8a23a', glow = '#7fd8ff', glowHot = '#ff7a3c';
const box = (c, s, tex, o = {}) => ({ type: 'box', w: s[0], h: s[1], d: s[2], at: [c[0], c[1] - s[1] / 2, c[2]], texture: tex, ...o });
/** Cylinder along -Z from z0 to z1 (z1 < z0) on the axis (x, y). */
const cyl = (x, y, z0, z1, r, tex, o = {}) => ({ type: 'cylinder', r, h: z0 - z1, segments: 10, rotate: [-90, 0, 0], at: [x, y, z0], texture: tex, ...o });
/** Blade / head outline in the side plane: points [[z, y], ...], thickness d along x. */
const profile = (points, d, tex, o = {}) => ({ type: 'shape', plane: 'zy', points, d, texture: tex, ...o });
const S = (at, part) => (part ? { part, at } : { at });

/**
 * The weapons. hands: 1 | 2 (two-handed swings put the support hand on the haft); damage: default
 * per strike kind; cell: the 2D weapon cell in body units [length, height] with the grip pivot
 * and the edge line as fractions of the cell (drawn pointing RIGHT, edge on the bottom side);
 * radius: hit capsule radius (body units); set: which melee clip set the weapon uses.
 */
export const MELEE_WEAPONS = {
  combat_knife: {
    title: 'combat knife (KM-7 fighting knife)', hands: 1, set: 'knife', length_cm: 30, mass_kg: 0.3,
    damage: { slash: 'slash', stab: 'pierce' }, stamina: 6,
    cell: { size: [17, 4], grip: [0.2, 0.5], edge: [[0.42, 0.72], [1, 0.45]], radius: 1.1 },
    model: () => ({
      parts: [
        { ...box([0, 1.2, 0], [1.7, 2.4, 11], grip, { bevel: 0.5 }), name: 'handle' },
        box([0, 2.0, -5.9], [3.6, 4.0, 0.8], dark, { bevel: 0.2 }),
        cyl(0, 0, 6.6, 5.4, 1.1, dark, { segments: 8 }),
        { ...profile([[-6.3, 1.0], [-18.5, 1.0], [-23.3, 0.1], [-21.2, -0.9], [-6.3, -1.4]], 0.5, steel, { material: 'bare_metal' }), name: 'blade' },
        box([0, -0.2, -12], [0.56, 0.5, 10], dark),
      ],
      sockets: { grip: S([0, 0, 0]), guard: S([0, 0, -5.9]), pommel: S([0, 0, 6.6]), tip: S([0, 0.1, -23.3]), edge_a: S([0, -1.4, -7]), edge_b: S([0, -0.7, -21.6]), strike: S([0, -1.0, -15]) },
    }),
  },
  machete: {
    title: 'machete (Hollis pattern brush blade)', hands: 1, set: 'blade', length_cm: 62, mass_kg: 0.7,
    damage: { swing: 'slash', slash: 'slash', stab: 'pierce' }, stamina: 12,
    cell: { size: [34, 6], grip: [0.12, 0.5], edge: [[0.3, 0.82], [0.99, 0.6]], radius: 1.4 },
    model: () => ({
      parts: [
        { ...box([0, 1.4, 0], [2.0, 2.8, 14], grip, { bevel: 0.6 }), name: 'handle' },
        box([0, 1.9, -7.3], [2.6, 3.8, 0.7], dark),
        { ...profile([[-7.5, 1.3], [-48, 1.6], [-58, 2.2], [-62, 0.6], [-60, -2.6], [-50, -3.4], [-7.5, -1.6]], 0.5, steel, { material: 'bare_metal' }), name: 'blade' },
        box([0, 1.2, -30], [0.56, 0.4, 40], dark),
      ],
      sockets: { grip: S([0, 0, 0]), guard: S([0, 0, -7.3]), pommel: S([0, 0, 7]), tip: S([0, 0.6, -62]), edge_a: S([0, -1.6, -9]), edge_b: S([0, -3.0, -57]), strike: S([0, -2.6, -42]) },
    }),
  },
  baton: {
    title: 'telescoping baton (TB-21)', hands: 1, set: 'baton', length_cm: 56, mass_kg: 0.5,
    damage: { strike: 'blunt' }, stamina: 8,
    cell: { size: [30, 3], grip: [0.13, 0.5], edge: [[0.45, 0.5], [1, 0.5]], radius: 1.3 },
    model: () => ({
      parts: [
        { ...cyl(0, 0, 10, -10, 1.45, rubber), name: 'sleeve' },
        cyl(0, 0, 11, 10, 1.2, dark, { segments: 8 }),
        { ...cyl(0, 0, -10, -28, 1.0, dark), name: 'shaft_mid' },
        { ...cyl(0, 0, -27, -44, 0.75, steel, { material: 'bare_metal' }), name: 'shaft_tip', parent: 'shaft_mid' },
        { ...cyl(0, 0, -44, -46, 1.05, dark, { segments: 8 }), name: 'tip_cap', parent: 'shaft_tip' },
      ],
      sockets: { grip: S([0, 0, 0]), guard: S([0, 0, -10]), pommel: S([0, 0, 11]), tip: S([0, 0, -46], 'tip_cap'), edge_a: S([0, -0.8, -24], 'shaft_mid'), edge_b: S([0, -0.8, -45], 'tip_cap'), strike: S([0, -0.8, -38], 'shaft_tip') },
      poses: { collapsed: { parts: { shaft_mid: { at: [0, 0, 17] }, shaft_tip: { at: [0, 0, 16] } } } },
      clips: {
        extend: { duration: 0.18, keys: [{ t: 0, pose: 'collapsed' }, { t: 0.12, parts: { shaft_mid: { at: [0, 0, -0.6] } }, ease: 'linear' }, { t: 0.18, parts: {} }], events: [{ t: 0.12, name: 'lock' }] },
        collapse: { duration: 0.3, keys: [{ t: 0, parts: {} }, { t: 0.3, pose: 'collapsed', ease: 'smooth' }], events: [{ t: 0.3, name: 'stow' }] },
      },
    }),
  },
  stun_baton: {
    title: 'stun baton (Volta SP-4 prod)', hands: 1, set: 'baton', length_cm: 58, mass_kg: 0.8,
    damage: { strike: 'blunt', tip: 'shock' }, shock: true, stamina: 9,
    cell: { size: [31, 4], grip: [0.13, 0.5], edge: [[0.45, 0.5], [1, 0.5]], radius: 1.4, shock_from: 0.82 },
    model: () => ({
      parts: [
        { ...cyl(0, 0, 9, -11, 1.6, rubber), name: 'grip' },
        box([0, 2.1, -1.5], [1.2, 0.8, 3], hazard, { name: 'trigger_pad' }),
        { ...cyl(0, 0, -11, -46, 1.15, od), name: 'shaft' },
        box([0, 1.4, -14], [0.9, 0.5, 1.4], glow, { material: 'emissive_panel', name: 'status_led' }),
        { ...cyl(0, 0, -46, -50, 1.5, dark, { segments: 8 }), name: 'head' },
        box([0, 1.6, -53], [0.6, 0.6, 6], steel, { material: 'bare_metal', name: 'prong_top' }),
        box([0, -1.0, -53], [0.6, 0.6, 6], steel, { material: 'bare_metal', name: 'prong_bottom' }),
        { ...box([0, 1.0, -55.4], [0.4, 2.6, 0.4], glow, { material: 'emissive_panel' }), name: 'arc', parent: 'head' },
      ],
      sockets: { grip: S([0, 0, 0]), guard: S([0, 0, -11]), pommel: S([0, 0, 9]), tip: S([0, 0, -56]), edge_a: S([0, -1.2, -24]), edge_b: S([0, -0.6, -56]), strike: S([0, -0.8, -50]), emitter: S([0, 0, -55.4], 'arc') },
      poses: { arc_off: { parts: { arc: { scale: [0.05, 0.05, 0.05] } } } },
      clips: {
        arc_on: { duration: 0.16, keys: [{ t: 0, pose: 'arc_off' }, { t: 0.06, parts: { arc: { scale: [1.6, 1.3, 1.6] } }, ease: 'linear' }, { t: 0.1, parts: { arc: { scale: [0.7, 0.9, 0.7] } }, ease: 'linear' }, { t: 0.16, parts: {} }], events: [{ t: 0, name: 'arc_start' }] },
        arc_off: { duration: 0.1, keys: [{ t: 0, parts: {} }, { t: 0.1, pose: 'arc_off', ease: 'linear' }], events: [{ t: 0.1, name: 'arc_stop' }] },
        arc_loop: { duration: 0.24, loop: true, keys: [{ t: 0, parts: {} }, { t: 0.08, parts: { arc: { scale: [1.3, 1.1, 1.3] } }, ease: 'step' }, { t: 0.16, parts: { arc: { scale: [0.8, 1, 0.8] } }, ease: 'step' }, { t: 0.24, parts: {} }] },
      },
    }),
  },
  vibro_blade: {
    title: 'vibro-blade (Ostrander folding sabre)', hands: 1, set: 'blade', length_cm: 72, mass_kg: 1.1,
    damage: { swing: 'slash', slash: 'slash', stab: 'pierce' }, stamina: 14,
    cell: { size: [39, 5], grip: [0.12, 0.5], edge: [[0.28, 0.78], [1, 0.5]], radius: 1.4 },
    model: () => ({
      parts: [
        { ...box([0, 1.6, 0], [2.2, 3.2, 17], grip, { bevel: 0.6 }), name: 'hilt' },
        box([0, 2.4, -9], [3.0, 4.6, 1.4], dark, { bevel: 0.3, name: 'hinge' }),
        box([0, 2.0, 3], [2.4, 0.5, 4], glow, { material: 'emissive_panel', name: 'power_cell' }),
        { type: 'box', w: 0.1, h: 0.1, d: 0.1, at: [0, 0, -9.5], texture: dark, name: 'blade', pivot: [0, 0, 0] },
        { ...profile([[-10, 1.4], [-64, 1.2], [-72, 0.2], [-66, -1.6], [-10, -1.8]], 0.6, '#c9d2dc', { material: 'bare_metal' }), name: 'blade_body', parent: 'blade' },
        { ...profile([[-11, -1.4], [-65, -1.2], [-70, -0.6], [-65, -1.75], [-11, -1.95]], 0.7, glow, { material: 'emissive_panel' }), name: 'edge_glow', parent: 'blade' },
      ],
      sockets: { grip: S([0, 0, 0]), guard: S([0, 0, -9]), pommel: S([0, 0, 8.5]), tip: S([0, 0.2, -72], 'blade'), edge_a: S([0, -1.8, -12], 'blade'), edge_b: S([0, -1.0, -68], 'blade'), strike: S([0, -1.6, -48], 'blade') },
      poses: { folded: { parts: { blade: { rot: [178, 0, 0] } } }, hum: { parts: { blade: { at: [0.08, 0, 0] } } } },
      clips: {
        unfold: { duration: 0.35, keys: [{ t: 0, pose: 'folded' }, { t: 0.28, parts: { blade: { rot: [-4, 0, 0] } }, ease: 'smooth' }, { t: 0.35, parts: {} }], events: [{ t: 0.28, name: 'lock' }, { t: 0.3, name: 'hum_start' }] },
        fold: { duration: 0.4, keys: [{ t: 0, parts: {} }, { t: 0.4, pose: 'folded', ease: 'smooth' }], events: [{ t: 0, name: 'hum_stop' }] },
        hum: { duration: 0.1, loop: true, keys: [{ t: 0, parts: {} }, { t: 0.05, pose: 'hum', ease: 'step' }, { t: 0.1, parts: {} }] },
      },
    }),
  },
  breach_axe: {
    title: 'breaching axe (Fenwick BA-3 pick-axe)', hands: 2, set: 'heavy', length_cm: 78, mass_kg: 2.4,
    damage: { swing: 'slash' }, stamina: 22,
    cell: { size: [42, 14], grip: [0.1, 0.42], edge: [[0.88, 0.95], [0.99, 0.62]], radius: 1.8, haft: 0.62 },
    model: () => ({
      parts: [
        { ...cyl(0, 0, 8, -76, 1.5, od), name: 'haft' },
        { ...cyl(0, 0, 8, -14, 1.75, rubber), name: 'wrap' },
        box([0, 3.4, -71], [2.6, 6.8, 7], dark, { bevel: 0.3, name: 'socket_head' }),
        { ...profile([[-67.5, -2.8], [-61, -9.5], [-70, -12.5], [-79, -9], [-74.5, -2.8]], 1.2, steel, { material: 'bare_metal' }), name: 'bit' },
        { ...profile([[-68.5, 3.2], [-71, 13], [-73.5, 3.2]], 1.4, dark), name: 'pick' },
        box([0, -1.0, -6], [1.8, 0.6, 3], hazard),
      ],
      sockets: { grip: S([0, 0, 0]), grip_support: S([0, 0, -34]), pommel: S([0, 0, 8]), guard: S([0, 0, -14]), tip: S([0, 13, -71]), edge_a: S([0, -12.5, -70]), edge_b: S([0, -9, -79]), strike: S([0, -10.5, -73]) },
    }),
  },
  breach_hammer: {
    title: 'breaching hammer (Kessler 8 lb door sledge)', hands: 2, set: 'heavy', length_cm: 74, mass_kg: 4.1,
    damage: { swing: 'blunt' }, stamina: 26,
    cell: { size: [40, 10], grip: [0.1, 0.5], edge: [[0.86, 0.95], [1, 0.95]], radius: 2.2, haft: 0.62 },
    model: () => ({
      parts: [
        { ...cyl(0, 0, 6, -66, 1.6, od), name: 'haft' },
        { ...cyl(0, 0, 6, -12, 1.85, rubber), name: 'wrap' },
        box([0, 7, -70], [6, 14, 8], dark, { bevel: 0.8, name: 'head' }),
        box([0, -7.6, -70], [6.4, 1.2, 8.4], steel, { material: 'bare_metal', name: 'face' }),
        box([0, 3, -70], [6.2, 1.2, 8.2], hazard),
      ],
      sockets: { grip: S([0, 0, 0]), grip_support: S([0, 0, -32]), pommel: S([0, 0, 6]), guard: S([0, 0, -12]), tip: S([0, 0, -74]), edge_a: S([0, -8.2, -66]), edge_b: S([0, -8.2, -74]), strike: S([0, -8.2, -70]) },
    }),
  },
  riot_shield: {
    title: 'riot shield (Bastion RS-90 ballistic shield)', hands: 1, set: 'shield', length_cm: 92, mass_kg: 6.5, shield: true,
    damage: { bash: 'blunt' }, stamina: 15,
    // 2D: a separate part on the support forearm, drawn as the face in front views and the edge in side views
    cell: { size: [26, 48], grip: [0.5, 0.42], edge: [[0.62, 0.06], [0.62, 0.94]], radius: 2.4 },
    model: () => ({
      parts: [
        box([0, -3, -1.2], [1.4, 12, 2.4], rubber, { name: 'handle' }),
        { ...box([0, -2, -7], [52, 92, 1.8], '#30343a', { bevel: 0.6 }), name: 'panel' },
        { ...box([0, 34, -8.1], [26, 9, 0.6], '#8fb8c8', { opacity: 0.65, glass: true }), name: 'visor' },
        box([0, 28, -8.0], [36, 1.6, 0.5], hazard, { name: 'stripe' }),
        { ...box([0, -10, -8.1], [8, 2, 0.6], glow, { material: 'emissive_panel' }), name: 'lamp' },
        { type: 'box', w: 0.1, h: 0.1, d: 0.1, at: [26, 0, -7], texture: dark, name: 'hinge_r', pivot: [0, 0, 0] },
        { type: 'box', w: 0.1, h: 0.1, d: 0.1, at: [-26, 0, -7], texture: dark, name: 'hinge_l', pivot: [0, 0, 0] },
        { ...box([31, -2, -7], [10, 80, 1.6], '#2b2f34', { bevel: 0.4 }), name: 'wing_r', parent: 'hinge_r' },
        { ...box([-31, -2, -7], [10, 80, 1.6], '#2b2f34', { bevel: 0.4 }), name: 'wing_l', parent: 'hinge_l' },
      ],
      sockets: { grip: S([0, 0, 0]), arm_strap: S([0, -2, 9]), face: S([0, -2, -8]), rim_top: S([0, 44, -8]), rim_bottom: S([0, -48, -8]), edge_a: S([0, 40, -8.2]), edge_b: S([0, -44, -8.2]), strike: S([0, 4, -8.2]), lamp: S([0, -11, -8.4], 'lamp') },
      poses: { folded: { parts: { hinge_r: { rot: [0, -170, 0] }, hinge_l: { rot: [0, 170, 0] } } } },
      clips: {
        deploy: { duration: 0.45, keys: [{ t: 0, pose: 'folded' }, { t: 0.4, parts: { hinge_r: { rot: [0, 4, 0] }, hinge_l: { rot: [0, -4, 0] } }, ease: 'smooth' }, { t: 0.45, parts: {} }], events: [{ t: 0.4, name: 'lock' }] },
        fold: { duration: 0.5, keys: [{ t: 0, parts: {} }, { t: 0.5, pose: 'folded', ease: 'smooth' }], events: [{ t: 0.5, name: 'stow' }] },
      },
    }),
  },
};
export const MELEE_IDS = Object.keys(MELEE_WEAPONS);

/** art_model template for a melee weapon: {parts, sockets, poses?, clips?, notes, melee, scale, grid}. */
export function meleeTemplate(id) {
  const W = MELEE_WEAPONS[id];
  if (!W) throw new Error(`unknown melee weapon "${id}" (${MELEE_IDS.join(', ')})`);
  const m = W.model();
  const clips = Object.keys(m.clips || {});
  return {
    ...m, scale: 100, grid: 1,
    melee: { weapon: id, set: W.set, hands: W.hands, damage: W.damage, stamina: W.stamina, edge: ['edge_a', 'edge_b'], radius_cm: Math.round(W.cell.radius * CM_PER_UNIT * 10) / 10, length_cm: W.length_cm, mass_kg: W.mass_kg, ...(W.shock ? { shock: true } : {}), ...(W.shield ? { shield: true } : {}) },
    notes: `melee_${id} (${W.title}; cm, -Z forward, grip on the origin, edge on -Y). Sockets ${Object.keys(m.sockets).join(', ')}: edge_a -> edge_b is the hit line (sweep it frame to frame), strike = the strike zone centre.${clips.length ? ` Clips ${clips.join(', ')}.` : ''} art_anim melee_sheet renders the world sheet (views x pitch, grip on a fixed pixel) characters hold as a runtime layer.`,
  };
}
/** MODEL_TEMPLATES entries: melee_<id>. */
export const MELEE_TEMPLATES = Object.fromEntries(MELEE_IDS.map((id) => [`melee_${id}`, () => meleeTemplate(id)]));

/**
 * The 2D weapon cell of a melee weapon for a character frame: {w, h, pivot, edge:[[u,v],[u,v]] cell
 * px, radius px, shock_from?}. Units: humanoid_hd body units (u lengths, uw widths).
 */
export function meleeCell(id, [W, H]) {
  const M = MELEE_WEAPONS[id];
  if (!M) throw new Error(`unknown melee weapon "${id}" (${MELEE_IDS.join(', ')})`);
  const u = (H - 4) / 98, uw = Math.min(u, W / 66);
  const c = M.cell;
  const w = Math.max(3, Math.round(c.size[0] * (M.shield ? uw : u))), h = Math.max(2, Math.round(c.size[1] * u));
  const pt = (f) => [Math.round(f[0] * (w - 1) * 10) / 10, Math.round(f[1] * (h - 1) * 10) / 10];
  return { id, w, h, pivot: [Math.round(c.grip[0] * (w - 1)), Math.round(c.grip[1] * (h - 1))], edge: c.edge.map(pt), radius: Math.round(c.radius * u * 10) / 10, ...(c.shock_from ? { shock_from: c.shock_from } : {}), ...(c.haft ? { haft: Math.round(c.haft * (w - 1)) } : {}), hands: M.hands, set: M.set, shield: !!M.shield };
}
