// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBitmap, installCanvasStub } from '@/test/canvasStub';
import { assetIndex, fakeFetch } from '@/test/fakes';
import type { AssetIndex, RigSummary } from '@/lib/api/types';
import type { ViewerEnv, ViewerHostApi } from '../types';
import { RigViewer } from './RigViewer';

const env: ViewerEnv = { tool: 'pencil', color: { hex: '#000000', hex8: '#000000ff' }, reviewMode: false, following: false, reviewsRev: 0, assetsRev: 0, compareLink: false, compareOverlay: 'off', peerRev: 0 };

function makeHost(assets: AssetIndex | null) {
  const open = vi.fn(), requestReview = vi.fn();
  const host: ViewerHostApi = {
    slot: 'A', readOnly: false, assets: () => assets, isHidden: () => false, reviewMarks: () => [], open, openNode: vi.fn(), inspectNode: vi.fn(),
    requestReview, setTool: vi.fn(), setColor: vi.fn(), canvasInfoChanged: vi.fn(), toast: vi.fn(), peerViewer: () => null, notifyPeer: vi.fn(),
    compareStatus: vi.fn(), setCompareOverlay: vi.fn(),
  };
  return { host, open, requestReview };
}
const rigSummary = (outputs: string[]): RigSummary => ({ name: 'hero', canvas: 'hero_parts', frame: [32, 32], views: ['side'], mirror: [], parts: [], poses: [], presets: [], outputs, version: '1' });
const RIG = { frame: [32, 32], views: ['side', 'front'], mirror: {}, parts: { torso: {}, head: { parent: 'torso' } }, poses: { crouch: {} } };
const OUT = {
  name: 'hero_side', width: 32, height: 128, frames: 4, frameHeight: 32, layers: [], activeLayer: 0, undo: 0, redo: 0, version: 1,
  animations: { walk_side: { frames: [0, 1, 2, 3], durations: [100, 100, 100, 100] } },
  meta: { anchors: { walk_side: [{ torso: [10, 10], head: [10, 4] }, { torso: [10, 11], head: [10, 5] }, { torso: [10, 10] }, { torso: [10, 11] }] } },
};
const png = { bytes: new Uint8Array([1]), contentType: 'image/png' };
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); await new Promise((r) => setTimeout(r, 0)); };

async function mount(o: { rig?: object; outputs?: string[]; target?: object; weights?: object } = {}) {
  const f = fakeFetch({
    '/api/rig/hero/preview.png': png,
    '/api/rig/hero/weights.png': o.weights ?? png,
    '/api/rig/hero': { json: o.rig ?? RIG },
    '/api/canvas/hero_side/png': png,
    '/api/canvas/hero_parts/png': png,
    '/api/canvas/hero_side': { json: OUT },
  });
  const { host, open, requestReview } = makeHost(assetIndex({ rigs: [rigSummary(o.outputs ?? ['hero_side'])] }));
  const el = document.createElement('div');
  document.body.append(el);
  const v = new RigViewer(host);
  await v.mount(el, { target: { kind: 'rig', name: 'hero', ...o.target }, env });
  await flush();
  return { v, el, f, open, requestReview };
}
const info = (v: RigViewer) => v.debugInfo() as { mode: string; playing: boolean; looping: boolean; clip: string | null; idx: number | null; image: boolean };
const setSelect = (s: HTMLSelectElement, value: string) => { s.value = value; s.dispatchEvent(new Event('change')); };
const modeSel = (el: HTMLElement) => el.querySelector<HTMLSelectElement>('.vtoolbar select')!;

describe('RigViewer', () => {
  let bitmaps: ImageBitmap[];
  beforeEach(() => {
    installCanvasStub();
    bitmaps = [];
    vi.stubGlobal('createImageBitmap', async () => { const b = fakeBitmap(32, 128); bitmaps.push(b); return b; });
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

  it('opens on the first clip with the skeleton and plays it in one rAF loop', async () => {
    const { v, el } = await mount();
    expect(el.querySelector('.viewer.rig-viewer canvas.rig-canvas')).not.toBeNull();
    expect(el.querySelector('.vstatus')!.textContent).toBe('hero · frame 32×32 · 2 parts · views side, front · clip hero_side/walk_side: 4 frames · skeleton from part anchors');
    expect(info(v)).toMatchObject({ mode: 'clip', clip: 'hero_side/walk_side', playing: true, looping: true });
    const ctx = (el.querySelector('canvas.rig-canvas') as HTMLCanvasElement & { _ctx: { calls: { fn: string }[] } })._ctx;
    expect(ctx.calls.some((c) => c.fn === 'arc')).toBe(true);
    v.destroy();
    v.destroy();
    expect(bitmaps[0].close).toHaveBeenCalled();
  });

  it('switching to pose fetches the preview with the legacy parameters into a read-only PixelView; the loop stops', async () => {
    const { v, el, f } = await mount();
    setSelect(modeSel(el), 'pose');
    await flush();
    const url = f.calls.map((c) => c.url).find((u) => u.includes('preview.png'))!;
    expect(url).toMatch(/^\/api\/rig\/hero\/preview\.png\?t=\d+$/);
    expect(url).not.toMatch(/scale=/);
    expect(el.querySelector('canvas.pixel-canvas')!.getAttribute('aria-label')).toBe('pose preview');
    expect(el.querySelector('canvas.rig-canvas')).toBeNull();
    expect(info(v)).toMatchObject({ mode: 'pose', looping: false, image: true });
    expect(el.querySelector('.vstatus')!.textContent).toMatch(/pose rest · red dashes = ground line$/);
    // pose + view selects feed the query
    const [, pose, view] = [...el.querySelectorAll<HTMLSelectElement>('.vtoolbar select')];
    pose.value = 'crouch'; view.value = 'front'; view.dispatchEvent(new Event('change'));
    await flush();
    expect(f.calls.map((c) => c.url).filter((u) => u.includes('preview.png')).pop()).toMatch(/^\/api\/rig\/hero\/preview\.png\?pose=crouch&view=front&t=\d+$/);
    // parts sheet destroys the previous PixelView and shows a new one; the replaced bitmap is closed
    setSelect(modeSel(el), 'parts');
    await flush();
    expect(el.querySelectorAll('canvas.pixel-canvas')).toHaveLength(1);
    expect(f.calls.some((c) => c.url.startsWith('/api/canvas/hero_parts/png?t='))).toBe(true);
    expect(bitmaps.slice(0, -1).every((b) => (b.close as unknown as { mock: { calls: unknown[] } }).mock.calls.length > 0)).toBe(true);
    v.destroy();
  });

  it('no clips: falls back to pose; requested skin without a skin falls back to pose', async () => {
    const a = await mount({ outputs: [] });
    expect(info(a.v).mode).toBe('pose');
    a.v.destroy();
    const b = await mount({ target: { mode: 'skin' } });
    expect(info(b.v).mode).toBe('pose');
    expect(modeSel(b.el).querySelector<HTMLOptionElement>('option[value="skin"]')!.hidden).toBe(true);
    b.v.destroy();
  });

  it('requested clip with no clips shows the note', async () => {
    const { v, el } = await mount({ outputs: [], target: { mode: 'clip' } });
    expect(el.querySelector('.empty-note')!.textContent).toBe('No clips yet: art_rig animate {name, preset} renders them.');
    v.destroy();
  });

  it('a 404 JSON body from the weights image is shown in the stage', async () => {
    const rig = { ...RIG, skin: { body: { bones: ['torso', 'head'] } } };
    const { v, el, f } = await mount({ rig, target: { mode: 'skin' }, weights: { status: 404, json: { error: 'no mesh drawing to show (pick a mesh / view)' } } });
    expect(f.calls.map((c) => c.url).find((u) => u.includes('weights.png'))).toMatch(/^\/api\/rig\/hero\/weights\.png\?mesh=body&t=\d+$/);
    expect(el.querySelector('.rig-stage .empty-note')!.textContent).toBe('no mesh drawing to show (pick a mesh / view)');
    v.destroy();
  });

  it('rig load errors are shown and rethrown', async () => {
    fakeFetch({ '/api/rig/nope': { status: 404, json: { error: 'no rig "nope"' } } });
    const { host } = makeHost(null);
    const el = document.createElement('div');
    const v = new RigViewer(host);
    await expect(v.mount(el, { target: { kind: 'rig', name: 'nope' }, env })).rejects.toThrow('no rig "nope"');
    expect(el.querySelector('.empty-note')!.textContent).toBe('no rig "nope"');
    v.destroy();
  });

  it('keys: space toggles play, , and . step (and pause); review click pins the output canvas frame', async () => {
    const { v, el, requestReview } = await mount();
    expect(v.onKey(new KeyboardEvent('keydown'), '.')).toBe(true);
    expect(info(v)).toMatchObject({ idx: 1, playing: false, looping: false });
    v.onKey(new KeyboardEvent('keydown'), ',');
    v.onKey(new KeyboardEvent('keydown'), ',');
    expect(info(v).idx).toBe(3);
    expect(v.onKey(new KeyboardEvent('keydown'), ' ')).toBe(true);
    expect(info(v)).toMatchObject({ playing: true, looping: true });
    const c = el.querySelector('canvas.rig-canvas') as HTMLCanvasElement;
    c.dispatchEvent(new MouseEvent('click', { clientX: 5, clientY: 5 }));
    expect(requestReview).not.toHaveBeenCalled();
    await v.update({ target: { kind: 'rig', name: 'hero' }, env: { ...env, reviewMode: true } });
    c.dispatchEvent(new MouseEvent('click', { clientX: 5, clientY: 5 }));
    expect(requestReview).toHaveBeenCalledWith({ asset: 'canvas:hero_side', tag: 'walk_side', frame: 3, point: [5, 5] });
    v.destroy();
  });

  it('Edit parts opens the parts canvas; a change to the parts canvas reloads after 200 ms', async () => {
    const { v, el, f, open } = await mount();
    [...el.querySelectorAll('button')].find((b) => b.textContent === 'Edit parts')!.click();
    expect(open).toHaveBeenCalledWith({ kind: 'canvas', name: 'hero_parts' });
    const n = f.calls.filter((c) => c.url === '/api/rig/hero').length;
    v.onEvent({ type: 'change', canvas: 'other', version: 1, op: 'draw', source: 'agent', dirty: null, ts: 1 });
    v.onEvent({ type: 'change', canvas: 'hero_parts', version: 2, op: 'draw', source: 'agent', dirty: null, ts: 1 });
    await new Promise((r) => setTimeout(r, 250));
    await flush();
    expect(f.calls.filter((c) => c.url === '/api/rig/hero').length).toBe(n + 1);
    expect(info(v).mode).toBe('clip');
    v.destroy();
  });
});
