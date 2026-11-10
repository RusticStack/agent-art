<!-- I11: notes on the asset or comparing with it, newest update first (reactive on the reviews store). -->
<script lang="ts">
  import { reviews } from '@/state/reviews.svelte';
  import ReviewCard from './ReviewCard.svelte';
  import Section from './Section.svelte';
  import { isActive } from './logic';

  let { id }: { id: string } = $props();
  const notes = $derived.by(() => { void reviews.rev; return reviews.forAsset(id); });
  const open = $derived(notes.filter((r) => isActive(r.status)).length);
</script>

<Section title="Review notes ({open} open)">
  {#if !notes.length}<div class="muted small">No notes. Press M (review mode) and drag a box or click a pin in the viewer.</div>{/if}
  {#each notes as r (r.id)}<ReviewCard review={r} />{/each}
</Section>
