// Rig templates: starting points, not constraints. Each gives a part layout scaled to the frame,
// key poses and preset animations. rig_create merges the caller's parts/poses/presets/views over
// it, so any part can be resized, moved, re-pivoted, removed (null) or added (tail, cape, weapon).

const r = Math.round;

function humanoid([W, H]) {
  const headH = r(H * 0.32), bodyH = r(H * 0.27), legH = r(H * 0.26), armH = r(H * 0.27);
  const headW = r(W * 0.4), bodyW = Math.max(4, r(W * 0.32));
  const armW = Math.max(3, r(W * 0.12)), legW = Math.max(3, r(W * 0.14));
  const groundY = H - 2;
  const root = [r(W / 2), groundY - legH];
  const legX = Math.max(1, r(bodyW * 0.2));
  const shoulderY = -bodyH + 3;
  const sideArm = r(bodyW / 2 + armW / 2) - 1;
  const parts = {
    leg_b: { w: legW, h: legH + 1, pivot: [r(legW / 2), 0], parent: 'body', at: [-legX, 0], z: -2, views: { front: { at: [legX + 1, 0], z: 1 }, back: { at: [-legX - 1, 0], z: 1 } } },
    arm_b: { w: armW, h: armH, pivot: [r(armW / 2), 1], parent: 'body', at: [-1, shoulderY], z: -3, views: { front: { at: [sideArm, shoulderY], z: 2 }, back: { at: [-sideArm, shoulderY], z: 2 } } },
    body: { w: bodyW, h: bodyH, pivot: [r(bodyW / 2), bodyH - 1], z: 0 },
    leg_f: { w: legW, h: legH + 1, pivot: [r(legW / 2), 0], parent: 'body', at: [legX, 0], z: -1, views: { front: { at: [-legX - 1, 0], z: 1 }, back: { at: [legX + 1, 0], z: 1 } } },
    head: { w: headW, h: headH, pivot: [r(headW / 2), headH - 1], parent: 'body', at: [0, -bodyH + 1], z: 3, variants: ['blink'] },
    arm_f: { w: armW, h: armH, pivot: [r(armW / 2), 1], parent: 'body', at: [1, shoulderY], z: 4, views: { front: { at: [-sideArm, shoulderY], z: 2 }, back: { at: [sideArm, shoulderY], z: 2 } } },
  };
  const poses = {
    idle_down: { head: { y: 1 }, arm_f: { y: 1 }, arm_b: { y: 1 } },
    blink: { head: { variant: 'blink' } },
    walk_contact: { leg_f: { rot: -26 }, leg_b: { rot: 26 }, arm_f: { rot: 22 }, arm_b: { rot: -22 } },
    walk_pass: { leg_f: { rot: 4 }, leg_b: { rot: -8 }, arm_f: { rot: -4 }, arm_b: { rot: 4 }, head: { y: -1 } },
    run_contact: { body: { rot: 8 }, leg_f: { rot: -42 }, leg_b: { rot: 40 }, arm_f: { rot: 55 }, arm_b: { rot: -55 } },
    run_pass: { body: { rot: 8 }, leg_f: { rot: 10 }, leg_b: { rot: -30 }, arm_f: { rot: -10 }, arm_b: { rot: 10 } },
    attack_windup: { body: { rot: -6 }, arm_f: { rot: -150 }, head: { rot: -4 } },
    attack_strike: { body: { rot: 10 }, arm_f: { rot: 70 }, leg_f: { rot: -15 }, leg_b: { rot: 15 } },
    hurt: { body: { rot: -12 }, head: { rot: -12, variant: 'blink' }, arm_f: { rot: -35 }, arm_b: { rot: 35 } },
    jump_crouch: { body: { sy: 0.85 }, leg_f: { rot: -20 }, leg_b: { rot: 20 } },
    jump_air: { leg_f: { rot: 25 }, leg_b: { rot: -15 }, arm_f: { rot: -140 }, arm_b: { rot: -120 } },
    death: { body: { rot: -88 }, head: { variant: 'blink' }, arm_f: { rot: 30 }, arm_b: { rot: -20 } },
  };
  const presets = {
    idle: { keys: [{ parts: {} }, { pose: 'idle_down' }], frames: 4, fps: 4 },
    blink: { keys: [{ parts: {} }, { parts: {}, t: 0.8 }, { pose: 'blink', t: 0.85, ease: 'step' }, { parts: {}, t: 0.95, ease: 'step' }], frames: 10, fps: 8 },
    walk: { keys: [{ pose: 'walk_contact' }, { pose: 'walk_pass' }, { pose: 'walk_contact', mirror_pairs: true }, { pose: 'walk_pass', mirror_pairs: true }], frames: 8, fps: 10, plant_feet: true },
    run: { keys: [{ pose: 'run_contact' }, { pose: 'run_pass' }, { pose: 'run_contact', mirror_pairs: true }, { pose: 'run_pass', mirror_pairs: true }], frames: 8, fps: 14, plant_feet: true },
    attack: { keys: [{ parts: {} }, { pose: 'attack_windup', t: 0.35 }, { pose: 'attack_strike', t: 0.55, ease: 'linear' }, { parts: {}, t: 1 }], frames: 8, fps: 14, loop: false, plant_feet: true },
    hurt: { keys: [{ parts: {} }, { pose: 'hurt', t: 0.3 }, { parts: {}, t: 1 }], frames: 4, fps: 12, loop: false, plant_feet: true },
    jump: { keys: [{ pose: 'jump_crouch' }, { pose: 'jump_air', t: 0.4 }, { pose: 'jump_crouch', t: 1 }], frames: 6, fps: 10, loop: false },
    death: { keys: [{ parts: {} }, { pose: 'hurt', t: 0.25 }, { pose: 'death', t: 1 }], frames: 7, fps: 10, loop: false, plant_feet: true },
  };
  const guide = `humanoid: body = torso (hip pivot at its bottom), head (neck pivot at its bottom; draw the face looking RIGHT in "side"), arm_f/arm_b (shoulder pivot at the top; arm_b is the far arm: draw it darker), leg_f/leg_b (hip pivot at the top, feet at the bottom row). "head:blink" = same head with eyes closed. front/back views: draw the same parts seen from the front/back.`;
  return { frame: [W, H], views: ['side', 'front', 'back'], mirror: { side_left: 'side' }, root, parts, poses, presets, guide };
}

function blob([W, H]) {
  const bodyW = r(W * 0.72), bodyH = r(H * 0.58);
  const faceW = Math.max(4, r(W * 0.5)), faceH = Math.max(3, r(H * 0.26));
  const root = [r(W / 2), H - 2];
  const parts = {
    body: { w: bodyW, h: bodyH, pivot: [r(bodyW / 2), bodyH - 1] },
    face: { w: faceW, h: faceH, pivot: [r(faceW / 2), r(faceH / 2)], parent: 'body', at: [0, -r(bodyH * 0.5)], z: 1, variants: ['blink'], views: { side: { at: [r(bodyW * 0.2), -r(bodyH * 0.5)] }, back: { hidden: true } } },
  };
  const poses = {
    squash: { body: { sx: 1.14, sy: 0.84 }, face: { y: 1 } },
    stretch: { body: { sx: 0.88, sy: 1.14 }, face: { y: -1 } },
    air: { body: { y: -r(H * 0.18), sx: 0.92, sy: 1.08 } },
    blink: { face: { variant: 'blink' } },
    hurt: { body: { sx: 1.2, sy: 0.75 }, face: { variant: 'blink' } },
    death: { body: { sx: 1.4, sy: 0.35 }, face: { variant: 'blink' } },
  };
  const presets = {
    idle: { keys: [{ parts: {} }, { pose: 'squash' }], frames: 6, fps: 8 },
    hop: { keys: [{ pose: 'squash' }, { pose: 'stretch', t: 0.25 }, { pose: 'air', t: 0.5 }, { pose: 'stretch', t: 0.75 }], frames: 8, fps: 12 },
    blink: { keys: [{ parts: {} }, { parts: {}, t: 0.8 }, { pose: 'blink', t: 0.85, ease: 'step' }, { parts: {}, t: 0.95, ease: 'step' }], frames: 10, fps: 8 },
    hurt: { keys: [{ parts: {} }, { pose: 'hurt', t: 0.3 }, { parts: {}, t: 1 }], frames: 4, fps: 12, loop: false },
    death: { keys: [{ parts: {} }, { pose: 'hurt', t: 0.3 }, { pose: 'death', t: 1 }], frames: 6, fps: 10, loop: false },
  };
  const guide = 'blob: body = the whole blob (pivot at the bottom centre; scales for squash & stretch), face = eyes + mouth on a transparent background ("face:blink" = eyes closed). side view: face looks right; back view hides the face.';
  return { frame: [W, H], views: ['front', 'side', 'back'], mirror: { side_left: 'side' }, root, parts, poses, presets, guide };
}

function flyer([W, H]) {
  const bodyW = r(W * 0.4), bodyH = r(H * 0.4), wingW = r(W * 0.4), wingH = r(H * 0.32);
  const root = [r(W / 2), r(H * 0.62)];
  const parts = {
    wing_b: { w: wingW, h: wingH, pivot: [wingW - 2, wingH - 2], parent: 'body', at: [-1, -r(bodyH * 0.4)], z: -1, views: { front: { at: [-r(bodyW * 0.3), -r(bodyH * 0.4)] } } },
    body: { w: bodyW, h: bodyH, pivot: [r(bodyW / 2), r(bodyH / 2)] },
    wing_f: { w: wingW, h: wingH, pivot: [1, wingH - 2], parent: 'body', at: [1, -r(bodyH * 0.4)], z: 1, views: { front: { at: [r(bodyW * 0.3), -r(bodyH * 0.4)] } } },
  };
  const poses = {
    up: { wing_f: { rot: -50 }, wing_b: { rot: 50 }, body: { y: 1 } },
    down: { wing_f: { rot: 45, sy: 0.85 }, wing_b: { rot: -45, sy: 0.85 }, body: { y: -1 } },
    hurt: { body: { rot: -15 }, wing_f: { rot: 50 }, wing_b: { rot: -50 } },
    death: { body: { rot: 120, y: r(H * 0.25) }, wing_f: { rot: 70 }, wing_b: { rot: -70 } },
  };
  const presets = {
    fly: { keys: [{ pose: 'up' }, { pose: 'down' }], frames: 6, fps: 12 },
    hurt: { keys: [{ parts: {} }, { pose: 'hurt', t: 0.3 }, { parts: {}, t: 1 }], frames: 4, fps: 12, loop: false },
    death: { keys: [{ parts: {} }, { pose: 'hurt', t: 0.25 }, { pose: 'death', t: 1 }], frames: 6, fps: 10, loop: false },
  };
  const guide = 'flyer: body (centre pivot), wing_f / wing_b (pivot where the wing joins the body; wing_b is the far wing, draw it darker). Works for bats, birds, eyeballs with wings, insects.';
  return { frame: [W, H], views: ['side', 'front'], mirror: { side_left: 'side' }, root, parts, poses, presets, guide };
}

// humanoid_hd: a high-detail humanoid for 64x96 .. 160x240 frames (late-90s pre-rendered /
// "Replaced"-style sprites): 3-piece spine, neck, two-bone arms and legs with hands and feet,
// gear slots, a cape with secondary motion, 5 drawn views + 3 mirrors (8 directions), IK aim /
// reload, foot planting and RotSprite sampling. Poses are authored for the side view; the other
// views get projected overrides (limbs swinging toward/away from the camera foreshorten through
// sy with scale_children, so knees lift in front/back walks instead of splaying sideways).
const HD_VIEWS = ['side', 'front_side', 'front', 'back_side', 'back'];
const YAW = { side: 0, front_side: 45, front: 90, back_side: 45, back: 90 };
const D2R = Math.PI / 180;
const FORE = new Set(['pelvis', 'torso', 'chest', 'neck', 'head', 'upper_arm_f', 'forearm_f', 'hand_f', 'upper_arm_b', 'forearm_b', 'hand_b', 'thigh_f', 'shin_f', 'thigh_b', 'shin_b']);
const r1 = (v) => Math.round(v * 1000) / 1000;

/** Project a side-view pose into a view rotated by its yaw: screen rotation + foreshortening. */
export function projectPose(parts, pose, view) {
  const cp = Math.cos(YAW[view] * D2R);
  const wa = {};
  const world = (n) => wa[n] ?? (wa[n] = Number(pose[n]?.rot ?? 0) + (parts[n].parent ? world(parts[n].parent) : 0));
  const scr = (th) => Math.atan2(Math.sin(th * D2R) * cp, Math.cos(th * D2R)) / D2R;
  const len = (th) => Math.hypot(Math.sin(th * D2R) * cp, Math.cos(th * D2R));
  const out = {};
  for (const n of Object.keys(parts)) {
    const v = pose[n] || {}, th = world(n), o = {};
    const rot = scr(th) - (parts[n].parent ? scr(world(parts[n].parent)) : 0);
    if (v.rot || Math.abs(rot) > 1e-6) o.rot = r1(rot);
    if (FORE.has(n) && Math.abs(len(th) - 1) > 1e-3) o.sy = r1(Math.max(0.25, Number(v.sy ?? 1) * len(th)));
    if (v.x) o.x = r1(v.x * cp);
    if (Object.keys(o).length) out[n] = o;
  }
  return out;
}

// weapon cell sizes per class (body units at the 98-unit figure height) and attachment cells
const WEAPON_CELL = { pistol: [14, 9], revolver: [15, 9], handgun: [14, 9], smg: [26, 10], dmr: [42, 11], sniper: [46, 11], lmg: [42, 13] };
const ATT_CELL = { vertical_grip: [5, 8, 'top'], angled_grip: [8, 6, 'top'], bipod: [5, 10, 'top'], suppressor: [11, 4, 'left'], optic: [10, 5, 'bottom'], light: [7, 4, 'top'] };
const LONG_MAP = {
  run_contact: 'sprint', run_down: 'sprint', run_pass: 'sprint', aim: 'aim', recoil: 'aim', reload_low: 'reload', reload_hip: 'reload', reload_insert: 'reload', reload_slap: 'reload',
  reload_grab: 'reload', reload_strip: 'reload', reload_pouch: 'reload', reload_seat: 'reload', reload_in: 'reload', reload_charge: 'reload_charge', reload_pull: 'reload_charge',
  throw_windup: 'slung', throw_release: 'slung', throw_follow: 'slung', death_buckle: 'ready_low', death_kneel: 'drop', death_ground: 'drop',
};
const pistolKind = (w) => w.kind === 'pistol' || ['pistol', 'handgun', 'revolver'].includes(w.class);
const PISTOL_MAP = { ...LONG_MAP, death_buckle: 'low', run_contact: 'low', run_down: 'low', run_pass: 'low', throw_windup: 'holster', throw_release: 'holster', throw_follow: 'holster' };
/** humanoid_hd weapon handling defaults: carry states per template pose, attachment cells. */
export function hdWeaponConfig(weapon) {
  if (weapon !== true && (!weapon || typeof weapon !== 'object' || Array.isArray(weapon))) throw new Error(`rig "weapon" must be true or {class?, points?, attachments?, carry?, ...} (e.g. weapon:{class:"pistol"}), not ${JSON.stringify(weapon)}`);
  const cfg = weapon === true ? {} : { ...weapon };
  const cls = cfg.class ?? (cfg.kind === 'pistol' ? 'pistol' : 'rifle');
  const pistol = cfg.kind === 'pistol' || ['pistol', 'handgun', 'revolver'].includes(cls);
  const attachments = {};
  for (const [n, a] of Object.entries(cfg.attachments || {})) attachments[n] = typeof a === 'string' ? { type: a } : { ...a };
  return { ...cfg, class: cls, attachments, poses: { ...(pistol ? PISTOL_MAP : LONG_MAP), ...(cfg.poses || {}) } };
}

function humanoidHD([W, H], opts = {}) {
  if (W < 32 || H < 48) throw new Error('humanoid_hd needs frames of at least 32x48 (64x96 .. 160x240 recommended); use template "humanoid" for small sprites');
  const wcfg = opts.weapon ? hdWeaponConfig(opts.weapon) : null;
  const u = (H - 4) / 98, uw = Math.min(u, W / 66);
  const L = (v) => Math.max(1, r(v * u)), Wd = (v) => Math.max(2, r(v * uw)), U = (v) => r1(v * u);
  const limb = (len, w, k, ext) => ({ w, h: len + k + ext, pivot: [Math.floor(w / 2), k] });
  const thighL = L(23), shinL = L(22), upperL = L(16), foreL = L(14), torsoL = L(11), chestNeck = L(15), shoulderY = L(13), neckL = L(4);
  const groundY = H - 3;
  const foot = { w: Wd(13), h: L(6) };
  const footPy = L(1);
  const root = [r(W / 2), groundY - thighL - shinL - (foot.h - 1 - footPy)];
  // per-view settings in HD_VIEWS order: side, front_side, front, back_side, back
  const pv = (at, z, extra = {}) => Object.fromEntries(HD_VIEWS.map((v, i) => [v, { ...(at ? { at: at[i] } : {}), z: z[i], ...(extra[v] || {}) }]));
  const ats = (xs, y) => xs.map((x) => [U(x), y]);
  const centred = (w, h, py) => ({ w, h, pivot: [Math.floor(w / 2), py] });
  const ua = limb(upperL, Wd(6.5), L(2), L(2)), fa = limb(foreL, Wd(5.5), L(1.5), L(1)), th = limb(thighL, Wd(9), L(3), L(2)), sh = limb(shinL, Wd(8), L(2), L(1));
  const hand = centred(Wd(5.5), L(8), L(1));
  const footViews = { side: { pivot: [Wd(4), footPy] }, front_side: { pivot: [Wd(5.5), footPy] }, front: { pivot: [Math.floor(foot.w / 2), footPy] }, back_side: { pivot: [Wd(5.5), footPy] }, back: { pivot: [Math.floor(foot.w / 2), footPy] } };
  const bottom = (w, h, up) => ({ w, h, pivot: [Math.floor(w / 2), h - 1 - up] });
  const parts = {
    cape: { ...centred(Wd(22), L(38), L(1)), parent: 'chest', views: pv(ats([-6, -4, 0, -4, 0], -L(14)), [-10, -10, -10, 4.5, 4]) },
    gear_back: { ...centred(Wd(13), L(17), L(2)), parent: 'chest', views: pv(ats([-9, -6, 0, -6, 0], -L(14)), [-4, -9, -9, 4, 3]) },
    upper_arm_b: { ...ua, parent: 'chest', views: pv(ats([-1, 5, 9, -5, -9], -shoulderY), [-8, -6, 4, -6, 5]) },
    forearm_b: { ...fa, parent: 'upper_arm_b', at: [0, upperL], views: pv(null, [-7, -5.5, 4.5, -5.5, 5.5]) },
    hand_b: { ...hand, parent: 'forearm_b', at: [0, foreL], views: pv(null, [-6, -5, 5.5, -5, 6]) },
    thigh_b: { ...th, parent: 'pelvis', views: pv(ats([-1, 2, 4, -2, -4], 0), [-5, -3, 0.4, -3, 0.4]) },
    shin_b: { ...sh, parent: 'thigh_b', at: [0, thighL], views: pv(null, [-5, -3, 0.4, -3, 0.4]) },
    foot_b: { ...foot, pivot: [Wd(4), footPy], parent: 'shin_b', at: [0, shinL], views: pv(null, [-5, -3, 0.4, -3, 0.4], footViews) },
    pelvis: { ...centred(Wd(19), L(11), L(4)), z: 0 },
    thigh_f: { ...th, parent: 'pelvis', views: pv(ats([1, -3, -4, 3, 4], 0), [1, 0.5, 0.5, 0.5, 0.5]) },
    shin_f: { ...sh, parent: 'thigh_f', at: [0, thighL], views: pv(null, [1, 0.5, 0.5, 0.5, 0.5]) },
    foot_f: { ...foot, pivot: [Wd(4), footPy], parent: 'shin_f', at: [0, shinL], views: pv(null, [1, 0.5, 0.5, 0.5, 0.5], footViews) },
    torso: { ...bottom(Wd(17), L(14), L(2)), parent: 'pelvis', at: [0, -L(3)], views: pv(null, [2, 1, 1, 1, 1]) },
    gear_hip: { ...centred(Wd(7), L(9), L(1)), parent: 'pelvis', views: pv(ats([-2, -6, -7, 3.5, 7], -L(1)), [4, 4, 3, 1.5, 2.5]) },
    chest: { ...bottom(Wd(24), L(18), L(2)), parent: 'torso', at: [0, -torsoL], views: pv(null, [3, 2, 2, 2, 2]) },
    neck: { ...bottom(Wd(6), L(7), L(1)), parent: 'chest', at: [0, -chestNeck], views: pv(null, [4, 4, 4, 4, 4]) },
    head: { ...bottom(Wd(14), L(15), L(1)), parent: 'neck', at: [0, -neckL], variants: ['blink'], views: pv(null, [5, 5, 5, 6, 6]) },
    upper_arm_f: { ...ua, parent: 'chest', views: pv(ats([1, -6, -9, 6, 9], -shoulderY), [6, 6, 4, 7, 5]) },
    forearm_f: { ...fa, parent: 'upper_arm_f', at: [0, upperL], views: pv(null, [7, 7, 4.5, 7.5, 5.5]) },
    weapon: { w: Wd(32), h: L(10), pivot: [Wd(9), L(4)], parent: 'hand_f', at: [0, L(3.5)], views: pv(null, [7.5, 7.5, 6, -2, -2]) },
    hand_f: { ...hand, parent: 'forearm_f', at: [0, foreL], views: pv(null, [8, 8, 5.5, 8, 6]) },
  };
  if (wcfg) {
    // weapon handling: a cell sized for the class, plus one cell per attachment (pivot = its mount point)
    const [cw, ch] = WEAPON_CELL[wcfg.class] || [32, 10];
    parts.weapon = { ...parts.weapon, w: Wd(cw), h: L(ch), pivot: [Wd(cw * 0.3), L(ch * 0.5)] };
    for (const [n, a] of Object.entries(wcfg.attachments)) {
      const [aw, ah, mount] = ATT_CELL[a.type] || [6, 6, 'top'];
      const w = Wd(aw), h = L(ah);
      const pivot = mount === 'top' ? [Math.floor(w / 2), 0] : mount === 'bottom' ? [Math.floor(w / 2), h - 1] : [0, Math.floor(h / 2)];
      parts[a.part ?? `att_${n}`] = { w, h, pivot, parent: 'weapon', views: pv(null, [7.6, 7.6, 6.1, -1.9, -1.9]) };
    }
    // magazine: rides in the mag well; mag_hand draws the same cell (art:"mag", side drawing in
    // every view) in the support hand while the reload carries it
    const [mw, mh] = pistolKind(wcfg) ? [3, 6] : [5, 9];
    parts.mag = { w: Wd(mw), h: L(mh), pivot: [Math.floor(Wd(mw) / 2), 0], parent: 'weapon', views: pv(null, [7.45, 7.45, 5.95, -2.05, -2.05]) };
    parts.mag_hand = { art: 'mag', pivot: [Math.floor(Wd(mw) / 2), Math.floor(L(mh) / 2)], parent: 'hand_b', at: [0, L(5)], hide: true, link: Object.fromEntries(HD_VIEWS.slice(1).map((v) => [v, 'side'])), views: pv(null, [-6.05, -5.05, 5.45, -5.05, 5.95]) };
  }
  // side-view pose authoring: x/y in body units (scaled to the frame), rot in degrees
  const S = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, { ...v, ...(v.x !== undefined ? { x: U(v.x) } : {}), ...(v.y !== undefined ? { y: U(v.y) } : {}) }]));
  const NOGUN = { weapon: { hide: true } };
  // gun hold per view: hand_f wrist relative to the chest pivot (fwd/up in side units) and weapon roll
  const gunAt = (v, fwd, up) => ({ side: [fwd, up], front_side: [-4.5 + 0.707 * (fwd - 1), up], front: [-6, up], back_side: [4.5 + 0.707 * (fwd - 1), up], back: [6, up] })[v];
  const rollIn = (v, rot) => r1(rot * ({ side: 1, front_side: 0.7, back_side: 0.7, front: 0, back: 0 })[v]);
  const offAt = (v, [ax, ay]) => (YAW[v] === 0 ? [U(ax), U(ay)] : YAW[v] === 45 ? [U(ax * 0.7), U(ay)] : [U(ax * 0.1), U(ay + 1)]);
  // elbows flare outward: the near arm is screen-left in front, screen-right in back
  const bendF = (v) => (v === 'front' ? -1 : v === 'back' ? 1 : -1), bendB = (v) => (v === 'front' ? 1 : -1);
  /** IK for a two-handed weapon: main hand at the chest-relative grip, off hand on the weapon or another part. */
  const gunIK = ({ fwd, up, rot = 0, off = [14, -2], offPart, wpt }) => (v) => {
    // weapon handling: the solver locks the trigger hand (and the support hand when the state
    // holds it); a free support hand reaches for a weapon point ({weapon:"mag"}) or a pouch
    if (wcfg) {
      if (offPart) return { hand_b: { target: { part: offPart, at: [U(off[0]), U(off[1])] }, bend: bendB(v) } };
      return wpt ? { hand_b: { target: { weapon: wpt[0], at: [0, U(wpt[1])] }, bend: bendB(v) } } : null;
    }
    const [gx, gy] = gunAt(v, fwd, up);
    return {
      hand_f: { target: { part: 'chest', at: [U(gx), U(gy)] }, bend: bendF(v), rot: rollIn(v, rot) },
      hand_b: offPart ? { target: { part: offPart, at: [U(off[0]), U(off[1])] }, bend: bendB(v) } : { target: { part: 'weapon', at: offAt(v, off) }, bend: bendB(v) },
    };
  };
  /** Side pose + projected overrides for the other views (+ per-view IK); fix = hand-set {view: {part: fields}} over the projection. */
  const pose = (side, ik, fix = {}) => {
    const p = S(side);
    if (ik) { const x = ik('side'); if (x) p.ik = x; }
    const views = {};
    for (const v of HD_VIEWS.slice(1)) {
      const o = projectPose(parts, p, v);
      for (const [k, f] of Object.entries(S(fix[v] || {}))) o[k] = { ...(o[k] || {}), ...f };
      if (ik) { const x = ik(v); if (x) o.ik = x; }
      if (Object.keys(o).length) views[v] = o;
    }
    if (Object.keys(views).length) p.views = views;
    return p;
  };
  const stance = { thigh_f: { rot: -4 }, shin_f: { rot: 3 }, foot_f: { rot: 1 }, thigh_b: { rot: 5 }, shin_b: { rot: 2 }, foot_b: { rot: -7 } };
  const relaxed = { upper_arm_f: { rot: 3 }, forearm_f: { rot: -8 }, hand_f: { rot: -4 }, upper_arm_b: { rot: -3 }, forearm_b: { rot: -10 }, hand_b: { rot: -4 } };
  const aimLegs = { pelvis: { x: -2, y: 0.8 }, torso: { rot: 5 }, chest: { rot: -3 }, neck: { rot: 3 }, head: { rot: 5 }, thigh_f: { rot: -12 }, shin_f: { rot: 8 }, foot_f: { rot: 4 }, thigh_b: { rot: 14 }, shin_b: { rot: 6 }, foot_b: { rot: -20 } };
  const crouch = { torso: { rot: 22 }, chest: { rot: 6 }, head: { rot: -22 }, upper_arm_f: { rot: -25 }, forearm_f: { rot: -55 }, upper_arm_b: { rot: -35 }, forearm_b: { rot: -50 }, ...NOGUN };
  // front/back: a spine folded past 90 degrees would project upside down; collapse toward the camera instead
  const fold = (spine, legs, arms) => {
    const f = { pelvis: { rot: 0, sy: spine[0] }, torso: { rot: 0, sy: spine[1] }, chest: { rot: 0, sy: spine[2] }, neck: { rot: 0, sy: spine[3] }, head: { rot: 0, sy: spine[4] }, cape: { rot: 0 } };
    for (const s of ['f', 'b']) Object.assign(f, { ['thigh_' + s]: { rot: 0, sy: legs[0] }, ['shin_' + s]: { rot: 0, sy: legs[1] }, ['foot_' + s]: { rot: 0 } });
    const front = { ...f, upper_arm_f: { rot: -arms, sy: 0.9 }, forearm_f: { rot: -arms / 2 }, upper_arm_b: { rot: arms, sy: 0.9 }, forearm_b: { rot: arms / 2 } };
    const back = { ...f, upper_arm_f: { rot: arms, sy: 0.9 }, forearm_f: { rot: arms / 2 }, upper_arm_b: { rot: -arms, sy: 0.9 }, forearm_b: { rot: -arms / 2 } };
    // the near (_f) arm is screen-left in front and screen-right in back
    return { front: back, back: front };
  };
  const poses = {
    idle_exhale: pose({ ...stance, ...relaxed, pelvis: { y: 0.3 }, chest: { rot: -1 }, head: { rot: 1 }, ...NOGUN }),
    idle_inhale: pose({ ...stance, ...relaxed, upper_arm_f: { rot: 2 }, upper_arm_b: { rot: -2 }, torso: { sy: 1.01 }, chest: { rot: -2, sy: 1.04 }, ...NOGUN }),
    blink: pose({ ...stance, ...relaxed, pelvis: { y: 0.3 }, chest: { rot: -1 }, head: { rot: 1, variant: 'blink' }, ...NOGUN }),
    walk_contact: pose({ pelvis: { y: 3.2 }, torso: { rot: 2 }, chest: { rot: -1 }, head: { rot: -1 }, thigh_f: { rot: -25 }, shin_f: { rot: 5 }, foot_f: { rot: -10 }, thigh_b: { rot: 20 }, shin_b: { rot: 10 }, foot_b: { rot: 15 }, upper_arm_f: { rot: 18 }, forearm_f: { rot: -8 }, upper_arm_b: { rot: -18 }, forearm_b: { rot: -22 }, ...NOGUN }),
    walk_down: pose({ pelvis: { y: 3.6 }, torso: { rot: 2 }, head: { rot: -1 }, thigh_f: { rot: -18 }, shin_f: { rot: 18 }, foot_f: { rot: 0 }, thigh_b: { rot: 14 }, shin_b: { rot: 38 }, foot_b: { rot: 0 }, upper_arm_f: { rot: 12 }, forearm_f: { rot: -10 }, upper_arm_b: { rot: -12 }, forearm_b: { rot: -20 }, ...NOGUN }),
    walk_pass: pose({ pelvis: { y: 0.2 }, torso: { rot: 2 }, head: { rot: -1 }, thigh_f: { rot: -2 }, shin_f: { rot: 6 }, foot_f: { rot: -4 }, thigh_b: { rot: -16 }, shin_b: { rot: 58 }, foot_b: { rot: -10 }, upper_arm_f: { rot: 0 }, forearm_f: { rot: -10 }, upper_arm_b: { rot: 0 }, forearm_b: { rot: -12 }, ...NOGUN }),
    walk_up: pose({ pelvis: { y: 1.2 }, torso: { rot: 2 }, head: { rot: -1 }, thigh_f: { rot: 12 }, shin_f: { rot: 6 }, foot_f: { rot: 6 }, thigh_b: { rot: -30 }, shin_b: { rot: 22 }, foot_b: { rot: -12 }, upper_arm_f: { rot: -12 }, forearm_f: { rot: -16 }, upper_arm_b: { rot: 12 }, forearm_b: { rot: -8 }, ...NOGUN }),
    run_contact: pose({ pelvis: { y: 0.5 }, torso: { rot: 10 }, chest: { rot: -2 }, head: { rot: -6 }, thigh_f: { rot: -32 }, shin_f: { rot: 14 }, foot_f: { rot: -6 }, thigh_b: { rot: 26 }, shin_b: { rot: 34 }, foot_b: { rot: 10 }, upper_arm_f: { rot: 40 }, forearm_f: { rot: -75 }, upper_arm_b: { rot: -50 }, forearm_b: { rot: -80 }, ...NOGUN }),
    run_down: pose({ pelvis: { y: 2 }, torso: { rot: 12 }, chest: { rot: -2 }, head: { rot: -8 }, thigh_f: { rot: -14 }, shin_f: { rot: 30 }, foot_f: { rot: -16 }, thigh_b: { rot: 10 }, shin_b: { rot: 85 }, foot_b: { rot: -15 }, upper_arm_f: { rot: 22 }, forearm_f: { rot: -80 }, upper_arm_b: { rot: -30 }, forearm_b: { rot: -85 }, ...NOGUN }),
    run_pass: pose({ pelvis: { y: -2.5 }, torso: { rot: 10 }, chest: { rot: -2 }, head: { rot: -6 }, thigh_f: { rot: 24 }, shin_f: { rot: 30 }, foot_f: { rot: 10 }, thigh_b: { rot: -50 }, shin_b: { rot: 100 }, foot_b: { rot: -20 }, upper_arm_f: { rot: -35 }, forearm_f: { rot: -85 }, upper_arm_b: { rot: 35 }, forearm_b: { rot: -70 }, ...NOGUN }),
    crouch_contact: pose({ ...crouch, pelvis: { y: 11 }, thigh_f: { rot: -60 }, shin_f: { rot: 62 }, foot_f: { rot: -10 }, thigh_b: { rot: -5 }, shin_b: { rot: 70 }, foot_b: { rot: -35 } }),
    crouch_down: pose({ ...crouch, pelvis: { y: 12 }, thigh_f: { rot: -52 }, shin_f: { rot: 66 }, foot_f: { rot: -14 }, thigh_b: { rot: -20 }, shin_b: { rot: 95 }, foot_b: { rot: -45 } }),
    crouch_pass: pose({ ...crouch, pelvis: { y: 11 }, thigh_f: { rot: -45 }, shin_f: { rot: 70 }, foot_f: { rot: -25 }, thigh_b: { rot: -62 }, shin_b: { rot: 110 }, foot_b: { rot: -28 } }),
    crouch_up: pose({ ...crouch, pelvis: { y: 10 }, thigh_f: { rot: -30 }, shin_f: { rot: 62 }, foot_f: { rot: -12 }, thigh_b: { rot: -75 }, shin_b: { rot: 85 }, foot_b: { rot: -15 } }),
    aim: pose({ ...aimLegs }, gunIK({ fwd: 10, up: -11 })),
    recoil: pose({ ...aimLegs, pelvis: { x: -2.4, y: 0.8 }, chest: { rot: -7 }, head: { rot: 3 } }, gunIK({ fwd: 8.5, up: -11.8, rot: -10 })),
    reload_low: pose({ ...aimLegs, head: { rot: 14 } }, gunIK({ fwd: 9, up: -7, rot: 25, off: [10, -1], wpt: ['mag', 2] })),
    reload_hip: pose({ ...aimLegs, head: { rot: 18 } }, gunIK({ fwd: 9, up: -7, rot: 25, off: [0, 3], offPart: 'gear_hip' })),
    reload_insert: pose({ ...aimLegs, head: { rot: 16 } }, gunIK({ fwd: 9, up: -7.5, rot: 22, off: [6, 3], wpt: ['mag', 6] })),
    reload_slap: pose({ ...aimLegs, head: { rot: 12 } }, gunIK({ fwd: 9.5, up: -8.5, rot: 18, off: [6, 1.5], wpt: ['mag', 3] })),
    hurt_hit: pose({ pelvis: { x: -2.5, y: 1 }, torso: { rot: -10 }, chest: { rot: -8 }, neck: { rot: -6 }, head: { rot: -14, variant: 'blink' }, upper_arm_f: { rot: -30 }, forearm_f: { rot: -40 }, upper_arm_b: { rot: -36 }, forearm_b: { rot: -48 }, thigh_f: { rot: -14 }, shin_f: { rot: 18 }, foot_f: { rot: -4 }, thigh_b: { rot: 10 }, shin_b: { rot: 16 }, foot_b: { rot: -26 }, ...NOGUN }),
    hurt_recover: pose({ ...stance, pelvis: { x: -1, y: 0.8 }, torso: { rot: -4 }, chest: { rot: -3 }, head: { rot: -5 }, upper_arm_f: { rot: -12 }, forearm_f: { rot: -20 }, upper_arm_b: { rot: -14 }, forearm_b: { rot: -24 }, ...NOGUN }),
    death_buckle: pose({ pelvis: { x: -1, y: 8 }, torso: { rot: 10 }, chest: { rot: 10 }, head: { rot: 20, variant: 'blink' }, thigh_f: { rot: -40 }, shin_f: { rot: 70 }, foot_f: { rot: -30 }, thigh_b: { rot: -10 }, shin_b: { rot: 60 }, foot_b: { rot: -30 }, upper_arm_f: { rot: -20 }, forearm_f: { rot: -10 }, upper_arm_b: { rot: -24 }, forearm_b: { rot: -12 }, ...NOGUN }),
    death_kneel: pose({ pelvis: { x: -4, y: 23, rot: 10 }, torso: { rot: 25 }, chest: { rot: 15 }, head: { rot: 25, variant: 'blink' }, thigh_f: { rot: -15 }, shin_f: { rot: 95 }, foot_f: { rot: 0 }, thigh_b: { rot: -5 }, shin_b: { rot: 92 }, foot_b: { rot: 0 }, upper_arm_f: { rot: -40 }, forearm_f: { rot: -10 }, upper_arm_b: { rot: -44 }, forearm_b: { rot: -12 }, ...NOGUN }, null, fold([1, 0.9, 0.9, 1, 0.95], [0.35, 0.15], 8)),
    death_ground: pose({ pelvis: { x: -14, y: 40, rot: 60 }, torso: { rot: 32 }, chest: { rot: 4 }, neck: { rot: 4 }, head: { rot: 20, variant: 'blink' }, thigh_f: { rot: -134 }, shin_f: { rot: 172 }, foot_f: { rot: 82 }, thigh_b: { rot: -130 }, shin_b: { rot: 168 }, foot_b: { rot: 86 }, upper_arm_f: { rot: -76 }, forearm_f: { rot: -30 }, upper_arm_b: { rot: -70 }, forearm_b: { rot: -26 }, ...NOGUN }, null, fold([0.5, 0.35, 0.3, 0.3, 0.6], [0.3, 0.15], 25)),
    throw_windup: pose({ pelvis: { x: -2, y: 0.6 }, torso: { rot: -6 }, chest: { rot: -10 }, head: { rot: 4 }, upper_arm_f: { rot: 140 }, forearm_f: { rot: -70 }, hand_f: { rot: -10 }, upper_arm_b: { rot: -80 }, forearm_b: { rot: -20 }, thigh_f: { rot: 15 }, shin_f: { rot: 10 }, foot_f: { rot: -25 }, thigh_b: { rot: -25 }, shin_b: { rot: 10 }, foot_b: { rot: 15 }, ...NOGUN }),
    throw_release: pose({ pelvis: { x: 2, y: 3 }, torso: { rot: 14 }, chest: { rot: 10 }, head: { rot: -4 }, upper_arm_f: { rot: -110 }, forearm_f: { rot: -15 }, hand_f: { rot: -20 }, upper_arm_b: { rot: 20 }, forearm_b: { rot: -40 }, thigh_f: { rot: 22 }, shin_f: { rot: 25 }, foot_f: { rot: -5 }, thigh_b: { rot: -28 }, shin_b: { rot: 22 }, foot_b: { rot: 6 }, ...NOGUN }),
    throw_follow: pose({ pelvis: { x: 2.5, y: 3 }, torso: { rot: 20 }, chest: { rot: 14 }, head: { rot: -6 }, upper_arm_f: { rot: -40 }, forearm_f: { rot: -20 }, upper_arm_b: { rot: 30 }, forearm_b: { rot: -60 }, thigh_f: { rot: 22 }, shin_f: { rot: 25 }, foot_f: { rot: -5 }, thigh_b: { rot: -28 }, shin_b: { rot: 22 }, foot_b: { rot: 6 }, ...NOGUN }),
  };
  if (wcfg) {
    // weapon reload, readable in every view: grab the mag -> strip it (mag in the hand) -> chest
    // pouch -> new mag to the well -> seat it -> charging handle -> back to aim (events in the preset)
    const handTo = (pt, dy, dx = 0) => (v) => ({ hand_b: { target: { weapon: pt, at: [U(dx), U(dy)] }, bend: bendB(v) } });
    const pouchAt = { side: [10, -9], front_side: [5, -9], front: [3, -9], back_side: [-3, -9], back: [-3, -9] };
    const pouch = (v) => ({ hand_b: { target: { part: 'chest', at: [U(pouchAt[v][0]), U(pouchAt[v][1])] }, bend: bendB(v) } });
    const IN_HAND = { mag: { hide: true }, mag_hand: { hide: false } };
    Object.assign(poses, {
      reload_grab: pose({ ...aimLegs, head: { rot: 16 } }, handTo('mag', 1)),
      reload_strip: pose({ ...aimLegs, head: { rot: 18 }, ...IN_HAND }, handTo('mag', 13)),
      reload_pouch: pose({ ...aimLegs, chest: { rot: -2 }, head: { rot: 10 }, ...IN_HAND }, pouch),
      reload_seat: pose({ ...aimLegs, head: { rot: 16 }, ...IN_HAND }, handTo('mag', 7)),
      reload_in: pose({ ...aimLegs, head: { rot: 14 } }, handTo('mag', 1)),
      reload_charge: pose({ ...aimLegs, head: { rot: 8 } }, handTo('charge', 0)),
      reload_pull: pose({ ...aimLegs, head: { rot: 8 } }, handTo('charge', 0, -6)),
    });
  }
  const cycle = (names, tStep) => [...names.map((p, i) => ({ pose: p, t: r1(i * tStep) })), ...names.map((p, i) => ({ pose: p, t: r1(0.5 + i * tStep), mirror_pairs: true }))];
  const presets = {
    idle: { keys: [{ pose: 'idle_exhale' }, { pose: 'idle_inhale', t: 0.45 }, { pose: 'idle_exhale', t: 0.85 }], frames: 12, fps: 8, plant: true, secondary: true },
    blink: { keys: [{ pose: 'idle_exhale' }, { pose: 'idle_exhale', t: 0.8 }, { pose: 'blink', t: 0.85, ease: 'step' }, { pose: 'idle_exhale', t: 0.95, ease: 'step' }], frames: 10, fps: 10, plant: true },
    walk: { keys: cycle(['walk_contact', 'walk_down', 'walk_pass', 'walk_up'], 0.125), frames: 16, fps: 16, plant: true, secondary: true },
    run: { keys: cycle(['run_contact', 'run_down', 'run_pass'], 1 / 6), frames: 12, fps: 16, plant: true, secondary: true },
    crouch_walk: { keys: cycle(['crouch_contact', 'crouch_down', 'crouch_pass', 'crouch_up'], 0.125), frames: 16, fps: 12, plant: true, secondary: true },
    aim: { keys: [{ pose: 'aim' }], frames: 1, fps: 10, loop: false, plant: true },
    shoot: { keys: [{ pose: 'aim' }, { pose: 'recoil', t: 1 / 6, ease: 'linear' }, { pose: 'aim', t: 0.67 }], frames: 6, fps: 20, plant: true, secondary: true },
    reload: { keys: [{ pose: 'aim' }, { pose: 'reload_low', t: 0.15 }, { pose: 'reload_hip', t: 0.38 }, { pose: 'reload_hip', t: 0.5 }, { pose: 'reload_insert', t: 0.68 }, { pose: 'reload_slap', t: 0.78, ease: 'linear' }, { pose: 'aim', t: 1 }], frames: 24, fps: 16, loop: false, plant: true, secondary: true },
    hurt: { keys: [{ pose: 'idle_exhale' }, { pose: 'hurt_hit', t: 0.2, ease: 'linear' }, { pose: 'hurt_recover', t: 0.55 }, { pose: 'idle_exhale', t: 1 }], frames: 8, fps: 16, loop: false, plant: true, secondary: true },
    death: { keys: [{ pose: 'idle_exhale' }, { pose: 'hurt_hit', t: 0.12, ease: 'linear' }, { pose: 'death_buckle', t: 0.35 }, { pose: 'death_kneel', t: 0.55 }, { pose: 'death_ground', t: 1 }], frames: 20, fps: 16, loop: false, secondary: true },
    throw: { keys: [{ pose: 'idle_exhale' }, { pose: 'throw_windup', t: 0.35 }, { pose: 'throw_release', t: 0.55, ease: 'linear' }, { pose: 'throw_follow', t: 0.75 }, { pose: 'idle_exhale', t: 1 }], frames: 12, fps: 16, loop: false, plant: true, secondary: true },
  };
  if (wcfg) presets.reload = {
    keys: [{ pose: 'aim' }, { pose: 'reload_grab', t: 0.12 }, { pose: 'reload_strip', t: 0.22 }, { pose: 'reload_pouch', t: 0.38 }, { pose: 'reload_pouch', t: 0.46 }, { pose: 'reload_seat', t: 0.6 }, { pose: 'reload_in', t: 0.68 }, { pose: 'reload_charge', t: 0.78 }, { pose: 'reload_pull', t: 0.85, ease: 'linear' }, { pose: 'reload_charge', t: 0.9, ease: 'linear' }, { pose: 'aim', t: 1 }],
    frames: 24, fps: 16, loop: false, plant: true, secondary: true,
    // the mag leaves the gun where the strip key takes over (tween midpoint) and is seated where reload_in does
    events: [{ t: 0.17, name: 'mag_out' }, { t: 0.42, name: 'mag_pouch' }, { t: 0.64, name: 'mag_in' }, { t: 0.85, name: 'charge' }, { t: 1, name: 'ready' }],
  };
  const guide = 'humanoid_hd: side = facing RIGHT; *_f = the near side in that view (draw *_b darker). Spine: pelvis (root, hip-joint pivot), torso (abdomen) and chest (pivots near their bottom), neck, head (neck pivot at the bottom; "head:blink" = eyes closed). Limbs: upper_arm/forearm/hand and thigh/shin/foot, pivots at the top joint (shoulder, elbow, wrist, hip, knee, ankle); foot pivot = ankle, toes point right in "side". Limb cells overlap their joints a few px so bent elbows and knees stay closed. Optional slots (leave empty or remove with null): weapon (in hand_f, drawn pointing right with the grip on the pivot; shown in aim/shoot/reload), gear_back, gear_hip (swings), cape (secondary motion). Views: side, front_side (3/4 toward camera), front, back_side (3/4 away), back; side_left/front_side_left/back_side_left are mirrors (8 directions).';
  return {
    frame: [W, H], views: HD_VIEWS, mirror: { side_left: 'side', front_side_left: 'front_side', back_side_left: 'back_side' }, root, parts, poses, presets,
    guide: wcfg ? `${guide} WEAPON HANDLING (weapon:{class:"${wcfg.class}"}): draw the weapon only in the "side" row, pointing RIGHT (the other views project that cell); stock at the left edge, pistol grip about 30% in, handguard / muzzle to the right. Attachment cells (att_<name>) mount on the weapon's sockets; draw them in the side row too. The solver places the weapon per carry state and locks the hands on the grips in every pose, so the weapon stays visible in every preset (holster / slung are explicit states). Check with art_rig check.` : guide,
    ...(wcfg ? { weapon: wcfg } : {}),
    sampling: 'rotsprite', scale_children: true, secondary: { cape: { stiffness: 0.25, damping: 0.22, gravity: 0.3 }, gear_hip: { stiffness: 0.6, damping: 0.35 } },
  };
}

export const RIG_TEMPLATES = { humanoid, humanoid_hd: humanoidHD, blob, flyer };
/** Frame used to describe each template (art_rig templates). */
export const TEMPLATE_FRAME = { humanoid: [32, 32], humanoid_hd: [64, 96], blob: [32, 32], flyer: [32, 32] };

export function rigTemplate(name, frame, opts) {
  const t = RIG_TEMPLATES[name];
  if (!t) throw new Error(`Unknown rig template "${name}" (templates: ${Object.keys(RIG_TEMPLATES).join(', ')})`);
  if (!Array.isArray(frame) || frame.length !== 2) throw new Error('template rigs need "frame": [width, height] (e.g. [32, 32])');
  if (Math.min(...frame) < 12) throw new Error('template rigs need frames of at least 12x12 px');
  return t(frame.map(Number), opts);
}

/** Merge caller overrides over a template: parts/poses/presets merge per key (null removes). */
export function mergeTemplate(t, a) {
  const merge = (base, over, deep) => {
    const out = { ...base };
    for (const [k, v] of Object.entries(over || {})) {
      if (v === null) delete out[k];
      else out[k] = deep && base[k] && typeof v === 'object' ? { ...base[k], ...v, views: v.views !== undefined ? { ...(base[k].views || {}), ...v.views } : base[k].views } : v;
    }
    return out;
  };
  const parts = merge(t.parts, a.parts, true);
  // a part that draws a removed part's cell (mag_hand without mag) goes with it
  for (const [k, p] of Object.entries(parts)) if (p.art && !parts[p.art]) delete parts[k];
  for (const p of Object.values(parts)) if (p.parent && !parts[p.parent]) { p.at = p.at || [0, 0]; delete p.parent; }
  const views = a.views || t.views;
  for (const p of Object.values(parts)) if (p.views) p.views = Object.fromEntries(Object.entries(p.views).filter(([v]) => views.includes(v)));
  // drop pose entries for removed parts, views and variants (a pose naming a variant the caller
  // took away, e.g. hurt -> head:blink, must not break the rig) and IK chains that lost a part
  const chain = (n) => parts[n] && parts[n].parent && parts[parts[n].parent]?.parent;
  const tpart = (tg) => !tg || Array.isArray(tg) || (tg.mix ? tpart(tg.mix[0]) && tpart(tg.mix[1]) : !tg.part || !!parts[tg.part]);
  const keepParts = (o) => {
    const out = {};
    for (const [k, v] of Object.entries(o || {})) {
      if (k === 'views' || k === 'ik' || !parts[k] || !v) continue;
      const variants = parts[k].variants || [];
      out[k] = v.variant && v.variant !== 'base' && !variants.includes(v.variant) ? Object.fromEntries(Object.entries(v).filter(([f]) => f !== 'variant')) : v;
    }
    if (o?.ik) {
      const ik = Object.fromEntries(Object.entries(o.ik).filter(([e, s]) => chain(e) && s && tpart(s.target)));
      if (Object.keys(ik).length) out.ik = ik;
    }
    return out;
  };
  const keep = (pose) => {
    const out = keepParts(pose);
    if (pose.views) {
      const vs = Object.fromEntries(Object.entries(pose.views).filter(([v]) => views.includes(v)).map(([v, o]) => [v, keepParts(o)]));
      if (Object.keys(vs).length) out.views = vs;
    }
    return out;
  };
  const poses = Object.fromEntries(Object.entries(merge(t.poses, a.poses)).map(([k, v]) => [k, keep(v)]));
  let mirror = a.mirror !== undefined ? a.mirror : t.mirror;
  mirror = Object.fromEntries(Object.entries(mirror || {}).filter(([, src]) => views.includes(src)));
  const secondary = Object.fromEntries(Object.entries({ ...(t.secondary || {}), ...(a.secondary || {}) }).filter(([k, v]) => v && parts[k] && parts[k].parent));
  return {
    frame: t.frame, views, mirror, root: a.root || t.root, parts, poses, presets: merge(t.presets, a.presets), guide: t.guide,
    sampling: a.sampling ?? t.sampling, scale_children: a.scale_children ?? t.scale_children, secondary, feet: a.feet,
    ...(t.weapon ? { weapon: t.weapon } : {}), ...(a.variant_sets ? { variant_sets: a.variant_sets } : {}),
  };
}
