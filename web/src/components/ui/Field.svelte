<!-- Labelled form row. The control snippet receives the id to put on its input. -->
<script lang="ts">
  import type { Snippet } from 'svelte';

  let { label, hint, error, children }: {
    label: string; hint?: string; error?: string | null; children: Snippet<[string]>;
  } = $props();
  const id = $props.id();
</script>

<div class="field">
  <label class="field-label" for={id}>{label}</label>
  {@render children(id)}
  {#if error}<div class="error" role="alert">{error}</div>{:else if hint}<div class="muted small">{hint}</div>{/if}
</div>

<style>
  .field { display: flex; flex-direction: column; gap: var(--s-2); }
  .field-label { color: var(--muted); font-size: var(--fs-3); }
</style>
