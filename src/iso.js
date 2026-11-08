// Isometric (2:1 pixel-art projection) shape commands.
import { int } from './util.js';
import { adjustColor } from './color.js';

/**
 * Screen position of an iso grid cell. Tile `tile` px wide (tile/2 tall). origin = screen
 * position of the top vertex of cell (0,0) at ground level. gz lifts by pixels.
 */
export function isoToScreen(gx, gy, gz, tile, origin) {
  return [origin[0] + ((gx - gy) * tile) / 2, origin[1] + ((gx + gy) * tile) / 4 - gz];
}

function boxGeometry(a) {
  let left, right;
  if (a.size_left !== undefined || a.size_right !== undefined) {
    left = int(a.size_left ?? a.size_right, 'size_left');
    right = int(a.size_right ?? a.size_left, 'size_right');
  } else {
    const w = int(a.w ?? a.tile ?? 32, 'w');
    const tx = Number(a.tiles_x ?? a.tiles ?? 1), ty = Number(a.tiles_y ?? a.tiles ?? 1);
    right = Math.round((w / 2) * tx); // extent along the down-right axis
    left = Math.round((w / 2) * ty); // extent along the down-left axis
  }
  if (left < 2 || right < 2) throw new Error('iso footprint too small');
  return { left, right };
}

function drawBox(ctx, a, height) {
  let { left: L, right: R } = boxGeometry(a);
  const h = Math.max(0, int(height, 'height'));
  // inset: shrink the footprint by N px on every side, keeping its centre (gaps between floor tiles)
  const inset = Math.max(0, int(a.inset ?? a.gap ?? 0, 'inset'));
  if (inset && (L - 2 * inset < 2 || R - 2 * inset < 2)) throw new Error('inset too large for this footprint');
  const anchor = a.anchor || 'top';
  if (!['top', 'center'].includes(anchor)) throw new Error('anchor must be "top" (grid cell top vertex) or "center" (centre the footprint on the cell)');
  let x0, y0;
  if (a.at) {
    if (!Array.isArray(a.at) || a.at.length < 2 || a.at.some((v) => !Number.isFinite(Number(v)))) throw new Error('"at" must be [gx, gy] or [gx, gy, gz] (fractions allowed)');
    const tile = int(a.tile ?? a.w ?? 32, 'tile');
    const [sx, sy] = isoToScreen(Number(a.at[0]), Number(a.at[1]), Number(a.at[2] ?? 0), tile, a.origin || [Math.floor(ctx.w / 2), 0]);
    if (anchor === 'center') {
      // footprint centre = top vertex + ((R-L)/2, (L+R)/4) -> put it on the cell centre (sx, sy + tile/4)
      x0 = Math.round(sx - (R - L) / 2 - L);
      y0 = Math.round(sy + tile / 4 - (L + R) / 4 - h);
    } else {
      x0 = Math.round(sx - L);
      y0 = Math.round(sy - h);
    }
  } else {
    x0 = int(a.x ?? 0, 'x');
    y0 = int(a.y ?? 0, 'y');
  }
  if (inset) {
    x0 += 2 * inset;
    y0 += inset;
    L -= 2 * inset;
    R -= 2 * inset;
  }
  const W = L + R, topH = Math.floor((L + R) / 2);
  const ytop = (x) => (x < L ? Math.floor((L - 1 - x) / 2) : Math.floor((x - L) / 2));
  const ybot = (x) => (x < R ? Math.floor(L / 2) + Math.floor(x / 2) : Math.floor(R / 2) + Math.floor((L + R - 1 - x) / 2));
  // label map: 1 top, 2 left face, 3 right face
  const H = topH + h + 1;
  const lab = new Uint8Array(W * H);
  for (let x = 0; x < W; x++) {
    const t = ytop(x), b = ybot(x);
    for (let y = t; y <= b && y < H; y++) lab[y * W + x] = 1;
    for (let y = b + 1; y <= b + h && y < H; y++) lab[y * W + x] = x < R ? 2 : 3;
  }
  const top = ctx.color(a.top ?? a.color ?? '#9ab'), base = top;
  const leftC = a.left !== undefined ? ctx.color(a.left) : adjustColor(base, { lightness: -0.12 });
  const rightC = a.right !== undefined ? ctx.color(a.right) : adjustColor(base, { lightness: -0.24 });
  const outline = a.outline !== undefined ? ctx.color(a.outline) : null;
  const edge = a.edge !== undefined ? ctx.color(a.edge) : null;
  const L4 = (x, y) => (x < 0 || y < 0 || x >= W || y >= H ? 0 : lab[y * W + x]);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const l = lab[y * W + x];
    if (!l) continue;
    let c = l === 1 ? top : l === 2 ? leftC : rightC;
    const border = !L4(x - 1, y) || !L4(x + 1, y) || !L4(x, y - 1) || !L4(x, y + 1);
    if (outline && border) c = outline;
    else if (edge && l === 1 && (L4(x, y + 1) > 1 || L4(x - 1, y) > 1 || L4(x + 1, y) > 1)) c = edge;
    else if (edge && l === 2 && L4(x + 1, y) === 3 && a.corner !== false) c = edge; // vertical front corner
    ctx.set(x0 + x, y0 + y, c);
  }
  return { x: x0, y: y0, w: W, h: H };
}

export const ISO = {
  /** Flat 2:1 diamond tile (floor). Position with x,y (bounding box) or at:[gx,gy,gz] + tile + origin. */
  iso_tile(ctx, a) {
    const r = drawBox(ctx, { ...a, top: a.color ?? a.top }, 0);
    return `tile at ${r.x},${r.y} ${r.w}x${r.h}`;
  },
  /** Isometric box/prism: top face + left/right faces (auto-shaded), optional outline and edge highlight. */
  iso_box(ctx, a) {
    const r = drawBox(ctx, a, a.height ?? 16);
    return `box at ${r.x},${r.y} ${r.w}x${r.h}`;
  },
};

/** Fields the iso helpers read (for unknown-field warnings). */
export const ISO_FIELDS = [...new Set([...String(boxGeometry).concat(String(drawBox)).matchAll(/(?<![\w$.])a\.(\w+)/g)].map((m) => m[1]))];
