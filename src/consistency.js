// Cross-view consistency of a rig's drawn cells (2D rotated sprites drawn once per view): the
// same part must read as the same object in every view. Checks per part and view: empty cells,
// palette drift (colours used in one view only), bone length drift (the drawn extent along the
// bone; foreshortening happens at render time, so every view draws the full length), the pivot and
// child joints sitting on the drawing (no gaps at the elbow), and the rest silhouette height.
// derive copies a view's cells into other views as a start to paint over.
import { cellOf, partIn, renderPose } from './rig.js';

const r2 = (v) => Math.round(v * 100) / 100;

/** Pixel statistics of one cell of the composite. */
function cellStats(rig, comp, W, name, view, variant = 'base') {
  const c = cellOf(rig, name, view, variant);
  let n = 0, x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
  const colors = new Set();
  const opaque = (x, y) => x >= 0 && y >= 0 && x < c.w && y < c.h && comp[((c.y + y) * W + c.x + x) * 4 + 3] > 0;
  for (let y = 0; y < c.h; y++) for (let x = 0; x < c.w; x++) {
    const o = ((c.y + y) * W + c.x + x) * 4;
    if (!comp[o + 3]) continue;
    n++;
    colors.add((comp[o] << 16) | (comp[o + 1] << 8) | comp[o + 2]);
    if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y;
  }
  const near = (px, py, r = 1) => { for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) if (opaque(Math.round(px) + dx, Math.round(py) + dy)) return true; return false; };
  return { n, box: n ? [x0, y0, x1, y1] : null, colors, near, w: c.w, h: c.h };
}

const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0; };

/**
 * -> {pass, summary, issues:[{part, view, kind, message}], views:{view: {height}}}
 * opts: views (drawn views to compare), tolerance (0.2 = 20% length drift), limit
 */
export function consistencyReport(rig, d, comp, { views, tolerance, limit } = {}) {
  const W = d.width;
  const vs = (views || rig.views).filter((v) => rig.views.includes(v));
  const tol = Math.max(0.05, Number(tolerance ?? 0.2));
  const issues = [];
  const push = (part, view, kind, message) => issues.push({ part, view, kind, message });
  // a held weapon (and its attachments / magazine) is drawn in its base view only and projected
  const Wp = rig.weapon && rig.weapon.cells !== 'view' ? new Set([rig.weapon.part, ...Object.values(rig.weapon.attachments).map((x) => x.part), ...(rig.weapon.mag ? [rig.weapon.mag.part] : [])]) : new Set();
  for (const name of rig.order) {
    const P = rig.parts[name];
    if (P.art) continue; // draws another part's cell
    const st = {};
    for (const v of vs) {
      const p = partIn(rig, name, v);
      if (p.hidden || p.link) continue; // not drawn in this view (hidden, or reuses another view's drawing)
      if (Wp.has(name) && v !== rig.weapon.base) continue;
      st[v] = cellStats(rig, comp, W, name, v);
    }
    const drawn = Object.entries(st).filter(([, s]) => s.n > 0);
    if (!drawn.length) continue; // an optional slot left empty everywhere
    for (const [v, s] of Object.entries(st)) if (!s.n) push(name, v, 'empty', `${name} is drawn in ${drawn.map(([x]) => x).join(', ')} but empty in ${v} (draw it, art_rig derive {from:"${drawn[0][0]}", to:["${v}"], parts:["${name}"]}, or set views.${v}.link)`);
    if (drawn.length < 2) continue;
    // palette drift: colours of one view that no other view of the part uses
    const all = new Map();
    for (const [, s] of drawn) for (const c of s.colors) all.set(c, (all.get(c) || 0) + 1);
    for (const [v, s] of drawn) {
      const own = [...s.colors].filter((c) => all.get(c) === 1);
      if (own.length >= Math.max(1, Math.ceil(s.colors.size * 0.34))) push(name, v, 'palette', `${name}/${v} uses ${own.length} of ${s.colors.size} colours no other view of ${name} uses (palette drift: ${own.slice(0, 4).map((c) => '#' + c.toString(16).padStart(6, '0')).join(' ')})`);
    }
    // bone length: drawn extent below the pivot (limbs hang from their pivot) vs the other views
    const pv = (v) => partIn(rig, name, v).pivot;
    const len = Object.fromEntries(drawn.map(([v, s]) => [v, s.box[3] - Math.min(s.box[1], pv(v)[1]) + 1]));
    const med = median(Object.values(len));
    if (med >= 6) for (const [v, l] of Object.entries(len)) if (Math.abs(l - med) / med > tol) push(name, v, 'length', `${name}/${v} is drawn ${l}px long, ${Math.round((l / med - 1) * 100)}% off the other views (${med}px): the bone would stretch between views`);
    // pivot on the drawing, child joints on the drawing (no gap at the elbow / knee)
    for (const [v, s] of drawn) {
      const [px, py] = pv(v);
      if (!s.near(px, py, 1)) push(name, v, 'pivot', `${name}/${v}: the pivot [${px}, ${py}] is not on the drawing (the part floats off its joint)`);
      for (const c of rig.order) {
        if (rig.parts[c].parent !== name || rig.parts[c].art || partIn(rig, c, v).hidden) continue;
        const at = partIn(rig, c, v).at;
        if (!(Math.hypot(at[0], at[1]) > 0)) continue;
        if (!s.near(px + at[0], py + at[1], 2)) push(name, v, 'joint', `${name}/${v}: the joint to ${c} at [${r2(px + at[0])}, ${r2(py + at[1])}] is not on the drawing (gap between ${name} and ${c})`);
      }
    }
  }
  // silhouette: rest-pose height per view (a head drawn bigger in one view, legs shorter, ...)
  const heights = {};
  const cache = new Map();
  for (const v of vs) {
    const img = renderPose(rig, d, {}, v, cache, { sampling: 'nearest8' });
    const [FW, FH] = rig.frame;
    let top = -1, bot = -1;
    for (let y = 0; y < FH && top < 0; y++) for (let x = 0; x < FW; x++) if (img[(y * FW + x) * 4 + 3]) { top = y; break; }
    for (let y = FH - 1; y >= 0 && bot < 0; y--) for (let x = 0; x < FW; x++) if (img[(y * FW + x) * 4 + 3]) { bot = y; break; }
    if (top >= 0) heights[v] = bot - top + 1;
  }
  const hm = median(Object.values(heights));
  if (hm > 8) for (const [v, h] of Object.entries(heights)) if (Math.abs(h - hm) / hm > tol / 2) push('(rest pose)', v, 'silhouette', `rest silhouette in ${v} is ${h}px tall vs ${hm}px in the other views`);
  const lim = limit ?? 60;
  return {
    pass: issues.length === 0,
    summary: issues.length ? `${issues.length} consistency issues (${[...new Set(issues.map((i) => i.kind))].join(', ')}); first: ${issues[0].message}` : `consistent: ${rig.order.filter((n) => !rig.parts[n].art).length} parts across ${vs.length} views`,
    heights, ...(issues.length ? { issues: issues.slice(0, lim), ...(issues.length > lim ? { more: issues.length - lim } : {}) } : {}),
  };
}

/** Copy cells (all variants) from one view to others on the "parts" layer; flip mirrors about the pivot column. */
export function deriveCells(rig, d, { parts, from, to, flip = false, overwrite = false }) {
  const layer = d.layers.find((l) => l.name === 'parts') || d.layers[0];
  const W = d.width, copied = [], skipped = [];
  for (const name of parts) {
    if (rig.parts[name].art) continue;
    for (const variant of rig.parts[name].variants) for (const v of to) {
      const a = cellOf(rig, name, from, variant), b = cellOf(rig, name, v, variant);
      let used = false;
      for (let y = 0; y < b.h && !used; y++) for (let x = 0; x < b.w; x++) if (layer.data[((b.y + y) * W + b.x + x) * 4 + 3]) { used = true; break; }
      if (used && !overwrite) { skipped.push(`${name}${variant === 'base' ? '' : ':' + variant}/${v}`); continue; }
      const px = partIn(rig, name, from).pivot[0];
      for (let y = 0; y < a.h; y++) for (let x = 0; x < a.w; x++) {
        let sx = x;
        if (flip) { sx = Math.round(2 * px - x); if (sx < 0 || sx >= a.w) { layer.data.fill(0, ((b.y + y) * W + b.x + x) * 4, ((b.y + y) * W + b.x + x) * 4 + 4); continue; } }
        const s = ((a.y + y) * W + a.x + sx) * 4;
        layer.data.set(layer.data.subarray(s, s + 4), ((b.y + y) * W + b.x + x) * 4);
      }
      copied.push(`${name}${variant === 'base' ? '' : ':' + variant}/${v}`);
    }
  }
  return { copied, ...(skipped.length ? { skipped, note: 'cells already drawn are kept (overwrite:true replaces them)' } : {}) };
}
