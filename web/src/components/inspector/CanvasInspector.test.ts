// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import type { CanvasInfo } from '@/lib/api/types';
import CanvasInspector from './CanvasInspector.svelte';

const op = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api/client', () => ({ op, api: {} }));

const info = (over: Partial<CanvasInfo> = {}): CanvasInfo => ({
  name: 'pauldron', width: 16, height: 16, frames: 1, frameHeight: null, activeLayer: 1,
  layers: [
    { index: 0, name: 'base', visible: true, opacity: 1 },
    { index: 1, name: 'shade', visible: false, opacity: 0.5, blend: 'multiply' },
  ],
  animations: { idle: { frames: [0], durations: [120] } }, project: null,
  palette: { o: '#101010ff', metal: '#8899aaff' }, inheritedPalette: null, undo: 0, redo: 0, version: 3,
  colors: { unique: 2, top: [{ color: '#101010ff', count: 12 }] },
  meta: { anchors: { hand: [{}, {}] } },
  ...over,
});

beforeEach(() => { op.mockReset(); op.mockResolvedValue({}); });
afterEach(() => { cleanup(); });

function setup(i = info()) {
  const onsetcolor = vi.fn(), onopen = vi.fn();
  const r = render(CanvasInspector, { props: { info: i, onsetcolor, onopen } });
  return { ...r, onsetcolor, onopen };
}

describe('CanvasInspector layers', () => {
  it('lists layers top first with active / hidden state and opacity', () => {
    const { container } = setup();
    const rows = [...container.querySelectorAll('.layers li')];
    expect(rows.map((li) => li.querySelector('.lname')!.textContent!.trim())).toEqual(['shade (50%)', 'base']);
    expect(rows[0].classList.contains('active')).toBe(true);
    expect(rows[0].classList.contains('hidden')).toBe(true);
    expect(rows[1].classList.contains('active')).toBe(false);
    expect((rows[0].querySelector('select') as HTMLSelectElement).value).toBe('multiply');
    expect((rows[1].querySelector('select') as HTMLSelectElement).value).toBe('normal');
    expect(rows[0].querySelector('.eye')!.getAttribute('aria-pressed')).toBe('false');
  });

  it('name click selects, eye toggles visibility, blend select sets the blend', async () => {
    setup();
    await fireEvent.click(screen.getByRole('button', { name: 'base' }));
    expect(op).toHaveBeenLastCalledWith('layer', { canvas: 'pauldron', action: 'select', layer: 0 });
    await fireEvent.click(screen.getByRole('button', { name: 'Toggle visibility of shade' }));
    expect(op).toHaveBeenLastCalledWith('layer', { canvas: 'pauldron', action: 'visibility', layer: 1 });
    const sel = screen.getByRole('combobox', { name: 'Blend mode of base' }) as HTMLSelectElement;
    sel.value = 'screen';
    await fireEvent.change(sel);
    expect(op).toHaveBeenLastCalledWith('layer', { canvas: 'pauldron', action: 'blend', layer: 0, blend: 'screen' });
    expect(op).toHaveBeenCalledTimes(3);
  });

  it('a failing op does not throw', async () => {
    op.mockRejectedValue(new Error('nope'));
    setup();
    await fireEvent.click(screen.getByRole('button', { name: 'base' }));
    expect(op).toHaveBeenCalledOnce();
  });

  it('"Layer stack / debug" opens the layers view', async () => {
    const { onopen } = setup();
    await fireEvent.click(screen.getByRole('button', { name: 'Layer stack / debug' }));
    expect(onopen).toHaveBeenCalledWith({ kind: 'canvas', name: 'pauldron', view: 'layers' });
  });
});

describe('CanvasInspector palette, animations, meta, project', () => {
  it('swatches set the colour; short keys are printed', async () => {
    const { container, onsetcolor } = setup();
    const sw = [...container.querySelectorAll<HTMLButtonElement>('.palette:not(.used) .swatch')];
    expect(sw.map((b) => b.querySelector('.k')?.textContent ?? null)).toEqual(['o', null]);
    await fireEvent.click(sw[1]);
    expect(onsetcolor).toHaveBeenLastCalledWith('#8899aaff');
    await fireEvent.click(container.querySelector<HTMLButtonElement>('.palette.used .swatch')!);
    expect(onsetcolor).toHaveBeenLastCalledWith('#101010ff');
    expect(op).not.toHaveBeenCalled();
  });

  it('animation chips open the animation view; meta is JSON with anchors summarised', async () => {
    const { container, onopen } = setup();
    await fireEvent.click(screen.getByRole('button', { name: 'idle · 1f' }));
    expect(onopen).toHaveBeenCalledWith({ kind: 'canvas', name: 'pauldron', view: 'anim', tag: 'idle' });
    const pre = container.querySelector('.meta-json pre.json')!;
    expect(JSON.parse(pre.textContent!)).toEqual({ anchors: { hand: '2 frames' } });
    expect(pre.querySelector('.j-key')).not.toBeNull();
  });

  it('project block and its Overview button', async () => {
    const { container, onopen } = setup();
    expect(container.textContent).not.toContain('Project p1');
    cleanup();
    const onopen2 = vi.fn();
    render(CanvasInspector, { props: { info: info({ project: 'p1' }), project: { name: 'p1', description: 'Desc', notes: 'N', canvases: [] }, onsetcolor: vi.fn(), onopen: onopen2 } });
    expect(screen.getByRole('region', { name: 'Project p1' }).textContent).toContain('Desc\n\nN');
    await fireEvent.click(screen.getByRole('button', { name: 'Overview (O)' }));
    expect(onopen2).toHaveBeenCalledWith({ kind: 'project', name: 'p1' });
    void onopen;
  });
});
