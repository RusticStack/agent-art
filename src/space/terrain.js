// Ground terrain that matches its planet: a landing-zone patch sampled from the planet field at
// (lat, lon) in a local tangent frame (+X east, +Z south, +Y up, metres).
//   relief     planet elevation + ground detail + ridged-multifractal mountain ranges (rising away
//              from the pad), desert dunes, mesas / escarpments, a flattened landing pad; then a
//              thermal (scree) + droplet hydraulic (gullies) erosion pass on the grid
//   ground     per-biome pixel tilesets authored with Agent Art ops (4 variants each + edge tiles),
//              blended per texel through a noise-perturbed splat lookup with dithered, noise-masked
//              organic borders (1 px rims); steep faces get layered strata bands
//   outputs    chunks (LODs, skirts, collision), 32 px/m detail patches around the pad, a horizon
//              ring out to the far mountains, clustered instanced props, anchors, fog parameters
// Heights at the patch come from the same heightAt() as the orbit maps (see test: height match).
import { mulberry32, bayer } from '../util.js';
import { perlin3, fractal, seedOf, vnorm, vcross, equirectDir, smoothstep, clamp01, shiftColor, texLimit, r4, hexRGB, toHex, lerp } from './noise.js';
import { elevKm, field, biomeOf } from './planet.js';
import { authorTile, edgeMask, edgeTile, tileMip, tileFbm } from './tiles.js';

const D2R = Math.PI / 180;
/** Unit direction for latitude / longitude (deg), equirect convention of the planet maps. */
export const latLonDir = (lat, lon) => equirectDir(lon / 360 + 0.5, lat / 180 + 0.5);

/** Local frame at a direction: up, east (+X), north (-Z). */
export function localFrame(d) {
  const lat = Math.asin(d[1]), lon = Math.atan2(d[2], d[0]);
  // d/dlat = (-sin lat cos lon, cos lat, -sin lat sin lon). East = north x up, so (east, up, south)
  // is right-handed and the patch places rigidly onto the planet mesh (d/dlon would mirror it: the
  // equirectUv longitude runs clockwise seen from the north pole).
  const north = vnorm([-Math.sin(lat) * Math.cos(lon), Math.cos(lat), -Math.sin(lat) * Math.sin(lon)]);
  return { up: d, east: vnorm(vcross(north, d)), north };
}

// ---------- materials per preset ----------
const MATS = {
  desert: { ground: 'ripples', rock: 'plates', low: 'mud', scree: 'gravel', dunes: true, mountains: 240 },
  ice: { ground: 'snow', rock: 'plates', low: 'ice', scree: 'gravel', dunes: false, mountains: 300 },
  toxic: { ground: 'toxic', rock: 'plates', low: 'mud', scree: 'gravel', dunes: false, mountains: 220 },
  bloom: { ground: 'moss', rock: 'plates', low: 'mud', scree: 'gravel', dunes: false, mountains: 280 },
  lava: { ground: 'plates', rock: 'plates', low: 'glow', scree: 'gravel', dunes: false, mountains: 260 },
  barren: { ground: 'regolith', rock: 'plates', low: 'regolith', scree: 'gravel', dunes: false, mountains: 200 },
};
export const LAYERS = ['ground', 'rock', 'low', 'scree'];

/** Layer specs (splat RGBA = ground, rock, low, scree): recipe kind + ramp (planet biome palette). */
function layerSpec(P, centre) {
  const b = biomeOf(P, centre), water = P.biomes.find((x) => x.where.water) || null;
  const find = (...names) => P.biomes.find((x) => names.includes(x.name));
  const dark = (r) => r.map((c) => shiftColor(c, 0, 0.9, 0.72));
  const M = MATS[P.preset] || MATS.barren;
  const rock = find('mesa', 'highland', 'peaks', 'ash', 'basalt');
  const ground = b.where.water ? (find('regolith', 'rust', 'forest', 'pack', 'basalt', 'highland') || b) : b;
  const rockRamp = rock && rock !== ground ? rock.ramp : dark(ground.ramp);
  const mixR = (r, k) => r.map((c, i) => { const g = ground.ramp[Math.min(ground.ramp.length - 1, i)]; return c.map((v, j) => Math.round(lerp(v, g[j], k))); });
  const lowRamp0 = P.preset === 'lava' ? find('basalt').ramp : water && P.preset !== 'toxic' ? water.ramp : P.preset === 'toxic' ? [[90, 58, 36], [160, 128, 96], [184, 154, 120], [208, 180, 144]] : dark(ground.ramp);
  const lowRamp = P.preset === 'desert' ? mixR(lowRamp0, 0.45) : lowRamp0; // dry lake beds tinted by the ground, not paper white
  const accent = P.preset === 'toxic' ? (water ? water.ramp[water.ramp.length - 2] : [196, 216, 43]) : P.preset === 'lava' ? [255, 122, 26] : null;
  return [
    { name: 'ground', kind: M.ground, ramp: ground.ramp, accent },
    { name: 'rock', kind: M.rock, ramp: rockRamp },
    { name: 'low', kind: M.low, ramp: lowRamp, accent },
    { name: 'scree', kind: M.scree, ramp: ground.ramp.map((c, i) => { const r = rockRamp[Math.min(rockRamp.length - 1, i)]; return c.map((v, j) => Math.round(lerp(v, r[j], 0.45) * 0.9)); }) },
  ];
}

const PROP_DEFAULTS = {
  desert: { rocks: 260, debris: 1400, shrubs: 240, crystals: 0, spires: 5, arches: 1, mesas: 2, cliffs: 1 },
  ice: { rocks: 200, debris: 900, shrubs: 0, crystals: 90, spires: 4, arches: 0, mesas: 1, cliffs: 1 },
  toxic: { rocks: 220, debris: 1000, shrubs: 60, crystals: 110, spires: 6, arches: 1, mesas: 2, cliffs: 0 },
  bloom: { rocks: 160, debris: 700, shrubs: 420, crystals: 0, spires: 3, arches: 0, mesas: 1, cliffs: 0 },
  lava: { rocks: 280, debris: 1400, shrubs: 0, crystals: 60, spires: 6, arches: 0, mesas: 1, cliffs: 1 },
  barren: { rocks: 300, debris: 1600, shrubs: 0, crystals: 0, spires: 3, arches: 0, mesas: 1, cliffs: 0 },
};

/**
 * Normalise terrain options. o: {lat, lon (deg), size m (512), grid (cells, 256), chunks (4),
 * lods ([1, 2, 4, 8] vertex steps), chunk_px (512), tile_px (64) per tile_m (2), detail {amplitude,
 * wavelength, octaves}, mountains {height, wavelength} | false, dunes {height, wavelength} | false,
 * erosion {droplets, thermal} | false, pad {radius}, detail_patches (n x n of 32 m at 32 px/m),
 * horizon {radius, rings, segments} | false, mesas, cliffs, arches, rocks, debris, shrubs, crystals,
 * spires (counts or false), seed, skirt m}
 */
export function normTerrain(P, o = {}) {
  if (P.gas) throw new Error('terrain: a gas giant has no ground (use a rocky or icy planet / moon)');
  const def = PROP_DEFAULTS[P.preset] || PROP_DEFAULTS.barren, M = MATS[P.preset] || MATS.barren;
  const t = {
    lat: Number(o.lat ?? 12), lon: Number(o.lon ?? 30), size: Number(o.size ?? 512), grid: Math.round(Number(o.grid ?? 256)), chunks: Math.round(Number(o.chunks ?? 4)),
    lods: o.lods ?? [1, 2, 4, 8], chunk_px: Math.round(Number(o.chunk_px ?? 1024)), tile_px: Math.round(Number(o.tile_px ?? 64)), tile_m: Number(o.tile_m ?? 2), seed: o.seed ?? P.seed,
    detail: { amplitude: 9, wavelength: 220, octaves: 5, ...(o.detail || {}) }, skirt: Number(o.skirt ?? 4),
    mountains: o.mountains === false ? null : { height: M.mountains, wavelength: 1400, ...(o.mountains || {}) },
    dunes: o.dunes === false || (!M.dunes && !o.dunes) ? null : { height: 5, wavelength: 46, ...(o.dunes || {}) },
    erosion: o.erosion === false ? null : { droplets: null, thermal: 30, talus: 0.7, ...(o.erosion || {}) },
    pad: { radius: 40, ...(o.pad || {}) }, detail_patches: Math.round(Number(o.detail_patches ?? 3)), detail_px_per_m: 32,
    horizon: o.horizon === false ? null : { radius: 6000, rings: 30, segments: 128, ...(o.horizon || {}) },
  };
  for (const k of ['mesas', 'cliffs', 'arches', 'rocks', 'debris', 'shrubs', 'crystals', 'spires']) t[k] = o[k] === false ? 0 : Math.max(0, Math.round(Number(o[k] ?? (k === 'shrubs' ? o.grass ?? def[k] : def[k]))));
  if (!(Math.abs(t.lat) <= 89.9)) throw new Error('lat must be -89.9..89.9 deg');
  if (!Number.isFinite(t.lon)) throw new Error('lon must be a number (deg)');
  if (!(t.grid >= 1 && t.grid <= 512)) throw new Error('grid must be 1..512 cells');
  if (!(t.tile_px >= 4 && t.tile_px <= 256)) throw new Error('tile_px must be 4..256');
  if (!(Number.isFinite(t.skirt) && t.skirt >= 0)) throw new Error('skirt must be >= 0 m');
  const D = t.detail;
  if (!(Number.isFinite(Number(D.amplitude)) && Number(D.amplitude) >= 0 && Number(D.wavelength) > 0 && Number.isInteger(Number(D.octaves)) && D.octaves >= 1 && D.octaves <= 8)) throw new Error('detail: amplitude >= 0 m, wavelength > 0 m, octaves 1..8');
  t.detail = { ...D, amplitude: Number(D.amplitude), wavelength: Number(D.wavelength), octaves: Number(D.octaves) };
  if (!(t.size >= 16 && t.size <= 8192)) throw new Error('size must be 16..8192 m');
  if (!(t.chunks >= 1 && t.chunks <= 16)) throw new Error('chunks must be 1..16');
  if (!Array.isArray(t.lods) || t.lods[0] !== 1 || t.lods.some((s, i) => !(Number.isInteger(s) && s >= 1 && (i === 0 || s > t.lods[i - 1])))) throw new Error('lods must be increasing vertex steps starting at 1, e.g. [1, 2, 4]');
  const cg = t.grid / t.chunks;
  if (!(Number.isInteger(cg) && cg % t.lods[t.lods.length - 1] === 0)) throw new Error(`grid (${t.grid}) / chunks (${t.chunks}) must be a whole number divisible by the largest LOD step ${t.lods[t.lods.length - 1]}`);
  texLimit(t.chunk_px, t.chunk_px, 'terrain chunk texture (chunk_px)');
  if (![16, 32, 64].includes(t.tile_px)) throw new Error('tile_px must be 16, 32 or 64');
  const ppm = t.chunk_px / (t.size / t.chunks), k = t.tile_px / (t.tile_m * ppm);
  if (!(k >= 1 && Number.isInteger(Math.log2(k)))) throw new Error(`chunk texel density ${r4(ppm)} px/m must be tile_px / tile_m divided by a power of two (raise or lower chunk_px)`);
  if (!(t.detail_patches >= 0 && t.detail_patches <= 4)) throw new Error('detail_patches must be 0..4');
  if (t.horizon && !(t.horizon.radius > t.size)) throw new Error('horizon.radius must be larger than size');
  return t;
}

/** Height function of a patch (analytic, before erosion): {at(x, z) m relative to the pad base, base, planet, detail, dir, frame, d0, mesas, cliffs, mountainMask} */
export function patchHeight(P, t) {
  const d0 = latLonDir(t.lat, t.lon), F = localFrame(d0), Rm = P.real_radius_km * 1000;
  const dir = (x, z) => vnorm([d0[0] * Rm + F.east[0] * x - F.north[0] * z, d0[1] * Rm + F.east[1] * x - F.north[1] * z, d0[2] * Rm + F.east[2] * x - F.north[2] * z]);
  const E0 = elevKm(P, d0) * 1000;
  // the planet field barely changes over a patch: sample it on a coarse grid over the whole
  // horizon disc, bilinear in between
  const ext = t.horizon ? t.horizon.radius * 1.01 : t.size / 2;
  const G = 48, coarse = new Float64Array((G + 1) * (G + 1));
  for (let j = 0; j <= G; j++) for (let i = 0; i <= G; i++) coarse[j * (G + 1) + i] = elevKm(P, dir(-ext + (i / G) * 2 * ext, -ext + (j / G) * 2 * ext)) * 1000 - E0;
  const planet = (x, z) => {
    const fx = clamp01((x + ext) / (2 * ext)) * G, fz = clamp01((z + ext) / (2 * ext)) * G;
    const i = Math.min(G - 1, Math.floor(fx)), j = Math.min(G - 1, Math.floor(fz)), u = fx - i, v = fz - j;
    const a = coarse[j * (G + 1) + i], b = coarse[j * (G + 1) + i + 1], c = coarse[(j + 1) * (G + 1) + i], d = coarse[(j + 1) * (G + 1) + i + 1];
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  };
  const nd = perlin3(seedOf(P.seed, 201)), nr = perlin3(seedOf(P.seed, 202)), nm = perlin3(seedOf(P.seed, 205)), nk = perlin3(seedOf(P.seed, 206)), D = t.detail;
  // ground detail + mountain ranges: global (direction-based) noise in metres, so neighbouring patches agree
  const detail = D.amplitude > 0 ? (x, z) => {
    const q = dir(x, z), k = Rm / D.wavelength;
    const a = fractal(nd, q[0] * k, q[1] * k, q[2] * k, { octaves: D.octaves, frequency: 1 });
    const r = fractal(nr, q[0] * k * 0.7, q[1] * k * 0.7, q[2] * k * 0.7, { type: 'ridged', octaves: 3, frequency: 1 });
    return D.amplitude * (a * 0.8 + (r - 0.5) * 0.6);
  } : () => 0;
  const half = t.size / 2, padR = t.pad.radius;
  const nsec = perlin3(seedOf(t.seed, 209));
  // ranges stand on some sides of the horizon (not a ring): radial ramp x angular sector noise
  const mountainMask = (x, z) => { const r = Math.hypot(x, z); if (r < half * 0.7) return 0; const a = Math.atan2(z, x); const sec = smoothstep(0.3, 0.7, 0.5 + 0.7 * fractal(nsec, Math.cos(a) * 1.4, Math.sin(a) * 1.4, 0.5, { octaves: 2 })); return smoothstep(half * 0.7, half * 2.4, r) * (0.12 + 0.88 * sec); };
  const MT = t.mountains;
  const mountains = MT ? (x, z) => {
    const q = dir(x, z), k = Rm / MT.wavelength;
    // ridged multifractal ranges, gated by a low-frequency "range" mask (not a ring around the pad)
    const ridge = fractal(nm, q[0] * k, q[1] * k, q[2] * k, { type: 'ridged', octaves: 6, frequency: 1, gain: 0.55 });
    const range = smoothstep(0.38, 0.68, 0.5 + 0.6 * fractal(nk, q[0] * k * 0.3, q[1] * k * 0.3, q[2] * k * 0.3, { octaves: 2, frequency: 1 }));
    return MT.height * Math.pow(ridge, 1.6) * (0.3 + 0.7 * range) * mountainMask(x, z);
  } : () => 0;
  const DU = t.dunes, ndn = perlin3(seedOf(P.seed, 207)), wind = mulberry32(seedOf(t.seed, 208))() * Math.PI;
  const dunes = DU ? (x, z) => {
    const s = (x * Math.cos(wind) + z * Math.sin(wind)) / DU.wavelength + 0.9 * fractal(ndn, x / 180, z / 180, 0.5, { octaves: 2 });
    const f = s - Math.floor(s), tri = f < 0.72 ? f / 0.72 : (1 - f) / 0.28; // gentle windward, steep lee
    const amp = 0.5 + 0.5 * fractal(ndn, x / 260 + 7, z / 260, 1.5, { octaves: 2 });
    return DU.height * Math.pow(tri, 1.4) * amp * (1 - mountainMask(x, z));
  } : () => 0;
  // features (patch-local, seeded): mesas (flat terraced tops), escarpments
  const r = mulberry32(seedOf(t.seed, 203)), nf = perlin3(seedOf(t.seed, 204));
  const mesas = [];
  for (let i = 0; i < t.mesas; i++) {
    const ang = r() * Math.PI * 2, dist = t.size * (0.22 + r() * 0.18);
    const rad = t.size * (0.06 + r() * 0.05);
    mesas.push({ x: Math.cos(ang) * dist, z: Math.sin(ang) * dist, r: rad, h: rad * (0.45 + r() * 0.35), terraces: 2 + Math.floor(r() * 2) });
  }
  const cliffs = [];
  for (let i = 0; i < t.cliffs; i++) { const a = r() * Math.PI; cliffs.push({ n: [Math.cos(a), Math.sin(a)], off: (0.18 + r() * 0.15) * t.size * (r() < 0.5 ? -1 : 1), h: 8 + r() * 14 }); }
  const raw = (x, z) => planet(x, z) + detail(x, z) + mountains(x, z) + dunes(x, z);
  for (const m of mesas) m.base = raw(m.x, m.z);
  const features = (x, z, y) => {
    for (const c of cliffs) {
      const s = x * c.n[0] + z * c.n[1] - c.off + 14 * fractal(nf, x / 90, z / 90, 0.5, { octaves: 2 });
      const k = smoothstep(-3, 3, s);
      y += c.h * (Math.round(k * 2) / 2 * 0.3 + k * 0.7) * (1 - smoothstep(padR * 1.5, padR, Math.hypot(x, z)));
    }
    for (const m of mesas) {
      const dx = x - m.x, dz = z - m.z, a = Math.atan2(dz, dx);
      const d = Math.hypot(dx, dz) / (m.r * (1 + 0.22 * fractal(nf, Math.cos(a) * 1.5 + m.x, Math.sin(a) * 1.5, m.z, { octaves: 2 })));
      if (d > 1.15) continue;
      const k = smoothstep(1.12, 0.86, d), stepped = Math.round(k * m.terraces) / m.terraces;
      const p = clamp01(k * 0.35 + stepped * 0.65);
      y = y + (m.base + m.h - y) * p;
    }
    return y;
  };
  // landing pad: blend toward a gently noisy plateau at the centre height
  const padBase = features(0, 0, raw(0, 0));
  const at = (x, z) => {
    const y = features(x, z, raw(x, z)), f = smoothstep(padR * 1.8, padR, Math.hypot(x, z));
    return f > 0 ? lerp(y, padBase + (detail(x, z) - detail(0, 0)) * 0.12, f) : y;
  };
  return { at, base: E0, planet, detail, mountains, dunes, dir, frame: F, d0, mesas, cliffs, padBase, mountainMask };
}

// ---------- erosion ----------
/**
 * Thermal erosion (talus collapse -> scree at cliff bases) then droplet hydraulic erosion (gullies)
 * on a (N+1)^2 height grid in place. mask(i, j) 0..1 scales erosion (0 on the pad and at the patch
 * border, so the horizon ring and the pad stay put). -> {deposit, flow} (Float32 per vertex)
 */
export function erode(h, N, step, E, mask, seed) {
  const V = N + 1, deposit = new Float32Array(V * V), flow = new Float32Array(V * V);
  const T = E.talus * step;
  for (let it = 0; it < E.thermal; it++) {
    for (let j = 1; j < N; j++) for (let i = 1; i < N; i++) {
      const k = j * V + i, m = mask[k];
      if (m <= 0) continue;
      for (const o of [1, -1, V, -V]) {
        const d = h[k] - h[k + o];
        if (d > T) { const mv = 0.25 * (d - T) * m * mask[k + o]; h[k] -= mv; h[k + o] += mv; deposit[k + o] += mv; }
      }
    }
  }
  const r = mulberry32(seedOf(seed, 240)), drops = E.droplets ?? Math.round(V * V * 0.9);
  const hAt = (x, y) => { const i = Math.floor(x), j = Math.floor(y), u = x - i, v = y - j, k = j * V + i; return { h: h[k] * (1 - u) * (1 - v) + h[k + 1] * u * (1 - v) + h[k + V] * (1 - u) * v + h[k + V + 1] * u * v, gx: (h[k + 1] - h[k]) * (1 - v) + (h[k + V + 1] - h[k + V]) * v, gy: (h[k + V] - h[k]) * (1 - u) + (h[k + V + 1] - h[k + 1]) * u }; };
  for (let n = 0; n < drops; n++) {
    let x = 1 + r() * (N - 2), y = 1 + r() * (N - 2), dx = 0, dy = 0, speed = 1, water = 1, sed = 0;
    for (let s = 0; s < 40; s++) {
      const i = Math.floor(x), j = Math.floor(y), u = x - i, v = y - j, k = j * V + i;
      const g = hAt(x, y);
      dx = dx * 0.1 - g.gx * 0.9; dy = dy * 0.1 - g.gy * 0.9;
      const len = Math.hypot(dx, dy);
      if (len < 1e-9) break;
      dx /= len; dy /= len;
      const nx = x + dx, ny = y + dy;
      if (nx < 1 || ny < 1 || nx >= N - 1 || ny >= N - 1) break;
      flow[k] += water;
      const dh = hAt(nx, ny).h - g.h;
      const cap = Math.max(-dh, 0.01) * speed * water * 4;
      const m = mask[k];
      const w4 = [(1 - u) * (1 - v), u * (1 - v), (1 - u) * v, u * v], ks = [k, k + 1, k + V, k + V + 1];
      if (sed > cap || dh > 0) {
        const amt = dh > 0 ? Math.min(dh, sed) : (sed - cap) * 0.3;
        sed -= amt;
        for (let q = 0; q < 4; q++) { const mm = mask[ks[q]]; h[ks[q]] += amt * w4[q] * mm; deposit[ks[q]] += amt * w4[q] * 0.5 * mm; } // nothing settles on masked ground (pad, border)
      } else {
        const amt = Math.min((cap - sed) * 0.3, -dh, 0.6) * m;
        for (let q = 0; q < 4; q++) h[ks[q]] -= amt * w4[q];
        sed += amt;
      }
      speed = Math.sqrt(Math.max(0.01, speed * speed + dh * -0.35));
      water *= 0.97;
      x = nx; y = ny;
    }
  }
  return { deposit, flow };
}

/** Splat weights (ground, rock, low, scree) summing to exactly 255. */
export function splatWeights({ slope = 0, hrel = 0.5, patch = 0, scree = 0, flow = 0 } = {}) {
  const rock = smoothstep(0.55, 0.95, slope);
  const low = clamp01(smoothstep(0.1, 0.02, hrel) + smoothstep(0.6, 0.92, flow) * 0.6) * (1 - rock);
  const sc = clamp01(scree * 1.6 + smoothstep(0.66, 0.82, patch) * 0.35 + smoothstep(0.5, 0.75, slope) * 0.5 + smoothstep(0.4, 0.7, flow) * 0.5) * (1 - rock) * (1 - low * 0.7);
  const ground = Math.max(0, 1 - rock - low - sc);
  const w = [ground, rock, low, sc], s = w[0] + w[1] + w[2] + w[3] || 1;
  // largest-remainder rounding: the four bytes always sum to 255
  const raw = w.map((v) => (v / s) * 255), q = raw.map(Math.floor);
  let rest = 255 - q.reduce((a, b) => a + b, 0);
  const order = raw.map((v, i) => [v - q[i], i]).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (let k = 0; rest > 0; k = (k + 1) % 4, rest--) q[order[k][1]]++;
  return q;
}

// ---------- ground texels ----------
/** Periodic float table (S x S over `period` m) from tileable fbm; bilinear world lookup. */
function noiseTable(seed, S, period, p0 = 4, oct = 4) {
  const f = tileFbm(seed, S, p0, oct), tab = new Float32Array(S * S);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) tab[y * S + x] = f(x, y);
  const fn = (wx, wz) => {
    const fx = ((wx / period) * S % S + S) % S, fz = ((wz / period) * S % S + S) % S, i = Math.floor(fx), j = Math.floor(fz), u = fx - i, v = fz - j;
    const i1 = (i + 1) % S, j1 = (j + 1) % S;
    return tab[j * S + i] * (1 - u) * (1 - v) + tab[j * S + i1] * u * (1 - v) + tab[j1 * S + i] * (1 - u) * v + tab[j1 * S + i1] * u * v;
  };
  return Object.assign(fn, { tab, size: S, period });
}

/**
 * Ground material set: authored tiles (4 variants per layer), edge masks, rims, mips and the
 * texel function shared by chunk textures, detail patches and the horizon ring.
 */
export function groundMaterials(P, t, layers) {
  const S = t.tile_px;
  const mats = layers.map((L, li) => {
    const variants = [0, 1, 2, 3].map((v) => authorTile(L.kind, L.ramp, { size: S, seed: seedOf(t.seed, 300 + li * 17 + v * 101) % 100000, accent: L.accent }));
    const mask = edgeMask(S, seedOf(t.seed, 330 + li));
    const ramp = L.ramp.map((c) => (Array.isArray(c) ? c : hexRGB(c)));
    const mean = [0, 0, 0];
    for (const v of variants) for (let i = 0; i < v.data.length; i += 4) for (let c = 0; c < 3; c++) mean[c] += v.data[i + c];
    const n = variants.length * S * S;
    return { ...L, variants, mask, rim: ramp[0].map((c) => c * 0.8), mean: mean.map((c) => c / n), mips: new Map([[1, variants]]), ramp };
  });
  const mipOf = (m, k) => { if (!m.mips.has(k)) m.mips.set(k, m.variants.map((v) => (k === 1 ? v : tileMip(v, k)))); return m.mips.get(k); };
  const warpX = noiseTable(seedOf(t.seed, 341), 256, 48), warpZ = noiseTable(seedOf(t.seed, 342), 256, 48);
  const varN = noiseTable(seedOf(t.seed, 343), 128, 96, 3, 3), fine = noiseTable(seedOf(t.seed, 344), 128, 9, 4, 2), band = noiseTable(seedOf(t.seed, 345), 64, 40, 3, 2);
  const strata = layers[1].ramp.map((c) => (Array.isArray(c) ? c : hexRGB(c)));
  const tm = t.tile_m;
  /**
   * RGBA (+ emissive) of the ground at world (wx, wz): ctx = {splat(x, z) -> [4 bytes], height(x, z),
   * slope(x, z)}, ppm = texels per metre (picks the tile mip), x / y = output pixel (dither).
   */
  const texel = (wx, wz, ctx, ppm, px, py, out, eo) => {
    // 1. noise-perturbed splat lookup: borders break up into organic shapes
    const ax = wx + (warpX(wx, wz) - 0.5) * 5, az = wz + (warpZ(wx, wz) - 0.5) * 5;
    const w = ctx.splat(ax, az);
    let A = 0, B = -1;
    for (let c = 1; c < 4; c++) if (w[c] > w[A]) A = c;
    for (let c = 0; c < 4; c++) if (c !== A && (B < 0 || w[c] > w[B])) B = c;
    const tB = w[B] / (w[A] + w[B] || 1);
    // 2. texel coordinates in full-res tile space; mip factor for coarse textures
    const k = Math.max(1, Math.min(S, 2 ** Math.round(Math.log2(Math.max(1, S / (tm * ppm))))));
    // gentle domain warp of the tile lookup: breaks the 2 m repetition, keeps crisp texels
    const gx = Math.floor(((wx + (fine(wx + 31.7, wz) - 0.5) * 1.1) / tm) * S), gz = Math.floor(((wz + (fine(wx, wz + 17.3) - 0.5) * 1.1) / tm) * S);
    const mi = ((gz % S) + S) % S * S + (((gx % S) + S) % S);
    // 3. dithered, noise-masked transition: B covers where its blob mask is below its weight
    const jit = (bayer(px, py) - 0.5) * 0.04 + (fine(wx, wz) - 0.5) * 0.3;
    const mB = mats[B].mask[mi] + jit;
    let L = mB < tB ? B : A, rim = false;
    if (L === A && mB < tB + 0.045 && tB > 0.04) rim = true;
    const m = mats[L];
    // 4. variant: low-frequency noise, organic borders from the material's own mask
    const v = Math.max(0, Math.min(3, Math.floor(varN(wx, wz) * 4 + (m.mask[mi] - 0.5) * 0.9)));
    const tiles = mipOf(m, k), T = tiles[v], ts = T.width;
    const tx = Math.floor(((((gx % S) + S) % S)) / k), tz = Math.floor(((((gz % S) + S) % S)) / k);
    const o = (tz * ts + tx) * 4;
    let r = T.data[o], g = T.data[o + 1], b = T.data[o + 2];
    if (rim && k <= 2) { const rc = mats[B].rim; r = rc[0]; g = rc[1]; b = rc[2]; }
    // 5. steep faces: layered strata bands (horizontal in world height), tile luminance kept
    if (L === 1) {
      const sl = ctx.slope(wx, wz);
      if (sl > 0.9) {
        const y = ctx.height(wx, wz) + (band(wx, wz) - 0.5) * 2.2;
        const bi = Math.floor(y / 1.7), hs = ((bi * 2654435761) >>> 0) % 1000 / 1000;
        const bc = strata[Math.min(strata.length - 1, Math.floor(hs * strata.length))];
        const lum = (r + g + b) / (3 * 255), kk = smoothstep(0.9, 1.3, sl);
        r = lerp(r, bc[0] * (0.7 + 0.6 * lum), kk); g = lerp(g, bc[1] * (0.7 + 0.6 * lum), kk); b = lerp(b, bc[2] * (0.7 + 0.6 * lum), kk);
      }
    }
    out[0] = r; out[1] = g; out[2] = b; out[3] = 255;
    if (eo && T.emissive && k === 1 && T.emissive[o + 3]) { eo[0] = T.emissive[o]; eo[1] = T.emissive[o + 1]; eo[2] = T.emissive[o + 2]; eo[3] = 255; return true; }
    return false;
  };
  return { mats, texel, layers, tables: { warpX, warpZ, varN, fine } };
}

/** Bake a ground texture over world rect [x0, x0 + w] x [z0, z0 + h] at `px` x `py` texels. */
export function bakeGround(G, ctx, x0, z0, w, h, px, py) {
  texLimit(px, py, 'ground texture');
  const data = new Uint8ClampedArray(px * py * 4), out = [0, 0, 0, 0], eo = [0, 0, 0, 0];
  let em = null;
  const ppm = px / w;
  for (let y = 0; y < py; y++) for (let x = 0; x < px; x++) {
    const wx = x0 + ((x + 0.5) / px) * w, wz = z0 + ((y + 0.5) / py) * h;
    const glow = G.texel(wx, wz, ctx, ppm, x, y, out, eo);
    data.set(out, (y * px + x) * 4);
    if (glow) { em = em || new Uint8ClampedArray(px * py * 4); em.set(eo, (y * px + x) * 4); }
  }
  return { width: px, height: py, data, emissive: em };
}

/**
 * Build a patch: eroded heights, splat, ground materials, chunks (LODs + skirts + collision),
 * detail patches, horizon ring, clustered scatter, formations, anchors.
 */
export function buildTerrain(P, t) {
  const H = patchHeight(P, t), N = t.grid, step = t.size / N, half = t.size / 2, V = N + 1;
  const h = new Float32Array(V * V);
  for (let j = 0; j < V; j++) for (let i = 0; i < V; i++) h[j * V + i] = H.at(-half + i * step, -half + j * step);
  let deposit = new Float32Array(V * V), flow = new Float32Array(V * V);
  if (t.erosion) {
    const mask = new Float32Array(V * V);
    for (let j = 0; j < V; j++) for (let i = 0; i < V; i++) {
      const x = -half + i * step, z = -half + j * step, edge = Math.min(i, j, N - i, N - j) / N;
      mask[j * V + i] = smoothstep(t.pad.radius * 1.3, t.pad.radius * 2.2, Math.hypot(x, z)) * smoothstep(0.01, 0.08, edge);
    }
    ({ deposit, flow } = erode(h, N, step, t.erosion, mask, t.seed));
  }
  let lo = Infinity, hi = -Infinity, fmax = 0, dmax = 0;
  for (const v of h) { if (v < lo) lo = v; if (v > hi) hi = v; }
  for (let k = 0; k < V * V; k++) { fmax = Math.max(fmax, flow[k]); dmax = Math.max(dmax, deposit[k]); }
  const flowN = (k) => (fmax > 0 ? Math.log1p(flow[k]) / Math.log1p(fmax) : 0), depN = (k) => (dmax > 0 ? Math.min(1, deposit[k] / (dmax * 0.25)) : 0);
  const hAt = (i, j) => h[Math.max(0, Math.min(N, j)) * V + Math.max(0, Math.min(N, i))];
  const slopeAt = (i, j) => Math.hypot((hAt(i + 1, j) - hAt(i - 1, j)) / (2 * step), (hAt(i, j + 1) - hAt(i, j - 1)) / (2 * step));
  const nrmAt = (i, j) => vnorm([-(hAt(i + 1, j) - hAt(i - 1, j)) / (2 * step), 1, -(hAt(i, j + 1) - hAt(i, j - 1)) / (2 * step)]);
  const bil = (arr, x, z) => {
    const fx = clamp01((x + half) / t.size) * N, fz = clamp01((z + half) / t.size) * N;
    const i = Math.min(N - 1, Math.floor(fx)), j = Math.min(N - 1, Math.floor(fz)), u = fx - i, v = fz - j;
    return arr(i, j) * (1 - u) * (1 - v) + arr(i + 1, j) * u * (1 - v) + arr(i, j + 1) * (1 - u) * v + arr(i + 1, j + 1) * u * v;
  };
  const heightAt = (x, z) => bil(hAt, x, z);
  // splat (grid resolution); hrel against a local 64 m window so dunes / gullies read, not the mountains
  const np = perlin3(seedOf(t.seed, 210));
  const splat = new Uint8ClampedArray(V * V * 4);
  const rel = 0.5 * 64 / step | 0;
  const blur = new Float32Array(V * V);
  { // box-blurred height (separable) for local relative height
    const tmp = new Float32Array(V * V);
    for (let j = 0; j < V; j++) { let s = 0, c = 0; for (let i = -rel; i < V; i++) { if (i + rel < V) { s += h[j * V + i + rel]; c++; } if (i - rel - 1 >= 0) { s -= h[j * V + i - rel - 1]; c--; } if (i >= 0) tmp[j * V + i] = s / c; } }
    for (let i = 0; i < V; i++) { let s = 0, c = 0; for (let j = -rel; j < V; j++) { if (j + rel < V) { s += tmp[(j + rel) * V + i]; c++; } if (j - rel - 1 >= 0) { s -= tmp[(j - rel - 1) * V + i]; c--; } if (j >= 0) blur[j * V + i] = s / c; } }
  }
  for (let j = 0; j < V; j++) for (let i = 0; i < V; i++) {
    const k = j * V + i, x = -half + i * step, z = -half + j * step;
    const patch = 0.5 + 0.6 * fractal(np, x / 40, z / 40, 0.5, { octaves: 3 });
    splat.set(splatWeights({ slope: slopeAt(i, j), hrel: clamp01(0.5 + (h[k] - blur[k]) / 6), patch, scree: depN(k), flow: flowN(k) }), k * 4);
  }
  const centre = field(P, H.d0);
  const layers = layerSpec(P, centre);
  const G = groundMaterials(P, t, layers);
  const splatAt = (x, z) => {
    const fx = clamp01((x + half) / t.size) * N, fz = clamp01((z + half) / t.size) * N;
    const i = Math.min(N - 1, Math.floor(fx)), j = Math.min(N - 1, Math.floor(fz)), u = fx - i, v = fz - j;
    const w = [0, 0, 0, 0];
    for (const [ii, jj, k] of [[i, j, (1 - u) * (1 - v)], [i + 1, j, u * (1 - v)], [i, j + 1, (1 - u) * v], [i + 1, j + 1, u * v]]) for (let c = 0; c < 4; c++) w[c] += splat[(jj * V + ii) * 4 + c] * k;
    return w;
  };
  const ctx = { splat: splatAt, height: heightAt, slope: (x, z) => bil(slopeAt, x, z) };
  // chunk meshes: LOD vertex steps over the global grid (shared edges -> no cracks at equal LOD), skirts
  const cn = t.chunks, cg = N / cn, cm = t.size / cn;
  const chunkGroup = (tex, cx, cz, s, skirt, i0 = cx * cg, j0 = cz * cg, n = cg / s, lift = 0) => {
    const g = { tex, pos: [], nrm: [], uv: [], idx: [] };
    const vid = (a, b) => b * (n + 1) + a;
    for (let b = 0; b <= n; b++) for (let a = 0; a <= n; a++) {
      const i = i0 + a * s, j = j0 + b * s, nn = nrmAt(i, j);
      g.pos.push(-half + i * step, hAt(i, j) + lift, -half + j * step); g.nrm.push(nn[0], nn[1], nn[2]); g.uv.push(a / n, b / n);
    }
    for (let b = 0; b < n; b++) for (let a = 0; a < n; a++) { const p = vid(a, b), q = p + 1, r = p + n + 1, u = r + 1; g.idx.push(p, r, q, q, r, u); }
    if (skirt) {
      const edge = (list, flip) => {
        const low = list.map((k) => { g.pos.push(g.pos[k * 3], g.pos[k * 3 + 1] - skirt, g.pos[k * 3 + 2]); g.nrm.push(g.nrm[k * 3], g.nrm[k * 3 + 1], g.nrm[k * 3 + 2]); g.uv.push(g.uv[k * 2], g.uv[k * 2 + 1]); return g.pos.length / 3 - 1; });
        for (let q = 0; q < list.length - 1; q++) { const a = list[q], b = list[q + 1], c = low[q], d = low[q + 1]; if (flip) g.idx.push(a, b, c, b, d, c); else g.idx.push(a, c, b, b, c, d); }
      };
      const R = [...Array(n + 1).keys()];
      // outward-facing skirts: -Z edge, +Z edge, -X edge, +X edge
      edge(R.map((a) => vid(a, 0)), true); edge(R.map((a) => vid(a, n)), false); edge(R.map((b) => vid(0, b)), false); edge(R.map((b) => vid(n, b)), true);
    }
    return g;
  };
  const lodError = (s) => {
    let e = 0;
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const a = Math.floor(i / s) * s, b = Math.floor(j / s) * s, u = (i - a) / s, v = (j - b) / s;
      const y = hAt(a, b) * (1 - u) * (1 - v) + hAt(a + s, b) * u * (1 - v) + hAt(a, b + s) * (1 - u) * v + hAt(a + s, b + s) * u * v;
      e = Math.max(e, Math.abs(y - h[j * V + i]));
    }
    return e;
  };
  const lodErr = t.lods.map((s) => (s === 1 ? 0 : lodError(s)));
  const chunks = [];
  for (let cz = 0; cz < cn; cz++) for (let cx = 0; cx < cn; cx++) {
    const img = bakeGround(G, ctx, -half + cx * cm, -half + cz * cm, cm, cm, t.chunk_px, t.chunk_px);
    const tex = { key: `terrain_${cx}_${cz}`, name: `terrain_${cx}_${cz}`, width: img.width, height: img.height, data: img.data, ...(img.emissive ? { emissive: img.emissive } : {}) };
    chunks.push({ cx, cz, tex, lods: t.lods.map((s) => chunkGroup(tex, cx, cz, s, t.skirt)), collision: chunkGroup({ key: 'collision', name: 'collision', width: 1, height: 1, data: Uint8ClampedArray.from([255, 0, 255, 255]) }, cx, cz, t.lods[t.lods.length - 1], 0) });
  }
  // detail patches around the pad: 32 m squares at 32 px/m, a decal 4 cm above the chunks
  const details = [];
  const dp = t.detail_patches, dm = 32, cells = Math.round(dm / step);
  for (let pz = 0; pz < dp; pz++) for (let px = 0; px < dp; px++) {
    const x0 = (px - dp / 2) * dm, z0 = (pz - dp / 2) * dm;
    const i0 = Math.round((x0 + half) / step), j0 = Math.round((z0 + half) / step);
    if (i0 < 0 || j0 < 0 || i0 + cells > N || j0 + cells > N) continue;
    const img = bakeGround(G, ctx, x0, z0, dm, dm, dm * t.detail_px_per_m, dm * t.detail_px_per_m);
    const tex = { key: `detail_${px}_${pz}`, name: `detail_${px}_${pz}`, width: img.width, height: img.height, data: img.data, ...(img.emissive ? { emissive: img.emissive } : {}) };
    details.push({ px, pz, x0, z0, size: dm, tex, group: chunkGroup(tex, 0, 0, 1, 0, i0, j0, cells, 0.04) });
  }
  // ---- horizon ring: square inner edge (the patch border) out to a circle at horizon.radius
  let horizon = null;
  if (t.horizon) {
    const Hz = t.horizon, K = Hz.rings, A = Hz.segments;
    const g = { tex: null, pos: [], nrm: [], uv: [], idx: [] };
    const pts = [];
    for (let k = 0; k <= K; k++) for (let a = 0; a <= A; a++) {
      const th = (a / A) * Math.PI * 2, c = Math.cos(th), s = Math.sin(th);
      const rin = half / Math.max(Math.abs(c), Math.abs(s)), sk = Math.pow(k / K, 1.7), rr = rin * Math.pow(Hz.radius / rin, sk);
      const x = c * rr, z = s * rr;
      pts.push([x, k === 0 ? heightAt(x, z) : H.at(x, z), z]);
    }
    const W = A + 1;
    for (let k = 0; k <= K; k++) for (let a = 0; a <= A; a++) {
      const p = pts[k * W + a], pa = pts[k * W + ((a + 1) % A)], pk = pts[Math.min(K, k + 1) * W + a], pm = pts[Math.max(0, k - 1) * W + a];
      const e1 = [pa[0] - p[0], pa[1] - p[1], pa[2] - p[2]], e2 = [pk[0] - pm[0], pk[1] - pm[1], pk[2] - pm[2]];
      let n = vnorm(vcross(e2, e1)); if (n[1] < 0) n = n.map((v) => -v);
      g.pos.push(...p); g.nrm.push(...n); g.uv.push(a / A, k / K);
    }
    for (let k = 0; k < K; k++) for (let a = 0; a < A; a++) {
      const p = k * W + a, q = p + 1, r = p + W, u = r + 1;
      const P0 = pts[p], P1 = pts[q], P2 = pts[r];
      const cr = vcross([P2[0] - P0[0], P2[1] - P0[1], P2[2] - P0[2]], [P1[0] - P0[0], P1[1] - P0[1], P1[2] - P0[2]]);
      if (cr[1] >= 0) g.idx.push(p, r, q, q, r, u); else g.idx.push(p, q, r, q, u, r);
    }
    // texture: polar unwrap (u = angle, v = ring): weighted mean material colours (no per-texel
    // dither at 10-100 m texels: that would read as blocks), strata tint on steep faces
    const TW = Math.min(1024, A * 8), TH = Math.min(256, K * 4), data = new Uint8ClampedArray(TW * TH * 4);
    const hp = new Float32Array(TW * TH), px = new Float32Array(TW * TH), pz = new Float32Array(TW * TH);
    for (let y = 0; y < TH; y++) for (let x = 0; x < TW; x++) {
      const th = ((x + 0.5) / TW) * Math.PI * 2, kk = ((y + 0.5) / TH) * K, c = Math.cos(th), s2 = Math.sin(th);
      const rin = half / Math.max(Math.abs(c), Math.abs(s2)), rr = rin * Math.pow(Hz.radius / rin, Math.pow(kk / K, 1.7)), q = y * TW + x;
      px[q] = c * rr; pz[q] = s2 * rr; hp[q] = H.at(px[q], pz[q]);
    }
    const aSlope = (x, z) => { const e = 3; return Math.hypot(H.at(x + e, z) - H.at(x - e, z), H.at(x, z + e) - H.at(x, z - e)) / (2 * e); };
    const hctx = {
      splat: (x, z) => (Math.max(Math.abs(x), Math.abs(z)) <= half ? splatAt(x, z) : splatWeights({ slope: aSlope(x, z), hrel: 0.5, patch: 0.5 + 0.6 * fractal(np, x / 40, z / 40, 0.5, { octaves: 3 }), scree: 0, flow: 0 })),
      height: (x, z) => H.at(x, z), slope: aSlope,
    };
    const means = G.mats.map((m) => m.mean), strataR = G.mats[1].ramp;
    for (let y = 0; y < TH; y++) for (let x = 0; x < TW; x++) {
      const q = y * TW + x, qa = y * TW + ((x + 1) % TW), qb = Math.min(TH - 1, y + 1) * TW + x, qc = Math.max(0, y - 1) * TW + x;
      const sl = Math.max(Math.abs(hp[qa] - hp[q]) / (Math.hypot(px[qa] - px[q], pz[qa] - pz[q]) || 1), Math.abs(hp[qb] - hp[qc]) / (Math.hypot(px[qb] - px[qc], pz[qb] - pz[qc]) || 1));
      const w = splatWeights({ slope: sl, hrel: 0.5, patch: 0.5 + 0.6 * fractal(np, px[q] / 300, pz[q] / 300, 0.5, { octaves: 2 }), scree: 0, flow: 0 });
      const c = [0, 1, 2].map((k) => (w[0] * means[0][k] + w[1] * means[1][k] + w[2] * means[2][k] + w[3] * means[3][k]) / 255);
      if (sl > 0.6) { const bc = strataR[Math.abs(Math.floor(hp[q] / 14)) % strataR.length], kk = smoothstep(0.6, 1.1, sl) * 0.6; for (let k = 0; k < 3; k++) c[k] = lerp(c[k], bc[k], kk); }
      const lit = 0.85 + 0.3 * clamp01((hp[q] - hp[qc]) / 40 + 0.5) - 0.15; // cheap relief shading in the albedo (far, unlit-looking ridges)
      // near the patch border use the real ground texels (no seam where the chunks end)
      const rq = Math.hypot(px[q], pz[q]), near = smoothstep(half * 2.1, half * 1.35, rq);
      if (near > 0 && bayer(x, y) < near) { const o4 = [0, 0, 0, 0]; G.texel(px[q], pz[q], hctx, TW / (2 * Math.PI * rq), x, y, o4, null); data.set(o4, q * 4); continue; }
      data.set([c[0] * lit, c[1] * lit, c[2] * lit, 255], q * 4);
    }
    g.tex = { key: 'horizon', name: 'horizon', width: TW, height: TH, data };
    let peak = -Infinity; for (const p of pts) peak = Math.max(peak, p[1]);
    horizon = { group: g, radius: Hz.radius, rings: K, segments: A, peak_m: r4(peak), triangles: g.idx.length / 3 };
  }
  // ---- clustered scatter (seeded): boulder clusters near cliffs / gullies, debris, spires, shrub clumps, crystal outcrops
  const rr = mulberry32(seedOf(t.seed, 230));
  const padR = t.pad.radius;
  const gridK = (x, z) => { const i = Math.round((x + half) / step), j = Math.round((z + half) / step); return Math.max(0, Math.min(N, j)) * V + Math.max(0, Math.min(N, i)); };
  const wAt = (x, z) => { const k = gridK(x, z); return [0, 1, 2, 3].map((c) => splat[k * 4 + c] / 255); };
  const slopeXZ = (x, z) => { const k = gridK(x, z); return slopeAt(k % V, Math.floor(k / V)); };
  const quatY = (a) => [0, Math.sin(a / 2), 0, Math.cos(a / 2)];
  const qmul = (a, b) => [a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1], a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0], a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3], a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]];
  const tilt = (yaw, tx, tz) => qmul(qmul([0, 0, Math.sin(tz / 2), Math.cos(tz / 2)], [Math.sin(tx / 2), 0, 0, Math.cos(tx / 2)]), quatY(yaw));
  const inside = (x, z, m = 2) => Math.abs(x) < half - m && Math.abs(z) < half - m;
  const pick = (score, tries = 400) => { for (let n = 0; n < tries; n++) { const x = (rr() * 2 - 1) * (half - 3), z = (rr() * 2 - 1) * (half - 3); if (Math.hypot(x, z) < padR) continue; if (rr() < score(x, z)) return [x, z]; } return null; };
  const scatter = { rocks: [], debris: [], spires: [], shrubs: [], crystals: [] };
  const requested = { rocks: t.rocks, debris: t.debris, spires: t.spires, shrubs: t.shrubs, crystals: t.crystals };
  const place = (kind, x, z, s, rot, v, sink = 0) => scatter[kind].push({ p: [r4(x), r4(heightAt(x, z) - sink * s), r4(z)], r: rot.map(r4), s: r4(s), v });
  const cliffBase = (x, z) => { const w = wAt(x, z), k = gridK(x, z); return clamp01(w[3] * 1.2 + depN(k) + w[1] * 0.4); };
  const gully = (x, z) => flowN(gridK(x, z));
  // boulder clusters: one big rock, smaller ones falling off in size with distance
  while (scatter.rocks.length < t.rocks) {
    const c = pick((x, z) => 0.08 + 0.92 * Math.max(cliffBase(x, z), gully(x, z) * 0.8));
    if (!c) break;
    const big = 1.4 + rr() * 2.2, n = 3 + Math.floor(rr() * 9);
    for (let i = 0; i < n && scatter.rocks.length < t.rocks; i++) {
      const d = i ? big * (0.7 + Math.pow(rr(), 0.7) * 3.2) : 0, a = rr() * Math.PI * 2, x = c[0] + Math.cos(a) * d, z = c[1] + Math.sin(a) * d;
      if (!inside(x, z) || Math.hypot(x, z) < padR * 0.8) continue;
      const s = i ? big * Math.exp(-d / (big * 2.2)) * (0.35 + rr() * 0.45) : big;
      place('rocks', x, z, Math.max(0.25, s), tilt(rr() * 6.283, (rr() - 0.5) * 0.5, (rr() - 0.5) * 0.5), i ? 1 + Math.floor(rr() * 3) : 0, 0.15);
    }
  }
  // debris: pebbles around the rocks and over scree
  while (scatter.debris.length < t.debris) {
    let x, z;
    if (scatter.rocks.length && rr() < 0.55) { const rk = scatter.rocks[Math.floor(rr() * scatter.rocks.length)], a = rr() * 6.283, d = rk.s * (0.8 + rr() * 3); x = rk.p[0] + Math.cos(a) * d; z = rk.p[2] + Math.sin(a) * d; }
    else { const c = pick((x2, z2) => 0.1 + 0.9 * cliffBase(x2, z2), 60); if (!c) { x = (rr() * 2 - 1) * (half - 3); z = (rr() * 2 - 1) * (half - 3); } else [x, z] = c; }
    if (!inside(x, z) || Math.hypot(x, z) < padR * 0.5) continue;
    place('debris', x, z, 0.12 + Math.pow(rr(), 2) * 0.4, tilt(rr() * 6.283, (rr() - 0.5) * 0.8, (rr() - 0.5) * 0.8), Math.floor(rr() * 2), 0.2);
  }
  // spires: on high, moderately steep ground away from the pad
  for (let n = 0; scatter.spires.length < t.spires && n < 4000; n++) {
    const x = (rr() * 2 - 1) * (half - 10), z = (rr() * 2 - 1) * (half - 10);
    if (Math.hypot(x, z) < padR * 2.5) continue;
    const k = gridK(x, z), hr = (h[k] - lo) / (hi - lo || 1), sl = slopeXZ(x, z);
    if (sl > 0.9 || rr() > 0.15 + hr * 0.6 + (sl > 0.3 ? 0.2 : 0)) continue;
    if (scatter.spires.some((s2) => Math.hypot(s2.p[0] - x, s2.p[2] - z) < 25)) continue;
    place('spires', x, z, 0.7 + rr() * 0.9, quatY(rr() * 6.283), Math.floor(rr() * 2), 0.05);
  }
  // shrub / grass clumps on gentle ground, denser along gullies
  while (scatter.shrubs.length < t.shrubs) {
    const c = pick((x, z) => { const w = wAt(x, z); return slopeXZ(x, z) > 0.45 ? 0 : (1 - w[1]) * (0.25 + gully(x, z) * 0.75 + w[2] * 0.3); });
    if (!c) break;
    const n = 3 + Math.floor(rr() * 7);
    for (let i = 0; i < n && scatter.shrubs.length < t.shrubs; i++) {
      const a = rr() * 6.283, d = Math.pow(rr(), 0.8) * 3.2, x = c[0] + Math.cos(a) * d, z = c[1] + Math.sin(a) * d;
      if (!inside(x, z) || Math.hypot(x, z) < padR * 0.9) continue;
      place('shrubs', x, z, 0.6 + rr() * 0.7, quatY(rr() * 6.283), rr() < 0.55 ? 0 : 1);
    }
  }
  // crystal outcrops on low ground / rock (toxic, ice, lava)
  while (scatter.crystals.length < t.crystals) {
    const c = pick((x, z) => { const w = wAt(x, z); return 0.05 + w[2] * 0.6 + w[1] * 0.4 + w[3] * 0.3; });
    if (!c) break;
    const n = 2 + Math.floor(rr() * 6);
    for (let i = 0; i < n && scatter.crystals.length < t.crystals; i++) {
      const a = rr() * 6.283, d = Math.pow(rr(), 0.7) * 2.5, x = c[0] + Math.cos(a) * d, z = c[1] + Math.sin(a) * d;
      if (!inside(x, z) || Math.hypot(x, z) < padR * 0.9) continue;
      place('crystals', x, z, i ? 0.4 + rr() * 0.6 : 1 + rr() * 0.8, tilt(rr() * 6.283, (rr() - 0.5) * 0.6, (rr() - 0.5) * 0.6), Math.floor(rr() * 2), 0.1);
    }
  }
  // ---- formations (arches) on gentle ground, away from mesas and the pad
  const forms = [];
  for (let tries = 0; forms.length < t.arches && tries < 600; tries++) {
    const x = (rr() - 0.5) * t.size * 0.7, z = (rr() - 0.5) * t.size * 0.7;
    if (H.mesas.some((m) => Math.hypot(x - m.x, z - m.z) < m.r * 1.6)) continue;
    if (Math.hypot(x, z) < padR * 2.5) continue;
    if (slopeXZ(x, z) > 0.35) continue;
    forms.push({ kind: 'arch', p: [r4(x), r4(heightAt(x, z) - 1), r4(z)], yaw: r4(rr() * 360), size: r4(Math.min(60, t.size * (0.06 + rr() * 0.04))) });
  }
  const anchors = [
    { kind: 'landing_pad', p: [0, r4(heightAt(0, 0)), 0], radius: r4(padR), slope: r4(slopeAt(N / 2, N / 2)) },
    ...H.mesas.map((m) => ({ kind: 'mesa_top', p: [r4(m.x), r4(heightAt(m.x, m.z)), r4(m.z)], radius: r4(m.r * 0.75) })),
    ...forms.map((f) => ({ kind: 'arch', p: f.p, span: f.size, yaw: f.yaw })),
  ];
  // fog / sky (from the planet's atmosphere and the ground palette)
  const atm = P.atmosphere ? P.atmosphere.color : [150, 150, 160];
  const gm = G.mats[0].mean;
  const fogC = atm.map((c, i) => Math.round(lerp(c, gm[i], 0.35) * 0.92));
  const fog = {
    color: toHex(fogC), type: 'exp2', density: r4(2.0 / (t.horizon ? t.horizon.radius * 0.85 : t.size * 2)), near: r4(t.size * 0.3), far: r4(t.horizon ? t.horizon.radius * 0.9 : t.size * 1.5),
    sky: { horizon: toHex(fogC.map((c) => Math.min(255, c * 1.08))), zenith: toHex(atm.map((c) => c * 0.45)) },
    note: 'three.js: scene.fog = new THREE.FogExp2(color, density) (or THREE.Fog(color, near, far)); sky gradient horizon -> zenith; fog hides the horizon ring edge',
  };
  return { H, heights: h, lo, hi, splat, layers, G, chunks, details, horizon, lodErr, scatter, requested, forms, anchors, fog, cm, step, heightAt, centreBiome: biomeOf(P, centre).name, erosion: { deposit_max: r4(dmax), flow_max: r4(fmax) } };
}
export { D2R };
