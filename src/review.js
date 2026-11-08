// Review annotations: the user marks an asset in the web UI (a pin or box on a frame, a view of an
// 8-direction set, a layer or rig/model part, an audio time range) with a category, priority, note
// and an optional "compare with" asset; the agent lists them compactly, gets a cropped image of the
// marked region (then, now, and the comparison) and moves them through open -> in_progress -> fixed
// -> accepted | reopened. Stored with the asset graph (graph.json), crops in <workspace>/reviews/.
import fs from 'node:fs';
import path from 'node:path';
import { decodePNG, encodePNG } from './png.js';
import { packImages } from './sheet.js';
import { modelDefs, modelThumbnail } from './modelops.js';

export const CATEGORIES = ['fix', 'redo', 'inconsistent', 'layering', 'style', 'question', 'approve'];
export const STATUSES = ['open', 'in_progress', 'fixed', 'accepted', 'reopened'];
const PRIORITIES = ['low', 'normal', 'high'];
const ACTIVE = new Set(['open', 'in_progress', 'reopened']);
const CROP_MAX = 192; // px: crops are scaled up to about this size for the agent
const kindOf = (id) => id.slice(0, id.indexOf(':'));
const nameOf = (id) => id.slice(id.indexOf(':') + 1);

/** Normalise a category ("inconsistent across views" -> "inconsistent"). */
function category(c) {
  const s = String(c || 'fix').toLowerCase().trim();
  if (s.startsWith('inconsistent')) return 'inconsistent';
  if (!CATEGORIES.includes(s)) throw new Error(`category must be one of ${CATEGORIES.join(', ')} (inconsistent = inconsistent across views)`);
  return s;
}
function region(r) {
  if (r === undefined || r === null) return undefined;
  if (!Array.isArray(r) || (r.length !== 4 && r.length !== 2) || !r.every((v) => Number.isFinite(Number(v)))) throw new Error('region must be [x, y, w, h] (or a pin [x, y]) in frame pixels');
  const v = r.map((x) => Math.round(Number(x)));
  return v.length === 2 ? [v[0], v[1], 1, 1] : [v[0], v[1], Math.max(1, v[2]), Math.max(1, v[3])];
}
/** Where on the asset a note points: frame, view, tag, layer, part, time range, region. */
function targetOf(a) {
  const t = {};
  if (a.frame !== undefined && a.frame !== null) { const f = Number(a.frame); if (!Number.isInteger(f) || f < 0) throw new Error('frame must be a frame index >= 0'); t.frame = f; }
  for (const k of ['view', 'tag', 'layer', 'part', 'pose', 'clip']) if (a[k] !== undefined && a[k] !== null && a[k] !== '') t[k] = String(a[k]).slice(0, 64);
  if (a.time !== undefined && a.time !== null) {
    const tm = [].concat(a.time).map(Number);
    if (!tm.length || tm.some((x) => !Number.isFinite(x) || x < 0)) throw new Error('time must be seconds or [start, end] seconds');
    t.time = tm.length > 1 ? [Math.min(tm[0], tm[1]), Math.max(tm[0], tm[1])] : [tm[0]];
  }
  const r = region(a.region ?? (a.point ? a.point : undefined));
  if (r) t.region = r;
  if (a.point) t.pin = true;
  return t;
}
const fmtTarget = (t = {}) => [
  t.tag ? `tag:${t.tag}` : '', t.frame !== undefined ? `f${t.frame}` : '', t.view ? `view:${t.view}` : '', t.layer ? `layer:${t.layer}` : '', t.part ? `part:${t.part}` : '',
  t.pose ? `pose:${t.pose}` : '', t.clip ? `clip:${t.clip}` : '', t.time ? `t=${t.time.map((x) => x.toFixed(2)).join('-')}s` : '', t.region ? `[${t.region.join(',')}]` : '',
].filter(Boolean).join(' ');

/** Nearest-neighbour upscale (crops are small) to about CROP_MAX px. */
function upscale(img, max = CROP_MAX) {
  const k = Math.max(1, Math.min(16, Math.floor(max / Math.max(img.width, img.height))));
  if (k === 1) return img;
  const W = img.width * k, H = img.height * k, out = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const s = (Math.floor(y / k) * img.width + Math.floor(x / k)) * 4; out.set(img.data.subarray(s, s + 4), (y * W + x) * 4); }
  return { width: W, height: H, data: out };
}
function downscale(img, max) {
  const k = Math.ceil(Math.max(img.width, img.height) / max);
  if (k <= 1) return img;
  const W = Math.ceil(img.width / k), H = Math.ceil(img.height / k), out = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const s = (Math.min(img.height - 1, y * k) * img.width + Math.min(img.width - 1, x * k)) * 4; out.set(img.data.subarray(s, s + 4), (y * W + x) * 4); }
  return { width: W, height: H, data: out };
}

export class Reviews {
  constructor(engine, graph) {
    this.engine = engine;
    this.graph = graph;
    this.dir = path.join(engine.home, 'reviews');
    graph.data.reviews ||= [];
    graph.data.reviewSeq ||= graph.data.reviews.reduce((m, r) => Math.max(m, Number(String(r.id).slice(1)) || 0), 0);
  }
  get list() { return this.graph.data.reviews; }
  save(change) { this.graph.save(change ? { ...change, review: true } : null); }
  get(id) {
    const r = this.list.find((x) => x.id === id);
    if (!r) throw new Error(`no review note "${id}" (art_review list shows them)`);
    return r;
  }

  /** Frame index on a canvas for a target (frame, else first frame of tag + view). */
  frameOf(d, t) {
    if (t.frame !== undefined) return Math.min(t.frame, d.frames - 1);
    const tag = t.tag && d.animations[t.tag];
    return tag ? tag.frames[0] : 0;
  }
  /** Current image of a target: canvas frame crop / rig view / model view. {img, label} or null. */
  render(asset, t = {}) {
    const e = this.engine, k = kindOf(asset), n = nameOf(asset);
    try {
      if (k === 'canvas' || k === 'layer' || k === 'anim' || k === 'frame') {
        const cname = k === 'canvas' ? n : n.slice(0, n.indexOf('/'));
        const d = e.docs.get(cname);
        if (!d) return null;
        const f = this.frameOf(d, t);
        const fh = d.frameHeight || d.height;
        const li = t.layer !== undefined ? d.layers.findIndex((l) => l.name === t.layer) : -1;
        const data = d.frameHeight ? d.frameData(f, li >= 0 ? { layer: li } : {}) : d.composite(li >= 0 ? { layer: li } : {});
        let img = { width: d.width, height: fh, data };
        const r = t.region && !t.pin ? t.region : t.region ? [t.region[0] - 6, t.region[1] - 6, 13, 13] : null;
        if (r) {
          // a little context around the box
          const pad = t.pin ? 0 : Math.max(1, Math.round(Math.max(r[2], r[3]) * 0.25));
          const x0 = Math.max(0, r[0] - pad), y0 = Math.max(0, r[1] - pad), x1 = Math.min(d.width, r[0] + r[2] + pad), y1 = Math.min(fh, r[1] + r[3] + pad);
          if (x1 > x0 && y1 > y0) {
            const out = new Uint8ClampedArray((x1 - x0) * (y1 - y0) * 4);
            for (let y = y0; y < y1; y++) out.set(data.subarray((y * d.width + x0) * 4, (y * d.width + x1) * 4), (y - y0) * (x1 - x0) * 4);
            img = { width: x1 - x0, height: y1 - y0, data: out };
          }
        }
        return { img: upscale(img), label: `${cname} f${f}${t.region ? ` [${t.region.join(',')}]` : ''} v${d.version}`, version: d.version };
      }
      if (k === 'rig' || k === 'rigpart') {
        const rig = k === 'rig' ? n : n.slice(0, n.indexOf('/'));
        const r = e.peek('rig_preview', { name: rig, view: t.view, pose: t.pose, scale: 4 });
        return { img: downscale(decodePNG(r.image), 384), label: `${rig}${t.view ? ` ${t.view}` : ''}${t.pose ? ` ${t.pose}` : ''}` };
      }
      if (k === 'model' || k === 'modelpart') {
        const m = modelDefs(e).get(k === 'model' ? n : n.slice(0, n.indexOf('/')));
        if (!m) return null;
        const views = t.view && ['front', 'back', 'side', 'left', 'top', 'iso', 'game'].includes(t.view) ? [t.view] : ['game'];
        const r = e.peek('model_preview', { name: m.name, views, size: 192 });
        return { img: decodePNG(r.image), label: `${m.name} ${views[0]}` };
      }
    } catch { return null; }
    return null;
  }
  savePng(name, img) {
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(path.join(this.dir, name), encodePNG(img.width, img.height, img.data));
    return name;
  }
  /** Store an image the UI sent (data URL / base64 PNG of what the user saw). */
  saveUpload(name, b64) {
    const buf = Buffer.from(String(b64).replace(/^data:image\/png;base64,/, ''), 'base64');
    const img = decodePNG(buf); // validates it is a PNG
    return this.savePng(name, downscale(img, 384));
  }
  readPng(name) {
    try { return decodePNG(fs.readFileSync(path.join(this.dir, name))); } catch { return null; }
  }

  add(a, source) {
    if (!a.asset) throw new Error('review add needs "asset" (e.g. "helmet_side" or "model:helmet")');
    const asset = this.graph.resolve(a.asset);
    const cat = category(a.category);
    const note = String(a.note || '').replace(/\s+/g, ' ').trim().slice(0, 400);
    if (!note && cat !== 'approve') throw new Error('review add needs a "note"');
    const target = targetOf(a);
    let compare;
    if (a.compare_with) {
      const c = typeof a.compare_with === 'string' ? { asset: a.compare_with } : a.compare_with;
      compare = { asset: this.graph.resolve(c.asset), ...targetOf(c) };
    }
    const priority = PRIORITIES.includes(a.priority) ? a.priority : 'normal';
    const id = `r${++this.graph.data.reviewSeq}`;
    const ts = Date.now();
    const r = { id, asset, target, category: cat, priority, note, status: cat === 'approve' ? 'accepted' : 'open', by: source === 'agent' ? 'agent' : 'user', created: ts, updated: ts, history: [] };
    if (compare) r.compare_with = compare;
    const cur = this.render(asset, target);
    let img;
    if (cur) img = this.savePng(`${id}-0.png`, cur.img);
    else if (a.image) img = this.saveUpload(`${id}-0.png`, a.image);
    if (cur?.version !== undefined) r.version = cur.version;
    r.history.push({ ts, status: r.status, by: r.by, ...(img ? { img } : {}), ...(r.version !== undefined ? { version: r.version } : {}) });
    this.list.push(r);
    if (cat === 'approve') this.setApproved(asset, true, r.version);
    this.save({ action: 'review', id, status: r.status, asset });
    return r;
  }
  update(a, source) {
    const r = this.get(a.id);
    const by = source === 'agent' ? 'agent' : 'user';
    const h = { ts: Date.now(), by };
    if (a.status !== undefined) {
      if (!STATUSES.includes(a.status)) throw new Error(`status must be one of ${STATUSES.join(', ')}`);
      r.status = a.status;
      h.status = a.status;
    }
    if (a.reply) h.reply = String(a.reply).replace(/\s+/g, ' ').trim().slice(0, 400);
    if (a.note !== undefined && by === 'user') r.note = String(a.note).slice(0, 400);
    if (a.priority && PRIORITIES.includes(a.priority)) r.priority = a.priority;
    if (a.status === 'fixed' || a.version !== undefined) {
      // the new version: an image of the target now (and the asset version when it is a canvas)
      const cur = this.render(r.asset, r.target);
      if (cur) { h.img = this.savePng(`${r.id}-${r.history.length}.png`, cur.img); if (cur.version !== undefined) h.version = cur.version; }
      if (a.version !== undefined) h.version = a.version;
    }
    if (a.status === 'accepted' && r.category === 'approve') this.setApproved(r.asset, true, h.version);
    r.history.push(h);
    r.updated = h.ts;
    this.save({ action: 'review', id: r.id, status: r.status, asset: r.asset });
    return r;
  }
  remove(a) {
    const i = this.list.findIndex((x) => x.id === a.id);
    if (i < 0) throw new Error(`no review note "${a.id}"`);
    const [r] = this.list.splice(i, 1);
    for (const h of r.history) if (h.img) fs.rmSync(path.join(this.dir, h.img), { force: true });
    this.save({ action: 'review', id: r.id, deleted: true, asset: r.asset });
    return r;
  }
  setApproved(asset, on, version) {
    const n = this.graph.data.nodes[asset] || (this.graph.data.nodes[asset] = {});
    if (on) n.approved = { ts: Date.now(), ...(version !== undefined ? { version } : {}) };
    else { delete n.approved; this.graph.prune(asset); }
  }
  approve(a, source) {
    const asset = this.graph.resolve(a.asset);
    const on = a.approved !== false;
    const d = kindOf(asset) === 'canvas' ? this.engine.docs.get(nameOf(asset)) : null;
    this.setApproved(asset, on, d?.version);
    this.save({ action: 'approve', asset, approved: on, by: source });
    return { asset, approved: on };
  }
  approved(asset) { return this.graph.data.nodes[asset]?.approved || null; }

  /** Notes matching a filter; status "active" = open + in_progress + reopened. */
  filter({ status = 'active', asset, category: cat } = {}) {
    let ids = null;
    if (asset) { const id = this.graph.resolveLoose(asset); ids = new Set([id]); }
    return this.list.filter((r) => (status === 'all' || (status === 'active' ? ACTIVE.has(r.status) : r.status === status))
      && (!ids || ids.has(r.asset) || ids.has(r.compare_with?.asset)) && (!cat || r.category === category(cat)));
  }
  line(r) {
    const last = r.history[r.history.length - 1];
    const reply = [...r.history].reverse().find((h) => h.reply);
    return `${r.id} ${r.status} ${r.priority !== 'normal' ? r.priority + ' ' : ''}${r.category} ${r.asset}${fmtTarget(r.target) ? ' ' + fmtTarget(r.target) : ''}${r.compare_with ? ` vs ${r.compare_with.asset}${fmtTarget(r.compare_with) ? ' ' + fmtTarget(r.compare_with) : ''}` : ''}: "${r.note}"${reply ? ` (reply: "${reply.reply.slice(0, 80)}")` : ''}${last.by === 'user' && r.status === 'reopened' ? ' REOPENED' : ''}`;
  }
  listText(a = {}) {
    const items = this.filter(a);
    const limit = Math.max(1, Math.min(200, a.limit ?? 30));
    if (!items.length) return `no ${a.status && a.status !== 'active' ? a.status : 'open'} review notes${a.asset ? ` on ${a.asset}` : ''}`;
    const pri = { high: 0, normal: 1, low: 2 };
    items.sort((x, y) => pri[x.priority] - pri[y.priority] || x.created - y.created);
    const lines = items.slice(0, limit).map((r) => this.line(r));
    if (items.length > limit) lines.push(`… +${items.length - limit} more (limit)`);
    return lines.join('\n');
  }
  /** get {id}: the marked region then (when noted), now, and the comparison, as one image. */
  getImage(id) {
    const r = this.get(id);
    const items = [];
    const first = r.history.find((h) => h.img);
    const then = first && this.readPng(first.img);
    if (then) items.push({ img: then, label: 'NOTED', sub: first.version !== undefined ? `V${first.version}` : '' });
    const now = this.render(r.asset, r.target);
    if (now) items.push({ img: now.img, label: 'NOW', sub: now.version !== undefined ? `V${now.version}` : '' });
    if (r.compare_with) {
      // the comparison uses the same region unless it names its own
      const ct = { ...r.target, ...r.compare_with };
      delete ct.asset;
      if (!r.compare_with.region && r.target.region) ct.region = r.target.region;
      if (r.compare_with.frame === undefined && !r.compare_with.tag) delete ct.frame;
      const c = this.render(r.compare_with.asset, ct);
      if (c) items.push({ img: c.img, label: 'COMPARE', sub: nameOf(r.compare_with.asset).slice(0, 18).toUpperCase() });
    }
    const text = [this.line(r), ...r.history.map((h) => `  ${new Date(h.ts).toISOString().slice(11, 19)} ${h.by}${h.status ? ' ' + h.status : ''}${h.version !== undefined ? ' v' + h.version : ''}${h.reply ? ` "${h.reply}"` : ''}`)].join('\n');
    if (!items.length) return { text };
    const sheet = packImages(items, { labels: true, columns: items.length });
    return { text, image: encodePNG(sheet.width, sheet.height, sheet.data) };
  }

  /**
   * One line for other tools' replies: open notes on the assets a call touched, and a warning
   * when it changed an asset the user approved. '' when there is nothing to say.
   */
  hint(ids, { mutated = false } = {}) {
    const set = new Set(ids);
    if (!set.size) return '';
    const open = this.list.filter((r) => ACTIVE.has(r.status) && (set.has(r.asset) || set.has(r.compare_with?.asset)));
    const approved = [...set].filter((id) => this.approved(id) && (kindOf(id) !== 'canvas' || this.engine.docs.has(nameOf(id))));
    const parts = [];
    if (open.length) parts.push(`${open.length} open review note${open.length > 1 ? 's' : ''} on ${[...new Set(open.map((r) => nameOf(r.asset)))].slice(0, 3).join(', ')} (${open.slice(0, 4).map((r) => r.id).join(' ')}): art_review list`);
    if (approved.length) parts.push(mutated ? `${approved.map(nameOf).join(', ')} was approved by the user and this call changed it (art_undo reverts)` : `${approved.map(nameOf).join(', ')} is approved by the user: ask before changing it`);
    return parts.length ? `review: ${parts.join('; ')}` : '';
  }
  /** Open-note counts per asset (graph badges, browser). */
  counts() {
    const out = {};
    for (const r of this.list) if (ACTIVE.has(r.status)) out[r.asset] = (out[r.asset] || 0) + 1;
    return out;
  }
}

export const REVIEW_OPS = {
  review_add(a, source) { const r = this.reviews.add(a, source); return { text: `added ${this.reviews.line(r)}`, id: r.id }; },
  review_list(a) { return { text: this.reviews.listText(a) }; },
  review_get(a) {
    if (!a.id) throw new Error('get needs "id"');
    return this.reviews.getImage(a.id);
  },
  review_update(a, source) {
    if (!a.id) throw new Error('update needs "id"');
    const r = this.reviews.update(a, source);
    return { text: `updated ${this.reviews.line(r)}` };
  },
  review_delete(a) { const r = this.reviews.remove(a); return { text: `deleted ${r.id}` }; },
  review_approve(a, source) {
    const r = this.reviews.approve(a, source);
    return { text: `${r.asset} ${r.approved ? 'approved' : 'no longer approved'}` };
  },
  /** {ids:[node ids], ops:[op names]} -> {text} one-line hint (used by the MCP layer). */
  review_hint(a) {
    const ids = (a.ids || []).filter((x) => typeof x === 'string');
    return { text: this.reviews.hint(ids, { mutated: !!a.mutated }) };
  },
  /** UI: every note (full records, no images). */
  review_all() {
    const approved = Object.entries(this.graph.data.nodes).filter(([, n]) => n.approved).map(([id]) => id);
    return { reviews: this.reviews.list, counts: this.reviews.counts(), approved };
  },
};
