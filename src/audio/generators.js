// Deterministic pattern generators: they return plain notation strings the agent can read and
// edit (art_audio generate), or are used inline in a section: {gen:"doom_riff", seed:3}.
import { makeRng } from './dsp.js';
import { parseKey, pcName } from './notation.js';

const up = (pc) => pcName(pc).replace(/^./, (c) => c.toUpperCase());
const bars = (list, steps = 16) => list.map((b) => b.join(' ')).join(' | ');

/** Power-chord riffs for metal_guitar / bass (track octave 2 / 1). styles: chug gallop doom breakdown tremolo. */
export function doom_riff({ key = 'e phrygian', bars: nb = 2, seed = 1, style = 'chug', steps = 16 } = {}) {
  const k = parseKey(key), rng = makeRng(seed);
  const rootPc = k.root;
  // chromatic/phrygian accent targets (semitones above the root) weighted toward b2 and the tritone
  const targets = [0, 0, 1, 1, 3, 6, 5, 7, 8];
  const ch = (iv, flag = '') => `${up(rootPc + iv)}5${flag}`;
  const out = [];
  for (let b = 0; b < nb; b++) {
    const t = [];
    const last = b === nb - 1;
    if (style === 'doom') {
      // slow: long ringing chords, chromatic creep, half-step drops
      const seq = rng.pick([[0, 0, 1, 0], [0, 6, 5, 1], [0, 3, 1, 0], [0, 1, 0, 8]]);
      for (let q = 0; q < 4; q++) { const iv = seq[q]; t.push(ch(iv, q === 0 ? '!' : ''), '_', '_', '_'); }
      if (last) { t.splice(12, 4, ch(1, '~'), '_', ch(0, "'"), ch(0, "'")); }
    } else if (style === 'tremolo') {
      const seq = rng.pick([[0, 1], [0, 3], [0, 8], [1, 0], [0, 6]]);
      t.push(ch(seq[b % 2], '%'), ...Array(steps / 2 - 1).fill('_'), ch(seq[(b + 1) % 2], '%'), ...Array(steps / 2 - 1).fill('_'));
    } else if (style === 'gallop') {
      for (let c = 0; c < steps / 4; c++) {
        const accent = c === 0 || rng.chance(0.25);
        const iv = c === 0 ? 0 : accent ? rng.pick(targets) : 0;
        t.push(accent ? ch(iv, '!') : ch(0, "'"), '.', ch(0, "'"), ch(0, "'"));
      }
    } else if (style === 'breakdown') {
      const cells = [["x", '.', '.', 'x'], ['.', '.', 'x', '.'], ['x', '.', '.', '.'], ['x', 'x', '.', 'x']];
      for (let c = 0; c < steps / 4; c++) {
        const cell = c === 0 ? ['A', '_', '_', 'x'] : rng.pick(cells);
        for (const s of cell) t.push(s === 'A' ? ch(rng.pick([0, 6, 1]), '!') : s === 'x' ? ch(0, "'") : s);
      }
    } else {
      // chug: palm-muted 16ths on the root with open accent chords
      const cells = [['x', 'x', 'x', 'x'], ['x', '.', 'x', 'x'], ['x', 'x', '.', 'x'], ['A', '_', 'x', 'x'], ['A', '_', '_', '_'], ['x', '.', '.', 'x']];
      for (let c = 0; c < steps / 4; c++) {
        const cell = c === 0 ? ['A', '_', 'x', 'x'] : rng.pick(cells);
        const iv = c === 0 ? 0 : rng.pick(targets);
        for (const s of cell) t.push(s === 'A' ? ch(iv, c === 0 ? '!' : '') : s === 'x' ? ch(0, "'") : s);
      }
      if (last) t.splice(steps - 4, 4, ch(1, '!'), '_', ch(6, ''), '_');
    }
    out.push(t);
  }
  return bars(out);
}

const PROGS = {
  dirge: [['i', 'bVI', 'bVII', 'i'], ['i', 'bVI', 'iv', 'V'], ['i', 'iv', 'bVI', 'V']],
  phrygian: [['i', 'bII', 'i', 'bII'], ['i', 'bII', 'bIII', 'bII'], ['i', 'bvii', 'bII', 'i']],
  liturgical: [['i', 'iv', 'i', 'V'], ['i', 'bVII', 'bVI', 'V'], ['i', 'bIII', 'bVII', 'i']],
  harmonic: [['i', 'iv', 'V', 'i'], ['i', 'bVI', 'V', 'i'], ['i', 'vii°', 'i', 'V']],
};
const MAJ = [0, 2, 4, 5, 7, 9, 11], ROM = ['i', 'ii', 'iii', 'iv', 'v', 'vi', 'vii'];
export function romanName(rn, key) {
  const k = parseKey(key);
  const m = rn.match(/^([b#]?)([ivIV]+)(°?)$/);
  const deg = ROM.indexOf(m[2].toLowerCase());
  const pc = k.root + MAJ[deg] + (m[1] === 'b' ? -1 : m[1] === '#' ? 1 : 0);
  const minor = m[2] === m[2].toLowerCase();
  return `${up(pc)}${m[3] ? 'dim' : minor ? 'm' : ''}`;
}
/** Organ/choir chord progression (one chord per bar, held). styles: dirge phrygian liturgical harmonic. */
export function organ_progression({ key = 'e phrygian', bars: nb = 4, seed = 1, style = 'dirge', per_bar = 1 } = {}) {
  const rng = makeRng(seed);
  const bank = PROGS[style] || PROGS.dirge;
  const prog = rng.pick(bank);
  const out = [];
  for (let b = 0; b < nb; b++) {
    const t = [];
    for (let c = 0; c < per_bar; c++) { t.push(romanName(prog[(b * per_bar + c) % prog.length], key)); t.push('_'); }
    out.push(t);
  }
  return bars(out);
}

const STYLES = {
  blast: { kick: 'x.x.x.x.x.x.x.x.', snare: '.x.x.x.x.x.x.x.x', ride: 'x.x.x.x.x.x.x.x.' },
  hammer: { kick: 'x.x.x.x.x.x.x.x.', snare: 'x.x.x.x.x.x.x.x.', crash: 'x.......x.......' },
  gravity: { kick: 'x...x...x...x...', snare: 'xxxxxxxxxxxxxxxx', ride: 'x...x...x...x...' },
  double_kick: { kick: 'Xxxxxxxxxxxxxxxx', snare: '....X.......X...', china: '..x...x...x...x.' },
  dbeat: { kick: 'x..xx...x..xx...', snare: '....X.......X...', hat: 'x.x.x.x.x.x.x.x.' },
  half_time: { kick: 'x.........x.....', snare: '........X.......', ride: 'x...x...x...x...' },
  doom: { kick: 'x.......x.....x.', snare: '........X.......', ride: 'x...x...x...x...' },
  four_floor: { kick: 'X...X...X...X...', ohat: '..x...x...x...x.', hat: 'x.x.x.x.x.x.x.x.', clap: '....x.......x...' },
  breakbeat: { kick: 'x.x.......xx....', snare: '....x..o.x..x..o', hat: 'x.x.x.x.x.x.x.x.' },
  trap: { kick: 'x......x..x.....', snare: '........X.......', hat: 'x.x.x.x.x.xxx.x.' },
  rock: { kick: 'x.......x.x.....', snare: '....X.......X...', hat: 'x.x.x.x.x.x.x.x.' },
};
/** Drum patterns for a kit track. styles: blast hammer gravity double_kick dbeat half_time doom four_floor breakbeat trap rock. */
export function blast_beat({ bars: nb = 2, seed = 1, style = 'blast', fill = true, ghosts = 0.15, crash = true } = {}) {
  const rng = makeRng(seed);
  const base = STYLES[style];
  if (!base) throw new Error(`blast_beat style must be ${Object.keys(STYLES).join('|')}`);
  const pieces = { ...base };
  if (crash && !pieces.crash) pieces.crash = '';
  const out = Object.fromEntries(Object.keys(pieces).map((k) => [k, []]));
  if (fill) Object.assign(out, { tom1: [], tom2: [], tom3: [] });
  for (let b = 0; b < nb; b++) {
    for (const [k, p] of Object.entries(pieces)) {
      let s = [...(p || '................')].slice(0, 16);
      while (s.length < 16) s.push('.');
      if (k === 'crash' && crash && b === 0) s[0] = 'X';
      // ghost notes between backbeats (metal/rock styles only)
      if (k === 'snare' && ghosts && !['blast', 'hammer', 'gravity', 'four_floor'].includes(style)) s = s.map((c, i) => (c === '.' && i % 2 === 1 && rng.chance(ghosts) ? 'o' : c));
      if (k === 'kick' && style === 'double_kick') s = s.map((c, i) => (i % 4 === 0 ? 'X' : rng.chance(0.3) ? 'x' : '7'));
      if (fill && b === nb - 1 && ['kick', 'snare', 'ride', 'hat', 'china', 'ohat', 'clap'].includes(k)) for (let i = 12; i < 16; i++) s[i] = k === 'kick' && i === 12 ? 'x' : '.';
      out[k].push(s.join(''));
    }
    if (fill) {
      const last = b === nb - 1;
      out.tom1.push(last ? '............Xx..' : '................');
      out.tom2.push(last ? '..............x.' : '................');
      out.tom3.push(last ? '...............X' : '................');
    }
  }
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v.some((x) => /[xXo1-9]/.test(x))).map(([k, v]) => [k, v.join('|')]));
}

/** Dread ambience parts: drone (long held root), bells (sparse tolls), heartbeat (steps), wind (held). */
export function dread_ambient({ key = 'e phrygian', bars: nb = 8, seed = 1 } = {}) {
  const k = parseKey(key), rng = makeRng(seed);
  const root = pcName(k.root);
  const hold = (note) => [note, ...Array(nb - 1).fill('_')].join(' | ');
  const bells = [];
  for (let b = 0; b < nb; b++) {
    if (b % 4 === 0) bells.push(`${root}3 . . .`);
    else if (rng.chance(0.35)) bells.push(`. . ${pcName(k.root + rng.pick([1, 6, 3]))}3 .`);
    else bells.push('.');
  }
  return {
    drone: hold(`${root}1`),
    drone_fifth: hold(`${pcName(k.root + rng.pick([7, 6, 1]))}2`),
    bells: bells.join(' | '),
    heartbeat: 'x.......x.......',
    wind: hold('c3'),
  };
}

export const GENERATORS = { doom_riff, organ_progression, blast_beat, dread_ambient };
export function runGenerator(g = {}) {
  const fn = GENERATORS[g.gen || g.generator];
  if (!fn) throw new Error(`Unknown generator "${g.gen || g.generator}". Generators: ${Object.keys(GENERATORS).join(', ')}`);
  return fn(g);
}
