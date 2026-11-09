import { describe, expect, it } from 'vitest';
import { descriptionLine, planTileUpdate, shouldAutoScroll } from './logic';

describe('project logic', () => {
  it('description line', () => {
    const c = [{ name: 'a' }, { name: 'b' }];
    expect(descriptionLine({ canvases: c }, 0)).toBe('2 canvases');
    expect(descriptionLine({ canvases: c, description: 'Armour', meta: { minecraft: '1.21' } }, 1)).toBe('2 canvases · 1 hidden · Minecraft 1.21 — Armour');
  });

  const tiles = new Set(['a', 'b']);
  const visible = () => false;
  const change = (o: object) => ({ type: 'change', canvas: 'a', project: 'p', version: 3, ts: 9, source: 'agent', op: 'draw', dirty: null, ...o });
  it.each([
    ['project event for this project', { type: 'project', project: 'p', source: 'agent', ts: 1 }, { action: 'reload' }],
    ['project event for another', { type: 'project', project: 'q', source: 'agent', ts: 1 }, { action: 'none' }],
    ['resync', { type: 'resync' }, { action: 'reload' }],
    ['deleted tile', { type: 'deleted', canvas: 'b', source: 'agent', ts: 1 }, { action: 'remove', name: 'b' }],
    ['deleted unknown', { type: 'deleted', canvas: 'z', source: 'agent', ts: 1 }, { action: 'none' }],
    ['agent change', change({}), { action: 'update', name: 'a', version: '3-9', isNew: false, flash: true }],
    ['user change', change({ source: 'user' }), { action: 'update', name: 'a', version: '3-9', isNew: false, flash: false }],
    ['new canvas', change({ canvas: 'c' }), { action: 'update', name: 'c', version: '3-9', isNew: true, flash: true }],
    ['other project', change({ project: 'q' }), { action: 'none' }],
  ])('%s', (_n, ev, want) => expect(planTileUpdate(ev as never, 'p', tiles, visible)).toEqual(want));

  it('hidden canvases get no tile', () => {
    expect(planTileUpdate(change({ canvas: 'c' }) as never, 'p', tiles, (id) => id === 'canvas:c')).toEqual({ action: 'none' });
  });
  it('auto-scroll pauses after a manual scroll in project follow mode', () => {
    expect(shouldAutoScroll('project', 1000, 2000)).toBe(false);
    expect(shouldAutoScroll('project', 1000, 5000)).toBe(true);
    expect(shouldAutoScroll('canvas', 1000, 2000)).toBe(true);
  });
});
