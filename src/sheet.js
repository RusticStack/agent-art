// Contact sheets: lay out many images in a labelled grid (project review, animation filmstrips).
import { FONT, FONT_H, textWidth, MAX_PIXELS } from './doc.js';
import { blendOver } from './color.js';

/** Nearest-neighbour resize of an RGBA image to fit inside boxW x boxH (keeps aspect). */
function fitImage(img, boxW, boxH = boxW) {
  if (img.width <= boxW && img.height <= boxH) return img;
  const f = Math.min(boxW / img.width, boxH / img.height);
  const w = Math.max(1, Math.round(img.width * f)), h = Math.max(1, Math.round(img.height * f));
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const sx = Math.min(img.width - 1, Math.floor(x / f)), sy = Math.min(img.height - 1, Math.floor(y / f));
    out.set(img.data.subarray((sy * img.width + sx) * 4, (sy * img.width + sx) * 4 + 4), (y * w + x) * 4);
  }
  return { width: w, height: h, data: out };
}

function drawText(put, text, x, y, color) {
  for (const ch of String(text).toUpperCase()) {
    const g = FONT[ch] || FONT['?'];
    for (let gy = 0; gy < FONT_H; gy++) for (let gx = 0; gx < g[gy].length; gx++) if (g[gy][gx] === '1') put(x + gx, y + gy, color);
    x += g[0].length + 1;
  }
}

/**
 * Pack images into a grid. items: [{ img: {width,height,data}, label?, sub? }].
 * Each cell is `cell` px square, or (no cell) as wide/tall as the largest image, so wide frames
 * do not get a tall empty box with the label far below. Larger images are scaled down to fit.
 */
/**
 * Layout of a packImages sheet without rendering it: n items of boxW x boxH, `lines` label lines
 * (0, 1 = label, 2 = label + sub). -> {W, H, cols, rows, cellW, cellH, labelH, fits (<= MAX_PIXELS)}
 */
export function packSize(n, boxW, boxH, { columns, labels = true, lines = labels ? 1 : 0, padding = 6 } = {}) {
  const cols = columns ?? Math.max(1, Math.min(n, Math.ceil(Math.sqrt(n * 1.6))));
  const rows = Math.ceil(n / cols);
  const labelH = labels && lines ? lines * (FONT_H + 2) + 3 : 0;
  const cellW = Math.max(boxW, labels ? 40 : 1), cellH = boxH + labelH;
  const W = cols * (cellW + padding) + padding, H = rows * (cellH + padding) + padding;
  return { W, H, cols, rows, cellW, cellH, labelH, fits: W * H <= MAX_PIXELS };
}
export function packImages(items, { cell, columns, labels = true, padding = 6, checker = true } = {}) {
  if (!items.length) throw new Error('Nothing to put on the sheet');
  const boxW = cell ?? Math.max(...items.map((i) => i.img.width));
  const boxH = cell ?? Math.max(...items.map((i) => i.img.height));
  const lines = labels ? Math.max(...items.map((i) => (i.sub ? 2 : i.label ? 1 : 0))) : 0;
  const { W, H, cols, cellW, cellH, labelH, fits } = packSize(items.length, boxW, boxH, { columns, labels, lines, padding });
  if (!fits) throw new Error(`Sheet would be ${W}x${H}; lower scale/cell or use limit/offset paging`);
  const out = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < out.length; i += 4) out.set([32, 35, 42, 255], i);
  const put = (x, y, c) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const o = (y * W + x) * 4;
    out.set(blendOver([out[o], out[o + 1], out[o + 2], out[o + 3]], c), o);
  };
  items.forEach((it, i) => {
    const cx = padding + (i % cols) * (cellW + padding), cy = padding + Math.floor(i / cols) * (cellH + padding);
    const img = fitImage(it.img, boxW, boxH);
    const ox = cx + Math.floor((cellW - img.width) / 2), oy = cy + Math.floor((boxH - img.height) / 2);
    for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) {
      const p = (y * img.width + x) * 4;
      const c = [img.data[p], img.data[p + 1], img.data[p + 2], img.data[p + 3]];
      const bg = checker ? (((x >> 2) + (y >> 2)) & 1 ? [56, 60, 68, 255] : [72, 76, 86, 255]) : [32, 35, 42, 255];
      put(ox + x, oy + y, blendOver(bg, c));
    }
    if (labels) {
      [it.label, it.sub].forEach((t, k) => {
        if (!t) return;
        let s = String(t).toUpperCase();
        while (s.length > 1 && textWidth(s) > cellW) s = s.slice(0, -1);
        drawText(put, s, cx + Math.max(0, Math.floor((cellW - textWidth(s)) / 2)), cy + boxH + 3 + k * (FONT_H + 2), k ? [140, 148, 160, 255] : [205, 210, 220, 255]);
      });
    }
  });
  return { width: W, height: H, data: out, columns: cols, cell: boxW === boxH ? boxW : [boxW, boxH] };
}

/**
 * Render canvases as a sheet. Cell size follows the most common canvas size (so one large
 * canvas does not shrink everything); larger canvases are scaled down to fit their cell.
 */
export function renderSheet(docs, { scale, columns, labels = true, tile = 1, tints = new Map(), cell, subs = new Map() } = {}) {
  if (!docs.length) throw new Error('No canvases to put on the sheet');
  const dim = (d) => Math.max(d.width, d.frameHeight || d.height) * tile;
  const counts = new Map();
  for (const d of docs) counts.set(dim(d), (counts.get(dim(d)) || 0) + 1);
  const common = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0];
  scale = scale ?? Math.max(1, Math.min(8, Math.floor(96 / common)));
  // mixed sizes: give larger canvases room (up to 2x the common size, max 128px) instead of
  // shrinking them to the common cell where they become unreadable
  const biggest = Math.max(...docs.map(dim));
  let cellPx = cell ?? Math.max(common * scale, Math.min(biggest * scale, 2 * common * scale, Math.max(128, common * scale)));
  const build = () => {
    const items = docs.map((d) => {
      // every canvas fills its cell as well as it can: small ones are upscaled, big ones shrunk
      const s = Math.max(1, Math.floor(cellPx / dim(d)));
      return { img: d.render({ scale: s, tile, frame: d.frameHeight ? 0 : undefined, tint: tints.get(d.name) }), label: labels ? d.name : null, sub: labels ? subs.get(d.name) : null };
    });
    return packImages(items, { cell: cellPx, columns, labels });
  };
  for (;;) {
    try {
      const r = build();
      return { ...r, scale };
    } catch (e) {
      // too big: shrink the upscale first, then the cells (larger canvases get downscaled)
      if (!/Sheet would be/.test(e.message)) throw e;
      if (scale > 1) {
        scale--;
        cellPx = Math.min(cellPx, common * scale);
      } else {
        if (cellPx <= 16) throw e;
        cellPx = Math.max(16, Math.floor(cellPx * 0.75));
      }
    }
  }
}
