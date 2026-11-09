// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBitmap, installCanvasStub, sizeElement } from '@/test/canvasStub';
import { PixelView, type PixelViewOptions } from './PixelView';

function setup(opts: PixelViewOptions = {}, img = fakeBitmap(16, 16)) {
  const host = document.createElement('div');
  document.body.append(host);
  sizeElement(host, 400, 300);
  const v = new PixelView(host, opts);
  sizeElement(v.canvas, 400, 300);
  v.resize();
  v.setImage(img);
  return { v, host };
}
const ptr = (type: string, x: number, y: number, o: Partial<PointerEventInit> = {}) => {
  const e = new MouseEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true, ...o }) as MouseEvent & { pointerId: number };
  Object.defineProperty(e, 'pointerId', { value: (o as { pointerId?: number }).pointerId ?? 1 });
  return e;
};
/** Client point of the centre of art pixel (x, y). */
const at = (v: PixelView, x: number, y: number): [number, number] => [v.ox + (x + 0.5) * v.zoom, v.oy + (y + 0.5) * v.zoom];

describe('PixelView', () => {
  beforeEach(() => {
    installCanvasStub();
    HTMLCanvasElement.prototype.setPointerCapture = () => {};
  });
  afterEach(() => { vi.restoreAllMocks(); document.body.replaceChildren(); });

  it('fits on load and keeps the pixel under the cursor when zooming', () => {
    const { v } = setup();
    expect(v.zoom).toBe(16); // (300-32)/16 = 16.75
    expect(v.autoFit).toBe(true);
    const before = v.pixelAt({ clientX: 150, clientY: 100 });
    v.setZoom(32, 150, 100);
    expect(v.autoFit).toBe(false);
    expect(v.pixelAt({ clientX: 150, clientY: 100 })).toEqual(before);
  });

  it('pixelAt: outside is null; tile mode wraps', () => {
    const { v } = setup();
    expect(v.pixelAt({ clientX: v.ox - 1, clientY: v.oy })).toBeNull();
    expect(v.pixelAt({ clientX: v.ox + 1, clientY: v.oy + 1 })).toEqual([0, 0]);
    v.tile = true; v.fit();
    const [x, y] = [v.ox + (16 + 3.5) * v.zoom, v.oy + (32 + 2.5) * v.zoom];
    expect(v.pixelAt({ clientX: x, clientY: y })).toEqual([3, 2]);
    expect(v.pixelAt({ clientX: v.ox + 48 * v.zoom + 1, clientY: v.oy })).toBeNull();
  });

  it('getView / setView round trip; setView does not call onView', () => {
    const onView = vi.fn();
    const { v } = setup({ onView });
    v.setZoom(8, 200, 150);
    expect(onView).toHaveBeenCalledTimes(1);
    const s = v.getView();
    v.setView({ zoom: 32, cx: 1, cy: 1 });
    expect(onView).toHaveBeenCalledTimes(1);
    v.setView(s);
    expect(v.getView().zoom).toBe(s.zoom);
    expect(v.getView().cx).toBeCloseTo(s.cx, 0);
    expect(v.getView().cy).toBeCloseTo(s.cy, 0);
    v.setView({ zoom: 8.5, cx: 0, cy: 0 });
    expect(v.zoom).toBe(8);
  });

  it('setOverlay with a different size is ignored', () => {
    const { v } = setup();
    v.setOverlay({ image: fakeBitmap(8, 8), rect: { x: 0, y: 0, w: 8, h: 8 }, mode: 'swipe' });
    expect(v.overlayMode).toBeNull();
    v.setOverlay({ image: fakeBitmap(16, 16), rect: { x: 0, y: 0, w: 16, h: 16 }, mode: 'swipe' });
    expect(v.overlayMode).toBe('swipe');
    v.setOverlay(null);
    expect(v.overlayMode).toBeNull();
  });

  it('pencil stroke sends one pixels command with the joined points', async () => {
    const onCommands = vi.fn();
    const { v } = setup({ editable: true, getTool: () => 'pencil', getColor: () => ({ hex: '#ff0000', hex8: '#ff0000ff' }), onCommands });
    v.canvas.dispatchEvent(ptr('pointerdown', ...at(v, 1, 1)));
    v.canvas.dispatchEvent(ptr('pointermove', ...at(v, 4, 1)));
    v.canvas.dispatchEvent(ptr('pointerup', ...at(v, 4, 1)));
    await Promise.resolve();
    expect(onCommands).toHaveBeenCalledWith([{ op: 'pixels', color: '#ff0000ff', points: [[1, 1], [2, 1], [3, 1], [4, 1]] }], 'user pencil');
  });

  it('eraser, fill, line, rect (shift = filled), picker', async () => {
    let tool = 'eraser';
    const onCommands = vi.fn(), onPick = vi.fn();
    const { v } = setup({ editable: true, getTool: () => tool as never, getColor: () => ({ hex: '#00ff00', hex8: '#00ff0080' }), onCommands, onPick });
    const drag = async (a: [number, number], b: [number, number], o: Partial<PointerEventInit> = {}) => {
      v.canvas.dispatchEvent(ptr('pointerdown', ...at(v, ...a), o));
      v.canvas.dispatchEvent(ptr('pointermove', ...at(v, ...b), o));
      v.canvas.dispatchEvent(ptr('pointerup', ...at(v, ...b), o));
      await Promise.resolve();
    };
    await drag([0, 0], [0, 0]);
    expect(onCommands).toHaveBeenLastCalledWith([{ op: 'pixels', color: 'transparent', points: [[0, 0]] }], 'user eraser');
    tool = 'fill';
    v.canvas.dispatchEvent(ptr('pointerdown', ...at(v, 5, 6)));
    expect(onCommands).toHaveBeenLastCalledWith([{ op: 'fill', x: 5, y: 6, color: '#00ff0080' }], 'user fill');
    v.canvas.dispatchEvent(ptr('pointerup', ...at(v, 5, 6)));
    tool = 'line';
    await drag([1, 1], [5, 3]);
    expect(onCommands).toHaveBeenLastCalledWith([{ op: 'line', x1: 1, y1: 1, x2: 5, y2: 3, color: '#00ff0080' }], 'user line');
    tool = 'rect';
    await drag([4, 4], [2, 2]);
    expect(onCommands).toHaveBeenLastCalledWith([{ op: 'rect', x: 2, y: 2, w: 3, h: 3, fill: false, color: '#00ff0080' }], 'user rect');
    await drag([2, 2], [4, 4], { shiftKey: true });
    expect(onCommands).toHaveBeenLastCalledWith([{ op: 'rect', x: 2, y: 2, w: 3, h: 3, color: '#00ff0080' }], 'user rect');
    tool = 'picker';
    v.canvas.dispatchEvent(ptr('pointerdown', ...at(v, 1, 1)));
    expect(onPick).not.toHaveBeenCalled(); // the stub sampler reads transparent pixels
  });

  it('review drags are normalised', () => {
    const onReview = vi.fn();
    const { v } = setup({ editable: true, getTool: () => 'review', onReview });
    v.canvas.dispatchEvent(ptr('pointerdown', ...at(v, 6, 5)));
    v.canvas.dispatchEvent(ptr('pointermove', ...at(v, 2, 1)));
    v.canvas.dispatchEvent(ptr('pointerup', ...at(v, 2, 1)));
    expect(onReview).toHaveBeenCalledWith({ region: [2, 1, 5, 5] });
    v.canvas.dispatchEvent(ptr('pointerdown', ...at(v, 3, 3)));
    v.canvas.dispatchEvent(ptr('pointerup', ...at(v, 3, 3)));
    expect(onReview).toHaveBeenLastCalledWith({ point: [3, 3] });
  });

  it('read-only views pan instead of painting', () => {
    const onCommands = vi.fn();
    const { v } = setup({ editable: false, getTool: () => 'pencil', onCommands });
    const ox = v.ox;
    v.canvas.dispatchEvent(ptr('pointerdown', 100, 100));
    v.canvas.dispatchEvent(ptr('pointermove', 130, 100));
    v.canvas.dispatchEvent(ptr('pointerup', 130, 100));
    expect(onCommands).not.toHaveBeenCalled();
    expect(v.ox).toBe(ox + 30);
  });

  it('arrow keys pan when focused (Shift = 128 px)', () => {
    const { v } = setup();
    const ox = v.ox, oy = v.oy;
    v.canvas.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    expect(v.ox).toBe(ox + 32);
    v.canvas.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', shiftKey: true, bubbles: true }));
    expect(v.oy).toBe(oy - 128);
  });

  it('destroy removes window listeners and is idempotent', () => {
    const add = vi.spyOn(window, 'addEventListener');
    const { v } = setup();
    const keyup = add.mock.calls.find((c) => c[0] === 'keyup');
    const signal = (keyup?.[2] as AddEventListenerOptions | undefined)?.signal;
    expect(signal?.aborted).toBe(false);
    v.destroy();
    expect(signal?.aborted).toBe(true);
    expect(() => v.destroy()).not.toThrow();
    expect(v.canvas.isConnected).toBe(false);
  });
});
