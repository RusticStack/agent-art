// Asset browser: one tree of the workspace (pinned, groups, projects, canvases with layers and
// animations, rigs, 3D models, audio, exports). Per item: hide (eye), pin, solo; collapsible
// sections; name filter. Hidden / pinned state persists per workspace (server ui-state.json).
import { el, enc, thumbURL, KIND_ICON, store, fmtBytes, assetId } from './util.js';

const SECTIONS = [['pinned', 'Pinned'], ['groups', 'Groups'], ['projects', 'Projects'], ['canvases', 'Canvases'], ['rigs', 'Rigs'], ['models', '3D models'], ['audio', 'Audio'], ['exports', 'Exports']];
const MAX_PER_GROUP = 400;

export class Browser {
  constructor(root, app) {
    this.app = app;
    this.root = root;
    this.collapsed = new Set(store.get('collapsed', ['exports', 'groups']));
    this.expanded = new Set(store.get('expanded', []));
    this.showHidden = store.get('showHidden', false);
    this.filter = '';
    this.search = el('input.search', { type: 'search', placeholder: 'Filter assets  ( / )', on: { input: () => { this.filter = this.search.value.trim().toLowerCase(); this.render(); } } });
    this.hiddenBtn = el('button.btn.small.icon', { title: 'Show hidden assets', on: { click: () => { this.showHidden = !this.showHidden; store.set('showHidden', this.showHidden); this.render(); } } });
    this.soloBtn = el('button.btn.small', { text: 'Clear solo', hidden: true, on: { click: () => { this.app.solo.clear(); this.app.onSoloChange(); } } });
    this.newBtn = el('button.btn.small', { text: '+ New', title: 'New canvas', on: { click: () => this.toggleNew() } });
    this.newForm = this.buildNewForm();
    root.append(el('div.pane-head', {}, el('h2', { text: 'Assets' }), el('div.spacer'), this.soloBtn, this.hiddenBtn, this.newBtn), this.newForm, el('div.pane-search', {}, this.search));
    this.tree = el('div.tree', { role: 'tree' });
    root.append(this.tree);
    this.tree.addEventListener('click', (e) => this.onClick(e));
    this.tree.addEventListener('dblclick', (e) => { const row = e.target.closest('.row'); if (row?.dataset.kind === 'canvas') this.app.open({ kind: 'canvas', name: row.dataset.name, view: 'edit' }); });
  }
  buildNewForm() {
    const name = el('input', { placeholder: 'name', required: true, pattern: '[A-Za-z0-9_\\-.]{1,64}' });
    const w = el('input', { type: 'number', value: 16, min: 1, max: 4096, title: 'width' });
    const h = el('input', { type: 'number', value: 16, min: 1, max: 4096, title: 'height' });
    const f = el('form.new-form', { hidden: true, on: { submit: async (e) => {
      e.preventDefault();
      const n = name.value.trim();
      await this.app.api('create', { name: n, width: Number(w.value), height: Number(h.value) }).catch(() => null);
      f.hidden = true; name.value = '';
      this.app.open({ kind: 'canvas', name: n });
    } } }, name, el('div.row-inline', {}, w, el('span', { text: '×' }), h, el('button.btn.small.primary', { type: 'submit', text: 'Create' }), el('button.btn.small', { type: 'button', text: 'Cancel', on: { click: () => (f.hidden = true) } })));
    this.newName = name;
    return f;
  }
  toggleNew() { this.newForm.hidden = !this.newForm.hidden; if (!this.newForm.hidden) this.newName.focus(); }
  focusSearch() { this.search.focus(); this.search.select(); }

  match(...names) { return !this.filter || names.some((n) => n && n.toLowerCase().includes(this.filter)); }
  visible(id) {
    if (this.app.solo.size && !this.app.solo.has(id)) return false;
    return this.showHidden || !this.app.isHidden(id);
  }

  /** One row. kids: function returning child rows (lazy), or null. */
  row({ id, kind, name, label, meta, thumb, depth = 0, kids, badge, open, actions = true, extra = {} }) {
    const hidden = this.app.isHidden(id), pinned = this.app.isPinned(id), solo = this.app.solo.has(id);
    const exp = kids && (this.filter ? true : this.expanded.has(id));
    const reviews = this.app.reviewCounts?.[id];
    const approved = this.app.approvedSet?.has(id);
    const r = el(`div.row${hidden ? '.is-hidden' : ''}${this.app.currentId === id ? '.active' : ''}`, { role: 'treeitem', dataset: { id, kind, name, open: JSON.stringify(open || { kind, name }), ...extra }, style: { paddingLeft: 6 + depth * 14 + 'px' } },
      el('span.twisty', { text: kids ? (exp ? '▾' : '▸') : '', dataset: { act: kids ? 'toggle' : '' } }),
      thumb ? el('img.thumb', { src: thumb, loading: 'lazy', alt: '' }) : el('span.kicon', { text: KIND_ICON[kind] || '•', style: { color: `var(--k-${kind}, #94a3b8)` } }),
      el('span.label', {}, el('span.name', { text: label ?? name }), meta ? el('span.meta', { text: meta }) : null),
      reviews ? el('span.badge.review', { text: String(reviews), title: `${reviews} open review note(s)` }) : null,
      approved ? el('span.badge.ok', { text: '✓', title: 'approved' }) : null,
      badge ? el('span.badge', { text: badge }) : null,
      actions ? el('span.acts', {},
        el('button.act', { title: solo ? 'Unsolo' : 'Solo (show only this)', text: '◎', dataset: { act: 'solo' }, class: solo ? 'act on' : 'act' }),
        el('button.act', { title: pinned ? 'Unpin' : 'Pin', text: pinned ? '★' : '☆', dataset: { act: 'pin' }, class: pinned ? 'act on' : 'act' }),
        el('button.act', { title: hidden ? 'Show' : 'Hide', text: hidden ? '◌' : '◉', dataset: { act: 'eye' }, class: hidden ? 'act off' : 'act' })) : null);
    const out = [r];
    if (exp) out.push(...kids());
    return out;
  }

  canvasRow(c, depth = 0) {
    const id = assetId('canvas', c.name);
    const size = `${c.width}×${c.height}${c.frames > 1 ? ` ·${c.frames}f` : ''}${c.layers.length > 1 ? ` ·${c.layers.length}L` : ''}`;
    const kids = c.layers.length > 1 || c.animations.length ? () => [
      ...c.animations.map((t) => this.row({ id: `anim:${c.name}/${t}`, kind: 'anim', name: t, depth: depth + 1, actions: false, open: { kind: 'canvas', name: c.name, view: 'anim', tag: t } })).flat(),
      ...[...c.layers].reverse().map((l) => this.row({ id: `layer:${c.name}/${l.name}`, kind: 'layer', name: l.name, meta: l.visible ? '' : 'hidden', depth: depth + 1, actions: false, open: { kind: 'canvas', name: c.name } })).flat(),
    ] : null;
    return this.row({ id, kind: 'canvas', name: c.name, meta: size, thumb: thumbURL('canvas', c.name, c.version), depth, kids });
  }

  async render() {
    const a = this.app.assets;
    if (!a) return;
    const st = this.tree.scrollTop;
    const frag = document.createDocumentFragment();
    this.hiddenBtn.textContent = this.showHidden ? '◉ hidden' : '◌ hidden';
    this.hiddenBtn.classList.toggle('on', this.showHidden);
    this.soloBtn.hidden = !this.app.solo.size;
    const canvasesByName = new Map(a.canvases.map((c) => [c.name, c]));
    const section = (key, title, count, rows) => {
      if (!count && key !== 'canvases') return;
      const col = this.collapsed.has(key) && !this.filter;
      frag.append(el('div.section', { dataset: { act: 'section', key } }, el('span.twisty', { text: col ? '▸' : '▾' }), el('span', { text: title }), el('span.count', { text: count })));
      if (!col) { const r = rows(); if (!r.length && this.filter) frag.append(el('div.empty-row', { text: 'no matches' })); frag.append(...r.slice(0, 4000)); }
    };
    const keep = (id, ...names) => this.visible(id) && this.match(...names);

    // pinned
    const pinned = this.app.uiState.pinned.filter((id) => this.visible(id));
    section('pinned', 'Pinned', pinned.length, () => pinned.flatMap((id) => {
      const [kind, name] = [id.slice(0, id.indexOf(':')), id.slice(id.indexOf(':') + 1)];
      if (kind === 'canvas' && canvasesByName.has(name)) return this.canvasRow(canvasesByName.get(name));
      return this.row({ id, kind, name, thumb: thumbURL(kind, name, a[kind + 's']?.find?.((x) => x.name === name)?.version) });
    }));
    // groups (asset graph)
    const roots = a.groups.filter((g) => !g.parent);
    const groupRows = (g, depth) => this.row({
      id: `group:${g.name}`, kind: 'group', name: g.name, meta: g.note || '', depth, badge: String(g.members.length), open: { kind: 'graph', focus: `group:${g.name}` },
      kids: () => g.members.flatMap((m) => {
        const k = m.slice(0, m.indexOf(':')), n = m.slice(m.indexOf(':') + 1);
        if (k === 'group') { const sub = a.groups.find((x) => x.name === n); return sub ? groupRows(sub, depth + 1) : []; }
        if (!keep(m, n)) return [];
        if (k === 'canvas' && canvasesByName.has(n)) return this.canvasRow(canvasesByName.get(n), depth + 1);
        return this.row({ id: m, kind: k, name: n, depth: depth + 1, thumb: ['model', 'rig'].includes(k) ? thumbURL(k, n, a[k + 's']?.find((x) => x.name === n)?.version || a.models?.find((x) => x.name === n)?.updated) : null });
      }),
    });
    section('groups', 'Groups', a.groups.length, () => roots.flatMap((g) => groupRows(g, 0)));
    // projects
    section('projects', 'Projects', a.projects.length, () => a.projects.flatMap((p) => {
      const items = a.canvases.filter((c) => c.project === p.name && keep(`canvas:${c.name}`, c.name));
      if (this.filter && !items.length && !this.match(p.name)) return [];
      if (!this.visible(`project:${p.name}`)) return [];
      return this.row({ id: `project:${p.name}`, kind: 'project', name: p.name, meta: p.description || '', badge: String(items.length), kids: () => [...items.slice(0, MAX_PER_GROUP).flatMap((c) => this.canvasRow(c, 1)), ...(items.length > MAX_PER_GROUP ? [el('div.empty-row', { text: `+${items.length - MAX_PER_GROUP} more: open the project overview` })] : [])] });
    }));
    // loose canvases (no project, not rig parts / rig outputs)
    const loose = a.canvases.filter((c) => !c.project && c.kind !== 'rigparts' && c.kind !== 'rigout');
    const shown = loose.filter((c) => keep(`canvas:${c.name}`, c.name));
    section('canvases', 'Canvases', loose.length, () => [...shown.slice(0, MAX_PER_GROUP * 2).flatMap((c) => this.canvasRow(c)), ...(!a.canvases.length ? [el('div.empty-row', { text: 'No canvases yet. Ask the agent to draw something, or create one.' })] : [])]);
    // rigs
    section('rigs', 'Rigs', a.rigs.length, () => a.rigs.filter((r) => keep(`rig:${r.name}`, r.name, ...r.outputs)).flatMap((r) => this.row({
      id: `rig:${r.name}`, kind: 'rig', name: r.name, meta: `${r.frame?.join('×')} · ${r.views?.length} views`, thumb: thumbURL('rig', r.name, r.version),
      kids: () => [
        ...(canvasesByName.get(r.canvas) ? this.canvasRow(canvasesByName.get(r.canvas), 1) : []),
        ...r.outputs.filter((o) => canvasesByName.has(o)).flatMap((o) => this.canvasRow(canvasesByName.get(o), 1)),
        ...r.poses.flatMap((p) => this.row({ id: `rigpose:${r.name}/${p}`, kind: 'rigpart', name: `pose ${p}`, depth: 1, actions: false, open: { kind: 'rig', name: r.name, mode: 'pose' } })),
      ],
    })));
    // models
    section('models', '3D models', a.models.length, () => a.models.filter((m) => keep(`model:${m.name}`, m.name)).flatMap((m) => this.row({
      id: `model:${m.name}`, kind: 'model', name: m.name, meta: `${m.parts} parts${m.clips.length ? ` · ${m.clips.length} clips` : ''}`, thumb: thumbURL('model', m.name, m.updated),
      kids: m.named.length || m.clips.length ? () => [
        ...m.clips.flatMap((c) => this.row({ id: `modelclip:${m.name}/${c}`, kind: 'anim', name: c, meta: 'clip', depth: 1, actions: false, open: { kind: 'model', name: m.name, clip: c } })),
        ...m.named.flatMap((p) => this.row({ id: `modelpart:${m.name}/${p}`, kind: 'modelpart', name: p, depth: 1, actions: false, open: { kind: 'model', name: m.name } })),
      ] : null,
    })));
    // audio
    section('audio', 'Audio', a.audio.length, () => a.audio.filter((s) => keep(`audio:${s.name}`, s.name, s.recipe)).flatMap((s) => this.row({
      id: `audio:${s.name}`, kind: 'audio', name: s.name, meta: [s.kind, s.duration !== undefined ? `${(+s.duration).toFixed(2)}s` : '', s.lufs !== undefined ? `${s.lufs} LUFS` : ''].filter(Boolean).join(' · '),
    })));
    // exports: folders
    section('exports', 'Exports', a.exports.length, () => {
      const rows = [];
      const files = a.exports.filter((f) => keep(`export:${f.path}`, f.path)).sort((x, y) => x.path.localeCompare(y.path));
      const dirs = new Map();
      for (const f of files) { const d = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : ''; if (!dirs.has(d)) dirs.set(d, []); dirs.get(d).push(f); }
      for (const [d, list] of dirs) {
        const fileRows = () => list.slice(0, MAX_PER_GROUP).flatMap((f) => this.row({ id: `export:${f.path}`, kind: 'export', name: f.path.split('/').pop(), meta: fmtBytes(f.size), depth: d ? 1 : 0, actions: false, thumb: /\.(png|gif)$/i.test(f.path) ? `/api/export-file?path=${enc(f.path)}&m=${f.mtime}` : null }));
        if (d) rows.push(...this.row({ id: `dir:${d}`, kind: 'file', name: d + '/', badge: String(list.length), actions: false, kids: fileRows, open: { kind: 'none' } }));
        else rows.push(...fileRows());
      }
      return rows;
    });
    this.tree.replaceChildren(frag);
    this.tree.scrollTop = st;
  }

  onClick(e) {
    const sec = e.target.closest('.section');
    if (sec) {
      const k = sec.dataset.key;
      if (this.collapsed.has(k)) this.collapsed.delete(k); else this.collapsed.add(k);
      store.set('collapsed', [...this.collapsed]);
      this.render();
      return;
    }
    const row = e.target.closest('.row');
    if (!row) return;
    const id = row.dataset.id;
    const act = e.target.dataset?.act || e.target.closest('[data-act]')?.dataset.act;
    if (act === 'toggle') {
      if (this.expanded.has(id)) this.expanded.delete(id); else this.expanded.add(id);
      store.set('expanded', [...this.expanded].slice(-500));
      this.render();
      return;
    }
    if (act === 'eye') { this.app.toggleHidden(id); return; }
    if (act === 'pin') { this.app.togglePinned(id); return; }
    if (act === 'solo') { if (this.app.solo.has(id)) this.app.solo.delete(id); else this.app.solo.add(id); this.app.onSoloChange(); return; }
    const open = JSON.parse(row.dataset.open || 'null');
    if (!open || open.kind === 'none') { if (row.querySelector('.twisty')?.textContent) { this.expanded.has(id) ? this.expanded.delete(id) : this.expanded.add(id); this.render(); } return; }
    if (e.altKey || e.shiftKey) { this.app.open(open, { slot: 'B' }); return; }
    this.app.open(open);
  }
  markActive(id) {
    for (const r of this.tree.querySelectorAll('.row.active')) r.classList.remove('active');
    if (id) for (const r of this.tree.querySelectorAll(`.row[data-id="${CSS.escape(id)}"]`)) r.classList.add('active');
  }
  flash(id) {
    for (const r of this.tree.querySelectorAll(`.row[data-id="${CSS.escape(id)}"]`)) { r.classList.add('flash'); setTimeout(() => r.classList.remove('flash'), 900); }
  }
}
