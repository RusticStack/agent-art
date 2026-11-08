// 3D from pixel art (HD-2D: pixel textures on low-poly meshes, nearest filtering).
// Mesh builders (props + modular environment kit pieces), part transforms and model assembly.
// Units are art pixels; export divides by px-per-unit (default 32). Y-up, +Z = front, origin
// bottom-centre. UV (0,0) = top-left texel (glTF convention, no flip).
//
// Textures: image-mapped faces (extrude, lathe, plane: mode 0) keep their UVs. World-tiled faces
// (kit pieces: mode 1 planar per face, mode 2 = cylinder unwrap with world v) get their UVs from
// the WORLD position after placement (finalize), 1 texel = 1 px: any offset, turn, array or nested
// layout lines up with its neighbours. Then CTM tiles are picked per face cell from neighbours
// across all pieces, and overlay shells (grime, moss, ...) get their own UV set (TEXCOORD_1).
import { hash3, mulberry32 } from './util.js';
import { triangulate, pointInPoly, polySDF, contour, simplifyLoop, simplifyPath, nestLoops, triangulateShape, area2 } from './poly2d.js';
import { applyCTM, cellIndex, ctmTileFor, faceBasis, tileUV } from './ctm.js';

// ---------- vector / matrix ----------
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const norm = (a) => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
export { cross, dot, norm, sub, triangulate };

// 3x4 affine matrices, row-major: [m00 m01 m02 tx, m10 m11 m12 ty, m20 m21 m22 tz]
export const IDENT = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];
export function matMul(A, B) {
  const r = new Array(12);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) r[i * 4 + j] = A[i * 4] * B[j] + A[i * 4 + 1] * B[4 + j] + A[i * 4 + 2] * B[8 + j];
    r[i * 4 + 3] = A[i * 4] * B[3] + A[i * 4 + 1] * B[7] + A[i * 4 + 2] * B[11] + A[i * 4 + 3];
  }
  return r;
}
const snap = (v) => (Math.abs(v) < 1e-12 ? 0 : Math.abs(Math.abs(v) - 1) < 1e-12 ? Math.sign(v) : v);
const cs = (deg) => { const r = (deg * Math.PI) / 180; return [snap(Math.cos(r)), snap(Math.sin(r))]; };
export const mT = (x, y, z) => [1, 0, 0, x, 0, 1, 0, y, 0, 0, 1, z];
export const mS = (x, y, z) => [x, 0, 0, 0, 0, y, 0, 0, 0, 0, z, 0];
export const mRX = (d) => { const [c, s] = cs(d); return [1, 0, 0, 0, 0, c, -s, 0, 0, s, c, 0]; };
export const mRY = (d) => { const [c, s] = cs(d); return [c, 0, s, 0, 0, 1, 0, 0, -s, 0, c, 0]; };
export const mRZ = (d) => { const [c, s] = cs(d); return [c, -s, 0, 0, s, c, 0, 0, 0, 0, 1, 0]; };
export const applyP = (M, p) => [M[0] * p[0] + M[1] * p[1] + M[2] * p[2] + M[3], M[4] * p[0] + M[5] * p[1] + M[6] * p[2] + M[7], M[8] * p[0] + M[9] * p[1] + M[10] * p[2] + M[11]];
export const det3 = (M) => M[0] * (M[5] * M[10] - M[6] * M[9]) - M[1] * (M[4] * M[10] - M[6] * M[8]) + M[2] * (M[4] * M[9] - M[5] * M[8]);
/** Cofactor matrix (= det * inverse-transpose): transforms normals. */
function cofactor(M) {
  const [a, b, c, , d, e, f, , g, h, i] = M;
  return [e * i - f * h, f * g - d * i, d * h - e * g, 0, c * h - b * i, a * i - c * g, b * g - a * h, 0, b * f - c * e, c * d - a * f, a * e - b * d, 0];
}

// ---------- mesh ----------
/**
 * Triangle mesh grouped by texture (one glTF primitive / material per texture). Base groups keep
 * a face list {v, vc, i, ic, n, mode, ...props}; overlay groups (decal shells) carry uv0 (base
 * world UV) and per-vertex alpha besides their own uv (exported as TEXCOORD_1).
 */
export class Mesh {
  constructor() { this.groups = new Map(); }
  group(tex, overlay = false) {
    const key = overlay ? `ov:${tex.key}` : tex.key;
    let g = this.groups.get(key);
    if (!g) {
      g = { tex, pos: [], nrm: [], uv: [], idx: [] };
      if (overlay) Object.assign(g, { overlay: true, uv0: [], alpha: [] }); else g.faces = [];
      this.groups.set(key, g);
    }
    return g;
  }
  /**
   * Planar-ish polygon face (fan triangulated). Winding is fixed automatically so the face
   * points along `nominal` (default: the normal); degenerate triangles are skipped.
   * mode: 0 = keep UV, 1 = world planar tiling, 2 = keep u + world v. Returns the face record.
   */
  face(tex, P, N, UV, nominal, mode = 0) {
    const k = P.length, perV = Array.isArray(N[0]);
    const nn = nominal || (perV ? N.reduce(add) : N);
    let c = [0, 0, 0];
    for (let i = 1; i < k - 1; i++) c = add(c, cross(sub(P[i], P[0]), sub(P[i + 1], P[0])));
    const flip = dot(c, nn) < 0;
    const g = this.group(tex), base = g.pos.length / 3, i0 = g.idx.length;
    for (let i = 0; i < k; i++) { g.pos.push(P[i][0], P[i][1], P[i][2]); const n = perV ? N[i] : N; g.nrm.push(n[0], n[1], n[2]); g.uv.push(UV[i][0], UV[i][1]); }
    for (let i = 1; i < k - 1; i++) {
      if (len(cross(sub(P[i], P[0]), sub(P[i + 1], P[0]))) < 1e-9) continue;
      if (flip) g.idx.push(base, base + i + 1, base + i); else g.idx.push(base, base + i, base + i + 1);
    }
    const f = { v: base, vc: k, i: i0, ic: g.idx.length - i0, n: norm(nn), mode };
    g.faces.push(f);
    return f;
  }
  /** Flat polygon with an explicit triangulation (caps). */
  polygon(tex, P, n, UV, tris, mode = 0) {
    const g = this.group(tex), base = g.pos.length / 3, i0 = g.idx.length;
    for (let i = 0; i < P.length; i++) { g.pos.push(P[i][0], P[i][1], P[i][2]); g.nrm.push(n[0], n[1], n[2]); g.uv.push(UV[i][0], UV[i][1]); }
    for (const [a, b, c] of tris) {
      const cr = cross(sub(P[b], P[a]), sub(P[c], P[a]));
      if (len(cr) < 1e-9) continue;
      if (dot(cr, n) < 0) g.idx.push(base + a, base + c, base + b); else g.idx.push(base + a, base + b, base + c);
    }
    const f = { v: base, vc: P.length, i: i0, ic: g.idx.length - i0, n: n.slice(), mode };
    g.faces.push(f);
    return f;
  }
  get faces() { const out = []; for (const g of this.groups.values()) if (g.faces) for (const f of g.faces) out.push({ g, f }); return out; }
  transform(M) {
    const C = cofactor(M), sg = Math.sign(det3(M)) || 1;
    const tn = (n) => norm(applyP(C, n).map((v) => v * sg));
    for (const g of this.groups.values()) {
      for (let i = 0; i < g.pos.length; i += 3) {
        const p = applyP(M, [g.pos[i], g.pos[i + 1], g.pos[i + 2]]);
        g.pos[i] = p[0]; g.pos[i + 1] = p[1]; g.pos[i + 2] = p[2];
        const n = tn([g.nrm[i], g.nrm[i + 1], g.nrm[i + 2]]);
        g.nrm[i] = n[0]; g.nrm[i + 1] = n[1]; g.nrm[i + 2] = n[2];
      }
      if (g.faces) for (const f of g.faces) f.n = tn(f.n);
      if (sg < 0) for (let i = 0; i < g.idx.length; i += 3) { const t = g.idx[i + 1]; g.idx[i + 1] = g.idx[i + 2]; g.idx[i + 2] = t; }
    }
    return this;
  }
  /** Map positions with any function (normals with fn on the normal; must be a rotation). */
  map(fp, fn) {
    for (const g of this.groups.values()) {
      for (let i = 0; i < g.pos.length; i += 3) {
        const p = fp([g.pos[i], g.pos[i + 1], g.pos[i + 2]]), n = fn([g.nrm[i], g.nrm[i + 1], g.nrm[i + 2]]);
        for (let k = 0; k < 3; k++) { g.pos[i + k] = p[k]; g.nrm[i + k] = n[k]; }
      }
      if (g.faces) for (const f of g.faces) f.n = fn(f.n);
    }
    return this;
  }
  add(other) {
    for (const o of other.groups.values()) {
      const g = this.group(o.tex, !!o.overlay), base = g.pos.length / 3, i0 = g.idx.length;
      for (const v of o.pos) g.pos.push(v);
      for (const v of o.nrm) g.nrm.push(v);
      for (const v of o.uv) g.uv.push(v);
      for (const i of o.idx) g.idx.push(base + i);
      if (o.overlay) { for (const v of o.uv0) g.uv0.push(v); for (const v of o.alpha) g.alpha.push(v); }
      else for (const f of o.faces) g.faces.push({ ...f, n: f.n.slice(), v: f.v + base, i: f.i + i0 });
    }
    return this;
  }
  clone() { return new Mesh().add(this); }
  /** Each face gets props (part id, CTM tag, overlays, material key) unless already set. */
  tagFaces(props) {
    for (const g of this.groups.values()) if (g.faces) for (const f of g.faces) {
      for (const [k, v] of Object.entries(props)) if (v !== undefined && f[k] === undefined) f[k] = v;
      if (f.mat === undefined) f.mat = g.tex.canvas ?? g.tex.key;
    }
    return this;
  }
  get triangles() { let n = 0; for (const g of this.groups.values()) n += g.idx.length / 3; return n; }
  bounds() {
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (const g of this.groups.values()) for (let i = 0; i < g.pos.length; i += 3) for (let k = 0; k < 3; k++) {
      if (g.pos[i + k] < min[k]) min[k] = g.pos[i + k];
      if (g.pos[i + k] > max[k]) max[k] = g.pos[i + k];
    }
    return min[0] === Infinity ? { min: [0, 0, 0], max: [0, 0, 0] } : { min, max };
  }
}

/** Merge identical vertices of a group into compact typed arrays. */
export function weld(g) {
  const map = new Map(), pos = [], nrm = [], uv = [], uv0 = [], alpha = [], remap = new Uint32Array(g.pos.length / 3);
  const q = (v) => Math.round(v * 1e5);
  const ov = !!g.overlay;
  for (let i = 0; i < g.pos.length / 3; i++) {
    let key = `${q(g.pos[i * 3])},${q(g.pos[i * 3 + 1])},${q(g.pos[i * 3 + 2])},${q(g.nrm[i * 3])},${q(g.nrm[i * 3 + 1])},${q(g.nrm[i * 3 + 2])},${q(g.uv[i * 2])},${q(g.uv[i * 2 + 1])}`;
    if (ov) key += `,${q(g.uv0[i * 2])},${q(g.uv0[i * 2 + 1])},${q(g.alpha[i])}`;
    let j = map.get(key);
    if (j === undefined) {
      j = pos.length / 3; map.set(key, j);
      pos.push(g.pos[i * 3], g.pos[i * 3 + 1], g.pos[i * 3 + 2]); nrm.push(g.nrm[i * 3], g.nrm[i * 3 + 1], g.nrm[i * 3 + 2]); uv.push(g.uv[i * 2], g.uv[i * 2 + 1]);
      if (ov) { uv0.push(g.uv0[i * 2], g.uv0[i * 2 + 1]); alpha.push(g.alpha[i]); }
    }
    remap[i] = j;
  }
  const out = { tex: g.tex, pos: new Float32Array(pos), nrm: new Float32Array(nrm), uv: new Float32Array(uv), idx: Uint32Array.from(g.idx, (i) => remap[i]) };
  if (ov) Object.assign(out, { overlay: true, uv0: new Float32Array(uv0), alpha: new Float32Array(alpha) });
  return out;
}

// ---------- UV helpers ----------
const tileBasis = faceBasis;
/** UVs for a flat face: tile = world-size repeat (1 texel = 1 px), else fit the face 0..1. */
export function uvFace(P, n, tex, tile = true) {
  const { t, b } = tileBasis(n);
  const st = P.map((p) => [dot(p, t), -dot(p, b)]);
  if (tile) return st.map(([s, q]) => [s / tex.width, q / tex.height]);
  const s0 = Math.min(...st.map((v) => v[0])), s1 = Math.max(...st.map((v) => v[0]));
  const q0 = Math.min(...st.map((v) => v[1])), q1 = Math.max(...st.map((v) => v[1]));
  return st.map(([s, q]) => [(s - s0) / (s1 - s0 || 1), (q - q0) / (q1 - q0 || 1)]);
}

const ROLE = (n) => (n[1] > 0.7 ? 'top' : n[1] < -0.7 ? 'bottom' : Math.abs(n[0]) > Math.abs(n[2]) ? (n[0] > 0 ? 'right' : 'left') : n[2] > 0 ? 'front' : 'back');
/**
 * Texture per face direction: faces:{top,bottom,front,back,left,right} or the same keys on the
 * part, then cap (top+bottom) / side (every vertical face), then texture, then color.
 */
function faceTexer(a, ctx, defColor = '#8a8a94', extra = {}) {
  const f = { ...(a.faces || {}), ...extra };
  const get = (k) => f[k] ?? a[k];
  const cache = new Map();
  return (n) => {
    const role = ROLE(n);
    if (cache.has(role)) return cache.get(role);
    const chain = role === 'top' || role === 'bottom' ? [role, 'cap'] : [role, 'side'];
    let ref = null;
    for (const k of chain) if (get(k) != null) { ref = get(k); break; }
    const t = ctx.tex(ref ?? a.texture ?? a.color ?? defColor);
    cache.set(role, t);
    return t;
  };
}

/** Axis-aligned box faces [min,max] with per-direction textures. */
function boxFaces(m, min, max, ft, tile = true) {
  const [x0, y0, z0] = min, [x1, y1, z1] = max;
  const F = [
    [[0, 0, 1], [[x0, y1, z1], [x1, y1, z1], [x1, y0, z1], [x0, y0, z1]]],
    [[0, 0, -1], [[x1, y1, z0], [x0, y1, z0], [x0, y0, z0], [x1, y0, z0]]],
    [[1, 0, 0], [[x1, y1, z1], [x1, y1, z0], [x1, y0, z0], [x1, y0, z1]]],
    [[-1, 0, 0], [[x0, y1, z0], [x0, y1, z1], [x0, y0, z1], [x0, y0, z0]]],
    [[0, 1, 0], [[x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]]],
    [[0, -1, 0], [[x0, y0, z1], [x1, y0, z1], [x1, y0, z0], [x0, y0, z0]]],
  ];
  for (const [n, P] of F) { const t = ft(n); m.face(t, P, n, uvFace(P, n, t, tile), null, tile ? 1 : 0); }
}

/** Extrude 2D shapes ({outer CCW, holes CW} or a bare polygon) from z0 to z1: caps + a wall per loop edge. */
function prismShapes(m, shapes, z0, z1, ft, tile = true) {
  const mode = tile ? 1 : 0;
  for (const sh of shapes) {
    const { pts, tris } = triangulateShape(sh);
    for (const [z, n] of [[z1, [0, 0, 1]], [z0, [0, 0, -1]]]) {
      const P = pts.map(([x, y]) => [x, y, z]), t = ft(n);
      m.polygon(t, P, n, uvFace(P, n, t, tile), tris, mode);
    }
    for (const loop of [sh.outer, ...sh.holes]) for (let i = 0; i < loop.length; i++) {
      const a = loop[i], b = loop[(i + 1) % loop.length];
      if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 1e-9) continue;
      const n = norm([b[1] - a[1], -(b[0] - a[0]), 0]);
      const P = [[a[0], a[1], z1], [b[0], b[1], z1], [b[0], b[1], z0], [a[0], a[1], z0]];
      const t = ft(n);
      m.face(t, P, n, uvFace(P, n, t, tile), null, mode);
    }
  }
  return m;
}
function prism(m, poly, z0, z1, ft, tile = true) {
  let pts = poly.map((p) => [Number(p[0]), Number(p[1])]);
  pts = pts.filter((p, i) => { const q = pts[(i + pts.length - 1) % pts.length]; return Math.hypot(p[0] - q[0], p[1] - q[1]) > 1e-6; });
  if (area2(pts) < 0) pts = pts.reverse();
  return prismShapes(m, [{ outer: pts, holes: [] }], z0, z1, ft, tile);
}

// ---------- voxel / heightfield mesher (sprites, and style:"voxel" ruins) ----------
function greedy(ni, nj, val, emit) {
  const seen = new Uint8Array(ni * nj);
  for (let j = 0; j < nj; j++) for (let i = 0; i < ni; i++) {
    const v = val(i, j);
    if (!v || seen[j * ni + i]) continue;
    let w = 1;
    while (i + w < ni && !seen[j * ni + i + w] && val(i + w, j) === v) w++;
    let h = 1;
    grow: while (j + h < nj) {
      for (let k = 0; k < w; k++) if (seen[(j + h) * ni + i + k] || val(i + k, j + h) !== v) break grow;
      h++;
    }
    for (let y = 0; y < h; y++) for (let k = 0; k < w; k++) seen[(j + y) * ni + i + k] = 1;
    emit(i, i + w - 1, j, j + h - 1, v);
  }
}
/**
 * Closed voxel columns over an ni x nj grid (j grows downward). h(i,j) = thickness (0 = empty)
 * from z = zb. rect(i0,i1,j0,j1) -> [xLeft, xRight, yTop, yBottom]. Greedy-merged caps
 * (caps=false skips them) and side walls merged into runs. emit(kind, P, n, cells).
 */
function voxelMesh(ni, nj, h, rect, zb, emit, caps = true) {
  const H = (i, j) => (i < 0 || j < 0 || i >= ni || j >= nj ? 0 : h(i, j));
  if (caps) {
    greedy(ni, nj, H, (i0, i1, j0, j1, t) => {
      const [xl, xr, yt, yb] = rect(i0, i1, j0, j1), z = zb + t;
      emit('front', [[xl, yt, z], [xr, yt, z], [xr, yb, z], [xl, yb, z]], [0, 0, 1], { i0, i1, j0, j1 });
    });
    greedy(ni, nj, (i, j) => (H(i, j) > 0 ? 1 : 0), (i0, i1, j0, j1) => {
      const [xl, xr, yt, yb] = rect(i0, i1, j0, j1);
      emit('back', [[xl, yt, zb], [xr, yt, zb], [xr, yb, zb], [xl, yb, zb]], [0, 0, -1], { i0, i1, j0, j1 });
    });
  }
  for (const dir of [-1, 1]) for (let j = 0; j < nj; j++) {
    for (let i = 0; i < ni;) {
      const ta = H(i, j), tb = H(i, j + dir);
      if (ta <= tb) { i++; continue; }
      let e = i + 1;
      while (e < ni && H(e, j) === ta && H(e, j + dir) === tb) e++;
      const [xl, xr, yt, yb] = rect(i, e - 1, j, j), y = dir < 0 ? yt : yb;
      emit('wall', [[xl, y, zb + tb], [xr, y, zb + tb], [xr, y, zb + ta], [xl, y, zb + ta]], [0, -dir, 0], { i0: i, i1: e - 1, j0: j, j1: j });
      i = e;
    }
  }
  for (const dir of [-1, 1]) for (let i = 0; i < ni; i++) {
    for (let j = 0; j < nj;) {
      const ta = H(i, j), tb = H(i + dir, j);
      if (ta <= tb) { j++; continue; }
      let e = j + 1;
      while (e < nj && H(i, e) === ta && H(i + dir, e) === tb) e++;
      const [xl, xr, yt, yb] = rect(i, i, j, e - 1), x = dir < 0 ? xl : xr;
      emit('wall', [[x, yt, zb + tb], [x, yb, zb + tb], [x, yb, zb + ta], [x, yt, zb + ta]], [dir, 0, 0], { i0: i, i1: i, j0: j, j1: e - 1 });
      j = e;
    }
  }
}

// ---------- ruins: jagged tops/edges and holes ----------
function ruinOpts(a, PH, res, defEdges) {
  if (!a.broken) return null;
  const b = a.broken === true ? {} : a.broken;
  return { amount: Number(b.amount ?? Math.max(res * 2, Math.round(PH * 0.35))), step: Math.max(1, Number(b.step ?? Math.max(res, 4))), seed: Number(b.seed ?? 1), edges: b.edges || defEdges };
}
/** Piecewise-linear jagged drop along an edge: random knots every `step` px (sharp, not blocky). */
const jagLine = (r, edge) => (pos) => {
  const k = pos / r.step, i = Math.floor(k), t = k - i;
  const h = (j) => hash3(j, edge.charCodeAt(0) * 7 + edge.length, r.seed) * r.amount;
  return h(i) * (1 - t) + h(i + 1) * t;
};
/** Bilinear coverage (0..1) of a mask canvas stretched over a PW x PH plane (cy up). */
function maskSampler(mask, PW, PH) {
  const { width: mw, height: mh, data } = mask;
  const at = (x, y) => (x < 0 || y < 0 || x >= mw || y >= mh ? 0 : data[(y * mw + x) * 4 + 3] / 255);
  return (cx, cy) => {
    const u = (cx / PW) * mw - 0.5, v = ((PH - cy) / PH) * mh - 0.5;
    const x0 = Math.floor(u), y0 = Math.floor(v), fx = u - x0, fy = v - y0;
    const cl = (x, y) => at(Math.max(0, Math.min(mw - 1, x)), Math.max(0, Math.min(mh - 1, y)));
    return (cl(x0, y0) * (1 - fx) + cl(x0 + 1, y0) * fx) * (1 - fy) + (cl(x0, y0 + 1) * (1 - fx) + cl(x0 + 1, y0 + 1) * fx) * fy;
  };
}
/**
 * Smooth ruined outline: signed field = min(base shape, jagged edges, mask holes) -> marching
 * squares (sample step `res` px, default 1) -> Douglas-Peucker -> shapes with holes.
 * base(x, y): signed distance, x centred (-PW/2..PW/2), y up (0..PH).
 */
function ruinShapes(a, ctx, PW, PH, base, defEdges) {
  const g0 = Math.max(0.25, Number(a.res ?? 1));
  const r = ruinOpts(a, PH, 4, defEdges);
  const jag = r ? Object.fromEntries(['top', 'bottom', 'left', 'right'].map((e) => [e, jagLine(r, e)])) : null;
  const hole = a.holes ? maskSampler(ctx.tex(a.holes), PW, PH) : null;
  const texel = a.holes ? PW / ctx.tex(a.holes).width : 1;
  const f = (x, y) => {
    let v = base(x, y);
    if (r) {
      const e = r.edges, cx = x + PW / 2;
      if (e.includes('top')) v = Math.min(v, PH - jag.top(cx) - y);
      if (e.includes('bottom')) v = Math.min(v, y - jag.bottom(cx));
      if (e.includes('left')) v = Math.min(v, cx - jag.left(y));
      if (e.includes('right')) v = Math.min(v, PW - cx - jag.right(y));
    }
    if (hole) v = Math.min(v, (0.5 - hole(x + PW / 2, y)) * texel);
    return v;
  };
  let gx = PW / Math.max(1, Math.round(PW / g0)), gy = PH / Math.max(1, Math.round(PH / g0));
  while ((PW / gx + 3) * (PH / gy + 3) > 400000) { gx *= 2; gy *= 2; }
  const nx = Math.round(PW / gx) + 2, ny = Math.round(PH / gy) + 2;
  const tol = Number(a.simplify ?? 0.35 * Math.max(gx, gy));
  const loops = contour(f, -PW / 2 - gx, -gy, nx, ny, gx, gy).map((l) => dropCollinear(simplifyLoop(l, tol))).filter((l) => l.length >= 3);
  return nestLoops(loops);
}
/** Remove points lying on the line through their neighbours (they would leave T-junctions / slivers). */
function dropCollinear(loop) {
  let pts = loop, changed = true;
  while (changed && pts.length > 3) {
    changed = false;
    for (let i = 0; i < pts.length && pts.length > 3; i++) {
      const a = pts[(i + pts.length - 1) % pts.length], b = pts[i], c = pts[(i + 1) % pts.length];
      const cr = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
      if (Math.abs(cr) < 1e-6 * Math.max(1, Math.hypot(c[0] - a[0], c[1] - a[1]))) { pts = pts.filter((_, k) => k !== i); changed = true; break; }
    }
  }
  return pts;
}
const rectSDF = (PW, PH) => (x, y) => Math.min(x + PW / 2, PW / 2 - x, y, PH - y);

/** Voxelised slab (style:"voxel"): PW x PH plane, thickness centred on z, cell size res. */
function slab(m, PW, PH, thick, res, solid, ft, place, placeN) {
  const ni = Math.ceil(PW / res), nj = Math.ceil(PH / res);
  const grid = new Uint8Array(ni * nj);
  for (let j = 0; j < nj; j++) for (let i = 0; i < ni; i++) {
    const cx = Math.min(PW, (i + 0.5) * res), cy = PH - Math.min(PH, (j + 0.5) * res);
    grid[j * ni + i] = solid(cx, cy) ? 1 : 0;
  }
  const rect = (i0, i1, j0, j1) => [-PW / 2 + i0 * res, -PW / 2 + Math.min(PW, (i1 + 1) * res), PH - j0 * res, Math.max(0, PH - (j1 + 1) * res)];
  voxelMesh(ni, nj, (i, j) => (grid[j * ni + i] ? thick : 0), rect, -thick / 2, (kind, P, n) => {
    const P2 = P.map(place), n2 = placeN(n), t = ft(n2);
    m.face(t, P2, n2, uvFace(P2, n2, t, true), null, 1);
  });
}
function voxelSolid(a, ctx, PW, PH, res, base, defEdges) {
  const r = ruinOpts(a, PH, res, defEdges);
  const hole = a.holes ? maskSampler(ctx.tex(a.holes), PW, PH) : null;
  const q = (v) => Math.floor(v / res) * res;
  const drop = (edge, p) => q(hash3(Math.floor(p / r.step), edge.charCodeAt(0), r.seed) * r.amount);
  return (cx, cy) => {
    if (!base(cx, cy)) return false;
    if (r) {
      const e = r.edges;
      if (e.includes('top') && cy > PH - drop('top', cx)) return false;
      if (e.includes('bottom') && cy < drop('bottom', cx)) return false;
      if (e.includes('left') && cx < drop('left', cy)) return false;
      if (e.includes('right') && cx > PW - drop('right', cy)) return false;
    }
    return !(hole && hole(cx, cy) >= 0.5);
  };
}
const XY = [(p) => p, (n) => n];
// plane XY -> floor XZ: plane y (up) -> -z (back), thickness z -> y
const toXZ = (yOff, d) => [(p) => [p[0], p[2] + yOff, d / 2 - p[1]], (n) => [n[0], n[2], -n[1]]];

// ---------- arch outlines ----------
/** One side of a two-centred (pointed) arch: from (cx - r, cy) up to the apex at x = 0. */
function archSide(cx, cy, r, segs) {
  const ca = Math.max(-1, Math.min(1, -cx / r)), pa = Math.acos(ca), out = [];
  for (let k = 0; k <= segs; k++) { const p = Math.PI + ((pa - Math.PI) * k) / segs; out.push([cx + r * Math.cos(p), cy + r * Math.sin(p)]); }
  return out;
}
/** Opening curve left jamb -> apex -> right jamb (offset t widens it, same centres). */
function archCurve(span, spring, point, segs, t = 0) {
  const R = Math.max(0.5, point) * span, cx = -span / 2 + R;
  const left = archSide(cx, spring, R + t, segs);
  const right = left.slice(0, -1).reverse().map(([x, y]) => [-x, y]);
  return [...left, ...right];
}
/** Segments per arch side follow the arc length (~one per 3 px), unless given. */
function archDims(a) {
  const span = Number(a.span ?? 16), point = Number(a.point ?? 1);
  const R = Math.max(0.5, point) * span, cx = -span / 2 + R;
  const arc = R * (Math.PI - Math.acos(Math.max(-1, Math.min(1, -cx / R))));
  const segs = Math.max(2, Math.round(Number(a.segments ?? Math.min(32, Math.max(3, Math.ceil(arc / 3))))));
  return { span, point, segs, rise: Math.sqrt(Math.max(0, R * R - cx * cx)) };
}

// ---------- builders ----------
const num = (v, d, name) => {
  const x = Number(v ?? d);
  if (!Number.isFinite(x)) throw new Error(`"${name}" must be a number`);
  return x;
};
const pos = (v, d, name) => { const x = num(v, d, name); if (x <= 0) throw new Error(`"${name}" must be > 0`); return x; };

function imageRef(a) {
  if (a.canvas) return { canvas: a.canvas, frame: a.frame, layer: a.layer, region: a.region, overlay: a.overlay };
  if (a.texture) return a.texture;
  throw new Error('needs "canvas" (the pixel art to use)');
}

/** Extrude an image: alpha-mask quads front/back + silhouette walls (edge texel colours). depth_map / mode voxel = relief. */
function extrude(a, ctx) {
  const tex = ctx.tex(imageRef(a));
  const { width: W, height: H, data } = tex;
  const thr = Number(a.alpha_threshold ?? 128);
  const solid = (x, y) => x >= 0 && y >= 0 && x < W && y < H && data[(y * W + x) * 4 + 3] >= thr;
  const D = pos(a.depth, 4, 'depth');
  const [px, py] = a.pivot || tex.pivot || [W / 2, H];
  const zb = a.center === false ? 0 : -D / 2;
  const m = new Mesh();
  const uvOf = (p) => [(p[0] + px) / W, (py - p[1]) / H];
  const rect = (i0, i1, j0, j1) => [i0 - px, i1 + 1 - px, py - j0, py - j1 - 1];
  const emit = (kind, P, n, c) => {
    let uv = P.map(uvOf);
    if (kind === 'wall') {
      const e = 1e-3;
      if (n[1]) uv = uv.map(([u]) => [Math.min((c.i1 + 1 - e) / W, Math.max((c.i0 + e) / W, u)), (c.j0 + 0.5) / H]);
      else uv = uv.map(([, v]) => [(c.i0 + 0.5) / W, Math.min((c.j1 + 1 - e) / H, Math.max((c.j0 + e) / H, v))]);
    }
    m.face(tex, P, n, uv);
  };
  const voxel = a.depth_map || a.mode === 'voxel';
  let hs;
  if (a.depth_map) {
    const dm = ctx.tex(a.depth_map), minD = Math.max(0.25, Number(a.min_depth ?? 1));
    hs = new Float32Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      if (!solid(x, y)) continue;
      const dx = Math.min(dm.width - 1, Math.floor(((x + 0.5) * dm.width) / W)), dy = Math.min(dm.height - 1, Math.floor(((y + 0.5) * dm.height) / H));
      const p = (dy * dm.width + dx) * 4;
      let l = dm.data[p + 3] ? (0.2126 * dm.data[p] + 0.7152 * dm.data[p + 1] + 0.0722 * dm.data[p + 2]) / 255 : 0;
      if (a.invert) l = 1 - l;
      const steps = a.levels ? Math.max(1, Number(a.levels)) : D;
      hs[y * W + x] = Math.max(minD, (Math.round(l * steps) / steps) * D);
    }
  }
  const h = (i, j) => (hs ? hs[j * W + i] : solid(i, j) ? D : 0);
  voxelMesh(W, H, h, rect, zb, emit, !!voxel);
  if (!voxel) {
    let x0 = W, x1 = -1, y0 = H, y1 = -1;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (solid(x, y)) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    if (x1 < 0) throw new Error(`canvas "${tex.canvas || tex.key}" has no opaque pixels to extrude`);
    for (const [z, n] of [[zb + D, [0, 0, 1]], [zb, [0, 0, -1]]]) {
      const P = [[x0 - px, py - y0, z], [x1 + 1 - px, py - y0, z], [x1 + 1 - px, py - y1 - 1, z], [x0 - px, py - y1 - 1, z]];
      m.face(tex, P, n, P.map(uvOf));
    }
  }
  return m;
}

/** Revolve the right-half silhouette of a canvas (around x = axis) into a round solid. */
function lathe(a, ctx) {
  const prof = ctx.tex(a.canvas ? imageRef(a) : a.profile ?? imageRef(a));
  const { width: W, height: H, data } = prof;
  const axis = num(a.axis, 0, 'axis'), N = Math.max(3, Math.min(128, Math.round(num(a.segments, 12, 'segments'))));
  const r = [];
  for (let y = 0; y < H; y++) { let rr = 0; for (let x = W - 1; x >= axis; x--) if (data[(y * W + x) * 4 + 3] >= 128) { rr = x + 1 - axis; break; } r.push(rr); }
  if (!r.some((v) => v > 0)) throw new Error(`lathe: no opaque pixels right of axis x=${axis}`);
  const py = (a.pivot || prof.pivot)?.[1] ?? H;
  const Y = (y) => py - y;
  const side = a.texture ? ctx.tex(a.texture) : null, capT = a.cap ? ctx.tex(a.cap) : side;
  const rmax = Math.max(...r);
  const wrap = side ? Number(a.wrap ?? Math.max(1, Math.round((2 * Math.PI * rmax) / side.width))) : 1;
  const eps = 1e-3;
  // profile polyline per opaque run of rows (axis -> outline -> axis), simplified before revolving:
  // collinear merge + Douglas-Peucker (simplify px, default 0.75; 0 = exact pixel steps), so a
  // one-pixel-per-row slope becomes one cone band instead of one ring per row
  const tol = Math.max(0, num(a.simplify, 0.75, 'simplify'));
  const segs = [];
  for (let y = 0; y < H;) {
    if (!r[y]) { y++; continue; }
    let yb = y;
    while (yb + 1 < H && r[yb + 1]) yb++;
    const ya = y;
    const pts = [[0, Y(ya)], [r[ya], Y(ya)]];
    if (a.smooth) {
      for (let k = ya; k <= yb; k++) if (k === ya || k === yb || r[k] !== r[k - 1] || r[k] !== r[k + 1]) pts.push([r[k], Y(k) - 0.5]);
    } else {
      for (let k = ya; k <= yb;) {
        let e = k;
        while (e + 1 <= yb && r[e + 1] === r[k]) e++;
        pts.push([r[k], Y(e + 1)]);
        if (e + 1 <= yb) pts.push([r[e + 1], Y(e + 1)]);
        k = e + 1;
      }
    }
    pts.push([r[yb], Y(yb + 1)], [0, Y(yb + 1)]);
    const path = simplifyPath(pts, tol);
    // texture row (v) of a point: flat steps take the wider of the two rows they separate
    const rowAt = (yy) => py - yy;
    for (let k = 0; k + 1 < path.length; k++) {
      const [r0, y0] = path[k], [r1, y1] = path[k + 1];
      let v0, v1;
      if (Math.abs(y0 - y1) < 1e-9) {
        const bnd = Math.round(rowAt(y0));
        const up = Math.max(ya, Math.min(yb, bnd - 1)), dn = Math.max(ya, Math.min(yb, bnd));
        const row = r[up] >= r[dn] ? up : dn;
        v0 = v1 = (row + 0.5) / H;
      } else {
        const cl = (v) => Math.max(ya + eps, Math.min(yb + 1 - eps, v)) / H;
        v0 = cl(rowAt(y0)); v1 = cl(rowAt(y1));
      }
      segs.push({ r0, y0, r1, y1, v0, v1 });
    }
    y = yb + 1;
  }
  const m = new Mesh();
  for (const s of segs) {
    if (!s.r0 && !s.r1) continue;
    const [nR, nY] = (() => { const dR = s.r1 - s.r0, dY = s.y1 - s.y0, l = Math.hypot(dR, dY) || 1; return [-dY / l, dR / l]; })();
    const flat = s.y0 === s.y1;
    const tex = side ? (flat ? capT : side) : prof;
    const mode = side ? (flat ? 1 : 2) : 0;
    const vert = (rr, yy, vv, j) => {
      const th = (2 * Math.PI * j) / N, sn = Math.sin(th), c = Math.cos(th);
      const p = [rr * sn, yy, rr * c];
      let uv;
      if (!side) uv = [(axis + 0.5 + Math.max(0, rr - 1) * Math.abs(sn)) / W, vv];
      else if (flat) uv = [p[0] / capT.width, p[2] / capT.height];
      else uv = [(wrap * j) / N, -yy / side.height];
      return { p, n: [nR * sn, nY, nR * c], uv };
    };
    for (let j = 0; j < N; j++) {
      const q = [vert(s.r0, s.y0, s.v0, j), vert(s.r0, s.y0, s.v0, j + 1), vert(s.r1, s.y1, s.v1, j + 1), vert(s.r1, s.y1, s.v1, j)];
      const tm = (2 * Math.PI * (j + 0.5)) / N;
      m.face(tex, q.map((v) => v.p), q.map((v) => v.n), q.map((v) => v.uv), [nR * Math.sin(tm), nY, nR * Math.cos(tm)], mode);
    }
  }
  return m;
}

function texSize(a, ctx) {
  const ref = a.texture ?? a.faces?.front;
  if (!ref || (typeof ref === 'string' && ref.startsWith('#')) || ref.color) return null;
  const t = ctx.tex(ref);
  return t.ctm ? { width: t.ctm.tile, height: t.ctm.tile } : t;
}
const isVoxel = (a) => a.style === 'voxel' || a.voxel === true;

/** Box-like kit pieces: box, wall, floor/slab, ledge. Ruins (broken/holes) = smooth polygon outlines. */
function block(defaults) {
  return (a, ctx) => {
    const t = defaults.fromTexture ? texSize(a, ctx) : null;
    const w = pos(a.w, defaults.w ?? t?.width ?? 16, 'w'), h = pos(a.h, defaults.h ?? t?.height ?? 16, 'h'), d = pos(a.d, defaults.d ?? t?.width ?? 16, 'd');
    const ft = faceTexer(a, ctx, defaults.color);
    const y0 = defaults.topAtZero ? -h : 0;
    const m = new Mesh();
    if (!a.broken && !a.holes) { boxFaces(m, [-w / 2, y0, -d / 2], [w / 2, y0 + h, d / 2], ft, a.tile !== false); return m; }
    const plane = a.plane ?? (h <= d && h <= w ? 'xz' : 'xy');
    const [PW, PH, thick, edges] = plane === 'xz' ? [w, d, h, ['top', 'bottom', 'left', 'right']] : [w, h, d, ['top']];
    const [fp, fn] = plane === 'xz' ? toXZ(y0 + h / 2, d) : [(p) => [p[0], p[1] + y0, p[2]], XY[1]];
    if (isVoxel(a)) {
      const res = pos(a.res, 4, 'res');
      slab(m, PW, PH, thick, res, voxelSolid(a, ctx, PW, PH, res, () => true, edges), ft, fp, fn);
      return m;
    }
    const shapes = ruinShapes(a, ctx, PW, PH, rectSDF(PW, PH), edges);
    const tmp = prismShapes(new Mesh(), shapes, -thick / 2, thick / 2, (nl) => ft(fn(nl)), true);
    return m.add(tmp.map(fp, fn));
  };
}

function cylinder(a, ctx) {
  const t0 = texSize(a, ctx);
  const R = pos(a.r ?? a.radius, t0 ? t0.width / (2 * Math.PI) : 8, 'r'), h = pos(a.h, t0?.height ?? 16, 'h');
  const N = Math.max(3, Math.round(num(a.segments, 12, 'segments')));
  const flat = a.flat ?? N <= 8, tile = a.tile !== false;
  const sideT = ctx.tex(a.side ?? a.texture ?? a.color ?? '#8a8a94');
  const topT = ctx.tex(a.top ?? a.cap ?? a.texture ?? a.color ?? '#8a8a94'), botT = ctx.tex(a.bottom ?? a.cap ?? a.texture ?? a.color ?? '#8a8a94');
  const y0 = a.center ? -h / 2 : 0, y1 = y0 + h;
  const m = new Mesh();
  const at = (j) => { const th = (2 * Math.PI * j) / N; return [Math.sin(th), Math.cos(th)]; };
  const circ = 2 * Math.PI * R;
  for (let j = 0; j < N; j++) {
    const [s0, c0] = at(j), [s1, c1] = at(j + 1), [sm, cm] = at(j + 0.5);
    const P = [[R * s0, y1, R * c0], [R * s1, y1, R * c1], [R * s1, y0, R * c1], [R * s0, y0, R * c0]];
    const N4 = flat ? [sm, 0, cm] : [[s0, 0, c0], [s1, 0, c1], [s1, 0, c1], [s0, 0, c0]];
    const u0 = tile ? (circ * j) / N / sideT.width : j / N, u1 = tile ? (circ * (j + 1)) / N / sideT.width : (j + 1) / N;
    const v0 = tile ? -y1 / sideT.height : 0, v1 = tile ? -y0 / sideT.height : 1;
    // flat facets tile like walls (mode 1); smooth sides unwrap u and take v from the world (mode 2)
    m.face(sideT, P, N4, [[u0, v0], [u1, v0], [u1, v1], [u0, v1]], [sm, 0, cm], tile ? (flat ? 1 : 2) : 0);
  }
  for (const [y, n, t] of [[y1, [0, 1, 0], topT], [y0, [0, -1, 0], botT]]) {
    const P = [...Array(N).keys()].map((j) => { const [s, c] = at(j); return [R * s, y, R * c]; });
    const uv = tile ? uvFace(P, n, t, true) : P.map((p) => [p[0] / (2 * R) + 0.5, (n[1] > 0 ? p[2] : -p[2]) / (2 * R) + 0.5]);
    m.polygon(t, P, n, uv, [...Array(N - 2).keys()].map((k) => [0, k + 1, k + 2]), tile ? 1 : 0);
  }
  return m;
}

function plane(a, ctx) {
  const img = a.texture ?? a.canvas;
  const t = ctx.tex(img ?? a.color ?? '#8a8a94');
  const w = pos(a.w, img ? t.width : 32, 'w'), h = pos(a.h, img ? t.height : 32, 'h');
  const up = a.facing === 'up';
  const P = up ? [[-w / 2, 0, -h / 2], [w / 2, 0, -h / 2], [w / 2, 0, h / 2], [-w / 2, 0, h / 2]] : [[-w / 2, h, 0], [w / 2, h, 0], [w / 2, 0, 0], [-w / 2, 0, 0]];
  const n = up ? [0, 1, 0] : [0, 0, 1];
  const uv = a.tile ? uvFace(P, n, t, true) : [[0, 0], [1, 0], [1, 1], [0, 1]];
  const m = new Mesh();
  m.face(t, P, n, uv, null, a.tile ? 1 : 0);
  if (a.double_sided) m.face(t, P, n.map((v) => -v), uv, null, a.tile ? 1 : 0); // back shows the mirrored image, like a card
  return m;
}

/** Gothic (pointed) arch: frame (wall with an arched opening), solid panel, or ring (vault rib). */
function arch(a, ctx) {
  const { span, point, segs, rise } = archDims(a);
  const kind = a.style ?? (a.solid ? 'solid' : 'frame');
  const spring = num(a.spring, kind === 'ring' ? 0 : span * 0.75, 'spring');
  const border = num(a.border, Math.max(4, Math.round(span / 4)), 'border');
  const w = pos(a.w, span + 2 * border, 'w'), d = pos(a.d, 8, 'd');
  const apex = spring + rise;
  const h = pos(a.h, Math.ceil(apex + border), 'h');
  const curve = archCurve(span, spring, point, segs);
  let poly;
  if (kind === 'solid') poly = [[-span / 2, 0], [span / 2, 0], ...curve.slice().reverse()];
  else if (kind === 'ring') {
    const outer = archCurve(span, spring, point, segs, border);
    poly = [[-span / 2, 0], ...curve, [span / 2, 0], [span / 2 + border, 0], ...outer.slice().reverse(), [-span / 2 - border, 0]];
  } else {
    if (w <= span) throw new Error(`arch: w (${w}) must be wider than span (${span})`);
    if (h <= apex) throw new Error(`arch: h (${h}) must be above the apex (${apex.toFixed(1)}); raise h or lower spring/span`);
    poly = [[-w / 2, 0], [-span / 2, 0], ...curve, [span / 2, 0], [w / 2, 0], [w / 2, h], [-w / 2, h]];
  }
  poly = poly.filter((p, i) => { const q = poly[(i + poly.length - 1) % poly.length]; return Math.hypot(p[0] - q[0], p[1] - q[1]) > 1e-6; });
  const ft = faceTexer(a, ctx, '#9a948a');
  const m = new Mesh();
  if (a.broken || a.holes) {
    const xs = poly.map((p) => p[0]), ys = poly.map((p) => p[1]);
    const PW = 2 * Math.max(...xs.map(Math.abs)), PH = Math.max(...ys);
    if (isVoxel(a) || a.voxel) {
      const res = pos(a.res, 2, 'res');
      slab(m, PW, PH, d, res, voxelSolid(a, ctx, PW, PH, res, (cx, cy) => pointInPoly(poly, cx - PW / 2, cy), ['top']), ft, XY[0], XY[1]);
    } else prismShapes(m, ruinShapes(a, ctx, PW, PH, polySDF(poly), ['top']), -d / 2, d / 2, ft, true);
  } else prism(m, poly, -d / 2, d / 2, ft, a.tile !== false);
  return m;
}

/** Barrel/pointed vault: an arch ring extruded along its length d. */
function vault(a, ctx) {
  return arch({ span: 64, border: 8, d: 32, point: 1, ...a, style: 'ring' }, ctx);
}

// polygon (a, b) -> world (x = extrusion, y = b, z = a): rotation, keeps outward normals
const sideways = [(p) => [-p[2], p[1], p[0]], (n) => [-n[2], n[1], n[0]]];

function stairs(a, ctx) {
  const n = Math.max(1, Math.round(num(a.steps, 4, 'steps'))), rise = pos(a.rise ?? a.step_h, 8, 'rise'), run = pos(a.run ?? a.step_d, 8, 'run'), w = pos(a.w, 32, 'w');
  const D = n * run;
  const poly = [[-D / 2, 0], [D / 2, 0]];
  for (let i = 0; i < n; i++) poly.push([D / 2 - i * run, (i + 1) * rise], [D / 2 - (i + 1) * run, (i + 1) * rise]);
  const ft = faceTexer(a, ctx, '#8a8a94', { top: a.tread ?? a.faces?.top ?? a.top, front: a.riser ?? a.faces?.front ?? a.front });
  return sidePrism(poly, w, ft, a);
}
/** Polygon in (z, y) extruded along x by w; textures picked on world normals. */
function sidePrism(poly, w, ft, a) {
  const [fp, fn] = sideways;
  return prism(new Mesh(), poly, -w / 2, w / 2, (nl) => ft(fn(nl)), a.tile !== false).map(fp, fn);
}
/** Polygon in (x, z) extruded up from y = 0 to h. */
function floorPrism(poly, h, ft, a) {
  const fp = (p) => [p[0], p[2], -p[1]];
  return prism(new Mesh(), poly.map(([x, z]) => [Number(x), -Number(z)]), 0, h, (nl) => ft(fp(nl)), a.tile !== false).map(fp, fp);
}

/** Gable (or shed) roof: ridge along x. */
function roof(a, ctx) {
  const w = pos(a.w, 32, 'w'), d = pos(a.d, 32, 'd'), h = pos(a.h, 16, 'h');
  const poly = a.style === 'shed' ? [[-d / 2, 0], [d / 2, 0], [-d / 2, h]] : [[-d / 2, 0], [d / 2, 0], [0, h]];
  const ft = faceTexer(a, ctx, '#6a4a3a');
  return sidePrism(poly, w, (n) => (Math.abs(n[0]) > 0.7 ? ft([n[0], 0, 0]) : n[1] < -0.7 ? ft(n) : ft([0, 1, 0])), a);
}

/** L-shaped wall corner covering one cell: arms along the back (-z) and left (-x) edges. */
function corner(a, ctx) {
  const w = pos(a.w, 32, 'w'), h = pos(a.h, 64, 'h'), d = pos(a.d, 8, 'd');
  const s = w / 2;
  const poly = [[-s, -s], [s, -s], [s, -s + d], [-s + d, -s + d], [-s + d, s], [-s, s]]; // (x, z)
  return floorPrism(poly, h, faceTexer(a, ctx, '#9a948a'), a);
}

/** Pillar (square) / column (round): shaft + optional base and capital blocks. */
function pillar(round) {
  return (a, ctx) => {
    const w = pos(a.w, 12, 'w'), h = pos(a.h, 64, 'h');
    const base = num(a.base, 4, 'base'), cap = num(a.cap_h ?? a.capital, 4, 'capital'), flare = num(a.flare, 2, 'flare');
    const ft = faceTexer(a, ctx, '#9a948a');
    const m = new Mesh();
    const bw = w + 2 * flare;
    if (base > 0) boxFaces(m, [-bw / 2, 0, -bw / 2], [bw / 2, base, bw / 2], ft);
    if (cap > 0) boxFaces(m, [-bw / 2, h - cap, -bw / 2], [bw / 2, h, bw / 2], ft);
    const sh = h - Math.max(0, base) - Math.max(0, cap);
    if (round) {
      const c = cylinder({ r: w / 2, h: sh, segments: a.segments ?? 8, flat: a.flat, side: a.side ?? a.texture, cap: a.cap ?? a.texture, color: a.color ?? '#9a948a', texture: a.texture }, ctx);
      m.add(c.transform(mT(0, Math.max(0, base), 0)));
    } else boxFaces(m, [-w / 2, Math.max(0, base), -w / 2], [w / 2, h - Math.max(0, cap), w / 2], ft);
    return m;
  };
}

/** Balustrade: base rail, top rail and balusters (prisms, or lathed from a baluster canvas). */
function balustrade(a, ctx) {
  const w = pos(a.w, 32, 'w'), h = pos(a.h, 16, 'h'), d = pos(a.d, 6, 'd');
  const rail = pos(a.rail, 3, 'rail'), count = Math.max(1, Math.round(num(a.count, Math.max(1, Math.round(w / 8)), 'count')));
  const ft = faceTexer(a, ctx, '#a8a296');
  const m = new Mesh();
  boxFaces(m, [-w / 2, 0, -d / 2], [w / 2, rail, d / 2], ft);
  boxFaces(m, [-w / 2, h - rail, -d / 2], [w / 2, h, d / 2], ft);
  const bh = h - 2 * rail;
  for (let i = 0; i < count; i++) {
    const x = -w / 2 + ((i + 0.5) * w) / count;
    const b = a.baluster
      ? lathe({ canvas: typeof a.baluster === 'string' ? a.baluster : a.baluster.canvas, segments: a.segments ?? 6, ...(typeof a.baluster === 'object' ? a.baluster : {}) }, ctx)
      : cylinder({ r: Math.min(d / 2 - 0.5, w / count / 3), h: bh, segments: a.segments ?? 6, texture: a.texture, color: a.color ?? '#a8a296' }, ctx);
    if (a.baluster) { const bb = b.bounds(); const sy = bh / Math.max(1e-6, bb.max[1] - bb.min[1]); b.transform(mS(1, sy, 1)).transform(mT(0, -bb.min[1] * sy, 0)); }
    m.add(b.transform(mT(x, rail, 0)));
  }
  return m;
}

/** Rubble: seeded scatter of low, rotated stone chunks on a w x d footprint. */
function rubble(a, ctx) {
  const w = pos(a.w, 32, 'w'), d = pos(a.d, 32, 'd');
  const count = Math.max(1, Math.min(400, Math.round(num(a.count, 8, 'count'))));
  const [smin, smax] = a.size ? [].concat(a.size, a.size).slice(0, 2).map(Number) : [3, 8];
  const rnd = mulberry32(Math.round(num(a.seed, 1, 'seed')) || 1);
  const ft = faceTexer(a, ctx, '#7a746c');
  const m = new Mesh();
  for (let k = 0; k < count; k++) {
    const sx = smin + rnd() * (smax - smin), sz = smin + rnd() * (smax - smin), sy = Math.max(1, (smin + rnd() * (smax - smin)) * Number(a.flatness ?? 0.6));
    const c = new Mesh();
    boxFaces(c, [-sx / 2, 0, -sz / 2], [sx / 2, sy, sz / 2], ft);
    const tilt = Number(a.tilt ?? 12);
    c.transform(matMul(mT((rnd() - 0.5) * (w - sx), -sy * 0.2 * rnd(), (rnd() - 0.5) * (d - sz)), matMul(mRY(rnd() * 360), matMul(mRX((rnd() - 0.5) * tilt), mRZ((rnd() - 0.5) * tilt)))));
    m.add(c);
  }
  return m;
}

/** Custom outline extruded: points [[x,y],...] px; plane "xy" (wall-like) or "xz" (floor-like). */
function shape(a, ctx) {
  if (!Array.isArray(a.points) || a.points.length < 3) throw new Error('shape needs points: [[x,y], ...] (3+ points, px)');
  const d = pos(a.d, 8, 'd'), ft = faceTexer(a, ctx);
  if (a.plane === 'xz') return floorPrism(a.points, d, ft, a);
  return prism(new Mesh(), a.points, -d / 2, d / 2, ft, a.tile !== false);
}

export const BUILDERS = {
  extrude, lathe, plane, cylinder, arch, vault, stairs, roof, corner, rubble, shape, balustrade,
  box: block({ fromTexture: true }),
  wall: block({ w: 32, h: 64, d: 8, color: '#9a948a' }),
  floor: block({ w: 32, h: 4, d: 32, color: '#6e6a62', topAtZero: true }),
  slab: block({ w: 32, h: 4, d: 32, color: '#6e6a62' }),
  ledge: block({ w: 32, h: 4, d: 12, color: '#a8a296' }),
  pillar: pillar(false),
  column: pillar(true),
};
BUILDERS.prism = (a, ctx) => cylinder({ segments: 6, flat: true, ...a }, ctx);

/** One-line signatures (art_help topic 3d + error hints). px units; ? = optional. */
export const PART_DOCS = {
  floor: 'w?:32,d?:32,h?:4 (top at y=0), texture|top|side|faces, broken? (eroded edges), holes?',
  wall: 'w?:32,h?:64,d?:8 (thickness), texture|faces{front,back,left,right,top}|side|top, broken?:{amount,step,seed}, holes?:<mask canvas>, res?:1 (outline sampling px), style?:"voxel" (blocky ruins)',
  corner: 'w?:32,h?:64,d?:8: L-shaped wall on the back+left cell edges',
  pillar: 'w?:12,h?:64,base?:4,capital?:4,flare?:2 (square)',
  column: 'same as pillar, round shaft (segments?:8)',
  arch: 'span?:16,spring?,point?:1 (1 gothic, 0.5 round),border?,w?,h?,d?:8,style?:frame|solid|ring,segments? (auto from size), broken?, holes?, voxel?',
  vault: 'span?:64,border?:8 (thickness),d?:32 (length),spring?:0,point?:1',
  stairs: 'steps?:4,rise?:8,run?:8,w?:32, tread?|riser?|side?|texture',
  ledge: 'w?:32,h?:4,d?:12 (box)',
  balustrade: 'w?:32,h?:16,d?:6,rail?:3,count?,baluster?:<profile canvas for lathe>',
  roof: 'w?:32 (ridge length),d?:32 (span),h?:16 (rise),style?:gable|shed, texture (slopes),side (gables)',
  rubble: 'w?:32,d?:32,count?:8,size?:[3,8],seed?,flatness?,tilt?',
  box: 'w,h,d (default texture size), texture|faces|top|side, tile?:true, broken?, holes?',
  cylinder: 'r?,h?,segments?:12,flat?,texture|side,cap|top|bottom, tile?:true',
  prism: 'cylinder with segments:6 flat',
  plane: 'texture,w?,h? (texture size), facing?:front|up, double_sided?, tile?',
  shape: 'points:[[x,y],...],d?:8,plane?:xy|xz, texture|faces',
  extrude: 'canvas,frame?,layer?,region?,depth?:4,center?:true, depth_map?:<canvas> (luminance = thickness, voxel relief), levels?, invert?, min_depth?:1, mode?:voxel',
  lathe: 'canvas (right-half profile),axis?:0,segments?:12,smooth?,simplify?:0.75 px (0 = exact pixel steps),texture?,wrap?,cap?',
  model: 'model:"<other model>" = place another model (layouts / dioramas)',
};
export const PART_TYPES = [...Object.keys(BUILDERS), 'model'];
export const PART_COMMON = 'at?:[x,y,z]|cell?:[gx,gy,gz]|turn?|rotate?|scale?|array?|overlays?:[{texture,where,map,scale,falloff,amount}]|ctm_tag?';

// ---------- world UVs (after placement) ----------
/** Recompute UVs of world-tiled faces from their final positions: seamless across pieces. */
export function worldUV(mesh) {
  for (const g of mesh.groups.values()) {
    if (!g.faces) continue;
    const W = g.tex.ctm ? g.tex.ctm.tile : g.tex.width, H = g.tex.ctm ? g.tex.ctm.tile : g.tex.height;
    for (const f of g.faces) {
      if (f.mode === 1) {
        const { t, b } = tileBasis(f.n);
        for (let v = f.v; v < f.v + f.vc; v++) {
          const p = [g.pos[v * 3], g.pos[v * 3 + 1], g.pos[v * 3 + 2]];
          g.uv[v * 2] = dot(p, t) / W; g.uv[v * 2 + 1] = -dot(p, b) / H;
        }
      } else if (f.mode === 2) for (let v = f.v; v < f.v + f.vc; v++) g.uv[v * 2 + 1] = -g.pos[v * 3 + 1] / H;
    }
  }
}

// ---------- overlays (grime, moss, blood, wear): decal shells with their own UV set ----------
const OV_WHERE = ['all', 'bottom', 'top', 'corners', 'edges'];
function normOverlay(o) {
  const s = typeof o === 'string' ? { texture: o } : { ...o };
  if (!s.texture) throw new Error('overlay needs texture: <canvas> (e.g. grime, moss, blood)');
  s.where = [].concat(s.where ?? 'all');
  for (const w of s.where) if (!OV_WHERE.includes(w)) throw new Error(`overlay where must be ${OV_WHERE.join('|')}`);
  s.map = s.map ?? 'world';
  if (!['world', 'face', 'piece', 'surface'].includes(s.map)) throw new Error('overlay map must be world|face|piece|surface');
  return s;
}
const nk = (n) => n.map((v) => Math.round(v * 1000)).join(',');
/** Smooth value noise (0..1) at a world position, period ~cell px. */
function vnoise(p, cell, seed) {
  const x = p[0] / cell, y = p[1] / cell, z = p[2] / cell;
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z), fx = x - xi, fy = y - yi, fz = z - zi;
  const h = (a, b, c) => hash3(a * 73856093 ^ c * 83492791, b, seed);
  const s = (t) => t * t * (3 - 2 * t);
  const l = (a, b, t) => a + (b - a) * s(t);
  return l(l(l(h(xi, yi, zi), h(xi + 1, yi, zi), fx), l(h(xi, yi + 1, zi), h(xi + 1, yi + 1, zi), fx), fy), l(l(h(xi, yi, zi + 1), h(xi + 1, yi, zi + 1), fx), l(h(xi, yi + 1, zi + 1), h(xi + 1, yi + 1, zi + 1), fx), fy), fz);
}
function applyOverlays(mesh, ctx) {
  const targets = mesh.faces.filter(({ f }) => f.ov && f.ov.length);
  if (!targets.length) return 0;
  // continuous surfaces (same plane) give the extents for bottom/top/corner/edge gradients
  const planes = new Map(), pieces = new Map();
  const pkey = (g, f) => { const p = [g.pos[f.v * 3], g.pos[f.v * 3 + 1], g.pos[f.v * 3 + 2]]; return `${nk(f.n)}|${Math.round(dot(p, f.n) * 100)}`; };
  for (const { g, f } of mesh.faces) {
    const { t, b } = tileBasis(f.n), k = pkey(g, f);
    let e = planes.get(k);
    if (!e) planes.set(k, (e = { s0: Infinity, s1: -Infinity, q0: Infinity, q1: -Infinity }));
    let pc = f.pid !== undefined ? pieces.get(f.pid) : null;
    if (f.pid !== undefined && !pc) pieces.set(f.pid, (pc = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] }));
    for (let v = f.v; v < f.v + f.vc; v++) {
      const p = [g.pos[v * 3], g.pos[v * 3 + 1], g.pos[v * 3 + 2]], s = dot(p, t), q = -dot(p, b);
      e.s0 = Math.min(e.s0, s); e.s1 = Math.max(e.s1, s); e.q0 = Math.min(e.q0, q); e.q1 = Math.max(e.q1, q);
      if (pc) for (let i = 0; i < 3; i++) { pc.min[i] = Math.min(pc.min[i], p[i]); pc.max[i] = Math.max(pc.max[i], p[i]); }
    }
  }
  const out = new Mesh();
  const ctmOv = [];
  let shells = 0;
  // faces pressed against an opposite face of a touching piece (wall ends in a run) are hidden
  const byPlane = new Map();
  for (const it of mesh.faces) { const k = pkey(it.g, it.f); if (!byPlane.has(k)) byPlane.set(k, []); byPlane.get(k).push(it); }
  const hidden = (g, f) => {
    const p0 = [g.pos[f.v * 3], g.pos[f.v * 3 + 1], g.pos[f.v * 3 + 2]];
    const opp = byPlane.get(`${nk(f.n.map((v) => -v))}|${Math.round(-dot(p0, f.n) * 100)}`);
    if (!opp) return false;
    const { t, b } = tileBasis(f.n), c = [0, 0];
    for (let v = f.v; v < f.v + f.vc; v++) { const p = [g.pos[v * 3], g.pos[v * 3 + 1], g.pos[v * 3 + 2]]; c[0] += dot(p, t) / f.vc; c[1] += dot(p, b) / f.vc; }
    return opp.some(({ g: g2, f: f2 }) => {
      for (let i = f2.i; i < f2.i + f2.ic; i += 3) {
        const P = [0, 1, 2].map((k) => { const v = g2.idx[i + k], p = [g2.pos[v * 3], g2.pos[v * 3 + 1], g2.pos[v * 3 + 2]]; return [dot(p, t), dot(p, b)]; });
        const d = [0, 1, 2].map((k) => { const A = P[k], B = P[(k + 1) % 3]; return (B[0] - A[0]) * (c[1] - A[1]) - (B[1] - A[1]) * (c[0] - A[0]); });
        if ((d[0] >= -1e-6 && d[1] >= -1e-6 && d[2] >= -1e-6) || (d[0] <= 1e-6 && d[1] <= 1e-6 && d[2] <= 1e-6)) return true;
      }
      return false;
    });
  };
  for (const { g, f } of targets) {
    if (hidden(g, f)) continue;
    const { t, b } = tileBasis(f.n);
    const ext = planes.get(pkey(g, f));
    const fe = { s0: Infinity, s1: -Infinity, q0: Infinity, q1: -Infinity };
    for (let v = f.v; v < f.v + f.vc; v++) { const p = [g.pos[v * 3], g.pos[v * 3 + 1], g.pos[v * 3 + 2]], s = dot(p, t), q = -dot(p, b); fe.s0 = Math.min(fe.s0, s); fe.s1 = Math.max(fe.s1, s); fe.q0 = Math.min(fe.q0, q); fe.q1 = Math.max(fe.q1, q); }
    for (const spec of f.ov) {
      const ot = ctx.tex(spec.texture);
      if (ot.ctm?.method === 'overlay') { ctmOv.push({ g, f, spec, ot }); continue; }
      const fall = Math.max(1, Number(spec.falloff ?? 24)), amount = Number(spec.amount ?? 1), jitter = Number(spec.jitter ?? 0.5), seed = Number(spec.seed ?? 1);
      // tessellation size: adaptive unless set (gradient need = falloff, plus face size); noise keeps
      // its own scale (noise:12 px). Uniform-strength triangles are never split (see split below).
      const faceSize = Math.max(fe.s1 - fe.s0, fe.q1 - fe.q0);
      const detail = spec.detail !== undefined ? Math.max(2, Number(spec.detail)) : Math.max(16, Math.min(64, Math.round(Math.max(fall, faceSize / 8))));
      const noiseCell = Math.max(6, Number(spec.noise ?? spec.detail ?? 12)), scl = Math.max(1e-3, Number(spec.scale ?? 1));
      const vertical = Math.abs(f.n[1]) < 0.7, up = f.n[1] > 0.7;
      // base strength (no noise): max of clamped linear ramps, so its maximum over a triangle sits on a vertex
      const weight0 = (p) => {
        const s = dot(p, t), q = -dot(p, b);
        let w = 0;
        for (const wh of spec.where) {
          if (wh === 'all') w = 1;
          else if (wh === 'bottom' && vertical) w = Math.max(w, 1 - (ext.q1 - q) / fall);
          else if (wh === 'top') w = Math.max(w, up ? 1 : vertical ? 1 - (q - ext.q0) / fall : 0);
          else if (wh === 'corners' && vertical) w = Math.max(w, 1 - Math.min(s - ext.s0, ext.s1 - s) / fall);
          else if (wh === 'edges') w = Math.max(w, 1 - Math.min(s - ext.s0, ext.s1 - s, q - ext.q0, ext.q1 - q) / fall);
        }
        return Math.max(0, Math.min(1, w)) * amount;
      };
      const weight = (p) => Math.max(0, Math.min(1, weight0(p) * (1 - jitter + 2 * jitter * vnoise(p, noiseCell, seed))));
      let box = fe;
      if (spec.map === 'surface') box = ext;
      else if (spec.map === 'piece' && pieces.has(f.pid)) {
        const pc = pieces.get(f.pid), cs = [];
        for (const x of [pc.min[0], pc.max[0]]) for (const y of [pc.min[1], pc.max[1]]) for (const z of [pc.min[2], pc.max[2]]) cs.push([dot([x, y, z], t), -dot([x, y, z], b)]);
        box = { s0: Math.min(...cs.map((c) => c[0])), s1: Math.max(...cs.map((c) => c[0])), q0: Math.min(...cs.map((c) => c[1])), q1: Math.max(...cs.map((c) => c[1])) };
      }
      const ouv = (p) => {
        const s = dot(p, t), q = -dot(p, b);
        if (spec.map === 'world') return [s / (ot.width * scl), q / (ot.height * scl)];
        return [(s - box.s0) / (box.s1 - box.s0 || 1), (q - box.q0) / (box.q1 - box.q0 || 1)];
      };
      const og = out.group(ot, true);
      const lift = Number(spec.lift ?? 0.25);
      const emit = (V) => {
        const al = V.map((v) => weight(v.p));
        if (Math.max(...al) < 0.2) return;
        const base = og.pos.length / 3;
        V.forEach((v, k) => {
          og.pos.push(v.p[0] + f.n[0] * lift, v.p[1] + f.n[1] * lift, v.p[2] + f.n[2] * lift);
          og.nrm.push(...f.n);
          og.uv.push(...ouv(v.p)); og.uv0.push(...v.uv); og.alpha.push(al[k]);
        });
        og.idx.push(base, base + 1, base + 2);
      };
      const split = (V, depth) => {
        const w0 = V.map((v) => weight0(v.p));
        if (Math.max(...w0) <= 0) return; // nothing on this triangle (exact: see weight0)
        const e = [[0, 1], [1, 2], [2, 0]].map(([i, j]) => [i, j, len(sub(V[i].p, V[j].p))]).sort((x, y) => y[2] - x[2])[0];
        // uniform strength over the triangle ("all", fully covered, or flat amount < 1): no split, the
        // noise only varies at the corners. Checked at the vertices, edge midpoints and centroid.
        const mid = (A, B) => A.p.map((x, c) => (x + B.p[c]) / 2);
        const probes = [mid(V[0], V[1]), mid(V[1], V[2]), mid(V[2], V[0]), V[0].p.map((x, c) => (x + V[1].p[c] + V[2].p[c]) / 3)].map(weight0);
        const uniform = spec.where.includes('all') || [...w0.slice(1), ...probes].every((w) => Math.abs(w - w0[0]) < 1e-6);
        if (uniform || e[2] <= detail || depth > 10) return emit(V);
        const [i, j] = e, k = 3 - i - j;
        const M = { p: V[i].p.map((x, c) => (x + V[j].p[c]) / 2), uv: [(V[i].uv[0] + V[j].uv[0]) / 2, (V[i].uv[1] + V[j].uv[1]) / 2] };
        split([V[i], M, V[k]], depth + 1); split([M, V[j], V[k]], depth + 1);
      };
      for (let i = f.i; i < f.i + f.ic; i += 3) {
        const V = [0, 1, 2].map((k) => { const v = g.idx[i + k]; return { p: [g.pos[v * 3], g.pos[v * 3 + 1], g.pos[v * 3 + 2]], uv: [g.uv[v * 2], g.uv[v * 2 + 1]] }; });
        // keep the source winding: the shell faces the same way as the face
        const c = cross(sub(V[1].p, V[0].p), sub(V[2].p, V[0].p));
        split(dot(c, f.n) >= 0 ? V : [V[0], V[2], V[1]], 0);
      }
      shells++;
    }
  }
  // CTM overlay tilesets: moss/blood/wax creeping in from neighbouring cells of another material
  if (ctmOv.length) {
    const byT = new Map();
    for (const it of ctmOv) { const T = it.ot.ctm.tile; if (!byT.has(T)) byT.set(T, []); byT.get(T).push(it); }
    const all = mesh.faces;
    for (const [T, items] of byT) {
      const idx = cellIndex(all, T, () => '*');
      const has = (c, from) => c && c.frags.some((fr) => fr.f.tag === from || fr.f.mat === from || fr.g.tex.ctm?.base === from);
      for (const c of idx.list) for (const fr of c.frags) for (const it of items) {
        if (fr.f !== it.f || has(c, it.spec.from)) continue;
        const m = idx.mask(c, (o) => has(o, it.spec.from));
        if (!m) continue;
        const k = ctmTileFor(m, 'overlay'), P = c.plane, og = out.group(it.ot, true), base = og.pos.length / 3, lift = 0.25;
        const poly = fr.poly;
        poly.forEach(([s, q, u0, v0]) => {
          og.pos.push(P.t[0] * s - P.b[0] * q + P.n[0] * (P.off + lift), P.t[1] * s - P.b[1] * q + P.n[1] * (P.off + lift), P.t[2] * s - P.b[2] * q + P.n[2] * (P.off + lift));
          og.nrm.push(...P.n); og.uv.push(...tileUV(it.ot.ctm, it.ot, k, s - c.cu * T, q - c.cv * T)); og.uv0.push(u0, v0); og.alpha.push(1);
        });
        for (let i = 1; i + 1 < poly.length; i++) {
          const A = poly[0], B = poly[i], C = poly[i + 1];
          // (s, q) is a left-handed frame on the face: counter-clockwise there = clockwise in world
          const ccw = (B[0] - A[0]) * (C[1] - A[1]) - (B[1] - A[1]) * (C[0] - A[0]) < 0;
          og.idx.push(base, base + (ccw ? i : i + 1), base + (ccw ? i + 1 : i));
        }
        shells++;
      }
    }
  }
  mesh.add(out);
  return shells;
}

/**
 * Bake world UVs, CTM tiles and overlay shells into a placed mesh (call once, after placement).
 * origin: world point of the texture / CTM cell lattice. Default [grid/2, 0, grid/2]: kit pieces
 * are centred on their cell, so tile edges land on piece edges (floor and wall seams).
 */
export function finalize(mesh, ctx, origin = [16, 0, 16]) {
  const O = vec3(origin);
  if (O.some((v) => v)) mesh.transform(mT(-O[0], -O[1], -O[2]));
  try { return finalizeAt(mesh, ctx); } finally { if (O.some((v) => v)) mesh.transform(mT(O[0], O[1], O[2])); }
}
function finalizeAt(mesh, ctx) {
  const add = new Mesh();
  const ctm = applyCTMEmit(mesh, add);
  if (ctm) {
    // rebuild groups without the replaced faces, then add the per-cell CTM faces
    for (const g of mesh.groups.values()) if (g.faces && g.faces.some((f) => ctm.drop.has(f))) rebuildGroup(g, ctm.drop);
    mesh.add(add);
  }
  worldUV(mesh);
  const shells = applyOverlays(mesh, ctx);
  return { ctm_cells: ctm ? ctm.cells : 0, overlay_shells: shells };
}
function applyCTMEmit(mesh, add) {
  return applyCTM(mesh, (tex, P, n, UV, src) => {
    const f = add.face(tex, P, n, UV, n, 0);
    for (const k of ['pid', 'tag', 'ov', 'mat']) if (src[k] !== undefined) f[k] = src[k];
    f.ctm = true;
  });
}
function rebuildGroup(g, drop) {
  const pos = [], nrm = [], uv = [], idx = [], faces = [];
  for (const f of g.faces) {
    if (drop.has(f)) continue;
    const base = pos.length / 3, i0 = idx.length;
    for (let v = f.v; v < f.v + f.vc; v++) { pos.push(g.pos[v * 3], g.pos[v * 3 + 1], g.pos[v * 3 + 2]); nrm.push(g.nrm[v * 3], g.nrm[v * 3 + 1], g.nrm[v * 3 + 2]); uv.push(g.uv[v * 2], g.uv[v * 2 + 1]); }
    for (let i = f.i; i < f.i + f.ic; i++) idx.push(g.idx[i] - f.v + base);
    faces.push({ ...f, v: base, i: i0 });
  }
  Object.assign(g, { pos, nrm, uv, idx, faces });
}

// ---------- transforms + assembly ----------
const vec3 = (v, d = 0) => (v === undefined || v === null ? [d, d, d] : typeof v === 'number' ? [v, v, v] : [Number(v[0] ?? d), Number(v[1] ?? d), Number(v[2] ?? d)]);

/** at (px) + cell * grid, turn (90° steps about y), rotate [x,y,z] degrees (X then Y then Z), scale. */
export function partMatrix(p, grid = 32) {
  const t = p.transform || {};
  const at = vec3(t.translate ?? t.at ?? p.at), cell = vec3(t.cell ?? p.cell), rot = vec3(t.rotate ?? p.rotate), sc = vec3(t.scale ?? p.scale, 1);
  const turn = Number(t.turn ?? p.turn ?? 0);
  let M = mS(...sc);
  M = matMul(mRX(rot[0]), M); M = matMul(mRY(rot[1]), M); M = matMul(mRZ(rot[2]), M);
  if (turn) M = matMul(mRY(turn * 90), M);
  return matMul(mT(at[0] + cell[0] * grid, at[1] + cell[1] * grid, at[2] + cell[2] * grid), M);
}
function arrayMatrices(p, M, grid) {
  const arr = p.array;
  if (!arr) return [M];
  const count = Math.max(1, Math.min(1000, Math.round(Number(arr.count ?? 2))));
  const step = vec3(arr.step), cstep = vec3(arr.cell_step), rot = vec3(arr.rotate), turn = Number(arr.turn ?? 0);
  const out = [];
  for (let k = 0; k < count; k++) {
    const R = matMul(mRY(turn * 90 * k), matMul(mRZ(rot[2] * k), matMul(mRY(rot[1] * k), mRX(rot[0] * k))));
    // copy k: rotated about its own origin (local), then stepped in world space
    out.push(matMul(mT((step[0] + cstep[0] * grid) * k, (step[1] + cstep[1] * grid) * k, (step[2] + cstep[2] * grid) * k), matMul(M, R)));
  }
  return out;
}

/** Translation applied to put the model origin at 0 (px). */
export function originShift(def, mesh, firstTex) {
  const o = def.origin ?? 'auto';
  if (Array.isArray(o)) return { mode: 'custom', shift: vec3(o).map((v) => -v) };
  // auto: keep part coordinates. Every builder already puts its origin at the canvas meta.pivot
  // (extrude/lathe) or bottom-centre (floor: top-centre), so grid placements survive export.
  const mode = o === 'auto' ? (firstTex?.pivot ? 'pivot' : 'parts') : o;
  if (mode === 'pivot' || mode === 'parts' || mode === 'none') return { mode, shift: [0, 0, 0] };
  const b = mesh.bounds();
  const c = [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
  if (mode === 'center') return { mode, shift: c.map((v) => -v) };
  if (mode === 'bottom') return { mode, shift: [-c[0], -b.min[1], -c[2]] };
  throw new Error('origin must be auto (keep part coordinates), bottom (recentre to bottom-centre), center, pivot or [x,y,z] px');
}

/**
 * Build a model definition -> { mesh (px, origin applied), parts:[{i,type,triangles}], origin,
 * instances:[{model, matrix, mesh}] when ctx.instances (model parts are then not merged), baked }.
 * ctx: { tex(ref), getModel(name), stack?, nested?, instances? }. Nested builds stay raw (no
 * world UV / CTM / overlays) so the top level bakes them with all neighbours in place.
 */
export function buildModel(def, ctx) {
  if (!Array.isArray(def.parts) || !def.parts.length) throw new Error('model needs parts: [{type:"wall", ...}, ...]');
  const grid = Number(def.grid ?? 32);
  const stack = ctx.stack || [];
  const ids = ctx.ids || (ctx.ids = { n: 0 });
  const mesh = new Mesh(), parts = [], instances = [], instMeshes = new Map();
  const modelOv = (def.overlays || []).map(normOverlay);
  let firstTex = null;
  def.parts.forEach((p, i) => {
    const type = p.type;
    try {
      if (!type) throw new Error(`missing "type" (one of ${PART_TYPES.join(', ')})`);
      if (p.hidden) { parts.push({ i, type, triangles: 0, hidden: true }); return; }
      const M = partMatrix(p, grid);
      const mats = arrayMatrices(p, M, grid);
      const partOv = p.overlays === false ? [] : (p.overlays || []).map(normOverlay);
      let local, tris = 0;
      if (type === 'model') {
        if (!p.model) throw new Error('needs model: "<name of another model>"');
        if (p.model === def.name || stack.includes(p.model)) throw new Error(`model "${p.model}" includes itself (${[...stack, p.model].join(' > ')})`);
        const sub = ctx.getModel(p.model);
        const subCtx = { ...ctx, stack: [...stack, def.name, p.model], instances: false, nested: true };
        if (ctx.instances && !ctx.nested) {
          if (!instMeshes.has(p.model)) {
            const built = buildModel(sub, subCtx).mesh;
            built.tagFaces({ ov: partOv.length || modelOv.length ? [...partOv, ...modelOv] : undefined });
            instMeshes.set(p.model, built);
          }
          const built = instMeshes.get(p.model);
          for (const mm of mats) instances.push({ model: p.model, matrix: mm, mesh: built });
          parts.push({ i, type, model: p.model, triangles: built.triangles * mats.length, copies: mats.length });
          return;
        }
        local = buildModel(sub, subCtx).mesh;
        if (partOv.length) for (const { f } of local.faces) f.ov = [...(f.ov || []), ...partOv];
      } else {
        const b = BUILDERS[type];
        if (!b) throw new Error(`unknown part type "${type}" (one of ${PART_TYPES.join(', ')})`);
        local = b(p, ctx);
        local.tagFaces({ pid: ids.n++, tag: p.ctm_tag ?? p.tag, ov: partOv.length ? partOv : undefined });
        if (!firstTex && (type === 'extrude' || type === 'lathe')) firstTex = ctx.tex(p.canvas ? imageRef(p) : p.profile ?? p.texture);
      }
      for (const [k, mm] of mats.entries()) {
        const c = mats.length > 1 ? local.clone() : local;
        if (k > 0 && type !== 'model') for (const { f } of c.faces) f.pid = ids.n++;
        c.transform(mm); mesh.add(c); tris += c.triangles;
      }
      parts.push({ i, type, triangles: tris, ...(mats.length > 1 ? { copies: mats.length } : {}) });
    } catch (e) {
      const sig = PART_DOCS[type];
      throw new Error(`part ${i} (${type}): ${e.message}${sig ? `\nusage: ${type} {${sig}} + ${PART_COMMON}` : ''}`);
    }
  });
  if (modelOv.length) for (const { f } of mesh.faces) f.ov = [...(f.ov || []), ...modelOv];
  let baked = null;
  if (!ctx.nested) {
    const uo = def.uv_origin ?? [grid / 2, 0, grid / 2];
    baked = finalize(mesh, ctx, uo);
    for (const m of instMeshes.values()) finalize(m, ctx, uo);
  }
  const all = instances.length ? instances.reduce((acc, it) => acc.add(it.mesh.clone().transform(it.matrix)), mesh.clone()) : mesh;
  const { mode, shift } = originShift(def, all, firstTex);
  if (shift.some((v) => v)) { mesh.transform(mT(...shift)); for (const it of instances) it.matrix = matMul(mT(...shift), it.matrix); }
  return { mesh, parts, origin: mode, instances, grid, baked };
}
export { normOverlay };
