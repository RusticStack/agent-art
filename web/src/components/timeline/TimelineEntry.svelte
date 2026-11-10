<!--
  One timeline entry (TL5–TL9). The main line is a button (opens, TL10); compare (TL11) and details
  (TL8) are sibling buttons. A click anywhere else on the entry opens like the main line (legacy).
-->
<script lang="ts">
  import type { ActivityEntry } from '@/lib/api/types';
  import Icon from '@/components/ui/Icon.svelte';
  import { fmtMs, fmtTime } from '@/lib/util/format';
  import { canCompare, displayName, hasDetails, keyArgs, statusOf, thumbsOf, type Hit } from './timeline';
  import EntryThumbs from './EntryThumbs.svelte';
  import EntryDetails from './EntryDetails.svelte';

  let { entry, ops, expanded, dimmed, onopen, oncompare, ontoggle }: {
    entry: ActivityEntry;
    ops: readonly ActivityEntry[];
    expanded: boolean;
    dimmed: boolean;
    onopen?: (hit: Hit) => void;
    oncompare?: () => void;
    ontoggle?: () => void;
  } = $props();

  const st = $derived(statusOf(entry));
  const thumbs = $derived(thumbsOf(entry));
  const details = $derived(hasDetails(entry, ops));
  const open = (hit: Hit) => onopen?.(hit);

  function rowClick(): void {
    // selecting text (args JSON, an error) is not a click on the row
    if (typeof getSelection === 'function' && getSelection()?.toString()) return;
    open({});
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions (the main line is the keyboard path; this is the legacy whole-row click) -->
<div class={['tl-entry', st, entry.source === 'user' && 'user', dimmed && 'is-hidden']} role="listitem" data-id={entry.id} onclick={rowClick}>
  <div class="tl-line">
    <button type="button" class="tl-open" onclick={(ev) => { ev.stopPropagation(); open({}); }}>
      <span class="tl-status" title={st}><span class="vh">{st}</span></span>
      <span class="tl-tool">{displayName(entry)}</span>
      {#if entry.action}<span class="tl-action">{entry.action}</span>{/if}
      <span class="tl-args">{keyArgs(entry.args, entry.action ? 'action' : null)}</span>
    </button>
    {#if canCompare(entry)}
      <button type="button" class="act" title="Compare before / after" aria-label="Compare before / after" data-act="compare"
        onclick={(ev) => { ev.stopPropagation(); oncompare?.(); }}><Icon name="columns-2" size={14} /></button>
    {/if}
    {#if details}
      <button type="button" class="act twisty" title="Details" aria-label="Details" aria-expanded={expanded} data-act="expand"
        onclick={(ev) => { ev.stopPropagation(); ontoggle?.(); }}><Icon name="chevron-right" size={14} /></button>
    {/if}
    <span class="tl-ms mono">{entry.running ? '…' : fmtMs(entry.ms)}</span>
    <span class="tl-time mono" title={new Date(entry.ts).toLocaleString()}>{fmtTime(entry.ts)}</span>
  </div>
  {#if entry.error}
    <div class="tl-error">{entry.error}</div>
  {:else if entry.summary}
    <div class="tl-summary">{entry.summary}</div>
  {/if}
  {#if thumbs.length}<EntryThumbs {thumbs} onopen={open} />{/if}
  {#if expanded}<EntryDetails {entry} {ops} />{/if}
</div>

<style>
  /* no vertical margins: virtua measures border boxes */
  .tl-entry { border-bottom: 1px solid var(--line); padding: 5px 8px 6px; cursor: pointer; }
  .tl-entry:hover { background: var(--panel2); }
  .tl-entry.is-hidden { opacity: .45; }
  .tl-entry.user { background: rgba(56, 189, 248, .04); }
  .tl-entry.user:hover { background: var(--panel2); }
  .tl-line { display: flex; align-items: center; gap: 6px; min-width: 0; }
  .tl-open { flex: 1 1 auto; min-width: 0; display: flex; align-items: center; gap: 6px; background: none; border: 0; padding: 0; margin: 0; color: inherit; font: inherit; text-align: left; cursor: pointer; border-radius: 3px; }
  .tl-status { width: 8px; height: 8px; border-radius: 50%; flex: none; background: var(--green); position: relative; }
  .tl-entry.err .tl-status { background: var(--red); }
  .tl-entry.running .tl-status { background: var(--accent); animation: tl-pulse 1s infinite; }
  @keyframes tl-pulse { 50% { opacity: .35; } }
  @media (prefers-reduced-motion: reduce) { .tl-entry.running .tl-status { animation: none; } }
  .vh { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
  .tl-tool { font-weight: 600; font-family: ui-monospace, monospace; font-size: 12px; flex: none; }
  .tl-action { font-size: 10px; text-transform: uppercase; letter-spacing: .05em; background: var(--panel2); border: 1px solid var(--line2); border-radius: 4px; padding: 0 5px; color: #cbd2dc; flex: none; }
  .tl-args { color: var(--muted); font: 11px ui-monospace, monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; flex: 0 1 auto; }
  .act { flex: none; }
  .twisty :global(.icon) { transition: transform var(--t-fast, 120ms); }
  .twisty[aria-expanded='true'] :global(.icon) { transform: rotate(90deg); }
  @media (prefers-reduced-motion: reduce) { .twisty :global(.icon) { transition: none; } }
  .tl-ms, .tl-time { color: var(--dim); flex: none; font-size: 11px; }
  .tl-summary { color: #b6bfcc; font-size: 12px; padding-left: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tl-error { color: #ff9a9d; font-size: 12px; padding-left: 14px; white-space: pre-wrap; }
</style>
