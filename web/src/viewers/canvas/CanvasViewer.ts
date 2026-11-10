// Canvas viewer / editor: pixel view + paint tools, zoom / pan, grid, 3x3 tile, frame strip with onion
// skin and scrubber, view-only layer solo, PNG / GIF export. Read-only in slot B and for snapshots.
import type { AnyEvent, CanvasInfo, ReviewMark } from '@/lib/api/types';
import { api, op, type DrawCommand } from '@/lib/api/client';
import { getBitmap, isAbort } from '@/lib/api/http';
import { canvasPng, snapshotPng } from '@/lib/api/urls';
import { h, icon } from '@/lib/util/dom';
import { fmtTime } from '@/lib/util/format';
import { store } from '@/lib/util/storage';
import type { IconName } from '@/lib/util/icons';
import { BaseViewer } from '../base';
import { button, fillSelect, group, link, range, select, spacer, toggle } from '../controls';
import { PixelView } from '../pixel/PixelView';
import type { CanvasTarget, CompareImage, LinkState, Target, Tool, ViewerEnv } from '../types';
import { ColorPicker } from './colorPicker';
import { diffStatus, modeHint, nextOverlay, overlayPlan } from './compare';
import { frameCount, frameLabel, frameRect, gifUrl, hoverText, metaText, onionNeighbours, planChange, zoomText } from './logic';

export const TOOLS: [Tool, IconName, string][] = [
  ['pencil', 'pencil', 'Pencil (B)'], ['eraser', 'eraser', 'Eraser (E)'], ['fill', 'paint-bucket', 'Fill (G)'], ['line', 'slash', 'Line (L)'],
  ['rect', 'square', 'Rectangle (R), Shift = filled'], ['picker', 'pipette', 'Pick colour (I)'], ['hand', 'hand', 'Pan (H, or Space / middle drag)'],
];
export const TOOL_KEYS: Record<string, Tool> = { b: 'pencil', e: 'eraser', g: 'fill', l: 'line', r: 'rect', i: 'picker', h: 'hand' };
export const MAX_THUMBS = 512;

type Info = Pick<CanvasInfo, 'name' | 'width' | 'height' | 'frames' | 'frameHeight' | 'layers' | 'animations' | 'palette' | 'inheritedPalette'> & { colors?: { unique: number }; undo?: number; snapshot?: unknown };

export class CanvasViewer extends BaseViewer {
  readonly isCanvasEditor = true;
  private name = '';
  private snap: string | null = null;
  private info: Info | null = null;
  private strip: ImageBitmap | null = null;
  private fh = 1;
  private nFrames = 1;
  private frame = 0;
  private layerSolo = '';
  private pendingTag: string | undefined;
  private imgSeq = 0;
  private imgAbort: AbortController | null = null;
  private thumbIO: IntersectionObserver | null = null;
  // compare (RV7): applying the peer's link state (never echo it back); an overlay is shown
  private applyingLink = false;
  private overlayOn = false;
  // DOM
  private view!: PixelView;
  private toolGroup!: HTMLElement;
  private editGroups: HTMLElement[] = [];
  private toolBtns = new Map<Tool, HTMLButtonElement>();
  private picker: ColorPicker | null = null;
  private alphaIn!: HTMLInputElement;
  private zoomLabel!: HTMLElement;
  private gridCb!: HTMLInputElement;
  private tileCb!: HTMLInputElement;
  private layerSel!: HTMLSelectElement;
  private stateBadge!: HTMLElement;
  private exportA!: HTMLAnchorElement;
  private framesBar!: HTMLElement;
  private frameViewCb!: HTMLInputElement;
  private onionCb!: HTMLInputElement;
  private scrub!: HTMLInputElement;
  private frameLabelEl!: HTMLElement;
  private tagSel!: HTMLSelectElement;
  private gifA!: HTMLAnchorElement;
  private thumbs!: HTMLElement;
  private metaEl!: HTMLElement;
  private cursorEl!: HTMLElement;

  private get readOnly(): boolean { return this.host.readOnly; }
  private get editable(): boolean { return !this.readOnly && !this.snap; }

  protected key(t: Target): string { const c = t as CanvasTarget; return JSON.stringify([c.name, c.snap ?? null, c.view ?? 'edit']); }

  protected build(): HTMLElement {
    const root = h('div', { class: 'viewer canvas-viewer' });
    const tb = h('div', { class: 'vtoolbar' });
    if (!this.readOnly) {
      this.toolGroup = h('div', { class: 'group', role: 'radiogroup', 'aria-label': 'Paint tool', on: { keydown: (e: KeyboardEvent) => this.toolKeys(e) } });
      for (const [t, ic, title] of TOOLS) {
        const b = h('button', { type: 'button', class: 'tool', title, role: 'radio', 'aria-label': title, dataset: { tool: t }, on: { click: () => this.host.setTool(t) } }, icon(ic));
        this.toolBtns.set(t, b);
        this.toolGroup.append(b);
      }
      this.picker = new ColorPicker(root, {
        getColor: () => this.env.color.hex8,
        setColor: (hex8) => this.host.setColor(hex8),
        palette: () => Object.entries({ ...(this.info?.inheritedPalette || {}), ...(this.info?.palette || {}) }).map(([name, hex]) => ({ name, hex })),
        toast: (t, k) => this.host.toast(t, k),
      });
      this.alphaIn = range({ min: 0, max: 255, value: 255, title: 'Alpha', className: 'alpha', onInput: () => this.host.setColor(this.env.color.hex + this.alphaHex()) });
      const colorGroup = group(this.picker.button, this.alphaIn);
      const undoGroup = group(
        button({ icon: 'undo-2', title: 'Undo (Ctrl+Z)', onClick: () => this.undo(false) }),
        button({ icon: 'redo-2', title: 'Redo (Ctrl+Y)', onClick: () => this.undo(true) }));
      this.editGroups = [this.toolGroup, colorGroup, undoGroup];
      tb.append(...this.editGroups);
    }
    this.zoomLabel = h('span', { class: 'mono zoom-label', text: '1×' });
    tb.append(group(
      button({ icon: 'zoom-out', title: 'Zoom out (-)', onClick: () => this.view.zoomBy(-1) }),
      this.zoomLabel,
      button({ icon: 'zoom-in', title: 'Zoom in (+)', onClick: () => this.view.zoomBy(1) }),
      button({ text: 'Fit', title: 'Fit (0, or double-click)', onClick: () => this.fit() })));
    const grid = toggle({ label: 'Grid', title: 'Pixel grid (#)', checked: store.get('grid', true), onChange: (on) => { this.view.grid = on; store.set('grid', on); this.view.render(); } });
    const tile = toggle({ label: 'Tile', title: 'Tile 3×3 seam check (T)', onChange: (on) => { this.view.tile = on; if (this.view.autoFit) this.view.fit(); this.view.render(); } });
    this.gridCb = grid.input; this.tileCb = tile.input;
    tb.append(group(grid.el, tile.el));
    this.layerSel = select({ title: 'Show one layer only (view only)', className: 'layer-solo', onChange: (v) => { this.layerSolo = v; void this.loadImage(); } });
    tb.append(group(this.layerSel), spacer());
    this.stateBadge = h('span', { class: 'badge state', hidden: true });
    this.exportA = link({ text: 'PNG', title: 'Download PNG' });
    tb.append(this.stateBadge, this.exportA);
    root.append(tb);

    const stage = h('div', { class: 'stage' });
    root.append(stage);
    const self = this;
    this.view = new PixelView(stage, {
      get editable() { return self.editable; },
      getTool: () => (!this.editable ? 'hand' : this.env.reviewMode ? 'review' : this.env.tool),
      getColor: () => this.env.color,
      onPick: (hex) => this.host.setColor(hex),
      onCommands: (commands, label) => this.draw(commands, label),
      onHover: (p, c) => { this.cursorEl.textContent = hoverText(p, c, this.info?.frameHeight, this.frameMode()); },
      onZoom: (z) => { this.zoomLabel.textContent = zoomText(z); },
      onView: () => this.linkOut(),
      onionFrames: () => onionNeighbours(this.frame, this.nFrames, this.frameMode()),
      onReview: (r) => this.host.requestReview({
        asset: `canvas:${this.name}`,
        ...(this.nFrames > 1 && this.frameMode() ? { frame: this.frame } : {}),
        ...(this.tagSel.value ? { tag: this.tagSel.value } : {}),
        ...(this.layerSolo !== '' ? { layer: this.info?.layers[Number(this.layerSolo)]?.name } : {}),
        ...r,
      }),
      marks: () => this.marks(),
    });
    this.view.grid = this.gridCb.checked;

    // frames strip
    this.framesBar = h('div', { class: 'frames-bar', hidden: true });
    const fv = toggle({ label: 'Frame', title: 'Show one frame at a time', checked: true, onChange: () => this.showFrame(this.frame, true) });
    const on = toggle({ label: 'Onion', title: 'Ghost previous (red) and next (blue) frames', onChange: (v) => { this.view.onion = v; this.view.render(); } });
    this.frameViewCb = fv.input; this.onionCb = on.input;
    this.scrub = range({ min: 0, max: 0, value: 0, className: 'scrub', title: 'Frame', onInput: (v) => this.showFrame(v) });
    this.frameLabelEl = h('span', { class: 'mono' });
    this.tagSel = select({ onChange: () => this.renderStrip() });
    this.gifA = link({ text: 'GIF', small: true, title: 'Download the selected animation as GIF' });
    this.thumbs = h('div', { class: 'frame-thumbs' });
    this.framesBar.append(
      h('div', { class: 'frames-controls' }, fv.el, on.el,
        button({ icon: 'chevron-left', small: true, title: 'Previous frame (,)', onClick: () => this.step(-1) }),
        this.scrub,
        button({ icon: 'chevron-right', small: true, title: 'Next frame (.)', onClick: () => this.step(1) }),
        this.frameLabelEl, spacer(), h('label', { class: 'toggle' }, 'Tag ', this.tagSel), this.gifA),
      this.thumbs);
    root.append(this.framesBar);
    this.metaEl = h('span');
    this.cursorEl = h('span');
    root.append(h('div', { class: 'vstatus mono' }, this.metaEl, this.cursorEl));
    this.addCleanup(() => { this.view.destroy(); this.picker?.destroy(); this.thumbIO?.disconnect(); this.imgAbort?.abort(); this.strip?.close?.(); this.strip = null; });
    this.applyTool();
    this.picker?.sync(this.env.color.hex8);
    this.setAlpha(this.env.color.hex8);
    return root;
  }

  // ---- env ----
  protected envChanged(prev: ViewerEnv, next: ViewerEnv): void {
    if (prev.tool !== next.tool || prev.reviewMode !== next.reviewMode) this.applyTool();
    if (prev.color.hex8 !== next.color.hex8) { this.picker?.sync(next.color.hex8); this.setAlpha(next.color.hex8); }
    if (prev.reviewsRev !== next.reviewsRev || prev.reviewMode !== next.reviewMode) this.view.render();
    if (prev.compareOverlay !== next.compareOverlay || prev.peerRev !== next.peerRev) this.syncOverlay();
  }
  private applyTool(): void {
    const t = this.env.tool;
    for (const [k, b] of this.toolBtns) {
      const on = k === t;
      b.classList.toggle('active', on);
      b.setAttribute('aria-checked', String(on));
      b.tabIndex = on ? 0 : -1;
    }
    this.view.setCursorTool(this.editable ? t : 'hand');
  }
  /** Roving focus in the tool radio group: arrows move and select. */
  private toolKeys(e: KeyboardEvent): void {
    const order = TOOLS.map((x) => x[0]);
    const i = order.indexOf(this.env.tool);
    const d = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    e.stopPropagation();
    const t = order[(i + d + order.length) % order.length];
    this.host.setTool(t);
    this.toolBtns.get(t)?.focus();
  }
  private alphaHex(): string { return Number(this.alphaIn?.value ?? 255).toString(16).padStart(2, '0'); }
  private setAlpha(hex8: string): void { if (this.alphaIn) this.alphaIn.value = String(hex8.length === 9 ? parseInt(hex8.slice(7), 16) : 255); }
  private marks(): ReviewMark[] {
    if (this.snap) return [];
    return this.host.reviewMarks({ kind: 'canvas', name: this.name }).filter((m) => m.region && (m.frame === undefined || !this.frameMode() || m.frame === this.frame));
  }
  fit(): void { this.view.autoFit = true; this.view.fit(true); this.view.render(); }

  // ---- loading ----
  protected async load(target: Target, prev: Target | null): Promise<void> {
    const t = target as CanvasTarget, p = prev as CanvasTarget | null;
    const same = !!p && p.name === t.name && !!p.snap === !!t.snap;
    this.name = t.name;
    this.snap = t.snap || null;
    if (!same) { this.view.autoFit = true; this.frame = t.frame ?? 0; this.layerSolo = ''; }
    else if (t.frame !== undefined) this.frame = t.frame;
    if (t.tag) this.pendingTag = t.tag;
    for (const g of this.editGroups) g.hidden = !!this.snap;
    this.applyTool();
    await this.reload();
  }
  protected targetChanged(_prev: Target, next: Target): void {
    const t = next as CanvasTarget;
    if (t.tag && this.info?.animations?.[t.tag]) { this.tagSel.value = t.tag; this.renderStrip(); } else if (t.tag) this.pendingTag = t.tag;
    if (t.frame !== undefined) this.showFrame(t.frame);
  }

  async reload(): Promise<void> {
    const token = this.nextLoad();
    const name = this.name, snap = this.snap;
    if (snap) {
      const meta = await api.snapshot(snap).catch(() => null);
      if (!this.isCurrent(token)) return;
      this.info = meta ? { name, width: Math.round(meta.width ?? 0), height: meta.height ?? 0, frames: meta.frames ?? 1, frameHeight: meta.frameHeight ?? null, layers: [], animations: {}, snapshot: meta } : null;
      this.stateBadge.hidden = false;
      this.stateBadge.textContent = meta ? `snapshot · v${meta.version}${(meta.scale ?? 1) > 1 ? ` · 1/${meta.scale}` : ''}` : 'snapshot expired';
      this.exportA.href = snapshotPng(snap);
      this.exportA.setAttribute('download', `${name}_${snap}.png`);
    } else {
      this.stateBadge.hidden = true;
      try { this.info = await api.canvas(name); } catch (e) {
        if (!this.isCurrent(token)) return;
        this.info = null;
        this.metaEl.textContent = (e as Error).message;
        throw e;
      }
      if (!this.isCurrent(token)) return;
      this.exportA.href = canvasPng(name, { download: true });
      this.exportA.setAttribute('download', `${name}.png`);
    }
    this.layerSel.hidden = !!snap;
    fillSelect(this.layerSel, (this.info?.layers || []).map((l, i) => ({ value: String(l.index ?? i), label: `${l.name}${l.visible ? '' : ' (hidden)'}` })), { first: { value: '', label: 'all layers' }, keep: this.layerSolo });
    this.layerSolo = this.layerSel.value;
    await this.loadImage();
    if (!this.isCurrent(token)) return;
    if (!snap) this.host.canvasInfoChanged(name);
  }

  /** Latest wins: an older image load that finishes late is dropped. */
  private async loadImage(): Promise<void> {
    if (!this.info) return;
    const seq = ++this.imgSeq;
    this.imgAbort?.abort();
    const ac = (this.imgAbort = new AbortController());
    const url = this.snap ? snapshotPng(this.snap) : canvasPng(this.name, { t: Date.now(), layer: this.layerSolo !== '' ? this.layerSolo : undefined });
    let bmp: ImageBitmap;
    try { bmp = await getBitmap(url, { signal: ac.signal }); } catch (e) {
      if (isAbort(e) || seq !== this.imgSeq || this.dead) return;
      this.metaEl.textContent = (e as Error).message;
      return;
    }
    if (seq !== this.imgSeq || this.dead || !this.info) { bmp.close?.(); return; }
    const old = this.strip;
    this.strip = bmp;
    this.fh = this.info.frameHeight || bmp.height;
    this.nFrames = frameCount(bmp.height, this.fh);
    this.frame = Math.min(this.frame, this.nFrames - 1);
    this.showFrame(this.frame, true);
    this.renderStrip();
    this.renderMeta();
    old?.close?.();
    this.host.notifyPeer();
  }

  frameMode(): boolean { return this.nFrames > 1 && this.frameViewCb.checked; }
  showFrame(f: number, force = false): void {
    if (!this.strip) return;
    f = Math.max(0, Math.min(this.nFrames - 1, f));
    const changed = f !== this.frame;
    this.frame = f;
    const fm = this.frameMode();
    const rect = frameRect(this.strip.width, this.strip.height, this.fh, f, fm);
    if (force) this.view.setImage(this.strip, { rect, frameLines: fm ? null : this.info?.frameHeight ?? null });
    else this.view.setFrameRect(rect);
    this.scrub.value = String(f);
    this.frameLabelEl.textContent = frameLabel(f, this.nFrames, fm);
    if (changed) { this.linkOut(); this.host.notifyPeer(); }
    if (changed || force) this.syncOverlay();
    if (changed || force) {
      for (const [i, t] of [...this.thumbs.children].entries()) t.classList.toggle('active', i === f);
      const act = this.thumbs.children[f] as HTMLElement | undefined;
      if (changed && act && typeof act.scrollIntoView === 'function') act.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
    this.view.setLabel(`${this.name}, ${fm ? `frame ${f + 1} of ${this.nFrames}, ` : ''}${this.strip.width}×${fm ? this.fh : this.strip.height}`);
  }
  step(d: number): void { if (this.nFrames) this.showFrame((this.frame + d + this.nFrames) % this.nFrames); }

  private renderStrip(): void {
    const tags = Object.keys(this.info?.animations || {});
    const show = this.nFrames > 1 || tags.length > 0;
    this.framesBar.hidden = !show;
    if (!show || !this.strip) return;
    const cur = this.pendingTag ?? this.tagSel.value;
    fillSelect(this.tagSel, tags.map((t) => ({ value: t, label: t })), { first: { value: '', label: 'all frames' }, keep: tags.includes(cur) ? cur : '' });
    this.pendingTag = undefined;
    this.scrub.max = String(this.nFrames - 1);
    const sel = this.tagSel.value;
    this.gifA.hidden = !!this.snap;
    this.gifA.href = gifUrl(this.name, sel);
    const tagged = new Set(sel ? this.info?.animations[sel]?.frames ?? [] : []);
    const n = Math.min(this.nFrames, MAX_THUMBS);
    if (this.thumbs.children.length !== n) {
      this.thumbIO?.disconnect();
      this.thumbs.replaceChildren();
      for (let i = 0; i < n; i++) this.thumbs.append(h('div', { class: 'frame-thumb', dataset: { i: String(i) }, on: { click: () => this.showFrame(i) } }, h('canvas'), h('span', { text: String(i) })));
      if (this.nFrames > MAX_THUMBS) this.thumbs.append(h('span', { class: 'muted small', text: `+${this.nFrames - MAX_THUMBS} more (use the scrubber)` }));
      this.thumbIO = typeof IntersectionObserver !== 'undefined'
        ? new IntersectionObserver((es) => { for (const e of es) if (e.isIntersecting) this.drawThumb(e.target as HTMLElement); }, { root: this.thumbs, rootMargin: '0px 200px' })
        : null;
      for (const t of this.thumbs.querySelectorAll<HTMLElement>('.frame-thumb')) this.thumbIO?.observe(t);
    }
    this.thumbs.querySelectorAll<HTMLElement>('.frame-thumb').forEach((t, i) => {
      t.classList.toggle('active', i === this.frame);
      t.classList.toggle('tagged', tagged.has(i));
      t.dataset.drawn = '';
      if (!this.thumbIO) this.drawThumb(t);
      else { this.thumbIO.unobserve(t); this.thumbIO.observe(t); }
    });
  }
  private drawThumb(t: HTMLElement): void {
    const s = this.strip;
    if (!s || t.dataset.drawn === '1') return;
    const i = Number(t.dataset.i);
    const w = s.width, fh = this.fh;
    const k = Math.min(1, 44 / Math.max(w, fh));
    const sc = Math.max(k, Math.floor(44 / Math.max(w, fh)) || k);
    const dw = Math.max(1, Math.round(w * sc)), dh = Math.max(1, Math.round(fh * sc));
    const c = t.querySelector('canvas')!;
    c.width = dw; c.height = dh;
    const cx = c.getContext('2d');
    if (!cx) return;
    cx.imageSmoothingEnabled = false;
    cx.drawImage(s, 0, i * fh, w, fh, 0, 0, dw, dh);
    t.dataset.drawn = '1';
  }
  private renderMeta(): void { if (this.info) this.metaEl.textContent = metaText(this.info, !!this.snap); }

  // ---- editing ----
  private async draw(commands: DrawCommand[], label: string): Promise<void> {
    if (!this.editable || !this.name) return;
    const ok = await op('draw', { canvas: this.name, label, ...(this.frameMode() ? { frame: this.frame } : {}), commands }).then(() => true, () => false);
    const painted = commands.find((c) => c.color !== 'transparent')?.color;
    if (ok && painted) this.picker?.painted(painted.length === 9 ? painted : painted.slice(0, 7) + 'ff');
  }
  undo(redo: boolean): void {
    if (this.name && this.editable) void op('undo', { canvas: this.name, ...(redo ? { redo: true } : {}) }).catch(() => {});
  }

  // ---- live ----
  onEvent(ev: AnyEvent): void {
    if (!this.name) return;
    const plan = planChange(ev, { name: this.name, snap: !!this.snap, frameMode: this.frameMode(), frameHeight: this.info?.frameHeight, frame: this.frame, following: this.env.following });
    if (plan.deleted) { this.metaEl.textContent = `${this.name} was deleted ${fmtTime((ev as { ts: number }).ts)}`; return; }
    if (plan.jumpToFrame !== null) this.frame = plan.jumpToFrame;
    if (plan.flashRect) this.view.flash(plan.flashRect);
    if (plan.thumbFlash !== null) {
      const th = this.thumbs.children[plan.thumbFlash];
      if (th) { th.classList.add('flash'); this.later(700, () => th.classList.remove('flash')); }
    }
    if (plan.refit) this.view.autoFit = true;
    if (plan.reload) this.later(60, () => { void this.reload().catch(() => {}); }, 'reload');
  }

  onKey(e: KeyboardEvent, k: string): boolean {
    if (k === '+' || k === '=') { this.view.zoomBy(1); return true; }
    if (k === '-') { this.view.zoomBy(-1); return true; }
    if (k === '0') { this.fit(); return true; }
    if (k === '#') { this.flip(this.gridCb); return true; }
    if (k === 't') { this.flip(this.tileCb); return true; }
    if (k === ',') { this.step(-1); return true; }
    if (k === '.') { this.step(1); return true; }
    if (k === 'n') { this.flip(this.onionCb); return true; }
    if (k === 'x' && this.view.overlayMode === 'blink') { this.view.swapBlink(); return true; }
    if (k === 'd' && this.host.peerViewer()?.compareImage) { this.host.setCompareOverlay(nextOverlay(this.env.compareOverlay)); return true; }
    if (this.editable && TOOL_KEYS[k] && !e.shiftKey) { this.host.setTool(TOOL_KEYS[k]); return true; }
    return false;
  }
  private flip(cb: HTMLInputElement): void { cb.checked = !cb.checked; cb.dispatchEvent(new Event('change')); }

  // ---- compare (RV7, step 18c) ----
  /** Mirror zoom / pan / frame to the other slot (user changes only; never while applying the peer's). */
  private linkOut(): void {
    if (this.applyingLink || !this.env.compareLink || !this.strip) return;
    this.host.peerViewer()?.applyLinkState?.({ ...this.view.getView(), frame: this.frame });
  }
  applyLinkState(s: LinkState): void {
    if (!this.strip) return;
    this.applyingLink = true;
    try {
      const f = Math.max(0, Math.min(this.nFrames - 1, s.frame));
      if (f !== this.frame && this.frameMode()) this.showFrame(f);
      this.view.setView({ zoom: s.zoom, cx: s.cx, cy: s.cy });
    } finally { this.applyingLink = false; }
  }
  /** Slot A: draw the other slot's image over this one (Difference / Swipe / Blink), or nothing. */
  private syncOverlay(): void {
    if (this.host.slot !== 'A' || !this.view) return;
    const mode = this.env.compareOverlay;
    if (mode === 'off' && !this.overlayOn) return; // compare closed / overlay off: no work, no host calls
    const peer = mode === 'off' ? null : this.host.peerViewer()?.compareImage?.() ?? null;
    const plan = overlayPlan(mode, this.view.rect, peer);
    this.view.setOverlay(plan.overlay);
    this.overlayOn = !!plan.overlay;
    this.setEditPaused(this.overlayOn);
    const status = plan.status === 'diff' ? diffStatus(this.view.overlayInfo) : plan.status ?? (plan.overlay ? modeHint(mode, this.view.blinkManual) : null);
    this.host.compareStatus(status);
  }
  /** While an overlay is shown, slot A is view-only (undo / redo keys stay). */
  private setEditPaused(on: boolean): void {
    if (!this.toolGroup) return;
    for (const b of this.toolBtns.values()) b.disabled = on;
    if (on) this.toolGroup.title = 'Editing is paused while an overlay is shown'; else this.toolGroup.removeAttribute('title');
    this.toolGroup.setAttribute('aria-disabled', String(on));
  }
  get overlayInfo(): { changed: number; total: number } | null { return this.view?.overlayInfo ?? null; }
  compareImage(): CompareImage | null {
    if (!this.strip || !this.view.rect) return null;
    return { image: this.strip, rect: { ...this.view.rect }, key: `${this.name}|${this.snap ?? ''}|${this.frame}|${this.layerSolo}` };
  }
  debugInfo(): unknown {
    return { name: this.name, snap: this.snap, frame: this.frame, frames: this.nFrames, zoom: this.view.zoom, autoFit: this.view.autoFit, layerSolo: this.layerSolo, overlay: this.view.overlayMode, overlayInfo: this.view.overlayMode === 'diff' ? this.view.overlayInfo : null, split: this.view.split };
  }
}
