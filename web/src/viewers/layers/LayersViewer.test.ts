// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBitmap, installCanvasStub, makeCtx, sizeElement } from '@/test/canvasStub';
import { assetIndex, fakeFetch } from '@/test/fakes';
import type { AssetIndex, RigSummary } from '@/lib/api/types';
import type { Target, ViewerEnv, ViewerHostApi } from '../types';
import { LayersViewer } from './LayersViewer';

const env: ViewerEnv = { tool: 'pencil', color: { hex: '#000000', hex8: '#000000ff' }, reviewMode: false, following: false, reviewsRev: 0, assetsRev: 0, compareLink: false, compareOverlay: 'off', peerRev: 0 };

function makeHost(assets: AssetIndex | null) {
  const requestReview = vi.fn();
  const host: ViewerHostApi = {
    slot: 'A', readOnly: false, assets: () => assets, isHidden: () => false, reviewMarks: () => [], open: vi.fn(), openNode: vi.fn(), inspectNode: vi.fn(),
    requestReview, setTool: vi.fn(), setColor: vi.fn(), canvasInfoChanged: vi.fn(), toast: vi.fn(), peerViewer: () => null, notifyPeer: vi.fn(),
    compareStatus: vi.fn(), setCompareOverlay: vi.fn(),
  };
  return { host, requestReview };
}
const rigSummary = (outputs: string[]): RigSummary => ({ name: 'hero', canvas: 'hero_parts', frame: [4, 4], views: ['side'], mirror: [], parts: [], poses: [], presets: [], outputs, version: '1' });
const STACK = [{ part: 'torso', z: 0, rule: 'base' }, { part: 'arm', z: 1, rule: 'near side' }, { part: 'head', z: 2, rule: 'above torso' }];
const LAYERS = { frames: [{ stack: STACK }, { stack: [STACK[1], STACK[0], STACK[2]] }], views: ['side', 'front'], view: 'side', source: 'rig_layers' };
const DEBUG = { size: [4, 4], atlas: btoa('png'), atlas_parts: ['torso', 'arm', 'head'], stack: STACK };
const OUT = { name: 'hero_side', width: 4, height: 16, frames: 4, frameHeight: 4, layers: [], activeLayer: 0, undo: 0, redo: 0, version: 1, animations: { walk_side: { frames: [4, 5, 6, 7], durations: [100, 100, 100, 100] } } };
const HELMET = { name: 'helmet', width: 4, height: 4, frames: 1, frameHeight: null, activeLayer: 0, undo: 0, redo: 0, version: 7, animations: {},
  layers: [{ index: 0, name: 'base', visible: true, opacity: 1 }, { index: 1, name: 'shine', visible: true, opacity: 1 }] };
const png = { bytes: new Uint8Array([1]), contentType: 'image/png' };
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); await new Promise((r) => setTimeout(r, 0)); for (let i = 0; i < 10; i++) await Promise.resolve(); };

/** OffscreenCanvas whose pixels are all opaque (so every part covers every pixel). */
class FakeOffscreen {
  constructor(public width: number, public height: number) {}
  getContext() {
    const c = makeCtx(this);
    return new Proxy(c, { get: (t, k: string) => (k === 'getImageData' ? (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4).fill(255) }) : t[k]) });
  }
}

async function mount(target: Target, routes: Record<string, object> = {}) {
  const f = fakeFetch({
    '/api/rig/hero/layers': { json: LAYERS },
    '/api/rig/hero/debug': { json: DEBUG },
    '/api/canvas/hero_side': { json: OUT },
    '/api/canvas/helmet/png': png,
    '/api/canvas/helmet': { json: HELMET },
    ...routes,
  });
  const { host, requestReview } = makeHost(assetIndex({ rigs: [rigSummary(['hero_side'])] }));
  const el = document.createElement('div');
  document.body.append(el);
  const v = new LayersViewer(host);
  await v.mount(el, { target, env });
  await flush();
  return { v, el, f, requestReview };
}
const rows = (el: HTMLElement) => [...el.querySelectorAll<HTMLElement>('.stack-list > .stack-row')];
const flagBtn = (el: HTMLElement) => [...el.querySelectorAll('button')].find((b) => /^Flag/.test(b.textContent || ''))!;

describe('LayersViewer', () => {
  beforeEach(() => {
    installCanvasStub();
    vi.stubGlobal('createImageBitmap', async () => fakeBitmap(4, 12));
    vi.stubGlobal('OffscreenCanvas', FakeOffscreen);
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

  it('rig: stack top first, clips, frame label; select two parts and flag the rest pose', async () => {
    const { v, el, requestReview } = await mount({ kind: 'rig', name: 'hero', view: 'layers' });
    expect(el.querySelector('.viewer.layers-viewer canvas.layers-canvas')).not.toBeNull();
    expect(rows(el).map((r) => r.dataset.part)).toEqual(['head', 'arm', 'torso']);
    expect(el.querySelector('.stack-list')!.children).toHaveLength(3);
    expect(rows(el)[0].querySelector('.sz')!.textContent).toBe('z 2');
    expect(rows(el)[0].querySelector('.srule')!.textContent).toBe('above torso');
    const [viewSel, tagSel] = [...el.querySelectorAll('select')];
    expect([...tagSel.options].map((o) => o.value)).toEqual(['', 'hero_side/walk_side']);
    expect([...viewSel.options].map((o) => o.value)).toEqual(['side', 'front']);
    expect(el.querySelector('input.scrub')!.getAttribute('aria-valuetext')).toBe('frame 1 of 2');
    expect(el.querySelector('.vtoolbar .mono')!.textContent).toBe('0 / 1');
    expect(el.querySelector('.layers-side .muted.small')!.textContent).toBe('source: rig_layers');
    expect(flagBtn(el).disabled).toBe(true);
    rows(el)[0].click();
    rows(el)[1].click();
    expect(flagBtn(el).disabled).toBe(false);
    expect(flagBtn(el).textContent).toBe('Flag: head above arm?');
    expect(rows(el)[0].classList.contains('sel0')).toBe(true);
    expect(rows(el)[1].classList.contains('sel1')).toBe(true);
    expect(rows(el)[0].querySelector('button.sname')!.getAttribute('aria-pressed')).toBe('true');
    flagBtn(el).click();
    expect(requestReview).toHaveBeenCalledWith({ asset: 'rig:hero', view: 'side', part: 'head,arm', category: 'layering', note: 'head should be above arm', priority: 'high' });
    v.destroy();
    v.destroy();
  });

  it('rig clip: flag uses the output canvas and its absolute frame; , . step and fetch /debug per frame', async () => {
    const { v, el, f, requestReview } = await mount({ kind: 'rig', name: 'hero', view: 'layers', canvas: 'hero_side', tag: 'walk_side' });
    const tagSel = el.querySelectorAll('select')[1];
    expect(tagSel.value).toBe('hero_side/walk_side');
    expect(f.calls.some((c) => c.url === '/api/rig/hero/layers?canvas=hero_side&tag=walk_side&view=side' || c.url === '/api/rig/hero/layers?canvas=hero_side&tag=walk_side')).toBe(true);
    expect(v.onKey(new KeyboardEvent('keydown'), '.')).toBe(true);
    await flush();
    expect(f.calls.map((c) => c.url)).toContain('/api/rig/hero/debug?canvas=hero_side&tag=walk_side&view=side&frame=1');
    expect(rows(el).map((r) => r.dataset.part)).toEqual(['head', 'arm', 'torso']);   // /debug stack
    rows(el)[2].click(); rows(el)[0].click();
    flagBtn(el).click();
    expect(requestReview).toHaveBeenCalledWith({ asset: 'canvas:hero_side', frame: 5, view: 'side', tag: 'walk_side', part: 'torso,head', category: 'layering', note: 'torso should be above head', priority: 'high' });
    v.destroy();
  });

  it('superseded frame fetches are aborted; the latest frame wins', async () => {
    const { v, f } = await mount({ kind: 'rig', name: 'hero', view: 'layers' });
    const before = f.calls.length;
    void v.setFrame(1);
    void v.setFrame(0);
    await flush();
    const dbg = f.calls.slice(before).filter((c) => c.url.includes('/debug'));
    expect(dbg).toHaveLength(2);
    expect((dbg[0].init as RequestInit).signal!.aborted).toBe(true);
    expect((v.debugInfo() as { frame: number }).frame).toBe(0);
    v.destroy();
  });

  it('hover tells which part drew the pixel and what is underneath; eye and solo are view-only', async () => {
    const { v, el } = await mount({ kind: 'rig', name: 'hero', view: 'layers' });
    const c = el.querySelector('canvas.layers-canvas') as HTMLCanvasElement;
    sizeElement(c, 4, 4);
    c.dispatchEvent(new MouseEvent('pointermove', { clientX: 1, clientY: 1 }));
    await new Promise((r) => setTimeout(r, 40));
    const hover = el.querySelector('.hover-info')!;
    expect(hover.textContent).toBe('x 1 y 1: drawn by head (z 2) · underneath: arm (z 1), torso (z 0)');
    const eye = rows(el)[0].querySelector<HTMLButtonElement>('button.act')!;
    eye.click();
    expect(rows(el)[0].querySelector('button.act')!.getAttribute('aria-pressed')).toBe('true');
    expect((v.debugInfo() as { sel: string[] }).sel).toEqual([]);   // eye click does not select
    c.dispatchEvent(new MouseEvent('pointermove', { clientX: 2, clientY: 1 }));
    await new Promise((r) => setTimeout(r, 40));
    expect(hover.textContent).toBe('x 2 y 1: drawn by arm (z 1) · underneath: torso (z 0)');
    const solo = rows(el)[2].querySelectorAll<HTMLButtonElement>('button.act')[1];
    solo.click();
    c.dispatchEvent(new MouseEvent('pointermove', { clientX: 0, clientY: 0 }));
    await new Promise((r) => setTimeout(r, 40));
    expect(hover.textContent).toBe('x 0 y 0: drawn by torso (z 0)');
    c.dispatchEvent(new MouseEvent('pointerleave'));
    expect(hover.textContent).toBe('');
    v.destroy();
  });

  it('canvas: one stack row per layer, layer PNGs per frame, flag on the canvas', async () => {
    const { v, el, f, requestReview } = await mount({ kind: 'canvas', name: 'helmet', view: 'layers' });
    expect(el.querySelector('.stack-list')!.children).toHaveLength(2);
    expect(rows(el).map((r) => r.dataset.part)).toEqual(['shine', 'base']);
    expect(f.calls.map((c) => c.url).filter((u) => u.includes('/png'))).toEqual(['/api/canvas/helmet/png?t=7&layer=0', '/api/canvas/helmet/png?t=7&layer=1']);
    expect([...el.querySelectorAll('select')[1].options].map((o) => o.textContent)).toEqual(['1 frame(s)']);
    expect((el.querySelector('.vtoolbar .group') as HTMLElement).hidden).toBe(true);   // view group (rig only)
    rows(el)[0].click(); rows(el)[1].click();
    flagBtn(el).click();
    expect(requestReview).toHaveBeenCalledWith({ asset: 'canvas:helmet', frame: 0, part: 'shine,base', category: 'layering', note: 'shine should be above base', priority: 'high' });
    v.destroy();
  });

  it('a change to the canvas reloads after 250 ms; other canvases are ignored', async () => {
    const { v, f } = await mount({ kind: 'canvas', name: 'helmet', view: 'layers' });
    const n = f.calls.filter((c) => c.url === '/api/canvas/helmet').length;
    v.onEvent({ type: 'change', canvas: 'other', version: 1, op: 'draw', source: 'agent', dirty: null, ts: 1 });
    v.onEvent({ type: 'change', canvas: 'helmet', version: 8, op: 'draw', source: 'agent', dirty: null, ts: 1 });
    await new Promise((r) => setTimeout(r, 300));
    await flush();
    expect(f.calls.filter((c) => c.url === '/api/canvas/helmet').length).toBe(n + 1);
    v.destroy();
  });

  it('load errors are shown and rethrown', async () => {
    fakeFetch({ '/api/canvas/nope': { status: 404, json: { error: 'no canvas "nope"' } } });
    const { host } = makeHost(null);
    const el = document.createElement('div');
    const v = new LayersViewer(host);
    await expect(v.mount(el, { target: { kind: 'canvas', name: 'nope', view: 'layers' }, env })).rejects.toThrow('no canvas "nope"');
    expect(el.querySelector('.layers-side .muted.small')!.textContent).toBe('no canvas "nope"');
    v.destroy();
  });
});
