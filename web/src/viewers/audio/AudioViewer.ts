// Audio player: waveform (stereo) with playhead, seek and range selection, live spectrum while playing
// (average spectrum when stopped), play / loop / volume, and the server's analysis (image + listener
// report + stats) that the agent reads. Also plays exported .wav / .mp3 / .ogg / .opus files.
import type { AnyEvent, AudioInfo } from '@/lib/api/types';
import { api } from '@/lib/api/client';
import { getArrayBuffer, isAbort } from '@/lib/api/http';
import { audioWav, exportFile } from '@/lib/api/urls';
import { h, icon, themeColors, withAlpha, type ThemeColors } from '@/lib/util/dom';
import { fmtMs } from '@/lib/util/format';
import { store } from '@/lib/util/storage';
import { BaseViewer } from '../base';
import { button, group, label, link, range, spacer, toggle } from '../controls';
import type { Target, ViewerEnv } from '../types';
import { averageSpectrum, bars, freqX } from './fft';
import {
  ariaTime, autoAnalyze, computePeaks, decodeRate, downloadInfo, normSel, playbackPlan, playheadAt, rulerTicks, seekKey, selText,
  statRows, statusText, type Peaks, type Range,
} from './logic';
import { wavSampleRate } from './wav';

type AudioTarget = { kind: 'audio' | 'export'; name: string };

const ANALYSIS_ALT = 'Analysis image the agent reads: waveform, spectrogram, loudness';

export class AudioViewer extends BaseViewer {
  private kind: 'audio' | 'export' = 'audio';
  private name = '';
  private info: AudioInfo | null = null;
  private buffer: AudioBuffer | null = null;
  private fileRate: number | null = null;
  private avgSpectrum: Float32Array | null = null;
  private sel: Range | null = null;
  private pos: number | undefined;
  private fetchAbort: AbortController | null = null;
  private analysisSeq = 0;
  private analysisAbort: AbortController | null = null;
  // Web Audio (created on the first Play)
  private ac: AudioContext | null = null;
  private gain: GainNode | null = null;
  private analyser: AnalyserNode | null = null;
  private src: AudioBufferSourceNode | null = null;
  private startedAt = 0;
  private playRange: Range = [0, 0];
  private raf = 0;
  private liveDb: Float32Array<ArrayBuffer> | null = null;
  private liveMags: Float32Array | null = null;
  private barLevels: Float32Array | null = null;
  // waveform cache: peaks per (buffer, width), base image (background, selection, lanes, ruler, marks)
  private peaks: { buffer: AudioBuffer; width: number; ch: Peaks[] } | null = null;
  private base: HTMLCanvasElement | null = null;
  private baseDirty = true;
  private colors!: ThemeColors;
  private dpr = 1;
  private ariaText = '';
  // DOM
  private playBtn!: HTMLButtonElement;
  private loopCb!: HTMLInputElement;
  private vol!: HTMLInputElement;
  private timeEl!: HTMLElement;
  private selEl!: HTMLElement;
  private analyzeBtn!: HTMLButtonElement;
  private wavA!: HTMLAnchorElement;
  private wave!: HTMLCanvasElement;
  private spec!: HTMLCanvasElement;
  private report!: HTMLElement;
  private status!: HTMLElement;

  protected key(t: Target): string { return JSON.stringify([t.kind, (t as AudioTarget).name]); }

  protected build(): HTMLElement {
    const root = h('div', { class: 'viewer audio-viewer' });
    this.colors = themeColors();
    this.playBtn = button({ icon: 'play', text: 'Play', variant: 'primary', title: 'Play / pause (Space)', onClick: () => this.toggle() });
    const loop = toggle({ label: 'Loop', title: 'Loop the clip or the selection', checked: store.get('audioLoop', true), onChange: (on) => store.set('audioLoop', on) });
    this.loopCb = loop.input;
    this.vol = range({
      min: 0, max: 100, value: clampVol(store.get('volume', 70)), title: 'Volume',
      onInput: (v) => { if (this.gain) this.gain.gain.value = v / 100; store.set('volume', v); },
    });
    this.vol.setAttribute('aria-label', 'Volume');
    this.timeEl = h('span', { class: 'mono', text: '0.00 s' });
    this.selEl = h('span', { class: 'mono muted' });
    this.analyzeBtn = button({ text: 'Analyze', title: 'Server analysis: spectrogram, loudness, listener report', onClick: () => { void this.analyze(); } });
    this.wavA = link({ text: 'WAV', title: 'Download' });
    root.append(h('div', { class: 'vtoolbar' },
      group(this.playBtn, button({ icon: 'square', title: 'Stop', onClick: () => this.stop(true) }), loop.el),
      group(label('Vol'), this.vol), this.timeEl, this.selEl, spacer(), this.analyzeBtn, this.wavA));

    this.wave = h('canvas', { class: 'wave', tabindex: '0', role: 'slider', 'aria-label': 'Playhead', 'aria-valuemin': '0', 'aria-valuemax': '0', 'aria-valuenow': '0' });
    this.spec = h('canvas', { class: 'spectrum', role: 'img', 'aria-label': 'Spectrum' });
    this.report = h('div', { class: 'audio-report' });
    root.append(h('div', { class: 'audio-body' },
      h('div', { class: 'wave-wrap' }, this.wave),
      h('div', { class: 'spec-wrap' }, h('div', { class: 'panel-label', text: 'Spectrum' }), this.spec),
      this.report));
    this.status = h('div', { class: 'vstatus mono' });
    root.append(this.status);

    this.bindWave();
    this.onResize(root, () => this.layout());
    this.onDprChange(() => this.layout());
    this.addCleanup(() => this.release());
    return root;
  }

  protected envChanged(prev: ViewerEnv, next: ViewerEnv): void {
    if (prev.reviewsRev !== next.reviewsRev) { this.baseDirty = true; this.drawWave(); }
  }

  // ---- loading ----
  protected async load(target: Target): Promise<void> {
    const t = target as AudioTarget;
    const token = this.nextLoad();
    this.stop(true);
    this.kind = t.kind === 'export' ? 'export' : 'audio';
    this.name = t.name;
    const isFile = this.kind === 'export';
    this.sel = null;
    this.selEl.textContent = '';
    this.fetchAbort?.abort();
    this.analysisAbort?.abort();
    this.analysisSeq++;
    const ac = (this.fetchAbort = new AbortController());
    const url = isFile ? exportFile(t.name) : audioWav(t.name, { t: Date.now() });
    const dl = downloadInfo(this.kind, t.name);
    this.wavA.href = isFile ? exportFile(t.name, { download: true }) : audioWav(t.name, { download: true });
    this.wavA.setAttribute('download', dl.file);
    this.wavA.textContent = dl.text;
    this.wavA.title = `Download ${dl.file}`;
    this.analyzeBtn.disabled = isFile;
    this.analyzeBtn.title = isFile ? 'Analysis is for workspace audio (art_audio), not exported files' : 'Server analysis: spectrogram, loudness, listener report';
    this.info = isFile ? null : await api.audio(t.name, ac.signal).catch(() => null);
    if (!this.isCurrent(token)) return;
    this.report.replaceChildren();
    try {
      const buf = await getArrayBuffer(url, { signal: ac.signal });
      if (!this.isCurrent(token)) return;
      this.fileRate = wavSampleRate(buf);
      const decoded = await decode(buf, this.fileRate);
      if (!this.isCurrent(token)) return;
      this.buffer = decoded;
    } catch (e) {
      if (!this.isCurrent(token) || isAbort(e)) return;
      this.buffer = null;
      this.avgSpectrum = null;
      this.peaks = null;
      this.status.textContent = `${t.name}: ${(e as Error).message}`;
      this.baseDirty = true;
      this.drawWave();
      this.drawSpectrum(false);
      throw e;
    }
    const b = this.buffer;
    this.avgSpectrum = averageSpectrum(b.getChannelData(0));
    this.peaks = null;
    this.baseDirty = true;
    this.colors = themeColors();
    this.layout();
    this.setPos(undefined);
    this.status.textContent = statusText(t.name, this.info, { duration: b.duration, channels: b.numberOfChannels, sampleRate: this.fileRate ?? b.sampleRate });
    if (autoAnalyze(this.kind, b.duration)) void this.analyze();
  }

  // ---- drawing ----
  /** Size both canvases to their boxes × devicePixelRatio, then redraw. */
  private layout(): void {
    this.dpr = window.devicePixelRatio || 1;
    const dpr = this.dpr;
    const ww = this.wave.parentElement?.getBoundingClientRect();
    const wW = Math.max(1, Math.round((ww?.width ?? 0) * dpr)), wH = Math.max(1, Math.round(Math.max(120, ww?.height ?? 0) * dpr));
    if (this.wave.width !== wW || this.wave.height !== wH) { this.wave.width = wW; this.wave.height = wH; this.wave.style.height = wH / dpr + 'px'; this.baseDirty = true; }
    const sw = this.spec.parentElement?.getBoundingClientRect();
    const sW = Math.max(1, Math.round((sw?.width ?? 0) * dpr)), sH = Math.max(1, Math.round(140 * dpr));
    if (this.spec.width !== sW || this.spec.height !== sH) { this.spec.width = sW; this.spec.height = sH; this.spec.style.height = sH / dpr + 'px'; }
    this.drawWave();
    this.drawSpectrum(!!this.src);
  }

  private wavePeaks(width: number): Peaks[] {
    const b = this.buffer!;
    if (this.peaks?.buffer !== b || this.peaks.width !== width) {
      const chans = Math.min(2, b.numberOfChannels), ch: Peaks[] = [];
      for (let k = 0; k < chans; k++) ch.push(computePeaks(b.getChannelData(k), width));
      this.peaks = { buffer: b, width, ch };
    }
    return this.peaks.ch;
  }

  /** The static part of the waveform, redrawn only when the buffer, size, selection or marks change. */
  private renderBase(): HTMLCanvasElement {
    const W = this.wave.width, H = this.wave.height, dpr = this.dpr, c = this.colors;
    const base = (this.base ??= document.createElement('canvas'));
    if (base.width !== W || base.height !== H) { base.width = W; base.height = H; }
    const x = base.getContext('2d');
    this.baseDirty = false;
    if (!x) return base;
    x.fillStyle = c.canvasBg; x.fillRect(0, 0, W, H);
    const b = this.buffer;
    if (!b) return base;
    const d = b.duration || 1;
    if (this.sel) { x.fillStyle = withAlpha(c.blue, 0.18); x.fillRect((this.sel[0] / d) * W, 0, ((this.sel[1] - this.sel[0]) / d) * W, H); }
    const peaks = this.wavePeaks(W), lane = H / peaks.length;
    peaks.forEach((p, k) => {
      const mid = lane * k + lane / 2;
      x.fillStyle = c.kAudio;
      for (let i = 0; i < W; i++) x.fillRect(i, mid - p.max[i] * lane * 0.45, 1, Math.max(1, (p.max[i] - p.min[i]) * lane * 0.45));
      x.fillStyle = 'rgba(255,255,255,.08)'; x.fillRect(0, mid, W, 1);
    });
    // seconds ruler
    x.fillStyle = c.muted; x.font = `${10 * dpr}px ui-monospace, monospace`;
    for (const [t, text] of rulerTicks(b.duration)) { const px = (t / d) * W; x.fillRect(px, H - 6 * dpr, 1, 6 * dpr); x.fillText(text, px + 2, H - 8 * dpr); }
    // review time ranges
    for (const m of this.host.reviewMarks({ kind: this.kind, name: this.name })) {
      const [t0, t1] = m.time || [];
      if (t0 === undefined) continue;
      x.fillStyle = withAlpha(c.accent, 0.25); x.fillRect((t0 / d) * W, 0, Math.max(2, (((t1 ?? t0) - t0) / d) * W), H);
      x.fillStyle = c.accent; x.fillText(m.id, (t0 / d) * W + 3, 12 * dpr);
    }
    return base;
  }

  /** Blit the cached base, then the playhead (the only per-frame work while playing). */
  private drawWave(): void {
    if (this.dead) return;
    const x = this.wave.getContext('2d');
    if (!x) return;
    const base = this.baseDirty || !this.base || this.base.width !== this.wave.width || this.base.height !== this.wave.height ? this.renderBase() : this.base;
    x.clearRect(0, 0, this.wave.width, this.wave.height);
    x.drawImage(base, 0, 0);
    const b = this.buffer;
    if (b && this.pos !== undefined) { x.fillStyle = this.colors.accent; x.fillRect((this.pos / (b.duration || 1)) * this.wave.width, 0, 2 * this.dpr, this.wave.height); }
  }

  private drawSpectrum(live: boolean): void {
    if (this.dead || !this.spec.parentElement) return;
    const x = this.spec.getContext('2d');
    if (!x) return;
    const W = this.spec.width, H = this.spec.height, dpr = this.dpr, c = this.colors;
    x.fillStyle = c.canvasBg; x.fillRect(0, 0, W, H);
    let mags: Float32Array | null, sr = this.buffer?.sampleRate || 44100;
    if (live && this.analyser && this.ac) {
      const n = this.analyser.frequencyBinCount;
      if (this.liveDb?.length !== n) { this.liveDb = new Float32Array(n); this.liveMags = new Float32Array(n); }
      this.analyser.getFloatFrequencyData(this.liveDb);
      const db = this.liveDb, lin = this.liveMags!;
      for (let i = 0; i < n; i++) lin[i] = Math.pow(10, db[i] / 20);
      mags = lin;
      sr = this.ac.sampleRate;
    } else mags = this.avgSpectrum;
    if (!mags) return;
    const nBars = Math.max(1, Math.min(160, Math.floor(W / (3 * dpr))));
    const levels = (this.barLevels = bars(mags, sr, nBars, this.barLevels ?? undefined));
    x.fillStyle = live ? c.blue : c.kAudio;
    for (let i = 0; i < nBars; i++) {
      const hgt = levels[i] * (H - 14 * dpr);
      x.fillRect((i / nBars) * W, H - 12 * dpr - hgt, Math.max(1, W / nBars - dpr), hgt);
    }
    x.fillStyle = c.muted; x.font = `${10 * dpr}px ui-monospace, monospace`;
    for (const f of [50, 100, 500, 1000, 5000, 10000]) if (f < sr / 2) x.fillText(f >= 1000 ? `${f / 1000}k` : String(f), freqX(f, sr, W), H - 2 * dpr);
    x.fillText(live ? 'live' : 'average', W - 50 * dpr, 12 * dpr);
  }

  // ---- interaction ----
  private bindWave(): void {
    let drag: { t0: number; moved: boolean } | null = null;
    const opts = { signal: this.dispose.signal };
    const at = (e: PointerEvent): number => {
      const r = this.wave.getBoundingClientRect();
      return Math.max(0, Math.min(1, (e.clientX - r.left) / (r.width || 1))) * (this.buffer?.duration || 0);
    };
    this.wave.addEventListener('pointerdown', (e) => {
      if (!this.buffer) return;
      drag = { t0: at(e), moved: false };
      try { this.wave.setPointerCapture?.(e.pointerId); } catch { /* not capturable */ }
    }, opts);
    this.wave.addEventListener('pointermove', (e) => {
      if (!drag || !this.buffer) return;
      const t1 = at(e);
      if (Math.abs(t1 - drag.t0) > this.buffer.duration * 0.005) {
        drag.moved = true;
        this.sel = normSel(drag.t0, t1);
        this.selEl.textContent = selText(this.sel);
        this.baseDirty = true;
        this.drawWave();
      }
    }, opts);
    this.wave.addEventListener('pointerup', () => {
      if (!drag) return;
      const d = drag;
      drag = null;
      if (!d.moved) { this.sel = null; this.selEl.textContent = ''; this.baseDirty = true; this.seek(d.t0); }
      else if (this.env.reviewMode && this.sel) this.host.requestReview({ asset: `${this.kind}:${this.name}`, time: [this.sel[0], this.sel[1]] });
    }, opts);
    this.wave.addEventListener('pointercancel', () => { drag = null; }, opts);
    this.wave.addEventListener('keydown', (e) => {
      if (!this.buffer || e.ctrlKey || e.metaKey || e.altKey) return;
      const to = seekKey(e.key, e.shiftKey, this.pos ?? 0, this.buffer.duration);
      if (to === null) return;
      e.preventDefault();
      e.stopPropagation();
      this.seek(to);
    }, opts);
  }

  private setPos(p: number | undefined): void {
    this.pos = p;
    const d = this.buffer?.duration ?? 0, v = p ?? 0;
    const text = ariaTime(v, d);
    if (text !== this.ariaText) {
      this.ariaText = text;
      this.wave.setAttribute('aria-valuemax', d.toFixed(2));
      this.wave.setAttribute('aria-valuenow', v.toFixed(2));
      this.wave.setAttribute('aria-valuetext', text);
    }
    this.timeEl.textContent = `${v.toFixed(2)} s`;
  }

  seek(at: number): void {
    const was = !!this.src;
    this.stop(false);
    this.setPos(at);
    this.drawWave();
    if (was) this.play();
  }

  /** The AudioContext and its graph (gain -> analyser -> destination), created on the first Play. */
  private actx(): AudioContext {
    if (!this.ac) {
      const ac = new AudioContext();
      this.ac = ac;
      this.gain = ac.createGain();
      this.gain.gain.value = Number(this.vol.value) / 100;
      this.analyser = ac.createAnalyser();
      this.analyser.fftSize = 2048;
      this.analyser.smoothingTimeConstant = 0.7;
      this.gain.connect(this.analyser);
      this.analyser.connect(ac.destination);
    }
    return this.ac;
  }

  play(): void {
    if (!this.buffer || this.dead) return;
    const ac = this.actx();
    void ac.resume().catch(() => {});
    const plan = playbackPlan(this.pos, this.sel, this.buffer.duration, this.loopCb.checked);
    const src = ac.createBufferSource();
    src.buffer = this.buffer;
    src.connect(this.gain!);
    src.loop = plan.loop;
    if (plan.loopStart !== undefined) { src.loopStart = plan.loopStart; src.loopEnd = plan.loopEnd!; }
    src.start(0, plan.from, plan.duration);
    this.startedAt = ac.currentTime - plan.offset;
    this.playRange = plan.range;
    // onended also fires on stop(): only the current source resets the button
    src.onended = () => {
      if (this.src !== src) return;
      this.src = null;
      try { src.disconnect(); } catch { /* already */ }
      this.setPlaying(false);
      cancelAnimationFrame(this.raf);
      this.drawSpectrum(false);
    };
    this.src = src;
    this.setPlaying(true);
    const tick = () => {
      if (this.src !== src || this.dead) return;
      this.setPos(playheadAt(ac.currentTime - this.startedAt, this.playRange, src.loop));
      this.drawWave();
      this.drawSpectrum(true);
      this.raf = requestAnimationFrame(tick);
    };
    cancelAnimationFrame(this.raf);
    tick();
  }

  stop(reset: boolean): void {
    if (this.src) {
      const s = this.src;
      this.src = null;
      try { s.stop(); } catch { /* not started */ }
      try { s.disconnect(); } catch { /* already */ }
    }
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.setPlaying(false);
    if (reset) this.setPos(undefined);
    this.drawWave();
    this.drawSpectrum(false);
  }

  toggle(): void { if (this.src) this.stop(false); else this.play(); }

  private setPlaying(on: boolean): void {
    if (!this.playBtn) return;
    this.playBtn.replaceChildren(icon(on ? 'pause' : 'play'), on ? ' Pause' : ' Play');
    this.playBtn.setAttribute('aria-pressed', String(on));
  }

  // ---- analysis ----
  async analyze(): Promise<void> {
    if (!this.name || this.kind === 'export' || this.dead) return;
    const seq = ++this.analysisSeq, name = this.name;
    this.analysisAbort?.abort();
    const ac = (this.analysisAbort = new AbortController());
    const current = () => seq === this.analysisSeq && !this.dead;
    this.report.replaceChildren(h('div', { class: 'muted', text: 'Analyzing…' }));
    const t0 = performance.now();
    try {
      const r = await api.audioAnalysis(name, undefined, ac.signal);
      if (!current()) return;
      const rows = statRows(r.stats);
      this.report.replaceChildren(
        h('div', { class: 'panel-label', text: `Analysis (${fmtMs(performance.now() - t0)})` }),
        h('img', { class: 'analysis-img', src: `data:image/png;base64,${r.image}`, alt: ANALYSIS_ALT }),
        h('pre', { class: 'report-text', text: typeof r.report === 'string' ? r.report : JSON.stringify(r.report, null, 1) }),
        h('table', { class: 'kv' }, ...rows.map(([k, v]) => h('tr', null, h('th', { text: k }), h('td', { text: v })))));
    } catch (e) {
      if (!current() || isAbort(e)) return;
      this.report.replaceChildren(h('div', { class: 'error', text: (e as Error).message }));
    }
  }

  // ---- live / keys ----
  onEvent(ev: AnyEvent): void {
    if (ev.type === 'audio' && this.kind === 'audio' && ev.name === this.name && !ev.deleted) {
      this.later(300, () => { void Promise.resolve(this.load(this.target)).catch(() => {}); }, 'reload');
    }
  }

  onKey(_e: KeyboardEvent, k: string): boolean {
    if (k === ' ') { this.toggle(); return true; }
    return false;
  }

  debugInfo(): unknown {
    return {
      kind: this.kind, name: this.name, duration: this.buffer?.duration ?? null, fileRate: this.fileRate, playing: !!this.src,
      pos: this.pos ?? null, sel: this.sel, context: !!this.ac,
    };
  }

  /** Stop playback and release every audio resource, fetch and cached image (runs once on destroy). */
  private release(): void {
    this.fetchAbort?.abort();
    this.analysisAbort?.abort();
    this.analysisSeq++;
    if (this.src) { const s = this.src; this.src = null; try { s.stop(); } catch { /* not started */ } try { s.disconnect(); } catch { /* already */ } }
    cancelAnimationFrame(this.raf);
    try { this.gain?.disconnect(); } catch { /* already */ }
    try { this.analyser?.disconnect(); } catch { /* already */ }
    if (this.ac && this.ac.state !== 'closed') void this.ac.close().catch(() => {});
    this.ac = null; this.gain = null; this.analyser = null;
    this.buffer = null; this.avgSpectrum = null; this.peaks = null; this.liveDb = null; this.liveMags = null; this.barLevels = null;
    if (this.base) { this.base.width = 0; this.base.height = 0; this.base = null; }
  }
}

const clampVol = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : 70);

/** Decode on a short-lived OfflineAudioContext (no output device, no autoplay warning). */
async function decode(buf: ArrayBuffer, fileRate: number | null): Promise<AudioBuffer> {
  const oc = new OfflineAudioContext(1, 1, decodeRate(fileRate));
  return oc.decodeAudioData(buf);
}
