<!-- Key hint: renders a SHORTCUTS `keys` string ("Ctrl+Z/Y", "[ ]", "1–5") as <kbd> elements. -->
<script lang="ts">
  import { keyTokens } from '@/state/shortcuts';

  let { keys }: { keys: string } = $props();
  const tokens = $derived(keyTokens(keys));
</script>

<span class="kbds">{#each tokens as t, i (i)}{#if t.k === 'key'}<kbd>{t.v}</kbd>{:else}{t.v}{/if}{/each}</span>
