// Recordings for the `sample` SFX layer: the bundled bank (src/audio/samples/<bank>/*.wav, CC0 field recordings,
// see samples/CREDITS.md) by id ("guns/rifle_1"), or any .wav by absolute path (stereo is mixed down). Mono at SR.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SR } from './dsp.js';
import { decodeWAV, resampleHQ } from './wav.js';

export const SAMPLE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'samples');
const cache = new Map();

/** The bundled gun bank: {class: {weapon, near:[ids], far:[ids]}} (ids are "guns/<file>"). */
export function gunBank() {
  if (!cache.has('bank:guns')) {
    const b = JSON.parse(fs.readFileSync(path.join(SAMPLE_DIR, 'guns', 'bank.json'), 'utf8'));
    for (const v of Object.values(b)) { v.near = v.near.map((n) => `guns/${n}`); v.far = v.far.map((n) => `guns/${n}`); }
    cache.set('bank:guns', b);
  }
  return cache.get('bank:guns');
}

/** Every bundled sample id ("guns/rifle_1", ...). */
export function sampleIds() {
  if (!fs.existsSync(SAMPLE_DIR)) return [];
  return fs.readdirSync(SAMPLE_DIR, { withFileTypes: true }).filter((d) => d.isDirectory())
    .flatMap((d) => fs.readdirSync(path.join(SAMPLE_DIR, d.name)).filter((f) => f.endsWith('.wav')).map((f) => `${d.name}/${f.slice(0, -4)}`)).sort();
}

/** Mono Float32Array at SR for a bundled id ("guns/rifle_1") or an absolute .wav path (cached per file + mtime). */
export function loadSample(id) {
  let file;
  if (path.isAbsolute(id)) file = id;
  else if (/^[a-z0-9_]+\/[a-z0-9_]+$/i.test(id)) file = path.join(SAMPLE_DIR, `${id}.wav`);
  else throw new Error(`sample "${id}": use a bundled id (${sampleIds().slice(0, 4).join(', ')}, ...) or an absolute .wav path (C:/sfx/shot.wav)`);
  if (!fs.existsSync(file)) throw new Error(`sample "${id}" not found${path.isAbsolute(id) ? '' : `: bundled ids are ${sampleIds().join(', ')}`}`);
  if (!/\.wav$/i.test(file)) throw new Error(`sample "${id}": only .wav files (convert other formats first, or art_audio import them and export wav)`);
  const key = `${file}@${fs.statSync(file).mtimeMs}`;
  if (cache.has(key)) return cache.get(key);
  const w = decodeWAV(fs.readFileSync(file));
  let m = w.channels[0];
  if (w.channels.length > 1) { m = new Float32Array(m.length); for (const c of w.channels) for (let i = 0; i < m.length; i++) m[i] += c[i] / w.channels.length; }
  if (w.sr !== SR) m = resampleHQ(m, w.sr, SR);
  cache.set(key, m);
  return m;
}
