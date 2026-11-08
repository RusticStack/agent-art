// More kit assemblies (see kitparts.js for the expansion rules): ship details (gun pod with a
// rotary barrel cluster, wing-root fairing, exposed hinge knuckles), walkable circulation (stairs
// within the player metrics), clutter (crate, barrel, stool, terminal) and the 1.8 m scale figure.
import { registerAssembly } from './assemblies.js';

const n = (v, d) => { const x = Number(v ?? d); if (!Number.isFinite(x)) throw new Error(`expected a number, got ${JSON.stringify(v)}`); return x; };
const tx = (p, k, d) => (p.textures && p.textures[k] !== undefined ? p.textures[k] : p[k] !== undefined ? p[k] : d);
const r3 = (v) => Math.round(v * 1000) / 1000;
const tint = (name, c) => (typeof c === 'string' && /^#[0-9a-fA-F]{6}$/.test(c) ? `kit_${name}_${c.slice(1).toLowerCase()}` : c ?? `kit_${name}`);

// ---------- ship details ----------
registerAssembly('gun_pod', (p, k) => {
  const L = n(p.len, 64), r = n(p.r, 7), nb = Math.max(3, Math.round(n(p.barrels, 6))), bl = n(p.barrel_len, L * 0.45);
  const T = tx(p, 'texture', 'kit_hull_dark'), dark = tx(p, 'dark', 'kit_metal_dark'), metal = tx(p, 'barrel', 'kit_metal');
  const B = k.node('barrels');
  const parts = [
    // pylon to the mount (+y), then the pod body along z, muzzle toward +z
    { type: 'box', w: r * 0.6, h: r * 0.9, d: L * 0.5, at: [0, -r * 0.9, -L * 0.05], bevel: 0.6, texture: dark },
    { type: 'hull', length: L, width: r * 2, height: r * 2, at: [0, -r * 0.9 - r, -L * 0.1], plan: [[0, r * 0.55], [0.2, r], [0.75, r], [1, r * 0.7]], profile: [[0, r * 0.55, -r * 0.55], [0.2, r, -r], [0.75, r, -r], [1, r * 0.7, -r * 0.7]], section: 2.2, rings: 6, segments: 10, panel_lines: { rings: [0.4, 0.62], seams: [0.25], width: 0.8, depth: 0.5 }, texture: T, groove: dark },
  ];
  const yc = -r * 0.9 - r, z0 = -L * 0.1 + L / 2;
  // ammo feed chute + vent slots
  parts.push({ type: 'tube', path: [[r * 0.8, yc + r * 0.3, z0 - L * 0.7], [r * 1.25, yc, z0 - L * 0.45], [r * 0.85, yc - r * 0.2, z0 - L * 0.2]], r: Math.max(0.6, r * 0.18), sides: 4, texture: dark });
  // rotary barrel cluster: hub, barrels round the axis, muzzle clamp ring
  parts.push({ type: 'cylinder', name: B ?? undefined, r: r * 0.55, h: bl * 0.18, segments: 10, rotate: [90, 0, 0], at: [0, yc, z0], texture: dark });
  const br = Math.max(0.5, r * 0.13);
  parts.push({ type: 'cylinder', ...(B ? { parent: B } : {}), r: br, h: bl, segments: 6, rotate: [90, 0, 0], at: [r3(r * 0.36), yc, z0], texture: metal, material: 'bare_metal', array: { count: nb, rotate: [0, 0, 360 / nb], about: [0, yc, 0] } });
  for (const f of [0.55, 0.92]) parts.push({ type: 'cylinder', ...(B ? { parent: B } : {}), r: r * 0.5, h: Math.max(0.8, bl * 0.05), segments: 10, rotate: [90, 0, 0], at: [0, yc, r3(z0 + bl * f)], texture: dark });
  const sockets = {}, clips = {};
  if (k.rig) {
    sockets[`${k.id}_muzzle`] = { at: [0, yc, z0 + bl], look: [0, 0, 1] };
    clips[`${k.id}_spin`] = { loop: true, duration: 0.24, keys: [{ t: 0, parts: {} }, { t: 0.08, parts: { [B]: { rot: [0, 120, 0] } } }, { t: 0.16, parts: { [B]: { rot: [0, 240, 0] } } }] };
  } else parts.push({ type: 'marker', kind: 'muzzle', at: [0, yc, r3(z0 + bl)], dir: [0, 0, 1], data: { socket: `${k.id}_muzzle` } });
  return { parts, sockets, clips };
}, 'len?:64,r?:7,barrels?:6,barrel_len? (gun pod under its mount (-y): pylon, lofted pod, ammo chute, rotary barrel cluster with clamp rings, muzzle toward +z; named: clip <name>_spin, socket <name>_muzzle)');

registerAssembly('fairing', (p) => {
  // a blended pod that hides a joint (wing root, pylon): flat bottom on the mount plane, rounded top
  const L = n(p.len, 96), w = n(p.w, 24), h = n(p.h, 10);
  return { parts: [{ type: 'hull', length: L, width: w, height: h, plan: [[0, w * 0.15], [0.3, w / 2], [0.75, w / 2], [1, w * 0.1]], profile: [[0, h * 0.3, 0], [0.35, h, 0], [0.8, h * 0.8, 0], [1, h * 0.15, 0]], section: { n: 2.4, n_bottom: 12 }, rings: n(p.rings, 8), segments: n(p.segments, 10), panel_lines: { rings: [0.5], width: 0.8, depth: 0.5 }, texture: tx(p, 'texture', 'kit_hull'), groove: tx(p, 'groove', 'kit_metal_dark'), material: 'painted_metal' }] };
}, 'len?:96,w?:24,h?:10 (wing-root / pylon fairing along z on the mount plane y = 0)');

registerAssembly('hinge', (p) => {
  // exposed knuckle joint along x: alternating knuckles, a through pin, end caps
  const L = n(p.len, 32), r = n(p.r, 3), c = Math.max(2, Math.round(n(p.count, 4))), T = tx(p, 'texture', 'kit_metal'), dark = tx(p, 'dark', 'kit_metal_dark');
  const parts = [{ type: 'cylinder', r: r * 0.45, h: L + r, segments: 8, rotate: [0, 0, 90], at: [r3((L + r) / 2), 0, 0], texture: dark, material: 'bare_metal' }];
  const kl = L / c;
  for (let i = 0; i < c; i++) parts.push({ type: 'cylinder', r: i % 2 ? r * 0.9 : r, h: kl * 0.9, segments: 8, rotate: [0, 0, 90], at: [r3(-L / 2 + kl * i + kl * 0.95), 0, 0], texture: i % 2 ? dark : T });
  return { parts };
}, 'len?:32,r?:3,count?:4 (exposed hinge knuckles along x with a through pin: wing folds, ramp / door hinges)');

// ---------- circulation ----------
registerAssembly('stair_run', (p) => {
  // straight run up along +z from y = 0 to y = h; risers <= 0.2 m, <= 38 deg (player metrics)
  const H = n(p.h, 100), w = n(p.w, 48), maxRise = n(p.max_rise, 6.4), going = n(p.going, 9.6);
  const steps = Math.max(1, Math.ceil(H / maxRise)), rise = H / steps, run = steps * going;
  const T = tx(p, 'texture', 'kit_deck'), rail = tx(p, 'rail', 'kit_hazard'), side = tx(p, 'side', 'kit_metal_dark');
  const parts = [];
  for (let i = 0; i < steps; i++) parts.push({ type: 'box', w, h: rise, d: going + 0.5, at: [0, r3(i * rise), r3(i * going + going / 2)], texture: T, faces: { front: 'kit_hazard' } });
  for (const s of [1, -1]) {
    parts.push({ type: 'beam', from: [s * (w / 2 + 1), 0, 0], to: [s * (w / 2 + 1), H, run], s: 2, texture: side });
    parts.push({ type: 'beam', from: [s * (w / 2 + 1), 32, 0], to: [s * (w / 2 + 1), H + 32, run], s: 1.4, texture: rail });
    for (const f of [0, 0.5, 1]) parts.push({ type: 'beam', from: [s * (w / 2 + 1), H * f, run * f], to: [s * (w / 2 + 1), H * f + 32, run * f], s: 1.2, texture: rail });
  }
  const ang = Math.atan2(H, run);
  parts.push({ type: 'marker', kind: 'walk', at: [0, r3(H / 2), r3(run / 2)], dir: [0, r3(Math.sin(ang)), r3(Math.cos(ang))], data: { w: w - 4, d: r3(Math.hypot(H, run)), kind: 'stairs', rise: r3(rise), room: p.room ?? 'stairs' } });
  return { parts };
}, 'h?:100 (rise),w?:48,max_rise?:6.4 (0.2 m),going?:9.6 (0.3 m tread) (straight stair run up along +z with stringers and handrails; walk marker kind stairs)');

// ---------- clutter ----------
registerAssembly('crate', (p) => {
  const s = n(p.size, 24), h = n(p.h, s * 0.8);
  return { parts: [{ type: 'box', w: s, h, d: s * 0.8, bevel: Math.min(1, s * 0.04), texture: tint('crate', p.color), material: 'painted_metal', rotate: [0, n(p.yaw, (Number(p.seed ?? 1) * 37) % 20 - 10), 0] }] };
}, 'size?:24,h?,color?,yaw? (supply crate, kit_crate texture tinted)');
registerAssembly('barrel', (p) => {
  const s = n(p.size, 18);
  return { parts: [{ type: 'cylinder', r: s / 2, h: s * 1.4, segments: 10, texture: tint('barrel', p.color), top: 'kit_metal_dark', bottom: 'kit_metal_dark', material: 'painted_metal' }] };
}, 'size?:18 (diameter; 1.4x tall),color? (drum with hoops and a hazard label)');
registerAssembly('stool', (p) => ({ parts: [
  { type: 'cylinder', r: 1.2, h: 20, segments: 6, texture: 'kit_metal' },
  { type: 'cylinder', r: 7, h: 2.5, segments: 10, at: [0, 20, 0], texture: tx(p, 'pad', '#4a3a30') },
  { type: 'cylinder', r: 6, h: 1, segments: 8, texture: 'kit_metal_dark' },
] }), 'bar stool (0.7 m)');
registerAssembly('chair', (p) => ({ parts: [
  { type: 'box', w: 16, h: 2, d: 16, at: [0, 14, 0], texture: tx(p, 'pad', '#3a4a5a') },
  { type: 'box', w: 16, h: 18, d: 2, at: [0, 16, -7], texture: tx(p, 'pad', '#3a4a5a') },
  ...[[1, 1], [1, -1], [-1, 1], [-1, -1]].map(([x, z]) => ({ type: 'beam', from: [x * 7, 0, z * 7], to: [x * 7, 14, z * 7], s: 1.2, texture: 'kit_metal' })),
] }), 'chair facing +z');
registerAssembly('terminal', (p, k) => {
  const small = !!p.small, w = small ? 14 : 24, h = small ? 10 : 44;
  const parts = small ? [] : [{ type: 'box', w: w * 0.7, h: h - 14, d: 10, texture: 'kit_metal_dark', bevel: 1 }];
  parts.push({ type: 'box', w, h: small ? 10 : 16, d: 4, at: [0, small ? 0 : h - 14, 0], rotate: [-12, 0, 0], texture: 'kit_metal_dark', faces: { front: p.screen ?? 'kit_screen' }, material: { preset: 'emissive_panel' } });
  parts.push({ type: 'light', at: [0, (small ? 6 : h - 6), 6], color: p.glow ?? '#40ffb0', intensity: 0.25, range: 40, bulb: false });
  parts.push({ type: 'marker', kind: 'screen', at: [0, small ? 5 : h - 6, 2.2], dir: [0, 0.2, 0.98], data: { screen: `${k.id}_screen`, w, h: small ? 10 : 16, ui: true } });
  return { parts };
}, 'small?:false (counter top) | floor kiosk; screen?:<UI canvas> (kit_screen); screen marker');

// ---------- scale figure ----------
registerAssembly('figure', (p) => {
  // 1.8 m human silhouette (px at 32 px / m) for scale shots; pose: stand | seated
  const H = n(p.h, 57.6), k = H / 57.6, c = tx(p, 'color', '#d0d4d8'), dark = '#3a3e45';
  const seated = p.pose === 'seated';
  const B = (w, h, d, at, col = c) => ({ type: 'box', w: r3(w * k), h: r3(h * k), d: r3(d * k), at: at.map((v) => r3(v * k)), color: col, bevel: r3(0.6 * k) });
  const parts = seated
    ? [B(10, 4, 16, [0, 14, 2], dark), B(9, 14, 4, [0, 0, 9], dark), B(12, 20, 7, [0, 17, -2]), B(7, 8, 7, [0, 37, -2]), B(3.4, 15, 3.4, [7.5, 22, 2]), B(3.4, 15, 3.4, [-7.5, 22, 2])]
    : [B(4.2, 26, 4.2, [3, 0, 0], dark), B(4.2, 26, 4.2, [-3, 0, 0], dark), B(12, 5, 6, [0, 26, 0], dark), B(13, 16, 7, [0, 31, 0]), B(3.4, 21, 3.4, [8.2, 26, 0]), B(3.4, 21, 3.4, [-8.2, 26, 0]), B(7, 9, 7.5, [0, 48.6, 0]), B(5, 2.5, 1, [0, 52, 3.8], '#7fd8ff')];
  return { parts };
}, 'h?:57.6 (1.8 m at 32 px/m),pose?:stand|seated,color? (scale figure for renders)');

// ---------- hero-ship capabilities: glazing, ring airlock, cockpit seat, screen arms, wall modules, portal arches ----------
const HULL_KEYS = ['length', 'width', 'height', 'plan', 'profile', 'sections', 'section', 'interp', 'rings', 'segments', 'crease', 'at', 'rotate'];
/** u range helper: [u0, u1] with wrap (u0 > u1 runs through the top centre) -> list of k + 1 values. */
const uSteps = (u0, u1, k) => { const span = u1 >= u0 ? u1 - u0 : u1 + 1 - u0; return [...Array(k + 1).keys()].map((i) => (u0 + (span * i) / k) % 1); };
registerAssembly('glazing', (p, k) => {
  // multi-pane glazing set into a hull opening: glass panes follow the hull surface `inset` px
  // inside the armour, heavy mullions (square tubes) on the pane grid and a thicker outer frame
  const H = k.hullOf(p.hull), S = k.surface(H), off = (H.at || [0, 0, 0]).map(Number);
  const [t0, t1] = p.t.map(Number), [u0, u1] = p.u.map(Number);
  const cols = Math.max(1, Math.round(n(p.cols, 4))), rows = Math.max(1, Math.round(n(p.rows, 2))), inset = n(p.inset, 3), mull = n(p.mullion, 5), frameW = n(p.frame, mull * 1.6);
  const glassT = tx(p, 'glass', 'kit_glass'), frameT = tx(p, 'frame', 'kit_metal_dark');
  const geo = Object.fromEntries(HULL_KEYS.filter((key) => H[key] !== undefined).map((key) => [key, H[key]]));
  const parts = [{ type: 'hull', ...geo, patch: { t: [t0, t1], u: [u0, u1] }, inset, texture: glassT, glass: { opacity: n(p.opacity, 0.24) }, double_sided: true, caps: false }];
  const at = (t, u, lift) => { const q = S.point(t, u), nn = S.normal(t, u); return [r3(q[0] + nn[0] * lift + off[0]), r3(q[1] + nn[1] * lift + off[1]), r3(q[2] + nn[2] * lift + off[2])]; };
  const lift = (1 - inset) / 2, rr = (w) => r3(Math.max(w / 2, (inset + 1) / 2));
  const us = uSteps(u0, u1, cols), N = 10;
  us.forEach((u, i) => { const edge = i === 0 || i === cols; parts.push({ type: 'tube', path: [...Array(N + 1).keys()].map((j) => at(t0 + ((t1 - t0) * j) / N, u, lift)), r: rr(edge ? frameW : mull), sides: 4, caps: true, texture: frameT }); });
  for (let r = 0; r <= rows; r++) { const t = t0 + ((t1 - t0) * r) / rows, edge = r === 0 || r === rows; parts.push({ type: 'tube', path: uSteps(u0, u1, cols * 4).map((u) => at(t, u, lift)), r: rr(edge ? frameW : mull), sides: 4, caps: true, texture: frameT }); }
  return { parts };
}, 'hull:<hull id>, t:[t0,t1], u:[u0,u1] (same as the hull opening it fills), cols?:4, rows?:2, inset?:3 px, mullion?:5 px, frame?:8 px, opacity?:0.32, textures:{glass, frame} (glass panes set into the armour + heavy mullion grid)');

registerAssembly('ring_door', (p, k) => {
  // circular airlock door in the local xz plane facing +y (local +x = up: rotate:[0,0,90] mounts it on a -x wall)
  const R = n(p.r, 38), T = tx(p, 'texture', 'kit_hull_dark'), dark = tx(p, 'dark', 'kit_metal_dark'), lit = p.glow ?? '#60c8ff';
  const ring = (rad, y, segs = 24) => [...Array(segs + 1).keys()].map((i) => { const a = (2 * Math.PI * i) / segs; return [r3(Math.cos(a) * rad), y, r3(Math.sin(a) * rad)]; });
  const N = k.node(), open = k.rig ? 0 : Math.max(0, Math.min(1, n(p.open, 0))), ang = n(p.open_angle, 105);
  const hz = -(R + 6);
  // static open: the leaf swings out about the hinge line (x axis through z = hz, y = 0)
  const leaf = (q) => (N ? { ...q, parent: N } : { ...q, ...(open ? { pivot: [-(q.at?.[0] ?? 0), -(q.at?.[1] ?? 0), hz - (q.at?.[2] ?? 0)], rotate: [-ang * open, 0, 0] } : {}) });
  const Q = R + 7;
  const parts = [];
  for (const [sx, sz] of [[1, 1], [-1, 1], [-1, -1], [1, -1]]) {
    const arc = [...Array(7).keys()].map((i) => { const a = (Math.PI / 2) * (i / 6); return [r3(sx * Math.cos(a) * (R + 1)), r3(sz * Math.sin(a) * (R + 1))]; });
    const pts = [[sx * Q, 0], [sx * Q, sz * Q], [0, sz * Q], ...arc.slice().reverse()];
    const area = pts.reduce((s, q, i) => { const w = pts[(i + 1) % pts.length]; return s + q[0] * w[1] - w[0] * q[1]; }, 0);
    parts.push({ type: 'shape', points: area < 0 ? pts.slice().reverse() : pts, d: 2, plane: 'xz', at: [0, -1, 0], texture: dark });
  }
  parts.push({ type: 'tube', path: ring(R + 3, 1.5), r: 3, sides: 6, caps: false, texture: T });
  parts.push({ type: 'tube', path: ring(R + 0.5, 1.2), r: 0.9, sides: 4, caps: false, color: lit, material: { preset: 'emissive_panel' } });
  parts.push(N ? { type: 'cylinder', name: N, r: R - 0.5, h: 2.5, segments: 24, at: [0, -2, 0], pivot: [0, 2, hz], texture: T } : leaf({ type: 'cylinder', r: R - 0.5, h: 2.5, segments: 24, at: [0, -2, 0], texture: T }));
  for (const [f, rr2] of [[0.82, 1.4], [0.58, 1.1], [0.34, 0.9]]) parts.push(leaf({ type: 'tube', path: ring(R * f, 0.9), r: rr2, sides: 4, caps: false, texture: dark }));
  parts.push(leaf({ type: 'cylinder', r: R * 0.16, h: 2.4, segments: 12, at: [0, 0.4, 0], texture: 'kit_metal' }));
  for (let i = 0; i < 3; i++) parts.push(leaf({ type: 'box', w: R * 0.9, h: 1.2, d: 2.4, at: [0, 0.4, 0], rotate: [0, i * 60, 0], texture: 'kit_hazard' }));
  parts.push({ type: 'hinge', len: 14, r: 2.4, count: 3, at: [0, 2, hz] });
  const clips = N ? { [p.clip ?? `${k.id}_open`]: { keys: [{ t: 0, parts: {} }, { t: n(p.duration, 1.6), parts: { [N]: { rot: [-ang, 0, 0] } }, ease: 'smooth' }] } } : {};
  parts.push({ type: 'light', at: [R + 9, 3, 0], color: lit, intensity: 0.5, range: 70, bulb: 1.2 });
  parts.push({ type: 'marker', kind: 'door', at: [-R + 2, 0, 0], dir: [0, 1, 0], data: { door: k.id, style: 'ring', w: r3(R * 1.6), h: r3(R * 2 - 4) } });
  parts.push({ type: 'marker', kind: 'trigger', at: [0, 0, 0], dir: [0, 1, 0], data: { trigger: 'door', id: k.id, w: R * 2, h: R * 2, d: 64 } });
  return { parts, clips };
}, 'r?:38 (opening radius px: 2.4 m door),open?:0..1 (static),open_angle?:105,glow? (round airlock door in the local xz plane facing +y, local +x = up: square adapter plate with a round cut, collar, lit ring, leaf with concentric rings, hub + locking bars, exposed hinge; named: clip <name>_open; door marker + trigger)');

registerAssembly('screen_arm', (p, k) => {
  // articulated monitor arm from a wall / seat mount: base knuckle, two links, screen with an emissive UI face
  const reach = n(p.reach, 18), sw = n(p.w, 14), sh = n(p.h, 10), a1 = n(p.angle, 35) * (Math.PI / 180), T = tx(p, 'texture', 'kit_metal_dark');
  const j1 = [0, 0, 0], j2 = [r3(Math.sin(a1) * reach * 0.5), r3(reach * 0.25), r3(Math.cos(a1) * reach * 0.5)], j3 = [r3(j2[0] * 0.4), r3(j2[1] + reach * 0.15), r3(j2[2] + reach * 0.5)];
  const parts = [
    { type: 'cylinder', r: 1.6, h: 3, segments: 8, at: [0, -1.5, 0], texture: T },
    { type: 'beam', from: j1, to: j2, s: 1.4, texture: 'kit_metal' },
    { type: 'cylinder', r: 1.3, h: 2.4, segments: 8, at: [j2[0], j2[1] - 1.2, j2[2]], texture: T },
    { type: 'beam', from: j2, to: j3, s: 1.2, texture: 'kit_metal' },
    { type: 'box', w: sw, h: sh, d: 1.6, at: [j3[0], j3[1] - sh / 2, j3[2] + 0.8], rotate: [n(p.tilt, -10), n(p.yaw, 0), 0], texture: T, faces: { back: tx(p, 'screen', 'kit_screen') }, material: { preset: 'emissive_panel' } },
    { type: 'marker', kind: 'screen', at: [j3[0], j3[1], j3[2]], dir: [0, 0, -1], data: { screen: `${k.id}_screen`, w: sw, h: sh, ui: true } },
  ];
  return { parts };
}, 'reach?:18,w?:14,h?:10,angle?:35,tilt?:-10,yaw?,textures:{texture,screen} (articulated screen arm; the screen faces -z toward the user; screen marker)');

registerAssembly('pilot_seat', (p, k) => {
  // flight seat facing +z: pedestal, perforated leather cushions, armrest control pods with joysticks, screen arms both sides
  const L = tx(p, 'leather', 'kit_leather'), T = tx(p, 'texture', 'kit_metal_dark'), rub = 'kit_rubber';
  const parts = [
    { type: 'marker', kind: 'seat', at: [0, 0, 0], dir: [0, 0, 1], data: { seat: p.id ?? 'pilot' } },
    { type: 'box', w: 14, h: 10, d: 16, at: [0, 0, -2], texture: T, bevel: 1 },
    { type: 'box', w: 20, h: 5, d: 19, at: [0, 10, 0], texture: L, bevel: 1.5 },
    { type: 'box', w: 20, h: 30, d: 5, at: [0, 14, -10], rotate: [-12, 0, 0], texture: L, bevel: 1.5 },
    { type: 'box', w: 22, h: 30, d: 3, at: [0, 13, -13], rotate: [-12, 0, 0], texture: T, bevel: 1 },
    { type: 'box', w: 12, h: 8, d: 5, at: [0, 44, -17], rotate: [-12, 0, 0], texture: L, bevel: 1.2 },
  ];
  for (const s of [1, -1]) {
    parts.push({ type: 'box', w: 6, h: 3, d: 18, at: [s * 13, 20, 1], texture: rub, bevel: 0.8 });
    parts.push({ type: 'box', w: 7, h: 4, d: 8, at: [s * 13, 23, 6], texture: T, faces: { top: 'kit_screen' }, bevel: 0.6 });
    parts.push({ type: 'cylinder', r: 0.9, h: 6, segments: 6, at: [s * 13, 27, 7], rotate: [12, 0, 0], texture: rub });
    parts.push({ type: 'box', w: 2.6, h: 3.4, d: 2.6, at: [s * 13, 32.5, 8.2], texture: rub, bevel: 0.5 });
    parts.push({ type: 'box', w: 3, h: 12, d: 3, at: [s * 13, 8, 1], texture: T });
    parts.push({ type: 'screen_arm', at: [s * 18, 28, -4], reach: 16, w: 12, h: 9, angle: s * 30, yaw: s * -18, id: `${k.id}_arm_${s > 0 ? 'l' : 'r'}` });
  }
  return { parts };
}, 'pilot seat facing +z (player-sized): pedestal, perforated leather (kit_leather), armrest pods with joysticks and lit button tops, articulated screen arms both sides; seat marker');

const MODULE_LABEL = { weapon_rack: 'WEAPON RACK', storage: 'PERSONAL STORAGE', component: 'COMPONENT BAY' };
registerAssembly('locker_wall', (p, k) => {
  // wall module facing +z (back on z = 0): framed recess with weapon slots / locker doors / labelled covers, lit header
  const kind = p.kind ?? 'storage';
  if (!MODULE_LABEL[kind]) throw new Error('locker_wall kind must be weapon_rack|storage|component');
  const w = n(p.w, 64), h = n(p.h, 72), d = n(p.d, 10), T = tx(p, 'texture', 'kit_panel_light'), dark = tx(p, 'dark', 'kit_metal_dark'), lit = p.glow ?? '#60c8ff';
  const y0 = n(p.y, 4);
  const parts = [
    { type: 'box', w, h, d, at: [0, y0, 0], texture: T, insets: [{ face: 'front', rect: [3, 9, w - 6, h - 12], depth: d - 2, texture: dark, side: 'kit_metal' }] },
    { type: 'box', w: w - 8, h: 3, d: 0.6, at: [0, y0 + h - 7, d / 2 + 0.3], color: lit, material: { preset: 'emissive_panel' } },
    { type: 'decal', text: p.label ?? MODULE_LABEL[kind], px: 0.45, color: '#1c1e22', at: [0, y0 + h - 3.4, d / 2 + 0.25] },
  ];
  const iw = w - 6, ih = h - 12, zb = -d / 2 + 2.2;
  if (kind === 'weapon_rack') {
    const slots = Math.max(1, Math.round(n(p.slots, Math.floor(iw / 12))));
    for (let i = 0; i < slots; i++) {
      const x = -iw / 2 + (iw * (i + 0.5)) / slots;
      if (i < slots - 1) parts.push({ type: 'box', w: 1, h: ih - 4, d: d - 3, at: [r3(x + iw / slots / 2), y0 + 5, zb + (d - 3) / 2], color: '#2a2c30' });
      parts.push({ type: 'box', w: 3.4, h: 22, d: 3, at: [r3(x), y0 + 26, zb + 2], texture: 'kit_metal_dark' }, { type: 'box', w: 2.6, h: 12, d: 2.6, at: [r3(x), y0 + 14, zb + 2.2], texture: 'kit_rubber' }, { type: 'cylinder', r: 0.7, h: 14, segments: 6, at: [r3(x), y0 + 48, zb + 3], texture: 'kit_metal' });
      parts.push({ type: 'box', w: 1.6, h: 1.2, d: 0.4, at: [r3(x), y0 + ih + 2, d / 2 - 1], color: i % 3 ? '#40ff70' : '#ffb040', material: { preset: 'emissive_panel' } });
    }
  } else if (kind === 'storage') {
    const cols = Math.max(1, Math.round(n(p.cols, Math.floor(iw / 20))));
    for (let i = 0; i < cols; i++) {
      const x = -iw / 2 + (iw * (i + 0.5)) / cols, dw = iw / cols - 1.6;
      parts.push({ type: 'box', w: r3(dw), h: ih - 2, d: 1.4, at: [r3(x), y0 + 10, d / 2 - 3], texture: T, insets: [{ face: 'front', rect: [2, 4, dw - 4, ih * 0.3], depth: 0.4 }] });
      parts.push({ type: 'box', w: 1.2, h: 8, d: 1.2, at: [r3(x + dw / 2 - 3), y0 + 10 + ih * 0.45, d / 2 - 1.2], texture: 'kit_rubber' });
      parts.push({ type: 'decal', text: String(i + 1).padStart(2, '0'), px: 0.4, color: '#2a2c30', at: [r3(x), y0 + 10 + ih - 6, d / 2 - 1.5] });
    }
  } else {
    const names = p.covers ?? ['PWR', 'COOL', 'SHLD', 'QDRV', 'AUX', 'LIFE'];
    const cols = 2, rows = Math.ceil(names.length / cols);
    names.forEach((nm, i) => {
      const c = i % cols, r = Math.floor(i / cols), cw = iw / cols - 2, ch = ih / rows - 2;
      const x = -iw / 2 + (iw * (c + 0.5)) / cols, y = y0 + 9 + (ih * (rows - r - 0.5)) / rows;
      parts.push({ type: 'box', w: r3(cw), h: r3(ch), d: 1.4, at: [r3(x), r3(y - ch / 2), d / 2 - 3], texture: 'kit_metal', insets: [{ face: 'front', rect: [1.5, 1.5, cw - 3, ch - 3], depth: 0.3 }] });
      parts.push({ type: 'decal', text: nm, px: 0.45, color: '#e8e4d8', bg: '#2a2c30', at: [r3(x), r3(y + ch / 2 - 4), d / 2 - 1.45] });
      parts.push({ type: 'decal', kind: 'stripes', len: 12, px: 0.5, color: '#d0a020', at: [r3(x), r3(y - ch / 2 + 2.5), d / 2 - 1.45] });
    });
  }
  parts.push({ type: 'light', at: [0, y0 + h - 5, d / 2 + 3], color: lit, intensity: 0.35, range: 60, bulb: false });
  return { parts };
}, 'kind:weapon_rack|storage|component, w?:64, h?:72, d?:10, y?:4, label?, slots? (weapon_rack), cols? (storage), covers?:[names] (component), glow? (wall module centred on z = 0 facing +z: framed recess, gun slots with status lights / numbered locker doors / labelled covers, lit header + label decal)');

registerAssembly('portal_arch', (p) => {
  // chamfered octagonal bulkhead portal round a corridor (plane xy, centred on x, floor at y = 0)
  const wi = n(p.w, 72), hi = n(p.h, 84), ci = n(p.chamfer, 16), fw = n(p.frame, 8), d = n(p.d, 8), T = tx(p, 'texture', 'kit_panel_light'), dark = tx(p, 'dark', 'kit_metal_dark');
  // chamfered at the head only: the jambs run straight down to the floor (nothing to trip over)
  const oct = (w, h, c) => [[-w / 2, 0], [w / 2, 0], [w / 2, 0], [w / 2, h - c], [w / 2 - c, h], [-w / 2 + c, h], [-w / 2, h - c], [-w / 2, 0]];
  const I = oct(wi, hi, ci), O = oct(wi + 2 * fw, hi + fw, ci + fw * 0.6);
  O[0][1] = O[1][1] = O[2][1] = O[7][1] = 0;
  const parts = [];
  for (let e = 1; e < 8; e++) { // the floor edge (e = 0) stays open
    if (e === 7 || e === 1) continue; // no bottom chamfers
    if (false) {
      const a = I[e], b = I[(e + 1) % 8], A = O[e], B = O[(e + 1) % 8];
      const pts = [a, b, B, A].map((q) => q.map(r3));
      const area = pts.reduce((s, q, i) => { const w = pts[(i + 1) % 4]; return s + q[0] * w[1] - w[0] * q[1]; }, 0);
      parts.push({ type: 'shape', points: area < 0 ? pts.reverse() : pts, d, plane: 'xy', texture: dark });
      continue;
    }
    const a = I[e], b = I[(e + 1) % 8], A = O[e], B = O[(e + 1) % 8];
    const pts = [a, b, B, A].map((q) => q.map(r3));
    const area = pts.reduce((s, q, i) => { const w = pts[(i + 1) % 4]; return s + q[0] * w[1] - w[0] * q[1]; }, 0);
    parts.push({ type: 'shape', points: area < 0 ? pts.reverse() : pts, d, plane: 'xy', texture: T });
  }
  parts.push({ type: 'box', w: wi - 2 * ci, h: 1.4, d: d + 1, at: [0, hi - 1.4, 0], color: p.glow ?? '#60c8ff', material: { preset: 'emissive_panel' } });
  for (const s of [1, -1]) parts.push({ type: 'box', w: 1, h: Math.min(40, hi - ci), d: d + 0.6, at: [s * (wi / 2 + 0.2), 0, 0], texture: 'kit_hazard' });
  return { parts };
}, 'w?:72,h?:84 (clear opening, >= 1.4 x 2.3 m),chamfer?:16,frame?:8,d?:8 (chamfered octagonal bulkhead portal, open at the floor, light bar on the head, hazard jambs)');
