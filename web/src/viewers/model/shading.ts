// Viewport shading modes for the 3D viewer (plan 5.7b): Wireframe, Solid (MatCap / Studio / Flat),
// Material preview (room environment + Neutral tone mapping) and Rendered (sun, PCF soft shadows,
// ground catcher, GTAO, baked AO / lightmaps, probes), with quality tiers and auto-degrade.
// Pure helpers (tested on their own); ShadingRig, which owns every GPU resource it creates, is in ./shadingRig.
// three is only imported as types; the runtime classes come from the lazy bundle (./three).
import type * as ThreeNS from 'three';
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js';
import type { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import type { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import type { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import type { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import type { LightProbeHelper } from 'three/addons/helpers/LightProbeHelper.js';
import { store } from '@/lib/util/storage';
import { needOf, needRank, type Need } from './channels';
import type { ThreeBundle } from './three';

// ---------------------------------------------------------------- settings
export type ShadingMode = 'wire' | 'solid' | 'material' | 'rendered';
export type Quality = 'auto' | 'low' | 'medium' | 'high';
export type Tier = 'low' | 'medium' | 'high';
export type SolidLight = 'matcap' | 'studio' | 'flat';
export type Baked = 'off' | 'ao' | 'ao+lightmap';
export type Background = 'dark' | 'studio' | 'env';
export interface ShadingSettings {
  mode: ShadingMode; texture: boolean; solidLight: SolidLight; sun: number; rotate: number; shadows: boolean; ao: boolean; aoStrength: number;
  baked: Baked; bg: Background; quality: Quality;
}

export const MODES: readonly ShadingMode[] = ['wire', 'solid', 'material', 'rendered'];
export const MODE_LABELS: Record<ShadingMode, string> = { wire: 'Wireframe', solid: 'Solid', material: 'Material preview', rendered: 'Rendered' };
export const SOLID_LIGHTS: readonly SolidLight[] = ['matcap', 'studio', 'flat'];
export const SOLID_LABELS: Record<SolidLight, string> = { matcap: 'MatCap', studio: 'Studio', flat: 'Flat' };
export const BAKED: readonly Baked[] = ['off', 'ao', 'ao+lightmap'];
export const BAKED_LABELS: Record<Baked, string> = { off: 'Off', ao: 'AO', 'ao+lightmap': 'AO + lightmap' };
export const BACKGROUNDS: readonly Background[] = ['dark', 'studio', 'env'];
export const BG_LABELS: Record<Background, string> = { dark: 'Dark', studio: 'Studio grey', env: 'Environment' };
export const QUALITIES: readonly Quality[] = ['auto', 'low', 'medium', 'high'];
export const QUALITY_LABELS: Record<Quality, string> = { auto: 'Auto', low: 'Low', medium: 'Medium', high: 'High' };

/** Default mode: Material preview (owner decision; the legacy look is Solid › Studio). */
export const DEFAULT_SETTINGS: Readonly<ShadingSettings> = Object.freeze({
  mode: 'material', texture: true, solidLight: 'matcap', sun: 10, rotate: 35, shadows: true, ao: true, aoStrength: 1, baked: 'off', bg: 'dark', quality: 'auto',
});
/** localStorage key (stored as agent-art:modelView through lib/util/storage). */
export const SETTINGS_KEY = 'modelView';

const oneOf = <T extends string>(list: readonly T[], v: unknown, d: T): T => (typeof v === 'string' && (list as readonly string[]).includes(v) ? (v as T) : d);
const num = (v: unknown, min: number, max: number, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? Math.max(min, Math.min(max, v)) : d);
const bool = (v: unknown, d: boolean): boolean => (typeof v === 'boolean' ? v : d);
export const isMode = (v: unknown): v is ShadingMode => typeof v === 'string' && (MODES as readonly string[]).includes(v);

/** Validate stored settings field by field; unknown or old values fall back to the defaults. */
export function parseSettings(raw: unknown): ShadingSettings {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const d = DEFAULT_SETTINGS;
  return {
    mode: oneOf(MODES, o.mode, d.mode), texture: bool(o.texture, d.texture), solidLight: oneOf(SOLID_LIGHTS, o.solidLight, d.solidLight),
    sun: num(o.sun, 6, 18, d.sun), rotate: num(o.rotate, 0, 360, d.rotate), shadows: bool(o.shadows, d.shadows), ao: bool(o.ao, d.ao),
    aoStrength: num(o.aoStrength, 0, 1.5, d.aoStrength), baked: oneOf(BAKED, o.baked, d.baked), bg: oneOf(BACKGROUNDS, o.bg, d.bg), quality: oneOf(QUALITIES, o.quality, d.quality),
  };
}
/** Stored settings, and whether the mode itself was stored (a default Material preview may fall back to Solid › Studio). */
export function loadSettings(): { settings: ShadingSettings; explicitMode: boolean } {
  const raw = store.get<unknown>(SETTINGS_KEY, null);
  return { settings: parseSettings(raw), explicitMode: !!raw && typeof raw === 'object' && isMode((raw as { mode?: unknown }).mode) };
}
export function saveSettings(s: ShadingSettings): void {
  const { mode, texture, solidLight, sun, rotate, shadows, ao, aoStrength, baked, bg, quality } = s;
  store.set(SETTINGS_KEY, { mode, texture, solidLight, sun, rotate, shadows, ao, aoStrength, baked, bg, quality });
}

/** Which GLB the settings + channel need: Material / Rendered need materials v2, baked lighting a quick bake. */
export function needFor(settings: Pick<ShadingSettings, 'mode' | 'baked'>, channel: string): Need {
  let s: Need = settings.mode === 'material' || settings.mode === 'rendered' ? 'three' : '';
  if (settings.mode === 'rendered' && settings.baked !== 'off') s = 'bake';
  const c = needOf(channel);
  return needRank(c) > needRank(s) ? c : s;
}

// ---------------------------------------------------------------- sun
const lerpHex = (a: number, b: number, k: number): number => {
  const ch = (s: number) => Math.round(((a >> s) & 255) + (((b >> s) & 255) - ((a >> s) & 255)) * k);
  return (ch(16) << 16) | (ch(8) << 8) | ch(0);
};
/**
 * Sun for a time of day (6.0–18.0 h) and an extra rotation in degrees. Elevation 5°..75° (5° at 6 and 18 h),
 * azimuth sweeps east (90°) → south (0°, in front of the default camera) → west (270°) plus the rotation,
 * wrapped to [0, 360). Colour warms below 15° elevation; intensity 1.2..3.0.
 */
export function sunDirection(timeOfDay: number, rotateDeg: number): { azimuth: number; elevation: number; color: number; intensity: number } {
  const t = Math.max(6, Math.min(18, timeOfDay));
  const elevation = 5 + 70 * Math.sin((Math.PI * (t - 6)) / 12);
  const az = 90 - (180 * (t - 6)) / 12 + rotateDeg;
  const azimuth = ((az % 360) + 360) % 360;
  const k = Math.max(0, Math.min(1, (elevation - 5) / 10));   // fully warm at the 5° horizon, white from 15°
  return { azimuth, elevation, color: lerpHex(0xffb070, 0xffffff, k), intensity: 1.2 + (1.8 * (elevation - 5)) / 70 };
}
/** Unit vector towards the sun (y up; azimuth from +Z towards +X, like the orbit maths). */
export function sunVector(azimuthDeg: number, elevationDeg: number): { x: number; y: number; z: number } {
  const a = (azimuthDeg * Math.PI) / 180, e = (elevationDeg * Math.PI) / 180;
  return { x: Math.cos(e) * Math.sin(a), y: Math.sin(e), z: Math.cos(e) * Math.cos(a) };
}

// ---------------------------------------------------------------- quality
export interface TierSpec { dprCap: number; shadowMap: number; gtaoSamples: number; pdSamples: number; pdRings: number; msaa: number; aoWhileOrbit: boolean }
export const TIERS: Record<Tier, TierSpec> = {
  low: { dprCap: 1, shadowMap: 1024, gtaoSamples: 8, pdSamples: 8, pdRings: 2, msaa: 0, aoWhileOrbit: false },
  medium: { dprCap: 1.5, shadowMap: 2048, gtaoSamples: 16, pdSamples: 16, pdRings: 2, msaa: 2, aoWhileOrbit: true },
  high: { dprCap: 2, shadowMap: 4096, gtaoSamples: 24, pdSamples: 16, pdRings: 2, msaa: 4, aoWhileOrbit: true },
};
const WEAK_GPU = /Intel|UHD|Iris|SwiftShader|llvmpipe|Mali|Adreno|PowerVR|Microsoft Basic/i;
/** Auto start tier: Low on integrated / mobile / software GPUs or small max texture size, else Medium (never High). */
export function tierFor(rendererName: string, maxTextureSize: number): 'low' | 'medium' {
  return WEAK_GPU.test(rendererName) || maxTextureSize < 8192 ? 'low' : 'medium';
}
/** Compare slot B starts one tier below slot A. */
export const tierBelow = (t: Tier): Tier => (t === 'high' ? 'medium' : 'low');

export type DegradeStep = 'dpr' | 'gtao-samples' | 'shadow-map' | 'ao-off' | 'shadows-off' | 'solid-studio';
export const DEGRADE_REASONS: Record<DegradeStep, string> = {
  dpr: 'pixel ratio 1', 'gtao-samples': 'GTAO 8 samples', 'shadow-map': 'shadow map 1024', 'ao-off': 'AO off', 'shadows-off': 'shadows off', 'solid-studio': 'Solid › Studio (slow GPU)',
};
export interface DegradeState {
  mode: ShadingMode; dpr: number; ao: boolean; gtaoSamples: number; shadows: boolean; shadowMap: number;
  /** Material preview was the default (not chosen): it may fall back to Solid › Studio. */
  canFallback: boolean;
}
/** The next step down, in the plan's order: DPR 1 → GTAO 8 → shadow map 1024 → AO off → shadows off. Null = nothing left. */
export function nextDegradeStep(s: DegradeState): DegradeStep | null {
  if (s.dpr > 1) return 'dpr';
  if (s.mode === 'rendered') {
    if (s.ao && s.gtaoSamples > 8) return 'gtao-samples';
    if (s.shadows && s.shadowMap > 1024) return 'shadow-map';
    if (s.ao) return 'ao-off';
    if (s.shadows) return 'shadows-off';
    return null;
  }
  if (s.mode === 'material' && s.canFallback) return 'solid-studio';
  return null;
}

/**
 * Frame interval meter: a delta counts only between two consecutive rendered animation frames of a
 * visible document (idle gaps never count) and only up to 250 ms (tab switches, GC pauses).
 */
export class FrameMeter {
  private last: number | null = null;
  sample(t: number, rendered: boolean, visible: boolean): number | null {
    const prev = this.last;
    this.last = rendered && visible ? t : null;
    if (prev === null || !rendered || !visible) return null;
    const d = t - prev;
    return d > 0 && d <= 250 ? d : null;
  }
  reset(): void { this.last = null; }
}
/** Rolling mean of the last 30 frame intervals; true once the mean has stayed above 34 ms for 1.5 s of frames. */
export class FrameCostWatch {
  private samples: number[] = [];
  private over = 0;
  constructor(readonly size = 30, readonly limitMs = 34, readonly holdMs = 1500, readonly minSamples = 10) {}
  push(ms: number): boolean {
    this.samples.push(ms);
    if (this.samples.length > this.size) this.samples.shift();
    const mean = this.samples.reduce((a, b) => a + b, 0) / this.samples.length;
    if (this.samples.length < this.minSamples || mean <= this.limitMs) { if (mean <= this.limitMs) this.over = 0; return false; }
    this.over += ms;
    if (this.over < this.holdMs) return false;
    this.reset();
    return true;
  }
  mean(): number { return this.samples.length ? this.samples.reduce((a, b) => a + b, 0) / this.samples.length : 0; }
  reset(): void { this.samples = []; this.over = 0; }
}

// ---------------------------------------------------------------- probes
export interface ProbeData { origin: number[]; spacing: number | number[]; dims: number[]; coefficients?: number[] | number[][]; file?: string }
/** Probe grid positions (units): probe (x, y, z) has index (z * dims[1] + y) * dims[0] + x. */
export function probePositions(p: ProbeData): { i: number; x: number; y: number; z: number }[] {
  const [nx, ny, nz] = [p.dims[0] | 0, p.dims[1] | 0, p.dims[2] | 0];
  const sp = Array.isArray(p.spacing) ? p.spacing : [p.spacing, p.spacing, p.spacing];
  const out: { i: number; x: number; y: number; z: number }[] = [];
  for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
    out.push({ i: (z * ny + y) * nx + x, x: (p.origin[0] ?? 0) + x * sp[0], y: (p.origin[1] ?? 0) + y * sp[1], z: (p.origin[2] ?? 0) + z * sp[2] });
  }
  return out;
}
/** 27 SH9 numbers of probe i, from a flat array or an array of arrays; null when missing. */
export function probeCoeffs(c: number[] | number[][] | undefined, i: number): number[] | null {
  if (!c) return null;
  if (Array.isArray(c[0])) { const a = (c as number[][])[i]; return a && a.length >= 27 ? a : null; }
  const flat = c as number[];
  return flat.length >= (i + 1) * 27 ? flat.slice(i * 27, i * 27 + 27) : null;
}

// ---------------------------------------------------------------- status
export interface ShadingInfo {
  mode: ShadingMode; solidLight: SolidLight; tier: Tier; auto: boolean; shadowMap: number; gtaoSamples: number; composer: boolean; degraded: string[];
  environment: boolean; toneMapping: 'None' | 'Neutral'; lights: number; shadows: boolean; ao: boolean; dpr: number;
  lightmaps: number; withoutLightmap: number; bakedAo: number; probes: number; channelView: boolean;
}
/** Status suffix: " · <mode>", in Rendered the active quality facts or the degrade reasons, and baked lighting. */
export function shadingNote(i: ShadingInfo): string {
  const parts: string[] = [i.mode === 'solid' && i.solidLight !== 'matcap' ? `${MODE_LABELS.solid} › ${SOLID_LABELS[i.solidLight]}` : MODE_LABELS[i.mode]];
  if (i.mode === 'rendered') {
    if (i.lightmaps) parts.push(`baked lighting${i.withoutLightmap ? ` (${i.withoutLightmap} mesh${i.withoutLightmap > 1 ? 'es' : ''} real-time)` : ''}`);
    if (i.shadows) parts.push(`shadows ${i.shadowMap}`);
    if (i.ao) parts.push(`GTAO ${i.gtaoSamples}`);
  }
  if (i.degraded.length) parts.push(`degraded: ${i.degraded.join(', ')}`);
  return parts.join(' · ');
}

// ---------------------------------------------------------------- matcap
/** The Solid matcap: neutral grey sphere, soft key highlight top-left, cool rim. Drawn once per rig. */
export function drawMatcap(x: CanvasRenderingContext2D, size: number): void {
  const r = size / 2;
  x.fillStyle = '#6b6f78';
  x.fillRect(0, 0, size, size);
  const base = x.createRadialGradient(r * 0.72, r * 0.62, r * 0.05, r, r, r);
  base.addColorStop(0, '#f2f3f5'); base.addColorStop(0.35, '#b9bcc3'); base.addColorStop(0.8, '#6d7179'); base.addColorStop(1, '#3d4047');
  x.fillStyle = base;
  x.beginPath(); x.arc(r, r, r, 0, Math.PI * 2); x.fill();
  const rim = x.createRadialGradient(r, r, r * 0.78, r, r, r);
  rim.addColorStop(0, 'rgba(150,175,210,0)'); rim.addColorStop(1, 'rgba(150,175,210,0.55)');
  x.fillStyle = rim;
  x.beginPath(); x.arc(r, r, r, 0, Math.PI * 2); x.fill();
}
