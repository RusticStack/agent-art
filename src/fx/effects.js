// Combat-FX generators: muzzle flashes, tracers, casings, impacts, decals, explosions, smoke, fire,
// sparks, steam, strobes, heat haze, particle cells. Each type = {variants, defaults, ramps, build
// (seeded particle set, made once), frame (fields at time t), meta (engine hints)}. Frames are pure
// functions of (options, seed, t): same input -> byte-identical sheets. Loop types are periodic in t
// (particle ages wrap with frac, flicker uses integer harmonics), so t = 1 matches t = 0.
import {
  heatRamp, matterRamp, glow, puff, streak, mline, ring, poly, bolt, emit, matter,
  mulberry32, seedOf, hash3, clamp01, lerp, smooth01, frac, bayer,
} from './raster.js';
import { tileFbm } from '../space/tiles.js';

const TAU = Math.PI * 2, rad = (d) => (d * Math.PI) / 180;
const rnd = (o, salt) => mulberry32(seedOf(o.seed, salt));
const range = (r, a, b) => a + (b - a) * r();
const life = (t, t0, L) => (t - t0) / L; // age 0..1 while alive
const alive = (a) => a >= 0 && a <= 1;

// ---------- palettes (hue-shifted ramps; `hue` option rotates emission) ----------
export const HUES = { fire: 28, spark: 40, energy: 190, plasma: 286, emp: 214, green: 120, red: 4, amber: 36, blue: 216 };
const E = (o, key, opts) => heatRamp(HUES[key] + (o.hue || 0), opts);
export const MATTER = {
  smoke: '#5e5e66', smoke_light: '#9a9aa2', concrete: '#8a847a', stone: '#6e665c', chips: '#5a544c', dirt: '#6a4c34', sand: '#b4966a',
  glass: '#9ed2e2', water: '#5a88b0', blood: '#6e1820', brass: '#b0863a', hull: '#9a2c26', steel: '#6a6e78', steam: '#c4c8cc', soot: '#2c2a2c',
};
const M = (name, opts) => matterRamp(MATTER[name] ?? name, opts);

// ---------- weapon classes ----------
// len/wid = flame length / width (fraction of the cell), prongs = flash-hider spikes (front + fp),
// diamonds = shock diamonds along the side flame, brake = muzzle-brake side jets.
export const WEAPONS = {
  pistol: { cell: 24, len: 0.5, wid: 0.34, prongs: 4, diamonds: 0, sound: 'gunshot_pistol', light: [1.0, 2.5], shake: 1.5, size_m: 0.25 },
  smg: { cell: 32, len: 0.56, wid: 0.3, prongs: 4, diamonds: 1, sound: 'gunshot_smg', light: [1.2, 3], shake: 1.2, size_m: 0.35 },
  rifle: { cell: 40, len: 0.72, wid: 0.28, prongs: 3, diamonds: 2, sound: 'gunshot_rifle', light: [2, 4], shake: 2.5, size_m: 0.5 },
  dmr: { cell: 40, len: 0.8, wid: 0.24, prongs: 3, diamonds: 2, sound: 'gunshot_marksman', light: [2.2, 4.5], shake: 3.5, size_m: 0.55 },
  shotgun: { cell: 40, len: 0.6, wid: 0.5, prongs: 6, diamonds: 0, pellets: 7, sound: 'gunshot_shotgun', light: [2.5, 5], shake: 5, size_m: 0.55 },
  lmg: { cell: 48, len: 0.78, wid: 0.32, prongs: 5, diamonds: 2, sound: 'gunshot_lmg', light: [2.2, 4.5], shake: 2.2, size_m: 0.6 },
  sniper: { cell: 56, len: 0.62, wid: 0.26, prongs: 2, diamonds: 1, brake: true, sound: 'gunshot_marksman', light: [3, 6], shake: 6, size_m: 0.8 },
  launcher: { cell: 64, len: 0.42, wid: 0.5, prongs: 8, diamonds: 0, smoke: 1, sound: 'fire_burst', light: [3, 6], shake: 7, size_m: 1.2 },
  energy: { cell: 40, len: 0.6, wid: 0.22, prongs: 0, energy: 'energy', sound: 'laser_bolt', light: [1.6, 4], shake: 1.2, size_m: 0.45 },
  plasma: { cell: 48, len: 0.5, wid: 0.36, prongs: 0, energy: 'plasma', sound: 'plasma_shot', light: [2.4, 5], shake: 2.5, size_m: 0.6 },
};
const LIGHT_HEX = { fire: '#ffc070', spark: '#ffe0a0', energy: '#80e8ff', plasma: '#d080ff', emp: '#a0c8ff' };
export const FP_FRAME = [384, 216];
export const FP_MUZZLE = [262, 150]; // typical fp muzzle anchor (fp v2 frame, right-handed carry)

// ---------- surfaces ----------
export const SURFACES = {
  metal: { blend: 'premultiplied', flash: 0.8, sparks: 16, ricochet: 1, dust: 2, dustc: 'steel', sound: ['ricochet', 'hit_light'], decal: 'bullet_metal' },
  concrete: { blend: 'premultiplied', flash: 0.35, sparks: 2, dust: 7, dustc: 'concrete', chips: 7, chipc: 'chips', sound: ['hit_heavy'], decal: 'bullet_concrete' },
  stone: { blend: 'premultiplied', flash: 0.3, sparks: 3, dust: 5, dustc: 'stone', chips: 10, chipc: 'stone', sound: ['hit_heavy'], decal: 'bullet_concrete' },
  glass: { blend: 'premultiplied', flash: 0.25, sparks: 0, dust: 2, dustc: 'glass', shards: 10, glint: 1, sound: ['hit_light'], decal: 'bullet_glass' },
  dirt: { blend: 'alpha', flash: 0, dust: 8, dustc: 'dirt', chips: 9, chipc: 'dirt', plume: 1, sound: ['hit_light'], decal: 'bullet_dirt' },
  sand: { blend: 'alpha', flash: 0, dust: 9, dustc: 'sand', chips: 5, chipc: 'sand', plume: 0.7, sound: ['hit_light'], decal: 'bullet_dirt' },
  water: { blend: 'alpha', flash: 0, splash: 1, sound: ['hit_light'], decal: null },
  flesh: { blend: 'alpha', flash: 0, mist: 1, sound: ['flesh_squelch'], decal: 'blood' },
  armor: { blend: 'premultiplied', flash: 1, sparks: 14, deflect: 1, dust: 1, dustc: 'steel', sound: ['ricochet', 'hit_heavy'], decal: 'bullet_armor' },
  shield: { blend: 'additive', hex: 1, sound: ['shield_hit'], decal: null },
  electronics: { blend: 'premultiplied', flash: 0.5, sparks: 8, arc: 1, dust: 2, dustc: 'soot', sound: ['glitch_tear', 'hit_light'], decal: 'bullet_electronics' },
};

// ---------- shared pieces ----------
/** Seeded spark set (cone around angle `dir`, deg; 0 = right, -90 = up). */
function sparkSet(r, n, { dir = -90, cone = 70, speed = [0.5, 1.1], life = [0.35, 0.8], delay = 0.12, g = 0.9 } = {}) {
  return Array.from({ length: n }, () => {
    const a = rad(dir + (r() - 0.5) * cone * 2), s = range(r, ...speed);
    return { vx: Math.cos(a) * s, vy: Math.sin(a) * s, L: range(r, ...life), t0: r() * delay, g: g * range(r, 0.7, 1.3), w: r() < 0.25 ? 2 : 1 };
  });
}
function drawSparks(F, set, t, ox, oy, scale, v = 1.2, k = 0) {
  for (const p of set) {
    const a = life(t, p.t0, p.L);
    if (!alive(a)) continue;
    const T = a * p.L, T0 = Math.max(0, T - 0.06), pos = (tt) => [ox + p.vx * tt * scale, oy + (p.vy * tt + 0.5 * p.g * tt * tt) * scale];
    const [x1, y1] = pos(T), [x0, y0] = pos(T0);
    streak(F, x0, y0, x1, y1, p.w, v * (1 - a) * 0.6, v * (1 - a) ** 0.8, k);
  }
}
function puffSet(r, n, { dir = -90, cone = 60, speed = [0.15, 0.4], r0 = [1, 2], r1 = [4, 8], life = [0.6, 1], delay = 0.1 } = {}) {
  return Array.from({ length: n }, () => {
    const a = rad(dir + (r() - 0.5) * cone * 2), s = range(r, ...speed);
    return { vx: Math.cos(a) * s, vy: Math.sin(a) * s, r0: range(r, ...r0), r1: range(r, ...r1), L: range(r, ...life), t0: r() * delay, d: range(r, 0.8, 1.2) };
  });
}
function drawPuffs(F, set, t, ox, oy, scale, { m = 0, dens = 1, under = 0, rise = 0 } = {}) {
  for (const p of set) {
    const a = life(t, p.t0, p.L);
    if (!alive(a)) continue;
    const ease = 1 - (1 - a) ** 2.4, x = ox + p.vx * ease * scale, y = oy + p.vy * ease * scale - rise * a * scale;
    puff(F, x, y, lerp(p.r0, p.r1, ease), dens * p.d * smooth01(a / 0.12) * (1 - a) ** 1.3, { m, under });
  }
}
function chipSet(r, n, { dir = -90, cone = 55, speed = [0.6, 1.2], g = 1.6, life = [0.5, 0.9] } = {}) {
  return Array.from({ length: n }, () => {
    const a = rad(dir + (r() - 0.5) * cone * 2), s = range(r, ...speed);
    return { vx: Math.cos(a) * s, vy: Math.sin(a) * s, g, L: range(r, ...life), t0: r() * 0.08, sz: r() < 0.3 ? 2 : 1, l: r() };
  });
}
function drawChips(F, set, t, ox, oy, scale, m = 1) {
  for (const p of set) {
    const a = life(t, p.t0, p.L);
    if (!alive(a)) continue;
    const T = a * p.L, x = ox + p.vx * T * scale, y = oy + (p.vy * T + 0.5 * p.g * T * T) * scale;
    for (let j = 0; j < p.sz; j++) for (let i = 0; i < p.sz; i++) matter(F, x + i, y + j, 2, j ? 0.2 : p.l * 0.8 + 0.2, m);
  }
}
/** Periodic flicker in 0..1 (integer harmonics of t: loops close exactly). */
const flick = (t, ph, k = [3, 5, 7]) => 0.5 + (Math.sin(TAU * (k[0] * t + ph)) * 0.5 + Math.sin(TAU * (k[1] * t + ph * 2.3)) * 0.3 + Math.sin(TAU * (k[2] * t + ph * 3.1)) * 0.2) * 0.5;

// =====================================================================================
// muzzle
// =====================================================================================
function muzzleSide(F, o, st, t) {
  const W = WEAPONS[o.variant], { W: CW, H: CH } = F, cy = CH / 2, px = 1;
  const sup = o.suppressed, I = (0.08 + 0.92 * (1 - t) ** 1.7) * (sup ? 0.55 : 1);
  const Lt = CW * W.len * (0.85 + 0.35 * Math.sqrt(t)) * (sup ? 0.24 : 1), Wt = CH * W.wid * (0.9 + 0.3 * t) * (sup ? 0.6 : 1);
  if (W.energy) {
    // charged bolt leaving the emitter: hot core ellipse + emitter ring (seen edge-on) + wisps
    glow(F, px + 2, cy, Wt * 0.55 * (1 - t * 0.5), I * 1.4);
    for (let x = 0; x < Lt; x++) { const v = I * (1 - x / Lt) ** 0.6; emit(F, px + x, cy, v * 1.3); emit(F, px + x, cy - 1, v * 0.5); emit(F, px + x, cy + 1, v * 0.5); }
    ring(F, px + 3 + t * Lt * 0.4, cy, Wt * (0.5 + t), 1.2, I * 0.9, { sx: 0.3 });
    if (W.energy === 'plasma') for (const d of st.drops) { const a = t * 1.2 + d.t0; glow(F, px + d.x * Lt * (0.4 + a), cy + d.y * Wt * a, 1.2, I * 0.9); }
    return;
  }
  // flame envelope with jagged, per-frame edge noise
  const kf = Math.round(t * 16);
  for (let y = 0; y < CH; y++) for (let x = px; x < CW; x++) {
    const u = (x - px) / Lt;
    if (u >= 1) continue;
    const prof = Math.pow(Math.sin(Math.PI * Math.pow(u, 0.55)), 0.8) * (1 - 0.3 * u) + (u < 0.12 ? 0.35 : 0), w = Wt * 0.5 * prof;
    const n = hash3(x >> 1, y >> 1, st.seed + kf), v = Math.abs(y + 0.5 - cy) / Math.max(0.6, w * (0.75 + 0.5 * n));
    if (v < 1) emit(F, x, y, I * (1 - v) ** 0.7 * (1 - u) ** 0.4 * 1.5);
  }
  for (let d = 0; d < W.diamonds && !sup; d++) glow(F, px + Lt * (0.3 + d * 0.28), cy, Wt * 0.22, I * 0.9);
  if (!sup) for (const p of st.prongs) streak(F, px, cy, px + Math.cos(p.a) * Lt * p.l, cy + Math.sin(p.a) * Lt * p.l, 1, I * 1.2, I * 0.3);
  if (W.brake && !sup) for (const s of [-1, 1]) for (let j = 0; j < 3; j++) streak(F, px + 2 + j * 2, cy, px + 2 + j * 2 - Lt * 0.15, cy + s * CH * 0.42 * I, 2, I * 1.1, I * 0.2);
  if (W.pellets && !sup) drawSparks(F, st.pellets, t * 0.6, px, cy, CW, 1.3);
  if (W.smoke || sup) drawPuffs(F, st.gas, t, px, cy, CW * (sup ? 0.5 : 0.8), { dens: sup ? 0.9 : 1.2, under: sup ? 0 : I });
}
function muzzleStar(F, o, st, t, fp) {
  const W = WEAPONS[o.variant], { W: CW, H: CH } = F, cx = CW / 2, cy = CH / 2;
  const sup = o.suppressed, I = (0.08 + 0.92 * (1 - t) ** 1.7) * (sup ? 0.5 : 1), R = CW * 0.46 * (sup ? 0.35 : 1);
  glow(F, cx, cy, R * (W.energy ? 0.45 : 0.38) * (0.8 + 0.4 * t), I * 1.6, { k: 0 });
  if (W.energy) {
    ring(F, cx, cy, R * (0.3 + 0.6 * t), 1.3, I * 1.1);
    for (const p of st.wisps) { const pts = bolt(mulberry32(p.s + Math.round(t * 8)), cx, cy, cx + Math.cos(p.a) * R * 0.8, cy + Math.sin(p.a) * R * 0.8, { iters: 3, jitter: 0.5 }); for (let i = 1; i < pts.length; i++) streak(F, ...pts[i - 1], ...pts[i], 1, I * 0.8); }
  } else {
    for (const p of st.spikes) {
      const L = R * p.l * (0.75 + 0.5 * Math.sqrt(t)), x1 = cx + Math.cos(p.a) * L, y1 = cy + Math.sin(p.a) * L;
      streak(F, cx, cy, x1, y1, t < 0.5 ? 2 : 1, I * 1.5, I * 0.2);
      glow(F, lerp(cx, x1, 0.4), lerp(cy, y1, 0.4), R * 0.14, I * 0.6);
    }
  }
  if (fp) {
    // the flame leaves the muzzle away from the camera: a short cone along the aim direction that
    // narrows with distance (perspective), plus the star at the muzzle
    const ax = Math.cos(o.aim), ay = Math.sin(o.aim), L = R * (W.energy ? 1.4 : 1.1) * W.len * (sup ? 0.4 : 1);
    for (let s = 0; s < L; s += 0.5) { const u = s / L, w = (1 - u) * R * W.wid * 0.9 + 0.6; glow(F, cx + ax * s, cy + ay * s, w, I * (1 - u) ** 0.6 * 0.5); }
  }
  if (W.smoke || sup) drawPuffs(F, st.gas, t, cx, cy, CW * 0.4, { dens: 1, under: sup ? 0 : I });
}
function muzzleBuild(o) {
  const r = rnd(o, 11), W = WEAPONS[o.variant], n = W.prongs;
  const base = r() * TAU;
  return {
    seed: seedOf(o.seed, 12),
    prongs: Array.from({ length: Math.min(n, 3) }, (_, i) => ({ a: rad((i - (Math.min(n, 3) - 1) / 2) * 34 + (r() - 0.5) * 10), l: range(r, 0.35, 0.6) })).filter((p) => Math.abs(p.a) > 0.1),
    spikes: Array.from({ length: n }, (_, i) => ({ a: base + (i * TAU) / n + (r() - 0.5) * 0.25, l: range(r, 0.65, 1) })),
    wisps: Array.from({ length: 5 }, () => ({ a: r() * TAU, s: seedOf(o.seed, 13 + Math.floor(r() * 1e6)) })),
    drops: Array.from({ length: 5 }, () => ({ x: range(r, 0.2, 0.9), y: (r() - 0.5) * 1.6, t0: r() * 0.3 })),
    pellets: sparkSet(r, W.pellets || 0, { dir: 0, cone: 8, speed: [1.2, 1.8], life: [0.4, 0.7], delay: 0, g: 0 }),
    gas: puffSet(r, o.suppressed ? 3 : 5, { dir: o.view === 'side' ? -10 : -90, cone: o.view === 'side' ? 25 : 180, speed: [0.15, 0.35], r0: [1, 2], r1: [3, o.cell[0] * 0.12], life: [0.7, 1], delay: 0.2 }),
  };
}

// =====================================================================================
// type registry
// =====================================================================================
const ONE = (n) => ({ frames: n, loop: false });
const LOOP = (n) => ({ frames: n, loop: true });

export const FX = {
  muzzle: {
    about: 'muzzle flash per weapon class; view side (third-person, points +x) | front (into camera) | fp (screen space, centred on the fp muzzle anchor); suppressed:true; smoke after: smoke/muzzle',
    variants: Object.keys(WEAPONS),
    defaults: (o) => {
      const c = WEAPONS[o.variant].cell, cell = o.view === 'fp' ? Math.round(c * 2.4) : o.view === 'front' ? Math.round(c * 0.8) : c;
      return { cell: [cell, cell], ...ONE(4), fps: 30, blend: WEAPONS[o.variant].smoke || o.suppressed ? 'premultiplied' : 'additive' };
    },
    ramps: (o) => ({ E: [E(o, WEAPONS[o.variant].energy || 'fire'), E(o, 'spark')], M: [M(o.suppressed ? 'smoke_light' : 'smoke')] }),
    build: muzzleBuild,
    frame: (F, o, st, t) => (o.view === 'side' ? muzzleSide(F, o, st, t) : muzzleStar(F, o, st, t, o.view === 'fp')),
    meta: (o) => {
      const W = WEAPONS[o.variant], sup = o.suppressed, k = sup ? 0.3 : 1, col = LIGHT_HEX[W.energy || 'fire'];
      return {
        pivot: o.view === 'side' ? [1, o.cell[1] / 2] : [o.cell[0] / 2, o.cell[1] / 2], facing: o.view === 'fp' ? 'screen' : o.view === 'front' ? 'camera' : 'camera_axis',
        size_m: W.size_m * (sup ? 0.5 : 1), sound: [sup ? 'gunshot_suppressed' : W.sound],
        light: { color: col, radius_m: W.light[1] * k, intensity: [[0, W.light[0] * 4 * k], [33, W.light[0] * 2 * k], [66, W.light[0] * 0.4 * k], [100, 0]] },
        fp: o.view === 'fp' ? { anchor: 'muzzle', frame: FP_FRAME, aim_deg: +((o.aim * 180) / Math.PI).toFixed(2), shake: { amp_px: W.shake * k, freq_hz: 18, decay_ms: 140 }, flash: sup ? null : { color: col, alpha: 0.08 + W.shake * 0.01, ms: 33 }, events: ['fire'] } : null,
        emitters: [
          { cell: 'particles:spark', count: sup ? [0, 1] : [W.pellets ? 4 : 1, W.pellets ? 8 : 3], velocity: { dir: [0, 0, -1], cone_deg: 12, speed_mps: [20, 40] }, gravity_mps2: 9.81, drag: 2, lifetime_s: [0.05, 0.15], size_over_life: [[0, 1], [1, 0.3]], color_over_life: [[0, '#fff4c0'], [1, '#ff8030']] },
          { cell: 'particles:smoke', count: [1, 2], velocity: { dir: [0, 0.3, -1], cone_deg: 25, speed_mps: [0.5, 1.5] }, gravity_mps2: -0.4, drag: 3, lifetime_s: [0.5, 1.1], size_over_life: [[0, 0.4], [1, 1.6]], color_over_life: [[0, '#8a8a92'], [1, '#5e5e66']], alpha_over_life: [[0, 0.6], [1, 0]] },
        ],
        views: o.view === 'side' ? { E: 'as is', W: 'flip x', NE: 'scale x 0.7', SE: 'scale x 0.7', NW: 'flip x, scale x 0.7', SW: 'flip x, scale x 0.7', S: 'use the front variant', N: 'hide (muzzle points away) or front at 50%' } : undefined,
        notes: o.view === 'fp' ? `Draw the cell pivot on the frame's muzzle anchor (fp v2 anchor "muzzle", art_model render "socket_muzzle") for 1-2 frames after a "fire" event; baked for aim ${((o.aim * 180) / Math.PI).toFixed(0)} deg (muzzle -> frame centre)` : undefined,
      };
    },
  },
  tracer: {
    about: 'tracer streak, head at the right edge; stretch along velocity. ballistic | energy | plasma',
    variants: ['ballistic', 'energy', 'plasma'],
    defaults: (o) => ({ cell: o.variant === 'ballistic' ? [64, 8] : o.variant === 'energy' ? [64, 12] : [48, 16], ...LOOP(4), fps: 30, blend: 'additive' }),
    ramps: (o) => ({ E: [E(o, o.variant === 'ballistic' ? 'fire' : o.variant), E(o, 'spark')], M: [M('smoke')] }),
    build: (o) => ({ seed: seedOf(o.seed, 21) }),
    frame: (F, o, st, t) => {
      const { W, H } = F, cy = H / 2, hx = W - 2, k = Math.round(t * o.frames) % o.frames, r = mulberry32(st.seed + k);
      if (o.variant === 'ballistic') {
        const tail = W * range(r, 0.8, 0.98);
        streak(F, hx - tail, cy, hx, cy, 1, 0.15, 1.3, 1);
        for (let x = 0; x < tail * 0.5; x++) emit(F, hx - x, cy - 1, 0.5 * (1 - x / (tail * 0.5)) * (0.6 + 0.4 * r()));
        glow(F, hx, cy, 2.2, 1.2, { k: 1 });
      } else if (o.variant === 'energy') {
        for (let x = 0; x < W - 1; x++) {
          const u = x / W, beads = 0.5 + 0.5 * Math.sin(TAU * (u * 3 - t)), v = Math.pow(u, 0.6);
          emit(F, x, cy, v * 1.3); emit(F, x, cy - 1, v * 0.9);
          for (let d = 2; d < H / 2; d++) { const g = v * (0.55 + 0.45 * beads) * (1 - d / (H / 2)) ** 1.6; emit(F, x, cy - d, g); emit(F, x, cy + d - 1, g); }
        }
      } else {
        for (let i = 0; i < 4; i++) { const ph = frac(t + i / 4); glow(F, hx - 6 - ph * W * 0.8, cy + Math.sin(TAU * (ph + i / 4)) * 2, (1 - ph) * 3 + 0.8, 0.7 * (1 - ph)); }
        glow(F, hx - 5, cy, H * 0.36 * (0.9 + 0.1 * Math.sin(TAU * t)), 1.5);
      }
    },
    meta: (o) => ({ pivot: [o.cell[0] - 2, o.cell[1] / 2], facing: 'velocity', size_m: o.variant === 'ballistic' ? 1.6 : 1.2, sound: ['bullet_whiz'], light: o.variant === 'ballistic' ? null : { color: LIGHT_HEX[o.variant], radius_m: 2, intensity: [[0, 1.2], [1000, 1.2]] }, notes: 'quad from (pos - dir * length) to pos, width = cell height in px at the game scale; ballistic: one tracer every 3-5 rounds, speed ~850 m/s (draw ~20 m long at most), energy/plasma 120-200 m/s' }),
  },
  casing: {
    about: 'spent casing spin frames (loop) for ejection sprites; rifle | pistol | shotgun',
    variants: ['rifle', 'pistol', 'shotgun'],
    defaults: (o) => ({ cell: o.variant === 'pistol' ? [8, 8] : [12, 12], ...LOOP(8), fps: 24, blend: 'alpha' }),
    ramps: (o) => ({ E: [E(o, 'spark')], M: [M('brass', { steps: 5, spread: 0.6 }), M('hull', { steps: 4 })] }),
    build: () => ({}),
    frame: (F, o, st, t) => {
      const { W, H } = F, cx = W / 2, cy = H / 2, dims = { rifle: [9, 2.6, 0.7], pistol: [5, 3, 1], shotgun: [10, 4.2, 0.3] }[o.variant];
      const a = TAU * frac(t), fl = 0.55 + 0.45 * Math.abs(Math.cos(TAU * frac(t) * 2)) ** 0.5, L = dims[0] * fl, D = dims[1], ca = Math.cos(a), sa = Math.sin(a);
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const dx = x + 0.5 - cx, dy = y + 0.5 - cy, u = (dx * ca + dy * sa) / (L / 2), v = (-dx * sa + dy * ca) / (D / 2);
        const neck = o.variant === 'rifle' && u > 0.45 ? 0.62 : 1;
        if (Math.abs(u) > 1 || Math.abs(v) > neck) continue;
        // cylinder shading across the casing, darker rim at the base (u < -0.82); shotgun: red hull over a brass head
        const lit = clamp01(0.62 - v * 0.45 + (Math.abs(v) < 0.3 ? 0.25 : 0)), hull = o.variant === 'shotgun' && u > -0.4;
        matter(F, x, y, 2, u < -0.82 ? lit * 0.5 : lit, hull ? 1 : 0);
      }
    },
    meta: (o) => ({ pivot: [o.cell[0] / 2, o.cell[1] / 2], facing: 'camera', size_m: o.variant === 'shotgun' ? 0.07 : o.variant === 'rifle' ? 0.06 : 0.025, sound: ['casing_drop'], light: null, emitters: [{ cell: `fx:casing_${o.variant}`, count: [1, 1], velocity: { dir: [1, 0.6, 0.2], cone_deg: 20, speed_mps: [2.5, 4] }, gravity_mps2: 9.81, drag: 0.2, lifetime_s: [1, 1.6], bounce: 0.3, spin_rps: [14, 24], size_over_life: [[0, 1], [1, 1]], color_over_life: [[0, '#ffffff'], [1, '#ffffff']] }], notes: 'spawn at the ejection port on the fire event (fp v2: event "eject"); play the spin frames at spin_rps * frames / 1 rev; on the first ground hit play casing_drop and settle on frame 0 or frames/2' }),
  },
  dust: {
    about: 'low ground dust puff: mag_drop (magazine clatter) | landing (body / jump landing)',
    variants: ['mag_drop', 'landing'],
    defaults: (o) => ({ cell: o.variant === 'landing' ? [48, 48] : [32, 32], ...ONE(16), fps: 24, blend: 'alpha' }),
    ramps: () => ({ E: [heatRamp(30)], M: [M('concrete'), M('chips')] }),
    build: (o) => { const r = rnd(o, 31); return { puffs: [...puffSet(r, 4, { dir: 180, cone: 12, speed: [0.25, 0.45], r0: [1, 2], r1: [3, 5], life: [0.6, 1], delay: 0.06 }), ...puffSet(r, 4, { dir: 0, cone: 12, speed: [0.25, 0.45], r0: [1, 2], r1: [3, 5], life: [0.6, 1], delay: 0.06 })], chips: chipSet(r, 5, { cone: 60, speed: [0.4, 0.8], g: 2.4, life: [0.3, 0.5] }) }; },
    frame: (F, o, st, t) => { const s = o.variant === 'landing' ? 1.5 : 1; drawPuffs(F, st.puffs, t, F.W / 2, F.H - 3, F.W * 0.6 * s, { dens: 0.9, rise: 0.08 }); drawChips(F, st.chips, t, F.W / 2, F.H - 2, F.W * 0.5, 1); },
    meta: (o) => ({ pivot: [o.cell[0] / 2, o.cell[1] - 1], facing: 'camera_up', size_m: o.variant === 'landing' ? 1.4 : 0.6, sound: [o.variant === 'landing' ? 'footstep' : 'mag_out'], light: null, notes: 'spawn on the ground contact point (magazine: when the dropped mag lands, ~0.35 s after the mag_out event)' }),
  },
  impact: {
    about: 'bullet impact per surface (normal = up, pivot on the hit point): ' + Object.keys(SURFACES).join(' | '),
    variants: Object.keys(SURFACES),
    defaults: (o) => ({ cell: o.variant === 'shield' ? [48, 48] : o.variant === 'water' || o.variant === 'dirt' ? [32, 32] : [32, 32], ...ONE(16), fps: 30, blend: SURFACES[o.variant].blend }),
    ramps: (o) => {
      const S = SURFACES[o.variant];
      if (o.variant === 'shield') return { E: [E(o, 'energy'), E(o, 'energy', { drift: 20 })], M: [M('smoke')] };
      const mat = o.variant === 'water' ? M('water', { steps: 5, spread: 0.7 }) : o.variant === 'flesh' ? M('blood', { steps: 4, spread: 0.4 }) : o.variant === 'glass' ? M('glass', { steps: 4, spread: 0.5 }) : M(S.dustc || 'concrete');
      return { E: [E(o, 'spark'), E(o, 'energy')], M: [mat, M(S.chipc || S.dustc || 'chips', { steps: 3 })] };
    },
    build: (o) => {
      const r = rnd(o, 41), S = SURFACES[o.variant];
      return {
        sparks: sparkSet(r, S.sparks || 0, { cone: o.variant === 'armor' ? 50 : 70, speed: [0.6, 1.3], g: 1 }),
        rico: { a: rad(-90 + (r() < 0.5 ? -1 : 1) * range(r, 50, 70)) },
        dust: puffSet(r, S.dust || 0, { cone: S.plume ? 18 : 55, speed: S.plume ? [0.35, 0.8] : [0.15, 0.45], r0: [1, 2], r1: [3, 6 + (S.plume || 0) * 3], life: [0.6, 1] }),
        chips: chipSet(r, S.chips || 0, { cone: 45 }),
        shards: Array.from({ length: S.shards || 0 }, () => ({ ...chipSet(r, 1, { cone: 60, speed: [0.6, 1.3], g: 1.4 })[0], rot: r() * TAU, spin: range(r, -12, 12), s: range(r, 1.4, 2.6) })),
        drops: chipSet(r, S.splash ? 12 : S.mist ? 5 : 0, { cone: S.splash ? 28 : 50, speed: S.splash ? [0.7, 1.4] : [0.4, 0.8], g: 2.2, life: [0.5, 0.9] }),
        mist: puffSet(r, S.mist ? 6 : 0, { cone: 70, speed: [0.15, 0.4], r0: [1, 2], r1: [3, 5], life: [0.45, 0.75], delay: 0.05 }),
        arc: { s: seedOf(o.seed, 42), on: Array.from({ length: 16 }, () => r() < 0.55) },
      };
    },
    frame: (F, o, st, t) => {
      const S = SURFACES[o.variant], { W, H } = F, ox = W / 2, oy = H - 2, sc = H * 0.95;
      if (o.variant === 'shield') {
        const cx = W / 2, cy = H / 2, R = W * 0.48, rr = R * smooth01(t / 0.8), hexR = 3.2;
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
          const dx = x + 0.5 - cx, dy = y + 0.5 - cy, d = Math.hypot(dx, dy);
          if (d > R) continue;
          // pointy hex grid: distance to the nearest hex edge
          const q = (dx * Math.sqrt(3) / 3 - dy / 3) / hexR, rq = (dy * 2 / 3) / hexR, cz = -q - rq;
          let rx = Math.round(q), ry = Math.round(rq), rz = Math.round(cz);
          const ddx = Math.abs(rx - q), ddy = Math.abs(ry - rq), ddz = Math.abs(rz - cz);
          if (ddx > ddy && ddx > ddz) rx = -ry - rz; else if (ddy > ddz) ry = -rx - rz;
          const edge = Math.max(Math.abs(q - rx), Math.abs(rq - ry), Math.abs(cz - (-rx - ry)));
          const band = Math.max(0, 1 - Math.abs(d - rr) / 3.5) * (1 - t) ** 0.7, fill = d < rr ? (1 - t) ** 2 * 0.35 * (1 - d / R) : 0;
          if (edge > 0.38) emit(F, x, y, (band * 1.3 + fill * 2) * (1 - d / R * 0.5), 1);
          else emit(F, x, y, band * 0.35 + fill * 0.4, 0);
        }
        glow(F, cx, cy, W * 0.16 * (1 - t), (1 - t) ** 2 * 1.6);
        return;
      }
      if (S.flash) glow(F, ox, oy - 1, W * 0.2 * S.flash, Math.max(0, 1 - t / 0.16) * 1.6 * S.flash);
      if (S.ricochet && t < 0.35) { const L = W * 0.8 * (t / 0.35), x1 = ox + Math.cos(st.rico.a) * L, y1 = oy + Math.sin(st.rico.a) * L; streak(F, ox + Math.cos(st.rico.a) * L * 0.4, oy + Math.sin(st.rico.a) * L * 0.4, x1, y1, 1, 0.3, 1.4); }
      if (S.deflect && t < 0.5) { const a = rad(-90 + 62), L = W * (0.3 + t * 1.6); streak(F, ox, oy, ox + Math.cos(a) * L, oy + Math.sin(a) * L, t < 0.2 ? 2 : 1, 1.4 * (1 - t * 2), 0.2); }
      drawPuffs(F, st.dust, t, ox, oy, sc * (S.plume ? 0.9 : 0.6), { m: 0, dens: o.variant === 'metal' || o.variant === 'armor' ? 0.6 : 1.1, rise: S.plume ? 0 : 0.08 });
      drawChips(F, st.chips, t, ox, oy, sc, 1);
      for (const p of st.shards) {
        const a = life(t, p.t0, p.L);
        if (!alive(a)) continue;
        const T = a * p.L, x = ox + p.vx * T * sc, y = oy + (p.vy * T + 0.5 * p.g * T * T) * sc, rt = p.rot + p.spin * T;
        const pts = [0, 2.2, 4.1].map((b, i) => [x + Math.cos(rt + b) * p.s * (i ? 1 : 1.4), y + Math.sin(rt + b) * p.s * (i ? 0.7 : 1.4)]);
        poly(F, pts, (px, py) => matter(F, px, py, 2, 0.4 + 0.5 * Math.sin(rt * 2) ** 2, 0));
        if (Math.sin(rt * 3) > 0.8) emit(F, pts[0][0], pts[0][1], 1.2, 0);
      }
      if (S.splash) {
        // crown + column + droplets + base ring
        const col = smooth01(t / 0.35) * (1 - smooth01((t - 0.45) / 0.5));
        for (let i = 0; i < 6; i++) puff(F, ox + (i - 2.5) * 1.2 * (1 + t), oy - col * H * (0.25 + 0.5 * Math.sin((i / 5) * Math.PI)), 1.6 + t * 2, col * 1.3, { m: 0 });
        drawChips(F, st.drops, t, ox, oy, sc, 0);
        const rr = W * 0.12 + t * W * 0.38;
        for (let k = 0; k < 28; k++) { const a = (k / 28) * TAU; matter(F, ox + Math.cos(a) * rr, oy + Math.sin(a) * rr * 0.25, 1.5 * (1 - t), 0.8, 0); }
      }
      if (S.mist) {
        drawPuffs(F, st.mist, t, ox, oy - 3, sc * 0.5, { m: 0, dens: 0.9 });
        drawChips(F, st.drops, t, ox, oy - 3, sc * 0.7, 0);
      }
      drawSparks(F, st.sparks, t, ox, oy, sc * (o.variant === 'armor' ? 1.1 : 0.9), 1.3, 0);
      if (S.arc) {
        const k = Math.min(15, Math.floor(t * 16));
        if (st.arc.on[k] && t < 0.7) {
          const r = mulberry32(st.arc.s + k), a = rad(-90 + (r() - 0.5) * 100), L = W * range(r, 0.25, 0.42), pts = bolt(r, ox, oy, ox + Math.cos(a) * L, oy + Math.sin(a) * L, { iters: 3, jitter: 0.6 });
          for (let i = 1; i < pts.length; i++) streak(F, ...pts[i - 1], ...pts[i], 1, 1.4, 1.4, 1);
          glow(F, ox, oy, 2.5, 1.1, { k: 1 });
        }
      }
    },
    meta: (o) => {
      const S = SURFACES[o.variant], E1 = S.sparks ? [{ cell: 'particles:spark', count: [Math.ceil(S.sparks / 3), S.sparks], velocity: { dir: [0, 1, 0], cone_deg: 70, speed_mps: [3, 9] }, gravity_mps2: 9.81, drag: 1, lifetime_s: [0.2, 0.6], bounce: 0.4, size_over_life: [[0, 1], [1, 0.4]], color_over_life: [[0, '#fff6d0'], [0.4, '#ffb040'], [1, '#c04010']] }] : [];
      const chip = S.chips || S.shards ? [{ cell: S.shards ? 'particles:shard' : 'particles:chip', count: [2, (S.chips || S.shards) >> 1], velocity: { dir: [0, 1, 0], cone_deg: 50, speed_mps: [2, 5] }, gravity_mps2: 9.81, drag: 0.5, lifetime_s: [0.4, 0.9], bounce: 0.2, size_over_life: [[0, 1], [1, 1]], color_over_life: [[0, '#ffffff'], [1, '#ffffff']] }] : [];
      const dust = S.dust || S.mist || S.splash ? [{ cell: S.mist ? 'particles:blood' : S.splash ? 'particles:droplet' : 'particles:dust', count: [2, 5], velocity: { dir: [0, 1, 0], cone_deg: 60, speed_mps: [0.4, 1.5] }, gravity_mps2: S.splash ? 9.81 : -0.2, drag: 3, lifetime_s: [0.4, 1.2], size_over_life: [[0, 0.5], [1, 1.5]], color_over_life: [[0, '#ffffff'], [1, '#ffffff']], alpha_over_life: [[0, 0.8], [1, 0]] }] : [];
      const light = S.flash || S.hex || S.arc ? { color: S.hex || S.arc ? LIGHT_HEX.energy : LIGHT_HEX.spark, radius_m: S.hex ? 3 : 1.2, intensity: [[0, (S.flash || 1) * 2], [50, (S.flash || 1) * 0.6], [120, 0]] } : null;
      return { pivot: o.variant === 'shield' ? [o.cell[0] / 2, o.cell[1] / 2] : [o.cell[0] / 2, o.cell[1] - 2], facing: o.variant === 'shield' ? 'surface' : 'camera_up', size_m: o.variant === 'shield' ? 0.9 : 0.45, sound: S.sound, light, decal: S.decal ? `decal:${S.decal}` : null, emitters: [...E1, ...chip, ...dust], notes: o.variant === 'shield' ? 'quad on the shield surface at the hit point (normal = shield normal)' : 'camera-facing quad, rotated so sprite up = the surface normal projected on screen; spawn the decal on the surface' };
    },
  },
  explosion: {
    about: 'explosion: frag | plasma | emp (shockwave) | incendiary',
    variants: ['frag', 'plasma', 'emp', 'incendiary'],
    defaults: (o) => ({ cell: [96, 96], ...ONE(16), fps: 20, blend: o.variant === 'frag' || o.variant === 'incendiary' ? 'premultiplied' : 'additive' }),
    ramps: (o) => ({ E: [E(o, o.variant === 'plasma' ? 'plasma' : o.variant === 'emp' ? 'emp' : 'fire', { steps: 7 }), E(o, o.variant === 'plasma' || o.variant === 'emp' ? 'energy' : 'spark')], M: [M('smoke', { steps: 5, spread: 0.55 }), M('soot', { steps: 3 }), M('smoke_light', { steps: 4 })] }),
    build: (o) => {
      const r = rnd(o, 51);
      return {
        balls: Array.from({ length: 12 }, () => { const a = r() * TAU, d = Math.sqrt(r()); return { dx: Math.cos(a) * d, dy: Math.sin(a) * d * 0.8 - 0.25, r: range(r, 0.12, 0.22), t0: r() * 0.08, h: range(r, 0.8, 1.2) }; }),
        debris: sparkSet(r, 14, { cone: 85, speed: [0.9, 1.6], life: [0.35, 0.7], delay: 0.03, g: 1.1 }),
        chips: chipSet(r, 10, { cone: 75, speed: [0.9, 1.5], g: 1.8, life: [0.6, 1] }),
        smoke: puffSet(r, 9, { cone: 50, speed: [0.12, 0.3], r0: [5, 8], r1: [9, 14], life: [0.7, 1], delay: 0.2 }),
        blobs: chipSet(r, 9, { cone: 70, speed: [0.6, 1.1], g: 1.6, life: [0.5, 0.75] }),
        trails: sparkSet(r, 6, { cone: 70, speed: [1, 1.5], life: [0.5, 0.9], delay: 0.02, g: 1.4 }),
        arcs: Array.from({ length: 6 }, () => ({ a: r() * TAU, s: seedOf(o.seed, 52 + Math.floor(r() * 1e6)), t0: r() * 0.5 })),
        flames: Array.from({ length: 10 }, (_, i) => ({ x: (i / 9 - 0.5) * 1.6 + (r() - 0.5) * 0.15, ph: r(), h: range(r, 0.5, 1) })),
      };
    },
    frame: (F, o, st, t) => {
      const { W, H } = F, cx = W / 2, cy = H * 0.64, R = W * 0.36, flash = Math.max(0, 1 - t / 0.12);
      if (o.variant === 'frag' || o.variant === 'incendiary') {
        glow(F, cx, cy, R * 0.75 * (0.6 + flash * 0.4), flash * 1.8);
        const heatOf = (b) => clamp01(1 - (t - b.t0) / (o.variant === 'frag' ? 0.42 : 0.3)) * b.h;
        for (const b of st.balls) {
          const a = clamp01((t - b.t0) / 0.5), e = 1 - Math.exp(-5 * a), x = cx + b.dx * R * 0.6 * e, y = cy + b.dy * R * 0.6 * e - t * H * 0.1, rr = R * b.r * (1 + 1.6 * e), heat = heatOf(b);
          if (t < b.t0) continue;
          if (heat > 0) glow(F, x, y, rr * (0.6 + heat * 0.5), heat * 1.5, { p: 0.6 });
          puff(F, x, y, rr * 1.1, smooth01((t - b.t0 - 0.12) / 0.25) * (1 - smooth01((t - 0.65) / 0.35)) * 1.4, { m: 0, under: heat * 0.8 });
        }
        if (o.variant === 'frag') { drawSparks(F, st.debris, t, cx, cy, R * 1.2, 1.4, 1); drawChips(F, st.chips, t, cx, cy, R, 1); }
        drawPuffs(F, st.smoke, t, cx, cy - R * 0.2, R * 0.8, { m: 0, dens: 1.2, rise: 0.2 });
        if (o.variant === 'incendiary') {
          for (const p of st.trails) { const a = life(t, p.t0, p.L); if (!alive(a)) continue; for (let s = 0; s < 6; s++) { const T = Math.max(0, a * p.L - s * 0.03), x = cx + p.vx * T * R, y = cy + (p.vy * T + 0.5 * p.g * T * T) * R; if (!s) glow(F, x, y, 1.6, 1.6, { k: 1 }); else puff(F, x, y - s * 0.4, 1.2 + s * 0.35, 0.9 * (1 - s / 6), { m: 2 }); } }
          for (const p of st.blobs) { const a = life(t, p.t0, p.L); if (!alive(a)) continue; const T = a * p.L, x = cx + p.vx * T * R, y = Math.min(H - 4, cy + (p.vy * T + 0.5 * p.g * T * T) * R); glow(F, x, y, 2.2, 1.3); }
          const g = smooth01((t - 0.2) / 0.2);
          for (const f of st.flames) { const fl = flick(t, f.ph), h = H * 0.2 * f.h * g * (0.6 + 0.5 * fl); for (let s = 0; s < h; s += 0.7) { const u = s / h; glow(F, cx + f.x * R * 0.75 + Math.sin(TAU * (u + f.ph + t * 2)) * 1.2, H - 4 - s, (1 - u) * 2.6 + 0.6, g * (1 - u) ** 0.8 * 1.25); } }
        }
      } else if (o.variant === 'plasma') {
        const core = Math.max(0, 1 - t / 0.55);
        glow(F, cx, cy, R * 0.5 * (0.5 + t), core * 1.7, { p: 0.7 });
        ring(F, cx, cy, R * smooth01(t / 0.6), 2.2, (1 - t) * 1.4);
        ring(F, cx, cy + R * 0.25, R * 1.05 * smooth01(t / 0.5), 1.6, (1 - t) * 1.2, { sy: 0.32 });
        for (const a of st.arcs) if (t > a.t0 && t < a.t0 + 0.3) { const rr = mulberry32(a.s + Math.round(t * 16)), L = R * 0.8 * (0.5 + t), pts = bolt(rr, cx, cy, cx + Math.cos(a.a) * L, cy + Math.sin(a.a) * L, { iters: 3, jitter: 0.55 }); for (let i = 1; i < pts.length; i++) streak(F, ...pts[i - 1], ...pts[i], 1, 1.3, 1, 1); }
        for (const p of st.debris.slice(0, 8)) { const a = life(t, p.t0, p.L); if (alive(a)) glow(F, cx + p.vx * a * p.L * R, cy + (p.vy * a * p.L + 0.25 * p.g * (a * p.L) ** 2) * R, 1.6 * (1 - a) + 0.6, (1 - a) * 1.2); }
      } else {
        glow(F, cx, cy, R * 0.3, flash * 1.8, { k: 1 });
        for (const [d, w] of [[0, 2.6], [0.16, 1.4]]) { const tt = clamp01((t - d) / 0.7); if (tt > 0 && tt < 1) ring(F, cx, cy, R * 1.08 * smooth01(tt) + 1, w, (1 - tt) ** 0.8 * 1.5, { k: d ? 1 : 0 }); }
        ring(F, cx, cy + R * 0.3, R * 1.1 * smooth01(t / 0.6), 1.2, (1 - t) * 1.1, { sy: 0.3, k: 1 });
        for (const a of st.arcs) if (t > a.t0 * 0.8 && t < a.t0 * 0.8 + 0.25) { const rr = mulberry32(a.s + Math.round(t * 16)), r0 = R * smooth01(t / 0.7) * 0.9, pts = bolt(rr, cx + Math.cos(a.a) * r0 * 0.5, cy + Math.sin(a.a) * r0 * 0.5, cx + Math.cos(a.a + 0.4) * r0, cy + Math.sin(a.a + 0.4) * r0, { iters: 3, jitter: 0.7 }); for (let i = 1; i < pts.length; i++) streak(F, ...pts[i - 1], ...pts[i], 1, 1.3, 1.3, 0); }
      }
    },
    meta: (o) => {
      const v = o.variant, col = { frag: LIGHT_HEX.fire, incendiary: '#ffd090', plasma: LIGHT_HEX.plasma, emp: LIGHT_HEX.emp }[v], I = { frag: 12, incendiary: 8, plasma: 10, emp: 6 }[v];
      const dur = (o.frames / o.fps) * 1000, tail = v === 'incendiary' ? [[dur * 0.3, I * 0.35], [dur, I * 0.25]] : [[dur * 0.3, I * 0.25], [dur, 0]];
      return {
        pivot: [o.cell[0] / 2, Math.round(o.cell[1] * 0.6)], facing: 'camera_up', size_m: v === 'emp' ? 8 : 6, sound: { frag: ['explosion'], incendiary: ['explosion', 'fire_burst'], plasma: ['plasma_shot', 'explosion'], emp: ['glitch_tear', 'shield_hit'] }[v],
        light: { color: col, radius_m: v === 'emp' ? 14 : 10, intensity: [[0, I], [60, I * 0.8], ...tail] },
        fp: { shake: { amp_px: v === 'emp' ? 3 : 8, freq_hz: 12, decay_ms: 500, falloff_m: 25 }, flash: { color: col, alpha: v === 'emp' ? 0.5 : 0.3, ms: v === 'emp' ? 180 : 90 }, emp: v === 'emp' ? { hud_glitch_ms: 2500, radius_m: 8 } : undefined },
        decal: v === 'emp' ? null : v === 'plasma' ? 'decal:energy_burn' : 'decal:scorch',
        emitters: [
          ...(v === 'frag' ? [{ cell: 'particles:chip', count: [12, 24], velocity: { dir: [0, 1, 0], cone_deg: 80, speed_mps: [6, 18] }, gravity_mps2: 9.81, drag: 0.4, lifetime_s: [0.6, 1.5], bounce: 0.3, size_over_life: [[0, 1], [1, 1]], color_over_life: [[0, '#ffffff'], [1, '#ffffff']] }] : []),
          { cell: v === 'emp' || v === 'plasma' ? 'particles:glint' : 'particles:ember', count: [10, 30], velocity: { dir: [0, 1, 0], cone_deg: 85, speed_mps: [3, 12] }, gravity_mps2: v === 'emp' ? 0 : 9.81, drag: 1.2, lifetime_s: [0.4, 1.4], size_over_life: [[0, 1], [1, 0.3]], color_over_life: [[0, '#ffffff'], [0.3, col], [1, '#401008']] },
          ...(v === 'frag' || v === 'incendiary' ? [{ cell: 'fx:smoke_column', count: [1, 1], velocity: { dir: [0, 1, 0], cone_deg: 0, speed_mps: [0, 0] }, gravity_mps2: 0, drag: 0, lifetime_s: [4, 8], delay_s: 0.4, size_over_life: [[0, 1], [1, 1.5]], color_over_life: [[0, '#ffffff'], [1, '#ffffff']], alpha_over_life: [[0, 0], [0.1, 1], [1, 0]] }] : []),
        ],
        notes: v === 'emp' ? 'shockwave ring, no fire: pair with a HUD / screen glitch and drone shutdown in fp.emp.radius_m' : v === 'incendiary' ? 'the last frames are ground flames: crossfade into fx:fire_large (loop) for the burn time' : undefined,
      };
    },
  },
  smoke: {
    about: 'smoke: column (loop) | grenade (loop, color) | muzzle (one-shot puff after a shot) | trail (loop, rocket / burning debris)',
    variants: ['column', 'grenade', 'muzzle', 'trail'],
    defaults: (o) => ({ cell: o.variant === 'muzzle' ? [32, 32] : [64, 64], ...(o.variant === 'muzzle' ? ONE(16) : LOOP(16)), fps: o.variant === 'muzzle' ? 20 : 12, blend: 'alpha' }),
    ramps: (o) => ({ E: [E(o, 'fire')], M: [o.variant === 'grenade' ? matterRamp(o.color || '#c8c8c0', { steps: 5, spread: 0.55 }) : M(o.variant === 'muzzle' ? 'smoke_light' : 'smoke', { steps: 5, spread: 0.55 })] }),
    build: (o) => {
      const r = rnd(o, 61), n = { column: 12, grenade: 18, muzzle: 5, trail: 10 }[o.variant];
      return { p: Array.from({ length: n }, (_, i) => ({ ph: (i + r() * 0.6) / n, x: (r() - 0.5), s: range(r, 0.8, 1.25), w: r() })), set: puffSet(r, 5, { dir: -15, cone: 20, speed: [0.25, 0.5], r0: [1.5, 2.5], r1: [4, 7], life: [0.7, 1], delay: 0.2 }) };
    },
    frame: (F, o, st, t) => {
      const { W, H } = F;
      if (o.variant === 'muzzle') { drawPuffs(F, st.set, t, 2, H / 2, W * 0.7, { dens: 1, rise: 0.25 }); return; }
      for (const p of st.p) {
        const a = frac(t + p.ph), fade = smooth01(a / 0.15) * (1 - a) ** 1.2;
        if (o.variant === 'column') puff(F, W / 2 + p.x * 4 + Math.sin(TAU * (a * 0.7 + p.w)) * 3 + a * W * 0.12, H - 6 - a * (H - 18), (3 + a * 11) * p.s, fade * 1.5, { m: 0 });
        else if (o.variant === 'grenade') { const up = p.w < 0.45; puff(F, W / 2 + p.x * (up ? 10 : 30) * (0.4 + a), H - 6 - (up ? a * (H - 22) : a * 6), (4 + a * (up ? 10 : 7)) * p.s, fade * 1.6, { m: 0 }); }
        else puff(F, W - 4 - a * (W - 12), H / 2 + p.x * 2 * a + Math.sin(TAU * (a + p.w)) * 2 * a, (1.5 + a * 7) * p.s, fade * 1.5, { m: 0 });
      }
    },
    meta: (o) => ({
      pivot: o.variant === 'muzzle' ? [1, o.cell[1] / 2] : o.variant === 'trail' ? [o.cell[0] - 4, o.cell[1] / 2] : [o.cell[0] / 2, o.cell[1] - 4], facing: o.variant === 'trail' ? 'velocity' : 'camera_up', size_m: { column: 4, grenade: 5, muzzle: 0.6, trail: 2 }[o.variant], sound: o.variant === 'grenade' ? ['fire_burst'] : [], light: null,
      emitters: o.variant === 'grenade' || o.variant === 'column' ? [{ cell: `fx:smoke_${o.variant}`, rate_per_s: o.variant === 'grenade' ? 4 : 1.5, count: [1, 1], velocity: { dir: [0, 1, 0], cone_deg: 15, speed_mps: [0.3, 0.8] }, gravity_mps2: -0.3, drag: 1, lifetime_s: [5, 9], size_over_life: [[0, 0.6], [1, 2.2]], color_over_life: [[0, '#ffffff'], [1, '#ffffff']], alpha_over_life: [[0, 0], [0.1, 0.9], [1, 0]] }] : [],
      notes: o.variant === 'grenade' ? 'stack 3-6 cards at random offsets, phase-offset the loop; blocks vision (cast as an occluder for AI line-of-sight)' : undefined,
    }),
  },
  fire: {
    about: 'fire loop: small (burning debris) | large (pool / vehicle fire)',
    variants: ['small', 'large'],
    defaults: (o) => ({ cell: o.variant === 'small' ? [32, 32] : [64, 64], ...LOOP(16), fps: 15, blend: 'additive' }),
    ramps: (o) => ({ E: [E(o, 'fire', { steps: 6 })], M: [M('smoke')] }),
    build: (o) => { const r = rnd(o, 71), n = o.variant === 'small' ? 10 : 20; return { p: Array.from({ length: n }, (_, i) => ({ ph: (i + r() * 0.7) / n, x: (r() - 0.5) * 2, s: range(r, 0.7, 1.3), w: r(), k: 1 + Math.floor(r() * 2) })), base: r() }; },
    frame: (F, o, st, t) => {
      const { W, H } = F, cx = W / 2, by = H - 3, sz = W / 32;
      for (let x = 0; x < W; x++) { const u = (x + 0.5 - cx) / (W * 0.38); if (Math.abs(u) < 1) for (let y = 0; y < 3 * sz; y++) emit(F, x, by - y, (1 - u * u) * (0.9 + 0.2 * flick(t, st.base + x * 0.07, [2, 3, 5])) * (1 - y / (3 * sz))); }
      for (const p of st.p) {
        const a = frac(t * p.k + p.ph), x = cx + p.x * W * 0.3 * (1 - a * 0.6) + Math.sin(TAU * (a * 1.5 + p.w)) * 2 * sz, y = by - a * H * 0.85;
        glow(F, x, y, (1 - a) ** 0.7 * 5 * sz * p.s + 0.6, (1 - a) ** 1.1 * 1.3 * smooth01(a / 0.08 + 0.3), { p: 0.9 });
      }
    },
    meta: (o) => ({ pivot: [o.cell[0] / 2, o.cell[1] - 2], facing: 'camera_up', size_m: o.variant === 'small' ? 0.6 : 2.5, sound: ['fire_burst'], light: { color: LIGHT_HEX.fire, radius_m: o.variant === 'small' ? 3 : 8, intensity: Array.from({ length: o.frames + 1 }, (_, k) => [Math.round((k / o.fps) * 1000), +((o.variant === 'small' ? 1.5 : 4) * (0.75 + 0.25 * flick(k / o.frames, 0.3, [2, 3, 5]))).toFixed(3)]), loop: true }, emitters: [{ cell: 'particles:ember', rate_per_s: o.variant === 'small' ? 4 : 12, count: [1, 1], velocity: { dir: [0, 1, 0], cone_deg: 25, speed_mps: [1, 3] }, gravity_mps2: -1, drag: 0.8, lifetime_s: [0.6, 1.6], size_over_life: [[0, 1], [1, 0.3]], color_over_life: [[0, '#ffe080'], [1, '#a02008']] }, { cell: 'fx:smoke_column', count: [1, 1], velocity: { dir: [0, 1, 0], cone_deg: 0, speed_mps: [0, 0] }, gravity_mps2: 0, drag: 0, lifetime_s: [999, 999], offset_m: [0, 0.6, 0], size_over_life: [[0, 1], [1, 1]], color_over_life: [[0, '#ffffff'], [1, '#ffffff']] }], notes: 'light intensity is per frame of the loop (same loop as the sheet); add a few random phase offsets between nearby fires' }),
  },
  sparks: {
    about: 'sparks loop: shower (broken wire / welding drip, source at the top) | arc (arcing cable between two contacts)',
    variants: ['shower', 'arc'],
    defaults: (o) => ({ cell: [48, 48], ...LOOP(16), fps: 20, blend: 'additive' }),
    ramps: (o) => ({ E: [E(o, 'spark'), E(o, 'energy')], M: [M('smoke')] }),
    build: (o) => { const r = rnd(o, 81); return { p: Array.from({ length: 16 }, (_, i) => ({ ph: (i + r() * 0.8) / 16, vx: (r() - 0.5) * 0.8, vy: range(r, -0.3, 0.2), b: r() })), s: seedOf(o.seed, 82), on: Array.from({ length: 64 }, () => r() < 0.6), burst: r() };},
    frame: (F, o, st, t) => {
      const { W, H } = F, k = Math.round(t * o.frames) % o.frames;
      const src = o.variant === 'arc' ? [W * 0.2, H * 0.35] : [W * 0.5, 3];
      if (o.variant === 'arc') {
        const B = [W * 0.8, H * 0.35];
        glow(F, ...src, 2, 0.9, { k: 1 }); glow(F, ...B, 2, 0.9, { k: 1 });
        if (st.on[k % 64]) { const pts = bolt(mulberry32(st.s + k), ...src, ...B, { iters: 4, jitter: 0.55 }); for (let i = 1; i < pts.length; i++) streak(F, ...pts[i - 1], ...pts[i], 1, 1.5, 1.5, 1); glow(F, W / 2, H * 0.35, W * 0.2, 0.35, { k: 1 }); }
      } else glow(F, ...src, 2.5, 0.8 + 0.5 * flick(t, st.burst, [2, 3, 7]));
      for (const p of st.p) {
        const a = frac(t + p.ph), T = a * 1.1, x = src[0] + p.vx * T * W * 0.6, y = src[1] + (p.vy * T + 0.5 * 2.2 * T * T) * H * 0.5;
        if (y > H - 2) { const bx = x + (p.b - 0.5) * 6 * (y - H + 2) / H; emit(F, bx, H - 2, (1 - a) * 1.2); continue; }
        const T0 = Math.max(0, T - 0.05), x0 = src[0] + p.vx * T0 * W * 0.6, y0 = src[1] + (p.vy * T0 + 0.5 * 2.2 * T0 * T0) * H * 0.5;
        streak(F, x0, y0, x, y, 1, (1 - a) * 0.6, (1 - a) ** 0.6 * 1.3);
      }
    },
    meta: (o) => ({ pivot: o.variant === 'arc' ? [o.cell[0] / 2, Math.round(o.cell[1] * 0.35)] : [o.cell[0] / 2, 3], facing: 'camera', size_m: 1.2, sound: o.variant === 'arc' ? ['glitch_tear'] : ['hit_light'], light: { color: o.variant === 'arc' ? LIGHT_HEX.energy : LIGHT_HEX.spark, radius_m: 3, intensity: Array.from({ length: o.frames + 1 }, (_, k) => [Math.round((k / o.fps) * 1000), o.variant === 'arc' ? (FX.sparks._on(o, k % o.frames) ? 2.5 : 0.3) : 1.2]), loop: true }, emitters: [{ cell: 'particles:spark', rate_per_s: 18, count: [1, 3], velocity: { dir: [0, -1, 0], cone_deg: 60, speed_mps: [0.5, 2] }, gravity_mps2: 9.81, drag: 0.5, lifetime_s: [0.3, 0.9], bounce: 0.35, size_over_life: [[0, 1], [1, 0.4]], color_over_life: [[0, '#fff6d0'], [1, '#c04010']] }] }),
    _on: (o, k) => FX.sparks.build(o).on[k % 64],
  },
  steam: {
    about: 'steam vent loop (pressurised jet pointing up, pivot = the vent)',
    variants: ['vent', 'leak'],
    defaults: (o) => ({ cell: [48, 48], ...LOOP(16), fps: 15, blend: 'alpha' }),
    ramps: () => ({ E: [heatRamp(200)], M: [M('steam', { steps: 4, spread: 0.35 })] }),
    build: (o) => { const r = rnd(o, 91); return { p: Array.from({ length: 16 }, (_, i) => ({ ph: (i + r() * 0.7) / 16, x: r() - 0.5, s: range(r, 0.8, 1.2), w: r() })) }; },
    frame: (F, o, st, t) => {
      const { W, H } = F, leak = o.variant === 'leak';
      for (const p of st.p) {
        const a = frac(t * 2 + p.ph), sp = leak ? [W * 0.85 * a, -a * a * H * 0.3] : [p.x * 6 * a + Math.sin(TAU * (a + p.w)) * 2 * a, -a * (H - 8)];
        puff(F, (leak ? 3 : W / 2) + sp[0], (leak ? H * 0.6 : H - 3) + sp[1], (1 + a * (leak ? 7 : 9)) * p.s, smooth01(a / 0.1) * (1 - a) ** 1.4 * 1.2, { m: 0, lift: 0.4 });
      }
    },
    meta: (o) => ({ pivot: o.variant === 'leak' ? [3, Math.round(o.cell[1] * 0.6)] : [o.cell[0] / 2, o.cell[1] - 3], facing: o.variant === 'leak' ? 'camera_axis' : 'camera_up', size_m: 1.5, sound: [], light: null, emitters: [], notes: 'no art_audio recipe yet for a steam hiss: layer a filtered noise sfx' }),
  },
  strobe: {
    about: 'alarm strobe glow card loop: red | amber | blue | green; mode pulse (double flash) | beacon (rotating)',
    variants: ['red', 'amber', 'blue', 'green'],
    defaults: (o) => ({ cell: [64, 64], ...LOOP(16), fps: 16, blend: 'additive' }),
    ramps: (o) => ({ E: [E(o, o.variant, { steps: 5, drift: 20 })], M: [M('smoke')] }),
    build: () => ({}),
    frame: (F, o, st, t) => {
      const { W, H } = F, cx = W / 2, cy = H / 2, I = FX.strobe._I(o, t);
      if (I <= 0.02) return;
      glow(F, cx, cy, W * 0.46 * (0.7 + 0.3 * I), I * 1.1, { p: 2.2 });
      glow(F, cx, cy, W * 0.12, I * 1.5);
      for (let x = 0; x < W; x++) { const u = Math.abs(x + 0.5 - cx) / (W / 2); emit(F, x, cy, I * (1 - u) ** 1.5 * 0.9); emit(F, x, cy - 1, I * (1 - u) ** 2 * 0.4); }
    },
    _I: (o, t) => (t = frac(t), o.mode === 'beacon' ? Math.max(0, Math.cos(TAU * t)) ** 3 : (t < 0.0625 || (t >= 0.1875 && t < 0.25) ? 1 : 0.04)),
    meta: (o) => ({ pivot: [o.cell[0] / 2, o.cell[1] / 2], facing: 'camera', size_m: 1, sound: ['alarm_klaxon'], light: { color: { red: '#ff3020', amber: '#ffa020', blue: '#3070ff', green: '#30ff60' }[o.variant], radius_m: 6, intensity: Array.from({ length: o.frames + 1 }, (_, k) => [Math.round((k / o.fps) * 1000), +(3 * FX.strobe._I(o, (k % o.frames) / o.frames)).toFixed(3)]), loop: true }, emitters: [], notes: 'light intensity is sampled per frame of the loop: drive the point light with the same frame index' }),
  },
  haze: {
    about: 'heat-haze distortion mask loop (R,G = screen offset, 128 = none; A = strength): flame (radial, over fire / exhaust) | sheet (tileable)',
    variants: ['flame', 'sheet'],
    defaults: (o) => ({ cell: [64, 64], ...LOOP(16), fps: 15, blend: 'distortion' }),
    ramps: () => ({ E: [heatRamp(0)], M: [[[128, 128, 128]]] }),
    build: (o) => ({ fx: tileFbm(seedOf(o.seed, 101), o.cell[0], 4, 3), fy: tileFbm(seedOf(o.seed, 102), o.cell[0], 4, 3) }),
    raw: (o, st, t) => {
      const [W, H] = o.cell, out = new Uint8ClampedArray(W * H * 4), sh = t * H;
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const yy = (((y + sh) % H) + H) % H, dx = st.fx(x, yy) - 0.55, dy = st.fy(x, yy) - 0.55, i = (y * W + x) * 4;
        const m = o.variant === 'sheet' ? 1 : clamp01(1 - Math.hypot((x + 0.5 - W / 2) / (W / 2), ((y + 0.5) - H) / H)) ** 0.8;
        const q = Math.floor(m * 4 + bayer(x, y)) / 4;
        out[i] = Math.round(128 + dx * 200); out[i + 1] = Math.round(128 + dy * 200); out[i + 2] = 128; out[i + 3] = Math.round(q * 255);
      }
      return out;
    },
    meta: (o) => ({ pivot: o.variant === 'flame' ? [o.cell[0] / 2, o.cell[1] - 1] : [o.cell[0] / 2, o.cell[1] / 2], facing: 'camera_up', size_m: 2, sound: [], light: null, emitters: [], palette_locked: false, notes: 'not a colour sheet: in a post pass, offset the scene UV by (rg - 0.5) * strength_px * a; scrolls upward over the loop; tileable when variant is "sheet"' }),
  },
  particles: {
    about: 'particle cells (8x8 each) the emitter hints reference as particles:<name>',
    variants: ['default'],
    defaults: () => ({ cell: [8, 8], frames: 10, loop: false, fps: 1, blend: 'mixed' }),
    cells: ['spark', 'ember', 'glint', 'hex', 'chip', 'shard', 'droplet', 'dust', 'blood', 'smoke'],
    cellBlend: { spark: 'additive', ember: 'additive', glint: 'additive', hex: 'additive', chip: 'alpha', shard: 'alpha', droplet: 'alpha', dust: 'alpha', blood: 'alpha', smoke: 'alpha' },
    ramps: (o) => ({ E: [E(o, 'spark'), E(o, 'fire'), E(o, 'energy')], M: [M('chips', { steps: 3 }), M('glass', { steps: 3 }), M('water', { steps: 3 }), M('concrete', { steps: 3 }), M('blood', { steps: 3 }), M('smoke', { steps: 3 })] }),
    build: () => ({}),
    frame: (F, o, st, t, k) => {
      const c = 4;
      switch (FX.particles.cells[k]) {
        case 'spark': glow(F, c, c, 2.2, 1.4); streak(F, c - 3, c, c + 3, c, 1, 0.6, 0.6); streak(F, c, c - 3, c, c + 3, 1, 0.6, 0.6); break;
        case 'ember': glow(F, c, c, 2.4, 1.2, { k: 1 }); break;
        case 'glint': streak(F, c - 3.5, c, c + 3.5, c, 1, 0.9, 0.9, 2); streak(F, c, c - 3.5, c, c + 3.5, 1, 0.9, 0.9, 2); glow(F, c, c, 1.4, 1.5, { k: 2 }); break;
        case 'hex': { const pts = Array.from({ length: 6 }, (_, i) => [c + Math.cos(i * TAU / 6 + Math.PI / 6) * 3.4, c + Math.sin(i * TAU / 6 + Math.PI / 6) * 3.4]); for (let i = 0; i < 6; i++) streak(F, ...pts[i], ...pts[(i + 1) % 6], 1, 1.1, 1.1, 2); break; }
        case 'chip': poly(F, [[2, 3], [5, 1.5], [6.5, 4.5], [4, 6.5], [1.5, 5.5]], (x, y) => matter(F, x, y, 2, 0.9 - (x + y) / 14, 0)); break;
        case 'shard': poly(F, [[1.5, 6.5], [4, 0.8], [6.8, 5]], (x, y) => matter(F, x, y, 2, 0.95 - y / 10, 1)); emit(F, 4, 1, 1.3, 0); break;
        case 'droplet': puff(F, c, c + 0.5, 2.6, 2, { m: 2, lift: 0.4 }); break;
        case 'dust': puff(F, c, c, 3.6, 1.4, { m: 3 }); break;
        case 'blood': puff(F, c, c, 3, 1.6, { m: 4 }); break;
        case 'smoke': puff(F, c, c, 3.8, 1.5, { m: 5 }); break;
      }
    },
    meta: () => ({ pivot: [4, 4], facing: 'camera', size_m: 0.05, sound: [], light: null, emitters: [], cells: FX.particles.cells, cell_blend: FX.particles.cellBlend, notes: 'one static cell per particle kind (not a flipbook), laid out like frames: cell i at column i % grid[0], row floor(i / grid[0])' }),
  },
};
export const FX_TYPES = Object.keys(FX);
export { flick };
