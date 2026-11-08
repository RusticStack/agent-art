// Skinned meshes for art_model: vertex skin weights (<= 4 influences, normalised) from automatic
// distance or heat-diffusion weights along bones (with smoothing), rigid parts (100% to the owning
// bone, blended seams) or painting (region selectors, weight canvases); blend shapes on the skinned
// mesh (variant builds, sculpted shapes, correctives driven by a joint angle); linear blend skinning
// for renders; the glTF scene (skin, joints, inverse bind matrices, TRS + weights animations); the
// Roblox profile (bone limit per mesh with mesh splitting, names sanitised, no morphs).
import { Mesh, applyP } from './model3d.js';
import { solvePoseState, sampleSkelClip, skelClipKeys, poseState, R15_NAMES, qConj, qRot, vecs, inv34 } from './skeleton3d.js';
import { matMul } from './model3d.js';
import { lookRotation } from './modelrig.js';

const { sub, add, mul, dot, len, nrm } = vecs;
const r4 = (v) => Math.round(v * 1e4) / 1e4;
export const MAX_INFLUENCES = 4;
/** Influences below this share of a vertex's total weight are dropped (heat / distance tails). */
export const MIN_WEIGHT = 0.01;
/** Assumed Roblox limit of bones (joints) per skinned MeshPart; export profile:"roblox", max_bones overrides. */
export const ROBLOX_MAX_BONES = 50;
/** Roblox triangle limit per MeshPart. */
export const ROBLOX_MAX_TRIANGLES = 20000;
const METHODS = ['distance', 'heat', 'rigid'];
const MAX_SMOOTH = 32;

// ---------- weights ----------
/**
 * Prune a sparse weight list to the n strongest influences (ties: lower bone index first) and
 * normalise to sum 1 exactly in float32 (the largest takes the rounding). [[bone, w], ...] ->
 * {j:[4], w:[4], raw: influences before pruning, sum: before normalising}
 */
export function normalizeWeights(list, n = MAX_INFLUENCES) {
  const pos = list.filter(([, w]) => w > 1e-6 && Number.isFinite(w));
  const raw = pos.length, sum = pos.reduce((s, [, w]) => s + w, 0);
  pos.sort((a, b) => b[1] - a[1] || a[0] - b[0]);
  const top = pos.slice(0, n);
  const j = [0, 0, 0, 0], w = [0, 0, 0, 0];
  const s = top.reduce((t, [, x]) => t + x, 0);
  if (!(s > 0)) return { j, w, raw: 0, sum: 0 };
  top.forEach(([b, x], k) => { j[k] = b; w[k] = Math.fround(x / s); });
  let rest = 0;
  for (let k = 1; k < top.length; k++) rest += w[k];
  w[0] = Math.fround(1 - rest);
  return { j, w, raw, sum };
}

/** Report for flat JOINTS/WEIGHTS arrays (4 per vertex). */
export function checkWeights(J, W, bones = null, raw = null) {
  const n = W.length / 4;
  let unweighted = 0, nonNorm = 0, over = 0, maxInf = 0, maxRaw = 0, inf = 0, outOfRange = 0;
  const used = new Map();
  for (let i = 0; i < n; i++) {
    let s = 0, c = 0;
    for (let k = 0; k < 4; k++) {
      const w = W[i * 4 + k];
      s += w;
      if (w > 0) { c++; used.set(J[i * 4 + k], (used.get(J[i * 4 + k]) || 0) + 1); if (bones && J[i * 4 + k] >= bones.length) outOfRange++; }
    }
    if (s < 1e-6) unweighted++;
    else if (Math.abs(s - 1) > 1e-4) nonNorm++;
    if (raw && raw[i] > MAX_INFLUENCES) over++;
    maxInf = Math.max(maxInf, c); if (raw) maxRaw = Math.max(maxRaw, raw[i]); inf += c;
  }
  const per = bones ? Object.fromEntries(bones.map((b, i) => [b, used.get(i) || 0])) : Object.fromEntries([...used].sort((a, b) => a[0] - b[0]));
  return {
    vertices: n, unweighted, non_normalised: nonNorm, over_4_influences: over, ...(outOfRange ? { joint_out_of_range: outOfRange } : {}),
    max_influences: maxInf, ...(raw ? { max_raw_influences: maxRaw } : {}), avg_influences: n ? r4(inf / n) : 0, bones_used: used.size, ...(bones ? { unused_bones: bones.filter((b, i) => !used.has(i)) } : {}), per_bone: per,
    ok: !unweighted && !nonNorm && !outOfRange,
  };
}

/** Distance from p to the segment a-b. */
const segDist = (p, a, b) => { const ab = sub(b, a), l2 = dot(ab, ab); const t = l2 > 1e-12 ? Math.max(0, Math.min(1, dot(sub(p, a), ab) / l2)) : 0; return len(sub(p, add(a, mul(ab, t)))); };
const smooth01 = (x) => { const t = Math.max(0, Math.min(1, x)); return t * t * (3 - 2 * t); };

/** Per-vertex part index of a mesh group (from face records; overlays / unknown = -1). */
function vertexParts(g) {
  const vc = g.pos.length / 3, out = new Int32Array(vc).fill(-1);
  if (g.faces) for (const f of g.faces) for (let v = f.v; v < f.v + f.vc; v++) out[v] = f.pi ?? -1;
  return out;
}

/** Uniform 1 -> 4 subdivision of every group, n times (positions, normals, UVs, part ids, morphs, overlay data). */
export function subdivideMesh(mesh, n) {
  for (let it = 0; it < n; it++) for (const g of mesh.groups.values()) {
    const cache = new Map();
    const lerpArr = (arr, k, a, b) => { for (let c = 0; c < k; c++) arr.push((arr[a * k + c] + arr[b * k + c]) / 2); };
    const mid = (a, b) => {
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      if (cache.has(key)) return cache.get(key);
      const m = g.pos.length / 3;
      lerpArr(g.pos, 3, a, b);
      lerpArr(g.nrm, 3, a, b);
      const nn = nrm([g.nrm[m * 3], g.nrm[m * 3 + 1], g.nrm[m * 3 + 2]]);
      g.nrm[m * 3] = nn[0]; g.nrm[m * 3 + 1] = nn[1]; g.nrm[m * 3 + 2] = nn[2];
      lerpArr(g.uv, 2, a, b);
      if (g.overlay) { lerpArr(g.uv0, 2, a, b); lerpArr(g.alpha, 1, a, b); }
      if (g.vpi) g.vpi.push(g.vpi[a] === g.vpi[b] ? g.vpi[a] : g.vpi[a]);
      for (const t of g.morphs || []) { lerpArr(t.pos, 3, a, b); lerpArr(t.nrm, 3, a, b); }
      cache.set(key, m);
      return m;
    };
    const idx = [];
    for (let t = 0; t < g.idx.length; t += 3) {
      const [a, b, c] = [g.idx[t], g.idx[t + 1], g.idx[t + 2]];
      const ab = mid(a, b), bc = mid(b, c), ca = mid(c, a);
      idx.push(a, ab, ca, ab, b, bc, ca, bc, c, ab, bc, ca);
    }
    g.idx = idx;
    if (g.faces) g.faces = [];
  }
  return mesh;
}

/** Region selector -> strength 0..1 of a vertex (p, part index). */
function regionFn(r, ctx, where) {
  if (!r || typeof r !== 'object') throw new Error(`${where}: region must be {box:[[x0,y0,z0],[x1,y1,z1]]} | {sphere:[x,y,z,r], falloff?} | {part} | {below:y} | {above:y} | {all:true}`);
  if (r.all) return () => 1;
  if (r.box) {
    const [a, b] = r.box;
    const lo = a.map((v, k) => Math.min(v, b[k])), hi = a.map((v, k) => Math.max(v, b[k]));
    return (p) => (p.every((v, k) => v >= lo[k] - 1e-6 && v <= hi[k] + 1e-6) ? 1 : 0);
  }
  if (r.sphere) {
    const [x, y, z, rad] = r.sphere.map(Number);
    if (!(rad > 0)) throw new Error(`${where}: sphere radius must be > 0`);
    const soft = r.falloff !== false;
    return (p) => { const d = Math.hypot(p[0] - x, p[1] - y, p[2] - z) / rad; return d >= 1 ? 0 : soft ? (1 - d * d) ** 2 : 1; };
  }
  if (r.part !== undefined) {
    const set = new Set([].concat(r.part).map((k) => ctx.partIndex(k, where)));
    return (p, pi) => (set.has(pi) ? 1 : 0);
  }
  if (r.below !== undefined) return (p) => (p[1] <= Number(r.below) ? 1 : 0);
  if (r.above !== undefined) return (p) => (p[1] >= Number(r.above) ? 1 : 0);
  throw new Error(`${where}: region needs box | sphere | part | below | above | all`);
}

/**
 * Skin a built mesh. spec: {method?: distance|heat|rigid (default heat), parts?: [parts that get the
 * method; others are rigid], rigid?: {<part>: <bone>}, blend?: px (rigid seam blend), smooth?: n,
 * falloff?: 6, exclude?: [bones], subdivide?: 0..3, paint?: [{bone, weight, mode?, region | canvas}],
 * shapes?: {<name>: {set|model|sculpt, driver?}}}. ctx: {def, built, S, partIndex(k), canvas(name),
 * variantShapes(mesh, shapes) (attaches set/model shapes as g.morphs)}.
 * -> {mesh (groups with skin {j, w} + morphs), morphNames, drivers, report}
 */
export function skinMesh(spec, ctx) {
  const { S, built } = ctx;
  const method = spec.method ?? 'heat';
  if (!METHODS.includes(method)) throw new Error(`skin.method must be ${METHODS.join(' | ')}`);
  const sub0 = Math.round(Number(spec.subdivide ?? 0));
  if (!(sub0 >= 0 && sub0 <= 3)) throw new Error('skin.subdivide must be 0..3 (each level = 4x triangles)');
  const exclude = new Set(spec.exclude || []);
  for (const b of exclude) if (!S.byName.has(b)) throw new Error(`skin.exclude: "${b}" is not a bone`);
  const deform = S.bones.filter((b) => !exclude.has(b.name));
  if (!deform.length) throw new Error('skin: every bone is excluded');
  const mesh = built.mesh.clone();
  for (const g of mesh.groups.values()) g.vpi = Array.from(vertexParts(g));
  // blend shapes from variant builds (same topology) go on before subdividing
  const shapes = spec.shapes || {};
  for (const [n, s] of Object.entries(shapes)) {
    if (!/^[\w.-]{1,48}$/.test(n)) throw new Error(`shape name "${n}" must be 1-48 letters, digits, _ - .`);
    if (!s || typeof s !== 'object' || !(s.set || s.model || s.sculpt)) throw new Error(`shape "${n}" must be {sculpt:[{sphere|box|part, move|inflate|scale}]} | {set:{<part>:{..}}} | {model}, driver?:{bone, axis, from, to}`);
  }
  const variant = Object.fromEntries(Object.entries({ ...(ctx.def.morphs || {}), ...shapes }).filter(([, s]) => s.set || s.model));
  const morphNames = Object.keys(variant).length ? ctx.variantShapes(mesh, variant) : [];
  if (sub0) subdivideMesh(mesh, sub0);
  const groups = [...mesh.groups.values()];
  // sculpted shapes (bind space)
  for (const [n, s] of Object.entries(shapes)) {
    if (!s.sculpt) continue;
    if (!Array.isArray(s.sculpt) || !s.sculpt.length) throw new Error(`shape "${n}": sculpt must be [{sphere|box|part|below|above, move?:[dx,dy,dz], inflate?:px, scale?:k, about?:[x,y,z]}]`);
    const ops = s.sculpt.map((o, i) => {
      const w = `shape "${n}" sculpt[${i}]`;
      if (o.move === undefined && o.inflate === undefined && o.scale === undefined) throw new Error(`${w}: needs move:[dx,dy,dz] | inflate:px | scale:k`);
      return { f: regionFn(o, ctx, w), move: o.move ? o.move.map(Number) : null, inflate: Number(o.inflate ?? 0), scale: o.scale !== undefined ? Number(o.scale) : null, about: o.about ? o.about.map(Number) : o.sphere ? o.sphere.slice(0, 3).map(Number) : null };
    });
    for (const g of groups) {
      const vc = g.pos.length / 3, pos = g.pos.slice(), nr = g.nrm.slice();
      for (let v = 0; v < vc; v++) {
        let p = [g.pos[v * 3], g.pos[v * 3 + 1], g.pos[v * 3 + 2]];
        const p0 = p.slice(), nn = [g.nrm[v * 3], g.nrm[v * 3 + 1], g.nrm[v * 3 + 2]];
        for (const o of ops) {
          const k = o.f(p0, g.vpi[v]);
          if (!k) continue;
          if (o.move) p = add(p, mul(o.move, k));
          if (o.inflate) p = add(p, mul(nn, o.inflate * k));
          if (o.scale !== null) { const c = o.about || p0; p = add(p, mul(sub(c, p), (1 - o.scale) * k)); }
        }
        pos[v * 3] = p[0]; pos[v * 3 + 1] = p[1]; pos[v * 3 + 2] = p[2];
      }
      (g.morphs || (g.morphs = [])).push({ name: n, pos, nrm: nr });
    }
    morphNames.push(n);
  }
  // every group carries every shape (writeGLB needs the same targets on each primitive)
  for (const g of groups) if ((g.morphs || []).length !== morphNames.length) {
    if (g.overlay && !(g.morphs || []).length) g.morphs = morphNames.map((name) => ({ name, pos: g.pos.slice(), nrm: g.nrm.slice() }));
    else throw new Error('shapes: every material must carry every shape');
  }
  const drivers = [];
  for (const [n, s] of Object.entries(shapes)) if (s.driver) {
    const d = s.driver;
    if (!S.byName.has(d.bone)) throw new Error(`shape "${n}" driver: "${d.bone}" is not a bone`);
    if (!['x', 'y', 'z'].includes(d.axis ?? 'x')) throw new Error(`shape "${n}" driver.axis must be x | y | z`);
    const from = Number(d.from ?? 0), to = Number(d.to ?? d.angle ?? 90);
    if (!(Number.isFinite(from) && Number.isFinite(to)) || from === to) throw new Error(`shape "${n}" driver: from and to must be different angles (deg)`);
    drivers.push({ name: n, bone: d.bone, axis: d.axis ?? 'x', from, to, weight: Number(d.weight ?? 1) });
  }

  // ---- weight nodes: one per (position, part) so split-normal copies share weights
  const q = (v) => Math.round(v * 1e4);
  const nodeOf = new Map(), nodes = [], vmap = groups.map((g) => new Int32Array(g.pos.length / 3));
  groups.forEach((g, gi) => {
    for (let v = 0; v < g.pos.length / 3; v++) {
      const key = `${q(g.pos[v * 3])},${q(g.pos[v * 3 + 1])},${q(g.pos[v * 3 + 2])},${g.vpi[v]}`;
      let id = nodeOf.get(key);
      if (id === undefined) { id = nodes.length; nodeOf.set(key, id); nodes.push({ p: [g.pos[v * 3], g.pos[v * 3 + 1], g.pos[v * 3 + 2]], pi: g.vpi[v] }); }
      vmap[gi][v] = id;
    }
  });
  const N = nodes.length, B = S.bones.length;
  if (N * B > 40e6) throw new Error(`skin: ${N} vertices x ${B} bones is too large (lower subdivide or segments)`);
  // adjacency (triangles)
  const adj = Array.from({ length: N }, () => new Set());
  groups.forEach((g, gi) => { for (let t = 0; t < g.idx.length; t += 3) { const a = vmap[gi][g.idx[t]], b = vmap[gi][g.idx[t + 1]], c = vmap[gi][g.idx[t + 2]]; if (a !== b) { adj[a].add(b); adj[b].add(a); } if (b !== c) { adj[b].add(c); adj[c].add(b); } if (a !== c) { adj[a].add(c); adj[c].add(a); } } });
  const nb = adj.map((s) => [...s].sort((x, y) => x - y));
  const Wt = new Float64Array(N * B);
  const owned = new Set(spec.parts !== undefined ? [].concat(spec.parts).map((k) => ctx.partIndex(k, 'skin.parts')) : []);
  const useMethod = (pi) => method !== 'rigid' && (spec.parts === undefined || owned.has(pi));
  // distances to every deforming bone
  const dist = (p) => S.bones.map((b) => (exclude.has(b.name) ? Infinity : segDist(p, b.head, b.tail)));
  const P = Number(spec.falloff ?? 6);
  const autoIds = [];
  for (let i = 0; i < N; i++) {
    const nd = nodes[i];
    if (useMethod(nd.pi)) { autoIds.push(i); continue; }
    // rigid: the owning bone, blended across joints
    const own = ctx.ownerBone(nd.pi, nd.p, deform);
    const bi = S.byName.get(own).i;
    const blend = Number(spec.blend ?? 0);
    let wSelf = 1;
    if (blend > 0) {
      const b = S.byName.get(own);
      const ax = nrm(sub(b.tail, b.head));
      // own head vs the parent
      if (b.parent && !exclude.has(b.parent) && len(ax) && len(sub(nd.p, b.head)) < blend * 3) {
        const s = dot(sub(nd.p, b.head), ax);
        if (s < blend) { const k = smooth01((s + blend) / (2 * blend)); Wt[i * B + S.byName.get(b.parent).i] += (1 - k); wSelf = k; }
      }
      // children heads
      for (const cn of b.children) {
        if (exclude.has(cn)) continue;
        const c = S.byName.get(cn), cax = nrm(sub(c.tail, c.head));
        if (!len(cax) || len(sub(nd.p, c.head)) > blend * 3) continue;
        const s = dot(sub(nd.p, c.head), cax);
        if (s > -blend) { const k = smooth01((s + blend) / (2 * blend)); Wt[i * B + c.i] += k * wSelf; wSelf *= 1 - k; }
      }
    }
    Wt[i * B + bi] += wSelf;
  }
  if (autoIds.length) {
    if (method === 'distance') {
      for (const i of autoIds) {
        const d = dist(nodes[i].p), dmin = Math.min(...d) + 0.5;
        for (let b = 0; b < B; b++) if (Number.isFinite(d[b])) Wt[i * B + b] = ((dmin) / (d[b] + 0.5)) ** P;
      }
    } else {
      // heat diffusion (Baran & Popovic 2007 style): -L w + H w = H p, p = nearest bone, H ~ 1/d^2
      const ids = new Int32Array(N).fill(-1);
      autoIds.forEach((i, k) => { ids[i] = k; });
      const H = new Float64Array(N), p = new Float64Array(N * B);
      let el = 0, ec = 0;
      for (const i of autoIds) for (const j of nb[i]) if (ids[j] >= 0) { el += len(sub(nodes[i].p, nodes[j].p)); ec++; }
      const meanEdge = ec ? el / ec : 1;
      const heat = Number(spec.heat ?? 1);
      for (const i of autoIds) {
        const d = dist(nodes[i].p), dmin = Math.min(...d);
        const near = d.map((x, b) => (x <= dmin * 1.0001 + 1e-6 ? b : -1)).filter((b) => b >= 0);
        for (const b of near) p[i * B + b] = 1 / near.length;
        const deg = nb[i].filter((j) => ids[j] >= 0).length;
        H[i] = heat * Math.max(1, deg) * (meanEdge / Math.max(dmin, meanEdge * 0.25)) ** 2;
        for (let b = 0; b < B; b++) Wt[i * B + b] = p[i * B + b];
      }
      for (let it = 0; it < 60; it++) for (const i of autoIds) {
        const ns = nb[i].filter((j) => ids[j] >= 0);
        const den = ns.length + H[i];
        for (let b = 0; b < B; b++) {
          let s = H[i] * p[i * B + b];
          for (const j of ns) s += Wt[j * B + b];
          Wt[i * B + b] = s / den;
        }
      }
    }
  }
  // smoothing (auto-weighted vertices only: rigid parts stay crisp)
  // bounded: each pass is O(vertices x bones) and the server is synchronous
  const iters = (v, what, def) => {
    if (v === undefined || v === null) return def;
    const x = Number(v);
    if (typeof v === 'boolean' || !Number.isFinite(x) || x < 0) throw new Error(`${what} must be a number of smoothing passes 0..${MAX_SMOOTH} (got ${JSON.stringify(v)})`);
    return Math.min(MAX_SMOOTH, Math.round(x));
  };
  const smoothN = iters(spec.smooth, 'skin.smooth', method === 'rigid' ? 0 : 2);
  const smoothPass = (list, lam = 0.5) => {
    const next = new Float64Array(Wt);
    for (const i of list) {
      const ns = nb[i];
      if (!ns.length) continue;
      for (let b = 0; b < B; b++) { let s = 0; for (const j of ns) s += Wt[j * B + b]; next[i * B + b] = (1 - lam) * Wt[i * B + b] + lam * (s / ns.length); }
    }
    Wt.set(next);
  };
  const normRow = (i) => { let s = 0; for (let b = 0; b < B; b++) s += Wt[i * B + b]; if (s > 0) for (let b = 0; b < B; b++) Wt[i * B + b] /= s; };
  for (let i = 0; i < N; i++) normRow(i);
  for (let s = 0; s < smoothN; s++) { smoothPass(autoIds); for (const i of autoIds) normRow(i); }
  // painting
  for (const [k, op] of (spec.paint || []).entries()) {
    const w = `skin.paint[${k}]`;
    if (!op || !S.byName.has(op.bone)) throw new Error(`${w}: needs bone (one of ${S.bones.map((b) => b.name).join(', ')})`);
    const bi = S.byName.get(op.bone).i, mode = op.mode ?? 'set', target = Number(op.weight ?? 1);
    if (!['set', 'add', 'smooth'].includes(mode)) throw new Error(`${w}: mode must be set | add | smooth`);
    let f;
    if (op.canvas) f = canvasFn(op, ctx, built.mesh.bounds(), w);
    else f = regionFn(op.region ?? op, ctx, w);
    const hit = [];
    for (let i = 0; i < N; i++) {
      const s = f(nodes[i].p, nodes[i].pi);
      if (!(s > 0)) continue;
      hit.push(i);
      if (mode === 'smooth') continue;
      if (mode === 'add') { Wt[i * B + bi] += target * s; normRow(i); continue; }
      const cur = Wt[i * B + bi], nw = cur + (Math.max(0, Math.min(1, target)) - cur) * s;
      const others = 1 - cur;
      for (let b = 0; b < B; b++) if (b !== bi) Wt[i * B + b] = others > 1e-9 ? (Wt[i * B + b] / others) * (1 - nw) : 0;
      Wt[i * B + bi] = nw;
      if (others <= 1e-9 && nw < 1) { // only this bone so far: give the rest to the nearest other bone
        const d = dist(nodes[i].p); d[bi] = Infinity;
        const o = d.indexOf(Math.min(...d));
        if (o >= 0 && Number.isFinite(d[o])) Wt[i * B + o] = 1 - nw;
      }
    }
    if (mode === 'smooth') for (let s = 0; s < Math.max(1, iters(op.iterations, `${w}.iterations`, 2)); s++) { smoothPass(hit); for (const i of hit) normRow(i); }
  }
  // final: <= 4 influences, normalised; unweighted -> nearest bone
  const NJ = new Uint16Array(N * 4), NW = new Float32Array(N * 4), raw = new Uint16Array(N);
  let fallback = 0;
  for (let i = 0; i < N; i++) {
    const list = [];
    // influences below 1% of the vertex total are diffusion tails: dropped before the 4-influence cut
    let tot = 0;
    for (let b = 0; b < B; b++) if (!exclude.has(S.bones[b].name)) tot += Math.max(0, Wt[i * B + b]);
    for (let b = 0; b < B; b++) if (Wt[i * B + b] > tot * MIN_WEIGHT && !exclude.has(S.bones[b].name)) list.push([b, Wt[i * B + b]]);
    let r = normalizeWeights(list);
    if (!r.raw) { const d = dist(nodes[i].p); r = normalizeWeights([[d.indexOf(Math.min(...d)), 1]]); fallback++; }
    raw[i] = r.raw;
    NJ.set(r.j, i * 4); NW.set(r.w, i * 4);
  }
  groups.forEach((g, gi) => {
    const vc = g.pos.length / 3, j = new Array(vc * 4), w = new Array(vc * 4);
    for (let v = 0; v < vc; v++) { const id = vmap[gi][v]; for (let k = 0; k < 4; k++) { j[v * 4 + k] = NJ[id * 4 + k]; w[v * 4 + k] = NW[id * 4 + k]; } }
    g.skin = { j, w };
    delete g.vpi;
  });
  const report = checkWeights(NJ, NW, S.bones.map((b) => b.name), raw);
  report.method = method; report.weight_nodes = N; report.fallback_nearest = fallback;
  if (sub0) report.subdivide = sub0;
  report.triangles = mesh.triangles;
  return { mesh, morphNames, drivers, report };
}

/** Weight canvas: canvas luminance (or alpha / red) projected over the model bounds from a view. */
function canvasFn(op, ctx, bounds, where) {
  const t = ctx.canvas(op.canvas);
  const view = op.view ?? 'front', ch = op.channel ?? 'l';
  if (!['front', 'side', 'top'].includes(view)) throw new Error(`${where}: view must be front | side | top`);
  const { min, max } = bounds, size = max.map((v, k) => Math.max(1e-6, v - min[k]));
  return (p) => {
    let u, v;
    if (view === 'front') { u = (p[0] - min[0]) / size[0]; v = (max[1] - p[1]) / size[1]; }
    else if (view === 'side') { u = (p[2] - min[2]) / size[2]; v = (max[1] - p[1]) / size[1]; }
    else { u = (p[0] - min[0]) / size[0]; v = (p[2] - min[2]) / size[2]; }
    const x = Math.max(0, Math.min(t.width - 1, Math.floor(u * t.width))), y = Math.max(0, Math.min(t.height - 1, Math.floor(v * t.height)));
    const o = (y * t.width + x) * 4, d = t.data;
    if (ch === 'a') return d[o + 3] / 255;
    if (ch === 'r') return (d[o] / 255) * (d[o + 3] / 255);
    return ((0.299 * d[o] + 0.587 * d[o + 1] + 0.114 * d[o + 2]) / 255) * (d[o + 3] / 255);
  };
}

// ---------- deformation ----------
/** Linear blend skinning of a skinned mesh under a solved pose (morph weights first, in bind space). -> Mesh (render groups) */
export function deformMesh(skinned, solved, S, morphNames = []) {
  const M = S.bones.map((b) => solved.skin.get(b.name));
  const out = new Mesh();
  const mw = morphNames.map((n) => Number(solved.morphs?.[n] ?? 0));
  for (const g of skinned.groups.values()) {
    const vc = g.pos.length / 3;
    const pos = new Array(vc * 3), nr = new Array(vc * 3);
    for (let v = 0; v < vc; v++) {
      let p = [g.pos[v * 3], g.pos[v * 3 + 1], g.pos[v * 3 + 2]], n = [g.nrm[v * 3], g.nrm[v * 3 + 1], g.nrm[v * 3 + 2]];
      if (g.morphs) mw.forEach((w, k) => { if (!w) return; const t = g.morphs[k]; for (let c = 0; c < 3; c++) { p[c] += (t.pos[v * 3 + c] - g.pos[v * 3 + c]) * w; n[c] += (t.nrm[v * 3 + c] - g.nrm[v * 3 + c]) * w; } });
      const sp = [0, 0, 0], sn = [0, 0, 0];
      for (let k = 0; k < 4; k++) {
        const w = g.skin.w[v * 4 + k];
        if (!w) continue;
        const A = M[g.skin.j[v * 4 + k]];
        const q = applyP(A, p);
        sp[0] += q[0] * w; sp[1] += q[1] * w; sp[2] += q[2] * w;
        sn[0] += (A[0] * n[0] + A[1] * n[1] + A[2] * n[2]) * w; sn[1] += (A[4] * n[0] + A[5] * n[1] + A[6] * n[2]) * w; sn[2] += (A[8] * n[0] + A[9] * n[1] + A[10] * n[2]) * w;
      }
      const nn = nrm(sn);
      pos[v * 3] = sp[0]; pos[v * 3 + 1] = sp[1]; pos[v * 3 + 2] = sp[2];
      nr[v * 3] = nn[0]; nr[v * 3 + 1] = nn[1]; nr[v * 3 + 2] = nn[2];
    }
    const og = out.group(g.tex, !!g.overlay);
    og.pos = pos; og.nrm = nr; og.uv = g.uv.slice(); og.idx = g.idx.slice();
    if (g.overlay) { og.uv0 = g.uv0.slice(); og.alpha = g.alpha.slice(); }
  }
  return out;
}

/** Socket world frames on a solved pose: skeleton.sockets {name: {bone, at:[x,y,z] (rest model px), look?, up?}}. */
export function skelSockets(S, solved) {
  const out = new Map();
  for (const [key, s] of Object.entries(S.spec.sockets || {})) {
    const b = S.byName.get(s.bone);
    if (!b) throw new Error(`skeleton socket "${key}": "${s.bone}" is not a bone`);
    const R = lookRotation(s.look || [0, 0, -1], s.up || undefined);
    const rest = [R[0], R[1], R[2], s.at[0], R[4], R[5], R[6], s.at[1], R[8], R[9], R[10], s.at[2]];
    const W = matMul(solved.skin.get(b.name), rest);
    out.set(`socket_${key}`, { matrix: W, pos: [W[3], W[7], W[11]], forward: nrm([-W[2], -W[6], -W[10]]), up: nrm([W[1], W[5], W[9]]), bone: b.name, local: matMul(b.ibm, rest) });
  }
  return out;
}

// ---------- glTF scene ----------
/** Clip sample times: every 1/fps plus every key and event time. */
function sampleTimes(ck, fps) {
  const set = new Set();
  for (let i = 0; i * (1 / fps) < ck.duration - 1e-9; i++) set.add(+(i / fps).toFixed(6));
  set.add(+ck.duration.toFixed(6));
  for (const k of ck.keys) set.add(+k.t.toFixed(6));
  return [...set].sort((a, b) => a - b).filter((t, i, a) => i === 0 || t - a[i - 1] > 1e-6);
}

/**
 * Scene for writeGLB: armature node (model name) holding the bone tree (rest TRS), sockets as bone
 * children, the skinned mesh node (skin 0) at the scene root, one animation per skeleton clip
 * (IK / constraints / plants / drivers baked at fps): TRS channels for moving bones, a weights
 * channel for the shapes.
 */
export function skinScene(name, S, sk, { fps = 30, clips = null } = {}) {
  const nodes = [{ name, children: [] }];
  const index = new Map();
  for (const b of S.bones) { index.set(b.name, nodes.length); nodes.push({ name: b.name, translation: b.t, rotation: b.q, children: [], extras: { head_px: b.head.map(r4), ...(b.limits ? { limits: b.limits } : {}) } }); }
  for (const b of S.bones) nodes[b.parent ? index.get(b.parent) : 0].children.push(index.get(b.name));
  const rest = { local: new Map(S.bones.map((b) => [b.name, { t: b.t, q: b.q, s: [1, 1, 1] }])), morphs: {}, ik: {}, targets: {} };
  for (const [k, s] of skelSockets(S, solvePoseState(S, rest))) {
    index.set(k, nodes.length);
    nodes.push({ name: k, matrix: s.local, extras: { socket: k.slice(7) } });
    nodes[index.get(s.bone)].children.push(index.get(k));
  }
  for (const n of nodes) if (!n.children || !n.children.length) delete n.children;
  const meshNode = nodes.length;
  nodes.push({ name: `${name}_mesh`, mesh: 0, skin: 0 });
  const meshes = [{ name, groups: [...sk.mesh.groups.values()] }];
  const skins = [{ name, joints: S.bones.map((b) => index.get(b.name)), skeleton: 0, ibm: S.bones.map((b) => b.ibm) }];
  const animations = [], info = {};
  for (const [cn, clip] of Object.entries(clips || S.clips)) {
    const ck = skelClipKeys(S, clip, sk.morphNames);
    const times = sampleTimes(ck, Number(clip.fps_export ?? fps));
    const solved = times.map((t) => solvePoseState(S, sampleSkelClip(S, ck, t), { drivers: sk.drivers }));
    const channels = [];
    for (const b of S.bones) {
      const L = solved.map((s) => s.local.get(b.name));
      const moves = (k, ref) => L.some((x) => x[k].some((v, i) => Math.abs(v - ref[i]) > 1e-5));
      for (const [path, k, ref] of [['translation', 't', b.t], ['rotation', 'q', null], ['scale', 's', [1, 1, 1]]]) {
        if (k === 'q' ? !L.some((x) => Math.abs(Math.abs(x.q[0] * b.q[0] + x.q[1] * b.q[1] + x.q[2] * b.q[2] + x.q[3] * b.q[3]) - 1) > 1e-7) : !moves(k, ref)) continue;
        const values = [];
        let prev = null;
        for (const x of L) { let v = x[k]; if (k === 'q' && prev && v[0] * prev[0] + v[1] * prev[1] + v[2] * prev[2] + v[3] * prev[3] < 0) v = v.map((y) => -y); values.push(...v); prev = v; }
        channels.push({ node: index.get(b.name), path, interpolation: 'LINEAR', times, values });
      }
    }
    if (sk.morphNames.length) {
      const values = [];
      for (const s of solved) for (const m of sk.morphNames) values.push(Number(s.morphs[m] ?? 0));
      if (values.some((v) => v !== 0)) channels.push({ node: meshNode, path: 'weights', interpolation: 'LINEAR', times, values });
    }
    const extras = { duration: ck.duration, loop: ck.loop, sampling: `baked ${fps} fps (LINEAR)`, ...(ck.events.length ? { events: ck.events } : {}) };
    if (channels.length) animations.push({ name: cn, channels, extras });
    info[cn] = { ...extras, channels: channels.length, samples: times.length };
  }
  return { meshes, nodes, skins, animations, index, meshNode, clips: info };
}

// ---------- Roblox profile ----------
const robloxName = (n, used) => {
  let s = String(n).replace(/[^A-Za-z0-9_]/g, '_').replace(/^(\d)/, '_$1').slice(0, 50) || 'Bone';
  let k = s, i = 1;
  while (used.has(k)) k = `${s.slice(0, 46)}_${i++}`;
  used.add(k);
  return k;
};
/**
 * Split a skinned mesh so every piece uses <= maxBones joints (greedy over triangles in bone order).
 * -> [{mesh (joint indices local to the piece), joints: [global bone indices]}]
 */
export function splitByBones(mesh, maxBones) {
  const tris = [];
  for (const g of mesh.groups.values()) for (let t = 0; t < g.idx.length; t += 3) {
    const set = new Set();
    for (let k = 0; k < 3; k++) { const v = g.idx[t + k]; for (let c = 0; c < 4; c++) if (g.skin.w[v * 4 + c] > 0) set.add(g.skin.j[v * 4 + c]); }
    tris.push({ g, t, set, key: Math.min(...set) });
  }
  tris.sort((a, b) => a.key - b.key || a.t - b.t);
  const chunks = [];
  let cur = null;
  for (const tr of tris) {
    if (!cur || [...tr.set].filter((j) => !cur.joints.has(j)).length + cur.joints.size > maxBones) { cur = { joints: new Set(), tris: [] }; chunks.push(cur); }
    for (const j of tr.set) cur.joints.add(j);
    cur.tris.push(tr);
  }
  return chunks.map((c) => {
    const joints = [...c.joints].sort((a, b) => a - b), local = new Map(joints.map((j, i) => [j, i]));
    const m = new Mesh();
    const maps = new Map();
    for (const { g, t } of c.tris) {
      const og = m.group(g.tex, !!g.overlay);
      if (!og.skin) og.skin = { j: [], w: [] };
      if (!maps.has(og)) maps.set(og, new Map());
      const vm = maps.get(og);
      for (let k = 0; k < 3; k++) {
        const v = g.idx[t + k];
        let nv = vm.get(v);
        if (nv === undefined) {
          nv = og.pos.length / 3; vm.set(v, nv);
          og.pos.push(g.pos[v * 3], g.pos[v * 3 + 1], g.pos[v * 3 + 2]); og.nrm.push(g.nrm[v * 3], g.nrm[v * 3 + 1], g.nrm[v * 3 + 2]); og.uv.push(g.uv[v * 2], g.uv[v * 2 + 1]);
          if (g.overlay) { og.uv0.push(g.uv0[v * 2], g.uv0[v * 2 + 1]); og.alpha.push(g.alpha[v]); }
          for (let q = 0; q < 4; q++) { const w = g.skin.w[v * 4 + q]; og.skin.j.push(w > 0 ? local.get(g.skin.j[v * 4 + q]) : 0); og.skin.w.push(w); }
        }
        og.idx.push(nv);
      }
    }
    return { mesh: m, joints };
  });
}

/**
 * Roblox profile on a skin scene: <= maxBones joints per mesh (the mesh is split into several
 * skinned meshes sharing the skeleton), <= 4 influences, names sanitised (letters, digits, _),
 * R15 bone names (r15), morph targets dropped (MeshParts have no blend shapes; FACS heads need
 * a FaceControls setup), triangles per mesh checked. Mutates and returns the scene + a report.
 */
export function robloxProfile(scene, S, { maxBones = ROBLOX_MAX_BONES, r15 = false } = {}) {
  const warnings = [];
  const used = new Set(), renamed = {};
  for (const [i, n] of scene.nodes.entries()) {
    const want = r15 && R15_NAMES[n.name] && S.byName.has(n.name) && scene.skins[0].joints.includes(i) ? R15_NAMES[n.name] : n.name;
    const nn = robloxName(want, used);
    if (nn !== n.name) renamed[n.name] = nn;
    n.name = nn;
  }
  for (const a of scene.animations) a.name = robloxName(a.name, new Set());
  // morph targets dropped
  let dropped = 0;
  const groups = [...scene.meshes[0].groups].map((g) => { const { morphs, ...rest } = g; if (morphs) dropped = morphs.length; return rest; });
  const before = scene.animations.reduce((s, a) => s + a.channels.length, 0);
  for (const a of scene.animations) a.channels = a.channels.filter((c) => c.path !== 'weights');
  scene.animations = scene.animations.filter((a) => a.channels.length);
  if (dropped) warnings.push(`${dropped} blend shapes dropped (Roblox MeshParts have no morph targets; ${before - scene.animations.reduce((s, a) => s + a.channels.length, 0)} weights channels removed)`);
  const rotated = S.bones.filter((b) => b.rotate && b.rotate.some((v) => Math.abs(v) > 1e-6)).map((b) => b.name);
  if (rotated.length) warnings.push(`bones with rest rotations (${rotated.join(', ')}): Roblox expects bones frozen at rotation 0 (rebuild the skeleton from a template or without rotate)`);
  // bone limit per mesh: split
  const meshDef = scene.meshes[0], mesh = new Mesh();
  for (const g of groups) mesh.groups.set(g.overlay ? `ov:${g.tex.key}` : g.tex.key, g);
  const all = scene.skins[0];
  let pieces = [{ mesh, joints: S.bones.map((b, i) => i) }];
  if (S.bones.length > maxBones) pieces = splitByBones(mesh, maxBones);
  const meshNodeName = scene.nodes[scene.meshNode].name;
  scene.meshes = []; scene.skins = [];
  const meshNodes = [];
  pieces.forEach((pc, k) => {
    scene.meshes.push({ name: pieces.length > 1 ? `${meshDef.name}_${k}` : meshDef.name, groups: [...pc.mesh.groups.values()] });
    scene.skins.push({ name: `${all.name}${pieces.length > 1 ? `_${k}` : ''}`, joints: pc.joints.map((j) => all.joints[j]), skeleton: all.skeleton, ibm: pc.joints.map((j) => all.ibm[j]) });
    meshNodes.push({ name: pieces.length > 1 ? `${meshNodeName}_${k}` : meshNodeName, mesh: k, skin: k, tris: pc.mesh.triangles, joints: pc.joints.length });
  });
  scene.nodes.splice(scene.meshNode, 1, ...meshNodes.map(({ tris, joints, ...n }) => n));
  for (const m of meshNodes) if (m.tris > ROBLOX_MAX_TRIANGLES) warnings.push(`${m.name}: ${m.tris} triangles (Roblox MeshParts allow ${ROBLOX_MAX_TRIANGLES})`);
  return {
    profile: 'roblox', max_bones: maxBones, bones: S.bones.length, meshes: meshNodes.map((m) => ({ name: m.name, joints: m.joints, triangles: m.tris })), max_influences: MAX_INFLUENCES,
    ...(Object.keys(renamed).length ? { renamed } : {}), ...(warnings.length ? { warnings } : {}),
    note: `Assumed limits: ${maxBones} bones per skinned MeshPart (export max_bones overrides), 4 influences per vertex, ${ROBLOX_MAX_TRIANGLES} triangles per MeshPart. Import with the 3D Importer (rig type: custom); each mesh becomes a MeshPart with Bones under it; animations import as AnimationClips (re-save through the Animation Editor to publish).`,
  };
}

export { qConj, qRot, inv34, poseState };
