// Engine ops for the first-person viewmodel pipeline (art_fp): kit models, gun / magazine /
// attachment / item sweeps (fp_guns, fp_mags, fp_attach manifests), the arms batch per skin x
// class x clip (group fp), the runtime-identical composite and the fp check. Files land in an
// asset root laid out like the game's public/assets (manifest/<group>.json + fp/...).
import fs from 'node:fs';
import path from 'node:path';
import { FRAME, CENTRE, F, D, PX_PER_M, composite, drawCell, cellIndex, anchorOf, placeAnchor, steps, RENDER_ORDER, SLOT_ANCHOR, r1, project } from './fp.js';
import { gunModel, magModel, attachModel, itemModel, fpGeometry, GUN_CLASSES, ITEM_CLASSES, FP_CLASSES, ATTACH, ITEMS, MAGS, FP_UNIT } from './fpkit.js';
import { buildRig, renderSweep, packSheets, unpackSheets, anchorJumps } from './fpsweep.js';
import { classClips, clipAngles, solveClip, VARIANTS, VARIANT_CLASSES, variantClips } from './fpclips.js';
import { SKINS, renderBones } from './fparms.js';
import { colorsOf } from './fppaint.js';
import { posedWorld, resolveOffsets } from './modelrig.js';
import { encodePNG, decodePNG } from './png.js';
import { packImages } from './sheet.js';
import { modelDefs } from './modelops.js';
import { conform } from './handling.js';
import { Doc } from './doc.js';

export const GRID_STEP = 10;
/** Gun grids never go past these (deg): the extreme sprint / melee frames take the nearest cell. */
export const GRID_LIMITS = { yaw: [-40, 70], pitch: [-20, 40] };
const MAG_OF = Object.fromEntries(GUN_CLASSES.map((c) => [c, gunModel(c).fp.mag]));

// ---------- model resolution + caches ----------
/** A model definition by name: workspace art_model first, else the built-in kit. */
export function fpDef(engine, name, kind) {
  const ws = engine ? modelDefs(engine).get(name) : null;
  if (ws) return ws;
  if (kind === 'gun' || (!kind && GUN_CLASSES.includes(name))) return gunModel(name);
  if (kind === 'mag' || (!kind && MAGS.includes(name))) return magModel(name);
  if (kind === 'attachment' || (!kind && ATTACH[name])) return attachModel(name);
  if (kind === 'item' || (!kind && ITEMS[name])) return itemModel(name);
  throw new Error(`no model "${name}" (workspace art_model or kit: guns ${GUN_CLASSES.join(', ')}; mags ${MAGS.join(', ')}; attachments ${Object.keys(ATTACH).join(', ')}; items ${Object.keys(ITEMS).join(', ')})`);
}
const CACHE = new Map();
const memo = (k, fn) => { if (!CACHE.has(k)) CACHE.set(k, fn()); return CACHE.get(k); };
export const clearFpCache = () => CACHE.clear();
const defKey = (def) => JSON.stringify(def.parts).length + ':' + (def.updated ?? def.created ?? 0) + ':' + def.name;

/** Snap a range to a grid with a margin: [min, max, step]. */
function gridOf(vals, step = GRID_STEP, margin = 4, clampTo = [-90, 90]) {
  let lo = Math.max(clampTo[0], Math.floor((Math.min(...vals) - margin) / step) * step), hi = Math.min(clampTo[1], Math.ceil((Math.max(...vals) + margin) / step) * step);
  if (hi < lo) hi = lo;
  hi = lo + Math.round((hi - lo) / step) * step;
  return [lo, hi, step];
}
/** The sweep grid of a gun class: every apparent angle its clips use (+ margin), snapped. */
export function classGrid(cls, step = GRID_STEP) {
  return memo(`grid:${cls}:${step}`, () => {
    const C = classClips(cls), ang = Object.values(C).flatMap((c) => clipAngles(c, cls));
    const states = {};
    for (const a of ang) if (a.state) (states[a.state] = states[a.state] || []).push(a);
    return {
      yaw: gridOf(ang.map((a) => a.yaw), step, 4, GRID_LIMITS.yaw), pitch: gridOf(ang.map((a) => a.pitch), step, 4, GRID_LIMITS.pitch),
      states: Object.fromEntries(Object.entries(states).map(([s, v]) => [s, { yaw: gridOf(v.map((a) => a.yaw), step, 4, GRID_LIMITS.yaw), pitch: gridOf(v.map((a) => a.pitch), step, 4, GRID_LIMITS.pitch) }])),
    };
  });
}
const union = (grids) => {
  const step = Math.min(...grids.map((g) => g[2]));
  return [Math.min(...grids.map((g) => g[0])), Math.max(...grids.map((g) => g[1])), step];
};
/** Grid of a magazine (union of the classes it feeds) / attachment (compatible classes) / item (clips using it). */
export function magGrid(name, step = GRID_STEP) { const cs = GUN_CLASSES.filter((c) => MAG_OF[c] === name); const gs = (cs.length ? cs : ['rifle']).map((c) => classGrid(c, step)); return { yaw: union(gs.map((g) => g.yaw)), pitch: union(gs.map((g) => g.pitch)), host: gunModel(cs[0] || 'rifle').sockets.mag_well.at }; }
export function attachGrid(name, step = GRID_STEP) {
  const slot = attachModel(name).fp.slot, anchor = SLOT_ANCHOR[slot];
  const cs = GUN_CLASSES.filter((c) => fpGeometry(c)[anchor] && gunModel(c).sockets[anchor]);
  const gs = cs.map((c) => classGrid(c, step));
  // host: the rifle when it fits (else the first compatible class): cells show the attachment as mounted there
  const host = cs.includes('rifle') ? 'rifle' : cs[0];
  return { yaw: union(gs.map((g) => g.yaw)), pitch: union(gs.map((g) => g.pitch)), classes: cs, host: gunModel(host).sockets[anchor].at, host_class: host };
}
function itemGrid(id, step) {
  return memo(`igrid:${id}:${step}`, () => {
    const vals = [];
    for (const cls of FP_CLASSES) {
      const C = classClips(cls);
      for (const c of Object.values(C)) {
        if (!c.keys.some((k) => k.item?.id === id)) continue;
        const sol = solveClip(c, classCtx(cls, step, { anglesOnly: true }));
        for (const fr of sol.frames) if (fr.item?.id === id) vals.push(fr.item);
      }
    }
    if (!vals.length) return { yaw: [-24, 24, step], pitch: [-24, 24, step] };
    return { yaw: gridOf(vals.map((v) => v.yaw), step, 6), pitch: gridOf(vals.map((v) => v.pitch), step, 6) };
  });
}

/** Sweep (cached) of a model with a grid: {def, cells, depths, ...}. */
export function sweepOf(engine, name, kind, grid, extra = {}) {
  const def = fpDef(engine, name, kind);
  return memo(`sweep:${defKey(def)}:${kind}:${JSON.stringify(grid)}:${JSON.stringify(extra)}`, () => renderSweep(buildRig(engine, def, (n) => fpDef(engine, n)), { yaw: grid.yaw, pitch: grid.pitch, kind, ...(grid.host ? { host: grid.host } : {}), ...extra }));
}
/** Gun-space sockets of a model in a state (pose). */
function socketsIn(engine, def, state) {
  return memo(`sock:${defKey(def)}:${state || ''}`, () => {
    const rig = buildRig(engine, def, (n) => fpDef(engine, n));
    const pose = state && def.poses?.[state] ? resolveOffsets(def, rig.info, { pose: state }) : new Map();
    const { sockets } = posedWorld(rig.info, pose, { mesh: false });
    return Object.fromEntries([...sockets].map(([k, s]) => [k.replace(/^socket_/, ''), s.pos]));
  });
}

/**
 * Solve context of a class: standard gun / mag / foregrip sweeps on the class grid.
 * opts: {engine, gun (model name), variant (vgrip|agrip), anglesOnly}
 */
export function classCtx(cls, step = GRID_STEP, opts = {}) {
  const engine = opts.engine || null;
  if (!GUN_CLASSES.includes(cls)) return { cls, gun: null, mag: null };
  const grid = classGrid(cls, step);
  const gunName = opts.gun || cls;
  const gdef = fpDef(engine, gunName, 'gun');
  const gun = opts.anglesOnly ? { def: { yaw: grid.yaw, pitch: grid.pitch, anchors: new Proxy({}, { get: () => [[0, 0]] }) } } : sweepOf(engine, gunName, 'gun', grid);
  const ctx = { cls, gun, gunDef: gdef, mag: gdef.fp?.mag || MAG_OF[cls], gunSockets: (state) => socketsIn(engine, gdef, state) };
  if (opts.variant && !opts.anglesOnly) {
    const an = VARIANTS[opts.variant].attachment;
    ctx.variant = opts.variant;
    ctx.att = { sweep: sweepOf(engine, an, 'attachment', attachGrid(an, step)), sockets: socketsIn(engine, attachModel(an), null) };
  }
  return ctx;
}

// ---------- arms frames ----------
/**
 * Render the arms of one solved frame and split them against the props (gun, magazine, foregrip,
 * item cells as the runtime draws them, with their depth): arm pixels behind a prop surface go to
 * the back layer, the rest to the front layer. -> {back, front} RGBA frames.
 */
export function armsLayers(frame, skin, sweeps) {
  const [W, H] = FRAME;
  const bones = [...frame.hands.R.bones, ...frame.hands.L.bones];
  const buf = renderBones(bones, skin);
  const pd = new Float32Array(W * H).fill(Infinity), scratch = new Uint8ClampedArray(W * H * 4);
  for (const p of frame.props) {
    const sw = p.kind === 'gun' ? sweeps.gun : p.kind === 'mag' || p.kind === 'mag_in' ? sweeps.mag : p.kind === 'att' ? sweeps.att : p.kind === 'item' ? sweeps.items?.[p.id] : null;
    if (!sw) continue;
    // cells without depth maps (hand-drawn / imported sweeps) count as a flat card at the reference depth
    if (!sw.depths) sw.depths = sw.cells.map(() => new Float32Array(sw.def.cell[0] * sw.def.cell[1]));
    const idx = p.kind === 'gun' ? p.idx : cellIndex(sw.def, p.yaw, p.pitch);
    const a = anchorOf(sw.def, p.kind === 'item' ? 'grip' : p.kind === 'gun' ? 'grip' : 'mount', idx);
    if (!a) continue;
    drawCell(scratch, W, H, sw, idx, a, p.x, p.y, p.rot, 1, { depth: { buf: pd, cells: sw.depths, base: p.depth } });
  }
  const back = new Uint8ClampedArray(W * H * 4), front = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    if (!buf.rgba[i * 4 + 3]) continue;
    (pd[i] < buf.depth[i] - 0.6 ? back : front).set(buf.rgba.subarray(i * 4, i * 4 + 4), i * 4);
  }
  return { back, front };
}
/** Frames -> horizontal strip {width, height, data}. */
export function strip(frames) {
  const [W, H] = FRAME, n = frames.length, data = new Uint8ClampedArray(W * n * H * 4);
  frames.forEach((fr, k) => { for (let y = 0; y < H; y++) data.set(fr.subarray(y * W * 4, (y + 1) * W * 4), (y * W * n + k * W) * 4); });
  return { width: W * n, height: H, data };
}
const sockOut = (s) => Object.fromEntries(Object.entries(s).filter(([, v]) => v !== undefined));

/**
 * Bake one clip of a class: solve, render, split. -> {anim (manifest entry without files), back,
 * front (strips), locks (per-frame hand locks for the check), metrics}
 */
export function bakeClip(cls, clipName, { skin = 'mec', variant = null, engine = null, step = GRID_STEP, gun } = {}) {
  const C = classClips(cls);
  const clip = C[clipName];
  if (!clip) throw new Error(`class "${cls}" has no clip "${clipName}" (clips: ${Object.keys(C).join(', ')})`);
  const ctx = classCtx(cls, step, { engine, variant, gun });
  const sol = solveClip(clip, ctx);
  const magName = clip.mag === 'shell' ? 'shotgun_shell' : ctx.mag;
  const sweeps = { gun: ctx.gun, att: ctx.att?.sweep, items: {} };
  if (magName) sweeps.mag = sweepOf(engine, magName, 'mag', magGrid(magName, step));
  for (const fr of sol.frames) if (fr.item && !sweeps.items[fr.item.id]) sweeps.items[fr.item.id] = sweepOf(engine, fr.item.id, 'item', itemGrid(fr.item.id, step));
  const backs = [], fronts = [], locks = [];
  let worstMiss = 0, clamped = 0;
  for (const fr of sol.frames) {
    const { back, front } = armsLayers(fr, skin, sweeps);
    backs.push(back); fronts.push(front);
    const L = {};
    for (const side of ['R', 'L']) {
      const h = fr.hands[side];
      if (h.target2) { const p = project(h.palm); const miss = Math.hypot(p[0] - h.target2[0], p[1] - h.target2[1]); L[side] = { at: h.target2.map(r1), palm: [r1(p[0]), r1(p[1])], miss: r1(miss) }; worstMiss = Math.max(worstMiss, miss); }
      if (h.clamped) clamped++;
    }
    locks.push(L);
  }
  const anim = { frames: clip.frames, fps: clip.fps, loop: !!clip.loop };
  if (ctx.gun) {
    anim.gun = sol.frames.map((f) => sockOut(f.gun));
    anim.mag = sol.frames.map((f) => sockOut(f.mag || { state: 'hidden' }));
  } else anim.gun = [{ hidden: true }];
  anim.item = sol.frames.some((f) => f.item) ? sol.frames.map((f) => (f.item ? sockOut(f.item) : { hidden: true })) : [];
  anim.events = sol.events.map((e) => ({ f: e.f, e: e.e }));
  if (clip.mag === 'shell') anim.mag_sweep = 'shotgun_shell';
  return { anim, back: strip(backs), front: strip(fronts), locks, frames: sol.frames, sweeps, metrics: { worst_hand_miss_px: r1(worstMiss), reach_clamped_frames: clamped } };
}

// ---------- files ----------
const writePNG = (root, rel, img) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, encodePNG(img.width, img.height, img.data)); return f; };
function readManifest(root, group) { const f = path.join(root, 'manifest', `${group}.json`); return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {}; }
function writeManifest(root, group, m) { const f = path.join(root, 'manifest', `${group}.json`); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(m, null, 1)); return f; }
const assetRoot = (engine, a) => (engine.resolvePath ? engine.resolvePath(a.out || 'fp_assets', engine.exportDir) : path.resolve(a.out || 'fp_assets'));

/** Write a sweep's sheets + manifest entry. */
function exportSweep(root, dir, sweep, extra = {}) {
  const { sheets } = packSheets(sweep);
  const files = sheets.map((s, i) => { const rel = `${dir}/sweep_${i}.png`; writePNG(root, rel, s); return rel; });
  return { ...sweep.def, ...extra, sheets: files, px_per_m: PX_PER_M };
}

function listArg(v, all) { if (v === undefined || v === true) return all; if (v === false || v === null) return []; return [].concat(v); }

export const FP_OPS = {
  /** Kit models into the workspace (art_model definitions you can edit). */
  fp_kit(a, source) {
    const names = [];
    const make = (def) => { if (!a.overwrite && modelDefs(this).has(def.name)) return; this.run('model_create', { ...def, overwrite: true }, source); names.push(def.name); };
    for (const c of listArg(a.guns, GUN_CLASSES)) make(gunModel(c));
    for (const m of listArg(a.mags, MAGS)) make(magModel(m));
    for (const n of listArg(a.attachments, Object.keys(ATTACH))) make(attachModel(n));
    for (const i of listArg(a.items, Object.keys(ITEMS))) make(itemModel(i));
    return { created: names, next: 'art_fp sweep {out} renders their sweeps; art_model preview {name} shows one; edit parts with art_model update (anchors are sockets)' };
  },

  /** Gun / magazine / attachment / item sweeps -> manifests fp_guns, fp_mags, fp_attach. */
  fp_sweep(a) {
    const root = assetRoot(this, a), step = Number(a.step ?? GRID_STEP), t0 = performance.now();
    const out = { guns: {}, mags: {}, attachments: {}, items: {} };
    const mg = readManifest(root, 'fp_guns'), mm = readManifest(root, 'fp_mags'), ma = readManifest(root, 'fp_attach');
    mg.sweeps = mg.sweeps || {}; mm.sweeps = mm.sweeps || {}; ma.sweeps = ma.sweeps || {};
    for (const name of listArg(a.guns, GUN_CLASSES)) {
      const def = fpDef(this, name, 'gun');
      const cls = def.fp?.class;
      if (!cls) throw new Error(`model "${name}" is not an fp gun (needs fp:{kind:"gun", class}; art_fp kit makes the kit guns)`);
      const grid = classGrid(cls, step);
      const sw = sweepOf(this, name, 'gun', grid);
      mg.sweeps[name] = exportSweep(root, `fp/guns/${name}`, sw);
      const rep = { cell: sw.def.cell, cells: sw.cells.length, sheets: mg.sweeps[name].sheets.length, colors: colorsOf(...sw.cells).size };
      if (a.states !== false) for (const [st, g] of Object.entries(grid.states)) {
        if (!def.poses?.[st]) continue;
        const ss = sweepOf(this, name, 'gun', g, { state: st });
        mg.sweeps[`${name}@${st}`] = exportSweep(root, `fp/guns/${name}/${st}`, ss);
        rep.states = { ...(rep.states || {}), [st]: { cells: ss.cells.length, sheets: mg.sweeps[`${name}@${st}`].sheets.length } };
      }
      out.guns[name] = rep;
    }
    for (const name of listArg(a.mags, MAGS)) {
      const sw = sweepOf(this, name, 'mag', magGrid(name, step));
      mm.sweeps[name] = exportSweep(root, `fp/mags/${name}`, sw);
      out.mags[name] = { cell: sw.def.cell, cells: sw.cells.length, sheets: mm.sweeps[name].sheets.length };
    }
    for (const name of listArg(a.attachments, Object.keys(ATTACH))) {
      const g = attachGrid(name, step), def = fpDef(this, name, 'attachment');
      const sw = sweepOf(this, name, 'attachment', g);
      ma.sweeps[`att:${name}`] = exportSweep(root, `fp/attach/${name}`, sw, { classes: g.classes, host: g.host_class });
      out.attachments[name] = { slot: def.fp.slot, cell: sw.def.cell, cells: sw.cells.length, sheets: ma.sweeps[`att:${name}`].sheets.length };
      if (def.fp.lens && a.lens !== false) {
        const ls = sweepOf(this, name, 'attachment', g, { only: [def.fp.lens], cell: sw.def.cell });
        ma.sweeps[`att:${name}@lens`] = exportSweep(root, `fp/attach/${name}/lens`, ls);
        out.attachments[name].lens = true;
      }
    }
    for (const id of listArg(a.items, Object.keys(ITEMS))) {
      const sw = sweepOf(this, id, 'item', itemGrid(id, step));
      ma.sweeps[`item:${id}`] = exportSweep(root, `fp/items/${id}`, sw);
      out.items[id] = { cell: sw.def.cell, cells: sw.cells.length, sheets: ma.sweeps[`item:${id}`].sheets.length };
    }
    const files = [writeManifest(root, 'fp_guns', mg), writeManifest(root, 'fp_mags', mm), writeManifest(root, 'fp_attach', ma)];
    return { root, manifests: files, ...out, px_per_m: PX_PER_M, camera: { frame: FRAME, focal_px: F, reference_depth_cm: D }, ms: Math.round(performance.now() - t0) };
  },

  /** Arms strips per skin x class x clip (+ @vgrip / @agrip variants) -> manifest fp. */
  fp_batch(a) {
    const root = assetRoot(this, a), t0 = performance.now(), step = Number(a.step ?? GRID_STEP);
    const skins = listArg(a.skins, ['mec']);
    for (const s of skins) if (!SKINS[s]) throw new Error(`unknown skin "${s}" (${Object.keys(SKINS).join(', ')})`);
    const classes = listArg(a.classes, FP_CLASSES);
    const man = readManifest(root, 'fp');
    man.sprites = man.sprites || {};
    const report = {};
    let frames = 0, worst = 0, clampedTotal = 0;
    for (const skin of skins) for (const cls of classes) {
      const C = classClips(cls), names = listArg(a.clips, Object.keys(C)).filter((n) => C[n]);
      const setName = skin === skins[0] && skin === (a.default_skin ?? skins[0]) ? `fp_${cls}` : `fp_${cls}.${skin}`;
      const dir = skin === skins[0] ? `fp/arms_${cls}` : `fp/${skin}/arms_${cls}`;
      const set = man.sprites[setName] || { frame: FRAME, anchor: FRAME, class: cls, anims: {} };
      set.frame = FRAME; set.anchor = FRAME; set.class = cls;
      const locks = {};
      const jobs = names.map((n) => [n, null]);
      if (a.variants !== false && VARIANT_CLASSES.includes(cls)) for (const n of variantClips(C).filter((x) => names.includes(x))) for (const v of Object.keys(VARIANTS)) jobs.push([n, v]);
      for (const [n, v] of jobs) {
        const b = bakeClip(cls, n, { skin, variant: v, engine: this, step, gun: a.guns?.[cls] });
        const key = v ? `${n}@${v}` : n, fileKey = v ? `${n}_${v}` : n;
        set.anims[key] = { back: `${dir}/${fileKey}_back.png`, front: `${dir}/${fileKey}_front.png`, ...b.anim };
        writePNG(root, set.anims[key].back, b.back);
        writePNG(root, set.anims[key].front, b.front);
        locks[key] = b.locks;
        frames += b.anim.frames;
        worst = Math.max(worst, b.metrics.worst_hand_miss_px);
        clampedTotal += b.metrics.reach_clamped_frames;
      }
      man.sprites[setName] = set;
      fs.mkdirSync(path.join(root, dir), { recursive: true });
      fs.writeFileSync(path.join(root, dir, 'locks.json'), JSON.stringify({ class: cls, gun: a.guns?.[cls] ?? (GUN_CLASSES.includes(cls) ? cls : null), step, anims: locks }));
      report[setName] = Object.keys(set.anims).length;
    }
    const file = writeManifest(root, 'fp', man);
    return { root, manifest: file, sets: report, frames, worst_hand_miss_px: worst, reach_clamped_frames: clampedTotal, ms: Math.round(performance.now() - t0), next: 'art_fp composite {class, clip, frame, gun, attachments} shows a frame exactly as the game draws it; art_fp check validates every gun of each class' };
  },

  /** One frame exactly as the game draws it (from the exported files). */
  fp_composite(a) {
    const root = assetRoot(this, a);
    const r = compositeFromFiles(root, a);
    const k = Math.max(1, Math.min(4, Number(a.zoom ?? 2)));
    const img = k > 1 ? zoomImg(r, k) : r;
    if (a.canvas) {
      const d = new Doc({ name: a.canvas, width: r.width, height: r.height });
      d.layers[0].data.set(r.data);
      d.meta = { fp_composite: { class: a.class, clip: a.clip, frame: a.frame ?? 0 } };
      if (this.docs.has(a.canvas)) this.docs.delete(a.canvas);
      this.attach(d);
    }
    return { image: encodePNG(img.width, img.height, img.data), size: `${r.width}x${r.height}`, sight: r.sight && r.sight.map(r1), muzzle: r.muzzle && r.muzzle.map(r1), draw_order: r.layers.map((l) => l.name), ...(a.canvas ? { canvas: a.canvas } : {}) };
  },

  /** Validation over the exported assets. */
  fp_check(a) {
    return checkAssets(assetRoot(this, a), { classes: a.classes ? [].concat(a.classes) : null, engine: this, limit: a.limit ?? 30 });
  },

  /** Paint-over: sweep sheets out to canvases (export) and back into the files (import), anchors kept. */
  fp_paint(a, source) {
    const root = assetRoot(this, a);
    const group = a.group || (a.sweep?.startsWith('att:') || a.sweep?.startsWith('item:') ? 'fp_attach' : MAGS.includes(a.sweep) ? 'fp_mags' : 'fp_guns');
    const man = readManifest(root, group);
    const sw = man.sweeps?.[a.sweep];
    if (!sw) throw new Error(`no sweep "${a.sweep}" in ${group} (${Object.keys(man.sweeps || {}).join(', ')})`);
    const base = `fpp_${a.sweep.replace(/[^\w.-]/g, '_')}`;
    if ((a.action || 'export') === 'export') {
      const canvases = sw.sheets.map((rel, i) => {
        const p = decodePNG(fs.readFileSync(path.join(root, rel)));
        const name = `${base}_${i}`;
        if (this.docs.has(name)) this.docs.delete(name);
        const d = new Doc({ name, width: p.width, height: p.height });
        d.layers[0].data.set(p.data);
        d.meta = { fp_paint: { root, group, sweep: a.sweep, sheet: i, cell: sw.cell, note: 'paint inside the cells; anchors stay where they are (art_fp paint {action:"import"})' } };
        this.attach(d);
        this.changed?.(d, { op: 'fp_paint', source, label: `fp paint ${a.sweep} sheet ${i}`, structural: true });
        return name;
      });
      return { canvases, cell: sw.cell, cells: steps(sw.yaw) * steps(sw.pitch), next: 'paint the canvases (art_draw), then art_fp paint {action:"import", sweep}' };
    }
    const written = sw.sheets.map((rel, i) => {
      const d = this.get(`${base}_${i}`);
      const p = decodePNG(fs.readFileSync(path.join(root, rel)));
      if (d.width !== p.width || d.height !== p.height) throw new Error(`canvas ${d.name} is ${d.width}x${d.height}, sheet ${rel} is ${p.width}x${p.height}`);
      const data = d.composite();
      fs.writeFileSync(path.join(root, rel), encodePNG(d.width, d.height, data));
      return rel;
    });
    return { imported: written, anchors: 'unchanged', sweep: a.sweep };
  },
};

function zoomImg(r, k) {
  const W = r.width * k, H = r.height * k, d = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const s = (Math.floor(y / k) * r.width + Math.floor(x / k)) * 4; d.set(r.data.subarray(s, s + 4), (y * W + x) * 4); }
  return { width: W, height: H, data: d };
}

// ---------- reading exported assets back (what the game loads) ----------
const SHEETS = new Map();
function loadSweep(root, def) {
  const key = `${root}|${def.sheets.join(',')}|${def.sheets.map((s) => { try { return fs.statSync(path.join(root, s)).mtimeMs; } catch { return 0; } }).join(',')}`;
  if (!SHEETS.has(key)) SHEETS.set(key, { def, cells: unpackSheets(def, def.sheets.map((s) => { const p = decodePNG(fs.readFileSync(path.join(root, s))); return { width: p.width, height: p.height, data: p.data }; })) });
  return SHEETS.get(key);
}
/** Everything a composite needs from the files: {anim, layers, gun, mag, attachments, items}. */
export function loadFrameAssets(root, { class: cls, clip, gun: gunName, attachments = {}, mag: magName, skin, variant, states = false }) {
  const fpm = readManifest(root, 'fp'), gm = readManifest(root, 'fp_guns'), mm = readManifest(root, 'fp_mags'), am = readManifest(root, 'fp_attach');
  const set = fpm.sprites?.[skin && skin !== 'mec' ? `fp_${cls}.${skin}` : `fp_${cls}`];
  if (!set) throw new Error(`no arms set fp_${cls} in ${root} (run art_fp batch)`);
  const ub = attachments.underbarrel || '';
  const vk = variant ?? (/angled/.test(ub) ? 'agrip' : /grip/.test(ub) ? 'vgrip' : null);
  const name = vk && set.anims[`${clip}@${vk}`] ? `${clip}@${vk}` : clip;
  const anim = set.anims[name];
  if (!anim) throw new Error(`fp_${cls} has no anim "${clip}" (${Object.keys(set.anims).join(', ')})`);
  const img = (rel) => { if (!rel) return null; const p = decodePNG(fs.readFileSync(path.join(root, rel))); return { width: p.width, height: p.height, data: p.data }; };
  const layers = { back: img(anim.back), mid: img(anim.mid), front: img(anim.front) };
  const gName = gunName ?? (GUN_CLASSES.includes(cls) ? cls : null);
  let gun = null;
  if (gName) {
    const gd = gm.sweeps?.[gName];
    if (!gd) throw new Error(`no gun sweep "${gName}" (run art_fp sweep)`);
    gun = loadSweep(root, gd);
    if (states) gun = { ...gun, states: Object.fromEntries(Object.entries(gm.sweeps).filter(([k]) => k.startsWith(`${gName}@`)).map(([k, d]) => [k.split('@')[1], loadSweep(root, d)])) };
  }
  const atts = {};
  for (const [slot, an] of Object.entries(attachments)) {
    if (!an) continue;
    const d = am.sweeps?.[`att:${an}`];
    if (!d) throw new Error(`no attachment sweep "att:${an}"`);
    atts[slot] = loadSweep(root, d);
  }
  const mName = anim.mag_sweep || magName || gm.sweeps?.[gName]?.mag;
  const mag = mName && mm.sweeps?.[mName] ? loadSweep(root, mm.sweeps[mName]) : null;
  const items = {};
  for (const it of anim.item || []) if (it.id && !items[it.id] && am.sweeps?.[`item:${it.id}`]) items[it.id] = loadSweep(root, am.sweeps[`item:${it.id}`]);
  return { anim, name, layers, gun, mag, attachments: atts, items };
}
export function compositeFromFiles(root, a) {
  const A = loadFrameAssets(root, a);
  const f = Math.max(0, Math.min(A.anim.frames - 1, Number(a.frame ?? 0)));
  return { ...composite({ anim: A.anim, f, layers: A.layers, gun: A.gun, mag: A.mag, attachments: A.attachments, items: A.items, yawOff: Number(a.yaw_offset ?? 0), pitchOff: Number(a.pitch_offset ?? 0), background: a.background === undefined ? [62, 58, 54, 255] : a.background }), anim: A.name };
}

// ---------- fp check ----------
export function checkAssets(root, { classes = null, engine = null, limit = 30 } = {}) {
  const t0 = performance.now();
  const fpm = readManifest(root, 'fp'), gm = readManifest(root, 'fp_guns'), am = readManifest(root, 'fp_attach'), mm = readManifest(root, 'fp_mags');
  const issues = [], counts = { frames: 0, hand_checks: 0, ads_frames: 0, mag_handoffs: 0, attachment_pairs: 0, guns: 0 };
  const worst = { hand_px: 0, ads_px: 0, mag_handoff_px: 0, anchor_jump_px: 0 };
  const bad = (x) => { if (issues.length < limit) issues.push(x); counts.failed = (counts.failed || 0) + 1; };
  const sets = Object.entries(fpm.sprites || {}).filter(([n, s]) => n.startsWith('fp_') && (!classes || classes.includes(s.class)));
  if (!sets.length) bad({ issue: `no fp arms sets in ${root} (run art_fp batch)` });
  for (const [setName, set] of sets) {
    const cls = set.class, dir = path.dirname(Object.values(set.anims)[0].back);
    const lockFile = path.join(root, dir, 'locks.json');
    const locks = fs.existsSync(lockFile) ? JSON.parse(fs.readFileSync(lockFile, 'utf8')) : { anims: {} };
    const std = locks.gun;
    const guns = Object.entries(gm.sweeps || {}).filter(([k, d]) => !k.includes('@') && d.class === cls);
    for (const [anim, A] of Object.entries(set.anims)) {
      // contract shape
      for (const k of ['frames', 'fps', 'back', 'front']) if (A[k] === undefined) bad({ set: setName, anim, issue: `missing "${k}"` });
      for (const [list, name] of [[A.gun, 'gun'], [A.mag, 'mag'], [A.item, 'item']]) {
        if (!list) continue;
        if (list.length !== 1 && list.length !== A.frames && !(name === 'item' && list.length === 0)) bad({ set: setName, anim, issue: `${name} has ${list.length} entries for ${A.frames} frames (one per frame, or one for all)` });
        for (const [i, s] of list.entries()) {
          if (s.order && !['back', 'mid', 'front'].includes(s.order)) bad({ set: setName, anim, frame: i, issue: `${name}.order "${s.order}"` });
          if (name === 'mag' && s.state && !['in', 'hand', 'hidden'].includes(s.state)) bad({ set: setName, anim, frame: i, issue: `mag.state "${s.state}"` });
          if (name === 'mag' && s.state === 'hand' && [s.x, s.y].some((v) => !Number.isFinite(v))) bad({ set: setName, anim, frame: i, issue: 'mag in hand without x/y' });
        }
      }
      for (const e of A.events || []) if (!(e.f >= 0 && e.f < A.frames)) bad({ set: setName, anim, issue: `event ${e.e} at frame ${e.f} outside 0..${A.frames - 1}` });
      counts.frames += A.frames;
      // hands on anchors for every gun of the class
      const L = locks.anims?.[anim] || [];
      const variant = anim.includes('@') ? anim.split('@')[1] : null;
      for (const [gName, gd] of guns) {
        const sd = gm.sweeps[std];
        if (!sd) continue;
        for (let f = 0; f < A.frames; f++) {
          const s = A.gun[Math.min(f, A.gun.length - 1)];
          if (!s || s.hidden) continue;
          const lk = L[f] || {};
          for (const side of ['R', 'L']) {
            const h = lk[side];
            if (!h) continue;
            counts.hand_checks++;
            if (h.miss > 1) { worst.hand_px = Math.max(worst.hand_px, h.miss); bad({ set: setName, anim, frame: f, hand: side, issue: `hand ${h.miss} px off its anchor (reach)` }); continue; }
            if (gName === std) continue;
            // the same anchor drawn by this gun vs the standard gun
            const an = side === 'R' ? 'grip' : variant ? null : 'support';
            if (!an || !gd.anchors[an] || !sd.anchors[an]) continue;
            const ig = cellIndex(gd, s.yaw, s.pitch), is = cellIndex(sd, s.yaw, s.pitch);
            const pg = placeAnchor(gd, ig, an, anchorOf(gd, 'grip', ig), s.x, s.y, s.rot), ps = placeAnchor(sd, is, an, anchorOf(sd, 'grip', is), s.x, s.y, s.rot);
            const err = Math.hypot(pg[0] - ps[0], pg[1] - ps[1]);
            const near = Math.hypot(h.at[0] - ps[0], h.at[1] - ps[1]) < 3; // the hand is on this anchor this frame
            if (!near) continue;
            worst.hand_px = Math.max(worst.hand_px, err);
            if (err > 1.5) bad({ set: setName, anim, frame: f, gun: gName, hand: side, issue: `${an} of "${gName}" is ${r1(err)} px from where the hand holds it` });
          }
        }
      }
      // ADS: the iron sight on the frame centre
      if (/^(ads_idle|fire_ads)/.test(anim) && std && gm.sweeps[std]) {
        const sd = gm.sweeps[std];
        for (let f = 0; f < A.frames; f++) {
          const s = A.gun[Math.min(f, A.gun.length - 1)];
          if (!s || s.hidden) continue;
          const i = cellIndex(sd, s.yaw, s.pitch);
          const p = placeAnchor(sd, i, 'sight', anchorOf(sd, 'grip', i), s.x, s.y, s.rot);
          if (!p) continue;
          counts.ads_frames++;
          const e = Math.hypot(p[0] - CENTRE[0], p[1] - CENTRE[1]);
          if (/^ads_idle/.test(anim)) { worst.ads_px = Math.max(worst.ads_px, e); if (e > 1) bad({ set: setName, anim, frame: f, issue: `ADS sight ${r1(e)} px from the centre` }); }
        }
      }
      // magazine hand-off: the mag in the hand meets the mag well when it goes in
      if (A.mag && std && gm.sweeps[std]) {
        const sd = gm.sweeps[std];
        for (let f = 1; f < A.frames; f++) {
          const m0 = A.mag[f - 1], m1 = A.mag[f];
          if (!(m0?.state === 'hand' && m1?.state === 'in') && !(m0?.state === 'in' && m1?.state === 'hand')) continue;
          const mh = m0.state === 'hand' ? m0 : m1, s = A.gun[Math.min(m0.state === 'hand' ? f - 1 : f, A.gun.length - 1)];
          const i = cellIndex(sd, s.yaw, s.pitch), w = placeAnchor(sd, i, 'mag_well', anchorOf(sd, 'grip', i), s.x, s.y, s.rot);
          if (!w) continue;
          counts.mag_handoffs++;
          const e = Math.hypot(mh.x - w[0], mh.y - w[1]);
          worst.mag_handoff_px = Math.max(worst.mag_handoff_px, e);
          if (e > 2) bad({ set: setName, anim, frame: f, issue: `magazine pops ${r1(e)} px between hand and mag_well` });
        }
      }
    }
  }
  // guns: grip geometry (handling.js conform) and anchor continuity across the sweep
  for (const [name, gd] of Object.entries(gm.sweeps || {})) {
    if (name.includes('@') || (classes && !classes.includes(gd.class))) continue;
    counts.guns++;
    const jumps = anchorJumps(gd);
    for (const [an, j] of Object.entries(jumps)) {
      worst.anchor_jump_px = Math.max(worst.anchor_jump_px, j);
      const lim = Math.max(gd.cell[0], gd.cell[1]) * 0.16 + 2;
      if (j > lim) bad({ gun: name, anchor: an, issue: `anchor jumps ${j} px between neighbouring cells (limit ${r1(lim)})` });
    }
    try {
      const def = fpDef(engine, name, 'gun'), so = def.sockets || {};
      const pt = (k) => (so[k] ? [-so[k].at[2], -so[k].at[1], so[k].at[0]] : undefined); // along (fwd), across (down), lateral
      const kind = def.fp?.class === 'pistol' ? 'pistol' : 'long';
      const c = conform(gd.class, { grip_main: pt('grip'), grip_support: kind === 'pistol' ? undefined : pt('support'), stock: pt('stock') }, { unit: FP_UNIT[kind] });
      if (!c.pass) bad({ gun: name, issue: `grip geometry does not conform to class ${gd.class}: ${c.checks.filter((x) => !x.ok).map((x) => `${x.point} off by [${x.along}, ${x.across}] cm`).join('; ')}` });
    } catch (e) { bad({ gun: name, issue: e.message }); }
  }
  // attachments: each one snaps onto every compatible gun (the gun has the slot anchor in every cell)
  for (const [key, ad] of Object.entries(am.sweeps || {})) {
    if (!key.startsWith('att:') || key.includes('@')) continue;
    const slot = ad.slot, anchor = SLOT_ANCHOR[slot];
    if (!ad.anchors?.mount) { bad({ attachment: key, issue: 'no mount anchor' }); continue; }
    for (const [gName, gd] of Object.entries(gm.sweeps || {})) {
      if (gName.includes('@') || !(ad.classes || []).includes(gd.class)) continue;
      counts.attachment_pairs++;
      if (!gd.anchors?.[anchor]) bad({ attachment: key, gun: gName, issue: `gun has no ${anchor} anchor for a ${slot} attachment` });
      else if (gd.anchors[anchor].length !== steps(gd.yaw) * steps(gd.pitch)) bad({ attachment: key, gun: gName, issue: `${anchor} not listed for every cell` });
    }
  }
  void mm; void RENDER_ORDER;
  const pass = !counts.failed;
  return { pass, root, ...counts, worst: Object.fromEntries(Object.entries(worst).map(([k, v]) => [k, r1(v)])), summary: pass ? `PASS: ${counts.frames} frames, ${counts.hand_checks} hand locks, ${counts.guns} guns, ${counts.attachment_pairs} attachment fits` : `FAIL: ${counts.failed} issues (first: ${JSON.stringify(issues[0])})`, ...(issues.length ? { issues } : {}), ms: Math.round(performance.now() - t0) };
}

/** Contact sheet of RGBA frames (for demos / replies). */
export function contactSheet(items, { columns = 3, labels = true, zoom = 1 } = {}) {
  const its = items.map((it) => ({ img: zoom > 1 ? zoomImg(it.img, zoom) : it.img, label: it.label }));
  return packImages(its, { labels, checker: false, columns });
}
