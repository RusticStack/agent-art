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
import { renderSfx, RECIPE_GROUPS, sfxrPreset } from '../src/audio/sfx.js';
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

// ---- FPS recipes + layered-sfx fixes ----
test('sfx: FPS recipes render, honour environment/surface vars and loopable ones loop seamlessly', () => {
  for (const g of ['firearms', 'weapon_handling', 'scifi', 'movement']) for (const recipe of RECIPE_GROUPS[g]) {
    const o = renderSfx({ recipe, seed: 3 });
    const st = measure(o.chs, { loop: o.loop }).stats;
    assert.ok(st.duration > 0.03 && st.duration < 6, `${recipe} ${st.duration}`);
    assert.ok(st.peak_dbfs <= -0.5 && st.peak_dbfs > -8, `${recipe} peak ${st.peak_dbfs}`);
    assert.ok(Math.abs(st.dc_offset) < 0.003, `${recipe} dc ${st.dc_offset}`);
    if (o.loop) assert.equal(st.seam.click, false, recipe);
  }
  const dur = (vars) => measure(renderSfx({ recipe: 'gunshot_rifle', vars }).chs).stats.duration;
  assert.ok(dur({ environment: 'canyon' }) > dur({ environment: 'indoor' }) + 1, 'canyon tail is longer than indoor');
  assert.ok(measure(renderSfx({ recipe: 'gunshot_marksman' }).chs).stats.duration > measure(renderSfx({ recipe: 'gunshot_pistol' }).chs).stats.duration);
  assert.throws(() => renderSfx({ recipe: 'gunshot_rifle', vars: { environment: 'space' } }), /outdoor\|indoor\|canyon/);
  for (const surface of ['metal', 'dirt', 'concrete', 'snow', 'grate']) assert.ok(renderSfx({ recipe: 'footstep', vars: { surface } }).chs[0].length > 1000, surface);
  assert.throws(() => renderSfx({ recipe: 'footstep', vars: { surface: 'lava' } }), /surface/);
  assert.ok(renderSfx({ recipe: 'casing_drop', vars: { surface: 'metal' } }).chs[0].length > renderSfx({ recipe: 'casing_drop', vars: { surface: 'concrete' } }).chs[0].length);
  assert.ok(renderSfx({ recipe: 'drone_rotor' }).loop && renderSfx({ recipe: 'alarm_klaxon' }).loop);
  assert.equal(renderSfx({ recipe: 'drone_rotor', loop: false }).loop, null);
});

test('sfx fixes: fx/reverb on layers, vars.target, default instrument, pitch_env sign, sfxr DC, loops', () => {
  const L = [{ kind: 'glide', f: 500, dur: 0.2 }];
  // fx as array, strings, keyed objects and JSON strings (clients that stringify undeclared params)
  assert.deepEqual(renderSfx({ layers: L, fx: '[{"type":"dc"},{"type":"comp"}]' }).spec.fx.map((f) => f.type), ['dc', 'comp']);
  assert.deepEqual(renderSfx({ layers: L, fx: ['dc', { eq: { bands: [{ type: 'hp', f: 90 }] } }] }).spec.fx.map((f) => f.type), ['dc', 'eq']);
  assert.throws(() => renderSfx({ layers: L, fx: [{ bands: [] }] }), /has no "type"/);
  // reverb is applied (longer tail) for objects, preset names and JSON strings
  const dry = renderSfx({ layers: L }).chs[0].length;
  for (const reverb of [{ preset: 'hall', wet: 0.5 }, 'hall', '{"preset":"room","wet":0.4}']) assert.ok(renderSfx({ layers: L, reverb }).chs[0].length > dry * 2, JSON.stringify(reverb));
  assert.equal(renderSfx({ recipe: 'hit_light', reverb: { preset: 'hall', wet: 0.4 } }).spec.reverb.preset, 'hall');
  // vars.target overrides the recipe's own target, for recipes and custom layers
  assert.ok(Math.abs(measure(renderSfx({ recipe: 'hover', vars: { target: -3 } }).chs).stats.peak_dbfs + 3) < 0.3);
  assert.ok(Math.abs(measure(renderSfx({ layers: L, vars: { target: -6 } }).chs).stats.peak_dbfs + 6) < 0.3);
  // note/voice layers without an instrument use a default tone instead of crashing
  for (const layer of [{ kind: 'note', note: 'c4', dur: 0.2 }, { kind: 'voice', note: 'c4' }]) assert.ok(renderSfx({ layers: [layer] }).chs[0].length > 1000);
  // negative pitch_env amount rises (also set on the layer itself); shape:"linear" sweeps over time
  const zc = (m, a, b) => { let c = 0; for (let i = a + 1; i < b; i++) if (m[i - 1] < 0 && m[i] >= 0) c++; return c; };
  for (const shape of [undefined, 'linear']) {
    const o = renderSfx({ layers: [{ kind: 'voice', patch: { sources: [{ type: 'osc', wave: 'sine' }], amp: { a: 0.001, d: 0, s: 1, r: 0.01 }, oneshot: 0.4 }, freq: 440, pitch_env: { amount: -12, time: 0.3, shape } }] });
    const m = o.chs[0];
    assert.ok(zc(m, 0, 2205) < zc(m, m.length - 3000, m.length - 795), `rises (${shape})`);
  }
  // sfxr slides are DC-blocked by default
  const P = sfxrPreset('laser', makeRng(3).fork(0)); // a square laser slide with a large offset
  const dcOf = (layer) => Math.abs(measure(renderSfx({ layers: [{ kind: 'sfxr', params: P, ...layer }] }).chs).stats.dc_offset);
  assert.ok(dcOf({ dc: false }) > 0.01 && dcOf({}) < 0.003, `dc ${dcOf({ dc: false })} -> ${dcOf({})}`);
  // loop:true gives a crossfaded loop that covers the file
  const lp = renderSfx({ layers: [{ kind: 'glide', noise: true, bp: 800, dur: 1.5 }], loop: true });
  assert.deepEqual(lp.loop, [0, lp.chs[0].length]);
  assert.equal(measure(lp.chs, { loop: lp.loop }).stats.seam.click, false);
});

test('critique: quiet target respected; seam level change ignores rhythmic gaps; pads read at half tempo', () => {
  const st = { peak_dbfs: -9, true_peak_dbtp: -9, duration: 0.1, head_silence_ms: 0, bands: { sub: 0, presence: 10 }, clipped_samples: 0, dc_offset: 0, channels: 1 };
  assert.ok(critiqueAudio(st, { kind: 'sfx' }).issues.some((i) => i.id === 'too_quiet'));
  assert.ok(!critiqueAudio(st, { kind: 'sfx', target_peak: -9 }).issues.some((i) => i.id === 'too_quiet'));
  // a hit-gap-hit-gap loop: the seam goes gap -> hit like every beat inside it, so no level change
  const beat = Math.round(0.5 * SR), x = new Float32Array(beat * 4);
  for (let b = 0; b < 4; b++) for (let i = 0; i < beat * 0.4; i++) x[b * beat + i] = Math.sin(i * 0.05) * Math.exp(-i / 4000) * 0.8;
  assert.ok(measure([x], { loop: [0, x.length], beatSec: 0.5 }).stats.seam.level_jump_db < 3);
  assert.ok(measure([x], { loop: [0, x.length] }).stats.seam.level_jump_db < 9);
  const s = renderSong(parseSongText('tempo 70\nkey a minor\nloop all\ntrack p strings_pad\nsection a 4\np: Am | F | C | G'));
  const rh = rhythm(toMono([s.L, s.R]), { tempo: 70 });
  assert.ok(rh.perceived_bpm < 100, `pad felt at ${rh.perceived_bpm}`);
});

test('art_audio: fx/reverb/loop schema, info shows resolved layers, delete wildcards, partial song update, no empty asset on error', async () => {
  const engine = new Engine({ home: tmp() });
  const call = (a) => runTool('art_audio', a, (op, args) => engine.run(op, args));
  const json = async (a) => JSON.parse((await call(a)).map((x) => x.text || '').join(''));
  const props = TOOLS.find((t) => t.name === 'art_audio').inputSchema.properties;
  for (const k of ['fx', 'reverb', 'target', 'loop', 'names']) assert.ok(props[k], k);
  await json({ action: 'sfx', name: 'pew', recipe: 'laser_bolt', variants: 3 });
  const info = await json({ action: 'info', name: 'pew_1' });
  assert.ok(Array.isArray(info.resolved.layers) && info.resolved.layers.length >= 3);
  // the resolved layers + seed reproduce the recipe exactly
  const rep = await json({ action: 'sfx', name: 'copy', layers: info.resolved.layers, fx: info.resolved.fx, reverb: info.resolved.reverb ?? null, tail: info.resolved.tail, target: info.resolved.target, seed: info.seed });
  assert.equal(rep.created[0].duration, info.stats.duration);
  assert.deepEqual((await json({ action: 'delete', name: 'pew_*' })).deleted, ['pew_1', 'pew_2', 'pew_3']);
  // loopable sfx export carries loop points
  const lp = await json({ action: 'sfx', name: 'hum', recipe: 'drone_rotor' });
  assert.ok(lp.created[0].loop);
  const ex = await json({ action: 'export', name: 'hum', format: 'wav' });
  assert.equal(decodeWAV(fs.readFileSync(ex.files[0])).loops.length, 1);
  // broken layers: clear error and no asset left behind
  await assert.rejects(() => call({ action: 'sfx', name: 'bad', layers: [{ kind: 'note', instrument: 'nope', note: 'c4' }] }), /Unknown instrument/);
  assert.ok(!(await json({ action: 'list' })).assets.some((x) => x.name === 'bad'));
  // partial song update merges tracks / sections into the saved song
  await json({ action: 'song', name: 's', song: { tempo: 100, loop: false, tracks: { p: { instrument: 'strings_pad' } }, sections: { a: { bars: 1, p: 'Am' } } } });
  await json({ action: 'song', name: 's', song: { tracks: { b: { instrument: 'bass_guitar' } } } });
  await json({ action: 'song', name: 's', song: { sections: { a: { bars: 1, p: 'Am', b: 'a2' } } } });
  const sd = await json({ action: 'info', name: 's' });
  assert.deepEqual(Object.keys(sd.song.tracks).sort(), ['b', 'p']);
  assert.equal(sd.song.sections.a.b, 'a2');
});
