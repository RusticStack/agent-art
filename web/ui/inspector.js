// Inspector: metadata of the open asset (canvas: previews, layers, palette, animations, meta;
// model / rig / audio / project / export details), its relations in the asset graph, and its
// review notes (with accept / reopen / compare). Also the review note dialog.
import { el, enc, getJSON, api, KIND_ICON, fmtBytes, playList, splitId } from './util.js';

const BLENDS = ['normal', 'multiply', 'screen', 'add', 'overlay', 'darken', 'lighten', 'soft-light'];
export const REVIEW_CATS = [['fix', 'Fix'], ['redo', 'Redo'], ['inconsistent', 'Inconsistent across views'], ['layering', 'Layering'], ['style', 'Style'], ['question', 'Question'], ['approve', 'Approve']];
const STATUS_LABEL = { open: 'open', in_progress: 'in progress', fixed: 'fixed', accepted: 'accepted', reopened: 'reopened' };

function section(title, ...kids) {
  return el('section.insp-sec', {}, el('div.panel-label', { text: title }), ...kids);
}
const kv = (rows) => el('table.kv', {}, ...rows.filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => el('tr', {}, el('th', { text: k }), el('td', { text: String(v) }))));

export class Inspector {
  constructor(root, app) {
    this.app = app;
    this.root = root;
    this.head = el('div.pane-head');
    this.body = el('div.insp-body');
    root.append(this.head, this.body);
    this.frame = 0;
    this.previewTimer = null;
  }

  async show(target) {
    this.target = target;
    clearTimeout(this.previewTimer);
    const id = target ? this.app.idOf(target) : null;
    this.head.replaceChildren(el('h2', { text: 'Inspector' }), el('div.spacer'));
    if (!target || target.kind === 'graph') {
      this.body.replaceChildren(el('div.muted.pad', { text: target?.kind === 'graph' ? 'Select a node in the graph to see its relations.' : 'Nothing open.' }));
      return;
    }
    const [kind, name] = splitId(id);
    const title = el('div.insp-title', {}, el('span.kicon', { text: KIND_ICON[kind] || '•' }), el('span.name', { text: name }), target.snap ? el('span.badge.state', { text: `snapshot ${target.label || target.snap}` }) : null);
    const acts = el('div.insp-actions', {},
      el('button.btn.small', { text: this.app.isPinned(id) ? '★ Pinned' : '☆ Pin', on: { click: () => this.app.togglePinned(id) } }),
      el('button.btn.small', { text: this.app.isHidden(id) ? '◌ Hidden' : '◉ Visible', on: { click: () => this.app.toggleHidden(id) } }),
      el('button.btn.small' + (this.app.approvedSet.has(id) ? '.ok' : ''), { text: this.app.approvedSet.has(id) ? '✓ Approved' : 'Approve', title: 'Approve this asset (the agent is warned before changing it)', on: { click: () => api('review_approve', { asset: id, approved: !this.app.approvedSet.has(id) }).catch(() => {}) } }),
      el('button.btn.small', { text: '⚑ Note', title: 'Add a review note to this asset (M = review mode: mark a region in the viewer)', on: { click: () => this.app.reviewPrompt({ asset: id }) } }));
    const parts = [title, acts];
    try {
      if (kind === 'canvas') parts.push(...(await this.canvasParts(name, target)));
      else if (kind === 'model') parts.push(...(await this.modelParts(name)));
      else if (kind === 'rig') parts.push(...(await this.rigParts(name)));
      else if (kind === 'audio') parts.push(...(await this.audioParts(name)));
      else if (kind === 'project') parts.push(...(await this.projectParts(name)));
      else if (kind === 'export') { const f = this.app.assets?.exports.find((x) => x.path === name); parts.push(section('File', kv([['path', name], ['size', f ? fmtBytes(f.size) : ''], ['modified', f ? new Date(f.mtime).toLocaleString() : '']]))); }
    } catch (e) { parts.push(el('div.error', { text: e.message })); }
    parts.push(this.reviewSection(id));
    parts.push(await this.relations(id));
    if (this.target !== target) return;
    this.body.replaceChildren(...parts);
  }

  async canvasParts(name, target) {
    if (target.snap) {
      const m = await getJSON(`/api/snapshot/${target.snap}`).catch(() => null);
      return [section('Snapshot', kv([['canvas', name], ['version', m?.version], ['size', m ? `${m.width}×${m.height}` : 'expired'], ['frames', m?.frames]]), el('button.btn.small', { text: 'Open live', on: { click: () => this.app.open({ kind: 'canvas', name }) } }))];
    }
    const info = await getJSON(`/api/canvas/${enc(name)}`);
    this.info = info;
    const out = [];
    // previews: actual size + animated
    const p1 = el('canvas.preview'), p2 = el('canvas.preview');
    out.push(section('Preview', el('div.preview-row', {}, p1, p2)));
    this.startPreview(info, p1, p2);
    out.push(section('Canvas', kv([['size', `${info.width}×${info.frameHeight || info.height}`], ['frames', info.frames > 1 ? info.frames : ''], ['layers', info.layers.length], ['colours', info.colors?.unique], ['project', info.project], ['undo / redo', `${info.undo} / ${info.redo}`], ['version', info.version]])));
    // layers (top first): eye = real visibility, blend, click = select (same API as the agent)
    const ul = el('ul.layers');
    for (const l of [...info.layers].reverse()) {
      const li = el(`li${l.index === info.activeLayer ? '.active' : ''}${l.visible ? '' : '.hidden'}`, { on: { click: () => api('layer', { canvas: name, action: 'select', layer: l.index }).catch(() => {}) } },
        el('button.eye', { text: l.visible ? '◉' : '○', title: 'Toggle visibility', on: { click: (e) => { e.stopPropagation(); api('layer', { canvas: name, action: 'visibility', layer: l.index }).catch(() => {}); } } }),
        el('span.lname', { text: l.name + (l.opacity < 1 ? ` (${Math.round(l.opacity * 100)}%)` : '') }),
        el('select.lblend', { title: 'Blend mode', on: { click: (e) => e.stopPropagation(), change: (e) => api('layer', { canvas: name, action: 'blend', layer: l.index, blend: e.target.value }).catch(() => {}) } }, ...BLENDS.map((m) => el('option', { value: m, text: m, selected: m === (l.blend || 'normal') }))));
      ul.append(li);
    }
    out.push(section('Layers', ul, el('button.btn.small', { text: 'Layer stack / debug', on: { click: () => this.app.open({ kind: 'canvas', name, view: 'layers' }) } })));
    const pal = el('div.palette'), used = el('div.palette.used');
    for (const [k, v] of Object.entries({ ...(info.inheritedPalette || {}), ...(info.palette || {}) })) pal.append(this.swatch(v, `${k}  ${v}`, k));
    for (const { color, count } of info.colors?.top || []) used.append(this.swatch(color, `${color} · ${count} px`));
    out.push(section('Palette', pal, el('div.muted.small', { text: 'Used colours' }), used));
    const tags = Object.entries(info.animations || {});
    if (tags.length) out.push(section('Animations', el('div.tag-list', {}, ...tags.map(([t, a]) => el('button.chip', { text: `${t} · ${a.frames.length}f`, title: `${a.durations.reduce((x, y) => x + y, 0)} ms${a.loop === false ? ', no loop' : ''}`, on: { click: () => this.app.open({ kind: 'canvas', name, view: 'anim', tag: t }) } })))));
    if (info.meta && Object.keys(info.meta).length) {
      const meta = { ...info.meta };
      if (meta.anchors) meta.anchors = Object.fromEntries(Object.entries(meta.anchors).map(([k, v]) => [k, `${v.length} frames`]));
      if (meta.rig && typeof meta.rig === 'object') meta.rig = `rig definition (${Object.keys(meta.rig.parts || {}).length} parts)`;
      out.push(section('Meta', el('pre.meta-json', { text: JSON.stringify(meta, null, 1).slice(0, 4000) })));
    }
    if (info.project) {
      const p = await getJSON(`/api/project/${enc(info.project)}`).catch(() => null);
      if (p) out.push(section(`Project ${p.name}`, el('div.notes', { text: [p.description, p.notes].filter(Boolean).join('\n\n') || 'No notes yet.' }), el('button.btn.small', { text: '▦ Overview (O)', on: { click: () => this.app.open({ kind: 'project', name: p.name }) } })));
    }
    return out;
  }
  startPreview(info, p1, p2) {
    loadPreview(info).then((strip) => {
      if (!strip || this.info !== info) return;
      const fh = info.frameHeight || strip.height;
      const big = Math.max(1, Math.floor(128 / Math.max(strip.width, fh))), small = Math.max(1, Math.floor(big / 4));
      const pl = playList(info, Object.keys(info.animations || {})[0], 10);
      let i = 0;
      const draw = () => {
        for (const [c, s] of [[p1, small], [p2, big]]) {
          c.width = strip.width * s; c.height = fh * s;
          const cx = c.getContext('2d');
          cx.imageSmoothingEnabled = false;
          cx.drawImage(strip, 0, (pl.frames[i] ?? 0) * fh, strip.width, fh, 0, 0, c.width, c.height);
        }
      };
      const tick = () => {
        if (this.info !== info) return;
        draw();
        if (pl.frames.length > 1) { i = (i + 1) % pl.frames.length; this.previewTimer = setTimeout(tick, pl.durations[i] || 100); }
      };
      tick();
    });
  }
  swatch(color, title, key) {
    const b = el('button.swatch', { title, on: { click: () => this.app.setColor(color) } });
    b.style.setProperty('--c', color);
    if (key && [...key].length <= 2) b.append(el('span.k', { text: key }));
    return b;
  }
  async modelParts(name) {
    const i = await getJSON(`/api/model/${enc(name)}/info`);
    const rows = [['triangles', i.triangles], ['parts', i.parts_def?.length], ['materials', (i.materials || []).join(', ')], ['size (units)', i.size_units?.join(' × ')], ['size (cells)', i.size_cells?.join(' × ')], ['origin', typeof i.origin === 'string' ? i.origin : JSON.stringify(i.origin)], ['template', i.template]];
    const out = [section('Model', kv(rows))];
    if (i.rig) out.push(section('Rig', kv([['nodes', (i.rig.nodes || []).map((n) => n.name || n).join(', ')], ['sockets', (i.rig.sockets || []).map((s) => s.name || s).join(', ')], ['poses', (i.rig.poses || []).join?.(', ')], ['clips', (i.rig.clips || []).map?.((c) => c.name || c).join(', ')]])));
    if (i.warnings?.length) out.push(section('Warnings', ...i.warnings.map((w) => el('div.warn-line', { text: w }))));
    if (i.notes) out.push(section('Notes', el('div.notes', { text: i.notes })));
    return out;
  }
  async rigParts(name) {
    const r = await getJSON(`/api/rig/${enc(name)}`);
    return [
      section('Rig', kv([['frame', r.frame?.join('×')], ['views', r.views?.join(', ')], ['mirrored', Object.keys(r.mirror || {}).join(', ')], ['sampling', r.sampling], ['root', r.root?.join(', ')]])),
      section('Parts (parent · z)', el('div.tag-list', {}, ...Object.entries(r.parts || {}).map(([n, p]) => el('span.chip', { text: `${n}${p.parent ? ` ← ${p.parent}` : ''} · z${p.z ?? 0}` })))),
      section('Poses / presets', el('div.tag-list', {}, ...Object.keys(r.poses || {}).map((p) => el('button.chip', { text: p, on: { click: () => this.app.open({ kind: 'rig', name, mode: 'pose' }) } })), ...Object.keys(r.presets || {}).map((p) => el('span.chip.dim', { text: p })))),
      el('button.btn.small', { text: 'Layer stack / debug', on: { click: () => this.app.open({ kind: 'rig', name, view: 'layers' }) } }),
    ];
  }
  async audioParts(name) {
    const a = await getJSON(`/api/audio/${enc(name)}`);
    const s = a.stats || {};
    return [section('Audio', kv([['kind', a.kind], ['recipe', a.recipe], ['seed', a.seed], ['duration', s.duration !== undefined ? `${s.duration} s` : ''], ['loudness', s.lufs !== undefined ? `${s.lufs} LUFS` : ''], ['peak', s.peak_dbfs !== undefined ? `${s.peak_dbfs} dBFS` : ''], ['score', s.score], ['issues', (s.issues || []).join(', ')], ['intent', a.intent], ['genre', a.genre]]))];
  }
  async projectParts(name) {
    const p = await getJSON(`/api/project/${enc(name)}`);
    const pal = el('div.palette');
    for (const [k, v] of Object.entries(p.palette || {})) pal.append(this.swatch(v, `${k}  ${v}`, k));
    return [section('Project', kv([['canvases', p.canvases.length], ['description', p.description], ['minecraft', p.meta?.minecraft]])), section('Notes', el('div.notes', { text: p.notes || 'No notes yet.' })), section('Palette', pal)];
  }

  reviewSection(id) {
    const notes = this.app.reviews.filter((r) => r.asset === id || r.compare_with?.asset === id).sort((a, b) => b.updated - a.updated);
    const box = section(`Review notes (${notes.filter((r) => ['open', 'in_progress', 'reopened'].includes(r.status)).length} open)`);
    if (!notes.length) box.append(el('div.muted.small', { text: 'No notes. Press M (review mode) and drag a box or click a pin in the viewer.' }));
    for (const r of notes) box.append(this.reviewCard(r));
    return box;
  }
  reviewCard(r) {
    const t = r.target || {};
    const where = [t.tag && `tag ${t.tag}`, t.frame !== undefined && `frame ${t.frame}`, t.view && `view ${t.view}`, t.layer && `layer ${t.layer}`, t.part && `part ${t.part}`, t.time && `${t.time.map((x) => x.toFixed(2)).join('–')} s`, t.region && `[${t.region.join(',')}]`].filter(Boolean).join(' · ');
    const last = [...r.history].reverse().find((h) => h.reply);
    const imgs = r.history.filter((h) => h.img);
    const card = el(`div.review-card.st-${r.status}`, {},
      el('div.rc-head', {}, el('span.rc-id.mono', { text: r.id }), el('span.rc-cat', { text: r.category }), r.priority !== 'normal' ? el('span.rc-pri', { text: r.priority }) : null, el('span.spacer'), el('span.rc-status', { text: STATUS_LABEL[r.status] || r.status })),
      el('div.rc-note', { text: r.note || '(approval)' }),
      where ? el('div.rc-where.muted.small', { text: where }) : null,
      r.compare_with ? el('div.rc-where.small', {}, 'compare with ', el('a', { href: '#', text: r.compare_with.asset, on: { click: (e) => { e.preventDefault(); this.app.openReviewCompare(r); } } })) : null,
      last ? el('div.rc-reply', { text: `${last.by}: ${last.reply}` }) : null,
      imgs.length ? el('div.rc-imgs', {}, ...imgs.slice(-3).map((h, i) => el('figure', {}, el('img', { src: `/api/review-image/${h.img}`, alt: '' }), el('figcaption', { text: i === 0 && imgs.length > 1 ? 'noted' : h.status || 'v' + (h.version ?? '') })))) : null,
      el('div.rc-actions', {},
        el('button.btn.small', { text: 'Show', on: { click: () => this.app.openReview(r) } }),
        r.compare_with ? el('button.btn.small', { text: 'Side by side', on: { click: () => this.app.openReviewCompare(r) } }) : null,
        r.status === 'fixed' ? el('button.btn.small.ok', { text: 'Accept', on: { click: () => api('review_update', { id: r.id, status: 'accepted' }).catch(() => {}) } }) : null,
        ['fixed', 'accepted'].includes(r.status) ? el('button.btn.small.warn', { text: 'Reopen', on: { click: () => { const reply = prompt('What is still wrong?') || undefined; api('review_update', { id: r.id, status: 'reopened', reply }).catch(() => {}); } } }) : null,
        el('button.btn.small.icon', { text: '✕', title: 'Delete note', on: { click: () => { if (confirm(`Delete ${r.id}?`)) api('review_delete', { id: r.id }).catch(() => {}); } } })));
    return card;
  }

  async relations(id) {
    const box = section('Relations');
    let n;
    try { n = await getJSON(`/api/graph/node?id=${enc(id)}`); } catch { return box; }
    const link = (nid) => el('a', { href: '#', text: nid, on: { click: (e) => { e.preventDefault(); this.app.openNode(nid); } } });
    if (n.tags?.length) box.append(el('div.tag-list', {}, ...n.tags.map((t) => el('span.chip', { text: '#' + t }))));
    if (n.note) box.append(el('div.notes', { text: n.note }));
    const sem = (x) => !x.derived;
    const rows = [...n.out.map((x) => ({ x, dir: 'out' })), ...n.in.map((x) => ({ x, dir: 'in' }))].filter(({ x }) => x.rel !== 'layer_of');
    rows.sort((a, b) => Number(sem(b.x)) - Number(sem(a.x)));
    const list = el('ul.rel-list');
    for (const { x, dir } of rows.slice(0, 40)) {
      const attrs = x.attrs ? ` {${Object.entries(x.attrs).map(([k, v]) => `${k}:${v}`).join(',')}}` : '';
      list.append(el(`li${x.derived ? '.derived' : ''}`, {}, dir === 'out' ? el('span.rel', { text: `${x.rel} →` }) : el('span.rel', { text: `← ${x.rel}` }), ' ', link(dir === 'out' ? x.to : x.from), attrs ? el('span.muted', { text: attrs }) : null));
    }
    if (rows.length > 40) list.append(el('li.muted', { text: `+${rows.length - 40} more` }));
    if (!rows.length) list.append(el('li.muted', { text: 'No relations yet (the agent adds them with art_graph link / group).' }));
    box.append(list, el('button.btn.small', { text: '⬡ Show in graph', on: { click: () => this.app.open({ kind: 'graph', focus: id }) } }));
    return box;
  }
  refreshFor(viewer) {
    if (viewer?.name && this.target?.kind === 'canvas' && this.target.name === viewer.name && !this.target.snap) { clearTimeout(this.rt); this.rt = setTimeout(() => this.show(this.target), 150); }
  }
}

async function loadPreview(info) {
  try { return await createImageBitmap(await (await fetch(`/api/canvas/${enc(info.name)}/png?t=${info.version}-${Date.now()}`)).blob()); } catch { return null; }
}

/** Modal dialog for a new review note. t: {asset, frame?, view?, tag?, layer?, part?, region?, point?, time?, image?, category?, note?, where?} */
export function reviewDialog(app, t) {
  return new Promise((resolve) => {
    const cat = el('select', {}, ...REVIEW_CATS.map(([v, l]) => el('option', { value: v, text: l, selected: v === (t.category || (t.compare ? 'inconsistent' : 'fix')) })));
    const pri = el('select', {}, ...['low', 'normal', 'high'].map((p) => el('option', { value: p, text: p, selected: p === (t.priority || 'normal') })));
    const note = el('textarea', { rows: 3, placeholder: 'What is wrong / what should change?', value: t.note || '' });
    note.value = t.note || '';
    const assets = app.assetChoices();
    const cmp = el('input', { list: 'cmp-assets', placeholder: 'compare with (optional): asset', value: t.compare_with || '' });
    const dl = el('datalist#cmp-assets', {}, ...assets.map((a) => el('option', { value: a })));
    const cmpView = el('input.small-in', { placeholder: 'view', value: t.compare_view || '' });
    const cmpFrame = el('input.small-in', { placeholder: 'frame', type: 'number', min: 0 });
    const where = [t.tag && `tag ${t.tag}`, t.frame !== undefined && `frame ${t.frame}`, t.view && `view ${t.view}`, t.layer && `layer ${t.layer}`, t.part && `parts ${t.part}`, t.region && `box [${t.region.join(',')}]`, t.point && `pin (${t.point.join(',')})`, t.time && `${t.time.map((x) => x.toFixed(2)).join('–')} s`, t.where].filter(Boolean).join(' · ');
    const close = (v) => { dlg.remove(); resolve(v); };
    const submit = async () => {
      const args = { asset: t.asset, category: cat.value, priority: pri.value, note: (note.value.trim() + (t.where ? ` (at ${t.where})` : '')).trim() };
      for (const k of ['frame', 'view', 'tag', 'layer', 'part', 'region', 'point', 'time', 'image', 'clip']) if (t[k] !== undefined) args[k] = t[k];
      if (cmp.value.trim()) args.compare_with = { asset: cmp.value.trim(), ...(cmpView.value.trim() ? { view: cmpView.value.trim() } : {}), ...(cmpFrame.value !== '' ? { frame: Number(cmpFrame.value) } : {}) };
      try { const r = await api('review_add', args); close(r); } catch { /* toast shown */ }
    };
    const dlg = el('div.modal', { on: { click: (e) => { if (e.target === dlg) close(null); } } },
      el('form.modal-card', { on: { submit: (e) => { e.preventDefault(); submit(); }, keydown: (e) => { if (e.key === 'Escape') close(null); } } },
        el('h3', { text: '⚑ Review note' }),
        el('div.mono.small', { text: t.asset }), where ? el('div.muted.small', { text: where }) : null,
        el('div.form-row', {}, el('label', {}, 'Category ', cat), el('label', {}, 'Priority ', pri)),
        note,
        el('div.form-row', {}, cmp, cmpView, cmpFrame), dl,
        el('div.form-row.end', {}, el('button.btn', { type: 'button', text: 'Cancel', on: { click: () => close(null) } }), el('button.btn.primary', { type: 'submit', text: 'Add note' }))));
    document.body.append(dlg);
    note.focus();
  });
}
