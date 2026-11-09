// View presets for the 3D viewer (plan 5.7b, View select + numpad keys): pure spherical maths around
// the orbit target. Azimuth = atan2(x, z) of the camera offset (0 = front, +Z), polar from +Y.
export type ViewPreset = 'front' | 'back' | 'right' | 'left' | 'top' | 'bottom';
export interface Spherical { azimuth: number; polar: number; radius: number }
export interface Vec3 { x: number; y: number; z: number }

export const VIEW_PRESETS: readonly ViewPreset[] = ['front', 'back', 'right', 'left', 'top', 'bottom'];
export const VIEW_LABELS: Record<ViewPreset | 'frame', string> = { front: 'Front', back: 'Back', right: 'Right', left: 'Left', top: 'Top', bottom: 'Bottom', frame: 'Frame model' };
/** OrbitControls cannot sit exactly on a pole. */
export const POLE = 0.001;
export const isPreset = (v: string): v is ViewPreset => (VIEW_PRESETS as readonly string[]).includes(v);

export function presetAngles(name: ViewPreset): { azimuth: number; polar: number } {
  switch (name) {
    case 'front': return { azimuth: 0, polar: Math.PI / 2 };
    case 'back': return { azimuth: Math.PI, polar: Math.PI / 2 };
    case 'right': return { azimuth: Math.PI / 2, polar: Math.PI / 2 };
    case 'left': return { azimuth: -Math.PI / 2, polar: Math.PI / 2 };
    case 'top': return { azimuth: 0, polar: POLE };
    case 'bottom': return { azimuth: 0, polar: Math.PI - POLE };
  }
}

export function opposite(name: ViewPreset): ViewPreset {
  const o: Record<ViewPreset, ViewPreset> = { front: 'back', back: 'front', right: 'left', left: 'right', top: 'bottom', bottom: 'top' };
  return o[name];
}

/** Wrap an angle to (-π, π]. */
export function wrapPi(a: number): number {
  const t = ((a + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
  return t === -Math.PI ? Math.PI : t;
}

/** Interpolate two sphericals; azimuth goes the short way round. t = 0 gives a, t = 1 gives b exactly. */
export function lerpSpherical(a: Spherical, b: Spherical, t: number): Spherical {
  if (t <= 0) return { ...a };
  if (t >= 1) return { ...b };
  const d = wrapPi(b.azimuth - a.azimuth);
  return { azimuth: wrapPi(a.azimuth + d * t), polar: a.polar + (b.polar - a.polar) * t, radius: a.radius + (b.radius - a.radius) * t };
}

/** Camera distance that fits a bounding sphere of `radius` in a perspective view (vertical fov in degrees). */
export function frameDistance(radius: number, fovDeg: number, aspect: number): number {
  const vHalf = (fovDeg * Math.PI) / 360;
  const hHalf = Math.atan(Math.tan(vHalf) * Math.max(1e-6, aspect));
  return radius / Math.sin(Math.max(1e-6, Math.min(vHalf, hHalf)));
}

export function toSpherical(off: Vec3): Spherical {
  const r = Math.hypot(off.x, off.y, off.z) || 1;
  return { azimuth: Math.atan2(off.x, off.z), polar: Math.acos(Math.max(-1, Math.min(1, off.y / r))), radius: r };
}
export function fromSpherical(s: Spherical): Vec3 {
  const sp = Math.sin(s.polar);
  return { x: s.radius * sp * Math.sin(s.azimuth), y: s.radius * Math.cos(s.polar), z: s.radius * sp * Math.cos(s.azimuth) };
}

/** Numpad view keys by e.code (never the digit keys, which select shading modes). */
export function viewKey(code: string, key: string): ViewPreset | 'opposite' | 'frame' | null {
  switch (code) {
    case 'Numpad1': return 'front';
    case 'Numpad3': return 'right';
    case 'Numpad7': return 'top';
    case 'Numpad9': return 'opposite';
    case 'NumpadDecimal': return 'frame';
    default: return key === 'Home' ? 'frame' : null;
  }
}

/** Ease for the 200 ms camera move. */
export const easeInOut = (t: number): number => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);
