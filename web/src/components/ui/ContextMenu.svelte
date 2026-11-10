<!--
  One context menu for a whole list: right-click, or Shift+F10 / the Menu key when the caller dispatches
  a `contextmenu` event on the focused element. `items` may be a function of the element the menu was
  opened on (resolve the row with target.closest(...)); when it returns null or [] the browser's own
  menu is left alone.
  Hand-written (plan 8: "replace that one wrapper with a small hand-written version"): the Bits
  ContextMenu brought floating-ui and its menu machinery into the initial chunk, because the asset
  browser mounts at boot. The open menu (keys, focus, closing) is ui/PopupMenu, shared with the top
  bar's overflow menu; closing returns focus to the element the menu was opened on.
-->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import PopupMenu from './PopupMenu.svelte';
  import type { MenuItem } from './menu';

  let { items, children }: {
    items: readonly MenuItem[] | ((target: Element) => readonly MenuItem[] | null);
    children: Snippet;
  } = $props();

  let current = $state.raw<readonly MenuItem[]>([]);
  let open = $state(false);
  let at = $state({ x: 0, y: 0 });
  let returnTo: HTMLElement | null = null;

  function resolve(target: EventTarget | null): readonly MenuItem[] {
    if (typeof items !== 'function') return items;
    return target instanceof Element ? items(target) ?? [] : [];
  }

  function oncontextmenu(e: MouseEvent): void {
    const list = resolve(e.target);
    if (!list.length) return; // the native menu
    e.preventDefault();
    const t = e.target instanceof Element ? e.target : null;
    returnTo = (t?.closest<HTMLElement>('[tabindex], button, a[href], input, select, textarea') ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null));
    current = list;
    at = { x: e.clientX, y: e.clientY };
    open = true;
  }

  function close(restore: boolean): void {
    if (!open) return;
    open = false;
    if (restore && returnTo?.isConnected) returnTo.focus();
    returnTo = null;
  }
</script>

<!-- a display: contents wrapper; keyboard users open the menu on the focused row (Shift+F10 / Menu key) -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="ctx-area" {oncontextmenu}>{@render children()}</div>

{#if open}
  <!-- a new menu for every open (a right-click elsewhere closes and reopens in the same tick) -->
  {#key at}<PopupMenu items={current} {at} onclose={close} />{/key}
{/if}

<style>
  .ctx-area { display: contents; }
</style>
