// Sprite sheet preview: every frame laid out like the spritesheet export (one row per animation tag),
// with frame numbers, durations and per-frame anchors (rig part pivots / model sockets). Also draws an
// exported sheet PNG + Aseprite-style JSON (frame rects and anchors) from exports/ (target kind 'export';
// the export viewer embeds this class through the normal mount, see mountInto).
import type { AnyEvent } from '@/lib/api/types';
import { api } from '@/lib/api/client';
import { getBitmap } from '@/lib/api/http';
import { canvasPng, exportFile } from '@/lib/api/urls';
import { h } from '@/lib/util/dom';
import { BaseViewer } from '../base';
import { button, group, label, range, spacer, toggle } from '../controls';
import type { Target, ViewerEnv } from '../types';
import { autoScale, canvasCells, clampSheetScale, drawSheet, exportCells, layoutCells, type SheetJson, type SrcCell } from './drawSheet';

/** Env for an embedded sheet (the sheet reads none of it). */
const EMBED_ENV: ViewerEnv = { tool: 'pencil', color: { hex: '#000000', hex8: '#000000ff' }, reviewMode: false, following: false, reviewsRev: 0, assetsRev: 0, compareLink: false, compareOverlay: 'off', peerRev: 0 };

export const sheetFiles = (name: string): { png: string; json: string } => ({ png: name.replace(/\.json$/i, '.png'), json: name.replace(/\.png$/i, '.json') });

export class SheetViewer extends BaseViewer {
  private kind: 'canvas' | 'export' = 'canvas';
  private name = '';
  private img: ImageBitmap | null = null;
  private src: SrcCell[] = [];
  private baseStatus = '';
  private userScale = 0;
  private scale = 0;
  private drawnKey = '';
  // DOM
  private anchorsCb!: HTMLInputElement;
  private labelsCb!: HTMLInputElement;
  private scaleIn!: HTMLInputElement;
  private legend!: HTMLElement;
  private scroll!: HTMLElement;
  private canvas!: HTMLCanvasElement;
  private status!: HTMLElement;

  /** Embedded use (export viewer): mount into el without an app env. */
  mountInto(el: HTMLElement, target: Target): void | Promise<void> {
    return this.mount(el, { target, env: EMBED_ENV });
  }

  protected key(t: Target): string { return JSON.stringify([t.kind, (t as { name?: string }).name ?? '']); }

  protected build(): HTMLElement {
    const root = h('div', { class: 'viewer sheet-viewer' });
    const anchors = toggle({ label: 'Anchors', title: 'Show per-frame anchors', checked: true, onChange: () => this.draw() });
    const labels = toggle({ label: 'Labels', title: 'Show frame labels and durations', checked: true, onChange: () => this.draw() });
    this.anchorsCb = anchors.input; this.labelsCb = labels.input;
    this.scaleIn = range({ min: 1, max: 12, value: 0, title: 'Scale', onInput: (v) => { this.userScale = v; this.draw(); } });
    this.legend = h('div', { class: 'legend' });
    root.append(h('div', { class: 'vtoolbar' },
      group(anchors.el, labels.el),
      group(label('Scale'), this.scaleIn),
      spacer(),
      this.legend,
      button({ icon: 'download', text: 'PNG', title: 'Download the composed sheet as PNG', onClick: () => this.download() })));
    this.scroll = h('div', { class: 'sheet-scroll' });
    this.canvas = h('canvas', { class: 'sheet-canvas', role: 'img', 'aria-label': 'Sprite sheet' });
    this.scroll.append(this.canvas);
    this.status = h('div', { class: 'vstatus mono' });
    root.append(this.scroll, this.status);
    this.onResize(this.scroll, () => { if (!this.userScale) this.draw(); });
    this.addCleanup(() => { this.img?.close?.(); this.img = null; });
    return root;
  }

  // ---- loading ----
  protected load(target: Target, _prev: Target | null): Promise<void> {
    const t = target as { kind: string; name: string };
    if (t.name !== this.name || t.kind !== this.kind) this.userScale = 0;
    this.kind = t.kind === 'export' ? 'export' : 'canvas';
    this.name = t.name;
    return this.reload();
  }

  async reload(): Promise<void> {
    const token = this.nextLoad();
    const name = this.name;
    try {
      if (this.kind === 'export') {
        const { png, json } = sheetFiles(name);
        const [img, j] = await Promise.all([getBitmap(exportFile(png)), api.exportJSON<SheetJson>(json).catch(() => null)]);
        if (!this.isCurrent(token)) { img.close?.(); return; }
        const src = exportCells(j, png, img.width, img.height);
        this.setImage(img, src, `${png} · ${img.width}×${img.height}${j ? ` · ${src.length} frames · ${j.meta?.frameTags?.length || 0} tags` : ' · no json sidecar'}`);
      } else {
        const [info, img] = await Promise.all([api.canvas(name), getBitmap(canvasPng(name, { t: Date.now() }))]);
        if (!this.isCurrent(token)) { img.close?.(); return; }
        const c = canvasCells(info, img.width, img.height);
        this.setImage(img, c.cells, `${name} · ${c.rows} row(s) · ${c.cells.length} cells · anchors: ${c.anchorNames.join(', ') || 'none'}`);
      }
    } catch (e) {
      if (!this.isCurrent(token)) return;
      this.status.textContent = `${name} · ${(e as Error).message}`;
      throw e;
    }
  }
  private setImage(img: ImageBitmap, src: SrcCell[], status: string): void {
    const old = this.img;
    this.img = img;
    old?.close?.();
    this.src = src;
    this.baseStatus = status;
    this.drawnKey = '';
    this.draw();
  }

  // ---- drawing ----
  draw(): void {
    const img = this.img;
    if (!img) return;
    const exportMode = this.kind === 'export';
    const labels = this.labelsCb.checked, anchors = this.anchorsCb.checked;
    const want = this.userScale || autoScale(this.src, this.scroll.getBoundingClientRect().width);
    const { scale, clamped } = clampSheetScale(this.src, want, labels, exportMode);
    const key = JSON.stringify([scale, labels, anchors]);
    if (key === this.drawnKey) return;   // resize without a scale change
    this.drawnKey = key;
    this.scale = scale;
    this.scaleIn.value = String(scale);
    const cells = layoutCells(this.src, scale, labels, exportMode);
    const names = drawSheet(this.canvas, img, cells, { scale, showAnchors: anchors, labels });
    this.canvas.setAttribute('aria-label', `${this.name} sprite sheet, ${cells.length} frames at ${scale}×`);
    this.legend.replaceChildren(...[...names].map(([n, col]) => h('span', { class: 'legend-item' }, h('i', { style: { background: col } }), n)));
    this.status.textContent = this.baseStatus + (clamped ? ` · scale capped at ${scale}× (canvas size limit)` : '');
  }

  /** Download the composed sheet (what is drawn now) as PNG. */
  private download(): void {
    if (!this.img || typeof this.canvas.toBlob !== 'function') return;
    const file = `${(this.name.split('/').pop() || 'sheet').replace(/\.(png|json)$/i, '')}_sheet.png`;
    this.canvas.toBlob((blob) => {
      if (!blob || this.dead) return;
      const url = URL.createObjectURL(blob);
      const a = h('a', { href: url, download: file });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 0);
    }, 'image/png');
  }

  // ---- live ----
  onEvent(ev: AnyEvent): void {
    if (this.kind === 'export' || !this.name) return;
    const reload = ev.type === 'resync' || (ev.type === 'change' && (ev as { canvas?: string }).canvas === this.name);
    if (reload) this.later(ev.type === 'resync' ? 0 : 150, () => { void this.reload().catch(() => {}); }, 'reload');
  }
  onKey(_e: KeyboardEvent, _k: string): boolean { return false; }
  debugInfo(): unknown {
    return { kind: this.kind, name: this.name, cells: this.src.length, scale: this.scale, userScale: this.userScale, width: this.canvas?.width, height: this.canvas?.height };
  }
}
