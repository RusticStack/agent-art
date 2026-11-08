// Layers view: the ordered part / layer stack of the current rig (pose or clip, view, frame) or
// canvas, live. Per entry: name, z, the rule that placed it, eye + solo (view only). A debug overlay
// tints parts by draw order and highlights overlaps; hovering a pixel tells which part drew it and
// what is underneath. A z-order lane chart (a lane per part across frames) shows ordering flips at a
// glance. "Flag layering" turns two selected parts into a review note for the agent.
import { el, enc, getJSON, loadBitmap, checker } from '../util.js';

const hue = (i, n) => `hsl(${Math.round((i / Math.max(1, n)) * 300)},85%,55%)`;

/** Accept the derived shape or the rig agent's rig_layers / rig_debug_render shapes. */
function normStack(list) {
  return (list || []).map((e, i) => ({
    part: e.part ?? e.name ?? e.layer ?? `#${i}`, z: e.z ?? e.order ?? i, rule: e.rule ?? e.reason ?? e.why ?? '',
    hidden: !!(e.hidden ?? (e.visible === false)), why_hidden: e.why_hidden, parent: e.parent ?? null,
  }));
}

export class LayersViewer {
  constructor(host, ctx) {
    this.ctx = ctx;
    this.root = el('div.viewer.layers-viewer');
    host.append(this.root);
    this.off = new Set(); // parts hidden in this view
    this.solo = null;
    this.sel = [];
    this.frame = 0;
    this.viewSel = el('select', { on: { change: () => this.load() } });
    this.tagSel = el('select', { on: { change: () => { this.frame = 0; this.load(); } } });
    this.debugCb = el('input', { type: 'checkbox', checked: true, on: { change: () => this.draw() } });
    this.overCb = el('input', { type: 'checkbox', checked: true, on: { change: () => this.draw() } });
    this.scrub = el('input.scrub', { type: 'range', min: 0, max: 0, value: 0, on: { input: () => this.setFrame(Number(this.scrub.value)) } });
    this.frameLabel = el('span.mono');
    this.flagBtn = el('button.btn.warn', { text: 'Flag layering', title: 'Select two parts in the stack, then flag their order for the agent', disabled: true, on: { click: () => this.flag() } });
    this.root.append(el('div.vtoolbar', {},
      this.viewG = el('div.group', {}, el('span.muted', { text: 'View' }), this.viewSel),
      this.tagG = el('div.group', {}, el('span.muted', { text: 'Clip' }), this.tagSel),
      el('div.group', {}, el('button.btn.small', { text: '◀', on: { click: () => this.setFrame(this.frame - 1) } }), this.scrub, el('button.btn.small', { text: '▶', on: { click: () => this.setFrame(this.frame + 1) } }), this.frameLabel),
      el('div.group', {}, el('label.toggle', { title: 'Tint parts by draw order (debug overlay)' }, this.debugCb, ' Debug tint'), el('label.toggle', { title: 'Highlight pixels where parts overlap' }, this.overCb, ' Overlaps')),
      el('div.spacer'), this.flagBtn));
    this.canvas = el('canvas.layers-canvas');
    this.hoverEl = el('div.hover-info.mono', { text: 'Hover a pixel: which part drew it, and what is underneath' });
    this.stackEl = el('div.stack-list');
    this.lanes = el('canvas.z-lanes');
    this.source = el('div.muted.small');
    this.root.append(el('div.layers-body', {},
      el('div.layers-stage', {}, el('div.center-scroll', {}, this.canvas), this.hoverEl),
      el('div.layers-side', {}, el('div.panel-label', { text: 'Draw order (top first)' }), this.stackEl, this.source)),
      el('div.lanes-wrap', {}, el('div.panel-label', { text: 'Z order across frames (a lane per part; crossings = order flips)' }), this.lanes));
    this.canvas.addEventListener('pointermove', (e) => this.hover(e));
    this.canvas.addEventListener('pointerleave', () => (this.hoverEl.textContent = ''));
    this.lanes.addEventListener('click', (e) => { const r = this.lanes.getBoundingClientRect(); const n = this.layerData?.frames.length || 1; this.setFrame(Math.floor(((e.clientX - r.left - 90) / Math.max(1, r.width - 100)) * n)); });
  }
  get app() { return this.ctx.app; }

  async open(target) {
    this.target = target;
    this.mode = 'rig';
    // a rig output canvas plays a clip of its rig; a plain canvas shows its layers
    if (target.kind === 'canvas') {
      this.info = await getJSON(`/api/canvas/${enc(target.name)}`).catch(() => null);
      const rigName = typeof this.info?.meta?.rig === 'string' ? this.info.meta.rig : /_parts$/.test(target.name) && this.info?.meta?.rig ? target.name.slice(0, -6) : null;
      if (rigName) { this.rig = rigName; this.canvasName = /_parts$/.test(target.name) ? null : target.name; }
      else { this.mode = 'canvas'; this.rig = null; this.canvasName = target.name; }
    } else { this.rig = target.name; this.canvasName = target.canvas || null; }
    this.viewG.hidden = this.mode !== 'rig';
    if (this.mode === 'rig') {
      const outs = this.app.assets?.rigs?.find((r) => r.name === this.rig)?.outputs || [];
      const tags = [];
      for (const o of outs) {
        const info = o === this.canvasName && this.info ? this.info : await getJSON(`/api/canvas/${enc(o)}`).catch(() => null);
        for (const t of Object.keys(info?.animations || {})) tags.push(`${o}/${t}`);
      }
      const k = tags.join('|');
      if (this.tagSel.dataset.k !== k) {
        this.tagSel.innerHTML = '';
        this.tagSel.append(el('option', { value: '', text: 'rest pose' }), ...tags.map((t) => el('option', { value: t, text: t })));
        this.tagSel.dataset.k = k;
      }
      const want = target.tag && this.canvasName ? `${this.canvasName}/${target.tag}` : this.canvasName ? tags.find((t) => t.startsWith(this.canvasName + '/')) : null;
      if (want && tags.includes(want)) this.tagSel.value = want;
      if (target.frame !== undefined) this.frame = target.frame;
    } else {
      this.tagSel.innerHTML = '';
      this.tagSel.append(el('option', { value: '', text: `${this.info?.frames || 1} frame(s)` }));
    }
    await this.load();
  }
  query() {
    const q = new URLSearchParams();
    const [canvas, tag] = (this.tagSel.value || '').split('/');
    if (tag) { q.set('canvas', canvas); q.set('tag', tag); }
    if (this.viewSel.value) q.set('view', this.viewSel.value);
    return q;
  }
  async load() {
    if (this.mode === 'canvas') return this.loadCanvas();
    const q = this.query();
    this.layerData = await getJSON(`/api/rig/${enc(this.rig)}/layers?${q}`).catch((e) => ({ error: e.message }));
    if (this.layerData.error) { this.source.textContent = this.layerData.error; return; }
    this.layerData.frames = (this.layerData.frames || []).map((f, i) => ({ frame: f.frame ?? i, stack: normStack(f.stack ?? f.parts ?? f.layers) }));
    const views = this.layerData.views || [];
    if (this.viewSel.dataset.k !== views.join('|')) {
      this.viewSel.innerHTML = '';
      for (const v of views) this.viewSel.append(el('option', { value: v, text: v }));
      this.viewSel.dataset.k = views.join('|');
    }
    if (this.layerData.view) this.viewSel.value = this.layerData.view;
    this.scrub.max = Math.max(0, this.layerData.frames.length - 1);
    this.source.textContent = `source: ${this.layerData.source || 'rig_layers'}`;
    await this.setFrame(Math.min(this.frame, this.layerData.frames.length - 1), true);
  }
  async loadCanvas() {
    const info = this.info;
    if (!info) return;
    const n = info.frames || 1;
    // canvas layers: bottom = index 0
    const stack = info.layers.map((l, i) => ({ part: l.name, z: i, rule: `layer ${i}${l.blend && l.blend !== 'normal' ? ` · ${l.blend}` : ''}${l.opacity < 1 ? ` · ${Math.round(l.opacity * 100)}%` : ''}`, hidden: !l.visible, index: i }));
    this.layerData = { frames: Array.from({ length: n }, (_, i) => ({ frame: i, stack })), source: 'canvas layers' };
    this.scrub.max = n - 1;
    this.source.textContent = 'source: canvas layers (bottom = layer 0)';
    await this.setFrame(Math.min(this.frame, n - 1), true);
  }
  async setFrame(f, force) {
    const n = this.layerData?.frames.length || 1;
    f = Math.max(0, Math.min(n - 1, f || 0));
    if (f === this.frame && !force) return;
    this.frame = f;
    this.scrub.value = f;
    this.frameLabel.textContent = `${f} / ${n - 1}`;
    const token = (this.token = {});
    if (this.mode === 'rig') {
      const q = this.query();
      q.set('frame', f);
      const d = await getJSON(`/api/rig/${enc(this.rig)}/debug?${q}`).catch((e) => ({ error: e.message }));
      if (token !== this.token) return;
      if (d.error) { this.hoverEl.textContent = d.error; return; }
      this.size = d.size;
      this.parts = d.atlas_parts || normStack(d.stack).filter((s) => !s.hidden).map((s) => s.part);
      this.stack = normStack(d.stack || this.layerData.frames[f].stack);
      this.atlas = await loadBitmap(`data:image/png;base64,${d.atlas}`);
      this.cells = this.parts.map((_, i) => ({ y: i * d.size[1] }));
    } else {
      const info = this.info, fh = info.frameHeight || info.height;
      this.size = [info.width, fh];
      this.stack = this.layerData.frames[f].stack;
      this.parts = this.stack.map((s) => s.part);
      const imgs = await Promise.all(this.stack.map((s) => loadBitmap(`/api/canvas/${enc(info.name)}/png?layer=${s.index}${info.frames > 1 ? `&frame=${f}` : ''}&t=${info.version}`)));
      if (token !== this.token) return;
      const c = new OffscreenCanvas(info.width, fh * Math.max(1, imgs.length));
      const x = c.getContext('2d');
      imgs.forEach((im, i) => x.drawImage(im, 0, i * fh));
      this.atlas = c;
      this.cells = imgs.map((_, i) => ({ y: i * fh }));
    }
    // per-part alpha for hit tests / overlaps
    const [W, H] = this.size;
    const oc = new OffscreenCanvas(W, H * Math.max(1, this.parts.length));
    const ox = oc.getContext('2d', { willReadFrequently: true });
    ox.drawImage(this.atlas, 0, 0);
    this.alpha = this.parts.map((_, i) => ox.getImageData(0, i * H, W, H).data);
    this.renderStack();
    this.draw();
    this.drawLanes();
  }
  visibleParts() {
    return this.parts.map((p, i) => ({ p, i })).filter(({ p }) => (this.solo ? p === this.solo : !this.off.has(p)));
  }
  draw() {
    if (!this.atlas) return;
    const [W, H] = this.size;
    const box = this.canvas.parentElement.getBoundingClientRect();
    const s = Math.max(1, Math.min(16, Math.floor(Math.min((box.width - 20) / W, (box.height - 20) / H))));
    this.scale = s;
    const c = this.canvas;
    c.width = W * s; c.height = H * s;
    const x = c.getContext('2d');
    checker(x, 0, 0, c.width, c.height, Math.max(4, s * 2));
    x.imageSmoothingEnabled = false;
    const vis = this.visibleParts();
    const tint = this.debugCb.checked;
    for (const { i } of vis) {
      x.drawImage(this.atlas, 0, this.cells[i].y, W, H, 0, 0, W * s, H * s);
      if (tint) {
        const t = new OffscreenCanvas(W, H), tx = t.getContext('2d');
        tx.drawImage(this.atlas, 0, this.cells[i].y, W, H, 0, 0, W, H);
        tx.globalCompositeOperation = 'source-atop';
        tx.fillStyle = hue(i, this.parts.length);
        tx.fillRect(0, 0, W, H);
        x.globalAlpha = 0.55;
        x.drawImage(t, 0, 0, W * s, H * s);
        x.globalAlpha = 1;
      }
    }
    if (this.overCb.checked) {
      x.fillStyle = 'rgba(229,72,77,.55)';
      for (let y = 0; y < H; y++) for (let xx = 0; xx < W; xx++) {
        let n = 0;
        for (const { i } of vis) if (this.alpha[i][(y * W + xx) * 4 + 3]) n++;
        if (n >= 2 && ((xx + y) & 1)) x.fillRect(xx * s, y * s, s, s);
      }
    }
    // selected parts outlined
    for (const [k, part] of this.sel.entries()) {
      const i = this.parts.indexOf(part);
      if (i < 0) continue;
      x.fillStyle = k === 0 ? 'rgba(56,189,248,.9)' : 'rgba(245,165,36,.9)';
      const a = this.alpha[i];
      for (let y = 0; y < H; y++) for (let xx = 0; xx < W; xx++) {
        if (!a[(y * W + xx) * 4 + 3]) continue;
        const edge = xx === 0 || y === 0 || xx === W - 1 || y === H - 1 || !a[(y * W + xx - 1) * 4 + 3] || !a[(y * W + xx + 1) * 4 + 3] || !a[((y - 1) * W + xx) * 4 + 3] || !a[((y + 1) * W + xx) * 4 + 3];
        if (edge) x.fillRect(xx * s, y * s, s, Math.max(1, s / 4));
      }
    }
  }
  hover(e) {
    if (!this.alpha) return;
    const r = this.canvas.getBoundingClientRect();
    const [W] = this.size;
    const px = Math.floor((e.clientX - r.left) / this.scale), py = Math.floor((e.clientY - r.top) / this.scale);
    const hits = this.visibleParts().filter(({ i }) => this.alpha[i][(py * W + px) * 4 + 3]).reverse();
    const z = (p) => this.stack.find((s) => s.part === p)?.z;
    this.hoverEl.textContent = hits.length
      ? `x ${px} y ${py}: drawn by ${hits[0].p} (z ${z(hits[0].p)})${hits.length > 1 ? ` · underneath: ${hits.slice(1).map((h) => `${h.p} (z ${z(h.p)})`).join(', ')}` : ''}`
      : `x ${px} y ${py}: empty`;
  }
  renderStack() {
    this.stackEl.innerHTML = '';
    const list = [...this.stack].reverse(); // top first
    const n = this.stack.length;
    for (const s of list) {
      const idx = this.stack.indexOf(s);
      const off = this.off.has(s.part), solo = this.solo === s.part, selK = this.sel.indexOf(s.part);
      const row = el(`div.stack-row${s.hidden ? '.is-hidden' : ''}${selK >= 0 ? `.sel${selK}` : ''}`, { title: s.why_hidden || '', on: { click: (e) => { if (e.target.closest('button')) return; this.toggleSel(s.part); } } },
        el('i.swatch-dot', { style: { background: hue(this.parts.indexOf(s.part) < 0 ? idx : this.parts.indexOf(s.part), this.parts.length) } }),
        el('button.act', { text: off ? '◌' : '◉', title: off ? 'Show' : 'Hide (view only)', on: { click: () => { off ? this.off.delete(s.part) : this.off.add(s.part); this.renderStack(); this.draw(); } } }),
        el('button.act' + (solo ? '.on' : ''), { text: '◎', title: solo ? 'Unsolo' : 'Solo', on: { click: () => { this.solo = solo ? null : s.part; this.renderStack(); this.draw(); } } }),
        el('span.sname', { text: s.part }),
        el('span.sz.mono', { text: `z ${s.z}` }),
        el('span.srule.muted', { text: s.hidden ? s.why_hidden || 'hidden' : s.rule }));
      this.stackEl.append(row);
    }
    if (!n) this.stackEl.append(el('div.muted', { text: 'Nothing drawn in this frame.' }));
    this.flagBtn.disabled = this.sel.length !== 2;
    this.flagBtn.textContent = this.sel.length === 2 ? `Flag: ${this.sel[0]} above ${this.sel[1]}?` : 'Flag layering (select 2)';
  }
  toggleSel(part) {
    const i = this.sel.indexOf(part);
    if (i >= 0) this.sel.splice(i, 1);
    else { this.sel.push(part); if (this.sel.length > 2) this.sel.shift(); }
    this.renderStack();
    this.draw();
  }
  drawLanes() {
    const frames = this.layerData?.frames || [];
    const parts = [...new Set(frames.flatMap((f) => f.stack.map((s) => s.part)))];
    const c = this.lanes, dpr = window.devicePixelRatio || 1;
    const r = c.parentElement.getBoundingClientRect();
    const rowH = 14, H = Math.max(40, parts.length * rowH + 16);
    c.width = Math.max(1, r.width * dpr); c.height = H * dpr;
    c.style.height = H + 'px';
    const x = c.getContext('2d');
    x.setTransform(dpr, 0, 0, dpr, 0, 0);
    x.fillStyle = '#15171c'; x.fillRect(0, 0, r.width, H);
    const L = 90, W = r.width - L - 10, n = Math.max(1, frames.length);
    const fx = (i) => L + (n === 1 ? W / 2 : (i / (n - 1)) * W);
    // rank 0 = bottom of the stack = bottom lane
    const yOf = (rank) => H - 10 - rank * rowH;
    x.font = '10px ui-monospace, monospace';
    for (let k = 0; k < parts.length; k++) { x.fillStyle = 'rgba(255,255,255,.04)'; if (k % 2) x.fillRect(L, yOf(k) - rowH / 2, W, rowH); }
    parts.forEach((p, pi) => {
      const col = hue(this.parts?.indexOf(p) >= 0 ? this.parts.indexOf(p) : pi, parts.length);
      x.strokeStyle = col; x.lineWidth = this.sel.includes(p) ? 3 : 1.5;
      x.beginPath();
      let pen = false, last = null;
      frames.forEach((f, i) => {
        const e = f.stack.find((s) => s.part === p);
        const rank = f.stack.indexOf(e);
        if (!e || e.hidden) { pen = false; return; }
        const X = fx(i), Y = yOf(rank);
        if (pen) x.lineTo(X, Y); else x.moveTo(X, Y);
        pen = true; last = Y;
      });
      x.stroke();
      const r0 = frames[0]?.stack.findIndex((s) => s.part === p);
      x.fillStyle = col;
      x.fillText(p, 4, (r0 >= 0 ? yOf(r0) : last ?? 10) + 3);
    });
    x.fillStyle = '#f5a524'; x.fillRect(fx(this.frame) - 1, 0, 2, H);
  }
  flag() {
    if (this.sel.length !== 2) return;
    const [a, b] = this.sel;
    const view = this.viewSel.value || undefined;
    const [canvas, tag] = (this.tagSel.value || '').split('/');
    const asset = this.mode === 'canvas' ? `canvas:${this.canvasName}` : canvas ? `canvas:${canvas}` : `rig:${this.rig}`;
    this.app.reviewPrompt({ asset, frame: this.mode === 'canvas' || canvas ? (canvas && tag ? this.tagFrame(canvas, tag) : this.frame) : undefined, view, tag: tag || undefined, part: `${a},${b}`, category: 'layering', note: `${a} should be above ${b}`, priority: 'high' });
  }
  /** Absolute frame on the output canvas for the tag's i-th frame. */
  tagFrame(canvas, tag) {
    const info = canvas === this.canvasName ? this.info : null;
    return info?.animations?.[tag]?.frames?.[this.frame] ?? this.frame;
  }
  onEvent(ev) {
    if (ev.type !== 'change') return;
    const hit = this.mode === 'canvas' ? ev.canvas === this.canvasName : ev.canvas === `${this.rig}_parts` || ev.canvas === this.tagSel.value.split('/')[0];
    if (hit) { clearTimeout(this.rt); this.rt = setTimeout(() => this.open(this.target), 250); }
  }
  keydown(e, k) {
    if (k === ',') { this.setFrame(this.frame - 1); return true; }
    if (k === '.') { this.setFrame(this.frame + 1); return true; }
    return false;
  }
  destroy() { clearTimeout(this.rt); this.root.remove(); }
}
