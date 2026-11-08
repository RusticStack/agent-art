// Procedural planets as pixel art: one field per planet (seeded 3D noise on the unit sphere) feeds
// every output, so orbit maps, cube-sphere meshes, quadtree tiles and ground patches agree.
//   field(P, dir)   height (0..1 + km), latitude, moisture, water, seams, cities
//   shade(P, f)     biome rules -> palette ramp colour (banded, ordered dither), roughness, glow
//   bakes           equirect + cube faces: albedo, height, normal (tangent), emissive, night, rough
//   meshes          cube-sphere LODs on an integer lattice (shared edges are bit-identical),
//                   quadtree tiles (same lattice: equal-level neighbours share edges exactly) + skirts
//   extras          cloud shell, ring annulus, atmosphere shell + shader params, disc impostor
//   renderPlanet    analytic reference renderer (rim, terminator, clouds, rings + shadows)
import { perlin3, fractal, warp, seedOf, clamp01, smoothstep, lerp, vnorm, vdot, tangents, equirectDir, dirToEquirect, cubeDir, cubePoint, dirToCube, FACES, hexRGB, rampPick, shiftColor, quantize, texLimit, r4 } from './noise.js';
import { mulberry32 } from '../util.js';

// ---------- presets (original palettes) ----------
const R = (...c) => c;
export const PRESETS = {
  ice: {
    about: 'glacier world: pack ice, blue crevasse seams, polar snow, thin cyan air',
    sea_level: 0.4, relief_km: 5, noise: { type: 'ridged', octaves: 6, frequency: 1.7, warp: 0.4 }, continents: { frequency: 0.8, weight: 0.5 },
    biomes: [
      { name: 'frozen_sea', where: { water: true }, ramp: R('#1d3550', '#27506f', '#346d8e', '#4f8aa6'), by: 'depth', rough: 0.25 },
      { name: 'cap', where: { lat: [0.72, 1] }, ramp: R('#d8e7ee', '#eaf3f6', '#f8fcfd'), by: 'height', rough: 0.45 },
      { name: 'peaks', where: { height: [0.74, 1] }, ramp: R('#8ea6b8', '#b3c8d5', '#e3eef3', '#ffffff'), by: 'height', rough: 0.5 },
      { name: 'pack', ramp: R('#7b97ad', '#97b2c4', '#b5ccd9', '#cfe0e8'), by: 'height', rough: 0.4 },
    ],
    seams: { ramp: R('#2b5677', '#3f7699'), width: 0.06, frequency: 3.2 },
    atmosphere: { color: '#9cd8ff', sunset: '#d8a0ff', density: 0.55, height: 0.035 }, clouds: { coverage: 0.62, color: '#eef6fa', shadow: '#b8cad6', frequency: 2.2 },
  },
  toxic: {
    about: 'toxic red world: rust plateaus, acid lakes that glow faintly, sulphur haze',
    sea_level: 0.37, relief_km: 7, noise: { type: 'fbm', octaves: 6, frequency: 1.5, warp: 0.55 }, continents: { frequency: 1.1, weight: 0.55 },
    biomes: [
      { name: 'acid_lake', where: { water: true }, ramp: R('#6f8f12', '#93b31c', '#bcd42a', '#dfe85a'), by: 'depth', rough: 0.12, emissive: '#7a9a0c', glow: 0.35 },
      { name: 'crust', where: { height: [0.37, 0.4] }, ramp: R('#c79a3a', '#dcb64c'), by: 'height', rough: 0.85 },
      { name: 'highland', where: { height: [0.7, 1] }, ramp: R('#4a1f1c', '#62302a', '#7c4538', '#9a5c48'), by: 'height', rough: 0.9 },
      { name: 'rust', ramp: R('#5a1a12', '#76261a', '#923520', '#ad4a29', '#c66534'), by: 'moisture', rough: 0.85 },
    ],
    canyons: { amount: 0.6, width: 0.05, depth: 0.12 },
    atmosphere: { color: '#ff6f3c', sunset: '#ffd040', density: 1.15, height: 0.05 }, clouds: { coverage: 0.5, color: '#d9915c', shadow: '#8a4a30', frequency: 1.6, warp: 0.8 },
  },
  bloom: {
    about: 'bloom world: teal-green vegetation blooms, deep teal seas, snowy ranges, colony lights at night',
    sea_level: 0.5, relief_km: 9, noise: { type: 'fbm', octaves: 7, frequency: 1.4, warp: 0.45 }, continents: { frequency: 0.9, weight: 0.62 },
    biomes: [
      { name: 'ocean', where: { water: true }, ramp: R('#052a35', '#08404d', '#0d5864', '#16727a'), by: 'depth', rough: 0.18 },
      { name: 'shore', where: { height: [0.5, 0.515] }, ramp: R('#b8b07a', '#d1c98f'), by: 'height', rough: 0.8 },
      { name: 'snow', where: { lat: [0.8, 1] }, ramp: R('#d6e2df', '#eef4f2'), by: 'height', rough: 0.5 },
      { name: 'peaks', where: { height: [0.78, 1] }, ramp: R('#56635c', '#7d8a83', '#b9c4bf', '#eef3f0'), by: 'height', rough: 0.75 },
      { name: 'bloom', where: { moisture: [0.56, 1] }, ramp: R('#127a5a', '#1f9a70', '#38bb8a', '#68d8aa', '#9cf0c8'), by: 'moisture', rough: 0.9 },
      { name: 'steppe', where: { moisture: [0, 0.3] }, ramp: R('#5f6a3e', '#7b8348', '#979c58'), by: 'height', rough: 0.9 },
      { name: 'forest', ramp: R('#0c4a3e', '#135f4a', '#1a7656', '#238b60'), by: 'height', rough: 0.9 },
    ],
    cities: { density: 0.5, color: '#ffcf7a', where: { height: [0.5, 0.62] } },
    atmosphere: { color: '#5fcfff', sunset: '#ff9a5a', density: 1, height: 0.04 }, clouds: { coverage: 0.52, color: '#f2f7f8', shadow: '#a9bcc4', frequency: 1.9, warp: 0.6 },
  },
  lava: {
    about: 'lava world: black basalt plates split by glowing seams, molten lowlands, ash haze',
    sea_level: 0.36, relief_km: 6, noise: { type: 'fbm', octaves: 6, frequency: 1.8, warp: 0.3 }, continents: { frequency: 1.3, weight: 0.4 },
    biomes: [
      { name: 'magma', where: { water: true }, ramp: R('#b8300c', '#e0521a', '#ff8a2a', '#ffc94a'), by: 'depth', rough: 0.6, emissive: '#ff6a1a', glow: 0.9 },
      { name: 'ash', where: { height: [0.72, 1] }, ramp: R('#3a3335', '#4d4446', '#625758'), by: 'height', rough: 0.95 },
      { name: 'basalt', ramp: R('#120e10', '#1d1719', '#2a2224', '#3a2f30'), by: 'moisture', rough: 0.9 },
    ],
    seams: { ramp: R('#c2380c', '#ff6a14', '#ffa21f', '#ffe45c'), width: 0.16, frequency: 2.2, emissive: true },
    craters: { count: 14, min: 0.03, max: 0.1, depth: 0.08 },
    atmosphere: { color: '#ff7a3a', sunset: '#ffb050', density: 0.6, height: 0.03 }, clouds: { coverage: 0.7, color: '#4a4044', shadow: '#1a1416', frequency: 2.4 },
  },
  desert: {
    about: 'desert world: dune seas, red mesas and canyons, white salt flats, thin dusty air',
    sea_level: 0.38, relief_km: 8, noise: { type: 'fbm', octaves: 6, frequency: 1.6, warp: 0.5 }, continents: { frequency: 1, weight: 0.5 },
    biomes: [
      { name: 'salt_flat', where: { water: true }, ramp: R('#d8ccae', '#e8dec4', '#f4eedc'), by: 'depth', rough: 0.55 },
      { name: 'mesa', where: { height: [0.66, 1] }, ramp: R('#6a3a26', '#844a30', '#9e5e3c', '#b8784e'), by: 'height', rough: 0.9 },
      { name: 'dunes', where: { moisture: [0.45, 1] }, ramp: R('#b06c34', '#c98444', '#dc9e58', '#ecbc74'), by: 'noise', rough: 0.95 },
      { name: 'regolith', ramp: R('#8a5636', '#a26a40', '#b8804e'), by: 'height', rough: 0.9 },
    ],
    canyons: { amount: 0.9, width: 0.045, depth: 0.16 },
    craters: { count: 10, min: 0.02, max: 0.07, depth: 0.06 },
    atmosphere: { color: '#ffc08a', sunset: '#ff7a4a', density: 0.45, height: 0.03 }, clouds: { coverage: 0.78, color: '#e8c8a0', shadow: '#a07850', frequency: 2 },
  },
  gas: {
    about: 'gas giant: lavender-peach latitude bands, turbulent edges, storm vortices, wide banded rings',
    gas: { bands: 11, turbulence: 0.35, storms: 3, ramp: R('#4a2e5e', '#6e4a7e', '#94668e', '#bf8c9c', '#e2b8ae', '#f2d8c2', '#d0a0a6', '#8a5a86') },
    atmosphere: { color: '#e4b4ff', sunset: '#ffb8a0', density: 0.8, height: 0.025 }, clouds: false,
    rings: { inner: 1.35, outer: 2.3, ramp: R('#7a6a58', '#a89070', '#c8b090', '#e0d0b0'), gaps: 3, opacity: 0.9, tilt: 18 },
  },
  barren: {
    about: 'airless moon: grey regolith, dense craters, no atmosphere',
    sea_level: null, relief_km: 4, noise: { type: 'billow', octaves: 5, frequency: 2, warp: 0.2 }, continents: { frequency: 0.9, weight: 0.35 },
    biomes: [
      { name: 'maria', where: { height: [0, 0.42] }, ramp: R('#2e2e32', '#3c3c41', '#4a4a50'), by: 'height', rough: 0.95 },
      { name: 'highland', ramp: R('#55555b', '#6b6b71', '#828288', '#9a9aa0'), by: 'height', rough: 0.95 },
    ],
    craters: { count: 140, min: 0.015, max: 0.16, depth: 0.22 },
    atmosphere: false, clouds: false,
  },
};
export const PRESET_NAMES = Object.keys(PRESETS);

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
function deepMerge(a, b) {
  if (!isObj(a) || !isObj(b)) return b === undefined ? a : b;
  const o = { ...a };
  for (const [k, v] of Object.entries(b)) o[k] = v === undefined ? a[k] : isObj(v) && isObj(a[k]) ? deepMerge(a[k], v) : v;
  return o;
}
const range = (v, name) => {
  if (v === undefined) return null;
  if (!Array.isArray(v) || v.length !== 2 || !v.every(Number.isFinite)) throw new Error(`${name} must be [min, max] (0..1)`);
  return [Number(v[0]), Number(v[1])];
};
const ramp = (v, name) => {
  if (!Array.isArray(v) || !v.length) throw new Error(`${name} must be a list of colours (dark -> light)`);
  return v.map(hexRGB);
};

/**
 * Planet spec = preset + overrides (deep merged). Returns the normalised spec used by every bake;
 * throws with a readable message on bad input.
 */
export function normPlanet(a = {}) {
  const preset = a.preset ?? a.biome ?? 'bloom';
  if (!PRESETS[preset]) throw new Error(`preset must be one of ${PRESET_NAMES.join(', ')} (got ${JSON.stringify(preset)})`);
  let s = deepMerge(PRESETS[preset], Object.fromEntries(Object.entries(a).filter(([k]) => !['biomes', 'ramps'].includes(k))));
  if (a.biomes) s.biomes = a.biomes;
  s.preset = preset;
  s.seed = a.seed ?? 1;
  s.radius = Number(a.radius ?? 100);
  if (!(s.radius > 0)) throw new Error('radius (mesh units) must be > 0');
  s.real_radius_km = Number(a.real_radius_km ?? 3200);
  s.relief_km = Number(s.relief_km ?? 6);
  s.mesh_relief = Number(a.mesh_relief ?? 4);
  s.hue = Number(a.hue ?? 0);
  s.dither = a.dither !== false;
  if (!(s.real_radius_km > 0) || ![s.relief_km, s.mesh_relief, s.hue].every(Number.isFinite)) throw new Error('real_radius_km must be > 0; relief_km, mesh_relief and hue must be numbers');
  const shift = (c) => (s.hue ? shiftColor(c, s.hue) : c);
  if (s.gas) s.gas = { bands: 10, turbulence: 0.3, storms: 2, ...s.gas, ramp: ramp(s.gas.ramp, 'gas.ramp').map(shift) };
  s.biomes = s.gas ? [] : (s.biomes || []).map((b, i) => {
    if (!isObj(b)) throw new Error(`biomes[${i}] must be {name, where?, ramp, by?, rough?, emissive?, glow?}`);
    const w = b.where || {};
    const custom = a.ramps && a.ramps[b.name];
    return {
      name: b.name || `biome_${i}`, ramp: ramp(custom || b.ramp, `biomes[${i}].ramp`).map(shift), by: b.by || 'height', rough: Number(b.rough ?? 0.9),
      emissive: b.emissive ? shift(hexRGB(b.emissive)) : null, glow: Number(b.glow ?? 0),
      where: { water: w.water, height: range(w.height, `biomes[${i}].where.height`), lat: range(w.lat, `biomes[${i}].where.lat`), moisture: range(w.moisture, `biomes[${i}].where.moisture`) },
    };
  });
  if (!s.gas && !s.biomes.length) throw new Error('a planet needs at least one biome (or a gas preset)');
  if (s.seams) s.seams = { width: 0.06, frequency: 3, ...s.seams, ramp: ramp(s.seams.ramp, 'seams.ramp').map(shift) };
  if (s.cities) s.cities = { density: 0.5, ...s.cities, color: hexRGB(s.cities.color ?? '#ffcf7a'), where: { height: range(s.cities.where?.height, 'cities.where.height') } };
  if (s.craters) s.craters = { count: 20, min: 0.02, max: 0.08, depth: 0.08, ...s.craters };
  if (s.canyons) s.canyons = { amount: 0.6, width: 0.05, depth: 0.12, ...s.canyons };
  if (s.atmosphere) s.atmosphere = { density: 1, height: 0.04, falloff: 3, ...s.atmosphere, color: hexRGB(s.atmosphere.color ?? '#7fd0ff'), sunset: hexRGB(s.atmosphere.sunset ?? '#ff9a5a') };
  if (s.clouds) s.clouds = { coverage: 0.55, sharpness: 0.08, frequency: 2, warp: 0.5, opacity: 0.95, height: 0.012, levels: 4, ...s.clouds, color: hexRGB(s.clouds.color ?? '#f0f4f6'), shadow: hexRGB(s.clouds.shadow ?? '#a0b0b8') };
  if (s.rings) s.rings = { inner: 1.4, outer: 2.2, gaps: 2, opacity: 0.85, tilt: 15, ...s.rings, ramp: ramp(s.rings.ramp ?? ['#8a7a68', '#c8b090'], 'rings.ramp').map(shift) };
  if (s.rings && !(s.rings.inner > 1 && s.rings.outer > s.rings.inner)) throw new Error('rings: need 1 < inner < outer (planet radii)');
  s.noise = { type: 'fbm', octaves: 6, frequency: 1.6, warp: 0.4, warp_frequency: 1.1, ...(s.noise || {}) };
  if (!['fbm', 'ridged', 'billow'].includes(s.noise.type)) throw new Error('noise.type must be fbm, ridged or billow');
  s.continents = { frequency: 1, weight: 0.5, ...(s.continents || {}) };
  s.moisture = { frequency: 1.3, bias: 0, ...(s.moisture || {}) };
  s.tilt = Number(a.tilt ?? s.rings?.tilt ?? 0);
  return s;
}

// ---------- field ----------
/** Noise generators, crater list and storms for a spec (cached on the spec object). */
function gen(P) {
  if (P._gen) return P._gen;
  const sd = (k) => seedOf(P.seed, k);
  const g = {
    h: perlin3(sd(1)), c: perlin3(sd(2)), m: perlin3(sd(3)), w: [perlin3(sd(4)), perlin3(sd(5)), perlin3(sd(6))], k: perlin3(sd(7)), s: perlin3(sd(8)), d: perlin3(sd(9)), cl: perlin3(sd(10)), e: perlin3(sd(11)), ci: perlin3(sd(12)),
    craters: [], storms: [],
  };
  const r = mulberry32(sd(20));
  const rdir = () => { const z = r() * 2 - 1, t = r() * 2 * Math.PI, q = Math.sqrt(1 - z * z); return [q * Math.cos(t), z, q * Math.sin(t)]; };
  if (P.craters) for (let i = 0; i < Math.min(400, P.craters.count); i++) {
    // power-law sizes: many small, few large
    const rad = P.craters.min * Math.pow(P.craters.max / P.craters.min, Math.pow(r(), 2.2));
    g.craters.push({ d: rdir(), r: rad, cos: Math.cos(rad * 1.6), depth: P.craters.depth * (0.5 + 0.5 * Math.sqrt(rad / P.craters.max)) });
  }
  if (P.gas) for (let i = 0; i < P.gas.storms; i++) { const d = rdir(); d[1] *= 0.6; g.storms.push({ d: vnorm(d), r: 0.08 + r() * 0.12, spin: (r() < 0.5 ? -1 : 1) * (2 + r() * 2), tone: r() }); }
  Object.defineProperty(P, '_gen', { value: g, enumerable: false });
  return g;
}

/** Normalised height 0..1 at a unit direction (no colour work: meshes, terrain, normals). */
export function heightAt(P, d) {
  if (P.gas) return 0.5;
  const g = gen(P), N = P.noise;
  const f = N.frequency;
  const p = warp(g.w, d[0] * f, d[1] * f, d[2] * f, N.warp, N.warp_frequency);
  let det = fractal(g.h, p[0], p[1], p[2], N);
  if (N.type !== 'fbm') det = det * 2 - 1;
  const cf = P.continents.frequency;
  const cont = fractal(g.c, d[0] * cf + p[0] * 0.15, d[1] * cf + p[1] * 0.15, d[2] * cf + p[2] * 0.15, { octaves: 4, frequency: 1 });
  const cw = P.continents.weight;
  let h = 0.5 + 0.62 * (cont * cw + det * (1 - cw));
  if (P.canyons && P.canyons.amount > 0) {
    const c = Math.abs(fractal(g.k, p[0] * 0.8, p[1] * 0.8, p[2] * 0.8, { octaves: 3, frequency: 1.4 }));
    const w = P.canyons.width;
    if (c < w && h > (P.sea_level ?? 0)) h -= P.canyons.depth * P.canyons.amount * smoothstep(w, w * 0.35, c);
  }
  for (const c of g.craters) {
    const cd = vdot(d, c.d);
    if (cd < c.cos) continue;
    const t = Math.acos(Math.min(1, cd)) / c.r;
    if (t < 1) h -= c.depth * (1 - t * t); // bowl
    h += c.depth * 0.35 * Math.exp(-(((t - 1) / 0.22) ** 2)); // raised rim
  }
  return clamp01(h);
}
/** Elevation in km above the datum (sea level, or 0.5 without a sea). */
export const datum = (P) => P.sea_level ?? 0.5;
export const elevKm = (P, d) => (heightAt(P, d) - datum(P)) * P.relief_km;

/** Everything the colour rules need at a direction. */
export function field(P, d) {
  const g = gen(P);
  const h = heightAt(P, d);
  const lat = Math.abs(d[1]); // |sin(latitude)|: 0 equator .. 1 pole
  const latf = Math.asin(Math.min(1, lat)) / (Math.PI / 2);
  const mf = P.moisture.frequency;
  let moist = 0.5 + 0.55 * fractal(g.m, d[0] * mf, d[1] * mf, d[2] * mf, { octaves: 4, frequency: 1 }) + P.moisture.bias;
  moist = clamp01(moist + (0.5 - latf) * 0.15);
  const edge = 0.04 * fractal(g.e, d[0] * 6, d[1] * 6, d[2] * 6, { octaves: 3 });
  const sea = P.sea_level;
  return { d, h, lat: latf, moist, edge, water: sea !== null && sea !== undefined && h < sea, sea };
}

const inR = (r, v) => !r || (v >= r[0] && v <= r[1]);
/** First biome whose `where` matches a field sample (the last biome is the fallback). */
export function biomeOf(P, f) {
  const hv = f.h + f.edge, lv = f.lat + f.edge * 1.5, mv = f.moist + f.edge;
  for (const c of P.biomes) {
    const w = c.where;
    if (w.water !== undefined && w.water !== f.water) continue;
    if (!inR(w.height, hv) || !inR(w.lat, lv) || !inR(w.moisture, mv)) continue;
    return c;
  }
  return P.biomes[P.biomes.length - 1];
}
/**
 * Colour of a field sample at pixel (x, y): -> {c:[r,g,b], rough 0..1, glow:[r,g,b]|null, night:[r,g,b]|null}.
 * Biomes are tested in order; the first whose `where` matches wins (the last one is the fallback).
 */
export function shade(P, f, x = 0, y = 0) {
  const g = gen(P), d = f.d, dither = P.dither;
  if (P.gas) return gasShade(P, g, d, x, y);
  const b = biomeOf(P, f), w = b.where;
  let t;
  if (b.by === 'depth') t = f.sea ? clamp01(f.h / f.sea) : f.h;
  else if (b.by === 'moisture') t = w.moisture ? clamp01((f.moist - w.moisture[0]) / (w.moisture[1] - w.moisture[0] || 1)) : f.moist;
  else if (b.by === 'lat') t = f.lat;
  else if (b.by === 'noise') t = 0.5 + 0.5 * fractal(g.d, d[0] * 9, d[1] * 9, d[2] * 9, { octaves: 2 });
  else { const r = w.height || [f.sea ?? 0, 1]; t = clamp01((f.h - r[0]) / (r[1] - r[0] || 1)); }
  let c = rampPick(b.ramp, t, dither, x, y), rough = b.rough;
  let glow = b.emissive && b.glow > 0 ? b.emissive.map((v) => v * b.glow) : null, night = null;
  // seams: ridged crack network on land (lava rivers, ice crevasses)
  if (P.seams && !f.water) {
    const S = P.seams, q = S.frequency;
    const r = fractal(g.s, d[0] * q, d[1] * q, d[2] * q, { type: 'ridged', octaves: 3, frequency: 1 });
    if (r > 1 - S.width) {
      const k = clamp01((r - (1 - S.width)) / S.width);
      c = rampPick(S.ramp, k, dither, x, y);
      rough = 0.5;
      if (S.emissive) glow = c.map((v) => v * (0.5 + 0.5 * k));
    }
  }
  // colony lights: clustered dots in habitable land, only on the night side (separate map)
  if (P.cities && !f.water && inR(P.cities.where.height, f.h)) {
    const n = fractal(g.ci, d[0] * 5, d[1] * 5, d[2] * 5, { octaves: 2 });
    const dots = fractal(g.ci, d[0] * 90, d[1] * 90, d[2] * 90, { octaves: 1 });
    if (n > 0.55 - P.cities.density * 0.4 && dots > 0.35) night = P.cities.color.map((v) => v * clamp01((dots - 0.35) * 4));
  }
  return { c, rough, glow, night };
}

function gasShade(P, g, d, x, y) {
  const G = P.gas;
  let q = d;
  let storm = 0, tone = 0;
  for (const s of g.storms) {
    const cd = vdot(d, s.d);
    if (cd < Math.cos(s.r)) continue;
    const k = 1 - Math.acos(Math.min(1, cd)) / s.r;
    // swirl: rotate around the storm axis by an angle growing toward the eye
    const ang = s.spin * k * k;
    const ax = s.d, cs = Math.cos(ang), sn = Math.sin(ang), dt = vdot(ax, q);
    const cr = [ax[1] * q[2] - ax[2] * q[1], ax[2] * q[0] - ax[0] * q[2], ax[0] * q[1] - ax[1] * q[0]];
    q = [q[0] * cs + cr[0] * sn + ax[0] * dt * (1 - cs), q[1] * cs + cr[1] * sn + ax[1] * dt * (1 - cs), q[2] * cs + cr[2] * sn + ax[2] * dt * (1 - cs)];
    if (k > storm) { storm = k; tone = s.tone; }
  }
  const p = warp(g.w, q[0] * 2, q[1] * 0.6, q[2] * 2, G.turbulence, 1.6, 3);
  const turb = fractal(g.h, p[0], p[1] * 4, p[2], { octaves: 4, frequency: 1.5 });
  const band = (q[1] * 0.5 + 0.5) * G.bands + turb * G.turbulence * 3 + 0.4 * Math.sin(q[1] * 23);
  const fr = band - Math.floor(band);
  // band index walks the ramp back and forth (soft gradient between neighbouring bands)
  const n = G.ramp.length, k = Math.floor(band) % (2 * n - 2);
  const t = (k < n - 1 ? k + fr : 2 * n - 2 - k - fr) / (n - 1);
  let c = rampPick(G.ramp, t, P.dither, x, y);
  if (storm > 0.55) c = rampPick(tone > 0.5 ? G.ramp.slice(-3) : G.ramp.slice(0, 3), clamp01((storm - 0.55) / 0.45), P.dither, x, y);
  return { c, rough: 0.9, glow: null, night: null };
}

// ---------- bakes ----------
/** Sample a grid of directions into maps. dirAt(x, y) -> unit dir. -> {albedo, glow, night, rough, heightKm (Float32)} */
function bakeGrid(P, W, H, dirAt, { palette } = {}) {
  const albedo = new Uint8ClampedArray(W * H * 4), glow = new Uint8ClampedArray(W * H * 4), night = new Uint8ClampedArray(W * H * 4), rough = new Uint8ClampedArray(W * H * 4);
  const heightKm = new Float32Array(W * H);
  let anyGlow = false, anyNight = false;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const d = dirAt(x, y), f = field(P, d), s = shade(P, f, x, y), o = (y * W + x) * 4;
    heightKm[y * W + x] = (f.h - datum(P)) * P.relief_km;
    albedo[o] = s.c[0]; albedo[o + 1] = s.c[1]; albedo[o + 2] = s.c[2]; albedo[o + 3] = 255;
    rough[o] = 255; rough[o + 1] = Math.round(s.rough * 255); rough[o + 2] = 0; rough[o + 3] = 255;
    if (s.glow) { glow[o] = s.glow[0]; glow[o + 1] = s.glow[1]; glow[o + 2] = s.glow[2]; glow[o + 3] = 255; anyGlow = true; }
    if (s.night) { night[o] = s.night[0]; night[o + 1] = s.night[1]; night[o + 2] = s.night[2]; night[o + 3] = 255; anyNight = true; }
  }
  if (palette) quantize(albedo, W, palette, { dither: P.dither });
  return { albedo, glow: anyGlow ? glow : null, night: anyNight ? night : null, rough, heightKm };
}

/**
 * Normals from a height function on a grid: positions p = dir * (R + e * exag); n = (dp/dx x image-up).
 * hAt(x, y) may be called one texel outside the grid (true field there: seamless across faces).
 * -> {tangent (RGBA, glTF: +x = +u, +y = image up), object (Float32 xyz)}
 */
function normalsGrid(W, H, dirAt, hAt, Rkm, exag) {
  const tan = new Uint8ClampedArray(W * H * 4), obj = new Float32Array(W * H * 3);
  const pos = (x, y) => { const d = dirAt(x, y), r = Rkm + hAt(x, y) * exag; return [d[0] * r, d[1] * r, d[2] * r]; };
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const a = pos(x + 1, y), b = pos(x - 1, y), u = pos(x, y - 1), v = pos(x, y + 1);
    const du = [a[0] - b[0], a[1] - b[1], a[2] - b[2]], dv = [u[0] - v[0], u[1] - v[1], u[2] - v[2]];
    const N0 = dirAt(x, y);
    let n = vnorm([du[1] * dv[2] - du[2] * dv[1], du[2] * dv[0] - du[0] * dv[2], du[0] * dv[1] - du[1] * dv[0]]);
    if (vdot(n, N0) < 0) n = n.map((c) => -c);
    if (!Number.isFinite(n[0]) || Math.hypot(...du) < 1e-9) n = N0;
    const Tp = vnorm([du[0] - vdot(du, N0) * N0[0], du[1] - vdot(du, N0) * N0[1], du[2] - vdot(du, N0) * N0[2]]);
    const Bp = vnorm([dv[0] - vdot(dv, N0) * N0[0], dv[1] - vdot(dv, N0) * N0[1], dv[2] - vdot(dv, N0) * N0[2]]);
    const o = (y * W + x) * 4;
    tan[o] = Math.round((vdot(n, Tp) * 0.5 + 0.5) * 255); tan[o + 1] = Math.round((vdot(n, Bp) * 0.5 + 0.5) * 255); tan[o + 2] = Math.round((vdot(n, N0) * 0.5 + 0.5) * 255); tan[o + 3] = 255;
    obj.set(n, (y * W + x) * 3);
  }
  return { tangent: tan, object: obj };
}

const eqDir = (W, H) => (x, y) => equirectDir(((x % W) + W) % W / W + 0.5 / W, 1 - (Math.max(-0.5, Math.min(H - 0.5, y)) + 0.5) / H);
const faceDir = (f, S) => (x, y) => vnorm(cubePoint(f, (2 * (x + 0.5)) / S - 1, (2 * (y + 0.5)) / S - 1));

/** Equirect maps (W x W/2). -> {width, height, albedo, glow, night, rough, heightKm (Float32), normal, onormal} */
export function bakeEquirect(P, W, { palette, exag = 8 } = {}) {
  const H = W / 2;
  texLimit(W, H, 'equirect');
  const dirAt = eqDir(W, H);
  const m = bakeGrid(P, W, H, dirAt, { palette });
  const hAt = (x, y) => (y >= 0 && y < H ? m.heightKm[y * W + (((x % W) + W) % W)] : elevKm(P, dirAt(x, y)));
  const nm = normalsGrid(W, H, dirAt, hAt, P.real_radius_km, exag);
  return { width: W, height: H, ...m, normal: nm.tangent, onormal: nm.object };
}
/** One cube face (S x S). Normals use the true field one texel past the edge (seamless). */
export function bakeFace(P, f, S, { palette, exag = 8 } = {}) {
  texLimit(S, S, 'cube face');
  const dirAt = faceDir(f, S);
  const m = bakeGrid(P, S, S, dirAt, { palette });
  const hAt = (x, y) => (x >= 0 && y >= 0 && x < S && y < S ? m.heightKm[y * S + x] : elevKm(P, dirAt(x, y)));
  const nm = normalsGrid(S, S, dirAt, hAt, P.real_radius_km, exag);
  return { face: FACES[f], width: S, height: S, ...m, normal: nm.tangent };
}
/** Maps for a square region of face f: s in [s0, s0 + span], t in [t0, t0 + span] at px x px (quadtree tiles). */
export function bakeRegion(P, f, s0, t0, span, px, { palette, exag = 8 } = {}) {
  texLimit(px, px, 'tile');
  const dirAt = (x, y) => vnorm(cubePoint(f, 2 * (s0 + ((x + 0.5) / px) * span) - 1, 2 * (t0 + ((y + 0.5) / px) * span) - 1));
  const m = bakeGrid(P, px, px, dirAt, { palette });
  const hAt = (x, y) => (x >= 0 && y >= 0 && x < px && y < px ? m.heightKm[y * px + x] : elevKm(P, dirAt(x, y)));
  return { width: px, height: px, ...m, normal: normalsGrid(px, px, dirAt, hAt, P.real_radius_km, exag).tangent };
}
/** Height map as RGBA: gray 8-bit, or 16-bit packed (R = high byte, G = low byte) over [lo, hi] km. */
export function heightImage(hk, lo, hi, packed = false) {
  const out = new Uint8ClampedArray(hk.length * 4);
  for (let i = 0; i < hk.length; i++) {
    const t = clamp01((hk[i] - lo) / (hi - lo || 1));
    if (packed) { const v = Math.round(t * 65535); out[i * 4] = v >> 8; out[i * 4 + 1] = v & 255; out[i * 4 + 2] = 0; }
    else { const v = Math.round(t * 255); out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = v; }
    out[i * 4 + 3] = 255;
  }
  return out;
}

// ---------- clouds + rings ----------
/** Cloud alpha 0..1 (quantised to `levels` steps) at a direction. */
export function cloudAt(P, d, x = 0, y = 0) {
  const C = P.clouds;
  if (!C) return 0;
  const g = gen(P), f = C.frequency;
  const p = warp(g.w, d[0] * f, d[1] * f * 1.6, d[2] * f, C.warp, 1.3, 3);
  let v = 0.5 + 0.6 * fractal(g.cl, p[0], p[1], p[2], { octaves: 5, frequency: 1 });
  v -= Math.abs(d[1]) * 0.08;
  const a = smoothstep(C.coverage, C.coverage + C.sharpness * 2, v);
  if (a <= 0) return 0;
  const L = Math.max(1, Math.round(C.levels));
  const thr = P.dither ? ((((x & 3) * 4 + (y & 3)) * 7) % 16 + 0.5) / 16 : 0.5;
  return Math.min(1, Math.floor(a * L + thr) / L) * C.opacity;
}
/** Cloud RGBA over a grid of directions (colour = lit tone by density, shadow tone at thin edges). */
function bakeClouds(P, W, H, dirAt) {
  const out = new Uint8ClampedArray(W * H * 4), C = P.clouds;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const a = cloudAt(P, dirAt(x, y), x, y), o = (y * W + x) * 4;
    if (!a) continue;
    const c = a > 0.6 * C.opacity ? C.color : C.shadow;
    out[o] = c[0]; out[o + 1] = c[1]; out[o + 2] = c[2]; out[o + 3] = Math.round(a * 255);
  }
  return out;
}
export const bakeCloudsEquirect = (P, W) => { texLimit(W, W / 2, 'clouds'); return bakeClouds(P, W, W / 2, eqDir(W, W / 2)); };
export const bakeCloudsFace = (P, f, S) => bakeClouds(P, S, S, faceDir(f, S));

/** Ring strip texture (W x 4, u = radial inner -> outer): banded colour + alpha with gaps. */
export function bakeRings(P, W = 512) {
  const Rg = P.rings;
  texLimit(W, 4, 'rings');
  const n = perlin3(seedOf(P.seed, 31)), r = mulberry32(seedOf(P.seed, 32));
  const gaps = Array.from({ length: Rg.gaps }, () => ({ at: 0.15 + r() * 0.75, w: 0.01 + r() * 0.03 }));
  const row = new Uint8ClampedArray(W * 4), alpha = new Float32Array(W);
  for (let x = 0; x < W; x++) {
    const u = (x + 0.5) / W;
    let a = 0.55 + 0.35 * fractal(n, u * 9, 0.5, 0.5, { octaves: 2 }) + 0.25 * fractal(n, u * 60, 3.5, 1.5, { octaves: 2 });
    a *= smoothstep(0, 0.06, u) * smoothstep(1, 0.9, u);
    for (const g of gaps) if (Math.abs(u - g.at) < g.w) a *= 0.08;
    a = clamp01(a) * Rg.opacity;
    a = Math.round(a * 6) / 6; // banded alpha: pixel-art steps
    alpha[x] = a;
    const c = rampPick(Rg.ramp, 0.5 + 0.5 * fractal(n, u * 14, 7.5, 2.5, { octaves: 2 }), P.dither, x, 0);
    row.set([c[0], c[1], c[2], Math.round(a * 255)], x * 4);
  }
  const data = new Uint8ClampedArray(W * 4 * 4);
  for (let y = 0; y < 4; y++) data.set(row, y * W * 4);
  return { width: W, height: 4, data, alpha };
}

// ---------- meshes ----------
/** Unit direction of lattice point (a, b) on face f at lattice resolution N (integers: exact across faces + levels). */
export const latticeDir = (f, a, b, N) => vnorm(cubePoint(f, 2 * a - N, 2 * b - N, N));
/** Mesh radius (units) at a direction: R + elevation * (R / real radius) * mesh_relief. */
export function surfaceR(P, d) { return P.radius + elevKm(P, d) * (P.radius / P.real_radius_km) * P.mesh_relief; }
/** Smooth vertex normal from the field (basis depends on d only: shared vertices get identical normals). */
function surfaceNormal(P, d, eps) {
  if (P.gas) return d;
  const [T, B] = tangents(d), r0 = surfaceR(P, d);
  const at = (t, b) => surfaceR(P, vnorm([d[0] + T[0] * t + B[0] * b, d[1] + T[1] * t + B[1] * b, d[2] + T[2] * t + B[2] * b]));
  const gT = (at(eps, 0) - at(-eps, 0)) / (2 * eps * r0), gB = (at(0, eps) - at(0, -eps)) / (2 * eps * r0);
  return vnorm([d[0] - gT * T[0] - gB * B[0], d[1] - gT * T[1] - gB * B[1], d[2] - gT * T[2] - gB * B[2]]);
}

/**
 * A grid patch of face f covering lattice [a0, a0+n] x [b0, b0+n] at resolution N, as a mesh group.
 * opts: {skirt: units (edges pushed toward the centre: hides cracks next to coarser / finer tiles),
 * uv: 'face' (s, t of the face) | 'tile' (0..1 over the patch), shell: fixed radius (clouds / air)}
 */
export function facePatch(P, tex, f, a0, b0, n, N, opts = {}) {
  const g = { tex, pos: [], nrm: [], uv: [], idx: [] };
  const V = (n + 1) * (n + 1);
  const pos = new Array(V), nrm = new Array(V), dir = new Array(V);
  const eps = Math.PI / (2 * N);
  for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) {
    const d = latticeDir(f, a0 + i, b0 + j, N), r = opts.shell ?? surfaceR(P, d);
    const k = j * (n + 1) + i;
    dir[k] = d; pos[k] = [d[0] * r, d[1] * r, d[2] * r]; nrm[k] = opts.shell ? d : surfaceNormal(P, d, eps);
  }
  const push = (p, nn, u, v) => { g.pos.push(p[0], p[1], p[2]); g.nrm.push(nn[0], nn[1], nn[2]); g.uv.push(u, v); return g.pos.length / 3 - 1; };
  const uvOf = (i, j) => (opts.uv === 'tile' ? [i / n, j / n] : [(a0 + i) / N, (b0 + j) / N]);
  for (let k = 0; k < V; k++) { const i = k % (n + 1), j = Math.floor(k / (n + 1)), [u, v] = uvOf(i, j); push(pos[k], nrm[k], u, v); }
  // outward winding: image right (+s) x image down (+t) points inward on every face, so use (a, c, b)
  const tri = (a, b, c) => {
    const A = pos[a] ?? [g.pos[a * 3], g.pos[a * 3 + 1], g.pos[a * 3 + 2]], B = [g.pos[b * 3], g.pos[b * 3 + 1], g.pos[b * 3 + 2]], C = [g.pos[c * 3], g.pos[c * 3 + 1], g.pos[c * 3 + 2]];
    const cr = [(B[1] - A[1]) * (C[2] - A[2]) - (B[2] - A[2]) * (C[1] - A[1]), (B[2] - A[2]) * (C[0] - A[0]) - (B[0] - A[0]) * (C[2] - A[2]), (B[0] - A[0]) * (C[1] - A[1]) - (B[1] - A[1]) * (C[0] - A[0])];
    if (cr[0] * (A[0] + B[0] + C[0]) + cr[1] * (A[1] + B[1] + C[1]) + cr[2] * (A[2] + B[2] + C[2]) < 0) g.idx.push(a, c, b); else g.idx.push(a, b, c);
  };
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const a = j * (n + 1) + i, b = a + 1, c = a + n + 1, d = c + 1;
    // alternate the diagonal (less directional artefacts)
    if ((i + j) & 1) { tri(a, b, d); tri(a, d, c); } else { tri(a, b, c); tri(b, d, c); }
  }
  if (opts.skirt) {
    // skirts: each edge duplicated `skirt` units toward the centre (hides cracks 2+ levels apart)
    const edges = [[...Array(n + 1).keys()].map((i) => i), [...Array(n + 1).keys()].map((i) => n * (n + 1) + i), [...Array(n + 1).keys()].map((j) => j * (n + 1)), [...Array(n + 1).keys()].map((j) => j * (n + 1) + n)];
    for (const e of edges) {
      const low = e.map((k) => {
        const p = pos[k], l = Math.hypot(p[0], p[1], p[2]), s = (l - opts.skirt) / l;
        const [u, v] = [g.uv[k * 2], g.uv[k * 2 + 1]];
        return push([p[0] * s, p[1] * s, p[2] * s], nrm[k], u, v);
      });
      for (let q = 0; q < e.length - 1; q++) {
        const a = e[q], b = e[q + 1], c = low[q], d = low[q + 1];
        // skirt faces point outward from the patch (either way is fine: draw them double-sided-free)
        const pa = pos[a], pb = pos[b], ctr = latticeDir(f, a0 + n / 2, b0 + n / 2, N);
        const side = [(pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2, (pa[2] + pb[2]) / 2];
        const out = [side[0] - ctr[0] * vdot(side, ctr), side[1] - ctr[1] * vdot(side, ctr), side[2] - ctr[2] * vdot(side, ctr)];
        const e1 = [pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]], P2 = [g.pos[c * 3], g.pos[c * 3 + 1], g.pos[c * 3 + 2]], e2 = [P2[0] - pa[0], P2[1] - pa[1], P2[2] - pa[2]];
        const cr = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
        if (vdot(cr, out) >= 0) g.idx.push(a, b, c, b, d, c); else g.idx.push(a, c, b, b, c, d);
      }
    }
  }
  return g;
}

/** Max distance (units) between the true surface and a patch's bilinear surface at cell centres. */
export function patchError(P, f, a0, b0, n, N) {
  let err = 0;
  const p = (a, b) => { const d = latticeDir(f, a, b, N), r = surfaceR(P, d); return [d[0] * r, d[1] * r, d[2] * r]; };
  const step = Math.max(1, Math.floor(n / 8));
  for (let j = 0; j < n; j += step) for (let i = 0; i < n; i += step) {
    const A = p(a0 + i, b0 + j), B = p(a0 + i + 1, b0 + j), C = p(a0 + i, b0 + j + 1), D = p(a0 + i + 1, b0 + j + 1);
    const mid = [(A[0] + B[0] + C[0] + D[0]) / 4, (A[1] + B[1] + C[1] + D[1]) / 4, (A[2] + B[2] + C[2] + D[2]) / 4];
    const dc = latticeDir(f, 2 * (a0 + i) + 1, 2 * (b0 + j) + 1, 2 * N), rc = surfaceR(P, dc);
    err = Math.max(err, Math.hypot(dc[0] * rc - mid[0], dc[1] * rc - mid[1], dc[2] * rc - mid[2]));
  }
  return err;
}

/** Whole planet at `segs` cells per face edge: 6 groups (one per face, textured by faceTex[f]). */
export function cubeSphere(P, segs, faceTex, opts = {}) {
  return FACES.map((_, f) => facePatch(P, faceTex[f], f, 0, 0, segs, segs, opts));
}

// ---------- quadtree tiles ----------
/**
 * Skirt depth (units) of tile (f, L, x, y): covers the gap to a neighbour one level coarser (its
 * edge is the chord polyline of the parent lattice, off by at most the parent's error) and to a
 * finer neighbour (this tile's own error), with a floor of 0.2 % of the radius.
 */
export function tileSkirt(P, f, L, x, y, n) {
  const N = n << L, own = patchError(P, f, x * n, y * n, n, N);
  const parent = L > 0 ? patchError(P, f, (x * n) / 2, (y * n) / 2, n / 2, N / 2) : own;
  return Math.max(2 * own, 1.5 * parent, P.radius * 0.002);
}
/** Tile id "<face>/<level>/<x>_<y>"; x = column (s), y = row (t). */
export const tileId = (f, L, x, y) => `${FACES[f]}/${L}/${x}_${y}`;
/** Bounding sphere (units) of a tile from its corner + centre lattice points (+ relief margin). */
export function tileBounds(P, f, L, x, y, n) {
  const N = n << L, a0 = x * n, b0 = y * n;
  const pts = [[a0, b0], [a0 + n, b0], [a0, b0 + n], [a0 + n, b0 + n], [a0 + n / 2, b0 + n / 2], [a0 + n / 2, b0], [a0, b0 + n / 2], [a0 + n, b0 + n / 2], [a0 + n / 2, b0 + n]].map(([a, b]) => { const d = latticeDir(f, a, b, N), r = surfaceR(P, d); return [d[0] * r, d[1] * r, d[2] * r]; });
  const c = pts[4];
  const relief = (P.relief_km * P.radius / P.real_radius_km) * P.mesh_relief;
  let rad = 0;
  for (const p of pts) rad = Math.max(rad, Math.hypot(p[0] - c[0], p[1] - c[1], p[2] - c[2]));
  return { center: c.map(r4), radius: r4(rad + relief) };
}

// ---------- atmosphere ----------
/** Atmosphere shader parameters (see docs: three.js snippet). */
export function atmosphereParams(P) {
  const A = P.atmosphere;
  if (!A) return null;
  return {
    shell_radius: r4(P.radius * (1 + A.height)), planet_radius: P.radius, color: A.color.map((v) => r4(v / 255)), sunset: A.sunset.map((v) => r4(v / 255)),
    density: A.density, falloff: A.falloff, terminator: [-0.25, 0.35],
    note: 'Additive shell (front faces, depthWrite false). rim = pow(1 - dot(N, V), falloff) * density; day = smoothstep(terminator[0], terminator[1], dot(N, L)); colour = mix(color, sunset, 1 - smoothstep(0, 0.45, abs(dot(N, L))))',
  };
}

// ---------- reference renderer ----------
const rotY = (v, a) => { const c = Math.cos(a), s = Math.sin(a); return [c * v[0] + s * v[2], v[1], -s * v[0] + c * v[2]]; };
const rotX = (v, a) => { const c = Math.cos(a), s = Math.sin(a); return [v[0], c * v[1] - s * v[2], s * v[1] + c * v[2]]; };
const rotZ = (v, a) => { const c = Math.cos(a), s = Math.sin(a); return [c * v[0] - s * v[1], s * v[0] + c * v[1], v[2]]; };

/**
 * Render a planet (unit sphere) from its equirect maps: orthographic camera, pixel exact, transparent
 * background. maps: {width, height, albedo, glow, night, rough, onormal, clouds?, rings?}. opts:
 * {size, sun:[x,y,z] (view space, toward the light), spin deg, pitch deg (camera above the equator),
 * yaw deg, tilt deg, rings, clouds, atmosphere, extent (half-width in planet radii)}
 */
export function renderPlanet(P, maps, opts = {}) {
  const S = Math.round(opts.size ?? 192);
  const out = new Uint8ClampedArray(S * S * 4);
  const ring = opts.rings !== false && P.rings && maps.rings ? P.rings : null;
  const A = opts.atmosphere !== false ? P.atmosphere : null;
  const ext = opts.extent ?? (ring ? ring.outer * 1.04 : 1 + (A ? A.height * 2.2 : 0) + 0.04);
  const pitch = ((opts.pitch ?? 12) * Math.PI) / 180, yaw = ((opts.yaw ?? 0) * Math.PI) / 180, tilt = ((opts.tilt ?? P.tilt ?? 0) * Math.PI) / 180, spin = ((opts.spin ?? 0) * Math.PI) / 180;
  // view -> planet frame: undo camera pitch / yaw, then the axial tilt, then the spin
  const toP = (v) => rotY(rotZ(rotY(rotX(v, -pitch), yaw), -tilt), -spin);
  const toF = (v) => rotZ(rotY(rotX(v, -pitch), yaw), -tilt); // frame without spin (rings, sun)
  const Lv = vnorm(opts.sun ?? [-0.75, 0.3, 0.6]);
  const L = toF(Lv);
  const W = maps.width, H = maps.height;
  const texel = (d) => {
    const ds = rotY(d, -spin);
    const [u, v] = dirToEquirect(ds);
    const x = Math.min(W - 1, Math.floor(u * W)), y = Math.min(H - 1, Math.floor((1 - v) * H));
    return y * W + x;
  };
  const cl = opts.clouds !== false && P.clouds && maps.clouds ? maps.clouds : null;
  const ringA = (r) => { const u = (r - ring.inner) / (ring.outer - ring.inner); if (u < 0 || u >= 1) return null; const x = Math.floor(u * maps.rings.width) * 4; return maps.rings.data.subarray(x, x + 4); };
  const amb = 0.05;
  for (let py = 0; py < S; py++) for (let px = 0; px < S; px++) {
    const vx = ((px + 0.5) / S * 2 - 1) * ext, vy = (1 - (py + 0.5) / S * 2) * ext;
    // ray in the un-spun planet frame (rings, sun and the sphere are spin-invariant)
    const o = toF([vx, vy, 10]), rd = toF([0, 0, -1]);
    let col = [0, 0, 0], alpha = 0;
    const over = (c, a) => { col = [c[0] * a + col[0] * (1 - a), c[1] * a + col[1] * (1 - a), c[2] * a + col[2] * (1 - a)]; alpha = a + alpha * (1 - a); };
    const b2 = vdot(o, o) - vdot(o, rd) ** 2, tca = -vdot(o, rd);
    const tHit = b2 <= 1 ? tca - Math.sqrt(1 - b2) : Infinity;
    let tRing = Infinity, ringC = null;
    if (ring && Math.abs(rd[1]) > 1e-6) {
      const t = -o[1] / rd[1], q = [o[0] + rd[0] * t, 0, o[2] + rd[2] * t], r = Math.hypot(q[0], q[2]), s = t > 0 ? ringA(r) : null;
      if (s && s[3]) {
        // planet shadow on the ring
        const b2s = vdot(q, q) - vdot(q, L) ** 2, lit = vdot(q, L) < 0 && b2s < 1 ? 0.12 : 0.35 + 0.65 * Math.sqrt(Math.abs(L[1]));
        tRing = t; ringC = [[s[0] * lit, s[1] * lit, s[2] * lit], s[3] / 255];
      }
    }
    if (ringC && tHit === Infinity) over(...ringC); // ring against space (a ring behind the planet stays hidden)
    if (tHit < Infinity) {
      const p = [o[0] + rd[0] * tHit, o[1] + rd[1] * tHit, o[2] + rd[2] * tHit], d = vnorm(p);
      const k = texel(d), k4 = k * 4;
      const nO = maps.onormal ? rotY([maps.onormal[k * 3], maps.onormal[k * 3 + 1], maps.onormal[k * 3 + 2]], spin) : d;
      const geo = vdot(d, L), day = smoothstep(-0.06, 0.14, geo), lam = Math.max(0, vdot(nO, L));
      let c = [maps.albedo[k4], maps.albedo[k4 + 1], maps.albedo[k4 + 2]].map((v) => v * (amb + (1 - amb) * lam * day));
      const rough = maps.rough ? maps.rough[k4 + 1] / 255 : 0.9;
      if (rough < 0.4) { const hv = vnorm([L[0] - rd[0], L[1] - rd[1], L[2] - rd[2]]); const sp = Math.pow(Math.max(0, vdot(nO, hv)), 30) * 0.7 * day; c = c.map((v) => v + 255 * sp); }
      if (cl) { const sd = vnorm([d[0] + L[0] * 0.025, d[1] + L[1] * 0.025, d[2] + L[2] * 0.025]); const sa = cl[texel(sd) * 4 + 3] / 255; c = c.map((v) => v * (1 - 0.45 * sa)); }
      if (ring && Math.abs(L[1]) > 1e-4) {
        const t = -d[1] / L[1];
        if (t > 0) { const q = [d[0] + L[0] * t, d[2] + L[2] * t]; const s = ringA(Math.hypot(q[0], q[1])); if (s) c = c.map((v) => v * (1 - 0.75 * s[3] / 255)); }
      }
      if (maps.glow && maps.glow[k4 + 3]) c = c.map((v, i) => v + maps.glow[k4 + i]);
      if (maps.night && maps.night[k4 + 3]) { const nf = 1 - smoothstep(-0.2, 0.05, geo); c = c.map((v, i) => v + maps.night[k4 + i] * nf); }
      over(c, 1);
      if (cl) {
        const rc = 1 + (P.clouds.height ?? 0.012), b2c = b2;
        const tc = b2c <= rc * rc ? tca - Math.sqrt(rc * rc - b2c) : tHit;
        const pc = vnorm([o[0] + rd[0] * tc, o[1] + rd[1] * tc, o[2] + rd[2] * tc]);
        const ck = texel(pc) * 4, ca = cl[ck + 3] / 255;
        if (ca) { const lit = amb + (1 - amb) * Math.max(0, vdot(pc, L)) * smoothstep(-0.06, 0.14, vdot(pc, L)); over([cl[ck] * lit, cl[ck + 1] * lit, cl[ck + 2] * lit], ca); }
      }
    }
    if (A) {
      const Ra = 1 + A.height * 2;
      let f = 0, nrm = null;
      if (tHit < Infinity) { const p = vnorm([o[0] + rd[0] * tHit, o[1] + rd[1] * tHit, o[2] + rd[2] * tHit]); nrm = p; f = Math.pow(1 - Math.max(0, -vdot(p, rd)), A.falloff) * A.density * 0.9; }
      else if (b2 < Ra * Ra) { const b = Math.sqrt(b2), alt = (b - 1) / (Ra - 1); const q = [o[0] + rd[0] * tca, o[1] + rd[1] * tca, o[2] + rd[2] * tca]; nrm = vnorm(q); f = A.density * Math.pow(1 - clamp01(alt), 2.4) * 0.9; }
      if (f > 0) {
        const ndl = vdot(nrm, L), light = smoothstep(-0.25, 0.35, ndl) + 0.4 * Math.pow(Math.max(0, vdot(rd, L)), 6) * (tHit === Infinity ? 1 : 0);
        const ss = 1 - smoothstep(0, 0.45, Math.abs(ndl));
        const ac = A.color.map((v, i) => lerp(v, A.sunset[i], ss * 0.85));
        const add = clamp01(f * light);
        if (tHit < Infinity) col = col.map((v, i) => v + ac[i] * add);
        else { const a2 = clamp01(add * 1.2); col = col.map((v, i) => (alpha ? v + ac[i] * add : ac[i])); alpha = Math.max(alpha, a2); }
      }
    }
    if (ringC && tRing < tHit && tHit < Infinity) over(...ringC);
    const o4 = (py * S + px) * 4;
    out[o4] = col[0]; out[o4 + 1] = col[1]; out[o4 + 2] = col[2]; out[o4 + 3] = Math.round(clamp01(alpha) * 255);
  }
  return { width: S, height: S, data: out };
}

/** Distinct ramp colours of a spec (palette strip / project palette). */
export function specPalette(P) {
  const seen = new Map();
  const add = (c) => seen.set(c.join(','), c);
  if (P.gas) P.gas.ramp.forEach(add);
  for (const b of P.biomes) b.ramp.forEach(add);
  if (P.seams) P.seams.ramp.forEach(add);
  if (P.rings) P.rings.ramp.forEach(add);
  return [...seen.values()];
}

export { dirToCube, cubeDir, equirectDir, dirToEquirect, FACES };
