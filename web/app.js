// Agent Art web UI: watch everything the agent does (activity timeline, asset browser, viewers for
// canvases, animations, rigs, 3D models, audio, exports and the asset graph), compare states side by
// side, leave review notes, and paint along. All changes go through the same API as the agent.
import './src/styles/tokens.css';
import './src/styles/base.css';
import './src/styles/viewers.css';
import './src/styles/legacy-shell.css';
import { $, el, api, getJSON, postJSON, store, debounce, toast, onToast, splitId, enc, KIND_ICON } from './ui/util.js';
import { Browser } from './ui/browser.js';
import { Timeline } from './ui/timeline.js';
import { Inspector, reviewDialog } from './ui/inspector.js';
import { adapt } from './src/viewers/legacyAdapter.ts';
import { CanvasViewer as CanvasViewerTS, TOOL_KEYS } from './src/viewers/canvas/CanvasViewer.ts';
import { AnimViewer as AnimViewerTS } from './src/viewers/anim/AnimViewer.ts';
import { SheetViewer as SheetViewerTS } from './src/viewers/sheet/SheetViewer.ts';
import { RigViewer as RigViewerTS } from './src/viewers/rig/RigViewer.ts';
import { ModelViewer as ModelViewerTS } from './src/viewers/model/ModelViewer.ts';
import { AudioViewer as AudioViewerTS } from './src/viewers/audio/AudioViewer.ts';
import { ProjectViewer as ProjectViewerTS } from './src/viewers/project/ProjectViewer.ts';
import { ExportViewer as ExportViewerTS } from './src/viewers/export/ExportViewer.ts';
import { GraphViewer as GraphViewerTS } from './src/viewers/graph/GraphViewer.ts';
import { LayersViewer as LayersViewerTS } from './src/viewers/layers/LayersViewer.ts';
import { cleanupPanel } from './ui/cleanup.js';

const CanvasViewer = adapt(CanvasViewerTS);
const AnimViewer = adapt(AnimViewerTS);
const SheetViewer = adapt(SheetViewerTS);
const RigViewer = adapt(RigViewerTS);
const LayersViewer = adapt(LayersViewerTS);
const ModelViewer = adapt(ModelViewerTS);
const AudioViewer = adapt(AudioViewerTS);
const ProjectViewer = adapt(ProjectViewerTS);
const ExportViewer = adapt(ExportViewerTS);
const GraphViewer = adapt(GraphViewerTS);

const ACTIVE_REVIEW = new Set(['open', 'in_progress', 'reopened']);

class App {
  constructor() {
    this.api = api;
    this.assets = null;
    this.uiState = { hidden: [], pinned: [] };
    this.hiddenSet = new Set();
    this.solo = new Set();
    this.reviews = [];
    this.reviewCounts = {};
    this.approvedSet = new Set();
    this.tool = 'pencil';
    this.color = { hex: '#4a7c3a', hex8: '#4a7c3aff' };
    this.reviewMode = false;
    this.followMode = store.get('follow', null) ?? (() => { try { return localStorage.getItem('agent-art-follow'); } catch { return null; } })() ?? 'canvas';
    if (this.followMode === 'asset') this.followMode = 'canvas';
    this.slots = { A: { host: $('slotA'), viewer: null, target: null, tabs: $('tabsA'), title: $('titleA') }, B: { host: $('slotB'), viewer: null, target: null, tabs: $('tabsB'), title: $('titleB') } };
    this.lastAgent = 0;
    this.browser = new Browser($('browser'), this);
    this.timeline = new Timeline($('timelinePane'), this);
    this.inspector = new Inspector($('inspector'), this);
    this.refreshAssetsSoon = debounce(() => this.refreshAssets(), 350);
    this.refreshReviewsSoon = debounce(() => this.refreshReviews(), 200);
    this.setupLayout();
    this.setupTopbar();
    this.setupKeys();
    onToast((text, kind) => this.toast(text, kind));
  }
  get current() { return this.slots.A.target; }
  get currentId() { return this.current ? this.idOf(this.current) : null; }
  get following() { return this.followMode !== 'off'; }

  // ---------- ids, visibility, pins ----------
  idOf(t) {
    if (t.kind === 'snapshot') return `${t.assetKind}:${t.name}`;
    if (t.kind === 'graph') return 'graph';
    return `${t.kind}:${t.name}`;
  }
  isHidden(id) { return this.hiddenSet.has(id); }
  isPinned(id) { return this.uiState.pinned.includes(id); }
  async saveUiState() {
    this.uiState.hidden = [...this.hiddenSet];
    const r = await postJSON('/api/ui-state', this.uiState).catch(() => null);
    if (!r?.ok) toast('Could not save the hidden / pinned state', 'error');
  }
  toggleHidden(id) {
    if (this.hiddenSet.has(id)) this.hiddenSet.delete(id); else this.hiddenSet.add(id);
    this.saveUiState();
    this.browser.render();
    this.timeline.render();
    if (this.current) this.inspector.show(this.current);
  }
  togglePinned(id) {
    const i = this.uiState.pinned.indexOf(id);
    if (i >= 0) this.uiState.pinned.splice(i, 1); else this.uiState.pinned.unshift(id);
    this.saveUiState();
    this.browser.render();
    if (this.current) this.inspector.show(this.current);
  }
  onSoloChange() { this.browser.render(); }

  // ---------- data ----------
  async refreshAssets() {
    try { this.assets = await getJSON('/api/assets'); } catch { return; }
    this.flags = { superseded: new Set(this.assets.flags?.superseded || []), orphans: new Set(this.assets.flags?.orphans || []) };
    this.browser.render();
    $('wsPath').textContent = this.assets.home;
    $('wsPath').title = `workspace: ${this.assets.home}`;
  }
  async refreshReviews() {
    const r = await getJSON('/api/reviews').catch(() => null);
    if (!r) return;
    this.reviews = r.reviews || [];
    this.reviewCounts = r.counts || {};
    this.approvedSet = new Set(r.approved || []);
    const open = this.reviews.filter((x) => ACTIVE_REVIEW.has(x.status)).length;
    $('reviewCount').textContent = open ? String(open) : '';
    $('reviewCount').hidden = !open;
    this.browser.render();
    for (const s of Object.values(this.slots)) if (s.viewer?.view?.render) s.viewer.view.render();
    if (this.current) this.inspector.show(this.current);
  }

  // ---------- tools / colour ----------
  setTool(t) {
    this.tool = t;
    for (const s of Object.values(this.slots)) s.viewer?.setToolUI?.(t);
  }
  setColor(hex) {
    const h = hex.length === 9 ? hex : hex.slice(0, 7) + 'ff';
    this.color = { hex: h.slice(0, 7), hex8: h };
    for (const s of Object.values(this.slots)) s.viewer?.setColorUI?.(h);
    if (this.tool === 'eraser' || this.tool === 'picker' || this.tool === 'hand') this.setTool('pencil');
  }

  // ---------- viewers ----------
  viewerClass(t) {
    if (t.kind === 'canvas') return { edit: CanvasViewer, anim: AnimViewer, sheet: SheetViewer, layers: LayersViewer, rig: RigViewer }[t.snap ? 'edit' : t.view || 'edit'] || CanvasViewer;
    if (t.kind === 'rig') return t.view === 'layers' ? LayersViewer : RigViewer;
    if (t.kind === 'model') return ModelViewer;
    if (t.kind === 'audio') return AudioViewer;
    if (t.kind === 'project') return ProjectViewer;
    if (t.kind === 'graph') return GraphViewer;
    if (t.kind === 'export') {
      if (/\.glb$/i.test(t.name)) return ModelViewer;
      if (/\.(wav|mp3|ogg|opus)$/i.test(t.name)) return AudioViewer;
      return ExportViewer;
    }
    return null;
  }
  /** Default target for an asset of a kind (browser, graph nodes, timeline). */
  targetFor(kind, name) {
    if (kind === 'layer' || kind === 'anim' || kind === 'frame') {
      const [c, sub] = [name.slice(0, name.indexOf('/')), name.slice(name.indexOf('/') + 1)];
      return kind === 'anim' ? { kind: 'canvas', name: c, view: 'anim', tag: sub } : { kind: 'canvas', name: c };
    }
    if (kind === 'rigpart') return { kind: 'rig', name: name.split('/')[0], mode: 'parts' };
    if (kind === 'modelpart') return { kind: 'model', name: name.split('/')[0] };
    if (kind === 'group') return { kind: 'graph', focus: `group:${name}` };
    if (kind === 'palette') return this.assets?.projects.some((p) => p.name === name) ? { kind: 'project', name } : { kind: 'canvas', name };
    return { kind, name };
  }
  openNode(id) { const [k, n] = splitId(id); const t = this.targetFor(k, n); if (this.viewerClass(t)) this.open(t); }

  async open(target, { slot = 'A', history = true } = {}) {
    if (!target) return;
    if (slot === 'B') this.setCompare(true);
    const s = this.slots[slot];
    const Cls = this.viewerClass(target);
    if (!Cls) return;
    if (!(s.viewer instanceof Cls)) {
      s.viewer?.destroy();
      s.host.innerHTML = '';
      s.viewer = new Cls(s.host, { app: this, readOnly: slot === 'B', slot });
    }
    s.target = target;
    this.renderTabs(slot);
    if (slot === 'A') {
      if (history) this.setHash(target);
      this.browser.markActive(this.currentId);
      this.inspector.show(target.kind === 'graph' ? { kind: 'graph' } : target);
      if (this.timeline.f.current) this.timeline.render();
    }
    try { await s.viewer.open(target); } catch (e) { toast(`${target.name || target.kind}: ${e.message}`, 'error'); }
  }
  renderTabs(slot) {
    const s = this.slots[slot], t = s.target;
    const id = this.idOf(t);
    const [kind, name] = splitId(id);
    s.title.replaceChildren(...[el('span.kicon', { text: KIND_ICON[t.kind === 'snapshot' ? t.assetKind : kind] || '•' }), el('span', { text: t.kind === 'graph' ? 'Asset graph' : name }), t.snap ? el('span.badge.state', { text: `state ${t.label || t.snap}` }) : null,
      t.snap && slot === 'A' ? el('button.btn.small', { text: 'Back to live', on: { click: () => this.open({ kind: t.kind, name: t.name }) } }) : null].filter(Boolean));
    const tabs = [];
    if (t.kind === 'canvas' && !t.snap) {
      const c = this.assets?.canvases.find((x) => x.name === t.name);
      tabs.push(['edit', 'Canvas']);
      if (!c || c.frames > 1 || c.animations.length) tabs.push(['anim', 'Animation']);
      tabs.push(['sheet', 'Sheet']);
      tabs.push(['layers', 'Layers']);
      if (c?.rig || c?.kind === 'rigparts') tabs.push(['rig', 'Rig']);
    } else if (t.kind === 'rig') { tabs.push(['rig', 'Rig'], ['layers', 'Layers']); }
    s.tabs.replaceChildren(...tabs.map(([v, label], i) => el('button.tab' + ((t.view || (t.kind === 'rig' ? 'rig' : 'edit')) === v ? '.on' : ''), { text: label, title: `${label} (${i + 1})`, on: { click: () => this.switchView(slot, v) } })));
  }
  switchView(slot, v) {
    const t = this.slots[slot].target;
    if (!t) return;
    if (t.kind === 'canvas' && v === 'rig') {
      const c = this.assets?.canvases.find((x) => x.name === t.name);
      const rig = c?.rig || (c?.kind === 'rigparts' ? t.name.replace(/_parts$/, '') : null);
      if (rig) this.open({ kind: 'rig', name: rig, clip: c?.rig && c.animations[0] ? `${t.name}/${c.animations[0]}` : undefined }, { slot });
      return;
    }
    if (t.kind === 'rig') { this.open({ kind: 'rig', name: t.name, view: v === 'layers' ? 'layers' : undefined }, { slot }); return; }
    this.open({ ...t, view: v }, { slot });
  }
  setHash(t) {
    let h = '';
    if (t.snap) return;
    if (t.kind === 'canvas') h = enc(t.name);
    else if (t.kind === 'graph') h = 'graph';
    else h = `${t.kind}:${enc(t.name)}`;
    if (location.hash.slice(1) !== h) history.replaceState(null, '', '#' + h);
  }
  fromHash() {
    const h = decodeURIComponent(location.hash.slice(1));
    if (!h) return null;
    if (h === 'graph') return { kind: 'graph' };
    const m = h.match(/^(project|model|rig|audio|export|canvas):(.+)$/);
    if (m) return { kind: m[1], name: m[2] };
    return { kind: 'canvas', name: h };
  }
  setCompare(on) {
    this.comparing = on;
    $('viewers').classList.toggle('compare', on);
    $('slotWrapB').hidden = !on;
    $('compareBtn').classList.toggle('on', on);
    if (!on && this.slots.B.viewer) { this.slots.B.viewer.destroy(); this.slots.B.viewer = null; this.slots.B.target = null; this.slots.B.host.innerHTML = ''; }
    if (on && !this.slots.B.target) this.slots.B.host.replaceChildren(el('div.empty-note', { text: 'Alt+click (or Shift+click) an asset in the browser, or ⇆ on a timeline entry, to compare it here.' }));
    window.dispatchEvent(new Event('resize'));
  }
  compare(a, b) {
    this.setCompare(true);
    this.open(a, { slot: 'A' });
    this.open(b, { slot: 'B' });
  }

  // ---------- review ----------
  reviewMarks(t) {
    const id = `${t.kind}:${t.name}`;
    return this.reviews.filter((r) => r.asset === id && ['open', 'in_progress', 'reopened', 'fixed'].includes(r.status)).map((r) => ({ id: r.id, status: r.status, region: r.target?.region, frame: r.target?.frame, time: r.target?.time }));
  }
  async reviewPrompt(t) {
    const r = await reviewDialog(this, t);
    if (r) { toast(`Review note ${r.id} added — the agent sees it in art_review list and in replies about this asset`, 'ok'); this.setReviewMode(false); }
  }
  setReviewMode(on) {
    this.reviewMode = on;
    $('reviewBtn').classList.toggle('on', on);
    document.body.classList.toggle('review-mode', on);
    for (const s of Object.values(this.slots)) s.viewer?.setToolUI?.(this.tool);
  }
  /** Asset ids for "compare with" suggestions. */
  assetChoices() {
    const a = this.assets;
    if (!a) return [];
    return [...a.canvases.map((c) => `canvas:${c.name}`), ...a.models.map((m) => `model:${m.name}`), ...a.rigs.map((r) => `rig:${r.name}`), ...a.audio.map((s) => `audio:${s.name}`)];
  }
  reviewTarget(asset, t = {}) {
    const [k, n] = splitId(asset);
    if (k === 'canvas') return { kind: 'canvas', name: n, frame: t.frame, tag: t.tag, view: t.tag && t.view ? 'anim' : undefined };
    return this.targetFor(k, n);
  }
  openReview(r) { this.open(this.reviewTarget(r.asset, r.target)); }
  openReviewCompare(r) {
    const a = this.reviewTarget(r.asset, r.target);
    const ct = { ...r.target, ...r.compare_with };
    const b = this.reviewTarget(r.compare_with.asset, ct);
    if (a.view === 'anim') delete a.view;
    if (b.view === 'anim') delete b.view;
    this.compare(a, b);
  }
  inspectNode(id) {
    const [k, n] = splitId(id);
    this.inspector.show({ kind: k, name: n });
  }

  // ---------- live events ----------
  connect() {
    const es = new EventSource('/api/events');
    es.onopen = () => this.setStatus();
    es.onerror = () => { $('status').className = 'status down'; $('statusText').textContent = 'disconnected — retrying'; };
    es.onmessage = (m) => this.onEvent(JSON.parse(m.data));
  }
  onEvent(ev) {
    if (ev.type === 'hello') { this.setStatus(); return; }
    if (ev.type === 'activity') {
      this.timeline.upsert(ev.entry);
      if (ev.entry.source !== 'user') { this.lastAgent = Date.now(); this.setStatus(); }
      if (ev.entry.type === 'op' && ev.entry.source === 'agent' && ev.entry.ok !== false) this.follow(ev.entry);
      return;
    }
    if (ev.type === 'ui-state') { this.loadUiState(); return; }
    if (ev.type === 'graph') {
      if (ev.review || ev.action === 'approve') this.refreshReviewsSoon();
      this.refreshAssetsSoon();
    }
    if (['change', 'deleted', 'model', 'audio', 'project'].includes(ev.type)) this.refreshAssetsSoon();
    if (ev.type === 'change' && ev.source === 'agent') this.browser.flash(`canvas:${ev.canvas}`);
    for (const s of Object.values(this.slots)) s.viewer?.onEvent?.(ev);
    if (ev.type === 'change' && this.current?.kind === 'canvas' && this.current.name === ev.canvas && !this.current.snap && this.current.view && this.current.view !== 'edit') this.inspector.refreshFor({ name: ev.canvas });
  }
  /** Follow mode: open whatever the agent is touching (skips hidden / non-solo assets). */
  follow(entry) {
    if (!this.following || document.querySelector('.modal:not(#help)')) return;
    const ok = (a) => !this.isHidden(`${a.kind}:${a.name}`) && (!this.solo.size || this.solo.has(`${a.kind}:${a.name}`)) && !a.deleted;
    const list = (entry.assets || []).filter((a) => ['canvas', 'model', 'audio', 'rig'].includes(a.kind) && ok(a));
    const a = list.find((x) => x.kind === 'canvas' && x.after) || list.find((x) => x.after) || list[0];
    if (!a) return;
    if (this.followMode === 'project') {
      const c = a.kind === 'canvas' && this.assets?.canvases.find((x) => x.name === a.name);
      const proj = c?.project;
      if (proj && !(this.current?.kind === 'project' && this.current.name === proj)) this.open({ kind: 'project', name: proj });
      return;
    }
    const cur = this.current;
    const t = a.kind === 'rig' ? { kind: 'canvas', name: `${a.name}_parts` } : { kind: a.kind, name: a.name };
    if (cur && !cur.snap && cur.kind === t.kind && cur.name === t.name) return;
    // stay in the same viewer mode when following within canvases (animation stays animation)
    if (cur?.kind === 'canvas' && t.kind === 'canvas' && cur.view && cur.view !== 'layers') t.view = cur.view;
    this.open(t);
  }
  setStatus() {
    const busy = Date.now() - this.lastAgent < 2500;
    $('status').className = 'status ' + (busy ? 'busy' : 'ok');
    $('statusText').textContent = busy ? 'agent is working…' : 'live';
  }
  async loadUiState() {
    const s = await getJSON('/api/ui-state').catch(() => null);
    if (!s) return;
    this.uiState = { hidden: s.hidden || [], pinned: s.pinned || [] };
    this.hiddenSet = new Set(this.uiState.hidden);
    this.browser.render();
  }

  // ---------- chrome ----------
  toast(text, kind = 'info') {
    const t = el(`div.toast.${kind}`, { text });
    $('toasts').append(t);
    setTimeout(() => t.classList.add('out'), kind === 'error' ? 6000 : 3500);
    setTimeout(() => t.remove(), kind === 'error' ? 6600 : 4100);
  }
  setupTopbar() {
    const fs = $('followMode');
    fs.value = this.followMode;
    const sync = () => { $('followBtn').classList.toggle('on', this.following); $('followBtn').textContent = this.following ? '◉ Follow' : '○ Follow'; fs.value = this.followMode; };
    fs.onchange = () => { this.followMode = fs.value; store.set('follow', this.followMode); try { localStorage.setItem('agent-art-follow', fs.value); } catch { /* ignore */ } sync(); };
    $('followBtn').onclick = () => { this.followMode = this.following ? 'off' : store.get('followOn', 'canvas'); if (this.following) store.set('followOn', this.followMode); store.set('follow', this.followMode); sync(); };
    sync();
    $('compareBtn').onclick = () => this.setCompare(!this.comparing);
    $('closeB').onclick = () => this.setCompare(false);
    $('swapB').onclick = () => { const a = this.slots.A.target, b = this.slots.B.target; if (a && b) this.compare(b, a); };
    $('reviewBtn').onclick = () => this.setReviewMode(!this.reviewMode);
    $('reviewListBtn').onclick = () => this.showReviewList();
    $('graphBtn').onclick = () => this.open({ kind: 'graph' });
    $('cleanupBtn').onclick = () => cleanupPanel(this);
    $('helpBtn').onclick = () => this.toggleHelp();
    $('help').onclick = (e) => { if (e.target.id === 'help') this.toggleHelp(); };
    $('toggleBrowser').onclick = () => this.togglePane('browser');
    $('toggleSide').onclick = () => this.togglePane('side');
  }
  showReviewList() {
    const list = this.reviews.slice().sort((a, b) => Number(ACTIVE_REVIEW.has(b.status)) - Number(ACTIVE_REVIEW.has(a.status)) || b.updated - a.updated);
    const dlg = el('div.modal', { on: { click: (e) => { if (e.target === dlg) dlg.remove(); } } },
      el('div.modal-card.wide', {}, el('div.pane-head', {}, el('h3', { text: `Review notes · ${list.filter((r) => ACTIVE_REVIEW.has(r.status)).length} open` }), el('div.spacer'), el('button.btn.small', { text: '✕', on: { click: () => dlg.remove() } })),
        el('div.review-list', {}, ...(list.length ? list.map((r) => { const c = this.inspector.reviewCard(r); c.addEventListener('click', (e) => { if (e.target.closest('button,a')) dlg.remove(); }); return el('div', {}, el('div.mono.small.muted', { text: r.asset }), c); }) : [el('div.muted', { text: 'No review notes yet. Press M, then drag a box (or click a pin) on what needs fixing.' })]))));
    document.body.append(dlg);
  }
  toggleHelp() {
    const h = $('help');
    h.hidden = !h.hidden;
  }
  togglePane(which) {
    const app = $('app');
    app.classList.toggle(`no-${which}`);
    store.set('panes', { browser: !app.classList.contains('no-browser'), side: !app.classList.contains('no-side') });
    window.dispatchEvent(new Event('resize'));
  }
  toggleTimelineDock() {
    this.dock = this.dock === 'bottom' ? 'right' : 'bottom';
    store.set('dock', this.dock);
    this.applyDock();
  }
  applyDock() {
    const app = $('app'), tl = $('timelinePane');
    app.classList.toggle('tl-bottom', this.dock === 'bottom');
    (this.dock === 'bottom' ? $('bottomDock') : $('sideDock')).append(tl);
    window.dispatchEvent(new Event('resize'));
  }
  setupLayout() {
    const sizes = store.get('sizes', {});
    const app = $('app');
    for (const [k, v] of Object.entries(sizes)) app.style.setProperty(`--${k}`, v + 'px');
    const panes = store.get('panes', { browser: true, side: true });
    if (!panes.browser) app.classList.add('no-browser');
    if (!panes.side) app.classList.add('no-side');
    this.dock = store.get('dock', 'right');
    this.applyDock();
    for (const sp of document.querySelectorAll('.splitter')) {
      sp.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        sp.setPointerCapture(e.pointerId);
        const key = sp.dataset.size, dir = sp.dataset.dir, sign = Number(sp.dataset.sign || 1);
        const start = dir === 'x' ? e.clientX : e.clientY;
        const cur = parseFloat(getComputedStyle(app).getPropertyValue(`--${key}`)) || 300;
        const move = (ev) => {
          const v = Math.max(140, Math.min(window.innerWidth * 0.7, cur + sign * ((dir === 'x' ? ev.clientX : ev.clientY) - start)));
          app.style.setProperty(`--${key}`, v + 'px');
          sizes[key] = Math.round(v);
        };
        const up = () => { sp.removeEventListener('pointermove', move); sp.removeEventListener('pointerup', up); store.set('sizes', sizes); window.dispatchEvent(new Event('resize')); };
        sp.addEventListener('pointermove', move);
        sp.addEventListener('pointerup', up);
      });
    }
  }
  setupKeys() {
    window.addEventListener('keydown', (e) => {
      const tag = e.target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target.isContentEditable) { if (e.key === 'Escape') e.target.blur(); return; }
      if (document.querySelector('.modal:not(#help)')) { if (e.key === 'Escape') document.querySelector('.modal:not(#help)').remove(); return; }
      const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      const v = this.slots.A.viewer;
      if ((e.ctrlKey || e.metaKey) && k === 'z') { e.preventDefault(); v?.undo?.(e.shiftKey); return; }
      if ((e.ctrlKey || e.metaKey) && k === 'y') { e.preventDefault(); v?.undo?.(true); return; }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === 'Escape') { if (this.reviewMode) this.setReviewMode(false); else if (!$('help').hidden) this.toggleHelp(); else if (this.comparing) this.setCompare(false); else if (this.current?.snap) this.open({ kind: this.current.kind, name: this.current.name }); return; }
      if (e.key === ' ' && document.activeElement?.classList.contains('pixel-canvas')) return; // space-drag pans
      if (v?.keydown?.(e, e.key === ' ' ? ' ' : k)) { e.preventDefault(); return; }
      if (e.shiftKey && k === 'g') { this.open({ kind: 'graph' }); return; }
      if (TOOL_KEYS[k] && v instanceof CanvasViewer) { this.setTool(TOOL_KEYS[k]); return; }
      if (k === 'f') $('followBtn').click();
      else if (k === 'c') this.setCompare(!this.comparing);
      else if (k === 'm') this.setReviewMode(!this.reviewMode);
      else if (k === '/') { e.preventDefault(); if (!document.getElementById('app').classList.contains('no-browser')) this.browser.focusSearch(); }
      else if (k === '?') this.toggleHelp();
      else if (k === 'p') this.toggleTimelineDock();
      else if (k === '[') this.togglePane('browser');
      else if (k === ']') this.togglePane('side');
      else if (k === 'o') { const c = this.assets?.canvases.find((x) => x.name === this.current?.name); if (c?.project) this.open({ kind: 'project', name: c.project }); }
      else if (/^[1-5]$/.test(k)) { const b = this.slots.A.tabs.children[Number(k) - 1]; b?.click(); }
    });
    window.addEventListener('hashchange', () => { const t = this.fromHash(); if (t && this.idOf(t) !== this.currentId) this.open(t, { history: false }); });
  }

  async boot() {
    setInterval(() => this.setStatus(), 1000);
    await Promise.all([this.loadUiState(), this.refreshAssets(), this.refreshReviews()]);
    try {
      const { entries } = await getJSON('/api/activity?limit=600');
      this.timeline.load(entries);
    } catch { /* older server */ }
    this.connect();
    const t = this.fromHash();
    const a = this.assets;
    if (t && (t.kind !== 'canvas' || a?.canvases.some((c) => c.name === t.name))) this.open(t, { history: false });
    else if (a?.canvases.length) this.open({ kind: 'canvas', name: [...a.canvases].sort((x, y) => y.updated - x.updated)[0].name });
    else this.slots.A.host.replaceChildren(el('div.empty-note.big', {}, el('h2', { text: 'Nothing here yet' }), el('p', { text: 'Ask the agent to draw something (it shows up live), or press "+ New" to create a canvas.' })));
  }
}

window.agentArt = new App();
window.agentArt.boot();
