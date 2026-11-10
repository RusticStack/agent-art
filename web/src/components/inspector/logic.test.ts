import { describe, expect, it } from 'vitest';
import type { CanvasInfo, GraphEdge, Review } from '@/lib/api/types';
import {
  animChips, canvasRows, defaultCategory, defaultPriority, draftWhereLine, imageSrc, linkHash, META_MAX, metaSummary, paletteSwatches, previewScales,
  relationRows, reviewActions, reviewAddArgs, reviewExtras, snapshotRows, swatchKey, usedSwatches, whereLine,
} from './logic';

const form = { category: 'fix', priority: 'normal', note: '', compareWith: '', compareView: '', compareFrame: null };

describe('whereLine (review card)', () => {
  it('is empty without a target', () => {
    expect(whereLine(undefined)).toBe('');
    expect(whereLine({})).toBe('');
  });
  it('lists the parts in the legacy order', () => {
    expect(whereLine({ tag: 'walk', frame: 0, view: 'front', layer: 'ink', part: 'arm', time: [0.5, 1.25], region: [1, 2, 3, 4] }))
      .toBe('tag walk · frame 0 · view front · layer ink · part arm · 0.50–1.25 s · [1,2,3,4]');
  });
  it('shows frame 0 and a pin point', () => {
    expect(whereLine({ frame: 0 })).toBe('frame 0');
    expect(whereLine({ point: [3, 4] })).toBe('pin (3,4)');
  });
});

describe('draftWhereLine (note dialog)', () => {
  it('formats box, pin, parts, time and the free where text', () => {
    expect(draftWhereLine({ asset: 'canvas:a', tag: 'idle', frame: 2, view: 'left', layer: 'base', part: 'head above body', region: [1, 2, 3, 4], point: [5, 6], time: [0, 1], where: 'screen 40%,60%' }))
      .toBe('tag idle · frame 2 · view left · layer base · parts head above body · box [1,2,3,4] · pin (5,6) · 0.00–1.00 s · screen 40%,60%');
  });
  it('is empty for a bare asset', () => { expect(draftWhereLine({ asset: 'model:x' })).toBe(''); });
});

describe('dialog defaults', () => {
  it('category: preset, else inconsistent with a compare target, else fix', () => {
    expect(defaultCategory({ asset: 'a' })).toBe('fix');
    expect(defaultCategory({ asset: 'a', compare_with: 'canvas:b' })).toBe('inconsistent');
    expect(defaultCategory({ asset: 'a', category: 'layering', compare_with: 'canvas:b' })).toBe('layering');
  });
  it('priority: preset or normal', () => {
    expect(defaultPriority({ asset: 'a' })).toBe('normal');
    expect(defaultPriority({ asset: 'a', priority: 'high' })).toBe('high');
  });
});

describe('reviewAddArgs (R3)', () => {
  it('trims the note and appends the where text', () => {
    expect(reviewAddArgs({ asset: 'model:m', where: 'screen 1%,2%' }, { ...form, note: '  too dark ' }).note).toBe('too dark (at screen 1%,2%)');
    expect(reviewAddArgs({ asset: 'model:m', where: 'screen 1%,2%' }, form).note).toBe('(at screen 1%,2%)');
    expect(reviewAddArgs({ asset: 'canvas:a' }, form).note).toBe('');
  });
  it('copies only the target fields that are present (frame 0 included)', () => {
    const a = reviewAddArgs({ asset: 'canvas:a', frame: 0, region: [1, 2, 3, 4], image: 'data:x', clip: 'c', where: 'w', category: 'style', compare_view: 'v' }, { ...form, category: 'redo', priority: 'high' });
    expect(a).toEqual({ asset: 'canvas:a', category: 'redo', priority: 'high', note: '(at w)', frame: 0, region: [1, 2, 3, 4], image: 'data:x', clip: 'c' });
    expect('where' in a).toBe(false);
    expect('compare_with' in a).toBe(false);
  });
  it('compare_with shapes: asset only, + view, + frame (0 kept, blank and NaN dropped)', () => {
    const d = { asset: 'canvas:a' };
    expect(reviewAddArgs(d, { ...form, compareWith: ' canvas:b ' }).compare_with).toEqual({ asset: 'canvas:b' });
    expect(reviewAddArgs(d, { ...form, compareWith: 'canvas:b', compareView: ' side ' }).compare_with).toEqual({ asset: 'canvas:b', view: 'side' });
    expect(reviewAddArgs(d, { ...form, compareWith: 'canvas:b', compareFrame: 0 }).compare_with).toEqual({ asset: 'canvas:b', frame: 0 });
    expect(reviewAddArgs(d, { ...form, compareWith: 'canvas:b', compareFrame: '3' }).compare_with).toEqual({ asset: 'canvas:b', frame: 3 });
    expect(reviewAddArgs(d, { ...form, compareWith: 'canvas:b', compareFrame: '' }).compare_with).toEqual({ asset: 'canvas:b' });
    expect(reviewAddArgs(d, { ...form, compareWith: 'canvas:b', compareFrame: 'x' }).compare_with).toEqual({ asset: 'canvas:b' });
    expect(reviewAddArgs(d, { ...form, compareWith: '   ', compareView: 'v' }).compare_with).toBeUndefined();
  });
});

describe('metaSummary (I4)', () => {
  it('null when there is no meta', () => {
    expect(metaSummary(undefined)).toBeNull();
    expect(metaSummary({})).toBeNull();
  });
  it('summarises anchors and a rig object, keeps a rig name', () => {
    const s = metaSummary({ anchors: { hand: [{ x: [1] }, { x: [2] }, { x: [3] }] }, rig: { parts: { a: {}, b: {} } }, texture: 't' })!;
    expect(JSON.parse(s)).toEqual({ anchors: { hand: '3 frames' }, rig: 'rig definition (2 parts)', texture: 't' });
    expect(JSON.parse(metaSummary({ rig: 'hero' })!)).toEqual({ rig: 'hero' });
    expect(JSON.parse(metaSummary({ rig: {} })!)).toEqual({ rig: 'rig definition (0 parts)' });
  });
  it('caps the text at 4000 characters', () => {
    const s = metaSummary({ notes: 'x'.repeat(10_000) })!;
    expect(s.length).toBe(META_MAX);
    expect(s.startsWith('{\n "notes": "xxx')).toBe(true);
  });
});

describe('relationRows (I12)', () => {
  const e = (from: string, rel: string, to: string, extra: Partial<GraphEdge> = {}): GraphEdge => ({ from, rel, to, ...extra });
  it('out then in, without layer_of, non-derived first (stable), attrs as {k:v}', () => {
    const r = relationRows({
      out: [e('canvas:a', 'uses', 'canvas:p', { derived: true }), e('canvas:a', 'layer_of', 'layer:a/x'), e('canvas:a', 'variant_of', 'canvas:b', { attrs: { view: 'side', n: 2 } })],
      in: [e('project:p', 'contains', 'canvas:a', { derived: true }), e('model:m', 'textured_by', 'canvas:a')],
    });
    expect(r.rows.map((x) => `${x.dir} ${x.rel} ${x.other}${x.attrs}${x.derived ? ' d' : ''}`)).toEqual([
      'out variant_of canvas:b {view:side,n:2}', 'in textured_by model:m', 'out uses canvas:p d', 'in contains project:p d',
    ]);
    expect(r.more).toBe(0);
    expect(r.total).toBe(4);
  });
  it('caps at 40 and counts the rest', () => {
    const out = Array.from({ length: 45 }, (_, i) => e('canvas:a', 'rel', `canvas:n${i}`));
    const r = relationRows({ out, in: [] });
    expect(r.rows).toHaveLength(40);
    expect(r.more).toBe(5);
    expect(r.rows[0].other).toBe('canvas:n0');
  });
  it('empty for no node', () => { expect(relationRows(null)).toEqual({ rows: [], more: 0, total: 0 }); });
});

const review = (over: Partial<Review> = {}): Review => ({
  id: 'r1', asset: 'canvas:a', target: {}, category: 'fix', priority: 'normal', note: 'n', status: 'open', by: 'user', created: 1, updated: 1, history: [], ...over,
});

describe('reviewActions / reviewExtras (R4)', () => {
  it('actions per status', () => {
    const v = (status: Review['status'], cw = false) => {
      const a = reviewActions(review({ status, compare_with: cw ? { asset: 'canvas:b' } : undefined }));
      return [a.accept, a.reopen, a.sideBySide];
    };
    expect(v('open')).toEqual([false, false, false]);
    expect(v('in_progress')).toEqual([false, false, false]);
    expect(v('reopened')).toEqual([false, false, false]);
    expect(v('fixed')).toEqual([true, true, false]);
    expect(v('accepted', true)).toEqual([false, true, true]);
  });
  it('last reply and the last 3 images with captions', () => {
    const x = reviewExtras(review({ history: [
      { ts: 1, by: 'user', img: 'a.png' }, { ts: 2, by: 'agent', reply: 'done', status: 'fixed', img: 'b.png', version: 3 },
      { ts: 3, by: 'agent', img: 'c.png', version: 4 }, { ts: 4, by: 'user', status: 'reopened', reply: 'still off', img: 'd.png' },
    ] }));
    expect(x.reply).toBe('user: still off');
    expect(x.images).toEqual([{ img: 'b.png', caption: 'noted' }, { img: 'c.png', caption: 'v4' }, { img: 'd.png', caption: 'reopened' }]);
    expect(reviewExtras(review({ history: [{ ts: 1, by: 'user', img: 'a.png' }] })).images).toEqual([{ img: 'a.png', caption: 'v' }]);
    expect(reviewExtras(review()).reply).toBeNull();
  });
});

describe('canvas section helpers', () => {
  const info: CanvasInfo = {
    name: 'a', width: 16, height: 64, frames: 4, frameHeight: 16, activeLayer: 0, layers: [{ index: 0, name: 'base', visible: true, opacity: 1 }],
    animations: { walk: { frames: [0, 1, 2], durations: [100, 100, 150], loop: false }, idle: { frames: [3], durations: [200] } },
    project: 'p', palette: { o: '#000000ff', skin: '#ffccaaff' }, inheritedPalette: { o: '#111111ff', g: '#00ff00ff' }, undo: 2, redo: 0, version: 7,
    colors: { unique: 5, top: [{ color: '#000000ff', count: 30 }] },
  };
  it('table rows', () => {
    expect(canvasRows(info)).toEqual([['size', '16×16'], ['frames', 4], ['layers', 1], ['colours', 5], ['project', 'p'], ['undo / redo', '2 / 0'], ['version', 7]]);
    expect(canvasRows({ ...info, frames: 1, frameHeight: null })[1]).toEqual(['frames', '']);
  });
  it('palette: inherited then own (own wins), used colours, short keys', () => {
    expect(paletteSwatches(info).map((s) => `${s.key}=${s.color}`)).toEqual(['o=#000000ff', 'g=#00ff00ff', 'skin=#ffccaaff']);
    expect(usedSwatches(info)).toEqual([{ color: '#000000ff', title: '#000000ff · 30 px' }]);
    expect(swatchKey('o')).toBe('o');
    expect(swatchKey('ab')).toBe('ab');
    expect(swatchKey('skin')).toBeNull();
    expect(swatchKey(undefined)).toBeNull();
  });
  it('animation chips', () => {
    expect(animChips(info)).toEqual([
      { tag: 'walk', label: 'walk · 3f', title: '350 ms, no loop' },
      { tag: 'idle', label: 'idle · 1f', title: '200 ms' },
    ]);
  });
  it('preview scales', () => {
    expect(previewScales(16, 16)).toEqual({ small: 2, big: 8 });
    expect(previewScales(256, 32)).toEqual({ small: 1, big: 1 });
  });
  it('snapshot rows', () => {
    expect(snapshotRows('a', null)).toEqual([['canvas', 'a'], ['version', undefined], ['size', 'expired'], ['frames', undefined]]);
  });
});

describe('links and images', () => {
  it('linkHash', () => {
    expect(linkHash('canvas:spark')).toBe('#spark');
    expect(linkHash('model:rifle')).toBe('#model:rifle');
    expect(linkHash('anim:hero/walk')).toBe('#hero');
    expect(linkHash('group:armor')).toBe('#graph');
  });
  it('imageSrc', () => {
    expect(imageSrc('data:image/png;base64,AAA')).toBe('data:image/png;base64,AAA');
    expect(imageSrc('AAA')).toBe('data:image/png;base64,AAA');
  });
});
