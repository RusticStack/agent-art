<!--
  Tooltip: label + optional <kbd> shortcut, 500 ms delay (4.2). Hand-written rather than Bits UI Tooltip
  (plan 8, "replace that one wrapper with a small hand-written version"): Bits Tooltip brings
  floating-ui, which put about 25 kB into the initial chunk for one hover hint. The trigger snippet gets
  the props to spread on its element (never combine with a native title on the same element). The
  bubble is moved to <body> while it shows, positioned below the trigger (above when there is no room),
  clamped to the viewport; Esc, pointer down, blur and leave hide it.
-->
<script lang="ts" module>
  let seq = 0;
</script>

<script lang="ts">
  import type { Snippet } from 'svelte';
  import Kbd from './Kbd.svelte';

  let { label, shortcut, disabled = false, trigger }: {
    label: string;
    shortcut?: string;
    disabled?: boolean;
    trigger: Snippet<[Record<string, unknown>]>;
  } = $props();

  const id = `tip-${++seq}`;
  const DELAY = 500;
  const GAP = 6;
  let open = $state(false);
  let anchor: HTMLElement | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  function clear(): void { if (timer) clearTimeout(timer); timer = null; }
  function show(e: Event): void {
    if (disabled || !label) return;
    anchor = e.currentTarget instanceof HTMLElement ? e.currentTarget : null;
    clear();
    timer = setTimeout(() => { timer = null; if (anchor?.isConnected) open = true; }, DELAY);
  }
  function hide(): void { clear(); open = false; }
  function safeMatches(el: Element, sel: string): boolean { try { return el.matches(sel); } catch { return true; } }
  function onkeydown(e: KeyboardEvent): void { if (e.key === 'Escape' && open) hide(); }

  $effect(() => () => clear());
  $effect(() => { if (disabled) hide(); });

  /** Move the bubble to <body> and place it next to the anchor. */
  function place(node: HTMLElement) {
    document.body.appendChild(node);
    const a = anchor?.getBoundingClientRect();
    if (a) {
      const b = node.getBoundingClientRect();
      const vw = document.documentElement.clientWidth, vh = document.documentElement.clientHeight;
      let top = a.bottom + GAP;
      if (top + b.height > vh - 4 && a.top - GAP - b.height >= 4) top = a.top - GAP - b.height;
      const left = Math.min(Math.max(4, a.left + a.width / 2 - b.width / 2), Math.max(4, vw - b.width - 4));
      node.style.left = `${Math.round(left)}px`;
      node.style.top = `${Math.round(top)}px`;
    }
    return { destroy() { node.remove(); } };
  }

  const tprops = $derived({
    'aria-describedby': open ? id : undefined,
    onpointerenter: show,
    onpointerleave: hide,
    onpointerdown: hide,
    // keyboard focus only (a click focuses too; Bits did the same check)
    onfocus: (e: FocusEvent) => { const t = e.currentTarget; if (t instanceof HTMLElement && safeMatches(t, ':focus-visible')) show(e); },
    onblur: hide,
    onkeydown,
  });
</script>

{@render trigger(tprops)}
{#if open}
  <div {id} role="tooltip" class="tooltip" style="position: fixed; left: 0; top: 0" use:place>
    <span>{label}</span>{#if shortcut}<Kbd keys={shortcut} />{/if}
  </div>
{/if}
