<!--
  Slot header (L6–L9): kind icon, name (or "Asset graph"), the snapshot badge, "Back to live" (slot A),
  the viewer tabs (keys 1–5). Slot B adds, while both slots hold a canvas viewer, the compare tools
  (RV7: Link toggle, Overlay select, the status text), then Swap and Close.
-->
<script lang="ts">
  import { KIND_ICON_NAME } from '@/lib/util/kinds';
  import { currentTab, tabsFor, type TabId } from '@/lib/util/targets';
  import { assets } from '@/state/assets.svelte';
  import { workspace } from '@/state/workspace.svelte';
  import { compareToolsShown, OVERLAY_LABEL, OVERLAY_ORDER } from '@/viewers/canvas/compare';
  import type { CompareOverlay, SlotId, Target } from '@/viewers/types';
  import Icon from '../ui/Icon.svelte';
  import Tabs from '../ui/Tabs.svelte';

  let { slot }: { slot: SlotId } = $props();

  const target = $derived<Target | null>(workspace.slots[slot].target);
  const snap = $derived(target && 'snap' in target && target.snap ? target : null);
  const name = $derived(!target ? '' : target.kind === 'graph' ? 'Asset graph' : target.name);
  const icon = $derived(target ? KIND_ICON_NAME[target.kind] ?? null : null);
  const tabs = $derived(tabsFor(target, assets.index).map((t, i) => ({ id: t.id, label: t.label, shortcut: String(i + 1) })));
  const tab = $derived(currentTab(target) ?? '');
  const tools = $derived(slot === 'B' && compareToolsShown(workspace.slots.A.target, workspace.slots.B.target));

  function backToLive(): void { workspace.backToLive(); }
  function setOverlay(e: Event): void { workspace.compareOverlay = (e.currentTarget as HTMLSelectElement).value as CompareOverlay; }
</script>

<div class="slot-head">
  <div class="slot-title" id="title{slot}">
    {#if target}
      <span class="kicon" style:color="var(--k-{target.kind}, var(--muted))">{#if icon}<Icon name={icon} size={14} />{:else}•{/if}</span>
      <span class="slot-name" title={name}>{name}</span>
      {#if snap}<span class="badge state">state {snap.label || snap.snap}</span>{/if}
      {#if snap && slot === 'A'}<button type="button" class="btn small" onclick={backToLive}>Back to live</button>{/if}
    {/if}
  </div>
  <div class="slot-tabs" id="tabs{slot}">
    {#if tabs.length}
      <Tabs {tabs} value={tab} label={slot === 'A' ? 'Viewer tabs' : 'Comparison viewer tabs'} idPrefix="slot{slot}" onchange={(id) => workspace.switchView(slot, id as TabId)} />
    {/if}
  </div>
  {#if slot === 'B'}
    <div class="spacer"></div>
    {#if tools}
      <div class="compare-tools" role="group" aria-label="Compare tools">
        <button type="button" class={['btn', 'small', workspace.compareLink && 'on']} aria-pressed={workspace.compareLink}
          title="Link zoom, pan and frame" onclick={() => { workspace.compareLink = !workspace.compareLink; }}>Link</button>
        <select class="compare-overlay" aria-label="Overlay" title="Show slot B over slot A (D)" value={workspace.compareOverlay} onchange={setOverlay}>
          {#each OVERLAY_ORDER as m (m)}<option value={m}>{OVERLAY_LABEL[m]}</option>{/each}
        </select>
        {#if workspace.compareStatus}<span class="mono muted compare-status" role="status">{workspace.compareStatus}</span>{/if}
      </div>
    {/if}
    <button type="button" class="btn small icon" id="swapB" title="Swap sides" aria-label="Swap sides" onclick={() => workspace.swap()}><Icon name="arrow-left-right" size={14} /></button>
    <button type="button" class="btn small icon" id="closeB" title="Close comparison (C / Esc)" aria-label="Close comparison (C / Esc)" onclick={() => workspace.setCompare(false)}><Icon name="x" size={14} /></button>
  {/if}
</div>

<style>
  .slot-head { display: flex; align-items: center; gap: 10px; padding: 4px 10px; background: var(--panel); border-bottom: 1px solid var(--line); min-height: 34px; flex: none; }
  .slot-title { display: flex; align-items: center; gap: 6px; font-weight: 600; min-width: 0; overflow: hidden; white-space: nowrap; }
  .slot-name { overflow: hidden; text-overflow: ellipsis; }
  .slot-tabs { display: flex; flex: none; }
  .slot-tabs :global(.tabs) { display: flex; gap: 2px; }
  .slot-tabs :global(.tab) { border-radius: 6px 6px 0 0; border-bottom: 0; padding: 3px 10px; font-size: 12px; }
  .compare-tools { display: flex; align-items: center; gap: 6px; min-width: 0; }
  .compare-status { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 28ch; }
</style>
