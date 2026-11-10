<!-- Item list shared by Menu and ContextMenu (rendered inside their Content). -->
<script lang="ts">
  import { DropdownMenu } from 'bits-ui';
  import Icon from './Icon.svelte';
  import Kbd from './Kbd.svelte';
  import { isSeparator, type MenuItem } from './menu';

  let { items }: { items: readonly MenuItem[] } = $props();
</script>

{#each items as m (m.id)}
  {#if isSeparator(m)}
    <DropdownMenu.Separator class="menu-sep" />
  {:else}
    <DropdownMenu.Item class="menu-item {m.danger ? 'danger' : ''}" disabled={m.disabled} textValue={m.label} onSelect={() => m.onselect()}>
      <span class="menu-icon">{#if m.icon}<Icon name={m.icon} />{/if}</span>
      <span class="menu-label">{m.label}</span>
      {#if m.shortcut}<Kbd keys={m.shortcut} />{/if}
    </DropdownMenu.Item>
  {/if}
{/each}

<style>
  .menu-icon { display: inline-flex; width: 16px; color: var(--muted); }
  .menu-label { flex: 1; white-space: nowrap; }
</style>
