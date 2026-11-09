// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssetIndex, CanvasInfo, RigSummary } from '@/lib/api/types';
import { fakeBitmap, installCanvasStub, sizeElement } from '@/test/canvasStub';
import { assetIndex, fakeFetch } from '@/test/fakes';
import type { ReviewDraft, ViewerEnv, ViewerHostApi } from '../types';
import { AnimViewer } from './AnimViewer';

const env = (o: Partial<ViewerEnv> = {}): ViewerEnv => ({ tool: 'pencil', color: { hex: '#000000', hex8: '#000000ff' }, reviewMode: false, following: true, reviewsRev: 0, assetsRev: 0, compareLink: false, compareOverlay: 'off', peerRev: 0, ...o });

function makeHost(assets: AssetIndex | null) {
  const reviews: ReviewDraft[] = [];
  const box = { assets };
  const host: ViewerHostApi = {
    slot: 'A', readOnly: false,
    assets: () => box.assets, isHidden: () => false, reviewMarks: () => [], open: () => {}, openNode: () => {}, inspectNode: () => {},
    requestReview: (d) => { reviews.push(d); }, setTool: () => {}, setColor: () => {}, canvasInfoChanged: () => {}, toast: () => {},
    peerViewer: () => null, notifyPeer: () => {}, compareStatus: () => {}, setCompareOverlay: () => {},
  };
  return { host, reviews, box };
}

const rig: RigSummary = { name: 'hero', canvas: 'hero_parts', frame: [16, 16], views: ['side', 'front', 'back'], mirror: [], parts: [], poses: [], presets: [], outputs: ['hero_walk'], version: '1' };
const tag = (frames: number[], d = 100) => ({ frames, durations: frames.map(() => d) });
function canvasInfo(o: Partial<CanvasInfo> = {}): CanvasInfo {
  return { name: 'hero_walk', width: 16, height: 96, frames: 6, frameHeight: 16, activeLayer: 0, layers: [], animations: { walk_side: tag([0, 1]), walk_front: tag([2, 3]), walk_back: tag([4, 5]) }, meta: { rig: 'hero' }, undo: 0, redo: 0, version: 1, ...o };
}

async function setup(info: CanvasInfo, assets: AssetIndex | null = assetIndex({ rigs: [rig] }), target: { tag?: string } = {}) {
  const f = fakeFetch({ '/api/canvas/hero_walk/png': { bytes: new Uint8Array([1]) }, '/api/canvas/hero_walk': { json: info } });
  const { host, reviews, box } = makeHost(assets);
  const v = new AnimViewer(host);
  const el = document.createElement('div');
  document.body.append(el);
  await v.mount(el, { target: { kind: 'canvas', name: 'hero_walk', view: 'anim', ...target }, env: env() });
  return { v, el, reviews, f, box, host };
}

describe('AnimViewer', () => {
  beforeEach(() => {
    installCanvasStub();
    vi.stubGlobal('createImageBitmap', async () => fakeBitmap(16, 96));
    localStorage.clear();
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); document.body.replaceChildren(); });

  it('rig output: plays every view in a compass grid', async () => {
    const { el, v } = await setup(canvasInfo());
    const cells = el.querySelectorAll('canvas.anim-cell');
    expect(cells.length).toBe(3);
    expect(el.querySelector('.anim-stage')!.classList.contains('compass')).toBe(true);
    expect(el.querySelectorAll('.anim-grid > figure').length).toBe(9);
    expect(el.querySelector('.anim-grid > figure:nth-child(5)')!.textContent).toBe('walk');
    expect(cells[0].getAttribute('role')).toBe('img');
    expect([...cells].map((c) => c.getAttribute('aria-label'))).toEqual(['back', 'side', 'front']);
    expect(el.querySelector('select')!.value).toBe('walk_side');
    expect(el.querySelector('.vstatus')!.textContent).toBe('hero_walk · walk_side: 2 frames, 200 ms · 3 views');
    expect(el.querySelector<HTMLAnchorElement>('a.btn')!.getAttribute('href')).toBe('/api/canvas/hero_walk/anim.gif?scale=4&download=1&animation=walk_side');
    v.destroy();
    v.destroy();
    expect(el.children.length).toBe(0);
  });

  it('target tag preselects; the user choice survives a reload; grid toggle persists', async () => {
    const { el, v } = await setup(canvasInfo(), undefined, { tag: 'walk_back' });
    const sel = el.querySelector('select')!;
    expect(sel.value).toBe('walk_back');
    sel.value = '';
    sel.dispatchEvent(new Event('change'));
    expect(el.querySelectorAll('canvas.anim-cell').length).toBe(1);
    await v.reload();
    expect(sel.value).toBe('');
    const grid = [...el.querySelectorAll<HTMLLabelElement>('label.toggle')].find((l) => l.textContent?.includes('Per-view grid'))!.querySelector('input')!;
    grid.checked = false;
    grid.dispatchEvent(new Event('change'));
    expect(localStorage.getItem('agent-art:dirgrid')).toBe('false');
    v.destroy();
  });

  it('without the asset index first, views are resolved when assetsRev bumps', async () => {
    const { el, v, box } = await setup(canvasInfo({ animations: { walk: tag([0, 1]), walk_front: tag([2, 3]), walk_back: tag([4, 5]) } }), null);
    // no rig: built-in names; "walk" -> default view, so 3 cells but not a compass
    expect(el.querySelector('.anim-stage')!.classList.contains('compass')).toBe(false);
    box.assets = assetIndex({ rigs: [rig] });
    v.update({ target: { kind: 'canvas', name: 'hero_walk', view: 'anim' }, env: env({ assetsRev: 1 }) });
    expect(el.querySelector('.anim-stage')!.classList.contains('compass')).toBe(true);
    v.destroy();
  });

  it('Space pauses and plays; the loop advances frames', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => setTimeout(() => cb(performance.now()), 16) as unknown as number);
    vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id));
    const { v, el } = await setup(canvasInfo());
    const frame = () => (v.debugInfo() as { cells: { idx: number }[] }).cells[0].idx;
    sizeElement(el.querySelector('.anim-stage')!, 400, 300);
    const seen = new Set<number>();
    for (let i = 0; i < 10; i++) { await vi.advanceTimersByTimeAsync(40); seen.add(frame()); }
    expect(seen).toEqual(new Set([0, 1]));
    const ev = new KeyboardEvent('keydown', { key: ' ' });
    expect(v.onKey(ev, ' ')).toBe(true);
    expect((v.debugInfo() as { playing: boolean }).playing).toBe(false);
    const at = frame();
    await vi.advanceTimersByTimeAsync(500);
    expect(frame()).toBe(at);
    expect((v.debugInfo() as { running: boolean }).running).toBe(false);
    expect(el.querySelector('button.btn')!.getAttribute('aria-pressed')).toBe('false');
    v.onKey(ev, ' ');
    await vi.advanceTimersByTimeAsync(250);
    expect((v.debugInfo() as { running: boolean }).running).toBe(true);
    expect(v.onKey(ev, 'x')).toBe(false);
    v.destroy();
  });

  it('review mode: click pins the pixel with tag, view and frame; Enter pins the centre', async () => {
    const { el, v, reviews } = await setup(canvasInfo());
    const c = el.querySelector<HTMLCanvasElement>('canvas.anim-cell[aria-label="front"]')!;
    c.dispatchEvent(new MouseEvent('click', { clientX: 1, clientY: 1 }));
    expect(reviews).toEqual([]);
    expect(c.tabIndex).toBe(-1);
    v.update({ target: { kind: 'canvas', name: 'hero_walk', view: 'anim' }, env: env({ reviewMode: true }) });
    expect(c.tabIndex).toBe(0);
    c.getBoundingClientRect = () => ({ left: 0, top: 0, width: 32, height: 32 }) as DOMRect;
    c.dispatchEvent(new MouseEvent('click', { clientX: 10, clientY: 30 }));
    c.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(reviews).toEqual([
      { asset: 'canvas:hero_walk', tag: 'walk_front', view: 'front', frame: 2, point: [5, 15] },
      { asset: 'canvas:hero_walk', tag: 'walk_front', view: 'front', frame: 2, point: [8, 8] },
    ]);
    v.destroy();
  });

  it('fps change keeps the user scale and persists; change events reload after 120 ms', async () => {
    const { el, v, f } = await setup(canvasInfo({ animations: {} }));
    const ranges = el.querySelectorAll<HTMLInputElement>('input[type=range]');
    const [fps, scale] = [ranges[0], ranges[1]];
    scale.value = '5'; scale.dispatchEvent(new Event('input'));
    expect(el.querySelector<HTMLCanvasElement>('canvas.anim-cell')!.width).toBe(80);
    fps.value = '20'; fps.dispatchEvent(new Event('input'));
    expect(localStorage.getItem('agent-art:fps')).toBe('20');
    expect(el.querySelector<HTMLCanvasElement>('canvas.anim-cell')!.width).toBe(80);
    expect(el.querySelector('.vstatus')!.textContent).toBe('hero_walk · 6 frames @ 20 fps');
    vi.useFakeTimers();
    const n = f.calls.length;
    v.onEvent({ type: 'change', canvas: 'other', ts: 1 } as never);
    v.onEvent({ type: 'change', canvas: 'hero_walk', ts: 1 } as never);
    v.onEvent({ type: 'change', canvas: 'hero_walk', ts: 2 } as never);
    await vi.advanceTimersByTimeAsync(100);
    expect(f.calls.length).toBe(n);
    await vi.advanceTimersByTimeAsync(30);
    expect(f.calls.length).toBe(n + 2);
    v.destroy();
  });

  it('a missing canvas shows "Canvas not found" and rejects', async () => {
    fakeFetch({ '/api/canvas/nope': { status: 404, json: { ok: false, error: 'no canvas nope' } } });
    const { host } = makeHost(null);
    const v = new AnimViewer(host);
    const el = document.createElement('div');
    await expect(v.mount(el, { target: { kind: 'canvas', name: 'nope', view: 'anim' }, env: env() })).rejects.toThrow('no canvas nope');
    expect(el.querySelector('.anim-stage')!.textContent).toBe('Canvas not found');
    v.destroy();
  });

  it('destroy during a pending load is safe', async () => {
    const { host } = makeHost(null);
    fakeFetch({ '/api/canvas/hero_walk/png': { bytes: new Uint8Array([1]) }, '/api/canvas/hero_walk': { json: canvasInfo() } });
    const v = new AnimViewer(host);
    const el = document.createElement('div');
    const p = v.mount(el, { target: { kind: 'canvas', name: 'hero_walk', view: 'anim' }, env: env() });
    v.destroy();
    await p;
    expect(el.children.length).toBe(0);
  });
});
