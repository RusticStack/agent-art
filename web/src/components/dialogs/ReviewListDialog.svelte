<!--
  R6 review list: "Review notes · N open", active first then newest, each card prefixed with its asset id;
  a button or link in a card closes the dialog before it acts.
-->
<script lang="ts">
  import type { DialogSpec } from '@/state/dialogs.svelte';
  import { reviews } from '@/state/reviews.svelte';
  import Dialog from '../ui/Dialog.svelte';
  import ReviewCard from '../inspector/ReviewCard.svelte';
  import { isActive } from '../inspector/logic';

  let { onclose }: { spec: Extract<DialogSpec, { type: 'reviewList' }>; onclose: (result?: unknown) => void } = $props();

  const list = $derived.by(() => { void reviews.rev; return reviews.sortedAll(); });
  const open = $derived(list.filter((r) => isActive(r.status)).length);
  let closed = false;
  const close = () => { if (closed) return; closed = true; onclose(); };
</script>

<Dialog open title="Review notes · {open} open" size="lg" onclose={close} class="review-list-dlg">
  <div class="review-list">
    {#each list as r (r.id)}
      <div class="rl-item"><ReviewCard review={r} showAsset onnavigate={close} /></div>
    {:else}
      <div class="muted">No review notes yet. Press M, then drag a box (or click a pin) on what needs fixing.</div>
    {/each}
  </div>
</Dialog>
