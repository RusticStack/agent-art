// Lighting & atmosphere commands for 2.5D / HD-2D style art. All of them stay pixel-art
// friendly: intensities can be quantized into a few bands with ordered (Bayer) dithering,
// and `quantize` snaps the result back onto the palette.
import { parseColor, blendOver } from './color.js';
import { int, num, band, hash3, smooth, mulberry32, bayer } from './util.js';

const lum = (c) => (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255;
const clamp = (v) => Math.max(0, Math.min(255, Math.round(v)));

function lerpColor(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t, a[3]].map(clamp);
}

/** Apply a light/paint contribution of strength s (0..1) with color col to pixel c. */
function applyLight(c, col, s, mode, onEmpty) {
  if (s <= 0) return null;
  if (c[3] === 0) return onEmpty ? blendOver(c, [col[0], col[1], col[2], clamp(s * col[3])]) : null;
  const k = s * (col[3] / 255);
  switch (mode) {
    case 'add': return [clamp(c[0] + col[0] * k), clamp(c[1] + col[1] * k), clamp(c[2] + col[2] * k), c[3]];
    case 'screen': return lerpColor(c, [255 - ((255 - c[0]) * (255 - col[0])) / 255, 255 - ((255 - c[1]) * (255 - col[1])) / 255, 255 - ((255 - c[2]) * (255 - col[2])) / 255, c[3]], k);
    case 'multiply': return lerpColor(c, [(c[0] * col[0]) / 255, (c[1] * col[1]) / 255, (c[2] * col[2]) / 255, c[3]], k);
    case 'paint': return blendOver(c, [col[0], col[1], col[2], clamp(s * col[3])]);
    default: throw new Error('mode must be add, screen, multiply or paint');
  }
}

function regionOf(ctx, a) {
  const R = Array.isArray(a.region) ? { x: a.region[0], y: a.region[1], w: a.region[2], h: a.region[3] } : a.region || {};
  return ctx.region({ x: a.rx ?? R.x, y: a.ry ?? R.y, w: a.rw ?? R.w, h: a.rh ?? R.h });
}

function valueNoise2(x, y, seed) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const fx = smooth(x - xi), fy = smooth(y - yi);
  const v = (i, j) => hash3(i, j, seed);
  const a = v(xi, yi), b = v(xi + 1, yi), c = v(xi, yi + 1), d = v(xi + 1, yi + 1);
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}

/** Separable box blur. wrap = sample across edges (seamless tiles). */
function boxBlur(buf, w, h, r, channels = 4, wrap = false) {
  if (r <= 0) return buf;
  const tmp = new Float32Array(buf.length);
  const out = new Float32Array(buf.length);
  // horizontal
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    for (let k = 0; k < channels; k++) {
      let s = 0, n = 0;
      for (let dx = -r; dx <= r; dx++) {
        let xx = x + dx;
        if (wrap) xx = ((xx % w) + w) % w;
        else if (xx < 0 || xx >= w) continue;
        s += buf[(y * w + xx) * channels + k]; n++;
      }
      tmp[(y * w + x) * channels + k] = s / n;
    }
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    for (let k = 0; k < channels; k++) {
      let s = 0, n = 0;
      for (let dy = -r; dy <= r; dy++) {
        let yy = y + dy;
        if (wrap) yy = ((yy % h) + h) % h;
        else if (yy < 0 || yy >= h) continue;
        s += tmp[(yy * w + x) * channels + k]; n++;
      }
      out[(y * w + x) * channels + k] = s / n;
    }
  }
  return out;
}

export const EFFECTS = {
  /** Point/elliptical light (or darkness with mode multiply). */
  light(ctx, a) {
    const col = ctx.color(a.color ?? '#fff3c4');
    const cx = num(a.x, 'x', ctx.w / 2), cy = num(a.y, 'y', ctx.h / 2);
    const rx = Math.max(1, num(a.radius, 'radius', 8)), ry = Math.max(1, num(a.radius_y, 'radius_y', rx));
    const intensity = num(a.intensity, 'intensity', 0.6);
    const steps = int(a.steps ?? 4, 'steps');
    const dither = a.dither !== false;
    const mode = a.mode || 'add';
    const fall = a.falloff || 'smooth';
    const reg = regionOf(ctx, a);
    const x0 = Math.max(reg.x, Math.floor(cx - rx)), x1 = Math.min(reg.x + reg.w - 1, Math.ceil(cx + rx));
    const y0 = Math.max(reg.y, Math.floor(cy - ry)), y1 = Math.min(reg.y + reg.h - 1, Math.ceil(cy + ry));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const dx = (x + 0.5 - cx) / rx, dy = (y + 0.5 - cy) / ry;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d >= 1) continue;
      let f = 1 - d;
      if (fall === 'smooth') f = smooth(f);
      else if (fall === 'sharp') f = f * f;
      if (steps > 0) f = band(f, steps, dither, x, y);
      const c = ctx.get(x, y);
      if (!c) continue;
      const nc = applyLight(c, col, f * intensity, mode, a.on_empty !== false);
      if (nc) ctx.put(x, y, nc, 'mask');
    }
  },

  /** Gradient haze: alpha ramps from `from` to `to` along a direction; optional wispy noise. */
  fog(ctx, a) {
    const col = ctx.color(a.color ?? '#c8d8e8');
    const { x, y, w, h } = ctx.region(a);
    const from = num(a.from, 'from', 0), to = num(a.to, 'to', 0.6);
    const steps = int(a.steps ?? 6, 'steps'), dither = a.dither !== false;
    const dir = a.direction || 'vertical';
    const noise = num(a.noise, 'noise', 0), nscale = Math.max(1, num(a.noise_scale, 'noise_scale', 12));
    const seed = int(a.seed ?? 1, 'seed');
    const mode = a.mode || 'paint';
    for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) {
      const u = w > 1 ? xx / (w - 1) : 0, v = h > 1 ? yy / (h - 1) : 0;
      let t = dir === 'horizontal' ? u : dir === 'up' ? 1 - v : dir === 'radial' ? Math.min(1, Math.hypot(u - 0.5, v - 0.5) * 2) : v;
      let al = from + (to - from) * t;
      if (noise > 0) al *= 1 - noise + noise * 2 * valueNoise2((x + xx) / nscale, (y + yy) / (nscale * 0.5), seed);
      al = Math.max(0, Math.min(1, al));
      if (steps > 0) al = band(al, steps, dither, x + xx, y + yy);
      const c = ctx.get(x + xx, y + yy);
      if (!c) continue;
      const nc = applyLight(c, col, al, mode, a.on_empty !== false);
      if (nc) ctx.put(x + xx, y + yy, nc, 'mask');
    }
  },

  /** God rays / light shafts fanning out from an origin. Best on a layer with blend screen/add. */
  rays(ctx, a) {
    const col = ctx.color(a.color ?? '#fff1c0');
    const ox = num(a.x, 'x', 0), oy = num(a.y, 'y', 0);
    const angle = (num(a.angle, 'angle', 70) * Math.PI) / 180;
    const spread = (num(a.spread, 'spread', 40) * Math.PI) / 180;
    const count = Math.max(1, int(a.count ?? 5, 'count'));
    const width = (num(a.width, 'width', 5) * Math.PI) / 180;
    const length = num(a.length, 'length', Math.hypot(ctx.w, ctx.h));
    const alpha = num(a.alpha, 'alpha', 0.35);
    const steps = int(a.steps ?? 4, 'steps'), dither = a.dither !== false;
    const rnd = mulberry32(int(a.seed ?? 1, 'seed'));
    const beams = [];
    for (let k = 0; k < count; k++) {
      const c = angle - spread / 2 + (spread * (k + 0.5)) / count + (rnd() - 0.5) * (spread / count) * 0.6;
      beams.push({ c, hw: (width / 2) * (0.5 + rnd()), s: 0.6 + rnd() * 0.4 });
    }
    const reg = regionOf(ctx, a);
    for (let y = reg.y; y < reg.y + reg.h; y++) for (let x = reg.x; x < reg.x + reg.w; x++) {
      const dx = x + 0.5 - ox, dy = y + 0.5 - oy;
      const dist = Math.hypot(dx, dy);
      if (dist > length || dist < 0.5) continue;
      const ang = Math.atan2(dy, dx);
      let prof = 0;
      for (const b of beams) {
        let d = Math.abs(((ang - b.c + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
        if (d < b.hw) prof = Math.max(prof, (1 - d / b.hw) * b.s);
      }
      if (!prof) continue;
      const fade = (1 - dist / length) * Math.min(1, dist / (length * 0.08));
      let s = prof * fade;
      if (steps > 0) s = band(s, steps, dither, x, y);
      const c = ctx.get(x, y);
      if (!c) continue;
      const nc = applyLight(c, col, s * alpha, a.mode || 'paint', a.on_empty !== false);
      if (nc) ctx.put(x, y, nc, 'mask');
    }
  },

  /** Bloom: bright pixels bleed light around them. */
  glow(ctx, a) {
    const { x, y, w, h } = ctx.region(a);
    const thr = num(a.threshold, 'threshold', 0.75);
    const r = Math.max(1, int(a.radius ?? 2, 'radius'));
    const intensity = num(a.intensity, 'intensity', 0.7);
    const tint = a.color !== undefined ? ctx.color(a.color) : null;
    const buf = new Float32Array(w * h * 3);
    for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) {
      const c = ctx.get(x + xx, y + yy);
      if (!c || !c[3]) continue;
      const l = lum(c);
      if (l <= thr) continue;
      const k = ((l - thr) / Math.max(0.001, 1 - thr)) * (c[3] / 255);
      const src = tint || c;
      buf.set([src[0] * k, src[1] * k, src[2] * k], (yy * w + xx) * 3);
    }
    const wrap = !!a.wrap; // seamless bloom for tiling textures
    let bl = boxBlur(buf, w, h, r, 3, wrap);
    bl = boxBlur(bl, w, h, Math.max(1, r >> 1), 3, wrap);
    const steps = int(a.steps ?? 0, 'steps');
    // small emitters (1-2 px) lose most of their energy in the blur: gain multiplies the halo,
    // normalize scales it so the brightest halo pixel reaches full intensity
    let gain = num(a.gain, 'gain', 1);
    if (a.normalize) {
      let peak = 0;
      for (let i = 0; i < bl.length; i++) peak = Math.max(peak, bl[i]);
      if (peak > 0) gain *= 255 / peak;
    }
    const cutoff = num(a.cutoff, 'cutoff', 0.01);
    for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) {
      const i = (yy * w + xx) * 3;
      let g = [bl[i] * intensity * gain, bl[i + 1] * intensity * gain, bl[i + 2] * intensity * gain];
      let m = Math.max(...g) / 255;
      if (m < cutoff) continue;
      if (steps > 0) {
        const q = band(Math.min(1, m), steps, true, x + xx, y + yy);
        g = g.map((v) => (m ? (v * q) / m : 0));
        m = q;
        if (!m) continue;
      }
      const c = ctx.get(x + xx, y + yy);
      if (!c) continue;
      let nc;
      if (c[3] === 0) {
        if (a.on_empty === false) continue;
        nc = [clamp(g[0] / m), clamp(g[1] / m), clamp(g[2] / m), clamp(Math.min(1, m) * 255)];
      } else nc = [clamp(c[0] + g[0]), clamp(c[1] + g[1]), clamp(c[2] + g[2]), c[3]];
      ctx.put(x + xx, y + yy, nc, 'mask');
    }
  },

  /** Box blur (two passes ~ gaussian). For depth-of-field on background/foreground layers. */
  blur(ctx, a) {
    const { x, y, w, h } = ctx.region(a);
    const r = Math.max(1, int(a.radius ?? 1, 'radius'));
    const buf = new Float32Array(w * h * 4);
    for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) {
      const c = ctx.get(x + xx, y + yy) || [0, 0, 0, 0];
      const al = c[3] / 255;
      buf.set([c[0] * al, c[1] * al, c[2] * al, c[3]], (yy * w + xx) * 4); // premultiplied
    }
    let bl = boxBlur(buf, w, h, r);
    if (a.passes !== 1) bl = boxBlur(bl, w, h, Math.max(1, Math.round(r / 2)));
    for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) {
      const i = (yy * w + xx) * 4;
      const al = bl[i + 3];
      const nc = al < 1 ? [0, 0, 0, 0] : [clamp((bl[i] * 255) / al), clamp((bl[i + 1] * 255) / al), clamp((bl[i + 2] * 255) / al), clamp(al)];
      ctx.put(x + xx, y + yy, nc, 'mask');
    }
  },

  /** Darken (or tint) towards the edges. */
  vignette(ctx, a) {
    const col = ctx.color(a.color ?? '#000000');
    const { x, y, w, h } = ctx.region(a);
    const strength = num(a.strength, 'strength', 0.6), radius = num(a.radius, 'radius', 0.6);
    const steps = int(a.steps ?? 5, 'steps'), dither = a.dither !== false;
    for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) {
      const u = (xx + 0.5) / w - 0.5, v = (yy + 0.5) / h - 0.5;
      const d = Math.hypot(u, v) / 0.7071;
      if (d <= radius) continue;
      let s = smooth(Math.min(1, (d - radius) / Math.max(0.01, 1 - radius))) * strength;
      if (steps > 0) s = band(s, steps, dither, x + xx, y + yy);
      const c = ctx.get(x + xx, y + yy);
      if (!c) continue;
      const nc = applyLight(c, col, s, a.mode || 'paint', a.on_empty !== false);
      if (nc) ctx.put(x + xx, y + yy, nc, 'mask');
    }
  },

  /** Snap pixels to a palette (canvas + project palette by default), optionally with ordered dithering. */
  quantize(ctx, a) {
    let list = a.colors;
    if (!list) list = Object.keys(ctx.pal);
    const pal = list.map((c) => ctx.color(c)).filter((c) => c[3] > 0);
    if (!pal.length) throw new Error('quantize needs "colors" or a non-empty palette');
    const { x, y, w, h } = ctx.region(a);
    const dither = a.dither || 'none';
    const spread = num(a.spread, 'spread', 40) * num(a.strength, 'strength', 1);
    const alphaCut = a.alpha_threshold !== undefined ? num(a.alpha_threshold, 'alpha_threshold') * 255 : null;
    const cache = new Map();
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) {
      const c = ctx.get(xx, yy);
      if (!c || !c[3]) continue;
      const off = dither === 'bayer' ? (bayer(xx, yy) - 0.5) * spread : 0;
      const r = c[0] + off, g = c[1] + off, b = c[2] + off;
      const key = ((clamp(r) >> 2) << 12) | ((clamp(g) >> 2) << 6) | (clamp(b) >> 2);
      let best = cache.get(key);
      if (!best) {
        let bd = Infinity;
        for (const p of pal) {
          const rm = (r + p[0]) / 2;
          const d = (2 + rm / 256) * (r - p[0]) ** 2 + 4 * (g - p[1]) ** 2 + (2 + (255 - rm) / 256) * (b - p[2]) ** 2;
          if (d < bd) { bd = d; best = p; }
        }
        cache.set(key, best);
      }
      let al = c[3];
      if (alphaCut !== null) al = al >= alphaCut ? 255 : 0;
      ctx.put(xx, yy, [best[0], best[1], best[2], al], 'mask');
    }
  },

  /** Cast a shadow of a layer's shapes (offset / squashed / skewed) onto the target layer. */
  cast_shadow(ctx, a) {
    const col = ctx.color(a.color ?? '#00000060');
    const srcIdx = a.from_layer !== undefined ? ctx.doc.layerIndex(a.from_layer) : ctx.layerIdx;
    const src = ctx.doc.layers[srcIdx].data;
    const dx = num(a.dx, 'dx', 2), dy = num(a.dy, 'dy', 1);
    const squash = num(a.squash, 'squash', 1), skew = num(a.skew, 'skew', 0);
    // base_y defaults to the lowest painted row (where the object touches the ground)
    let base = a.base_y;
    if (base === undefined) {
      base = 0;
      for (let y = 0; y < ctx.h; y++) for (let x = 0; x < ctx.w; x++) if (src[((y + ctx.oy) * ctx.W + x) * 4 + 3]) base = y;
    }
    // rasterize the projected silhouette into a coverage mask
    const W = ctx.w, H = ctx.h;
    const cov = new Float32Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      if (!src[((y + ctx.oy) * ctx.W + x) * 4 + 3]) continue;
      const tx = Math.round(x + dx + skew * (base - y)), ty = Math.round(base + (y - base) * squash + dy);
      if (tx >= 0 && ty >= 0 && tx < W && ty < H) cov[ty * W + tx] = 1;
    }
    // soft: blur radius in px; the coverage is banded (steps, Bayer dither) so edges stay pixel art
    const soft = Math.max(0, int(a.soft ?? a.blur ?? 0, 'soft'));
    const field = soft ? boxBlur(boxBlur(cov, W, H, soft, 1), W, H, Math.max(1, soft >> 1), 1) : cov;
    const steps = int(a.steps ?? 3, 'steps');
    const blend = ctx.blend;
    ctx.blend = 'over';
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      let s = field[y * W + x];
      if (s <= 0.001) continue;
      if (soft && steps > 0) s = band(Math.min(1, s), steps, a.dither !== false, x, y);
      if (s <= 0) continue;
      ctx.set(x, y, [col[0], col[1], col[2], clamp(col[3] * Math.min(1, s))]);
    }
    ctx.blend = blend;
  },
};

export const EFFECT_NAMES = Object.keys(EFFECTS);
export { parseColor };
