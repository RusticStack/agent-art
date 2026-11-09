import { describe, expect, it } from 'vitest';
import { playList } from '@/lib/util/playlist';
import { anchorIndex, baseStatus, clipFrameLabel, clipList, clipScale, fitCanvas, MAX_AREA, MAX_SIDE, modeStatus, pickMode, splitClip } from './logic';

describe('rig logic', () => {
  describe('anchorIndex maps the shown frame back to the tag position', () => {
    const tag = (direction: string) => ({ frames: [4, 5, 6, 7], durations: [100, 100, 100, 100], direction });
    const mapped = (direction: string) => {
      const info = { animations: { walk: tag(direction) } };
      const pl = playList(info, 'walk');
      return pl.frames.map((f, idx) => anchorIndex(info.animations.walk.frames, f, idx));
    };
    it('forward', () => expect(mapped('forward')).toEqual([0, 1, 2, 3]));
    it('reverse', () => expect(mapped('reverse')).toEqual([3, 2, 1, 0]));
    it('pingpong', () => expect(mapped('pingpong')).toEqual([0, 1, 2, 3, 2, 1]));
    it('falls back to the play index for a frame outside the tag', () => expect(anchorIndex([4, 5], 9, 1)).toBe(1));
  });

  describe('pickMode', () => {
    it('defaults to clip when clips exist, pose when none', () => {
      expect(pickMode({ current: 'clip', hasClips: true, hasSkin: false })).toBe('clip');
      expect(pickMode({ current: 'clip', hasClips: false, hasSkin: false })).toBe('pose');
    });
    it('skin requested or current but absent falls back to pose', () => {
      expect(pickMode({ current: 'clip', requested: 'skin', hasClips: true, hasSkin: false })).toBe('pose');
      expect(pickMode({ current: 'skin', hasClips: true, hasSkin: false })).toBe('pose');
      expect(pickMode({ current: 'clip', requested: 'skin', hasClips: true, hasSkin: true })).toBe('skin');
    });
    it('an explicit request wins (parts, or clip shows the "no clips" note)', () => {
      expect(pickMode({ current: 'pose', requested: 'parts', hasClips: false, hasSkin: false })).toBe('parts');
      expect(pickMode({ current: 'pose', requested: 'clip', hasClips: false, hasSkin: false })).toBe('clip');
    });
    it('keeps the user mode across reloads', () => {
      expect(pickMode({ current: 'parts', hasClips: true, hasSkin: false })).toBe('parts');
    });
  });

  it('clip list and split', () => {
    const infos = { hero_side: { animations: { walk_side: { frames: [0], durations: [1] }, idle: { frames: [1], durations: [1] } } }, hero_front: null };
    expect(clipList(['hero_side', 'hero_front'], infos)).toEqual(['hero_side/walk_side', 'hero_side/idle']);
    expect(splitClip('hero_side/walk_side')).toEqual(['hero_side', 'walk_side']);
    expect(splitClip('')).toEqual(['', '']);
  });

  it('clip scale fits the stage, 1..16', () => {
    expect(clipScale(400, 300, 32, 32)).toBe(8);
    expect(clipScale(0, 0, 32, 32)).toBe(1);
    expect(clipScale(4000, 4000, 8, 8)).toBe(16);
  });

  it('fitCanvas clamps to the canvas limits', () => {
    expect(fitCanvas(32, 32, 8, 2)).toEqual({ scale: 8, dpr: 2, clamped: false });
    const a = fitCanvas(1024, 1024, 16, 1);
    expect(a.clamped).toBe(true);
    expect(1024 * a.scale).toBeLessThanOrEqual(MAX_SIDE);
    expect(1024 * 1024 * a.scale * a.scale).toBeLessThanOrEqual(MAX_AREA);
    const b = fitCanvas(10000, 10, 1, 2);
    expect(b.scale).toBe(1);
    expect(10000 * b.dpr).toBeLessThanOrEqual(MAX_SIDE);
    expect(b.clamped).toBe(true);
  });

  it('status texts', () => {
    const base = baseStatus('hero', { frame: [32, 32], parts: { torso: {}, head: { parent: 'torso' } }, views: ['side', 'front'], mirror: { left: 'side' } });
    expect(base).toBe('hero · frame 32×32 · 2 parts · views side, front (+ mirrored left)');
    expect(baseStatus('b', { frame: [8, 8], parts: {}, views: ['side'] })).toBe('b · frame 8×8 · 0 parts · views side');
    expect(modeStatus('B', { mode: 'pose', pose: '' })).toBe('B · pose rest · red dashes = ground line');
    expect(modeStatus('B', { mode: 'parts', name: 'hero' })).toBe('B · parts canvas hero_parts (red dot = pivot)');
    expect(modeStatus('B', { mode: 'skin', mesh: 'body', bone: '' })).toBe('B · skin body: drawing + lattice | dominant bone per pixel');
    expect(modeStatus('B', { mode: 'skin', mesh: 'body', bone: 'arm' })).toBe('B · skin body: drawing + lattice | weight of arm (blue 0 .. red 1)');
    expect(modeStatus('B', { mode: 'clip', clip: 'hero_side/walk_side', frames: 8, anchors: true })).toBe('B · clip hero_side/walk_side: 8 frames · skeleton from part anchors');
    expect(modeStatus('B', { mode: 'clip', clip: 'x/y', frames: 1, anchors: false })).toBe('B · clip x/y: 1 frames · no anchors on this clip');
    expect(clipFrameLabel(0, 8, 4)).toBe('1 / 8 · f4');
  });
});
