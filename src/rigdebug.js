// Layer stack + debug render data for the web UI's Layers view (rigs and their clips).
// Uses the engine's rig_layers / rig_debug_render ops when they exist; until then it derives the
// same information from the rig definition: per frame and view, the parts in draw order with their
// z, the rule that placed them (part z, per-view z override, declaration order) and visibility,
// plus one RGBA layer per part so the UI can tint, solo and hit-test them.
import { normalizeRig, viewPose, resolvePose, animatePoses, renderPose } from './rig.js';
import { encodePNG } from './png.js';
import { OP_NAMES } from './engine.js';

function rigOf(engine, name) {
  const d = engine.docs.get(`${name}_parts`);
  if (!d?.meta?.rig || typeof d.meta.rig !== 'object') throw new Error(`No rig "${name}"`);
  return { d, def: d.meta.rig, rig: normalizeRig(d.meta.rig) };
}

/** Which poses a request covers: a clip on an output canvas (preset keys), a stored pose, or rest. */
function posesFor(engine, rig, def, { canvas, tag, pose, view }) {
  const allViews = [...rig.views, ...Object.keys(rig.mirror)];
  let v = view && allViews.includes(view) ? view : null;
  if (tag) {
    const presets = def.presets || {};
    let preset = presets[tag] ? tag : null;
    if (!preset) for (const p of Object.keys(presets)) for (const vv of allViews) if (tag === `${p}_${vv}`) { preset = p; v ||= vv; }
    if (preset && !v) v = presets[preset].view || rig.views[0];
    const out = canvas ? engine.docs.get(canvas) : null;
    const n = out?.animations?.[tag]?.frames.length;
    if (preset) {
      const pr = presets[preset];
      try {
        const poses = animatePoses(rig, { keys: pr.keys, frames: n || pr.frames, loop: pr.loop !== false });
        return { view: v || rig.views[0], poses, source: `preset ${preset}` };
      } catch { /* fall through */ }
    }
    return { view: v || rig.views[0], poses: Array(n || 1).fill({}), source: 'rest pose (clip keys unknown: z order is the rig default)' };
  }
  return { view: v || rig.views[0], poses: [pose ? resolvePose(rig, { pose }) : {}], source: pose ? `pose ${pose}` : 'rest pose' };
}

/** Parts of one pose in one view, bottom to top, with the rule that placed each. */
function stackOf(rig, pose, view) {
  const src = rig.mirror[view] || view;
  const VP = viewPose(rig, pose, src);
  return rig.order.map((name, i) => {
    const p = rig.parts[name], o = p.views?.[src] || {};
    const z = Number(o.z ?? p.z ?? 0);
    const rule = o.z !== undefined ? `views.${src}.z = ${o.z}` : p.z ? `z = ${p.z}` : 'z 0';
    const hidden = !!o.hidden || !!VP[name]?.hide;
    return { part: name, z, rule, order: i, hidden, why_hidden: o.hidden ? `hidden in view ${src}` : VP[name]?.hide ? 'pose hides it' : undefined, parent: p.parent || null };
  }).sort((a, b) => a.z - b.z || a.order - b.order).map((e, rank, arr) => {
    const tie = arr.some((x) => x !== e && x.z === e.z);
    return { ...e, rank, rule: tie ? `${e.rule}, tie -> declaration order #${e.order}` : e.rule };
  });
}

/** {view, source, parts, frames:[{frame, stack:[...]}]} for the Layers view. */
export function rigLayers(engine, name, q = {}) {
  if (hasOp('rig_layers')) {
    // only when the op answers in this endpoint's shape (per-frame stacks); art_rig layers (0.7) reports one frame's draw order
    try { const r = engine.peek('rig_layers', { name, ...q }); if (Array.isArray(r?.frames) && r.frames.every((f) => Array.isArray(f?.stack))) return { ...r, source: 'rig_layers' }; } catch { /* use the fallback */ }
  }
  const { def, rig } = rigOf(engine, name);
  const { view, poses, source } = posesFor(engine, rig, def, q);
  const frames = poses.map((P, i) => ({ frame: i, stack: stackOf(rig, P, view) }));
  return { rig: name, view, views: [...rig.views, ...Object.keys(rig.mirror)], source: `derived (${source})`, parts: rig.order, frames };
}

/** One frame as per-part layers (atlas PNG, one frame-sized cell per part in draw order). */
export function rigDebugRender(engine, name, q = {}) {
  if (hasOp('rig_debug_render')) {
    try { const r = engine.peek('rig_debug_render', { name, ...q }); if (Array.isArray(r?.stack) && typeof r?.atlas === 'string') return { ...r, source: 'rig_debug_render' }; } catch { /* fallback */ }
  }
  const { d, def, rig } = rigOf(engine, name);
  const { view, poses, source } = posesFor(engine, rig, def, q);
  const fi = Math.max(0, Math.min(poses.length - 1, Number(q.frame || 0)));
  const pose = poses[fi];
  const stack = stackOf(rig, pose, view);
  const [FW, FH] = rig.frame;
  const cache = new Map();
  const shown = stack.filter((s) => !s.hidden);
  const atlas = new Uint8ClampedArray(FW * FH * shown.length * 4 || 4);
  shown.forEach((s, i) => atlas.set(renderPose(rig, d, pose, view, cache, { only: [s.part] }), i * FW * FH * 4));
  return {
    rig: name, view, frame: fi, size: [FW, FH], source: `derived (${source})`,
    stack, atlas_parts: shown.map((s) => s.part), atlas: encodePNG(FW, Math.max(1, FH * shown.length), shown.length ? atlas : new Uint8ClampedArray(FW * FH * 4)).toString('base64'),
  };
}

/** The rig agent's layer ops, once merged, take over from the derived data. */
const hasOp = (op) => OP_NAMES.includes(op);
