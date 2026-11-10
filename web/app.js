// Agent Art web UI: watch everything the agent does (activity timeline, asset browser, viewers for
// canvases, animations, rigs, 3D models, audio, exports and the asset graph), compare states side by
// side, leave review notes, and paint along. All changes go through the same API as the agent.
import './src/styles/tokens.css';
import './src/styles/base.css';
import './src/styles/viewers.css';
import './src/styles/legacy-shell.css';
import { $, el, api, getJSON, store, toast, onToast, splitId, KIND_ICON } from './ui/util.js';
import { api as rest } from './src/lib/api/client.ts';
import AssetBrowser from './src/components/browser/AssetBrowser.svelte';
import { hasDragTarget, readDragTarget } from './src/components/browser/drag.ts';
import Timeline from './src/components/timeline/Timeline.svelte';
import Inspector from './src/components/inspector/Inspector.svelte';
import { reviewPrompt } from './src/components/inspector/actions.ts';
import { adapt } from './src/viewers/legacyAdapter.ts';
import { CanvasViewer as CanvasViewerTS, TOOL_KEYS } from './src/viewers/canvas/CanvasViewer.ts';
import { assets } from './src/state/assets.svelte.ts';
import { uiState } from './src/state/uiState.svelte.ts';
import { reviews, ACTIVE_REVIEW } from './src/state/reviews.svelte.ts';
import { activity } from './src/state/activity.svelte.ts';
import { editor } from './src/state/editor.svelte.ts';
import { workspace } from './src/state/workspace.svelte.ts';
import { connection } from './src/state/connection.svelte.ts';
import * as live from './src/state/live.svelte.ts';
import { watch } from './src/state/legacyWatch.svelte.ts';
import { toasts } from './src/state/toasts.svelte.ts';
import { dialogs } from './src/state/dialogs.svelte.ts';
import { mount } from 'svelte';
import Toasts from './src/components/ui/Toasts.svelte';

const CanvasViewer = adapt(CanvasViewerTS);
// Every viewer except the canvas editor is its own lazy chunk (plan 7.1). One adapted class per kind,
// so the instanceof reuse check in open() keeps working.
const LOADERS = {
  anim: () => import('./src/viewers/anim/AnimViewer.ts').then((m) => m.AnimViewer),
  sheet: () => import('./src/viewers/sheet/SheetViewer.ts').then((m) => m.SheetViewer),
  rig: () => import('./src/viewers/rig/RigViewer.ts').then((m) => m.RigViewer),
  model: () => import('./src/viewers/model/ModelViewer.ts').then((m) => m.ModelViewer),
  audio: () => import('./src/viewers/audio/AudioViewer.ts').then((m) => m.AudioViewer),
  project: () => import('./src/viewers/project/ProjectViewer.ts').then((m) => m.ProjectViewer),
  export: () => import('./src/viewers/export/ExportViewer.ts').then((m) => m.ExportViewer),
  graph: () => import('./src/viewers/graph/GraphViewer.ts').then((m) => m.GraphViewer),
  layers: () => import('./src/viewers/layers/LayersViewer.ts').then((m) => m.LayersViewer),
};
const adapted = { canvas: Promise.resolve(CanvasViewer) };
function loadViewerClass(kind) {
  if (!adapted[kind]) {
    adapted[kind] = LOADERS[kind]().then((C) => adapt(C));
    adapted[kind].catch(() => { delete adapted[kind]; });
  }
  return adapted[kind];
}

/** A dialog other than Help is open (K2, E10): the Svelte dialogs first, legacy .modal DOM until step 17. */
const dialogOpen = () => dialogs.blocking || !!document.querySelector('.modal:not(#help)');

class App {
  constructor() {
    this.api = api;
    /** e2e / devtools: window.agentArt.debug.viewer('A') -> the slot viewer's debugInfo(). */
    this.debug = { viewer: (slot) => this.slots[slot]?.viewer?.inner?.debugInfo?.() ?? null };
    workspace.navigator = (t, o) => { void this.open(t, o); };
    workspace.dialogOpen = dialogOpen;
    mount(Toasts, { target: document.body });
    // DialogHost (Bits UI dialogs) is a lazy chunk, mounted when the first dialog opens.
    let dialogHost = null;
    watch(() => dialogs.stack.length, (n) => {
      if (n && !dialogHost) dialogHost = import('./src/components/dialogs/DialogHost.svelte').then((m) => mount(m.default, { target: document.body }));
    });
    this.slots = { A: { host: $('slotA'), viewer: null, target: null, tabs: $('tabsA'), title: $('titleA') }, B: { host: $('slotB'), viewer: null, target: null, tabs: $('tabsB'), title: $('titleB') } };
    const browser = mount(AssetBrowser, { target: $('browser'), props: { reviewNote: (d) => { void this.reviewPrompt(d); } } });
    // legacy surface: the Svelte browser renders from the stores, follows workspace.currentId and signals.flash
    this.browser = { render() {}, markActive() {}, flash() {}, focusSearch: () => browser.focusSearch() };
    mount(Timeline, { target: $('timelinePane'), props: { ontoggleDock: () => this.toggleTimelineDock() } });
    // legacy surface: the Svelte timeline renders from the activity store on its own
    this.timeline = { upsert: (e) => activity.upsert(e), load: (list) => activity.load(list), render() {}, get f() { return activity.filter; } };
    mount(Inspector, { target: $('inspector'), props: {
      onsetcolor: (hex) => this.setColor(hex), // also pushes the colour to the viewers
      ontogglepinned: (id) => this.togglePinned(id),
      ontogglehidden: (id) => this.toggleHidden(id),
      onnote: (d) => { void this.reviewPrompt(d); },
      onopen: (t) => { void this.open(t); },
    } });
    // legacy surface: the Svelte inspector follows workspace.inspected and live.signals.inspectorTick
    this.inspector = {
      show: (t) => { workspace.inspected = !t ? null : t.kind === 'graph' ? { kind: 'graph' } : t; },
      refreshFor: () => { live.signals.inspectorTick++; },
    };
    this.setupLayout();
    this.setupDrop();
    this.setupTopbar();
    this.setupKeys();
    onToast((text, kind) => toasts.push(text, kind));
  }
  // ---------- state lives in the stores (web/src/state); these getters keep the legacy surface ----------
  get assets() { return assets.index; }
  get flags() { return { superseded: { has: (id) => assets.isSuperseded(id) }, orphans: { has: (id) => assets.isOrphan(id) } }; }
  get uiState() { return { hidden: [...uiState.hidden], pinned: uiState.pinned }; }
  get hiddenSet() { return uiState.hidden; }
  get solo() { return uiState.solo; }
  get reviews() { return reviews.list; }
  get reviewCounts() { return reviews.counts; }
  get approvedSet() { return reviews.approved; }
  get tool() { return editor.tool; }
  get color() { return editor.color; }
  get reviewMode() { return editor.reviewMode; }
  get followMode() { return workspace.followMode; }
  get comparing() { return workspace.comparing; }
  get current() { return this.slots.A.target; }
  get currentId() { return this.current ? this.idOf(this.current) : null; }
  get following() { return workspace.following; }

  // ---------- ids, visibility, pins ----------
  idOf(t) {
    if (t.kind === 'snapshot') return `${t.assetKind}:${t.name}`;
    if (t.kind === 'graph') return 'graph';
    return `${t.kind}:${t.name}`;
  }
  isHidden(id) { return uiState.isHidden(id); }
  isPinned(id) { return uiState.isPinned(id); }
  toggleHidden(id) {
    void uiState.toggleHidden(id);
  }
  togglePinned(id) {
    void uiState.togglePinned(id);
  }
  toggleSolo(id) { uiState.toggleSolo(id); this.browser.render(); }
  clearSolo() { uiState.clearSolo(); this.browser.render(); }

  // ---------- data (the stores fetch; these re-render the legacy DOM) ----------
  async refreshAssets() { await assets.refresh(); }
  renderAssets() {
    this.browser.render();
    if (!this.assets) return;
    $('wsPath').textContent = this.assets.home;
    $('wsPath').title = `workspace: ${this.assets.home}`;
  }
  async refreshReviews() { await reviews.refresh(); }
  renderReviews() {
    const open = reviews.openCount;
    $('reviewCount').textContent = open ? String(open) : '';
    $('reviewCount').hidden = !open;
    this.browser.render();
    for (const s of Object.values(this.slots)) if (s.viewer?.view?.render) s.viewer.view.render();
  }

  // ---------- tools / colour ----------
  setTool(t) {
    editor.setTool(t);
    for (const s of Object.values(this.slots)) s.viewer?.setToolUI?.(t);
  }
  setColor(hex) {
    editor.setColor(hex);
    for (const s of Object.values(this.slots)) s.viewer?.setColorUI?.(editor.color.hex8);
  }

  // ---------- viewers ----------
  viewerClass(t) {
    if (t.kind === 'canvas') return { edit: 'canvas', anim: 'anim', sheet: 'sheet', layers: 'layers', rig: 'rig' }[t.snap ? 'edit' : t.view || 'edit'] || 'canvas';
    if (t.kind === 'rig') return t.view === 'layers' ? 'layers' : 'rig';
    if (t.kind === 'model') return 'model';
    if (t.kind === 'audio') return 'audio';
    if (t.kind === 'project') return 'project';
    if (t.kind === 'graph') return 'graph';
    if (t.kind === 'export') {
      if (/\.glb$/i.test(t.name)) return 'model';
      if (/\.(wav|mp3|ogg|opus)$/i.test(t.name)) return 'audio';
      return 'export';
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
    const kind = this.viewerClass(target);
    if (!kind) return;
    const seq = (s.seq = (s.seq || 0) + 1);
    let Cls;
    try { Cls = await loadViewerClass(kind); } catch (e) { toast(`${target.name || target.kind}: could not load the viewer (${e.message})`, 'error'); return; }
    if (seq !== s.seq) return; // a newer open() for this slot won
    if (!(s.viewer instanceof Cls)) {
      s.viewer?.destroy();
      s.host.innerHTML = '';
      s.viewer = new Cls(s.host, { app: this, readOnly: slot === 'B', slot });
      workspace.registerViewer(slot, s.viewer);
    }
    s.target = target;
    workspace.open(target, { slot, history });
    this.renderTabs(slot);
    if (slot === 'A') {
      this.browser.markActive(this.currentId);
      this.inspector.show(target.kind === 'graph' ? { kind: 'graph' } : target);
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
  fromHash() {
    const h = decodeURIComponent(location.hash.slice(1));
    if (!h) return null;
    if (h === 'graph') return { kind: 'graph' };
    const m = h.match(/^(project|model|rig|audio|export|canvas):(.+)$/);
    if (m) return { kind: m[1], name: m[2] };
    return { kind: 'canvas', name: h };
  }
  setCompare(on) {
    workspace.setCompare(on);
    $('viewers').classList.toggle('compare', on);
    $('slotWrapB').hidden = !on;
    $('compareBtn').classList.toggle('on', on);
    if (!on && this.slots.B.viewer) { this.slots.B.viewer.destroy(); this.slots.B.viewer = null; workspace.registerViewer('B', null); this.slots.B.target = null; this.slots.B.host.innerHTML = ''; }
    if (on && !this.slots.B.target) this.slots.B.host.replaceChildren(el('div.empty-note', { text: 'Alt+click (or Shift+click) an asset in the browser, or ⇆ on a timeline entry, to compare it here.' }));
    window.dispatchEvent(new Event('resize'));
  }
  compare(a, b) {
    this.setCompare(true);
    this.open(a, { slot: 'A' });
    this.open(b, { slot: 'B' });
  }

  // ---------- review ----------
  reviewMarks(t) { return reviews.marks(t); }
  async reviewPrompt(t) {
    return reviewPrompt(t, () => this.setReviewMode(false));
  }
  setReviewMode(on) {
    editor.setReviewMode(on);
    $('reviewBtn').classList.toggle('on', on);
    document.body.classList.toggle('review-mode', on);
    for (const s of Object.values(this.slots)) s.viewer?.setToolUI?.(this.tool);
  }
  /** Asset ids for "compare with" suggestions. */
  assetChoices() { return assets.choices(); }
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
  inspectNode(id) { workspace.inspectNode(id); }

  // ---------- live events (state/live routes them to the stores; this re-renders the legacy DOM) ----------
  afterEvent(ev) {
    this.setStatus();
    if (ev.type === 'hello') return;
    if (ev.type === 'activity' || ev.type === 'resync') return; // the activity store has it; the timeline re-renders
    if (ev.type === 'change' && this.current?.kind === 'canvas' && this.current.name === ev.canvas && !this.current.snap && this.current.view && this.current.view !== 'edit') this.inspector.refreshFor({ name: ev.canvas });
  }
  /** Follow mode: open whatever the agent is touching (skips hidden / non-solo assets). */
  follow(entry) { workspace.follow(entry); }
  setStatus() {
    $('status').className = connection.pillClass;
    $('statusText').textContent = connection.label;
  }
  async loadUiState() { await uiState.load(); }
  /** Store changes -> legacy DOM. */
  watchStores() {
    watch(() => assets.rev, () => this.renderAssets());
    watch(() => reviews.rev, () => this.renderReviews());
    watch(() => connection.label, () => this.setStatus());
  }

  // ---------- drag an asset row onto a viewer slot (RV3) ----------
  setupDrop() {
    const viewers = $('viewers');
    const zone = el('div.drop-compare', { text: 'Compare here' });
    zone.hidden = true;
    viewers.append(zone);
    let depth = 0;
    const end = () => { depth = 0; zone.hidden = true; for (const s of ['A', 'B']) this.slots[s].host.classList.remove('drop-over'); };
    viewers.addEventListener('dragenter', (e) => { if (!hasDragTarget(e)) return; depth++; zone.hidden = this.comparing; });
    viewers.addEventListener('dragleave', (e) => { if (hasDragTarget(e) && --depth <= 0) end(); });
    viewers.addEventListener('dragover', (e) => {
      if (!hasDragTarget(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      const over = e.target instanceof Node && zone.contains(e.target) ? null : this.slots.B.host.contains(e.target) ? 'B' : 'A';
      for (const s of ['A', 'B']) this.slots[s].host.classList.toggle('drop-over', s === over);
    });
    viewers.addEventListener('drop', (e) => {
      const t = readDragTarget(e);
      const toB = e.target instanceof Node && (zone.contains(e.target) || this.slots.B.host.contains(e.target));
      end();
      if (!t) return;
      e.preventDefault();
      void this.open(t, { slot: toB ? 'B' : 'A' });
    });
    window.addEventListener('dragend', end);
  }

  // ---------- chrome ----------
  toast(text, kind = 'info') { toasts.push(text, kind); }
  setupTopbar() {
    const fs = $('followMode');
    fs.value = this.followMode;
    const sync = () => { $('followBtn').classList.toggle('on', this.following); $('followBtn').textContent = this.following ? '◉ Follow' : '○ Follow'; fs.value = this.followMode; };
    fs.onchange = () => { workspace.setFollowMode(fs.value); sync(); };
    $('followBtn').onclick = () => { workspace.toggleFollow(); sync(); };
    sync();
    $('compareBtn').onclick = () => this.setCompare(!this.comparing);
    $('closeB').onclick = () => this.setCompare(false);
    $('swapB').onclick = () => { const a = this.slots.A.target, b = this.slots.B.target; if (a && b) this.compare(b, a); };
    $('reviewBtn').onclick = () => this.setReviewMode(!this.reviewMode);
    $('reviewListBtn').onclick = () => this.showReviewList();
    $('graphBtn').onclick = () => this.open({ kind: 'graph' });
    $('cleanupBtn').onclick = () => dialogs.openCleanup();
    $('helpBtn').onclick = () => this.toggleHelp();
    $('toggleBrowser').onclick = () => this.togglePane('browser');
    $('toggleSide').onclick = () => this.togglePane('side');
  }
  showReviewList() { dialogs.openReviewList(); }
  toggleHelp() { dialogs.toggleHelp(); }
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
      // K2: a Svelte (Bits) dialog closes itself on Esc; only a legacy .modal is removed here.
      if (dialogOpen()) { if (e.key === 'Escape' && !dialogs.blocking) document.querySelector('.modal:not(#help)')?.remove(); return; }
      const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      const v = this.slots.A.viewer;
      if ((e.ctrlKey || e.metaKey) && k === 'z') { e.preventDefault(); v?.undo?.(e.shiftKey); return; }
      if ((e.ctrlKey || e.metaKey) && k === 'y') { e.preventDefault(); v?.undo?.(true); return; }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === 'Escape') { if (this.reviewMode) this.setReviewMode(false); else if (dialogs.helpOpen) this.toggleHelp(); else if (this.comparing) this.setCompare(false); else if (this.current?.snap) this.open({ kind: this.current.kind, name: this.current.name }); return; }
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
    this.watchStores();
    live.onAfterEvent((ev) => this.afterEvent(ev));
    const health = rest.health().catch(() => null);
    await Promise.all([uiState.load(), assets.refresh(), reviews.refresh()]);
    this.renderAssets(); this.renderReviews(); this.browser.render();
    try {
      const { entries } = await getJSON('/api/activity?limit=600');
      activity.load(entries);
    } catch { /* older server */ }
    connection.serverPid = (await health)?.pid ?? null;
    live.start();
    const t = this.fromHash();
    const a = this.assets;
    if (t && (t.kind !== 'canvas' || a?.canvases.some((c) => c.name === t.name))) this.open(t, { history: false });
    else if (a?.canvases.length) this.open({ kind: 'canvas', name: [...a.canvases].sort((x, y) => y.updated - x.updated)[0].name });
    else this.slots.A.host.replaceChildren(el('div.empty-note.big', {}, el('h2', { text: 'Nothing here yet' }), el('p', { text: 'Ask the agent to draw something (it shows up live), or press "+ New" to create a canvas.' })));
  }
}

window.agentArt = new App();
window.agentArt.boot();
