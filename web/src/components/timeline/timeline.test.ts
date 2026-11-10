import { describe, expect, it } from 'vitest';
import type { ActivityAsset, ActivityEntry, OpEntry, ToolEntry } from '@/lib/api/types';
import { allHidden, canCompare, clickTarget, compareTargets, displayName, entryLabel, hasDetails, keyArgs, statusOf, thumbsOf, type Hit } from './timeline';

const tool = (p: Partial<ToolEntry> = {}): ToolEntry => ({ id: 7, type: 'tool', call: 'c1', tool: 'art_draw', source: 'agent', ts: 0, args: {}, assets: [], ops: [], ...p });
const op = (p: Partial<OpEntry> = {}): OpEntry => ({ id: 8, type: 'op', op: 'draw', source: 'user', ts: 0, args: {}, assets: [], ...p });
const A = (p: Partial<ActivityAsset> & { name: string }): ActivityAsset => ({ kind: 'canvas', ...p });

describe('keyArgs', () => {
  const cases: [string, Record<string, unknown> | undefined, string | null | undefined, string][] = [
    ['empty', {}, undefined, ''],
    ['undefined args', undefined, undefined, ''],
    ['k=v in KEY_ARGS order, not object order', { name: 'n', canvas: 'c' }, undefined, 'canvas=c  name=n'],
    ['non-strings as JSON', { canvas: 'c', id: 3, status: true, to: ['a', 'b'] }, undefined, 'canvas=c  to=["a","b"]  id=3  status=true'],
    ['skips undefined, null and empty strings', { canvas: '', name: null, label: undefined, pose: 'idle' }, undefined, 'pose=idle'],
    ['0 and false are shown', { id: 0, status: false }, undefined, 'id=0  status=false'],
    ['unknown keys ignored', { foo: 1, canvas: 'c' }, undefined, 'canvas=c'],
    ['skip drops action', { canvas: 'c', action: 'add' }, 'action', 'canvas=c'],
    ['action shown without skip', { canvas: 'c', action: 'add' }, null, 'canvas=c  action=add'],
    ['commands printed raw (string)', { canvas: 'c', commands: 'rect 0 0 2 2 #fff' }, undefined, 'canvas=c  rect 0 0 2 2 #fff'],
    ['commands printed raw (array, String())', { commands: ['a', 'b'] }, undefined, 'a,b'],
    ['commands objects are not JSON', { commands: [{ op: 'px' }] }, undefined, '[object Object]'],
    ['4-arg cap', { canvas: 'c', name: 'n', new_name: 'm', label: 'l', preset: 'p', path: 'x' }, undefined, 'canvas=c  name=n  new_name=m  label=l'],
    ['4-arg cap counts after the skip', { canvas: 'c', name: 'n', action: 'a', label: 'l', preset: 'p', clip: 'k' }, 'action', 'canvas=c  name=n  label=l  preset=p'],
  ];
  it.each(cases)('%s', (_n, args, skip, want) => { expect(keyArgs(args, skip)).toBe(want); });
});

describe('statusOf / displayName / entryLabel / hasDetails / canCompare / allHidden', () => {
  it.each([
    ['running', tool({ running: true, ok: false }), 'running'],
    ['error', tool({ ok: false }), 'err'],
    ['ok', tool({ ok: true }), 'ok'],
    ['ok when unknown', op(), 'ok'],
  ] as const)('statusOf %s', (_n, e, want) => { expect(statusOf(e)).toBe(want); });

  it.each([
    [tool({ tool: 'art_draw' }), 'draw', 'art_draw'],
    [tool({ tool: 'custom' }), 'custom', 'custom'],
    [op({ op: 'layer' }), 'layer', 'layer'],
  ] as const)('names %#', (e, shown, label) => {
    expect(displayName(e)).toBe(shown);
    expect(entryLabel(e)).toBe(label);
  });

  it('hasDetails: ops or args', () => {
    expect(hasDetails(tool(), [])).toBe(false);
    expect(hasDetails(tool({ args: { a: 1 } }), [])).toBe(true);
    expect(hasDetails(tool(), [op()])).toBe(true);
  });

  it('canCompare needs one asset with before and after', () => {
    expect(canCompare(tool({ assets: [A({ name: 'a', before: 's1' }), A({ name: 'b', after: 's2' })] }))).toBe(false);
    expect(canCompare(tool({ assets: [A({ name: 'a', before: 's1', after: 's2' })] }))).toBe(true);
  });

  it('allHidden: every asset hidden, never for no assets', () => {
    const hidden = new Set(['canvas:a', 'model:m']);
    const isHidden = (id: string) => hidden.has(id);
    expect(allHidden(tool(), isHidden)).toBe(false);
    expect(allHidden(tool({ assets: [A({ name: 'a' }), A({ kind: 'model', name: 'm' })] }), isHidden)).toBe(true);
    expect(allHidden(tool({ assets: [A({ name: 'a' }), A({ name: 'b' })] }), isHidden)).toBe(false);
  });
});

describe('thumbsOf', () => {
  it('pairs, singles, skips assets without snapshots, max 3, title with (new)', () => {
    const e = tool({ assets: [
      A({ name: 'none' }),
      A({ name: 'p', before: 'b1', after: 'a1' }),
      A({ name: 'onlyBefore', before: 'b2' }),
      A({ kind: 'model', name: 'm', after: 'a3', created: true }),
      A({ name: 'fourth', after: 'a4' }),
    ] });
    const t = thumbsOf(e);
    expect(t.map((x) => x.asset.name)).toEqual(['p', 'onlyBefore', 'm']);
    expect(t.map((x) => x.images)).toEqual([['b1', 'a1'], ['b2'], ['a3']]);
    expect(t.map((x) => x.title)).toEqual(['canvas p', 'canvas onlyBefore', 'model m (new)']);
  });
  it('no assets: none', () => { expect(thumbsOf(op({ assets: undefined as unknown as ActivityAsset[] }))).toEqual([]); });
});

describe('clickTarget (TL10)', () => {
  const pair = A({ name: 'p', before: 'b1', after: 'a1' });
  const cases: [string, ActivityEntry, Hit, unknown][] = [
    ['row: first asset with after, as snapshot #id', tool({ assets: [A({ name: 'x' }), pair] }), {}, { kind: 'canvas', name: 'p', snap: 'a1', label: '#7' }],
    ['row: no after -> first openable non-deleted live', tool({ assets: [A({ kind: 'layer', name: 'c/l' }), A({ name: 'gone', deleted: true }), A({ kind: 'audio', name: 'zap' })] }), {}, { kind: 'audio', name: 'zap' }],
    ['row: nothing openable', tool({ assets: [A({ kind: 'palette', name: 'p' }), A({ name: 'd', deleted: true })] }), {}, null],
    ['row: no assets', tool(), {}, null],
    ['row: deleted asset with after opens live via targetFor', tool({ assets: [A({ name: 'd', after: 'a9', deleted: true })] }), {}, { kind: 'canvas', name: 'd' }],
    ['row: rig snapshot -> parts canvas', tool({ assets: [A({ kind: 'rig', name: 'hero', after: 'r1' })] }), {}, { kind: 'canvas', name: 'hero_parts', snap: 'r1', label: '#7' }],
    ['thumb: first image of a pair -> before', tool({ assets: [pair] }), { pairName: 'p', imageIndex: 0 }, { kind: 'canvas', name: 'p', snap: 'b1', label: '#7' }],
    ['thumb: second image -> after', tool({ assets: [pair] }), { pairName: 'p', imageIndex: 1 }, { kind: 'canvas', name: 'p', snap: 'a1', label: '#7' }],
    ['thumb: pair outside the images -> after', tool({ assets: [pair] }), { pairName: 'p' }, { kind: 'canvas', name: 'p', snap: 'a1', label: '#7' }],
    ['thumb: single before-only image -> before', tool({ assets: [A({ name: 'b', before: 'b5' })] }), { pairName: 'b', imageIndex: 0 }, { kind: 'canvas', name: 'b', snap: 'b5', label: '#7' }],
    ['thumb: before-only, outside the image -> live', tool({ assets: [A({ name: 'b', before: 'b5' })] }), { pairName: 'b' }, { kind: 'canvas', name: 'b' }],
    ['thumb: deleted asset -> live', tool({ assets: [A({ name: 'd', before: 'b1', after: 'a1', deleted: true })] }), { pairName: 'd', imageIndex: 0 }, { kind: 'canvas', name: 'd' }],
    ['thumb: rig pair -> parts canvas snapshots', tool({ assets: [A({ kind: 'rig', name: 'hero', before: 'r0', after: 'r1' })] }), { pairName: 'hero', imageIndex: 0 }, { kind: 'canvas', name: 'hero_parts', snap: 'r0', label: '#7' }],
    ['thumb: deleted rig -> live rig', tool({ assets: [A({ kind: 'rig', name: 'hero', after: 'r1', deleted: true })] }), { pairName: 'hero', imageIndex: 0 }, { kind: 'rig', name: 'hero' }],
    ['thumb: unknown pair name', tool({ assets: [pair] }), { pairName: 'nope', imageIndex: 0 }, null],
  ];
  it.each(cases)('%s', (_n, e, hit, want) => { expect(clickTarget(e, hit)).toEqual(want); });

  it('deleted palette opens the project when the index has one', () => {
    const index = { projects: [{ name: 'severance' }] } as unknown as Parameters<typeof clickTarget>[2];
    const e = tool({ assets: [A({ kind: 'palette', name: 'severance', before: 'x', deleted: true })] });
    expect(clickTarget(e, { pairName: 'severance', imageIndex: 0 }, index)).toEqual({ kind: 'project', name: 'severance' });
  });
});

describe('compareTargets (TL11)', () => {
  it.each([
    ['first asset with both', tool({ assets: [A({ name: 'a', after: 'x' }), A({ name: 'p', before: 'b1', after: 'a1' })] }),
      [{ kind: 'canvas', name: 'p', snap: 'b1', label: 'before' }, { kind: 'canvas', name: 'p', snap: 'a1', label: 'after' }]],
    ['rig -> parts canvas', tool({ assets: [A({ kind: 'rig', name: 'hero', before: 'r0', after: 'r1' })] }),
      [{ kind: 'canvas', name: 'hero_parts', snap: 'r0', label: 'before' }, { kind: 'canvas', name: 'hero_parts', snap: 'r1', label: 'after' }]],
    ['none', tool({ assets: [A({ name: 'a', after: 'x' })] }), null],
  ] as const)('%s', (_n, e, want) => { expect(compareTargets(e)).toEqual(want); });
});
