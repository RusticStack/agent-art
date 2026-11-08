// Automatic pixel-art review. Returns concrete, actionable problems (with coordinates) so a
// model can fix its art without relying on its own (often weak) visual judgement.
import { toHex, rgbToHsl } from './color.js';

const lum = (r, g, b) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** RGBA buffer -> helper view. */
function view(data, w, h) {
  const at = (x, y) => {
    const p = (y * w + x) * 4;
    return [data[p], data[p + 1], data[p + 2], data[p + 3]];
  };
  const op = (x, y) => x >= 0 && y >= 0 && x < w && y < h && data[(y * w + x) * 4 + 3] > 0;
  const key = (x, y) => {
    const p = (y * w + x) * 4;
    return (data[p] << 24) | (data[p + 1] << 16) | (data[p + 2] << 8) | data[p + 3];
  };
  return { at, op, key };
}

const pct = (v) => Math.round(v * 100);

/**
 * Critique one image. kind: auto | texture | sprite | scene.
 * Returns { kind, stats, issues: [{id, severity, message, fix, at?}], score }.
 */
export function critiqueImage(data, w, h, { kind = 'auto', tileable, maxColors } = {}) {
  const { at, op, key } = view(data, w, h);
  const N = w * h;
  let opaque = 0, semi = 0;
  const counts = new Map();
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const c = at(x, y);
    if (!c[3]) continue;
    opaque++;
    if (c[3] < 255) semi++;
    const k = key(x, y);
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  const issues = [];
  const add = (id, severity, message, fix, extra = {}) => issues.push({ id, severity, message, fix, ...extra });
  if (!opaque) {
    add('empty', 'error', 'The image is empty (fully transparent).', 'Draw something first.');
    return { kind, stats: { colors: 0, coverage: 0 }, issues, score: 0 };
  }
  const coverage = opaque / N;
  if (kind === 'auto') kind = coverage > 0.97 ? (w <= 64 && h <= 64 ? 'texture' : 'scene') : 'sprite';
  const colors = [...counts.entries()].map(([k, n]) => ({ c: [(k >>> 24) & 255, (k >>> 16) & 255, (k >>> 8) & 255, k & 255], n }));
  colors.sort((a, b) => b.n - a.n);

  // --- palette size ---
  const limit = maxColors ?? (kind === 'scene' ? 64 : Math.max(8, Math.min(32, Math.round(Math.sqrt(opaque) * 1.2))));
  if (colors.length > limit) {
    add('too_many_colors', 'warn', `${colors.length} colors for a ${w}x${h} ${kind} (aim for <= ${limit}).`, 'Use a small ramp per material (4-6 shades); run quantize with your palette, or remap near-duplicate colors.');
  }
  // --- near-duplicate colors (wasted shades that read as noise) ---
  const dups = [];
  for (let i = 0; i < colors.length && dups.length < 6; i++) for (let j = i + 1; j < colors.length; j++) {
    if (colors[i].c[3] === colors[j].c[3] && dist(colors[i].c, colors[j].c) < 10) { dups.push([toHex(colors[i].c), toHex(colors[j].c)]); break; }
  }
  if (dups.length) add('near_duplicate_colors', 'info', `Near-identical colors: ${dups.map((d) => d.join('~')).join(', ')}.`, 'Merge them with remap so each shade is clearly distinct.');
  // --- semi-transparency in sprites/textures ---
  if (kind !== 'scene' && semi > opaque * 0.05) {
    add('semi_transparent', 'info', `${pct(semi / opaque)}% of pixels are semi-transparent.`, 'Game sprites/textures usually want fully opaque pixels; quantize with alpha_threshold:0.5 unless the glow is intended.');
  }

  // --- orphan pixels: no same-color 4-neighbour, strongly different from all neighbours ---
  const orphans = [];
  let noisy = 0;
  const wrap = kind === 'texture';
  const nb4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (!op(x, y)) continue;
    const me = key(x, y), c = at(x, y);
    let same = 0, diffCount = 0, neighbours = 0, minD = Infinity;
    for (const [dx, dy] of nb4) {
      let xx = x + dx, yy = y + dy;
      if (wrap) { xx = (xx + w) % w; yy = (yy + h) % h; }
      if (!op(xx, yy)) continue;
      neighbours++;
      if (key(xx, yy) === me) same++;
      else { diffCount++; minD = Math.min(minD, dist(c, at(xx, yy))); }
    }
    if (neighbours >= 3 && diffCount >= 3) noisy++;
    if (neighbours >= 3 && same === 0 && minD > 40) orphans.push([x, y]);
  }
  const noiseRatio = noisy / opaque;
  if (orphans.length > Math.max(2, opaque * 0.02)) {
    add('orphan_pixels', 'warn', `${orphans.length} isolated single pixels (no same-colored neighbour).`, 'Remove them or grow them into 2-3 px clusters; random speckle reads as noise.', { at: orphans.slice(0, 12) });
  }
  if (noiseRatio > (kind === 'texture' ? 0.35 : kind === 'scene' ? 0.6 : 0.3)) { // scenes use dithered gradients legitimately
    add('noisy', 'warn', `${pct(noiseRatio)}% of pixels differ from 3+ neighbours: the surface reads as noise/static.`, 'Use bigger clusters of the same shade (noise scale 3-4 + despeckle, or hand-placed shapes) and keep 1px detail for edges/highlights.');
  }

  // --- contrast: luminance range and distinct value levels ---
  let lo = 1, hi = 0;
  for (const { c } of colors) { const l = lum(c[0], c[1], c[2]); lo = Math.min(lo, l); hi = Math.max(hi, l); }
  if (hi - lo < 0.25 && colors.length > 1) add('low_contrast', 'warn', `Value range is only ${pct(hi - lo)}% (darkest ${pct(lo)}%, brightest ${pct(hi)}%).`, 'Widen the ramp: darker shadows and a brighter highlight make the form readable.');
  if (colors.length > 2) {
    const sat = colors.map(({ c }) => rgbToHsl(c[0], c[1], c[2])[1]);
    const avgS = sat.reduce((a, b) => a + b, 0) / sat.length;
    if (avgS < 0.06 && kind !== 'texture') add('desaturated', 'info', 'Nearly grayscale colors.', 'Hue-shift the ramp (cool shadows, warm highlights) for more life, unless grayscale is intended (e.g. biome-tinted textures).');
  }

  // --- tiling seams (textures) ---
  if (tileable ?? kind === 'texture') {
    // discontinuity across the wrap boundary vs every interior column/row boundary
    const colDiff = (x0, x1) => { let t = 0; for (let y = 0; y < h; y++) t += dist(at(x0, y), at(x1, y)); return t / h; };
    const rowDiff = (y0, y1) => { let t = 0; for (let x = 0; x < w; x++) t += dist(at(x, y0), at(x, y1)); return t / w; };
    const inner = [];
    for (let x = 0; x < w - 1; x++) inner.push(colDiff(x, x + 1));
    for (let y = 0; y < h - 1; y++) inner.push(rowDiff(y, y + 1));
    inner.sort((p, q) => p - q);
    const p90 = inner[inner.length - 1] ?? 0; // roughest interior line
    const e = Math.max(colDiff(w - 1, 0), rowDiff(h - 1, 0));
    if (e > p90 * 1.1 + 6) add('tiling_seam', 'warn', `The wrap edge differs ${Math.round(e)} vs ${Math.round(p90)} for the roughest interior line: a visible seam when tiled.`, 'Check with art_view tile:3; continue shapes across the borders (shift wrap:true by half the size, fix the middle cross, shift back).');
    // straight lines that run exactly along the border look like a grid when tiled
    let rowSame = 0;
    for (let x = 0; x < w; x++) if (key(x, 0) === key(0, 0)) rowSame++;
    if (rowSame === w && w >= 8 && colors.length > 2) add('border_line', 'info', 'The whole top row is one color: tiles will show a grid line.', 'Break border lines up unless a framed/beveled block is intended.');
  }

  // --- sprite checks: outline, silhouette, pillow shading, jaggies ---
  if (kind === 'sprite') {
    let border = 0, darkBorder = 0;
    const edgePix = [];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (!op(x, y)) continue;
      if (!op(x + 1, y) || !op(x - 1, y) || !op(x, y + 1) || !op(x, y - 1)) {
        border++;
        edgePix.push([x, y]);
        const c = at(x, y);
        if (lum(c[0], c[1], c[2]) < (lo + (hi - lo) * 0.35)) darkBorder++;
      }
    }
    if (border && darkBorder / border < 0.5 && opaque > 40) {
      add('weak_outline', 'info', `Only ${pct(darkBorder / border)}% of the silhouette edge is dark.`, 'Add an outline (outline mode:outer with a dark, hue-shifted color — not pure black) so the sprite reads on any background; selective light-side outlines are fine.');
    }
    // jaggies: single-pixel steps breaking an otherwise straight edge run (doubles / L-corners)
    let corners = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (op(x, y)) continue;
      // empty pixel with opaque on exactly two orthogonal sides forming an L inner corner and the diagonal empty
      const r = op(x + 1, y), l = op(x - 1, y), d = op(x, y + 1), u = op(x, y - 1);
      if ((r && d && !l && !u && op(x + 1, y + 1)) || (l && d && !r && !u && op(x - 1, y + 1)) || (r && u && !l && !d && op(x + 1, y - 1)) || (l && u && !r && !d && op(x - 1, y - 1))) corners++;
    }
    if (corners > Math.max(4, border * 0.25)) add('jaggies', 'info', `${corners} stair-step corners along the silhouette.`, 'Smooth curves with consistent step lengths (1-1-2-2-3...), line pixel_perfect:true, or curve for round shapes.');
    // pillow shading: brightness follows distance-from-edge instead of a light direction
    const pts = [];
    let maxD = 0;
    const dEdge = new Float32Array(N).fill(0);
    // cheap distance-to-edge via BFS
    const q = [];
    for (const [x, y] of edgePix) { dEdge[y * w + x] = 1; q.push(x, y); }
    for (let i = 0; i < q.length; i += 2) {
      const x = q[i], y = q[i + 1], dv = dEdge[y * w + x];
      for (const [dx, dy] of nb4) {
        const xx = x + dx, yy = y + dy;
        if (!op(xx, yy) || dEdge[yy * w + xx]) continue;
        dEdge[yy * w + xx] = dv + 1;
        maxD = Math.max(maxD, dv + 1);
        q.push(xx, yy);
      }
    }
    if (maxD >= 4) {
      let cx = 0, cy = 0;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (op(x, y)) { cx += x; cy += y; }
      cx /= opaque; cy /= opaque;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        if (!op(x, y) || dEdge[y * w + x] < 2) continue; // ignore the outline ring
        const c = at(x, y);
        pts.push({ l: lum(c[0], c[1], c[2]), d: dEdge[y * w + x], dir: -((x - cx) + (y - cy)) });
      }
      const corr = (f) => {
        const n = pts.length;
        if (n < 10) return 0;
        let sa = 0, sb = 0;
        for (const p of pts) { sa += f(p); sb += p.l; }
        const ma = sa / n, mb = sb / n;
        let cov = 0, va = 0, vb = 0;
        for (const p of pts) { const a = f(p) - ma, b = p.l - mb; cov += a * b; va += a * a; vb += b * b; }
        return va && vb ? cov / Math.sqrt(va * vb) : 0;
      };
      const cDist = corr((p) => p.d), cDir = corr((p) => p.dir);
      if (cDist > 0.55 && Math.abs(cDir) < 0.25) add('pillow_shading', 'warn', `Brightness follows distance from the edge (r=${cDist.toFixed(2)}) but not a light direction (r=${cDir.toFixed(2)}): pillow shading.`, 'Pick one light direction (e.g. top-left): lighten the top-left-facing side, darken the bottom-right side, not every edge. The "shade" command does this automatically.');
      if (Math.abs(cDir) < 0.1 && cDist < 0.3 && colors.length >= 3) add('flat_shading', 'info', 'No consistent light direction detected.', 'Add form shading from one light (shade command, or lighter top-left / darker bottom-right).');
    }
  }

  const sev = { error: 30, warn: 12, info: 4 };
  const score = Math.max(0, 100 - issues.reduce((a, i) => a + sev[i.severity], 0));
  return {
    kind,
    stats: { size: `${w}x${h}`, colors: colors.length, coverage: pct(coverage), value_range: pct(hi - lo), noise: pct(noiseRatio) },
    issues,
    score,
  };
}

/** Animation consistency over frames: size/volume drift, ground line, palette drift, duplicates. */
export function critiqueFrames(frames, w, h) {
  const info = frames.map((data, i) => {
    let x0 = w, y0 = h, x1 = -1, y1 = -1, n = 0;
    const cols = new Set();
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const p = (y * w + x) * 4;
      if (!data[p + 3]) continue;
      n++;
      cols.add((data[p] << 16) | (data[p + 1] << 8) | data[p + 2]);
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    return { i, n, bottom: y1, height: y1 - y0 + 1, width: x1 - x0 + 1, cols };
  });
  const issues = [];
  const add = (id, severity, message, fix, extra = {}) => issues.push({ id, severity, message, fix, ...extra });
  const painted = info.filter((f) => f.n);
  if (painted.length < frames.length) add('empty_frames', 'warn', `Empty frames: ${info.filter((f) => !f.n).map((f) => f.i).join(', ')}.`, 'Draw them or delete them (art_animation delete).');
  if (painted.length >= 2) {
    const ns = painted.map((f) => f.n), avg = ns.reduce((a, b) => a + b, 0) / ns.length;
    const worst = painted.reduce((a, f) => (Math.abs(f.n - avg) > Math.abs(a.n - avg) ? f : a));
    if (Math.abs(worst.n - avg) / avg > 0.22) add('volume_drift', 'warn', `Frame ${worst.i} has ${worst.n} px vs ${Math.round(avg)} on average: the character changes size/mass.`, 'Keep the same body; build frames from a base frame (copy from_frame) and move parts instead of redrawing.');
    const bottoms = painted.map((f) => f.bottom);
    const bMin = Math.min(...bottoms), bMax = Math.max(...bottoms);
    if (bMax - bMin > Math.max(1, Math.round(h * 0.06))) add('ground_line', 'info', `Lowest painted row varies ${bMin}..${bMax} between frames.`, 'Keep feet on one ground line unless the motion is a jump/bob (a 1px bob is fine).', { frames: painted.map((f) => [f.i, f.bottom]) });
    const base = painted[0].cols;
    for (const f of painted.slice(1)) {
      const extra = [...f.cols].filter((c) => !base.has(c));
      if (extra.length > Math.max(2, base.size * 0.3)) { add('palette_drift', 'warn', `Frame ${f.i} uses ${extra.length} colors that frame ${painted[0].i} does not.`, 'Use the same palette keys in every frame (project/canvas palette).'); break; }
    }
    for (let i = 1; i < frames.length; i++) {
      if (info[i].n && Buffer.compare(Buffer.from(frames[i].buffer, frames[i].byteOffset, frames[i].byteLength), Buffer.from(frames[i - 1].buffer, frames[i - 1].byteOffset, frames[i - 1].byteLength)) === 0) {
        add('duplicate_frames', 'info', `Frame ${i} is identical to frame ${i - 1}.`, 'Intended holds are better expressed with a longer duration on one frame.');
        break;
      }
    }
  }
  return { frames: info.map(({ i, n, bottom, width, height }) => ({ i, px: n, bottom, bbox: `${width}x${height}` })), issues };
}
