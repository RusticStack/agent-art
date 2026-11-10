// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { flushSync } from 'svelte';
import type { Review } from '@/lib/api/types';
import { dialogs } from '@/state/dialogs.svelte';
import { workspace } from '@/state/workspace.svelte';
import ReviewCard from './ReviewCard.svelte';

const op = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api/client', () => ({ op, api: {} }));

const review = (over: Partial<Review> = {}): Review => ({
  id: 'r7', asset: 'canvas:helmet_side', target: { region: [12, 11, 5, 3] }, category: 'inconsistent', priority: 'normal', note: 'Visor line',
  status: 'open', by: 'user', created: 1, updated: 1, history: [], ...over,
});
const names = () => screen.queryAllByRole('button').map((b) => b.getAttribute('aria-label') || b.textContent!.trim());

beforeEach(() => { op.mockReset(); op.mockResolvedValue({ text: 'ok' }); });
afterEach(() => { cleanup(); dialogs.closeAll(); workspace.navigator = null; });

describe('ReviewCard actions per status', () => {
  const cases: [Review['status'], boolean, string[]][] = [
    ['open', false, ['Show', 'Delete note r7']],
    ['in_progress', false, ['Show', 'Delete note r7']],
    ['reopened', true, ['Show', 'Side by side', 'Delete note r7']],
    ['fixed', false, ['Show', 'Accept', 'Reopen', 'Delete note r7']],
    ['fixed', true, ['Show', 'Side by side', 'Accept', 'Reopen', 'Delete note r7']],
    ['accepted', false, ['Show', 'Reopen', 'Delete note r7']],
  ];
  for (const [status, cw, expected] of cases) {
    it(`${status}${cw ? ' with compare' : ''}`, () => {
      const { container } = render(ReviewCard, { props: { review: review({ status, compare_with: cw ? { asset: 'canvas:helmet_front' } : undefined }) } });
      expect(names()).toEqual(expected);
      const card = container.querySelector('.review-card')!;
      expect(card.classList.contains(`st-${status}`)).toBe(true);
      expect(card.querySelector('.rc-status')!.textContent).toBe(status === 'in_progress' ? 'in progress' : status);
      expect(!!card.querySelector('.rc-where a')).toBe(cw);
    });
  }

  it('shows the note, where line, priority, last reply, images and the asset prefix', () => {
    const { container } = render(ReviewCard, { props: { showAsset: true, review: review({ priority: 'high', note: '', history: [
      { ts: 1, by: 'user', img: 'r7-0.png' }, { ts: 2, by: 'agent', status: 'fixed', reply: 'fixed it', img: 'r7-1.png' },
    ] }) } });
    expect(container.querySelector('.rc-asset')!.textContent).toBe('canvas:helmet_side');
    expect(container.querySelector('.rc-note')!.textContent).toBe('(approval)');
    expect(container.querySelector('.rc-pri')!.textContent).toBe('high');
    expect(container.querySelector('.rc-where')!.textContent).toBe('[12,11,5,3]');
    expect(container.querySelector('.rc-reply')!.textContent).toBe('agent: fixed it');
    expect([...container.querySelectorAll('.rc-imgs img')].map((i) => i.getAttribute('src'))).toEqual(['/api/review-image/r7-0.png', '/api/review-image/r7-1.png']);
    expect([...container.querySelectorAll('figcaption')].map((f) => f.textContent)).toEqual(['noted', 'fixed']);
  });
});

describe('ReviewCard actions', () => {
  it('Accept sends review_update accepted', async () => {
    render(ReviewCard, { props: { review: review({ status: 'fixed' }) } });
    await fireEvent.click(screen.getByRole('button', { name: 'Accept' }));
    expect(op).toHaveBeenCalledWith('review_update', { id: 'r7', status: 'accepted' });
  });

  it('Reopen asks with the prompt dialog and sends the reply; Cancel sends nothing', async () => {
    render(ReviewCard, { props: { review: review({ status: 'accepted' }) } });
    await fireEvent.click(screen.getByRole('button', { name: 'Reopen' }));
    const spec = dialogs.top!;
    expect(spec).toMatchObject({ type: 'prompt', title: 'Reopen r7', label: 'What is still wrong?' });
    dialogs.close(spec, null);
    await Promise.resolve(); await Promise.resolve();
    expect(op).not.toHaveBeenCalled();
    await fireEvent.click(screen.getByRole('button', { name: 'Reopen' }));
    dialogs.close(dialogs.top!, ' still too bright ');
    await vi.waitFor(() => expect(op).toHaveBeenCalledWith('review_update', { id: 'r7', status: 'reopened', reply: 'still too bright' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Reopen' }));
    dialogs.close(dialogs.top!, '');
    await vi.waitFor(() => expect(op).toHaveBeenLastCalledWith('review_update', { id: 'r7', status: 'reopened' }));
  });

  it('Delete confirms (danger) before review_delete', async () => {
    render(ReviewCard, { props: { review: review() } });
    await fireEvent.click(screen.getByRole('button', { name: 'Delete note r7' }));
    expect(dialogs.top).toMatchObject({ type: 'confirm', title: 'Delete r7?', confirmLabel: 'Delete', danger: true });
    dialogs.close(dialogs.top!, false);
    await Promise.resolve(); await Promise.resolve();
    expect(op).not.toHaveBeenCalled();
    await fireEvent.click(screen.getByRole('button', { name: 'Delete note r7' }));
    dialogs.close(dialogs.top!, true);
    await vi.waitFor(() => expect(op).toHaveBeenCalledWith('review_delete', { id: 'r7' }));
  });

  it('Show / Side by side / the compare link navigate; onnavigate runs first', async () => {
    const nav = vi.fn();
    workspace.navigator = nav;
    const onnavigate = vi.fn();
    render(ReviewCard, { props: { onnavigate, review: review({ status: 'reopened', target: { frame: 1 }, compare_with: { asset: 'canvas:helmet_front' } }) } });
    await fireEvent.click(screen.getByRole('button', { name: 'Show' }));
    expect(nav).toHaveBeenLastCalledWith({ kind: 'canvas', name: 'helmet_side', frame: 1, tag: undefined, view: undefined }, undefined);
    await fireEvent.click(screen.getByRole('button', { name: 'Side by side' }));
    expect(nav).toHaveBeenCalledWith(expect.objectContaining({ kind: 'canvas', name: 'helmet_front' }), { slot: 'B' });
    await fireEvent.click(screen.getByRole('link', { name: 'canvas:helmet_front' }));
    expect(onnavigate).toHaveBeenCalledTimes(3);
    flushSync();
  });
});
