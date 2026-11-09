<!--
  One context menu for a whole list (Bits UI ContextMenu): right-click, Shift+F10 / the Menu key on a
  focused element, or a touch long-press inside the wrapped content. `items` may be a function of the
  element the menu was opened on (resolve the row with target.closest('[data-row-id]')); when it
  returns null or [] the browser's own menu is left alone.
-->
<script lang="ts">
  import { ContextMenu } from 'bits-ui';
  import type { Snippet } from 'svelte';
  import MenuItems from './MenuItems.svelte';
  import type { MenuItem } from './menu';

  let { items, children }: {
    items: readonly MenuItem[] | ((target: Element) => readonly MenuItem[] | null);
    children: Snippet;
  } = $props();

  let current = $state.raw<readonly MenuItem[]>([]);
  let open = $state(false);

  const resolve = (target: EventTarget | null): readonly MenuItem[] => {
    if (typeof items !== 'function') return items;
    return target instanceof Element ? items(target) ?? [] : [];
  };
  type Handler = (e: Event) => void;
  const call = (props: Record<string, unknown>, name: string, e: Event) => {
    const fn = props[name];
    if (typeof fn === 'function') (fn as Handler)(e);
  };
</script>

<ContextMenu.Root bind:open>
  <ContextMenu.Trigger>
    {#snippet child({ props })}
      <div
        {...props}
        class="ctx-area"
        oncontextmenu={(e) => { current = resolve(e.target); if (current.length) call(props, 'oncontextmenu', e); }}
        onpointerdown={(e) => { current = resolve(e.target); if (current.length) call(props, 'onpointerdown', e); }}
      >{@render children()}</div>
    {/snippet}
  </ContextMenu.Trigger>
  <ContextMenu.Portal>
    <ContextMenu.Content class="menu">
      <MenuItems items={current} />
    </ContextMenu.Content>
  </ContextMenu.Portal>
</ContextMenu.Root>

<style>
  .ctx-area { display: contents; }
</style>
