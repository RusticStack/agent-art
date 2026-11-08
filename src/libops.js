// Engine ops for the animation library (art_anim): skeletons, clips, skins, retargeting, rendering a
// clip on a skin, batch rendering skins x loadouts x clips x views straight into game strips + a
// manifest, and glTF skin export. Assets are JSON files under <home>/library/.
import fs from 'node:fs';
import path from 'node:path';
import { normalizeRig, renderPose, stableRotations } from './rig.js';
import { rigTemplate, mergeTemplate } from './rigtemplates.js';
import { getRig, framePoses, feetGround } from './rigops.js';
import { applyProportions, normalizeProportions, defaultMasks, normalizeClip, evalClip, retargetClip, LIB_NAME } from './animlib.js';
import { orderOf } from './depth.js';
import { encodePNG } from './png.js';
import { writeSkinGLB } from './gltfskin.js';
import { compactCells } from './compact.js';

const RIG_OPTS = ['sampling', 'secondary', 'feet', 'scale_children', 'weapon', 'variant_sets', 'depth'];
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
      const loadouts = a.loadouts === 'all' ? Object.keys(skin.loadouts || {}) : a.loadouts ? [].concat(a.loadouts) : [null];
      for (const lo of loadouts) {
        const set = `${sname}${lo ? '_' + lo : ''}`;
        const lopt = loadoutOpts(skin, lo);
        // render everything with a generous pad, then crop every frame to the set's padding
        const auto = a.pad === undefined || a.pad === 'auto';
        const fixed = auto ? null : typeof a.pad === 'number' ? [a.pad, a.pad, a.pad, a.pad] : Array.isArray(a.pad) ? a.pad.map(Number) : [0, 0, 0, 0];
        const G = auto ? [Math.ceil(W / 2), Math.ceil(H / 4), Math.ceil(W / 2), Math.ceil(H / 8)] : fixed;
        const GW = W + G[0] + G[2], GH = H + G[1] + G[3];
        const rendered = [];
        let ub = null;
        const cache = new Map();
        for (const clip of clips) for (const view of views) {
          const { fp } = skinClip(this, skin, clip, view);
          const rots = a.stable === false ? null : stableRotations(rig, fp.poses, view, typeof a.stable === 'object' ? a.stable : {});
          const frames = [], fronts = [], orders = [];
          fp.poses.forEach((P, i) => {
            const base = { ...(lopt.variant ? { variant: lopt.variant } : {}), pad: G, ...(rots ? { rot: rots[i] } : {}) };
            const trace = {};
            const full = renderPose(rig, d, P, view, cache, { ...base, ...(lopt.hide ? { hide: lopt.hide } : {}), trace });
            orders.push(orderOf(trace));
            const front = a.front ? frontParts(rig, trace, a.front) : [];
            if (front.length) {
              frames.push(renderPose(rig, d, P, view, cache, { ...base, hide: [...(lopt.hide || []), ...front] }));
              fronts.push(renderPose(rig, d, P, view, cache, { ...base, only: front.filter((n) => !(lopt.hide || []).includes(n)) }));
            } else { frames.push(full); fronts.push(null); }
            const b = bboxOf(full, GW, GH);
            if (b) ub = ub ? [Math.min(ub[0], b[0]), Math.min(ub[1], b[1]), Math.max(ub[2], b[2]), Math.max(ub[3], b[3])] : b;
          });
          rendered.push({ clip, view, frames, fronts, orders, fp });
        }
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
        const entry = { frame: [FW, FH], anchor: [rig.root[0] + pad[0], ground + pad[1]], pad, skeleton: sk.name, skin: sname, ...(lo ? { loadout: lo } : {}), class: sk.class, anims: {} };
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

