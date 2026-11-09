<!--
  Virtualised list: a thin wrapper over virtua's VList, the only file that imports virtua. Rows are
  measured (they may differ in height; `rowHeight` is the estimate for unmeasured ones) and must not
  have vertical margins. `shift` keeps the reading position when items are added at the start.
  `scrollToIndex` hands the caller a function that scrolls a row into view.
-->
<script module lang="ts">
  export type ScrollAlign = 'start' | 'center' | 'end' | 'nearest';
  export type ScrollToIndexFn = (index: number, align?: ScrollAlign) => void;
</script>

<script lang="ts" generics="T">
  import type { Snippet } from 'svelte';
  import { VList } from 'virtua/svelte';

  let {
    items, key, row, rowHeight, shift = false, overscan, class: cls, role, label, scrollToIndex, onscroll,
  }: {
    items: readonly T[];
    key: (item: T) => string;
    row: Snippet<[T, number]>;
    /** estimated row height in px (rows are measured) */
    rowHeight?: number;
    /** keep the reading position when items are prepended (timeline) */
    shift?: boolean;
    /** extra rows rendered above and below the viewport */
    overscan?: number;
    class?: string;
    role?: string;
    label?: string;
    /** receives the scroll-to-row function once mounted */
    scrollToIndex?: (fn: ScrollToIndexFn) => void;
    onscroll?: (offset: number) => void;
  } = $props();

  let list: { scrollToIndex(index: number, opts?: { align?: ScrollAlign }): void } | undefined = $state();
  const bufferSize = $derived(overscan === undefined ? undefined : overscan * (rowHeight ?? 28));

  $effect(() => {
    if (!list || !scrollToIndex) return;
    const l = list;
    scrollToIndex((index, align) => l.scrollToIndex(index, { align }));
  });
</script>

<VList
  bind:this={list}
  data={items}
  getKey={(item: T) => key(item)}
  itemSize={rowHeight}
  {bufferSize}
  {shift}
  {onscroll}
  class={cls}
  {role}
  aria-label={label}
>
  {#snippet children(item: T, index: number)}{@render row(item, index)}{/snippet}
</VList>
