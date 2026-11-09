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
  :global(.menu) { z-index: var(--z-tooltip); min-width: 180px; padding: var(--s-2); background: var(--panel); border: 1px solid var(--line2); border-radius: var(--r-4); box-shadow: var(--shadow-1); }
  :global(.menu-item) { display: flex; align-items: center; gap: var(--s-4); height: var(--h-row); padding: 0 var(--s-4); border-radius: var(--r-2); cursor: pointer; outline: none; }
  :global(.menu-item[data-highlighted]) { background: var(--panel2); }
  :global(.menu-item[data-disabled]) { opacity: .45; cursor: default; }
  :global(.menu-item.danger) { color: var(--red-fg); }
  :global(.menu-sep) { height: 1px; margin: var(--s-2) 0; background: var(--line); }
  .menu-icon { display: inline-flex; width: 16px; color: var(--muted); }
  .menu-label { flex: 1; white-space: nowrap; }
</style>
