<!-- .chip: a <button> when it acts (aria-pressed from `active`), a <span> when it only labels. -->
<script lang="ts">
  import type { Snippet } from 'svelte';

  let { active, dim = false, title, onclick, children }: {
    active?: boolean; dim?: boolean; title?: string; onclick?: (e: MouseEvent) => void; children: Snippet;
  } = $props();
  const cls = $derived(['chip', active && 'on', dim && 'dim']);
</script>

{#if onclick}
  <button type="button" class={cls} {title} aria-pressed={active === undefined ? undefined : active} {onclick}>{@render children()}</button>
{:else}
  <span class={cls} {title}>{@render children()}</span>
{/if}
