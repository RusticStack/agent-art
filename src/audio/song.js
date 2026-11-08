// Song renderer: notation -> events -> per-track voices -> insert fx -> buses/sends -> master.
// Loops are seamless: the loop body is rendered on its own and its tail (reverb, releases) is
// wrapped back onto the loop start; an intro (sections before the loop) is rendered separately.
import { SR, db2a, makeRng, hashStr, panMono, addInto, clamp, filter } from './dsp.js';
import { applyFx, compress, limit, reverbAlgo, reverbConv, at } from './fx.js';
import { renderVoice, midiToFreq } from './voice.js';
import { resolvePatch, merge } from './presets.js';
import { parseEntry, parseTime, parseSongText, expandArrangement, parseKey } from './notation.js';
import { runGenerator } from './generators.js';
import { loudness, truePeak } from './analysis.js';

/** Normalize a song definition (JSON, or {text}) and resolve instruments. */
/** Track shorthands for mix carving (also usable from song text): hp=Hz lp=Hz cut=Hz cut_db=-3 cut_q=1.2 boost=Hz boost_db=2. */
function quickEq(t) {
  const bands = [];
  if (t.hp) bands.push({ type: 'hp', f: t.hp });
  if (t.lp) bands.push({ type: 'lp', f: t.lp });
  if (t.cut) bands.push({ type: 'peak', f: t.cut, q: t.cut_q ?? 1.2, gain: t.cut_db ?? -3 });
  if (t.boost) bands.push({ type: 'peak', f: t.boost, q: t.boost_q ?? 1, gain: t.boost_db ?? 2 });
  return bands.length ? [{ type: 'eq', bands }] : [];
}
export function normalizeSong(def, custom = {}) {
  let s = def.text ? merge(parseSongText(def.text), Object.fromEntries(Object.entries(def).filter(([k]) => k !== 'text'))) : { ...def };
  const time = parseTime(s.time || '4/4');
  const tempo = Number(s.tempo || 120);
  if (!(tempo >= 20 && tempo <= 400)) throw new Error('tempo must be 20..400 BPM');
  const stepsPerBar = s.steps || time.stepsPerBar;
  const barSec = (time.beatsPerBar * 60) / tempo;
  if (!s.sections || !Object.keys(s.sections).length) throw new Error('song needs sections: {intro:{bars:4, <track>:"pattern"}, ...}');
  if (!s.tracks || !Object.keys(s.tracks).length) throw new Error('song needs tracks: {gtr:{instrument:"metal_guitar"}, drums:{instrument:"metal_kit"}}');
  const arrangement = expandArrangement(s.arrangement, s.sections);
  const tracks = {};
  for (const [name, t0] of Object.entries(s.tracks)) {
    const t = typeof t0 === 'string' ? { instrument: t0 } : t0;
    const patch = t.patch ? resolvePatch({ base: t.instrument, ...t.patch }, custom) : resolvePatch(t.instrument, custom);
    const kit = patch.kit ? Object.fromEntries(Object.entries(patch.kit).map(([p, ref]) => [p, resolvePatch(ref, custom)])) : null;
    tracks[name] = {
      name, instrument: t.instrument, patch, kit,
      gain: t.gain ?? patch.gain ?? 0, pan: t.pan ?? patch.pan ?? 0, width: t.width ?? patch.width ?? 1,
      reverb: t.reverb ?? patch.reverb ?? 0.2, delay: t.delay ?? 0, bus: t.bus ?? (kit ? 'drums' : 'music'),
      double: t.double ?? patch.double ?? false, humanize: { ...(patch.humanize || {}), ...(t.humanize || {}) },
      octave: t.octave ?? patch.octave ?? 3, transpose: t.transpose ?? 0, root_only: t.root_only ?? patch.root_only ?? false,
      fx: [...(t.fx_replace ? [] : patch.fx || []), ...(t.fx || []), ...quickEq(t)], automation: t.automation || null, mute: !!t.mute, note: t.note,
      levels: { ...(patch.levels || {}), ...(t.levels || {}) }, pans: { ...(patch.pans || {}), ...(t.pans || {}) },
      round_robin: t.round_robin ?? patch.round_robin ?? 3,
    };
  }
  // timeline
  const timeline = [];
  let bar = 0;
  for (const name of arrangement) {
    const sec = s.sections[name];
    const bars = Number(sec.bars ?? 4);
    timeline.push({ section: name, bar, bars, start: bar * barSec, end: (bar + bars) * barSec });
    bar += bars;
  }
  let loop = s.loop ?? true;
  let loopStartBar = 0;
  if (typeof loop === 'string') { const t = timeline.find((x) => x.section === loop); if (!t) throw new Error(`loop "${loop}" is not a section in the arrangement`); loopStartBar = t.bar; }
  else if (loop && typeof loop === 'object') loopStartBar = loop.start_bar ?? 0;
  const totalBars = loop && typeof loop === 'object' && loop.end_bar ? loop.end_bar : bar;
  return {
    ...s, tempo, time, stepsPerBar, barSec, arrangement, tracks, timeline, totalBars, seed: s.seed ?? 1,
    loop: !!loop, loopStartBar, key: s.key || 'c minor', swing: s.swing ?? 0,
    reverbCfg: typeof s.reverb === 'string' ? { preset: s.reverb } : { preset: 'hall', ...(s.reverb || {}) },
    master: { target_lufs: -14, ceiling: -1, glue: true, ...(s.master || {}) },
  };
}

/** Convert [[bar, v], ...] automation curves to seconds (songs speak bars). */
function barsToSec(v, barSec) {
  if (Array.isArray(v) && v.length && v.every((p) => Array.isArray(p) && p.length === 2 && typeof p[0] === 'number')) return v.map(([b, x]) => [b * barSec, x]);
  if (Array.isArray(v)) return v.map((x) => barsToSec(x, barSec));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, barsToSec(x, barSec)]));
  return v;
}
const shiftCurve = (v, dt) => (Array.isArray(v) && v.length && Array.isArray(v[0]) && typeof v[0][0] === 'number' ? v.map(([t, x]) => [t - dt, x]) : Array.isArray(v) ? v.map((x) => shiftCurve(x, dt)) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shiftCurve(x, dt)])) : v);

/** All note events of the song: [{track, piece, t, dur, midis, vel, art}] with t in seconds. */
export function songEvents(song) {
  const out = [];
  const rr = new Map();
  for (const seg of song.timeline) {
    const sec = song.sections[seg.section];
    for (const [tn, tr] of Object.entries(song.tracks)) {
      if (tr.mute) continue;
      let entry = sec[tn];
      if (entry === undefined || entry === null) continue;
      if (entry && typeof entry === 'object' && (entry.gen || entry.generator)) {
        const g = runGenerator({ key: song.key, ...entry, bars: entry.bars ?? seg.bars });
        entry = typeof g === 'string' ? g : tr.kit ? g : g[entry.part || 'drone'];
      }
      const pieces = tr.kit ? Object.entries(entry || {}) : [[null, entry]];
      const rng = makeRng(hashStr(`${song.seed}|${tn}|${seg.bar}`));
      for (const [piece, pat] of pieces) {
        if (piece && !tr.kit[piece]) throw new Error(`track "${tn}" (kit) has no piece "${piece}". Pieces: ${Object.keys(tr.kit).join(', ')}`);
        const evs = parseEntry(pat, { bars: seg.bars, stepsPerBar: song.stepsPerBar, octave: tr.octave, key: song.key, note: tr.note || 'c3', transpose: tr.transpose + (sec.transpose ?? 0) });
        for (const e of evs) {
          let t = (seg.bar + e.pos) * song.barSec;
          const stepPos = e.pos * song.stepsPerBar;
          if (song.swing && Math.abs(stepPos - Math.round(stepPos)) < 1e-6 && Math.round(stepPos) % 2 === 1) t += song.swing * (song.barSec / song.stepsPerBar);
          const h = tr.humanize;
          if (h.time) t += rng.gauss() * h.time * 0.5;
          let vel = e.vel * (1 + (h.vel ? rng.gauss() * h.vel * 0.5 : 0)) * (sec.vel ?? 1);
          const midis = tr.root_only ? [Math.min(...e.midis)] : e.midis;
          const k = `${tn}|${piece}|${midis}`;
          const r = rr.get(k) || 0;
          rr.set(k, r + 1);
          out.push({ track: tn, piece, t: Math.max(0, t), dur: e.len * song.barSec, midis, vel: clamp(vel, 0.05, 1.2), art: e.art, rr: r, section: seg.section });
        }
      }
    }
  }
  return out;
}

function fit(chs, N) {
  return chs.map((c) => { if (c.length === N) return c; const o = new Float32Array(N); o.set(c.subarray(0, Math.min(N, c.length))); return o; });
}

/** Render one track's events (times relative to `t0`) into stereo [L, R] of N samples. */
function renderTrack(tr, events, { t0, N, song, ctx, cache }) {
  const voiceCtx = { getSample: ctx.getSample };
  const playInto = (buf, patch, ev, take, hitFx = null) => {
    const freqs = ev.midis.map(midiToFreq);
    const rrN = Math.max(1, tr.round_robin);
    const velQ = Math.round(ev.vel * 20) / 20;
    const key = `${ev.piece}|${ev.midis}|${Math.round(ev.dur * 1000)}|${velQ}|${JSON.stringify(ev.art)}|${ev.rr % rrN}|${take}`;
    let v = cache.get(key);
    if (!v) {
      v = renderVoice(patch, { freqs, dur: ev.dur, vel: velQ, art: ev.art, seed: hashStr(`${song.seed}|${tr.name}|${key}`), rr: ev.rr, tempo: song.tempo }, voiceCtx);
      // drum pieces: insert fx per cached hit (cheap, and equivalent for one-shots)
      if (hitFx && hitFx.length) v = applyFx([v], hitFx, { tempo: song.tempo })[0];
      cache.set(key, v);
    }
    addInto(buf, v, Math.round((ev.t - t0) * SR));
  };
  const fxCtx = { tempo: song.tempo, key: ctx.key };
  const fxList = shiftCurve(barsToSec(tr.fx, song.barSec), t0);
  let chs;
  if (tr.kit) {
    const L = new Float32Array(N), R = new Float32Array(N);
    const byPiece = new Map();
    for (const e of events) { if (!byPiece.has(e.piece)) byPiece.set(e.piece, []); byPiece.get(e.piece).push(e); }
    for (const [piece, evs] of byPiece) {
      const p = tr.kit[piece];
      let buf = new Float32Array(N);
      for (const e of evs) playInto(buf, p, e, 0, p.fx);
      let pc = [buf];
      const g = db2a((tr.levels[piece] ?? 0) + (p.gain ?? 0));
      if (pc.length === 1) pc = panMono(pc[0], tr.pans[piece] ?? 0, g);
      else for (const c of pc) for (let i = 0; i < N; i++) c[i] *= g;
      addInto(L, pc[0]); addInto(R, pc[1]);
    }
    chs = fit(applyFx([L, R], fxList, fxCtx), N);
  } else {
    const takes = tr.double ? 2 : 1;
    const outs = [];
    for (let k = 0; k < takes; k++) {
      const buf = new Float32Array(N);
      // second take: own seeds + its own humanize offsets so L/R differ like real double-tracking
      const r = makeRng(hashStr(`${tr.name}|take${k}`));
      for (const e of events) playInto(buf, tr.patch, k ? { ...e, t: e.t + (tr.humanize.time ?? 0.006) * r.gauss() * 0.6 } : e, k);
      outs.push(fit(applyFx([buf], fxList, fxCtx), N));
    }
    if (takes === 2) chs = [outs[0][0], outs[1][0]].map((c) => { const o = Float32Array.from(c); for (let i = 0; i < N; i++) o[i] *= Math.SQRT1_2 * 1.2; return o; });
    else chs = outs[0].length === 1 ? panMono(outs[0][0], 0, 1) : outs[0];
  }
  // pan (balance), width, gain, automation
  const [L, R] = chs;
  const auto = tr.automation ? shiftCurve(barsToSec(tr.automation, song.barSec), t0) : {};
  const pan = auto.pan ?? tr.pan, gain = auto.gain ?? tr.gain, wdt = tr.width;
  const curve = Array.isArray(pan) || Array.isArray(gain);
  const thL = (p) => Math.cos(((clamp(p, -1, 1) + 1) * Math.PI) / 4) * Math.SQRT2, thR = (p) => Math.sin(((clamp(p, -1, 1) + 1) * Math.PI) / 4) * Math.SQRT2;
  let gl = thL(at(pan, 0)) * db2a(at(gain, 0)), gr = thR(at(pan, 0)) * db2a(at(gain, 0));
  for (let i = 0; i < N; i++) {
    if (curve && (i & 63) === 0) { const p = at(pan, i), g = db2a(at(gain, i)); gl = thL(p) * g; gr = thR(p) * g; }
    let l = L[i], r = R[i];
    if (wdt !== 1) { const m = (l + r) / 2, s = ((l - r) / 2) * wdt; l = m + s; r = m - s; }
    L[i] = l * gl; R[i] = r * gr;
  }
  if (auto.cutoff) { filter(L, 'lp', (i) => at(auto.cutoff, i), 0.7); filter(R, 'lp', (i) => at(auto.cutoff, i), 0.7); }
  return [L, R];
}

/**
 * Render events with t in [from, to) into a buffer starting at `from` (seconds), length
 * (to - from) + tail. Returns {mix, stems, sends}.
 */
function renderRange(song, events, { from, to, tail, ctx, stems, only }) {
  const N = Math.round((to - from + tail) * SR);
  const mix = [new Float32Array(N), new Float32Array(N)];
  const stemOut = {};
  const buses = {};
  const revIn = [new Float32Array(N), new Float32Array(N)], delIn = [new Float32Array(N), new Float32Array(N)];
  const keys = new Map();
  // tracks used as sidechain keys render first
  const keyNames = new Set();
  for (const tr of Object.values(song.tracks)) for (const f of tr.fx) if (f.type === 'duck' || ((f.type === 'comp') && (f.key || f.sidechain))) keyNames.add(f.from || f.key || f.sidechain);
  const order = Object.values(song.tracks).sort((a, b) => (keyNames.has(b.name) ? 1 : 0) - (keyNames.has(a.name) ? 1 : 0));
  const perTrackRev = {};
  for (const tr of order) {
    if (only && !only.includes(tr.name) && !keyNames.has(tr.name)) continue;
    const evs = events.filter((e) => e.track === tr.name && e.t >= from - 1e-9 && e.t < to - 1e-9);
    const cache = ctx.caches.get(tr.name) || new Map();
    ctx.caches.set(tr.name, cache);
    const chs = evs.length ? renderTrack(tr, evs, { t0: from, N, song, ctx: { ...ctx, key: (n) => keys.get(n) }, cache }) : null;
    if (chs && keyNames.has(tr.name)) { const m = new Float32Array(N); for (let i = 0; i < N; i++) m[i] = (chs[0][i] + chs[1][i]) / 2; keys.set(tr.name, m); }
    if (!chs || (only && !only.includes(tr.name))) continue;
    if (tr.reverb > 0) {
      if (stems === true) perTrackRev[tr.name] = tr.reverb;
      for (let c = 0; c < 2; c++) addInto(revIn[c], chs[c], 0, tr.reverb);
    }
    if (tr.delay > 0) for (let c = 0; c < 2; c++) addInto(delIn[c], chs[c], 0, tr.delay);
    if (stems) stemOut[tr.name] = chs;
    const bus = tr.bus || 'music';
    if (!buses[bus]) buses[bus] = [new Float32Array(N), new Float32Array(N)];
    addInto(buses[bus][0], chs[0]); addInto(buses[bus][1], chs[1]);
  }
  // buses with their own fx (drum bus glue, music bus)
  for (const [name, b] of Object.entries(buses)) {
    const cfg = song.buses?.[name];
    const out = cfg?.fx ? fit(applyFx(b, shiftCurve(barsToSec(cfg.fx, song.barSec), from), { tempo: song.tempo }), N) : b;
    const g = db2a(cfg?.gain ?? 0);
    addInto(mix[0], out[0], 0, g); addInto(mix[1], out[1], 0, g);
  }
  // reverb send (one shared space, like a real mix); in stems mode each stem gets its own share
  // (stems:'dry' = analysis: stems stay pre-reverb and the mix keeps the single shared reverb, 2x faster)
  const rc = song.reverbCfg;
  const wetG = db2a(rc.return ?? 0) * (rc.wet ?? 1);
  const runRev = (inp) => fit(rc.type === 'convolution' || rc.conv ? reverbConv(inp, rc) : reverbAlgo(inp, { ...rc, tail: 0 }), N);
  if (stems === true) {
    for (const [n, amt] of Object.entries(perTrackRev)) {
      const inp = stemOut[n].map((c) => { const o = Float32Array.from(c); for (let i = 0; i < N; i++) o[i] *= amt; return o; });
      const w = runRev(inp);
      for (let c = 0; c < 2; c++) { addInto(stemOut[n][c], w[c], 0, wetG); addInto(mix[c], w[c], 0, wetG); }
    }
  } else if (Object.keys(song.tracks).some((k) => song.tracks[k].reverb > 0)) {
    const w = runRev(revIn);
    for (let c = 0; c < 2; c++) addInto(mix[c], w[c], 0, wetG);
  }
  if (song.delay && delIn[0].some((v) => v !== 0)) {
    const d = fit(applyFx(delIn, [{ type: 'delay', mix: 1, ...song.delay }], { tempo: song.tempo }), N);
    for (let c = 0; c < 2; c++) { for (let i = 0; i < N; i++) d[c][i] -= delIn[c][i]; addInto(mix[c], d[c]); }
  }
  return { mix, stems: stemOut, N };
}

function wrapTail(chs, bodyN) {
  return chs.map((c) => {
    const o = c.slice(0, bodyN);
    for (let i = bodyN; i < c.length; i++) o[(i - bodyN) % bodyN] += c[i];
    return o;
  });
}

/** Master chain: HP, glue compression, loudness to target, true-peak-safe limiter. */
export function master(chs, cfg = {}, { loudRegion = null } = {}) {
  const target = cfg.target_lufs ?? -14, ceiling = cfg.ceiling ?? -1;
  for (const c of chs) filter(c, 'hp', cfg.hp ?? 25, 0.7);
  if (cfg.eq) chs = applyFx(chs, [{ type: 'eq', bands: cfg.eq }]);
  const region = (x) => (loudRegion ? x.map((c) => c.subarray(loudRegion[0], loudRegion[1])) : x);
  let L0 = loudness(region(chs)).integrated;
  if (L0 < -100) return { chs, gain_db: 0, lufs: L0 };
  // pre-gain into the glue compressor at a consistent level
  let pre = -20 - L0;
  for (const c of chs) for (let i = 0; i < c.length; i++) c[i] *= db2a(pre);
  let glueGR = 0;
  if (cfg.glue !== false) glueGR = compress(chs, { threshold: cfg.glue_threshold ?? -16, ratio: cfg.glue_ratio ?? 2, attack: 0.03, release: 0.25, knee: 8 });
  const L1 = loudness(region(chs)).integrated;
  const base = chs.map((c) => Float32Array.from(c));
  let g = target - L1, out, lim = 0;
  for (let it = 0; it < 3; it++) {
    out = base.map((c) => { const o = Float32Array.from(c); const k = db2a(g); for (let i = 0; i < o.length; i++) o[i] *= k; return o; });
    lim = limit(out, { ceiling: ceiling - 0.4, release: cfg.release ?? 0.06, lookahead: 0.003 });
    const L2 = loudness(region(out)).integrated;
    if (Math.abs(L2 - target) < 0.3) break;
    g += target - L2;
  }
  // true-peak safety: reduce if inter-sample peaks exceed the ceiling
  const tp = 20 * Math.log10(truePeak(out) || 1e-9);
  if (tp > ceiling) { const k = db2a(ceiling - tp - 0.05); for (const c of out) for (let i = 0; i < c.length; i++) c[i] *= k; }
  return { chs: out, gain_db: +(pre + g).toFixed(2), glue_gr_db: +glueGR.toFixed(1), limiter_gr_db: +lim.toFixed(1) };
}

/**
 * Render a song. Returns {L, R, stems?, loop:[start,end] samples|null, timeline, events, perf}.
 * opts: {custom, getSample, stems, layers (bool: render intensity layers), only:[tracks]}
 */
export function renderSong(def, opts = {}) {
  const t0 = performance.now();
  const song = def.timeline ? def : normalizeSong(def, opts.custom);
  const events = songEvents(song);
  const ctx = { getSample: opts.getSample, caches: new Map() };
  const total = song.totalBars * song.barSec;
  const loopStart = song.loop ? song.loopStartBar * song.barSec : null;
  const tail = song.tail ?? 6;
  const stems = opts.stems === 'dry' ? 'dry' : !!opts.stems;
  let mix, stemOut = {}, loopS = null;
  const only = opts.only;
  if (!song.loop) {
    const r = renderRange(song, events, { from: 0, to: total, tail, ctx, stems, only });
    mix = r.mix; stemOut = r.stems;
  } else {
    const S = Math.round(loopStart * SR), E = Math.round(total * SR);
    const body = renderRange(song, events, { from: loopStart, to: total, tail, ctx, stems, only });
    const bodyN = E - S;
    const wrapped = wrapTail(body.mix, bodyN);
    const wrappedStems = Object.fromEntries(Object.entries(body.stems).map(([k, v]) => [k, wrapTail(v, bodyN)]));
    if (S > 0) {
      // intro: its own render; its tail fades out over the last 0.25 s before the loop start
      const intro = renderRange(song, events, { from: 0, to: loopStart, tail: 0, ctx, stems, only });
      const fadeN = Math.min(S, Math.round(0.25 * SR));
      const fade = (chs) => chs.map((c) => { const o = c.slice(0, S); for (let i = 0; i < fadeN; i++) o[S - 1 - i] *= i / fadeN; return o; });
      const cat = (a, b) => [0, 1].map((c) => { const o = new Float32Array(S + bodyN); o.set(a[c]); o.set(b[c], S); return o; });
      mix = cat(fade(intro.mix), wrapped);
      for (const k of new Set([...Object.keys(intro.stems), ...Object.keys(wrappedStems)])) stemOut[k] = cat(intro.stems[k] ? fade(intro.stems[k]) : [new Float32Array(S), new Float32Array(S)], wrappedStems[k] || [new Float32Array(bodyN), new Float32Array(bodyN)]);
    } else { mix = wrapped; stemOut = wrappedStems; }
    loopS = [S, E];
  }
  const tRender = performance.now();
  // mastering: for loops, process [intro][loop][loop] and keep the second loop copy so the
  // compressor/limiter state at the seam matches what the player hears when it wraps
  let mastered, mInfo;
  const mcfg = song.master;
  if (mcfg.bypass) { mastered = mix; mInfo = { gain_db: 0 }; }
  else if (loopS) {
    const [S, E] = loopS, B = E - S;
    const tri = [0, 1].map((c) => { const o = new Float32Array(S + 2 * B); o.set(mix[c]); o.set(mix[c].subarray(S), S + B); return o; });
    const r = master(tri, mcfg, { loudRegion: [S, S + B] });
    mastered = r.chs.map((c) => { const o = new Float32Array(S + B); o.set(c.subarray(0, S)); o.set(c.subarray(S + B, S + 2 * B), S); return o; });
    mInfo = r;
  } else { const r = master(mix, mcfg); mastered = r.chs; mInfo = r; }
  // stems carry the static master gain (not the limiter), so they sum back to ~the mix
  if (stems) { const k = db2a(mInfo.gain_db || 0); for (const v of Object.values(stemOut)) for (const c of v) for (let i = 0; i < c.length; i++) c[i] *= k; }
  return {
    L: mastered[0], R: mastered[1], stems: stems ? stemOut : null, loop: loopS, song, events,
    timeline: song.timeline.map((t) => ({ ...t, start: +t.start.toFixed(3), end: +t.end.toFixed(3) })),
    master: { gain_db: mInfo.gain_db, glue_gr_db: mInfo.glue_gr_db, limiter_gr_db: mInfo.limiter_gr_db },
    perf: { render_ms: Math.round(tRender - t0), master_ms: Math.round(performance.now() - tRender), events: events.length, seconds: +(mastered[0].length / SR).toFixed(2) },
  };
}

/** Intensity layers for adaptive music: {explore:[tracks], combat:[tracks], boss:[tracks]} -> per-layer stems. */
export function renderLayers(def, opts = {}) {
  const song = def.timeline ? def : normalizeSong(def, opts.custom);
  const layers = song.layers || { full: Object.keys(song.tracks) };
  const full = renderSong(song, { ...opts, stems: true });
  const out = {};
  const used = new Set();
  for (const [name, tracks] of Object.entries(layers)) {
    // additive layers: each layer file holds only the tracks it adds (game sums active layers)
    const add = tracks.filter((t) => !used.has(t));
    add.forEach((t) => used.add(t));
    const L = new Float32Array(full.L.length), R = new Float32Array(full.L.length);
    for (const t of add) { const s = full.stems[t]; if (!s) continue; addInto(L, s[0]); addInto(R, s[1]); }
    limit([L, R], { ceiling: -1.4 });
    out[name] = { tracks: add, L, R };
  }
  return { full, layers: out, song };
}

export { parseKey };
