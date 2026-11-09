// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { createRawSnippet, flushSync, tick } from 'svelte';
import Button from './Button.svelte';
import Icon from './Icon.svelte';
import Tabs from './Tabs.svelte';
import Splitter from './Splitter.svelte';
import Toasts from './Toasts.svelte';
import JsonView from './JsonView.svelte';
import KV from './KV.svelte';
import { toasts, LIFETIME, FADE_MS } from '@/state/toasts.svelte';
import DialogHarness from '@/test/harness/DialogHarness.svelte';
import VirtualListHarness from '@/test/harness/VirtualListHarness.svelte';
import type { ScrollToIndexFn } from './VirtualList.svelte';

const text = (t: string) => createRawSnippet(() => ({ render: () => `<span>${t}</span>` }));

afterEach(() => { cleanup(); });

describe('Button', () => {
  it('applies the variant and size classes', () => {
    for (const variant of ['primary', 'ok', 'warn', 'danger', 'ghost'] as const) {
      render(Button, { props: { variant, size: 'sm', children: text(variant) } });
      const b = screen.getByRole('button', { name: variant });
      expect(b.classList.contains('btn')).toBe(true);
      expect(b.classList.contains(variant)).toBe(true);
      expect(b.classList.contains('sm')).toBe(true);
    }
  });

  it('aria-pressed only for toggles; .on when active', () => {
    render(Button, { props: { children: text('Plain') } });
    expect(screen.getByRole('button', { name: 'Plain' }).hasAttribute('aria-pressed')).toBe(false);
    render(Button, { props: { active: false, children: text('Off') } });
    expect(screen.getByRole('button', { name: 'Off' }).getAttribute('aria-pressed')).toBe('false');
    render(Button, { props: { active: true, children: text('On') } });
    const on = screen.getByRole('button', { name: 'On' });
    expect(on.getAttribute('aria-pressed')).toBe('true');
    expect(on.classList.contains('on')).toBe(true);
  });

  it('renders a link for href and calls onclick', async () => {
    render(Button, { props: { href: '/x.png', download: 'x.png', children: text('Get') } });
    expect(screen.getByRole('link', { name: 'Get' }).getAttribute('download')).toBe('x.png');
    const onclick = vi.fn();
    render(Button, { props: { onclick, disabled: false, children: text('Go') } });
    await fireEvent.click(screen.getByRole('button', { name: 'Go' }));
    expect(onclick).toHaveBeenCalledOnce();
  });
});

describe('Icon', () => {
  it('renders an aria-hidden svg', () => {
    const { container } = render(Icon, { props: { name: 'x' } });
    const span = container.querySelector('span.icon')!;
    expect(span.getAttribute('aria-hidden')).toBe('true');
    expect(span.querySelector('svg')).not.toBeNull();
  });
});

describe('Tabs', () => {
  const tabs = [{ id: 'edit', label: 'Canvas' }, { id: 'anim', label: 'Animation' }, { id: 'sheet', label: 'Sheet' }];

  it('roving tabindex and aria-selected', () => {
    render(Tabs, { props: { tabs, value: 'anim', onchange: () => {}, label: 'Views' } });
    expect(screen.getByRole('tablist', { name: 'Views' })).toBeTruthy();
    const els = screen.getAllByRole('tab');
    expect(els.map((e) => e.getAttribute('aria-selected'))).toEqual(['false', 'true', 'false']);
    expect(els.map((e) => e.tabIndex)).toEqual([-1, 0, -1]);
  });

  it('arrow keys move (wrapping), Home / End jump', async () => {
    const onchange = vi.fn();
    render(Tabs, { props: { tabs, value: 'edit', onchange, label: 'Views' } });
    const [first] = screen.getAllByRole('tab');
    await fireEvent.keyDown(first, { key: 'ArrowRight' });
    expect(onchange).toHaveBeenLastCalledWith('anim');
    await fireEvent.keyDown(first, { key: 'ArrowLeft' });
    expect(onchange).toHaveBeenLastCalledWith('sheet');
    await fireEvent.keyDown(first, { key: 'End' });
    expect(onchange).toHaveBeenLastCalledWith('sheet');
    onchange.mockClear();
    await fireEvent.keyDown(first, { key: 'Home' });
    expect(onchange).not.toHaveBeenCalled();
    await tick();
    expect(document.activeElement).toBe(first);
  });
});

describe('Splitter', () => {
  const base = { orientation: 'vertical' as const, sign: 1 as const, label: 'Resize assets pane', min: 140, max: 600 };

  it('arrow keys resize by 16 px, Shift by 64 px, along the sign', async () => {
    const onchange = vi.fn(); const oncommit = vi.fn();
    render(Splitter, { props: { ...base, value: 300, onchange, oncommit } });
    const sep = screen.getByRole('separator', { name: 'Resize assets pane' });
    expect(sep.getAttribute('aria-orientation')).toBe('vertical');
    expect([sep.getAttribute('aria-valuenow'), sep.getAttribute('aria-valuemin'), sep.getAttribute('aria-valuemax')]).toEqual(['300', '140', '600']);
    await fireEvent.keyDown(sep, { key: 'ArrowRight' });
    expect(onchange).toHaveBeenLastCalledWith(316);
    expect(oncommit).toHaveBeenLastCalledWith(316);
    await fireEvent.keyDown(sep, { key: 'ArrowLeft', shiftKey: true });
    expect(onchange).toHaveBeenLastCalledWith(236);
    await fireEvent.keyDown(sep, { key: 'ArrowDown' });
    expect(onchange).toHaveBeenCalledTimes(2);
  });

  it('a pane on the other side inverts the keys; values clamp to min / max', async () => {
    const onchange = vi.fn();
    render(Splitter, { props: { ...base, sign: -1, value: 590, onchange } });
    const sep = screen.getByRole('separator');
    await fireEvent.keyDown(sep, { key: 'ArrowLeft', shiftKey: true });
    expect(onchange).toHaveBeenLastCalledWith(600);
    await fireEvent.keyDown(sep, { key: 'ArrowRight', shiftKey: true });
    expect(onchange).toHaveBeenLastCalledWith(526);
    await fireEvent.keyDown(sep, { key: 'Home' });
    expect(onchange).toHaveBeenLastCalledWith(140);
    await fireEvent.keyDown(sep, { key: 'End' });
    expect(onchange).toHaveBeenLastCalledWith(600);
  });

  it('horizontal splitters use Up / Down; double-click resets', async () => {
    const onchange = vi.fn(); const onreset = vi.fn();
    render(Splitter, { props: { ...base, orientation: 'horizontal', min: 100, value: 150, onchange, onreset } });
    const sep = screen.getByRole('separator');
    await fireEvent.keyDown(sep, { key: 'ArrowUp', shiftKey: true });
    expect(onchange).toHaveBeenLastCalledWith(100);
    await fireEvent.dblClick(sep);
    expect(onreset).toHaveBeenCalledOnce();
  });
});

describe('Toasts', () => {
  beforeEach(() => { vi.useFakeTimers(); toasts.reset(); });
  afterEach(() => { toasts.reset(); vi.useRealTimers(); });

  it('shows toasts, errors as role=alert with a dismiss button, and removes them after their lifetime', () => {
    render(Toasts);
    const region = screen.getByRole('status', { name: 'Notifications' });
    flushSync(() => { toasts.push('saved', 'ok'); toasts.push('draw: boom', 'error'); });
    expect(region.querySelectorAll('.toast')).toHaveLength(2);
    expect(screen.getByRole('alert').textContent).toContain('draw: boom');
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeTruthy();
    flushSync(() => vi.advanceTimersByTime(LIFETIME.ok));
    expect(region.querySelector('.toast.ok')!.classList.contains('out')).toBe(true);
    flushSync(() => vi.advanceTimersByTime(FADE_MS));
    expect(region.querySelectorAll('.toast')).toHaveLength(1);
    flushSync(() => vi.advanceTimersByTime(LIFETIME.error));
    expect(region.querySelectorAll('.toast')).toHaveLength(0);
  });

  it('hovering the stack pauses the timers', async () => {
    render(Toasts);
    const region = screen.getByRole('status', { name: 'Notifications' });
    flushSync(() => { toasts.push('hello'); });
    await fireEvent.pointerEnter(region);
    flushSync(() => vi.advanceTimersByTime(60_000));
    expect(region.querySelectorAll('.toast:not(.out)')).toHaveLength(1);
    await fireEvent.pointerLeave(region);
    flushSync(() => vi.advanceTimersByTime(LIFETIME.info + FADE_MS));
    expect(region.querySelectorAll('.toast')).toHaveLength(0);
  });

  it('shows at most 4, the newest, and counts the rest', () => {
    render(Toasts);
    const region = screen.getByRole('status', { name: 'Notifications' });
    flushSync(() => { for (let i = 1; i <= 6; i++) toasts.push(`t${i}`); });
    expect([...region.querySelectorAll('.toast-text')].map((e) => e.textContent)).toEqual(['t3', 't4', 't5', 't6']);
    expect(region.textContent).toContain('+2 earlier');
  });
});

describe('Dialog', () => {
  it('renders the title as its accessible name and calls onclose on Esc', async () => {
    const onclose = vi.fn();
    render(DialogHarness, { props: { onclose } });
    const dlg = await screen.findByRole('dialog', { name: 'Test dialog' });
    expect(dlg.textContent).toContain('Body text');
    expect(screen.getByRole('button', { name: 'Done' })).toBeTruthy();
    await fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    expect(onclose).toHaveBeenCalledOnce();
  });

  it('the close button calls onclose; closeOnEscape=false leaves Esc alone', async () => {
    const onclose = vi.fn();
    render(DialogHarness, { props: { onclose, closeOnEscape: false } });
    await screen.findByRole('dialog', { name: 'Test dialog' });
    await fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(onclose).not.toHaveBeenCalled();
    await fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onclose).toHaveBeenCalledOnce();
  });
});

describe('VirtualList', () => {
  const items = Array.from({ length: 50 }, (_, i) => ({ id: `id${i}`, name: `item ${i}` }));

  // jsdom has no layout: report a 200 px viewport for every observed element, so the library asks for
  // the rows that fit (rows are unmeasured and use the 20 px estimate).
  class SizedResizeObserver {
    constructor(private cb: ResizeObserverCallback) {}
    observe(target: Element): void {
      const contentRect = { width: 300, height: 200 } as DOMRectReadOnly;
      queueMicrotask(() => this.cb([{ target, contentRect } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver));
    }
    unobserve(): void {}
    disconnect(): void {}
  }
  let saved: typeof ResizeObserver;
  beforeEach(() => { saved = window.ResizeObserver; window.ResizeObserver = SizedResizeObserver; });
  afterEach(() => { window.ResizeObserver = saved; });

  it('renders the row snippet with the item and index the library asks for, keyed by key()', async () => {
    let scroll: ScrollToIndexFn | null = null;
    render(VirtualListHarness, { props: { items, onscrollfn: (fn) => { scroll = fn; } } });
    await tick();
    await new Promise((r) => setTimeout(r, 0));
    flushSync();
    const list = screen.getByRole('list', { name: 'Things' });
    const rows = [...list.querySelectorAll<HTMLElement>('.r')];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThan(items.length);
    for (const r of rows) {
      const [idx, name] = r.textContent!.split(':');
      expect(name).toBe(items[Number(idx)].name);
      expect(r.dataset.key).toBe(items[Number(idx)].id);
    }
    expect(typeof scroll).toBe('function');
    expect(() => scroll!(10, 'start')).not.toThrow();
  });
});

describe('JsonView and KV', () => {
  it('colours JSON tokens with spans', () => {
    const { container } = render(JsonView, { props: { text: '{\n  "a": 1,\n  "b": [true, "x"]\n}' } });
    const pre = container.querySelector('pre.json')!;
    expect(pre.querySelector('.j-key')!.textContent).toBe('"a"');
    expect(pre.querySelector('.j-num')!.textContent).toBe('1');
    expect(pre.querySelector('.j-lit')!.textContent).toBe('true');
    expect(pre.querySelector('.j-str')!.textContent).toBe('"x"');
    expect(pre.textContent).toBe('{\n  "a": 1,\n  "b": [true, "x"]\n}');
  });

  it('renders plain text above maxChars', () => {
    const { container } = render(JsonView, { props: { text: '{"a": 1}', maxChars: 3 } });
    expect(container.querySelector('pre.json')!.children).toHaveLength(0);
  });

  it('KV skips empty values', () => {
    const { container } = render(KV, { props: { rows: [['size', '8×8'], ['tag', undefined], ['n', null], ['x', ''], ['frames', 0]] } });
    expect([...container.querySelectorAll('dt')].map((e) => e.textContent)).toEqual(['size', 'frames']);
  });
});
