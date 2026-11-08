// 0.3.0 audio fixes: rhythm gates, harmonic distortion, reverb estimate, loop seam, sfx reads-as.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SR, noise, makeRng, osc } from '../src/audio/dsp.js';
import { decodeWAV, resampleHQ, resampleLoop } from '../src/audio/wav.js';
import { reverbAlgo } from '../src/audio/fx.js';
import { reverbEstimate } from '../src/audio/perception.js';
import { critiqueAudio } from '../src/audio/critique.js';
import { Engine } from '../src/engine.js';
import { normalizeSong } from '../src/audio/song.js';
import { AUDIO_TOPICS, AUDIO_SKILLS } from '../src/audio/docs.js';

const eng = () => new Engine({ home: fs.mkdtempSync(path.join(os.tmpdir(), 'aa-v030a-')) });
const song = (e, name, def) => { e.run('audio_song', { name, ...def }); return e.run('audio_analyze', { name }).perception; };

test('fix 11: sustained choir / wind / sub_bass do not read as a double kick or backbeat', () => {
  const e = eng();
  const choir = song(e, 'choir', { tempo: 66, tracks: { a: { instrument: 'boys_choir' } }, sections: { s: { bars: 4, a: 'd5 e5 f5 a5 | a5 g5 f5 e5 | d5 f5 a5 d6 | c6 a5 f5 d5' } } });
  assert.notEqual(choir.rhythm.kick_pattern, 'double_kick');
  const wind = song(e, 'wind', { tempo: 60, loop: true, genre: 'dark_ambient', tracks: { a: { instrument: 'wind_ambience' } }, sections: { s: { bars: 4, a: 'c3 | _ | _ | _' } } });
  assert.notEqual(wind.rhythm.kick_pattern, 'double_kick');
  const sub = song(e, 'sub', { tempo: 90, tracks: { a: { instrument: 'sub_bass' } }, sections: { s: { bars: 4, a: 'e1 _ e1 g1 | a1 _ e1 _ | e1 _ e1 g1 | a1 _ b1 _' } } });
  assert.notEqual(sub.rhythm.kick_pattern, 'double_kick');
  assert.ok(!JSON.stringify(sub.rhythm.patterns || []).includes('backbeat'), JSON.stringify(sub.rhythm.patterns));
  // a real kit still reads
  const dk = song(e, 'dk', { tempo: 160, tracks: { d: { instrument: 'metal_kit' } }, sections: { s: { bars: 4, d: { kick: 'xxxxxxxxxxxxxxxx', snare: '....x.......x...', hat: 'x...x...x...x...' } } } });
  assert.equal(dk.rhythm.kick_pattern, 'double_kick');
});

test('fix 13: distortion comes from harmonic structure, not reverb wash or drums', () => {
  const e = eng();
  const wash = song(e, 'wash', { tempo: 60, reverb: 'cathedral', tracks: { a: { instrument: 'choir_pad', send: 0.9 } }, sections: { s: { bars: 4, a: 'c4 e4 g4 c5 | a3 c4 e4 a4 | f3 a3 c4 f4 | g3 b3 d4 g4' } } });
  assert.ok(wash.timbre.distortion < 0.4, `wash ${wash.timbre.distortion}`);
  const pedal = song(e, 'pedal', { tempo: 50, reverb: 'cathedral', tracks: { a: { instrument: 'cathedral_organ' } }, sections: { s: { bars: 4, a: 'c1 | _ | g0 | _' } } });
  assert.ok(pedal.timbre.distortion < 0.4, `pedal ${pedal.timbre.distortion}`);
  const kit = song(e, 'kit', { tempo: 120, tracks: { d: { instrument: 'metal_kit' } }, sections: { s: { bars: 4, d: { kick: 'x...x...x...x...', snare: '....x.......x...', hat: 'x.x.x.x.x.x.x.x.' } } } });
  assert.ok(kit.timbre.distortion < 0.4, `kit ${kit.timbre.distortion}`);
  const gtr = song(e, 'gtr', { tempo: 120, tracks: { g: { instrument: 'metal_guitar', octave: 2 } }, sections: { s: { bars: 4, g: 'e2 e2 e2 e2 | f2 f2 e2 e2 | e2 e2 e2 e2 | g2 f2 e2 e2' } } });
  assert.ok(gtr.timbre.distortion > 0.5, `guitar ${gtr.timbre.distortion}`);
});

test('fix 14: reverb RT60 from free decays, with a confidence', () => {
  // noise bursts with silence between them, through the algorithmic reverb
  const rng = makeRng(3), n = Math.round(12 * SR), dry = new Float32Array(n);
  for (let k = 0; k < 4; k++) { const b = noise(Math.round(0.08 * SR), 'white', rng); dry.set(b.map((x) => x * 0.5), Math.round((0.2 + k * 3) * SR)); }
  const rt = (preset) => { const w = reverbAlgo([dry, dry], { preset }); const m = Float32Array.from(w[0], (x, i) => (x + w[1][i]) * 0.5 + (dry[i] || 0) * 0.3); return reverbEstimate(m); };
  const room = rt('room'), hall = rt('hall');
  assert.ok(room.rt60 > 0.25 && room.rt60 < 1, `room ${room.rt60}`);
  assert.ok(hall.rt60 > 1.3 && hall.rt60 < 3, `hall ${hall.rt60}`);
  assert.ok(hall.rt60 > room.rt60);
  assert.ok(hall.confidence > 0 && hall.confidence <= 1);
  // dense constant noise: no free decays -> no estimate, or low confidence
  const dense = reverbEstimate(noise(Math.round(6 * SR), 'pink', makeRng(4)));
  assert.ok(dense.rt60 == null || dense.confidence < 0.35, JSON.stringify(dense));
});

test('fix 15: loop_seam needs a real discontinuity', () => {
  const base = { clipped_samples: 0, true_peak_dbtp: -2, dc_offset: 0, lufs: -14, crest_db: 10, duration: 30, tail_silence_ms: 0, head_silence_ms: 0, channels: 1, bands: { sub: 10, low: 15, low_mid: 15, mid: 20, presence: 15, high: 5, air: 2 } };
  const lvl = critiqueAudio({ ...base, seam: { click: false, level_jump_db: 12, jump: 0.01, jump_ratio: 1 } }, { loop: true });
  assert.ok(!lvl.issues.some((i) => i.id === 'loop_seam'));
  assert.ok(lvl.issues.some((i) => i.id === 'loop_level_change'));
  const clk = critiqueAudio({ ...base, seam: { click: true, level_jump_db: 0, jump: 0.4, jump_ratio: 9 } }, { loop: true });
  assert.ok(clk.issues.some((i) => i.id === 'loop_seam'));
});

test('fix 17: sfx reads-as separates pitch sweeps from impacts', () => {
  const e = eng();
  const reads = (recipe, seed = 1) => { e.run('audio_sfx', { name: `${recipe}_${seed}`, recipe, seed }); return e.run('audio_analyze', { name: `${recipe}_${seed}` }).perception.sfx; };
  const hit = reads('hit_light');
  assert.ok(!/falling tone/.test(hit.reads_as), hit.reads_as);
  assert.match(hit.reads_as, /impact/);
  for (const seed of [1, 2, 4]) {
    const laser = reads('sfxr_laser', seed);
    assert.ok(!/impact/.test(laser.reads_as), `seed ${seed}: ${laser.reads_as}`);
    assert.match(laser.reads_as, /falling tone/);
    assert.ok(laser.sweep_octaves < 0);
  }
  assert.match(reads('sfxr_powerup', 2).reads_as, /power-up/);
  assert.ok(!/falling|power-up/.test(reads('crit').reads_as));
});

test('fix 12: sample_rate 48000 export: windowed-sinc resample, sample-exact loop points', () => {
  // resampler quality: a 1 kHz sine converted 44.1k -> 48k matches the ideal 48k sine
  const x = osc(SR, 1000, { wave: 'sine', gain: 0.5 }), y = resampleHQ(x, SR, 48000);
  assert.equal(y.length, 48000);
  let err = 0, ref = 0;
  for (let i = 4000; i < 44000; i++) { const t = i / 48000, s = 0.5 * Math.sin(2 * Math.PI * 1000 * t); err += (y[i] - s) ** 2; ref += s * s; }
  assert.ok(10 * Math.log10(err / ref) < -60, `resample error ${(10 * Math.log10(err / ref)).toFixed(1)} dB`);
  // loop body is resampled as a periodic segment: exact new points, seamless wrap
  const body = osc(1000, 441, { wave: 'sine', gain: 0.5 }), sig = new Float32Array(1500 + 1000);
  sig.fill(0.1, 0, 1500); sig.set(body, 1500);
  const rl = resampleLoop([sig], SR, 48000, [1500, 2500]);
  assert.deepEqual(rl.loop, [Math.round(1500 * 48000 / SR), Math.round(1500 * 48000 / SR) + Math.round(1000 * 48000 / SR)]);
  assert.equal(rl.chs[0].length, rl.loop[1]);

  const e = eng();
  const r = e.run('audio_song', { name: 'lp', tempo: 120, loop: true, sample_rate: 48000, tracks: { a: { instrument: 'strings_pad' } }, sections: { s: { bars: 2, a: 'Am | F' } } });
  assert.equal(r.sample_rate, 48000);
  const out = e.run('audio_export', { name: 'lp', path: 'lp48.wav' });
  const w = decodeWAV(fs.readFileSync(out.files[0]));
  assert.equal(w.sr, 48000);
  const side = JSON.parse(fs.readFileSync(out.files[0].replace(/\.wav$/, '.json'), 'utf8'));
  assert.equal(side.sample_rate, 48000);
  const [s, en] = r.loop, k = 48000 / SR;
  const exp = [Math.round(s * k), Math.round(s * k) + Math.round((en - s) * k)];
  assert.deepEqual([side.loop.start, side.loop.end], exp);
  assert.equal(w.loops[0].start, exp[0]);
  assert.equal(w.loops[0].end, exp[1]);
  assert.equal(w.channels[0].length, side.samples);
  const w44 = decodeWAV(fs.readFileSync(e.run('audio_export', { name: 'lp', path: 'lp44b.wav', sample_rate: 44100 }).files[0]));
  assert.equal(w44.sr, 44100);
  assert.equal(w44.loops[0].start, s);
  assert.throws(() => e.run('audio_export', { name: 'lp', sample_rate: 22050 }), /sample_rate/);
});

test('fix 16: song text + JSON tracks/buses deep-merge, and it is documented', () => {
  const text = 'tempo 100\ntrack gtr metal_guitar gain=-5\ntrack drums metal_kit\nsection a 1\ngtr: e2 e2 e2 e2\ndrums: @blast_beat style=rock seed=1 bars=1';
  const s = normalizeSong({ text, tracks: { gtr: { gain: -9, fx: [{ type: 'gain', db: -1 }] } }, buses: { drums: { gain: -2 } } });
  assert.equal(s.tracks.gtr.gain, -9, 'JSON overrides the text field');
  assert.match(JSON.stringify(s.tracks.gtr), /metal_guitar/, 'text instrument kept');
  assert.ok(s.tracks.drums, 'text-only track kept');
  assert.equal(s.buses.drums.gain, -2);
  assert.equal(s.tempo, 100);
  assert.match(AUDIO_TOPICS.music, /TEXT \+ JSON/);
  assert.match(AUDIO_TOPICS.music, /deep-merge/);
  assert.match(AUDIO_SKILLS['music-track'].body, /deep-merge/);
  assert.match(AUDIO_TOPICS.audio, /sample_rate:48000/);
  assert.match(AUDIO_TOPICS.perception, /reverb_confidence/);
});
