<script lang="ts">
  // Lives inside <SvelteFlow> (its context): exposes the viewport helpers and the zoom to the bridge.
  import { useNodesInitialized, useSvelteFlow } from '@xyflow/svelte';
  import type { FlowBridge } from './bridge.svelte';

  let { bridge }: { bridge: FlowBridge } = $props();
  const flow = useSvelteFlow();
  const inited = useNodesInitialized();

  $effect(() => {
    const b = bridge;
    b.api = {
      fit: () => { void flow.fitView({ padding: 0.08, maxZoom: 2 }); },
      center: (x, y, minZoom) => { void flow.setCenter(x, y, { zoom: Math.max(flow.getZoom(), minZoom) }); },
      viewport: () => flow.getViewport(),
    };
    return () => { b.api = null; };
  });
  $effect(() => { bridge.zoom = flow.getZoom(); });
  $effect(() => { bridge.cb.initialized(inited.current); });
</script>
