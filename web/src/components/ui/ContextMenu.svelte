<!--
  One context menu for a whole list: right-click, or Shift+F10 / the Menu key when the caller dispatches
  a `contextmenu` event on the focused element. `items` may be a function of the element the menu was
  opened on (resolve the row with target.closest(...)); when it returns null or [] the browser's own
  menu is left alone.
  Hand-written (plan 8: "replace that one wrapper with a small hand-written version"): the Bits
  ContextMenu brought floating-ui and its menu machinery into the initial chunk, because the asset
  browser mounts at boot. WAI-ARIA menu pattern: focus moves to the first enabled item, Up / Down wrap,
  Home / End, Enter / Space run the item, a letter jumps to the next item starting with it, Esc and
  Tab close; closing returns focus to the element the menu was opened on. Click outside, scroll,
  resize and blur close it too.
-->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import { tick } from 'svelte';
  import Icon from './Icon.svelte';
  import Kbd from './Kbd.svelte';
  import { isSeparator, type MenuAction, type MenuItem } from './menu';

  let { items, children }: {
    items: readonly MenuItem[] | ((target: Element) => readonly MenuItem[] | null);
    children: Snippet;
  } = $props();

  let current = $state.raw<readonly MenuItem[]>([]);
  let open = $state(false);
  let at = $state({ x: 0, y: 0 });
  let active = $state(-1);
  let menuEl: HTMLElement | undefined = $state();
  let returnTo: HTMLElement | null = null;

  const actions = $derived(current.map((m, i) => ({ m, i })).filter((x): x is { m: MenuAction; i: number } => !isSeparator(x.m) && !x.m.disabled));

  function resolve(target: EventTarget | null): readonly MenuItem[] {
    if (typeof items !== 'function') return items;
    return target instanceof Element ? items(target) ?? [] : [];
  }

  async function oncontextmenu(e: MouseEvent): Promise<void> {
    const list = resolve(e.target);
    if (!list.length) return; // the native menu
    e.preventDefault();
    const t = e.target instanceof Element ? e.target : null;
    returnTo = (t?.closest<HTMLElement>('[tabindex], button, a[href], input, select, textarea') ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null));
    current = list;
    at = { x: e.clientX, y: e.clientY };
    open = true;
    await tick();
    place();
    focusAt(actions[0]?.i ?? -1);
  }

  function place(): void {
    if (!menuEl) return;
    const r = menuEl.getBoundingClientRect();
    const vw = document.documentElement.clientWidth, vh = document.documentElement.clientHeight;
    const x = at.x + r.width > vw - 4 ? Math.max(4, at.x - r.width) : at.x;
    const y = at.y + r.height > vh - 4 ? Math.max(4, vh - 4 - r.height) : at.y;
    menuEl.style.left = `${Math.round(x)}px`;
    menuEl.style.top = `${Math.round(y)}px`;
  }

  function focusAt(i: number): void {
    active = i;
    if (i < 0) { menuEl?.focus(); return; }
    menuEl?.querySelector<HTMLElement>(`[data-index="${i}"]`)?.focus();
  }

  function close(restore = true): void {
    if (!open) return;
    open = false;
    active = -1;
    if (restore && returnTo?.isConnected) returnTo.focus();
    returnTo = null;
  }

  function run(m: MenuAction): void {
    close();
    m.onselect();
  }

  function step(delta: number): void {
    const list = actions;
    if (!list.length) return;
    const k = list.findIndex((x) => x.i === active);
    const n = k < 0 ? (delta > 0 ? 0 : list.length - 1) : (k + delta + list.length) % list.length;
    focusAt(list[n].i);
  }

  function onkeydown(e: KeyboardEvent): void {
    const k = e.key;
    if (k === 'ArrowDown') step(1);
    else if (k === 'ArrowUp') step(-1);
    else if (k === 'Home') focusAt(actions[0]?.i ?? -1);
    else if (k === 'End') focusAt(actions[actions.length - 1]?.i ?? -1);
    else if (k === 'Escape') close();
    else if (k === 'Tab') { close(); return; }
    else if (k === 'Enter' || k === ' ') {
      const m = current[active];
      if (m && !isSeparator(m) && !m.disabled) run(m);
    } else if (k.length === 1 && /\S/.test(k)) {
      const list = actions;
      const from = list.findIndex((x) => x.i === active);
      for (let s = 1; s <= list.length; s++) {
        const x = list[(from + s) % list.length];
        if (x.m.label.toLowerCase().startsWith(k.toLowerCase())) { focusAt(x.i); break; }
      }
    } else return;
    // the menu owns these keys (no global shortcut, no tree navigation behind it)
    e.preventDefault();
    e.stopPropagation();
  }

  $effect(() => {
    if (!open) return;
    const outside = (e: Event) => { if (!(e.target instanceof Node) || !menuEl?.contains(e.target)) close(e.type !== 'pointerdown'); };
    const away = () => close(false);
    document.addEventListener('pointerdown', outside, true);
    window.addEventListener('resize', away);
    window.addEventListener('blur', away);
    document.addEventListener('scroll', away, true);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('resize', away);
      window.removeEventListener('blur', away);
      document.removeEventListener('scroll', away, true);
    };
  });

  /** Render the menu at the end of <body>, above everything (no clipping by the list's overflow). */
  function portal(node: HTMLElement) {
    document.body.appendChild(node);
    return { destroy() { node.remove(); } };
  }
</script>

<!-- a display: contents wrapper; keyboard users open the menu on the focused row (Shift+F10 / Menu key) -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="ctx-area" {oncontextmenu}>{@render children()}</div>

{#if open}
  <div
    bind:this={menuEl}
    use:portal
    class="menu ctx-menu"
    role="menu"
    tabindex="-1"
    aria-orientation="vertical"
    style="position: fixed; left: 0; top: 0"
    {onkeydown}
    oncontextmenu={(e) => e.preventDefault()}
  >
    {#each current as m, i (m.id)}
      {#if isSeparator(m)}
        <div class="menu-sep" role="separator"></div>
      {:else}
        <!-- keys are handled by the role=menu container (roving focus), clicks by the item -->
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <div
          class={['menu-item', m.danger && 'danger']}
          role="menuitem"
          tabindex="-1"
          data-index={i}
          data-highlighted={active === i ? '' : undefined}
          data-disabled={m.disabled ? '' : undefined}
          aria-disabled={m.disabled ? 'true' : undefined}
          onpointermove={() => { if (!m.disabled && active !== i) focusAt(i); }}
          onclick={() => { if (!m.disabled) run(m); }}
        >
          <span class="menu-icon">{#if m.icon}<Icon name={m.icon} />{/if}</span>
          <span class="menu-label">{m.label}</span>
          {#if m.shortcut}<Kbd keys={m.shortcut} />{/if}
        </div>
      {/if}
    {/each}
  </div>
{/if}

<style>
  .ctx-area { display: contents; }
  .ctx-menu { outline: none; }
  .menu-icon { display: inline-flex; width: 16px; color: var(--muted); }
  .menu-label { flex: 1; white-space: nowrap; }
</style>
