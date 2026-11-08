// art_fp actions for hand-drawn sources (fp2d.js, fp2darms.js): template (blank key / arm part
// canvases with guides), anchors (place, move, suggest from the silhouette, check), sweep2d (key
// drawings -> the same sweep files and manifests art_fp sweep writes) and trace (a 3D arms skin
// exported as editable 2D skin canvases). Batch, composite, check and paint are unchanged: batch
// resolves a gun / magazine / attachment / item / skin name to its drawings when they exist.
import { Doc, Layer } from './doc.js';
import { GUN_CLASSES, MAGS, ATTACH } from './fpkit.js';
import { classGrid, magGrid2, attachGrid2, itemGrid, sweep2dOf, assetRoot, readManifest, writeManifest, exportSweep, GRID_STEP, checkFpName, numArg } from './fpops.js';
import { sources2d, keyOf, gunTemplate, suggestAnchors, anchorsOffArt, artOf, fitSockets, colorSet, KINDS, GUIDES, VIEWS, STATION_VIEWS, stationView } from './fp2d.js';
import { armTemplate, traceSkin, skin2dOf, HAND_POSES, LIMB_VIEWS, HAND_VIEWS, ARM_PX_PER_CM } from './fp2darms.js';
import { PX_PER_M, r1 } from './fp.js';
import { REF } from './fpsweep.js';

const ARM_POINTS = ['joint', 'end', 'wrist', 'grip'];
/** Paintable contact layers a key template gets per kind (fp2d.js MASK_LAYERS; opaque = in the zone; height: grey = cm toward the eye). */
const KIND_MASKS = { gun: ['mask_grip', 'mask_guard', 'mask_fore', 'height'], mag: ['mask_pinch', 'height'], attachment: ['mask_fore', 'height'], item: ['mask_grip', 'height'] };
const r2 = (v) => Math.round(v * 100) / 100;

/** New canvas with an "art" layer (plus "back" / "front" for hands) under a "guides" layer. */
function newCanvas(engine, name, width, height, layers, guides, meta, a, source, hidden = []) {
  checkFpName(name, 'canvas');
  if (engine.docs.has(name) && !a.overwrite) throw new Error(`Canvas "${name}" exists (pass overwrite: true)`);
  if (engine.docs.has(name)) engine.docs.delete(name);
  const d = new Doc({ name, width, height });
  d.layers[0].name = layers[0];
  for (const l of layers.slice(1)) d.layers.push(new Layer(l, width, height));
  // contact masks / height: paintable, hidden (never part of the art)
  for (const l of hidden) { const L = new Layer(l, width, height); L.visible = false; d.layers.push(L); }
  if (a.project) { engine.getProject(a.project); d.project = a.project; }
  d.meta = meta;
  engine.attach(d);
  if (guides?.length) {
    d.layers.push(new Layer(GUIDES, width, height));
    d.execute(guides, { layer: GUIDES, label: 'fp2d guides' });
  }
  d.active = 0;
  engine.changed(d, { op: 'fp_template', source, label: `fp2d template ${name}`, structural: true });
  return d;
}

/** Fit of a 2D source's other drawings (for suggestions and consistency). */
function sourceFit(engine, m, except) {
  const s = sources2d(engine).get(m.source);
  if (!s) return null;
  const keys = [];
  for (const d of s.docs) { if (d.name === except) continue; try { keys.push(keyOf(d, s.kind, s.class)); } catch { /* a key without its reference anchor yet */ } }
  if (!keys.length) return null;
  return { ...fitSockets(keys, s.kind, s.class), keys: keys.length };
}

/** Warnings of one source at sweep time: consistency between keys, anchors off the art, coverage. */
function check2dOf(src, sw, keysByName) {
  const warnings = [];
  for (const [k, per] of Object.entries(sw.fit.per_key)) for (const [n, px] of Object.entries(per)) if (px > 2 && Object.keys(sw.fit.per_key).length > 1) warnings.push({ key: k, anchor: n, issue: `${n} in "${k}" is ${px} px from where the other drawings put it (anchor inconsistent between keys)` });
  for (const [name, key] of keysByName) for (const w of anchorsOffArt(key.img, key.anchors)) warnings.push({ key: name, ...w });
  if (sw.stats.worst_key_distance_deg > 45) warnings.push({ issue: `some cells are ${sw.stats.worst_key_distance_deg}° from their nearest drawing (a far cell is a plain card): add a key drawing nearer, or paint over those cells` });
  const pal = sw.palette, cols = colorSet(...sw.cells);
  let foreign = 0;
  for (const c of cols) if (!pal.has(c)) foreign++;
  return { warnings, palette_ok: foreign === 0, foreign_colors: foreign, colors: cols.size, key_colors: pal.size, residual_px: sw.fit.residual_px };
}

export const FP2D_OPS = {
  /** Blank, drawable canvas for a key drawing or an arm part, with guides and meta filled in. */
  fp_template(a, source) {
    const kind = a.kind || 'gun';
    if (kind === 'arm') {
      const part = a.part || 'hand';
      if (!['upper', 'fore', 'hand'].includes(part)) throw new Error(`part "${part}" (upper | fore | hand)`);
      if (!a.name) throw new Error('arm templates need "name" (the 2D skin they belong to)');
      checkFpName(a.name, 'skin name');
      if (part === 'hand' && a.pose && !HAND_POSES.includes(a.pose)) throw new Error(`pose "${a.pose}" (${HAND_POSES.join(', ')})`);
      const t = armTemplate(part, { px_per_cm: a.px_per_cm });
      const view = a.view || (part === 'hand' ? 'back' : 'side');
      if (part === 'hand' ? !HAND_VIEWS.includes(view) : !LIMB_VIEWS[view]) throw new Error(`view "${view}" (${part === 'hand' ? HAND_VIEWS.join(' | ') : Object.keys(LIMB_VIEWS).join(' | ')})`);
      const pose = part === 'hand' ? a.pose || 'trigger' : undefined;
      const canvas = a.canvas || `${a.name}_${part}${pose ? `_${pose}` : ''}_${view}`;
      const meta = { fp2d: { kind: 'arm', skin: a.name, part, view, ...(pose ? { pose } : {}), ...(a.side ? { side: a.side } : {}), ...t.points, px_per_cm: t.px_per_cm, ...(part === 'hand' ? { thumb: 'up' } : { up: '-x' }) } };
      newCanvas(this, canvas, t.width, t.height, part === 'hand' ? ['back', 'front', 'trigger'] : ['art'], t.guides, meta, a, source);
      return { canvas, size: `${t.width}x${t.height}`, points: t.points, px_per_cm: t.px_per_cm, note: t.note, next: 'draw on the art layers (art_draw; the guides layer is never used), then art_fp batch {skins:[name]}' };
    }
    if (!KINDS.includes(kind)) throw new Error(`kind "${kind}" (${[...KINDS, 'arm'].join(' | ')})`);
    if (!a.name) throw new Error('templates need "name" (the source: the gun / magazine / attachment / item the drawings make)');
    checkFpName(a.name, 'source name');
    if (a.state !== undefined) checkFpName(a.state, 'state');
    if (kind === 'gun' && !GUN_CLASSES.includes(a.class)) throw new Error(`a gun needs class (${GUN_CLASSES.join(' | ')})`);
    const view = a.view ?? (a.yaw === undefined && a.pitch === undefined ? (kind === 'gun' ? 'hip' : 'side') : undefined);
    const m = { source: a.name, kind, ...(a.class ? { class: a.class } : {}), ...(view ? { view } : { yaw: a.yaw ?? 0, pitch: a.pitch ?? 0, ...(a.roll ? { roll: a.roll } : {}) }), ...(a.slot ? { slot: a.slot } : {}), ...(a.mag ? { mag: a.mag } : {}), ...(a.state ? { state: a.state } : {}) };
    if (kind === 'attachment' && !m.slot) m.slot = ATTACH[a.name]?.slot || 'optic';
    const t = gunTemplate(kind, a.class, m);
    const canvas = a.canvas || `${a.name}_${view || `y${a.yaw ?? 0}_p${a.pitch ?? 0}`}${a.state ? `_${a.state}` : ''}`;
    newCanvas(this, canvas, t.width, t.height, ['art'], t.guides, { fp2d: { ...m, anchors: t.anchors } }, a, source, KIND_MASKS[kind]);
    const ang = STATION_VIEWS.includes(view) ? stationView(a.class, view) : null;
    return { canvas, size: `${t.width}x${t.height}`, view: view || { yaw: a.yaw ?? 0, pitch: a.pitch ?? 0 }, ...(ang ? { yaw_pitch: ang } : {}), anchors: t.anchors, note: `the guides mark the class standard anchors in this view (draw so grip, support and mag_well land on them and the class hands fit); ${kind === 'gun' ? 'muzzle left, no magazine (it is its own sweep), no stock' : 'reference ' + REF[kind] + ' on its mark'}`, next: 'draw on the art layer (art_draw), then art_fp anchors {canvas, suggest:true} to check / move anchors, art_fp sweep2d {out}' };
  },

  /** Place / move / remove anchors on a drawing, suggest them from the silhouette, check them. */
  fp_anchors(a, source) {
    const d = this.get(a.canvas);
    const m = d.meta?.fp2d;
    if (!m) throw new Error(`canvas "${d.name}" is not an fp2d drawing (art_fp template makes one, or art_canvas meta {fp2d:{source, kind, class, view, anchors}})`);
    const arm = m.kind === 'arm';
    const pt = (v, n) => { if (!Array.isArray(v) || v.length !== 2 || !v.every(Number.isFinite)) throw new Error(`anchor ${n}: [x, y] in canvas px`); return [r2(v[0]), r2(v[1])]; };
    let changed = false;
    const next = { ...m, anchors: { ...(m.anchors || {}) } };
    for (const [n, v] of Object.entries(a.set || {})) {
      if (arm) { if (!ARM_POINTS.includes(n)) throw new Error(`arm points: ${ARM_POINTS.join(', ')}`); next[n] = pt(v, n); } else next.anchors[n] = pt(v, n);
      changed = true;
    }
    for (const n of [].concat(a.remove || [])) { if (arm) delete next[n]; else delete next.anchors[n]; changed = true; }
    const img = artOf(d);
    let suggestions;
    if (!arm && (a.suggest || a.accept !== undefined)) {
      suggestions = suggestAnchors(img, next, sourceFit(this, next, d.name));
      const min = a.accept === undefined ? null : numArg(a, 'accept', 0);
      if (min !== null) for (const [n, s] of Object.entries(suggestions)) if (s.confidence >= min && (a.overwrite || !next.anchors[n])) { next.anchors[n] = s.at; changed = true; }
    }
    if (changed) {
      if (arm) for (const k of Object.keys(next)) if (k === 'anchors') delete next.anchors;
      d.meta = { ...d.meta, fp2d: arm ? Object.fromEntries(Object.entries(next).filter(([k]) => k !== 'anchors')) : next };
      this.changed(d, { op: 'fp_anchors', source, label: `fp2d anchors ${d.name}`, structural: true });
    }
    const cur = d.meta.fp2d;
    const warnings = arm ? anchorsOffArt(img, Object.fromEntries(ARM_POINTS.filter((k) => cur[k] && k !== 'joint' && k !== 'end').map((k) => [k, cur[k]]))) : anchorsOffArt(img, cur.anchors);
    // consistency with the other drawings of the source
    if (!arm && cur.anchors?.[REF[cur.kind]]) {
      const fit = sourceFit(this, cur, null);
      if (fit && fit.keys > 1) for (const [n, px] of Object.entries(fit.per_key[d.name] || {})) if (px > 2) warnings.push({ anchor: n, issue: `${n} is ${px} px from where the other drawings of "${cur.source}" put it` });
    }
    return { canvas: d.name, ...(arm ? { points: Object.fromEntries(ARM_POINTS.filter((k) => cur[k]).map((k) => [k, cur[k]])) } : { anchors: cur.anchors }), ...(suggestions ? { suggestions } : {}), ...(warnings.length ? { warnings } : {}), ok: !warnings.length };
  },

  /** Key drawings -> sweeps (fp_guns / fp_mags / fp_attach), exactly the files art_fp sweep writes. */
  fp_sweep2d(a) {
    const root = assetRoot(this, a), step = numArg(a, 'step', GRID_STEP, { positive: true }), t0 = performance.now();
    const all = sources2d(this);
    const names = a.sources ? [].concat(a.sources) : [...all.keys()];
    if (!names.length) throw new Error('no 2D sources: art_fp template {kind, name, class, view} makes a key canvas (meta.fp2d.source)');
    const mg = readManifest(root, 'fp_guns'), mm = readManifest(root, 'fp_mags'), ma = readManifest(root, 'fp_attach');
    mg.sweeps = mg.sweeps || {}; mm.sweeps = mm.sweeps || {}; ma.sweeps = ma.sweeps || {};
    const out = {};
    for (const name of names) {
      const src = all.get(name);
      if (!src) throw new Error(`no 2D source "${name}" (${[...all.keys()].join(', ')})`);
      checkFpName(name, '2D source (meta.fp2d.source)');
      const jobs = [];
      if (src.kind === 'gun') {
        if (!GUN_CLASSES.includes(src.class)) throw new Error(`2D gun "${name}" needs a class (meta.fp2d.class: ${GUN_CLASSES.join(' | ')})`);
        const g = classGrid(src.class, step);
        jobs.push({ key: name, man: mg, dir: `fp/guns/${name}`, grid: g });
        const states = [...new Set(src.docs.map((d) => d.meta.fp2d.state).filter(Boolean))];
        for (const st of states) checkFpName(st, `2D gun "${name}" state (meta.fp2d.state)`);
        for (const st of states) jobs.push({ key: `${name}@${st}`, man: mg, dir: `fp/guns/${name}/${st}`, grid: g.states[st] || g, state: st });
      } else if (src.kind === 'mag') jobs.push({ key: name, man: mm, dir: `fp/mags/${name}`, grid: magGrid2(this, name, src.class, step) });
      else if (src.kind === 'attachment') { const g = attachGrid2(this, name, step); jobs.push({ key: `att:${name}`, man: ma, dir: `fp/attach/${name}`, grid: g, extra: { classes: g.classes, host: g.host_class, slot: src.slot || ATTACH[name]?.slot } }); }
      else jobs.push({ key: `item:${name}`, man: ma, dir: `fp/items/${name}`, grid: itemGrid(name, step) });
      for (const j of jobs) {
        const sw = sweep2dOf(src, { yaw: j.grid.yaw, pitch: j.grid.pitch }, j.state ? { state: j.state } : {});
        const keys = new Map(src.docs.filter((d) => (d.meta.fp2d.state ?? null) === (j.state ?? null)).map((d) => [d.name, keyOf(d, src.kind, src.class)]));
        const check2d = check2dOf(src, sw, keys);
        j.man.sweeps[j.key] = exportSweep(root, j.dir, sw, { ...(j.extra || {}), source: '2d', source2d: { name, kind: src.kind, ...(j.state ? { state: j.state } : {}), keys: [...keys.keys()], overrides: sw.overridden.length }, ...(src.kind === 'gun' ? { sockets3d: sw.fit.sockets } : {}), check2d });
        out[j.key] = { kind: src.kind, cell: sw.def.cell, cells: sw.cells.length, sheets: j.man.sweeps[j.key].sheets.length, keys: keys.size, overrides: sw.overridden.length, colors: check2d.colors, key_colors: check2d.key_colors, palette_ok: check2d.palette_ok, worst_key_distance_deg: sw.stats.worst_key_distance_deg, ms: sw.stats.ms, ...(check2d.warnings.length ? { warnings: check2d.warnings.slice(0, 6) } : {}) };
      }
    }
    const files = [writeManifest(root, 'fp_guns', mg), writeManifest(root, 'fp_mags', mm), writeManifest(root, 'fp_attach', ma)];
    return { root, manifests: files, sweeps: out, px_per_m: PX_PER_M, ms: Math.round(performance.now() - t0), next: 'art_fp batch {out, guns:{<class>: "<gun>"}, skins?:["<2D skin>"]} drives the arms with these; art_fp paint {sweep} paints over cells (kept as overrides)' };
  },

  /** A 3D arms skin (#16's procedural parts) exported as an editable 2D skin. */
  fp_trace(a, source) {
    const from = a.skin || 'mec', name = checkFpName(a.name || `${from}2d`, 'skin name');
    const list = traceSkin(from, name, { parts: a.parts, poses: a.poses, views: a.views, px_per_cm: a.px_per_cm });
    const made = [];
    for (const c of list) {
      checkFpName(c.name, 'canvas');
      if (this.docs.has(c.name) && !a.overwrite) throw new Error(`Canvas "${c.name}" exists (pass overwrite: true)`);
      if (this.docs.has(c.name)) this.docs.delete(c.name);
      const d = new Doc({ name: c.name, width: c.width, height: c.height });
      if (c.layers) {
        // hands: behind / in front of the held grip
        d.layers[0].name = 'back';
        d.layers[0].data.set(c.layers.back);
        const f = new Layer('front', c.width, c.height);
        f.data.set(c.layers.front);
        d.layers.push(f);
        const tr = new Layer('trigger', c.width, c.height);
        if (c.layers.trigger) tr.data.set(c.layers.trigger);
        d.layers.push(tr);
      } else {
        d.layers[0].name = 'art';
        d.layers[0].data.set(c.data);
      }
      d.meta = c.meta;
      if (a.project) d.project = a.project;
      this.attach(d);
      this.changed(d, { op: 'fp_trace', source, label: `fp2d trace ${c.name}`, structural: true });
      made.push(c.name);
    }
    const sk = skin2dOf(this, name);
    return { skin: name, canvases: made, parts: { upper: sk.parts.upper.length, fore: sk.parts.fore.length, hands: sk.parts.hand.length }, px_per_cm: a.px_per_cm ?? ARM_PX_PER_CM, next: `paint over the canvases (they are the 2D skin "${name}" as they are), then art_fp batch {skins:["${name}"]}` };
  },
};
export { VIEWS, MAGS, r1 };
