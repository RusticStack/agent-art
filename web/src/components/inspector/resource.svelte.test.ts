import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Resource } from './resource.svelte';

function deferred<T>() {
  let resolve!: (v: T) => void, reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('Resource', () => {
  it('keeps the previous data while the next key loads, then replaces it', async () => {
    const r = new Resource<string>();
    const a = deferred<string>(), b = deferred<string>();
    r.load('a', () => a.promise);
    a.resolve('A'); await flush();
    expect([r.data, r.dataKey, r.loading]).toEqual(['A', 'a', false]);
    r.load('b', () => b.promise);
    expect([r.data, r.loading]).toEqual(['A', true]);
    b.resolve('B'); await flush();
    expect([r.data, r.dataKey, r.loading]).toEqual(['B', 'b', false]);
  });

  it('last wins: a slow earlier response is dropped and its request aborted', async () => {
    const r = new Resource<string>();
    const a = deferred<string>(), b = deferred<string>();
    let sigA: AbortSignal | null = null;
    r.load('a', (s) => { sigA = s; return a.promise; });
    r.load('b', () => b.promise);
    expect(sigA!.aborted).toBe(true);
    b.resolve('B'); await flush();
    a.resolve('A'); await flush();
    expect(r.data).toBe('B');
  });

  it('the same key does not reload; invalidate() allows it; null clears', async () => {
    const r = new Resource<number>();
    const fn = vi.fn(async () => 1);
    r.load('k', fn); r.load('k', fn);
    await flush();
    expect(fn).toHaveBeenCalledOnce();
    r.invalidate(); r.load('k', fn); await flush();
    expect(fn).toHaveBeenCalledTimes(2);
    r.load(null, fn);
    expect([r.data, r.dataKey, r.loading]).toEqual([null, null, false]);
  });

  it('slow turns on after 150 ms and off when settled; errors keep the data', async () => {
    const r = new Resource<string>();
    r.load('a', async () => 'A'); await flush();
    const b = deferred<string>();
    r.load('b', () => b.promise);
    expect(r.slow).toBe(false);
    vi.advanceTimersByTime(149);
    expect(r.slow).toBe(false);
    vi.advanceTimersByTime(1);
    expect(r.slow).toBe(true);
    b.reject(new Error('boom')); await flush();
    expect([r.slow, r.loading, r.error, r.data]).toEqual([false, false, 'boom', 'A']);
  });

  it('dispose aborts and ignores the pending result', async () => {
    const r = new Resource<string>();
    const a = deferred<string>();
    let sig: AbortSignal | null = null;
    r.load('a', (s) => { sig = s; return a.promise; });
    r.dispose();
    a.resolve('A'); await flush();
    expect(sig!.aborted).toBe(true);
    expect(r.data).toBeNull();
  });
});
