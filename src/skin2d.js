// 2D mesh skinning of drawn sprites (art_rig skin / weights / shapes): a part's cell (or a whole
// canvas) is cut into a pixel-aligned lattice mesh clipped to its opaque pixels, bound to the
// rig's bones (parts) with heat / distance / rigid weights (max 4 influences, sum 1, paintable),
// and deformed per frame with linear blend skinning. Deformed frames are drawn by inverse mapping
// (dest pixel -> triangle -> rest point -> nearest source pixel in a Scale2x 8x copy, 3x3
// supersampled majority), so they stay crisp pixel art in the source palette: no blending, no new
// colours, a cleanup pass for pinholes / stray pixels and an outline repair for newly exposed
// edges. Triangles that only translate copy their pixels exactly, so the rest pose reproduces the
// source pixel for pixel. Deform shapes (blend-shape equivalent) are sculpted or fitted to a
// variant drawing, and can be driven by a joint angle (correctives). Rigs without "skin" never
// reach this file.
import { upscale } from './pixelops.js';
import { worldOf, partIn, poseOf, cellOf } from './rig.js';

const NAME = /^[\w-]+$/;
export const SKIN_METHODS = ['heat', 'distance', 'rigid'];
export const SKIN_SAMPLING = ['rotsprite', 'nearest8', 'smooth'];
const DENSITY = { low: 8, medium: 4, high: 2 };
const MAX_INF = 4;
const MIN_W = 0.01;
const D2R = Math.PI / 180;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const adiff = (a, b) => { let d = (b - a) % 360; if (d > 180) d -= 360; if (d < -180) d += 360; return d; };
const MESH_KEYS = ['part', 'canvas', 'at', 'bones', 'absorb', 'method', 'density', 'falloff', 'blend', 'smooth', 'heat', 'paint', 'weight_canvas', 'outline', 'sampling', 'z', 'views', 'shapes'];
const VIEW_KEYS = ['canvas', 'at', 'bones', 'method', 'density', 'falloff', 'blend', 'smooth', 'heat', 'paint', 'weight_canvas', 'outline', 'z', 'shapes', 'off'];

// ---------- spec ----------
function checkRegion(r, where) {
  if (r === undefined || r === 'all') return;
  if (!r || typeof r !== 'object') throw new Error(`${where}: region must be "all" or {box:[x,y,w,h]} | {circle:[cx,cy,r]} | {rows:[y0,y1]} | {cols:[x0,x1]} | {above:y} | {below:y} (source image px), soft?`);
  const n = (v, k) => Array.isArray(v) && v.length === k && v.every((x) => Number.isFinite(Number(x)));
  if (r.box !== undefined && !n(r.box, 4)) throw new Error(`${where}: box must be [x,y,w,h]`);
  if (r.circle !== undefined && !n(r.circle, 3)) throw new Error(`${where}: circle must be [cx,cy,r]`);
  for (const k of ['rows', 'cols']) if (r[k] !== undefined && !n(r[k], 2)) throw new Error(`${where}: ${k} must be [from, to]`);
  if (!['box', 'circle', 'rows', 'cols', 'above', 'below'].some((k) => r[k] !== undefined)) throw new Error(`${where}: region needs box, circle, rows, cols, above or below`);
}

function checkShape(rig, name, s, where) {
  if (!NAME.test(name)) throw new Error(`${where}: bad shape name "${name}"`);
  if (!s || typeof s !== 'object') throw new Error(`${where}: shape must be {sculpt?:[{region?, move?, scale?, about?, rotate?, inflate?}], variant?, canvas?, fit?, driver?:{bone, from, to}}`);
  if (s.sculpt === undefined && s.variant === undefined && s.canvas === undefined) throw new Error(`${where}: shape needs sculpt:[...] or variant:"<part variant>" / canvas:"<drawing>"`);
  for (const [i, op] of [].concat(s.sculpt || []).entries()) {
    if (!op || typeof op !== 'object') throw new Error(`${where}.sculpt[${i}] must be an object`);
    checkRegion(op.region, `${where}.sculpt[${i}]`);
    if (op.move !== undefined && !(Array.isArray(op.move) && op.move.length === 2)) throw new Error(`${where}.sculpt[${i}].move must be [dx,dy]`);
    if (op.move === undefined && op.scale === undefined && op.rotate === undefined && op.inflate === undefined) throw new Error(`${where}.sculpt[${i}] needs move, scale, rotate or inflate`);
  }
  if (s.driver !== undefined) {
    const d = s.driver;
    if (!d || !rig.parts[d.bone]) throw new Error(`${where}.driver needs bone:<part> (got ${JSON.stringify(d?.bone)})`);
    if (!Number.isFinite(Number(d.from)) || !Number.isFinite(Number(d.to)) || Number(d.from) === Number(d.to)) throw new Error(`${where}.driver needs from and to: the joint angles (deg, local rotation) where the shape is 0 and 1`);
  }
}

/** Validate a rig "skin": {<mesh>: {part | canvas, bones?, absorb?, method?, density?, ..., views?, shapes?}}. */
export function normalizeSkin(rig, spec) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) throw new Error('rig "skin" must be {<mesh>: {part:"<part>" | canvas:"<canvas>", bones?, method?:"heat"|"distance"|"rigid", density?, paint?, shapes?, views?}}');
  const out = {};
  for (const [name, m0] of Object.entries(spec)) {
    if (m0 === null) continue;
    const w = `skin.${name}`;
    if (!NAME.test(name)) throw new Error(`${w}: bad mesh name`);
    if (!m0 || typeof m0 !== 'object') throw new Error(`${w} must be an object`);
    for (const k of Object.keys(m0)) if (!MESH_KEYS.includes(k)) throw new Error(`${w}: unknown key "${k}" (keys: ${MESH_KEYS.join(', ')})`);
    const m = structuredClone(m0);
    if (m.part === undefined && m.canvas === undefined && !Object.values(m.views || {}).some((v) => v?.canvas)) throw new Error(`${w} needs part:"<part>" (its cell is the drawing) or canvas:"<canvas>" (a whole drawn sprite, placed at at:[x,y] of the frame)`);
    if (m.part !== undefined) {
      if (!rig.parts[m.part]) throw new Error(`${w}: unknown part "${m.part}"`);
      if (rig.parts[m.part].bone) throw new Error(`${w}: part "${m.part}" is a bone (bone:true has no drawing)`);
      if (rig.parts[m.part].art) throw new Error(`${w}: part "${m.part}" draws another part's cell (art); skin the owner`);
    }
    if (m.part !== undefined && m.canvas !== undefined) throw new Error(`${w}: use part or canvas, not both`);
    const bonesOk = (b, where) => { if (b === undefined || b === 'all') return; if (!Array.isArray(b) || !b.length) throw new Error(`${where}: bones must be "all" or a list of parts`); for (const n of b) if (!rig.parts[n]) throw new Error(`${where}: unknown bone "${n}"`); };
    bonesOk(m.bones, w);
    if (m.absorb !== undefined) { if (!Array.isArray(m.absorb)) throw new Error(`${w}.absorb must be a list of parts`); for (const n of m.absorb) if (!rig.parts[n]) throw new Error(`${w}.absorb: unknown part "${n}"`); }
    if (m.part === undefined && m.bones === undefined) m.bones = 'all';
    const opts = (o, where) => {
      if (o.method !== undefined && !SKIN_METHODS.includes(o.method)) throw new Error(`${where}.method must be ${SKIN_METHODS.join(' | ')}`);
      if (o.density !== undefined && !DENSITY[o.density] && !(Number.isInteger(Number(o.density)) && Number(o.density) >= 1 && Number(o.density) <= 32)) throw new Error(`${where}.density must be low | medium | high or a lattice step 1..32 px`);
      if (o.sampling !== undefined && !SKIN_SAMPLING.includes(o.sampling)) throw new Error(`${where}.sampling must be ${SKIN_SAMPLING.join(' | ')}`);
      for (const [i, p] of (o.paint || []).entries()) {
        if (!p || !rig.parts[p.bone]) throw new Error(`${where}.paint[${i}] needs bone:<part>`);
        if (p.mode !== undefined && !['set', 'add', 'smooth'].includes(p.mode)) throw new Error(`${where}.paint[${i}].mode must be set | add | smooth`);
        checkRegion(p.region ?? 'all', `${where}.paint[${i}]`);
      }
      if (o.weight_canvas !== undefined) {
        const c = o.weight_canvas;
        if (!c?.canvas || !(c.bone ? rig.parts[c.bone] : c.colors && typeof c.colors === 'object')) throw new Error(`${where}.weight_canvas must be {canvas, bone} (grey = weight) or {canvas, colors:{"#rrggbb": bone}}`);
        for (const b of Object.values(c.colors || {})) if (!rig.parts[b]) throw new Error(`${where}.weight_canvas.colors: unknown bone "${b}"`);
      }
      for (const [s, sh] of Object.entries(o.shapes || {})) if (sh !== null) checkShape(rig, s, sh, `${where}.shapes.${s}`);
    };
    opts(m, w);
    for (const [v, o] of Object.entries(m.views || {})) {
      if (!rig.views.includes(v)) throw new Error(`${w}.views: "${v}" must be a drawn view (${rig.views.join(', ')}); mirror views use their source view`);
      if (!o || typeof o !== 'object') throw new Error(`${w}.views.${v} must be an object`);
      for (const k of Object.keys(o)) if (!VIEW_KEYS.includes(k)) throw new Error(`${w}.views.${v}: unknown key "${k}" (keys: ${VIEW_KEYS.join(', ')})`);
      bonesOk(o.bones, `${w}.views.${v}`);
      opts(o, `${w}.views.${v}`);
    }
    out[name] = { name, ...m };
  }
  return out;
}

/** Effective mesh settings in a drawn view (view overrides merged; shapes merged by name). */
function meshIn(m, view) {
  const o = m.views?.[view] || {};
  const r = { ...m, ...o };
  r.shapes = { ...(m.shapes || {}), ...(o.shapes || {}) };
  for (const k of Object.keys(r.shapes)) if (r.shapes[k] === null) delete r.shapes[k];
  return r;
}

// ---------- sources ----------
const artCache = new WeakMap();
function artOf(doc) {
  let c = artCache.get(doc);
  if (!c || c.v !== doc.version) {
    const saved = doc.layers;
    doc.layers = saved.filter((l) => l.name !== 'cells');
    try { c = { v: doc.version, data: doc.composite() }; } finally { doc.layers = saved; }
    artCache.set(doc, c);
  }
  return c.data;
}

function block(data, W, x, y, w, h) {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let j = 0; j < h; j++) out.set(data.subarray(((y + j) * W + x) * 4, ((y + j) * W + x + w) * 4), j * w * 4);
  return out;
}

/** The drawing of a mesh in a view (the host cell or the canvas frame 0) -> {img, w, h, origin} | null. */
function sourceOf(rig, partsDoc, m, view, variant = null, canvasName = null) {
  if (m.part !== undefined && !canvasName) {
    const p = partIn(rig, m.part, view);
    const cv = p.link && !p.link.flip ? p.link.view : view;
    const v = variant ?? 'base';
    if (!rig.parts[m.part].variants.includes(v)) throw new Error(`skin.${m.name}: part "${m.part}" has no variant "${v}"`);
    const c = cellOf(rig, m.part, cv, v);
    const W0 = worldOf(rig, {}, view)[m.part];
    return { img: block(artOf(partsDoc), partsDoc.width, c.x, c.y, c.w, c.h), w: c.w, h: c.h, origin: [Math.round(W0.x) - p.pivot[0], Math.round(W0.y) - p.pivot[1]], cell: c };
  }
  const name = canvasName ?? m.canvas;
  const d = rig.skinDocs?.(name);
  if (!d) throw new Error(`skin.${m.name}: no canvas "${name}"`);
  const fh = d.frameHeight || d.height;
  const at = (m.at || [0, 0]).map((v) => Math.round(Number(v) || 0));
  return { img: block(d.composite(), d.width, 0, 0, d.width, fh), w: d.width, h: fh, origin: at, canvas: name, version: d.version };
}

// ---------- lattice mesh ----------
/**
 * Pixel-aligned lattice of step s clipped to the mask: each lattice cell holds one quad per
 * 8-connected component of its opaque pixels; quad corners are shared only where the pixels
 * connect across the cell edge, so a 1px gap (two legs, an arm against the body) cuts the mesh
 * instead of gluing both sides together. -> {verts, tris, triCell, triComp, label, cells, gw}
 */
export function latticeMesh(mask, w, h, s) {
  const gw = Math.ceil(w / s), gh = Math.ceil(h / s);
  const label = new Int16Array(w * h).fill(-1);
  const ncomp = new Int32Array(gw * gh), base = new Int32Array(gw * gh);
  const stack = [];
  let quads = 0;
  for (let cy = 0; cy < gh; cy++) for (let cx = 0; cx < gw; cx++) {
    const ci = cy * gw + cx, x0 = cx * s, y0 = cy * s, x1 = Math.min(w, x0 + s), y1 = Math.min(h, y0 + s);
    let k = 0;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      if (!mask[y * w + x] || label[y * w + x] >= 0) continue;
      label[y * w + x] = k;
      stack.push(x, y);
      while (stack.length) {
        const py = stack.pop(), px = stack.pop();
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const qx = px + dx, qy = py + dy;
          if (qx < x0 || qy < y0 || qx >= x1 || qy >= y1) continue;
          const q = qy * w + qx;
          if (mask[q] && label[q] < 0) { label[q] = k; stack.push(qx, qy); }
        }
      }
      k++;
    }
    ncomp[ci] = k; base[ci] = quads; quads += k;
  }
  const uf = new Int32Array(quads * 4);
  for (let i = 0; i < uf.length; i++) uf[i] = i;
  const find = (a) => { while (uf[a] !== a) { uf[a] = uf[uf[a]]; a = uf[a]; } return a; };
  const union = (a, b) => { a = find(a); b = find(b); if (a !== b) { if (a < b) uf[b] = a; else uf[a] = b; } };
  const slot = (ci, comp, corner) => (base[ci] + comp) * 4 + corner; // 0 TL 1 TR 2 BL 3 BR
  const lab = (x, y) => (x < 0 || y < 0 || x >= w || y >= h || !mask[y * w + x] ? -1 : label[y * w + x]);
  for (let cy = 0; cy < gh; cy++) for (let cx = 0; cx < gw; cx++) {
    const ci = cy * gw + cx;
    if (!ncomp[ci]) continue;
    const x0 = cx * s, y0 = cy * s, x1 = Math.min(w, x0 + s), y1 = Math.min(h, y0 + s);
    if (cx + 1 < gw && ncomp[ci + 1]) for (let y = y0; y < y1; y++) { // right neighbour
      const a = lab(x1 - 1, y);
      if (a < 0) continue;
      for (let dy = -1; dy <= 1; dy++) {
        const yb = y + dy;
        if (yb < y0 || yb >= y1) continue;
        const b = lab(x1, yb);
        if (b >= 0) { union(slot(ci, a, 1), slot(ci + 1, b, 0)); union(slot(ci, a, 3), slot(ci + 1, b, 2)); }
      }
    }
    if (cy + 1 < gh && ncomp[ci + gw]) for (let x = x0; x < x1; x++) { // bottom neighbour
      const a = lab(x, y1 - 1);
      if (a < 0) continue;
      for (let dx = -1; dx <= 1; dx++) {
        const xb = x + dx;
        if (xb < x0 || xb >= x1) continue;
        const b = lab(xb, y1);
        if (b >= 0) { union(slot(ci, a, 2), slot(ci + gw, b, 0)); union(slot(ci, a, 3), slot(ci + gw, b, 1)); }
      }
    }
    if (cx + 1 < gw && cy + 1 < gh && ncomp[ci + gw + 1]) { const a = lab(x1 - 1, y1 - 1), b = lab(x1, y1); if (a >= 0 && b >= 0) union(slot(ci, a, 3), slot(ci + gw + 1, b, 0)); }
    if (cx > 0 && cy + 1 < gh && ncomp[ci + gw - 1]) { const a = lab(x0, y1 - 1), b = lab(x0 - 1, y1); if (a >= 0 && b >= 0) union(slot(ci, a, 2), slot(ci + gw - 1, b, 1)); }
  }
  // pixel extent of every quad's component: a corner's anchor (where its weights are measured)
  // is the corner clamped into the component, averaged over the quads sharing the vertex
  const ext = new Float64Array(quads * 4).fill(NaN);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (!mask[y * w + x]) continue;
    const q = base[Math.floor(y / s) * gw + Math.floor(x / s)] + label[y * w + x], o = q * 4;
    if (Number.isNaN(ext[o])) { ext[o] = x; ext[o + 1] = y; ext[o + 2] = x + 1; ext[o + 3] = y + 1; }
    else { ext[o] = Math.min(ext[o], x); ext[o + 1] = Math.min(ext[o + 1], y); ext[o + 2] = Math.max(ext[o + 2], x + 1); ext[o + 3] = Math.max(ext[o + 3], y + 1); }
  }
  const vid = new Map(), verts = [], tris = [], triCell = [], triComp = [], acc = [];
  const vert = (sl, x, y) => {
    const r = find(sl);
    let v = vid.get(r);
    if (v === undefined) { v = verts.length / 2; vid.set(r, v); verts.push(x, y); acc.push(0, 0, 0); }
    const q = (sl >> 2) * 4;
    acc[3 * v] += clamp(x, ext[q], ext[q + 2]); acc[3 * v + 1] += clamp(y, ext[q + 1], ext[q + 3]); acc[3 * v + 2]++;
    return v;
  };
  for (let cy = 0; cy < gh; cy++) for (let cx = 0; cx < gw; cx++) {
    const ci = cy * gw + cx, x0 = cx * s, y0 = cy * s, x1 = Math.min(w, x0 + s), y1 = Math.min(h, y0 + s);
    for (let k = 0; k < ncomp[ci]; k++) {
      const tl = vert(slot(ci, k, 0), x0, y0), tr = vert(slot(ci, k, 1), x1, y0), bl = vert(slot(ci, k, 2), x0, y1), br = vert(slot(ci, k, 3), x1, y1);
      tris.push(tl, tr, br, tl, br, bl);
      triCell.push(ci, ci); triComp.push(k, k);
    }
  }
  const anchors = new Float64Array(verts.length);
  for (let v = 0; v < verts.length / 2; v++) { anchors[2 * v] = acc[3 * v] / acc[3 * v + 2]; anchors[2 * v + 1] = acc[3 * v + 1] / acc[3 * v + 2]; }
  return { verts: Float64Array.from(verts), anchors, tris: Int32Array.from(tris), triCell: Int32Array.from(triCell), triComp: Int16Array.from(triComp), label, gw, s };
}

/** Vertex adjacency (sorted, deduplicated) with edge weights 1 / length^2. */
function adjacency(verts, tris, n) {
  const sets = Array.from({ length: n }, () => new Set());
  for (let t = 0; t < tris.length; t += 3) for (let k = 0; k < 3; k++) { const a = tris[t + k], b = tris[t + (k + 1) % 3]; sets[a].add(b); sets[b].add(a); }
  return sets.map((st, i) => [...st].sort((a, b) => a - b).map((j) => [j, 1 / Math.max(1e-9, (verts[2 * i] - verts[2 * j]) ** 2 + (verts[2 * i + 1] - verts[2 * j + 1]) ** 2)]));
}

/** Conjugate gradient for (L + diag(H)) x = b (L = graph Laplacian of adj). */
function solveCG(adj, H, b, x0) {
  const n = b.length;
  const mul = (x, out) => { for (let i = 0; i < n; i++) { let s = H[i] * x[i]; for (const [j, w] of adj[i]) s += w * (x[i] - x[j]); out[i] = s; } };
  const x = Float64Array.from(x0), r = new Float64Array(n), p = new Float64Array(n), Ap = new Float64Array(n);
  mul(x, Ap);
  let bn = 0;
  for (let i = 0; i < n; i++) { r[i] = b[i] - Ap[i]; p[i] = r[i]; bn += b[i] * b[i]; }
  let rr = 0;
  for (let i = 0; i < n; i++) rr += r[i] * r[i];
  const tol = Math.max(1e-30, bn * 1e-20);
  for (let it = 0; it < Math.max(50, 4 * n) && rr > tol; it++) {
    mul(p, Ap);
    let pAp = 0;
    for (let i = 0; i < n; i++) pAp += p[i] * Ap[i];
    if (!(pAp > 0)) break;
    const a = rr / pAp;
    let rr2 = 0;
    for (let i = 0; i < n; i++) { x[i] += a * p[i]; r[i] -= a * Ap[i]; rr2 += r[i] * r[i]; }
    const beta = rr2 / rr;
    rr = rr2;
    for (let i = 0; i < n; i++) p[i] = r[i] + beta * p[i];
  }
  return x;
}

const segDist = (px, py, s) => {
  const dx = s.tail[0] - s.head[0], dy = s.tail[1] - s.head[1], l2 = dx * dx + dy * dy;
  const t = l2 > 1e-12 ? clamp(((px - s.head[0]) * dx + (py - s.head[1]) * dy) / l2, 0, 1) : 0;
  const cx = s.head[0] + dx * t, cy = s.head[1] + dy * t;
  return { d: Math.hypot(px - cx, py - cy), cx, cy };
};

/** Region test in source px (vertex = pixel corner) -> factor 0..1 (soft px falloff outside). */
function regionFactor(r, x, y) {
  if (r === undefined || r === 'all') return 1;
  const soft = Math.max(0, Number(r.soft ?? 0));
  let d = Infinity; // distance outside (<= 0 inside)
  if (r.box) { const [bx, by, bw, bh] = r.box.map(Number); d = Math.max(bx - x, x - (bx + bw), by - y, y - (by + bh)); }
  else if (r.circle) { const [cx, cy, rr] = r.circle.map(Number); d = Math.hypot(x - cx, y - cy) - rr; }
  else if (r.rows) { const [a, b] = r.rows.map(Number); d = Math.max(a - y, y - b); }
  else if (r.cols) { const [a, b] = r.cols.map(Number); d = Math.max(a - x, x - b); }
  else if (r.above !== undefined) d = y - Number(r.above);
  else if (r.below !== undefined) d = Number(r.below) - y;
  if (d <= 0) return 1;
  return soft > 0 && d < soft ? 1 - d / soft : 0;
}

/** Line of sight from a point to a bone inside the (1px dilated) mask. */
function visible(dil, w, h, x0, y0, x1, y1) {
  const L = Math.hypot(x1 - x0, y1 - y0), n = Math.max(1, Math.ceil(L * 2));
  for (let i = 0; i <= n; i++) {
    const x = Math.floor(x0 + ((x1 - x0) * i) / n - 1e-9), y = Math.floor(y0 + ((y1 - y0) * i) / n - 1e-9);
    if (x < -1 || y < -1 || x > w || y > h) return false;
    if (x < 0 || y < 0 || x >= w || y >= h) continue;
    if (!dil[y * w + x]) return false;
  }
  return true;
}

/**
 * Influences under 1% are dropped, then the 4 strongest kept (over = more than 4 were left),
 * normalised to sum 1; ties go to the lower bone index.
 */
export function pruneWeights(row) {
  const total = row.reduce((t, v) => t + (v > 0 ? v : 0), 0);
  const idx = [];
  for (let b = 0; b < row.length; b++) if (row[b] > 0 && row[b] / total >= MIN_W) idx.push(b);
  if (!idx.length) { let m = 0; for (let b = 1; b < row.length; b++) if (row[b] > row[m]) m = b; idx.push(m); }
  idx.sort((a, b) => row[b] - row[a] || a - b);
  const over = idx.length > MAX_INF;
  const keep = idx.slice(0, MAX_INF);
  const s = keep.reduce((t, b) => t + row[b], 0);
  const j = [], wv = [];
  for (const b of keep) { j.push(b); wv.push(row[b] / s); }
  // make the float sum exactly 1 (the largest takes the rounding residue)
  if (wv.length > 1) { let r = 0; for (let i = 1; i < wv.length; i++) r += wv[i]; wv[0] = 1 - r; }
  return { j, w: wv, over };
}

// ---------- build ----------
const buildCache = new WeakMap();

/** Bones of a mesh in a view: names + bind segments in source px. */
function meshBones(rig, m, view, origin) {
  const names = m.bones === 'all' || m.bones === undefined && m.part === undefined ? rig.order.slice()
    : m.bones ? m.bones.slice() : [m.part, ...(m.absorb || []).filter((n) => n !== m.part)];
  const W0 = worldOf(rig, {}, view);
  const set = new Set(names);
  const segs = names.map((b) => {
    const head = [W0[b].x - origin[0], W0[b].y - origin[1]];
    const kids = rig.order.filter((c) => rig.parts[c].parent === b && set.has(c));
    let tail;
    if (kids.length) tail = [kids.reduce((s, c) => s + W0[c].x, 0) / kids.length - origin[0], kids.reduce((s, c) => s + W0[c].y, 0) / kids.length - origin[1]];
    else {
      const p = partIn(rig, b, view), cx = p.w / 2 - p.pivot[0], cy = p.h / 2 - p.pivot[1];
      tail = Math.hypot(cx, cy) >= 0.5 ? [head[0] + 2 * cx, head[1] + 2 * cy] : head.slice();
    }
    return { name: b, head, tail };
  });
  return { names, segs };
}

/** Skinned mesh of one skin entry in one drawn view (cached per parts canvas version + spec). -> built | null (nothing drawn) */
export function buildSkinMesh(rig, partsDoc, mesh, view) {
  const m = meshIn(mesh, view);
  if (m.off) return null;
  const canvasName = m.canvas ?? null;
  const ext = [];
  const wc = m.weight_canvas ? rig.skinDocs?.(m.weight_canvas.canvas) : null;
  if (m.weight_canvas && !wc) throw new Error(`skin.${mesh.name}: no weight canvas "${m.weight_canvas.canvas}"`);
  if (wc) ext.push(`${wc.name}@${wc.version}`);
  for (const sh of Object.values(m.shapes)) if (sh.canvas) { const d = rig.skinDocs?.(sh.canvas); if (d) ext.push(`${d.name}@${d.version}`); }
  if (canvasName) { const d = rig.skinDocs?.(canvasName); if (d) ext.push(`${d.name}@${d.version}`); }
  const key = `${view}|${partsDoc.version ?? 0}|${ext.join(',')}|${JSON.stringify(m)}|${JSON.stringify(rig.frame)}|${JSON.stringify(rig.root)}`;
  let per = buildCache.get(partsDoc);
  if (!per) { per = new Map(); buildCache.set(partsDoc, per); }
  if (per.has(key)) return per.get(key);
  const t0 = performance.now();
  const built = buildUncached(rig, partsDoc, m, mesh.name, view, canvasName, wc);
  if (built) built.ms = Math.round(performance.now() - t0);
  if (per.size > 64) per.clear();
  per.set(key, built);
  return built;
}

function rimOf(img32, w, h) {
  const rim = new Uint8Array(w * h);
  const op = (x, y) => x >= 0 && y >= 0 && x < w && y < h && img32[y * w + x] >>> 24;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (op(x, y) && (!op(x - 1, y) || !op(x + 1, y) || !op(x, y - 1) || !op(x, y + 1))) rim[y * w + x] = 1;
  return rim;
}

function buildUncached(rig, partsDoc, m, name, view, canvasName, wc) {
  const src = sourceOf(rig, partsDoc, m, view, null, canvasName);
  const { w, h, origin } = src;
  const img32 = new Uint32Array(src.img.buffer, src.img.byteOffset, w * h);
  // variant drawings (deform shapes fitted to / swapping in another drawing of the same cell)
  const shapeSpecs = Object.entries(m.shapes || {});
  const variants = {};
  for (const [sn, sh] of shapeSpecs) {
    if (sh.variant === undefined && sh.canvas === undefined) continue;
    const vs = sh.canvas !== undefined ? sourceOf(rig, partsDoc, { ...m, name, part: undefined }, view, null, sh.canvas) : sourceOf(rig, partsDoc, m, view, sh.variant, canvasName);
    if (vs.w !== w || vs.h !== h) throw new Error(`skin.${name}.shapes.${sn}: the drawing is ${vs.w}x${vs.h}, the mesh source ${w}x${h}`);
    const v32 = new Uint32Array(vs.img.buffer, vs.img.byteOffset, w * h);
    variants[sn] = { img32: v32, big32: new Uint32Array(upscale(vs.img, w, h, 8).data.buffer), rim: rimOf(v32, w, h) };
  }
  const mask = new Uint8Array(w * h);
  let opaque = 0;
  for (let i = 0; i < w * h; i++) { let on = img32[i] >>> 24 ? 1 : 0; for (const v of Object.values(variants)) if (v.img32[i] >>> 24) on = 1; mask[i] = on; opaque += on; }
  if (!opaque) return null;
  const step = DENSITY[m.density] ?? (m.density !== undefined ? Math.round(Number(m.density)) : clamp(Math.round(Math.sqrt(opaque) / 9), 2, 6));
  const L = latticeMesh(mask, w, h, step);
  const n = L.verts.length / 2;
  const { names, segs } = meshBones(rig, m, view, origin);
  const nb = names.length;
  const adj = adjacency(L.verts, L.tris, n);
  const dil = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (mask[y * w + x]) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const X = x + dx, Y = y + dy; if (X >= 0 && Y >= 0 && X < w && Y < h) dil[Y * w + X] = 1; }
  // ---- weights ----
  const method = m.method ?? 'heat';
  const Wt = Array.from({ length: n }, () => new Float64Array(nb));
  const AN = L.anchors; // weights are measured at the anchors (corners clamped into their pixels)
  const dist = Array.from({ length: n }, (_, i) => segs.map((s) => segDist(AN[2 * i], AN[2 * i + 1], s)));
  const vis = Array.from({ length: n }, (_, i) => dist[i].map((q) => visible(dil, w, h, AN[2 * i], AN[2 * i + 1], q.cx, q.cy)));
  const nearest = (i, onlyVis) => { let best = -1, bd = Infinity; for (let b = 0; b < nb; b++) { if (onlyVis && !vis[i][b]) continue; if (dist[i][b].d < bd - 1e-9) { bd = dist[i][b].d; best = b; } } return best; };
  let fallback = 0;
  if (method === 'heat') {
    const c = Number(m.heat ?? 1);
    const H = new Float64Array(n), near = new Int32Array(n).fill(-1);
    for (let i = 0; i < n; i++) { const b = nearest(i, true); if (b >= 0) { near[i] = b; H[i] = c / Math.max(0.25, dist[i][b].d) ** 2; } }
    // mesh pieces that see no bone at all: bind them to their nearest bone (keeps the system solvable)
    const comp = new Int32Array(n).fill(-1);
    for (let i = 0; i < n; i++) {
      if (comp[i] >= 0) continue;
      const list = [i]; comp[i] = i;
      for (let k = 0; k < list.length; k++) for (const [j] of adj[list[k]]) if (comp[j] < 0) { comp[j] = i; list.push(j); }
      if (!list.some((v) => H[v] > 0)) for (const v of list) { const b = nearest(v, false); near[v] = b; H[v] = (0.25 * c) / Math.max(0.25, dist[v][b].d) ** 2; fallback++; }
    }
    for (let b = 0; b < nb; b++) {
      const rhs = new Float64Array(n), x0 = new Float64Array(n);
      for (let i = 0; i < n; i++) if (near[i] === b) { rhs[i] = H[i]; x0[i] = 1; }
      const x = solveCG(adj, H, rhs, x0);
      for (let i = 0; i < n; i++) Wt[i][b] = Math.max(0, x[i]);
    }
  } else if (method === 'distance') {
    const p = Number(m.falloff ?? 3);
    for (let i = 0; i < n; i++) {
      const anyVis = vis[i].some(Boolean);
      for (let b = 0; b < nb; b++) if (!anyVis || vis[i][b]) Wt[i][b] = 1 / Math.max(0.5, dist[i][b].d) ** p;
    }
  } else {
    for (let i = 0; i < n; i++) { let b = nearest(i, true); if (b < 0) { b = nearest(i, false); fallback++; } Wt[i][b] = 1; }
  }
  const smoothPass = (passes, sel = null) => {
    for (let k = 0; k < passes; k++) {
      const prev = Wt.map((r) => Float64Array.from(r));
      for (let i = 0; i < n; i++) {
        if (sel && !sel[i]) continue;
        const r = Wt[i];
        for (let b = 0; b < nb; b++) { let s = prev[i][b]; for (const [j] of adj[i]) s += prev[j][b]; r[b] = s / (1 + adj[i].length); }
      }
    }
  };
  const norm = (r) => { const s = r.reduce((t, v) => t + v, 0); if (s > 0) for (let b = 0; b < nb; b++) r[b] /= s; };
  for (const r of Wt) norm(r);
  if (method === 'rigid' && m.blend) smoothPass(Math.max(1, Math.ceil(Number(m.blend) / step)));
  // paint: weight canvas, then regions
  const bi = (bone, where) => { const k = names.indexOf(bone); if (k < 0) throw new Error(`skin.${name}.${where}: "${bone}" is not one of this mesh's bones (${names.join(', ')})`); return k; };
  const setW = (i, b, v) => { const r = Wt[i]; const rest = r.reduce((t, x, k) => (k === b ? t : t + x), 0); for (let k = 0; k < nb; k++) if (k !== b) r[k] = rest > 0 ? (r[k] * (1 - v)) / rest : 0; r[b] = v; if (rest <= 0 && v < 1) r[b] = 1; };
  if (wc) {
    const cw = wc.width, ch = wc.frameHeight || wc.height, cd = wc.composite();
    const frameCoords = !(cw === w && ch === h);
    if (frameCoords && !(cw === rig.frame[0] && ch === rig.frame[1])) throw new Error(`skin.${name}.weight_canvas: canvas "${wc.name}" is ${cw}x${ch}; it must match the mesh drawing (${w}x${h}) or the rig frame (${rig.frame.join('x')})`);
    const spec = m.weight_canvas;
    const colors = spec.colors ? Object.fromEntries(Object.entries(spec.colors).map(([hex, b]) => [hex.toLowerCase().slice(0, 7), bi(b, 'weight_canvas')])) : null;
    for (let i = 0; i < n; i++) {
      const vx = Math.round(AN[2 * i]) + (frameCoords ? origin[0] : 0), vy = Math.round(AN[2 * i + 1]) + (frameCoords ? origin[1] : 0);
      const acc = new Float64Array(nb);
      let cnt = 0;
      for (const [px, py] of [[vx - 1, vy - 1], [vx, vy - 1], [vx - 1, vy], [vx, vy]]) {
        if (px < 0 || py < 0 || px >= cw || py >= ch) continue;
        const o = (py * cw + px) * 4;
        if (!cd[o + 3]) continue;
        cnt++;
        if (colors) { const hex = '#' + [cd[o], cd[o + 1], cd[o + 2]].map((v) => v.toString(16).padStart(2, '0')).join(''); if (colors[hex] !== undefined) acc[colors[hex]] += 1; }
        else acc[0] += ((0.299 * cd[o] + 0.587 * cd[o + 1] + 0.114 * cd[o + 2]) / 255) * (cd[o + 3] / 255);
      }
      if (!cnt) continue;
      if (colors) { const s = acc.reduce((t, v) => t + v, 0); if (s > 0) for (let b = 0; b < nb; b++) Wt[i][b] = acc[b] / s; }
      else setW(i, bi(spec.bone, 'weight_canvas'), acc[0] / cnt);
    }
  }
  for (const p of m.paint || []) {
    const b = bi(p.bone, 'paint'), mode = p.mode ?? 'set', v = clamp(Number(p.value ?? 1), 0, 1);
    const f = Array.from({ length: n }, (_, i) => regionFactor(p.region ?? 'all', AN[2 * i], AN[2 * i + 1]));
    if (mode === 'smooth') { smoothPass(Math.max(1, Math.round(Number(p.value ?? 2))), f.map((x) => x > 0)); continue; }
    for (let i = 0; i < n; i++) {
      if (!(f[i] > 0)) continue;
      if (mode === 'add') { Wt[i][b] += v * f[i]; norm(Wt[i]); } else setW(i, b, Wt[i][b] + (v - Wt[i][b]) * f[i]);
    }
  }
  if (m.smooth) smoothPass(Math.round(Number(m.smooth)));
  // normalise + prune to 4 influences
  const joints = new Uint8Array(n * MAX_INF), weights = new Float64Array(n * MAX_INF), counts = new Uint8Array(n);
  let over = 0, unweighted = 0, maxInf = 0;
  const perBone = new Int32Array(nb);
  for (let i = 0; i < n; i++) {
    let r = Wt[i];
    if (!(r.reduce((t, v) => t + v, 0) > 0)) { unweighted++; r = new Float64Array(nb); r[Math.max(0, nearest(i, false))] = 1; }
    const q = pruneWeights(r);
    if (q.over) over++;
    counts[i] = q.j.length;
    maxInf = Math.max(maxInf, q.j.length);
    for (let k = 0; k < q.j.length; k++) { joints[i * MAX_INF + k] = q.j[k]; weights[i * MAX_INF + k] = q.w[k]; perBone[q.j[k]]++; }
  }
  let nonNorm = 0;
  for (let i = 0; i < n; i++) { let s = 0; for (let k = 0; k < counts[i]; k++) s += weights[i * MAX_INF + k]; if (Math.abs(s - 1) > 1e-9) nonNorm++; }
  // ---- shapes ----
  const shapes = [];
  for (const [sn, sh] of shapeSpecs) {
    const d = new Float64Array(2 * n);
    for (const op of [].concat(sh.sculpt || [])) {
      const about = op.about ? op.about.map(Number) : null;
      const sc = op.scale === undefined ? null : Array.isArray(op.scale) ? op.scale.map(Number) : [Number(op.scale), Number(op.scale)];
      const rot = Number(op.rotate ?? 0) * D2R;
      for (let i = 0; i < n; i++) {
        const x = L.verts[2 * i], y = L.verts[2 * i + 1], f = regionFactor(op.region ?? 'all', x, y);
        if (!(f > 0)) continue;
        let tx = x, ty = y;
        const [ax, ay] = about || (op.region?.circle ? op.region.circle.slice(0, 2).map(Number) : [x, y]);
        if (sc) { tx = ax + (tx - ax) * sc[0]; ty = ay + (ty - ay) * sc[1]; }
        if (rot) { const dx = tx - ax, dy = ty - ay; tx = ax + dx * Math.cos(rot) - dy * Math.sin(rot); ty = ay + dx * Math.sin(rot) + dy * Math.cos(rot); }
        if (op.move) { tx += Number(op.move[0]); ty += Number(op.move[1]); }
        if (op.inflate) { const b = nearest(i, false), q = segDist(x, y, segs[b]); const l = Math.hypot(x - q.cx, y - q.cy); if (l > 1e-6) { tx += ((x - q.cx) / l) * Number(op.inflate); ty += ((y - q.cy) / l) * Number(op.inflate); } }
        d[2 * i] += (tx - x) * f; d[2 * i + 1] += (ty - y) * f;
      }
    }
    const v = variants[sn];
    if (v && sh.fit !== false) fitVariant(L, n, adj, mask, img32, v.img32, w, h, step, d);
    shapes.push({ name: sn, d, ...(v ? { variant: v } : {}), ...(sh.driver ? { driver: { bone: sh.driver.bone, from: Number(sh.driver.from), to: Number(sh.driver.to) } } : {}) });
  }
  // ---- draw order: dominant bone z, then bone depth (children over parents), then lattice order ----
  const depth = (b) => { let k = 0; for (let p = rig.parts[b].parent; p; p = rig.parts[p].parent) k++; return k; };
  const bz = names.map((b) => partIn(rig, b, view).z), bd = names.map(depth);
  const nt = L.tris.length / 3;
  const triBone = new Int32Array(nt);
  for (let t = 0; t < nt; t++) {
    const acc = new Float64Array(nb);
    for (let k = 0; k < 3; k++) { const v0 = L.tris[3 * t + k]; for (let c = 0; c < counts[v0]; c++) acc[joints[v0 * MAX_INF + c]] += weights[v0 * MAX_INF + c]; }
    let best = 0; for (let b = 1; b < nb; b++) if (acc[b] > acc[best] + 1e-9) best = b;
    triBone[t] = best;
  }
  const order = Int32Array.from({ length: nt }, (_, t) => t).sort((a, b) => bz[triBone[a]] - bz[triBone[b]] || bd[triBone[a]] - bd[triBone[b]] || a - b);
  // outline colour: the dominant colour of the drawing's rim (>= 60% of rim pixels)
  const rim = rimOf(img32, w, h);
  let outline = 0;
  if (m.outline !== false) {
    if (typeof m.outline === 'string') { const c = m.outline.replace('#', ''); outline = ((255 << 24) | (parseInt(c.slice(4, 6), 16) << 16) | (parseInt(c.slice(2, 4), 16) << 8) | parseInt(c.slice(0, 2), 16)) >>> 0; }
    else {
      const cnt = new Map(); let tot = 0;
      for (let i = 0; i < w * h; i++) if (rim[i]) { tot++; cnt.set(img32[i], (cnt.get(img32[i]) || 0) + 1); }
      let best = 0, bc = 0; for (const [c, k] of cnt) if (k > bc || (k === bc && c < best)) { best = c; bc = k; }
      if (tot && bc / tot >= 0.6) outline = best;
    }
  }
  const bigData = upscale(src.img, w, h, 8).data;
  return {
    name, view, host: m.part ?? null, canvas: src.canvas ?? null, w, h, origin, step, img32, big32: new Uint32Array(bigData.buffer, bigData.byteOffset, w * h * 64), rim, mask,
    label: L.label, gw: L.gw, verts: L.verts, tris: L.tris, triCell: L.triCell, triComp: L.triComp, triBone, order,
    bones: names, segs, joints, weights, counts, shapes, outline, sampling: m.sampling ?? 'rotsprite', z: m.z ?? (m.part !== undefined ? null : 0),
    absorb: m.absorb ? m.absorb.slice() : names.filter((b) => b !== m.part),
    report: { method, step, vertices: n, triangles: nt, bones: names.length, max_influences: maxInf, over_4_influences: over, unweighted, fallback, non_normalised: nonNorm, unused_bones: names.filter((_, b) => !perBone[b]), per_bone: Object.fromEntries(names.map((b, k) => [b, perBone[k]])) },
  };
}

/**
 * Fit a deform shape to a variant drawing: silhouette vertices move to the nearest silhouette
 * corner of the variant (within 2 lattice steps), interior vertices follow harmonically.
 */
function fitVariant(L, n, adj, mask, base32, var32, w, h, s, d) {
  const corner = (img, x, y) => { let on = 0, tot = 0; for (const [px, py] of [[x - 1, y - 1], [x, y - 1], [x - 1, y], [x, y]]) { tot++; if (px >= 0 && py >= 0 && px < w && py < h && img[py * w + px] >>> 24) on++; } return on > 0 && on < tot; };
  const vc = [];
  for (let y = 0; y <= h; y++) for (let x = 0; x <= w; x++) if (corner(var32, x, y)) vc.push(x, y);
  const H = new Float64Array(n), bx = new Float64Array(n), by = new Float64Array(n);
  const R = 2 * s + 2;
  for (let i = 0; i < n; i++) {
    const x = L.verts[2 * i], y = L.verts[2 * i + 1];
    if (!corner(base32, x, y)) continue;
    let best = -1, bd = R * R + 1e-9;
    for (let k = 0; k < vc.length; k += 2) { const q = (vc[k] - x) ** 2 + (vc[k + 1] - y) ** 2; if (q < bd) { bd = q; best = k; } }
    H[i] = 1e3;
    if (best >= 0) { bx[i] = vc[best] - x; by[i] = vc[best + 1] - y; }
  }
  if (!H.some((v) => v > 0)) return;
  for (let i = 0; i < n; i++) if (!H[i] && !adj[i].length) H[i] = 1e3;
  const fx = solveCG(adj, H, bx.map((v, i) => v * H[i]), bx), fy = solveCG(adj, H, by.map((v, i) => v * H[i]), by);
  for (let i = 0; i < n; i++) { d[2 * i] += fx[i]; d[2 * i + 1] += fy[i]; }
}

// ---------- deform + render ----------
/** Shape weights of a frame: pose shapes {name: w} + joint-angle drivers. */
export function shapeWeights(rig, built, world, P) {
  const out = new Float64Array(built.shapes.length);
  built.shapes.forEach((s, k) => {
    let wv = Number(P?.shapes?.[s.name] ?? 0) || 0;
    if (s.driver) {
      const b = s.driver.bone, par = rig.parts[b].parent;
      const ang = par ? adiff(world[par].rot, world[b].rot) : adiff(0, world[b].rot);
      wv += clamp((ang - s.driver.from) / (s.driver.to - s.driver.from), 0, 1);
    }
    out[k] = clamp(wv, 0, 1);
  });
  return out;
}

/** Deformed vertex positions (frame px) of a built mesh for a solved frame. -> {pos, rest, sw, active} */
export function deformVerts(rig, built, VP, world, P, bindWorld) {
  const nb = built.bones.length, n = built.verts.length / 2;
  const A = new Float64Array(nb * 6);
  built.bones.forEach((b, k) => {
    const T = world[b], v = poseOf(rig, VP, b), B = bindWorld[b];
    const sx = (T.flip ? -1 : 1) * Math.max(0.05, v.sx), sy = Math.max(0.05, v.sy), c = Math.cos(T.rot * D2R), s = Math.sin(T.rot * D2R);
    const a = c * sx, bb = -s * sy, cc = s * sx, dd = c * sy;
    const ox = built.origin[0] - B.x, oy = built.origin[1] - B.y; // source px -> offset from the bind joint
    A.set([a, bb, cc, dd, T.x + a * ox + bb * oy, T.y + cc * ox + dd * oy], k * 6);
  });
  const sw = shapeWeights(rig, built, world, P);
  const rest = Float64Array.from(built.verts);
  sw.forEach((wv, k) => { if (wv > 0) { const d = built.shapes[k].d; for (let i = 0; i < 2 * n; i++) rest[i] += wv * d[i]; } });
  const pos = new Float64Array(2 * n);
  for (let i = 0; i < n; i++) {
    const x = rest[2 * i], y = rest[2 * i + 1];
    let X = 0, Y = 0;
    for (let c = 0; c < built.counts[i]; c++) {
      const k = built.joints[i * MAX_INF + c], wv = built.weights[i * MAX_INF + c], o = k * 6;
      X += wv * (A[o] * x + A[o + 1] * y + A[o + 4]); Y += wv * (A[o + 2] * x + A[o + 3] * y + A[o + 5]);
    }
    pos[2 * i] = X; pos[2 * i + 1] = Y;
  }
  // the strongest variant shape at >= 0.5 swaps its drawing in
  let active = -1;
  sw.forEach((wv, k) => { if (built.shapes[k].variant && wv >= 0.5 && (active < 0 || wv > sw[active])) active = k; });
  return { pos, rest, sw, active };
}

const SUB3 = [1 / 6, 0.5, 5 / 6];
/** Most frequent value (first wins ties). */
const majority = (a) => { let b0 = a[0], bc = 0; for (const q of a) { const c = a.filter((z) => z === q).length; if (c > bc) { bc = c; b0 = q; } } return b0; };

/**
 * Draw a skinned mesh for a solved frame into out32 (FW x FH, pad offset ox/oy): inverse-mapped
 * nearest sampling in the 8x Scale2x drawing, 3x3 majority (rotsprite), exact copies where a
 * triangle only translates, cleanup + outline repair on resampled pixels. mark(x, y) for traces.
 */
export function drawSkin(rig, built, VP, world, P, bindWorld, out32, FW, FH, ox, oy, { sampling, mark, layerMask } = {}) {
  const D = deformVerts(rig, built, VP, world, P, bindWorld);
  const { pos } = D;
  const n = built.verts.length / 2, w = built.w, h = built.h;
  const mode = sampling ?? built.sampling;
  const sub = mode === 'nearest8' ? 1 : 3, offs = sub === 1 ? [0.5] : SUB3, need = sub === 1 ? 1 : 5;
  const k8 = mode === 'smooth' ? 1 : 8;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < n; i++) { const X = pos[2 * i] + ox, Y = pos[2 * i + 1] + oy; if (X < x0) x0 = X; if (X > x1) x1 = X; if (Y < y0) y0 = Y; if (Y > y1) y1 = Y; }
  const bx = Math.max(0, Math.floor(x0) - 1), by = Math.max(0, Math.floor(y0) - 1), ex = Math.min(FW, Math.ceil(x1) + 1), ey = Math.min(FH, Math.ceil(y1) + 1);
  const bw = ex - bx, bh = ey - by;
  if (bw <= 0 || bh <= 0) return { drawn: 0, shapes: D.sw };
  const SS = sub * sub;
  const subCol = new Uint32Array(bw * bh * SS), subFlag = new Uint8Array(bw * bh * SS); // flag: 1 rim, 2 exact
  const V = D.active >= 0 ? built.shapes[D.active].variant : null;
  const Vd = D.active >= 0 ? built.shapes[D.active].d : null;
  const gw = built.gw, s = built.step;
  for (const t of built.order) {
    if (layerMask && !layerMask.has(built.bones[built.triBone[t]])) continue;
    const a = built.tris[3 * t], b = built.tris[3 * t + 1], c = built.tris[3 * t + 2];
    const qx0 = pos[2 * a] + ox, qy0 = pos[2 * a + 1] + oy, qx1 = pos[2 * b] + ox, qy1 = pos[2 * b + 1] + oy, qx2 = pos[2 * c] + ox, qy2 = pos[2 * c + 1] + oy;
    const det = (qx1 - qx0) * (qy2 - qy0) - (qx2 - qx0) * (qy1 - qy0);
    if (Math.abs(det) < 1e-9) continue;
    // source coords: the rest drawing (texture rides on the bind lattice); variant: rest + its fit
    const sx0 = built.verts[2 * a], sy0 = built.verts[2 * a + 1], sx1 = built.verts[2 * b], sy1 = built.verts[2 * b + 1], sx2 = built.verts[2 * c], sy2 = built.verts[2 * c + 1];
    // affine dest -> source: S = s0 + [s1-s0, s2-s0] * Q^-1 * (P - q0)
    const i00 = (qy2 - qy0) / det, i01 = -(qx2 - qx0) / det, i10 = -(qy1 - qy0) / det, i11 = (qx1 - qx0) / det;
    const m00 = (sx1 - sx0) * i00 + (sx2 - sx0) * i10, m01 = (sx1 - sx0) * i01 + (sx2 - sx0) * i11;
    const m10 = (sy1 - sy0) * i00 + (sy2 - sy0) * i10, m11 = (sy1 - sy0) * i01 + (sy2 - sy0) * i11;
    const exact = !V && Math.abs(m00 - 1) < 1e-6 && Math.abs(m11 - 1) < 1e-6 && Math.abs(m01) < 1e-6 && Math.abs(m10) < 1e-6;
    let vm = null;
    if (V) {
      const vx0 = sx0 + Vd[2 * a], vy0 = sy0 + Vd[2 * a + 1], vx1 = sx1 + Vd[2 * b], vy1 = sy1 + Vd[2 * b + 1], vx2 = sx2 + Vd[2 * c], vy2 = sy2 + Vd[2 * c + 1];
      vm = [vx0, vy0, (vx1 - vx0) * i00 + (vx2 - vx0) * i10, (vx1 - vx0) * i01 + (vx2 - vx0) * i11, (vy1 - vy0) * i00 + (vy2 - vy0) * i10, (vy1 - vy0) * i01 + (vy2 - vy0) * i11];
    }
    const cell = built.triCell[t], comp = built.triComp[t];
    const cx0 = (cell % gw) * s, cy0 = Math.floor(cell / gw) * s, cx1 = Math.min(w, cx0 + s) - 1, cy1 = Math.min(h, cy0 + s) - 1;
    const px0 = Math.max(bx, Math.floor(Math.min(qx0, qx1, qx2))), px1 = Math.min(ex - 1, Math.ceil(Math.max(qx0, qx1, qx2)));
    const py0 = Math.max(by, Math.floor(Math.min(qy0, qy1, qy2))), py1 = Math.min(ey - 1, Math.ceil(Math.max(qy0, qy1, qy2)));
    const sample = (X, Y) => { // -> [colour, flag] or null
      const dx = X - qx0, dy = Y - qy0;
      const l1 = i00 * dx + i01 * dy, l2 = i10 * dx + i11 * dy;
      if (l1 < -1e-9 || l2 < -1e-9 || l1 + l2 > 1 + 1e-9) return null;
      if (V) {
        const u = vm[0] + vm[2] * dx + vm[3] * dy, v = vm[1] + vm[4] * dx + vm[5] * dy;
        const iu = clamp(Math.floor(u), 0, w - 1), iv = clamp(Math.floor(v), 0, h - 1);
        const bu = clamp(Math.floor(u * 8), iu * 8, iu * 8 + 7), bv = clamp(Math.floor(v * 8), iv * 8, iv * 8 + 7);
        const c = k8 === 8 ? V.big32[bv * w * 8 + bu] : V.img32[iv * w + iu];
        return c >>> 24 ? [c, V.rim[iv * w + iu]] : null;
      }
      const u = sx0 + m00 * dx + m01 * dy, v = sy0 + m10 * dx + m11 * dy;
      const iu = clamp(Math.floor(u), cx0, cx1), iv = clamp(Math.floor(v), cy0, cy1), pi = iv * w + iu;
      if (!built.mask[pi] || built.label[pi] !== comp) return null;
      let c;
      if (exact) c = built.img32[pi];
      else { const bu = clamp(Math.floor(u * 8), iu * 8, iu * 8 + 7), bv = clamp(Math.floor(v * 8), iv * 8, iv * 8 + 7); c = k8 === 8 ? built.big32[bv * w * 8 + bu] : built.img32[pi]; }
      return c >>> 24 ? [c, built.rim[pi] | (exact ? 2 : 0)] : null;
    };
    for (let py = py0; py <= py1; py++) for (let px = px0; px <= px1; px++) {
      const base = ((py - by) * bw + (px - bx)) * SS;
      if (exact) { // the whole pixel follows its centre: an exact copy of a translated pixel
        const r = sample(px + 0.5, py + 0.5);
        if (r) for (let q = 0; q < SS; q++) { subCol[base + q] = r[0]; subFlag[base + q] = r[1]; }
        continue;
      }
      for (let j = 0; j < sub; j++) for (let i = 0; i < sub; i++) {
        const r = sample(px + offs[i], py + offs[j]);
        if (r) { subCol[base + j * sub + i] = r[0]; subFlag[base + j * sub + i] = r[1]; }
      }
    }
  }
  // reduce: majority colour of the covered subsamples (only colours of the drawing)
  const col = new Uint32Array(bw * bh), flg = new Uint8Array(bw * bh);
  const cols = new Uint32Array(9), cnt = new Uint8Array(9), fl = new Uint8Array(9);
  for (let p = 0; p < bw * bh; p++) {
    let hits = 0, nc = 0;
    for (let q = 0; q < SS; q++) {
      const c = subCol[p * SS + q];
      if (!c) continue;
      hits++;
      let k = 0; while (k < nc && cols[k] !== c) k++;
      if (k === nc) { cols[nc] = c; cnt[nc] = 0; fl[nc] = subFlag[p * SS + q]; nc++; }
      cnt[k]++;
      fl[k] |= subFlag[p * SS + q] & 2;
    }
    if (hits < need) continue;
    let best = 0; for (let k = 1; k < nc; k++) if (cnt[k] > cnt[best]) best = k;
    col[p] = cols[best]; flg[p] = fl[best];
  }
  const at = (i, j) => (i < 0 || j < 0 || i >= bw || j >= bh ? 0 : col[j * bw + i]);
  if (sub === 3) {
    // cleanup of resampled pixels: fill pinholes, drop stray single pixels (exact copies untouched)
    const fix = col.slice();
    for (let j = 0; j < bh; j++) for (let i = 0; i < bw; i++) {
      const p = j * bw + i;
      if (flg[p] & 2) continue;
      if (!col[p]) {
        const n4 = [at(i - 1, j), at(i + 1, j), at(i, j - 1), at(i, j + 1)];
        if (n4.every((q) => q)) { fix[p] = majority(n4); flg[p] = 0; }
      } else {
        let any = false;
        for (let b = -1; b <= 1 && !any; b++) for (let a = -1; a <= 1; a++) if ((a || b) && at(i + a, j + b)) { any = true; break; }
        if (!any) fix[p] = 0;
      }
    }
    col.set(fix);
  }
  if (built.outline) {
    // outline repair: a resampled pixel on the new silhouette that came from inside the drawing
    // gets the outline colour; a resampled rim pixel buried inside takes its neighbours' colour
    const fix = col.slice();
    for (let j = 0; j < bh; j++) for (let i = 0; i < bw; i++) {
      const p = j * bw + i, c = col[p];
      if (!c || flg[p] & 2) continue;
      const n4 = [at(i - 1, j), at(i + 1, j), at(i, j - 1), at(i, j + 1)];
      const edge = n4.some((q) => !q);
      if (edge && !(flg[p] & 1)) fix[p] = built.outline;
      else if (!edge && flg[p] & 1 && c === built.outline) {
        const nr = [[i - 1, j], [i + 1, j], [i, j - 1], [i, j + 1]].filter(([a, b]) => !(flg[b * bw + a] & 1)).map(([a, b]) => col[b * bw + a]);
        if (nr.length === 4) fix[p] = majority(nr);
      }
    }
    col.set(fix);
  }
  let drawn = 0;
  for (let j = 0; j < bh; j++) for (let i = 0; i < bw; i++) {
    const c = col[j * bw + i];
    if (!c) continue;
    out32[(by + j) * FW + bx + i] = c;
    drawn++;
    if (mark) mark(bx + i, by + j);
  }
  return { drawn, shapes: D.sw };
}

// ---------- per frame ----------
/**
 * Skin state of a drawn view for renderPose: meshes with a drawing in this view, the parts they
 * replace (host + absorbed) and the bind pose. -> null when the rig has no skin.
 */
export function skinView(rig, partsDoc, view, cache) {
  if (!rig.skin) return null;
  const key = `__skin|${view}|${partsDoc.version ?? 0}`;
  if (cache?.has(key)) return cache.get(key);
  const meshes = [], replaced = new Set();
  for (const m of Object.values(rig.skin)) {
    const b = buildSkinMesh(rig, partsDoc, m, view);
    if (!b) continue;
    meshes.push(b);
    if (b.host) replaced.add(b.host);
    for (const n of b.absorb) replaced.add(n);
  }
  const out = { meshes, replaced, bind: worldOf(rig, {}, view) };
  cache?.set(key, out);
  return out;
}

/** Heat map of one bone's weights (blue 0 .. red 1) over the drawing, with the mesh wireframe, side by side with the drawing. -> {width, height, data} */
export function weightsImage(built, bone, scale = 4) {
  const w = built.w, h = built.h, k = Math.max(1, Math.round(scale));
  const b = bone === undefined || bone === null ? -1 : built.bones.indexOf(bone);
  if (bone !== undefined && bone !== null && b < 0) throw new Error(`weights: "${bone}" is not a bone of mesh "${built.name}" (bones: ${built.bones.join(', ')})`);
  const W = (w * 2 + 1) * k, H = h * k;
  const out = new Uint8ClampedArray(W * H * 4);
  const n = built.verts.length / 2;
  // per-vertex weight of the bone (or the dominant bone hue)
  const vw = new Float64Array(n), vb = new Int32Array(n);
  for (let i = 0; i < n; i++) { let best = 0; for (let c = 0; c < built.counts[i]; c++) { const j = built.joints[i * MAX_INF + c], wv = built.weights[i * MAX_INF + c]; if (j === b) vw[i] = wv; if (wv > best) { best = wv; vb[i] = j; } } }
  const ramp = (t) => [Math.round(40 + 215 * t), Math.round(60 + 120 * (1 - Math.abs(t - 0.5) * 2)), Math.round(255 * (1 - t))];
  const hue = (j) => { const a = (j * 137.508) % 360, c = [0, 8, 4].map((o) => { const x = (o + a / 30) % 12; return Math.round(255 * (0.55 - 0.45 * Math.max(-1, Math.min(x - 3, 9 - x, 1)))); }); return c; };
  const put = (x, y, c, a = 255) => { for (let j = 0; j < k; j++) for (let i = 0; i < k; i++) { const o = ((y * k + j) * W + x * k + i) * 4; out[o] = c[0]; out[o + 1] = c[1]; out[o + 2] = c[2]; out[o + 3] = a; } };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const c = built.img32[y * w + x];
    if (c >>> 24) put(x, y, [c & 255, (c >>> 8) & 255, (c >>> 16) & 255]);
  }
  // heat per pixel: barycentric interpolation of the vertex weights in the pixel's triangle
  const nt = built.tris.length / 3;
  for (let t = 0; t < nt; t++) {
    const a = built.tris[3 * t], bb = built.tris[3 * t + 1], c = built.tris[3 * t + 2];
    const [x0, y0, x1, y1, x2, y2] = [built.verts[2 * a], built.verts[2 * a + 1], built.verts[2 * bb], built.verts[2 * bb + 1], built.verts[2 * c], built.verts[2 * c + 1]];
    const det = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
    if (Math.abs(det) < 1e-12) continue;
    const cell = built.triCell[t], comp = built.triComp[t], s = built.step;
    const cx0 = (cell % built.gw) * s, cy0 = Math.floor(cell / built.gw) * s;
    for (let y = cy0; y < Math.min(h, cy0 + s); y++) for (let x = cx0; x < Math.min(w, cx0 + s); x++) {
      const pi = y * w + x;
      if (!built.mask[pi] || built.label[pi] !== comp) continue;
      const dx = x + 0.5 - x0, dy = y + 0.5 - y0;
      const l1 = ((y2 - y0) * dx - (x2 - x0) * dy) / det, l2 = (-(y1 - y0) * dx + (x1 - x0) * dy) / det;
      if (l1 < -1e-9 || l2 < -1e-9 || l1 + l2 > 1 + 1e-9) continue;
      const l0 = 1 - l1 - l2;
      if (b >= 0) put(w + 1 + x, y, ramp(clamp(l0 * vw[a] + l1 * vw[bb] + l2 * vw[c], 0, 1)));
      else put(w + 1 + x, y, hue([vb[a], vb[bb], vb[c]][[l0, l1, l2].indexOf(Math.max(l0, l1, l2))]));
    }
  }
  // wireframe (both panels) + bones on the heat panel
  const line = (xa, ya, xb, yb, c, a, off) => {
    const L = Math.max(1, Math.ceil(Math.hypot(xb - xa, yb - ya) * k));
    for (let i = 0; i <= L; i++) {
      const X = Math.round((xa + ((xb - xa) * i) / L) * k + off * k), Y = Math.round((ya + ((yb - ya) * i) / L) * k);
      if (X < 0 || Y < 0 || X >= W || Y >= H) continue;
      const o = (Y * W + X) * 4;
      out[o] = Math.round(out[o] * (1 - a / 255) + c[0] * (a / 255)); out[o + 1] = Math.round(out[o + 1] * (1 - a / 255) + c[1] * (a / 255)); out[o + 2] = Math.round(out[o + 2] * (1 - a / 255) + c[2] * (a / 255)); out[o + 3] = Math.max(out[o + 3], a);
    }
  };
  if (k >= 3) for (let t = 0; t < nt; t++) for (let e = 0; e < 3; e++) {
    const p = built.tris[3 * t + e], q = built.tris[3 * t + (e + 1) % 3];
    for (const off of [0, w + 1]) line(built.verts[2 * p], built.verts[2 * p + 1], built.verts[2 * q], built.verts[2 * q + 1], [255, 255, 255], 110, off);
  }
  for (const [j, sg] of built.segs.entries()) line(sg.head[0], sg.head[1], sg.tail[0], sg.tail[1], j === b ? [255, 255, 0] : [20, 20, 20], 255, w + 1);
  return { width: W, height: H, data: out };
}

/** Compact weights report (per_bone without zeros). */
export function compactSkinReport(r) {
  const { per_bone, ...rest } = r;
  return { ...rest, per_bone: Object.fromEntries(Object.entries(per_bone).filter(([, v]) => v)) };
}
