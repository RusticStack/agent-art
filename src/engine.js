// Engine: canvas registry, persistence, operation dispatch, change events.
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { Doc, Layer, checkSize, COMMAND_NAMES } from './doc.js';
import { parseColor, toHex, makeRamp } from './color.js';
import { decodePNG, encodePNG } from './png.js';
import { createZip, readZip } from './zip.js';
import { renderSheet, packImages } from './sheet.js';
import { encodeGIF } from './gif.js';
import { critiqueImage, critiqueFrames } from './critique.js';
import { RIG_OPS } from './rigops.js';
import { MODEL_OPS } from './modelops.js';
import { FP_OPS } from './fpops.js';
import { FP2D_OPS } from './fp2dops.js';
import { LIB_OPS } from './libops.js';
import { SKIN2D_OPS } from './skin2dops.js';
import { AUDIO_OPS } from './audio/ops.js';
import { PLANET_OPS } from './space/ops.js';
import { FX_OPS } from './fx/ops.js';
import { Activity } from './activity.js';
import { Graph, GRAPH_OPS } from './graph.js';
import { Reviews, REVIEW_OPS } from './review.js';
import { Cleanup, CLEANUP_OPS } from './cleanup.js';
import crypto from 'node:crypto';

const NAME_RE = /^[A-Za-z0-9_\-.]{1,64}$/;

/** Java Edition resource pack_format by game version. */
const PACK_FORMATS = [
  ['1.6', 1], ['1.7', 1], ['1.8', 1], ['1.9', 2], ['1.10', 2], ['1.11', 3], ['1.12', 3], ['1.13', 4], ['1.14', 4],
  ['1.15', 5], ['1.16', 5], ['1.16.2', 6], ['1.16.3', 6], ['1.16.4', 6], ['1.16.5', 6], ['1.17', 7], ['1.18', 8],
  ['1.19', 9], ['1.19.3', 12], ['1.19.4', 13], ['1.20', 15], ['1.20.2', 18], ['1.20.3', 22], ['1.20.4', 22],
  ['1.20.5', 32], ['1.20.6', 32], ['1.21', 34], ['1.21.1', 34], ['1.21.2', 42], ['1.21.3', 42], ['1.21.4', 46],
  ['1.21.5', 55], ['1.21.6', 63], ['1.21.7', 64], ['1.21.8', 64],
];
export function packFormatFor(version) {
  const v = String(version).split('.').map(Number);
  let best = null;
  for (const [k, f] of PACK_FORMATS) {
    const kv = k.split('.').map(Number);
    const le = kv[0] < v[0] || (kv[0] === v[0] && (kv[1] < v[1] || (kv[1] === v[1] && (kv[2] || 0) <= (v[2] || 0))));
    if (le) best = f;
  }
  if (best === null) throw new Error(`Unknown Minecraft version ${version}`);
  return best;
}

export class Engine extends EventEmitter {
  constructor({ home, cwd }) {
    super();
    this.home = path.resolve(home);
    // "./x" and "../x" export paths resolve against this directory (the MCP server's working
    // directory: the user's project), bare relative paths against the workspace exports folder
    this.cwd = path.resolve(cwd ?? process.cwd());
    this.canvasDir = path.join(this.home, 'canvases');
    this.exportDir = path.join(this.home, 'exports');
    this.packDir = path.join(this.home, 'packs');
    this.projectDir = path.join(this.home, 'projects');
    this.vanillaDir = path.join(this.home, 'vanilla');
    for (const d of [this.canvasDir, this.exportDir, this.packDir, this.projectDir]) fs.mkdirSync(d, { recursive: true });
    this.docs = new Map();
    this.projects = new Map();
    this.jars = new Map();
    this.log = [];
    this.saveTimers = new Map();
    this.uiUrl = null;
    this.load();
    // timeline of ops / tool calls for the web UI, and the asset graph (relations, tags, groups)
    this.activity = new Activity(this);
    this.graph = new Graph(this);
    this.reviews = new Reviews(this, this.graph);
    // bulk, dependency-aware cleanup with a trash (art_cleanup); single deletes use its trash too
    this.cleanup = new Cleanup(this);
  }

  load() {
    for (const f of fs.readdirSync(this.projectDir)) {
      if (!f.endsWith('.json')) continue;
      try {
        const p = JSON.parse(fs.readFileSync(path.join(this.projectDir, f), 'utf8'));
        this.projects.set(p.name, p);
      } catch (e) {
        process.stderr.write(`[agent-art] could not load project ${f}: ${e.message}\n`);
      }
    }
    for (const f of fs.readdirSync(this.canvasDir)) {
      if (!f.endsWith('.json')) continue;
      try {
        const d = Doc.fromJSON(JSON.parse(fs.readFileSync(path.join(this.canvasDir, f), 'utf8')));
        this.attach(d);
      } catch (e) {
        process.stderr.write(`[agent-art] could not load ${f}: ${e.message}\n`);
      }
    }
  }

  /** Register a doc and wire its palette inheritance to its project. */
  attach(d) {
    d.inherit = () => (d.project && this.projects.get(d.project)?.palette) || null;
    this.docs.set(d.name, d);
    return d;
  }

  getProject(name) {
    const p = this.projects.get(name);
    if (!p) throw new Error(`No project "${name}". Existing: ${[...this.projects.keys()].join(', ') || '(none)'}`);
    return p;
  }
  saveProject(p, source = 'agent', label = 'project updated') {
    p.updated = Date.now();
    fs.writeFileSync(path.join(this.projectDir, `${p.name}.json`), JSON.stringify(p, null, 2));
    const ev = { type: 'project', project: p.name, source, label, ts: Date.now() };
    this.pushLog({ ...ev, canvas: p.name });
    this.emit('event', ev);
  }
  projectDocs(name) {
    return [...this.docs.values()].filter((d) => d.project === name).sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Load (downloading once from Mojang's official servers if needed) a vanilla client jar. */
  async vanillaJar(version) {
    if (this.jars.has(version)) return this.jars.get(version);
    const dir = path.join(this.vanillaDir, version);
    const file = path.join(dir, 'client.jar');
    if (!fs.existsSync(file)) {
      const manifest = await (await fetch('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json')).json();
      const v = manifest.versions.find((x) => x.id === version);
      if (!v) throw new Error(`Minecraft version ${version} not found in Mojang's manifest`);
      const meta = await (await fetch(v.url)).json();
      const dl = meta.downloads.client;
      const buf = Buffer.from(await (await fetch(dl.url)).arrayBuffer());
      const sha1 = crypto.createHash('sha1').update(buf).digest('hex');
      if (sha1 !== dl.sha1) throw new Error('Downloaded client jar failed its sha1 check');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, buf);
    }
    const zip = readZip(fs.readFileSync(file));
    this.jars.set(version, zip);
    return zip;
  }

  get(name) {
    if (!name) throw new Error('Missing "canvas" name');
    const d = this.docs.get(name);
    if (!d) throw new Error(`No canvas "${name}". Existing: ${[...this.docs.keys()].join(', ') || '(none)'}`);
    return d;
  }

  scheduleSave(doc) {
    clearTimeout(this.saveTimers.get(doc.name));
    this.saveTimers.set(doc.name, setTimeout(() => this.saveNow(doc), 250));
  }
  saveNow(doc) {
    this.saveTimers.delete(doc.name);
    if (this.docs.get(doc.name) !== doc) return;
    const file = path.join(this.canvasDir, `${doc.name}.json`);
    fs.writeFileSync(file + '.tmp', JSON.stringify(doc.toJSON()));
    fs.renameSync(file + '.tmp', file);
  }
  flush() {
    for (const [name, t] of this.saveTimers) {
      clearTimeout(t);
      const d = this.docs.get(name);
      if (d) this.saveNow(d);
    }
  }

  changed(doc, { op, source, label, dirty = null, structural = false }) {
    doc.touch?.();
    this.scheduleSave(doc);
    const ev = { type: 'change', canvas: doc.name, project: doc.project, version: doc.version, op, source, label, dirty, structural, ts: Date.now() };
    this.pushLog(ev);
    this.emit('event', ev);
  }
  pushLog(ev) {
    this.log.push(ev);
    if (this.log.length > 300) this.log.splice(0, this.log.length - 300);
  }

  resolvePath(p, baseDir) {
    if (!p) return null;
    if (path.isAbsolute(p)) return p;
    if (/^\.\.?([\\/]|$)/.test(p)) return path.resolve(this.cwd, p);
    return path.join(baseDir, p);
  }

  /** Reply note for a bare relative export path (it went to the workspace exports folder). */
  pathNote(p, file) {
    if (!p || path.isAbsolute(p) || /^\.\.?([\\/]|$)/.test(p)) return {};
    return { note: `relative path "${p}" was written under the workspace exports folder (${file}); use an absolute path, or "./${p.replace(/^[\\/]+/, '')}" for the server's working directory (${this.cwd})` };
  }

  /**
   * Run an operation. Returns a plain object; `image` (Buffer, PNG) when an image is produced.
   * ctx (optional): {call, tool} of the MCP tool call this op belongs to (activity timeline).
   */
  run(op, args = {}, source = 'agent', ctx = null) {
    const fn = OPS[op];
    if (!fn) throw new Error(`Unknown op "${op}". Valid: ${Object.keys(OPS).join(', ')}`);
    return this.activity.record(op, args, source, ctx, () => fn.call(this, args, source));
  }
  /** Run a read-only op without recording it in the activity timeline (UI reads). */
  peek(op, args = {}) {
    const fn = OPS[op];
    if (!fn) throw new Error(`Unknown op "${op}"`);
    return fn.call(this, args, 'user');
  }
}

const isRigPartsDoc = (d) => /_parts$/.test(d.name) && d.meta?.rig && typeof d.meta.rig === 'object';

function uiHint(engine, name) {
  return engine.uiUrl ? `${engine.uiUrl}/#${encodeURIComponent(name)}` : undefined;
}

function packRoot(engine, pack) {
  if (!pack) throw new Error('Missing "pack" (name under workspace/packs, or an absolute path)');
  return path.isAbsolute(pack) ? pack : path.join(engine.packDir, pack);
}

function walk(dir, base = dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, base, out);
    else out.push(path.relative(base, p).replace(/\\/g, '/'));
  }
  return out;
}

/** Resolve a canvas's meta.tint: a color, or {canvas, x, y} sampling a colormap canvas. */
function resolveTint(engine, d, override) {
  const t = override ?? d.meta?.tint;
  if (!t) return undefined;
  if (typeof t === 'string') return t;
  if (t.canvas) {
    const m = engine.get(t.canvas);
    const data = m.composite();
    const x = Math.max(0, Math.min(m.width - 1, Math.round(t.x ?? m.width / 2)));
    const y = Math.max(0, Math.min(m.height - 1, Math.round(t.y ?? m.height / 2)));
    const p = (y * m.width + x) * 4;
    return toHex([data[p], data[p + 1], data[p + 2], 255]);
  }
  return undefined;
}

function frameImage(d, f, scale = 1, opts = {}) {
  return d.render({ scale, frame: d.frameHeight ? f : undefined, ...opts });
}

const OPS = {
  list(a = {}) {
    return {
      canvases: [...this.docs.values()]
        .filter((d) => !a.project || d.project === a.project)
        .sort((x, y) => y.updated - x.updated)
        .map((d) => ({ name: d.name, project: d.project, width: d.width, height: d.height, frames: d.frames, layers: d.layers.length, version: d.version, updated: d.updated, texture: d.meta?.texture })),
      projects: [...this.projects.values()].map((p) => ({ name: p.name, description: p.description, canvases: this.projectDocs(p.name).length })),
      ui: this.uiUrl,
    };
  },

  // ---------- projects ----------
  project_create(a, source) {
    if (!NAME_RE.test(a.name || '')) throw new Error('Project "name" must be 1-64 chars of letters, digits, _ - .');
    if (this.projects.has(a.name) && !a.overwrite) throw new Error(`Project "${a.name}" exists`);
    const palette = {};
    for (const [k, v] of Object.entries(a.palette || {})) palette[k] = toHex(parseColor(v, palette));
    const p = { name: a.name, description: a.description || '', notes: a.notes || '', palette, meta: a.meta || {}, created: Date.now() };
    this.projects.set(p.name, p);
    this.saveProject(p, source, 'project created');
    return { project: p, ui: this.uiUrl ? `${this.uiUrl}/#project:${encodeURIComponent(p.name)}` : undefined };
  },

  project_update(a, source) {
    const p = this.getProject(a.name ?? a.project);
    if (a.description !== undefined) p.description = a.description;
    if (a.notes !== undefined) p.notes = a.notes;
    if (a.append_notes) p.notes = (p.notes ? p.notes + '\n' : '') + a.append_notes;
    if (a.meta) p.meta = { ...p.meta, ...a.meta };
    this.saveProject(p, source, 'project updated');
    return { project: p };
  },

  project_list() {
    return { projects: [...this.projects.values()].map((p) => ({ name: p.name, description: p.description, canvases: this.projectDocs(p.name).length, meta: p.meta })) };
  },

  project_info(a) {
    const p = this.getProject(a.name ?? a.project);
    return {
      ...p,
      canvases: this.projectDocs(p.name).map((d) => ({ name: d.name, size: `${d.width}x${d.frameHeight || d.height}`, frames: d.frames, meta: d.meta })),
      ui: this.uiUrl ? `${this.uiUrl}/#project:${encodeURIComponent(p.name)}` : undefined,
    };
  },

  project_delete(a, source) {
    const p = this.getProject(a.name ?? a.project);
    const docs = this.projectDocs(p.name);
    if (a.delete_canvases) for (const d of docs) OPS.delete.call(this, { canvas: d.name }, source);
    else for (const d of docs) { d.project = null; this.scheduleSave(d); }
    // the project file goes to the trash (art_cleanup restore), unless cleanup.trash_deletes is false
    const trash = this.cleanup.trashFiles('project', p.name, source, 'art_project delete');
    if (!trash) {
      this.projects.delete(p.name);
      fs.rmSync(path.join(this.projectDir, `${p.name}.json`), { force: true });
      const ev = { type: 'project', project: p.name, deleted: true, source, ts: Date.now() };
      this.emit('event', ev);
    }
    return { deleted: p.name, canvases: a.delete_canvases ? docs.length : 0, ...(trash ? { trash } : {}) };
  },

  meta(a, source) {
    const d = this.get(a.canvas);
    if (a.project !== undefined) {
      if (a.project) this.getProject(a.project);
      d.project = a.project || null;
    }
    if (a.meta) {
      for (const [k, v] of Object.entries(a.meta)) {
        if (v === null) delete d.meta[k];
        else d.meta[k] = v;
      }
    }
    this.changed(d, { op: 'meta', source, label: 'metadata', structural: true });
    return { canvas: d.name, project: d.project, meta: d.meta };
  },

  sheet(a) {
    let docs;
    if (a.canvases) docs = a.canvases.map((n) => this.get(n));
    else if (a.project) docs = this.projectDocs(this.getProject(a.project).name);
    else docs = [...this.docs.values()];
    // filter / exclude match canvas NAMES; texture_filter matches meta.texture
    if (a.filter) { const re = new RegExp(a.filter, 'i'); docs = docs.filter((d) => re.test(d.name)); }
    if (a.exclude) { const re = new RegExp(a.exclude, 'i'); docs = docs.filter((d) => !re.test(d.name)); }
    if (a.texture_filter) {
      const re = new RegExp(a.texture_filter, 'i');
      docs = docs.filter((d) => [].concat(d.meta?.texture || []).some((t) => re.test(t)));
    }
    const total = docs.length;
    const offset = a.offset ?? 0;
    docs = docs.slice(offset, a.limit ? offset + a.limit : undefined);
    if (!docs.length) throw new Error(`No canvases match (of ${total})`);
    const tints = new Map();
    if (a.apply_tint !== false) for (const d of docs) { const t = resolveTint(this, d); if (t) tints.set(d.name, t); }
    const subs = new Map();
    if (a.show_texture) for (const d of docs) if (d.meta?.texture) subs.set(d.name, [].concat(d.meta.texture)[0]);
    const img = renderSheet(docs, { scale: a.scale, columns: a.columns, labels: a.labels !== false, tile: a.tile ?? 1, tints, cell: a.cell, subs });
    return {
      count: docs.length, total, offset, scale: img.scale, cell: img.cell, columns: img.columns,
      tinted: tints.size ? [...tints.keys()] : undefined,
      names: docs.map((d) => d.name),
      image: encodePNG(img.width, img.height, img.data),
    };
  },

  /** Frames side by side (with frame numbers and durations) so motion can be checked at a glance. */
  filmstrip(a) {
    const d = this.get(a.canvas);
    const { frames, durations } = d.playback(a.animation);
    const fh = d.frameHeight || d.height;
    const scale = a.scale ?? Math.max(1, Math.min(16, Math.floor(160 / Math.max(d.width, fh))));
    const tint = resolveTint(this, d, a.tint);
    const items = frames.map((f, i) => ({
      img: frameImage(d, f, scale, { onion: a.onion ?? 0, tint, layer: a.layer, guide: a.guide }),
      label: `#${f}`,
      // durations only mean something for a tagged animation (untagged frames have no timing)
      sub: a.animation ? `${durations[i]}MS` : null,
    }));
    const img = packImages(items, { columns: a.columns ?? Math.min(items.length, 8), labels: a.labels !== false });
    return { canvas: d.name, animation: a.animation, frames, durations, scale, image: encodePNG(img.width, img.height, img.data) };
  },

  /** Animation tags and frame operations on a frame strip. */
  animation(a, source) {
    const d = this.get(a.canvas);
    const action = a.action || 'list';
    if (action === 'list') return { frames: d.frames, frameHeight: d.frameHeight || d.height, animations: d.animations };
    d.checkpoint(`animation ${action}`);
    let msg;
    try {
      const n = d.frames;
      const order = [...Array(n).keys()];
      const idx = (v, name, max = n - 1) => {
        const i = Number(v);
        if (!Number.isInteger(i) || i < 0 || i > max) throw new Error(`"${name}" must be a frame index 0..${max}`);
        return i;
      };
      if (action === 'tag') {
        const t = d.setAnimation(a.name, a);
        msg = `animation "${a.name}": ${t.frames.length} frames`;
      } else if (action === 'untag') {
        if (!d.animations[a.name]) throw new Error(`No animation "${a.name}"`);
        delete d.animations[a.name];
        msg = `removed animation "${a.name}"`;
      } else if (action === 'insert') {
        // insert `count` frames at `at` (default end), blank or copies of `copy_from`
        d.ensureFrames();
        const at = a.at === undefined ? n : idx(a.at, 'at', n);
        const count = Math.max(1, Number(a.count ?? 1));
        const src = a.copy_from === undefined ? -1 : idx(a.copy_from, 'copy_from');
        order.splice(at, 0, ...Array(count).fill(src));
        d.reorderFrames(order);
        msg = `inserted ${count} frame(s) at ${at}`;
      } else if (action === 'delete') {
        if (n <= 1) throw new Error('Cannot delete the only frame');
        const list = [].concat(a.frames ?? a.frame).map((f) => idx(f, 'frame'));
        d.reorderFrames(order.filter((f) => !list.includes(f)));
        msg = `deleted frame(s) ${list.join(', ')}`;
      } else if (action === 'duplicate') {
        d.ensureFrames();
        const f = idx(a.frame, 'frame');
        const to = a.to === undefined ? f + 1 : idx(a.to, 'to', n);
        order.splice(to, 0, f);
        d.reorderFrames(order);
        msg = `duplicated frame ${f} to ${to}`;
      } else if (action === 'move') {
        const f = idx(a.frame, 'frame'), to = idx(a.to, 'to');
        order.splice(f, 1);
        order.splice(to, 0, f);
        d.reorderFrames(order);
        msg = `moved frame ${f} to ${to}`;
      } else if (action === 'set_frame_size') {
        const fh = Number(a.frame_height);
        if (!fh || d.height % fh !== 0) throw new Error(`frame_height must divide the canvas height (${d.height})`);
        d.frameHeight = fh < d.height ? fh : null;
        msg = `frame height ${fh}`;
      } else throw new Error('animation action must be list, tag, untag, insert, delete, duplicate, move or set_frame_size');
    } catch (e) {
      d.restore(d.undoStack.pop());
      throw e;
    }
    this.changed(d, { op: 'animation', source, label: msg, structural: true });
    return { message: msg, frames: d.frames, animations: d.animations };
  },

  /** Export an animation: gif, spritesheet (png + json, Aseprite-style), or numbered frame pngs. */
  export_animation(a) {
    const d = this.get(a.canvas);
    const format = a.format || 'gif';
    const scale = a.scale ?? 1;
    const fh = d.frameHeight || d.height;
    const tint = resolveTint(this, d, a.tint);
    const stem = `${d.name}${a.animation ? '_' + a.animation : ''}`;
    let base = this.resolvePath(a.path || stem, this.exportDir).replace(/\.(gif|png|json)$/i, '');
    // a folder (existing, or path ending in / or \) gets <folder>/<canvas>.png|json|gif
    if (a.path && (/[\\/]$/.test(a.path) || (fs.existsSync(base) && fs.statSync(base).isDirectory()))) base = path.join(base, stem);
    fs.mkdirSync(path.dirname(base), { recursive: true });
    if (format === 'gif') {
      const { frames, durations } = d.playback(a.animation);
      const imgs = frames.map((f, i) => ({ data: frameImage(d, f, scale, { tint, background: a.background }).data, delay: durations[i] }));
      const loop = a.animation ? d.animations[a.animation].loop : true;
      const gif = encodeGIF(d.width * scale, fh * scale, imgs, { loop });
      fs.writeFileSync(base + '.gif', gif);
      return { file: base + '.gif', frames: frames.length, bytes: gif.length, ...this.pathNote(a.path, base + '.gif') };
    }
    if (format === 'frames') {
      const { frames } = d.playback(a.animation);
      const files = frames.map((f, i) => {
        const img = frameImage(d, f, scale, { tint });
        const file = `${base}_${String(i).padStart(3, '0')}.png`;
        fs.writeFileSync(file, encodePNG(img.width, img.height, img.data));
        return file;
      });
      return { files, ...this.pathNote(a.path, path.dirname(base)) };
    }
    if (format === 'spritesheet' && a.layout === 'files') {
      // one horizontal strip (+ json) per animation tag: <base>_<tag>.png (game engines that load
      // one strip per animation)
      const tags = a.animation ? [a.animation] : Object.keys(d.animations);
      if (!tags.length) throw new Error(`canvas "${d.name}" has no animation tags (layout:"files" writes one strip per tag; use layout:"strip")`);
      const stemBase = a.animation ? base.replace(new RegExp(`_${a.animation}$`), '') : base;
      const files = tags.map((t) => this.run('export_animation', { ...a, layout: 'rows', animation: t, path: `${stemBase}_${t}`, _inner: true }));
      return { files: files.map((f) => f.png), json: a.json !== false ? files.map((f) => f.json) : undefined, layout: 'files', strips: files.length, ...this.pathNote(a.path, stemBase) };
    }
    if (format === 'spritesheet') {
      // one row per animation tag (or one row of all frames), plus an Aseprite-compatible JSON
      const tags = a.animation ? [a.animation] : Object.keys(d.animations);
      const rows = tags.length ? tags.map((t) => ({ name: t, ...d.playback(t), tag: d.animations[t] })) : [{ name: null, ...d.playback(null) }];
      const uniqueRows = a.layout === 'strip' ? [{ name: null, ...d.playback(null) }] : rows;
      const cols = Math.max(...uniqueRows.map((r) => r.frames.length));
      const fw = d.width * scale, fhh = fh * scale;
      const W = cols * fw, H = uniqueRows.length * fhh;
      checkSize(W, H);
      const sheet = new Uint8ClampedArray(W * H * 4);
      const json = { frames: {}, meta: { app: 'agent-art', image: path.basename(base) + '.png', size: { w: W, h: H }, scale: String(scale), frameTags: [] } };
      let k = 0;
      uniqueRows.forEach((r, ri) => {
        const start = k;
        r.frames.forEach((f, ci) => {
          const img = frameImage(d, f, scale, { tint });
          for (let y = 0; y < fhh; y++) sheet.set(img.data.subarray(y * fw * 4, (y + 1) * fw * 4), ((ri * fhh + y) * W + ci * fw) * 4);
          const an = r.name && d.meta?.anchors?.[r.name]?.[ci];
          const ord = r.name && d.meta?.order?.[r.name]?.[ci];
          const evs = r.name ? (d.meta?.events?.[r.name] || []).filter((e) => e.frame === ci).map((e) => e.name) : [];
          json.frames[`${d.name}${r.name ? '_' + r.name : ''}_${ci}`] = { frame: { x: ci * fw, y: ri * fhh, w: fw, h: fhh }, sourceFrame: f, duration: r.durations[ci], ...(an ? { anchors: Object.fromEntries(Object.entries(an).map(([k, [x, y, rot]]) => [k, { x: x * scale, y: y * scale, rot }])) } : {}), ...(ord ? { order: ord } : {}), ...(evs.length ? { events: evs } : {}) };
          k++;
        });
        if (r.name) json.meta.frameTags.push({ name: r.name, from: start, to: k - 1, direction: r.tag.direction, loop: r.tag.loop, row: ri });
      });
      // strip layout: one row of every frame, but keep the tags (frame ranges into that row)
      if (a.layout === 'strip') for (const [t, tag] of Object.entries(d.animations)) {
        const fr = [...tag.frames].sort((x, y) => x - y);
        json.meta.frameTags.push({ name: t, from: fr[0], to: fr[fr.length - 1], direction: tag.direction, loop: tag.loop, row: 0 });
      }
      fs.writeFileSync(base + '.png', encodePNG(W, H, sheet));
      // json:false = png only (no Aseprite-style sidecar)
      const writeJson = a.json !== false;
      if (writeJson) fs.writeFileSync(base + '.json', JSON.stringify(json, null, 2));
      // say how the sheet is laid out: several tags stack as rows unless asked otherwise
      const layoutNote = !a._inner && uniqueRows.length > 1 ? { layout: 'rows', layout_note: `${uniqueRows.length} tags exported as ${uniqueRows.length} rows (one per tag); layout:"files" writes one horizontal strip per tag, layout:"strip" puts every frame in one row` } : {};
      return { png: base + '.png', json: writeJson ? base + '.json' : undefined, size: `${W}x${H}`, rows: uniqueRows.length, frames: k, ...layoutNote, ...(a._inner ? {} : this.pathNote(a.path, base + '.png')) };
    }
    throw new Error('format must be gif, spritesheet or frames');
  },

  /** Generate a normal map (for dynamic 2.5D lighting in game engines) as a new canvas. */
  normal_map(a, source) {
    const d = this.get(a.canvas);
    const name = a.new_name || `${d.name}_n`;
    if (!NAME_RE.test(name)) throw new Error('Bad new_name');
    const W = d.width, H = d.height;
    const src = d.composite();
    const strength = a.strength ?? 2;
    const bevel = Math.max(0, a.bevel ?? 3);
    const mix = a.luminance ?? 0.5; // 0 = shape only (edge bevel), 1 = brightness only
    const alpha = (x, y) => (x < 0 || y < 0 || x >= W || y >= H ? 0 : src[(y * W + x) * 4 + 3] > 0 ? 1 : 0);
    // distance to the nearest transparent pixel (capped at bevel) => rounded "pillow" height
    const dist = new Float32Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      if (!alpha(x, y)) continue;
      let best = bevel;
      for (let r = 1; r <= bevel && best === bevel; r++) {
        for (let k = -r; k <= r; k++) {
          if (!alpha(x + k, y - r) || !alpha(x + k, y + r) || !alpha(x - r, y + k) || !alpha(x + r, y + k)) { best = r - 1; break; }
        }
      }
      dist[y * W + x] = bevel ? best / bevel : 1;
    }
    const hgt = (x, y) => {
      x = Math.max(0, Math.min(W - 1, x)); y = Math.max(0, Math.min(H - 1, y));
      const p = (y * W + x) * 4;
      if (!src[p + 3]) return 0;
      const l = (0.2126 * src[p] + 0.7152 * src[p + 1] + 0.0722 * src[p + 2]) / 255;
      return (1 - mix) * Math.sqrt(dist[y * W + x]) + mix * l;
    };
    const out = new Uint8ClampedArray(W * H * 4);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const p = (y * W + x) * 4;
      if (!src[p + 3]) continue;
      const dx = (hgt(x + 1, y - 1) + 2 * hgt(x + 1, y) + hgt(x + 1, y + 1)) - (hgt(x - 1, y - 1) + 2 * hgt(x - 1, y) + hgt(x - 1, y + 1));
      const dy = (hgt(x - 1, y + 1) + 2 * hgt(x, y + 1) + hgt(x + 1, y + 1)) - (hgt(x - 1, y - 1) + 2 * hgt(x, y - 1) + hgt(x + 1, y - 1));
      let nx = -dx * strength, ny = (a.invert_y ? 1 : -1) * dy * strength, nz = 1;
      const len = Math.hypot(nx, ny, nz);
      nx /= len; ny /= len; nz /= len;
      out[p] = Math.round((nx * 0.5 + 0.5) * 255);
      out[p + 1] = Math.round((ny * 0.5 + 0.5) * 255);
      out[p + 2] = Math.round((nz * 0.5 + 0.5) * 255);
      out[p + 3] = src[p + 3];
    }
    const n = new Doc({ name, width: W, height: H, frameHeight: d.frameHeight });
    n.layers[0].data.set(out);
    n.project = d.project;
    n.meta = { normal_map_of: d.name, build: false };
    if (this.docs.has(name) && !a.overwrite) throw new Error(`Canvas "${name}" exists (pass overwrite: true)`);
    this.attach(n);
    this.changed(n, { op: 'normal_map', source, label: `normal map of ${d.name}`, structural: true });
    return { created: n.info().name, size: `${W}x${H}` };
  },

  create(a, source) {
    const name = a.name;
    if (!NAME_RE.test(name || '')) throw new Error('Canvas "name" must be 1-64 chars of letters, digits, _ - .');
    if (this.docs.has(name) && !a.overwrite) throw new Error(`Canvas "${name}" exists (pass overwrite: true to replace)`);
    const width = Number(a.width ?? 16), frameH = Number(a.height ?? width);
    const frames = Math.max(1, Number(a.frames ?? 1));
    checkSize(width, frameH * frames);
    const d = new Doc({ name, width, height: frameH * frames, frameHeight: frames > 1 ? frameH : null });
    if (a.project) { this.getProject(a.project); d.project = a.project; }
    if (a.meta) d.meta = { ...a.meta };
    if (a.palette) for (const [k, v] of Object.entries(a.palette)) d.palette[k] = toHex(parseColor(v));
    if (a.background && a.background !== 'transparent') {
      const c = parseColor(a.background, d.palette);
      for (let p = 0; p < d.layers[0].data.length; p += 4) d.layers[0].data.set(c, p);
    }
    this.attach(d);
    this.changed(d, { op: 'create', source, label: `created ${width}x${frameH}${frames > 1 ? ` x${frames} frames` : ''}`, structural: true });
    return { created: d.info(), ui: uiHint(this, name) };
  },

  delete(a, source) {
    const d = this.get(a.canvas);
    // the canvas file goes to the trash (art_cleanup restore), unless cleanup.trash_deletes is false
    const trash = this.cleanup.trashFiles(isRigPartsDoc(d) ? 'rig' : 'canvas', isRigPartsDoc(d) ? d.name.slice(0, -6) : d.name, source, 'art_canvas delete');
    if (trash) return { deleted: d.name, trash };
    this.docs.delete(d.name);
    clearTimeout(this.saveTimers.get(d.name));
    fs.rmSync(path.join(this.canvasDir, `${d.name}.json`), { force: true });
    const ev = { type: 'deleted', canvas: d.name, source, ts: Date.now() };
    this.pushLog(ev);
    this.emit('event', ev);
    return { deleted: d.name };
  },

  duplicate(a, source) {
    const d = this.get(a.canvas);
    if (!NAME_RE.test(a.new_name || '')) throw new Error('"new_name" must be 1-64 chars of letters, digits, _ - .');
    if (this.docs.has(a.new_name) && !a.overwrite) throw new Error(`Canvas "${a.new_name}" exists`);
    const n = Doc.fromJSON({ ...d.toJSON(), name: a.new_name });
    if (a.meta) n.meta = { ...n.meta, ...a.meta };
    this.attach(n);
    this.changed(n, { op: 'duplicate', source, label: `copied from ${d.name}`, structural: true });
    return { created: n.info(), ui: uiHint(this, n.name) };
  },

  info(a) {
    const d = this.get(a.canvas);
    return { ...d.info(), colors: d.colorStats(a.color_limit ?? 32), ui: uiHint(this, d.name) };
  },

  draw(a, source) {
    const d = this.get(a.canvas);
    if (a.commands_file) {
      // commands from a JSON file: [cmd, ...] or {commands:[...]}; inline commands run after them
      const file = path.resolve(a.commands_file);
      let j;
      try { j = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { throw new Error(`commands_file ${file}: ${e.message}`); }
      const list = Array.isArray(j) ? j : j?.commands;
      if (!Array.isArray(list)) throw new Error(`commands_file ${file} must hold a JSON array of commands or {"commands":[...]}`);
      a = { ...a, commands: [...list, ...(a.commands || [])] };
    }
    const size0 = `${d.width}x${d.height}x${d.frameHeight}`;
    const r = d.execute(a.commands, { layer: a.layer, frame: a.frame, label: a.label, resolveDoc: (n) => this.get(n) });
    // rotate {expand:true} can grow the canvas: tell the UI to reload the whole document
    const grew = size0 !== `${d.width}x${d.height}x${d.frameHeight}`;
    this.changed(d, { op: 'draw', source, label: a.label || a.commands.map((c) => c.op).join(', '), dirty: grew ? null : r.dirty, structural: grew });
    return { canvas: d.name, version: d.version, commands: a.commands.length, dirty: r.dirty, frames: r.frames, notes: r.notes.length ? r.notes : undefined };
  },

  layer(a, source) {
    const d = this.get(a.canvas);
    d.checkpoint(`layer ${a.action}`);
    let msg;
    try {
      msg = d.layerAction(a);
    } catch (e) {
      d.undoStack.pop();
      throw e;
    }
    this.changed(d, { op: 'layer', source, label: msg, structural: true });
    return { message: msg, layers: d.info().layers, activeLayer: d.active };
  },

  palette(a, source) {
    const action = a.action || 'get';
    let d;
    if (a.project && !a.canvas) {
      // a project palette is shared by every canvas in the project (canvas palettes override it)
      const p = this.getProject(a.project);
      const pd = new Doc({ name: '_', width: 1, height: 1 });
      pd.palette = p.palette;
      d = pd;
      d.isProject = p;
    } else d = this.get(a.canvas);
    if (action === 'get') return { palette: d.palette, inherited: d.isProject ? undefined : d.inherit?.() || undefined };
    d.checkpoint(`palette ${action}`);
    let added = {};
    if (action === 'set') {
      if (!a.colors || typeof a.colors !== 'object') throw new Error('"set" needs colors: {key: color}');
      for (const [k, v] of Object.entries(a.colors)) {
        if (!k || k === '.' || k === ' ') throw new Error(`Palette key "${k}" is reserved`);
        added[k] = d.palette[k] = toHex(parseColor(v, d.fullPalette));
      }
    } else if (action === 'remove') {
      for (const k of a.keys || []) delete d.palette[k];
    } else if (action === 'clear') {
      d.palette = {};
    } else if (action === 'ramp') {
      const ramp = makeRamp(parseColor(a.base, d.fullPalette), { steps: a.steps ?? 5, hueShift: a.hue_shift ?? 18, spread: a.spread ?? 0.5, saturationShift: a.saturation_shift ?? 0.08 });
      const keys = a.keys || ramp.map((_, i) => `${a.prefix || 'r'}${i}`);
      if (keys.length !== ramp.length) throw new Error('"keys" length must equal "steps"');
      keys.forEach((k, i) => (added[k] = d.palette[k] = ramp[i]));
    } else {
      d.undoStack.pop();
      throw new Error('palette action must be get, set, remove, clear or ramp');
    }
    if (d.isProject) {
      d.isProject.palette = d.palette;
      this.saveProject(d.isProject, source, `project palette ${action}`);
      for (const pd of this.projectDocs(d.isProject.name)) this.changed(pd, { op: 'palette', source, label: `project palette ${action}`, structural: true });
      return { added: Object.keys(added).length ? added : undefined, palette: d.palette };
    }
    this.changed(d, { op: 'palette', source, label: `palette ${action}`, structural: true });
    const multi = Object.keys(added).some((k) => k.length > 1);
    return { added: Object.keys(added).length ? added : undefined, palette: d.palette, ...(multi ? { tip: 'multi-char keys: use them as colors ("color":"r2") or in grid with cpp:2 (rows like "r0r1r2"), or map 1-char legend keys to them: legend {"1":"r1"}' } : {}) };
  },

  transform(a, source) {
    const d = this.get(a.canvas);
    d.checkpoint(`transform ${a.action}`);
    try {
      if (a.action === 'resize') d.resize(a.width, a.height, a.anchor || 'top-left');
      else if (a.action === 'scale') {
        if (a.method === 'scale2x' || a.method === 'epx') d.upscaleEPX(a.factor ?? 2);
        else if (a.method && a.method !== 'nearest') throw new Error('scale method must be "nearest" (default) or "scale2x" (clean pixel-art upscale; factor 2,3,4,6,8)');
        else if (a.factor) d.scaleTo(Math.round(d.width * a.factor), Math.round(d.height * a.factor));
        else d.scaleTo(a.width, a.height);
      } else if (a.action === 'crop') d.crop(a.x ?? 0, a.y ?? 0, a.w, a.h);
      else if (a.action === 'set_frames') {
        const fh = Number(a.frame_height);
        if (!fh || d.height % fh !== 0) throw new Error(`frame_height must divide the canvas height (${d.height})`);
        d.frameHeight = fh < d.height ? fh : null;
      } else if (a.action === 'add_frame') {
        if (!d.frameHeight) d.frameHeight = d.height;
        const fh = d.frameHeight, src = a.copy_from;
        d.resize(d.width, d.height + fh, 'top-left');
        if (src !== undefined && src !== null) {
          for (const l of d.layers) {
            const start = Number(src) * fh * d.width * 4;
            l.data.copyWithin((d.height - fh) * d.width * 4, start, start + fh * d.width * 4);
          }
        }
      } else throw new Error('transform action must be resize, scale, crop, set_frames or add_frame');
    } catch (e) {
      d.restore(d.undoStack.pop());
      throw e;
    }
    this.changed(d, { op: 'transform', source, label: a.action, structural: true });
    return d.info();
  },

  undo(a, source) {
    const d = this.get(a.canvas);
    const labels = a.redo ? d.redo(a.steps ?? 1) : d.undo(a.steps ?? 1);
    if (!labels.length) throw new Error(`nothing to ${a.redo ? 'redo' : 'undo'} on "${a.canvas}" — history lives in the running process; one-shot CLI calls only keep it while an "agent-art serve" is running`);
    if (labels.length) this.changed(d, { op: a.redo ? 'redo' : 'undo', source, label: `${a.redo ? 'redo' : 'undo'}: ${labels.join(' | ')}`, structural: true });
    return { [a.redo ? 'redone' : 'undone']: labels, undo: d.undoStack.length, redo: d.redoStack.length };
  },

  /** Automatic pixel-art review: actionable issues with coordinates (+ animation consistency). */
  critique(a) {
    const d = this.get(a.canvas);
    const fh = d.frameHeight || d.height;
    const opts = { kind: a.kind, tileable: a.tileable, maxColors: a.max_colors, style: a.style };
    const frameList = a.frame !== undefined ? [Number(a.frame)] : a.animation ? [...new Set(d.playback(a.animation).frames)] : [...Array(d.frames).keys()];
    const datas = frameList.map((f) => (d.frameHeight ? d.frameData(f, { layer: a.layer }) : d.composite({ layer: a.layer })));
    // review the first frame in detail (or every frame with all_frames), plus cross-frame consistency
    const detail = a.all_frames ? frameList : [frameList[0]];
    const out = { canvas: d.name, size: `${d.width}x${fh}` };
    const per = detail.map((f) => ({ frame: d.frameHeight ? f : undefined, ...critiqueImage(datas[frameList.indexOf(f)], d.width, fh, opts) }));
    if (per.length === 1) Object.assign(out, per[0]);
    else out.frames_detail = per;
    if (datas.length > 1) out.animation = critiqueFrames(datas, d.width, fh);
    const all = [...per.flatMap((p) => p.issues), ...(out.animation?.issues || [])];
    out.summary = all.length ? `${all.length} issue(s): ${all.map((i) => i.id).join(', ')}` : 'No automatic issues found — still look at it (art_view) for style and readability.';
    return out;
  },

  read(a) {
    const d = this.get(a.canvas);
    return d.read({ x: a.x, y: a.y, w: a.w, h: a.h, layer: a.layer, frame: a.frame });
  },

  render(a) {
    const d = this.get(a.canvas);
    const tile = a.tile ?? 1;
    const fh = a.frame !== undefined && d.frameHeight ? d.frameHeight : d.height;
    const region = a.x !== undefined || a.y !== undefined || a.w !== undefined || a.h !== undefined ? { x: a.x, y: a.y, w: a.w, h: a.h } : undefined;
    // view size in art pixels
    const vw = region ? (a.w ?? d.width - (a.x ?? 0)) : d.width * tile, vh = region ? (a.h ?? fh - (a.y ?? 0)) : fh * tile;
    // Image tokens grow with image area, and a 16 px sprite holds no more information at 768 px
    // than at 256 px: default to ~512 px max and at most 16 screen px per art pixel.
    const target = a.max_size ?? 512;
    const big = Math.max(vw, vh);
    const tint = a.apply_tint ? resolveTint(this, d, a.tint) : a.tint;
    const opts = { tile, layer: a.layer, frame: a.frame, region, tint, onion: a.onion ?? 0, guide: a.guide, background: a.background ?? 'checker' };
    if (a.scale === undefined && big > target * 1.25) {
      // overview of a large canvas: area-average downsample (zoom in with x,y,w,h for exact pixels)
      const k = Math.ceil(big / target);
      const img = d.render({ ...opts, scale: 1, grid: false });
      const W = Math.ceil(img.width / k), H = Math.ceil(img.height / k);
      const out = new Uint8ClampedArray(W * H * 4);
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const acc = [0, 0, 0, 0];
        let n = 0;
        for (let yy = y * k; yy < Math.min(img.height, y * k + k); yy++) for (let xx = x * k; xx < Math.min(img.width, x * k + k); xx++) {
          const p = (yy * img.width + xx) * 4;
          for (let c = 0; c < 4; c++) acc[c] += img.data[p + c];
          n++;
        }
        out.set(acc.map((v) => Math.round(v / n)), (y * W + x) * 4);
      }
      return { canvas: d.name, width: d.width, height: d.height, frames: d.frames, scale: `1/${k}`, note: `overview downsampled 1/${k}; pass x,y,w,h to zoom into exact pixels`, image: encodePNG(W, H, out) };
    }
    const used = a.scale ?? Math.max(1, Math.min(16, Math.floor(target / big)));
    if (a.scale === undefined && tile > 1 && used < 16 && big * used < target * 0.75) {
      // tiled seam checks: integer scale would waste most of max_size (192 px for 3x64 in 300):
      // render one step larger and nearest-neighbour downscale to fit max_size
      const img = d.render({ ...opts, scale: used + 1, grid: false });
      const k = Math.min(target / img.width, target / img.height);
      const W = Math.max(1, Math.floor(img.width * k)), H = Math.max(1, Math.floor(img.height * k));
      const out = new Uint8ClampedArray(W * H * 4);
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const s = (Math.min(img.height - 1, Math.floor(y / k)) * img.width + Math.min(img.width - 1, Math.floor(x / k))) * 4;
        out.set(img.data.subarray(s, s + 4), (y * W + x) * 4);
      }
      const sc = Math.round((W / vw) * 100) / 100;
      return { canvas: d.name, width: d.width, height: d.height, frames: d.frames, scale: sc, note: `tiled view fitted to max_size: ~${sc} screen px per art pixel (nearest neighbour)`, tint, image: encodePNG(W, H, out) };
    }
    const png = d.toPNG({ ...opts, scale: used, grid: a.grid ?? used >= 8 });
    return { canvas: d.name, width: d.width, height: d.height, frames: d.frames, scale: used, tint, image: png };
  },

  import(a, source) {
    let buf;
    if (a.path) buf = fs.readFileSync(a.path);
    else if (a.base64) buf = Buffer.from(a.base64.replace(/^data:image\/png;base64,/, ''), 'base64');
    else throw new Error('import needs "path" or "base64"');
    const img = decodePNG(buf);
    if (a.canvas && this.docs.has(a.canvas) && a.as_layer) {
      const d = this.get(a.canvas);
      if (img.width !== d.width || img.height !== d.height) throw new Error(`Image is ${img.width}x${img.height}, canvas is ${d.width}x${d.height}`);
      d.checkpoint('import layer');
      const l = new Layer(a.as_layer, d.width, d.height, img.data);
      d.layers.splice(d.active + 1, 0, l);
      d.active += 1;
      this.changed(d, { op: 'import', source, label: `imported layer ${a.as_layer}`, structural: true });
      return d.info();
    }
    const name = a.canvas || path.basename(a.path || 'imported', '.png').replace(/[^A-Za-z0-9_\-.]/g, '_');
    if (!NAME_RE.test(name)) throw new Error('Bad canvas name');
    if (this.docs.has(name) && !a.overwrite) throw new Error(`Canvas "${name}" exists (pass overwrite: true)`);
    checkSize(img.width, img.height);
    let frameHeight = a.frame_height ? Number(a.frame_height) : null;
    if (!frameHeight && a.path && fs.existsSync(a.path + '.mcmeta') && img.height > img.width && img.height % img.width === 0) frameHeight = img.width;
    const d = new Doc({ name, width: img.width, height: img.height, frameHeight });
    d.layers[0].data.set(img.data);
    if (a.project) { this.getProject(a.project); d.project = a.project; }
    if (a.meta) d.meta = { ...a.meta };
    this.attach(d);
    this.changed(d, { op: 'import', source, label: `imported ${img.width}x${img.height}`, structural: true });
    return { created: d.info(), colors: d.colorStats(16), ui: uiHint(this, name) };
  },

  export(a) {
    const d = this.get(a.canvas);
    const file = this.resolvePath(a.path || `${d.name}${a.frame !== undefined ? `_f${a.frame}` : ''}.png`, this.exportDir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const png = d.toPNG({ scale: a.scale ?? 1, frame: a.frame, layer: a.layer, tile: a.tile ?? 1 });
    fs.writeFileSync(file, png);
    return { file, bytes: png.length, size: `${d.width * (a.scale ?? 1)}x${(a.frame !== undefined && d.frameHeight ? d.frameHeight : d.height) * (a.scale ?? 1)}`, ...this.pathNote(a.path, file) };
  },

  // ---------- Minecraft resource packs ----------
  pack_init(a) {
    const root = packRoot(this, a.pack);
    fs.mkdirSync(path.join(root, 'assets', 'minecraft', 'textures'), { recursive: true });
    const fmt = a.pack_format ?? (a.minecraft ? packFormatFor(a.minecraft) : 64);
    const meta = { pack: { pack_format: fmt, description: a.description ?? 'Made with Agent Art' } };
    if (a.supported_formats) meta.pack.supported_formats = a.supported_formats;
    if (a.min_format !== undefined) meta.pack.min_format = a.min_format;
    if (a.max_format !== undefined) meta.pack.max_format = a.max_format;
    fs.writeFileSync(path.join(root, 'pack.mcmeta'), JSON.stringify(meta, null, 2));
    return { pack: root, mcmeta: meta };
  },

  pack_add(a) {
    const root = packRoot(this, a.pack);
    if (!fs.existsSync(path.join(root, 'pack.mcmeta'))) throw new Error(`No pack.mcmeta in ${root}; run pack init first`);
    const d = this.get(a.canvas);
    if (!a.texture) throw new Error('Missing "texture", e.g. "block/stone" or "item/diamond_sword"');
    let ns = 'minecraft', tex = a.texture.replace(/\.png$/, '');
    if (tex.includes(':')) [ns, tex] = tex.split(':');
    if (!/^[a-z0-9_\-./]+$/.test(tex) || tex.includes('..')) throw new Error('texture path must be lowercase like "block/stone"');
    const file = path.join(root, 'assets', ns, 'textures', ...tex.split('/')) + '.png';
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const png = d.toPNG({ scale: a.scale ?? 1 });
    fs.writeFileSync(file, png);
    const written = [file];
    if (d.frames > 1) {
      const anim = { frametime: a.frametime ?? 2 };
      if (a.interpolate) anim.interpolate = true;
      if (a.frame_order) anim.frames = a.frame_order;
      fs.writeFileSync(file + '.mcmeta', JSON.stringify({ animation: anim }, null, 2));
      written.push(file + '.mcmeta');
    } else if (fs.existsSync(file + '.mcmeta') && !a.keep_mcmeta) {
      fs.rmSync(file + '.mcmeta');
    }
    return { written };
  },

  pack_icon(a) {
    const root = packRoot(this, a.pack);
    const d = this.get(a.canvas);
    const scale = a.scale ?? Math.max(1, Math.floor(128 / Math.max(d.width, d.frameHeight || d.height)));
    const png = d.toPNG({ scale, frame: d.frameHeight ? 0 : undefined });
    fs.writeFileSync(path.join(root, 'pack.png'), png);
    return { written: path.join(root, 'pack.png') };
  },

  pack_info(a) {
    const root = packRoot(this, a.pack);
    if (!fs.existsSync(root)) throw new Error(`Pack not found: ${root}`);
    return { pack: root, files: walk(root) };
  },

  pack_zip(a) {
    const root = packRoot(this, a.pack);
    if (!fs.existsSync(path.join(root, 'pack.mcmeta'))) throw new Error(`No pack.mcmeta in ${root}`);
    const files = walk(root);
    const zip = createZip(files.map((f) => ({ name: f, data: fs.readFileSync(path.join(root, f)) })));
    const out = a.out ? this.resolvePath(a.out, this.exportDir) : path.join(this.exportDir, `${path.basename(root)}.zip`);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, zip);
    return { zip: out, files: files.length, bytes: zip.length };
  },

  /** Write every canvas of a project that has meta.texture into the pack (and optionally zip it). */
  pack_build(a, source) {
    const p = this.getProject(a.project);
    const pack = a.pack || p.meta?.pack || p.name;
    const root = packRoot(this, pack);
    if (!fs.existsSync(path.join(root, 'pack.mcmeta')) || a.minecraft || a.pack_format || a.description) {
      OPS.pack_init.call(this, { pack, minecraft: a.minecraft ?? p.meta?.minecraft, pack_format: a.pack_format, description: a.description ?? p.description });
    }
    const written = [], skipped = [];
    for (const d of this.projectDocs(p.name)) {
      if (d.meta?.pack_icon) OPS.pack_icon.call(this, { pack, canvas: d.name });
      if (d.meta?.build === false) { skipped.push(d.name); continue; }
      const tex = d.meta?.texture;
      if (!tex) { if (!d.meta?.pack_icon) skipped.push(d.name); continue; }
      for (const t of Array.isArray(tex) ? tex : [tex]) {
        OPS.pack_add.call(this, { pack, canvas: d.name, texture: t, frametime: d.meta.frametime, interpolate: d.meta.interpolate, frame_order: d.meta.frame_order });
        written.push(t);
      }
    }
    const out = { pack: root, textures: written.length, skipped: skipped.length ? skipped : undefined };
    if (a.zip !== false) out.zip = OPS.pack_zip.call(this, { pack, out: a.out }).zip;
    const ev = { type: 'project', project: p.name, source, label: `pack built: ${written.length} textures`, ts: Date.now() };
    this.pushLog({ ...ev, canvas: p.name });
    this.emit('event', ev);
    return out;
  },

  /** Vanilla Minecraft textures as REFERENCE (names, sizes, UV layouts). Never ship them in a pack. */
  async mc_vanilla(a, source) {
    const version = a.version || '1.12.2';
    const zip = await this.vanillaJar(version);
    const prefix = 'assets/minecraft/textures/';
    const all = [...zip.keys()].filter((n) => n.startsWith(prefix) && n.endsWith('.png')).map((n) => n.slice(prefix.length, -4));
    const re = a.filter ? new RegExp(a.filter, 'i') : null;
    const matches = re ? all.filter((n) => re.test(n)) : all;
    const action = a.action || 'list';
    if (action === 'list') {
      const sizes = a.sizes !== false && matches.length <= 400;
      const items = matches.map((n) => {
        if (!sizes) return n;
        const png = zip.get(prefix + n + '.png')();
        const w = png.readUInt32BE(16), h = png.readUInt32BE(20);
        const animated = zip.has(prefix + n + '.png.mcmeta');
        return `${n} ${w}x${h}${animated ? ` (animated, ${h / w} frames)` : ''}`;
      });
      const dirs = {};
      for (const n of all) { const top = n.split('/')[0]; dirs[top] = (dirs[top] || 0) + 1; }
      return { version, total: all.length, folders: dirs, matched: matches.length, textures: a.limit ? items.slice(0, a.limit) : items };
    }
    if (action === 'import') {
      const names = a.textures || matches;
      if (names.length > 200) throw new Error(`${names.length} textures match; narrow the filter (max 200 per import)`);
      const project = a.project || `vanilla-${version}`;
      if (!this.projects.has(project)) OPS.project_create.call(this, { name: project, description: `Vanilla ${version} textures (reference only, do not ship)` }, source);
      const created = [];
      for (const n of names) {
        const entry = zip.get(prefix + n + '.png');
        if (!entry) throw new Error(`No vanilla texture ${n}`);
        const name = (a.prefix ?? 'ref_') + n.replace(/\//g, '.');
        const tmp = { base64: entry().toString('base64'), canvas: name, project, overwrite: true, meta: { reference: `${version}:${n}` } };
        const r = OPS.import.call(this, tmp, source);
        const d = this.get(name);
        const mm = zip.get(prefix + n + '.png.mcmeta');
        if (mm && !d.frameHeight && d.height > d.width && d.height % d.width === 0) { d.frameHeight = d.width; this.scheduleSave(d); }
        created.push(r.created?.name || name);
      }
      return { project, imported: created };
    }
    if (action === 'mcmeta') {
      const n = a.texture;
      const entry = zip.get(prefix + n + '.png.mcmeta');
      return { texture: n, mcmeta: entry ? JSON.parse(entry().toString('utf8')) : null };
    }
    throw new Error('mc_vanilla action must be list, import or mcmeta');
  },

  commands() {
    return { commands: COMMAND_NAMES };
  },
};

Object.assign(OPS, RIG_OPS, MODEL_OPS, AUDIO_OPS, GRAPH_OPS, REVIEW_OPS, LIB_OPS, PLANET_OPS, FP_OPS, FP2D_OPS, CLEANUP_OPS, SKIN2D_OPS, FX_OPS);
export const OP_NAMES = Object.keys(OPS);
