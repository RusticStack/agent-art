<!-- Key / value table; rows whose value is undefined, null or '' are skipped. -->
<script lang="ts">
  let { rows }: { rows: readonly (readonly [string, unknown])[] } = $props();
  const shown = $derived(rows.filter(([, v]) => v !== undefined && v !== null && v !== ''));
  const text = (v: unknown): string => (typeof v === 'object' ? JSON.stringify(v) : String(v));
</script>

<dl class="kv">
  {#each shown as [k, v] (k)}<dt>{k}</dt><dd title={text(v)}>{text(v)}</dd>{/each}
</dl>

<style>
  .kv { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: var(--s-1) var(--s-4); margin: 0; font-size: var(--fs-3); }
  dt { color: var(--muted); }
  dd { margin: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
