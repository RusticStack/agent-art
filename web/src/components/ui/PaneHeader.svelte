<!-- Pane head: section label on the left, actions on the right. -->
<script lang="ts">
  import type { Snippet } from 'svelte';

  let { title, children }: { title: string; children?: Snippet } = $props();
</script>

<div class="pane-head">
  <h2 class="panel-label">{title}</h2>
  <div class="spacer"></div>
  {@render children?.()}
</div>

<style>
  h2.panel-label { margin: 0; font-size: var(--fs-1); font-weight: 700; letter-spacing: .08em; text-transform: uppercase; color: var(--muted); }
</style>
