// Canvas viewer/editor: pixel view + paint tools, zoom/pan, grid, 3x3 tile, frame strip with
// onion skin and scrubber, view-only layer solo, PNG/GIF export. Read-only for snapshots/compare.
import { el, enc, api, getJSON, loadBitmap, store, fmtTime } from '../util.js';
import { PixelView } from './pixel.js';

const TOOLS = [['pencil', '✎', 'Pencil (B)'], ['eraser', '⌫', 'Eraser (E)'], ['fill', '◧', 'Fill (G)'], ['line', '╱', 'Line (L)'], ['rect', '▭', 'Rectangle (R), Shift = filled'], ['picker', '⦿', 'Pick colour (I)'], ['hand', '✋', 'Pan (H, or Space / middle drag)']];
export const TOOL_KEYS = { b: 'pencil', e: 'eraser', g: 'fill', l: 'line', r: 'rect', i: 'picker', h: 'hand' };

export class CanvasViewer {
  constructor(host, ctx) {
    this.ctx = ctx; // {app, readOnly}
    this.readOnly = !!ctx.readOnly;
    this.root = el('div.viewer.canvas-viewer');
    host.append(this.root);
    this.name = null;
    this.info = null;
    this.snap = null;
    this.frame = 0;
    this.layerSolo = '';
    this.build();
  }
  get app() { return this.ctx.app; }
  build() {
    const tb = el('div.vtoolbar');
    this.toolBtns = new Map();
    if (!this.readOnly) {
      const g = el('div.group');
      for (const [t, icon, title] of TOOLS) {
        const b = el('button.tool', { title, text: icon, dataset: { tool: t }, on: { click: () => this.app.setTool(t) } });
        this.toolBtns.set(t, b);
        g.append(b);
      }
      tb.append(g);
      this.colorIn = el('input', { type: 'color', value: this.app.color.hex, title: 'Colour', on: { input: () => this.app.setColor(this.colorIn.value + this.alphaHex()) } });
      this.alphaIn = el('input.alpha', { type: 'range', min: 0, max: 255, value: 255, title: 'Alpha', on: { input: () => this.app.setColor(this.colorIn.value + this.alphaHex()) } });
      tb.append(el('div.group', {}, this.colorIn, this.alphaIn));
      tb.append(el('div.group', {},
        el('button.btn', { title: 'Undo (Ctrl+Z)', text: '↶', on: { click: () => this.undo(false) } }),
        el('button.btn', { title: 'Redo (Ctrl+Y)', text: '↷', on: { click: () => this.undo(true) } })));
    }
    this.zoomLabel = el('span.mono.zoom-label', { text: '1×' });
    tb.append(el('div.group', {},
      el('button.btn', { title: 'Zoom out (-)', text: '−', on: { click: () => this.view.zoomBy(-1) } }),
      this.zoomLabel,
      el('button.btn', { title: 'Zoom in (+)', text: '+', on: { click: () => this.view.zoomBy(1) } }),
      el('button.btn', { title: 'Fit (0, or double-click)', text: 'Fit', on: { click: () => this.fit() } })));
    this.gridCb = el('input', { type: 'checkbox', checked: store.get('grid', true), on: { change: () => { this.view.grid = this.gridCb.checked; store.set('grid', this.gridCb.checked); this.view.render(); } } });
    this.tileCb = el('input', { type: 'checkbox', on: { change: () => { this.view.tile = this.tileCb.checked; if (this.view.autoFit) this.view.fit(); this.view.render(); } } });
    tb.append(el('div.group', {}, el('label.toggle', { title: 'Pixel grid (#)' }, this.gridCb, ' Grid'), el('label.toggle', { title: 'Tile 3×3 seam check (T)' }, this.tileCb, ' Tile')));
    this.layerSel = el('select.layer-solo', { title: 'Show one layer only (view only)', on: { change: () => { this.layerSolo = this.layerSel.value; this.loadImage(); } } });
    tb.append(el('div.group', {}, this.layerSel));
    tb.append(el('div.spacer'));
    this.stateBadge = el('span.badge.state', { hidden: true });
    this.exportA = el('a.btn', { text: 'PNG', title: 'Download PNG', download: '' });
    tb.append(this.stateBadge, this.exportA);
    this.root.append(tb);

    this.stage = el('div.stage');
    this.root.append(this.stage);
    this.view = new PixelView(this.stage, {
      editable: !this.readOnly,
      getTool: () => (this.readOnly ? 'hand' : this.app.reviewMode && !this.snap ? 'review' : this.app.tool),
      getColor: () => this.app.color,
      onPick: (hex) => this.app.setColor(hex),
      onCommands: (commands, label) => this.draw(commands, label),
      onHover: (p, c) => this.hover(p, c),
      onZoom: (z) => { this.zoomLabel.textContent = z >= 1 ? `${z}×` : `1/${Math.round(1 / z)}`; },
      onionFrames: () => this.onionFrames(),
      onReview: (r) => this.app.reviewPrompt({ asset: `canvas:${this.name}`, ...(this.nFrames > 1 && this.frameMode() ? { frame: this.frame } : {}), ...(this.tagSel.value ? { tag: this.tagSel.value } : {}), ...(this.layerSolo !== '' ? { layer: this.info.layers[Number(this.layerSolo)]?.name } : {}), ...r }),
      marks: () => (this.snap ? [] : (this.app.reviewMarks?.({ kind: 'canvas', name: this.name }) || []).filter((m) => m.region && (m.frame === undefined || !this.frameMode() || m.frame === this.frame))),
    });
    this.view.grid = this.gridCb.checked;

    // frames strip
    this.frames = el('div.frames-bar', { hidden: true });
    this.frameViewCb = el('input', { type: 'checkbox', checked: true, on: { change: () => this.showFrame(this.frame, true) } });
    this.onionCb = el('input', { type: 'checkbox', on: { change: () => { this.view.onion = this.onionCb.checked; this.view.render(); } } });
    this.scrub = el('input.scrub', { type: 'range', min: 0, max: 0, value: 0, on: { input: () => this.showFrame(Number(this.scrub.value)) } });
    this.frameLabel = el('span.mono');
    this.tagSel = el('select', { on: { change: () => this.renderStrip() } });
    this.gifA = el('a.btn.small', { text: 'GIF', download: '', title: 'Download the selected animation as GIF' });
    this.thumbs = el('div.frame-thumbs');
    this.frames.append(
      el('div.frames-controls', {},
        el('label.toggle', { title: 'Show one frame at a time' }, this.frameViewCb, ' Frame'),
        el('label.toggle', { title: 'Ghost previous (red) and next (blue) frames' }, this.onionCb, ' Onion'),
        el('button.btn.small', { text: '◀', title: 'Previous frame (,)', on: { click: () => this.step(-1) } }),
        this.scrub,
        el('button.btn.small', { text: '▶', title: 'Next frame (.)', on: { click: () => this.step(1) } }),
        this.frameLabel, el('div.spacer'), el('label.toggle', {}, 'Tag ', this.tagSel), this.gifA),
      this.thumbs);
    this.root.append(this.frames);
    this.status = el('div.vstatus.mono', {}, this.metaEl = el('span'), this.cursorEl = el('span'));
    this.root.append(this.status);
    this.setToolUI(this.app.tool);
  }
  alphaHex() { return Number(this.alphaIn?.value ?? 255).toString(16).padStart(2, '0'); }
  setToolUI(t) { for (const [k, b] of this.toolBtns) b.classList.toggle('active', k === t); this.view.canvas.dataset.tool = this.readOnly ? 'hand' : t; }
  setColorUI(hex8) { if (!this.colorIn) return; this.colorIn.value = hex8.slice(0, 7); this.alphaIn.value = hex8.length === 9 ? parseInt(hex8.slice(7), 16) : 255; }
  fit() { this.view.autoFit = true; this.view.fit(); this.view.render(); }

  async open(target) {
    const same = this.name === target.name && !!this.snap === !!target.snap;
    this.name = target.name;
    this.snap = target.snap || null;
    if (!same) { this.view.autoFit = true; this.frame = target.frame ?? 0; this.layerSolo = ''; }
    else if (target.frame !== undefined) this.frame = target.frame;
    if (target.tag) this.pendingTag = target.tag;
    await this.reload();
  }
  async reload() {
    if (this.snap) {
      const meta = await getJSON(`/api/snapshot/${this.snap}`).catch(() => null);
      this.info = meta ? { name: this.name, width: Math.round(meta.width), height: meta.height, frames: meta.frames, frameHeight: meta.frameHeight, layers: [], animations: {}, snapshot: meta } : null;
      this.stateBadge.hidden = false;
      this.stateBadge.textContent = meta ? `snapshot · v${meta.version}${meta.scale > 1 ? ` · 1/${meta.scale}` : ''}` : 'snapshot expired';
      this.exportA.href = `/api/snapshot/${this.snap}.png`;
      this.exportA.setAttribute('download', `${this.name}_${this.snap}.png`);
    } else {
      this.stateBadge.hidden = true;
      try { this.info = await getJSON(`/api/canvas/${enc(this.name)}`); } catch (e) { this.info = null; this.metaEl.textContent = e.message; return; }
      this.exportA.href = `/api/canvas/${enc(this.name)}/png?download=1`;
      this.exportA.setAttribute('download', `${this.name}.png`);
    }
    this.layerSel.hidden = !!this.snap;
    const opts = ['<option value="">all layers</option>', ...(this.info?.layers || []).map((l) => `<option value="${l.index}">${l.name.replace(/</g, '&lt;')}${l.visible ? '' : ' (hidden)'}</option>`)].join('');
    if (this.layerSel.dataset.k !== opts) { this.layerSel.innerHTML = opts; this.layerSel.dataset.k = opts; this.layerSel.value = this.layerSolo; }
    await this.loadImage();
    this.app.inspector?.refreshFor?.(this);
  }
  async loadImage() {
    if (!this.info) return;
    if (this.busy) { this.again = true; return; }
    this.busy = true;
    try {
      const url = this.snap ? `/api/snapshot/${this.snap}.png` : `/api/canvas/${enc(this.name)}/png?t=${Date.now()}${this.layerSolo !== '' ? `&layer=${this.layerSolo}` : ''}`;
      const name = this.name;
      const bmp = await loadBitmap(url);
      if (name !== this.name) return;
      this.strip = bmp;
      this.fh = this.info.frameHeight || bmp.height;
      this.nFrames = Math.max(1, Math.round(bmp.height / this.fh));
      this.frame = Math.min(this.frame, this.nFrames - 1);
      this.showFrame(this.frame, true);
      this.renderStrip();
      this.renderMeta();
    } finally {
      this.busy = false;
      if (this.again) { this.again = false; this.loadImage(); }
    }
  }
  frameMode() { return this.nFrames > 1 && this.frameViewCb.checked; }
  showFrame(f, force = false) {
    if (!this.strip) return;
    f = Math.max(0, Math.min(this.nFrames - 1, f));
    const changed = f !== this.frame;
    this.frame = f;
    const fm = this.frameMode();
    const rect = fm ? { x: 0, y: f * this.fh, w: this.strip.width, h: this.fh } : { x: 0, y: 0, w: this.strip.width, h: this.strip.height };
    if (force) this.view.setImage(this.strip, { rect, frameLines: fm ? null : this.info.frameHeight });
    else this.view.setFrameRect(rect);
    this.scrub.value = f;
    this.frameLabel.textContent = fm ? `${f} / ${this.nFrames - 1}` : `${this.nFrames} frames`;
    if (changed || force) for (const [i, t] of [...this.thumbs.children].entries()) t.classList.toggle('active', i === f);
    this.app.onFrame?.(this, f);
  }
  step(d) { this.showFrame((this.frame + d + this.nFrames) % this.nFrames); }
  onionFrames() {
    if (!this.frameMode()) return null;
    return { prev: this.frame > 0 ? this.frame - 1 : null, next: this.frame < this.nFrames - 1 ? this.frame + 1 : null };
  }
  renderStrip() {
    const tags = Object.keys(this.info?.animations || {});
    const show = this.nFrames > 1 || tags.length;
    this.frames.hidden = !show;
    if (!show) return;
    const want = ['', ...tags].join('|');
    if (this.tagSel.dataset.k !== want) {
      const cur = this.pendingTag ?? this.tagSel.value;
      this.tagSel.innerHTML = '';
      this.tagSel.append(el('option', { value: '', text: 'all frames' }), ...tags.map((t) => el('option', { value: t, text: t })));
      this.tagSel.value = tags.includes(cur) ? cur : '';
      this.tagSel.dataset.k = want;
      this.pendingTag = undefined;
    }
    this.scrub.max = this.nFrames - 1;
    const sel = this.tagSel.value;
    this.gifA.hidden = !!this.snap;
    this.gifA.href = `/api/canvas/${enc(this.name)}/anim.gif?scale=4&download=1${sel ? '&animation=' + enc(sel) : ''}`;
    const tagged = new Set(sel ? this.info.animations[sel].frames : []);
    const w = this.strip.width, fh = this.fh;
    const k = Math.min(1, 44 / Math.max(w, fh));
    const s = Math.max(k, Math.floor(44 / Math.max(w, fh)) || k);
    const dw = Math.max(1, Math.round(w * s)), dh = Math.max(1, Math.round(fh * s));
    if (this.thumbs.children.length !== this.nFrames) {
      this.thumbs.innerHTML = '';
      for (let i = 0; i < this.nFrames; i++) this.thumbs.append(el('div.frame-thumb', { on: { click: () => this.showFrame(i) } }, el('canvas'), el('span', { text: i })));
    }
    [...this.thumbs.children].forEach((t, i) => {
      const c = t.querySelector('canvas');
      c.width = dw; c.height = dh;
      const cx = c.getContext('2d');
      cx.imageSmoothingEnabled = false;
      cx.drawImage(this.strip, 0, i * fh, w, fh, 0, 0, dw, dh);
      t.classList.toggle('active', i === this.frame);
      t.classList.toggle('tagged', tagged.has(i));
    });
  }
  renderMeta() {
    const i = this.info;
    if (!i) return;
    const fh = i.frameHeight;
    this.metaEl.textContent = `${i.name} · ${i.width}×${fh || i.height}${i.frames > 1 ? ` × ${i.frames} frames` : ''}${i.colors ? ` · ${i.colors.unique} colours` : ''}${i.undo !== undefined ? ` · undo ${i.undo}` : ''}${this.snap ? ' · read-only snapshot' : ''}`;
  }
  hover(p, c) {
    if (!p) { this.cursorEl.textContent = ''; return; }
    const fh = this.info?.frameHeight;
    const y = this.frameMode() ? p[1] : p[1];
    const fr = fh && !this.frameMode() ? `  frame ${Math.floor(y / fh)} (y ${y % fh})` : '';
    this.cursorEl.textContent = `x ${p[0]}  y ${y}${fr}  ${c && c.a ? c.hex : 'transparent'}`;
  }
  frameArg() { return this.frameMode() ? { frame: this.frame } : {}; }
  async draw(commands, label) {
    if (this.readOnly || this.snap || !this.name) return;
    await api('draw', { canvas: this.name, label, ...this.frameArg(), commands }).catch(() => {});
  }
  undo(redo) { if (this.name && !this.readOnly && !this.snap) api('undo', { canvas: this.name, ...(redo ? { redo: true } : {}) }).catch(() => {}); }

  /** Live workspace events (only the open canvas matters here). */
  onEvent(ev) {
    if (this.snap || !this.name) return;
    if (ev.type === 'deleted' && ev.canvas === this.name) { this.metaEl.textContent = `${this.name} was deleted ${fmtTime(ev.ts)}`; return; }
    if (ev.type !== 'change' || ev.canvas !== this.name) return;
    if (ev.dirty && ev.source === 'agent') {
      const fh = this.info?.frameHeight;
      if (this.frameMode() && fh) {
        const f = Math.floor(ev.dirty.y / fh);
        if (this.app.following && ev.dirty.y + ev.dirty.h <= (f + 1) * fh) this.frame = f;
        if (f === this.frame) this.view.flash({ ...ev.dirty, y: ev.dirty.y - f * fh });
        const th = this.thumbs.children[f];
        if (th) { th.classList.add('flash'); setTimeout(() => th.classList.remove('flash'), 700); }
      } else this.view.flash(ev.dirty);
    }
    if (ev.op === 'transform') this.view.autoFit = true;
    this.reloadSoon();
  }
  reloadSoon() {
    clearTimeout(this.rt);
    this.rt = setTimeout(() => this.reload(), 60);
  }
  keydown(e, k) {
    if (k === '+' || k === '=') { this.view.zoomBy(1); return true; }
    if (k === '-') { this.view.zoomBy(-1); return true; }
    if (k === '0') { this.fit(); return true; }
    if (k === '#') { this.gridCb.checked = !this.gridCb.checked; this.gridCb.dispatchEvent(new Event('change')); return true; }
    if (k === 't') { this.tileCb.checked = !this.tileCb.checked; this.tileCb.dispatchEvent(new Event('change')); return true; }
    if (k === ',') { this.step(-1); return true; }
    if (k === '.') { this.step(1); return true; }
    if (k === 'n') { this.onionCb.checked = !this.onionCb.checked; this.onionCb.dispatchEvent(new Event('change')); return true; }
    return false;
  }
  destroy() { clearTimeout(this.rt); this.view.destroy(); this.root.remove(); }
}
