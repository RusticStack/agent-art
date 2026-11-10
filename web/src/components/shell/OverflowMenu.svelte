<!--
  The narrow top bar's overflow menu (4.5, step 19): Search (command palette), Compare, Review, Notes
  (with the open count), Graph, Cleanup, Help, then what follow mode opens. It replaces the horizontal
  scrolling of the legacy narrow bar. A menu button (aria-haspopup / aria-expanded) over ui/PopupMenu;
  the open count also shows on the button so it is not hidden behind the menu. Opening the menu warms up
  the palette chunk.
-->
<script lang="ts">
  import { dialogs } from '@/state/dialogs.svelte';
  import { editor } from '@/state/editor.svelte';
  import { reviews } from '@/state/reviews.svelte';
  import { workspace } from '@/state/workspace.svelte';
  import type { FollowMode } from '@/lib/util/storage';
  import { loadPalette } from '../dialogs/loadPalette';
  import Icon from '../ui/Icon.svelte';
  import PopupMenu from '../ui/PopupMenu.svelte';
  import type { MenuItem } from '../ui/menu';

  const uid = $props.id();
  let open = $state(false);
  let btn: HTMLButtonElement | undefined = $state();
  const count = $derived(reviews.openCount);

  const FOLLOW: { mode: FollowMode; label: string }[] = [
    { mode: 'canvas', label: 'Follow opens: asset' },
    { mode: 'project', label: 'Follow opens: project overview' },
    { mode: 'off', label: 'Follow opens: off' },
  ];

  const items = $derived<MenuItem[]>([
    { id: 'search', label: 'Search assets and actions', icon: 'search', shortcut: 'Ctrl+K', onselect: () => dialogs.openPalette() },
    { id: 'compare', label: 'Compare', shortcut: 'C', checked: workspace.comparing, onselect: () => workspace.setCompare(!workspace.comparing) },
    { id: 'review', label: 'Review mode', shortcut: 'M', checked: editor.reviewMode, onselect: () => editor.setReviewMode(!editor.reviewMode) },
    { id: 'notes', label: 'Notes', icon: 'message-square', badge: count || '', onselect: () => dialogs.openReviewList() },
    { id: 'graph', label: 'Graph', icon: 'waypoints', shortcut: 'Shift+G', onselect: () => workspace.open({ kind: 'graph' }) },
    { id: 'cleanup', label: 'Cleanup', icon: 'trash-2', onselect: () => dialogs.openCleanup() },
    { id: 'help', label: 'Keyboard shortcuts', icon: 'circle-help', shortcut: '?', onselect: () => dialogs.toggleHelp() },
    { separator: true, id: 'sep-follow' },
    ...FOLLOW.map((f) => ({ id: `follow-${f.mode}`, label: f.label, radio: true, checked: workspace.followMode === f.mode, onselect: () => workspace.setFollowMode(f.mode) })),
  ]);

  function toggle(): void {
    open = !open;
    if (open) void loadPalette().catch(() => {});
  }
  function close(restore: boolean): void {
    open = false;
    if (restore) btn?.focus();
  }
  function onkeydown(e: KeyboardEvent): void {
    // the menu button pattern: Down / Up open the menu as well
    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && !open) { e.preventDefault(); toggle(); }
  }
</script>

<!-- the name comes from the content (an aria-label without the visible count fails axe label-content-name-mismatch) -->
<button bind:this={btn} type="button" class="btn icon more" id="moreBtn" title="More actions"
  aria-haspopup="menu" aria-expanded={open} aria-controls={open ? `${uid}-menu` : undefined} onclick={toggle} {onkeydown}>
  <Icon name="ellipsis" /><span class="sr-only">{'More actions '}</span>{#if count}<span class="count-badge">{count}<span class="sr-only">{' open notes'}</span></span>{/if}
</button>
{#if open}
  <PopupMenu {items} anchor={btn} ignore={btn} id="{uid}-menu" label="More actions" onclose={close} />
{/if}

<style>
  .more { position: relative; }
  .more .count-badge { position: absolute; top: -4px; right: -4px; font-size: 10px; line-height: 14px; padding: 0 4px; }
</style>
