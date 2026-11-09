// SFX recipes for a hardcore sci-fi FPS: firearms (layered crack / body / sub / mechanics /
// environment tail), weapon handling, sci-fi weapons and UI, and footsteps. Each recipe is
// (rng, v, j) -> {layers, fx?, reverb?, target?, tail?, loop?} like the ones in sfx.js; the layer
// helpers are passed in so this module has no import cycle with sfx.js.
// vars (all optional): pitch (semitones), length (x), intensity 0..1, variation 0..1, wet 0..1,
// reverb; firearms: environment "outdoor"|"indoor"|"canyon", distance "near"|"far" (recorded only); casing_drop: surface "metal"|"concrete";
// footstep: surface "metal"|"dirt"|"concrete"|"snow"|"grate".

import { gunBank } from './samples.js';

export const ENVIRONMENTS = ['outdoor', 'indoor', 'canyon'];
export const DISTANCES = ['near', 'far'];
export const CASING_SURFACES = ['metal', 'concrete'];
export const FOOT_SURFACES = ['metal', 'dirt', 'concrete', 'snow', 'grate'];

// firearm profiles: crack (s), crackF, body (s), bodyFrom/To (Hz), thumpF/thumpD, sub Hz + gain, mechanics, drive, tail scale
const GUNS = {
  rifle: { crack: 0.008, crackF: 13000, body: 0.14, bodyFrom: 6000, bodyTo: 450, thumpF: 110, thumpD: 0.12, sub: 50, subG: -8, mechF: 3400, mechG: -16, drive: 10, tail: 1 },
  pistol: { crack: 0.006, crackF: 12000, body: 0.09, bodyFrom: 5000, bodyTo: 600, thumpF: 160, thumpD: 0.08, sub: 62, subG: -14, mechF: 2900, mechG: -14, drive: 8, tail: 0.8 },
  marksman: { crack: 0.012, crackF: 14000, body: 0.2, bodyFrom: 7000, bodyTo: 350, thumpF: 90, thumpD: 0.16, sub: 44, subG: -6, mechF: 3000, mechG: -18, drive: 12, tail: 1.8, slap: true },
  shotgun: { crack: 0.01, crackF: 9000, body: 0.26, bodyFrom: 4500, bodyTo: 300, thumpF: 80, thumpD: 0.18, sub: 42, subG: -4, mechF: 2200, mechG: -18, drive: 14, tail: 1.2, color: 'brown' },
  smg: { crack: 0.005, crackF: 12000, body: 0.06, bodyFrom: 5500, bodyTo: 700, thumpF: 175, thumpD: 0.06, sub: 65, subG: -16, mechF: 3800, mechG: -12, drive: 8, tail: 0.6 },
  lmg: { crack: 0.009, crackF: 12500, body: 0.16, bodyFrom: 6000, bodyTo: 400, thumpF: 100, thumpD: 0.13, sub: 48, subG: -6, mechF: 2600, mechG: -11, drive: 12, tail: 1 },
  suppressed: { crack: 0.004, crackF: 4000, body: 0.07, bodyFrom: 2500, bodyTo: 300, thumpF: 140, thumpD: 0.06, sub: 70, subG: -20, mechF: 3200, mechG: -7, drive: 3, tail: 0.35, suppressed: true },
};

export function fpsRecipes({ V, thump, burst, whoosh }) {
  // metallic hit (modal), tiny transient tick, filtered scrape
  const clank = (f, dur, o = {}) => V({ sources: [{ type: 'modal', modes: o.modes || [[1, 1, 0.6], [2.32, 0.6, 0.4], [4.25, 0.4, 0.25], [6.63, 0.25, 0.15]], fixed: f, strike: o.strike ?? 0.6 }], amp: { a: 0.0005, d: 0, s: 1, r: dur * 0.5 }, oneshot: dur }, { gain: o.gain ?? 0, at: o.at ?? 0 });
  const tick = (o = {}) => burst({ dur: o.dur ?? 0.004, from: 11000, to: 3000, type: 'hp' }, { gain: o.gain ?? -6, at: o.at ?? 0 });
  const scrape = (dur, f, o = {}) => V({ sources: [{ type: 'noise', color: 'white' }], filter: { type: 'bp', cutoff: f, q: 3, lfo: { rate: 30, depth: 0.4, shape: 'random' } }, amp: { a: 0.008, d: dur, s: 0.6, r: 0.02 }, oneshot: dur }, { gain: o.gain ?? -10, at: o.at ?? 0 });
  const glide = (o) => ({ kind: 'glide', ...o });

  // environment tail: slapback / room / canyon echoes. Returns {fx, reverb, tail}.
  const environment = (v, j, ts, quiet = 1) => {
    const env = v.environment || 'outdoor', w = (v.wet ?? 0.7) * quiet;
    if (!ENVIRONMENTS.includes(env)) throw new Error(`environment must be ${ENVIRONMENTS.join('|')} (got "${env}")`);
    if (env === 'indoor') return { fx: [{ type: 'delay', time: j(0.035), feedback: 0.3, mix: 0.2 * w, lp: 5000, hp: 200, pingpong: true }], reverb: { preset: 'room', wet: 0.3 * w }, tail: 0.6 + 0.3 * ts };
    if (env === 'canyon') return { fx: [{ type: 'delay', time: j(0.45 * (1 + 0.2 * ts)), feedback: 0.5, mix: 0.45 * w, lp: 1800, hp: 150, pingpong: true }], reverb: { preset: 'cathedral', wet: 0.12 * w }, tail: 1.5 + 2 * ts };
    const slap = ts > 1.5; // marksman: long outdoor slapback
    return { fx: [{ type: 'delay', time: j(slap ? 0.38 : 0.16 + 0.1 * ts), feedback: slap ? 0.42 : 0.22, mix: (slap ? 0.42 : 0.32) * w, lp: slap ? 2200 : 2800, hp: 200, pingpong: true }], reverb: { preset: 'hall', wet: 0.08 * w }, tail: 0.6 + 1.1 * ts };
  };

  const gun = (P) => (r, v, j) => {
    const L = v.len, I = v.intensity, ts = P.tail * L;
    const layers = [];
    if (P.suppressed) layers.push(burst({ dur: 0.03 * L, from: j(3500), to: 600, color: 'pink', type: 'bp', q: 1.2 }, { gain: -2 }));
    else layers.push(burst({ dur: P.crack * L, from: j(P.crackF), to: 2500, type: 'hp' }, { gain: -1 + 3 * (I - 0.6) }));
    layers.push(
      burst({ dur: P.body * L, from: j(P.bodyFrom), to: P.bodyTo, color: P.color || 'pink', q: 0.7 }, { gain: -3 }),
      thump(j(P.thumpF) * v.pf, P.thumpD * L, { drop: 16, time: 0.02, gain: -4 }),
      thump(P.sub * v.pf, 0.3 * L * Math.max(0.6, P.tail), { drop: 8, time: 0.05, gain: P.subG + 4 * (I - 0.6) }),
      clank(j(P.mechF), 0.05, { gain: P.mechG, at: 0.002 }),
      { kind: 'crackle', dur: 0.05, density: 60, f: P.mechF, metal: true, gain: P.mechG - 4, at: 0.02 },
    );
    const env = environment(v, j, ts, P.suppressed ? 0.4 : 1);
    return {
      layers,
      fx: [{ type: 'drive', drive: P.drive + 8 * I }, { type: 'transient', attack: 5 }, { type: 'eq', bands: [{ type: 'hp', f: 30 }, { type: 'peak', f: 2500, q: 1, gain: 2 }] }, ...env.fx, { type: 'dc' }],
      reverb: env.reverb, tail: env.tail,
    };
  };

  // recorded firearms (CC0 field recordings, src/audio/samples/guns): the seed picks the shot (played at its recorded
  // pitch: no per-variant pitch jitter; vars.pitch still shifts it), length / intensity shape it, distance near|far picks the close or the distant recording; outdoor = as recorded (real tail), indoor /
  // canyon add a room / echoes on top
  const recEnv = (v, j, quiet = 1) => {
    const env = v.environment || 'outdoor', w = (v.wet ?? 0.7) * quiet;
    if (!ENVIRONMENTS.includes(env)) throw new Error(`environment must be ${ENVIRONMENTS.join('|')} (got "${env}")`);
    if (env === 'indoor') return { fx: [{ type: 'eq', bands: [{ type: 'lp', f: 9000 }] }, { type: 'delay', time: j(0.03), feedback: 0.35, mix: 0.5 * w, lp: 4500, hp: 200, pingpong: true }], reverb: { preset: 'crypt', wet: 0.75 * w }, tail: 1.2 };
    if (env === 'canyon') return { fx: [{ type: 'delay', time: j(0.5), feedback: 0.5, mix: 0.45 * w, lp: 1800, hp: 150, pingpong: true }], reverb: { preset: 'cathedral', wet: 0.1 * w }, tail: 2.5 };
    return { fx: [], reverb: null, tail: 0.05 };
  };
  const recorded = (cls) => (r, v, j) => {
    const dist = v.distance || 'near';
    if (!DISTANCES.includes(dist)) throw new Error(`distance must be ${DISTANCES.join('|')} (got "${dist}")`);
    const env = recEnv(v, j);
    return {
      layers: [{ kind: 'sample', sample: gunBank()[cls][dist], pitch: v.pitch_set ?? 0, ...(v.len < 0.98 ? { dur: (dist === 'far' ? 2.2 : 1.4) * v.len } : {}), gain: 3 * (v.intensity - 0.6) }],
      fx: [...env.fx, { type: 'dc' }], reverb: env.reverb, tail: env.tail,
    };
  };
  // suppressed (no suppressed recording exists in the bank): a recorded pistol / rifle shot without its blast
  // (low-passed, short) + the action's metal clack
  const suppressed = (r, v, j) => {
    const env = recEnv(v, j, 0.4);
    return {
      layers: [
        { kind: 'sample', sample: gunBank()[v.caliber === 'rifle' ? 'rifle' : 'pistol'].near, pitch: v.pitch - 2, dur: 0.35 * v.len, gain: -4 + 3 * (v.intensity - 0.6) },
        clank(j(3200) * v.pf, 0.05, { gain: -9, at: 0.002 }),
        { kind: 'crackle', dur: 0.05, density: 60, f: 3200, metal: true, gain: -14, at: 0.02 },
      ],
      fx: [{ type: 'eq', bands: [{ type: 'hp', f: 180 }, { type: 'lp', f: 2200 }] }, ...env.fx, { type: 'dc' }], reverb: env.reverb, tail: Math.min(env.tail, 0.4) + 0.05,
    };
  };

  const bounce = (surface, v, j) => {
    if (!CASING_SURFACES.includes(surface)) throw new Error(`casing_drop surface must be ${CASING_SURFACES.join('|')} (got "${surface}")`);
    const L = [], n = 4 + (v.variation > 0.3 ? 1 : 0);
    let t = 0;
    for (let k = 0; k < n; k++) {
      const g = [0, -5, -9, -13, -16][k] ?? -18;
      L.push(clank(j(5200) * v.pf, surface === 'metal' ? 0.35 : 0.12, { gain: g, at: t, modes: [[1, 1, 0.5], [2.7, 0.5, 0.3], [5.1, 0.3, 0.2]] }));
      if (surface === 'concrete') L.push(tick({ at: t, gain: g - 4, dur: 0.003 }));
      else if (k === 0) L.push(clank(j(900) * v.pf, 0.15, { gain: -8, at: t }));
      t += j(0.11) * v.len * Math.pow(0.55, k);
    }
    if (surface === 'metal') L.push({ kind: 'crackle', dur: 0.2 * v.len, density: 30, f: 6000, metal: true, gain: -16, at: t });
    return L;
  };

  const step = (surface, r, v, j) => {
    if (!FOOT_SURFACES.includes(surface)) throw new Error(`footstep surface must be ${FOOT_SURFACES.join('|')} (got "${surface}")`);
    const pf = v.pf, L = v.len, I = v.intensity;
    const heel = 0, toe = j(0.05) * L;
    const scuff = burst({ dur: 0.05 * L, from: 3000, to: 1200, color: 'pink', type: 'bp' }, { gain: -12, at: toe });
    switch (surface) {
      case 'concrete': return { layers: [thump(j(110) * pf, 0.05, { drop: 6, gain: -4 + 2 * I, at: heel }), burst({ dur: 0.035 * L, from: j(6000), to: 900, type: 'bp' }, { gain: -2 }), scuff], reverb: { preset: 'room', wet: 0.05 } };
      case 'dirt': return { layers: [thump(j(90) * pf, 0.06, { drop: 6, gain: -2 }), burst({ dur: 0.07 * L, from: j(2500), to: 300, color: 'brown' }, { gain: -3 }), { kind: 'crackle', dur: 0.08 * L, density: 320, f: j(1800), q: 0.8, gain: -4, at: 0.005 }, scuff] };
      case 'metal': return { layers: [thump(j(140) * pf, 0.05, { drop: 6, gain: -3 }), clank(j(700) * pf, 0.25, { gain: -4 }), clank(j(1900) * pf, 0.12, { gain: -10, at: toe }), burst({ dur: 0.02, from: 8000, to: 2000, type: 'hp' }, { gain: -8 })], reverb: { preset: 'room', wet: 0.08 } };
      case 'snow': return { layers: [{ kind: 'crackle', dur: 0.16 * L, density: 600, f: j(2800), q: 0.7, click: 0.001, gain: 0 }, burst({ dur: 0.1 * L, from: 1200, to: 300, color: 'brown' }, { gain: -6 }), thump(j(80) * pf, 0.05, { drop: 4, gain: -10 })], fx: [{ type: 'eq', bands: [{ type: 'lp', f: 7000 }] }] };
      default: return { layers: [thump(j(120) * pf, 0.05, { drop: 6, gain: -4 }), clank(j(900) * pf, 0.18, { gain: -3 }), { kind: 'crackle', dur: 0.15 * L, density: 80, f: j(2500), metal: true, gain: -6, at: 0.01 }, scuff], reverb: { preset: 'room', wet: 0.08 } };
    }
  };

  return {
    // ---- firearms ----
    // recorded (default) + the synthesized originals as *_synth (unchanged)
    gunshot_rifle: recorded('rifle'), gunshot_pistol: recorded('pistol'), gunshot_marksman: recorded('marksman'), gunshot_shotgun: recorded('shotgun'),
    gunshot_smg: recorded('smg'), gunshot_lmg: recorded('lmg'), gunshot_suppressed: suppressed, gunshot_revolver: recorded('revolver'),
    gunshot_rifle_synth: gun(GUNS.rifle), gunshot_pistol_synth: gun(GUNS.pistol), gunshot_marksman_synth: gun(GUNS.marksman), gunshot_shotgun_synth: gun(GUNS.shotgun),
    gunshot_smg_synth: gun(GUNS.smg), gunshot_lmg_synth: gun(GUNS.lmg), gunshot_suppressed_synth: gun(GUNS.suppressed),
    // ---- weapon handling ----
    mag_out: (r, v, j) => ({ layers: [clank(j(2600) * v.pf, 0.06, { gain: -2 }), tick(), scrape(0.09 * v.len, j(3200), { at: 0.01 }), thump(j(320) * v.pf, 0.05, { drop: 6, gain: -8, at: 0.07 * v.len }), clank(j(1400) * v.pf, 0.08, { at: 0.075 * v.len, gain: -6 })], reverb: { preset: 'room', wet: 0.06 }, target: -3 }),
    mag_in: (r, v, j) => { const t = 0.06 * v.len; return { layers: [scrape(t, j(2800), { gain: -12 }), clank(j(1800) * v.pf, 0.1, { at: t }), thump(j(260) * v.pf, 0.06, { at: t, gain: -4, drop: 8 }), tick({ at: t, gain: -4 }), clank(j(3600) * v.pf, 0.03, { at: t + 0.04 * v.len, gain: -8 })], reverb: { preset: 'room', wet: 0.06 }, target: -3 }; },
    bolt_rack: (r, v, j) => { const t2 = 0.2 * v.len; return { layers: [clank(j(2200) * v.pf, 0.05, { gain: -3 }), scrape(0.12 * v.len, j(2800), { at: 0.01 }), clank(j(3000) * v.pf, 0.04, { at: 0.12 * v.len, gain: -6 }), tick({ at: t2, gain: -2 }), clank(j(1600) * v.pf, 0.12, { at: t2 }), thump(j(220) * v.pf, 0.06, { at: t2, gain: -5, drop: 8 }), clank(j(4200) * v.pf, 0.06, { at: t2 + 0.004, gain: -10 })], reverb: { preset: 'room', wet: 0.06 }, target: -2 }; },
    dry_fire: (r, v, j) => ({ layers: [tick({ gain: -4 }), clank(j(3400) * v.pf, 0.03, { gain: -3 }), thump(j(600) * v.pf, 0.015, { drop: 4, gain: -12 })], target: -6 }),
    shotgun_pump: (r, v, j) => { const t2 = j(0.24) * v.len; return { layers: [clank(j(1500) * v.pf, 0.06), thump(j(240) * v.pf, 0.07, { drop: 6, gain: -4 }), scrape(0.12 * v.len, j(1800), { at: 0.01, gain: -12 }), clank(j(1300) * v.pf, 0.09, { at: t2 }), thump(j(200) * v.pf, 0.08, { at: t2, gain: -3, drop: 6 }), tick({ at: t2, gain: -3 })], reverb: { preset: 'room', wet: 0.06 }, target: -2 }; },
    casing_drop: (r, v, j) => ({ layers: bounce(v.surface || 'concrete', v, j), reverb: { preset: 'room', wet: 0.08 * v.wet }, target: -4 }),
    // ---- sci-fi ----
    laser_bolt: (r, v, j) => ({ layers: [glide({ wave: 'saw', pts: [[0, j(2400) * v.pf], [0.18 * v.len, 300 * v.pf]], dur: 0.18 * v.len, a: 0.001, r: 0.04, decay: 0.08 * v.len, lp: 7000, gain: -2 }), glide({ wave: 'square', pts: [[0, j(1200) * v.pf], [0.15 * v.len, 180 * v.pf]], dur: 0.15 * v.len, decay: 0.06 * v.len, gain: -8 }), burst({ dur: 0.02, from: 9000, to: 2000, type: 'hp' }, { gain: -10 }), thump(j(140) * v.pf, 0.06, { drop: 12, gain: -10 })], fx: [{ type: 'drive', drive: 4 + 6 * v.intensity }, { type: 'delay', time: 0.06, feedback: 0.3, mix: 0.25 * v.wet, lp: 5000, hp: 150 }, { type: 'eq', bands: [{ type: 'hp', f: 80 }] }], tail: 0.4 }),
    plasma_shot: (r, v, j) => ({ layers: [V({ sources: [{ type: 'fm', fixed: j(220) * v.pf, ratio: 1.5, index: 6, index_decay: 0.08 }], pitch_env: { amount: 14, time: 0.06 }, filter: { type: 'lp', cutoff: 800, q: 4, env_amount: 3, env: { a: 0.001, d: 0.2, s: 0, r: 0.05 } }, amp: { a: 0.002, d: 0.35 * v.len, s: 0, r: 0.06 }, oneshot: 0.3 * v.len }), whoosh({ dur: 0.35 * v.len, from: 3000, to: 300, q: 1.5 }, { gain: -6 }), thump(j(90) * v.pf, 0.15, { drop: 16, gain: -4 }), { kind: 'crackle', dur: 0.25 * v.len, density: 40 + 120 * v.intensity, f: 4000, gain: -14 }], fx: [{ type: 'saturate', drive: 6 }, { type: 'eq', bands: [{ type: 'hp', f: 40 }] }], reverb: { preset: 'room', wet: 0.12 * v.wet } }),
    shield_hit: (r, v, j) => ({ layers: [burst({ dur: 0.03, from: 12000, to: 3000, type: 'hp' }, { gain: -2 }), { kind: 'crackle', dur: 0.35 * v.len, density: 100 + 400 * v.intensity, f: j(3500), q: 0.8, gain: -4 }, glide({ wave: 'saw', pts: [[0, j(180) * v.pf], [0.5 * v.len, 150 * v.pf]], dur: 0.5 * v.len, a: 0.002, r: 0.15, decay: 0.25 * v.len, am: { rate: j(38), depth: 0.7 }, lp: 2500, gain: -6 }), clank(j(880) * v.pf, 0.5, { gain: -12, modes: [[1, 1, 1.2], [1.5, 0.5, 0.8], [2.02, 0.4, 0.6]] })], fx: [{ type: 'eq', bands: [{ type: 'hp', f: 60 }] }], reverb: { preset: 'hall', wet: 0.1 * v.wet } }),
    glitch_tear: (r, v, j) => ({ layers: [{ kind: 'glitch', dur: 0.6 * v.len, density: v.intensity, f: j(1200) * v.pf }], fx: [{ type: 'bitcrush', bits: Math.max(3, Math.round(7 - 3 * v.intensity)), rate: 8000 + 6000 * (1 - v.intensity) }, { type: 'eq', bands: [{ type: 'hp', f: 100 }] }, { type: 'dc' }] }),
    teleport_swell: (r, v, j) => { const T = 1.2 * v.len; return { layers: [whoosh({ dur: T, from: 150, to: j(6000), q: 3 }, { gain: -4 }), glide({ wave: 'sine', pts: [[0, 200 * v.pf], [T, j(1600) * v.pf]], dur: T, a: T * 0.6, r: 0.05, vib: { rate: 7, depth: 25 }, gain: -6 }), glide({ wave: 'tri', pts: [[0, 300 * v.pf], [T, j(2400) * v.pf]], dur: T, a: T * 0.7, r: 0.05, gain: -10 }), { kind: 'crackle', dur: T, density: 40, f: 6000, metal: true, gain: -14 }, burst({ dur: 0.05, from: 10000, to: 1500 }, { at: T, gain: 0 }), thump(j(120) * v.pf, 0.2, { at: T, drop: 12, gain: -4 })], fx: [{ type: 'chorus' }], reverb: { preset: 'hall', wet: 0.3 * v.wet } }; },
    servo: (r, v, j) => { const T = 0.48 * v.len, f = j(260) * v.pf; return { layers: [glide({ wave: 'saw', pts: [[0, f], [0.08, f * 1.6], [T * 0.85, f * 1.75], [T, f * 1.15]], dur: T, a: 0.02, r: 0.05, am: { rate: j(90), depth: 0.25 }, lp: 2200, gain: -2 }), glide({ noise: true, bp: j(1800), q: 2, dur: T, a: 0.02, r: 0.04, am: { rate: j(60), depth: 0.6 }, gain: -12 }), clank(j(2400) * v.pf, 0.04, { at: T, gain: -12 })], fx: [{ type: 'eq', bands: [{ type: 'hp', f: 120 }, { type: 'peak', f: 1500, q: 1, gain: 2 }] }], target: -3 }; },
    drone_rotor: (r, v, j) => { const D = 2 * v.len, br = Math.max(1, Math.round(j(24) * v.pf * D)) / D, f = j(180) * v.pf; return { layers: [glide({ wave: 'saw', f, dur: D + 0.3, a: 0.001, r: 0.01, am: { rate: br, depth: 0.5 }, lp: 1800, gain: -6 }), glide({ wave: 'sine', f: f * 2, dur: D + 0.3, a: 0.001, r: 0.01, gain: -10 }), glide({ noise: true, color: 'pink', bp: j(1200), q: 1, dur: D + 0.3, a: 0.001, r: 0.01, am: { rate: br, depth: 0.8 }, gain: -3 + 3 * v.intensity })], fx: [{ type: 'eq', bands: [{ type: 'hp', f: 50 }] }], loop: { length: D, crossfade: 0.15 } }; },
    hologram_ui: (r, v, j) => ({ layers: [glide({ wave: 'sine', pts: [[0, j(1200) * v.pf], [0.12 * v.len, 1900 * v.pf]], dur: 0.12 * v.len, a: 0.005, r: 0.08, am: { rate: 30, depth: 0.3 }, gain: -2 }), glide({ wave: 'tri', pts: [[0, 1800 * v.pf], [0.1 * v.len, 2850 * v.pf]], dur: 0.1 * v.len, a: 0.005, r: 0.06, gain: -8, at: 0.04 }), { kind: 'crackle', dur: 0.2 * v.len, density: 50, f: 7000, metal: true, gain: -16 }], fx: [{ type: 'chorus' }], reverb: { preset: 'room', wet: 0.15 * v.wet }, target: -3 }),
    alarm_klaxon: (r, v, j) => { const T = 0.6 * v.len, f = j(440) * v.pf, L = []; for (let k = 0; k < 3; k++) L.push(glide({ wave: 'saw', pts: [[0, f], [T * 0.75, f * 1.26]], dur: T * 0.85, a: 0.01, r: 0.03, at: k * T, gain: 0 }), glide({ wave: 'square', pts: [[0, f / 2], [T * 0.75, f * 0.63]], dur: T * 0.85, a: 0.01, r: 0.03, at: k * T, gain: -8 })); return { layers: L, fx: [{ type: 'drive', drive: 6 + 6 * v.intensity }, { type: 'eq', bands: [{ type: 'hp', f: 200 }, { type: 'peak', f: 1200, q: 1, gain: 4 }, { type: 'lp', f: 5000 }] }], loop: { length: 2 * T, crossfade: 0.05 }, tail: 0.2 }; },
    radio_squelch_on: (r, v, j) => ({ layers: [tick({ gain: -2 }), glide({ noise: true, bp: j(1800), q: 1.2, dur: 0.08 * v.len, a: 0.001, r: 0.02, gain: -4 }), glide({ wave: 'sine', f: j(1250) * v.pf, dur: 0.07, a: 0.002, r: 0.01, at: 0.07 * v.len, gain: -6 })], fx: [{ type: 'bitcrush', bits: 10, rate: 16000 }, { type: 'eq', bands: [{ type: 'hp', f: 300 }, { type: 'lp', f: 3500 }] }], target: -3 }),
    radio_squelch_off: (r, v, j) => ({ layers: [tick({ gain: -2 }), glide({ noise: true, bp: j(2200), q: 0.9, dur: 0.18 * v.len, a: 0.001, r: 0.05, decay: 0.1 * v.len, gain: 0 })], fx: [{ type: 'bitcrush', bits: 9, rate: 14000 }, { type: 'eq', bands: [{ type: 'hp', f: 300 }, { type: 'lp', f: 3500 }] }], target: -3 }),
    bullet_whiz: (r, v, j) => { const D = 0.3 * v.len, pts = [[0, j(3200) * v.pf], [D * 0.5, 2400 * v.pf], [D, 1500 * v.pf]]; return { layers: [glide({ wave: 'sine', pts, dur: D, a: 0.001, r: 0.03, env: 'swell', gain: -6, pan: -0.3 }), glide({ noise: true, track: true, q: 4, pts, dur: D * 0.5, a: 0.001, r: 0.02, env: 'swell', gain: 0, pan: -0.6 }), glide({ noise: true, track: true, q: 4, pts: pts.slice(1).map(([t, f]) => [t - D * 0.5, f]), dur: D * 0.5, a: 0.001, r: 0.03, env: 'swell', gain: -2, pan: 0.6, at: D * 0.5 })] }; },
    ricochet: (r, v, j) => ({ layers: [burst({ dur: 0.006, from: 12000, to: 3000, type: 'hp' }, { gain: 0 }), glide({ wave: 'sine', pts: [[0, j(3000) * v.pf], [0.5 * v.len, 1700 * v.pf]], dur: 0.5 * v.len, a: 0.002, r: 0.1, vib: { rate: j(25), depth: 40 }, decay: 0.35 * v.len, gain: -4 }), glide({ noise: true, bp: 3500, q: 2, dur: 0.3 * v.len, env: 'swell', gain: -10 }), clank(j(2600) * v.pf, 0.1, { gain: -8 })], fx: [{ type: 'delay', time: 0.14, feedback: 0.2, mix: 0.2 * v.wet, lp: 3000, hp: 200 }], reverb: { preset: 'hall', wet: 0.12 * v.wet }, tail: 0.8 }),
    // ---- steam (art_fx steam vent / leak) ----
    // hiss: a pressurised one-shot burst (onset, broadband body, high sizzle, falling pressure)
    steam_hiss: (r, v, j) => { const T = 0.9 * v.len; return { layers: [burst({ dur: 0.02, from: 9000, to: 4000, type: 'hp' }, { gain: -6 }), glide({ noise: true, color: 'white', bp: j(5600) * v.pf, q: 0.8, dur: T, a: 0.012, r: 0.25 * v.len, decay: 0.7 * v.len, gain: -1 }), glide({ noise: true, color: 'white', bp: j(8500) * v.pf, q: 1.4, dur: T * 0.8, a: 0.01, r: 0.2, decay: 0.45 * v.len, am: { rate: j(23), depth: 0.2 }, gain: -7 }), glide({ noise: true, color: 'pink', bp: j(900) * v.pf, q: 0.8, dur: T * 0.6, a: 0.008, r: 0.15, decay: 0.3 * v.len, gain: -10 + 4 * v.intensity })], fx: [{ type: 'eq', bands: [{ type: 'hp', f: 300 }, { type: 'peak', f: 3200, q: 0.9, gain: -5 }] }, { type: 'dc' }], reverb: { preset: 'room', wet: 0.08 * v.wet }, target: -3 }; },
    // vent: steady broadband roar + hiss with a slow pressure wobble; seamless loop
    steam_vent: (r, v, j) => { const D = 2 * v.len, w = Math.max(1, Math.round(j(0.7) * D)) / D; return { layers: [glide({ noise: true, color: 'white', bp: j(5200) * v.pf, q: 0.7, dur: D + 0.3, a: 0.001, r: 0.01, am: { rate: w, depth: 0.25 }, gain: -2 }), glide({ noise: true, color: 'pink', bp: j(700) * v.pf, q: 0.7, dur: D + 0.3, a: 0.001, r: 0.01, am: { rate: w * 2, depth: 0.15 }, gain: -5 + 4 * v.intensity }), glide({ noise: true, color: 'white', bp: j(8000) * v.pf, q: 1.2, dur: D + 0.3, a: 0.001, r: 0.01, gain: -10 })], fx: [{ type: 'eq', bands: [{ type: 'hp', f: 120 }, { type: 'peak', f: 3200, q: 0.9, gain: -5 }] }, { type: 'dc' }], target: -4, loop: { length: D, crossfade: 0.2 } }; },
    // leak: a thin high hiss from a small crack, sputtering (fast random-ish AM); seamless loop
    steam_leak: (r, v, j) => { const D = 1.5 * v.len, s = Math.max(1, Math.round(j(11) * D)) / D; return { layers: [glide({ noise: true, color: 'white', bp: j(6500) * v.pf, q: 2.2, dur: D + 0.3, a: 0.001, r: 0.01, am: { rate: s, depth: 0.55 }, gain: -2 }), glide({ noise: true, color: 'white', bp: j(10500) * v.pf, q: 3, dur: D + 0.3, a: 0.001, r: 0.01, am: { rate: s * 2, depth: 0.4 }, gain: -9 }), glide({ wave: 'sine', f: j(5200) * v.pf, dur: D + 0.3, a: 0.001, r: 0.01, am: { rate: s, depth: 0.7 }, gain: -24 + 6 * v.intensity })], fx: [{ type: 'eq', bands: [{ type: 'hp', f: 1500 }] }, { type: 'dc' }], target: -4, loop: { length: D, crossfade: 0.15 } }; },
    footstep: (r, v, j) => { const s = step(v.surface || 'concrete', r, v, j); return { ...s, fx: [...(s.fx || []), { type: 'dc' }], target: -3 }; },
  };
}

export const FPS_GROUPS = {
  firearms: ['gunshot_rifle', 'gunshot_pistol', 'gunshot_revolver', 'gunshot_marksman', 'gunshot_shotgun', 'gunshot_smg', 'gunshot_lmg', 'gunshot_suppressed'],
  firearms_synth: ['gunshot_rifle_synth', 'gunshot_pistol_synth', 'gunshot_marksman_synth', 'gunshot_shotgun_synth', 'gunshot_smg_synth', 'gunshot_lmg_synth', 'gunshot_suppressed_synth'],
  weapon_handling: ['mag_out', 'mag_in', 'bolt_rack', 'dry_fire', 'shotgun_pump', 'casing_drop'],
  scifi: ['laser_bolt', 'plasma_shot', 'shield_hit', 'glitch_tear', 'teleport_swell', 'servo', 'drone_rotor', 'hologram_ui', 'alarm_klaxon', 'radio_squelch_on', 'radio_squelch_off', 'bullet_whiz', 'ricochet'],
  movement: ['footstep'],
  steam: ['steam_hiss', 'steam_vent', 'steam_leak'],
};
/** Recipes that default to a seamless loop (loop:false makes them one-shots). */
export const LOOP_RECIPES = ['drone_rotor', 'alarm_klaxon', 'steam_vent', 'steam_leak'];
