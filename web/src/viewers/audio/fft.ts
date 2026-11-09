// Spectrum maths for the audio viewer: radix-2 FFT magnitude, the average spectrum of a clip, and the
// log-frequency bar mapping both the live and the average spectrum are drawn with. Pure, unit-tested.

/** Magnitude of the FFT of a real window (length = power of two), normalised by n; n / 2 bins. */
export function fftMag(input: Float32Array): Float32Array {
  const n = input.length, re = Float32Array.from(input), im = new Float32Array(n);
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { const t = re[i]; re[i] = re[j]; re[j] = t; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len, half = len / 2;
    for (let k = 0; k < half; k++) {
      const wr = Math.cos(ang * k), wi = Math.sin(ang * k);
      for (let i = 0; i < n; i += len) {
        const a = i + k, b = a + half;
        const tr = re[b] * wr - im[b] * wi, ti = re[b] * wi + im[b] * wr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
      }
    }
  }
  const out = new Float32Array(n / 2);
  for (let i = 0; i < n / 2; i++) out[i] = Math.hypot(re[i], im[i]) / n;
  return out;
}

/** Hann window of length n (cached per n). */
const hannCache = new Map<number, Float32Array>();
export function hann(n: number): Float32Array {
  let w = hannCache.get(n);
  if (!w) {
    w = new Float32Array(n);
    for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
    hannCache.set(n, w);
  }
  return w;
}

/**
 * Average magnitude spectrum: up to maxWindows Hann windows of n samples spread over the clip.
 * A clip shorter than one window gets one zero-padded window instead of none (short SFX).
 */
export function averageSpectrum(samples: Float32Array, n = 4096, maxWindows = 24): Float32Array {
  const out = new Float32Array(n / 2);
  const count = Math.min(maxWindows, Math.max(1, Math.floor(samples.length / n)));
  const step = Math.max(n, Math.floor(samples.length / count));
  const win = hann(n), w = new Float32Array(n);
  let used = 0;
  for (let s = 0; (s + n <= samples.length || s === 0) && used < count; s += step, used++) {
    for (let i = 0; i < n; i++) w[i] = (samples[s + i] || 0) * win[i];
    const m = fftMag(w);
    for (let i = 0; i < m.length; i++) out[i] += m[i];
  }
  for (let i = 0; i < out.length; i++) out[i] /= Math.max(1, used);
  return out;
}

export const FMIN = 20;

/** Lower edge (Hz) of bar i of nBars on a log axis FMIN..Nyquist; barFreq(nBars) is Nyquist. */
export function barFreq(i: number, nBars: number, sampleRate: number, fmin = FMIN): number {
  const fmax = sampleRate / 2;
  return fmin * Math.pow(fmax / fmin, i / nBars);
}

/** x of frequency f on the same log axis, 0..width. */
export function freqX(f: number, sampleRate: number, width: number, fmin = FMIN): number {
  return (Math.log(f / fmin) / Math.log(sampleRate / 2 / fmin)) * width;
}

/**
 * Log-frequency bars from linear magnitudes (bins cover 0..Nyquist): per bar the max magnitude of its
 * bins, in dB mapped -100..-10 dB to a level 0..1. `out` is reused when given (per-frame drawing).
 */
export function bars(mags: ArrayLike<number>, sampleRate: number, nBars: number, out?: Float32Array): Float32Array {
  const levels = out && out.length === nBars ? out : new Float32Array(nBars);
  const fmax = sampleRate / 2, bins = mags.length;
  for (let i = 0; i < nBars; i++) {
    const f0 = barFreq(i, nBars, sampleRate), f1 = barFreq(i + 1, nBars, sampleRate);
    const b0 = Math.floor((f0 / fmax) * bins), b1 = Math.max(b0 + 1, Math.floor((f1 / fmax) * bins));
    let m = 0;
    for (let b = b0; b < Math.min(bins, b1); b++) if (mags[b] > m) m = mags[b];
    const db = 20 * Math.log10(m + 1e-9);
    levels[i] = Math.max(0, Math.min(1, (db + 100) / 90));
  }
  return levels;
}
