<!--
  The viewers area: slot A, slot B while comparing (side by side, stacked in the narrow layout), and the
  drop targets for an asset row dragged from the browser (RV3): a drop on a slot opens it there; while
  not comparing, a "Compare here" zone covers the right 28 % and a drop on it opens slot B.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { hasDragTarget, readDragTarget } from '@/components/browser/drag';
  import { workspace } from '@/state/workspace.svelte';
  import type { SlotId } from '@/viewers/types';
  import ViewerSlot from './ViewerSlot.svelte';

  let depth = 0;
  let dragging = $state(false);
  let over = $state<SlotId | null>(null);
  let zone: HTMLElement | undefined = $state();

  const end = () => { depth = 0; dragging = false; over = null; };
  const slotOf = (t: EventTarget | null): SlotId | null => (t instanceof Element ? ((t.closest('[data-slot]') as HTMLElement | null)?.dataset.slot as SlotId | undefined) ?? null : null);
  const inZone = (t: EventTarget | null): boolean => !!zone && t instanceof Node && zone.contains(t);

  function ondragenter(e: DragEvent): void {
    if (!hasDragTarget(e)) return;
    depth++;
    dragging = true;
  }
  function ondragleave(e: DragEvent): void {
    if (hasDragTarget(e) && --depth <= 0) end();
  }
  function ondragover(e: DragEvent): void {
    if (!hasDragTarget(e)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    over = inZone(e.target) ? null : slotOf(e.target) === 'B' ? 'B' : 'A';
  }
  function ondrop(e: DragEvent): void {
    const t = readDragTarget(e);
    const toB = inZone(e.target) || slotOf(e.target) === 'B';
    end();
    if (!t) return;
    e.preventDefault();
    workspace.open(t, { slot: toB ? 'B' : 'A' });
  }
  onMount(() => {
    window.addEventListener('dragend', end);
    return () => window.removeEventListener('dragend', end);
  });
</script>

<div id="viewers" class={['viewers', workspace.comparing && 'compare']} role="group" aria-label="Viewers" {ondragenter} {ondragleave} {ondragover} {ondrop}>
  <ViewerSlot slot="A" dropOver={over === 'A'} />
  {#if workspace.comparing}<ViewerSlot slot="B" dropOver={over === 'B'} />{/if}
  <div class="drop-compare" bind:this={zone} hidden={!dragging || workspace.comparing}>Compare here</div>
</div>

<style>
  .viewers { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(0, 1fr); grid-template-rows: minmax(0, 1fr); }
  .viewers.compare { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 4px; background: var(--line); }
  @media (max-width: 860px) {
    .viewers.compare { grid-template-columns: minmax(0, 1fr); grid-template-rows: minmax(0, 1fr) minmax(0, 1fr); }
  }
</style>
