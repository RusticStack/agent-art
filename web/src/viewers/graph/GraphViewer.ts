// Asset graph viewer (controller): loads /api/graph, filters (relation, tag, text, sub-assets), collapses
// groups, keeps the selection, persists the toolbar choices, reloads on server events, and hands the
// visible graph to a renderer (CanvasRenderer in step 10; a Cards renderer joins in step 10b).
// Click selects (the inspector shows the node), double-click opens. A keyboard list of the visible
// nodes ("List") makes selection and open work without a pointer.
import type { AnyEvent, GraphDoc, GraphEdge } from '@/lib/api/types';
import { api } from '@/lib/api/client';
import { isAbort } from '@/lib/api/http';
import { thumbUrl } from '@/lib/api/urls';
import { h } from '@/lib/util/dom';
import { KIND_LABEL } from '@/lib/util/kinds';
import { store } from '@/lib/util/storage';
import { BaseViewer } from '../base';
import { button, fillSelect, group, label, select, spacer, toggle } from '../controls';
import type { Target } from '../types';
import { CanvasRenderer } from './CanvasRenderer';
import type { GraphRendererHost, VisNode } from './renderer';
import {
  applyFilter, buildGraph, countsText, findNode, layeredLayout, nodeLabel, parseLayout, relColor, reloadsOn,
  type GraphLayout, type SimNode, type VisEdge,
} from './sim';

/** Persisted keys (prefixed "agent-art:" by store). */
export const KEYS = { collapsed: 'graphCollapsed', hiddenRels: 'graphHiddenRels', sub: 'graphSub', layout: 'graphLayout' } as const;
const strList = (v: unknown, d: string[]): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : d);
let listSeq = 0;

export class GraphViewer extends BaseViewer {
  private nodes = new Map<string, SimNode>();
  private allEdges: GraphEdge[] = [];
  private rels: string[] = [];
  private vis: SimNode[] = [];
  private edges: VisEdge[] = [];
  private collapsed = new Set(strList(store.get<unknown>(KEYS.collapsed, []), []));
  private hiddenRels = new Set(strList(store.get<unknown>(KEYS.hiddenRels, ['layer_of']), ['layer_of']));
  private showSub = store.get<unknown>(KEYS.sub, false) === true;
  private layout: GraphLayout = parseLayout(store.get<unknown>(KEYS.layout, 'force'));
  private selected: string | null = null;
  private pendingFocus: string | null = null;
  private version = 0;
  private relSig = '';
  private listOpen = false;
  private listActive = -1;
  private readonly listId = `graph-list-${++listSeq}`;
  // DOM
  private renderer!: CanvasRenderer;
  private search!: HTMLInputElement;
  private tagSel!: HTMLSelectElement;
  private layoutSel!: HTMLSelectElement;
  private listBtn!: HTMLButtonElement;
  private list!: HTMLUListElement;
  private relBox!: HTMLElement;
  private counts!: HTMLElement;
  private stage!: HTMLElement;
  private statusEl!: HTMLElement;

  /** One graph per slot: a new focus re-selects, it does not reload. */
  protected key(_t: Target): string { return 'graph'; }

  protected build(): HTMLElement {
    const root = h('div', { class: 'viewer graph-viewer' });
    this.search = h('input', { class: 'search', type: 'text', placeholder: 'Find node…', 'aria-label': 'Find node', on: { input: () => this.focusSearch(), keydown: (e: KeyboardEvent) => { if (e.key === 'Enter') this.focusSearch(); } } });
    this.tagSel = select({ title: 'Show only nodes with this tag', onChange: () => this.applyFilter(false) });
    fillSelect(this.tagSel, [], { first: { value: '', label: 'any' } });
    const sub = toggle({ label: 'Sub-assets', title: 'Layers, animation tags, rig and model parts', checked: this.showSub, onChange: (on) => { this.showSub = on; store.set(KEYS.sub, on); this.applyFilter(false); } });
    this.layoutSel = select({ title: 'Layout', onChange: (v) => { this.layout = parseLayout(v); store.set(KEYS.layout, this.layout); this.relayout(false); } });
    fillSelect(this.layoutSel, [{ value: 'force', label: 'Force' }, { value: 'layered', label: 'Layered by kind' }], { keep: this.layout });
    this.listBtn = button({ text: 'List', title: 'List the visible nodes (keyboard selection)', onClick: () => this.toggleList() });
    this.listBtn.setAttribute('aria-expanded', 'false');
    this.listBtn.setAttribute('aria-controls', this.listId);
    this.counts = h('span', { class: 'mono muted', 'aria-live': 'polite' });
    root.append(h('div', { class: 'vtoolbar' },
      this.search,
      group(label('Tag'), this.tagSel),
      sub.el,
      group(this.layoutSel, button({ text: 'Fit', title: 'Fit (0)', onClick: () => this.fit() }), this.listBtn),
      spacer(), this.counts));
    this.relBox = h('div', { class: 'rel-filter', role: 'group', 'aria-label': 'Relations' });
    root.append(this.relBox);
    this.list = h('ul', { class: 'graph-list', id: this.listId, role: 'listbox', tabindex: '0', 'aria-label': 'Visible nodes', hidden: true, on: { keydown: (e: KeyboardEvent) => this.listKey(e) } });
    root.append(this.list);
    this.stage = h('div', { class: 'graph-stage', dataset: { settled: 'false' } });
    root.append(this.stage);
    this.statusEl = h('div', { class: 'vstatus mono', hidden: true });
    root.append(this.statusEl);

    const rhost: GraphRendererHost = {
      onSelect: (id) => this.select(id),
      onOpen: (id) => this.host.openNode(id),
      onToggleGroup: (id) => this.toggleGroup(id),
      onMoved: () => {},
      onSettled: (s) => { this.stage.dataset.settled = String(s); },
      thumb: (n: VisNode) => (n.missing ? null : thumbUrl(n.kind, n.name, n.version || '0')),
    };
    this.renderer = new CanvasRenderer(this.stage, rhost);
    this.onResize(this.stage, () => this.renderer.resize());
    this.onDprChange(() => this.renderer.resize());
    this.addCleanup(() => this.renderer.destroy());
    return root;
  }

  // ---- loading ----
  protected async load(target: Target, _prev: Target | null): Promise<void> {
    const focus = target.kind === 'graph' ? target.focus ?? null : null;
    this.pendingFocus = focus;
    await this.reload(true);
    if (focus && !this.dead) this.select(focus, true);
  }
  protected targetChanged(_prev: Target, next: Target): void {
    if (next.kind === 'graph' && next.focus) this.select(next.focus, true);
  }

  async reload(first = false): Promise<void> {
    const token = this.nextLoad();
    let g: GraphDoc;
    try { g = await api.graph(this.dispose.signal); } catch (e) {
      if (!this.isCurrent(token) || isAbort(e)) return;
      this.showError(`Graph: ${(e as Error).message}`);
      throw e;
    }
    if (!this.isCurrent(token)) return;
    this.showError(null);
    const b = buildGraph(g, this.nodes);
    this.nodes = b.nodes;
    this.allEdges = b.edges;
    this.rels = b.rels;
    fillSelect(this.tagSel, b.tags.map((t) => ({ value: t, label: '#' + t })), { first: { value: '', label: 'any' } });
    this.renderChips();
    this.applyFilter(first);
  }
  private showError(msg: string | null): void {
    this.statusEl.hidden = !msg;
    this.statusEl.textContent = msg ?? '';
  }

  /** Relation toggle chips (pressed = shown); rebuilt only when the relation list changes. */
  private renderChips(): void {
    const sig = this.rels.join('|');
    if (sig === this.relSig) { for (const b of this.relBox.querySelectorAll<HTMLButtonElement>('.rel-chip')) this.syncChip(b); return; }
    this.relSig = sig;
    this.relBox.replaceChildren(...this.rels.map((r) => {
      const b = h('button', { type: 'button', class: 'rel-chip', text: r, title: `Show "${r}" edges`, dataset: { rel: r }, style: { borderColor: relColor(r) },
        on: { click: () => { if (this.hiddenRels.has(r)) this.hiddenRels.delete(r); else this.hiddenRels.add(r); store.set(KEYS.hiddenRels, [...this.hiddenRels]); this.syncChip(b); this.applyFilter(false); } } });
      this.syncChip(b);
      return b;
    }));
  }
  private syncChip(b: HTMLButtonElement): void {
    const on = !this.hiddenRels.has(b.dataset.rel ?? '');
    b.setAttribute('aria-pressed', String(on));
    b.classList.toggle('on', on);
  }

  /** Visible nodes / edges after filters and group collapse. */
  private applyFilter(first: boolean): void {
    const r = applyFilter(this.nodes, this.allEdges, { tag: this.tagSel.value, showSub: this.showSub, hiddenRels: this.hiddenRels, collapsed: this.collapsed });
    this.vis = r.vis;
    this.edges = r.edges;
    this.counts.textContent = countsText(this.vis.length, this.edges.length, this.collapsed.size);
    this.relayout(first);
    if (this.listOpen) this.renderList();
  }

  private relayout(fit: boolean): void {
    if (this.layout === 'layered') layeredLayout(this.vis);
    this.version++;
    this.renderer.setData({ nodes: this.vis, edges: this.edges, positions: this.nodes, selected: this.selected, version: this.version, layout: this.layout, collapsed: this.collapsed });
    // first load auto-fits (after the force layout had time to spread); a focus target is centred after
    if (fit) this.later(this.layout === 'force' ? 700 : 0, () => { this.renderer.fit(); if (this.pendingFocus) this.renderer.center(this.pendingFocus, 0); this.pendingFocus = null; }, 'fit');
  }

  fit(): void { this.renderer.fit(); }

  // ---- selection ----
  /** Select a node (the inspector shows it; never opens). center = put it in the middle of the stage. */
  select(id: string | null, center = false, minZoom = 0): void {
    this.selected = id;
    this.renderer.setSelected(id);
    if (id) this.host.inspectNode(id);
    if (center && id) this.renderer.center(id, minZoom);
    if (this.listOpen) this.syncListSelection();
  }
  private toggleGroup(id: string): void {
    if (this.collapsed.has(id)) this.collapsed.delete(id); else this.collapsed.add(id);
    store.set(KEYS.collapsed, [...this.collapsed]);
    this.applyFilter(false);
  }
  private openOrFold(id: string): void {
    if (this.nodes.get(id)?.kind === 'group') this.toggleGroup(id);
    else this.host.openNode(id);
  }
  private focusSearch(): void {
    const n = findNode(this.vis, this.search.value);
    if (n) this.select(n.id, true, 1.2);
  }

  // ---- keyboard list of the visible nodes ----
  private toggleList(): void {
    this.listOpen = !this.listOpen;
    this.list.hidden = !this.listOpen;
    this.listBtn.setAttribute('aria-expanded', String(this.listOpen));
    this.listBtn.classList.toggle('on', this.listOpen);
    if (this.listOpen) { this.renderList(); this.list.focus(); } else this.list.replaceChildren();
  }
  private listNodes(): SimNode[] { return [...this.vis].sort((a, b) => a.id.localeCompare(b.id)); }
  private renderList(): void {
    const items = this.listNodes();
    this.list.replaceChildren(...items.map((n, i) => h('li', {
      id: `${this.listId}-${i}`, role: 'option', 'aria-selected': String(n.id === this.selected), dataset: { id: n.id },
      text: `${nodeLabel(n)} (${KIND_LABEL[n.kind] ?? n.kind})`,
      on: { click: () => { this.listActive = i; this.select(n.id, true); }, dblclick: () => this.openOrFold(n.id) },
    })));
    this.syncListSelection();
  }
  private syncListSelection(): void {
    const opts = [...this.list.children] as HTMLElement[];
    let active = -1;
    opts.forEach((li, i) => { const on = li.dataset.id === this.selected; li.setAttribute('aria-selected', String(on)); li.classList.toggle('on', on); if (on) active = i; });
    this.listActive = active;
    if (active >= 0) { this.list.setAttribute('aria-activedescendant', opts[active].id); opts[active].scrollIntoView?.({ block: 'nearest' }); }
    else this.list.removeAttribute('aria-activedescendant');
  }
  private listKey(e: KeyboardEvent): void {
    const opts = [...this.list.children] as HTMLElement[];
    const n = opts.length;
    let i = this.listActive;
    switch (e.key) {
      case 'ArrowDown': i = Math.min(n - 1, i + 1); break;
      case 'ArrowUp': i = Math.max(0, i - 1); break;
      case 'Home': i = 0; break;
      case 'End': i = n - 1; break;
      case 'Enter': { const id = opts[i]?.dataset.id; if (id) this.openOrFold(id); e.preventDefault(); e.stopPropagation(); return; }
      case 'Escape': this.toggleList(); this.listBtn.focus(); e.preventDefault(); e.stopPropagation(); return;
      default: return;
    }
    e.preventDefault();
    e.stopPropagation();
    const id = opts[i]?.dataset.id;
    if (id) this.select(id, true);
  }

  // ---- live ----
  onEvent(ev: AnyEvent): void {
    if (reloadsOn(ev as { type: string; structural?: unknown })) this.later(400, () => { void this.reload(false).catch(() => {}); }, 'reload');
  }
  onKey(_e: KeyboardEvent, key: string): boolean {
    if (key === '0') { this.fit(); return true; }
    return false;
  }

  debugInfo(): { renderer: 'canvas'; nodes: number; edges: number; layout: GraphLayout; settled: boolean; selected: string | null; view: { x: number; y: number; k: number }; positions: Record<string, [number, number]> } {
    const positions: Record<string, [number, number]> = {};
    for (const n of this.vis) positions[n.id] = [Math.round(n.x * 10) / 10, Math.round(n.y * 10) / 10];
    return { renderer: 'canvas', nodes: this.vis.length, edges: this.edges.length, layout: this.layout, settled: this.renderer.settled, selected: this.selected, view: { ...this.renderer.view }, positions };
  }
}
