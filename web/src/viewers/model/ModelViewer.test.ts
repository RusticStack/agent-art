// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeFetch } from '@/test/fakes';
import type { Target, ViewerEnv, ViewerHostApi } from '../types';

vi.mock('./three', () => ({ loadThree: vi.fn(), resetThree: vi.fn() }));
import { loadThree, resetThree, type ThreeBundle } from './three';
import { ModelViewer } from './ModelViewer';

const env: ViewerEnv = { tool: 'pencil', color: { hex: '#000000', hex8: '#000000ff' }, reviewMode: false, following: false, reviewsRev: 0, assetsRev: 0, compareLink: false, compareOverlay: 'off', peerRev: 0 };
const host: ViewerHostApi = {
  slot: 'A', readOnly: false, assets: () => null, isHidden: () => false, reviewMarks: () => [], open: vi.fn(), openNode: vi.fn(), inspectNode: vi.fn(),
  requestReview: vi.fn(), setTool: vi.fn(), setColor: vi.fn(), canvasInfoChanged: vi.fn(), toast: vi.fn(), peerViewer: () => null, notifyPeer: vi.fn(),
  compareStatus: vi.fn(), setCompareOverlay: vi.fn(),
};
/** A bundle whose renderer cannot get a WebGL context. */
const noGl = { THREE: { WebGLRenderer: class { constructor() { throw new Error('no gl'); } } } } as unknown as ThreeBundle;
const load = vi.mocked(loadThree);
let viewer: ModelViewer;
let el: HTMLElement;
let calls: { url: string }[];

async function mount(target: Target): Promise<void> {
  viewer = new ModelViewer(host);
  el = document.createElement('div');
  document.body.append(el);
  await viewer.mount(el, { target, env });
}
const status = () => el.querySelector('.vstatus span')!.textContent;
const retry = () => [...el.querySelectorAll<HTMLButtonElement>('.vstatus button')].find((b) => b.textContent === 'Retry')!;

beforeEach(() => {
  localStorage.clear();
  load.mockReset();
  vi.mocked(resetThree).mockReset();
  calls = fakeFetch({ '/api/model/rifle/info': { json: { materials: ['overlay:rifle_tex'] } } }).calls;
});
afterEach(() => { viewer?.destroy(); el?.remove(); vi.unstubAllGlobals(); });

describe('ModelViewer without three / WebGL', () => {
  it('builds the legacy toolbar and DOM classes', async () => {
    load.mockRejectedValue(new Error('offline'));
    await mount({ kind: 'model', name: 'rifle' });
    expect(el.querySelector('.viewer.model-viewer .vtoolbar')).not.toBeNull();
    expect(el.querySelectorAll('.vtoolbar:not(.shading) .group').length).toBe(4);
    expect(el.querySelector('.vtoolbar.shading [role=radiogroup]')!.querySelectorAll('[role=radio]').length).toBe(4);
    expect(el.querySelector('.model-stage .model-labels')).not.toBeNull();
    const sel = el.querySelectorAll('select');
    expect(sel[0].options.length).toBe(14);
    expect(sel[0].value).toBe('lit');
    const labels = [...el.querySelectorAll('.vtoolbar:not(.shading) label.toggle')].map((l) => l.textContent!.trim());
    expect(labels).toEqual(['Wireframe', 'Clusters', 'Normals', 'UV checker', 'Sockets', 'Pivots', 'Grid', 'Loop']);
    const checked = [...el.querySelectorAll<HTMLInputElement>('.vtoolbar:not(.shading) label.toggle input')].map((i) => i.checked);
    expect(checked).toEqual([false, false, false, false, true, false, true, true]);
    const a = el.querySelector<HTMLAnchorElement>('a.btn')!;
    expect(a.getAttribute('href')).toBe('/api/model/rifle/glb?download=1');
    expect(a.getAttribute('download')).toBe('rifle.glb');
  });

  it('chunk load failure shows the server thumbnail and a Retry that clears the cached promise', async () => {
    load.mockRejectedValueOnce(new Error('Failed to fetch dynamically imported module'));
    await mount({ kind: 'model', name: 'rifle', snap: 's9' });
    const img = el.querySelector<HTMLImageElement>('.model-stage img.fallback')!;
    expect(img.getAttribute('src')).toBe('/api/model/rifle/thumb.png?size=384&snap=s9');
    expect(status()).toBe('3D viewer failed to load (Failed to fetch dynamically imported module); showing the server preview.');
    expect(retry().hidden).toBe(false);
    expect(el.querySelector('a.btn')!.getAttribute('href')).toBe('/api/model/rifle/glb?snap=s9&download=1');

    load.mockResolvedValueOnce(noGl);
    retry().click();
    expect(resetThree).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(status()).toBe('WebGL unavailable (no gl); showing the server preview.'));
    expect(load).toHaveBeenCalledTimes(2);
    expect(retry().hidden).toBe(true);
    expect(el.querySelectorAll('img.fallback').length).toBe(1);
  });

  it('exported .glb: export-file URL, no thumbnail', async () => {
    load.mockResolvedValue(noGl);
    await mount({ kind: 'export', name: 'out/rifle.glb' });
    expect(el.querySelector('a.btn')!.getAttribute('href')).toBe('/api/export-file?path=out%2Frifle.glb&download=1');
    expect(el.querySelector('img.fallback')).toBeNull();
    expect(status()).toBe('WebGL unavailable (no gl).');
    expect(calls.some((c) => c.url.includes('/info'))).toBe(false);
  });

  it('a channel that needs the v2 GLB changes the request on reload', async () => {
    load.mockResolvedValue(noGl);
    await mount({ kind: 'model', name: 'rifle' });
    const sel = el.querySelector('select')!;
    sel.value = 'lightmap';
    await viewer.update({ target: { kind: 'model', name: 'other' }, env });
    expect(el.querySelector('a.btn')!.getAttribute('href')).toBe('/api/model/other/glb?profile=three&bake=1&download=1');
  });

  it('keys: W toggles wireframe, unknown keys are not handled', async () => {
    load.mockResolvedValue(noGl);
    await mount({ kind: 'model', name: 'rifle' });
    const wire = el.querySelector<HTMLInputElement>('label.toggle input')!;
    expect(viewer.onKey(new KeyboardEvent('keydown', { key: 'w' }), 'w')).toBe(true);
    expect(wire.checked).toBe(true);
    expect(viewer.onKey(new KeyboardEvent('keydown', { key: '0' }), '0')).toBe(true);
    expect(viewer.onKey(new KeyboardEvent('keydown', { key: 'ArrowLeft' }), 'ArrowLeft')).toBe(false);   // canvas not focused
    expect(viewer.onKey(new KeyboardEvent('keydown', { key: 'q' }), 'q')).toBe(false);
  });

  it('reloads 200 ms after a model event or a change to one of its texture canvases; ignores others', async () => {
    load.mockResolvedValue(noGl);
    await mount({ kind: 'model', name: 'rifle' });
    const infos = () => calls.filter((c) => c.url.startsWith('/api/model/rifle/info')).length;
    expect(infos()).toBe(1);
    viewer.onEvent({ type: 'model', model: 'other', ts: 1 });
    viewer.onEvent({ type: 'model', model: 'rifle', deleted: true, ts: 1 });
    viewer.onEvent({ type: 'change', canvas: 'unrelated', ts: 1 });
    await new Promise((r) => setTimeout(r, 260));
    expect(infos()).toBe(1);
    viewer.onEvent({ type: 'model', model: 'rifle', ts: 1 });
    viewer.onEvent({ type: 'change', canvas: 'rifle_tex', ts: 2 });   // debounced into the same reload
    await vi.waitFor(() => expect(infos()).toBe(2), { timeout: 1000 });
    await new Promise((r) => setTimeout(r, 260));
    expect(infos()).toBe(2);
  });

  it('destroy is idempotent and safe during a pending load', async () => {
    let resolve!: (b: ThreeBundle) => void;
    load.mockReturnValue(new Promise((r) => { resolve = r; }));
    viewer = new ModelViewer(host);
    el = document.createElement('div');
    const p = viewer.mount(el, { target: { kind: 'model', name: 'rifle' }, env });
    viewer.destroy();
    viewer.destroy();
    resolve(noGl);
    await p;
    expect(el.children.length).toBe(0);
  });
});
