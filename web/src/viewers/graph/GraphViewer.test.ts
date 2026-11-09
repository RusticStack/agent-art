// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installCanvasStub, sizeElement } from '@/test/canvasStub';
import { fakeFetch } from '@/test/fakes';
import type { GraphDoc } from '@/lib/api/types';
import type { ViewerEnv, ViewerHostApi } from '../types';
import { GraphViewer } from './GraphViewer';
import { CanvasRenderer, backingScale } from './CanvasRenderer';

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
  const h = { inspectNode: vi.fn(), openNode: vi.fn() };
  const host = { slot: 'A', readOnly: false, ...h } as unknown as ViewerHostApi;
  return { host, ...h };
}
async function mount(focus?: string) {
  const el = document.createElement('div');
  document.body.append(el);
  const { host, inspectNode, openNode } = makeHost();
  const v = new GraphViewer(host);
  await v.mount(el, { target: { kind: 'graph', ...(focus ? { focus } : {}) }, env: ENV });
  return { v, el, inspectNode, openNode };
}

describe('GraphViewer', () => {
  beforeEach(() => {
    localStorage.clear();
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
