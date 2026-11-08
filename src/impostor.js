// Impostors for far LOD: the model rendered from many directions into one atlas (albedo, world
// normal, depth), with the existing software rasteriser (nearest texels, no AA). Layouts:
//   octahedral  N x N cells, each the view along the direction decoded from the cell centre of a
//               (hemi-)octahedral map: the engine encodes its view direction to find the cell (and
//               blends the 3 nearest for smooth turns).
//   ring        n yaw angles (+ optional pitch) around the model, for objects seen from the ground.
// Every cell uses the same orthographic scale (the bounding sphere fits the cell), so the billboard
// is a fixed-size quad of side 2 * radius centred on the sphere centre.
import { rasterCore } from './raster3d.js';

const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const sgn = (v) => (v < 0 ? -1 : 1);

/** Octahedral map [-1,1]^2 -> unit direction (y up). hemi: upper hemisphere only. */
export function octDecode(u, v, hemi = true) {
  if (hemi) { const a = (u + v) / 2, b = (u - v) / 2; return norm([a, 1 - Math.abs(a) - Math.abs(b), b]); }
  let x = u, z = v; const y = 1 - Math.abs(u) - Math.abs(v);
  if (y < 0) { const ox = x; x = (1 - Math.abs(z)) * sgn(ox); z = (1 - Math.abs(ox)) * sgn(z); }
  return norm([x, y, z]);
}
/** Unit direction -> octahedral [-1,1]^2 (inverse of octDecode). */
export function octEncode(d, hemi = true) {
  const s = Math.abs(d[0]) + Math.abs(d[1]) + Math.abs(d[2]) || 1;
  let x = d[0] / s, z = d[2] / s;
  if (hemi) return [x + z, x - z];
  if (d[1] < 0) { const ox = x; x = (1 - Math.abs(z)) * sgn(ox); z = (1 - Math.abs(ox)) * sgn(z); }
  return [x, z];
}

/** impostor: true | {layout?:"octahedral"|"ring", grid?:8, angles?:8, pitch?:0, size?:64, full?:false} */
export function normImpostor(v) {
  if (!v) return null;
  const o = v === true ? {} : v;
  if (typeof o !== 'object') throw new Error('impostor must be true or {layout?:"octahedral"|"ring", grid?:8, angles?:8|16, pitch?, size?:64, full?}');
  const layout = o.layout ?? (o.angles !== undefined ? 'ring' : 'octahedral');
  if (!['octahedral', 'ring'].includes(layout)) throw new Error('impostor layout must be "octahedral" or "ring"');
  const size = Math.round(Number(o.size ?? 64));
  if (!(size >= 8 && size <= 512)) throw new Error('impostor size (px per cell) must be 8..512');
  const grid = Math.round(Number(o.grid ?? 8)), angles = Math.round(Number(o.angles ?? 8));
  if (layout === 'octahedral' && !(grid >= 2 && grid <= 32)) throw new Error('impostor grid must be 2..32');
  if (layout === 'ring' && !(angles >= 2 && angles <= 64)) throw new Error('impostor angles must be 2..64');
  return { layout, size, grid, angles, pitch: Number(o.pitch ?? 0), full: !!o.full };
}

/** Cell directions of an impostor layout -> {cols, rows, cells:[{i, col, row, dir, yaw?, pitch?}]} */
export function impostorCells(o) {
  const cells = [];
  if (o.layout === 'octahedral') {
    for (let row = 0; row < o.grid; row++) for (let col = 0; col < o.grid; col++) {
      const u = ((col + 0.5) / o.grid) * 2 - 1, v = ((row + 0.5) / o.grid) * 2 - 1;
      cells.push({ i: cells.length, col, row, dir: octDecode(u, v, !o.full) });
    }
    return { cols: o.grid, rows: o.grid, cells };
  }
  const cols = Math.ceil(Math.sqrt(o.angles)), rows = Math.ceil(o.angles / cols);
  for (let k = 0; k < o.angles; k++) {
    const yaw = (360 * k) / o.angles, y = (yaw * Math.PI) / 180, p = (o.pitch * Math.PI) / 180;
    cells.push({ i: k, col: k % cols, row: Math.floor(k / cols), yaw, pitch: o.pitch, dir: [Math.sin(y) * Math.cos(p), Math.sin(p), Math.cos(y) * Math.cos(p)] });
  }
  return { cols, rows, cells };
}

/**
 * Bake an impostor atlas from world groups (px). -> {albedo, normal, depth: {width, height, data},
 * meta (cells, radius, centre, mapping)}. Albedo is unlit (ambient 1) with baked AO if the groups
 * carry it; normal = world normal * 0.5 + 0.5; depth = 255 nearest .. 0 farthest over the sphere.
 */
export function bakeImpostor(groups, opts) {
  const o = normImpostor(opts);
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const g of groups) for (let i = 0; i < g.pos.length; i += 3) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], g.pos[i + k]); max[k] = Math.max(max[k], g.pos[i + k]); }
  if (min[0] === Infinity) throw new Error('impostor: model has no triangles');
  const center = min.map((v, i) => (v + max[i]) / 2);
  let radius = 0;
  for (const g of groups) for (let i = 0; i < g.pos.length; i += 3) radius = Math.max(radius, Math.hypot(g.pos[i] - center[0], g.pos[i + 1] - center[1], g.pos[i + 2] - center[2]));
  radius = Math.max(radius, 1e-3);
  const { cols, rows, cells } = impostorCells(o);
  const S = o.size, W = cols * S, H = rows * S;
  const albedo = new Uint8ClampedArray(W * H * 4), normal = new Uint8ClampedArray(W * H * 4), depth = new Uint8ClampedArray(W * H * 4);
  const k = (S / 2 - 1) / radius;
  for (const c of cells) {
    const zc = c.dir, up = Math.abs(zc[1]) > 0.999 ? [0, 0, -1] : [0, 1, 0];
    const xc = norm(cross(up, zc)), yc = cross(zc, xc);
    const screen = groups.map((g) => {
      const n = g.pos.length / 3, sx = new Float32Array(n), sy = new Float32Array(n), Z = new Float32Array(n), Wv = new Float32Array(n).fill(1);
      for (let i = 0; i < n; i++) {
        const q = [g.pos[i * 3] - center[0], g.pos[i * 3 + 1] - center[1], g.pos[i * 3 + 2] - center[2]];
        sx[i] = S / 2 + dot(q, xc) * k; sy[i] = S / 2 - dot(q, yc) * k; Z[i] = dot(q, zc);
      }
      return { sx, sy, Z, W: Wv };
    });
    const aux = { normal: new Uint8ClampedArray(S * S * 4), depth: new Uint8ClampedArray(S * S * 4), zmin: -radius, zmax: radius };
    const img = rasterCore(groups, screen, S, S, { bg: null, ambient: 1, aux, view: zc });
    c.pixels = img.drawn;
    for (let y = 0; y < S; y++) {
      const d = ((c.row * S + y) * W + c.col * S) * 4, s = y * S * 4;
      albedo.set(img.data.subarray(s, s + S * 4), d); normal.set(aux.normal.subarray(s, s + S * 4), d); depth.set(aux.depth.subarray(s, s + S * 4), d);
    }
  }
  return {
    albedo: { width: W, height: H, data: albedo }, normal: { width: W, height: H, data: normal }, depth: { width: W, height: H, data: depth },
    meta: {
      layout: o.layout, ...(o.layout === 'octahedral' ? { grid: o.grid, hemi: !o.full } : { angles: o.angles, pitch: o.pitch }),
      cell_px: S, atlas_px: [W, H], cols, rows, center_px: center, radius_px: radius,
      cells: cells.map((c) => ({ i: c.i, rect: [c.col * S, c.row * S, S, S], dir: c.dir.map((v) => +v.toFixed(6)), ...(c.yaw !== undefined ? { yaw: c.yaw, pitch: c.pitch } : {}), pixels: c.pixels })),
    },
  };
}
