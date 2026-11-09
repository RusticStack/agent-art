// art_model ships + structures (0.8): hulls from design curves, panel lines / plates / carving,
// assemblies with sockets + clips (gear, ramp, canopy), interiors fitted inside hulls with doors
// and windows lined up, truss generator, neon text, seeded layout generators, triangle budgets and
// mesh splitting, markers -> nodes, mood previews, kit textures and livery.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { Engine } from '../src/engine.js';
import { buildModel, Mesh } from '../src/model3d.js';
import { hullSurface, curve, makeSection } from '../src/hull.js';
import { expandDef, ASSEMBLIES } from '../src/kitparts.js';
import { pixelStrokes, textPixels } from '../src/structures.js';
import { interiorFromHull, insideHull, miningColony, marketDistrict } from '../src/layoutgen.js';
import { splitMesh, SCALE_CLASSES, shipClass } from '../src/modelkit.js';
import { SHIP_TEMPLATES } from '../src/shipgen.js';
import { helpText } from '../src/docs.js';
import { SKILLS } from '../src/skills.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'agent-art-ships-'));
const texCtx = () => {
  const cache = new Map();
  const tex = (ref) => {
    const k = typeof ref === 'string' ? ref : JSON.stringify(ref);
    if (!cache.has(k)) cache.set(k, { key: k, name: 't', width: 8, height: 8, data: new Uint8ClampedArray(256).fill(160) });
    return cache.get(k);
  };
  return { tex, getModel: () => { throw new Error('no models'); } };
};
const build = (parts, extra = {}) => { const b = buildModel({ name: 'm', parts, ...extra }, texCtx()); b.mesh.markers = b.markers; return b.mesh; };

/** Closed + outward: directed edges pair up (welded positions), the area vectors cancel, volume > 0. */
function closedStats(mesh) {
  const key = (g, v) => `${Math.round(g.pos[v * 3] * 1000)},${Math.round(g.pos[v * 3 + 1] * 1000)},${Math.round(g.pos[v * 3 + 2] * 1000)}`;
  const edges = new Map();
  let vol = 0, area = 0;
  const sum = [0, 0, 0];
  for (const g of mesh.groups.values()) {
    if (g.overlay) continue;
    for (let i = 0; i < g.idx.length; i += 3) {
      const v = [g.idx[i], g.idx[i + 1], g.idx[i + 2]], P = v.map((k) => [g.pos[k * 3], g.pos[k * 3 + 1], g.pos[k * 3 + 2]]);
      const u = P[1].map((x, j) => x - P[0][j]), w = P[2].map((x, j) => x - P[0][j]);
      const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
      for (let j = 0; j < 3; j++) sum[j] += n[j];
      area += Math.hypot(...n) / 2;
      vol += (P[0][0] * (P[1][1] * P[2][2] - P[1][2] * P[2][1]) - P[0][1] * (P[1][0] * P[2][2] - P[1][2] * P[2][0]) + P[0][2] * (P[1][0] * P[2][1] - P[1][1] * P[2][0])) / 6;
      for (let k = 0; k < 3; k++) { const a = key(g, v[k]), b = key(g, v[(k + 1) % 3]); if (a === b) continue; const e = `${a}|${b}`; edges.set(e, (edges.get(e) || 0) + 1); }
    }
  }
  let unpaired = 0;
  for (const [e, c] of edges) { const [a, b] = e.split('|'); if ((edges.get(`${b}|${a}`) || 0) !== c) unpaired++; }
  return { vol, open: Math.hypot(...sum) / Math.max(1, area), unpaired };
}

test('hull: loft from plan + profile + sections is closed, outward and follows the curves', () => {
  const H = { type: 'hull', length: 320, plan: [[0, 20], [0.5, 40], [1, 4]], profile: [[0, 30, 4], [0.5, 40, 0], [1, 14, 10]], sections: [[0, 'box'], [0.6, 2.6]], rings: 12, segments: 16 };
  const m = build([H]);
  const s = closedStats(m);
  assert.ok(s.vol > 0, 'positive volume (outward)');
  assert.ok(s.open < 1e-6, `closed (area vectors cancel: ${s.open})`);
  assert.equal(s.unpaired, 0, 'every edge shared by two faces');
  const S = hullSurface(H);
  // half-width at the mid station = the plan value; top / bottom = the profile
  assert.ok(Math.abs(Math.max(...[...Array(64).keys()].map((k) => S.point(0.5, k / 64)[0])) - 40) < 0.5);
  assert.ok(Math.abs(S.point(0.5, 0)[1] - 40) < 1e-6 && Math.abs(S.point(0.5, 0.5)[1]) < 1e-6);
  assert.equal(S.z(1), 160);
  // monotone cubic: never overshoots between knots
  const f = curve([[0, 0], [0.5, 10], [1, 10]]);
  for (let t = 0; t <= 1; t += 0.05) assert.ok(f(t) <= 10 + 1e-9 && f(t) >= -1e-9);
  // polygon section keeps its corners as grid columns (hard creases)
  assert.ok(makeSection('box').corners.length >= 4);
  assert.throws(() => build([{ ...H, plan: [[2, 10]] }]), /t must be 0..1/);
  assert.throws(() => build([{ ...H, sections: undefined, section: 'blob' }]), /unknown/);
});

test('hull: panel-line grooves, plates and mask carving recess / raise quads and stay closed', () => {
  const base = { type: 'hull', length: 320, width: 80, height: 40, rings: 12, segments: 16, groove: '#111111', texture: '#888888' };
  const plain = build([base]);
  const grooved = build([{ ...base, panel_lines: { rings: [0.3, 0.6], seams: [0.2], width: 2, depth: 1.5 }, plates: [{ t: [0.4, 0.5], u: [0.22, 0.3], lift: 2 }] }]);
  const s = closedStats(grooved);
  assert.ok(s.open < 1e-6 && s.vol > 0, 'closed after relief');
  assert.equal(s.unpaired, 0, 'walls join the levels watertight');
  assert.ok(grooved.triangles > plain.triangles + 100, `${grooved.triangles} vs ${plain.triangles}`);
  // groove floor vertices sit 1.5 px inside the surface at t 0.3
  const S = hullSurface(base);
  const g = [...grooved.groups.values()].find((x) => x.tex.key === '#111111');
  assert.ok(g, 'groove material');
  let deepest = 0;
  for (let i = 0; i < g.pos.length; i += 3) {
    const t = S.tOf(g.pos[i + 2]);
    if (Math.abs(t - 0.3) > 0.004) continue;
    const y = g.pos[i + 1], hw = S.halfWidthAt(t, y);
    if (Math.abs(g.pos[i]) < 0.8 * S.extentAt(t).w) continue; // side wall only: there the normal is ~x
    deepest = Math.max(deepest, hw - Math.abs(g.pos[i]));
  }
  assert.ok(deepest > 1 && deepest < 3, `groove depth ${deepest}`); // 1.5 px along the normal (horizontal on a curved side reads a little deeper)
  // plates are raised: the hull bounds grow by about the lift on that side
  assert.ok(grooved.bounds().max[0] > plain.bounds().max[0] + 1);
  // carve mask: opaque pixels recess hull quads
  const e = new Engine({ home: tmp() });
  e.run('create', { name: 'mask', width: 16, height: 16 });
  e.run('draw', { canvas: 'mask', commands: [{ op: 'rect', x: 2, y: 4, w: 3, h: 6, color: '#fff' }] });
  e.run('model_create', { name: 'carved', parts: [{ ...base, carve: { mask: 'mask', depth: 2 } }] });
  e.run('model_create', { name: 'uncarved', parts: [base] });
  assert.ok(e.run('model_info', { name: 'carved' }).triangles > e.run('model_info', { name: 'uncarved' }).triangles);
});

test('assemblies: gear, ramp and canopy expand to nodes, sockets and merged clips; static state without names', () => {
  const H = { type: 'hull', id: 'hull', name: 'hull', length: 320, width: 80, height: 40, at: [0, 30, 0] };
  const def = { name: 's', parts: [H,
    { type: 'canopy', name: 'canopy', parent: 'hull', on_hull: { hull: 'hull', t: 0.75, u: 0 } },
    { type: 'landing_gear', name: 'gear_l', parent: 'hull', at: [20, 30, 60], h: 28 },
    { type: 'landing_gear', name: 'gear_r', parent: 'hull', at: [-20, 30, 60], h: 28 },
    { type: 'ramp', name: 'ramp', parent: 'hull', at: [0, 31, -162], w: 40, len: 30 },
  ] };
  const x = expandDef(def);
  assert.notEqual(x, def);
  const names = x.parts.filter((p) => p.name).map((p) => p.name);
  for (const n of ['canopy', 'gear_l', 'gear_l.piston', 'gear_l.foot', 'gear_l.door_l', 'gear_r', 'ramp']) assert.ok(names.includes(n), n);
  assert.ok(x.sockets.gear_l_contact && x.sockets.gear_r_contact && x.sockets.canopy_seat);
  const gr = x.clips.gear_retract;
  assert.ok(gr.keys.at(-1).parts['gear_l'] && gr.keys.at(-1).parts['gear_r'], 'one gear_retract clip moves every leg');
  assert.deepEqual(gr.keys.map((k) => k.t), [0, 0.4, 1.2, 1.6]);
  assert.ok(x.clips.gear_deploy && x.clips.canopy_open && x.clips.ramp_open);
  // contact socket: foot bottom at the ground (mount 30 - strut 28 - pad)
  assert.ok(x.sockets.gear_l_contact.at[1] < 2 && x.sockets.gear_l_contact.at[1] > -3);
  // through the engine: rig export has the clips as glTF animations + socket nodes
  const e = new Engine({ home: tmp() });
  e.run('model_create', def);
  const info = e.run('model_info', { name: 's' });
  assert.ok(info.rig && info.rig.clips.gear_retract && info.rig.clips.ramp_open);
  const p = e.run('model_preview', { name: 's', clip: 'gear_retract', frames: 3, view: 'side' });
  assert.ok(p.image.length > 1000);
  const out = path.join(tmp(), 's.glb');
  const r = e.run('model_export', { name: 's', path: out });
  for (const c of ['gear_retract', 'gear_deploy', 'canopy_open', 'ramp_open']) assert.ok(r.animations.includes(c), c);
  assert.ok(r.sockets.includes('socket_gear_l_contact'));
  // the ramp clip swings the panel down past horizontal (open_angle 112)
  const ramp = x.clips.ramp_open.keys.at(-1).parts.ramp.rot[0];
  assert.ok(ramp < -90);
  // static: no nodes, open state baked
  const st = expandDef({ name: 't', parts: [{ type: 'ramp', w: 40, len: 30, open: 1 }, { type: 'landing_gear', deployed: false }] });
  assert.ok(!st.parts.some((q) => q.name));
  assert.ok(!st.clips);
  assert.ok(st.parts[0].rotate[0] < -90, 'static ramp rotated open');
  // every registered assembly builds with its defaults
  // (glazing fills an opening of a hull, so it gets one)
  const H0 = { type: 'hull', id: 'h', length: 200, openings: [{ t: [0.6, 0.8], u: [0.9, 0.1] }] };
  for (const t of Object.keys(ASSEMBLIES)) assert.doesNotThrow(() => build(t === 'glazing' ? [H0, { type: t, hull: 'h', t: [0.6, 0.8], u: [0.9, 0.1] }] : [{ type: t }]), t);
});

test('templates: four original ships build, stay in their class budget and keep gear contact at y=0', () => {
  const ctx = texCtx();
  for (const [t, o] of [['fighter', {}], ['dropship', {}], ['hauler', { bays: 2 }], ['capital_ring', { segments: 12 }]]) {
    const tpl = SHIP_TEMPLATES[t]({ seed: 3, ...o });
    const b = buildModel({ name: t, parts: tpl.parts }, ctx);
    assert.ok(b.mesh.triangles > 1000, t);
    const L = Math.max(...[0, 2].map((k) => b.mesh.bounds().max[k] - b.mesh.bounds().min[k]));
    const cls = t === 'capital_ring' ? 'capital' : shipClass(L);
    assert.ok(b.mesh.triangles <= SCALE_CLASSES[cls].triangles, `${t}: ${b.mesh.triangles} > ${cls} ${SCALE_CLASSES[cls].triangles}`);
    if (t !== 'capital_ring') assert.ok(Math.abs(b.mesh.bounds().min[1]) < 1.5, `${t} rests on y=0 (${b.mesh.bounds().min[1]})`);
    assert.ok((b.markers || []).some((k) => k.kind === 'light'), `${t} light markers`);
  }
  // same seed = same ship; another seed differs
  assert.deepEqual(SHIP_TEMPLATES.fighter({ seed: 5 }), SHIP_TEMPLATES.fighter({ seed: 5 }));
  assert.notDeepEqual(SHIP_TEMPLATES.fighter({ seed: 5 }), SHIP_TEMPLATES.fighter({ seed: 6 }));
});

test('interior from hull: fits inside, doors meet the exterior ramp, windows line up with the hull', () => {
  const e = new Engine({ home: tmp() });
  e.run('model_create', { name: 'ds', template: 'dropship', seed: 3 });
  const r = e.run('model_generate', { kind: 'interior', name: 'ds_int', hull: 'ds', seed: 2 });
  assert.ok(r.rooms.some((x) => x.kind === 'cargo_bay') && r.rooms.some((x) => x.kind === 'bridge') && r.rooms.some((x) => x.kind === 'engine_room'));
  // fit: every interior vertex inside the hull section
  const ship = expandDef(e.run('model_info', { name: 'ds' }).parts_def ? { name: 'ds', parts: e.run('model_info', { name: 'ds' }).parts_def } : null);
  const H = ship.parts.find((p) => p.type === 'hull');
  const intr = buildModel({ name: 'ds_int', parts: e.run('model_info', { name: 'ds_int' }).parts_def }, { tex: (ref) => ({ key: JSON.stringify(ref), name: 't', width: 1, height: 1, data: Uint8ClampedArray.from([1, 1, 1, 255]) }), getModel: () => null });
  const fit = insideHull(H, intr.mesh);
  assert.equal(fit.outside, 0, `interior vertices outside the hull: ${fit.outside} (worst ${fit.worst_px} px)`);
  // the cargo bay opens onto the rear ramp: gap < one wall + a few px
  const ramp = r.alignment.find((a) => a.kind === 'ramp');
  assert.ok(ramp && ramp.room.startsWith('cargo_bay') && ramp.gap_px < 12, JSON.stringify(r.alignment));
  // windows: ship got iwin_* parts on the hull at the window openings (same station, side and height)
  assert.ok(r.windows_on_ship > 0);
  const shipParts = e.run('model_info', { name: 'ds' }).parts_def;
  const wins = shipParts.filter((p) => p.auto === 'interior');
  assert.equal(wins.length, r.windows_on_ship);
  const S = hullSurface(H);
  for (const [k, w] of wins.entries()) {
    const o = r.openings[k];
    const pt = S.point(w.on_hull.t, w.on_hull.u);
    assert.ok(Math.abs(pt[2] + H.at[2] - o.z) < 2, 'window station = opening z');
    assert.equal(Math.sign(pt[0]), Math.sign(o.x), 'same side');
    assert.ok(Math.abs(pt[1] + H.at[1] - o.y) < 12, `window height ${pt[1] + H.at[1]} vs ${o.y}`);
    assert.ok(Math.abs(pt[0]) >= Math.abs(o.x) - 1, 'on the skin outside the room wall');
  }
  // cull rooms feed #7's portals on export
  const ex = e.run('model_export', { name: 'ds_int', path: path.join(tmp(), 'i.glb') });
  assert.ok(ex.cull && ex.cull.rooms >= 5 && ex.cull.portals >= 3, JSON.stringify(ex.cull));
  // regenerating replaces the windows instead of stacking them
  e.run('model_generate', { kind: 'interior', name: 'ds_int', hull: 'ds', seed: 2, overwrite: true });
  assert.equal(e.run('model_info', { name: 'ds' }).parts_def.filter((p) => p.auto === 'interior').length, r.windows_on_ship);
});

test('truss generator: bays, chords and cross-bracing', () => {
  const ctx = texCtx();
  const w = buildModel({ name: 't', parts: [{ type: 'truss', length: 192, w: 12, bay: 24, style: 'warren' }] }, ctx).mesh;
  const x = buildModel({ name: 't', parts: [{ type: 'truss', length: 192, w: 12, bay: 24, style: 'x' }] }, ctx).mesh;
  const f = buildModel({ name: 't', parts: [{ type: 'truss', length: 192, w: 12, bay: 24, section: 'flat', style: 'warren' }] }, ctx).mesh;
  // members: 4-sided beams = 8 triangles each (+ 4 cap triangles on chords)
  // warren box: 4 chords + 2 end frames x 4 + 8 bays x 4 diagonals = 4 + 8 + 32 = 44 members
  assert.equal(w.triangles, 4 * 12 + 40 * 8);
  // x bracing: two diagonals per face per bay + a frame every bay
  assert.equal(x.triangles, 4 * 12 + (9 * 4 + 8 * 4 * 2) * 8);
  assert.ok(f.triangles < w.triangles / 2);
  const b = w.bounds();
  assert.ok(Math.abs(b.max[0] - b.min[0] - 192 - 0) < 4 && Math.abs(b.max[1] - b.min[1] - 12) < 4);
  assert.throws(() => buildModel({ name: 't', parts: [{ type: 'truss', style: 'zigzag' }] }, ctx), /warren\|pratt\|x\|k\|none/);
});

test('neon: pixel-font strokes become emissive tubes with a light marker', () => {
  const G = textPixels('L');
  const st = pixelStrokes(G);
  assert.equal(st.lines.length, 1, 'an L is one stroke');
  assert.equal(st.lines[0].length, 3, 'two straight runs (collinear pixels merged)');
  const T = pixelStrokes(textPixels('T'));
  assert.equal(T.lines.length, 3, 'a T junction splits into three strokes');
  const m = build([{ type: 'neon', text: 'BAR 24', px: 4, color: '#ff3fd0' }]);
  const glowG = [...m.groups.values()].find((g) => g.tex.emissive);
  assert.ok(glowG && glowG.idx.length > 100, 'emissive tube material');
  const lights = m.markers?.length ? m.markers : buildModel({ name: 'm', parts: [{ type: 'neon', text: 'BAR 24' }] }, texCtx()).markers;
  assert.ok(lights.some((k) => k.kind === 'light' && k.data.color === '#ff3fd0'));
  // canvas strokes
  const e = new Engine({ home: tmp() });
  e.run('create', { name: 'arrow', width: 8, height: 8 });
  e.run('draw', { canvas: 'arrow', commands: [{ op: 'line', x1: 0, y1: 4, x2: 7, y2: 4, color: '#fff' }, { op: 'line', x1: 5, y1: 2, x2: 7, y2: 4, color: '#fff' }] });
  const c = e.run('model_create', { name: 'n', parts: [{ type: 'neon', canvas: 'arrow', backing: false }] });
  assert.ok(c.triangles > 20);
});

test('generators are deterministic by seed and output instanced kit pieces', () => {
  const a = miningColony('c', { seed: 3 }), b = miningColony('c', { seed: 3 }), c = miningColony('c', { seed: 4 });
  assert.deepEqual(a, b);
  assert.notDeepEqual(a.def.parts, c.def.parts);
  assert.ok(a.def.parts.filter((p) => p.type === 'model').length >= a.models.length);
  assert.ok(a.report.walkable.some((w) => w.kind === 'platform') && a.report.walkable.some((w) => w.kind === 'bridge'));
  const m1 = marketDistrict('mk', { seed: 2 }), m2 = marketDistrict('mk', { seed: 2 });
  assert.deepEqual(m1, m2);
  assert.notDeepEqual(m1, marketDistrict('mk', { seed: 9 }));
  // through the engine: kit models saved, layout exports as instances, lights + cull zones as nodes
  const e = new Engine({ home: tmp() });
  const r = e.run('model_generate', { kind: 'market', name: 'mk', seed: 2 });
  assert.ok(r.stalls > 10 && r.kit_models > 3);
  const ex = e.run('model_export', { name: 'mk', instances: true, path: path.join(tmp(), 'mk.glb') });
  assert.ok(ex.lights > 5 && ex.markers > ex.lights);
  const glb = fs.readFileSync(ex.file), json = JSON.parse(glb.toString('utf8', 20, 20 + glb.readUInt32LE(12)));
  assert.ok(json.nodes.some((n) => n.extras?.model && n.extras?.world_offset), 'instance nodes');
  assert.ok(json.nodes.some((n) => n.extras?.light?.color), 'light nodes');
  assert.ok(json.nodes.some((n) => n.extras?.marker === 'cull_zone'), 'cull zone nodes');
  const col = e.run('model_generate', { kind: 'mining_colony', name: 'col', seed: 3 });
  assert.equal(col.platforms, a.report.platforms);
});

test('budgets: class report, export budget enforcement, split meshes under 20k', () => {
  const e = new Engine({ home: tmp() });
  e.run('model_create', { name: 'big', parts: [{ type: 'hull', length: 640, rings: 100, segments: 96, panel_lines: { every: 16, width: 1, depth: 0.5 } }] });
  const b = e.run('model_budget', { name: 'big', class: 'snub' });
  assert.equal(b.class, 'snub');
  assert.ok(b.triangles > 20000 && /over by/.test(b.verdict) && b.lod_estimate.length >= 3 && b.top_parts[0].type === 'hull');
  assert.throws(() => e.run('model_export', { name: 'big', budget: 'snub', path: path.join(tmp(), 'b.glb') }), /budget snub/);
  assert.throws(() => e.run('model_export', { name: 'big', budget: 1e6, path: path.join(tmp(), 'b.glb') }), /split:true/);
  const out = path.join(tmp(), 'big.glb');
  const r = e.run('model_export', { name: 'big', split: true, budget: 1e6, path: out });
  const glb = fs.readFileSync(out), json = JSON.parse(glb.toString('utf8', 20, 20 + glb.readUInt32LE(12)));
  const meshTris = json.meshes.map((m) => m.primitives.reduce((s, p) => s + json.accessors[p.indices].count / 3, 0));
  assert.ok(meshTris.length >= 2 && meshTris.every((t) => t <= 20000), JSON.stringify(meshTris));
  assert.equal(meshTris.reduce((s, t) => s + t, 0), r.triangles, 'no triangle lost');
  assert.ok(json.nodes.some((n) => n.extras?.split_of === 'big'));
  // splitMesh keeps every triangle and respects the limit
  const m = new Mesh();
  const t = { key: 'k', name: 'k', width: 1, height: 1, data: new Uint8ClampedArray(4) };
  for (let i = 0; i < 500; i++) m.face(t, [[i, 0, 0], [i + 1, 0, 0], [i + 1, 1, 0], [i, 1, 0]], [0, 0, 1], [[0, 0], [1, 0], [1, 1], [0, 1]]);
  const parts = splitMesh(m, 300);
  assert.equal(parts.reduce((s, p) => s + p.triangles, 0), 1000);
  assert.ok(parts.every((p) => p.triangles <= 300));
});

test('static export of a rigged ship bakes the pose, enables lods, and keeps sockets as marker nodes', () => {
  const e = new Engine({ home: tmp() });
  e.run('model_create', { name: 'f', template: 'fighter', seed: 2 });
  // a rigged ship exports lods with the rig kept (LOD children per rig node); static bakes one pose instead
  const rl = e.run('model_export', { name: 'f', lods: [1, 0.5], path: path.join(tmp(), 'x.glb') });
  assert.ok(rl.animations !== undefined && rl.lods.length === 2, 'rigged lods');
  e.run('model_pose', { name: 'f', pose: 'open', parts: { canopy: { rot: [-60, 0, 0] } } });
  const r = e.run('model_export', { name: 'f', static: 'open', lods: [1, 0.5], path: path.join(tmp(), 'f.glb') });
  assert.equal(r.static, 'open');
  assert.ok(r.lods.length === 2 && r.lods[1].triangles < r.lods[0].triangles);
  const glb = fs.readFileSync(r.file), json = JSON.parse(glb.toString('utf8', 20, 20 + glb.readUInt32LE(12)));
  assert.ok(json.nodes.some((n) => n.name === 'socket_gear_n_contact' && n.extras?.marker === 'socket'));
  assert.ok(!json.animations, 'no clips on a static export');
  assert.ok(json.nodes.some((n) => n.extras?.light?.type === 'spot'), 'landing light node');
  // the rigged export keeps the nodes, clips and puts the light markers under their nodes
  const rig = e.run('model_export', { name: 'f', path: path.join(tmp(), 'fr.glb') });
  assert.ok(rig.animations.includes('gear_retract') && rig.animations.includes('wings_fold'));
});

test('additive cards, mood previews, kit textures and livery', () => {
  const e = new Engine({ home: tmp() });
  const k = e.run('model_kit', {});
  for (const n of ['kit_hull', 'kit_deck', 'kit_wall', 'kit_screen', 'kit_glow', 'kit_scratches']) assert.ok(k.canvases.includes(n), n);
  assert.ok(e.get('kit_screen').layers.some((l) => l.name === 'emissive'));
  assert.ok(e.get('kit_hull').layers.some((l) => l.name === 'height'));
  e.run('model_create', { name: 'f', template: 'fighter', seed: 4, textures: 'kit' });
  const lv = e.run('model_livery', { name: 'f', primary: '#6e7682', stripes: [{ t: [0.6, 0.64], color: '#b8462e' }], decals: [{ text: '07', t: 0.45 }], mark: { t: 0.2, seed: 3 } });
  assert.ok(lv.applied && e.get('f_livery').width >= 32);
  const hull = e.run('model_info', { name: 'f' }).parts_def.find((p) => p.type === 'hull');
  assert.equal(hull.texture, 'f_livery'); assert.equal(hull.uv, 'fit');
  // fog card material: additive BLEND, exported with extras.blending
  e.run('model_create', { name: 'fog', parts: [{ type: 'box', w: 32, h: 4, d: 32, color: '#334' }, { type: 'fog_card', at: [0, 64, 0], color: '#a0c8ff' }, { type: 'light', at: [0, 30, 0], color: '#ff8040', range: 120 }] });
  const ex = e.run('model_export', { name: 'fog', path: path.join(tmp(), 'fog.glb') });
  const glb = fs.readFileSync(ex.file), json = JSON.parse(glb.toString('utf8', 20, 20 + glb.readUInt32LE(12)));
  assert.ok(json.materials.some((m) => m.alphaMode === 'BLEND' && m.extras?.blending === 'additive'));
  assert.ok(json.nodes.some((n) => n.name === 'light_0' && n.extras.light.range === 120 / 32));
  // mood preview: darker overall than the default preview, but the lit area shows colour
  const lum = (img) => { let s = 0; const d = img.data; for (let i = 0; i < d.length; i += 4) s += d[i] + d[i + 1] + d[i + 2]; return s / (d.length / 4); };
  const dec = async () => (await import('../src/png.js')).decodePNG;
  return dec().then((decodePNG) => {
    const a = decodePNG(e.run('model_preview', { name: 'fog', views: ['iso'], size: 128 }).image), b = decodePNG(e.run('model_preview', { name: 'fog', views: ['iso'], size: 128, mood: true }).image);
    assert.ok(lum(b) < lum(a), 'mood is darker');
  });
});

test('plain models are untouched: no expansion, no extra nodes, identical bytes on repeat', () => {
  const def = { name: 'p', parts: [{ type: 'box', w: 32, h: 32, d: 32 }] };
  assert.equal(expandDef(def), def, 'defs without assemblies or on_hull are returned as is');
  const e = new Engine({ home: tmp() });
  e.run('model_create', def);
  const a = e.run('model_export', { name: 'p', path: path.join(tmp(), 'a.glb') }), b = e.run('model_export', { name: 'p', path: path.join(tmp(), 'b.glb') });
  const md5 = (f) => crypto.createHash('md5').update(fs.readFileSync(f)).digest('hex');
  assert.equal(md5(a.file), md5(b.file));
  const json = JSON.parse(fs.readFileSync(a.file).toString('utf8', 20, 20 + fs.readFileSync(a.file).readUInt32LE(12)));
  assert.equal(json.nodes.length, 1);
  assert.ok(!a.markers && !a.split && !a.budget && !a.static);
});

test('docs: art_help 3d lists the kit, the skill exists', () => {
  const t = helpText({ topic: '3d' });
  for (const k of ['SHIPS + STRUCTURES', 'hull {length', 'landing_gear {', 'engine_room {', 'market_stall {', 'generate {kind:"interior"', 'budget {name', 'mood']) assert.ok(t.includes(k), k);
  assert.ok(SKILLS['ships-structures']);
});

test('area light markers export their size (units) in extras.light; the schema lists clips once', async () => {
  const e = new Engine({ home: tmp() });
  e.run('model_create', { name: 'lit', scale: 32, parts: [{ type: 'box', w: 32, h: 4, d: 32, color: '#334' }, { type: 'light', kind: 'area', size: [32, 16], at: [0, 30, 0], dir: [0, -1, 0] }, { type: 'light', kind: 'area', at: [0, 20, 0] }] });
  const r = e.run('model_export', { name: 'lit' }), buf = fs.readFileSync(r.file);
  const json = JSON.parse(buf.toString('utf8', 20, 20 + buf.readUInt32LE(12)));
  const ls = json.nodes.filter((n) => n.extras?.light).map((n) => n.extras.light);
  assert.deepEqual(ls.map((l) => l.size), [[1, 0.5], [0.5, 0.5]]);
  assert.throws(() => e.run('model_create', { name: 'bad', parts: [{ type: 'light', kind: 'area', size: [0, 'x'] }] }), /area light size/);
  const { TOOLS } = await import('../src/mcp.js');
  const src = fs.readFileSync(new URL('../src/mcp.js', import.meta.url), 'utf8');
  const block = src.slice(src.indexOf("name: 'art_model'"), src.indexOf("name: 'art_audio'"));
  assert.equal(block.match(/\bclips: \{/g).length, 1, 'clips declared once in art_model');
  assert.deepEqual(TOOLS.find((t) => t.name === 'art_model').inputSchema.properties.clips.type, ['object', 'array']);
});
