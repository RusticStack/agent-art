// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CanvasInfo } from '@/lib/api/types';
import { fakeBitmap, installCanvasStub, sizeElement } from '@/test/canvasStub';
import { fakeFetch } from '@/test/fakes';
import type { ViewerEnv, ViewerHostApi } from '../types';
import { SheetViewer, sheetFiles } from './SheetViewer';

const env: ViewerEnv = { tool: 'pencil', color: { hex: '#000000', hex8: '#000000ff' }, reviewMode: false, following: true, reviewsRev: 0, assetsRev: 0, compareLink: false, compareOverlay: 'off', peerRev: 0 };
const host = {
  slot: 'A', readOnly: false, assets: () => null, isHidden: () => false, reviewMarks: () => [], open: () => {}, openNode: () => {}, inspectNode: () => {},
  requestReview: () => {}, setTool: () => {}, setColor: () => {}, canvasInfoChanged: () => {}, toast: () => {},
  peerViewer: () => null, notifyPeer: () => {}, compareStatus: () => {}, setCompareOverlay: () => {},
} satisfies ViewerHostApi;

const info: CanvasInfo = {
  name: 'spark', width: 16, height: 64, frames: 4, frameHeight: 16, activeLayer: 0, layers: [], undo: 0, redo: 0, version: 1,
  animations: { spin: { frames: [0, 1, 2, 3], durations: [100, 100, 100, 100] } },
  meta: { anchors: { spin: [{ tip: [8, 1, 45] }] } },
};

describe('SheetViewer', () => {
  beforeEach(() => {
    installCanvasStub();
    vi.stubGlobal('createImageBitmap', async () => fakeBitmap(16, 64));
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); document.body.replaceChildren(); });

  it('canvas mode: status, legend, aria-label, scale clamp to auto 1..8', async () => {
    const f = fakeFetch({ '/api/canvas/spark/png': { bytes: new Uint8Array([1]) }, '/api/canvas/spark': { json: info } });
    const v = new SheetViewer(host);
    const el = document.createElement('div');
    document.body.append(el);
    await v.mount(el, { target: { kind: 'canvas', name: 'spark', view: 'sheet' }, env });
    expect(el.querySelector('.viewer.sheet-viewer')).not.toBeNull();
    expect(el.querySelector('.vstatus')!.textContent).toBe('spark · 1 row(s) · 4 cells · anchors: spin');
    expect([...el.querySelectorAll('.legend-item')].map((x) => x.textContent)).toEqual(['tip']);
    const c = el.querySelector<HTMLCanvasElement>('canvas.sheet-canvas')!;
    expect(c.getAttribute('aria-label')).toBe('spark sprite sheet, 4 frames at 1×');
    // anchors off -> empty legend
    const anchors = el.querySelector<HTMLInputElement>('label.toggle input')!;
    anchors.checked = false; anchors.dispatchEvent(new Event('change'));
    expect(el.querySelectorAll('.legend-item').length).toBe(0);
    // live: change -> reload after 150 ms
    vi.useFakeTimers();
    const n = f.calls.length;
    v.onEvent({ type: 'change', canvas: 'spark', ts: 1 } as never);
    await vi.advanceTimersByTimeAsync(149);
    expect(f.calls.length).toBe(n);
    await vi.advanceTimersByTimeAsync(5);
    expect(f.calls.length).toBe(n + 2);
    v.destroy();
    v.destroy();
    expect(el.children.length).toBe(0);
  });

  it('auto scale follows the width; a user scale sticks', async () => {
    fakeFetch({ '/api/canvas/spark/png': { bytes: new Uint8Array([1]) }, '/api/canvas/spark': { json: info } });
    const v = new SheetViewer(host);
    const el = document.createElement('div');
    document.body.append(el);
    await v.mount(el, { target: { kind: 'canvas', name: 'spark', view: 'sheet' }, env });
    sizeElement(el.querySelector('.sheet-scroll')!, 440, 300);
    v.draw();
    expect((v.debugInfo() as { scale: number }).scale).toBe(5);   // (440-40) / (4 * 20)
    const r = el.querySelector<HTMLInputElement>('input[type=range]')!;
    expect(r.value).toBe('5');
    r.value = '2'; r.dispatchEvent(new Event('input'));
    sizeElement(el.querySelector('.sheet-scroll')!, 1000, 300);
    v.draw();
    expect((v.debugInfo() as { scale: number }).scale).toBe(2);
    v.destroy();
  });

  it('export mode (embedded via mountInto): png + json sidecar', async () => {
    const json = { frames: { a_spin_0: { frame: { x: 0, y: 0, w: 16, h: 16 }, duration: 100 }, a_spin_1: { frame: { x: 0, y: 16, w: 16, h: 16 }, duration: 100 } }, meta: { frameTags: [{ name: 'spin' }] } };
    const f = fakeFetch({ '/api/export-file?path=sheets%2Fa.png': { bytes: new Uint8Array([1]) }, '/api/export-file?path=sheets%2Fa.json': { json } });
    expect(sheetFiles('sheets/a.json')).toEqual({ png: 'sheets/a.png', json: 'sheets/a.json' });
    const v = new SheetViewer(host);
    const el = document.createElement('div');
    await v.mountInto(el, { kind: 'export', name: 'sheets/a.json' });
    expect(el.querySelector('.vstatus')!.textContent).toBe('sheets/a.png · 16×64 · 2 frames · 1 tags');
    // export mode ignores change events
    vi.useFakeTimers();
    const n = f.calls.length;
    v.onEvent({ type: 'change', canvas: 'a', ts: 1 } as never);
    v.onEvent({ type: 'resync', ts: 1 } as never);
    await vi.advanceTimersByTimeAsync(500);
    expect(f.calls.length).toBe(n);
    v.destroy();
  });

  it('export mode without a sidecar: one cell; a failed load shows the error and rejects', async () => {
    fakeFetch({ '/api/export-file?path=b.png': { bytes: new Uint8Array([1]) } });
    const v = new SheetViewer(host);
    const el = document.createElement('div');
    await v.mount(el, { target: { kind: 'export', name: 'b.png' }, env });
    expect(el.querySelector('.vstatus')!.textContent).toBe('b.png · 16×64 · no json sidecar');
    v.destroy();
    fakeFetch({});
    const w = new SheetViewer(host);
    const el2 = document.createElement('div');
    await expect(w.mount(el2, { target: { kind: 'canvas', name: 'gone', view: 'sheet' }, env })).rejects.toThrow();
    expect(el2.querySelector('.vstatus')!.textContent).toMatch(/^gone · /);
    w.destroy();
  });
});
