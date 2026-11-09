import { describe, expect, it } from 'vitest';
import { playList } from './playlist';

const anim = (direction: string, loop?: boolean) => ({ frames: 4, animations: { t: { frames: [0, 1, 2, 3], durations: [10, 20, 30, 40], direction, loop } as never } });

describe('playList', () => {
  it('forward', () => expect(playList(anim('forward'), 't')).toEqual({ frames: [0, 1, 2, 3], durations: [10, 20, 30, 40], loop: true }));
  it('reverse', () => expect(playList(anim('reverse'), 't')).toEqual({ frames: [3, 2, 1, 0], durations: [40, 30, 20, 10], loop: true }));
  it('pingpong', () => expect(playList(anim('pingpong'), 't').frames).toEqual([0, 1, 2, 3, 2, 1]));
  it('loop false', () => expect(playList(anim('forward', false), 't').loop).toBe(false));
  it('no tag: all frames at fps', () => expect(playList({ frames: 3 }, null, 5)).toEqual({ frames: [0, 1, 2], durations: [200, 200, 200], loop: true }));
  it('unknown tag and empty info', () => {
    expect(playList({ frames: 2 }, 'nope').frames).toEqual([0, 1]);
    expect(playList(null).frames).toEqual([0]);
  });
});
