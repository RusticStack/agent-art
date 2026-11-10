<!--
  Activity timeline (1.5, TL1–TL13; RV6, RV9). Reads the activity / workspace / uiState stores. The list
  is virtualised (every filtered entry of the 3000 kept, newest first); virtua keeps the reading
  position when entries arrive above (TL12). The dock button only calls `ontoggleDock` (the layout
  lives in the shell).
-->
<script lang="ts">
  import type { ActivityEntry } from '@/lib/api/types';
  import Icon from '@/components/ui/Icon.svelte';
  import PaneHeader from '@/components/ui/PaneHeader.svelte';
  import VirtualList from '@/components/ui/VirtualList.svelte';
  import EmptyState from '@/components/ui/EmptyState.svelte';
  import { activity } from '@/state/activity.svelte';
  import { workspace } from '@/state/workspace.svelte';
  import { uiState } from '@/state/uiState.svelte';
  import { assets } from '@/state/assets.svelte';
  import { viewerKindFor } from '@/lib/util/targets';
  import type { Target } from '@/viewers/types';
  import { allHidden, clickTarget, compareTargets, type Hit } from './timeline';
  import TimelineFilters from './TimelineFilters.svelte';
  import TimelineEntry from './TimelineEntry.svelte';

  let { ontoggleDock }: { ontoggleDock?: () => void } = $props();

  const data = $derived.by(() => {
    void activity.version;
    return activity.rows(activity.filter.current ? workspace.current : null);
  });
  const counter = $derived(`${data.shown.length}/${data.total}${data.errors ? ` · ${data.errors} err` : ''}`);

  // virtua's `shift` keeps the visible entries in place when entries are added at the start. At the very
  // top the newest entry should appear at the top instead (legacy), so shift only while scrolled down.
  let scrolled = $state(false);

  const isEntry = (e: ActivityEntry | undefined): e is ActivityEntry => !!e;
  function opsOf(e: ActivityEntry): ActivityEntry[] {
    void activity.version;
    return e.type === 'tool' ? (e.ops ?? []).map((id) => activity.get(id)).filter(isEntry) : [];
  }

  /** Navigate like the stores do: the shell's navigator mounts the viewer, else state only. */
  function go(t: Target | null): void {
    if (!t || !viewerKindFor(t)) return;
    if (workspace.navigator) workspace.navigator(t); else workspace.open(t);
  }
  const openHit = (e: ActivityEntry, hit: Hit) => go(clickTarget(e, hit, assets.index));
  function compare(e: ActivityEntry): void {
    const pair = compareTargets(e);
    if (pair) workspace.compare(pair[0], pair[1]);
  }
</script>

<section class="timeline" aria-label="Activity">
  <PaneHeader title="Activity">
    <span class="muted mono tl-count">{counter}</span>
    <button type="button" class="btn small icon" title="Move timeline (P): right / bottom" aria-label="Move timeline (P): right / bottom"
      onclick={() => ontoggleDock?.()}><Icon name="arrow-up-down" size={14} /></button>
  </PaneHeader>
  <TimelineFilters tools={data.tools} />
  {#if data.shown.length}
    <VirtualList items={data.shown} key={(e) => String(e.id)} rowHeight={46} shift={scrolled} class="tl-list" role="list" label="Activity entries"
      onscroll={(offset) => { scrolled = offset > 0; }}>
      {#snippet row(e)}
        <TimelineEntry entry={e} ops={opsOf(e)} expanded={activity.expanded.has(e.id)} dimmed={allHidden(e, (id) => uiState.isHidden(id))}
          onopen={(hit) => openHit(e, hit)} oncompare={() => compare(e)} ontoggle={() => activity.toggleExpanded(e.id)} />
      {/snippet}
    </VirtualList>
  {:else}
    <div class="tl-list tl-empty">
      <EmptyState text={data.total ? 'No entries match the filters.' : 'Waiting for the agent… every tool call shows up here.'} />
    </div>
  {/if}
</section>

<style>
  .timeline { flex: 1; min-height: 0; min-width: 0; display: flex; flex-direction: column; }
  .tl-count { white-space: nowrap; }
  .timeline :global(.tl-list) { flex: 1 1 0; min-height: 0; }
  .tl-empty { overflow: auto; display: flex; }
</style>
