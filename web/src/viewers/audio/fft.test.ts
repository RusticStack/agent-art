import { describe, expect, it } from 'vitest';
import { averageSpectrum, barFreq, bars, fftMag, freqX } from './fft';

const sine = (n: number, cyclesOrHz: number, sampleRate?: number): Float32Array => {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.sin((2 * Math.PI * cyclesOrHz * i) / (sampleRate ?? n));
  return out;
};
const argmax = (a: ArrayLike<number>): number => { let k = 0; for (let i = 1; i < a.length; i++) if (a[i] > a[k]) k = i; return k; };

describe('fft', () => {
  it('fftMag of a pure sine peaks at its bin with amplitude 1/2', () => {
    const m = fftMag(sine(1024, 37));
    expect(m.length).toBe(512);
    expect(argmax(m)).toBe(37);
    expect(m[37]).toBeCloseTo(0.5, 3);
    expect(m[10]).toBeLessThan(1e-4);
  });

  it('averageSpectrum of a clip shorter than one window uses one zero-padded window', () => {
    const sr = 44100, clip = sine(1000, 1000, sr);   // 1000 samples < 4096
    const a = averageSpectrum(clip);
    expect(a.length).toBe(2048);
    expect(a.every(Number.isFinite)).toBe(true);
    const peakHz = (argmax(a) * sr) / 4096;
    expect(Math.abs(peakHz - 1000)).toBeLessThan(25);
    expect(averageSpectrum(new Float32Array(0)).every((v) => v === 0)).toBe(true);
  });

  it('averageSpectrum of a long clip averages windows (a steady sine keeps its level)', () => {
    const sr = 44100, one = averageSpectrum(sine(4096, 440, sr)), long = averageSpectrum(sine(4096 * 40, 440, sr));
    const k = argmax(one);
    expect(argmax(long)).toBe(k);
    expect(long[k]).toBeCloseTo(one[k], 1);
  });

  it('bar mapping is monotonic in frequency', () => {
    const sr = 44100, n = 160;
    for (let i = 0; i < n; i++) expect(barFreq(i + 1, n, sr)).toBeGreaterThan(barFreq(i, n, sr));
    expect(barFreq(0, n, sr)).toBe(20);
    expect(barFreq(n, n, sr)).toBeCloseTo(sr / 2, 6);
    let last = -1;
    for (const hz of [60, 200, 800, 3000, 9000, 16000]) {
      const lv = bars(averageSpectrum(sine(8192, hz, sr)), sr, n);
      const b = argmax(lv);
      expect(b).toBeGreaterThan(last);
      expect(barFreq(b, n, sr)).toBeLessThanOrEqual(hz * 1.1);
      expect(barFreq(b + 1, n, sr)).toBeGreaterThanOrEqual(hz * 0.9);
      last = b;
    }
  });

  it('bars: levels in 0..1, silence is 0, output array reused', () => {
    const out = new Float32Array(32);
    const lv = bars(new Float32Array(2048), 44100, 32, out);
    expect(lv).toBe(out);
    expect([...lv].every((v) => v === 0)).toBe(true);
    const loud = bars(new Float32Array(2048).fill(1), 44100, 32);
    expect([...loud].every((v) => v > 0.99 && v <= 1)).toBe(true);
  });

  it('freqX places labels on the log axis', () => {
    expect(freqX(20, 44100, 1000)).toBeCloseTo(0, 6);
    expect(freqX(22050, 44100, 1000)).toBeCloseTo(1000, 6);
    expect(freqX(1000, 44100, 1000)).toBeGreaterThan(freqX(100, 44100, 1000));
  });
});
