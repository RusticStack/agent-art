// Material channel views (materials v2) and the GLB request they need. Pure: no three import.
// Channels that need the v2 GLB reload it with profile=three; lightmap / AO / bent normals / lightmap
// UVs (TEXCOORD_1) also need a quick bake (bake=1). Shown through a RawShaderMaterial (VS / FS below).
import { exportFile, modelGlb } from '@/lib/api/urls';
import type { Target } from '../types';

export type Need = '' | 'three' | 'bake';
export type Swizzle = 'rgb' | 'r' | 'g' | 'b';
export type ChannelId = 'lit' | 'albedo' | 'normal' | 'orm' | 'metal' | 'rough' | 'ao' | 'emissive' | 'height' | 'detail' | 'lightmap' | 'bent' | 'tangent' | 'uv1';
export interface ChannelSpec { label: string; source: string | null; swizzle?: Swizzle; needs?: 'three' | 'bake' }

/** source: a material texture property, `x:<path>` = texture index in material extras (userData), or the tangent / uv1 attribute. */
export const CHANNELS: Record<ChannelId, ChannelSpec> = {
  lit: { label: 'Lit', source: null },
  albedo: { label: 'Albedo', source: 'map' },
  normal: { label: 'Normal', source: 'normalMap', swizzle: 'rgb', needs: 'three' },
  orm: { label: 'ORM', source: 'metalnessMap', swizzle: 'rgb', needs: 'three' },
  metal: { label: 'Metal', source: 'metalnessMap', swizzle: 'b', needs: 'three' },
  rough: { label: 'Rough', source: 'roughnessMap', swizzle: 'g', needs: 'three' },
  ao: { label: 'AO', source: 'aoMap', swizzle: 'r', needs: 'bake' },
  emissive: { label: 'Emissive', source: 'emissiveMap', swizzle: 'rgb', needs: 'three' },
  height: { label: 'Height', source: 'x:heightTexture', swizzle: 'r', needs: 'three' },
  detail: { label: 'Detail', source: 'x:detail.texture', swizzle: 'rgb', needs: 'three' },
  lightmap: { label: 'Lightmap', source: 'x:lightMap', swizzle: 'rgb', needs: 'bake' },
  bent: { label: 'Bent normals', source: 'x:bentNormalTexture', swizzle: 'rgb', needs: 'bake' },
  tangent: { label: 'Tangents', source: 'tangent', swizzle: 'rgb', needs: 'three' },
  uv1: { label: 'Lightmap UVs', source: 'uv1', swizzle: 'rgb', needs: 'bake' },
};
export const CHANNEL_IDS = Object.keys(CHANNELS) as ChannelId[];
export const isChannel = (v: string): v is ChannelId => Object.prototype.hasOwnProperty.call(CHANNELS, v);
export const SWIZZLE: Record<Swizzle, number> = { rgb: 0, r: 1, g: 2, b: 3 };

export const VS = `precision highp float;
uniform mat4 modelViewMatrix; uniform mat4 projectionMatrix;
attribute vec3 position; attribute vec2 uv; attribute vec2 uv1; attribute vec4 tangent;
varying vec2 vUv; varying vec2 vUv1; varying vec4 vT;
void main() { vUv = uv; vUv1 = uv1; vT = tangent; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
export const FS = `precision highp float;
uniform sampler2D map; uniform int useMap; uniform int useUv1; uniform int mode; uniform int swz; uniform int toSrgb; uniform vec3 color; uniform float scale;
varying vec2 vUv; varying vec2 vUv1; varying vec4 vT;
vec3 srgb(vec3 c) { return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
void main() {
  vec3 c = color;
  if (mode == 1) c = vT.xyz * 0.5 + 0.5;
  else if (mode == 2) { vec2 g = floor(vUv1 * 64.0); c = vec3(vUv1, mod(g.x + g.y, 2.0) * 0.6 + 0.2); }
  else if (useMap == 1) {
    vec4 t = texture2D(map, (useUv1 == 1 ? vUv1 : vUv) * scale);
    vec3 v = swz == 1 ? vec3(t.r) : swz == 2 ? vec3(t.g) : swz == 3 ? vec3(t.b) : t.rgb;
    c = (toSrgb == 1 ? srgb(v) : v) * color;
  }
  gl_FragColor = vec4(c, 1.0);
}`;

export const needOf = (ch: string): Need => (isChannel(ch) ? CHANNELS[ch].needs ?? '' : '');
export function needRank(need: Need): 0 | 1 | 2 { return need === 'bake' ? 2 : need === 'three' ? 1 : 0; }
/** A channel change reloads only when it needs a richer GLB than the one loaded (workspace models only). */
export const needsReload = (target: Target | null, want: Need, loaded: Need): boolean => !!target && target.kind === 'model' && needRank(want) > needRank(loaded);
/** What the GLB actually loaded for this target carries (exports and others: nothing extra). */
export const loadedNeed = (target: Target, need: Need): Need => (target.kind === 'model' ? need : '');

/** Query string (no '?') for /api/model/<n>/glb: snap, then profile=three (+ &bake=1) for workspace models. */
export function glbQuery(target: Target, need: Need): string {
  const snap = 'snap' in target && target.snap ? `snap=${encodeURIComponent(target.snap)}` : '';
  const prof = target.kind === 'model' && need ? `profile=three${need === 'bake' ? '&bake=1' : ''}` : '';
  return [snap, prof].filter(Boolean).join('&');
}
/** GLB URL for a model (workspace or snapshot) or an exported .glb file. */
export function glbUrl(target: Target, need: Need): string {
  if (target.kind === 'export') return exportFile(target.name);
  const name = 'name' in target ? target.name : '';
  const q = glbQuery(target, need);
  return modelGlb(name) + (q ? `?${q}` : '');
}
export function downloadHref(url: string): string { return url + (url.includes('?') ? '&' : '?') + 'download=1'; }
export function downloadName(name: string): string { return `${name.split('/').pop()!.replace(/\.glb$/i, '')}.glb`; }

export type RGB = [number, number, number];
/** Constant colour shown when a mesh's material lacks the channel's texture (legacy values). */
export function fallbackColor(ch: ChannelId, src: string, m: { metalness?: number; roughness?: number; color?: RGB | null }): RGB {
  const mt = m.metalness ?? 0, rg = m.roughness ?? 1;
  if (src === 'normalMap') return [0.5, 0.5, 1];
  if (src === 'metalnessMap') return ch === 'orm' ? [1, rg, mt] : [mt, mt, mt];
  if (src === 'roughnessMap') return [rg, rg, rg];
  if (src === 'map' && m.color) return [...m.color];
  if (src !== 'emissiveMap' && src !== 'aoMap') return [0.25, 0.1, 0.25];
  if (src === 'aoMap') return [1, 1, 1];
  return [0, 0, 0];
}
/** Status suffix for a channel view: "channel Normal (2 meshes without it)". */
export function channelNote(ch: string, missing: number): string {
  if (!isChannel(ch) || ch === 'lit') return '';
  return `channel ${CHANNELS[ch].label}${missing ? ` (${missing} mesh${missing > 1 ? 'es' : ''} without it)` : ''}`;
}
