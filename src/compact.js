// Compact tool replies for agents (MCP): art_info and art_rig info / create / update return a
// summary by default; full:true returns the complete reply, fields:[..] picks complete fields.
// The engine ops (and the web UI) keep their full replies.

const MAX_INLINE = 240; // chars of a meta value kept inline in a summary

function pick(full, fields, always) {
  const out = {};
  for (const k of always) if (full[k] !== undefined) out[k] = full[k];
  for (const f of [].concat(fields)) {
    if (typeof f !== 'string') throw new Error('fields must be a list of reply field names');
    if (full[f] === undefined) throw new Error(`fields: no field "${f}" (fields: ${Object.keys(full).join(', ')})`);
    out[f] = full[f];
  }
  return out;
}

/** Cells as {rows:{view:y}, parts:{"part[:variant]":[x, w, h]}}: cell = [x, rows[view], w, h]. */
export function compactCells(cells) {
  const views = Object.keys(cells || {});
  if (!views.length) return cells;
  const rows = {}, parts = {};
  for (const v of views) {
    const ys = new Set(Object.values(cells[v]).map((c) => c[1]));
    if (ys.size !== 1) return cells; // not a row-per-view layout: keep it as it is
    rows[v] = [...ys][0];
    for (const [k, c] of Object.entries(cells[v])) {
      const prev = parts[k];
      if (prev && (prev[0] !== c[0] || prev[1] !== c[2] || prev[2] !== c[3])) return cells;
      parts[k] = [c[0], c[2], c[3]];
    }
  }
  return { rows, parts, cell: "parts values are [x, w, h] (not y); the cell of a part in a view = [x, rows[view], w, h], a px rectangle on parts_canvas (draw the part there)" };
}

function metaSummary(meta) {
  const out = {};
  for (const [k, v] of Object.entries(meta || {})) {
    if (k === 'anchors' && v && typeof v === 'object') { out.anchors = Object.fromEntries(Object.entries(v).map(([a, fr]) => [a, `${Array.isArray(fr) ? fr.length : 0} frames`])); continue; }
    if (k === 'rig' && v && typeof v === 'object') { out.rig = typeof v === 'string' ? v : `rig definition (${Object.keys(v.parts || {}).length} parts, ${Object.keys(v.poses || {}).length} poses; art_rig info)`; continue; }
    const s = JSON.stringify(v);
    out[k] = s === undefined || s.length <= MAX_INLINE ? v : `(${s.length} chars; fields:["meta"] or full:true)`;
  }
  return out;
}

/** art_info: summary by default. */
export function compactInfo(r, a = {}) {
  if (a.full) return r;
  if (a.fields) return pick(r, a.fields, ['name', 'width', 'height']);
  return {
    name: r.name, width: r.width, height: r.height, frames: r.frames, frameHeight: r.frameHeight,
    layers: (r.layers || []).map((l) => `${l.name}${l.visible === false ? ' (hidden)' : ''}`), activeLayer: r.activeLayer,
    animations: Object.fromEntries(Object.entries(r.animations || {}).map(([k, t]) => {
      const f = t.frames || [];
      return [k, { frames: f.length, from: f[0], to: f[f.length - 1], loop: t.loop, ms: t.durations?.[0] }];
    })),
    project: r.project, meta: metaSummary(r.meta),
    // palette key names (what draw commands and grids use); the colours via fields:["palette"]
    palette: Object.keys(r.palette || {}).length ? Object.keys(r.palette) : undefined,
    inheritedPalette: Object.keys(r.inheritedPalette || {}).length ? Object.keys(r.inheritedPalette) : undefined,
    colors: r.colors ? { unique: r.colors.unique, top: (r.colors.top || []).slice(0, a.color_limit ?? 8) } : undefined,
    undo: r.undo, redo: r.redo, version: r.version, ui: r.ui,
    more: 'summary reply: full:true for everything, or fields:["palette","meta","animations","layers","colors",...]',
  };
}

/** art_rig info / create / update: summary by default. */
export function compactRig(action, r, a = {}) {
  if (a.full || !r || typeof r !== 'object') return r;
  if (a.fields) return pick(r, a.fields, ['rig']);
  const out = { ...r };
  if (out.cells) out.cells = compactCells(out.cells);
  if (action === 'info') {
    if (out.parts) out.parts = Object.fromEntries(Object.entries(out.parts).map(([n, p]) => [n, { w: p.w, h: p.h, pivot: p.pivot, ...(p.parent ? { parent: p.parent } : {}), ...(p.variants?.length ? { variants: p.variants } : {}), ...(p.bone ? { bone: true } : {}) }]));
    if (out.poses && !Array.isArray(out.poses)) out.poses = Object.keys(out.poses);
    if (out.presets) out.presets = Object.fromEntries(Object.entries(out.presets).map(([k, p]) => [k, { frames: p.frames ?? p.keys?.length, fps: p.fps, ...(p.loop === false ? { loop: false } : {}) }]));
    if (out.secondary) out.secondary = Object.keys(out.secondary);
    out.more = 'summary reply: full:true for the complete rig JSON (save as <name>_rig.json), or fields:["poses","presets","parts","cells",...]';
  } else out.more = 'summary reply (cells as rows + parts): full:true or fields:["cells"] for the per-view table';
  return out;
}
