<!-- Test harness: an open Dialog with a body and a footer button. -->
<script lang="ts">
  import Dialog from '@/components/ui/Dialog.svelte';

  let { onclose, closeOnEscape = true }: { onclose: () => void; closeOnEscape?: boolean } = $props();
</script>

<button type="button">opener</button>
<Dialog open title="Test dialog" {onclose} {closeOnEscape} initialFocus="#second">
  <p>Body text</p>
  <button type="button" id="first">First</button>
  <button type="button" id="second">Second</button>
  {#snippet footer()}<button type="button">Done</button>{/snippet}
</Dialog>
