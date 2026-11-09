// Checkerboard behind transparent pixels.
export interface CheckerColors { a: string; b: string }
let colors: CheckerColors = { a: '#3a3d44', b: '#2c2f35' };
/** Viewers call this once with the theme's --checker-a / --checker-b. */
export function setCheckerColors(c: CheckerColors) { colors = c; }

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export function checker(ctx: Ctx2D, x: number, y: number, w: number, h: number, cell = 8): void {
  ctx.fillStyle = colors.a;
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = colors.b;
  const x0 = Math.floor(x / cell), y0 = Math.floor(y / cell);
  for (let j = y0; j * cell < y + h; j++) {
    for (let i = x0 + ((x0 + j) & 1); i * cell < x + w; i += 2) {
      const px = Math.max(x, i * cell), py = Math.max(y, j * cell);
      ctx.fillRect(px, py, Math.min(x + w, i * cell + cell) - px, Math.min(y + h, j * cell + cell) - py);
    }
  }
}
