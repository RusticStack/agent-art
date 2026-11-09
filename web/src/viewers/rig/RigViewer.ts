// Rig viewer: parts sheet (cells + pivots), pose previews per view, skin mesh + weights, and clips (the
// rig's animated output canvases) played with a skeleton overlay built from the per-frame part anchors.
// Parts, pose and skin images are shown in a read-only PixelView (zoom, pan, fit); the server draws them.
import type { AnyEvent, CanvasInfo, RigInfo } from '@/lib/api/types';
import { api } from '@/lib/api/client';
import { getBitmap, isAbort } from '@/lib/api/http';
import { canvasPng, rigPreview, rigWeights } from '@/lib/api/urls';
import { checker } from '@/lib/util/checker';
import { h, icon } from '@/lib/util/dom';
import { playList, type PlayList } from '@/lib/util/playlist';
import { BaseViewer } from '../base';
import { button, fillSelect, group, label, range, select, spacer, toggle } from '../controls';
import { PixelView } from '../pixel/PixelView';
import type { RigTarget, Target, ViewerEnv } from '../types';
import { anchorIndex, baseStatus, clipFrameLabel, clipList, clipScale, fitCanvas, modeStatus, NO_CLIPS, pickMode, RIG_MODES, splitClip, type RigMode } from './logic';

interface ClipState {
  c: HTMLCanvasElement;
  canvas: string;
  tag: string;
  strip: ImageBitmap;
  fh: number;
  scale: number;
  dpr: number;
  clamped: boolean;
  info: CanvasInfo;
  pl: PlayList;
  idx: number;
  next: number;
  anchors: Record<string, number[]>[];
  tagFrames: number[];
}

export class RigViewer extends BaseViewer {
  private name = '';
  private rig: RigInfo | null = null;
  private mode: RigMode = 'clip';
  private playing = true;
  private outInfo: Record<string, CanvasInfo> = {};
  private parent: Record<string, string | undefined> = {};
  private pv: PixelView | null = null;
  private img: ImageBitmap | null = null;
  private clip: ClipState | null = null;
  private stopLoop: (() => void) | null = null;
  private showSeq = 0;
  private imgAbort: AbortController | null = null;
  // DOM
  private modeSel!: HTMLSelectElement;
  private skinOpt!: HTMLOptionElement;
  private poseSel!: HTMLSelectElement;
  private viewSel!: HTMLSelectElement;
  private clipSel!: HTMLSelectElement;
  private meshSel!: HTMLSelectElement;
  private boneSel!: HTMLSelectElement;
  private boneCb!: HTMLInputElement;
  private playBtn!: HTMLButtonElement;
  private scrub!: HTMLInputElement;
  private frameLabelEl!: HTMLElement;
  private poseG!: HTMLElement;
  private viewG!: HTMLElement;
  private clipG!: HTMLElement;
  private scrubG!: HTMLElement;
  private skinG!: HTMLElement;
  private stage!: HTMLElement;
  private status!: HTMLElement;

  protected key(t: Target): string { return JSON.stringify([t.kind, (t as RigTarget).name]); }

  protected build(): HTMLElement {
    const root = h('div', { class: 'viewer rig-viewer' });
    this.modeSel = select({ title: 'What to show', onChange: (v) => { this.mode = v as RigMode; void this.show(); } });
    for (const m of RIG_MODES) this.modeSel.append(h('option', { value: m.value, text: m.label }));
    this.skinOpt = this.modeSel.querySelector<HTMLOptionElement>('option[value="skin"]')!;
    this.skinOpt.hidden = true;
    this.meshSel = select({ title: 'Skin mesh', onChange: () => { this.fillBones(); void this.show(); } });
    this.boneSel = select({ title: 'Bone weights to show', onChange: () => void this.show() });
    this.poseSel = select({ title: 'Pose', onChange: () => void this.show() });
    this.viewSel = select({ title: 'View', onChange: () => void this.show() });
    this.clipSel = select({ title: 'Clip (output canvas / tag)', onChange: () => void this.show() });
    const bones = toggle({ label: 'Skeleton', title: 'Draw the skeleton from the part anchors', checked: true, onChange: () => this.drawClip() });
    this.boneCb = bones.input;
    this.playBtn = button({ icon: 'pause', title: 'Play / pause (Space)', onClick: () => this.toggle() });
    this.scrub = range({ min: 0, max: 0, value: 0, className: 'scrub', title: 'Clip frame', onInput: (v) => this.seek(v) });
    this.frameLabelEl = h('span', { class: 'mono' });
    this.poseG = group(label('Pose'), this.poseSel);
    this.viewG = group(label('View'), this.viewSel);
    this.clipG = group(label('Clip'), this.clipSel, this.playBtn, bones.el);
    this.scrubG = group(
      button({ icon: 'chevron-left', small: true, title: 'Previous frame (,)', onClick: () => this.step(-1) }),
      this.scrub,
      button({ icon: 'chevron-right', small: true, title: 'Next frame (.)', onClick: () => this.step(1) }),
      this.frameLabelEl);
    this.skinG = group(label('Mesh'), this.meshSel, label('Bone'), this.boneSel);
    root.append(h('div', { class: 'vtoolbar' },
      group(this.modeSel), this.poseG, this.viewG, this.clipG, this.scrubG, this.skinG, spacer(),
      button({ text: 'Edit parts', title: 'Open the parts canvas in the editor', onClick: () => this.host.open({ kind: 'canvas', name: `${this.name}_parts` }) })));
    this.stage = h('div', { class: 'rig-stage' });
    this.status = h('div', { class: 'vstatus mono' });
    root.append(this.stage, this.status);
    this.onResize(this.stage, () => this.refit());
    this.onDprChange(() => this.refit());
    this.addCleanup(() => { this.imgAbort?.abort(); this.clearStage(); });
    this.syncGroups();
    return root;
  }

  // ---- loading ----
  protected async load(target: Target, prev: Target | null): Promise<void> {
    const t = target as RigTarget;
    if (!prev || (prev as RigTarget).name !== t.name) { this.mode = 'clip'; this.playing = true; this.syncPlayBtn(); }
    this.name = t.name;
    await this.reload(t);
  }

  protected targetChanged(prev: Target, next: Target): void {
    const p = prev as RigTarget, t = next as RigTarget;
    if (!this.rig || (p.mode === t.mode && p.clip === t.clip)) return;
    this.preselect(t, clipList(Object.keys(this.outInfo), this.outInfo));
    void this.show();
  }

  protected envChanged(prev: ViewerEnv, next: ViewerEnv): void {
    if (prev.assetsRev !== next.assetsRev) this.scheduleReload();
  }

  /** Fetch the rig and its output canvases; `t` = a new target whose mode / clip preselect. */
  async reload(t?: RigTarget): Promise<void> {
    const token = this.nextLoad();
    const name = this.name;
    let rig: RigInfo;
    try { rig = await api.rig(name); } catch (e) {
      if (!this.isCurrent(token)) return;
      this.rig = null;
      this.clearStage();
      this.stage.append(h('div', { class: 'empty-note', text: (e as Error).message }));
      this.status.textContent = `${name}: ${(e as Error).message}`;
      throw e;
    }
    if (!this.isCurrent(token)) return;
    const outs = this.host.assets()?.rigs.find((r) => r.name === name)?.outputs ?? [];
    const infos = await Promise.all(outs.map((o) => api.canvas(o).catch(() => null)));
    if (!this.isCurrent(token)) return;
    this.rig = rig;
    this.outInfo = {};
    outs.forEach((o, i) => { const inf = infos[i]; if (inf) this.outInfo[o] = inf; });
    const views = [...rig.views, ...Object.keys(rig.mirror || {})];
    const opts = (xs: string[]) => xs.map((v) => ({ value: v, label: v }));
    fillSelect(this.poseSel, opts(Object.keys(rig.poses || {})), { first: { value: '', label: 'rest' } });
    fillSelect(this.viewSel, opts(views), { first: { value: '', label: 'all views' } });
    const clips = clipList(outs, this.outInfo);
    fillSelect(this.clipSel, opts(clips));
    this.skinOpt.hidden = !rig.skin;
    if (rig.skin) { fillSelect(this.meshSel, opts(Object.keys(rig.skin))); this.fillBones(); }
    this.parent = Object.fromEntries(Object.entries(rig.parts).map(([n, p]) => [n, p.parent]));
    if (t) this.preselect(t, clips);
    else this.mode = pickMode({ current: this.mode, hasClips: clips.length > 0, hasSkin: !!rig.skin });
    this.modeSel.value = this.mode;
    await this.show();
  }

  private preselect(t: RigTarget, clips: string[]): void {
    if (t.clip && clips.includes(t.clip)) this.clipSel.value = t.clip;
    this.mode = pickMode({ current: this.mode, requested: t.mode, hasClips: clips.length > 0, hasSkin: !!this.rig?.skin });
    this.modeSel.value = this.mode;
  }

  private fillBones(): void {
    const bones = this.rig?.skin?.[this.meshSel.value]?.bones || [];
    fillSelect(this.boneSel, bones.map((b) => ({ value: b, label: b })), { first: { value: '', label: 'dominant bone' } });
  }

  private scheduleReload(): void {
    if (this.name) this.later(200, () => { void this.reload().catch(() => {}); }, 'reload');
  }

  // ---- showing ----
  private syncGroups(): void {
    this.poseG.hidden = this.mode !== 'pose';
    this.viewG.hidden = this.mode !== 'pose' && this.mode !== 'skin';
    this.skinG.hidden = this.mode !== 'skin';
    this.clipG.hidden = this.mode !== 'clip';
    this.scrubG.hidden = this.mode !== 'clip' || !this.clip;
  }

  /** Drop whatever the stage shows (PixelView, clip canvas, rAF loop, bitmaps). */
  private clearStage(): void {
    this.stopLoop?.();
    this.stopLoop = null;
    this.pv?.destroy();
    this.pv = null;
    this.clip = null;
    this.img?.close?.();
    this.img = null;
    this.stage?.replaceChildren();
  }

  private showError(msg: string): void {
    this.clearStage();
    this.stage.append(h('div', { class: 'empty-note', role: 'alert', text: msg }));
  }

  async show(): Promise<void> {
    const seq = ++this.showSeq;
    this.imgAbort?.abort();
    const ac = (this.imgAbort = new AbortController());
    this.clearStage();
    this.syncGroups();
    const r = this.rig;
    if (!r) return;
    const stale = () => seq !== this.showSeq || this.dead;
    const base = baseStatus(this.name, r);
    if (this.mode === 'parts' || this.mode === 'pose' || this.mode === 'skin') {
      let url: string, alt: string;
      if (this.mode === 'parts') {
        url = canvasPng(`${this.name}_parts`, { t: Date.now() });
        alt = 'parts sheet';
        this.status.textContent = modeStatus(base, { mode: 'parts', name: this.name });
      } else if (this.mode === 'skin') {
        // legacy parameters: mesh, bone (unless dominant), view (unless all), t; no scale
        url = rigWeights(this.name, { mesh: this.meshSel.value, bone: this.boneSel.value || undefined, view: this.viewSel.value || undefined, t: Date.now() });
        alt = 'skin weights';
        this.status.textContent = modeStatus(base, { mode: 'skin', mesh: this.meshSel.value, bone: this.boneSel.value });
      } else {
        url = rigPreview(this.name, { pose: this.poseSel.value || undefined, view: this.viewSel.value || undefined, t: Date.now() });
        alt = 'pose preview';
        this.status.textContent = modeStatus(base, { mode: 'pose', pose: this.poseSel.value });
      }
      const host = h('div', { class: 'stage' });
      this.stage.append(host);
      const pv = (this.pv = new PixelView(host, { editable: false }));
      pv.setLabel(alt);
      let bmp: ImageBitmap;
      try { bmp = await getBitmap(url, { signal: ac.signal }); } catch (e) {
        if (isAbort(e) || stale()) return;
        this.showError((e as Error).message);
        return;
      }
      if (stale() || this.pv !== pv) { bmp.close?.(); return; }
      this.img = bmp;
      pv.setImage(bmp, { pixels: false });
      return;
    }
    // clip
    const [canvas, tag] = splitClip(this.clipSel.value || '');
    const info = this.outInfo[canvas];
    if (!info) {
      this.stage.append(h('div', { class: 'empty-note', text: NO_CLIPS }));
      this.status.textContent = base;
      return;
    }
    let strip: ImageBitmap;
    try { strip = await getBitmap(canvasPng(canvas, { t: Date.now() }), { signal: ac.signal }); } catch (e) {
      if (isAbort(e) || stale()) return;
      this.showError((e as Error).message);
      return;
    }
    if (stale()) { strip.close?.(); return; }
    const fh = info.frameHeight || strip.height;
    const c = h('canvas', { class: 'rig-canvas', role: 'img', 'aria-label': `clip ${canvas}/${tag}` });
    this.stage.append(h('div', { class: 'center-scroll' }, c));
    const pl = playList(info, tag);
    this.img = strip;
    const k: ClipState = {
      c, canvas, tag, strip, fh, scale: 1, dpr: 1, clamped: false, info, pl, idx: 0, next: 0,
      anchors: info.meta?.anchors?.[tag] || [], tagFrames: info.animations?.[tag]?.frames || [],
    };
    this.clip = k;
    c.addEventListener('click', (e) => this.reviewClick(e));
    this.scrub.max = String(Math.max(0, pl.frames.length - 1));
    this.syncGroups();
    this.fitClip();
    this.clipStatus(base);
    this.drawClip();
    this.syncLoop();
  }

  private clipStatus(base = this.rig ? baseStatus(this.name, this.rig) : this.name): void {
    const k = this.clip;
    if (!k) return;
    this.status.textContent = modeStatus(base, { mode: 'clip', clip: `${k.canvas}/${k.tag}`, frames: k.pl.frames.length, anchors: k.anchors.length > 0 })
      + (k.clamped ? ' · scale clamped to the canvas size limit' : '');
  }

  /** Integer scale that fits the stage; backing store at devicePixelRatio. True when it changed. */
  private fitClip(): boolean {
    const k = this.clip;
    if (!k) return false;
    const box = this.stage.getBoundingClientRect();
    const w = k.strip.width;
    const f = fitCanvas(w, k.fh, clipScale(box.width, box.height, w, k.fh), window.devicePixelRatio || 1);
    if (f.scale === k.scale && f.dpr === k.dpr && k.c.width > 0 && k.c.style.width) return false;
    k.scale = f.scale; k.dpr = f.dpr; k.clamped = f.clamped;
    k.c.width = Math.max(1, Math.round(w * f.scale * f.dpr));
    k.c.height = Math.max(1, Math.round(k.fh * f.scale * f.dpr));
    k.c.style.width = `${w * f.scale}px`;
    k.c.style.height = `${k.fh * f.scale}px`;
    return true;
  }

  private refit(): void {
    if (this.fitClip()) { this.clipStatus(); this.drawClip(); }
  }

  drawClip(): void {
    const k = this.clip;
    if (!k) return;
    const cx = k.c.getContext('2d');
    if (!cx) return;
    const s = k.scale, W = k.strip.width * s, H = k.fh * s;
    cx.setTransform(k.dpr, 0, 0, k.dpr, 0, 0);
    checker(cx, 0, 0, W, H, Math.max(4, s * 2));
    cx.imageSmoothingEnabled = false;
    const f = k.pl.frames[k.idx] ?? 0;
    cx.drawImage(k.strip, 0, f * k.fh, k.strip.width, k.fh, 0, 0, W, H);
    this.scrub.value = String(k.idx);
    this.frameLabelEl.textContent = clipFrameLabel(k.idx, k.pl.frames.length, f);
    this.scrub.setAttribute('aria-valuetext', `frame ${k.idx + 1} of ${k.pl.frames.length}`);
    if (!this.boneCb.checked) return;
    const an = k.anchors[anchorIndex(k.tagFrames, f, k.idx)];
    if (!an) return;
    const P = (n: string): [number, number] | null => { const a = an[n]; return a ? [(a[0] + 0.5) * s, (a[1] + 0.5) * s] : null; };
    cx.lineWidth = Math.max(1.5, s / 3);
    for (const n of Object.keys(an)) {
      const p = P(n), par = this.parent[n], q = par ? P(par) : null;
      if (p && q) { cx.strokeStyle = 'rgba(245,165,36,.9)'; cx.beginPath(); cx.moveTo(q[0], q[1]); cx.lineTo(p[0], p[1]); cx.stroke(); }
    }
    for (const n of Object.keys(an)) {
      const p = P(n);
      if (!p) continue;
      cx.fillStyle = this.parent[n] ? '#38bdf8' : '#e5484d';
      cx.beginPath(); cx.arc(p[0], p[1], Math.max(2, s / 2.5), 0, Math.PI * 2); cx.fill();
      if (s >= 4) { cx.fillStyle = 'rgba(230,233,239,.85)'; cx.font = '10px ui-monospace, monospace'; cx.fillText(n, p[0] + 4, p[1] - 4); }
    }
  }

  private reviewClick(e: MouseEvent): void {
    const k = this.clip;
    if (!k || !this.env.reviewMode) return;
    const r = k.c.getBoundingClientRect();
    this.host.requestReview({
      asset: `canvas:${k.canvas}`, tag: k.tag, frame: k.pl.frames[k.idx],
      point: [Math.floor((e.clientX - r.left) / k.scale), Math.floor((e.clientY - r.top) / k.scale)],
    });
  }

  // ---- playback ----
  /** One rAF loop, only in clip mode while playing. */
  private syncLoop(): void {
    const want = !!this.clip && this.playing && this.mode === 'clip' && this.clip.pl.frames.length > 1;
    if (want && !this.stopLoop) this.stopLoop = this.animate((t) => this.tick(t));
    else if (!want && this.stopLoop) { this.stopLoop(); this.stopLoop = null; }
  }

  private tick(t: number): void {
    const k = this.clip;
    if (!k || !this.playing) return;
    if (!k.next) k.next = t + (k.pl.durations[k.idx] || 100);
    if (t < k.next) return;
    k.idx = (k.idx + 1) % k.pl.frames.length;
    k.next = t + (k.pl.durations[k.idx] || 100);
    this.drawClip();
  }

  private syncPlayBtn(): void {
    this.playBtn?.replaceChildren(icon(this.playing ? 'pause' : 'play'));
    this.playBtn?.setAttribute('aria-pressed', String(this.playing));
  }

  toggle(): void {
    this.playing = !this.playing;
    if (this.clip) this.clip.next = 0;
    this.syncPlayBtn();
    this.syncLoop();
  }

  private pause(): void {
    if (!this.playing) return;
    this.playing = false;
    this.syncPlayBtn();
    this.syncLoop();
  }

  /** Step the clip by d play-list positions (pauses playback). */
  step(d: number): void {
    const k = this.clip;
    if (!k) return;
    this.pause();
    const n = k.pl.frames.length;
    k.idx = (((k.idx + d) % n) + n) % n;
    this.drawClip();
  }

  seek(i: number): void {
    const k = this.clip;
    if (!k) return;
    this.pause();
    k.idx = Math.max(0, Math.min(k.pl.frames.length - 1, Math.round(i)));
    this.drawClip();
  }

  // ---- live ----
  onEvent(ev: AnyEvent): void {
    if (!this.name) return;
    if (ev.type === 'resync') { this.scheduleReload(); return; }
    if (ev.type !== 'change') return;
    const c = (ev as { canvas?: string }).canvas;
    if (c && (c === `${this.name}_parts` || this.outInfo[c])) this.scheduleReload();
  }

  onKey(_e: KeyboardEvent, k: string): boolean {
    if (k === ' ') { this.toggle(); return true; }
    if (this.mode === 'clip' && this.clip && (k === ',' || k === '.')) { this.step(k === ',' ? -1 : 1); return true; }
    return false;
  }

  debugInfo(): unknown {
    const k = this.clip;
    return { name: this.name, mode: this.mode, playing: this.playing, looping: !!this.stopLoop, clip: k ? `${k.canvas}/${k.tag}` : null, idx: k?.idx ?? null, scale: k?.scale ?? null, image: !!this.img };
  }
}
