// Engine ops for audio (art_audio). Assets live in <workspace>/audio/<name>.json (definitions:
// sfx recipe+seed+vars, song notation, imported samples) with rendered caches in audio/cache/,
// so agents iterate by editing definitions and re-rendering (deterministic, no undo needed).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { SR } from './dsp.js';
import { renderSfx, RECIPE_GROUPS, RECIPES, resolveSfxSpec, validateSfx } from './sfx.js';
import { renderSong, normalizeSong, renderLayers } from './song.js';
import { PRESETS, DRUMS, resolvePatch, PRESET_NAMES } from './presets.js';
import { GENERATORS, runGenerator } from './generators.js';
import { measure, toMono } from './analysis.js';
import { perceive, publicPerception, listenerReport, compareToReference } from './perception.js';
import { critiqueAudio } from './critique.js';
import { overviewImage, mixImage } from './image.js';
import { encodeWAV, decodeWAV, encodeWithFfmpeg, decodeFile, findFfmpeg, resampleLoop, SAMPLE_RATES } from './wav.js';
/** Delivery sample rate: 44100 (render rate) or 48000 (resampled on export). */
function sampleRate(v) {
  if (v == null) return null;
  const n = Number(v);
  if (!SAMPLE_RATES.includes(n)) throw new Error(`sample_rate must be ${SAMPLE_RATES.join(' or ')} (got ${v})`);
  return n;
}
import { GENRE_NAMES } from './genres.js';

const NAME_RE = /^[A-Za-z0-9_\-.]{1,64}$/;
const dirs = (e) => {
  const root = path.join(e.home, 'audio');
  const d = { root, cache: path.join(root, 'cache'), inst: path.join(root, 'instruments'), exports: path.join(e.exportDir, 'audio') };
  for (const x of Object.values(d)) fs.mkdirSync(x, { recursive: true });
  return d;
};
function store(e) {
  if (e.audio) return e.audio;
  const d = dirs(e);
  const defs = new Map(), inst = {};
  for (const f of fs.readdirSync(d.root)) if (f.endsWith('.json')) { try { const a = JSON.parse(fs.readFileSync(path.join(d.root, f), 'utf8')); defs.set(a.name, a); } catch { /* skip */ } }
  for (const f of fs.readdirSync(d.inst)) if (f.endsWith('.json')) { try { const a = JSON.parse(fs.readFileSync(path.join(d.inst, f), 'utf8')); inst[a.name] = a.patch; } catch { /* skip */ } }
  e.audio = { d, defs, inst, mem: new Map() };
  return e.audio;
}
/** The workspace audio store (definitions by name), loaded on first use. */
export const audioStore = (e) => store(e);
const hashDef = (def) => crypto.createHash('sha1').update(JSON.stringify({ ...def, updated: 0, created: 0, stats: 0 })).digest('hex').slice(0, 16);
function saveDef(e, def, source) {
  const s = store(e);
  if (!NAME_RE.test(def.name || '')) throw new Error('"name" must be 1-64 chars of letters, digits, _ - .');
  def.updated = Date.now();
  def.created ||= def.updated;
  fs.writeFileSync(path.join(s.d.root, `${def.name}.json`), JSON.stringify(def, null, 1));
  s.defs.set(def.name, def);
  e.emit('event', { type: 'audio', name: def.name, kind: def.kind, source, ts: Date.now() });
}
function getDef(e, name) {
  const s = store(e);
  if (!name) throw new Error('"name" is required');
  const d = s.defs.get(name);
  if (!d) throw new Error(`No audio asset "${name}". Existing: ${[...s.defs.keys()].slice(0, 40).join(', ') || '(none)'}`);
  return d;
}
const r1 = (v) => Math.round(v * 10) / 10;
/** Names matching a wildcard pattern ("gib_*"), or the name itself. */
function matchNames(s, name) {
  if (!name || !name.includes('*')) return name ? [name] : [];
  const re = new RegExp(`^${name.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
  return [...s.defs.keys()].filter((n) => re.test(n)).sort();
}
/** analyze / critique with a wildcard name or names:[...]: the matching names (null = a single sound). */
function manyNames(self, a, verb) {
  if (!a.names && !(a.name && a.name.includes('*'))) return null;
  const names = a.names || matchNames(store(self), a.name);
  if (!names.length) throw new Error(`${verb}: no sound matches "${a.name}" (art_audio list shows the names)`);
  return names;
}
// partial song update: only tracks or only sections merge into the saved song (null removes a key)
function mergeSong(old, nu) {
  const out = { ...old };
  for (const [k, v] of Object.entries(nu)) {
    if ((k === 'tracks' || k === 'sections') && v && typeof v === 'object') {
      const m = { ...(old[k] || {}) };
      for (const [n, x] of Object.entries(v)) { if (x === null) delete m[n]; else m[n] = x && typeof x === 'object' && m[n] && typeof m[n] === 'object' && !Array.isArray(x) ? { ...m[n], ...x } : x; }
      out[k] = m;
    } else if (v === null) delete out[k];
    else out[k] = v;
  }
  return out;
}

/** Render (or load from cache) an asset -> {chs, loop, meta, stems?}. */
export function getAudio(e, name, { stems = false, force = false } = {}) {
  const s = store(e), def = getDef(e, name);
  const h = hashDef(def);
  const m = s.mem.get(name);
  if (!force && m && m.hash === h && (!stems || (m.stems && (m.stemsMode === stems || stems === 'dry')))) return m;
  const wav = path.join(s.d.cache, `${name}.wav`), meta = path.join(s.d.cache, `${name}.meta.json`);
  if (!force && !stems && fs.existsSync(wav) && fs.existsSync(meta)) {
    try {
      const mj = JSON.parse(fs.readFileSync(meta, 'utf8'));
      if (mj.hash === h) { const w = decodeWAV(fs.readFileSync(wav)); const r = { hash: h, chs: w.channels, loop: mj.loop, meta: mj, stems: null }; s.mem.set(name, r); return r; }
    } catch { /* re-render */ }
  }
  const t0 = performance.now();
  let out;
  const getSample = (n) => { const a = getAudio(e, n); return { mono: toMono(a.chs), sr: SR, loop: a.loop }; };
  if (def.kind === 'sfx') {
    const r = renderSfx(def, { custom: s.inst, getSample });
    out = { chs: r.chs, loop: r.loop, meta: { kind: 'sfx', recipe: def.recipe, target: r.target } };
  } else if (def.kind === 'song') {
    const r = renderSong(def.song, { custom: s.inst, getSample, stems });
    const kit = Object.values(r.song.tracks).find((t) => t.kit);
    out = { chs: [r.L, r.R], loop: r.loop, stems: r.stems, meta: { kind: 'song', timeline: r.timeline, tempo: r.song.tempo, beatsPerBar: r.song.time.beatsPerBar, drums: kit?.name, master: r.master, perf: r.perf, target_lufs: r.song.master.target_lufs, tracks: Object.keys(r.song.tracks) } };
  } else if (def.kind === 'sample') {
    const w = decodeFile(def.source);
    out = { chs: w.channels.slice(0, 2), loop: def.loop || (w.loops[0] ? [w.loops[0].start, w.loops[0].end] : null), meta: { kind: 'sample', source: def.source } };
  } else throw new Error(`asset "${name}" has unknown kind ${def.kind}`);
  out.meta.render_ms = Math.round(performance.now() - t0);
  out.hash = h;
  out.stemsMode = out.stems ? stems : null;
  out.meta.hash = h; out.meta.loop = out.loop;
  fs.writeFileSync(wav, encodeWAV(out.chs, { bits: 32 }));
  fs.writeFileSync(meta, JSON.stringify(out.meta));
  s.mem.set(name, out);
  if (s.mem.size > 24) s.mem.delete(s.mem.keys().next().value);
  return out;
}

function quickStats(a, def) {
  const m = measure(a.chs, { loop: a.loop, beatSec: a.meta.tempo ? 60 / a.meta.tempo : null });
  const s = m.stats;
  const c = critiqueAudio(s, { kind: def.kind === 'song' ? 'music' : 'sfx', loop: !!a.loop, target_lufs: a.meta.target_lufs, target_peak: a.meta.target, recipe: def.recipe });
  return { duration: s.duration, lufs: s.lufs, peak_dbfs: s.peak_dbfs, true_peak_dbtp: s.true_peak_dbtp, centroid_hz: s.centroid_hz, seam: s.seam, score: c.score, issues: c.issues.map((i) => i.id) };
}

function perceptionFor(e, name, a, def, args) {
  const isSong = def.kind === 'song';
  const full = isSong ? getAudio(e, name, { stems: 'dry' }) : a;
  const key = `${args.intent ?? def.intent}|${args.genre ?? def.genre}`;
  if (full._perc?.key === key) return full._perc.v;
  const meas = measure(full.chs, { loop: full.loop, beatSec: full.meta.tempo ? 60 / full.meta.tempo : null });
  const p = perceive(full.chs, meas, {
    tempo: full.meta.tempo, beatsPerBar: full.meta.beatsPerBar, stems: isSong ? full.stems : null, drums: full.meta.drums, timeline: full.meta.timeline,
    intent: args.intent ?? def.intent, genre: args.genre ?? def.genre, kind: isSong || (def.kind === 'sample' && meas.stats.duration > 8) ? 'music' : 'sfx',
  });
  full._perc = { key, v: { full, meas, p } };
  return full._perc.v;
}

export const AUDIO_OPS = {
  audio_list(a = {}) {
    const s = store(this);
    return { assets: [...s.defs.values()].filter((d) => !a.kind || d.kind === a.kind).sort((x, y) => y.updated - x.updated).map((d) => ({ name: d.name, kind: d.kind, recipe: d.recipe, seed: d.seed, duration: d.stats?.duration, lufs: d.stats?.lufs })), instruments: Object.keys(s.inst), presets: PRESET_NAMES.length, ffmpeg: findFfmpeg()?.version || null };
  },

  audio_info(a) {
    if (!a.name) {
      return { recipes: RECIPE_GROUPS, presets: Object.fromEntries(PRESET_NAMES.map((n) => [n, PRESETS[n].doc || ''])), generators: Object.keys(GENERATORS), genres: GENRE_NAMES, fx: 'eq filter drive saturate amp cab bitcrush chorus flanger delay reverb comp gate transient multiband limit formant tremolo width gain pan duck fade dc' };
    }
    const def = getDef(this, a.name);
    const res = { ...def, cache: store(this).mem.get(a.name)?.meta };
    if (def.kind === 'sfx' && def.recipe) {
      // the layers the recipe resolved to for this seed + vars: copy, edit, re-render as {layers, seed}
      const { spec, vars } = resolveSfxSpec(def);
      // target and loop resolve like renderSfx does (def, then vars, then the recipe's own)
      const loop = def.loop === false ? undefined : def.loop ?? vars.loop ?? spec.loop;
      res.resolved = { layers: spec.layers, fx: spec.fx, reverb: spec.reverb, target: def.target ?? vars.target ?? spec.target, tail: spec.tail, loop };
      res.tip = 'art_audio sfx {name, layers: resolved.layers, fx: resolved.fx, reverb: resolved.reverb, target: resolved.target, tail: resolved.tail, loop: resolved.loop, seed} reproduces this sound; edit layers to change it';
    }
    return res;
  },

  audio_delete(a, source) {
    const s = store(this);
    const names = a.names || matchNames(s, a.name);
    if (!a.names && !a.name) throw new Error('delete needs name (wildcards ok: "gib_*") or names:[...]');
    if (!names.length) throw new Error(`No audio asset matches "${a.name}". Existing: ${[...s.defs.keys()].slice(0, 40).join(', ') || '(none)'}`);
    const deleted = [];
    for (const n of names) {
      const def = getDef(this, n);
      // the asset (definition + render cache) goes to the trash (art_cleanup restore), unless cleanup.trash_deletes is false
      if (!this.cleanup?.trashFiles('audio', def.name, source, 'art_audio delete')) {
        for (const f of [path.join(s.d.root, `${def.name}.json`), path.join(s.d.cache, `${def.name}.wav`), path.join(s.d.cache, `${def.name}.meta.json`)]) fs.rmSync(f, { force: true });
        s.defs.delete(def.name); s.mem.delete(def.name);
        this.emit('event', { type: 'audio', name: def.name, deleted: true, source, ts: Date.now() });
      }
      deleted.push(def.name);
    }
    return { deleted: deleted.length === 1 && !a.names && !a.name.includes('*') ? deleted[0] : deleted };
  },

  /** Sound effects: recipe | params (sfxr) | layers, seed, variants -> one asset per variant. */
  audio_sfx(a, source) {
    if (!a.recipe && !a.params && !a.layers) throw new Error(`sfx needs recipe, params (sfxr) or layers. Recipes: ${Object.entries(RECIPE_GROUPS).map(([g, l]) => `${g}: ${l.join(' ')}`).join('; ')}`);
    if (a.recipe && !RECIPES[a.recipe]) throw new Error(`Unknown recipe "${a.recipe}". Recipes: ${Object.values(RECIPE_GROUPS).flat().join(', ')}`);
    const base = a.name || a.recipe || 'sfx';
    const n = Math.max(1, Math.min(32, a.variants ?? 1));
    const seed0 = a.seed ?? 1;
    const out = [];
    const s = store(this);
    for (let i = 0; i < n; i++) {
      const name = n > 1 ? `${base}_${i + 1}` : base;
      const def = { name, kind: 'sfx', recipe: a.recipe, params: a.params, layers: a.layers, fx: a.fx, reverb: a.reverb, target: a.target, loop: a.loop, tail: a.tail, seed: seed0 + i, vars: a.vars || {}, sample_rate: sampleRate(a.sample_rate) ?? undefined };
      for (const k of Object.keys(def)) if (def[k] === undefined) delete def[k];
      // validate (layer kinds, instruments, fx) before anything is written
      validateSfx(def, { custom: s.inst });
      const prev = s.defs.get(name);
      saveDef(this, def, source);
      let au;
      try { au = getAudio(this, name, { force: true }); } catch (err) {
        // a failed render leaves nothing behind: restore the previous definition or remove the new one
        if (prev) saveDef(this, prev, source);
        else { fs.rmSync(path.join(s.d.root, `${name}.json`), { force: true }); s.defs.delete(name); s.mem.delete(name); }
        throw err;
      }
      def.stats = quickStats(au, def);
      saveDef(this, def, source);
      out.push({ name, seed: def.seed, ...def.stats, loop: au.loop || undefined, sample_rate: def.sample_rate ?? SR, render_ms: au.meta.render_ms });
    }
    return { created: out, tip: 'art_audio analyze {name} shows it (spectrogram + listener report); export {name:"' + base + (n > 1 ? '_*' : '') + '", format:"ogg"} writes files' };
  },

  /** Instrument presets: no patch = show the preset patch (to tweak); patch = save a custom instrument. */
  audio_instrument(a, source) {
    const s = store(this);
    if (!a.name) return { presets: Object.fromEntries(PRESET_NAMES.map((n) => [n, PRESETS[n].doc || ''])), saved: Object.keys(s.inst) };
    if (a.patch) {
      if (!NAME_RE.test(a.name) || a.name.includes(':')) throw new Error('bad instrument name (letters, digits, _ - .)');
      if (PRESETS[a.name]) throw new Error(`"${a.name}" is a preset; save your version under a new name with patch.base:"${a.name}" (e.g. name:"my_${a.name}")`);
      const patch = { ...a.patch };
      if (!patch.base && !patch.sources && !patch.kit) throw new Error('patch needs base:"<preset>" (plus overrides) or its own sources');
      resolvePatch(patch, s.inst); // validate
      s.inst[a.name] = patch;
      fs.writeFileSync(path.join(s.d.inst, `${a.name}.json`), JSON.stringify({ name: a.name, patch }, null, 1));
    }
    const resolved = resolvePatch(a.name, s.inst);
    const res = { name: a.name, patch: s.inst[a.name] || PRESETS[a.name.split(':')[0]], resolved: a.full ? resolved : undefined, variants: PRESETS[a.name.split(':')[0]]?.variants ? Object.keys(PRESETS[a.name.split(':')[0]].variants) : undefined };
    if (a.notes) {
      // audition: a one-track song playing the notes, saved as <name>_demo
      const demo = `${a.name.replace(/:/g, '_')}_demo`;
      const kit = !!resolved.kit;
      const def = { name: demo, kind: 'song', song: { tempo: a.tempo ?? 100, loop: false, tail: 3, reverb: a.reverb ?? 'hall', tracks: { t: { instrument: a.name } }, sections: { a: { bars: a.bars ?? 2, t: kit ? (typeof a.notes === 'object' ? a.notes : { kick: 'x...x...', snare: '....x...', hat: 'x.x.x.x.' }) : a.notes } } } };
      saveDef(this, def, source);
      const au = getAudio(this, demo, { force: true });
      def.stats = quickStats(au, def); saveDef(this, def, source);
      res.demo = { name: demo, ...def.stats };
    }
    return res;
  },

  audio_generate(a) {
    const g = runGenerator(a);
    return { generator: a.generator || a.gen, patterns: g, tip: 'paste into a section: {"<track>": <pattern>} (kit tracks take the object), or use {gen:"...", seed} inline' };
  },

  /** Songs: JSON (tempo, tracks, sections, arrangement) or {text} notation. */
  audio_song(a, source) {
    const { name, action, render, ...rest } = a;
    let song = rest.song || rest;
    if (typeof song === 'string') song = JSON.parse(song);
    // partial update: a song with only tracks (or only sections) merges into the saved one
    const old = store(this).defs.get(name);
    if (old?.kind === 'song' && !song.text && (!song.sections || !song.tracks)) song = mergeSong(old.song, song);
    const sr = sampleRate(a.sample_rate ?? song.sample_rate);
    for (const k of ['intent', 'genre', 'stems', 'format', 'path', 'sample_rate']) delete song[k];
    const s = store(this);
    normalizeSong(song, s.inst); // validate before saving
    const def = { name, kind: 'song', song, intent: a.intent, genre: a.genre };
    if (sr) def.sample_rate = sr;
    saveDef(this, def, source);
    if (render === false) return { saved: name };
    // stems stay in memory so an analyze/critique right after does not render again
    const au = getAudio(this, name, { force: true, stems: 'dry' });
    def.stats = quickStats(au, def);
    saveDef(this, def, source);
    return { name, ...def.stats, sample_rate: def.sample_rate ?? SR, loop: au.loop, timeline: au.meta.timeline.map((t) => `${t.section}@${t.start}s`).join(' '), perf: au.meta.perf, master: au.meta.master, tip: 'art_audio analyze {name} = image + listener report; critique {name, intent, genre} = ranked issues' };
  },

  audio_render(a) {
    const def = getDef(this, a.name);
    if (a.sample_rate !== undefined) { const sr = sampleRate(a.sample_rate); if (sr === SR) delete def.sample_rate; else def.sample_rate = sr; }
    const au = getAudio(this, a.name, { force: true, stems: !!a.stems });
    def.stats = quickStats(au, def);
    saveDef(this, def, 'agent');
    return { name: a.name, ...def.stats, sample_rate: def.sample_rate ?? SR, render_ms: au.meta.render_ms, perf: au.meta.perf };
  },

  /** Image (overview: waveform+beats+onsets, spectrogram, loudness/energy, stereo; mix: stem spectra + masking) + stats + perception. */
  audio_analyze(a) {
    const many = manyNames(this, a, 'analyze');
    if (many) return { results: many.map((name) => { const r = AUDIO_OPS.audio_analyze.call(this, { ...a, name, names: undefined }); delete r.image; return r; }), tip: 'images are left out for several sounds: analyze {name} one at a time to see the spectrogram' };
    const def = getDef(this, a.name);
    const au = getAudio(this, a.name);
    const { full, meas, p } = perceptionFor(this, a.name, au, def, a);
    const issues = critiqueAudio(meas.stats, { kind: def.kind === 'song' ? 'music' : 'sfx', loop: !!full.loop, target_lufs: full.meta.target_lufs, target_peak: full.meta.target, perception: p, recipe: def.recipe, genre: a.genre ?? def.genre, intent: a.intent ?? def.intent }).issues;
    const view = a.view || 'overview';
    const image = view === 'mix' && p.mix ? mixImage(p.mix) : overviewImage({ chs: full.chs, meas, perception: p, loop: full.loop, title: a.name, target_lufs: full.meta.target_lufs ?? (def.kind === 'song' ? -14 : -18), timeline: full.meta.timeline });
    const pub = publicPerception(p);
    if (pub.mix) delete pub.mix.spectra;
    if (p.kind === 'sfx' && pub.rhythm) pub.rhythm.note = 'one-shot SFX: the tempo/groove fields describe onset spacing (hits, tails), not a musical beat; ignore them unless the sound is a loop';
    if (a.detail !== true) { delete pub.tension?.curve; if (pub.tonal) delete pub.tonal.chords_per_segment; if (pub.tonal) delete pub.tonal.chroma; }
    return { name: a.name, stats: meas.stats, report: listenerReport(p, issues), perception: pub, image, views: p.mix ? 'view:"mix" = stem spectra + masking' : undefined };
  },

  audio_critique(a) {
    const many = manyNames(this, a, 'critique');
    if (many) return { results: many.map((name) => AUDIO_OPS.audio_critique.call(this, { ...a, name, names: undefined })) };
    const def = getDef(this, a.name);
    const au = getAudio(this, a.name);
    const { full, meas, p } = perceptionFor(this, a.name, au, def, a);
    const c = critiqueAudio(meas.stats, { kind: def.kind === 'song' ? 'music' : a.kind || (meas.stats.duration > 10 ? 'music' : 'sfx'), loop: !!full.loop, target_lufs: a.target_lufs ?? full.meta.target_lufs, target_peak: full.meta.target, perception: p, recipe: def.recipe, genre: a.genre ?? def.genre, intent: a.intent ?? def.intent });
    return { name: a.name, ...c, report: listenerReport(p, c.issues), genre: p.genre?.verdict, intent: p.intent || undefined };
  },

  /** Compare an asset with a reference (asset name, or a WAV/MP3/OGG path decoded via ffmpeg). */
  audio_compare(a) {
    const def = getDef(this, a.name);
    const au = getAudio(this, a.name);
    let ref;
    if (store(this).defs.has(a.reference)) ref = getAudio(this, a.reference);
    else if (a.reference && fs.existsSync(a.reference)) ref = { chs: decodeFile(a.reference).channels, meta: {}, loop: null };
    else throw new Error('"reference" must be an audio asset name or a file path (wav, or mp3/ogg/flac with ffmpeg)');
    const mA = measure(au.chs), mB = measure(ref.chs);
    const pA = perceive(au.chs, mA, { tempo: au.meta.tempo, kind: 'music' }), pB = perceive(ref.chs, mB, { kind: 'music' });
    return { name: a.name, reference: a.reference, ...compareToReference(pA, pB, mA, mB), yours: listenerReport(pA), theirs: listenerReport(pB), _def: def.kind };
  },

  /** Import a WAV/MP3/OGG as a sample asset (for sampler zones) or a reference. */
  audio_import(a, source) {
    if (!a.path || !fs.existsSync(a.path)) throw new Error('import needs "path" to an existing audio file');
    const name = a.name || path.basename(a.path).replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9_\-.]/g, '_');
    const def = { name, kind: 'sample', source: path.resolve(a.path), loop: a.loop, root: a.root };
    saveDef(this, def, source);
    const au = getAudio(this, name, { force: true });
    def.stats = quickStats(au, def); saveDef(this, def, source);
    return { name, ...def.stats, use: `sampler zones: {sample:"${name}", root:"${a.root || 'c4'}"}; or art_audio compare {name:<yours>, reference:"${name}"}` };
  },

  /** Export WAV (16/24/32f) or mp3/ogg/opus via ffmpeg; loop smpl chunk + JSON sidecar (re-render recipe). */
  audio_export(a) {
    const s = store(this);
    const names = a.names || matchNames(s, a.name);
    if (!names.length || !names[0]) throw new Error('export needs name (wildcards ok: "gib_burst_*") or names:[...]');
    const format = a.format || 'wav';
    if (!['wav', 'mp3', 'ogg', 'opus'].includes(format)) throw new Error('format must be wav, mp3, ogg or opus');
    if (format !== 'wav' && !findFfmpeg()) throw new Error('ffmpeg not found (set AGENT_ART_FFMPEG or put ffmpeg on PATH); export format "wav" works without it');
    let dir = a.path ? (path.isAbsolute(a.path) ? a.path : path.join(s.d.exports, a.path)) : s.d.exports;
    const single = names.length === 1 && a.path && /\.(wav|mp3|ogg|opus)$/i.test(a.path) && !a.stems && !a.layers;
    if (single) dir = path.dirname(dir);
    fs.mkdirSync(dir, { recursive: true });
    const files = [];
    const askedSR = sampleRate(a.sample_rate);
    // renders run at 44.1 kHz; 48 kHz delivery is a windowed-sinc resample with sample-exact loop points
    const write = (chs, base, loop, sidecar, sr = SR) => {
      const f = `${base}.${format}`;
      const rs = resampleLoop(a.mono ? [toMono(chs)] : chs, SR, sr, loop);
      if (sidecar) { sidecar.sample_rate = sr; sidecar.samples = rs.chs[0].length; sidecar.duration = +(rs.chs[0].length / sr).toFixed(3); sidecar.loop = rs.loop ? { start: rs.loop[0], end: rs.loop[1] } : null; }
      if (format === 'wav') fs.writeFileSync(f, encodeWAV(rs.chs, { bits: a.bits ?? 16, loop: rs.loop, sr }));
      else encodeWithFfmpeg(rs.chs, f, { format, bitrate: a.bitrate, loop: rs.loop, sr });
      if (sidecar) fs.writeFileSync(`${base}.json`, JSON.stringify(sidecar, null, 1));
      files.push(f);
      return rs.loop;
    };
    for (const n of names) {
      const def = getDef(this, n);
      const outSR = askedSR ?? def.sample_rate ?? SR;
      const base = single ? a.path.replace(/\.(wav|mp3|ogg|opus)$/i, '') : path.join(dir, n);
      const absBase = path.isAbsolute(base) ? base : path.join(s.d.exports, base);
      fs.mkdirSync(path.dirname(absBase), { recursive: true });
      if (a.layers && def.kind === 'song') {
        // adaptive music: one file per intensity layer + a manifest for crossfading
        const L = renderLayers(def.song, { custom: s.inst });
        const rate = outSR / SR, lp = L.full.loop || null;
        const man = { name: n, tempo: L.song.tempo, beats_per_bar: L.song.time.beatsPerBar, sample_rate: outSR, loop_start: 0, loop_end: Math.round(L.full.L.length * rate), sections: L.full.timeline, layers: {}, crossfade_ms: 1500, transition: 'switch layers on bar lines; all layer files share the same length and loop points, so play them in sync and fade gains' };
        for (const [ln, lay] of Object.entries(L.layers)) {
          const nl = write([lay.L, lay.R], `${absBase}_${ln}`, lp, null, outSR);
          if (nl) { man.loop_start = nl[0]; man.loop_end = nl[1]; }
          man.layers[ln] = { file: path.basename(`${absBase}_${ln}.${format}`), tracks: lay.tracks };
        }
        fs.writeFileSync(`${absBase}_layers.json`, JSON.stringify(man, null, 1));
        files.push(`${absBase}_layers.json`);
        continue;
      }
      const au = getAudio(this, n, { stems: !!a.stems && def.kind === 'song' });
      const sidecar = { name: n, kind: def.kind, sample_rate: SR, samples: au.chs[0].length, duration: +(au.chs[0].length / SR).toFixed(3), loop: au.loop ? { start: au.loop[0], end: au.loop[1] } : null, render: { recipe: def.recipe, seed: def.seed, vars: def.vars, params: def.params, layers: def.layers, song: def.song }, tool: 'agent-art art_audio' };
      write(au.chs, absBase, au.loop, sidecar, outSR);
      if (a.stems && au.stems) for (const [t, chs] of Object.entries(au.stems)) write(chs, `${absBase}_stem_${t}`, au.loop, null, outSR);
    }
    return { files, count: files.length, format, sample_rate: askedSR ?? undefined, ffmpeg: format === 'wav' ? undefined : findFfmpeg()?.version };
  },
};
