// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { assets } from '@/state/assets.svelte';
import { uiState } from '@/state/uiState.svelte';
import { workspace } from '@/state/workspace.svelte';
import { assetIndex, canvasSummary } from '@/test/fakes';
import type { SlotId, Target } from '@/viewers/types';
import type { PaletteAction, PaletteContext } from './commands';
import CommandPalette from './CommandPalette.svelte';

const context: PaletteContext = { slotA: null, index: null, comparing: false, following: false, reviewMode: false, browserShown: true, showHidden: false, soloCount: 0 };

function setup() {
  const onclose = vi.fn();
  const runAction = vi.fn<(a: PaletteAction) => void>();
  const open = vi.fn<(t: Target, slot: SlotId) => void>();
  render(CommandPalette, { props: { onclose, context, runAction, open } });
  return { onclose, runAction, open };
}
const input = () => screen.getByRole<HTMLInputElement>('combobox', { name: 'Search assets and actions' });
const options = () => screen.getAllByRole('option');
const type = async (v: string) => { await fireEvent.input(input(), { target: { value: v } }); };

beforeEach(() => {
  assets.set(assetIndex({ canvases: [canvasSummary('helmet_front'), canvasSummary('pauldron'), canvasSummary('spark')], models: [] }));
  workspace.recent = ['spark'];
  uiState.solo = new Set();
  uiState.hidden = new Set(['canvas:spark_hidden']);
});
afterEach(() => { cleanup(); workspace.recent = []; });

describe('CommandPalette', () => {
  it('opens on Recent then Actions with group headers and an active option', async () => {
    setup();
    await screen.findByRole('dialog', { name: 'Search assets and actions' });
    const groups = screen.getAllByRole('group').map((g) => g.getAttribute('aria-labelledby') && document.getElementById(g.getAttribute('aria-labelledby')!)!.textContent);
    expect(groups).toEqual(['Recent', 'Actions']);
    expect(options()[0].textContent).toContain('spark');
    expect(options()[0].getAttribute('aria-selected')).toBe('true');
    expect(input().getAttribute('aria-activedescendant')).toBe(options()[0].id);
  });

  it('typing filters and wraps the matched characters in <mark>', async () => {
    setup();
    await type('pauld');
    const opts = options();
    expect(opts[0].textContent).toContain('pauldron');
    expect(opts.some((o) => o.textContent!.includes('helmet_front'))).toBe(false);
    expect([...opts[0].querySelectorAll('mark')].map((m) => m.textContent).join('')).toBe('pauld');
    await type('zzzzqqq');
    expect(screen.queryAllByRole('option')).toHaveLength(0);
    expect(screen.getByRole('status').textContent).toBe('No matches');
  });

  it('Enter closes, then runs the active item with compare: false', async () => {
    const { onclose, open } = setup();
    await type('pauld');
    await fireEvent.keyDown(input(), { key: 'Enter' });
    expect(onclose).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith({ kind: 'canvas', name: 'pauldron' }, 'A');
    expect(onclose.mock.invocationCallOrder[0]).toBeLessThan(open.mock.invocationCallOrder[0]);
  });

  it('Alt+Enter runs with compare: true (slot B); Shift+Enter too', async () => {
    const { open } = setup();
    await type('helmet');
    await fireEvent.keyDown(input(), { key: 'Enter', altKey: true });
    expect(open).toHaveBeenLastCalledWith({ kind: 'canvas', name: 'helmet_front' }, 'B');
    await fireEvent.keyDown(input(), { key: 'Enter', shiftKey: true });
    expect(open).toHaveBeenCalledTimes(2);
    expect(open).toHaveBeenLastCalledWith({ kind: 'canvas', name: 'helmet_front' }, 'B');
  });

  it('Down / Up / End / Home move the active option; an action runs through runAction', async () => {
    const { runAction } = setup();
    await type('graph');
    expect(options()[0].textContent).toContain('Asset graph');
    await fireEvent.keyDown(input(), { key: 'End' });
    const last = options().at(-1)!;
    expect(input().getAttribute('aria-activedescendant')).toBe(last.id);
    await fireEvent.keyDown(input(), { key: 'ArrowDown' });
    expect(input().getAttribute('aria-activedescendant')).toBe(options()[0].id);
    await fireEvent.keyDown(input(), { key: 'ArrowUp' });
    expect(input().getAttribute('aria-activedescendant')).toBe(last.id);
    await fireEvent.keyDown(input(), { key: 'Home' });
    await fireEvent.keyDown(input(), { key: 'Enter', altKey: true });
    expect(runAction).toHaveBeenCalledWith({ type: 'shortcut', action: 'graph' });
  });

  it('a click runs the clicked option', async () => {
    const { open } = setup();
    await type('spark');
    await fireEvent.click(options()[0]);
    expect(open).toHaveBeenCalledWith({ kind: 'canvas', name: 'spark' }, 'A');
  });

  it('Esc closes', async () => {
    const { onclose, open } = setup();
    await screen.findByRole('dialog');
    await fireEvent.keyDown(input(), { key: 'Escape' });
    expect(onclose).toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });
});
