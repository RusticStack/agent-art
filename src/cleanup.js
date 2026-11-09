// Cleanup: retire superseded assets in bulk without leaving junk or breaking what still uses them.
//   plan    = dry run: what a selector picks, sizes, what depends on it, what blocks it (compact)
//   apply   = soft delete into <workspace>/trash/<batch>/ (files moved, graph edges, review notes,
//             pins and manifest entries recorded so restore puts everything back byte for byte)
//   restore = undo a batch (or single assets of it); empty = the only hard delete (confirm:true)
//   usage   = disk use by kind, project and group, biggest first; replace = record "new replaces old"
// Asset kinds plug in through assettypes.js (registerAssetType); the built-in ones are below.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Doc } from './doc.js';
import { modelDefs } from './modelops.js';
import { audioStore } from './audio/ops.js';
import { registerAssetType, assetType, assetTypes, subOwnerKind } from './assettypes.js';

const kindOf = (id) => id.slice(0, id.indexOf(':'));
const nameOf = (id) => id.slice(id.indexOf(':') + 1);
/** "needs" relations: from cannot work without to. */
export const HARD_RELS = new Set(['depends_on', 'uses_palette']);
/** Relations that never make one asset depend on another. */
const NEUTRAL_RELS = new Set(['exports_to', 'replaces', 'layer_of']);
const DEFAULT_LIMIT = 10;
const MAX_EXPORT_WALK = 20000;
const PLAN_KEEP = 30;
const EVENTS_KEEP = 200;
const WIN = process.platform === 'win32';

// ---------- built-in asset types ----------
const canvasFile = (e, name) => path.join(e.canvasDir, `${name}.json`);
const isRigParts = (d) => !!d && /_parts$/.test(d.name) && d.meta?.rig && typeof d.meta.rig === 'object';
function flushCanvas(e, name) {
  const d = e.docs.get(name);
  if (d && e.saveTimers.has(name)) e.saveNow(d);
}
function unloadCanvas(e, name, source) {
  e.docs.delete(name);
  clearTimeout(e.saveTimers.get(name));
  e.saveTimers.delete(name);
  const ev = { type: 'deleted', canvas: name, source, ts: Date.now() };
  e.pushLog(ev);
  e.emit('event', ev);
}
function reloadCanvas(e, name, source) {
  const d = Doc.fromJSON(JSON.parse(fs.readFileSync(canvasFile(e, name), 'utf8')));
  e.attach(d);
  // no engine.changed(): that would touch + re-save the file (restore must stay byte identical)
  const ev = { type: 'change', canvas: d.name, project: d.project, version: d.version, op: 'restore', source, label: 'restored from trash', structural: true, ts: Date.now() };
  e.pushLog(ev);
  e.emit('event', ev);
}
const modelFile = (e, name) => path.join(e.home, 'models', `${name}.json`);
const audioFiles = (e, name) => { const s = audioStore(e); return [path.join(s.d.root, `${name}.json`), path.join(s.d.cache, `${name}.wav`), path.join(s.d.cache, `${name}.meta.json`), path.join(s.d.root, 'voices', `${name}.wav`)]; }; // + an ElevenLabs voice take

registerAssetType('canvas', {
  builtin: true, sub: ['layer', 'anim', 'frame'],
  list: (e) => [...e.docs.values()].filter((d) => !isRigParts(d)).map((d) => d.name),
  exists: (e, n) => e.docs.has(n),
  info: (e, n) => { const d = e.docs.get(n); return d ? { project: d.project, updated: d.updated, created: d.created } : {}; },
  files: (e, n) => [canvasFile(e, n)],
  estimate: (e, n) => { const d = e.docs.get(n); return d ? JSON.stringify(d.toJSON()).length : 0; },
  flush: flushCanvas, unload: unloadCanvas, reload: reloadCanvas,
});
registerAssetType('rig', {
  builtin: true, sub: ['rigpart'],
  list: (e) => [...e.docs.values()].filter(isRigParts).map((d) => d.name.slice(0, -6)),
  exists: (e, n) => isRigParts(e.docs.get(`${n}_parts`)),
  info: (e, n) => { const d = e.docs.get(`${n}_parts`); return d ? { project: d.project, updated: d.updated } : {}; },
  files: (e, n) => [canvasFile(e, `${n}_parts`)],
  estimate: (e, n) => { const d = e.docs.get(`${n}_parts`); return d ? JSON.stringify(d.toJSON()).length : 0; },
  flush: (e, n) => flushCanvas(e, `${n}_parts`),
  unload: (e, n, s) => unloadCanvas(e, `${n}_parts`, s),
  reload: (e, n, s) => reloadCanvas(e, `${n}_parts`, s),
});
registerAssetType('model', {
  builtin: true, sub: ['modelpart'],
  list: (e) => [...modelDefs(e).keys()],
  exists: (e, n) => modelDefs(e).has(n),
  info: (e, n) => { const m = modelDefs(e).get(n); return m ? { project: m.project, updated: m.updated || m.created } : {}; },
  files: (e, n) => [modelFile(e, n), modelFile(e, n).replace(/\.json$/, '.mesh.bin')].filter((f, i) => i === 0 || fs.existsSync(f)), // + art_model boolean / remesh / decimate baked mesh
  unload: (e, n, source) => { modelDefs(e).delete(n); e.emit('event', { type: 'model', model: n, deleted: true, source, ts: Date.now() }); },
  reload: (e, n, source) => { const m = JSON.parse(fs.readFileSync(modelFile(e, n), 'utf8')); modelDefs(e).set(m.name, m); e.emit('event', { type: 'model', model: m.name, source, label: 'restored from trash', ts: Date.now() }); },
});
registerAssetType('audio', {
  builtin: true,
  list: (e) => [...audioStore(e).defs.keys()],
  exists: (e, n) => audioStore(e).defs.has(n),
  info: (e, n) => { const a = audioStore(e).defs.get(n); return a ? { project: a.project, updated: a.updated || a.created } : {}; },
  files: audioFiles,
  unload: (e, n, source) => { const s = audioStore(e); s.defs.delete(n); s.mem.delete(n); e.emit('event', { type: 'audio', name: n, deleted: true, source, ts: Date.now() }); },
  reload: (e, n, source) => { const a = JSON.parse(fs.readFileSync(audioFiles(e, n)[0], 'utf8')); audioStore(e).defs.set(a.name, a); e.emit('event', { type: 'audio', name: a.name, source, ts: Date.now() }); },
});
registerAssetType('project', {
  builtin: true, container: true,
  list: (e) => [...e.projects.keys()],
  exists: (e, n) => e.projects.has(n),
  info: (e, n) => { const p = e.projects.get(n); return p ? { updated: p.updated || p.created } : {}; },
  files: (e, n) => [path.join(e.projectDir, `${n}.json`)],
  unload: (e, n, source) => { e.projects.delete(n); e.emit('event', { type: 'project', project: n, deleted: true, source, ts: Date.now() }); },
  reload: (e, n, source) => { const p = JSON.parse(fs.readFileSync(path.join(e.projectDir, `${n}.json`), 'utf8')); e.projects.set(p.name, p); e.emit('event', { type: 'project', project: p.name, source, label: 'restored from trash', ts: Date.now() }); },
});
registerAssetType('export', {
  builtin: true,
  list: (e) => walkFiles(e.exportDir).map((f) => f.rel),
  exists: (e, n) => fs.existsSync(exportAbs(e, n)),
  info: (e, n) => { try { return { updated: Math.round(fs.statSync(exportAbs(e, n)).mtimeMs) }; } catch { return {}; } },
  files: (e, n) => [exportAbs(e, n)],
  unload: () => {}, reload: () => {},
});

// ---------- helpers ----------
function exportAbs(e, rel) { return path.isAbsolute(rel) ? path.resolve(rel) : path.resolve(e.exportDir, rel); }
function walkFiles(root, max = MAX_EXPORT_WALK) {
  const out = [];
  const visit = (dir, depth) => {
    if (out.length >= max || depth > 12) return;
    let list;
    try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const d of list) {
      if (out.length >= max) return;
      const p = path.join(dir, d.name);
      if (d.isDirectory()) visit(p, depth + 1);
      else if (d.isFile()) out.push({ abs: p, rel: path.relative(root, p).replace(/\\/g, '/') });
    }
  };
  visit(root, 0);
  return out;
}
const norm = (p) => (WIN ? path.resolve(p).toLowerCase() : path.resolve(p));
function inside(p, root) {
  const rel = path.relative(norm(root), norm(p));
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}
const realOr = (p) => { try { return fs.realpathSync.native(p); } catch { return null; } };
const fileSize = (f) => { try { return fs.statSync(f).size; } catch { return 0; } };
const sha1 = (buf) => crypto.createHash('sha1').update(buf).digest('hex');
export const fmtBytes = (n) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : n < 1024 ** 3 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${(n / 1024 ** 3).toFixed(2)} GB`);
const rid = (p) => `${p}${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}`;

/** "30d" | "12h" | "45m" | "2w" | number (days) | ISO date -> a timestamp (ms) in the past. */
export function parseAge(v, now = Date.now()) {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v === 'number') return now - v * 86400000;
  const m = String(v).trim().match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d|w|y)?$/i);
  if (m) return now - Number(m[1]) * { ms: 1, s: 1e3, m: 6e4, h: 3.6e6, d: 8.64e7, w: 6.048e8, y: 3.1536e10 }[(m[2] || 'd').toLowerCase()];
  const t = Date.parse(v);
  if (!Number.isNaN(t)) return t;
  throw new Error(`age "${v}" must be like "30d", "12h", "2w", a number of days or an ISO date`);
}
/** Glob -> RegExp: * = anything but "/", ** = anything, ? = one char. Case-insensitive. */
export function globRe(g) {
  let s = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') { if (g[i + 1] === '*') { s += '.*'; i++; } else s += '[^/]*'; }
    else if (c === '?') s += '[^/]';
    else s += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${s}$`, 'i');
}
const arr = (v) => (v === undefined || v === null ? [] : [].concat(v));

// ---------- workspace config + UI state ----------
const configFile = (e) => path.join(e.home, 'config.json');
export function readConfig(e) { try { return JSON.parse(fs.readFileSync(configFile(e), 'utf8')) || {}; } catch { return {}; } }
function writeConfig(e, c) { fs.writeFileSync(configFile(e) + '.tmp', JSON.stringify(c, null, 2)); fs.renameSync(configFile(e) + '.tmp', configFile(e)); }
const uiFile = (e) => path.join(e.home, 'ui-state.json');
function readUi(e) { try { const s = JSON.parse(fs.readFileSync(uiFile(e), 'utf8')); return { hidden: s.hidden || [], pinned: s.pinned || [], updated: s.updated }; } catch { return { hidden: [], pinned: [] }; } }
function writeUi(e, s) {
  fs.writeFileSync(uiFile(e) + '.tmp', JSON.stringify({ hidden: s.hidden, pinned: s.pinned, updated: Date.now() }));
  fs.renameSync(uiFile(e) + '.tmp', uiFile(e));
  e.emit('event', { type: 'ui-state', ts: Date.now() });
}

// ---------- the cleanup service ----------
export class Cleanup {
  constructor(engine) {
    this.e = engine;
    this.trashDir = path.join(engine.home, 'trash');
    this.plans = new Map();
    try { for (const p of JSON.parse(fs.readFileSync(path.join(this.trashDir, 'plans.json'), 'utf8'))) this.plans.set(p.id, p); } catch { /* none yet */ }
  }
  get graph() { return this.e.graph; }

  // ----- ids -----
  /** canvas:x_parts (a rig's parts canvas) -> rig:x; everything else unchanged. */
  canon(id) {
    if (kindOf(id) === 'canvas' && isRigParts(this.e.docs.get(nameOf(id)))) return `rig:${nameOf(id).slice(0, -6)}`;
    return id;
  }
  /** The removable asset an id belongs to (layer:c/l -> canvas:c, palette:p -> project:p), or null. */
  assetOf(id) {
    const k = kindOf(id), n = nameOf(id);
    if (k === 'palette') return this.e.projects.has(n) ? `project:${n}` : this.e.docs.has(n) ? this.canon(`canvas:${n}`) : null;
    const owner = subOwnerKind(k);
    if (owner && n.includes('/')) return this.canon(`${owner}:${n.slice(0, n.indexOf('/'))}`);
    const t = assetType(k);
    if (!t || t.removable === false) return null;
    return this.canon(id);
  }
  exists(id) {
    const t = assetType(kindOf(id));
    if (!t) return false;
    try { return t.exists ? !!t.exists(this.e, nameOf(id)) : [...t.list(this.e)].includes(nameOf(id)); } catch { return false; }
  }
  info(id) { try { return assetType(kindOf(id))?.info?.(this.e, nameOf(id)) || {}; } catch { return {}; } }
  /** Every removable asset id (exports only when asked: they are files, not assets). */
  allAssets({ exports = false } = {}) {
    const out = [];
    for (const t of assetTypes()) {
      if (t.removable === false || (t.kind === 'export' && !exports)) continue;
      try { for (const n of t.list(this.e)) out.push(`${t.kind}:${n}`); } catch { /* broken plug-in */ }
    }
    if (exports) {
      // exports recorded outside the workspace exports folder (a game folder) are files too
      for (const ed of this.graph.data.edges) if (ed.rel === 'exports_to' && path.isAbsolute(nameOf(ed.to)) && fs.existsSync(nameOf(ed.to)) && !out.includes(ed.to)) out.push(ed.to);
    }
    return out;
  }
  files(id) {
    const t = assetType(kindOf(id));
    try { return (t?.files?.(this.e, nameOf(id)) || []).filter((f) => fs.existsSync(f)); } catch { return []; }
  }
  bytes(id) {
    const fl = this.files(id);
    if (fl.length) return fl.reduce((s, f) => s + fileSize(f), 0);
    try { return assetType(kindOf(id))?.estimate?.(this.e, nameOf(id)) || 0; } catch { return 0; }
  }

  // ----- dependencies -----
  /** {hard: Map<asset, Set<dependent>>, soft: Map<asset, [{from, rel}]>} over every edge. */
  deps() {
    const hard = new Map(), soft = new Map();
    const push = (m, k, v) => { if (!m.has(k)) m.set(k, []); m.get(k).push(v); };
    for (const ed of this.graph.all().edges) {
      if (NEUTRAL_RELS.has(ed.rel)) continue;
      const f = this.assetOf(ed.from), t = this.assetOf(ed.to);
      if (!f || !t || f === t) continue;
      const isHard = HARD_RELS.has(ed.rel) || (ed.rel === 'part_of' && assetType(kindOf(t))?.container);
      if (ed.rel === 'part_of' && !isHard) continue; // membership of a non-container
      push(isHard ? hard : soft, t, { from: f, rel: ed.rel });
    }
    return { hard, soft };
  }
  pinned() { return new Set(readUi(this.e).pinned); }
  approved(id) {
    const n = this.graph.data.nodes;
    if (n[id]?.approved) return true;
    if (kindOf(id) === 'rig' && n[`canvas:${nameOf(id)}_parts`]?.approved) return true;
    return false;
  }
  isPinned(id, pins) { return pins.has(id) || (kindOf(id) === 'rig' && pins.has(`canvas:${nameOf(id)}_parts`)); }

  /** superseded (replaced side of "replaces" edges, or marked) and orphan ids, for selectors and badges. */
  flags() {
    const superseded = new Set();
    for (const ed of this.graph.all().edges) if (ed.rel === 'replaces') { const t = this.assetOf(ed.to) || ed.to; superseded.add(t); if (kindOf(t) === 'rig') superseded.add(`canvas:${nameOf(t)}_parts`); }
    for (const [id, n] of Object.entries(this.graph.data.nodes)) if (n.superseded) superseded.add(id);
    const orphans = new Set();
    const pins = this.pinned();
    const inbound = new Set(), member = new Set();
    for (const ed of this.graph.all().edges) {
      const f = this.assetOf(ed.from) || ed.from, t = this.assetOf(ed.to) || ed.to;
      if (f === t) continue;
      inbound.add(t);
      if (ed.rel === 'part_of') member.add(f);
    }
    for (const id of this.allAssets()) {
      if (inbound.has(id) || member.has(id) || this.isPinned(id, pins)) continue;
      const p = this.info(id).project;
      if (p) continue;
      orphans.add(id);
      if (kindOf(id) === 'rig') orphans.add(`canvas:${nameOf(id)}_parts`);
    }
    return { superseded, orphans };
  }

  // ----- export file safety -----
  allowRoots() {
    const roots = [this.e.exportDir];
    for (const p of arr(readConfig(this.e).cleanup?.allow_paths)) if (typeof p === 'string' && p) roots.push(path.resolve(this.e.home, p));
    return roots;
  }
  /** null when an export file may be moved to the trash, else why not. */
  refusePath(abs) {
    let st;
    try { st = fs.lstatSync(abs); } catch { return 'missing'; }
    if (st.isSymbolicLink()) return 'symlink';
    if (!st.isFile()) return 'not a file';
    const real = realOr(abs);
    if (!real) return 'unresolvable';
    const home = realOr(this.e.home) || this.e.home, exp = realOr(this.e.exportDir) || this.e.exportDir;
    if (inside(real, home) && !inside(real, exp)) return 'workspace internals (only workspace/exports is allowed)';
    for (const r of this.allowRoots()) {
      const rr = realOr(r);
      if (rr && inside(abs, r) && inside(real, rr)) return null;
    }
    return 'outside the workspace exports folder and cleanup.allow_paths';
  }

  // ----- selection -----
  /** Resolve a select object (or array of them = union) to asset ids. */
  select(sel) {
    if (Array.isArray(sel)) { const out = new Set(); const unknown = []; for (const s of sel) { const r = this.select(s); r.ids.forEach((x) => out.add(x)); unknown.push(...r.unknown); } return { ids: [...out], unknown }; }
    if (!sel || typeof sel !== 'object') throw new Error('select must be an object like {names:["marine_*"]}, {superseded:true}, {orphans:true}, {stale_exports:true} or {ids:[...]}');
    const KEYS = ['ids', 'names', 'kind', 'type', 'tag', 'group', 'project', 'rel', 'superseded', 'orphans', 'stale_exports', 'older_than', 'unused_since', 'exclude'];
    const bad = Object.keys(sel).filter((k) => !KEYS.includes(k));
    if (bad.length) throw new Error(`unknown selector ${bad.join(', ')} (use ${KEYS.join(', ')})`);
    if (!KEYS.some((k) => k !== 'exclude' && sel[k] !== undefined && sel[k] !== false)) throw new Error('select needs at least one selector (names, ids, kind, tag, group, project, rel, superseded, orphans, stale_exports, older_than, unused_since)');
    const kinds = arr(sel.kind ?? sel.type);
    for (const k of kinds) if (!assetType(k)) throw new Error(`unknown kind "${k}" (${assetTypes().map((t) => t.kind).join(', ')})`);
    const unknown = [];
    const explicit = new Set();
    for (const r of arr(sel.ids)) {
      let id;
      try { id = this.graph.resolveLoose(r); } catch { id = String(r).includes(':') ? String(r) : null; }
      const a = id && (kindOf(id) === 'export' ? `export:${this.graph.exportRel(nameOf(id))}` : this.assetOf(id));
      if (a && this.exists(a)) explicit.add(a); else unknown.push(String(r));
    }
    const wantExports = kinds.includes('export') || !!sel.stale_exports || [...explicit].some((x) => kindOf(x) === 'export');
    // explicitly named export paths always reach the path checks (traversal, links, outside files)
    let ids = [...new Set([...this.allAssets({ exports: wantExports }), ...[...explicit].filter((x) => kindOf(x) === 'export')])];
    const filter = (fn) => { ids = ids.filter(fn); };
    if (sel.ids !== undefined) filter((id) => explicit.has(id));
    if (kinds.length) filter((id) => kinds.includes(kindOf(id)));
    if (sel.names !== undefined) {
      const res = arr(sel.names).map((g) => globRe(String(g)));
      filter((id) => res.some((re) => re.test(nameOf(id)) || re.test(id)));
    }
    if (sel.exclude !== undefined) {
      const res = arr(sel.exclude).map((g) => globRe(String(g)));
      filter((id) => !res.some((re) => re.test(nameOf(id)) || re.test(id)));
    }
    if (sel.tag !== undefined) {
      const tags = arr(sel.tag);
      const n = this.graph.data.nodes;
      filter((id) => [id, kindOf(id) === 'rig' ? `canvas:${nameOf(id)}_parts` : null].some((x) => x && (n[x]?.tags || []).some((t) => tags.includes(t))));
    }
    if (sel.group !== undefined) {
      const mem = new Set();
      const walk = (g, seen) => {
        if (seen.has(g)) return;
        seen.add(g);
        if (!this.graph.data.groups[g]) throw new Error(`no group "${g}"`);
        for (const m of this.graph.members(g)) { if (kindOf(m) === 'group') walk(nameOf(m), seen); else { const a = this.assetOf(m); if (a) mem.add(a); } }
      };
      for (const g of arr(sel.group)) walk(String(g), new Set());
      filter((id) => mem.has(id));
    }
    if (sel.project !== undefined) {
      const ps = arr(sel.project);
      for (const p of ps) if (!this.e.projects.has(p)) throw new Error(`no project "${p}"`);
      filter((id) => ps.includes(this.info(id).project));
    }
    for (const r of arr(sel.rel)) {
      if (!r || typeof r !== 'object' || !r.rel || (!r.to && !r.from)) throw new Error('rel selector is {rel:"rendered_from", to:"model:x"} (assets with that edge to x) or {rel, from} (targets of x\'s edges)');
      const hits = new Set();
      const end = this.graph.resolveLoose(r.to ?? r.from);
      const endAsset = this.assetOf(end) || end;
      for (const ed of this.graph.all().edges) {
        if (ed.rel !== r.rel) continue;
        if (r.to !== undefined && (ed.to === end || this.assetOf(ed.to) === endAsset)) { const a = this.assetOf(ed.from); if (a && a !== endAsset) hits.add(a); }
        if (r.from !== undefined && (ed.from === end || this.assetOf(ed.from) === endAsset)) { const a = kindOf(ed.to) === 'export' ? ed.to : this.assetOf(ed.to); if (a && a !== endAsset) hits.add(a); }
      }
      filter((id) => hits.has(id));
    }
    if (sel.superseded) { const f = this.flags().superseded; filter((id) => f.has(id)); }
    if (sel.orphans) { const f = this.flags().orphans; filter((id) => f.has(id)); }
    if (sel.stale_exports) {
      const stale = new Set();
      for (const ed of this.graph.data.edges) {
        if (ed.rel !== 'exports_to') continue;
        const src = this.assetOf(ed.from) || ed.from;
        if (!this.graph.exists(src) && this.exists(ed.to)) stale.add(ed.to);
      }
      filter((id) => stale.has(id));
    }
    if (sel.older_than !== undefined) { const t = parseAge(sel.older_than); filter((id) => (this.info(id).updated ?? Infinity) < t); }
    if (sel.unused_since !== undefined) { const t = parseAge(sel.unused_since); filter((id) => this.lastUse(id) < t); }
    return { ids: [...new Set(ids)].sort(), unknown };
  }
  /** Latest of: last edit, a recorded export or relation, review activity. */
  lastUse(id) {
    let t = this.info(id).updated || 0;
    for (const ed of this.graph.data.edges) if (ed.ts && (this.assetOf(ed.from) === id || this.assetOf(ed.to) === id)) t = Math.max(t, ed.ts);
    for (const r of this.graph.data.reviews || []) if (this.assetOf(r.asset) === id) t = Math.max(t, r.updated || 0);
    return t || 0;
  }

  // ----- plan -----
  /** Build a plan (pure: nothing is changed). */
  build(a = {}) {
    if (!a.select && !a.ids) throw new Error('plan needs select (e.g. {names:["marine_*"]}, {superseded:true}, {orphans:true}, {stale_exports:true}) or ids');
    const { ids: picked, unknown } = this.select(a.select ?? { ids: a.ids });
    const set = new Map(); // id -> reason
    for (const id of picked) set.set(id, 'selected');
    const { hard, soft } = this.deps();
    const cascade = a.include_dependents === 'all' ? 'all' : !!a.include_dependents;
    // cascade: dependents of removed assets go too (hard ones, or all with include_dependents:"all")
    if (cascade) {
      const queue = [...set.keys()];
      while (queue.length) {
        const id = queue.shift();
        const list = [...(hard.get(id) || []), ...(cascade === 'all' ? soft.get(id) || [] : [])];
        for (const d of list) if (!set.has(d.from)) { set.set(d.from, `${d.rel} ${id}`); queue.push(d.from); }
      }
    }
    // exports of removed assets
    const refused = [];
    const sharedKept = [];
    if (a.include_exports) {
      // a file several assets export (a shared manifest, a batch folder) stays while one of them stays
      const exporters = new Map();
      for (const ed of this.graph.data.edges) {
        if (ed.rel !== 'exports_to') continue;
        if (!exporters.has(ed.to)) exporters.set(ed.to, new Set());
        exporters.get(ed.to).add(this.assetOf(ed.from) || ed.from);
      }
      for (const [to, srcs] of exporters) {
        const going = [...srcs].filter((s) => set.has(s));
        if (!going.length || set.has(to) || !this.exists(to)) continue;
        const staying = [...srcs].filter((s) => !set.has(s) && this.graph.exists(s));
        if (staying.length) { sharedKept.push(`${to} kept: also exported by ${staying.slice(0, 2).join(', ')}`); continue; }
        set.set(to, `exported by ${going[0]}`);
      }
    }
    for (const id of [...set.keys()]) if (kindOf(id) === 'export') {
      const why = this.refusePath(exportAbs(this.e, nameOf(id)));
      if (why) { refused.push({ path: nameOf(id), why }); set.delete(id); }
    }
    const blocked = [], warnings = [...sharedKept], pins = this.pinned();
    for (const id of set.keys()) {
      const needers = [];
      for (const d of hard.get(id) || []) {
        if (set.has(d.from)) continue;
        const have = needers.find((x) => x.from === d.from);
        if (have) { if (!have.rels.includes(d.rel)) have.rels.push(d.rel); } else needers.push({ from: d.from, rels: [d.rel] });
      }
      if (needers.length && !a.force) blocked.push({ id, why: 'needed', by: needers.map((d) => `${d.from} (${d.rels.join(', ')})`) });
      else if (needers.length) warnings.push(`forced: ${id} is still needed by ${needers.slice(0, 3).map((d) => d.from).join(', ')}${needers.length > 3 ? ` +${needers.length - 3}` : ''}`);
      if (this.approved(id) && !a.allow_approved) blocked.push({ id, why: 'approved', by: ['approved in review (allow_approved:true)'] });
      if (this.isPinned(id, pins)) warnings.push(`pinned: ${id}`);
      const users = (soft.get(id) || []).filter((d) => !set.has(d.from));
      if (users.length) warnings.push(`${id} <- ${users.slice(0, 3).map((d) => `${d.rel} ${d.from}`).join(', ')}${users.length > 3 ? ` +${users.length - 3}` : ''} (kept)`);
    }
    const items = [...set.entries()].map(([id, reason]) => ({ id, bytes: this.bytes(id), ...(reason !== 'selected' ? { reason } : {}) })).sort((x, y) => y.bytes - x.bytes || x.id.localeCompare(y.id));
    let manifest;
    if (a.prune_manifest) manifest = this.manifestPlan(a.prune_manifest, items);
    return { items, blocked, warnings, refused, unknown, manifest };
  }
  plan(a = {}) {
    const b = this.build(a);
    const id = rid('p');
    const opts = pick(a, ['include_exports', 'include_dependents', 'force', 'allow_approved', 'prune_manifest']);
    this.plans.set(id, { id, ts: Date.now(), ids: b.items.map((x) => x.id), opts });
    this.savePlans();
    return this.report(b, a, id);
  }
  savePlans() {
    const list = [...this.plans.values()].sort((x, y) => y.ts - x.ts).slice(0, PLAN_KEEP);
    this.plans = new Map(list.map((p) => [p.id, p]));
    fs.mkdirSync(this.trashDir, { recursive: true });
    fs.writeFileSync(path.join(this.trashDir, 'plans.json'), JSON.stringify(list));
  }
  /** Compact dry-run report: counts + first N (full:true = everything). */
  report(b, a, planId) {
    const n = a.full ? Infinity : Math.max(1, Math.min(200, a.limit ?? DEFAULT_LIMIT));
    const byKind = {};
    let bytes = 0;
    for (const it of b.items) { byKind[kindOf(it.id)] = (byKind[kindOf(it.id)] || 0) + 1; bytes += it.bytes; }
    const out = { plan_id: planId, remove: { count: b.items.length, bytes, size: fmtBytes(bytes), by_kind: byKind } };
    out.items = a.full ? b.items : b.items.slice(0, n).map((x) => `${x.id} ${fmtBytes(x.bytes)}${x.reason ? ` (${x.reason})` : ''}`);
    if (b.items.length > n) out.more = b.items.length - n;
    if (b.blocked.length) {
      out.blocked = b.blocked.slice(0, n).map((x) => (a.full ? x : `${x.id}: ${x.why === 'approved' ? 'approved in review' : `needed by ${x.by.slice(0, 3).join(', ')}${x.by.length > 3 ? ` +${x.by.length - 3}` : ''}`}`));
      out.blocked_count = b.blocked.length;
    }
    if (b.warnings.length) { out.warnings = b.warnings.slice(0, n); if (b.warnings.length > n) out.warnings_more = b.warnings.length - n; }
    if (b.refused.length) { out.refused_files = b.refused.slice(0, n).map((x) => `${x.path}: ${x.why}`); if (b.refused.length > n) out.refused_more = b.refused.length - n; }
    if (b.unknown.length) out.unknown = b.unknown.slice(0, n);
    if (b.manifest) out.manifest = { file: b.manifest.file, keys: b.manifest.keys.length, ...(a.full ? { remove: b.manifest.keys } : { first: b.manifest.keys.slice(0, 5) }) };
    if (!b.items.length) out.next = 'nothing to remove';
    else if (b.blocked.length) {
      const appr = b.blocked.some((x) => x.why === 'approved'), need = b.blocked.some((x) => x.why === 'needed');
      out.next = `blocked: ${[need ? 'include_dependents:true removes the dependents too (force:true ignores them)' : '', appr ? 'allow_approved:true removes approved assets' : ''].filter(Boolean).join('; ')}`;
    } else if (planId) out.next = `apply {plan_id:"${planId}", confirm:true} moves these to the trash (restore undoes it)`;
    return out;
  }

  // ----- manifests -----
  manifestPlan(pm, items) {
    if (!pm || typeof pm !== 'object' || !pm.file) throw new Error('prune_manifest is {file, keys?:[dotted keys]} (no keys = entries naming a removed export file)');
    const abs = path.isAbsolute(pm.file) ? path.resolve(pm.file) : path.resolve(this.e.exportDir, pm.file);
    const why = this.refusePath(abs);
    if (why) throw new Error(`prune_manifest file ${pm.file}: ${why}`);
    let json;
    try { json = JSON.parse(fs.readFileSync(abs, 'utf8')); } catch (err) { throw new Error(`prune_manifest file ${pm.file}: ${err.message}`); }
    let keys;
    if (pm.keys !== undefined) keys = arr(pm.keys).map(String).filter((k) => getPath(json, k) !== undefined);
    else {
      // entries whose value names a removed export file (by path or file name)
      const names = new Set();
      for (const it of items) if (kindOf(it.id) === 'export') { const p = nameOf(it.id); names.add(p.toLowerCase()); names.add(path.basename(p).toLowerCase()); }
      const hits = new Set();
      const named = (v) => { const s = v.replace(/\\/g, '/').toLowerCase(); return names.has(s) || names.has(path.posix.basename(s)); };
      // a string naming a removed file: an entry object ({file:"x.png", w:8}) goes as a whole,
      // a top-level value or an array element goes alone
      const scan = (v, k, depth) => {
        if (!v || typeof v !== 'object') return;
        for (const [kk, vv] of Object.entries(v)) {
          const sub = k ? `${k}.${kk}` : kk;
          if (typeof vv === 'string' && named(vv)) hits.add(depth > 0 && !Array.isArray(v) ? k : sub);
          else scan(vv, sub, depth + 1);
        }
      };
      scan(json, '', 0);
      keys = [...hits];
    }
    return { file: abs, keys };
  }

  // ----- apply -----
  apply(a = {}, source = 'agent') {
    let opts = a, planId = a.plan_id;
    if (planId) {
      const p = this.plans.get(planId);
      if (!p) throw new Error(`no plan "${planId}" (plans are kept for the last ${PLAN_KEEP}; run plan again)`);
      opts = { ...p.opts, ...pick(a, ['force', 'allow_approved', 'prune_manifest']), select: { ids: p.ids.length ? p.ids : ['__none__'] } };
      // a plan applies exactly what it listed: no new dependents/exports join silently
      opts.include_dependents = false;
      opts.include_exports = false;
    }
    if (a.confirm !== true) throw new Error('apply needs confirm:true (plan first: it lists what goes, sizes and blockers)');
    const b = this.build(opts);
    if (planId) {
      const planned = new Set(this.plans.get(planId).ids);
      b.items = b.items.filter((x) => planned.has(x.id));
    }
    if (b.blocked.length) {
      const r = this.report(b, { limit: 8 });
      throw new Error(`refused, nothing removed: ${r.blocked.join('; ')}${b.blocked.length > 8 ? ` +${b.blocked.length - 8}` : ''}. ${r.next}`);
    }
    if (!b.items.length) return { removed: 0, text: 'nothing to remove', ...(b.unknown.length ? { unknown: b.unknown.slice(0, 10) } : {}) };
    const batch = this.removeAssets(b.items, { source, via: 'cleanup', plan: planId, manifest: b.manifest, full: true });
    const out = { removed: batch.items.length, bytes: batch.bytes, size: fmtBytes(batch.bytes), trash: batch.id, plan_id: planId };
    const n = a.full ? Infinity : Math.max(1, Math.min(200, a.limit ?? DEFAULT_LIMIT));
    out.items = batch.items.slice(0, n).map((x) => x.id);
    if (batch.items.length > n) out.more = batch.items.length - n;
    if (batch.edges.length || batch.reviews.length) out.also = `${batch.edges.length} graph edge(s), ${batch.reviews.length} review note(s)${batch.ui.length ? `, ${batch.ui.length} pin/hide entr${batch.ui.length > 1 ? 'ies' : 'y'}` : ''}`;
    if (batch.manifests.length) out.manifest = `${batch.manifests[0].keys.length} entr${batch.manifests[0].keys.length === 1 ? 'y' : 'ies'} pruned from ${batch.manifests[0].file}`;
    if (b.refused.length) out.refused_files = b.refused.slice(0, n).map((x) => `${x.path}: ${x.why}`);
    if (b.warnings.length) out.warnings = b.warnings.slice(0, Math.min(n, 5));
    out.next = `restore {ids:["${batch.id}"]} undoes this`;
    return out;
  }

  batchDir(id) { return path.join(this.trashDir, id); }
  /**
   * Move assets into a new trash batch. items: [{id}]. full = also take their stored graph edges,
   * node data (tags, notes, approval), review notes and pins (cleanup); false = files only
   * (single-item deletes keep their old graph behaviour).
   */
  removeAssets(items, { source = 'agent', via = 'cleanup', plan, manifest, full = false } = {}) {
    const id = rid('t');
    const dir = this.batchDir(id);
    fs.mkdirSync(path.join(dir, 'f'), { recursive: true });
    const batch = { id, ts: Date.now(), source, via, plan, items: [], edges: [], nodes: {}, reviews: [], ui: [], manifests: [], bytes: 0 };
    let seq = 0;
    const moved = [];
    const stash = (orig) => {
      const buf = fs.readFileSync(orig);
      const stored = `f/${++seq}-${path.basename(orig)}`;
      moveFile(orig, path.join(dir, stored));
      moved.push([path.join(dir, stored), orig]);
      return { orig, stored, bytes: buf.length, sha1: sha1(buf) };
    };
    // owner of each affected graph id, decided before anything is unloaded (rig parts canvases)
    const owner = new Map();
    const ownerOf = (x) => { if (!owner.has(x)) { const a = kindOf(x) === 'export' ? x : this.assetOf(x); owner.set(x, a); } return owner.get(x); };
    const ids = new Set(items.map((x) => x.id));
    const graphIds = full ? this.graph.allIds() : new Set();
    for (const x of graphIds) ownerOf(x);
    if (full) {
      for (const ed of this.graph.data.edges) { ownerOf(ed.from); ownerOf(ed.to); }
      for (const r of this.graph.data.reviews || []) ownerOf(r.asset);
      const ui0 = readUi(this.e);
      for (const x of [...ui0.pinned, ...ui0.hidden]) if (x.includes(':')) ownerOf(x);
    }
    try {
      for (const it of items) {
        const t = assetType(kindOf(it.id));
        if (!t) throw new Error(`no asset type "${kindOf(it.id)}"`);
        try { t.flush?.(this.e, nameOf(it.id)); } catch { /* best effort */ }
        if (kindOf(it.id) === 'export') { const why = this.refusePath(exportAbs(this.e, nameOf(it.id))); if (why) throw new Error(`${it.id}: ${why}`); }
        const files = this.files(it.id).map(stash);
        const bytes = files.reduce((s, f) => s + f.bytes, 0);
        batch.items.push({ id: it.id, bytes, files, ...(it.reason ? { reason: it.reason } : {}) });
        batch.bytes += bytes;
      }
      if (manifest?.keys.length) {
        const orig = manifest.file;
        const buf = fs.readFileSync(orig);
        const stored = `f/${++seq}-manifest-${path.basename(orig)}`;
        fs.writeFileSync(path.join(dir, stored), buf);
        const json = JSON.parse(buf.toString('utf8'));
        const removed = {};
        // children and the highest array indices first, so a deletion never shifts a later one
        for (const k of [...manifest.keys].sort(keyOrder)) { removed[k] = getPath(json, k); delPath(json, k); }
        const text = JSON.stringify(json, null, detectIndent(buf.toString('utf8')));
        fs.writeFileSync(orig, text);
        batch.manifests.push({ file: orig, stored, sha1: sha1(buf), pruned_sha1: sha1(Buffer.from(text)), keys: manifest.keys, removed });
      }
    } catch (err) {
      // roll back: put every moved file back
      for (const [from, to] of moved.reverse()) { try { fs.mkdirSync(path.dirname(to), { recursive: true }); moveFile(from, to); } catch { /* report below */ } }
      fs.rmSync(dir, { recursive: true, force: true }); // only our own empty batch folder
      throw new Error(`cleanup failed, nothing removed: ${err.message}`);
    }
    for (const it of batch.items) { try { assetType(kindOf(it.id)).unload(this.e, nameOf(it.id), source); } catch { /* files are gone already */ } }
    if (full) {
      const g = this.graph.data;
      const hit = (x) => typeof x === 'string' && x.includes(':') && ids.has(owner.has(x) ? owner.get(x) : ownerOf(x));
      // _index: where the edge was, so restore puts it back in the same order
      // an export file that stays keeps its exports_to edge: it is now a stale export (stale_exports finds it)
      const goes = (ed) => (hit(ed.from) || hit(ed.to)) && !(ed.rel === 'exports_to' && !hit(ed.to));
      batch.edges = g.edges.map((ed, i) => [ed, i]).filter(([ed]) => goes(ed)).map(([ed, i]) => ({ ...ed, _owner: hit(ed.from) ? owner.get(ed.from) : owner.get(ed.to), _index: i }));
      g.edges = g.edges.filter((ed) => !goes(ed));
      for (const [nid, data] of Object.entries(g.nodes)) if (hit(nid)) { batch.nodes[nid] = { data, owner: owner.get(nid) }; delete g.nodes[nid]; }
      const keep = [];
      (g.reviews || []).forEach((r, index) => {
        if (!hit(r.asset)) { keep.push(r); return; }
        const files = [];
        for (const h of r.history || []) if (h.img) { const f = path.join(this.e.reviews.dir, h.img); if (fs.existsSync(f)) files.push(stash(f)); }
        batch.reviews.push({ record: r, index, owner: owner.get(r.asset), files });
      });
      if (g.reviews) g.reviews = keep;
      const ui = readUi(this.e);
      let uiChanged = false;
      for (const list of ['pinned', 'hidden']) {
        ui[list] = ui[list].filter((x) => { if (hit(x)) { batch.ui.push({ list, id: x, owner: owner.get(x) }); uiChanged = true; return false; } return true; });
      }
      if (uiChanged) writeUi(this.e, ui);
      this.logEvent({ type: 'removed', plan, batch: id, count: batch.items.length, ids: batch.items.slice(0, 20).map((x) => x.id) });
      this.graph.save({ action: 'removed', plan, batch: id, count: batch.items.length });
    }
    fs.writeFileSync(path.join(dir, 'batch.json'), JSON.stringify(batch, null, 1));
    this.timeline('removed', batch, source);
    return batch;
  }
  logEvent(ev) {
    const g = this.graph.data;
    g.events = Array.isArray(g.events) ? g.events : [];
    g.events.push({ ...ev, ts: Date.now() });
    if (g.events.length > EVENTS_KEEP) g.events.splice(0, g.events.length - EVENTS_KEEP);
  }
  /** An activity timeline entry ("removed" / "restored", with the plan and trash batch ids). */
  timeline(op, batch, source) {
    const act = this.e.activity;
    if (!act) return;
    const entry = {
      id: ++act.seq, type: 'op', op, source, ts: Date.now(), ok: true, ms: 0,
      args: { plan: batch.plan, trash: batch.id, via: batch.via },
      summary: `${op} ${batch.items.length} asset(s), ${fmtBytes(batch.bytes)}${batch.plan ? ` (plan ${batch.plan})` : ''} · trash ${batch.id}`,
      assets: batch.items.slice(0, 12).map((x) => ({ kind: kindOf(x.id), name: nameOf(x.id), ...(op === 'removed' ? { deleted: true } : {}) })),
      event: op, plan: batch.plan, trash: batch.id,
    };
    act.push(entry);
    act.emit(entry);
  }

  // ----- trash -----
  batches() {
    let list = [];
    try { list = fs.readdirSync(this.trashDir, { withFileTypes: true }).filter((d) => d.isDirectory()); } catch { return []; }
    const out = [];
    for (const d of list) { try { out.push(JSON.parse(fs.readFileSync(path.join(this.trashDir, d.name, 'batch.json'), 'utf8'))); } catch { /* not a batch */ } }
    return out.sort((x, y) => y.ts - x.ts);
  }
  saveBatch(b) { fs.writeFileSync(path.join(this.batchDir(b.id), 'batch.json'), JSON.stringify(b, null, 1)); }
  trashList(a = {}) {
    const n = a.full ? Infinity : Math.max(1, Math.min(200, a.limit ?? DEFAULT_LIMIT));
    const all = this.batches().filter((b) => a.all || b.items.some((x) => !x.restored));
    const now = Date.now();
    let bytes = 0;
    const rows = all.map((b) => {
      const live = b.items.filter((x) => !x.restored);
      const by = live.reduce((s, x) => s + x.bytes, 0) + (b.reviews || []).reduce((s, r) => s + r.files.reduce((t, f) => t + f.bytes, 0), 0);
      bytes += by;
      return { id: b.id, ts: b.ts, age: ageText(now - b.ts), via: b.via, ...(b.plan ? { plan: b.plan } : {}), items: live.length, bytes: by, size: fmtBytes(by), ...(a.full ? { assets: live.map((x) => ({ id: x.id, bytes: x.bytes, files: x.files.map((f) => f.orig) })), edges: b.edges.length, reviews: (b.reviews || []).length, manifests: (b.manifests || []).map((m) => m.file) } : { first: live.slice(0, 5).map((x) => x.id), ...(live.length > 5 ? { more: live.length - 5 } : {}) }) };
    });
    return { batches: rows.length, bytes, size: fmtBytes(bytes), trash: rows.slice(0, n), ...(rows.length > n ? { more: rows.length - n } : {}), ...(rows.length ? { next: 'restore {ids:["<batch or asset id>"]} | empty {older_than?, confirm:true}' } : {}) };
  }
  restore(a = {}, source = 'agent') {
    const want = arr(a.ids);
    if (!want.length && !a.all) throw new Error('restore needs ids:[batch ids "t..." or asset ids like "canvas:marine_a"] or all:true');
    const batches = this.batches();
    const restored = [], conflicts = [];
    const touched = new Set();
    for (const b of batches) {
      const wholeBatch = a.all || want.includes(b.id);
      const pickIt = (it) => !it.restored && (wholeBatch || want.includes(it.id) || want.some((w) => { try { return this.canon(this.graph.resolveLoose(w)) === it.id; } catch { return false; } }));
      const items = b.items.filter(pickIt);
      if (!items.length) continue;
      const dir = this.batchDir(b.id);
      const done = [];
      for (const it of items) {
        if (this.exists(it.id) && kindOf(it.id) !== 'export') { conflicts.push(`${it.id}: exists again (rename or remove it first)`); continue; }
        const busy = it.files.filter((f) => fs.existsSync(f.orig));
        if (busy.length) { conflicts.push(`${it.id}: ${busy[0].orig} exists`); continue; }
        for (const f of it.files) { fs.mkdirSync(path.dirname(f.orig), { recursive: true }); moveFile(path.join(dir, f.stored), f.orig); }
        try { assetType(kindOf(it.id))?.reload(this.e, nameOf(it.id), source); } catch (err) { conflicts.push(`${it.id}: restored files but could not load it (${err.message})`); }
        it.restored = Date.now();
        done.push(it.id);
        restored.push(it.id);
      }
      if (!done.length) continue;
      const own = new Set(done);
      const g = this.graph.data;
      // graph edges, node data, review notes and pins that went with these assets
      const key = (ed) => `${ed.from}\u0000${ed.rel}\u0000${ed.to}`;
      const have = new Set(g.edges.map(key));
      b.edges = b.edges.filter((ed) => {
        if (!own.has(ed._owner)) return true;
        const { _owner, _index, ...clean } = ed;
        if (!have.has(key(clean))) { g.edges.splice(Math.min(_index ?? g.edges.length, g.edges.length), 0, clean); have.add(key(clean)); }
        return false;
      });
      for (const [nid, v] of Object.entries(b.nodes)) if (own.has(v.owner)) { g.nodes[nid] = { ...v.data, ...(g.nodes[nid] || {}) }; delete b.nodes[nid]; }
      g.reviews ||= [];
      b.reviews = (b.reviews || []).filter((r) => {
        if (!own.has(r.owner)) return true;
        for (const f of r.files) if (!fs.existsSync(f.orig)) { fs.mkdirSync(path.dirname(f.orig), { recursive: true }); moveFile(path.join(dir, f.stored), f.orig); }
        if (!g.reviews.some((x) => x.id === r.record.id)) g.reviews.splice(Math.min(r.index, g.reviews.length), 0, r.record);
        return false;
      });
      const uiBack = (b.ui || []).filter((u) => own.has(u.owner));
      if (uiBack.length) {
        const ui = readUi(this.e);
        for (const u of uiBack) if (!ui[u.list].includes(u.id)) ui[u.list].push(u.id);
        writeUi(this.e, ui);
        b.ui = b.ui.filter((u) => !own.has(u.owner));
      }
      // manifests: back to the original bytes when untouched since, else re-insert the pruned entries
      for (const m of b.manifests || []) {
        if (m.restored) continue;
        const exportsBack = b.items.filter((x) => kindOf(x.id) === 'export');
        if (exportsBack.length && !exportsBack.every((x) => x.restored) && !wholeBatch) continue;
        let cur = null;
        try { cur = fs.readFileSync(m.file); } catch { /* gone */ }
        if (!cur || sha1(cur) === m.pruned_sha1) { fs.mkdirSync(path.dirname(m.file), { recursive: true }); fs.copyFileSync(path.join(dir, m.stored), m.file); m.restored = 'exact'; }
        else {
          const json = JSON.parse(cur.toString('utf8'));
          // reverse of the deletion order: array elements go back at their old index
          for (const [k, v] of Object.entries(m.removed).reverse()) if (getPath(json, k) === undefined || /\.\d+$/.test(k)) setPath(json, k, v);
          fs.writeFileSync(m.file, JSON.stringify(json, null, detectIndent(cur.toString('utf8'))));
          m.restored = 'merged';
        }
        touched.add(`${m.file} (${m.restored})`);
      }
      this.saveBatch(b);
      this.logEvent({ type: 'restored', plan: b.plan, batch: b.id, count: done.length, ids: done.slice(0, 20) });
      this.graph.save({ action: 'restored', batch: b.id, count: done.length });
      this.timeline('restored', { ...b, items: b.items.filter((x) => own.has(x.id)), bytes: b.items.filter((x) => own.has(x.id)).reduce((s, x) => s + x.bytes, 0) }, source);
    }
    const n = a.full ? Infinity : DEFAULT_LIMIT;
    if (!restored.length && !conflicts.length) throw new Error(`nothing to restore for ${want.join(', ') || 'all'} (trash lists batches and their assets)`);
    return { restored: restored.length, items: restored.slice(0, n), ...(restored.length > n ? { more: restored.length - n } : {}), ...(conflicts.length ? { conflicts: conflicts.slice(0, n) } : {}), ...(touched.size ? { manifests: [...touched] } : {}) };
  }
  /** The only hard delete: remove trash batches (all, older_than, or ids). */
  empty(a = {}) {
    if (a.confirm !== true) throw new Error('empty permanently deletes trash batches: pass confirm:true (trash lists them)');
    const t = a.older_than !== undefined ? parseAge(a.older_than) : null;
    const ids = arr(a.ids);
    let n = 0, bytes = 0;
    for (const b of this.batches()) {
      if (t !== null && b.ts >= t) continue;
      if (ids.length && !ids.includes(b.id)) continue;
      const dir = this.batchDir(b.id);
      for (const f of walkFiles(dir)) bytes += fileSize(f.abs);
      fs.rmSync(dir, { recursive: true, force: true });
      n++;
    }
    if (n) { this.logEvent({ type: 'emptied', count: n, bytes }); this.graph.save({ action: 'emptied', count: n }); }
    return { emptied: n, bytes, size: fmtBytes(bytes) };
  }

  // ----- usage -----
  usage(a = {}) {
    const n = a.full ? Infinity : Math.max(1, Math.min(200, a.limit ?? DEFAULT_LIMIT));
    const kinds = {}, projects = {}, groups = {}, all = [];
    for (const id of this.allAssets({ exports: true })) {
      const k = kindOf(id), by = this.bytes(id);
      (kinds[k] ||= { count: 0, bytes: 0 }).count++;
      kinds[k].bytes += by;
      const p = this.info(id).project;
      if (p) { (projects[p] ||= { count: 0, bytes: 0 }).count++; projects[p].bytes += by; }
      all.push([id, by]);
    }
    const sizeOf = new Map(all);
    for (const g of Object.keys(this.graph.data.groups)) {
      const seen = new Set();
      const walk = (name, guard) => { if (guard.has(name)) return; guard.add(name); for (const m of this.graph.members(name)) { if (kindOf(m) === 'group') walk(nameOf(m), guard); else { const x = this.assetOf(m) || m; if (sizeOf.has(x)) seen.add(x); } } };
      walk(g, new Set());
      groups[g] = { count: seen.size, bytes: [...seen].reduce((s, x) => s + sizeOf.get(x), 0) };
    }
    const dirBytes = (d) => walkFiles(d).reduce((s, f) => s + fileSize(f.abs), 0);
    const other = { trash: dirBytes(this.trashDir), reviews: dirBytes(path.join(this.e.home, 'reviews')), packs: dirBytes(this.e.packDir), audio_cache: 0 };
    try { other.audio_cache = dirBytes(audioStore(this.e).d.cache); } catch { /* none */ }
    const total = all.reduce((s, [, b]) => s + b, 0);
    const fmt = (o) => Object.fromEntries(Object.entries(o).sort((x, y) => y[1].bytes - x[1].bytes).slice(0, n).map(([k, v]) => [k, `${v.count} · ${fmtBytes(v.bytes)}`]));
    const raw = (o) => Object.fromEntries(Object.entries(o).sort((x, y) => y[1].bytes - x[1].bytes));
    const biggest = all.sort((x, y) => y[1] - x[1]).slice(0, n);
    return {
      total: fmtBytes(total), bytes: total,
      by_kind: a.full ? raw(kinds) : fmt(kinds), by_project: a.full ? raw(projects) : fmt(projects), by_group: a.full ? raw(groups) : fmt(groups),
      biggest: a.full ? biggest.map(([id, b]) => ({ id, bytes: b })) : biggest.map(([id, b]) => `${id} ${fmtBytes(b)}`),
      other: a.full ? other : Object.fromEntries(Object.entries(other).map(([k, v]) => [k, fmtBytes(v)])),
    };
  }

  // ----- superseding -----
  replace(a = {}, source = 'agent') {
    const pairs = a.pairs ? arr(a.pairs) : [{ old: a.old, new: a.new }];
    const lines = [];
    for (const p of pairs) {
      if (!p?.old || !p?.new) throw new Error('replace needs old and new (or pairs:[{old, new}])');
      const o = this.assetOf(this.graph.resolve(p.old, { mustExist: true })) || this.graph.resolve(p.old);
      const nw = this.assetOf(this.graph.resolve(p.new, { mustExist: true })) || this.graph.resolve(p.new);
      if (o === nw) throw new Error('old and new are the same asset');
      const g = this.graph.data;
      const alias = (x) => (x === o || (kindOf(o) === 'rig' && x === `canvas:${nameOf(o)}_parts`));
      let moved = 0;
      const key = (ed) => `${ed.from}\u0000${ed.rel}\u0000${ed.to}`;
      const have = new Set(g.edges.map(key));
      for (const ed of [...g.edges]) {
        if (['replaces', 'exports_to'].includes(ed.rel)) continue;
        const from = alias(ed.from), to = alias(ed.to);
        if (!from && !to) continue;
        const nx = { ...ed, from: from ? nw : ed.from, to: to ? nw : ed.to };
        if (nx.from === nx.to || nx.from === nw && nx.to === o) continue;
        have.delete(key(ed));
        g.edges.splice(g.edges.indexOf(ed), 1);
        if (!have.has(key(nx))) { g.edges.push(nx); have.add(key(nx)); }
        moved++;
      }
      if (!g.edges.some((ed) => ed.from === nw && ed.rel === 'replaces' && ed.to === o)) g.edges.push({ from: nw, rel: 'replaces', to: o, ts: Date.now() });
      // active review notes follow the replacement; resolved ones stay as history on the old asset
      let notes = 0;
      const ACTIVE = new Set(['open', 'in_progress', 'reopened']);
      for (const r of g.reviews || []) {
        if (!ACTIVE.has(r.status)) continue;
        let hit = false;
        if (alias(r.asset)) { r.asset = nw; hit = true; }
        if (r.compare_with && alias(r.compare_with.asset)) { r.compare_with.asset = nw; hit = true; }
        if (hit) { r.history.push({ ts: Date.now(), by: source === 'agent' ? 'agent' : 'user', reply: `moved from ${o} (replaced by ${nw})` }); r.updated = Date.now(); notes++; }
      }
      // tags stay on old: they often describe its state ("baked_gun", "wip") and help select it
      const on = g.nodes[o] || (g.nodes[o] = {});
      on.superseded = { by: nw, ts: Date.now() };
      this.logEvent({ type: 'replaced', from: o, to: nw });
      lines.push(`${nw} replaces ${o}: ${moved} edge(s) and ${notes} open review note(s) moved; ${o} is superseded`);
    }
    this.graph.save({ action: 'replace', count: pairs.length });
    return { text: `${lines.slice(0, DEFAULT_LIMIT).join('\n')}${lines.length > DEFAULT_LIMIT ? `\n… +${lines.length - DEFAULT_LIMIT} more` : ''}\nnext: plan {select:{superseded:true}, include_exports:true}` };
  }

  // ----- config -----
  config(a = {}, source) {
    const c = readConfig(this.e);
    if (a.allow_paths !== undefined || a.trash_deletes !== undefined) {
      // the allowlist widens what cleanup may move: only the user sets it (web UI, or config.json by hand)
      if (source !== 'user') throw new Error(`cleanup.allow_paths is set by the user (web UI Cleanup > Settings, or ${configFile(this.e)}), not by the agent`);
      c.cleanup ||= {};
      if (a.allow_paths !== undefined) {
        const list = arr(a.allow_paths).map(String).filter(Boolean).map((p) => path.resolve(p));
        for (const p of list) {
          if (path.parse(p).root === p) throw new Error(`allow path ${p} is a drive / filesystem root`);
          if (!fs.existsSync(p) || !fs.statSync(p).isDirectory()) throw new Error(`allow path ${p} is not a folder`);
        }
        c.cleanup.allow_paths = [...new Set(list)];
      }
      if (a.trash_deletes !== undefined) c.cleanup.trash_deletes = !!a.trash_deletes;
      writeConfig(this.e, c);
    }
    return { exports: this.e.exportDir, allow_paths: arr(c.cleanup?.allow_paths), trash_deletes: c.cleanup?.trash_deletes !== false, file: configFile(this.e) };
  }

  /** Single-item deletes (art_canvas delete, art_model delete, ...): files to the trash, unless disabled. */
  trashFiles(kind, name, source, via) {
    if (readConfig(this.e).cleanup?.trash_deletes === false) return null;
    const id = `${kind}:${name}`;
    try { assetType(kind)?.flush?.(this.e, name); } catch { /* best effort */ }
    if (!this.files(id).length) return null;
    return this.removeAssets([{ id }], { source, via, full: false }).id;
  }
}

function pick(o, keys) { const out = {}; for (const k of keys) if (o[k] !== undefined) out[k] = o[k]; return out; }
function ageText(ms) { const s = ms / 1000; return s < 90 ? `${Math.round(s)}s` : s < 5400 ? `${Math.round(s / 60)}m` : s < 129600 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`; }
function moveFile(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  try { fs.renameSync(from, to); } catch (err) {
    if (err.code !== 'EXDEV' && err.code !== 'EPERM') throw err;
    // another drive (a game folder): copy, verify, then remove the original
    fs.copyFileSync(from, to);
    if (fs.statSync(to).size !== fs.statSync(from).size) throw new Error(`copy of ${from} is incomplete`);
    fs.unlinkSync(from);
  }
}
function detectIndent(text) { const m = text.match(/\n([ \t]+)"/); return m ? m[1] : text.includes('\n') ? 2 : 0; }
const splitKey = (k) => String(k).split('.');
/** Deletion order: "list.10" before "list.2", children before parents. */
function keyOrder(a, b) {
  const x = splitKey(a), y = splitKey(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    if (x[i] === y[i]) continue;
    const nx = /^\d+$/.test(x[i]), ny = /^\d+$/.test(y[i]);
    return nx && ny ? Number(y[i]) - Number(x[i]) : y[i] < x[i] ? -1 : 1;
  }
  return y.length - x.length;
}
function getPath(o, k) { let v = o; for (const p of splitKey(k)) { if (v === null || typeof v !== 'object' || !Object.prototype.hasOwnProperty.call(v, p)) return undefined; v = v[p]; } return v; }
function delPath(o, k) {
  const ps = splitKey(k), last = ps.pop();
  let v = o;
  for (const p of ps) { v = v?.[p]; if (!v || typeof v !== 'object') return; }
  if (Array.isArray(v)) v.splice(Number(last), 1); else delete v[last];
}
function setPath(o, k, val) {
  const ps = splitKey(k), last = ps.pop();
  let v = o;
  for (const p of ps) { if (!v[p] || typeof v[p] !== 'object') v[p] = {}; v = v[p]; }
  if (Array.isArray(v)) v.splice(Number(last), 0, val); else v[last] = val;
}

export const CLEANUP_OPS = {
  cleanup_plan(a) { return this.cleanup.plan(a); },
  cleanup_apply(a, source) { return this.cleanup.apply(a, source); },
  cleanup_trash(a) { return this.cleanup.trashList(a); },
  cleanup_restore(a, source) { return this.cleanup.restore(a, source); },
  cleanup_empty(a) { return this.cleanup.empty(a); },
  cleanup_usage(a) { return this.cleanup.usage(a); },
  cleanup_replace(a, source) { return this.cleanup.replace(a, source); },
  cleanup_config(a, source) { return this.cleanup.config(a, source); },
  /** UI: superseded / orphan ids for the browser badges. */
  cleanup_flags() { const f = this.cleanup.flags(); return { superseded: [...f.superseded], orphans: [...f.orphans] }; },
};
