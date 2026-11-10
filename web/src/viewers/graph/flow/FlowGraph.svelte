<script lang="ts">
  // The Cards renderer view: Svelte Flow with asset cards, relation edges, minimap, zoom controls and a dot
  // background. Gets everything through the bridge (no store or components/ imports, plan 2.2).
  import '@xyflow/svelte/dist/base.css';
  import { setContext } from 'svelte';
  import { Background, BackgroundVariant, Controls, MiniMap, SvelteFlow, type Node } from '@xyflow/svelte';
  import { KIND_COLOR } from '@/lib/util/kinds';
  import { LABEL_ZOOM, LOD_FAR_ZOOM } from '../cards';
  import AssetNode from './AssetNode.svelte';
  import FlowApi from './FlowApi.svelte';
  import RelEdge from './RelEdge.svelte';
  import { BRIDGE_KEY, type CardNode, type FlowBridge, type RelFlowEdge } from './bridge.svelte';

  let { bridge }: { bridge: FlowBridge } = $props();
  // svelte-ignore state_referenced_locally
  setContext(BRIDGE_KEY, bridge);

  const nodeTypes = { asset: AssetNode };
  const edgeTypes = { rel: RelEdge };
  const lod = $derived(bridge.zoom < LOD_FAR_ZOOM ? 'far' : 'near');
  const labels = $derived(bridge.zoom > LABEL_ZOOM ? 'on' : 'off');
  const ARROWS: Record<string, [number, number]> = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] };

  const kindColor = (n: Node): string => (typeof n.data.color === 'string' ? n.data.color : KIND_COLOR.file);

  /** Enter on a focused node selects it; Enter on the selected node opens it. Arrow moves count as a drag end. */
  function onKey(e: KeyboardEvent) {
    const el = e.target as HTMLElement | null;
    if (!el?.classList?.contains('svelte-flow__node')) return;
    const id = el.dataset.id;
    if (!id) return;
    if (e.key === 'Enter') {
      if (bridge.selected === id) bridge.cb.activate(id); else bridge.cb.select(id);
      e.preventDefault();
      e.stopPropagation();
    } else if (e.key === 'Escape') {
      bridge.cb.select(null);
    } else if (ARROWS[e.key] && bridge.selected === id) {
      e.stopPropagation(); // the viewer's own keys must not also act
      requestAnimationFrame(() => {
        const n = bridge.nodes.find((m) => m.id === id);
        if (n) bridge.cb.moved(id, n.position.x, n.position.y);
      });
    }
  }
</script>

<div class="aa-flow" data-lod={lod} data-labels={labels} onkeydown={onKey} role="presentation">
  <SvelteFlow
    bind:nodes={() => bridge.nodes, (v: CardNode[]) => { bridge.nodes = v; }}
    bind:edges={() => bridge.edges, (v: RelFlowEdge[]) => { bridge.edges = v; }}
    {nodeTypes}
    {edgeTypes}
    colorMode="dark"
    nodeOrigin={[0.5, 0.5]}
    minZoom={0.05}
    maxZoom={6}
    nodesDraggable
    nodesConnectable={false}
    nodesFocusable
    edgesFocusable={false}
    elementsSelectable
    selectNodesOnDrag={false}
    deleteKey={null}
    selectionKey={null}
    multiSelectionKey={null}
    zoomOnDoubleClick={false}
    zoomOnScroll
    panOnDrag
    onlyRenderVisibleElements
    elevateEdgesOnSelect={false}
    onnodeclick={({ node }) => bridge.cb.select(node.id)}
    onnodedragstop={({ targetNode }) => { if (targetNode) bridge.cb.moved(targetNode.id, targetNode.position.x, targetNode.position.y); }}
    onpaneclick={() => bridge.cb.select(null)}
  >
    <Background variant={BackgroundVariant.Dots} gap={20} size={1} />
    <Controls showLock={false} />
    <MiniMap nodeColor={kindColor} nodeStrokeWidth={0} pannable zoomable ariaLabel="Graph overview" />
    <FlowApi {bridge} />
  </SvelteFlow>
</div>

<style>
  .aa-flow { position: absolute; inset: 0; }
  .aa-flow.aa-flow :global(.svelte-flow) { /* beats .svelte-flow.dark of base.css whatever the sheet order */
    --xy-background-color: var(--canvas-bg);
    --xy-background-pattern-color: var(--line2);
    --xy-edge-stroke: var(--line3);
    --xy-minimap-background-color: var(--panel);
    --xy-minimap-mask-background-color: rgba(0, 0, 0, .45);
    --xy-minimap-node-background-color: var(--line3);
    --xy-node-border: none;
    --xy-node-border-selected: none;
    --xy-node-color: var(--text);
    --xy-attribution-background-color: transparent;
    font-family: var(--font-ui);
  }
  .aa-flow :global(.svelte-flow__node) { border-radius: var(--r-3); outline: none; }
  .aa-flow :global(.svelte-flow__node:focus-visible) { box-shadow: 0 0 0 2px var(--focus); }
  .aa-flow :global(.svelte-flow__controls) { gap: 2px; box-shadow: none; }
  .aa-flow :global(.svelte-flow__controls-button) {
    width: 28px; height: 28px; padding: 6px; background: var(--panel2); border: 1px solid var(--line2);
    border-radius: 6px; color: var(--text); fill: currentColor;
  }
  .aa-flow :global(.svelte-flow__controls-button:hover) { background: var(--panel3); border-color: var(--line3); }
  .aa-flow :global(.svelte-flow__minimap) { border: 1px solid var(--line2); border-radius: var(--r-3); overflow: hidden; }
  .aa-flow :global(.svelte-flow__attribution a) { color: var(--dim); }
</style>
