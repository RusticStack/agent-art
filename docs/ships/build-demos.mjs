// Rebuilds the ships + structures demo renders in docs/ships/:
//   node docs/ships/build-demos.mjs [out dir]
// Three original ships (fighter: canopy open + gear down; dropship: ramp open; modular hauler with
// container racks), a capital ring module, a ship interior (engine room + corridor), a mining
// colony and an underground market with neon. Each gets a before / after detail pass, LOD stats,
// triangles and draw calls; renders use the dark "mood" lighting (light markers as point lights).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Engine } from '../../src/engine.js';
import { packImages } from '../../src/sheet.js';
import { encodePNG, decodePNG } from '../../src/png.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(process.argv[2] || here);
fs.mkdirSync(OUT, { recursive: true });
const e = new Engine({ home: fs.mkdtempSync(path.join(os.tmpdir(), 'aa-ships-')) });
const run = (op, a) => e.run(op, a, 'agent');
const log = [];
const stats = {};
const t0 = performance.now();

run('model_kit', {});

/** Mood preview image (decoded PNG) of a model. */
const view = (name, views, size, mood = true) => decodePNG(run('model_preview', { name, views, size, mood }).image);
const sheet = (file, items, columns) => {
  const img = packImages(items, { labels: true, checker: false, columns: columns ?? items.length });
  fs.writeFileSync(path.join(OUT, file), encodePNG(img.width, img.height, img.data));
  log.push(`${file}: ${img.width}x${img.height}`);
};
const record = (key, name, extra = {}) => {
  const b = run('model_budget', { name, ...(extra.class ? { class: extra.class } : {}) });
  const ex = run('model_export', { name, path: path.join(os.tmpdir(), 'aa-ships-out', `${name}.glb`), ...(extra.export || {}) });
  stats[key] = { model: name, class: b.class, triangles: b.triangles, budget: b.budget.triangles, verdict: b.verdict, lods: b.lod_estimate.map((l) => l.triangles), draw_calls: b.draw_calls, materials: b.materials, export: { triangles: ex.triangles, nodes: ex.nodes, materials: ex.materials, bytes: ex.bytes, ...(ex.split ? { split: ex.split } : {}), ...(ex.lods ? { lods: ex.lods } : {}), ...(ex.lights !== undefined ? { lights: ex.lights, markers: ex.markers } : {}) } };
  return stats[key];
};

// ---------- 1. fighter: canopy open, gear down (static pose bake = the rest pose, open canopy pose) ----------
run('model_create', { name: 'fighter_base', template: 'fighter', seed: 7, rigged: false, set: {} });
// "before": hull + wings only, no panel lines / greebles / plates
const fb = run('model_info', { name: 'fighter_base' }).parts_def;
run('model_create', { name: 'fighter_before', parts: fb.filter((p) => ['hull', 'wing', 'canopy', 'engine'].includes(p.type)).map((p) => (p.type === 'hull' ? { ...p, panel_lines: undefined, plates: undefined, texture: '#7a8089' } : p)) });
run('model_create', { name: 'fighter', template: 'fighter', seed: 7, textures: 'kit', canopy: 'open' });
run('model_livery', { name: 'fighter', canvas: 'fighter_livery', primary: '#6e7682', secondary: '#2f343b', stripes: [{ t: [0.6, 0.64], color: '#b8462e' }], hazard: [{ t: [0.83, 0.86], u: [0.44, 0.56] }], decals: [{ text: 'VK-07', t: 0.45, side: ['left', 'right'], size: 2 }, { text: 'NO STEP', t: 0.32, side: 'top', size: 1, color: '#d09a28' }], mark: { t: 0.18, side: ['left', 'right'], seed: 11, color: '#e8e4d8' }, wear: 0.4 });
run('model_pose', { name: 'fighter', pose: 'canopy_up', parts: { canopy: { rot: [-60, 0, 0] } } });
sheet('fighter_before_after.png', [
  { img: view('fighter_before', [{ yaw: 35, pitch: 24, perspective: true, fov: 30 }], 384), label: 'before: hull + wings' },
  { img: decodePNG(run('model_preview', { name: 'fighter', pose: 'canopy_up', mood: true, views: [{ yaw: 35, pitch: 24, perspective: true, fov: 30 }], size: 384 }).image), label: 'after: canopy open, gear down' },
  { img: view('fighter', ['side'], 384), label: 'side (mood)' },
]);
record('fighter', 'fighter', { export: { static: 'canopy_up', lods: [1, 0.5, 0.2], split: true } });

// ---------- 2. dropship: ramp open ----------
run('model_create', { name: 'dropship_static', template: 'dropship', seed: 3, rigged: false, ramp: 'open', textures: 'kit' });
run('model_create', { name: 'dropship_before', parts: run('model_info', { name: 'dropship_static' }).parts_def.filter((p) => p.type === 'hull').map((p) => ({ ...p, panel_lines: undefined, plates: undefined, texture: '#7a8089' })) });
run('model_create', { name: 'dropship', template: 'dropship', seed: 3, textures: 'kit' });
run('model_livery', { name: 'dropship', canvas: 'dropship_livery', primary: '#7d7a6a', secondary: '#3a3b36', stripes: [{ t: [0.7, 0.74], color: '#d09a28' }], hazard: [{ t: [0.0, 0.05], u: [0.35, 0.65] }], decals: [{ text: 'D-42', t: 0.55, size: 3 }], mark: { t: 0.3, seed: 4 }, wear: 0.55 });
run('model_pose', { name: 'dropship', pose: 'deployed', parts: { ramp: { rot: [-118, 0, 0] } } });
sheet('dropship_before_after.png', [
  { img: view('dropship_before', [{ yaw: 150, pitch: 22, perspective: true, fov: 30 }], 384), label: 'before: hull' },
  { img: decodePNG(run('model_preview', { name: 'dropship', pose: 'deployed', mood: true, views: [{ yaw: 150, pitch: 22, perspective: true, fov: 30 }], size: 384 }).image), label: 'after: ramp open (rear)' },
  { img: view('dropship_static', ['side'], 384), label: 'static variant (side)' },
]);
record('dropship', 'dropship', { export: { static: 'deployed', lods: [1, 0.5, 0.25, 0.1], split: true } });

// ---------- 3. modular hauler ----------
run('model_create', { name: 'hauler', template: 'hauler', seed: 5, bays: 3, rigged: false, textures: 'kit' });
run('model_create', { name: 'hauler_before', template: 'hauler', seed: 5, bays: 3, rigged: false, fill: 0 });
sheet('hauler_before_after.png', [
  { img: view('hauler_before', [{ yaw: 40, pitch: 26, perspective: true, fov: 30 }], 384), label: 'before: empty racks, flat' },
  { img: view('hauler', [{ yaw: 40, pitch: 26, perspective: true, fov: 30 }], 384), label: 'after: kit textures, containers' },
  { img: view('hauler', ['top'], 384), label: 'top' },
]);
record('hauler', 'hauler', { export: { lods: [1, 0.5, 0.25, 0.1], split: true, impostor: { grid: 6, size: 48 } } });

// ---------- 4. capital ring module ----------
run('model_create', { name: 'ring', template: 'capital_ring', segments: 20, textures: 'kit' });
run('model_create', { name: 'ring_before', parts: run('model_info', { name: 'ring' }).parts_def.filter((p) => p.type === 'hull' || p.type === 'revolve').map((p) => ({ ...p, panel_lines: undefined, plates: undefined, texture: '#7a8089' })) });
sheet('capital_ring_before_after.png', [
  { img: view('ring_before', ['iso'], 384), label: 'before: segments + hub' },
  { img: view('ring', ['iso'], 384), label: 'after: spokes, arms, windows' },
  { img: view('ring', [{ pos: [2900, 700, 1700], look: [1700, 180, 300], fov: 50 }], 384), label: 'close: segments, turrets, arm' },
]);
record('capital_ring', 'ring', { class: 'capital', export: { lods: [1, 0.4, 0.15], split: true } });

// ---------- 5. ship interior (from the dropship hull) ----------
const intr = run('model_generate', { kind: 'interior', name: 'dropship_interior', hull: 'dropship', seed: 2, textures: { floor: 'kit_deck', wall: 'kit_wall', ceiling: 'kit_metal_dark' } });
log.push(`interior: ${intr.rooms.map((r) => r.kind).join(', ')}; doors ${intr.doors.length}; windows on ship ${intr.windows_on_ship}; alignment ${JSON.stringify(intr.alignment)}`);
run('model_create', { name: 'engine_corridor', parts: [{ type: 'engine_room', cells: [3, 3], openings: { n: [{ at: 1, kind: 'door' }] }, textures: { floor: 'kit_deck', wall: 'kit_wall', ceiling: 'kit_metal_dark' } }, { type: 'corridor', len: 3, at: [0, 0, 64 * 3], textures: { floor: 'kit_deck', wall: 'kit_wall', ceiling: 'kit_metal_dark' } }, { type: 'door', at: [0, 0, 64 * 1.5 + 2], open: 0.6 }] });
run('model_create', { name: 'engine_corridor_before', parts: [{ type: 'room', cells: [3, 3], h: 160, openings: { n: [{ at: 1, kind: 'door' }] }, ribs: false, pipes: false, lights: false }, { type: 'corridor', len: 3, at: [0, 0, 64 * 3], ribs: false, pipes: false, lights: false, greebles: false }] });
const inside = { pos: [86, 34, 86], look: [-20, 92, -20], fov: 80 }, corr = { pos: [0, 62, 280], look: [0, 50, 40], fov: 70 };
// deck plan: the generated interior with its ceilings left off
run('model_create', { name: 'deck_plan', parts: run('model_info', { name: 'dropship_interior' }).parts_def.map((p) => ({ ...p, ceiling: false })) });
sheet('interior_before_after.png', [
  { img: view('engine_corridor_before', [inside], 384), label: 'before: room shells' },
  { img: view('engine_corridor', [inside], 384), label: 'after: reactor, cage, conduits' },
  { img: view('engine_corridor', [corr], 384), label: 'corridor toward the engine room' },
  { img: view('deck_plan', [{ yaw: 0, pitch: 70, perspective: true, fov: 30 }], 384), label: 'generated deck plan (dropship)' },
], 4);
record('interior', 'engine_corridor', { class: 'room', export: { cull: { rooms: [{ name: 'engine', min: [-96, -4, -96], max: [96, 100, 96] }, { name: 'corridor', min: [-32, -4, 96], max: [32, 100, 288] }] } } });
record('dropship_interior', 'dropship_interior', { class: 'building' });

// ---------- 6. mining colony ----------
const col = run('model_generate', { kind: 'mining_colony', name: 'colony', seed: 9, platforms: 5 });
log.push(`colony: ${col.platforms} platforms, ${col.kit_models} kit models, ${col.instances} instances`);
sheet('mining_colony.png', [
  { img: view('colony', ['iso'], 512, false), label: 'colony (plain light)' },
  { img: view('colony', [{ yaw: 200, pitch: 18, perspective: true, fov: 45 }], 512), label: 'colony at night (mood)' },
]);
record('mining_colony', 'colony', { class: 'district', export: { instances: true, collision: 'boxes' } });

// ---------- 7. underground market with neon ----------
const mk = run('model_generate', { kind: 'market', name: 'market', seed: 4 });
log.push(`market: ${mk.stalls} stalls, ${mk.kit_models} kit models, cull zones ${mk.cull_zones}`);
const street = { pos: [0, 70, 700], look: [0, 90, 0], fov: 60 };
sheet('underground_market.png', [
  { img: view('market', [street], 512), label: 'street level (mood)' },
  { img: view('market', [{ pos: [150, 220, -500], look: [0, 80, 200], fov: 60 }], 512), label: 'from the upper walkway' },
]);
record('market', 'market', { class: 'district', export: { instances: true, collision: 'boxes' } });

// ---------- kit sheet ----------
const kitPieces = [['tank', { type: 'tank', style: 'capsule' }], ['dish', { type: 'dish' }], ['crane', { type: 'crane', h: 160, boom: 120 }], ['truss', { type: 'truss', length: 160, axis: 'x', style: 'x' }], ['catwalk', { type: 'catwalk' }], ['pad', { type: 'landing_pad', w: 128, mark: '07' }], ['hab', { type: 'hab_module' }], ['stall', { type: 'market_stall', sign: 'NOODLE', neon: true }], ['neon', { type: 'neon', text: 'OPEN 24' }], ['gear', { type: 'landing_gear', h: 24 }], ['turret', { type: 'turret' }], ['containers', { type: 'container_rack', layers: 1 }]];
for (const [k, p] of kitPieces) run('model_create', { name: `kit_${k}`, parts: [p] });
sheet('kit_pieces.png', kitPieces.map(([k]) => ({ img: view(`kit_${k}`, ['iso'], 192, k === 'neon' || k === 'stall'), label: k })), 6);

fs.writeFileSync(path.join(OUT, 'stats.json'), JSON.stringify(stats, null, 2));
console.log(log.join('\n'));
for (const [k, s] of Object.entries(stats)) console.log(`${k}: ${s.triangles} tris (${s.class} budget ${s.budget}: ${s.verdict}); LOD est ${s.lods.join(' / ')}; draw ${JSON.stringify(s.draw_calls)}; export ${JSON.stringify(s.export)}`);
console.log(`total ${Math.round(performance.now() - t0)} ms`);
