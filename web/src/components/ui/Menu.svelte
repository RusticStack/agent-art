<!-- Dropdown menu (Bits UI DropdownMenu) behind a button: icon + optional text; items from menu.ts. -->
<script lang="ts">
  import { DropdownMenu } from 'bits-ui';
  import type { IconName } from '@/lib/util/icons';
  import Icon from './Icon.svelte';
  import MenuItems from './MenuItems.svelte';
  import type { MenuItem } from './menu';

  let { items, label, icon = 'ellipsis', text, align = 'end' }: {
    items: readonly MenuItem[];
    /** accessible name of the trigger */
    label: string;
    icon?: IconName;
    text?: string;
    align?: 'start' | 'center' | 'end';
  } = $props();
</script>

<DropdownMenu.Root>
  <DropdownMenu.Trigger class="btn {text ? '' : 'icon'}" aria-label={label}>
    <Icon name={icon} />{#if text}<span>{text}</span>{/if}
  </DropdownMenu.Trigger>
  <DropdownMenu.Portal>
    <DropdownMenu.Content class="menu" {align} sideOffset={4}>
      <MenuItems {items} />
    </DropdownMenu.Content>
  </DropdownMenu.Portal>
</DropdownMenu.Root>
