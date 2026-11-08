// Hand-drawn fp2d demo art, made only with Agent Art's own drawing ops (art_draw commands: polygon,
// line, ellipse, pixels, outline, shade) on the canvases art_fp template lays out. No 3D render is
// involved: the gun is a short list of block shapes in gun space (cm) placed over the template's
// class anchors, each drawn face by face as a flat polygon (lit top, mid side, dark ends) with its
// edges inked; arms and hands are lines, ellipses and polygons in the template's part layout.
// Used by scripts/fp2d-demos.js and test/fp2d.test.js.
import { keyRotation, projectRef } from '../src/fp2d.js';
import { mv } from '../src/fp.js';

// ---------- palettes (hue-shifted ramps, dark -> light) ----------
export const PAL = {
  ink: '#121318',
  metal: ['#1c1e25', '#2c3039', '#424854', '#5d6573', '#848d9a'],
  poly: ['#1d1e1b', '#2b2d27', '#3e4138', '#565a4d'],
  tan: ['#3d3326', '#5e4f39', '#837053', '#a8946f'],
  sleeve: ['#252b1c', '#36402a', '#4b5a3c', '#63764f', '#7f9365'],
  glove: ['#1a1a1c', '#29292c', '#3b3c40', '#505257', '#6a6d73'],
  plate: ['#22262c', '#363c45', '#4e5662', '#6e7885'],
  skin: ['#6e4a36', '#8f644a', '#b38463'],
};

/** An axis-aligned block (gun space, cm): x half width, y from..to, z from..to (+z = rear). */
const block = (hx, y0, y1, z0, z1, mat, name) => ({ name, mat, P: [[-hx, y0, z0], [hx, y0, z0], [hx, y1, z0], [-hx, y1, z0], [-hx, y0, z1], [hx, y0, z1], [hx, y1, z1], [-hx, y1, z1]] });
/** A raked block: 8 explicit corners (bottom ring then top ring, same order as block). */
const hexa = (P, mat, name) => ({ name, mat, P });

/** The demo SMG ("vandal"): built around the smg class anchors (grip 0, support z -23, mag well z -11.5, muzzle z -47.3). */
export function smgBlueprint() {
  const g = 1.2;
  return [
    hexa([[-g, -8.6, 4.4], [g, -8.6, 4.4], [g, 3.9, 1.6], [-g, 3.9, 1.6], [-g, -8.6, 0.8], [g, -8.6, 0.8], [g, 3.9, -2.0], [-g, 3.9, -2.0]], 'poly', 'grip'),
    block(1.35, 0.3, 3.9, -9.4, -13.8, 'metal', 'mag_well'),
    block(0.3, 1.6, 2.2, -1.6, -7.2, 'metal', 'guard'),
    block(1.45, 3.9, 9.9, 5.5, -16.5, 'metal', 'receiver'),
    block(1.0, 9.9, 11.0, 3.5, -14.5, 'metal', 'rail'),
    block(0.55, 9.9, 13.9, -0.4, -2.4, 'metal', 'rear_sight'),
    block(0.35, 10.6, 10.9, 4.8, 3.0, 'metal', 'charging'),
    block(1.75, 4.9, 9.9, -16.5, -31.5, 'tan', 'shroud'),
    block(0.3, 9.9, 12.4, -29.6, -30.8, 'metal', 'front_sight'),
    block(0.55, 7.2, 8.2, -31.5, -44.8, 'metal', 'barrel'),
    block(0.85, 6.85, 8.55, -44.8, -47.3, 'metal', 'muzzle'),
  ];
}
/** The demo magazine (mag space: mount at the top centre, origin). */
export function magBlueprint() {
  return [hexa([[-0.9, -12, 1.5], [0.9, -12, 1.5], [0.9, 0, 1.8], [-0.9, 0, 1.8], [-0.9, -12, -2.1], [0.9, -12, -2.1], [0.9, 0, -1.8], [-0.9, 0, -1.8]], 'metal', 'body'), block(1.1, -12.9, -12, 1.9, -2.5, 'poly', 'base')];
}
const FACES = [[0, 1, 2, 3, 'rear'], [5, 4, 7, 6, 'front'], [4, 0, 3, 7, 'left'], [1, 5, 6, 2, 'right'], [3, 2, 6, 7, 'top'], [4, 5, 1, 0, 'bottom']];
const SHADE = { top: 3, left: 2, right: 2, rear: 1, front: 1, bottom: 0 };

/**
 * Draw commands for a block blueprint seen in a key canvas (meta.fp2d view, reference anchor at
 * ref): visible faces back to front, flat ramp colours per face, inked edges, then an outer outline.
 */
export function blueprintCommands(parts, meta, ref) {
  const R = keyRotation(meta);
  const px = (X) => { const p = projectRef(R, X); return [Math.round(ref[0] + p[0]), Math.round(ref[1] + p[1])]; };
  const eye = (X) => { const Y = mv(R, X); return [Y[0], Y[1], Y[2] - 34]; };
  const faces = [];
  for (const part of parts) {
    const ramp = PAL[part.mat];
    for (const [a, b, c, d, side] of FACES) {
      const Q = [part.P[a], part.P[b], part.P[c], part.P[d]], E = Q.map(eye);
      // visible: the face normal points toward the eye
      const u = E[1].map((v, i) => v - E[0][i]), v = E[3].map((w, i) => w - E[0][i]);
      const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
      const cen = E.reduce((s, p) => s.map((x, i) => x + p[i] / 4), [0, 0, 0]);
      if (n[0] * -cen[0] + n[1] * -cen[1] + n[2] * -cen[2] <= 0) continue;
      const shade = Math.min(ramp.length - 1, SHADE[side] + (part.mat === 'tan' ? 0 : 0));
      faces.push({ z: -cen[2], pts: Q.map(px), color: ramp[shade], edge: ramp[Math.max(0, shade - 1)] });
    }
  }
  faces.sort((p, q) => q.z - p.z);
  const cmds = [];
  for (const f of faces) {
    cmds.push({ op: 'polygon', points: f.pts, color: f.color });
    cmds.push({ op: 'line', points: [...f.pts, f.pts[0]], color: f.edge });
  }
  cmds.push({ op: 'outline', color: PAL.ink });
  return cmds;
}

/** Detail pass for the SMG (rail teeth, ejection port, vents) in the same view. */
export function smgDetail(meta, ref) {
  const R = keyRotation(meta);
  const px = (X) => { const p = projectRef(R, X); return [Math.round(ref[0] + p[0]), Math.round(ref[1] + p[1])]; };
  const cmds = [];
  const teeth = [];
  for (let z = 3; z > -14; z -= 1.6) teeth.push(px([-1.0, 11.0, z]));
  cmds.push({ op: 'pixels', color: PAL.metal[4], points: teeth });
  cmds.push({ op: 'line', points: [px([-1.46, 8.6, -4]), px([-1.46, 8.6, -10]), px([-1.46, 6.6, -10]), px([-1.46, 6.6, -4]), px([-1.46, 8.6, -4])], color: PAL.metal[0] });
  for (let z = -18.5; z > -30; z -= 3) cmds.push({ op: 'line', points: [px([-1.76, 8.6, z]), px([-1.76, 8.6, z - 1.6])], color: PAL.tan[0] });
  return cmds;
}

// ---------- arms ----------
/** Upper / fore arm in the template layout (joint at the left, end at the right, outside up). */
export function limbCommands(part, view, pts, s = 6) {
  const [jx, jy] = pts.joint, [ex, ey] = pts.end;
  const L = ex - jx, cy = jy, r0 = (part === 'upper' ? 5.2 : 4.4) * s, r1 = (part === 'upper' ? 4.4 : 3.2) * s;
  const cmds = [];
  const poly = (x0, x1, a0, a1, color) => cmds.push({ op: 'polygon', points: [[Math.round(x0), Math.round(cy - a0)], [Math.round(x1), Math.round(cy - a1)], [Math.round(x1), Math.round(cy + a1)], [Math.round(x0), Math.round(cy + a0)]], color });
  const rAt = (t) => r0 + (r1 - r0) * t;
  if (part === 'upper') {
    poly(jx, ex, r0, r1, PAL.sleeve[2]);
    cmds.push({ op: 'ellipse', x: Math.round(jx - r0), y: Math.round(cy - r0), w: Math.round(2 * r0), h: Math.round(2 * r0), color: PAL.sleeve[2] });
    for (let t = 0.2; t < 0.95; t += 0.18) cmds.push({ op: 'line', points: [[Math.round(jx + L * t), Math.round(cy - rAt(t) + 3)], [Math.round(jx + L * t + 8), Math.round(cy - rAt(t) * 0.2)]], color: PAL.sleeve[0] });
    cmds.push({ op: 'shade', colors: PAL.sleeve, light: 'top-left' });
  } else {
    const cuff = 0.82;
    poly(jx, jx + L * cuff, r0, rAt(cuff), PAL.sleeve[2]);
    cmds.push({ op: 'ellipse', x: Math.round(jx - r0), y: Math.round(cy - r0), w: Math.round(2 * r0), h: Math.round(2 * r0), color: PAL.sleeve[2] });
    cmds.push({ op: 'shade', colors: PAL.sleeve, light: 'top-left' });
    poly(jx + L * cuff, ex + 4, rAt(cuff) + 2, r1 + 2, PAL.glove[2]);
    // bracer plate on the outside (up)
    poly(jx + L * 0.3, jx + L * 0.72, rAt(0.3) * 0.95, rAt(0.72) * 0.95, PAL.plate[2]);
    cmds.push({ op: 'polygon', points: [[Math.round(jx + L * 0.3), Math.round(cy - rAt(0.3))], [Math.round(jx + L * 0.72), Math.round(cy - rAt(0.72))], [Math.round(jx + L * 0.72), Math.round(cy - rAt(0.72) * 0.25)], [Math.round(jx + L * 0.3), Math.round(cy - rAt(0.3) * 0.25)]], color: PAL.plate[3] });
    cmds.push({ op: 'line', points: [[Math.round(jx + L * 0.3), Math.round(cy - rAt(0.3) * 0.25)], [Math.round(jx + L * 0.72), Math.round(cy - rAt(0.72) * 0.25)]], color: PAL.plate[0] });
    if (view === 'away') cmds.push({ op: 'ellipse', x: Math.round(ex - r1 * 0.6), y: Math.round(cy - r1 - 2), w: Math.round(r1 * 1.2), h: Math.round(2 * r1 + 4), color: PAL.glove[1] });
  }
  cmds.push({ op: 'outline', color: PAL.ink });
  return cmds;
}

/**
 * Hand pose in the template layout (wrist left, fingers right, back of the hand toward you, thumb
 * up). -> {front: commands, back: commands}: what lies over the held grip and what goes behind it.
 */
export function handCommands(pose, pts, s = 6) {
  const [wx, wy] = pts.wrist, [gx] = pts.grip;
  const kx = wx + (gx - wx) * 2; // knuckle line
  const hw = 4.0 * s, fw = Math.round(1.7 * s);
  const front = [], back = [];
  const G = PAL.glove;
  // palm (back of the hand) + knuckle plate
  front.push({ op: 'polygon', points: [[Math.round(wx), Math.round(wy - hw * 0.8)], [Math.round(kx), Math.round(wy - hw)], [Math.round(kx), Math.round(wy + hw)], [Math.round(wx), Math.round(wy + hw * 0.8)]], color: G[2] });
  front.push({ op: 'polygon', points: [[Math.round(kx - 1.6 * s), Math.round(wy - hw + 2)], [Math.round(kx), Math.round(wy - hw + 2)], [Math.round(kx), Math.round(wy + hw - 2)], [Math.round(kx - 1.6 * s), Math.round(wy + hw - 2)]], color: PAL.plate[2] });
  // fingers: 4 from the knuckle line (index on the thumb side, y up). Each finger is [straight, curled] lengths (cm)
  const F = {
    open: [[4.6, 0], [4.9, 0], [4.6, 0], [3.8, 0]], relaxed: [[3.6, 1.2], [3.6, 1.4], [3.4, 1.4], [2.8, 1.2]],
    trigger: [[4.2, 0.6], [1.6, 2.6], [1.6, 2.6], [1.4, 2.2]], trigger_off: [[4.6, 0], [1.6, 2.6], [1.6, 2.6], [1.4, 2.2]], thumb_release: [[4.2, 0.6], [1.6, 2.6], [1.6, 2.6], [1.4, 2.2]],
    support: [[2.6, 2.2], [2.8, 2.2], [2.6, 2.2], [2.2, 1.8]], vgrip: [[1.6, 2.8], [1.6, 2.8], [1.6, 2.8], [1.4, 2.4]], agrip: [[3.4, 1.0], [3.6, 1.0], [3.4, 1.0], [2.8, 1.0]],
    mag_pinch: [[3.8, 1.0], [3.4, 1.2], [1.6, 2.4], [1.4, 2.0]], fist: [[1.4, 2.4], [1.5, 2.4], [1.4, 2.4], [1.2, 2.0]], grenade: [[2.4, 2.0], [2.6, 2.0], [2.4, 2.0], [2.0, 1.8]],
  }[pose];
  const ys = [-0.62, -0.2, 0.2, 0.6].map((t) => wy + t * hw * 1.5);
  F.forEach(([st, cu], i) => {
    const x0 = Math.round(kx), y0 = Math.round(ys[i]), x1 = Math.round(kx + st * s);
    front.push({ op: 'line', points: [[x0, y0], [x1, y0]], color: G[2], width: fw, brush: 'round' });
    if (cu > 0) back.push({ op: 'line', points: [[x1, y0], [Math.round(x1 - cu * s * 0.3), Math.round(y0 + cu * s * 0.8)]], color: G[1], width: fw, brush: 'round' });
  });
  // thumb: from the base of the palm on the upper side
  const tx = Math.round(wx + 1.6 * s), ty = Math.round(wy - hw * 0.85);
  const thumb = { trigger: [[2.6, -1.0], [4.6, -0.2]], thumb_release: [[2.2, -2.4], [3.4, -3.8]], open: [[2.4, -2.6], [4.2, -3.4]], trigger_off: [[2.6, -1.0], [4.6, -0.2]] }[pose] || [[2.8, -0.6], [4.4, 0.6]];
  front.push({ op: 'line', points: [[tx, ty], ...thumb.map(([dx, dy]) => [Math.round(tx + dx * s), Math.round(ty + dy * s)])], color: G[2], width: Math.round(1.9 * s), brush: 'round' });
  front.push({ op: 'shade', colors: G.slice(1), of: G[2], light: 'top-left' });
  if (back.length) back.push({ op: 'shade', colors: G.slice(0, 3), of: G[1], light: 'top-left' });
  for (const L of [front, back]) if (L.length) L.push({ op: 'outline', color: PAL.ink });
  // a light catch on the knuckles
  front.push({ op: 'line', points: [[Math.round(kx - 1.4 * s), Math.round(wy - hw + 3)], [Math.round(kx - 1.4 * s), Math.round(wy + hw - 4)]], color: PAL.plate[3] });
  return { front, back };
}

/**
 * Draw the whole demo set into an engine: SMG keys (hip, ads, reload) + magazine keys + the "ink"
 * arms skin (upper side, fore side / away, hands). Returns the canvas names.
 */
export function drawDemoSet(e, { gun = 'vandal', mag = 'vandal_mag', skin = 'ink', poses, views = ['hip', 'ads', 'reload'], arms = true } = {}) {
  const made = { gun: [], mag: [], arms: [] };
  for (const view of views) {
    const t = e.run('fp_template', { kind: 'gun', name: gun, class: 'smg', ...(typeof view === 'string' ? { view } : view), mag, overwrite: true });
    const d = e.get(t.canvas), m = d.meta.fp2d;
    e.run('draw', { canvas: t.canvas, layer: 'art', commands: [...blueprintCommands(smgBlueprint(), m, m.anchors.grip), ...smgDetail(m, m.anchors.grip)] });
    made.gun.push(t.canvas);
  }
  for (const view of ['hip', 'ads']) {
    const t = e.run('fp_template', { kind: 'mag', name: mag, class: 'smg', view, overwrite: true });
    const d = e.get(t.canvas), m = d.meta.fp2d;
    e.run('draw', { canvas: t.canvas, layer: 'art', commands: blueprintCommands(magBlueprint(), m, m.anchors.mount) });
    made.mag.push(t.canvas);
  }
  if (!arms) return made;
  for (const [part, view] of [['upper', 'side'], ['fore', 'side'], ['fore', 'away']]) {
    const t = e.run('fp_template', { kind: 'arm', name: skin, part, view, overwrite: true });
    const pts = t.points;
    if (view === 'away') { // the far end foreshortened: the drawing is shorter
      const d = e.get(t.canvas); const end = [pts.joint[0] + (pts.end[0] - pts.joint[0]) * 0.7, pts.end[1]];
      d.meta = { ...d.meta, fp2d: { ...d.meta.fp2d, end } }; pts.end = end;
    }
    e.run('draw', { canvas: t.canvas, layer: 'art', commands: limbCommands(part, view, pts) });
    made.arms.push(t.canvas);
  }
  for (const pose of poses || ['trigger', 'trigger_off', 'thumb_release', 'support', 'vgrip', 'agrip', 'mag_pinch', 'open', 'relaxed', 'fist', 'grenade']) {
    const t = e.run('fp_template', { kind: 'arm', name: skin, part: 'hand', pose, view: 'back', overwrite: true });
    const c = handCommands(pose, t.points);
    if (c.back.length) e.run('draw', { canvas: t.canvas, layer: 'back', commands: c.back });
    e.run('draw', { canvas: t.canvas, layer: 'front', commands: c.front });
    made.arms.push(t.canvas);
  }
  return made;
}
