import { describe, expect, it } from 'vitest';
import type { ActivityEntry, Review } from '@/lib/api/types';
import type { Target } from '@/viewers/types';
import { assetIndex, canvasSummary } from '@/test/fakes';
import {
  currentTab, followTarget, reviewCompareTargets, reviewTarget, snapTarget, switchViewTarget, tabsFor, targetFor, targetForId, viewerKindFor,
  type FollowContext,
} from './targets';

const index = assetIndex({
  canvases: [
    canvasSummary('one'),
    canvasSummary('spark', { frames: 4, animations: ['spin'] }),
    canvasSummary('tagged', { animations: ['idle'] }),
    canvasSummary('hero_parts', { kind: 'rigparts' }),
    canvasSummary('hero_walk', { rig: 'hero', frames: 8, animations: ['walk_side'] }),
    canvasSummary('hero_still', { rig: 'hero' }),
    canvasSummary('helmet', { project: 'sev' }),
  ],
  projects: [{ name: 'sev' } as never],
});

describe('viewerKindFor', () => {
  it.each<[Target | null, string | null]>([
    [null, null],
    [{ kind: 'canvas', name: 'a' }, 'canvas'],
    [{ kind: 'canvas', name: 'a', view: 'edit' }, 'canvas'],
    [{ kind: 'canvas', name: 'a', view: 'anim' }, 'anim'],
    [{ kind: 'canvas', name: 'a', view: 'sheet' }, 'sheet'],
    [{ kind: 'canvas', name: 'a', view: 'layers' }, 'layers'],
    [{ kind: 'canvas', name: 'a', view: 'anim', snap: 's1' }, 'canvas'],
    [{ kind: 'canvas', name: 'a', view: 'bogus' as never }, 'canvas'],
    [{ kind: 'rig', name: 'r' }, 'rig'],
    [{ kind: 'rig', name: 'r', view: 'layers' }, 'layers'],
    [{ kind: 'model', name: 'm' }, 'model'],
    [{ kind: 'audio', name: 'a' }, 'audio'],
    [{ kind: 'project', name: 'p' }, 'project'],
    [{ kind: 'graph' }, 'graph'],
    [{ kind: 'export', name: 'x/thing.GLB' }, 'model'],
    [{ kind: 'export', name: 'a.wav' }, 'audio'],
    [{ kind: 'export', name: 'a.mp3' }, 'audio'],
    [{ kind: 'export', name: 'a.ogg' }, 'audio'],
    [{ kind: 'export', name: 'a.opus' }, 'audio'],
    [{ kind: 'export', name: 'a.png' }, 'export'],
    [{ kind: 'export', name: 'a.json' }, 'export'],
    [{ kind: 'nope' } as never, null],
  ])('%j -> %s', (t, k) => expect(viewerKindFor(t)).toBe(k));
});

describe('targetFor', () => {
  it('sub-assets', () => {
    expect(targetFor('layer', 'one/base')).toEqual({ kind: 'canvas', name: 'one' });
    expect(targetFor('frame', 'spark/2')).toEqual({ kind: 'canvas', name: 'spark' });
    expect(targetFor('anim', 'spark/spin')).toEqual({ kind: 'canvas', name: 'spark', view: 'anim', tag: 'spin' });
    expect(targetFor('anim', 'spark/a/b')).toEqual({ kind: 'canvas', name: 'spark', view: 'anim', tag: 'a/b' });
    expect(targetFor('rigpart', 'hero/arm')).toEqual({ kind: 'rig', name: 'hero', mode: 'parts' });
    expect(targetFor('modelpart', 'rifle/stock')).toEqual({ kind: 'model', name: 'rifle' });
    expect(targetFor('group', 'Armour')).toEqual({ kind: 'graph', focus: 'group:Armour' });
    expect(targetFor('graph', '')).toEqual({ kind: 'graph' });
  });
  it('palette: project vs canvas', () => {
    expect(targetFor('palette', 'sev', index)).toEqual({ kind: 'project', name: 'sev' });
    expect(targetFor('palette', 'one', index)).toEqual({ kind: 'canvas', name: 'one' });
    expect(targetFor('palette', 'one')).toEqual({ kind: 'canvas', name: 'one' });
  });
  it('plain kinds and ids', () => {
    expect(targetFor('model', 'm')).toEqual({ kind: 'model', name: 'm' });
    expect(targetForId('audio:shot')).toEqual({ kind: 'audio', name: 'shot' });
    expect(targetForId('bare')).toEqual({ kind: 'canvas', name: 'bare' });
  });
});

describe('tabsFor (L8)', () => {
  const ids = (t: Target, i = index) => tabsFor(t, i).map((x) => x.id);
  it('canvas branches', () => {
    expect(ids({ kind: 'canvas', name: 'one' })).toEqual(['edit', 'sheet', 'layers']);
    expect(ids({ kind: 'canvas', name: 'spark' })).toEqual(['edit', 'anim', 'sheet', 'layers']);
    expect(ids({ kind: 'canvas', name: 'tagged' })).toEqual(['edit', 'anim', 'sheet', 'layers']);
    expect(ids({ kind: 'canvas', name: 'unknown' })).toEqual(['edit', 'anim', 'sheet', 'layers']);
    expect(ids({ kind: 'canvas', name: 'hero_parts' })).toEqual(['edit', 'sheet', 'layers', 'rig']);
    expect(ids({ kind: 'canvas', name: 'hero_walk' })).toEqual(['edit', 'anim', 'sheet', 'layers', 'rig']);
    expect(tabsFor({ kind: 'canvas', name: 'one' }, index)[0].label).toBe('Canvas');
  });
  it('snapshots, rigs, others', () => {
    expect(ids({ kind: 'canvas', name: 'one', snap: 's1' })).toEqual([]);
    expect(ids({ kind: 'rig', name: 'hero' })).toEqual(['rig', 'layers']);
    expect(ids({ kind: 'model', name: 'm' })).toEqual([]);
    expect(tabsFor(null)).toEqual([]);
  });
  it('currentTab', () => {
    expect(currentTab({ kind: 'canvas', name: 'a' })).toBe('edit');
    expect(currentTab({ kind: 'canvas', name: 'a', view: 'sheet' })).toBe('sheet');
    expect(currentTab({ kind: 'rig', name: 'r' })).toBe('rig');
    expect(currentTab({ kind: 'rig', name: 'r', view: 'layers' })).toBe('layers');
    expect(currentTab({ kind: 'model', name: 'm' })).toBeNull();
    expect(currentTab(null)).toBeNull();
  });
});

describe('switchViewTarget (L9)', () => {
  it('canvas -> rig', () => {
    expect(switchViewTarget({ kind: 'canvas', name: 'hero_parts' }, 'rig', index)).toEqual({ kind: 'rig', name: 'hero', clip: undefined });
    expect(switchViewTarget({ kind: 'canvas', name: 'hero_walk' }, 'rig', index)).toEqual({ kind: 'rig', name: 'hero', clip: 'hero_walk/walk_side' });
    expect(switchViewTarget({ kind: 'canvas', name: 'hero_still' }, 'rig', index)).toEqual({ kind: 'rig', name: 'hero', clip: undefined });
    expect(switchViewTarget({ kind: 'canvas', name: 'one' }, 'rig', index)).toBeNull();
  });
  it('rig and canvas views', () => {
    expect(switchViewTarget({ kind: 'rig', name: 'hero', clip: 'x' }, 'layers')).toEqual({ kind: 'rig', name: 'hero', view: 'layers' });
    expect(switchViewTarget({ kind: 'rig', name: 'hero', view: 'layers' }, 'rig')).toEqual({ kind: 'rig', name: 'hero', view: undefined });
    expect(switchViewTarget({ kind: 'canvas', name: 'spark', tag: 'spin' }, 'anim')).toEqual({ kind: 'canvas', name: 'spark', tag: 'spin', view: 'anim' });
    expect(switchViewTarget({ kind: 'model', name: 'm' }, 'edit')).toEqual({ kind: 'model', name: 'm' });
    expect(switchViewTarget(null, 'edit')).toBeNull();
  });
});

describe('review targets (R5)', () => {
  it('reviewTarget', () => {
    expect(reviewTarget('canvas:a', { frame: 2 })).toEqual({ kind: 'canvas', name: 'a', frame: 2, tag: undefined, view: undefined });
    expect(reviewTarget('canvas:a', { tag: 'spin', view: 'side' })).toEqual({ kind: 'canvas', name: 'a', frame: undefined, tag: 'spin', view: 'anim' });
    expect(reviewTarget('canvas:a', { tag: 'spin' })).toMatchObject({ view: undefined });
    expect(reviewTarget('model:m')).toEqual({ kind: 'model', name: 'm' });
    expect(reviewTarget('bare')).toMatchObject({ kind: 'canvas', name: 'bare' });
  });
  it('reviewCompareTargets drops the anim view', () => {
    const r = { asset: 'canvas:a', target: { tag: 't', view: 'side' }, compare_with: { asset: 'canvas:b', frame: 1 } } as unknown as Review;
    const pair = reviewCompareTargets(r)!;
    expect(pair[0]).toMatchObject({ kind: 'canvas', name: 'a' });
    expect(pair[0]).not.toHaveProperty('view');
    expect(pair[1]).toMatchObject({ kind: 'canvas', name: 'b', frame: 1 });
    expect(pair[1]).not.toHaveProperty('view');
    expect(reviewCompareTargets({ ...r, compare_with: undefined })).toBeNull();
  });
});

describe('followTarget (E10..E13)', () => {
  const entry = (assets: ActivityEntry['assets']): ActivityEntry => ({ id: 1, type: 'op', op: 'draw', source: 'agent', ts: 0, args: {}, assets });
  const ctx = (o: Partial<FollowContext> = {}): FollowContext => ({ mode: 'canvas', dialogOpen: false, current: null, isHidden: () => false, solo: new Set(), index, ...o });
  const spark = [{ kind: 'canvas', name: 'spark', after: '2' }];

  it.each<[string, ActivityEntry['assets'], Partial<FollowContext>, Target | null]>([
    ['opens the changed canvas', spark, {}, { kind: 'canvas', name: 'spark' }],
    ['follow off', spark, { mode: 'off' }, null],
    ['dialog open', spark, { dialogOpen: true }, null],
    ['hidden asset', spark, { isHidden: (id) => id === 'canvas:spark' }, null],
    ['not in solo', spark, { solo: new Set(['canvas:one']) }, null],
    ['in solo', spark, { solo: new Set(['canvas:spark']) }, { kind: 'canvas', name: 'spark' }],
    ['deleted', [{ kind: 'canvas', name: 'spark', deleted: true }], {}, null],
    ['rig -> parts canvas', [{ kind: 'rig', name: 'hero', after: '1' }], {}, { kind: 'canvas', name: 'hero_parts' }],
    ['model', [{ kind: 'model', name: 'rifle', after: '1' }], {}, { kind: 'model', name: 'rifle' }],
    ['ignores palettes and exports', [{ kind: 'export', name: 'x.png' }, { kind: 'palette', name: 'p' }], {}, null],
    ['prefers a changed canvas', [{ kind: 'model', name: 'm', after: '1' }, { kind: 'canvas', name: 'one', after: '3' }], {}, { kind: 'canvas', name: 'one' }],
    ['prefers anything changed over unchanged', [{ kind: 'canvas', name: 'one' }, { kind: 'audio', name: 'a', after: '1' }], {}, { kind: 'audio', name: 'a' }],
    ['same target is a no-op', spark, { current: { kind: 'canvas', name: 'spark', view: 'anim' } }, null],
    ['keeps the view', spark, { current: { kind: 'canvas', name: 'one', view: 'anim' } }, { kind: 'canvas', name: 'spark', view: 'anim' }],
    ['not the layers view', spark, { current: { kind: 'canvas', name: 'one', view: 'layers' } }, { kind: 'canvas', name: 'spark' }],
    ['a snapshot is not the same target', spark, { current: { kind: 'canvas', name: 'spark', snap: 's1' } }, { kind: 'canvas', name: 'spark' }],
    ['project mode opens the project', [{ kind: 'canvas', name: 'helmet', after: '1' }], { mode: 'project' }, { kind: 'project', name: 'sev' }],
    ['project mode: already shown', [{ kind: 'canvas', name: 'helmet', after: '1' }], { mode: 'project', current: { kind: 'project', name: 'sev' } }, null],
    ['project mode: no project', spark, { mode: 'project' }, null],
  ])('%s', (_n, assets, o, want) => expect(followTarget(entry(assets), ctx(o))).toEqual(want));
});

describe('snapTarget', () => {
  it('rig snapshots are of the parts canvas', () => {
    expect(snapTarget({ kind: 'rig', name: 'hero' }, 's3', 'before')).toEqual({ kind: 'canvas', name: 'hero_parts', snap: 's3', label: 'before' });
    expect(snapTarget({ kind: 'model', name: 'm' }, 's4', 'x')).toEqual({ kind: 'model', name: 'm', snap: 's4', label: 'x' });
  });
});
