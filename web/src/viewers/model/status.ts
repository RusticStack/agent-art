// Status line and keyboard-orbit maths for the 3D viewer (pure).
import type { ModelInfo } from '@/lib/api/types';
import { fmtBytes } from '@/lib/util/format';

export interface ModelStats {
  name: string; snap?: string;
  tris: number; verts: number; meshes: number; materials: number; nodes: number; sockets: number; clips: number;
  size: [number, number, number]; bytes: number;
}

/** "rifle · 120 tris · 96 verts · 3 meshes · 2 materials · 5 nodes · 1 sockets · 0 clips · size 2×1×6 u · 4.1 kB". */
export function statusLine(s: ModelStats, info: ModelInfo | null): string {
  const rig = info?.rig;
  return [
    s.name + (s.snap ? ` (snapshot ${s.snap})` : ''),
    `${Math.round(s.tris)} tris`, `${s.verts} verts`, `${s.meshes} meshes`, `${s.materials} materials`,
    `${s.nodes} nodes`, `${s.sockets} sockets`, `${s.clips} clips`,
    info?.size_units ? `size ${info.size_units.join('×')} u` : `size ${s.size.map((v) => v.toFixed(2)).join('×')} u`,
    rig ? `rig ${rig.nodes?.length ?? ''} nodes` : '', fmtBytes(s.bytes), ...(info?.warnings || []).map((w) => '⚠ ' + w),
  ].filter(Boolean).join(' · ');
}
/** Base status and channel note are composed separately. */
export const composeStatus = (base: string, note: string): string => [base, note].filter(Boolean).join(' · ');

/** Texture canvases a model uses (info.materials, "overlay:" prefix stripped). */
export function usesCanvas(info: ModelInfo | null, canvas: string): boolean {
  return !!info?.materials?.some((m) => String(m).replace(/^overlay:/, '') === canvas);
}

export type Vec3 = { x: number; y: number; z: number };
const EPS = 0.001;
/**
 * Keyboard orbit: rotate the camera offset (camera - target, y up) by dAz around y and dPolar towards
 * the poles (clamped off the poles, as OrbitControls requires), and scale its length by dolly.
 */
export function orbitOffset(off: Vec3, dAz: number, dPolar: number, dolly = 1): Vec3 {
  const r = Math.hypot(off.x, off.y, off.z) || 1;
  let theta = Math.atan2(off.x, off.z);
  let phi = Math.acos(Math.max(-1, Math.min(1, off.y / r)));
  theta += dAz;
  phi = Math.max(EPS, Math.min(Math.PI - EPS, phi + dPolar));
  const rr = r * dolly, sp = Math.sin(phi);
  return { x: rr * sp * Math.sin(theta), y: rr * Math.cos(phi), z: rr * sp * Math.cos(theta) };
}
export const ORBIT_STEP = (10 * Math.PI) / 180;
/** Arrow / + / - key to [dAz, dPolar, dolly], or null. */
export function orbitKey(key: string): [number, number, number] | null {
  switch (key) {
    case 'ArrowLeft': return [-ORBIT_STEP, 0, 1];
    case 'ArrowRight': return [ORBIT_STEP, 0, 1];
    case 'ArrowUp': return [0, -ORBIT_STEP, 1];
    case 'ArrowDown': return [0, ORBIT_STEP, 1];
    case '+': case '=': return [0, 0, 0.9];
    case '-': case '_': return [0, 0, 1 / 0.9];
    default: return null;
  }
}
/** Animation step in seconds: never jump after a pause or a background tab. */
export const clampDt = (dt: number): number => Math.max(0, Math.min(0.1, dt));
