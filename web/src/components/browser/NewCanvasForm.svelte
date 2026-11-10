<!--
  New canvas form (B2): name ([A-Za-z0-9_\-.]{1,64}, required), width and height (1..4096, default 16).
  Submit runs op create, hides the form, clears the name and opens the canvas (as legacy: also when
  create failed, e.g. the name exists; op() already toasted the error). Focus starts on the name.
-->
<script lang="ts">
  import Button from '@/components/ui/Button.svelte';
  import { op } from '@/lib/api/client';

  let { onclose, oncreated }: { onclose: () => void; oncreated: (name: string) => void } = $props();

  let name = $state('');
  let width = $state(16);
  let height = $state(16);
  let nameEl: HTMLInputElement | undefined = $state();

  $effect(() => { nameEl?.focus(); });

  async function submit(e: SubmitEvent): Promise<void> {
    e.preventDefault();
    const n = name.trim();
    await op('create', { name: n, width: Number(width), height: Number(height) }).catch(() => null);
    name = '';
    onclose();
    oncreated(n);
  }
</script>

<form class="new-form" aria-label="New canvas" onsubmit={submit}>
  <input bind:this={nameEl} bind:value={name} placeholder="name" aria-label="Canvas name" required pattern={'[A-Za-z0-9_\\-.]{1,64}'} />
  <div class="row-inline">
    <input type="number" bind:value={width} min="1" max="4096" title="width" aria-label="Width" />
    <span aria-hidden="true">×</span>
    <input type="number" bind:value={height} min="1" max="4096" title="height" aria-label="Height" />
    <Button size="sm" variant="primary" type="submit">Create</Button>
    <Button size="sm" onclick={onclose}>Cancel</Button>
  </div>
</form>

<style>
  .new-form { display: flex; flex-direction: column; gap: var(--s-3); padding: var(--s-4); border-bottom: 1px solid var(--line); flex: none; }
  .row-inline { display: flex; align-items: center; gap: var(--s-2); }
  .row-inline input[type=number] { width: 64px; }
</style>
