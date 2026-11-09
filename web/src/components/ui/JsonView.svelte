<!-- Syntax-coloured JSON (RV9): one span per token from tokenizeJson, never {@html}. -->
<script lang="ts">
  import { JSON_CLASS, tokenizeJson } from '@/lib/util/jsonTokens';

  let { text, maxChars = 200_000 }: { text: string; maxChars?: number } = $props();
  const tokens = $derived(text.length > maxChars ? null : tokenizeJson(text));
</script>

<pre class="json">{#if tokens}{#each tokens as tok, i (i)}{#if JSON_CLASS[tok.t]}<span class={JSON_CLASS[tok.t]}>{tok.v}</span>{:else}{tok.v}{/if}{/each}{:else}{text}{/if}</pre>
