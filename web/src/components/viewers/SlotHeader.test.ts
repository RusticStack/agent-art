// @vitest-environment jsdom
// Slot header (L6–L9, step 18; compare tools RV7, step 18c).
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { flushSync } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { assets } from '@/state/assets.svelte';
import { workspace } from '@/state/workspace.svelte';
import { assetIndex, canvasSummary } from '@/test/fakes';
import type { Target } from '@/viewers/types';
import SlotHeader from './SlotHeader.svelte';

function put(a: Target | null, b?: Target | null) {
  workspace.slots.A = { target: a, error: null };
  workspace.comparing = b !== undefined;
  workspace.slots.B = { target: b ?? null, error: null };
  flushSync();
}
const tabNames = (name: RegExp | string) => screen.getByRole('tablist', { name }).querySelectorAll('[role=tab]');
const labels = (list: NodeListOf<Element>) => [...list].map((t) => t.textContent?.replace(/\s+/g, ' ').trim());

describe('SlotHeader', () => {
  beforeEach(() => {
    assets.set(assetIndex({
      canvases: [
        canvasSummary('spark', { frames: 4 }),
        canvasSummary('icon', { frames: 1, animations: [] }),
        canvasSummary('hero_parts', { kind: 'rigparts', frames: 1, animations: [] }),
      ],
    }));
    workspace.compareLink = true; workspace.compareOverlay = 'off'; workspace.compareStatus = null;
  });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); put(null); });

  it('L8: a live canvas has Canvas, Animation (only when animated), Sheet, Layers, plus Rig for rig parts', () => {
    put({ kind: 'canvas', name: 'spark' });
    render(SlotHeader, { props: { slot: 'A' } });
    expect(labels(tabNames('Viewer tabs')).map((l) => l?.replace(/\d$/, '').trim())).toEqual(['Canvas', 'Animation', 'Sheet', 'Layers']);
    expect(screen.getByRole('tab', { selected: true }).textContent).toMatch(/Canvas/);
    cleanup();
    put({ kind: 'canvas', name: 'icon', view: 'sheet' });
    render(SlotHeader, { props: { slot: 'A' } });
    expect(labels(tabNames('Viewer tabs')).map((l) => l?.replace(/\d$/, '').trim())).toEqual(['Canvas', 'Sheet', 'Layers']);
    expect(screen.getByRole('tab', { selected: true }).textContent).toMatch(/Sheet/);
    cleanup();
    put({ kind: 'canvas', name: 'hero_parts' });
    render(SlotHeader, { props: { slot: 'A' } });
    expect(labels(tabNames('Viewer tabs')).at(-1)).toMatch(/^Rig/);
  });

  it('L8: a rig has Rig and Layers; models, snapshots and the graph have no tabs', () => {
    put({ kind: 'rig', name: 'hero' });
    render(SlotHeader, { props: { slot: 'A' } });
    expect(labels(tabNames('Viewer tabs')).map((l) => l?.replace(/\d$/, '').trim())).toEqual(['Rig', 'Layers']);
    cleanup();
    for (const t of [{ kind: 'model', name: 'rifle' }, { kind: 'graph' }, { kind: 'canvas', name: 'spark', snap: 's1', label: 'v1' }] as Target[]) {
      put(t);
      render(SlotHeader, { props: { slot: 'A' } });
      expect(screen.queryByRole('tablist')).toBeNull();
      cleanup();
    }
  });

  it('a tab click switches the view of its own slot', async () => {
    const sw = vi.spyOn(workspace, 'switchView').mockImplementation(() => {});
    put({ kind: 'canvas', name: 'icon' }, { kind: 'canvas', name: 'spark' });
    render(SlotHeader, { props: { slot: 'B' } });
    await fireEvent.click(screen.getByRole('tab', { name: /Sheet/ }));
    expect(sw).toHaveBeenCalledWith('B', 'sheet');
    expect(screen.getByRole('tablist', { name: 'Comparison viewer tabs' })).toBeTruthy();
  });

  it('title: name, snapshot badge, and Back to live only in slot A', () => {
    const back = vi.spyOn(workspace, 'backToLive').mockImplementation(() => {});
    put({ kind: 'canvas', name: 'spark', snap: 's1', label: 'before' });
    const { container } = render(SlotHeader, { props: { slot: 'A' } });
    expect(container.querySelector('#titleA')!.textContent).toMatch(/spark\s*state before/);
    void fireEvent.click(screen.getByRole('button', { name: 'Back to live' }));
    expect(back).toHaveBeenCalled();
    cleanup();
    put({ kind: 'graph' }, { kind: 'canvas', name: 'spark', snap: 's1', label: 'before' });
    render(SlotHeader, { props: { slot: 'B' } });
    expect(screen.queryByRole('button', { name: 'Back to live' })).toBeNull();
  });

  it('RV7: compare tools only while both slots hold a canvas viewer; Link, Overlay and status drive the store', async () => {
    put({ kind: 'canvas', name: 'icon' }, { kind: 'canvas', name: 'spark', snap: 's1' });
    render(SlotHeader, { props: { slot: 'B' } });
    const group = screen.getByRole('group', { name: 'Compare tools' });
    expect(group).toBeTruthy();
    const link = screen.getByRole('button', { name: 'Link' });
    expect(link.getAttribute('aria-pressed')).toBe('true');
    await fireEvent.click(link);
    expect(workspace.compareLink).toBe(false);
    const sel = screen.getByRole('combobox', { name: 'Overlay' }) as HTMLSelectElement;
    expect([...sel.options].map((o) => o.text)).toEqual(['Off', 'Difference', 'Swipe', 'Blink']);
    await fireEvent.change(sel, { target: { value: 'diff' } });
    expect(workspace.compareOverlay).toBe('diff');
    workspace.compareStatus = '1 px differ (0.4%) · bbox 0,0 1×1'; flushSync();
    expect(screen.getByRole('status').textContent).toMatch(/^1 px differ/);
    // a model in B: the tools go away
    put({ kind: 'canvas', name: 'icon' }, { kind: 'model', name: 'rifle' });
    expect(screen.queryByRole('group', { name: 'Compare tools' })).toBeNull();
    // slot A never has them, nor Swap / Close
    cleanup();
    put({ kind: 'canvas', name: 'icon' }, { kind: 'canvas', name: 'spark' });
    render(SlotHeader, { props: { slot: 'A' } });
    expect(screen.queryByRole('group', { name: 'Compare tools' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Swap sides' })).toBeNull();
  });

  it('slot B: Swap and Close', async () => {
    const swap = vi.spyOn(workspace, 'swap').mockImplementation(() => {});
    const close = vi.spyOn(workspace, 'setCompare').mockImplementation(() => {});
    put({ kind: 'canvas', name: 'icon' }, { kind: 'canvas', name: 'spark' });
    render(SlotHeader, { props: { slot: 'B' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Swap sides' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Close comparison (C / Esc)' }));
    expect(swap).toHaveBeenCalled();
    expect(close).toHaveBeenCalledWith(false);
  });
});
