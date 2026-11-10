<!--
  One viewer slot (L6, L7): header + the viewer host, or the slot's empty / boot / error state.
  Slot B (comparison) is read-only; its empty state says how to fill it.
-->
<script lang="ts">
  import { viewerKindFor } from '@/lib/util/targets';
  import { assets } from '@/state/assets.svelte';
  import { bootState, retryBoot } from '@/state/boot.svelte';
  import { workspace } from '@/state/workspace.svelte';
  import type { SlotId } from '@/viewers/types';
  import EmptyState from '../ui/EmptyState.svelte';
  import Spinner from '../ui/Spinner.svelte';
  import SlotHeader from './SlotHeader.svelte';
  import ViewerHost from './ViewerHost.svelte';

  let { slot, dropOver = false }: { slot: SlotId; dropOver?: boolean } = $props();

  const target = $derived(workspace.slots[slot].target);
  const showable = $derived(!!target && !!viewerKindFor(target));
</script>

<div class="slot-wrap" id="slotWrap{slot}" data-slot={slot} role="region" aria-label={slot === 'A' ? 'Viewer' : 'Comparison viewer'}>
  <SlotHeader {slot} />
  <div class={['slot', dropOver && 'drop-over']} id="slot{slot}">
    {#if showable && target}
      <ViewerHost {slot} {target} />
    {:else if slot === 'B'}
      <div class="empty-note">Alt+click (or Shift+click) an asset in the browser, or ⇆ on a timeline entry, to compare it here.</div>
    {:else if bootState.phase === 'failed' && !assets.index}
      <EmptyState title="Cannot reach the Agent Art server" text={assets.error ? `The asset list did not load (${assets.error}). Is the server still running?` : 'The asset list did not load. Is the server still running?'} icon="circle-alert">
        <button type="button" class="btn" onclick={() => void retryBoot()}>Retry</button>
      </EmptyState>
    {:else if bootState.phase === 'loading'}
      <div class="slot-loading"><Spinner label="Loading" size={20} /></div>
    {:else}
      <div class="empty-note big">
        <h2>Nothing here yet</h2>
        <p>Ask the agent to draw something (it shows up live), or press "+ New" to create a canvas.</p>
      </div>
    {/if}
  </div>
</div>

<style>
  .slot-wrap { min-width: 0; min-height: 0; display: flex; flex-direction: column; background: var(--bg); }
  .slot { flex: 1; min-height: 0; position: relative; display: flex; }
  .slot-loading { margin: auto; }
</style>
