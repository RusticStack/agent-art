// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { assetIndex, fakeFetch } from '@/test/fakes';
import { onToast } from '@/lib/util/notify';
import type { AnyEvent, ActivityEntry } from '@/lib/api/types';
import type { Viewer } from '@/viewers/types';
import { activity } from './activity.svelte';
import { assets } from './assets.svelte';
import { connection } from './connection.svelte';
import { reviews } from './reviews.svelte';
import { uiState } from './uiState.svelte';
import { workspace } from './workspace.svelte';
import { entryScript, onAfterEvent, resync, route, signals } from './live.svelte';

const viewer = () => ({ onEvent: vi.fn() } as unknown as Viewer & { onEvent: ReturnType<typeof vi.fn> });
let A: ReturnType<typeof viewer>, B: ReturnType<typeof viewer>;
beforeEach(() => {
  A = viewer(); B = viewer();
  workspace.registerViewer('A', A); workspace.registerViewer('B', B);
  vi.spyOn(assets, 'refreshSoon').mockImplementation(() => {});
  vi.spyOn(reviews, 'refreshSoon').mockImplementation(() => {});
  vi.spyOn(uiState, 'load').mockResolvedValue();
  vi.spyOn(workspace, 'follow').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); onToast(null); workspace.registerViewer('A', null); workspace.registerViewer('B', null); });

const act = (o: Partial<ActivityEntry>): AnyEvent => ({ type: 'activity', ts: 1, entry: { id: 7, type: 'op', op: 'draw', source: 'agent', ts: 1, args: {}, assets: [], ...o } as ActivityEntry });

describe('live.route', () => {
  it.each<[string, AnyEvent, { assets?: boolean; reviews?: boolean; ui?: boolean; viewers?: boolean; follow?: boolean }]>([
    ['hello', { type: 'hello', ts: 1 }, {}],
    ['agent op', act({}), { follow: true }],
    ['user op', act({ source: 'user' }), {}],
    ['failed agent op', act({ ok: false }), {}],
    ['ui-state', { type: 'ui-state', ts: 1 }, { ui: true }],
    ['graph review', { type: 'graph', review: true, ts: 1 }, { assets: true, reviews: true, viewers: true }],
    ['graph approve', { type: 'graph', action: 'approve', ts: 1 }, { assets: true, reviews: true, viewers: true }],
    ['graph link', { type: 'graph', action: 'link', ts: 1 }, { assets: true, viewers: true }],
    ['change', { type: 'change', canvas: 'a', version: 1, op: 'draw', source: 'user', dirty: null, ts: 1 }, { assets: true, viewers: true }],
    ['deleted', { type: 'deleted', canvas: 'a', source: 'agent', ts: 1 }, { assets: true, viewers: true }],
    ['model', { type: 'model', model: 'm', source: 'agent', ts: 1 }, { assets: true, viewers: true }],
    ['planet', { type: 'planet', name: 'p', source: 'agent', ts: 1 }, { assets: true, viewers: true }],
    ['unknown', { type: 'brand_new', ts: 1 }, { assets: true, viewers: true }],
  ])('%s', (_n, ev, want) => {
    route(ev);
    expect(vi.mocked(assets.refreshSoon).mock.calls.length > 0).toBe(!!want.assets);
    expect(vi.mocked(reviews.refreshSoon).mock.calls.length > 0).toBe(!!want.reviews);
    expect(vi.mocked(uiState.load).mock.calls.length > 0).toBe(!!want.ui);
    expect(A.onEvent.mock.calls.length > 0).toBe(!!want.viewers);
    expect(B.onEvent.mock.calls.length > 0).toBe(!!want.viewers);
    expect(vi.mocked(workspace.follow).mock.calls.length > 0).toBe(!!want.follow);
  });
  it('activity upserts, marks the agent busy, hooks run after the stores', () => {
    const seen: string[] = [];
    const off = onAfterEvent((ev) => seen.push(ev.type + ':' + activity.get(7)?.id));
    route(act({}));
    off();
    expect(seen).toEqual(['activity:7']);
    expect(connection.status).toBe('busy');
  });
  it('an agent change flashes the row; a change of the inspected asset bumps the inspector', () => {
    vi.useFakeTimers();
    workspace.inspected = { kind: 'canvas', name: 'a' };
    const n = signals.flash.n, tick = signals.inspectorTick;
    route({ type: 'change', canvas: 'a', version: 2, op: 'draw', source: 'agent', dirty: null, ts: 1 });
    expect(signals.flash).toEqual({ id: 'canvas:a', n: n + 1 });
    vi.advanceTimersByTime(200);
    expect(signals.inspectorTick).toBe(tick + 1);
    vi.useRealTimers();
  });
});

describe('resync', () => {
  it('same pid: refresh stores, fetch activity since lastId, then send resync to both viewers', async () => {
    const order: string[] = [];
    connection.serverPid = 11;
    vi.spyOn(assets, 'refresh').mockImplementation(async () => { order.push('assets'); });
    vi.spyOn(reviews, 'refresh').mockImplementation(async () => { order.push('reviews'); });
    vi.mocked(uiState.load).mockImplementation(async () => { order.push('ui'); });
    activity.reset();
    activity.load([{ id: 40, type: 'op', op: 'x', source: 'user', ts: 0, args: {}, assets: [] } as ActivityEntry]);
    const { calls } = fakeFetch({ '/api/health': { json: { pid: 11 } }, '/api/activity': { json: { entries: [], seq: 0 } } });
    A.onEvent.mockImplementation(() => order.push('viewer'));
    await resync();
    expect(calls[0].url).toBe('/api/health');
    expect(calls.find((c) => c.url.startsWith('/api/activity'))!.url).toContain('since=40');
    expect(order.slice(0, 3).sort()).toEqual(['assets', 'reviews', 'ui']);
    expect(order.at(-1)).toBe('viewer');
    expect(A.onEvent).toHaveBeenCalledWith({ type: 'resync' });
    expect(B.onEvent).toHaveBeenCalledWith({ type: 'resync' });
    expect(connection.restarted).toBe(false);
  });
  it('a new pid: restarted, token refreshed, activity reset, last 600 fetched, toast', async () => {
    connection.serverPid = 11;
    connection.restarted = false;
    vi.spyOn(assets, 'refresh').mockResolvedValue();
    vi.spyOn(reviews, 'refresh').mockResolvedValue();
    activity.load([{ id: 99, type: 'op', op: 'x', source: 'user', ts: 0, args: {}, assets: [] } as ActivityEntry]);
    const toasts: string[] = [];
    onToast((t) => toasts.push(t));
    const { calls } = fakeFetch({
      '/api/health': { json: { pid: 12 } },
      '/api/activity': { json: { entries: [{ id: 1, type: 'op', op: 'y', source: 'agent', ts: 0, args: {}, assets: [] }], seq: 1 } },
      '/': { text: '<meta name="agent-art-ui-token" content="t2"><script type="module" src="./assets/index-X.js"></script>', contentType: 'text/html' },
    });
    await resync();
    expect(connection.restarted).toBe(true);
    expect(connection.serverPid).toBe(12);
    expect(calls.some((c) => c.url === '/')).toBe(true);
    expect(calls.find((c) => c.url.startsWith('/api/activity'))!.url).toContain('limit=600');
    expect(activity.get(99)).toBeUndefined();
    expect(activity.get(1)).toBeDefined();
    expect(toasts).toContain('Reconnected to a restarted server');
    assets.set(assetIndex());
  });
  it('entryScript reads the module entry', () => {
    expect(entryScript('<script type="module" crossorigin src="./assets/index-A.js"></script>')).toBe('./assets/index-A.js');
    expect(entryScript(null)).toBeNull();
  });
});
