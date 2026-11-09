<!-- Red inline error message with an optional Retry. -->
<script lang="ts">
  import Button from './Button.svelte';

  let { text, onretry }: { text: string; onretry?: () => void } = $props();
</script>

<div class="error error-note" role="alert">
  <span>{text}</span>
  {#if onretry}<Button size="sm" icon="rotate-ccw" onclick={() => onretry?.()}>Retry</Button>{/if}
</div>

<style>
  .error-note { display: flex; align-items: center; gap: var(--s-4); flex-wrap: wrap; }
</style>
