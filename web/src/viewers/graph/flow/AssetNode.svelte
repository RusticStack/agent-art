<script lang="ts">
  // One asset card (156 × 44): kind edge colour, thumbnail or kind icon, name, tags / note, the browser
  // row badges, and a hover / focus toolbar (Open, Compare, Pin, Hide). Groups use the same card.
  import { getContext } from 'svelte';
  import { Handle, Position, type NodeProps } from '@xyflow/svelte';
  import { icon } from '@/lib/util/dom';
  import type { IconName } from '@/lib/util/icons';
  import type { NodeAction } from '../renderer';
  import { BRIDGE_KEY, type CardNode, type FlowBridge } from './bridge.svelte';

  let { id, data, selected }: NodeProps<CardNode> = $props();
  const bridge = getContext<FlowBridge>(BRIDGE_KEY);

  /** The kind's Lucide icon (a build-time SVG constant appended as a node). */
  function kindIcon(el: HTMLElement, name: IconName) {
    el.replaceChildren(icon(name));
    return { update(n: IconName) { el.replaceChildren(icon(n)); } };
  }
  function act(e: MouseEvent, a: NodeAction | 'open') {
    e.stopPropagation();
    bridge.cb.action(id, a);
  }
  function dbl(e: MouseEvent) {
    if ((e.target as HTMLElement).closest('.aa-tools')) return;
    bridge.cb.activate(id);
  }
</script>

<div
  class="aa-card"
  class:missing={data.missing}
  class:dim={data.dim}
  class:sel={selected || bridge.selected === id}
  class:group={data.group}
  style:--kc={data.color}
  data-kind={data.kind}
  ondblclick={dbl}
  role="presentation"
>
  <Handle type="target" position={Position.Left} isConnectable={false} class="aa-h" />
  <Handle type="source" position={Position.Right} isConnectable={false} class="aa-h" />
  {#if data.thumb}
    <span class="aa-th"><img src={data.thumb} alt="" loading="lazy" decoding="async" draggable="false" /></span>
  {:else}
    <span class="aa-ic" use:kindIcon={data.icon}></span>
  {/if}
  <span class="aa-txt">
    <span class="aa-name" title={data.id}>{data.label}</span>
    {#if data.sub}<span class="aa-sub">{data.sub}</span>{/if}
  </span>
  <span class="aa-badges">
    {#if data.folded}<span class="badge" title="{data.folded} folded members">+{data.folded}</span>{/if}
    {#if data.reviews}<span class="badge review" title="{data.reviews} open review note(s)">{data.reviews}</span>{/if}
    {#if data.approved}<span class="badge ok" title="approved">✓</span>{/if}
    {#if data.superseded}<span class="badge old" title="replaced by a newer asset">superseded</span>{/if}
    {#if data.orphan}<span class="badge orphan" title="nothing links to it, not in a project or group, not pinned">orphan</span>{/if}
  </span>
  <span class="aa-tools nodrag nopan" role="toolbar" aria-label="{data.label} actions">
    <button type="button" class="btn small" onclick={(e) => act(e, 'open')}>{data.group ? (data.collapsed ? 'Expand' : 'Fold') : 'Open'}</button>
    {#if !data.group}<button type="button" class="btn small" title="Open in the compare slot" onclick={(e) => act(e, 'compare')}>Compare</button>{/if}
    <button type="button" class="btn small" class:on={data.pinned} aria-pressed={data.pinned} onclick={(e) => act(e, 'pin')}>Pin</button>
    <button type="button" class="btn small" class:on={data.hidden} aria-pressed={data.hidden} onclick={(e) => act(e, 'hide')}>Hide</button>
  </span>
</div>

<style>
  .aa-card {
    position: relative; box-sizing: border-box; width: 156px; height: 44px;
    display: flex; align-items: center; gap: 6px; padding: 0 6px 0 8px;
    background: var(--bg2); border: 1px solid var(--line2); border-left: 2px solid var(--kc);
    border-radius: var(--r-3); color: var(--text); font-size: var(--fs-3); line-height: var(--lh-tight);
  }
  .aa-card.group { background: var(--panel); }
  .aa-card.missing { border-style: dashed; opacity: .6; }
  .aa-card.dim { opacity: .35; }
  .aa-card.sel { outline: 2px solid var(--accent); outline-offset: 1px; }
  .aa-th, .aa-ic { flex: none; width: 32px; height: 32px; display: grid; place-items: center; border-radius: var(--r-1); overflow: hidden; }
  .aa-th { background: repeating-conic-gradient(var(--checker-a) 0 25%, var(--checker-b) 0 50%) 0 0 / 8px 8px; }
  .aa-th img { max-width: 100%; max-height: 100%; image-rendering: pixelated; }
  .aa-ic { color: var(--kc); background: var(--panel2); }
  .aa-txt { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
  .aa-name, .aa-sub { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .aa-sub { color: var(--muted); font-size: var(--fs-1); }
  .aa-badges { position: absolute; top: -8px; right: 4px; display: flex; gap: 2px; }
  .aa-tools { position: absolute; bottom: calc(100% + 6px); left: 0; display: none; gap: 2px; padding: 2px; background: var(--panel); border: 1px solid var(--line2); border-radius: var(--r-3); box-shadow: var(--shadow-1); white-space: nowrap; }
  .aa-card:hover .aa-tools, :global(.svelte-flow__node:focus-within) .aa-tools { display: flex; }
  .aa-card :global(.aa-h) { left: 50%; top: 50%; width: 1px; height: 1px; min-width: 0; min-height: 0; border: 0; opacity: 0; pointer-events: none; transform: none; }
  /* far zoom: a kind-coloured pill with the name, no per-node JavaScript */
  :global([data-lod='far']) .aa-card { background: var(--kc); color: var(--accent-ink); border-color: var(--kc); border-radius: var(--r-pill); justify-content: center; }
  :global([data-lod='far']) .aa-card :is(.aa-th, .aa-ic, .aa-sub, .aa-badges, .aa-tools) { display: none; }
  :global([data-lod='far']) .aa-name { font-weight: 600; text-align: center; }
</style>
