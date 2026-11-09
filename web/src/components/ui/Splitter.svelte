<!--
  Pane splitter (role=separator). Pointer drag, arrow keys (16 px, Shift 64 px), Home / End, double-click
  resets. `value` is the current size in px of the pane it resizes; `sign` is +1 when moving the bar
  right / down grows that pane. The caller owns the size (layout store from step 18): onchange while
  resizing, oncommit when a drag or key press is done (persist), onreset on double-click.
-->
<script module lang="ts">
  export const KEY_STEP = 16;
  export const KEY_STEP_BIG = 64;
  export const clampSize = (v: number, min: number, max: number): number => Math.round(Math.max(min, Math.min(Math.max(min, max), v)));
</script>

<script lang="ts">
  let { orientation, value, sign, label, min = 140, max, sizeKey, onchange, oncommit, onreset }: {
    /** vertical = a vertical bar that resizes a width; horizontal = a horizontal bar that resizes a height */
    orientation: 'vertical' | 'horizontal';
    value: number;
    sign: 1 | -1;
    label: string;
    min?: number;
    /** default: 70 % of the window along the axis */
    max?: number;
    /** layout key this splitter drives ('browser-w' | 'side-w' | 'insp-h' | 'bottom-h'), as data-size */
    sizeKey?: string;
    onchange: (px: number) => void;
    oncommit?: (px: number) => void;
    onreset?: () => void;
  } = $props();

  const vertical = $derived(orientation === 'vertical');
  const limit = (): number => max ?? Math.round((vertical ? window.innerWidth : window.innerHeight) * 0.7);
  let dragging = $state(false);

  function onkeydown(e: KeyboardEvent) {
    const fwd = vertical ? 'ArrowRight' : 'ArrowDown';
    const back = vertical ? 'ArrowLeft' : 'ArrowUp';
    let next: number | null = null;
    const step = e.shiftKey ? KEY_STEP_BIG : KEY_STEP;
    if (e.key === fwd) next = value + sign * step;
    else if (e.key === back) next = value - sign * step;
    else if (e.key === 'Home') next = min;
    else if (e.key === 'End') next = limit();
    if (next === null) return;
    e.preventDefault();
    e.stopPropagation();
    const v = clampSize(next, min, limit());
    onchange(v);
    oncommit?.(v);
  }

  function onpointerdown(e: PointerEvent) {
    if (e.button !== 0) return;
    e.preventDefault();
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture?.(e.pointerId);
    const start = vertical ? e.clientX : e.clientY;
    const from = value;
    let last = value;
    dragging = true;
    const move = (ev: PointerEvent) => {
      last = clampSize(from + sign * ((vertical ? ev.clientX : ev.clientY) - start), min, limit());
      onchange(last);
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      dragging = false;
      oncommit?.(last);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  }
</script>

<!-- A focusable separator with a value is a widget (WAI-ARIA window splitter); Svelte's a11y check does not know that. -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
<div
  class={['splitter', 'ui-splitter', vertical ? 'v' : 'h', dragging && 'dragging']}
  role="separator"
  aria-orientation={orientation}
  aria-label={label}
  aria-valuenow={Math.round(value)}
  aria-valuemin={min}
  aria-valuemax={max ?? limit()}
  data-size={sizeKey}
  tabindex="0"
  {onkeydown}
  {onpointerdown}
  ondblclick={() => onreset?.()}
></div>

<style>
  .ui-splitter { position: relative; background: var(--line); flex: none; touch-action: none; }
  .ui-splitter.v { width: 4px; cursor: col-resize; }
  .ui-splitter.h { height: 4px; cursor: row-resize; }
  .ui-splitter::after { content: ''; position: absolute; inset: -2px; }
  .ui-splitter:hover, .ui-splitter:focus-visible, .ui-splitter.dragging { background: var(--accent); }
</style>
