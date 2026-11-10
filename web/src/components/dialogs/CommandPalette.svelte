<!--
  Command palette (step 18b): a search input over a grouped listbox (Recent, Actions, Assets). Focus
  stays in the input; the active option is announced through aria-activedescendant. Results come from
  commands.ts. Up / Down / Home / End move, Enter runs, Alt+Enter or Shift+Enter runs an asset in
  compare (slot B); Esc (ui/Dialog) closes and focus returns to the opener. Running an item closes the
  palette first, so focus is back on the opener before the action moves it (filter, new canvas).
  Assets, recent targets and the hidden / solo filter are read from the stores; actions run through
  the injected `runAction`, targets open through `open` (default `workspace.open`).
-->
<script lang="ts">
  import { flushSync } from 'svelte';
  import Dialog from '../ui/Dialog.svelte';
  import Icon from '../ui/Icon.svelte';
  import Kbd from '../ui/Kbd.svelte';
  import { KIND_ICON_NAME, KIND_LABEL, kindColor } from '@/lib/util/kinds';
  import { assets } from '@/state/assets.svelte';
  import { prefs } from '@/state/prefs.svelte';
  import { uiState } from '@/state/uiState.svelte';
  import { workspace } from '@/state/workspace.svelte';
  import type { DialogSpec } from '@/state/dialogs.svelte';
  import type { SlotId, Target } from '@/viewers/types';
  import { actionItems, assetItems, search, segments, type PaletteContext, type PaletteItem, type RunAction } from './commands';

  // `spec` is accepted for DialogHost's uniform { spec, onclose } call; the palette spec carries no data.
  let {
    onclose,
    context,
    runAction,
    open = (t: Target, slot: SlotId) => workspace.open(t, { slot }),
  }: {
    spec?: Extract<DialogSpec, { type: 'palette' }>;
    onclose: () => void;
    context: PaletteContext;
    runAction: RunAction;
    open?: (t: Target, slot: SlotId) => void;
  } = $props();

  const uid = $props.id();
  const listId = `${uid}-list`;
  const optId = (i: number) => `${uid}-opt-${i}`;

  let query = $state('');
  let active = $state(0);
  let listEl: HTMLElement | null = $state(null);

  // Built (and prepared by search) once per index revision / visibility change, not per keystroke.
  const assetList = $derived.by(() => {
    void assets.rev;
    return assetItems(assets.index, (id) => uiState.visible(id, prefs.showHidden), open);
  });
  const actions = $derived(actionItems(context, runAction));
  const all = $derived([...actions, ...assetList]);
  const results = $derived(search(query, all, workspace.recent));
  const blocks = $derived.by(() => {
    const out: { group: string; rows: { item: PaletteItem; i: number }[] }[] = [];
    results.forEach((item, i) => {
      const last = out.at(-1);
      if (last && last.group === item.group) last.rows.push({ item, i });
      else out.push({ group: item.group, rows: [{ item, i }] });
    });
    return out;
  });
  const activeIndex = $derived(results.length ? Math.min(active, results.length - 1) : -1);

  $effect(() => {
    const i = activeIndex;
    if (i < 0 || !listEl) return;
    listEl.querySelector<HTMLElement>(`#${CSS.escape(optId(i))}`)?.scrollIntoView?.({ block: 'nearest' });
  });

  const isAsset = (item: PaletteItem) => item.group !== 'Actions' && !item.id.startsWith('recent:action:');

  function runItem(item: PaletteItem, compare: boolean) {
    onclose();
    flushSync(); // the dialog unmounts and gives focus back to the opener before the item runs
    item.run({ compare: compare && isAsset(item) });
  }

  function move(to: number) {
    if (!results.length) return;
    active = Math.max(0, Math.min(results.length - 1, to));
  }

  function onkeydown(e: KeyboardEvent) {
    const n = results.length;
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); if (n) active = (activeIndex + 1) % n; break;
      case 'ArrowUp': e.preventDefault(); if (n) active = (activeIndex - 1 + n) % n; break;
      case 'Home': e.preventDefault(); move(0); break;
      case 'End': e.preventDefault(); move(n - 1); break;
      case 'PageDown': e.preventDefault(); move(activeIndex + 8); break;
      case 'PageUp': e.preventDefault(); move(activeIndex - 8); break;
      case 'Enter': {
        e.preventDefault();
        const item = results[activeIndex];
        if (item) runItem(item, e.altKey || e.shiftKey);
        break;
      }
      default:
        // Ctrl/Cmd+K inside the palette selects the query (the global rule never sees it)
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
          e.preventDefault(); e.stopPropagation();
          (e.currentTarget as HTMLInputElement).select();
        }
    }
  }
</script>

<Dialog open title="Search assets and actions" {onclose} initialFocus="input.pal-input" class="palette-dlg">
  <div class="pal-search">
    <Icon name="search" />
    <input
      class="pal-input"
      type="text"
      role="combobox"
      aria-label="Search assets and actions"
      aria-expanded="true"
      aria-controls={listId}
      aria-autocomplete="list"
      aria-activedescendant={activeIndex >= 0 ? optId(activeIndex) : undefined}
      placeholder="Search assets and actions…"
      autocomplete="off"
      spellcheck="false"
      data-palette-input=""
      bind:value={query}
      oninput={() => { active = 0; }}
      {onkeydown}
    />
  </div>
  <div class="pal-list" id={listId} role="listbox" aria-label="Results" bind:this={listEl}>
    {#each blocks as block, b (b)}
      <div class="pal-group" role="group" aria-labelledby="{uid}-g{b}">
        <div class="pal-head" id="{uid}-g{b}" role="presentation">{block.group}</div>
        {#each block.rows as { item, i } (item.id)}
          <!-- Options are not buttons: focus stays in the input (combobox / listbox pattern). -->
          <div
            id={optId(i)}
            class="pal-item"
            class:active={i === activeIndex}
            role="option"
            tabindex="-1"
            aria-selected={i === activeIndex}
            data-id={item.id}
            onpointermove={() => { active = i; }}
            onmousedown={(e) => e.preventDefault()}
            onclick={(e) => runItem(item, e.altKey || e.shiftKey)}
            onkeydown={() => {}}
          >
            <span class="pal-icon" style:color={item.kind ? kindColor(item.kind) : undefined} title={item.kind ? KIND_LABEL[item.kind] ?? item.kind : undefined}>
              {#if item.kind}<Icon name={KIND_ICON_NAME[item.kind] ?? 'file'} size={14} />{/if}
            </span>
            <span class="pal-label" title={item.label}>{#each segments(item.label, item.highlight) as s, k (k)}{#if s.hit}<mark>{s.text}</mark>{:else}{s.text}{/if}{/each}</span>
            {#if item.meta}<span class="pal-meta">{item.meta}</span>{/if}
            {#if item.shortcut}<span class="pal-kbd"><Kbd keys={item.shortcut} /></span>{/if}
          </div>
        {/each}
      </div>
    {/each}
  </div>
  {#if !results.length}<p class="pal-empty" role="status">No matches</p>{/if}
  <div class="pal-hint" aria-hidden="true">
    <Kbd keys="↑ ↓" /> move · <Kbd keys="Enter" /> open · <Kbd keys="Alt+Enter" /> open in compare · <Kbd keys="Esc" /> close
  </div>
</Dialog>

<style>
  /* the dialog card: anchored 12vh from the top, title kept for the accessible name only */
  :global(.dlg.palette-dlg) { top: 12vh; transform: translateX(-50%); padding: var(--s-4); gap: var(--s-3); }
  :global(.dlg.palette-dlg[data-state='open']) { animation: palette-in 120ms var(--ease); }
  @keyframes -global-palette-in { from { opacity: 0; transform: translate(-50%, 4px); } }
  @media (prefers-reduced-motion: reduce) { :global(.dlg.palette-dlg[data-state='open']) { animation: none; } }
  /* the Close button sits inside the input's right padding, above the (positioned, opaque) search row */
  :global(.palette-dlg .dlg-head) { position: absolute; top: calc(var(--s-4) + 4px); right: calc(var(--s-4) + 4px); z-index: 1; }
  :global(.palette-dlg .dlg-title) {
    position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap;
  }
  :global(.palette-dlg .dlg-body) { display: flex; flex-direction: column; gap: var(--s-3); overflow: visible; }

  .pal-search { position: relative; display: flex; align-items: center; color: var(--muted); }
  .pal-search :global(.icon) { position: absolute; left: var(--s-4); pointer-events: none; }
  /* type=text is not covered by the base input rule: give it the field look and body text colour (axe contrast) */
  .pal-input {
    width: 100%; height: 36px; padding: 0 36px 0 calc(var(--s-4) + 24px); font-size: var(--fs-4);
    background: var(--bg2); border: 1px solid var(--line2); border-radius: 6px; color: var(--text);
  }
  .pal-input::placeholder { color: var(--muted); opacity: 1; }

  .pal-list { max-height: 50vh; overflow: auto; }
  .pal-head {
    padding: var(--s-3) var(--s-3) var(--s-2); font-size: var(--fs-1); font-weight: 700; letter-spacing: .08em;
    text-transform: uppercase; color: var(--muted);
  }
  .pal-item {
    display: flex; align-items: center; gap: var(--s-4); height: var(--h-row); padding: 0 var(--s-3);
    border-left: 2px solid transparent; border-radius: var(--r-2); cursor: pointer; color: var(--text);
  }
  .pal-item.active { background: var(--accent-bg); border-left-color: var(--accent); }
  .pal-icon { flex: none; display: inline-flex; width: 14px; justify-content: center; }
  .pal-label { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .pal-label mark { background: none; color: var(--accent-fg); font-weight: 600; }
  .pal-meta {
    flex: 0 1 auto; min-width: 0; max-width: 45%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    color: var(--muted); font-size: var(--fs-2);
  }
  .pal-kbd { flex: none; font-size: var(--fs-2); color: var(--muted); }
  .pal-empty { margin: 0; padding: var(--s-4) var(--s-3); color: var(--muted); }
  /* --muted, not --dim: --dim text fails 4.5:1 on the panel (axe color-contrast) */
  .pal-hint { font-size: var(--fs-2); color: var(--muted); padding: 0 var(--s-3); }
  @media (max-width: 860px) { .pal-item { height: 36px; } }
</style>
