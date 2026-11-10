import { describe, expect, it } from 'vitest';
import type { CleanupPlan, TrashBatch } from '@/lib/api/types';
import { applyToast, batchSummary, emptyWhat, parseAllowPaths, planView, restoreToast, usageBars, usageTiles } from './cleanup';

const plan = (o: Partial<CleanupPlan> = {}): CleanupPlan => ({
  plan_id: 'p1', remove: { count: 2, bytes: 3000, size: '2.9 KB', by_kind: { canvas: 1, model: 1 } },
  items: [{ id: 'canvas:a', bytes: 1000, reason: 'selected' }, { id: 'model:m', bytes: 2000 }], ...o,
});

describe('planView', () => {
  it('tiles: assets, on disk, one per kind, blocked 0 in green', () => {
    const v = planView(plan());
    expect(v.tiles).toEqual([
      { label: 'assets', value: '2' }, { label: 'on disk', value: '2.9 KB' }, { label: 'canvas', value: '1' }, { label: 'model', value: '1' },
      { label: 'blocked', value: '0', tone: 'good' },
    ]);
    expect(v.applyLabel).toBe('Move 2 to trash');
    expect(v.applyDisabled).toBe(false);
    expect(v.items).toEqual([{ id: 'canvas:a', reason: 'selected', size: '1000 B' }, { id: 'model:m', reason: '', size: '2.0 KB' }]);
    expect(v.blocked).toEqual([]);
    expect(v.next).toBe('');
    expect(v.unknown).toBe('');
  });

  it('blocked: red count, reasons, next, label "Blocked", disabled', () => {
    const v = planView(plan({
      blocked: [{ id: 'canvas:tex', why: 'needed', by: ['model:m', 'project:p'] }, { id: 'canvas:ok', why: 'approved', by: [] }],
      next: 'add include_dependents', warnings: ['w1'], refused_files: ['/x.png'], unknown: ['canvas:zz', 'q'],
    }));
    expect(v.tiles.at(-1)).toEqual({ label: 'blocked', value: '2', tone: 'bad' });
    expect(v.blocked).toEqual([{ id: 'canvas:tex', why: ' needed by model:m, project:p' }, { id: 'canvas:ok', why: ' approved in review' }]);
    expect(v.next).toBe('add include_dependents');
    expect(v.warnings).toEqual(['w1']);
    expect(v.refused).toEqual(['/x.png']);
    expect(v.unknown).toBe('not removable / unknown: canvas:zz, q');
    expect(v.applyLabel).toBe('Blocked');
    expect(v.applyDisabled).toBe(true);
  });

  it('an empty plan cannot be applied', () => {
    const v = planView(plan({ items: [], remove: { count: 0, bytes: 0, size: '0 B', by_kind: {} } }));
    expect(v.applyLabel).toBe('Move 0 to trash');
    expect(v.applyDisabled).toBe(true);
  });

  it('apply toast (C3)', () => {
    expect(applyToast({ removed: 1, size: '12 B', trash: 't-1' })).toBe('1 asset(s), 12 B moved to the trash (t-1): Cleanup › Trash restores them');
  });
});

describe('batchSummary', () => {
  const assets = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `canvas:c${i}`, bytes: 1, files: [] }));
  const b = (o: Partial<TrashBatch>): Pick<TrashBatch, 'assets' | 'edges' | 'reviews' | 'manifests'> => ({ assets: assets(1), edges: 0, reviews: 0, manifests: [], ...o });

  it('names only', () => { expect(batchSummary(b({ assets: [{ id: 'model:rifle', bytes: 1, files: [] }, { id: 'plain', bytes: 1, files: [] }] }))).toBe('rifle, plain'); });
  it('first 6 names, +N', () => { expect(batchSummary(b({ assets: assets(8) }))).toBe('c0, c1, c2, c3, c4, c5, +2'); });
  it('exactly 6: no +N', () => { expect(batchSummary(b({ assets: assets(6) }))).toBe('c0, c1, c2, c3, c4, c5'); });
  it('graph links, review notes, manifests', () => {
    expect(batchSummary(b({ edges: 3, reviews: 2, manifests: ['a.json', 'b.json'] }))).toBe('c0 · 3 graph link(s) · 2 review note(s) · manifest a.json, b.json');
  });
});

describe('usageBars', () => {
  it('server order, top 14, widths relative to the biggest, at least 1 %', () => {
    const obj = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`k${i}`, { count: i, bytes: i === 0 ? 2048 : i === 1 ? 0 : 1024 }]));
    const bars = usageBars(obj);
    expect(bars).toHaveLength(14);
    expect(bars[0]).toEqual({ name: 'k0', text: '0 · 2.0 KB', pct: 100 });
    expect(bars[1]).toEqual({ name: 'k1', text: '1 · 0 B', pct: 1 });
    expect(bars[2].pct).toBe(50);
    expect(usageBars(obj, 3).map((x) => x.name)).toEqual(['k0', 'k1', 'k2']);
  });
  it('empty and all-zero inputs', () => {
    expect(usageBars({})).toEqual([]);
    expect(usageBars({ a: { count: 0, bytes: 0 } })).toEqual([{ name: 'a', text: '0 · 0 B', pct: 1 }]);
  });
  it('tiles: total plus each other entry', () => {
    expect(usageTiles({ total: '5 MB', other: { trash_dir: 2048, snapshots: 0 } })).toEqual([
      { label: 'assets + exports', value: '5 MB' }, { label: 'trash dir', value: '2.0 KB' }, { label: 'snapshots', value: '0 B' },
    ]);
  });
});

describe('trash and settings helpers', () => {
  it('restore toast: ok, or error with the first conflict', () => {
    expect(restoreToast({ restored: 1 })).toEqual({ text: 'restored 1 asset(s)', kind: 'ok' });
    expect(restoreToast({ restored: 0, conflicts: ['canvas:a exists', 'b'] })).toEqual({ text: 'restored 0 asset(s) · 2 conflict(s): canvas:a exists', kind: 'error' });
  });
  it('empty confirm wording', () => {
    expect(emptyWhat({ batches: 3, size: '1 MB' }, '')).toBe('all 3 trash batch(es), 1 MB');
    expect(emptyWhat({ batches: 3, size: '1 MB' }, '7d')).toBe('trash batches older than 7 days');
  });
  it('allow paths: trimmed, blank lines dropped, CRLF', () => {
    expect(parseAllowPaths('  C:\\a  \r\n\r\n/b\n   ')).toEqual(['C:\\a', '/b']);
    expect(parseAllowPaths('')).toEqual([]);
  });
});
