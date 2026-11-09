// Cards renderer for the asset graph (plan 5.9b): Svelte Flow behind the GraphRenderer interface.
// This is the one place under viewers/ that mounts a Svelte component (plan 2.2). The module is
// imported lazily by GraphViewer, so Svelte Flow lands in the graph-cards chunk.
// The force layout runs to completion off-screen and is applied once; there is no live simulation.
import type { GraphData, GraphRenderer, GraphRendererHost, VisNode } from '../renderer';
import {
  CARD_H, CARD_W, cardData, fromCards, relData, relatedTo, relationCounts, toCards, type CardContext, type CardData,
} from '../cards';
import { runForce } from '../sim';
import { FlowBridge, type CardNode, type RelFlowEdge } from './bridge.svelte';

type Mounted = Record<string, unknown>;

export class FlowRenderer implements GraphRenderer {
  readonly bridge: FlowBridge;
  readonly el: HTMLDivElement;
  private comp: Mounted | null = null;
  private unmountFn: ((c: Mounted) => void) | null = null;
  private data: GraphData | null = null;
  private runSeq = 0;
  private applied = false;
  private inited = false;
  private dead = false;
  private wantFit = false;
  private wantCenter: { id: string; minZoom: number } | null = null;
  private wasSettled: boolean | null = null;

  constructor(private readonly stage: HTMLElement, private readonly host: GraphRendererHost) {
    this.el = document.createElement('div');
    this.el.className = 'graph-flow';
    this.bridge = new FlowBridge({
      select: (id) => this.host.onSelect(id),
      activate: (id) => this.activate(id),
      moved: (id, x, y) => { const p = fromCards({ x, y }); this.host.onMoved(id, p.x, p.y); },
      action: (id, a) => {
        if (a === 'open') { this.activate(id); return; }
        this.host.onAction(id, a);
        this.refreshCard(id);
      },
      initialized: (on) => { this.inited = on; this.flush(); this.notifySettled(); },
    });
  }

  /** Mounts the Svelte component (dynamic imports: Svelte Flow is fetched here, not with the viewer). */
  async mount(): Promise<void> {
    const [{ mount, unmount }, { default: FlowGraph }] = await Promise.all([import('svelte'), import('./FlowGraph.svelte')]);
    if (this.dead) return;
    this.stage.append(this.el);
    this.comp = mount(FlowGraph, { target: this.el, props: { bridge: this.bridge } });
    this.unmountFn = (c) => { void unmount(c); };
    this.notifySettled();
  }

  get settled(): boolean { return this.applied && (this.inited || !this.bridge.nodes.length); }
  get focusEl(): HTMLElement | null { return null; }
  get view(): { x: number; y: number; k: number } {
    const v = this.bridge.api?.viewport();
    return v ? { x: v.x, y: v.y, k: v.zoom } : { x: 0, y: 0, k: 1 };
  }

  // ---- data ----
  setData(d: GraphData): void {
    this.data = d;
    const seq = ++this.runSeq;
    this.applied = false;
    this.notifySettled();
    const simulate = d.simulate ?? d.layout === 'force';
    if (!simulate || !d.nodes.length) { this.apply(); return; }
    void runForce(d.nodes, d.edges, () => !this.dead && seq === this.runSeq).then((ok) => { if (ok) this.apply(); });
  }

  setSelected(id: string | null): void {
    this.bridge.selected = id;
    if (!this.data || !this.applied) { if (this.data) this.data = { ...this.data, selected: id }; return; }
    this.data = { ...this.data, selected: id };
    const d = this.data;
    const related = relatedTo(id, d.edges);
    const counts = relationCounts(d.edges);
    const ctx = this.ctx(d);
    this.bridge.nodes = this.bridge.nodes.map((n) => {
      const sim = d.positions.get(n.id);
      return sim ? { ...n, selected: n.id === id, data: cardData(sim, counts.get(n.id) ?? 0, related, ctx) } : n;
    });
    const byId = new Map(d.edges.map((e) => [edgeId(e.a.id, e.rel, e.b.id), e]));
    this.bridge.edges = this.bridge.edges.map((e) => { const v = byId.get(e.id); return v ? { ...e, data: relData(v, id, d.edges.length) } : e; });
  }

  fit(): void {
    if (this.ready()) this.bridge.api?.fit(); else this.wantFit = true;
  }

  center(id: string, minZoom: number): void {
    const n = this.data?.positions.get(id);
    if (!n) return;
    if (!this.ready()) { this.wantCenter = { id, minZoom }; return; }
    const p = toCards(n);
    this.bridge.api?.center(p.x, p.y, minZoom);
  }

  resize(): void { /* Svelte Flow observes its own size */ }

  destroy(): void {
    if (this.dead) return;
    this.dead = true;
    this.runSeq++;
    if (this.comp && this.unmountFn) this.unmountFn(this.comp);
    this.comp = null;
    this.el.remove();
  }

  // ---- internals ----
  private ctx(d: GraphData): CardContext {
    return { thumb: (n: VisNode) => this.host.thumb(n), isPinned: (id) => this.host.isPinned(id), isHidden: (id) => this.host.isHidden(id), collapsed: d.collapsed, folded: d.folded };
  }

  /** Builds the flow nodes / edges from the controller's data (positions scaled to card space). */
  private apply(): void {
    const d = this.data;
    if (!d || this.dead) return;
    const prev = new Map(this.bridge.nodes.map((n) => [n.id, n]));
    const related = relatedTo(d.selected, d.edges);
    const counts = relationCounts(d.edges);
    const ctx = this.ctx(d);
    this.bridge.selected = d.selected;
    this.bridge.nodes = d.nodes.map((n): CardNode => {
      const data: CardData = cardData(n, counts.get(n.id) ?? 0, related, ctx);
      return {
        id: n.id, type: 'asset', position: toCards(n), data, width: CARD_W, height: CARD_H,
        selected: n.id === d.selected, connectable: false, deletable: false, ariaLabel: data.aria,
        measured: prev.get(n.id)?.measured,
      };
    });
    this.bridge.edges = d.edges.map((e): RelFlowEdge => ({
      id: edgeId(e.a.id, e.rel, e.b.id), source: e.a.id, target: e.b.id, type: 'rel',
      data: relData(e, d.selected, d.edges.length), selectable: false, focusable: false, deletable: false,
    }));
    this.applied = true;
    this.flush();
    this.notifySettled();
  }

  private refreshCard(id: string): void {
    const d = this.data;
    const sim = d?.positions.get(id);
    if (!d || !sim) return;
    const data = cardData(sim, relationCounts(d.edges).get(id) ?? 0, relatedTo(d.selected, d.edges), this.ctx(d));
    this.bridge.nodes = this.bridge.nodes.map((n) => (n.id === id ? { ...n, data } : n));
  }

  private activate(id: string): void {
    if (this.data?.positions.get(id)?.kind === 'group') this.host.onToggleGroup(id);
    else this.host.onOpen(id);
  }

  private ready(): boolean { return this.applied && !!this.bridge.api && (this.inited || !this.bridge.nodes.length); }

  /** Pending fit / centre requests run once the nodes are applied and measured. */
  private flush(): void {
    if (!this.ready() || (!this.wantFit && !this.wantCenter)) return;
    const fit = this.wantFit, c = this.wantCenter;
    this.wantFit = false;
    this.wantCenter = null;
    requestAnimationFrame(() => {
      if (this.dead) return;
      if (fit) this.bridge.api?.fit();
      if (c) this.center(c.id, c.minZoom);
    });
  }

  private notifySettled(): void {
    const s = this.settled;
    if (s !== this.wasSettled) { this.wasSettled = s; this.host.onSettled(s); }
  }
}

export const edgeId = (a: string, rel: string, b: string): string => `${a}|${rel}|${b}`;

/** Creates the Cards renderer inside the graph stage. */
export async function mountFlow(el: HTMLElement, host: GraphRendererHost): Promise<GraphRenderer> {
  const r = new FlowRenderer(el, host);
  await r.mount();
  return r;
}
