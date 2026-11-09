import { describe, expect, it } from 'vitest';
import { ZOOMS, bresenham, fitZoom, normBox, rectPoints, reviewPick, shapeCommand, snapZoom, stepZoom, strokeCommand } from './tools';

describe('zoom ladder', () => {
  it('steps on the ladder', () => {
    expect(stepZoom(8, 1)).toBe(10);
    expect(stepZoom(8, -1)).toBe(6);
    expect(stepZoom(64, 1)).toBe(64);
    expect(stepZoom(0.0625, -1)).toBe(0.0625);
  });
  it('steps from an off-ladder zoom to its neighbour in both directions', () => {
    expect(stepZoom(7, 1)).toBe(8);
    expect(stepZoom(7, -1)).toBe(6);
    expect(stepZoom(100, -1)).toBe(64);
    expect(stepZoom(0.3, 1)).toBe(0.5);
    expect(stepZoom(0.3, -1)).toBe(0.25);
  });
  it('fit picks the largest fitting step', () => {
    expect(fitZoom(800, 600, 32, 32)).toBe(16);   // (600-32)/32 = 17.75
    expect(fitZoom(800, 600, 32, 32, 3)).toBe(5); // 568/96 = 5.9
    expect(fitZoom(100, 100, 4096, 4096)).toBe(0.0625);
    expect(fitZoom(10000, 10000, 1, 1)).toBe(64);
  });
  it('snapZoom', () => {
    expect(snapZoom(8.5)).toBe(8);
    expect(snapZoom(9.5)).toBe(10);
    expect(snapZoom(1000)).toBe(64);
    expect(ZOOMS).toContain(snapZoom(0.4));
  });
});

describe('bresenham', () => {
  const octants: [number, number][] = [[5, 2], [2, 5], [-2, 5], [-5, 2], [-5, -2], [-2, -5], [2, -5], [5, -2]];
  it.each(octants)('octant to (%i, %i): connected, ends exact', (x, y) => {
    const pts = bresenham(0, 0, x, y);
    expect(pts[0]).toEqual([0, 0]);
    expect(pts[pts.length - 1]).toEqual([x, y]);
    expect(pts.length).toBe(Math.max(Math.abs(x), Math.abs(y)) + 1);
    for (let i = 1; i < pts.length; i++) {
      expect(Math.abs(pts[i][0] - pts[i - 1][0])).toBeLessThanOrEqual(1);
      expect(Math.abs(pts[i][1] - pts[i - 1][1])).toBeLessThanOrEqual(1);
    }
  });
  it('exact points for a shallow line', () => expect(bresenham(0, 0, 4, 2)).toEqual([[0, 0], [1, 1], [2, 1], [3, 2], [4, 2]]));
  it('single point', () => expect(bresenham(3, 3, 3, 3)).toEqual([[3, 3]]));
});

describe('shapes and commands', () => {
  it('rectangle outline vs filled', () => {
    expect(rectPoints([0, 0], [2, 2], false).length).toBe(8);
    expect(rectPoints([2, 2], [0, 0], true).length).toBe(9);
    expect(rectPoints([0, 0], [2, 2], false)).not.toContainEqual([1, 1]);
  });
  it('review box normalisation in every direction', () => {
    expect(normBox([1, 1], [3, 4])).toEqual([1, 1, 3, 4]);
    expect(normBox([3, 4], [1, 1])).toEqual([1, 1, 3, 4]);
    expect(normBox([3, 1], [1, 4])).toEqual([1, 1, 3, 4]);
    expect(normBox([1, 4], [3, 1])).toEqual([1, 1, 3, 4]);
    expect(reviewPick([2, 2], [2, 2])).toEqual({ point: [2, 2] });
    expect(reviewPick([2, 2], [0, 3])).toEqual({ region: [0, 2, 3, 2] });
  });
  it('commands per tool (exact objects)', () => {
    expect(shapeCommand('line', [0, 1], [5, 3], '#ff0000ff', false)).toEqual({ op: 'line', x1: 0, y1: 1, x2: 5, y2: 3, color: '#ff0000ff' });
    expect(shapeCommand('rect', [4, 4], [1, 2], '#00ff00ff', false)).toEqual({ op: 'rect', x: 1, y: 2, w: 4, h: 3, fill: false, color: '#00ff00ff' });
    expect(shapeCommand('rect', [1, 2], [4, 4], '#00ff00ff', true)).toEqual({ op: 'rect', x: 1, y: 2, w: 4, h: 3, color: '#00ff00ff' });
    expect(strokeCommand([[1, 1], [2, 1]], 'transparent')).toEqual({ op: 'pixels', color: 'transparent', points: [[1, 1], [2, 1]] });
  });
});
