// Nebula + starfield skyboxes as pixel art: layered domain-warped fbm gas with palette ramps (banded,
// ordered dither), dark dust lanes, an optional galaxy band, stars in brightness / colour classes
// and bright-star sprites. One direction field -> 6 cube faces and / or an equirect, so both agree.
import { mulberry32, bayer } from '../util.js';
import { perlin3, fractal, warp, seedOf, vnorm, vdot, vcross, hexRGB, clamp01, smoothstep, rampPick, equirectDir, dirToEquirect, cubePoint, dirToCube, FACES, texLimit } from './noise.js';

export const SKY_PRESETS = {
  ember: { about: 'warm rose-ember nebula over a violet void', base: '#07050c', layers: [{ ramp: ['#1a0a1e', '#3d1235', '#6e1d40', '#a8334a', '#e0644e', '#ffb07a'], frequency: 1.4, density: 0.55, warp: 0.9 }, { ramp: ['#0d0a24', '#24185a', '#3d2c8a'], frequency: 2.3, density: 0.45, warp: 0.6 }], dust: 0.6, galaxy: { tilt: 28, width: 0.18, color: '#b9a6d8' } },
  tide: { about: 'teal and cobalt gas tides with cold blue stars', base: '#03070c', layers: [{ ramp: ['#04141c', '#06303a', '#0b5560', '#16857e', '#5fd0b0', '#c8ffe8'], frequency: 1.2, density: 0.5, warp: 1 }, { ramp: ['#060a22', '#0f1a4a', '#1f3480', '#4062c0'], frequency: 2, density: 0.5, warp: 0.7 }], dust: 0.45, galaxy: { tilt: -15, width: 0.14, color: '#a8c8ff' } },
  verdigris: { about: 'acid green / amber cloud with deep olive voids', base: '#05060a', layers: [{ ramp: ['#0c1208', '#1d2a0e', '#3a4a12', '#6c7a18', '#b8b02a', '#fff08a'], frequency: 1.6, density: 0.48, warp: 0.8 }, { ramp: ['#120a06', '#3a1a0c', '#6e3414'], frequency: 2.6, density: 0.4, warp: 0.5 }], dust: 0.7, galaxy: false },
  void: { about: 'sparse dark starfield with a faint violet galaxy band', base: '#030308', layers: [{ ramp: ['#06060e', '#0e0c20', '#1c1838', '#2e2650'], frequency: 1.1, density: 0.35, warp: 0.6 }], dust: 0.3, galaxy: { tilt: 40, width: 0.12, color: '#c4b8e8' } },
};
const STAR_CLASSES = [
  { name: 'faint', share: 0.8, size: 1, gain: 0.45 },
  { name: 'mid', share: 0.165, size: 1, gain: 0.85 },
  { name: 'bright', share: 0.03, size: 3, gain: 1 },
  { name: 'brilliant', share: 0.005, size: 7, gain: 1 },
];
const STAR_COLORS = ['#9fbfff', '#cfdcff', '#ffffff', '#fff2c8', '#ffd08a', '#ff9a6a'].map(hexRGB);

/** Normalise a sky spec: preset + overrides. */
export function normSky(a = {}) {
  const preset = a.preset ?? 'ember';
  if (!SKY_PRESETS[preset]) throw new Error(`sky preset must be one of ${Object.keys(SKY_PRESETS).join(', ')}`);
  const p = SKY_PRESETS[preset];
  const s = {
    preset, seed: a.seed ?? 1, base: hexRGB(a.base ?? p.base), dust: Number(a.dust ?? p.dust), dither: a.dither !== false,
    stars: { density: Number(a.stars?.density ?? 1), count: a.stars?.count, sprites: a.stars?.sprites !== false },
    layers: (a.layers ?? p.layers).map((L, i) => {
      if (!L || !Array.isArray(L.ramp)) throw new Error(`layers[${i}] needs ramp:[colours dark -> light]`);
      return { ramp: L.ramp.map(hexRGB), frequency: Number(L.frequency ?? 1.5), density: Number(L.density ?? 0.5), warp: Number(L.warp ?? 0.7), offset: L.offset ?? i * 13.1 };
    }),
  };
  const g = a.galaxy === undefined ? p.galaxy : a.galaxy;
  s.galaxy = g ? { tilt: Number(g.tilt ?? 25), width: Number(g.width ?? 0.15), color: hexRGB(g.color ?? '#c0b0e0'), yaw: Number(g.yaw ?? 0) } : null;
  return s;
}

function gen(S) {
  if (S._g) return S._g;
  const sd = (k) => seedOf(S.seed, k);
  const g = { L: S.layers.map((_, i) => perlin3(sd(100 + i))), w: [perlin3(sd(1)), perlin3(sd(2)), perlin3(sd(3))], dust: perlin3(sd(4)), mask: perlin3(sd(5)) };
  if (S.galaxy) {
    const t = (S.galaxy.tilt * Math.PI) / 180, y = (S.galaxy.yaw * Math.PI) / 180;
    g.gn = vnorm([Math.sin(t) * Math.cos(y), Math.cos(t), Math.sin(t) * Math.sin(y)]);
  }
  Object.defineProperty(S, '_g', { value: g, enumerable: false });
  return g;
}

/** Gas colour (no stars) at a direction, pixel (x, y) for the dither. -> [r, g, b] */
export function skyGas(S, d, x = 0, y = 0) {
  const g = gen(S);
  let c = S.base.slice();
  const band = g.gn ? Math.exp(-((vdot(d, g.gn) / S.galaxy.width) ** 2)) : 0;
  for (let i = 0; i < S.layers.length; i++) {
    const L = S.layers[i], f = L.frequency;
    const p = warp(g.w, d[0] * f + L.offset, d[1] * f, d[2] * f, L.warp, 1.2, 3);
    const n = fractal(g.L[i], p[0], p[1], p[2], { octaves: 5, frequency: 1 });
    const m = 0.5 + 0.5 * fractal(g.mask, d[0] * 0.8 + i, d[1] * 0.8, d[2] * 0.8, { octaves: 2, frequency: 1 });
    let v = clamp01((n * 0.5 + 0.5 - (1 - L.density)) / L.density) * smoothstep(0.3, 0.7, m + band * 0.3);
    if (v <= 0.02) continue;
    const col = rampPick(L.ramp, v, S.dither, x, y);
    // brighter ramp entries cover the darker ones (painterly layering, no smooth blending)
    const k = v > 0.12 ? 1 : v / 0.12;
    c = c.map((cv, j) => Math.max(cv, cv * (1 - k) + col[j] * k));
  }
  if (band > 0.05) {
    const gc = S.galaxy.color, k = band * 0.35;
    const t = S.dither ? (bayer(x, y) - 0.5) * 0.15 : 0;
    const kk = Math.round((k + t) * 6) / 6;
    c = c.map((cv, j) => cv + (gc[j] - cv) * clamp01(kk));
  }
  if (S.dust > 0) {
    const r = fractal(g.dust, d[0] * 2.4, d[1] * 2.4, d[2] * 2.4, { type: 'ridged', octaves: 4, frequency: 1 });
    const lane = smoothstep(0.55, 0.85, r) * S.dust * (0.4 + band);
    if (lane > 0.05) { const q = Math.round(lane * 4) / 4; c = c.map((cv, j) => cv * (1 - q * 0.8) + S.base[j] * q * 0.8); }
  }
  return c;
}

/** Seeded star list: [{d, cls, color, gain}] (more stars inside the galaxy band). */
export function starList(S, faceSize) {
  const g = gen(S), r = mulberry32(seedOf(S.seed, 300));
  const count = Math.round(S.stars.count ?? 6 * faceSize * faceSize * 0.006 * S.stars.density);
  const out = [];
  for (let tries = 0; out.length < count && tries < count * 4; tries++) {
    const z = r() * 2 - 1, t = r() * 2 * Math.PI, q = Math.sqrt(1 - z * z), d = [q * Math.cos(t), z, q * Math.sin(t)];
    const band = g.gn ? Math.exp(-((vdot(d, g.gn) / (S.galaxy.width * 1.5)) ** 2)) : 0;
    if (r() > 0.35 + band * 0.65) continue;
    let u = r(), k = 0;
    while (k < STAR_CLASSES.length - 1 && u > STAR_CLASSES[k].share) { u -= STAR_CLASSES[k].share; k++; }
    out.push({ d, cls: k, color: STAR_COLORS[Math.floor(r() * STAR_COLORS.length)], gain: STAR_CLASSES[k].gain });
  }
  return out;
}
/** Sprite offsets [dx, dy, intensity] for a star class (crisp plus / cross shapes). */
function sprite(cls) {
  if (cls < 2) return [[0, 0, 1]];
  if (cls === 2) return [[0, 0, 1], [1, 0, 0.5], [-1, 0, 0.5], [0, 1, 0.5], [0, -1, 0.5]];
  const s = [[0, 0, 1]];
  for (let k = 1; k <= 3; k++) { const v = k === 1 ? 0.8 : k === 2 ? 0.5 : 0.25; s.push([k, 0, v], [-k, 0, v], [0, k, v], [0, -k, v]); }
  s.push([1, 1, 0.3], [-1, 1, 0.3], [1, -1, 0.3], [-1, -1, 0.3]);
  return s;
}

/** Bake the 6 faces (S x S each, OpenGL / three.js order px nx py ny pz nz). */
export function bakeSkyFaces(S, size) {
  texLimit(size, size, 'skybox face');
  const faces = FACES.map((_, f) => {
    const data = new Uint8ClampedArray(size * size * 4);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const d = vnorm(cubePoint(f, (2 * (x + 0.5)) / size - 1, (2 * (y + 0.5)) / size - 1));
      const c = skyGas(S, d, x, y), o = (y * size + x) * 4;
      data[o] = c[0]; data[o + 1] = c[1]; data[o + 2] = c[2]; data[o + 3] = 255;
    }
    return data;
  });
  const stars = starList(S, size);
  // each sprite texel is placed by direction (offset in the star's face plane, re-projected), so
  // sprites crossing a cube edge continue on the neighbouring face
  for (const st of stars) {
    const c = dirToCube(st.d), sc = c.s * 2 - 1, tc = c.t * 2 - 1;
    for (const [dx, dy, k] of S.stars.sprites ? sprite(st.cls) : [[0, 0, 1]]) {
      const d = vnorm(cubePoint(c.face, sc + (2 * dx) / size, tc + (2 * dy) / size));
      const q = dirToCube(d), x = Math.min(size - 1, Math.floor(q.s * size)), y = Math.min(size - 1, Math.floor(q.t * size)), o = (y * size + x) * 4;
      const a = st.gain * k, img = faces[q.face];
      for (let j = 0; j < 3; j++) img[o + j] = Math.max(img[o + j], img[o + j] * (1 - a) + st.color[j] * a);
    }
  }
  return { faces, stars: stars.length };
}
/** Bake an equirect (W x W/2) from the same field + star list. */
export function bakeSkyEquirect(S, W, faceSize = W / 2) {
  const H = W / 2;
  texLimit(W, H, 'skybox equirect');
  const data = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const d = equirectDir((x + 0.5) / W, 1 - (y + 0.5) / H), c = skyGas(S, d, x, y), o = (y * W + x) * 4;
    data[o] = c[0]; data[o + 1] = c[1]; data[o + 2] = c[2]; data[o + 3] = 255;
  }
  for (const st of starList(S, faceSize)) {
    const [u, v] = dirToEquirect(st.d), x0 = Math.floor(u * W), y0 = Math.floor((1 - v) * H);
    for (const [dx, dy, k] of S.stars.sprites ? sprite(st.cls) : [[0, 0, 1]]) {
      const x = (((x0 + dx) % W) + W) % W, y = y0 + dy;
      if (y < 0 || y >= H) continue;
      const o = (y * W + x) * 4, a = st.gain * k;
      for (let j = 0; j < 3; j++) data[o + j] = Math.max(data[o + j], data[o + j] * (1 - a) + st.color[j] * a);
    }
  }
  return data;
}
/** Horizontal-cross preview of 6 faces (each downsampled to `cell` px). */
export function crossPreview(faces, size, cell = 128) {
  const W = cell * 4, H = cell * 3, out = new Uint8ClampedArray(W * H * 4);
  // layout:     [py]
  //        [nx][pz][px][nz]
  //             [ny]
  const at = { 2: [1, 0], 1: [0, 1], 4: [1, 1], 0: [2, 1], 5: [3, 1], 3: [1, 2] };
  for (const [f, [cx, cy]] of Object.entries(at)) {
    const img = faces[f];
    for (let y = 0; y < cell; y++) for (let x = 0; x < cell; x++) {
      const s = (Math.floor((y * size) / cell) * size + Math.floor((x * size) / cell)) * 4;
      out.set(img.subarray(s, s + 4), ((cy * cell + y) * W + cx * cell + x) * 4);
    }
  }
  return { width: W, height: H, data: out };
}
export { vcross };
