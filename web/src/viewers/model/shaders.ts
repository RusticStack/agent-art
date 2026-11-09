// Channel-view shaders (RawShaderMaterial): used only once three is loaded, so they ship in the three
// chunk and the model viewer reaches them through ./shadingRig.
import type { Swizzle } from './channels';

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
