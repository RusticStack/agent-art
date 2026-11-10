<!-- Stat tiles of the cleanup dialogs (4.3 "Stat tile"): value over a muted label, tones bad / good. -->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { StatTile } from './cleanup';

  let { tiles, children }: { tiles: readonly StatTile[]; children?: Snippet } = $props();
</script>

<div class="cu-stats">
  {#each tiles as t (t.label)}
    <div class={['cu-stat', t.tone]} data-tile={t.label}><div class="cu-stat-v">{t.value}</div><div class="cu-stat-l">{t.label}</div></div>
  {/each}
  {@render children?.()}
</div>
