// WAV read/write (16/24-bit PCM, 32-bit float; smpl loop chunk) and optional ffmpeg encode/decode.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { SR, makeRng } from './dsp.js';

/** Encode channels (Float32Array[]) to a WAV Buffer. bits: 16 | 24 | 32 (float). loop: [start, end) samples. */
export function encodeWAV(chs, { bits = 16, sr = SR, loop = null, dither = true, seed = 1 } = {}) {
  const nch = chs.length, n = chs[0].length;
  const float = bits === 32, bps = bits / 8;
  const dataLen = n * nch * bps;
  const smplLen = loop ? 36 + 24 : 0;
  const total = 12 + 24 + 8 + dataLen + (dataLen & 1) + (loop ? 8 + smplLen : 0);
  const b = Buffer.alloc(total);
  let o = 0;
  const str = (s) => { b.write(s, o, 'ascii'); o += 4; };
  const u32 = (v) => { b.writeUInt32LE(v >>> 0, o); o += 4; };
  const u16 = (v) => { b.writeUInt16LE(v, o); o += 2; };
  str('RIFF'); u32(total - 8); str('WAVE');
  str('fmt '); u32(16); u16(float ? 3 : 1); u16(nch); u32(sr); u32(sr * nch * bps); u16(nch * bps); u16(bits);
  str('data'); u32(dataLen);
  const rng = makeRng(seed);
  const q = bits === 16 ? 32767 : 8388607;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < nch; c++) {
      let v = chs[c][i];
      if (float) { b.writeFloatLE(v, o); o += 4; continue; }
      // TPDF dither (+-1 LSB) before quantising
      let s = v * q + (dither && bits === 16 ? rng.next() - rng.next() : 0);
      s = Math.round(s);
      if (s > q) s = q; else if (s < -q - 1) s = -q - 1;
      if (bits === 16) { b.writeInt16LE(s, o); o += 2; } else { b.writeIntLE(s, o, 3); o += 3; }
    }
  }
  if (dataLen & 1) o++;
  if (loop) {
    str('smpl'); u32(smplLen);
    u32(0); u32(0); u32(Math.round(1e9 / sr)); u32(60); u32(0); u32(0); u32(0); u32(1); u32(0);
    // one forward loop; end is the last sample played (inclusive)
    u32(0); u32(0); u32(loop[0]); u32(loop[1] - 1); u32(0); u32(0);
  }
  return b;
}

/** Decode a WAV Buffer -> {sr, channels: Float32Array[], bits, format, loops:[{start,end}]}. */
export function decodeWAV(buf) {
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') throw new Error('not a RIFF/WAVE file');
  let o = 12, fmt = null, data = null;
  const loops = [];
  while (o + 8 <= buf.length) {
    const id = buf.toString('ascii', o, o + 4), len = buf.readUInt32LE(o + 4), body = o + 8;
    if (id === 'fmt ') {
      let format = buf.readUInt16LE(body);
      const bits = buf.readUInt16LE(body + 14);
      if (format === 0xfffe && len >= 40) format = buf.readUInt16LE(body + 24); // WAVE_FORMAT_EXTENSIBLE
      fmt = { format, channels: buf.readUInt16LE(body + 2), sr: buf.readUInt32LE(body + 4), bits };
    } else if (id === 'data') data = [body, Math.min(len, buf.length - body)];
    else if (id === 'smpl') {
      const nl = buf.readUInt32LE(body + 28);
      for (let k = 0; k < nl; k++) { const lo = body + 36 + k * 24; loops.push({ start: buf.readUInt32LE(lo + 8), end: buf.readUInt32LE(lo + 12) + 1 }); }
    }
    o = body + len + (len & 1);
  }
  if (!fmt || !data) throw new Error('WAV missing fmt or data chunk');
  const { format, channels, bits } = fmt;
  const bps = bits / 8, frames = Math.floor(data[1] / (bps * channels));
  const chs = Array.from({ length: channels }, () => new Float32Array(frames));
  let p = data[0];
  for (let i = 0; i < frames; i++) for (let c = 0; c < channels; c++) {
    let v;
    if (format === 3) v = bits === 64 ? buf.readDoubleLE(p) : buf.readFloatLE(p);
    else if (bits === 16) v = buf.readInt16LE(p) / 32768;
    else if (bits === 24) v = buf.readIntLE(p, 3) / 8388608;
    else if (bits === 32) v = buf.readInt32LE(p) / 2147483648;
    else if (bits === 8) v = (buf[p] - 128) / 128;
    else throw new Error(`unsupported WAV bit depth ${bits}`);
    chs[c][i] = v;
    p += bps;
  }
  return { sr: fmt.sr, channels: chs, bits, format: format === 3 ? 'float' : 'pcm', loops };
}

// ---------- ffmpeg ----------
let ffCache;
export function findFfmpeg() {
  if (ffCache !== undefined) return ffCache;
  for (const cand of [process.env.AGENT_ART_FFMPEG, 'ffmpeg'].filter(Boolean)) {
    try {
      const r = spawnSync(cand, ['-hide_banner', '-version'], { encoding: 'utf8', timeout: 10000, windowsHide: true });
      if (r.status === 0) return (ffCache = { bin: cand, version: (r.stdout.match(/ffmpeg version (\S+)/) || [])[1] || '?' });
    } catch { /* not found */ }
  }
  return (ffCache = null);
}
const NO_FF = 'ffmpeg not found (set AGENT_ART_FFMPEG to its path or put it on PATH). Export format "wav" works without it.';

const CODECS = { mp3: ['libmp3lame', 'mp3'], ogg: ['libvorbis', 'ogg'], opus: ['libopus', 'opus'] };
/** Encode channels with ffmpeg to mp3 | ogg (Vorbis) | opus. loop -> LOOPSTART/LOOPLENGTH tags. */
export function encodeWithFfmpeg(chs, file, { format, bitrate, loop = null, sr = SR } = {}) {
  const ff = findFfmpeg();
  if (!ff) throw new Error(NO_FF);
  const [codec] = CODECS[format] || [];
  if (!codec) throw new Error(`format must be wav, mp3, ogg or opus (got ${format})`);
  const tmp = path.join(os.tmpdir(), `agent-art-${process.pid}-${Date.now()}.wav`);
  fs.writeFileSync(tmp, encodeWAV(chs, { bits: 32, sr }));
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', tmp, '-c:a', codec];
  const br = bitrate || (format === 'opus' ? 128 : 192);
  args.push('-b:a', `${String(br).replace(/k$/, '')}k`);
  if (loop) args.push('-metadata', `LOOPSTART=${loop[0]}`, '-metadata', `LOOPLENGTH=${loop[1] - loop[0]}`);
  args.push(file);
  const r = spawnSync(ff.bin, args, { encoding: 'utf8', timeout: 180000, windowsHide: true });
  fs.rmSync(tmp, { force: true });
  if (r.status !== 0) throw new Error(`ffmpeg failed (${format}): ${(r.stderr || r.error?.message || '').trim().slice(0, 400)}`);
  return { file, bytes: fs.statSync(file).size, ffmpeg: ff.version };
}

/** Decode any audio file (wav natively; mp3/ogg/flac/... via ffmpeg) -> {sr, channels}. */
export function decodeFile(file) {
  const buf = fs.readFileSync(file);
  if (buf.toString('ascii', 0, 4) === 'RIFF') {
    const w = decodeWAV(buf);
    return w.sr === SR ? w : { ...w, channels: w.channels.map((c) => resampleHQ(c, w.sr, SR)), sr: SR, loops: w.loops.map((l) => ({ start: Math.round((l.start * SR) / w.sr), end: Math.round((l.end * SR) / w.sr) })) };
  }
  const ff = findFfmpeg();
  if (!ff) throw new Error(`Cannot decode ${path.extname(file)} without ffmpeg. ${NO_FF.split('. ')[0]}; or convert it to WAV.`);
  const r = spawnSync(ff.bin, ['-hide_banner', '-loglevel', 'error', '-i', file, '-f', 'f32le', '-acodec', 'pcm_f32le', '-ac', '2', '-ar', String(SR), '-'], { timeout: 180000, maxBuffer: 1 << 30, windowsHide: true });
  if (r.status !== 0) throw new Error(`ffmpeg could not decode ${file}: ${String(r.stderr || '').trim().slice(0, 300)}`);
  const f = new Float32Array(r.stdout.buffer, r.stdout.byteOffset, Math.floor(r.stdout.length / 4));
  const n = f.length / 2, L = new Float32Array(n), R = new Float32Array(n);
  for (let i = 0; i < n; i++) { L[i] = f[2 * i]; R[i] = f[2 * i + 1]; }
  return { sr: SR, channels: [L, R], loops: [] };
}

// ---------- high-quality resampling (Kaiser-windowed sinc, polyphase table) ----------
export const SAMPLE_RATES = [44100, 48000];
const HALF = 32, PHASES = 512, BETA = 9;
function besselI0(x) { let s = 1, t = 1; for (let k = 1; k < 40; k++) { t *= (x / (2 * k)) * (x / (2 * k)); s += t; if (t < 1e-12 * s) break; } return s; }
const kernels = new Map();
/** sinc table for a cutoff fc (fraction of the input Nyquist), HALF zero crossings of the scaled kernel per side. */
function kernel(fc) {
  const key = fc.toFixed(6);
  if (kernels.has(key)) return kernels.get(key);
  const taps = Math.ceil(HALF / fc), len = taps * PHASES + 1, T = new Float32Array(len + 1), i0b = besselI0(BETA);
  for (let i = 0; i <= len; i++) {
    const d = i / PHASES, u = d / taps;
    const w = u >= 1 ? 0 : besselI0(BETA * Math.sqrt(1 - u * u)) / i0b;
    const a = Math.PI * fc * d;
    T[i] = w * fc * (d === 0 ? 1 : Math.sin(a) / a);
  }
  const k = { taps, T };
  kernels.set(key, k);
  return k;
}
/**
 * Resample x[start, start+len) to exactly outLen samples. periodic: the segment repeats (a loop
 * body), so its edges read around the loop instead of off it; otherwise samples outside x are 0.
 */
function resampleSegment(x, start, len, outLen, periodic) {
  const out = new Float32Array(outLen);
  if (!len || !outLen) return out;
  const step = len / outLen, fc = Math.min(1, outLen / len) * 0.97, { taps, T } = kernel(fc);
  for (let i = 0; i < outLen; i++) {
    const p = start + i * step, c = Math.floor(p);
    let s = 0;
    for (let j = c - taps + 1; j <= c + taps; j++) {
      const d = Math.abs(p - j) * PHASES, di = d | 0;
      if (di >= T.length - 1) continue;
      const h = T[di] + (T[di + 1] - T[di]) * (d - di);
      let idx = j;
      if (periodic) idx = start + ((((j - start) % len) + len) % len);
      else if (j < 0 || j >= x.length) continue;
      s += x[idx] * h;
    }
    out[i] = s;
  }
  return out;
}
/** High-quality resample of one channel (from -> to Hz). */
export function resampleHQ(x, from, to) {
  if (from === to) return x;
  return resampleSegment(x, 0, x.length, Math.round((x.length * to) / from), false);
}
/**
 * Resample channels and keep loop points sample-exact: head [0,s), loop body [s,e) (resampled as a
 * periodic segment so the seam stays seamless) and any tail after e are converted separately.
 * -> {chs, loop:[s', e'] | null}
 */
export function resampleLoop(chs, from, to, loop = null) {
  if (from === to) return { chs, loop };
  if (!loop) return { chs: chs.map((c) => resampleHQ(c, from, to)), loop: null };
  const r = to / from, [s, e] = loop, n = chs[0].length;
  const s2 = Math.round(s * r), body2 = Math.max(1, Math.round((e - s) * r)), tail2 = Math.round((n - e) * r);
  const out = chs.map((x) => {
    const head = resampleSegment(x, 0, s, s2, false), body = resampleSegment(x, s, e - s, body2, true), tail = resampleSegment(x, e, n - e, tail2, false);
    const y = new Float32Array(s2 + body2 + tail2);
    y.set(head, 0); y.set(body, s2); y.set(tail, s2 + body2);
    return y;
  });
  return { chs: out, loop: [s2, s2 + body2] };
}

/** Linear-interpolation resampler (adequate for imported samples / references). */
export function resample(x, from, to) {
  if (from === to) return x;
  const n = Math.floor((x.length * to) / from), out = new Float32Array(n), k = from / to;
  for (let i = 0; i < n; i++) { const p = i * k, j = p | 0, f = p - j; out[i] = x[j] + ((x[j + 1] ?? x[j]) - x[j]) * f; }
  return out;
}
