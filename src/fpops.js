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
import { sources2d, sourceKey, sweep2d, autoZones, MASKS } from './fp2d.js';
import { skin2dOf, renderArms2d, POSE_FALLBACK, handPose } from './fp2darms.js';

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
/** Grid of a magazine that may be hand-drawn: a kit name keeps magGrid; a new 2D magazine takes its class's grid. */
export function magGrid2(engine, name, cls, step = GRID_STEP) {
  const src = source2d(engine, name, 'mag');
  if (!src || MAGS.includes(name)) return magGrid(name, step);
  const c = src.class || cls || 'rifle', g = classGrid(GUN_CLASSES.includes(c) ? c : 'rifle', step);
  return { yaw: g.yaw, pitch: g.pitch };
}
/** Grid of an attachment that may be hand-drawn (a new name: its slot decides the classes). */
export function attachGrid2(engine, name, step = GRID_STEP) {
  const src = source2d(engine, name, 'attachment');
  if (!src || ATTACH[name]) return attachGrid(name, step);
  const slot = src.slot || 'optic', anchor = SLOT_ANCHOR[slot];
  if (!anchor) throw new Error(`2D attachment "${name}": slot "${slot}" (optic | muzzle | underbarrel)`);
  const cs = GUN_CLASSES.filter((c) => fpGeometry(c)[anchor] && gunModel(c).sockets[anchor]);
  const gs = cs.map((c) => classGrid(c, step));
  return { yaw: union(gs.map((g) => g.yaw)), pitch: union(gs.map((g) => g.pitch)), classes: cs, host_class: cs.includes('rifle') ? 'rifle' : cs[0] };
}
export function attachGrid(name, step = GRID_STEP) {
  const slot = attachModel(name).fp.slot, anchor = SLOT_ANCHOR[slot];
  const cs = GUN_CLASSES.filter((c) => fpGeometry(c)[anchor] && gunModel(c).sockets[anchor]);
  const gs = cs.map((c) => classGrid(c, step));
  // host: the rifle when it fits (else the first compatible class): cells show the attachment as mounted there
  const host = cs.includes('rifle') ? 'rifle' : cs[0];
  return { yaw: union(gs.map((g) => g.yaw)), pitch: union(gs.map((g) => g.pitch)), classes: cs, host: gunModel(host).sockets[anchor].at, host_class: host };
}
export function itemGrid(id, step = GRID_STEP) {
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
// ---------- hand-drawn (2D) sources: canvases with meta.fp2d (see fp2d.js) ----------
/** The 2D source of that name and kind in the workspace, or null (3D model / kit then). */
export function source2d(engine, name, kind) {
  if (!engine?.docs || !name) return null;
  const s = sources2d(engine).get(name);
  return s && (!kind || s.kind === kind) ? s : null;
}
/** Sweep (cached) of a 2D source on a grid. */
export function sweep2dOf(src, grid, extra = {}) {
  return memo(`sweep2d:${sourceKey(src)}:${JSON.stringify(grid)}:${JSON.stringify(extra)}`, () => sweep2d(src, { yaw: grid.yaw, pitch: grid.pitch }, extra));
}
/** A sweep by name: a 2D source when one exists, else the art_model / kit model (sweepOf). */
export function anySweep(engine, name, kind, grid, extra = {}) {
  const src = source2d(engine, name, kind);
  return src ? sweep2dOf(src, grid, extra) : sweepOf(engine, name, kind, grid, extra);
}
/** Gun-space sockets of a 2D source (fitted to its drawings) in a state. */
function sockets2d(src, grid, state) {
  const st = state && src.docs.some((d) => d.meta.fp2d.state === state) ? state : null;
  return sweep2dOf(src, grid, st ? { state: st } : {}).fit.sockets;
}
/** Arms skin by name: a 3D skin (SKINS) or a hand-drawn 2D skin (canvases). */
export function resolveSkin(engine, skin) {
  if (typeof skin !== 'string' || SKINS[skin]) return skin;
  const s = skin2dOf(engine, skin);
  if (!s) throw new Error(`unknown skin "${skin}" (3D: ${Object.keys(SKINS).join(', ')}; or a 2D skin: canvases with meta.fp2d {kind:"arm", skin})`);
  return s;
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
  const src = source2d(engine, gunName, 'gun');
  if (src) {
    // a hand-drawn gun: its sweep from the drawings, its 3D anchors fitted to them (class geometry where unseen)
    const gun = opts.anglesOnly ? { def: { yaw: grid.yaw, pitch: grid.pitch, anchors: new Proxy({}, { get: () => [[0, 0]] }) } } : sweep2dOf(src, grid);
    const ctx = { cls, gun, gunDef: null, source: '2d', mag: src.mag || MAG_OF[cls], gunSockets: (state) => sockets2d(src, grid, state) };
    if (opts.variant && !opts.anglesOnly) variantAtt(engine, ctx, opts.variant, step);
    return ctx;
  }
  const gdef = fpDef(engine, gunName, 'gun');
  const gun = opts.anglesOnly ? { def: { yaw: grid.yaw, pitch: grid.pitch, anchors: new Proxy({}, { get: () => [[0, 0]] }) } } : sweepOf(engine, gunName, 'gun', grid);
  const ctx = { cls, gun, gunDef: gdef, mag: gdef.fp?.mag || MAG_OF[cls], gunSockets: (state) => socketsIn(engine, gdef, state) };
  if (opts.variant && !opts.anglesOnly) {
    const an = VARIANTS[opts.variant].attachment;
    ctx.variant = opts.variant;
    const asrc = source2d(engine, an, 'attachment');
    if (asrc) variantAtt(engine, ctx, opts.variant, step);
    else ctx.att = { sweep: sweepOf(engine, an, 'attachment', attachGrid(an, step)), sockets: socketsIn(engine, attachModel(an), null) };
  }
  return ctx;
}
/** Foregrip of a variant (vgrip / agrip) for a solve context: 2D source of that name, else the kit attachment. */
function variantAtt(engine, ctx, variant, step) {
  const an = VARIANTS[variant].attachment, asrc = source2d(engine, an, 'attachment');
  ctx.variant = variant;
  if (asrc) { const g = attachGrid(an, step); const sw = sweep2dOf(asrc, g); ctx.att = { sweep: sw, sockets: sw.fit.sockets }; }
  else ctx.att = { sweep: sweepOf(engine, an, 'attachment', attachGrid(an, step)), sockets: socketsIn(engine, attachModel(an), null) };
}

// ---------- arms frames ----------
/**
 * Render the arms of one solved frame and split them against the props (gun, magazine, foregrip,
 * item cells as the runtime draws them, with their depth): arm pixels behind a prop surface go to
 * the back layer, the rest to the front layer. -> {back, front} RGBA frames.
 * With a hand-drawn skin or gun (sweeps.contact), held hands also respect the props' contact zones
 * (fp2d.js autoZones / painted masks): finger pixels over a prop outside its zones (grip wrap, guard
 * opening, foregrip, magazine pinch) go behind it, the trigger finger shows only in the guard opening
 * (and on the grip), and the frame reports {contact: {R, L: {front, clipped, out, trigger,
 * trigger_guard}, mag_visible (share of the magazine in hand, on screen or not, the pinching hand leaves uncovered)}}. o: {override: {R|L: {pose, dx, dy}}} (2D skins; the nudge).
 */
export function armsLayers(frame, skin, sweeps, o = {}) {
  const [W, H] = FRAME;
  const bones = [...frame.hands.R.bones, ...frame.hands.L.bones];
  // a hand-drawn skin draws its own sprites; hand drawings can force pixels to the back / front layer
  const two = skin?.kind === '2d';
  const buf = two ? renderArms2d(frame, skin, FRAME, o) : renderBones(bones, skin);
  const contact = !!sweeps.contact;
  const pd = new Float32Array(W * H).fill(Infinity), scratch = new Uint8ClampedArray(W * H * 4);
  const body = contact ? new Uint8Array(W * H) : null, zs = contact ? new Uint8ClampedArray(W * H * 4) : null;
  let magTotal = 0;
  for (const p of frame.props) {
    const sw = p.kind === 'gun' ? sweeps.gun : p.kind === 'mag' || p.kind === 'mag_in' ? sweeps.mag : p.kind === 'att' ? sweeps.att : p.kind === 'item' ? sweeps.items?.[p.id] : null;
    if (!sw) continue;
    // cells without depth maps (hand-drawn / imported sweeps) count as a flat card at the reference depth
    if (!sw.depths) sw.depths = sw.cells.map(() => new Float32Array(sw.def.cell[0] * sw.def.cell[1]));
    const idx = p.kind === 'gun' ? p.idx : cellIndex(sw.def, p.yaw, p.pitch);
    const a = anchorOf(sw.def, p.kind === 'item' ? 'grip' : p.kind === 'gun' ? 'grip' : 'mount', idx);
    if (!a) continue;
    if (!contact) { drawCell(scratch, W, H, sw, idx, a, p.x, p.y, p.rot, 1, { depth: { buf: pd, cells: sw.depths, base: p.depth } }); continue; }
    drawCell(scratch, W, H, sw, idx, a, p.x, p.y, p.rot, 1, { depth: { buf: pd, cells: sw.depths, base: p.depth }, mask: body, maskValue: BODY_OF[p.kind] });
    // the whole magazine in hand (also the part outside the frame): what the hand may hide a share of
    if (p.kind === 'mag') { const c = sw.cells[idx]; magTotal = 0; for (let i = 3; i < c.length; i += 4) if (c[i] >= 128) magTotal++; }
    drawCell(zs, W, H, { def: sw.def, cells: zoneCells(sw, ZONE_KIND[p.kind]) }, idx, a, p.x, p.y, p.rot, 1);
  }
  const back = new Uint8ClampedArray(W * H * 4), front = new Uint8ClampedArray(W * H * 4);
  const force = buf.force, hand = buf.hand, vis = hand ? { R: [0, 0], L: [0, 0] } : null;
  // 3D arms on a hand-drawn gun: hand pixels = arm pixels near a holding palm
  let cls = buf.cls, sideOf = hand;
  if (contact && !two) {
    cls = new Uint8Array(W * H); sideOf = new Uint8Array(W * H);
    const palms = ['R', 'L'].map((sd) => { const h = frame.hands[sd]; if (!h.target2 && !h.held && !(sd === 'L' && frame.mag?.state === 'hand')) return null; const pp = project(h.palm), z = Math.max(4, -h.palm[2]); return { sd, x: pp[0], y: pp[1], r: (11 * F) / z }; }).filter(Boolean);
    for (let i = 0; i < W * H; i++) {
      if (!buf.rgba[i * 4 + 3]) continue;
      const x = i % W, y = (i - x) / W;
      for (const P of palms) if ((x + 0.5 - P.x) ** 2 + (y + 0.5 - P.y) ** 2 <= P.r * P.r) { cls[i] = 3; sideOf[i] = P.sd === 'R' ? 1 : 2; break; }
    }
  }
  const C = contact ? { R: { front: 0, clipped: 0, out: 0, trigger: 0, trigger_guard: 0 }, L: { front: 0, clipped: 0, out: 0, trigger: 0, trigger_guard: 0 } } : null;
  const zoneAt = (i) => (zs[i * 4 + 3] ? zs[i * 4] : 0);
  const held = two ? buf.holding : { R: !!(frame.hands.R.target2 || frame.hands.R.held), L: !!(frame.hands.L.target2 || frame.hands.L.held) || frame.mag?.state === 'hand' };
  const allowed = (c, z) => (c === 4 ? (z & (MASKS.guard | MASKS.grip)) !== 0 : z !== 0);
  for (let i = 0; i < W * H; i++) {
    if (!buf.rgba[i * 4 + 3]) continue;
    const f = force ? force[i] : 0;
    let toBack = f === 1 || (f !== 2 && pd[i] < buf.depth[i] - 0.6);
    const c = cls ? cls[i] : 0;
    if (contact && !toBack && (c === 3 || c === 4) && (!two || f === 2) && body[i] && !allowed(c, zoneAt(i))) {
      toBack = true; // a finger over the prop outside its contact zones: behind the prop
      const sd = sideOf[i] === 1 ? 'R' : sideOf[i] === 2 ? 'L' : null;
      if (sd) C[sd].clipped++;
    }
    (toBack ? back : front).set(buf.rgba.subarray(i * 4, i * 4 + 4), i * 4);
    // hand pixels the player sees: front layer, or back layer where no prop covers them
    if (vis && hand[i]) { const v = vis[hand[i] === 1 ? 'R' : 'L']; v[1]++; if (!toBack || pd[i] === Infinity) v[0]++; }
  }
  let magVisible = null;
  if (contact) {
    // the result as the game draws it: finger pixels of the front layer over a prop must sit in its zones
    let magPx = 0, magHidden = 0;
    for (let i = 0; i < W * H; i++) {
      // the magazine in hand must mostly show past the hand pinching it
      if (body[i] === BODY_OF.mag) { magPx++; if (front[i * 4 + 3] && sideOf?.[i] === 2) magHidden++; }
      if (!front[i * 4 + 3]) continue;
      const c = cls[i], sd = sideOf[i] === 1 ? 'R' : sideOf[i] === 2 ? 'L' : null;
      if (!sd || (c !== 3 && c !== 4)) continue;
      C[sd].front++;
      if (c === 4) { C[sd].trigger++; if (zoneAt(i) & MASKS.guard) C[sd].trigger_guard++; }
      if (body[i] && held[sd] && !allowed(c, zoneAt(i))) C[sd].out++;
    }
    if (magPx && magTotal) magVisible = Math.round((1 - magHidden / magTotal) * 100) / 100;
  }
  const out = { back, front };
  if (vis) Object.assign(out, { vis: { R: vis.R[1] ? vis.R[0] / vis.R[1] : null, L: vis.L[1] ? vis.L[0] / vis.L[1] : null }, poses: buf.poses });
  if (contact) out.contact = { R: C.R, L: C.L, mag_visible: magVisible };
  return out;
}
/** Prop pixel kinds in the contact pass. */
const BODY_OF = { gun: 1, att: 1, mag: 2, mag_in: 3, item: 4 };
const ZONE_KIND = { gun: 'gun', att: 'attachment', mag: 'mag', mag_in: 'mag', item: 'item' };
/** Below this share of the magazine in hand showing, the check fails (the hand hides it). */
export const MAG_VISIBLE_MIN = 0.5;
/** Zone cells of a sweep as RGBA (R = zone bits, alpha over the prop or a zone): painted / swept zones, else autoZones. */
const ZONES = new WeakMap();
function zoneCells(sw, kind) {
  let z = ZONES.get(sw);
  if (z) return z;
  const [cw, ch] = sw.def.cell;
  z = sw.cells.map((img, idx) => {
    const bits = sw.zones?.[idx] || autoZones(img, cw, ch, (n) => sw.def.anchors[n]?.[idx] || null, kind);
    const out = new Uint8ClampedArray(cw * ch * 4);
    for (let i = 0; i < cw * ch; i++) if (img[i * 4 + 3] >= 128 || bits[i]) { out[i * 4] = bits[i]; out[i * 4 + 3] = 255; }
    return out;
  });
  ZONES.set(sw, z);
  return z;
}
/**
 * The arms of a frame with a 2D skin, nudged when a held hand is hidden (< 20 % showing) or hides the
 * magazine in hand (< MAG_VISIBLE_MIN showing after clipping): the other drawings its pose falls back to
 * and half-pixel offsets of the hand (inside the 1 px hand tolerance) are tried, best kept. -> armsLayers
 * result (+ nudge: {R|L: {pose, dx, dy}} when one was applied).
 */
function nudgeHands(fr, sk, sweeps) {
  const base = armsLayers(fr, sk, sweeps);
  const bad = (r, sd) => ((fr.hands[sd].target2 || fr.hands[sd].held) && r.vis?.[sd] != null && r.vis[sd] < 0.2 ? 1 : 0) + (sd === 'L' && r.contact?.mag_visible != null && fr.mag?.state === 'hand' && r.contact.mag_visible < MAG_VISIBLE_MIN ? 1 : 0);
  let best = base, nudge = null;
  for (const sd of ['R', 'L']) {
    if (!bad(best, sd)) continue;
    const cur = best.poses?.[sd] || handPose(fr, sd), drawn = new Set(sk.parts.hand.map((p) => p.pose));
    const poses = [cur, ...(POSE_FALLBACK[cur] || [])].filter((p, i) => i === 0 || drawn.has(p));
    const score = (r) => [bad(r, sd), -(r.contact?.mag_visible ?? 1), -(r.vis?.[sd] ?? 1), r.contact?.[sd]?.clipped ?? 0];
    const better = (a, b) => { for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] < b[i]; return false; };
    let bs = score(best);
    for (const pose of poses) for (const [dx, dy] of [[0, 0], [0.5, 0], [-0.5, 0], [0, 0.5], [0, -0.5]]) {
      if (pose === cur && !dx && !dy) continue;
      const ov = { ...(nudge || {}), [sd]: { pose, dx, dy } };
      const r = armsLayers(fr, sk, sweeps, { override: ov });
      const sc = score(r);
      if (better(sc, bs)) { best = r; bs = sc; nudge = ov; }
    }
  }
  return nudge ? { ...best, nudge } : best;
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
export function bakeClip(cls, clipName, { skin = 'mec', variant = null, engine = null, step = GRID_STEP, gun, contact } = {}) {
  const C = classClips(cls);
  const clip = C[clipName];
  if (!clip) throw new Error(`class "${cls}" has no clip "${clipName}" (clips: ${Object.keys(C).join(', ')})`);
  const ctx = classCtx(cls, step, { engine, variant, gun });
  const sol = solveClip(clip, ctx);
  const magName = clip.mag === 'shell' ? 'shotgun_shell' : ctx.mag;
  const sweeps = { gun: ctx.gun, att: ctx.att?.sweep, items: {} };
  const sk = resolveSkin(engine, skin);
  if (magName) sweeps.mag = anySweep(engine, magName, 'mag', magGrid2(engine, magName, cls, step));
  for (const fr of sol.frames) if (fr.item && !sweeps.items[fr.item.id]) sweeps.items[fr.item.id] = anySweep(engine, fr.item.id, 'item', itemGrid(fr.item.id, step));
  // hands against the props' contact zones: whenever a hand-drawn skin or gun is involved (3D on 3D stays as it was)
  sweeps.contact = contact ?? (sk?.kind === '2d' || ctx.source === '2d');
  const backs = [], fronts = [], locks = [];
  let worstMiss = 0, clamped = 0;
  for (const fr of sol.frames) {
    const lay = sweeps.contact && sk?.kind === '2d' ? nudgeHands(fr, sk, sweeps) : armsLayers(fr, sk, sweeps);
    const { back, front, vis, poses, contact, nudge } = lay;
    backs.push(back); fronts.push(front);
    const L = {};
    for (const side of ['R', 'L']) {
      const h = fr.hands[side];
      if (h.target2) {
        const p = project(h.palm), n = nudge?.[side];
        const px = p[0] + (n?.dx || 0), py = p[1] + (n?.dy || 0), miss = Math.hypot(px - h.target2[0], py - h.target2[1]);
        L[side] = { at: h.target2.map(r1), palm: [r1(px), r1(py)], miss: r1(miss) };
        worstMiss = Math.max(worstMiss, miss);
      }
      // hand-drawn skins: the hand drawing used and how much of it shows (fp check warns on a hidden hand)
      if (vis && L[side]) { L[side].vis = vis[side] == null ? 0 : Math.round(vis[side] * 100) / 100; L[side].pose = poses?.[side]; if (h.clamped) L[side].clamped = true; }
      // contact with the props (2D skin or gun): finger pixels clipped to the zones, any left outside, the trigger finger in the guard
      // (frame level, for every frame the hand holds something, key or in between)
      if (contact && (h.target2 || h.held || (side === 'L' && fr.mag?.state === 'hand'))) { const c = contact[side]; (L.contact = L.contact || {})[side] = { clipped: c.clipped, out: c.out, ...(c.trigger ? { trigger: c.trigger, trigger_guard: c.trigger_guard } : {}), ...(nudge?.[side] ? { nudge: nudge[side] } : {}) }; }
      if (h.clamped) clamped++;
    }
    if (contact && contact.mag_visible != null && fr.mag?.state === 'hand') L.mag_visible = contact.mag_visible;
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
/** Names that become path segments under the asset root (gun / magazine / skin / state): 1-64 letters, digits, _ - ., never "." or "..". */
const FP_NAME = /^[A-Za-z0-9_\-.]{1,64}$/;
export function checkFpName(n, what) {
  if (typeof n !== 'string' || !FP_NAME.test(n) || /^\.+$/.test(n)) throw new Error(`${what} ${JSON.stringify(n)} must be 1-64 letters, digits, _ - . (it names files under the asset root)`);
  return n;
}
/** root + rel, refusing anything that resolves outside root (defence in depth for every file the fp ops write). */
export function insideRoot(root, rel) {
  const base = path.resolve(root), f = path.resolve(base, rel), r = path.relative(base, f);
  if (!r || r === '..' || r.startsWith(`..${path.sep}`) || path.isAbsolute(r)) throw new Error(`refusing to write "${rel}": it resolves outside the asset root ${base}`);
  return f;
}
export const writePNG = (root, rel, img) => { const f = insideRoot(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, encodePNG(img.width, img.height, img.data)); return f; };
export function readManifest(root, group) { const f = path.join(root, 'manifest', `${group}.json`); return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {}; }
export function writeManifest(root, group, m) { const f = path.join(root, 'manifest', `${group}.json`); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(m, null, 1)); return f; }
export const assetRoot = (engine, a) => (engine.resolvePath ? engine.resolvePath(a.out || 'fp_assets', engine.exportDir) : path.resolve(a.out || 'fp_assets'));

/** Write a sweep's sheets + manifest entry. */
export function exportSweep(root, dir, sweep, extra = {}) {
  const { sheets } = packSheets(sweep);
  const files = sheets.map((s, i) => { const rel = `${dir}/sweep_${i}.png`; writePNG(root, rel, s); return rel; });
  return { ...sweep.def, ...extra, sheets: files, px_per_m: PX_PER_M };
}

/** A finite numeric argument (default when absent); positive:true also requires > 0. */
export function numArg(a, k, def, { positive = false } = {}) {
  const v = a[k] === undefined || a[k] === null ? def : Number(a[k]);
  if (!Number.isFinite(v) || (positive && !(v > 0)) || (typeof a[k] === 'string' && !a[k].trim())) throw new Error(`${k} must be a finite number${positive ? ' > 0' : ''} (got ${JSON.stringify(a[k])})`);
  return v;
}
export function listArg(v, all) { if (v === undefined || v === true) return all; if (v === false || v === null) return []; return [].concat(v); }

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
    const root = assetRoot(this, a), step = numArg(a, 'step', GRID_STEP, { positive: true }), t0 = performance.now();
    const out = { guns: {}, mags: {}, attachments: {}, items: {} };
    const mg = readManifest(root, 'fp_guns'), mm = readManifest(root, 'fp_mags'), ma = readManifest(root, 'fp_attach');
    mg.sweeps = mg.sweeps || {}; mm.sweeps = mm.sweeps || {}; ma.sweeps = ma.sweeps || {};
    for (const name of listArg(a.guns, GUN_CLASSES)) {
      checkFpName(name, 'gun');
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
      checkFpName(name, 'magazine');
      const sw = sweepOf(this, name, 'mag', magGrid(name, step));
      mm.sweeps[name] = exportSweep(root, `fp/mags/${name}`, sw);
      out.mags[name] = { cell: sw.def.cell, cells: sw.cells.length, sheets: mm.sweeps[name].sheets.length };
    }
    for (const name of listArg(a.attachments, Object.keys(ATTACH))) {
      checkFpName(name, 'attachment');
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
      checkFpName(id, 'item');
      const sw = sweepOf(this, id, 'item', itemGrid(id, step));
      ma.sweeps[`item:${id}`] = exportSweep(root, `fp/items/${id}`, sw);
      out.items[id] = { cell: sw.def.cell, cells: sw.cells.length, sheets: ma.sweeps[`item:${id}`].sheets.length };
    }
    const files = [writeManifest(root, 'fp_guns', mg), writeManifest(root, 'fp_mags', mm), writeManifest(root, 'fp_attach', ma)];
    return { root, manifests: files, ...out, px_per_m: PX_PER_M, camera: { frame: FRAME, focal_px: F, reference_depth_cm: D }, ms: Math.round(performance.now() - t0) };
  },

  /** Arms strips per skin x class x clip (+ @vgrip / @agrip variants) -> manifest fp. */
  fp_batch(a) {
    const root = assetRoot(this, a), t0 = performance.now(), step = numArg(a, 'step', GRID_STEP, { positive: true });
    const skins = listArg(a.skins, ['mec']);
    for (const s of skins) { checkFpName(s, 'skin'); resolveSkin(this, s); }
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
        const b = bakeClip(cls, n, { skin, variant: v, engine: this, step, gun: a.guns?.[cls], ...(a.contact === false ? { contact: false } : {}) });
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
      const lockFile = insideRoot(root, `${dir}/locks.json`);
      fs.mkdirSync(path.dirname(lockFile), { recursive: true });
      fs.writeFileSync(lockFile, JSON.stringify({ class: cls, gun: a.guns?.[cls] ?? (GUN_CLASSES.includes(cls) ? cls : null), step, anims: locks }));
      report[setName] = Object.keys(set.anims).length;
    }
    const file = writeManifest(root, 'fp', man);
    return { root, manifest: file, sets: report, frames, worst_hand_miss_px: worst, reach_clamped_frames: clampedTotal, ms: Math.round(performance.now() - t0), next: 'art_fp composite {class, clip, frame, gun, attachments} shows a frame exactly as the game draws it; art_fp check validates every gun of each class' };
  },

  /** One frame exactly as the game draws it (from the exported files). */
  fp_composite(a) {
    const root = assetRoot(this, a);
    const r = compositeFromFiles(root, a);
    const k = Math.max(1, Math.min(4, numArg(a, 'zoom', 2)));
    const img = k > 1 ? zoomImg(r, k) : r;
    if (a.canvas) {
      checkFpName(a.canvas, 'canvas');
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
    const guess = a.sweep?.startsWith('att:') || a.sweep?.startsWith('item:') ? 'fp_attach' : MAGS.includes(a.sweep) ? 'fp_mags' : 'fp_guns';
    // a hand-drawn magazine may have any name: look it up where it is
    const group = a.group || (readManifest(root, guess).sweeps?.[a.sweep] ? guess : ['fp_guns', 'fp_mags', 'fp_attach'].find((g) => readManifest(root, g).sweeps?.[a.sweep]) || guess);
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
    const olds = [], news = [];
    const written = sw.sheets.map((rel, i) => {
      const d = this.get(`${base}_${i}`);
      const p = decodePNG(fs.readFileSync(path.join(root, rel)));
      if (d.width !== p.width || d.height !== p.height) throw new Error(`canvas ${d.name} is ${d.width}x${d.height}, sheet ${rel} is ${p.width}x${p.height}`);
      const data = d.composite();
      olds.push({ width: p.width, height: p.height, data: p.data }); news.push({ width: d.width, height: d.height, data });
      fs.writeFileSync(insideRoot(root, rel), encodePNG(d.width, d.height, data));
      return rel;
    });
    // a hand-drawn source: every painted cell is kept as an override canvas, so the next sweep2d keeps it
    const overrides = sw.source === '2d' && sw.source2d ? keepOverrides(this, sw, olds, news, source) : undefined;
    return { imported: written, anchors: 'unchanged', sweep: a.sweep, ...(overrides ? { overrides } : {}) };
  },
};

/** Painted cells of a 2D sweep -> override canvases (meta.fp2d.override) the next sweep2d applies. */
function keepOverrides(engine, sw, olds, news, source) {
  const before = unpackSheets(sw, olds), after = unpackSheets(sw, news);
  const yaws = steps(sw.yaw), out = [], ref = sw.source2d.kind === 'gun' || sw.source2d.kind === 'item' ? 'grip' : 'mount';
  for (let i = 0; i < after.length; i++) {
    if (Buffer.compare(Buffer.from(before[i].buffer), Buffer.from(after[i].buffer)) === 0) continue;
    const yaw = +(sw.yaw[0] + (i % yaws) * sw.yaw[2]).toFixed(6), pitch = +(sw.pitch[0] + Math.floor(i / yaws) * sw.pitch[2]).toFixed(6);
    const name = `fpo_${sw.source2d.name}${sw.source2d.state ? `_${sw.source2d.state}` : ''}_${yaw}_${pitch}`.replace(/-/g, 'm').replace(/[^\w.]/g, '_');
    if (engine.docs.has(name)) engine.docs.delete(name);
    const d = new Doc({ name, width: sw.cell[0], height: sw.cell[1] });
    d.layers[0].data.set(after[i]);
    d.meta = { fp2d: { source: sw.source2d.name, kind: sw.source2d.kind, ...(sw.source2d.state ? { state: sw.source2d.state } : {}), override: { yaw, pitch }, grip: sw.anchors[ref][i] } };
    engine.attach(d);
    engine.changed?.(d, { op: 'fp_paint', source, label: `fp2d override ${sw.source2d.name} ${yaw}/${pitch}`, structural: true });
    out.push(name);
  }
  return out;
}

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
  const yawOff = numArg(a, 'yaw_offset', 0), pitchOff = numArg(a, 'pitch_offset', 0), frame = numArg(a, 'frame', 0);
  const A = loadFrameAssets(root, a);
  const f = Math.max(0, Math.min(A.anim.frames - 1, frame));
  return { ...composite({ anim: A.anim, f, layers: A.layers, gun: A.gun, mag: A.mag, attachments: A.attachments, items: A.items, yawOff, pitchOff, background: a.background === undefined ? [62, 58, 54, 255] : a.background }), anim: A.name };
}

// ---------- fp check ----------
export function checkAssets(root, { classes = null, engine = null, limit = 30 } = {}) {
  const t0 = performance.now();
  const fpm = readManifest(root, 'fp'), gm = readManifest(root, 'fp_guns'), am = readManifest(root, 'fp_attach'), mm = readManifest(root, 'fp_mags');
  const issues = [], counts = { frames: 0, hand_checks: 0, ads_frames: 0, mag_handoffs: 0, attachment_pairs: 0, guns: 0 };
  const worst = { hand_px: 0, ads_px: 0, mag_handoff_px: 0, anchor_jump_px: 0 };
  const bad = (x) => { if (issues.length < limit) issues.push(x); counts.failed = (counts.failed || 0) + 1; };
  const warnings = [];
  const warn = (x) => { if (warnings.length < limit) warnings.push(x); counts.warnings = (counts.warnings || 0) + 1; };
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
          // hand-drawn skin / gun: finger pixels over the gun outside its zones (none left after clipping)
          if (gName === std && lk.contact) for (const [side, c] of Object.entries(lk.contact)) {
            counts.contact_checks = (counts.contact_checks || 0) + 1;
            worst.finger_out_px = Math.max(worst.finger_out_px ?? 0, c.out);
            if (c.out > 0) bad({ set: setName, anim, frame: f, hand: side, issue: `${c.out} finger px over the gun outside its grip / guard / foregrip zones` });
            if (c.nudge) counts.nudged_hands = (counts.nudged_hands || 0) + 1;
          }
          // the magazine in hand must stay visible (the pinching hand over it)
          if (gName === std && lk.mag_visible != null) {
            counts.mag_visibility_checks = (counts.mag_visibility_checks || 0) + 1;
            worst.mag_visible_min = Math.min(worst.mag_visible_min ?? 1, lk.mag_visible);
            if (lk.mag_visible < MAG_VISIBLE_MIN) bad({ set: setName, anim, frame: f, issue: `the hand hides the magazine (${Math.round(lk.mag_visible * 100)}% visible, min ${MAG_VISIBLE_MIN * 100}%)` });
          }
          for (const side of ['R', 'L']) {
            const h = lk[side];
            if (!h) continue;
            counts.hand_checks++;
            // hand-drawn arms: a held hand mostly hidden (part order / layers), an arm that cannot reach
            if (gName === std && h.vis !== undefined && h.vis < 0.2) warn({ set: setName, anim, frame: f, hand: side, issue: `hand drawing "${h.pose}" only ${Math.round(h.vis * 100)}% visible (behind the gun or its fore arm: draw a "front" layer, or check the part order)` });
            if (gName === std && h.clamped) warn({ set: setName, anim, frame: f, hand: side, issue: 'arm cannot reach the anchor (reach clamped)' });
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
      // hand-drawn guns carry their 3D anchors as fitted to the drawings (sockets3d)
      const two = gd.source === '2d';
      const def = two ? null : fpDef(engine, name, 'gun'), so = two ? Object.fromEntries(Object.entries(gd.sockets3d || {}).map(([k, v]) => [k, { at: v }])) : def.sockets || {};
      const pt = (k) => (so[k] ? [-so[k].at[2], -so[k].at[1], so[k].at[0]] : undefined); // along (fwd), across (down), lateral
      const kind = (two ? gd.class : def.fp?.class) === 'pistol' ? 'pistol' : 'long';
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
  // hand-drawn sources: what fp2d found at sweep time (anchor consistency across keys, anchors off the art, palette)
  for (const [group, m] of [['fp_guns', gm], ['fp_mags', mm], ['fp_attach', am]]) {
    for (const [name, d] of Object.entries(m.sweeps || {})) {
      if (d.source !== '2d' || !d.check2d) continue;
      if (classes && d.class && !classes.includes(d.class)) continue;
      counts.sources_2d = (counts.sources_2d || 0) + 1;
      for (const w of d.check2d.warnings || []) warn({ sweep: name, group, ...w });
      if (d.check2d.palette_ok === false) bad({ sweep: name, group, issue: `cells hold ${d.check2d.foreign_colors} colour(s) that are not in the drawings` });
    }
  }
  void RENDER_ORDER;
  const pass = !counts.failed;
  return { pass, root, ...counts, worst: Object.fromEntries(Object.entries(worst).map(([k, v]) => [k, r1(v)])), summary: pass ? `PASS: ${counts.frames} frames, ${counts.hand_checks} hand locks, ${counts.guns} guns, ${counts.attachment_pairs} attachment fits` : `FAIL: ${counts.failed} issues (first: ${JSON.stringify(issues[0])})`, ...(issues.length ? { issues } : {}), ...(warnings.length ? { warnings } : {}), ms: Math.round(performance.now() - t0) };
}

/** Contact sheet of RGBA frames (for demos / replies). */
export function contactSheet(items, { columns = 3, labels = true, zoom = 1 } = {}) {
  const its = items.map((it) => ({ img: zoom > 1 ? zoomImg(it.img, zoom) : it.img, label: it.label }));
  return packImages(its, { labels, checker: false, columns });
}
