// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import IconButton from './IconButton.svelte';

describe('Tooltip (hand-written, via IconButton)', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { cleanup(); vi.useRealTimers(); });

  it('shows the label and shortcut after 500 ms of hover, linked by aria-describedby', async () => {
    render(IconButton, { icon: 'copy', label: 'Copy link', shortcut: 'Ctrl+C' });
    const btn = screen.getByRole('button', { name: 'Copy link' });
    await fireEvent.pointerEnter(btn);
    await vi.advanceTimersByTimeAsync(499);
    expect(screen.queryByRole('tooltip')).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    const tip = screen.getByRole('tooltip');
    expect(tip.textContent).toContain('Copy link');
    expect(tip.querySelectorAll('kbd').length).toBeGreaterThan(0);
    expect(tip.parentElement).toBe(document.body);
    expect(btn.getAttribute('aria-describedby')).toBe(tip.id);
  });

  it('hides on leave, pointer down and Esc; a leave before the delay shows nothing', async () => {
    render(IconButton, { icon: 'copy', label: 'Copy' });
    const btn = screen.getByRole('button', { name: 'Copy' });
    await fireEvent.pointerEnter(btn);
    await vi.advanceTimersByTimeAsync(200);
    await fireEvent.pointerLeave(btn);
    await vi.advanceTimersByTimeAsync(600);
    expect(screen.queryByRole('tooltip')).toBeNull();

    await fireEvent.pointerEnter(btn);
    await vi.advanceTimersByTimeAsync(500);
    expect(screen.getByRole('tooltip')).toBeTruthy();
    await fireEvent.keyDown(btn, { key: 'Escape' });
    expect(screen.queryByRole('tooltip')).toBeNull();
    expect(btn.hasAttribute('aria-describedby')).toBe(false);

    await fireEvent.pointerEnter(btn);
    await vi.advanceTimersByTimeAsync(500);
    await fireEvent.pointerDown(btn);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('removes the bubble from <body> on unmount', async () => {
    const r = render(IconButton, { icon: 'copy', label: 'Copy' });
    await fireEvent.pointerEnter(screen.getByRole('button', { name: 'Copy' }));
    await vi.advanceTimersByTimeAsync(500);
    expect(document.querySelector('[role=tooltip]')).not.toBeNull();
    r.unmount();
    expect(document.querySelector('[role=tooltip]')).toBeNull();
  });
});
