// A recording 2D context for jsdom (which has no canvas): every method call is logged, properties are kept.
import { vi } from 'vitest';

export interface StubCtx { calls: { fn: string; args: unknown[] }[]; [k: string]: unknown }

export function makeCtx(canvas?: { width: number; height: number }): StubCtx {
  const calls: StubCtx['calls'] = [];
  const props: Record<string, unknown> = { canvas, calls, globalAlpha: 1, imageSmoothingEnabled: true, fillStyle: '#000', strokeStyle: '#000', lineWidth: 1, font: '', globalCompositeOperation: 'source-over' };
  return new Proxy(props, {
    get(t, k: string) {
      if (k in t) return t[k];
      if (k === 'measureText') return (s: string) => ({ width: s.length * 6 });
      if (k === 'getImageData') return (_x: number, _y: number, w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) });
      if (k === 'then') return undefined;
      return (...args: unknown[]) => { calls.push({ fn: k, args }); };
    },
    set(t, k: string, v) { t[k] = v; return true; },
  }) as StubCtx;
}

/** Stub HTMLCanvasElement.getContext, rAF and ResizeObserver for jsdom tests. */
export function installCanvasStub(): void {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
    const self = this as HTMLCanvasElement & { _ctx?: StubCtx };
    self._ctx ??= makeCtx(this);
    return self._ctx as unknown as CanvasRenderingContext2D;
  } as never);
  if (typeof globalThis.requestAnimationFrame !== 'function') {
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => setTimeout(() => cb(performance.now()), 16) as unknown as number);
    vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id));
  }
}

/** A fake ImageBitmap of the given size. */
export const fakeBitmap = (width: number, height: number): ImageBitmap => ({ width, height, close: vi.fn() }) as unknown as ImageBitmap;

/** Give an element a layout size (jsdom has none). */
export function sizeElement(el: HTMLElement, width: number, height: number): void {
  el.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: width, bottom: height, width, height, toJSON() {} }) as DOMRect;
}
