// Analysis images: what the agent SEES instead of hearing. Overview = waveform with beat grid and
// onsets, log-frequency spectrogram, loudness + energy over the arrangement, stereo field, bands.
// Mix view = per-stem spectra overlaid with masking highlights + stem balance.
import { encodePNG } from '../png.js';
import { FONT, FONT_H } from '../doc.js';
import { SR } from './dsp.js';

const BG = [18, 18, 24], GRID = [44, 44, 56], TXT = [200, 204, 214], DIM = [120, 124, 138];
const STEM_COLORS = [[255, 120, 90], [90, 200, 255], [250, 210, 80], [150, 230, 120], [220, 130, 255], [255, 160, 200], [120, 255, 220], [255, 255, 255], [200, 160, 110], [140, 140, 255]];

class Img {
  constructor(w, h) { this.w = w; this.h = h; this.d = new Uint8ClampedArray(w * h * 4); this.rect(0, 0, w, h, BG); }
  px(x, y, c, a = 1) {
    x |= 0; y |= 0;
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const p = (y * this.w + x) * 4;
    this.d[p] = this.d[p] * (1 - a) + c[0] * a; this.d[p + 1] = this.d[p + 1] * (1 - a) + c[1] * a; this.d[p + 2] = this.d[p + 2] * (1 - a) + c[2] * a; this.d[p + 3] = 255;
  }
  rect(x, y, w, h, c, a = 1) { for (let j = Math.max(0, y | 0); j < Math.min(this.h, (y + h) | 0); j++) for (let i = Math.max(0, x | 0); i < Math.min(this.w, (x + w) | 0); i++) this.px(i, j, c, a); }
  line(x0, y0, x1, y1, c, a = 1) {
    const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
    for (let k = 0; k <= n; k++) this.px(x0 + ((x1 - x0) * k) / n, y0 + ((y1 - y0) * k) / n, c, a);
  }
  vline(x, y0, y1, c, a = 1) { for (let y = y0; y <= y1; y++) this.px(x, y, c, a); }
  text(x, y, s, c = TXT) {
    for (const ch of String(s).toUpperCase()) {
      const g = FONT[ch] || FONT['?'];
      for (let gy = 0; gy < FONT_H; gy++) for (let gx = 0; gx < g[gy].length; gx++) if (g[gy][gx] === '1') this.px(x + gx, y + gy, c);
      x += g[0].length + 1;
    }
    return x;
  }
  png() { return encodePNG(this.w, this.h, this.d); }
}

function heat(v) {
  // v 0..1 -> dark blue -> purple -> orange -> yellow -> white
  const stops = [[0, [10, 10, 24]], [0.25, [60, 20, 110]], [0.5, [180, 40, 90]], [0.72, [245, 130, 30]], [0.9, [250, 230, 90]], [1, [255, 255, 240]]];
  for (let i = 1; i < stops.length; i++) if (v <= stops[i][0]) { const [a, ca] = stops[i - 1], [b, cb] = stops[i], t = (v - a) / (b - a); return ca.map((x, k) => x + (cb[k] - x) * t); }
  return stops[stops.length - 1][1];
}

const FMIN = 30, FMAX = 16000;
const yOfF = (f, top, h) => top + h - 1 - (Math.log(f / FMIN) / Math.log(FMAX / FMIN)) * (h - 1);

/** Overview image. a = {chs, meas, perception, loop, title, target_lufs, timeline}. */
export function overviewImage({ chs, meas, perception: p, loop, title, target_lufs = -14, timeline }) {
  const W = 900, L = 44, PW = W - L - 8;
  const H = 14 + 90 + 16 + 210 + 8 + 90 + 8 + 130 + 6;
  const img = new Img(W, H);
  const n = chs[0].length, dur = n / SR;
  const st = meas.stats;
  img.text(6, 4, `${title || ''}  ${dur.toFixed(2)}S  ${st.lufs} LUFS  PEAK ${st.peak_dbfs}  TP ${st.true_peak_dbtp}${p?.rhythm?.perceived_bpm && p.kind !== 'sfx' ? `  FELT ${Math.round(p.rhythm.perceived_bpm)} BPM` : ''}${p?.tonal ? `  ${p.tonal.key}` : ''}`);
  const xOf = (t) => L + (t / dur) * PW;
  // sections background (shared by every panel)
  const secs = timeline || [];
  const shadeSections = (top, h) => secs.forEach((s, i) => { if (i % 2) img.rect(xOf(s.start), top, xOf(s.end) - xOf(s.start), h, [255, 255, 255], 0.035); });
  // ---- waveform
  let y0 = 14;
  const wh = 90;
  img.rect(L, y0, PW, wh, [24, 24, 32]);
  shadeSections(y0, wh);
  const cols = PW;
  for (let c = 0; c < chs.length; c++) {
    const ch = chs[c], mid = y0 + (chs.length === 2 ? (c ? wh * 0.75 : wh * 0.25) : wh / 2), amp = chs.length === 2 ? wh / 4 - 1 : wh / 2 - 1;
    const col = c ? [120, 200, 255] : [255, 150, 110];
    for (let x = 0; x < cols; x++) {
      const a = Math.floor((x / cols) * n), b = Math.max(a + 1, Math.floor(((x + 1) / cols) * n));
      let mn = 1, mx = -1, s2 = 0;
      for (let i = a; i < b; i++) { const v = ch[i]; if (v < mn) mn = v; if (v > mx) mx = v; s2 += v * v; }
      img.vline(L + x, Math.round(mid - mx * amp), Math.round(mid - mn * amp), col, 0.55);
      const r = Math.sqrt(s2 / (b - a));
      img.vline(L + x, Math.round(mid - r * amp), Math.round(mid + r * amp), col, 0.9);
    }
  }
  img.text(4, y0 + 2, 'WAVE', DIM);
  // beat grid + bars
  const rh = p?.rhythm;
  if (rh?._grid?.barSec) {
    const g = rh._grid;
    for (let b = 0; g.t0 + b * g.barSec < dur; b++) { const x = Math.round(xOf(g.t0 + b * g.barSec)); img.vline(x, y0, y0 + wh + 15, [255, 255, 255], 0.25); }
  }
  if (rh?._beats) for (const bt of rh._beats) img.vline(Math.round(xOf(bt)), y0 + wh, y0 + wh + 4, [255, 255, 255], 0.5);
  if (loop) { img.vline(Math.round(xOf(loop[0] / SR)), y0, H - 140, [80, 255, 120], 0.8); img.vline(Math.round(xOf(loop[1] / SR)) - 1, y0, H - 140, [80, 255, 120], 0.8); }
  // onset strip
  y0 += wh;
  const os = { low: [[255, 90, 70], 6], snare: [[250, 220, 80], 9], high: [[90, 220, 255], 12] };
  if (rh?._onsets) for (const [b, [col, yy]] of Object.entries(os)) for (const o of rh._onsets[b] || []) img.vline(Math.round(xOf(o.t)), y0 + yy - 1, y0 + yy + 1, col);
  img.text(4, y0 + 5, 'HITS', DIM);
  // ---- spectrogram (log frequency)
  y0 += 16;
  const sh = 210;
  const sp = meas.spec, fr = sp.frames, binHz = sp.binHz;
  let ref = 1e-9;
  for (const f of fr) for (let k = 0; k < f.length; k++) if (f[k] > ref) ref = f[k];
  const rowBins = [];
  for (let y = 0; y < sh; y++) {
    const fHi = FMIN * Math.pow(FMAX / FMIN, (sh - y) / sh), fLo = FMIN * Math.pow(FMAX / FMIN, (sh - y - 1) / sh);
    rowBins.push([Math.max(1, Math.floor(fLo / binHz)), Math.max(1, Math.ceil(fHi / binHz))]);
  }
  for (let x = 0; x < PW; x++) {
    const fi = Math.min(fr.length - 1, Math.floor((x / PW) * fr.length)), f = fr[fi];
    for (let y = 0; y < sh; y++) {
      const [a, b] = rowBins[y];
      let m = 0;
      for (let k = a; k <= Math.min(b, f.length - 1); k++) if (f[k] > m) m = f[k];
      const db = 20 * Math.log10(m / ref + 1e-12);
      img.px(L + x, y0 + y, heat(Math.max(0, Math.min(1, (db + 90) / 90))));
    }
  }
  for (const f of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) {
    const y = Math.round(yOfF(f, y0, sh));
    for (let x = L; x < L + PW; x += 4) img.px(x, y, [255, 255, 255], 0.18);
    img.text(4, y - 2, f >= 1000 ? `${f / 1000}K` : `${f}`, DIM);
  }
  // ---- loudness + energy over arrangement
  y0 += sh + 8;
  const lh = 90;
  img.rect(L, y0, PW, lh, [24, 24, 32]);
  shadeSections(y0, lh);
  const yL = (v) => y0 + lh - 1 - ((Math.max(-40, Math.min(0, v)) + 40) / 40) * (lh - 1);
  for (const v of [-30, -20, -10]) { const y = Math.round(yL(v)); for (let x = L; x < L + PW; x += 3) img.px(x, y, GRID); img.text(4, y - 2, `${v}`, DIM); }
  const ty = Math.round(yL(target_lufs));
  for (let x = L; x < L + PW; x += 6) img.rect(x, ty, 3, 1, [80, 255, 120]);
  const lu = meas.loud;
  const plot = (arr, hop, off, col, a) => { let px = null, py = null; arr.forEach((v, i) => { const x = xOf(i * hop + off), y = yL(v); if (px !== null && v > -70) img.line(px, py, x, y, col, a); px = x; py = y; }); };
  plot(lu.momentary, 0.1, 0.2, [150, 150, 190], 0.5);
  if (lu.shortTerm.length > 1) plot(lu.shortTerm, 0.1, 1.5, [255, 210, 90], 1);
  img.text(4, y0 + 2, 'LUFS', DIM);
  if (p?.energy) for (const s of p.energy.segments) {
    const x0 = xOf(s.start), x1 = xOf(s.end), y = y0 + lh - 3 - s.energy * (lh - 14);
    img.rect(x0 + 1, y, Math.max(1, x1 - x0 - 2), 2, [255, 120, 200]);
    img.text(x0 + 2, y0 + 2, String(s.section).slice(0, Math.max(1, Math.floor((x1 - x0) / 4) - 1)), [255, 160, 220]);
  }
  // ---- bottom: goniometer, bands, key facts
  y0 += lh + 8;
  const G = 130;
  img.rect(L, y0, G, G, [24, 24, 32]);
  img.line(L, y0 + G, L + G, y0, GRID); img.line(L, y0, L + G, y0 + G, GRID); img.vline(L + G / 2, y0, y0 + G, GRID);
  if (chs.length === 2) {
    const [Lc, Rc] = chs;
    let pk = 1e-6; for (let i = 0; i < n; i += 7) pk = Math.max(pk, Math.abs(Lc[i]), Math.abs(Rc[i]));
    const step = Math.max(1, Math.floor(n / 25000));
    for (let i = 0; i < n; i += step) {
      const m = (Lc[i] + Rc[i]) / (2 * pk), s = (Lc[i] - Rc[i]) / (2 * pk);
      img.px(L + G / 2 + s * (G / 2 - 2), y0 + G / 2 - m * (G / 2 - 2), [120, 255, 170], 0.25);
    }
  }
  img.text(L + 3, y0 + 3, `CORR ${st.stereo.correlation}`, DIM);
  // bands
  const bx = L + G + 20, bw = 26;
  const bands = Object.entries(st.bands);
  const bmax = Math.max(1, ...bands.map(([, v]) => v));
  bands.forEach(([k, v], i) => {
    const h = (v / bmax) * (G - 20);
    img.rect(bx + i * (bw + 6), y0 + G - 10 - h, bw, h, [110, 140, 255]);
    img.text(bx + i * (bw + 6), y0 + G - 7, k.replace('low_mid', 'lmid').replace('presence', 'pres').slice(0, 4), DIM);
    img.text(bx + i * (bw + 6), y0 + G - 18 - h, `${Math.round(v)}`, TXT);
  });
  // facts
  let tx = bx + bands.length * (bw + 6) + 16, ty2 = y0 + 4;
  const facts = [];
  if (rh) facts.push(`DRUMS: ${rh.kick_pattern}`, `HATS: ${rh.hats}`, `FEEL: ${rh.drive_words}`, `SWING ${rh.swing}  TIGHT ${rh.timing_spread_ms}MS`);
  if (p?.timbre) facts.push(`TONE: ${p.timbre.brightness}`, `DIST: ${p.timbre.distortion_words}`, `SPACE: ${p.timbre.space}${p.timbre.reverb_rt60_s ? ` ${p.timbre.reverb_rt60_s}S` : ''}`);
  if (p?.tension) facts.push(`TENSION: ${p.tension.words}`);
  if (p?.genre?.ranking) facts.push(`STYLE: ${p.genre.ranking[0].genre} ${p.genre.ranking[0].match}`);
  for (const f of facts) { img.text(tx, ty2, f.slice(0, 48), TXT); ty2 += 9; }
  img.text(tx, y0 + G - 6, 'RED=KICK YEL=SNARE CYAN=HATS  PINK=ENERGY  GREEN=TARGET/LOOP', DIM);
  return img.png();
}

/** Mix image: per-stem 1/3-octave spectra with masking highlights, stem balance bars. */
export function mixImage(mix) {
  const W = 900, H = 330, L = 44, PW = W - L - 200, top = 16, ph = 240;
  const img = new Img(W, H);
  img.text(6, 4, `STEM SPECTRA (1/3 OCT)  MIX ${mix.mix_lufs} LUFS  DOMINANT: ${mix.dominant}`);
  const fs = mix.bands_hz;
  const xOf = (f) => L + (Math.log(f / fs[0]) / Math.log(fs[fs.length - 1] / fs[0])) * PW;
  const all = Object.values(mix.spectra).flat();
  const mx = Math.max(...all), mn = mx - 60;
  const yOf = (db) => top + ph - ((Math.max(mn, db) - mn) / 60) * ph;
  img.rect(L, top, PW, ph, [24, 24, 32]);
  for (const m of mix.masking) for (const f of m._bands || []) { const x0 = xOf(f / Math.pow(2, 1 / 6)), x1 = xOf(f * Math.pow(2, 1 / 6)); img.rect(x0, top, x1 - x0, ph, [255, 40, 40], 0.12 + Math.min(0.25, m.severity / 30)); }
  for (const f of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) { const x = Math.round(xOf(f)); img.vline(x, top, top + ph, GRID); img.text(x - 6, top + ph + 3, f >= 1000 ? `${f / 1000}K` : `${f}`, DIM); }
  for (let db = Math.ceil(mn / 10) * 10; db <= mx; db += 10) { const y = Math.round(yOf(db)); for (let x = L; x < L + PW; x += 3) img.px(x, y, GRID); }
  Object.entries(mix.spectra).forEach(([name, spec], si) => {
    const col = STEM_COLORS[si % STEM_COLORS.length];
    for (let i = 1; i < spec.length; i++) { img.line(xOf(fs[i - 1]), yOf(spec[i - 1]), xOf(fs[i]), yOf(spec[i]), col); img.line(xOf(fs[i - 1]), yOf(spec[i - 1]) + 1, xOf(fs[i]), yOf(spec[i]) + 1, col, 0.5); }
  });
  // legend + balance
  let y = top;
  const lx = L + PW + 14;
  img.text(lx, y, 'STEM   REL LU  MASKED', DIM); y += 10;
  const names = Object.keys(mix.spectra);
  for (const b of mix.balance) {
    const si = names.indexOf(b.stem), col = STEM_COLORS[si % STEM_COLORS.length];
    img.rect(lx, y, 6, 6, col);
    img.text(lx + 9, y, `${b.stem.slice(0, 9)}`, mix.buried.includes(b.stem) ? [255, 90, 90] : TXT);
    img.text(lx + 70, y, `${b.rel_lu}`, TXT);
    img.text(lx + 108, y, `${b.masked_pct}%`, b.masked_pct > 60 ? [255, 120, 90] : DIM);
    const w = Math.max(1, (30 + Math.max(-30, b.rel_lu)) * 1.6);
    img.rect(lx + 9, y + 7, w, 2, col);
    y += 14;
  }
  y += 6;
  img.text(lx, y, 'RED BANDS = MASKING', [255, 120, 120]); y += 9;
  for (const m of mix.masking.slice(0, 4)) { img.text(lx, y, `${m.stems.join('+').slice(0, 30)}`, DIM); y += 8; img.text(lx + 6, y, `${m.range_hz.join('-')}HZ`, DIM); y += 10; }
  return img.png();
}
