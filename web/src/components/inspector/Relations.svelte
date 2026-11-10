<!--
  I12: tags, note, edges out (`rel →`) and in (`← rel`) without layer_of, non-derived first, attrs as {k:v},
  links open the node, max 40 then "+N more"; "Show in graph". No graph node (request failed): label only.
-->
<script lang="ts">
  import type { GraphNodeInfo } from '@/lib/api/types';
  import type { Target } from '@/viewers/types';
  import Chip from '../ui/Chip.svelte';
  import Icon from '../ui/Icon.svelte';
  import Section from './Section.svelte';
  import { linkHash, relationRows } from './logic';

  let { id, node, onopennode, onopen }: {
    id: string; node: GraphNodeInfo | null; onopennode: (id: string) => void; onopen: (t: Target) => void;
  } = $props();
  const rel = $derived(relationRows(node));
</script>

<Section title="Relations">
  {#if node}
    {#if node.tags?.length}<div class="tag-list">{#each node.tags as t (t)}<Chip>#{t}</Chip>{/each}</div>{/if}
    {#if node.note}<div class="notes">{node.note}</div>{/if}
    <ul class="rel-list">
      {#each rel.rows as x, i (i)}
        <li class={[x.derived && 'derived']}>
          <span class="rel">{x.dir === 'out' ? `${x.rel} →` : `← ${x.rel}`}</span>
          <a href={linkHash(x.other)} onclick={(e) => { e.preventDefault(); onopennode(x.other); }}>{x.other}</a>{#if x.attrs}<span class="muted">{x.attrs}</span>{/if}
        </li>
      {/each}
      {#if rel.more}<li class="muted">+{rel.more} more</li>{/if}
      {#if !rel.total}<li class="muted">No relations yet (the agent adds them with art_graph link / group).</li>{/if}
    </ul>
    <button type="button" class="btn small" onclick={() => onopen({ kind: 'graph', focus: id })}><Icon name="waypoints" />Show in graph</button>
  {/if}
</Section>
