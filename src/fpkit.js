// Built-in first-person kit: the standard gun of every handling class (built to the class grip
// geometry from handling.js), magazines, generic attachments and hand items, as ordinary art_model
// definitions (centimetres: scale 100 = metres on export). Anchors are art_model sockets named
// like the fp v2 contract (grip, support, mag_well, muzzle, optic, muzzle_mount, underbarrel,
// sight, mount); moving parts are named nodes with state poses (bolt_back, slide_locked, ...).
// Gun space: origin = the trigger hand's grip anchor, -Z = muzzle, +Y = up, +X = right.
import { HANDLING_CLASSES, gripGeometry, scaleGeometry, classOf } from './handling.js';
import { HEX } from './fppaint.js';

/** Centimetres per body unit for first-person guns (handling.js geometry is in body units). */
export const FP_UNIT = { long: { u: 1.6, uw: 2.6 }, pistol: { u: 1.0, uw: 1.5 } };
export const GUN_CLASSES = ['pistol', 'smg', 'rifle', 'dmr', 'shotgun', 'lmg', 'sniper', 'launcher'];
export const ITEM_CLASSES = ['unarmed', 'knife', 'grenade', 'med', 'tablet'];
export const FP_CLASSES = [...GUN_CLASSES, ...ITEM_CLASSES];
const r1 = (v) => Math.round(v * 10) / 10;

/**
 * First-person standard geometry of a gun class (cm, gun space): the class grip geometry (support,
 * stock, muzzle) from handling.js scaled by FP_UNIT, plus the anchors every gun of the class puts
 * at the same place so magazines, foregrips and the arms' reload / vgrip poses fit any of them.
 */
export function fpGeometry(cls) {
  const c = classOf(cls);
  const H = HANDLING_CLASSES[c];
  if (!H.cell) return null;
  const G = scaleGeometry(gripGeometry(c), FP_UNIT[H.kind]);
  const P = (along, up, x = 0) => [r1(x), r1(up), r1(-along)];
  const hb = -G.muzzle[1]; // bore height above the grip anchor
  if (H.kind === 'pistol') {
    const rear = G.stock[0];
    return {
      class: c, kind: 'pistol', geometry: G.geometry, unit: FP_UNIT.pistol, bore: r1(hb),
      grip: [0, 0, 0], support: [-2.4, -1.6, -1.2], stock: P(rear, -G.stock[1]), muzzle: P(G.muzzle[0], hb), muzzle_mount: P(G.muzzle[0], hb),
      sight: P(rear + 1.2, hb + 1.7), optic: P(rear + 5.2, hb + 1.2), mag_well: P(0.9, -4.6), underbarrel: P(G.muzzle[0] - 4, hb - 2.2), charging: P(rear + 1.5, hb + 0.6),
      tolerance: G.tolerance,
    };
  }
  const sup = G.support, stk = G.stock;
  const rail = hb + 3.6, hgBottom = hb - 2.8;
  return {
    class: c, kind: 'long', geometry: G.geometry, unit: FP_UNIT.long, bore: r1(hb),
    grip: [0, 0, 0], support: P(sup[0], -sup[1]), stock: P(stk[0], -stk[1]), muzzle: P(G.muzzle[0], hb), muzzle_mount: P(G.muzzle[0], hb),
    optic: P(7, rail), sight: P(1.5, rail + 2.6), underbarrel: P(sup[0] + 2.5, hgBottom), mag_well: P(11.5, hb - 7.4), charging: P(-3, hb + 2.6),
    rail: r1(rail), handguard_bottom: r1(hgBottom), tolerance: G.tolerance,
  };
}

// ---------- part helpers (cm) ----------
/** Box by centre and size. */
const box = (c, s, mat, o = {}) => ({ type: 'box', w: s[0], h: s[1], d: s[2], at: [c[0], c[1] - s[1] / 2, c[2]], texture: HEX[mat] ?? mat, ...o });
/** Cylinder along -Z from z0 to z1 (z1 < z0) on the axis (x, y). */
const cyl = (x, y, z0, z1, r, mat, o = {}) => ({ type: 'cylinder', r, h: z0 - z1, segments: 10, rotate: [-90, 0, 0], at: [x, y, z0], texture: HEX[mat] ?? mat, ...o });
/** Picatinny rail with teeth from z0 to z1 on top of y. */
function rail(y, z0, z1, mat = 'gunmetal', w = 2.1) {
  const n = Math.max(1, Math.floor((z0 - z1) / 1.0));
  return [box([0, y + 0.35, (z0 + z1) / 2], [w, 0.7, z0 - z1], mat), box([0, y + 0.95, z0 - 0.5], [w * 0.9, 0.5, 0.5], mat, { array: { count: n, step: [0, 0, -1] } })];
}
const sockets = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v).map(([k, v]) => [k, Array.isArray(v) ? { at: v } : v]));

/**
 * Anchors of a class's standard gun straight from the class table (fpGeometry), the same points
 * gunModel's sockets carry, without building any model: what hand-drawn guns use as their prior.
 */
export function classSockets(cls) {
  const G = fpGeometry(cls);
  if (!G) return {};
  const hb = G.bore, S = { grip: G.grip, support: G.support, mag_well: G.mag_well, muzzle: G.muzzle, muzzle_mount: G.muzzle_mount, sight: G.sight, stock: G.stock };
  if (G.class === 'launcher') S.mag_well = [0, G.bore, 5];
  if (G.kind === 'long' && G.class !== 'launcher') { S.optic = G.optic; S.underbarrel = G.underbarrel; }
  if (G.kind === 'pistol') S.underbarrel = G.underbarrel;
  if (G.class === 'pistol') S.charging = [0, hb + 0.4, G.stock[2] - 1.5];
  else if (G.class === 'shotgun') S.pump = G.support;
  else if (G.class === 'sniper') S.bolt_handle = [4.6, hb + 0.6, 1.1];
  else if (G.class !== 'launcher') S.charging = [0, G.bore + 2.6 + 0.4, G.charging[2] + 2.4];
  return Object.fromEntries(Object.entries(S).map(([k, v]) => [k, v.slice()]));
}
/** Magazine of each class's standard gun (class table). */
export const CLASS_MAG = { pistol: 'pistol_mag', smg: 'smg_mag', rifle: 'rifle_mag_30', dmr: 'dmr_mag_20', shotgun: 'shotgun_shell', lmg: 'lmg_box_100', sniper: 'sniper_mag_5', launcher: 'rocket' };
/** How many kit model definitions were built (gun / mag / attachment / item): tests prove the all-2D path builds none. */
export const KIT_BUILDS = { gun: 0, mag: 0, attachment: 0, item: 0 };

/** Hand grasp frames for gun anchors (gun space): fingers direction, back-of-hand direction, palm offset. */
export const GRASP = {
  grip: { fingers: [0, -0.32, -1], dorsal: [1, 0.12, 0], palm: [1.9, 0.4, 1.2], preset: 'trigger' },
  support: { fingers: [0.72, 0.05, -0.7], dorsal: [-0.15, -1, 0], palm: [0, -0.9, 0], preset: 'support_under' },
  support_pistol: { fingers: [0.55, -0.35, -0.75], dorsal: [-0.85, -0.35, 0.2], palm: [-0.6, -0.4, 0.2], preset: 'pistol_cup' },
  vgrip: { fingers: [0.15, 0, -1], dorsal: [-1, 0, -0.15], palm: [-1.8, 0, 0.3], preset: 'vgrip' },
  agrip: { fingers: [0.3, -0.35, -0.9], dorsal: [-0.55, -0.8, 0], palm: [-0.4, -1.4, 0.4], preset: 'agrip' },
  pump: { fingers: [0.72, 0.05, -0.7], dorsal: [-0.15, -1, 0], palm: [0, -1.2, 0], preset: 'support_under' },
  mag: { fingers: [0.35, -0.25, -0.9], dorsal: [-1, 0.1, -0.35], palm: [-2.1, -2.5, 0.2], preset: 'mag_grasp' },
  charging: { fingers: [0.85, -0.3, 0.45], dorsal: [-0.2, 0.9, 0.4], palm: [-1.6, 1.6, 1.2], preset: 'pinch' },
  bolt_handle: { fingers: [0.8, -0.2, 0.5], dorsal: [0, 1, 0.3], palm: [0.6, 1.2, 1.2], preset: 'pinch' },
  launcher_grip: { fingers: [0, -0.3, -1], dorsal: [1, 0.1, 0], palm: [1.9, 0.4, 1.2], preset: 'trigger' },
};

// ---------- guns ----------
/** Standard gun of a class (art_model definition, cm). */
export function gunModel(cls, o = {}) {
  KIT_BUILDS.gun++;
  const G = fpGeometry(cls);
  if (!G) throw new Error(`class "${cls}" has no gun`);
  const name = o.name ?? cls;
  const make = { pistol: pistolParts, shotgun: shotgunParts, sniper: sniperParts, launcher: launcherParts }[G.class] || arParts;
  const { parts, poses, extra = {}, states } = make(G, o);
  // launcher: breech-loading (the rocket goes in at the rear opening of the front tube, in reach)
  if (G.class === 'launcher') G.mag_well = [0, G.bore, 5];
  const S = { grip: G.grip, support: G.support, mag_well: G.mag_well, muzzle: G.muzzle, muzzle_mount: G.muzzle_mount, sight: G.sight, stock: G.stock, ...extra };
  if (G.kind === 'long' && G.class !== 'launcher') { S.optic = G.optic; S.underbarrel = G.underbarrel; }
  if (G.kind === 'pistol') { S.optic = null; S.underbarrel = G.underbarrel; }
  return {
    name, parts, scale: 100, grid: 1, origin: 'auto', sockets: sockets(S), poses,
    fp: { kind: 'gun', class: G.class, mag: o.mag ?? MAG_OF[G.class], states: states || {}, ...(parts.some((p) => p.name === 'stock') ? { sweep_hide: ['stock'] } : {}) },
    notes: `fp kit gun "${name}" (class ${G.class}, cm, gun space: origin = grip, -Z = muzzle). Sockets are the fp v2 anchors; poses are moving-part states.`,
  };
}

function arParts(G, o) {
  const c = G.class, hb = G.bore, mz = -G.muzzle[2];
  const size = { smg: 0.86, rifle: 1, dmr: 1.05, lmg: 1.18 }[c] ?? 1;
  const hgLen = { smg: 14, rifle: 22, dmr: 30, lmg: 26 }[c] ?? 22, hg0 = 14 * size;
  const furn = o.furniture ?? (c === 'dmr' ? 'polymer_tan' : c === 'lmg' ? 'polymer_od' : 'polymer');
  const recTop = hb + 2.2, recBot = hb - 3.8;
  const parts = [
    // lower + upper receiver
    box([0, (recBot + hb) / 2, -4.5], [2.5 * size, hb - recBot, 20 * size], 'gunmetal', { bevel: 0.25 }),
    box([0, (hb + recTop) / 2, -4.5], [2.7 * size, recTop - hb, 20.5 * size], 'gunmetal', { bevel: 0.3 }),
    ...rail(recTop, 5.5, -hg0 + 0.5),
    // magazine well
    box([0, G.mag_well[1] + 2.3, G.mag_well[2]], [2.9 * size, 4.6, 6.2], 'gunmetal', { bevel: 0.3 }),
    // pistol grip (raked) + trigger guard
    box([0, -0.6, 1.3], [2.5, 9.8, 3.3], furn, { rotate: [-17, 0, 0], pivot: [0, 9.8, 0], bevel: 0.45 }),
    box([0, recBot - 0.3, -4.3], [0.6, 0.5, 7], 'gunmetal'),
    // ejection port + forward assist (right side detail)
    box([1.35 * size, hb + 0.5, -6.5], [0.2, 1.7, 5.5], 'blued'),
    cyl(1.4 * size, hb + 1.2, -1.5, -3.6, 0.55, 'steel', { segments: 8 }),
    // handguard with vents
    box([0, hb - 0.1, -hg0 - hgLen / 2], [3.6 * size, 5.4, hgLen], furn, { bevel: 0.6 }),
    box([1.85 * size, hb + 0.4, -hg0 - hgLen / 2], [0.1, 1.2, hgLen - 4], 'blued'),
    box([-1.85 * size, hb + 0.4, -hg0 - hgLen / 2], [0.1, 1.2, hgLen - 4], 'blued'),
    ...rail(hb + 2.7, -hg0, -hg0 - hgLen + 0.5),
    // barrel, gas block, front sight post
    cyl(0, hb, -hg0 - hgLen, -mz + (c === 'lmg' ? 0 : 0), c === 'lmg' ? 1.1 : 0.75, 'steel'),
    box([0, hb + 1.4, -hg0 - hgLen - 2], [1.4, 3.2, 1.6], 'gunmetal', { bevel: 0.2 }),
    box([0, G.sight[1] - 0.5, -hg0 - hgLen + 1.5], [0.35, 2.2, 0.35], 'blued'),
    // rear sight (flip-up irons)
    box([0, G.sight[1] - 1.0, G.sight[2]], [1.6, 2.0, 1.2], 'blued', { bevel: 0.15 }),
    // buffer tube + stock
    { ...box([0, hb - 0.3, 6 + (G.stock[2] - 6) / 2], [2.4, 2.8, G.stock[2] - 6], 'gunmetal', { bevel: 0.6 }), name: 'stock' },
    box([0, G.stock[1] - 1.5, G.stock[2] - 5.2], [3.4, 8.6, 11], furn, { bevel: 0.8, rotate: [4, 0, 0], pivot: [0, 8.6, 5.5], parent: 'stock' }),
    box([0, G.stock[1] - 1.5, G.stock[2] + 0.4], [3.6, 9.0, 0.8], 'rubber', { bevel: 0.3, parent: 'stock' }),
    // muzzle (bare crown / birdcage), replaced visually by muzzle devices
    cyl(0, hb, -mz + 4.5, -mz, c === 'lmg' ? 1.25 : 0.95, 'blued', { segments: 8 }),
    // moving parts
    { ...box([0, -0.2, -2.3], [0.4, 1.8, 0.5], 'steel', { rotate: [12, 0, 0], pivot: [0, 1.8, 0] }), name: 'trigger' },
    { ...box([1.45 * size, hb - 2.6, -7], [0.3, 0.9, 0.9], 'steel'), name: 'mag_release' },
    { ...box([0.6 * size, hb + 0.6, -6.5], [1.4, 1.2, 5], 'steel'), name: 'bolt' },
    { ...box([0, recTop + 0.3, G.charging[2] + 0.5], [1.2, 0.6, 4], 'gunmetal'), name: 'charging_handle' },
    box([0, recTop + 0.3, G.charging[2] + 2.4], [3.6, 0.7, 1.0], 'gunmetal', { parent: 'charging_handle', bevel: 0.2 }),
  ];
  if (c === 'lmg') {
    parts.push({ ...box([0, recTop + 0.6, -6], [3.6, 1.2, 15], 'gunmetal', { bevel: 0.4 }), name: 'cover' });
    parts.push(box([0, recTop + 3.2, -10], [1.6, 0.8, 9], 'gunmetal', { bevel: 0.2 }), box([0, recTop + 1.6, -6.2], [1.1, 2.6, 1.0], 'gunmetal'), box([0, recTop + 1.6, -13.8], [1.1, 2.6, 1.0], 'gunmetal'));
  }
  const poses = {
    bolt_back: { parts: { bolt: { at: [0, 0, 5.5] } } },
    charging_back: { parts: { bolt: { at: [0, 0, 5.5] }, charging_handle: { at: [0, 0, 6] } } },
    trigger_pulled: { parts: { trigger: { rot: [-18, 0, 0] } } },
    mag_release: { parts: { mag_release: { at: [-0.4, 0, 0] } } },
    ...(c === 'lmg' ? { cover_open: { parts: { cover: { rot: [62, 0, 0] } } } } : {}),
  };
  if (c === 'lmg') parts[parts.findIndex((p) => p.name === 'cover')].pivot = [0, 0, 7.5];
  return { parts, poses, states: { bolt_back: 'bolt_back', charging_back: 'charging_back', ...(c === 'lmg' ? { cover_open: 'cover_open' } : {}) }, extra: { charging: { part: 'charging_handle', at: [0, G.bore + 2.6 + 0.4, G.charging[2] + 2.4] } } };
}

function pistolParts(G) {
  const hb = G.bore, mz = -G.muzzle[2], rear = G.stock[2];
  const parts = [
    // frame + grip
    box([0, hb - 2.0, (rear + -mz) / 2 + 0.6], [2.4, 1.6, mz + rear - 1.2], 'polymer', { bevel: 0.3 }),
    box([0, -1.4, 0.6], [2.6, 9.6, 3.6], 'polymer', { rotate: [-16, 0, 0], pivot: [0, 9.6, 0], bevel: 0.6 }),
    box([0, hb - 3.4, -3.6], [0.5, 0.5, 4.6], 'polymer'),
    box([0, hb - 2.9, -mz + 2.2], [2.2, 1.0, 3.6], 'polymer', { bevel: 0.2 }),
    // moving: slide (+ sights on it), trigger, mag release
    { ...box([0, hb + 0.25, (rear - mz) / 2], [2.3, 2.7, mz + rear], 'blued', { bevel: 0.35 }), name: 'slide' },
    box([0, hb + 1.8, rear - 1.2], [1.8, 0.7, 0.9], 'gunmetal', { parent: 'slide' }),
    box([0, hb + 1.8, -mz + 1.2], [0.4, 0.7, 0.7], 'gunmetal', { parent: 'slide' }),
    box([1.17, hb + 0.6, -3.5], [0.1, 1.2, 4.2], 'gunmetal', { parent: 'slide' }),
    cyl(0, hb, -mz + 0.2, -mz - 0.2, 0.55, 'steel', { segments: 8 }),
    { ...box([0, hb - 3.1, -2.2], [0.4, 1.6, 0.5], 'steel', { rotate: [10, 0, 0], pivot: [0, 1.6, 0] }), name: 'trigger' },
    { ...box([-1.3, hb - 2.8, -0.8], [0.3, 0.8, 0.8], 'steel'), name: 'mag_release' },
  ];
  return {
    parts,
    poses: { slide_back: { parts: { slide: { at: [0, 0, 3.4] } } }, slide_locked: { parts: { slide: { at: [0, 0, 3.4] } } }, trigger_pulled: { parts: { trigger: { rot: [-18, 0, 0] } } } },
    states: { slide_locked: 'slide_locked' },
    extra: { charging: { part: 'slide', at: [0, hb + 0.4, rear - 1.5] } },
  };
}

function shotgunParts(G) {
  const hb = G.bore, mz = -G.muzzle[2], recTop = hb + 2.2, recBot = hb - 4;
  const parts = [
    box([0, (recBot + recTop) / 2, -5], [3, recTop - recBot, 22], 'gunmetal', { bevel: 0.4 }),
    ...rail(recTop, 4, -14),
    box([0, -0.6, 1.3], [2.6, 9.8, 3.4], 'polymer', { rotate: [-17, 0, 0], pivot: [0, 9.8, 0], bevel: 0.45 }),
    box([0, recBot - 0.3, -4.3], [0.6, 0.5, 7], 'gunmetal'),
    cyl(0, hb, -16, -mz, 0.95, 'steel'),
    cyl(0, hb - 2.4, -16, -mz + 3, 0.85, 'gunmetal', { segments: 8 }),
    box([0, hb + 1.1, -mz + 1], [0.35, 0.5, 0.35], 'brass'),
    box([0, G.sight[1] - 1.0, G.sight[2]], [1.6, 2.0, 1.2], 'blued', { bevel: 0.15 }),
    box([1.55, hb, -6], [0.2, 2.0, 7], 'blued'),
    { ...box([0, hb - 0.6, 6 + (G.stock[2] - 6) / 2], [2.6, 3.2, G.stock[2] - 6], 'polymer', { bevel: 0.6 }), name: 'stock' },
    box([0, G.stock[1] - 1.5, G.stock[2] - 5.2], [3.4, 8.6, 11], 'polymer', { bevel: 0.8, rotate: [4, 0, 0], pivot: [0, 8.6, 5.5], parent: 'stock' }),
    box([0, G.stock[1] - 1.5, G.stock[2] + 0.4], [3.6, 9, 0.8], 'rubber', { bevel: 0.3, parent: 'stock' }),
    { ...box([0, hb - 2.4, G.support[2]], [3.4, 3.8, 14], 'polymer', { bevel: 0.6 }), name: 'pump' },
    box([0, hb - 2.4, G.support[2]], [3.6, 0.5, 12], 'rubber', { parent: 'pump', array: { count: 6, step: [0, 0.6, 0] } }),
    { ...box([0, -0.2, -2.3], [0.4, 1.8, 0.5], 'steel', { rotate: [12, 0, 0], pivot: [0, 1.8, 0] }), name: 'trigger' },
  ];
  return { parts, poses: { pump_back: { parts: { pump: { at: [0, 0, 7.5] } } }, trigger_pulled: { parts: { trigger: { rot: [-18, 0, 0] } } } }, states: { pump_back: 'pump_back' }, extra: { pump: { part: 'pump', at: G.support } } };
}

function sniperParts(G) {
  const hb = G.bore, mz = -G.muzzle[2];
  const parts = [
    cyl(0, hb, 6, -14, 1.7, 'gunmetal', { segments: 12 }),
    ...rail(hb + 1.6, 5, -13, 'gunmetal', 2.0),
    box([0, hb - 1.8, -10], [3.6, 4.4, 34], 'polymer_od', { bevel: 0.8 }),
    box([0, -0.6, 1.3], [2.8, 9.8, 3.6], 'polymer_od', { rotate: [-12, 0, 0], pivot: [0, 9.8, 0], bevel: 0.7 }),
    box([0, hb - 4.6, -4.3], [0.6, 0.5, 7], 'gunmetal'),
    cyl(0, hb, -14, -mz, 1.0, 'steel', { segments: 10 }),
    box([0, G.mag_well[1] + 2.3, G.mag_well[2]], [3.0, 4.6, 6.2], 'gunmetal', { bevel: 0.3 }),
    { ...box([0, G.stock[1] - 0.5, G.stock[2] / 2 + 3], [3.4, 7, G.stock[2] - 6], 'polymer_od', { bevel: 1 }), name: 'stock' },
    box([0, G.stock[1] + 1.8, G.stock[2] / 2 + 6], [2.6, 2.2, 14], 'polymer_od', { bevel: 0.6, parent: 'stock' }),
    box([0, G.stock[1] - 1.0, G.stock[2] + 0.4], [3.6, 8.4, 0.8], 'rubber', { bevel: 0.3, parent: 'stock' }),
    cyl(0, hb, -mz + 7, -mz, 1.35, 'blued', { segments: 10 }),
    { ...cyl(0, hb + 0.6, 2.5, -4, 0.9, 'steel', { segments: 8 }), name: 'bolt' },
    { ...box([2.6, hb + 0.6, 1.2], [3.6, 0.7, 0.7], 'steel', { pivot: [-1.8, 0.35, 0] }), parent: 'bolt', name: 'bolt_handle' },
    cyl(4.6, hb + 0.6, 1.6, 0.6, 0.9, 'steel', { parent: 'bolt_handle', segments: 8 }),
    { ...box([0, -0.2, -2.3], [0.4, 1.8, 0.5], 'steel', { rotate: [12, 0, 0], pivot: [0, 1.8, 0] }), name: 'trigger' },
  ];
  return {
    parts,
    poses: { bolt_up: { parts: { bolt_handle: { rot: [0, 0, 75] } } }, bolt_back: { parts: { bolt_handle: { rot: [0, 0, 75] }, bolt: { at: [0, 0, 9] } } } },
    states: { bolt_up: 'bolt_up', bolt_back: 'bolt_back' },
    extra: { bolt_handle: { part: 'bolt_handle', at: [4.6, hb + 0.6, 1.1] } },
  };
}

function launcherParts(G) {
  const hb = G.bore, mz = -G.muzzle[2];
  const parts = [
    cyl(0, hb, 6, -mz, 4.6, 'polymer_od', { segments: 14 }),
    { ...cyl(0, hb, G.stock[2] + 2, 6, 4.6, 'polymer_od', { segments: 14 }), name: 'stock' },
    cyl(0, hb, G.stock[2] + 3.5, G.stock[2] + 1.5, 5.2, 'rubber', { segments: 14, parent: 'stock' }),
    cyl(0, hb, -mz + 2, -mz, 5.1, 'gunmetal', { segments: 14 }),
    box([0, -0.6, 1.3], [2.8, 9.8, 3.6], 'polymer', { rotate: [-12, 0, 0], pivot: [0, 9.8, 0], bevel: 0.7 }),
    box([0, hb - 4.2, -1], [3, 4, 9], 'gunmetal', { bevel: 0.6 }),
    box([0, G.support[1] - 1, G.support[2]], [2.8, 8, 3.4], 'polymer', { bevel: 0.7 }),
    box([-5.6, hb + 2.4, -8], [2.6, 3.4, 9], 'gunmetal', { bevel: 0.5 }),
    box([-5.6, hb + 2.4, -12.6], [2.2, 2.6, 0.2], 'glass'),
    box([0, G.sight[1] - 1.0, G.sight[2]], [1.6, 2.0, 1.2], 'blued', { bevel: 0.15 }),
    { ...box([0, -0.2, -2.3], [0.4, 1.8, 0.5], 'steel', { rotate: [12, 0, 0], pivot: [0, 1.8, 0] }), name: 'trigger' },
  ];
  return { parts, poses: { trigger_pulled: { parts: { trigger: { rot: [-18, 0, 0] } } } }, states: {}, extra: {} };
}

// ---------- magazines (mount = top centre, sits on the gun's mag_well) ----------
const MAG_OF = { pistol: 'pistol_mag', smg: 'smg_mag', rifle: 'rifle_mag_30', dmr: 'dmr_mag_20', shotgun: 'shotgun_shell', lmg: 'lmg_box_100', sniper: 'sniper_mag_5', launcher: 'rocket' };
export function magModel(name) {
  KIT_BUILDS.mag++;
  const mk = {
    rifle_mag_30: () => [
      box([0, -4, -0.6], [2.2, 8.4, 6.2], 'mag_steel', { bevel: 0.3, rotate: [8, 0, 0], pivot: [0, 8.4, 0] }),
      box([0, -11.2, -2.3], [2.2, 6.6, 6.0], 'mag_steel', { bevel: 0.3, rotate: [22, 0, 0], pivot: [0, 6.6, 0] }),
      box([0, -14.6, -4.0], [2.6, 1.2, 6.6], 'polymer', { bevel: 0.3, rotate: [24, 0, 0], pivot: [0, 1.2, 0] }),
      box([0, 0.2, 0], [1.4, 0.6, 4.2], 'brass'),
    ],
    dmr_mag_20: () => [box([0, -3.6, -0.4], [2.3, 7.4, 6.6], 'mag_steel', { bevel: 0.3, rotate: [6, 0, 0], pivot: [0, 7.4, 0] }), box([0, -9.3, -1.6], [2.3, 4.2, 6.6], 'mag_steel', { bevel: 0.3, rotate: [14, 0, 0], pivot: [0, 4.2, 0] }), box([0, -11.6, -2.6], [2.7, 1, 7], 'polymer', { bevel: 0.3 }), box([0, 0.2, 0], [1.4, 0.6, 4.6], 'brass')],
    smg_mag: () => [box([0, -6, -0.3], [1.8, 12, 3.6], 'mag_steel', { bevel: 0.25, rotate: [4, 0, 0], pivot: [0, 12, 0] }), box([0, -12.4, -0.8], [2.2, 1, 4], 'polymer', { bevel: 0.2 }), box([0, 0.2, 0], [1.0, 0.5, 2.4], 'brass')],
    pistol_mag: () => [box([0, -4.6, 0.6], [1.8, 9.4, 3.2], 'mag_steel', { bevel: 0.25, rotate: [-16, 0, 0], pivot: [0, 9.4, 0] }), box([0, -9.8, 2.2], [2.2, 1, 3.6], 'polymer', { bevel: 0.2, rotate: [-16, 0, 0], pivot: [0, 1, 0] }), box([0, 0.1, 0], [0.9, 0.5, 2.2], 'brass')],
    sniper_mag_5: () => [box([0, -2.6, 0], [2.4, 5.4, 9], 'mag_steel', { bevel: 0.3 }), box([0, -5.6, 0], [2.8, 1, 9.4], 'polymer', { bevel: 0.2 })],
    lmg_box_100: () => [box([-1.2, -5.6, 0], [7, 11, 11], 'polymer_od', { bevel: 0.6 }), box([-1.2, -5.6, 0], [7.2, 1.2, 11.2], 'rubber'), box([0.4, 0.4, 0], [1.6, 1.2, 6], 'brass', { array: { count: 3, step: [0, 0, 0] } }), box([-4.8, -3, 0], [0.2, 4, 6], 'mag_steel')],
    shotgun_shell: () => [cyl(0, 0, 1.8, -3.4, 1.05, 'shell_red', { segments: 10 }), cyl(0, 0, 3.4, 1.8, 1.12, 'brass', { segments: 10 })],
    rocket: () => [cyl(0, 0, 0, -30, 3.2, 'od_green', { segments: 12 }), { type: 'cone', r: 3.2, h: 9, segments: 12, rotate: [-90, 0, 0], at: [0, 0, -30], texture: HEX.gunmetal }, cyl(0, 0, 4, 0, 2.2, 'gunmetal', { segments: 10 })],
  }[name];
  if (!mk) throw new Error(`unknown magazine "${name}" (${Object.keys(MAG_OF).map((k) => MAG_OF[k]).join(', ')})`);
  return { name, parts: mk(), scale: 100, grid: 1, origin: 'auto', sockets: { mount: { at: [0, 0, 0] } }, fp: { kind: 'mag' }, notes: `fp kit magazine "${name}" (cm, mount = top centre on the gun's mag_well).` };
}
export const MAGS = Object.values(MAG_OF);

// ---------- attachments (generic: mount = where it meets the gun) ----------
/** slot -> the gun anchor it snaps to; classes = the classes whose standard gun has that anchor. */
export const ATTACH = {
  reflex: { slot: 'optic', make: () => ({
    parts: [box([0, 0.5, 0], [2.4, 1, 4.6], 'gunmetal', { bevel: 0.2 }), box([0, 1.5, 0.2], [2.8, 1.0, 4.0], 'gunmetal', { bevel: 0.3 }), box([1.25, 2.8, -1.4], [0.35, 3.2, 0.9], 'gunmetal'), box([-1.25, 2.8, -1.4], [0.35, 3.2, 0.9], 'gunmetal'), box([0, 4.6, -1.4], [2.85, 0.5, 0.9], 'gunmetal'), { ...box([0, 2.9, -1.35], [2.15, 2.9, 0.15], 'glass'), name: 'lens' }, box([0, 2.9, -1.5], [0.3, 0.3, 0.1], 'reticle', { parent: 'lens' })],
    sockets: { mount: [0, 0, 0], sight: [0, 2.9, -1.4] } }) },
  scope_4x: { slot: 'optic', make: () => ({
    parts: [box([0, 0.8, 1.6], [2.4, 1.6, 1.8], 'gunmetal', { bevel: 0.2 }), box([0, 0.8, -3.4], [2.4, 1.6, 1.8], 'gunmetal', { bevel: 0.2 }), cyl(0, 3.4, 6.5, -8.5, 1.5, 'blued', { segments: 14 }), cyl(0, 3.4, 8.8, 6.5, 2.0, 'blued', { segments: 14 }), cyl(0, 3.4, -8.5, -12.5, 2.3, 'blued', { segments: 14 }), { type: 'cylinder', r: 0.9, h: 1.4, segments: 8, at: [0, 4.8, -1], texture: HEX.gunmetal }, { type: 'cylinder', r: 0.8, h: 1.3, segments: 8, rotate: [0, 0, -90], at: [1.4, 3.4, -1], texture: HEX.gunmetal }, { ...cyl(0, 3.4, 8.85, 8.75, 1.7, 'glass', { segments: 14 }), name: 'lens' }, cyl(0, 3.4, -12.45, -12.55, 2.0, 'glass', { parent: 'lens', segments: 14 })],
    sockets: { mount: [0, 0, 0], sight: [0, 3.4, 8.8] } }) },
  suppressor: { slot: 'muzzle', make: () => ({ parts: [cyl(0, 0, 0, -18, 1.9, 'blued', { segments: 12 }), cyl(0, 0, 0.2, -1.2, 2.05, 'gunmetal', { segments: 12 }), cyl(0, 0, -16.8, -18.1, 2.0, 'gunmetal', { segments: 12 })], sockets: { mount: [0, 0, 0], muzzle: [0, 0, -18.1] } }) },
  compensator: { slot: 'muzzle', make: () => ({ parts: [cyl(0, 0, 0, -6, 1.15, 'gunmetal', { segments: 10 }), box([0, 0.9, -2.2], [0.6, 0.5, 1.0], 'blued'), box([0, 0.9, -4.2], [0.6, 0.5, 1.0], 'blued'), box([0.95, 0, -3.2], [0.5, 0.6, 2.4], 'blued'), box([-0.95, 0, -3.2], [0.5, 0.6, 2.4], 'blued')], sockets: { mount: [0, 0, 0], muzzle: [0, 0, -6] } }) },
  vertical_grip: { slot: 'underbarrel', make: () => ({ parts: [box([0, -0.6, 0], [2.0, 1.2, 4.4], 'polymer', { bevel: 0.2 }), box([0, -5.4, 0], [2.6, 9.4, 2.9], 'polymer', { bevel: 0.7, rotate: [6, 0, 0], pivot: [0, 9.4, 0] }), box([0, -9.9, 0.4], [2.9, 0.8, 3.2], 'rubber', { bevel: 0.3 })], sockets: { mount: [0, 0, 0], support: [0, -5.2, 0.3] }, grasp: 'vgrip' }) },
  angled_grip: { slot: 'underbarrel', make: () => ({ parts: [box([0, -0.5, 0], [2.0, 1.0, 7], 'polymer', { bevel: 0.2 }), { type: 'wedge', w: 2.4, h: 3.4, d: 7, top_d: 7, shift: [0, 0], at: [0, -3.9, 0], rotate: [180, 0, 0], pivot: [0, 1.7, 0], texture: HEX.polymer }], sockets: { mount: [0, 0, 0], support: [0, -2.6, 0.8] }, grasp: 'agrip' }) },
};
/** Attachment model definition. */
export function attachModel(name) {
  KIT_BUILDS.attachment++;
  const A = ATTACH[name];
  if (!A) throw new Error(`unknown attachment "${name}" (${Object.keys(ATTACH).join(', ')})`);
  const m = A.make();
  return { name, parts: m.parts, scale: 100, grid: 1, origin: 'auto', sockets: sockets(m.sockets), fp: { kind: 'attachment', slot: A.slot, ...(m.grasp ? { grasp: m.grasp } : {}), ...(m.parts.some((p) => p.name === 'lens') ? { lens: 'lens' } : {}) }, notes: `fp kit attachment "${name}" (slot ${A.slot}: mount snaps onto the gun's ${A.slot === 'optic' ? 'optic' : A.slot === 'muzzle' ? 'muzzle_mount' : 'underbarrel'} anchor).` };
}

// ---------- items (grip = where the hand holds it) ----------
export const ITEMS = {
  knife: () => ({ parts: [box([0, 0, 0], [1.6, 2.4, 11], 'rubber', { bevel: 0.6 }), box([0, 0, -5.9], [3.2, 3.2, 0.8], 'gunmetal', { bevel: 0.2 }), { type: 'wedge', w: 0.5, h: 3.2, d: 17, top_d: 0, shift: [0, 8.5], at: [0, -1.6, -14.8], texture: HEX.blade }, box([0, -0.6, -10.8], [0.55, 2.0, 9.6], 'blade', { bevel: 0.1 }), cyl(0, 0, 6.2, 5.2, 1.2, 'gunmetal', { segments: 8 })], sockets: { grip: { at: [0, 0, 0] }, tip: { at: [0, -1.3, -23.3] } } }),
  frag: () => ({ parts: [{ type: 'cylinder', r: 3.0, r_top: 2.4, r_bottom: 2.4, h: 6.6, segments: 12, at: [0, -3.3, 0], texture: HEX.od_green }, { type: 'cylinder', r: 3.05, h: 3.6, segments: 12, at: [0, -1.8, 0], texture: HEX.od_green }, { type: 'cylinder', r: 1.3, h: 1.8, segments: 8, at: [0, 3.2, 0], texture: HEX.gunmetal }, { ...box([1.8, 2.3, 0], [0.5, 4.6, 1.4], 'gunmetal', { rotate: [0, 0, -12], pivot: [0, 4.6, 0] }), name: 'spoon' }, { ...cyl(-1.6, 4.2, 0.2, -0.2, 1.1, 'steel', { rotate: [0, 0, 90], segments: 8 }), name: 'pin' }], sockets: { grip: { at: [0, 0, 0] }, pin: { part: 'pin', at: [-2.4, 4.2, 0] } } }),
  medpen: () => ({ parts: [cyl(0, 0, 6, -6, 1.1, 'hazard', { segments: 10 }), cyl(0, 0, -6, -8, 0.8, 'polymer', { segments: 8 }), cyl(0, 0, 8, 6, 1.0, 'cross_red', { segments: 8 }), box([1.0, -0.3, 0], [0.2, 0.6, 7], 'polymer')], sockets: { grip: { at: [0, 0, 0] }, tip: { at: [0, 0, -8] } } }),
  bandage: () => ({ parts: [{ type: 'cylinder', r: 3.2, h: 5.2, segments: 14, at: [0, -2.6, 0], rotate: [0, 0, 90], pivot: [0, 2.6, 0], texture: HEX.cloth_white }, box([0, 0.2, 2.6], [5, 0.4, 6], 'cloth_white')], sockets: { grip: { at: [0, 0, 0] } } }),
  trauma_kit: () => ({ parts: [box([0, 0, 0], [13, 8, 9], 'od_green', { bevel: 1 }), box([0, 0.2, -4.6], [4.2, 1.2, 0.3], 'cross_red'), box([0, 0.2, -4.6], [1.2, 4.2, 0.3], 'cross_red'), box([0, 4.4, 0], [11, 0.8, 1.2], 'rubber')], sockets: { grip: { at: [0, -1, 4.5] } } }),
  tablet: () => ({ parts: [box([0, 0, 0], [22, 1.6, 15], 'rubber', { bevel: 0.8 }), { ...box([0, 0.85, 0], [18.4, 0.2, 11.6], 'screen'), name: 'screen' }, box([-11.4, 0, 0], [1.4, 2.2, 13], 'polymer_od', { bevel: 0.4 }), box([11.4, 0, 0], [1.4, 2.2, 13], 'polymer_od', { bevel: 0.4 })], sockets: { grip: { at: [-11, 0, 0] }, grip_r: { at: [11, 0, 0] }, screen: { part: 'screen', at: [0, 1, 0] } } }),
};
export function itemModel(id) {
  KIT_BUILDS.item++;
  const mk = ITEMS[id];
  if (!mk) throw new Error(`unknown item "${id}" (${Object.keys(ITEMS).join(', ')})`);
  const m = mk();
  return { name: id, parts: m.parts, scale: 100, grid: 1, origin: 'auto', sockets: m.sockets, fp: { kind: 'item' }, notes: `fp kit item "${id}" (cm, grip = the hand's palm anchor).` };
}

/** Every kit definition: {guns, mags, attachments, items} (names). */
export function kitDefs() {
  return {
    guns: GUN_CLASSES.map((c) => gunModel(c)),
    mags: MAGS.map(magModel),
    attachments: Object.keys(ATTACH).map(attachModel),
    items: Object.keys(ITEMS).map(itemModel),
  };
}
