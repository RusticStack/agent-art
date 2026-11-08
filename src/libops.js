// Engine ops for the animation library (art_anim): skeletons, clips, skins, retargeting, rendering a
// clip on a skin, batch rendering skins x loadouts x clips x views straight into game strips + a
// manifest, and glTF skin export. Assets are JSON files under <home>/library/.
import fs from 'node:fs';
import path from 'node:path';
import { normalizeRig, renderPose, stableRotations, solvePose, cellOf, partIn } from './rig.js';
import { packImages } from './sheet.js';
import { handlingOf, DEFAULT_PITCH, SHEET_VIEWS, classGeometry, weaponAssetDef, conformAsset, renderWeaponCells, sheetImage, socketOf, compositeFrame, pitchCol, HANDLING } from './weaponassets.js';
import { decodePNG } from './png.js';
import { rigTemplate, mergeTemplate } from './rigtemplates.js';
import { getRig, framePoses, feetGround, artComposite } from './rigops.js';
import { applyProportions, normalizeProportions, defaultMasks, normalizeClip, evalClip, retargetClip, LIB_NAME } from './animlib.js';
import { orderOf } from './depth.js';
import { encodePNG } from './png.js';
import { writeSkinGLB } from './gltfskin.js';
import { compactCells } from './compact.js';
import { registerAssetType } from './assettypes.js';

const RIG_OPTS = ['sampling', 'secondary', 'feet', 'scale_children', 'weapon', 'variant_sets', 'depth', 'skin', 'constrain', 'limits'];
const libDir = (e, ...p) => path.join(e.home, 'library', ...p);
const checkName = (n, what) => { if (!LIB_NAME.test(n || '')) throw new Error(`${what} needs a "name" of 1-58 letters, digits, _ - .`); return n; };
const readJSON = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const writeJSON = (f, o) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(o, null, 1)); };

function loadSkeleton(e, name) {
  const f = libDir(e, 'skeletons', `${checkName(name, 'skeleton')}.json`);
  if (!fs.existsSync(f)) throw new Error(`no skeleton "${name}" (art_anim skeleton {name, template:"humanoid_hd", frame} first; list: ${listNames(e, 'skeletons').join(', ') || 'none'})`);
  return readJSON(f);
}
function loadSkin(e, name) {
  const f = libDir(e, 'skins', `${checkName(name, 'skin')}.json`);
  if (!fs.existsSync(f)) throw new Error(`no skin "${name}" (art_anim skin {name, skeleton} first; list: ${listNames(e, 'skins').join(', ') || 'none'})`);
  return readJSON(f);
}
const clipFile = (e, sk, name) => libDir(e, 'clips', sk, `${name}.json`);
function loadClip(e, sk, name) { const f = clipFile(e, sk, name); return fs.existsSync(f) ? readJSON(f) : null; }
function listNames(e, kind, sub) {
  const d = sub ? libDir(e, kind, sub) : libDir(e, kind);
  return fs.existsSync(d) ? fs.readdirSync(d).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort() : [];
}

/** The skeleton's rig (proportions applied), for validating clips. */
const skeletonRig = (sk, prop) => normalizeRig(applyProportions(sk.def, prop));

/** Standard composed clips for a humanoid skeleton: layers (upper-body aim over walk) and an additive flinch. */
function standardClips(names, masks) {
  const out = [];
  if (!masks.upper || !masks.lower) return out;
  if (names.has('walk') && names.has('aim')) out.push({ name: 'walk_aim', layers: [{ clip: 'walk', events: true }, { clip: 'aim', mask: 'upper' }], frames: 16, fps: 16, loop: true, plant: true, notes: 'walk legs, aim upper body (layer mask)' });
  out.push({ name: 'flinch', keys: [{ parts: {} }, { parts: { chest: { rot: -9 }, neck: { rot: -4 }, head: { rot: -12 } }, t: 0.25, ease: 'linear' }, { parts: {}, t: 1 }], frames: 8, fps: 16, loop: false, additive: true, mask: 'upper', events: [{ t: 0.25, name: 'hit' }], notes: 'additive: layer onto any clip' });
  if (names.has('walk')) out.push({ name: 'walk_hit', layers: [{ clip: 'walk' }, { clip: 'flinch', events: true }], frames: 16, fps: 16, loop: true, plant: true, notes: 'walk + additive flinch on the upper body' });
  return out;
}

/** Clip frames of a skin: the skeleton's clip (retargeted to the skin's proportions) -> framePoses args. */
function skinClip(e, skin, clipName, view) {
  const sk = loadSkeleton(e, skin.skeleton);
  const { d, rig, def } = getRig(e, skin.rig);
  const prop = skin.proportions && Object.keys(skin.proportions).length ? skin.proportions : null;
  const from = sk.def;
  const cache = new Map();
  const getClip = (n) => {
    if (cache.has(n)) return cache.get(n);
    const c = loadClip(e, sk.name, n);
    const r = !c ? null : prop || skin.retarget ? retargetClip(c, from, def, skin.map).clip : c;
    cache.set(n, r);
    return r;
  };
  const clip = getClip(clipName);
  if (!clip) throw new Error(`skeleton "${sk.name}" has no clip "${clipName}" (clips: ${listNames(e, 'clips', sk.name).join(', ') || 'none'})`);
  const ev = evalClip(rig, clip, getClip, sk);
  const a = { animation: `${clipName}_${view}`, view, _poses: ev.poses, frames: ev.poses.length, loop: ev.loop, fps: ev.fps, events: ev.events.length ? ev.events : undefined, ...(clip.plant !== undefined ? { plant: clip.plant } : {}), ...(clip.secondary !== undefined ? { secondary: clip.secondary } : {}), ...(clip.carry !== undefined ? { carry: clip.carry } : {}) };
  const fp = framePoses(e, rig, def, a);
  return { sk, d, rig, def, clip, fp };
}

/** Loadout -> render options: equipment set variant + parts of unequipped items hidden. */
function loadoutOpts(skin, name) {
  if (!name) {
    // no loadout: equipment items are shown only if the skin says so (default: all items shown)
    return {};
  }
  const L = skin.loadouts?.[name];
  if (!L) throw new Error(`skin "${skin.name}" has no loadout "${name}" (loadouts: ${Object.keys(skin.loadouts || {}).join(', ') || 'none'})`);
  const equip = new Set(L.equip || Object.keys(skin.equipment || {}));
  const hide = [], vs = [];
  for (const [item, b] of Object.entries(skin.equipment || {})) {
    if (!equip.has(item)) { if (b.part && !b.variant) hide.push(b.part); continue; }
    if (b.variant) vs.push(b.variant);
  }
  const variant = [...(L.set ? [].concat(L.set) : []), ...vs];
  return { ...(variant.length ? { variant } : {}), ...(hide.length ? { hide } : {}) };
}

/** Bounding box of opaque pixels in an RGBA frame. */
function bboxOf(img, w, h) {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (img[(y * w + x) * 4 + 3]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  return x1 < 0 ? null : [x0, y0, x1, y1];
}
function crop(img, w, h, x, y, cw, ch) {
  const out = new Uint8ClampedArray(cw * ch * 4);
  for (let j = 0; j < ch; j++) { const sy = y + j; if (sy < 0 || sy >= h) continue; for (let i = 0; i < cw; i++) { const sx = x + i; if (sx < 0 || sx >= w) continue; out.set(img.subarray((sy * w + sx) * 4, (sy * w + sx) * 4 + 4), (j * cw + i) * 4); } }
  return out;
}
/** Frames -> one horizontal strip (or a grid when wider than maxW). */
function strip(frames, fw, fh, maxW) {
  const n = frames.length;
  const cols = maxW && n * fw > maxW ? Math.max(1, Math.floor(maxW / fw)) : n, rows = Math.ceil(n / cols);
  const W = cols * fw, H = rows * fh, out = new Uint8ClampedArray(W * H * 4);
  frames.forEach((f, i) => { const cx = (i % cols) * fw, cy = Math.floor(i / cols) * fh; for (let y = 0; y < fh; y++) out.set(f.subarray(y * fw * 4, (y + 1) * fw * 4), ((cy + y) * W + cx) * 4); });
  return { data: out, W, H, cols, rows };
}

/** Run-length per-frame order: [{frame, parts}] only where the order changes. */
function orderRuns(orders) {
  const out = [];
  let prev = null;
  orders.forEach((o, f) => { const k = o.join(','); if (k !== prev) { out.push({ frame: f, parts: o }); prev = k; } });
  return out;
}

export const LIB_OPS = {
  /** Create a skeleton from a template, an existing rig or parts; imports the template presets as the standard clip library. */
  anim_skeleton(a) {
    const name = checkName(a.name, 'skeleton');
    const f = libDir(this, 'skeletons', `${name}.json`);
    if (fs.existsSync(f) && !a.overwrite) throw new Error(`skeleton "${name}" exists (overwrite:true replaces it)`);
    let def, presets = {}, source;
    if (a.template) {
      const t = mergeTemplate(rigTemplate(a.template, a.frame, a.weapon ? { weapon: a.weapon } : undefined), a);
      def = { frame: t.frame, views: t.views, mirror: t.mirror, parts: t.parts, root: t.root, poses: t.poses, template: a.template };
      for (const k of RIG_OPTS) if (t[k] !== undefined && !(k === 'secondary' && !Object.keys(t[k]).length)) def[k] = t[k];
      presets = t.presets; source = `template ${a.template}`;
    } else if (a.from_rig) {
      const { def: rd } = getRig(this, a.from_rig);
      def = structuredClone(rd); presets = def.presets || {}; delete def.presets; source = `rig ${a.from_rig}`;
    } else if (a.parts) {
      def = { frame: a.frame, views: a.views, mirror: a.mirror, parts: a.parts, root: a.root, pairs: a.pairs, poses: a.poses || {} };
      for (const k of RIG_OPTS) if (a[k] !== undefined) def[k] = a[k];
      presets = a.presets || {}; source = 'parts';
    } else throw new Error('skeleton needs template:"humanoid_hd" (+ frame), from_rig:<rig> or parts:{...}');
    if (a.weapon && !def.weapon) def.weapon = a.weapon;
    // library skeletons decide arm draw order from depth by default (depth:false turns it off)
    if (a.depth !== undefined) def.depth = a.depth; else if (def.depth === undefined && def.parts.chest) def.depth = true;
    if (!def.depth) delete def.depth;
    const rig = normalizeRig(def);
    const proportions = normalizeProportions(a.proportions);
    for (const [n, p] of Object.entries(proportions)) { try { normalizeRig(applyProportions(def, p)); } catch (err) { throw new Error(`proportions.${n}: ${err.message}`); } }
    const masks = { ...defaultMasks(def), ...(a.masks || {}) };
    for (const [m, list] of Object.entries(masks)) { if (!Array.isArray(list)) throw new Error(`masks.${m} must be a list of parts`); for (const p of list) if (!def.parts[p]) throw new Error(`masks.${m}: unknown part "${p}"`); }
    const sk = { name, def, masks, proportions, class: def.weapon ? (def.weapon.class ?? 'rifle') : 'none', source };
    writeJSON(f, sk);
    // the clip library: the template presets, then the standard composed clips
    const saved = [];
    if (a.clips !== false) {
      if (a.overwrite) fs.rmSync(libDir(this, 'clips', name), { recursive: true, force: true });
      const have = new Set();
      const getClip = (n) => loadClip(this, name, n);
      for (const [p, pr] of Object.entries(presets)) { writeJSON(clipFile(this, name, p), normalizeClip({ name: p, ...pr }, rig, sk, getClip)); have.add(p); saved.push(p); }
      for (const c of standardClips(have, masks)) { writeJSON(clipFile(this, name, c.name), normalizeClip(c, rig, sk, getClip)); saved.push(c.name); }
    }
    return { skeleton: name, source, frame: rig.frame, views: rig.views, parts: rig.order.length, class: sk.class, depth: !!def.depth, masks: Object.fromEntries(Object.entries(masks).map(([k, v]) => [k, v.length])), proportions: Object.keys(proportions), clips: saved, next: `art_anim skin {name, skeleton:"${name}", proportions?} creates a rig to draw; art_anim batch renders skins x clips x views` };
  },

  /** Save (or delete) a clip of a skeleton: keys, events, layers with masks, additive. */
  anim_clip(a) {
    const sk = loadSkeleton(this, a.skeleton);
    const name = checkName(a.name, 'clip');
    if (a.delete) { const f = clipFile(this, sk.name, name); if (!fs.existsSync(f)) throw new Error(`no clip "${name}"`); fs.rmSync(f); return { skeleton: sk.name, deleted: name }; }
    const rig = skeletonRig(sk);
    let c = { ...a };
    if (a.from_rig) {
      const { def } = getRig(this, a.from_rig);
      const pr = def.presets?.[a.preset ?? name];
      if (!pr) throw new Error(`rig "${a.from_rig}" has no preset "${a.preset ?? name}"`);
      c = { ...pr, ...Object.fromEntries(Object.entries(a).filter(([k, v]) => v !== undefined && !['from_rig', 'preset', 'skeleton'].includes(k))) };
    }
    const clip = normalizeClip({ ...c, name }, rig, sk, (n) => loadClip(this, sk.name, n));
    writeJSON(clipFile(this, sk.name, name), clip);
    const ev = evalClip(rig, clip, (n) => loadClip(this, sk.name, n), sk);
    return { skeleton: sk.name, clip: name, frames: ev.frames, fps: ev.fps, loop: ev.loop, ...(clip.layers ? { layers: clip.layers.map((l) => `${l.clip}${l.mask ? ' [' + (typeof l.mask === 'string' ? l.mask : 'mask') + ']' : ''}${l.additive ? ' +additive' : ''}`) } : {}), ...(ev.events.length ? { events: ev.events } : {}) };
  },

  /** A skin: a drawn rig bound to a skeleton (created with the skeleton's proportions, or an existing rig), equipment and loadouts. */
  anim_skin(a, source) {
    const name = checkName(a.name, 'skin');
    const sk = loadSkeleton(this, a.skeleton);
    let prop = null, propName = null;
    if (typeof a.proportions === 'string') { prop = sk.proportions[a.proportions]; propName = a.proportions; if (!prop) throw new Error(`skeleton "${sk.name}" has no proportions "${a.proportions}" (${Object.keys(sk.proportions).join(', ') || 'none'})`); }
    else if (a.proportions) prop = normalizeProportions({ custom: a.proportions }).custom;
    const rigName = a.rig ?? name;
    let created = false;
    if (!this.docs.has(`${rigName}_parts`)) {
      const def = applyProportions(sk.def, prop);
      if (a.parts) for (const [k, v] of Object.entries(a.parts)) { if (v === null) delete def.parts[k]; else def.parts[k] = { ...(def.parts[k] || {}), ...v }; }
      if (a.variant_sets) def.variant_sets = a.variant_sets;
      const args = { name: rigName, frame: def.frame, views: def.views, mirror: def.mirror, parts: def.parts, root: def.root, pairs: def.pairs, poses: def.poses || {}, presets: {}, project: a.project, palette: a.palette };
      for (const k of RIG_OPTS) if (def[k] !== undefined) args[k] = def[k];
      this.run('rig_create', args, source);
      created = true;
    }
    const { rig } = getRig(this, rigName);
    const missing = Object.keys(sk.def.parts).filter((p) => !rig.parts[p] && !(a.map && Object.values(a.map).includes(p)));
    const equipment = {};
    for (const [item, b0] of Object.entries(a.equipment || {})) {
      const b = typeof b0 === 'string' ? { part: b0 } : { ...b0 };
      if (b.part && !rig.parts[b.part]) throw new Error(`equipment.${item}: rig "${rigName}" has no part "${b.part}"`);
      if (b.variant && !(rig.variantSets?.[b.variant] || rig.order.some((n) => rig.parts[n].variants.includes(b.variant)))) throw new Error(`equipment.${item}: no variant or set "${b.variant}"`);
      if (!b.part && !b.variant) throw new Error(`equipment.${item} needs part (a part shown when equipped) and/or variant (a part variant / variant set)`);
      equipment[item] = b;
    }
    const loadouts = {};
    for (const [n, L] of Object.entries(a.loadouts || {})) {
      checkName(n, 'loadout');
      for (const i of L.equip || []) if (!equipment[i]) throw new Error(`loadouts.${n}: unknown equipment "${i}" (${Object.keys(equipment).join(', ') || 'none'})`);
      loadouts[n] = { ...(L.set ? { set: L.set } : {}), ...(L.equip ? { equip: L.equip } : {}) };
    }
    const skin = { name, skeleton: sk.name, rig: rigName, proportions: prop || {}, ...(propName ? { proportion: propName } : {}), equipment, loadouts, ...(a.map ? { map: a.map, retarget: true } : {}) };
    for (const n of Object.keys(loadouts)) loadoutOpts(skin, n); // validate sets
    writeJSON(libDir(this, 'skins', `${name}.json`), skin);
    const out = { skin: name, skeleton: sk.name, rig: rigName, created, ...(propName ? { proportions: propName } : prop ? { proportions: prop } : {}), equipment: Object.keys(equipment), loadouts: Object.keys(loadouts), ...(missing.length ? { warning: `rig lacks skeleton parts ${missing.join(', ')} (clips drop them; pass map:{skeleton_part: rig_part})` } : {}) };
    if (created) { const { rig: r2 } = getRig(this, rigName); out.cells = compactCells(Object.fromEntries(r2.views.map((v) => [v, Object.fromEntries(r2.order.filter((n) => !r2.parts[n].art).map((n) => { const c = r2.layout.columns.find((x) => x.part === n && x.variant === 'base'); return [n, [c.x, r2.views.indexOf(v) * r2.layout.rowH, r2.parts[n].w, r2.parts[n].h]]; }))]))); out.next = `draw the cells on canvas "${rigName}_parts" (art_rig consistency checks the views agree), then art_anim render / batch`; }
    return out;
  },

  /** Retarget a clip from one skeleton to another (saved on the target). */
  anim_retarget(a) {
    const from = loadSkeleton(this, a.from), to = loadSkeleton(this, a.to);
    const c = loadClip(this, from.name, a.clip);
    if (!c) throw new Error(`skeleton "${from.name}" has no clip "${a.clip}"`);
    const name = checkName(a.name ?? a.clip, 'clip');
    // layers retarget their clips too (when the target lacks them)
    const done = [];
    const move = (clip, as) => {
      for (const l of clip.layers || []) if (!loadClip(this, to.name, l.clip)) { const lc = loadClip(this, from.name, l.clip); if (lc) move(lc, l.clip); }
      const r = retargetClip(clip, from.def, to.def, a.map);
      const rig = skeletonRig(to);
      const out = normalizeClip({ ...r.clip, name: as }, rig, to, (n) => loadClip(this, to.name, n));
      writeJSON(clipFile(this, to.name, as), out);
      done.push({ clip: as, ...(r.notes.length ? { notes: r.notes } : {}), ...(r.clip.retarget ? { scale: r.clip.retarget.k } : {}) });
    };
    move(c, name);
    return { from: from.name, to: to.name, clips: done };
  },

  /** Render a library clip on a skin into a canvas (like art_rig animate). */
  anim_render(a, source) {
    const skin = loadSkin(this, a.skin);
    const { rig } = getRig(this, skin.rig);
    const view = a.view || rig.views[0];
    const { fp } = skinClip(this, skin, a.clip, view);
    const lo = loadoutOpts(skin, a.loadout);
    return this.run('rig_animate', { name: skin.rig, animation: a.animation ?? `${a.clip}_${view}`, view, canvas: a.canvas ?? `${a.skin}${a.loadout ? '_' + a.loadout : ''}_${a.clip}_${view}`, _poses: fp.poses, frames: fp.poses.length, loop: fp.loop, fps: a.fps ?? fp.a.fps, events: fp.events, depth: false, stable: a.stable ?? true, constraints: a.constraints, ...(lo.variant ? { variant: lo.variant } : {}), ...(lo.hide ? { hide: lo.hide } : {}) }, source);
  },

  /**
   * Batch render: skins x loadouts x clips x views -> characters/<set>/<clip>_<view>.png strips
   * (+ __front split strips) and a manifest (frame, anchor, padding, per-anim frames / fps / loop /
   * events / draw order). pad:"auto" grows the set's frame to fit every frame (recorded in the
   * manifest); stable rotation on by default.
   */
  anim_batch(a) {
    const skins = [].concat(a.skins ?? a.skin ?? []);
    if (!skins.length) throw new Error('batch needs skins:[...]');
    const out = this.resolvePath(a.out ?? 'assets', this.exportDir);
    const manifestFile = path.isAbsolute(a.manifest ?? '') ? a.manifest : path.join(out, a.manifest ?? 'manifest/characters.json');
    const group = a.group ?? 'sprites';
    const maxW = a.max_width ? Number(a.max_width) : null;
    const manifest = fs.existsSync(manifestFile) ? readJSON(manifestFile) : {};
    manifest[group] = manifest[group] || {};
    const report = { out, manifest: manifestFile, sets: {}, files: 0 };
    const warnings = [];
    for (const sname of skins) {
      const skin = loadSkin(this, sname);
      const sk = loadSkeleton(this, skin.skeleton);
      const { d, rig } = getRig(this, skin.rig);
      const [W, H] = rig.frame;
      const allClips = listNames(this, 'clips', sk.name);
      const clips = a.clips === undefined || a.clips === 'all' ? allClips : [].concat(a.clips);
      for (const c of clips) if (!allClips.includes(c)) throw new Error(`batch: skeleton "${sk.name}" has no clip "${c}"`);
      const views = a.views === undefined || a.views === 'drawn' ? rig.views : a.views === 'all' ? [...rig.views, ...Object.keys(rig.mirror)] : [].concat(a.views);
      for (const v of views) if (!rig.views.includes(v) && !rig.mirror[v]) throw new Error(`batch: unknown view "${v}" (views: ${[...rig.views, ...Object.keys(rig.mirror)].join(', ')})`);
      const loadouts = a.loadouts === 'all' ? Object.keys(skin.loadouts || {}) : a.loadouts ? [].concat(a.loadouts) : [null];
      for (const lo of loadouts) {
        const set = `${sname}${lo ? '_' + lo : ''}`;
        const lopt = loadoutOpts(skin, lo);
        // render everything with a generous pad, then crop every frame to the set's padding
        const auto = a.pad === undefined || a.pad === 'auto';
        const fixed = auto ? null : typeof a.pad === 'number' ? [a.pad, a.pad, a.pad, a.pad] : Array.isArray(a.pad) ? a.pad.map(Number) : null;
        if (!auto && !(fixed && fixed.length === 4 && fixed.every((n) => Number.isInteger(n) && n >= 0))) throw new Error('batch: pad must be "auto", a whole number of pixels >= 0, or [left, top, right, bottom]');
        let G = auto ? [Math.ceil(W / 2), Math.ceil(H / 4), Math.ceil(W / 2), Math.ceil(H / 8)] : fixed;
        let GW, GH, rendered, ub;
        const cache = new Map(), clipPoses = new Map();
        // weapon:"runtime": the game draws the gun from its world sheet at per-frame sockets
        const runtime = a.weapon === 'runtime';
        if (runtime && !rig.weapon) throw new Error(`batch weapon:"runtime": skin "${sname}" has no weapon (skeleton weapon:{class})`);
        const RW = rig.weapon;
        const gunParts = runtime ? [RW.part, ...Object.values(RW.attachments).map((x) => x.part), ...(RW.mag ? [RW.mag.part] : [])] : [];
        const handling = runtime ? handlingOf(RW.class) : null;
        const pitch = a.pitch ?? DEFAULT_PITCH;
        // auto: a frame that reaches the edge of the render margin would be cut, so render again with
        // twice the margin on that side (a death fall, a long barrel) until every frame fits
        for (let attempt = 0; ; attempt++) {
          GW = W + G[0] + G[2]; GH = H + G[1] + G[3];
          rendered = []; ub = null;
          for (const clip of clips) for (const view of views) {
            const ck = `${clip}|${view}`;
            if (!clipPoses.has(ck)) {
              const { fp } = skinClip(this, skin, clip, view);
              clipPoses.set(ck, { fp, rots: a.stable === false ? null : stableRotations(rig, fp.poses, view, typeof a.stable === 'object' ? a.stable : {}) });
            }
            const { fp, rots } = clipPoses.get(ck);
            const frames = [], fronts = [], orders = [], sockets = [];
            fp.poses.forEach((P, i) => {
              const base = { ...(lopt.variant ? { variant: lopt.variant } : {}), pad: G, ...(rots ? { rot: rots[i] } : {}) };
              const trace = {};
              const full = renderPose(rig, d, P, view, cache, { ...base, ...(lopt.hide ? { hide: lopt.hide } : {}), trace });
              orders.push(orderOf(trace));
              const b = bboxOf(full, GW, GH);
              if (b) ub = ub ? [Math.min(ub[0], b[0]), Math.min(ub[1], b[1]), Math.max(ub[2], b[2]), Math.max(ub[3], b[3])] : b;
              if (runtime) {
                // gun-free: body without the weapon, __front = what is drawn over the weapon, + the socket
                const front = frontParts(rig, trace, 'auto');
                frames.push(renderPose(rig, d, P, view, cache, { ...base, hide: [...(lopt.hide || []), ...gunParts, ...front] }));
                const only = front.filter((n) => !(lopt.hide || []).includes(n));
                fronts.push(only.length ? renderPose(rig, d, P, view, cache, { ...base, only }) : null);
                sockets.push(socketOf(rig, solvePose(rig, P, view), trace, { pad: G, pitch, view }));
                return;
              }
              const front = a.front ? frontParts(rig, trace, a.front) : [];
              if (front.length) {
                frames.push(renderPose(rig, d, P, view, cache, { ...base, hide: [...(lopt.hide || []), ...front] }));
                fronts.push(renderPose(rig, d, P, view, cache, { ...base, only: front.filter((n) => !(lopt.hide || []).includes(n)) }));
              } else { frames.push(full); fronts.push(null); }
            });
            rendered.push({ clip, view, frames, fronts, orders, fp, sockets });
          }
          if (!auto || !ub || attempt >= 4) break;
          const edge = [ub[0] <= 0, ub[1] <= 0, ub[2] >= GW - 1, ub[3] >= GH - 1];
          if (!edge.some(Boolean)) break;
          // left and right grow together (mirrored views flip the side that overruns)
          G = G.map((g, i) => (edge[i] || edge[i ^ 2] && i % 2 === 0 ? g * 2 : g));
        }
        if (auto && ub && (ub[0] <= 0 || ub[1] <= 0 || ub[2] >= GW - 1 || ub[3] >= GH - 1)) warnings.push(`${set}: some frames still reach the edge of the render margin and may be cut`);
        // the set's padding: symmetric left/right (mirrored views stay on the anchor), even
        let pad = fixed || [0, 0, 0, 0];
        if (auto && ub) {
          const side = Math.max(0, G[0] - ub[0], ub[2] - (G[0] + W - 1));
          const x = side + (side % 2);
          pad = [x, Math.max(0, G[1] - ub[1]), x, Math.max(0, ub[3] - (G[1] + H - 1))];
        }
        const FW = W + pad[0] + pad[2], FH = H + pad[1] + pad[3];
        const cx = G[0] - pad[0], cy = G[1] - pad[1];
        if (!auto && ub && (ub[0] < G[0] - pad[0] || ub[2] > G[0] + W - 1 + pad[2] || ub[1] < G[1] - pad[1] || ub[3] > G[1] + H - 1 + pad[3])) warnings.push(`${set}: some frames are cut at the frame edge (pad:"auto" grows the frame)`);
        const dir = path.join(out, 'characters', set);
        fs.mkdirSync(dir, { recursive: true });
        const ground = feetGround(rig, rig.views[0]) ?? rig.root[1];
        const entry = { frame: [FW, FH], anchor: [rig.root[0] + pad[0], ground + pad[1]], pad, skeleton: sk.name, skin: sname, ...(lo ? { loadout: lo } : {}), class: runtime ? handling : sk.class, ...(runtime ? { weapon: 'runtime', weapon_pitch: pitch } : {}), anims: {} };
        for (const r of rendered) {
          const key = `${r.clip}_${r.view}`;
          const cropF = (f) => crop(f, GW, GH, cx, cy, FW, FH);
          const s = strip(r.frames.map(cropF), FW, FH, maxW);
          const file = `characters/${set}/${key}.png`;
          fs.writeFileSync(path.join(out, file), encodePNG(s.W, s.H, s.data));
          report.files++;
          const anim = { file, frames: r.frames.length, fps: Math.round((r.fp.a.fps ?? 10) * 10) / 10, loop: r.fp.loop };
          if (s.rows > 1) anim.grid = { cols: s.cols, rows: s.rows };
          if (r.fronts.some((f) => f && bboxOf(f, GW, GH))) {
            const fs2 = strip(r.fronts.map((f) => (f ? cropF(f) : new Uint8ClampedArray(FW * FH * 4))), FW, FH, maxW);
            anim.front = `characters/${set}/${key}__front.png`;
            fs.writeFileSync(path.join(out, anim.front), encodePNG(fs2.W, fs2.H, fs2.data));
            report.files++;
          }
          if (runtime) {
            anim.class = handling;
            // sockets were computed in the generous frame: move them into the set's frame
            anim.weapon = r.sockets.map((s) => ({ ...s, x: Math.round((s.x - cx) * 10) / 10, y: Math.round((s.y - cy) * 10) / 10 }));
          }
          if (r.fp.events.length) anim.events = r.fp.events;
          if (a.order !== false) anim.order = orderRuns(r.orders);
          entry.anims[key] = anim;
        }
        manifest[group][set] = entry;
        report.sets[set] = { frame: entry.frame, anchor: entry.anchor, pad, anims: Object.keys(entry.anims).length };
      }
    }
    writeJSON(manifestFile, manifest);
    return { ...report, ...(warnings.length ? { warnings } : {}), ...this.pathNote(a.out, out) };
  },

  /** List library assets (skeletons, skins, clips per skeleton). */
  anim_list(a) {
    const skeletons = listNames(this, 'skeletons');
    if (a.skeleton) return { skeleton: a.skeleton, clips: listNames(this, 'clips', loadSkeleton(this, a.skeleton).name) };
    return { skeletons: Object.fromEntries(skeletons.map((s) => [s, listNames(this, 'clips', s).length + ' clips'])), skins: listNames(this, 'skins') };
  },

  /** Compact info on a skeleton / skin / clip (full:true = the stored JSON). */
  anim_info(a) {
    if (a.skin) { const s = loadSkin(this, a.skin); return a.full ? s : { skin: s.name, skeleton: s.skeleton, rig: s.rig, proportions: s.proportion ?? s.proportions, equipment: s.equipment, loadouts: s.loadouts }; }
    const sk = loadSkeleton(this, a.skeleton);
    if (a.clip) { const c = loadClip(this, sk.name, a.clip); if (!c) throw new Error(`no clip "${a.clip}"`); return a.full ? c : { clip: c.name, skeleton: sk.name, frames: c.frames, fps: c.fps, loop: c.loop !== false, keys: c.keys?.length, layers: c.layers, additive: c.additive, mask: c.mask, events: c.events, notes: c.notes }; }
    if (a.full) return sk;
    return { skeleton: sk.name, source: sk.source, class: sk.class, frame: sk.def.frame, views: sk.def.views, parts: Object.keys(sk.def.parts), poses: Object.keys(sk.def.poses || {}).length, depth: !!sk.def.depth, masks: Object.fromEntries(Object.entries(sk.masks).map(([k, v]) => [k, v.length])), proportions: sk.proportions, clips: listNames(this, 'clips', sk.name) };
  },

  /** glTF skin export: a skin's base view as a skinned cutout mesh (one quad per part) + clips as animations. */
  anim_gltf(a) {
    const skin = loadSkin(this, a.skin);
    const { d, rig } = getRig(this, skin.rig);
    const sk = loadSkeleton(this, skin.skeleton);
    const names = a.clips ? [].concat(a.clips) : listNames(this, 'clips', sk.name).slice(0, a.limit ?? 64);
    const base = rig.views.includes('side') ? 'side' : rig.views[0];
    const clips = names.map((n) => { const { fp } = skinClip(this, skin, n, base); return { name: n, poses: fp.poses, fps: fp.a.fps ?? 10, loop: fp.loop, events: fp.events }; });
    let file = this.resolvePath(a.path || `${a.skin}.glb`, this.exportDir);
    if (!/\.glb$/i.test(file)) file += '.glb';
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const r = writeSkinGLB(rig, d, clips, { view: base, scale: a.scale ?? 32, name: a.skin });
    fs.writeFileSync(file, r.glb);
    return { file, bytes: r.glb.length, joints: r.joints, animations: clips.map((c) => c.name), ...this.pathNote(a.path, file) };
  },
};

// ---------- runtime weapon layers: weapon assets, world sheets, composite, class check ----------
function loadWeapon(e, name) {
  const f = libDir(e, 'weapons', `${checkName(name, 'weapon')}.json`);
  if (!fs.existsSync(f)) throw new Error(`no weapon asset "${name}" (art_anim weapon {name, class} first; list: ${listNames(e, 'weapons').join(', ') || 'none'})`);
  return readJSON(f);
}
const saveWeapon = (e, w) => writeJSON(libDir(e, 'weapons', `${w.name}.json`), w);

/** A weapon asset built from a character rig's weapon (cells, points, attachments copied). */
function weaponFromRig(rig, d, name) {
  const W = rig.weapon;
  const P = rig.parts[W.part], pv = partIn(rig, W.part, W.base).pivot;
  const g = [Math.round(W.points.grip_main.x), Math.round(W.points.grip_main.y)];
  const parts = { weapon: { w: P.w, h: P.h, pivot: g } };
  const atts = {};
  for (const [n, a] of Object.entries(W.attachments)) {
    const c = rig.parts[a.part];
    parts[a.part] = { w: c.w, h: c.h, pivot: a.pivot, parent: 'weapon', at: [a.mount[0] + pv[0] - g[0], a.mount[1] + pv[1] - g[1]], z: 0.1 };
    atts[n] = { type: a.type, part: a.part, socket: a.socket };
  }
  if (W.mag) { const c = rig.parts[W.mag.part]; parts.mag = { w: c.w, h: c.h, pivot: partIn(rig, W.mag.part, W.base).pivot, parent: 'weapon', at: [W.mag.mount[0] + pv[0] - g[0], W.mag.mount[1] + pv[1] - g[1]], z: -0.1 }; }
  const S = 2 * Math.ceil(Math.hypot(P.w, P.h)) + 8;
  const asset = {
    name, class: W.class, handling: handlingOf(W.class), kind: W.kind, frame: rig.frame, cell: [P.w, P.h],
    points: Object.fromEntries(Object.entries(W.points).map(([k, p]) => [k, { at: [Math.round(p.x * 10) / 10, Math.round(p.y * 10) / 10], angle: p.angle }])),
    sockets: W.sockets, attachments: atts,
  };
  const copy = [['weapon', W.part], ...Object.values(W.attachments).map((a) => [a.part, a.part]), ...(W.mag ? [['mag', W.mag.part]] : [])];
  return { rig: { frame: [S, S], views: ['side'], root: [S / 2, S / 2], parts, sampling: 'rotsprite' }, asset, copy };
}

/** Engine-shaped frames of a clip on a skin: body (gun-free), __front, socket per frame (rig frame, no padding). */
function runtimeFrames(e, skin, clip, view, lopt = {}) {
  const { d, rig } = getRig(e, skin.rig);
  if (!rig.weapon) throw new Error(`skin "${skin.name}" has no weapon (skeleton weapon:{class})`);
  const { fp } = skinClip(e, skin, clip, view);
  const W = rig.weapon, cache = new Map();
  const gunParts = [W.part, ...Object.values(W.attachments).map((x) => x.part), ...(W.mag ? [W.mag.part] : [])];
  const v = lopt.variant ? { variant: lopt.variant } : {};
  return {
    rig, d, fp, frames: fp.poses.map((P) => {
      const trace = {};
      const full = renderPose(rig, d, P, view, cache, { ...v, ...(lopt.hide ? { hide: lopt.hide } : {}), trace });
      const front = frontParts(rig, trace, 'auto');
      const body = renderPose(rig, d, P, view, cache, { ...v, hide: [...(lopt.hide || []), ...gunParts, ...front] });
      const only = front.filter((n) => !(lopt.hide || []).includes(n));
      const fr = only.length ? renderPose(rig, d, P, view, cache, { ...v, only }) : null;
      const solved = solvePose(rig, P, view);
      return { full, body, front: fr, solved, sock: socketOf(rig, solved, trace, { view }) };
    }),
  };
}

/** Where a gun's support grip lands in a frame (cell grip on the socket, rotated) vs the baked support hand. */
function supportError(f, cells, vi, pitch) {
  const R = f.solved.weapon, h = R.hands?.support;
  if (!h || h.weight < 0.999 || R.s.pl.cup || f.sock.hidden) return null;
  const c = cells.pts[vi][pitchCol(pitch, f.sock.pitch)];
  if (!c.support) return null;
  // the support hand may slide back along the handguard (reach): the same rail move on this gun
  const sl = R.s.slide || 0;
  const [dx, dy] = rotDeg(f.sock.rot, c.support[0] - sl * c.axis[0] - cells.grip[0], c.support[1] - sl * c.axis[1] - cells.grip[1]);
  return Math.hypot(f.sock.x + dx - h.grip[0], f.sock.y + dy - h.grip[1]);
}
/** A weapon point from anim_weapon points: [x, y] or {at:[x, y], angle?} with finite numbers. */
function weaponPoint(k, p) {
  const at = Array.isArray(p) ? p : p && typeof p === 'object' ? p.at : undefined;
  if (!Array.isArray(at) || at.length !== 2 || !at.every((v) => typeof v === 'number' && Number.isFinite(v))) throw new Error(`points.${k}: needs [x, y] or {at:[x, y], angle?} with two finite numbers (got ${JSON.stringify(p)})`);
  const angle = !Array.isArray(p) && p.angle !== undefined ? p.angle : undefined;
  if (angle !== undefined && !(typeof angle === 'number' && Number.isFinite(angle))) throw new Error(`points.${k}.angle must be a finite number of degrees (got ${JSON.stringify(angle)})`);
  return { at: at.slice(), ...(angle !== undefined ? { angle } : {}) };
}
const rotDeg = (deg, x, y) => { const r = deg * Math.PI / 180, c = Math.cos(r), s = Math.sin(r); return [x * c - y * s, x * s + y * c]; };

Object.assign(LIB_OPS, {
  /** A standalone weapon asset (one side cell + attachments + magazine) of a handling class; from_skin copies a character's gun. */
  anim_weapon(a, source) {
    const name = checkName(a.name, 'weapon');
    const f = libDir(this, 'weapons', `${name}.json`);
    if (fs.existsSync(f) && !a.overwrite && !a.points) throw new Error(`weapon "${name}" exists (overwrite:true replaces it; points:{...} updates its points)`);
    if (a.points !== undefined && (!a.points || typeof a.points !== 'object' || Array.isArray(a.points))) throw new Error('points must be an object {<point>: [x, y] | {at:[x, y], angle?}}');
    const pts = a.points ? Object.entries(a.points).map(([k, p]) => [k, weaponPoint(k, p)]) : [];
    if (fs.existsSync(f) && a.points && !a.overwrite) {
      const w = loadWeapon(this, name);
      for (const [k, p] of pts) { if (!w.points[k] && !['grip_support', 'stock', 'muzzle', 'optic', 'mag', 'charge'].includes(k)) throw new Error(`points.${k}: unknown point`); w.points[k] = { ...(w.points[k] || {}), ...p }; }
      saveWeapon(this, w);
      const { def } = getRig(this, w.rig);
      return { weapon: name, points: w.points, conform: conformAsset(w, normalizeRig(def)) };
    }
    let built, copy = null, srcRig = null;
    if (a.from_skin || a.from_rig) {
      const rn = a.from_rig ?? loadSkin(this, a.from_skin).rig;
      srcRig = getRig(this, rn);
      if (!srcRig.rig.weapon) throw new Error(`rig "${rn}" has no weapon`);
      const r = weaponFromRig(srcRig.rig, srcRig.d, name);
      built = { rig: r.rig, asset: r.asset }; copy = r.copy;
    } else {
      if (!a.class) throw new Error('weapon needs class (a handling class or member: rifle, carbine, dmr, shotgun, smg, lmg, sniper, pistol, launcher) or from_skin');
      // sized for a character frame: frame:[w, h], or the frame of skin:"<name>"
      const frame = a.frame ?? (a.skin ? getRig(this, loadSkin(this, a.skin).rig).rig.frame : null);
      if (!frame) throw new Error('weapon needs frame:[w, h] (the character frame it is drawn for) or skin:"<name>"');
      built = weaponAssetDef(name, a.class, frame, a.attachments || {});
    }
    const rigName = a.rig ?? `weapon_${name}`;
    this.run('rig_create', { name: rigName, ...built.rig, overwrite: !!a.overwrite }, source);
    if (copy) {
      // copy the character's side cells into the asset (all layers of the parts canvas)
      const { rig: dst, d: dd } = getRig(this, rigName), { rig: sr, d: sd } = srcRig;
      const L = dd.layers.find((l) => l.name === 'parts') || dd.layers[0];
      const comp = artComposite(sd);
      for (const [to, from] of copy) {
        const A = cellOf(sr, from, sr.weapon.base), B = cellOf(dst, to, 'side');
        for (let y = 0; y < Math.min(A.h, B.h); y++) for (let x = 0; x < Math.min(A.w, B.w); x++) L.data.set(comp.subarray(((A.y + y) * sd.width + A.x + x) * 4, ((A.y + y) * sd.width + A.x + x) * 4 + 4), ((B.y + y) * dd.width + B.x + x) * 4);
      }
      dd.touch?.();
      this.changed(dd, { op: 'rig', source, label: `weapon ${name}: cells copied from the character rig`, structural: true });
    }
    const w = { ...built.asset, rig: rigName };
    for (const [k, p] of pts) w.points[k] = { ...(w.points[k] || {}), ...p };
    saveWeapon(this, w);
    const { rig } = getRig(this, rigName);
    const cells = Object.fromEntries(rig.order.map((n) => { const c = cellOf(rig, n, 'side'); return [n, [c.x, c.y, c.w, c.h]]; }));
    return { weapon: name, rig: rigName, class: w.class, handling: w.handling, cell: w.cell, cells, points: Object.fromEntries(Object.entries(w.points).map(([k, p]) => [k, p.at])), geometry: classGeometry(w.handling, w.frame), conform: conformAsset(w, rig), next: copy ? `art_anim weapon_sheet {weapon:"${name}", out}` : `draw the gun in "${rigName}_parts" pointing RIGHT (grip_main on the red pivot), attachments and magazine in their cells; then art_anim conform / weapon_sheet` };
  },

  /** conform: a weapon asset's grips against its handling class geometry (fix:true moves the points to it). */
  anim_conform(a) {
    const w = loadWeapon(this, a.weapon);
    const { def } = getRig(this, w.rig);
    const r = conformAsset(w, normalizeRig(def), { fix: !!a.fix });
    if (r.fixed) { w.points = r.fixed.points; saveWeapon(this, w); }
    return { weapon: w.name, ...r, summary: r.pass ? `${w.name} conforms to the ${w.handling} class geometry` : `${w.name} is off the ${w.handling} class geometry: ${r.checks.filter((c) => !c.ok).map((c) => c.issue || `${c.point} ${c.along} along / ${c.across} across (tolerance ${c.tolerance.join('/')})`).join('; ')}` };
  },

  /**
   * Weapon world sheet (contract weapons_world): rows = views, columns = pitch, grip / muzzle per
   * cell, one overlay sheet per attachment (same grid), every sheet <= 1024 px; merged into
   * manifest/weapons_world.json.
   */
  anim_weapon_sheet(a) {
    const w = loadWeapon(this, a.weapon);
    const { d, def } = getRig(this, w.rig);
    const views = a.views ? [].concat(a.views) : SHEET_VIEWS;
    if (!views.length || views.some((v) => !SHEET_VIEWS.includes(v)) || new Set(views).size !== views.length) throw new Error(`views: a non-empty list of distinct sheet views (${SHEET_VIEWS.join(', ')}); got ${JSON.stringify(a.views)}`);
    if (a.pitch !== undefined && (!Array.isArray(a.pitch) || !a.pitch.length || !a.pitch.every((p, i) => typeof p === 'number' && Number.isFinite(p) && (i === 0 || p > a.pitch[i - 1])))) throw new Error(`pitch: a non-empty list of finite degrees in ascending order (e.g. [-30, 0, 30]); got ${JSON.stringify(a.pitch)}`);
    const proj = a.skin ? getRig(this, loadSkin(this, a.skin).rig).rig.weapon : null;
    const atts = a.attach !== undefined ? [].concat(a.attach) : Object.keys(w.attachments);
    for (const n of atts) if (!w.attachments[n]) throw new Error(`attach: weapon "${w.name}" has no attachment "${n}"`);
    const max = Number(a.max_size ?? 1024);
    if (!(Number.isFinite(max) && max > 0)) throw new Error(`max_size must be a finite number of px > 0 (got ${JSON.stringify(a.max_size)})`);
    // pitch steps: given, or the default 15 deg steps, fewer when a long gun would pass max_size
    const tries = a.pitch ? [a.pitch] : [DEFAULT_PITCH, [-40, -20, 0, 20, 40], [-30, 0, 30]];
    let C, base, pitch;
    for (const p of tries) {
      pitch = p;
      C = renderWeaponCells(w, def, d, { views, pitch, W: proj, layers: atts });
      base = sheetImage(C.cells.base, C.frame);
      if (base.W <= max && base.H <= max) break;
    }
    if (base.W > max || base.H > max) throw new Error(`weapon sheet ${base.W}x${base.H} is over ${max} px (frame ${C.frame.join('x')}, ${views.length} views x ${pitch.length} pitch): use fewer pitch steps or views`);
    const out = this.resolvePath(a.out ?? 'assets', this.exportDir);
    fs.mkdirSync(path.join(out, 'weapons_world'), { recursive: true });
    const file = `weapons_world/${w.name}.png`;
    fs.writeFileSync(path.join(out, file), encodePNG(base.W, base.H, base.data));
    const attach = {};
    for (const n of atts) { const s = sheetImage(C.cells[n], C.frame); attach[n] = `weapons_world/${w.name}_att_${n}.png`; fs.writeFileSync(path.join(out, attach[n]), encodePNG(s.W, s.H, s.data)); }
    // the magazine: its own overlay (same grid), drawn by the engine unless the socket says mag:false
    let mag = null;
    if (C.cells.mag) { const s = sheetImage(C.cells.mag, C.frame); mag = `weapons_world/${w.name}_mag.png`; fs.writeFileSync(path.join(out, mag), encodePNG(s.W, s.H, s.data)); }
    const entry = { class: w.handling, views, pitch, file, frame: C.frame, grip: C.pts.flat().map(() => C.grip), muzzle: C.pts.flat().map((c) => c.muzzle), ...(mag ? { mag } : {}), ...(atts.length ? { attach } : {}) };
    const mf = path.isAbsolute(a.manifest ?? '') ? a.manifest : path.join(out, a.manifest ?? 'manifest/weapons_world.json');
    const man = fs.existsSync(mf) ? readJSON(mf) : {};
    man.weapons_world = { ...(man.weapons_world || {}), [w.name]: entry };
    writeJSON(mf, man);
    const note = pitch !== DEFAULT_PITCH && !a.pitch ? `the default pitch steps would pass ${max} px: this sheet uses pitch ${JSON.stringify(pitch)}; export the characters with the same anim_batch pitch so socket rot matches the cells` : undefined;
    return { weapon: w.name, file: path.join(out, file), size: [base.W, base.H], frame: C.frame, pitch, ...(note ? { note } : {}), cells: views.length * pitch.length, ...(mag ? { mag: path.join(out, mag) } : {}), attach: Object.keys(attach), manifest: mf, ...this.pathNote(a.out, out) };
  },

  /**
   * Composite preview, engine-identical: per frame the gun-free body strip, the gun cell (view,
   * nearest pitch) rotated about its grip onto the socket, the __front strip; next to the baked
   * frame. -> image + support-grip error per frame.
   */
  anim_composite(a) {
    const skin = loadSkin(this, a.skin), w = loadWeapon(this, a.weapon);
    const view = a.view || 'side';
    const R = runtimeFrames(this, skin, a.clip, view, loadoutOpts(skin, a.loadout));
    const { d: wd, def: wdef } = getRig(this, w.rig);
    const src = R.rig.mirror[view] || view, pitch = a.pitch ?? DEFAULT_PITCH;
    const C = renderWeaponCells(w, wdef, wd, { views: [src], pitch, W: R.rig.weapon, attach: a.attach !== undefined ? [].concat(a.attach) : Object.keys(w.attachments) });
    const [FW, FH] = R.rig.frame;
    const pick = a.select ? [].concat(a.select) : [...Array(R.frames.length).keys()];
    const items = [], errors = [];
    for (const i of pick) {
      const f = R.frames[i];
      if (!f) continue;
      const col = pitchCol(pitch, f.sock.pitch);
      const comp = compositeFrame(f.body, f.front, { base: C.cells.base[0][col], mag: C.cells.mag?.[0][col] }, C.frame, C.grip, f.sock, [FW, FH]);
      const err = supportError(f, C, 0, pitch);
      errors.push(err === null ? null : Math.round(err * 10) / 10);
      items.push({ img: { width: FW, height: FH, data: f.full }, label: `baked ${i}` }, { img: { width: FW, height: FH, data: comp }, label: `runtime ${i}${err !== null ? ` ${err.toFixed(1)}px` : ''}` });
    }
    const sheet = packImages(items, { columns: Math.min(8, items.length), labels: true });
    const worst = Math.max(0, ...errors.filter((x) => x !== null));
    return { skin: a.skin, weapon: w.name, clip: a.clip, view, frames: pick.length, sockets: pick.map((i) => R.frames[i]?.sock), support_error: errors, worst_support_error: worst, image: encodePNG(sheet.width, sheet.height, sheet.data) };
  },

  /**
   * Hands on the grips of every gun of a class: each weapon asset conforms to the class geometry and,
   * drawn at the skin's sockets, puts its support grip under the baked support hand in every frame.
   */
  anim_weapon_check(a) {
    const skin = loadSkin(this, a.skin);
    const { rig } = getRig(this, skin.rig);
    if (!rig.weapon) throw new Error(`skin "${skin.name}" has no weapon`);
    const handling = a.class ? handlingOf(a.class) : handlingOf(rig.weapon.class);
    const names = a.weapons ? [].concat(a.weapons) : listNames(this, 'weapons').filter((n) => loadWeapon(this, n).handling === handling);
    if (!names.length) throw new Error(`no weapon assets of class ${handling} (art_anim weapon {name, class:"${handling}"})`);
    const sk = loadSkeleton(this, skin.skeleton);
    const clips = a.clips ? [].concat(a.clips) : listNames(this, 'clips', sk.name).filter((c) => !/death|throw/.test(c));
    const views = a.views ? [].concat(a.views) : rig.views;
    const pitch = a.pitch ?? DEFAULT_PITCH;
    const G = classGeometry(handling, rig.frame);
    const tol = (G?.tolerance.support[0] ?? 2) + 1.5;
    const runs = [];
    for (const c of clips) for (const v of views) runs.push({ key: `${c}_${v}`, view: v, R: runtimeFrames(this, skin, c, v, loadoutOpts(skin, a.loadout)) });
    const report = {};
    let pass = true;
    for (const n of names) {
      const w = loadWeapon(this, n);
      const { d: wd, def: wdef } = getRig(this, w.rig);
      const conform = conformAsset(w, normalizeRig(wdef));
      if (Math.abs(w.frame[0] - rig.frame[0]) > 1 || Math.abs(w.frame[1] - rig.frame[1]) > 1) {
        conform.pass = false;
        conform.checks.push({ point: 'frame', ok: false, issue: `drawn for a ${w.frame.join('x')} character, the skin is ${rig.frame.join('x')} (art_anim weapon {skin} sizes it)` });
      }
      const C = renderWeaponCells(w, wdef, wd, { views, pitch, W: rig.weapon, attach: Object.keys(w.attachments) });
      let worst = 0, checked = 0;
      const bad = [];
      for (const { key, view, R } of runs) {
        const vi = C.views.indexOf(R.rig.mirror[view] || view);
        R.frames.forEach((f, i) => {
          const e = supportError(f, C, vi, pitch);
          if (e === null) return;
          checked++;
          worst = Math.max(worst, e);
          if (e > tol && bad.length < 6) bad.push(`${key}[${i}] ${e.toFixed(1)}px`);
        });
      }
      const ok = conform.pass && worst <= tol;
      pass &&= ok;
      report[n] = { pass: ok, conform: conform.pass ? 'ok' : conform.checks.filter((c) => !c.ok).map((c) => c.issue || `${c.point} ${c.along}/${c.across}`), frames_checked: checked, worst_support_error: Math.round(worst * 10) / 10, ...(bad.length ? { off: bad } : {}) };
    }
    return { skin: a.skin, handling, tolerance_px: tol, pass, weapons: report, summary: pass ? `PASS: ${names.length} ${handling} weapons keep the baked hands on their grips (${clips.length} clips x ${views.length} views)` : `FAIL: ${Object.entries(report).filter(([, r]) => !r.pass).map(([k]) => k).join(', ')} off the ${handling} grips` };
  },
});

/** Parts of the __front strip: a list, or "auto" = everything drawn over the weapon (else the near arm). */
function frontParts(rig, trace, spec) {
  if (Array.isArray(spec)) return spec.filter((n) => rig.parts[n]);
  if (spec !== 'auto') throw new Error('front must be "auto" or a list of parts');
  const W = rig.weapon;
  if (W) {
    const own = new Set([W.part, ...Object.values(W.attachments).map((x) => x.part), ...(W.mag ? [W.mag.part] : [])]);
    const i = trace.order.findIndex((e) => e.part === W.part);
    if (i >= 0) return [...new Set(trace.order.slice(i + 1).map((e) => e.part).filter((n) => !own.has(n)))];
  }
  return ['upper_arm_f', 'forearm_f', 'hand_f'].filter((n) => rig.parts[n]);
}


// ---------- asset graph + cleanup (assettypes.js) ----------
// Library assets are JSON files read on demand (no in-memory cache), so unload / reload only
// announce the change. Skins and weapon assets need the rig they draw on; clips need their skeleton.
const mtime = (f) => { try { return Math.round(fs.statSync(f).mtimeMs); } catch { return undefined; } };
const tryJSON = (f) => { try { return readJSON(f); } catch { return null; } };
const libEvent = (kind) => (e, name, source) => e.emit('event', { type: 'anim_library', kind, name, source, ts: Date.now() });
const libType = (kind, dir, edges, extra = {}) => registerAssetType(kind, {
  list: (e) => listNames(e, dir),
  exists: (e, n) => LIB_NAME.test(n) && fs.existsSync(libDir(e, dir, `${n}.json`)),
  info: (e, n) => ({ updated: mtime(libDir(e, dir, `${n}.json`)) }),
  files: (e, n) => (LIB_NAME.test(n) ? [libDir(e, dir, `${n}.json`)] : []),
  edges, unload: libEvent(kind), reload: libEvent(kind), ...extra,
});
// a skeleton contains its clip library (clip part_of skeleton = a hard dependency, not an orphan)
libType('skeleton', 'skeletons', undefined, { container: true });
libType('skin', 'skins', (e, add) => {
  for (const n of listNames(e, 'skins')) {
    const s = tryJSON(libDir(e, 'skins', `${n}.json`));
    if (!s) continue;
    if (s.skeleton) add(`skin:${n}`, 'depends_on', `skeleton:${s.skeleton}`);
    if (s.rig) add(`skin:${n}`, 'depends_on', `rig:${s.rig}`);
  }
});
libType('weapon', 'weapons', (e, add) => {
  for (const n of listNames(e, 'weapons')) { const w = tryJSON(libDir(e, 'weapons', `${n}.json`)); if (w?.rig) add(`weapon:${n}`, 'depends_on', `rig:${w.rig}`); }
});
/** Clips are "clip:<skeleton>/<clip>" (one file each under library/clips/<skeleton>/). */
const clipParts = (n) => { const i = n.indexOf('/'); const sk = n.slice(0, i), c = n.slice(i + 1); return i > 0 && LIB_NAME.test(sk) && LIB_NAME.test(c) ? [sk, c] : null; };
const clipDirs = (e) => { const d = libDir(e, 'clips'); try { return fs.readdirSync(d, { withFileTypes: true }).filter((x) => x.isDirectory() && LIB_NAME.test(x.name)).map((x) => x.name); } catch { return []; } };
registerAssetType('clip', {
  list: (e) => clipDirs(e).flatMap((sk) => listNames(e, 'clips', sk).map((c) => `${sk}/${c}`)),
  exists: (e, n) => { const p = clipParts(n); return !!p && fs.existsSync(clipFile(e, ...p)); },
  info: (e, n) => { const p = clipParts(n); return p ? { updated: mtime(clipFile(e, ...p)) } : {}; },
  files: (e, n) => { const p = clipParts(n); return p ? [clipFile(e, ...p)] : []; },
  edges: (e, add) => {
    for (const sk of clipDirs(e)) for (const c of listNames(e, 'clips', sk)) {
      add(`clip:${sk}/${c}`, 'part_of', `skeleton:${sk}`);
      const clip = tryJSON(clipFile(e, sk, c));
      for (const l of clip?.layers || []) if (l?.clip && l.clip !== c) add(`clip:${sk}/${c}`, 'depends_on', `clip:${sk}/${l.clip}`);
    }
  },
  unload: libEvent('clip'), reload: libEvent('clip'),
});
