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

/** Default kinds by amount: [kind, from amount]. */
const KIND_AT = [['scratches', 0], ['chips', 0], ['dents', 0.15], ['holes', 0.2], ['cracks', 0.3], ['under', 0.45], ['scorch', 0.5]];
const KINDS = KIND_AT.map(([k]) => k);

export const DAMAGE_SPRITE = {
  /** Damage overlay on the current layer (see file header). */
  damage(ctx, a) {
    const amount = Math.max(0, Math.min(1, Number(a.amount ?? 0.5)));
    if (!Number.isFinite(amount)) throw new Error('amount must be 0..1');
    const seed = int(a.seed ?? 1, 'seed');
    const kinds = a.kinds ? [].concat(a.kinds) : KIND_AT.filter(([, at]) => amount >= at).map(([k]) => k);
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
    // feature scale: 1 on small sprites (boxes up to ~40 px), up to 4 on big ones, so damage reads at any size
    const S = Math.max(1, Math.min(4, Math.sqrt(bw * bh) / 40));
    const X = (u) => bx0 + Math.round((mirror ? 1 - u : u) * (bw - 1)), Y = (v) => by0 + Math.round(v * (bh - 1));
    const dx1 = mirror ? -1 : 1;
    // ordered dither in box space (the same pattern per view, also when the sprite shifts)
    const dith = (xx, yy) => (BAYER4[(yy - by0) & 3][(mirror ? bx1 - xx : xx - bx0) & 3] + 0.5) / 16;
    // under-layer colour: the palette's least saturated colour a bit lighter than the paint (primer /
    // bare metal), or under:<colour> (must be in the palette)
    const underC = a.under ? (() => { const c = ctx.color(a.under); return [c[0], c[1], c[2], 255]; })() : null;
    const umemo = new Map();
    const under = (c) => {
      if (underC) return underC;
      const k = key(c);
      if (umemo.has(k)) return umemo.get(k);
      const l = lum(c);
      let best = null, bs = Infinity;
      for (const p of pal) {
        if (key(p) === k) continue;
        const pl = lum(p), ch = Math.max(p[0], p[1], p[2]) - Math.min(p[0], p[1], p[2]);
        const s = ch * 0.8 + Math.abs(pl - (l + 34)) * 0.6;
        if (s < bs) { bs = s; best = p; }
      }
      umemo.set(k, best);
      return best;
    };
    // outline of the damaged area, before anything is painted (chips sit on it)
    const edge = [];
    if (kinds.includes('chips')) for (let yy = by0; yy <= by1; yy++) for (let xx = bx0; xx <= bx1; xx++) {
      if (!isOn(ctx.get(xx, yy))) continue;
      if (!isOn(ctx.get(xx + 1, yy)) || !isOn(ctx.get(xx - 1, yy)) || !isOn(ctx.get(xx, yy + 1)) || !isOn(ctx.get(xx, yy - 1))) edge.push([xx, yy]);
    }
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
    const N = (per, min) => Math.max(min, Math.round((amount * area) / per));
    const run = (k, fn) => { if (kinds.includes(k)) counts[k] = fn(rng(k)); };
    // blob of radius rad around (cx, cy) with a lobed edge: cb(xx, yy, d 0..1, dx, dy)
    const blob = (r, cx, cy, rad, sy, cb) => {
      const lobes = Array.from({ length: 8 }, () => 0.6 + 0.6 * r());
      for (let yy = Math.floor(cy - rad * 1.2); yy <= cy + rad * 1.2; yy++) for (let xx = Math.floor(cx - rad * 1.2); xx <= cx + rad * 1.2; xx++) {
        const ddx = (xx - cx) * dx1, ddy = (yy - cy) * sy, ang = (Math.atan2(ddy, ddx) / (Math.PI * 2) + 1) % 1, f = ang * 8, i0 = Math.floor(f) % 8;
        const R2 = rad * (lobes[i0] + (lobes[(i0 + 1) % 8] - lobes[i0]) * (f - Math.floor(f)));
        const d = Math.hypot(ddx, ddy) / R2;
        if (d <= 1) cb(xx, yy, d, ddx, ddy);
      }
    };
    // ---- exposed under-layer: paint flaked off in irregular patches, dark paint rim on the upper-left
    run('under', (r) => {
      let c = 0;
      for (let i = 0, n = Math.max(1, Math.round((amount ** 1.5 * area) / 2400)); i < n; i++) {
        const cx = X(0.08 + 0.84 * r()), cy = Y(0.08 + 0.84 * r()), rad = (2 + 3 * r()) * S * (0.55 + 0.6 * amount);
        blob(r, cx, cy, rad, 1.15, (xx, yy, d, ddx, ddy) => {
          if (d > 0.82) { if (ddx + ddy < 0) put(xx, yy, (col) => R.darker(col)); return; }
          put(xx, yy, (col) => under(col));
        });
        c++;
      }
      return c;
    });
    // ---- scorch: soft dithered burn, darkest at the core
    run('scorch', (r) => {
      let c = 0;
      for (let i = 0, n = N(2600, 1); i < n; i++) {
        const cx = X(r()), cy = Y(r()), rad = (2 + 3 * r()) * S * (0.7 + 0.6 * amount);
        blob(r, cx, cy, rad, 1.2, (xx, yy, d) => {
          const lv = (1 - d) * 2.4 + (dith(xx, yy) - 0.5) * 0.9;
          if (lv > 0.55) put(xx, yy, (col) => (lv > 2 ? R.darkest : R.darker(col, lv > 1.3 ? 2 : 1)));
        });
        c++;
      }
      return c;
    });
    // ---- dents: concave dimples (light from the top-left: shadow upper-left inside, lit lower-right rim)
    run('dents', (r) => {
      let c = 0;
      for (let i = 0, n = N(700, 1); i < n; i++) {
        const cx = X(r()), cy = Y(r()), rad = Math.max(1, (1 + r() * 1.5) * S * 0.75);
        for (let yy = Math.floor(cy - rad - 1); yy <= cy + rad + 1; yy++) for (let xx = Math.floor(cx - rad - 1); xx <= cx + rad + 1; xx++) {
          const d = Math.hypot(xx - cx, yy - cy);
          if (d > rad + 0.5) continue;
          const s = (xx - cx) * dx1 + (yy - cy);
          if (d > rad - 0.9 && s > 0) put(xx, yy, (col) => R.lighter(col));
          else if (s <= 0) put(xx, yy, (col) => R.darker(col, d < rad * 0.5 && rad > 2 ? 2 : 1));
        }
        c++;
      }
      return c;
    });
    // ---- scratches: bright gouge with a dark lower lip (on bigger sprites)
    run('scratches', (r) => {
      let c = 0;
      for (let i = 0, n = N(450, 1); i < n; i++) {
        let px = X(r()), py = Y(r());
        const sx = (r() < 0.5 ? 1 : -1) * dx1, slope = r() < 0.65 ? 0.5 : r() < 0.5 ? 1 : 0, L = Math.round((3 + r() * (3 + 6 * amount)) * Math.max(1, S * 0.75));
        let fy = py;
        for (let k = 0; k < L; k++) { put(px, py, (col) => R.lighter(col)); if (S >= 1.5) put(px, py + 1, (col) => R.darker(col)); px += sx; fy += slope; py = Math.round(fy); }
        c++;
      }
      return c;
    });
    // ---- cracks: darkest branching line, lit lower lip
    run('cracks', (r) => {
      let c = 0;
      for (let i = 0, n = N(2400, amount >= 0.3 ? 1 : 0); i < n; i++) {
        const walk = (sx, sy, steps, dir) => {
          let px = sx, py = sy, d = dir;
          for (let k = 0; k < steps; k++) {
            put(px, py, () => R.darkest);
            if (S >= 1.5) put(px + dx1, py + 1, (col) => R.lighter(col));
            if (r() < 0.3) d += r() < 0.5 ? 1 : -1;
            const m = ((d % 8) + 8) % 8, D = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]][m];
            px += D[0] * dx1; py += D[1];
            if (r() < 0.1 && steps - k > 4) walk(px, py, Math.floor((steps - k) * 0.55), d + (r() < 0.5 ? 2 : -2));
          }
        };
        walk(X(0.1 + 0.8 * r()), Y(0.1 + 0.8 * r()), Math.round((5 + r() * (4 + 10 * amount)) * Math.max(1, S * 0.8)), Math.floor(r() * 8));
        c++;
      }
      return c;
    });
    // ---- bullet holes: dark core, darker ring, lit lower-right petal (punched rim)
    run('holes', (r) => {
      let c = 0;
      for (let i = 0, n = N(1100, 1); i < n; i++) {
        const cx = X(0.05 + 0.9 * r()), cy = Y(0.05 + 0.9 * r()), big = r() < 0.25 + amount * 0.4;
        const rc = Math.max(0.5, (big ? 0.75 : 0.4) * S), rr = rc + Math.max(1, 0.5 * S);
        for (let yy = Math.floor(cy - rr - 1); yy <= cy + rr + 1; yy++) for (let xx = Math.floor(cx - rr - 1); xx <= cx + rr + 1; xx++) {
          const ddx = (xx - cx) * dx1, ddy = yy - cy, d = Math.hypot(ddx, ddy);
          if (d <= rc) put(xx, yy, () => R.darkest);
          else if (d <= rr) put(xx, yy, (col) => (ddx + ddy > 0.5 && d > rr - 0.9 ? R.lighter(col) : R.darker(col)));
        }
        c++;
      }
      return c;
    });
    // ---- chipped edges: notches on the outline of the damaged area (dark bite, bright bare edge)
    run('chips', (r) => {
      if (!edge.length) return 0;
      let c = 0;
      const n = Math.max(1, Math.round((amount * edge.length) / 55));
      const cxb = (bx0 + bx1) / 2, cyb = (by0 + by1) / 2;
      for (let i = 0; i < n; i++) {
        // nearest edge pixel to a seeded box point: the same spot in every view
        const tx = X(r()), ty = Y(r());
        let best = edge[0], bd = Infinity;
        for (const p of edge) { const d = (p[0] - tx) ** 2 + (p[1] - ty) ** 2; if (d < bd) { bd = d; best = p; } }
        // a bite into the edge: dark where material is gone, one bright bare-metal pixel row on its inner side
        const rad = Math.max(1, (0.8 + r() * 1.2) * S * (0.5 + 0.5 * amount));
        const ix = Math.sign(cxb - best[0]), iy = Math.sign(cyb - best[1]);
        for (let yy = Math.floor(best[1] - rad - 1); yy <= best[1] + rad + 1; yy++) for (let xx = Math.floor(best[0] - rad - 1); xx <= best[0] + rad + 1; xx++) {
          const d = Math.hypot(xx - best[0], (yy - best[1]) * 1.1);
          if (d <= rad) put(xx, yy, (col) => (d <= rad * 0.55 ? R.darkest : R.darker(col, 2)));
          else if (d <= rad + 1 && (xx - best[0]) * ix + (yy - best[1]) * iy > rad * 0.5) put(xx, yy, (col) => R.lighter(col));
        }
        c++;
      }
      return c;
    });
    return `damage ${amount}: ${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ')} on ${area} px (scale ${S.toFixed(2)}, palette ${pal.length} colours)`;
  },
};
