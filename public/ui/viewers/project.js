// Project overview: every canvas of a project as a grid of lazily loaded thumbnails (live: the
// tile the agent changes flashes and scrolls into view; new canvases appear).
import { el, enc, getJSON, store, thumbURL } from '../util.js';

export class ProjectViewer {
  constructor(host, ctx) {
    this.ctx = ctx;
    this.root = el('div.viewer.project-viewer');
    host.append(this.root);
    this.size = el('input', { type: 'range', min: 32, max: 256, step: 16, value: store.get('ovSize', 96), on: { input: () => { this.grid.style.setProperty('--ov', this.size.value + 'px'); store.set('ovSize', Number(this.size.value)); } } });
    this.title = el('h1');
    this.desc = el('p.muted');
    this.root.append(el('div.vtoolbar', {}, this.title, el('div.spacer'), el('label.toggle', {}, 'Size ', this.size)));
    this.scroll = el('div.ov-scroll');
    this.grid = el('div.ov-grid');
    this.grid.style.setProperty('--ov', this.size.value + 'px');
    this.scroll.append(this.desc, this.grid);
    this.root.append(this.scroll);
    this.tiles = new Map();
  }
  async open(target) {
    this.name = target.name;
    this.p = await getJSON(`/api/project/${enc(this.name)}`).catch((e) => ({ error: e.message }));
    if (this.p.error) { this.title.textContent = this.p.error; return; }
    this.title.textContent = this.p.name;
    const fmt = this.p.meta?.minecraft ? ` · Minecraft ${this.p.meta.minecraft}` : '';
    this.desc.textContent = `${this.p.canvases.length} canvases${fmt}${this.p.description ? ' — ' + this.p.description : ''}`;
    this.grid.innerHTML = '';
    this.tiles.clear();
    const versions = new Map((this.ctx.app.assets?.canvases || []).map((c) => [c.name, c.version]));
    for (const c of this.p.canvases) {
      if (this.ctx.app.isHidden(`canvas:${c.name}`)) continue;
      this.tile(c.name, versions.get(c.name), c.meta?.texture);
    }
  }
  tile(name, version, texture, isNew) {
    let t = this.tiles.get(name);
    if (!t) {
      t = el('div.ov-tile' + (isNew ? '.new' : ''), { title: name, on: { click: () => this.ctx.app.open({ kind: 'canvas', name }) } }, el('img', { alt: '', loading: 'lazy' }), el('span.n', { text: name }), el('span.t'));
      this.grid.append(t);
      this.tiles.set(name, t);
    }
    if (texture !== undefined) t.querySelector('.t').textContent = [].concat(texture || []).join(', ');
    t.querySelector('img').src = thumbURL('canvas', name, version ?? Date.now());
    return t;
  }
  onEvent(ev) {
    if (ev.type === 'project' && ev.project === this.name) { clearTimeout(this.rt); this.rt = setTimeout(() => this.open({ name: this.name }), 300); return; }
    if (ev.type === 'deleted') { const t = this.tiles.get(ev.canvas); if (t) { t.remove(); this.tiles.delete(ev.canvas); } return; }
    if (ev.type !== 'change' || ev.project !== this.name) return;
    const isNew = !this.tiles.has(ev.canvas);
    const t = this.tile(ev.canvas, `${ev.version}-${ev.ts}`, undefined, isNew);
    if (ev.source === 'agent') {
      t.classList.add('flash');
      setTimeout(() => t.classList.remove('flash'), 900);
      t.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }
  keydown() { return false; }
  destroy() { clearTimeout(this.rt); this.root.remove(); }
}
