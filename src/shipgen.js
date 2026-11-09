// Ship templates (art_model create {template:"fighter"|"dropship"|"hauler"|"capital_ring"}): a
// complete ORIGINAL ship from a few parameters + a seed, built from the hull + assemblies kit, for
// agents to refine (set:{<part name>:{..}}, add, remove). Plus the sci-fi kit texture set and the
// livery painter (paint masks, stripes, hazard, decals, faction marks, wear) mapped once over a hull.
import { hullSurface } from './hull.js';
import { mulberry32, hash3, BAYER4 } from './util.js';
import { FONTS } from './fonts.js';
import { shipClass, SCALE_CLASSES } from './modelkit.js';
import { gunshipTemplate } from './gunship.js';

const r2 = (v) => Math.round(v * 100) / 100;
const pick = (rnd, list) => list[Math.floor(rnd() * list.length)];
const lerp = (a, b, t) => a + (b - a) * t;

// ---------- texture slots ----------
const SLOT_DEFAULTS = { hull: '#7a8089', hull2: '#5b616b', dark: '#24272c', metal: '#4b5059', glass: '#7fc8e8', glow: '#7fd8ff', hazard: '#d09a28', deck: '#4a4f57', frame: '#33373e', accent: '#b8462e' };
/** textures:"kit" (the art_model kit canvases) | {slot: texture} | undefined (flat colours). */
export function shipSlots(t) {
  if (t === 'kit' || t === undefined) return { hull: 'kit_hull', hull2: 'kit_hull_dark', dark: 'kit_metal_dark', metal: 'kit_metal', glass: 'kit_glass', glow: 'kit_glow', hazard: 'kit_hazard', deck: 'kit_deck', frame: 'kit_metal_dark', accent: 'kit_accent' };
  return { ...SLOT_DEFAULTS, ...(t && typeof t === 'object' ? t : {}) }; // textures:"flat" = flat colours
}
const hullAt = (S, at, t, u) => { const p = S.point(t, u); return [r2(p[0] + at[0]), r2(p[1] + at[1]), r2(p[2] + at[2])]; };

// ---------- fighter ----------
export function fighterTemplate(o = {}) {
  const rnd = mulberry32((Number(o.seed ?? 1) * 2654435761) >>> 0 || 1), T = shipSlots(o.textures);
  const L = Number(o.length ?? 640), W = Number(o.width ?? L * lerp(0.2, 0.26, rnd())), H = Number(o.height ?? L * 0.1);
  const clear = Number(o.clearance ?? 40), rig = o.rigged !== false;
  const hullTex = o.livery ?? T.hull;
  const hull = {
    type: 'hull', id: 'hull', name: rig ? 'hull' : undefined, length: L, width: W, height: H, at: [0, clear, 0],
    plan: [[0, W * 0.3], [0.12, W * 0.42], [0.42, W * 0.5], [0.62, W * 0.36], [0.86, W * 0.16], [1, W * 0.02]],
    profile: [[0, H * 0.9, H * 0.12], [0.25, H * 1.05, 0], [0.62, H * 1.1, H * 0.04], [0.85, H * 0.72, H * 0.22], [1, H * 0.42, H * 0.36]],
    sections: [[0, 'hex'], [0.55, 'hex'], [0.9, 'wedge']], rings: Number(o.rings ?? 18), segments: Number(o.segments ?? 14), crease: 35,
    panel_lines: { every: Math.round(L / 7), seams: [0.17], width: 1.2, depth: 0.8 }, plates: [{ t: [0.3, 0.52], u: [0.2, 0.31], lift: 1.2 }],
    texture: hullTex, groove: T.dark, plate_texture: T.hull2, material: 'painted_metal', ...(o.livery ? { uv: 'fit' } : {}),
  };
  const S = hullSurface(hull), at = hull.at;
  const parts = [hull];
  const named = (n) => (rig ? { name: n } : {});
  const wingT = lerp(0.24, 0.34, rnd()), wspan = W * lerp(0.9, 1.3, rnd());
  const rootX = S.extentAt(wingT).w * 0.82, wy = S.extentAt(wingT).bottom + H * 0.35;
  parts.push({ type: 'wing', ...named('wings'), side: 'both', at: [0, r2(at[1] + wy), r2(S.z(wingT))], root_x: r2(rootX), span: r2(wspan), root: r2(L * 0.3), tip: r2(L * lerp(0.07, 0.12, rnd())), sweep: r2(L * lerp(0.14, 0.24, rnd())), thick: r2(H * 0.18), dihedral: r2(lerp(-6, 8, rnd())), texture: T.hull, fold_angle: 70 });
  // canted tail fins
  const finT = 0.08, finX = S.extentAt(finT).w * 0.55, finY = S.extentAt(finT).top;
  for (const s of [1, -1]) parts.push({ type: 'wing_panel', span: r2(H * 1.1), root: r2(L * 0.16), tip: r2(L * 0.06), sweep: r2(L * 0.08), thick: 2, dihedral: s > 0 ? 70 : 110, at: [r2(s * finX), r2(at[1] + finY - 1), r2(S.z(finT) + L * 0.02)], ...(s < 0 ? {} : {}), texture: T.hull2, ...(rig ? { parent: 'hull' } : {}) });
  parts.push({ type: 'canopy', ...named('canopy'), on_hull: { hull: 'hull', t: 0.72, u: 0, lift: -1 }, len: r2(L * 0.17), w: r2(W * 0.42), h: r2(H * 0.55), textures: { frame: T.dark, glass: T.glass }, ...(!rig ? { open: o.canopy === 'open' ? 1 : 0 } : {}), ...(rig ? { parent: 'hull' } : {}) });
  for (const [u, sfx] of [[0.19, 'l'], [0.81, 'r']]) parts.push({ type: 'engine', id: `engine_${sfx}`, on_hull: { hull: 'hull', t: 0.02, u, lift: -H * 0.18 }, rotate: [-90, 0, 0], r: r2(H * 0.34), len: r2(L * 0.14), textures: { housing: T.metal, nozzle: T.dark, dark: T.dark }, glow: o.glow ?? '#7fd8ff', ...(rig ? { parent: 'hull' } : {}) });
  for (const [u, sfx] of [[0.27, 'l'], [0.73, 'r']]) parts.push({ type: 'intake', on_hull: { hull: 'hull', t: 0.56, u, lift: -0.5 }, rotate: [-90, 0, 0], w: r2(H * 0.45), h: r2(H * 0.3), d: r2(L * 0.08), textures: { texture: T.hull2, dark: T.dark }, id: `intake_${sfx}`, ...(rig ? { parent: 'hull' } : {}) });
  parts.push({ type: 'rotary_cannon', id: 'chin_gun', on_hull: { hull: 'hull', t: 0.86, u: 0.5 }, r: r2(H * 0.18), barrel_len: r2(L * 0.1), textures: { texture: T.metal, dark: T.dark, barrel: T.dark }, ...(rig ? { parent: 'hull' } : {}) });
  for (const s of [1, -1]) parts.push({ type: 'hardpoint', id: `hp_${s > 0 ? 'l' : 'r'}`, at: [r2(s * (rootX + wspan * 0.55)), r2(at[1] + wy - 1), r2(S.z(wingT) + L * 0.02)], len: r2(L * 0.1), textures: { texture: T.metal, dark: T.dark }, ...(rig ? { parent: 'wings.' + (s > 0 ? 'l' : 'r') } : {}) });
  parts.push({ type: 'rcs_quad', on_hull: { hull: 'hull', t: 0.8, u: 0.24, mirror: true }, s: 3, texture: T.metal, ...(rig ? { parent: 'hull' } : {}) });
  parts.push({ type: 'antenna', on_hull: { hull: 'hull', t: 0.35, u: 0 }, h: r2(H * 0.6), style: 'blade', texture: T.dark, ...(rig ? { parent: 'hull' } : {}) });
  parts.push({ type: 'greeble', on_hull: { hull: 'hull', t: 0.45, u: 0, lift: -0.3 }, w: r2(W * 0.3), d: r2(L * 0.18), seed: Number(o.seed ?? 1), density: 0.4, size: [2, 7], height: [0.4, 1.6], kinds: ['panel', 'vent', 'bolts', 'hatch'], texture: T.hull2, dark: T.dark, accent: T.hazard, ...(rig ? { parent: 'hull' } : {}) });
  parts.push({ type: 'light', at: [0, r2(at[1] + S.extentAt(0.9).bottom - 1), r2(S.z(0.9))], kind: 'spot', dir: [0, -0.6, 0.8], color: '#fff2d8', intensity: 1.2, range: 260, bulb: 1.2, ...(rig ? { parent: 'hull' } : {}) });
  gear(parts, S, at, o, rig, T, [[0.8, 0.5, 'gear_n', 'wheel', 0.7], [0.32, 0.4, 'gear_l', 'wheel', 1], [0.32, 0.6, 'gear_r', 'wheel', 1]], clear);
  return { parts, notes: notes('fighter', L, 'hull > wings (.l/.r), canopy, gear_n/l/r; engines engine_l/r (plume sockets), chin_gun (rotary), hardpoints hp_l/r; clips canopy_open, gear_retract, gear_deploy, wings_fold') };
}
/** Landing gear legs under a hull: [[t, u, name, foot, scale]]. */
function gear(parts, S, at, o, rig, T, legs, clear) {
  for (const [t, u, nm, foot, k] of legs) {
    const p = hullAt(S, at, t, u), mount = r2(p[1] + 0.6);
    const r = r2(1.6 * k * Math.max(1, clear / 26));
    // strut length so the foot touches y = 0 (pad: 1.1 r thick, skid: 1.4 r, wheel: bottom at -h)
    const h = r2(foot === 'wheel' ? mount : foot === 'skid' ? mount - 1.4 * r : mount - 1.1 * r);
    parts.push({ type: 'landing_gear', at: [p[0], mount, p[2]], h, r, foot, textures: { texture: T.metal, piston: '#9aa0a8', door: T.hull2, dark: T.dark }, door_w: r2(10 * k), door_d: r2(h * 0.7), ...(rig ? { name: nm, parent: 'hull' } : { deployed: o.gear !== 'up' }) });
  }
}
const notes = (kind, L, extra) => {
  const cls = shipClass(L);
  return `${kind} template (ORIGINAL design, seeded): ${(L / 32).toFixed(1)} m, class ${cls} (budget ${SCALE_CLASSES[cls].triangles} tris LOD0, art_model budget {name}). +Z nose, gear contact at y=0. ${extra}. Refine with set:{<part name>:{..}}, add, remove; livery: art_model livery {name, canvas} then set:{hull:{texture:<canvas>, uv:"fit"}}; textures:"kit" uses art_model kit canvases. Static variant (LODs, impostor): export {static:true}.`;
};

// ---------- dropship ----------
export function dropshipTemplate(o = {}) {
  const rnd = mulberry32((Number(o.seed ?? 1) * 2246822519) >>> 0 || 1), T = shipSlots(o.textures);
  const L = Number(o.length ?? 1120), W = Number(o.width ?? L * lerp(0.26, 0.3, rnd())), H = Number(o.height ?? L * 0.2);
  const clear = Number(o.clearance ?? 40), rig = o.rigged !== false;
  const hull = {
    type: 'hull', id: 'hull', name: rig ? 'hull' : undefined, length: L, width: W, height: H, at: [0, clear, 0],
    plan: [[0, W * 0.46], [0.2, W * 0.5], [0.7, W * 0.5], [0.88, W * 0.38], [1, W * 0.16]],
    profile: [[0, H * 0.95, 0], [0.3, H, 0], [0.72, H * 0.98, 0], [0.9, H * 0.72, H * 0.12], [1, H * 0.42, H * 0.26]],
    sections: [[0, { points: [[0, 1], [1, 1], [1, -1], [-1, -1], [-1, 1]], chamfer: 0.24 }], [0.85, { points: [[0, 1], [0.8, 1], [1, 0.2], [0.8, -1], [-0.8, -1], [-1, 0.2], [-0.8, 1]], chamfer: 0.1 }]],
    rings: Number(o.rings ?? 18), segments: Number(o.segments ?? 12), crease: 30,
    panel_lines: { every: Math.round(L / 9), seams: [0.13, 0.36], width: 1.6, depth: 1 }, plates: [{ t: [0.25, 0.65], u: [0.33, 0.42], lift: 1.6 }, { t: [0.12, 0.3], u: [0.04, 0.12], lift: 1.2 }],
    texture: o.livery ?? T.hull, groove: T.dark, plate_texture: T.hull2, material: 'painted_metal', caps: 'nose', ...(o.livery ? { uv: 'fit' } : {}),
  };
  const S = hullSurface(hull), at = hull.at, parts = [hull];
  const P = (rig) => (rig ? { parent: 'hull' } : {});
  parts.push({ type: 'canopy', ...(rig ? { name: 'canopy' } : {}), on_hull: { hull: 'hull', t: 0.9, u: 0, lift: -2 }, len: r2(L * 0.12), w: r2(W * 0.5), h: r2(H * 0.25), ribs: 4, textures: { frame: T.dark, glass: T.glass }, ...P(rig) });
  // rear ramp at the tail: hinge on the keel line of the tail cap
  const tb = S.extentAt(0), rampW = r2(tb.w * 1.3), rampL = r2((tb.top - tb.bottom) * 0.82);
  parts.push({ type: 'ramp', ...(rig ? { name: 'ramp' } : { open: o.ramp === 'open' ? 1 : 0 }), at: [0, r2(at[1] + tb.bottom + 1), r2(S.z(0) - 1.5)], w: rampW, len: rampL, thick: 3, open_angle: r2(90 + (Math.acos(Math.min(1, (at[1] + tb.bottom) / rampL)) * 180) / Math.PI), textures: { texture: T.hull2, tread: T.dark, hazard: T.hazard }, ...P(rig) });
  parts.push({ type: 'cargo_door', ...(rig ? { name: 'side_door' } : {}), on_hull: { hull: 'hull', t: 0.6, u: 0.25, lift: 0.3 }, w: r2(H * 0.6), d: r2(L * 0.12), style: 'slide', textures: { texture: T.hull2, frame: T.dark }, ...P(rig) });
  // 4 VTOL engines on stub wings
  for (const [t, sfx] of [[0.22, 'aft'], [0.7, 'fwd']]) {
    const e = S.extentAt(t), y = r2(at[1] + e.bottom + (e.top - e.bottom) * 0.62);
    parts.push({ type: 'wing', ...(rig ? { name: `pylon_${sfx}` } : {}), side: 'both', at: [0, y, r2(S.z(t))], root_x: r2(e.w * 0.9), span: r2(W * 0.38), root: r2(L * 0.12), tip: r2(L * 0.1), sweep: 0, thick: r2(H * 0.12), dihedral: 0, texture: T.hull2, nav_lights: sfx === 'fwd', vtol: true, pod_r: r2(H * 0.2), glow: o.glow ?? '#ffb060', ...P(rig) });
  }
  parts.push({ type: 'turret', ...(rig ? { name: 'chin_turret' } : {}), on_hull: { hull: 'hull', t: 0.84, u: 0.5 }, r: r2(H * 0.12), barrels: 2, barrel_len: r2(L * 0.07), textures: { texture: T.metal, dark: T.dark, barrel: T.dark }, ...P(rig) });
  for (const s of [0.07, 0.93]) parts.push({ type: 'sensor_dome', on_hull: { hull: 'hull', t: 0.5, u: s }, r: r2(H * 0.07), ...P(rig) });
  parts.push({ type: 'antenna', on_hull: { hull: 'hull', t: 0.3, u: 0 }, h: r2(H * 0.4), style: 'mast', texture: T.dark, ...P(rig) });
  parts.push({ type: 'rcs_quad', on_hull: { hull: 'hull', t: 0.95, u: 0.2, mirror: true }, s: 4, texture: T.metal, ...P(rig) });
  parts.push({ type: 'greeble', on_hull: { hull: 'hull', t: 0.42, u: 0, lift: -0.4 }, w: r2(W * 0.5), d: r2(L * 0.3), seed: Number(o.seed ?? 1) + 7, density: 0.32, size: [6, 18], height: [0.5, 3], grid: 2, texture: T.hull2, dark: T.dark, accent: T.hazard, instanced: false, ...P(rig) });
  for (const [t, u] of [[0.5, 0.25], [0.5, 0.75]]) parts.push({ type: 'vent', on_hull: { hull: 'hull', t: 0.35, u, lift: 0.1 }, w: r2(H * 0.18), d: r2(L * 0.06), glow: '#ff7a30', texture: T.metal, dark: T.dark, id: `vent_${u}`, ...P(rig) });
  parts.push({ type: 'light', at: [0, r2(at[1] + S.extentAt(0.02).top - 6), r2(S.z(0) - 12)], kind: 'spot', dir: [0, -0.7, -0.7], color: '#ff9a40', intensity: 1, range: 220, bulb: 1.5, ...P(rig) });
  gear(parts, S, at, o, rig, T, [[0.82, 0.42, 'gear_fl', 'pad', 1.4], [0.82, 0.58, 'gear_fr', 'pad', 1.4], [0.16, 0.4, 'gear_al', 'pad', 1.6], [0.16, 0.6, 'gear_ar', 'pad', 1.6]], clear);
  return { parts, notes: notes('dropship', L, 'hull > canopy, ramp (rear, door marker for the interior), side_door, pylon_aft/fwd (VTOL pods, clip vtol_down), chin_turret, gear_fl/fr/al/ar; clips canopy_open, ramp_open, side_door_open, gear_retract, gear_deploy, vtol_down') };
}

// ---------- modular cargo hauler ----------
export function haulerTemplate(o = {}) {
  const rnd = mulberry32((Number(o.seed ?? 1) * 3266489917) >>> 0 || 1), T = shipSlots(o.textures);
  const L = Number(o.length ?? 1760), rig = o.rigged !== false;
  const bays = Math.max(1, Math.round(Number(o.bays ?? 3)));
  const cw = 40, ch = 40, cd = 96;
  const clear = Number(o.clearance ?? 40);
  const cabL = L * 0.18, engL = L * 0.16, spineL = L - cabL - engL;
  const cy = clear + 70;
  const cab = { type: 'hull', id: 'cab', name: rig ? 'hull' : undefined, length: cabL, width: 200, height: 120, at: [0, clear, r2(L / 2 - cabL / 2)], plan: [[0, 96], [0.5, 100], [0.85, 76], [1, 30]], profile: [[0, 118, 6], [0.5, 120, 0], [0.86, 92, 16], [1, 58, 40]], sections: [[0, { points: [[0, 1], [0.85, 1], [1, 0.5], [1, -0.7], [0.7, -1], [-0.7, -1], [-1, -0.7], [-1, 0.5], [-0.85, 1]], chamfer: 0.08 }]], rings: 10, segments: 14, crease: 32, panel_lines: { every: 48, seams: [0.12, 0.3], width: 1.5, depth: 1 }, texture: o.livery ?? T.hull, groove: T.dark, material: 'painted_metal', ...(o.livery ? { uv: 'fit' } : {}) };
  const eng = { type: 'hull', id: 'engine_block', length: engL, width: 230, height: 150, at: [0, clear - 10, r2(-L / 2 + engL / 2)], plan: [[0, 100], [0.3, 115], [1, 96]], profile: [[0, 140, 10], [0.4, 150, 0], [1, 128, 20]], section: { points: [[0, 1], [1, 1], [1, -1], [-1, -1], [-1, 1]], chamfer: 0.2 }, rings: 6, segments: 12, panel_lines: { rings: [0.5], seams: [0.25], width: 2, depth: 1.5 }, texture: T.hull2, groove: T.dark, material: 'painted_metal', ...(rig ? { parent: 'hull' } : {}) };
  const parts = [cab, eng];
  const P = rig ? { parent: 'hull' } : {};
  const z0 = -L / 2 + engL, z1 = L / 2 - cabL;
  parts.push({ type: 'truss', from: [0, cy, r2(z0 - 4)], to: [0, cy, r2(z1 + 4)], w: 40, h: 40, bay: 48, style: 'x', chord: 4, brace: 2.2, texture: T.metal, ...P });
  for (const s of [1, -1]) parts.push({ type: 'tube', path: [[s * 14, cy + 24, z0], [s * 14, cy + 24, z1]], r: 3, sides: 6, texture: T.dark, ...P });
  const S = hullSurface(cab);
  const bayL = (spineL - 40) / bays;
  for (let b = 0; b < bays; b++) {
    const zc = z0 + 20 + bayL * (b + 0.5);
    const layers = Math.max(1, Math.floor((bayL - 20) / (cd + 3)));
    for (const s of [1, -1]) parts.push({ type: 'container_rack', at: [r2(s * 70), cy - 50, r2(zc)], cols: 2, rows: 3, layers, size: [cw, ch, cd], seed: Number(o.seed ?? 1) * 10 + b * 2 + (s > 0 ? 0 : 1), fill: Number(o.fill ?? lerp(0.7, 0.95, rnd())), textures: { frame: T.frame }, ...P });
    parts.push({ type: 'beam', from: [-140, cy, r2(zc - bayL / 2 + 8)], to: [140, cy, r2(zc - bayL / 2 + 8)], s: 6, texture: T.metal, ...P });
    parts.push({ type: 'light', at: [0, cy + 30, r2(zc)], color: '#ffd8a0', intensity: 0.6, range: 180, bulb: 2, ...P });
  }
  for (const [x, y] of [[-60, 40], [60, 40], [-60, 104], [60, 104]]) parts.push({ type: 'engine', at: [x, r2(clear - 10 + y), r2(-L / 2 + 10)], r: 26, len: 70, textures: { housing: T.metal, nozzle: T.dark, dark: T.dark }, glow: o.glow ?? '#9ab8ff', ...P });
  parts.push({ type: 'canopy', ...(rig ? { name: 'canopy' } : {}), on_hull: { hull: 'cab', t: 0.86, u: 0, lift: -2 }, len: 60, w: 90, h: 22, ribs: 5, textures: { frame: T.dark, glass: T.glass }, ...P });
  parts.push({ type: 'antenna', on_hull: { hull: 'cab', t: 0.4, u: 0 }, h: 60, style: 'mast', texture: T.dark, ...P });
  parts.push({ type: 'antenna', on_hull: { hull: 'cab', t: 0.25, u: 0.06 }, h: 40, style: 'array', texture: T.metal, ...P });
  parts.push({ type: 'turret', ...(rig ? { name: 'pd_turret' } : {}), on_hull: { hull: 'cab', t: 0.5, u: 0.0, lift: 0 }, at: [0, 0, -30], r: 10, h: 6, style: 'rotary', textures: { texture: T.metal, dark: T.dark, barrel: T.dark }, ...P });
  parts.push({ type: 'cargo_door', ...(rig ? { name: 'cab_hatch' } : {}), on_hull: { hull: 'cab', t: 0.45, u: 0.25 }, w: 36, d: 44, style: 'gullwing', textures: { texture: T.hull2, frame: T.dark }, ...P });
  parts.push({ type: 'greeble', at: [0, clear + 140, r2(-L / 2 + engL / 2)], w: 180, d: r2(engL * 0.8), seed: Number(o.seed ?? 1) + 3, density: 0.4, size: [8, 22], height: [1, 5], grid: 2, texture: T.hull2, dark: T.dark, accent: T.hazard, ...P });
  gear(parts, S, cab.at, o, rig, T, [[0.7, 0.42, 'gear_fl', 'pad', 2], [0.7, 0.58, 'gear_fr', 'pad', 2]], clear);
  for (const s of [1, -1]) parts.push({ type: 'landing_gear', ...(rig ? { name: s > 0 ? 'gear_al' : 'gear_ar', parent: 'hull' } : { deployed: o.gear !== 'up' }), at: [s * 80, clear - 10, r2(-L / 2 + engL * 0.5)], h: clear - 14, r: 4, foot: 'pad', textures: { texture: T.metal, door: T.hull2, dark: T.dark } });
  return { parts, notes: notes('hauler', L, `cab (hull) + engine_block on a truss spine with ${bays} container bays (container_rack, seeded fill), 4 engines, canopy, pd_turret (rotary), cab_hatch, gear; clips canopy_open, pd_turret_scan/_spin, cab_hatch_open, gear_retract, gear_deploy`) };
}

// ---------- capital ring module ----------
export function capitalRingTemplate(o = {}) {
  const T = shipSlots(o.textures);
  const R = Number(o.radius ?? 2400), n = Math.max(8, Math.round(Number(o.segments ?? 24))), thick = Number(o.thick ?? 260), depth = Number(o.depth ?? 320);
  const segL = (2 * Math.PI * R) / n;
  const parts = [];
  const y0 = Number(o.y ?? depth / 2 + 40);
  // ring segments: a hull section tangential to the ring, arrayed about the hub axis (y)
  parts.push({ type: 'hull', id: 'ring_segment', length: r2(segL * 1.02), width: depth, height: thick, plan: [[0, depth / 2], [1, depth / 2]], profile: [[0, thick / 2, -thick / 2], [1, thick / 2, -thick / 2]], section: { points: [[0, 1], [0.7, 1], [1, 0.6], [1, -0.6], [0.7, -1], [-0.7, -1], [-1, -0.6], [-1, 0.6], [-0.7, 1]] }, interp: 'linear', rings: 4, segments: 10, crease: 25, panel_lines: { rings: [0.5], seams: [0.12, 0.38], width: 3, depth: 2 }, plates: [{ t: [0.15, 0.4], u: [0.18, 0.32], lift: 3 }], texture: T.hull, groove: T.dark, plate_texture: T.hull2, material: 'painted_metal', at: [R, y0, 0], rotate: [0, 0, 90], array: { count: n, rotate: [0, 360 / n, 0], about: [0, y0, 0] } });
  // habitat window band (emissive) on the outer face
  parts.push({ type: 'box', w: 2, h: r2(thick * 0.12), d: r2(segL * 0.8), at: [r2(R + depth / 2 + 1), r2(y0 + thick * 0.18), 0], color: o.window ?? '#ffd890', material: { preset: 'emissive_panel' }, array: { count: n, rotate: [0, 360 / n, 0], about: [0, y0, 0] } });
  parts.push({ type: 'box', w: 2, h: r2(thick * 0.06), d: r2(segL * 0.8), at: [r2(R + depth / 2 + 1), r2(y0 - thick * 0.12), 0], color: o.glow ?? '#7fd8ff', material: { preset: 'emissive_panel' }, array: { count: n, rotate: [0, 360 / n, 0], about: [0, y0, 0] } });
  // spokes to the hub
  const spokes = Math.max(3, Math.round(Number(o.spokes ?? 6)));
  parts.push({ type: 'truss', from: [Number(o.hub ?? 420) * 0.9, y0, 0], to: [R - depth / 2, y0, 0], w: 60, h: 60, bay: 120, style: 'warren', chord: 7, brace: 4, texture: T.metal, array: { count: spokes, rotate: [0, 360 / spokes, 0], about: [0, y0, 0] } });
  parts.push({ type: 'tube', path: [[Number(o.hub ?? 420), y0 + 40, 0], [R - depth / 2, y0 + 40, 0]], r: 10, sides: 6, texture: T.dark, array: { count: spokes, rotate: [0, 360 / spokes, 0], about: [0, y0, 0] } });
  const hub = Number(o.hub ?? 420);
  parts.push({ type: 'revolve', profile: [[0, y0 - 300], [hub * 0.6, y0 - 290], [hub, y0 - 160], [hub, y0 + 160], [hub * 0.6, y0 + 290], [0, y0 + 300]], segments: 16, smooth: false, texture: T.hull2 });
  parts.push({ type: 'revolve', profile: [[hub * 0.7, y0 + 300], [hub * 0.7, y0 + 420], [hub * 0.3, y0 + 460], [0, y0 + 460]], segments: 12, smooth: false, texture: T.metal });
  // docking arms + beacons
  for (let k = 0; k < 4; k++) {
    const a = (k * 90 + 45) * (Math.PI / 180), x = Math.cos(a), z = Math.sin(a);
    parts.push({ type: 'truss', from: [r2(x * (R + depth / 2)), y0, r2(z * (R + depth / 2))], to: [r2(x * (R + depth / 2 + 420)), y0, r2(z * (R + depth / 2 + 420))], w: 40, h: 40, bay: 70, style: 'x', chord: 5, brace: 3, texture: T.metal });
    parts.push({ type: 'light', at: [r2(x * (R + depth / 2 + 430)), y0, r2(z * (R + depth / 2 + 430))], color: k % 2 ? '#ff4040' : '#40ff80', intensity: 1, range: 400, bulb: 8 });
  }
  for (let k = 0; k < 8; k++) {
    const a = (k * 45) * (Math.PI / 180);
    parts.push({ type: 'turret', at: [r2(Math.cos(a) * R), r2(y0 + thick / 2), r2(Math.sin(a) * R)], r: 30, h: 16, barrels: 2, barrel_len: 120, turn: 0, rotate: [0, r2(-k * 45 + 90), 0], textures: { texture: T.metal, dark: T.dark, barrel: T.dark } });
  }
  parts.push({ type: 'antenna', at: [0, y0 + 460, 0], h: 300, style: 'mast', texture: T.dark });
  parts.push({ type: 'light', at: [0, y0 + 40, 0], color: '#9ab8ff', intensity: 2, range: 1800, bulb: false });
  return { parts, notes: `capital_ring template (ORIGINAL): ring module ${(2 * R / 32).toFixed(0)} m across, ${n} hull segments (one instanced segment arrayed radially), ${spokes} truss spokes, hub, 4 docking arms, 8 turrets, window bands. Class capital: export {split:true, lods:[1,0.4,0.15], impostor:true}; interior: art_model generate {kind:"interior", hull:<name>, part:"ring_segment"}.` };
}

export const SHIP_TEMPLATES = { gunship: gunshipTemplate, fighter: fighterTemplate, dropship: dropshipTemplate, hauler: haulerTemplate, capital_ring: capitalRingTemplate };

/**
 * length is in px (32 px = 1 m). Agents often pass metres (length:20 for a 20 m fighter = 0.6 m), and
 * a tiny ship's detail parts then fail with a part error that does not say why. For a fighter /
 * dropship / hauler with length < 160 px (5 m) this is the hint model_create adds to such an error
 * (and to the reply under 2 m); builds are unchanged. null otherwise.
 */
export function shipLengthHint(a = {}) {
  if (!['fighter', 'dropship', 'hauler'].includes(a.template) || a.length === undefined || a.length === null) return null;
  const L = Number(a.length);
  if (!Number.isFinite(L) || L >= 160) return null;
  return { length: L, text: `length is in px (32 px = 1 m): length:${L} = ${(L / 32).toFixed(2)} m; for a ${L} m ship pass length:${Math.round(L * 32)}` };
}

// ---------- kit textures (kittex.js) ----------
export { paintKitTextures } from './kittex.js';
const hex = (c) => { const v = parseInt(String(c).replace('#', '').slice(0, 6), 16); return [(v >> 16) & 255, (v >> 8) & 255, v & 255, 255]; };
const shade = (c, k) => [Math.max(0, Math.min(255, c[0] * k)), Math.max(0, Math.min(255, c[1] * k)), Math.max(0, Math.min(255, c[2] * k)), c[3] ?? 255];

// ---------- livery ----------
/**
 * Livery canvas for a hull (texture x = around from the top centre, y = nose (top row) .. tail),
 * used with the hull's uv:"fit". o: {primary, secondary, belly?:0.32 (u band around the keel),
 * stripes:[{t:[a,b], color, u?:[a,b]}], hazard:[{t:[a,b], u:[a,b]}], decals:[{text, t, side:left|right|top|bottom, v?:0.5, size?:2, color}],
 * mark:{t, side, size, color, seed} (original seeded faction emblem), wear?:0..1, panel?:px (panel line grid)}.
 */
export function paintLivery(hullPart, o = {}) {
  const S = hullSurface(hullPart);
  // texel size ~1.5 px of hull surface, power of two, max 512
  let perim = 0; { let p = S.point(0.5, 0); for (let k = 1; k <= 64; k++) { const q = S.point(0.5, k / 64); perim += Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]); p = q; } }
  const p2 = (v) => 2 ** Math.max(5, Math.min(9, Math.round(Math.log2(Math.max(32, v)))));
  const W = o.width ?? p2(perim / (o.texel ?? 1.5)), H = o.height ?? p2(S.L / (o.texel ?? 1.5));
  const prim = hex(o.primary ?? '#8a9098'), sec = hex(o.secondary ?? '#3d434c'), dark = shade(prim, 0.45);
  const seed = Number(o.seed ?? 1), belly = Number(o.belly ?? 0.3);
  const color = new Uint8ClampedArray(W * H * 4), height = new Uint8ClampedArray(W * H * 4);
  const set = (x, y, c) => { x = ((Math.round(x) % W) + W) % W; if (y < 0 || y >= H) return; color.set(c, (Math.round(y) * W + x) * 4); };
  const panel = Number(o.panel ?? 24); // px of hull surface
  const pu = Math.max(4, Math.round((W * panel) / perim)), pv = Math.max(4, Math.round((H * panel) / S.L));
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const u = (x + 0.5) / W, t = 1 - (y + 0.5) / H;
    const dk = Math.abs(u - 0.5);
    let c = dk < belly / 2 ? sec : prim;
    const nz = 0.94 + hash3(x >> 1, y >> 1, seed) * 0.1 + (BAYER4[y & 3][x & 3] / 16 - 0.5) * 0.03;
    const line = x % pu === 0 || (y + (Math.floor(x / pu) % 2) * (pv >> 1)) % pv === 0;
    c = shade(c, line ? 0.62 : nz);
    color.set(c, (y * W + x) * 4);
    const hv = line ? 0 : 160; height.set([hv, hv, hv, 255], (y * W + x) * 4);
    void t;
  }
  const tToY = (t) => (1 - t) * H, uToX = (u) => u * W;
  for (const s of o.stripes || []) {
    const c = hex(s.color ?? '#b8462e'), [ta, tb] = s.t, [ua, ub] = s.u ?? [0, 1];
    for (let y = Math.floor(tToY(Math.max(ta, tb))); y < Math.ceil(tToY(Math.min(ta, tb))); y++) for (let x = Math.floor(uToX(ua)); x < Math.ceil(uToX(ub)); x++) set(x, y, shade(c, 0.95 + hash3(x, y, seed + 3) * 0.08));
  }
  for (const z of o.hazard || []) {
    const [ta, tb] = z.t, [ua, ub] = z.u ?? [0.4, 0.6], c = hex(z.color ?? '#d09a28');
    for (let y = Math.floor(tToY(Math.max(ta, tb))); y < Math.ceil(tToY(Math.min(ta, tb))); y++) for (let x = Math.floor(uToX(ua)); x < Math.ceil(uToX(ub)); x++) set(x, y, ((x + y) >> 2) % 2 ? c : [24, 24, 26, 255]);
  }
  // decals: glyph pixels laid along the surface so they read from outside (side frames from the surface)
  const sideU = { right: 0.25, left: 0.75, top: 0, bottom: 0.5 };
  const stamp = (bitmap, bw, bh, t, side, v, size, c) => {
    const u0 = (sideU[side] ?? 0.25) + (side === 'right' ? (v - 0.5) * 0.3 : side === 'left' ? -(v - 0.5) * 0.3 : 0);
    const P = S.point(t, u0), du = 1e-3, dt = 1e-3;
    const Pu = S.point(t, u0 + du), Pt = S.point(Math.min(1, t + dt), u0);
    const n = S.normal(t, u0);
    const up = side === 'top' || side === 'bottom' ? [0, 0, 1] : [0, 1, 0];
    // viewer right = (-n) x up
    const right = [-(n[1] * up[2] - n[2] * up[1]), -(n[2] * up[0] - n[0] * up[2]), -(n[0] * up[1] - n[1] * up[0])];
    const eu = [Pu[0] - P[0], Pu[1] - P[1], Pu[2] - P[2]].map((x) => x / du), et = [Pt[0] - P[0], Pt[1] - P[1], Pt[2] - P[2]].map((x) => x / dt);
    // texel deltas: x per unit u = W, y per unit t = -H; solve right ~ a*eu + b*et (least squares) -> image vector
    const sol = (d) => { const a11 = eu.reduce((s, x, i) => s + x * eu[i], 0), a12 = eu.reduce((s, x, i) => s + x * et[i], 0), a22 = et.reduce((s, x, i) => s + x * et[i], 0); const b1 = d.reduce((s, x, i) => s + x * eu[i], 0), b2 = d.reduce((s, x, i) => s + x * et[i], 0); const det = a11 * a22 - a12 * a12 || 1; const a = (b1 * a22 - b2 * a12) / det, b = (a11 * b2 - a12 * b1) / det; return [a * W, -b * H]; };
    const downV = [-up[0], -up[1], -up[2]];
    const gx = sol(right), gy = sol(downV);
    const nx = Math.hypot(...gx) || 1, ny = Math.hypot(...gy) || 1;
    const k = Number(size ?? 2), ax = gx.map((x) => (x / nx) * k * (nx / Math.max(nx, ny)) ** 0), ay = gy.map((x) => (x / ny) * k);
    const cx = uToX(u0), cy = tToY(t);
    for (let j = 0; j < bh; j++) for (let i = 0; i < bw; i++) {
      if (!bitmap(i, j)) continue;
      for (let s = 0; s < k; s++) for (let r = 0; r < k; r++) {
        const fx = i - bw / 2 + s / k, fy = j - bh / 2 + r / k;
        set(cx + ax[0] * fx + ay[0] * fy, cy + ax[1] * fx + ay[1] * fy, c);
      }
    }
  };
  const G = FONTS['5x7'].glyphs;
  for (const d of o.decals || []) {
    const text = String(d.text ?? '07').toUpperCase(), chars = [...text];
    const gw = chars.reduce((s, ch) => s + (G[ch] || G['?'])[0].length + 1, -1);
    const bm = (i, j) => { let x = i; for (const ch of chars) { const g = G[ch] || G['?']; if (x < g[0].length) return g[j]?.[x] === '1'; x -= g[0].length + 1; if (x < 0) return false; } return false; };
    for (const side of [].concat(d.side ?? ['left', 'right'])) stamp(bm, gw, 7, Number(d.t ?? 0.5), side, Number(d.v ?? 0.5), d.size ?? 2, hex(d.color ?? '#e8e4d8'));
  }
  if (o.mark) {
    // original faction emblem: seeded symmetric 7x7 pixel glyph in a chevron frame
    const m = o.mark === true ? {} : o.mark, rnd = mulberry32((Number(m.seed ?? seed) * 747796405) >>> 0 || 1);
    const cells = [...Array(7)].map(() => [...Array(4)].map(() => rnd() > 0.48));
    const bm = (i, j) => { if (j >= 9) return false; if (j === 0 || j === 8) return i >= 1 && i <= 7; if (j > 0 && j < 8 && (i === 0 || i === 8)) return j < 7 || (i === 4); const ci = Math.min(i - 1, 7 - (i - 1)); return i > 0 && i < 8 && cells[j - 1]?.[Math.min(3, ci)]; };
    for (const side of [].concat(m.side ?? ['left', 'right', 'top'])) stamp(bm, 9, 9, Number(m.t ?? 0.4), side, Number(m.v ?? 0.5), m.size ?? 2, hex(m.color ?? '#e8e4d8'));
  }
  // wear: scratches + chipped edges, grime toward the belly and the tail
  const wear = Math.max(0, Math.min(1, Number(o.wear ?? 0.35)));
  if (wear) {
    const rnd = mulberry32(seed * 31 + 7);
    const nS = Math.round(W * H * 0.004 * wear);
    for (let i = 0; i < nS; i++) { let x = rnd() * W, y = rnd() * H; const l = 2 + rnd() * 6, dx = rnd() - 0.5, dy = rnd() - 0.5; for (let k = 0; k < l; k++) { const p = (((Math.round(y) % H + H) % H) * W + ((Math.round(x) % W) + W) % W) * 4; color.set(shade([color[p], color[p + 1], color[p + 2], 255], 1.35), p); x += dx * 1.5; y += dy * 1.5; } }
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const u = (x + 0.5) / W, t = 1 - (y + 0.5) / H, g = Math.max(0, 1 - Math.abs(u - 0.5) * 4) * 0.25 + Math.max(0, 0.15 - t) * 2;
      if (g * wear > hash3(x, y, seed + 9)) { const p = (y * W + x) * 4; color.set(shade([color[p], color[p + 1], color[p + 2], 255], 0.78), p); }
    }
  }
  void dark;
  return { width: W, height: H, color, height_layer: height };
}
