// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { flushSync } from 'svelte';
import type { CanvasInfo, GraphNodeInfo } from '@/lib/api/types';
import { signals } from '@/state/live.svelte';
import { reviews } from '@/state/reviews.svelte';
import { workspace } from '@/state/workspace.svelte';
import Inspector from './Inspector.svelte';
import PreviewCanvas from './PreviewCanvas.svelte';
import { inspectKey } from './load';

const m = vi.hoisted(() => ({
  op: vi.fn(),
  api: { canvas: vi.fn(), project: vi.fn(), snapshot: vi.fn(), graphNode: vi.fn(), modelInfo: vi.fn(), rig: vi.fn(), audio: vi.fn() },
}));
vi.mock('@/lib/api/client', () => ({ op: m.op, api: m.api }));

const canvas = (name: string, over: Partial<CanvasInfo> = {}): CanvasInfo => ({
  name, width: 8, height: 8, frames: 1, frameHeight: null, activeLayer: 0, layers: [{ index: 0, name: 'base', visible: true, opacity: 1 }],
  animations: {}, project: null, undo: 0, redo: 0, version: 1, ...over,
});
const node = (id: string, over: Partial<GraphNodeInfo> = {}): GraphNodeInfo => ({ id, exists: true, tags: [], out: [], in: [], text: '', ...over });
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); flushSync(); };

beforeEach(() => {
  for (const f of Object.values(m.api)) f.mockReset();
  m.op.mockReset(); m.op.mockResolvedValue({});
  m.api.graphNode.mockImplementation(async (id: string) => node(id));
  reviews.list = []; reviews.approved = new Set();
});
afterEach(() => { cleanup(); workspace.inspected = null; workspace.navigator = null; });

describe('inspectKey', () => {
  it('(id, snap, tick); null for nothing and the graph', () => {
    expect(inspectKey(null, 0)).toBeNull();
    expect(inspectKey({ kind: 'graph' }, 3)).toBeNull();
    expect(inspectKey({ kind: 'canvas', name: 'a', view: 'anim' }, 2)).toBe('canvas:a||2');
    expect(inspectKey({ kind: 'canvas', name: 'a', snap: 's1' }, 2)).toBe('canvas:a|s1|2');
  });
});

describe('Inspector', () => {
  it('I1 texts', async () => {
    render(Inspector);
    expect(screen.getByText('Nothing open.')).toBeTruthy();
    flushSync(() => { workspace.inspected = { kind: 'graph' }; });
    expect(screen.getByText('Select a node in the graph to see its relations.')).toBeTruthy();
    expect(m.api.graphNode).not.toHaveBeenCalled();
  });

  it('a canvas: title, sections, reviews and relations; a relation link opens the node', async () => {
    m.api.canvas.mockResolvedValue(canvas('pauldron', { project: 'armor' }));
    m.api.project.mockResolvedValue({ name: 'armor', description: 'Armour set', canvases: [] });
    m.api.graphNode.mockResolvedValue(node('canvas:pauldron', { tags: ['metal'], out: [{ from: 'canvas:pauldron', rel: 'variant_of', to: 'canvas:helmet_front' }] }));
    reviews.list = [{ id: 'r1', asset: 'canvas:pauldron', target: {}, category: 'fix', priority: 'normal', note: 'x', status: 'open', by: 'user', created: 1, updated: 1, history: [] }];
    const onopennode = vi.fn();
    const { container } = render(Inspector, { props: { onopennode } });
    flushSync(() => { workspace.inspected = { kind: 'canvas', name: 'pauldron' }; });
    await flush();
    expect(container.querySelector('.insp-title .name')!.textContent).toBe('pauldron');
    const labels = [...container.querySelectorAll('.insp-sec .panel-label')].map((e) => e.textContent);
    expect(labels).toEqual(['Preview', 'Canvas', 'Layers', 'Palette', 'Project armor', 'Review notes (1 open)', 'Relations']);
    expect(container.querySelectorAll('.review-card')).toHaveLength(1);
    expect(screen.getByText('#metal')).toBeTruthy();
    await fireEvent.click(screen.getByRole('link', { name: 'canvas:helmet_front' }));
    expect(onopennode).toHaveBeenCalledWith('canvas:helmet_front');
  });

  it('keeps the previous content while the next target loads; a late response never wins', async () => {
    let releaseA!: (v: CanvasInfo) => void;
    m.api.canvas.mockImplementation((name: string) => (name === 'a' ? new Promise<CanvasInfo>((r) => { releaseA = r; }) : Promise.resolve(canvas(name))));
    const { container } = render(Inspector);
    flushSync(() => { workspace.inspected = { kind: 'canvas', name: 'b' }; });
    await flush();
    expect(container.querySelector('.insp-title .name')!.textContent).toBe('b');
    flushSync(() => { workspace.inspected = { kind: 'canvas', name: 'a' }; });
    await flush();
    expect(container.querySelector('.insp-title .name')!.textContent).toBe('b');
    expect(container.querySelector('.insp-body')!.classList.contains('stale')).toBe(true);
    expect(container.querySelector('.insp-body')!.getAttribute('aria-busy')).toBe('true');
    flushSync(() => { workspace.inspected = { kind: 'canvas', name: 'c' }; });
    await flush();
    expect(container.querySelector('.insp-title .name')!.textContent).toBe('c');
    releaseA(canvas('a'));
    await flush();
    expect(container.querySelector('.insp-title .name')!.textContent).toBe('c');
  });

  it('inspectorTick refetches; a failing section keeps reviews and relations (I14)', async () => {
    m.api.modelInfo.mockRejectedValueOnce(new Error('model not found'));
    const { container } = render(Inspector);
    flushSync(() => { workspace.inspected = { kind: 'model', name: 'rifle' }; });
    await flush();
    expect(container.querySelector('.insp-body .error')!.textContent).toBe('model not found');
    expect([...container.querySelectorAll('.panel-label')].map((e) => e.textContent)).toEqual(['Review notes (0 open)', 'Relations']);
    m.api.modelInfo.mockResolvedValueOnce({ triangles: 12, warnings: ['thin wall'] });
    flushSync(() => { signals.inspectorTick++; });
    await flush();
    expect(m.api.modelInfo).toHaveBeenCalledTimes(2);
    expect(container.querySelector('.insp-body .error')).toBeNull();
    expect(screen.getByText('thin wall')).toBeTruthy();
  });

  it('snapshot section with Open live; actions call the callbacks / ops', async () => {
    m.api.snapshot.mockResolvedValue({ id: 's1', kind: 'canvas', name: 'a', bytes: 1, hasDef: true, width: 8, height: 4, frames: 2, version: 5 });
    const onopen = vi.fn(), ontogglepinned = vi.fn(), ontogglehidden = vi.fn(), onnote = vi.fn();
    const { container } = render(Inspector, { props: { onopen, ontogglepinned, ontogglehidden, onnote } });
    flushSync(() => { workspace.inspected = { kind: 'canvas', name: 'a', snap: 's1', label: 'before' }; });
    await flush();
    expect(container.querySelector('.insp-title .badge')!.textContent).toBe('snapshot before');
    expect(screen.getByRole('region', { name: 'Snapshot' }).textContent).toContain('8×4');
    await fireEvent.click(screen.getByRole('button', { name: 'Open live' }));
    expect(onopen).toHaveBeenCalledWith({ kind: 'canvas', name: 'a' });
    await fireEvent.click(screen.getByRole('button', { name: 'Pin' }));
    expect(ontogglepinned).toHaveBeenCalledWith('canvas:a');
    await fireEvent.click(screen.getByRole('button', { name: 'Visible' }));
    expect(ontogglehidden).toHaveBeenCalledWith('canvas:a');
    await fireEvent.click(screen.getByRole('button', { name: 'Note' }));
    expect(onnote).toHaveBeenCalledWith({ asset: 'canvas:a' });
    await fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(m.op).toHaveBeenCalledWith('review_approve', { asset: 'canvas:a', approved: true });
  });
});

describe('PreviewCanvas timer', () => {
  it('clears its timer chain when the canvas changes and on destroy', async () => {
    vi.useFakeTimers();
    const proto = HTMLImageElement.prototype as { decode?: () => Promise<void> };
    const hadDecode = 'decode' in proto;
    const oldDecode = proto.decode;
    Object.defineProperty(proto, 'decode', { configurable: true, writable: true, value: () => Promise.resolve() });
    const nw = vi.spyOn(HTMLImageElement.prototype, 'naturalWidth', 'get').mockReturnValue(8);
    const nh = vi.spyOn(HTMLImageElement.prototype, 'naturalHeight', 'get').mockReturnValue(32);
    const ctx = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    try {
      const anim = (version: number): CanvasInfo => canvas('a', { frames: 4, frameHeight: 8, version, animations: { walk: { frames: [0, 1, 2, 3], durations: [100, 100, 100, 100] } } });
      const { rerender, unmount } = render(PreviewCanvas, { props: { info: anim(1) } });
      await flush();
      expect(vi.getTimerCount()).toBe(1);
      await rerender({ info: anim(2) });
      await flush();
      expect(vi.getTimerCount()).toBe(1);
      vi.advanceTimersByTime(100);
      expect(vi.getTimerCount()).toBe(1);
      unmount();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      if (hadDecode) proto.decode = oldDecode; else delete proto.decode;
      nw.mockRestore(); nh.mockRestore(); ctx.mockRestore();
      vi.useRealTimers();
    }
  });
});
