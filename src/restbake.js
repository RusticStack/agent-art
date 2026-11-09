// Baked AO / lightmap / thickness and LOD levels for rigged (rigid rig) and skinned exports. The bake
// runs on the rest pose: every rig node's mesh (or the skinned bind mesh) goes to its rest world
// placement, the pieces occlude each other there, and the baked per-vertex data (AO, lightmap chart
// UVs on TEXCOORD_1) is copied back onto the node-local meshes (same vertex order), so the bake rides
// with the parts / bones when they move. One set per LOD level: each level occludes itself, all
// levels share one lightmap.
import { Mesh } from './model3d.js';
import { bakeAO } from './bake.js';
import { bakeLighting } from './lightbake.js';
import { trsMatrix } from './glb.js';
import { simplifyMesh, switchDistance } from './lod.js';

const BAKED = ['uv1', 'ao', 'aoTex', 'lmW', 'lmH'];
const mul = (A, B) => {
  const r = new Array(12);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) r[i * 4 + j] = A[i * 4] * B[j] + A[i * 4 + 1] * B[4 + j] + A[i * 4 + 2] * B[8 + j];
    r[i * 4 + 3] = A[i * 4] * B[3] + A[i * 4 + 1] * B[7] + A[i * 4 + 2] * B[11] + A[i * 4 + 3];
  }
  return r;
};
const I34 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];

/** Rest world 3x4 matrices (px) of a node list ({translation?, rotation?, scale?, matrix?, children?}). */
export function restWorld(nodes) {
  const parent = new Map();
  nodes.forEach((n, i) => (n.children || []).forEach((c) => parent.set(c, i)));
  const W = new Map();
  const of = (i) => {
    if (W.has(i)) return W.get(i);
    const n = nodes[i], L = n.matrix || (n.translation || n.rotation || n.scale ? trsMatrix(n.translation, n.rotation, n.scale) : I34);
    const M = parent.has(i) ? mul(of(parent.get(i)), L) : L;
    W.set(i, M);
    return M;
  };
  return nodes.map((_, i) => of(i));
}

/** A Mesh over a scene mesh's groups (deep copy: the build's meshes stay untouched). */
export function meshOfGroups(groups) {
  const m = new Mesh();
  for (const g of groups) m.groups.set(g.overlay ? `ov:${g.tex.key}` : g.tex.key, g);
  return m.cloneFull();
}

/**
 * Bake on the rest pose. levels: [[{mesh (node-local Mesh, baked in place), world (3x4) | null}]]
 * (one list per LOD level). opts: {ao, lm, thickness, lights, bounds}. -> {glbOpts, stats}
 */
export function bakeRest(levels, { ao = null, lm = null, thickness = null, lights = [], bounds = null }) {
  const worlds = levels.map((L) => L.map((e) => { const w = e.mesh.cloneFull(); if (e.world) w.transform(e.world); return w; }));
  const sets = worlds.map((ws) => ({ meshes: ws.filter((w) => [...w.groups.values()].some((g) => !g.overlay && g.idx.length)) })).filter((s) => s.meshes.length);
  const glbOpts = {};
  let stats = null;
  if (!sets.length) return { glbOpts, stats };
  if (lm || thickness || ao?.bent) {
    const all = new Mesh();
    for (const s of sets) for (const w of s.meshes) all.add(w.clone());
    const r = bakeLighting(sets, { ao, lm, thickness, lights, bounds: bounds || all.bounds() });
    if (r.ao) glbOpts.ao = r.ao;
    for (const k of ['lightmap', 'bent', 'thickness']) if (r[k]) glbOpts[k] = r[k];
    stats = { ...r.stats, sets: sets.length };
  } else {
    const r = bakeAO(sets, ao);
    if (r.map) glbOpts.ao = r.map;
    stats = { ...r.stats, sets: sets.length };
  }
  // the baked per-vertex data back onto the node-local meshes (same groups, same vertex order)
  levels.forEach((L, i) => L.forEach((e, k) => {
    const w = worlds[i][k];
    for (const [key, g] of e.mesh.groups) { const wg = w.groups.get(key); if (wg) for (const b of BAKED) if (wg[b] !== undefined) g[b] = wg[b]; }
  }));
  return { glbOpts, stats };
}

/**
 * LOD levels of a set of meshes (rig node pieces, or one skinned bind mesh): every piece simplified to
 * the level's ratio. -> [{level, ratio, meshes: [Mesh|null], triangles, error, distance}]
 */
export function lodSet(meshes, ratios, { scale, screen, carry = false }) {
  const out = [{ level: 0, ratio: 1, meshes, triangles: meshes.reduce((s, m) => s + (m ? m.triangles : 0), 0), error: 0 }];
  for (let i = 1; i < ratios.length; i++) {
    let tris = 0, err = 0;
    const ms = meshes.map((m) => {
      if (!m || !m.triangles) return null;
      const r = simplifyMesh(m, { ratio: ratios[i], level: i, keepOverlays: i === 1, carry });
      tris += r.triangles; err = Math.max(err, r.error);
      return r.mesh;
    });
    out.push({ level: i, ratio: ratios[i], meshes: ms, triangles: tris, error: err });
  }
  let prev = 0;
  for (const L of out) { L.distance = L.level ? Math.max(prev, +switchDistance(L.error / scale, screen).toFixed(6)) : 0; L.error_px = +L.error.toFixed(6); delete L.error; prev = L.distance; }
  return out;
}
