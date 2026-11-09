<script lang="ts">
  // Straight relation edge from card border to card border: relation colour, dashed when not derived,
  // arrow head at the target, label (relation + attrs) when zoomed in or touching the selection.
  import type { EdgeProps } from '@xyflow/svelte';
  import { clipToBoxes } from '../cards';
  import type { RelFlowEdge } from './bridge.svelte';

  let { sourceX, sourceY, targetX, targetY, data }: EdgeProps<RelFlowEdge> = $props();
  const seg = $derived(clipToBoxes(sourceX, sourceY, targetX, targetY));
  const head = $derived.by(() => {
    if (!seg) return '';
    const dx = seg.x2 - seg.x1, dy = seg.y2 - seg.y1, d = Math.hypot(dx, dy) || 1, ux = dx / d, uy = dy / d, s = 7;
    const bx = seg.x2 - ux * s, by = seg.y2 - uy * s;
    return `M${seg.x2},${seg.y2}L${bx - uy * s * 0.5},${by + ux * s * 0.5}L${bx + uy * s * 0.5},${by - ux * s * 0.5}Z`;
  });
</script>

{#if seg && data}
  <g class="aa-rel" class:sel={data.sel} class:dim={data.dim} style:--rc={data.color}>
    <path class="aa-line" class:dashed={!data.derived} d="M{seg.x1},{seg.y1}L{seg.x2},{seg.y2}" fill="none" />
    <path class="aa-head" d={head} />
    {#if data.sel || data.labelOk}
      <text class="aa-lbl" class:pin={data.sel} x={(seg.x1 + seg.x2) / 2 + 3} y={(seg.y1 + seg.y2) / 2 - 3}>{data.label}</text>
    {/if}
  </g>
{/if}

<style>
  .aa-line { stroke: var(--rc); stroke-opacity: .6; stroke-width: 1.25; }
  .aa-line.dashed { stroke-dasharray: 5 3; }
  .aa-head { fill: var(--rc); fill-opacity: .6; }
  .sel .aa-line { stroke-opacity: 1; stroke-width: 2; }
  .sel .aa-head { fill-opacity: 1; }
  .dim .aa-line, .dim .aa-head { stroke-opacity: .27; fill-opacity: .27; }
  .aa-lbl { fill: var(--text2); font: var(--fs-1) var(--font-mono); pointer-events: none; display: none; }
  .aa-lbl.pin, :global([data-labels='on']) .aa-lbl { display: inline; }
  :global([data-lod='far']) .aa-lbl:not(.pin) { display: none; }
</style>
