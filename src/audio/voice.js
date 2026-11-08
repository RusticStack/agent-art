// Voice renderer: one note (or chord) of a patch -> mono Float32Array.
// Sources: osc (PolyBLEP, unison, per-voice vibrato), additive (organ ranks, per-pipe detune),
// modal (bells/metal), fm, pluck (Karplus-Strong), bowed (waveguide), noise, metal (808 hats),
// sample (imported recordings with key/velocity zones, loops, round-robin).
import { SR, osc, noise, adsr, decayEnv, lfo, filter, shape, wavetable, playTable, modal, pluck, bowed, makeRng, db2a, clamp, sin01 } from './dsp.js';
import { merge } from './presets.js';

const C4 = 261.6256;
const tablePeak = new WeakMap();
const METAL = [2, 3, 4.16, 5.43, 6.79, 8.21];

function pitchCurve(n, f, p, rng) {
  const pe = p.pitch_env, vb = p.vibrato;
  if (!(pe && pe.amount) && !(vb && vb.depth)) return f;
  const out = new Float32Array(n);
  const vib = vb && vb.depth ? lfo(n, vb.rate ?? 5.5, { depth: vb.depth, delay: vb.delay ?? 0, phase: rng.next() }) : null;
  const k = pe && pe.amount ? -1 / Math.max(1e-4, (pe.time ?? 0.05) * SR) : 0;
  for (let i = 0; i < n; i++) {
    let semis = pe && pe.amount ? pe.amount * Math.exp(k * i) : 0;
    if (vib) semis += vib[i] / 100;
    const x = semis * 0.0577623;
    out[i] = f * (x > -0.2 && x < 0.2 ? 1 + x + x * x * 0.5 + x * x * x * 0.1666667 : Math.exp(x));
  }
  return out;
}

function srcEnv(src, n, gateN) {
  if (src.decay !== undefined) return decayEnv(n, src.decay, src.attack ?? 0.0005);
  if (src.env) return adsr(n, gateN, src.env);
  return null;
}

function addWithEnv(out, tmp, env, gain = 1) {
  if (env) for (let i = 0; i < out.length; i++) out[i] += tmp[i] * env[i] * gain;
  else for (let i = 0; i < out.length; i++) out[i] += tmp[i] * gain;
}

function renderSource(src, n, f, fr, out, rng, ev, gateN, p, ctx, chordGain) {
  const type = src.type || 'osc';
  const g = (src.gain ?? 1) * chordGain;
  const tmp = new Float32Array(n);
  const mulBase = Math.pow(2, (src.octave ?? 0) + (src.semi ?? 0) / 12 + (src.detune ?? 0) / 1200);
  const freq = src.fixed !== undefined ? (src.pitch === false || typeof fr === 'number' ? src.fixed : scaleArr(fr, src.fixed / f)) : fr;
  switch (type) {
    case 'osc': {
      const U = Math.max(1, src.unison ?? 1), spread = src.spread ?? 10;
      const pwm = src.pwm ? lfo(n, src.pwm.rate ?? 0.5, { depth: src.pwm.depth ?? 0.2, phase: rng.next() }) : null;
      for (let v = 0; v < U; v++) {
        const cents = U > 1 ? spread * (v / (U - 1) - 0.5) + rng.bi() * spread * 0.08 : 0;
        let fv = freq, mul = mulBase * Math.pow(2, cents / 1200);
        const vv = src.voice_vibrato;
        if (vv) {
          const j = vv.jitter ?? 0.2;
          const vib = lfo(n, (vv.rate ?? 5) * (1 + j * rng.bi()), { depth: (vv.depth ?? 15) * (1 + j * rng.bi()), phase: rng.next(), delay: vv.delay ?? 0.15 });
          const arr = new Float32Array(n);
          // 2^(c/1200) ~ 1 + c*ln2/1200 (+ 2nd order) for vibrato-sized deviations
          for (let i = 0; i < n; i++) { const x = vib[i] * 0.000577623; arr[i] = (typeof freq === 'number' ? freq : freq[i]) * (1 + x + x * x * 0.5); }
          fv = arr;
        }
        osc(n, fv, { wave: src.wave || 'saw', pw: src.pw ?? 0.5, phase: U > 1 || src.random_phase ? rng.next() : 0, gain: 1 / Math.sqrt(U), mul, out: tmp, pwm });
      }
      break;
    }
    case 'additive': {
      const parts = (src.partials || [[1, 1]]).map(([r, a]) => [Math.max(1, Math.round(r * 4)), a]);
      const maxHarm = Math.floor((SR * 0.45) / (f * mulBase / 4));
      const table = wavetable(parts, maxHarm);
      if (!tablePeak.has(table)) { let pk = 0; for (const v of table) pk = Math.max(pk, Math.abs(v)); tablePeak.set(table, pk || 1); }
      const norm = 1 / tablePeak.get(table);
      const ranks = Math.max(1, src.ranks ?? 1), rd = src.rank_detune ?? 2;
      // per-pipe detune: deterministic per pitch, so a pipe always sounds the same
      const pipe = (makeRng(Math.round(f * 1000)).bi()) * (src.pipe_detune ?? 0);
      for (let r = 0; r < ranks; r++) {
        const cents = pipe + (ranks > 1 ? (r - (ranks - 1) / 2) * rd : 0);
        playTable(n, table, freq, { gain: norm / Math.sqrt(ranks), phase: rng.next(), mul: (mulBase / 4) * Math.pow(2, cents / 1200), out: tmp });
      }
      break;
    }
    case 'modal': {
      const f0 = (src.fixed ?? f) * mulBase;
      const modes = (src.modes || [[1, 1, 1]]).map(([r, a, t]) => [r, a, (t ?? 1) * (src.decay_scale ?? 1) * Math.pow(C4 / f0, src.decay_track ?? 0.3)]);
      modal(n, f0, modes, { out: tmp, rng, strike: src.strike ?? 0 });
      break;
    }
    case 'fm': {
      const I = src.index ?? 2, kd = src.index_decay ? -1 / (src.index_decay * SR) : 0, ratio = src.ratio ?? 1, fbk = src.feedback ?? 0;
      let pc = 0, pm = rng.next(), prev = 0;
      for (let i = 0; i < n; i++) {
        const fc = (typeof freq === 'number' ? freq : freq[i]) * mulBase;
        const idx = I * ((src.index_end ?? 0) + (1 - (src.index_end ?? 0)) * (kd ? Math.exp(kd * i) : 1));
        const m = sin01(pm) * idx + prev * fbk;
        let ph = pc + m / (2 * Math.PI);
        ph -= Math.floor(ph);
        const y = sin01(ph);
        tmp[i] = y; prev = y;
        pc += fc / SR; if (pc >= 1) pc -= 1;
        pm += (fc * ratio) / SR; if (pm >= 1) pm -= 1;
      }
      break;
    }
    case 'pluck': {
      const fp = (src.fixed ?? f) * mulBase;
      pluck(n, fp, rng, { decay: src.decay_t ?? src.t60 ?? 3, brightness: (src.brightness ?? 0.7) * (0.65 + 0.35 * ev.vel), out: tmp, pick: src.pick ?? 0.13 });
      break;
    }
    case 'bowed': {
      const players = Math.max(1, src.players ?? 1), spread = src.spread ?? 8;
      const bowEnv = adsr(n, gateN, p.amp || {});
      for (let k = 0; k < players; k++) {
        const cents = players > 1 ? spread * (k / (players - 1) - 0.5) + rng.bi() * 2 : 0;
        bowed(n, f * mulBase * Math.pow(2, cents / 1200), rng, { pressure: src.pressure ?? 0.25, position: src.position ?? 0.13, gain: 1 / Math.sqrt(players), out: tmp, envBow: bowEnv });
      }
      filter(tmp, 'hp', 60, 0.7);
      break;
    }
    case 'noise': {
      noise(n, src.color || 'white', rng, { out: tmp });
      const fl = src.filter;
      if (fl) {
        const fc = fl.f ?? (fl.keytrack ? f * fl.keytrack : 1000);
        filter(tmp, fl.type || 'bp', clamp(fc, 20, 20000), fl.q ?? 0.7);
      }
      if (src.wind) { const m = lfo(n, 2.5, { depth: 0.6, shape: 'random', rng }); for (let i = 0; i < n; i++) tmp[i] *= 1 + m[i]; }
      break;
    }
    case 'metal': {
      const base = (src.base ?? 400) * mulBase;
      for (const r of src.ratios || METAL) osc(n, base * r, { wave: 'square', gain: 1 / 6, phase: rng.next(), out: tmp });
      break;
    }
    case 'sample': renderSample(src, n, f * mulBase, tmp, ev, ctx, gateN); break;
    default: throw new Error(`source type "${type}" unknown (osc additive modal fm pluck bowed noise metal sample)`);
  }
  addWithEnv(out, tmp, srcEnv(src, n, gateN), g);
}

function scaleArr(a, k) { const o = new Float32Array(a.length); for (let i = 0; i < a.length; i++) o[i] = a[i] * k; return o; }

export function noteToMidi(name) {
  if (typeof name === 'number') return name;
  const m = String(name).trim().match(/^([a-gA-G])([#b]?)(-?\d)$/);
  if (!m) throw new Error(`Bad note "${name}" (use c4, f#2, bb1)`);
  const pc = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 }[m[1].toLowerCase()] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0);
  return pc + (Number(m[3]) + 1) * 12;
}
export const midiToFreq = (m) => 440 * Math.pow(2, (m - 69) / 12);

function renderSample(src, n, f, out, ev, ctx, gateN) {
  const zones = src.zones || [];
  if (!zones.length) throw new Error('sampler has no zones: patch.sources[0].zones = [{sample:"<imported asset>", root:"c3"}]');
  const midi = 69 + 12 * Math.log2(f / 440);
  let cand = zones.filter((z) => midi >= noteToMidi(z.lo ?? 'c-1') - 0.5 && midi <= noteToMidi(z.hi ?? 'g9') + 0.5 && ev.vel >= (z.vel?.[0] ?? 0) && ev.vel <= (z.vel?.[1] ?? 1));
  if (!cand.length) cand = zones;
  // round-robin: zones sharing key/velocity range alternate per event
  const z = cand[(ev.rr ?? 0) % cand.length];
  const s = ctx.getSample?.(z.sample);
  if (!s) throw new Error(`sample "${z.sample}" not found (import it first: art_audio import {name, path})`);
  const data = s.mono, rootF = midiToFreq(noteToMidi(z.root ?? 'c4'));
  const step = (z.fixed_pitch ? 1 : f / rootF) * (s.sr / SR);
  const loop = z.loop === true ? s.loop || [0, data.length - 1] : z.loop;
  let pos = z.start ?? 0;
  for (let i = 0; i < n; i++) {
    if (loop && pos >= loop[1]) pos -= loop[1] - loop[0];
    const k = pos | 0;
    if (k + 1 >= data.length) break;
    out[i] = data[k] + (data[k + 1] - data[k]) * (pos - k);
    pos += step;
  }
  if (z.gain) for (let i = 0; i < n; i++) out[i] *= db2a(z.gain);
}

/**
 * Render one event. ev: {freqs:[Hz], dur (s), vel 0..1, art:{mute,legato,tremolo,swell,accent}, seed, rr, tempo}.
 */
export function renderVoice(patch, ev, ctx = {}) {
  let p = patch;
  if (p.layers) { const L = p.layers.find((l) => ev.vel <= (l.max_vel ?? 1)); if (L) p = merge(p, L); }
  const art = ev.art || {};
  if (art.mute && p.mute) p = merge(p, p.mute);
  if (art.legato && p.legato) p = merge(p, p.legato);
  const rng = makeRng(ev.seed ?? 1);
  const amp = { a: 0.005, d: 0.1, s: 0.8, r: 0.2, ...(p.amp || {}) };
  if (art.swell) amp.a = Math.max(amp.a, ev.dur * 0.85);
  if (art.legato) amp.a = Math.min(amp.a, 0.03);
  const gate = p.oneshot ? p.oneshot : ev.dur * (art.mute ? p.gate ?? 0.5 : art.legato ? 1.08 : 1);
  const gateN = Math.max(16, Math.round(gate * SR));
  const relN = Math.round(amp.r * SR);
  const hitMax = p.hits ? Math.max(...p.hits.map((h) => h[0])) : 0;
  const nBody = gateN + relN + 1;
  const out = new Float32Array(nBody);
  const chordGain = 1 / Math.sqrt(Math.max(1, ev.freqs.length));
  ev.freqs.forEach((f, k) => {
    const fr = pitchCurve(nBody, f, p, rng);
    (p.sources || []).forEach((src, si) => renderSource(src, nBody, f, fr, out, rng.fork(`${k}:${si}`), ev, gateN, p, ctx, chordGain));
  });
  // voice filter (static, or swept by envelope / LFO / velocity)
  const fl = p.filter;
  if (fl) {
    const f0 = ev.freqs[0] || C4;
    const base = (fl.cutoff ?? 2000) * Math.pow(f0 / C4, fl.keytrack ?? 0) * Math.pow(2, (fl.vel_amount ?? 0) * (ev.vel - 0.7));
    if (fl.env || fl.lfo) {
      const fe = fl.env ? adsr(nBody, gateN, fl.env) : null;
      const lf = fl.lfo ? lfo(nBody, fl.lfo.rate ?? 0.2, { depth: fl.lfo.depth ?? 1, shape: fl.lfo.shape, rng, phase: rng.next() }) : null;
      filter(out, fl.type || 'lp', (i) => base * Math.pow(2, (fe ? (fl.env_amount ?? 2) * fe[i] : 0) + (lf ? lf[i] : 0)), fl.q ?? 0.7071);
    } else filter(out, fl.type || 'lp', base, fl.q ?? 0.7071);
  }
  const env = adsr(nBody, gateN, amp);
  const vg = Math.pow(clamp(ev.vel, 0, 1.2), p.vel_curve ?? 1.3) * db2a(p.level ?? 0);
  for (let i = 0; i < nBody; i++) out[i] *= env[i] * vg;
  if (art.tremolo) {
    // tremolo picking: re-attack every period (default 1/32 note)
    const P = Math.max(64, Math.round((art.tremolo_period ?? 60 / (ev.tempo ?? 120) / 8) * SR));
    for (let i = 0; i < nBody; i++) { const x = (i % P) / P; out[i] *= 0.45 + 0.55 * Math.exp(-x * 4) * Math.min(1, x * P / 40 + 0.2); }
  }
  if (p.drive) shape(out, typeof p.drive === 'number' ? { drive: p.drive } : p.drive);
  if (!p.hits) return out;
  const res = new Float32Array(nBody + Math.round(hitMax * SR));
  for (const [t, gH] of p.hits) { const o = Math.round(t * SR); for (let i = 0; i < nBody; i++) res[i + o] += out[i] * gH; }
  return res;
}
