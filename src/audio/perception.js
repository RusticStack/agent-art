// Perceptual analysis: what a listener would hear, in words. Agents cannot hear, so this turns
// signal features into human terms: rhythm (tactus vs written BPM, kick/hat patterns, swing,
// drive), tonality (key/mode, chords, tension), timbre words, mix balance/masking, energy over the
// arrangement, repetition, genre-profile comparison, intent check and a listener report.
import { SR, magSpectrum, a2db, clamp, filter, fft, hann } from './dsp.js';
import { toMono, stft, loudness, spectralSummary, stereoField, kWeighted } from './analysis.js';
import { GENRES } from './genres.js';
import { SCALES, pcName } from './notation.js';

const r1 = (v) => Math.round(v * 10) / 10, r2 = (v) => Math.round(v * 100) / 100;
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const pct = (a, p) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const norm = (v, lo, hi) => clamp((v - lo) / (hi - lo), 0, 1);

// ---------------- onsets ----------------
const OBANDS = { low: [35, 110], lowmid: [110, 700], snare: [1500, 6000], high: [7000, 16000], mid: [500, 4000] };
// attack noisiness ranges: a drum hit adds broadband noise, a sung/played note adds a few partials
const NBANDS = { snare: [1000, 8000], high: [5000, 16000], click: [1000, 10000], body: [120, 1200] };
/**
 * Per-band spectral flux and energy envelopes at ~100 fps, plus drum evidence:
 * - noisy[b][t]: spectral flatness of the power INCREASE over the last 20-30 ms in range b (about 0
 *   for tonal onsets and slow swells, 0.3-0.6 for drum hits);
 * - kick: a 35-110 Hz filter-bank envelope (the 1024-point FFT has only ~3 bins there, so noise
 *   and sustained bass fluctuate like hits) and its dB rise per frame;
 * - etot / ltot: total frame energy (FFT scale) and broadband RMS level (filter scale) for the
 *   absolute gates.
 */
export function onsetFeatures(mono, { coarse = false } = {}) {
  const n = 1024, hop = coarse || mono.length > 240 * SR ? 882 : 441, F = Math.max(1, Math.floor(mono.length / hop));
  const binHz = SR / n;
  const rng = ([lo, hi]) => [Math.max(1, Math.round(lo / binHz)), Math.min(n / 2 - 1, Math.round(hi / binHz))];
  const ranges = Object.fromEntries(Object.entries(OBANDS).map(([k, r]) => [k, rng(r)]));
  const nranges = Object.fromEntries(Object.entries(NBANDS).map(([k, r]) => [k, rng(r)]));
  const flux = {}, energy = {}, noisy = {};
  for (const k of Object.keys(OBANDS)) { flux[k] = new Float32Array(F); energy[k] = new Float32Array(F); }
  for (const k of Object.keys(NBANDS)) noisy[k] = new Float32Array(F);
  const etot = new Float32Array(F);
  let prev = null, p1 = null, p2 = null, p3 = null;
  for (let t = 0; t < F; t++) {
    const m = magSpectrum(mono, t * hop - n / 2, n);
    const lg = new Float32Array(m.length), pw = new Float32Array(m.length);
    let tot = 0;
    for (let k = 0; k < m.length; k++) { lg[k] = Math.log1p(300 * m[k]); pw[k] = m[k] * m[k]; tot += pw[k]; }
    etot[t] = 10 * Math.log10(tot + 1e-12);
    for (const [b, [lo, hi]] of Object.entries(ranges)) {
      let e = 0, f = 0;
      for (let k = lo; k <= hi; k++) { e += pw[k]; if (prev) { const d = lg[k] - prev[k]; if (d > 0) f += d; } }
      energy[b][t] = 10 * Math.log10(e + 1e-12);
      flux[b][t] = f / (hi - lo + 1);
    }
    if (p3) {
      for (const [b, [lo, hi]] of Object.entries(nranges)) {
        let l = 0, ar = 0;
        for (let k = lo; k <= hi; k++) { const d = Math.max(0, pw[k] - Math.min(p2[k], p3[k])) + 1e-16; l += Math.log(d); ar += d; }
        const c = hi - lo + 1;
        noisy[b][t] = ar / c > 1e-12 ? Math.exp(l / c) / (ar / c) : 0;
      }
    }
    prev = lg; p3 = p2; p2 = p1; p1 = pw;
  }
  const drum = new Float32Array(F);
  for (let t = 0; t < F; t++) drum[t] = flux.low[t] * 1.2 + flux.snare[t] * 1 + flux.high[t] * 0.35 + flux.lowmid[t] * 0.5;
  // kick band through a filter bank (4-pole 35 Hz high-pass + 4-pole 110 Hz low-pass), 12 ms RMS
  const y = Float32Array.from(mono);
  filter(y, 'hp', 35, 0.7071, 0, { poles: 4 });
  filter(y, 'lp', 110, 0.7071, 0, { poles: 4 });
  const sq = (x) => { const p = new Float64Array(x.length + 1); for (let i = 0; i < x.length; i++) p[i + 1] = p[i] + x[i] * x[i]; return p; };
  const py = sq(y), pm = sq(mono);
  const rms = (p, len, c, h) => { const a = Math.max(0, c - h), b = Math.min(len, c + h); return 10 * Math.log10((p[b] - p[a]) / Math.max(1, b - a) + 1e-14); };
  const kE = new Float32Array(F), kF = new Float32Array(F), ltot = new Float32Array(F);
  for (let t = 0; t < F; t++) { kE[t] = rms(py, y.length, t * hop, 256); ltot[t] = rms(pm, mono.length, t * hop, 512); if (t) kF[t] = Math.max(0, kE[t] - kE[t - 1]); }
  return { hop, fps: SR / hop, F, flux, energy, drum, noisy, etot, ltot, kick: { energy: kE, flux: kF } };
}

// ---------------- drum gates: absolute level, attack sharpness, noisy transient ----------------
const NOISY_MIN = 0.08, KICK_NOISY = 0.09;
const maxIn = (arr, a, b) => { let m = -Infinity, at = Math.max(0, a); for (let j = Math.max(0, a); j <= Math.min(arr.length - 1, b); j++) if (arr[j] > m) { m = arr[j]; at = j; } return [m, at]; };
/** Kick onsets: filter-bank low-band rises that are loud in absolute terms and start with a noisy click. */
export function kickOnsets(of, fps) {
  const { energy: E, flux } = of.kick;
  let top = -200;
  for (const v of of.ltot) if (v > top) top = v;
  const out = [];
  for (const o of pickOnsets(flux, fps)) {
    const k = Math.round(o.t * fps);
    const [pk] = maxIn(E, k, k + 3);
    const before = Math.min(E[Math.max(0, k - 2)], E[Math.max(0, k - 3)], E[Math.max(0, k - 4)]);
    if (pk < top - 30 || pk < -70) continue; // absolute: the low band must matter in the mix
    if (pk - before < 3) continue; // a transient, not a swell or sustained bass
    // the kick body (pitch-swept down into 35-110 Hz) lags its beater click by up to ~60 ms; the
    // click or thump is noisy in at least one range (a cymbal or chord on the same beat can mask one)
    let nz = 0, at = k;
    for (const b of ['click', 'body', 'snare']) { const [v, j] = maxIn(of.noisy[b], k - 6, k + 1); if (v > nz) { nz = v; at = j; } }
    if (!(nz >= KICK_NOISY || (nz >= NOISY_MIN * 0.6 && pk - before >= 12))) continue;
    const t = at / fps;
    if (out.length && t - out[out.length - 1].t < 0.035) { if (pk > out[out.length - 1].pk) out[out.length - 1] = { t, s: o.s, pk }; continue; }
    out.push({ t, s: o.s, pk });
  }
  // like levelGate: ghost thumps far below the band's loud hits do not count as kicks
  const ref = pct(out.map((o) => o.pk), 0.9);
  return out.filter((o) => o.pk >= ref - LEVEL_DB.low - 4).map(({ t, s }) => ({ t, s }));
}
/** Snare / hat onsets must be noisy transients that are loud enough in absolute terms. */
function percussiveGate(onsets, of, fps, band) {
  let top = -200;
  for (const v of of.etot) if (v > top) top = v;
  return onsets.filter((o) => {
    const k = Math.round(o.t * fps);
    const [nz] = maxIn(of.noisy[band], k - 1, k + 1);
    const [lv] = maxIn(of.energy[band], k, k + 3);
    return nz >= NOISY_MIN && lv >= top - 45;
  });
}

/** Peak-picking onsets (adaptive threshold). Returns [{t (s), s (strength)}]. */
export function pickOnsets(flux, fps, { k = 1.4, minGap = 0.035 } = {}) {
  const F = flux.length, w = Math.max(3, Math.round(0.12 * fps));
  const sorted = Array.from(flux).sort((a, b) => a - b);
  const floor = sorted[Math.floor(F * 0.5)] + (sorted[Math.floor(F * 0.98)] - sorted[Math.floor(F * 0.5)]) * 0.12;
  const pre = new Float64Array(F + 1);
  for (let i = 0; i < F; i++) pre[i + 1] = pre[i] + flux[i];
  const out = [];
  let last = -1e9;
  for (let t = 1; t < F - 1; t++) {
    const v = flux[t];
    if (v < flux[t - 1] || v < flux[t + 1] || v <= floor) continue;
    const a = Math.max(0, t - w), b = Math.min(F, t + w + 1);
    if (v < ((pre[b] - pre[a]) / (b - a)) * k) continue;
    if ((t - last) / fps < minGap) { if (v > out[out.length - 1].s) { out[out.length - 1] = { t: t / fps, s: v }; last = t; } continue; }
    out.push({ t: t / fps, s: v });
    last = t;
  }
  return out;
}

// ---------------- tempo + beats ----------------
const tactusWeight = (bpm) => Math.exp(-0.5 * (Math.log2(bpm / 115) / 0.75) ** 2);
export function tempoEstimate(env, fps) {
  const F = env.length;
  const x = Float32Array.from(env);
  const w = Math.round(fps * 0.5);
  const pre = new Float64Array(F + 1);
  for (let i = 0; i < F; i++) pre[i + 1] = pre[i] + x[i];
  for (let i = 0; i < F; i++) { const a = Math.max(0, i - w), b = Math.min(F, i + w); x[i] = Math.max(0, env[i] - (pre[b] - pre[a]) / (b - a)); }
  const minL = Math.floor((fps * 60) / 260), maxL = Math.ceil((fps * 60) / 30);
  const acf = new Float64Array(maxL * 4 + 2);
  for (let L = 1; L < acf.length && L < F; L++) { let s = 0; for (let i = L; i < F; i++) s += x[i] * x[i - L]; acf[L] = s / (F - L); }
  const at = (L) => { const i = Math.floor(L), f = L - i; return i + 1 < acf.length ? acf[i] * (1 - f) + acf[i + 1] * f : 0; };
  const cands = [];
  for (let L = minL; L <= maxL; L++) {
    const comb = at(L) + 0.5 * at(2 * L) + 0.25 * at(4 * L) + 0.33 * at(L / 2);
    if (at(L) >= at(L - 1) && at(L) >= at(L + 1)) {
      // parabolic refinement
      const y0 = at(L - 1), y1 = at(L), y2 = at(L + 1), d = (y0 - 2 * y1 + y2) ? (0.5 * (y0 - y2)) / (y0 - 2 * y1 + y2) : 0;
      const Lr = L + clamp(d, -0.5, 0.5), bpm = (60 * fps) / Lr;
      if (bpm >= 30 && bpm <= 260) cands.push({ bpm, period: Lr, score: comb });
    }
  }
  if (!cands.length) return { bpm: 0, tactus: 0, confidence: 0, candidates: [] };
  const best = [...cands].sort((a, b) => b.score - a.score);
  const metrical = best[0];
  const tact = [...cands].sort((a, b) => b.score * tactusWeight(b.bpm) - a.score * tactusWeight(a.bpm))[0];
  const conf = clamp(metrical.score / (mean(Array.from(acf.slice(minL, maxL))) * 3 + 1e-12) - 0.3, 0, 1);
  return { bpm: metrical.bpm, tactus: tact.bpm, period: tact.period, confidence: r2(conf), candidates: best.slice(0, 4).map((c) => r1(c.bpm)) };
}
export function trackBeats(env, fps, period, duration) {
  if (!period) return [];
  const F = env.length;
  let bestPh = 0, bestS = -1;
  for (let ph = 0; ph < period; ph += 0.5) {
    let s = 0;
    for (let t = ph; t < F; t += period) { const i = Math.round(t); s += Math.max(env[i] || 0, env[i - 1] || 0, env[i + 1] || 0); }
    if (s > bestS) { bestS = s; bestPh = ph; }
  }
  const beats = [];
  let t = bestPh;
  const win = Math.max(1, Math.round(period * 0.08));
  while (t < F) {
    let bi = Math.round(t), bv = env[bi] || 0;
    for (let d = -win; d <= win; d++) { const v = env[Math.round(t) + d] || 0; if (v > bv * 1.15) { bv = v; bi = Math.round(t) + d; } }
    beats.push(bi / fps);
    t = bi + period;
  }
  return beats.filter((b) => b <= duration);
}

// ---------------- rhythm ----------------
const W16 = [5, 1, 2, 1, 3, 1, 2, 1, 4, 1, 2, 1, 3, 1, 2, 1];
// A broadband hit (snare, crash) leaks a little flux into every band; a real kick/snare/hat onset
// is also loud in its own band: keep onsets that rise >= 4 dB and peak within N dB of the band's top.
const LEVEL_DB = { low: 10, lowmid: 14, snare: 10, high: 14, mid: 14 };
function levelGate(onsets, E, fps, db) {
  if (!onsets.length) return onsets;
  const peakAt = (t) => { const k = Math.round(t * fps); let m = -200; for (let j = k; j < Math.min(E.length, k + 4); j++) m = Math.max(m, E[j]); return m; };
  const lv = onsets.map((o) => peakAt(o.t));
  const top = pct(lv, 0.9);
  return onsets.filter((o, i) => { const k = Math.round(o.t * fps); const before = Math.min(...Array.from({ length: 3 }, (_, j) => E[Math.max(0, k - 2 - j)])); return lv[i] >= top - db && lv[i] - before >= 4; });
}
// snare vs cymbals/kick beater: a snare has body (110-700 Hz rises with it) and is not a hat-dominant
// event (cymbals are loud in 7-16 kHz relative to their usual level, snares in 1.5-6 kHz)
function snareOnly(onsets, of, fps, kicks = []) {
  const E = of.energy, rel = {};
  const at = (b, t) => { const k = Math.round(t * fps); let m = -200; for (let j = k; j < Math.min(E[b].length, k + 4); j++) m = Math.max(m, E[b][j]); return m; };
  const rise = (b, t) => { const k = Math.round(t * fps); return at(b, t) - Math.min(E[b][Math.max(0, k - 2)], E[b][Math.max(0, k - 3)], E[b][Math.max(0, k - 4)]); };
  for (const b of ['snare', 'high', 'lowmid']) rel[b] = pct(onsets.map((o) => at(b, o.t)), 0.9);
  const cand = onsets.filter((o) => rise('lowmid', o.t) >= 3 && at('lowmid', o.t) >= rel.lowmid - 12 && at('snare', o.t) - rel.snare >= at('high', o.t) - rel.high - 3);
  // kick beater/body leaks into the snare band: a hit on a kick only counts as snare when it is as
  // loud there as the stand-alone snares (or, with none, clearly louder than the other kick hits)
  const nearKick = (o) => kicks.some((k) => Math.abs(k.t - o.t) < 0.03);
  const pure = cand.filter((o) => !nearKick(o)), co = cand.filter(nearKick);
  if (!co.length) return cand;
  const lv = (o) => at('snare', o.t);
  let keep;
  if (pure.length >= 2) { const ref = pct(pure.map(lv), 0.5); keep = co.filter((o) => lv(o) >= ref - 3); }
  else { const l = co.map(lv), mx = Math.max(...l); keep = mx - Math.min(...l) > 8 ? co.filter((o) => lv(o) >= mx - 3) : co; }
  return [...pure, ...keep].sort((a, b) => a.t - b.t);
}
function occupancy(onsets, grid) {
  const occ = new Float64Array(16), offs = [];
  const nb = grid.bars;
  if (nb < 1) return { occ, offs, perBar: 0 };
  const hit = new Set();
  let onGrid = 0;
  for (const o of onsets) {
    const pos = (o.t - grid.t0) / grid.barSec;
    if (pos < 0 || pos >= nb) continue;
    const b = Math.floor(pos), st = (pos - b) * 16, s = Math.round(st), off = st - s;
    if (Math.abs(off) > 0.4) continue;
    const key = b * 16 + (s % 16);
    if (hit.has(key)) continue;
    hit.add(key); onGrid++;
    occ[s % 16] += 1;
    offs.push({ s: s % 16, off });
  }
  for (let i = 0; i < 16; i++) occ[i] /= nb;
  return { occ, offs, perBar: onGrid / nb };
}
const fmtOcc = (occ) => Array.from(occ).map((v) => (v >= 0.75 ? 'X' : v >= 0.4 ? 'x' : v >= 0.15 ? 'o' : '.')).join('');

export function classifyDrums(low, snare, high, tempo) {
  const kick = low.occ, sn = snare.occ, hh = high.occ;
  const onBeats = [0, 4, 8, 12];
  let kickType;
  const others = mean([...kick].filter((_, i) => !onBeats.includes(i)));
  if (low.perBar < 0.4 && snare.perBar < 0.4) kickType = 'none';
  else if (onBeats.every((i) => kick[i] >= 0.5) && others < 0.25 && low.perBar < 5.5 && snare.perBar < 6) kickType = 'four_on_the_floor';
  else if (low.perBar >= 12) kickType = 'double_kick';
  else if ((low.perBar >= 5 && snare.perBar >= 5) || (snare.perBar >= 6.5 && low.perBar >= 2.5)) kickType = 'blast'; // incl. hammer/gravity blasts
  else if (low.perBar >= 7) kickType = 'double_kick';
  else {
    const back = (sn[4] + sn[12]) / 2, half = sn[8];
    const sync = kick[2] + kick[3] + kick[6] + kick[7] + kick[10] + kick[11] + kick[14] + kick[15];
    const dbeat = [1, 0, 0, 1, 1, 0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 0];
    const dcor = dbeat.reduce((s, v, i) => s + v * kick[i], 0) / 6;
    if (half >= 0.45 && half > 1.4 * Math.max(sn[4], sn[12])) kickType = high.perBar >= 10 && tempo > 125 ? 'trap' : 'half_time';
    else if (dcor > 0.5 && back >= 0.4) kickType = 'dbeat';
    else if (back >= 0.4 && sync >= 0.8 && sn[7] + sn[9] + sn[10] + sn[14] >= 0.6 && snare.perBar > 2.5) kickType = 'breakbeat';
    else if (back >= 0.4) kickType = 'backbeat';
    else kickType = low.perBar < 1.5 ? 'sparse' : 'irregular';
  }
  let hats;
  const off = (hh[2] + hh[6] + hh[10] + hh[14]) / 4, on = (hh[0] + hh[4] + hh[8] + hh[12]) / 4;
  if (high.perBar < 0.5) hats = 'none';
  else if (off >= 0.4 && on < off * 0.75 && high.perBar < 7) hats = 'offbeat';
  else if (high.perBar >= 13) hats = high.rolls ? 'rolls' : '16ths';
  else if (high.perBar >= 5) hats = '8ths';
  else hats = 'sparse';
  return { kick: kickType, hats };
}
const KICK_WORDS = { none: 'no audible kick/beat', sparse: 'sparse, occasional low hits', irregular: 'irregular low hits with no clear pattern', four_on_the_floor: 'four-on-the-floor kick (every beat)', backbeat: 'rock/metal backbeat (kick on 1 and 3 area, snare on 2 and 4)', half_time: 'half-time feel (snare on beat 3)', blast: 'blast beats (kick and snare hammering 8ths/16ths)', double_kick: 'continuous double-kick', breakbeat: 'syncopated breakbeat', dbeat: 'd-beat (punk/crust gallop)', trap: 'trap half-time with rolling hats' };

export function rhythm(mono, { tempo = null, beatsPerBar = 4, drums = null, of = null } = {}) {
  const dur = mono.length / SR;
  const of1 = of || onsetFeatures(mono);
  const ofd = drums ? onsetFeatures(drums) : of1; // the drum stem when we have it (like focusing on the kit)
  const fps = of1.fps;
  const on = Object.fromEntries(Object.keys(OBANDS).map((b) => [b, levelGate(pickOnsets(ofd.flux[b], fps), ofd.energy[b], fps, LEVEL_DB[b])]));
  // drums need evidence a relative threshold cannot give: absolute level, a sharp attack and a
  // noisy (percussive) transient. Choirs, organs, drones, wind and sub bass have none of them.
  on.low = kickOnsets(ofd, fps);
  on.snare = percussiveGate(on.snare, ofd, fps, 'snare');
  on.high = percussiveGate(on.high, ofd, fps, 'high');
  on.snare = snareOnly(on.snare, ofd, fps, on.low);
  // the analysed file often has a reverb/release tail: only bars that contain hits count
  const lastHit = Math.max(0, ...['low', 'snare', 'high'].map((b) => (on[b].length ? on[b][on[b].length - 1].t : 0)));
  const allOn = pickOnsets(of1.drum, fps);
  const te = tempoEstimate(of1.drum, fps);
  // grid: the written grid when the perceived tempo is a simple ratio of it, else tracked beats
  let grid = null, gridSource = 'tracked';
  if (tempo) {
    const ratios = [0.5, 1, 2, 4, 0.25].map((k) => ({ k, e: Math.abs(Math.log2((te.bpm || tempo) / (tempo * k))) }));
    if (ratios.some((r) => r.e < 0.06)) { gridSource = 'written'; grid = { t0: 0, barSec: (beatsPerBar * 60) / tempo }; }
  }
  const beats = trackBeats(of1.drum, fps, te.period, dur);
  if (!grid) {
    // bar = 4 tactus beats (or 2 when the tactus is a half-time feel of a fast metre)
    const beatSec = te.tactus ? 60 / te.tactus : 0.5;
    let best = 0, bs = -1;
    for (let d = 0; d < 4; d++) { let s = 0; for (let i = d; i < beats.length; i += 4) { const k = Math.round(beats[i] * fps); s += (ofd.flux.low[k] || 0) + (ofd.flux.high[k] || 0) * 0.3; } if (s > bs) { bs = s; best = d; } }
    grid = { t0: beats[best] ?? 0, barSec: beatSec * 4 };
  }
  grid.bars = Math.max(0, Math.min(Math.floor((dur - grid.t0) / grid.barSec), Math.floor((lastHit - grid.t0) / grid.barSec + 0.999)));
  const occ = Object.fromEntries(Object.entries(on).map(([b, o]) => [b, occupancy(o, grid)]));
  occ.high.rolls = on.high.length / Math.max(1, grid.bars) > occ.high.perBar * 1.3 + 2;
  const gridBpm = (60 * beatsPerBar) / grid.barSec;
  const cls = classifyDrums(occ.low, occ.snare, occ.high, gridBpm);
  // swing: offsets of off-beat 16ths (odd steps) in fractions of a step; tightness: timing spread
  const offsOdd = [...occ.snare.offs, ...occ.high.offs].filter((o) => o.s % 2 === 1).map((o) => o.off);
  const offsAll = [...occ.low.offs, ...occ.snare.offs, ...occ.high.offs].map((o) => o.off);
  const swing = offsOdd.length >= 8 ? clamp(mean(offsOdd), 0, 0.5) : 0;
  const stepMs = (grid.barSec / 16) * 1000;
  const tightMs = offsAll.length ? Math.sqrt(mean(offsAll.map((o) => o * o))) * stepMs : 0;
  const synMass = [...occ.low.occ].map((v, i) => v + occ.snare.occ[i]);
  const tot = synMass.reduce((a, b) => a + b, 0);
  const syncopation = tot ? synMass.reduce((s, v, i) => s + v * (5 - W16[i]), 0) / (tot * 4) : 0;
  const density = Object.fromEntries(Object.entries(on).map(([b, o]) => [b, r1(o.length / dur)]));
  const perceived = te.tactus || 0;
  let feel = 'unclear pulse';
  if (perceived && tempo) {
    const ratio = perceived / tempo;
    feel = Math.abs(Math.log2(ratio)) < 0.08 ? 'felt at the written tempo' : Math.abs(Math.log2(ratio / 0.5)) < 0.08 ? 'half-time feel (listeners tap at half the written BPM)' : Math.abs(Math.log2(ratio / 2)) < 0.08 ? 'double-time feel (listeners tap at twice the written BPM)' : Math.abs(Math.log2(ratio / 1.5)) < 0.08 || Math.abs(Math.log2(ratio / 0.667)) < 0.08 ? 'triplet/dotted feel' : `felt around ${r1(perceived)} BPM, not the written ${tempo}`;
  } else if (perceived) feel = `pulse around ${r1(perceived)} BPM`;
  const lowPulse = occ.low.perBar / Math.max(1e-6, grid.barSec);
  const regularity = clamp(te.confidence, 0, 1);
  const drive = clamp(0.35 * norm(perceived || 0, 50, 170) + 0.35 * norm(lowPulse, 0.3, 6) + 0.3 * regularity, 0, 1);
  const driveWord = drive < 0.25 ? 'floating, no pulse' : drive < 0.45 ? 'laid-back' : drive < 0.62 ? 'steady' : drive < 0.8 ? 'driving' : 'relentless';
  return {
    written_bpm: tempo || undefined, detected_bpm: r1(te.bpm), perceived_bpm: r1(perceived), feel, tempo_confidence: te.confidence, tempo_candidates: te.candidates,
    grid: { source: gridSource, bars: grid.bars, bar_sec: r2(grid.barSec), t0: r2(grid.t0) },
    kick_pattern: cls.kick, kick_words: KICK_WORDS[cls.kick], hats: cls.hats,
    patterns: { kick: fmtOcc(occ.low.occ), snare: fmtOcc(occ.snare.occ), hats: fmtOcc(occ.high.occ) },
    hits_per_bar: { kick: r1(occ.low.perBar), snare: r1(occ.snare.perBar), hats: r1(occ.high.perBar) },
    density_per_s: density, onsets_per_s: r1(allOn.length / dur), swing: r2(swing), timing_spread_ms: r1(tightMs), syncopation: r2(syncopation), drive: r2(drive), drive_words: driveWord,
    _beats: beats, _onsets: on, _of: of1, _grid: grid,
  };
}

// ---------------- tonal ----------------
const KMAJ = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88], KMIN = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
function pearson(a, b) { const ma = mean(a), mb = mean(b); let n = 0, da = 0, db = 0; for (let i = 0; i < a.length; i++) { n += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; } return n / Math.sqrt(da * db || 1); }
// parabolic peak interpolation -> pitch class (bins are too coarse for bass notes otherwise)
function peakPc(m, k, binHz) {
  const a = m[k - 1], b = m[k], c = m[k + 1], d = a - 2 * b + c;
  const f = (k + (d ? (0.5 * (a - c)) / d : 0)) * binHz;
  return ((Math.round(69 + 12 * Math.log2(f / 440)) % 12) + 12) % 12;
}
function chromaFrames(mono) {
  const n = 4096, sp = stft(mono, { n, hop: 2048, maxFrames: 700 });
  const binHz = SR / n, frames = [];
  for (const m of sp.frames) {
    const c = new Float64Array(12), b = new Float64Array(12);
    let e = 0;
    for (let k = 2; k < m.length - 1; k++) {
      const f = k * binHz;
      if (f < 180 || f > 2500) continue;
      if (m[k] < m[k - 1] || m[k] < m[k + 1]) continue; // spectral peaks only
      c[peakPc(m, k, binHz)] += Math.sqrt(m[k]);
      e += m[k] * m[k];
    }
    frames.push({ c, b, e, t: (frames.length * sp.hop) / SR });
  }
  // bass notes need ~2.7 Hz resolution (E1-E2 semitones are 2-5 Hz apart): a long-window pass
  const bn = 16384, bsp = stft(mono, { n: bn, hop: 4096, maxFrames: 500 }), bHz = SR / bn;
  for (let i = 0; i < bsp.frames.length; i++) {
    const m = bsp.frames[i], t = (i * bsp.hop + bn / 2 - n / 2) / SR;
    const fr = frames[Math.max(0, Math.min(frames.length - 1, Math.round((t * SR) / sp.hop)))];
    if (!fr) break;
    let mx = 0;
    for (let k = Math.ceil(32 / bHz); k < 260 / bHz; k++) mx = Math.max(mx, m[k]);
    let low = -1; // the bass note = the lowest strong peak (its fifth/octave partials sit above it)
    for (let k = Math.ceil(32 / bHz); k < 260 / bHz; k++) {
      if (m[k] < mx * 0.25 || m[k] < m[k - 1] || m[k] < m[k + 1]) continue;
      const pc = peakPc(m, k, bHz);
      fr.c[pc] += Math.sqrt(m[k]) * 0.6;
      if (low < 0 && m[k] >= mx * 0.5) low = k;
    }
    if (low > 0) {
      // a weaker peak at f/2 or f/3 means "low" is a harmonic of a deeper fundamental
      for (const d of [2, 3]) { const k = Math.round(low / d); if (k > 32 / bHz && Math.max(m[k - 1], m[k], m[k + 1]) > mx * 0.12) { low = m[k - 1] > m[k] ? k - 1 : m[k + 1] > m[k] ? k + 1 : k; break; } }
      fr.b[peakPc(m, low, bHz)] += m[low] * 3 + mx;
    }
  }
  return { frames, hop: sp.hop };
}
const ROMAN = ['i', 'bII', 'II', 'bIII', 'III', 'iv', 'bV', 'v', 'bVI', 'VI', 'bVII', 'VII'];
function chordOf(c, b) {
  const s = c.reduce((x, y) => x + y, 0) || 1, cn = c.map((v) => v / s), bmax = Math.max(...b) || 1;
  let best = null;
  for (let r = 0; r < 12; r++) {
    const root = cn[r], fifth = cn[(r + 7) % 12], m3 = cn[(r + 3) % 12], M3 = cn[(r + 4) % 12], d5 = cn[(r + 6) % 12];
    const bass = (b[r] / bmax) * 0.25;
    const cand = [
      ['', root + fifth + M3 - 0.5 * m3], ['m', root + fifth + m3 - 0.5 * M3], ['dim', root + d5 + m3 - 0.5 * fifth],
      ['5', root + fifth + (Math.max(m3, M3) < 0.35 * root ? 0.12 : -0.2)],
    ];
    for (const [q, v] of cand) if (!best || v + bass > best.v) best = { root: r, q, v: v + bass };
  }
  return best;
}
export function tonal(mono, { bars = null, barSec = null, t0 = 0, key = null } = {}) {
  const { frames } = chromaFrames(mono);
  const tot = new Float64Array(12), bas = new Float64Array(12);
  for (const f of frames) for (let i = 0; i < 12; i++) { tot[i] += f.c[i]; bas[i] += f.b[i]; }
  const keys = [];
  for (let r = 0; r < 12; r++) {
    const rot = (p) => Array.from({ length: 12 }, (_, i) => p[(i - r + 12) % 12]);
    const comb = Array.from(tot, (v, i) => v + bas[i] * 0.5);
    keys.push({ root: r, minor: false, s: pearson(comb, rot(KMAJ)) }, { root: r, minor: true, s: pearson(comb, rot(KMIN)) });
  }
  keys.sort((a, b) => b.s - a.s);
  const k0 = keys[0];
  // mode: best binary scale fit with the detected tonic (bass weight favours the real tonic)
  const tonicCands = [k0.root, ...keys.slice(1, 4).map((k) => k.root)];
  const cs = tot.reduce((a, b) => a + b, 0) || 1, bs = bas.reduce((a, b) => a + b, 0) || 1;
  // scale fit uses mid chroma plus the bass line (cleaner: no overtones of organ mixtures)
  const fit = Array.from(tot, (v, i) => v / cs + (bas[i] / bs) * 0.6);
  let mode = null;
  const MODES = ['aeolian', 'phrygian', 'dorian', 'harmonic_minor', 'phrygian_dominant', 'ionian', 'mixolydian', 'lydian'];
  // modes sharing one pitch set differ only by tonic: the bass/pedal (lowest notes) decides it
  for (const b of [...bas.keys()].sort((x, y) => bas[y] - bas[x]).slice(0, 3)) tonicCands.push(b);
  for (const t of new Set(tonicCands)) for (const m of MODES) {
    const sc = SCALES[m];
    let inS = 0;
    for (let i = 0; i < 12; i++) if (sc.includes((i - t + 12) % 12)) inS += fit[i] / 1.6;
    const v = inS - (1 - inS) * 1.2 + (bas[t] / (Math.max(...bas) || 1)) * 0.35 + (t === k0.root ? 0.05 : 0) + (m === 'aeolian' || m === 'ionian' ? 0.005 : 0);
    if (!mode || v > mode.v) mode = { tonic: t, mode: m, v };
  }
  // chords per bar (or per 2 s)
  const segSec = barSec || 2, nSeg = bars || Math.floor((frames.length ? frames[frames.length - 1].t : 0) / segSec);
  const chords = [];
  for (let s = 0; s < nSeg; s++) {
    const a = t0 + s * segSec, b = a + segSec;
    const c = new Float64Array(12), bb = new Float64Array(12);
    let e = 0;
    for (const f of frames) if (f.t >= a && f.t < b) { for (let i = 0; i < 12; i++) { c[i] += f.c[i]; bb[i] += f.b[i]; } e += f.e; }
    if (e < 1e-9) { chords.push(null); continue; }
    const ch = chordOf(c, bb);
    chords.push(`${pcName(ch.root).replace(/^./, (x) => x.toUpperCase())}${ch.q}`);
  }
  const prog = [];
  for (const c of chords) { if (prog.length && prog[prog.length - 1].c === c) prog[prog.length - 1].n++; else prog.push({ c, n: 1 }); }
  const roman = chords.filter(Boolean).map((c) => { const pc = { c: 0, 'c#': 1, d: 2, eb: 3, e: 4, f: 5, 'f#': 6, g: 7, ab: 8, a: 9, bb: 10, b: 11 }[c.match(/^([A-G][#b]?)/)[1].toLowerCase()]; return ROMAN[(pc - mode.tonic + 12) % 12]; });
  const uniq = new Set(chords.filter(Boolean));
  return {
    key: `${pcName(mode.tonic)} ${mode.mode}`, key_profile: `${pcName(k0.root)} ${k0.minor ? 'minor' : 'major'}`, key_confidence: r2(k0.s), minor: ['aeolian', 'phrygian', 'dorian', 'harmonic_minor', 'locrian', 'phrygian_dominant'].includes(mode.mode),
    chroma: Array.from(tot, (v) => r2(v / cs)),
    chords_per_segment: chords, progression: prog.slice(0, 24).map((p) => `${p.c || '-'}${p.n > 1 ? `(${p.n})` : ''}`).join(' > '),
    distinct_chords: uniq.size, degrees_used: [...new Set(roman)].join(' '), _tonic: mode.tonic,
  };
}

/** Plomp-Levelt roughness of the strongest spectral peaks (dissonance), per window. */
function roughness(frame, binHz) {
  const peaks = [];
  for (let k = 2; k < frame.length - 1; k++) { const f = k * binHz; if (f < 50 || f > 4000) continue; if (frame[k] > frame[k - 1] && frame[k] >= frame[k + 1]) peaks.push([f, frame[k]]); }
  peaks.sort((a, b) => b[1] - a[1]);
  const P = peaks.slice(0, 16);
  let num = 0, den = 0;
  for (let i = 0; i < P.length; i++) {
    den += P[i][1] * P[i][1];
    for (let j = i + 1; j < P.length; j++) {
      const fmin = Math.min(P[i][0], P[j][0]), df = Math.abs(P[i][0] - P[j][0]), s = 0.24 / (0.021 * fmin + 19);
      num += P[i][1] * P[j][1] * (Math.exp(-3.5 * s * df) - Math.exp(-5.75 * s * df));
    }
  }
  return den ? num / den : 0;
}

// ---------------- timbre ----------------
const distWordOf = (d) => (d < 0.2 ? 'clean' : d < 0.4 ? 'lightly saturated' : d < 0.6 ? 'crunchy, distorted' : d < 0.8 ? 'heavily distorted' : 'saturated wall of distortion/noise');
/** Median frame spectral flatness 300 Hz - 4 kHz (dense intermodulation/noise reads as distortion). */
function frameFlatness(frames, binHz, step = 1) {
  const fl = [];
  for (let i = 0; i < frames.length; i += step) {
    const f = frames[i];
    let l = 0, a = 0, cc = 0;
    for (let k = Math.ceil(300 / binHz); k < Math.min(f.length, 4000 / binHz); k++) { const p = f[k] * f[k] + 1e-20; l += Math.log(p); a += p; cc++; }
    if (a / cc > 1e-10) fl.push(Math.exp(l / cc) / (a / cc));
  }
  return pct(fl, 0.5);
}
/**
 * Distortion from harmonic structure, not spectral flatness (a reverb wash, a pedal organ or a drum
 * kit are flat/dense without being distorted). On pitched frames (energy at prominent partials
 * >= 50 % of 150 Hz-8 kHz) that are not deep in a decay/reverb tail (within 12 dB of the level of
 * the last 1.5 s and 20 dB of the loudest frame):
 * - harmonic extension: partial energy 2.5-8 kHz vs 150-1500 Hz (clipping/amp gain pushes high
 *   harmonics up: clean sources sit below -15 dB, a high-gain rhythm guitar near -1 dB);
 * - intermodulation grass: energy between the partials (1 - partial share).
 * Noise-like material (drums, wind) has too few pitched frames and scores 0.
 */
export function harmonicDistortion(x, { maxFrames = 500 } = {}) {
  const N = 4096, binHz = SR / N, w = hann(N);
  const hop = Math.max(N / 2, Math.floor((x.length - N) / maxFrames));
  const lo = Math.round(150 / binHz), hi = Math.round(8000 / binHz);
  const l0 = lo, l1 = Math.round(1500 / binHz), h0 = Math.round(2500 / binHz);
  const db = (v) => 10 * Math.log10(v + 1e-20);
  const frames = [];
  const re = new Float64Array(N), im = new Float64Array(N), pw = new Float64Array(N / 2), isPk = new Uint8Array(N / 2), nb = new Float64Array(24);
  for (let s = 0; s + N <= x.length; s += hop) {
    re.fill(0); im.fill(0);
    for (let i = 0; i < N; i++) re[i] = x[s + i] * w[i];
    fft(re, im);
    let tot = 0;
    for (let i = 0; i < N / 2; i++) pw[i] = re[i] * re[i] + im[i] * im[i];
    for (let k = lo; k < hi; k++) tot += pw[k];
    const e = db(tot);
    if (tot < 1e-9) { frames.push({ e, pitched: false }); continue; }
    isPk.fill(0);
    for (let k = lo; k < hi; k++) {
      if (!(pw[k] > pw[k - 1] && pw[k] >= pw[k + 1])) continue;
      let c = 0;
      for (let j = k - 12; j <= k + 12; j++) if (j !== k) nb[c++] = pw[j];
      nb.sort();
      if (db(pw[k]) - db(nb[12]) >= 10) isPk[k - 1] = isPk[k] = isPk[k + 1] = 1;
    }
    let peak = 0, pl = 1e-20, ph = 1e-20;
    for (let k = lo; k < hi; k++) if (isPk[k]) { peak += pw[k]; if (k >= l0 && k < l1) pl += pw[k]; else if (k >= h0) ph += pw[k]; }
    const H = peak / tot;
    frames.push({ e, pitched: H >= 0.5, H, ext: db(ph) - db(pl) });
  }
  if (!frames.length) return { distortion: 0, pitched_share: 0, extension_db: null, inharmonic: null };
  const emax = Math.max(...frames.map((f) => f.e));
  const look = Math.max(1, Math.round((1.5 * SR) / hop));
  const use = frames.filter((f, i) => {
    if (f.e < emax - 20) return false;
    let m = -Infinity;
    for (let j = Math.max(0, i - look); j <= i; j++) m = Math.max(m, frames[j].e);
    return f.e >= m - 12; // not deep in a decay / reverb tail
  });
  const pitched = use.filter((f) => f.pitched);
  const share = use.length ? pitched.length / use.length : 0;
  if (pitched.length < 3 || share < 0.15) return { distortion: 0, pitched_share: r2(share), extension_db: null, inharmonic: null };
  const ext = pct(pitched.map((f) => f.ext), 0.5), grass = pct(pitched.map((f) => 1 - f.H), 0.5);
  const d = clamp(norm(ext, -17, 3) + 0.15 * norm(grass, 0.03, 0.3), 0, 1) * clamp(share / 0.4, 0.5, 1);
  return { distortion: d, pitched_share: r2(share), extension_db: r1(ext), inharmonic: r2(grass) };
}
/**
 * Reverb time from free decays (after note offsets and in gaps), per octave band 250 Hz-4 kHz.
 * A decay is a run where the band never re-rises more than 4 dB above its running minimum, lasts
 * >= 0.25 s and falls >= 12 dB; its slope is fitted on the late part (past the direct sound's
 * release knee, the last 25 dB above the decay's minimum). Deep decays (quiet bands, gaps, the file's final tail) weigh most, so a dense mix
 * whose notes overlap no longer reads as a dry room. Returns {rt60, confidence 0-1, decays}.
 */
export function reverbEstimate(mono, { maxSeconds = 600 } = {}) {
  const n = 2048, hop = mono.length > 240 * SR ? 882 : 441, fps = SR / hop;
  const F = Math.max(0, Math.min(Math.floor(mono.length / hop), Math.round(maxSeconds * fps)));
  const binHz = SR / n;
  const OCT = [250, 500, 1000, 2000, 4000].map((fc) => [Math.max(1, Math.floor(fc / Math.SQRT2 / binHz)), Math.ceil((fc * Math.SQRT2) / binHz)]);
  const E = OCT.map(() => new Float32Array(F));
  for (let t = 0; t < F; t++) {
    const m = magSpectrum(mono, t * hop - n / 2, n);
    OCT.forEach(([a, b], i) => { let s = 0; for (let k = a; k < b; k++) s += m[k] * m[k]; E[i][t] = 10 * Math.log10(s + 1e-14); });
  }
  const decays = [];
  for (const [bi, Eb] of E.entries()) {
    // smoothing (70 ms, power domain): a reverb tail in one octave beats by several dB
    const S = new Float32Array(F);
    for (let t = 0; t < F; t++) { let s = 0, c = 0; for (let j = t - 3; j <= t + 3; j++) if (j >= 0 && j < F) { s += Math.pow(10, Eb[j] / 10); c++; } S[t] = 10 * Math.log10(s / c + 1e-14); }
    const sorted = Array.from(S).sort((a, b) => a - b);
    const floor = sorted[Math.floor(F * 0.03)] ?? -140, top = sorted[Math.floor(F * 0.98)] ?? -140;
    if (top - floor < 15) continue;
    let t = 1;
    while (t < F - 1) {
      // start at a local maximum that is well above the floor
      if (!(S[t] >= S[t - 1] && S[t] > S[t + 1] && S[t] > floor + 15)) { t++; continue; }
      const st = t;
      let mn = S[t], k = t + 1;
      // the decay runs until a new note (a re-rise of 4 dB above its running minimum) or the floor
      while (k < F && S[k] <= mn + 4 && S[k] > floor + 2) { if (S[k] < mn) mn = S[k]; k++; }
      const end = k - 1;
      const drop = S[st] - mn;
      if ((end - st) / fps >= 0.25 && drop >= 12) {
        // fit the late part (the reverb tail, past the direct sound's release knee): at least 8 dB
        // below the start, the last 25 dB above this decay's minimum
        const xs = [], ys = [];
        for (let j = st; j <= end; j++) if (S[st] - S[j] >= 8 && S[j] <= mn + 27 && S[j] >= mn + 1) { xs.push(j); ys.push(S[j]); }
        if (xs.length >= 10 && ys[0] - ys[ys.length - 1] >= 6) {
          const mx = mean(xs), my = mean(ys);
          let nn = 0, dx = 0, dy = 0;
          for (let j = 0; j < xs.length; j++) { nn += (xs[j] - mx) * (ys[j] - my); dx += (xs[j] - mx) ** 2; dy += (ys[j] - my) ** 2; }
          const slope = nn / (dx || 1), r2v = dy ? (nn * nn) / (dx * dy) : 0;
          if (slope < -0.003 && r2v >= 0.75) decays.push({ rt: -60 / (slope * fps), r2: r2v, range: ys[0] - ys[ys.length - 1], depth: drop, final: end >= F - 3, band: bi });
        }
      }
      t = Math.max(end, st + 1) + 1;
    }
  }
  if (!decays.length) return { rt60: null, confidence: 0, decays: 0 };
  // weight: fit quality x depth (gaps and quiet bands reach deepest); the final tail is a free decay
  for (const d of decays) d.w = d.r2 ** 2 * Math.min(1, d.range / 25) * (d.final ? 2 : 1);
  decays.sort((a, b) => a.rt - b.rt);
  const W = decays.reduce((s, d) => s + d.w, 0);
  let acc = 0, rt = decays[decays.length - 1].rt;
  for (const d of decays) { acc += d.w; if (acc >= W / 2) { rt = d.rt; break; } }
  const spread = decays.reduce((s, d) => s + d.w * Math.abs(Math.log2(d.rt / rt)), 0) / W;
  const conf = clamp(Math.min(1, W / 3) * (1 - clamp(spread / 1.2, 0, 0.8)), 0, 1);
  return { rt60: Math.min(30, rt), confidence: r2(conf), decays: decays.length };
}
export function timbre(chs, mono, meas, rhy) {
  const { centroid } = meas.summary, bands = meas.stats.bands;
  const avg = meas.summary.avgPower, binHz = meas.spec.binHz;
  // spectral flatness 200 Hz - 5 kHz of the average spectrum (dense harmonics/noise -> distorted)
  let lg = 0, ar = 0, c = 0;
  for (let k = Math.ceil(200 / binHz); k < Math.min(avg.length, 5000 / binHz); k++) { lg += Math.log(avg[k] + 1e-20); ar += avg[k]; c++; }
  const flat = c ? Math.exp(lg / c) / (ar / c + 1e-20) : 0;
  // frame-level flatness (dense = distortion/noise even when the average is peaky)
  const frameFlat = frameFlatness(meas.spec.frames, binHz, 3);
  const rough = mean(meas.spec.frames.filter((_, i) => i % 4 === 0).map((f) => roughness(f, binHz)));
  const crest = meas.stats.crest_db;
  const hd = harmonicDistortion(mono);
  const distortion = hd.distortion;
  const hi = bands.high + bands.air, lowAll = bands.sub + bands.low;
  const words = [];
  const brightness = centroid < 400 ? 'very dark' : centroid < 800 ? 'dark' : centroid < 1600 ? 'warm/balanced' : centroid < 3000 ? 'bright' : 'very bright, piercing';
  words.push(brightness);
  if (bands.low_mid > 22) words.push('muddy (heavy 250-500 Hz)');
  else if (bands.low + bands.low_mid > 45 && centroid < 900) words.push('warm, thick');
  if (bands.sub > 25) words.push('boomy sub');
  if (lowAll < 10) words.push('thin (little low end)');
  if (bands.presence > 25) words.push('harsh (2-5 kHz forward)');
  if (rough > 0.12) words.push('rough/gritty');
  const distWord = distWordOf(distortion);
  words.push(distWord);
  // reverb: free decays after offsets / in gaps, deepest decays weigh most (see reverbEstimate)
  const of = rhy._of;
  const rv = reverbEstimate(mono);
  const rt = rv.rt60;
  const conf = rv.confidence;
  const spaceOf = (v) => (v < 0.35 ? 'dry' : v < 0.9 ? 'small room' : v < 1.8 ? 'hall' : v < 3.5 ? 'large hall / church' : 'cathedral-sized');
  const space = rt === null ? 'unclear (dense, few gaps)' : `${spaceOf(rt)}${conf < 0.35 ? ' (low confidence: few free decays)' : ''}`;
  const st = meas.stats.stereo;
  const widthWord = chs.length < 2 || st.correlation > 0.97 ? 'mono / centred' : st.correlation > 0.75 ? 'moderately wide' : st.correlation > 0.35 ? 'wide' : st.correlation > 0 ? 'very wide' : 'phase problems (out-of-phase stereo)';
  // synthetic vs organic cues
  const cues = [];
  let organic = 0;
  if (rhy.timing_spread_ms > 2.5) { organic += 0.35; cues.push(`human timing spread ${rhy.timing_spread_ms} ms`); } else if (rhy.onsets_per_s > 1) cues.push('machine-tight timing');
  if (frameFlat > 0.1 && hi > 3) { organic += 0.2; cues.push('noise components (breath/bow/pick/air)'); }
  const fluxVar = pct(Array.from(of.flux.lowmid), 0.5);
  if (fluxVar > 0.01) { organic += 0.2; cues.push('continuous micro-variation in sustained tones'); } else cues.push('static sustained spectra');
  if (rt && rt > 0.6) { organic += 0.15; cues.push('natural-sounding space'); }
  if (distortion > 0.5) organic += 0.1;
  return {
    words, brightness, centroid_hz: Math.round(centroid), distortion: r2(distortion), distortion_words: distWord, harmonic_extension_db: hd.extension_db, roughness: r2(rough), flatness: r2(frameFlat),
    reverb_rt60_s: rt === null ? null : r1(rt), reverb_confidence: conf, space, stereo: widthWord, organic: r2(clamp(organic, 0, 1)), organic_words: organic > 0.55 ? 'organic/played' : organic > 0.3 ? 'mixed (synthetic with human cues)' : 'synthetic/programmed', cues,
  };
}

// ---------------- mix ----------------
const THIRD = Array.from({ length: 30 }, (_, i) => 25 * Math.pow(2, i / 3)).filter((f) => f < 18000);
function thirdOct(avg, binHz) {
  return THIRD.map((fc) => { const lo = fc / Math.pow(2, 1 / 6), hi = fc * Math.pow(2, 1 / 6); let s = 0; for (let k = Math.max(1, Math.floor(lo / binHz)); k < Math.min(avg.length, Math.ceil(hi / binHz)); k++) s += avg[k]; return 10 * Math.log10(s + 1e-20); });
}
const bandName = (f) => (f < 60 ? 'sub' : f < 250 ? 'lows' : f < 500 ? 'low-mids' : f < 2000 ? 'mids' : f < 5000 ? 'presence' : 'highs');
export function mixAnalysis(stems, mixChs, { tempo, beatsPerBar = 4 } = {}) {
  const names = Object.keys(stems || {});
  if (!names.length) return null;
  const mixL = loudness(mixChs).integrated;
  const info = {};
  for (const n of names) {
    const m = toMono(stems[n]);
    const sp = stft(m, { n: 4096, hop: 4096, maxFrames: 250 });
    const sum = spectralSummary(sp);
    const lu = loudness(stems[n]).integrated;
    const of = onsetFeatures(m, { coarse: true });
    const ons = pickOnsets(of.drum, of.fps).length / (m.length / SR);
    const loud = sp.frames.filter((f) => f.reduce((s, v) => s + v * v, 0) > 1e-6);
    const dist = loud.length ? harmonicDistortion(m, { maxFrames: 250 }).distortion : 0;
    const bb = THIRD.map((fc) => [Math.max(1, Math.floor(fc / Math.pow(2, 1 / 6) / sp.binHz)), Math.ceil((fc * Math.pow(2, 1 / 6)) / sp.binHz)]);
    const bf = sp.frames.map((f) => { const o = new Float64Array(bb.length); for (let i = 0; i < bb.length; i++) { let x = 0; for (let k = bb[i][0]; k < Math.min(f.length, bb[i][1]); k++) x += f[k] * f[k]; o[i] = x; } return o; });
    info[n] = { lufs: lu, spec: thirdOct(sum.avgPower, sp.binHz), centroid: sum.centroid, onsetsPerS: ons, dist, _of: of, _bf: bf };
  }
  const active = names.filter((n) => info[n].lufs > -70);
  // masking is judged only where stems actually play together (an intro-only drone is not
  // "masked" by guitars that come in later): per-frame 1/3-octave powers, activity masks
  const T = THIRD.length, F = Math.min(...active.map((n) => info[n]._bf.length));
  const act = {};
  for (const n of active) { const e = info[n]._bf.map((f) => f.reduce((x, y) => x + y, 0)); const mx = Math.max(...e); act[n] = e.map((v) => v > mx * 1e-3 && v > 1e-9); }
  const avgOver = (n, mask) => { const o = new Float64Array(T); let c = 0; for (let j = 0; j < F; j++) if (mask[j]) { c++; const f = info[n]._bf[j]; for (let i = 0; i < T; i++) o[i] += f[i]; } return Array.from(o, (v) => 10 * Math.log10(v / (c || 1) + 1e-20)); };
  const bandsOver = (mask) => {
    const sp = Object.fromEntries(active.map((n) => [n, avgOver(n, mask)]));
    const mix = THIRD.map((_, i) => 10 * Math.log10(active.reduce((s2, n) => s2 + Math.pow(10, sp[n][i] / 10), 0) + 1e-20));
    return { sp, mix, max: Math.max(...mix) };
  };
  const pairs = {};
  const maskedShare = Object.fromEntries(active.map((n) => [n, 0]));
  const ownEnergy = Object.fromEntries(active.map((n) => [n, 0]));
  for (const n of active) {
    const { sp, mix, max } = bandsOver(act[n]);
    THIRD.forEach((_, i) => {
      if (mix[i] < max - 24) return;
      const top = Math.max(...active.filter((o) => o !== n).map((o) => sp[o][i]));
      const e = Math.pow(10, sp[n][i] / 10);
      ownEnergy[n] += e;
      if (sp[n][i] < top - 6) maskedShare[n] += e;
    });
  }
  for (let x = 0; x < active.length; x++) for (let y = x + 1; y < active.length; y++) {
    const A = active[x], B = active[y], mask = act[A].map((v, j) => v && act[B][j]);
    if (mask.filter(Boolean).length < Math.max(4, F * 0.1)) continue;
    const { sp, mix, max } = bandsOver(mask);
    THIRD.forEach((fc, i) => {
      if (mix[i] < max - 24) return;
      const [hiN, loN] = sp[A][i] >= sp[B][i] ? [A, B] : [B, A];
      if (sp[hiN][i] < mix[i] - 8 || sp[loN][i] < sp[hiN][i] - 6) return;
      const k = `${A}+${B}`;
      (pairs[k] ||= { a: A, b: B, bands: [], score: 0 }).bands.push(fc);
      pairs[k].score += 1 - (sp[hiN][i] - sp[loN][i]) / 6;
    });
  }
  const masking = Object.values(pairs).sort((x, y) => y.score - x.score).slice(0, 4).map((p) => ({ stems: [p.a, p.b], range_hz: [Math.round(Math.min(...p.bands)), Math.round(Math.max(...p.bands))], region: bandName(Math.sqrt(Math.min(...p.bands) * Math.max(...p.bands))), severity: r1(p.score), _bands: p.bands }));
  const sorted = active.sort((a, b) => info[b].lufs - info[a].lufs);
  const dom = sorted[0];
  const balance = sorted.map((n) => ({ stem: n, rel_lu: r1(info[n].lufs - mixL), distortion: r2(info[n].dist), masked_pct: Math.round((100 * maskedShare[n]) / (ownEnergy[n] || 1)) }));
  const buried = balance.filter((b) => b.rel_lu < -16 || b.masked_pct > 80).map((b) => b.stem);
  // pumping: beat-synchronous level dips in sustained stems
  const pumping = [];
  if (tempo) for (const n of active) {
    if (info[n].onsetsPerS > 3) continue;
    const E = info[n]._of.energy.mid, fps = info[n]._of.fps, P = Math.round(((60 / tempo) * fps));
    if (P < 4) continue;
    // only sustained material can pump (a riff with rests just has gaps): skip stems whose quiet
    // frames sit far below their loud ones, and dips deeper than 20 dB (those are rests)
    const on = Array.from(E).filter((v) => v > -70);
    if (on.length < E.length * 0.3 || pct(on, 0.9) - pct(on, 0.2) > 18) continue;
    const depths = [];
    for (let s = P; s + P < E.length; s += P) { let mx = -999, mn = 999; for (let k = s; k < s + P; k++) { mx = Math.max(mx, E[k]); mn = Math.min(mn, E[k]); } if (mx > -60) depths.push(mx - mn); }
    const d = pct(depths, 0.5);
    if (d > 5 && d < 20) pumping.push({ stem: n, depth_db: r1(d) });
  }
  return { mix_lufs: r1(mixL), dominant: dom, balance, masking, buried, pumping, spectra: Object.fromEntries(active.map((n) => [n, info[n].spec.map(r1)])), bands_hz: THIRD.map(Math.round) };
}

// ---------------- energy curve + repetition ----------------
export function energyCurve(chs, rhy, timeline) {
  const lu = loudness(chs);
  const of = rhy._of, fps = of.fps, dur = chs[0].length / SR;
  let segs = timeline && timeline.length ? timeline.map((t) => ({ name: t.section, start: t.start, end: Math.min(dur, t.end) })) : null;
  if (!segs) { const L = rhy._grid?.barSec ? rhy._grid.barSec * 8 : 10; segs = []; for (let t = rhy._grid?.t0 || 0; t < dur - 1; t += L) segs.push({ name: `${Math.round(t)}s`, start: t, end: Math.min(dur, t + L) }); }
  const onsAll = Object.values(rhy._onsets).flat();
  const out = segs.filter((s) => s.end - s.start > 0.5).map((s) => {
    const m = lu.momentary.filter((_, i) => i * 0.1 >= s.start && i * 0.1 + 0.4 <= s.end + 0.01).filter((v) => v > -70);
    const L = m.length ? 10 * Math.log10(mean(m.map((v) => Math.pow(10, v / 10)))) : -70;
    const dens = onsAll.filter((o) => o.t >= s.start && o.t < s.end).length / (s.end - s.start);
    const a = Math.floor(s.start * fps), b = Math.min(of.F, Math.ceil(s.end * fps));
    const hi = mean(Array.from(of.energy.high.subarray(a, b))), lo = mean(Array.from(of.energy.low.subarray(a, b)));
    return { section: s.name, start: r1(s.start), end: r1(s.end), lufs: r1(L), density: r1(dens), high_db: r1(hi), low_db: r1(lo) };
  });
  const Ls = out.map((o) => o.lufs).filter((v) => v > -70), Ds = out.map((o) => o.density);
  const lmin = Math.min(...Ls), lmax = Math.max(...Ls), dmax = Math.max(1, ...Ds);
  for (const o of out) o.energy = r2(clamp(0.6 * norm(o.lufs, lmin - 1, lmax + 0.01) + 0.4 * (o.density / dmax), 0, 1));
  const notes = [];
  for (let i = 1; i < out.length; i++) {
    const d = out[i].lufs - out[i - 1].lufs, de = out[i].energy - out[i - 1].energy;
    if (out[i].section === out[i - 1].section) continue;
    const name = out[i].section;
    if (/chorus|climax|drop/i.test(name) && de < 0.08 && d < 1) notes.push(`"${name}" does not lift over "${out[i - 1].section}" (${d >= 0 ? '+' : ''}${r1(d)} LU, energy ${out[i - 1].energy}->${out[i].energy})`);
    else if (/breakdown|bridge|interlude/i.test(name) && de > -0.1) notes.push(`"${name}" does not drop enough (energy ${out[i - 1].energy}->${out[i].energy}); thin it out for contrast`);
    else if (Math.abs(de) >= 0.2) notes.push(`"${name}" ${de > 0 ? 'lifts' : 'drops'} (${d >= 0 ? '+' : ''}${r1(d)} LU, energy ${out[i - 1].energy}->${out[i].energy})`);
  }
  const range = Math.max(...out.map((o) => o.energy)) - Math.min(...out.map((o) => o.energy));
  if (out.length > 2 && range < 0.25) notes.push(`flat energy curve: every section has about the same intensity (range ${r2(range)})`);
  return { segments: out, notes, range: r2(range) };
}
export function repetition(mono, rhy, ton) {
  const g = rhy._grid;
  if (!g || g.bars < 4) return { notes: [], variety: null };
  const { frames } = chromaFrames(mono);
  const of = rhy._of, fps = of.fps;
  const feats = [];
  for (let b = 0; b < g.bars; b++) {
    const a = g.t0 + b * g.barSec, e = a + g.barSec;
    const c = new Float64Array(12);
    for (const f of frames) if (f.t >= a && f.t < e) for (let i = 0; i < 12; i++) c[i] += f.c[i];
    const s = c.reduce((x, y) => x + y, 0) || 1;
    const v = [...Array.from(c, (x) => x / s)];
    for (const band of ['low', 'snare', 'high', 'lowmid']) { const A = Math.floor(a * fps), B = Math.min(of.F, Math.ceil(e * fps)); v.push((mean(Array.from(of.energy[band].subarray(A, B))) + 80) / 80); }
    // onset rhythm per 16th
    const steps = new Array(16).fill(0);
    for (const o of rhy._onsets.low.concat(rhy._onsets.snare)) if (o.t >= a && o.t < e) steps[Math.min(15, Math.floor(((o.t - a) / g.barSec) * 16))] = 1;
    feats.push([...v, ...steps.map((x) => x * 0.15)]);
  }
  const cos = (x, y) => { let n = 0, a = 0, b = 0; for (let i = 0; i < x.length; i++) { n += x[i] * y[i]; a += x[i] * x[i]; b += y[i] * y[i]; } return n / Math.sqrt(a * b || 1); };
  const notes = [];
  // longest run where bar i equals bar i-k (k = 1, 2, 4 bar phrases)
  let worst = null;
  for (const k of [1, 2, 4]) {
    let run = 0, start = 0;
    for (let i = k; i <= feats.length; i++) {
      const same = i < feats.length && cos(feats[i], feats[i - k]) > 0.985;
      if (same) { if (!run) start = i - k; run++; } else { if (run >= k * 3 && (!worst || run > worst.run)) worst = { k, run, start, end: start + run + k }; run = 0; }
    }
  }
  if (worst) notes.push(`bars ${worst.start + 1}-${worst.end}: the same ${worst.k}-bar phrase repeats ${Math.round((worst.end - worst.start) / worst.k)} times with no audible variation`);
  const types = [];
  for (const f of feats) if (!types.some((t) => cos(t, f) > 0.97)) types.push(f);
  const variety = types.length / feats.length;
  if (feats.length >= 8 && variety < 0.15) notes.push(`low variety: only ${types.length} distinct bar types in ${feats.length} bars`);
  if (ton && ton.distinct_chords <= 1 && feats.length > 8) notes.push('harmony never changes (one chord the whole time)');
  return { notes, variety: r2(variety), distinct_bars: types.length, bars: feats.length };
}

// ---------------- genres ----------------
function rangeMatch(v, r, soft) { if (!r || v === null || v === undefined) return 1; const [lo, hi] = r; if (v >= lo && v <= hi) return 1; const d = v < lo ? (lo - v) / soft : (v - hi) / soft; return clamp(1 - d, 0, 1); }
export function genreCompare(p, target = null) {
  const res = [];
  for (const [id, g] of Object.entries(GENRES)) {
    const gaps = [];
    const bpmFelt = p.rhythm.perceived_bpm, bpm = p.rhythm.detected_bpm;
    let tScore = 1;
    if (g.tempo) {
      const cand = [p.rhythm.written_bpm, bpm, bpmFelt, bpm / 2, bpm * 2].filter(Boolean);
      tScore = Math.max(...cand.map((c) => rangeMatch(c, g.tempo, 25)));
      if (tScore < 0.9) gaps.push(`tempo: needs ~${g.tempo[0]}-${g.tempo[1]} BPM, yours is ${p.rhythm.written_bpm || r1(bpm)} BPM (felt ~${r1(bpmFelt)})`);
    } else if (p.rhythm.kick_pattern !== 'none' && p.rhythm.kick_pattern !== 'sparse') { tScore = 0.5; gaps.push('should have no steady beat'); }
    const kScore = g.kick.includes(p.rhythm.kick_pattern) ? 1 : 0;
    if (!kScore) gaps.push(`drums: needs ${g.kick.map((k) => KICK_WORDS[k]).join(' or ')}; yours: ${p.rhythm.kick_words}`);
    const hScore = g.hats.includes(p.rhythm.hats) ? 1 : 0.3;
    if (hScore < 1) gaps.push(`hats: expected ${g.hats.join('/')}, yours: ${p.rhythm.hats}`);
    const dScore = rangeMatch(p.timbre.distortion, g.distortion, 0.3);
    if (dScore < 0.8) gaps.push(`distortion: ${p.timbre.distortion < g.distortion[0] ? 'too clean' : 'too distorted'} (${p.timbre.distortion_words})`);
    const cScore = rangeMatch(p.timbre.centroid_hz, g.centroid, 800);
    if (cScore < 0.8) gaps.push(`tone: ${p.timbre.centroid_hz < g.centroid[0] ? 'too dark' : 'too bright'} (centroid ${p.timbre.centroid_hz} Hz, expected ${g.centroid[0]}-${g.centroid[1]})`);
    const rScore = p.timbre.reverb_rt60_s === null ? 0.7 : rangeMatch(p.timbre.reverb_rt60_s, g.reverb, 1.5);
    if (rScore < 0.8) gaps.push(`space: ${p.timbre.space} (RT60 ~${p.timbre.reverb_rt60_s ?? '?'} s), expected ${g.reverb[0]}-${g.reverb[1]} s`);
    const lScore = rangeMatch(p.meters.lufs, g.lufs, 6);
    if (lScore < 0.8) gaps.push(`loudness ${p.meters.lufs} LUFS, genre masters sit around ${g.lufs[0]} to ${g.lufs[1]} LUFS`);
    const nScore = rangeMatch(p.rhythm.onsets_per_s, g.density, 4);
    if (nScore < 0.8) gaps.push(`density: ${p.rhythm.onsets_per_s} onsets/s, expected ${g.density[0]}-${g.density[1]}`);
    let mScore = 1;
    if (g.minor === true && p.tonal && !p.tonal.minor) { mScore = 0.4; gaps.push('harmony: expected minor/modal, sounds major'); }
    const bass = p.timbre.bass_behaviour;
    const bScore = !g.bass || !bass ? 1 : g.bass.includes(bass) ? 1 : 0.4;
    if (bScore < 1) gaps.push(`bass: expected ${g.bass.join('/')}, yours: ${bass}`);
    const score = (tScore * 2 + kScore * 2.2 + hScore * 0.8 + dScore * 1.3 + cScore * 0.8 + rScore * 1 + lScore * 0.5 + nScore * 1 + mScore * 0.6 + bScore * 0.8) / 11;
    res.push({ genre: id, label: g.label, match: r2(score), gaps });
  }
  res.sort((a, b) => b.match - a.match);
  const t = target && res.find((r) => r.genre === target || r.label === target);
  const top = res[0];
  let verdict;
  const reads = `${p.rhythm.kick_words}, ${p.timbre.distortion_words}, ${p.timbre.space}, ~${r1(p.rhythm.perceived_bpm || p.rhythm.detected_bpm)} BPM felt`;
  if (t) {
    const g = GENRES[t.genre];
    verdict = t.match >= 0.8 ? `Reads as ${g.label} (match ${t.match}).` : `Reads as ${top.label === g.label ? 'a weak ' + g.label : top.label + '-ish'} (${reads}), not convincing ${g.label} (match ${t.match}). ${g.label} needs ${g.needs.join('; ')}. Gaps: ${t.gaps.join('; ')}.`;
  } else verdict = `Closest style: ${top.label} (${top.match}), then ${res[1].label} (${res[1].match}). It reads as: ${reads}.`;
  return { verdict, target: t || undefined, ranking: res.slice(0, 5).map((r) => ({ genre: r.genre, match: r.match, gaps: r.gaps.slice(0, 4) })) };
}

// ---------------- intent ----------------
const INTENT_WORDS = {
  organ: (p) => p.stems?.some((s) => /organ/i.test(s)) || (p.timbre.sustain_harmonic ?? 0) > 0.4,
  choir: (p) => p.stems?.some((s) => /choir|chant|vox|voice/i.test(s)),
  bells: (p) => p.stems?.some((s) => /bell/i.test(s)),
  guitar: (p) => p.stems?.some((s) => /gtr|guitar/i.test(s)) || p.timbre.distortion > 0.45,
  strings: (p) => p.stems?.some((s) => /string/i.test(s)),
  bass: (p) => (p.meters.bands.sub + p.meters.bands.low) > 15,
  drums: (p) => !['none', 'sparse'].includes(p.rhythm.kick_pattern),
  cathedral: (p) => (p.timbre.reverb_rt60_s ?? 0) >= 2.5,
  reverb: (p) => (p.timbre.reverb_rt60_s ?? 0) >= 1.2,
  dry: (p) => (p.timbre.reverb_rt60_s ?? 9) < 0.5,
  heavy: (p) => p.timbre.distortion > 0.45 && (p.meters.bands.low + p.meters.bands.low_mid) > 25,
  brutal: (p) => ['blast', 'double_kick'].includes(p.rhythm.kick_pattern) || p.rhythm.sections_with_blast > 0 || p.timbre.distortion > 0.6,
  distorted: (p) => p.timbre.distortion > 0.45,
  slow: (p) => (p.rhythm.perceived_bpm || 999) < 95,
  fast: (p) => (p.rhythm.perceived_bpm || 0) > 140 || p.rhythm.onsets_per_s > 8,
  dark: (p) => p.timbre.centroid_hz < 1400 || p.tonal?.minor,
  gothic: (p) => p.tonal?.minor && (p.timbre.reverb_rt60_s ?? 0) > 1.5,
  doom: (p) => p.timbre.distortion > 0.4 && p.tonal?.minor,
  loop: (p) => p.meters.seam ? !p.meters.seam.click : null,
};
function intentCheck(intent, p) {
  if (!intent) return null;
  const low = String(intent).toLowerCase();
  const out = { matched: [], missing: [] };
  for (const [w, fn] of Object.entries(INTENT_WORDS)) {
    if (!low.includes(w)) continue;
    if (w === 'slow' && /slow.to.mid/.test(low)) continue;
    const ok = fn(p);
    if (ok === null) continue;
    (ok ? out.matched : out.missing).push(w);
  }
  if (/slow.to.mid|mid.tempo|slow-to-mid/.test(low)) { const b = p.rhythm.perceived_bpm || 0; ((b >= 55 && b <= 130) ? out.matched : out.missing).push(`slow-to-mid tempo (felt ${r1(b)} BPM)`); }
  return out;
}

// ---------------- listener report ----------------
const MOODS = (p) => {
  const m = [];
  if (p.tonal?.minor) m.push(/phrygian|locrian/.test(p.tonal.key) ? 'ominous' : 'dark');
  if ((p.timbre.reverb_rt60_s ?? 0) > 2.5) m.push('vast', 'sacred');
  if (p.timbre.distortion > 0.55) m.push('aggressive', 'heavy');
  if (p.rhythm.drive > 0.75) m.push('relentless');
  else if (p.rhythm.drive < 0.3) m.push('still');
  if ((p.tension?.mean ?? 0) > 0.55) m.push('tense');
  if (p.timbre.centroid_hz > 2500) m.push('bright');
  if (!p.tonal?.minor && p.timbre.distortion < 0.3) m.push('calm');
  return [...new Set(m)];
};
export function listenerReport(p, issues = []) {
  const s = [];
  if (p.kind === 'sfx' && p.sfx) {
    const x = p.sfx;
    s.push(`Reads as: ${x.reads_as}.`);
    s.push(`Envelope: ${x.attack_words} (${x.attack_ms} ms to peak), ${x.hits_words}, ${x.decay_words}; ${x.duration} s long.`);
    s.push(`Timbre: ${p.timbre.words.join(', ')}, ${x.tone_words}${x.pitch_words ? `, ${x.pitch_words}` : ''}; space: ${p.timbre.space}; stereo ${p.timbre.stereo}.`);
    if (issues.length) s.push(`Most audible problems: ${issues.slice(0, 4).map((i) => i.message).join('; ')}.`);
    return s.join(' ');
  }
  const f5 = p.first5;
  s.push(`First 5 s: ${f5.description}.`);
  const tempoTxt = p.rhythm.perceived_bpm ? `A listener taps along at ~${Math.round(p.rhythm.perceived_bpm)} BPM (${p.rhythm.feel})` : 'There is no clear pulse to tap along to';
  const secs = (p.rhythm.sections || []).filter((x) => x.kick && x.kick !== 'none');
  const bySec = new Set(secs.map((x) => x.kick)).size > 1 ? ` (by section: ${secs.map((x) => `${x.section} ${x.kick.replace(/_/g, '-')}`).join(', ')})` : '';
  s.push(`${tempoTxt}; the drums read as ${p.rhythm.kick_words}${bySec}, the groove feels ${p.rhythm.drive_words}.`);
  if (p.tonal) s.push(`Harmony sounds like ${p.tonal.key}${p.tonal.distinct_chords > 1 ? `, moving ${p.tonal.progression.split(' > ').slice(0, 6).join(' > ')}` : ', on one chord'}.`);
  s.push(`Timbre: ${p.timbre.words.join(', ')}; space: ${p.timbre.space}${p.timbre.reverb_rt60_s ? ` (RT60 ~${p.timbre.reverb_rt60_s} s)` : ''}; stereo ${p.timbre.stereo}; sounds ${p.timbre.organic_words}.`);
  s.push(`Mood: ${MOODS(p).join(', ') || 'neutral'}.`);
  if (p.mix) s.push(`Stands out: ${p.mix.dominant}${p.mix.buried.length ? `; buried: ${p.mix.buried.join(', ')}` : ''}${p.mix.masking.length ? `; ${p.mix.masking[0].stems.join(' and ')} fight in the ${p.mix.masking[0].region} (${p.mix.masking[0].range_hz.join('-')} Hz)` : ''}.`);
  const boring = [...(p.repetition?.notes || []), ...(p.energy?.notes || []).filter((n) => /flat|does not/.test(n))];
  if (boring.length) s.push(`Could get boring: ${boring.join('; ')}.`);
  if (p.energy?.notes?.length) { const lifts = p.energy.notes.filter((n) => /lifts|drops \(/.test(n)); if (lifts.length) s.push(`Arrangement: ${lifts.slice(0, 3).join('; ')}.`); }
  if (issues.length) s.push(`Most audible problems: ${issues.slice(0, 4).map((i) => i.message).join('; ')}.`);
  return s.join(' ');
}

/** One-shot description: attack, number of hits, decay, tonal vs noisy, pitch motion, a category guess. */
/**
 * Pitch sweep while the sound is still loud: f0 (normalised autocorrelation, 90 Hz-2 kHz) on
 * 23 ms frames within 12 dB of the peak. An impact's body may drop in pitch, but only as it dies
 * away; a laser / power-up sweeps while it holds its level. -> {sweep (octaves), held_s, frames}
 */
export function pitchSweep(mono, { from = 0 } = {}) {
  // short sounds (sfxr lasers are often < 0.15 s) need short frames to see the glide at all
  const short = mono.length - from < 0.3 * SR;
  const W = short ? 512 : 1024, hop = W / 4, lagMin = Math.max(2, Math.floor(SR / 4000)), lagMax = Math.round(SR / (short ? 180 : 90));
  const lv = [];
  for (let s = from; s + W <= mono.length; s += hop) { let e = 0; for (let i = 0; i < W; i++) e += mono[s + i] * mono[s + i]; lv.push(10 * Math.log10(e / W + 1e-12)); }
  if (!lv.length) return { sweep: 0, held_s: 0, frames: 0 };
  const peak = Math.max(...lv);
  const f0 = [];
  lv.forEach((l, j) => {
    if (l < peak - 12) return;
    const s = from + j * hop;
    let r0 = 0; for (let i = 0; i < W; i++) r0 += mono[s + i] * mono[s + i];
    if (r0 < 1e-9) return;
    const R = new Float64Array(lagMax + 2);
    let best = 0;
    for (let lag = lagMin; lag <= lagMax + 1; lag++) { let r = 0; for (let i = 0; i < W - lag; i++) r += mono[s + i] * mono[s + i + lag]; R[lag] = r / (r0 * (1 - lag / W)); if (lag <= lagMax && R[lag] > best) best = R[lag]; }
    if (best < 0.6) return;
    // the first local maximum within 10% of the best (avoids sub-octave picks), refined parabolically
    let bl = 0;
    for (let lag = lagMin + 1; lag <= lagMax; lag++) if (R[lag] >= 0.9 * best && R[lag] >= R[lag - 1] && R[lag] >= R[lag + 1]) { bl = lag; break; }
    if (!bl) return;
    const a = R[bl - 1], b = R[bl], c = R[bl + 1], den = a - 2 * b + c;
    const lagF = bl + (Math.abs(den) > 1e-9 ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / den)) : 0);
    f0.push({ j, f: SR / lagF });
  });
  // keep the longest glide: consecutive pitched frames whose f0 never jumps more than half an
  // octave (a jump means a different source or an octave error, not a sweep)
  let run = [], cur = [];
  for (const p of f0) {
    const prev = cur[cur.length - 1];
    if (prev && p.j - prev.j <= 2 && Math.abs(Math.log2(p.f / prev.f)) <= 0.5) cur.push(p);
    else { if (cur.length > run.length) run = cur; cur = [p]; }
  }
  if (cur.length > run.length) run = cur;
  const held = run.length ? ((run[run.length - 1].j - run[0].j) * hop + W) / SR : 0;
  if (run.length < 4) return { sweep: 0, held_s: r2(held), frames: run.length, monotonic: 0 };
  const k = Math.max(1, Math.floor(run.length / 3));
  const med = (a) => pct(a.map((x) => x.f), 0.5);
  const sweep = Math.log2(med(run.slice(-k)) / med(run.slice(0, k)));
  // share of steps that move in the sweep's direction (a vibrato or a wobble scores ~0.5)
  let along = 0, moved = 0;
  for (let i = 1; i < run.length; i++) { const d = Math.log2(run[i].f / run[i - 1].f); if (Math.abs(d) < 0.005) continue; moved++; if (Math.sign(d) === Math.sign(sweep)) along++; }
  return { sweep: r2(sweep), held_s: r2(held), frames: run.length, monotonic: r2(moved ? along / moved : 1) };
}
function sfxShape(mono, meas, rhy, tim) {
  const w = Math.round(0.005 * SR), env = [];
  for (let i = 0; i < mono.length; i += w) { let e = 0; for (let k = i; k < Math.min(mono.length, i + w); k++) e += mono[k] * mono[k]; env.push(10 * Math.log10(e / w + 1e-12)); }
  let pk = 0; for (let i = 1; i < env.length; i++) if (env[i] > env[pk]) pk = i;
  const attack = pk * 5;
  let end = pk; while (end < env.length - 1 && env[end] > env[pk] - 30) end++;
  const decay = (end - pk) * 0.005;
  const all = [...rhy._onsets.low, ...rhy._onsets.snare, ...rhy._onsets.high, ...rhy._onsets.mid].map((o) => o.t).sort((a, b) => a - b);
  const hits = all.filter((t, i) => i === 0 || t - all[i - 1] > 0.045).length;
  // centroid motion over the audible part
  const fr = meas.spec.frames, binHz = meas.spec.binHz, cs = [];
  for (const f of fr) { let a = 0, b = 0; for (let k = 1; k < f.length; k++) { const q = f[k] * f[k]; a += q * k * binHz; b += q; } if (b > 1e-9) cs.push(a / b); }
  const third = Math.max(1, Math.floor(cs.length / 3)), c0 = mean(cs.slice(0, third)), c1 = mean(cs.slice(-third));
  const motion = cs.length > 3 ? Math.log2((c1 || 1) / (c0 || 1)) : 0;
  // pitch clarity: normalised autocorrelation peak (50 Hz - 2 kHz) on the loudest frames
  const N = 2048, starts = [];
  const pkS = pk * w;
  for (let k = 0; k < 6; k++) { const st = pkS + Math.round(k * Math.max(0, Math.min(mono.length - pkS - N, (end - pk) * w) / 6)); if (st + N <= mono.length) starts.push(st); }
  const clar = starts.map((st) => {
    let r0 = 0; for (let i = 0; i < N; i++) r0 += mono[st + i] * mono[st + i];
    if (r0 < 1e-9) return 0;
    let best = 0;
    for (let lag = Math.round(SR / 2000); lag < SR / 50; lag++) { let r = 0; for (let i = 0; i < N - lag; i++) r += mono[st + i] * mono[st + i + lag]; best = Math.max(best, r / r0); }
    return best;
  });
  const clarity = clar.length ? mean(clar) : 0;
  const noisy = clarity < 0.45, tonal = clarity > 0.72;
  const sharpPeak = pk >= 2 && env[pk] - env[pk - 2] > 10;
  // a sustained pitch sweep (laser, power-up, fail) vs an impact whose body drops as it dies away
  const b = meas.stats.bands, dur = meas.stats.duration;
  const sw = pitchSweep(mono, { from: Math.max(0, pkS - 1024) });
  // a glide: a steady one-way pitch change (half an octave, or a fast clean zap of a few semitones)
  const asw = Math.abs(sw.sweep);
  const swept = sw.held_s >= 0.04 && sw.monotonic >= 0.6 && (asw >= 0.5 || (asw >= 0.15 && sw.monotonic >= 0.8 && asw / sw.held_s >= 1.5));
  // an impact decays from its peak at once; a zap / laser / power-up holds its level while it glides
  let hold = pk; while (hold < env.length - 1 && env[hold + 1] > env[pk] - 6) hold++;
  const levelHeld = (hold - pk + 1) * 0.005 >= 0.3 * Math.min(dur, 1.5);
  const zap = swept && levelHeld && sw.held_s >= 0.35 * Math.min(dur, 1.5) && clarity >= 0.5;
  const attackW = attack <= 10 ? 'instant, sharp attack' : attack <= 60 ? 'fast attack' : attack <= 250 ? 'soft attack' : 'slow swell';
  const hitsW = hits <= 1 ? 'one impact' : hits <= 3 ? `${hits} distinct hits` : hits / Math.max(0.1, dur) > 12 ? 'a dense crackle/spray of many small hits' : `${hits} hits (rattling/debris)`;
  const decayW = decay < 0.12 ? 'stops dead (tight)' : decay < 0.5 ? 'short decay' : decay < 1.5 ? 'medium tail' : 'long ringing tail';
  const toneW = tonal ? 'tonal (clear pitch)' : noisy ? 'noisy (no clear pitch)' : 'mix of tone and noise';
  const pitchW = swept ? `pitch ${sw.sweep > 0 ? 'rises' : 'falls'} ${Math.abs(sw.sweep)} octave(s) while it sounds` : Math.abs(motion) < 0.4 ? '' : `brightness ${motion > 0 ? 'rises' : 'falls'} over the sound`;
  let reads;
  if (dur < 0.06) reads = 'a click / tick';
  else if (b.sub + b.low > 60 && dur > 1 && !tonal) reads = 'an explosion / heavy rumble';
  else if (clarity >= 0.5 && clarity < 0.85 && dur > 1 && attack > 30 && b.low + b.low_mid > 35) reads = 'a growl / roar (rough pitched voice)';
  else if (zap) reads = sw.sweep < 0 ? 'a falling tone (laser, fail, drop)' : 'a power-up / pickup (rising tone)';
  else if (attack <= 30 && dur < 0.8 && hits <= 3 && decay < 0.5 && !zap) reads = tonal ? 'a punchy impact with a pitched body' : b.presence + b.high > 25 ? 'a sharp crack / snap (whip, bone, blade)' : 'a punchy impact / hit';
  else if (tonal && decay > 1) reads = 'a ringing bell/tone';
  else if (attack > 120 && sharpPeak) reads = 'a swing/whoosh that ends in a crack or impact';
  else if (attack > 120 && !tonal) reads = 'a whoosh / swell';
  else if (hits > 4 && !tonal) reads = b.low_mid + b.low > 40 ? 'wet gore: squelch / splatter' : 'crackle, debris or spray';
  else if (tonal && swept && levelHeld && sw.sweep > 0) reads = 'a power-up / pickup (rising tone)';
  else if (tonal && swept && levelHeld && sw.sweep < 0) reads = 'a falling tone (laser, fail, drop)';
  else if (tonal && decay > 1) reads = 'a ringing bell/tone';
  else if (tonal) reads = dur < 0.4 ? 'a UI blip/click' : 'a tonal sting';
  else if (attack <= 15 && dur < 0.8) reads = b.presence + b.high > 25 ? 'a sharp crack / snap (whip, bone, blade)' : 'a punchy impact / hit';
  else reads = attack <= 15 ? 'an impact with a tail' : 'a textured noise event';
  return { duration: r2(dur), pitch_clarity: r2(clarity), attack_ms: attack, attack_words: attackW, hits, hits_words: hitsW, decay_s: r2(decay), decay_words: decayW, tone_words: toneW, pitch_words: pitchW, sweep_octaves: sw.sweep, reads_as: reads };
}
function firstSeconds(chs, p, stems, dur = 5) {
  const N = Math.min(chs[0].length, dur * SR);
  const seg = chs.map((c) => c.subarray(0, N));
  const L = loudness(seg).integrated;
  const ons = Object.values(p.rhythm._onsets).flat().filter((o) => o.t < dur).length;
  const parts = [];
  if (stems) {
    const act = Object.entries(stems).map(([n, c]) => [n, loudness(c.map((x) => x.subarray(0, N))).integrated]).filter(([, l]) => l > L - 18 && l > -60).sort((a, b) => b[1] - a[1]).map(([n]) => n);
    parts.push(act.length ? `${act.join(', ')} ${act.length > 1 ? 'are' : 'is'} audible` : 'near silence');
  }
  parts.push(L < -40 ? 'almost silent' : L < -24 ? 'quiet' : L < -16 ? 'moderate level' : 'loud from the start');
  parts.push(ons / dur < 0.5 ? 'no rhythmic hits (sustained/ambient opening)' : ons / dur < 3 ? 'a few rhythmic hits' : 'busy rhythm right away');
  return { lufs: r1(L), onsets: ons, description: parts.join(', ') };
}

/**
 * Full perceptual analysis. ctx: {tempo, beatsPerBar, stems:{name:[L,R]}, drums: name of the kit
 * stem, timeline, intent, genre, kind}.
 */
export function perceive(chs, meas, ctx = {}) {
  const mono = meas.mono || toMono(chs);
  const drumsStem = ctx.stems && ctx.drums ? toMono(ctx.stems[ctx.drums]) : null;
  const rhy = rhythm(mono, { tempo: ctx.tempo, beatsPerBar: ctx.beatsPerBar || 4, drums: drumsStem });
  // harmony is judged on the pitched stems when we have them (tuned kick drums fake bass notes)
  let pitched = mono;
  if (ctx.stems && ctx.drums && Object.keys(ctx.stems).length > 1) {
    pitched = new Float32Array(mono.length);
    for (const [n, c] of Object.entries(ctx.stems)) if (n !== ctx.drums) { const m = toMono(c); for (let i = 0; i < pitched.length && i < m.length; i++) pitched[i] += m[i]; }
  }
  const ton = mono.length > 3 * SR ? tonal(pitched, { bars: rhy._grid.bars || null, barSec: rhy._grid.barSec, t0: rhy._grid.t0 }) : null;
  const tim = timbre(chs, mono, meas, rhy);
  // bass behaviour: sustained vs rhythmic vs rumble
  const lowOns = rhy.density_per_s.low;
  const lowShare = meas.stats.bands.sub + meas.stats.bands.low;
  tim.bass_behaviour = lowShare < 6 ? 'none' : rhy.kick_pattern === 'four_on_the_floor' && meas.stats.bands.sub > 12 && tim.reverb_rt60_s !== null ? 'rumble' : lowOns > 3 ? 'riff' : meas.stats.bands.sub > 20 ? 'sub' : 'sustained';
  // tension over time: roughness + loudness + brightness per segment
  const seg = Math.max(1, Math.floor(meas.spec.frames.length / 24));
  const tens = [];
  for (let i = 0; i < meas.spec.frames.length; i += seg) {
    const fr = meas.spec.frames.slice(i, i + seg);
    const rough = mean(fr.map((f) => roughness(f, meas.spec.binHz)));
    const e = mean(fr.map((f) => f.reduce((s, v) => s + v * v, 0)));
    tens.push({ t: r1((i * meas.spec.hop) / SR), rough, e });
  }
  const emax = Math.max(...tens.map((t) => t.e), 1e-12);
  const tension = tens.map((t) => r2(clamp(0.55 * norm(t.rough, 0.02, 0.2) + 0.45 * norm(10 * Math.log10(t.e / emax + 1e-12), -30, 0), 0, 1)));
  const p = { meters: meas.stats, rhythm: rhy, tonal: ton, timbre: tim, stems: ctx.stems ? Object.keys(ctx.stems) : null };
  p.tension = { curve: tension, mean: r2(mean(tension)), words: mean(tension) > 0.6 ? 'tense, dissonant' : mean(tension) > 0.35 ? 'some tension' : 'consonant, calm' };
  p.mix = ctx.stems ? mixAnalysis(ctx.stems, chs, { tempo: ctx.tempo }) : null;
  if (p.mix) {
    // a listener hears a prominent distorted guitar even when the full-mix spectrum is dominated by
    // drums/organ: take the most distorted stem that is loud enough to hear (within 12 LU of the mix)
    const loud = p.mix.balance.filter((b) => b.rel_lu > -12 && b.stem !== ctx.drums && !/drum|kit|perc/i.test(b.stem));
    const top = loud.sort((a, b) => b.distortion - a.distortion)[0];
    if (top && top.distortion * (top.rel_lu > -8 ? 1 : 0.8) > tim.distortion) {
      const old = tim.distortion_words;
      tim.distortion = r2(top.distortion * (top.rel_lu > -8 ? 1 : 0.8));
      tim.distortion_words = distWordOf(tim.distortion);
      tim.distortion_source = top.stem;
      tim.words = tim.words.map((w) => (w === old ? `${tim.distortion_words} (${top.stem})` : w));
    }
  }
  p.energy = mono.length > 8 * SR ? energyCurve(chs, rhy, ctx.timeline) : null;
  p.repetition = mono.length > 8 * SR ? repetition(mono, rhy, ton) : null;
  p.first5 = firstSeconds(chs, p, ctx.stems);
  if (ctx.timeline && ctx.stems && ctx.drums) {
    // per-section drum feel (a song can mix half-time and blast sections)
    p.rhythm.sections = ctx.timeline.map((t) => {
      const a = Math.round(t.start * SR), b = Math.min(chs[0].length, Math.round(t.end * SR));
      if (b - a < SR * 2) return null;
      const r = rhythm(drumsStem.subarray(a, b), { tempo: ctx.tempo, beatsPerBar: ctx.beatsPerBar || 4 });
      return { section: t.section, kick: r.kick_pattern, felt_bpm: r.perceived_bpm };
    }).filter(Boolean);
    p.rhythm.sections_with_blast = p.rhythm.sections.filter((s) => ['blast', 'double_kick'].includes(s.kick)).length;
  }
  p.kind = ctx.kind || 'music';
  if (p.kind === 'sfx') p.sfx = sfxShape(mono, meas, rhy, tim);
  p.genre = ctx.kind === 'sfx' ? null : genreCompare(p, ctx.genre);
  p.intent = intentCheck(ctx.intent, p);
  return p;
}

/** Strip private fields for JSON output. */
export function publicPerception(p) {
  const clean = (o) => (Array.isArray(o) ? o.map(clean) : o && typeof o === 'object' && !(o instanceof Float32Array) ? Object.fromEntries(Object.entries(o).filter(([k]) => !k.startsWith('_')).map(([k, v]) => [k, clean(v)])) : o);
  const out = clean(p);
  delete out.meters;
  return out;
}

/** Compare a track to a reference (both perceived): spectrum curve, loudness, dynamics, tempo, groove, stereo. */
export function compareToReference(a, b, measA, measB) {
  const tA = thirdOct(measA.summary.avgPower, measA.spec.binHz), tB = thirdOct(measB.summary.avgPower, measB.spec.binHz);
  const oA = 10 * Math.log10(tA.reduce((s, v) => s + Math.pow(10, v / 10), 0)), oB = 10 * Math.log10(tB.reduce((s, v) => s + Math.pow(10, v / 10), 0));
  const diff = THIRD.map((fc, i) => ({ hz: Math.round(fc), db: r1(tA[i] - oA - (tB[i] - oB)) }));
  const regions = {};
  for (const d of diff) { const r = bandName(d.hz); (regions[r] ||= []).push(d.db); }
  const spectral = Object.fromEntries(Object.entries(regions).map(([k, v]) => [k, r1(mean(v))]));
  const notes = [];
  for (const [k, v] of Object.entries(spectral)) if (Math.abs(v) >= 3) notes.push(`${k}: ${v > 0 ? '+' : ''}${v} dB vs reference (${v > 0 ? 'cut' : 'boost'} it)`);
  const dl = measA.stats.lufs - measB.stats.lufs;
  if (Math.abs(dl) > 1.5) notes.push(`loudness ${measA.stats.lufs} vs ${measB.stats.lufs} LUFS (${dl > 0 ? 'louder' : 'quieter'} by ${r1(Math.abs(dl))} LU)`);
  const dc = measA.stats.crest_db - measB.stats.crest_db;
  if (Math.abs(dc) > 2) notes.push(`dynamics: crest ${measA.stats.crest_db} vs ${measB.stats.crest_db} dB (${dc > 0 ? 'more dynamic / less compressed' : 'more squashed'})`);
  if (Math.abs(a.rhythm.perceived_bpm - b.rhythm.perceived_bpm) > 4) notes.push(`tempo felt ${a.rhythm.perceived_bpm} vs ${b.rhythm.perceived_bpm} BPM`);
  if (a.rhythm.kick_pattern !== b.rhythm.kick_pattern) notes.push(`drums: yours ${a.rhythm.kick_words}; reference ${b.rhythm.kick_words}`);
  if (Math.abs(a.rhythm.swing - b.rhythm.swing) > 0.06) notes.push(`swing ${a.rhythm.swing} vs ${b.rhythm.swing}`);
  if (Math.abs(a.rhythm.onsets_per_s - b.rhythm.onsets_per_s) > 2) notes.push(`density ${a.rhythm.onsets_per_s} vs ${b.rhythm.onsets_per_s} onsets/s`);
  const ws = measA.stats.stereo.correlation - measB.stats.stereo.correlation;
  if (Math.abs(ws) > 0.15) notes.push(`stereo: yours is ${ws > 0 ? 'narrower' : 'wider'} (correlation ${measA.stats.stereo.correlation} vs ${measB.stats.stereo.correlation})`);
  if (a.timbre.reverb_rt60_s && b.timbre.reverb_rt60_s && Math.abs(Math.log2(a.timbre.reverb_rt60_s / b.timbre.reverb_rt60_s)) > 0.6) notes.push(`space: ${a.timbre.space} vs ${b.timbre.space}`);
  if (a.timbre.distortion_words !== b.timbre.distortion_words) notes.push(`distortion: ${a.timbre.distortion_words} vs ${b.timbre.distortion_words}`);
  return { spectral_diff_db: spectral, curve: diff, notes, summary: notes.length ? notes.join('; ') : 'close to the reference on every measured axis' };
}
export { kWeighted, stereoField, a2db, magSpectrum };
