// Text notation that weak models can write reliably.
//  Step pattern (drums): "x...x...x.x.x..." one char per step (16 steps = 1 bar of 4/4 by default).
//    X accent, x hit, o ghost, 1-9 velocity 0.1-0.9, . or - rest, _ hold; | and spaces ignored.
//  Note line: bars split by "|"; the tokens of a bar share it evenly ("Em | C" = one chord per bar,
//    "e2 e2 f2 e2" = four quarter notes). Lowercase = note (e2 f#3 bb1), Uppercase = chord (Em C5 Bdim
//    Am7), roman numerals relative to the key (i iv bVI V7), stacks e2+b2+e3. "_" holds the previous
//    note, "." rests, tok*4 repeats. Suffixes: ! accent, ? ghost, ' palm-mute/staccato, ~ legato,
//    % tremolo picking, < swell, @0.7 velocity.
export const SCALES = {
  major: [0, 2, 4, 5, 7, 9, 11], ionian: [0, 2, 4, 5, 7, 9, 11], minor: [0, 2, 3, 5, 7, 8, 10], aeolian: [0, 2, 3, 5, 7, 8, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10], phrygian: [0, 1, 3, 5, 7, 8, 10], lydian: [0, 2, 4, 6, 7, 9, 11], mixolydian: [0, 2, 4, 5, 7, 9, 10],
  locrian: [0, 1, 3, 5, 6, 8, 10], harmonic_minor: [0, 2, 3, 5, 7, 8, 11], melodic_minor: [0, 2, 3, 5, 7, 9, 11],
  phrygian_dominant: [0, 1, 4, 5, 7, 8, 10], hungarian_minor: [0, 2, 3, 6, 7, 8, 11], double_harmonic: [0, 1, 4, 5, 7, 8, 11],
  pentatonic_minor: [0, 3, 5, 7, 10], pentatonic_major: [0, 2, 4, 7, 9], blues: [0, 3, 5, 6, 7, 10], whole_tone: [0, 2, 4, 6, 8, 10],
  diminished: [0, 2, 3, 5, 6, 8, 9, 11], chromatic: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
};
export const CHORDS = {
  '': [0, 4, 7], maj: [0, 4, 7], M: [0, 4, 7], m: [0, 3, 7], min: [0, 3, 7], dim: [0, 3, 6], '°': [0, 3, 6], o: [0, 3, 6], aug: [0, 4, 8], '+': [0, 4, 8],
  5: [0, 7, 12], sus2: [0, 2, 7], sus4: [0, 5, 7], 7: [0, 4, 7, 10], m7: [0, 3, 7, 10], maj7: [0, 4, 7, 11], dim7: [0, 3, 6, 9], m7b5: [0, 3, 6, 10],
  add9: [0, 4, 7, 14], madd9: [0, 3, 7, 14], m9: [0, 3, 7, 10, 14], mmaj7: [0, 3, 7, 11], 6: [0, 4, 7, 9], m6: [0, 3, 7, 9], b5: [0, 6, 12],
};
const PC = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };
const NAMES = ['c', 'c#', 'd', 'eb', 'e', 'f', 'f#', 'g', 'ab', 'a', 'bb', 'b'];
export const midiName = (m) => `${NAMES[((m % 12) + 12) % 12]}${Math.floor(m / 12) - 1}`;
export const pcName = (pc) => NAMES[((pc % 12) + 12) % 12];

export function parseKey(key = 'c minor') {
  const m = String(key).trim().toLowerCase().match(/^([a-g])([#b]?)\s*(?:[ _-]?(\w+))?$/);
  if (!m) throw new Error(`key "${key}" must look like "e phrygian" or "d minor". Modes: ${Object.keys(SCALES).join(', ')}`);
  const root = (PC[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0) + 12) % 12;
  const mode = m[3] || 'major';
  if (!SCALES[mode]) throw new Error(`Unknown mode "${mode}". Modes: ${Object.keys(SCALES).join(', ')}`);
  return { root, mode, scale: SCALES[mode], name: `${pcName(root)} ${mode}` };
}

const ROMAN = ['i', 'ii', 'iii', 'iv', 'v', 'vi', 'vii'];
const MAJOR = [0, 2, 4, 5, 7, 9, 11];

/** Parse the pitch part of a token -> midi notes, or null for rest. */
export function parsePitch(core, { octave = 3, key } = {}) {
  if (core.includes('+') && !/^[A-G][#b]?(aug|\+)$/.test(core) && !/^[b#]?[ivIV]+\+$/.test(core)) return core.split('+').flatMap((c) => parsePitch(c, { octave, key }));
  let m = core.match(/^([a-g])([#b]?)(-?\d)$/);
  if (m) return [PC[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0) + (Number(m[3]) + 1) * 12];
  m = core.match(/^([A-G])([#b]?)(.*)$/);
  if (m && CHORDS[m[3]] !== undefined) {
    const root = PC[m[1].toLowerCase()] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0) + (octave + 1) * 12;
    return CHORDS[m[3]].map((iv) => root + iv);
  }
  m = core.match(/^([b#]?)(vii|vi|iv|v|iii|ii|i|VII|VI|IV|V|III|II|I)(.*)$/);
  if (m) {
    const k = key ? parseKey(key) : parseKey('c minor');
    const deg = ROMAN.indexOf(m[2].toLowerCase());
    const minor = m[2] === m[2].toLowerCase();
    let q = m[3];
    if (q === '' || q === '7') q = minor ? (q ? 'm7' : 'm') : q;
    else if (minor && q === '°') q = 'dim';
    if (CHORDS[q] === undefined) return null;
    let root = k.root + MAJOR[deg] + (m[1] === 'b' ? -1 : m[1] === '#' ? 1 : 0) + (octave + 1) * 12;
    return CHORDS[q].map((iv) => root + iv);
  }
  return undefined; // not a pitch
}

function parseToken(tok, opts) {
  const m = tok.match(/^(.*?)([!?'~%<]*)(?:@(\d*\.?\d+))?$/);
  const core = m[1], flags = m[2] || '';
  const art = {};
  if (flags.includes("'")) art.mute = true;
  if (flags.includes('~')) art.legato = true;
  if (flags.includes('%')) art.tremolo = true;
  if (flags.includes('<')) art.swell = true;
  let vel = opts.vel ?? 0.8;
  if (flags.includes('!')) vel = 1;
  if (flags.includes('?')) vel = 0.4;
  if (m[3]) vel = Number(m[3]);
  if (['.', '-', 'r', ''].includes(core)) return { rest: true };
  if (core === '_') return { hold: true };
  const midis = parsePitch(core, opts);
  if (midis === undefined || midis === null) throw new Error(`Bad token "${tok}". Notes are lowercase with octave (e2, f#3, bb1); chords Uppercase (Em, C5, Bdim, Am7); roman numerals (i, bVI, V7); "_" hold, "." rest; suffixes ! ? ' ~ % < @vel`);
  return { midis, vel, art };
}

const isSteps = (s) => /^[xXo.\-_|\s1-9]+$/.test(s) && /[xXo1-9]/.test(s);

/**
 * Parse one track entry of a section into events [{pos (bars), len (bars), midis, vel, art}].
 * entry: note line string | step string | {notes|steps, res?, vel?, octave?, transpose?}.
 */
export function parseEntry(entry, { bars, stepsPerBar = 16, octave = 3, key, note = 'c3', transpose = 0 }) {
  if (entry === null || entry === undefined || entry === '') return [];
  if (typeof entry === 'object') {
    const o = { bars, stepsPerBar: entry.res ?? stepsPerBar, octave: entry.octave ?? octave, key, note: entry.note ?? note, transpose: transpose + (entry.transpose ?? 0) };
    const ev = parseEntry(entry.notes ?? entry.steps ?? '', o);
    if (entry.vel !== undefined) for (const e of ev) e.vel *= entry.vel;
    return ev;
  }
  const s = String(entry);
  return (isSteps(s) ? parseSteps(s, bars, stepsPerBar, note, octave) : parseNotes(s, bars, { octave, key })).map((e) => ({ ...e, midis: e.midis.map((m) => m + transpose) }));
}

export function parseSteps(str, bars, stepsPerBar = 16, note = 'c3', octave = 3) {
  const chars = [...str.replace(/[|\s]/g, '')];
  if (!chars.length) return [];
  const total = Math.round(bars * stepsPerBar);
  const midi = parsePitch(note, { octave }) || [48];
  const out = [];
  let last = null;
  for (let s = 0; s < total; s++) {
    const c = chars[s % chars.length];
    if (c === '_' && last) { last.len += 1 / stepsPerBar; continue; }
    last = null;
    if (c === '.' || c === '-' || c === '_') continue;
    const vel = c === 'X' ? 1 : c === 'x' ? 0.8 : c === 'o' ? 0.4 : Number(c) / 10;
    last = { pos: s / stepsPerBar, len: 1 / stepsPerBar, midis: midi, vel, art: {} };
    out.push(last);
  }
  return out;
}

export function parseNotes(str, bars, opts = {}) {
  let barStrs = String(str).split('|').map((b) => b.trim());
  while (barStrs.length > 1 && !barStrs[barStrs.length - 1]) barStrs.pop();
  if (!barStrs.length) return [];
  const parsed = barStrs.map((b) => b.split(/\s+/).filter(Boolean).flatMap((t) => { const m = t.match(/^(.+)\*(\d+)$/); return m ? Array(Number(m[2])).fill(m[1]) : [t]; }).map((t) => parseToken(t, opts)));
  const out = [];
  let last = null;
  for (let b = 0; b < bars; b++) {
    const toks = parsed[b % parsed.length];
    const slot = 1 / Math.max(1, toks.length);
    toks.forEach((t, i) => {
      if (t.hold) { if (last) last.len += slot; return; }
      if (t.rest) { last = null; return; }
      last = { pos: b + i * slot, len: slot, midis: t.midis, vel: t.vel, art: t.art };
      out.push(last);
    });
  }
  return out;
}

export function parseTime(t = '4/4') {
  const m = String(t).match(/^(\d+)\/(\d+)$/);
  if (!m) throw new Error('time must look like "4/4", "3/4", "6/8", "7/8"');
  const num = Number(m[1]), den = Number(m[2]);
  return { num, den, beatsPerBar: (num * 4) / den, stepsPerBar: Math.round((num * 16) / den) };
}

// ---------- full text song format ----------
const val = (v) => (v === 'true' ? true : v === 'false' ? false : /^-?\d*\.?\d+$/.test(v) ? Number(v) : v);
function kv(parts) { const o = {}; for (const p of parts) { const i = p.indexOf('='); if (i > 0) o[p.slice(0, i)] = val(p.slice(i + 1)); } return o; }

/**
 * Text song -> JSON song definition.
 *   tempo 132 | time 4/4 | key e phrygian | reverb cathedral | loop verse|all | swing 0.1 | seed 3
 *   track gtr metal_guitar gain=-3 pan=0 reverb=0.1
 *   section verse 4
 *   gtr: E5' E5' F5 E5 | ...        drums.kick: x...x...       bass: @doom_riff seed=3
 *   arrange intro verse*2 chorus outro
 */
export function parseSongText(text) {
  const song = { tracks: {}, sections: {}, arrangement: [] };
  let sec = null;
  String(text).split(/\r?\n/).forEach((raw, ln) => {
    const line = raw.replace(/(^|\s)#.*$/, '').trim();
    if (!line) return;
    const m = line.match(/^([A-Za-z0-9_]+)(?:\.([A-Za-z0-9_]+))?\s*:\s*(.*)$/);
    if (m && sec) {
      const [, tr, piece, pat] = m;
      let entry = pat;
      if (pat.startsWith('@')) { const [g, ...rest] = pat.slice(1).split(/\s+/); entry = { gen: g, ...kv(rest) }; }
      if (piece) { sec[tr] = sec[tr] && typeof sec[tr] === 'object' ? sec[tr] : {}; sec[tr][piece] = entry; } else sec[tr] = entry;
      return;
    }
    const [cmd, ...args] = line.split(/\s+/);
    switch (cmd) {
      case 'tempo': song.tempo = Number(args[0]); break;
      case 'time': song.time = args[0]; break;
      case 'key': song.key = args.join(' '); break;
      case 'steps': song.steps = Number(args[0]); break;
      case 'swing': song.swing = Number(args[0]); break;
      case 'seed': song.seed = Number(args[0]); break;
      case 'reverb': song.reverb = { preset: args[0], ...kv(args.slice(1)) }; break;
      case 'loop': song.loop = args[0] === 'all' ? true : args[0] === 'none' ? false : args[0]; break;
      case 'master': song.master = kv(args); break;
      case 'track': song.tracks[args[0]] = { instrument: args[1], ...kv(args.slice(2)) }; break;
      case 'section': sec = song.sections[args[0]] = { bars: Number(args[1] || 4), ...kv(args.slice(2)) }; break;
      case 'arrange': case 'arrangement': song.arrangement.push(...args); break;
      case 'layer': (song.layers ||= {})[args[0]] = args.slice(1); break;
      default: throw new Error(`song text line ${ln + 1}: unknown "${cmd}" (tempo time key steps swing seed reverb loop master track section arrange layer, or "track: pattern" inside a section)`);
    }
  });
  return song;
}

/** "intro verse*2 chorus" or ["intro", "verse*2"] -> flat list of section names. */
export function expandArrangement(arr, sections) {
  const list = (Array.isArray(arr) ? arr : String(arr || '').split(/[\s,]+/)).filter(Boolean).flatMap((s) => { const m = String(s).match(/^(.+?)(?:\*|x)(\d+)$/); return m && sections[m[1]] ? Array(Number(m[2])).fill(m[1]) : [s]; });
  for (const s of list) if (!sections[s]) throw new Error(`arrangement uses unknown section "${s}". Sections: ${Object.keys(sections).join(', ')}`);
  return list.length ? list : Object.keys(sections);
}
