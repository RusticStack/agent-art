// Asset graph: typed relations between assets (part_of, variant_of, view_of, ...), tags, one-line
// notes and nested groups, persisted in <workspace>/graph.json. It is the light index an agent
// reads instead of calling art_info on everything: queries return ids, relation types and notes only.
//
// Structural edges (project membership, layers, animation tags, rig parts, rendered sprites, model
// parts and textures, normal maps, CTM tilesets) are derived from the workspace on every read, so
// they never go stale. Only semantic edges, tags, notes, groups and export records are stored.
import fs from 'node:fs';
import path from 'node:path';
import { audioStore } from './audio/ops.js';
import { modelDefs } from './modelops.js';
import { assetType, assetTypes, subOwnerKind } from './assettypes.js';

export const RELS = ['part_of', 'variant_of', 'view_of', 'layer_of', 'uses_palette', 'rendered_from', 'exports_to', 'depends_on', 'replaces'];
export const KINDS = ['canvas', 'layer', 'anim', 'frame', 'rig', 'rigpart', 'model', 'modelpart', 'palette', 'audio', 'export', 'project', 'group', 'file'];
const REL_RE = /^[a-z][a-z0-9_]{0,31}$/;
const GROUP_RE = /^[\w .\-]{1,64}$/;
const TAG_RE = /^[\w.\-:]{1,32}$/;
/** Lookup order for a bare name ("helmet" -> canvas:helmet if it exists, else model:helmet, ...). */
const BARE_ORDER = ['canvas', 'model', 'rig', 'audio', 'group', 'project'];
const DEFAULT_CHARS = 1600;

const kindOf = (id) => id.slice(0, id.indexOf(':'));
/** Registered kinds the built-in lookups do not already cover (assettypes.js). */
const extraKinds = () => assetTypes().filter((t) => !t.builtin && !KINDS.includes(t.kind)).map((t) => t.kind);
const nameOf = (id) => id.slice(id.indexOf(':') + 1);
const fmtAttrs = (a) => (a && Object.keys(a).length ? ` {${Object.entries(a).map(([k, v]) => `${k}:${v}`).join(',')}}` : '');

export class Graph {
  constructor(engine) {
    this.engine = engine;
    this.file = path.join(engine.home, 'graph.json');
    // null-prototype maps: group names / node ids are user input ("__proto__" must not reach Object.prototype)
    const dict = (o) => Object.assign(Object.create(null), o && typeof o === 'object' ? o : {});
    this.data = { version: 1, nodes: dict(), edges: [], groups: dict() };
    this.cache = null;
    try {
      if (fs.existsSync(this.file)) {
        const j = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        this.data = { version: 1, nodes: dict(j.nodes), edges: Array.isArray(j.edges) ? j.edges : [], groups: dict(j.groups), reviews: Array.isArray(j.reviews) ? j.reviews : [], reviewSeq: j.reviewSeq || 0 };
      }
    } catch (e) {
      process.stderr.write(`[agent-art] could not load graph.json: ${e.message}\n`);
    }
    // any workspace change can change derived edges
    engine.on('event', (ev) => { if (ev.type !== 'activity') this.cache = null; });
  }

  save(change) {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 1));
    fs.renameSync(tmp, this.file);
    this.cache = null;
    if (change) this.engine.emit('event', { type: 'graph', ...change, ts: Date.now() });
  }

  // ---------- nodes ----------
  /** Does the asset behind an id exist in the workspace? (groups: defined; files / exports: on disk) */
  exists(id) {
    const e = this.engine, k = kindOf(id), n = nameOf(id);
    const [owner, sub] = n.includes('/') ? [n.slice(0, n.indexOf('/')), n.slice(n.indexOf('/') + 1)] : [n, null];
    switch (k) {
      case 'canvas': return e.docs.has(n);
      case 'layer': return !!e.docs.get(owner)?.layers.some((l) => l.name === sub);
      case 'anim': return !!e.docs.get(owner)?.animations[sub];
      case 'frame': { const d = e.docs.get(owner); return !!d && Number(sub) >= 0 && Number(sub) < d.frames; }
      case 'rig': return !!e.docs.get(`${n}_parts`)?.meta?.rig;
      case 'rigpart': return !!e.docs.get(`${owner}_parts`)?.meta?.rig?.parts?.[sub];
      case 'model': return !!this.models().get(n);
      case 'modelpart': return !!this.models().get(owner)?.parts?.some((p) => p?.name === sub);
      case 'palette': return e.projects.has(n) || e.docs.has(n);
      case 'audio': return !!this.audio()?.defs.has(n);
      case 'project': return e.projects.has(n);
      case 'group': return !!this.data.groups[n];
      case 'export': return fs.existsSync(path.isAbsolute(n) ? n : path.join(e.exportDir, n));
      case 'file': return fs.existsSync(n);
      default: {
        // registered asset kinds (assettypes.js): planet:x, ship:y, ...
        const t = assetType(k);
        if (!t) return false;
        try { return t.exists ? !!t.exists(e, n) : [...t.list(e)].includes(n); } catch { return false; }
      }
    }
  }
  models() {
    try { return modelDefs(this.engine); } catch { return new Map(); }
  }
  audio() {
    try { return audioStore(this.engine); } catch { return null; }
  }

  /** "helmet" | "canvas:helmet" | "layer:helmet/base" -> a node id (bare names must exist). */
  resolve(ref, { mustExist = false } = {}) {
    if (typeof ref !== 'string' || !ref.trim()) throw new Error('node reference must be a non-empty string like "canvas:helmet" or "helmet"');
    ref = ref.trim();
    const m = ref.match(/^([a-z]+):(.+)$/);
    if (m && (KINDS.includes(m[1]) || assetType(m[1]) || subOwnerKind(m[1]))) {
      const id = m[1] === 'export' ? `export:${this.exportRel(m[2])}` : ref;
      if (mustExist && !this.exists(id)) throw new Error(`no ${m[1]} "${m[2]}"`);
      return id;
    }
    if (m && m[1] === 'tag') return `anim:${m[2]}`;
    for (const k of [...BARE_ORDER, ...extraKinds()]) if (this.exists(`${k}:${ref}`)) return `${k}:${ref}`;
    throw new Error(`unknown node "${ref}": no canvas, model, rig, audio, group or project of that name (prefix the kind: ${KINDS.map((k) => k + ':').join(' ')})`);
  }
  exportRel(p) {
    const abs = path.resolve(this.engine.exportDir, p);
    const rel = path.relative(this.engine.exportDir, abs);
    return (!rel.startsWith('..') && !path.isAbsolute(rel) ? rel : abs).replace(/\\/g, '/');
  }

  // ---------- edges ----------
  /** Structural edges computed from the workspace (cached until the next change event). */
  derived() {
    const e = this.engine, out = [];
    const add = (from, rel, to, attrs) => out.push({ from, rel, to, ...(attrs ? { attrs } : {}), derived: true });
    for (const d of e.docs.values()) {
      const c = `canvas:${d.name}`;
      if (d.project) {
        add(c, 'part_of', `project:${d.project}`);
        if (Object.keys(e.projects.get(d.project)?.palette || {}).length) add(c, 'uses_palette', `palette:${d.project}`);
      }
      for (const l of d.layers) add(`layer:${d.name}/${l.name}`, 'layer_of', c);
      for (const t of Object.keys(d.animations || {})) add(`anim:${d.name}/${t}`, 'part_of', c);
      const meta = d.meta || {};
      if (meta.rig && typeof meta.rig === 'object' && /_parts$/.test(d.name)) {
        const r = d.name.slice(0, -6);
        add(c, 'part_of', `rig:${r}`);
        for (const p of Object.keys(meta.rig.parts || {})) add(`rigpart:${r}/${p}`, 'part_of', c);
      } else if (typeof meta.rig === 'string') add(c, 'rendered_from', `rig:${meta.rig}`);
      if (meta.renders && typeof meta.renders === 'object') {
        for (const m of new Set(Object.values(meta.renders).map((x) => x?.model).filter(Boolean))) add(c, 'rendered_from', `model:${m}`);
      }
      if (typeof meta.normal_map_of === 'string') add(c, 'variant_of', `canvas:${meta.normal_map_of}`, { map: 'normal' });
      if (typeof meta.ctm?.base === 'string') add(c, 'rendered_from', `canvas:${meta.ctm.base}`, { ctm: meta.ctm.method });
    }
    for (const p of e.projects.values()) if (Object.keys(p.palette || {}).length) add(`palette:${p.name}`, 'part_of', `project:${p.name}`);
    for (const m of this.models().values()) {
      const id = `model:${m.name}`;
      if (m.project) add(id, 'part_of', `project:${m.project}`);
      const textures = new Set(), sub = new Set();
      const scan = (v, key) => {
        if (typeof v === 'string') { if (key === 'model') sub.add(v); else if (TEX_KEYS.has(key) && e.docs.has(v)) textures.add(v); return; }
        if (Array.isArray(v)) { for (const x of v) scan(x, key); return; }
        if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) scan(x, k === 'canvas' ? key || 'texture' : k);
      };
      for (const p of m.parts || []) {
        if (!p) continue;
        if (p.name) add(`modelpart:${m.name}/${p.name}`, 'part_of', id);
        scan(p, null);
      }
      for (const t of textures) add(id, 'depends_on', `canvas:${t}`);
      for (const s of sub) if (s !== m.name) add(id, 'depends_on', `model:${s}`);
    }
    // registered asset kinds contribute their own structural edges
    for (const t of assetTypes()) if (t.edges) { try { t.edges(e, add); } catch { /* a broken plug-in must not break the graph */ } }
    return out;
  }
  /** Every edge (stored + derived) with adjacency indexes. */
  all() {
    if (this.cache) return this.cache;
    const edges = [...this.data.edges, ...this.derived()];
    const out = new Map(), inn = new Map();
    for (const ed of edges) {
      if (!out.has(ed.from)) out.set(ed.from, []);
      if (!inn.has(ed.to)) inn.set(ed.to, []);
      out.get(ed.from).push(ed);
      inn.get(ed.to).push(ed);
    }
    this.cache = { edges, out, inn };
    return this.cache;
  }

  link({ from, rel, to, attrs, label, auto = false }) {
    const f = this.resolve(from), t = this.resolve(to);
    if (!REL_RE.test(rel || '')) throw new Error(`rel must be one of ${RELS.join(', ')} or a custom lowercase label (a-z, 0-9, _)`);
    if (f === t) throw new Error('an edge needs two different nodes');
    if (attrs !== undefined && (typeof attrs !== 'object' || Array.isArray(attrs) || attrs === null)) throw new Error('attrs must be an object of short values, e.g. {view:"side"}');
    const clean = attrs ? Object.fromEntries(Object.entries(attrs).filter(([, v]) => v !== null && v !== undefined).map(([k, v]) => [String(k).slice(0, 24), String(v).slice(0, 48)])) : undefined;
    let ed = this.data.edges.find((x) => x.from === f && x.rel === rel && x.to === t);
    const isNew = !ed;
    if (!ed) { ed = { from: f, rel, to: t, ts: Date.now() }; this.data.edges.push(ed); }
    if (clean && Object.keys(clean).length) ed.attrs = clean; else if (attrs !== undefined) delete ed.attrs;
    if (label !== undefined) { if (label) ed.label = String(label).slice(0, 80); else delete ed.label; }
    if (auto) ed.auto = true;
    this.save({ action: 'link', from: f, rel, to: t, auto: !!auto });
    return { edge: ed, isNew };
  }
  unlink({ from, rel, to, node }) {
    let removed;
    if (node !== undefined) {
      const id = this.resolveLoose(node);
      removed = this.data.edges.filter((x) => (x.from === id || x.to === id) && (!rel || x.rel === rel));
    } else {
      const f = this.resolveLoose(from), t = to !== undefined ? this.resolveLoose(to) : null;
      removed = this.data.edges.filter((x) => x.from === f && (!t || x.to === t) && (!rel || x.rel === rel));
    }
    this.data.edges = this.data.edges.filter((x) => !removed.includes(x));
    if (removed.length) this.save({ action: 'unlink', count: removed.length });
    return removed;
  }
  /** Like resolve, but a stale id (deleted asset) still resolves, so it can be cleaned up. */
  resolveLoose(ref) {
    try { return this.resolve(ref); } catch (e) {
      const id = BARE_ORDER.map((k) => `${k}:${ref}`).find((x) => this.data.edges.some((ed) => ed.from === x || ed.to === x) || this.data.nodes[x]);
      if (id) return id;
      throw e;
    }
  }

  /** Remember a file an export op wrote: <asset> exports_to export:<path>. */
  recordExport(op, a, files) {
    if (!files?.length) return;
    let src;
    if (op === 'model_export') src = `model:${a.name}`;
    else if (op === 'audio_export') src = a.name && !a.name.includes('*') ? `audio:${a.name}` : null;
    else if (op === 'pack_build') src = `project:${a.project}`;
    else if (op === 'pack_zip') src = null;
    else src = a.canvas ? `canvas:${a.canvas}` : null;
    if (!src) return;
    let changed = 0;
    for (const f of files.slice(0, 12)) {
      const to = `export:${this.exportRel(f)}`;
      if (this.data.edges.some((x) => x.from === src && x.rel === 'exports_to' && x.to === to)) continue;
      this.data.edges.push({ from: src, rel: 'exports_to', to, auto: true, ts: Date.now() });
      changed++;
    }
    if (changed) this.save({ action: 'export', from: src, count: changed });
  }

  // ---------- tags, notes, groups ----------
  node(id) {
    return this.data.nodes[id] || null;
  }
  tag({ node, add, remove, tags }) {
    const id = this.resolve(node);
    const n = this.data.nodes[id] || (this.data.nodes[id] = {});
    let cur = new Set(n.tags || []);
    if (tags !== undefined) cur = new Set([].concat(tags || []));
    for (const t of [].concat(add || [])) cur.add(t);
    for (const t of [].concat(remove || [])) cur.delete(t);
    for (const t of cur) if (!TAG_RE.test(t)) throw new Error(`tag "${t}" must be 1-32 chars of letters, digits, _ - . :`);
    n.tags = [...cur].sort();
    if (!n.tags.length) delete n.tags;
    this.prune(id);
    this.save({ action: 'tag', node: id });
    return { id, tags: n.tags || [] };
  }
  note({ node, note }) {
    const id = this.resolve(node);
    const n = this.data.nodes[id] || (this.data.nodes[id] = {});
    if (note === null || note === undefined || note === '') delete n.note;
    else n.note = String(note).replace(/\s+/g, ' ').trim().slice(0, 160);
    this.prune(id);
    this.save({ action: 'note', node: id });
    return { id, note: n.note || null };
  }
  prune(id) {
    const n = this.data.nodes[id];
    if (n && !n.tags && !n.note) delete this.data.nodes[id];
  }
  /** Ancestors of a group (cycle safe). */
  groupChain(name) {
    const seen = new Set();
    let cur = this.data.groups[name]?.parent;
    while (cur && !seen.has(cur)) { seen.add(cur); cur = this.data.groups[cur]?.parent; }
    return seen;
  }
  group({ name, members, remove, parent, note, delete: del }) {
    if (!GROUP_RE.test(name || '')) throw new Error('group "name" must be 1-64 chars of letters, digits, space, _ - .');
    const gid = `group:${name}`;
    if (del) {
      if (!this.data.groups[name]) throw new Error(`no group "${name}"`);
      delete this.data.groups[name];
      for (const g of Object.values(this.data.groups)) if (g.parent === name) delete g.parent;
      this.data.edges = this.data.edges.filter((x) => x.to !== gid && x.from !== gid);
      delete this.data.nodes[gid];
      this.save({ action: 'group', group: name, deleted: true });
      return { group: name, deleted: true };
    }
    const g = this.data.groups[name] || (this.data.groups[name] = { created: Date.now() });
    if (parent !== undefined) {
      if (parent === null || parent === '') delete g.parent;
      else {
        if (!this.data.groups[parent]) throw new Error(`no parent group "${parent}" (create it first)`);
        if (parent === name || this.groupChain(parent).has(name)) throw new Error(`group "${parent}" is inside "${name}": nesting it would make a cycle`);
        g.parent = parent;
      }
    }
    if (note !== undefined) { if (note) g.note = String(note).slice(0, 160); else delete g.note; }
    const added = [];
    for (const m of [].concat(members || [])) {
      const id = this.resolve(m);
      if (id === gid) throw new Error('a group cannot contain itself');
      if (kindOf(id) === 'group') {
        const child = nameOf(id);
        if (child === name || this.groupChain(name).has(child)) throw new Error(`group "${child}" contains "${name}": that would make a cycle`);
        this.data.groups[child].parent = name;
        added.push(id);
        continue;
      }
      if (!this.data.edges.some((x) => x.from === id && x.rel === 'part_of' && x.to === gid)) this.data.edges.push({ from: id, rel: 'part_of', to: gid, ts: Date.now() });
      added.push(id);
    }
    const removed = [];
    for (const m of [].concat(remove || [])) {
      const id = this.resolveLoose(m);
      if (kindOf(id) === 'group' && this.data.groups[nameOf(id)]?.parent === name) { delete this.data.groups[nameOf(id)].parent; removed.push(id); continue; }
      const before = this.data.edges.length;
      this.data.edges = this.data.edges.filter((x) => !(x.from === id && x.rel === 'part_of' && x.to === gid));
      if (this.data.edges.length !== before) removed.push(id);
    }
    this.save({ action: 'group', group: name });
    return { group: name, parent: g.parent || null, added, removed, members: this.members(name).length };
  }
  /** Direct members of a group: assets (part_of edges) and child groups. */
  members(name) {
    const gid = `group:${name}`;
    const assets = (this.all().inn.get(gid) || []).filter((x) => x.rel === 'part_of').map((x) => x.from);
    const groups = Object.entries(this.data.groups).filter(([, g]) => g.parent === name).map(([n]) => `group:${n}`);
    return [...groups, ...assets];
  }
  /** Group nesting as edges too (child group part_of parent group), for traversal. */
  groupEdges() {
    return Object.entries(this.data.groups).filter(([, g]) => g.parent).map(([n, g]) => ({ from: `group:${n}`, rel: 'part_of', to: `group:${g.parent}`, derived: true }));
  }
  edgesOf(id) {
    const { out, inn } = this.all();
    const ge = this.groupEdges();
    return { out: [...(out.get(id) || []), ...ge.filter((x) => x.from === id)], in: [...(inn.get(id) || []), ...ge.filter((x) => x.to === id)] };
  }

  // ---------- compact text output ----------
  label(id) {
    const n = this.data.nodes[id];
    const g = kindOf(id) === 'group' ? this.data.groups[nameOf(id)] : null;
    const tags = n?.tags?.length ? ' ' + n.tags.map((t) => '#' + t).join(' ') : '';
    const note = n?.note || g?.note;
    const gone = this.exists(id) ? '' : ' (missing)';
    return `${id}${tags}${note ? ` "${note}"` : ''}${gone}`;
  }
  /** Short form of a neighbour id relative to the node it hangs off ("layer:hero/base" -> "base"). */
  shortId(id, owner) {
    const n = nameOf(id), on = nameOf(owner);
    if (['layer', 'anim', 'rigpart', 'modelpart', 'frame'].includes(kindOf(id)) && n.startsWith(on + '/')) return n.slice(on.length + 1);
    return id;
  }

  /** query {node, depth, rel, dir, limit} -> adjacency outline. */
  query({ node, depth = 1, rel, dir = 'both', limit = 12, max_chars = DEFAULT_CHARS }) {
    const root = this.resolveLoose(node);
    depth = Math.max(0, Math.min(4, Number(depth) || 0));
    const rels = rel ? new Set([].concat(rel)) : null;
    const lines = [this.label(root)];
    const seen = new Set([root]);
    let truncated = false;
    const walk = (id, d, indent) => {
      if (d >= depth) return;
      const { out, in: inn } = this.edgesOf(id);
      const pick = (list) => list.filter((x) => !rels || rels.has(x.rel));
      const rows = [];
      if (dir !== 'in') {
        // outgoing: one line per edge
        for (const x of pick(out)) rows.push({ text: `${x.rel}> ${this.labelBrief(x.to)}${fmtAttrs(x.attrs)}${x.label ? ` "${x.label}"` : ''}`, next: x.to });
      }
      if (dir !== 'out') {
        // incoming: grouped per relation ("<layer_of base, ink, shade")
        const by = new Map();
        for (const x of pick(inn)) { if (!by.has(x.rel)) by.set(x.rel, []); by.get(x.rel).push(x); }
        for (const [r, list] of by) {
          const leafy = list.every((x) => ['layer', 'anim', 'rigpart', 'modelpart'].includes(kindOf(x.from)));
          if (leafy || list.length > 3) {
            const names = list.map((x) => this.shortId(x.from, id) + fmtAttrs(x.attrs));
            const shown = names.slice(0, 16);
            rows.push({ text: `<${r} ${shown.join(', ')}${names.length > shown.length ? `, +${names.length - shown.length}` : ''}`, many: list.map((x) => x.from), leafy });
          } else for (const x of list) rows.push({ text: `<${r} ${this.labelBrief(x.from)}${fmtAttrs(x.attrs)}${x.label ? ` "${x.label}"` : ''}`, next: x.from });
        }
      }
      const shown = rows.slice(0, limit);
      for (const row of shown) {
        lines.push(`${indent}${row.text}`);
        const nexts = row.next ? [row.next] : row.leafy ? [] : row.many || [];
        for (const nx of nexts) {
          if (seen.has(nx)) continue;
          seen.add(nx);
          walk(nx, d + 1, indent + '  ');
        }
      }
      if (rows.length > shown.length) { lines.push(`${indent}… +${rows.length - shown.length} more (pass rel or limit)`); truncated = true; }
    };
    walk(root, 0, ' ');
    return this.cap(lines, max_chars, truncated);
  }
  /** id + tags + note, but no "(missing)" check cost for derived leaf nodes. */
  labelBrief(id) {
    const n = this.data.nodes[id];
    const g = kindOf(id) === 'group' ? this.data.groups[nameOf(id)] : null;
    const tags = n?.tags?.length ? ' ' + n.tags.map((t) => '#' + t).join(' ') : '';
    const note = n?.note || g?.note;
    return `${id}${tags}${note ? ` "${note}"` : ''}`;
  }
  cap(lines, max, truncated = false) {
    let text = lines.join('\n');
    if (text.length > max) {
      let n = 0, keep = [];
      for (const l of lines) { if (n + l.length + 1 > max - 40) break; keep.push(l); n += l.length + 1; }
      text = keep.join('\n') + `\n… (${lines.length - keep.length} more lines; narrow with rel/depth/limit or max_chars)`;
      truncated = true;
    }
    return { text, truncated };
  }

  /** Every node id the graph knows (assets + stored + edge endpoints). */
  allIds() {
    const e = this.engine, ids = new Set();
    for (const d of e.docs.values()) ids.add(`canvas:${d.name}`);
    for (const p of e.projects.values()) ids.add(`project:${p.name}`);
    for (const m of this.models().values()) ids.add(`model:${m.name}`);
    for (const n of this.audio()?.defs.keys() || []) ids.add(`audio:${n}`);
    for (const g of Object.keys(this.data.groups)) ids.add(`group:${g}`);
    for (const d of e.docs.values()) if (/_parts$/.test(d.name) && d.meta?.rig && typeof d.meta.rig === 'object') ids.add(`rig:${d.name.slice(0, -6)}`);
    for (const k of extraKinds()) { try { for (const n of assetType(k).list(e)) ids.add(`${k}:${n}`); } catch { /* skip */ } }
    for (const id of Object.keys(this.data.nodes)) ids.add(id);
    for (const ed of this.all().edges) { ids.add(ed.from); ids.add(ed.to); }
    return ids;
  }

  find({ tag, rel, text, kind, limit = 40, max_chars = DEFAULT_CHARS }) {
    const lines = [];
    if (rel && !tag && !text) {
      const list = this.all().edges.concat(this.groupEdges()).filter((x) => x.rel === rel && (!kind || kindOf(x.from) === kind || kindOf(x.to) === kind));
      for (const x of list.slice(0, limit)) lines.push(`${x.from} ${x.rel}> ${x.to}${fmtAttrs(x.attrs)}`);
      if (list.length > limit) lines.push(`… +${list.length - limit} more`);
      if (!list.length) lines.push(`no "${rel}" edges`);
      return this.cap(lines, max_chars);
    }
    const q = text ? String(text).toLowerCase() : null;
    const hits = [];
    for (const id of this.allIds()) {
      if (kind && kindOf(id) !== kind) continue;
      if (!tag && !q && !rel && !kind) break;
      const n = this.data.nodes[id];
      if (tag && !(n?.tags || []).includes(tag)) continue;
      if (q && !`${id} ${n?.note || ''} ${(n?.tags || []).join(' ')} ${kindOf(id) === 'group' ? this.data.groups[nameOf(id)]?.note || '' : ''}`.toLowerCase().includes(q)) continue;
      if (rel) { const { out, in: inn } = this.edgesOf(id); if (![...out, ...inn].some((x) => x.rel === rel)) continue; }
      hits.push(id);
    }
    if (!tag && !q && !rel && !kind) throw new Error('find needs tag, rel, text or kind');
    hits.sort();
    for (const id of hits.slice(0, limit)) lines.push(this.labelBrief(id));
    if (hits.length > limit) lines.push(`… +${hits.length - limit} more (pass limit)`);
    if (!hits.length) lines.push('no matches');
    return this.cap(lines, max_chars);
  }

  /** Shortest undirected path between two nodes (BFS, cycle safe). */
  path({ from, to, max_depth = 8 }) {
    const a = this.resolveLoose(from), b = this.resolveLoose(to);
    const prev = new Map([[a, null]]);
    let frontier = [a];
    for (let d = 0; d < max_depth && frontier.length && !prev.has(b); d++) {
      const next = [];
      for (const id of frontier) {
        const { out, in: inn } = this.edgesOf(id);
        for (const x of out) if (!prev.has(x.to)) { prev.set(x.to, { id, x, fwd: true }); next.push(x.to); }
        for (const x of inn) if (!prev.has(x.from)) { prev.set(x.from, { id, x, fwd: false }); next.push(x.from); }
      }
      frontier = next;
    }
    if (!prev.has(b)) return { text: `no path from ${a} to ${b} within ${max_depth} steps`, found: false };
    const steps = [];
    for (let cur = b; prev.get(cur); cur = prev.get(cur).id) steps.unshift({ cur, ...prev.get(cur) });
    let text = a;
    for (const s of steps) text += s.fwd ? ` ${s.x.rel}> ${s.cur}` : ` <${s.x.rel} ${s.cur}`;
    return { text, found: true, length: steps.length };
  }

  /** One-screen outline: groups (nested) with members, or the workspace overview. */
  summary({ group, max_chars = 2400 } = {}) {
    const lines = [];
    const seen = new Set();
    const rel1 = (id) => {
      // the most informative outgoing semantic edge, inline
      const { out } = this.edgesOf(id);
      const x = out.find((y) => !y.derived && y.rel !== 'part_of') || null;
      return x ? `  ${x.rel}> ${x.to}${fmtAttrs(x.attrs)}` : '';
    };
    const tree = (name, indent) => {
      const gid = `group:${name}`;
      if (seen.has(gid)) { lines.push(`${indent}${gid} (cycle)`); return; }
      seen.add(gid);
      const mem = this.members(name);
      lines.push(`${indent}${this.labelBrief(gid)} (${mem.length})`);
      for (const m of mem) {
        if (kindOf(m) === 'group') tree(nameOf(m), indent + '  ');
        else lines.push(`${indent}  ${this.labelBrief(m)}${rel1(m)}${this.exists(m) ? '' : ' (missing)'}`);
      }
    };
    if (group) {
      if (!this.data.groups[group]) throw new Error(`no group "${group}" (groups: ${Object.keys(this.data.groups).join(', ') || 'none'})`);
      tree(group, '');
      return this.cap(lines, max_chars);
    }
    const e = this.engine;
    const rigs = [...e.docs.values()].filter((d) => /_parts$/.test(d.name) && d.meta?.rig && typeof d.meta.rig === 'object').length;
    lines.push(`workspace: ${e.docs.size} canvases, ${rigs} rigs, ${this.models().size} models, ${this.audio()?.defs.size || 0} audio, ${e.projects.size} projects, ${Object.keys(this.data.groups).length} groups, ${this.data.edges.filter((x) => !x.auto).length} links, ${Object.keys(this.data.nodes).length} tagged/noted`);
    for (const [n, g] of Object.entries(this.data.groups)) if (!g.parent) tree(n, '');
    const projects = [...e.projects.values()].map((p) => `project:${p.name} (${e.projectDocs(p.name).length})`);
    if (projects.length) lines.push(`projects: ${projects.join(', ')}`);
    const tags = new Map();
    for (const n of Object.values(this.data.nodes)) for (const t of n.tags || []) tags.set(t, (tags.get(t) || 0) + 1);
    if (tags.size) lines.push(`tags: ${[...tags].sort((x, y) => y[1] - x[1]).slice(0, 30).map(([t, c]) => `#${t}(${c})`).join(' ')}`);
    if (!Object.keys(this.data.groups).length && !this.data.edges.some((x) => !x.auto)) lines.push('no groups or links yet: art_graph group {name, members} / link {from, rel, to}');
    return this.cap(lines, max_chars);
  }

  /** The whole graph for the web UI. */
  toJSON() {
    const ids = this.allIds();
    const e = this.engine;
    const reviewCounts = e.reviews?.counts() || {};
    for (const id of Object.keys(reviewCounts)) ids.add(id);
    let flags = null;
    try { flags = e.cleanup?.flags(); } catch { /* badges are best effort */ }
    const nodes = [...ids].map((id) => {
      const n = this.data.nodes[id];
      const k = kindOf(id);
      const out = { id, kind: k };
      if (n?.tags) out.tags = n.tags;
      if (n?.note) out.note = n.note;
      if (n?.approved) out.approved = true;
      if (reviewCounts[id]) out.reviews = reviewCounts[id];
      if (flags?.superseded.has(id)) out.superseded = true;
      if (flags?.orphans.has(id)) out.orphan = true;
      if (k === 'group') { const g = this.data.groups[nameOf(id)]; if (g?.note) out.note = g.note; if (g?.parent) out.parent = `group:${g.parent}`; }
      if (k === 'canvas') { const d = e.docs.get(nameOf(id)); if (d) out.version = `${d.version}-${d.updated}`; else out.missing = true; }
      else if (['model', 'audio', 'project', 'rig'].includes(k) && !this.exists(id)) out.missing = true;
      return out;
    });
    return { nodes, edges: [...this.all().edges, ...this.groupEdges()].map(({ ts, ...x }) => x), rels: RELS };
  }
  /** Relations of one node for the inspector. */
  nodeInfo(id) {
    const { out, in: inn } = this.edgesOf(id);
    const n = this.data.nodes[id] || {};
    return { id, exists: this.exists(id), tags: n.tags || [], note: n.note || (kindOf(id) === 'group' ? this.data.groups[nameOf(id)]?.note : undefined), out: out.map(({ ts, ...x }) => x), in: inn.map(({ ts, ...x }) => x) };
  }
}

/** Part fields that name a texture canvas. */
const TEX_KEYS = new Set(['texture', 'side', 'top', 'bottom', 'front', 'back', 'left', 'right', 'faces', 'emissive', 'overlay', 'overlays', 'base', 'variants', 'texture_top', 'texture_side']);

const textOut = (r) => ({ text: r.text });

export const GRAPH_OPS = {
  graph_link(a) {
    const { edge, isNew } = this.graph.link(a);
    return { text: `${isNew ? 'linked' : 'updated'} ${edge.from} ${edge.rel}> ${edge.to}${fmtAttrs(edge.attrs)}` };
  },
  graph_unlink(a) {
    const r = this.graph.unlink(a);
    return { text: r.length ? `removed ${r.length} edge(s): ${r.slice(0, 6).map((x) => `${x.from} ${x.rel}> ${x.to}`).join('; ')}` : 'no matching stored edge (derived edges follow the workspace and cannot be unlinked)' };
  },
  graph_tag(a) {
    const r = this.graph.tag(a);
    return { text: `${r.id} tags: ${r.tags.map((t) => '#' + t).join(' ') || '(none)'}` };
  },
  graph_note(a) {
    const r = this.graph.note(a);
    return { text: `${r.id} note: ${r.note ? `"${r.note}"` : '(cleared)'}` };
  },
  graph_group(a) {
    const r = this.graph.group(a);
    if (r.deleted) return { text: `deleted group:${r.group}` };
    return { text: `group:${r.group}${r.parent ? ` (in group:${r.parent})` : ''}: ${r.members} member(s)${r.added.length ? `, added ${r.added.join(', ')}` : ''}${r.removed.length ? `, removed ${r.removed.join(', ')}` : ''}` };
  },
  graph_query(a) {
    if (!a.node) throw new Error('query needs "node" (e.g. "helmet_front" or "group:Severance armour")');
    return textOut(this.graph.query(a));
  },
  graph_find(a) { return textOut(this.graph.find(a)); },
  graph_path(a) {
    if (!a.from || !a.to) throw new Error('path needs "from" and "to"');
    return textOut(this.graph.path(a));
  },
  graph_summary(a) { return textOut(this.graph.summary(a)); },
};
