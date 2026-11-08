// Activity recorder: every engine op and every MCP tool call becomes a timeline entry for the web UI
// (timing, a short args/result summary, the assets it touched, before/after snapshots of the canvases
// and models it changed). Entries live in memory (a ring buffer); snapshots have a byte budget.
import { encodePNG } from './png.js';

/** Ops that never change the workspace: no snapshots, no version scan. */
/** Ops that are never recorded (UI / MCP plumbing). */
const SILENT = new Set(['review_hint', 'review_all']);
export const READ_ONLY = new Set([
  'review_list', 'review_get',
  'list', 'info', 'read', 'render', 'critique', 'sheet', 'filmstrip', 'commands', 'project_list', 'project_info',
  'rig_info', 'rig_preview', 'rig_templates', 'model_info', 'model_list', 'model_preview',
  'audio_list', 'audio_info', 'audio_analyze', 'audio_critique', 'audio_compare', 'audio_generate',
  'graph_query', 'graph_find', 'graph_path', 'graph_summary', 'pack_info',
]);
/** Ops that write files (exports_to edges in the asset graph). */
const EXPORTS = new Set(['export', 'export_animation', 'model_export', 'audio_export', 'pack_zip', 'pack_build']);
const MODEL_WRITES = new Set(['model_create', 'model_update', 'model_pose', 'model_animate', 'model_delete']);
const SNAP_MAX = 512; // px: larger canvases are snapshotted downsampled
const SNAP_BUDGET = 64 * 1024 * 1024;
const SNAP_COUNT = 20000; // tiny canvases: cap the number of snapshots too
const MAX_ENTRIES = 1500;
const MAX_ASSETS = 6;

const trunc = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

function short(v, n = 80) {
  if (v === null || typeof v === 'number' || typeof v === 'boolean') return v;
  if (typeof v === 'string') return trunc(v, n);
  if (Array.isArray(v)) {
    if (v.length <= 6 && v.every((x) => x === null || ['number', 'string', 'boolean'].includes(typeof x))) return trunc(JSON.stringify(v), n);
    return `[${v.length} items]`;
  }
  if (typeof v === 'object') return trunc(JSON.stringify(v), n);
  return String(v);
}

/** Tool / op arguments as a few short fields (no pixel data, no base64). */
export function summarizeArgs(args) {
  const out = {};
  for (const [k, v] of Object.entries(args || {})) {
    if (v === undefined) continue;
    if ((k === 'base64' || k === 'image') && typeof v === 'string') { out[k] = `<${v.length} chars>`; continue; }
    if (k === 'commands' && Array.isArray(v)) { out[k] = `${v.length} cmd${v.length === 1 ? '' : 's'}: ${trunc([...new Set(v.map((c) => c?.op))].join(', '), 70)}`; continue; }
    out[k] = short(v);
  }
  return out;
}

const SKIP_RESULT = new Set(['image', 'ui', 'next', 'tip', 'use', 'note', 'guide', 'cells', 'palette', 'colors', 'perception', 'report', 'layers']);
/** One line describing a result (for the timeline). */
export function summarizeResult(r) {
  if (r === null || r === undefined) return '';
  if (typeof r !== 'object') return trunc(String(r), 160);
  if (typeof r.text === 'string') return trunc(r.text.split('\n')[0], 160);
  if (typeof r.message === 'string') return trunc(r.message, 160);
  if (typeof r.summary === 'string') return trunc(r.summary, 160);
  const parts = [];
  for (const [k, v] of Object.entries(r)) {
    if (SKIP_RESULT.has(k) || v === undefined) continue;
    if (v === null || ['number', 'string', 'boolean'].includes(typeof v)) parts.push(`${k} ${typeof v === 'string' ? trunc(v, 48) : v}`);
    else if (Array.isArray(v)) parts.push(`${k}[${v.length}]`);
    else if (k === 'created' && v.name) parts.push(`created ${v.name}`);
    if (parts.length >= 6) break;
  }
  if (r.image) parts.push('image');
  return trunc(parts.join(' · '), 160);
}

/** Composite (all frames) as a PNG, downsampled to fit SNAP_MAX. */
function canvasSnapshot(d) {
  const W = d.width, H = d.height;
  let data = d.composite();
  const k = Math.max(1, Math.ceil(Math.max(W, H) / SNAP_MAX));
  let w = W, h = H;
  if (k > 1) {
    w = Math.ceil(W / k); h = Math.ceil(H / k);
    const out = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const s = (Math.min(H - 1, y * k) * W + Math.min(W - 1, x * k)) * 4;
      out.set(data.subarray(s, s + 4), (y * w + x) * 4);
    }
    data = out;
  }
  return { png: encodePNG(w, h, data), width: w, height: h, scale: k, frames: d.frames, frameHeight: d.frameHeight ? d.frameHeight / k : null, version: d.version };
}

/** Files named in an export result (file, files[], png, json, zip, ...). */
export function exportedFiles(r) {
  if (!r || typeof r !== 'object') return [];
  const out = [];
  for (const k of ['file', 'png', 'json', 'gif', 'zip', 'meta', 'ctm']) if (typeof r[k] === 'string') out.push(r[k]);
  for (const k of ['files', 'written']) if (Array.isArray(r[k])) out.push(...r[k].filter((x) => typeof x === 'string'));
  return [...new Set(out)];
}

export class Activity {
  constructor(engine) {
    this.engine = engine;
    this.entries = [];
    this.byId = new Map();
    this.calls = new Map(); // MCP call id -> tool entry
    this.snaps = new Map(); // snapshot id -> {kind, name, png?, def?, bytes}
    this.snapBytes = 0;
    this.seq = 0;
    this.snapSeq = 0;
    this.depth = 0;
  }

  push(entry) {
    this.entries.push(entry);
    this.byId.set(entry.id, entry);
    while (this.entries.length > MAX_ENTRIES) {
      const old = this.entries.shift();
      this.byId.delete(old.id);
      if (old.call) this.calls.delete(old.call);
    }
    return entry;
  }
  emit(entry) {
    this.engine.emit('event', { type: 'activity', entry: this.public(entry), ts: Date.now() });
  }
  /** Entry as sent to the UI (snapshot ids only). */
  public(e) {
    return e;
  }

  addSnap(s) {
    const id = `s${++this.snapSeq}`;
    s.id = id;
    s.bytes = (s.png?.length || 0) + (s.def ? JSON.stringify(s.def).length : 0);
    this.snaps.set(id, s);
    this.snapBytes += s.bytes;
    for (const [k, v] of this.snaps) {
      if (this.snapBytes <= SNAP_BUDGET && this.snaps.size <= SNAP_COUNT) break;
      this.snaps.delete(k);
      this.snapBytes -= v.bytes;
    }
    return id;
  }
  snapCanvas(d) {
    try { return this.addSnap({ kind: 'canvas', name: d.name, ...canvasSnapshot(d) }); } catch { return undefined; }
  }
  /** A model snapshot keeps its definition; the thumbnail is rendered when the UI asks. */
  snapModel(def) {
    try { return this.addSnap({ kind: 'model', name: def.name, def: structuredClone(def) }); } catch { return undefined; }
  }
  /** Attach a lazily rendered thumbnail to a snapshot (counted in the byte budget). */
  setSnapPng(snap, png) {
    snap.png = png;
    if (this.snaps.has(snap.id)) { snap.bytes += png.length; this.snapBytes += png.length; }
  }
  snapshot(id) {
    return this.snaps.get(id) || null;
  }

  /** Start / end of an MCP tool call (from the MCP layer, local or over /api/trace). */
  toolStart({ call, tool, args, source = 'agent' }) {
    if (!call) return null;
    const entry = this.push({ id: ++this.seq, type: 'tool', call: String(call).slice(0, 64), tool: String(tool || '?').slice(0, 64), action: args?.action, args: summarizeArgs(args), source, ts: Date.now(), running: true, ok: true, ops: [], assets: [] });
    this.calls.set(entry.call, entry);
    this.emit(entry);
    return entry;
  }
  toolEnd({ call, ok = true, error, ms, summary }) {
    const entry = this.calls.get(String(call).slice(0, 64));
    if (!entry) return null;
    entry.running = false;
    entry.ok = ok !== false;
    if (error) entry.error = trunc(String(error), 400);
    entry.ms = typeof ms === 'number' ? Math.round(ms) : Date.now() - entry.ts;
    if (summary) entry.summary = trunc(String(summary), 200);
    this.calls.delete(entry.call);
    this.emit(entry);
    return entry;
  }

  /** Assets an op names in its args (before it runs). */
  argAssets(op, a) {
    const out = [];
    const add = (kind, name) => { if (typeof name === 'string' && name && !out.some((x) => x.kind === kind && x.name === name)) out.push({ kind, name }); };
    if (op.startsWith('rig_')) { add('rig', a.name); if (a.canvas) add('canvas', a.canvas); }
    else if (op.startsWith('model_') && op !== 'model_ctm') { add('model', a.name); if (op === 'model_render') add('canvas', a.canvas); }
    else if (op.startsWith('audio_')) { if (a.name && !a.name.includes('*')) add('audio', a.name); for (const n of a.names || []) add('audio', n); }
    else if (op.startsWith('project_')) add('project', a.name ?? a.project);
    else if (op.startsWith('graph_')) add('graph', a.node || a.from || a.name || 'graph');
    else if (op.startsWith('review_')) add('review', a.id || a.asset || 'review');
    else {
      add('canvas', a.canvas);
      if (op === 'create' || op === 'import') add('canvas', a.name || a.canvas);
      if (op === 'duplicate') add('canvas', a.new_name);
    }
    return out;
  }

  /** Run an op, recording it (top-level runs only; ops run by other ops are part of their parent). */
  record(op, args, source, ctx, fn) {
    if (this.depth > 0 || SILENT.has(op)) return fn();
    const e = this.engine;
    const t0 = performance.now();
    const entry = { id: ++this.seq, type: 'op', op, source, ts: Date.now(), args: summarizeArgs(args), assets: this.argAssets(op, args || {}) };
    if (ctx?.call) entry.call = String(ctx.call);
    if (ctx?.tool) entry.tool = String(ctx.tool);
    const mutating = !READ_ONLY.has(op);
    let versions = null;
    if (mutating) {
      versions = new Map();
      for (const d of e.docs.values()) versions.set(d.name, d.version);
      for (const as of entry.assets) {
        let d = null;
        if (as.kind === 'canvas') d = e.docs.get(as.name);
        else if (as.kind === 'rig') d = e.docs.get(`${as.name}_parts`);
        if (d) as.before = this.snapCanvas(d);
        if (as.kind === 'model' && MODEL_WRITES.has(op)) {
          const def = e.models?.get(as.name);
          if (def) as.before = this.snapModel(def);
        }
      }
    }
    // the timeline is best effort: a recording failure must never fail (or mask) the op itself
    const finish = (result, err) => { try { finishEntry(result, err); } catch { /* ignore */ } };
    const finishEntry = (result, err) => {
      entry.ms = Math.round(performance.now() - t0);
      entry.ok = !err;
      if (err) entry.error = trunc(String(err.message || err), 400);
      else entry.summary = summarizeResult(result);
      if (mutating) this.afterMutation(op, args || {}, entry, versions, result);
      if (!err && EXPORTS.has(op)) {
        entry.files = exportedFiles(result).slice(0, 20);
        try { e.graph?.recordExport(op, args || {}, entry.files); } catch { /* graph is best effort */ }
      }
      this.push(entry);
      const parent = entry.call && this.calls.get(entry.call);
      if (parent) {
        parent.ops.push(entry.id);
        for (const as of entry.assets) {
          const have = parent.assets.find((x) => x.kind === as.kind && x.name === as.name);
          if (!have) { if (parent.assets.length < MAX_ASSETS * 2) parent.assets.push({ ...as }); }
          else { if (as.after) have.after = as.after; if (!have.before && as.before) have.before = as.before; }
        }
        if (err) { parent.ok = false; parent.error = entry.error; }
        this.emit(parent);
      }
      this.emit(entry);
    };
    this.depth++;
    let r;
    try {
      r = fn();
    } catch (err) {
      this.depth--;
      finish(null, err);
      throw err;
    }
    this.depth--;
    if (r && typeof r.then === 'function') {
      return r.then((v) => { finish(v); return v; }, (err) => { finish(null, err); throw err; });
    }
    finish(r);
    return r;
  }

  afterMutation(op, a, entry, versions, result) {
    const e = this.engine;
    // canvases created or changed by this op (rig animate output, model render, normal maps, ...)
    let n = 0;
    for (const d of e.docs.values()) {
      if (versions.get(d.name) === d.version && versions.has(d.name)) continue;
      if (n++ >= MAX_ASSETS) break;
      let as = entry.assets.find((x) => x.kind === 'canvas' && x.name === d.name);
      if (!as) {
        const rig = /_parts$/.test(d.name) && d.meta?.rig ? entry.assets.find((x) => x.kind === 'rig' && `${x.name}_parts` === d.name) : null;
        as = rig || { kind: 'canvas', name: d.name };
        if (!rig) entry.assets.push(as);
      }
      as.after = this.snapCanvas(d);
      if (!versions.has(d.name)) as.created = true;
    }
    for (const name of versions.keys()) if (!e.docs.has(name)) {
      const as = entry.assets.find((x) => x.kind === 'canvas' && x.name === name);
      if (as) as.deleted = true;
      else if (entry.assets.length < MAX_ASSETS * 2) entry.assets.push({ kind: 'canvas', name, deleted: true });
    }
    if (MODEL_WRITES.has(op)) {
      for (const as of entry.assets) if (as.kind === 'model') {
        const def = e.models?.get(as.name);
        if (def) as.after = this.snapModel(def);
        else as.deleted = true;
      }
    }
    if (op.startsWith('audio_') && result?.created) for (const c of [].concat(result.created)) {
      if (c?.name && !entry.assets.some((x) => x.kind === 'audio' && x.name === c.name)) entry.assets.push({ kind: 'audio', name: c.name, created: true });
    }
    if (op === 'audio_song' && a.name && !entry.assets.some((x) => x.kind === 'audio')) entry.assets.push({ kind: 'audio', name: a.name });
  }

  list({ since = 0, limit = 400 } = {}) {
    const out = since ? this.entries.filter((x) => x.id > since) : this.entries;
    return out.slice(-limit);
  }
}
