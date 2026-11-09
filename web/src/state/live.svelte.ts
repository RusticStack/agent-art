// The only place that maps server events to store calls (plan 2.5), plus reconnect + resync (3.5).
import { api } from '@/lib/api/client';
import { EventStream, type EventStreamOptions } from '@/lib/api/events';
import { lastFetchedIndex, refreshUiToken } from '@/lib/api/http';
import type { AnyEvent, ActivityEntry } from '@/lib/api/types';
import { toast } from '@/lib/util/notify';
import { activity } from './activity.svelte';
import { assets } from './assets.svelte';
import { connection } from './connection.svelte';
import { reviews } from './reviews.svelte';
import { uiState } from './uiState.svelte';
import { workspace } from './workspace.svelte';

/** browserFlash (asset rows that should flash: the agent changed them) and inspectorTick (refetch the inspector). */
class Signals {
  flash = $state.raw<{ id: string; n: number }>({ id: '', n: 0 });
  inspectorTick = $state(0);
}
export const signals = new Signals();

const ASSET_EVENTS = new Set(['change', 'deleted', 'model', 'audio', 'project', 'anim_library', 'planet']);
const KNOWN = new Set(['hello', 'activity', 'ui-state', 'graph', 'resync', ...ASSET_EVENTS]);
const OWN_EVENTS = new Set(['hello', 'activity', 'ui-state']);
const INSPECT_EVENTS = new Set(['change', 'model', 'audio', 'project']);

let inspectTimer: ReturnType<typeof setTimeout> | null = null;
function bumpInspector(): void {
  if (inspectTimer) return;
  inspectTimer = setTimeout(() => { inspectTimer = null; signals.inspectorTick++; }, 150);
}

/** The asset an event is about, as an id (for the inspector refresh). */
function eventAssetId(ev: AnyEvent): string | null {
  const e = ev as Record<string, unknown>;
  if (ev.type === 'change') return `canvas:${e.canvas}`;
  if (ev.type === 'model') return `model:${e.model}`;
  if (ev.type === 'audio') return `audio:${e.name}`;
  if (ev.type === 'project') return `project:${e.project}`;
  return null;
}

type Hook = (ev: AnyEvent) => void;
const afterHooks: Hook[] = [];
/** Temporary (removed in step 18): the legacy App re-renders its DOM after each event. */
export function onAfterEvent(fn: Hook): () => void {
  afterHooks.push(fn);
  return () => { const i = afterHooks.indexOf(fn); if (i >= 0) afterHooks.splice(i, 1); };
}

/** Route one server event to the stores and the viewers. */
export function route(ev: AnyEvent): void {
  if (ev.type === 'hello') {
    connection.phase = 'open';
  } else if (ev.type === 'activity') {
    const entry = (ev as { entry: ActivityEntry }).entry;
    activity.upsert(entry);
    if (entry.source !== 'user') connection.agentActive();
    if (entry.type === 'op' && entry.source === 'agent' && entry.ok !== false) workspace.follow(entry);
  } else if (ev.type === 'ui-state') {
    void uiState.load();
  } else {
    if (ev.type === 'graph') {
      const g = ev as { review?: boolean; action?: string };
      if (g.review || g.action === 'approve') reviews.refreshSoon();
      assets.refreshSoon();
      signals.inspectorTick++;
    } else if (ASSET_EVENTS.has(ev.type) || !KNOWN.has(ev.type)) {
      assets.refreshSoon();
    }
    if (ev.type === 'change' && (ev as { source?: string }).source === 'agent') {
      const id = `canvas:${(ev as { canvas: string }).canvas}`;
      signals.flash = { id, n: signals.flash.n + 1 };
    }
    if (INSPECT_EVENTS.has(ev.type)) {
      const id = eventAssetId(ev);
      const ins = workspace.inspected;
      if (id && ins && 'name' in ins && `${ins.kind}:${ins.name}` === id) bumpInspector();
    }
    if (!OWN_EVENTS.has(ev.type)) {
      workspace.viewer('A')?.onEvent?.(ev);
      workspace.viewer('B')?.onEvent?.(ev);
    }
  }
  for (const h of afterHooks) h(ev);
}

/** The entry script URL of an HTML page (the stale-build check). */
export function entryScript(html: string | null): string | null {
  return html?.match(/<script[^>]+type="module"[^>]+src="([^"]+)"/i)?.[1] ?? html?.match(/<script[^>]+src="([^"]+)"[^>]+type="module"/i)?.[1] ?? null;
}

/** 3.5: what to do after a reconnect, in order. */
export async function resync(): Promise<void> {
  let reset = false;
  try {
    const h = await api.health();
    if (connection.serverPid !== null && h.pid !== connection.serverPid) {
      connection.restarted = true;
      reset = true;
      await refreshUiToken().catch(() => {});
      activity.reset();
      const served = entryScript(lastFetchedIndex());
      const mine = typeof document !== 'undefined' ? document.querySelector<HTMLScriptElement>('script[type="module"][src]')?.getAttribute('src') ?? null : null;
      if (served && mine && served !== mine) connection.uiOutdated = true;
      else toast('Reconnected to a restarted server', 'info');
    }
    connection.serverPid = h.pid;
  } catch { /* the stream is up, health will answer next time */ }
  await Promise.all([assets.refresh(), reviews.refresh(), uiState.load()]);
  try {
    const { entries } = await api.activity(reset ? { limit: 600 } : { since: activity.lastId, limit: 1500 });
    activity.load(entries);
  } catch { /* older server */ }
  const ev = { type: 'resync' } as const;
  workspace.viewer('A')?.onEvent?.(ev);
  workspace.viewer('B')?.onEvent?.(ev);
  for (const h of afterHooks) h(ev);
}

let stream: EventStream | null = null;
let ticker: ReturnType<typeof setInterval> | null = null;

export function start(o: Partial<EventStreamOptions> = {}): void {
  stop();
  stream = new EventStream({
    onEvent: route,
    onOpen: ({ reconnect }) => { connection.phase = 'open'; connection.attempt = 0; if (reconnect) void resync(); },
    onDown: ({ attempt }) => { connection.phase = 'down'; connection.attempt = attempt; },
    ...o,
  });
  stream.start();
  ticker = setInterval(() => connection.tick(), 1000);
}
export function stop(): void {
  stream?.stop();
  stream = null;
  if (ticker) clearInterval(ticker);
  ticker = null;
}
