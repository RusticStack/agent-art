// View preset maths (plan 5.7b, Review 2).
import { describe, expect, it } from 'vitest';
import { POLE, VIEW_PRESETS, frameDistance, fromSpherical, lerpSpherical, opposite, presetAngles, toSpherical, viewKey, wrapPi } from './views';

describe('views', () => {
  it('presetAngles for the six presets', () => {
    expect(presetAngles('front')).toEqual({ azimuth: 0, polar: Math.PI / 2 });
    expect(presetAngles('back')).toEqual({ azimuth: Math.PI, polar: Math.PI / 2 });
    expect(presetAngles('right')).toEqual({ azimuth: Math.PI / 2, polar: Math.PI / 2 });
    expect(presetAngles('left')).toEqual({ azimuth: -Math.PI / 2, polar: Math.PI / 2 });
    expect(presetAngles('top').polar).toBe(POLE);
    expect(presetAngles('bottom').polar).toBe(Math.PI - POLE);
    // front looks from +Z, right from +X, top from +Y
    const f = fromSpherical({ ...presetAngles('front'), radius: 1 }), r = fromSpherical({ ...presetAngles('right'), radius: 1 }), t = fromSpherical({ ...presetAngles('top'), radius: 1 });
    expect(f.z).toBeCloseTo(1); expect(r.x).toBeCloseTo(1); expect(t.y).toBeCloseTo(1, 3);
  });
  it('opposite pairs', () => {
    expect(VIEW_PRESETS.map(opposite)).toEqual(['back', 'front', 'left', 'right', 'bottom', 'top']);
    for (const v of VIEW_PRESETS) expect(opposite(opposite(v))).toBe(v);
  });
  it('lerpSpherical takes the short way across ±π and hits both ends exactly', () => {
    const a = { azimuth: Math.PI - 0.1, polar: 1, radius: 2 }, b = { azimuth: -Math.PI + 0.1, polar: 2, radius: 4 };
    const mid = lerpSpherical(a, b, 0.5);
    expect(Math.abs(mid.azimuth)).toBeCloseTo(Math.PI);
    expect(mid.polar).toBeCloseTo(1.5); expect(mid.radius).toBeCloseTo(3);
    expect(lerpSpherical(a, b, 0)).toEqual(a);
    expect(lerpSpherical(a, b, 1)).toEqual(b);
    const q = lerpSpherical({ azimuth: 0, polar: 1, radius: 1 }, { azimuth: Math.PI / 2, polar: 1, radius: 1 }, 0.5);
    expect(q.azimuth).toBeCloseTo(Math.PI / 4);
    expect(wrapPi(3 * Math.PI)).toBeCloseTo(Math.PI);
    expect(wrapPi(-Math.PI)).toBe(Math.PI);
  });
  it('frameDistance for a tall and a wide aspect', () => {
    const wide = frameDistance(1, 45, 2), tall = frameDistance(1, 45, 0.5);
    expect(wide).toBeCloseTo(1 / Math.sin((22.5 * Math.PI) / 180));
    expect(tall).toBeGreaterThan(wide);
    expect(tall).toBeCloseTo(1 / Math.sin(Math.atan(Math.tan((22.5 * Math.PI) / 180) * 0.5)));
  });
  it('spherical round trip and numpad keys by code', () => {
    const v = { x: 1, y: 2, z: -3 }, s = toSpherical(v), w = fromSpherical(s);
    expect(w.x).toBeCloseTo(1); expect(w.y).toBeCloseTo(2); expect(w.z).toBeCloseTo(-3);
    expect(viewKey('Numpad1', '1')).toBe('front');
    expect(viewKey('Numpad3', 'PageDown')).toBe('right');
    expect(viewKey('Numpad7', '7')).toBe('top');
    expect(viewKey('Numpad9', '9')).toBe('opposite');
    expect(viewKey('NumpadDecimal', '.')).toBe('frame');
    expect(viewKey('Home', 'Home')).toBe('frame');
    expect(viewKey('Digit1', '1')).toBeNull();
  });
});
