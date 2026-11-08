// Audio DSP core: deterministic, seeded, 44.1 kHz Float32 buffers. Everything here is plain
// array processing (no Web Audio), so renders are reproducible from a seed and a patch.
import { mulberry32 } from '../util.js';

export const SR = 44100;
export const TAU = Math.PI * 2;
export const db2a = (db) => Math.pow(10, db / 20);
export const a2db = (a) => (a > 1e-12 ? 20 * Math.log10(a) : -240);
export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/** Seeded RNG with helpers. Any number (or string) works as a seed. */
export function makeRng(seed = 1) {
  let s = typeof seed === 'string' ? hashStr(seed) : Math.floor(Number(seed) || 0);
  const r = mulberry32((s ^ 0x5bd1e995) >>> 0);
  r(); r();
  const rng = {
    next: r,
    range: (a, b) => a + (b - a) * r(),
    int: (a, b) => a + Math.floor((b - a + 1) * r()),
    pick: (arr) => arr[Math.floor(r() * arr.length)],
    chance: (p) => r() < p,
    bi: () => r() * 2 - 1,
    gauss: () => { let u = 0; for (let i = 0; i < 4; i++) u += r(); return (u - 2) * 1.73; },
    fork: (k) => makeRng(((s * 2654435761) ^ hashStr(String(k))) >>> 0),
  };
  return rng;
}
export function hashStr(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

// ---------- tables ----------
const TBL = 4096;
const SIN = new Float32Array(TBL + 1);
for (let i = 0; i <= TBL; i++) SIN[i] = Math.sin((TAU * i) / TBL);
/** sin(2*pi*p) for p in [0,1). */
export function sin01(p) {
  const x = p * TBL, i = x | 0;
  return SIN[i] + (SIN[i + 1] - SIN[i]) * (x - i);
}

function polyblep(t, dt) {
  if (t < dt) { t /= dt; return t + t - t * t - 1; }
  if (t > 1 - dt) { t = (t - 1) / dt; return t * t + t + t + 1; }
  return 0;
}

const WAVES = { sine: 0, saw: 1, square: 2, pulse: 2, tri: 3, triangle: 3 };

/**
 * Band-limited oscillator (PolyBLEP saw/square/pulse, table sine, naive triangle).
 * freq: Hz number or per-sample Float32Array; mul scales it. Adds into out.
 */
export function osc(n, freq, { wave = 'sine', pw = 0.5, phase = 0, gain = 1, mul = 1, out = new Float32Array(n), pwm = null } = {}) {
  const w = WAVES[wave];
  if (w === undefined) throw new Error(`wave must be one of ${Object.keys(WAVES).join('|')}`);
  const fa = typeof freq === 'number' ? null : freq;
  let ph = phase - Math.floor(phase);
  const k = mul / SR, T = TBL;
  // one specialised loop per wave (no per-sample switch)
  if (w === 0) {
    for (let i = 0; i < n; i++) {
      const x = ph * T, j = x | 0;
      out[i] += (SIN[j] + (SIN[j + 1] - SIN[j]) * (x - j)) * gain;
      ph += (fa ? fa[i] : freq) * k; if (ph >= 1) ph -= 1; else if (ph < 0) ph += 1;
    }
  } else if (w === 1) {
    for (let i = 0; i < n; i++) {
      const dt = Math.min(0.49, Math.abs((fa ? fa[i] : freq) * k));
      let v = 2 * ph - 1;
      if (ph < dt) { const t = ph / dt; v -= t + t - t * t - 1; } else if (ph > 1 - dt) { const t = (ph - 1) / dt; v -= t * t + t + t + 1; }
      out[i] += v * gain;
      ph += dt; if (ph >= 1) ph -= 1;
    }
  } else if (w === 2) {
    for (let i = 0; i < n; i++) {
      const dt = Math.min(0.49, Math.abs((fa ? fa[i] : freq) * k));
      const p = pwm ? clamp(pw + pwm[i], 0.05, 0.95) : pw;
      let v = (ph < p ? 1 : -1) + polyblep(ph, dt);
      let t2 = ph + 1 - p; if (t2 >= 1) t2 -= 1;
      v -= polyblep(t2, dt) + 2 * p - 1;
      out[i] += v * gain;
      ph += dt; if (ph >= 1) ph -= 1;
    }
  } else {
    for (let i = 0; i < n; i++) {
      out[i] += (4 * Math.abs(ph - 0.5) - 1) * gain;
      ph += Math.abs((fa ? fa[i] : freq) * k); if (ph >= 1) ph -= 1;
    }
  }
  return out;
}

/** Noise: white, pink (Kellet), brown (leaky integrator). Adds into out. */
export function noise(n, color, rng, { gain = 1, out = new Float32Array(n) } = {}) {
  const r = rng.next;
  if (color === 'pink') {
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (let i = 0; i < n; i++) {
      const w = r() * 2 - 1;
      b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759; b2 = 0.969 * b2 + w * 0.153852;
      b3 = 0.8665 * b3 + w * 0.3104856; b4 = 0.55 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.016898;
      out[i] += (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11 * gain;
      b6 = w * 0.115926;
    }
  } else if (color === 'brown') {
    let b = 0;
    for (let i = 0; i < n; i++) { b = (b + 0.02 * (r() * 2 - 1)) / 1.02; out[i] += b * 3.5 * gain; }
  } else for (let i = 0; i < n; i++) out[i] += (r() * 2 - 1) * gain;
  return out;
}

// ---------- envelopes ----------
/** ADSR: linear attack to 1 in a s; d/r = time to reach the target (exponential, exact 0 at the end). */
export function adsr(n, gateN, { a = 0.005, d = 0.1, s = 1, r = 0.1, h = 0 } = {}) {
  const env = new Float32Array(n);
  const aN = Math.max(1, Math.round(a * SR)), hN = Math.round(h * SR), dN = Math.max(1, d * SR), rN = Math.max(1, Math.round(r * SR));
  let level = 0;
  for (let i = 0; i < Math.min(n, gateN); i++) {
    if (i < aN) level = i / aN;
    else if (i < aN + hN) level = 1;
    else { const t = (i - aN - hN) / dN; level = s + (1 - s) * Math.exp(-4.6 * t); }
    env[i] = level;
  }
  if (gateN < n) {
    const l0 = gateN > 0 ? env[Math.min(n, gateN) - 1] : 0;
    for (let i = gateN; i < n; i++) {
      const x = (i - gateN) / rN;
      env[i] = x >= 1 ? 0 : l0 * (Math.exp(-4.6 * x) - 0.01 * x);
    }
  }
  return env;
}

/** Multi-segment envelope: points [[t, level, curve?], ...]; curve >1 = slow start, <1 = fast start. */
export function segEnv(n, points) {
  const env = new Float32Array(n);
  const pts = [...points].sort((x, y) => x[0] - y[0]);
  let k = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    while (k < pts.length - 1 && t >= pts[k + 1][0]) k++;
    if (t <= pts[0][0]) { env[i] = pts[0][1]; continue; }
    if (k >= pts.length - 1) { env[i] = pts[pts.length - 1][1]; continue; }
    const [t0, l0] = pts[k], [t1, l1, c = 1] = pts[k + 1];
    const x = (t - t0) / Math.max(1e-9, t1 - t0);
    env[i] = l0 + (l1 - l0) * Math.pow(x, c);
  }
  return env;
}

/** Exponential decay envelope reaching -40 dB at `time` s. */
export function decayEnv(n, time, attack = 0.0005) {
  const env = new Float32Array(n), k = -4.6 / Math.max(1e-4, time * SR), aN = Math.max(1, attack * SR);
  for (let i = 0; i < n; i++) env[i] = Math.exp(k * i) * Math.min(1, i / aN);
  return env;
}

/** LFO: sine|tri|square|saw|random (smoothed sample&hold). Values in [-depth, depth]. */
export function lfo(n, rate, { depth = 1, shape = 'sine', phase = 0, rng = null, delay = 0 } = {}) {
  const out = new Float32Array(n);
  let ph = phase, prev = 0, next = rng ? rng.bi() : 0;
  const dN = delay * SR;
  for (let i = 0; i < n; i++) {
    let v;
    if (shape === 'tri') v = 4 * Math.abs(ph - 0.5) - 1;
    else if (shape === 'square') v = ph < 0.5 ? 1 : -1;
    else if (shape === 'saw') v = 2 * ph - 1;
    else if (shape === 'random') { const t = ph * ph * (3 - 2 * ph); v = prev + (next - prev) * t; }
    else v = sin01(ph);
    const fade = dN > 0 ? Math.min(1, i / dN) : 1;
    out[i] = v * depth * fade;
    ph += rate / SR;
    if (ph >= 1) { ph -= 1; prev = next; next = rng ? rng.bi() : 0; }
  }
  return out;
}

// ---------- biquad (RBJ cookbook) ----------
export function biquadCoefs(type, f, q = 0.7071, gainDb = 0) {
  f = clamp(f, 5, SR * 0.49);
  q = Math.max(0.05, q);
  const w = (TAU * f) / SR, cw = Math.cos(w), sw = Math.sin(w), al = sw / (2 * q), A = Math.pow(10, gainDb / 40);
  let b0, b1, b2, a0, a1, a2;
  switch (type) {
    case 'lp': b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = b0; a0 = 1 + al; a1 = -2 * cw; a2 = 1 - al; break;
    case 'hp': b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = b0; a0 = 1 + al; a1 = -2 * cw; a2 = 1 - al; break;
    case 'bp': b0 = al; b1 = 0; b2 = -al; a0 = 1 + al; a1 = -2 * cw; a2 = 1 - al; break;
    case 'notch': b0 = 1; b1 = -2 * cw; b2 = 1; a0 = 1 + al; a1 = -2 * cw; a2 = 1 - al; break;
    case 'allpass': b0 = 1 - al; b1 = -2 * cw; b2 = 1 + al; a0 = 1 + al; a1 = -2 * cw; a2 = 1 - al; break;
    case 'peak': b0 = 1 + al * A; b1 = -2 * cw; b2 = 1 - al * A; a0 = 1 + al / A; a1 = -2 * cw; a2 = 1 - al / A; break;
    case 'lowshelf': case 'highshelf': {
      const sq = 2 * Math.sqrt(A) * al, s = type === 'lowshelf' ? 1 : -1;
      b0 = A * ((A + 1) - s * (A - 1) * cw + sq); b1 = 2 * s * A * ((A - 1) - s * (A + 1) * cw); b2 = A * ((A + 1) - s * (A - 1) * cw - sq);
      a0 = (A + 1) + s * (A - 1) * cw + sq; a1 = -2 * s * ((A - 1) + s * (A + 1) * cw); a2 = (A + 1) + s * (A - 1) * cw - sq;
      break;
    }
    default: throw new Error(`filter type must be lp|hp|bp|notch|peak|lowshelf|highshelf|allpass (got ${type})`);
  }
  return [b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0];
}

/** |H(f)| of a coefficient set (for tests and EQ curves). */
export function biquadMag(c, f) {
  const w = (TAU * f) / SR;
  const re = (k0, k1, k2) => k0 + k1 * Math.cos(-w) + k2 * Math.cos(-2 * w), im = (k0, k1, k2) => k1 * Math.sin(-w) + k2 * Math.sin(-2 * w);
  const nr = re(c[0], c[1], c[2]), ni = im(c[0], c[1], c[2]), dr = re(1, c[3], c[4]), di = im(1, c[3], c[4]);
  return Math.hypot(nr, ni) / Math.hypot(dr, di);
}

export class Biquad {
  constructor(type, f, q, g) { this.z1 = 0; this.z2 = 0; this.set(type, f, q, g); }
  set(type, f, q = 0.7071, g = 0) { this.c = biquadCoefs(type, f, q, g); return this; }
  run(buf, start = 0, end = buf.length) {
    // one loop per array type: a single polymorphic loop runs ~7x slower in V8
    (buf instanceof Float32Array ? bqF32 : bqAny)(this, buf, start, end);
    return buf;
  }
}
function bqF32(st, buf, start, end) {
  const c = st.c, b0 = c[0], b1 = c[1], b2 = c[2], a1 = c[3], a2 = c[4];
  let z1 = st.z1, z2 = st.z2;
  for (let i = start; i < end; i++) {
    const x = buf[i], y = b0 * x + z1;
    z1 = b1 * x - a1 * y + z2;
    z2 = b2 * x - a2 * y;
    buf[i] = y;
  }
  st.z1 = Math.abs(z1) < 1e-25 ? 0 : z1; st.z2 = Math.abs(z2) < 1e-25 ? 0 : z2;
}
function bqAny(st, buf, start, end) {
  const c = st.c, b0 = c[0], b1 = c[1], b2 = c[2], a1 = c[3], a2 = c[4];
  let z1 = st.z1, z2 = st.z2;
  for (let i = start; i < end; i++) {
    const x = buf[i], y = b0 * x + z1;
    z1 = b1 * x - a1 * y + z2;
    z2 = b2 * x - a2 * y;
    buf[i] = y;
  }
  st.z1 = Math.abs(z1) < 1e-25 ? 0 : z1; st.z2 = Math.abs(z2) < 1e-25 ? 0 : z2;
}

/** Filter in place. type/f/q/gain fixed, or fFn(i) -> Hz evaluated every 32 samples (sweeps, LFOs). */
export function filter(buf, type, f, q = 0.7071, gain = 0, { poles = 2 } = {}) {
  const stages = Math.max(1, Math.round(poles / 2));
  for (let s = 0; s < stages; s++) {
    if (typeof f === 'function') {
      const bq = new Biquad(type, f(0), q, gain);
      for (let i = 0; i < buf.length; i += 32) { bq.set(type, f(i), q, gain); bq.run(buf, i, Math.min(buf.length, i + 32)); }
    } else new Biquad(type, f, q, gain).run(buf);
  }
  return buf;
}

/** Several fixed biquads in series (separate tight passes measured faster in V8 than one fused loop). */
export function cascade(buf, coefs) {
  for (const k of coefs) { const bq = new Biquad('lp', 1000); bq.c = k; bq.run(buf); }
  return buf;
}
export function onePoleLP(buf, f) {
  const a = 1 - Math.exp((-TAU * f) / SR);
  let y = 0;
  for (let i = 0; i < buf.length; i++) { y += a * (buf[i] - y); buf[i] = y; }
  return buf;
}

export function dcBlock(buf) {
  let x1 = 0, y1 = 0;
  for (let i = 0; i < buf.length; i++) { const x = buf[i]; const y = x - x1 + 0.9995 * y1; x1 = x; y1 = y; buf[i] = y; }
  return buf;
}

// ---------- waveshaping ----------
const SHAPES = {
  tanh: (x) => Math.tanh(x),
  soft: (x) => x / (1 + Math.abs(x)),
  hard: (x) => (x > 1 ? 1 : x < -1 ? -1 : x),
  fold: (x) => { let y = x; for (let k = 0; k < 6 && (y > 1 || y < -1); k++) y = y > 1 ? 2 - y : -2 - y; return y; },
  tube: (x) => (x >= 0 ? Math.tanh(x) : Math.tanh(x * 0.75) / 0.75 * 0.9),
  fuzz: (x) => Math.sign(x) * (1 - Math.exp(-Math.abs(x) * 1.5)),
};
export const SHAPE_NAMES = Object.keys(SHAPES);

/** Waveshaping distortion; drive in dB; 2x oversampled when os. Keeps level roughly constant. */
export function shape(buf, { drive = 12, type = 'tanh', bias = 0, mix = 1, os = true } = {}) {
  const fn = SHAPES[type];
  if (!fn) throw new Error(`drive type must be ${SHAPE_NAMES.join('|')}`);
  const g = db2a(drive), comp = 1 / Math.max(1, Math.tanh(g) * Math.sqrt(g) * 0.7);
  const off = fn(bias);
  const n = buf.length;
  if (!os) {
    for (let i = 0; i < n; i++) buf[i] = buf[i] * (1 - mix) + (fn(buf[i] * g + bias) - off) * comp * mix;
    return dcBlock(buf);
  }
  const up = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) { const a = buf[i], b = i + 1 < n ? buf[i + 1] : a; up[2 * i] = a; up[2 * i + 1] = (a + b) / 2; }
  for (let i = 0; i < up.length; i++) up[i] = fn(up[i] * g + bias) - off;
  // anti-alias lowpass at the 88.2 kHz rate (cutoff ~19 kHz), then decimate
  const c = biquadCoefsAt('lp', 19000, 0.7071, 2 * SR);
  for (let s = 0; s < 2; s++) runCoefs(up, c);
  for (let i = 0; i < n; i++) buf[i] = buf[i] * (1 - mix) + up[2 * i] * comp * mix;
  return dcBlock(buf);
}
function biquadCoefsAt(type, f, q, sr) {
  const w = (TAU * f) / sr, cw = Math.cos(w), al = Math.sin(w) / (2 * q), a0 = 1 + al;
  return [(1 - cw) / 2 / a0, (1 - cw) / a0, (1 - cw) / 2 / a0, (-2 * cw) / a0, (1 - al) / a0];
}
function runCoefs(buf, [b0, b1, b2, a1, a2]) {
  let z1 = 0, z2 = 0;
  for (let i = 0; i < buf.length; i++) { const x = buf[i], y = b0 * x + z1; z1 = b1 * x - a1 * y + z2; z2 = b2 * x - a2 * y; buf[i] = y; }
}

// ---------- FFT ----------
/** In-place iterative radix-2 complex FFT (length power of two). */
const TW = new Map();
function twiddles(n) {
  let t = TW.get(n);
  if (!t) { t = { c: new Float64Array(n / 2), s: new Float64Array(n / 2) }; for (let k = 0; k < n / 2; k++) { t.c[k] = Math.cos((-TAU * k) / n); t.s[k] = Math.sin((-TAU * k) / n); } TW.set(n, t); }
  return t;
}
export function fft(re, im) {
  const n = re.length, { c: tc, s: ts } = twiddles(n);
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { const r = re[i]; re[i] = re[j]; re[j] = r; const m = im[i]; im[i] = im[j]; im[j] = m; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1, step = n / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < half; k++) {
        const a = i + k, b = a + half, cr = tc[k * step], ci = ts[k * step];
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
      }
    }
  }
}
const HANN = new Map();
export function hann(n) {
  if (!HANN.has(n)) { const w = new Float32Array(n); for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((TAU * i) / n); HANN.set(n, w); }
  return HANN.get(n);
}
/** Magnitude spectrum (n/2 bins) of a windowed frame starting at `start`. */
export function magSpectrum(x, start, n) {
  const re = new Float64Array(n), im = new Float64Array(n), w = hann(n);
  for (let i = 0; i < n; i++) { const k = start + i; re[i] = k >= 0 && k < x.length ? x[k] * w[i] : 0; }
  fft(re, im);
  const m = new Float32Array(n / 2);
  const g = 2 / (n * 0.5);
  for (let i = 0; i < n / 2; i++) m[i] = Math.sqrt(re[i] * re[i] + im[i] * im[i]) * g;
  return m;
}

/** Fast convolution (overlap-add FFT) of x with ir; returns length x.length + ir.length - 1. */
export function convolve(x, ir) {
  const N = x.length, M = ir.length;
  const block = 1 << Math.ceil(Math.log2(Math.max(256, Math.min(M, 1 << 15))));
  const parts = Math.ceil(M / block);
  const fftN = block * 2;
  // partition the IR into `parts` blocks (uniformly partitioned convolution)
  const H = [];
  for (let p = 0; p < parts; p++) {
    const re = new Float64Array(fftN), im = new Float64Array(fftN);
    for (let i = 0; i < block && p * block + i < M; i++) re[i] = ir[p * block + i];
    fft(re, im);
    H.push([re, im]);
  }
  const out = new Float32Array(N + M - 1);
  const nBlocks = Math.ceil(N / block);
  const X = [];
  for (let b = 0; b < nBlocks; b++) {
    const re = new Float64Array(fftN), im = new Float64Array(fftN);
    let any = false;
    for (let i = 0; i < block && b * block + i < N; i++) { re[i] = x[b * block + i]; if (re[i]) any = true; }
    if (any) fft(re, im);
    X.push(any ? [re, im] : null);
  }
  const accR = new Float64Array(fftN), accI = new Float64Array(fftN);
  for (let ob = 0; ob < nBlocks + parts; ob++) {
    accR.fill(0); accI.fill(0);
    let any = false;
    for (let p = 0; p < parts; p++) {
      const b = ob - p;
      if (b < 0 || b >= nBlocks || !X[b]) continue;
      any = true;
      const [xr, xi] = X[b], [hr, hi] = H[p];
      for (let k = 0; k < fftN; k++) { accR[k] += xr[k] * hr[k] - xi[k] * hi[k]; accI[k] += xr[k] * hi[k] + xi[k] * hr[k]; }
    }
    if (!any) continue;
    // inverse FFT via conjugation
    for (let k = 0; k < fftN; k++) accI[k] = -accI[k];
    fft(accR, accI);
    const base = ob * block;
    for (let i = 0; i < fftN && base + i < out.length; i++) out[base + i] += accR[i] / fftN;
  }
  return out;
}

// ---------- synthesis primitives ----------
/** Harmonic wavetable from [[harmonic, amp]] (harmonic integers), band-limited to maxHarm. */
const TABLES = new Map();
export function wavetable(partials, maxHarm, size = 2048) {
  const key = JSON.stringify(partials) + '|' + maxHarm;
  if (TABLES.has(key)) return TABLES.get(key);
  const t = new Float32Array(size + 1);
  for (const [h, a, ph = 0] of partials) {
    if (h > maxHarm || h <= 0) continue;
    for (let i = 0; i <= size; i++) t[i] += a * Math.sin((TAU * h * i) / size + ph);
  }
  if (TABLES.size > 500) TABLES.clear();
  TABLES.set(key, t);
  return t;
}
export function playTable(n, table, freq, { gain = 1, phase = 0, mul = 1, out = new Float32Array(n) } = {}) {
  const size = table.length - 1, fa = typeof freq === 'number' ? null : freq;
  let ph = phase * size;
  for (let i = 0; i < n; i++) {
    const k = ph | 0, fr = ph - k;
    out[i] += (table[k] + (table[k + 1] - table[k]) * fr) * gain;
    ph += ((fa ? fa[i] : freq) * mul * size) / SR;
    while (ph >= size) ph -= size;
  }
  return out;
}

/** Modal synthesis: damped resonators [[ratio, amp, t60]] excited at t=0 (bells, metal, wood). */
export function modal(n, f0, modes, { gain = 1, out = new Float32Array(n), rng = null, strike = 0 } = {}) {
  for (const [ratio, amp, t60 = 1] of modes) {
    const f = f0 * ratio;
    if (f >= SR * 0.45 || amp === 0) continue;
    const w = (TAU * f) / SR, r = Math.exp(-6.9 / (Math.max(0.005, t60) * SR));
    const cr = r * Math.cos(w), ci = r * Math.sin(w);
    const ph = rng ? rng.next() * TAU : 0;
    let x = Math.cos(ph) * amp * gain, y = Math.sin(ph) * amp * gain;
    const m = Math.min(n, Math.ceil(Math.max(0.005, t60) * SR * 1.2));
    for (let i = 0; i < m; i++) { out[i] += y; const nx = x * cr - y * ci; y = x * ci + y * cr; x = nx; }
  }
  if (strike > 0 && rng) { const sN = Math.min(n, Math.round(0.004 * SR)); for (let i = 0; i < sN; i++) out[i] += rng.bi() * strike * gain * (1 - i / sN); }
  return out;
}

/** Karplus-Strong plucked string. decay = T60 seconds; brightness 0..1. */
export function pluck(n, freq, rng, { decay = 2, brightness = 0.7, gain = 1, out = new Float32Array(n), pick = 0.13 } = {}) {
  const L = Math.max(2, Math.round(SR / freq - 0.5));
  const buf = new Float32Array(L);
  let y = 0;
  const b = clamp(brightness, 0.02, 1);
  for (let i = 0; i < L; i++) { y += b * (rng.bi() - y); buf[i] = y; }
  // pick position comb: removes harmonics that have a node at the pick point
  const pk = Math.max(1, Math.round(L * pick));
  const ex = Float32Array.from(buf);
  for (let i = 0; i < L; i++) buf[i] = ex[i] - 0.6 * ex[(i + pk) % L];
  let mean = 0; for (let i = 0; i < L; i++) mean += buf[i]; mean /= L;
  for (let i = 0; i < L; i++) buf[i] -= mean;
  const g = Math.pow(10, -3 / (decay * freq));
  const S = 0.5 - 0.35 * b * 0.5; // more brightness = less loop lowpass
  let p = 0;
  for (let i = 0; i < n; i++) {
    const a = buf[p], c = buf[(p + 1) % L];
    out[i] += a * gain;
    buf[p] = g * ((1 - S) * a + S * c);
    p = (p + 1) % L;
  }
  return out;
}

/**
 * Bowed string (digital waveguide with a friction bow): two delay lines meeting at the bow,
 * a bridge lowpass reflection and a stick-slip friction curve. Sustained, with natural bow noise.
 */
export function bowed(n, freq, rng, { pressure = 0.25, position = 0.13, gain = 1, out = new Float32Array(n), envBow = null, vibrato = null } = {}) {
  const total = SR / freq;
  const nutLen = Math.max(2, Math.round(total * (1 - position) / 2)), brLen = Math.max(2, Math.round(total * position / 2));
  const nut = new Float32Array(nutLen), br = new Float32Array(brLen);
  let pn = 0, pb = 0, lp = 0;
  const slope = 5 - pressure * 4;
  for (let i = 0; i < n; i++) {
    const bowV = (envBow ? envBow[i] : 1) * 0.12 + rng.bi() * 0.003;
    const nutOut = -nut[pn], brOut = br[pb];
    lp = lp + 0.55 * (brOut - lp);
    const bridgeRefl = -lp * 0.995;
    const vStr = nutOut + bridgeRefl;
    const dv = bowV - vStr;
    const xb = Math.abs(dv) * slope + 0.75, x2 = xb * xb;
    const fr = Math.min(1, 1 / (x2 * x2));
    const add = dv * fr;
    nut[pn] = bridgeRefl + add;
    br[pb] = nutOut + add;
    out[i] += brOut * gain * 2;
    pn = (pn + 1) % nutLen; pb = (pb + 1) % brLen;
  }
  return out;
}

// ---------- stereo helpers ----------
/** Equal-power pan of a mono buffer -> [L, R]. pan -1..1. */
export function panMono(m, pan = 0, gain = 1) {
  const th = ((clamp(pan, -1, 1) + 1) * Math.PI) / 4, gl = Math.cos(th) * Math.SQRT2 * gain, gr = Math.sin(th) * Math.SQRT2 * gain;
  const L = new Float32Array(m.length), R = new Float32Array(m.length);
  for (let i = 0; i < m.length; i++) { L[i] = m[i] * gl; R[i] = m[i] * gr; }
  return [L, R];
}
export function width([L, R], w) {
  for (let i = 0; i < L.length; i++) { const m = (L[i] + R[i]) / 2, s = ((L[i] - R[i]) / 2) * w; L[i] = m + s; R[i] = m - s; }
}
export function addInto(dst, src, offset = 0, gain = 1) {
  const end = Math.min(dst.length, offset + src.length);
  for (let i = Math.max(0, offset); i < end; i++) dst[i] += src[i - offset] * gain;
}
export function peakOf(...chs) { let p = 0; for (const c of chs) for (let i = 0; i < c.length; i++) { const v = Math.abs(c[i]); if (v > p) p = v; } return p; }
export function scale(chs, g) { for (const c of chs) for (let i = 0; i < c.length; i++) c[i] *= g; }
