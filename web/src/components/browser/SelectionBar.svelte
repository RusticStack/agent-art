<!--
  Select mode bar (B21): "<n> selected", All shown, by tag…, Clear, Plan cleanup… (disabled at 0).
-->
<script lang="ts">
  import Button from '@/components/ui/Button.svelte';
  import Select from '@/components/ui/Select.svelte';

  let { count, tags, onall, ontag, onclear, onplan }: {
    count: number;
    tags: readonly string[];
    onall: () => void;
    ontag: (tag: string) => void;
    onclear: () => void;
    onplan: () => void;
  } = $props();

  let tag = $state('');
  const options = $derived([{ value: '', label: 'by tag…' }, ...tags.map((t) => ({ value: t, label: '#' + t }))]);
  function pick(v: string): void {
    if (v) ontag(v);
    tag = '';
  }
</script>

<div class="selbar" role="region" aria-label="Selection">
  <div class="selbar-row">
    <span class="mono count" aria-live="polite">{count} selected</span>
    <div class="spacer"></div>
    <Button size="sm" title="Select every asset the filter shows" onclick={onall}>All shown</Button>
    <Select bind:value={tag} {options} label="Add every asset with this tag" title="Add every asset with this tag" onchange={pick} />
    <Button size="sm" onclick={onclear}>Clear</Button>
  </div>
  <div class="selbar-row">
    <span class="grow"><Button size="sm" variant="primary" disabled={!count} title="Dry run: what goes, sizes, what still depends on it" onclick={onplan}>Plan cleanup…</Button></span>
  </div>
</div>

<style>
  .selbar { border-top: 1px solid var(--line); background: var(--bg2); padding: var(--s-3) var(--s-4); display: flex; flex-direction: column; gap: var(--s-3); flex: none; }
  .selbar-row { display: flex; align-items: center; gap: var(--s-3); }
  .selbar-row :global(select) { max-width: 92px; }
  .count { font-variant-numeric: tabular-nums; white-space: nowrap; }
  .grow { flex: 1; display: flex; }
  .grow :global(.btn) { flex: 1; justify-content: center; }
</style>
