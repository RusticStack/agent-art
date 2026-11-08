// Chunky low-poly rocks, boulders, asteroids, crystals, grass cards and rock formations (mesas,
// buttes, spires, arches) with pixel textures. Flat-shaded faces (PSX look), units = metres.
// Built as model3d Meshes, so #7's simplifyMesh makes their LODs.
import { Mesh } from '../model3d.js';
import { mulberry32 } from '../util.js';
import { perlin3, fractal, seedOf, vnorm, vdot, vcross, hexRGB, clamp01 } from './noise.js';

// ---------- icosphere ----------
function icosphere(sub) {
  const t = (1 + Math.sqrt(5)) / 2;
  let V = [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]].map(vnorm);
  let F = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8], [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]];
  for (let s = 0; s < sub; s++) {
    const mid = new Map(), NF = [];
    const m = (a, b) => { const k = a < b ? `${a},${b}` : `${b},${a}`; if (!mid.has(k)) { V.push(vnorm([(V[a][0] + V[b][0]) / 2, (V[a][1] + V[b][1]) / 2, (V[a][2] + V[b][2]) / 2])); mid.set(k, V.length - 1); } return mid.get(k); };
    for (const [a, b, c] of F) { const ab = m(a, b), bc = m(b, c), ca = m(c, a); NF.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]); }
    F = NF;
  }
  return { V, F };
}

/** Texture object for model3d / glb from a tile image. */
export function texOf(key, img, extra = {}) {
  return { key, name: key.replace(/[^\w.-]/g, '_'), width: img.width, height: img.height, data: img.data, ...(img.emissive ? { emissive: img.emissive } : {}), ...extra };
}
/** Box-projected UVs for a flat triangle (dominant normal axis), `world` metres per texture repeat. */
function boxUV(P, n, world) {
  const ax = Math.abs(n[0]), ay = Math.abs(n[1]), az = Math.abs(n[2]);
  return P.map((p) => (ay >= ax && ay >= az ? [p[0] / world, p[2] / world] : ax >= az ? [p[2] / world, -p[1] / world] : [p[0] / world, -p[1] / world]));
}
function flatTri(m, tex, A, B, C, world, outward) {
  let n = vnorm(vcross([B[0] - A[0], B[1] - A[1], B[2] - A[2]], [C[0] - A[0], C[1] - A[1], C[2] - A[2]]));
  if (outward && vdot(n, outward) < 0) n = n.map((v) => -v);
  if (!Number.isFinite(n[0])) return;
  m.face(tex, [A, B, C], n, boxUV([A, B, C], n, world), n, 0);
}

export const ROCK_KINDS = { boulder: [1, 0.8, 1], rock: [1, 0.65, 0.9], slab: [1.4, 0.35, 1], shard: [0.55, 1.4, 0.6], pebble: [1, 0.6, 0.85], potato: [1.5, 0.8, 0.85], binary: [1.6, 0.8, 0.9], cratered: [1, 0.92, 1] };
/**
 * One rock / asteroid mesh. o: {kind, size (m, longest half-extent), seed, detail (icosphere
 * subdivisions 1..3), cuts (flattening planes), craters, tex, world (m per texture repeat)}
 */
export function rockMesh(o) {
  const kind = o.kind || 'rock';
  if (!ROCK_KINDS[kind]) throw new Error(`rock kind must be one of ${Object.keys(ROCK_KINDS).join(', ')}`);
  const r = mulberry32(seedOf(o.seed ?? 1, 41)), n3 = perlin3(seedOf(o.seed ?? 1, 42));
  const { V, F } = icosphere(Math.max(0, Math.min(3, o.detail ?? 1)));
  const sc = ROCK_KINDS[kind].map((v) => v * (0.85 + r() * 0.3));
  const size = o.size ?? 1;
  const bump = kind === 'pebble' ? 0.15 : kind === 'shard' ? 0.1 : 0.28;
  // lumps for a contact binary: a second centre
  const lobe = kind === 'binary' ? [0.55, (r() - 0.5) * 0.3, (r() - 0.5) * 0.3] : null;
  const craters = kind === 'cratered' || o.craters ? Array.from({ length: o.craters ?? 6 }, () => ({ d: vnorm([r() - 0.5, r() - 0.5, r() - 0.5]), r: 0.25 + r() * 0.35 })) : [];
  let P = V.map((v) => {
    let k = 1 + bump * fractal(n3, v[0] * 1.6, v[1] * 1.6, v[2] * 1.6, { octaves: 3 });
    for (const c of craters) { const t = Math.acos(Math.min(1, vdot(v, c.d))) / c.r; if (t < 1) k -= 0.12 * (1 - t * t); else if (t < 1.3) k += 0.03; }
    let p = [v[0] * k * sc[0], v[1] * k * sc[1], v[2] * k * sc[2]];
    if (lobe) { const s = v[0] > 0 ? 1 : 0.75; p = [p[0] + (v[0] > 0 ? lobe[0] : -lobe[0] * 0.6), p[1] * s + lobe[1] * (v[0] > 0 ? 1 : 0), p[2] * s + lobe[2] * (v[0] > 0 ? 1 : 0)]; }
    return p;
  });
  // planar cuts: chunky facets (vertices past a plane are pressed onto it)
  const cuts = o.cuts ?? (kind === 'pebble' ? 2 : kind === 'shard' ? 5 : 4);
  for (let c = 0; c < cuts; c++) {
    const nrm = vnorm([r() - 0.5, (r() - 0.5) * (kind === 'slab' ? 3 : 1), r() - 0.5]);
    let mx = -Infinity;
    for (const p of P) mx = Math.max(mx, vdot(p, nrm));
    const lim = mx * (0.72 + r() * 0.2);
    P = P.map((p) => { const d = vdot(p, nrm) - lim; return d > 0 ? [p[0] - nrm[0] * d, p[1] - nrm[1] * d, p[2] - nrm[2] * d] : p; });
  }
  // normalise to `size` (longest half-extent), sit on y = 0 for ground rocks
  let ext = 0;
  for (const p of P) ext = Math.max(ext, Math.abs(p[0]), Math.abs(p[1]), Math.abs(p[2]));
  const k = size / (ext || 1);
  let minY = Infinity;
  P = P.map((p) => p.map((v) => v * k));
  for (const p of P) minY = Math.min(minY, p[1]);
  const lift = o.ground === false ? 0 : -minY - size * 0.12; // sink a little into the ground
  P = P.map((p) => [p[0], p[1] + lift, p[2]]);
  const cen = [0, lift, 0];
  const m = new Mesh(), world = o.world ?? Math.max(0.5, size);
  for (const [a, b, c] of F) {
    const A = P[a], B = P[b], C = P[c];
    flatTri(m, o.tex, A, B, C, world, [(A[0] + B[0] + C[0]) / 3 - cen[0], (A[1] + B[1] + C[1]) / 3 - cen[1], (A[2] + B[2] + C[2]) / 3 - cen[2]]);
  }
  return m;
}

/** Crystal cluster: hexagonal prisms with pointed tips, tilted outward. */
export function crystalMesh(o) {
  const r = mulberry32(seedOf(o.seed ?? 1, 51)), m = new Mesh(), size = o.size ?? 1;
  const count = o.count ?? 5;
  for (let i = 0; i < count; i++) {
    const h = size * (0.5 + r() * 0.8) * (i === 0 ? 1.3 : 1), w = size * (0.1 + r() * 0.1);
    const ang = r() * Math.PI * 2, tilt = i === 0 ? r() * 0.15 : 0.25 + r() * 0.5;
    const ax = vnorm([Math.cos(ang) * Math.sin(tilt), Math.cos(tilt), Math.sin(ang) * Math.sin(tilt)]);
    const base = [Math.cos(ang) * w * 1.5 * (i ? 1 : 0), -w * 0.5, Math.sin(ang) * w * 1.5 * (i ? 1 : 0)];
    const [t1, t2] = (() => { const t = vnorm(vcross(ax, [0.3, 0.1, 0.9])); return [t, vcross(ax, t)]; })();
    const ring = (along, rad) => Array.from({ length: 6 }, (_, k) => { const a = (k / 6) * Math.PI * 2; return [0, 1, 2].map((c) => base[c] + ax[c] * along + (t1[c] * Math.cos(a) + t2[c] * Math.sin(a)) * rad); });
    const lo = ring(0, w), hi = ring(h * 0.78, w), tip = [0, 1, 2].map((c) => base[c] + ax[c] * h);
    const mid = [0, 1, 2].map((c) => base[c] + ax[c] * h * 0.4);
    for (let k = 0; k < 6; k++) {
      const k2 = (k + 1) % 6;
      flatTri(m, o.tex, lo[k], lo[k2], hi[k2], size * 0.5, [hi[k][0] - mid[0], hi[k][1] - mid[1], hi[k][2] - mid[2]]);
      flatTri(m, o.tex, lo[k], hi[k2], hi[k], size * 0.5, [hi[k][0] - mid[0], hi[k][1] - mid[1], hi[k][2] - mid[2]]);
      flatTri(m, o.tex, hi[k], hi[k2], tip, size * 0.5, [hi[k][0] - mid[0], hi[k][1] - mid[1], hi[k][2] - mid[2]]);
    }
  }
  return m;
}

/** Grass / dry-brush card: two crossed quads, alpha-cut pixel blades, double sided. */
export function grassCard(o) {
  const m = new Mesh(), w = o.size ?? 0.8, h = w * 0.75;
  for (const a of [0, Math.PI / 2]) {
    const dx = (Math.cos(a) * w) / 2, dz = (Math.sin(a) * w) / 2, n = [-Math.sin(a), 0, Math.cos(a)];
    m.face(o.tex, [[-dx, 0, -dz], [dx, 0, dz], [dx, h, dz], [-dx, h, -dz]], [0, 1, 0], [[0, 1], [1, 1], [1, 0], [0, 0]], n, 0);
  }
  return m;
}
/** Blade card texture (W x W, transparent background). */
export function grassTexture(ramp, { size = 32, seed = 1 } = {}) {
  ramp = ramp.map((c) => (Array.isArray(c) ? c : hexRGB(c)));
  const S = size, data = new Uint8ClampedArray(S * S * 4), r = mulberry32(seedOf(seed, 61));
  for (let b = 0; b < 11; b++) {
    let x = 2 + r() * (S - 4);
    const hgt = S * (0.4 + r() * 0.55), lean = (r() - 0.5) * 0.7, c = ramp[Math.floor(r() * ramp.length)];
    for (let y = S - 1; y > S - hgt; y--) {
      x += lean * 0.5;
      const xi = Math.round(x);
      if (xi < 0 || xi >= S) break;
      const top = (S - y) / hgt > 0.8;
      const cc = top ? ramp[ramp.length - 1] : c;
      const o4 = (y * S + xi) * 4;
      data[o4] = cc[0]; data[o4 + 1] = cc[1]; data[o4 + 2] = cc[2]; data[o4 + 3] = 255;
    }
  }
  return { width: S, height: S, data };
}

// ---------- formations (colony anchors) ----------
/**
 * Rock formation mesh. o: {kind: mesa|butte|spire|arch, size (m: footprint radius / arch span),
 * height (m), seed, tex (sides, strata), top (tex for the cap), layers (terraces)}
 * -> {mesh, anchor: {top_y, radius} (flat top for colony pads; arch: under-span clearance)}
 */
export function formationMesh(o) {
  const kind = o.kind || 'mesa';
  const r = mulberry32(seedOf(o.seed ?? 1, 71)), n3 = perlin3(seedOf(o.seed ?? 1, 72));
  const m = new Mesh(), size = o.size ?? 40;
  if (kind === 'arch') return archMesh(o, m, r, n3);
  const H = o.height ?? (kind === 'spire' ? size * 2.2 : kind === 'butte' ? size * 0.9 : size * 0.45);
  const segs = kind === 'spire' ? 9 : 16, layers = o.layers ?? (kind === 'spire' ? 5 : 3);
  // terraces: radius shrinks per level with a noisy outline; the base flares out (talus)
  const rings = [];
  for (let L = 0; L <= layers + 1; L++) {
    const t = L / (layers + 1);
    const y = L === 0 ? -size * 0.05 : t * H;
    const base = kind === 'spire' ? size * (1 - t * 0.75) : size * (1 - 0.18 * t) * (L === 0 ? 1.25 : 1);
    rings.push(Array.from({ length: segs }, (_, k) => {
      const a = (k / segs) * Math.PI * 2, nn = 1 + 0.22 * fractal(n3, Math.cos(a) * 1.3, Math.sin(a) * 1.3, L * 0.35, { octaves: 2 });
      return [Math.cos(a) * base * nn, y, Math.sin(a) * base * nn];
    }));
  }
  const strata = o.tex, cap = o.top || o.tex, wv = Math.max(4, H / 3);
  const side = (A, B, C) => {
    let n = vnorm(vcross([B[0] - A[0], B[1] - A[1], B[2] - A[2]], [C[0] - A[0], C[1] - A[1], C[2] - A[2]]));
    const out = [(A[0] + B[0] + C[0]) / 3, 0, (A[2] + B[2] + C[2]) / 3];
    if (vdot(n, out) < 0) n = n.map((v) => -v);
    // cylinder-ish UV: u = angle * radius, v = height (strata stay horizontal)
    const uv = [A, B, C].map((p) => [(Math.atan2(p[2], p[0]) * size) / wv, -p[1] / wv]);
    if (Math.abs(uv[0][0] - uv[1][0]) > 1 || Math.abs(uv[0][0] - uv[2][0]) > 1) for (const q of uv) if (q[0] < 0) q[0] += (2 * Math.PI * size) / wv;
    m.face(strata, [A, B, C], n, uv, n, 0);
  };
  for (let L = 0; L < rings.length - 1; L++) for (let k = 0; k < segs; k++) {
    const k2 = (k + 1) % segs, a = rings[L][k], b = rings[L][k2], c = rings[L + 1][k2], d = rings[L + 1][k];
    side(a, b, c); side(a, c, d);
  }
  const top = rings[rings.length - 1], cy = top[0][1];
  const tc = [0, cy + (kind === 'spire' ? size * 0.3 : 0), 0];
  for (let k = 0; k < segs; k++) {
    const A = top[k], B = top[(k + 1) % segs];
    if (kind === 'spire') { side(A, B, tc); continue; }
    m.face(cap, [A, B, tc], [0, 1, 0], [A, B, tc].map((p) => [p[0] / wv, p[2] / wv]), [0, 1, 0], 0);
  }
  let rad = Infinity;
  for (const p of top) rad = Math.min(rad, Math.hypot(p[0], p[2]));
  return { mesh: m, anchor: kind === 'spire' ? { top_y: cy, radius: 0 } : { top_y: +cy.toFixed(3), radius: +(rad * 0.9).toFixed(3) } };
}

function archMesh(o, m, r, n3) {
  const span = o.size ?? 40, H = o.height ?? span * 0.7, th = o.thickness ?? span * 0.14;
  const segs = 14, sides = 7, tex = o.tex, world = Math.max(2, th);
  // centre line: a squashed half-ellipse, legs sunk below ground; cross-section = noisy heptagon
  const C = [], T = [];
  for (let i = 0; i <= segs; i++) {
    const a = Math.PI * (1 - i / segs) * 1.08 - Math.PI * 0.04;
    C.push([Math.cos(a) * span / 2, Math.sin(a) * H - th * 0.4, 0]);
    T.push(vnorm([-Math.sin(a) * span / 2, Math.cos(a) * H, 0]));
  }
  const rings = C.map((c, i) => {
    const t = T[i], b = [0, 0, 1], nn = vnorm(vcross(b, t));
    const thick = th * (1 + 0.6 * Math.abs(i / segs - 0.5) * 2) * (0.85 + r() * 0.3);
    return Array.from({ length: sides }, (_, k) => {
      const a = (k / sides) * Math.PI * 2, j = 1 + 0.25 * fractal(n3, i * 0.6, k * 0.9, 0.5, { octaves: 2 });
      return [0, 1, 2].map((q) => c[q] + (nn[q] * Math.cos(a) * 1.2 + b[q] * Math.sin(a)) * thick * j);
    });
  });
  for (let i = 0; i < segs; i++) for (let k = 0; k < sides; k++) {
    const k2 = (k + 1) % sides, A = rings[i][k], B = rings[i][k2], Cc = rings[i + 1][k2], D = rings[i + 1][k];
    const mid = [(C[i][0] + C[i + 1][0]) / 2, (C[i][1] + C[i + 1][1]) / 2, 0];
    const out = (P) => [P[0] - mid[0], P[1] - mid[1], P[2] - mid[2]];
    flatTri(m, tex, A, B, Cc, world, out(A)); flatTri(m, tex, A, Cc, D, world, out(A));
  }
  for (const i of [0, segs]) for (let k = 1; k < sides - 1; k++) flatTri(m, tex, rings[i][0], rings[i][k], rings[i][k + 1], world, i ? T[i] : T[i].map((v) => -v));
  return { mesh: m, anchor: { clearance: +(H - th * 1.4).toFixed(3), span: +(span * 0.75).toFixed(3) } };
}

/** Scale a mesh's UVs / positions helper: world bounds of a Mesh. */
export const meshSize = (m) => { const b = m.bounds(); return b.max.map((v, i) => v - b.min[i]); };
export { clamp01 };
