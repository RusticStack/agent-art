// Hero ship template (art_model create {template:"gunship"}): an ORIGINAL small multi-crew VTOL
// gunship at true scale (32 px = 1 m, 25 m long), exterior and walkable interior in ONE model.
// Brand and names are original to this universe: maker "ORVANE", class "TERN", serial OV-TN-####.
//
// Exterior, big masses first: a faceted chined fuselage wedge (linear loft of polygon sections:
// flat upper deck stepping down to a wrap canopy and a blunt armoured nose), a raised dorsal spine,
// side sponsons that carry thick armoured wing pylons (truss keels underneath), a heavy chin block;
// then medium forms: faceted VTOL nacelles (intake lip, hazard band, exhaust bell, blue glow ring),
// gun pods, missile rails, deep intakes, the round airlock + boarding ladder, chunky gear; then
// separate bevelled armour slabs with shadow gaps (worn edges), vents and greebles only in the
// recessed chine channel. Livery: two-tone (light deck, gunmetal sides, dark belly) + one yellow
// accent block, stencils, serials, logotype, chevrons.
// Interior (player metrics, walk_check clean): corridor with chamfered octagonal portal arches,
// grating floor with blue edge strips, wall modules (weapon rack, personal storage, component bay),
// terminals on arms, the airlock vestibule with a door panel, a cargo hold, and the cockpit with a
// pilot seat looking out through the mullioned glazing.
import { hullSurface } from './hull.js';
import { bulkhead, walkMarker, deckHalfWidth } from './walk.js';
import { mulberry32 } from './util.js';

const r2 = (v) => Math.round(v * 100) / 100;
const lerp = (a, b, t) => a + (b - a) * t;

/** u on the -x side (0.5 .. 1) of station t whose point has local height y (nearest). */
const uAtY = (S, t, y, side = -1) => {
  let best = side < 0 ? 0.75 : 0.25, bd = Infinity;
  const [a, b] = side < 0 ? [0.5, 1] : [0, 0.5];
  for (let i = 0; i <= 200; i++) { const u = a + ((b - a) * i) / 200, p = S.point(t, u); if (Math.sign(p[0]) !== side) continue; const d = Math.abs(p[1] - y); if (d < bd) { bd = d; best = u; } }
  return best;
};

export function gunshipTemplate(o = {}) {
  const rnd = mulberry32((Number(o.seed ?? 1) * 2654435761) >>> 0 || 1);
  const rig = o.rigged !== false;
  const serial = o.serial ?? `OV-TN-${String(Math.floor(rnd() * 9000) + 1000)}`;
  const accent = o.accent ?? '#d0a020', hullC = o.color ?? '#454b54', glowC = o.glow ?? '#4cc8ff';
  const hx = (c) => c.slice(1).toLowerCase();
  const HULL = `kit_armor_${hx(hullC)}`, HULL2 = 'kit_hull_dark', ACC = `kit_accent_${hx(accent)}`, DARK = 'kit_metal_dark', MET = 'kit_metal';
  // two-tone livery: light upper deck / spine / sponson tops, gunmetal sides, dark underbelly
  const topC = o.color2 ?? '#6a7078', TOP = `kit_armor_${hx(topC)}`, BELLY = 'kit_armor_2c3036';
  const SLAB_TOP = `kit_slab_${hx(topC)}`, SLAB_SIDE = `kit_slab_${hx(hullC)}`, SLAB_DARK = 'kit_slab_30343a', SLAB_ACC = `kit_slab_${hx(accent)}`;
  const L = 800, clear = 48, Y = (yl) => clear + yl; // local hull height -> world
  const floorL = 30, FY = Y(floorL), CH = 88; // corridor floor (world) and clear height (2.75 m)
  const zt = (t) => r2((t - 0.5) * L);
  const P = rig ? { parent: 'hull' } : {};
  const named = (n) => (rig ? { name: n } : {});
  // ---------- primary mass: a faceted, chined fuselage wedge (linear loft of polygon sections) ----------
  // Main section: flat upper deck, shoulder bevel, tumblehome upper side, hard chine, vertical side,
  // lower bevel, flat belly. Nose section: narrower deck, deeper shoulder, keel-ish chin.
  const mir = (h) => [...h, ...h.slice(1).reverse().map(([x, y]) => [-x, y])];
  const MAIN = { points: mir([[0, 1], [0.6, 1], [0.84, 0.72], [1, 0.3], [1, -0.6], [0.78, -0.86], [0.55, -1]]), chamfer: 0.02 };
  const NOSE = { points: mir([[0, 1], [0.42, 1], [0.8, 0.52], [1, 0.05], [0.9, -0.45], [0.55, -1]]), chamfer: 0.02 };
  // facet u ranges of MAIN on the +x side (polygon corners): deck | shoulder | upper side | side | lower side | belly
  const FU = { deck: [0, 0.0863], shoulder: [0.0863, 0.1393], upper: [0.1393, 0.2039], side: [0.2039, 0.3333], lower: [0.3333, 0.3822] };
  const body = {
    type: 'hull', id: 'body', ...named('hull'), length: L, width: 224, height: 164, at: [0, clear, 0], interp: 'linear',
    plan: [[0, 92], [0.06, 108], [0.12, 112], [0.6, 112], [0.7, 108], [0.8, 96], [0.9, 72], [0.97, 44], [1, 30]],
    // flat upper deck, a hard step down at t 0.6, the second deck, then the canopy slope into a blunt armoured nose
    profile: [[0, 132, 26], [0.05, 158, 6], [0.1, 164, 0], [0.6, 164, 0], [0.63, 146, 0], [0.76, 146, 0], [0.86, 118, 8], [0.95, 84, 24], [1, 66, 40]],
    sections: [[0, MAIN], [0.7, MAIN], [0.88, NOSE]],
    rings: 14, segments: 16, crease: 20, shell: 6, inner: 'kit_metal_dark', rim: DARK,
    panel_lines: { rings: [0.1, 0.6, 0.76], seams: [FU.side[1]], width: 2.4, depth: 2 },
    plates: [
      // two-tone paint blocks: light upper deck + shoulders, gunmetal sides, dark underbelly
      { t: [0.02, 0.99], u: [1 - FU.shoulder[1], FU.shoulder[1]], lift: 0.6, texture: TOP, mirror: false },
      { t: [0.02, 0.99], u: [FU.side[1], 1 - FU.side[1]], lift: 0.6, texture: BELLY, mirror: false },
    ],
    texture: HULL, groove: DARK, plate_texture: HULL2, material: 'painted_metal',
    openings: [],
  };
  const S = hullSurface(body);
  // armour slabs: separate bevelled boxes with real thickness on the flat facets, shadow gaps between
  // them, an optional smaller second layer; fitted kit_slab texture = worn bare-metal edges
  const slab = (hid, Sh, t0, t1, ua, ub, { h = 4, m = 3, tex = SLAB_SIDE, stack = 0, mirror = true, parent = P } = {}) => {
    const tc = (t0 + t1) / 2, uc = (ua + ub) / 2, pa = Sh.point(tc, ua), pb = Sh.point(tc, ub);
    const w = r2(Math.hypot(pa[0] - pb[0], pa[1] - pb[1], pa[2] - pb[2]) - 2 * m), d = r2(Math.abs(Sh.z(t1) - Sh.z(t0)) - 2 * m);
    if (w < 6 || d < 6) return;
    const q = { type: 'box', w, h, d, bevel: r2(Math.min(1.8, h * 0.42)), tile: false, texture: tex, material: 'painted_metal', ...parent };
    parts.push({ ...q, on_hull: { hull: hid, t: tc, u: uc, lift: -0.6, mirror } });
    if (stack) parts.push({ ...q, w: r2(w * 0.72), d: r2(d * 0.8), h: stack, bevel: r2(Math.min(1.4, stack * 0.42)), on_hull: { hull: hid, t: tc, u: uc, lift: h - 0.8, mirror } });
  };
  // openings: cockpit wrap canopy (deck + shoulders + upper sides of the nose) and the round airlock on -x
  const glz = { t: [0.79, 0.945], u: [0.8, 0.2] };
  const zDoor = -40, tDoor = 0.5 + zDoor / L, R = 36, doorC = floorL + R + 2; // door centre (local y)
  const tD = [0.5 + (zDoor - R - 8) / L, 0.5 + (zDoor + R + 8) / L];
  const uD = [uAtY(S, tDoor, doorC + R + 8), uAtY(S, tDoor, doorC - R - 8)].sort((a, b) => a - b);
  body.openings = [{ ...glz, id: 'glazing' }, { t: tD, u: uD, id: 'airlock' }];
  const parts = [body];
  const Sx = (t, yl) => S.halfWidthAt(t, yl); // outer half width at local height
  // body slabs (t ranges avoid the sponsons, the airlock band t 0.39..0.51 and the canopy)
  for (const [a, b] of [[0.12, 0.24], [0.25, 0.37], [0.48, 0.6]]) slab('body', S, a, b, 0.052, FU.deck[1], { tex: SLAB_TOP, h: 3 });
  for (const [a, b] of [[0.11, 0.25], [0.64, 0.76]]) slab('body', S, a, b, ...FU.shoulder, { tex: SLAB_TOP, h: 3.5 });
  for (const [a, b] of [[0.07, 0.2], [0.64, 0.76]]) slab('body', S, a, b, ...FU.upper, { h: 4 });
  for (const [a, b, st] of [[0.06, 0.2, 3], [0.21, 0.35, 3], [0.52, 0.63, 3], [0.64, 0.75, 0]]) slab('body', S, a, b, ...FU.side, { h: 5, stack: st });
  slab('body', S, 0.38, 0.5, ...FU.side, { h: 5, stack: 3, tex: SLAB_ACC, mirror: false }); // the one accent block (+x side; the airlock is on -x)
  for (const [a, b] of [[0.1, 0.37], [0.52, 0.74]]) slab('body', S, a, b, ...FU.lower, { h: 4, tex: SLAB_DARK });
  // ---------- dorsal spine block (raised, faceted) ----------
  const spine = { type: 'hull', id: 'spine', length: 384, width: 76, height: 24, at: [0, Y(162), zt(0.36)], interp: 'linear', plan: [[0, 20], [0.12, 38], [0.86, 38], [1, 22]], profile: [[0, 10, 0], [0.12, 24, 0], [0.86, 24, 0], [1, 12, 0]], section: { points: mir([[0, 1], [0.62, 1], [1, 0.1], [1, -1]]), chamfer: 0.04 }, rings: 6, segments: 8, crease: 20, texture: TOP, groove: DARK, material: 'painted_metal', ...P };
  parts.push(spine);
  const SP = hullSurface(spine);
  for (const [a, b] of [[0.14, 0.4], [0.42, 0.62], [0.64, 0.84]]) slab('spine', SP, a, b, 0.92, 0.08, { tex: SLAB_TOP, h: 3, m: 4, mirror: false });
  // ---------- side sponsons (the boom roots), heavy and wedge-ended ----------
  const tB = 0.42, zB = zt(tB), yBl = 146, yB = Y(yBl), xS = Sx(tB, yBl);
  const SPON = { points: mir([[0, 1], [0.55, 1], [1, 0.4], [1, -0.3], [0.6, -1]]), chamfer: 0.04 };
  for (const s of [1, -1]) {
    const sp = { type: 'hull', id: `spon_${s > 0 ? 'l' : 'r'}`, length: 288, width: 64, height: 58, at: [r2(s * (xS + 14)), Y(118), zB + 14], interp: 'linear', plan: [[0, 14], [0.2, 32], [0.74, 32], [1, 16]], profile: [[0, 30, 16], [0.2, 58, 0], [0.74, 58, 0], [1, 38, 8]], section: SPON, rings: 6, segments: 10, crease: 20, panel_lines: { rings: [0.2, 0.74], width: 2, depth: 1.6 }, texture: HULL, groove: DARK, material: 'painted_metal', ...P };
    parts.push(sp);
    const SS = hullSurface(sp);
    for (const [a, b] of [[0.22, 0.46], [0.5, 0.72]]) slab(sp.id, SS, a, b, 0.92, 0.08, { tex: SLAB_TOP, h: 3.5, stack: 2.5, mirror: false });
  }
  // ---------- heavy chin block under the nose (chin turret housing, nose gear bay) ----------
  const chin = { type: 'hull', id: 'chin', length: 230, width: 124, height: 36, at: [0, clear - 14, zt(0.88)], interp: 'linear', plan: [[0, 36], [0.25, 60], [0.7, 52], [1, 28]], profile: [[0, 20, 6], [0.25, 36, 0], [0.7, 34, 0], [1, 28, 10]], section: { points: mir([[0, 1], [0.7, 1], [1, 0.4], [0.85, -0.6], [0.5, -1]]), chamfer: 0.04 }, rings: 6, segments: 10, crease: 20, panel_lines: { rings: [0.25, 0.7], width: 2, depth: 1.6 }, texture: BELLY, groove: DARK, material: 'painted_metal', ...P };
  parts.push(chin);
  const CS = hullSurface(chin);
  slab('chin', CS, 0.28, 0.68, 0.17, 0.27, { h: 3.5, tex: SLAB_DARK });
  // ---------- glazing + nose sensor cage ----------
  parts.push({ type: 'glazing', hull: 'body', t: glz.t, u: glz.u, cols: 5, rows: 2, mullion: 7, frame: 12, inset: 4, opacity: 0.2, textures: { glass: '#8ec4dc', frame: DARK }, ...P });
  const nz = zt(1);
  parts.push({ type: 'truss', from: [0, Y(50), nz - 6], to: [0, Y(50), nz + 50], w: 26, h: 22, bay: 18, style: 'x', chord: 1.6, brace: 0.9, texture: DARK, ...P });
  parts.push({ type: 'sensor_dome', at: [0, Y(44), nz + 28], r: 7, ...P });
  for (const s of [1, -1]) parts.push({ type: 'antenna', at: [s * 11, Y(61), nz + 38], h: 26, style: 'whip', texture: DARK, ...P });
  parts.push({ type: 'light', at: [0, Y(38), nz + 52], color: '#fff2d8', kind: 'spot', dir: [0, -0.2, 1], intensity: 1.2, range: 420, bulb: 1.5, ...P });
  // ---------- airlock (round door, outside) + boarding ladder ----------
  const xDoor = -Sx(tDoor, doorC);
  parts.push({ type: 'ring_door', ...(rig ? { name: 'airlock' } : { open: o.airlock === 'open' ? 1 : 0 }), r: R, at: [r2(xDoor - 1), Y(doorC), zDoor], rotate: [0, 0, 90], glow: glowC, ...P });
  if (rig || o.gear !== 'up') parts.push({ type: 'ladder', at: [r2(xDoor - 8), 0, zDoor], rotate: [0, 90, 0], h: FY, w: 18, ...P });
  parts.push({ type: 'decal', text: 'AIRLOCK', font: '5x7', px: 1, color: '#e8e4d8', at: [r2(xDoor - 1.4), Y(doorC + R + 13), zDoor], rotate: [0, -90, 0], ...P });
  for (const s of [1, -1]) parts.push({ type: 'decal', kind: 'chevrons', count: 3, px: 1.2, color: accent, at: [r2(xDoor - 1.4), Y(doorC), zDoor + s * (R + 18)], rotate: [0, -90, s > 0 ? 0 : 180], ...P });
  parts.push({ type: 'marker', kind: 'spawn', at: [r2(xDoor - 60), 0, zDoor], dir: [1, 0, 0], data: { spawn: 'boarding' } });
  // ---------- armoured wing pylons from the sponsons, VTOL nacelles at the tips ----------
  const boomLen = 200, root = xS + 40, podR = 41, podX = root + boomLen + 30;
  const WING = { points: mir([[0, 1], [0.62, 1], [1, 0.25], [1, -0.25], [0.8, -1]]), chamfer: 0.03 };
  for (const s of [1, -1]) {
    const sfx = s > 0 ? 'l' : 'r', boomN = rig ? `boom_${sfx}` : undefined, podN = rig ? `pod_${sfx}` : undefined;
    const PB = rig ? { parent: boomN } : {}, PP = rig ? { parent: podN } : {};
    // shoulder pivot: exposed knuckles + collar on the sponson flank
    parts.push({ type: 'cylinder', r: 22, h: 14, segments: 10, rotate: [0, 0, 90], at: [r2(s * (root - (s > 0 ? 0 : 14))), yB, zB], texture: DARK, material: 'bare_metal', ...P });
    parts.push({ type: 'hinge', len: 30, r: 9, count: 4, at: [r2(s * (root - 2)), yB + 18, zB - 24], ...P });
    // the wing: thick tapered armoured pylon (faceted), top slabs, an exposed truss keel underneath
    parts.push({ type: 'hull', ...(rig ? { name: boomN, parent: 'hull' } : {}), id: `boom_${sfx}`, length: boomLen + 16, width: 128, height: 30, at: [r2(s * (root - 8 + (boomLen + 16) / 2)), yB - 15, zB], rotate: [0, s * 90, 0], interp: 'linear', plan: [[0, 64], [0.85, 48], [1, 42]], profile: [[0, 30, 0], [0.85, 26, 2], [1, 24, 3]], section: WING, rings: 6, segments: 10, crease: 20, panel_lines: { rings: [0.5], width: 2, depth: 1.5 }, texture: HULL, groove: DARK, material: 'painted_metal' });
    for (const [a, b] of [[0.06, 0.48], [0.52, 0.92]]) {
      const x0 = root + a * boomLen, x1 = root + b * boomLen, f = Math.min(1, ((x0 + x1) / 2 - root + 8) / (boomLen + 16) / 0.85);
      const hw = 64 - 16 * f, top = 30 - 4 * f;
      parts.push({ type: 'box', w: r2(x1 - x0), h: 3.5, d: r2(2 * 0.62 * hw - 8), at: [r2((s * (x0 + x1)) / 2), r2(yB - 15 + top - 0.8), zB], bevel: 1.4, tile: false, texture: SLAB_TOP, material: 'painted_metal', ...PB });
    }
    parts.push({ type: 'truss', from: [r2(s * (root + 8)), yB - 26, zB - 6], to: [r2(s * (podX - podR - 4)), yB - 23, zB - 6], w: 30, h: 14, bay: 26, style: 'warren', chord: 1.8, brace: 1.1, texture: DARK, ...PB });
    // underslung gun pod near the root, missile rails outboard
    parts.push({ type: 'gun_pod', at: [r2(s * (root + 46)), yB - 24, zB + 16], len: 100, r: 10, barrels: 6, ...PB });
    for (const k2 of [0, 1]) parts.push({ type: 'hardpoint', at: [r2(s * (root + 110 + k2 * 40)), yB - 15, zB + 10], len: 64, missile_r: 4, textures: { texture: MET, dark: DARK }, ...PB });
    // the nacelle: a faceted revolve (intake lip at the front, swelling body, exhaust bell at the back)
    const vt = o.vtol === 'flight' ? 0 : -90;
    if (rig) parts.push({ type: 'box', name: podN, parent: boomN, w: 20, h: 30, d: 40, at: [r2(s * podX), yB - 15, zB], pivot: [0, 15, 0], texture: DARK });
    const inPod = (q, local) => {
      // a part in the pod's frame (offset from the pod centre); static VTOL turns origin + part about x with the pod
      const c = [s * podX, yB, zB], a = (vt * Math.PI) / 180, ca = Math.cos(a), sa = Math.sin(a);
      const l = rig || !vt ? local : [local[0], local[1] * ca - local[2] * sa, local[1] * sa + local[2] * ca];
      const at = [r2(c[0] + l[0]), r2(c[1] + l[1]), r2(c[2] + l[2])];
      if (rig || !vt) return { ...q, at, ...PP };
      return { ...q, at, rotate: [vt + (q.rotate?.[0] ?? 0), q.rotate?.[1] ?? 0, q.rotate?.[2] ?? 0] };
    };
    parts.push(inPod({ type: 'revolve', id: `pod_${sfx}`, profile: [[20, -80], [27, -92], [31, -91], [35, -74], [podR, -52], [podR, 14], [38, 50], [35, 70], [37.5, 78], [36, 88], [29, 89], [26, 80], [22, 62]], segments: 10, smooth: false, rotate: [90, 0, 0], texture: HULL, material: 'painted_metal' }, [0, 0, 0]));
    parts.push(inPod({ type: 'engine', id: `vtol_${sfx}`, r: 22, len: 30, nozzle_len: 14, petals: 12, glow: glowC, textures: { housing: HULL2, nozzle: MET, dark: DARK } }, [0, 0, -78]));
    // intake: dark fan face + cross grille + hazard-striped lip band
    parts.push(inPod({ type: 'cylinder', r: 23, h: 3, segments: 10, rotate: [90, 0, 0], texture: 'kit_grate', material: 'bare_metal' }, [0, 0, 64]));
    for (const rz of [0, 90]) parts.push(inPod({ type: 'box', w: 50, h: 2.4, d: 2.4, rotate: [0, 0, rz], texture: DARK }, [0, -1.2, 84]));
    parts.push(inPod({ type: 'revolve', profile: [[38.4, -3.5], [38.4, 3.5]], segments: 10, smooth: false, rotate: [90, 0, 0], texture: 'kit_hazard' }, [0, 0, 74]));
    // top armour slab band, vent banks on the flanks, nav light
    parts.push(inPod({ type: 'box', w: 30, h: 3.5, d: 64, bevel: 1.4, tile: false, texture: SLAB_TOP, material: 'painted_metal' }, [0, podR - 1.2, -14]));
    for (const yy of [12, -12]) parts.push(inPod({ type: 'box', w: 2, h: 9, d: 52, texture: DARK, insets: [{ face: s > 0 ? 'right' : 'left', rect: [4, 2, 44, 5], depth: 0.6 }] }, [s * (podR - 0.6), yy - 4.5, -16]));
    parts.push(inPod({ type: 'light', color: s > 0 ? '#ff3030' : '#30ff60', intensity: 0.7, range: 80, bulb: 2.2 }, [s * (podR + 1), 8, 40]));
    parts.push(inPod({ type: 'decal', text: 'NO STEP', px: 0.8, color: '#e8e4d8', rotate: [-90, 0, 0] }, [0, podR + 2.6, -14]));
    // logotype + stripes on the wing's leading face
    parts.push({ type: 'decal', kind: 'logo', text: 'ORVANE', px: 1.1, color: '#e8e4d8', at: [r2(s * (root + 100)), yB - 2, r2(zB + 64.6)], ...PB });
    parts.push({ type: 'decal', kind: 'stripes', len: 40, px: 1, color: accent, at: [r2(s * (root + 100)), yB - 10, r2(zB + 64.6)], ...PB });
  }
  // ---------- tail: main engines, fin on the spine, strakes, vents ----------
  for (const s of [1, -1]) {
    parts.push({ type: 'engine', id: `main_${s > 0 ? 'l' : 'r'}`, at: [s * 42, Y(76), zt(0) - 26], r: 26, len: 60, nozzle_len: 20, petals: 12, glow: glowC, textures: { housing: HULL2, nozzle: MET, dark: DARK }, ...P });
    parts.push({ type: 'decal', kind: 'chevrons', count: 4, px: 1.2, color: accent, at: [s * 42, Y(110), zt(0) - 0.6], rotate: [0, 180, 0], ...P });
    parts.push({ type: 'wing_panel', span: 60, root: 120, tip: 50, sweep: 50, thick: 6, dihedral: s > 0 ? -35 : 215, at: [s * 54, Y(18), zt(0.12)], texture: HULL2, ...P });
  }
  parts.push({ type: 'wing_panel', span: 84, root: 150, tip: 56, sweep: 90, thick: 7, dihedral: 90, at: [0, Y(184), zt(0.15)], texture: TOP, ...P });
  parts.push({ type: 'decal', text: 'CAUTION JET BLAST', px: 0.7, color: '#1c1d20', bg: accent, at: [0, Y(102), zt(0) - 0.6], rotate: [0, 180, 0], ...P });
  // vent banks on the upper deck beside the spine + deep intakes on the second deck shoulders
  for (const s of [1, -1]) for (let i = 0; i < 3; i++) parts.push({ type: 'vent', on_hull: { hull: 'body', t: 0.395 + i * 0.04, u: s > 0 ? 0.068 : 0.932, lift: 0.2 }, w: 18, d: 24, slats: 5, texture: DARK, ...P });
  for (const s of [1, -1]) parts.push({ type: 'intake', on_hull: { hull: 'body', t: 0.7, u: s > 0 ? 0.115 : 0.885, lift: -0.5 }, w: 30, h: 14, d: 30, depth: 20, textures: { texture: HULL2, side: DARK }, ...P });
  // fine greebles only inside the recessed chine channel
  for (const u of [FU.side[1], 1 - FU.side[1]]) parts.push({ type: 'greeble', on_hull: { hull: 'body', t: 0.45, u, lift: -1.8 }, w: 3, d: 520, seed: 5, density: 0.5, size: [2, 6], height: [0.4, 1.2], kinds: ['bolts', 'conduit', 'panel'], texture: DARK, dark: '#18191c', accent: ACC, ...P });
  // ---------- underslung chin guns ----------
  parts.push({ type: 'turret', ...(rig ? { name: 'chin_turret' } : {}), on_hull: { hull: 'chin', t: 0.55, u: 0.5 }, r: 14, h: 6, barrels: 2, barrel_len: 70, textures: { texture: HULL2, dark: DARK, barrel: MET }, ...P });
  // ---------- livery decals: serial, stencils, logotype (on the side slabs) ----------
  for (const s of [1, -1]) {
    const tS = 0.575, xs = Sx(tS, 80) + 5.6;
    parts.push({ type: 'decal', text: serial, font: '5x7', px: 1.4, color: '#e8e4d8', at: [r2(s * (xs + 3)), Y(80), zt(tS)], rotate: [0, s * 90, 0], ...P });
    parts.push({ type: 'decal', text: 'TERN', font: '7x9', px: 1.6, color: accent, at: [r2(s * (Sx(0.28, 80) + 8.6)), Y(80), zt(0.28)], rotate: [0, s * 90, 0], ...P });
    parts.push({ type: 'decal', text: 'O2 SVC', px: 0.7, color: '#e8e4d8', at: [r2(s * (Sx(0.135, 70) + 5.6)), Y(70), zt(0.135)], rotate: [0, s * 90, 0], ...P });
  }
  // ---------- landing gear (chunky feet, visible pistons) ----------
  const legs = [[0.8, 0, 'gear_n', clear - 14 + CS.extentAt(CS.tOf(zt(0.8) - zt(0.88))).bottom], [0.24, 74, 'gear_l', clear + S.extentAt(0.24).bottom], [0.24, -74, 'gear_r', clear + S.extentAt(0.24).bottom]];
  for (const [t, x, nm, bot] of legs) {
    const yb = bot + 6;
    parts.push({ type: 'landing_gear', at: [x, r2(yb), zt(t)], h: r2(yb - 6 * 1.1), r: 6, foot: 'pad', door_w: 30, door_d: 46, textures: { texture: MET, piston: '#c8ccd0', door: HULL2, dark: DARK }, ...(rig ? { name: nm, parent: 'hull' } : { deployed: o.gear !== 'up' }) });
  }
  // ---------- interior (one model with the exterior; parts tagged inside:"body") ----------
  const IN = { inside: 'body', ...P };
  const zc0 = zt(0.31), zc1 = zt(0.785), zh0 = zt(0.075), zk1 = zt(0.925);
  const W2 = 52, wallT = 4;
  // floors: subfloor + grating panels + blue edge strips (corridor), rubber mat (cockpit), deck (hold)
  parts.push({ type: 'box', w: W2 * 2, h: 4, d: r2(zc1 - zc0), at: [0, FY - 6, r2((zc0 + zc1) / 2)], texture: DARK, ...IN });
  for (const s of [1, -1]) parts.push({ type: 'box', w: W2 - 30, h: 2, d: r2(zc1 - zc0), at: [s * (30 + (W2 - 30) / 2), FY - 2, r2((zc0 + zc1) / 2)], texture: 'kit_deck', ...IN });
  for (let z = zc0 + 2; z < zc1 - 30; z += 32) parts.push({ type: 'box', w: 60, h: 0.6, d: 30, at: [0, FY - 0.6, r2(z + 15)], texture: 'kit_grate', ...IN });
  for (const s of [1, -1]) parts.push({ type: 'box', w: 1.4, h: 0.8, d: r2(zc1 - zc0 - 8), at: [s * (W2 - 3), FY, r2((zc0 + zc1) / 2)], color: glowC, material: { preset: 'emissive_panel' }, ...IN });
  const ck = deckHalfWidth(body, 0.785, 0.925, FY - 4, 0, 3);
  parts.push({ type: 'box', w: r2(ck * 2), h: 4, d: r2(zk1 - zc1), at: [0, FY - 4, r2((zc1 + zk1) / 2)], texture: DARK, ...IN });
  parts.push({ type: 'box', w: r2(ck * 2 - 10), h: 0.8, d: r2(zk1 - zc1 - 10), at: [0, FY, r2((zc1 + zk1) / 2)], texture: 'kit_rubber', ...IN });
  // corridor walls (airlock gap on -x), ceiling with light bars
  const gap = [zDoor - R - 4, zDoor + R + 4];
  for (const s of [1, -1]) {
    const runs = s < 0 ? [[zc0, gap[0]], [gap[1], zc1]] : [[zc0, zc1]];
    for (const [a, b] of runs) {
      parts.push({ type: 'box', w: wallT, h: CH, d: r2(b - a), at: [s * (W2 + wallT / 2), FY, r2((a + b) / 2)], texture: 'kit_panel_light', material: 'painted_metal', ...IN });
      parts.push({ type: 'marker', kind: 'collider', at: [s * (W2 + wallT / 2), FY + CH / 2, r2((a + b) / 2)], dir: [0, 0, 1], data: { room: 'corridor', w: wallT, h: CH, d: r2(b - a) } });
    }
  }
  parts.push({ type: 'box', w: W2 * 2 + 2 * wallT, h: 4, d: r2(zc1 - zc0), at: [0, FY + CH, r2((zc0 + zc1) / 2)], texture: 'kit_ceiling', ...IN });
  for (let z = zc0 + 48; z < zc1 - 20; z += 96) {
    parts.push({ type: 'box', w: 40, h: 1.2, d: 6, at: [0, FY + CH - 1.2, r2(z)], color: '#e8f0ff', material: { preset: 'emissive_panel' }, ...IN });
    parts.push({ type: 'light', at: [0, FY + CH - 8, r2(z)], color: '#d8e8ff', intensity: 0.6, range: 110, bulb: false, ...IN });
  }
  // portal arches every 3 m
  for (let z = zc0 + 4; z <= zc1 - 4; z += 96) parts.push({ type: 'portal_arch', at: [0, FY, r2(z)], w: 92, h: 82, chamfer: 18, frame: 6, d: 8, glow: glowC, ...IN });
  // wall modules (+x wall faces -x): weapon rack, personal storage, component bay; terminal on an arm
  const wm = [['weapon_rack', -96, 112], ['storage', 16, 96], ['component', 124, 80]];
  for (const [kind, z, w] of wm) parts.push({ type: 'locker_wall', kind, at: [W2 - 5, FY, z], rotate: [0, -90, 0], w, h: 76, d: 10, glow: glowC, ...IN });
  parts.push({ type: 'screen_arm', at: [-W2 + 1, FY + 52, zDoor + R + 30], rotate: [0, 90, 0], reach: 20, w: 16, h: 11, angle: 20, ...IN });
  // airlock vestibule: floor, side walls, ceiling, door panel + decals
  const xv0 = -W2 - wallT, xv1 = xDoor + 17, vw = xv0 - xv1;
  parts.push({ type: 'box', w: 17, h: 1.6, d: R * 1.4, at: [r2(xDoor + 8.5), FY - 1.6, zDoor], texture: 'kit_hazard', ...P }); // door sill plate (in the airlock frame)
  parts.push({ type: 'box', w: r2(vw), h: 4, d: r2(gap[1] - gap[0]), at: [r2((xv0 + xv1) / 2), FY - 4, zDoor], texture: 'kit_deck', ...IN });
  const VH = 78;
  for (const zz of gap) parts.push({ type: 'box', w: r2(vw), h: VH, d: 4, at: [r2((xv0 + xv1) / 2), FY, r2(zz + (zz < zDoor ? -2 : 2))], texture: 'kit_panel_light', ...IN });
  parts.push({ type: 'box', w: r2(vw), h: 4, d: r2(gap[1] - gap[0] + 8), at: [r2((xv0 + xv1) / 2), FY + VH, zDoor], texture: 'kit_ceiling', ...IN });
  parts.push({ type: 'box', w: 4, h: CH - VH, d: r2(gap[1] - gap[0] + 8), at: [-W2 - wallT / 2, FY + VH, zDoor], texture: 'kit_panel_light', ...IN });
  parts.push({ type: 'terminal', small: true, at: [r2(xv1 + vw * 0.4), FY + 40, r2(gap[1] - 0.5)], rotate: [0, 180, 0], glow: '#40ff70', ...IN });
  parts.push({ type: 'decal', text: 'PUSH TO OPEN', px: 0.5, color: '#1c1d20', bg: accent, at: [r2(xv1 + vw * 0.4), FY + 30, r2(gap[1] - 0.6)], rotate: [0, 180, 0], ...IN });
  parts.push({ type: 'decal', kind: 'arrow', dir: 'left', px: 1.2, color: glowC, glow: true, at: [r2(-W2 + 0.4), FY + 70, zDoor + R + 18], rotate: [0, 90, 0], ...IN });
  parts.push({ type: 'decal', text: 'COCKPIT', px: 0.8, color: '#2a2c30', at: [r2(W2 - 0.4), FY + 80, zt(0.7)], rotate: [0, -90, 0], ...IN });
  parts.push({ type: 'decal', kind: 'arrow', dir: 'left', px: 1, color: '#2a2c30', at: [r2(W2 - 0.4), FY + 80, zt(0.7) + 26], rotate: [0, -90, 0], ...IN });
  parts.push({ type: 'light', at: [r2((xv0 + xv1) / 2), FY + VH - 6, zDoor], color: '#ffb060', intensity: 0.6, range: 90, bulb: false, ...IN });
  // cargo hold (behind the corridor): bulkhead + door frame, crates, lamps
  parts.push(...bulkhead(body, 0.305, { thick: 6, door: { w: 92, h: 84, y: FY }, texture: 'kit_panel_light' }).map((q) => ({ ...q, ...IN })));
  parts.push(...bulkhead(body, 0.07, { thick: 6, texture: 'kit_metal_dark' }).map((q) => ({ ...q, ...IN })));
  parts.push({ type: 'box', w: 140, h: 4, d: r2(zc0 - zh0), at: [0, FY - 4, r2((zh0 + zc0) / 2)], texture: 'kit_deck', ...IN });
  const crates = [[-44, -280, '#5d6a3c'], [-44, -250, '#5d6a3c'], [40, -290, '#8a5a2a'], [44, -240, '#2f5a7a']];
  crates.forEach(([x, z, c], i) => parts.push({ type: i === 3 ? 'barrel' : 'crate', at: [x, FY, z], size: i === 3 ? 22 : 30, color: c, seed: i + 1, ...IN }));
  parts.push({ type: 'light', at: [0, FY + 100, zt(0.19)], color: '#ffc880', intensity: 0.8, range: 160, bulb: 2, ...IN });
  // cockpit: pilot seat, flight console, overhead lamp, step plate
  const zSeat = zt(0.865);
  parts.push({ type: 'pilot_seat', id: 'pilot', at: [0, FY, zSeat], ...IN });
  const cw = Math.min(92, deckHalfWidth(body, 0.9, 0.91, FY, 34, 2) * 2);
  parts.push({ type: 'console', id: 'flight', turn: 2, at: [0, FY, zt(0.905)], w: r2(cw), screens: 3, textures: { texture: DARK, screen: 'kit_screen' }, ...IN });
  parts.push({ type: 'light', at: [0, FY + 70, zSeat], color: '#ffd8a0', intensity: 0.5, range: 80, bulb: false, ...IN });
  // walk areas, room data, spawn
  parts.push({ ...walkMarker([0, FY, r2((zc0 + zc1) / 2)], W2 * 2 - 6, r2(zc1 - zc0), { room: 'corridor', headroom: 74 }), ...IN });
  parts.push({ type: 'marker', kind: 'room', at: [0, FY, r2((zc0 + zc1) / 2)], data: { room: 'corridor', w: W2 * 2 + 8, d: r2(zc1 - zc0), h: CH } });
  parts.push({ ...walkMarker([r2((xv0 + xv1) / 2), FY, zDoor], r2(vw + 4), r2(gap[1] - gap[0] - 8), { room: 'airlock' }), ...IN });
  parts.push({ ...walkMarker([0, FY, r2(zc1 + (zSeat - 24 - zc1) / 2)], r2(Math.min(84, ck * 2 - 8)), r2(zSeat - 24 - zc1), { room: 'cockpit' }), ...IN });
  parts.push({ ...walkMarker([0, FY, r2((zh0 + zc0) / 2)], 54, r2(zc0 - zh0 - 12), { room: 'hold' }), ...IN });
  parts.push({ type: 'marker', kind: 'spawn', at: [0, FY, zt(0.6)], dir: [0, 0, 1], data: { spawn: 'crew' } });
  return {
    parts,
    notes: `gunship template (ORIGINAL design: maker ORVANE, class TERN, ${serial}): 25 m VTOL gunship at true scale (32 px = 1 m), exterior + walkable interior in one model. Nodes (rigged): hull > boom_l/boom_r > pod_l/pod_r, airlock (round door), chin_turret, gear_n/l/r; clips airlock_open, gear_retract, gear_deploy, vtol (pods down), plus per-assembly clips. Static: rigged:false + vtol:"landed"|"flight", gear:"down"|"up", airlock:"open". Interior: corridor (portal arches, grating, edge strips, weapon rack / storage / component bay, terminal arm), airlock vestibule, hold, cockpit (pilot seat, console, mullioned glazing). art_model walk_check {name} validates it against the player metrics; export {walk:true} adds the navmesh + colliders + triggers.`,
    ...(rig ? { poses: { landed: { parts: { pod_l: { rot: [-90, 0, 0] }, pod_r: { rot: [-90, 0, 0] } } } }, clips: { vtol: { keys: [{ t: 0, parts: {} }, { t: 2.4, parts: { pod_l: { rot: [-90, 0, 0] }, pod_r: { rot: [-90, 0, 0] } }, ease: 'smooth' }] } } } : {}),
  };
}
