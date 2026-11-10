<!--
  One asset tree row (B5-B7): checkbox (select mode), twisty, thumbnail or kind icon, name + meta,
  badges, hover actions. Solo / pin / hide call the uiState store; everything else goes through the
  callbacks (the browser owns selection, expansion, opening and keyboard navigation).
  A div[role=treeitem], not a button: it holds the action buttons.
-->
<script lang="ts">
  import Badge from '@/components/ui/Badge.svelte';
  import Icon from '@/components/ui/Icon.svelte';
  import { KIND_ICON_NAME } from '@/lib/util/kinds';
  import { uiState } from '@/state/uiState.svelte';
  import { setDragTarget } from './drag';
  import type { TreeRow } from './tree';

  let {
    row, active = false, selected = false, flash = false, focused = false, draggable = true, height = 28,
    onactivate, ontoggle, onselect, ondblopen, onkey,
  }: {
    row: TreeRow;
    /** slot A shows this asset (B18) */
    active?: boolean;
    /** checked in select mode */
    selected?: boolean;
    /** the agent just changed it (B19) */
    flash?: boolean;
    /** roving tabindex: this row is the tree's tab stop */
    focused?: boolean;
    /** drag to a viewer slot is allowed (not in select mode) */
    draggable?: boolean;
    height?: number;
    /** click on the row body (open / compare / toggle) */
    onactivate: (row: TreeRow, e: MouseEvent | KeyboardEvent) => void;
    ontoggle?: (row: TreeRow) => void;
    /** select-mode click or checkbox; range = Shift */
    onselect?: (row: TreeRow, range: boolean) => void;
    /** double-click (canvas rows open the Canvas view) */
    ondblopen?: (row: TreeRow) => void;
    onkey?: (row: TreeRow, e: KeyboardEvent) => void;
  } = $props();

  let brokenThumb = $state<string | null>(null);
  const thumb = $derived(row.thumb && row.thumb !== brokenThumb ? row.thumb : null);
  const icon = $derived(KIND_ICON_NAME[row.kind] ?? 'file');
  const canDrag = $derived(draggable && !!row.open);

  function onclick(e: MouseEvent): void {
    const act = (e.target instanceof Element ? e.target.closest('[data-act]') : null)?.getAttribute('data-act') ?? '';
    if (row.selectable && (act === 'select' || !act)) { e.preventDefault(); onselect?.(row, e.shiftKey); return; }
    if (act === 'toggle') { ontoggle?.(row); return; }
    if (act) return;
    onactivate(row, e);
  }
  function act(e: MouseEvent, which: 'solo' | 'pin' | 'eye'): void {
    e.stopPropagation();
    if (which === 'solo') uiState.toggleSolo(row.id);
    else if (which === 'pin') void uiState.togglePinned(row.id);
    else void uiState.toggleHidden(row.id);
  }
</script>

<div
  class={['row', row.hidden && 'is-hidden', active && 'active', row.selectable && selected && 'selected', flash && 'flash']}
  role="treeitem"
  aria-level={row.level}
  aria-setsize={row.setsize}
  aria-posinset={row.posinset}
  aria-expanded={row.hasKids ? row.expanded : undefined}
  aria-selected={active}
  aria-checked={row.selectable ? selected : undefined}
  tabindex={focused ? 0 : -1}
  data-id={row.id}
  data-kind={row.kind}
  data-name={row.name}
  data-section={row.section}
  data-row-key={row.key}
  data-sel={row.selectable ? '1' : undefined}
  style:padding-left="{6 + row.depth * 14}px"
  style:height="{height}px"
  draggable={canDrag}
  ondragstart={(e) => { if (canDrag && row.open) setDragTarget(e, row.open, row.name); else e.preventDefault(); }}
  {onclick}
  ondblclick={() => ondblopen?.(row)}
  onkeydown={(e) => onkey?.(row, e)}
>
  {#if row.selectable}
    <input class="selbox" type="checkbox" checked={selected} tabindex="-1" data-act="select" aria-label="Select {row.label}" />
  {/if}
  <span class="twisty" data-act={row.hasKids ? 'toggle' : undefined}>
    {#if row.hasKids}<Icon name="chevron-right" size={12} class={row.expanded ? 'open' : ''} />{/if}
  </span>
  {#if thumb}
    <img class="thumb" src={thumb} loading="lazy" alt="" onerror={() => { brokenThumb = thumb; }} />
  {:else}
    <span class="kicon" style:color="var(--k-{row.kind}, var(--k-file))"><Icon name={icon} size={14} /></span>
  {/if}
  <span class="label" title={row.meta ? `${row.label} · ${row.meta}` : row.label}>
    <span class="name">{row.label}</span>
    {#if row.meta}<span class="meta">{row.meta}</span>{/if}
  </span>
  {#if row.reviews}<Badge tone="review" title="{row.reviews} open review note(s)">{row.reviews}</Badge>{/if}
  {#if row.approved}<Badge tone="ok" title="approved">✓</Badge>{/if}
  {#if row.superseded}<Badge tone="old" title={'replaced by a newer asset (art_cleanup plan {select:{superseded:true}})'}>superseded</Badge>{/if}
  {#if row.orphan}<Badge tone="orphan" title="nothing links to it, not in a project or group, not pinned">orphan</Badge>{/if}
  {#if row.badge}<Badge>{row.badge}</Badge>{/if}
  {#if row.actions}
    <span class="acts">
      <button type="button" class={['act', row.solo && 'on']} data-act="solo" tabindex={focused ? 0 : -1}
        title={row.solo ? 'Unsolo' : 'Solo (show only this)'} aria-label={row.solo ? 'Unsolo' : 'Solo'} aria-pressed={row.solo}
        onclick={(e) => act(e, 'solo')}><Icon name="scan-eye" size={14} /></button>
      <button type="button" class={['act', 'pin', row.pinned && 'on']} data-act="pin" tabindex={focused ? 0 : -1}
        title={row.pinned ? 'Unpin' : 'Pin'} aria-label={row.pinned ? 'Unpin' : 'Pin'} aria-pressed={row.pinned}
        onclick={(e) => act(e, 'pin')}><Icon name="star" size={14} /></button>
      <button type="button" class={['act', row.hidden && 'off']} data-act="eye" tabindex={focused ? 0 : -1}
        title={row.hidden ? 'Show' : 'Hide'} aria-label={row.hidden ? 'Show' : 'Hide'}
        onclick={(e) => act(e, 'eye')}><Icon name={row.hidden ? 'eye-off' : 'eye'} size={14} /></button>
    </span>
  {/if}
</div>

<style>
  .row {
    display: flex; align-items: center; gap: 5px; padding: 0 var(--s-3) 0 6px; box-sizing: border-box; min-height: 0;
    cursor: pointer; border-left: 2px solid transparent; user-select: none; overflow: hidden;
  }
  .row:hover { background: var(--panel2); }
  .row.active { background: var(--accent-bg); border-left-color: var(--accent); }
  .row.selected { background: var(--select-bg); }
  .row.is-hidden { opacity: .4; }
  .row:focus-visible { outline: 2px solid var(--focus); outline-offset: -2px; }
  .twisty { width: 12px; flex: none; color: var(--muted); display: inline-flex; justify-content: center; }
  .twisty :global(.icon) { transition: transform var(--t-fast); }
  .twisty :global(.icon.open) { transform: rotate(90deg); }
  .thumb {
    width: 22px; height: 22px; flex: none; object-fit: contain; image-rendering: pixelated; border-radius: var(--r-1);
    background: repeating-conic-gradient(var(--checker-b) 0 25%, var(--checker-a) 0 50%) 0 0 / 8px 8px;
  }
  .kicon { width: 22px; flex: none; display: inline-flex; justify-content: center; }
  .label { min-width: 0; flex: 1; display: flex; flex-direction: column; line-height: var(--lh-tight); }
  .name, .meta { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .meta { font-size: var(--fs-1); color: var(--muted); font-variant-numeric: tabular-nums; }
  .selbox { margin: 0 2px 0 0; accent-color: var(--accent); flex: none; cursor: pointer; }
  .acts { display: none; flex: none; }
  .row:hover .acts, .row:focus .acts, .row:focus-within .acts, .acts:has(:global(.on)), .row.is-hidden .acts { display: inline-flex; }
  .act { min-width: var(--hit-min); justify-content: center; }
  .act.pin.on :global(svg) { fill: currentColor; }
  @media (prefers-reduced-motion: reduce) {
    .twisty :global(.icon) { transition: none; }
    .row.flash { animation: none; outline: 2px solid var(--accent); outline-offset: -2px; }
  }
</style>
