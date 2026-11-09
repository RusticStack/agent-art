// @vitest-environment jsdom
// Pure shading helpers (plan 5.7b): sun, tiers, degrade order, GLB need matrix, settings persistence, frame meter.
import { beforeEach, describe, expect, it } from 'vitest';
import {
  BAKED, DEFAULT_SETTINGS, FrameCostWatch, FrameMeter, MODES, TIERS, loadSettings, needFor, nextDegradeStep, parseSettings, probeCoeffs, probePositions,
  saveSettings, shadingNote, sunDirection, sunVector, tierBelow, tierFor, type DegradeState, type DegradeStep, type ShadingInfo,
} from './shading';
import { CHANNEL_IDS } from './channels';
import { sole } from './three';

beforeEach(() => localStorage.clear());

describe('sunDirection', () => {
  it('rises in the east at 6, peaks at noon, sets in the west at 18; never below 5°', () => {
    const a = sunDirection(6, 0), b = sunDirection(12, 0), c = sunDirection(18, 0);
    expect(a.elevation).toBeCloseTo(5); expect(a.azimuth).toBeCloseTo(90);
    expect(b.elevation).toBeCloseTo(75); expect(b.azimuth).toBeCloseTo(0);
    expect(c.elevation).toBeCloseTo(5); expect(c.azimuth).toBeCloseTo(270);
    for (let t = 6; t <= 18; t += 0.25) expect(sunDirection(t, 0).elevation).toBeGreaterThanOrEqual(5 - 1e-9);
    expect(sunDirection(2, 0).elevation).toBeCloseTo(5);   // clamped to 6:00
  });
  it('rotation adds to the azimuth and wraps to [0, 360)', () => {
    expect(sunDirection(12, 35).azimuth).toBeCloseTo(35);
    expect(sunDirection(6, 300).azimuth).toBeCloseTo(30);
    expect(sunDirection(18, 360).azimuth).toBeCloseTo(270);
    for (const r of [0, 90, 359, 360, 720]) { const z = sunDirection(9, r).azimuth; expect(z).toBeGreaterThanOrEqual(0); expect(z).toBeLessThan(360); }
  });
  it('warm and dim near the horizon, white and bright at noon', () => {
    const low = sunDirection(6, 0), noon = sunDirection(12, 0);
    expect(low.color).toBe(0xffb070);
    expect(sunDirection(6.25, 0).color).not.toBe(0xffffff);   // 6:15 is still below 15°
    expect(noon.color).toBe(0xffffff);
    expect(low.intensity).toBeCloseTo(1.2); expect(noon.intensity).toBeCloseTo(3.0);
    const v = sunVector(noon.azimuth, noon.elevation);
    expect(Math.hypot(v.x, v.y, v.z)).toBeCloseTo(1);
    expect(v.y).toBeGreaterThan(0.9);
  });
});

describe('quality tiers', () => {
  it('tierFor: Low on integrated / mobile / software GPUs or a small max texture, else Medium', () => {
    for (const n of ['ANGLE (Intel, Intel(R) UHD Graphics 620)', 'Google SwiftShader', 'llvmpipe (LLVM 15.0.7, 256 bits)', 'Mali-G78', 'Adreno (TM) 650', 'PowerVR Rogue', 'Microsoft Basic Render Driver', 'Intel Iris Xe']) expect(tierFor(n, 16384)).toBe('low');
    expect(tierFor('ANGLE (NVIDIA GeForce RTX 3070)', 16384)).toBe('medium');
    expect(tierFor('AMD Radeon RX 6800', 4096)).toBe('low');
    expect(tierFor('', 32768)).toBe('medium');
  });
  it('tier table and slot B one tier below', () => {
    expect([TIERS.low.shadowMap, TIERS.medium.shadowMap, TIERS.high.shadowMap]).toEqual([1024, 2048, 4096]);
    expect([TIERS.low.gtaoSamples, TIERS.medium.gtaoSamples, TIERS.high.gtaoSamples]).toEqual([8, 16, 24]);
    expect([TIERS.low.msaa, TIERS.medium.msaa, TIERS.high.msaa]).toEqual([0, 2, 4]);
    expect([TIERS.low.aoWhileOrbit, TIERS.medium.aoWhileOrbit]).toEqual([false, true]);
    expect([tierBelow('high'), tierBelow('medium'), tierBelow('low')]).toEqual(['medium', 'low', 'low']);
  });
  it('nextDegradeStep: DPR → GTAO 8 → shadow map 1024 → AO off → shadows off, then nothing', () => {
    let s: DegradeState = { mode: 'rendered', dpr: 2, ao: true, gtaoSamples: 16, shadows: true, shadowMap: 2048, canFallback: false };
    const order: DegradeStep[] = [];
    for (let i = 0; i < 10; i++) {
      const st = nextDegradeStep(s);
      if (!st) break;
      order.push(st);
      if (st === 'dpr') s = { ...s, dpr: 1 };
      if (st === 'gtao-samples') s = { ...s, gtaoSamples: 8 };
      if (st === 'shadow-map') s = { ...s, shadowMap: 1024 };
      if (st === 'ao-off') s = { ...s, ao: false };
      if (st === 'shadows-off') s = { ...s, shadows: false };
    }
    expect(order).toEqual(['dpr', 'gtao-samples', 'shadow-map', 'ao-off', 'shadows-off']);
    expect(nextDegradeStep(s)).toBeNull();
  });
  it('nextDegradeStep: a default Material preview falls back to Solid › Studio; a chosen one does not', () => {
    const m: DegradeState = { mode: 'material', dpr: 1, ao: false, gtaoSamples: 8, shadows: false, shadowMap: 1024, canFallback: true };
    expect(nextDegradeStep({ ...m, dpr: 2 })).toBe('dpr');
    expect(nextDegradeStep(m)).toBe('solid-studio');
    expect(nextDegradeStep({ ...m, canFallback: false })).toBeNull();
    expect(nextDegradeStep({ ...m, mode: 'solid' })).toBeNull();
  });
});

describe('frame cost', () => {
  it('FrameMeter counts only consecutive rendered frames of a visible page, ≤ 250 ms', () => {
    const f = new FrameMeter();
    expect(f.sample(0, true, true)).toBeNull();          // first frame: no previous
    expect(f.sample(16, true, true)).toBe(16);
    expect(f.sample(32, false, true)).toBeNull();        // idle frame
    expect(f.sample(1000, true, true)).toBeNull();       // first after the idle gap
    expect(f.sample(1020, true, true)).toBe(20);
    expect(f.sample(1400, true, true)).toBeNull();       // > 250 ms
    expect(f.sample(1420, true, false)).toBeNull();      // hidden
    expect(f.sample(1440, true, true)).toBeNull();
    expect(f.sample(1460, true, true)).toBe(20);
  });
  it('FrameCostWatch fires once the rolling mean stayed above 34 ms for 1.5 s, then starts over', () => {
    const w = new FrameCostWatch();
    let fired = 0, n = 0;
    for (let i = 0; i < 200; i++) { n++; if (w.push(16)) fired++; }
    expect(fired).toBe(0);
    let at = -1;
    for (let i = 0; i < 200 && at < 0; i++) if (w.push(50)) at = i;
    expect(at).toBeGreaterThan(20);       // ~1.5 s of 50 ms frames plus the mean crossing 34 ms
    expect(at).toBeLessThan(60);
    expect(w.mean()).toBe(0);             // reset after firing
    expect(n).toBe(200);
  });
});

describe('needFor (mode × baked × channel)', () => {
  it('matrix', () => {
    for (const mode of MODES) for (const baked of BAKED) for (const ch of CHANNEL_IDS) {
      const got = needFor({ mode, baked }, ch);
      const shading = mode === 'rendered' && baked !== 'off' ? 2 : mode === 'material' || mode === 'rendered' ? 1 : 0;
      const chan = ['ao', 'lightmap', 'bent', 'uv1'].includes(ch) ? 2 : ch === 'lit' || ch === 'albedo' ? 0 : 1;
      expect(['', 'three', 'bake'][Math.max(shading, chan)], `${mode} ${baked} ${ch}`).toBe(got);
    }
  });
});

describe('settings persistence', () => {
  it('round trip through agent-art:modelView', () => {
    expect(loadSettings()).toEqual({ settings: DEFAULT_SETTINGS, explicitMode: false });
    expect(DEFAULT_SETTINGS.mode).toBe('material');
    const s = { ...DEFAULT_SETTINGS, mode: 'rendered' as const, bg: 'studio' as const, sun: 7.5, quality: 'low' as const, baked: 'ao+lightmap' as const };
    saveSettings(s);
    expect(JSON.parse(localStorage.getItem('agent-art:modelView')!)).toEqual(s);
    expect(loadSettings()).toEqual({ settings: s, explicitMode: true });
  });
  it('unknown / old values fall back field by field', () => {
    localStorage.setItem('agent-art:modelView', JSON.stringify({ mode: 'lit', texture: 'yes', solidLight: 'studio', sun: 99, rotate: -5, aoStrength: 'x', baked: 'lightmap', bg: 'env', quality: 'ultra', extra: 1 }));
    const { settings, explicitMode } = loadSettings();
    expect(explicitMode).toBe(false);
    expect(settings).toEqual({ ...DEFAULT_SETTINGS, solidLight: 'studio', sun: 18, rotate: 0, bg: 'env' });
    localStorage.setItem('agent-art:modelView', '{not json');
    expect(loadSettings().settings).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings([1, 2])).toEqual(DEFAULT_SETTINGS);
  });
});

describe('status note and probes', () => {
  const base: ShadingInfo = {
    mode: 'rendered', solidLight: 'matcap', tier: 'medium', auto: true, shadowMap: 2048, gtaoSamples: 16, composer: true, degraded: [], environment: true, toneMapping: 'Neutral',
    lights: 1, shadows: true, ao: true, dpr: 1, lightmaps: 0, withoutLightmap: 0, bakedAo: 0, probes: 0, channelView: false,
  };
  it('mode name, quality facts, degrade reasons, baked lighting', () => {
    expect(shadingNote(base)).toBe('Rendered · shadows 2048 · GTAO 16');
    expect(shadingNote({ ...base, shadows: false, ao: false, degraded: ['pixel ratio 1', 'AO off'] })).toBe('Rendered · degraded: pixel ratio 1, AO off');
    expect(shadingNote({ ...base, lightmaps: 2, withoutLightmap: 1, shadows: false, ao: false })).toBe('Rendered · baked lighting (1 mesh real-time)');
    expect(shadingNote({ ...base, mode: 'material' })).toBe('Material preview');
    expect(shadingNote({ ...base, mode: 'solid', solidLight: 'studio' })).toBe('Solid › Studio');
    expect(shadingNote({ ...base, mode: 'solid' })).toBe('Solid');
    expect(shadingNote({ ...base, mode: 'wire' })).toBe('Wireframe');
  });
  it('probe grid positions and SH9 slices', () => {
    const p = probePositions({ origin: [1, 0, -1], spacing: 2, dims: [2, 1, 2] });
    expect(p).toEqual([{ i: 0, x: 1, y: 0, z: -1 }, { i: 1, x: 3, y: 0, z: -1 }, { i: 2, x: 1, y: 0, z: 1 }, { i: 3, x: 3, y: 0, z: 1 }]);
    expect(probePositions({ origin: [0, 0, 0], spacing: [1, 2, 3], dims: [1, 2, 1] })[1]).toEqual({ i: 1, x: 0, y: 2, z: 0 });
    const flat = Array.from({ length: 54 }, (_, i) => i);
    expect(probeCoeffs(flat, 1)![0]).toBe(27);
    expect(probeCoeffs(flat, 2)).toBeNull();
    expect(probeCoeffs([flat.slice(0, 27)], 0)!.length).toBe(27);
    expect(probeCoeffs(undefined, 0)).toBeNull();
  });
});

describe('three loader', () => {
  it('sole() reads the only class export of a module without naming it', () => {
    class A {}
    expect(sole<typeof A>({ A })).toBe(A);
    expect(() => sole({ x: 1 })).toThrow('missing export');
  });
});
