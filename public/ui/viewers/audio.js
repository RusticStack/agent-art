// Audio player: waveform (stereo) with playhead, seek and range selection, live spectrum while
// playing (average spectrum when stopped), play / loop / volume, and the server's analysis
// (image + listener report + stats) that the agent reads.
import { el, enc, getJSON, fmtMs } from '../util.js';

/** In-place radix-2 FFT magnitude of a real window (n = power of two). */
function fftMag(input) {
  const n = input.length, re = Float32Array.from(input), im = new Float32Array(n);
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    for (let i = 0; i < n; i += len) for (let k = 0; k < len / 2; k++) {
      const wr = Math.cos(ang * k), wi = Math.sin(ang * k);
      const a = i + k, b = a + len / 2;
      const tr = re[b] * wr - im[b] * wi, ti = re[b] * wi + im[b] * wr;
      re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
    }
  }
  const out = new Float32Array(n / 2);
  for (let i = 0; i < n / 2; i++) out[i] = Math.hypot(re[i], im[i]) / n;
  return out;
}

export class AudioViewer {
  constructor(host, ctx) {
    this.ctx = ctx;
    this.root = el('div.viewer.audio-viewer');
    host.append(this.root);
    this.playBtn = el('button.btn.primary', { text: '▶ Play', title: 'Play / pause (Space)', on: { click: () => this.toggle() } });
    this.loopCb = el('input', { type: 'checkbox', checked: true });
    this.vol = el('input', { type: 'range', min: 0, max: 100, value: 70, title: 'Volume', on: { input: () => { if (this.gain) this.gain.gain.value = this.vol.value / 100; } } });
    this.timeEl = el('span.mono', { text: '0.00 s' });
    this.wavA = el('a.btn', { text: 'WAV', download: '' });
    this.root.append(el('div.vtoolbar', {},
      el('div.group', {}, this.playBtn, el('button.btn', { text: '■', title: 'Stop', on: { click: () => this.stop(true) } }), el('label.toggle', {}, this.loopCb, ' Loop')),
      el('div.group', {}, el('span.muted', { text: 'Vol' }), this.vol), this.timeEl,
      this.selEl = el('span.mono.muted'),
      el('div.spacer'),
      el('button.btn', { text: 'Analyze', title: 'Server analysis: spectrogram, loudness, listener report', on: { click: () => this.analyze() } }), this.wavA));
    this.wave = el('canvas.wave');
    this.spec = el('canvas.spectrum');
    this.report = el('div.audio-report');
    this.root.append(el('div.audio-body', {}, el('div.wave-wrap', {}, this.wave), el('div.spec-wrap', {}, el('div.panel-label', { text: 'Spectrum' }), this.spec), this.report));
    this.status = el('div.vstatus.mono');
    this.root.append(this.status);
    this.bindWave();
    this.ro = new ResizeObserver(() => { this.drawWave(); this.drawSpectrum(); });
    this.ro.observe(this.root);
  }
  actx() {
    if (!this.ac) {
      this.ac = new AudioContext();
      this.gain = this.ac.createGain();
      this.gain.gain.value = this.vol.value / 100;
      this.analyser = this.ac.createAnalyser();
      this.analyser.fftSize = 2048;
      this.analyser.smoothingTimeConstant = 0.7;
      this.gain.connect(this.analyser);
      this.analyser.connect(this.ac.destination);
    }
    return this.ac;
  }
  async open(target) {
    this.stop(true);
    this.target = target;
    this.sel = null;
    const isFile = target.kind === 'export';
    const url = isFile ? `/api/export-file?path=${enc(target.name)}` : `/api/audio/${enc(target.name)}.wav?t=${Date.now()}`;
    this.wavA.href = isFile ? url + '&download=1' : `/api/audio/${enc(target.name)}.wav?download=1`;
    this.wavA.setAttribute('download', `${target.name.split('/').pop().replace(/\.(wav|mp3|ogg|opus)$/i, '')}.wav`);
    this.info = isFile ? null : await getJSON(`/api/audio/${enc(target.name)}`).catch(() => null);
    this.report.innerHTML = '';
    try {
      const buf = await (await fetch(url)).arrayBuffer();
      this.buffer = await this.actx().decodeAudioData(buf);
    } catch (e) { this.status.textContent = `${target.name}: ${e.message}`; this.buffer = null; return; }
    this.avgSpectrum = this.computeAverage();
    this.drawWave();
    this.drawSpectrum();
    const st = this.info?.stats || this.info?.cache || {};
    this.status.textContent = [target.name, this.info?.kind, this.info?.recipe && `recipe ${this.info.recipe}`, `${this.buffer.duration.toFixed(2)} s`, `${this.buffer.numberOfChannels} ch`, `${this.buffer.sampleRate} Hz`,
      st.lufs !== undefined && `${st.lufs} LUFS`, st.peak_dbfs !== undefined && `peak ${st.peak_dbfs} dBFS`, st.score !== undefined && `score ${st.score}`, st.issues?.length ? `issues: ${st.issues.join(', ')}` : ''].filter(Boolean).join(' · ');
    if (!isFile && this.buffer.duration < 12) this.analyze();
  }
  computeAverage() {
    const b = this.buffer, n = 4096;
    const ch = b.getChannelData(0);
    const out = new Float32Array(n / 2);
    const count = Math.min(24, Math.max(1, Math.floor(ch.length / n)));
    const step = Math.max(n, Math.floor(ch.length / count));
    let used = 0;
    for (let s = 0; s + n <= ch.length && used < count; s += step, used++) {
      const w = new Float32Array(n);
      for (let i = 0; i < n; i++) w[i] = ch[s + i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)));
      const m = fftMag(w);
      for (let i = 0; i < m.length; i++) out[i] += m[i];
    }
    for (let i = 0; i < out.length; i++) out[i] /= Math.max(1, used);
    return out;
  }
  size(c) {
    const r = c.parentElement.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    c.width = Math.max(1, Math.round(r.width * dpr)); c.height = Math.max(1, Math.round((c === this.wave ? Math.max(120, r.height) : 140) * dpr));
    c.style.height = c.height / dpr + 'px';
    return dpr;
  }
  drawWave() {
    if (!this.buffer) return;
    const c = this.wave, dpr = this.size(c), x = c.getContext('2d');
    const W = c.width, H = c.height, b = this.buffer;
    x.fillStyle = '#15171c'; x.fillRect(0, 0, W, H);
    const chans = Math.min(2, b.numberOfChannels), lane = H / chans;
    if (this.sel) { x.fillStyle = 'rgba(56,189,248,.18)'; x.fillRect((this.sel[0] / b.duration) * W, 0, ((this.sel[1] - this.sel[0]) / b.duration) * W, H); }
    for (let k = 0; k < chans; k++) {
      const d = b.getChannelData(k), per = d.length / W, mid = lane * k + lane / 2;
      x.fillStyle = '#2dd4bf';
      for (let i = 0; i < W; i++) {
        let mn = 1, mx = -1;
        const s0 = Math.floor(i * per), s1 = Math.min(d.length, Math.floor((i + 1) * per) + 1);
        for (let s = s0; s < s1; s += Math.max(1, Math.floor((s1 - s0) / 64))) { const v = d[s]; if (v < mn) mn = v; if (v > mx) mx = v; }
        x.fillRect(i, mid - mx * lane * 0.45, 1, Math.max(1, (mx - mn) * lane * 0.45));
      }
      x.fillStyle = 'rgba(255,255,255,.08)'; x.fillRect(0, mid, W, 1);
    }
    // seconds ruler
    x.fillStyle = '#6b7280'; x.font = `${10 * dpr}px ui-monospace, monospace`;
    const stepS = b.duration > 20 ? 5 : b.duration > 5 ? 1 : b.duration > 1 ? 0.25 : 0.1;
    for (let t = 0; t <= b.duration; t += stepS) { const px = (t / b.duration) * W; x.fillRect(px, H - 6 * dpr, 1, 6 * dpr); x.fillText(t.toFixed(stepS < 1 ? 2 : 0), px + 2, H - 8 * dpr); }
    for (const m of this.ctx.app.reviewMarks?.(this.target) || []) {
      const [t0, t1] = m.time || [];
      if (t0 === undefined) continue;
      x.fillStyle = 'rgba(245,165,36,.25)'; x.fillRect((t0 / b.duration) * W, 0, Math.max(2, (((t1 ?? t0) - t0) / b.duration) * W), H);
      x.fillStyle = '#f5a524'; x.fillText(m.id, (t0 / b.duration) * W + 3, 12 * dpr);
    }
    if (this.pos !== undefined) { x.fillStyle = '#f5a524'; x.fillRect((this.pos / b.duration) * W, 0, 2 * dpr, H); }
  }
  drawSpectrum(live) {
    const c = this.spec;
    if (!c.parentElement) return;
    const dpr = this.size(c), x = c.getContext('2d');
    const W = c.width, H = c.height;
    x.fillStyle = '#15171c'; x.fillRect(0, 0, W, H);
    let mags, sr = this.buffer?.sampleRate || 44100;
    if (live && this.analyser) {
      const a = new Float32Array(this.analyser.frequencyBinCount);
      this.analyser.getFloatFrequencyData(a);
      mags = a.map((db) => Math.pow(10, db / 20));
      sr = this.ac.sampleRate;
    } else mags = this.avgSpectrum;
    if (!mags) return;
    const fmin = 20, fmax = sr / 2, bins = mags.length;
    const bars = Math.min(160, Math.floor(W / (3 * dpr)));
    for (let i = 0; i < bars; i++) {
      const f0 = fmin * Math.pow(fmax / fmin, i / bars), f1 = fmin * Math.pow(fmax / fmin, (i + 1) / bars);
      const b0 = Math.floor((f0 / fmax) * bins), b1 = Math.max(b0 + 1, Math.floor((f1 / fmax) * bins));
      let m = 0;
      for (let b = b0; b < Math.min(bins, b1); b++) m = Math.max(m, mags[b]);
      const db = 20 * Math.log10(m + 1e-9);
      const h = Math.max(0, Math.min(1, (db + 100) / 90)) * (H - 14 * dpr);
      x.fillStyle = live ? '#38bdf8' : '#2dd4bf';
      x.fillRect((i / bars) * W, H - 12 * dpr - h, Math.max(1, W / bars - dpr), h);
    }
    x.fillStyle = '#6b7280'; x.font = `${10 * dpr}px ui-monospace, monospace`;
    for (const f of [50, 100, 500, 1000, 5000, 10000]) { const px = (Math.log(f / fmin) / Math.log(fmax / fmin)) * W; x.fillText(f >= 1000 ? `${f / 1000}k` : String(f), px, H - 2 * dpr); }
    x.fillText(live ? 'live' : 'average', W - 50 * dpr, 12 * dpr);
  }
  bindWave() {
    let drag = null;
    const t = (e) => { const r = this.wave.getBoundingClientRect(); return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * (this.buffer?.duration || 0); };
    this.wave.addEventListener('pointerdown', (e) => { if (!this.buffer) return; drag = { t0: t(e), moved: false }; this.wave.setPointerCapture(e.pointerId); });
    this.wave.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const t1 = t(e);
      if (Math.abs(t1 - drag.t0) > this.buffer.duration * 0.005) { drag.moved = true; this.sel = [Math.min(drag.t0, t1), Math.max(drag.t0, t1)]; this.selEl.textContent = `sel ${this.sel[0].toFixed(2)}–${this.sel[1].toFixed(2)} s`; this.drawWave(); }
    });
    this.wave.addEventListener('pointerup', (e) => {
      if (!drag) return;
      if (!drag.moved) { this.sel = null; this.selEl.textContent = ''; this.seek(drag.t0); }
      else if (this.ctx.app.reviewMode) this.ctx.app.reviewPrompt({ asset: `audio:${this.target.name}`, time: this.sel });
      drag = null;
    });
  }
  seek(at) {
    const was = !!this.src;
    this.stop(false);
    this.pos = at;
    this.drawWave();
    if (was) this.play();
  }
  play() {
    if (!this.buffer) return;
    const ac = this.actx();
    ac.resume();
    const src = ac.createBufferSource();
    src.buffer = this.buffer;
    src.connect(this.gain);
    const [a, b] = this.sel || [0, this.buffer.duration];
    src.loop = this.loopCb.checked;
    if (this.sel) { src.loopStart = a; src.loopEnd = b; }
    let from = this.pos ?? a;
    if (from < a || from >= b) from = a;
    src.start(0, from, this.loopCb.checked ? undefined : b - from);
    this.startedAt = ac.currentTime - (from - a);
    this.range = [a, b];
    src.onended = () => { if (this.src === src) { this.src = null; this.playBtn.textContent = '▶ Play'; } };
    this.src = src;
    this.playBtn.textContent = '❚❚ Pause';
    const tick = () => {
      if (this.src !== src) return;
      const len = this.range[1] - this.range[0];
      let el2 = ac.currentTime - this.startedAt;
      if (src.loop) el2 %= len;
      this.pos = Math.min(this.range[1], this.range[0] + el2);
      this.timeEl.textContent = `${this.pos.toFixed(2)} s`;
      this.drawWave();
      this.drawSpectrum(true);
      this.rafId = requestAnimationFrame(tick);
    };
    tick();
  }
  stop(reset) {
    if (this.src) { const s = this.src; this.src = null; try { s.stop(); } catch { /* not started */ } }
    cancelAnimationFrame(this.rafId);
    this.playBtn.textContent = '▶ Play';
    if (reset) { this.pos = undefined; this.timeEl.textContent = '0.00 s'; }
    this.drawWave();
    this.drawSpectrum(false);
  }
  toggle() { if (this.src) this.stop(false); else this.play(); }
  async analyze() {
    if (!this.target || this.target.kind === 'export') return;
    this.report.innerHTML = '';
    this.report.append(el('div.muted', { text: 'Analyzing…' }));
    const t0 = performance.now();
    try {
      const r = await getJSON(`/api/audio/${enc(this.target.name)}/analysis`);
      this.report.innerHTML = '';
      const s = r.stats || {};
      const rows = Object.entries(s).filter(([, v]) => typeof v === 'number' || typeof v === 'string').slice(0, 24);
      this.report.append(
        el('div.panel-label', { text: `Analysis (${fmtMs(performance.now() - t0)})` }),
        el('img.analysis-img', { src: `data:image/png;base64,${r.image}`, alt: 'analysis' }),
        el('pre.report-text', { text: typeof r.report === 'string' ? r.report : JSON.stringify(r.report, null, 1) }),
        el('table.kv', {}, ...rows.map(([k, v]) => el('tr', {}, el('th', { text: k }), el('td', { text: typeof v === 'number' ? +v.toFixed(3) : v })))));
    } catch (e) { this.report.innerHTML = ''; this.report.append(el('div.error', { text: e.message })); }
  }
  onEvent(ev) {
    if (ev.type === 'audio' && this.target?.kind === 'audio' && ev.name === this.target.name && !ev.deleted) { clearTimeout(this.rt); this.rt = setTimeout(() => this.open(this.target), 300); }
  }
  keydown(e, k) { if (k === ' ') { this.toggle(); return true; } return false; }
  destroy() { this.stop(true); clearTimeout(this.rt); this.ro.disconnect(); this.ac?.close(); this.root.remove(); }
}
