import { describe, expect, it } from 'vitest';
import { playList } from '@/lib/util/playlist';
import { compassOf, compassSlots, directionGroups, layoutFor, SLOT } from './directions';
import { cellPixel, clampScale, fitScale, statusText } from './logic';

const obj = (m: Map<string, Record<string, string>>) => Object.fromEntries(m);

describe('directionGroups', () => {
  it('groups by the rig views (incl. mirrored); a tag without a suffix belongs to the first view', () => {
    const g = directionGroups(['walk', 'walk_front', 'walk_back', 'idle_front'], ['side', 'front', 'back', 'side_left'], 'side');
    expect(obj(g)).toEqual({ walk: { side: 'walk', front: 'walk_front', back: 'walk_back' }, idle: { front: 'idle_front' } });
    const m = directionGroups(['run_side', 'run_side_left'], ['side', 'front'].concat(['side_left']), 'side');
    expect(obj(m)).toEqual({ run: { side: 'run_side', side_left: 'run_side_left' } });
  });
  it('without a rig uses the compass names; no suffix -> default', () => {
    const g = directionGroups(['walk', 'walk_north', 'walk_s', 'spin'], null, null);
    expect(obj(g)).toEqual({ walk: { default: 'walk', north: 'walk_north', s: 'walk_s' }, spin: { default: 'spin' } });
  });
  it('nested suffixes: the longest view wins', () => {
    const g = directionGroups(['walk_front_side_left', 'walk_front_side', 'walk_side_left', 'walk_left'], null, null);
    expect(obj(g)).toEqual({ walk: { front_side_left: 'walk_front_side_left', front_side: 'walk_front_side', side_left: 'walk_side_left', left: 'walk_left' } });
  });
  it('compassOf', () => {
    expect(compassOf('back')).toBe('n');
    expect(compassOf('front_side_left')).toBe('sw');
    expect(compassOf('default')).toBeUndefined();
    expect(compassOf(undefined)).toBeUndefined();
  });
});

describe('layoutFor', () => {
  const tags = ['walk_side', 'walk_front', 'walk_back', 'wave'];
  const views = ['side', 'front', 'back'];
  it('3 compass views -> 3x3 compass with the base in the centre', () => {
    const l = layoutFor('walk_front', tags, views, 'side', true);
    expect(l.compass).toBe(true);
    expect([l.cols, l.rows]).toEqual([3, 3]);
    expect(l.base).toBe('walk');
    expect(l.cells.map((c) => c.label)).toEqual(['side', 'front', 'back']);
    const slots = compassSlots(l.cells);
    expect(slots[SLOT.e]).toBe(0);
    expect(slots[SLOT.s]).toBe(1);
    expect(slots[SLOT.n]).toBe(2);
    expect(slots[4]).toBeNull();
  });
  it('grid off or no tag -> one cell', () => {
    expect(layoutFor('walk_front', tags, views, 'side', false).cells).toEqual([{ tag: 'walk_front', label: 'walk_front' }]);
    expect(layoutFor('', tags, views, 'side', true).cells).toEqual([{ tag: '', label: 'all frames' }]);
    expect(layoutFor('wave', tags, views, 'side', true).cells.length).toBe(1);
  });
  it('non-compass names -> plain grid capped at 4 columns', () => {
    const t = ['a_v1', 'a_v2', 'a_v3', 'a_v4', 'a_v5'];
    const l = layoutFor('a_v2', t, ['v1', 'v2', 'v3', 'v4', 'v5'], 'v1', true);
    expect(l.compass).toBe(false);
    expect([l.cols, l.rows]).toEqual([4, 2]);
  });
  it('two compass views stay a plain grid; default view is not compass', () => {
    expect(layoutFor('walk_front', ['walk_front', 'walk_back'], null, null, true).compass).toBe(false);
    const l = layoutFor('walk', ['walk', 'walk_front', 'walk_back'], null, null, true);
    expect(l.compass).toBe(false);
    expect(l.cells[0]).toEqual({ tag: 'walk', label: 'walk', view: 'default' });
  });
});

describe('playList', () => {
  const info = (direction: string, n: number, loop?: boolean) => ({ frames: 8, animations: { t: { frames: [...Array(n).keys()].map((i) => i + 2), durations: [...Array(n).keys()].map((i) => (i + 1) * 10), direction, loop } } });
  it('reverse', () => expect(playList(info('reverse', 3), 't')).toEqual({ frames: [4, 3, 2], durations: [30, 20, 10], loop: true }));
  it('pingpong with 2 and 3 frames', () => {
    expect(playList(info('pingpong', 2), 't').frames).toEqual([2, 3]);
    expect(playList(info('pingpong', 3), 't')).toEqual({ frames: [2, 3, 4, 3], durations: [10, 20, 30, 20], loop: true });
  });
  it('untagged at fps; loop false', () => {
    expect(playList(info('forward', 2), '', 20)).toEqual({ frames: [0, 1, 2, 3, 4, 5, 6, 7], durations: Array(8).fill(50), loop: true });
    expect(playList(info('forward', 2, false), 't').loop).toBe(false);
  });
});

describe('anim logic', () => {
  it('fitScale: largest fitting integer, 1..16', () => {
    expect(fitScale({ width: 400, height: 300 }, 16, 16, 1, 1)).toBe(16);
    expect(fitScale({ width: 500, height: 500 }, 32, 32, 3, 3)).toBe(3);
    expect(fitScale({ width: 0, height: 0 }, 16, 16, 1, 1)).toBe(1);
    expect(fitScale({ width: 5000, height: 5000 }, 8, 8, 1, 1)).toBe(16);
  });
  it('clampScale keeps cells under the canvas limits', () => {
    expect(clampScale(4, 64, 64)).toEqual({ scale: 4, clamped: false });
    expect(clampScale(16, 1024, 64)).toEqual({ scale: 8, clamped: true });  // side limit: 8192 / 1024
    expect(clampScale(16, 600, 600)).toEqual({ scale: 9, clamped: true });  // area limit: sqrt(32e6 / 360000) = 9.4
    expect(clampScale(16, 4000, 4000)).toEqual({ scale: 1, clamped: true });
  });
  it('status line', () => {
    const info = { frames: 4, animations: { spin: { frames: [0, 1, 2, 3], durations: [100, 100, 100, 100], loop: false, direction: 'pingpong' } } };
    expect(statusText('spark', 'spin', info, 10, 1)).toBe('spark · spin: 4 frames, 400 ms, no loop, pingpong');
    expect(statusText('spark', '', info, 12, 1)).toBe('spark · 4 frames @ 12 fps');
    expect(statusText('hero', 'spin', { frames: 4, animations: { spin: { frames: [0], durations: [80] } } }, 10, 3, 2)).toBe('hero · spin: 1 frames, 80 ms · 3 views · scale capped at 2× (canvas size limit)');
  });
  it('cellPixel maps client points to image pixels', () => {
    expect(cellPixel({ left: 10, top: 20, width: 64, height: 64 }, 10, 20, 16, 16)).toEqual([0, 0]);
    expect(cellPixel({ left: 10, top: 20, width: 64, height: 64 }, 73, 83, 16, 16)).toEqual([15, 15]);
  });
});
