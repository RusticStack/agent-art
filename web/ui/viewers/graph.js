// Asset graph view: force-directed (or layered by kind) layout on a 2D canvas, so it stays fast with
// thousands of nodes (grid-bucketed repulsion, viewport culling, thumbnails only when zoomed in).
// Nodes are coloured by kind with review badges; edges carry their relation; filter by relation,
// tag or text; collapse groups; click selects (inspector shows relations), double-click opens.
import { el, getJSON, KIND_COLOR, KIND_ICON, thumbURL, splitId, store } from '../util.js';

const SUB_KINDS = new Set(['layer', 'anim', 'frame', 'rigpart', 'modelpart']);
const REL_COLOR = { part_of: '#64748b', variant_of: '#a78bfa', view_of: '#38bdf8', layer_of: '#475569', uses_palette: '#22c55e', rendered_from: '#f472b6', exports_to: '#94a3b8', depends_on: '#f5a524', replaces: '#e5484d' };
const relColor = (r) => REL_COLOR[r] || '#c084fc';

export class GraphViewer {
  constructor(host, ctx) {
    this.ctx = ctx;
    this.root = el('div.viewer.graph-viewer');
    host.append(this.root);
    this.nodes = new Map();
    this.edges = [];
    this.view = { x: 0, y: 0, k: 1 };
    this.collapsed = new Set(store.get('graphCollapsed', []));
    this.hiddenRels = new Set(store.get('graphHiddenRels', ['layer_of']));
    this.showSub = store.get('graphSub', false);
    this.layout = store.get('graphLayout', 'force');
    this.thumbs = new Map();
    this.build();
    this.raf = requestAnimationFrame(() => this.loop());
  }
  get app() { return this.ctx.app; }
  build() {
    this.search = el('input.search', { placeholder: 'Find node…', on: { input: () => this.focusSearch() } });
    this.tagSel = el('select', { on: { change: () => this.applyFilter() } });
    this.subCb = el('input', { type: 'checkbox', checked: this.showSub, on: { change: () => { this.showSub = this.subCb.checked; store.set('graphSub', this.showSub); this.applyFilter(); } } });
    this.layoutSel = el('select', { on: { change: () => { this.layout = this.layoutSel.value; store.set('graphLayout', this.layout); this.relayout(); } } }, el('option', { value: 'force', text: 'Force' }), el('option', { value: 'layered', text: 'Layered by kind' }));
    this.layoutSel.value = this.layout;
    this.relBox = el('div.rel-filter');
    this.root.append(el('div.vtoolbar', {}, this.search, el('div.group', {}, el('span.muted', { text: 'Tag' }), this.tagSel),
      el('label.toggle', { title: 'Layers, animation tags, rig and model parts' }, this.subCb, ' Sub-assets'),
      el('div.group', {}, this.layoutSel, el('button.btn', { text: 'Fit', on: { click: () => this.fit() } })), el('div.spacer'), this.counts = el('span.mono.muted')));
    this.root.append(this.relBox);
    this.stage = el('div.graph-stage');
    this.canvas = el('canvas.graph-canvas', { tabindex: '0' });
    this.stage.append(this.canvas);
    this.root.append(this.stage);
    this.tip = el('div.graph-tip', { hidden: true });
    this.stage.append(this.tip);
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(this.stage);
    this.bind();
  }
  resize() {
    const r = this.stage.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.max(1, r.width * dpr); this.canvas.height = Math.max(1, r.height * dpr);
    this.canvas.style.width = r.width + 'px'; this.canvas.style.height = r.height + 'px';
    this.W = r.width; this.H = r.height;
    this.dirty = true;
  }
  async open(target) {
    this.target = target;
    await this.reload(true);
    if (target.focus) this.select(target.focus, true);
  }
  async reload(first) {
    const g = await getJSON('/api/graph');
    this.rels = [...new Set([...g.rels, ...g.edges.map((e) => e.rel)])];
    const old = this.nodes;
    this.nodes = new Map();
    for (const n of g.nodes) {
      const o = old.get(n.id);
      const [kind, name] = splitId(n.id);
      this.nodes.set(n.id, { ...n, kind, name, x: o?.x ?? (Math.random() - 0.5) * 600, y: o?.y ?? (Math.random() - 0.5) * 600, vx: 0, vy: 0, fixed: o?.fixed, deg: 0 });
    }
    this.allEdges = g.edges.filter((e) => this.nodes.has(e.from) && this.nodes.has(e.to));
    for (const e of this.allEdges) { this.nodes.get(e.from).deg++; this.nodes.get(e.to).deg++; }
    // tags
    const tags = [...new Set(g.nodes.flatMap((n) => n.tags || []))].sort();
    const want = tags.join('|');
    if (this.tagSel.dataset.k !== want) { const cur = this.tagSel.value; this.tagSel.innerHTML = ''; this.tagSel.append(el('option', { value: '', text: 'any' }), ...tags.map((t) => el('option', { value: t, text: '#' + t }))); this.tagSel.value = tags.includes(cur) ? cur : ''; this.tagSel.dataset.k = want; }
    this.relBox.innerHTML = '';
    for (const r of this.rels) {
      const cb = el('input', { type: 'checkbox', checked: !this.hiddenRels.has(r), on: { change: () => { if (cb.checked) this.hiddenRels.delete(r); else this.hiddenRels.add(r); store.set('graphHiddenRels', [...this.hiddenRels]); this.applyFilter(); } } });
      this.relBox.append(el('label.rel-chip', { style: { borderColor: relColor(r) } }, cb, ' ' + r));
    }
    this.applyFilter(first);
  }
  /** Visible nodes/edges after filters and group collapse (collapsed members fold into the group). */
  applyFilter(first) {
    const tag = this.tagSel.value;
    const parentOf = new Map();
    for (const e of this.allEdges) if (e.rel === 'part_of' && e.to.startsWith('group:')) parentOf.set(e.from, e.to);
    const rep = (id) => {
      // the outermost collapsed group containing id (cycle safe)
      let cur = id, out = id;
      const seen = new Set();
      while (parentOf.has(cur) && !seen.has(cur)) { seen.add(cur); cur = parentOf.get(cur); if (this.collapsed.has(cur)) out = cur; }
      return out;
    };
    const vis = new Set();
    for (const n of this.nodes.values()) {
      if (!this.showSub && SUB_KINDS.has(n.kind)) continue;
      if (tag && !(n.tags || []).includes(tag) && n.kind !== 'group') continue;
      const r = rep(n.id);
      if (r !== n.id) continue;
      vis.add(n.id);
    }
    const seen = new Set();
    this.edges = [];
    for (const e of this.allEdges) {
      if (this.hiddenRels.has(e.rel)) continue;
      const a = rep(e.from), b = rep(e.to);
      if (a === b || !vis.has(a) || !vis.has(b)) continue;
      const k = `${a}|${e.rel}|${b}`;
      if (seen.has(k)) continue;
      seen.add(k);
      this.edges.push({ ...e, a: this.nodes.get(a), b: this.nodes.get(b) });
    }
    // with a tag filter, drop isolated groups
    this.vis = [...vis].map((id) => this.nodes.get(id)).filter((n) => !tag || n.kind !== 'group' || this.edges.some((e) => e.a === n || e.b === n));
    this.counts.textContent = `${this.vis.length} nodes · ${this.edges.length} edges${this.collapsed.size ? ` · ${this.collapsed.size} collapsed` : ''}`;
    this.relayout(first);
  }
  relayout(fit) {
    if (this.layout === 'layered') {
      const order = ['group', 'project', 'rig', 'model', 'canvas', 'audio', 'palette', 'export', 'file', 'layer', 'anim', 'frame', 'rigpart', 'modelpart'];
      const cols = new Map();
      for (const n of this.vis) { const k = order.includes(n.kind) ? n.kind : 'file'; if (!cols.has(k)) cols.set(k, []); cols.get(k).push(n); }
      let ci = 0;
      for (const k of order) {
        const list = cols.get(k);
        if (!list) continue;
        list.sort((a, b) => a.id.localeCompare(b.id));
        list.forEach((n, i) => { n.x = ci * 220; n.y = (i - list.length / 2) * 46; n.vx = n.vy = 0; });
        ci++;
      }
      this.alpha = 0;
    } else this.alpha = 1;
    this.dirty = true;
    if (fit) setTimeout(() => this.fit(), this.layout === 'force' ? 700 : 0);
  }
  step() {
    const ns = this.vis;
    if (!ns?.length || this.alpha < 0.01) return false;
    const a = this.alpha, R = 140;
    // grid-bucketed repulsion (O(n) per tick for spread-out graphs)
    const grid = new Map();
    for (const n of ns) { const k = `${Math.floor(n.x / R)},${Math.floor(n.y / R)}`; if (!grid.has(k)) grid.set(k, []); grid.get(k).push(n); }
    for (const n of ns) {
      const gx = Math.floor(n.x / R), gy = Math.floor(n.y / R);
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (const m of grid.get(`${gx + dx},${gy + dy}`) || []) {
        if (m === n) continue;
        let x = n.x - m.x, y = n.y - m.y, d2 = x * x + y * y;
        if (d2 > R * R) continue;
        if (d2 < 1) { x = Math.random() - 0.5; y = Math.random() - 0.5; d2 = 1; }
        const f = (900 / d2) * a;
        n.vx += x * f * 0.05; n.vy += y * f * 0.05;
      }
    }
    for (const e of this.edges) {
      const x = e.b.x - e.a.x, y = e.b.y - e.a.y, d = Math.hypot(x, y) || 1;
      const want = e.rel === 'part_of' ? 70 : 110;
      const f = ((d - want) / d) * 0.04 * a;
      e.a.vx += x * f; e.a.vy += y * f; e.b.vx -= x * f; e.b.vy -= y * f;
    }
    for (const n of ns) {
      n.vx -= n.x * 0.002 * a; n.vy -= n.y * 0.002 * a; // gravity
      if (n.fixed || n === this.drag?.n) { n.vx = n.vy = 0; continue; }
      n.vx *= 0.6; n.vy *= 0.6;
      n.x += Math.max(-30, Math.min(30, n.vx)); n.y += Math.max(-30, Math.min(30, n.vy));
    }
    this.alpha *= 0.985;
    return true;
  }
  loop() {
    this.raf = requestAnimationFrame(() => this.loop());
    const moved = this.step();
    if (moved || this.dirty) { this.draw(); this.dirty = false; }
  }
  fit() {
    if (!this.vis?.length) return;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const n of this.vis) { x0 = Math.min(x0, n.x); y0 = Math.min(y0, n.y); x1 = Math.max(x1, n.x); y1 = Math.max(y1, n.y); }
    const k = Math.min(2, Math.min((this.W - 80) / Math.max(1, x1 - x0), (this.H - 80) / Math.max(1, y1 - y0)));
    this.view = { k, x: this.W / 2 - ((x0 + x1) / 2) * k, y: this.H / 2 - ((y0 + y1) / 2) * k };
    this.dirty = true;
  }
  radius(n) { return n.kind === 'group' ? 16 : SUB_KINDS.has(n.kind) ? 6 : 11 + Math.min(6, Math.sqrt(n.deg)); }
  thumb(n) {
    if (!['canvas', 'model', 'rig'].includes(n.kind) || n.missing) return null;
    const key = `${n.id}@${n.version || ''}`;
    let t = this.thumbs.get(key);
    if (!t) {
      t = new Image();
      t.onload = () => (this.dirty = true);
      t.src = thumbURL(n.kind, n.name, n.version || '0');
      this.thumbs.set(key, t);
      if (this.thumbs.size > 1500) this.thumbs.delete(this.thumbs.keys().next().value);
    }
    return t.complete && t.naturalWidth ? t : null;
  }
  draw() {
    const c = this.canvas, x = c.getContext('2d'), dpr = window.devicePixelRatio || 1;
    const { k, x: vx, y: vy } = this.view;
    x.setTransform(dpr, 0, 0, dpr, 0, 0);
    x.fillStyle = '#121418'; x.fillRect(0, 0, this.W, this.H);
    if (!this.vis) return;
    x.setTransform(dpr * k, 0, 0, dpr * k, dpr * vx, dpr * vy);
    const inView = (n, pad = 40) => { const sx = n.x * k + vx, sy = n.y * k + vy; return sx > -pad && sy > -pad && sx < this.W + pad && sy < this.H + pad; };
    const sel = this.selected, hl = new Set();
    if (sel) for (const e of this.edges) { if (e.a.id === sel) hl.add(e.b.id); if (e.b.id === sel) hl.add(e.a.id); }
    // edges
    const labels = k > 0.9 && this.edges.length < 600;
    x.lineWidth = 1 / k;
    for (const e of this.edges) {
      if (!inView(e.a, 2000) && !inView(e.b, 2000)) continue;
      const on = sel && (e.a.id === sel || e.b.id === sel);
      x.strokeStyle = on ? relColor(e.rel) : relColor(e.rel) + (sel ? '44' : '99');
      x.lineWidth = (on ? 2 : 1) / k;
      x.setLineDash(e.derived ? [] : [5 / k, 3 / k]);
      x.beginPath(); x.moveTo(e.a.x, e.a.y); x.lineTo(e.b.x, e.b.y); x.stroke();
      // arrow head at b
      const dx = e.b.x - e.a.x, dy = e.b.y - e.a.y, d = Math.hypot(dx, dy) || 1, r = this.radius(e.b) + 2;
      const ax = e.b.x - (dx / d) * r, ay = e.b.y - (dy / d) * r, s = 6 / Math.max(0.6, k);
      x.setLineDash([]);
      x.fillStyle = x.strokeStyle;
      x.beginPath(); x.moveTo(ax, ay); x.lineTo(ax - (dx / d) * s - (dy / d) * s * 0.5, ay - (dy / d) * s + (dx / d) * s * 0.5); x.lineTo(ax - (dx / d) * s + (dy / d) * s * 0.5, ay - (dy / d) * s - (dx / d) * s * 0.5); x.fill();
      if ((labels && !e.derived) || on) {
        x.fillStyle = '#c7cdd8'; x.font = `${10 / Math.max(0.8, k)}px ui-monospace, monospace`;
        const attrs = e.attrs ? ' ' + Object.entries(e.attrs).map(([a, b]) => `${a}:${b}`).join(',') : '';
        x.fillText(e.rel + attrs, (e.a.x + e.b.x) / 2 + 3, (e.a.y + e.b.y) / 2 - 3);
      }
    }
    x.setLineDash([]);
    // nodes
    const big = k > 1.1;
    for (const n of this.vis) {
      if (!inView(n)) continue;
      const r = this.radius(n), col = KIND_COLOR[n.kind] || '#94a3b8';
      const dim = sel && n.id !== sel && !hl.has(n.id);
      x.globalAlpha = dim ? 0.35 : 1;
      const t = big && this.thumb(n);
      if (t) {
        const s = r * 2.4;
        x.fillStyle = '#1d2027'; x.fillRect(n.x - s / 2, n.y - s / 2, s, s);
        x.imageSmoothingEnabled = false;
        const q = Math.min(s / t.naturalWidth, s / t.naturalHeight);
        x.drawImage(t, n.x - (t.naturalWidth * q) / 2, n.y - (t.naturalHeight * q) / 2, t.naturalWidth * q, t.naturalHeight * q);
        x.strokeStyle = col; x.lineWidth = 2 / k; x.strokeRect(n.x - s / 2, n.y - s / 2, s, s);
      } else {
        x.fillStyle = n.missing ? '#2a2d34' : col;
        x.beginPath();
        if (n.kind === 'group') { x.arc(n.x, n.y, r, 0, Math.PI * 2); x.fill(); x.strokeStyle = '#e9d5ff'; x.lineWidth = 2 / k; x.stroke(); }
        else { x.arc(n.x, n.y, r, 0, Math.PI * 2); x.fill(); }
        if (n.missing) { x.strokeStyle = col; x.lineWidth = 1.5 / k; x.stroke(); }
        if (k > 0.6) { x.fillStyle = '#0b0c0f'; x.font = `${r}px system-ui`; x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText(KIND_ICON[n.kind] || '•', n.x, n.y + 0.5); x.textAlign = 'left'; x.textBaseline = 'alphabetic'; }
      }
      if (n.id === sel || n.id === this.hover?.id) { x.strokeStyle = '#fff'; x.lineWidth = 2 / k; x.beginPath(); x.arc(n.x, n.y, r + 4, 0, Math.PI * 2); x.stroke(); }
      if (this.collapsed.has(n.id)) { x.fillStyle = '#e9d5ff'; x.font = `bold ${11 / Math.max(0.8, k)}px system-ui`; x.fillText('+', n.x + r + 2, n.y - r); }
      // badges: open review notes, approved
      if (n.reviews) { x.fillStyle = '#f5a524'; x.beginPath(); x.arc(n.x + r, n.y - r, 7 / Math.max(0.7, k), 0, Math.PI * 2); x.fill(); x.fillStyle = '#111'; x.font = `bold ${9 / Math.max(0.7, k)}px system-ui`; x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText(String(n.reviews), n.x + r, n.y - r + 0.5); x.textAlign = 'left'; x.textBaseline = 'alphabetic'; }
      if (n.approved) { x.fillStyle = '#22c55e'; x.font = `bold ${12 / Math.max(0.7, k)}px system-ui`; x.fillText('✓', n.x - r - 10 / Math.max(0.7, k), n.y - r + 4); }
      // cleanup badges: superseded (red slash + dashed ring), orphan (dashed grey ring)
      if (n.superseded || n.orphan) {
        x.save(); x.setLineDash([3 / k, 3 / k]); x.lineWidth = 1.5 / k; x.strokeStyle = n.superseded ? '#f87171' : '#8b93a1';
        x.beginPath(); x.arc(n.x, n.y, r + 7 / Math.max(0.7, k), 0, Math.PI * 2); x.stroke(); x.restore();
        if (n.superseded) { x.strokeStyle = '#f87171'; x.lineWidth = 2 / k; x.beginPath(); x.moveTo(n.x - r * 0.8, n.y + r * 0.8); x.lineTo(n.x + r * 0.8, n.y - r * 0.8); x.stroke(); }
        if (k > 0.6) { x.fillStyle = n.superseded ? '#fca5a5' : '#a5b0c2'; x.font = `${9 / Math.max(0.75, k)}px system-ui`; x.fillText(n.superseded ? 'superseded' : 'orphan', n.x - r, n.y + r + 12 / Math.max(0.75, k)); }
      }
      if (k > 0.45 || n.id === sel || hl.has(n.id) || n.kind === 'group') {
        x.fillStyle = n.missing ? '#6b7280' : '#e6e9ef'; x.font = `${(n.kind === 'group' ? 12 : 11) / Math.max(0.75, k)}px system-ui`;
        x.fillText(n.kind === 'group' || n.kind === 'project' ? n.id : n.name, n.x + r + 4, n.y + 4);
        if (n.tags?.length && k > 1) { x.fillStyle = '#9aa3b2'; x.font = `${9 / k}px system-ui`; x.fillText(n.tags.map((t) => '#' + t).join(' '), n.x + r + 4, n.y + 16 / Math.max(0.75, k)); }
      }
      x.globalAlpha = 1;
    }
  }
  toWorld(e) { const r = this.canvas.getBoundingClientRect(); return [(e.clientX - r.left - this.view.x) / this.view.k, (e.clientY - r.top - this.view.y) / this.view.k]; }
  hit(e) {
    const [wx, wy] = this.toWorld(e);
    let best = null, bd = Infinity;
    for (const n of this.vis || []) { const d = Math.hypot(n.x - wx, n.y - wy); if (d < this.radius(n) * 1.4 + 4 / this.view.k && d < bd) { bd = d; best = n; } }
    return best;
  }
  bind() {
    const c = this.canvas;
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      const r = c.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top;
      const f = Math.exp(-e.deltaY * 0.0015), k = Math.max(0.05, Math.min(6, this.view.k * f));
      this.view.x = mx - (mx - this.view.x) * (k / this.view.k); this.view.y = my - (my - this.view.y) * (k / this.view.k); this.view.k = k;
      this.dirty = true;
    }, { passive: false });
    c.addEventListener('pointerdown', (e) => {
      const n = this.hit(e);
      c.setPointerCapture(e.pointerId);
      this.drag = n ? { n, moved: false, x: e.clientX, y: e.clientY } : { pan: true, x: e.clientX, y: e.clientY, vx: this.view.x, vy: this.view.y, moved: false };
    });
    c.addEventListener('pointermove', (e) => {
      const d = this.drag;
      if (!d) {
        const n = this.hit(e);
        if (n?.id !== this.hover?.id) { this.hover = n; this.dirty = true; }
        this.tip.hidden = !n;
        if (n) { this.tip.textContent = `${n.id}${n.note ? ` — ${n.note}` : ''}${n.reviews ? ` · ${n.reviews} open review` : ''}${n.approved ? ' · approved' : ''}${n.superseded ? ' · superseded' : ''}${n.orphan ? ' · orphan' : ''}`; const r = this.stage.getBoundingClientRect(); this.tip.style.left = e.clientX - r.left + 14 + 'px'; this.tip.style.top = e.clientY - r.top + 10 + 'px'; }
        return;
      }
      if (Math.abs(e.clientX - d.x) + Math.abs(e.clientY - d.y) > 3) d.moved = true;
      if (d.pan) { this.view.x = d.vx + e.clientX - d.x; this.view.y = d.vy + e.clientY - d.y; }
      else if (d.moved) { const [wx, wy] = this.toWorld(e); d.n.x = wx; d.n.y = wy; d.n.fixed = true; this.alpha = Math.max(this.alpha, 0.3); }
      this.dirty = true;
    });
    c.addEventListener('pointerup', () => {
      const d = this.drag;
      this.drag = null;
      if (!d || d.moved) return;
      if (d.pan) { this.select(null); return; }
      if (d.n.kind === 'group') {
        const now = Date.now();
        if (this.lastGroupClick?.id === d.n.id && now - this.lastGroupClick.t < 350) return;
        this.lastGroupClick = { id: d.n.id, t: now };
      }
      this.select(d.n.id);
    });
    c.addEventListener('dblclick', (e) => {
      const n = this.hit(e);
      if (!n) return;
      if (n.kind === 'group') { if (this.collapsed.has(n.id)) this.collapsed.delete(n.id); else this.collapsed.add(n.id); store.set('graphCollapsed', [...this.collapsed]); this.applyFilter(); return; }
      this.app.openNode(n.id);
    });
  }
  select(id, center) {
    this.selected = id;
    this.dirty = true;
    if (id) this.app.inspectNode?.(id);
    const n = id && this.nodes.get(id);
    if (center && n) { this.view.x = this.W / 2 - n.x * this.view.k; this.view.y = this.H / 2 - n.y * this.view.k; }
  }
  focusSearch() {
    const q = this.search.value.trim().toLowerCase();
    if (!q) return;
    const n = this.vis?.find((m) => m.id.toLowerCase().includes(q) || (m.note || '').toLowerCase().includes(q));
    if (n) { if (this.view.k < 1) this.view.k = 1.2; this.select(n.id, true); }
  }
  onEvent(ev) {
    if (['graph', 'change', 'deleted', 'model', 'audio', 'project'].includes(ev.type) && (ev.type !== 'change' || ev.structural)) {
      clearTimeout(this.rt);
      this.rt = setTimeout(() => this.reload(false), 400);
    }
  }
  keydown(e, k) { if (k === '0') { this.fit(); return true; } return false; }
  destroy() { cancelAnimationFrame(this.raf); clearTimeout(this.rt); this.ro.disconnect(); this.root.remove(); }
}
