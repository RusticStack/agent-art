// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { flushSync, tick } from 'svelte';
import { assets } from '@/state/assets.svelte';
import { dialogs } from '@/state/dialogs.svelte';
import { signals } from '@/state/live.svelte';
import { uiState } from '@/state/uiState.svelte';
import { workspace } from '@/state/workspace.svelte';
import { assetIndex, canvasSummary } from '@/test/fakes';
import AssetRow from './AssetRow.svelte';
import AssetBrowser from './AssetBrowser.svelte';
import { prefs } from '@/state/prefs.svelte';
import { buildTree, type TreeInput, type TreeRow } from './tree';

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
let savedRO: typeof ResizeObserver;

const index = () => assetIndex({
  canvases: [canvasSummary('spark', { animations: ['spin'] }), canvasSummary('pauldron'), canvasSummary('scratch')],
  tags: { 'canvas:spark': ['fx'], 'canvas:scratch': ['fx', 'wip'] },
});
const baseInput = (o: Partial<TreeInput> = {}): TreeInput => ({
  index: index(), hidden: new Set(), pinned: [], solo: new Set(), showHidden: false, filter: '', collapsed: new Set(), expanded: new Set(),
  selectMode: false, reviewCounts: {}, approved: new Set(), ...o,
});
const treeRow = (id: string, o: Partial<TreeInput> = {}): TreeRow => {
  const r = buildTree(baseInput(o)).find((x) => x.type === 'row' && x.id === id);
  if (!r || r.type !== 'row') throw new Error('no row ' + id);
  return r;
};
async function settle(): Promise<void> {
  await tick();
  await new Promise((r) => setTimeout(r, 0));
  flushSync();
  await tick();
}

beforeEach(() => {
  savedRO = window.ResizeObserver;
  window.ResizeObserver = SizedResizeObserver;
  localStorage.clear();
  prefs.load();
  uiState.hidden = new Set(); uiState.pinned = []; uiState.solo = new Set();
  workspace.navigator = null;
});
afterEach(() => {
  cleanup();
  window.ResizeObserver = savedRO;
  vi.restoreAllMocks();
});

describe('AssetRow', () => {
  it('solo / pin / eye call the uiState store with the row id, not onactivate', async () => {
    const solo = vi.spyOn(uiState, 'toggleSolo').mockImplementation(() => {});
    const pin = vi.spyOn(uiState, 'togglePinned').mockResolvedValue();
    const hide = vi.spyOn(uiState, 'toggleHidden').mockResolvedValue();
    const onactivate = vi.fn();
    const { container } = render(AssetRow, { props: { row: treeRow('canvas:pauldron'), onactivate } });
    const btn = (act: string) => container.querySelector<HTMLButtonElement>(`.row [data-act="${act}"]`)!;
    await fireEvent.click(btn('solo'));
    await fireEvent.click(btn('pin'));
    await fireEvent.click(btn('eye'));
    expect(solo).toHaveBeenCalledWith('canvas:pauldron');
    expect(pin).toHaveBeenCalledWith('canvas:pauldron');
    expect(hide).toHaveBeenCalledWith('canvas:pauldron');
    expect(onactivate).not.toHaveBeenCalled();
  });
  it('shows the state of the actions (titles, pressed, hidden row dimmed)', () => {
    const r = treeRow('canvas:pauldron', { pinned: ['canvas:pauldron'], hidden: new Set(['canvas:pauldron']), showHidden: true, solo: new Set(['canvas:pauldron']) });
    const { container } = render(AssetRow, { props: { row: r, onactivate: vi.fn() } });
    const el = container.querySelector<HTMLElement>('.row')!;
    expect(el.classList.contains('is-hidden')).toBe(true);
    expect(el.dataset.id).toBe('canvas:pauldron');
    expect(container.querySelector('[data-act="pin"]')!.getAttribute('title')).toBe('Unpin');
    expect(container.querySelector('[data-act="pin"]')!.getAttribute('aria-pressed')).toBe('true');
    expect(container.querySelector('[data-act="eye"]')!.getAttribute('title')).toBe('Show');
    expect(container.querySelector('[data-act="solo"]')!.getAttribute('title')).toBe('Unsolo');
  });
  it('a click on the row body activates it; the twisty toggles; child rows have no actions', async () => {
    const onactivate = vi.fn();
    const ontoggle = vi.fn();
    const r = treeRow('canvas:spark');
    const { container } = render(AssetRow, { props: { row: r, onactivate, ontoggle } });
    await fireEvent.click(container.querySelector('.label')!);
    expect(onactivate).toHaveBeenCalledWith(r, expect.any(MouseEvent));
    await fireEvent.click(container.querySelector('.twisty')!);
    expect(ontoggle).toHaveBeenCalledWith(r);
    cleanup();
    const child = treeRow('anim:spark/spin', { expanded: new Set(['canvas:spark']) });
    const c2 = render(AssetRow, { props: { row: child, onactivate } }).container;
    expect(c2.querySelector('[data-act="pin"]')).toBeNull();
  });
  it('in select mode a click selects (Shift = range) instead of opening', async () => {
    const onactivate = vi.fn();
    const onselect = vi.fn();
    const r = treeRow('canvas:pauldron', { selectMode: true });
    const { container } = render(AssetRow, { props: { row: r, onactivate, onselect, selected: true } });
    const box = container.querySelector<HTMLInputElement>('input.selbox')!;
    expect(box.checked).toBe(true);
    expect(container.querySelector('.row')!.getAttribute('aria-checked')).toBe('true');
    await fireEvent.click(container.querySelector('.label')!, { shiftKey: true });
    expect(onselect).toHaveBeenLastCalledWith(r, true);
    await fireEvent.click(box);
    expect(onselect).toHaveBeenLastCalledWith(r, false);
    expect(onactivate).not.toHaveBeenCalled();
  });
  it('drag sets the custom target type (not in select mode)', () => {
    const r = treeRow('canvas:pauldron');
    const { container } = render(AssetRow, { props: { row: r, onactivate: vi.fn() } });
    const el = container.querySelector<HTMLElement>('.row')!;
    expect(el.getAttribute('draggable')).toBe('true');
    const data = new Map<string, string>();
    const ev = new Event('dragstart', { bubbles: true }) as DragEvent;
    Object.defineProperty(ev, 'dataTransfer', { value: { setData: (t: string, v: string) => data.set(t, v), effectAllowed: '' } });
    el.dispatchEvent(ev);
    expect(JSON.parse(data.get('application/x-agent-art-target')!)).toEqual({ kind: 'canvas', name: 'pauldron' });
    expect(data.get('text/plain')).toBe('pauldron');
  });
});

describe('AssetBrowser', () => {
  beforeEach(() => { assets.set(index()); });

  it('renders the tree with the legacy selectors', async () => {
    const { container } = render(AssetBrowser, { props: {} });
    await settle();
    expect(container.querySelector('input.search')).not.toBeNull();
    expect(container.querySelector('.section[data-key="canvases"]')).not.toBeNull();
    expect(container.querySelector('.row[data-id="canvas:spark"] .label')).not.toBeNull();
    expect(screen.getByRole('tree', { name: 'Assets' })).toBeTruthy();
    expect(container.querySelector('.selbar')).toBeNull();
  });
  it('select mode shows checkboxes and the selection bar; leaving it clears the selection', async () => {
    const { container } = render(AssetBrowser, { props: {} });
    await settle();
    expect(container.querySelectorAll('input.selbox').length).toBe(0);
    await fireEvent.click(screen.getByRole('button', { name: /Select$/ }));
    await settle();
    expect(container.querySelectorAll('input.selbox').length).toBe(3);
    const bar = container.querySelector<HTMLElement>('.selbar')!;
    expect(bar.textContent).toContain('0 selected');
    const plan = screen.getByRole('button', { name: 'Plan cleanup…' }) as HTMLButtonElement;
    expect(plan.disabled).toBe(true);
    await fireEvent.click(container.querySelector('.row[data-id="canvas:spark"] .label')!);
    await fireEvent.click(container.querySelector('.row[data-id="canvas:scratch"] .label')!, { shiftKey: true });
    await settle();
    expect(bar.textContent).toContain('3 selected');
    expect(plan.disabled).toBe(false);
    const planSpy = vi.spyOn(dialogs, 'planCleanup').mockResolvedValue(true);
    await fireEvent.click(plan);
    await settle();
    expect(planSpy).toHaveBeenCalledWith(['canvas:spark', 'canvas:pauldron', 'canvas:scratch']);
    expect(bar.textContent).toContain('0 selected'); // cleared after a successful apply
    await fireEvent.click(screen.getByRole('button', { name: 'All shown' }));
    await settle();
    expect(bar.textContent).toContain('3 selected');
    await fireEvent.click(screen.getByRole('button', { name: /Select$/ }));
    await settle();
    expect(container.querySelector('.selbar')).toBeNull();
    expect(container.querySelectorAll('input.selbox').length).toBe(0);
  });
  it('by tag… adds every asset with the tag, then resets', async () => {
    const { container } = render(AssetBrowser, { props: {} });
    await settle();
    await fireEvent.click(screen.getByRole('button', { name: /Select$/ }));
    await settle();
    const pick = screen.getByRole('combobox', { name: 'Add every asset with this tag' }) as HTMLSelectElement;
    expect([...pick.options].map((o) => o.textContent)).toEqual(['by tag…', '#fx', '#wip']);
    pick.value = 'fx';
    await fireEvent.change(pick);
    await settle();
    expect(container.querySelector('.selbar')!.textContent).toContain('2 selected');
    expect(pick.value).toBe('');
  });
  it('click opens in slot A, Alt+click in slot B, double-click a canvas opens the Canvas view', async () => {
    const nav = vi.fn();
    workspace.navigator = nav;
    const onopen = vi.fn();
    const { container } = render(AssetBrowser, { props: { onopen } });
    await settle();
    const label = container.querySelector('.row[data-id="canvas:pauldron"] .label')!;
    await fireEvent.click(label);
    expect(nav).toHaveBeenLastCalledWith({ kind: 'canvas', name: 'pauldron' }, { slot: 'A' });
    await fireEvent.click(label, { altKey: true });
    expect(nav).toHaveBeenLastCalledWith({ kind: 'canvas', name: 'pauldron' }, { slot: 'B' });
    await fireEvent.dblClick(label);
    expect(nav).toHaveBeenLastCalledWith({ kind: 'canvas', name: 'pauldron', view: 'edit' }, { slot: 'A' });
    expect(onopen).toHaveBeenCalledWith({ kind: 'canvas', name: 'pauldron' }, 'B');
  });
  it('filter narrows the rows; a section toggle persists collapsed', async () => {
    const { container } = render(AssetBrowser, { props: {} });
    await settle();
    const search = container.querySelector<HTMLInputElement>('input.search')!;
    await fireEvent.input(search, { target: { value: 'paul' } });
    await settle();
    expect([...container.querySelectorAll<HTMLElement>('.row')].map((r) => r.dataset.id)).toEqual(['canvas:pauldron']);
    await fireEvent.input(search, { target: { value: '' } });
    await settle();
    await fireEvent.click(container.querySelector('.section[data-key="canvases"]')!);
    await settle();
    expect(container.querySelectorAll('.row').length).toBe(0);
    expect(JSON.parse(localStorage.getItem('agent-art:collapsed')!)).toEqual(['exports', 'groups', 'canvases']);
  });
  it('keyboard: arrows move the roving focus, Right expands, Enter opens, Shift+Enter compares', async () => {
    const nav = vi.fn();
    workspace.navigator = nav;
    const { container } = render(AssetBrowser, { props: {} });
    await settle();
    const sec = container.querySelector<HTMLElement>('.section[data-key="canvases"]')!;
    expect(sec.tabIndex).toBe(0);
    sec.focus();
    await fireEvent.keyDown(sec, { key: 'ArrowDown' });
    await settle();
    const spark = container.querySelector<HTMLElement>('.row[data-id="canvas:spark"]')!;
    expect(document.activeElement).toBe(spark);
    expect(spark.tabIndex).toBe(0);
    expect(sec.tabIndex).toBe(-1);
    await fireEvent.keyDown(spark, { key: 'ArrowRight' });
    await settle();
    expect(container.querySelector('.row[data-id="anim:spark/spin"]')).not.toBeNull();
    await fireEvent.keyDown(container.querySelector('.row[data-id="canvas:spark"]')!, { key: 'ArrowRight' });
    await settle();
    expect((document.activeElement as HTMLElement).dataset.id).toBe('anim:spark/spin');
    await fireEvent.keyDown(document.activeElement!, { key: 'ArrowLeft' });
    await settle();
    expect((document.activeElement as HTMLElement).dataset.id).toBe('canvas:spark');
    await fireEvent.keyDown(document.activeElement!, { key: 'Enter' });
    expect(nav).toHaveBeenLastCalledWith({ kind: 'canvas', name: 'spark' }, { slot: 'A' });
    await fireEvent.keyDown(document.activeElement!, { key: 'Enter', shiftKey: true });
    expect(nav).toHaveBeenLastCalledWith({ kind: 'canvas', name: 'spark' }, { slot: 'B' });
    await fireEvent.keyDown(document.activeElement!, { key: 'End' });
    await settle();
    expect((document.activeElement as HTMLElement).dataset.id).toBe('canvas:scratch');
    await fireEvent.keyDown(document.activeElement!, { key: 'Home' });
    await settle();
    expect(document.activeElement).toBe(container.querySelector('.section[data-key="canvases"]'));
  });
  it('the active row follows slot A; a flash signal marks matching rows for 900 ms', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      workspace.open({ kind: 'canvas', name: 'scratch' }, { history: false });
      const { container } = render(AssetBrowser, { props: {} });
      await vi.waitFor(() => expect(container.querySelector('.row[data-id="canvas:scratch"]')).not.toBeNull());
      expect(container.querySelector('.row[data-id="canvas:scratch"]')!.classList.contains('active')).toBe(true);
      signals.flash = { id: 'canvas:pauldron', n: signals.flash.n + 1 };
      flushSync();
      expect(container.querySelector('.row[data-id="canvas:pauldron"]')!.classList.contains('flash')).toBe(true);
      vi.advanceTimersByTime(900);
      flushSync();
      expect(container.querySelector('.row[data-id="canvas:pauldron"]')!.classList.contains('flash')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
  it('Shift+F10 on a focused row opens its context menu; an item calls the store', async () => {
    const nav = vi.fn();
    workspace.navigator = nav;
    const { container } = render(AssetBrowser, { props: {} });
    await settle();
    const row = container.querySelector<HTMLElement>('.row[data-id="canvas:pauldron"]')!;
    row.focus();
    await fireEvent.keyDown(row, { key: 'F10', shiftKey: true });
    await settle();
    const menu = await screen.findByRole('menu');
    const labels = [...menu.querySelectorAll('[role="menuitem"]')].map((m) => m.textContent?.trim());
    expect(labels.slice(0, 2)).toEqual(['Open', 'Open in compare']);
    expect(labels).toContain('Plan cleanup…');
    await fireEvent.click(screen.getByRole('menuitem', { name: 'Open in compare' }));
    expect(nav).toHaveBeenLastCalledWith({ kind: 'canvas', name: 'pauldron' }, { slot: 'B' });
  });
  it('right-click on a section header leaves the browser menu alone', async () => {
    const { container } = render(AssetBrowser, { props: {} });
    await settle();
    const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    container.querySelector('.section[data-key="canvases"]')!.dispatchEvent(ev);
    await settle();
    expect(ev.defaultPrevented).toBe(false);
    expect(screen.queryByRole('menu')).toBeNull();
  });
  it('focusSearch() focuses and selects the filter', async () => {
    const r = render(AssetBrowser, { props: {} });
    await settle();
    (r.component as unknown as { focusSearch(): void }).focusSearch();
    expect(document.activeElement).toBe(r.container.querySelector('input.search'));
  });
  it('hidden toggle persists showHidden; Clear solo shows only while solo is set', async () => {
    const { container } = render(AssetBrowser, { props: {} });
    await settle();
    await fireEvent.click(screen.getByRole('button', { name: 'hidden' }));
    expect(localStorage.getItem('agent-art:showHidden')).toBe('true');
    expect(screen.queryByRole('button', { name: 'Clear solo' })).toBeNull();
    uiState.toggleSolo('canvas:spark');
    await settle();
    expect([...container.querySelectorAll<HTMLElement>('.row')].map((r) => r.dataset.id)).toEqual(['canvas:spark']);
    await fireEvent.click(screen.getByRole('button', { name: 'Clear solo' }));
    await settle();
    expect(uiState.solo.size).toBe(0);
  });
  it('the new canvas form focuses the name and cancels', async () => {
    const { container } = render(AssetBrowser, { props: {} });
    await settle();
    await fireEvent.click(screen.getByRole('button', { name: 'New' }));
    await settle();
    const name = container.querySelector<HTMLInputElement>('form.new-form input[aria-label="Canvas name"]')!;
    expect(document.activeElement).toBe(name);
    expect(name.pattern).toBe('[A-Za-z0-9_\\-.]{1,64}');
    expect(container.querySelector<HTMLInputElement>('input[aria-label="Width"]')!.value).toBe('16');
    await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await settle();
    expect(container.querySelector('form.new-form')).toBeNull();
  });
});
