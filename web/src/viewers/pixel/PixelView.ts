// PixelView: a zoomable, pannable pixel canvas (checker, pixel grid, 3x3 tile preview, onion skin,
// change flash, review marks) with the user paint tools, plus the compare overlay (diff / swipe / blink).
// Used by the canvas editor, snapshots, comparisons, rig parts and export PNGs.
import type { Rect, ReviewMark } from '@/lib/api/types';
import type { DrawCommand } from '@/lib/api/client';
import { checker } from '@/lib/util/checker';
import { clamp } from '@/lib/util/format';
import { watchDpr } from '../base';
import type { Tool } from '../types';
import { diffMask } from './diff';
import { bresenham, extendStroke, fitZoom, rectPoints, reviewPick, shapeCommand, snapZoom, stepZoom, strokeCommand, type Pt } from './tools';

export type OverlayMode = 'diff' | 'swipe' | 'blink';
export interface Overlay { image: ImageBitmap; rect: Rect; mode: OverlayMode; split?: number }
export interface ViewState { zoom: number; cx: number; cy: number }

export interface PixelViewOptions {
  editable?: boolean;
  getTool?(): Tool | 'review';
  getColor?(): { hex: string; hex8: string };
  onCommands?(commands: DrawCommand[], label: string): void | Promise<void>;
  onPick?(hex: string): void;
  onHover?(p: [number, number] | null, color?: { hex: string; a: number } | null): void;
  onZoom?(zoom: number): void;
  onionFrames?(): { prev: number | null; next: number | null } | null;
  onReview?(r: { point: [number, number] } | { region: [number, number, number, number] }): void;
  marks?(): ReviewMark[];
  afterRender?(ctx: CanvasRenderingContext2D, view: { ox: number; oy: number; z: number; w: number; h: number }): void;
  /** After a user zoom / pan / fit; never from setView. */
  onView?(v: ViewState): void;
  /** Overlay state changed (diff counts, blink side): the owner refreshes its status line. */
  onOverlay?(): void;
}

type Stroke =
  | { kind: 'free'; tool: 'pencil' | 'eraser'; color: string; send: string; erase: boolean; last: Pt; pts: Map<string, Pt> }
  | { kind: 'shape'; tool: 'line' | 'rect'; color: string; send: string; start: Pt; end: Pt; filled: boolean };

const MAX_SAMPLE_PX = 64_000_000;
const MAX_DIFF_PX = 16_000_000;
const SPLIT_GRAB = 12;
const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const hasOffscreen = () => typeof OffscreenCanvas !== 'undefined';

/** Tint a bitmap (onion skin ghosts) once per image. */
function tinted(bmp: CanvasImageSource & { width: number; height: number }, color: string): OffscreenCanvas | null {
  if (!hasOffscreen()) return null;
  const c = new OffscreenCanvas(bmp.width, bmp.height);
  const x = c.getContext('2d');
  if (!x) return null;
  x.drawImage(bmp, 0, 0);
  x.globalCompositeOperation = 'source-atop';
  x.fillStyle = color;
  x.fillRect(0, 0, bmp.width, bmp.height);
  return c;
}

export class PixelView {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private host: HTMLElement;
  private opts: PixelViewOptions;
  private abort = new AbortController();
  private ro: ResizeObserver | null = null;
  private stopDpr: () => void;
  private strip: ImageBitmap | null = null;
  rect: Rect | null = null;
  zoom = 8;
  ox = 0;
  oy = 0;
  autoFit = true;
  grid = true;
  tile = false;
  onion = false;
  private frameLines: number | null = null;
  private flashRect: (Rect & { t: number }) | null = null;
  private stroke: Stroke | null = null;
  private box: { start: Pt; end: Pt } | null = null;
  private sampler: OffscreenCanvasRenderingContext2D | null = null;
  private ghosts: { prev: OffscreenCanvas | null; next: OffscreenCanvas | null } | null = null;
  private space = false;
  private pan: { x: number; y: number; ox: number; oy: number } | null = null;
  private pointers = new Map<number, { x: number; y: number }>();
  private pinch: { d: number; mx: number; my: number; zoom: number; ox: number; oy: number } | null = null;
  private rafId = 0;
  private flashRaf = 0;
  private dead = false;
  // compare overlay
  private overlay: Overlay | null = null;
  private diffCache: { key: object; canvas: OffscreenCanvas | null; info: { changed: number; total: number; bbox: Rect | null; tooLarge?: boolean } } | null = null;
  private blinkTimer: ReturnType<typeof setInterval> | null = null;
  private blinkShowOverlay = false;
  private splitDrag = false;

  constructor(host: HTMLElement, opts: PixelViewOptions = {}) {
    this.host = host;
    this.opts = opts;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'pixel-canvas';
    this.canvas.tabIndex = 0;
    this.canvas.setAttribute('role', 'img');
    host.append(this.canvas);
    this.ctx = this.canvas.getContext('2d') as CanvasRenderingContext2D;
    if (typeof ResizeObserver !== 'undefined') {
      this.ro = new ResizeObserver(() => this.resize());
      this.ro.observe(host);
    }
    this.stopDpr = watchDpr(() => this.resize());
    this.bind();
  }

  destroy(): void {
    if (this.dead) return;
    this.dead = true;
    this.abort.abort();
    this.ro?.disconnect();
    this.stopDpr();
    if (this.rafId) cancelAnimationFrame(this.rafId);
    if (this.flashRaf) cancelAnimationFrame(this.flashRaf);
    this.stopBlink();
    this.overlay = null;
    this.diffCache = null;
    this.strip = null;
    this.sampler = null;
    this.ghosts = null;
    this.canvas.remove();
  }

  setLabel(text: string): void { this.canvas.setAttribute('aria-label', text); }

  /** strip: the whole image (all frames); rect: the frame shown (default whole); frameLines: frame height for separators. */
  setImage(strip: ImageBitmap, o: { rect?: Rect; frameLines?: number | null; keepView?: boolean; pixels?: boolean } = {}): void {
    const { rect, frameLines = null, keepView = true, pixels = true } = o;
    const changedSize = !this.rect || !rect || this.rect.w !== rect.w || this.rect.h !== rect.h;
    this.strip = strip;
    this.rect = rect || { x: 0, y: 0, w: strip.width, h: strip.height };
    this.frameLines = frameLines;
    this.ghosts = null;
    this.diffCache = null;
    this.sampler = null;
    if (pixels && hasOffscreen() && strip.width * strip.height <= MAX_SAMPLE_PX) {
      try {
        const c = new OffscreenCanvas(strip.width, strip.height);
        const x = c.getContext('2d', { willReadFrequently: true });
        if (x) { x.drawImage(strip, 0, 0); this.sampler = x; }
      } catch { this.sampler = null; }
    }
    if (this.autoFit || (changedSize && !keepView)) this.fit();
    this.render();
  }
  setFrameRect(rect: Rect): void {
    this.rect = rect;
    this.diffCache = null;
    this.render();
  }

  resize(): void {
    if (this.dead) return;
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
  get cssW(): number { return this.canvas.width / (window.devicePixelRatio || 1); }
  get cssH(): number { return this.canvas.height / (window.devicePixelRatio || 1); }
  get tiles(): number { return this.tile ? 3 : 1; }

  /** Largest ladder step that fits, centred. user = a user action (reports onView). */
  fit(user = false): void {
    if (!this.rect) return;
    this.zoom = fitZoom(this.cssW, this.cssH, this.rect.w, this.rect.h, this.tiles);
    this.center();
    this.opts.onZoom?.(this.zoom);
    if (user) this.reportView();
  }
  private center(): void {
    if (!this.rect) return;
    const t = this.tiles;
    this.ox = Math.round((this.cssW - this.rect.w * t * this.zoom) / 2);
    this.oy = Math.round((this.cssH - this.rect.h * t * this.zoom) / 2);
  }
  /** Step the zoom keeping the pixel under (cx, cy) in place. */
  zoomBy(d: 1 | -1, cx = this.cssW / 2, cy = this.cssH / 2): void {
    this.setZoom(stepZoom(this.zoom, d), cx, cy);
  }
  setZoom(nz: number, cx = this.cssW / 2, cy = this.cssH / 2): void {
    const k = nz / this.zoom;
    this.ox = Math.round(cx - (cx - this.ox) * k);
    this.oy = Math.round(cy - (cy - this.oy) * k);
    this.zoom = nz;
    this.autoFit = false;
    this.opts.onZoom?.(this.zoom);
    this.render();
    this.reportView();
  }
  /** Pan by a screen offset (keyboard, wheel). */
  panBy(dx: number, dy: number): void {
    this.ox += dx; this.oy += dy;
    this.autoFit = false;
    this.requestRender();
    this.reportView();
  }

  // ---- compare API (RV7) ----
  getView(): ViewState {
    return { zoom: this.zoom, cx: (this.cssW / 2 - this.ox) / this.zoom, cy: (this.cssH / 2 - this.oy) / this.zoom };
  }
  setView(v: ViewState): void {
    this.autoFit = false;
    this.zoom = snapZoom(v.zoom);
    this.ox = Math.round(this.cssW / 2 - v.cx * this.zoom);
    this.oy = Math.round(this.cssH / 2 - v.cy * this.zoom);
    this.opts.onZoom?.(this.zoom);
    this.render();
  }
  private reportView(): void { this.opts.onView?.(this.getView()); }

  setOverlay(o: Overlay | null): void {
    if (!o) {
      this.overlay = null; this.diffCache = null; this.stopBlink(); this.render(); return;
    }
    if (!this.rect || o.rect.w !== this.rect.w || o.rect.h !== this.rect.h) return;
    const modeChanged = this.overlay?.mode !== o.mode;
    if (this.overlay?.image !== o.image || modeChanged || this.overlay?.rect.x !== o.rect.x || this.overlay?.rect.y !== o.rect.y) this.diffCache = null;
    this.overlay = { ...o, split: o.split ?? this.overlay?.split ?? 0.5 };
    if (o.mode === 'blink') { if (modeChanged) this.startBlink(); } else this.stopBlink();
    this.render();
  }
  get overlayMode(): OverlayMode | null { return this.overlay?.mode ?? null; }
  get overlayInfo(): { changed: number; total: number; bbox: Rect | null; tooLarge?: boolean } | null {
    if (this.overlay?.mode !== 'diff') return null;
    this.ensureDiff();
    return this.diffCache?.info ?? null;
  }
  /** Blink without a timer (reduced motion): the X key swaps manually. */
  get blinkManual(): boolean { return this.overlay?.mode === 'blink' && !this.blinkTimer; }
  get blinkShowsOverlay(): boolean { return this.blinkShowOverlay; }
  swapBlink(): void { if (this.overlay?.mode !== 'blink') return; this.blinkShowOverlay = !this.blinkShowOverlay; this.render(); this.opts.onOverlay?.(); }
  get split(): number { return this.overlay?.split ?? 0.5; }
  setSplit(s: number): void { if (!this.overlay) return; this.overlay.split = clamp(s, 0, 1); this.render(); }
  private startBlink(): void {
    this.stopBlink();
    this.blinkShowOverlay = false;
    if (reducedMotion()) return;
    this.blinkTimer = setInterval(() => { this.blinkShowOverlay = !this.blinkShowOverlay; this.render(); }, 500);
  }
  private stopBlink(): void { if (this.blinkTimer) clearInterval(this.blinkTimer); this.blinkTimer = null; this.blinkShowOverlay = false; }

  private ensureDiff(): void {
    const o = this.overlay, r = this.rect, s = this.strip;
    if (!o || !r || !s || o.mode !== 'diff') return;
    if (this.diffCache?.key === o) return;
    const total = r.w * r.h;
    if (total > MAX_DIFF_PX || !hasOffscreen()) { this.diffCache = { key: o, canvas: null, info: { changed: 0, total, bbox: null, tooLarge: true } }; return; }
    try {
      const read = (img: CanvasImageSource, rr: Rect) => {
        const c = new OffscreenCanvas(r.w, r.h); const x = c.getContext('2d', { willReadFrequently: true })!;
        x.drawImage(img, rr.x, rr.y, rr.w, rr.h, 0, 0, r.w, r.h);
        return x.getImageData(0, 0, r.w, r.h).data;
      };
      const d = diffMask(read(s, r), read(o.image, o.rect), r.w, r.h);
      const mc = new OffscreenCanvas(r.w, r.h);
      mc.getContext('2d')!.putImageData(new ImageData(d.mask as unknown as Uint8ClampedArray<ArrayBuffer>, r.w, r.h), 0, 0);
      this.diffCache = { key: o, canvas: mc, info: { changed: d.changed, total, bbox: d.bbox } };
    } catch {
      this.diffCache = { key: o, canvas: null, info: { changed: 0, total, bbox: null, tooLarge: true } };
    }
  }

  /** Screen (client) point -> art pixel of the frame (wrapping in tile mode), or null. */
  pixelAt(e: { clientX: number; clientY: number }): Pt | null {
    if (!this.rect) return null;
    const r = this.canvas.getBoundingClientRect();
    const gx = Math.floor((e.clientX - r.left - this.ox) / this.zoom), gy = Math.floor((e.clientY - r.top - this.oy) / this.zoom);
    const t = this.tiles, { w, h } = this.rect;
    if (gx < 0 || gy < 0 || gx >= w * t || gy >= h * t) return null;
    return [((gx % w) + w) % w, ((gy % h) + h) % h];
  }
  colorAt(x: number, y: number): { hex: string; a: number } | null {
    if (!this.sampler || !this.rect) return null;
    let d: Uint8ClampedArray;
    try { d = this.sampler.getImageData(x + this.rect.x, y + this.rect.y, 1, 1).data; } catch { return null; }
    const hx = (v: number) => v.toString(16).padStart(2, '0');
    const a = d[3];
    return { hex: `#${hx(d[0])}${hx(d[1])}${hx(d[2])}${a < 255 ? hx(a) : ''}`, a };
  }

  flash(rect: Rect): void {
    this.flashRect = { ...rect, t: performance.now() };
    if (this.flashRaf) return;
    const tick = () => {
      this.flashRaf = 0;
      if (!this.flashRect || this.dead) return;
      this.render();
      if (performance.now() - this.flashRect.t < 1200) this.flashRaf = requestAnimationFrame(tick);
      else { this.flashRect = null; this.render(); }
    };
    this.flashRaf = requestAnimationFrame(tick);
  }

  /** Coalesce renders into one animation frame. */
  requestRender(): void {
    if (this.rafId || this.dead) return;
    this.rafId = requestAnimationFrame(() => { this.rafId = 0; this.render(); });
  }

  setCursorTool(tool: string): void { this.canvas.dataset.tool = tool; }

  render(): void {
    if (this.dead || !this.ctx) return;
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
    const ov = this.overlay && this.overlay.rect.w === w && this.overlay.rect.h === h ? this.overlay : null;
    const ghosts = !ov && this.onion ? this.opts.onionFrames?.() : null;
    if (ghosts && !this.ghosts) this.ghosts = { prev: tinted(this.strip, 'rgba(229,72,77,1)'), next: tinted(this.strip, 'rgba(56,189,248,1)') };
    if (ov?.mode === 'diff') this.ensureDiff();
    for (let ty = 0; ty < t; ty++) for (let tx = 0; tx < t; tx++) {
      const dx = this.ox + tx * w * z, dy = this.oy + ty * h * z;
      if (ghosts && this.ghosts) {
        ctx.globalAlpha = 0.28;
        for (const [g, f] of [[this.ghosts.prev, ghosts.prev], [this.ghosts.next, ghosts.next]] as const) if (g && f !== null && f !== undefined) ctx.drawImage(g, sx, f * h, w, h, dx, dy, w * z, h * z);
        ctx.globalAlpha = 1;
      }
      if (!ov) { ctx.drawImage(this.strip, sx, sy, w, h, dx, dy, w * z, h * z); continue; }
      if (ov.mode === 'diff') {
        const mask = this.diffCache?.canvas;
        ctx.globalAlpha = mask ? 0.35 : 1;
        ctx.drawImage(this.strip, sx, sy, w, h, dx, dy, w * z, h * z);
        ctx.globalAlpha = 1;
        if (mask) { const sm = ctx.imageSmoothingEnabled; ctx.imageSmoothingEnabled = false; ctx.drawImage(mask, 0, 0, w, h, dx, dy, w * z, h * z); ctx.imageSmoothingEnabled = sm; }
      } else if (ov.mode === 'blink') {
        if (this.blinkShowOverlay) ctx.drawImage(ov.image, ov.rect.x, ov.rect.y, w, h, dx, dy, w * z, h * z);
        else ctx.drawImage(this.strip, sx, sy, w, h, dx, dy, w * z, h * z);
      } else {
        ctx.drawImage(this.strip, sx, sy, w, h, dx, dy, w * z, h * z);
        const cut = Math.round(w * (ov.split ?? 0.5));
        if (cut > 0) ctx.drawImage(ov.image, ov.rect.x, ov.rect.y, cut, h, dx, dy, cut * z, h * z);
      }
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
    if (ov?.mode === 'swipe') {
      const bx = ox + Math.round(w * (ov.split ?? 0.5)) * z;
      ctx.fillStyle = '#f5a524';
      ctx.fillRect(bx - 1, oy, 2, h * z);
      const hy = oy + (h * z) / 2;
      ctx.fillRect(bx - 4, hy - 12, 8, 24);
    }
    const s = this.stroke;
    if (s) {
      ctx.fillStyle = s.kind === 'free' && s.erase ? 'rgba(255,255,255,.55)' : s.color;
      const pts: Iterable<Pt> = s.kind === 'free' ? s.pts.values() : s.tool === 'line' ? bresenham(s.start[0], s.start[1], s.end[0], s.end[1]) : rectPoints(s.start, s.end, s.filled);
      for (const [px, py] of pts) for (let ty = 0; ty < t; ty++) for (let tx = 0; tx < t; tx++) ctx.fillRect(this.ox + (px + tx * w) * z, this.oy + (py + ty * h) * z, Math.max(1, z), Math.max(1, z));
    }
    // review marks on this frame, and the box being dragged
    const marks: (ReviewMark & { live?: boolean })[] = [...(this.opts.marks?.() || [])];
    if (this.box) {
      const [bx, by, bw, bh] = [Math.min(this.box.start[0], this.box.end[0]), Math.min(this.box.start[1], this.box.end[1]), Math.abs(this.box.end[0] - this.box.start[0]) + 1, Math.abs(this.box.end[1] - this.box.start[1]) + 1];
      marks.push({ id: '', status: 'open', region: [bx, by, bw, bh], live: true });
    }
    for (const m of marks) {
      if (!m.region) continue;
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

  /** Screen x of the swipe bar (CSS px relative to the canvas), or null. */
  private splitX(): number | null {
    const o = this.overlay, r = this.rect;
    if (!o || o.mode !== 'swipe' || !r) return null;
    const ox = this.ox + (this.tiles > 1 ? r.w * this.zoom : 0);
    return ox + Math.round(r.w * (o.split ?? 0.5)) * this.zoom;
  }

  private bind(): void {
    const c = this.canvas, signal = this.abort.signal;
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      const r = c.getBoundingClientRect();
      if (e.shiftKey && !e.ctrlKey) { this.panBy(-e.deltaY, 0); return; }
      this.zoomBy(e.deltaY < 0 ? 1 : -1, e.clientX - r.left, e.clientY - r.top);
    }, { passive: false, signal });
    c.addEventListener('pointerdown', (e) => this.down(e), { signal });
    c.addEventListener('pointermove', (e) => this.move(e), { signal });
    c.addEventListener('pointerleave', () => this.opts.onHover?.(null), { signal });
    c.addEventListener('pointerup', (e) => { this.pointers.delete(e.pointerId); if (this.pointers.size < 2) this.pinch = null; void this.up(); }, { signal });
    c.addEventListener('pointercancel', (e) => { this.pointers.delete(e.pointerId); this.pinch = null; this.pan = null; this.stroke = null; this.box = null; this.splitDrag = false; c.classList.remove('panning'); this.render(); }, { signal });
    c.addEventListener('contextmenu', (e) => e.preventDefault(), { signal });
    c.addEventListener('dblclick', () => { this.autoFit = true; this.fit(true); this.render(); }, { signal });
    // space-drag pans while the canvas has focus; arrow keys pan (Shift = faster); Left / Right move the swipe bar
    c.addEventListener('keydown', (e) => {
      if (e.code === 'Space') { this.space = true; e.preventDefault(); return; }
      const arrows: Record<string, [number, number]> = { ArrowLeft: [1, 0], ArrowRight: [-1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] };
      const a = arrows[e.key];
      if (!a || e.ctrlKey || e.metaKey || e.altKey) return;
      e.preventDefault();
      if (this.overlay?.mode === 'swipe' && (e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !this.space) {
        this.setSplit(this.split + (e.key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 0.1 : 0.02));
        return;
      }
      const step = e.shiftKey ? 128 : 32;
      this.panBy(a[0] * step, a[1] * step);
    }, { signal });
    window.addEventListener('keyup', (e) => { if (e.code === 'Space') this.space = false; }, { signal });
    c.addEventListener('blur', () => { this.space = false; }, { signal });
  }

  private down(e: PointerEvent): void {
    const c = this.canvas;
    c.focus({ preventScroll: true });
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.pointers.size === 2) {
      // two fingers: pinch zoom + pan; drop any stroke in progress
      const [p1, p2] = [...this.pointers.values()];
      this.stroke = null; this.box = null; this.pan = null;
      this.pinch = { d: Math.hypot(p2.x - p1.x, p2.y - p1.y) || 1, mx: (p1.x + p2.x) / 2, my: (p1.y + p2.y) / 2, zoom: this.zoom, ox: this.ox, oy: this.oy };
      try { c.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      this.render();
      return;
    }
    const tool = this.opts.getTool?.() || 'hand';
    if (this.overlay) {
      const sxp = this.splitX();
      const r = c.getBoundingClientRect();
      if (sxp !== null && e.button === 0 && Math.abs(e.clientX - r.left - sxp) <= SPLIT_GRAB) {
        this.splitDrag = true;
        try { c.setPointerCapture(e.pointerId); } catch { /* ignore */ }
        return;
      }
      this.startPan(e);
      return;
    }
    if (tool === 'review' && e.button === 0) {
      const p = this.pixelAt(e);
      if (!p) return;
      try { c.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      this.box = { start: p, end: p };
      this.render();
      return;
    }
    if (e.button === 1 || e.button === 2 || this.space || tool === 'hand' || !this.opts.editable) {
      if (!(e.button === 0 && !this.opts.editable && tool === 'picker')) { this.startPan(e); return; }
    }
    if (e.button !== 0) return;
    const p = this.pixelAt(e);
    if (!p) return;
    try { c.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    if (tool === 'picker') { const col = this.colorAt(p[0], p[1]); if (col && col.a) this.opts.onPick?.(col.hex); return; }
    const { hex8, hex } = this.opts.getColor?.() ?? { hex: '#000000', hex8: '#000000ff' };
    if (tool === 'fill') { void this.opts.onCommands?.([{ op: 'fill', x: p[0], y: p[1], color: hex8 }], 'user fill'); return; }
    const send = tool === 'eraser' ? 'transparent' : hex8;
    if (tool === 'pencil' || tool === 'eraser') {
      this.stroke = { kind: 'free', tool, color: tool === 'eraser' ? 'transparent' : hex, send, erase: tool === 'eraser', last: p, pts: new Map([[p.join(','), p]]) };
    } else if (tool === 'line' || tool === 'rect') {
      this.stroke = { kind: 'shape', tool, color: hex, send, start: p, end: p, filled: e.shiftKey };
    }
    this.render();
  }

  private startPan(e: PointerEvent): void {
    this.pan = { x: e.clientX, y: e.clientY, ox: this.ox, oy: this.oy };
    try { this.canvas.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    this.canvas.classList.add('panning');
    e.preventDefault();
  }

  private move(e: PointerEvent): void {
    if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.pinch && this.pointers.size >= 2) {
      const [p1, p2] = [...this.pointers.values()];
      const d = Math.hypot(p2.x - p1.x, p2.y - p1.y) || 1;
      const mx = (p1.x + p2.x) / 2, my = (p1.y + p2.y) / 2;
      const r = this.canvas.getBoundingClientRect();
      const pz = this.pinch;
      const nz = snapZoom(pz.zoom * (d / pz.d));
      const k = nz / pz.zoom;
      const cx = pz.mx - r.left, cy = pz.my - r.top;
      this.zoom = nz;
      this.ox = Math.round(cx - (cx - pz.ox) * k + (mx - pz.mx));
      this.oy = Math.round(cy - (cy - pz.oy) * k + (my - pz.my));
      this.autoFit = false;
      this.opts.onZoom?.(this.zoom);
      this.requestRender();
      this.reportView();
      return;
    }
    if (this.splitDrag && this.rect) {
      const r = this.canvas.getBoundingClientRect();
      const ox = this.ox + (this.tiles > 1 ? this.rect.w * this.zoom : 0);
      this.setSplit((e.clientX - r.left - ox) / (this.rect.w * this.zoom));
      return;
    }
    if (this.pan) {
      this.ox = this.pan.ox + e.clientX - this.pan.x; this.oy = this.pan.oy + e.clientY - this.pan.y;
      this.autoFit = false;
      this.requestRender();
      this.reportView();
      return;
    }
    if (this.overlay?.mode === 'swipe') {
      const sxp = this.splitX(), r = this.canvas.getBoundingClientRect();
      this.canvas.style.cursor = sxp !== null && Math.abs(e.clientX - r.left - sxp) <= SPLIT_GRAB ? 'col-resize' : '';
    } else if (this.canvas.style.cursor) this.canvas.style.cursor = '';
    const p = this.pixelAt(e);
    if (p) this.opts.onHover?.(p, this.colorAt(p[0], p[1]));
    if (this.box && p) { this.box.end = p; this.render(); return; }
    const s = this.stroke;
    if (!s || !p) return;
    if (s.kind === 'free') { extendStroke(s.pts, s.last, p); s.last = p; } else s.end = p;
    this.render();
  }

  private async up(): Promise<void> {
    if (this.splitDrag) { this.splitDrag = false; return; }
    if (this.pan) { this.pan = null; this.canvas.classList.remove('panning'); return; }
    if (this.box) {
      const b = this.box;
      this.box = null;
      this.render();
      this.opts.onReview?.(reviewPick(b.start, b.end));
      return;
    }
    const s = this.stroke;
    if (!s) return;
    const cmds: DrawCommand[] = s.kind === 'free' ? [strokeCommand(s.pts.values(), s.send)] : [shapeCommand(s.tool, s.start, s.end, s.send, s.filled)];
    try { await this.opts.onCommands?.(cmds, `user ${s.tool}`); } finally { this.stroke = null; this.render(); }
  }
}
