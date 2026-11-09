// Rigs on damage exports. A rigid rig (named parts / sockets / clips) keeps its node tree, its socket
// nodes and its clips in every damage state: the state mesh is split by rig node (face node tags
// survive the damage passes), each piece goes into its node's rest frame, and every clip drives the
// matching nodes of every state (one animation per clip), so a damaged door still opens and a wrecked
// turret still turns. A skinned model keeps its skin: every state mesh is a skinned mesh on the one
// shared armature, its weights transferred from the intact skinned mesh (nearest bind vertex).
import { Mesh } from './model3d.js';
import { clipKeys, clipChannels } from './modelrig.js';

// per-vertex extras that ride along (width per vertex); overlays keep their decal UVs / alpha
const EXTRAS = [['uv1', 2], ['ao', 1], ['uvd', 2], ['dmg', 4]];
const OV_EXTRAS = [['uv0', 2], ['alpha', 1]];

function copyVertex(g, tg, v, extras) {
  tg.pos.push(g.pos[v * 3], g.pos[v * 3 + 1], g.pos[v * 3 + 2]);
  tg.nrm.push(g.nrm[v * 3], g.nrm[v * 3 + 1], g.nrm[v * 3 + 2]);
  tg.uv.push(g.uv[v * 2], g.uv[v * 2 + 1]);
  for (const [k, w] of extras) if (g[k]) { const a = tg[k] || (tg[k] = []); for (let c = 0; c < w; c++) a.push(g[k][v * w + c]); }
  if (g.morphs) {
    if (!tg.morphs) tg.morphs = g.morphs.map((t) => ({ name: t.name, pos: [], ...(t.nrm ? { nrm: [] } : {}) }));
    g.morphs.forEach((t, m) => { for (let c = 0; c < 3; c++) { tg.morphs[m].pos.push(t.pos[v * 3 + c]); if (t.nrm) tg.morphs[m].nrm.push(t.nrm[v * 3 + c]); } });
  }
  if (g.vnode) (tg.vnode || (tg.vnode = [])).push(g.vnode[v]);
}

/**
 * A (damaged) mesh split by rig node, keeping chart UVs, damage RGBA, AO / lightmap UVs and morph
 * targets; each piece in its node's rest frame (R^T (p - joint)). Faces without a known node go to
 * the root. -> Map(node name -> Mesh)
 */
export function splitRig(mesh, info) {
  const out = new Map();
  const known = (n) => (n !== null && n !== undefined && info.byName.has(n) ? n : info.root);
  const piece = (n) => { if (!out.has(n)) out.set(n, new Mesh()); return out.get(n); };
  for (const g of mesh.groups.values()) {
    if (g.overlay || !g.faces) {
      for (let t = 0; t < g.idx.length; t += 3) {
        const tg = piece(known(g.vnode ? g.vnode[g.idx[t]] : null)).group(g.tex, !!g.overlay), base = tg.pos.length / 3;
        for (let k = 0; k < 3; k++) copyVertex(g, tg, g.idx[t + k], g.overlay ? OV_EXTRAS : EXTRAS);
        tg.idx.push(base, base + 1, base + 2);
      }
      continue;
    }
    for (const f of g.faces) {
      const tg = piece(known(f.node)).group(g.tex), base = tg.pos.length / 3, i0 = tg.idx.length;
      for (let v = f.v; v < f.v + f.vc; v++) copyVertex(g, tg, v, EXTRAS);
      for (let i = f.i; i < f.i + f.ic; i++) tg.idx.push(g.idx[i] - f.v + base);
      tg.faces.push({ ...f, n: f.n.slice(), v: base, i: i0 });
    }
  }
  for (const [name, m] of out) {
    const N = info.byName.get(name), R = N.R, J = N.joint;
    if (N.root && !J.some((v) => v)) continue;
    const rt = (x, y, z) => [R[0] * x + R[4] * y + R[8] * z, R[1] * x + R[5] * y + R[9] * z, R[2] * x + R[6] * y + R[10] * z];
    const rot = (a, sub) => { for (let i = 0; i < a.length; i += 3) { const q = rt(a[i] - sub[0], a[i + 1] - sub[1], a[i + 2] - sub[2]); a[i] = q[0]; a[i + 1] = q[1]; a[i + 2] = q[2]; } };
    const Z = [0, 0, 0];
    for (const g of m.groups.values()) {
      rot(g.pos, J); rot(g.nrm, Z);
      for (const t of g.morphs || []) { rot(t.pos, Z); if (t.nrm) rot(t.nrm, Z); }
      for (const f of g.faces || []) { const q = rt(f.n[0], f.n[1], f.n[2]); f.n[0] = q[0]; f.n[1] = q[1]; f.n[2] = q[2]; }
    }
  }
  return out;
}

/**
 * One copy of the rig under a damage state (or one of its LOD levels): a node per rig node (rest TRS,
 * its piece of the state mesh), socket nodes, and the clips' channels for these nodes merged into
 * anims (Map clip -> {name, channels, extras}). extraPieces: [{pieces, suffix, extras}] (overlay
 * shells) as child nodes. -> {root (node index), nodes: [names]}
 */
export function addRig(S, def, info, pieces, prefix, { addMesh, node, anims, hidden = false, extraPieces = [] }) {
  const idx = new Map(), names = [];
  for (const n of info.nodes) {
    const nm = n.root ? prefix : `${prefix}_${n.name}`;
    const id = node(S, { name: nm, translation: n.t, rotation: n.q, children: [], extras: n.root ? { rig_root: def.name } : { rig_node: n.name, joint_px: n.joint.map((v) => +v.toFixed(4)), part: n.i } });
    const m = pieces.get(n.name);
    if (m && m.triangles) { S.nodes[id].mesh = addMesh(S, nm, m); if (hidden) S.nodes[id].lodHidden = true; }
    for (const ep of extraPieces) {
      const em = ep.pieces.get(n.name);
      if (!em || !em.triangles) continue;
      const en = `${nm}_${ep.suffix}`;
      S.nodes[id].children.push(node(S, { name: en, mesh: addMesh(S, en, em), extras: { ...ep.extras }, ...(hidden ? { lodHidden: true } : {}) }));
    }
    idx.set(n.name, id);
    names.push(nm);
  }
  for (const n of info.nodes) if (n.parent !== null) S.nodes[idx.get(n.parent)].children.push(idx.get(n.name));
  for (const s of info.sockets) {
    const id = node(S, { name: `${prefix}_${s.name}`, translation: s.t, rotation: s.q, extras: { socket: s.key } });
    S.nodes[idx.get(s.parent)].children.push(id);
  }
  for (const [name, clip] of Object.entries(def.clips || {})) {
    const ck = clipKeys(def, info, clip);
    const { channels, mode } = clipChannels(info, ck, idx);
    if (!channels.length) continue;
    if (!anims.has(name)) {
      const events = (clip.events || []).map((e) => ({ t: Number(e.t), name: e.name })).sort((a, b) => a.t - b.t);
      anims.set(name, { name, channels: [], extras: { duration: ck.duration, loop: ck.loop, sampling: mode, ...(events.length ? { events } : {}), note: 'drives the rig nodes of every damage state (and LOD level)' } });
    }
    anims.get(name).channels.push(...channels);
  }
  for (const id of idx.values()) if (!S.nodes[id].children.length) delete S.nodes[id].children;
  return { root: idx.get(info.root), nodes: names };
}

/** Closest point on triangle abc to p -> [u, v, w] barycentric weights (Ericson, Real-Time Collision Detection 5.1.5). */
function closestBary(p, a, b, c) {
  const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]], ap = [p[0] - a[0], p[1] - a[1], p[2] - a[2]];
  const dot = (x, y) => x[0] * y[0] + x[1] * y[1] + x[2] * y[2];
  const d1 = dot(ab, ap), d2 = dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return [1, 0, 0];
  const bp = [p[0] - b[0], p[1] - b[1], p[2] - b[2]], d3 = dot(ab, bp), d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return [0, 1, 0];
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) { const v = d1 / (d1 - d3); return [1 - v, v, 0]; }
  const cp = [p[0] - c[0], p[1] - c[1], p[2] - c[2]], d5 = dot(ab, cp), d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return [0, 0, 1];
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) { const w = d2 / (d2 - d6); return [1 - w, 0, w]; }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) { const w = (d4 - d3) / (d4 - d3 + (d5 - d6)); return [0, 1 - w, w]; }
  const den = 1 / (va + vb + vc), v = vb * den, w = vc * den;
  return [1 - v - w, v, w];
}

/**
 * Skin weights for a damage-state mesh from the intact skinned mesh: every vertex takes the weights
 * of the closest point on the bind surface (barycentric blend of that triangle's corner influences,
 * the 4 biggest kept, normalised). Untouched surface keeps its exact weights; subdivided dents, cuts,
 * inner backing and wires take the smooth weights of the surface they came from.
 * -> {mesh (copy with skin), max_distance}
 */
export function transferSkin(src, dst) {
  const T = [];
  for (const g of src.groups.values()) if (g.skin) for (let t = 0; t < g.idx.length; t += 3) {
    const v = [g.idx[t], g.idx[t + 1], g.idx[t + 2]];
    T.push({ p: v.map((i) => [g.pos[i * 3], g.pos[i * 3 + 1], g.pos[i * 3 + 2]]), inf: v.map((i) => [0, 1, 2, 3].map((c) => [g.skin.j[i * 4 + c], g.skin.w[i * 4 + c]])) });
  }
  if (!T.length) throw new Error('damage: the intact skinned mesh has no weighted triangles');
  const b = src.bounds(), diag = Math.hypot(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]);
  const cell = Math.max(diag / 32, 1e-3), grid = new Map();
  const key = (x, y, z) => `${x},${y},${z}`;
  T.forEach((tr, i) => {
    const lo = [0, 1, 2].map((k) => Math.floor(Math.min(tr.p[0][k], tr.p[1][k], tr.p[2][k]) / cell)), hi = [0, 1, 2].map((k) => Math.floor(Math.max(tr.p[0][k], tr.p[1][k], tr.p[2][k]) / cell));
    for (let x = lo[0]; x <= hi[0]; x++) for (let y = lo[1]; y <= hi[1]; y++) for (let z = lo[2]; z <= hi[2]; z++) { const k = key(x, y, z); if (!grid.has(k)) grid.set(k, []); grid.get(k).push(i); }
  });
  const test = (p, i, best) => {
    const tr = T[i], bc = closestBary(p, tr.p[0], tr.p[1], tr.p[2]);
    const q = [0, 1, 2].map((k) => bc[0] * tr.p[0][k] + bc[1] * tr.p[1][k] + bc[2] * tr.p[2][k]);
    const d = Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
    if (d < best.d - 1e-9) { best.d = d; best.t = i; best.bc = bc; }
  };
  const closest = (p) => {
    const c = p.map((v) => Math.floor(v / cell)), best = { d: Infinity, t: -1, bc: null }, seen = new Set();
    for (let r = 0; r <= 8; r++) {
      for (let i = -r; i <= r; i++) for (let j = -r; j <= r; j++) for (let k = -r; k <= r; k++) {
        if (Math.max(Math.abs(i), Math.abs(j), Math.abs(k)) !== r) continue;
        for (const q of grid.get(key(c[0] + i, c[1] + j, c[2] + k)) || []) if (!seen.has(q)) { seen.add(q); test(p, q, best); }
      }
      if (best.t >= 0 && best.d <= r * cell) break;
    }
    if (best.t < 0) for (let q = 0; q < T.length; q++) test(p, q, best);
    return best;
  };
  const out = dst.cloneFull();
  let worst = 0;
  for (const g of out.groups.values()) {
    const j = [], w = [];
    for (let v = 0; v < g.pos.length / 3; v++) {
      const best = closest([g.pos[v * 3], g.pos[v * 3 + 1], g.pos[v * 3 + 2]]);
      worst = Math.max(worst, best.d);
      const acc = new Map();
      T[best.t].inf.forEach((corner, ci) => { for (const [jj, ww] of corner) if (ww > 0) acc.set(jj, (acc.get(jj) || 0) + ww * best.bc[ci]); });
      const top = [...acc].sort((x, y) => y[1] - x[1] || x[0] - y[0]).slice(0, 4);
      const s = top.reduce((m, x) => m + x[1], 0) || 1;
      for (let c = 0; c < 4; c++) { j.push(top[c] ? top[c][0] : 0); w.push(top[c] ? top[c][1] / s : 0); }
    }
    g.skin = { j, w };
  }
  return { mesh: out, max_distance: worst };
}
