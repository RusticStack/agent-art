<!-- Test harness: VirtualList with a row snippet that prints item and index. -->
<script lang="ts">
  import VirtualList, { type ScrollToIndexFn } from '@/components/ui/VirtualList.svelte';

  interface Item { id: string; name: string }
  let { items, onscrollfn }: { items: Item[]; onscrollfn: (fn: ScrollToIndexFn) => void } = $props();
</script>

<div style="height: 200px">
  <VirtualList {items} key={(i) => i.id} rowHeight={20} role="list" label="Things" scrollToIndex={onscrollfn}>
    {#snippet row(item, index)}<div class="r" role="listitem" data-key={item.id}>{index}:{item.name}</div>{/snippet}
  </VirtualList>
</div>
