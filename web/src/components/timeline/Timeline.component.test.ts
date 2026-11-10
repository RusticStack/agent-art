// @vitest-environment jsdom
// virtua hides rows it has not measured yet (jsdom never lays out, so they have no accessible name): rows of the full list are queried by selector.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { flushSync, tick } from 'svelte';
import type { ActivityEntry, OpEntry, ToolEntry } from '@/lib/api/types';
import { activity } from '@/state/activity.svelte';
import { workspace } from '@/state/workspace.svelte';
import type { Target } from '@/viewers/types';
import Timeline from './Timeline.svelte';
import TimelineEntry from './TimelineEntry.svelte';

const tool = (p: Partial<ToolEntry> = {}): ToolEntry => ({ id: 1, type: 'tool', call: 'c1', tool: 'art_draw', source: 'agent', ts: Date.UTC(2026, 0, 1, 12), args: {}, assets: [], ops: [], ok: true, ms: 12, ...p });
const op = (p: Partial<OpEntry> = {}): OpEntry => ({ id: 2, type: 'op', op: 'draw', call: 'c1', source: 'agent', ts: Date.UTC(2026, 0, 1, 12), args: {}, assets: [], ok: true, ms: 3, ...p });

// jsdom has no layout: report a 400 px viewport so virtua renders a window of rows.
class SizedResizeObserver {
  constructor(private cb: ResizeObserverCallback) {}
  observe(target: Element): void {
    const contentRect = { width: 300, height: 400 } as DOMRectReadOnly;
    queueMicrotask(() => this.cb([{ target, contentRect } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver));
  }
  unobserve(): void {}
  disconnect(): void {}
}

const settle = async () => {
  await new Promise((r) => setTimeout(r, 40)); // activity bumps its version on the next frame
  flushSync();
  await tick();
  await new Promise((r) => setTimeout(r, 0));
  flushSync();
};

afterEach(() => { cleanup(); });

describe('TimelineEntry', () => {
  it('before / after renders two images and a compare button; buttons call back', async () => {
    const e = tool({ args: { canvas: 'spark', commands: 'px 0 0 #fff' }, assets: [{ kind: 'canvas', name: 'spark', before: 'b1', after: 'a1' }] });
    const onopen = vi.fn(), oncompare = vi.fn(), ontoggle = vi.fn();
    const { container } = render(TimelineEntry, { props: { entry: e, ops: [], expanded: false, dimmed: false, onopen, oncompare, ontoggle } });
    const entry = container.querySelector('.tl-entry')!;
    expect(entry.classList.contains('ok')).toBe(true);
    expect(entry.textContent).toContain('canvas=spark  px 0 0 #fff');
    const imgs = [...container.querySelectorAll<HTMLImageElement>('.tl-pair img')];
    expect(imgs.map((i) => i.getAttribute('src'))).toEqual(['/api/snapshot/b1.png', '/api/snapshot/a1.png']);
    expect(container.querySelector('.tl-pair')!.getAttribute('title')).toBe('canvas spark');

    await fireEvent.click(screen.getByRole('button', { name: 'Compare before / after' }));
    expect(oncompare).toHaveBeenCalledOnce();
    expect(onopen).not.toHaveBeenCalled();

    await fireEvent.click(imgs[0]);
    expect(onopen).toHaveBeenLastCalledWith({ pairName: 'spark', imageIndex: 0 });
    await fireEvent.click(imgs[1]);
    expect(onopen).toHaveBeenLastCalledWith({ pairName: 'spark', imageIndex: 1 });
    await fireEvent.click(container.querySelector('.tl-line')!);
    expect(onopen).toHaveBeenLastCalledWith({});
    await fireEvent.click(container.querySelector('.tl-open')!);
    expect(onopen).toHaveBeenLastCalledWith({});
    expect(onopen).toHaveBeenCalledTimes(4);

    const details = screen.getByRole('button', { name: 'Details' });
    expect(details.getAttribute('aria-expanded')).toBe('false');
    await fireEvent.click(details);
    expect(ontoggle).toHaveBeenCalledOnce();
    expect(onopen).toHaveBeenCalledTimes(4);
  });

  it('an expired snapshot image is hidden', async () => {
    const e = tool({ assets: [{ kind: 'canvas', name: 'spark', after: 'old' }] });
    const { container } = render(TimelineEntry, { props: { entry: e, ops: [], expanded: false, dimmed: false } });
    const img = container.querySelector('.tl-pair img')!;
    await fireEvent.error(img);
    expect(img.classList.contains('gone')).toBe(true);
    expect(container.querySelector('.tl-thumbs')).not.toBeNull();
  });

  it('an error entry shows its error and the red status; no compare without a pair', () => {
    const e = tool({ ok: false, error: 'No canvas "nope"\nsecond line', summary: 'ignored' });
    const { container } = render(TimelineEntry, { props: { entry: e, ops: [], expanded: false, dimmed: true } });
    const entry = container.querySelector('.tl-entry')!;
    expect(entry.classList.contains('err')).toBe(true);
    expect(entry.classList.contains('is-hidden')).toBe(true);
    expect(container.querySelector('.tl-error')!.textContent).toBe('No canvas "nope"\nsecond line');
    expect(container.querySelector('.tl-summary')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Compare before / after' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Details' })).toBeNull();
  });

  it('running: … instead of the duration; user entries tinted; summary line', () => {
    const e = op({ running: true, source: 'user', summary: 'drew 4 px', action: 'add', args: { canvas: 'a', action: 'add' } });
    const { container } = render(TimelineEntry, { props: { entry: e, ops: [], expanded: false, dimmed: false } });
    const entry = container.querySelector('.tl-entry')!;
    expect(entry.classList.contains('running')).toBe(true);
    expect(entry.classList.contains('user')).toBe(true);
    expect(container.querySelector('.tl-ms')!.textContent).toBe('…');
    expect(container.querySelector('.tl-action')!.textContent).toBe('add');
    expect(container.querySelector('.tl-args')!.textContent).toBe('canvas=a');
    expect(container.querySelector('.tl-summary')!.textContent).toBe('drew 4 px');
  });
});

describe('Timeline', () => {
  let saved: typeof ResizeObserver;
  const opened: Target[] = [];
  beforeEach(() => {
    saved = window.ResizeObserver;
    window.ResizeObserver = SizedResizeObserver;
    activity.reset();
    activity.setFilter({ tool: '', errors: false, current: false, agent: false });
    activity.search = '';
    opened.length = 0;
    workspace.navigator = (t) => { opened.push(t); };
  });
  afterEach(() => { window.ResizeObserver = saved; workspace.navigator = null; activity.reset(); });

  const seed: ActivityEntry[] = [
    tool({ id: 1, call: 'c1', args: { canvas: 'spark', commands: 'px 0 0 #fff' }, ops: [2], summary: 'drew 1 px', assets: [{ kind: 'canvas', name: 'spark', before: 'b1', after: 'a1' }] }),
    op({ id: 2, call: 'c1', op: 'draw', args: { canvas: 'spark' }, summary: 'child op summary' }),
    tool({ id: 3, call: 'c2', ok: false, error: 'No canvas "nope"', args: { canvas: 'nope' } }),
    op({ id: 4, call: undefined, op: 'layer', source: 'user', args: { canvas: 'helmet', action: 'select' } }),
  ];

  it('counter, newest first, expand shows the args JSON and the child ops', async () => {
    const { container } = render(Timeline, { props: {} });
    expect(container.textContent).toContain('Waiting for the agent… every tool call shows up here.');
    activity.load(seed);
    await settle();
    expect(container.querySelector('.pane-head .mono')!.textContent).toBe('3/3 · 1 err');
    const rows = [...container.querySelectorAll<HTMLElement>('.tl-entry')];
    expect(rows.map((r) => r.dataset.id)).toEqual(['4', '3', '1']);

    const first = rows.find((r) => r.dataset.id === '1')!;
    expect(first.querySelector('.tl-details')).toBeNull();
    await fireEvent.click(first.querySelector('[data-act="expand"]')!);
    flushSync();
    const det = container.querySelector<HTMLElement>('.tl-entry[data-id="1"] .tl-details')!;
    expect(det).not.toBeNull();
    const pre = det.querySelector('pre.json')!;
    expect(pre.textContent).toBe(JSON.stringify(seed[0].args, null, 1));
    expect(pre.querySelector('span')).not.toBeNull(); // syntax-coloured tokens
    const ops = [...det.querySelectorAll<HTMLElement>('.tl-op')];
    expect(ops.map((o) => o.dataset.id)).toEqual(['2']);
    expect(ops[0].textContent).toContain('draw');
    expect(ops[0].textContent).toContain('canvas=spark');
    expect(ops[0].textContent).toContain('child op summary');
    expect(container.querySelector('.tl-entry[data-id="1"] [data-act="expand"]')!.getAttribute('aria-expanded')).toBe('true');
  });

  it('Errors chip filters; search; no-match text; row click and compare navigate', async () => {
    const { container } = render(Timeline, { props: {} });
    activity.load(seed);
    await settle();
    await fireEvent.click(screen.getByRole('button', { name: 'Errors' }));
    await settle();
    expect([...container.querySelectorAll<HTMLElement>('.tl-entry')].map((r) => r.dataset.id)).toEqual(['3']);
    expect(container.querySelector('.pane-head .mono')!.textContent).toBe('1/3 · 1 err');
    await fireEvent.click(screen.getByRole('button', { name: 'Errors' }));

    const search = container.querySelector<HTMLInputElement>('input.search')!;
    await fireEvent.input(search, { target: { value: 'helmet' } });
    await new Promise((r) => setTimeout(r, 120)); // 80 ms debounce
    await settle();
    expect([...container.querySelectorAll<HTMLElement>('.tl-entry')].map((r) => r.dataset.id)).toEqual(['4']);
    await fireEvent.input(search, { target: { value: 'zzz' } });
    await new Promise((r) => setTimeout(r, 120));
    await settle();
    expect(container.textContent).toContain('No entries match the filters.');
    await fireEvent.input(search, { target: { value: '' } });
    await new Promise((r) => setTimeout(r, 120));
    await settle();

    await fireEvent.click(container.querySelector('.tl-entry[data-id="1"] .tl-line')!);
    expect(opened).toEqual([{ kind: 'canvas', name: 'spark', snap: 'a1', label: '#1' }]);
    await fireEvent.click(container.querySelector('.tl-entry[data-id="1"] [data-act="compare"]')!);
    expect(opened.slice(1)).toEqual([{ kind: 'canvas', name: 'spark', snap: 'b1', label: 'before' }, { kind: 'canvas', name: 'spark', snap: 'a1', label: 'after' }]);
  });

  it('dock button calls ontoggleDock', async () => {
    const ontoggleDock = vi.fn();
    const { container } = render(Timeline, { props: { ontoggleDock } });
    await fireEvent.click(container.querySelector('.pane-head button')!);
    expect(ontoggleDock).toHaveBeenCalledOnce();
  });
});
