// Engine ops for rigs (art_rig). The rig definition lives in the parts canvas meta.rig, so it is
// saved, undone and shown in the UI like any canvas.
import { Doc, Layer, checkSize, MAX_SIZE } from './doc.js';
import { encodePNG } from './png.js';
import { packImages } from './sheet.js';
import { rigTemplate, mergeTemplate, RIG_TEMPLATES, TEMPLATE_FRAME, hdWeaponConfig } from './rigtemplates.js';
import { weaponArt, weaponMetrics, CARRY_STATES, ATTACHMENT_TYPES, WEAPON_CLASSES, POINT_NAMES } from './weapon.js';
import { normalizeRig, normalizeSecondary, cellOf, renderPose, animatePoses, resolvePose, lowestRow, shiftFrame, poseAnchors, plantFeet, simulateSecondary, ikChain, solvePose, partIn, poseOf, stableRotations, eventFrames } from './rig.js';
import { depthPass, findFlicker, layerIssues, orderOf } from './depth.js';
import { consistencyReport, deriveCells } from './consistency.js';

const partsName = (name) => `${name}_parts`;

export function getRig(engine, name) {
  if (!name) throw new Error('rig "name" is required');
  const d = engine.docs.get(partsName(name));
  if (!d || !d.meta?.rig) throw new Error(`No rig "${name}" (art_rig create first)`);
  const rig = normalizeRig(d.meta.rig);
  // weapon handling collides with the drawn silhouettes (cell art), not the cell boxes
  if (rig.weapon) weaponArt(rig, artComposite(d), d.width, cellOf);
  return { d, rig, def: d.meta.rig };
}

/** Thin 1px cell frames on a hidden "cells" layer so the UI shows where each part goes. */
function cellGuides(rig, d) {
  const data = new Uint8ClampedArray(d.width * d.height * 4);
  for (const view of rig.views) for (const name of rig.order) for (const variant of rig.parts[name].variants) {
    if (rig.parts[name].art) continue;
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
      if (newRig.parts[name].art) continue;
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
const RIG_OPTS = ['sampling', 'secondary', 'feet', 'scale_children', 'weapon', 'variant_sets', 'depth'];

/** Validate pose data: parts, variants, per-view overrides and IK specs. */
function checkPose(rig, P, where = 'pose') {
  const ok = (tg) => (Array.isArray(tg) ? tg.length === 2 && tg.every((n) => Number.isFinite(Number(n))) : tg?.mix ? ok(tg.mix[0]) && ok(tg.mix[1]) : tg?.weapon !== undefined ? !!rig.weapon && (POINT_NAMES.includes(tg.weapon) || !!rig.weapon.sockets[tg.weapon]) : !!(tg?.part && rig.parts[tg.part]));
  const checkParts = (o, w) => {
    for (const [k, v] of Object.entries(o || {})) {
      if (k === 'ik' || k === 'views') continue;
      if (k === 'carry' && rig.weapon && w === where) {
        // a pose may set the carry state (a state name or {state, ...overrides})
        const st = typeof v === 'string' ? v : v && typeof v === 'object' ? v.state ?? rig.weapon.carry : undefined;
        if (!rig.weapon.states[st]) throw new Error(`${w}: carry: unknown state ${JSON.stringify(st)} (states: ${Object.keys(rig.weapon.states).join(', ')})`);
        continue;
      }
      if (!rig.parts[k]) throw new Error(`${w}: unknown part "${k}" (parts: ${rig.order.join(', ')})`);
      if (v?.variant && !rig.parts[k].variants.includes(v.variant)) throw new Error(`${w}: part "${k}" has no variant "${v.variant}"`);
    }
    for (const [end, e] of Object.entries(o?.ik || {})) {
      if (!e) continue;
      ikChain(rig, end);
      if (!ok(e.target)) throw new Error(`${w}: ik "${end}" needs target:[x,y] (frame px), {part:<existing part>, at?:[dx,dy]} or, with a rig weapon, {weapon:<${POINT_NAMES.join('|')}|socket>, at?:[dx,dy]}`);
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
      if (rig.parts[name].art) continue;
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
      const t = mergeTemplate(rigTemplate(a.template, a.frame, a.weapon ? { weapon: a.weapon } : undefined), a);
      guide = t.guide;
      def = { frame: t.frame, views: t.views, mirror: t.mirror, parts: t.parts, root: t.root, pairs: a.pairs, poses: t.poses, presets: t.presets, template: a.template };
      for (const k of RIG_OPTS) if (t[k] !== undefined && !(k === 'secondary' && !Object.keys(t[k]).length)) def[k] = t[k];
      if (a.weapon && !def.weapon) def.weapon = a.weapon;
      if (a.depth !== undefined) def.depth = a.depth;
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
    if (a.weapon && def.template === 'humanoid_hd') {
      // humanoid_hd: carry states for the template poses and cells for any new attachments
      next.weapon = hdWeaponConfig(a.weapon);
      const tp = rigTemplate('humanoid_hd', next.frame || def.frame, { weapon: a.weapon }).parts;
      next.parts = { ...(next.parts || def.parts) };
      for (const [k, v] of Object.entries(tp)) if (/^att_/.test(k) && !next.parts[k] && v.parent === 'weapon') next.parts[k] = v;
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
      ...(rig.weapon ? { weapon: weaponSummary(rig) } : {}), ...(rig.variantSets ? { variant_sets: rig.variantSets } : {}),
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
    let pose = a.pose !== undefined ? resolvePose(rig, { pose: a.pose, ...(a.carry !== undefined ? { carry: a.carry } : {}) }) : a.parts || {};
    if (a.carry !== undefined && a.pose === undefined) pose = { ...pose, carry: a.carry };
    const views = a.view ? [a.view] : [...rig.views, ...Object.keys(rig.mirror)];
    const scale = a.scale ?? Math.max(1, Math.min(12, Math.floor(160 / Math.max(...rig.frame))));
    const cache = new Map();
    const items = views.map((v) => {
      const data = renderPose(rig, d, pose, v, cache, a.variant ? { variant: a.variant } : {});
      const W = rig.frame[0] * scale, H = rig.frame[1] * scale;
      const big = new Uint8ClampedArray(W * H * 4);
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const s = ((Math.floor(y / scale)) * rig.frame[0] + Math.floor(x / scale)) * 4;
        big.set(data.subarray(s, s + 4), (y * W + x) * 4);
      }
      // ground line: the feet's contact row (where plant pins them), else under the rest pose's lowest pixel
      const ground = feetGround(rig, v);
      const low = ground === null ? lowestRow(renderPose(rig, d, {}, v, cache), rig.frame[0], rig.frame[1]) : ground - 1;
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
      const r = RIG_OPS.rig_animate.call(this, { name: a.name, canvas: a.canvas, animation: v, view: v, keys: [a.pose !== undefined ? { pose: a.pose } : { parts: a.parts || {} }], frames: 1, loop: false, duration: a.duration ?? 500, variant: a.variant, carry: a.carry, constraints: a.constraints }, source);
      out.push([v, r.frames[0]]);
    }
    return { canvas: a.canvas || a.name, frames: Object.fromEntries(out), next: 'export each frame with art_export {frame}, or art_animation export spritesheet' };
  },

  /** Tween key poses into frames on an output canvas and tag them as an animation. */
  rig_animate(a, source) {
    const { d, rig, def } = getRig(this, a.name);
    const fp = framePoses(this, rig, def, a);
    a = fp.a;
    const { view, loop, notes, follow } = fp;
    let poses = fp.poses;
    const [FW, FH] = rig.frame;
    const outName = a.canvas || a.name;
    const cache = new Map();
    const ropts = a.variant ? { variant: a.variant } : {};
    // weapon handling: validate every frame before anything is written (refuse | fix | warn | off)
    let wsum = null;
    if (rig.weapon) {
      const mode = a.constraints ?? 'refuse';
      if (!['refuse', 'fix', 'warn', 'off'].includes(mode)) throw new Error('constraints must be "refuse" (default: no frames are written when one violates), "fix" (auto-correct), "warn" (write + report) or "off"');
      if (mode !== 'off') {
        let fr = weaponFrames(rig, d, poses, view, { ...ropts, cache, visibility: a.visibility !== false });
        let fixed = 0;
        if (mode === 'fix' && fr.some((x) => x.issues.length)) {
          const r = fixFrames(rig, d, poses, view, fr);
          poses = r.poses; fixed = r.fixed;
          fr = weaponFrames(rig, d, poses, view, { ...ropts, cache, visibility: a.visibility !== false });
        }
        const bad = fr.filter((x) => x.issues.length);
        if (bad.length && mode === 'refuse') throw new Error(`weapon constraints: ${bad.length} of ${fr.length} frames violate (${a.animation}, ${view}): ${bad.slice(0, 4).map((x) => `frame ${x.frame}: ${x.issues.join('; ')}`).join(' | ')}${bad.length > 4 ? ' | ...' : ''}. Nothing was written. constraints:"fix" auto-corrects, "warn" writes and reports; art_rig check {name} lists every clip and view.`);
        wsum = { pass: !bad.length, frames: fr.length, failed: bad.length, ...(fixed ? { fixed } : {}), states: [...new Set(fr.map((x) => x.state))], ...(bad.length ? { issues: bad.slice(0, 8).map((x) => ({ frame: x.frame, issues: x.issues })) } : {}) };
      }
    }
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
    // plant_feet: keep the lowest painted pixel on the rest pose's ground row in every frame
    // (legs that rotate would otherwise lift the whole body off the floor); gives a natural bob
    const ground = a.plant_feet ? lowestRow(renderPose(rig, d, {}, view, cache, ropts), FW, FH) : -1;
    // only / hide: render a subset of parts (paper-doll layers: body without head, gear alone)
    // with the SAME timing and ground shift as the full character, so layers stack exactly
    const filter = { only: a.only, hide: a.hide, ...ropts };
    for (const k of ['only', 'hide']) if (filter[k]) for (const n of filter[k]) if (!rig.parts[n]) throw new Error(`${k}: unknown part "${n}" (parts: ${rig.order.join(', ')})`);
    const anchors = [], order = [];
    // stable:true | {step, hold}: quantized drawing angles with hysteresis (no pixel shimmer)
    const rots = a.stable ? stableRotations(rig, poses, view, typeof a.stable === 'object' ? a.stable : {}) : null;
    poses.forEach((pose, i) => {
      const trace = {};
      let img = renderPose(rig, d, pose, view, cache, { ...filter, ...(rots ? { rot: rots[i] } : {}), trace });
      order.push(orderOf(trace));
      let dy = 0;
      if (ground >= 0) {
        const full = filter.only || filter.hide ? renderPose(rig, d, pose, view, cache, { ...ropts, ...(rots ? { rot: rots[i] } : {}) }) : img;
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
    // per-frame part anchors (pivot x,y + rotation), draw order (bottom -> top) and events,
    // exported with spritesheets (json frames[].anchors / order / events)
    const meta = { ...(out.meta || {}), anchors: { ...(out.meta?.anchors || {}), [a.animation]: anchors } };
    if (rig.depth || a.order) meta.order = { ...(out.meta?.order || {}), [a.animation]: order };
    if (fp.events.length) meta.events = { ...(out.meta?.events || {}), [a.animation]: fp.events };
    else if (meta.events?.[a.animation]) { meta.events = { ...meta.events }; delete meta.events[a.animation]; }
    out.meta = meta;
    out.touch?.();
    this.changed(out, { op: 'rig', source, label: `rig ${a.name}: ${a.animation} (${n} frames, ${view})`, structural: true });
    return { canvas: outName, animation: a.animation, view, frames: [start, start + n - 1], fps: Math.round(fps * 10) / 10, total_frames: out.frames, anchors: 'per-frame part anchors saved (spritesheet json frames[].anchors)', ...(fp.events.length ? { events: fp.events } : {}), ...(follow ? { ik_from: `${follow.canvas}/${follow.animation} (${follow.targets.length} frames)` } : {}), ...(a.variant ? { variant: a.variant } : {}), ...(wsum ? { weapon: wsum } : {}), ...(notes.length ? { notes } : {}) };
  },

  /** Draw order of one frame (bottom -> top): part, z and what set it (pose z, view z, weapon depth / layer rules). */
  rig_layers(a) {
    const { rig, def } = getRig(this, a.name);
    // all_frames / a canvas tag (the web UI's Layers view): every frame's stack with the rule per part
    if (a.all_frames || a.tag !== undefined) {
      const { view, poses, source } = uiPoses(this, rig, def, a);
      return { rig: a.name, view, views: [...rig.views, ...Object.keys(rig.mirror)], source: `rig_layers: ${source} (solved: depth, weapon, z keys)`, parts: rig.order, frames: poses.map((P, i) => ({ frame: i, stack: uiStack(rig, P, view) })) };
    }
    const { pose, view, frame, label } = oneFrame(this, rig, def, a);
    const st = layerStack(rig, pose, view);
    return { rig: a.name, view, frame: label, frame_index: frame, order: st.order.map((e) => [e.part, e.z, e.reason]), ...(st.hidden.length ? { hidden: st.hidden } : {}), key: '[part, z, reason], bottom first; equal z: part order' };
  },

  /**
   * One frame as per-part layers: the stack (bottom first, with rules) and an atlas PNG with one
   * frame-sized cell per drawn part in draw order (the web UI's Layers view tints / solos / hit-tests
   * them). Frame: tag + frame (UI), preset + frame, pose, or rest.
   */
  rig_debug_render(a) {
    const { d, rig, def } = getRig(this, a.name);
    const { view, poses, source } = a.tag !== undefined || !a.preset ? uiPoses(this, rig, def, a) : uiPoses(this, rig, def, { ...a, tag: undefined });
    const fi = Math.max(0, Math.min(poses.length - 1, Number(a.frame ?? 0) || 0));
    const pose = poses[fi];
    const stack = uiStack(rig, pose, view);
    const shown = stack.filter((s) => !s.hidden).map((s) => s.part);
    const [FW, FH] = rig.frame;
    const cache = new Map();
    const atlas = new Uint8ClampedArray(FW * FH * Math.max(1, shown.length) * 4);
    shown.forEach((p, i) => atlas.set(renderPose(rig, d, pose, view, cache, { only: [p] }), i * FW * FH * 4));
    const png = encodePNG(FW, FH * Math.max(1, shown.length), atlas);
    return { rig: a.name, view, frame: fi, size: [FW, FH], source: `rig_debug_render: ${source}`, stack, atlas_parts: shown, atlas: png.toString('base64') };
  },

  /** Why part_a is drawn over (or under) part_b in a frame. */
  rig_explain(a) {
    const { rig, def } = getRig(this, a.name);
    for (const k of ['part_a', 'part_b']) if (!rig.parts[a[k]]) throw new Error(`explain needs ${k}: a part name (parts: ${rig.order.join(', ')})`);
    const { pose, view, label } = oneFrame(this, rig, def, a);
    const st = layerStack(rig, pose, view);
    const all = [...st.order, ...st.hidden.map((p) => ({ part: p, hidden: true }))];
    const A = all.find((e) => e.part === a.part_a), B = all.find((e) => e.part === a.part_b);
    if (A.hidden || B.hidden) return { view, frame: label, answer: `${A.hidden ? a.part_a : a.part_b} is not drawn in this frame (hidden)` };
    const ia = st.order.indexOf(A), ib = st.order.indexOf(B), top = ia > ib ? A : B, bot = ia > ib ? B : A;
    const why = top.z !== bot.z ? `z ${top.z} > ${bot.z}` : 'equal z: later in the part order wins';
    return { view, frame: label, over: top.part, under: bot.part, answer: `${top.part} is drawn over ${bot.part}: ${why}`, [top.part]: { z: top.z, reason: top.reason }, [bot.part]: { z: bot.z, reason: bot.reason } };
  },

  /**
   * Weapon-handling validation: every frame of every preset (clip) in every view (drawn + mirror):
   * hand-to-grip distance, limb over-extension / inverted elbows, weapon-body penetration,
   * muzzle flags and weapon visibility. -> pass/fail summary + the failing frames.
   */
  rig_check(a) {
    const { d, rig, def } = getRig(this, a.name);
    if (!rig.weapon) throw new Error(`rig "${a.name}" has no weapon: art_rig update {name:"${a.name}", weapon:{class:"rifle"}} (or create with weapon:{...}) first`);
    const presets = a.clips ? [].concat(a.clips) : a.preset ? [a.preset] : Object.keys(def.presets || {});
    for (const p of presets) if (!(def.presets || {})[p]) throw new Error(`check: no preset "${p}" (presets: ${Object.keys(def.presets || {}).join(', ')})`);
    const views = a.views ? [].concat(a.views) : a.view ? [a.view] : [...rig.views, ...Object.keys(rig.mirror)];
    const ropts = a.variant ? { variant: a.variant } : {};
    const cache = new Map();
    const clips = {};
    let frames = 0, failed = 0;
    const worst = { hand_grip: 0, reach: 0, penetration: 0, visible: null };
    const issues = [];
    for (const preset of presets) {
      clips[preset] = {};
      const bySrc = new Map();
      for (const view of views) {
        const src = rig.mirror[view] || view;
        if (!rig.views.includes(src)) throw new Error(`check: unknown view "${view}"`);
        let fr = bySrc.get(src);
        if (!fr) {
          const fp = framePoses(this, rig, def, { ...a, preset, view: src, animation: undefined, keys: undefined, frames: undefined });
          fr = weaponFrames(rig, d, fp.poses, src, { ...ropts, cache, visibility: a.visibility !== false });
          bySrc.set(src, fr);
        }
        const bad = fr.filter((x) => x.issues.length);
        frames += fr.length; failed += bad.length;
        for (const x of fr) {
          for (const v of Object.values(x.hand_grip)) worst.hand_grip = Math.max(worst.hand_grip, v);
          for (const v of Object.values(x.reach)) if (v !== null) worst.reach = Math.max(worst.reach, v);
          worst.penetration = Math.max(worst.penetration, x.penetration);
          if (x.visible !== null && !x.hidden) worst.visible = worst.visible === null ? x.visible : Math.min(worst.visible, x.visible);
        }
        clips[preset][view] = { frames: fr.length, failed: bad.length, ...(a.detail ? { metrics: fr } : {}) };
        for (const x of bad) if (issues.length < (a.limit ?? 40)) issues.push({ clip: preset, view, frame: x.frame, state: x.state, issues: x.issues });
      }
    }
    return {
      rig: a.name, pass: failed === 0, frames_checked: frames, frames_failed: failed, worst,
      summary: failed ? `FAIL: ${failed} of ${frames} frames violate weapon constraints (first: ${issues[0].clip}/${issues[0].view} frame ${issues[0].frame}: ${issues[0].issues[0]})` : `PASS: ${frames} frames in ${presets.length} clips x ${views.length} views hold the weapon correctly`,
      clips, ...(issues.length ? { issues } : {}),
      next: failed ? 'art_rig animate {..., constraints:"fix"} auto-corrects; or tune weapon.points / weapon.states (art_help {topic:"rig"})' : undefined,
    };
  },

  /**
   * Cross-view consistency of the drawn cells: empty cells, palette drift between views of a part,
   * bone length drift, pivots and joints off the drawing, silhouette height per view.
   */
  rig_consistency(a) {
    const { d, rig } = getRig(this, a.name);
    return { rig: a.name, ...consistencyReport(rig, d, artComposite(d), { views: a.views, tolerance: a.tolerance, limit: a.limit }) };
  },

  /** Copy drawn cells from one view into others (a start to paint over): parts?, from, to:[views], flip?, overwrite?. */
  rig_derive(a, source) {
    const { d, rig } = getRig(this, a.name);
    if (!a.from || !rig.views.includes(a.from)) throw new Error(`derive needs from: a drawn view (${rig.views.join(', ')})`);
    const to = [].concat(a.to ?? rig.views.filter((v) => v !== a.from));
    for (const v of to) if (!rig.views.includes(v) || v === a.from) throw new Error(`derive: to must be other drawn views (${rig.views.filter((x) => x !== a.from).join(', ')})`);
    const parts = a.parts || (a.part ? [a.part] : rig.order);
    for (const p of parts) if (!rig.parts[p]) throw new Error(`derive: unknown part "${p}"`);
    d.checkpoint('rig derive');
    const r = deriveCells(rig, d, { parts, from: a.from, to, flip: !!a.flip, overwrite: !!a.overwrite });
    d.touch?.();
    this.changed(d, { op: 'rig', source, label: `rig ${a.name}: derived ${r.copied.length} cells from ${a.from}` });
    return { rig: a.name, from: a.from, to, ...r, next: 'paint over the derived cells (turn, shade, foreshorten); art_rig consistency checks the views agree' };
  },

  /**
   * Draw-order validation of clips: z-flicker (two overlapping parts swap order and swap back
   * within `window` frames) and depth-rule violations (a part drawn under / over its reference
   * against the depth model). -> pass/fail + per-frame order of the failing frames.
   */
  rig_zcheck(a) {
    const { d, rig, def } = getRig(this, a.name);
    const presets = a.clips || (a.preset ? [a.preset] : Object.keys(def.presets || {}));
    for (const p of presets) if (!(def.presets || {})[p]) throw new Error(`zcheck: no preset "${p}" (presets: ${Object.keys(def.presets || {}).join(', ')})`);
    const views = a.views || (a.view ? [a.view] : [...rig.views, ...Object.keys(rig.mirror)]);
    const cache = new Map();
    const ropts = a.variant ? { variant: a.variant } : {};
    const issues = [];
    let frames = 0, failed = 0;
    for (const preset of presets) for (const view of views) {
      const fp = framePoses(this, rig, def, { ...a, preset, view, animation: undefined, keys: undefined, frames: undefined });
      const traces = fp.poses.map((P) => { const t = {}; renderPose(rig, d, P, view, cache, { ...ropts, sampling: 'nearest8', trace: t }); return t; });
      const bad = new Map();
      const add = (f, msg) => { if (!bad.has(f)) bad.set(f, []); bad.get(f).push(msg); };
      for (const fl of findFlicker(traces, { window: a.window ?? 2, loop: fp.loop })) for (const f of fl.frames) add(f, `z-flicker: ${fl.pair[0]} / ${fl.pair[1]} swap order and swap back`);
      if (rig.depth) fp.poses.forEach((P, f) => { for (const m of layerIssues(rig, traces[f], solvePose(rig, P, view).depth)) add(f, m); });
      frames += fp.poses.length; failed += bad.size;
      for (const [f, msgs] of [...bad.entries()].sort((x, y) => x[0] - y[0])) if (issues.length < (a.limit ?? 40)) issues.push({ clip: preset, view, frame: f, issues: msgs, order: orderOf(traces[f]) });
    }
    return {
      rig: a.name, pass: failed === 0, frames_checked: frames, frames_failed: failed, depth_model: !!rig.depth,
      summary: failed ? `FAIL: ${failed} of ${frames} frames have draw-order problems (first: ${issues[0].clip}/${issues[0].view} frame ${issues[0].frame}: ${issues[0].issues[0]})` : `PASS: ${frames} frames in ${presets.length} clips x ${views.length} views: no z-flicker${rig.depth ? ', order agrees with depth' : ''}`,
      ...(issues.length ? { issues } : {}),
      ...(failed && !rig.depth ? { next: 'art_rig update {depth:true} decides arm order from depth with hysteresis; or remove the alternating z keys' } : {}),
    };
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

/**
 * The pose pipeline of art_rig animate (and check): preset merge, ik_from, tweening, carry /
 * attach overrides, foot planting, secondary motion. -> {a (resolved args), view, loop, poses, notes, follow}
 */
export function framePoses(engine, rig, def, a) {
  if (a.preset) {
    const pr = (def.presets || {})[a.preset];
    if (!pr) throw new Error(`no preset "${a.preset}" (presets: ${Object.keys(def.presets || {}).join(', ') || 'none'}; add one with art_rig update {presets:{name:{keys,frames,fps,loop?,plant_feet?}}})`);
    const named = a.animation;
    a = { ...pr, ...Object.fromEntries(Object.entries(a).filter(([, v]) => v !== undefined)) };
    // one tag convention: <preset>_<view> (the view defaults to the rig's first view)
    a.animation = named || `${a.preset}_${a.view || rig.views[0]}`;
  }
  if (!/^[\w.-]+$/.test(a.animation || '')) throw new Error('animate needs an "animation" name (e.g. "walk_side")');
  const view = a.view || rig.views[0];
  if (a.variant !== undefined) {
    for (const s of [].concat(a.variant)) if (typeof s !== 'string' || !(rig.variantSets?.[s] || rig.order.some((n) => rig.parts[n].variants.includes(s)))) throw new Error(`variant: no set or part variant "${s}" (variant_sets: ${Object.keys(rig.variantSets || {}).join(', ') || 'none'}; part variants: ${[...new Set(rig.order.flatMap((n) => rig.parts[n].variants.slice(1)))].join(', ') || 'none'})`);
  }
  if (a.carry !== undefined || a.attach !== undefined) {
    if (!rig.weapon) throw new Error('carry / attach need a rig weapon (art_rig update {weapon:{class:"rifle"}})');
    if (a.carry !== undefined) { const st = typeof a.carry === 'string' ? a.carry : a.carry?.state; if (!rig.weapon.states[st]) throw new Error(`carry: unknown state "${st}" (states: ${Object.keys(rig.weapon.states).join(', ')})`); }
    if (a.attach !== undefined) {
      const list = [].concat(a.attach || []);
      for (const n of list) if (!rig.weapon.attachments[n]) throw new Error(`attach: unknown attachment "${n}" (attachments: ${Object.keys(rig.weapon.attachments).join(', ') || 'none'})`);
      rig.weapon.attach = list;
    }
  }
  // ik_from: per-frame IK targets from another canvas's anchors (a pre-rendered gun clip's
  // socket_grip_r / socket_grip_l), same frame count and timing as that animation
  const follow = a.ik_from ? ikFromAnchors(engine, rig, a.ik_from, view) : null;
  if (follow) {
    a = { ...a, frames: follow.targets.length };
    if (a.duration === undefined && a.fps === undefined) a.duration = follow.duration;
    if (a.loop === undefined) a.loop = follow.loop;
    if (!a.keys) a.keys = [{ parts: {} }];
  }
  const loop = a.loop !== false;
  // _poses: frames evaluated elsewhere (library clips with layers / additive / retargeting)
  let poses = a._poses ? a._poses.map((P) => (a.carry !== undefined ? { ...structuredClone(P), carry: a.carry } : structuredClone(P)))
    : animatePoses(rig, { keys: a.carry !== undefined && Array.isArray(a.keys) ? a.keys.map((k) => ({ ...k, carry: a.carry })) : a.keys, frames: a.frames, loop });
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
  // depth model: decide the draw order frame by frame (hysteresis: no flicker at a surface)
  if (rig.depth && a.depth !== false) poses = depthPass(rig, poses, view, { loop });
  const events = eventFrames(a.events, poses.length, loop);
  return { a, view, loop, poses, notes, follow, events };
}

/** Composite of the parts canvas without the "cells" guide layer. */
export function artComposite(d) {
  const saved = d.layers;
  d.layers = saved.filter((l) => l.name !== 'cells');
  try { return d.composite(); } finally { d.layers = saved; }
}

/** Weapon pixels visible in a frame: (full render - render without the weapon) / weapon alone. */
function weaponVisibility(rig, d, pose, view, cache, ropts) {
  const W = rig.weapon;
  const names = [W.part, ...W.attach.map((n) => W.attachments[n].part)];
  const o = { ...ropts, sampling: 'nearest8' };
  const only = renderPose(rig, d, pose, view, cache, { ...o, only: names });
  let own = 0;
  for (let i = 3; i < only.length; i += 4) if (only[i]) own++;
  if (!own) return null;
  const full = renderPose(rig, d, pose, view, cache, o), none = renderPose(rig, d, pose, view, cache, { ...o, hide: names });
  let vis = 0;
  for (let i = 0; i < full.length; i += 4) if (full[i + 3] && (full[i] !== none[i] || full[i + 1] !== none[i + 1] || full[i + 2] !== none[i + 2] || full[i + 3] !== none[i + 3])) vis++;
  return Math.round((vis / own) * 100) / 100;
}

/** Violations of one frame's weapon metrics. */
function frameIssues(m, vis, W) {
  const out = [];
  for (const [r, v] of Object.entries(m.hand_grip)) if (v > 1.5) out.push(`${r} hand ${v}px off its grip`);
  for (const [r, v] of Object.entries(m.reach)) if (v !== null && v > W.reach + 0.005) out.push(`${r} arm over-extended (${v} of its length)`);
  if (m.corrections.includes('out_of_reach') && !out.some((x) => /over-extended/.test(x))) out.push('a grip is out of reach (arm clamped at full extension)');
  for (const r of m.elbow_inverted) out.push(`${r} elbow inverted`);
  for (const r of m.elbow_raised || []) out.push(`${r} elbow raised above the shoulder (seen from behind)`);
  if (m.penetration > 1) out.push(`weapon ${m.penetration}px inside the ${m.hit}`);
  if (m.muzzle) out.push(m.muzzle);
  for (const x of m.layer || []) out.push(x);
  if (!m.hidden && !m.exempt && vis !== null && vis !== undefined && vis < (m.back ? W.min_visible_back : W.min_visible)) out.push(`weapon only ${Math.round(vis * 100)}% visible`);
  return out;
}

/** Solve + measure every frame. */
function weaponFrames(rig, d, poses, view, { cache = new Map(), visibility = true, ...ropts } = {}) {
  return poses.map((pose, frame) => {
    const m = weaponMetrics(rig, solvePose(rig, pose, view));
    const visible = visibility && !m.hidden ? weaponVisibility(rig, d, pose, view, cache, ropts) : null;
    return { frame, ...m, visible, issues: frameIssues(m, visible, rig.weapon) };
  });
}

/** constraints:"fix": re-solve violating frames with escalation (muzzle down, stronger cant / floor, flipped elbows, draw order). */
function fixFrames(rig, d, poses, view, fr) {
  const src = rig.mirror[view] || view;
  const zTop = Math.max(...rig.order.map((n) => partIn(rig, n, src).z)) + 1;
  let fixed = 0;
  const out = poses.map((P, i) => {
    const x = fr[i];
    if (!x.issues.length) return P;
    fixed++;
    const t = { fix: true, cant: 30, floor: 0.6 };
    if (x.elbow_inverted.length) t.flip_elbow = x.elbow_inverted;
    if (x.visible !== null && x.visible < (x.back ? rig.weapon.min_visible_back : rig.weapon.min_visible)) t.z = zTop;
    return { ...P, _weapon: t };
  });
  return { poses: out, fixed };
}

/** Compact weapon description for info / create. */
function weaponSummary(rig) {
  const W = rig.weapon;
  const pt = (p) => (p ? [Math.round(p.x * 10) / 10, Math.round(p.y * 10) / 10, ...(p.angle ? [p.angle] : [])] : undefined);
  return {
    part: W.part, class: W.class, kind: W.kind, hands: W.hands, carry: W.carry, states: Object.keys(W.states), base_view: W.base, cells: W.cells,
    points: Object.fromEntries(Object.entries(W.points).map(([k, p]) => [k, pt(p)])), sockets: W.sockets,
    attachments: Object.fromEntries(Object.entries(W.attachments).map(([k, x]) => [k, { part: x.part, socket: x.socket, ...(x.type ? { type: x.type } : {}), takes: Object.keys(x.over) }])), attach: W.attach,
    poses: W.poses, foreshorten: W.foreshorten, arm_length: Math.round(W.A * 10) / 10, standoff: Math.round(W.standoff * 10) / 10,
  };
}

/** One frame for layers / explain: pose:<name> | preset (+ frame index), view, carry?. */
function oneFrame(engine, rig, def, a) {
  const view = a.view || rig.views[0];
  if (a.preset) {
    const fp = framePoses(engine, rig, def, { ...a, view, animation: undefined });
    const frame = Math.max(0, Math.min(fp.poses.length - 1, Number(a.frame ?? 0) || 0));
    return { pose: fp.poses[frame], view, frame, label: `${a.preset}[${frame}]` };
  }
  const pose = a.pose !== undefined ? resolvePose(rig, { pose: a.pose, ...(a.carry !== undefined ? { carry: a.carry } : {}) }) : { ...(a.parts || {}), ...(a.carry !== undefined ? { carry: a.carry } : {}) };
  return { pose, view, frame: 0, label: a.pose ?? 'rest' };
}

/** Draw order of a solved frame with the reason for each z. */
function layerStack(rig, pose, view) {
  const sp = solvePose(rig, pose, view);
  const src = sp.src, W = rig.weapon;
  const weaponParts = W ? new Set([W.part, ...Object.values(W.attachments).map((x) => x.part)]) : new Set();
  if (W?.mag) weaponParts.add(W.mag.part);
  const order = [], hidden = [], why = {};
  rig.order.forEach((name, i) => {
    const p = partIn(rig, name, src), v = poseOf(rig, sp.VP, name);
    if (p.hidden || v.hide) {
      hidden.push(name);
      why[name] = p.hidden ? `hidden in view ${src}` : weaponParts.has(name) && sp.weapon?.s?.pl?.hidden >= 0.5 ? 'the carry state hides the weapon' : rig.parts[name].hide && sp.P?.[name]?.hide === undefined ? 'hidden until a pose shows it (hide:true)' : 'the pose hides it';
      return;
    }
    const z = v.z ?? p.z;
    const dp = sp.depth?.[name];
    let reason = (sp.P?.[name]?.z ?? sp.P?.views?.[src]?.[name]?.z) !== undefined ? 'pose z (z keyframe)' : dp && (dp.z !== undefined || dp.split) ? `depth: ${dp.state}${dp.ref ? ` vs ${dp.ref} (${dp.depth}px)` : ''}` : v.z !== undefined && v.z !== null ? 'pose z' : rig.parts[name].views?.[src]?.z !== undefined ? `view z (${src})` : 'part z';
    if (weaponParts.has(name) && sp.weapon?.layer) reason = name === W.part ? sp.weapon.layer.reason : `rides on ${W.part}`;
    if (W && sp.weapon?.layer?.supportZ !== undefined && name === sp.weapon.s.roles.support) reason = 'support hand over a gun aimed at the camera';
    order.push({ part: name, z: Math.round(z * 100) / 100, reason, i, parent: rig.parts[name].parent || null, ...(v.split ? { split: v.split } : {}) });
  });
  order.sort((x, y) => x.z - y.z || x.i - y.i);
  return { order, hidden, why };
}

/**
 * Poses for the web UI's Layers view: tag "<preset>_<view>" (or a preset name) on an output
 * canvas = the clip's frames through the full pipeline (plant, secondary, depth, weapon); else
 * a stored pose or the rest pose. -> {view, poses, source}
 */
function uiPoses(engine, rig, def, a) {
  const allViews = [...rig.views, ...Object.keys(rig.mirror)];
  let view = a.view && allViews.includes(a.view) ? a.view : null;
  const presets = def.presets || {};
  let preset = a.preset && presets[a.preset] ? a.preset : null;
  if (!preset && a.tag) {
    if (presets[a.tag]) preset = a.tag;
    else for (const p of Object.keys(presets)) for (const v of allViews) if (a.tag === `${p}_${v}`) { preset = p; view ||= v; }
  }
  view ||= rig.views[0];
  if (preset) {
    const n = a.canvas && a.tag ? engine.docs.get(a.canvas)?.animations?.[a.tag]?.frames.length : null;
    const fp = framePoses(engine, rig, def, { preset, view, animation: undefined, ...(n ? { frames: n } : {}), ...(a.carry !== undefined ? { carry: a.carry } : {}) });
    return { view, poses: fp.poses, source: `preset ${preset}` };
  }
  if (a.tag) return { view, poses: [{}], source: `rest pose (no preset for tag "${a.tag}")` };
  return { view, poses: [a.pose !== undefined ? resolvePose(rig, { pose: a.pose }) : {}], source: a.pose !== undefined ? `pose ${a.pose}` : 'rest pose' };
}

/** One frame's stack in the UI shape (bottom first): {part, z, rule, order, hidden, why_hidden, parent}. */
function uiStack(rig, pose, view) {
  const st = layerStack(rig, pose, view);
  return [...st.order.map((e) => ({ part: e.part, z: e.z, rule: e.reason + (e.split ? ` (split at row ${e.split.cut}: ${e.split.z.join(' / ')})` : ''), order: e.i, hidden: false, parent: e.parent })),
    ...st.hidden.map((n) => ({ part: n, z: partIn(rig, n, rig.mirror[view] || view).z, rule: 'not drawn', order: rig.order.indexOf(n), hidden: true, why_hidden: st.why[n], parent: rig.parts[n].parent || null }))];
}

/** Row under the feet in the rest pose (the plant contact row + 1), or null for rigs without feet. */
export function feetGround(rig, view) {
  if (!rig.feet?.length) return null;
  const src = rig.mirror[view] || view;
  const W = solvePose(rig, {}, view).world;
  return Math.round(Math.max(...rig.feet.map((f) => W[f].y + partIn(rig, f, src).h - 1 - partIn(rig, f, src).pivot[1]))) + 1;
}
