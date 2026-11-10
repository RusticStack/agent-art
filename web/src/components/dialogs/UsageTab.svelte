<!--
  Cleanup › Disk usage (C6): tiles, bars by kind / project / group (top 14, kind colours), the 14 biggest
  assets (a click closes the dialog and opens the asset: onopen), and the select-mode hint.
-->
<script lang="ts">
  import ErrorNote from '../ui/ErrorNote.svelte';
  import CleanupTiles from './CleanupTiles.svelte';
  import KindIcon from './KindIcon.svelte';
  import { op } from '@/lib/api/client';
  import type { DiskUsage } from '@/lib/api/types';
  import { fmtBytes } from '@/lib/util/format';
  import { usageBars, usageTiles } from './cleanup';

  let { onopen }: { onopen: (id: string) => void } = $props();

  let u = $state.raw<DiskUsage | null>(null);
  let error = $state<string | null>(null);

  async function load() {
    u = null;
    error = null;
    try { u = await op('cleanup_usage', { full: true }); } catch (e) { error = (e as Error).message; }
  }
  void load();

  const sections = $derived(u ? [
    { title: 'By kind', bars: usageBars(u.by_kind), color: (k: string) => `var(--k-${k}, #94a3b8)` },
    { title: 'By project', bars: usageBars(u.by_project), color: () => 'var(--k-project)' },
    { title: 'By group', bars: usageBars(u.by_group), color: () => 'var(--k-group)' },
  ] : []);
</script>

{#if error}
  <ErrorNote text={error} onretry={load} />
{:else if !u}
  <div class="muted">measuring…</div>
{:else}
  <CleanupTiles tiles={usageTiles(u)} />
  <div class="cu-grid">
    {#each sections as s (s.title)}
      <section class="cu-section" aria-label={s.title}>
        <h4>{s.title}</h4>
        {#each s.bars as b (b.name)}
          <div class="cu-bar" data-bar={b.name}>
            <span class="cu-bar-name mono" title={b.name}>{b.name}</span>
            <span class="cu-bar-track"><span class="cu-bar-fill" style:width="{b.pct}%" style:background={s.color(b.name)}></span></span>
            <span class="mono muted cu-bar-v">{b.text}</span>
          </div>
        {:else}
          <div class="muted small">none</div>
        {/each}
      </section>
    {/each}
    <section class="cu-section" aria-label="Biggest">
      <h4>Biggest</h4>
      {#each u.biggest.slice(0, 14) as b (b.id)}
        <button type="button" class="cu-item" onclick={() => onopen(b.id)}>
          <KindIcon id={b.id} /><span class="mono grow">{b.id}</span><span class="mono muted">{fmtBytes(b.bytes)}</span>
        </button>
      {/each}
    </section>
  </div>
  <div class="muted small">Select assets in the browser (☐ Select) and "Plan cleanup…" to retire them; superseded and orphan assets carry badges.</div>
{/if}
