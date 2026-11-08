// Instrument presets as plain JSON patches. A patch = voice (sources, envelopes, filter) +
// track defaults (fx chain, gain, pan, reverb send, double-tracking, humanize). Variants
// ("cathedral_organ:flute") deep-merge over the base. Agents read them with
// art_audio instrument {name} and save tweaked copies with {name, patch:{base, ...overrides}}.

const organ = (partials, extra = {}) => ({
  sources: [
    { type: 'additive', partials, gain: 0.5, ranks: 2, rank_detune: 2.5, pipe_detune: 3 },
    { type: 'noise', color: 'white', gain: 0.05, filter: { type: 'bp', keytrack: 4, q: 1.5 }, decay: 0.07 }, // chiff
    { type: 'noise', color: 'pink', gain: 0.012, filter: { type: 'bp', keytrack: 2, q: 0.8 }, wind: true }, // wind
  ],
  amp: { a: 0.06, d: 0.1, s: 1, r: 0.35 },
  vibrato: { rate: 5.6, depth: 0, delay: 0 },
  gain: -8, reverb: 0.55,
  fx: [{ type: 'eq', bands: [{ type: 'hp', f: 45 }, { type: 'peak', f: 350, q: 0.8, gain: -2 }] }],
  ...extra,
});
const harmonics = (n, fn) => Array.from({ length: n }, (_, i) => [i + 1, fn(i + 1)]);

export const PRESETS = {
  cathedral_organ: {
    doc: 'Pipe organ (additive ranks, per-pipe detune, chiff, wind). Variants: full (plenum, default), principal, flute, reed, tutti, pedal.',
    ...organ([[0.5, 0.55], [1, 1], [1.5, 0.22], [2, 0.7], [3, 0.4], [4, 0.5], [5, 0.12], [6, 0.3], [8, 0.3], [10, 0.07], [12, 0.15], [16, 0.1]]),
    variants: {
      full: {},
      principal: { sources: [{ partials: [[1, 1], [2, 0.6], [3, 0.12], [4, 0.35], [6, 0.08], [8, 0.15]] }] },
      flute: { sources: [{ partials: [[1, 1], [2, 0.18], [3, 0.06], [4, 0.05]], gain: 0.7 }, { gain: 0.08 }] },
      reed: { sources: [{ partials: harmonics(20, (h) => Math.pow(h, -0.75) * (h > 3 && h < 9 ? 1.4 : 1)) }], amp: { a: 0.03 } },
      tutti: { sources: [{ partials: [[0.25, 0.4], [0.5, 0.7], [1, 1], [1.5, 0.3], [2, 0.8], [3, 0.55], [4, 0.6], [5, 0.25], [6, 0.45], [8, 0.4], [10, 0.2], [12, 0.25], [16, 0.18]], gain: 0.45 }] },
      pedal: { sources: [{ partials: [[0.25, 0.5], [0.5, 1], [1, 0.6], [2, 0.25], [3, 0.08]] }], amp: { a: 0.12, r: 0.5 } },
    },
  },
  choir_pad: {
    doc: 'Formant choir: 6 detuned voices per note, own vibrato each, breath noise. Vowel via fx formant (ah/eh/ee/oh/oo). Variants: ah, oh, oo, male, female.',
    sources: [
      { type: 'osc', wave: 'saw', gain: 0.45, unison: 5, spread: 22, voice_vibrato: { rate: 5.2, depth: 22, jitter: 0.25 } },
      { type: 'osc', wave: 'pulse', pw: 0.3, gain: 0.15, unison: 2, spread: 10, octave: 0 },
      { type: 'noise', color: 'white', gain: 0.03, filter: { type: 'bp', keytrack: 6, q: 0.7 } }, // breath
    ],
    amp: { a: 0.5, d: 0.4, s: 0.9, r: 1.0 },
    filter: { type: 'lp', cutoff: 3800, q: 0.6 },
    gain: -3, reverb: 0.6, pan: 0,
    fx: [{ type: 'formant', vowel: 'ah', voice: 'tenor' }, { type: 'eq', bands: [{ type: 'hp', f: 110 }, { type: 'highshelf', f: 6000, gain: -4 }] }, { type: 'chorus', mix: 0.35, rate: 0.3 }],
    variants: {
      ah: {}, oh: { fx: [{ vowel: 'oh' }] }, oo: { fx: [{ vowel: 'oo' }] },
      male: { fx: [{ voice: 'bass' }] }, female: { fx: [{ voice: 'alto' }] },
    },
  },
  boys_choir: {
    doc: 'Boys/soprano choir: purer tone (tri+saw), little vibrato, soprano "oo" formants. Play an octave up (c4-c6).',
    sources: [
      { type: 'osc', wave: 'tri', gain: 0.5, unison: 5, spread: 12, voice_vibrato: { rate: 5.6, depth: 9, jitter: 0.2 } },
      { type: 'osc', wave: 'saw', gain: 0.2, unison: 3, spread: 14 },
      { type: 'noise', color: 'white', gain: 0.02, filter: { type: 'bp', keytrack: 5, q: 0.8 } },
    ],
    amp: { a: 0.35, d: 0.3, s: 0.95, r: 0.9 },
    filter: { type: 'lp', cutoff: 5200, q: 0.5 },
    gain: -5, reverb: 0.65,
    fx: [{ type: 'formant', vowel: 'oo', voice: 'soprano' }, { type: 'eq', bands: [{ type: 'hp', f: 220 }] }, { type: 'chorus', mix: 0.3 }],
  },
  church_bells: {
    doc: 'Cast church bell (modal: hum, prime, minor tierce, quint, nominal...). Strike noise. Long natural decay. Play c3-c4.',
    sources: [
      { type: 'modal', modes: [[0.5, 0.55, 9], [1, 0.6, 6], [1.183, 0.5, 4.5], [1.506, 0.3, 3.2], [2, 0.55, 3], [2.514, 0.25, 2], [2.662, 0.22, 1.8], [3.011, 0.2, 1.4], [4.166, 0.14, 0.9], [5.433, 0.1, 0.6], [6.796, 0.07, 0.4]], gain: 0.5, strike: 0.4 },
      { type: 'fm', ratio: 3.53, index: 3, index_decay: 0.05, gain: 0.08, decay: 0.15 },
    ],
    amp: { a: 0.001, d: 0, s: 1, r: 6 }, oneshot: 7,
    gain: -6, reverb: 0.5,
    fx: [{ type: 'eq', bands: [{ type: 'hp', f: 60 }] }],
  },
  tubular_bell: {
    doc: 'Orchestral tubular bell / chime (modal). Play c4-c5.',
    sources: [{ type: 'modal', modes: [[1, 0.5, 4], [2.02, 0.5, 3.5], [3.03, 0.35, 2.6], [4.19, 0.3, 2], [5.4, 0.2, 1.4], [6.82, 0.12, 0.9], [8.4, 0.06, 0.5]], gain: 0.5, strike: 0.3 }],
    amp: { a: 0.001, d: 0, s: 1, r: 4 }, oneshot: 4.5,
    gain: -7, reverb: 0.4,
  },
  metal_guitar: {
    doc: 'High-gain rhythm guitar: plucked strings -> amp (2 gain stages) -> 4x12 cab, double-tracked L/R takes. Articulations: e2\' palm-mute chug, open notes ring, % tremolo picking. Play power chords (E5) at octave 2.',
    sources: [
      { type: 'pluck', gain: 1, brightness: 0.85, t60: 3 },
      { type: 'osc', wave: 'saw', gain: 0.12, detune: 6 },
    ],
    amp: { a: 0.001, d: 0.2, s: 0.9, r: 0.06 },
    filter: { type: 'lp', cutoff: 6500, q: 0.6 },
    mute: { gate: 0.7, amp: { a: 0.001, d: 0.09, s: 0.05, r: 0.04 }, filter: { cutoff: 900, env_amount: 2.2, env: { a: 0.001, d: 0.06, s: 0, r: 0.04 } } },
    gain: -4, double: true, width: 1, reverb: 0.06, humanize: { time: 0.006, vel: 0.06 },
    fx: [{ type: 'amp', gain: 34, tight: 120, mid: 850, mid_gain: 6, scoop: -3 }, { type: 'cab', lp: 5000 }, { type: 'eq', bands: [{ type: 'hp', f: 85 }, { type: 'peak', f: 420, q: 1.2, gain: -3 }, { type: 'peak', f: 2600, q: 1, gain: 1.5 }] }],
    variants: { lead: { double: false, fx: [{ gain: 30, mid_gain: 9 }, {}, {}, { type: 'delay', time: '1/8d', mix: 0.18 }], reverb: 0.2 } },
  },
  bass_guitar: {
    doc: 'Picked bass with grit (pluck + sub sine, light drive, compressed). Play octave 1.',
    sources: [{ type: 'pluck', gain: 0.8, brightness: 0.6, t60: 2.5 }, { type: 'osc', wave: 'sine', gain: 0.6 }, { type: 'osc', wave: 'saw', gain: 0.12 }],
    amp: { a: 0.002, d: 0.3, s: 0.8, r: 0.06 },
    filter: { type: 'lp', cutoff: 1800, q: 0.8, env_amount: 1.2, env: { a: 0.001, d: 0.12, s: 0.2, r: 0.1 } },
    mute: { gate: 0.6, amp: { d: 0.1, s: 0.1 } },
    gain: -2, reverb: 0,
    fx: [{ type: 'drive', drive: 10, shape: 'tube' }, { type: 'comp', threshold: -20, ratio: 4, attack: 0.005, release: 0.1, auto_makeup: true }, { type: 'eq', bands: [{ type: 'hp', f: 35 }, { type: 'peak', f: 800, q: 1, gain: 2 }, { type: 'lp', f: 4500 }] }],
  },
  sub_bass: {
    doc: 'Clean sine sub with a touch of 2nd harmonic. Use under guitars/kick; octave 1.',
    sources: [{ type: 'osc', wave: 'sine', gain: 0.9 }, { type: 'osc', wave: 'sine', octave: 1, gain: 0.12 }],
    amp: { a: 0.01, d: 0.1, s: 1, r: 0.15 }, gain: -4, reverb: 0,
    fx: [{ type: 'saturate', drive: 4 }, { type: 'eq', bands: [{ type: 'lp', f: 160, poles: 4 }, { type: 'hp', f: 28 }] }],
  },
  rumble_bass: {
    doc: 'Hard-techno rumble: kick-triggered sub with distortion and a reverb-smeared tail. Use on off-beats.',
    sources: [{ type: 'osc', wave: 'sine', gain: 1 }, { type: 'osc', wave: 'tri', gain: 0.3 }],
    pitch_env: { amount: 5, time: 0.03 },
    amp: { a: 0.002, d: 0.25, s: 0.4, r: 0.1 }, gain: -4, reverb: 0,
    fx: [{ type: 'reverb', preset: 'room', wet: 0.6, hp: 20, lp: 900 }, { type: 'drive', drive: 18, shape: 'tube' }, { type: 'eq', bands: [{ type: 'lp', f: 220, poles: 4 }, { type: 'hp', f: 30 }] }],
  },
  strings_pad: {
    doc: 'Bowed string section (waveguide bowed strings x3 per note + soft saw ensemble). Slow attack; legato.',
    sources: [
      { type: 'bowed', gain: 0.8, players: 2, spread: 9, pressure: 0.3 },
      { type: 'osc', wave: 'saw', gain: 0.16, unison: 4, spread: 14, voice_vibrato: { rate: 5, depth: 10, jitter: 0.3 } },
    ],
    amp: { a: 0.45, d: 0.3, s: 0.9, r: 0.8 },
    filter: { type: 'lp', cutoff: 3200, q: 0.6 },
    vibrato: { rate: 5.2, depth: 10, delay: 0.35 },
    gain: -6, reverb: 0.5,
    fx: [{ type: 'eq', bands: [{ type: 'hp', f: 90 }, { type: 'peak', f: 1200, q: 0.7, gain: 1.5 }] }, { type: 'chorus', mix: 0.2 }],
  },
  low_brass_stab: {
    doc: 'Low brass stab (trombones/tuba feel): saw ensemble, bright filter envelope, growl. Octave 2-3.',
    sources: [{ type: 'osc', wave: 'saw', gain: 0.5, unison: 3, spread: 8 }, { type: 'osc', wave: 'square', octave: -1, gain: 0.2 }],
    amp: { a: 0.02, d: 0.35, s: 0.55, r: 0.25 },
    filter: { type: 'lp', cutoff: 350, q: 1.2, env_amount: 3, vel_amount: 1, env: { a: 0.03, d: 0.3, s: 0.3, r: 0.2 } },
    gain: -5, reverb: 0.4,
    fx: [{ type: 'saturate', drive: 6 }, { type: 'eq', bands: [{ type: 'hp', f: 50 }] }],
  },
  dread_drone: {
    doc: 'Dark evolving drone (detuned saws + sub + noise through a slowly sweeping filter). Hold long notes (octave 1-2).',
    sources: [{ type: 'osc', wave: 'saw', gain: 0.35, unison: 4, spread: 18 }, { type: 'osc', wave: 'square', octave: -1, gain: 0.2 }, { type: 'noise', color: 'pink', gain: 0.08 }],
    amp: { a: 3, d: 1, s: 1, r: 4 },
    filter: { type: 'lp', cutoff: 380, q: 2, lfo: { rate: 0.07, depth: 1.4 } },
    gain: -6, reverb: 0.5,
    fx: [{ type: 'chorus', mix: 0.4, rate: 0.12, depth: 0.006 }, { type: 'eq', bands: [{ type: 'hp', f: 30 }] }],
  },
  heartbeat: {
    doc: 'Heartbeat thump (lub-dub per hit). One hit per beat at slow tempo.',
    sources: [{ type: 'osc', wave: 'sine', gain: 1, fixed: 52 }, { type: 'noise', color: 'brown', gain: 0.3, decay: 0.05 }],
    pitch_env: { amount: 10, time: 0.035 },
    amp: { a: 0.003, d: 0.14, s: 0, r: 0.05 }, oneshot: 0.2,
    hits: [[0, 1], [0.2, 0.7]],
    gain: -2, reverb: 0.1,
    fx: [{ type: 'eq', bands: [{ type: 'lp', f: 180 }] }, { type: 'saturate', drive: 6 }],
  },
  wind_ambience: {
    doc: 'Howling wind (pink noise through drifting resonant bandpasses). Hold one long note.',
    sources: [{ type: 'noise', color: 'pink', gain: 1 }],
    amp: { a: 2, d: 0.5, s: 1, r: 3 },
    filter: { type: 'bp', cutoff: 650, q: 3.5, keytrack: 0, lfo: { rate: 0.11, depth: 1.3, shape: 'random' } },
    gain: -4, reverb: 0.3, width: 1.5,
    fx: [{ type: 'chorus', mix: 0.6, rate: 0.08, depth: 0.008 }],
  },
  sampler: {
    doc: 'Plays imported samples (art_audio import). patch.sources[0].zones: [{sample, root:"c3", lo:"c0", hi:"c8", vel:[0,1], loop?:[start,end] samples, rr?:0}].',
    sources: [{ type: 'sample', zones: [] }],
    amp: { a: 0.002, d: 0, s: 1, r: 0.15 }, gain: -6, reverb: 0.2,
  },
};

// ---------- drums ----------
const D = (o) => ({ oneshot: 0.5, amp: { a: 0.0005, d: 0, s: 1, r: 0.01 }, round_robin: 4, ...o });
export const DRUMS = {
  metal_kick: D({ doc: 'Tight metal kick: sine body + pitch drop + beater click.', sources: [{ type: 'osc', wave: 'sine', fixed: 50, gain: 1, decay: 0.32 }, { type: 'osc', wave: 'tri', fixed: 1800, gain: 0.15, decay: 0.008, pitch: false }, { type: 'noise', color: 'white', gain: 0.35, decay: 0.006, filter: { type: 'hp', f: 2500 } }], pitch_env: { amount: 26, time: 0.025 }, oneshot: 0.4, fx: [{ type: 'drive', drive: 6 }, { type: 'eq', bands: [{ type: 'peak', f: 60, q: 1, gain: 3 }, { type: 'peak', f: 350, q: 1.4, gain: -6 }, { type: 'peak', f: 4000, q: 1, gain: 4 }] }] }),
  metal_snare: D({ doc: 'Cracking snare: two tone modes + bright noise wires.', sources: [{ type: 'osc', wave: 'tri', fixed: 190, gain: 0.7, decay: 0.12 }, { type: 'osc', wave: 'sine', fixed: 330, gain: 0.35, decay: 0.07 }, { type: 'noise', color: 'white', gain: 0.75, decay: 0.24, filter: { type: 'bp', f: 3800, q: 0.6 } }], pitch_env: { amount: 5, time: 0.015 }, fx: [{ type: 'transient', attack: 4 }, { type: 'eq', bands: [{ type: 'hp', f: 120 }, { type: 'peak', f: 220, q: 1, gain: 2 }] }] }),
  metal_tom1: D({ sources: [{ type: 'osc', wave: 'sine', fixed: 170, gain: 1, decay: 0.32 }, { type: 'noise', gain: 0.1, decay: 0.03 }], pitch_env: { amount: 6, time: 0.06 } }),
  metal_tom2: D({ sources: [{ type: 'osc', wave: 'sine', fixed: 120, gain: 1, decay: 0.38 }, { type: 'noise', gain: 0.1, decay: 0.03 }], pitch_env: { amount: 6, time: 0.06 } }),
  metal_tom3: D({ sources: [{ type: 'osc', wave: 'sine', fixed: 82, gain: 1, decay: 0.45 }, { type: 'noise', gain: 0.1, decay: 0.03 }], pitch_env: { amount: 6, time: 0.07 } }),
  metal_hat: D({ sources: [{ type: 'metal', base: 420, gain: 0.5, decay: 0.05 }, { type: 'noise', gain: 0.3, decay: 0.04 }], filter: { type: 'hp', cutoff: 7500, q: 0.7 }, oneshot: 0.12 }),
  metal_ohat: D({ sources: [{ type: 'metal', base: 420, gain: 0.5, decay: 0.38 }, { type: 'noise', gain: 0.3, decay: 0.3 }], filter: { type: 'hp', cutoff: 6500, q: 0.7 }, oneshot: 0.5 }),
  metal_crash: D({ sources: [{ type: 'metal', base: 340, gain: 0.45, decay: 1.8 }, { type: 'noise', gain: 0.5, decay: 1.6 }], filter: { type: 'hp', cutoff: 4200, q: 0.6 }, oneshot: 2.2, round_robin: 3 }),
  metal_china: D({ sources: [{ type: 'metal', base: 290, gain: 0.6, decay: 1.2 }, { type: 'noise', gain: 0.5, decay: 1 }], filter: { type: 'bp', cutoff: 4500, q: 0.9 }, oneshot: 1.5, fx: [{ type: 'drive', drive: 8 }] }),
  metal_ride: D({ sources: [{ type: 'metal', base: 520, gain: 0.35, decay: 0.9 }, { type: 'osc', wave: 'sine', fixed: 2650, gain: 0.12, decay: 0.5 }, { type: 'osc', wave: 'sine', fixed: 4120, gain: 0.07, decay: 0.4 }], filter: { type: 'hp', cutoff: 3000, q: 0.6 }, oneshot: 1.1 }),
  ind_kick: D({ doc: 'Industrial/hard-techno kick: long distorted boom with rumble tail.', sources: [{ type: 'osc', wave: 'sine', fixed: 46, gain: 1, decay: 0.55 }, { type: 'noise', color: 'white', gain: 0.4, decay: 0.01, filter: { type: 'hp', f: 1500 } }], pitch_env: { amount: 30, time: 0.03 }, oneshot: 0.6, fx: [{ type: 'drive', drive: 20, shape: 'tube' }, { type: 'eq', bands: [{ type: 'lp', f: 6000 }, { type: 'peak', f: 300, q: 1, gain: -5 }] }] }),
  ind_snare: D({ doc: 'Industrial clank snare: metallic FM hit + crushed noise.', sources: [{ type: 'fm', fixed: 210, ratio: 1.41, index: 7, index_decay: 0.05, gain: 0.6, decay: 0.15 }, { type: 'noise', gain: 0.8, decay: 0.2, filter: { type: 'bp', f: 2500, q: 0.8 } }], fx: [{ type: 'bitcrush', bits: 7, rate: 16000 }, { type: 'drive', drive: 10 }] }),
  ind_tom1: D({ sources: [{ type: 'fm', fixed: 140, ratio: 1.5, index: 3, index_decay: 0.08, gain: 0.8, decay: 0.3 }], pitch_env: { amount: 8, time: 0.05 } }),
  ind_tom2: D({ sources: [{ type: 'fm', fixed: 100, ratio: 1.5, index: 3, index_decay: 0.08, gain: 0.8, decay: 0.35 }], pitch_env: { amount: 8, time: 0.05 } }),
  ind_tom3: D({ sources: [{ type: 'fm', fixed: 70, ratio: 1.5, index: 3, index_decay: 0.08, gain: 0.8, decay: 0.4 }], pitch_env: { amount: 8, time: 0.05 } }),
  ind_hat: D({ sources: [{ type: 'noise', gain: 0.7, decay: 0.035 }], filter: { type: 'hp', cutoff: 8000, q: 0.7 }, oneshot: 0.1, fx: [{ type: 'bitcrush', bits: 6, rate: 22050 }] }),
  ind_ohat: D({ sources: [{ type: 'noise', gain: 0.7, decay: 0.22 }, { type: 'metal', base: 600, gain: 0.25, decay: 0.2 }], filter: { type: 'hp', cutoff: 7000, q: 0.7 }, oneshot: 0.35 }),
  ind_crash: D({ sources: [{ type: 'noise', gain: 0.7, decay: 1.4 }, { type: 'metal', base: 300, gain: 0.3, decay: 1.2 }], filter: { type: 'hp', cutoff: 3500, q: 0.6 }, oneshot: 1.8, fx: [{ type: 'bitcrush', bits: 8, rate: 22050 }] }),
  ind_ride: D({ sources: [{ type: 'metal', base: 700, gain: 0.4, decay: 0.6 }], filter: { type: 'hp', cutoff: 4000, q: 0.6 }, oneshot: 0.8 }),
  clap: D({ sources: [{ type: 'noise', gain: 1, decay: 0.12, filter: { type: 'bp', f: 1500, q: 1.2 } }], hits: [[0, 0.7], [0.011, 0.8], [0.022, 1]], oneshot: 0.25 }),
};
const kit = (pfx, extra) => ({
  kit: { kick: `${pfx}_kick`, snare: `${pfx}_snare`, tom1: `${pfx}_tom1`, tom2: `${pfx}_tom2`, tom3: `${pfx}_tom3`, hat: `${pfx}_hat`, ohat: `${pfx}_ohat`, crash: `${pfx}_crash`, ride: `${pfx}_ride`, ...(pfx === 'metal' ? { china: 'metal_china' } : { clap: 'clap' }) },
  levels: { kick: 0, snare: -1, tom1: -3, tom2: -3, tom3: -3, hat: -8, ohat: -8, crash: -6, ride: -8, china: -7, clap: -4 },
  pans: { tom1: -0.35, tom2: 0.1, tom3: 0.4, hat: 0.3, ohat: 0.3, crash: -0.4, ride: 0.45, china: 0.5 },
  ...extra,
});
PRESETS.metal_kit = { doc: 'Heavy metal kit. Pieces: kick snare tom1 tom2 tom3 hat ohat crash ride china. Ghost notes with "o", accents "X".', ...kit('metal'), gain: 0, reverb: 0.12, humanize: { time: 0.004, vel: 0.08 }, fx: [{ type: 'comp', threshold: -14, ratio: 3, attack: 0.005, release: 0.08, auto_makeup: true }] };
PRESETS.industrial_kit = { doc: 'Industrial / hard techno kit (distorted, crushed). Pieces: kick snare tom1-3 hat ohat crash ride clap.', ...kit('ind'), gain: 0, reverb: 0.1, humanize: { time: 0.001, vel: 0.03 }, fx: [{ type: 'drive', drive: 6 }, { type: 'comp', threshold: -12, ratio: 4, attack: 0.003, release: 0.06, auto_makeup: true }] };
Object.assign(PRESETS, DRUMS);

export const PRESET_NAMES = Object.keys(PRESETS);

/** Deep merge (arrays merged by index when both are arrays of objects). null deletes. */
export function merge(a, b) {
  if (b === undefined) return a;
  if (b === null) return undefined;
  if (Array.isArray(b)) {
    if (!Array.isArray(a) || !b.every((x) => x && typeof x === 'object' && !Array.isArray(x))) return b.map((x) => (x && typeof x === 'object' ? merge(undefined, x) : x));
    // arrays of objects: merge element-wise, extra elements appended
    const out = a.map((x, i) => (i < b.length ? merge(x, b[i]) : x));
    for (let i = a.length; i < b.length; i++) out.push(b[i]);
    return out.filter((x) => x !== undefined);
  }
  if (typeof b !== 'object') return b;
  const out = a && typeof a === 'object' && !Array.isArray(a) ? { ...a } : {};
  for (const [k, v] of Object.entries(b)) { const m = merge(out[k], v); if (m === undefined) delete out[k]; else out[k] = m; }
  return out;
}

/**
 * Resolve an instrument reference: "name", "name:variant" or a patch object {base?, ...overrides}.
 * custom = map of saved instruments (workspace).
 */
export function resolvePatch(ref, custom = {}, depth = 0) {
  if (depth > 8) throw new Error('instrument base chain too deep');
  if (ref && typeof ref === 'object') {
    const { base, ...rest } = ref;
    return base ? merge(resolvePatch(base, custom, depth + 1), rest) : rest;
  }
  const [name, variant] = String(ref || '').split(':');
  const src = custom[name] ? resolvePatch(custom[name], custom, depth + 1) : PRESETS[name];
  if (!src) throw new Error(`Unknown instrument "${name}". Presets: ${PRESET_NAMES.filter((n) => !DRUMS[n]).join(', ')}; drums: ${Object.keys(DRUMS).join(', ')}${Object.keys(custom).length ? `; saved: ${Object.keys(custom).join(', ')}` : ''}`);
  const { variants, ...base } = src;
  if (!variant) return base;
  if (!variants?.[variant]) throw new Error(`Instrument "${name}" has no variant "${variant}". Variants: ${Object.keys(variants || {}).join(', ') || '(none)'}`);
  return merge(base, variants[variant]);
}
