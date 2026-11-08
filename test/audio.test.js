// Audio: DSP correctness, WAV/loop round trip, notation, loudness meters, perception, art_audio tool.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SR, osc, adsr, biquadCoefs, biquadMag, makeRng, noise, magSpectrum } from '../src/audio/dsp.js';
import { encodeWAV, decodeWAV, findFfmpeg } from '../src/audio/wav.js';
import { loudness, truePeak, measure, toMono } from '../src/audio/analysis.js';
import { parseSongText, parseNotes, parseKey } from '../src/audio/notation.js';
import { renderSong } from '../src/audio/song.js';
import { renderSfx } from '../src/audio/sfx.js';
import { critiqueAudio } from '../src/audio/critique.js';
import { rhythm, tonal } from '../src/audio/perception.js';
import { runGenerator } from '../src/audio/generators.js';
import { runTool, TOOLS } from '../src/mcp.js';
import { Engine } from '../src/engine.js';
import { helpText } from '../src/docs.js';
import { SKILLS } from '../src/skills.js';

const sine = (sec, f, amp = 0.5) => osc(Math.round(sec * SR), f, { wave: 'sine', gain: amp });
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'aa-audio-'));

test('oscillator frequency and seeded determinism', () => {
  const x = osc(SR, 441, { wave: 'saw' });
  const m = magSpectrum(x, 0, 8192);
  let k = 1; for (let i = 2; i < m.length; i++) if (m[i] > m[k]) k = i;
  assert.ok(Math.abs((k * SR) / 8192 - 441) < 6, `peak ${(k * SR) / 8192}`);
  const a = noise(1000, 'pink', makeRng(7)), b = noise(1000, 'pink', makeRng(7)), c = noise(1000, 'pink', makeRng(8));
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, c);
});

test('biquad lowpass is -3 dB at cutoff; envelope timing', () => {
  const lp = biquadCoefs('lp', 1000, Math.SQRT1_2);
  assert.ok(Math.abs(20 * Math.log10(biquadMag(lp, 1000)) + 3.01) < 0.1);
  assert.ok(biquadMag(lp, 100) > 0.99 && biquadMag(lp, 8000) < 0.03);
  const e = adsr(SR, SR / 2, { a: 0.1, d: 0.1, s: 0.5, r: 0.1 });
  assert.ok(Math.abs(e[Math.round(0.1 * SR)] - 1) < 0.02, 'attack peak at 100 ms');
  assert.ok(Math.abs(e[Math.round(0.4 * SR)] - 0.5) < 0.03, 'sustain level');
  assert.equal(e[SR - 1], 0);
});

test('meters: -6 dBFS sine peak, BS.1770 loudness, true peak', () => {
  const x = sine(3, 1000, 0.5);
  const m = measure([x]);
  assert.ok(Math.abs(m.stats.peak_dbfs + 6.02) < 0.05, `peak ${m.stats.peak_dbfs}`);
  // mono 1 kHz sine at -6 dBFS: -3.01 (rms) - 0.691 + ~0.69 (K-weighting at 1k) - 6.02 ~= -9.03 LUFS
  assert.ok(Math.abs(loudness([x]).integrated + 9.03) < 0.3);
  assert.ok(truePeak([x]) <= 0.51);
  const clipped = Float32Array.from(sine(1, 200, 1.5), (v) => Math.max(-1, Math.min(1, v)));
  const crit = critiqueAudio(measure([clipped, clipped]).stats, { kind: 'music' });
  assert.equal(crit.issues[0].id, 'clipping');
});

test('WAV round trip keeps samples and the smpl loop chunk', () => {
  const L = sine(0.2, 300), R = sine(0.2, 450);
  for (const bits of [16, 24, 32]) {
    const w = decodeWAV(encodeWAV([L, R], { bits, loop: [100, 5000], dither: false }));
    assert.equal(w.channels.length, 2);
    assert.equal(w.channels[0].length, L.length);
    assert.ok(Math.abs(w.channels[1][777] - R[777]) < (bits === 16 ? 1e-4 : 1e-6));
    assert.deepEqual([w.loops[0].start, w.loops[0].end], [100, 5000]);
  }
});

test('notation: keys, notes, song text length; loops are seamless', () => {
  assert.equal(parseKey('e phrygian').scale.join(','), '0,1,3,5,7,8,10');
  const ev = parseNotes('Em _ . c4 | E5! E5 E5 E5', 2, { octave: 2 });
  assert.equal(ev.length, 6);
  assert.equal(ev[0].len, 0.5);
  const text = 'tempo 120\nkey a minor\nloop all\ntrack pad strings_pad\ntrack drums industrial_kit\nsection a 2\npad: Am | F\ndrums: @blast_beat style=four_floor bars=2';
  const r = renderSong(parseSongText(text));
  assert.equal(r.L.length, 4 * SR); // 2 bars of 4/4 at 120 BPM, loop tail wrapped onto the start
  const m = measure([r.L, r.R], { loop: r.loop });
  assert.equal(m.stats.seam.click, false);
  assert.ok(Math.abs(m.stats.lufs + 14) < 1, `lufs ${m.stats.lufs}`);
  assert.ok(m.stats.true_peak_dbtp <= -0.9);
});

test('perception: drum feel, perceived tempo and key are what was written', () => {
  for (const [style, want] of [['half_time', 'half_time'], ['blast', 'blast'], ['four_floor', 'four_on_the_floor']]) {
    const g = runGenerator({ generator: 'blast_beat', style, bars: 4, seed: 2 });
    const r = renderSong({ tempo: 128, loop: false, tracks: { d: { instrument: style === 'four_floor' ? 'industrial_kit' : 'metal_kit' } }, sections: { a: { bars: 4, d: g } } });
    const rh = rhythm(toMono([r.L, r.R]), { tempo: 128 });
    assert.equal(rh.kick_pattern, want, `${style}: ${JSON.stringify(rh.patterns)}`);
    assert.ok(Math.abs(rh.perceived_bpm - 128) < 3 || Math.abs(rh.perceived_bpm - 64) < 2, `bpm ${rh.perceived_bpm}`);
  }
  const s = renderSong(parseSongText('tempo 90\nkey a minor\ntrack p cathedral_organ:flute\ntrack b bass_guitar octave=1 root_only=true\nsection a 4\np: Am | Dm | Em | Am\nb: Am | Dm | Em | Am'));
  const t = tonal(toMono([s.L, s.R]), { bars: 4, barSec: 60 / 90 * 4 });
  assert.match(t.key, /^a (aeolian|harmonic_minor|dorian)/, t.key);
  assert.equal(t.chords_per_segment[1], 'Dm');
});

test('sfx: recipes are seeded, normalised and trimmed', () => {
  const a = renderSfx({ recipe: 'bone_crunch', seed: 3 }), b = renderSfx({ recipe: 'bone_crunch', seed: 3 }), c = renderSfx({ recipe: 'bone_crunch', seed: 4 });
  assert.deepEqual(a.chs[0], b.chs[0]);
  assert.notDeepEqual(a.chs[0].length === c.chs[0].length ? a.chs[0] : [], c.chs[0]);
  const st = measure(a.chs).stats;
  assert.ok(Math.abs(st.peak_dbfs + 1) < 0.6 && st.head_silence_ms < 5, JSON.stringify(st));
  assert.throws(() => renderSfx({ recipe: 'nope' }), /Recipes:/);
});

test('art_audio via runTool: sfx variants, song, analyze image, critique, export', async () => {
  const engine = new Engine({ home: tmp() });
  const call = (a) => runTool('art_audio', a, (op, args) => engine.run(op, args));
  const text = (c) => c.map((x) => x.text || '').join('\n');
  const sfx = await call({ action: 'sfx', name: 'gib', recipe: 'gib_burst', variants: 2, seed: 5 });
  assert.match(text(sfx), /gib_1[\s\S]*gib_2/);
  await call({ action: 'song', name: 'loop', text: 'tempo 140\nkey e phrygian\nloop all\ntrack g metal_guitar octave=2\ntrack drums metal_kit\nsection a 2\ng: @doom_riff style=chug bars=2\ndrums: @blast_beat style=blast bars=2' });
  const an = await call({ action: 'analyze', name: 'loop', intent: 'fast heavy metal with blast beats' });
  assert.ok(an.some((c) => c.type === 'image'));
  assert.match(text(an), /blast/);
  const cr = JSON.parse(text(await call({ action: 'critique', name: 'gib_1' })));
  assert.ok(cr.score >= 0 && Array.isArray(cr.issues));
  const ex = JSON.parse(text(await call({ action: 'export', name: 'gib_*', format: 'wav', bits: 24 })));
  assert.equal(ex.files.length, 2);
  assert.equal(decodeWAV(fs.readFileSync(ex.files[1])).bits, 24);
  if (findFfmpeg()) {
    const ogg = JSON.parse(text(await call({ action: 'export', name: 'loop', format: 'ogg' })));
    assert.ok(fs.statSync(ogg.files[0]).size > 1000);
  }
  await assert.rejects(() => call({ action: 'sfx', recipe: 'nope' }), /Recipes:/);
  assert.ok(TOOLS.some((t) => t.name === 'art_audio'));
});

test('docs and skills cover audio', () => {
  for (const t of ['audio', 'music', 'mixing', 'perception']) assert.ok(helpText({ topic: t }).length > 300, t);
  assert.match(helpText({ topic: 'music' }), /cathedral/i);
  assert.ok(SKILLS['sfx-pack'] && SKILLS['music-track']);
});
