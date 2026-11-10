// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { createRawSnippet } from 'svelte';
import ContextMenu from './ContextMenu.svelte';
import type { MenuItem } from './menu';

const rows = createRawSnippet(() => ({ render: () => '<div><button data-row="a">Row A</button><span data-note="1">note</span></div>' }));

function setup(over: Partial<Record<'open' | 'copy' | 'gone', () => void>> = {}) {
  const calls = { open: vi.fn(over.open), copy: vi.fn(over.copy), gone: vi.fn(over.gone) };
  const items = (t: Element): MenuItem[] | null => t.closest('[data-row]') ? [
    { id: 'open', label: 'Open', onselect: calls.open },
    { id: 'gone', label: 'Gone', disabled: true, onselect: calls.gone },
    { separator: true, id: 'sep' },
    { id: 'copy', label: 'Copy link', shortcut: 'Ctrl+C', onselect: calls.copy },
  ] : null;
  render(ContextMenu, { items, children: rows });
  return calls;
}

describe('ContextMenu (hand-written)', () => {
  afterEach(() => cleanup());

  it('opens on contextmenu over a row, focuses the first enabled item, Enter runs it and focus returns', async () => {
    const calls = setup();
    const row = screen.getByRole('button', { name: 'Row A' });
    row.focus();
    const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 20 });
    row.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(screen.getByRole('menu')).toBeTruthy());
    const items = screen.getAllByRole('menuitem');
    expect(items.map((i) => i.textContent?.trim())).toEqual(['Open', 'Gone', expect.stringContaining('Copy link')]);
    expect(document.activeElement).toBe(items[0]);
    expect(screen.getByRole('separator')).toBeTruthy();
    await fireEvent.keyDown(screen.getByRole('menu'), { key: 'Enter' });
    expect(calls.open).toHaveBeenCalledOnce();
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(row);
  });

  it('arrow keys skip disabled items and wrap; Esc closes and returns focus', async () => {
    const calls = setup();
    const row = screen.getByRole('button', { name: 'Row A' });
    row.focus();
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(screen.getByRole('menu')).toBeTruthy());
    const menu = screen.getByRole('menu');
    const [open, , copy] = screen.getAllByRole('menuitem');
    await fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(copy); // "Gone" is disabled
    await fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(open);
    await fireEvent.keyDown(menu, { key: 'End' });
    expect(document.activeElement).toBe(copy);
    await fireEvent.keyDown(menu, { key: 'o' });
    expect(document.activeElement).toBe(open);
    await fireEvent.keyDown(menu, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(row);
    expect(calls.gone).not.toHaveBeenCalled();
  });

  it('leaves the native menu alone where items() returns null; click and outside pointer down', async () => {
    const calls = setup();
    const note = document.querySelector('[data-note]')!;
    const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    note.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
    expect(screen.queryByRole('menu')).toBeNull();

    const row = screen.getByRole('button', { name: 'Row A' });
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(screen.getByRole('menu')).toBeTruthy());
    await fireEvent.click(screen.getAllByRole('menuitem')[1]); // disabled: nothing
    expect(screen.getByRole('menu')).toBeTruthy();
    await fireEvent.click(screen.getAllByRole('menuitem')[2]);
    expect(calls.copy).toHaveBeenCalledOnce();

    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(screen.getByRole('menu')).toBeTruthy());
    await fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('menu')).toBeNull();
  });
});
