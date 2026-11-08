// Kit assemblies for art_model: parametric multi-part components (ship parts, interior rooms,
// industrial and city pieces) that expand into ordinary parts before a model is built, with
// sockets, poses and clips. Expansion is a pure def -> def step (expandDef), so rigs, exports and
// previews see plain parts, and a model that uses no assembly and no on_hull is returned as is
// (its exports stay byte-identical).
//
// Rules:
//   - An assembly part {type:"<assembly>", ...params, at?, rotate?, turn?, scale? (uniform),
//     on_hull?, parent?} expands in place. Its own transform applies to every generated part.
//   - Named (name:"gear_fl") = animated: generated nodes are "<name>" and "<name>.<piece>" and
//     the assembly adds its clips (shared clip names such as gear_retract are merged across
//     assemblies). Unnamed = static: one merged mesh in the given state (open, deployed, ...).
//   - on_hull:{hull:"<hull part id|name>", t, u, lift?, mirror?} places a part (any part, not
//     only assemblies) on that hull's surface: local +Y = surface normal, +Z = toward the nose.
//   - Assemblies add markers (lights, plume / hardpoint / door points) as marker parts; named
//     assemblies add real sockets too.
import { hullPlacement, hullSurface } from './hull.js';
import { mulberry32 } from './util.js';
import { ASSEMBLIES, ASSEMBLY_DOCS, registerAssembly } from './assemblies.js';

// ---------- small matrix helpers (3x3 rows) ----------
const D2R = Math.PI / 180;
const rx = (d) => { const c = Math.cos(d * D2R), s = Math.sin(d * D2R); return [[1, 0, 0], [0, c, -s], [0, s, c]]; };
const ry = (d) => { const c = Math.cos(d * D2R), s = Math.sin(d * D2R); return [[c, 0, s], [0, 1, 0], [-s, 0, c]]; };
const rz = (d) => { const c = Math.cos(d * D2R), s = Math.sin(d * D2R); return [[c, -s, 0], [s, c, 0], [0, 0, 1]]; };
const mm = (A, B) => A.map((r) => [0, 1, 2].map((j) => r[0] * B[0][j] + r[1] * B[1][j] + r[2] * B[2][j]));
const mv = (A, v) => [A[0][0] * v[0] + A[0][1] * v[1] + A[0][2] * v[2], A[1][0] * v[0] + A[1][1] * v[1] + A[1][2] * v[2], A[2][0] * v[0] + A[2][1] * v[1] + A[2][2] * v[2]];
const I3 = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
const v3 = (v, d = 0) => (v === undefined || v === null ? [d, d, d] : typeof v === 'number' ? [v, v, v] : [Number(v[0] ?? d), Number(v[1] ?? d), Number(v[2] ?? d)]);
/** Rotation of a part (rotate X then Y then Z about fixed axes, then turn). */
export function rotOf(p) {
  const t = p.transform || {};
  const r = v3(t.rotate ?? p.rotate), turn = Number(t.turn ?? p.turn ?? 0);
  let R = mm(rz(r[2]), mm(ry(r[1]), rx(r[0])));
  if (turn) R = mm(ry(turn * 90), R);
  return R;
}
/** Euler degrees [x, y, z] with R = Rz * Ry * Rx. */
export function eulerOf(R) {
  const b = Math.asin(Math.max(-1, Math.min(1, -R[2][0])));
  let a, c;
  if (Math.abs(Math.cos(b)) > 1e-6) { a = Math.atan2(R[2][1], R[2][2]); c = Math.atan2(R[1][0], R[0][0]); } else { a = Math.atan2(-R[1][2], R[1][1]); c = 0; }
  const f = (v) => { const d = Math.round(((v * 180) / Math.PI) * 1e4) / 1e4; return Object.is(d, -0) ? 0 : d; };
  return [f(a), f(b), f(c)];
}
const r4 = (v) => { const x = Math.round(v * 1e4) / 1e4; return Object.is(x, -0) ? 0 : x; };

/** Frame of a placement: {t: translation, R: rotation (3x3), s: uniform scale}. */
function frameOf(p, grid) {
  const t = p.transform || {};
  const sc = t.scale ?? p.scale;
  let s = 1;
  if (sc !== undefined && sc !== null) {
    const sv = v3(sc, 1);
    if (Math.abs(sv[0] - sv[1]) > 1e-9 || Math.abs(sv[1] - sv[2]) > 1e-9) throw new Error('assembly scale must be uniform (one number)');
    s = sv[0];
  }
  const at = v3(t.translate ?? t.at ?? p.at), cell = v3(t.cell ?? p.cell);
  return { t: [at[0] + cell[0] * grid, at[1] + cell[1] * grid, at[2] + cell[2] * grid], R: rotOf(p), s };
}
/** Compose a parent frame F onto a child part (keeps the part's own pivot, scale, mirror rules). */
function placeIn(F, q, grid) {
  if (!q) return q;
  const o = { ...q };
  const R0 = rotOf(q), pv = Array.isArray(q.pivot) && q.pivot.length === 3 ? q.pivot.map(Number) : [0, 0, 0];
  const at = v3(q.at), cell = v3(q.cell);
  const a0 = [at[0] + cell[0] * grid, at[1] + cell[1] * grid, at[2] + cell[2] * grid];
  // at' = F.t + F.R s (at + pv) - pv
  const w = mv(F.R, [(a0[0] + pv[0]) * F.s, (a0[1] + pv[1]) * F.s, (a0[2] + pv[2]) * F.s]);
  o.at = [r4(F.t[0] + w[0] - pv[0]), r4(F.t[1] + w[1] - pv[1]), r4(F.t[2] + w[2] - pv[2])];
  delete o.cell; delete o.turn; delete o.transform;
  const e = eulerOf(mm(F.R, R0));
  if (e.some((v) => v)) o.rotate = e; else delete o.rotate;
  if (F.s !== 1) {
    const sv = v3(q.scale, 1);
    o.scale = sv.map((v) => r4(v * F.s));
  }
  if (q.array && (q.array.rotate || q.array.turn) && (F.R !== I3 || F.s !== 1)) return unrollArray(q, grid).map((c) => placeIn(F, c, grid));
  if (q.array) {
    const arr = { ...q.array };
    const st = v3(arr.step), cst = v3(arr.cell_step);
    const step = mv(F.R, [(st[0] + cst[0] * grid) * F.s, (st[1] + cst[1] * grid) * F.s, (st[2] + cst[2] * grid) * F.s]);
    arr.step = step.map(r4); delete arr.cell_step;
    if (arr.about) { const ab = mv(F.R, v3(arr.about).map((v) => v * F.s)); arr.about = [r4(F.t[0] + ab[0]), r4(F.t[1] + ab[1]), r4(F.t[2] + ab[2])]; }
    o.array = arr;
  }
  // tube / sweep paths are part-local already (they move with at / rotate): nothing to do
  return o;
}
/** Explicit copies of a rotating array (local frame), so a rotated assembly turns them about its own axes. */
function unrollArray(q, grid) {
  const arr = q.array, count = Math.max(1, Math.min(1000, Math.round(Number(arr.count ?? 2))));
  const st = v3(arr.step), cst = v3(arr.cell_step), rot = v3(arr.rotate), turn = Number(arr.turn ?? 0);
  const about = arr.about ? v3(arr.about) : null;
  const R0 = rotOf(q), pv = Array.isArray(q.pivot) && q.pivot.length === 3 ? q.pivot.map(Number) : [0, 0, 0];
  const at = v3(q.at), cell = v3(q.cell), a0 = [at[0] + cell[0] * grid, at[1] + cell[1] * grid, at[2] + cell[2] * grid];
  const out = [];
  for (let k = 0; k < count; k++) {
    const Rk = mm(ry(turn * 90 * k), mm(rz(rot[2] * k), mm(ry(rot[1] * k), rx(rot[0] * k))));
    const step = [(st[0] + cst[0] * grid) * k, (st[1] + cst[1] * grid) * k, (st[2] + cst[2] * grid) * k];
    const c = { ...q }; delete c.array; delete c.cell; delete c.turn; delete c.transform;
    // point the part's pivot lands on: about + Rk (a0 + pv - about) (radial) | a0 + pv (local copy turn)
    const P0 = [a0[0] + pv[0], a0[1] + pv[1], a0[2] + pv[2]];
    const P1 = about ? (() => { const d = mv(Rk, [P0[0] - about[0], P0[1] - about[1], P0[2] - about[2]]); return [about[0] + d[0], about[1] + d[1], about[2] + d[2]]; })() : P0;
    c.at = [r4(P1[0] - pv[0] + step[0]), r4(P1[1] - pv[1] + step[1]), r4(P1[2] - pv[2] + step[2])];
    const e = eulerOf(about ? mm(Rk, R0) : mm(R0, Rk));
    if (e.some((v) => v)) c.rotate = e; else delete c.rotate;
    out.push(c);
  }
  return out;
}
const placePoint = (F, p) => { const w = mv(F.R, v3(p).map((v) => v * F.s)); return [r4(F.t[0] + w[0]), r4(F.t[1] + w[1]), r4(F.t[2] + w[2])]; };
const placeDir = (F, d) => mv(F.R, v3(d)).map(r4);

// ---------- registry (assemblies.js) ----------
export { ASSEMBLIES, ASSEMBLY_DOCS, registerAssembly };

// ---------- expansion ----------
const cache = new WeakMap();
const needs = (def) => Array.isArray(def.parts) && def.parts.some((p) => p && (ASSEMBLIES[p.type] || p.on_hull));
/**
 * Expand assemblies and on_hull placements: def -> def (the same object when there is nothing to
 * expand). Generated clips with the same name are merged (union of key times, each assembly's
 * offsets interpolated at the others' times).
 */
export function expandDef(def) {
  if (!def || !needs(def)) return def;
  if (cache.has(def)) return cache.get(def);
  const grid = Number(def.grid ?? 32);
  const hulls = new Map();
  def.parts.forEach((p, i) => { if (p && p.type === 'hull') { hulls.set(i, p); if (p.id !== undefined) hulls.set(p.id, p); if (p.name !== undefined) hulls.set(p.name, p); } });
  const findHull = (k, i) => {
    if (k === undefined && hulls.size) return [...hulls.values()][0];
    const h = hulls.get(k) ?? hulls.get(Number(k));
    if (!h) throw new Error(`part ${i}: on_hull.hull "${k}" is not a hull part (id, name or index of a {type:"hull"} part)`);
    return h;
  };
  const out = [], sockets = { ...(def.sockets || {}) }, poses = { ...(def.poses || {}) }, genClips = new Map();
  const used = new Set(def.parts.filter((p) => p && p.name && !ASSEMBLIES[p.type]).map((p) => p.name));
  const expandOne = (p, i, depth) => {
    if (depth > 6) throw new Error(`part ${i}: assemblies nest too deep`);
    let list = [p];
    if (p.on_hull) {
      const oh = p.on_hull;
      if (typeof oh !== 'object') throw new Error(`part ${i}: on_hull must be {hull?, t, u, lift?, mirror?}`);
      const H = findHull(oh.hull, i);
      const place = (u, sfx) => {
        const pl = hullPlacement(H, { ...oh, u });
        const F = { t: pl.pos, R: pl.R, s: 1 };
        const q = { ...p };
        delete q.on_hull;
        if (sfx && q.name) q.name = `${q.name}${sfx}`;
        if (ASSEMBLIES[q.type]) return [{ ...q, _frame: F }];
        return [].concat(placeIn(F, q, grid));
      };
      list = place(Number(oh.u ?? 0), '');
      if (oh.mirror) list.push(...place(1 - Number(oh.u ?? 0), '_m'));
    }
    const res = [];
    for (const q of list) {
      if (!ASSEMBLIES[q.type]) { res.push(q); continue; }
      const F0 = q._frame || { t: [0, 0, 0], R: I3, s: 1 };
      const local = frameOf({ ...q, at: q.at, cell: q.cell }, grid);
      // assembly frame = on_hull frame * own transform
      const F = { t: placePoint(F0, local.t), R: mm(F0.R, local.R), s: F0.s * local.s };
      const N = q.name ?? null;
      if (N !== null && (typeof N !== 'string' || !/^[A-Za-z0-9_.-]{1,48}$/.test(N))) throw new Error(`part ${i} (${q.type}): name must be 1-48 letters, digits, _ - .`);
      const id = N ?? q.id ?? `${q.type}${i}`;
      const k = { node: (piece) => (N === null ? null : piece ? `${N}.${piece}` : N), rig: N !== null, grid, rnd: mulberry32((Number(q.seed ?? i + 1) * 2654435761) >>> 0 || 1), id, hullOf: (ref) => findHull(ref, i), surface: hullSurface };
      let r;
      try { r = ASSEMBLIES[q.type](q, k); } catch (e) { throw new Error(`part ${i} (${q.type}): ${e.message}${ASSEMBLY_DOCS[q.type] ? `\nusage: ${q.type} {${ASSEMBLY_DOCS[q.type]}}` : ''}`); }
      for (const sub of r.parts) {
        if (!sub) continue;
        const s2 = { ...sub };
        if (s2.parent === undefined && q.parent !== undefined) s2.parent = q.parent;
        for (const key of ['material', 'cast_shadow', 'receive_shadow', 'overlays']) if (q[key] !== undefined && s2[key] === undefined && !s2.glass && !s2.emissive_part) s2[key] = q[key];
        delete s2.emissive_part;
        if (s2.name) {
          if (used.has(s2.name)) throw new Error(`part ${i} (${q.type}): node "${s2.name}" already exists (give the assembly another name)`);
          used.add(s2.name);
        }
        for (const placed of [].concat(placeIn(F, s2, grid))) {
          if (ASSEMBLIES[placed.type] || placed.on_hull) res.push(...expandOne(placed, i, depth + 1));
          else res.push(placed);
        }
      }
      for (const [n, s] of Object.entries(r.sockets || {})) sockets[n] = { ...s, at: placePoint(F, s.at), ...(s.look ? { look: placeDir(F, s.look) } : {}) };
      for (const [n, ps] of Object.entries(r.poses || {})) poses[n] = { parts: { ...(poses[n]?.parts || {}), ...ps.parts } };
      for (const [n, c] of Object.entries(r.clips || {})) { if (!genClips.has(n)) genClips.set(n, []); genClips.get(n).push(c); }
    }
    return res;
  };
  def.parts.forEach((p, i) => { if (!p) return; out.push(...expandOne(p, i, 0)); });
  const clips = { ...Object.fromEntries([...genClips].map(([n, list]) => [n, mergeClips(list)])), ...(def.clips || {}) };
  const next = { ...def, parts: out };
  if (Object.keys(sockets).length) next.sockets = sockets;
  if (Object.keys(poses).length) next.poses = poses;
  if (Object.keys(clips).length) next.clips = clips;
  next._expanded = { from: def.parts.length, parts: out.length, clips: [...genClips.keys()] };
  cache.set(def, next);
  return next;
}

/** Merge clips (keys with parts only) over the union of their key times. */
export function mergeClips(list) {
  if (list.length === 1) return list[0];
  const times = [...new Set(list.flatMap((c) => c.keys.map((k) => +Number(k.t).toFixed(6))))].sort((a, b) => a - b);
  const sample = (c, t) => {
    const K = c.keys;
    let i = 0;
    while (i < K.length - 1 && K[i + 1].t <= t + 1e-9) i++;
    const A = K[i], B = K[Math.min(K.length - 1, i + 1)];
    const f = B.t > A.t ? Math.max(0, Math.min(1, (t - A.t) / (B.t - A.t))) : 0;
    const nodes = new Set([...Object.keys(A.parts || {}), ...Object.keys(B.parts || {})]);
    const out = {};
    for (const n of nodes) {
      const a = A.parts?.[n] || {}, b = B.parts?.[n] || {};
      const lerp = (x, y) => (x || y ? v3(x).map((v, k) => r4(v + (v3(y)[k] - v) * f)) : undefined);
      const o = {};
      const at = lerp(a.at, b.at), rot = lerp(a.rot, b.rot);
      if (at && at.some((v) => v)) o.at = at;
      if (rot && rot.some((v) => v)) o.rot = rot;
      if (Object.keys(o).length) out[n] = o;
    }
    return out;
  };
  const keys = times.map((t) => {
    const parts = {};
    let ease;
    for (const c of list) { Object.assign(parts, sample(c, t)); const k = c.keys.find((x) => Math.abs(x.t - t) < 1e-6); if (k && k.ease && !ease) ease = k.ease; }
    return { t, parts, ...(ease ? { ease } : {}) };
  });
  const out = { keys };
  const dur = Math.max(...list.map((c) => c.duration ?? c.keys[c.keys.length - 1].t));
  if (dur > times[times.length - 1] + 1e-9) out.duration = dur;
  if (list.some((c) => c.loop)) out.loop = true;
  const ev = list.flatMap((c) => c.events || []);
  if (ev.length) out.events = ev;
  return out;
}

// ---------- shared piece helpers ----------
const tex = (p, k, d) => (p.textures && p.textures[k] !== undefined ? p.textures[k] : p[k] !== undefined ? p[k] : d);
const n = (v, d) => { const x = Number(v ?? d); if (!Number.isFinite(x)) throw new Error(`expected a number, got ${JSON.stringify(v)}`); return x; };
const glow = (c) => ({ color: c, material: { preset: 'emissive_panel' }, emissive_part: true });
const markerPart = (kind, at, data, dir) => ({ type: 'marker', kind, at, data, ...(dir ? { dir } : {}) });
/** Points around a circle in the xy plane at z (tube rings). */
const ringPath = (r, z, segs = 12, y0 = 0) => [...Array(segs + 1).keys()].map((k) => { const a = (2 * Math.PI * k) / segs; return [r4(Math.sin(a) * r), r4(y0 + Math.cos(a) * r), z]; });

// ---------- ship components ----------
registerAssembly('canopy', (p, k) => {
  const L = n(p.len ?? p.length, 48), W = n(p.w, 22), H = n(p.h, 12), sill = n(p.sill, 2), ribs = Math.max(0, Math.round(n(p.ribs, 3)));
  const frameT = tex(p, 'frame', '#2a2d33'), glassT = tex(p, 'glass', '#7fc8e8');
  const ang = n(p.open_angle, 65), front = p.hinge === 'front';
  const hingeZ = front ? L / 2 : -L / 2, sgn = front ? 1 : -1;
  const open = k.rig ? 0 : Math.max(0, Math.min(1, n(p.open, 0)));
  const bubble = { type: 'hull', length: L, plan: [[0, W * 0.4], [0.3, W / 2], [0.72, W * 0.44], [1, W * 0.06]], profile: [[0, H * 0.55, 0], [0.38, H, 0], [0.78, H * 0.78, 0], [1, H * 0.12, 0]], section: { n: 2.4, n_bottom: 12 }, rings: n(p.rings, 8), segments: n(p.segments, 12), texture: glassT, glass: p.opacity === undefined ? true : { opacity: p.opacity } };
  const S = hullSurface(bubble);
  const rot = open ? [sgn * ang * open, 0, 0] : undefined;
  const hp = [0, 0, hingeZ];
  const parts = [{ type: 'box', w: W + 3, h: sill, d: L + 3, bevel: 0.8, texture: frameT }];
  if (p.cockpit !== false) {
    // a seat + instrument console under the glass (scaled to the canopy height)
    const ks = Math.max(0.2, (H - 1) / 46);
    parts.push({ type: 'seat', at: [0, sill, r4(-L * 0.08)], scale: r4(ks), textures: { texture: frameT, pad: tex(p, 'seat', '#4a3a30') } });
    parts.push({ type: 'console', id: `${k.id}_dash`, turn: 2, at: [0, sill, r4(L * 0.24)], scale: r4(ks * 0.75), w: r4((W * 0.75) / (ks * 0.75)), screens: 2, textures: { texture: frameT, ...(p.textures?.screen ? { screen: p.textures.screen } : {}) } });
  }
  parts.push({ ...bubble, name: k.node(), at: [0, sill, 0], pivot: hp, ...(rot ? { rotate: rot } : {}) });
  const lift = 0.35;
  const ribPath = (t) => { const out = []; for (let j = 0; j <= 12; j++) { const u = 0.75 + (0.5 * j) / 12; const pt = S.point(t, u), nn = S.normal(t, u); out.push([r4(pt[0] + nn[0] * lift), r4(pt[1] + nn[1] * lift + sill), r4(pt[2] + nn[2] * lift)]); } return out; };
  const frameAttach = k.rig ? { parent: k.node(), pivot: [0, sill, hingeZ] } : { pivot: [0, sill, hingeZ], ...(rot ? { rotate: rot } : {}) };
  for (let r = 0; r < ribs; r++) parts.push({ type: 'tube', path: ribPath((r + 1) / (ribs + 1)), r: 0.7, sides: 4, caps: false, texture: frameT, ...frameAttach });
  const spine = []; for (let j = 0; j <= 10; j++) { const t = 0.04 + (0.92 * j) / 10, pt = S.point(t, 0); spine.push([0, r4(pt[1] + lift + sill), r4(pt[2])]); }
  parts.push({ type: 'tube', path: spine, r: 0.7, sides: 4, caps: false, texture: frameT, ...frameAttach });
  const clips = k.rig ? { [p.clip ?? 'canopy_open']: { keys: [{ t: 0, parts: {} }, { t: n(p.duration, 1.4), parts: { [k.node()]: { rot: [sgn * ang, 0, 0] } }, ease: 'smooth' }] } } : {};
  return { parts, clips, sockets: k.rig ? { [`${k.id}_seat`]: { part: undefined, at: [0, sill, 0], look: [0, 0, 1] } } : {} };
}, 'len?:48,w?:22,h?:12,ribs?:3,hinge?:rear|front,open_angle?:65,open?:0..1 (static),frame|glass textures,opacity? -> clip canopy_open (named)');

const engineParts = (p, k, small = false) => {
  const r = n(p.r, small ? 3 : 10), L = n(p.len ?? p.length, small ? r * 2.5 : r * 4);
  const housing = tex(p, 'housing', tex(p, 'texture', '#5d636d')), dark = tex(p, 'dark', '#202328'), glowC = p.glow ?? '#7fd8ff';
  const nz = n(p.nozzle_len, L * 0.28), nozzle = tex(p, 'nozzle', '#3a3e45');
  const parts = [];
  if (!small) {
    parts.push({ type: 'hull', length: L, plan: [[0, r * 0.86], [0.18, r], [0.82, r], [1, r * 0.72]], profile: [[0, r * 0.86, -r * 0.86], [0.18, r, -r], [0.82, r, -r], [1, r * 0.72, -r * 0.72]], section: 2, rings: 6, segments: n(p.segments, 12), texture: housing, panel_lines: { rings: [0.35, 0.62], width: 1, depth: 0.6 }, groove: dark });
    parts.push({ type: 'tube', path: ringPath(r * 0.6, L / 2 + 0.2, 12), r: Math.max(0.6, r * 0.12), sides: 4, caps: false, texture: dark });
    parts.push({ type: 'cylinder', r: r * 0.62, h: 0.6, segments: 12, rotate: [90, 0, 0], at: [0, 0, L / 2], color: dark });
  } else {
    parts.push({ type: 'box', w: r * 2, h: r * 2, d: L * 0.6, bevel: Math.min(1, r * 0.2), texture: housing, at: [0, -r, 0] });
  }
  const z0 = small ? -L * 0.3 : -L / 2;
  parts.push({ type: 'cylinder', r_bottom: r * 0.82, r_top: r * 0.96, h: nz, segments: n(p.segments, 12), rotate: [-90, 0, 0], at: [0, 0, z0], texture: nozzle, material: 'bare_metal' });
  parts.push({ type: 'cylinder', r: r * 0.7, h: 0.8, segments: n(p.segments, 12), rotate: [-90, 0, 0], at: [0, 0, z0 - nz * 0.45], ...glow(glowC) });
  parts.push({ type: 'tube', path: ringPath(r * 0.9, z0 - nz + 0.3, 12), r: Math.max(0.45, r * 0.07), sides: 4, caps: false, closed: false, ...glow(glowC) });
  const exit = [0, 0, z0 - nz];
  parts.push({ type: 'light', at: [0, 0, z0 - nz - r], color: glowC, intensity: small ? 0.4 : 1.2, range: r * (small ? 6 : 10), bulb: false });
  const sockets = {};
  if (k.rig) sockets[`${k.id}_plume`] = { at: exit, look: [0, 0, -1] };
  else parts.push(markerPart('plume', exit, { socket: `${k.id}_plume`, r: r * 0.9 }, [0, 0, -1]));
  return { parts, sockets };
};
registerAssembly('engine', (p, k) => engineParts(p, k, false), 'r?:10,len?:40 (axis z, nozzle toward -z),nozzle_len?,glow?:"#7fd8ff",textures:{housing,nozzle,dark},segments?:12 -> plume socket / marker <id>_plume, glow light');
registerAssembly('thruster', (p, k) => engineParts(p, k, true), 'r?:3,len? (small nozzle block, nozzle toward -z),glow? -> plume marker');

registerAssembly('wing', (p, k) => {
  const side = p.side ?? 'both';
  const base = { type: 'wing_panel', span: n(p.span, 64), root: n(p.root ?? p.chord, 48), tip: n(p.tip, (p.root ?? 48) * 0.4), sweep: n(p.sweep, (p.root ?? 48) * 0.45), thick: n(p.thick, 4), tip_thick: p.tip_thick, dihedral: n(p.dihedral, side === 'center' ? 90 : 0), section: p.section, texture: tex(p, 'texture', '#6b717b'), faces: p.faces };
  const rootX = n(p.root_x, 0), fold = n(p.fold_angle, 90), parts = [], clips = {};
  const sides = side === 'both' ? [1, -1] : side === 'left' ? [1] : side === 'right' ? [-1] : [0];
  const foldKeys = {};
  for (const s of sides) {
    const nm = sides.length > 1 ? k.node(s > 0 ? 'l' : 'r') : k.node();
    const staticFold = !k.rig && p.fold ? n(p.fold, 0) : 0;
    const panel = { ...base, name: nm, at: [s * rootX, 0, 0], ...(s < 0 ? { scale: [-1, 1, 1] } : {}), ...(staticFold ? { rotate: [0, 0, s * fold * staticFold] } : {}) };
    parts.push(panel);
    if (nm) foldKeys[nm] = { rot: [0, 0, s * fold] };
    // nav light at the tip (glTF: +x = left = red)
    if (s !== 0 && p.nav_lights !== false && !staticFold) {
      const dih = (base.dihedral * Math.PI) / 180, tipP = [s * (rootX + base.span * Math.cos(dih)), base.span * Math.sin(dih), base.root / 2 - base.sweep - base.tip / 2];
      const c = s > 0 ? '#ff3030' : '#30ff60';
      parts.push({ type: 'light', at: tipP.map(r4), color: c, intensity: 0.5, range: 48, bulb: 1.5, ...(nm ? { parent: nm } : {}) });
    }
    if (p.vtol && s !== 0) {
      const dih = (base.dihedral * Math.PI) / 180, tipP = [s * (rootX + base.span * Math.cos(dih)), base.span * Math.sin(dih), 0];
      const pod = k.node(s > 0 ? 'pod_l' : 'pod_r');
      const r = n(p.pod_r, 6);
      parts.push({ type: 'hull', name: pod, ...(nm ? { parent: nm } : {}), length: r * 4, width: r * 2, height: r * 2, plan: [[0, r * 0.7], [0.3, r], [0.8, r], [1, r * 0.4]], profile: [[0, r * 0.7, -r * 0.7], [0.3, r, -r], [0.8, r, -r], [1, r * 0.4, -r * 0.4]], section: 2, rings: 5, segments: 10, texture: base.texture, at: tipP.map(r4), pivot: [0, 0, 0] });
      parts.push({ type: 'cylinder', r: r * 0.6, h: 0.8, segments: 10, rotate: [-90, 0, 0], at: [tipP[0], tipP[1], -r * 2 - 0.2].map(r4), ...glow(p.glow ?? '#7fd8ff'), ...(pod ? { parent: pod } : {}) });
      if (pod) foldKeys[pod] = foldKeys[pod] || {};
    }
  }
  if (k.rig) {
    clips[p.clip ?? 'wings_fold'] = { keys: [{ t: 0, parts: {} }, { t: n(p.duration, 2), parts: Object.fromEntries(Object.entries(foldKeys).filter(([, v]) => v.rot)), ease: 'smooth' }] };
    if (p.vtol) clips.vtol_down = { keys: [{ t: 0, parts: {} }, { t: 1.2, parts: Object.fromEntries(sides.filter((s) => s).map((s) => [k.node(s > 0 ? 'pod_l' : 'pod_r'), { rot: [90, 0, 0] }])), ease: 'smooth' }] };
  }
  return { parts, clips };
}, 'span?:64,root?:48,tip?,sweep?,thick?:4,dihedral?,side?:both|left|right|center,root_x?:0,section?:hex|diamond|flat,fold_angle?:90 (named: clip wings_fold; static fold:0..1),vtol?:true (+ pods, clip vtol_down),nav_lights?:true');
registerAssembly('fin', (p, k) => ASSEMBLIES.wing({ side: 'center', dihedral: 90, span: 28, root: 36, tip: 14, sweep: 18, thick: 3, ...p }, k), 'wing with side:"center", dihedral:90 (vertical stabiliser)');

registerAssembly('landing_gear', (p, k) => {
  const h = n(p.h, 24), r = n(p.r, 1.6), foot = p.foot ?? 'pad', dir = p.retract === 'forward' ? -1 : 1;
  const metal = tex(p, 'texture', '#4b5059'), piston = tex(p, 'piston', '#9aa0a8'), doorT = tex(p, 'door', tex(p, 'hull', '#6b717b')), dark = tex(p, 'dark', '#202328');
  const dw = n(p.door_w, Math.max(8, r * 6)), dd = n(p.door_d, h * 0.75), bay = p.bay !== false;
  const deployed = k.rig ? true : p.deployed !== false;
  const parts = [];
  const strutL = h * 0.55;
  if (bay) parts.push({ type: 'box', w: dw, h: 0.6, d: dd, at: [0, 0.4, 0], color: dark });
  if (deployed) {
    parts.push({ type: 'cylinder', name: k.node(), r, h: strutL, segments: 8, at: [0, -strutL, 0], pivot: [0, strutL, 0], texture: metal, material: 'painted_metal' });
    parts.push({ type: 'cylinder', name: k.node('piston'), parent: k.node() ?? undefined, r: r * 0.68, h: h * 0.5, segments: 8, at: [0, -h * 0.98, 0], texture: piston, material: 'bare_metal' });
    parts.push({ type: 'box', parent: k.node() ?? undefined, w: r * 0.8, h: h * 0.3, d: r * 0.8, at: [0, -h * 0.55, r * 1.3], texture: metal });
    const footN = k.node('foot'), fp = footN ? { name: footN, parent: k.node('piston') } : {};
    if (foot === 'wheel') {
      parts.push({ type: 'cylinder', ...fp, r: r * 3, h: r * 2.2, segments: 10, rotate: [0, 0, 90], at: [r * 1.1, -h + r * 3, 0], color: '#1e1f22', material: 'rubber' });
    } else if (foot === 'skid') {
      parts.push({ type: 'box', ...fp, w: r * 2.6, h: r * 1.4, d: h * 1.4, bevel: r * 0.5, at: [0, -h - r * 1.4, 0], texture: metal });
    } else {
      parts.push({ type: 'cylinder', ...fp, r: r * 3.4, h: r * 1.1, segments: 10, at: [0, -h - r * 1.1, 0], texture: metal, material: 'painted_metal' });
    }
    if (bay) for (const s of [1, -1]) parts.push({ type: 'box', name: k.node(s > 0 ? 'door_l' : 'door_r'), w: 0.8, h: dw / 2, d: dd, at: [s * dw / 2, -dw / 2, 0], pivot: [0, dw / 2, 0], texture: doorT });
  } else if (bay) for (const s of [1, -1]) parts.push({ type: 'box', w: dw / 2, h: 0.8, d: dd, at: [s * dw / 4, -0.8, 0], texture: doorT });
  const sockets = {}, clips = {};
  if (k.rig) {
    sockets[`${k.id}_contact`] = { part: k.node('foot'), at: [0, -h - (foot === 'wheel' ? 0 : r * 1.1), 0], look: [0, -1, 0] };
    const N = k.node(), P = k.node('piston');
    const doors = (closed) => (bay ? { [k.node('door_l')]: { rot: [0, 0, closed ? -90 : 0] }, [k.node('door_r')]: { rot: [0, 0, closed ? 90 : 0] } } : {});
    const up = { [N]: { rot: [dir * 90, 0, 0] }, [P]: { at: [0, h * 0.32, 0] } };
    const comp = { [P]: { at: [0, h * 0.32, 0] } };
    clips[p.clip ?? 'gear_retract'] = { keys: [{ t: 0, parts: {} }, { t: 0.4, parts: comp, ease: 'smooth' }, { t: 1.2, parts: { ...up }, ease: 'smooth' }, { t: 1.6, parts: { ...up, ...doors(true) }, ease: 'smooth' }] };
    clips[p.deploy_clip ?? 'gear_deploy'] = { keys: [{ t: 0, parts: { ...up, ...doors(true) } }, { t: 0.4, parts: { ...up }, ease: 'smooth' }, { t: 1.2, parts: comp, ease: 'smooth' }, { t: 1.6, parts: {}, ease: 'smooth' }] };
    for (const c of Object.values(clips)) for (const key of c.keys) key.parts = Object.fromEntries(Object.entries(key.parts).filter(([nm]) => nm));
  }
  return { parts, sockets, clips };
}, 'h?:24 (strut length down from the mount),r?:1.6,foot?:pad|wheel|skid,retract?:back|forward,bay?:true,door_w?,door_d?,textures:{texture,piston,door,dark} -> named: clips gear_retract + gear_deploy (merged over every leg), socket <name>_contact; static deployed?:true|false (false = closed bay doors)');

registerAssembly('ramp', (p, k) => {
  const w = n(p.w, 48), L = n(p.len ?? p.length, 56), th = n(p.thick, 3);
  const ang = n(p.open_angle, 112), open = k.rig ? 0 : Math.max(0, Math.min(1, n(p.open, 0)));
  const T = tex(p, 'texture', '#5d636d'), tread = tex(p, 'tread', '#2c3036'), haz = tex(p, 'hazard', '#d09a28');
  const N = k.node(), rot = open ? [-ang * open, 0, 0] : undefined;
  const pv = [0, 0, th / 2];
  const attach = (at) => (N ? { parent: N, at } : { at, pivot: at.map((v) => -v), ...(rot ? { rotate: rot } : {}) });
  const parts = [{ type: 'box', name: N, w, h: L, d: th, at: [0, 0, -th / 2], pivot: pv, texture: T, ...(rot ? { rotate: rot } : {}) }];
  const strips = Math.max(2, Math.round(L / 8));
  for (let i = 0; i < strips; i++) parts.push({ type: 'box', w: w * 0.8, h: 1.2, d: 0.8, color: tread, ...attach([0, ((i + 0.5) * L) / strips, 0.4]) });
  for (const s of [1, -1]) parts.push({ type: 'box', w: 2, h: L, d: 1, color: haz, ...attach([s * (w / 2 - 1), 0, 0.5]) });
  const clips = N ? { [p.clip ?? 'ramp_open']: { keys: [{ t: 0, parts: {} }, { t: 0.25, parts: { [N]: { rot: [-4, 0, 0] } }, ease: 'step' }, { t: n(p.duration, 2.2), parts: { [N]: { rot: [-ang, 0, 0] } }, ease: 'smooth' }] } } : {};
  parts.push(markerPart('door', [0, 0, 0], { door: k.id, kind: 'ramp', w, h: L }, [0, 0, -1]));
  return { parts, clips };
}, 'w?:48,len?:56 (panel height when closed, hinge at its bottom edge, outer face -z),thick?:3,open_angle?:112,open?:0..1 (static),textures:{texture,tread,hazard} -> named: clip ramp_open; door marker for interiors');

registerAssembly('cargo_door', (p, k) => {
  // in the hull-surface convention: panel in the local xz plane facing +y (on_hull: +y = normal), length along z
  const w = n(p.w, 40), d = n(p.d ?? p.len, 48), th = n(p.thick, 2), style = p.style ?? 'slide';
  if (!['slide', 'gullwing', 'split'].includes(style)) throw new Error('cargo_door style must be slide|gullwing|split');
  const T = tex(p, 'texture', '#6b717b'), frame = tex(p, 'frame', '#2c3036');
  const open = k.rig ? 0 : Math.max(0, Math.min(1, n(p.open, 0)));
  const parts = [{ type: 'box', w: w + 4, h: 0.6, d: d + 4, at: [0, -0.4, 0], color: frame }];
  const clips = {};
  if (style === 'split') {
    const keys = {};
    for (const s of [1, -1]) {
      const nm = k.node(s > 0 ? 'a' : 'b');
      parts.push({ type: 'box', name: nm, w: w / 2, h: th, d, at: [s * w / 4 + (open ? s * (w / 2) * open : 0), 0, 0], texture: T, bevel: 0.5 });
      if (nm) keys[nm] = { at: [s * w / 2, 0, 0] };
    }
    if (k.rig) clips[p.clip ?? `${k.id}_open`] = { keys: [{ t: 0, parts: {} }, { t: n(p.duration, 1.2), parts: keys, ease: 'smooth' }] };
  } else if (style === 'slide') {
    const nm = k.node();
    parts.push({ type: 'box', name: nm, w, h: th, d, at: [0, open ? th : 0, open ? -d * open : 0], texture: T, bevel: 0.5 });
    if (k.rig) clips[p.clip ?? `${k.id}_open`] = { keys: [{ t: 0, parts: {} }, { t: 0.3, parts: { [nm]: { at: [0, th, 0] } }, ease: 'smooth' }, { t: n(p.duration, 1.4), parts: { [nm]: { at: [0, th, -d] } }, ease: 'smooth' }] };
  } else {
    const nm = k.node(), ang = n(p.open_angle, 100);
    parts.push({ type: 'box', name: nm, w, h: th, d, at: [0, 0, 0], pivot: [-w / 2, 0, 0], texture: T, bevel: 0.5, ...(open ? { rotate: [0, 0, ang * open] } : {}) });
    if (k.rig) clips[p.clip ?? `${k.id}_open`] = { keys: [{ t: 0, parts: {} }, { t: n(p.duration, 1.4), parts: { [nm]: { rot: [0, 0, ang] } }, ease: 'smooth' }] };
  }
  parts.push(markerPart('door', [0, 0, 0], { door: k.id, kind: `cargo_${style}`, w, d }, [0, 1, 0]));
  return { parts, clips };
}, 'w?:40,d?:48 (panel in the local xz plane facing +y: put it on_hull),thick?:2,style?:slide|gullwing|split,open?:0..1 (static),open_angle? -> named: clip <name>_open; door marker');

registerAssembly('turret', (p, k) => {
  const r = n(p.r, 8), h = n(p.h, 5), style = p.style ?? 'cannon', nb = Math.max(1, Math.round(n(p.barrels, style === 'rotary' ? 6 : 2)));
  const bl = n(p.barrel_len, r * 3), br = n(p.barrel_r, r * 0.13);
  const T = tex(p, 'texture', '#5d636d'), dark = tex(p, 'dark', '#25282d'), barrelT = tex(p, 'barrel', '#33363c');
  const Y = k.node(), P = k.node('pitch'), B = k.node('barrel');
  const parts = [
    { type: 'cylinder', r: r * 1.12, h: 1.6, segments: 12, texture: dark },
    { type: 'cylinder', name: Y, r, h, segments: 12, at: [0, 1.6, 0], texture: T, material: 'painted_metal' },
    { type: 'box', parent: Y ?? undefined, w: r * 1.5, h: h * 0.8, d: r * 1.3, bevel: 0.8, at: [0, 1.6 + h, -r * 0.2], texture: T },
  ];
  const py = 1.6 + h + h * 0.4;
  parts.push({ type: 'box', name: P, parent: Y ?? undefined, w: r * 1.1, h: r * 0.75, d: r * 0.9, bevel: 0.6, at: [0, py - r * 0.375, r * 0.3], pivot: [0, r * 0.375, -r * 0.3], texture: T });
  const tipZ = r * 0.75 + bl;
  if (style === 'rotary') {
    parts.push({ type: 'cylinder', name: B, parent: P ?? undefined, r: br * 3.2, h: bl * 0.15, segments: 10, rotate: [90, 0, 0], at: [0, py, r * 0.75], texture: dark });
    parts.push({ type: 'cylinder', parent: B ?? P ?? undefined, r: br, h: bl, segments: 6, rotate: [90, 0, 0], at: [br * 2.2, py, r * 0.75], texture: barrelT, material: 'bare_metal', array: { count: nb, rotate: [0, 0, 360 / nb], about: [0, py, 0] } });
  } else {
    for (let b = 0; b < nb; b++) {
      const x = nb === 1 ? 0 : -r * 0.3 + (r * 0.6 * b) / (nb - 1);
      parts.push({ type: 'cylinder', parent: P ?? undefined, r: br, h: bl, segments: 8, rotate: [90, 0, 0], at: [x, py, r * 0.75], texture: barrelT, material: 'bare_metal' });
      parts.push({ type: 'cylinder', parent: P ?? undefined, r: br * 1.5, h: bl * 0.12, segments: 8, rotate: [90, 0, 0], at: [x, py, tipZ - bl * 0.12], color: dark });
    }
  }
  const sockets = {}, clips = {};
  if (k.rig) {
    sockets[`${k.id}_muzzle`] = { part: P, at: [0, py, tipZ], look: [0, 0, 1] };
    const sc = n(p.scan, 60);
    clips[p.clip ?? `${k.id}_scan`] = { loop: true, duration: n(p.duration, 6), keys: [{ t: 0, parts: { [Y]: { rot: [0, -sc, 0] }, [P]: { rot: [-8, 0, 0] } } }, { t: 3, parts: { [Y]: { rot: [0, sc, 0] }, [P]: { rot: [-14, 0, 0] } }, ease: 'smooth' }] };
    if (style === 'rotary') clips[`${k.id}_spin`] = { loop: true, duration: 0.3, keys: [{ t: 0, parts: {} }, { t: 0.1, parts: { [B]: { rot: [0, 120, 0] } } }, { t: 0.2, parts: { [B]: { rot: [0, 240, 0] } } }] };
  } else parts.push(markerPart('muzzle', [0, py, tipZ], { socket: `${k.id}_muzzle` }, [0, 0, 1]));
  return { parts, sockets, clips };
}, 'r?:8,h?:5,style?:cannon|rotary,barrels?:2 (rotary 6),barrel_len?,barrel_r?,scan?:60,textures:{texture,dark,barrel} -> named: yaw node <name>, pitch <name>.pitch, clips <name>_scan (+ <name>_spin), socket <name>_muzzle');
registerAssembly('rotary_cannon', (p, k) => ASSEMBLIES.turret({ style: 'rotary', r: 5, h: 3, ...p }, k), 'turret with style:"rotary" (6 barrels, spin clip)');
registerAssembly('hardpoint', (p, k) => {
  const L = n(p.len, 24), T = tex(p, 'texture', '#4b5059');
  const parts = [{ type: 'box', w: 3, h: 4, d: L * 0.6, bevel: 0.5, at: [0, -4, 0], texture: T }, { type: 'box', w: 4, h: 1.2, d: L, at: [0, -5.2, 0], color: tex(p, 'dark', '#25282d') }];
  if (p.payload !== false) {
    const mr = n(p.missile_r, 2);
    parts.push({ type: 'cylinder', r: mr, h: L * 0.8, segments: 8, rotate: [90, 0, 0], at: [0, -5.2 - mr, -L * 0.4], color: tex(p, 'missile', '#c8c8c0') });
    parts.push({ type: 'cone', r: mr, h: mr * 3, segments: 8, rotate: [90, 0, 0], at: [0, -5.2 - mr, L * 0.4], color: tex(p, 'missile', '#c8c8c0') });
    parts.push({ type: 'box', w: mr * 4, h: 0.5, d: mr * 2, at: [0, -5.2 - mr, -L * 0.35], color: '#a03028' });
  }
  const sockets = {};
  if (k.rig) sockets[`hardpoint_${k.id}`] = { at: [0, -5.2, 0], look: [0, 0, 1] };
  else parts.push(markerPart('hardpoint', [0, -5.2, 0], { socket: `hardpoint_${k.id}` }, [0, 0, 1]));
  return { parts, sockets };
}, 'len?:24 (pylon under the mount, -y),payload?:true (missile),missile_r?:2 -> hardpoint_<id> socket / marker');
registerAssembly('antenna', (p) => {
  const h = n(p.h, 24), style = p.style ?? 'whip', T = tex(p, 'texture', '#3a3e45');
  const parts = [{ type: 'cylinder', r: 1.6, h: 1.2, segments: 8, texture: T }];
  if (style === 'whip') { parts.push({ type: 'cylinder', r: 0.35, h, segments: 4, at: [0, 1.2, 0], texture: T }); parts.push({ type: 'light', at: [0, h + 1.6, 0], color: '#ff3030', intensity: 0.4, range: 40, bulb: 1.2 }); }
  else if (style === 'mast') { parts.push({ type: 'truss', from: [0, 1.2, 0], to: [0, h, 0], w: 3, h: 3, section: 'tri', bay: 4, chord: 0.6, texture: T }); for (const y of [h * 0.6, h * 0.9]) parts.push({ type: 'box', w: h * 0.4, h: 0.6, d: 0.6, at: [0, y, 0], texture: T }); parts.push({ type: 'light', at: [0, h + 1, 0], color: '#ff3030', intensity: 0.4, range: 40, bulb: 1.2 }); }
  else if (style === 'array') { parts.push({ type: 'cylinder', r: 0.6, h: h * 0.4, segments: 4, at: [0, 1.2, 0], texture: T }); parts.push({ type: 'box', w: h * 0.6, h: h * 0.45, d: 0.8, at: [0, h * 0.4 + 1.2, 0], rotate: [-15, 0, 0], insets: [{ face: 'front', rect: [1, 1, h * 0.6 - 2, h * 0.45 - 2], depth: 0.4 }], texture: T }); }
  else parts.push({ type: 'wing_panel', span: h, root: h * 0.5, tip: h * 0.15, sweep: h * 0.35, thick: 1, dihedral: 90, at: [0, 1.2, 0], texture: T });
  return { parts };
}, 'h?:24,style?:whip|mast|array|blade (red beacon light on whip / mast)');
registerAssembly('sensor_dome', (p) => {
  const r = n(p.r, 6);
  return { parts: [{ type: 'cylinder', r: r * 1.1, h: 1.2, segments: 12, texture: tex(p, 'texture', '#3a3e45') }, { type: 'dome', r, h: r * 0.9, segments: 12, rings: 4, at: [0, 1.2, 0], color: tex(p, 'dome', '#20262e'), material: { metal: 0.1, rough: 0.2 } }, { type: 'light', at: [0, r + 2, 0], color: p.glow ?? '#40ffa0', intensity: 0.3, range: 24, bulb: 1 }] };
}, 'r?:6 (sensor dome on a base ring, small status light)');
registerAssembly('rcs_quad', (p, k) => {
  const s = n(p.s ?? p.size, 4), T = tex(p, 'texture', '#4b5059'), parts = [{ type: 'box', w: s * 1.6, h: s, d: s * 1.6, bevel: s * 0.15, texture: T }];
  for (const [dx, dz, ry2] of [[1, 0, 90], [-1, 0, -90], [0, 1, 0], [0, -1, 180]]) {
    parts.push({ type: 'cone', r: s * 0.32, h: s * 0.7, segments: 6, rotate: [-90, ry2 + 180, 0], at: [dx * s * 0.8, s * 0.5, dz * s * 0.8], color: '#2a2c30' });
    if (!k.rig) parts.push(markerPart('rcs', [dx * s * 1.5, s * 0.5, dz * s * 1.5], { socket: `${k.id}_rcs` }, [dx, 0, dz]));
  }
  return { parts };
}, 's?:4 (RCS block with 4 nozzles in the tangent plane; rcs markers for puff sprites)');
registerAssembly('intake', (p) => {
  const w = n(p.w, 16), h = n(p.h, 8), d = n(p.d, 20), T = tex(p, 'texture', '#5d636d'), dark = tex(p, 'dark', '#15171a');
  const parts = [{ type: 'box', w, h, d, at: [0, 0, 0], insets: [{ face: 'front', rect: [1.2, 1.2, w - 2.4, h - 2.4], depth: Math.min(d * 0.8, 8), texture: dark, side: dark }], texture: T }];
  const slats = Math.max(1, Math.round(w / 4));
  for (let i = 1; i < slats; i++) parts.push({ type: 'box', w: 0.5, h: h - 2.4, d: 1, at: [-w / 2 + (w * i) / slats, 1.2, d / 2 - 1.5], color: dark });
  return { parts };
}, 'w?:16,h?:8,d?:20 (air scoop: recessed dark mouth facing +z, grille slats)');
registerAssembly('vent', (p) => {
  const w = n(p.w, 12), d = n(p.d, 16), sl = Math.max(2, Math.round(n(p.slats, 5))), T = tex(p, 'texture', '#3a3e45'), dark = tex(p, 'dark', '#121417');
  const parts = [{ type: 'box', w: w + 2, h: 0.8, d: d + 2, texture: T }, { type: 'box', w, h: 0.3, d, at: [0, 0.8, 0], color: dark }];
  for (let i = 0; i < sl; i++) parts.push({ type: 'box', w: w - 0.6, h: 0.4, d: d / sl * 0.7, at: [0, 1.1, -d / 2 + ((i + 0.5) * d) / sl], rotate: [25, 0, 0], texture: T });
  if (p.glow) parts.push({ type: 'box', w: w - 1, h: 0.2, d: d - 1, at: [0, 0.85, 0], ...glow(p.glow) });
  return { parts };
}, 'w?:12,d?:16,slats?:5,glow?:<colour> (heat glow under the slats)');
registerAssembly('armor_plate', (p) => {
  const w = n(p.w, 20), d = n(p.d, 28), h = n(p.h, 1.8), T = tex(p, 'texture', '#6b717b');
  const parts = [{ type: 'box', w, h, d, bevel: Math.min(0.8, h * 0.45), texture: T, material: p.material ?? 'painted_metal' }];
  if (p.bolts !== false) for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) parts.push({ type: 'box', w: 1, h: 0.6, d: 1, at: [sx * (w / 2 - 1.6), h, sz * (d / 2 - 1.6)], color: tex(p, 'bolt', '#9aa0a8') });
  return { parts };
}, 'w?:20,d?:28,h?:1.8,bolts?:true (bevelled armour plate in the local xz plane: put it on_hull)');
registerAssembly('container_rack', (p, k) => {
  const [cw, ch, cd] = v3(p.size, 0).every((v) => !v) ? [40, 40, 96] : v3(p.size);
  const cols = Math.max(1, Math.round(n(p.cols, 2))), rows = Math.max(1, Math.round(n(p.rows, 2))), layers = Math.max(1, Math.round(n(p.layers, 1)));
  const gap = n(p.gap, 3), fill = Math.max(0, Math.min(1, n(p.fill, 1)));
  const colors = p.colors ?? ['#8a3a2a', '#2f5a7a', '#a8862a', '#4a6a3a', '#7a7a80'];
  const W = cols * cw + (cols + 1) * gap, H = rows * ch + (rows + 1) * gap, D = layers * cd + (layers + 1) * gap;
  const parts = [], frameT = tex(p, 'frame', '#3a3e45');
  for (let l = 0; l < layers; l++) for (let c = 0; c < cols; c++) for (let r = 0; r < rows; r++) {
    if (k.rnd() > fill) continue;
    const col = colors[Math.floor(k.rnd() * colors.length)];
    parts.push({ type: 'container', w: cw, h: ch, d: cd, color: col, at: [-W / 2 + gap + c * (cw + gap) + cw / 2, gap + r * (ch + gap), -D / 2 + gap + l * (cd + gap) + cd / 2] });
  }
  if (p.frame !== false) {
    const fs = n(p.frame_size, 2.5);
    for (const x of [-W / 2, W / 2]) for (let l = 0; l <= layers; l++) { const z = -D / 2 + l * (cd + gap) + gap / 2; parts.push({ type: 'beam', from: [x, 0, z], to: [x, H, z], s: fs, texture: frameT }); }
    for (let r = 0; r <= rows; r++) for (const x of [-W / 2, W / 2]) { const y = r * (ch + gap) + gap / 2; parts.push({ type: 'beam', from: [x, y, -D / 2], to: [x, y, D / 2], s: fs, texture: frameT }); }
    for (let l = 0; l <= layers; l++) { const z = -D / 2 + l * (cd + gap) + gap / 2; parts.push({ type: 'beam', from: [-W / 2, H, z], to: [W / 2, H, z], s: fs, texture: frameT }); }
  }
  return { parts };
}, 'cols?:2,rows?:2,layers?:1 (along z),size?:[40,40,96] px per container,gap?:3,fill?:1 (seeded share present),colors?:[..],seed?,frame?:true (stacking frame of beams)');
