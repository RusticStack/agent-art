// Damage overlay for 2D pixel art (sprite props, character armour plates, helmets): cracks,
// scorch, dents, bullet holes and scratches painted onto the existing pixels with palette
// discipline (every colour written is already in the palette: the region's own colours, or
// palette:[..]). Features are placed in normalised coordinates of the damaged area's bounding
// box from the seed, so the same seed lands them in the same relative spot in every frame /
// view of a rig (mirror:true flips them for mirrored views).
import { mulberry32, BAYER4, int } from './util.js';

const lum = (c) => 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
const key = (c) => (c[0] << 16) | (c[1] << 8) | c[2];
/** Darker / lighter neighbour of a colour inside the palette (same hue family first). */
function ramp(pal) {
  const chroma = (c) => { const l = lum(c); return [c[0] - l, c[1] - l, c[2] - l]; };
  const memo = new Map();
  const step = (c, dir) => {
    const k = `${key(c)}${dir}`;
    if (memo.has(k)) return memo.get(k);
    const l = lum(c), ch = chroma(c);
    let best = null, bs = Infinity;
    for (const p of pal) {
      const dl = (lum(p) - l) * dir;
      if (dl < 6) continue;
      const pc = chroma(p), dh = Math.hypot(pc[0] - ch[0], pc[1] - ch[1], pc[2] - ch[2]);
      const s = dl * 0.55 + dh * 1.2;
      if (s < bs) { bs = s; best = p; }
    }
    memo.set(k, best);
    return best;
  };
  const darkest = pal.reduce((d, p) => (!d || lum(p) < lum(d) ? p : d), null);
  return { darker: (c, n = 1) => { let x = c; for (let i = 0; i < n; i++) x = step(x, -1) || x; return x; }, lighter: (c, n = 1) => { let x = c; for (let i = 0; i < n; i++) x = step(x, 1) || x; return x; }, darkest };
}

export const DAMAGE_SPRITE = {
  /** Damage overlay on the current layer (see file header). */
  damage(ctx, a) {
    const amount = Math.max(0, Math.min(1, Number(a.amount ?? 0.5)));
    if (!Number.isFinite(amount)) throw new Error('amount must be 0..1');
    const seed = int(a.seed ?? 1, 'seed');
    const KINDS = ['scratches', 'dents', 'holes', 'cracks', 'scorch'];
    const kinds = a.kinds ? [].concat(a.kinds) : KINDS.filter((k, i) => amount >= [0, 0.15, 0.35, 0.4, 0.55][i]);
    for (const k of kinds) if (!KINDS.includes(k)) throw new Error(`kinds: unknown "${k}" (${KINDS.join(', ')})`);
    const { x, y, w, h } = ctx.region(a);
    const on = a.on ? [].concat(a.on).map((c) => ctx.color(c)) : null;
    const isOn = (c) => c && c[3] > 0 && (!on || on.some((o) => o[0] === c[0] && o[1] === c[1] && o[2] === c[2]));
    // damaged area + its bounding box
    let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity, area = 0;
    const seen = new Map();
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) {
      const c = ctx.get(xx, yy);
      if (c && c[3] > 0) seen.set(key(c), c);
      if (!isOn(c)) continue;
      area++; bx0 = Math.min(bx0, xx); by0 = Math.min(by0, yy); bx1 = Math.max(bx1, xx); by1 = Math.max(by1, yy);
    }
    if (!area || !amount) return 'damage: nothing to damage (no matching pixels or amount 0)';
    const pal = a.palette ? [].concat(a.palette).map((c) => ctx.color(c)).map((c) => [c[0], c[1], c[2], 255]) : [...seen.values()].map((c) => [c[0], c[1], c[2], 255]);
    const R = ramp(pal);
    const inPal = new Set(pal.map(key));
    const bw = bx1 - bx0 + 1, bh = by1 - by0 + 1, mirror = !!a.mirror;
    const X = (u) => bx0 + Math.round((mirror ? 1 - u : u) * (bw - 1)), Y = (v) => by0 + Math.round(v * (bh - 1));
    const counts = {};
    const put = (xx, yy, fn) => {
      const c = ctx.get(xx, yy);
      if (!isOn(c)) return false;
      const n = fn(c);
      if (!n || !inPal.has(key(n)) || (n[0] === c[0] && n[1] === c[1] && n[2] === c[2])) return false;
      ctx.set(xx, yy, [n[0], n[1], n[2], c[3]]);
      return true;
    };
    const rng = (k) => mulberry32(seed * 7919 + KINDS.indexOf(k) * 104729 + 1);
    const n = (per, min) => Math.max(min, Math.round((amount * area) / per));
    if (kinds.includes('scorch')) {
      const r = rng('scorch'); let c = 0;
      for (let i = 0, N = n(380, 1); i < N; i++) {
        const cx = X(r()), cy = Y(r()), rad = 1.5 + r() * (2 + 3 * amount) * Math.sqrt(bw * bh) / 24;
        for (let yy = Math.floor(cy - rad); yy <= cy + rad; yy++) for (let xx = Math.floor(cx - rad); xx <= cx + rad; xx++) {
          const d = Math.hypot(xx - cx, (yy - cy) * 1.2) / rad;
          if (d > 1) continue;
          const th = (BAYER4[yy & 3][xx & 3] + 0.5) / 16, lv = (1 - d) * 2.2 + (th - 0.5) * 0.8;
          if (lv > 0.6) put(xx, yy, (col) => R.darker(col, lv > 1.5 ? 2 : 1));
        }
        c++;
      }
      counts.scorch = c;
    }
    if (kinds.includes('dents')) {
      const r = rng('dents'); let c = 0;
      for (let i = 0, N = n(150, 1); i < N; i++) {
        const cx = X(r()), cy = Y(r()), rad = 1 + Math.round(r() * (1 + amount * 1.5));
        for (let yy = cy - rad - 1; yy <= cy + rad + 1; yy++) for (let xx = cx - rad - 1; xx <= cx + rad + 1; xx++) {
          const d = Math.hypot(xx - cx, yy - cy);
          if (d > rad + 0.5) continue;
          // concave: shadow on the upper-left inner rim, highlight on the lower-right rim (light from top-left)
          const s = (xx - cx) + (yy - cy);
          if (d > rad - 0.8 && s > 0) put(xx, yy, (col) => R.lighter(col));
          else if (s <= 0) put(xx, yy, (col) => R.darker(col));
        }
        c++;
      }
      counts.dents = c;
    }
    if (kinds.includes('scratches')) {
      const r = rng('scratches'); let c = 0;
      for (let i = 0, N = n(70, 1); i < N; i++) {
        let px = X(r()), py = Y(r());
        const dx = r() < 0.5 ? 1 : -1, dy = r() < 0.7 ? 1 : 0, L = 2 + Math.floor(r() * (2 + 3 * amount));
        for (let k = 0; k < L; k++) { put(px, py, (col) => R.lighter(col)); px += mirror ? -dx : dx; if (k % 2 === 0) py += dy; }
        c++;
      }
      counts.scratches = c;
    }
    if (kinds.includes('cracks')) {
      const r = rng('cracks'); let c = 0;
      for (let i = 0, N = n(320, amount > 0.5 ? 1 : 0); i < N; i++) {
        const walk = (sx, sy, steps, dir) => {
          let px = sx, py = sy, d = dir;
          for (let k = 0; k < steps; k++) {
            put(px, py, () => R.darkest);
            if (r() < 0.25) put(px + 1, py, (col) => R.lighter(col));
            if (r() < 0.35) d += r() < 0.5 ? 1 : -1;
            const m = ((d % 8) + 8) % 8, D = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]][m];
            px += mirror ? -D[0] : D[0]; py += D[1];
            if (r() < 0.12 && steps - k > 3) walk(px, py, Math.floor((steps - k) / 2), d + (r() < 0.5 ? 2 : -2));
          }
        };
        walk(X(r()), Y(r()), 4 + Math.floor(r() * (3 + 8 * amount)), Math.floor(r() * 8));
        c++;
      }
      counts.cracks = c;
    }
    if (kinds.includes('holes')) {
      const r = rng('holes'); let c = 0;
      for (let i = 0, N = n(230, 1); i < N; i++) {
        const cx = X(r()), cy = Y(r()), big = r() < amount * 0.5;
        const ring = big ? [[-1, -1], [0, -1], [1, -1], [-1, 0], [2, 0], [-1, 1], [2, 1], [0, 2], [1, 2]] : [[-1, 0], [1, 0], [0, -1], [0, 1]];
        for (const [dx, dy] of ring) put(cx + dx, cy + dy, (col) => R.darker(col));
        for (const [dx, dy] of big ? [[0, 0], [1, 0], [0, 1], [1, 1]] : [[0, 0]]) put(cx + dx, cy + dy, () => R.darkest);
        c++;
      }
      counts.holes = c;
    }
    return `damage ${amount}: ${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ')} on ${area} px (palette ${pal.length} colours)`;
  },
};
