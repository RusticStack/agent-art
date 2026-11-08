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

export const RIG_TEMPLATES = { humanoid, blob, flyer };

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
  for (const p of Object.values(parts)) if (p.parent && !parts[p.parent]) { p.at = p.at || [0, 0]; delete p.parent; }
  const views = a.views || t.views;
  for (const p of Object.values(parts)) if (p.views) p.views = Object.fromEntries(Object.entries(p.views).filter(([v]) => views.includes(v)));
  const keep = (pose) => Object.fromEntries(Object.entries(pose).filter(([k]) => parts[k]));
  const poses = Object.fromEntries(Object.entries(merge(t.poses, a.poses)).map(([k, v]) => [k, keep(v)]));
  let mirror = a.mirror !== undefined ? a.mirror : t.mirror;
  mirror = Object.fromEntries(Object.entries(mirror || {}).filter(([, src]) => views.includes(src)));
  return { frame: t.frame, views, mirror, root: a.root || t.root, parts, poses, presets: merge(t.presets, a.presets), guide: t.guide };
}
