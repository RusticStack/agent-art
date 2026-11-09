// WCAG 2 contrast ratio of two CSS colours (#rgb, #rrggbb, rgb()/rgba() with alpha composited on the background).

export type RGB = [number, number, number];

export function parseColor(c: string): { rgb: RGB; a: number } {
  const s = c.trim().toLowerCase();
  let m = s.match(/^#([0-9a-f]{3})$/);
  if (m) return { rgb: [...m[1]].map((x) => parseInt(x + x, 16)) as RGB, a: 1 };
  m = s.match(/^#([0-9a-f]{6})([0-9a-f]{2})?$/);
  if (m) return { rgb: [0, 2, 4].map((i) => parseInt(m![1].slice(i, i + 2), 16)) as RGB, a: m[2] ? parseInt(m[2], 16) / 255 : 1 };
  m = s.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+))?\s*\)$/);
  if (m) return { rgb: [+m[1], +m[2], +m[3]], a: m[4] !== undefined ? +m[4] : 1 };
  throw new Error(`unsupported colour: ${c}`);
}

const lin = (v: number) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; };
export const luminance = ([r, g, b]: RGB): number => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);

export function contrast(fg: string, bg: string): number {
  const b = parseColor(bg).rgb;
  const f = parseColor(fg);
  const rgb = f.rgb.map((v, i) => v * f.a + b[i] * (1 - f.a)) as RGB;
  const l1 = luminance(rgb), l2 = luminance(b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

/** Custom properties of the first :root block of a stylesheet. */
export function rootTokens(css: string): Record<string, string> {
  const body = css.replace(/\/\*[\s\S]*?\*\//g, '').match(/:root\s*\{([\s\S]*?)\}/)?.[1] ?? '';
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out[m[1]] = m[2].trim();
  return out;
}
