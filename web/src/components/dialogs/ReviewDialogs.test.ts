// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import type { Review } from '@/lib/api/types';
import { assets } from '@/state/assets.svelte';
import { reviews } from '@/state/reviews.svelte';
import { workspace } from '@/state/workspace.svelte';
import type { ReviewDraft } from '@/viewers/types';
import ReviewListDialog from './ReviewListDialog.svelte';
import ReviewNoteDialog from './ReviewNoteDialog.svelte';

const op = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api/client', () => ({ op, api: {} }));

const spec = (draft: ReviewDraft) => ({ type: 'reviewNote' as const, draft, resolve: () => {} });
const open = async (draft: ReviewDraft) => {
  const onclose = vi.fn();
  render(ReviewNoteDialog, { props: { spec: spec(draft), onclose } });
  const dlg = await screen.findByRole('dialog', { name: 'Review note' });
  return { dlg, onclose };
};

beforeEach(() => {
  op.mockReset();
  assets.set({ canvases: [{ name: 'helmet_front' }, { name: 'helmet_side' }], models: [{ name: 'rifle' }], rigs: [], audio: [{ name: 'shot' }], projects: [], groups: [], exports: [], home: '/', flags: { superseded: [], orphans: [] }, tags: {} } as never);
});
afterEach(() => { cleanup(); workspace.navigator = null; });

describe('ReviewNoteDialog', () => {
  it('shows the asset, the where line and the defaults; the note is prefilled', async () => {
    const { dlg } = await open({ asset: 'canvas:pauldron', region: [1, 2, 3, 4], frame: 0, note: 'pre' });
    expect(dlg.textContent).toContain('canvas:pauldron');
    expect(dlg.textContent).toContain('frame 0 · box [1,2,3,4]');
    const [cat, pri] = [...dlg.querySelectorAll('select')];
    expect(cat.value).toBe('fix');
    expect(pri.value).toBe('normal');
    expect([...cat.options].map((o) => o.textContent)).toEqual(['Fix', 'Redo', 'Inconsistent across views', 'Layering', 'Style', 'Question', 'Approve']);
    expect((dlg.querySelector('textarea') as HTMLTextAreaElement).value).toBe('pre');
    expect(dlg.querySelector('textarea')!.getAttribute('placeholder')).toBe('What is wrong / what should change?');
    expect(dlg.querySelector('img')).toBeNull();
  });

  it('presets: category / priority, compare target -> inconsistent, suggestions in a datalist', async () => {
    const { dlg } = await open({ asset: 'canvas:helmet_side', compare_with: 'canvas:helmet_front', compare_view: 'side' });
    const [cat] = [...dlg.querySelectorAll('select')];
    expect(cat.value).toBe('inconsistent');
    const cmp = screen.getByRole('combobox', { name: 'Compare with' }) as HTMLInputElement;
    expect(cmp.value).toBe('canvas:helmet_front');
    const list = document.getElementById(cmp.getAttribute('list')!)!;
    expect(list.tagName).toBe('DATALIST');
    expect([...list.querySelectorAll('option')].map((o) => o.value)).toEqual(['canvas:helmet_front', 'canvas:helmet_side', 'model:rifle', 'audio:shot']);
    expect((screen.getByRole('textbox', { name: 'Compare view' }) as HTMLInputElement).value).toBe('side');
    cleanup();
    const again = await open({ asset: 'rig:hero', category: 'layering', priority: 'high' });
    const sel = [...again.dlg.querySelectorAll('select')];
    expect(sel.map((s) => s.value)).toEqual(['layering', 'high']);
  });

  it('shows the attached crop as a data: image', async () => {
    const { dlg } = await open({ asset: 'model:rifle', image: 'data:image/png;base64,iVBORw0KGgo=', where: 'screen 40%,60%', view: 'orbit' });
    const img = dlg.querySelector('img')!;
    expect(img.getAttribute('src')).toBe('data:image/png;base64,iVBORw0KGgo=');
    expect(img.getAttribute('alt')).toBe('Attached view of model:rifle');
    expect(dlg.textContent).toContain('view orbit · screen 40%,60%');
  });

  it('Add note sends review_add (R3) and closes with the id', async () => {
    op.mockResolvedValue({ text: 'added', id: 'r9' });
    const { dlg, onclose } = await open({ asset: 'model:rifle', image: 'data:x', where: 'screen 1%,2%', view: 'orbit', clip: 'fire' });
    await fireEvent.input(dlg.querySelector('textarea')!, { target: { value: ' muzzle too long ' } });
    const [cat, pri] = [...dlg.querySelectorAll('select')];
    await fireEvent.change(cat, { target: { value: 'style' } });
    await fireEvent.change(pri, { target: { value: 'high' } });
    await fireEvent.input(screen.getByRole('combobox', { name: 'Compare with' }), { target: { value: 'model:rifle_v2' } });
    await fireEvent.input(screen.getByRole('spinbutton', { name: 'Compare frame' }), { target: { value: '0' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Add note' }));
    await vi.waitFor(() => expect(onclose).toHaveBeenCalledWith({ id: 'r9' }));
    expect(op).toHaveBeenCalledWith('review_add', {
      asset: 'model:rifle', category: 'style', priority: 'high', note: 'muzzle too long (at screen 1%,2%)', view: 'orbit', image: 'data:x', clip: 'fire',
      compare_with: { asset: 'model:rifle_v2', frame: 0 },
    });
  });

  it('Ctrl+Enter in the note submits; an error keeps the dialog open', async () => {
    op.mockRejectedValueOnce(new Error('review_add: bad'));
    const { dlg, onclose } = await open({ asset: 'canvas:a' });
    const ta = dlg.querySelector('textarea')!;
    await fireEvent.keyDown(ta, { key: 'Enter', ctrlKey: true });
    await vi.waitFor(() => expect(op).toHaveBeenCalledOnce());
    await Promise.resolve();
    expect(onclose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'Review note' })).toBeTruthy();
    op.mockResolvedValueOnce({ text: 'added', id: 'r2' });
    await fireEvent.keyDown(ta, { key: 'Enter', ctrlKey: true });
    await vi.waitFor(() => expect(onclose).toHaveBeenCalledWith({ id: 'r2' }));
    await fireEvent.keyDown(ta, { key: 'Enter' });
    expect(op).toHaveBeenCalledTimes(2);
  });

  it('Cancel closes with null', async () => {
    const { onclose } = await open({ asset: 'canvas:a' });
    await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onclose).toHaveBeenCalledWith(null);
    expect(op).not.toHaveBeenCalled();
  });
});

const rv = (id: string, status: Review['status'], updated: number, asset = 'canvas:a'): Review =>
  ({ id, asset, target: {}, category: 'fix', priority: 'normal', note: `note ${id}`, status, by: 'user', created: 1, updated, history: [] });

describe('ReviewListDialog', () => {
  it('title counts open notes; active first then newest; asset prefix; a card action closes it', async () => {
    reviews.list = [rv('r1', 'accepted', 50), rv('r2', 'open', 10, 'model:m'), rv('r3', 'fixed', 99), rv('r4', 'reopened', 20)];
    const onclose = vi.fn();
    const nav = vi.fn();
    workspace.navigator = nav;
    render(ReviewListDialog, { props: { spec: { type: 'reviewList' }, onclose } });
    const dlg = await screen.findByRole('dialog', { name: 'Review notes · 2 open' });
    expect([...dlg.querySelectorAll('.review-card .rc-id')].map((e) => e.textContent)).toEqual(['r4', 'r2', 'r3', 'r1']);
    expect([...dlg.querySelectorAll('.rc-asset')].map((e) => e.textContent)).toEqual(['canvas:a', 'model:m', 'canvas:a', 'canvas:a']);
    await fireEvent.click(dlg.querySelectorAll<HTMLButtonElement>('.review-card .rc-actions button')[0]);
    expect(onclose).toHaveBeenCalledOnce();
    expect(nav).toHaveBeenCalledWith({ kind: 'canvas', name: 'a', frame: undefined, tag: undefined, view: undefined }, undefined);
  });

  it('empty text', async () => {
    reviews.list = [];
    render(ReviewListDialog, { props: { spec: { type: 'reviewList' }, onclose: vi.fn() } });
    const dlg = await screen.findByRole('dialog', { name: 'Review notes · 0 open' });
    expect(dlg.textContent).toContain('No review notes yet. Press M, then drag a box (or click a pin) on what needs fixing.');
  });
});
