// Engine ops for rigs (art_rig). The rig definition lives in the parts canvas meta.rig, so it is
// saved, undone and shown in the UI like any canvas.
import { Doc, Layer, checkSize, MAX_SIZE } from './doc.js';
import { encodePNG } from './png.js';
import { packImages } from './sheet.js';
import { rigTemplate, mergeTemplate, RIG_TEMPLATES, TEMPLATE_FRAME } from './rigtemplates.js';
import { normalizeRig, normalizeSecondary, cellOf, renderPose, animatePoses, resolvePose, lowestRow, shiftFrame, poseAnchors, plantFeet, simulateSecondary, ikChain } from './rig.js';

const partsName = (name) => `${name}_parts`;

function getRig(engine, name) {
  if (!name) throw new Error('rig "name" is required');
  const d = engine.docs.get(partsName(name));
  if (!d || !d.meta?.rig) throw new Error(`No rig "${name}" (art_rig create first)`);
  return { d, rig: normalizeRig(d.meta.rig), def: d.meta.rig };
}

/** Thin 1px cell frames on a hidden "cells" layer so the UI shows where each part goes. */
function cellGuides(rig, d) {
  const data = new Uint8ClampedArray(d.width * d.height * 4);
  for (const view of rig.views) for (const name of rig.order) for (const variant of rig.parts[name].variants) {
    const c = cellOf(rig, name, view, variant);
    const [px, py] = rig.parts[name].pivot;
    for (let y = c.y; y < c.y + c.h; y++) for (let x = c.x; x < c.x + c.w; x++) {
      const edge = x === c.x || y === c.y || x === c.x + c.w - 1 || y === c.y + c.h - 1;
      const piv = x === c.x + px && y === c.y + py;
      if (piv) data.set([255, 60, 60, 200], (y * d.width + x) * 4);
      else if (edge) data.set([90, 140, 255, 90], (y * d.width + x) * 4);
    }
  }
  return data;
}

/** Copy every existing cell from an old layout into a new one (after a rig update). */
function relayout(oldRig, newRig, d) {
  const W = newRig.layout.width, H = newRig.layout.height;
  checkSize(W, H);
  for (const l of d.layers) {
    if (l.name === 'cells') continue;
    const nd = new Uint8ClampedArray(W * H * 4);
    for (const view of newRig.views) for (const name of newRig.order) for (const variant of newRig.parts[name].variants) {
      if (!oldRig.views.includes(view) || !oldRig.parts[name] || !oldRig.parts[name].variants.includes(variant)) continue;
      const a = cellOf(oldRig, name, view, variant), b = cellOf(newRig, name, view, variant);
      for (let y = 0; y < Math.min(a.h, b.h); y++) for (let x = 0; x < Math.min(a.w, b.w); x++) {
        const s = ((a.y + y) * d.width + a.x + x) * 4;
        nd.set(l.data.subarray(s, s + 4), ((b.y + y) * W + b.x + x) * 4);
      }
    }
    l.data = nd;
  }
  d.width = W;
  d.height = H;
  const cells = d.layers.find((l) => l.name === 'cells');
  if (cells) cells.data = cellGuides(newRig, d);
}

/** Rig-level options stored in the definition (absent = old behaviour). */
const RIG_OPTS = ['sampling', 'secondary', 'feet', 'scale_children'];

/** Validate pose data: parts, variants, per-view overrides and IK specs. */
function checkPose(rig, P, where = 'pose') {
  const ok = (tg) => (Array.isArray(tg) ? tg.length === 2 && tg.every((n) => Number.isFinite(Number(n))) : tg?.mix ? ok(tg.mix[0]) && ok(tg.mix[1]) : !!(tg?.part && rig.parts[tg.part]));
  const checkParts = (o, w) => {
    for (const [k, v] of Object.entries(o || {})) {
      if (k === 'ik' || k === 'views') continue;
      if (!rig.parts[k]) throw new Error(`${w}: unknown part "${k}" (parts: ${rig.order.join(', ')})`);
      if (v?.variant && !rig.parts[k].variants.includes(v.variant)) throw new Error(`${w}: part "${k}" has no variant "${v.variant}"`);
    }
    for (const [end, e] of Object.entries(o?.ik || {})) {
      if (!e) continue;
      ikChain(rig, end);
      if (!ok(e.target)) throw new Error(`${w}: ik "${end}" needs target:[x,y] (frame px) or {part:<existing part>, at?:[dx,dy]}`);
    }
  };
  checkParts(P, where);
  for (const [v, o] of Object.entries(P.views || {})) {
    if (!rig.views.includes(v)) throw new Error(`${where}: views."${v}" must be a drawn view (${rig.views.join(', ')}); mirror views use their source view's override`);
    checkParts(o, `${where} views.${v}`);
  }
}

function cellsReport(rig) {
  const cells = {};
  for (const view of rig.views) {
    cells[view] = {};
    for (const name of rig.order) for (const variant of rig.parts[name].variants) {
      const c = cellOf(rig, name, view, variant);
      cells[view][variant === 'base' ? name : `${name}:${variant}`] = [c.x, c.y, c.w, c.h];
    }
  }
  return cells;
}

export const RIG_OPS = {
  rig_templates() {
    return Object.fromEntries(Object.keys(RIG_TEMPLATES).map((k) => { const t = rigTemplate(k, TEMPLATE_FRAME[k] || [32, 32]); return [k, { views: t.views, mirror_views: Object.keys(t.mirror || {}), parts: Object.keys(t.parts), presets: Object.keys(t.presets), ...(t.sampling ? { sampling: t.sampling } : {}), guide: t.guide }]; }));
  },

  rig_create(a, source) {
    const name = a.name;
    if (!/^[\w.-]{1,58}$/.test(name || '')) throw new Error('rig "name" must be 1-58 chars of letters, digits, _ - .');
    const pn = partsName(name);
    if (this.docs.has(pn) && !a.overwrite) throw new Error(`Rig "${name}" exists (overwrite:true replaces it, art_rig update changes it)`);
    let def, guide;
    if (a.template) {
      // template = starting point only: caller parts/poses/presets/views/root override it
      const t = mergeTemplate(rigTemplate(a.template, a.frame), a);
      guide = t.guide;
      def = { frame: t.frame, views: t.views, mirror: t.mirror, parts: t.parts, root: t.root, pairs: a.pairs, poses: t.poses, presets: t.presets, template: a.template };
      for (const k of RIG_OPTS) if (t[k] !== undefined && !(k === 'secondary' && !Object.keys(t[k]).length)) def[k] = t[k];
    } else {
      def = { frame: a.frame, views: a.views, mirror: a.mirror, parts: a.parts, root: a.root, pairs: a.pairs, poses: a.poses || {}, presets: a.presets || {} };
      for (const k of RIG_OPTS) if (a[k] !== undefined) def[k] = a[k];
    }
    const rig = normalizeRig(def);
    for (const [k, P] of Object.entries(rig.poses)) checkPose(rig, P, `pose "${k}"`);
    checkSize(rig.layout.width, rig.layout.height);
    const d = new Doc({ name: pn, width: rig.layout.width, height: rig.layout.height });
    if (a.project) { this.getProject(a.project); d.project = a.project; }
    if (a.palette) Object.assign(d.palette, a.palette);
    d.layers[0].name = 'parts';
    const guides = new Layer('cells', d.width, d.height, cellGuides(rig, d));
    guides.visible = true;
    guides.opacity = 1;
    d.layers.push(guides);
    d.active = 0;
    d.meta = { rig: { ...def, frame: rig.frame, views: rig.views, root: rig.root }, build: false };
    this.attach(d);
    this.changed(d, { op: 'rig', source, label: `rig ${name} created`, structural: true });
    return {
      rig: name, parts_canvas: pn, frame: rig.frame, views: rig.views, mirror_views: Object.keys(rig.mirror), cells: cellsReport(rig),
      ...(guide ? { template: a.template, guide, poses: Object.keys(def.poses), presets: Object.keys(def.presets) } : {}),
      next: `Draw each part on canvas "${pn}" (layer "parts") inside its cell [x,y,w,h]; red dot = pivot (the "cells" guide layer is visible in the UI and never exported). Same palette keys in every view. Check with art_rig preview, then ${guide ? `art_rig animate {name, preset:"${Object.keys(def.presets)[0]}", view} for each preset (sizes/poses are only defaults: art_rig update / pose change anything)` : 'art_rig pose / animate'}.`,
    };
  },

  rig_update(a, source) {
    const { d, rig: oldRig, def } = getRig(this, a.name);
    d.checkpoint('rig update');
    const next = { ...def };
    for (const k of ['frame', 'views', 'mirror', 'root', 'pairs', ...RIG_OPTS]) if (a[k] !== undefined) next[k] = a[k];
    if (a.poses) {
      next.poses = { ...(def.poses || {}) };
      for (const [k, v] of Object.entries(a.poses)) if (v === null) delete next.poses[k]; else next.poses[k] = v;
    }
    if (a.presets) {
      next.presets = { ...(def.presets || {}) };
      for (const [k, v] of Object.entries(a.presets)) if (v === null) delete next.presets[k]; else next.presets[k] = v;
    }
    if (a.parts) {
      next.parts = { ...def.parts };
      for (const [k, v] of Object.entries(a.parts)) {
        if (v === null) delete next.parts[k];
        else next.parts[k] = { ...(def.parts[k] || {}), ...v };
      }
    }
    const rig = normalizeRig(next);
    if (a.poses) for (const [k, P] of Object.entries(a.poses)) if (P) checkPose(rig, P, `pose "${k}"`);
    relayout(oldRig, rig, d);
    d.meta = { ...d.meta, rig: { ...next, frame: rig.frame, views: rig.views, root: rig.root } };
    d.touch?.();
    this.changed(d, { op: 'rig', source, label: `rig ${a.name} updated`, structural: true });
    return { rig: a.name, cells: cellsReport(rig) };
  },

  rig_info(a) {
    const { rig, def } = getRig(this, a.name);
    return {
      rig: a.name, parts_canvas: partsName(a.name), frame: rig.frame, root: rig.root, views: rig.views, mirror: rig.mirror, pairs: rig.pairs,
      parts: Object.fromEntries(rig.order.map((n) => { const p = rig.parts[n]; return [n, { w: p.w, h: p.h, pivot: p.pivot, parent: p.parent, at: p.at, z: p.z, variants: p.variants.slice(1), views: p.views }]; })),
      cells: cellsReport(rig), poses: rig.poses, presets: def.presets || {},
      sampling: rig.sampling, scale_children: rig.scaleChildren, secondary: rig.secondary, feet: rig.feet,
      note: 'complete rig for game engines: save this JSON as <name>_rig.json',
    };
  },

  rig_pose(a, source) {
    const { d, rig, def } = getRig(this, a.name);
    if (!/^[\w.-]+$/.test(a.pose || '')) throw new Error('pose needs a "pose" name');
    const poses = { ...(def.poses || {}) };
    if (a.parts === null || a.delete) delete poses[a.pose];
    else {
      if ((!a.parts || typeof a.parts !== 'object') && !a.views && !a.ik) throw new Error('pose needs "parts": {part: {x?, y?, rot?, sx?, sy?, variant?, hide?}} (offsets from the rest pose), and/or views:{view:{part:{...}}} / ik:{end:{target, bend?, rot?}}');
      const add = { ...(a.parts || {}) };
      if (a.views) add.views = a.views;
      if (a.ik) add.ik = a.ik;
      checkPose(rig, add);
      const base = a.from ? resolvePose(rig, { pose: a.from }) : a.merge && poses[a.pose] ? poses[a.pose] : {};
      const P = { ...base, ...add };
      if (a.views && base.views) {
        P.views = { ...base.views };
        for (const [v, o] of Object.entries(a.views)) P.views[v] = { ...(base.views[v] || {}), ...o };
      }
      if (a.ik && base.ik) P.ik = { ...base.ik, ...a.ik };
      poses[a.pose] = P;
    }
    d.checkpoint(`pose ${a.pose}`);
    d.meta = { ...d.meta, rig: { ...def, poses } };
    this.changed(d, { op: 'rig', source, label: `pose ${a.pose}`, structural: true });
    return { rig: a.name, poses: Object.keys(poses) };
  },

  /** One pose in one view (or every view side by side) as an image. */
  rig_preview(a) {
    const { d, rig } = getRig(this, a.name);
    const pose = a.pose !== undefined ? resolvePose(rig, { pose: a.pose }) : a.parts || {};
    const views = a.view ? [a.view] : [...rig.views, ...Object.keys(rig.mirror)];
    const scale = a.scale ?? Math.max(1, Math.min(12, Math.floor(160 / Math.max(...rig.frame))));
    const cache = new Map();
    const items = views.map((v) => {
      const data = renderPose(rig, d, pose, v, cache);
      const W = rig.frame[0] * scale, H = rig.frame[1] * scale;
      const big = new Uint8ClampedArray(W * H * 4);
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const s = ((Math.floor(y / scale)) * rig.frame[0] + Math.floor(x / scale)) * 4;
        big.set(data.subarray(s, s + 4), (y * W + x) * 4);
      }
      // ground line under the rest pose's lowest pixel (helps keep feet aligned)
      const low = lowestRow(renderPose(rig, d, {}, v, cache), rig.frame[0], rig.frame[1]);
      const gy = Math.min(H - 1, ((low >= 0 ? low + 1 : rig.root[1])) * scale);
      for (let x = 0; x < W; x += 2) if (!big[(gy * W + x) * 4 + 3]) big.set([255, 80, 80, 120], (gy * W + x) * 4);
      return { img: { width: W, height: H, data: big }, label: v };
    });
    const img = packImages(items, { labels: true });
    return { rig: a.name, pose: a.pose ?? null, views, image: encodePNG(img.width, img.height, img.data) };
  },

  /** One still frame per view (front/side/back/mirrors) on one canvas, each tagged with its view name. */
  rig_turnaround(a, source) {
    const { rig } = getRig(this, a.name);
    const views = a.views || [...rig.views, ...Object.keys(rig.mirror)];
    const out = [];
    for (const v of views) {
      const r = RIG_OPS.rig_animate.call(this, { name: a.name, canvas: a.canvas, animation: v, view: v, keys: [a.pose !== undefined ? { pose: a.pose } : { parts: a.parts || {} }], frames: 1, loop: false, duration: a.duration ?? 500 }, source);
      out.push([v, r.frames[0]]);
    }
    return { canvas: a.canvas || a.name, frames: Object.fromEntries(out), next: 'export each frame with art_export {frame}, or art_animation export spritesheet' };
  },

  /** Tween key poses into frames on an output canvas and tag them as an animation. */
  rig_animate(a, source) {
    const { d, rig, def } = getRig(this, a.name);
    if (a.preset) {
      const pr = (def.presets || {})[a.preset];
      if (!pr) throw new Error(`no preset "${a.preset}" (presets: ${Object.keys(def.presets || {}).join(', ') || 'none'}; add one with art_rig update {presets:{name:{keys,frames,fps,loop?,plant_feet?}}})`);
      const named = a.animation;
      a = { ...pr, ...Object.fromEntries(Object.entries(a).filter(([, v]) => v !== undefined)) };
      a.animation = named || (a.view && a.view !== rig.views[0] ? `${a.preset}_${a.view}` : a.preset);
    }
    if (!/^[\w.-]+$/.test(a.animation || '')) throw new Error('animate needs an "animation" name (e.g. "walk_side")');
    const view = a.view || rig.views[0];
    // ik_from: per-frame IK targets from another canvas's anchors (a pre-rendered gun clip's
    // socket_grip_r / socket_grip_l), same frame count and timing as that animation
    const follow = a.ik_from ? ikFromAnchors(this, rig, a.ik_from, view) : null;
    if (follow) {
      a = { ...a, frames: follow.targets.length };
      if (a.duration === undefined && a.fps === undefined) a.duration = follow.duration;
      if (a.loop === undefined) a.loop = follow.loop;
      if (!a.keys) a.keys = [{ parts: {} }];
    }
    const loop = a.loop !== false;
    let poses = animatePoses(rig, { keys: a.keys, frames: a.frames, loop });
    if (follow) poses = poses.map((P, f) => {
      const Q = structuredClone(P);
      Q.views = Q.views || {};
      Q.views[follow.src] = Q.views[follow.src] || {};
      Q.views[follow.src].ik = { ...(Q.views[follow.src].ik || {}), ...follow.targets[f] };
      return Q;
    });
    const notes = follow?.notes || [];
    // plant / ik_feet: pin stance feet with leg IK on contact frames (true = rig feet, or [parts])
    const plant = a.plant ?? a.ik_feet;
    if (plant) {
      const feet = Array.isArray(plant) ? plant : typeof plant === 'string' ? [plant] : rig.feet;
      for (const f of feet) ikChain(rig, f);
      if (feet.length) poses = plantFeet(rig, poses, view, feet, { loop });
      else notes.push('plant: this rig has no foot parts with a two-bone leg (foot -> shin -> thigh); set rig "feet" or pass plant:[parts]');
    }
    // secondary: damped follow-through for rig.secondary parts (or an inline {part:{stiffness,damping}})
    if (a.secondary) {
      const config = typeof a.secondary === 'object' ? normalizeSecondary(rig.parts, a.secondary) : rig.secondary;
      if (Object.keys(config).length) poses = simulateSecondary(rig, poses, view, { loop, config });
      else notes.push('secondary: the rig has no "secondary" parts (art_rig update {secondary:{cape:{stiffness:0.3, damping:0.2}}})');
    }
    const [FW, FH] = rig.frame;
    const outName = a.canvas || a.name;
    let out = this.docs.get(outName);
    if (out) {
      if (out === d) throw new Error('output canvas cannot be the parts canvas');
      if (out.width !== FW || (out.frameHeight || out.height) !== FH) throw new Error(`canvas "${outName}" frames are ${out.width}x${out.frameHeight || out.height}, rig frames are ${FW}x${FH}`);
      out.checkpoint(`rig animate ${a.animation}`);
      if (!out.frameHeight) out.frameHeight = FH;
    } else {
      out = new Doc({ name: outName, width: FW, height: FH, frameHeight: FH });
      out.project = d.project;
      out.meta = { rig: a.name };
      out._fresh = true;
      this.attach(out);
    }
    const n = poses.length;
    // where the frames go: replace the existing tag's frames, reuse a blank fresh canvas, or append
    let start;
    const old = out.animations[a.animation];
    const blankSingle = out.frames === 1 && !Object.keys(out.animations).length && !out.layers.some((l) => l.data.some((v, i) => i % 4 === 3 && v));
    if (old) {
      const sorted = [...old.frames].sort((x, y) => x - y);
      const contiguous = sorted.every((f, i) => f === sorted[0] + i) && new Set(old.frames).size === old.frames.length;
      if (contiguous && sorted.length === n) start = sorted[0];
      else {
        // delete the old frames, append new ones
        const keep = [...Array(out.frames).keys()].filter((f) => !old.frames.includes(f));
        delete out.animations[a.animation];
        out.reorderFrames(keep.length ? keep : [-1]);
        if (!keep.length) { start = 0; out.reorderFrames([...Array(n).fill(-1)]); }
      }
    }
    if (start === undefined) {
      const total = (blankSingle ? 0 : out.frames) + n;
      if (total * FH > MAX_SIZE) throw new Error(`canvas "${outName}" would hold ${total} frames of ${FH}px (${total * FH}px tall, max ${MAX_SIZE}): animate into another canvas, e.g. canvas:"${a.name}_${a.animation}" (one canvas per animation)`);
      if (blankSingle) { out.reorderFrames(Array(n).fill(-1)); start = 0; }
      else { start = out.frames; out.reorderFrames([...Array(out.frames).keys(), ...Array(n).fill(-1)]); }
    }
    let layer = out.layers.find((l) => l.name === 'rig');
    if (!layer) {
      layer = out.layers[0];
      if (out._fresh) layer.name = 'rig';
    }
    delete out._fresh;
    const cache = new Map();
    // plant_feet: keep the lowest painted pixel on the rest pose's ground row in every frame
    // (legs that rotate would otherwise lift the whole body off the floor); gives a natural bob
    const ground = a.plant_feet ? lowestRow(renderPose(rig, d, {}, view, cache), FW, FH) : -1;
    // only / hide: render a subset of parts (paper-doll layers: body without head, gear alone)
    // with the SAME timing and ground shift as the full character, so layers stack exactly
    const filter = { only: a.only, hide: a.hide };
    for (const k of ['only', 'hide']) if (filter[k]) for (const n of filter[k]) if (!rig.parts[n]) throw new Error(`${k}: unknown part "${n}" (parts: ${rig.order.join(', ')})`);
    const anchors = [];
    poses.forEach((pose, i) => {
      let img = renderPose(rig, d, pose, view, cache, filter);
      let dy = 0;
      if (ground >= 0) {
        const full = filter.only || filter.hide ? renderPose(rig, d, pose, view, cache) : img;
        const low = lowestRow(full, FW, FH);
        if (low >= 0) { dy = ground - low; img = shiftFrame(img, FW, FH, dy); }
      }
      const an = poseAnchors(rig, pose, view);
      for (const k of Object.keys(an)) an[k][1] += dy;
      anchors.push(an);
      // replace the frame's pixels on the rig layer
      layer.data.set(img, (start + i) * FW * FH * 4);
    });
    const fps = a.fps ?? (a.duration ? 1000 / a.duration : 10);
    out.setAnimation(a.animation, { from: start, to: start + n - 1, duration: a.duration ?? Math.round(1000 / fps), loop, direction: a.direction });
    // per-frame part anchors (pivot x,y + rotation), exported with spritesheets
    out.meta = { ...(out.meta || {}), anchors: { ...(out.meta?.anchors || {}), [a.animation]: anchors } };
    out.touch?.();
    this.changed(out, { op: 'rig', source, label: `rig ${a.name}: ${a.animation} (${n} frames, ${view})`, structural: true });
    return { canvas: outName, animation: a.animation, view, frames: [start, start + n - 1], fps: Math.round(fps * 10) / 10, total_frames: out.frames, anchors: 'per-frame part anchors saved (spritesheet json frames[].anchors)', ...(follow ? { ik_from: `${follow.canvas}/${follow.animation} (${follow.targets.length} frames)` } : {}), ...(notes.length ? { notes } : {}) };
  },
};

/**
 * ik_from {canvas, animation?, map:{<end part>: "<anchor>" | {anchor, bend?, rot?:true|deg, rot_offset?, at?:[dx,dy]}}, offset?:[dx,dy]}
 * -> per-frame IK specs for the drawn source view (anchors are frame px of the other canvas; a
 * mirror view flips them back into the drawn view).
 */
function ikFromAnchors(engine, rig, spec, view) {
  if (!spec || typeof spec !== 'object' || !spec.canvas) throw new Error('ik_from needs {canvas, animation?, map:{hand_f:"socket_grip_r", ...}}');
  const d = engine.get(spec.canvas);
  const all = d.meta?.anchors || {};
  const animation = spec.animation ?? Object.keys(all)[0];
  const A = all[animation];
  if (!A || !A.length) throw new Error(`ik_from: canvas "${d.name}" has no anchors for animation "${animation}" (anchored animations: ${Object.keys(all).join(', ') || 'none'}; art_model render / art_rig animate save them)`);
  if (!spec.map || typeof spec.map !== 'object' || !Object.keys(spec.map).length) throw new Error('ik_from.map must be {<end part>: "<anchor name>"}, e.g. {hand_f:"socket_grip_r", hand_b:"socket_grip_l"}');
  const src = rig.mirror[view] || view, flip = !!rig.mirror[view];
  const off = (spec.offset || [0, 0]).map(Number);
  const ends = Object.entries(spec.map).map(([end, m]) => {
    const o = typeof m === 'string' ? { anchor: m } : { ...m };
    if (!o.anchor) throw new Error(`ik_from.map.${end} needs an anchor name`);
    ikChain(rig, end);
    return [end, o];
  });
  const notes = [];
  const missing = new Set();
  const targets = A.map((an) => {
    const ik = {};
    for (const [end, o] of ends) {
      const p = an?.[o.anchor];
      if (!p) { missing.add(o.anchor); continue; }
      const at = (o.at || [0, 0]).map(Number);
      let x = Number(p[0]) + off[0] + at[0];
      const y = Number(p[1]) + off[1] + at[1];
      let rot = o.rot === true ? Number(p[2] ?? 0) + Number(o.rot_offset ?? 0) : typeof o.rot === 'number' ? o.rot : undefined;
      if (flip) { x = 2 * rig.root[0] - 1 - x; if (rot !== undefined) rot = -rot; }
      ik[end] = { target: [x, y], ...(o.bend !== undefined ? { bend: o.bend } : {}), ...(rot !== undefined ? { rot } : {}), ...(o.weight !== undefined ? { weight: o.weight } : {}) };
    }
    return ik;
  });
  if (missing.size) notes.push(`ik_from: anchors ${[...missing].join(', ')} missing on some frames of ${d.name}/${animation} (those frames keep FK)`);
  const tag = d.animations[animation];
  return { canvas: d.name, animation, targets, src, notes, duration: tag ? tag.durations[0] : undefined, loop: tag ? tag.loop : undefined };
}
