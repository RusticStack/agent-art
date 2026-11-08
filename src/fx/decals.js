// Decal atlas: bullet holes per surface, scorch marks, blood splats, energy burns. Rows = kinds,
// columns = seeded variants; every cell keeps a transparent 1 px gutter (no bleed with NEAREST or
// mips). Each cell also gets a height field (0.5 = the surface) -> tangent-space normal map, and
// energy burns an emissive map (materials v2: emissive strength from meta).
import { fields, matter, emit, puff, bolt, resolve, matterRamp, heatRamp, normalFromHeight, mulberry32, seedOf, clamp01, hash3, texLimit, lockRamp } from './raster.js';
import { MATTER } from './effects.js';

const TAU = Math.PI * 2;
export const DECAL_KINDS = {
  bullet_metal: { ramp: 'steel', about: 'punched hole, bright stressed petals, scratches' },
  bullet_concrete: { ramp: 'concrete', about: 'chipped crater, dark core' },
  bullet_glass: { ramp: 'glass', about: 'hole + radial and ring cracks' },
  bullet_armor: { ramp: 'steel', about: 'shallow dent with a bright scuff (no penetration)' },
  bullet_electronics: { ramp: 'soot', about: 'hole in a panel, cracked screen lines, scorch' },
  bullet_dirt: { ramp: 'dirt', about: 'soft dark pock' },
  scorch: { ramp: 'soot', about: 'blast scorch, dithered edge' },
  blood: { ramp: 'blood', about: 'splat + droplets (dark, desaturated)' },
  energy_burn: { ramp: 'soot', emissive: true, about: 'melted ring with a glowing core (emissive map)' },
};

function drawDecal(kind, F, h, r, c, o) {
  const W = F.W, cx = W / 2 + (r() - 0.5) * 2, cy = W / 2 + (r() - 0.5) * 2, R = W / 2 - 1.5;
  const H = (x, y, v, mode = 'min') => { x = Math.floor(x); y = Math.floor(y); if (x < 0 || y < 0 || x >= W || y >= W) return; const i = y * W + x; h[i] = mode === 'min' ? Math.min(h[i], v) : mode === 'max' ? Math.max(h[i], v) : v; };
  const each = (rad, fn) => { for (let y = Math.floor(cy - rad); y <= Math.ceil(cy + rad); y++) for (let x = Math.floor(cx - rad); x <= Math.ceil(cx + rad); x++) { const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy); if (d <= rad) fn(x, y, d / rad, Math.atan2(y + 0.5 - cy, x + 0.5 - cx)); } };
  const s = W / 32; // scale relative to the 32 px default cell
  switch (kind) {
    case 'bullet_metal': {
      const hr = (1.4 + r() * 0.8) * s, petals = 5 + Math.floor(r() * 3), pr = hr * 2.4, ph = r() * TAU;
      each(pr, (x, y, d, a) => { const pet = 0.65 + 0.35 * Math.cos(a * petals + ph); if (d * pr < hr) { matter(F, x, y, 2, 0.02); H(x, y, 0.05); } else if (d < pet) { matter(F, x, y, 2, 0.95 - d * 0.5); H(x, y, 0.62 + 0.2 * (1 - d), 'max'); } });
      for (let k = 0; k < 3; k++) { const a = r() * TAU, L = R * (0.4 + r() * 0.5); for (let t = pr * 0.8; t < L; t++) if (hash3(t, k, 7) < 0.8) matter(F, cx + Math.cos(a) * t, cy + Math.sin(a) * t, 1, 0.85); }
      break;
    }
    case 'bullet_concrete': case 'bullet_dirt': {
      const soft = kind === 'bullet_dirt', cr = (soft ? 3 : 3.5 + r() * 2) * s, n = seedOf(o.seed, 7);
      each(cr * 1.6, (x, y, d, a) => { const jag = 0.72 + 0.5 * hash3(Math.floor((a + Math.PI) * 3), 1, n); if (d < jag * 0.62) { const dd = d / (jag * 0.62); matter(F, x, y, 2, 0.05 + dd * 0.45); H(x, y, 0.1 + 0.4 * dd * dd); } else if (!soft && d < jag && hash3(x, y, n) < 0.6) { matter(F, x, y, 2, 0.75); H(x, y, 0.45); } else if (soft && d < jag) { matter(F, x, y, 1.2 - d, 0.3); H(x, y, 0.42); } });
      if (!soft) for (let k = 0; k < 4; k++) { const a = r() * TAU, L = cr * (1.4 + r()); matter(F, cx + Math.cos(a) * L, cy + Math.sin(a) * L, 2, 0.6); }
      break;
    }
    case 'bullet_glass': {
      const hr = 1.3 * s;
      each(hr * 2, (x, y, d) => { if (d < 0.5) { matter(F, x, y, 2, 0.05); H(x, y, 0.2); } else { matter(F, x, y, 2, 1); H(x, y, 0.55, 'max'); } });
      const rays = 6 + Math.floor(r() * 4);
      for (let k = 0; k < rays; k++) { const a = (k / rays) * TAU + (r() - 0.5) * 0.5, L = R * (0.55 + r() * 0.45), pts = bolt(r, cx, cy, cx + Math.cos(a) * L, cy + Math.sin(a) * L, { iters: 3, jitter: 0.25 }); for (let i = 1; i < pts.length; i++) { const [x0, y0] = pts[i - 1], [x1, y1] = pts[i], n = Math.ceil(Math.hypot(x1 - x0, y1 - y0)); for (let j = 0; j <= n; j++) { const x = x0 + ((x1 - x0) * j) / (n || 1), y = y0 + ((y1 - y0) * j) / (n || 1); matter(F, x, y, 2, 0.85); H(x, y, 0.45); } } }
      const rr = R * (0.35 + r() * 0.2);
      for (let k = 0; k < 40; k++) { const a = (k / 40) * TAU; if (hash3(k, 3, o.seed | 0) < 0.7) { matter(F, cx + Math.cos(a) * rr, cy + Math.sin(a) * rr, 2, 0.7); H(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr, 0.46); } }
      break;
    }
    case 'bullet_armor': {
      const dr = (3 + r() * 1.5) * s, ang = r() * TAU;
      each(dr * 1.5, (x, y, d, a) => { const sx = Math.cos(a - ang) * d * 1.5 * dr, inside = d < 1 / 1.5 + 0.2 * Math.cos(a - ang); if (inside) { matter(F, x, y, 2, 0.35 + 0.6 * clamp01(0.5 - sx / (dr * 2))); H(x, y, 0.5 - 0.25 * (1 - d * 1.5) ** 2); } else if (d < 1 && hash3(x, y, 9) < 0.35) matter(F, x, y, 2, 0.95); });
      break;
    }
    case 'bullet_electronics': {
      const hr = 1.6 * s;
      each(R * 0.55, (x, y, d) => { if (d * R * 0.55 < hr) { matter(F, x, y, 2, 0.05); H(x, y, 0.1); } else if (hash3(x, y, 13) < (1 - d) * 0.9) matter(F, x, y, 1.6 * (1 - d) + 0.2, 0.25); });
      for (let k = 0; k < 4; k++) { const a = r() * TAU, pts = bolt(r, cx, cy, cx + Math.cos(a) * R * 0.9, cy + Math.sin(a) * R * 0.9, { iters: 2, jitter: 0.15 }); for (let i = 1; i < pts.length; i++) { const [x0, y0] = pts[i - 1], [x1, y1] = pts[i], n = Math.ceil(Math.hypot(x1 - x0, y1 - y0)); for (let j = 0; j <= n; j++) matter(F, x0 + ((x1 - x0) * j) / (n || 1), y0 + ((y1 - y0) * j) / (n || 1), 2, 0.75); } }
      break;
    }
    case 'scorch': {
      const n = seedOf(o.seed, 17 + Math.floor(r() * 1e6));
      each(R, (x, y, d, a) => { const nn = hash3(x >> 1, y >> 1, n) * 0.35 + hash3(Math.floor((a + 4) * 4), 0, n) * 0.25, v = 1 - d - nn * 0.6 + 0.25; if (v > 0) { matter(F, x, y, v * 2.2, clamp01(0.15 + d * 0.6 - nn * 0.3)); H(x, y, 0.5 - 0.05 * v); } });
      break;
    }
    case 'blood': {
      const br = R * (0.35 + r() * 0.15);
      puff(F, cx, cy, br, 2.4, { lift: 0.1 });
      for (let k = 0; k < 4; k++) { const a = r() * TAU, d = br * (0.6 + r() * 0.5); puff(F, cx + Math.cos(a) * d, cy + Math.sin(a) * d, br * (0.35 + r() * 0.3), 2.2); }
      for (let k = 0; k < 10; k++) { const a = r() * TAU, d = br + r() * (R - br), sz = r() < 0.3 ? 1.6 : 0.8; puff(F, cx + Math.cos(a) * d, cy + Math.sin(a) * d, sz, 2.2); }
      for (let i = 0; i < W * W; i++) if (F.D[i] > 0.12) h[i] = 0.53;
      break;
    }
    case 'energy_burn': {
      const er = R * (0.85 + r() * 0.15), cr = er * 0.32;
      each(er, (x, y, d) => { const n = hash3(x, y, 31); if (d * er < cr) { H(x, y, 0.38 + 0.1 * (d * er / cr)); matter(F, x, y, 2, 0.6); emit(F, x, y, 1.3 - (d * er) / cr * 0.6); } else if (d < 0.62) { H(x, y, 0.58, 'max'); matter(F, x, y, 2, 0.35 + 0.2 * n); if (n < 0.25) emit(F, x, y, 0.45); } else if (n < (1 - d) * 2.4) { matter(F, x, y, 1.4 * (1 - d) + 0.15, 0.15); } });
      break;
    }
  }
}

/**
 * Build the decal atlas. kinds: list (default all), variants per kind, cell px (power of two).
 * -> {width, height, albedo, normal, height16?, height8, emissive|null, cells:{<kind>:[[x,y,w,h]...]}, palette}
 */
export function decalAtlas({ kinds = Object.keys(DECAL_KINDS), variants = 4, cell = 32, seed = 1, palette = null, hue = 0, relief = 2.5 } = {}) {
  for (const k of kinds) if (!DECAL_KINDS[k]) throw new Error(`decal kinds: ${Object.keys(DECAL_KINDS).join(', ')} (got "${k}")`);
  if (!(cell >= 8 && cell <= 128 && (cell & (cell - 1)) === 0)) throw new Error('decal cell must be a power of two 8..128');
  const Wd = cell * variants, Hd = cell * kinds.length;
  texLimit(Wd, Hd, 'decal atlas');
  const albedo = new Uint8ClampedArray(Wd * Hd * 4), normal = new Uint8ClampedArray(Wd * Hd * 4), height = new Uint8ClampedArray(Wd * Hd * 4), emis = new Uint8ClampedArray(Wd * Hd * 4);
  const cells = {}, glowRamp = lockRamp(heatRamp(22 + hue, { steps: 5 }), palette);
  let anyEmis = false;
  kinds.forEach((kind, row) => {
    const K = DECAL_KINDS[kind], ramp = lockRamp(matterRamp(MATTER[K.ramp], { steps: 4, spread: 0.6 }), palette);
    cells[kind] = [];
    for (let v = 0; v < variants; v++) {
      const F = fields(cell, cell), h = new Float32Array(cell * cell).fill(0.5), r = mulberry32(seedOf(seed, 1000 + row * 64 + v));
      drawDecal(kind, F, h, r, cell, { seed: seedOf(seed, row * 64 + v) });
      // 1 px transparent gutter
      for (let i = 0; i < cell; i++) for (const [x, y] of [[i, 0], [i, cell - 1], [0, i], [cell - 1, i]]) { const j = y * cell + x; F.D[j] = 0; F.E[j] = 0; h[j] = 0.5; }
      const em = F.E.slice(); F.E.fill(0);
      const a = resolve(F, { E: [ramp], M: [ramp] }, { blend: 'alpha', mcut: 0.3 }), n = normalFromHeight(h, cell, cell, relief);
      let e = null;
      if (K.emissive) { const G = fields(cell, cell); G.E.set(em); e = resolve(G, { E: [glowRamp], M: [ramp] }, { blend: 'additive', cut: 0.2 }); anyEmis = true; }
      const ox = v * cell, oy = row * cell;
      for (let y = 0; y < cell; y++) for (let x = 0; x < cell; x++) {
        const s = (y * cell + x) * 4, d = ((oy + y) * Wd + ox + x) * 4, hv = Math.round(clamp01(h[y * cell + x]) * 255);
        albedo.set(a.subarray(s, s + 4), d); normal.set(n.subarray(s, s + 4), d);
        height[d] = height[d + 1] = height[d + 2] = hv; height[d + 3] = 255;
        if (e) { emis.set(e.subarray(s, s + 4), d); if (!e[s + 3]) emis[d + 3] = 255; } else emis[d + 3] = 255;
      }
      cells[kind].push([ox, oy, cell, cell]);
    }
  });
  return { width: Wd, height: Hd, albedo, normal, heightmap: height, emissive: anyEmis ? emis : null, cells };
}
