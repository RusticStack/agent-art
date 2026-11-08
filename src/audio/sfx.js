// SFX designer: an sfxr-style parametric generator plus layered recipes. Every recipe is a
// function (rng, vars) -> layer spec, so a seed gives a repeatable variant and N seeds give N
// variants. vars: pitch (semitones), length (x), intensity 0..1, variation 0..1, wet 0..1, reverb.
import { SR, makeRng, db2a, noise, filter, panMono, addInto, lfo, osc, decayEnv, peakOf, a2db, clamp, shape } from './dsp.js';
import { applyFx, reverbAlgo } from './fx.js';
import { renderVoice, midiToFreq, noteToMidi } from './voice.js';
import { resolvePatch, merge } from './presets.js';
import { truePeak } from './analysis.js';

// ---------- sfxr ----------
export const SFXR_DEFAULTS = { wave: 'square', attack: 0, sustain: 0.3, punch: 0, decay: 0.4, freq: 0.3, freq_limit: 0, slide: 0, delta_slide: 0, vib_strength: 0, vib_speed: 0, arp_mod: 0, arp_speed: 0, duty: 0, duty_sweep: 0, repeat_speed: 0, phaser_offset: 0, phaser_sweep: 0, lpf_freq: 1, lpf_sweep: 0, lpf_resonance: 0, hpf_freq: 0, hpf_sweep: 0, volume: 0.5 };
/** sfxr synthesis (DrPetter's algorithm, 8x supersampled). Returns mono Float32Array. */
export function sfxr(params = {}, seed = 1) {
  const p = { ...SFXR_DEFAULTS, ...params };
  const rng = makeRng(seed);
  const wave = { square: 0, saw: 1, sine: 2, noise: 3 }[p.wave] ?? 0;
  let fperiod, fmaxperiod, fslide, fdslide, period, squareDuty, squareSlide, arpMod, arpTime, arpLimit;
  const reset = () => {
    fperiod = 100 / (p.freq * p.freq + 0.001); fmaxperiod = 100 / (p.freq_limit * p.freq_limit + 0.001);
    fslide = 1 - Math.pow(p.slide, 3) * 0.01; fdslide = -Math.pow(p.delta_slide, 3) * 0.000001;
    squareDuty = 0.5 - p.duty * 0.5; squareSlide = -p.duty_sweep * 0.00005;
    arpMod = p.arp_mod >= 0 ? 1 - Math.pow(p.arp_mod, 2) * 0.9 : 1 + Math.pow(p.arp_mod, 2) * 10;
    arpTime = 0; arpLimit = p.arp_speed === 1 ? 0 : Math.floor(Math.pow(1 - p.arp_speed, 2) * 20000 + 32);
  };
  reset();
  let fltp = 0, fltdp = 0, fltw = Math.pow(p.lpf_freq, 3) * 0.1;
  const fltwd = 1 + p.lpf_sweep * 0.0001;
  let fltdmp = Math.min(0.8, (5 / (1 + Math.pow(p.lpf_resonance, 2) * 20)) * (0.01 + fltw));
  let fltphp = 0, flthp = Math.pow(p.hpf_freq, 2) * 0.1;
  const flthpd = 1 + p.hpf_sweep * 0.0003;
  let vibPhase = 0;
  const vibSpeed = Math.pow(p.vib_speed, 2) * 0.01, vibAmp = p.vib_strength * 0.5;
  const envLen = [p.attack * p.attack * 100000, p.sustain * p.sustain * 100000, p.decay * p.decay * 100000].map((x) => Math.max(1, x));
  let fphase = Math.pow(p.phaser_offset, 2) * 1020 * Math.sign(p.phaser_offset || 1);
  const fdphase = Math.pow(p.phaser_sweep, 2) * Math.sign(p.phaser_sweep || 1);
  const pbuf = new Float32Array(1024);
  let ipp = 0;
  const nbuf = Float32Array.from({ length: 32 }, () => rng.bi());
  const repLimit = p.repeat_speed ? Math.floor(Math.pow(1 - p.repeat_speed, 2) * 20000 + 32) : 0;
  let repTime = 0, phase = 0, envStage = 0, envTime = 0;
  const total = Math.ceil(envLen[0] + envLen[1] + envLen[2]);
  const out = new Float32Array(Math.min(total, SR * 10));
  for (let i = 0; i < out.length; i++) {
    if (repLimit && ++repTime >= repLimit) { repTime = 0; reset(); }
    if (arpLimit && ++arpTime >= arpLimit) { arpLimit = 0; fperiod *= arpMod; }
    fslide += fdslide; fperiod *= fslide;
    if (fperiod > fmaxperiod) { fperiod = fmaxperiod; if (p.freq_limit > 0) return out.subarray(0, i); }
    let rf = fperiod;
    if (vibAmp > 0) { vibPhase += vibSpeed; rf = fperiod * (1 + Math.sin(vibPhase) * vibAmp); }
    period = Math.max(8, Math.floor(rf));
    squareDuty = clamp(squareDuty + squareSlide, 0, 0.5);
    if (++envTime > envLen[envStage]) { envTime = 0; if (++envStage > 2) return out.subarray(0, i); }
    const ev = envStage === 0 ? envTime / envLen[0] : envStage === 1 ? 1 + (1 - envTime / envLen[1]) * 2 * p.punch : 1 - envTime / envLen[2];
    fphase += fdphase;
    const iphase = Math.min(1023, Math.abs(Math.floor(fphase)));
    if (flthpd !== 1) flthp = clamp(flthp * flthpd, 0.00001, 0.1);
    let ss = 0;
    for (let si = 0; si < 8; si++) {
      if (++phase >= period) { phase %= period; if (wave === 3) for (let k = 0; k < 32; k++) nbuf[k] = rng.bi(); }
      const fp = phase / period;
      let s = wave === 0 ? (fp < squareDuty ? 0.5 : -0.5) : wave === 1 ? 1 - fp * 2 : wave === 2 ? Math.sin(fp * 2 * Math.PI) : nbuf[Math.floor((phase * 32) / period)];
      const pp = fltp;
      fltw = clamp(fltw * fltwd, 0, 0.1);
      if (p.lpf_freq !== 1) { fltdp += (s - fltp) * fltw; fltdp -= fltdp * fltdmp; } else { fltp = s; fltdp = 0; }
      fltp += fltdp;
      fltphp += fltp - pp; fltphp -= fltphp * flthp; s = fltphp;
      pbuf[ipp & 1023] = s; s += pbuf[(ipp - iphase + 1024) & 1023]; ipp = (ipp + 1) & 1023;
      ss += s * ev;
    }
    out[i] = clamp((ss / 8) * 2 * p.volume, -1, 1);
  }
  return out;
}
/** sfxr button presets, randomised from a seed (like the original generator buttons). */
export function sfxrPreset(kind, rng) {
  const r = rng.next, P = { ...SFXR_DEFAULTS };
  switch (kind) {
    case 'pickup': Object.assign(P, { freq: 0.4 + r() * 0.5, sustain: r() * 0.1, decay: 0.1 + r() * 0.4, punch: 0.3 + r() * 0.3 }); if (r() < 0.5) Object.assign(P, { arp_speed: 0.5 + r() * 0.2, arp_mod: 0.2 + r() * 0.4 }); break;
    case 'laser': Object.assign(P, { wave: rng.pick(['square', 'saw', 'sine']), freq: 0.5 + r() * 0.5, freq_limit: 0.1 + r() * 0.2, slide: -0.15 - r() * 0.2, duty: r() * 0.5, sustain: 0.1 + r() * 0.2, decay: r() * 0.4, punch: r() * 0.3 }); break;
    case 'explosion': Object.assign(P, { wave: 'noise', freq: 0.1 + r() * 0.3, slide: -0.1 + r() * 0.4, sustain: 0.1 + r() * 0.3, decay: r() * 0.5, punch: 0.2 + r() * 0.6, phaser_offset: r() < 0.5 ? -0.3 + r() * 0.9 : 0, phaser_sweep: -r() * 0.3 }); break;
    case 'powerup': Object.assign(P, { wave: r() < 0.5 ? 'saw' : 'square', freq: 0.2 + r() * 0.3, slide: 0.05 + r() * 0.2, sustain: r() * 0.4, decay: 0.1 + r() * 0.4, vib_strength: r() * 0.7, vib_speed: r() * 0.6 }); break;
    case 'hit': Object.assign(P, { wave: rng.pick(['square', 'saw', 'noise']), freq: 0.2 + r() * 0.6, slide: -0.3 - r() * 0.4, sustain: r() * 0.1, decay: 0.1 + r() * 0.2, hpf_freq: r() < 0.5 ? r() * 0.3 : 0 }); break;
    case 'jump': Object.assign(P, { wave: 'square', duty: r() * 0.6, freq: 0.3 + r() * 0.3, slide: 0.1 + r() * 0.2, sustain: 0.1 + r() * 0.3, decay: 0.1 + r() * 0.2 }); break;
    case 'blip': Object.assign(P, { wave: rng.pick(['square', 'saw']), duty: r() * 0.6, freq: 0.2 + r() * 0.4, sustain: 0.1 + r() * 0.1, decay: r() * 0.2, hpf_freq: 0.1 }); break;
    default: throw new Error(`sfxr preset must be pickup|laser|explosion|powerup|hit|jump|blip`);
  }
  return P;
}

// ---------- custom layer kinds ----------
function crackle({ dur = 0.2, density = 300, f = 2500, q = 1.2, click = 0.0015, bias = 1.5, metal = false }, rng) {
  const n = Math.round(dur * SR) + 2000, out = new Float32Array(n);
  const count = Math.round(density * dur);
  const cN = Math.max(8, Math.round(click * SR));
  for (let k = 0; k < count; k++) {
    const t = Math.floor(Math.pow(rng.next(), bias) * dur * SR), a = 0.25 + rng.next() * 0.75;
    if (metal) { const fr = f * (0.7 + rng.next() * 0.8); const m = Math.round(0.03 * SR); for (let i = 0; i < m && t + i < n; i++) out[t + i] += Math.sin((2 * Math.PI * fr * i) / SR) * Math.exp(-i / (0.006 * SR)) * a * 0.6; }
    else for (let i = 0; i < cN && t + i < n; i++) out[t + i] += rng.bi() * a * (1 - i / cN);
  }
  if (!metal) filter(out, 'bp', f, q);
  return out;
}
function drops({ count = 6, dur = 0.5, f = 900, spread = 0.6, size = 0.04 }, rng) {
  const n = Math.round((dur + 0.15) * SR), out = new Float32Array(n);
  for (let k = 0; k < count; k++) {
    const t = Math.floor(rng.next() * dur * SR), fr = f * (1 + rng.bi() * spread), len = Math.round(size * (0.6 + rng.next()) * SR), a = 0.3 + rng.next() * 0.7;
    let ph = 0;
    for (let i = 0; i < len && t + i < n; i++) {
      const x = i / len;
      ph += (fr * (0.55 + 1.3 * x)) / SR; // rising "plip"
      out[t + i] += Math.sin(2 * Math.PI * ph) * Math.exp(-x * 5) * Math.min(1, i / 30) * a;
    }
  }
  return out;
}
function squelch({ dur = 0.4, wet = 0.7, f = 700 }, rng) {
  const n = Math.round((dur + 0.1) * SR);
  const out = noise(n, 'pink', rng);
  const am = lfo(n, 16 + rng.next() * 14, { depth: 0.8, shape: 'random', rng });
  const sweep = lfo(n, 7 + rng.next() * 6, { depth: 1.2, shape: 'random', rng });
  const env = decayEnv(n, dur, 0.004);
  for (let i = 0; i < n; i++) out[i] *= Math.max(0, 1 + am[i]) * env[i];
  filter(out, 'lp', (i) => clamp(f * Math.pow(2, sweep[i]), 120, 6000), 4 + wet * 6);
  filter(out, 'peak', 350, 1.5, 6 * wet);
  filter(out, 'hp', 90, 0.7);
  return out;
}

// ---------- layer helpers ----------
const V = (patch, o = {}) => ({ kind: 'voice', patch, ...o });
const thump = (f, dur, o = {}) => V({ sources: [{ type: 'osc', wave: 'sine', fixed: f }], pitch_env: { amount: o.drop ?? 18, time: o.time ?? 0.03 }, amp: { a: 0.001, d: dur, s: 0, r: 0.03 }, oneshot: dur }, o);
const burst = ({ dur, from, to, q = 0.8, color = 'white', type = 'lp' }, o = {}) => V({ sources: [{ type: 'noise', color }], filter: { type, cutoff: to, q, env_amount: Math.log2(from / to), env: { a: 0.001, d: dur, s: 0, r: 0.05 } }, amp: { a: 0.001, d: dur, s: 0, r: 0.04 }, oneshot: dur }, o);
const whoosh = ({ dur, from, to, peak = null, q = 2 }, o = {}) => {
  const pts = peak ? [[0, from], [dur * 0.55, peak], [dur, to]] : [[0, from], [dur, to]];
  return { kind: 'whoosh', dur, pts, q, ...o };
};
const blip = (f, dur, o = {}) => V({ sources: [{ type: 'osc', wave: o.wave || 'sine', fixed: f }], pitch_env: o.up ? { amount: o.up, time: dur * 0.5 } : undefined, amp: { a: 0.002, d: dur, s: 0, r: 0.01 }, oneshot: dur }, o);
const bell = (note, o = {}) => ({ kind: 'note', instrument: o.instrument || 'church_bells', note, dur: o.dur ?? 0.5, ...o });

/** Recipes: (rng, v, j) -> {layers, fx?, reverb?, target?}. j(x) = x varied by +-variation. */
export const RECIPES = {
  // ---- gore ----
  gib_burst: (r, v, j) => ({ layers: [thump(j(70) * v.pf, 0.28 * v.len, { gain: 0 }), burst({ dur: 0.35 * v.len, from: 6000, to: 300, color: 'pink' }, { gain: -4 }), { kind: 'squelch', dur: 0.55 * v.len, wet: v.wet, f: j(650), gain: -2, at: 0.02 }, { kind: 'drops', count: Math.round(6 + 8 * v.wet * r.next()), dur: 0.7 * v.len, f: j(800) * v.pf, gain: -10, at: 0.08 }, { kind: 'crackle', dur: 0.15, density: 200 * v.intensity, f: 1800, gain: -8, at: 0.01 }], fx: [{ type: 'drive', drive: 6 + 10 * v.intensity }, { type: 'eq', bands: [{ type: 'hp', f: 40 }, { type: 'peak', f: 300, q: 1, gain: 3 }] }], reverb: { preset: 'room', wet: 0.12 } }),
  flesh_squelch: (r, v, j) => ({ layers: [{ kind: 'squelch', dur: 0.38 * v.len, wet: v.wet, f: j(600) * v.pf, gain: 0 }, { kind: 'drops', count: Math.round(2 + 5 * v.wet), dur: 0.35 * v.len, f: j(700) * v.pf, gain: -12, at: 0.05 }, thump(j(110) * v.pf, 0.12, { gain: -6, drop: 8 })], fx: [{ type: 'saturate', drive: 4 + 6 * v.intensity }], reverb: { preset: 'room', wet: 0.08 } }),
  bone_crunch: (r, v, j) => ({ layers: [{ kind: 'crackle', dur: 0.16 * v.len, density: 350 + 300 * v.intensity, f: j(2600) * v.pf, q: 1.3, gain: 0 }, { kind: 'crackle', dur: 0.12 * v.len, density: 160, f: j(800) * v.pf, q: 1, click: 0.003, gain: -3, at: 0.01 }, thump(j(120) * v.pf, 0.1, { gain: -5, drop: 10 })], fx: [{ type: 'drive', drive: 8 + 8 * v.intensity }, { type: 'transient', attack: 6 }, { type: 'eq', bands: [{ type: 'hp', f: 70 }] }], reverb: { preset: 'room', wet: 0.06 } }),
  blood_splat: (r, v, j) => ({ layers: [burst({ dur: 0.18 * v.len, from: j(4500), to: 500, color: 'white' }, { gain: -3 }), { kind: 'squelch', dur: 0.22 * v.len, wet: v.wet, f: j(900), gain: -4 }, { kind: 'drops', count: Math.round(5 + 8 * v.wet), dur: 0.45 * v.len, f: j(1000) * v.pf, gain: -9, at: 0.03 }], fx: [{ type: 'eq', bands: [{ type: 'hp', f: 120 }, { type: 'peak', f: 2500, q: 1, gain: -2 }] }], reverb: { preset: 'room', wet: 0.1 } }),
  dismember: (r, v, j) => ({ layers: [whoosh({ dur: 0.22, from: 500, to: 2600 * v.pf }, { gain: -6 }), { kind: 'recipe', recipe: 'flesh_squelch', at: 0.16, gain: -1 }, { kind: 'recipe', recipe: 'bone_crunch', at: 0.18, gain: -2 }, { kind: 'drops', count: 10, dur: 0.6 * v.len, f: j(850), gain: -11, at: 0.25 }], fx: [{ type: 'drive', drive: 6 }], reverb: { preset: 'room', wet: 0.1 } }),
  arterial_spray: (r, v, j) => {
    const pulses = 3 + (r.next() < 0.5 ? 1 : 0), L = [];
    for (let k = 0; k < pulses; k++) L.push(V({ sources: [{ type: 'noise', color: 'white' }], filter: { type: 'bp', cutoff: j(1700) * v.pf, q: 1.2, lfo: { rate: 9, depth: 0.5, shape: 'random' } }, amp: { a: 0.03, d: 0.22 * v.len, s: 0.3, r: 0.12 }, oneshot: 0.18 * v.len }, { at: k * 0.32 * v.len, gain: -3 * k }));
    L.push({ kind: 'drops', count: 16, dur: pulses * 0.32 * v.len, f: j(1100), gain: -12 }, { kind: 'squelch', dur: 0.3, wet: v.wet, gain: -6 });
    return { layers: L, reverb: { preset: 'room', wet: 0.1 } };
  },
  // ---- combat ----
  hit_light: (r, v, j) => ({ layers: [thump(j(190) * v.pf, 0.08, { drop: 10 }), burst({ dur: 0.04, from: 7000, to: 1500 }, { gain: -6 }), { kind: 'squelch', dur: 0.1, wet: 0.4 * v.wet, f: 900, gain: -12 }], fx: [{ type: 'saturate', drive: 4 }] }),
  hit_heavy: (r, v, j) => ({ layers: [thump(j(68) * v.pf, 0.22 * v.len, { drop: 20 }), burst({ dur: 0.15 * v.len, from: 5000, to: 400, color: 'pink' }, { gain: -3 }), { kind: 'crackle', dur: 0.1, density: 200, f: 1200, gain: -9 }, { kind: 'squelch', dur: 0.2, wet: v.wet, gain: -9 }], fx: [{ type: 'drive', drive: 10 + 8 * v.intensity }, { type: 'eq', bands: [{ type: 'peak', f: 90, q: 1, gain: 3 }] }], reverb: { preset: 'room', wet: 0.08 } }),
  crit: (r, v, j) => ({ layers: [{ kind: 'recipe', recipe: 'hit_heavy' }, V({ sources: [{ type: 'modal', modes: [[1, 0.5, 0.6], [2.76, 0.4, 0.4], [5.4, 0.3, 0.25], [8.9, 0.2, 0.15]], fixed: j(880) * v.pf, strike: 0.3 }], amp: { a: 0.001, d: 0, s: 1, r: 0.5 }, oneshot: 0.4 }, { gain: -8, at: 0.005 }), burst({ dur: 0.03, from: 12000, to: 4000 }, { gain: -6 })], reverb: { preset: 'hall', wet: 0.15 } }),
  whip_crack: (r, v, j) => { const t = 0.24 * v.len; return { layers: [whoosh({ dur: t, from: 350, to: 3200 * v.pf, q: 3 }, { gain: -8 }), burst({ dur: 0.012, from: 12000, to: 2500, color: 'white', type: 'hp' }, { at: t, gain: 0 }), blip(j(3200) * v.pf, 0.02, { at: t, up: -24, gain: -4 })], fx: [{ type: 'eq', bands: [{ type: 'hp', f: 200 }] }], reverb: { preset: 'hall', wet: 0.12 } }; },
  blade_swing: (r, v, j) => ({ layers: [whoosh({ dur: 0.3 * v.len, from: 300, peak: j(2800) * v.pf, to: 600, q: 2.5 }), V({ sources: [{ type: 'modal', modes: [[1, 0.3, 0.4], [2.3, 0.2, 0.3], [3.9, 0.15, 0.2]], fixed: j(3200), strike: 0 }], amp: { a: 0.05, d: 0, s: 1, r: 0.2 }, oneshot: 0.25 }, { gain: -18, at: 0.05 })], reverb: { preset: 'room', wet: 0.1 } }),
  crossbow_shot: (r, v, j) => ({ layers: [burst({ dur: 0.01, from: 9000, to: 3000, type: 'hp' }, { gain: -2 }), V({ sources: [{ type: 'pluck', fixed: j(98) * v.pf, t60: 0.5, brightness: 0.9, gain: 1 }], pitch_env: { amount: 4, time: 0.02 }, amp: { a: 0.001, d: 0.25, s: 0, r: 0.05 }, oneshot: 0.25 }, { gain: 0, at: 0.004 }), thump(j(160), 0.06, { gain: -6, drop: 12 }), whoosh({ dur: 0.25, from: 2500, to: 600, q: 2 }, { gain: -12, at: 0.02 })], fx: [{ type: 'saturate', drive: 6 }], reverb: { preset: 'room', wet: 0.1 } }),
  censer_whoosh: (r, v, j) => ({ layers: [whoosh({ dur: 0.7 * v.len, from: 200, peak: j(1300) * v.pf, to: 300, q: 1.6 }), { kind: 'crackle', dur: 0.6 * v.len, density: 18, f: j(3500), metal: true, gain: -10, at: 0.1 }, V({ sources: [{ type: 'noise', color: 'brown' }], filter: { type: 'lp', cutoff: 600, q: 0.8, lfo: { rate: 6, depth: 0.6, shape: 'random' } }, amp: { a: 0.15, d: 0.4, s: 0.3, r: 0.3 }, oneshot: 0.5 * v.len }, { gain: -9 * (1.2 - v.intensity) })], reverb: { preset: 'hall', wet: 0.12 } }),
  explosion: (r, v, j) => ({ layers: [thump(j(50) * v.pf, 0.7 * v.len, { drop: 22, time: 0.06, gain: -6 }), burst({ dur: 1.6 * v.len, from: 8000, to: 260, color: 'brown', q: 0.6 }, { gain: -1 }), burst({ dur: 0.5, from: 9000, to: 800, color: 'white' }, { gain: -7 }), { kind: 'crackle', dur: 1.2 * v.len, density: 60, f: 1500, click: 0.004, bias: 1, gain: -5, at: 0.1 }, burst({ dur: 0.9 * v.len, from: 2500, to: 400, color: 'pink', q: 0.8 }, { gain: -3 })], fx: [{ type: 'drive', drive: 12 + 8 * v.intensity, shape: 'tube' }, { type: 'eq', bands: [{ type: 'peak', f: 60, q: 0.8, gain: 1 }, { type: 'peak', f: 700, q: 0.8, gain: 3 }, { type: 'lp', f: 9000 }] }], reverb: { preset: 'hall', wet: 0.22 } }),
  fire_burst: (r, v, j) => ({ layers: [whoosh({ dur: 0.6 * v.len, from: 300, peak: j(3000), to: 700, q: 1 }, { gain: -2 }), { kind: 'crackle', dur: 0.9 * v.len, density: 45, f: 2200, click: 0.002, bias: 1.2, gain: -6 }, burst({ dur: 0.8 * v.len, from: 1200, to: 200, color: 'brown' }, { gain: -6 })], fx: [{ type: 'saturate', drive: 6 }], reverb: { preset: 'room', wet: 0.12 } }),
  // ---- holy ----
  bell_toll: (r, v, j) => ({ layers: [bell(midiToNote(noteToMidi('e3') + Math.round(v.pitch)), { dur: 0.5 })], reverb: { preset: 'cathedral', wet: 0.3 + 0.3 * v.wet } }),
  choir_hit: (r, v, j) => ({ layers: [{ kind: 'note', instrument: 'choir_pad', patch: { amp: { a: 0.015, d: 0.5, s: 0.5, r: 1.2 } }, notes: chordAt('e3', [0, 7, 12, 15], v.pitch), dur: 0.5 * v.len }, { kind: 'note', instrument: 'tubular_bell', note: midiToNote(noteToMidi('e4') + Math.round(v.pitch)), dur: 0.3, gain: -10 }], reverb: { preset: 'cathedral', wet: 0.4 } }),
  chant_swell: (r, v, j) => ({ layers: [{ kind: 'note', instrument: 'choir_pad', patch: { amp: { a: 1.5 * v.len, d: 0.3, s: 1, r: 1.4 }, fx: [{ morph: ['oo', 'ah'], rate: 0.25 }] }, notes: chordAt('e3', [0, 7, 12], v.pitch), dur: 2.2 * v.len }], reverb: { preset: 'cathedral', wet: 0.45 } }),
  // ---- ui ----
  click: (r, v, j) => ({ layers: [blip(j(2200) * v.pf, 0.012, { gain: 0 }), burst({ dur: 0.004, from: 9000, to: 3000, type: 'hp' }, { gain: -8 })], target: -3 }),
  hover: (r, v, j) => ({ layers: [blip(j(1300) * v.pf, 0.035, { up: 4, gain: 0 })], target: -9 }),
  confirm: (r, v, j) => ({ layers: [V({ sources: [{ type: 'osc', wave: 'tri' }], amp: { a: 0.002, d: 0.07, s: 0, r: 0.03 }, oneshot: 0.06 }, { freq: midiToFreq(76 + v.pitch) }), V({ sources: [{ type: 'osc', wave: 'tri' }], amp: { a: 0.002, d: 0.12, s: 0, r: 0.05 }, oneshot: 0.1 }, { freq: midiToFreq(83 + v.pitch), at: 0.07 })], reverb: { preset: 'room', wet: 0.1 }, target: -3 }),
  level_up: (r, v, j) => {
    const steps = r.next() < 0.5 ? [0, 4, 7, 12, 16] : [0, 3, 7, 12, 15];
    return { layers: steps.map((s, k) => ({ kind: 'note', instrument: 'tubular_bell', note: midiToNote(72 + s + Math.round(v.pitch)), dur: 0.15, at: k * 0.075 * v.len, gain: -2 + k })).concat([V({ sources: [{ type: 'osc', wave: 'square', gain: 0.4 }], filter: { type: 'lp', cutoff: 3000 }, amp: { a: 0.002, d: 0.3, s: 0, r: 0.1 }, oneshot: 0.3 }, { freq: midiToFreq(84 + v.pitch), at: steps.length * 0.075 * v.len, gain: -10 })]), reverb: { preset: 'hall', wet: 0.25 } };
  },
  // ---- monster ----
  monster_growl: (r, v, j) => ({ layers: [growl(j(78) * v.pf, 1.1 * v.len, v, r)], fx: [{ type: 'drive', drive: 10 + 10 * v.intensity, shape: 'tube' }, { type: 'eq', bands: [{ type: 'hp', f: 50 }, { type: 'peak', f: 2500, q: 1, gain: -3 }] }], reverb: { preset: 'crypt', wet: 0.15 } }),
  boss_roar: (r, v, j) => ({ layers: [growl(j(55) * v.pf, 2.2 * v.len, v, r), growl(j(110) * v.pf, 2 * v.len, v, r, { gain: -6, at: 0.05 }), thump(j(38), 1.2, { drop: 14, time: 0.1, gain: -2 }), burst({ dur: 1.8 * v.len, from: 1500, to: 300, color: 'pink', type: 'bp' }, { gain: -8 })], fx: [{ type: 'drive', drive: 16 + 8 * v.intensity, shape: 'tube' }, { type: 'eq', bands: [{ type: 'hp', f: 30 }, { type: 'peak', f: 80, q: 0.8, gain: 3 }] }], reverb: { preset: 'cathedral', wet: 0.2 } }),
};
for (const k of ['pickup', 'laser', 'explosion', 'powerup', 'hit', 'jump', 'blip']) RECIPES[`sfxr_${k}`] = (r) => ({ layers: [{ kind: 'sfxr', params: sfxrPreset(k, r) }] });

export const RECIPE_GROUPS = {
  gore: ['gib_burst', 'flesh_squelch', 'bone_crunch', 'blood_splat', 'dismember', 'arterial_spray'],
  combat: ['hit_light', 'hit_heavy', 'crit', 'whip_crack', 'blade_swing', 'crossbow_shot', 'censer_whoosh', 'explosion', 'fire_burst'],
  holy: ['bell_toll', 'choir_hit', 'chant_swell'], ui: ['click', 'hover', 'confirm', 'level_up'], monster: ['monster_growl', 'boss_roar'],
  sfxr: ['sfxr_pickup', 'sfxr_laser', 'sfxr_explosion', 'sfxr_powerup', 'sfxr_hit', 'sfxr_jump', 'sfxr_blip'],
};

function midiToNote(m) { const n = ['c', 'c#', 'd', 'd#', 'e', 'f', 'f#', 'g', 'g#', 'a', 'a#', 'b']; return `${n[((m % 12) + 12) % 12]}${Math.floor(m / 12) - 1}`; }
function chordAt(root, ivs, pitch) { const m = noteToMidi(root) + Math.round(pitch); return ivs.map((i) => midiToNote(m + i)); }
function growl(f, dur, v, r, o = {}) {
  return { kind: 'growl', f, dur, rough: 0.5 + 0.5 * v.intensity, ...o };
}
function renderGrowl({ f = 90, dur = 0.8, rough = 0.6 }, rng) {
  const n = Math.round(dur * SR);
  const jit = lfo(n, 7, { depth: 0.18, shape: 'random', rng });
  const contour = new Float32Array(n);
  for (let i = 0; i < n; i++) { const x = i / n; contour[i] = f * (0.85 + 0.35 * Math.sin(Math.PI * Math.min(1, x * 1.3))) * (1 + jit[i]); }
  const src = osc(n, contour, { wave: 'saw', gain: 0.6 });
  noise(n, 'pink', rng, { gain: 0.35, out: src });
  // roughness: amplitude modulation at 30-60 Hz (vocal fry / growl)
  const am = lfo(n, 30 + rough * 25, { depth: rough * 0.9, shape: 'random', rng });
  const env = new Float32Array(n);
  for (let i = 0; i < n; i++) { const x = i / n; env[i] = Math.min(1, x * 8) * Math.pow(1 - x, 0.6); src[i] *= (1 + am[i]) * env[i]; }
  return applyFx([src], [{ type: 'formant', voice: 'bass', morph: ['oo', 'oh', 'ah', 'oh'], rate: 0.8 / dur }])[0];
}
function renderWhoosh({ dur = 0.5, pts = [[0, 300], [dur * 0.55, 2500], [dur, 600]], q = 1.5 }, rng) {
  const n = Math.round((dur + 0.05) * SR);
  const b = noise(n, 'pink', rng);
  const curve = pts.map(([t, f]) => [t * SR, f]); // t in seconds
  const fAt = (i) => { for (let k = 1; k < curve.length; k++) if (i < curve[k][0]) { const [t0, a] = curve[k - 1], [t1, c] = curve[k]; return a * Math.pow(c / a, (i - t0) / (t1 - t0)); } return curve[curve.length - 1][1]; };
  filter(b, 'bp', fAt, q);
  for (let i = 0; i < n; i++) { const x = i / n; b[i] *= Math.sin(Math.PI * Math.min(1, x)) ** 1.5 * 3; }
  return b;
}

/** Render a layer spec -> stereo [L, R]. */
export function renderSfxSpec(spec, rng, vars, ctx = {}, depth = 0) {
  const parts = [];
  for (const [li, L] of (spec.layers || []).entries()) {
    const r = rng.fork(li);
    let m;
    switch (L.kind || 'voice') {
      case 'voice': {
        const patch = typeof L.patch === 'string' ? resolvePatch(L.patch, ctx.custom) : L.patch;
        m = renderVoice(patch, { freqs: [L.freq ?? (L.note ? midiToFreq(noteToMidi(L.note)) : 220)], dur: L.dur ?? patch.oneshot ?? 0.3, vel: L.vel ?? 0.9, seed: r.int(1, 1e9), art: {} }, ctx);
        if (patch.fx) m = applyFx([m], patch.fx)[0];
        break;
      }
      case 'note': {
        const patch = L.patch ? resolvePatch({ base: L.instrument, ...L.patch }, ctx.custom) : resolvePatch(L.instrument, ctx.custom);
        const notes = L.notes || [L.note || 'c4'];
        m = renderVoice(patch, { freqs: notes.map((n) => midiToFreq(noteToMidi(n))), dur: L.dur ?? 0.5, vel: L.vel ?? 0.9, seed: r.int(1, 1e9), art: {} }, ctx);
        if (patch.fx) m = applyFx([m], patch.fx.filter((f) => f.type !== 'chorus'))[0];
        m = Float32Array.from(m, (x) => x * db2a(patch.gain ?? 0));
        break;
      }
      case 'sfxr': m = sfxr(L.params, r.int(1, 1e9)); break;
      case 'crackle': m = crackle(L, r); break;
      case 'drops': m = drops(L, r); break;
      case 'squelch': m = squelch(L, r); break;
      case 'growl': m = renderGrowl(L, r); break;
      case 'whoosh': m = renderWhoosh(L, r); break;
      case 'recipe': {
        if (depth > 3) throw new Error('recipe nesting too deep');
        const sub = buildRecipe(L.recipe, r, vars);
        const st = renderSfxSpec({ ...sub, reverb: null }, r, vars, ctx, depth + 1);
        parts.push({ chs: st, at: L.at ?? 0, gain: L.gain ?? 0 });
        continue;
      }
      default: throw new Error(`layer kind "${L.kind}" unknown (voice note sfxr crackle drops squelch growl whoosh recipe)`);
    }
    parts.push({ chs: panMono(m, L.pan ?? 0, 1), at: L.at ?? 0, gain: L.gain ?? 0 });
  }
  const tailS = spec.reverb ? 1.5 : 0.05;
  const N = Math.max(...parts.map((p) => Math.round(p.at * SR) + p.chs[0].length), 64) + Math.round(tailS * SR);
  let out = [new Float32Array(N), new Float32Array(N)];
  for (const p of parts) for (let c = 0; c < 2; c++) addInto(out[c], p.chs[c], Math.round(p.at * SR), db2a(p.gain));
  if (spec.fx) out = applyFx(out, spec.fx);
  return out.map((c) => c.subarray(0, N));
}

function buildRecipe(name, rng, vars) {
  const fn = RECIPES[name];
  if (!fn) throw new Error(`Unknown recipe "${name}". Recipes: ${Object.entries(RECIPE_GROUPS).map(([g, l]) => `${g}: ${l.join(' ')}`).join('; ')}`);
  const v = { pitch: 0, length: 1, intensity: 0.6, variation: 0.5, wet: 0.7, ...vars };
  // per-variant jitter: pitch and length drift with the seed (scaled by variation)
  const vp = v.pitch + rng.bi() * 1.5 * v.variation;
  const vv = { ...v, pitch: vp, pf: Math.pow(2, vp / 12), len: v.length * (1 + rng.bi() * 0.15 * v.variation) };
  const j = (x) => x * (1 + rng.bi() * 0.18 * v.variation);
  return fn(rng, vv, j);
}

/** Render a sound effect definition -> {chs, spec}. def: {recipe | params (sfxr) | layers, seed, vars, fx, reverb, target}. */
export function renderSfx(def, ctx = {}) {
  const rng = makeRng(def.seed ?? 1);
  const vars = { ...(def.vars || {}) };
  let spec;
  if (def.layers) spec = { layers: def.layers, fx: def.fx, reverb: def.reverb };
  else if (def.recipe) spec = buildRecipe(def.recipe, rng, vars);
  else if (def.params) spec = { layers: [{ kind: 'sfxr', params: def.params }] };
  else throw new Error('sfx needs recipe, params (sfxr) or layers');
  if (def.fx && !def.layers) spec.fx = [...(spec.fx || []), ...def.fx];
  if (vars.reverb !== undefined) spec.reverb = typeof vars.reverb === 'string' ? { preset: vars.reverb, wet: 0.3 } : vars.reverb > 0 ? { preset: spec.reverb?.preset || 'hall', wet: vars.reverb } : null;
  let chs = renderSfxSpec(spec, rng, vars, ctx);
  if (spec.reverb && spec.reverb.wet > 0) {
    const w = reverbAlgo(chs, { ...spec.reverb, tail: 0 });
    chs = chs.map((c, k) => { const o = Float32Array.from(c); for (let i = 0; i < o.length; i++) o[i] += w[k][i] * spec.reverb.wet; return o; });
  }
  // finish: trim head silence, fade + trim tail, normalise peak to target (default -1 dBFS)
  const th = db2a(-60), n = chs[0].length;
  let s = 0; while (s < n && Math.abs(chs[0][s]) < th && Math.abs(chs[1][s]) < th) s++;
  let e = n; while (e > s + 64 && Math.abs(chs[0][e - 1]) < db2a(-66) && Math.abs(chs[1][e - 1]) < db2a(-66)) e--;
  chs = chs.map((c) => c.slice(Math.max(0, s - 8), e));
  const m = chs[0].length, fo = Math.min(m >> 2, Math.round(0.02 * SR));
  for (const c of chs) { for (let i = 0; i < fo; i++) c[m - 1 - i] *= i / fo; for (let i = 0; i < 8 && i < m; i++) c[i] *= i / 8; }
  const target = def.target ?? spec.target ?? -1;
  const pk = peakOf(...chs);
  if (!(pk > 1e-6)) throw new Error('the sfx rendered silent (check layer kinds/params: e.g. growl {f, dur, rough}, whoosh {dur, pts:[[t,hz],...]}, voice {patch, note, dur})');
  if (pk > 0) { const k = db2a(target) / pk; for (const c of chs) for (let i = 0; i < c.length; i++) c[i] *= k; }
  const tp = a2db(truePeak(chs));
  if (tp > target + 0.2) { const k = db2a(target - tp); for (const c of chs) for (let i = 0; i < c.length; i++) c[i] *= k; }
  return { chs, spec };
}
export { shape, merge };
