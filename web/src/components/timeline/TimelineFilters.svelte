<!--
  TL2: search (debounced 80 ms, not persisted), tool select, Errors / This asset / Agent chips
  (persisted as agent-art:tlFilter through activity.setFilter).
-->
<script lang="ts">
  import { onDestroy } from 'svelte';
  import Chip from '@/components/ui/Chip.svelte';
  import Select from '@/components/ui/Select.svelte';
  import { activity, type TimelineFilter } from '@/state/activity.svelte';
  import { debounce } from '@/lib/util/format';

  let { tools }: { tools: readonly string[] } = $props();

  let q = $state(activity.search);
  const push = debounce((v: string) => { activity.search = v; }, 80);
  onDestroy(() => push.flush());

  const options = $derived([{ value: '', label: 'all tools' }, ...tools.map((t) => ({ value: t, label: t }))]);
  type Flag = Exclude<keyof TimelineFilter, 'tool'>;
  const CHIPS: { key: Flag; text: string; title: string }[] = [
    { key: 'errors', text: 'Errors', title: 'Only failed calls' },
    { key: 'current', text: 'This asset', title: 'Only entries touching the open asset' },
    { key: 'agent', text: 'Agent', title: 'Only the agent (hide your own edits)' },
  ];
  function toggle(k: Flag): void {
    const patch: Partial<TimelineFilter> = {};
    patch[k] = !activity.filter[k];
    activity.setFilter(patch);
  }
</script>

<div class="tl-filters">
  <input class="search" type="search" placeholder="Search activity" aria-label="Search activity" bind:value={q} oninput={() => push(q)} />
  <Select value={activity.filter.tool} {options} label="Filter by tool" title="Filter by tool" onchange={(v) => activity.setFilter({ tool: v })} />
  {#each CHIPS as c (c.key)}
    <Chip active={activity.filter[c.key]} title={c.title} onclick={() => toggle(c.key)}>{c.text}</Chip>
  {/each}
</div>

<style>
  .tl-filters { display: flex; gap: 4px; padding: 6px 8px; border-bottom: 1px solid var(--line); flex-wrap: wrap; align-items: center; }
  .tl-filters .search { flex: 1 1 120px; width: auto; min-width: 0; }
  .tl-filters :global(select) { max-width: 130px; }
</style>
