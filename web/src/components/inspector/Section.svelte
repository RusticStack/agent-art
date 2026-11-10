<!-- One inspector section: .insp-sec with its .panel-label heading (the e2e locators use both). -->
<script lang="ts">
  import type { Snippet } from 'svelte';

  let { title, children }: { title: string; children?: Snippet } = $props();
</script>

<section class="insp-sec" aria-label={title}>
  <h3 class="panel-label">{title}</h3>
  {@render children?.()}
</section>
