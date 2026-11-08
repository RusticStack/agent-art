// Rigid-part 3D rigs for art_model (PSX / Half-Life 1 style: no skinning). Named parts become
// nodes whose joint is the part's pivot; poses are per-node offsets from the rest pose; clips are
// keyed poses in seconds, exported as glTF animations; sockets are empty child nodes.
//
// Rest pose: every node's world transform is T(joint) * R(part rotation); its mesh is stored in
// that frame (scale stays baked into the vertices). Local transform = parent^-1 * world, so a
// child's translation is its joint offset from the parent's joint. Pose offsets: at (px, in the
// parent's frame) is added to the local translation; rot [x,y,z] deg (X then Y then Z, fixed axes
// of the node's rest frame) multiplies the rest rotation; scale scales the node (and its children).
import { Mesh, matMul, mT, IDENT, rigJoints, cross, norm, dot, mRX, mRY, mRZ, applyP } from './model3d.js';
import { trsMatrix } from './glb.js';

// ---------- quaternions [x, y, z, w] ----------
export const qMul = (a, b) => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];
const qAxis = (ax, deg) => { const h = (deg * Math.PI) / 360, q = [0, 0, 0, Math.cos(h)]; q[ax] = Math.sin(h); return q; };
/** Euler degrees [x, y, z] applied X then Y then Z about fixed axes (R = Rz * Ry * Rx), like part rotate. */
export const qEuler = (e) => qMul(qAxis(2, e[2]), qMul(qAxis(1, e[1]), qAxis(0, e[0])));
const qNorm = (q) => { const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1; return q.map((v) => v / l); };
/** Shortest-arc spherical interpolation (glTF LINEAR rotation). */
export function qSlerp(a, b, t) {
  let d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  if (d < 0) { b = b.map((v) => -v); d = -d; }
  if (d > 0.9995) return qNorm(a.map((v, i) => v + (b[i] - v) * t));
  const th = Math.acos(Math.min(1, d)), s = Math.sin(th), ka = Math.sin((1 - t) * th) / s, kb = Math.sin(t * th) / s;
  return a.map((v, i) => v * ka + b[i] * kb);
}
/** Quaternion of the rotation part of a 3x4 matrix (orthonormal). */
export function quatOfMat(M) {
  const r = [M[0], M[1], M[2], M[4], M[5], M[6], M[8], M[9], M[10]];
  const tr = r[0] + r[4] + r[8];
  let q;
  if (tr > 0) { const s = Math.sqrt(tr + 1) * 2; q = [(r[7] - r[5]) / s, (r[2] - r[6]) / s, (r[3] - r[1]) / s, s / 4]; }
  else if (r[0] > r[4] && r[0] > r[8]) { const s = Math.sqrt(1 + r[0] - r[4] - r[8]) * 2; q = [s / 4, (r[1] + r[3]) / s, (r[2] + r[6]) / s, (r[7] - r[5]) / s]; }
  else if (r[4] > r[8]) { const s = Math.sqrt(1 + r[4] - r[0] - r[8]) * 2; q = [(r[1] + r[3]) / s, s / 4, (r[5] + r[7]) / s, (r[2] - r[6]) / s]; }
  else { const s = Math.sqrt(1 + r[8] - r[0] - r[4]) * 2; q = [(r[2] + r[6]) / s, (r[5] + r[7]) / s, s / 4, (r[3] - r[1]) / s]; }
  q = qNorm(q);
  return q[3] < 0 ? q.map((v) => -v) : q;
}
/** Rotation part transposed (= inverse for a rotation), no translation. */
export const rotT = (R) => [R[0], R[4], R[8], 0, R[1], R[5], R[9], 0, R[2], R[6], R[10], 0];
const rotApply = (R, v) => [R[0] * v[0] + R[1] * v[1] + R[2] * v[2], R[4] * v[0] + R[5] * v[1] + R[6] * v[2], R[8] * v[0] + R[9] * v[1] + R[10] * v[2]];
const vec3 = (v, d = 0, name = 'value') => {
  if (v === undefined || v === null) return [d, d, d];
  if (typeof v === 'number') return [v, v, v];
  if (!Array.isArray(v) || v.length !== 3 || v.some((x) => !Number.isFinite(Number(x)))) throw new Error(`${name} must be [x,y,z] numbers (got ${JSON.stringify(v)})`);
  return v.map(Number);
};
/** 3x4 rotation whose local -Z points along `look` (model axes) and local +Y toward `up`. */
export function lookRotation(look = [0, 0, -1], up = [0, 1, 0]) {
  const z = norm(look.map((v) => -v));
  let u = up;
  if (Math.abs(dot(norm(u), z)) > 0.999) u = Math.abs(z[2]) > 0.9 ? [0, 1, 0] : [0, 0, 1];
  if (Math.abs(dot(norm(u), z)) > 0.999) u = [1, 0, 0];
  const x = norm(cross(u, z)), y = cross(z, x);
  return [x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0];
}

// ---------- mesh split by node ----------
/** Split a built mesh into one Mesh per node (face.node; overlay shells use vnode). null = root. */
export function splitByNode(mesh) {
  const out = new Map();
  const target = (n) => { const k = n ?? null; if (!out.has(k)) out.set(k, new Mesh()); return out.get(k); };
  for (const g of mesh.groups.values()) {
    if (g.overlay) {
      for (let t = 0; t < g.idx.length; t += 3) {
        const n = g.vnode ? g.vnode[g.idx[t]] : null;
        const og = target(n).group(g.tex, true), base = og.pos.length / 3;
        for (let k = 0; k < 3; k++) {
          const v = g.idx[t + k];
          og.pos.push(g.pos[v * 3], g.pos[v * 3 + 1], g.pos[v * 3 + 2]); og.nrm.push(g.nrm[v * 3], g.nrm[v * 3 + 1], g.nrm[v * 3 + 2]);
          og.uv.push(g.uv[v * 2], g.uv[v * 2 + 1]); og.uv0.push(g.uv0[v * 2], g.uv0[v * 2 + 1]); og.alpha.push(g.alpha[v]);
        }
        og.idx.push(base, base + 1, base + 2);
      }
      continue;
    }
    for (const f of g.faces) {
      const tg = target(f.node).group(g.tex), base = tg.pos.length / 3, i0 = tg.idx.length;
      for (let v = f.v; v < f.v + f.vc; v++) { tg.pos.push(g.pos[v * 3], g.pos[v * 3 + 1], g.pos[v * 3 + 2]); tg.nrm.push(g.nrm[v * 3], g.nrm[v * 3 + 1], g.nrm[v * 3 + 2]); tg.uv.push(g.uv[v * 2], g.uv[v * 2 + 1]); }
      for (let i = f.i; i < f.i + f.ic; i++) tg.idx.push(g.idx[i] - f.v + base);
      tg.faces.push({ ...f, n: f.n.slice(), v: base, i: i0 });
    }
  }
  return out;
}

// ---------- rig info ----------
/**
 * Node tree of a built model: {root, nodes:[{name, parent, joint, R, t, q, mesh (local), children}],
 * byName, sockets:[{name, key, parent, t, q}]}. force: also for models without named parts (one
 * root node holding the whole mesh), so previews / renders / sockets work on any model.
 */
export function rigInfo(def, built, force = false) {
  const layout = built.layout;
  if (!layout && !force && !def.sockets && !def.clips) return null;
  const J = layout ? rigJoints(def, layout, built.shift) : new Map();
  const root = { name: def.name, parent: null, joint: [0, 0, 0], R: IDENT, root: true };
  const nodes = [root, ...(layout ? layout.nodes.map((nd) => ({ name: nd.name, parent: nd.parent ?? def.name, i: nd.i, ...J.get(nd.name) })) : [])];
  const byName = new Map(nodes.map((n) => [n.name, n]));
  for (const n of nodes) n.children = [];
  for (const n of nodes) if (n.parent !== null) byName.get(n.parent).children.push(n.name);
  const split = layout ? splitByNode(built.mesh) : new Map([[null, built.mesh.clone()]]);
  for (const n of nodes) {
    const P = n.parent === null ? null : byName.get(n.parent);
    if (P) {
      const PT = rotT(P.R);
      n.t = rotApply(PT, [n.joint[0] - P.joint[0], n.joint[1] - P.joint[1], n.joint[2] - P.joint[2]]);
      n.q = quatOfMat(matMul(PT, n.R));
    } else { n.t = [0, 0, 0]; n.q = [0, 0, 0, 1]; }
    const m = split.get(n.root ? null : n.name) || new Mesh();
    // into the node's rest frame: R^T * T(-joint)
    if (!n.root || n.joint.some((v) => v)) m.transform(matMul(rotT(n.R), mT(-n.joint[0], -n.joint[1], -n.joint[2])));
    n.mesh = m;
  }
  const sockets = [];
  for (const [key, s] of Object.entries(def.sockets || {})) {
    if (!/^[A-Za-z0-9_.-]{1,48}$/.test(key)) throw new Error(`socket name "${key}" must be 1-48 chars of letters, digits, _ - .`);
    if (!s || typeof s !== 'object') throw new Error(`socket "${key}" must be {part?, at:[x,y,z], look?:[x,y,z]}`);
    const parent = s.part ?? def.name;
    const P = byName.get(parent);
    if (!P) throw new Error(`socket "${key}": part "${parent}" is not a node (named parts: ${nodes.slice(1).map((n) => n.name).join(', ') || 'none'}; omit part for the model root)`);
    const S = vec3(s.at, 0, `socket "${key}" at`), sh = built.shift || [0, 0, 0];
    const W = [S[0] + sh[0], S[1] + sh[1], S[2] + sh[2]];
    const PT = rotT(P.R);
    const look = s.look === undefined || s.look === null ? [0, 0, -1] : vec3(s.look, 0, `socket "${key}" look`);
    if (!look.some((v) => v)) throw new Error(`socket "${key}": look must not be [0,0,0]`);
    sockets.push({ name: `socket_${key}`, key, parent, world: W, t: rotApply(PT, [W[0] - P.joint[0], W[1] - P.joint[1], W[2] - P.joint[2]]), q: quatOfMat(matMul(PT, lookRotation(look, s.up ? vec3(s.up, 0, 'up') : undefined))) });
  }
  return { root: def.name, nodes, byName, sockets, rigged: !!layout };
}

/** Compact node tree for create/info: nested {name: {children...}} plus per-node rows. */
export function rigSummary(def, info) {
  const tree = (name) => Object.fromEntries(info.byName.get(name).children.map((c) => [c, tree(c)]));
  const r3 = (v) => v.map((x) => +x.toFixed(3));
  return {
    root: info.root,
    tree: { [info.root]: tree(info.root) },
    nodes: info.nodes.map((n) => ({ name: n.name, parent: n.parent, joint: r3(n.joint), triangles: n.mesh.triangles })),
    sockets: info.sockets.map((s) => ({ name: s.name, part: s.parent, at: r3(s.world) })),
    poses: Object.keys(def.poses || {}),
    clips: Object.fromEntries(Object.entries(def.clips || {}).map(([k, c]) => [k, { duration: clipDuration(c), loop: !!c.loop, events: (c.events || []).length }])),
  };
}

// ---------- poses ----------
/** Offsets of one key / pose reference: {pose?:<name>, parts?:{node:{rot, at, scale}}} -> Map node -> {rot, at, scale}. */
export function resolveOffsets(def, info, key = {}) {
  const out = new Map();
  const add = (parts, where) => {
    if (parts === undefined || parts === null) return;
    if (typeof parts !== 'object' || Array.isArray(parts)) throw new Error(`${where}: parts must be {<part name>: {rot?:[x,y,z], at?:[dx,dy,dz], scale?}}`);
    for (const [n, o] of Object.entries(parts)) {
      if (!info.byName.has(n)) throw new Error(`${where}: "${n}" is not a node (nodes: ${info.nodes.map((x) => x.name).join(', ')})`);
      if (o === null) { out.delete(n); continue; }
      if (typeof o !== 'object') throw new Error(`${where}: ${n} must be {rot?, at?, scale?}`);
      for (const k of Object.keys(o)) if (!['rot', 'at', 'scale'].includes(k)) throw new Error(`${where}: ${n}.${k} is not a pose field (rot:[x,y,z] deg, at:[dx,dy,dz] px, scale)`);
      out.set(n, { rot: vec3(o.rot, 0, `${n}.rot`), at: vec3(o.at, 0, `${n}.at`), scale: vec3(o.scale, 1, `${n}.scale`) });
    }
  };
  // "rest" is built in (no offsets) unless the model defines its own
  if (key.pose !== undefined && key.pose !== null && !(key.pose === 'rest' && !(def.poses || {}).rest)) {
    const p = (def.poses || {})[key.pose];
    if (!p) throw new Error(`unknown pose "${key.pose}" (poses: ${Object.keys(def.poses || {}).join(', ') || 'none'}; add one with art_model pose)`);
    add(p.parts, `pose "${key.pose}"`);
  }
  add(key.parts, 'parts');
  return out;
}
const ZERO = { rot: [0, 0, 0], at: [0, 0, 0], scale: [1, 1, 1] };
/** Local TRS of a node under an offset. */
export function nodeTRS(node, off = ZERO) {
  return { t: [node.t[0] + off.at[0], node.t[1] + off.at[1], node.t[2] + off.at[2]], q: off.rot.some((v) => v) ? qNorm(qMul(node.q, qEuler(off.rot))) : node.q.slice(), s: off.scale.slice() };
}

// ---------- clips ----------
const EASES = ['linear', 'smooth', 'step'];
export const clipDuration = (c) => Number(c.duration ?? (c.keys?.length ? c.keys[c.keys.length - 1].t ?? 0 : 0));
const ease = (u, k) => (k === 'step' ? (u >= 1 ? 1 : 0) : k === 'smooth' ? u * u * (3 - 2 * u) : u);
/**
 * Validated keys of a clip: [{t, ease, off: Map}] (strictly increasing t, seconds). ease on a key
 * = how the motion INTO that key goes (default linear). loop with duration > last t closes on
 * the first key at duration.
 */
export function clipKeys(def, info, clip) {
  if (!clip || !Array.isArray(clip.keys) || !clip.keys.length) throw new Error('clip needs keys: [{pose|parts, t (seconds), ease?}, ...]');
  const keys = clip.keys.map((k, i) => {
    if (!k || typeof k !== 'object') throw new Error(`key ${i} must be {pose|parts, t, ease?}`);
    const t = k.t === undefined && i === 0 ? 0 : Number(k.t);
    if (!Number.isFinite(t) || t < 0) throw new Error(`key ${i}: t must be seconds >= 0 (got ${JSON.stringify(k.t)})`);
    const e = k.ease ?? clip.ease ?? 'linear';
    if (!EASES.includes(e)) throw new Error(`key ${i}: ease must be ${EASES.join('|')}`);
    let off;
    try { off = resolveOffsets(def, info, k); } catch (err) { throw new Error(`key ${i}: ${err.message}`); }
    return { t, ease: e, off };
  });
  for (let i = 1; i < keys.length; i++) if (!(keys[i].t > keys[i - 1].t)) throw new Error(`key ${i}: t ${keys[i].t} must be greater than key ${i - 1}'s ${keys[i - 1].t} (glTF needs strictly increasing times)`);
  const last = keys[keys.length - 1].t;
  const duration = clip.duration !== undefined ? Number(clip.duration) : last;
  if (!(duration >= last)) throw new Error(`duration ${clip.duration} is shorter than the last key (t ${last})`);
  if (clip.loop && duration > last + 1e-9) keys.push({ t: duration, ease: keys[0].ease === 'step' ? 'step' : clip.close_ease ?? 'linear', off: keys[0].off, closing: true });
  for (const ev of clip.events || []) {
    if (!ev || typeof ev.name !== 'string' || !Number.isFinite(Number(ev.t))) throw new Error('events must be [{t (seconds), name}]');
    if (Number(ev.t) < 0 || Number(ev.t) > duration + 1e-9) throw new Error(`event "${ev.name}" at ${ev.t}s is outside the clip (0..${duration}s)`);
  }
  return { keys, duration, loop: !!clip.loop };
}
/** Nodes a clip moves, with which channels change. */
export function clipNodes(keys) {
  const out = new Map();
  for (const k of keys) for (const [n, o] of k.off) {
    const c = out.get(n) || { translation: false, rotation: false, scale: false };
    if (o.at.some((v) => v)) c.translation = true;
    if (o.rot.some((v) => v)) c.rotation = true;
    if (o.scale.some((v) => v !== 1)) c.scale = true;
    out.set(n, c);
  }
  return out;
}
/** Local TRS of every moved node at time (seconds): Map node -> {t, q, s}. */
export function sampleClip(info, ck, time, names) {
  const { keys } = ck;
  let i = keys.length - 1;
  while (i > 0 && keys[i].t > time + 1e-9) i--;
  const a = keys[i], b = i + 1 < keys.length ? keys[i + 1] : a;
  const span = b.t - a.t, u = span > 0 ? ease(Math.max(0, Math.min(1, (time - a.t) / span)), b.ease) : 0;
  const out = new Map();
  for (const n of names || clipNodes(keys).keys()) {
    const node = info.byName.get(n);
    const A = nodeTRS(node, a.off.get(n)), B = nodeTRS(node, b.off.get(n));
    out.set(n, { t: A.t.map((v, k) => v + (B.t[k] - v) * u), q: u === 0 ? A.q : u === 1 ? B.q : qSlerp(A.q, B.q, u), s: A.s.map((v, k) => v + (B.s[k] - v) * u) });
  }
  return out;
}
/** Offsets equivalent of a sampled clip (for posing previews / renders): Map node -> {t,q,s} local TRS. */
export function clipFrameTRS(info, ck, time) { return sampleClip(info, ck, time); }

/**
 * glTF channels of a clip. All keys linear -> LINEAR at the key times; all step -> STEP; mixed /
 * smooth -> baked at 30 fps (+ every key time; a step jump gets a sample 1 ms before it).
 */
export function clipChannels(info, ck, nodeIndex, fps = 30) {
  const eases = ck.keys.slice(1).map((k) => k.ease);
  let mode = 'baked';
  if (eases.every((e) => e === 'linear')) mode = 'LINEAR';
  else if (eases.every((e) => e === 'step')) mode = 'STEP';
  let times;
  if (mode !== 'baked') times = ck.keys.map((k) => k.t);
  else {
    const set = new Set();
    const T = ck.keys[ck.keys.length - 1].t;
    for (let i = 0; i * (1 / fps) < T - 1e-9; i++) set.add(+(i / fps).toFixed(6));
    for (let i = 0; i < ck.keys.length; i++) {
      set.add(+ck.keys[i].t.toFixed(6));
      if (i > 0 && ck.keys[i].ease === 'step' && ck.keys[i].t - 0.001 > ck.keys[i - 1].t) set.add(+(ck.keys[i].t - 0.001).toFixed(6));
    }
    times = [...set].sort((x, y) => x - y).filter((t, i, a) => i === 0 || t - a[i - 1] > 1e-6);
  }
  const moved = clipNodes(ck.keys);
  const samples = times.map((t) => sampleClip(info, ck, t, moved.keys()));
  const channels = [];
  for (const [n, c] of moved) {
    for (const path of ['translation', 'rotation', 'scale']) {
      if (!c[path]) continue;
      const k = path === 'translation' ? 't' : path === 'rotation' ? 'q' : 's';
      const values = [];
      let prev = null;
      for (const s of samples) {
        let v = s.get(n)[k];
        // keep consecutive quaternions in one hemisphere (LINEAR = slerp between neighbours)
        if (k === 'q' && prev && v[0] * prev[0] + v[1] * prev[1] + v[2] * prev[2] + v[3] * prev[3] < 0) v = v.map((x) => -x);
        values.push(...v);
        prev = v;
      }
      channels.push({ node: nodeIndex.get(n), path, interpolation: mode === 'STEP' ? 'STEP' : 'LINEAR', times, values });
    }
  }
  return { channels, mode: mode === 'baked' ? `baked ${fps} fps (LINEAR)` : mode, times: times.length };
}

// ---------- posing ----------
/** Every node (and socket) under a set of names, inclusive. */
export function subtree(info, names) {
  const out = new Set();
  const walk = (n) => { out.add(n); for (const c of info.byName.get(n).children) walk(c); };
  for (const n of names) { if (!info.byName.has(n)) throw new Error(`"${n}" is not a node (nodes: ${info.nodes.map((x) => x.name).join(', ')})`); walk(n); }
  return out;
}
/**
 * World transforms (3x4, px) of every node and socket for local TRS overrides (Map node -> {t,q,s}
 * or offsets {rot,at,scale}), plus the posed world mesh of the visible nodes.
 * opts: {only?: [names] (+ their children), hide?: [names] (+ children), mesh?: false, pre?: 3x4 applied last}
 */
export function posedWorld(info, pose = new Map(), opts = {}) {
  const world = new Map();
  const local = (n) => {
    const p = pose.get(n.name);
    const trs = !p ? nodeTRS(n) : p.q ? p : nodeTRS(n, p);
    return trsMatrix(trs.t, trs.q, trs.s);
  };
  const pre = opts.pre || null;
  const solve = (name) => {
    if (world.has(name)) return world.get(name);
    const n = info.byName.get(name);
    const L = local(n);
    const W = n.parent === null ? (pre ? matMul(pre, L) : L) : matMul(solve(n.parent), L);
    world.set(name, W);
    return W;
  };
  for (const n of info.nodes) solve(n.name);
  const sockets = new Map();
  for (const s of info.sockets) {
    const W = matMul(world.get(s.parent), trsMatrix(s.t, s.q, [1, 1, 1]));
    sockets.set(s.name, { matrix: W, pos: [W[3], W[7], W[11]], forward: norm([-W[2], -W[6], -W[10]]), up: norm([W[1], W[5], W[9]]) });
  }
  let mesh = null;
  if (opts.mesh !== false) {
    const show = opts.only && opts.only.length ? subtree(info, opts.only) : null;
    const hide = opts.hide && opts.hide.length ? subtree(info, opts.hide) : null;
    mesh = new Mesh();
    for (const n of info.nodes) {
      if (!n.mesh.triangles || (show && !show.has(n.name)) || (hide && hide.has(n.name))) continue;
      mesh.add(n.mesh.clone().transform(world.get(n.name)));
    }
  }
  return { world, sockets, mesh };
}

/** Model rotation for render angles: yaw about Y, pitch about X, roll about Z (about the model origin or pivot). */
export function angleMatrix({ yaw = 0, pitch = 0, roll = 0 } = {}, pivot = [0, 0, 0]) {
  const R = matMul(mRY(Number(yaw)), matMul(mRX(Number(pitch)), mRZ(Number(roll))));
  return matMul(mT(pivot[0], pivot[1], pivot[2]), matMul(R, mT(-pivot[0], -pivot[1], -pivot[2])));
}

// ---------- glTF scene of a rig ----------
/**
 * Meshes + nodes + animations for writeGLB: root node (model name, unnamed parts' mesh) with the
 * node tree below it (rest TRS), sockets as empty child nodes, one animation per clip.
 */
export function rigScene(def, info) {
  const meshes = [], nodes = [], index = new Map();
  for (const n of info.nodes) {
    index.set(n.name, nodes.length);
    const node = { name: n.name, translation: n.t, rotation: n.q, children: [] };
    if (n.mesh.triangles) { meshes.push({ name: n.name, groups: n.mesh.groups.values() }); node.mesh = meshes.length - 1; }
    if (!n.root) node.extras = { joint_px: n.joint.map((v) => +v.toFixed(4)), part: n.i };
    nodes.push(node);
  }
  for (const n of info.nodes) if (n.parent !== null) nodes[index.get(n.parent)].children.push(index.get(n.name));
  for (const s of info.sockets) {
    index.set(s.name, nodes.length);
    nodes.push({ name: s.name, translation: s.t, rotation: s.q, extras: { socket: s.key } });
    nodes[index.get(s.parent)].children.push(index.get(s.name));
  }
  const animations = [], clips = {};
  for (const [name, clip] of Object.entries(def.clips || {})) {
    const ck = clipKeys(def, info, clip);
    const { channels, mode } = clipChannels(info, ck, index);
    const events = (clip.events || []).map((e) => ({ t: Number(e.t), name: e.name })).sort((a, b) => a.t - b.t);
    const extras = { duration: ck.duration, loop: ck.loop, sampling: mode, ...(events.length ? { events } : {}) };
    if (channels.length) animations.push({ name, channels, extras });
    clips[name] = { ...extras, channels: channels.length };
  }
  return { meshes, nodes, animations, index, clips };
}

/** Joint table for meta.json (units): Roblox Motor6D C0 = parent-space joint frame. */
export function rigMeta(info, scale) {
  const f = (v) => +v.toFixed(6);
  return {
    root: info.root,
    nodes: info.nodes.map((n) => ({ name: n.name, parent: n.parent, translation: n.t.map((v) => f(v / scale)), rotation: n.q.map(f), triangles: n.mesh.triangles })),
    sockets: info.sockets.map((s) => ({ name: s.name, parent: s.parent, translation: s.t.map((v) => f(v / scale)), rotation: s.q.map(f) })),
    note: 'Rigid parts, no skinning. Each node = one part; translation/rotation are local to the parent node (glTF TRS). Roblox: one MeshPart per node, Motor6D Part0 = parent, Part1 = node, C0 = CFrame(translation) * rotation, C1 = identity. Sockets are empty nodes (attachments).',
  };
}

export { applyP };
