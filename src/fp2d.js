// Hand-drawn sources for the fp v2 pipeline (art_fp template / anchors / sweep2d): a gun, magazine,
// attachment or item drawn as a few canvases at key angles, each with its anchors in canvas meta,
// becomes the same yaw x pitch sweep a 3D model gives (fpsweep.js renderSweep): {def: {cell, yaw,
// pitch, anchors, class?, mag?, slot?}, cells, depths}. Nothing downstream changes: composite,
// check, batch and the game read the files exactly as they read a 3D sweep.
//
// The warp: every cell takes its NEAREST key drawing (rotation distance) and treats it as a flat
// card through the reference anchor (grip / mount). The card plane is the gun's side plane (the
// x = 0 plane of gun space, where every contract anchor sits) when that faces the key's eye within
// 55 degrees, the top plane likewise, else the plane facing the key's eye. A cell pixel is a ray
// from the fp eye that hits the card; the card point is projected back into the key drawing
// (a plane-induced homography, with the fp camera's perspective), and the drawing pixel is read
// with nearest sampling from a Scale2x upscale (RotSprite style). So cells only ever hold the
// drawing's own colours, a key angle reproduces its drawing exactly, and the result is
// deterministic. Anchors go through the same map, so hands land where the drawn grip is drawn.
//
// Canvas meta (meta.fp2d) of a key: {source, kind: gun|mag|attachment|item, class?, mag?, slot?,
// view?: side|side_right|rear|three_quarter_rear|three_quarter_front|top | yaw?, pitch?, roll?,
// anchors: {name: [x, y]} (canvas px; a pixel's centre is x + 0.5), scale? (drawing px per cell px,
// default 1), plane?: auto|side|top|view|[nx, ny, nz], state? (moving-part state variant),
// override?: {yaw, pitch} + grip: [x, y] (a painted cell that replaces the generated one)}.
// Layers named "guides" are never sampled.
import { F, D, MAX_SHEET, cellRotation, anglesOf, mm, mv, tr, rx, ry, rz, norm, dot, sub, add, mul, r1, clamp } from './fp.js';
import { gunModel, fpGeometry, GUN_CLASSES } from './fpkit.js';
import { ANCHORS, REF } from './fpsweep.js';
import { upscale } from './pixelops.js';
import { STATIONS, adsStation } from './fpclips.js';
import { apparent, ypr } from './fp.js';

/** Fall-off (px) of the anchor correction field: half the correction at this distance from an anchor. */
export const FIELD_R = 60;
/** The correction is full up to FIELD_FADE[0] degrees from the cell's key and gone at FIELD_FADE[1]. */
export const FIELD_FADE = [30, 60];

const R2D = 180 / Math.PI;
export const KINDS = ['gun', 'mag', 'attachment', 'item'];
export const GUIDES = 'guides';
/** Key views (eye-space rotation of the object, as a sweep cell: ry(yaw) * rx(pitch)). */
export const VIEWS = {
  side: () => cellRotation(90, 0), // muzzle left, the gun's left side toward the eye
  side_right: () => cellRotation(-90, 0), // muzzle right
  rear: () => cellRotation(0, 0), // the sight picture (ADS)
  three_quarter_rear: () => cellRotation(40, 10), // the hip view
  three_quarter_front: () => cellRotation(130, 10),
  top: () => mm(rx(90), ry(90)), // looking down on the top, muzzle left
};
/** Yaw / pitch the views stand for (reports; top has no yaw / pitch form). */
const VIEW_ANGLES = { side: [90, 0], side_right: [-90, 0], rear: [0, 0], three_quarter_rear: [40, 10], three_quarter_front: [130, 10] };
/**
 * Where the clips of a class show the gun (apparent cell angles of the class stations): hip, ads
 * (the sight picture: the grip sits below the axis, so pitch is about 20) and reload.
 */
export function stationView(cls, name) {
  if (!cls || !GUN_CLASSES.includes(cls)) throw new Error(`view "${name}" needs the gun class (class: ${GUN_CLASSES.join('|')})`);
  const kind = cls === 'pistol' ? 'pistol' : 'long';
  const S = name === 'ads' ? adsStation(fpGeometry(cls)) : STATIONS[kind][name];
  const a = apparent(S.P, ypr(...S.r));
  return [Math.round(a.yaw) + 0, Math.round(a.pitch) + 0];
}
export const STATION_VIEWS = ['hip', 'ads', 'reload'];
export function keyRotation(m) {
  if (STATION_VIEWS.includes(m.view)) { const [y, p] = stationView(m.class, m.view); return cellRotation(y, p); }
  if (m.view) { const v = VIEWS[m.view]; if (!v) throw new Error(`unknown view "${m.view}" (${Object.keys(VIEWS).join(', ')}, or yaw / pitch / roll)`); return v(); }
  return mm(cellRotation(Number(m.yaw ?? 0), Number(m.pitch ?? 0)), rz(Number(m.roll ?? 0)));
}
/** Angle (deg) between two rotations. */
export function rotDist(A, B) {
  const M = mm(tr(A), B);
  return Math.acos(clamp((M[0][0] + M[1][1] + M[2][2] - 1) / 2, -1, 1)) * R2D;
}

// ---------- camera: pixels relative to the reference pixel (the cell camera of fpsweep.js) ----------
/** Gun-space point X seen with rotation R (reference on the axis at depth D) -> [x, y, depth]. */
export function projectRef(R, X) {
  const Y = mv(R, X), z = Math.max(0.5, D - Y[2]);
  return [(F * Y[0]) / z, (-F * Y[1]) / z, z];
}
/** Pixel q seen with rotation R -> the gun-space point on plane n (through the reference), or null. */
export function unprojectPlane(R, n, q) {
  const N = mv(R, n), d = [q[0] / F, -q[1] / F, -1];
  const den = dot(N, d);
  if (Math.abs(den) < 1e-7) return null;
  const t = (-D * N[2]) / den;
  if (!(t > 0.5)) return null;
  return mv(tr(R), [d[0] * t, d[1] * t, -t + D]);
}
/** Card plane (gun space) of a key: see the header. */
export function planeOf(key) {
  const p = key.plane ?? 'auto';
  if (Array.isArray(p)) return norm(p);
  const v = mv(tr(key.R), [0, 0, 1]); // toward the key's eye, gun space
  if (p === 'view') return v;
  if (p === 'side') return [1, 0, 0];
  if (p === 'top') return [0, 1, 0];
  const c = Math.cos(55 / R2D);
  if (Math.abs(v[0]) >= c) return [1, 0, 0];
  if (Math.abs(v[1]) >= c) return [0, 1, 0];
  return v;
}
/** Drawing px of key -> pixel (relative to the reference) seen with rotation Rt, through the card. */
export function mapPoint(key, Rt, p) {
  const q = [(p[0] - key.ref[0]) / key.scale, (p[1] - key.ref[1]) / key.scale];
  const X = unprojectPlane(key.R, key.n, q);
  return X ? projectRef(Rt, X) : null;
}

// ---------- keys from canvases ----------
const opaque = (data, i) => data[i * 4 + 3] >= 128;
/** Image of a canvas without its guides layer: {width, height, data}. */
export function artOf(doc, layer) {
  if (layer) { const i = doc.layers.findIndex((l) => l.name === layer); if (i < 0) return null; return { width: doc.width, height: doc.height, data: doc.composite({ layer: i }) }; }
  return { width: doc.width, height: doc.height, data: doc.composite({ exclude: [GUIDES] }) };
}
/** Dominant outline colour of an image: the colour of most silhouette-edge pixels (when it is a real outline). */
export function outlineOf(img) {
  const { width: W, height: H, data } = img, count = new Map();
  let edges = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x;
    if (!opaque(data, i)) continue;
    let edge = false;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const X = x + dx, Y = y + dy; if (X < 0 || Y < 0 || X >= W || Y >= H || !opaque(data, Y * W + X)) { edge = true; break; } }
    if (!edge) continue;
    edges++;
    const c = (data[i * 4] << 16) | (data[i * 4 + 1] << 8) | data[i * 4 + 2];
    count.set(c, (count.get(c) || 0) + 1);
  }
  let best = null, bn = 0;
  for (const [c, n] of count) if (n > bn || (n === bn && c < best)) { best = c; bn = n; }
  return edges && bn / edges >= 0.5 ? { color: [best >> 16, (best >> 8) & 255, best & 255], set: new Set([...count].filter(([, n]) => n / edges >= 0.08).map(([c]) => c)) } : null;
}
/** Distinct opaque colours (rgb ints). */
export const colorSet = (...imgs) => { const s = new Set(); for (const d of imgs) for (let i = 0; i < d.length; i += 4) if (d[i + 3] >= 128) s.add((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]); return s; };

/** A key: canvas -> {name, R, n, ref, scale, img, big, anchors, outline, ...}. */
export function keyOf(doc, kind, cls) {
  const m = { ...(doc.meta?.fp2d || {}) };
  if (!m.class && cls) m.class = cls;
  const img = artOf(doc);
  const refName = REF[kind];
  const anchors = m.anchors || {};
  const ref = anchors[refName];
  if (!ref) throw new Error(`canvas "${doc.name}": no "${refName}" anchor (the reference of a ${kind}); place it with art_fp anchors {canvas, set:{${refName}:[x, y]}} or {suggest:true}`);
  const R = keyRotation(m);
  const key = { name: doc.name, R, view: m.view ?? null, yaw: m.yaw ?? (STATION_VIEWS.includes(m.view) ? stationView(m.class, m.view)[0] : VIEW_ANGLES[m.view]?.[0]) ?? null, pitch: m.pitch ?? (STATION_VIEWS.includes(m.view) ? stationView(m.class, m.view)[1] : VIEW_ANGLES[m.view]?.[1]) ?? null, plane: m.plane, scale: Number(m.scale ?? 1), ref, anchors, img, state: m.state ?? null, version: doc.version, updated: doc.updated };
  key.n = planeOf(key);
  // RotSprite-style source: Scale2x x4 for small drawings, x2 for big ones (no new colours either way)
  const k = Math.max(img.width, img.height) <= 400 ? 4 : 2;
  key.big = { ...upscale(img.data, img.width, img.height, k), k };
  key.outline = outlineOf(img);
  // opaque bounds (+ anchors) of the drawing
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) if (opaque(img.data, y * img.width + x)) { x0 = Math.min(x0, x); x1 = Math.max(x1, x + 1); y0 = Math.min(y0, y); y1 = Math.max(y1, y + 1); }
  for (const a of Object.values(anchors)) { x0 = Math.min(x0, a[0]); x1 = Math.max(x1, a[0]); y0 = Math.min(y0, a[1]); y1 = Math.max(y1, a[1]); }
  key.bounds = x0 === Infinity ? [ref[0], ref[1], ref[0] + 1, ref[1] + 1] : [x0, y0, x1, y1];
  return key;
}

/**
 * 2D sources of an engine: canvases whose meta.fp2d names a source. -> Map name -> {name, kind,
 * class, mag, slot, docs, overrides} (overrides: painted cells that replace generated ones).
 */
export function sources2d(engine) {
  const out = new Map();
  if (!engine?.docs) return out;
  for (const d of engine.docs.values()) {
    const m = d.meta?.fp2d;
    if (!m?.source || !KINDS.includes(m.kind)) continue;
    let s = out.get(m.source);
    if (!s) { s = { name: m.source, kind: m.kind, docs: [], overrides: [] }; out.set(m.source, s); }
    if (m.class && !s.class) s.class = m.class;
    if (m.mag && !s.mag) s.mag = m.mag;
    if (m.slot && !s.slot) s.slot = m.slot;
    (m.override ? s.overrides : s.docs).push(d);
  }
  for (const s of out.values()) { s.docs.sort((a, b) => a.name.localeCompare(b.name)); s.overrides.sort((a, b) => a.name.localeCompare(b.name)); }
  return out;
}
/** Cache key of a source (every canvas's version): a redraw re-sweeps. */
export const sourceKey = (s) => [s.name, s.kind, ...s.docs.map((d) => `${d.name}@${d.version}:${d.updated}:${JSON.stringify(d.meta.fp2d)}`), ...s.overrides.map((d) => `${d.name}@${d.version}:${d.updated}:${JSON.stringify(d.meta.fp2d)}`)].join('|');

/** Gun-space prior of the anchors: the class standard gun's sockets (the geometry every gun of a class shares). */
export function priorSockets(kind, cls) {
  if (kind !== 'gun' || !cls || !GUN_CLASSES.includes(cls)) return {};
  return Object.fromEntries(Object.entries(gunModel(cls).sockets).filter(([, v]) => v?.at).map(([k, v]) => [k, v.at.slice()]));
}

/**
 * Gun-space anchors from the drawings: for every anchor, the 3D point whose projection best meets
 * where it is drawn in every key (Gauss-Newton), held to the class geometry along the directions
 * the drawings cannot see (one key fixes no depth). -> {sockets: {name: [x,y,z]}, residual_px:
 * {name: worst px over keys}, per_key: {key: {name: px}}}
 */
export function fitSockets(keys, kind, cls) {
  const prior = priorSockets(kind, cls), refName = REF[kind];
  const names = new Set([...Object.keys(prior), ...keys.flatMap((k) => Object.keys(k.anchors))]);
  const sockets = { [refName]: [0, 0, 0] }, residual = {}, perKey = Object.fromEntries(keys.map((k) => [k.name, {}]));
  const lam = 0.5; // px^2 per cm^2: weak where a drawing sees the point, firm along the rays it cannot
  for (const n of names) {
    if (n === refName) continue;
    const obs = keys.filter((k) => k.anchors[n]).map((k) => ({ k, q: [(k.anchors[n][0] - k.ref[0]) / k.scale, (k.anchors[n][1] - k.ref[1]) / k.scale] }));
    let X0 = prior[n];
    if (!X0) { if (!obs.length) continue; X0 = unprojectPlane(obs[0].k.R, obs[0].k.n, obs[0].q) || [0, 0, 0]; }
    let X = X0.slice();
    for (let it = 0; it < 10 && obs.length; it++) {
      // normal equations (J^T J + lam I) dx = J^T r - lam (X - X0)
      const A = [[lam, 0, 0], [0, lam, 0], [0, 0, lam]], b = [-lam * (X[0] - X0[0]), -lam * (X[1] - X0[1]), -lam * (X[2] - X0[2])];
      for (const { k, q } of obs) {
        const p = projectRef(k.R, X), e = 1e-3, J = [];
        for (let j = 0; j < 3; j++) { const Xe = X.slice(); Xe[j] += e; const pe = projectRef(k.R, Xe); J.push([(pe[0] - p[0]) / e, (pe[1] - p[1]) / e]); }
        const r = [q[0] - p[0], q[1] - p[1]];
        for (let i = 0; i < 3; i++) { b[i] += J[i][0] * r[0] + J[i][1] * r[1]; for (let j = 0; j < 3; j++) A[i][j] += J[i][0] * J[j][0] + J[i][1] * J[j][1]; }
      }
      const dx = solve3(A, b);
      X = add(X, dx);
      if (Math.hypot(...dx) < 1e-5) break;
    }
    sockets[n] = X.map((v) => Math.round(v * 1000) / 1000);
    let worst = 0;
    for (const { k, q } of obs) { const p = projectRef(k.R, sockets[n]); const e = Math.hypot(p[0] - q[0], p[1] - q[1]); perKey[k.name][n] = r1(e); worst = Math.max(worst, e); }
    if (obs.length) residual[n] = r1(worst);
  }
  if (prior.stock && !sockets.stock) sockets.stock = prior.stock;
  return { sockets, residual_px: residual, per_key: perKey };
}
function solve3(A, b) {
  const det = (M) => M[0][0] * (M[1][1] * M[2][2] - M[1][2] * M[2][1]) - M[0][1] * (M[1][0] * M[2][2] - M[1][2] * M[2][0]) + M[0][2] * (M[1][0] * M[2][1] - M[1][1] * M[2][0]);
  const d = det(A);
  if (Math.abs(d) < 1e-12) return [0, 0, 0];
  return [0, 1, 2].map((j) => det(A.map((row, i) => row.map((v, c) => (c === j ? b[i] : v)))) / d);
}

// ---------- warp ----------
/** Warp a key into rect [x0, y0, w, h] (pixels relative to the reference) seen with rotation Rt. */
export function warpKey(key, Rt, rect, opts = {}) {
  const [x0, y0, w, h] = rect, N = w * h;
  const rgba = new Uint8ClampedArray(N * 4), depth = new Float32Array(N).fill(Infinity);
  const A = mm(key.R, tr(Rt)), Nt = mv(Rt, key.n), ND = -D * Nt[2];
  const { data: B, width: BW, height: BH, k } = key.big;
  const s = key.scale, rx0 = key.ref[0], ry0 = key.ref[1];
  // anchor correction field (target px): the card's picture is displaced so every drawn anchor lands
  // where its 3D point goes; exact at the anchors, fading with distance (inverse square, FIELD_R)
  const fq = opts.field?.q || [], fc = opts.field?.c || [], nf = fq.length, w0 = 1 / (FIELD_R * FIELD_R), Li = opts.field?.Li;
  for (let py = 0; py < h; py++) for (let px = 0; px < w; px++) {
    let vx = x0 + px + 0.5, vy = y0 + py + 0.5;
    if (nf) {
      let sw = w0, cx = 0, cy = 0;
      for (let i = 0; i < nf; i++) { const ddx = vx - fq[i][0], ddy = vy - fq[i][1], wi = 1 / (ddx * ddx + ddy * ddy + 1e-6); sw += wi; cx += wi * fc[i][0]; cy += wi * fc[i][1]; }
      vx -= cx / sw; vy -= cy / sw;
    }
    if (Li) { const ax = Li[0][0] * vx + Li[0][1] * vy, ay = Li[1][0] * vx + Li[1][1] * vy; vx = ax; vy = ay; }
    const dx = vx / F, dy = -vy / F;
    const den = Nt[0] * dx + Nt[1] * dy - Nt[2];
    if (Math.abs(den) < 1e-7) continue;
    const t = ND / den;
    if (!(t > 0.5)) continue;
    // card point in the target eye (t*d), back into gun space, into the key eye
    const ex = dx * t, ey = dy * t, ez = -t + D;
    const Y0 = A[0][0] * ex + A[0][1] * ey + A[0][2] * ez, Y1 = A[1][0] * ex + A[1][1] * ey + A[1][2] * ez, Y2 = A[2][0] * ex + A[2][1] * ey + A[2][2] * ez;
    const z = D - Y2;
    if (!(z > 0.5)) continue;
    const u = rx0 + ((F * Y0) / z) * s, v = ry0 + ((-F * Y1) / z) * s;
    const U = Math.floor(u * k), V = Math.floor(v * k);
    if (U < 0 || V < 0 || U >= BW || V >= BH) continue;
    const si = (V * BW + U) * 4;
    if (B[si + 3] < 128) continue;
    const o = py * w + px;
    rgba[o * 4] = B[si]; rgba[o * 4 + 1] = B[si + 1]; rgba[o * 4 + 2] = B[si + 2]; rgba[o * 4 + 3] = 255;
    depth[o] = t - D;
  }
  if (opts.outline !== false && key.outline) crispen(rgba, w, h, key.outline);
  return { rgba, depth };
}
/**
 * Keep a drawn outline crisp after resampling: silhouette pixels that are not an outline colour take
 * the drawing's outline colour, and lone pixels (no 4-neighbour) go. Only colours of the drawing.
 */
export function crispen(rgba, w, h, outline) {
  const op = (x, y) => x >= 0 && y >= 0 && x < w && y < h && rgba[(y * w + x) * 4 + 3] >= 128;
  const lone = [], edge = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (!op(x, y)) continue;
    const n = [op(x + 1, y), op(x - 1, y), op(x, y + 1), op(x, y - 1)];
    const cnt = n.filter(Boolean).length;
    if (!cnt) { lone.push(y * w + x); continue; }
    if (cnt < 4) edge.push(y * w + x);
  }
  for (const i of lone) rgba[i * 4 + 3] = 0, rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = 0;
  for (const i of edge) {
    const c = (rgba[i * 4] << 16) | (rgba[i * 4 + 1] << 8) | rgba[i * 4 + 2];
    if (!outline.set.has(c)) { rgba[i * 4] = outline.color[0]; rgba[i * 4 + 1] = outline.color[1]; rgba[i * 4 + 2] = outline.color[2]; }
  }
}
/**
 * Correction from where the card puts the anchors (h) to where they belong (q): a linear map L
 * (shear / foreshortening; the reference is fixed, so no translation) fitted by least squares and
 * held toward identity, then a local field for what L leaves (exact at every anchor).
 * -> {Li (L inverse), q, c (residual displacement at q), stretch (how much L can grow distances)}
 */
export function fieldOf(hs, qs) {
  let sxx = 0, sxy = 0, syy = 0, n2 = 0;
  for (const h of hs) { sxx += h[0] * h[0]; sxy += h[0] * h[1]; syy += h[1] * h[1]; n2 += h[0] * h[0] + h[1] * h[1]; }
  const mu = 0.15 * (n2 || 1) + 1;
  const A = [[sxx + mu, sxy], [sxy, syy + mu]], det = A[0][0] * A[1][1] - A[0][1] * A[1][0];
  const L = [0, 1].map((r) => {
    let bx = mu * (r === 0 ? 1 : 0), by = mu * (r === 1 ? 1 : 0);
    hs.forEach((h, i) => { bx += qs[i][r] * h[0]; by += qs[i][r] * h[1]; });
    return [(A[1][1] * bx - A[0][1] * by) / det, (A[0][0] * by - A[1][0] * bx) / det];
  });
  const dL = L[0][0] * L[1][1] - L[0][1] * L[1][0];
  if (!(Math.abs(dL) > 0.2)) return { Li: null, q: qs, c: qs.map((q, i) => [q[0] - hs[i][0], q[1] - hs[i][1]]), stretch: 1 };
  const Li = [[L[1][1] / dL, -L[0][1] / dL], [-L[1][0] / dL, L[0][0] / dL]];
  const c = qs.map((q, i) => [q[0] - (L[0][0] * hs[i][0] + L[0][1] * hs[i][1]), q[1] - (L[1][0] * hs[i][0] + L[1][1] * hs[i][1])]);
  const stretch = Math.max(1, Math.hypot(L[0][0], L[1][0]), Math.hypot(L[0][1], L[1][1])) - 1;
  return { Li, q: qs, c, stretch };
}
/** Rect (relative to the reference) that holds a key seen with Rt (forward-mapped drawing bounds). */
function rectFor(key, Rt) {
  const [x0, y0, x1, y1] = key.bounds;
  const pts = [[x0, y0], [x1, y0], [x0, y1], [x1, y1], [(x0 + x1) / 2, y0], [(x0 + x1) / 2, y1], [x0, (y0 + y1) / 2], [x1, (y0 + y1) / 2]].map((p) => mapPoint(key, Rt, p));
  const ok = pts.filter(Boolean);
  if (ok.length < pts.length) return [-MAX_SHEET / 2, -MAX_SHEET / 2, MAX_SHEET, MAX_SHEET];
  const X0 = Math.floor(Math.min(...ok.map((p) => p[0]))) - 2, Y0 = Math.floor(Math.min(...ok.map((p) => p[1]))) - 2;
  const X1 = Math.ceil(Math.max(...ok.map((p) => p[0]))) + 2, Y1 = Math.ceil(Math.max(...ok.map((p) => p[1]))) + 2;
  const w = clamp(X1 - X0, 1, MAX_SHEET * 2), h = clamp(Y1 - Y0, 1, MAX_SHEET * 2);
  return [X0, Y0, w, h];
}
/** Nearest key of a cell rotation (ties: the first key by name). */
export function nearestKey(keys, Rt) {
  let best = null, bd = Infinity;
  for (const k of keys) { const d = rotDist(k.R, Rt); if (d < bd - 1e-9) { bd = d; best = k; } }
  return { key: best, dist: bd };
}

/**
 * Sweep of a 2D source: the same shape renderSweep returns. src: {name, kind, class, mag, slot,
 * docs, overrides}; grid {yaw, pitch}; o: {state, names (anchor list), pad, cell, outline}.
 * -> {def, cells, depths, kind, ref, stats, fit, keys (the key of each cell), palette}
 */
export function sweep2d(src, grid, o = {}) {
  const kind = src.kind, refName = REF[kind];
  const docs = src.docs.filter((d) => (d.meta.fp2d.state ?? null) === (o.state ?? null));
  const base = src.docs.filter((d) => !d.meta.fp2d.state);
  const use = docs.length ? docs : base;
  if (!use.length) throw new Error(`2D source "${src.name}" has no key drawings${o.state ? ` for state ${o.state}` : ''}`);
  const keys = use.map((d) => keyOf(d, kind, src.class));
  const fit = fitSockets(keys, kind, src.class);
  const yaws = anglesOf(grid.yaw || [0, 0, 1]), pitches = anglesOf(grid.pitch || [0, 0, 1]);
  if (yaws.length * pitches.length > 2000) throw new Error('sweep2d: too many cells (max 2000)');
  // anchor list: the contract anchors of the kind the source has (drawn or from the class), + any extra drawn
  const prior = priorSockets(kind, src.class);
  const drawn = new Set(keys.flatMap((k) => Object.keys(k.anchors)));
  const have = new Set([refName, ...drawn, ...(kind === 'gun' ? Object.keys(prior) : [])]);
  have.delete('stock');
  const names = o.names || [...(ANCHORS[kind] || []).filter((n) => have.has(n)), ...[...have].filter((n) => !(ANCHORS[kind] || []).includes(n)).sort()];
  const t0 = performance.now();
  const raw = [];
  const ovr = new Map();
  for (const d of src.overrides) { const m = d.meta.fp2d; if ((m.state ?? null) === (o.state ?? null)) ovr.set(`${+m.override.yaw}|${+m.override.pitch}`, d); }
  for (const pitch of pitches) for (const yaw of yaws) {
    const Rt = cellRotation(yaw, pitch);
    const { key, dist } = nearestKey(keys, Rt);
    // drawn anchors move with their 3D points (keeping the key's own residual, so a key angle is exact);
    // the card picture follows through the correction field. Far from its key (FIELD_FADE) a drawing
    // cannot show what turned into view, so the correction fades out and the cell stays a plain card;
    // the anchors always stay where the pixels go.
    const alpha = clamp((FIELD_FADE[1] - dist) / (FIELD_FADE[1] - FIELD_FADE[0]), 0, 1);
    const anchors = {}, hs = [], qs = [];
    for (const [n, a] of Object.entries(key.anchors)) {
      const X = fit.sockets[n], h = mapPoint(key, Rt, a);
      if (!X || !h) continue;
      const rel = [(a[0] - key.ref[0]) / key.scale, (a[1] - key.ref[1]) / key.scale], pk = projectRef(key.R, X), pt = projectRef(Rt, X);
      const q0 = [pt[0] + rel[0] - pk[0], pt[1] + rel[1] - pk[1]], q = [h[0] + alpha * (q0[0] - h[0]), h[1] + alpha * (q0[1] - h[1])];
      anchors[n] = [q[0], q[1], pt[2]];
      hs.push(h); qs.push(q);
    }
    const field = fieldOf(hs, qs);
    let reach = 0;
    for (const [x, y] of [[key.bounds[0], key.bounds[1]], [key.bounds[2], key.bounds[3]], [key.bounds[0], key.bounds[3]], [key.bounds[2], key.bounds[1]]]) { const h = mapPoint(key, Rt, [x, y]); if (h) reach = Math.max(reach, Math.hypot(h[0], h[1]) * field.stretch); }
    reach += Math.max(0, ...field.c.map((c) => Math.hypot(...c)));
    for (const n of names) if (!anchors[n] && fit.sockets[n]) anchors[n] = projectRef(Rt, fit.sockets[n]);
    const r0 = rectFor(key, Rt), m = Math.ceil(reach) + 2;
    const rect = [r0[0] - m, r0[1] - m, r0[2] + 2 * m, r0[3] + 2 * m];
    const w = warpKey(key, Rt, rect, { outline: o.outline, field });
    anchors[refName] = [0, 0, D];
    raw.push({ yaw, pitch, rect, ...w, anchors, key: key.name, dist });
  }
  // one cell size for the sweep (as renderSweep): union of every cell's pixels and anchors
  let ux0 = Infinity, uy0 = Infinity, ux1 = -Infinity, uy1 = -Infinity;
  for (const c of raw) {
    const [x0, y0, w, h] = c.rect;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (c.rgba[(y * w + x) * 4 + 3]) { ux0 = Math.min(ux0, x0 + x); ux1 = Math.max(ux1, x0 + x + 1); uy0 = Math.min(uy0, y0 + y); uy1 = Math.max(uy1, y0 + y + 1); }
    for (const a of Object.values(c.anchors)) { ux0 = Math.min(ux0, Math.floor(a[0])); ux1 = Math.max(ux1, Math.ceil(a[0]) + 1); uy0 = Math.min(uy0, Math.floor(a[1])); uy1 = Math.max(uy1, Math.ceil(a[1]) + 1); }
  }
  // overrides keep their own pixels: the cell must hold them around the grip
  for (const d of ovr.values()) { const g = d.meta.fp2d.grip || [0, 0]; ux0 = Math.min(ux0, -Math.floor(g[0])); uy0 = Math.min(uy0, -Math.floor(g[1])); ux1 = Math.max(ux1, d.width - Math.floor(g[0])); uy1 = Math.max(uy1, d.height - Math.floor(g[1])); }
  if (ux0 === Infinity) { ux0 = 0; uy0 = 0; ux1 = 1; uy1 = 1; }
  const pad = o.pad ?? 1;
  ux0 -= pad; uy0 -= pad; ux1 += pad; uy1 += pad;
  let cw = ux1 - ux0, ch = uy1 - uy0;
  cw += cw & 1; ch += ch & 1;
  if (o.cell) { const [fw, fh] = o.cell; ux0 -= Math.floor((fw - cw) / 2); uy0 -= Math.floor((fh - ch) / 2); cw = fw; ch = fh; }
  if (cw > MAX_SHEET || ch > MAX_SHEET) throw new Error(`sweep2d "${src.name}": a cell would be ${cw}x${ch} px (max ${MAX_SHEET}): narrow the grid or add key drawings nearer the cells (an edge-on card spreads)`);
  const cells = [], depths = [], anchors = Object.fromEntries(names.map((n) => [n, []])), overridden = [];
  for (const c of raw) {
    const img = new Uint8ClampedArray(cw * ch * 4), dep = new Float32Array(cw * ch).fill(Infinity);
    const [x0, y0, w, h] = c.rect;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const s = y * w + x;
      if (!c.rgba[s * 4 + 3]) continue;
      const X = x0 + x - ux0, Y = y0 + y - uy0;
      if (X < 0 || Y < 0 || X >= cw || Y >= ch) continue;
      img.set(c.rgba.subarray(s * 4, s * 4 + 4), (Y * cw + X) * 4);
      dep[Y * cw + X] = c.depth[s];
    }
    const od = ovr.get(`${c.yaw}|${c.pitch}`);
    if (od) {
      // a painted cell: its pixels replace the generated ones (placed by its grip), depth stays the card's
      img.fill(0);
      const g = od.meta.fp2d.grip || [0, 0], data = artOf(od).data, gx = Math.floor(-ux0 - g[0]), gy = Math.floor(-uy0 - g[1]);
      for (let y = 0; y < od.height; y++) for (let x = 0; x < od.width; x++) {
        const s = y * od.width + x, X = x + gx, Y = y + gy;
        if (data[s * 4 + 3] < 128 || X < 0 || Y < 0 || X >= cw || Y >= ch) continue;
        img.set(data.subarray(s * 4, s * 4 + 4), (Y * cw + X) * 4);
        if (dep[Y * cw + X] === Infinity) dep[Y * cw + X] = 0;
      }
      overridden.push({ yaw: c.yaw, pitch: c.pitch, canvas: od.name });
    }
    cells.push(img); depths.push(dep);
    for (const n of names) { const a = c.anchors[n]; anchors[n].push(a ? [r1(a[0] - ux0), r1(a[1] - uy0)] : anchors[n][anchors[n].length - 1] ?? [0, 0]); }
  }
  const def = {
    ...(src.class ? { class: src.class } : {}), cell: [cw, ch], yaw: grid.yaw || [0, 0, 1], pitch: grid.pitch || [0, 0, 1], anchors,
    ...(kind === 'gun' && (src.mag || (src.class && GUN_CLASSES.includes(src.class))) ? { mag: src.mag || gunModel(src.class).fp.mag } : {}), ...(src.slot ? { slot: src.slot } : {}),
  };
  const palette = colorSet(...keys.map((k) => k.img.data), ...[...ovr.values()].map((d) => artOf(d).data));
  return {
    def, cells, depths, kind, ref: refName, fit, palette, keys: raw.map((c) => c.key), overridden,
    stats: { cells: cells.length, cell: [cw, ch], keys: keys.length, ms: Math.round(performance.now() - t0), px_per_m: Math.round((F / D) * 1000) / 10, worst_key_distance_deg: r1(Math.max(...raw.map((c) => c.dist))) },
  };
}

// ---------- anchor tools ----------
/** Screen basis of a key: forward (gun -Z) and up (gun +Y) per drawing px, foreshortening (1 = full length). */
function basisOf(R, scale = 1) {
  const s0 = F / D, o = projectRef(R, [0, 0, 0]), f = projectRef(R, [0, 0, -10]), u = projectRef(R, [0, 10, 0]);
  const fv = [(f[0] - o[0]) * scale, (f[1] - o[1]) * scale], uv = [(u[0] - o[0]) * scale, (u[1] - o[1]) * scale];
  return { f: fv, u: uv, ff: Math.hypot(...fv) / (10 * s0 * scale), fu: Math.hypot(...uv) / (10 * s0 * scale) };
}
/**
 * Anchor suggestions from the silhouette of a drawing (kind, class, view) -> {name: {at: [x, y],
 * confidence 0..1, why}}. Guns: muzzle = forward-most barrel tip; grip = top of the rear-most
 * protrusion under the receiver (the pistol grip); mag_well = bottom of the next protrusion forward;
 * support / underbarrel = handguard underside, optic / sight / charging = top edge, at the class
 * geometry's share of the grip-to-muzzle length; muzzle_mount = muzzle. Magazines: mount = top
 * centre. Attachments: mount = the edge that meets the gun. Items: grip = middle of the mass.
 * Other keys of the same source (fitted 3D anchors) override with their own confidence.
 */
export function suggestAnchors(img, meta, fit = null) {
  const kind = meta.kind || 'gun', R = keyRotation(meta), scale = Number(meta.scale ?? 1);
  const B = basisOf(R, scale);
  const { width: W, height: H, data } = img;
  const pts = [];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (opaque(data, y * W + x)) pts.push([x + 0.5, y + 0.5]);
  const out = {};
  if (!pts.length) return out;
  // coordinates along (forward) / up in the drawing (solve p = a f^ + b u^ with unit screen vectors)
  const fl = Math.hypot(...B.f) || 1, ul = Math.hypot(...B.u) || 1;
  const fh = [B.f[0] / fl, B.f[1] / fl], uh = [B.u[0] / ul, B.u[1] / ul];
  const det = fh[0] * uh[1] - fh[1] * uh[0];
  const ok = Math.abs(det) > 0.2;
  const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length, cy = pts.reduce((s, p) => s + p[1], 0) / pts.length;
  const toAU = (p) => { const dx = p[0] - cx, dy = p[1] - cy; return [(dx * uh[1] - dy * uh[0]) / det, (fh[0] * dy - fh[1] * dx) / det]; };
  const toXY = (a, u) => [r1(cx + a * fh[0] + u * uh[0]), r1(cy + a * fh[1] + u * uh[1])];
  const view = clamp(Math.min(B.ff, B.fu) / 0.6, 0, 1); // foreshortened views are unreliable
  const put = (n, at, conf, why) => { if (at) out[n] = { at, confidence: Math.round(conf * view * 100) / 100, why }; };
  if (ok) {
    const au = pts.map(toAU);
    const a0 = Math.min(...au.map((p) => p[0])), a1 = Math.max(...au.map((p) => p[0]));
    const bins = new Map();
    for (const [a, u] of au) { const k = Math.round(a); const b = bins.get(k) || { lo: Infinity, hi: -Infinity }; b.lo = Math.min(b.lo, u); b.hi = Math.max(b.hi, u); bins.set(k, b); }
    const ks = [...bins.keys()].sort((x, y) => x - y);
    const col = (a) => { let best = null, bd = Infinity; for (const k of ks) { const d = Math.abs(k - a); if (d < bd) { bd = d; best = bins.get(k); } } return best; };
    const height = Math.max(...ks.map((k) => bins.get(k).hi)) - Math.min(...ks.map((k) => bins.get(k).lo));
    if (kind === 'gun') {
      const front = col(a1);
      put('muzzle', toXY(a1 - 0.5, (front.lo + front.hi) / 2), front.hi - front.lo < height * 0.35 ? 0.85 : 0.5, 'forward-most tip of the silhouette');
      if (out.muzzle) out.muzzle_mount = { ...out.muzzle, why: 'the muzzle' };
      const lows = ks.map((k) => bins.get(k).lo).sort((x, y) => x - y);
      const baseLo = lows[Math.floor(lows.length * 0.6)];
      // protrusions under the receiver: runs of columns that reach well below the receiver's underside
      const runs = [];
      let cur = null;
      for (const k of ks) {
        const deep = bins.get(k).lo < baseLo - height * 0.18;
        if (deep) { if (!cur) cur = { a0: k, a1: k, lo: Infinity }; cur.a1 = k; cur.lo = Math.min(cur.lo, bins.get(k).lo); } else if (cur) { runs.push(cur); cur = null; }
      }
      if (cur) runs.push(cur);
      const geo = meta.class && GUN_CLASSES.includes(meta.class) ? fpGeometry(meta.class) : null;
      const big = runs.filter((r) => r.a1 - r.a0 >= 2);
      if (big.length) {
        const g = big[0];
        // the grip anchor is the trigger hand's palm: the top of the pistol grip, under the receiver
        put('grip', toXY(g.a1 - (g.a1 - g.a0) * 0.35, baseLo), big.length >= 2 ? 0.65 : 0.45, 'top of the rear-most protrusion under the receiver (pistol grip)');
        if (big[1]) put('mag_well', toXY((big[1].a0 + big[1].a1) / 2, big[1].lo + 0.5), 0.7, 'bottom of the protrusion forward of the grip (magazine well)');
      } else put('grip', toXY(a0 + (a1 - a0) * 0.2, baseLo), 0.25, 'no grip protrusion found: rear fifth of the underside');
      // class shares of the grip-to-muzzle length (gun space: -z forward)
      const gp = out.grip ? toAU(out.grip.at) : [a0, baseLo];
      const L = a1 - gp[0];
      if (geo && L > 4) {
        const mz = -geo.muzzle[2] || 1, share = (p) => gp[0] + (-p[2] / mz) * L;
        const bottom = (a) => col(a).lo + 0.5, top = (a) => col(a).hi - 0.5;
        if (geo.kind === 'long') put('support', toXY(share(geo.support), bottom(share(geo.support))), 0.5, 'handguard underside at the class support share');
        put('underbarrel', toXY(share(geo.underbarrel), bottom(share(geo.underbarrel))), 0.45, 'handguard underside at the class underbarrel share');
        put('sight', toXY(share(geo.sight), top(share(geo.sight))), 0.45, 'top edge at the class rear-sight share');
        if (geo.kind === 'long') put('optic', toXY(share(geo.optic), top(share(geo.optic))), 0.45, 'rail top at the class optic share');
        put('charging', toXY(share(geo.charging), top(share(geo.charging))), 0.35, 'top edge at the class charging-handle share');
        if (!out.mag_well) put('mag_well', toXY(share(geo.mag_well), bottom(share(geo.mag_well))), 0.35, 'underside at the class magazine-well share');
        if (geo.kind === 'pistol') put('support', toXY(gp[0] - 0.4 * (-geo.support[2]), gp[1] + geo.support[1]), 0.4, 'class support offset from the grip');
      }
    } else if (kind === 'mag') {
      const topU = Math.max(...au.map((p) => p[1])), band = au.filter((p) => p[1] > topU - 2);
      put('mount', toXY(band.reduce((s, p) => s + p[0], 0) / band.length, topU), 0.8, 'top centre (where it seats in the well)');
    } else if (kind === 'attachment') {
      const slot = meta.slot || 'optic';
      if (slot === 'muzzle') {
        const rear = col(a0), frontC = col(a1);
        put('mount', toXY(a0, (rear.lo + rear.hi) / 2), 0.75, 'rear end centre (meets the muzzle)');
        put('muzzle', toXY(a1, (frontC.lo + frontC.hi) / 2), 0.75, 'front end centre');
      } else if (slot === 'underbarrel') {
        const topU = Math.max(...au.map((p) => p[1])), band = au.filter((p) => p[1] > topU - 2);
        const am = band.reduce((s, p) => s + p[0], 0) / band.length;
        put('mount', toXY(am, topU), 0.75, 'top centre (meets the rail)');
        const c = col(am);
        put('support', toXY(am, (c.lo + c.hi) / 2), 0.5, 'middle of the grip');
      } else {
        const lowU = Math.min(...au.map((p) => p[1])), band = au.filter((p) => p[1] < lowU + 2);
        const am = band.reduce((s, p) => s + p[0], 0) / band.length;
        put('mount', toXY(am, lowU), 0.75, 'bottom centre (meets the rail)');
        const c = col(am);
        put('sight', toXY(am, c.lo + (c.hi - c.lo) * 0.65), 0.45, 'upper middle of the body (aim point)');
      }
    }
  }
  if (kind === 'item' || !ok) put(REF[kind], [r1(cx), r1(cy)], ok ? 0.5 : 0.2, 'middle of the mass');
  // other drawings of the source: their fitted 3D anchors projected into this view
  if (fit?.sockets && out[REF[kind]] !== undefined) {
    const ref = meta.anchors?.[REF[kind]] || out[REF[kind]].at;
    for (const [n, X] of Object.entries(fit.sockets)) {
      if (n === REF[kind] || n === 'stock') continue;
      const p = projectRef(R, X), at = [r1(ref[0] + p[0] * scale), r1(ref[1] + p[1] * scale)];
      const conf = fit.keys >= 2 ? 0.9 : 0.6;
      if (!out[n] || out[n].confidence < conf) out[n] = { at, confidence: conf, why: `projected from the anchors of ${fit.keys} other drawing(s) of "${meta.source}"` };
    }
  }
  return out;
}
/** Anchors that sit on nothing: no opaque pixel within r px. -> [{anchor, at, issue}] */
export function anchorsOffArt(img, anchors, r = 3) {
  const out = [];
  const { width: W, height: H, data } = img;
  for (const [n, a] of Object.entries(anchors || {})) {
    let hit = false;
    for (let y = Math.floor(a[1] - r); y <= Math.ceil(a[1] + r) && !hit; y++) for (let x = Math.floor(a[0] - r); x <= Math.ceil(a[0] + r) && !hit; x++) {
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      if (Math.hypot(x + 0.5 - a[0], y + 0.5 - a[1]) <= r + 0.71 && opaque(data, y * W + x)) hit = true;
    }
    if (!hit) out.push({ anchor: n, at: a, issue: `${n} at [${a.map(r1)}] is not on the drawing (no opaque pixel within ${r} px)` });
  }
  return out;
}

// ---------- templates ----------
/**
 * Layout of a blank key canvas: the class standard anchors projected into the view (where to draw
 * so the hands land on the class geometry), the bore line and the extent of the standard gun.
 * -> {width, height, anchors, guides: [draw commands], grid_note}
 */
export function gunTemplate(kind, cls, meta) {
  const R = keyRotation(meta);
  const prior = priorSockets(kind, cls);
  const pts = { ...prior };
  if (kind === 'gun' && cls) { const g = fpGeometry(cls); pts.rear = [0, g.bore, 8]; }
  if (kind !== 'gun') pts[REF[kind]] = [0, 0, 0];
  const P = Object.fromEntries(Object.entries(pts).map(([k, X]) => [k, projectRef(R, X)]));
  const xs = Object.values(P).map((p) => p[0]), ys = Object.values(P).map((p) => p[1]);
  const margin = kind === 'gun' ? 28 : 12;
  // room around the reference for the other kinds (a magazine hangs below its mount)
  const [[ex0, ey0], [ex1, ey1]] = kind === 'gun' ? [[0, 0], [0, 0]] : ({ mag: [[-30, -14], [30, 90]], attachment: [[-60, -36], [60, 36]], item: [[-60, -60], [60, 60]] })[kind];
  const x0 = Math.floor(Math.min(...xs, ex0)) - margin, y0 = Math.floor(Math.min(...ys, ey0)) - margin;
  const width = Math.min(1024, Math.ceil(Math.max(...xs, ex1)) + margin - x0), height = Math.min(1024, Math.ceil(Math.max(...ys, ey1)) + margin - y0);
  const at = (k) => [r1(P[k][0] - x0), r1(P[k][1] - y0)];
  const anchors = Object.fromEntries(Object.keys(P).filter((k) => k !== 'rear' && k !== 'stock').map((k) => [k, at(k)]));
  const guides = [];
  const G = '#ff40ff', G2 = '#40c0ff';
  if (P.rear && P.muzzle) guides.push({ op: 'line', x1: Math.round(at('rear')[0]), y1: Math.round(at('rear')[1]), x2: Math.round(at('muzzle')[0]), y2: Math.round(at('muzzle')[1]), color: G2 });
  for (const [k, a] of Object.entries(anchors)) {
    const x = Math.floor(a[0]), y = Math.floor(a[1]);
    guides.push({ op: 'pixels', color: G, points: [[x, y], [x - 2, y], [x + 2, y], [x, y - 2], [x, y + 2]].filter(([px, py]) => px >= 0 && py >= 0 && px < width && py < height) });
    void k;
  }
  return { width, height, anchors, guides };
}
