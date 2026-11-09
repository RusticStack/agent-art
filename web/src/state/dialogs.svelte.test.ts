import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Dialogs } from './dialogs.svelte';
import { FADE_MS, LIFETIME, MAX_VISIBLE, Toasts } from './toasts.svelte';
import { toast as busToast } from '@/lib/util/notify';
import { connectToastBus, toasts as toastSingleton } from './toasts.svelte';

describe('dialogs store', () => {
  it('help toggles and does not block (K2, E10)', () => {
    const d = new Dialogs();
    expect(d.helpOpen).toBe(false);
    d.toggleHelp();
    expect(d.helpOpen).toBe(true);
    expect(d.blocking).toBe(false);
    d.toggleHelp();
    expect(d.stack).toEqual([]);
  });

  it('confirm resolves true only for result true; blocking while open', async () => {
    const d = new Dialogs();
    const p = d.confirm({ title: 'Delete r1?', confirmLabel: 'Delete', danger: true });
    expect(d.blocking).toBe(true);
    const spec = d.top!;
    expect(spec).toMatchObject({ type: 'confirm', title: 'Delete r1?', confirmLabel: 'Delete', danger: true });
    d.close(spec, true);
    await expect(p).resolves.toBe(true);
    expect(d.blocking).toBe(false);
    const q = d.confirm({ title: 'x', confirmLabel: 'OK' });
    d.closeTop();
    await expect(q).resolves.toBe(false);
  });

  it('prompt resolves the string, or null when cancelled', async () => {
    const d = new Dialogs();
    const p = d.prompt({ title: 'Reopen', label: 'What is still wrong?' });
    d.close(d.top!, 'still blurry');
    await expect(p).resolves.toBe('still blurry');
    const q = d.prompt({ title: 'Reopen', label: 'x' });
    d.close(d.top!);
    await expect(q).resolves.toBeNull();
  });

  it('reviewNote and planCleanup settle on close', async () => {
    const d = new Dialogs();
    const r = d.reviewNote({ asset: 'canvas:spark' });
    expect(d.top).toMatchObject({ type: 'reviewNote', draft: { asset: 'canvas:spark' } });
    d.close(d.top!, { id: 'r7', extra: 1 });
    await expect(r).resolves.toEqual({ id: 'r7' });
    const r2 = d.reviewNote({ asset: 'canvas:spark' });
    d.close(d.top!, 'nonsense');
    await expect(r2).resolves.toBeNull();
    const ids = ['canvas:a'];
    const c = d.planCleanup(ids);
    ids.push('canvas:b');
    expect(d.top).toMatchObject({ type: 'planCleanup', ids: ['canvas:a'] });
    d.close(d.top!, true);
    await expect(c).resolves.toBe(true);
  });

  it('closing twice settles once; closeAll cancels everything', async () => {
    const d = new Dialogs();
    const p = d.confirm({ title: 'a', confirmLabel: 'OK' });
    const spec = d.top!;
    d.close(spec, true);
    d.close(spec, false);
    await expect(p).resolves.toBe(true);
    d.toggleHelp();
    const q = d.prompt({ title: 'b', label: 'b' });
    d.openCleanup('usage');
    d.openCleanup('settings');
    expect(d.stack.filter((s) => s.type === 'cleanup')).toEqual([{ type: 'cleanup', tab: 'settings' }]);
    d.openReviewList(); d.openReviewList();
    expect(d.stack.filter((s) => s.type === 'reviewList')).toHaveLength(1);
    d.closeAll();
    await expect(q).resolves.toBeNull();
    expect(d.stack).toEqual([]);
  });
});

describe('toasts store', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('info / ok live 3.5 s, errors 6 s, then fade 0.5 s (O1)', () => {
    const t = new Toasts();
    t.push('hello');
    t.push('bad', 'error');
    expect(t.list.map((x) => x.kind)).toEqual(['info', 'error']);
    vi.advanceTimersByTime(LIFETIME.info);
    expect(t.list[0].leaving).toBe(true);
    vi.advanceTimersByTime(FADE_MS);
    expect(t.list.map((x) => x.text)).toEqual(['bad']);
    vi.advanceTimersByTime(LIFETIME.error - LIFETIME.info - FADE_MS + FADE_MS);
    expect(t.list).toEqual([]);
  });

  it('hold pauses every timer and resumes with the time left', () => {
    const t = new Toasts();
    t.push('a');
    vi.advanceTimersByTime(3000);
    t.hold(true);
    vi.advanceTimersByTime(20_000);
    expect(t.list).toHaveLength(1);
    expect(t.list[0].leaving).toBe(false);
    t.push('b');
    t.hold(false);
    vi.advanceTimersByTime(499);
    expect(t.list[0].leaving).toBe(false);
    vi.advanceTimersByTime(1);
    expect(t.list[0].leaving).toBe(true);
    vi.advanceTimersByTime(LIFETIME.info);
    expect(t.list).toEqual([]);
  });

  it('shows the newest MAX_VISIBLE; dismiss fades at once', () => {
    const t = new Toasts();
    for (let i = 0; i < 6; i++) t.push(`t${i}`);
    expect(t.visible.map((x) => x.text)).toEqual(['t2', 't3', 't4', 't5']);
    expect(t.visible).toHaveLength(MAX_VISIBLE);
    expect(t.collapsed).toBe(2);
    const id = t.visible[3].id;
    t.dismiss(id);
    vi.advanceTimersByTime(FADE_MS);
    expect(t.list.some((x) => x.id === id)).toBe(false);
  });

  it('the lib toast bus feeds the store once connected', () => {
    toastSingleton.reset();
    connectToastBus();
    busToast('op: failed', 'error');
    expect(toastSingleton.list.map((x) => [x.text, x.kind])).toEqual([['op: failed', 'error']]);
    toastSingleton.reset();
  });
});
