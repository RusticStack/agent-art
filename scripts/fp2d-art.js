// Hand-pixelled fp2d demo art, made only with Agent Art's own drawing ops (art_draw commands:
// polygon, line, ellipse, pixels, outline) on the canvases art_fp template lays out. No 3D render is
// involved. Guns and magazines are drawn the way a pixel artist builds a turned sprite: a side
// profile (cm, around the class anchors the template marks) laid out in the key's view, each part
// filled from a hue-shifted ramp (cool shadows, warm highlights) with a rim light on its upper edges
// and a shadow band under it, a 1 px selective outline per material, then hand-placed details
// (ejection port, rail teeth, vents, pins, mag ribs, grip stipple, the trigger guard as a real
// opening with the blade inside). The contact masks (grip wrap, guard opening, fore grip wrap, mag
// pinch) are painted on the hidden mask layers. Arms are a glove + sleeve skin: sleeve tubes with
// folds and a cuff, hands with four jointed fingers and a thumb per pose, split into the layers
// back (behind the held object), front (over it) and trigger (the finger through the guard).
// Used by scripts/fp2d-demos.js and test/fp2d.test.js.
import { keyRotation, projectRef } from '../src/fp2d.js';
import { mv, D } from '../src/fp.js';
import { FINGERS } from '../src/fparms.js';

// ---------- palettes (hue-shifted ramps, dark -> light: cool / violet shadows, warm highlights) ----------
export const PAL = {
  ink: '#120f1a',
  metal: ['#14121f', '#23243a', '#353b52', '#4d5869', '#6f7e88', '#aab3a6'],
  anod: ['#151320', '#25222f', '#383444', '#514c5a', '#736c74', '#a39a94'],
  poly: ['#161317', '#24202a', '#352f38', '#4a4249', '#64595b', '#8a7b72'],
  tan: ['#2c2224', '#4a3a33', '#6e5843', '#937652', '#b89a69', '#dcc38e'],
  od: ['#1a1d1f', '#2a3127', '#3e4834', '#566142', '#737d55', '#9ea476'],
  brass: ['#3a2a14', '#6b4e1f', '#a07a2e', '#cfa94a', '#f0d98a'],
  sleeve: ['#1d211f', '#2c3527', '#404b33', '#596443', '#757f57', '#9fa275'],
  glove: ['#17141d', '#25212b', '#363140', '#4b4553', '#665d66', '#8d7f7a'],
  plate: ['#1f2129', '#30343f', '#474d5a', '#646b76', '#8f9298'],
  mask: '#ffffff',
};
const LIGHT = (() => { const v = [-0.45, 0.8, 0.45], n = Math.hypot(...v); return v.map((x) => x / n); })();
const R2 = (p) => [Math.round(p[0]), Math.round(p[1])];

// ---------- gun profiles (cm, gun space: origin = grip anchor, +y up, -z toward the muzzle) ----------
/** A part: profile polygon in (z, y), extruded across x0..x1, material ramp name. */
const part = (name, mat, x, prof, o = {}) => ({ name, mat, x: Array.isArray(x) ? x : [-x, x], prof, ...o });
/** A thick polyline (z, y) as a closed profile (half thickness h). */
function thick(path, h) {
  const L = [], Rr = [];
  for (let i = 0; i < path.length; i++) {
    const a = path[Math.max(0, i - 1)], b = path[Math.min(path.length - 1, i + 1)];
    const dz = b[0] - a[0], dy = b[1] - a[1], n = Math.hypot(dz, dy) || 1, nz = -dy / n, ny = dz / n;
    L.push([path[i][0] + nz * h, path[i][1] + ny * h]); Rr.push([path[i][0] - nz * h, path[i][1] - ny * h]);
  }
  return [...L, ...Rr.reverse()];
}
/** Pistol grip with finger grooves and a curved back strap (shared by the long-gun classes). */
const GRIP = [[2.3, 3.9], [2.9, 1.2], [3.4, -2.2], [3.9, -5.0], [3.7, -5.9], [0.5, -6.0], [0.1, -5.2], [-0.5, -4.6], [-0.2, -3.6], [-0.8, -2.5], [-0.6, -1.4], [-1.1, -0.4], [-1.5, 1.2], [-1.9, 3.9]];
/** Guard ring centre line (grip front -> receiver / well) and the trigger blade. */
const GUARD = [[-1.25, 1.0], [-2.0, 0.55], [-7.3, 0.55], [-8.5, 1.2], [-8.95, 2.4], [-9.0, 3.9]];
const TRIGGER = [[-3.3, 3.9], [-3.9, 2.9], [-3.95, 2.2], [-3.55, 1.6]];
/** Guard opening (the hole between grip, receiver and ring), for the guard mask. */
const OPENING = [[-1.3, 3.9], [-1.5, 1.2], [-2.1, 0.85], [-7.2, 0.85], [-8.3, 1.4], [-8.7, 2.4], [-8.7, 3.9]];

/** The demo SMG "vandal" (smg class anchors: support z -23, mag well z -11.5, muzzle z -47.3, sight y 13.9). */
export function smgParts() {
  return [
    part('grip', 'poly', 1.3, GRIP, { texture: 'stipple' }),
    part('mag_well', 'metal', 1.35, [[-9.2, 3.9], [-9.05, 0.3], [-14.0, 0.3], [-13.85, 3.9]], { flare: [-9.3, -13.8, 0.8] }),
    part('guard', 'metal', 0.35, thick(GUARD, 0.32)),
    part('trigger', 'metal', 0.28, thick(TRIGGER, 0.2), { light: 1 }),
    part('receiver', 'metal', 1.45, [[5.6, 9.0], [4.7, 9.9], [-16.5, 9.9], [-16.5, 3.9], [4.6, 3.9], [5.6, 4.8]], { port: [-3.2, -9.2, 6.3, 8.5], pins: [[3.4, 5.0], [-14.8, 5.0], [-6.5, 4.6]], seam: 6.0 }),
    part('charging', 'metal', 1.95, [[4.3, 9.9], [4.3, 10.9], [3.9, 11.3], [1.9, 11.3], [1.9, 9.9]]),
    part('rail', 'metal', 1.0, [[3.5, 9.9], [3.5, 11.0], [-14.5, 11.0], [-14.5, 9.9]], { teeth: [3.0, -14.2, 11.0] }),
    part('shroud', 'tan', 1.75, [[-16.5, 9.9], [-30.6, 9.9], [-31.5, 9.0], [-31.5, 5.8], [-30.6, 4.9], [-16.5, 4.9]], { vents: { z: [-18.6, -28.8], y: 7.4, n: 5 }, seam: 8.9 }),
    part('fsight_base', 'metal', 0.6, [[-29.3, 9.9], [-29.3, 10.6], [-31.0, 10.6], [-31.0, 9.9]]),
    part('fsight_ear_l', 'metal', [-0.95, -0.6], [[-29.5, 10.6], [-29.5, 12.9], [-30.8, 12.9], [-30.8, 10.6]]),
    part('fsight_ear_r', 'metal', [0.6, 0.95], [[-29.5, 10.6], [-29.5, 12.9], [-30.8, 12.9], [-30.8, 10.6]]),
    part('fsight_post', 'metal', 0.22, [[-29.9, 10.6], [-29.9, 12.5], [-30.4, 12.5], [-30.4, 10.6]], { light: 1 }),
    part('barrel', 'metal', 0.5, [[-31.5, 8.2], [-44.8, 8.2], [-44.8, 7.2], [-31.5, 7.2]]),
    part('muzzle', 'metal', 0.85, [[-44.6, 8.6], [-47.3, 8.6], [-47.3, 6.8], [-44.6, 6.8]], { slots: [[-45.2, -46.6], 7.7] }),
    part('rsight_base', 'metal', 0.9, [[0.2, 10.9], [0.2, 11.5], [-2.8, 11.5], [-2.8, 10.9]]),
    part('rsight_ear_l', 'metal', [-0.95, -0.35], [[-0.5, 11.5], [-0.5, 13.5], [-0.9, 13.95], [-2.0, 13.95], [-2.4, 13.5], [-2.4, 11.5]]),
    part('rsight_ear_r', 'metal', [0.35, 0.95], [[-0.5, 11.5], [-0.5, 13.5], [-0.9, 13.95], [-2.0, 13.95], [-2.4, 13.5], [-2.4, 11.5]]),
  ];
}
/** The demo rifle "warden" (rifle class anchors: support z -28.3, muzzle z -58.2). */
export function rifleParts() {
  return [
    part('grip', 'poly', 1.3, GRIP, { texture: 'stipple' }),
    part('lower', 'anod', 1.45, [[6.2, 6.0], [-14.2, 6.0], [-14.2, 3.9], [-13.9, 0.3], [-9.2, 0.3], [-9.0, 3.6], [2.2, 3.6], [4.8, 4.3], [6.2, 5.0]], { pins: [[1.4, 4.6], [-7.8, 4.6], [4.6, 5.2]], flare: [-9.3, -14.0, 0.8] }),
    part('guard', 'anod', 0.35, thick(GUARD, 0.32)),
    part('trigger', 'metal', 0.28, thick(TRIGGER, 0.2), { light: 1 }),
    part('upper', 'anod', 1.5, [[6.6, 9.9], [-13.6, 9.9], [-13.6, 6.0], [6.6, 6.0]], { port: [-2.6, -9.0, 6.8, 8.9], pins: [[-11.8, 7.0]], assist: [4.4, 7.4] }),
    part('charging', 'metal', 2.0, [[4.8, 9.9], [4.8, 10.8], [4.4, 11.2], [1.6, 11.2], [1.6, 9.9]]),
    part('handguard', 'od', 1.95, [[-13.6, 10.0], [-36.4, 10.0], [-37.2, 9.2], [-37.2, 5.7], [-36.4, 4.9], [-13.6, 4.9]], { slots: null, mlok: { z: [-16.0, -34.5], y: 7.0, n: 6 }, seam: 9.2 }),
    part('rail', 'metal', 1.05, [[5.8, 10.0], [5.8, 11.2], [-36.0, 11.2], [-36.0, 10.0]], { teeth: [5.4, -35.6, 11.2] }),
    part('gas_block', 'metal', 0.85, [[-37.6, 9.4], [-37.6, 6.6], [-40.0, 6.6], [-40.0, 9.4]]),
    part('barrel', 'metal', 0.55, [[-37.2, 8.3], [-55.0, 8.3], [-55.0, 7.1], [-37.2, 7.1]]),
    part('muzzle', 'metal', 0.95, [[-54.8, 8.8], [-58.2, 8.8], [-58.2, 6.6], [-54.8, 6.6]], { slots: [[-55.4, -57.6], 7.7] }),
    part('fsight_base', 'metal', 0.7, [[-33.6, 11.2], [-33.6, 11.8], [-35.6, 11.8], [-35.6, 11.2]]),
    part('fsight_ear_l', 'metal', [-1.0, -0.6], [[-34.0, 11.8], [-34.0, 13.6], [-35.2, 13.6], [-35.2, 11.8]]),
    part('fsight_ear_r', 'metal', [0.6, 1.0], [[-34.0, 11.8], [-34.0, 13.6], [-35.2, 13.6], [-35.2, 11.8]]),
    part('fsight_post', 'metal', 0.22, [[-34.4, 11.8], [-34.4, 13.3], [-34.9, 13.3], [-34.9, 11.8]], { light: 1 }),
    part('rsight_base', 'metal', 0.95, [[0.4, 11.2], [0.4, 11.8], [-2.9, 11.8], [-2.9, 11.2]]),
    part('rsight_ear_l', 'metal', [-1.0, -0.35], [[-0.5, 11.8], [-0.5, 13.5], [-0.9, 13.95], [-2.0, 13.95], [-2.4, 13.5], [-2.4, 11.8]]),
    part('rsight_ear_r', 'metal', [0.35, 1.0], [[-0.5, 11.8], [-0.5, 13.5], [-0.9, 13.95], [-2.0, 13.95], [-2.4, 13.5], [-2.4, 11.8]]),
  ];
}
/** Straight SMG stick magazine (mag space: mount = top centre, origin; body hangs down, front = -z). */
export function smgMagParts() {
  return [
    part('lips', 'brass', 0.55, [[0.9, 0.55], [-1.2, 0.55], [-1.4, 0.0], [1.1, 0.0]]),
    part('body', 'metal', 0.9, [[1.8, 0.0], [2.0, -12.0], [-1.9, -12.0], [-1.8, 0.0]], { ribs: { y: [-2.0, -10.6], n: 6 }, holes: [[0.9, -3.0], [0.9, -6.0], [0.9, -9.0]] }),
    part('base', 'poly', 1.1, [[2.3, -12.0], [2.3, -12.9], [-2.2, -12.9], [-2.0, -12.0]]),
  ];
}
/** Curved rifle magazine. */
export function rifleMagParts() {
  const rear = [[1.8, 0.0], [2.0, -4.0], [1.4, -9.0], [0.0, -14.4]], front = [[-1.9, 0.0], [-2.2, -4.0], [-3.4, -8.6], [-5.2, -13.6]];
  return [
    part('lips', 'brass', 0.55, [[0.9, 0.55], [-1.2, 0.55], [-1.4, 0.0], [1.1, 0.0]]),
    part('body', 'anod', 1.1, [...rear, ...front.reverse()], { ribs: { curve: [[0.0, -1.6], [-0.2, -5.0], [-1.0, -9.0], [-2.4, -12.6]], n: 7, w: 1.6 } }),
    part('base', 'poly', 1.3, [[0.3, -14.4], [-0.1, -15.3], [-5.9, -14.4], [-5.5, -13.4]]),
  ];
}

// ---------- the profile painter ----------
/** Signed area of a (z, y) profile (winding). */
const area = (P) => P.reduce((s, p, i) => { const q = P[(i + 1) % P.length]; return s + p[0] * q[1] - q[0] * p[1]; }, 0) / 2;
const inside = (P, z, y) => { let c = false; for (let i = 0, j = P.length - 1; i < P.length; j = i++) { const [zi, yi] = P[i], [zj, yj] = P[j]; if ((yi > y) !== (yj > y) && z < ((zj - zi) * (y - yi)) / (yj - yi) + zi) c = !c; } return c; };

/**
 * Draw commands for a list of profile parts seen in a key canvas (meta.fp2d view, reference anchor
 * at ref). Returns {art, near} where near(part) is the near-side x of a drawn part.
 */
export function profileCommands(parts, meta, ref) {
  const R = keyRotation(meta);
  const px = (X) => { const p = projectRef(R, X); return [ref[0] + p[0], ref[1] + p[1]]; };
  const eyeOf = (X) => mv(R, X);
  const visible = (n, X) => { const N = mv(R, n), Y = eyeOf(X); return N[0] * -Y[0] + N[1] * -Y[1] + N[2] * (D - Y[2]) > 1e-6; };
  const lum = (n) => { const N = mv(R, n); return N[0] * LIGHT[0] + N[1] * LIGHT[1] + N[2] * LIGHT[2]; };
  const tone = (ramp, n, bias = 0) => ramp[Math.max(1, Math.min(ramp.length - 2, Math.round(((lum(n) + 0.55) / 1.55) * (ramp.length - 3)) + 1 + bias))];
  const ordered = parts.map((p) => {
    const cz = p.prof.reduce((s, q) => s + q[0], 0) / p.prof.length, cy = p.prof.reduce((s, q) => s + q[1], 0) / p.prof.length;
    const Y = eyeOf([(p.x[0] + p.x[1]) / 2, cy, cz]);
    return { p, dist: Math.hypot(Y[0], Y[1], D - Y[2]) };
  }).sort((a, b) => b.dist - a.dist).map((o) => o.p);
  const art = [], detail = [];
  const sides = new Map();
  for (const p of ordered) {
    const ramp = PAL[p.mat], s = Math.sign(area(p.prof)) || 1, bias = p.light || 0;
    // the extruded rims facing the eye (top, bottom, ends) as flat ramp faces
    const xs = p.x;
    const nearX = visible([1, 0, 0], [xs[1], p.prof[0][1], p.prof[0][0]]) ? xs[1] : xs[0];
    const sideVis = visible([nearX > (xs[0] + xs[1]) / 2 ? 1 : -1, 0, 0], [nearX, p.prof[0][1], p.prof[0][0]]);
    sides.set(p, nearX);
    const edges = p.prof.map((a, i) => { const b = p.prof[(i + 1) % p.prof.length]; const dz = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dz, dy) || 1; return { a, b, n: [0, (-dz / L) * s, (dy / L) * s] }; });
    // e.n = (0, ny, nz): the outward normal (for a CCW (z, y) profile, edge a->b points out along (dy, -dz))
    for (const e of edges) {
      const mid = [(xs[0] + xs[1]) / 2, (e.a[1] + e.b[1]) / 2, (e.a[0] + e.b[0]) / 2];
      if (!visible(e.n, mid)) continue;
      art.push({ op: 'polygon', points: [px([xs[0], e.a[1], e.a[0]]), px([xs[1], e.a[1], e.a[0]]), px([xs[1], e.b[1], e.b[0]]), px([xs[0], e.b[1], e.b[0]])], color: tone(ramp, e.n, bias) });
    }
    if (!sideVis) continue;
    // the near side: base tone, a warm rim on edges facing up, a shadow band under edges facing down
    const sideN = [nearX >= 0 ? 1 : -1, 0, 0];
    const S = (z, y) => px([nearX, y, z]);
    art.push({ op: 'polygon', points: p.prof.map(([z, y]) => S(z, y)), color: tone(ramp, sideN, bias) });
    for (const e of edges) {
      const [nz, ny] = [e.n[2], e.n[1]];
      const inset = (k) => [S(e.a[0] - nz * k, e.a[1] - ny * k), S(e.b[0] - nz * k, e.b[1] - ny * k)].map(R2);
      if (ny > 0.55) art.push({ op: 'line', points: inset(0.02), color: ramp[ramp.length - 1 - (p.mat === 'poly' ? 1 : 0)] });
      else if (ny < -0.55) { art.push({ op: 'line', points: inset(0.02), color: ramp[1] }); art.push({ op: 'line', points: inset(0.22), color: ramp[2] }); }
      else if (Math.abs(nz) > 0.55) art.push({ op: 'line', points: inset(0.02), color: nz > 0 ? ramp[2] : ramp[1] });
    }
    detail.push(...detailsOf(p, S, ramp));
  }
  return { art: [...art, ...detail], sides, px };
}

/** Hand-placed details on a part's near side (S: profile point -> canvas px). */
function detailsOf(p, S, ramp) {
  const c = [], top = ramp.length - 1;
  const line = (pts, color) => c.push({ op: 'line', points: pts.map(([z, y]) => R2(S(z, y))), color });
  const dot = (z, y, color) => c.push({ op: 'pixels', points: [R2(S(z, y))], color });
  if (p.port) { // ejection port: dark slot, lit lower lip, shadowed upper lip
    const [z0, z1, y0, y1] = p.port;
    c.push({ op: 'polygon', points: [S(z0, y0), S(z1, y0), S(z1, y1), S(z0, y1)].map(R2), color: ramp[0] });
    line([[z0, y1 - 0.25], [z1, y1 - 0.25]], ramp[1]);
    line([[z0, y0], [z1, y0]], ramp[top]);
    c.push({ op: 'polygon', points: [S(z0 - 0.4, y1 - 0.5), S(z0 - 2.0, y1 - 0.5), S(z0 - 2.0, y0 + 0.5), S(z0 - 0.4, y0 + 0.5)].map(R2), color: PAL.brass[2] });
    dot(z0 - 0.8, y1 - 0.7, PAL.brass[4]);
  }
  if (p.seam !== undefined) line([[p.prof[0][0] - 0.3, p.seam], [p.prof.reduce((m, q) => Math.min(m, q[0]), 0) + 0.4, p.seam]], ramp[1]);
  for (const [z, y] of p.pins || []) { dot(z, y, ramp[0]); dot(z + 0.2, y + 0.2, ramp[top]); }
  if (p.assist) { const [z, y] = p.assist; c.push({ op: 'polygon', points: [S(z, y + 0.6), S(z - 1.2, y + 0.6), S(z - 1.2, y - 0.6), S(z, y - 0.6)].map(R2), color: ramp[2] }); dot(z - 0.3, y + 0.3, ramp[top]); }
  if (p.teeth) { // rail teeth: slots across the top, lit tooth tops
    const [z0, z1, y] = p.teeth;
    for (let z = z0; z > z1; z -= 1.0) { line([[z, y - 0.05], [z, y - 0.55]], ramp[1]); dot(z - 0.5, y - 0.1, ramp[top]); }
  }
  if (p.vents) { // vent holes along the shroud
    const { z: [z0, z1], y, n } = p.vents;
    for (let i = 0; i < n; i++) { const z = z0 + ((z1 - z0) * i) / (n - 1); c.push({ op: 'polygon', points: [S(z + 0.55, y + 0.8), S(z - 0.55, y + 0.8), S(z - 0.75, y - 0.8), S(z + 0.35, y - 0.8)].map(R2), color: ramp[0] }); line([[z + 0.3, y - 0.9], [z - 0.7, y - 0.9]], ramp[top]); }
  }
  if (p.mlok) { // M-LOK slots on the handguard
    const { z: [z0, z1], y, n } = p.mlok;
    for (let i = 0; i < n; i++) { const z = z0 + ((z1 - z0) * i) / (n - 1); c.push({ op: 'polygon', points: [S(z + 0.9, y + 0.45), S(z - 0.9, y + 0.45), S(z - 0.9, y - 0.45), S(z + 0.9, y - 0.45)].map(R2), color: ramp[0] }); line([[z + 0.9, y - 0.55], [z - 0.9, y - 0.55]], ramp[top - 1]); }
  }
  if (p.slots) { const [[z0, z1], y] = p.slots; for (let z = z0; z > z1; z -= 0.7) line([[z, y + 0.4], [z, y - 0.4]], ramp[0]); }
  if (p.flare) { const [z0, z1, y] = p.flare; line([[z0, y], [z1, y]], ramp[top - 1]); line([[z0, y + 0.25], [z1, y + 0.25]], ramp[1]); }
  if (p.ribs?.curve) {
    const cv = p.ribs.curve;
    for (let i = 0; i < p.ribs.n; i++) {
      const t = (i + 0.5) / p.ribs.n, k = t * (cv.length - 1), j = Math.min(cv.length - 2, Math.floor(k)), u = k - j;
      const z = cv[j][0] + (cv[j + 1][0] - cv[j][0]) * u, y = cv[j][1] + (cv[j + 1][1] - cv[j][1]) * u;
      line([[z + p.ribs.w, y + 0.25], [z - p.ribs.w, y - 0.35]], ramp[1]);
      line([[z + p.ribs.w, y - 0.05], [z - p.ribs.w, y - 0.65]], ramp[top - 1]);
    }
  } else if (p.ribs) {
    const { y: [y0, y1], n } = p.ribs, zs = p.prof.map((q) => q[0]);
    for (let i = 0; i < n; i++) { const y = y0 + ((y1 - y0) * i) / (n - 1); line([[Math.max(...zs) - 0.5, y], [Math.min(...zs) + 0.5, y]], ramp[1]); line([[Math.max(...zs) - 0.5, y - 0.2], [Math.min(...zs) + 0.5, y - 0.2]], ramp[top - 1]); }
  }
  for (const [z, y] of p.holes || []) { dot(z, y, ramp[0]); dot(z, y - 0.2, ramp[0]); }
  if (p.texture === 'stipple') { // grip stipple + finger-groove creases
    for (let y = -5.6; y < 3.4; y += 0.42) for (let z = -1.4; z < 4.2; z += 0.42) {
      const odd = Math.round((y + 9) / 0.42) % 2;
      if (inside(p.prof, z + (odd ? 0.21 : 0), y) && inside(p.prof, z + 0.5, y + 0.5) && inside(p.prof, z - 0.5, y - 0.5)) dot(z + (odd ? 0.21 : 0), y, ramp[1]);
    }
    for (const [z, y] of [[-0.3, -4.6], [-0.6, -2.5], [-0.9, -0.4]]) line([[z, y], [z + 1.3, y + 0.1]], ramp[0]);
  }
  return c;
}

/** Selective outline: each material outlined in its own darkest tone, only onto empty pixels. */
const selout = (mats) => mats.map((m) => ({ op: 'outline', color: PAL[m][0], of: PAL[m], over_other: false }));

/** Mask polygons (flat colour) of parts / extra profiles seen in the view (both extrusion sides). */
function maskCommands(profiles, meta, ref) {
  const R = keyRotation(meta);
  const px = (X) => R2((() => { const p = projectRef(R, X); return [ref[0] + p[0], ref[1] + p[1]]; })());
  const out = [];
  for (const { prof, x } of profiles) {
    for (const X of x) out.push({ op: 'polygon', points: prof.map(([z, y]) => px([X, y, z])), color: PAL.mask });
    for (let i = 0; i < prof.length; i++) { const a = prof[i], b = prof[(i + 1) % prof.length]; out.push({ op: 'polygon', points: [px([x[0], a[1], a[0]]), px([x[1], a[1], a[0]]), px([x[1], b[1], b[0]]), px([x[0], b[1], b[0]])], color: PAL.mask }); }
  }
  return out;
}

/** Draw a gun key (art + contact masks) on a template canvas. */
function drawGunKey(e, canvas, parts, fore) {
  const d = e.get(canvas), m = d.meta.fp2d, ref = m.anchors.grip;
  const { art } = profileCommands(parts, m, ref);
  const mats = [...new Set(parts.map((p) => p.mat))];
  e.run('draw', { canvas, layer: 'art', commands: [...art, ...selout(mats)] });
  const grip = parts.find((p) => p.name === 'grip');
  e.run('draw', { canvas, layer: 'mask_grip', commands: maskCommands([{ prof: grip.prof, x: [-1.3, 1.3] }, { prof: [[2.6, 3.9], [2.6, 5.0], [-1.6, 5.0], [-1.6, 3.9]], x: [-1.5, 1.5] }], m, ref) });
  e.run('draw', { canvas, layer: 'mask_guard', commands: maskCommands([{ prof: OPENING, x: [-0.4, 0.4] }, { prof: thick(TRIGGER, 0.25), x: [-0.3, 0.3] }], m, ref) });
  e.run('draw', { canvas, layer: 'mask_fore', commands: maskCommands([{ prof: [[fore + 5, 3.0], [fore + 5, 7.0], [fore - 5, 7.0], [fore - 5, 3.0]], x: [-2.0, 2.0] }], m, ref) });
}
/** Draw a magazine key (art + pinch mask). */
function drawMagKey(e, canvas, parts) {
  const d = e.get(canvas), m = d.meta.fp2d, ref = m.anchors.mount;
  const { art } = profileCommands(parts, m, ref);
  const mats = [...new Set(parts.map((p) => p.mat))];
  e.run('draw', { canvas, layer: 'art', commands: [...art, ...selout(mats)] });
  e.run('draw', { canvas, layer: 'mask_pinch', commands: maskCommands([{ prof: [[2.2, 0.6], [2.3, -4.0], [-2.5, -4.0], [-2.0, 0.6]], x: [-1.1, 1.1] }], m, ref) });
}

// ---------- arms ----------
/** A tube between x0 and x1 (radius r0 -> r1) around cy, as lit bands (top rim .. dark underside). */
function tube(x0, x1, cy, r0, r1, ramp, bands = [[-1, -0.82, 4], [-0.82, 0.2, 3], [0.2, 0.68, 2], [0.68, 1, 1]]) {
  const out = [];
  for (const [a, b, k] of bands) out.push({ op: 'polygon', points: [[x0, cy + r0 * a], [x1, cy + r1 * a], [x1, cy + r1 * b], [x0, cy + r0 * b]].map(R2), color: ramp[k] });
  return out;
}
/** Upper / fore arm sleeve in the template layout (joint left, end right, outside of the arm up). */
export function limbCommands(part, view, pts, s = 6) {
  const [jx, cy] = pts.joint, [ex] = pts.end;
  const L = ex - jx, S = PAL.sleeve, G = PAL.glove;
  const c = [];
  if (part === 'upper') {
    const r0 = 5.0 * s, r1 = 4.3 * s;
    c.push({ op: 'ellipse', x: Math.round(jx - r0), y: Math.round(cy - r0), w: Math.round(2 * r0), h: Math.round(2 * r0), color: S[3] });
    c.push({ op: 'ellipse', x: Math.round(jx - r0 + 4), y: Math.round(cy - r0 + 2), w: Math.round(2 * r0 - 14), h: Math.round(r0 * 0.5), color: S[4] });
    c.push(...tube(jx, ex, cy, r0, r1, S));
    // shoulder patch with stitching
    const px0 = jx + L * 0.12, px1 = jx + L * 0.34;
    c.push({ op: 'polygon', points: [[px0, cy - r0 * 0.7], [px1, cy - r0 * 0.66], [px1, cy + r0 * 0.05], [px0, cy + r0 * 0.1]].map(R2), color: S[2] });
    c.push({ op: 'line', points: [[px0 + 2, cy - r0 * 0.7 + 2], [px1 - 2, cy - r0 * 0.66 + 2]].map(R2), color: S[4] });
    for (let x = px0 + 3; x < px1 - 2; x += 3) c.push({ op: 'pixels', points: [R2([x, cy + r0 * 0.05 - 2])], color: S[1] });
    // folds toward the elbow: dark crease + lit lip
    for (const t of [0.62, 0.74, 0.86]) {
      const x = jx + L * t, r = r0 + (r1 - r0) * t;
      c.push({ op: 'line', points: [[x - 6, cy - r * 0.55], [x + 3, cy - r * 0.05], [x - 2, cy + r * 0.5]].map(R2), color: S[1] });
      c.push({ op: 'line', points: [[x - 5, cy - r * 0.55], [x + 4, cy - r * 0.05], [x - 1, cy + r * 0.5]].map(R2), color: S[4] });
    }
    c.push({ op: 'line', points: [[jx + 8, cy - r0 * 0.25], [ex - 6, cy - r1 * 0.25]].map(R2), color: S[2] });
  } else {
    const r0 = 4.2 * s, rc = 3.6 * s, r1 = 3.1 * s, cuff = view === 'away' ? 0.6 : 0.7;
    const xc = jx + L * cuff;
    c.push({ op: 'ellipse', x: Math.round(jx - r0), y: Math.round(cy - r0), w: Math.round(2 * r0), h: Math.round(2 * r0), color: S[3] });
    c.push(...tube(jx, xc, cy, r0, rc, S));
    for (const t of [0.18, 0.38, 0.55]) {
      const x = jx + L * t, r = r0 + (rc - r0) * (t / cuff);
      c.push({ op: 'line', points: [[x + 5, cy - r * 0.6], [x - 3, cy], [x + 4, cy + r * 0.55]].map(R2), color: S[1] });
      c.push({ op: 'line', points: [[x + 6, cy - r * 0.6], [x - 2, cy], [x + 5, cy + r * 0.55]].map(R2), color: S[4] });
    }
    // rolled cuff
    c.push(...tube(xc - 2, xc + 0.08 * L, cy, rc + 3, rc + 2, S, [[-1, -0.7, 5], [-0.7, 0.3, 4], [0.3, 1, 2]]));
    c.push({ op: 'line', points: [[xc + 0.08 * L, cy - rc - 2], [xc + 0.08 * L, cy + rc + 2]].map(R2), color: S[1] });
    // glove gauntlet + strap
    const g0 = xc + 0.08 * L;
    c.push(...tube(g0, ex + 5, cy, rc + 1, r1 + 1, G, [[-1, -0.78, 4], [-0.78, 0.25, 3], [0.25, 0.7, 2], [0.7, 1, 1]]));
    c.push({ op: 'polygon', points: [[g0 + 5, cy - rc - 1], [g0 + 12, cy - rc - 1], [g0 + 12, cy + rc + 1], [g0 + 5, cy + rc + 1]].map(R2), color: PAL.plate[2] });
    c.push({ op: 'line', points: [[g0 + 5, cy - rc], [g0 + 12, cy - rc]].map(R2), color: PAL.plate[4] });
    c.push({ op: 'pixels', points: [R2([g0 + 8, cy - rc * 0.3])], color: PAL.plate[4] });
    if (view === 'away') c.push({ op: 'ellipse', x: Math.round(ex - r1 * 0.5), y: Math.round(cy - r1 - 1), w: Math.round(r1), h: Math.round(2 * r1 + 2), color: G[1] });
  }
  c.push({ op: 'outline', color: S[0], of: S, over_other: false }, { op: 'outline', color: G[0], of: [...G, ...PAL.plate], over_other: false });
  return c;
}

/** Hand poses -> finger curls (deg: base, middle per finger, index first), thumb [abduction, flex]. */
const CURL = (preset) => { const f = FINGERS[preset]; return { fingers: [f.index, f.group, f.group, f.group], thumb: [f.thumb[0], f.thumb[1]] }; };
const POSES = {
  trigger: { ...CURL('trigger'), trigger: true }, thumb_release: { ...CURL('trigger'), trigger: true, thumb: [68, 6] }, trigger_off: CURL('trigger_off'),
  support: CURL('support_under'), vgrip: CURL('vgrip'), agrip: CURL('agrip'), mag_pinch: { fingers: [[28, 26], [34, 30], [70, 80], [74, 84]], thumb: [42, 30], compact: true },
  open: CURL('open_palm'), relaxed: CURL('relaxed'), fist: CURL('fist'), grenade: CURL('grenade_hold'), pinch: { fingers: [[40, 46], [92, 100], [96, 102], [96, 104]], thumb: [20, 40], compact: true },
};

/**
 * Hand pose in the template layout (wrist left, fingers right, back of the hand toward you, thumb
 * up). -> {back, front, trigger}: commands for the layers behind / over the held object and the
 * finger that goes through the trigger guard.
 */
export function handCommands(pose, pts, s = 6) {
  const P = POSES[pose] || POSES.relaxed;
  const [wx, cy] = pts.wrist;
  const G = PAL.glove, K = PAL.plate;
  const knuck = wx + 9 * s - 1; // knuckle line at the end of the palm
  const back = [], front = [], trig = [], under = [];
  const hand = P.compact ? back : front;
  // back of the hand: tapered from the wrist, lit top edge, tendon seams, hard knuckle plate
  const hb = [[wx - 4, cy - 17], [wx + 14, cy - 23], [knuck - 6, cy - 25], [knuck + 2, cy - 22], [knuck + 3, cy + 19], [knuck - 6, cy + 24], [wx + 14, cy + 22], [wx - 4, cy + 16]];
  hand.push({ op: 'polygon', points: hb.map(R2), color: G[3] });
  hand.push({ op: 'polygon', points: [[wx - 4, cy - 17], [wx + 14, cy - 23], [knuck - 6, cy - 25], [knuck - 6, cy - 20], [wx + 14, cy - 18], [wx - 4, cy - 12]].map(R2), color: G[4] });
  hand.push({ op: 'polygon', points: [[wx - 4, cy + 10], [wx + 14, cy + 15], [knuck - 6, cy + 17], [knuck + 3, cy + 13], [knuck + 3, cy + 19], [knuck - 6, cy + 24], [wx + 14, cy + 22], [wx - 4, cy + 16]].map(R2), color: G[2] });
  for (const y of [-12, -3, 6, 14]) hand.push({ op: 'line', points: [[wx + 12, cy + y * 0.55], [knuck - 9, cy + y]].map(R2), color: G[2] });
  hand.push({ op: 'polygon', points: [[knuck - 14, cy - 22], [knuck - 3, cy - 21], [knuck - 1, cy + 17], [knuck - 13, cy + 18]].map(R2), color: K[2] });
  hand.push({ op: 'line', points: [[knuck - 13, cy - 21], [knuck - 4, cy - 20]].map(R2), color: K[4] });
  hand.push({ op: 'line', points: [[knuck - 13, cy - 20], [knuck - 12, cy + 17]].map(R2), color: K[3] });
  hand.push({ op: 'line', points: [[knuck - 2, cy - 19], [knuck - 1, cy + 16]].map(R2), color: K[1] });
  // cuff strap at the wrist
  hand.push({ op: 'polygon', points: [[wx - 6, cy - 16], [wx + 4, cy - 19], [wx + 4, cy + 18], [wx - 6, cy + 15]].map(R2), color: G[1] });
  hand.push({ op: 'line', points: [[wx - 5, cy - 15], [wx + 3, cy - 18]].map(R2), color: G[3] });
  hand.push({ op: 'pixels', points: [R2([wx, cy - 6]), R2([wx, cy + 6])], color: K[3] });
  // fingers: index (top, thumb side) .. little; segments proximal / middle / distal
  const ys = [-17, -6, 5, 15], ws = [10, 10, 9, 8], lens = [[26, 15, 11], [28, 17, 12], [26, 16, 11], [20, 13, 10]], x0s = [knuck, knuck + 1, knuck, knuck - 3];
  for (let i = 3; i >= 0; i--) {
    const [cb, cm] = P.fingers[i];
    const angs = [cb, cb + cm, cb + cm + cm * 0.75].map((a) => (a * Math.PI) / 180);
    let x = x0s[i], z = 0;
    const isTrig = P.trigger && i === 0;
    for (let k = 0; k < 3; k++) {
      const len = lens[i][k], a = angs[k], x1 = x + len * Math.cos(a), z1 = z + len * Math.sin(a);
      const w = ws[i] - k * 1.5, y = cy + ys[i];
      // depth past the held grip (about 1.6 cm toward the palm side) goes behind it
      // curled tips behind the palm go under the back of the hand
      const tgt = isTrig ? trig : P.compact ? (i < 2 && z <= 9 ? front : under) : z > 9 ? under : front;
      // a bent knuckle still shows its back from the eye: keep a short rounded stub
      let xa = Math.min(x, x1), xb = Math.max(x, x1);
      if (k === 0 && xb - xa < w * 0.8) xb = xa + w * 0.8;
      if (k > 0 && z <= 9 && xb - xa < w * 0.5) xb = xa + w * 0.5;
      const tone = z > 9 ? 1 : k === 0 ? 3 : 2;
      tgt.push({ op: 'polygon', points: [[xa, y - w / 2], [xb, y - w / 2 + (k ? 0.5 : 0)], [xb, y + w / 2 - (k ? 0.5 : 0)], [xa, y + w / 2]].map(R2), color: G[tone] });
      tgt.push({ op: 'ellipse', x: Math.round(Math.max(x1, xb) - w / 2), y: Math.round(y - w / 2), w: Math.round(w), h: Math.round(w), color: G[tone] });
      if (z <= 9) {
        tgt.push({ op: 'line', points: [[xa + 1, y - w / 2 + 1], [xb - 1, y - w / 2 + 1]].map(R2), color: G[tone + 1] });
        tgt.push({ op: 'line', points: [[xa + 1, y + w / 2 - 1], [xb - 1, y + w / 2 - 1]].map(R2), color: G[Math.max(0, tone - 1)] });
      }
      if (k === 0 && z <= 9) { // knuckle bump highlight
        tgt.push({ op: 'pixels', points: [R2([x + 1, y - 2]), R2([x + 2, y - 3]), R2([x + 1, y - 3])], color: G[5] });
      }
      if (k > 0 && Math.abs(x1 - x) > 3) tgt.push({ op: 'line', points: [[x, y - w / 2 + 2], [x, y + w / 2 - 2]].map(R2), color: G[1] }); // joint crease
      x = x1; z = z1;
    }
  }
  // thumb: from the base of the palm on the upper side, up and forward; flex foreshortens it
  const [abd, flex] = P.thumb;
  const ta = (-abd * Math.PI) / 180, l1 = 22, l2 = 17 * Math.cos((flex * Math.PI) / 360);
  const t0 = [wx + 12, cy - 18], t1 = [t0[0] + l1 * Math.cos(ta), t0[1] + l1 * Math.sin(ta)], tb = ta + (abd > 40 ? 0.5 : 0.25), t2 = [t1[0] + l2 * Math.cos(tb), t1[1] + l2 * Math.sin(tb)];
  const th = front;
  th.push({ op: 'line', points: [R2(t0), R2(t1)], color: G[3], width: 12, brush: 'round' });
  th.push({ op: 'line', points: [R2(t1), R2(t2)], color: G[3], width: 10, brush: 'round' });
  th.push({ op: 'line', points: [R2([t0[0] + 2, t0[1] - 4]), R2([t1[0] + 1, t1[1] - 4])], color: G[4] });
  th.push({ op: 'line', points: [R2([t1[0] + 1, t1[1] - 3]), R2([t2[0], t2[1] - 3])], color: G[4] });
  th.push({ op: 'pixels', points: [R2([t1[0], t1[1] - 4])], color: G[5] });
  th.push({ op: 'line', points: [R2([t1[0] - 2, t1[1] - 3]), R2([t1[0] + 1, t1[1] + 4])], color: G[1] });
  back.unshift(...under);
  const ol = (L) => { if (L.length) L.push({ op: 'outline', color: G[0], of: [...G, ...K], over_other: false }); };
  ol(back); ol(front); ol(trig);
  return { back, front, trigger: trig };
}

/**
 * Draw the whole demo set into an engine: SMG keys (hip, ads, reload) + magazine keys (+ the rifle
 * and its magazine with rifle:true) + the "ink" arms skin (upper side, fore side / away, hands).
 * Returns the canvas names.
 */
export function drawDemoSet(e, { gun = 'vandal', mag = 'vandal_mag', skin = 'ink', poses, views = ['hip', 'ads', 'reload'], arms = true, rifle = false } = {}) {
  const made = { gun: [], mag: [], arms: [] };
  const keys = (name, cls, magName, parts, magParts, fore, out) => {
    for (const view of views) {
      const t = e.run('fp_template', { kind: 'gun', name, class: cls, ...(typeof view === 'string' ? { view } : view), mag: magName, overwrite: true });
      drawGunKey(e, t.canvas, parts, fore);
      out.gun.push(t.canvas);
    }
    for (const view of ['hip', 'ads']) {
      const t = e.run('fp_template', { kind: 'mag', name: magName, class: cls, view, overwrite: true });
      drawMagKey(e, t.canvas, magParts);
      out.mag.push(t.canvas);
    }
  };
  keys(gun, 'smg', mag, smgParts(), smgMagParts(), -23, made);
  if (rifle) { made.rifle = { gun: [], mag: [] }; keys(typeof rifle === 'string' ? rifle : 'warden', 'rifle', 'warden_mag', rifleParts(), rifleMagParts(), -28.3, made.rifle); }
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
  for (const pose of poses || ['trigger', 'trigger_off', 'thumb_release', 'support', 'vgrip', 'agrip', 'mag_pinch', 'open', 'relaxed', 'fist', 'grenade', 'pinch']) {
    let t;
    try { t = e.run('fp_template', { kind: 'arm', name: skin, part: 'hand', pose, view: 'back', overwrite: true }); } catch { continue; }
    const c = handCommands(pose, t.points);
    const layers = new Set(e.get(t.canvas).layers.map((l) => l.name));
    for (const [layer, cmds] of [['back', c.back], ['front', c.front], ['trigger', c.trigger]]) {
      if (!cmds.length) continue;
      e.run('draw', { canvas: t.canvas, layer: layers.has(layer) ? layer : 'front', commands: cmds });
    }
    made.arms.push(t.canvas);
  }
  return made;
}
