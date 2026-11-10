<!--
  The open menu itself (WAI-ARIA menu pattern), shared by ContextMenu (at the pointer) and the top bar's
  OverflowMenu (under its button). Mounted open: focus moves to the first enabled item; Up / Down wrap,
  Home / End, Enter / Space run the item, a letter jumps to the next item starting with it, Esc and Tab
  close. A pointer down outside (except on `ignore`, the trigger), scroll, resize and window blur close
  it. `onclose(restore)`: restore = put focus back on the opener (Esc, Enter, a click on an item);
  false for a pointer down elsewhere, Tab or the page losing focus. Rendered at the end of <body>.
  Items with `checked` are menuitemcheckbox / menuitemradio (aria-checked, a square / circle mark).
-->
<script lang="ts">
  import { tick } from 'svelte';
  import Icon from './Icon.svelte';
  import Kbd from './Kbd.svelte';
  import { isSeparator, itemRole, type MenuAction, type MenuItem } from './menu';

  let { items, at, anchor = null, ignore = null, label, id, onclose }: {
    items: readonly MenuItem[];
    /** open at this point (context menu) ... */
    at?: { x: number; y: number };
    /** ... or below this element, right-aligned with it (dropdown) */
    anchor?: HTMLElement | null;
    /** a pointer down on this element does not count as outside (the trigger toggles the menu itself) */
    ignore?: HTMLElement | null;
    label?: string;
    id?: string;
    onclose: (restore: boolean) => void;
  } = $props();

  let active = $state(-1);
  let menuEl: HTMLElement | undefined = $state();
  let closed = false;

  const actions = $derived(items.map((m, i) => ({ m, i })).filter((x): x is { m: MenuAction; i: number } => !isSeparator(x.m) && !x.m.disabled));

  function close(restore: boolean): void {
    if (closed) return;
    closed = true;
    onclose(restore);
  }

  function place(): void {
    if (!menuEl) return;
    const r = menuEl.getBoundingClientRect();
    const vw = document.documentElement.clientWidth, vh = document.documentElement.clientHeight;
    let x: number, y: number;
    if (anchor) {
      const a = anchor.getBoundingClientRect();
      x = Math.min(Math.max(4, a.right - r.width), Math.max(4, vw - 4 - r.width));
      y = a.bottom + 4;
      if (y + r.height > vh - 4 && a.top - 4 - r.height >= 4) y = a.top - 4 - r.height;
    } else {
      const p = at ?? { x: 0, y: 0 };
      x = p.x + r.width > vw - 4 ? Math.max(4, p.x - r.width) : p.x;
      y = p.y + r.height > vh - 4 ? Math.max(4, vh - 4 - r.height) : p.y;
    }
    menuEl.style.left = `${Math.round(x)}px`;
    menuEl.style.top = `${Math.round(y)}px`;
  }

  function focusAt(i: number): void {
    active = i;
    if (i < 0) { menuEl?.focus(); return; }
    menuEl?.querySelector<HTMLElement>(`[data-index="${i}"]`)?.focus();
  }

  function run(m: MenuAction): void {
    close(true);
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
    else if (k === 'Escape') close(true);
    else if (k === 'Tab') { close(false); return; }
    else if (k === 'Enter' || k === ' ') {
      const m = items[active];
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
    void tick().then(() => { if (!closed) { place(); focusAt(actions[0]?.i ?? -1); } });
    const outside = (e: Event) => {
      const t = e.target;
      if (t instanceof Node && (menuEl?.contains(t) || ignore?.contains(t))) return;
      close(e.type !== 'pointerdown');
    };
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

  /** Render the menu at the end of <body>, above everything (no clipping by a list's overflow). */
  function portal(node: HTMLElement) {
    document.body.appendChild(node);
    return { destroy() { node.remove(); } };
  }
</script>

<div
  bind:this={menuEl}
  use:portal
  {id}
  class="menu ctx-menu"
  role="menu"
  tabindex="-1"
  aria-label={label}
  aria-orientation="vertical"
  style="position: fixed; left: 0; top: 0"
  {onkeydown}
  oncontextmenu={(e) => e.preventDefault()}
>
  {#each items as m, i (m.id)}
    {#if isSeparator(m)}
      <div class="menu-sep" role="separator"></div>
    {:else}
      <!-- keys are handled by the role=menu container (roving focus), clicks by the item -->
      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <div
        class={['menu-item', m.danger && 'danger']}
        role={itemRole(m)}
        aria-checked={m.checked === undefined ? undefined : m.checked}
        tabindex="-1"
        data-index={i}
        data-id={m.id}
        data-highlighted={active === i ? '' : undefined}
        data-disabled={m.disabled ? '' : undefined}
        aria-disabled={m.disabled ? 'true' : undefined}
        onpointermove={() => { if (!m.disabled && active !== i) focusAt(i); }}
        onclick={() => { if (!m.disabled) run(m); }}
      >
        <span class="menu-icon">
          {#if m.checked !== undefined}<Icon name={m.radio ? (m.checked ? 'circle-dot' : 'circle') : m.checked ? 'square-check' : 'square'} />{:else if m.icon}<Icon name={m.icon} />{/if}
        </span>
        <span class="menu-label">{m.label}</span>
        {#if m.badge}<span class="count-badge">{m.badge}</span>{/if}
        {#if m.shortcut}<Kbd keys={m.shortcut} />{/if}
      </div>
    {/if}
  {/each}
</div>

<style>
  .ctx-menu { outline: none; }
  .menu-icon { display: inline-flex; width: 16px; color: var(--muted); }
  .menu-label { flex: 1; white-space: nowrap; }
</style>
