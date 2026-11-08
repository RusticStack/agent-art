// Sprite sheet preview: every frame laid out like the spritesheet export (one row per animation
// tag), with frame numbers, durations and per-frame anchors (rig part pivots / model sockets).
// Also draws exported sheet PNG + Aseprite-style JSON (frame rects and anchors) from exports/.
import { el, enc, getJSON, loadBitmap, checker } from '../util.js';

const ANCHOR_COLORS = ['#f5a524', '#38bdf8', '#22c55e', '#e5484d', '#a78bfa', '#2dd4bf', '#f472b6', '#facc15'];

/** Draw cells [{sx,sy,w,h,dx,dy,label,sub,anchors:{name:[x,y,rot]}}] from img at scale onto canvas. */
export function drawSheet(canvas, img, cells, { scale = 2, showAnchors = true, labels = true } = {}) {
  let W = 0, H = 0;
  for (const c of cells) { W = Math.max(W, c.dx + c.w * scale); H = Math.max(H, c.dy + c.h * scale + (labels ? 14 : 0)); }
  canvas.width = Math.max(1, W); canvas.height = Math.max(1, H);
  const cx = canvas.getContext('2d');
  cx.fillStyle = '#16181d'; cx.fillRect(0, 0, W, H);
  cx.imageSmoothingEnabled = false;
  const names = new Map();
  for (const c of cells) {
    checker(cx, c.dx, c.dy, c.w * scale, c.h * scale, Math.max(4, scale * 2));
    cx.drawImage(img, c.sx, c.sy, c.w, c.h, c.dx, c.dy, c.w * scale, c.h * scale);
    cx.strokeStyle = 'rgba(255,255,255,.12)';
    cx.strokeRect(c.dx + 0.5, c.dy + 0.5, c.w * scale - 1, c.h * scale - 1);
    if (labels) {
      cx.fillStyle = '#9aa3b2'; cx.font = '10px ui-monospace, monospace';
      cx.fillText(`${c.label}${c.sub ? ' · ' + c.sub : ''}`, c.dx + 1, c.dy + c.h * scale + 11);
    }
    if (showAnchors && c.anchors) for (const [n, a] of Object.entries(c.anchors)) {
      if (!names.has(n)) names.set(n, ANCHOR_COLORS[names.size % ANCHOR_COLORS.length]);
      const col = names.get(n);
      const x = c.dx + (a[0] + 0.5) * scale, y = c.dy + (a[1] + 0.5) * scale;
      cx.strokeStyle = col; cx.lineWidth = 1;
      cx.beginPath(); cx.moveTo(x - 3, y); cx.lineTo(x + 3, y); cx.moveTo(x, y - 3); cx.lineTo(x, y + 3); cx.stroke();
      if (a[2]) { const r = (a[2] * Math.PI) / 180; cx.beginPath(); cx.moveTo(x, y); cx.lineTo(x + Math.cos(r) * 8, y + Math.sin(r) * 8); cx.stroke(); }
    }
  }
  return names;
}

export class SheetViewer {
  constructor(host, ctx) {
    this.ctx = ctx;
    this.root = el('div.viewer.sheet-viewer');
    host.append(this.root);
    this.anchorsCb = el('input', { type: 'checkbox', checked: true, on: { change: () => this.draw() } });
    this.labelsCb = el('input', { type: 'checkbox', checked: true, on: { change: () => this.draw() } });
    this.scaleIn = el('input', { type: 'range', min: 1, max: 12, value: 0, on: { input: () => { this.userScale = Number(this.scaleIn.value); this.draw(); } } });
    this.legend = el('div.legend');
    this.root.append(el('div.vtoolbar', {},
      el('div.group', {}, el('label.toggle', {}, this.anchorsCb, ' Anchors'), el('label.toggle', {}, this.labelsCb, ' Labels')),
      el('div.group', {}, el('span.muted', { text: 'Scale' }), this.scaleIn), el('div.spacer'), this.legend));
    this.scroll = el('div.sheet-scroll');
    this.canvas = el('canvas.sheet-canvas');
    this.scroll.append(this.canvas);
    this.root.append(this.scroll);
    this.status = el('div.vstatus.mono');
    this.root.append(this.status);
  }
  async open(target) {
    this.target = target;
    if (target.kind === 'export') {
      // exported sheet: png + sidecar json (frames{}, meta.frameTags)
      const png = target.name.replace(/\.json$/i, '.png'), json = target.name.replace(/\.png$/i, '.json');
      this.img = await loadBitmap(`/api/export-file?path=${enc(png)}`);
      const j = await getJSON(`/api/export-file?path=${enc(json)}`).catch(() => null);
      const frames = j?.frames ? Object.entries(j.frames).map(([k, f]) => ({ ...f.frame, label: k, sub: f.duration ? `${f.duration}ms` : '', anchors: f.anchors ? Object.fromEntries(Object.entries(f.anchors).map(([n, a]) => [n, [a.x, a.y, a.rot]])) : null })) : [{ x: 0, y: 0, w: this.img.width, h: this.img.height, label: png }];
      this.cellsSrc = frames;
      this.status.textContent = `${png} · ${this.img.width}×${this.img.height}${j ? ` · ${frames.length} frames · ${j.meta?.frameTags?.length || 0} tags` : ' · no json sidecar'}`;
    } else {
      this.info = await getJSON(`/api/canvas/${enc(target.name)}`);
      this.img = await loadBitmap(`/api/canvas/${enc(target.name)}/png?t=${Date.now()}`);
      const fh = this.info.frameHeight || this.img.height, w = this.img.width;
      const tags = Object.entries(this.info.animations || {});
      const anchors = this.info.meta?.anchors || {};
      this.cellsSrc = [];
      const rows = tags.length ? tags.map(([n, t]) => ({ n, frames: t.frames, durations: t.durations })) : [{ n: null, frames: [...Array(this.info.frames).keys()], durations: [] }];
      rows.forEach((r, ri) => r.frames.forEach((f, ci) => this.cellsSrc.push({ x: 0, y: f * fh, w, h: fh, row: ri, col: ci, label: `${r.n ? r.n + ' ' : ''}#${f}`, sub: r.durations[ci] ? `${r.durations[ci]}ms` : '', anchors: r.n ? anchors[r.n]?.[ci] : null })));
      this.status.textContent = `${target.name} · ${rows.length} row(s) · ${this.cellsSrc.length} cells · anchors: ${Object.keys(anchors).join(', ') || 'none'}`;
    }
    this.draw();
  }
  draw() {
    if (!this.img) return;
    const src = this.cellsSrc;
    const maxW = Math.max(...src.map((c) => c.w)), maxH = Math.max(...src.map((c) => c.h));
    const box = this.scroll.getBoundingClientRect();
    const cols = Math.max(1, ...src.map((c) => (c.col ?? 0) + 1));
    const auto = Math.max(1, Math.min(8, Math.floor((box.width - 40) / Math.max(1, (src[0]?.col !== undefined ? cols : Math.min(src.length, 8)) * (maxW + 4)))));
    const s = this.userScale || auto;
    this.scaleIn.value = s;
    const gap = 6, lab = this.labelsCb.checked ? 14 : 0;
    let cells;
    if (src[0]?.col !== undefined) cells = src.map((c) => ({ sx: c.x, sy: c.y, w: c.w, h: c.h, dx: gap + c.col * (maxW * s + gap), dy: gap + c.row * (maxH * s + gap + lab), label: c.label, sub: c.sub, anchors: c.anchors }));
    else if (this.target.kind === 'export') cells = src.map((c) => ({ sx: c.x, sy: c.y, w: c.w, h: c.h, dx: gap + c.x * s + Math.floor(c.x / Math.max(1, c.w)) * gap, dy: gap + c.y * s + Math.floor(c.y / Math.max(1, c.h)) * (gap + lab), label: c.label.replace(/^.*?_(\w+_\d+)$/, '$1'), sub: c.sub, anchors: c.anchors }));
    const names = drawSheet(this.canvas, this.img, cells, { scale: s, showAnchors: this.anchorsCb.checked, labels: !!lab });
    this.legend.innerHTML = '';
    for (const [n, col] of names) this.legend.append(el('span.legend-item', {}, el('i', { style: { background: col } }), n));
  }
  onEvent(ev) {
    if (this.target?.kind !== 'export' && ev.type === 'change' && ev.canvas === this.target?.name) { clearTimeout(this.rt); this.rt = setTimeout(() => this.open(this.target), 150); }
  }
  keydown() { return false; }
  destroy() { clearTimeout(this.rt); this.root.remove(); }
}
