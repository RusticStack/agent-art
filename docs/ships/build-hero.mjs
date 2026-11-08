// Rebuilds the headline hero-ship renders in docs/ships/:
//   node docs/ships/build-hero.mjs [out dir]
// The ORIGINAL "ORVANE TERN" VTOL gunship (art_model create {template:"gunship"}): a 6-angle
// exterior turntable with the gear down and the thruster pods turned down, three in-flight angles
// with the pods rotated and the gear up, four interior eye-height shots (down the corridor to the
// cockpit, the airlock from inside, the weapon rack, the pilot seat from behind), a 1.8 m figure
// for scale, the walk_check report and triangle / draw-call / LOD numbers (hero_stats.json).
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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-hero-'));
const e = new Engine({ home: tmp });
const run = (op, a) => e.run(op, a, 'agent');
const t0 = performance.now();
const stats = {};
const sheet = (file, items, columns) => {
  const img = packImages(items, { labels: true, checker: false, columns: columns ?? items.length });
  fs.writeFileSync(path.join(OUT, file), encodePNG(img.width, img.height, img.data));
  console.log(`${file}: ${img.width}x${img.height}`);
};
const AO = { texel: 3, samples: 20 };
// exterior: brighter key + fill and a sky / ground gradient so the faceted form reads (preview only)
const EXT = { mood: { sky: true, key: { strength: 1.75 }, ambient: 0.42, fill: { strength: 0.75 } } };
const shot = (name, view, size = 384, extra = {}) => ({ img: decodePNG(run('model_preview', { name, views: [view], size, mood: true, ao: AO, ...extra }).image) });

// ---------- the ship: landed (pods down, gear down), in flight (pods level, gear up), rigged ----------
run('model_create', { name: 'tern', template: 'gunship', rigged: false, seed: 4 });
run('model_create', { name: 'tern_flight', template: 'gunship', rigged: false, seed: 4, vtol: 'flight', gear: 'up' });
run('model_create', { name: 'tern_open', template: 'gunship', rigged: false, seed: 4, airlock: 'open' });
run('model_create', { name: 'tern_rig', template: 'gunship', seed: 4 });
// scenes: a pad to stand on, a 1.8 m figure at the boarding ladder, distant rocks for the view out of the cockpit
const ground = [{ type: 'landing_pad', w: 1100, h: 4, at: [0, -4, 0], mark: '07' }];
const rocks = [[-700, 1500, 1], [500, 1900, 2], [1400, 1200, 3], [-1500, 900, 4], [100, 2600, 5]].map(([x, z, s]) => ({ type: 'rock', w: 600, h: 260 + s * 40, d: 500, at: [x, -20, z], seed: s, detail: 2, texture: 'kit_rock' }));
run('model_create', { name: 'tern_scene', parts: [{ type: 'model', model: 'tern' }, { type: 'figure', at: [-170, 0, -40], rotate: [0, 90, 0] }, ...ground] });
run('model_create', { name: 'tern_interior', parts: [{ type: 'model', model: 'tern_open' }, { type: 'figure', at: [0, 78, 40], rotate: [0, 180, 0], color: '#c8ccd0' }, ...ground, ...rocks] });

// ---------- exterior turntable (6 angles, gear down) ----------
const orbit = (yaw, r = 1250, h = 300, fov = 40) => { const a = (yaw * Math.PI) / 180; return { pos: [Math.round(Math.sin(a) * r), h, Math.round(Math.cos(a) * r)], look: [0, 110, 0], fov }; };
const turn = [30, 90, 150, 210, 270, 330].map((yaw) => ({ ...shot('tern_scene', orbit(yaw), 384, EXT), label: `yaw ${yaw}` }));
sheet('hero_turntable.png', turn, 3);
// ---------- in flight (pods rotated level, gear up) ----------
sheet('hero_flight.png', [
  { ...shot('tern_flight', orbit(40, 1150, 420), 384, EXT), label: 'in flight: pods level' },
  { ...shot('tern_flight', { pos: [700, -260, -900], look: [0, 110, 0], fov: 40 }, 384, EXT), label: 'from below / behind' },
  { ...shot('tern_flight', { yaw: 0, pitch: 70, perspective: true, fov: 30 }, 384, EXT), label: 'top' },
]);
// ---------- scale + detail ----------
sheet('hero_scale.png', [
  { ...shot('tern_scene', { pos: [-1150, 120, -40], look: [0, 110, -40], fov: 42 }, 512, EXT), label: 'side, 1.8 m figure at the ladder' },
  { ...shot('tern_scene', { pos: [-300, 70, 40], look: [-110, 90, -40], fov: 50 }, 512, EXT), label: 'airlock + boarding ladder' },
]);
sheet('hero_details.png', [
  { ...shot('tern', { pos: [120, 120, 620], look: [0, 90, 330], fov: 45 }, 384, EXT), label: 'wrap canopy, sensor cage, chin block + guns' },
  { ...shot('tern', { pos: [520, 260, 140], look: [330, 180, -60], fov: 50 }, 384, EXT), label: 'sponson, wing pylon, nacelle, gun pod' },
  { ...shot('tern', { pos: [160, 110, -720], look: [0, 110, -400], fov: 45 }, 384, EXT), label: 'main thrusters, chevrons' },
]);
// ---------- interior, eye height (1.65 m = 52.8 px above the 78 px deck) ----------
const eye = 78 + 52.8;
sheet('hero_interior.png', [
  { ...shot('tern_interior', { pos: [0, eye, -150], look: [0, eye - 8, 300], fov: 72 }, 448), label: 'corridor to the cockpit' },
  { ...shot('tern_interior', { pos: [34, eye, -40], look: [-120, eye - 18, -40], fov: 75 }, 448), label: 'airlock from inside' },
  { ...shot('tern_interior', { pos: [-24, eye - 6, -96], look: [47, eye - 20, -96], fov: 62 }, 448), label: 'weapon rack' },
  { ...shot('tern_interior', { pos: [0, eye + 6, 214], look: [0, eye - 18, 420], fov: 75 }, 448), label: 'pilot seat from behind' },
], 2);

// ---------- walk_check, budget, exports ----------
const wc = run('model_walk_check', { name: 'tern_rig' });
const b = run('model_budget', { name: 'tern' });
const exp = (file, extra) => run('model_export', { name: 'tern_rig', path: path.join(tmp, file), ...extra });
const full = exp('tern.glb', { static: 'landed', lods: [1, 0.5, 0.25, 0.1], split: true, walk: true });
const atlas = exp('tern_atlas.glb', { static: 'landed', atlas: true });
const rig = exp('tern_rigged.glb', { walk: true });
stats.hero = {
  model: 'gunship (ORVANE TERN, original)', length_m: 25, class: b.class, triangles: b.triangles, budget: b.budget.triangles, verdict: b.verdict,
  lod_estimate: b.lod_estimate.map((l) => l.triangles), materials: b.materials, draw_calls: b.draw_calls,
  export_static_lods: { triangles: full.triangles, nodes: full.nodes, bytes: full.bytes, lods: full.lods, split: full.split, walk: full.walk },
  export_atlas: { triangles: atlas.triangles, materials: atlas.materials, bytes: atlas.bytes },
  export_rigged: { nodes: rig.nodes, animations: rig.animations, walk: rig.walk },
  walk_check: { ok: wc.ok, problems: wc.problems, counts: wc.counts, areas: wc.areas.map((a) => `${a.name} ${a.size_m.join('x')} m`) },
};
fs.writeFileSync(path.join(OUT, 'hero_stats.json'), JSON.stringify(stats, null, 2));
console.log(JSON.stringify(stats, null, 1));
console.log(`total ${Math.round(performance.now() - t0)} ms`);
