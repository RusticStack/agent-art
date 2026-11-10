<!--
  Asset browser (plan 1.4 B1-B22, Review 2 RV2 / RV3, 4.4 keyboard): header buttons, new canvas form,
  filter, the tree (always virtualised; the current section header is a pinned overlay), select mode
  bar. Reads the stores directly; mounted into #browser. `focusSearch()` is exported for the `/` key.
-->
<script lang="ts">
  import { onDestroy, untrack } from 'svelte';
  import Button from '@/components/ui/Button.svelte';
  import ContextMenu from '@/components/ui/ContextMenu.svelte';
  import PaneHeader from '@/components/ui/PaneHeader.svelte';
  import VirtualList, { type ScrollToIndexFn } from '@/components/ui/VirtualList.svelte';
  import type { MenuItem } from '@/components/ui/menu';
  import { assets } from '@/state/assets.svelte';
  import { dialogs } from '@/state/dialogs.svelte';
  import { signals } from '@/state/live.svelte';
  import { reviews } from '@/state/reviews.svelte';
  import { toast } from '@/state/toasts.svelte';
  import { uiState } from '@/state/uiState.svelte';
  import { workspace } from '@/state/workspace.svelte';
  import type { ReviewDraft, SlotId, Target } from '@/viewers/types';
  import AssetRow from './AssetRow.svelte';
  import NewCanvasForm from './NewCanvasForm.svelte';
  import SelectionBar from './SelectionBar.svelte';
  import TreeSectionHeader from './TreeSectionHeader.svelte';
  import { prefs } from '@/state/prefs.svelte';
  import { buildTree, menuFor, rangeSelect, selectableIds, type MenuContext, type TreeItem, type TreeRow, type TreeSection } from './tree';

  const FLASH_MS = 900;

  let { narrow = false, onopen, reviewNote, planCleanup: planDialog }: {
    /** narrow layout: 36 px rows */
    narrow?: boolean;
    /** told after the browser opened something (the narrow shell closes the drawer) */
    onopen?: (target: Target, slot: SlotId) => void;
    /** "Add review note…" (default: dialogs.reviewNote) */
    reviewNote?: (draft: ReviewDraft) => void;
    /** "Plan cleanup…": resolves true after a successful apply (default: dialogs.planCleanup) */
    planCleanup?: (ids: string[]) => Promise<boolean>;
  } = $props();

  let filterText = $state('');
  let selectMode = $state(false);
  let selected = $state.raw<ReadonlySet<string>>(new Set());
  let lastSel: string | null = null;
  let showNew = $state(false);
  let focusKey = $state<string | null>(null);
  let flashing = $state.raw<ReadonlySet<string>>(new Set());
  let offset = $state(0);
  let searchEl: HTMLInputElement | undefined = $state();
  let wrapEl: HTMLElement | undefined = $state();
  let scrollTo: ScrollToIndexFn | null = null;
  let menuKey: string | null = null;
  let alive = true;
  onDestroy(() => { alive = false; scrollTo = null; });

  const rowHeight = $derived(narrow ? 36 : 28);
  const items = $derived<TreeItem[]>(assets.index ? buildTree({
    index: assets.index, hidden: uiState.hidden, pinned: uiState.pinned, solo: uiState.solo, showHidden: prefs.showHidden,
    filter: filterText, collapsed: prefs.collapsed, expanded: prefs.expanded, selectMode,
    reviewCounts: reviews.counts, approved: reviews.approved,
  }) : []);
  const byKey = $derived(new Map(items.map((it) => [it.key, it])));
  /** Items keyboard focus can land on (notes are skipped). */
  const nav = $derived(items.filter((it) => it.type !== 'note'));
  /** The roving tab stop: the focused item, else the first one. */
  const tabKey = $derived(focusKey && byKey.has(focusKey) ? focusKey : (nav[0]?.key ?? null));
  const currentId = $derived(workspace.currentId);
  const tags = $derived(assets.index ? assets.allTags() : []);
  /** The section whose header has scrolled out of view (rows have a fixed height). */
  const overlay = $derived.by<TreeSection | null>(() => {
    if (offset <= 0 || !items.length) return null;
    const first = Math.min(items.length - 1, Math.floor(offset / rowHeight));
    for (let j = first; j >= 0; j--) {
      const it = items[j];
      if (it.type === 'section') return j * rowHeight < offset ? it : null;
    }
    return null;
  });

  // ---------- opening ----------
  function navigate(t: Target, slot: SlotId = 'A'): void {
    if (workspace.navigator) workspace.navigator(t, { slot });
    else workspace.open(t, { slot });
    onopen?.(t, slot);
  }
  function activate(row: TreeRow, e: MouseEvent | KeyboardEvent): void {
    if (!row.open) { if (row.hasKids) prefs.toggleExpanded(row.id); return; }
    navigate(row.open, e.altKey || e.shiftKey ? 'B' : 'A');
  }
  function dblopen(row: TreeRow): void {
    if (row.kind === 'canvas') navigate({ kind: 'canvas', name: row.name, view: 'edit' });
  }

  // ---------- selection (B21) ----------
  function setSelectMode(on: boolean): void {
    selectMode = on;
    if (!on) { selected = new Set(); lastSel = null; }
  }
  function toggleSel(row: TreeRow, range: boolean): void {
    selected = range ? rangeSelect(items, lastSel, row.id, selected) : rangeSelect(items, null, row.id, selected);
    lastSel = row.id;
  }
  function selectShown(): void { selected = new Set([...selected, ...selectableIds(items)]); }
  function selectTag(tag: string): void {
    const next = new Set(selected);
    for (const [id, list] of Object.entries(assets.index?.tags ?? {})) if (list.includes(tag)) next.add(id);
    selected = next;
  }
  async function planCleanup(ids: readonly string[] = [...selected]): Promise<void> {
    if (!ids.length) return;
    const done = await (planDialog ?? ((x: string[]) => dialogs.planCleanup(x)))([...ids]);
    if (done) selected = new Set();
  }

  // ---------- context menu (RV2) ----------
  async function copy(text: string): Promise<void> {
    try {
      if (!navigator.clipboard) throw new Error('clipboard unavailable');
      await navigator.clipboard.writeText(text);
      toast('Copied', 'ok');
    } catch (e) {
      toast(`Copy failed: ${(e as Error).message}`, 'error');
    }
  }
  const menuCtx: MenuContext = {
    get index() { return assets.index; },
    get selected() { return selected; },
    get base() { return typeof location === 'undefined' ? '' : location.origin + location.pathname; },
    open: (t, slot) => navigate(t, slot),
    togglePinned: (id) => { void uiState.togglePinned(id); },
    toggleHidden: (id) => { void uiState.toggleHidden(id); },
    toggleSolo: (id) => uiState.toggleSolo(id),
    reviewNote: (d) => { if (reviewNote) reviewNote(d); else void dialogs.reviewNote(d); },
    copy: (text) => { void copy(text); },
    select: (id) => { if (!selectMode) setSelectMode(true); selected = new Set([...selected, id]); lastSel = id; },
    planCleanup: (ids) => { void planCleanup(ids); },
  };
  function menuItems(target: Element): MenuItem[] | null {
    const el = target.closest('[data-row-key]');
    const it = el ? byKey.get(el.getAttribute('data-row-key') ?? '') : undefined;
    const list = it ? menuFor(it, menuCtx) : null;
    menuKey = list?.length && it ? it.key : null;
    if (!list || !it) return list;
    const key = it.key;
    return list.map((m) => ('separator' in m ? m : { ...m, onselect: () => { m.onselect(); restoreFocus(key); } }));
  }
  /** After the menu closes, give focus back to the row (unless something else took it, e.g. a dialog). */
  function restoreFocus(key: string | null): void {
    if (!key) return;
    const run = () => {
      const a = document.activeElement;
      if (a && a !== document.body && a.isConnected && !a.closest('[role="menu"]')) return;
      focusItem(key);
    };
    setTimeout(run, 0);
    requestAnimationFrame(() => requestAnimationFrame(run));
  }
  function openMenu(el: HTMLElement): void {
    const r = el.getBoundingClientRect();
    el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + Math.min(48, r.width / 2), clientY: r.top + r.height / 2 }));
  }
  /** Esc in our menu: the menu closes it; keep it from also running the global Esc chain (K5). */
  function onDocKey(e: KeyboardEvent): void {
    if (e.key !== 'Escape' || !menuKey) return;
    const t = e.target instanceof Element ? e.target : null;
    if (!t?.closest('[role="menu"]')) return;
    e.stopPropagation();
    const key = menuKey;
    menuKey = null;
    restoreFocus(key);
  }
  $effect(() => {
    document.addEventListener('keydown', onDocKey);
    return () => document.removeEventListener('keydown', onDocKey);
  });

  // ---------- keyboard (4.4) ----------
  function findEl(key: string): HTMLElement | null {
    if (!wrapEl) return null;
    for (const el of wrapEl.querySelectorAll<HTMLElement>('[data-row-key]')) if (el.dataset.rowKey === key) return el;
    return null;
  }
  function focusItem(key: string, tries = 12): void {
    if (!alive) return;
    focusKey = key;
    const el = findEl(key);
    if (el) { el.focus(); return; }
    const i = items.findIndex((it) => it.key === key);
    if (i < 0) return;
    scrollTo?.(i, 'nearest');
    // keep at it for a few frames: virtua may re-create the row while the scroll settles, which drops
    // focus to <body>; stop as soon as focus is somewhere else (the user moved on)
    const retry = (n: number) => requestAnimationFrame(() => {
      if (!alive || focusKey !== key) return;
      const a = document.activeElement;
      if (a && a !== document.body && !wrapEl?.contains(a)) return;
      const e2 = findEl(key);
      if (e2 && a !== e2) e2.focus();
      if (n > 0) retry(n - 1);
    });
    retry(tries);
  }
  function move(from: TreeItem, delta: number): void {
    const i = nav.findIndex((it) => it.key === from.key);
    const next = nav[Math.max(0, Math.min(nav.length - 1, i + delta))];
    if (next) focusItem(next.key);
  }
  function toggleSection(s: TreeSection): void {
    if (filterText.trim()) return; // filtering expands everything (B3)
    prefs.toggleCollapsed(s.section);
    focusKey = s.key;
  }
  function onkey(it: TreeItem, e: KeyboardEvent): void {
    if (e.target !== e.currentTarget) return; // keys on the row's own buttons / checkbox
    const k = e.key;
    let handled = true;
    if ((k === 'F10' && e.shiftKey) || k === 'ContextMenu') { if (e.currentTarget instanceof HTMLElement) openMenu(e.currentTarget); }
    else if (e.ctrlKey || e.metaKey) handled = false;
    else if (k === 'ArrowDown') move(it, 1);
    else if (k === 'ArrowUp') move(it, -1);
    else if (k === 'Home') { if (nav[0]) focusItem(nav[0].key); }
    else if (k === 'End') { const last = nav[nav.length - 1]; if (last) focusItem(last.key); }
    else if (it.type === 'section') {
      if (k === 'ArrowRight') { if (it.collapsed) toggleSection(it); else move(it, 1); }
      else if (k === 'ArrowLeft') { if (!it.collapsed) toggleSection(it); }
      else if (k === 'Enter' || k === ' ') toggleSection(it);
      else handled = false;
    } else if (it.type === 'row') {
      if (k === 'ArrowRight') {
        if (it.hasKids && !it.expanded) prefs.setExpanded(it.id, true);
        else if (it.hasKids) { const i = items.indexOf(it); const child = items[i + 1]; if (child && child.type === 'row' && child.parent === it.key) focusItem(child.key); }
      } else if (k === 'ArrowLeft') {
        if (it.hasKids && it.expanded && !filterText.trim()) prefs.setExpanded(it.id, false);
        else if (byKey.has(it.parent)) focusItem(it.parent);
      } else if (k === 'Enter') activate(it, e);
      else if (k === ' ') { if (selectMode && it.selectable) toggleSel(it, e.shiftKey); }
      else handled = false;
    } else handled = false;
    if (handled) { e.preventDefault(); e.stopPropagation(); }
  }

  // ---------- flash (B19) ----------
  const flashTimers = new Map<string, ReturnType<typeof setTimeout>>();
  let lastFlash = untrack(() => signals.flash.n);
  /** B19: mark the rows of an asset for 900 ms (live events do this through signals.flash). */
  export function flash(id: string): void {
    const old = flashTimers.get(id);
    if (old) clearTimeout(old);
    flashing = new Set([...flashing, id]);
    flashTimers.set(id, setTimeout(() => {
      flashTimers.delete(id);
      const next = new Set(flashing);
      next.delete(id);
      flashing = next;
    }, FLASH_MS));
  }
  $effect(() => {
    const f = signals.flash;
    untrack(() => {
      if (f.n === lastFlash) return;
      lastFlash = f.n;
      if (f.id) flash(f.id);
    });
  });
  onDestroy(() => { for (const t of flashTimers.values()) clearTimeout(t); flashTimers.clear(); });

  // ---------- errors (2.7): keep the last index; toast the first failure after a success ----------
  let errored = false;
  $effect(() => {
    const err = assets.error;
    untrack(() => {
      if (err && !errored && assets.index) toast(`Could not refresh the asset list: ${err}`, 'error');
      errored = !!err;
    });
  });

  /** `/` (K10): focus and select the filter. */
  export function focusSearch(): void {
    searchEl?.focus();
    searchEl?.select();
  }
</script>

<div class="asset-browser">
  <PaneHeader title="Assets">
    {#if uiState.solo.size}
      <Button size="sm" onclick={() => uiState.clearSolo()}>Clear solo</Button>
    {/if}
    <Button size="sm" icon={prefs.showHidden ? 'eye' : 'eye-off'} active={prefs.showHidden} title="Show hidden assets" onclick={() => prefs.toggleShowHidden()}>hidden</Button>
    <Button size="sm" icon="square-check" active={selectMode} title="Select assets for cleanup (checkboxes, Shift+click = range)" onclick={() => setSelectMode(!selectMode)}>Select</Button>
    <Button size="sm" icon="plus" title="New canvas" active={showNew} onclick={() => { showNew = !showNew; }}>New</Button>
  </PaneHeader>
  {#if showNew}
    <NewCanvasForm onclose={() => { showNew = false; }} oncreated={(name) => navigate({ kind: 'canvas', name })} />
  {/if}
  <div class="pane-search">
    <input class="search" type="search" placeholder="Filter assets  ( / )" aria-label="Filter assets" bind:this={searchEl} bind:value={filterText} />
  </div>
  <div class="tree-wrap" bind:this={wrapEl}>
    {#if !assets.index}
      <div class="skeleton" aria-busy="true" aria-label="Loading assets">
        {#each [0, 1, 2, 3, 4, 5] as i (i)}<div class="skel-row" style:height="{rowHeight}px"><span class="bar"></span></div>{/each}
      </div>
    {:else}
      <ContextMenu items={menuItems}>
        <VirtualList
          {items}
          key={(it: TreeItem) => it.key}
          {rowHeight}
          overscan={10}
          class="asset-tree"
          role="tree"
          label="Assets"
          scrollToIndex={(fn) => { scrollTo = fn; }}
          onscroll={(o) => { offset = o; }}
        >
          {#snippet row(it: TreeItem)}
            {#if it.type === 'section'}
              <TreeSectionHeader section={it} focused={it.key === tabKey} height={rowHeight} ontoggle={toggleSection} {onkey} />
            {:else if it.type === 'row'}
              <AssetRow
                row={it}
                height={rowHeight}
                active={it.id === currentId}
                selected={selected.has(it.id)}
                flash={flashing.has(it.id)}
                focused={it.key === tabKey}
                draggable={!selectMode}
                onactivate={activate}
                ontoggle={(r) => prefs.toggleExpanded(r.id)}
                onselect={toggleSel}
                ondblopen={dblopen}
                {onkey}
              />
            {:else}
              <div class="empty-row" role="none" style:height="{rowHeight}px" style:padding-left="{12 + it.depth * 14}px">{it.text}</div>
            {/if}
          {/snippet}
        </VirtualList>
      </ContextMenu>
      {#if overlay}
        <TreeSectionHeader section={overlay} overlay height={rowHeight} ontoggle={toggleSection} />
      {/if}
    {/if}
  </div>
  {#if selectMode}
    <SelectionBar count={selected.size} {tags} onall={selectShown} ontag={selectTag} onclear={() => { selected = new Set(); }} onplan={() => { void planCleanup(); }} />
  {/if}
</div>

<style>
  .asset-browser { display: flex; flex-direction: column; flex: 1; min-height: 0; min-width: 0; }
  .pane-search { padding: var(--s-3) var(--s-4); border-bottom: 1px solid var(--line); flex: none; }
  .pane-search .search { width: 100%; box-sizing: border-box; }
  .tree-wrap { flex: 1; min-height: 0; position: relative; display: flex; flex-direction: column; }
  .tree-wrap :global(.asset-tree) { flex: 1; min-height: 0; height: 100%; }
  .empty-row { display: flex; align-items: center; box-sizing: border-box; color: var(--muted); font-size: var(--fs-3); overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .skeleton { padding: var(--s-2) 0; }
  .skel-row { display: flex; align-items: center; padding: 0 var(--s-5); box-sizing: border-box; }
  .bar { display: block; height: 10px; width: 70%; border-radius: var(--r-2); background: var(--panel2); }
  .skel-row:nth-child(2n) .bar { width: 52%; }
  .skel-row:nth-child(3n) .bar { width: 82%; }
</style>
