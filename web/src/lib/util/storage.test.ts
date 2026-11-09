import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFollowMode, store } from './storage';

function memStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() { return m.size; }, clear: () => m.clear(), key: (i: number) => [...m.keys()][i] ?? null,
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null), setItem: (k: string, v: string) => void m.set(k, String(v)), removeItem: (k: string) => void m.delete(k),
  };
}

describe('storage', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('round trips JSON under the prefix', () => {
    const s = memStorage();
    vi.stubGlobal('localStorage', s);
    store.set('k', { a: 1 });
    expect(s.getItem('agent-art:k')).toBe('{"a":1}');
    expect(store.get('k', null)).toEqual({ a: 1 });
    expect(store.get('missing', 7)).toBe(7);
  });

  it('swallows throwing storage', () => {
    const bad = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('quota'); } };
    vi.stubGlobal('localStorage', bad);
    expect(store.get('k', 'd')).toBe('d');
    expect(() => store.set('k', 1)).not.toThrow();
    expect(store.getRaw('x')).toBeNull();
    expect(() => store.setRaw('x', 'y')).not.toThrow();
  });

  it('bad JSON gives the default', () => {
    const s = memStorage();
    s.setItem('agent-art:k', '{nope');
    vi.stubGlobal('localStorage', s);
    expect(store.get('k', 3)).toBe(3);
  });

  it('follow mode: new key, legacy key, asset alias, default', () => {
    const s = memStorage();
    vi.stubGlobal('localStorage', s);
    expect(readFollowMode()).toBe('canvas');
    s.setItem('agent-art-follow', 'asset');
    expect(readFollowMode()).toBe('canvas');
    s.setItem('agent-art-follow', 'project');
    expect(readFollowMode()).toBe('project');
    store.set('follow', 'off');
    expect(readFollowMode()).toBe('off');
    store.set('follow', 'weird');
    expect(readFollowMode()).toBe('canvas');
  });
});
