// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installCanvasStub, sizeElement } from '@/test/canvasStub';
import { fakeFetch } from '@/test/fakes';
import type { GraphDoc } from '@/lib/api/types';
import type { ViewerEnv, ViewerHostApi } from '../types';
import { GraphViewer } from './GraphViewer';
import { CanvasRenderer, backingScale } from './CanvasRenderer';
import type { GraphData, GraphRenderer, GraphRendererHost } from './renderer';
import { CARDS_MAX_NODES, CARDS_REFUSED_MSG } from './cards';
import { HIER_LIMIT_MSG } from './hierarchy';

// The Cards renderer needs a real browser (Svelte Flow measures the DOM): the controller is tested
// against a stand-in that records what it is given; the real one is covered by e2e/graph.spec.ts.
const flow = vi.hoisted(() => {
  class FakeFlow {
    data: GraphData | null = null;
    selected: string | null = null;
    fits = 0;
    destroyed = false;
    readonly el = document.createElement('div');
    constructor(stage: HTMLElement, readonly host: GraphRendererHost) { this.el.className = 'fake-flow'; stage.append(this.el); }
    setData(d: GraphData) { this.data = d; this.selected = d.selected; this.host.onSettled(true); }
    setSelected(id: string | null) { this.selected = id; }
    fit() { this.fits++; }
    center() {}
    resize() {}
    destroy() { this.destroyed = true; this.el.remove(); }
    get settled() { return !!this.data; }
    get focusEl() { return null; }
    get view() { return { x: 0, y: 0, k: 1 }; }
  }
  return { FakeFlow, fail: false, last: null as InstanceType<typeof FakeFlow> | null };
});
vi.mock('./flow/mountFlow', () => ({
  mountFlow: async (el: HTMLElement, host: GraphRendererHost): Promise<GraphRenderer> => {
    if (flow.fail) throw new Error('chunk failed');
    flow.last = new flow.FakeFlow(el, host);
    return flow.last;
  },
}));

const DOC: GraphDoc = {
  nodes: [
    { id: 'canvas:helmet_front', kind: 'canvas', tags: ['armour'] },
    { id: 'canvas:helmet_side', kind: 'canvas' },
    { id: 'canvas:pauldron', kind: 'canvas', note: 'Left shoulder' },
    { id: 'group:Severance armour', kind: 'group' },
    { id: 'layer:pauldron/base', kind: 'layer' },
  ],
  edges: [
    { from: 'canvas:helmet_side', rel: 'variant_of', to: 'canvas:helmet_front' },
    { from: 'canvas:helmet_front', rel: 'part_of', to: 'group:Severance armour' },
    { from: 'canvas:helmet_side', rel: 'part_of', to: 'group:Severance armour' },
    { from: 'canvas:pauldron', rel: 'part_of', to: 'group:Severance armour' },
    { from: 'layer:pauldron/base', rel: 'layer_of', to: 'canvas:pauldron' },
  ],
  rels: ['part_of', 'variant_of', 'layer_of'],
};
const ENV: ViewerEnv = { tool: 'pencil', color: { hex: '#000000', hex8: '#000000ff' }, reviewMode: false, following: false, reviewsRev: 0, assetsRev: 0, compareLink: false, compareOverlay: 'off', peerRev: 0 };

function makeHost() {
  const h = { inspectNode: vi.fn(), openNode: vi.fn(), toast: vi.fn(), open: vi.fn(), togglePinned: vi.fn(), toggleHidden: vi.fn(), isHidden: vi.fn(() => false), isPinned: vi.fn(() => false), assets: vi.fn(() => null) };
  const host = { slot: 'A', readOnly: false, ...h } as unknown as ViewerHostApi;
  return { host, ...h };
}
async function mount(focus?: string) {
  const el = document.createElement('div');
  document.body.append(el);
  const hh = makeHost();
  const v = new GraphViewer(hh.host);
  await v.mount(el, { target: { kind: 'graph', ...(focus ? { focus } : {}) }, env: ENV });
  return { v, el, ...hh };
}

describe('GraphViewer', () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem('agent-art:graphRenderer', '"canvas"'); // the Cards renderer needs a real browser (e2e)
    installCanvasStub();
    HTMLCanvasElement.prototype.setPointerCapture = () => {};
    fakeFetch({ '/api/graph': { json: DOC } });
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); document.body.replaceChildren(); });

  it('loads, counts, hides layer_of and sub-assets by default, persists chip toggles', async () => {
    const { v, el } = await mount();
    expect(el.querySelector('.viewer.graph-viewer .vtoolbar')!.textContent).toMatch(/4 nodes · 4 edges/);
    const chips = [...el.querySelectorAll<HTMLButtonElement>('.rel-filter .rel-chip')];
    expect(chips.map((c) => [c.textContent, c.getAttribute('aria-pressed')])).toEqual([['part_of', 'true'], ['variant_of', 'true'], ['layer_of', 'false']]);
    chips[1].click();
    expect(chips[1].getAttribute('aria-pressed')).toBe('false');
    expect(JSON.parse(localStorage.getItem('agent-art:graphHiddenRels')!).sort()).toEqual(['layer_of', 'variant_of']);
    expect((v.debugInfo()).edges).toBe(3);
    expect(el.querySelector('canvas.graph-canvas')!.getAttribute('aria-label')).toBe('Asset graph: 4 nodes, 3 edges');
    v.destroy();
    v.destroy();
    expect(el.children).toHaveLength(0);
  });

  it('Find selects the first match (inspector, not open); focus target selects', async () => {
    const { v, el, inspectNode, openNode } = await mount('canvas:pauldron');
    expect(inspectNode).toHaveBeenCalledWith('canvas:pauldron');
    const search = el.querySelector<HTMLInputElement>('input.search')!;
    search.value = 'helmet_s';
    search.dispatchEvent(new Event('input'));
    expect(inspectNode).toHaveBeenLastCalledWith('canvas:helmet_side');
    expect(v.debugInfo().selected).toBe('canvas:helmet_side');
    expect(v.debugInfo().view.k).toBeGreaterThanOrEqual(1.2);
    expect(openNode).not.toHaveBeenCalled();
    v.destroy();
  });

  it('keyboard list: arrows select, Enter opens, a group folds; collapsed persists', async () => {
    const { v, el, inspectNode, openNode } = await mount();
    const listBtn = [...el.querySelectorAll('button')].find((b) => b.textContent === 'List')!;
    listBtn.click();
    const list = el.querySelector<HTMLUListElement>('ul.graph-list[role=listbox]')!;
    expect(list.hidden).toBe(false);
    expect(list.children).toHaveLength(4);
    const key = (k: string) => list.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
    key('ArrowDown');
    expect(inspectNode).toHaveBeenLastCalledWith('canvas:helmet_front');
    expect(list.getAttribute('aria-activedescendant')).toBe(list.children[0].id);
    key('Enter');
    expect(openNode).toHaveBeenCalledWith('canvas:helmet_front');
    key('End');
    expect(inspectNode).toHaveBeenLastCalledWith('group:Severance armour');
    key('Enter');
    expect(JSON.parse(localStorage.getItem('agent-art:graphCollapsed')!)).toEqual(['group:Severance armour']);
    expect(v.debugInfo().nodes).toBe(1);
    expect(el.querySelector('.vtoolbar')!.textContent).toMatch(/1 nodes · 0 edges · 1 collapsed/);
    v.destroy();
  });

  it('settles: data-settled flips to true once the force run ends; layered is settled at once', async () => {
    const { v, el } = await mount();
    const stage = el.querySelector<HTMLElement>('.graph-stage')!;
    expect(stage.dataset.settled).toBe('false');
    const r = (v as unknown as { renderer: CanvasRenderer }).renderer;
    for (let i = 0; i < 400 && !r.settled; i++) r.tick();
    expect(r.ticks).toBeLessThanOrEqual(300);
    expect(stage.dataset.settled).toBe('true');
    expect(v.debugInfo().settled).toBe(true);
    const sel = el.querySelectorAll<HTMLSelectElement>('select')[1];
    sel.value = 'layered';
    sel.dispatchEvent(new Event('change'));
    expect(localStorage.getItem('agent-art:graphLayout')).toBe('"layered"');
    expect(stage.dataset.settled).toBe('true');
    expect(v.debugInfo().layout).toBe('layered');
    v.destroy();
  });

  it('reloads 400 ms after a graph event, keeping positions; plain canvas changes do not reload', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { v } = await mount();
    (v as unknown as { nodes: Map<string, { pinned?: boolean }> }).nodes.get('canvas:pauldron')!.pinned = true; // pinned: the simulation does not move it
    const before = v.debugInfo().positions['canvas:pauldron'];
    const f = fetch as unknown as { mock: { calls: unknown[] } };
    const n0 = f.mock.calls.length;
    v.onEvent({ type: 'change', canvas: 'x', ts: 1 });
    v.onEvent({ type: 'graph', ts: 1 });
    v.onEvent({ type: 'graph', ts: 2 });
    await vi.advanceTimersByTimeAsync(450);
    expect(f.mock.calls.length).toBe(n0 + 1);
    expect(v.debugInfo().positions['canvas:pauldron']).toEqual(before);
    expect(v.onKey!(new KeyboardEvent('keydown'), '0')).toBe(true);
    v.destroy();
  });

  it('canvas renderer: click selects, double-click opens, keys pan / zoom / open', async () => {
    const { v, el, inspectNode, openNode } = await mount();
    const r = (v as unknown as { renderer: CanvasRenderer }).renderer;
    const canvas = el.querySelector<HTMLCanvasElement>('canvas.graph-canvas')!;
    sizeElement(canvas, 400, 300);
    r.view = { x: 0, y: 0, k: 1 };
    const pos = v.debugInfo().positions['canvas:helmet_side'];
    const ev = (type: string) => { const e = new MouseEvent(type, { clientX: pos[0], clientY: pos[1], bubbles: true }); Object.defineProperty(e, 'pointerId', { value: 1 }); canvas.dispatchEvent(e); };
    ev('pointerdown'); ev('pointerup');
    expect(inspectNode).toHaveBeenLastCalledWith('canvas:helmet_side');
    ev('dblclick');
    expect(openNode).toHaveBeenCalledWith('canvas:helmet_side');
    const key = (k: string) => { const e = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }); canvas.dispatchEvent(e); return e.defaultPrevented; };
    expect(key('ArrowLeft')).toBe(true);
    expect(r.view.x).toBe(60);
    expect(key('+')).toBe(true);
    expect(r.view.k).toBeCloseTo(1.25);
    expect(key('Enter')).toBe(true);
    expect(openNode).toHaveBeenCalledTimes(2);
    expect(key('q')).toBe(false);
    v.destroy();
  });

  it('shows a load error in the viewer and rethrows', async () => {
    fakeFetch({ '/api/graph': { status: 500, json: { error: 'boom' } } });
    const el = document.createElement('div');
    const v = new GraphViewer(makeHost().host);
    await expect(v.mount(el, { target: { kind: 'graph' }, env: ENV })).rejects.toThrow();
    const st = el.querySelector<HTMLElement>('.vstatus')!;
    expect(st.hidden).toBe(false);
    expect(st.textContent).toMatch(/Graph/);
    v.destroy();
  });

  it('backing store is clamped to 8192 px a side and 32 MP', () => {
    expect(backingScale(800, 600, 2)).toBe(2);
    expect(backingScale(5000, 1000, 2)).toBeCloseTo(8192 / 5000);
    expect(backingScale(5000, 5000, 2)).toBeCloseTo(Math.sqrt(32_000_000 / 25_000_000));
  });
});

/** A graph with n loose canvases (plus the DOC ones). */
const bigDoc = (n: number): GraphDoc => ({ ...DOC, nodes: [...DOC.nodes, ...Array.from({ length: n }, (_, i) => ({ id: `canvas:extra_${i}`, kind: 'canvas' }))] });
const viewSel = (el: HTMLElement) => el.querySelector<HTMLSelectElement>('select[aria-label="View"]')!;
const change = (sel: HTMLSelectElement, value: string) => { sel.value = value; sel.dispatchEvent(new Event('change')); };

describe('GraphViewer: renderer choice (Auto / Cards / Canvas) and Hierarchy', () => {
  beforeEach(() => {
    localStorage.clear();
    installCanvasStub();
    HTMLCanvasElement.prototype.setPointerCapture = () => {};
    fakeFetch({ '/api/graph': { json: DOC } });
    flow.fail = false;
    flow.last = null;
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

  it('Auto opens a small graph in Cards: counts say so, no canvas, no List button', async () => {
    const { v, el } = await mount();
    await vi.waitFor(() => expect(v.debugInfo().renderer).toBe('cards'));
    expect(viewSel(el).value).toBe('auto');
    expect(el.querySelector('.vtoolbar')!.textContent).toMatch(/4 nodes · 4 edges · cards/);
    expect(el.querySelector('canvas.graph-canvas')).toBeNull();
    expect(el.querySelector('.graph-stage .fake-flow')).not.toBeNull();
    expect([...el.querySelectorAll('button')].find((b) => b.textContent === 'List')!.hidden).toBe(true);
    expect(flow.last!.data!.nodes).toHaveLength(4);
    expect(el.querySelector<HTMLElement>('.graph-stage')!.dataset.settled).toBe('true');
    expect(v.debugInfo()).toMatchObject({ pref: 'auto', large: false, settled: true });
    v.destroy();
    expect(flow.last!.destroyed).toBe(true);
  });

  it('switching View keeps positions and the selection; the choice persists', async () => {
    const { v, el } = await mount();
    await vi.waitFor(() => expect(v.debugInfo().renderer).toBe('cards'));
    v.select('canvas:helmet_side');
    const before = v.debugInfo().positions;
    change(viewSel(el), 'canvas');
    expect(localStorage.getItem('agent-art:graphRenderer')).toBe('"canvas"');
    expect(v.debugInfo().renderer).toBe('canvas');
    expect(el.querySelector('canvas.graph-canvas')).not.toBeNull();
    expect(el.querySelector('.fake-flow')).toBeNull();
    expect(v.debugInfo().positions).toEqual(before);
    expect(v.debugInfo().selected).toBe('canvas:helmet_side');
    expect(v.debugInfo().settled).toBe(true); // no new simulation run on a switch
    change(viewSel(el), 'cards');
    await vi.waitFor(() => expect(v.debugInfo().renderer).toBe('cards'));
    expect(v.debugInfo().positions).toEqual(before);
    expect(flow.last!.data!.selected).toBe('canvas:helmet_side');
    expect(flow.last!.data!.simulate).toBe(false);
    expect(el.querySelector('.vtoolbar')!.textContent).toMatch(/· cards/);
    v.destroy();
  });

  it('Auto falls back to Canvas for a large graph and says so', async () => {
    fakeFetch({ '/api/graph': { json: bigDoc(401) } });
    const { v, el } = await mount();
    expect(v.debugInfo()).toMatchObject({ renderer: 'canvas', large: true, nodes: 405 });
    expect(el.querySelector('.vtoolbar')!.textContent).toMatch(/405 nodes · 4 edges · canvas \(large graph\)/);
    expect(flow.last).toBeNull();
    v.destroy();
  });

  it('Cards above the limit is refused with a toast and the select returns to Canvas', async () => {
    localStorage.setItem('agent-art:graphRenderer', '"cards"');
    fakeFetch({ '/api/graph': { json: bigDoc(CARDS_MAX_NODES) } });
    const { v, el, toast } = await mount();
    expect(toast).toHaveBeenCalledWith(CARDS_REFUSED_MSG, 'error');
    expect(viewSel(el).value).toBe('canvas');
    expect(v.debugInfo().renderer).toBe('canvas');
    expect(flow.last).toBeNull();
    v.destroy();
  });

  it('a failed cards chunk toasts once and uses Canvas', async () => {
    flow.fail = true;
    const { v, el, toast } = await mount();
    await vi.waitFor(() => expect(el.querySelector('canvas.graph-canvas')).not.toBeNull());
    expect(v.debugInfo().renderer).toBe('canvas');
    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast.mock.calls[0][0]).toMatch(/Cards view failed to load/);
    expect(el.querySelector('canvas.graph-canvas')).not.toBeNull();
    el.querySelector<HTMLButtonElement>('.rel-chip[data-rel="variant_of"]')!.click();
    expect(toast).toHaveBeenCalledTimes(1);
    v.destroy();
  });

  it('card actions: compare opens in the other slot, pin / hide go to the host, a drag end pins', async () => {
    const { v, open, togglePinned, toggleHidden } = await mount();
    await vi.waitFor(() => expect(flow.last).not.toBeNull());
    const host = flow.last!.host;
    host.onAction('canvas:helmet_front', 'compare');
    expect(open).toHaveBeenCalledWith({ kind: 'canvas', name: 'helmet_front' }, { slot: 'B' });
    host.onAction('canvas:helmet_front', 'pin');
    expect(togglePinned).toHaveBeenCalledWith('canvas:helmet_front');
    host.onAction('canvas:helmet_front', 'hide');
    expect(toggleHidden).toHaveBeenCalledWith('canvas:helmet_front');
    host.onMoved('canvas:pauldron', 12.5, -40);
    expect(v.debugInfo().positions['canvas:pauldron']).toEqual([12.5, -40]);
    const collapsed = flow.last!.data!.collapsed;
    expect(collapsed.size).toBe(0);
    host.onToggleGroup('group:Severance armour');
    expect(flow.last!.data!.folded?.get('group:Severance armour')).toBe(3);
    v.destroy();
  });

  it('Hierarchy (canvas): containers left of their parts; the choice persists', async () => {
    localStorage.setItem('agent-art:graphRenderer', '"canvas"');
    const { v, el } = await mount();
    change(el.querySelectorAll<HTMLSelectElement>('select')[1], 'hierarchy');
    expect(localStorage.getItem('agent-art:graphLayout')).toBe('"hierarchy"');
    expect(el.querySelector('.vtoolbar')!.textContent).toMatch(/laying out…/);
    await vi.waitFor(() => expect(el.querySelector('.vtoolbar')!.textContent).not.toMatch(/laying out/));
    const p = v.debugInfo().positions;
    expect(p['group:Severance armour'][0]).toBeLessThan(p['canvas:helmet_front'][0]);
    expect(p['group:Severance armour'][0]).toBeLessThan(p['canvas:pauldron'][0]);
    expect(p['canvas:helmet_side'][0]).toBeLessThan(p['canvas:helmet_front'][0]); // variant_of keeps its direction
    expect(v.debugInfo()).toMatchObject({ layout: 'hierarchy', settled: true });
    v.destroy();
  });

  it('Hierarchy in Cards lays out in card space and hands controller coordinates back', async () => {
    localStorage.setItem('agent-art:graphLayout', '"hierarchy"');
    const { v } = await mount();
    await vi.waitFor(() => expect(flow.last?.data?.layout).toBe('hierarchy'));
    const p = v.debugInfo().positions;
    // card boxes are 156 wide, ranks 64 apart; divided by the 2.2 card scale on the way back
    expect(p['canvas:pauldron'][0] - p['group:Severance armour'][0]).toBeCloseTo((156 + 64) / 2.2, 0);
    v.destroy();
  });

  it('Hierarchy over the limit falls back to Layered by kind for this run, keeping the stored choice', async () => {
    localStorage.setItem('agent-art:graphRenderer', '"canvas"');
    localStorage.setItem('agent-art:graphLayout', '"hierarchy"');
    fakeFetch({ '/api/graph': { json: bigDoc(1500) } });
    const { v, el } = await mount();
    const st = el.querySelector<HTMLElement>('.vstatus')!;
    expect(st.hidden).toBe(false);
    expect(st.textContent).toBe(HIER_LIMIT_MSG);
    expect(v.debugInfo().layout).toBe('hierarchy');
    expect(localStorage.getItem('agent-art:graphLayout')).toBe('"hierarchy"');
    const p = v.debugInfo().positions;
    expect(p['group:Severance armour'][0]).toBeLessThan(p['canvas:helmet_front'][0]); // layered columns
    change(el.querySelectorAll<HTMLSelectElement>('select')[1], 'force');
    expect(st.hidden).toBe(true);
    v.destroy();
  });
});
