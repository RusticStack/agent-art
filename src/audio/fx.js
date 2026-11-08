// Effects and mixing processors. Each operates on chs = [L] or [L, R] in place (or returns new
// channels when the signal becomes stereo). Any numeric parameter marked (auto) also accepts an
// automation curve [[seconds, value], ...]; every effect accepts mix (0..1, auto) = wet/dry.
import { SR, TAU, db2a, a2db, clamp, Biquad, biquadCoefs, filter, shape, makeRng, convolve, lfo, sin01, dcBlock, onePoleLP, cascade } from './dsp.js';

/** Value of a parameter that may be an automation curve [[t, v], ...] at sample i. */
export function at(v, i) {
  if (!Array.isArray(v)) return v;
  const t = i / SR;
  if (t <= v[0][0]) return v[0][1];
  for (let k = 1; k < v.length; k++) {
    if (t < v[k][0]) { const [t0, a] = v[k - 1], [t1, b] = v[k]; return a + ((b - a) * (t - t0)) / Math.max(1e-9, t1 - t0); }
  }
  return v[v.length - 1][1];
}
const curveArr = (v, n) => { const o = new Float32Array(n); for (let i = 0; i < n; i++) o[i] = at(v, i); return o; };
const isCurve = Array.isArray;

// ---------- formants (Csound formant tables; freqs Hz, amps dB, bandwidths Hz) ----------
export const FORMANTS = {
  bass: { a: [[600, 1040, 2250, 2450, 2750], [0, -7, -9, -9, -20], [60, 70, 110, 120, 130]], e: [[400, 1620, 2400, 2800, 3100], [0, -12, -9, -12, -18], [40, 80, 100, 120, 120]], i: [[250, 1750, 2600, 3050, 3340], [0, -30, -16, -22, -28], [60, 90, 100, 120, 120]], o: [[400, 750, 2400, 2600, 2900], [0, -11, -21, -20, -40], [40, 80, 100, 120, 120]], u: [[350, 600, 2400, 2675, 2950], [0, -20, -32, -28, -36], [40, 80, 100, 120, 120]] },
  tenor: { a: [[650, 1080, 2650, 2900, 3250], [0, -6, -7, -8, -22], [80, 90, 120, 130, 140]], e: [[400, 1700, 2600, 3200, 3580], [0, -14, -12, -14, -20], [70, 80, 100, 120, 120]], i: [[290, 1870, 2800, 3250, 3540], [0, -15, -18, -20, -30], [40, 90, 100, 120, 120]], o: [[400, 800, 2600, 2800, 3000], [0, -10, -12, -12, -26], [40, 80, 100, 120, 120]], u: [[350, 600, 2700, 2900, 3300], [0, -20, -17, -14, -26], [40, 60, 100, 120, 120]] },
  alto: { a: [[800, 1150, 2800, 3500, 4950], [0, -4, -20, -36, -60], [80, 90, 120, 130, 140]], e: [[400, 1600, 2700, 3300, 4950], [0, -24, -30, -35, -60], [60, 80, 120, 150, 200]], i: [[350, 1700, 2700, 3700, 4950], [0, -20, -30, -36, -60], [50, 100, 120, 150, 200]], o: [[450, 800, 2830, 3500, 4950], [0, -9, -16, -28, -55], [70, 80, 100, 130, 135]], u: [[325, 700, 2530, 3500, 4950], [0, -12, -30, -40, -64], [50, 60, 170, 180, 200]] },
  soprano: { a: [[800, 1150, 2900, 3900, 4950], [0, -6, -32, -20, -50], [80, 90, 120, 130, 140]], e: [[350, 2000, 2800, 3600, 4950], [0, -20, -15, -40, -56], [60, 100, 120, 150, 200]], i: [[270, 2140, 2950, 3900, 4950], [0, -12, -26, -26, -44], [60, 90, 100, 120, 120]], o: [[450, 800, 2830, 3800, 4950], [0, -11, -22, -22, -50], [40, 80, 100, 120, 120]], u: [[325, 700, 2700, 3800, 4950], [0, -16, -35, -40, -60], [50, 60, 170, 180, 200]] },
};
const VOWEL = { ah: 'a', a: 'a', eh: 'e', e: 'e', ee: 'i', i: 'i', oh: 'o', o: 'o', oo: 'u', u: 'u' };
export const VOWELS = ['ah', 'eh', 'ee', 'oh', 'oo'];
function vowelSpec(voice, v) {
  const t = FORMANTS[voice] || FORMANTS.tenor, k = VOWEL[v];
  if (!k) throw new Error(`vowel must be ${VOWELS.join('|')}`);
  return t[k];
}

function formantFx(ch, { vowel = 'ah', voice = 'tenor', morph = null, rate = 0.1, gain = 0 }) {
  const seq = morph || [vowel];
  const specs = seq.map((v) => vowelSpec(voice, v));
  const n = ch.length, out = new Float32Array(n);
  const bqs = [0, 1, 2, 3, 4].map(() => new Biquad('bp', 500, 5));
  const tmp = new Float32Array(32);
  for (let i = 0; i < n; i += 32) {
    // position in the vowel sequence (triangle sweep through morph list)
    let pos = 0;
    if (specs.length > 1) { const ph = ((i / SR) * rate) % 1; pos = (specs.length - 1) * (1 - Math.abs(1 - 2 * ph)); }
    const k0 = Math.floor(pos), k1 = Math.min(specs.length - 1, k0 + 1), fr = pos - k0;
    const end = Math.min(n, i + 32);
    for (let f = 0; f < 5; f++) {
      const F = specs[k0][0][f] * (1 - fr) + specs[k1][0][f] * fr, A = specs[k0][1][f] * (1 - fr) + specs[k1][1][f] * fr, B = specs[k0][2][f] * (1 - fr) + specs[k1][2][f] * fr;
      bqs[f].set('bp', F, F / B);
      tmp.set(ch.subarray(i, end));
      bqs[f].run(tmp, 0, end - i);
      const g = db2a(A + gain) * 3.2;
      for (let j = i; j < end; j++) out[j] += tmp[j - i] * g;
    }
  }
  return out;
}

// ---------- reverb ----------
export const REVERBS = {
  room: { size: 0.55, decay: 0.78, damp: 0.45, predelay: 0.004, er: 0.5, er_span: 0.025, hp: 120, lp: 9000 },
  studio: { size: 0.7, decay: 0.82, damp: 0.5, predelay: 0.01, er: 0.4, er_span: 0.035, hp: 150, lp: 8000 },
  hall: { size: 1.0, decay: 0.9, damp: 0.35, predelay: 0.022, er: 0.45, er_span: 0.06, hp: 120, lp: 9000 },
  plate: { size: 0.85, decay: 0.88, damp: 0.12, predelay: 0.008, er: 0.1, er_span: 0.01, hp: 200, lp: 12000 },
  crypt: { size: 0.8, decay: 0.9, damp: 0.65, predelay: 0.012, er: 0.6, er_span: 0.04, hp: 100, lp: 5000 },
  cathedral: { size: 1.5, decay: 0.95, damp: 0.3, predelay: 0.045, er: 0.5, er_span: 0.12, hp: 140, lp: 8500 },
  cathedral_huge: { size: 1.8, decay: 0.968, damp: 0.25, predelay: 0.07, er: 0.45, er_span: 0.16, hp: 160, lp: 8000 },
};
const COMBS = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617], APS = [556, 441, 341, 225];

/** Approximate RT60 (s) of an algorithmic preset (for docs/perception). */
export function reverbRT60(p) { const len = 1400 * p.size / SR; return (-3 * len) / Math.log10(p.decay); }

/** Freeverb-style stereo reverb + early reflections; returns wet [L, R] (length + tail). */
export function reverbAlgo(chs, opts = {}) {
  const p = { ...(REVERBS[opts.preset] || REVERBS.hall), ...opts };
  const tail = Math.round((opts.tail ?? Math.min(12, reverbRT60(p) * 0.9)) * SR);
  const n = chs[0].length, N = n + tail;
  const inp = new Float32Array(N);
  const R0 = chs[1] || chs[0];
  for (let i = 0; i < n; i++) inp[i] = (chs[0][i] + R0[i]) * 0.5;
  if (p.hp) filter(inp, 'hp', p.hp, 0.7);
  if (p.lp) filter(inp, 'lp', p.lp, 0.7);
  const pd = Math.round((p.predelay || 0) * SR);
  const outs = [];
  const rng = makeRng(opts.seed ?? 7);
  for (let c = 0; c < 2; c++) {
    const spread = c ? 23 : 0;
    const combs = COMBS.map((l) => ({ b: new Float32Array(Math.round((l + spread) * p.size)), i: 0, f: 0 }));
    const aps = APS.map((l) => ({ b: new Float32Array(Math.round((l + spread) * Math.max(0.6, p.size * 0.8))), i: 0 }));
    const out = new Float32Array(N);
    const fb = p.decay, d1 = p.damp, d2 = 1 - p.damp;
    for (let i = 0; i < N; i++) {
      const x = (i - pd >= 0 ? inp[i - pd] : 0) * 0.03;
      let s = 0;
      for (let k = 0; k < 8; k++) {
        const cb = combs[k], y = cb.b[cb.i];
        cb.f = y * d2 + cb.f * d1;
        cb.b[cb.i] = x + cb.f * fb;
        if (++cb.i >= cb.b.length) cb.i = 0;
        s += y;
      }
      for (let k = 0; k < 4; k++) {
        const ap = aps[k], bo = ap.b[ap.i];
        ap.b[ap.i] = s + bo * 0.5;
        s = bo - s;
        if (++ap.i >= ap.b.length) ap.i = 0;
      }
      out[i] = s;
    }
    // early reflections: sparse taps (different per side) before the dense tail
    if (p.er > 0) {
      const taps = 14;
      for (let t = 0; t < taps; t++) {
        const d = Math.round((pd * 0.3 + (p.er_span * SR * (t + rng.next())) / taps));
        const g = p.er * 0.55 * (1 - t / taps) * (rng.next() * 0.6 + 0.4) * (rng.next() < 0.5 ? -1 : 1);
        for (let i = 0; i + d < N && i < n; i++) out[i + d] += inp[i] * g;
      }
    }
    outs.push(out);
  }
  return outs;
}

/** Generated impulse response: early reflections + exponentially decaying, band-dependent noise tail. */
export function makeIR({ preset = 'hall', rt60, seed = 3, length } = {}) {
  const p = { ...(REVERBS[preset] || REVERBS.hall) };
  const rt = rt60 ?? reverbRT60(p);
  const N = Math.round((length ?? Math.min(10, rt * 1.1)) * SR);
  const rng = makeRng(seed);
  const pd = Math.round(p.predelay * SR);
  const chans = [];
  for (let c = 0; c < 2; c++) {
    const ir = new Float32Array(N);
    // three bands decaying at different rates: lows longest, highs damped
    const bands = [['lp', 400, 1.25], ['bp', 1800, 1.0], ['hp', 4500, 0.55 + (1 - p.damp) * 0.3]];
    for (const [type, f, k] of bands) {
      const b = new Float32Array(N);
      const r = rng.fork(`${c}${f}`);
      const decay = -6.9 / (rt * k * SR);
      for (let i = pd; i < N; i++) {
        const t = i - pd, fadeIn = Math.min(1, t / (0.012 * SR * p.size));
        b[i] = r.bi() * Math.exp(decay * t) * fadeIn;
      }
      filter(b, type, f, type === 'bp' ? 0.6 : 0.7);
      for (let i = 0; i < N; i++) ir[i] += b[i];
    }
    for (let t = 0; t < 18; t++) {
      const d = Math.round(pd * 0.4 + (p.er_span * SR * (t + rng.next())) / 18);
      if (d < N) ir[d] += p.er * (1 - t / 18) * (rng.next() < 0.5 ? -1 : 1) * 0.6;
    }
    if (p.hp) filter(ir, 'hp', p.hp, 0.7);
    if (p.lp) filter(ir, 'lp', p.lp, 0.7);
    let e = 0; for (let i = 0; i < N; i++) e += ir[i] * ir[i];
    const g = 1 / Math.sqrt(e || 1) * 0.5;
    for (let i = 0; i < N; i++) ir[i] *= g;
    chans.push(ir);
  }
  return chans;
}
const IR_CACHE = new Map();
export function reverbConv(chs, opts = {}) {
  const key = JSON.stringify([opts.preset, opts.rt60, opts.seed, opts.length]);
  if (!IR_CACHE.has(key)) { if (IR_CACHE.size > 6) IR_CACHE.clear(); IR_CACHE.set(key, opts.ir || makeIR(opts)); }
  const [irL, irR] = IR_CACHE.get(key);
  const n = chs[0].length, mono = new Float32Array(n), R0 = chs[1] || chs[0];
  for (let i = 0; i < n; i++) mono[i] = (chs[0][i] + R0[i]) * 0.5;
  return [convolve(mono, irL), convolve(mono, irR)];
}

/** Reverb as an effect: mixes wet (wet 0..1) into chs, extending length when tail:true. */
function reverbFx(chs, o) {
  const wet = o.conv || o.type === 'convolution' ? reverbConv(chs, o) : reverbAlgo(chs, o);
  const n = chs[0].length;
  const out = [new Float32Array(n), new Float32Array(n)];
  const R0 = chs[1] || chs[0];
  const w = o.wet ?? 0.3, d = o.dry ?? 1;
  for (let i = 0; i < n; i++) { const ww = at(w, i); out[0][i] = chs[0][i] * d + wet[0][i] * ww; out[1][i] = R0[i] * d + wet[1][i] * ww; }
  return out;
}

// ---------- dynamics ----------
/** Envelope follower in dB (peak, attack/release seconds). */
export function follower(level, attack, release) {
  const n = level.length, out = new Float32Array(n);
  const ga = Math.exp(-1 / (Math.max(1e-5, attack) * SR)), gr = Math.exp(-1 / (Math.max(1e-5, release) * SR));
  let e = 0;
  for (let i = 0; i < n; i++) { const x = level[i]; e = x > e ? ga * e + (1 - ga) * x : gr * e + (1 - gr) * x; out[i] = e; }
  return out;
}
function detector(chs, key) {
  if (key) { const k = new Float32Array(key.length); for (let i = 0; i < k.length; i++) k[i] = Math.abs(key[i]); return k; }
  const n = chs[0].length, k = new Float32Array(n);
  for (const c of chs) for (let i = 0; i < n; i++) { const v = Math.abs(c[i]); if (v > k[i]) k[i] = v; }
  return k;
}
/** Feed-forward compressor with soft knee; key = sidechain buffer. Returns max gain reduction dB. */
export function compress(chs, { threshold = -18, ratio = 4, attack = 0.01, release = 0.12, knee = 6, makeup = 0, key = null, auto_makeup = false } = {}) {
  const env = follower(detector(chs, key), attack, release);
  const n = chs[0].length;
  let maxGR = 0;
  const mk = makeup + (auto_makeup ? -(threshold * (1 - 1 / ratio)) / 2 : 0);
  for (let i = 0; i < n; i++) {
    const x = a2db(env[i]), th = at(threshold, i);
    let y;
    if (2 * (x - th) < -knee) y = x;
    else if (2 * Math.abs(x - th) <= knee) y = x + ((1 / ratio - 1) * (x - th + knee / 2) ** 2) / (2 * knee);
    else y = th + (x - th) / ratio;
    const gr = x - y;
    if (gr > maxGR) maxGR = gr;
    const g = db2a(mk - gr);
    for (const c of chs) c[i] *= g;
  }
  return maxGR;
}
/** Noise gate / expander with hold. range = attenuation dB when closed. */
export function gate(chs, { threshold = -45, attack = 0.001, hold = 0.03, release = 0.08, range = -60, key = null } = {}) {
  const lvl = detector(chs, key), n = lvl.length;
  const env = follower(lvl, 0.0005, 0.02);
  let g = 0, holdN = 0;
  const ga = 1 - Math.exp(-1 / (attack * SR)), gr = 1 - Math.exp(-1 / (release * SR)), floor = db2a(range), th = db2a(threshold);
  for (let i = 0; i < n; i++) {
    let target;
    if (env[i] > th) { target = 1; holdN = hold * SR; } else if (holdN > 0) { holdN--; target = 1; } else target = floor;
    g += (target - g) * (target > g ? ga : gr);
    for (const c of chs) c[i] *= g;
  }
}
/** Transient shaper: attack/sustain in dB (+ = emphasise). */
export function transient(chs, { attack = 4, sustain = 0 } = {}) {
  const lvl = detector(chs);
  const fast = follower(lvl, 0.0008, 0.03), slow = follower(lvl, 0.02, 0.25);
  const n = lvl.length;
  for (let i = 0; i < n; i++) {
    const d = a2db(fast[i] + 1e-9) - a2db(slow[i] + 1e-9);
    const gdb = attack * clamp(d / 9, 0, 1) + sustain * clamp(-d / 9, 0, 1);
    const g = db2a(gdb);
    for (const c of chs) c[i] *= g;
  }
}
/** Linkwitz-Riley 4 split into bands at crossovers. */
function lr4(ch, type, f) { const o = Float32Array.from(ch); filter(o, type, f, 0.7071); filter(o, type, f, 0.7071); return o; }
export function multiband(chs, { crossovers = [150, 2500], bands = [{ threshold: -20, ratio: 3 }, { threshold: -18, ratio: 2.5 }, { threshold: -20, ratio: 3 }], attack = 0.01, release = 0.15 } = {}) {
  const xs = [...crossovers].sort((a, b) => a - b);
  const split = chs.map((c) => {
    const parts = [];
    let rest = c;
    for (const x of xs) { parts.push(lr4(rest, 'lp', x)); rest = lr4(rest, 'hp', x); }
    parts.push(rest);
    return parts;
  });
  const grs = [];
  for (let b = 0; b <= xs.length; b++) {
    const band = split.map((p) => p[b]);
    const o = { attack, release, ...(bands[b] || bands[bands.length - 1]) };
    grs.push(+compress(band, o).toFixed(1));
    if (o.gain) for (const c of band) for (let i = 0; i < c.length; i++) c[i] *= db2a(o.gain);
  }
  chs.forEach((c, ci) => { c.fill(0); for (const p of split[ci]) for (let i = 0; i < c.length; i++) c[i] += p[i]; });
  return grs;
}
/** Lookahead brickwall limiter (non-causal window minimum, no overshoot). ceiling dBFS. */
export function limit(chs, { ceiling = -1, release = 0.08, lookahead = 0.003 } = {}) {
  const n = chs[0].length, L = Math.max(1, Math.round(lookahead * SR)), c = db2a(ceiling);
  const req = new Float32Array(n);
  for (let i = 0; i < n; i++) { let p = 0; for (const ch of chs) { const v = Math.abs(ch[i]); if (v > p) p = v; } req[i] = p > c ? c / p : 1; }
  // window min over [i-L, i+L] (monotonic deque)
  const mn = new Float32Array(n), dq = new Int32Array(n + 2 * L + 2);
  let h = 0, t = 0, j = 0;
  for (let i = 0; i < n; i++) {
    while (j < n && j <= i + L) { while (t > h && req[dq[t - 1]] >= req[j]) t--; dq[t++] = j; j++; }
    while (dq[h] < i - L) h++;
    mn[i] = req[dq[h]];
  }
  // box average (length 2*half+1) of the window minimum: smooth ramps that never exceed req
  const half = Math.max(1, Math.floor(L / 2));
  const pre = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + mn[i];
  const rel = 1 - Math.exp(-1 / (release * SR));
  let g = 1, minG = 1;
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - half), hi = Math.min(n, i + half + 1);
    const target = Math.min(req[i], (pre[hi] - pre[lo]) / (hi - lo));
    g = target < g ? target : g + (target - g) * rel;
    if (g > req[i]) g = req[i];
    if (g < minG) minG = g;
    for (const ch of chs) ch[i] *= g;
  }
  return -a2db(minG);
}

// ---------- modulation / time effects ----------
function fracRead(buf, pos, len) { const i = Math.floor(pos), f = pos - i; const a = buf[((i % len) + len) % len], b = buf[(((i + 1) % len) + len) % len]; return a + (b - a) * f; }
function chorusFx(chs, { voices = 3, delay = 0.014, depth = 0.003, rate = 0.45, mix = 0.5, feedback = 0, seed = 1 }) {
  const n = chs[0].length, rng = makeRng(seed);
  const inL = chs[0], inR = chs[1] || chs[0];
  const outs = [];
  const len = Math.ceil((delay + depth + 0.01) * SR);
  for (let c = 0; c < 2; c++) {
    const src = c ? inR : inL, out = new Float32Array(n), buf = new Float32Array(len);
    const phases = Array.from({ length: voices }, (_, v) => v / voices + c * 0.25 + rng.next() * 0.1);
    let w = 0;
    for (let i = 0; i < n; i++) {
      let acc = 0;
      for (let v = 0; v < voices; v++) {
        const d = (delay + depth * sin01((phases[v] + (i * rate * (1 + v * 0.13)) / SR) % 1)) * SR;
        let pos = w - d; if (pos < 0) pos += len;
        const j = pos | 0, fr = pos - j, j1 = j + 1 >= len ? 0 : j + 1;
        acc += buf[j] + (buf[j1] - buf[j]) * fr;
      }
      acc /= voices;
      buf[w] = src[i] + acc * feedback;
      if (++w >= len) w = 0;
      out[i] = acc;
    }
    outs.push(out);
  }
  const m = mix;
  return [0, 1].map((c) => { const d = c ? inR : inL, o = new Float32Array(n); for (let i = 0; i < n; i++) { const mm = at(m, i); o[i] = d[i] * (1 - mm * 0.5) + outs[c][i] * mm; } return o; });
}
function flangerFx(chs, { delay = 0.0018, depth = 0.0016, rate = 0.15, feedback = 0.6, mix = 0.5 }) {
  return chs.map((src, c) => {
    const n = src.length, len = Math.ceil((delay + depth) * SR) + 4, buf = new Float32Array(len), out = new Float32Array(n);
    let w = 0;
    for (let i = 0; i < n; i++) {
      const d = (delay + depth * sin01(((i * rate) / SR + c * 0.25) % 1)) * SR;
      const y = fracRead(buf, w - d, len);
      buf[w % len] = src[i] + y * feedback;
      w++;
      const mm = at(mix, i);
      out[i] = src[i] * (1 - mm * 0.5) + y * mm;
    }
    return out;
  });
}
export function noteTime(v, tempo = 120) {
  if (typeof v === 'number') return v;
  const m = String(v).match(/^(\d+)\/(\d+)([dt])?$/);
  if (!m) throw new Error(`delay time "${v}" must be seconds or a note value like "1/8", "3/16", "1/4d" (dotted), "1/8t" (triplet)`);
  let beats = (4 * Number(m[1])) / Number(m[2]);
  if (m[3] === 'd') beats *= 1.5;
  if (m[3] === 't') beats *= 2 / 3;
  return (beats * 60) / tempo;
}
function delayFx(chs, { time = 0.375, feedback = 0.35, mix = 0.25, pingpong = true, lp = 4500, hp = 150 }, ctx) {
  const t = noteTime(time, ctx.tempo);
  const n = chs[0].length, D = Math.max(1, Math.round(t * SR));
  const inL = chs[0], inR = chs[1] || chs[0];
  const outL = new Float32Array(n), outR = new Float32Array(n);
  const bl = new Float32Array(D), br = new Float32Array(D);
  const a = 1 - Math.exp((-TAU * lp) / SR), ah = Math.exp((-TAU * hp) / SR);
  let fl = 0, fr = 0, hl = 0, hr = 0, pl = 0, pr = 0;
  for (let i = 0; i < n; i++) {
    const k = i % D, yl = bl[k], yr = br[k];
    fl += a * (yl - fl); fr += a * (yr - fr);
    // gentle highpass in the loop
    hl = ah * (hl + fl - pl); pl = fl; hr = ah * (hr + fr - pr); pr = fr;
    const m = (inL[i] + inR[i]) * 0.5;
    if (pingpong) { bl[k] = m + hr * feedback; br[k] = hl * feedback; } else { bl[k] = inL[i] + hl * feedback; br[k] = inR[i] + hr * feedback; }
    const mm = at(mix, i);
    outL[i] = inL[i] + yl * mm; outR[i] = inR[i] + yr * mm;
  }
  return [outL, outR];
}

// ---------- guitar amp + cabinet ----------
/** High-gain amp: tight HP, mid push, two gain stages (2x oversampled), tone stack. */
export function ampSim(ch, { gain = 30, tight = 110, mid = 900, mid_gain = 6, bass = 2, scoop = -3, treble = 1, presence = 2, level = -6, shape: st = 'tube' } = {}) {
  filter(ch, 'hp', tight, 0.7);
  filter(ch, 'peak', mid, 0.8, mid_gain);
  filter(ch, 'lp', 7500, 0.6);
  shape(ch, { drive: gain * 0.6, type: st });
  filter(ch, 'peak', 720, 0.7, -2);
  shape(ch, { drive: gain * 0.4, type: 'tanh' });
  filter(ch, 'lowshelf', 120, 0.7, bass);
  filter(ch, 'peak', 480, 0.9, scoop);
  filter(ch, 'highshelf', 3200, 0.7, treble);
  filter(ch, 'peak', 3800, 1.2, presence);
  const g = db2a(level);
  for (let i = 0; i < ch.length; i++) ch[i] *= g;
  return ch;
}
/** Speaker cabinet: low resonance, cone breakup, steep 24 dB/oct rolloff (4x12 by default). */
export function cabSim(ch, { lp = 5200, hp = 75, res = 110, res_gain = 3, breakup = 2400, breakup_gain = 2.5 } = {}) {
  filter(ch, 'hp', hp, 0.8);
  filter(ch, 'peak', res, 1.4, res_gain);
  filter(ch, 'peak', breakup, 1.5, breakup_gain);
  filter(ch, 'lp', lp, 0.75, 0, { poles: 4 });
  filter(ch, 'peak', 6500, 2, -4);
  return ch;
}

// ---------- dispatcher ----------
/**
 * Apply an fx chain. fx: [{type, ...params, mix?}]. chs: [L] or [L,R]; returns new chs.
 * ctx: {tempo, seed, key?: (track name) -> Float32Array for sidechain}.
 */
export const FX_TYPES = ['eq', 'filter', 'drive', 'saturate', 'amp', 'cab', 'bitcrush', 'chorus', 'flanger', 'delay', 'reverb', 'comp', 'gate', 'transient', 'multiband', 'limit', 'formant', 'tremolo', 'width', 'gain', 'pan', 'duck', 'fade', 'dc'];
export function applyFx(chs, fx = [], ctx = {}) {
  for (const f of fx || []) {
    if (!f || f.bypass) continue;
    const dry = f.mix !== undefined && !['chorus', 'flanger', 'delay', 'reverb'].includes(f.type) ? chs.map((c) => Float32Array.from(c)) : null;
    chs = applyOne(chs, f, ctx);
    if (dry) {
      const n = chs[0].length;
      chs = chs.map((c, ci) => { const d = dry[Math.min(ci, dry.length - 1)]; for (let i = 0; i < n; i++) { const m = at(f.mix, i); c[i] = (i < d.length ? d[i] : 0) * (1 - m) + c[i] * m; } return c; });
    }
  }
  return chs;
}
function perCh(chs, fn) { chs.forEach(fn); return chs; }
function applyOne(chs, f, ctx) {
  switch (f.type) {
    case 'eq': {
      // fixed bands run as one cascade (one pass over memory); automated bands fall back to filter()
      const fixed = [], moving = [];
      for (const b of f.bands || []) {
        const ty = b.type || 'peak', q = b.q ?? (ty === 'peak' ? 1 : 0.7071);
        if (isCurve(b.f) || isCurve(b.gain)) moving.push(b);
        else for (let s = 0; s < Math.max(1, Math.round((b.poles || 2) / 2)); s++) fixed.push(biquadCoefs(ty, b.f, q, b.gain ?? 0));
      }
      return perCh(chs, (c) => { cascade(c, fixed); for (const b of moving) filter(c, b.type || 'peak', (i) => at(b.f, i), b.q ?? 1, at(b.gain ?? 0, 0), { poles: b.poles || 2 }); });
    }
    case 'filter': return perCh(chs, (c) => {
      const mod = f.lfo ? lfo(c.length, f.lfo.rate ?? 0.2, { depth: f.lfo.depth ?? 1, shape: f.lfo.shape }) : null;
      const ff = isCurve(f.f) || mod ? (i) => at(f.f, i) * (mod ? Math.pow(2, mod[i]) : 1) : f.f;
      filter(c, f.ftype || f.mode || 'lp', ff, f.q ?? 0.7071, f.gain ?? 0, { poles: f.poles || 2 });
    });
    case 'drive': case 'saturate': return perCh(chs, (c) => shape(c, { drive: f.drive ?? (f.type === 'saturate' ? 6 : 18), type: f.shape || (f.type === 'saturate' ? 'tube' : 'tanh'), bias: f.bias ?? 0 }));
    case 'amp': return perCh(chs, (c) => ampSim(c, f));
    case 'cab': return perCh(chs, (c) => cabSim(c, f));
    case 'bitcrush': return perCh(chs, (c) => {
      const q = Math.pow(2, (f.bits ?? 8) - 1), hold = Math.max(1, Math.round(SR / (f.rate ?? 11025)));
      let v = 0;
      for (let i = 0; i < c.length; i++) { if (i % hold === 0) v = Math.round(c[i] * q) / q; c[i] = v; }
    });
    case 'chorus': return chorusFx(chs, f);
    case 'flanger': return flangerFx(chs, f);
    case 'delay': return delayFx(chs, f, ctx);
    case 'reverb': return reverbFx(chs, f);
    case 'comp': { const key = f.key || f.sidechain ? ctx.key?.(f.key || f.sidechain) : null; compress(chs, { ...f, key }); return chs; }
    case 'duck': {
      // sidechain ducking: up to `amount` dB when the key track hits (normalised to its peak)
      const key = ctx.key?.(f.from || f.key);
      if (!key) return chs;
      const env = follower(detector([key]), f.attack ?? 0.003, f.release ?? 0.18);
      let pk = 0; for (let i = 0; i < env.length; i++) if (env[i] > pk) pk = env[i];
      const amt = 1 - db2a(-(f.amount ?? 6));
      return perCh(chs, (c) => { for (let i = 0; i < c.length; i++) c[i] *= 1 - amt * Math.min(1, (env[i] || 0) / (pk || 1)); });
    }
    case 'gate': gate(chs, f); return chs;
    case 'transient': transient(chs, f); return chs;
    case 'multiband': multiband(chs, f); return chs;
    case 'limit': limit(chs, f); return chs;
    case 'formant': return chs.map((c) => formantFx(c, f));
    case 'tremolo': return perCh(chs, (c, ci) => {
      const rate = typeof f.rate === 'string' ? 1 / noteTime(f.rate, ctx.tempo) : f.rate ?? 5;
      for (let i = 0; i < c.length; i++) { const d = at(f.depth ?? 0.5, i); c[i] *= 1 - d * 0.5 * (1 + sin01(((i * rate) / SR + ci * (f.stereo ? 0.5 : 0)) % 1)); }
    });
    case 'width': {
      if (chs.length < 2) chs = [chs[0], Float32Array.from(chs[0])];
      const [L, R] = chs;
      for (let i = 0; i < L.length; i++) { const w = at(f.amount ?? 1.2, i), m = (L[i] + R[i]) / 2, s = ((L[i] - R[i]) / 2) * w; L[i] = m + s; R[i] = m - s; }
      return chs;
    }
    case 'gain': return perCh(chs, (c) => { for (let i = 0; i < c.length; i++) c[i] *= db2a(at(f.db ?? f.gain ?? 0, i)); });
    case 'pan': {
      const m = chs.length > 1 ? chs[0].map((v, i) => (v + chs[1][i]) / 2) : chs[0];
      const L = new Float32Array(m.length), R = new Float32Array(m.length);
      for (let i = 0; i < m.length; i++) { const th = ((clamp(at(f.pan ?? 0, i), -1, 1) + 1) * Math.PI) / 4; L[i] = m[i] * Math.cos(th) * Math.SQRT2; R[i] = m[i] * Math.sin(th) * Math.SQRT2; }
      return [L, R];
    }
    case 'fade': return perCh(chs, (c) => {
      const fi = Math.round((f.in ?? 0) * SR), fo = Math.round((f.out ?? 0.01) * SR), n = c.length;
      for (let i = 0; i < fi && i < n; i++) c[i] *= i / fi;
      for (let i = 0; i < fo && i < n; i++) c[n - 1 - i] *= i / fo;
    });
    case 'dc': return perCh(chs, dcBlock);
    default: throw new Error(`fx type "${f.type}" unknown. Types: ${FX_TYPES.join(', ')}`);
  }
}
export { onePoleLP };
