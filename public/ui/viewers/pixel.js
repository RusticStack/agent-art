// PixelView: a zoomable, pannable pixel canvas (checker, pixel grid, 3x3 tile preview, onion skin,
// change flash) with the user paint tools. Used by the canvas editor, snapshots and comparisons.
import { el, checker, clamp } from '../util.js';

const ZOOMS = [0.0625, 0.125, 0.25, 0.5, 1, 2, 3, 4, 5, 6, 8, 10, 12, 16, 20, 24, 32, 40, 48, 64];

function bresenham(x0, y0, x1, y1) {
  const pts = [];
  let dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  for (;;) {
    pts.push([x0, y0]);
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x0 += sx; }
    if (e2 <= dx) { err += dx; y0 += sy; }
  }
  return pts;
}

/** Tint a bitmap (onion skin ghosts) once per load. */
function tinted(bmp, color) {
  const c = new OffscreenCanvas(bmp.width, bmp.height);
  const x = c.getContext('2d');
  x.drawImage(bmp, 0, 0);
  x.globalCompositeOperation = 'source-atop';
  x.fillStyle = color;
  x.fillRect(0, 0, bmp.width, bmp.height);
  return c;
}

export class PixelView {
  /**
   * opts: editable, getTool() -> tool name, getColor() -> {hex8, hex}, onCommands(commands, label),
   * onPick(hex), onHover(text), onZoom(zoom)
   */
  constructor(host, opts = {}) {
    this.opts = opts;
    this.host = host;
    this.canvas = el('canvas.pixel-canvas', { tabindex: '0' });
    host.append(this.canvas);
    this.ctx = this.canvas.getContext('2d');
    this.strip = null; // full image (all frames)
    this.rect = null; // source rect of the shown frame
    this.zoom = 8;
    this.ox = 0; this.oy = 0;
    this.autoFit = true;
    this.grid = true;
    this.tile = false;
    this.onion = false;
    this.frameLines = null; // frame height to draw separators (strip view)
    this.flashRect = null;
    this.stroke = null;
    this.pixels = null;
    this.ghosts = null;
    this.space = false;
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(host);
    this.bind();
  }
  destroy() {
    this.ro.disconnect();
    this.canvas.remove();
  }

  /** strip: ImageBitmap; rect: {x,y,w,h} of the frame to show (default whole); frameLines: fh|null. */
  setImage(strip, { rect, frameLines = null, keepView = true, pixels = true } = {}) {
    const changedSize = !this.rect || !rect || this.rect.w !== rect.w || this.rect.h !== rect.h;
    this.strip = strip;
    this.rect = rect || { x: 0, y: 0, w: strip.width, h: strip.height };
    this.frameLines = frameLines;
    this.ghosts = null;
    if (pixels) {
      try {
        const c = new OffscreenCanvas(strip.width, strip.height);
        const x = c.getContext('2d', { willReadFrequently: true });
        x.drawImage(strip, 0, 0);
        this.pixels = x.getImageData(0, 0, strip.width, strip.height);
      } catch { this.pixels = null; }
    }
    if (this.autoFit || (changedSize && !keepView)) this.fit();
    this.render();
  }
  setFrameRect(rect) {
    this.rect = rect;
    this.render();
  }

  resize() {
    const r = this.host.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(r.width * dpr)), h = Math.max(1, Math.round(r.height * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w; this.canvas.height = h;
      this.canvas.style.width = r.width + 'px'; this.canvas.style.height = r.height + 'px';
    }
    if (this.autoFit) this.fit();
    this.render();
  }
  get cssW() { return this.canvas.width / (window.devicePixelRatio || 1); }
  get cssH() { return this.canvas.height / (window.devicePixelRatio || 1); }
  get tiles() { return this.tile ? 3 : 1; }

  fit() {
    if (!this.rect) return;
    const t = this.tiles, pad = 32;
    const z = Math.min((this.cssW - pad) / (this.rect.w * t), (this.cssH - pad) / (this.rect.h * t));
    let best = ZOOMS[0];
    for (const s of ZOOMS) if (s <= z) best = s;
    this.zoom = best;
    this.center();
    this.opts.onZoom?.(this.zoom);
  }
  center() {
    const t = this.tiles;
    this.ox = Math.round((this.cssW - this.rect.w * t * this.zoom) / 2);
    this.oy = Math.round((this.cssH - this.rect.h * t * this.zoom) / 2);
  }
  /** Step the zoom (d = +1 / -1) keeping the pixel under (cx, cy) in place. */
  zoomBy(d, cx = this.cssW / 2, cy = this.cssH / 2) {
    let i = ZOOMS.findIndex((z) => z >= this.zoom);
    if (i < 0) i = ZOOMS.length - 1;
    if (ZOOMS[i] !== this.zoom && d < 0) i++;
    const nz = ZOOMS[clamp(i + d, 0, ZOOMS.length - 1)];
    this.setZoom(nz, cx, cy);
  }
  setZoom(nz, cx = this.cssW / 2, cy = this.cssH / 2) {
    const k = nz / this.zoom;
    this.ox = Math.round(cx - (cx - this.ox) * k);
    this.oy = Math.round(cy - (cy - this.oy) * k);
    this.zoom = nz;
    this.autoFit = false;
    this.opts.onZoom?.(this.zoom);
    this.render();
  }

  /** Screen (client) point -> art pixel of the frame (wrapping in tile mode), or null. */
  pixelAt(e) {
    if (!this.rect) return null;
    const r = this.canvas.getBoundingClientRect();
    const gx = Math.floor((e.clientX - r.left - this.ox) / this.zoom), gy = Math.floor((e.clientY - r.top - this.oy) / this.zoom);
    const t = this.tiles, { w, h } = this.rect;
    if (gx < 0 || gy < 0 || gx >= w * t || gy >= h * t) return null;
    return [((gx % w) + w) % w, ((gy % h) + h) % h];
  }
  colorAt(x, y) {
    const d = this.pixels;
    if (!d) return null;
    const px = x + this.rect.x, py = y + this.rect.y;
    const p = (py * d.width + px) * 4;
    const hx = (v) => v.toString(16).padStart(2, '0');
    const a = d.data[p + 3];
    return { hex: `#${hx(d.data[p])}${hx(d.data[p + 1])}${hx(d.data[p + 2])}${a < 255 ? hx(a) : ''}`, a };
  }

  flash(rect) {
    this.flashRect = { ...rect, t: performance.now() };
    const tick = () => {
      if (!this.flashRect) return;
      this.render();
      if (performance.now() - this.flashRect.t < 1200) requestAnimationFrame(tick);
      else { this.flashRect = null; this.render(); }
    };
    requestAnimationFrame(tick);
  }

  render() {
    const ctx = this.ctx, dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, this.cssW, this.cssH);
    if (!this.strip || !this.rect) return;
    const z = this.zoom, t = this.tiles, { x: sx, y: sy, w, h } = this.rect;
    const W = w * z * t, H = h * z * t;
    // visible part only (big canvases at high zoom)
    const vx0 = Math.max(this.ox, 0), vy0 = Math.max(this.oy, 0);
    const vx1 = Math.min(this.ox + W, this.cssW), vy1 = Math.min(this.oy + H, this.cssH);
    if (vx1 <= vx0 || vy1 <= vy0) return;
    checker(ctx, vx0, vy0, vx1 - vx0, vy1 - vy0, clamp(Math.round(z / 2), 4, 12));
    ctx.imageSmoothingEnabled = z < 1;
    const ghosts = this.onion && this.opts.onionFrames?.();
    if (ghosts && !this.ghosts) this.ghosts = { prev: tinted(this.strip, 'rgba(229,72,77,1)'), next: tinted(this.strip, 'rgba(56,189,248,1)') };
    for (let ty = 0; ty < t; ty++) for (let tx = 0; tx < t; tx++) {
      const dx = this.ox + tx * w * z, dy = this.oy + ty * h * z;
      if (ghosts) {
        ctx.globalAlpha = 0.28;
        for (const [g, f] of [[this.ghosts.prev, ghosts.prev], [this.ghosts.next, ghosts.next]]) if (f !== null && f !== undefined) ctx.drawImage(g, sx, f * h, w, h, dx, dy, w * z, h * z);
        ctx.globalAlpha = 1;
      }
      ctx.drawImage(this.strip, sx, sy, w, h, dx, dy, w * z, h * z);
    }
    if (this.grid && z >= 6) {
      const pw = w * t, ph = h * t;
      const i0 = Math.max(0, Math.floor((vx0 - this.ox) / z)), i1 = Math.min(pw, Math.ceil((vx1 - this.ox) / z));
      const j0 = Math.max(0, Math.floor((vy0 - this.oy) / z)), j1 = Math.min(ph, Math.ceil((vy1 - this.oy) / z));
      for (let i = i0; i <= i1; i++) { ctx.fillStyle = i % 8 === 0 ? 'rgba(0,0,0,.4)' : i % 4 === 0 ? 'rgba(0,0,0,.28)' : 'rgba(0,0,0,.12)'; ctx.fillRect(this.ox + i * z, vy0, 1, vy1 - vy0); }
      for (let j = j0; j <= j1; j++) { ctx.fillStyle = j % 8 === 0 ? 'rgba(0,0,0,.4)' : j % 4 === 0 ? 'rgba(0,0,0,.28)' : 'rgba(0,0,0,.12)'; ctx.fillRect(vx0, this.oy + j * z, vx1 - vx0, 1); }
    }
    if (this.frameLines && this.frameLines < h) {
      ctx.fillStyle = 'rgba(245,165,36,.85)';
      for (let ty = 0; ty < t; ty++) for (let f = 1; f < h / this.frameLines; f++) ctx.fillRect(this.ox, this.oy + (ty * h + f * this.frameLines) * z - 1, W, 2);
    }
    if (t > 1) {
      ctx.strokeStyle = 'rgba(245,165,36,.9)';
      ctx.lineWidth = 2;
      ctx.strokeRect(this.ox + w * z + 1, this.oy + h * z + 1, w * z - 2, h * z - 2);
    }
    const ox = this.ox + (t > 1 ? w * z : 0), oy = this.oy + (t > 1 ? h * z : 0);
    const s = this.stroke;
    if (s) {
      ctx.fillStyle = s.erase ? 'rgba(255,255,255,.55)' : s.color;
      for (const [px, py] of s.preview()) for (let ty = 0; ty < t; ty++) for (let tx = 0; tx < t; tx++) ctx.fillRect(this.ox + (px + tx * w) * z, this.oy + (py + ty * h) * z, Math.max(1, z), Math.max(1, z));
    }
    // review marks on this frame, and the box being dragged
    const marks = this.opts.marks?.() || [];
    if (this.box) marks.push({ region: [Math.min(this.box.start[0], this.box.end[0]), Math.min(this.box.start[1], this.box.end[1]), Math.abs(this.box.end[0] - this.box.start[0]) + 1, Math.abs(this.box.end[1] - this.box.start[1]) + 1], live: true });
    for (const m of marks) {
      const [mx, my, mw, mh] = m.region;
      ctx.strokeStyle = m.live ? '#f5a524' : m.status === 'fixed' ? '#22c55e' : '#f5a524';
      ctx.lineWidth = 2;
      ctx.setLineDash(m.live ? [4, 3] : []);
      if (mw === 1 && mh === 1 && !m.live) {
        ctx.beginPath(); ctx.arc(ox + (mx + 0.5) * z, oy + (my + 0.5) * z, Math.max(5, z * 0.6), 0, Math.PI * 2); ctx.stroke();
      } else ctx.strokeRect(ox + mx * z - 1, oy + my * z - 1, mw * z + 2, mh * z + 2);
      ctx.setLineDash([]);
      if (m.id) { ctx.fillStyle = '#f5a524'; ctx.font = 'bold 11px system-ui'; const tw = ctx.measureText(m.id).width + 6; ctx.fillRect(ox + mx * z - 1, oy + my * z - 15, tw, 14); ctx.fillStyle = '#111'; ctx.fillText(m.id, ox + mx * z + 2, oy + my * z - 4); }
    }
    const f = this.flashRect;
    if (f) {
      const age = (performance.now() - f.t) / 1200;
      if (age < 1) {
        ctx.strokeStyle = `rgba(56,189,248,${1 - age})`;
        ctx.lineWidth = 2;
        ctx.strokeRect(ox + f.x * z - 1, oy + f.y * z - 1, f.w * z + 2, f.h * z + 2);
      }
    }
    this.opts.afterRender?.(ctx, { ox, oy, z, w, h });
  }

  bind() {
    const c = this.canvas;
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      const r = c.getBoundingClientRect();
      if (e.shiftKey && !e.ctrlKey) { this.ox -= e.deltaY; this.autoFit = false; this.render(); return; }
      this.zoomBy(e.deltaY < 0 ? 1 : -1, e.clientX - r.left, e.clientY - r.top);
    }, { passive: false });
    let pan = null;
    c.addEventListener('pointerdown', (e) => {
      c.focus({ preventScroll: true });
      const tool = this.opts.getTool?.() || 'hand';
      if (tool === 'review' && e.button === 0) {
        const p = this.pixelAt(e);
        if (!p) return;
        c.setPointerCapture(e.pointerId);
        this.box = { start: p, end: p };
        this.render();
        return;
      }
      if (e.button === 1 || e.button === 2 || this.space || tool === 'hand' || !this.opts.editable) {
        if (e.button === 0 && !this.opts.editable && tool === 'picker') { /* fall through to pick */ } else {
          pan = { x: e.clientX, y: e.clientY, ox: this.ox, oy: this.oy };
          c.setPointerCapture(e.pointerId);
          c.classList.add('panning');
          e.preventDefault();
          return;
        }
      }
      if (e.button !== 0) return;
      const p = this.pixelAt(e);
      if (!p) return;
      c.setPointerCapture(e.pointerId);
      if (tool === 'picker') { const col = this.colorAt(...p); if (col && col.a) this.opts.onPick?.(col.hex); return; }
      const { hex8, hex } = this.opts.getColor();
      if (tool === 'fill') { this.opts.onCommands?.([{ op: 'fill', x: p[0], y: p[1], color: hex8 }], 'user fill'); return; }
      const color = tool === 'eraser' ? 'transparent' : hex8;
      if (tool === 'pencil' || tool === 'eraser') {
        const pts = new Map([[p.join(','), p]]);
        this.stroke = { tool, color: hex, erase: tool === 'eraser', last: p, pts, preview: () => pts.values(), send: () => [{ op: 'pixels', color, points: [...pts.values()] }] };
      } else {
        const st = { tool, color: hex, start: p, end: p, filled: e.shiftKey };
        st.preview = () => {
          if (tool === 'line') return bresenham(...st.start, ...st.end);
          const [x0, x1] = [Math.min(st.start[0], st.end[0]), Math.max(st.start[0], st.end[0])];
          const [y0, y1] = [Math.min(st.start[1], st.end[1]), Math.max(st.start[1], st.end[1])];
          const out = [];
          for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (st.filled || x === x0 || x === x1 || y === y0 || y === y1) out.push([x, y]);
          return out;
        };
        st.send = () => {
          if (tool === 'line') return [{ op: 'line', x1: st.start[0], y1: st.start[1], x2: st.end[0], y2: st.end[1], color }];
          const x = Math.min(st.start[0], st.end[0]), y = Math.min(st.start[1], st.end[1]);
          return [{ op: 'rect', x, y, w: Math.abs(st.end[0] - st.start[0]) + 1, h: Math.abs(st.end[1] - st.start[1]) + 1, ...(st.filled ? { color } : { fill: false, color }) }];
        };
        this.stroke = st;
      }
      this.render();
    });
    c.addEventListener('pointermove', (e) => {
      if (pan) {
        this.ox = pan.ox + e.clientX - pan.x; this.oy = pan.oy + e.clientY - pan.y;
        this.autoFit = false;
        this.render();
        return;
      }
      const p = this.pixelAt(e);
      if (p) {
        const col = this.colorAt(...p);
        this.opts.onHover?.(p, col);
      }
      if (this.box && p) { this.box.end = p; this.render(); return; }
      const s = this.stroke;
      if (!s || !p) return;
      if (s.pts) { for (const q of bresenham(...s.last, ...p)) s.pts.set(q.join(','), q); s.last = p; } else s.end = p;
      this.render();
    });
    c.addEventListener('pointerleave', () => this.opts.onHover?.(null));
    const up = async () => {
      if (pan) { pan = null; c.classList.remove('panning'); return; }
      if (this.box) {
        const b = this.box;
        this.box = null;
        const x = Math.min(b.start[0], b.end[0]), y = Math.min(b.start[1], b.end[1]);
        const w = Math.abs(b.end[0] - b.start[0]) + 1, h = Math.abs(b.end[1] - b.start[1]) + 1;
        this.render();
        this.opts.onReview?.(w === 1 && h === 1 ? { point: [x, y] } : { region: [x, y, w, h] });
        return;
      }
      const s = this.stroke;
      if (!s) return;
      try { await this.opts.onCommands?.(s.send(), `user ${s.tool}`); } finally { this.stroke = null; this.render(); }
    };
    c.addEventListener('pointerup', up);
    c.addEventListener('pointercancel', () => { pan = null; this.stroke = null; this.render(); });
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    c.addEventListener('dblclick', () => { this.autoFit = true; this.fit(); this.render(); });
    window.addEventListener('keydown', (e) => { if (e.code === 'Space' && document.activeElement === c) { this.space = true; e.preventDefault(); } });
    window.addEventListener('keyup', (e) => { if (e.code === 'Space') this.space = false; });
  }
}
