import { describe, expect, it } from 'vitest';
import type { Target } from '@/viewers/types';
import { hashToTarget, targetToHash } from './hash';

const names = ['plain', 'with space', 'hash#tag', 'pct%20lit', 'ünï→code', 'a/b', 'x:y'];

describe('hash', () => {
  it('round trips every kind', () => {
    for (const name of names) {
      for (const kind of ['canvas', 'project', 'model', 'rig', 'audio', 'export'] as const) {
        const t = { kind, name } as Target;
        const h = targetToHash(t)!;
        expect(hashToTarget('#' + h)).toEqual(t);
      }
    }
    expect(hashToTarget('#' + targetToHash({ kind: 'graph' }))).toEqual({ kind: 'graph' });
  });
  it('snapshots are never written', () => {
    expect(targetToHash({ kind: 'canvas', name: 'a', snap: 's1' })).toBeNull();
    expect(targetToHash({ kind: 'model', name: 'a', snap: 's2' })).toBeNull();
  });
  it('fixed formats', () => {
    expect(targetToHash({ kind: 'canvas', name: 'a b' })).toBe('a%20b');
    expect(targetToHash({ kind: 'project', name: 'p' })).toBe('project:p');
    expect(hashToTarget('#canvas:x')).toEqual({ kind: 'canvas', name: 'x' });
    expect(hashToTarget('#model')).toEqual({ kind: 'canvas', name: 'model' });
    expect(hashToTarget('#unknown:thing')).toEqual({ kind: 'canvas', name: 'unknown:thing' });
    expect(hashToTarget('')).toBeNull();
    expect(hashToTarget('#')).toBeNull();
    expect(hashToTarget('#bad%E0%A4%A')).toEqual({ kind: 'canvas', name: 'bad%E0%A4%A' });
  });
});
