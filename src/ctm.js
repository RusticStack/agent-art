// Connected textures (CTM, like OptiFine / Continuity): tile selection from neighbours, tileset
// generation from a base texture (+ border/edge style) or a hand-drawn template, and the
// adjacency-aware bake pass that picks a tile per face cell across every placed piece.
//
// Neighbour bits (screen directions on the face; N = up on walls, back (-z) on floors):
//   N=1 NE=2 E=4 SE=8 S=16 SW=32 W=64 NW=128
// Blob ("full", 47 tiles): a corner bit only counts when both of its edges are connected.

export const BITS = { n: 1, ne: 2, e: 4, se: 8, s: 16, sw: 32, w: 64, nw: 128 };
export const CTM_METHODS = ['full', 'compact', 'horizontal', 'vertical', 'horizontal+vertical', 'top', 'random', 'repeat', 'overlay'];

// ---- reference tile selection (copied verbatim into docs/3d/README.md for engines; keep self-contained) ----
/**
 * ctmTileFor(neighbors, method, opts) -> tile index into the tileset (compact: [tl, tr, br, bl]
 * indices of the 5 compact tiles). neighbors: 8-bit mask (N1 NE2 E4 SE8 S16 SW32 W64 NW128),
 * an array of 8 booleans in that order, or {n, ne, e, se, s, sw, w, nw}.
 * opts: cell [x, y, z?] (random, repeat), weights (random), seed (random), repeat [cols, rows].
 */
export function ctmTileFor(neighbors, method = 'full', opts = {}) {
  const K = ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'];
  let m = 0;
  if (typeof neighbors === 'number') m = neighbors & 255;
  else if (Array.isArray(neighbors)) neighbors.forEach((v, i) => { if (v) m |= 1 << i; });
  else K.forEach((k, i) => { if (neighbors && neighbors[k]) m |= 1 << i; });
  const blob = (x) => {
    let r = x & 85; // edges N E S W
    if (x & 1 && x & 4 && x & 2) r |= 2;
    if (x & 4 && x & 16 && x & 8) r |= 8;
    if (x & 16 && x & 64 && x & 32) r |= 32;
    if (x & 64 && x & 1 && x & 128) r |= 128;
    return r;
  };
  const N = !!(m & 1), E = !!(m & 4), S = !!(m & 16), W = !!(m & 64);
  const cell = opts.cell || [0, 0, 0];
  const hash = () => {
    let h = (opts.seed ?? 1) ^ 0x9e3779b9;
    for (const v of [cell[0] | 0, cell[1] | 0, (cell[2] ?? 0) | 0]) { h = Math.imul(h ^ v, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16; }
    return (h >>> 0) / 4294967296;
  };
  switch (method) {
    case 'full':
    case 'overlay': {
      if (!ctmTileFor.blobIndex) {
        const masks = [...new Set([...Array(256).keys()].map(blob))].sort((a, b) => a - b);
        ctmTileFor.blobIndex = new Map(masks.map((x, i) => [x, i]));
      }
      // overlay: bits mean "the other material is there"; its tiles are the blob set of the complement
      return ctmTileFor.blobIndex.get(blob(method === 'overlay' ? ~m & 255 : m));
    }
    case 'compact': {
      const q = (v, h, d) => (v && h ? (d ? 1 : 4) : v ? 3 : h ? 2 : 0);
      return [q(N, W, m & 128), q(N, E, m & 2), q(S, E, m & 8), q(S, W, m & 32)];
    }
    case 'horizontal': return (W ? 1 : 0) | (E ? 2 : 0);
    case 'vertical': return (N ? 1 : 0) | (S ? 2 : 0);
    case 'horizontal+vertical': return (N ? 1 : 0) | (E ? 2 : 0) | (S ? 4 : 0) | (W ? 8 : 0);
    case 'top': return N ? 0 : 1;
    case 'random': {
      const w = opts.weights && opts.weights.length ? opts.weights : [1];
      let r = hash() * w.reduce((a, b) => a + b, 0);
      for (let i = 0; i < w.length; i++) { r -= w[i]; if (r < 0) return i; }
      return w.length - 1;
    }
    case 'repeat': {
      const [cw, ch] = opts.repeat || [1, 1];
      const mod = (a, n) => ((a % n) + n) % n;
      return mod(cell[0], cw) + mod(cell[1], ch) * cw;
    }
    default: throw new Error(`unknown CTM method "${method}"`);
  }
}
// ---- end reference ----

const blobReduce = (x) => {
  let r = x & 85;
  if (x & 1 && x & 4 && x & 2) r |= 2;
  if (x & 4 && x & 16 && x & 8) r |= 8;
  if (x & 16 && x & 64 && x & 32) r |= 32;
  if (x & 64 && x & 1 && x & 128) r |= 128;
  return r;
};
export const BLOB_MASKS = [...new Set([...Array(256).keys()].map(blobReduce))].sort((a, b) => a - b);

// ---------- tile rendering ----------
const h2 = (x, y, s) => {
  let h = Math.imul((s | 0) ^ 0x27d4eb2d, 0x9e3779b1) ^ Math.imul(x | 0, 0x85ebca6b) ^ Math.imul(y | 0, 0xc2b2ae35);
  h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); h ^= h >>> 12;
  return (h >>> 0) / 4294967296;
};
/**
 * Render one tile for a neighbour mask: every pixel gets its distance to the nearest
 * unconnected edge (or inner-corner notch); paint(x, y, d, side, basePixel) decides.
 */
export function renderBlob(mask, T, basePx, paint) {
  const out = new Uint8ClampedArray(T * T * 4);
  const N = mask & 1, E = mask & 4, S = mask & 16, W = mask & 64;
  for (let y = 0; y < T; y++) for (let x = 0; x < T; x++) {
    let d = Infinity, side = null;
    const take = (v, s) => { if (v < d) { d = v; side = s; } };
    if (!N) take(y, 'n');
    if (!W) take(x, 'w');
    if (!S) take(T - 1 - y, 's');
    if (!E) take(T - 1 - x, 'e');
    if (N && E && !(mask & 2)) take(Math.max(y, T - 1 - x), 'ne');
    if (S && E && !(mask & 8)) take(Math.max(T - 1 - y, T - 1 - x), 'se');
    if (S && W && !(mask & 32)) take(Math.max(T - 1 - y, x), 'sw');
    if (N && W && !(mask & 128)) take(Math.max(y, x), 'nw');
    const b = basePx(x, y);
    const p = side ? paint(x, y, d, side, b) : null;
    out.set(p || b, (y * T + x) * 4);
  }
  return out;
}
/** Compose a blob tile from the 5 compact tiles (0 none, 1 all, 2 horizontal, 3 vertical, 4 inner corners). */
export function composeCompact(compact, mask, T) {
  const q = ctmTileFor(mask, 'compact');
  const out = new Uint8ClampedArray(T * T * 4), h = T >> 1;
  const quads = [[0, 0], [h, 0], [h, h], [0, h]];
  quads.forEach(([qx, qy], k) => {
    const src = compact[q[k]];
    for (let y = qy; y < (k >= 2 ? T : h); y++) for (let x = qx; x < (k === 1 || k === 2 ? T : h); x++) out.set(src.subarray((y * T + x) * 4, (y * T + x) * 4 + 4), (y * T + x) * 4);
  });
  return out;
}

const shadeP = (p, k) => [Math.min(255, p[0] * k), Math.min(255, p[1] * k), Math.min(255, p[2] * k), p[3]];
function borderPainter(border, avg) {
  const width = Math.max(1, Number(border.width ?? 2));
  const style = border.style || (border.color ? 'line' : 'bevel');
  const light = border.light, dark = border.dark, color = border.color || [avg[0] * 0.55, avg[1] * 0.55, avg[2] * 0.55, 255];
  return {
    width,
    paint: (x, y, d, side, b) => {
      if (d >= width || !b[3]) return null;
      if (style === 'line') return color;
      const lit = side === 'n' || side === 'w' || side === 'nw' || side === 'sw';
      return lit ? light || shadeP(b, 1.3) : dark || shadeP(b, 0.6);
    },
  };
}
const SPLIT = (img, T) => {
  const cols = Math.floor(img.width / T), rows = Math.floor(img.height / T), tiles = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const t = new Uint8ClampedArray(T * T * 4);
    for (let y = 0; y < T; y++) t.set(img.data.subarray(((r * T + y) * img.width + c * T) * 4, ((r * T + y) * img.width + c * T + T) * 4), y * T * 4);
    tiles.push(t);
  }
  return tiles;
};
const transformTile = (src, T, f) => {
  const out = new Uint8ClampedArray(T * T * 4);
  for (let y = 0; y < T; y++) for (let x = 0; x < T; x++) { const [sx, sy] = f(x, y); out.set(src.subarray((sy * T + sx) * 4, (sy * T + sx) * 4 + 4), (y * T + x) * 4); }
  return out;
};

/** Neighbour masks rendered for each tile of a method (edge-only methods treat the other axis as connected). */
export function methodMasks(method) {
  switch (method) {
    case 'full': case 'overlay': return BLOB_MASKS;
    case 'compact': return [0, 255, 4 | 64, 1 | 16, 1 | 4 | 16 | 64];
    case 'horizontal': return [0, 1, 2, 3].map((i) => 1 | 16 | (i & 1 ? 64 | 128 | 32 : 0) | (i & 2 ? 4 | 2 | 8 : 0));
    case 'vertical': return [0, 1, 2, 3].map((i) => 4 | 64 | (i & 1 ? 1 | 2 | 128 : 0) | (i & 2 ? 16 | 8 | 32 : 0));
    case 'horizontal+vertical': return [...Array(16).keys()].map((i) => blobReduce(((i & 1 ? 1 : 0) | (i & 2 ? 4 : 0) | (i & 4 ? 16 : 0) | (i & 8 ? 64 : 0)) | 170));
    case 'top': return [255, 255 & ~(1 | 2 | 128)];
    default: return null;
  }
}

/**
 * Build a CTM tileset. base/template/overlay/variants are images {width, height, data}.
 * -> { width, height, data, meta }
 */
export function generateCTM(o) {
  const method = o.method || 'full';
  if (!CTM_METHODS.includes(method)) throw new Error(`ctm method must be one of ${CTM_METHODS.join(', ')}`);
  // random with only variants: the first variant is the base (tile size, average colour)
  const base = o.base || (method === 'random' && o.variants && o.variants.length ? o.variants[0] : null);
  if (!base && !o.template && method !== 'overlay') throw new Error(`ctm needs base (a tileable canvas) or template${method === 'random' ? ' or variants' : ''}`);
  let T = Number(o.tile ?? (method === 'repeat' ? 32 : base ? base.width : o.template ? o.template.height : o.overlay ? o.overlay.width : 16));
  if (!(T >= 2)) throw new Error('tile size must be >= 2');
  if (method !== 'repeat' && T % 2) T -= 1;
  const basePx = base ? (x, y) => { const p = ((y % base.height) * base.width + (x % base.width)) * 4; return base.data.subarray(p, p + 4); } : () => [0, 0, 0, 0];
  let avg = [128, 128, 128];
  if (base) { const s = [0, 0, 0]; let n = 0; for (let i = 0; i < base.data.length; i += 4) if (base.data[i + 3]) { s[0] += base.data[i]; s[1] += base.data[i + 1]; s[2] += base.data[i + 2]; n++; } if (n) avg = s.map((v) => v / n); }
  let tiles, cols, meta = { method, tile: T, connect: o.connect || 'material', bits: BITS };
  const masks = methodMasks(method);
  const fromTemplate = o.template ? SPLIT(o.template, T) : null;
  if (method === 'repeat') {
    if (!base || base.width % T || base.height % T) throw new Error(`repeat: base must be a multiple of the tile size (${T}) in both directions, e.g. a 96x64 slab pattern = 3x2 cells`);
    tiles = SPLIT(base, T);
    cols = base.width / T;
    meta.repeat = [cols, base.height / T];
  } else if (method === 'random') {
    const vs = o.variants && o.variants.length ? o.variants.map((v) => SPLIT(v, T)[0]) : fromTemplate || (() => {
      const b = SPLIT({ width: T, height: T, data: Uint8ClampedArray.from({ length: T * T * 4 }, (_, i) => basePx(Math.floor(i / 4) % T, Math.floor(i / 4 / T))[i % 4]) }, T)[0];
      return [b, transformTile(b, T, (x, y) => [T - 1 - x, y]), transformTile(b, T, (x, y) => [x, T - 1 - y]), transformTile(b, T, (x, y) => [T - 1 - x, T - 1 - y])];
    })();
    tiles = vs;
    cols = Math.min(8, vs.length);
    meta.weights = (o.weights || vs.map(() => 1)).map(Number);
    if (meta.weights.length !== vs.length) throw new Error(`random: weights (${meta.weights.length}) must match variants (${vs.length})`);
    meta.seed = Number(o.seed ?? 1);
  } else if (fromTemplate && fromTemplate.length === masks.length) {
    tiles = fromTemplate;
  } else if (fromTemplate && fromTemplate.length >= 5 && (method === 'full' || method === 'overlay')) {
    tiles = masks.map((m) => composeCompact(fromTemplate, m, T)); // hand-drawn compact template -> 47
  } else if (fromTemplate) {
    throw new Error(`template has ${fromTemplate.length} tiles of ${T}px; ${method} needs ${masks.length}${method === 'full' ? ' (or the 5 compact tiles: none, all, horizontal, vertical, inner corners)' : ''}`);
  } else if (method === 'overlay') {
    const ov = o.overlay;
    if (!ov) throw new Error('overlay method needs overlay: <canvas> (moss, blood, wax...)');
    const creep = Number(o.creep ?? Math.max(2, T / 4)), seed = Number(o.seed ?? 1);
    const ovPx = (x, y) => { const p = ((y % ov.height) * ov.width + (x % ov.width)) * 4; return ov.data.subarray(p, p + 4); };
    // bit set = the source material is there: it creeps in from those edges
    tiles = masks.map((m) => renderBlob(m, T, () => [0, 0, 0, 0], (x, y, d) => (d < creep * (0.45 + 1.1 * h2(x, y, seed)) ? ovPx(x, y) : null)));
    meta.creep = creep;
  } else {
    const bp = borderPainter(o.border || {}, avg);
    if (bp.width * 2 >= T) throw new Error(`border width ${bp.width} must be below half the tile (${T / 2})`);
    tiles = masks.map((m) => renderBlob(m, T, basePx, bp.paint));
    meta.border = { width: bp.width, style: (o.border || {}).style || ((o.border || {}).color ? 'line' : 'bevel') };
  }
  if (masks && method !== 'repeat' && method !== 'random') meta.masks = masks;
  cols = cols || (method === 'full' || method === 'overlay' ? 8 : method === 'horizontal+vertical' ? 4 : tiles.length);
  const rows = Math.ceil(tiles.length / cols);
  const W = cols * T, H = rows * T, data = new Uint8ClampedArray(W * H * 4);
  tiles.forEach((t, i) => { const c = i % cols, r = Math.floor(i / cols); for (let y = 0; y < T; y++) data.set(t.subarray(y * T * 4, (y + 1) * T * 4), ((r * T + y) * W + c * T) * 4); });
  Object.assign(meta, { cols, rows, count: tiles.length, order: ORDER[method] });
  return { width: W, height: H, data, meta };
}
const ORDER = {
  full: 'blob47: tile i has neighbour mask masks[i] (N1 NE2 E4 SE8 S16 SW32 W64 NW128; corners only when both edges connect), row-major, 8 columns',
  overlay: 'blob47 of the complement: ctmTileFor(mask of "source material is there", "overlay")',
  compact: '0 none, 1 all, 2 horizontal (W+E), 3 vertical (N+S), 4 inner corners; each quarter picked from its 2 edges + diagonal',
  horizontal: 'index = W?1 | E?2: 0 alone, 1 right end, 2 left end, 3 middle',
  vertical: 'index = N?1 | S?2: 0 alone, 1 bottom end, 2 top end, 3 middle',
  'horizontal+vertical': 'index = N?1 | E?2 | S?4 | W?8 (edges only)',
  top: '0 = something above (plain), 1 = nothing above (top row)',
  random: 'weighted variants, hash of the world cell + seed',
  repeat: 'tile = (cell.x mod cols) + (cell.y mod rows) * cols: one big pattern over cols x rows cells',
};

// ---------- bake: face cells, adjacency, tile UVs ----------
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const crossV = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const normV = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
/** Face basis (same as the world tiling): t = right on the face, b = up; s = p.t, q = -p.b. */
export function faceBasis(n) {
  if (Math.abs(n[1]) > 0.999) return { t: [1, 0, 0], b: n[1] > 0 ? [0, 0, -1] : [0, 0, 1] };
  const t = normV(crossV([0, 1, 0], n));
  return { t, b: crossV(n, t) };
}
/** Sutherland-Hodgman clip of a polygon [[s, q, ...attrs]] to s0<=s<=s1, q0<=q<=q1 (attrs interpolated). */
export function clipRect(poly, s0, s1, q0, q1) {
  const planes = [[0, s0, 1], [0, s1, -1], [1, q0, 1], [1, q1, -1]];
  let out = poly;
  for (const [ax, v, sg] of planes) {
    const inp = out; out = [];
    if (!inp.length) break;
    for (let i = 0; i < inp.length; i++) {
      const A = inp[i], B = inp[(i + 1) % inp.length];
      const da = (A[ax] - v) * sg, db = (B[ax] - v) * sg;
      if (da >= 0) out.push(A);
      if ((da >= 0) !== (db >= 0)) { const t = da / (da - db); out.push(A.map((x, k) => x + (B[k] - x) * t)); }
    }
  }
  return out;
}
const polyArea = (p) => { let s = 0; for (let i = 0; i < p.length; i++) { const a = p[i], b = p[(i + 1) % p.length]; s += a[0] * b[1] - b[0] * a[1]; } return Math.abs(s) / 2; };
const nkey = (n) => n.map((v) => Math.round(v * 1000)).join(',');
/** Stable small integer per plane (orientation + offset), so random tiles differ between walls. */
const planeId = (P) => { let h = 0; for (const ch of `${nkey(P.n)}|${Math.round(P.off * 1000)}`) h = (Math.imul(h, 31) + ch.charCodeAt(0)) | 0; return h; };

/**
 * Split faces into world cells of size T on their planes. faces: [{g, f}] (Mesh group + face).
 * key(g, f) = connect key. -> { cells: Map, planes: Map, list: [cell] }
 */
export function cellIndex(items, T, key) {
  const cells = new Map(), planes = new Map();
  for (const { g, f } of items) {
    const n = f.n, { t, b } = faceBasis(n);
    const p0 = [g.pos[f.v * 3], g.pos[f.v * 3 + 1], g.pos[f.v * 3 + 2]];
    const off = dot(p0, n), conn = key(g, f);
    const pk = `${nkey(n)}|${Math.round(off * 1000)}|${conn}|${T}`;
    let plane = planes.get(pk);
    if (!plane) { plane = { key: pk, n, t, b, off, conn, T, vertical: Math.abs(n[1]) < 0.01 }; planes.set(pk, plane); }
    for (let i = f.i; i < f.i + f.ic; i += 3) {
      const tri = [0, 1, 2].map((k) => {
        const v = g.idx[i + k], p = [g.pos[v * 3], g.pos[v * 3 + 1], g.pos[v * 3 + 2]];
        return [dot(p, t), -dot(p, b), g.uv[v * 2], g.uv[v * 2 + 1]];
      });
      const s0 = Math.min(...tri.map((p) => p[0])), s1 = Math.max(...tri.map((p) => p[0])), q0 = Math.min(...tri.map((p) => p[1])), q1 = Math.max(...tri.map((p) => p[1]));
      for (let cu = Math.floor(s0 / T + 1e-7); cu * T < s1 - 1e-7; cu++) for (let cv = Math.floor(q0 / T + 1e-7); cv * T < q1 - 1e-7; cv++) {
        const poly = clipRect(tri, cu * T, (cu + 1) * T, cv * T, (cv + 1) * T);
        if (poly.length < 3 || polyArea(poly) < 1e-6) continue;
        const ck = `${pk}#${cu},${cv}`;
        let c = cells.get(ck);
        if (!c) { c = { plane, cu, cv, frags: [], smin: Infinity, smax: -Infinity, qmin: Infinity, qmax: -Infinity }; cells.set(ck, c); }
        c.frags.push({ poly, g, f });
        for (const p of poly) { c.smin = Math.min(c.smin, p[0]); c.smax = Math.max(c.smax, p[0]); c.qmin = Math.min(c.qmin, p[1]); c.qmax = Math.max(c.qmax, p[1]); }
      }
    }
  }
  const byPlane = [...planes.values()];
  const get = (plane, cu, cv) => cells.get(`${plane.key}#${cu},${cv}`);
  /** One step along s (dx) or q (dy); along s it folds around vertical corners onto perpendicular walls of other pieces. */
  const step = (c, dx, dy, match = (p) => p.conn === c.plane.conn) => {
    const direct = get(c.plane, c.cu + dx, c.cv + dy);
    if (direct) return direct;
    if (dy || !c.plane.vertical) return null;
    const P = c.plane, s = dx > 0 ? c.smax : c.smin;
    const q = (c.qmin + c.qmax) / 2;
    const W = [P.t[0] * s - P.b[0] * q + P.n[0] * P.off, P.t[1] * s - P.b[1] * q + P.n[1] * P.off, P.t[2] * s - P.b[2] * q + P.n[2] * P.off];
    const dir = P.t.map((v) => v * dx); // walking direction in world space
    for (const p2 of byPlane) {
      if (p2 === P || !p2.vertical || p2.T !== T || !match(p2) || Math.abs(dot(p2.n, P.n)) > 0.01) continue;
      if (Math.abs(dot(W, p2.n) - p2.off) > 1e-3) continue;
      // inner corner (walking into p2): the run continues along +P.n; outer corner: along -P.n
      const cont = dot(dir, p2.n) < 0 ? 1 : -1;
      const Wp = W.map((v, k) => v + P.n[k] * cont * 1e-3);
      const s2 = dot(Wp, p2.t), q2 = -dot(Wp, p2.b);
      const c2 = get(p2, Math.floor(s2 / T), Math.floor(q2 / T));
      // only onto another piece (wall runs meeting at a corner), never around a piece's own end
      if (c2 && !c2.frags.some((a) => c.frags.some((b) => a.f.pid !== undefined && a.f.pid === b.f.pid))) return c2;
    }
    return null;
  };
  const nb = (c, dx, dy) => {
    if (!dx || !dy) return step(c, dx, dy);
    const a = step(c, dx, 0), r = a && step(a, 0, dy);
    if (r) return r;
    const b2 = step(c, 0, dy);
    return (b2 && step(b2, dx, 0)) || null;
  };
  const DIRS = [[0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1]];
  const mask = (c, test = (o) => !!o) => DIRS.reduce((m, [dx, dy], i) => (test(nb(c, dx, dy)) ? m | (1 << i) : m), 0);
  return { cells, planes, list: [...cells.values()], nb, mask };
}

/** UV inside atlas tile k for cell-local (ls, lq) in px. */
function tileUV(meta, tex, k, ls, lq) {
  const T = meta.tile, e = 1e-3;
  const col = k % meta.cols, row = Math.floor(k / meta.cols);
  return [(col * T + Math.min(T - e, Math.max(e, ls))) / tex.width, (row * T + Math.min(T - e, Math.max(e, lq))) / tex.height];
}

/**
 * Bake CTM: every world-tiled face whose texture is a CTM tileset is split into cells, neighbours
 * are found across all pieces (same plane + connect key; walls also around vertical corners), and
 * each cell gets its tile's UVs. emitFace(tex, P, n, UV, src) adds the new face.
 */
export function applyCTM(mesh, emitFace) {
  const byT = new Map();
  for (const g of mesh.groups.values()) {
    if (g.overlay || !g.tex.ctm || !g.faces || g.tex.ctm.method === 'overlay') continue;
    for (const f of g.faces) if (f.mode === 1) {
      const T = g.tex.ctm.tile;
      if (!byT.has(T)) byT.set(T, []);
      byT.get(T).push({ g, f });
    }
  }
  if (!byT.size) return 0;
  const connectKey = (g, f) => {
    const c = g.tex.ctm.connect || 'material';
    if (c === 'tag') return `tag:${f.tag ?? g.tex.canvas}`;
    if (c === 'texture') return `tex:${g.tex.ctm.base ?? g.tex.canvas}`;
    return `mat:${g.tex.canvas ?? g.tex.key}`;
  };
  const drop = new Set();
  let cellsBaked = 0;
  for (const [T, items] of byT) {
    const idx = cellIndex(items, T, connectKey);
    for (const c of idx.list) {
      const m = idx.mask(c);
      cellsBaked++;
      for (const fr of c.frags) {
        const { g, f } = fr, meta = g.tex.ctm, P = c.plane;
        drop.add(f);
        const opts = { cell: [c.cu, c.cv, planeId(P)], weights: meta.weights, seed: meta.seed, repeat: meta.repeat };
        const pieces = meta.method === 'compact'
          ? [[0, 0], [1, 0], [1, 1], [0, 1]].map(([qx, qy], k) => [clipRect(fr.poly, c.cu * T + qx * T / 2, c.cu * T + (qx + 1) * T / 2, c.cv * T + qy * T / 2, c.cv * T + (qy + 1) * T / 2), ctmTileFor(m, 'compact')[k]])
          : [[fr.poly, ctmTileFor(m, meta.method, opts)]];
        for (const [poly, k] of pieces) {
          if (poly.length < 3 || polyArea(poly) < 1e-7) continue;
          const Pw = poly.map(([s, q]) => [P.t[0] * s - P.b[0] * q + P.n[0] * P.off, P.t[1] * s - P.b[1] * q + P.n[1] * P.off, P.t[2] * s - P.b[2] * q + P.n[2] * P.off]);
          const UV = poly.map(([s, q]) => tileUV(meta, g.tex, k, s - c.cu * T, q - c.cv * T));
          emitFace(g.tex, Pw, P.n, UV, f);
        }
      }
    }
  }
  return { drop, cells: cellsBaked };
}
export { tileUV };
