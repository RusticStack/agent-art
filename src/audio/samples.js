// Recordings for the `sample` SFX layer: any .wav by absolute path (stereo is mixed down), mono at SR.
import fs from 'node:fs';
import path from 'node:path';
import { SR } from './dsp.js';
import { decodeWAV, resampleHQ } from './wav.js';

const cache = new Map();

/** Mono Float32Array at SR for an absolute .wav path (cached per path + file mtime). */
export function loadSample(file) {
  if (!path.isAbsolute(file)) throw new Error(`sample "${file}": use an absolute .wav path (C:/sfx/shot.wav, forward slashes are fine)`);
  if (!fs.existsSync(file)) throw new Error(`sample "${file}" not found`);
  if (!/\.wav$/i.test(file)) throw new Error(`sample "${file}": only .wav files (convert other formats first, or art_audio import them and export wav)`);
  const key = `${file}@${fs.statSync(file).mtimeMs}`;
  if (cache.has(key)) return cache.get(key);
  const w = decodeWAV(fs.readFileSync(file));
  let m = w.channels[0];
  if (w.channels.length > 1) { m = new Float32Array(m.length); for (const c of w.channels) for (let i = 0; i < m.length; i++) m[i] += c[i] / w.channels.length; }
  if (w.sr !== SR) m = resampleHQ(m, w.sr, SR);
  cache.set(key, m);
  return m;
}
