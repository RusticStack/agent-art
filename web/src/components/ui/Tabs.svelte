<!--
  Flat tab strip (role=tablist). Roving tabindex; Left / Right move and select (wrapping), Home / End
  jump. Panels are the caller's: give the panel aria-labelledby={tabId(id)} via the exported helper.
-->
<script module lang="ts">
  export interface TabItem { id: string; label: string; shortcut?: string }
</script>

<script lang="ts">
  import { tick } from 'svelte';

  let { tabs, value, onchange, label, idPrefix }: {
    tabs: readonly TabItem[];
    value: string;
    onchange: (id: string) => void;
    /** accessible name of the tablist */
    label: string;
    /** prefix for the tab element ids (default: a unique one) */
    idPrefix?: string;
  } = $props();
  const uid = $props.id();
  const prefix = $derived(idPrefix ?? uid);
  let list: HTMLElement | undefined = $state();

  const selectedIndex = $derived(Math.max(0, tabs.findIndex((t) => t.id === value)));

  async function move(i: number) {
    const n = tabs.length;
    if (!n) return;
    const t = tabs[((i % n) + n) % n];
    if (t.id !== value) onchange(t.id);
    await tick();
    list?.querySelector<HTMLElement>(`[data-tab="${CSS.escape(t.id)}"]`)?.focus();
  }
  function onkeydown(e: KeyboardEvent) {
    const i = tabs.findIndex((t) => t.id === (e.target as HTMLElement).dataset.tab);
    if (i < 0) return;
    let next: number | null = null;
    if (e.key === 'ArrowRight') next = i + 1;
    else if (e.key === 'ArrowLeft') next = i - 1;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = tabs.length - 1;
    if (next === null) return;
    e.preventDefault();
    e.stopPropagation();
    void move(next);
  }
</script>

<div class="tabs" role="tablist" aria-label={label} tabindex="-1" bind:this={list} {onkeydown}>
  {#each tabs as t, i (t.id)}
    <button
      type="button"
      role="tab"
      class={['tab', i === selectedIndex && 'on']}
      id="{prefix}-tab-{t.id}"
      data-tab={t.id}
      aria-selected={i === selectedIndex}
      tabindex={i === selectedIndex ? 0 : -1}
      title={t.shortcut ? `${t.label} (${t.shortcut})` : undefined}
      onclick={() => { if (t.id !== value) onchange(t.id); }}
    >{t.label}</button>
  {/each}
</div>
