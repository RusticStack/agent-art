// Baked ambient occlusion for art_model exports: a BVH over the model's opaque triangles and
// cosine-weighted hemisphere rays (deterministic Hammersley set, rotated per sample point by a
// hash, so a bake is bit-identical run to run). Contact shadows land in crevices, under greebles,
// in insets and where pieces meet.
//   vertex  -> per-vertex AO (glTF COLOR_0, multiplies the base colour in three.js)
//   texture -> an AO lightmap (glTF occlusionTexture, its own unique UV set TEXCOORD_1): every
//              face gets its own chart at `texel` px per AO texel, shelf-packed, NEAREST sampled
//              so it stays pixel-crisp like the colour textures.
import { faceBasis } from './ctm.js';

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

// ---------- BVH ----------
/** Triangles (Float32Array, 9 floats each) -> flat BVH with closest-hit ray queries. */
export class BVH {
  constructor(tris) {
    this.tris = tris;
    const n = tris.length / 9;
    this.order = new Uint32Array(n);
    for (let i = 0; i < n; i++) this.order[i] = i;
    const cen = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) cen[i * 3 + k] = (tris[i * 9 + k] + tris[i * 9 + 3 + k] + tris[i * 9 + 6 + k]) / 3;
    const cap = Math.max(1, 2 * n);
    this.bmin = new Float32Array(cap * 3); this.bmax = new Float32Array(cap * 3);
    this.left = new Int32Array(cap); this.start = new Uint32Array(cap); this.count = new Uint32Array(cap);
    let nodes = 0;
    const mk = (s, c) => {
      const id = nodes++;
      let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
      for (let i = s; i < s + c; i++) {
        const t = this.order[i] * 9;
        for (let v = 0; v < 9; v += 3) {
          const x = tris[t + v], y = tris[t + v + 1], z = tris[t + v + 2];
          if (x < x0) x0 = x; if (y < y0) y0 = y; if (z < z0) z0 = z; if (x > x1) x1 = x; if (y > y1) y1 = y; if (z > z1) z1 = z;
        }
      }
      this.bmin.set([x0, y0, z0], id * 3); this.bmax.set([x1, y1, z1], id * 3);
      this.left[id] = -1; this.start[id] = s; this.count[id] = c;
      return id;
    };
    if (!n) { this.nodes = 0; return; }
    const root = mk(0, n), st = [root];
    while (st.length) {
      const id = st.pop(), s = this.start[id], c = this.count[id];
      if (c <= 4) continue;
      // split on the longest centroid axis at the median
      let c0 = [Infinity, Infinity, Infinity], c1 = [-Infinity, -Infinity, -Infinity];
      for (let i = s; i < s + c; i++) { const t = this.order[i]; for (let k = 0; k < 3; k++) { const v = cen[t * 3 + k]; if (v < c0[k]) c0[k] = v; if (v > c1[k]) c1[k] = v; } }
      const ax = c1[0] - c0[0] >= c1[1] - c0[1] && c1[0] - c0[0] >= c1[2] - c0[2] ? 0 : c1[1] - c0[1] >= c1[2] - c0[2] ? 1 : 2;
      if (c1[ax] - c0[ax] < 1e-9) continue;
      const sub0 = Array.from(this.order.subarray(s, s + c)).sort((a, b) => cen[a * 3 + ax] - cen[b * 3 + ax] || a - b);
      this.order.set(sub0, s);
      const h = c >> 1;
      const l = mk(s, h); mk(s + h, c - h);
      this.left[id] = l; this.count[id] = 0;
      st.push(l, l + 1);
    }
    this.nodes = nodes;
  }
  /** Distance to the closest hit along unit dir d from o within tmax, or Infinity (two-sided). */
  hit(o, d, tmax) {
    if (!this.nodes) return Infinity;
    const T = this.tris, inv = [1 / d[0], 1 / d[1], 1 / d[2]];
    let best = tmax;
    const st = [0];
    while (st.length) {
      const id = st.pop();
      // slab test
      let t0 = 0, t1 = best;
      for (let k = 0; k < 3; k++) {
        let a = (this.bmin[id * 3 + k] - o[k]) * inv[k], b = (this.bmax[id * 3 + k] - o[k]) * inv[k];
        if (a > b) { const x = a; a = b; b = x; }
        if (a > t0) t0 = a; if (b < t1) t1 = b;
        if (t0 > t1) break;
      }
      if (t0 > t1) continue;
      if (this.left[id] >= 0) { st.push(this.left[id], this.left[id] + 1); continue; }
      for (let i = this.start[id], e = i + this.count[id]; i < e; i++) {
        const t = this.order[i] * 9;
        const e1x = T[t + 3] - T[t], e1y = T[t + 4] - T[t + 1], e1z = T[t + 5] - T[t + 2];
        const e2x = T[t + 6] - T[t], e2y = T[t + 7] - T[t + 1], e2z = T[t + 8] - T[t + 2];
        const px = d[1] * e2z - d[2] * e2y, py = d[2] * e2x - d[0] * e2z, pz = d[0] * e2y - d[1] * e2x;
        const det = e1x * px + e1y * py + e1z * pz;
        if (Math.abs(det) < 1e-12) continue;
        const id2 = 1 / det, sx = o[0] - T[t], sy = o[1] - T[t + 1], sz = o[2] - T[t + 2];
        const u = (sx * px + sy * py + sz * pz) * id2;
        if (u < 0 || u > 1) continue;
        const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
        const v = (d[0] * qx + d[1] * qy + d[2] * qz) * id2;
        if (v < 0 || u + v > 1) continue;
        const tt = (e2x * qx + e2y * qy + e2z * qz) * id2;
        if (tt > 1e-6 && tt < best) best = tt;
      }
    }
    return best;
  }
}

/** Opaque triangles of meshes (px) as a BVH: overlays and translucent materials do not occlude. */
export function bvhOf(meshes) {
  const out = [];
  for (const m of meshes) for (const g of m.groups.values()) {
    if (g.overlay || g.tex.material?.blend || g.tex.decal) continue; // decals (alpha-cut stickers) never occlude
    for (let i = 0; i < g.idx.length; i += 3) for (let k = 0; k < 3; k++) { const v = g.idx[i + k]; out.push(g.pos[v * 3], g.pos[v * 3 + 1], g.pos[v * 3 + 2]); }
  }
  return new BVH(Float32Array.from(out));
}

// ---------- hemisphere sampling ----------
function radical(i) { let b = 0, f = 0.5; while (i) { if (i & 1) b += f; i >>= 1; f *= 0.5; } return b; }
/** Cosine-weighted hemisphere directions (z up) for n samples. */
function hemisphere(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const u = (i + 0.5) / n, v = radical(i + 1);
    const r = Math.sqrt(u), ph = 2 * Math.PI * v;
    out.push([r * Math.cos(ph), r * Math.sin(ph), Math.sqrt(Math.max(0, 1 - u))]);
  }
  return out;
}
const hashf = (a, b) => { let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x632be5ab, 0xc2b2ae35); h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); h ^= h >>> 12; return (h >>> 0) / 4294967296; };

/** AO options: true | {mode, samples, distance, strength, texel, levels, bias, max_size} -> normalized. */
export function normAO(v) {
  if (!v) return null;
  const o = v === true ? {} : v;
  if (typeof o !== 'object') throw new Error('bake_ao must be true or {mode?:"texture"|"vertex"|"both", samples?:24, distance?:24 px, strength?:1, texel?:2 px, levels?}');
  const mode = o.mode ?? 'texture';
  if (!['texture', 'vertex', 'both'].includes(mode)) throw new Error('bake_ao.mode must be texture (AO lightmap, occlusionTexture + TEXCOORD_1), vertex (COLOR_0) or both');
  const r = {
    mode, samples: Math.max(4, Math.min(256, Math.round(Number(o.samples ?? 24)))), distance: Number(o.distance ?? 24), strength: Number(o.strength ?? 1),
    texel: Number(o.texel ?? 2), levels: o.levels ? Math.max(2, Math.round(Number(o.levels))) : 0, bias: Number(o.bias ?? 0.05), maxSize: Math.max(64, Math.min(4096, Math.round(Number(o.max_size ?? 2048)))),
  };
  if (!(r.distance > 0) || !(r.texel > 0) || !(r.strength >= 0) || !Number.isFinite(r.samples) || !Number.isFinite(r.bias) || (o.levels && !Number.isFinite(r.levels))) throw new Error('bake_ao distance and texel must be > 0, strength >= 0, samples / levels / bias numbers');
  return r;
}

/** AO (0..1, 1 = open) at point p with normal n. */
function aoAt(bvh, p, n, dirs, o, rot) {
  const t = Math.abs(n[1]) < 0.9 ? norm(cross([0, 1, 0], n)) : norm(cross([1, 0, 0], n)), b = cross(n, t);
  const c = Math.cos(rot), s = Math.sin(rot);
  const org = [p[0] + n[0] * o.bias, p[1] + n[1] * o.bias, p[2] + n[2] * o.bias];
  let occ = 0;
  for (const [x0, y0, z] of dirs) {
    const x = x0 * c - y0 * s, y = x0 * s + y0 * c;
    const d = [t[0] * x + b[0] * y + n[0] * z, t[1] * x + b[1] * y + n[1] * z, t[2] * x + b[2] * y + n[2] * z];
    const h = bvh.hit(org, d, o.distance);
    if (h < o.distance) occ += 1 - h / o.distance;
  }
  let ao = Math.max(0, Math.min(1, 1 - (o.strength * occ) / dirs.length));
  if (o.levels) ao = Math.round(ao * (o.levels - 1)) / (o.levels - 1);
  return ao;
}

/** Per-vertex AO into g.ao (one value per vertex) for every base group of mesh. */
export function bakeVertexAO(mesh, bvh, o) {
  const dirs = hemisphere(o.samples);
  for (const g of mesh.groups.values()) {
    if (g.overlay) continue;
    g.ao = new Array(g.pos.length / 3).fill(1);
    for (const f of g.faces) {
      const c = [0, 0, 0];
      for (let v = f.v; v < f.v + f.vc; v++) for (let k = 0; k < 3; k++) c[k] += g.pos[v * 3 + k] / f.vc;
      for (let v = f.v; v < f.v + f.vc; v++) {
        const p = [g.pos[v * 3], g.pos[v * 3 + 1], g.pos[v * 3 + 2]];
        // pull the sample a little toward the face centre so it does not sit on the edge it shares
        const toC = sub(c, p), dl = Math.hypot(...toC), k = dl > 1e-9 ? Math.min(0.5, dl * 0.25) / dl : 0;
        const q = [p[0] + toC[0] * k, p[1] + toC[1] * k, p[2] + toC[2] * k];
        const vn = norm([g.nrm[v * 3], g.nrm[v * 3 + 1], g.nrm[v * 3 + 2]]);
        g.ao[v] = aoAt(bvh, q, vn, dirs, o, hashf(v, Math.round(p[0] * 7 + p[1] * 13 + p[2] * 17)) * 2 * Math.PI);
      }
    }
  }
}

/**
 * AO lightmap: one chart per face (planar projection on the face basis), shelf-packed with a
 * 1-texel gutter, texel px per AO texel (grown until the atlas fits max_size). Writes g.uv1 and
 * returns {width, height, data (RGBA, grey = AO), texel, charts}.
 */
export function bakeTextureAO(items, o) {
  const dirs = hemisphere(o.samples);
  const charts = [];
  for (const { mesh, bvh } of items) for (const g of mesh.groups.values()) {
    if (g.overlay) continue;
    for (const f of g.faces) {
      if (!f.vc) continue;
      const { t, b } = faceBasis(f.n);
      let s0 = Infinity, s1 = -Infinity, q0 = Infinity, q1 = -Infinity, d = 0;
      for (let v = f.v; v < f.v + f.vc; v++) {
        const p = [g.pos[v * 3], g.pos[v * 3 + 1], g.pos[v * 3 + 2]], s = dot(p, t), q = dot(p, b);
        if (s < s0) s0 = s; if (s > s1) s1 = s; if (q < q0) q0 = q; if (q > q1) q1 = q; d += dot(p, f.n) / f.vc;
      }
      charts.push({ g, f, t, b, s0, s1, q0, q1, d, bvh });
    }
  }
  let texel = o.texel, W = 0, H = 0;
  for (let tries = 0; tries < 24; tries++) {
    for (const c of charts) { c.w = Math.max(1, Math.ceil((c.s1 - c.s0) / texel - 1e-6)) + 2; c.h = Math.max(1, Math.ceil((c.q1 - c.q0) / texel - 1e-6)) + 2; }
    const area = charts.reduce((s, c) => s + c.w * c.h, 0);
    W = 1; while (W * W < area * 1.15) W *= 2;
    W = Math.max(W, ...charts.map((c) => { let p = 1; while (p < c.w) p *= 2; return p; }), 16);
    const order = charts.map((c, i) => i).sort((a, b) => charts[b].h - charts[a].h || charts[b].w - charts[a].w || a - b);
    let x = 0, y = 0, rowH = 0;
    for (const i of order) {
      const c = charts[i];
      if (x + c.w > W) { x = 0; y += rowH; rowH = 0; }
      c.x = x; c.y = y; x += c.w; rowH = Math.max(rowH, c.h);
    }
    H = 1; while (H < y + rowH) H *= 2;
    if (W <= o.maxSize && H <= o.maxSize) break;
    texel *= 1.5;
  }
  const data = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) data.set([255, 255, 255, 255], i * 4);
  let texels = 0;
  for (const c of charts) {
    const { g, f, t, b, bvh } = c;
    // the face's triangles in (s, q) for clamping texel centres onto the face
    const tri2 = [];
    for (let i = f.i; i < f.i + f.ic; i += 3) tri2.push([0, 1, 2].map((k) => { const v = g.idx[i + k], p = [g.pos[v * 3], g.pos[v * 3 + 1], g.pos[v * 3 + 2]]; return [dot(p, t), dot(p, b)]; }));
    const clamp2 = (s, q) => {
      let best = null, bd = Infinity;
      for (const T of tri2) {
        const ar = (T[1][0] - T[0][0]) * (T[2][1] - T[0][1]) - (T[2][0] - T[0][0]) * (T[1][1] - T[0][1]);
        if (Math.abs(ar) < 1e-12) continue;
        const l1 = ((T[1][0] - s) * (T[2][1] - q) - (T[2][0] - s) * (T[1][1] - q)) / ar, l2 = ((T[2][0] - s) * (T[0][1] - q) - (T[0][0] - s) * (T[2][1] - q)) / ar, l3 = 1 - l1 - l2;
        if (l1 >= 0 && l2 >= 0 && l3 >= 0) return [s, q];
        for (let k = 0; k < 3; k++) {
          const A = T[k], B = T[(k + 1) % 3], dx = B[0] - A[0], dy = B[1] - A[1], L = dx * dx + dy * dy;
          const u = L ? Math.max(0, Math.min(1, ((s - A[0]) * dx + (q - A[1]) * dy) / L)) : 0;
          const px = A[0] + dx * u, py = A[1] + dy * u, dd = (px - s) ** 2 + (py - q) ** 2;
          if (dd < bd) { bd = dd; best = [px, py]; }
        }
      }
      return best || [s, q];
    };
    const iw = c.w - 2, ih = c.h - 2;
    const vals = new Float32Array(iw * ih);
    for (let j = 0; j < ih; j++) for (let i = 0; i < iw; i++) {
      let s = c.s0 + (i + 0.5) * texel, q = c.q0 + (j + 0.5) * texel;
      [s, q] = clamp2(s, q);
      // nudge 0.3 texel inside so edge samples do not start on the neighbouring face
      const p = [t[0] * s + b[0] * q + f.n[0] * c.d, t[1] * s + b[1] * q + f.n[1] * c.d, t[2] * s + b[2] * q + f.n[2] * c.d];
      vals[j * iw + i] = aoAt(bvh, p, f.n, dirs, o, hashf(c.x + i, c.y + j) * 2 * Math.PI);
      texels++;
    }
    for (let j = -1; j <= ih; j++) for (let i = -1; i <= iw; i++) {
      const v = vals[Math.max(0, Math.min(ih - 1, j)) * iw + Math.max(0, Math.min(iw - 1, i))];
      const g8 = Math.round(v * 255), p = ((c.y + 1 + j) * W + c.x + 1 + i) * 4;
      data[p] = g8; data[p + 1] = g8; data[p + 2] = g8;
    }
    if (!g.uv1) g.uv1 = new Array((g.pos.length / 3) * 2).fill(0);
    for (let v = f.v; v < f.v + f.vc; v++) {
      const p = [g.pos[v * 3], g.pos[v * 3 + 1], g.pos[v * 3 + 2]];
      g.uv1[v * 2] = (c.x + 1 + (dot(p, t) - c.s0) / texel) / W;
      g.uv1[v * 2 + 1] = (c.y + 1 + (dot(p, b) - c.q0) / texel) / H;
    }
  }
  return { key: 'ao', name: 'ao', width: W, height: H, data, texel: +texel.toFixed(4), charts: charts.length, texels };
}

/**
 * Bake AO (px meshes). sets: [{meshes:[Mesh], occluders?:[Mesh]}]: each set shares one BVH (its
 * meshes + occluders; e.g. one LOD level), all sets share one AO lightmap. g.ao and/or g.uv1 +
 * g.aoTex are set. -> {stats, map}
 */
export function bakeAO(sets, opts) {
  const o = normAO(opts);
  const prepared = sets.map((s) => ({ meshes: s.meshes, bvh: bvhOf([...s.meshes, ...(s.occluders || [])]) }));
  const stats = { mode: o.mode, samples: o.samples, distance_px: o.distance, strength: o.strength };
  let map = null;
  if (o.mode === 'vertex' || o.mode === 'both') for (const s of prepared) for (const m of s.meshes) bakeVertexAO(m, s.bvh, o);
  if (o.mode === 'texture' || o.mode === 'both') {
    map = bakeTextureAO(prepared.flatMap((s) => s.meshes.map((mesh) => ({ mesh, bvh: s.bvh }))), o);
    for (const s of prepared) for (const m of s.meshes) for (const g of m.groups.values()) if (!g.overlay) g.aoTex = map;
    Object.assign(stats, { size: [map.width, map.height], texel_px: map.texel, charts: map.charts });
  }
  return { stats, map };
}
