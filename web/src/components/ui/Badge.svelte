<!-- .badge with a tone (the text always carries the meaning; colour is never the only signal). -->
<script lang="ts">
  import type { Snippet } from 'svelte';

  let { tone = 'neutral', title, children }: {
    tone?: 'neutral' | 'review' | 'ok' | 'state' | 'old' | 'orphan'; title?: string; children: Snippet;
  } = $props();
</script>

<span class={['badge', tone !== 'neutral' && tone]} {title}>{@render children()}</span>
