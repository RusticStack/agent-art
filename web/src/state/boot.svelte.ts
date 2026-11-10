// Boot sequence (P2, P3): stores in parallel, then the activity log, then the event stream, then the
// first target (the hash, else the most recently updated canvas, else the empty state).
import { api } from '@/lib/api/client';
import { hashToTarget } from '@/lib/util/hash';
import { activity } from './activity.svelte';
import { assets } from './assets.svelte';
import { connection } from './connection.svelte';
import * as live from './live.svelte';
import { reviews } from './reviews.svelte';
import { uiState } from './uiState.svelte';
import { workspace } from './workspace.svelte';

class BootState {
  /** loading: before the first asset index; ready: booted; failed: the first asset request failed */
  phase = $state<'loading' | 'ready' | 'failed'>('loading');
}
export const bootState = new BootState();

/** P3: the hash target when it is not a canvas or is a canvas that exists, else the newest canvas. */
export function openInitial(hash = typeof location === 'undefined' ? '' : location.hash): void {
  const t = hashToTarget(hash);
  const a = assets.index;
  if (t && (t.kind !== 'canvas' || a?.canvases.some((c) => c.name === t.name))) { workspace.open(t, { history: false }); return; }
  if (a?.canvases.length) workspace.open({ kind: 'canvas', name: [...a.canvases].sort((x, y) => y.updated - x.updated)[0].name });
}

let started = false;

export async function boot(): Promise<void> {
  const health = api.health().catch(() => null);
  await Promise.all([uiState.load(), assets.refresh(), reviews.refresh()]);
  try {
    const { entries } = await api.activity({ limit: 600 });
    activity.load(entries);
  } catch { /* older server */ }
  const h = await health;
  connection.serverPid = h?.pid ?? null;
  connection.setUiStatus(h?.ui);
  if (!started) { started = true; live.start(); }
  if (!assets.index) { bootState.phase = 'failed'; return; }
  openInitial();
  bootState.phase = 'ready';
}

/** "Cannot reach the Agent Art server" → Retry. */
export async function retryBoot(): Promise<void> {
  bootState.phase = 'loading';
  await boot();
}
