// @vitest-environment jsdom
// Compare tools (RV7, step 18c): the pure overlay plan / cycle / status, and the CanvasViewer wiring
// (link echo guard, overlay in slot A, no work while compare is closed).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CanvasInfo } from '@/lib/api/types';
import { fakeBitmap, installCanvasStub } from '@/test/canvasStub';
import { fakeFetch } from '@/test/fakes';
import type { CompareImage, CompareOverlay, SlotId, Viewer, ViewerEnv, ViewerHostApi } from '../types';
import { CanvasViewer } from './CanvasViewer';
import { compareToolsShown, diffStatus, modeHint, nextOverlay, overlayPlan, SIZE_MISMATCH } from './compare';

const rect = (w: number, h: number, y = 0) => ({ x: 0, y, w, h });
const peer = (w: number, h: number): CompareImage => ({ image: fakeBitmap(w, h * 2), rect: rect(w, h, h), key: 'k' });

describe('nextOverlay', () => {
  it('cycles Off → Difference → Swipe → Blink → Off', () => {
    const seen: CompareOverlay[] = ['off'];
    for (let i = 0; i < 4; i++) seen.push(nextOverlay(seen[seen.length - 1]));
    expect(seen).toEqual(['off', 'diff', 'swipe', 'blink', 'off']);
  });
});

describe('overlayPlan', () => {
  it('off or no peer: nothing, no status', () => {
    expect(overlayPlan('off', rect(16, 16), peer(16, 16))).toEqual({ overlay: null, status: null });
    expect(overlayPlan('diff', rect(16, 16), null)).toEqual({ overlay: null, status: null });
    expect(overlayPlan('diff', null, peer(16, 16))).toEqual({ overlay: null, status: null });
  });
  it('different sizes: no overlay, the status says why', () => {
    expect(overlayPlan('swipe', rect(16, 16), peer(16, 8))).toEqual({ overlay: null, status: SIZE_MISMATCH });
  });
  it('same size: the peer image and frame rect in that mode; Difference asks for the counts', () => {
    const p = peer(16, 16);
    expect(overlayPlan('diff', rect(16, 16), p)).toEqual({ overlay: { image: p.image, rect: p.rect, mode: 'diff' }, status: 'diff' });
    expect(overlayPlan('blink', rect(16, 16), p)).toEqual({ overlay: { image: p.image, rect: p.rect, mode: 'blink' }, status: null });
  });
});

describe('status texts', () => {
  it('diffStatus', () => {
    expect(diffStatus(null)).toBeNull();
    expect(diffStatus({ changed: 0, total: 256, bbox: null })).toBe('identical');
    expect(diffStatus({ changed: 1, total: 256, bbox: { x: 3, y: 4, w: 1, h: 1 } })).toBe('1 px differ (0.4%) · bbox 3,4 1×1');
    expect(diffStatus({ changed: 1234, total: 40000, bbox: { x: 0, y: 0, w: 200, h: 200 } })).toMatch(/^1 234 px differ \(3\.1%\)/);
    expect(diffStatus({ changed: 0, total: 1, bbox: null, tooLarge: true })).toMatch(/16 megapixels/);
  });
  it('modeHint', () => {
    expect(modeHint('blink', true)).toMatch(/press X to swap/);
    expect(modeHint('swipe', false)).toMatch(/drag the bar/);
    expect(modeHint('diff', false)).toBeNull();
  });
  it('compare tools only for two canvas viewers (live or snapshot)', () => {
    expect(compareToolsShown({ kind: 'canvas', name: 'a' }, { kind: 'canvas', name: 'b', snap: 's1' })).toBe(true);
    expect(compareToolsShown({ kind: 'canvas', name: 'a', view: 'anim' }, { kind: 'canvas', name: 'b' })).toBe(false);
    expect(compareToolsShown({ kind: 'canvas', name: 'a' }, { kind: 'model', name: 'm' })).toBe(false);
    expect(compareToolsShown({ kind: 'canvas', name: 'a' }, null)).toBe(false);
  });
});

// ---- CanvasViewer wiring ----

const env = (o: Partial<ViewerEnv> = {}): ViewerEnv => ({ tool: 'pencil', color: { hex: '#000000', hex8: '#000000ff' }, reviewMode: false, following: false, reviewsRev: 0, assetsRev: 0, compareLink: false, compareOverlay: 'off', peerRev: 0, ...o });
const info = (name: string, w = 16, h = 16): CanvasInfo => ({ name, width: w, height: h, frames: 2, frameHeight: h, activeLayer: 0, layers: [], animations: {}, meta: {}, undo: 0, redo: 0, version: 1 });

interface Pair { viewers: Record<SlotId, CanvasViewer>; hosts: Record<SlotId, ViewerHostApi & { statuses: (string | null)[] }>; peers: { on: boolean } }

async function pair(sizeB = 16): Promise<Pair> {
  fakeFetch({
    '/api/canvas/a/png': { bytes: new Uint8Array([1]) }, '/api/canvas/a': { json: info('a') },
    '/api/canvas/b/png': { bytes: new Uint8Array([2]) }, '/api/canvas/b': { json: info('b', 16, sizeB) },
  });
  let n = 0;
  vi.stubGlobal('createImageBitmap', async () => (n++ === 0 ? fakeBitmap(16, 32) : fakeBitmap(16, sizeB * 2)));
  const peers = { on: true };
  const viewers = {} as Record<SlotId, CanvasViewer>;
  const hosts = {} as Pair['hosts'];
  for (const slot of ['A', 'B'] as SlotId[]) {
    const statuses: (string | null)[] = [];
    hosts[slot] = {
      slot, readOnly: slot === 'B', statuses,
      assets: () => null, isHidden: () => false, reviewMarks: () => [], open: () => {}, openNode: () => {}, inspectNode: () => {},
      requestReview: () => {}, setTool: () => {}, setColor: () => {}, canvasInfoChanged: () => {}, toast: () => {},
      peerViewer: (): Viewer | null => (peers.on ? viewers[slot === 'A' ? 'B' : 'A'] : null),
      notifyPeer: vi.fn(), compareStatus: (t) => { statuses.push(t); }, setCompareOverlay: vi.fn(),
    };
    viewers[slot] = new CanvasViewer(hosts[slot]);
  }
  for (const slot of ['A', 'B'] as SlotId[]) {
    const el = document.createElement('div');
    el.dataset.slot = slot;
    document.body.append(el);
    await viewers[slot].mount(el, { target: { kind: 'canvas', name: slot === 'A' ? 'a' : 'b' }, env: env({ compareLink: true }) });
  }
  return { viewers, hosts, peers };
}
const dbg = (v: CanvasViewer) => v.debugInfo() as { zoom: number; frame: number; overlay: string | null };
const key = (k: string) => new KeyboardEvent('keydown', { key: k });

describe('CanvasViewer compare wiring', () => {
  beforeEach(() => { installCanvasStub(); localStorage.clear(); });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

  it('a zoom or frame change in one slot is mirrored to the other; applying it does not echo back', async () => {
    const { viewers } = await pair();
    const backA = vi.spyOn(viewers.A, 'applyLinkState');
    const toB = vi.spyOn(viewers.B, 'applyLinkState');
    viewers.A.onKey(key('+'), '+');
    expect(toB).toHaveBeenCalledTimes(1);
    expect(dbg(viewers.B).zoom).toBe(dbg(viewers.A).zoom);
    viewers.A.onKey(key('.'), '.');
    expect(dbg(viewers.B).frame).toBe(1);
    expect(backA).not.toHaveBeenCalled(); // B applied the state without sending it back
  });

  it('Link off: nothing is mirrored', async () => {
    const { viewers } = await pair();
    await viewers.A.update({ target: { kind: 'canvas', name: 'a' }, env: env({ compareLink: false }) });
    const toB = vi.spyOn(viewers.B, 'applyLinkState');
    viewers.A.onKey(key('+'), '+');
    expect(toB).not.toHaveBeenCalled();
  });

  it('slot A draws slot B over itself in the chosen mode and reports a status; Off clears both', async () => {
    const { viewers, hosts } = await pair();
    await viewers.A.update({ target: { kind: 'canvas', name: 'a' }, env: env({ compareLink: true, compareOverlay: 'diff', peerRev: 1 }) });
    expect(dbg(viewers.A).overlay).toBe('diff');
    expect(hosts.A.statuses.at(-1)).toEqual(expect.any(String));
    expect(document.querySelector('[data-slot=A] [role=radiogroup]')!.getAttribute('title')).toBe('Editing is paused while an overlay is shown');
    await viewers.A.update({ target: { kind: 'canvas', name: 'a' }, env: env({ compareLink: true, compareOverlay: 'off', peerRev: 1 }) });
    expect(dbg(viewers.A).overlay).toBeNull();
    expect(hosts.A.statuses.at(-1)).toBeNull();
    expect(document.querySelector('[data-slot=A] [role=radiogroup]')!.hasAttribute('title')).toBe(false);
  });

  it('different sizes: no overlay, the status explains', async () => {
    const { viewers, hosts } = await pair(8);
    await viewers.A.update({ target: { kind: 'canvas', name: 'a' }, env: env({ compareLink: true, compareOverlay: 'swipe', peerRev: 1 }) });
    expect(dbg(viewers.A).overlay).toBeNull();
    expect(hosts.A.statuses.at(-1)).toBe(SIZE_MISMATCH);
  });

  it('D cycles the overlay through the host only when the other slot is a canvas too', async () => {
    const { viewers, hosts, peers } = await pair();
    expect(viewers.A.onKey(key('d'), 'd')).toBe(true);
    expect(hosts.A.setCompareOverlay).toHaveBeenCalledWith('diff');
    peers.on = false;
    expect(viewers.A.onKey(key('d'), 'd')).toBe(false);
  });

  it('with compare closed: no overlay, no peer calls, no status', async () => {
    const { viewers, hosts, peers } = await pair();
    peers.on = false;
    const peerCalls = vi.spyOn(hosts.A, 'peerViewer');
    await viewers.A.update({ target: { kind: 'canvas', name: 'a' }, env: env({ compareLink: false, compareOverlay: 'off' }) });
    viewers.A.onKey(key('+'), '+');
    viewers.A.onKey(key('.'), '.');
    expect(viewers.A.overlayInfo).toBeNull();
    expect(peerCalls).not.toHaveBeenCalled();
    expect(hosts.A.statuses).toEqual([]);
  });
});
