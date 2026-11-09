// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { assetIndex, canvasSummary, fakeFetch } from '@/test/fakes';
import { onToast } from '@/lib/util/notify';
import type { ActivityEntry, Review } from '@/lib/api/types';
import { Assets } from './assets.svelte';
import { UiState } from './uiState.svelte';
import { Reviews } from './reviews.svelte';
import { Activity, MAX_ENTRIES } from './activity.svelte';
import { Editor, normColor } from './editor.svelte';
import { Connection } from './connection.svelte';

afterEach(() => { vi.unstubAllGlobals(); onToast(null); localStorage.clear(); });

describe('assets', () => {
  it('refresh builds lookups and bumps rev; a failure keeps the old index', async () => {
    const a = new Assets();
    fakeFetch({ '/api/assets': { json: assetIndex({ canvases: [canvasSummary('a')], flags: { superseded: ['canvas:a'], orphans: [] }, tags: { 'canvas:a': ['x', 'b'] } }) } });
    await a.refresh();
    expect(a.rev).toBe(1);
    expect(a.canvas('a')?.name).toBe('a');
    expect(a.canvas('zz')).toBeUndefined();
    expect(a.isSuperseded('canvas:a')).toBe(true);
    expect(a.isOrphan('canvas:a')).toBe(false);
    expect(a.choices()).toEqual(['canvas:a']);
    expect(a.allTags()).toEqual(['b', 'x']);
    fakeFetch({ '/api/assets': { status: 500, json: { error: 'down' } } });
    await a.refresh();
    expect(a.rev).toBe(1);
    expect(a.canvas('a')).toBeDefined();
    expect(a.error).toBe('down');
  });
});

describe('uiState', () => {
  it('toggles optimistically; a failed save toasts and reloads from the server', async () => {
    const u = new UiState();
    const { calls } = fakeFetch({ '/api/ui-state': (_u, init) => (init?.method === 'POST' ? { json: { ok: true, state: {} } } : { json: { hidden: [], pinned: ['canvas:p'] } }) });
    await u.load();
    expect(u.isPinned('canvas:p')).toBe(true);
    const p = u.toggleHidden('canvas:a');
    expect(u.isHidden('canvas:a')).toBe(true);
    await p;
    void u.togglePinned('canvas:b');
    expect(u.pinned).toEqual(['canvas:b', 'canvas:p']);
    expect(JSON.parse(String(calls.at(-1)!.init!.body))).toEqual({ hidden: ['canvas:a'], pinned: ['canvas:b', 'canvas:p'] });
    const toasts: string[] = [];
    onToast((t) => toasts.push(t));
    fakeFetch({ '/api/ui-state': (_u, init) => (init?.method === 'POST' ? { status: 500, json: { error: 'no' } } : { json: { hidden: [], pinned: [] } }) });
    await u.toggleHidden('canvas:c');
    expect(toasts).toContain('Could not save the hidden / pinned state');
    expect(u.isHidden('canvas:c')).toBe(false);
  });
  it('visible(): solo first, then hidden unless shown', () => {
    const u = new UiState();
    u.hidden = new Set(['canvas:h']);
    expect(u.visible('canvas:h', false)).toBe(false);
    expect(u.visible('canvas:h', true)).toBe(true);
    u.toggleSolo('canvas:s');
    expect(u.visible('canvas:x', true)).toBe(false);
    expect(u.visible('canvas:s', false)).toBe(true);
    u.clearSolo();
    expect(u.visible('canvas:x', false)).toBe(true);
  });
});

const review = (id: string, o: Partial<Review>): Review => ({ id, asset: 'canvas:a', target: {}, category: 'fix', priority: 'normal', note: '', status: 'open', by: 'user', created: 0, updated: 0, history: [], ...o });

describe('reviews', () => {
  it('openCount, marks filter, forAsset, sortedAll', async () => {
    const r = new Reviews();
    fakeFetch({ '/api/reviews': { json: { reviews: [
      review('r1', { status: 'accepted', updated: 9 }),
      review('r2', { status: 'open', updated: 1, target: { region: [1, 2, 3, 4], frame: 2 } }),
      review('r3', { status: 'fixed', updated: 5 }),
      review('r4', { asset: 'canvas:b', status: 'reopened', updated: 3, compare_with: { asset: 'canvas:a' } }),
    ], counts: { 'canvas:a': 1 }, approved: ['canvas:z'] } } });
    await r.refresh();
    expect(r.openCount).toBe(2);
    expect(r.marks({ kind: 'canvas', name: 'a' }).map((m) => m.id)).toEqual(['r2', 'r3']);
    expect(r.marks({ kind: 'canvas', name: 'a' })[0]).toEqual({ id: 'r2', status: 'open', region: [1, 2, 3, 4], frame: 2, time: undefined });
    expect(r.forAsset('canvas:a').map((x) => x.id)).toEqual(['r1', 'r3', 'r4', 'r2']);
    expect(r.sortedAll().map((x) => x.id)).toEqual(['r4', 'r2', 'r1', 'r3']);
    expect(r.approved.has('canvas:z')).toBe(true);
  });
});

let nextId = 1;
const tool = (o: Partial<ActivityEntry> = {}): ActivityEntry => ({ id: nextId++, type: 'tool', call: 'c' + nextId, tool: 'art_draw', ops: [], source: 'agent', ts: 0, args: {}, assets: [], ...o } as ActivityEntry);
const opE = (o: Partial<ActivityEntry> = {}): ActivityEntry => ({ id: nextId++, type: 'op', op: 'draw', source: 'user', ts: 0, args: {}, assets: [], ...o } as ActivityEntry);

describe('activity', () => {
  beforeEach(() => { nextId = 1; });
  it('upsert replaces by id, trims to 3000, reset clears', () => {
    const a = new Activity();
    const e = tool();
    a.upsert(e);
    a.upsert({ ...e, summary: 'done' });
    expect(a.size).toBe(1);
    expect(a.get(e.id)?.summary).toBe('done');
    a.load(Array.from({ length: MAX_ENTRIES + 5 }, () => opE()));
    expect(a.size).toBe(MAX_ENTRIES);
    expect(a.get(e.id)).toBeUndefined();
    expect(a.lastId).toBe(nextId - 1);
    a.reset();
    expect(a.size).toBe(0);
    expect(a.lastId).toBe(0);
  });
  it('rows(): top-level rule, each filter, search; newest first; persists the filter', () => {
    const a = new Activity();
    const t = tool({ call: 'k1', assets: [{ kind: 'canvas', name: 'hero' }] } as Partial<ActivityEntry>);
    const child = opE({ call: 'k1', source: 'agent' } as Partial<ActivityEntry>);
    const loose = opE({ op: 'layer', assets: [{ kind: 'canvas', name: 'hero_parts' }] } as Partial<ActivityEntry>);
    const err = tool({ tool: 'art_model', ok: false, error: 'kaput' } as Partial<ActivityEntry>);
    a.load([t, child, loose, err]);
    let r = a.rows(null);
    expect(r.shown.map((e) => e.id)).toEqual([err.id, loose.id, t.id]);
    expect(r.total).toBe(3);
    expect(r.errors).toBe(1);
    expect(r.tools).toEqual(['art_draw', 'art_model', 'draw', 'layer']);
    a.setFilter({ errors: true });
    expect(a.rows(null).shown).toEqual([err]);
    expect(JSON.parse(localStorage.getItem('agent-art:tlFilter')!).errors).toBe(true);
    a.setFilter({ errors: false, agent: true });
    expect(a.rows(null).shown.map((e) => e.id)).toEqual([err.id, t.id]);
    a.setFilter({ agent: false, current: true });
    expect(a.rows({ kind: 'canvas', name: 'hero' }).shown.map((e) => e.id)).toEqual([loose.id, t.id]);
    expect(a.rows(null).shown).toEqual([]);
    a.setFilter({ current: false, tool: 'art_model' });
    expect(a.rows(null).shown).toEqual([err]);
    a.setFilter({ tool: '' });
    a.search = 'KAPUT';
    expect(a.rows(null).shown).toEqual([err]);
  });
  it('toggleExpanded', () => {
    const a = new Activity();
    a.toggleExpanded(3);
    expect(a.expanded.has(3)).toBe(true);
    a.toggleExpanded(3);
    expect(a.expanded.has(3)).toBe(false);
  });
});

describe('editor', () => {
  it.each([['#ABC', '#aabbccff'], ['#11223344', '#11223344'], ['#112233', '#112233ff'], ['abcd', '#aabbccdd']])('normColor %s', (i, o) => expect(normColor(i).hex8).toBe(o));
  it('setColor switches eraser / picker / hand back to the pencil', () => {
    const e = new Editor();
    for (const t of ['eraser', 'picker', 'hand'] as const) { e.setTool(t); e.setColor('#ff0000'); expect(e.tool).toBe('pencil'); }
    e.setTool('fill'); e.setColor('#00ff00');
    expect(e.tool).toBe('fill');
    expect(e.color).toEqual({ hex: '#00ff00', hex8: '#00ff00ff' });
  });
});

describe('connection', () => {
  it.each([
    ['connecting', 0, 'connecting', 'connecting…'],
    ['down', 0, 'down', 'disconnected — retrying'],
    ['open', 2499, 'busy', 'agent is working…'],
    ['open', 2500, 'live', 'live'],
  ] as const)('%s, %d ms after the agent -> %s', (phase, dt, status, label) => {
    const c = new Connection();
    c.phase = phase;
    c.lastAgentAt = 10_000;
    c.tick(10_000 + dt);
    expect(c.status).toBe(status);
    expect(c.label).toBe(label);
  });
});
