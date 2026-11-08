// Seeded layout generators for art_model generate: a ship interior fitted inside a hull (deck plan,
// rooms on a corridor spine, doors at the exterior hatches, windows written back onto the hull,
// cull rooms), a mining colony on a rock outcrop and an underground market district (kit pieces as
// instanced models, walkable floors, light markers, cull zones).
import { hullSurface } from './hull.js';
import { mulberry32 } from './util.js';
import { DECK } from './kitrooms.js';

const r2 = (v) => Math.round(v * 100) / 100, r5 = (v) => Math.round(v * 1e5) / 1e5;

// ---------- ship interior ----------
/**
 * Deck plan inside a hull. ship: the expanded ship def; hullPart: its hull part (at = offset);
 * doors: exterior door markers [{pos, data}] (ramp / cargo hatches) from the built ship.
 * -> {def (interior model), windows (parts for the ship), report}
 */
export function interiorFromHull(name, hullPart, doors = [], o = {}) {
  const S = hullSurface(hullPart);
  const off = (hullPart.at || [0, 0, 0]).map(Number);
  const C = Number(o.cell ?? DECK.cell), Hd = Number(o.deck_h ?? DECK.h), margin = Number(o.margin ?? 6), wall = DECK.wall;
  const fits = (xEdge, z, yf) => {
    const t = S.tOf(z - off[2]);
    if (t <= 0.001 || t >= 0.999) return false;
    for (const y of [yf - DECK.floor - 1, yf + Hd + DECK.floor + 1]) { const hw = S.halfWidthAt(t, y - off[1]); if (hw < xEdge + wall + margin) return false; }
    return true;
  };
  const cellFits = (ix, zc, yf) => fits(Math.abs(ix) * C + C / 2, zc - C / 2, yf) && fits(Math.abs(ix) * C + C / 2, zc + C / 2, yf);
  // the ramp / tail hatch sets where the rows start, so the cargo bay door meets it
  const ramp = doors.find((d) => d.data?.kind === 'ramp');
  const zMin = off[2] - S.L / 2, zMax = off[2] + S.L / 2;
  let best = null;
  const yLo = off[1] + Math.min(...[0.3, 0.5, 0.7].map((t) => S.extentAt(t).bottom)), yHi = off[1] + Math.max(...[0.3, 0.5, 0.7].map((t) => S.extentAt(t).top));
  for (let k = 0; k <= 24; k++) {
    const yf = r2(yLo + DECK.floor + 2 + ((yHi - yLo - Hd - 2 * DECK.floor - 4) * k) / 24);
    if (o.floor_y !== undefined && k) break;
    const Y = o.floor_y !== undefined ? Number(o.floor_y) : yf;
    const z0 = ramp ? ramp.pos[2] + wall + 1 : zMin;
    const rows = [];
    for (let z = z0 + C / 2; z + C / 2 <= zMax; z += C) {
      let K = -1;
      while (K < 6 && cellFits(K + 1, z, Y)) K++;
      rows.push({ z: r2(z), K });
    }
    // longest run of rows where the centre column fits
    let run = null, cur = null;
    for (let j = 0; j < rows.length; j++) {
      if (rows[j].K >= 0) { if (!cur) cur = { a: j, b: j }; else cur.b = j; if (!run || cur.b - cur.a > run.b - run.a) run = { ...cur }; } else cur = null;
    }
    if (!run) continue;
    if (ramp && run.a > 1) continue;
    const cells = rows.slice(run.a, run.b + 1).reduce((s, r) => s + 2 * r.K + 1, 0);
    if (!best || cells > best.cells) best = { y: Y, rows: rows.slice(run.a, run.b + 1), cells };
  }
  if (!best || best.rows.length < 3) throw new Error(`interior: the hull has no room for a ${Hd} px deck with ${C} px cells (${best ? best.rows.length : 0} rows fit; lower deck_h / cell, or use a bigger hull)`);
  const { y: yf, rows } = best;
  const N = rows.length;
  // bands from the tail (j = 0) to the nose (j = N - 1)
  const bands = [];
  let j = 0;
  const minK = (a, b) => Math.min(...rows.slice(a, b + 1).map((r) => r.K));
  const cargoRows = ramp ? Math.min(Math.max(2, Math.round(N * 0.3)), N - 3) : 0;
  if (cargoRows) { bands.push({ kind: 'cargo_bay', a: 0, b: cargoRows - 1 }); j = cargoRows; }
  const engRows = N - j >= 6 ? 3 : N - j >= 4 ? 2 : 0;
  if (engRows) { bands.push({ kind: 'engine_room', a: j, b: j + engRows - 1 }); j += engRows; }
  const bridgeRows = N - j >= 3 ? 2 : 1;
  const side = ['quarters', 'med_bay', 'armoury', 'quarters', 'cargo_bay'];
  let si = 0;
  while (N - j - bridgeRows >= 2) { bands.push({ kind: 'sides', a: j, b: j + 1, rooms: [side[si % side.length], side[(si + 1) % side.length]] }); si += 2; j += 2; }
  if (N - j - bridgeRows === 1) { bands.push({ kind: 'corridor', a: j, b: j }); j++; }
  bands.push({ kind: 'bridge', a: j, b: N - 1 });
  // parts
  const parts = [], rooms = [], openings = [], report = { rooms: [], doors: [], windows: 0 };
  const zOf = (a, b) => (rows[a].z + rows[b].z) / 2, depth = (a, b) => b - a + 1;
  const doorsOpen = o.doors !== 'closed';
  const addRoom = (kind, cx, a, b, cw, open, id) => {
    const cd = depth(a, b), zc = zOf(a, b);
    parts.push({ type: kind, id, at: [r2(cx), yf, r2(zc)], cells: [cw, cd], openings: open, seed: Number(o.seed ?? 1) + rooms.length, textures: o.textures, ...(kind === 'engine_room' ? { h: Hd } : kind === 'cargo_bay' ? { h: Hd } : {}) });
    const W = cw * C, D = cd * C;
    rooms.push({ name: id, min: [r2(cx - W / 2), r2(yf - DECK.floor), r2(zc - D / 2)], max: [r2(cx + W / 2), r2(yf + Hd + DECK.floor), r2(zc + D / 2)] });
    report.rooms.push({ id, kind, cells: [cw, cd], at: [r2(cx), yf, r2(zc)] });
  };
  const doorAt = (x, z, turn, id) => { parts.push({ type: 'door', id, at: [r2(x), yf, r2(z)], turn, style: 'bulkhead', open: doorsOpen ? 1 : 0 }); report.doors.push({ id, at: [r2(x), yf, r2(z)] }); };
  const corridorRuns = [];
  for (const [bi, bd] of bands.entries()) {
    const K = minK(bd.a, bd.b), cw = 2 * K + 1;
    if (bd.kind === 'sides' && K >= 1) {
      const zc = zOf(bd.a, bd.b), D = depth(bd.a, bd.b) * C;
      corridorRuns.push({ a: bd.a, b: bd.b, e: [{ at: 0, kind: 'door' }], w: [{ at: 0, kind: 'door' }] });
      for (const [sgn, kind] of [[1, bd.rooms[0]], [-1, bd.rooms[1]]]) {
        const cx = sgn * (C / 2 + (K * C) / 2);
        // window on the outer wall when the hull skin is close
        const xOut = C / 2 + K * C + wall, t = S.tOf(zc - off[2]), skin = S.halfWidthAt(t, yf + Hd * 0.5 - off[1]);
        const win = skin - xOut < Number(o.window_gap ?? 40);
        const open = { [sgn > 0 ? 'w' : 'e']: [{ at: 0, kind: 'door' }], ...(win ? { [sgn > 0 ? 'e' : 'w']: [{ at: 0, kind: 'window' }] } : {}) };
        addRoom(kind, cx, bd.a, bd.b, K, open, `${kind}_${bi}_${sgn > 0 ? 'l' : 'r'}`);
        doorAt(sgn * (C / 2 + wall / 2), r2(zc - D / 2 + C / 2), 1, `door_${bi}_${sgn > 0 ? 'l' : 'r'}`);
        if (win) openings.push({ x: sgn * xOut, z: r2(zc - D / 2 + C / 2), y: yf + Hd * 0.38 + Hd * 0.175, w: C * 0.7, h: Hd * 0.35, room: `${kind}_${bi}` });
      }
      continue;
    }
    if (bd.kind === 'corridor' || (bd.kind === 'sides' && K < 1)) { corridorRuns.push({ a: bd.a, b: bd.b }); continue; }
    const open = {};
    const prevB = bands[bi - 1], nextB = bands[bi + 1];
    if (nextB) open.n = [{ at: K, kind: 'door' }];
    if (prevB) open.s = [{ at: K, kind: 'door' }];
    if (bd.kind === 'cargo_bay' && ramp) open.s = 'open';
    if (bd.kind === 'bridge') open.n = [{ at: K, kind: 'window', w: Math.min(cw * C * 0.8, C * 2), h: Hd * 0.4, sill: Hd * 0.35 }];
    addRoom(bd.kind, 0, bd.a, bd.b, cw, open, `${bd.kind}_${bi}`);
    if (nextB) doorAt(0, r2(zOf(bd.b, bd.b) + C / 2 + wall / 2), 0, `door_${bi}_n`);
  }
  for (const [ci, cr] of corridorRuns.entries()) {
    const zc = zOf(cr.a, cr.b), len = depth(cr.a, cr.b);
    const op = { n: 'open', s: 'open' };
    if (cr.e) { op.e = []; op.w = []; for (let r = 0; r < len; r++) { op.e.push({ at: r, kind: 'door' }); op.w.push({ at: r, kind: 'door' }); } }
    parts.push({ type: 'corridor', id: `corridor_${ci}`, kind: 'straight', len, at: [0, yf, r2(zc)], openings: { ...op, ...(cr.e ? { e: [{ at: 0, kind: 'door' }], w: [{ at: 0, kind: 'door' }] } : {}) }, seed: Number(o.seed ?? 1) + ci, textures: o.textures });
    rooms.push({ name: `corridor_${ci}`, min: [-C / 2, r2(yf - DECK.floor), r2(zc - (len * C) / 2)], max: [C / 2, r2(yf + Hd + DECK.floor), r2(zc + (len * C) / 2)] });
  }
  // exterior windows on the hull: the point of the hull side at the window's height and station
  const windows = [];
  for (const [k, w] of openings.entries()) {
    const t = S.tOf(w.z - off[2]);
    let bu = 0.25, bd = 1e9;
    const side = w.x > 0 ? [0.02, 0.48] : [0.52, 0.98];
    for (let i = 0; i <= 64; i++) { const u = side[0] + ((side[1] - side[0]) * i) / 64, p = S.point(t, u); const d = Math.abs(p[1] + off[1] - w.y); if (d < bd && Math.sign(p[0]) === Math.sign(w.x)) { bd = d; bu = u; } }
    windows.push({ type: 'box', id: `iwin_${k}`, auto: 'interior', on_hull: { hull: hullPart.id ?? hullPart.name ?? 0, t: r5(t), u: r5(bu), lift: 0.2 }, w: r2(w.h * 0.8), h: 0.6, d: r2(w.w * 0.9), color: o.window_color ?? '#ffd890', material: { preset: 'emissive_panel' } });
    w.exterior = { t: r5(t), u: r5(bu) };
  }
  report.windows = windows.length;
  // door alignment: each exterior hatch vs the nearest interior opening
  report.alignment = doors.map((d) => {
    let bestD = Infinity, at = null;
    for (const r of rooms) {
      const cz = Math.max(r.min[2], Math.min(r.max[2], d.pos[2])), cx = Math.max(r.min[0], Math.min(r.max[0], d.pos[0]));
      const dist = Math.hypot(d.pos[0] - cx, d.pos[2] - cz);
      if (dist < bestD) { bestD = dist; at = r.name; }
    }
    return { door: d.data?.door ?? d.data?.kind, kind: d.data?.kind, room: at, gap_px: r2(bestD) };
  });
  const def = { name, parts, grid: C, scale: 32, origin: 'auto', cull: { rooms, depth: 2 }, notes: `interior of ${o.ship ?? 'ship'}: deck at y ${yf}, ${N} rows of ${C} px cells; rooms ${report.rooms.map((r) => r.kind).join(', ')}; export with cull (rooms + auto portals) for portal culling. Door / window markers line up with the exterior hatches and the iwin_* window parts on the ship.` };
  return { def, windows, report: { ...report, deck_y: yf, rows: N, cells: best.cells, openings } };
}

/** Inside test for the interior-hull fit: every vertex of a mesh within the hull section (tolerance px). */
export function insideHull(hullPart, mesh, tol = 0.5) {
  const S = hullSurface(hullPart), off = (hullPart.at || [0, 0, 0]).map(Number);
  let worst = -Infinity, bad = 0, n = 0;
  for (const g of mesh.groups.values()) {
    if (g.tex?.material?.additive) continue; // fog cards are not geometry
    for (let i = 0; i < g.pos.length; i += 3) {
      const x = g.pos[i], y = g.pos[i + 1], z = g.pos[i + 2];
      const t = S.tOf(z - off[2]);
      const hw = t <= 0 || t >= 1 ? -1 : S.halfWidthAt(t, y - off[1]);
      const over = Math.abs(x) - hw;
      n++;
      if (over > tol) bad++;
      worst = Math.max(worst, over);
    }
  }
  return { vertices: n, outside: bad, worst_px: r2(worst) };
}

// ---------- mining colony ----------
const kitModel = (prefix, key, part) => ({ name: `${prefix}_k_${key}`, parts: [part], grid: 32, scale: 32, origin: 'auto', notes: `kit piece for ${prefix} (generated)` });
/**
 * Mining colony on a rock outcrop: platforms on rock anchors at seeded heights joined by bridges,
 * tanks, silo, comms tower + dish, crane, habitat modules, hangar shell, landing pad, a drill rig,
 * pipelines, lights and haze. -> {models (kit pieces), def (layout of instances), report}
 */
export function miningColony(name, o = {}) {
  const rnd = mulberry32((Number(o.seed ?? 1) * 2654435761) >>> 0 || 1);
  const R = (a, b) => a + (b - a) * rnd();
  const kits = new Map();
  const kit = (key, part) => { if (!kits.has(key)) kits.set(key, kitModel(name, key, part)); return kits.get(key).name; };
  const parts = [], walk = [], lights = [];
  const nPlat = Math.max(2, Math.round(Number(o.platforms ?? 4)));
  // platforms on a ring around the outcrop centre, stepped in height
  const plats = [];
  for (let i = 0; i < nPlat; i++) {
    const a = (2 * Math.PI * i) / nPlat + R(-0.3, 0.3), dist = i === 0 ? 0 : R(300, 420);
    const w = Math.round(R(220, 300) / 32) * 32, d = Math.round(R(180, 240) / 32) * 32, y = Math.round(i === 0 ? 160 : R(60, 220));
    plats.push({ x: r2(Math.sin(a) * dist), z: r2(Math.cos(a) * dist), y, w, d });
  }
  for (const [i, p] of plats.entries()) {
    parts.push({ type: 'model', model: kit(`platform_${p.w}x${p.d}_${i}`, { type: 'rock_platform', w: p.w, d: p.d, h: p.y, seed: Number(o.seed ?? 1) + i, textures: o.textures }), at: [p.x, p.y, p.z] });
    walk.push({ min: [p.x - p.w / 2, p.y + 6, p.z - p.d / 2], max: [p.x + p.w / 2, p.y + 6, p.z + p.d / 2], kind: 'platform' });
  }
  // bridges from the hub platform to the others
  for (let i = 1; i < plats.length; i++) {
    const A = plats[0], B = plats[i], dx = B.x - A.x, dz = B.z - A.z, L = Math.hypot(dx, dz);
    const ang = (Math.atan2(dx, dz) * 180) / Math.PI, inset = Math.min(A.w, A.d) / 2;
    const len = Math.max(32, L - inset - Math.min(B.w, B.d) / 2), mid = [(A.x + B.x) / 2, (A.y + B.y) / 2 + 6, (A.z + B.z) / 2];
    const slope = (Math.atan2(B.y - A.y, len) * 180) / Math.PI;
    parts.push({ type: 'bridge_walk', len: r2(len + 24), w: 32, at: mid.map(r2), rotate: [r2(-slope), r2(ang), 0] });
    walk.push({ from: [A.x, A.y + 6, A.z], to: [B.x, B.y + 6, B.z], w: 32, kind: 'bridge' });
  }
  // dress the platforms
  const hub = plats[0];
  const on = (p, dx, dz) => [r2(p.x + dx), p.y + 6, r2(p.z + dz)];
  parts.push({ type: 'model', model: kit('hab', { type: 'hab_module', len: 192, r: 44 }), at: on(hub, 0, -hub.d * 0.2) });
  parts.push({ type: 'model', model: kit('tower', { type: 'tower', h: 360, w: 24, platforms: 2 }), at: on(hub, hub.w * 0.38, hub.d * 0.35) });
  parts.push({ type: 'model', model: kit('dish', { type: 'dish', r: 56, tilt: 40, mount_h: 40 }), at: on(hub, -hub.w * 0.3, hub.d * 0.3), turn: Math.floor(R(0, 4)) });
  const roles = ['tanks', 'pad', 'industry', 'hangar', 'tanks', 'industry'];
  for (let i = 1; i < plats.length; i++) {
    const p = plats[i], role = roles[(i - 1 + Math.floor(R(0, 2))) % roles.length];
    if (role === 'tanks') {
      for (let k = 0; k < 3; k++) parts.push({ type: 'model', model: kit(`tank_${k % 2}`, { type: 'tank', r: 34, h: k % 2 ? 72 : 96, style: k % 2 ? 'capsule' : 'cylinder' }), at: on(p, -p.w * 0.3 + k * p.w * 0.3, -p.d * 0.15) });
      parts.push({ type: 'model', model: kit('sphere_tank', { type: 'tank', r: 40, style: 'sphere' }), at: on(p, p.w * 0.25, p.d * 0.25) });
      parts.push({ type: 'pipeline', path: [[p.x - p.w * 0.3, p.y + 30, p.z + p.d * 0.1], [p.x + p.w * 0.3, p.y + 30, p.z + p.d * 0.1], [hub.x, hub.y + 30, hub.z]].map((q) => q.map(r2)), r: 4, supports: 96 });
    } else if (role === 'pad') {
      parts.push({ type: 'model', model: kit('pad', { type: 'landing_pad', w: 160, mark: String(10 + i) }), at: on(p, 0, 0) });
    } else if (role === 'hangar') {
      parts.push({ type: 'model', model: kit('hangar', { type: 'hangar_shell', w: 224, d: 192, h: 112 }), at: on(p, 0, 0) });
    } else {
      parts.push({ type: 'model', model: kit('crane', { type: 'crane', h: 220, boom: 180 }), at: on(p, -p.w * 0.3, 0), rotate: [0, r2(R(0, 360)), 0] });
      parts.push({ type: 'model', model: kit('silo', { type: 'silo', r: 36, h: 200 }), at: on(p, p.w * 0.25, -p.d * 0.2) });
      parts.push({ type: 'model', model: kit('drill', { type: 'tower', h: 260, w: 40, platforms: 1, beacon: true }), at: on(p, p.w * 0.25, p.d * 0.25) });
      parts.push({ type: 'cylinder', r: 8, h: p.y + 40, at: [r2(p.x + p.w * 0.25), -20, r2(p.z + p.d * 0.25)], color: '#3a3e45', material: 'bare_metal' });
    }
    parts.push({ type: 'light', at: on(p, 0, 0).map((v, k) => (k === 1 ? v + 120 : v)), color: i % 2 ? '#ffb060' : '#a8d0ff', intensity: 1.2, range: 360, bulb: false });
    parts.push({ type: 'fog_card', w: 300, h: 140, at: [p.x, p.y - 10, p.z], color: '#8a9ab0', opacity: 0.12, cross: 2, falloff: 'vertical', rotate: [180, 0, 0] });
  }
  for (const pt of walk) if (pt.kind === 'platform') lights.push(pt);
  const def = { name, parts, grid: 32, scale: 32, origin: 'auto', notes: `mining colony (seed ${o.seed ?? 1}): ${plats.length} rock-anchored platforms, ${plats.length - 1} bridges, ${kits.size} instanced kit models (${name}_k_*). Export {instances:true, collision:"boxes"}: one shared mesh per kit piece + one node per placement.` };
  return { models: [...kits.values()], def, report: { platforms: plats.length, kit_models: kits.size, instances: parts.filter((p) => p.type === 'model').length, walkable: walk.map((w) => ({ ...w, min: w.min?.map(r2), max: w.max?.map(r2) })) } };
}

// ---------- underground market district ----------
/**
 * Underground market: a long cavern street (rock / concrete walls, a vault ceiling), stalls on both
 * sides (seeded neon / lit signs), an upper walkway level with crossing bridges, a lift shaft, pipe
 * walls, cable webs with hanging lamps, wall neon, haze cards and light shafts; cull zones along the
 * street. -> {models, def, report}
 */
export function marketDistrict(name, o = {}) {
  const rnd = mulberry32((Number(o.seed ?? 1) * 1597334677) >>> 0 || 1);
  const R = (a, b) => a + (b - a) * rnd();
  const L = Number(o.length ?? 1536), W = Number(o.width ?? 448), H = Number(o.height ?? 384);
  const street = Number(o.street ?? 160);
  const kits = new Map();
  const kit = (key, part) => { if (!kits.has(key)) kits.set(key, kitModel(name, key, part)); return kits.get(key).name; };
  const parts = [], walk = [];
  const wallT = o.textures?.wall ?? '#4a4640', floorT = o.textures?.floor ?? '#3a3a3c';
  // cavern shell: floor, side walls, end walls (one open), ceiling slabs
  parts.push({ type: 'box', w: W, h: 8, d: L, at: [0, -8, 0], texture: floorT });
  for (const s of [1, -1]) parts.push({ type: 'box', w: 16, h: H, d: L, at: [s * (W / 2 + 8), 0, 0], texture: wallT });
  parts.push({ type: 'box', w: W + 32, h: H, d: 16, at: [0, 0, -L / 2 - 8], texture: wallT });
  parts.push({ type: 'box', w: W + 32, h: 24, d: L, at: [0, H, 0], texture: o.textures?.ceiling ?? '#2c2a28' });
  parts.push({ type: 'box', w: street * 0.9, h: 0.5, d: L, at: [0, 0, 0], color: '#2a2a2c' });
  walk.push({ min: [-W / 2, 0, -L / 2], max: [W / 2, 0, L / 2], kind: 'street' });
  // stalls along both sides (3 variants each side, instanced)
  const stallW = 64, nSt = Math.floor((L - 64) / (stallW + 16));
  const words = ['NOODLE', 'FIX', 'AIR', 'PARTS', 'BAR', 'SCRAP', 'TEA', 'CHIPS', 'MEDS', 'ORE', 'SLEEP', 'DATA', 'GUNS', 'SOUP', 'VOLT'];
  const signColors = ['#ff3fd0', '#40e0ff', '#ffd040', '#60ff80', '#ff6a30'];
  for (const s of [1, -1]) for (let i = 0; i < nSt; i++) {
    if (rnd() < 0.15) continue;
    const v = Math.floor(rnd() * 3), word = words[Math.floor(rnd() * words.length)], col = signColors[Math.floor(rnd() * signColors.length)];
    const z = -L / 2 + 48 + i * (stallW + 16) + stallW / 2;
    const model = kit(`stall_${v}_${word}_${col.slice(1)}`, { type: 'market_stall', w: stallW, d: 48, h: 64 + v * 8, seed: v + 1, sign: word, neon: v !== 1, sign_color: col, awning: ['#a03028', '#2f6a5a', '#4a3a7a'][v] });
    parts.push({ type: 'model', model, at: [r2(s * (street / 2 + 30)), 0, r2(z)], turn: s > 0 ? 3 : 1 });
  }
  // upper walkways along both walls + crossing bridges
  const upY = Math.round(H * 0.45);
  for (const s of [1, -1]) {
    parts.push({ type: 'catwalk', len: L - 32, w: 48, at: [s * (W / 2 - 24), upY, 0], rails: s > 0 ? 'right' : 'left' });
    walk.push({ min: [s > 0 ? W / 2 - 48 : -W / 2, upY, -L / 2 + 16], max: [s > 0 ? W / 2 : -W / 2 + 48, upY, L / 2 - 16], kind: 'walkway' });
  }
  const nb = Math.max(1, Math.round(Number(o.bridges ?? 3)));
  for (let b = 0; b < nb; b++) { const z = r2(-L / 2 + (L * (b + 0.5)) / nb + R(-40, 40)); parts.push({ type: 'model', model: kit('bridge', { type: 'bridge_walk', len: W - 96, w: 40 }), at: [0, upY, z], rotate: [0, 90, 0] }); walk.push({ from: [-W / 2 + 48, upY, z], to: [W / 2 - 48, upY, z], w: 40, kind: 'bridge' }); }
  // lift shaft at the closed end, pipe walls and wall neon
  parts.push({ type: 'model', model: kit('lift', { type: 'lift_shaft', h: H - 8, w: 64 }), at: [r2(W / 2 - 80), 0, r2(-L / 2 + 64)] });
  for (let k = 0; k < 4; k++) parts.push({ type: 'model', model: kit(`pipes_${k % 2}`, { type: 'pipe_wall', w: 160, h: 112, count: 7, seed: 5 + (k % 2) }), at: [r2((k % 2 ? 1 : -1) * (W / 2 - 4)), r2(upY + 40), r2(-L / 2 + 240 + k * (L / 4))], turn: k % 2 ? 3 : 1 });
  const big = ['MARKET', 'LEVEL 9', 'NO GUNS', 'SLEEP 24', 'ORE XCHG'];
  for (let k = 0; k < 5; k++) { const s = k % 2 ? 1 : -1; parts.push({ type: 'neon', text: big[k], px: 3, r: 1, color: signColors[(k + Number(o.seed ?? 1)) % signColors.length], at: [r2(s * (W / 2 - 2)), r2(upY + 80 + R(0, 60)), r2(-L / 2 + 160 + k * (L / 5.5))], rotate: [0, s > 0 ? -90 : 90, 0] }); }
  // cable webs with lamps across the street, haze and light shafts
  for (let k = 0; k < Math.round(L / 256); k++) { const z = -L / 2 + 128 + k * 256; parts.push({ type: 'cable_web', from: [-W / 2, H - 40, z], to: [W / 2, H - 40, z + R(-60, 60)], count: 4, sag: 48, spread: 24, lamps: 2, lamp_color: k % 2 ? '#ffb060' : '#ff6a90', seed: k + 1 }); }
  for (let k = 0; k < 4; k++) parts.push({ type: 'fog_card', w: W * 0.8, h: 120, at: [0, 60, r2(-L / 2 + L * (k + 0.5) / 4)], falloff: 'vertical', color: '#806080', opacity: 0.1, cross: 1, rotate: [180, 0, 0] });
  for (let k = 0; k < 3; k++) parts.push({ type: 'god_ray', w: 64, h: H * 0.9, at: [r2(R(-60, 60)), H, r2(-L / 2 + L * (k + 0.5) / 3)], color: '#9ab8ff', opacity: 0.12 });
  parts.push({ type: 'light', at: [0, H - 20, 0], color: '#6a7aa8', intensity: 0.8, range: L * 0.6, bulb: false });
  // cull zones along the street (the open end connects to "outside")
  const zones = Math.max(2, Math.round(Number(o.zones ?? 3)));
  const rooms = [...Array(zones).keys()].map((k) => ({ name: `zone_${k}`, min: [-W / 2 - 16, -8, r2(-L / 2 + (L * k) / zones)], max: [W / 2 + 16, H + 24, r2(-L / 2 + (L * (k + 1)) / zones)] }));
  // instanced layouts cannot carry #7 cull rooms (export instances + cull is not supported): zones ride as marker nodes
  for (const r of rooms) parts.push({ type: 'marker', kind: 'cull_zone', at: [0, r.min[1], r2((r.min[2] + r.max[2]) / 2)], data: { zone: r.name, w: r.max[0] - r.min[0], h: r.max[1] - r.min[1], d: r.max[2] - r.min[2] } });
  const def = { name, parts, grid: 32, scale: 32, origin: 'auto', notes: `underground market (seed ${o.seed ?? 1}): ${L / 32} m street, ${parts.filter((p) => p.type === 'model' && /stall/.test(p.model)).length} stalls (${[...kits.keys()].filter((k) => k.startsWith('stall')).length} instanced variants), upper walkways + ${nb} bridges, lift shaft, cable webs with lamps, neon. Export {instances:true, collision:"boxes"}; cull zones = marker nodes cull_zone_<k> (extras w/h/d units: assign instances by position, portal = the shared face).` };
  return { models: [...kits.values()], def, report: { stalls: parts.filter((p) => p.type === 'model' && /stall/.test(p.model)).length, kit_models: kits.size, instances: parts.filter((p) => p.type === 'model').length, walkable: walk.map((w) => ({ ...w, ...(w.min ? { min: w.min.map(r2), max: w.max.map(r2) } : {}) })), cull_zones: zones } };
}
