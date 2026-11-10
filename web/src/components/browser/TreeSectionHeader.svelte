<!--
  Section header (B4): twisty + title + count. In the list it is a level-1 treeitem (`.section[data-key]`);
  as the pinned overlay above the list (`overlay`) it is a mouse-only copy, hidden from assistive tech.
-->
<script lang="ts">
  import Icon from '@/components/ui/Icon.svelte';
  import type { TreeSection } from './tree';

  let { section, focused = false, overlay = false, height = 28, ontoggle, onkey }: {
    section: TreeSection;
    focused?: boolean;
    overlay?: boolean;
    height?: number;
    ontoggle: (s: TreeSection) => void;
    onkey?: (s: TreeSection, e: KeyboardEvent) => void;
  } = $props();
</script>

{#snippet body()}
  <span class="twisty"><Icon name="chevron-right" size={12} class={section.collapsed ? '' : 'open'} /></span>
  <span class="title">{section.title}</span>
  <span class="count">{section.count}</span>
{/snippet}

{#if overlay}
  <button type="button" class="sec section-overlay" tabindex="-1" aria-hidden="true" style:height="{height}px" onclick={() => ontoggle(section)}>
    {@render body()}
  </button>
{:else}
  <div
    class="sec section"
    role="treeitem"
    aria-level={section.level}
    aria-setsize={section.setsize}
    aria-posinset={section.posinset}
    aria-expanded={!section.collapsed}
    aria-selected={false}
    aria-label="{section.title} ({section.count})"
    tabindex={focused ? 0 : -1}
    data-act="section"
    data-key={section.section}
    data-row-key={section.key}
    style:height="{height}px"
    onclick={() => ontoggle(section)}
    onkeydown={(e) => onkey?.(section, e)}
  >{@render body()}</div>
{/if}

<style>
  .sec {
    display: flex; align-items: center; gap: var(--s-3); width: 100%; box-sizing: border-box; padding: 0 var(--s-5);
    font: inherit; font-size: var(--fs-1); font-weight: 700; letter-spacing: .08em; text-transform: uppercase; color: var(--muted);
    cursor: pointer; user-select: none; background: var(--panel); border: 0; text-align: left;
    position: static; margin: 0;
  }
  .sec:hover { color: var(--text2); }
  .section:focus-visible { outline: 2px solid var(--focus); outline-offset: -2px; }
  .section-overlay { position: absolute; top: 0; left: 0; right: 0; z-index: var(--z-sticky); border-bottom: 1px solid var(--line); border-radius: 0; }
  .twisty { width: 12px; flex: none; display: inline-flex; justify-content: center; }
  .twisty :global(.icon) { transition: transform var(--t-fast); }
  .twisty :global(.icon.open) { transform: rotate(90deg); }
  .title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .count { margin-left: auto; font-weight: 400; color: var(--dim); font-variant-numeric: tabular-nums; }
  @media (prefers-reduced-motion: reduce) { .twisty :global(.icon) { transition: none; } }
</style>
