// Color parsing, conversion and palette-ramp generation.

const NAMED = {
  black: '#000000', white: '#ffffff', red: '#ff0000', green: '#008000', lime: '#00ff00',
  blue: '#0000ff', yellow: '#ffff00', cyan: '#00ffff', magenta: '#ff00ff', gray: '#808080',
  grey: '#808080', orange: '#ffa500', purple: '#800080', brown: '#8b4513', pink: '#ffc0cb',
  silver: '#c0c0c0', maroon: '#800000', navy: '#000080', olive: '#808000', teal: '#008080',
};

export const TRANSPARENT = [0, 0, 0, 0];

const clamp255 = (v) => Math.max(0, Math.min(255, Math.round(v)));

/**
 * Parse a color. Accepts: [r,g,b,a?], "#rgb", "#rgba", "#rrggbb", "#rrggbbaa",
 * "rgb(r,g,b)", "rgba(r,g,b,a)", "hsl(h,s%,l%)", "transparent", CSS basic names,
 * or a key of the given palette (e.g. "s2" or "@s2").
 */
export function parseColor(input, palette = {}) {
  if (input == null) throw new Error('Missing color');
  if (Array.isArray(input)) {
    const [r, g, b, a = 255] = input;
    return [clamp255(r), clamp255(g), clamp255(b), clamp255(a)];
  }
  if (typeof input === 'object' && 'r' in input) {
    return [clamp255(input.r), clamp255(input.g), clamp255(input.b), clamp255(input.a ?? 255)];
  }
  let s = String(input).trim();
  if (s.startsWith('@')) s = s.slice(1);
  if (Object.prototype.hasOwnProperty.call(palette, s)) return parseColor(palette[s]);
  const lower = s.toLowerCase();
  if (lower === 'transparent' || lower === 'none' || lower === 'clear') return [...TRANSPARENT];
  if (NAMED[lower]) return parseColor(NAMED[lower]);
  if (lower.startsWith('#')) {
    let h = lower.slice(1);
    if (!/^[0-9a-f]+$/.test(h)) throw new Error(`Bad hex color "${input}"`);
    if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join('');
    if (h.length !== 6 && h.length !== 8) throw new Error(`Bad hex color "${input}"`);
    const n = (i) => parseInt(h.slice(i, i + 2), 16);
    return [n(0), n(2), n(4), h.length === 8 ? n(6) : 255];
  }
  let m = lower.match(/^rgba?\(([^)]+)\)$/);
  if (m) {
    const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
    const a = p.length > 3 ? (p[3] <= 1 ? p[3] * 255 : p[3]) : 255;
    return [clamp255(p[0]), clamp255(p[1]), clamp255(p[2]), clamp255(a)];
  }
  m = lower.match(/^hsla?\(([^)]+)\)$/);
  if (m) {
    const p = m[1].split(/[\s,/]+/).filter(Boolean).map((v) => parseFloat(v));
    const [r, g, b] = hslToRgb(p[0], p[1] / 100, p[2] / 100);
    const a = p.length > 3 ? (p[3] <= 1 ? p[3] * 255 : p[3]) : 255;
    return [r, g, b, clamp255(a)];
  }
  throw new Error(`Unknown color "${input}" (use #hex, rgb(), hsl(), transparent, or a palette key)`);
}

export function toHex([r, g, b, a = 255]) {
  const h = (v) => v.toString(16).padStart(2, '0');
  return '#' + h(r) + h(g) + h(b) + (a < 255 ? h(a) : '');
}

export function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0, s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
  }
  return [h, s, l];
}

export function hslToRgb(h, s, l) {
  h = ((h % 360) + 360) % 360;
  s = Math.max(0, Math.min(1, s));
  l = Math.max(0, Math.min(1, l));
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r, g, b;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return [clamp255((r + m) * 255), clamp255((g + m) * 255), clamp255((b + m) * 255)];
}

/** Rotate hue h toward target by `amount` degrees along the shortest path. */
function hueToward(h, target, amount) {
  let d = ((target - h + 540) % 360) - 180;
  const step = Math.sign(d) * Math.min(Math.abs(d), amount);
  return h + step;
}

/** Adjust a color in HSL space. dl/ds are additive (-1..1), dh in degrees. */
export function adjustColor([r, g, b, a], { hue = 0, saturation = 0, lightness = 0 } = {}) {
  const [h, s, l] = rgbToHsl(r, g, b);
  const [nr, ng, nb] = hslToRgb(h + hue, s + saturation, l + lightness);
  return [nr, ng, nb, a];
}

/**
 * Build a pixel-art shading ramp (dark -> light) around a base color, with hue shifting:
 * shadows drift toward cool/blue-violet, highlights toward warm/yellow, the way pixel
 * artists hand-pick ramps instead of just mixing with black/white.
 */
export function makeRamp(base, { steps = 5, hueShift = 18, spread = 0.5, saturationShift = 0.08 } = {}) {
  const [r, g, b] = parseColor(base);
  const [h, s, l] = rgbToHsl(r, g, b);
  const out = [];
  const mid = (steps - 1) / 2;
  const lo = Math.max(0.03, l - spread * 0.55);
  const hi = Math.min(0.97, l + spread * 0.45);
  for (let i = 0; i < steps; i++) {
    const t = steps === 1 ? 0 : (i - mid) / mid; // -1 (darkest) .. +1 (lightest)
    const nl = t < 0 ? l + (l - lo) * t : l + (hi - l) * t;
    const nh = t < 0 ? hueToward(h, 245, hueShift * -t) : hueToward(h, 55, hueShift * t);
    // saturation peaks in the mid/dark tones, drops at the bright end
    const ns = s + saturationShift * (t < 0 ? -t * 0.5 : -t);
    out.push(toHex([...hslToRgb(nh, ns, nl), 255]));
  }
  return out;
}

export function colorsEqual(a, b, tolerance = 0) {
  if (tolerance <= 0) return a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3];
  if (a[3] === 0 && b[3] === 0) return true;
  return (
    Math.abs(a[0] - b[0]) <= tolerance && Math.abs(a[1] - b[1]) <= tolerance &&
    Math.abs(a[2] - b[2]) <= tolerance && Math.abs(a[3] - b[3]) <= tolerance
  );
}

/** Source-over alpha compositing of src onto dst, returns new color. */
export function blendOver(dst, src, opacity = 1) {
  const sa = (src[3] / 255) * opacity;
  if (sa <= 0) return dst;
  const da = dst[3] / 255;
  const oa = sa + da * (1 - sa);
  if (oa <= 0) return [0, 0, 0, 0];
  const ch = (i) => clamp255((src[i] * sa + dst[i] * da * (1 - sa)) / oa);
  return [ch(0), ch(1), ch(2), clamp255(oa * 255)];
}
