// Layers view: the ordered part / layer stack of a rig (rest pose or a clip of an output canvas, per view,
// per frame) or of a plain canvas, live. Per entry: colour, eye + solo (view only), name, z, the rule that
// placed it. A debug overlay tints parts by draw order and hatches overlaps; hovering a pixel tells which
// part drew it and what is underneath. A z-order lane chart (a lane per part across frames) shows order
// flips at a glance. "Flag layering" turns two selected parts into a review note for the agent.
import type { AnyEvent, CanvasInfo } from '@/lib/api/types';
import { api } from '@/lib/api/client';
import { getBitmap, isAbort } from '@/lib/api/http';
import { canvasPng } from '@/lib/api/urls';
import { checker } from '@/lib/util/checker';
import { h, icon } from '@/lib/util/dom';
import { rafBatch } from '@/lib/util/format';
import { BaseViewer } from '../base';
import { button, fillSelect, group, label, range, select, spacer, toggle } from '../controls';
import { fitCanvas } from '../rig/logic';
import type { CanvasTarget, RigTarget, Target, ViewerEnv } from '../types';
import {
  canvasStack, flagDraft, flagLabel, hatchRgba, hitTest, hue, laneFrameAt, laneFrameX, laneLayout, laneParts, mapLimit, normStack,
  outlineMask, outlineRgba, overlapMask, toggleSel, type StackEntry,
} from './stack';

type Surface = OffscreenCanvas | HTMLCanvasElement;
type Ctx = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;
interface FrameData { frame: number; stack: StackEntry[] }
interface PartSrc { img: CanvasImageSource; sy: number }

const MAX_PARALLEL = 6;
const OVERLAP_RGBA: [number, number, number, number] = [229, 72, 77, 140];   // rgba(229,72,77,.55)
const SEL_RGBA: [number, number, number, number][] = [[56, 189, 248, 230], [245, 165, 36, 230]];   // .9 alpha

function surface(w: number, h: number): Surface {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}
function ctx2d(s: Surface, o?: CanvasRenderingContext2DSettings): Ctx | null {
  return s instanceof HTMLCanvasElement ? s.getContext('2d', o) : (s as OffscreenCanvas).getContext('2d', o);
}

/** Draw RGBA bytes into a new surface (null when ImageData is unavailable). */
function rgbaSurface(data: Uint8ClampedArray, w: number, h: number): Surface | null {
  if (typeof ImageData === 'undefined') return null;
  const s = surface(w, h);
  ctx2d(s)?.putImageData(new ImageData(data as Uint8ClampedArray<ArrayBuffer>, w, h), 0, 0);
  return s;
}

async function decodePng(b64: string): Promise<ImageBitmap> {
  const bin = atob(b64);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return createImageBitmap(new Blob([u], { type: 'image/png' }));
}

export class LayersViewer extends BaseViewer {
  private tgt: CanvasTarget | RigTarget | null = null;
  private mode: 'rig' | 'canvas' = 'rig';
  private rig: string | null = null;
  private canvasName: string | null = null;
  private info: CanvasInfo | null = null;
  private outInfo: Record<string, CanvasInfo> = {};
  private frames: FrameData[] = [];
  private hasData = false;
  private frame = 0;
  private sel: string[] = [];
  private off = new Set<string>();
  private solo: string | null = null;
  // the loaded frame
  private size: [number, number] | null = null;
  private parts: string[] = [];
  private stack: StackEntry[] = [];
  private srcs: PartSrc[] = [];
  private alpha: Uint8ClampedArray[] = [];
  private tinted: (Surface | null)[] = [];
  private bitmaps: ImageBitmap[] = [];
  private hatch: { key: string; s: Surface | null } | null = null;
  private outlines = new Map<string, Surface | null>();
  private scale = 1;
  private frameSeq = 0;
  private frameAbort: AbortController | null = null;
  private lastHover: { x: number; y: number } | null = null;
  private hoverRaf!: ReturnType<typeof rafBatch>;
  // DOM
  private viewSel!: HTMLSelectElement;
  private tagSel!: HTMLSelectElement;
  private debugCb!: HTMLInputElement;
  private overCb!: HTMLInputElement;
  private scrub!: HTMLInputElement;
  private frameLabel!: HTMLElement;
  private flagBtn!: HTMLButtonElement;
  private viewG!: HTMLElement;
  private canvas!: HTMLCanvasElement;
  private hoverEl!: HTMLElement;
  private stackEl!: HTMLElement;
  private lanes!: HTMLCanvasElement;
  private source!: HTMLElement;

  protected key(t: Target): string {
    const r = t as Partial<RigTarget> & { kind: string; name: string };
    return JSON.stringify([t.kind, r.name, r.canvas ?? null, r.tag ?? null]);
  }

  protected build(): HTMLElement {
    const root = h('div', { class: 'viewer layers-viewer' });
    this.viewSel = select({ title: 'View', onChange: () => this.reloadData() });
    this.tagSel = select({ title: 'Clip', onChange: () => { this.frame = 0; this.reloadData(); } });
    const dbg = toggle({ label: 'Debug tint', title: 'Tint parts by draw order (debug overlay)', checked: true, onChange: () => this.draw() });
    const ovr = toggle({ label: 'Overlaps', title: 'Highlight pixels where parts overlap', checked: true, onChange: () => this.draw() });
    this.debugCb = dbg.input; this.overCb = ovr.input;
    this.scrub = range({ min: 0, max: 0, value: 0, className: 'scrub', title: 'Frame', onInput: (v) => void this.setFrame(v) });
    this.frameLabel = h('span', { class: 'mono' });
    this.flagBtn = button({ text: 'Flag layering', variant: 'warn', title: 'Select two parts in the stack, then flag their order for the agent', onClick: () => this.flag() });
    this.flagBtn.disabled = true;
    this.viewG = group(label('View'), this.viewSel);
    root.append(h('div', { class: 'vtoolbar' },
      this.viewG,
      group(label('Clip'), this.tagSel),
      group(
        button({ icon: 'chevron-left', small: true, title: 'Previous frame (,)', onClick: () => void this.setFrame(this.frame - 1) }),
        this.scrub,
        button({ icon: 'chevron-right', small: true, title: 'Next frame (.)', onClick: () => void this.setFrame(this.frame + 1) }),
        this.frameLabel),
      group(dbg.el, ovr.el),
      spacer(), this.flagBtn));
    this.canvas = h('canvas', { class: 'layers-canvas', role: 'img', 'aria-label': 'layer composite' });
    this.hoverEl = h('div', { class: 'hover-info mono', 'aria-live': 'polite', text: 'Hover a pixel: which part drew it, and what is underneath' });
    this.stackEl = h('div', { class: 'stack-list' });
    this.lanes = h('canvas', { class: 'z-lanes', role: 'img', 'aria-label': 'Z order across frames' });
    this.source = h('div', { class: 'muted small' });
    const stage = h('div', { class: 'layers-stage' }, h('div', { class: 'center-scroll' }, this.canvas), this.hoverEl);
    const lanesWrap = h('div', { class: 'lanes-wrap' }, h('div', { class: 'panel-label', text: 'Z order across frames (a lane per part; crossings = order flips)' }), this.lanes);
    root.append(
      h('div', { class: 'layers-body' }, stage, h('div', { class: 'layers-side' }, h('div', { class: 'panel-label', text: 'Draw order (top first)' }), this.stackEl, this.source)),
      lanesWrap);
    this.hoverRaf = rafBatch(() => this.hoverNow());
    this.canvas.addEventListener('pointermove', (e) => { this.lastHover = { x: e.clientX, y: e.clientY }; this.hoverRaf(); });
    this.canvas.addEventListener('pointerleave', () => { this.lastHover = null; this.hoverRaf.cancel(); this.hoverEl.textContent = ''; });
    this.lanes.addEventListener('click', (e) => {
      const r = this.lanes.getBoundingClientRect();
      void this.setFrame(laneFrameAt(e.clientX - r.left, r.width, this.frames.length || 1));
    });
    this.onResize(stage, () => this.draw());
    this.onResize(lanesWrap, () => this.drawLanes());
    this.onDprChange(() => { this.draw(); this.drawLanes(); });
    this.addCleanup(() => { this.hoverRaf.cancel(); this.frameAbort?.abort(); this.dropFrame(); });
    return root;
  }

  // ---- loading ----
  protected load(target: Target, prev: Target | null): Promise<void> {
    if (prev) { this.sel = []; this.off.clear(); this.solo = null; }
    this.frame = (target as RigTarget).frame ?? 0;
    return this.open(target as CanvasTarget | RigTarget, true);
  }

  protected targetChanged(_prev: Target, next: Target): void {
    this.tgt = next as CanvasTarget | RigTarget;
    const f = (next as RigTarget).frame;
    if (f !== undefined && f !== this.frame) void this.setFrame(f);
  }

  protected envChanged(prev: ViewerEnv, next: ViewerEnv): void {
    if (prev.assetsRev !== next.assetsRev && this.mode === 'rig') this.scheduleReload();
  }

  /** Resolve rig / canvas mode and the clip list; preselect = apply the target's canvas / tag / frame. */
  private async open(t: CanvasTarget | RigTarget, preselect: boolean): Promise<void> {
    const token = this.nextLoad();
    this.tgt = t;
    let mode: 'rig' | 'canvas' = 'rig', rig: string | null, canvasName: string | null, info: CanvasInfo | null = null;
    if (t.kind === 'canvas') {
      try { info = await api.canvas(t.name); } catch (e) {
        if (!this.isCurrent(token)) return;
        this.source.textContent = (e as Error).message;
        throw e;
      }
      if (!this.isCurrent(token)) return;
      const meta = info.meta;
      const parts = /_parts$/.test(t.name);
      rig = typeof meta?.rig === 'string' ? meta.rig : parts && meta?.rig ? t.name.slice(0, -6) : null;
      if (rig) canvasName = parts ? null : t.name;
      else { mode = 'canvas'; canvasName = t.name; }
    } else { rig = t.name; canvasName = t.canvas || null; }
    this.mode = mode; this.rig = rig; this.canvasName = canvasName; this.info = info;
    this.viewG.hidden = mode !== 'rig';
    if (mode === 'rig') {
      const outs = this.host.assets()?.rigs.find((r) => r.name === rig)?.outputs ?? [];
      const infos = await Promise.all(outs.map((o) => (o === canvasName && info ? Promise.resolve(info) : api.canvas(o).catch(() => null))));
      if (!this.isCurrent(token)) return;
      this.outInfo = {};
      outs.forEach((o, i) => { const x = infos[i]; if (x) this.outInfo[o] = x; });
      const tags = outs.flatMap((o) => Object.keys(this.outInfo[o]?.animations || {}).map((tg) => `${o}/${tg}`));
      const want = !preselect ? undefined
        : t.tag && canvasName ? `${canvasName}/${t.tag}` : canvasName ? tags.find((x) => x.startsWith(canvasName + '/')) : undefined;
      fillSelect(this.tagSel, tags.map((x) => ({ value: x, label: x })), { first: { value: '', label: 'rest pose' }, keep: want && tags.includes(want) ? want : undefined });
    } else {
      this.outInfo = {};
      fillSelect(this.tagSel, [], { first: { value: '', label: `${info?.frames || 1} frame(s)` } });
    }
    await this.loadData(token);
  }

  private query(): { canvas?: string; tag?: string; view?: string } {
    const v = this.tagSel.value || '';
    const i = v.indexOf('/');
    const q: { canvas?: string; tag?: string; view?: string } = {};
    if (i >= 0 && v.slice(i + 1)) { q.canvas = v.slice(0, i); q.tag = v.slice(i + 1); }
    if (this.viewSel.value) q.view = this.viewSel.value;
    return q;
  }

  private reloadData(): void { void this.loadData(this.nextLoad()).catch(() => {}); }

  /** The stack per frame (rig /layers, or the canvas layers), then the current frame. */
  private async loadData(token: number): Promise<void> {
    if (this.mode === 'canvas') {
      const info = this.info;
      if (!info) return;
      const n = info.frames || 1;
      const stack = canvasStack(info.layers);
      this.frames = Array.from({ length: n }, (_, i) => ({ frame: i, stack }));
      this.hasData = true;
      this.scrub.max = String(n - 1);
      this.source.textContent = 'source: canvas layers (bottom = layer 0)';
      await this.setFrame(Math.min(this.frame, n - 1), true);
      return;
    }
    const rig = this.rig!;
    let ld;
    try { ld = await api.rigLayers(rig, this.query()); } catch (e) {
      if (!this.isCurrent(token)) return;
      this.source.textContent = (e as Error).message;
      throw e;
    }
    if (!this.isCurrent(token)) return;
    this.frames = (ld.frames || []).map((f, i) => ({ frame: f.frame ?? i, stack: normStack(f.stack ?? f.parts ?? f.layers) }));
    this.hasData = true;
    const views = ld.views || [];
    fillSelect(this.viewSel, views.map((v) => ({ value: v, label: v })), { keep: ld.view || undefined });
    this.scrub.max = String(Math.max(0, this.frames.length - 1));
    this.source.textContent = `source: ${ld.source || 'rig_layers'}`;
    await this.setFrame(Math.min(this.frame, this.frames.length - 1), true);
  }

  /** Show frame f: fetch its per-part pixels (latest wins; superseded fetches are aborted). */
  async setFrame(f: number, force = false): Promise<void> {
    if (!this.hasData) return;
    const n = this.frames.length || 1;
    f = Math.max(0, Math.min(n - 1, Math.round(f) || 0));
    if (f === this.frame && !force) return;
    this.frame = f;
    this.scrub.value = String(f);
    this.frameLabel.textContent = `${f} / ${n - 1}`;
    this.scrub.setAttribute('aria-valuetext', `frame ${f + 1} of ${n}`);
    const seq = ++this.frameSeq;
    this.frameAbort?.abort();
    const ac = (this.frameAbort = new AbortController());
    const stale = () => seq !== this.frameSeq || this.dead;
    let size: [number, number], parts: string[], stack: StackEntry[], srcs: PartSrc[], bitmaps: ImageBitmap[];
    try {
      if (this.mode === 'rig') {
        const d = await api.rigDebug(this.rig!, { ...this.query(), frame: f }, ac.signal);
        if (stale()) return;
        size = d.size;
        // /debug lists atlas cells in draw order (atlas_parts); stack entries are looked up by part name
        parts = d.atlas_parts || normStack(d.stack).filter((s) => !s.hidden).map((s) => s.part);
        stack = d.stack ? normStack(d.stack) : this.frames[f]?.stack ?? [];
        const atlas = await decodePng(d.atlas);
        if (stale()) { atlas.close?.(); return; }
        bitmaps = [atlas];
        srcs = parts.map((_, i) => ({ img: atlas, sy: i * size[1] }));
      } else {
        const info = this.info!;
        size = [info.width, info.frameHeight || info.height];
        stack = this.frames[f]?.stack ?? [];
        parts = stack.map((s) => s.part);
        bitmaps = await mapLimit(stack, MAX_PARALLEL, (s) => getBitmap(canvasPng(info.name, { layer: s.index, frame: info.frames > 1 ? f : undefined, t: info.version }), { signal: ac.signal }));
        if (stale()) { for (const b of bitmaps) b.close?.(); return; }
        srcs = bitmaps.map((img) => ({ img, sy: 0 }));
      }
    } catch (e) {
      if (isAbort(e) || stale()) return;
      this.hoverEl.textContent = (e as Error).message;
      return;
    }
    this.dropFrame();
    this.size = size; this.parts = parts; this.stack = stack; this.srcs = srcs; this.bitmaps = bitmaps;
    this.prepare();
    this.renderStack();
    this.draw();
    this.drawLanes();
  }

  /** Per-part alpha (hit tests, overlaps, outlines) and tinted copies, once per frame load. */
  private prepare(): void {
    const [W, H] = this.size!;
    const n = this.parts.length;
    const sampler = surface(W, H);
    const sx = ctx2d(sampler, { willReadFrequently: true });
    this.alpha = []; this.tinted = [];
    for (let i = 0; i < n; i++) {
      const src = this.srcs[i];
      if (!sx || !src) { this.alpha.push(new Uint8ClampedArray(W * H * 4)); this.tinted.push(null); continue; }
      sx.clearRect(0, 0, W, H);
      sx.drawImage(src.img, 0, src.sy, W, H, 0, 0, W, H);
      this.alpha.push(sx.getImageData(0, 0, W, H).data);
      const t = surface(W, H), tx = ctx2d(t);
      if (tx) {
        tx.drawImage(src.img, 0, src.sy, W, H, 0, 0, W, H);
        tx.globalCompositeOperation = 'source-atop';
        tx.fillStyle = hue(i, n);
        tx.fillRect(0, 0, W, H);
      }
      this.tinted.push(tx ? t : null);
    }
  }

  private dropFrame(): void {
    for (const b of this.bitmaps) b.close?.();
    this.bitmaps = []; this.srcs = []; this.alpha = []; this.tinted = [];
    this.hatch = null; this.outlines.clear();
  }

  private visible(): number[] {
    const out: number[] = [];
    this.parts.forEach((p, i) => { if (this.solo ? p === this.solo : !this.off.has(p)) out.push(i); });
    return out;
  }

  // ---- drawing ----
  draw(): void {
    if (!this.size) return;
    const [W, H] = this.size;
    const box = this.canvas.parentElement!.getBoundingClientRect();
    const s0 = Math.max(1, Math.min(16, Math.floor(Math.min((box.width - 20) / W, (box.height - 20) / H))));
    const fit = fitCanvas(W, H, s0, window.devicePixelRatio || 1);
    const s = (this.scale = fit.scale);
    const c = this.canvas;
    c.width = Math.max(1, Math.round(W * s * fit.dpr)); c.height = Math.max(1, Math.round(H * s * fit.dpr));
    c.style.width = `${W * s}px`; c.style.height = `${H * s}px`;
    c.dataset.clamped = fit.clamped ? '1' : '';
    const x = c.getContext('2d');
    if (!x) return;
    x.setTransform(fit.dpr, 0, 0, fit.dpr, 0, 0);
    checker(x, 0, 0, W * s, H * s, Math.max(4, s * 2));
    x.imageSmoothingEnabled = false;
    const vis = this.visible();
    const tint = this.debugCb.checked;
    for (const i of vis) {
      const src = this.srcs[i];
      if (!src) continue;
      x.drawImage(src.img, 0, src.sy, W, H, 0, 0, W * s, H * s);
      const t = tint ? this.tinted[i] : null;
      if (t) { x.globalAlpha = 0.55; x.drawImage(t, 0, 0, W * s, H * s); x.globalAlpha = 1; }
    }
    if (this.overCb.checked && vis.length > 1) {
      const key = vis.join(',');
      if (this.hatch?.key !== key) this.hatch = { key, s: rgbaSurface(hatchRgba(overlapMask(this.alpha, W, H, vis), W, H, OVERLAP_RGBA), W, H) };
      if (this.hatch.s) x.drawImage(this.hatch.s, 0, 0, W * s, H * s);
    }
    // selected parts outlined: a band of max(1, s/4) px at the top of each edge pixel
    const band = Math.max(1, Math.round(s / 4));
    this.sel.forEach((part, k) => {
      const i = this.parts.indexOf(part);
      if (i < 0 || !this.alpha[i]) return;
      const key = `${i}|${k}|${s}`;
      if (!this.outlines.has(key)) this.outlines.set(key, rgbaSurface(outlineRgba(outlineMask(this.alpha[i], W, H), W, H, s, band, SEL_RGBA[k]), W, H * s));
      const o = this.outlines.get(key);
      if (o) x.drawImage(o, 0, 0, W * s, H * s);
    });
    const note = fit.clamped ? ' · scale clamped to the canvas size limit' : '';
    if (note && !this.source.textContent?.endsWith(note)) this.source.textContent += note;
  }

  private hoverNow(): void {
    const p = this.lastHover;
    if (!p || !this.size || !this.alpha.length) return;
    const r = this.canvas.getBoundingClientRect();
    const [W] = this.size;
    const px = Math.floor((p.x - r.left) / this.scale), py = Math.floor((p.y - r.top) / this.scale);
    const hits = hitTest(this.alpha, W, px, py, this.visible()).map((i) => this.parts[i]);
    const z = (part: string) => this.stack.find((s) => s.part === part)?.z;
    this.hoverEl.textContent = hits.length
      ? `x ${px} y ${py}: drawn by ${hits[0]} (z ${z(hits[0])})${hits.length > 1 ? ` · underneath: ${hits.slice(1).map((q) => `${q} (z ${z(q)})`).join(', ')}` : ''}`
      : `x ${px} y ${py}: empty`;
  }

  private renderStack(): void {
    const rows: HTMLElement[] = [];
    const n = this.parts.length;
    for (const s of [...this.stack].reverse()) {   // top first
      const idx = this.stack.indexOf(s);
      const pi = this.parts.indexOf(s.part);
      const off = this.off.has(s.part), solo = this.solo === s.part, selK = this.sel.indexOf(s.part);
      const eye = h('button', { type: 'button', class: 'act', title: off ? 'Show' : 'Hide (view only)', 'aria-label': `${off ? 'Show' : 'Hide'} ${s.part}`, 'aria-pressed': String(off),
        on: { click: () => { if (off) this.off.delete(s.part); else this.off.add(s.part); this.renderStack(); this.draw(); } } }, icon(off ? 'eye-off' : 'eye'));
      const so = h('button', { type: 'button', class: solo ? 'act on' : 'act', title: solo ? 'Unsolo' : 'Solo', 'aria-label': `Solo ${s.part}`, 'aria-pressed': String(solo),
        on: { click: () => { this.solo = solo ? null : s.part; this.renderStack(); this.draw(); } } }, icon('circle-dot'));
      rows.push(h('div', {
        class: `stack-row${s.hidden ? ' is-hidden' : ''}${selK >= 0 ? ` sel${selK}` : ''}`, title: s.why_hidden || '', dataset: { part: s.part },
        on: { click: (e: MouseEvent) => { if ((e.target as Element | null)?.closest?.('button.act')) return; this.select(s.part); } },
      },
      h('i', { class: 'swatch-dot', style: { background: hue(pi < 0 ? idx : pi, n) } }),
      eye, so,
      h('button', { type: 'button', class: 'sname', 'aria-pressed': String(selK >= 0), title: 'Select (pick two to flag their order)', text: s.part }),
      h('span', { class: 'sz mono', text: `z ${s.z}` }),
      h('span', { class: 'srule muted', text: s.hidden ? s.why_hidden || 'hidden' : s.rule })));
    }
    if (!this.stack.length) rows.push(h('div', { class: 'muted', text: 'Nothing drawn in this frame.' }));
    this.stackEl.replaceChildren(...rows);
    this.flagBtn.disabled = this.sel.length !== 2;
    this.flagBtn.textContent = flagLabel(this.sel);
  }

  private select(part: string): void {
    this.sel = toggleSel(this.sel, part);
    this.renderStack();
    this.draw();
    this.drawLanes();
  }

  drawLanes(): void {
    const frames = this.frames;
    const parts = laneParts(frames);
    const c = this.lanes, dpr = window.devicePixelRatio || 1;
    const r = (c.parentElement ?? c).getBoundingClientRect();
    const L = laneLayout(frames, parts, r.width);
    c.width = Math.max(1, Math.round(r.width * dpr)); c.height = Math.round(L.height * dpr);
    c.style.height = `${L.height}px`;
    const x = c.getContext('2d');
    if (!x) return;
    x.setTransform(dpr, 0, 0, dpr, 0, 0);
    x.fillStyle = '#15171c'; x.fillRect(0, 0, r.width, L.height);
    x.font = '10px ui-monospace, monospace';
    x.fillStyle = 'rgba(255,255,255,.04)';
    for (let k = 1; k < parts.length; k += 2) x.fillRect(L.left, L.rankY(k) - L.rowH / 2, L.plotW, L.rowH);
    L.lanes.forEach((lane, pi) => {
      const i = this.parts.indexOf(lane.part);
      const col = hue(i >= 0 ? i : pi, parts.length);
      x.strokeStyle = col; x.lineWidth = this.sel.includes(lane.part) ? 3 : 1.5;
      x.beginPath();
      for (const seg of lane.segs) seg.forEach(([X, Y], j) => (j ? x.lineTo(X, Y) : x.moveTo(X, Y)));
      x.stroke();
      x.fillStyle = col;
      x.fillText(lane.part, 4, lane.labelY);
    });
    x.fillStyle = '#f5a524';
    x.fillRect(laneFrameX(L, this.frame, Math.max(1, frames.length)) - 1, 0, 2, L.height);
  }

  // ---- actions ----
  flag(): void {
    const d = flagDraft({
      mode: this.mode, rig: this.rig, canvasName: this.canvasName, sel: this.sel, view: this.viewSel.value, clip: this.tagSel.value || '', frame: this.frame,
      tagFrames: (cv, tag) => this.outInfo[cv]?.animations?.[tag]?.frames,
    });
    if (d) this.host.requestReview(d);
  }

  private scheduleReload(): void {
    const t = this.tgt;
    if (t) this.later(250, () => { void this.open(t, false).catch(() => {}); }, 'reload');
  }

  onEvent(ev: AnyEvent): void {
    if (!this.tgt) return;
    if (ev.type === 'resync') { this.scheduleReload(); return; }
    if (ev.type !== 'change') return;
    const c = (ev as { canvas?: string }).canvas;
    if (!c) return;
    const clipCanvas = (this.tagSel.value || '').split('/')[0];
    const hit = this.mode === 'canvas' ? c === this.canvasName : c === `${this.rig}_parts` || (!!clipCanvas && c === clipCanvas);
    if (hit) this.scheduleReload();
  }

  onKey(_e: KeyboardEvent, k: string): boolean {
    if (k === ',') { void this.setFrame(this.frame - 1); return true; }
    if (k === '.') { void this.setFrame(this.frame + 1); return true; }
    return false;
  }

  debugInfo(): unknown {
    return { mode: this.mode, rig: this.rig, canvas: this.canvasName, frame: this.frame, frames: this.frames.length, parts: [...this.parts], sel: [...this.sel], scale: this.scale, clip: this.tagSel.value };
  }
}
