// Meters and low-level features: BS.1770 loudness (K-weighting, gating), true peak (4x),
// STFT, band energy, stereo field, silence, clipping, DC and loop-seam continuity.
import { SR, biquadCoefs, Biquad, magSpectrum, a2db, clamp } from './dsp.js';

export function toMono(chs) {
  if (chs.length === 1) return chs[0];
  const [L, R] = chs, m = new Float32Array(L.length);
  for (let i = 0; i < L.length; i++) m[i] = (L[i] + R[i]) * 0.5;
  return m;
}

/** K-weighting (pyloudnorm parameters, valid at any sample rate). */
export function kWeighted(ch) {
  const o = Float32Array.from(ch);
  new Biquad('highshelf', 1500, 0.7071, 4).run(o);
  new Biquad('hp', 38, 0.5).run(o);
  return o;
}

/** BS.1770-4 loudness: integrated (gated), momentary (400 ms, 100 ms hop), short-term (3 s), LRA. */
export function loudness(chs) {
  const n = chs[0].length;
  const pre = chs.map((c) => { const k = kWeighted(c); const p = new Float64Array(n + 1); for (let i = 0; i < n; i++) p[i + 1] = p[i] + k[i] * k[i]; return p; });
  const hop = Math.round(0.1 * SR);
  const blockZ = (w) => {
    const out = [];
    for (let s = 0; s + w <= n || (s === 0 && n > 0); s += hop) {
      const e = Math.min(n, s + w), len = e - s;
      let z = 0;
      for (const p of pre) z += (p[e] - p[s]) / len;
      out.push(z);
      if (e >= n) break;
    }
    return out;
  };
  const lk = (z) => (z > 0 ? -0.691 + 10 * Math.log10(z) : -120);
  const mz = blockZ(Math.round(0.4 * SR));
  const momentary = mz.map(lk);
  const abs = mz.filter((z) => lk(z) > -70);
  let integrated = -120;
  if (abs.length) {
    const rel = lk(abs.reduce((a, b) => a + b, 0) / abs.length) - 10;
    const g = abs.filter((z) => lk(z) > rel);
    if (g.length) integrated = lk(g.reduce((a, b) => a + b, 0) / g.length);
  }
  const sz = n > 3 * SR ? blockZ(3 * SR) : [mz.reduce((a, b) => a + b, 0) / Math.max(1, mz.length)];
  const shortTerm = sz.map(lk);
  // loudness range (EBU 3342): 10th..95th percentile of gated short-term loudness
  const st = shortTerm.filter((l) => l > -70);
  let lra = 0;
  if (st.length > 2) {
    const relg = lk(sz.filter((z) => lk(z) > -70).reduce((a, b) => a + b, 0) / st.length) - 20;
    const s2 = st.filter((l) => l > relg).sort((a, b) => a - b);
    if (s2.length > 2) lra = s2[Math.floor(s2.length * 0.95) - 1] - s2[Math.floor(s2.length * 0.1)];
  }
  return { integrated, momentary, shortTerm, lra, hop: 0.1, maxMomentary: Math.max(-120, ...momentary), maxShortTerm: Math.max(-120, ...shortTerm) };
}

/** True peak estimate (4x windowed-sinc interpolation around loud samples). */
export function truePeak(chs) {
  let tp = 0;
  const taps = 8, os = 4;
  const kern = [];
  for (let ph = 1; ph < os; ph++) {
    const k = [];
    for (let t = -taps + 1; t <= taps; t++) { const x = t - ph / os; const w = 0.5 + 0.5 * Math.cos((Math.PI * x) / taps); k.push(x === 0 ? 1 : (Math.sin(Math.PI * x) / (Math.PI * x)) * w); }
    kern.push(k);
  }
  for (const c of chs) {
    let pk = 0;
    for (let i = 0; i < c.length; i++) pk = Math.max(pk, Math.abs(c[i]));
    tp = Math.max(tp, pk);
    const th = pk * 0.6;
    for (let i = taps; i < c.length - taps; i++) {
      if (Math.abs(c[i]) < th && Math.abs(c[i + 1]) < th) continue;
      for (const k of kern) {
        let s = 0;
        for (let t = 0; t < k.length; t++) s += c[i + t - taps + 1] * k[t];
        if (Math.abs(s) > tp) tp = Math.abs(s);
      }
    }
  }
  return tp;
}

/** STFT magnitude frames. maxFrames limits work on long files (hop grows). */
export function stft(x, { n = 2048, hop = 512, maxFrames = 4000, start = 0, end = x.length } = {}) {
  const len = end - start;
  hop = Math.max(hop, Math.ceil(len / maxFrames));
  const frames = [];
  for (let s = start; s < end; s += hop) frames.push(magSpectrum(x, s - n / 2, n));
  return { frames, hop, n, binHz: SR / n, start };
}

export const BANDS = { sub: [20, 60], low: [60, 250], low_mid: [250, 500], mid: [500, 2000], presence: [2000, 5000], high: [5000, 12000], air: [12000, 20000] };

/** Average power per band (fraction of total) + centroid from STFT frames. */
export function spectralSummary(spec) {
  const nb = spec.frames[0]?.length || 0, avg = new Float64Array(nb);
  let cNum = 0, cDen = 0;
  for (const f of spec.frames) {
    let e = 0, c = 0;
    for (let k = 1; k < nb; k++) { const p = f[k] * f[k]; avg[k] += p; e += p; c += p * k * spec.binHz; }
    cNum += c; cDen += e;
  }
  let tot = 0;
  for (let k = 1; k < nb; k++) tot += avg[k];
  const bands = {};
  for (const [name, [lo, hi]] of Object.entries(BANDS)) {
    let s = 0;
    for (let k = Math.max(1, Math.ceil(lo / spec.binHz)); k < Math.min(nb, Math.ceil(hi / spec.binHz)); k++) s += avg[k];
    bands[name] = tot ? s / tot : 0;
  }
  for (let k = 0; k < nb; k++) avg[k] /= Math.max(1, spec.frames.length);
  return { bands, centroid: cDen ? cNum / cDen : 0, avgPower: avg };
}

/** Power in [lo, hi) Hz of one frame. */
export function bandPower(frame, binHz, lo, hi) {
  let s = 0;
  for (let k = Math.max(1, Math.floor(lo / binHz)); k < Math.min(frame.length, Math.ceil(hi / binHz)); k++) s += frame[k] * frame[k];
  return s;
}

export function stereoField(chs) {
  if (chs.length < 2) return { correlation: 1, width: 0, mono_loss_db: 0, balance_db: 0 };
  const [L, R] = chs;
  let lr = 0, ll = 0, rr = 0, mm = 0, ss = 0;
  for (let i = 0; i < L.length; i++) { const l = L[i], r = R[i]; lr += l * r; ll += l * l; rr += r * r; const m = (l + r) / 2, s = (l - r) / 2; mm += m * m; ss += s * s; }
  const corr = ll && rr ? lr / Math.sqrt(ll * rr) : 1;
  return {
    correlation: +corr.toFixed(3),
    width: +(mm ? Math.sqrt(ss / mm) : 0).toFixed(3),
    mono_loss_db: +Math.max(-60, 10 * Math.log10(Math.max(1e-12, mm) / Math.max(1e-12, (ll + rr) / 2))).toFixed(2),
    balance_db: +(10 * Math.log10((ll + 1e-12) / (rr + 1e-12))).toFixed(2),
  };
}

/** Loop seam continuity: second-difference prediction error + level jump across end->start. */
export function seamCheck(chs, start = 0, end = chs[0].length, { beatSec = null } = {}) {
  let worst = 0, ratio = 0, energyJump = 0;
  for (const c of chs) {
    const at = (i) => c[start + ((((i - start) % (end - start)) + (end - start)) % (end - start))];
    const pred = 2 * at(end - 1) - at(end - 2);
    const err = Math.abs(at(end) - pred);
    // typical second differences around the seam
    const d = [];
    for (let i = end - 2048; i < end - 2; i++) if (i > start + 2) d.push(Math.abs(c[i + 2] - 2 * c[i + 1] + c[i]));
    for (let i = start; i < start + 2048 && i + 2 < end; i++) d.push(Math.abs(c[i + 2] - 2 * c[i + 1] + c[i]));
    d.sort((a, b) => a - b);
    const p99 = d[Math.floor(d.length * 0.99)] || 1e-6;
    worst = Math.max(worst, err);
    ratio = Math.max(ratio, err / Math.max(p99, 1e-4));
    // level jump: RMS of the last vs the first window (a beat when the tempo is known, so a
    // rhythmic loop with intended gaps compares hit+gap with hit+gap), minus the loop's own typical
    // window-to-window change (gaps inside the loop are not a seam problem)
    const len = end - start;
    const w = Math.max(64, Math.min(beatSec ? Math.round(beatSec * SR) : Math.round(0.05 * SR), Math.floor(len / 4)));
    const e = (s0) => { let a = 0; for (let i = 0; i < w; i++) a += at(s0 + i) ** 2; return a / w + 1e-9; }; // floor -90 dB
    const raw = Math.abs(10 * Math.log10(e(end - w) / e(start)));
    const nW = Math.floor(len / w), internal = [];
    for (let k = 1; k < nW && internal.length < 400; k++) internal.push(Math.abs(10 * Math.log10(e(start + k * w) / e(start + (k - 1) * w))));
    internal.sort((x, y) => x - y);
    // a change that happens at least twice inside the loop (hit after a gap) is the loop's own rhythm
    const typical = internal.length >= 3 ? internal[internal.length - 2] : 0;
    energyJump = Math.max(energyJump, Math.max(0, raw - typical));
  }
  return { jump: +worst.toFixed(4), jump_ratio: +ratio.toFixed(2), level_jump_db: +energyJump.toFixed(2), click: worst > 0.02 && ratio > 8 };
}

const r1 = (v) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : v);
/** Core meter readings for a buffer. */
export function measure(chs, { loop = null, spec = null, beatSec = null } = {}) {
  const n = chs[0].length;
  let peak = 0, sum2 = 0, dc = 0, clipped = 0;
  for (const c of chs) for (let i = 0; i < n; i++) { const v = c[i], a = Math.abs(v); if (a > peak) peak = a; sum2 += v * v; dc += v; if (a >= 0.9999) clipped++; }
  const rms = Math.sqrt(sum2 / (n * chs.length || 1));
  const th = 0.001; // -60 dBFS
  let head = 0, tail = 0;
  outer: for (; head < n; head++) for (const c of chs) if (Math.abs(c[head]) > th) break outer;
  outer2: for (; tail < n; tail++) for (const c of chs) if (Math.abs(c[n - 1 - tail]) > th) break outer2;
  const lu = loudness(chs);
  const mono = toMono(chs);
  const sp = spec || stft(mono, { n: n > 4 * SR ? 2048 : 1024, hop: 512, maxFrames: 1500 });
  const sum = spectralSummary(sp);
  const out = {
    duration: +(n / SR).toFixed(3), channels: chs.length,
    peak_dbfs: r1(a2db(peak)), true_peak_dbtp: r1(a2db(truePeak(chs))), lufs: r1(lu.integrated), lufs_short_max: r1(lu.maxShortTerm), lra: r1(lu.lra),
    rms_dbfs: r1(a2db(rms)), crest_db: r1(a2db(peak) - a2db(rms)), dc_offset: +(dc / (n * chs.length || 1)).toFixed(5), clipped_samples: clipped,
    head_silence_ms: Math.round((Math.min(head, n) / SR) * 1000), tail_silence_ms: Math.round((Math.min(tail, n) / SR) * 1000),
    centroid_hz: Math.round(sum.centroid),
    bands: Object.fromEntries(Object.entries(sum.bands).map(([k, v]) => [k, +(v * 100).toFixed(1)])),
    stereo: stereoField(chs),
  };
  if (loop) out.seam = seamCheck(chs, loop[0], loop[1], { beatSec });
  return { stats: out, loud: lu, spec: sp, summary: sum, mono };
}

export { clamp };
