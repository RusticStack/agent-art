// Form shading and cell patterns: the parts of pixel art that weaker models get wrong most
// (pillow shading, flat blobs, grid-like "stones"). Both stay strictly on the given ramp.
import { int, num, bayer, mulberry32 } from './util.js';
import { colorsEqual } from './color.js';

/** Light direction: "top-left" etc. or an angle in degrees (0 = from the right, 90 = from below, screen coords). */
function lightVector(light, elevation) {
  const names = { 'top-left': 225, top: 270, 'top-right': 315, right: 0, 'bottom-right': 45, bottom: 90, 'bottom-left': 135, left: 180 };
  const deg = typeof light === 'string' ? names[light] : Number(light ?? 225);
  if (deg === undefined || !Number.isFinite(deg)) throw new Error(`light must be a direction (${Object.keys(names).join(', ')}) or an angle in degrees`);
  const a = (deg * Math.PI) / 180, el = (num(elevation, 'elevation', 45) * Math.PI) / 180;
  return [Math.cos(a) * Math.cos(el), Math.sin(a) * Math.cos(el), Math.sin(el)];
}

/**
 * Distance (chamfer 3-4, in px) from each pixel to the nearest pixel outside its region.
 * region ids: Int32Array, 0 = outside. wrap: distances wrap around (tileable textures).
 */
function regionDistance(ids, w, h, wrap) {
  const INF = 1e9;
  const d = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) d[i] = ids[i] ? INF : 0;
  const idx = (x, y) => {
    if (wrap) return ((y + h) % h) * w + ((x + w) % w);
    return x < 0 || y < 0 || x >= w || y >= h ? -1 : y * w + x;
  };
  const relax = (x, y, dx, dy, cost) => {
    const i = y * w + x, j = idx(x + dx, y + dy);
    const v = j < 0 || ids[j] !== ids[i] ? cost * 0.5 : d[j] + cost; // border between regions counts as edge
    if (v < d[i]) d[i] = v;
  };
  for (let pass = 0; pass < (wrap ? 2 : 1); pass++) {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (ids[y * w + x]) {
      relax(x, y, -1, 0, 1); relax(x, y, 0, -1, 1); relax(x, y, -1, -1, 1.4142); relax(x, y, 1, -1, 1.4142);
    }
    for (let y = h - 1; y >= 0; y--) for (let x = w - 1; x >= 0; x--) if (ids[y * w + x]) {
      relax(x, y, 1, 0, 1); relax(x, y, 0, 1, 1); relax(x, y, 1, 1, 1.4142); relax(x, y, -1, 1, 1.4142);
    }
  }
  return d;
}

/**
 * Shade regions with a ramp from their geometry: rounded height field from the distance to the
 * region edge, normals, one directional light. Returns ramp index per pixel (-1 = untouched).
 */
function shadeField(ids, w, h, { light = 'top-left', elevation, depth, bias = 0, contrast = 1, profile = 'round', wrap = false, rampLen, dither = true, ox = 0, oy = 0, seed = 0, cleanup = 1 }) {
  const L = lightVector(light, elevation);
  const dist = regionDistance(ids, w, h, wrap);
  // default depth = each region's own max distance (a full dome); smaller = bevelled edges + flat top
  const maxD = new Map();
  for (let i = 0; i < w * h; i++) if (ids[i]) maxD.set(ids[i], Math.max(maxD.get(ids[i]) || 0, dist[i]));
  const height = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    if (!ids[i]) continue;
    const dep = depth ?? maxD.get(ids[i]);
    const t = Math.min(1, dist[i] / Math.max(0.5, dep));
    height[i] = profile === 'flat' ? Math.min(1, t * 1.5) : profile === 'sharp' ? t : Math.sqrt(1 - (1 - t) * (1 - t));
  }
  // smooth the height inside each region (chamfer distances are faceted -> pyramids/speckle)
  const smoothPasses = profile === 'flat' ? 1 : 2;
  for (let pass = 0; pass < smoothPasses; pass++) {
    const src = height.slice();
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x, id = ids[i];
      if (!id) continue;
      let sum = 0, n = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        let xx = x + dx, yy = y + dy;
        if (wrap) { xx = (xx + w) % w; yy = (yy + h) % h; }
        const inside = xx >= 0 && yy >= 0 && xx < w && yy < h && ids[yy * w + xx] === id;
        sum += inside ? src[yy * w + xx] : 0;
        n++;
      }
      height[i] = Math.max(src[i] * 0.35, sum / n); // keep the rim from collapsing
    }
  }
  const H = (x, y, own) => {
    if (wrap) { x = (x + w) % w; y = (y + h) % h; }
    if (x < 0 || y < 0 || x >= w || y >= h) return 0;
    const j = y * w + x;
    return ids[j] === own ? height[j] : 0;
  };
  const out = new Int16Array(w * h).fill(-1);
  const rnd = seed ? mulberry32(seed) : null;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x, id = ids[i];
    if (!id) continue;
    const k = Math.max(1, depth ?? maxD.get(id)) * 0.9;
    const gx = (H(x + 1, y, id) - H(x - 1, y, id)) * 0.5 * k, gy = (H(x, y + 1, id) - H(x, y - 1, id)) * 0.5 * k;
    let nx = -gx, ny = -gy, nz = 1;
    const nl = Math.hypot(nx, ny, nz);
    nx /= nl; ny /= nl; nz /= nl;
    // L points from the surface towards the light (screen coords, y down)
    const lit = Math.max(0, nx * L[0] + ny * L[1] + nz * L[2]);
    // a face pointing at the viewer gets the middle tone; towards the light brighter, away darker
    // lit=1 (facing the light) -> top of the ramp, lit=0 (facing away) -> bottom
    const rel = lit >= L[2] ? (lit - L[2]) / Math.max(1e-3, 1 - L[2]) : (lit - L[2]) / Math.max(1e-3, L[2]);
    let v = 0.5 + bias + rel * 0.5 * contrast;
    if (rnd) v += (rnd() - 0.5) * 0.08;
    v = Math.max(0, Math.min(1, v));
    const p = v * (rampLen - 1);
    let s = Math.floor(p);
    if (dither ? p - s > bayer(x + ox, y + oy) : p - s >= 0.5) s++;
    out[i] = Math.max(0, Math.min(rampLen - 1, s));
  }
  // cleanup: a lone tone pixel (no same-tone neighbour in its own shape) joins the most common
  // neighbouring tone — banding at small sizes otherwise reads as speckle
  for (let pass = 0; pass < cleanup; pass++) {
    const src = out.slice();
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x, id = ids[i];
      if (!id) continue;
      const tones = [];
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        let xx = x + dx, yy = y + dy;
        if (wrap) { xx = (xx + w) % w; yy = (yy + h) % h; }
        if (xx < 0 || yy < 0 || xx >= w || yy >= h || ids[yy * w + xx] !== id) continue;
        tones.push(src[yy * w + xx]);
      }
      if (tones.length < 2 || tones.includes(src[i])) continue;
      const cnt = new Map();
      for (const t of tones) cnt.set(t, (cnt.get(t) || 0) + 1);
      // prefer the closest tone among the most common ones so shading order is preserved
      out[i] = [...cnt.entries()].sort((p, q) => q[1] - p[1] || Math.abs(p[0] - src[i]) - Math.abs(q[0] - src[i]))[0][0];
    }
  }
  return out;
}

function rampOf(ctx, a) {
  const list = a.colors ?? a.ramp;
  if (!Array.isArray(list) || list.length < 2) throw new Error('shade needs "colors": a ramp dark->light with 2+ colors (e.g. palette keys ["s0","s1","s2","s3","s4"])');
  return list.map((c) => ctx.color(c));
}

export const SHADING = {
  /**
   * Automatic form shading on existing shapes. Which pixels: of (color/colors), else every
   * painted pixel in the region (respects mask). per_color: each color = separate shape.
   */
  shade(ctx, a) {
    const ramp = rampOf(ctx, a);
    const r = ctx.region(a);
    const x0 = Math.max(0, r.x), y0 = Math.max(0, r.y), x1 = Math.min(ctx.w, r.x + r.w), y1 = Math.min(ctx.h, r.y + r.h);
    const w = x1 - x0, h = y1 - y0;
    if (w <= 0 || h <= 0) return 'nothing to shade';
    const of = a.of === undefined ? null : (Array.isArray(a.of) ? a.of : [a.of]).map((c) => ctx.color(c));
    const tol = Number(a.tolerance ?? 0);
    const ids = new Int32Array(w * h);
    const colorId = new Map();
    let n = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const c = ctx.get(x0 + x, y0 + y);
      if (!c || !c[3]) continue;
      if (of && !of.some((o) => colorsEqual(c, o, tol))) continue;
      let id = 1;
      if (a.per_color) {
        const k = c.join(',');
        if (!colorId.has(k)) colorId.set(k, colorId.size + 1);
        id = colorId.get(k);
      }
      ids[y * w + x] = id;
      n++;
    }
    if (!n) throw new Error(`shade: no pixels to shade in the region${of ? ' with the "of" colors' : ''} — draw the shape first (any color), then shade it`);
    const field = shadeField(ids, w, h, {
      light: a.light, elevation: a.elevation, depth: a.depth === undefined ? undefined : num(a.depth, 'depth'),
      bias: num(a.bias, 'bias', 0), contrast: num(a.contrast, 'contrast', 1), profile: a.profile || 'round',
      wrap: !!a.wrap, rampLen: ramp.length, dither: a.dither === true || a.dither === 'bayer', ox: x0, oy: y0, cleanup: a.cleanup === false ? 0 : int(a.cleanup ?? 1, 'cleanup'),
    });
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const s = field[y * w + x];
      if (s >= 0) ctx.set(x0 + x, y0 + y, ramp[s]);
    }
    return `shaded ${n} px with ${ramp.length} tones`;
  },

  /**
   * Cell pattern (cobblestones, scales, tiles, cracked earth): jittered-grid Voronoi cells, each
   * shaded as its own rounded bump, separated by gap (mortar) lines. Tileable over the region.
   */
  cells(ctx, a) {
    const { x: rx, y: ry, w, h } = ctx.region(a);
    const ramp = rampOf(ctx, a);
    const gapC = a.gap_color !== undefined ? ctx.color(a.gap_color) : null;
    const gap = Math.max(0, int(a.gap ?? 1, 'gap'));
    // size: one number, or [w, h] for cells of their own width and height
    const sz = Array.isArray(a.size) ? a.size : [a.size, a.size];
    if (Array.isArray(a.size) && a.size.length !== 2) throw new Error('size: a number or [w, h]');
    const size = Math.max(2, num(sz[1], 'size', Math.max(3, Math.round(Math.min(w, h) / 3))));
    const sizeX = Math.max(2, num(sz[0], 'size', size));
    const jitter = Math.max(0, Math.min(1, num(a.jitter, 'jitter', 0.8)));
    const stretch = num(a.stretch, 'stretch', 1); // >1 = wider cells (bricks/planks-ish), <1 = taller
    const seed = int(a.seed ?? 1, 'seed');
    const rnd = mulberry32(seed);
    const gw = Math.max(1, Math.round(w / (sizeX * stretch))), gh = Math.max(1, Math.round(h / size));
    const cw = w / gw, ch = h / gh;
    const pts = [];
    // random global offset so cell borders do not line up with the tile edges (grid look)
    const gox = rnd() * cw, goy = a.layout === 'brick' ? 0 : rnd() * ch;
    for (let j = 0; j < gh; j++) for (let i = 0; i < gw; i++) {
      const off = a.layout === 'brick' && j % 2 ? 0.5 : 0;
      pts.push([((i + 0.5 + off + (rnd() - 0.5) * jitter) * cw + gox) % w, ((j + 0.5 + (rnd() - 0.5) * jitter) * ch + goy) % h, rnd()]);
    }
    // assign each pixel to its nearest cell centre (wrapping distance => tileable)
    const ids = new Int32Array(w * h);
    const tone = [];
    // nearest centre: only grid cells within 2 of the pixel's own cell can win (jitter < 1 cell)
    const near = gw > 5 && gh > 5;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let best = Infinity, bi = 0;
      const cand = [];
      if (near) {
        const gi = Math.floor((((x + 0.5 - gox) % w + w) % w) / cw), gj = Math.floor((((y + 0.5 - goy) % h + h) % h) / ch);
        for (let j = gj - 2; j <= gj + 2; j++) for (let i = gi - 3; i <= gi + 3; i++) cand.push(((j + gh) % gh) * gw + ((i + gw) % gw));
      }
      const list = near ? cand : pts.keys();
      for (const k of list) {
        let dx = Math.abs(x + 0.5 - pts[k][0]), dy = Math.abs(y + 0.5 - pts[k][1]);
        dx = Math.min(dx, w - dx); dy = Math.min(dy, h - dy);
        const dd = Math.hypot(dx / stretch, dy);
        if (dd < best) { best = dd; bi = k; }
      }
      ids[y * w + x] = bi + 1;
    }
    // gaps (mortar): pixels bordering a different cell. One side only for gap 1 (clean 1px lines),
    // both sides for 2+, wrapping so the pattern stays tileable.
    if (gap) {
      const src = ids.slice();
      const at = (x, y) => src[((y + h) % h) * w + ((x + w) % w)];
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const me = at(x, y);
        let edge = false;
        for (let r = 1; r <= Math.max(1, gap - 1) && !edge; r++) {
          const nb = gap === 1 ? [at(x + 1, y), at(x, y + 1)] : [at(x + r, y), at(x - r, y), at(x, y + r), at(x, y - r)];
          edge = nb.some((o) => o !== me);
        }
        if (edge) ids[y * w + x] = 0;
      }
    }
    for (let k = 0; k < pts.length; k++) tone[k + 1] = pts[k][2];
    const field = shadeField(ids, w, h, {
      light: a.light, elevation: a.elevation, depth: a.depth === undefined ? undefined : num(a.depth, 'depth'), bias: num(a.bias, 'bias', 0),
      contrast: num(a.contrast, 'contrast', 1), profile: a.profile || 'round', wrap: true, rampLen: ramp.length, dither: a.dither === true || a.dither === 'bayer', ox: rx, oy: ry, cleanup: a.cleanup === false ? 0 : int(a.cleanup ?? 1, 'cleanup'),
    });
    const variation = num(a.variation, 'variation', 1); // per-cell tone shift in ramp steps
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const id = ids[y * w + x];
      if (!id) { if (gapC) ctx.set(rx + x, ry + y, gapC); continue; }
      const shift = Math.round((tone[id] - 0.5) * 2 * variation);
      const s = Math.max(0, Math.min(ramp.length - 1, field[y * w + x] + shift));
      ctx.set(rx + x, ry + y, ramp[s]);
    }
    return `${pts.length} cells`;
  },
};
