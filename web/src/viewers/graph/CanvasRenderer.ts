// Canvas renderer for the asset graph: 2D canvas drawing, live force simulation, pan / zoom, node drag,
// hover tooltip, thumbnails when zoomed in, keyboard pan / zoom / open on the focused canvas.
// Fast with thousands of nodes (grid-bucketed repulsion, viewport culling, draw only when dirty).
import { KIND_COLOR, KIND_ICON } from '@/lib/util/kinds';
import { h, themeColors, type ThemeColors } from '@/lib/util/dom';
import type { GraphData, GraphRenderer, GraphRendererHost, VisEdge, VisNode } from './renderer';
import {
  MAX_TICKS, SETTLE_ALPHA, centerOn, edgeLabel, fitView, hitTest, nodeLabel, radius, relColor, stepForce, tipText, wheelFactor, zoomAt,
  type View,
} from './sim';

export const MAX_THUMBS = 1500;
const MAX_SIDE = 8192, MAX_PIXELS = 32_000_000;
const PAN_STEP = 60;

type Drag =
  | { pan: true; x: number; y: number; vx: number; vy: number; moved: boolean }
  | { pan: false; n: VisNode; x: number; y: number; moved: boolean };

/** Backing-store scale: devicePixelRatio, clamped so the canvas stays within 8192 px a side and 32 MP. */
export function backingScale(W: number, H: number, dpr: number): number {
  if (W <= 0 || H <= 0) return dpr;
  return Math.max(0.1, Math.min(dpr, MAX_SIDE / W, MAX_SIDE / H, Math.sqrt(MAX_PIXELS / (W * H))));
}

export class CanvasRenderer implements GraphRenderer {
  readonly canvas: HTMLCanvasElement;
  readonly tip: HTMLDivElement;
  view: View = { x: 0, y: 0, k: 1 };
  alpha = 0;
  ticks = 0;
  private nodes: VisNode[] = [];
  private edges: VisEdge[] = [];
  private positions = new Map<string, VisNode>();
  private collapsed: ReadonlySet<string> = new Set();
  private selected: string | null = null;
  private hover: VisNode | null = null;
  private drag: Drag | null = null;
  private lastGroupClick: { id: string; t: number } | null = null;
  private thumbs = new Map<string, HTMLImageElement>();
  private W = 0;
  private H = 0;
  private dpr = 1;
  /** Chrome colours from the CSS tokens (4.1); kind and relation colours encode data and stay literal. */
  private tc: ThemeColors = themeColors();
  private dirty = true;
  private raf = 0;
  private dead = false;
  private wasSettled: boolean | null = null;
  private readonly ac = new AbortController();

  constructor(private readonly el: HTMLElement, private readonly host: GraphRendererHost) {
    this.canvas = h('canvas', { class: 'graph-canvas', tabindex: '0', role: 'img', 'aria-label': 'Asset graph: 0 nodes, 0 edges' });
    this.tip = h('div', { class: 'graph-tip', hidden: true });
    el.append(this.canvas, this.tip);
    this.bind();
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', () => { if (!document.hidden) this.invalidate(); }, { signal: this.ac.signal });
    this.resize();
  }

  get settled(): boolean { return this.alpha < SETTLE_ALPHA && !this.drag; }
  get focusEl(): HTMLElement { return this.canvas; }
  get selection(): string | null { return this.selected; }

  // ---- data ----
  setData(d: GraphData): void {
    this.nodes = d.nodes;
    this.edges = d.edges;
    this.positions = d.positions;
    this.collapsed = d.collapsed;
    this.selected = d.selected;
    if (this.hover && !this.positions.has(this.hover.id)) { this.hover = null; this.tip.hidden = true; }
    this.canvas.setAttribute('aria-label', `Asset graph: ${d.nodes.length} nodes, ${d.edges.length} edges`);
    this.alpha = (d.simulate ?? d.layout === 'force') ? 1 : 0;
    this.ticks = 0;
    this.invalidate();
    this.notifySettled();
  }
  setSelected(id: string | null): void { this.selected = id; this.invalidate(); }
  fit(): void {
    const v = fitView(this.nodes, this.W, this.H);
    if (v) { this.view = v; this.invalidate(); }
  }
  center(id: string, minZoom: number): void {
    const n = this.positions.get(id);
    if (!n) return;
    this.view = centerOn(this.view, n.x, n.y, this.W, this.H, minZoom);
    this.invalidate();
  }
  zoomBy(factor: number): void { this.view = zoomAt(this.view, this.W / 2, this.H / 2, factor); this.invalidate(); }
  panBy(dx: number, dy: number): void { this.view = { ...this.view, x: this.view.x + dx, y: this.view.y + dy }; this.invalidate(); }

  resize(): void {
    const r = this.el.getBoundingClientRect();
    const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    this.W = r.width; this.H = r.height;
    this.dpr = backingScale(r.width, r.height, dpr);
    this.canvas.width = Math.max(1, Math.round(r.width * this.dpr));
    this.canvas.height = Math.max(1, Math.round(r.height * this.dpr));
    this.canvas.style.width = r.width + 'px';
    this.canvas.style.height = r.height + 'px';
    this.tc = themeColors();
    this.invalidate();
  }

  destroy(): void {
    if (this.dead) return;
    this.dead = true;
    this.ac.abort();
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    for (const t of this.thumbs.values()) { t.onload = null; t.src = ''; }
    this.thumbs.clear();
    this.canvas.remove();
    this.tip.remove();
  }

  // ---- loop: runs only while something changes; paused while the page is hidden ----
  invalidate(): void { this.dirty = true; this.wake(); }
  private wake(): void {
    if (this.dead || this.raf || (typeof document !== 'undefined' && document.hidden)) return;
    this.raf = requestAnimationFrame(() => this.tick());
  }
  private get running(): boolean { return this.alpha >= SETTLE_ALPHA && this.nodes.length > 0; }
  /** One frame: a simulation step (capped at MAX_TICKS per run) and a draw when anything changed. */
  tick(): void {
    this.raf = 0;
    if (this.dead) return;
    let moved = false;
    if (this.running) {
      const dragId = this.drag && !this.drag.pan ? this.drag.n.id : null;
      this.alpha = stepForce(this.nodes, this.edges, this.alpha, dragId);
      if (++this.ticks >= MAX_TICKS) this.alpha = 0;
      moved = true;
    }
    if (moved || this.dirty) { this.dirty = false; this.draw(); }
    this.notifySettled();
    if (this.running && !(typeof document !== 'undefined' && document.hidden)) this.wake();
  }
  private notifySettled(): void {
    const s = this.settled;
    if (s !== this.wasSettled) { this.wasSettled = s; this.host.onSettled(s); }
  }

  // ---- drawing ----
  private thumb(n: VisNode): HTMLImageElement | null {
    const url = this.host.thumb(n);
    if (!url) return null;
    let t = this.thumbs.get(url);
    if (!t) {
      t = new Image();
      t.onload = () => this.invalidate();
      t.src = url;
      this.thumbs.set(url, t);
      if (this.thumbs.size > MAX_THUMBS) {
        const first = this.thumbs.keys().next().value;
        if (first !== undefined) { const o = this.thumbs.get(first); if (o) { o.onload = null; o.src = ''; } this.thumbs.delete(first); }
      }
    }
    return t.complete && t.naturalWidth ? t : null;
  }

  draw(): void {
    const x = this.canvas.getContext('2d');
    if (!x) return;
    const dpr = this.dpr, { k, x: vx, y: vy } = this.view, W = this.W, H = this.H;
    x.setTransform(dpr, 0, 0, dpr, 0, 0);
    x.fillStyle = this.tc.stage; x.fillRect(0, 0, W, H);
    if (!this.nodes.length) return;
    x.setTransform(dpr * k, 0, 0, dpr * k, dpr * vx, dpr * vy);
    const inView = (n: VisNode, pad = 40) => { const sx = n.x * k + vx, sy = n.y * k + vy; return sx > -pad && sy > -pad && sx < W + pad && sy < H + pad; };
    const sel = this.selected, hl = new Set<string>();
    if (sel) for (const e of this.edges) { if (e.a.id === sel) hl.add(e.b.id); if (e.b.id === sel) hl.add(e.a.id); }
    // edges
    const labels = k > 0.9 && this.edges.length < 600;
    x.lineWidth = 1 / k;
    for (const e of this.edges) {
      if (!inView(e.a, 2000) && !inView(e.b, 2000)) continue;
      const on = !!sel && (e.a.id === sel || e.b.id === sel);
      const col = on ? relColor(e.rel) : relColor(e.rel) + (sel ? '44' : '99');
      x.strokeStyle = col;
      x.lineWidth = (on ? 2 : 1) / k;
      x.setLineDash(e.derived ? [] : [5 / k, 3 / k]);
      x.beginPath(); x.moveTo(e.a.x, e.a.y); x.lineTo(e.b.x, e.b.y); x.stroke();
      // arrow head at b
      const dx = e.b.x - e.a.x, dy = e.b.y - e.a.y, d = Math.hypot(dx, dy) || 1, r = radius(e.b) + 2;
      const ax = e.b.x - (dx / d) * r, ay = e.b.y - (dy / d) * r, s = 6 / Math.max(0.6, k);
      x.setLineDash([]);
      x.fillStyle = col;
      x.beginPath(); x.moveTo(ax, ay); x.lineTo(ax - (dx / d) * s - (dy / d) * s * 0.5, ay - (dy / d) * s + (dx / d) * s * 0.5); x.lineTo(ax - (dx / d) * s + (dy / d) * s * 0.5, ay - (dy / d) * s - (dx / d) * s * 0.5); x.fill();
      if ((labels && !e.derived) || on) {
        x.fillStyle = this.tc.text2; x.font = `${10 / Math.max(0.8, k)}px ui-monospace, monospace`;
        x.fillText(edgeLabel(e), (e.a.x + e.b.x) / 2 + 3, (e.a.y + e.b.y) / 2 - 3);
      }
    }
    x.setLineDash([]);
    // nodes
    const big = k > 1.1;
    for (const n of this.nodes) {
      if (!inView(n)) continue;
      const r = radius(n), col = KIND_COLOR[n.kind] || '#94a3b8';
      const dim = !!sel && n.id !== sel && !hl.has(n.id);
      x.globalAlpha = dim ? 0.35 : 1;
      const t = big ? this.thumb(n) : null;
      if (t) {
        const s = r * 2.4;
        x.fillStyle = this.tc.panel; x.fillRect(n.x - s / 2, n.y - s / 2, s, s);
        x.imageSmoothingEnabled = false;
        const q = Math.min(s / t.naturalWidth, s / t.naturalHeight);
        x.drawImage(t, n.x - (t.naturalWidth * q) / 2, n.y - (t.naturalHeight * q) / 2, t.naturalWidth * q, t.naturalHeight * q);
        x.strokeStyle = col; x.lineWidth = 2 / k; x.strokeRect(n.x - s / 2, n.y - s / 2, s, s);
      } else {
        x.fillStyle = n.missing ? this.tc.line : col;
        x.beginPath();
        x.arc(n.x, n.y, r, 0, Math.PI * 2); x.fill();
        if (n.kind === 'group') { x.strokeStyle = '#e9d5ff'; x.lineWidth = 2 / k; x.stroke(); }
        if (n.missing) { x.strokeStyle = col; x.lineWidth = 1.5 / k; x.stroke(); }
        if (k > 0.6) { x.fillStyle = '#0b0c0f'; x.font = `${r}px system-ui`; x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText(KIND_ICON[n.kind] || '•', n.x, n.y + 0.5); x.textAlign = 'left'; x.textBaseline = 'alphabetic'; }
      }
      if (n.id === sel || n.id === this.hover?.id) { x.strokeStyle = '#fff'; x.lineWidth = 2 / k; x.beginPath(); x.arc(n.x, n.y, r + 4, 0, Math.PI * 2); x.stroke(); }
      if (this.collapsed.has(n.id)) { x.fillStyle = '#e9d5ff'; x.font = `bold ${11 / Math.max(0.8, k)}px system-ui`; x.fillText('+', n.x + r + 2, n.y - r); }
      // badges: open review notes, approved
      if (n.reviews) { x.fillStyle = this.tc.accent; x.beginPath(); x.arc(n.x + r, n.y - r, 7 / Math.max(0.7, k), 0, Math.PI * 2); x.fill(); x.fillStyle = this.tc.accentInk; x.font = `bold ${9 / Math.max(0.7, k)}px system-ui`; x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText(String(n.reviews), n.x + r, n.y - r + 0.5); x.textAlign = 'left'; x.textBaseline = 'alphabetic'; }
      if (n.approved) { x.fillStyle = this.tc.green; x.font = `bold ${12 / Math.max(0.7, k)}px system-ui`; x.fillText('✓', n.x - r - 10 / Math.max(0.7, k), n.y - r + 4); }
      // cleanup badges: superseded (red slash + dashed ring), orphan (dashed grey ring)
      if (n.superseded || n.orphan) {
        x.save(); x.setLineDash([3 / k, 3 / k]); x.lineWidth = 1.5 / k; x.strokeStyle = n.superseded ? '#f87171' : this.tc.muted;
        x.beginPath(); x.arc(n.x, n.y, r + 7 / Math.max(0.7, k), 0, Math.PI * 2); x.stroke(); x.restore();
        if (n.superseded) { x.strokeStyle = '#f87171'; x.lineWidth = 2 / k; x.beginPath(); x.moveTo(n.x - r * 0.8, n.y + r * 0.8); x.lineTo(n.x + r * 0.8, n.y - r * 0.8); x.stroke(); }
        if (k > 0.6) { x.fillStyle = n.superseded ? this.tc.redFg : this.tc.orphanFg; x.font = `${9 / Math.max(0.75, k)}px system-ui`; x.fillText(n.superseded ? 'superseded' : 'orphan', n.x - r, n.y + r + 12 / Math.max(0.75, k)); }
      }
      if (k > 0.45 || n.id === sel || hl.has(n.id) || n.kind === 'group') {
        x.fillStyle = n.missing ? this.tc.dim : this.tc.text; x.font = `${(n.kind === 'group' ? 12 : 11) / Math.max(0.75, k)}px system-ui`;
        x.fillText(nodeLabel(n), n.x + r + 4, n.y + 4);
        if (n.tags?.length && k > 1) { x.fillStyle = this.tc.muted; x.font = `${9 / k}px system-ui`; x.fillText(n.tags.map((tg) => '#' + tg).join(' '), n.x + r + 4, n.y + 16 / Math.max(0.75, k)); }
      }
      x.globalAlpha = 1;
    }
  }

  // ---- pointer and keyboard ----
  toWorld(e: { clientX: number; clientY: number }): [number, number] {
    const r = this.canvas.getBoundingClientRect();
    return [(e.clientX - r.left - this.view.x) / this.view.k, (e.clientY - r.top - this.view.y) / this.view.k];
  }
  hit(e: { clientX: number; clientY: number }): VisNode | null {
    const [wx, wy] = this.toWorld(e);
    return hitTest(this.nodes, wx, wy, this.view.k, radius);
  }

  private bind(): void {
    const c = this.canvas, signal = this.ac.signal;
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      const r = c.getBoundingClientRect();
      this.view = zoomAt(this.view, e.clientX - r.left, e.clientY - r.top, wheelFactor(e.deltaY));
      this.invalidate();
    }, { passive: false, signal });
    c.addEventListener('pointerdown', (e) => {
      const n = this.hit(e);
      try { c.setPointerCapture(e.pointerId); } catch { /* synthetic events */ }
      this.drag = n ? { pan: false, n, moved: false, x: e.clientX, y: e.clientY } : { pan: true, x: e.clientX, y: e.clientY, vx: this.view.x, vy: this.view.y, moved: false };
    }, { signal });
    c.addEventListener('pointermove', (e) => {
      const d = this.drag;
      if (!d) {
        const n = this.hit(e);
        if (n?.id !== this.hover?.id) { this.hover = n; this.invalidate(); }
        this.tip.hidden = !n;
        if (n) {
          this.tip.textContent = tipText(n);
          const r = this.el.getBoundingClientRect();
          this.tip.style.left = e.clientX - r.left + 14 + 'px';
          this.tip.style.top = e.clientY - r.top + 10 + 'px';
        }
        return;
      }
      if (Math.abs(e.clientX - d.x) + Math.abs(e.clientY - d.y) > 3) d.moved = true;
      if (d.pan) this.view = { ...this.view, x: d.vx + e.clientX - d.x, y: d.vy + e.clientY - d.y };
      else if (d.moved) {
        const [wx, wy] = this.toWorld(e);
        d.n.x = wx; d.n.y = wy; d.n.pinned = true;
        if (this.alpha < 0.3) { this.alpha = 0.3; this.ticks = 0; } // re-heat
      }
      this.invalidate();
    }, { signal });
    c.addEventListener('pointerleave', () => {
      if (this.drag) return;
      this.tip.hidden = true;
      if (this.hover) { this.hover = null; this.invalidate(); }
    }, { signal });
    const up = () => {
      const d = this.drag;
      this.drag = null;
      if (!d) return;
      if (d.moved) {
        if (!d.pan) this.host.onMoved(d.n.id, d.n.x, d.n.y);
        this.invalidate();
        return;
      }
      if (d.pan) { this.host.onSelect(null); return; }
      if (d.n.kind === 'group') {
        // a group double-click also fires two clicks: ignore the second
        const now = Date.now();
        if (this.lastGroupClick?.id === d.n.id && now - this.lastGroupClick.t < 350) return;
        this.lastGroupClick = { id: d.n.id, t: now };
      }
      this.host.onSelect(d.n.id);
    };
    c.addEventListener('pointerup', up, { signal });
    c.addEventListener('pointercancel', () => { this.drag = null; this.invalidate(); }, { signal });
    c.addEventListener('dblclick', (e) => {
      const n = this.hit(e);
      if (!n) return;
      if (n.kind === 'group') this.host.onToggleGroup(n.id);
      else this.host.onOpen(n.id);
    }, { signal });
    c.addEventListener('keydown', (e) => { if (this.onCanvasKey(e)) { e.preventDefault(); e.stopPropagation(); } }, { signal });
  }

  /** Keys on the focused canvas: arrows pan, + / - zoom, Enter opens (or folds) the selection. */
  onCanvasKey(e: KeyboardEvent): boolean {
    if (e.ctrlKey || e.metaKey || e.altKey) return false;
    const step = e.shiftKey ? PAN_STEP * 4 : PAN_STEP;
    switch (e.key) {
      case 'ArrowLeft': this.panBy(step, 0); return true;
      case 'ArrowRight': this.panBy(-step, 0); return true;
      case 'ArrowUp': this.panBy(0, step); return true;
      case 'ArrowDown': this.panBy(0, -step); return true;
      case '+': case '=': this.zoomBy(1.25); return true;
      case '-': case '_': this.zoomBy(0.8); return true;
      case 'Enter': {
        const id = this.selected;
        if (!id) return false;
        if (this.positions.get(id)?.kind === 'group') this.host.onToggleGroup(id);
        else this.host.onOpen(id);
        return true;
      }
      default: return false;
    }
  }
}
