import { afterEach, describe, expect, it, vi } from 'vitest';
import { clamp, debounce, fmtBytes, fmtMs, fmtSeconds, rafBatch } from './format';

describe('format', () => {
  afterEach(() => vi.useRealTimers());

  it('fmtMs', () => {
    expect(fmtMs(undefined)).toBe('');
    expect(fmtMs(null)).toBe('');
    expect(fmtMs(999)).toBe('999 ms');
    expect(fmtMs(1000)).toBe('1.00 s');
    expect(fmtMs(9999)).toBe('10.00 s');
    expect(fmtMs(10000)).toBe('10.0 s');
    expect(fmtMs(12.4)).toBe('12 ms');
  });

  it('fmtBytes boundaries', () => {
    expect(fmtBytes(0)).toBe('0 B');
    expect(fmtBytes(1023)).toBe('1023 B');
    expect(fmtBytes(1024)).toBe('1.0 KB');
    expect(fmtBytes(1024 * 1024 - 1)).toBe('1024.0 KB');
    expect(fmtBytes(1024 * 1024)).toBe('1.0 MB');
    expect(fmtBytes(5.5 * 1024 * 1024)).toBe('5.5 MB');
  });

  it('clamp', () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-1, 0, 10)).toBe(0);
    expect(clamp(11, 0, 10)).toBe(10);
  });

  it('fmtSeconds', () => {
    expect(fmtSeconds(1.234)).toBe('1.23s');
    expect(fmtSeconds(undefined)).toBe('');
  });

  it('debounce: trailing call with the last args, cancel, flush', () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const d = debounce(fn, 100);
    d(1); d(2); d(3);
    vi.advanceTimersByTime(99);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenLastCalledWith(3);
    d(4); d.cancel();
    vi.advanceTimersByTime(200);
    expect(fn).toHaveBeenCalledTimes(1);
    d(5); d.flush();
    expect(fn).toHaveBeenLastCalledWith(5);
    vi.advanceTimersByTime(200);
    expect(fn).toHaveBeenCalledTimes(2);
    d.flush();
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('rafBatch coalesces calls', () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const b = rafBatch(fn);
    b(); b(); b();
    vi.advanceTimersByTime(20);
    expect(fn).toHaveBeenCalledTimes(1);
    b(); b.cancel();
    vi.advanceTimersByTime(20);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
