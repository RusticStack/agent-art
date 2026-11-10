// @vitest-environment jsdom
// Step 19: the narrow top bar's overflow menu (menu button + PopupMenu).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { tick } from 'svelte';
import type { Review } from '@/lib/api/types';
import { dialogs } from '@/state/dialogs.svelte';
import { editor } from '@/state/editor.svelte';
import { reviews } from '@/state/reviews.svelte';
import { workspace } from '@/state/workspace.svelte';
import OverflowMenu from './OverflowMenu.svelte';

const button = () => screen.getByRole('button', { name: /^More actions/ });
const menu = () => screen.getByRole('menu', { name: 'More actions' });
const item = (id: string) => menu().querySelector<HTMLElement>(`[data-id="${id}"]`)!;
async function openMenu() {
  await fireEvent.click(button());
  await tick(); await tick();
}

beforeEach(() => {
  workspace.writeHash = () => {};
  workspace.setCompare(false);
  editor.setReviewMode(false);
  workspace.setFollowMode('canvas');
  reviews.list = [];
  dialogs.closeAll();
});
afterEach(() => { cleanup(); dialogs.closeAll(); localStorage.clear(); });

describe('OverflowMenu', () => {
  it('is a menu button; opening lists the actions and follow mode, focus on the first item', async () => {
    render(OverflowMenu);
    expect(button().getAttribute('aria-haspopup')).toBe('menu');
    expect(button().getAttribute('aria-expanded')).toBe('false');
    await openMenu();
    expect(button().getAttribute('aria-expanded')).toBe('true');
    expect(button().getAttribute('aria-controls')).toBe(menu().id);
    expect([...menu().querySelectorAll('[data-id]')].map((e) => e.getAttribute('data-id'))).toEqual(
      ['search', 'compare', 'review', 'notes', 'graph', 'cleanup', 'help', 'follow-canvas', 'follow-project', 'follow-off']);
    expect(document.activeElement).toBe(item('search'));
    expect(item('compare').getAttribute('role')).toBe('menuitemcheckbox');
    expect(item('compare').getAttribute('aria-checked')).toBe('false');
    expect(item('follow-canvas').getAttribute('role')).toBe('menuitemradio');
    expect(item('follow-canvas').getAttribute('aria-checked')).toBe('true');
  });

  it('runs an item, closes and returns focus to the button', async () => {
    render(OverflowMenu);
    await openMenu();
    await fireEvent.click(item('compare'));
    expect(workspace.comparing).toBe(true);
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(button());
    await openMenu();
    await fireEvent.click(item('help'));
    expect(dialogs.helpOpen).toBe(true);
    await openMenu();
    await fireEvent.click(item('follow-project'));
    expect(workspace.followMode).toBe('project');
    await openMenu();
    await fireEvent.click(item('search'));
    expect(dialogs.isOpen('palette')).toBe(true);
  });

  it('Esc closes and returns focus; Down on the button opens it; the button toggles', async () => {
    render(OverflowMenu);
    await openMenu();
    await fireEvent.keyDown(menu(), { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(button());
    await fireEvent.keyDown(button(), { key: 'ArrowDown' });
    await tick(); await tick();
    expect(menu()).toBeTruthy();
    await fireEvent.click(button());
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('shows the open notes count on the button and on the Notes item', async () => {
    reviews.list = [{ id: 'r1', status: 'open' }, { id: 'r2', status: 'fixed' }, { id: 'r3', status: 'reopened' }] as Review[];
    render(OverflowMenu);
    expect(button().textContent).toContain('2 open notes');
    await openMenu();
    expect(item('notes').querySelector('.count-badge')?.textContent).toBe('2');
    reviews.list = [];
    await tick();
    expect(item('notes').querySelector('.count-badge')).toBeNull();
  });
});
