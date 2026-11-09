// Animation player: plays a canvas's tags at their own timing (or all frames at an fps), loop, scale,
// and a per-view grid that plays every direction of the same animation side by side
// (rig outputs: "walk", "walk_front", "walk_back", ... laid out as a compass for 8 directions).
import type { AnyEvent, CanvasInfo } from '@/lib/api/types';
import { api } from '@/lib/api/client';
import { getBitmap } from '@/lib/api/http';
import { canvasGif, canvasPng } from '@/lib/api/urls';
import { checker } from '@/lib/util/checker';
import { h, icon } from '@/lib/util/dom';
import { playList, type PlayList } from '@/lib/util/playlist';
import { store } from '@/lib/util/storage';
import { BaseViewer } from '../base';
import { button, fillSelect, group, label, link, range, select, spacer, toggle } from '../controls';
import type { Target, ViewerEnv } from '../types';
import { compassSlots, layoutFor, type AnimCellSpec } from './directions';
import { cellPixel, clampScale, fitScale, statusText } from './logic';

type Info = Pick<CanvasInfo, 'name' | 'frames' | 'frameHeight' | 'animations' | 'meta'>;

interface Cell { c: HTMLCanvasElement; spec: AnimCellSpec; pl: PlayList; idx: number; next: number; scale: number }

export class AnimViewer extends BaseViewer {
  private name = '';
  private info: Info | null = null;
  private strip: ImageBitmap | null = null;
  private fh = 1;
  private views: string[] | null = null;
  private firstView: string | null = null;
  private rigResolved = false;
  private wantTag: string | undefined;
  private cells: Cell[] = [];
  private playing = true;
  private running = false;
  private userScale = 0;
  private scale = 0;
  // DOM
  private tagSel!: HTMLSelectElement;
  private playBtn!: HTMLButtonElement;
  private fpsIn!: HTMLInputElement;
  private fpsLabel!: HTMLElement;
  private loopCb!: HTMLInputElement;
  private dirCb!: HTMLInputElement;
  private scaleIn!: HTMLInputElement;
  private gifA!: HTMLAnchorElement;
  private stage!: HTMLElement;
  private status!: HTMLElement;

  protected key(t: Target): string { return JSON.stringify([t.kind, (t as { name?: string }).name ?? '']); }

  protected build(): HTMLElement {
    const root = h('div', { class: 'viewer anim-viewer' });
    this.tagSel = select({ title: 'Animation', onChange: () => this.layout() });
    this.playBtn = button({ icon: 'pause', title: 'Play / pause (Space)', onClick: () => this.toggle() });
    this.playBtn.setAttribute('aria-pressed', 'true');
    const fps = store.get('fps', 10);
    this.fpsIn = range({ min: 1, max: 30, value: fps, title: 'fps for untagged frames', onInput: (v) => { this.fpsLabel.textContent = `${v} fps`; store.set('fps', v); this.layout(true); } });
    this.fpsLabel = h('span', { class: 'mono', text: `${this.fpsIn.value} fps` });
    const loop = toggle({ label: 'Loop', title: 'Loop', checked: true, onChange: (on) => { if (on) this.ensureLoop(); } });
    const dir = toggle({ label: 'Per-view grid', title: 'Play every direction of this animation in a grid', checked: store.get('dirgrid', true), onChange: (on) => { store.set('dirgrid', on); this.layout(); } });
    this.loopCb = loop.input; this.dirCb = dir.input;
    this.scaleIn = range({ min: 1, max: 16, value: 0, title: 'Scale', onInput: (v) => { this.userScale = v; this.layout(true); } });
    this.gifA = link({ text: 'GIF', title: 'Download the selected animation as GIF' });
    root.append(h('div', { class: 'vtoolbar' },
      group(h('label', { class: 'toggle' }, 'Animation ', this.tagSel)),
      group(this.playBtn, loop.el),
      group(this.fpsIn, this.fpsLabel),
      group(dir.el),
      group(label('Scale'), this.scaleIn),
      spacer(),
      this.gifA));
    this.stage = h('div', { class: 'anim-stage' });
    this.status = h('div', { class: 'vstatus mono' });
    root.append(this.stage, this.status);
    this.onResize(this.stage, () => this.refit());
    this.addCleanup(() => { this.strip?.close?.(); this.strip = null; this.cells = []; });
    return root;
  }

  // ---- loading ----
  protected load(target: Target, _prev: Target | null): Promise<void> {
    const t = target as { name: string; tag?: string };
    if (t.name !== this.name) this.userScale = 0;
    this.name = t.name;
    this.wantTag = t.tag;
    return this.reload();
  }
  protected targetChanged(_prev: Target, next: Target): void {
    const tag = (next as { tag?: string }).tag;
    if (tag && this.info?.animations?.[tag] && tag !== this.tagSel.value) { this.tagSel.value = tag; this.layout(); }
  }

  async reload(): Promise<void> {
    const token = this.nextLoad();
    const name = this.name;
    let info: Info;
    try { info = await api.canvas(name); } catch (e) {
      if (!this.isCurrent(token)) return;
      this.info = null;
      this.stopCells();
      this.stage.textContent = 'Canvas not found';
      this.status.textContent = `${name} · ${(e as Error).message}`;
      throw e;
    }
    if (!this.isCurrent(token)) return;
    let bmp: ImageBitmap;
    try { bmp = await getBitmap(canvasPng(name, { t: Date.now() })); } catch (e) {
      if (!this.isCurrent(token)) return;
      this.status.textContent = `${name} · ${(e as Error).message}`;
      throw e;
    }
    if (!this.isCurrent(token)) { bmp.close?.(); return; }
    const old = this.strip;
    this.strip = bmp;
    old?.close?.();
    this.info = info;
    this.fh = info.frameHeight || bmp.height;
    this.rigResolved = false;
    this.resolveRig();
    const tags = Object.keys(info.animations || {});
    const want = this.wantTag;
    this.wantTag = undefined;
    const cur = this.tagSel.options.length ? this.tagSel.value : null;
    const keep = want && tags.includes(want) ? want : cur !== null && (cur === '' || tags.includes(cur)) ? cur : tags[0] ?? '';
    fillSelect(this.tagSel, tags.map((t) => ({ value: t, label: t })), { first: { value: '', label: 'all frames' }, keep });
    this.layout();
  }

  /** Rig views (+ mirrored) from the asset index; null without a rig or before the index is loaded. */
  private resolveRig(): boolean {
    const rigName = this.info?.meta?.rig;
    const before = JSON.stringify([this.views, this.firstView]);
    if (typeof rigName !== 'string') { this.views = null; this.firstView = null; this.rigResolved = true; return false; }
    const assets = this.host.assets();
    const rig = assets?.rigs?.find((r) => r.name === rigName) ?? null;
    this.views = rig ? [...(rig.views || []), ...(rig.mirror || [])] : null;
    this.firstView = rig?.views?.[0] || null;
    this.rigResolved = !!assets;
    return JSON.stringify([this.views, this.firstView]) !== before;
  }

  protected envChanged(prev: ViewerEnv, next: ViewerEnv): void {
    if (prev.assetsRev !== next.assetsRev && this.info && !this.rigResolved && this.resolveRig()) this.layout();
    if (prev.reviewMode !== next.reviewMode) for (const s of this.cells) s.c.tabIndex = next.reviewMode ? 0 : -1;
  }

  // ---- layout ----
  private currentScale(cols: number, rows: number, w: number, fh: number): { scale: number; capped: number | null } {
    const want = this.userScale || fitScale(this.stage.getBoundingClientRect(), w, fh, cols, rows);
    const c = clampScale(want, w, fh);
    return { scale: c.scale, capped: c.clamped ? c.scale : null };
  }

  /** Re-layout on stage resize when the scale is automatic and the fitted scale changed. */
  private refit(): void {
    if (!this.info || !this.strip || this.userScale) return;
    const lay = this.currentLayout();
    if (this.currentScale(lay.cols, lay.rows, this.strip.width, this.fh).scale !== this.scale) this.layout(true);
    else this.ensureLoop();
  }
  private currentLayout() {
    return layoutFor(this.tagSel.value, Object.keys(this.info?.animations || {}), this.views, this.firstView, this.dirCb.checked);
  }

  /** Build one cell per view. keep = keep each view's current frame (resize, fps, scale changes). */
  layout(keep = false): void {
    const info = this.info, strip = this.strip;
    if (!info || !strip) return;
    const tag = this.tagSel.value;
    this.gifA.href = canvasGif(this.name, { scale: 4, download: true, animation: tag || undefined });
    const lay = this.currentLayout();
    const w = strip.width, fh = this.fh;
    const { scale, capped } = this.currentScale(lay.cols, lay.rows, w, fh);
    this.scale = scale;
    this.scaleIn.value = String(scale);
    const oldIdx = new Map(keep ? this.cells.map((s) => [s.spec.tag, s.idx] as const) : []);
    this.stage.replaceChildren();
    this.stage.classList.toggle('compass', lay.compass);
    const grid = h('div', { class: 'anim-grid', style: { gridTemplateColumns: `repeat(${lay.cols}, auto)` } });
    const fps = Number(this.fpsIn.value);
    const figs: HTMLElement[] = [];
    this.cells = lay.cells.map((spec) => {
      const c = h('canvas', { class: 'anim-cell', role: 'img', 'aria-label': spec.label });
      c.width = w * scale; c.height = fh * scale;
      c.tabIndex = this.env.reviewMode ? 0 : -1;
      const pl = playList(info, spec.tag, fps);
      const st: Cell = { c, spec, pl, idx: Math.min(oldIdx.get(spec.tag) ?? 0, pl.frames.length - 1), next: 0, scale };
      c.addEventListener('click', (e) => {
        if (!this.env.reviewMode) return;
        this.pin(st, cellPixel(c.getBoundingClientRect(), e.clientX, e.clientY, w, fh));
      });
      c.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' || !this.env.reviewMode) return;
        e.preventDefault();
        e.stopPropagation();
        this.pin(st, [Math.floor(w / 2), Math.floor(fh / 2)]);
      });
      figs.push(h('figure', { class: 'anim-fig' }, c, h('figcaption', { text: spec.label })));
      return st;
    });
    if (lay.compass) {
      compassSlots(lay.cells).forEach((i, slot) => grid.append(i !== null ? figs[i] : h('figure', { class: 'anim-fig empty' }, slot === 4 ? h('span', { class: 'muted', text: lay.base ?? tag.replace(/_.*/, '') }) : null)));
    } else grid.append(...figs);
    this.stage.append(grid);
    this.status.textContent = statusText(this.name, tag, info, fps, lay.cells.length, capped);
    for (const s of this.cells) this.drawCell(s);
    this.ensureLoop();
  }

  private pin(st: Cell, point: [number, number]): void {
    const { tag, view } = st.spec;
    this.host.requestReview({
      asset: `canvas:${this.name}`,
      ...(tag ? { tag } : {}),
      ...(view && view !== 'default' ? { view } : {}),
      frame: st.pl.frames[st.idx],
      point,
    });
  }

  private drawCell(s: Cell): void {
    const strip = this.strip;
    const cx = s.c.getContext('2d');
    if (!cx || !strip) return;
    checker(cx, 0, 0, s.c.width, s.c.height, Math.max(4, s.scale * 2));
    cx.imageSmoothingEnabled = false;
    const f = s.pl.frames[s.idx] ?? 0;
    cx.drawImage(strip, 0, f * this.fh, strip.width, this.fh, 0, 0, s.c.width, s.c.height);
  }

  // ---- playback ----
  /** One rAF loop, only while playing and the stage is in the document. */
  private ensureLoop(): void {
    if (this.running || !this.playing || this.dead || !this.cells.length) return;
    this.running = true;
    this.animate((t) => {
      const go = this.playing && this.stage.isConnected && this.cells.length > 0;
      if (go) this.tick(t);
      else this.running = false;
      return go;
    });
  }
  tick(t: number): void {
    const loop = this.loopCb.checked;
    for (const s of this.cells) {
      if (!s.next) s.next = t + (s.pl.durations[s.idx] || 100);
      if (t < s.next) continue;
      let i = s.idx + 1;
      if (i >= s.pl.frames.length) { if (!loop || !s.pl.loop) continue; i = 0; }
      s.idx = i;
      // never fast-forward (hidden tab, long frame): the next frame is due one duration from now
      s.next = t + (s.pl.durations[i] || 100);
      this.drawCell(s);
    }
  }
  toggle(): void {
    this.playing = !this.playing;
    this.playBtn.replaceChildren(icon(this.playing ? 'pause' : 'play'));
    this.playBtn.setAttribute('aria-pressed', String(this.playing));
    if (this.playing) {
      for (const s of this.cells) {
        s.next = 0;
        // a finished one-shot animation starts again on play
        if (s.idx >= s.pl.frames.length - 1 && (!this.loopCb.checked || !s.pl.loop)) { s.idx = 0; this.drawCell(s); }
      }
      this.ensureLoop();
    }
  }
  get isPlaying(): boolean { return this.playing; }
  private stopCells(): void { this.cells = []; }

  // ---- live ----
  onEvent(ev: AnyEvent): void {
    if (!this.name) return;
    const reload = ev.type === 'resync' || (ev.type === 'change' && (ev as { canvas?: string }).canvas === this.name);
    if (reload) this.later(ev.type === 'resync' ? 0 : 120, () => { void this.reload().catch(() => {}); }, 'reload');
  }
  onKey(_e: KeyboardEvent, k: string): boolean {
    if (k === ' ') { this.toggle(); return true; }
    return false;
  }
  debugInfo(): unknown {
    return { name: this.name, tag: this.tagSel?.value, playing: this.playing, running: this.running, scale: this.scale, userScale: this.userScale, cells: this.cells.map((s) => ({ tag: s.spec.tag, view: s.spec.view, idx: s.idx, frame: s.pl.frames[s.idx] })) };
  }
}
