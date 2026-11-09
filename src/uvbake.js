// Atlas bakes for art_model unwrap (pure, no engine): the part textures resampled into the model
// atlas in pattern space (patterns run on across parts and round the shaft), cohesion masks from
// the WHOLE built mesh (contact AO, cavity, crease lines, convex edge wear, ground grime), model-wide
// masonry courses, and a compose pass that ends every texel in a palette lookup (pixel art: no
// in-between colours), plus the UV guide overlay and the reply contact sheet.
import { BVH, bvhOf, aoAt, hemisphere, hashf } from './bake.js';
import { hash3 } from './util.js';
import { medianCut, parseColor, nearestColor } from './color.js';
import { dilate } from './uvunwrap.js';
import { getFont } from './fonts.js';

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const pmod = (a, n) => ((a % n) + n) % n;
const mix = (c, d, t) => [c[0] + (d[0] - c[0]) * t, c[1] + (d[1] - c[1]) * t, c[2] + (d[2] - c[2]) * t];
/** Smooth value noise (0..1) at a world position, period ~cell px (same as model3d overlays). */
function vnoise(p, cell, seed) {
  const x = p[0] / cell, y = p[1] / cell, z = p[2] / cell;
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z), fx = x - xi, fy = y - yi, fz = z - zi;
  const h = (a, b, c) => hash3(a * 73856093 ^ c * 83492791, b, seed);
  const s = (t) => t * t * (3 - 2 * t);
  const l = (a, b, t) => a + (b - a) * s(t);
  return l(l(l(h(xi, yi, zi), h(xi + 1, yi, zi), fx), l(h(xi, yi + 1, zi), h(xi + 1, yi + 1, zi), fx), fy), l(l(h(xi, yi, zi + 1), h(xi + 1, yi, zi + 1), fx), l(h(xi, yi + 1, zi + 1), h(xi + 1, yi + 1, zi + 1), fx), fy), fz);
}
const filledMask = (M) => { const m = new Uint8Array(M.W * M.H); for (let k = 0; k < m.length; k++) m[k] = M.facet[k] >= 0 ? 1 : 0; return m; };
const vertical = (n) => Math.abs(n[1]) <= 0.7;

// ---------- 5.1 base bake ----------
/** Ring fit per chart: {scale} when the pattern closes within fit_max, else a pattern-seam record. */
export function ringFits(L, o) {
  const fits = new Map(), seams = [];
  for (const c of L.charts) {
    if (!c.ring) continue;
    const F0 = L.facets[c.facets[0]], T = F0.src.tex;
    if (T.width * T.height <= 1 || !c.facets.every((fi) => Math.abs(L.facets[fi].n[1]) < 0.5)) continue;
    const n = Math.max(1, Math.round(c.ring.L / T.width)), scale = (n * T.width) / c.ring.L;
    const N = c.ring.N, rr = (k) => +((k * T.width) / (2 * N * Math.sin(Math.PI / N))).toFixed(2);
    if (o.fit !== false && Math.abs(scale - 1) <= o.fit_max) fits.set(c.id, scale);
    else if (Math.abs(scale - 1) > 1e-6) seams.push({ island: c.id, pi: c.pi, L: +c.ring.L.toFixed(2), period: T.width, suggest_r: [rr(Math.max(1, n - 1)), rr(n), rr(n + 1)] });
  }
  return { fits, seams };
}
/**
 * Base colour (+ emissive / metal / rough / height data layers) of every atlas texel from the
 * facet's own texture: "island" samples at the island's pattern coords (world anchored, continuous
 * across hinges, ring-fitted), "uv" at the original UV (image-mapped faces, CTM tiles, trims).
 */
export function bakeBase(L, M, o = {}) {
  const { W, H } = M, n = W * H;
  const color = new Uint8ClampedArray(n * 4);
  const any = (fn) => L.facets.some((F) => fn(F.src.tex));
  const emissive = any((T) => T.emissive) ? new Uint8ClampedArray(n * 4) : null;
  const pbr = any((T) => T.mr || T.pbr) ? { metal: new Uint8ClampedArray(n * 4), rough: new Uint8ClampedArray(n * 4) } : null;
  const hasH = any((T) => T.heightOf);
  const height = hasH ? new Uint8ClampedArray(n * 4) : null;
  const hcache = new Map(), notes = new Set();
  const heightOf = (T) => { if (!hcache.has(T)) hcache.set(T, T.heightOf ? T.heightOf() : null); return hcache.get(T); };
  for (const F of L.facets) if (F.src.tex.normal && !F.src.tex.heightOf && F.src.tex.canvas) notes.add(`normal map of ${F.src.tex.canvas} not carried into the atlas: add a "height" layer to it`);
  const { fits, seams } = ringFits(L, o);
  const tileOf = (F, T) => (T.width * T.height <= 1 ? 'color' : o.tile === 'island' || o.tile === 'uv' ? o.tile : (F.src.mode === 1 || F.src.mode === 2) && !F.src.ctm ? 'island' : 'uv');
  // bake.top: up faces that only got the side texture (faceTexer fallback) take the top texture
  const topOf = new Map();
  if (o.top) for (const F of L.facets) {
    if (F.n[1] <= 0.7) continue;
    for (const [, , key] of F.bnd) {
      const us = L.edges.get(key) || [];
      if (us.some((u) => { const B = L.facets[u.fi]; return B !== F && vertical(B.n) && B.pi === F.pi && B.src.tex.key === F.src.tex.key; })) { topOf.set(F.id, o.top); break; }
    }
  }
  for (let k = 0; k < n; k++) {
    const fi = M.facet[k];
    if (fi < 0) continue;
    const F = L.facets[fi], c = L.charts[M.island[k]];
    const T = topOf.get(fi) || F.src.tex;
    const mode = topOf.has(fi) ? (T.width * T.height <= 1 ? 'color' : 'island') : tileOf(F, T);
    let x = 0, y = 0;
    if (mode === 'uv') { const [u, v] = M.srcUV(k); x = pmod(Math.floor(u * T.width + 1e-7), T.width); y = pmod(Math.floor(v * T.height + 1e-7), T.height); }
    else if (mode === 'island') {
      let [S, Q] = M.st(k);
      const sc = fits.get(c.id);
      if (sc) S = c.ring.u0 + (S - c.ring.u0) * sc;
      x = pmod(Math.floor(S), T.width); y = pmod(Math.floor(Q), T.height);
    }
    const p = (y * T.width + x) * 4;
    color.set(T.data.subarray(p, p + 4), k * 4);
    if (emissive && T.emissive) emissive.set(T.emissive.subarray(p, p + 4), k * 4);
    if (pbr) {
      const mt = T.mr ? T.mr[p + 2] : Math.round((T.pbr?.metal ?? 0) * 255), rg = T.mr ? T.mr[p + 1] : Math.round((T.pbr?.rough ?? 1) * 255);
      pbr.metal.set([mt, mt, mt, 255], k * 4); pbr.rough.set([rg, rg, rg, 255], k * 4);
    }
    if (height) { const h = heightOf(T); const v = h ? Math.round(clamp01(h[y * T.width + x]) * 255) : 0; height.set([v, v, v, 255], k * 4); }
  }
  const mask = filledMask(M);
  for (const b of [color, emissive, pbr?.metal, pbr?.rough, height]) if (b) dilate(b, mask, W, H, L.pad);
  return { color, emissive, metal: pbr?.metal || null, rough: pbr?.rough || null, height, notes: [...notes], ring_fit: [...fits].map(([island, scale]) => ({ island, scale: +scale.toFixed(4) })), fits, pattern_seams: seams };
}

// ---------- 5.2 masks ----------
/** Per-node occluders for rigs (parts that move do not shadow each other), else the whole mesh. */
function occluders(mesh, perNode) {
  if (!perNode) { const b = bvhOf([mesh]); return () => b; }
  const by = new Map();
  for (const g of mesh.groups.values()) {
    if (g.overlay || g.tex.material?.blend || g.tex.decal || !g.faces) continue;
    for (const f of g.faces) {
      const key = f.node ?? null;
      let l = by.get(key); if (!l) by.set(key, (l = []));
      for (let i = f.i; i < f.i + f.ic; i++) { const v = g.idx[i]; l.push(g.pos[v * 3], g.pos[v * 3 + 1], g.pos[v * 3 + 2]); }
    }
  }
  const cache = new Map();
  return (node) => { const key = node ?? null; if (!cache.has(key)) cache.set(key, new BVH(Float32Array.from(by.get(key) || []))); return cache.get(key); };
}
/** Segment distance (2D). */
const segDist = (px, py, ax, ay, bx, by) => { const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy; const t = l2 ? clamp01(((px - ax) * dx + (py - ay) * dy) / l2) : 0; return Math.hypot(px - ax - dx * t, py - ay - dy * t); };
/** Sharp boundary edges of every facet in atlas texel coords: {convex, concave, open} segment lists. */
function facetEdges(L, minAngle) {
  const out = new Map();
  for (const c of L.charts) for (const fi of c.facets) {
    const F = L.facets[fi], X = L.x2[fi], t = L.texel;
    const P = (l) => [c.rect[0] + (X[l * 2] - c.o[0]) / t, c.rect[1] + (X[l * 2 + 1] - c.o[1]) / t];
    const r = { convex: [], concave: [], open: [] };
    for (const [a, b, key] of F.bnd) {
      const us = L.edges.get(key) || [];
      const seg = [...P(a), ...P(b)];
      if (us.length === 1) { r.open.push(seg); continue; }
      if (us.length !== 2) continue;
      const B = L.facets[us[0].fi === fi ? us[1].fi : us[0].fi];
      const d = (Math.acos(Math.max(-1, Math.min(1, dot(F.n, B.n)))) * 180) / Math.PI;
      if (d < minAngle + 0.5) continue;
      const s = dot(F.n, [B.c[0] - F.c[0], B.c[1] - F.c[1], B.c[2] - F.c[2]]);
      (s < 0 ? r.convex : r.concave).push(seg);
    }
    out.set(fi, r);
  }
  return out;
}
/**
 * Cohesion masks over the atlas texels (0..1 floats): ao (long range, whole model occludes),
 * cavity (short range = contact with another part or a crease), edge (convex sharp edges, worn),
 * crease (concave edges + the 1 texel contact line), grime (ground dirt + occluded dirt), up.
 */
export function bakeMasks(L, M, mesh, o) {
  const { W, H } = M, n = W * H, coh = o.cohesion, anchor = L.anchor;
  const ao = new Float32Array(n).fill(1), cavity = new Float32Array(n), edge = new Float32Array(n), crease = new Uint8Array(n), grime = new Float32Array(n), up = new Float32Array(n);
  const bvhFor = occluders(mesh, o.perNode);
  const aoO = coh.ao ? { distance: coh.ao.distance, strength: 1, bias: 0.05, levels: 0 } : null;
  const caO = { distance: coh.contact ? coh.contact.width : 4, strength: 1, bias: 0.05, levels: 0 };
  const dirsA = coh.ao ? hemisphere(coh.ao.samples) : null, dirsC = hemisphere(8);
  const rays = M.filled * ((coh.ao ? coh.ao.samples : 0) + 8);
  const step = rays > (o.maxRays ?? 12e6) ? Math.ceil(Math.sqrt(rays / (o.maxRays ?? 12e6))) : 1;
  const sampleAt = (k) => {
    const i = k % W, j = (k - i) / W, F = L.facets[M.facet[k]];
    const p = M.posAt(k), P = [p[0] + anchor[0], p[1] + anchor[1], p[2] + anchor[2]], nn = M.nrmAt(k);
    const bvh = bvhFor(F.node);
    const rot = hashf(i, j) * 2 * Math.PI;
    // cavity: short-range occlusion scaled so a texel right at a 90 deg contact (half the hemisphere blocked) reads ~1
    return [aoO ? aoAt(bvh, P, nn, dirsA, aoO, rot) : 1, clamp01(2 * (1 - aoAt(bvh, P, nn, dirsC, caO, rot)))];
  };
  if (step === 1) {
    for (let k = 0; k < n; k++) if (M.facet[k] >= 0) { const [a, c] = sampleAt(k); ao[k] = a; cavity[k] = c; }
  } else {
    // lattice per island + interpolation (nearest filled lattice texel of the same island)
    const lat = new Map();
    for (const c of L.charts) {
      const [rx, ry, rw, rh] = c.rect;
      for (let j = ry; j < ry + rh; j += step) for (let i = rx; i < rx + rw; i += step) { const k = j * W + i; if (M.facet[k] >= 0) lat.set(k, sampleAt(k)); }
    }
    for (let k = 0; k < n; k++) {
      if (M.facet[k] < 0) continue;
      if (lat.has(k)) { [ao[k], cavity[k]] = lat.get(k); continue; }
      const i = k % W, j = (k - i) / W, c = L.charts[M.island[k]];
      const bi = c.rect[0] + Math.floor((i - c.rect[0]) / step) * step, bj = c.rect[1] + Math.floor((j - c.rect[1]) / step) * step;
      let wsum = 0, a = 0, cv = 0;
      for (const [di, dj] of [[0, 0], [step, 0], [0, step], [step, step]]) {
        const v = lat.get((bj + dj) * W + bi + di);
        if (!v) continue;
        const w = (1 - Math.abs(i - bi - di) / step) * (1 - Math.abs(j - bj - dj) / step);
        if (w <= 0) continue;
        wsum += w; a += v[0] * w; cv += v[1] * w;
      }
      if (wsum > 0) { ao[k] = a / wsum; cavity[k] = cv / wsum; } else { const s = sampleAt(k); ao[k] = s[0]; cavity[k] = s[1]; }
    }
  }
  const fe = facetEdges(L, coh.edges ? coh.edges.min_angle : 30);
  let yMin = Infinity;
  for (const F of L.facets) for (const p of F.pos) if (p[1] < yMin) yMin = p[1];
  const seed = coh.seed;
  for (let k = 0; k < n; k++) {
    const fi = M.facet[k];
    if (fi < 0) continue;
    const i = k % W, j = (k - i) / W, qx = i + 0.5, qy = j + 0.5, F = L.facets[fi], r = fe.get(fi);
    const p = M.posAt(k), nn = F.n;
    up[k] = Math.max(0, nn[1]);
    if (coh.edges) {
      const w = coh.edges.width;
      let hit = r.convex.some((s) => segDist(qx, qy, ...s) < w);
      if (!hit && cavity[k] < 0.3) hit = r.open.some((s) => segDist(qx, qy, ...s) < w);
      if (hit && vnoise(p, 6, seed) < coh.edges.wear) edge[k] = 1;
    }
    if (r.concave.some((s) => segDist(qx, qy, ...s) < 1)) crease[k] = 1;
    if (coh.grime) {
      const g0 = vertical(nn) ? clamp01(1 - (p[1] - yMin) / coh.grime.height) * (0.5 + vnoise(p, coh.grime.noise, seed + 7)) : 0;
      grime[k] = clamp01(g0 + 0.5 * clamp01((0.6 - ao[k]) / 0.6));
    }
  }
  // contact line: the texel row nearest another part (local cavity maximum), 1 texel thick
  if (coh.contact && coh.contact.line) {
    const thr = o.lineThreshold ?? 0.75;
    const at = (k, di, dj) => { const i = (k % W) + di, j = Math.floor(k / W) + dj; if (i < 0 || j < 0 || i >= W || j >= H) return -1; const q = j * W + i; return M.island[q] === M.island[k] ? q : -1; };
    for (let k = 0; k < n; k++) {
      if (M.facet[k] < 0 || cavity[k] <= thr) continue;
      let max = true;
      for (const [di, dj] of [[0, -1], [-1, 0], [1, 0], [0, 1]]) { const q = at(k, di, dj); if (q >= 0 && cavity[q] > cavity[k] + 0.02) { max = false; break; } }
      if (!max) continue;
      // thin plateaus: keep the texel only when it is the maximum along the steepest axis
      const gx = [at(k, -1, 0), at(k, 1, 0)].map((q) => (q >= 0 ? cavity[q] : cavity[k])), gy = [at(k, 0, -1), at(k, 0, 1)].map((q) => (q >= 0 ? cavity[q] : cavity[k]));
      const sx = Math.abs(gx[1] - gx[0]), sy = Math.abs(gy[1] - gy[0]);
      const [lo, hi] = sx >= sy ? gx : gy;
      if (Math.max(sx, sy) > 0.01 && cavity[k] < Math.max(lo, hi) - 1e-6) continue;
      crease[k] = 1;
    }
  }
  const masks = new Uint8ClampedArray(n * 4);
  for (let k = 0; k < n; k++) if (M.facet[k] >= 0) masks.set([Math.round(ao[k] * 255), Math.round(cavity[k] * 255), Math.round(edge[k] * 255), 255], k * 4);
  dilate(masks, filledMask(M), W, H, L.pad);
  return { ao, cavity, edge, crease, grime, up, masks, ao_step: step };
}

// ---------- 5.3 courses ----------
/**
 * Model-wide masonry joints: bed joints per part (snap:"parts" = each part's height in whole
 * courses, so part borders are joints) or at world multiples of h; head joints along each island's
 * pattern u (ring islands: a whole number of stones round). -> Uint8Array (1 joint, 2 highlight)
 */
export function bakeCourses(L, M, spec, { partBounds, partOk = () => true, seed = 1 } = {}) {
  const { W, H } = M, n = W * H, joint = new Uint8Array(n), A = L.anchor;
  const span = new Map();
  for (const [pi, b] of (partBounds || []).entries()) if (b) span.set(pi, [b.min[1] - A[1], b.max[1] - A[1]]);
  const J = spec.joint;
  for (let k = 0; k < n; k++) {
    const fi = M.facet[k];
    if (fi < 0) continue;
    const F = L.facets[fi];
    if (!partOk(F.pi)) continue;
    const c = L.charts[M.island[k]], p = M.posAt(k), [S0, Q] = M.st(k);
    if (vertical(F.n)) {
      const sp = span.get(F.pi);
      const y = p[1];
      let y0, ch, ci;
      if (spec.snap === 'parts' && sp) {
        const Hp = sp[1] - sp[0], nC = Math.max(1, Math.round(Hp / spec.h));
        y0 = sp[0]; ch = Hp / nC; ci = Math.min(nC - 1, Math.max(0, Math.floor((y - y0) / ch)));
        let bed = false;
        for (let q = 0; q <= nC; q++) {
          const jy = Math.round(y0 + q * ch);
          const lo = q === nC ? jy - J : jy, fy = Math.floor(y);
          if (fy >= lo && fy < lo + J) { bed = true; break; }
        }
        if (bed) { joint[k] = 1; continue; }
      } else {
        y0 = 0; ch = spec.h; ci = Math.floor(y / ch);
        if (pmod(Math.floor(y), spec.h) < J) { joint[k] = 1; continue; }
      }
      if (spec.bond === 'drums') continue;
      let S = S0, period = spec.len;
      if (c.ring) { const m = Math.max(1, Math.round(c.ring.L / spec.len)); period = c.ring.L / m; S = S0 - c.ring.u0; }
      let off = spec.bond === 'running' && pmod(ci, 2) === 1 ? period / 2 : 0;
      if (spec.jitter) { const si = Math.floor((S - off) / period); off += Math.round((hash3(ci, si, seed) - 0.5) * spec.jitter * period); }
      if (Math.floor(pmod(S - off, period)) < J) joint[k] = 1;
    } else if (spec.caps === 'grid') {
      if (pmod(Math.floor(S0), spec.len) < J || pmod(Math.floor(Q), spec.len) < J) joint[k] = 1;
    }
  }
  // highlight: below a bed joint / right of a head joint (light from the upper left), same island
  for (let k = 0; k < n; k++) {
    if (M.facet[k] < 0 || joint[k]) continue;
    const i = k % W, j = (k - i) / W, isl = M.island[k];
    const up = j > 0 && M.island[k - W] === isl && joint[k - W] === 1, left = i > 0 && M.island[k - 1] === isl && joint[k - 1] === 1;
    if ((up || left) && vertical(L.facets[M.facet[k]].n)) joint[k] = 2;
  }
  return { joint };
}

// ---------- 5.4 palette + compose ----------
const rgb = (c) => { const x = parseColor(c); return [x[0], x[1], x[2]]; };
/** Palette for the compose pass: "auto" = base colours (median cut over 48) + shadow / highlight steps of the 8 most frequent. */
export function cohesionPalette(base, coh, { project, canvas, extra = [] } = {}) {
  const P = coh.palette;
  if (Array.isArray(P)) return P.map(rgb);
  if (P === 'project' || P === 'canvas') {
    const src = P === 'project' ? project : canvas;
    const pal = Object.values(src || {}).map((c) => parseColor(c)).filter((c) => (c[3] ?? 255) > 0).map((c) => [c[0], c[1], c[2]]);
    if (!pal.length) throw new Error(`unwrap: cohesion.palette "${P}" is empty (set the model's project palette, or palette:"auto" | ["#rrggbb", ...])`);
    return pal;
  }
  const counts = new Map();
  for (let i = 0; i < base.length; i += 4) if (base[i + 3] >= 128) { const k = (base[i] << 16) | (base[i + 1] << 8) | base[i + 2]; counts.set(k, (counts.get(k) || 0) + 1); }
  for (const c of extra) { const k = (c[0] << 16) | (c[1] << 8) | c[2]; counts.set(k, (counts.get(k) || 0) + 1); }
  let pal = [...counts.keys()].map((k) => [(k >> 16) & 255, (k >> 8) & 255, k & 255]);
  if (pal.length > 48) pal = medianCut([base], coh.colors);
  const top = [...counts].sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, 8).map(([k]) => [(k >> 16) & 255, (k >> 8) & 255, k & 255]);
  const sh = rgb(coh.shadow), hi = rgb(coh.highlight), out = [...pal];
  for (const c of top) for (const [d, t] of [[sh, 0.3], [sh, 0.55], [hi, 0.35]]) out.push(mix(c, d, t).map(Math.round));
  const seen = new Set();
  return out.filter((c) => { const k = c.join(','); if (seen.has(k)) return false; seen.add(k); return true; });
}
/**
 * Cohesion layer: AO / contact / grime darken toward `shadow`, worn edges lighten toward
 * `highlight`, crease and joint texels become crisp lines; the shading is cut into a few clean value
 * bands (checker only at band borders, no orphan texels); every texel ends in a palette colour.
 * Only texels that differ from the base are written.
 */
export function composeCohesion(L, M, base, masks, courses, coh, palette, { overlays = [] } = {}) {
  const { W, H } = M, n = W * H, out = new Uint8ClampedArray(n * 4), cache = new Map();
  const sh = rgb(coh.shadow), hi = rgb(coh.highlight);
  const jc = courses && coh.courses?.color ? rgb(coh.courses.color) : null, jl = courses && coh.courses?.light ? rgb(coh.courses.light) : null;
  const pal = [...palette, ...(jc ? [jc] : []), ...(jl ? [jl] : [])];
  const lv = coh.ao ? coh.ao.levels : 0;
  // 1. per texel: colour after overlays, darkening, light (edge wear), structural lines
  const dark = new Float32Array(n), cols = new Array(n), kind = new Int8Array(n); // kind: 0 none, 1 crease / joint line, 2 joint highlight
  for (let k = 0; k < n; k++) {
    if (M.facet[k] < 0 || !base[k * 4 + 3]) continue;
    let cc = [base[k * 4], base[k * 4 + 1], base[k * 4 + 2]];
    // overlays (moss in the contact, dirt at the bottom, ...): hard per-texel replace before the lookup
    for (const ov of overlays) {
      const m = ov.where === 'contact' ? masks.cavity[k] : ov.where === 'cavity' ? (masks.ao[k] < 0.6 ? 1 - masks.ao[k] : 0) : ov.where === 'top' ? (masks.up[k] > 0.7 ? 1 : 0) : ov.where === 'bottom' ? masks.grime[k] : ov.where === 'edges' ? masks.edge[k] : 1;
      if (!m) continue;
      const p = M.posAt(k);
      if (m * (0.5 + vnoise(p, ov.noise, coh.seed + 13)) * ov.amount <= ov.threshold) continue;
      const [S, Q] = M.st(k), T = ov.tex, q = (pmod(Math.floor(Q), T.height) * T.width + pmod(Math.floor(S), T.width)) * 4;
      if (T.data[q + 3] >= 128) cc = [T.data[q], T.data[q + 1], T.data[q + 2]];
    }
    cols[k] = cc;
    const a = masks.ao[k], aoq = lv > 1 ? Math.round(a * (lv - 1)) / (lv - 1) : a;
    dark[k] = clamp01((coh.ao ? coh.ao.strength * (1 - aoq) : 0) + (coh.contact ? coh.contact.strength * 0.5 * masks.cavity[k] : 0) + (coh.grime ? coh.grime.strength * masks.grime[k] : 0));
    const jv = courses ? courses.joint[k] : 0;
    kind[k] = masks.crease[k] || jv === 1 ? 1 : jv === 2 ? 2 : 0;
  }
  // 2. clean pixel-art shading: the darkening is smoothed inside its island (no per-texel AO speckle),
  // cut into a few value bands, texels that no neighbour shares (orphans) take the band around them,
  // and a 1 px checker marks band borders. Lines (creases, joints) are never touched.
  const same = (k, q) => q >= 0 && q < n && M.island[q] === M.island[k] && cols[q] !== undefined;
  const nb = (k, di, dj) => { const i = (k % W) + di, j = (k - (k % W)) / W + dj; return i < 0 || j < 0 || i >= W || j >= H ? -1 : j * W + i; };
  const N = BANDS, band = new Int8Array(n).fill(-1); // -1 not shaded here, 0..N darkness band, N + 1 edge light
  for (let k = 0; k < n; k++) {
    if (cols[k] === undefined || kind[k]) continue;
    let s = 0, w = 0;
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) { const q = nb(k, di, dj); if (same(k, q) && !kind[q]) { s += dark[q]; w++; } }
    const d = w ? s / w : dark[k];
    const light = coh.edges ? coh.edges.strength * masks.edge[k] : 0;
    if (light > 0 && d < 0.35) { band[k] = N + 1; continue; }
    band[k] = Math.min(N, Math.round(d * N));
  }
  for (let pass = 0; pass < 2; pass++) {
    const prev = Int8Array.from(band);
    for (let k = 0; k < n; k++) {
      if (prev[k] < 0) continue;
      const votes = new Map();
      let kin = false;
      for (let dj = -1; dj <= 1 && !kin; dj++) for (let di = -1; di <= 1; di++) {
        if (!di && !dj) continue;
        const q = nb(k, di, dj);
        if (!same(k, q) || prev[q] < 0) continue;
        if (prev[q] === prev[k]) { kin = true; break; }
        if (!di || !dj) votes.set(prev[q], (votes.get(prev[q]) || 0) + 1); // 4-neighbours vote
      }
      if (kin || !votes.size) continue;
      let best = -1, bc = 0;
      for (const [b, c] of votes) if (c > bc || (c === bc && Math.abs(b - prev[k]) < Math.abs(best - prev[k]))) { best = b; bc = c; }
      band[k] = best;
    }
  }
  // a 1 px checker on the light side of each band border (the only dither)
  if (coh.dither) {
    const prev = Int8Array.from(band);
    for (let k = 0; k < n; k++) {
      const b = prev[k], i = k % W, j = (k - i) / W;
      if (b < 0 || b >= N || (i + j) & 1) continue;
      for (const [di, dj] of [[0, -1], [-1, 0], [1, 0], [0, 1]]) { const q = nb(k, di, dj); if (same(k, q) && prev[q] === b + 1) { band[k] = b + 1; break; } }
    }
  }
  // 3. palette lookup per texel
  for (let k = 0; k < n; k++) {
    const cc = cols[k];
    if (cc === undefined) continue;
    const touched = cc[0] !== base[k * 4] || cc[1] !== base[k * 4 + 1] || cc[2] !== base[k * 4 + 2];
    let target;
    if (kind[k] === 1) target = courses && courses.joint[k] === 1 && jc ? jc : mix(cc, sh, 0.6);
    else if (kind[k] === 2) target = jl || mix(cc, hi, 0.3);
    else if (band[k] === N + 1) target = mix(cc, hi, 0.4 * (coh.edges ? coh.edges.strength * masks.edge[k] : 0));
    else if (band[k] > 0) target = mix(cc, sh, 0.7 * band[k] / N);
    else if (touched) target = cc;
    else continue; // untouched texel: the base stays as painted
    const best = nearestColor(pal, target[0], target[1], target[2], cache);
    if (best[0] === base[k * 4] && best[1] === base[k * 4 + 1] && best[2] === base[k * 4 + 2]) continue;
    out.set([best[0], best[1], best[2], 255], k * 4);
  }
  dilateWithin(out, M, L.pad);
  return out;
}
/** Darkness bands of the cohesion shading. */
const BANDS = 4;
/** Dilate a sparse layer into the gutters only (texels of an island stay as they are). */
function dilateWithin(buf, M, pad) {
  const { W, H } = M;
  const tmp = new Uint8ClampedArray(buf.length);
  tmp.set(buf);
  // fill island texels left transparent with a marker so gutter texels copy "nothing" there
  const mask = filledMask(M);
  const grown = dilate(tmp, mask, W, H, pad);
  for (let k = 0; k < W * H; k++) if (!mask[k] && grown[k]) buf.set(tmp.subarray(k * 4, k * 4 + 4), k * 4);
}

// ---------- 5.5 guide ----------
const hsl = (h, s, l) => { const a = s * Math.min(l, 1 - l), f = (n) => { const k = (n + h / 30) % 12; return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)))); }; return [f(0), f(8), f(4)]; };
/**
 * UV guide (hidden "guide" layer): island outlines coloured by part, an 8 px checker aligned to
 * pattern px (texel grid + scale), visible seams in red, labels "<id> <part> <role>" (3x5 font).
 */
export function guideImage(L, M, { names = [] } = {}) {
  const { W, H } = M, out = new Uint8ClampedArray(W * H * 4), font = getFont('3x5');
  const put = (i, j, c, a = 255) => { if (i < 0 || j < 0 || i >= W || j >= H) return; out.set([c[0], c[1], c[2], a], (j * W + i) * 4); };
  for (const c of L.charts) {
    const col = hsl(((c.pi ?? 0) * 47) % 360, 0.7, 0.6);
    const [rx, ry, rw, rh] = c.rect;
    for (let j = ry; j < ry + rh; j++) for (let i = rx; i < rx + rw; i++) {
      const k = j * W + i;
      if (M.island[k] !== c.id) continue;
      const S = Math.floor(c.o[0] / L.texel + (i - rx)), Q = Math.floor(c.o[1] / L.texel + (j - ry));
      const border = [[0, -1], [-1, 0], [1, 0], [0, 1]].some(([di, dj]) => { const q = (j + dj) * W + i + di; return i + di < 0 || j + dj < 0 || i + di >= W || j + dj >= H || M.island[q] !== c.id; });
      if (border) put(i, j, col);
      else if ((Math.floor(S / 8) + Math.floor(Q / 8)) & 1) put(i, j, col, 40);
    }
  }
  // visible seams (smooth edges facing the viewer that are cut)
  for (const s of L.seams) {
    if (!(s.smooth && s.vis > 0.6)) continue;
    for (const u of [s.a, s.b]) {
      const c = L.charts[L.chartOf[u.fi]], X = L.x2[u.fi], t = L.texel;
      const P = (l) => [c.rect[0] + (X[l * 2] - c.o[0]) / t, c.rect[1] + (X[l * 2 + 1] - c.o[1]) / t];
      const [ax, ay] = P(u.a), [bx, by] = P(u.b), steps = Math.ceil(Math.hypot(bx - ax, by - ay) * 2) + 1;
      for (let q = 0; q <= steps; q++) { const x = Math.min(c.rect[0] + c.rect[2] - 1, Math.floor(ax + ((bx - ax) * q) / steps)), y = Math.min(c.rect[1] + c.rect[3] - 1, Math.floor(ay + ((by - ay) * q) / steps)); put(x, y, [255, 48, 48]); }
    }
  }
  const text = (s, x, y, col) => {
    let cx = x;
    for (const ch of s.toUpperCase()) {
      const g = font.glyphs[ch] || font.glyphs['?'];
      g.forEach((row, r) => { for (let q = 0; q < row.length; q++) if (row[q] === '1') put(cx + q, y + r, col); });
      cx += g[0].length + 1;
    }
    return cx - x;
  };
  const width = (s) => [...s.toUpperCase()].reduce((w, ch) => w + (font.glyphs[ch] || font.glyphs['?'])[0].length + 1, 0);
  for (const c of L.charts) {
    const [rx, ry, rw, rh] = c.rect;
    if (rw < 5 || rh < 7) continue;
    const nm = names[c.pi] ?? (c.pi ?? '');
    const long = `${c.id} ${nm} ${c.role}`.replace(/\s+/g, ' ').trim(), mid = `${c.id} ${c.role}`;
    const s = width(long) <= rw - 2 ? long : width(mid) <= rw - 2 ? mid : String(c.id);
    if (width(s) > rw) continue;
    text(s, rx + 1, ry + 1, [255, 255, 255]);
  }
  return out;
}
