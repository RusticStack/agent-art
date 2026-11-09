// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeEventSource } from '@/test/fakes';
import { EventStream, HELLO_TIMEOUT_MS, backoffMs, type EventStreamOptions } from './events';

function make(o: Partial<EventStreamOptions> = {}) {
  const events: unknown[] = [], opens: { reconnect: boolean }[] = [], downs: { attempt: number; retryInMs: number }[] = [];
  const s = new EventStream({ onEvent: (e) => events.push(e), onOpen: (i) => opens.push(i), onDown: (i) => downs.push(i), makeSource: FakeEventSource.make, random: () => 0.5, ...o });
  return { s, events, opens, downs };
}
function setVisibility(v: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => v });
  document.dispatchEvent(new Event('visibilitychange'));
}

describe('backoffMs', () => {
  it('sequence with random 0.5', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 20].map((n) => backoffMs(n, () => 0.5))).toEqual([500, 1000, 2000, 4000, 8000, 15000, 15000, 15000]);
  });
  it('jitter 0.8..1.2', () => {
    expect(backoffMs(0, () => 0)).toBe(400);
    expect(backoffMs(0, () => 1)).toBeCloseTo(600, 6);
  });
});

describe('EventStream', () => {
  beforeEach(() => { vi.useFakeTimers(); FakeEventSource.reset(); });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('1: one source; malformed frames are dropped with a warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { s, events } = make();
    s.start();
    s.start();
    expect(FakeEventSource.instances.length).toBe(1);
    expect(FakeEventSource.last().url).toBe('/api/events');
    const src = FakeEventSource.last();
    src.hello();
    src.emit('{not json');
    src.emit({ nope: 1 });
    src.emit({ type: 'change', canvas: 'a' });
    expect(warn).toHaveBeenCalledTimes(2);
    expect(events).toEqual([{ type: 'change', canvas: 'a' }]);
    s.stop();
  });

  it('2: open on hello, not on onopen; attempt resets', () => {
    const { s, opens, downs } = make();
    s.start();
    expect(s.state).toBe('connecting');
    FakeEventSource.last().onopen?.(new Event('open'));
    expect(opens).toEqual([]);
    FakeEventSource.last().error();
    FakeEventSource.last().error(); // the closed source is ignored
    expect(downs.length).toBe(1);
    vi.advanceTimersByTime(500);
    FakeEventSource.last().error();
    expect(downs.map((d) => d.retryInMs)).toEqual([500, 1000]);
    vi.advanceTimersByTime(1000);
    FakeEventSource.last().hello();
    expect(s.state).toBe('open');
    expect(opens).toEqual([{ reconnect: false }]);
    FakeEventSource.last().error();
    expect(downs[2]).toEqual({ attempt: 1, retryInMs: 500 });
    s.stop();
  });

  it('first open is not a reconnect; later ones are', () => {
    const { s, opens } = make();
    s.start();
    FakeEventSource.last().hello();
    FakeEventSource.last().error();
    vi.advanceTimersByTime(500);
    FakeEventSource.last().hello();
    expect(opens).toEqual([{ reconnect: false }, { reconnect: true }]);
    s.stop();
  });

  it('3+4: onerror closes, reports and reconnects with backoff, never gives up', () => {
    const { s, downs } = make();
    s.start();
    for (let i = 0; i < 9; i++) {
      const src = FakeEventSource.last();
      src.error();
      expect(src.closed).toBe(true);
      expect(s.state).toBe('waiting');
      vi.advanceTimersByTime(downs[downs.length - 1].retryInMs);
    }
    expect(downs.map((d) => d.retryInMs)).toEqual([500, 1000, 2000, 4000, 8000, 15000, 15000, 15000, 15000]);
    expect(downs.map((d) => d.attempt)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(FakeEventSource.instances.length).toBe(10);
    expect(FakeEventSource.instances.slice(0, -1).every((x) => x.closed)).toBe(true);
    s.stop();
  });

  it('5: no hello within 10 s is an error', () => {
    const { s, downs } = make();
    s.start();
    vi.advanceTimersByTime(HELLO_TIMEOUT_MS - 1);
    expect(downs.length).toBe(0);
    vi.advanceTimersByTime(1);
    expect(downs.length).toBe(1);
    expect(FakeEventSource.instances[0].closed).toBe(true);
    s.stop();
  });

  it('hello in time cancels the hello timeout', () => {
    const { s, downs } = make();
    s.start();
    FakeEventSource.last().hello();
    vi.advanceTimersByTime(HELLO_TIMEOUT_MS * 3);
    expect(downs.length).toBe(0);
    s.stop();
  });

  it('6: visible while waiting reconnects at once, keeping the attempt count', () => {
    const { s, downs } = make();
    s.start();
    FakeEventSource.last().error();
    FakeEventSource.last();
    vi.advanceTimersByTime(500);
    FakeEventSource.last().error();
    expect(s.state).toBe('waiting');
    const n = FakeEventSource.instances.length;
    setVisibility('hidden');
    expect(FakeEventSource.instances.length).toBe(n);
    setVisibility('visible');
    expect(FakeEventSource.instances.length).toBe(n + 1);
    expect(s.state).toBe('connecting');
    vi.advanceTimersByTime(1000); // the old retry timer was cleared
    expect(FakeEventSource.instances.length).toBe(n + 1);
    FakeEventSource.last().error();
    expect(downs[downs.length - 1].attempt).toBe(3);
    s.stop();
  });

  it('7: stop closes and clears timers', () => {
    const { s } = make();
    s.start();
    FakeEventSource.last().error();
    s.stop();
    expect(s.state).toBe('idle');
    vi.advanceTimersByTime(60_000);
    expect(FakeEventSource.instances.length).toBe(1);
    s.start();
    expect(FakeEventSource.instances.length).toBe(2);
    s.stop();
    expect(FakeEventSource.last().closed).toBe(true);
    setVisibility('visible');
    expect(FakeEventSource.instances.length).toBe(2);
  });

  it('custom url', () => {
    const { s } = make({ url: '/x/events' });
    s.start();
    expect(FakeEventSource.last().url).toBe('/x/events');
    s.stop();
  });
});
