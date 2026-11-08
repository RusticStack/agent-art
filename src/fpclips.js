// First-person clip library: one set of clips per handling class, authored as keys on the gun
// (eye-space stations + offsets) and on each hand (a gun anchor with a grasp, an item, or a free
// eye-space pose), with finger presets, magazine / item states, moving-part states and events.
// Additive layers (breathing, walk bob, recoil kick + recovery) stack on the base keys, so walk,
// ADS and fire share one solve. solveClip turns a clip into per-frame sockets exactly as the fp v2
// contract writes them, with the hands locked onto the anchors of the gun cells the runtime draws.
import { FRAME, CENTRE, add, sub, mul, mv, ypr, slerpR, lerp3, project, unproject, apparent, cellIndex, anchorOf, placeAnchor, r1, clamp, len, norm, frameOf, col, mm, tr, fromCols } from './fp.js';
import { GRASP, fpGeometry, GUN_CLASSES } from './fpkit.js';
import { FINGERS, blendFingers, handFrame, solveArm } from './fparms.js';

const smooth = (u) => u * u * (3 - 2 * u);
const KIND = (cls) => (cls === 'pistol' ? 'pistol' : GUN_CLASSES.includes(cls) ? 'long' : 'item');
const TAU = Math.PI * 2;

// ---------- stations: where the gun's grip sits, and how it is turned (eye space, cm / deg) ----------
/** Station table per kind; 'ads' is solved from the gun's iron sight (sight on the optical axis). */
export const STATIONS = {
  long: {
    hip: { P: [12, -15, -32], r: [14, 4, -12] },
    sprint: { P: [15, -21, -27], r: [34, -20, -38] },
    low: { P: [11, -22, -30], r: [24, -16, -18] },
    reload: { P: [5, -12, -29], r: [30, 18, -50] },
    inspect_l: { P: [3, -14, -33], r: [44, 6, -16] },
    inspect_r: { P: [-1, -12, -32], r: [-28, 8, 12] },
    melee: { P: [4, -12, -40], r: [18, 4, -55] },
    under: { P: [16, -46, -24], r: [40, -40, -30] },
  },
  pistol: {
    hip: { P: [8, -11, -27], r: [10, 4, -6] },
    sprint: { P: [12, -22, -24], r: [30, -35, -20] },
    low: { P: [8, -21, -28], r: [10, -22, -8] },
    reload: { P: [4, -9, -25], r: [26, 16, -40] },
    inspect_l: { P: [2, -12, -27], r: [44, 8, -12] },
    inspect_r: { P: [6, -11, -27], r: [-24, 6, 50] },
    melee: { P: [5, -9, -34], r: [10, -10, -70] },
    under: { P: [14, -44, -22], r: [20, -45, -10] },
  },
};
/** ADS station: sight on the axis at depth ads_depth (the frame centre), barrel level. */
export function adsStation(geo, depth = 34) {
  const R = ypr(0, 0, 0);
  return { P: sub([0, 0, -depth], mv(R, geo.sight)), r: [0, 0, 0] };
}
function station(cls, name) {
  const geo = fpGeometry(cls);
  if (name === 'ads') return adsStation(geo);
  const S = STATIONS[KIND(cls)][name];
  if (!S) throw new Error(`no station "${name}"`);
  // long guns whose support grip sits further out than the rifle's come back toward the body, so
  // the support arm still reaches (sniper, lmg, launcher)
  if (KIND(cls) === 'long') {
    const extra = -geo.support[2] - -fpGeometry('rifle').support[2];
    if (extra > 0) return { ...S, P: [S.P[0], S.P[1], S.P[2] + extra * 0.7] };
  }
  return S;
}

// ---------- item grasps (item space: the item's grip anchor is the origin) ----------
export const ITEM_GRASP = {
  // hammer grip: the handle runs through the fist from the pinky to the thumb side, the blade leaves on the thumb side
  knife: { fingers: [0, -1, 0], dorsal: [1, 0, 0], palm: [1.7, 1.0, 0.6], preset: 'knife_hammer' },
  frag: { fingers: [0.1, 0.4, -1], dorsal: [0.4, -0.2, 0.9], palm: [0.3, -0.5, 3.2], preset: 'grenade_hold' },
  medpen: { fingers: [1, 0, 0.2], dorsal: [0, 1, 0], palm: [0, 1.6, 0], preset: 'fist' },
  bandage: { fingers: [0, -0.3, -1], dorsal: [0, 1, 0], palm: [0, 3.6, 0.5], preset: 'grenade_hold' },
  trauma_kit: { fingers: [0, 0.2, -1], dorsal: [0, 0.3, 1], palm: [0, 0, 1.8], preset: 'support_under' },
  tablet: { fingers: [1, 0.1, -0.2], dorsal: [0, -1, 0], palm: [-0.6, -1.9, 0], preset: 'support_under' },
};

// ---------- clip authoring helpers ----------
/** Gun key: station name, offsets [dx, dy, dz] cm, [dyaw, dpitch, droll] deg. */
const G = (st, d = [0, 0, 0], r = [0, 0, 0], extra = {}) => ({ st, d, r, ...extra });
const HID = { hidden: true };
const grip = (fingers) => ({ at: 'grip', grasp: 'grip', ...(fingers ? { fingers } : {}) });
const sup = (fingers) => ({ at: 'support', grasp: 'support', ...(fingers ? { fingers } : {}) });
const anc = (at, grasp, extra = {}) => ({ at, grasp: grasp ?? at, ...extra });
/** Free hand: palm centre (eye), fingers direction, back-of-hand direction, preset. */
const free = (P, fingers, dorsal, preset = 'relaxed', extra = {}) => ({ free: P, fwd: fingers, dorsal, fingers: preset, ...extra });
const LOW_L = free([-16, -46, -26], [0.3, 0.6, -0.7], [-0.9, 0, 0.3], 'relaxed');
const LOW_R = free([18, -48, -24], [-0.2, 0.6, -0.7], [0.9, 0, 0.3], 'relaxed');
const POUCH = free([-12, -46, -22], [0.2, -0.3, -0.9], [-1, 0, 0.2], 'mag_grasp');

/** Clips for a gun class. Frames f are integers; keys interpolate (smoothstep) between them. */
function gunClips(cls) {
  const kind = KIND(cls), pistol = kind === 'pistol';
  const S = pistol ? (fingers) => anc('support', 'support_pistol', fingers ? { fingers } : {}) : cls === 'shotgun' ? (fingers) => anc('pump', 'pump', fingers ? { fingers } : {}) : cls === 'launcher' ? sup : sup;
  const R0 = grip(), L0 = S();
  const base = (st = 'hip') => ({ gun: G(st), R: R0, L: L0, mag: 'in' });
  const bolt = cls === 'sniper', pump = cls === 'shotgun', lmg = cls === 'lmg', launcher = cls === 'launcher';
  const charge = pistol ? 'charging' : bolt ? 'bolt_handle' : 'charging';
  const lockState = pistol ? 'slide_locked' : bolt || pump || launcher ? null : 'bolt_back';
  const pullState = pistol ? 'slide_locked' : bolt ? 'bolt_back' : pump ? 'pump_back' : 'charging_back';
  const C = {};
  C.idle = { frames: 16, fps: 8, loop: true, keys: [{ f: 0, ...base() }], layers: ['breathe'] };
  C.walk = { frames: 12, fps: 12, loop: true, keys: [{ f: 0, ...base() }], layers: ['walk'] };
  C.sprint = { frames: 12, fps: 12, loop: true, keys: [{ f: 0, ...base('sprint'), R: grip('trigger_off') }], layers: ['sprint'] };
  // fire: recoil kick + recovery; pump / bolt guns cycle the action
  if (pump) C.fire = { frames: 14, fps: 18, loop: false, keys: [{ f: 0, ...base(), e: 'shot' }, { f: 5, ...base(), L: S() }, { f: 8, ...base(), L: S(), state: 'pump_back', e: 'pump' }, { f: 11, ...base(), L: S() }, { f: 13, ...base() }], layers: ['recoil'] };
  else if (bolt) C.fire = { frames: 22, fps: 16, loop: false, keys: [{ f: 0, ...base(), e: 'shot' }, { f: 5, ...base() }, { f: 8, ...base(), gun: G('hip', [0, 0, 0], [0, 0, -8]), R: anc('bolt_handle', 'bolt_handle') }, { f: 10, ...base(), gun: G('hip', [0, 0, 0], [0, 0, -8]), R: anc('bolt_handle', 'bolt_handle'), state: 'bolt_up', e: 'bolt_up' }, { f: 13, ...base(), gun: G('hip', [0, 0, 0], [0, 0, -8]), R: anc('bolt_handle', 'bolt_handle'), state: 'bolt_back', e: 'bolt_back' }, { f: 16, ...base(), gun: G('hip', [0, 0, 0], [0, 0, -8]), R: anc('bolt_handle', 'bolt_handle'), state: 'bolt_up', e: 'bolt_fwd' }, { f: 18, ...base(), R: anc('bolt_handle', 'bolt_handle') }, { f: 21, ...base() }], layers: ['recoil'] };
  else C.fire = { frames: 6, fps: 24, loop: false, keys: [{ f: 0, ...base(), e: 'shot', R: grip('trigger'), ...(pistol ? { state: 'slide_locked' } : {}) }, { f: 2, ...base(), ...(pistol ? { state: 'slide_locked' } : {}) }, { f: 5, ...base() }], layers: ['recoil'] };
  C.fire_ads = { ...C.fire, keys: C.fire.keys.map((k) => ({ ...k, gun: { ...k.gun, st: 'ads' } })), layers: ['recoil_ads'] };
  C.ads_in = { frames: 6, fps: 20, loop: false, keys: [{ f: 0, ...base() }, { f: 5, ...base('ads') }] };
  C.ads_idle = { frames: 8, fps: 8, loop: true, keys: [{ f: 0, ...base('ads') }], layers: ['breathe_ads'] };
  // reloads
  const cov = lmg ? { state: 'cover_open' } : {};
  const magOut = [
    { f: 0, ...base() },
    { f: 4, ...base('reload') },
    { f: 7, ...base('reload'), L: anc('mag_well', 'mag'), e: lmg ? 'cover_open' : 'mag_release', ...cov },
    { f: 8, ...base('reload'), L: anc('mag_well', 'mag'), mag: 'hand', e: 'mag_out', ...cov },
    { f: 10, ...base('reload'), L: anc('mag_well', 'mag', { off: [0, -12, 3] }), mag: 'hand', ...cov },
    { f: 13, ...base('reload'), L: POUCH, mag: 'hidden', ...cov },
    { f: 15, ...base('reload'), L: POUCH, mag: 'hand', ...cov },
    { f: 18, ...base('reload'), L: anc('mag_well', 'mag', { off: [0, -10, 2] }), mag: 'hand', ...cov },
    { f: 20, ...base('reload'), L: anc('mag_well', 'mag'), mag: 'hand', ...cov },
    { f: 21, ...base('reload'), L: anc('mag_well', 'mag'), mag: 'in', e: 'mag_in', ...cov },
  ];
  if (pistol) { // the empty mag drops free; the support hand only fetches the new one
    magOut[2] = { f: 7, ...base('reload'), L: free([-6, -26, -30], [0.3, 0.2, -1], [-1, 0, 0.2], 'relaxed'), e: 'mag_release' };
    magOut[3] = { f: 9, ...base('reload'), L: POUCH, mag: 'hidden', e: 'mag_out' };
    magOut.splice(4, 1);
  }
  if (pump || launcher) {
    // shotgun: shells one by one (start, shell loop, end); launcher: a rocket into the muzzle
    const shell = (f0) => [
      { f: f0, ...base('reload'), L: POUCH, mag: 'hand' },
      { f: f0 + 3, ...base('reload'), L: anc('mag_well', 'mag', { off: [0, -5, 0] }), mag: 'hand' },
      { f: f0 + 5, ...base('reload'), L: anc('mag_well', 'mag'), mag: 'hand', e: 'shell_in' },
      { f: f0 + 7, ...base('reload'), L: POUCH, mag: 'hidden' },
    ];
    if (launcher) {
      C.reload = { frames: 30, fps: 12, loop: false, keys: [{ f: 0, ...base(), mag: 'hidden' }, { f: 4, ...base('reload'), mag: 'hidden' }, { f: 8, ...base('reload'), L: POUCH, mag: 'hand' }, { f: 14, ...base('reload'), L: anc('mag_well', 'mag', { off: [0, -6, 8] }), mag: 'hand' }, { f: 19, ...base('reload'), L: anc('mag_well', 'mag'), mag: 'hand' }, { f: 20, ...base('reload'), L: anc('mag_well', 'mag'), mag: 'in', e: 'mag_in' }, { f: 23, ...base('reload'), mag: 'in' }, { f: 26, ...base(), mag: 'in' }, { f: 29, ...base() }] };
      C.reload_empty = C.reload;
    } else {
      C.reload_start = { frames: 8, fps: 12, loop: false, keys: [{ f: 0, ...base(), mag: 'hidden' }, { f: 7, ...base('reload'), L: POUCH, mag: 'hidden' }] };
      C.reload_shell = { frames: 8, fps: 12, loop: true, keys: shell(0).map((k) => ({ ...k })).concat([]) };
      C.reload_end = { frames: 8, fps: 12, loop: false, keys: [{ f: 0, ...base('reload'), L: POUCH, mag: 'hidden' }, { f: 7, ...base(), mag: 'hidden' }] };
      C.reload = { frames: 30, fps: 12, loop: false, keys: [{ f: 0, ...base(), mag: 'hidden' }, { f: 4, ...base('reload'), L: POUCH, mag: 'hidden' }, ...shell(5), ...shell(13), { f: 25, ...base('reload'), L: POUCH, mag: 'hidden' }, { f: 29, ...base(), mag: 'hidden' }] };
      C.reload_empty = { frames: 34, fps: 12, loop: false, keys: [{ f: 0, ...base(), mag: 'hidden' }, { f: 4, ...base('reload'), L: POUCH, mag: 'hidden' }, ...shell(5), ...shell(13), { f: 24, ...base(), L: S(), mag: 'hidden' }, { f: 27, ...base(), L: S(), mag: 'hidden', state: 'pump_back', e: 'pump' }, { f: 30, ...base(), mag: 'hidden' }, { f: 33, ...base(), mag: 'hidden' }] };
      for (const c of [C.reload, C.reload_empty, C.reload_start, C.reload_shell, C.reload_end]) c.mag = 'shell';
    }
  } else {
    const end = (f) => [{ f, ...base('reload'), mag: 'in' }, { f: f + 4, ...base() }];
    C.reload = { frames: 30, fps: 12, loop: false, keys: [...magOut, { f: 24, ...base('reload') }, { f: 29, ...base() }] };
    const rack = (f) => pistol
      ? [{ f, ...base('reload'), L: anc('charging', 'charging'), mag: 'in', state: lockState }, { f: f + 2, ...base('reload'), L: anc('charging', 'charging', { off: [0, 0, 3.4] }), mag: 'in', state: 'slide_locked', e: 'slide_release' }, { f: f + 4, ...base('reload'), mag: 'in' }]
      : bolt
        ? [{ f, ...base('reload'), R: anc('bolt_handle', 'bolt_handle'), mag: 'in' }, { f: f + 2, ...base('reload'), R: anc('bolt_handle', 'bolt_handle'), mag: 'in', state: 'bolt_back', e: 'bolt_back' }, { f: f + 4, ...base('reload'), R: anc('bolt_handle', 'bolt_handle'), mag: 'in', state: 'bolt_up', e: 'bolt_fwd' }, { f: f + 6, ...base('reload'), mag: 'in' }]
        : [{ f, ...base('reload'), L: anc('charging', 'charging'), mag: 'in', state: lockState }, { f: f + 3, ...base('reload'), L: anc('charging', 'charging', { off: [0, 0, 6] }), mag: 'in', state: pullState, e: 'charge' }, { f: f + 5, ...base('reload'), L: anc('charging', 'charging'), mag: 'in' }];
    const lock = (k) => (lockState && k.f < 21 ? { ...k, state: k.state ?? lockState } : k);
    const n = bolt ? 6 : 5;
    C.reload_empty = { frames: 36, fps: 12, loop: false, keys: [...magOut.map(lock), ...rack(23), ...end(23 + n + 1).map((k, i) => (i ? { ...k, f: 35 } : k))] };
    C.charge = { frames: 12, fps: 12, loop: false, keys: [{ f: 0, ...base() }, ...rack(3).map((k) => ({ ...k, state: k.state === lockState ? undefined : k.state })), { f: 11, ...base() }] };
  }
  // equip / handling
  C.draw = { frames: 8, fps: 14, loop: false, keys: [{ f: 0, ...base('under'), L: LOW_L }, { f: 4, ...base('low') }, { f: 7, ...base() }], ...(cls ? { events: [{ f: 1, e: 'draw' }] } : {}) };
  C.holster = { frames: 8, fps: 14, loop: false, keys: [{ f: 0, ...base() }, { f: 3, ...base('low') }, { f: 6, ...base('under'), L: LOW_L }, { f: 7, gun: HID, R: LOW_R, L: LOW_L, mag: 'in' }], events: [{ f: 6, e: 'holster' }] };
  C.inspect = { frames: 36, fps: 10, loop: false, keys: [{ f: 0, ...base() }, { f: 6, ...base('inspect_l') }, { f: 14, ...base('inspect_l'), gun: G('inspect_l', [0, 1, 0], [6, 3, 0]) }, { f: 22, ...base('inspect_r'), L: free([-3, -20, -30], [0.4, 0.3, -1], [-1, 0.1, 0.2], 'relaxed') }, { f: 29, ...base('inspect_r'), gun: G('inspect_r', [0, 1, 0], [-4, 2, 4]), L: free([-3, -20, -30], [0.4, 0.3, -1], [-1, 0.1, 0.2], 'relaxed') }, { f: 35, ...base() }] };
  C.jam_clear = { frames: 20, fps: 12, loop: false, keys: [{ f: 0, ...base() }, { f: 4, ...base('reload') }, { f: 6, ...base('reload'), L: anc('mag_well', 'mag', { off: [0, -3, 0] }), e: 'tap' }, { f: 7, ...base('reload'), L: anc('mag_well', 'mag') }, ...(pump || launcher ? [{ f: 10, ...base('reload') }, { f: 12, ...base('reload'), state: pump ? 'pump_back' : undefined, e: 'rack' }] : bolt ? [{ f: 10, ...base('reload'), R: anc('bolt_handle', 'bolt_handle'), state: 'bolt_back', e: 'rack' }, { f: 12, ...base('reload'), R: anc('bolt_handle', 'bolt_handle') }] : [{ f: 10, ...base('reload'), L: anc('charging', 'charging') }, { f: 12, ...base('reload'), L: anc('charging', 'charging', { off: [0, 0, pistol ? 3.4 : 6] }), state: pullState, e: 'rack' }, { f: 14, ...base('reload'), L: anc('charging', 'charging') }]), { f: 19, ...base() }] };
  C.firemode = { frames: 8, fps: 12, loop: false, keys: [{ f: 0, ...base() }, { f: 3, ...base('hip'), gun: G('hip', [0, 0, 0], [0, 0, -10]), R: grip('trigger_off'), e: 'firemode' }, { f: 7, ...base() }] };
  C.check_mag = pistol || pump || launcher
    ? { frames: 16, fps: 12, loop: false, keys: [{ f: 0, ...base() }, { f: 5, ...base('inspect_l') }, { f: 11, ...base('inspect_l'), gun: G('inspect_l', [0, 0, 0], [4, 6, -8]), e: 'check' }, { f: 15, ...base() }] }
    : { frames: 22, fps: 12, loop: false, keys: [{ f: 0, ...base() }, { f: 4, ...base('reload') }, { f: 6, ...base('reload'), L: anc('mag_well', 'mag') }, { f: 7, ...base('reload'), L: anc('mag_well', 'mag'), mag: 'hand', e: 'mag_out' }, { f: 9, ...base('reload'), L: anc('mag_well', 'mag', { off: [0, -5, 1] }), mag: 'hand' }, { f: 13, ...base('reload'), L: free([-6, -18, -30], [0.2, 0.2, -1], [-1, 0.3, 0.3], 'mag_grasp'), mag: 'hand', e: 'check' }, { f: 16, ...base('reload'), L: anc('mag_well', 'mag'), mag: 'hand' }, { f: 17, ...base('reload'), L: anc('mag_well', 'mag'), mag: 'in', e: 'mag_in' }, { f: 21, ...base() }] };
  C.melee = { frames: 10, fps: 16, loop: false, keys: [{ f: 0, ...base() }, { f: 3, ...base('hip'), gun: G('hip', [-2, 2, 6], [-10, 6, 20]) }, { f: 5, ...base('melee'), e: 'hit' }, { f: 9, ...base() }] };
  // one-handed grenade throw while holding the gun (the support hand leaves the gun)
  C.throw = { frames: 22, fps: 14, loop: false, keys: [
    { f: 0, ...base() }, { f: 3, ...base('low'), L: LOW_L },
    { f: 6, ...base('low'), L: free([-10, -16, -28], [0.1, 0.5, -0.9], [-0.9, -0.1, 0.4], 'grenade_hold'), item: { id: 'frag', hand: 'L' } },
    { f: 9, ...base('low'), L: free([-14, -2, -28], [0, 0.7, -0.7], [-1, 0, 0.2], 'grenade_hold'), item: { id: 'frag', hand: 'L' } },
    { f: 13, ...base('low'), L: free([-2, 2, -44], [0.1, 0.2, -1], [-0.6, 0.6, 0.2], 'open_palm'), item: { id: 'frag', hand: 'L', hidden: true }, e: 'throw' },
    { f: 17, ...base('low'), L: LOW_L }, { f: 21, ...base() }] };
  C.use_med = { frames: 22, fps: 12, loop: false, keys: [
    { f: 0, ...base() }, { f: 4, ...base('low'), L: LOW_L },
    { f: 7, ...base('low'), L: free([-9, -16, -28], [0.6, 0.4, -0.6], [0, 1, 0.2], 'fist'), item: { id: 'medpen', hand: 'L' } },
    { f: 11, ...base('low'), L: free([-14, -30, -18], [0.2, -0.9, -0.2], [-1, 0, 0], 'fist'), item: { id: 'medpen', hand: 'L' }, e: 'inject' },
    { f: 15, ...base('low'), L: LOW_L }, { f: 21, ...base() }] };
  C.interact = { frames: 12, fps: 12, loop: false, keys: [{ f: 0, ...base() }, { f: 3, ...base('low'), L: LOW_L }, { f: 6, ...base('low'), L: free([-6, -6, -40], [0.1, 0.4, -1], [-0.4, 0.1, 0.9], 'flat_touch'), e: 'use' }, { f: 8, ...base('low'), L: free([-6, -6, -36], [0.1, 0.4, -1], [-0.4, 0.1, 0.9], 'flat_touch') }, { f: 11, ...base() }] };
  if (C.reload_empty?.keys) C.reload_empty.keys.sort((a, b) => a.f - b.f);
  return C;
}

/** Right-hand pose holding a knife: blade direction + back-of-hand hint -> free hand spec. */
function bladeHand(P, blade, dorsalHint, preset = 'knife_hammer') {
  const sx = norm(mul(blade, -1)); // right hand: thumb (blade) side = -s
  const d = norm(sub(dorsalHint, mul(sx, dorsalHint[0] * sx[0] + dorsalHint[1] * sx[1] + dorsalHint[2] * sx[2])));
  const b = [sx[1] * d[2] - sx[2] * d[1], sx[2] * d[0] - sx[0] * d[2], sx[0] * d[1] - sx[1] * d[0]];
  return free(P, mul(b, -1), d, preset);
}
/** Clips for item / hand classes (no gun). */
function itemClips(cls) {
  const C = {};
  const idleR = { knife: bladeHand([13, -12, -30], [-0.45, 0.6, -0.65], [0.35, 0.25, 0.9]), grenade: free([12, -13, -30], [-0.2, 0.4, -0.9], [0.7, 0.4, 0.5], 'grenade_hold'), med: free([10, -18, -30], [-0.3, 0.3, -0.9], [0.4, 0.8, 0.3], 'fist'), tablet: free([11, -20, -30], [-1, 0.1, -0.2], [0, -1, 0], 'support_under'), unarmed: free([13, -20, -32], [-0.2, 0.3, -0.9], [0.6, 0.6, 0.4], 'relaxed') }[cls];
  const idleL = { knife: free([-12, -22, -32], [0.3, 0.4, -0.85], [-0.6, 0.4, 0.6], 'fist'), grenade: LOW_L, med: free([-10, -20, -30], [0.3, 0.3, -0.9], [-0.5, 0.8, 0.3], 'relaxed'), tablet: free([-11, -20, -30], [1, 0.1, -0.2], [0, -1, 0], 'support_under'), unarmed: free([-13, -20, -32], [0.2, 0.3, -0.9], [-0.6, 0.6, 0.4], 'relaxed') }[cls];
  const item = { knife: { id: 'knife', hand: 'R' }, grenade: { id: 'frag', hand: 'R' }, med: { id: 'trauma_kit', hand: 'L' }, tablet: { id: 'tablet', hand: 'L' }, unarmed: null }[cls];
  const base = { gun: HID, R: idleR, L: idleL, ...(item ? { item } : {}) };
  const mv2 = (h, d, extra = {}) => ({ ...h, free: add(h.free, d), ...extra });
  C.idle = { frames: 16, fps: 8, loop: true, keys: [{ f: 0, ...base }], layers: ['breathe'] };
  C.walk = { frames: 12, fps: 12, loop: true, keys: [{ f: 0, ...base }], layers: ['walk'] };
  C.sprint = { frames: 12, fps: 12, loop: true, keys: [{ f: 0, ...base, R: mv2(idleR, [2, -8, 4]), L: mv2(idleL, [-2, -8, 4]) }], layers: ['sprint_arms'] };
  C.draw = { frames: 8, fps: 14, loop: false, keys: [{ f: 0, ...base, R: mv2(idleR, [4, -26, 6]), L: mv2(idleL, [-4, -26, 6]) }, { f: 7, ...base }], events: [{ f: 1, e: 'draw' }] };
  C.holster = { frames: 8, fps: 14, loop: false, keys: [{ f: 0, ...base }, { f: 6, ...base, R: mv2(idleR, [4, -26, 6]), L: mv2(idleL, [-4, -26, 6]) }, { f: 7, ...base, R: mv2(idleR, [4, -30, 6]), L: mv2(idleL, [-4, -30, 6]), ...(item ? { item: { ...item, hidden: true } } : {}) }], events: [{ f: 6, e: 'holster' }] };
  C.interact = { frames: 12, fps: 12, loop: false, keys: [{ f: 0, ...base }, { f: 6, ...base, L: free([-6, -6, -40], [0.1, 0.4, -1], [-0.4, 0.1, 0.9], 'flat_touch'), e: 'use' }, { f: 11, ...base }] };
  if (cls === 'knife') {
    C.slash = { frames: 12, fps: 18, loop: false, keys: [{ f: 0, ...base }, { f: 3, ...base, R: bladeHand([18, -4, -30], [-0.25, 0.9, -0.35], [0.3, 0.1, 0.95]) }, { f: 6, ...base, R: bladeHand([-4, -14, -38], [-0.9, -0.3, -0.3], [0.1, 0.5, 0.85]), e: 'hit' }, { f: 8, ...base, R: bladeHand([-10, -20, -34], [-0.9, -0.4, -0.2], [0.1, 0.5, 0.85]) }, { f: 11, ...base }] };
    C.stab = { frames: 10, fps: 18, loop: false, keys: [{ f: 0, ...base }, { f: 3, ...base, R: bladeHand([14, -14, -22], [-0.15, 0.25, -1], [0.7, 0.5, 0.2]) }, { f: 5, ...base, R: bladeHand([5, -7, -46], [-0.1, 0.1, -1], [0.7, 0.5, 0.2]), e: 'hit' }, { f: 9, ...base }] };
    C.inspect = { frames: 24, fps: 10, loop: false, keys: [{ f: 0, ...base }, { f: 8, ...base, R: bladeHand([6, -8, -28], [-0.9, 0.3, -0.1], [0.1, 0.2, 1]) }, { f: 16, ...base, R: bladeHand([6, -8, -28], [-0.9, 0.3, -0.1], [0.1, 0.9, -0.4]) }, { f: 23, ...base }] };
  }
  if (cls === 'grenade') {
    const pin = free([4, -12, -28], [0.6, 0.2, -0.8], [0, 0.9, 0.4], 'pin_pull');
    C.cook = { frames: 16, fps: 12, loop: false, keys: [{ f: 0, ...base }, { f: 4, ...base, R: mv2(idleR, [-3, 3, 0]), L: pin }, { f: 7, ...base, R: mv2(idleR, [-3, 3, 0]), L: free([-8, -10, -26], [0.6, 0.2, -0.8], [0, 0.9, 0.4], 'pin_pull'), e: 'pin' }, { f: 10, ...base, e: 'spoon' }, { f: 15, ...base }] };
    C.throw = { frames: 16, fps: 14, loop: false, keys: [{ f: 0, ...base }, { f: 4, ...base, R: free([17, 2, -27], [0, 0.8, -0.6], [0.9, 0, 0.3], 'grenade_hold') }, { f: 8, ...base, R: free([4, 2, -46], [-0.1, 0.2, -1], [0.6, 0.6, 0.2], 'open_palm'), item: { ...item, hidden: true }, e: 'throw' }, { f: 12, ...base, R: free([8, -30, -36], [-0.1, -0.3, -1], [0.6, 0.6, 0.2], 'relaxed'), item: { ...item, hidden: true } }, { f: 15, ...base, R: mv2(idleR, [4, -26, 6]), item: { ...item, hidden: true } }] };
  }
  if (cls === 'med') {
    const kit = { id: 'trauma_kit', hand: 'L' };
    C.bandage = { frames: 24, fps: 10, loop: false, keys: [{ f: 0, ...base, item: { id: 'bandage', hand: 'R' } }, { f: 5, ...base, R: free([4, -22, -26], [-0.4, -0.4, -0.8], [0.6, 0.6, 0.3], 'grenade_hold'), item: { id: 'bandage', hand: 'R' } }, { f: 10, ...base, R: free([-8, -28, -24], [-0.4, -0.6, -0.6], [0.6, 0.6, 0.3], 'grenade_hold'), item: { id: 'bandage', hand: 'R' }, e: 'wrap' }, { f: 15, ...base, R: free([6, -26, -24], [-0.4, -0.4, -0.8], [0.6, 0.6, 0.3], 'grenade_hold'), item: { id: 'bandage', hand: 'R' }, e: 'wrap' }, { f: 23, ...base, item: { id: 'bandage', hand: 'R', hidden: true } }] };
    C.stim = { frames: 18, fps: 12, loop: false, keys: [{ f: 0, ...base, item: { id: 'medpen', hand: 'R' } }, { f: 6, ...base, R: free([4, -14, -26], [-0.6, 0.4, -0.6], [0.2, 0.9, 0.3], 'fist'), item: { id: 'medpen', hand: 'R' } }, { f: 10, ...base, R: free([0, -34, -18], [-0.2, -0.9, -0.2], [0.9, 0, 0.3], 'fist'), item: { id: 'medpen', hand: 'R' }, e: 'inject' }, { f: 17, ...base, item: { id: 'medpen', hand: 'R', hidden: true } }] };
    C.kit = { frames: 26, fps: 10, loop: false, keys: [{ f: 0, ...base, item: kit }, { f: 6, ...base, L: free([-6, -18, -30], [0.4, 0.2, -0.9], [-0.3, -0.9, 0.2], 'support_under'), item: kit }, { f: 10, ...base, L: free([-6, -18, -30], [0.4, 0.2, -0.9], [-0.3, -0.9, 0.2], 'support_under'), R: free([4, -12, -32], [-0.3, -0.6, -0.7], [0.3, 0.6, -0.6], 'pinch'), item: kit, e: 'open' }, { f: 18, ...base, L: free([-6, -18, -30], [0.4, 0.2, -0.9], [-0.3, -0.9, 0.2], 'support_under'), R: free([6, -24, -24], [-0.3, -0.6, -0.7], [0.3, 0.6, -0.6], 'pinch'), item: kit, e: 'apply' }, { f: 25, ...base, item: { ...kit, hidden: true } }] };
  }
  if (cls === 'tablet') {
    const up = { R: free([12, -10, -28], [-1, 0.1, -0.2], [0, -1, 0.3], 'support_under'), L: free([-12, -10, -28], [1, 0.1, -0.2], [0, -1, 0.3], 'support_under') };
    C.idle.keys[0] = { f: 0, ...base, item: { id: 'tablet', hand: 'L', hidden: true }, R: idleR, L: idleL };
    C.raise = { frames: 10, fps: 12, loop: false, keys: [{ f: 0, ...base, R: mv2(idleR, [0, -20, 4]), L: mv2(idleL, [0, -20, 4]) }, { f: 9, ...base, ...up }], events: [{ f: 8, e: 'screen_on' }] };
    C.use = { frames: 16, fps: 10, loop: true, keys: [{ f: 0, ...base, ...up }, { f: 5, ...base, ...up, R: free([6, -6, -27], [-0.6, -0.3, -0.7], [0.2, 0.7, 0.5], 'flat_touch'), e: 'tap' }, { f: 9, ...base, ...up }, { f: 12, ...base, ...up, R: free([10, -7, -27], [-0.6, -0.3, -0.7], [0.2, 0.7, 0.5], 'flat_touch'), e: 'tap' }] };
    C.draw = C.raise;
  }
  if (cls === 'unarmed') {
    C.melee = { frames: 10, fps: 16, loop: false, keys: [{ f: 0, ...base, R: mv2(idleR, [0, 2, 0], { fingers: 'fist' }) }, { f: 3, ...base, R: free([4, -8, -48], [0, 0.1, -1], [0.5, 0.7, 0.2], 'fist'), e: 'hit' }, { f: 6, ...base, R: mv2(idleR, [0, 2, 0], { fingers: 'fist' }) }, { f: 9, ...base }] };
    C.throw = { frames: 16, fps: 14, loop: false, keys: [{ f: 0, ...base, item: { id: 'frag', hand: 'R', hidden: true } }, { f: 3, ...base, R: idleR, item: { id: 'frag', hand: 'R' } }, { f: 7, ...base, R: free([17, 2, -27], [0, 0.8, -0.6], [0.9, 0, 0.3], 'grenade_hold'), item: { id: 'frag', hand: 'R' } }, { f: 10, ...base, R: free([4, 2, -46], [-0.1, 0.2, -1], [0.6, 0.6, 0.2], 'open_palm'), item: { id: 'frag', hand: 'R', hidden: true }, e: 'throw' }, { f: 15, ...base, item: { id: 'frag', hand: 'R', hidden: true } }] };
    C.use_med = { frames: 18, fps: 12, loop: false, keys: [{ f: 0, ...base, item: { id: 'medpen', hand: 'L', hidden: true } }, { f: 4, ...base, L: free([-9, -16, -28], [0.6, 0.4, -0.6], [0, 1, 0.2], 'fist'), item: { id: 'medpen', hand: 'L' } }, { f: 9, ...base, L: free([-14, -30, -18], [0.2, -0.9, -0.2], [-1, 0, 0], 'fist'), item: { id: 'medpen', hand: 'L' }, e: 'inject' }, { f: 17, ...base, item: { id: 'medpen', hand: 'L', hidden: true } }] };
  }
  return C;
}

/** The clip library of a class: {name: clip}. Variants @vgrip / @agrip for foregrip classes. */
export function classClips(cls) {
  const C = GUN_CLASSES.includes(cls) ? gunClips(cls) : itemClips(cls);
  for (const c of Object.values(C)) for (const k of c.keys) if (k.L?.at === 'support' && !k.L.variant) k.L = { ...k.L, variant: true };
  return C;
}
export const VARIANT_CLASSES = ['smg', 'rifle', 'dmr', 'lmg'];
export const VARIANTS = { vgrip: { attachment: 'vertical_grip', grasp: 'vgrip' }, agrip: { attachment: 'angled_grip', grasp: 'agrip' } };
/** Clips that get a foregrip variant (any key holds the support anchor). */
export const variantClips = (C) => Object.keys(C).filter((n) => C[n].keys.some((k) => k.L?.variant));

// ---------- additive layers ----------
const LAYERS = {
  breathe: (t) => ({ d: [0, 0.35 * Math.sin(TAU * t), 0.1 * Math.sin(TAU * t)], r: [0.4 * Math.sin(TAU * t), 0.5 * Math.sin(TAU * t + 1), 0] }),
  breathe_ads: (t) => ({ d: [0.05 * Math.sin(TAU * t), 0.1 * Math.sin(TAU * t), 0], r: [0, 0, 0] }),
  walk: (t) => ({ d: [1.2 * Math.sin(TAU * t), -1.1 * Math.abs(Math.cos(TAU * t)) + 0.5, 0], r: [-1.6 * Math.sin(TAU * t), 1.2 * Math.abs(Math.cos(TAU * t)), 2 * Math.sin(TAU * t)] }),
  sprint: (t) => ({ d: [2.2 * Math.sin(TAU * t), -2.4 * Math.abs(Math.cos(TAU * t)) + 1, 1.2 * Math.cos(TAU * t)], r: [-4 * Math.sin(TAU * t), 3 * Math.abs(Math.cos(TAU * t)), 5 * Math.sin(TAU * t)] }),
  sprint_arms: (t) => ({ d: [0, 0, 0], r: [0, 0, 0], hands: { R: [1.5 * Math.sin(TAU * t), -3 * Math.cos(TAU * t), 4 * Math.cos(TAU * t)], L: [1.5 * Math.sin(TAU * t), 3 * Math.cos(TAU * t), -4 * Math.cos(TAU * t)] } }),
  // recoil: a fast kick (back + muzzle up) then an exponential recovery
  recoil: (t, f) => { const k = f === 0 ? 0 : Math.exp(-(f - 1) * 0.9); return { d: [0.2 * k, 0.4 * k, 3.2 * k], r: [-0.8 * k, 7 * k, -1.5 * k] }; },
  recoil_ads: (t, f) => { const k = f === 0 ? 0 : Math.exp(-(f - 1) * 0.9); return { d: [0, 0.2 * k, 2.2 * k], r: [0, 3.5 * k, -0.6 * k] }; },
};
export const LAYER_NAMES = Object.keys(LAYERS);

// ---------- evaluation ----------
/** Key pair + eased weight at frame f. */
function keyAt(clip, f) {
  const ks = clip.keys;
  let i = ks.length - 1;
  while (i > 0 && ks[i].f > f) i--;
  const a = ks[i];
  let b = ks[i + 1];
  if (!b && clip.loop && ks.length > 1) b = { ...ks[0], f: clip.frames };
  if (!b) return { a, b: a, u: 0 };
  const u = smooth(clamp((f - a.f) / Math.max(1, b.f - a.f), 0, 1));
  return { a, b, u };
}
const stepPick = (a, b, u, k) => (u >= 1 - 1e-9 ? b[k] : a[k]);

/**
 * Solve a clip into per-frame data. ctx: {cls, gun (standard gun sweep {def}), gunRig (model rig
 * of the standard gun: sockets per state), att (vgrip / agrip sweep), magRig, variant}
 * -> frames: [{gun: socket, mag, item, events, hands: {R, L} solutions, props: [...] (for depth)}]
 */
export function solveClip(clip, ctx) {
  const out = [];
  const geo = ctx.cls && GUN_CLASSES.includes(ctx.cls) ? fpGeometry(ctx.cls) : null;
  for (let f = 0; f < clip.frames; f++) out.push(solveFrame(clip, f, ctx, geo));
  // events (keys' e plus clip events)
  const ev = [];
  for (const k of clip.keys) if (k.e) ev.push({ f: k.f, e: k.e });
  for (const e of clip.events || []) ev.push(e);
  ev.sort((x, y) => x.f - y.f);
  return { frames: out, events: ev };
}

/** Gun pose (eye space) of a key's gun spec. */
function gunPose(cls, g) {
  if (!g || g.hidden) return null;
  const S = station(cls, g.st || 'hip');
  const P = add(S.P, g.d || [0, 0, 0]);
  const r = add(S.r, g.r || [0, 0, 0]);
  return { P, R: ypr(r[0], r[1], r[2]) };
}

function solveFrame(clip, f, ctx, geo) {
  const { a, b, u } = keyAt(clip, f);
  const t = clip.frames ? f / clip.frames : 0;
  const cls = ctx.cls;
  // gun pose: blend keys, then additive layers (in the gun's eye space)
  let gun = null;
  const ga = gunPose(cls, a.gun), gb = gunPose(cls, b.gun);
  if (ga && gb) gun = { P: lerp3(ga.P, gb.P, u), R: slerpR(ga.R, gb.R, u) };
  else if (ga && u < 1) gun = ga;
  else if (gb && u >= 1) gun = gb;
  let handAdd = { R: [0, 0, 0], L: [0, 0, 0] };
  for (const L of clip.layers || []) {
    const v = LAYERS[L](t, f);
    if (v.hands) handAdd = { R: add(handAdd.R, v.hands.R), L: add(handAdd.L, v.hands.L) };
    if (gun) { gun.P = add(gun.P, v.d); gun.R = mm(ypr(v.r[0], v.r[1], v.r[2]), gun.R); }
    else { handAdd = { R: add(handAdd.R, v.d), L: add(handAdd.L, v.d) }; }
  }
  const state = stepPick(a, b, u, 'state') ?? null;
  const frame = { f, events: [], hands: {}, props: [] };
  // gun socket: apparent cell + grip position; ADS frames move the socket so the irons hit the centre
  let sock = null, comp = null;
  if (gun) {
    const ap = apparent(gun.P, gun.R);
    let [x, y, z] = project(gun.P);
    const def = ctx.gun.def;
    const idx = cellIndex(def, ap.yaw, ap.pitch);
    const gripA = anchorOf(def, 'grip', idx);
    const isAds = (a.gun?.st === 'ads' && b.gun?.st === 'ads');
    if (isAds) {
      const s = placeAnchor(def, idx, 'sight', gripA, x, y, ap.rot);
      if (s) { x += CENTRE[0] - s[0]; y += CENTRE[1] - s[1]; }
    }
    sock = { x: r1(x), y: r1(y), rot: r1(ap.rot), yaw: r1(ap.yaw), pitch: r1(ap.pitch), scale: 1, order: 'mid', ...(state ? { state } : {}) };
    // use the rounded socket values for everything below (what the engine reads)
    const idx2 = cellIndex(def, sock.yaw, sock.pitch);
    const g2 = anchorOf(def, 'grip', idx2);
    comp = { idx: idx2, grip: g2, at: (n) => placeAnchor(def, idx2, n, g2, sock.x, sock.y, sock.rot), shift: [sock.x - project(gun.P)[0], sock.y - project(gun.P)[1]] };
    frame.props.push({ kind: 'gun', idx: idx2, anchor: g2, x: sock.x, y: sock.y, rot: sock.rot, depth: z });
  }
  frame.gun = sock || { hidden: true };
  // gun-space sockets of the standard gun in the current state
  const sockets = gun ? socketsOf(ctx, state) : null;
  const restSockets = gun ? socketsOf(ctx, null) : null;
  const gunPt = (n, st = sockets) => (st[n] ? add(gun.P, mv(gun.R, st[n])) : null);
  // composite correction for an anchor: drawn position minus its 3D projection (rest pose)
  const corr = (n) => {
    if (!comp) return [0, 0];
    const drawn = comp.at(n === 'mag_well' || n === 'charging' || n === 'pump' || n === 'bolt_handle' || n === 'grip' || n === 'support' ? n : 'grip');
    const p3 = gunPt(n, restSockets);
    if (!drawn || !p3) return comp.shift;
    const pp = project(p3);
    return [drawn[0] - pp[0], drawn[1] - pp[1]];
  };
  // ---- hands ----
  const itemSpec = stepPick(a, b, u, 'item') ?? (u < 1 ? a.item : b.item);
  const magState = stepPick(a, b, u, 'mag') ?? 'in';
  const resolveHand = (side, h) => {
    if (!h) h = side === 'R' ? LOW_R : LOW_L;
    if (h.free) {
      const R = handFrame(h.fwd, h.dorsal);
      return { P: add(h.free, handAdd[side]), R, fingers: h.fingers || 'relaxed', free: true, c2: [0, 0], shift3: [0, 0, 0] };
    }
    if (!gun) return resolveHand(side, side === 'R' ? LOW_R : LOW_L);
    let anchor = h.at, graspName = h.grasp || h.at, att = null;
    if (h.variant && ctx.variant) { anchor = 'variant_support'; graspName = VARIANTS[ctx.variant].grasp; att = ctx.att; }
    const Gs = GRASP[graspName] || GRASP.grip;
    let A3, c2;
    if (anchor === 'variant_support') {
      // the foregrip's support point: gun underbarrel + the attachment's support (cell offsets drawn by the runtime)
      const ub = gunPt('underbarrel'), sup = att.sockets.support;
      A3 = add(ub, mv(gun.R, sup));
      const drawnUb = comp.at('underbarrel');
      const ai = cellIndex(att.sweep.def, sock.yaw, sock.pitch);
      const m = anchorOf(att.sweep.def, 'mount', ai), s = anchorOf(att.sweep.def, 'support', ai);
      const r = (sock.rot * Math.PI) / 180, dx = s[0] - m[0], dy = s[1] - m[1];
      const drawn = [drawnUb[0] + dx * Math.cos(r) - dy * Math.sin(r), drawnUb[1] + dx * Math.sin(r) + dy * Math.cos(r)];
      const pp = project(A3);
      c2 = [drawn[0] - pp[0], drawn[1] - pp[1]];
    } else {
      A3 = gunPt(anchor);
      if (!A3) return resolveHand(side, side === 'R' ? LOW_R : LOW_L);
      c2 = corr(anchor);
    }
    let palm = add(A3, mv(gun.R, Gs.palm));
    if (h.off) palm = add(palm, mv(gun.R, h.off));
    const pp = project(palm);
    const P2 = unproject(pp[0] + c2[0], pp[1] + c2[1], pp[2]);
    const R = handFrame(mv(gun.R, Gs.fingers), mv(gun.R, Gs.dorsal));
    return { P: P2, R, fingers: h.fingers || Gs.preset, target2: [pp[0] + c2[0], pp[1] + c2[1]], c2, shift3: sub(P2, palm) };
  };
  const hands = {};
  for (const side of ['R', 'L']) {
    const ha = resolveHand(side, a[side]), hb = resolveHand(side, b[side]);
    const P = lerp3(ha.P, hb.P, u), R = slerpR(ha.R, hb.R, u);
    const fingers = blendFingers(ha.fingers, hb.fingers, u);
    const target2 = u <= 0 ? ha.target2 : u >= 1 ? hb.target2 : null;
    const sol = solveArm(side === 'R' ? 'r' : 'l', P, R, fingers);
    // the anchor correction travels with the hand: 2D offset + the 3D shift that produced it
    const c2 = [ha.c2[0] + (hb.c2[0] - ha.c2[0]) * u, ha.c2[1] + (hb.c2[1] - ha.c2[1]) * u], shift3 = lerp3(ha.shift3, hb.shift3, u);
    // pose: the finger preset name in force (hand-drawn skins pick their hand drawing by it)
    hands[side] = { ...sol, target: P, target2, frame: R, c2, shift3, pose: u < 0.5 ? ha.fingers : hb.fingers };
  }
  frame.hands = hands;
  // ---- magazine ----
  if (gun && ctx.mag) {
    if (magState === 'hand') {
      const H = hands.L, Gm = GRASP.mag;
      // mag frame: the hand frame with the grasp undone; mount = palm - R_mag * palm offset
      const Fm = handFrame(Gm.fingers, Gm.dorsal);
      const Rm = mm(H.frame, tr(Fm));
      const ref = sub(H.palm, mv(Rm, Gm.palm));
      const ap = apparent(ref, Rm);
      // undo the 3D shift of the hand's anchor correction and apply it in pixels instead, so at the
      // well the magazine lands exactly on the drawn mag_well (no pop at the hand-off)
      const pu = project(sub(ref, H.shift3)), z = pu[2];
      const x = pu[0] + H.c2[0], y = pu[1] + H.c2[1];
      frame.mag = { state: 'hand', x: r1(x), y: r1(y), rot: r1(ap.rot), yaw: r1(ap.yaw), pitch: r1(ap.pitch) };
      frame.props.push({ kind: 'mag', ...frame.mag, depth: z });
    } else frame.mag = { state: magState === 'hidden' ? 'hidden' : 'in' };
    if (frame.mag.state === 'in') {
      const wellD = comp.at('mag_well');
      if (wellD) frame.props.push({ kind: 'mag_in', x: wellD[0], y: wellD[1], rot: sock.rot, yaw: sock.yaw, pitch: sock.pitch, depth: project(gunPt('mag_well', restSockets))[2] });
    }
  } else if (ctx.mag) frame.mag = { state: 'hidden' };
  if (gun && ctx.variant && ctx.att) {
    const ub = comp.at('underbarrel');
    if (ub) frame.props.push({ kind: 'att', x: ub[0], y: ub[1], rot: sock.rot, yaw: sock.yaw, pitch: sock.pitch, depth: project(gunPt('underbarrel'))[2] });
  }
  // ---- item ----
  if (itemSpec && itemSpec.id) {
    const H = hands[itemSpec.hand || 'R'], Gi = ITEM_GRASP[itemSpec.id] || ITEM_GRASP.knife;
    const Fi = handFrame(Gi.fingers, Gi.dorsal);
    const Ri = mm(H.frame, tr(Fi));
    const ref = sub(H.palm, mv(Ri, Gi.palm));
    const ap = apparent(ref, Ri);
    const [x, y, z] = project(ref);
    frame.item = { id: itemSpec.id, x: r1(x), y: r1(y), rot: r1(ap.rot), yaw: r1(ap.yaw), pitch: r1(ap.pitch), order: 'mid', ...(itemSpec.hidden ? { hidden: true } : {}) };
    if (!itemSpec.hidden) frame.props.push({ kind: 'item', id: itemSpec.id, ...frame.item, depth: z });
  }
  // events at this frame
  for (const k of clip.keys) if (k.f === f && k.e) frame.events.push(k.e);
  return frame;
}

/** Gun-space sockets of the standard gun in a state (cached per state on ctx). */
function socketsOf(ctx, state) {
  const key = state || '_rest';
  ctx._sockets = ctx._sockets || {};
  if (!ctx._sockets[key]) ctx._sockets[key] = ctx.gunSockets(state);
  return ctx._sockets[key];
}

/** The apparent angles a clip's gun takes (for sweep ranges): [{yaw, pitch, state}]. */
export function clipAngles(clip, cls) {
  const out = [];
  for (let f = 0; f < clip.frames; f++) {
    const { a, b, u } = keyAt(clip, f);
    const ga = gunPose(cls, a.gun), gb = gunPose(cls, b.gun);
    let gun = null;
    if (ga && gb) gun = { P: lerp3(ga.P, gb.P, u), R: slerpR(ga.R, gb.R, u) };
    else if (ga && u < 1) gun = ga; else if (gb && u >= 1) gun = gb;
    if (!gun) continue;
    const t = f / clip.frames;
    for (const L of clip.layers || []) { const v = LAYERS[L](t, f); gun.P = add(gun.P, v.d); gun.R = mm(ypr(v.r[0], v.r[1], v.r[2]), gun.R); }
    const ap = apparent(gun.P, gun.R);
    out.push({ yaw: ap.yaw, pitch: ap.pitch, state: stepPick(a, b, u, 'state') ?? null });
  }
  return out;
}
export { FINGERS, KIND, norm, col, fromCols, frameOf, FRAME };
