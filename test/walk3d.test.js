// Walkable ships (0.8): player metrics, shelled hulls with openings, glazing set into the armour,
// the hero gunship template (one model, exterior + interior), walk_check findings, the walk export
// (navmesh, colliders, triggers), built-in kit textures and decals.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Engine } from '../src/engine.js';
import { buildModel } from '../src/model3d.js';
import { PLAYER_M, playerPx } from '../src/walk.js';
import { kitTexture, isKitRef, KIT_TEXTURES } from '../src/kittex.js';
const readGLB = (glb) => ({ json: JSON.parse(glb.toString('utf8', 20, 20 + glb.readUInt32LE(12))) });

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'agent-art-walk-'));
const texCtx = () => {
  const cache = new Map();
  const tex = (ref) => { const k = typeof ref === 'string' ? ref : JSON.stringify(ref); if (!cache.has(k)) cache.set(k, { key: k, name: 't', width: 8, height: 8, data: new Uint8ClampedArray(256).fill(160) }); return cache.get(k); };
  return { tex, getModel: () => { throw new Error('no models'); } };
};
const edges = (mesh) => {
  const key = (g, v) => `${Math.round(g.pos[v * 3] * 1000)},${Math.round(g.pos[v * 3 + 1] * 1000)},${Math.round(g.pos[v * 3 + 2] * 1000)}`;
  const m = new Map();
  for (const g of mesh.groups.values()) for (let i = 0; i < g.idx.length; i += 3) for (let k = 0; k < 3; k++) { const a = key(g, g.idx[i + k]), b = key(g, g.idx[i + ((k + 1) % 3)]); if (a !== b) m.set(`${a}|${b}`, (m.get(`${a}|${b}`) || 0) + 1); }
  let unpaired = 0;
  for (const [e, c] of m) { const [a, b] = e.split('|'); if ((m.get(`${b}|${a}`) || 0) !== c) unpaired++; }
  return unpaired;
};

test('player metrics: one shared constant, px at 32 px / m', () => {
  const P = playerPx(32);
  assert.equal(PLAYER_M.height, 1.8);
  assert.equal(P.door_w, 1.2 * 32);
  assert.equal(P.corridor_h, 2.3 * 32);
  assert.equal(P.ramp_deg, 20);
});

test('hull: shell + openings stay closed (inner skin, rims at the cut) and glazing panes sit inset', () => {
  const H = { type: 'hull', id: 'h', length: 320, width: 96, height: 64, rings: 10, segments: 12, shell: 6, openings: [{ t: [0.4, 0.6], u: [0.2, 0.3] }], caps: true };
  const plain = buildModel({ name: 'a', parts: [{ ...H, shell: undefined, openings: undefined }] }, texCtx()).mesh;
  const shelled = buildModel({ name: 'b', parts: [H] }, texCtx()).mesh;
  assert.equal(edges(shelled), 0, 'shelled hull with an opening is still closed (outer skin + rims + inner skin)');
  assert.ok(shelled.triangles > plain.triangles * 1.8);
  const g = buildModel({ name: 'c', parts: [H, { type: 'glazing', hull: 'h', t: [0.4, 0.6], u: [0.2, 0.3], cols: 3, rows: 2 }] }, texCtx());
  const glass = g.parts.find((p) => p.type === 'hull' && p.i > 0);
  assert.ok(glass && glass.triangles > 0 && glass.triangles < shelled.triangles / 4, 'glass patch only covers the opening');
  assert.ok(g.parts.filter((p) => p.type === 'tube').length >= 7, 'mullions on the pane grid');
});

test('gunship: original hero ship is one walkable model inside its budget; walk_check passes', () => {
  const e = new Engine({ home: tmp() });
  e.run('model_create', { name: 'g', template: 'gunship', rigged: false });
  const b = e.run('model_budget', { name: 'g' });
  assert.ok(b.triangles <= b.budget.triangles, `${b.triangles} > ${b.budget.triangles}`);
  const info = e.run('model_info', { name: 'g' });
  assert.ok(info.bounds_px.min[1] > -1 && info.bounds_px.min[1] < 1, 'gear contact at y = 0');
  const len = info.bounds_px.size[2] / 32;
  assert.ok(len > 22 && len < 32, `true scale length ${len} m`);
  const w = e.run('model_walk_check', { name: 'g' });
  assert.ok(w.ok, JSON.stringify({ ...w, areas: undefined }));
  assert.ok(w.counts.areas >= 4 && w.counts.seats >= 1 && w.counts.ladders >= 1 && w.counts.reachable === w.counts.areas);
  // rigged: booms / pods / airlock / gear nodes, the vtol clip, landed pose
  e.run('model_create', { name: 'gr', template: 'gunship' });
  const r = e.run('model_info', { name: 'gr' });
  for (const n of ['hull', 'boom_l', 'pod_l', 'airlock', 'gear_n']) assert.ok(r.rig.nodes.some((x) => x.name === n || x === n), n);
  assert.ok(r.rig.clips.vtol && r.rig.clips.airlock_open && r.rig.clips.gear_retract);
  assert.ok(e.run('model_walk_check', { name: 'gr' }).ok);
});

test('walk_check finds blocked headroom, small doors, floor gaps, unreachable areas and hull pokes', () => {
  const e = new Engine({ home: tmp() });
  const room = { type: 'room', cells: [2, 3], openings: { n: [{ at: 0, kind: 'door', w: 24 }] } };
  e.run('model_create', { name: 'bad', parts: [
    room,
    { type: 'door', w: 30, at: [-32, 0, 98] }, // a door narrower than 1.2 m
    { type: 'box', w: 30, h: 20, d: 30, at: [0, 30, 0] }, // a low beam over the floor
    { type: 'room', cells: [1, 1], at: [400, 0, 0] }, // nobody can get here
  ] });
  const w = e.run('model_walk_check', { name: 'bad' });
  assert.ok(!w.ok);
  assert.ok(w.headroom.length >= 1, 'low beam');
  assert.ok(w.metrics.some((m) => m.check === 'door size'), 'door narrower than 1.2 m');
  assert.ok(w.unreachable.length >= 1, 'isolated room');
  // a floor with a hole + an interior part that pokes through a hull
  e.run('model_create', { name: 'gap', parts: [
    { type: 'hull', id: 'h', length: 400, width: 200, height: 140, shell: 6, openings: [{ t: [0.45, 0.55], u: [0.45, 0.55] }] },
    { type: 'box', w: 60, h: 4, d: 80, at: [0, 6, -60], inside: 'h' }, { type: 'box', w: 60, h: 4, d: 80, at: [0, 6, 60], inside: 'h' },
    { type: 'marker', kind: 'walk', at: [0, 10, 0], dir: [0, 0, 1], data: { w: 50, d: 200 } },
    { type: 'box', w: 400, h: 4, d: 20, at: [0, 40, 0], inside: 'h' },
  ] });
  const w2 = e.run('model_walk_check', { name: 'gap' });
  assert.ok(w2.floor_gaps.length === 1, 'hole between the two floor boxes');
  assert.ok(w2.hull_pokes.length === 1 && w2.hull_pokes[0].outside > 0, 'the 400 px plank sticks out of a 200 px hull');
});

test('export walk:true adds the navmesh + collider / trigger nodes; without it they stay out', () => {
  const e = new Engine({ home: tmp() });
  const d = tmp();
  e.run('model_create', { name: 'c', parts: [{ type: 'corridor', len: 3 }, { type: 'door', at: [0, 0, 98] }, { type: 'ladder', at: [0, 0, -60] }] });
  const a = e.run('model_export', { name: 'c', path: path.join(d, 'a.glb') });
  const b = e.run('model_export', { name: 'c', path: path.join(d, 'b.glb'), walk: true });
  const ga = readGLB(fs.readFileSync(path.join(d, 'a.glb'))).json, gb = readGLB(fs.readFileSync(path.join(d, 'b.glb'))).json;
  assert.ok(!ga.nodes.some((n) => /^collider_|^trigger_|^walk_/.test(n.name)));
  assert.ok(gb.nodes.some((n) => n.name === 'c_walk' && n.extras?.navmesh));
  assert.ok(gb.nodes.some((n) => /^collider_/.test(n.name)) && gb.nodes.some((n) => /^trigger_/.test(n.name) && n.extras?.trigger));
  assert.ok(b.walk.navmesh_triangles >= 2 && b.walk.colliders >= 3 && b.walk.triggers >= 2);
  assert.equal(a.triangles, b.triangles, 'navmesh is a proxy (not counted)');
});

test('kit textures resolve without canvases (tinted variants), carry normal + metal/rough; decals are alpha-cut', () => {
  assert.ok(isKitRef('kit_deck') && isKitRef('kit_fabric_a03028') && isKitRef('kit_container_end_8a3a2a') && !isKitRef('kit_nope') && !isKitRef('deck'));
  const a = kitTexture('kit_hull'), b = kitTexture('kit_hull_aa3030');
  assert.ok(a.normal && a.mr && a.width === 64);
  assert.notDeepEqual(a.data.slice(0, 400), b.data.slice(0, 400));
  for (const n of KIT_TEXTURES) assert.ok(kitTexture(`kit_${n}`), n);
  const e = new Engine({ home: tmp() });
  e.run('model_create', { name: 'k', parts: [{ type: 'box', w: 64, h: 32, d: 32, texture: 'kit_wall' }, { type: 'decal', text: 'PUSH TO OPEN', at: [0, 16, 16.3] }, { type: 'decal', kind: 'chevrons', at: [0, 8, 16.3] }] });
  const p = e.run('model_preview', { name: 'k', mood: true, views: ['front'], size: 96 });
  assert.ok(p.image.length > 1000);
  const glb = e.run('model_export', { name: 'k', path: path.join(tmp(), 'k.glb') });
  assert.ok(glb.triangles > 12);
});
