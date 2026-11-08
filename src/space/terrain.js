// Ground terrain that matches its planet: a landing-zone patch sampled from the planet field at
// (lat, lon) in a local tangent frame (+X east, +Z south, +Y up, metres), plus ground detail noise,
// mesas / escarpments, slope + height + biome splat layers drawn from pixel tilesets, seeded
// instanced props (rocks, crystals, grass cards) and rock formations (arches) for colony anchors.
// Heights at the patch come from the same heightAt() as the orbit maps (see test: height match).
import { mulberry32, bayer } from '../util.js';
import { perlin3, fractal, seedOf, vnorm, vcross, equirectDir, smoothstep, clamp01, shiftColor, texLimit, r4 } from './noise.js';
import { elevKm, field, biomeOf } from './planet.js';
import { makeTile } from './tiles.js';

const D2R = Math.PI / 180;
/** Unit direction for latitude / longitude (deg), equirect convention of the planet maps. */
export const latLonDir = (lat, lon) => equirectDir(lon / 360 + 0.5, lat / 180 + 0.5);

/** Local frame at a direction: up, east (+X), north (-Z). */
export function localFrame(d) {
  const lat = Math.asin(d[1]), lon = Math.atan2(d[2], d[0]);
  // d/dlon of equirectDir = (-sin lon, 0, cos lon); d/dlat = (-sin lat cos lon, cos lat, -sin lat sin lon)
  let east = [-Math.sin(lon), 0, Math.cos(lon)];
  const north = vnorm([-Math.sin(lat) * Math.cos(lon), Math.cos(lat), -Math.sin(lat) * Math.sin(lon)]);
  if (Math.abs(d[1]) > 0.9999) east = [1, 0, 0];
  return { up: d, east: vnorm(east), north };
}

/** Terrain layers (splat RGBA = ground, rock, low, accent) per planet preset: tile kinds + ramps. */
function layerSpec(P, centre) {
  const b = biomeOf(P, centre), water = P.biomes.find((x) => x.where.water) || null;
  const find = (...names) => P.biomes.find((x) => names.includes(x.name));
  const dark = (r) => r.map((c) => shiftColor(c, 0, 0.9, 0.72));
  const light = (r) => r.map((c) => shiftColor(c, 0, 1.05, 1.18));
  const groundKind = { desert: 'ripple', ice: 'snow', bloom: 'moss', toxic: 'ground', lava: 'ground', barren: 'ground' }[P.preset] || 'ground';
  const rock = find('mesa', 'highland', 'peaks', 'ash', 'basalt');
  const ground = b.where.water ? (find('regolith', 'rust', 'forest', 'pack', 'basalt', 'highland') || b) : b;
  return [
    { name: 'ground', kind: groundKind, ramp: ground.ramp },
    { name: 'rock', kind: 'rock', ramp: rock && rock !== ground ? rock.ramp : dark(ground.ramp) },
    { name: 'low', kind: P.preset === 'lava' ? 'glow' : 'crack', ramp: water ? water.ramp : dark(ground.ramp), glow: P.preset === 'lava' ? [255, 120, 30] : null },
    { name: 'accent', kind: P.preset === 'bloom' ? 'moss' : P.preset === 'ice' ? 'crack' : 'ground', ramp: light(ground.ramp) },
  ];
}

const PROP_DEFAULTS = {
  desert: { rocks: 140, grass: 90, crystals: 0, arches: 1, mesas: 2, cliffs: 1 },
  ice: { rocks: 90, grass: 0, crystals: 40, arches: 0, mesas: 1, cliffs: 1 },
  toxic: { rocks: 110, grass: 0, crystals: 60, arches: 1, mesas: 2, cliffs: 0 },
  bloom: { rocks: 70, grass: 220, crystals: 0, arches: 0, mesas: 1, cliffs: 0 },
  lava: { rocks: 160, grass: 0, crystals: 30, arches: 0, mesas: 1, cliffs: 1 },
  barren: { rocks: 180, grass: 0, crystals: 0, arches: 0, mesas: 1, cliffs: 0 },
};

/**
 * Normalise terrain options. o: {lat, lon (deg), size m (512), grid (cells, 128), chunks (4),
 * lods ([1, 2, 4] vertex steps), texel m (0.5), tile_px (32), detail {amplitude m, wavelength m,
 * octaves}, mesas, cliffs, arches, rocks, grass, crystals (counts or false), seed, skirt m}
 */
export function normTerrain(P, o = {}) {
  if (P.gas) throw new Error('terrain: a gas giant has no ground (use a rocky or icy planet / moon)');
  const def = PROP_DEFAULTS[P.preset] || PROP_DEFAULTS.barren;
  const t = {
    lat: Number(o.lat ?? 12), lon: Number(o.lon ?? 30), size: Number(o.size ?? 512), grid: Math.round(Number(o.grid ?? 128)), chunks: Math.round(Number(o.chunks ?? 4)),
    lods: o.lods ?? [1, 2, 4], texel: Number(o.texel ?? 0.5), tile_px: Math.round(Number(o.tile_px ?? 32)), seed: o.seed ?? P.seed,
    detail: { amplitude: 14, wavelength: 260, octaves: 5, ...(o.detail || {}) }, skirt: Number(o.skirt ?? 4),
  };
  for (const k of ['mesas', 'cliffs', 'arches', 'rocks', 'grass', 'crystals']) t[k] = o[k] === false ? 0 : Math.max(0, Math.round(Number(o[k] ?? def[k])));
  if (!(Math.abs(t.lat) <= 89.9)) throw new Error('lat must be -89.9..89.9 deg');
  if (!(t.size >= 16 && t.size <= 8192)) throw new Error('size must be 16..8192 m');
  if (!(t.chunks >= 1 && t.chunks <= 16)) throw new Error('chunks must be 1..16');
  if (!Array.isArray(t.lods) || t.lods[0] !== 1 || t.lods.some((s, i) => !(Number.isInteger(s) && s >= 1 && (i === 0 || s > t.lods[i - 1])))) throw new Error('lods must be increasing vertex steps starting at 1, e.g. [1, 2, 4]');
  const cg = t.grid / t.chunks;
  if (!(Number.isInteger(cg) && cg % t.lods[t.lods.length - 1] === 0)) throw new Error(`grid (${t.grid}) / chunks (${t.chunks}) must be a whole number divisible by the largest LOD step ${t.lods[t.lods.length - 1]}`);
  if (t.grid > 512) throw new Error('grid must be <= 512 cells');
  const px = Math.round(t.size / t.chunks / t.texel);
  texLimit(px, px, `terrain chunk texture (size / chunks / texel = ${px})`);
  return t;
}

/** Height function of a patch: {at(x, z) -> m (relative to the patch centre), base (m), planet(x, z), detail(x, z), dir(x, z)} */
export function patchHeight(P, t) {
  const d0 = latLonDir(t.lat, t.lon), F = localFrame(d0), Rm = P.real_radius_km * 1000;
  const dir = (x, z) => vnorm([d0[0] * Rm + F.east[0] * x - F.north[0] * z, d0[1] * Rm + F.east[1] * x - F.north[1] * z, d0[2] * Rm + F.east[2] * x - F.north[2] * z]);
  const E0 = elevKm(P, d0) * 1000;
  // the planet field barely changes over a patch: sample it on a coarse grid, bilinear in between
  const G = 16, half = t.size / 2, coarse = new Float64Array((G + 1) * (G + 1));
  for (let j = 0; j <= G; j++) for (let i = 0; i <= G; i++) coarse[j * (G + 1) + i] = elevKm(P, dir(-half + (i / G) * t.size, -half + (j / G) * t.size)) * 1000 - E0;
  const planet = (x, z) => {
    const fx = clamp01((x + half) / t.size) * G, fz = clamp01((z + half) / t.size) * G;
    const i = Math.min(G - 1, Math.floor(fx)), j = Math.min(G - 1, Math.floor(fz)), u = fx - i, v = fz - j;
    const a = coarse[j * (G + 1) + i], b = coarse[j * (G + 1) + i + 1], c = coarse[(j + 1) * (G + 1) + i], d = coarse[(j + 1) * (G + 1) + i + 1];
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  };
  const nd = perlin3(seedOf(P.seed, 201)), nr = perlin3(seedOf(P.seed, 202)), D = t.detail;
  // ground detail: global (direction-based) noise in metres, so neighbouring patches agree
  const detail = D.amplitude > 0 ? (x, z) => {
    const q = dir(x, z), k = Rm / D.wavelength;
    const a = fractal(nd, q[0] * k, q[1] * k, q[2] * k, { octaves: D.octaves, frequency: 1 });
    const r = fractal(nr, q[0] * k * 0.7, q[1] * k * 0.7, q[2] * k * 0.7, { type: 'ridged', octaves: 3, frequency: 1 });
    return D.amplitude * (a * 0.8 + (r - 0.5) * 0.6);
  } : () => 0;
  // features (patch-local, seeded): mesas (flat terraced tops), escarpments
  const r = mulberry32(seedOf(t.seed, 203)), nf = perlin3(seedOf(t.seed, 204));
  const mesas = [];
  for (let i = 0; i < t.mesas; i++) {
    const ang = r() * Math.PI * 2, dist = t.size * (0.18 + r() * 0.22);
    const rad = t.size * (0.07 + r() * 0.06);
    mesas.push({ x: Math.cos(ang) * dist, z: Math.sin(ang) * dist, r: rad, h: rad * (0.35 + r() * 0.3), terraces: 2 + Math.floor(r() * 2) });
  }
  const cliffs = [];
  for (let i = 0; i < t.cliffs; i++) { const a = r() * Math.PI; cliffs.push({ n: [Math.cos(a), Math.sin(a)], off: (r() - 0.5) * t.size * 0.5 + t.size * 0.3 * (r() < 0.5 ? -1 : 1), h: 8 + r() * 14 }); }
  for (const m of mesas) m.base = planet(m.x, m.z) + detail(m.x, m.z);
  const features = (x, z, y) => {
    for (const c of cliffs) {
      const s = x * c.n[0] + z * c.n[1] - c.off + 14 * fractal(nf, x / 90, z / 90, 0.5, { octaves: 2 });
      const k = smoothstep(-3, 3, s);
      y += c.h * (Math.round(k * 2) / 2 * 0.3 + k * 0.7);
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
  const at = (x, z) => features(x, z, planet(x, z) + detail(x, z));
  return { at, base: E0, planet, detail, dir, frame: F, d0, mesas, cliffs };
}

/** Splat weights (ground, rock, low, accent) summing to exactly 255. */
export function splatWeights(slope, hrel, patch) {
  const rock = smoothstep(0.45, 0.85, slope);
  const low = smoothstep(0.14, 0.03, hrel) * (1 - rock);
  const acc = smoothstep(0.55, 0.7, patch) * (1 - rock) * (1 - low);
  const ground = Math.max(0, 1 - rock - low - acc);
  const w = [ground, rock, low, acc], s = w[0] + w[1] + w[2] + w[3] || 1;
  // largest-remainder rounding: the four bytes always sum to 255
  const raw = w.map((v) => (v / s) * 255), q = raw.map(Math.floor);
  let rest = 255 - q.reduce((a, b) => a + b, 0);
  const order = raw.map((v, i) => [v - q[i], i]).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (let k = 0; rest > 0; k = (k + 1) % 4, rest--) q[order[k][1]]++;
  return q;
}

/**
 * Build a patch: heights grid, splat map, layer tiles, chunk meshes (LODs + skirts + collision),
 * scatter instances and formation placements. Texture objects follow model3d / glb conventions.
 */
export function buildTerrain(P, t, { makeChunkTex } = {}) {
  const H = patchHeight(P, t), N = t.grid, step = t.size / N, half = t.size / 2;
  const V = N + 1, h = new Float32Array(V * V);
  for (let j = 0; j < V; j++) for (let i = 0; i < V; i++) h[j * V + i] = H.at(-half + i * step, -half + j * step);
  let lo = Infinity, hi = -Infinity;
  for (const v of h) { if (v < lo) lo = v; if (v > hi) hi = v; }
  const hAt = (i, j) => h[Math.max(0, Math.min(N, j)) * V + Math.max(0, Math.min(N, i))];
  const slopeAt = (i, j) => Math.hypot((hAt(i + 1, j) - hAt(i - 1, j)) / (2 * step), (hAt(i, j + 1) - hAt(i, j - 1)) / (2 * step));
  const nrmAt = (i, j) => vnorm([-(hAt(i + 1, j) - hAt(i - 1, j)) / (2 * step), 1, -(hAt(i, j + 1) - hAt(i, j - 1)) / (2 * step)]);
  // splat (grid resolution)
  const np = perlin3(seedOf(t.seed, 210));
  const splat = new Uint8ClampedArray(V * V * 4);
  for (let j = 0; j < V; j++) for (let i = 0; i < V; i++) {
    const x = -half + i * step, z = -half + j * step;
    const patch = 0.5 + 0.6 * fractal(np, x / 40, z / 40, 0.5, { octaves: 3 });
    splat.set(splatWeights(slopeAt(i, j), (h[j * V + i] - lo) / (hi - lo || 1), patch), (j * V + i) * 4);
  }
  const centre = field(P, H.d0);
  const layers = layerSpec(P, centre).map((L, k) => ({ ...L, tile: makeTile(L.kind, L.ramp, { size: t.tile_px, seed: seedOf(t.seed, 220 + k), glow: L.glow }) }));
  // chunk albedo: per texel, the layer is picked by ordered dither against the bilinear splat weights
  const cn = t.chunks, cg = N / cn, cm = t.size / cn, px = Math.round(cm / t.texel);
  const splatAt = (x, z) => {
    const fx = clamp01((x + half) / t.size) * N, fz = clamp01((z + half) / t.size) * N;
    const i = Math.min(N - 1, Math.floor(fx)), j = Math.min(N - 1, Math.floor(fz)), u = fx - i, v = fz - j;
    const w = [0, 0, 0, 0];
    for (const [ii, jj, k] of [[i, j, (1 - u) * (1 - v)], [i + 1, j, u * (1 - v)], [i, j + 1, (1 - u) * v], [i + 1, j + 1, u * v]]) for (let c = 0; c < 4; c++) w[c] += splat[(jj * V + ii) * 4 + c] * k;
    return w;
  };
  const chunkTex = (cx, cz) => {
    const data = new Uint8ClampedArray(px * px * 4);
    let em = null;
    for (let y = 0; y < px; y++) for (let x = 0; x < px; x++) {
      const wx = -half + cx * cm + (x + 0.5) * t.texel, wz = -half + cz * cm + (y + 0.5) * t.texel;
      const w = splatAt(wx, wz), thr = bayer(x, y) * 255;
      let acc = 0, li = 0;
      for (let c = 0; c < 4; c++) { acc += w[c]; if (thr < acc) { li = c; break; } li = c; }
      const T = layers[li].tile, gx = Math.floor((wx + half) / t.texel), gz = Math.floor((wz + half) / t.texel);
      const s = ((((gz % T.height) + T.height) % T.height) * T.width + (((gx % T.width) + T.width) % T.width)) * 4;
      data.set(T.data.subarray(s, s + 4), (y * px + x) * 4);
      if (T.emissive && T.emissive[s + 3]) { em = em || new Uint8ClampedArray(px * px * 4); em.set(T.emissive.subarray(s, s + 4), (y * px + x) * 4); }
    }
    return makeChunkTex ? makeChunkTex(cx, cz, { width: px, height: px, data, emissive: em }) : { key: `terrain_${cx}_${cz}`, name: `terrain_${cx}_${cz}`, width: px, height: px, data, ...(em ? { emissive: em } : {}) };
  };
  // chunk meshes: LOD vertex steps over the global grid (shared edges -> no cracks at equal LOD), skirts
  const chunkGroup = (tex, cx, cz, s, skirt) => {
    const g = { tex, pos: [], nrm: [], uv: [], idx: [] }, n = cg / s, i0 = cx * cg, j0 = cz * cg;
    const vid = (a, b) => b * (n + 1) + a;
    for (let b = 0; b <= n; b++) for (let a = 0; a <= n; a++) {
      const i = i0 + a * s, j = j0 + b * s, nn = nrmAt(i, j);
      g.pos.push(-half + i * step, hAt(i, j), -half + j * step); g.nrm.push(nn[0], nn[1], nn[2]); g.uv.push(a / n, b / n);
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
  // geometric error of a LOD step: max |true height - bilinear of the coarse grid|
  const lodError = (s) => {
    let e = 0;
    for (let j = 0; j < N; j += 1) for (let i = 0; i < N; i += 1) {
      const a = Math.floor(i / s) * s, b = Math.floor(j / s) * s, u = (i - a) / s, v = (j - b) / s;
      const y = hAt(a, b) * (1 - u) * (1 - v) + hAt(a + s, b) * u * (1 - v) + hAt(a, b + s) * (1 - u) * v + hAt(a + s, b + s) * u * v;
      e = Math.max(e, Math.abs(y - h[j * V + i]));
    }
    return e;
  };
  const lodErr = t.lods.map((s) => (s === 1 ? 0 : lodError(s)));
  const chunks = [];
  for (let cz = 0; cz < cn; cz++) for (let cx = 0; cx < cn; cx++) {
    const tex = chunkTex(cx, cz);
    chunks.push({ cx, cz, tex, lods: t.lods.map((s) => chunkGroup(tex, cx, cz, s, t.skirt)), collision: chunkGroup({ key: 'collision', name: 'collision', width: 1, height: 1, data: Uint8ClampedArray.from([255, 0, 255, 255]) }, cx, cz, t.lods[t.lods.length - 1], 0) });
  }
  // ---- scatter (seeded, exact counts where the rules allow)
  const rr = mulberry32(seedOf(t.seed, 230));
  const heightAt = (x, z) => {
    const fx = clamp01((x + half) / t.size) * N, fz = clamp01((z + half) / t.size) * N;
    const i = Math.min(N - 1, Math.floor(fx)), j = Math.min(N - 1, Math.floor(fz)), u = fx - i, v = fz - j;
    return hAt(i, j) * (1 - u) * (1 - v) + hAt(i + 1, j) * u * (1 - v) + hAt(i, j + 1) * (1 - u) * v + hAt(i + 1, j + 1) * u * v;
  };
  const weightsAt = (x, z) => splatAt(x, z).map((v) => v / 255);
  const quatY = (a) => [0, Math.sin(a / 2), 0, Math.cos(a / 2)];
  const quatTilt = (yaw, tx, tz) => {
    // yaw then a small tilt about X and Z
    const q1 = quatY(yaw), qx = [Math.sin(tx / 2), 0, 0, Math.cos(tx / 2)], qz = [0, 0, Math.sin(tz / 2), Math.cos(tz / 2)];
    const mul = (a, b) => [a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1], a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0], a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3], a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]];
    return mul(mul(qz, qx), q1);
  };
  const scatter = { rocks: [], crystals: [], grass: [] }, requested = { rocks: t.rocks, crystals: t.crystals, grass: t.grass };
  const margin = 2;
  const rules = {
    rocks: (w) => rr() < 0.25 + w[1] * 0.75 + w[3] * 0.3,
    crystals: (w) => w[2] + w[1] > 0.15 || rr() < 0.08,
    grass: (w, s) => s < 0.45 && w[1] < 0.3 && w[2] < 0.5,
  };
  for (const kind of ['rocks', 'crystals', 'grass']) {
    const want = requested[kind];
    for (let tries = 0; scatter[kind].length < want && tries < want * 60; tries++) {
      const x = -half + margin + rr() * (t.size - 2 * margin), z = -half + margin + rr() * (t.size - 2 * margin);
      const i = Math.round((x + half) / step), j = Math.round((z + half) / step), s = slopeAt(i, j), w = weightsAt(x, z);
      if (!rules[kind](w, s)) continue;
      const scale = kind === 'rocks' ? 0.4 + Math.pow(rr(), 2.5) * 2.2 : kind === 'crystals' ? 0.6 + rr() * 1.2 : 0.7 + rr() * 0.6;
      const yaw = rr() * Math.PI * 2;
      const rot = kind === 'grass' ? quatY(yaw) : quatTilt(yaw, (rr() - 0.5) * 0.4, (rr() - 0.5) * 0.4);
      scatter[kind].push({ p: [r4(x), r4(heightAt(x, z)), r4(z)], r: rot.map(r4), s: r4(scale), v: Math.floor(rr() * 4) });
    }
  }
  // ---- formations (arches) on gentle ground, away from mesas
  const forms = [];
  for (let tries = 0; forms.length < t.arches && tries < 400; tries++) {
    const x = (rr() - 0.5) * t.size * 0.7, z = (rr() - 0.5) * t.size * 0.7;
    if (H.mesas.some((m) => Math.hypot(x - m.x, z - m.z) < m.r * 1.6)) continue;
    if (Math.abs(x) < t.size * 0.12 && Math.abs(z) < t.size * 0.12) continue; // keep the landing pad clear
    const i = Math.round((x + half) / step), j = Math.round((z + half) / step);
    if (slopeAt(i, j) > 0.35) continue;
    forms.push({ kind: 'arch', p: [r4(x), r4(heightAt(x, z) - 1), r4(z)], yaw: r4(rr() * 360), size: r4(t.size * (0.06 + rr() * 0.04)) });
  }
  const anchors = [
    { kind: 'landing_pad', p: [0, r4(heightAt(0, 0)), 0], radius: r4(t.size * 0.08), slope: r4(slopeAt(N / 2, N / 2)) },
    ...H.mesas.map((m) => ({ kind: 'mesa_top', p: [r4(m.x), r4(m.base + m.h), r4(m.z)], radius: r4(m.r * 0.75) })),
    ...forms.map((f) => ({ kind: 'arch', p: f.p, span: f.size, yaw: f.yaw })),
  ];
  return { H, heights: h, lo, hi, splat, layers, chunks, lodErr, scatter, requested, forms, anchors, px, cm, step, centreBiome: biomeOf(P, centre).name };
}
export { D2R, vcross };
