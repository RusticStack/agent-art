import { describe, expect, it } from 'vitest';
import {
  canvasStack, flagDraft, flagLabel, hatchRgba, hitTest, hue, laneFrameAt, laneFrameX, laneLayout, laneParts, mapLimit, normStack,
  outlineMask, outlineRgba, overlapMask, toggleSel, type StackEntry,
} from './stack';

/** RGBA alpha plane for a W×H grid from a string of '#' (opaque) and '.' rows. */
const plane = (rows: string[]): Uint8ClampedArray => {
  const W = rows[0].length, d = new Uint8ClampedArray(W * rows.length * 4);
  rows.forEach((r, y) => [...r].forEach((ch, x) => { if (ch === '#') d[(y * W + x) * 4 + 3] = 255; }));
  return d;
};
const e = (part: string, o: Partial<StackEntry> = {}): StackEntry => ({ part, z: 0, rule: '', hidden: false, parent: null, ...o });

describe('layers stack helpers', () => {
  it('normStack accepts the derived, rig_layers and rig_debug_render shapes', () => {
    expect(normStack([{ part: 'head', z: 5, rule: 'above torso', hidden: true, why_hidden: 'back view', parent: 'torso' }]))
      .toEqual([{ part: 'head', z: 5, rule: 'above torso', hidden: true, why_hidden: 'back view', parent: 'torso' }]);
    expect(normStack([{ name: 'arm_l', order: 2, reason: 'far side', visible: false }]))
      .toEqual([{ part: 'arm_l', z: 2, rule: 'far side', hidden: true, why_hidden: undefined, parent: null }]);
    expect(normStack([{ layer: 'leg', why: 'base' }, {}]))
      .toEqual([{ part: 'leg', z: 0, rule: 'base', hidden: false, why_hidden: undefined, parent: null }, { part: '#1', z: 1, rule: '', hidden: false, why_hidden: undefined, parent: null }]);
    expect(normStack(undefined)).toEqual([]);
  });

  it('canvasStack: bottom = layer 0, blend and opacity in the rule', () => {
    expect(canvasStack([{ name: 'base', visible: true, opacity: 1 }, { name: 'shade', visible: false, opacity: 0.5, blend: 'multiply' }])).toEqual([
      { part: 'base', z: 0, parent: null, hidden: false, index: 0, rule: 'layer 0' },
      { part: 'shade', z: 1, parent: null, hidden: true, index: 1, rule: 'layer 1 · multiply · 50%' },
    ]);
  });

  it('hue spreads over 300 degrees', () => {
    expect(hue(0, 4)).toBe('hsl(0,85%,55%)');
    expect(hue(2, 4)).toBe('hsl(150,85%,55%)');
    expect(hue(0, 0)).toBe('hsl(0,85%,55%)');
  });

  it('hit test returns the visible parts top first', () => {
    const a = [plane(['##', '..']), plane(['#.', '#.']), plane(['##', '##'])];
    expect(hitTest(a, 2, 0, 0, [0, 1, 2])).toEqual([2, 1, 0]);
    expect(hitTest(a, 2, 0, 0, [0, 1])).toEqual([1, 0]);
    expect(hitTest(a, 2, 1, 1, [0, 1])).toEqual([]);
    expect(hitTest(a, 2, 2, 0, [0, 1, 2])).toEqual([]);   // outside
    expect(hitTest(a, 2, 0, 5, [0, 1, 2])).toEqual([]);
  });

  it('overlap mask on a 4×4 fixture, and the hatch', () => {
    const a = [
      plane(['##..', '##..', '....', '....']),
      plane(['.##.', '.##.', '.##.', '....']),
      plane(['....', '....', '..##', '..##']),
    ];
    const m = overlapMask(a, 4, 4, [0, 1, 2]);
    expect([...m]).toEqual([
      0, 1, 0, 0,
      0, 1, 0, 0,
      0, 0, 1, 0,
      0, 0, 0, 0,
    ]);
    expect([...overlapMask(a, 4, 4, [0, 2])].every((v) => v === 0)).toBe(true);
    const h = hatchRgba(m, 4, 4, [1, 2, 3, 4]);
    expect([...h.slice(4, 8)]).toEqual([1, 2, 3, 4]);         // (1,0): odd
    expect([...h.slice((1 * 4 + 1) * 4, (1 * 4 + 1) * 4 + 4)]).toEqual([0, 0, 0, 0]);   // (1,1): even
    expect([...h.slice((2 * 4 + 2) * 4, (2 * 4 + 2) * 4 + 4)]).toEqual([0, 0, 0, 0]);   // (2,2): even
  });

  it('outline mask marks the edge pixels; the outline band paints the top sub-rows', () => {
    const a = plane(['....', '.###', '.###', '.###']);
    expect([...outlineMask(a, 4, 4)]).toEqual([
      0, 0, 0, 0,
      0, 1, 1, 1,
      0, 1, 0, 1,
      0, 1, 1, 1,
    ]);
    const m = new Uint8Array([1]);
    const d = outlineRgba(m, 1, 1, 8, 2, [9, 9, 9, 9]);
    expect(d.length).toBe(8 * 4);
    expect([...d.slice(0, 8)]).toEqual([9, 9, 9, 9, 9, 9, 9, 9]);
    expect([...d.slice(8)].every((v) => v === 0)).toBe(true);
  });

  it('lane layout coordinates', () => {
    const frames = [
      { stack: [e('torso'), e('arm'), e('head')] },
      { stack: [e('arm'), e('torso'), e('head', { hidden: true })] },
      { stack: [e('torso'), e('arm')] },
    ];
    const parts = laneParts(frames);
    expect(parts).toEqual(['torso', 'arm', 'head']);
    const L = laneLayout(frames, parts, 300);
    expect(L.height).toBe(58);   // 3 * 14 + 16
    expect(L.left).toBe(90);
    expect(L.plotW).toBe(200);
    expect(L.xs).toEqual([90, 190, 290]);
    expect(L.rankY(0)).toBe(48);
    expect(L.rankY(1)).toBe(34);
    expect(L.lanes[0]).toEqual({ part: 'torso', segs: [[[90, 48], [190, 34], [290, 48]]], labelY: 51 });
    expect(L.lanes[2]).toEqual({ part: 'head', segs: [[[90, 20]]], labelY: 23 });
    expect(laneFrameX(L, 1, 3)).toBe(190);
    expect(laneLayout([{ stack: [e('a')] }], ['a'], 300).xs).toEqual([190]);
    expect(laneLayout([], [], 300).height).toBe(40);
    expect(laneFrameAt(90, 300, 3)).toBe(0);
    expect(laneFrameAt(190, 300, 3)).toBe(1);
    expect(laneFrameAt(289, 300, 3)).toBe(2);
  });

  it('selection keeps two, first in first out; flag label', () => {
    let s: string[] = [];
    s = toggleSel(s, 'a'); s = toggleSel(s, 'b'); s = toggleSel(s, 'c');
    expect(s).toEqual(['b', 'c']);
    expect(toggleSel(s, 'b')).toEqual(['c']);
    expect(flagLabel(s)).toBe('Flag: b above c?');
    expect(flagLabel(['b'])).toBe('Flag layering (select 2)');
  });

  describe('flag draft', () => {
    const base = { rig: 'hero', canvasName: null, sel: ['arm', 'torso'], view: 'side', frame: 2 };
    const tail = { part: 'arm,torso', category: 'layering', note: 'arm should be above torso', priority: 'high' };
    it('rig clip: the output canvas, its absolute frame and the tag', () => {
      const tagFrames = (c: string, t: string) => (c === 'hero_side' && t === 'walk_side' ? [8, 9, 10, 11] : undefined);
      expect(flagDraft({ ...base, mode: 'rig', clip: 'hero_side/walk_side', tagFrames }))
        .toEqual({ asset: 'canvas:hero_side', frame: 10, view: 'side', tag: 'walk_side', ...tail });
      expect(flagDraft({ ...base, mode: 'rig', clip: 'hero_side/walk_side' }))
        .toEqual({ asset: 'canvas:hero_side', frame: 2, view: 'side', tag: 'walk_side', ...tail });
    });
    it('rig rest pose: the rig, no frame', () => {
      expect(flagDraft({ ...base, mode: 'rig', clip: '' })).toEqual({ asset: 'rig:hero', view: 'side', ...tail });
    });
    it('canvas: the canvas and the frame, no view', () => {
      expect(flagDraft({ ...base, mode: 'canvas', rig: null, canvasName: 'helmet', view: '', clip: '' }))
        .toEqual({ asset: 'canvas:helmet', frame: 2, ...tail });
    });
    it('needs exactly two parts', () => expect(flagDraft({ ...base, sel: ['arm'], mode: 'rig', clip: '' })).toBeNull());
  });

  it('mapLimit keeps order and caps parallelism', async () => {
    let live = 0, peak = 0;
    const out = await mapLimit([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 3, async (x) => {
      live++; peak = Math.max(peak, live);
      await new Promise((r) => setTimeout(r, 11 - x));
      live--;
      return x * 2;
    });
    expect(out).toEqual([2, 4, 6, 8, 10, 12, 14, 16, 18, 20]);
    expect(peak).toBe(3);
    expect(await mapLimit([], 6, async () => 1)).toEqual([]);
  });
});
