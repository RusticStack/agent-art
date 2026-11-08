// Workspace asset index for the web UI's asset browser: canvases (layers, frames, animations),
// projects, rigs, 3D models, audio and exported files, in one light JSON (no pixel data).
import fs from 'node:fs';
import path from 'node:path';
import { modelDefs } from './modelops.js';
import { audioStore } from './audio/ops.js';

const MAX_EXPORTS = 2000;

function walkExports(root, max = MAX_EXPORTS) {
  const out = [];
  const visit = (dir, depth) => {
    if (out.length >= max || depth > 6) return;
    let list;
    try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of list) {
      if (out.length >= max) return;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) visit(p, depth + 1);
      else {
        let st;
        try { st = fs.statSync(p); } catch { continue; }
        out.push({ path: path.relative(root, p).replace(/\\/g, '/'), size: st.size, mtime: Math.round(st.mtimeMs) });
      }
    }
  };
  visit(root, 0);
  return out;
}

/** Kind of a canvas as the browser groups it. */
function canvasKind(d) {
  const m = d.meta || {};
  if (m.rig && typeof m.rig === 'object' && /_parts$/.test(d.name)) return 'rigparts';
  if (typeof m.rig === 'string') return 'rigout';
  if (m.renders) return 'render';
  if (m.ctm) return 'ctm';
  if (m.normal_map_of) return 'normal';
  return 'canvas';
}

export function assetIndex(engine) {
  const canvases = [...engine.docs.values()].sort((a, b) => a.name.localeCompare(b.name)).map((d) => ({
    name: d.name, project: d.project, width: d.width, height: d.frameHeight || d.height, frames: d.frames,
    layers: d.layers.map((l) => ({ name: l.name, visible: l.visible })), animations: Object.keys(d.animations || {}),
    version: `${d.version}-${d.updated}`, updated: d.updated, kind: canvasKind(d),
    rig: typeof d.meta?.rig === 'string' ? d.meta.rig : undefined,
    model: d.meta?.renders ? Object.values(d.meta.renders).map((r) => r?.model).find(Boolean) : undefined,
    texture: d.meta?.texture, anchors: d.meta?.anchors ? Object.keys(d.meta.anchors) : undefined,
  }));
  const rigs = [...engine.docs.values()].filter((d) => /_parts$/.test(d.name) && d.meta?.rig && typeof d.meta.rig === 'object').map((d) => {
    const name = d.name.slice(0, -6), r = d.meta.rig;
    return {
      name, canvas: d.name, project: d.project, frame: r.frame, views: r.views, mirror: Object.keys(r.mirror || {}),
      parts: Object.keys(r.parts || {}), poses: Object.keys(r.poses || {}), presets: Object.keys(r.presets || {}), template: r.template,
      outputs: [...engine.docs.values()].filter((o) => o.meta?.rig === name).map((o) => o.name),
      version: `${d.version}-${d.updated}`,
    };
  }).sort((a, b) => a.name.localeCompare(b.name));
  let models = [];
  try {
    models = [...modelDefs(engine).values()].sort((a, b) => a.name.localeCompare(b.name)).map((m) => ({
      name: m.name, project: m.project, parts: (m.parts || []).length, named: (m.parts || []).filter((p) => p?.name).map((p) => p.name),
      types: [...new Set((m.parts || []).map((p) => p?.type).filter(Boolean))], poses: Object.keys(m.poses || {}), clips: Object.keys(m.clips || {}),
      sockets: Object.keys(m.sockets || {}), template: m.template, updated: m.updated || m.created || 0,
    }));
  } catch { /* no models */ }
  let audio = [];
  try {
    audio = [...audioStore(engine).defs.values()].sort((a, b) => a.name.localeCompare(b.name)).map((a) => ({
      name: a.name, kind: a.kind, recipe: a.recipe, duration: a.stats?.duration, lufs: a.stats?.lufs, score: a.stats?.score, updated: a.updated || 0,
    }));
  } catch { /* no audio */ }
  const projects = [...engine.projects.values()].map((p) => ({ name: p.name, description: p.description, palette: Object.keys(p.palette || {}).length }));
  const groups = Object.entries(engine.graph.data.groups).map(([name, g]) => ({ name, parent: g.parent || null, note: g.note, members: engine.graph.members(name) }));
  // cleanup badges (superseded / orphan) and graph tags for the browser's multi-select
  let flags = { superseded: [], orphans: [] };
  try { const f = engine.cleanup.flags(); flags = { superseded: [...f.superseded], orphans: [...f.orphans] }; } catch { /* best effort */ }
  const tags = Object.fromEntries(Object.entries(engine.graph.data.nodes).filter(([, n]) => n.tags?.length).map(([id, n]) => [id, n.tags]));
  return { canvases, rigs, models, audio, projects, groups, exports: walkExports(engine.exportDir), home: engine.home, flags, tags };
}
