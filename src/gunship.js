// Hero ship template (art_model create {template:"gunship"}): an ORIGINAL small multi-crew VTOL
// gunship at true scale (32 px = 1 m, 25 m long), exterior and walkable interior in ONE model.
// Brand and names are original to this universe: maker "ORVANE", class "TERN", serial OV-TN-####.
//
// Exterior: tiered angular armour (stepped plates, recessed channels), two articulated nacelle
// booms with hard pivots and VTOL thruster pods (blue glow rings, intake grilles, vent banks,
// hazard-striped tips with nav lights), a big multi-pane glazed cockpit set into the armour, a
// round side airlock with a boarding ladder, underslung guns, missile rails, a nose sensor cage,
// chunky landing gear, livery decals (gunmetal + one yellow accent, stencils, serials, logotype,
// chevrons).
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
  const L = 800, clear = 48, Y = (yl) => clear + yl; // local hull height -> world
  const floorL = 30, FY = Y(floorL), CH = 88; // corridor floor (world) and clear height (2.75 m)
  const zt = (t) => r2((t - 0.5) * L);
  const P = rig ? { parent: 'hull' } : {};
  const named = (n) => (rig ? { name: n } : {});
  // ---------- primary form: the armoured body ----------
  const body = {
    type: 'hull', id: 'body', ...named('hull'), length: L, width: 224, height: 160, at: [0, clear, 0],
    plan: [[0, 70], [0.1, 96], [0.3, 112], [0.64, 112], [0.78, 100], [0.9, 72], [1, 18]],
    profile: [[0, 120, 26], [0.1, 150, 6], [0.3, 160, 0], [0.64, 160, 0], [0.78, 146, 6], [0.9, 112, 14], [0.97, 74, 30], [1, 56, 40]],
    sections: [[0, { points: [[0, 1], [0.6, 1], [0.92, 0.62], [1, 0.25], [1, -0.62], [0.75, -1], [-0.75, -1], [-1, -0.62], [-1, 0.25], [-0.92, 0.62], [-0.6, 1]], chamfer: 0.03 }], [0.94, { points: [[0, 1], [0.5, 1], [1, 0.3], [0.9, -0.6], [0.5, -1], [-0.5, -1], [-0.9, -0.6], [-1, 0.3], [-0.5, 1]], chamfer: 0.04 }]],
    rings: 20, segments: 18, crease: 28, shell: 6, inner: 'kit_metal_dark', rim: DARK,
    panel_lines: { every: 128, seams: [0.06, 0.2], width: 2.2, depth: 1.8 },
    plates: [
      // tiered side armour: two stepped layers + a third small cap, recessed channels between
      { t: [0.12, 0.38], u: [0.21, 0.33], lift: 2.5 }, { t: [0.15, 0.35], u: [0.23, 0.31], lift: 5 },
      { t: [0.52, 0.76], u: [0.21, 0.33], lift: 2.5 }, { t: [0.55, 0.72], u: [0.23, 0.31], lift: 5 },
      // dorsal spine plates
      { t: [0.12, 0.7], u: [0.965, 0.035], lift: 2.5 }, { t: [0.16, 0.42], u: [0.975, 0.025], lift: 5 },
      // the one accent colour: shoulder panels
      { t: [0.38, 0.52], u: [0.08, 0.19], lift: 3, texture: ACC },
      // belly armour
      { t: [0.18, 0.7], u: [0.44, 0.56], lift: 2.5 },
    ],
    texture: HULL, groove: DARK, plate_texture: HULL2, material: 'painted_metal',
    openings: [],
  };
  const S = hullSurface(body);
  // openings: cockpit glazing (top + upper sides of the nose) and the round airlock on the -x side
  const glz = { t: [0.785, 0.972], u: [0.69, 0.31] };
  const zDoor = -40, tDoor = 0.5 + zDoor / L, R = 36, doorC = floorL + R + 2; // door centre (local y)
  const tD = [0.5 + (zDoor - R - 8) / L, 0.5 + (zDoor + R + 8) / L];
  const uD = [uAtY(S, tDoor, doorC + R + 8), uAtY(S, tDoor, doorC - R - 8)].sort((a, b) => a - b);
  body.openings = [{ ...glz, id: 'glazing' }, { t: tD, u: uD, id: 'airlock' }];
  const parts = [body];
  const Sx = (t, yl) => S.halfWidthAt(t, yl); // outer half width at local height
  // ---------- glazing + nose sensor cage ----------
  parts.push({ type: 'glazing', hull: 'body', t: glz.t, u: glz.u, cols: 6, rows: 2, mullion: 5, frame: 9, inset: 3, textures: { glass: 'kit_glass', frame: DARK }, ...P });
  const nz = zt(1);
  parts.push({ type: 'truss', from: [0, Y(48), nz - 6], to: [0, Y(48), nz + 54], w: 26, h: 22, bay: 18, style: 'x', chord: 1.6, brace: 0.9, texture: DARK, ...P });
  parts.push({ type: 'sensor_dome', at: [0, Y(42), nz + 30], r: 7, ...P });
  for (const s of [1, -1]) parts.push({ type: 'antenna', at: [s * 11, Y(59), nz + 40], h: 26, style: 'whip', texture: DARK, ...P });
  parts.push({ type: 'light', at: [0, Y(36), nz + 56], color: '#fff2d8', kind: 'spot', dir: [0, -0.2, 1], intensity: 1.2, range: 420, bulb: 1.5, ...P });
  // ---------- airlock (round door, outside) + boarding ladder ----------
  const xDoor = -Sx(tDoor, doorC);
  parts.push({ type: 'ring_door', ...(rig ? { name: 'airlock' } : { open: o.airlock === 'open' ? 1 : 0 }), r: R, at: [r2(xDoor - 1), Y(doorC), zDoor], rotate: [0, 0, 90], glow: glowC, ...P });
  parts.push({ type: 'ladder', at: [r2(xDoor - 8), 0, zDoor], rotate: [0, 90, 0], h: FY, w: 18, ...P });
  parts.push({ type: 'decal', text: 'AIRLOCK', font: '5x7', px: 1, color: '#e8e4d8', at: [r2(xDoor - 1.4), Y(doorC + R + 13), zDoor], rotate: [0, -90, 0], ...P });
  for (const s of [1, -1]) parts.push({ type: 'decal', kind: 'chevrons', count: 3, px: 1.2, color: accent, at: [r2(xDoor - 1.4), Y(doorC), zDoor + s * (R + 18)], rotate: [0, -90, s > 0 ? 0 : 180], ...P });
  parts.push({ type: 'marker', kind: 'spawn', at: [r2(xDoor - 60), 0, zDoor], dir: [1, 0, 0], data: { spawn: 'boarding' } });
  // ---------- booms with VTOL thruster pods ----------
  const tB = 0.42, zB = zt(tB), yB = Y(132), xS = Sx(tB, 132);
  const boomLen = 230, podX = xS + boomLen + 18;
  for (const s of [1, -1]) {
    const sfx = s > 0 ? 'l' : 'r', boomN = rig ? `boom_${sfx}` : undefined, podN = rig ? `pod_${sfx}` : undefined;
    const PB = rig ? { parent: boomN } : {}, PP = rig ? { parent: podN } : {};
    // shoulder pivot: exposed knuckles + collar
    parts.push({ type: 'cylinder', r: 20, h: 16, segments: 12, rotate: [0, 0, 90], at: [r2(s * (xS + (s > 0 ? 14 : -2))), yB, zB], texture: DARK, material: 'bare_metal', ...P });
    parts.push({ type: 'hinge', len: 30, r: 9, count: 4, at: [r2(s * (xS + 8)), yB + 14, zB], ...P });
    parts.push({ type: 'hull', ...(rig ? { name: boomN, parent: 'hull' } : {}), id: `boom_${sfx}`, length: boomLen, width: 40, height: 30, at: [r2(s * (xS + 12 + boomLen / 2)), yB - 15, zB], rotate: [0, s * 90, 0], pivot: [r2(-s * (boomLen / 2 + 12)) * 0, 15, r2(-(boomLen / 2 + 4))], plan: [[0, 20], [0.85, 16], [1, 12]], profile: [[0, 30, 0], [0.8, 26, 3], [1, 22, 6]], section: { points: [[0, 1], [0.6, 1], [1, 0.4], [1, -0.4], [0.6, -1], [-0.6, -1], [-1, -0.4], [-1, 0.4], [-0.6, 1]] }, rings: 8, segments: 12, panel_lines: { every: 48, seams: [0.25], width: 1.5, depth: 1.2 }, plates: [{ t: [0.15, 0.7], u: [0.92, 0.08], lift: 2 }], texture: HULL, groove: DARK, plate_texture: HULL2, material: 'painted_metal' });
    // underslung gun pod near the root, missile rail outboard
    parts.push({ type: 'gun_pod', at: [r2(s * (xS + 70)), yB - 16, zB + 6], len: 96, r: 9, barrels: 6, ...PB });
    for (const k2 of [0, 1]) parts.push({ type: 'hardpoint', at: [r2(s * (xS + 140 + k2 * 40)), yB - 16, zB], len: 60, missile_r: 4, textures: { texture: MET, dark: DARK }, ...PB });
    // the pod: housing, thruster with a blue glow ring, intake grille, vent banks, hazard tip + nav light
    const pod = { type: 'hull', id: `pod_${sfx}`, ...(rig ? { name: podN, parent: boomN } : {}), length: 150, width: 64, height: 64, at: [r2(s * podX), yB - 32, zB], plan: [[0, 28], [0.15, 32], [0.85, 32], [1, 24]], profile: [[0, 58, 6], [0.15, 64, 0], [0.85, 64, 0], [1, 54, 10]], section: { points: [[0, 1], [0.7, 1], [1, 0.7], [1, -0.7], [0.7, -1], [-0.7, -1], [-1, -0.7], [-1, 0.7], [-0.7, 1]] }, rings: 8, segments: 12, panel_lines: { rings: [0.3, 0.7], seams: [0.25, 0.75], width: 1.5, depth: 1.2 }, plates: [{ t: [0.32, 0.68], u: [0.9, 0.1], lift: 2 }], texture: HULL, groove: DARK, plate_texture: HULL2, material: 'painted_metal', pivot: [0, 32, 0] };
    const vt = o.vtol === 'flight' ? 0 : -90;
    if (!rig && vt) pod.rotate = [vt, 0, 0];
    parts.push(pod);
    const inPod = (q, local) => {
      // a part in the pod's frame (offset from the pod centre); static VTOL turns origin + part about x with the pod
      const c = [s * podX, yB, zB], a = (vt * Math.PI) / 180, ca = Math.cos(a), sa = Math.sin(a);
      const l = rig || !vt ? local : [local[0], local[1] * ca - local[2] * sa, local[1] * sa + local[2] * ca];
      const at = [r2(c[0] + l[0]), r2(c[1] + l[1]), r2(c[2] + l[2])];
      if (rig || !vt) return { ...q, at, ...PP };
      return { ...q, at, rotate: [vt + (q.rotate?.[0] ?? 0), q.rotate?.[1] ?? 0, q.rotate?.[2] ?? 0] };
    };
    parts.push(inPod({ type: 'engine', id: `vtol_${sfx}`, r: 24, len: 50, nozzle_len: 16, petals: 12, glow: glowC, textures: { housing: HULL2, nozzle: MET, dark: DARK } }, [0, 0, -88]));
    parts.push(inPod({ type: 'intake', w: 40, h: 28, d: 30, depth: 24, textures: { texture: HULL2, side: DARK } }, [0, -14, 62]));
    for (const yy of [16, -16]) parts.push(inPod({ type: 'box', w: 2, h: 10, d: 60, rotate: [0, 0, 0], texture: DARK, insets: [{ face: s > 0 ? 'right' : 'left', rect: [4, 2, 52, 6], depth: 0.6 }] }, [s * 33, yy - 5, 0]));
    parts.push(inPod({ type: 'box', w: 6, h: 66, d: 40, texture: 'kit_hazard', bevel: 1 }, [s * 34, -33, -20]));
    parts.push(inPod({ type: 'light', color: s > 0 ? '#ff3030' : '#30ff60', intensity: 0.7, range: 80, bulb: 2.2 }, [s * 38, 30, -20]));
    parts.push(inPod({ type: 'decal', text: 'NO STEP', px: 0.8, color: '#e8e4d8', rotate: [-90, 0, 0] }, [0, 32.4, 30]));
    // logotype on the boom side (original maker mark)
    parts.push({ type: 'decal', kind: 'logo', text: 'ORVANE', px: 1.1, color: '#e8e4d8', at: [r2(s * (xS + 110)), yB - 4, r2(zB + 20.6)], ...PB });
    parts.push({ type: 'decal', kind: 'stripes', len: 40, px: 1, color: accent, at: [r2(s * (xS + 110)), yB - 13, r2(zB + 20.6)], ...PB });
  }
  // ---------- tail: main engines, fin, strakes, vents ----------
  for (const s of [1, -1]) {
    parts.push({ type: 'engine', id: `main_${s > 0 ? 'l' : 'r'}`, at: [s * 42, Y(74), zt(0) - 26], r: 26, len: 60, nozzle_len: 20, petals: 12, glow: glowC, textures: { housing: HULL2, nozzle: MET, dark: DARK }, ...P });
    parts.push({ type: 'decal', kind: 'chevrons', count: 4, px: 1.2, color: accent, at: [s * 42, Y(108), zt(0) - 0.6], rotate: [0, 180, 0], ...P });
    parts.push({ type: 'wing_panel', span: 60, root: 120, tip: 50, sweep: 50, thick: 5, dihedral: s > 0 ? -35 : 215, at: [s * 50, Y(16), zt(0.12)], texture: HULL2, ...P });
  }
  parts.push({ type: 'wing_panel', span: 90, root: 170, tip: 60, sweep: 90, thick: 6, dihedral: 90, at: [0, Y(150), zt(0.14)], texture: HULL2, ...P });
  parts.push({ type: 'decal', text: 'CAUTION JET BLAST', px: 0.7, color: '#1c1d20', bg: accent, at: [0, Y(100), zt(0) - 0.6], rotate: [0, 180, 0], ...P });
  // vent banks on the spine (in the recessed channel) + intake grilles behind the canopy
  for (const s of [1, -1]) for (let i = 0; i < 4; i++) parts.push({ type: 'vent', on_hull: { hull: 'body', t: 0.16 + i * 0.045, u: s > 0 ? 0.06 : 0.94, lift: 0.2 }, w: 18, d: 26, slats: 5, texture: DARK, ...P });
  for (const s of [1, -1]) parts.push({ type: 'intake', on_hull: { hull: 'body', t: 0.66, u: s > 0 ? 0.12 : 0.88, lift: -0.5 }, w: 36, h: 14, d: 30, depth: 20, textures: { texture: HULL2, side: DARK }, ...P });
  // fine greebles only inside the recessed seams
  for (const u of [0.2, 0.8]) parts.push({ type: 'greeble', on_hull: { hull: 'body', t: 0.47, u, lift: -1.5 }, w: 3, d: 420, seed: 5, density: 0.5, size: [2, 6], height: [0.4, 1.2], kinds: ['bolts', 'conduit', 'panel'], texture: DARK, dark: '#18191c', accent: ACC, ...P });
  // ---------- underslung chin guns ----------
  parts.push({ type: 'turret', ...(rig ? { name: 'chin_turret' } : {}), on_hull: { hull: 'body', t: 0.86, u: 0.5 }, r: 14, h: 6, barrels: 2, barrel_len: 70, textures: { texture: HULL2, dark: DARK, barrel: MET }, ...P });
  // ---------- livery decals: serial, stencils, logotype ----------
  for (const s of [1, -1]) {
    const tS = 0.66, xs = Sx(tS, 70) + 5.6;
    parts.push({ type: 'decal', text: serial, font: '5x7', px: 1.4, color: '#e8e4d8', at: [r2(s * xs), Y(70), zt(tS)], rotate: [0, s * 90, 0], ...P });
    parts.push({ type: 'decal', text: 'TERN', font: '7x9', px: 1.6, color: accent, at: [r2(s * xs), Y(52), zt(0.2)], rotate: [0, s * 90, 0], ...P });
    parts.push({ type: 'decal', text: 'O2 SVC', px: 0.7, color: '#e8e4d8', at: [r2(s * (Sx(0.25, 100) + 0.3)), Y(100), zt(0.25)], rotate: [0, s * 90, 0], ...P });
  }
  // ---------- landing gear (chunky feet, visible pistons) ----------
  const legs = [[0.8, 0, 'gear_n'], [0.24, 74, 'gear_l'], [0.24, -74, 'gear_r']];
  for (const [t, x, nm] of legs) {
    const yb = clear + S.extentAt(t).bottom + 6;
    parts.push({ type: 'landing_gear', at: [x, r2(yb), zt(t)], h: r2(yb - 6 * 1.1), r: 6, foot: 'pad', door_w: 30, door_d: 46, textures: { texture: MET, piston: '#c8ccd0', door: HULL2, dark: DARK }, ...(rig ? { name: nm, parent: 'hull' } : { deployed: o.gear !== 'up' }) });
  }
  // ---------- interior (one model with the exterior; parts tagged inside:"body") ----------
  const IN = { inside: 'body', ...P };
  const zc0 = zt(0.31), zc1 = zt(0.785), zh0 = zt(0.075), zk1 = zt(0.925);
  const W2 = 52, wallT = 4;
  // floors: subfloor + grating panels + blue edge strips (corridor), rubber mat (cockpit), deck (hold)
  parts.push({ type: 'box', w: W2 * 2, h: 4, d: r2(zc1 - zc0), at: [0, FY - 4, r2((zc0 + zc1) / 2)], texture: DARK, ...IN });
  for (let z = zc0 + 2; z < zc1 - 30; z += 32) parts.push({ type: 'box', w: 60, h: 0.6, d: 30, at: [0, FY, r2(z + 15)], texture: 'kit_grate', ...IN });
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
