// Greebles: seeded scatter of small hard-surface kit details (panels, vents, pipes, conduit runs,
// antennas, rivets, hatches, heat sinks, nozzles, sensor domes, cable bundles, tanks, tech
// blocks) over a rectangular region, the Star Wars model-shop look. Pieces never overlap (1 px
// occupancy grid + gap), can snap to a panel grid, avoid a painted mask or rectangles, and are
// tagged so LOD export drops them at distance. User models can be pieces too.
//
// Region frame: local y = 0 plane facing +y, w (x) by d (z) px centred on the origin; the region's
// top-left (u = 0, v = 0) is the (-x, -z) corner, u along +x, v along +z. A box face uses the same
// frame as insets (top-left as seen from outside).
import { mulberry32 } from './util.js';
import { Mesh, BUILDERS, matMul, mT, mRY, mRZ, buildModel } from './model3d.js';
import { sweep } from './sweep.js';

const box = (a, ctx) => BUILDERS.box({ tile: true, ...a }, ctx);
const cyl = (a, ctx) => BUILDERS.cylinder(a, ctx);
const place = (m, x, y, z, M) => m.transform(M ? matMul(mT(x, y, z), M) : mT(x, y, z));

/** Built-in pieces: (o) -> Mesh on y = 0, footprint sx (x) by sz (z) centred, top at about h. */
const KINDS = {
  panel(o) { const { sx, sz, h, T, ctx } = o; return box({ w: sx, h: Math.max(0.5, Math.min(1.5, h * 0.35)), d: sz, texture: T.main }, ctx); },
  vent(o) {
    const { sx, sz, ctx, T } = o;
    if (sx < 4 || sz < 4) return KINDS.panel(o);
    const hh = 1.25, dep = 0.75, m = box({ w: sx, h: hh, d: sz, texture: T.main, insets: [{ face: 'top', rect: [1, 1, sx - 2, sz - 2], depth: dep, texture: T.dark, side: T.dark }] }, ctx);
    const n = Math.max(1, Math.floor((sz - 2) / 2));
    for (let k = 0; k < n; k++) m.add(place(box({ w: sx - 2, h: dep, d: 0.75, texture: T.main }, ctx), 0, hh - dep, -sz / 2 + 1 + ((k + 0.5) * (sz - 2)) / n));
    return m;
  },
  pipe(o) {
    const { sx, sz, h, ctx, T } = o;
    const r = Math.max(0.75, Math.min(sz / 2, h / 2, 2.5));
    const m = new Mesh();
    const runs = sz >= 4 * r + 1 ? 2 : 1;
    for (let k = 0; k < runs; k++) {
      const z = runs === 1 ? 0 : (k ? 1 : -1) * (r + 0.5);
      m.add(place(cyl({ r, h: sx, segments: 6, flat: true, texture: T.main, tile: false }, ctx), sx / 2, r, z, mRZ(90)));
    }
    for (const x of [-1, 1]) m.add(place(box({ w: 1.5, h: 2 * r + 0.5, d: runs === 1 ? 2 * r + 1 : sz, texture: T.dark }, ctx), x * Math.max(0, sx / 2 - 2), 0, 0));
    return m;
  },
  conduit(o) {
    const { sx, sz, ctx, T } = o;
    const c = Math.max(0.5, Math.min(1.5, sz / 4, sx / 4));
    const path = [[-sx / 2, c, -sz / 2 + c], [sx / 2 - c, c, -sz / 2 + c], [sx / 2 - c, c, sz / 2]];
    const m = sweep({ path, profile: [[-c, -c], [c, -c], [c, c], [-c, c]], texture: T.main, caps: true }, ctx);
    m.add(place(box({ w: 2 * c + 1, h: 2 * c + 0.5, d: 2 * c + 1, texture: T.dark }, ctx), sx / 2 - c, 0, -sz / 2 + c));
    return m;
  },
  antenna(o) {
    const { h, ctx, T } = o;
    const mh = Math.max(4, Math.min(16, h * 3));
    const m = box({ w: 2.5, h: 1, d: 2.5, texture: T.dark }, ctx);
    m.add(place(cyl({ r: 0.4, h: mh, segments: 4, flat: true, texture: T.accent, tile: false }, ctx), 0, 1, 0));
    m.add(place(box({ w: 1, h: 1, d: 1, texture: T.accent }, ctx), 0, 1 + mh, 0));
    m.add(place(box({ w: 3, h: 0.4, d: 0.4, texture: T.accent }, ctx), 0, 1 + mh * 0.7, 0));
    return m;
  },
  bolts(o) {
    const { sx, sz, ctx, T } = o;
    const m = new Mesh();
    const along = sx >= sz, n = Math.max(1, Math.min(8, Math.floor((along ? sx : sz) / 3)));
    for (let k = 0; k < n; k++) {
      const t = -((along ? sx : sz) / 2) + ((k + 0.5) * (along ? sx : sz)) / n;
      m.add(place(box({ w: 1, h: 0.5, d: 1, texture: T.accent }, ctx), along ? t : 0, 0, along ? 0 : t));
    }
    return m;
  },
  hatch(o) {
    const { sx, sz, ctx, T } = o;
    if (sx < 4 || sz < 4) return KINDS.panel(o);
    const m = box({ w: sx, h: 0.75, d: sz, texture: T.main, insets: [{ face: 'top', rect: [1, 1, sx - 2, sz - 2], depth: -0.5, texture: T.main, side: T.dark }] }, ctx);
    m.add(place(box({ w: Math.min(3, sx - 2), h: 0.5, d: 0.6, texture: T.accent }, ctx), 0, 1.25, sz / 2 - 2));
    m.add(place(cyl({ r: 0.5, h: Math.max(1, sx - 4), segments: 4, flat: true, texture: T.dark, tile: false }, ctx), (sx - 4) / 2, 0.75, -sz / 2 + 0.5, mRZ(90)));
    return m;
  },
  heatsink(o) {
    const { sx, sz, h, ctx, T } = o;
    const m = box({ w: sx, h: 0.75, d: sz, texture: T.dark }, ctx);
    const n = Math.max(2, Math.floor(sx / 2));
    const fh = Math.max(1, Math.min(4, h));
    for (let k = 0; k < n; k++) m.add(place(box({ w: 0.75, h: fh, d: Math.max(1, sz - 1), texture: T.main }, ctx), -sx / 2 + ((k + 0.5) * sx) / n, 0.75, 0));
    return m;
  },
  nozzle(o) {
    const { sx, sz, h, ctx, T } = o;
    const R = Math.max(1, Math.min(sx, sz) / 2);
    const nh = Math.max(1, Math.min(h, R * 1.5));
    const m = box({ w: 2 * R, h: 0.75, d: 2 * R, texture: T.dark }, ctx);
    m.add(place(cyl({ r_bottom: R * 0.95, r_top: R * 0.7, h: nh, segments: 8, texture: T.main, tile: false }, ctx), 0, 0.75, 0));
    m.add(place(cyl({ r: R * 0.5, h: 0.25, segments: 8, texture: T.dark, tile: false }, ctx), 0, 0.75 + nh, 0));
    return m;
  },
  dome(o) {
    const { sx, sz, ctx, T } = o;
    const R = Math.max(1, (Math.min(sx, sz) / 2) * 0.9);
    const m = cyl({ r: R, h: 0.75, segments: 8, texture: T.dark, tile: false }, ctx);
    let y = 0.75;
    for (const [r0, r1, hh] of [[R * 0.95, R * 0.85, R * 0.35], [R * 0.85, R * 0.55, R * 0.35], [R * 0.55, 0, R * 0.3]]) {
      m.add(place(cyl({ r_bottom: r0, r_top: r1, h: hh, segments: 8, texture: T.accent, tile: false }, ctx), 0, y, 0));
      y += hh;
    }
    return m;
  },
  cables(o) {
    const { sx, sz, h, ctx, T } = o;
    if (sx < 6) return KINDS.bolts(o);
    const ah = Math.max(1.5, Math.min(4, h));
    const m = new Mesh();
    for (const x of [-1, 1]) m.add(place(box({ w: 1.5, h: ah, d: sz, texture: T.dark }, ctx), x * (sx / 2 - 0.75), 0, 0));
    const n = Math.max(1, Math.min(3, Math.floor(sz / 1.5)));
    for (let k = 0; k < n; k++) {
      const z = -sz / 2 + ((k + 0.5) * sz) / n, y = ah - 0.6;
      m.add(sweep({ from: [-sx / 2 + 1.5, y, z], to: [sx / 2 - 1.5, y, z], sag: Math.min(y - 0.6, sx * 0.12 + k * 0.3), segments: 6, r: 0.45, sides: 4, flat: true, texture: T.accent, caps: false }, ctx));
    }
    return m;
  },
  tank(o) {
    const { sx, sz, h, ctx, T } = o;
    const r = Math.max(1, Math.min(sz / 2, h));
    const m = place(cyl({ r, h: Math.max(2, sx - 1), segments: 8, texture: T.main, tile: false }, ctx), (sx - 1) / 2, r, 0, mRZ(90));
    for (const x of [-1, 1]) m.add(place(box({ w: 1, h: 2 * r + 0.3, d: 2 * r + 0.4, texture: T.dark }, ctx), x * (sx / 2 - 2), 0, 0));
    return m;
  },
  block(o) {
    const { sx, sz, h, ctx, T } = o;
    const bh = Math.max(1, Math.min(6, h));
    const m = box({ w: sx, h: bh, d: sz, texture: T.main }, ctx);
    if (sx >= 4 && sz >= 4) m.add(place(box({ w: sx - 2, h: 0.5, d: sz - 2, texture: T.dark }, ctx), 0, bh, 0));
    return m;
  },
};
/** Kind -> [aspect range (long / short side), default weight]. */
const SHAPE = {
  panel: [[1, 3], 4], vent: [[1, 2.5], 2], pipe: [[3, 8], 2], conduit: [[1.5, 3], 1], antenna: [[1, 1], 0.5], bolts: [[3, 8], 1.5],
  hatch: [[1, 1.6], 1], heatsink: [[1, 2], 1], nozzle: [[1, 1], 0.7], dome: [[1, 1], 0.5], cables: [[3, 6], 1], tank: [[2, 3.5], 0.7], block: [[1, 2.5], 2],
};
export const GREEBLE_KINDS = Object.keys(KINDS);
/** One built-in piece (footprint sx x sz px centred on the origin, about h tall) -> Mesh. T = {main, dark, accent} textures. */
export function greeblePiece(kind, sx, sz, h, T, ctx) {
  if (!KINDS[kind]) throw new Error(`unknown greeble kind "${kind}" (${GREEBLE_KINDS.join(", ")})`);
  return KINDS[kind]({ sx, sz, h, T: { main: "#7a808a", dark: "#3c4048", accent: "#a8acb4", ...T }, ctx });
}

const num = (v, d, name) => { const x = Number(v ?? d); if (!Number.isFinite(x)) throw new Error(`greeble ${name} must be a number`); return x; };
const range = (v, d, name) => {
  const r = v === undefined ? d : typeof v === 'number' ? [v, v] : v;
  if (!Array.isArray(r) || r.length !== 2 || r.some((x) => !Number.isFinite(Number(x)) || Number(x) <= 0)) throw new Error(`greeble ${name} must be [min, max] px (> 0)`);
  return r.map(Number).sort((a, b) => a - b);
};

/** kinds: list | {name: weight} | entries {model:"x", weight} -> [{name, weight, model?}] */
function kindList(a, ctx) {
  let k = a.kinds ?? a.kind;
  if (k === undefined) return Object.entries(SHAPE).map(([name, s]) => ({ name, weight: s[1] }));
  if (typeof k === 'string') k = [k];
  const entries = Array.isArray(k) ? k.map((x) => (typeof x === 'string' ? [x, null] : [x.model ? `model:${x.model}` : x.kind, x.weight ?? null, x])) : Object.entries(k).map(([n, w]) => [n, w]);
  const reg = ctx.greebleKinds ? ctx.greebleKinds() : {};
  return entries.map(([name, w, obj]) => {
    if (typeof name !== 'string') throw new Error('greeble kinds entries must be names or {model, weight}');
    let model = null;
    if (name.startsWith('model:')) model = name.slice(6);
    else if (!KINDS[name]) {
      if (reg[name]) model = reg[name];
      else throw new Error(`unknown greeble kind "${name}" (built-in: ${GREEBLE_KINDS.join(', ')}; your own: "model:<model name>" or a model with greeble_kind:"${name}"${Object.keys(reg).length ? `; registered: ${Object.keys(reg).join(', ')}` : ''})`);
    }
    const weight = Number(w ?? (model ? 1 : SHAPE[name][1]));
    if (!(weight >= 0)) throw new Error(`greeble kind "${name}" weight must be >= 0`);
    return { name, weight, model, fit: obj?.fit ?? 'fit' };
  }).filter((e) => e.weight > 0);
}

/** Avoid mask: canvas (painted alpha >= 128 = keep out, stretched over the region) and/or rects [[u,v,w,h]]. */
function avoidFn(a, ctx, W, D) {
  const tests = [];
  const list = a.avoid === undefined ? [] : Array.isArray(a.avoid) && (a.avoid.length === 0 || Array.isArray(a.avoid[0])) ? [{ rects: a.avoid }] : [].concat(a.avoid);
  for (const it of list) {
    if (typeof it === 'string' || (it && it.canvas)) {
      const t = ctx.tex(it);
      tests.push((u, v) => {
        const x = Math.min(t.width - 1, Math.max(0, Math.floor((u / W) * t.width))), y = Math.min(t.height - 1, Math.max(0, Math.floor((v / D) * t.height)));
        return t.data[(y * t.width + x) * 4 + 3] >= 128;
      });
    } else if (it && Array.isArray(it.rects)) {
      for (const r of it.rects) {
        if (!Array.isArray(r) || r.length !== 4 || r.some((x) => !Number.isFinite(Number(x)))) throw new Error('greeble avoid rects must be [[u,v,w,h], ...] px from the region top-left');
        const [u0, v0, w, h] = r.map(Number);
        tests.push((u, v) => u >= u0 && u < u0 + w && v >= v0 && v < v0 + h);
      }
    } else throw new Error('greeble avoid must be a mask canvas name, {canvas} or [[u,v,w,h], ...] rects');
  }
  return tests.length ? (u, v) => tests.some((f) => f(u, v)) : null;
}

/**
 * Deterministic placement: [{kind, model?, u, v (top-left px), fx, fz (footprint), sx, sz (piece
 * size before turning), h, turn (0|1 = 90°), yaw (free rotation deg)}], plus the coverage.
 */
export function greebleLayout(a, ctx) {
  const W = num(a.w, 64, 'w'), D = num(a.d, 64, 'd');
  if (!(W > 0 && D > 0)) throw new Error('greeble w and d must be > 0');
  const rnd = mulberry32(Math.round(num(a.seed, 1, 'seed')) || 1);
  const density = num(a.density, 0.45, 'density');
  if (!(density > 0 && density <= 1)) throw new Error('greeble density must be 0..1 (target fraction of the free region covered)');
  const [smin, smax] = range(a.size, [3, 12], 'size'), [hmin, hmax] = range(a.height, [1, 4], 'height');
  const grid = Math.max(0, num(a.grid, 0, 'grid'));
  const align = a.align ?? (grid ? 'grid' : 'grid');
  if (!['grid', 'free'].includes(align)) throw new Error('greeble align must be "grid" (axis-aligned, 90° turns, snapped when grid is set) or "free" (any yaw)');
  const gap = Math.max(0, num(a.gap, 1, 'gap')), margin = Math.max(0, num(a.margin, 1, 'margin'));
  const kinds = kindList(a, ctx);
  if (!kinds.length) throw new Error('greeble kinds: nothing to place (all weights 0)');
  const totalW = kinds.reduce((s, k) => s + k.weight, 0);
  const pick = () => { let r = rnd() * totalW; for (const k of kinds) { r -= k.weight; if (r <= 0) return k; } return kinds[kinds.length - 1]; };
  const avoid = avoidFn(a, ctx, W, D);
  const cell = 1;
  const ni = Math.ceil(W / cell), nj = Math.ceil(D / cell);
  if (ni * nj > 4e6) throw new Error('greeble region too large (max 4M px²): split it into several greeble parts');
  const occ = new Uint8Array(ni * nj);
  let free = 0;
  for (let j = 0; j < nj; j++) for (let i = 0; i < ni; i++) {
    const u = (i + 0.5) * cell, v = (j + 0.5) * cell;
    const out = u < margin || v < margin || u > W - margin || v > D - margin || (avoid && avoid(u, v));
    if (out) occ[j * ni + i] = 2; else free++;
  }
  const target = free * density, maxCount = Math.max(1, Math.min(2000, Math.round(num(a.count, 2000, 'count'))));
  const snap = (v) => (grid ? Math.max(grid, Math.round(v / grid) * grid) : Math.round(v * 2) / 2);
  const out = [];
  let covered = 0, misses = 0;
  const attempts = Math.min(60000, 400 + maxCount * 40);
  for (let k = 0; k < attempts && covered < target && out.length < maxCount && misses < 3000; k++) {
    const kind = pick();
    const asp = kind.model ? [1, 1] : SHAPE[kind.name][0];
    // big pieces first, smaller ones fill the gaps as the region fills
    const fill = covered / Math.max(1, target);
    const s = smin + (smax - smin) * Math.pow(rnd(), 1 + fill * 2);
    const ar = asp[0] + (asp[1] - asp[0]) * rnd();
    let sx = snap(Math.min(smax * Math.max(1, ar / 2), s * Math.sqrt(ar) * (asp[1] > 1 ? 1.2 : 1))), sz = snap(Math.max(smin * 0.5, s / Math.sqrt(ar)));
    if (asp[0] === 1 && asp[1] === 1) sz = sx;
    const turn = align === 'grid' && rnd() < 0.5 ? 1 : 0;
    const yaw = align === 'free' ? rnd() * 360 : 0;
    let fx = turn ? sz : sx, fz = turn ? sx : sz;
    if (yaw) { const c = Math.abs(Math.cos((yaw * Math.PI) / 180)), sn = Math.abs(Math.sin((yaw * Math.PI) / 180)); [fx, fz] = [sx * c + sz * sn, sx * sn + sz * c]; }
    if (fx > W - 2 * margin || fz > D - 2 * margin) { misses++; continue; }
    let u = margin + rnd() * (W - 2 * margin - fx), v = margin + rnd() * (D - 2 * margin - fz);
    if (grid) { u = Math.round(u / grid) * grid; v = Math.round(v / grid) * grid; } else { u = Math.round(u * 2) / 2; v = Math.round(v * 2) / 2; }
    const i0 = Math.floor((u - gap) / cell), i1 = Math.ceil((u + fx + gap) / cell), j0 = Math.floor((v - gap) / cell), j1 = Math.ceil((v + fz + gap) / cell);
    let ok = u >= margin - 1e-9 && v >= margin - 1e-9 && u + fx <= W - margin + 1e-9 && v + fz <= D - margin + 1e-9;
    for (let j = Math.max(0, j0); ok && j < Math.min(nj, j1); j++) for (let i = Math.max(0, i0); i < Math.min(ni, i1); i++) {
      const o = occ[j * ni + i];
      if (o === 1) { ok = false; break; }
      // keep-out (margin / avoid) only blocks the footprint itself, not the gap ring
      if (o === 2 && i >= Math.floor(u / cell) && i < Math.ceil((u + fx) / cell) && j >= Math.floor(v / cell) && j < Math.ceil((v + fz) / cell)) { ok = false; break; }
    }
    if (!ok) { misses++; continue; }
    misses = 0;
    for (let j = Math.floor(v / cell); j < Math.ceil((v + fz) / cell); j++) for (let i = Math.floor(u / cell); i < Math.ceil((u + fx) / cell); i++) if (i >= 0 && j >= 0 && i < ni && j < nj && occ[j * ni + i] === 0) { occ[j * ni + i] = 1; covered++; }
    const h = Math.round((hmin + (hmax - hmin) * rnd()) * 2) / 2;
    out.push({ kind: kind.name, model: kind.model, fit: kind.fit, u, v, fx, fz, sx, sz, h, turn, yaw });
  }
  return { pieces: out, coverage: free ? covered / free : 0, W, D };
}

/** Mesh of one piece in its own frame (footprint centred on the origin, before turning). */
function pieceMesh(pc, T, ctx, cache) {
  if (pc.model) {
    let base = cache.get(`model:${pc.model}`);
    if (!base) {
      const def = ctx.getModel(pc.model);
      base = buildModel(def, { ...ctx, nested: true, instances: false, stack: [...(ctx.stack || []), pc.model] }).mesh;
      cache.set(`model:${pc.model}`, base);
    }
    const m = base.clone(), b = m.bounds();
    const bw = b.max[0] - b.min[0] || 1, bd = b.max[2] - b.min[2] || 1;
    const k = pc.fit === 'none' ? 1 : Math.min(pc.sx / bw, pc.sz / bd);
    const cx = (b.min[0] + b.max[0]) / 2, cz = (b.min[2] + b.max[2]) / 2;
    return m.transform([k, 0, 0, -cx * k, 0, k, 0, -b.min[1] * k, 0, 0, k, -cz * k]);
  }
  return KINDS[pc.kind]({ sx: pc.sx, sz: pc.sz, h: pc.h, T, ctx });
}

/** Piece placement matrix in the region frame. */
const pieceMatrix = (pc, W, D) => {
  const cx = pc.u + pc.fx / 2 - W / 2, cz = pc.v + pc.fz / 2 - D / 2;
  const R = pc.yaw ? mRY(pc.yaw) : pc.turn ? mRY(90) : null;
  return R ? matMul(mT(cx, 0, cz), R) : mT(cx, 0, cz);
};

/**
 * Greeble part / face option -> Mesh (all pieces merged; faces tagged greeble = the LOD level
 * from which they are dropped). instanced:true leaves the mesh empty and returns the pieces as
 * GPU instances on mesh.gpu = [{key, mesh, mats}] (EXT_mesh_gpu_instancing at export).
 */
export function greeble(a, ctx) {
  const lay = greebleLayout(a, ctx);
  const tx = a.textures || {};
  const main = a.texture ?? a.color ?? '#7a808a';
  const T = { main: tx.main ?? main, dark: tx.dark ?? a.dark ?? '#3c4048', accent: tx.accent ?? a.accent ?? '#a8acb4' };
  // drop_lod: the LOD level a piece disappears at; auto = flat pieces (<= 2 px) at LOD 1, the rest at LOD 2
  const dropOpt = a.drop_lod ?? a.lod_drop ?? 'auto';
  const fixed = dropOpt === 'auto' ? null : Math.max(1, Math.round(num(dropOpt, 1, 'drop_lod')));
  const m = new Mesh();
  const cache = new Map();
  const perKind = (k) => (tx[k] ? { ...T, main: tx[k] } : T);
  // faces remember the LOD level they drop at and their piece height (= the LOD error of dropping it)
  const tag = (pm) => { const gh = Math.max(0, pm.bounds().max[1]), drop = fixed ?? (gh <= 2 ? 1 : 2); for (const { f } of pm.faces) { f.greeble = drop; f.gh = gh; } return pm; };
  if (a.instanced) {
    const protos = new Map();
    for (const pc of lay.pieces) {
      const key = `${pc.model ? `model:${pc.model}` : pc.kind}|${pc.sx}|${pc.sz}|${pc.h}`;
      if (!protos.has(key)) protos.set(key, { key, mesh: tag(pieceMesh(pc, perKind(pc.kind), ctx, cache)), mats: [] });
      protos.get(key).mats.push(pieceMatrix(pc, lay.W, lay.D));
    }
    m.gpu = [...protos.values()];
  } else {
    for (const pc of lay.pieces) m.add(tag(pieceMesh(pc, perKind(pc.kind), ctx, cache)).transform(pieceMatrix(pc, lay.W, lay.D)));
  }
  m.greebleStats = { pieces: lay.pieces.length, coverage: +lay.coverage.toFixed(3), kinds: [...new Set(lay.pieces.map((p) => p.kind))] };
  return m;
}
